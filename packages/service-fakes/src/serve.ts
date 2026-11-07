/** What every fake shares: a loopback listener on an OS-assigned port. */

/** The three fields every fake has, whatever else it offers. */
export type FakeService = {
  readonly url: string;
  readonly port: number;
  /**
   * Stop listening, gracefully. Never `server.stop(true)`: on bun 1.3.14 force-closing
   * a server's idle keep-alive sockets makes the next fetch in this process, even to
   * another port, fail with ECONNRESET, which turned into a failure in the next test.
   */
  stop(): Promise<void>;
};

/** Long enough for a `git http-backend` child; Bun's default is 10 s. */
const IDLE_TIMEOUT_SECONDS = 60;

/** Serve `fetch` on 127.0.0.1, port 0. Never a wildcard, never a fixed port. */
export function serveLoopback(
  fetch: (req: Request) => Response | Promise<Response>,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch,
  });
}

/** A JSON response. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A delivery goes only to a receiver on this machine. A test that names any
 * other host has a bug, and a fake must never be the thing that opens a real
 * outbound connection.
 */
export function assertLoopbackUrl(url: string): void {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
    throw new Error(`a fake delivers only to loopback receivers, not to ${host}`);
  }
}
