/**
 * The Content-Security-Policy Home's own pages carry, and the headers that go with it.
 *
 * The console is zero-build ES modules and one stylesheet, all served from Home itself,
 * with no inline script, no inline style (styles are set through the CSSOM), no image,
 * no font and no form that navigates. So the policy allows exactly that: scripts, styles
 * and fetches from Home, and frames from Home (a plugin pane is served from its own
 * single-use address with its own, stricter policy). Everything else is refused, and no
 * other site may frame Home.
 */

/**
 * The policy on every page and asset Home serves.
 *
 * First consumers: Home's static responses and its built-in index.
 */
export const HOME_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/**
 * The headers on every page and asset: the policy, a browsing context of its own, and no
 * referrer to anywhere.
 *
 * First consumer: `serveStatic` and the built-in index in `server.ts`.
 */
export const SHELL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": HOME_CSP,
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
});
