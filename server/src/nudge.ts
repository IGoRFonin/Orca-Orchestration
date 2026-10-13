/**
 * Stall detection for Claude Code workers that died on a transient API error.
 *
 * When the Anthropic API drops a stream, Claude Code prints
 *
 *   ⏺ API Error: Connection lost mid-response. The response above may be incomplete.
 *   ✻ Crunched for 2m 30s · done 11:00 AM
 *   ❯
 *
 * and ends its turn. It never calls `worker_done`, so Orca keeps the task
 * `dispatched` and the heartbeat just goes quiet — from the coordinator's side
 * it looks like a slow worker, forever. A human unsticks it by typing
 * "continue"; this module decides when the coordinator may do the same.
 *
 * Pure on purpose (screen lines in, verdict out) so it can be checked against
 * captured screens without provoking a real API error.
 */

export type StallVerdict =
  | { kind: "transient"; message: string }
  | { kind: "fatal"; message: string }
  | null;

/** Claude Code marks every assistant/tool block with this glyph. */
const BLOCK_MARK = "⏺";

/**
 * Errors where retrying cannot help: the context is full, the credentials are
 * wrong, or the plan's quota is spent until some reset time. Checked BEFORE the
 * transient list — "usage limit … 429" must not be retried in a loop.
 */
const FATAL = [
  /prompt is too long/i,
  /context (window|length)/i,
  /invalid (api|x-api) key/i,
  /authentication|unauthori[sz]ed|\b401\b|\b403\b|forbidden/i,
  /credit balance/i,
  /usage limit|limit (reached|will reset)|resets? at/i,
  /\b400\b|invalid_request/i,
];

/** Errors that are worth a "continue": the network or the API hiccuped. */
const TRANSIENT = [
  /connection (lost|error|reset|closed)/i,
  /overloaded|\b529\b/i,
  /\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway time-?out/i,
  /timed? ?out|timeout/i,
  /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|network/i,
  /stream (ended|closed|error)|premature close|terminated/i,
  /\b429\b|rate.?limit/i,
];

/**
 * Look at a worker's rendered screen (`orca terminal read --screen`) and say
 * whether its LAST assistant block is an API error.
 *
 * "Last" is the whole point: an error the agent already recovered from stays
 * on screen above newer `⏺` blocks (a human typed "continue" and it went on),
 * and matching it again would nudge a healthy worker after every recovery.
 */
export function detectApiErrorStall(lines: string[]): StallVerdict {
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimStart().startsWith(BLOCK_MARK)) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;

  const head = lines[last].trimStart().slice(BLOCK_MARK.length).trim();
  if (!/^API Error\b/i.test(head)) return null;

  // The message can wrap onto indented continuation lines; stop at the first
  // blank line or the "✻ … done" turn summary.
  const parts = [head];
  for (let i = last + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || !/^\s/.test(l)) break;
    parts.push(l.trim());
  }
  const message = parts.join(" ");

  if (FATAL.some((re) => re.test(message))) return { kind: "fatal", message };
  if (TRANSIENT.some((re) => re.test(message))) return { kind: "transient", message };
  // An API error we don't recognise: be conservative and leave it to a human.
  return { kind: "fatal", message };
}
