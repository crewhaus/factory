/**
 * The temporary listener that dissolves setup's ordering deadlock.
 *
 * THE DEADLOCK. A Slack app's Request URL has to be answerable — Slack POSTs
 * `{ type: "url_verification", challenge }` and wants the challenge echoed
 * back with HTTP 200. The thing that would normally answer is the compiled
 * channel daemon. But the daemon gates its boot on every secret env ref the
 * spec declares and `process.exit(2)`s when one is unset, and the signing
 * secret it needs is returned exactly once — in the response to the
 * `apps.manifest.create` call we have not made yet. So the daemon cannot run
 * before the app exists, and the app's URL cannot verify before something
 * runs. Whether `apps.manifest.create` verifies the URL synchronously is
 * undocumented either way, and a human clicking "Retry" in App Settings later
 * hits the same wall.
 *
 * THE WAY OUT. Setup stands in for the daemon for the length of the apply. A
 * `url_verification` challenge needs no credential to answer correctly — the
 * response is the echoed challenge — so a ~40-line listener on the same port,
 * behind the same tunnel hostname, satisfies Slack whether it verifies at
 * create time, at update time, or when a human clicks Retry. It shuts down
 * before the real daemon takes the port.
 *
 * It also serves the OAuth callback. Slack requires an HTTPS redirect URL, so
 * a bare `http://localhost` callback is rejected — but setup has just
 * provisioned a tunnel, and the tunnel terminates TLS. Routing the callback
 * through the hostname we already created is what turns "paste the bot token
 * by hand" into one browser click.
 *
 * Security posture: the responder answers only two paths, echoes only the
 * challenge string Slack sent, holds the OAuth `code` in memory for a single
 * exchange, and is closed in a `finally`. It never writes to disk and never
 * logs a request body.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { createConnection } from "node:net";

/** How a request was answered — surfaced so setup can report what Slack did. */
export type ResponderEvent =
  | { readonly kind: "challenge"; readonly at: number }
  | { readonly kind: "oauth-code"; readonly at: number }
  | { readonly kind: "oauth-error"; readonly at: number; readonly error: string };

export type ResponderOptions = {
  /** Port to bind. The daemon's events port — the one the tunnel points at. */
  readonly port: number;
  /** Interface to bind. Loopback by default; the tunnel dials it locally. */
  readonly host?: string;
  /** Path Slack posts the verification challenge to. */
  readonly eventsPath?: string;
  /** Path the OAuth redirect lands on. */
  readonly callbackPath?: string;
  /** The `state` value the authorize URL carried, checked on callback. */
  readonly expectedState?: string;
};

/** A running responder. Always stop it in a `finally`. */
export type Responder = {
  /** Everything it answered, oldest first. */
  readonly events: readonly ResponderEvent[];
  /** Resolves with the OAuth `code` once the browser redirect arrives. */
  waitForCode(timeoutMs: number): Promise<string>;
  /** True once at least one `url_verification` challenge was answered. */
  sawChallenge(): boolean;
  stop(): Promise<void>;
};

/**
 * True when something is already listening on the port. Setup uses this to
 * decide whether to stand in at all: if the real daemon is already up it
 * answers the challenge itself, and binding would fail anyway.
 */
export function portInUse(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host });
    const settle = (inUse: boolean): void => {
      socket.destroy();
      resolvePromise(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/**
 * Start the stand-in listener.
 *
 * Rejects when the port is taken, with a message that names the likely cause
 * — a daemon already running, which is the good case and means the caller
 * should skip the responder rather than retry.
 */
export function startResponder(opts: ResponderOptions): Promise<Responder> {
  const host = opts.host ?? "127.0.0.1";
  const eventsPath = opts.eventsPath ?? "/slack/events";
  const callbackPath = opts.callbackPath ?? "/crewhaus/oauth/callback";
  const events: ResponderEvent[] = [];

  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  let capturedCode: string | undefined;
  let capturedError: Error | undefined;

  const server: Server = createServer((req, res) => {
    // `handle` awaits the request body, and `for await (…of req)` REJECTS when
    // a client drops the connection mid-body (ECONNRESET). Unhandled, that
    // rejection is fatal under Node's and Bun's default policy — and this
    // listener sits on a public tunnel hostname for up to five minutes with a
    // half-created Slack app on disk, so a single reset browser tab or a
    // timed-out Slack delivery would kill the run at its least recoverable
    // moment. An aborted request is not an error worth reporting; drop it.
    handle(req, res).catch(() => {
      res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (url.pathname === callbackPath) {
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (error !== null) {
        finishOauth(undefined, new Error(`Slack returned "${error}" — the install was declined`));
        respondHtml(res, 400, "Install declined", "You can close this tab and re-run setup.");
        return;
      }
      if (opts.expectedState !== undefined && state !== opts.expectedState) {
        // A mismatched state means this redirect did not originate from the
        // authorize URL we built. Refuse it rather than exchanging a code of
        // unknown provenance.
        finishOauth(undefined, new Error("OAuth state mismatch — refusing the callback"));
        respondHtml(res, 400, "Unexpected callback", "You can close this tab and re-run setup.");
        return;
      }
      if (code === null || code === "") {
        respondHtml(res, 400, "No code in callback", "You can close this tab and re-run setup.");
        return;
      }
      finishOauth(code, undefined);
      respondHtml(res, 200, "Installed", "Setup has the token. You can close this tab.");
      return;
    }

    if (url.pathname === eventsPath && req.method === "POST") {
      const body = await readBody(req);
      const challenge = readChallenge(body);
      if (challenge !== undefined) {
        events.push({ kind: "challenge", at: Date.now() });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(challenge);
        return;
      }
      // Anything else on the events path during setup is a real event
      // arriving before the daemon is up. ACK it so Slack does not retry
      // into a disabled subscription; the daemon owns the port moments later.
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  }

  function finishOauth(code: string | undefined, err: Error | undefined): void {
    if (err !== undefined) {
      events.push({ kind: "oauth-error", at: Date.now(), error: err.message });
      capturedError = err;
      rejectCode?.(err);
      return;
    }
    if (code !== undefined) {
      events.push({ kind: "oauth-code", at: Date.now() });
      capturedCode = code;
      resolveCode?.(code);
    }
  }

  return new Promise<Responder>((resolvePromise, rejectPromise) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      rejectPromise(
        err.code === "EADDRINUSE"
          ? new Error(
              `port ${opts.port} is already in use — if that is the harness daemon, it will answer Slack's verification itself and no stand-in is needed`,
            )
          : err,
      );
    });
    server.listen(opts.port, host, () => {
      resolvePromise({
        events,
        sawChallenge: () => events.some((e) => e.kind === "challenge"),
        waitForCode: (timeoutMs: number) =>
          new Promise<string>((resolveWait, rejectWait) => {
            if (capturedCode !== undefined) return resolveWait(capturedCode);
            if (capturedError !== undefined) return rejectWait(capturedError);
            const timer = setTimeout(() => {
              rejectWait(
                new Error(
                  `no OAuth callback arrived within ${Math.round(timeoutMs / 1000)}s — open the authorize URL and approve the install, or re-run with --manual-install`,
                ),
              );
            }, timeoutMs);
            resolveCode = (c) => {
              clearTimeout(timer);
              resolveWait(c);
            };
            rejectCode = (e) => {
              clearTimeout(timer);
              rejectWait(e);
            };
          }),
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // A browser keep-alive socket would otherwise hold the port past
            // close(), and the daemon needs it back immediately.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** Read a request body with a hard cap — nothing legitimate here is large. */
async function readBody(req: IncomingMessage, limitBytes = 128 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Pull the challenge out of a Slack verification body. Returns undefined for
 * anything that is not a `url_verification`, so a real event is never echoed
 * back to the sender.
 */
export function readChallenge(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (rec["type"] !== "url_verification") return undefined;
  const challenge = rec["challenge"];
  return typeof challenge === "string" ? challenge : undefined;
}

/** A minimal, styleless confirmation page — the operator sees it once. */
function respondHtml(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px system-ui;padding:3rem"><h1>${title}</h1><p>${body}</p>`,
  );
}
