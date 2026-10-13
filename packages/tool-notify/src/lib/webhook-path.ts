/** Whether `text` holds `lower` at `at`, an ASCII letter in either case as the `i` flag matches. */
function caseFoldedAt(text: string, at: number, lower: string): boolean {
  if (at + lower.length > text.length) return false;
  for (let i = 0; i < lower.length; i++) {
    const want = lower.charCodeAt(i);
    const got = text.charCodeAt(at + i);
    if (got !== want && !(want >= 0x61 && want <= 0x7a && got === want - 0x20)) return false;
  }
  return true;
}

/** A code unit `.` does not match without the `s` flag. */
function isLineBreak(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

const TEAMS_PREFIX = "/webhookb2/";
const TEAMS_MARKER = "/incomingwebhook/";

/**
 * Whether a URL path is a Teams incoming webhook's, whose path is the
 * credential: what `/^\/webhookb2\/[^/]+@[^/]+\/IncomingWebhook\/.+/i`
 * answered, read a segment at a time. The segment after `/webhookb2/` must
 * hold an `@` with a character on each side, `/IncomingWebhook/` must follow
 * it, and a character that is not a line break after that. The pattern's
 * `[^/]+@` overlapped the `@`, so it tried every `@` of a run and rescanned
 * the rest of the segment from each: quadratic in a path the call wrote,
 * before the allow-list was asked.
 */
export function isTeamsWebhookPath(path: string): boolean {
  if (!caseFoldedAt(path, 0, TEAMS_PREFIX)) return false;
  const segmentEnd = path.indexOf("/", TEAMS_PREFIX.length);
  if (segmentEnd === -1) return false;
  const at = path.indexOf("@", TEAMS_PREFIX.length + 1);
  if (at === -1 || at > segmentEnd - 2) return false;
  if (!caseFoldedAt(path, segmentEnd, TEAMS_MARKER)) return false;
  const rest = segmentEnd + TEAMS_MARKER.length;
  return rest < path.length && !isLineBreak(path.charCodeAt(rest));
}
