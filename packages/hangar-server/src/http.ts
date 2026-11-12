/**
 * The HTTP primitives every route body shares: the typed error a handler
 * throws to answer a status, and the JSON response builder.
 *
 * Lifted out of `server.ts` for M3: the per-area handler modules live outside
 * the server closure and must be able to refuse with the SAME error type the
 * dispatcher already translates. A module that threw a bare `Error` would
 * surface as a 500 "internal error" and lose its message — the opposite of
 * this server's typed-degradation posture.
 */

/** A refusal with a status. Thrown by handlers, caught by the dispatcher. */
export class HttpError extends Error {
  readonly status: number;
  /**
   * Fields answered beside `error` (a 412's `current`, a 409's `needs`). The
   * dispatcher masks them like any answer; no field may be named so that the
   * credential masker redacts it.
   */
  readonly body: Readonly<Record<string, unknown>> | undefined;
  constructor(status: number, message: string, body?: Readonly<Record<string, unknown>>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Headers on every JSON body: no caching, no MIME sniffing. */
export const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** One JSON response (trailing newline so `curl` output is line-clean). */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(data)}\n`, {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** The error envelope. 401 carries the challenge header. */
export function errResponse(status: number, message: string): Response {
  const headers: Record<string, string> = status === 401 ? { "www-authenticate": "Bearer" } : {};
  return json({ error: message }, status, headers);
}
