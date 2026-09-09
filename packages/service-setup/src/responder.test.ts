/**
 * Stand-in responder coverage.
 *
 * This module exists to bind a real port, so these tests bind real ports —
 * always on loopback, always one grabbed fresh from the kernel (bind :0, read
 * the number, release it) rather than a hard-coded one, and always released
 * again in `afterEach`. Nothing here reaches the network, and no test waits
 * longer than a fraction of a second.
 *
 * The load-bearing assertion is the negative one: `readChallenge` returns
 * undefined for every body that is not a well-formed `url_verification`, which
 * is what keeps a real Slack event from being echoed back to the sender.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { request } from "node:http";
import { type Server as NetServer, createServer as createNetServer } from "node:net";
import { type Responder, portInUse, readChallenge, startResponder } from "./responder";

/** Responders and throwaway sockets opened by a test, torn down after it. */
const openResponders: Responder[] = [];
const openServers: NetServer[] = [];

afterEach(async () => {
  for (const responder of openResponders.splice(0)) await responder.stop();
  for (const server of openServers.splice(0)) await closeNetServer(server);
});

/** Ask the kernel for a port, then hand it back — the caller races nobody. */
function freePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createNetServer();
    probe.once("error", rejectPromise);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => rejectPromise(new Error("no numeric address")));
        return;
      }
      const port = address.port;
      probe.close(() => resolvePromise(port));
    });
  });
}

/** A bare TCP listener, used both to occupy a port and to prove one is free. */
function listenOn(port: number): Promise<NetServer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
  });
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((done) => {
    if (!server.listening) return done();
    server.close(() => done());
  });
}

async function start(opts: Parameters<typeof startResponder>[0]): Promise<Responder> {
  const responder = await startResponder(opts);
  openResponders.push(responder);
  return responder;
}

type Settled =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: Error };

/**
 * Attach handlers to a `waitForCode` promise the moment it is created, so a
 * rejection we assert on later never surfaces as an unhandled rejection.
 */
function settle(promise: Promise<string>): Promise<Settled> {
  return promise.then(
    (value): Settled => ({ ok: true, value }),
    (error: Error): Settled => ({ ok: false, error }),
  );
}

describe("readChallenge", () => {
  test("returns the challenge from a well-formed url_verification body", () => {
    expect(readChallenge('{"type":"url_verification","challenge":"abc"}')).toBe("abc");
  });

  test("tolerates extra fields Slack sends alongside the challenge", () => {
    const body = JSON.stringify({
      token: "shhh",
      challenge: "3eZbrw1aB",
      type: "url_verification",
    });
    expect(readChallenge(body)).toBe("3eZbrw1aB");
  });

  test("returns undefined for invalid JSON", () => {
    expect(readChallenge("not json at all")).toBeUndefined();
    expect(readChallenge("")).toBeUndefined();
    expect(readChallenge('{"type":')).toBeUndefined();
  });

  test("returns undefined for JSON that is not an object", () => {
    expect(readChallenge('"url_verification"')).toBeUndefined();
    expect(readChallenge("42")).toBeUndefined();
    expect(readChallenge("true")).toBeUndefined();
    expect(readChallenge("null")).toBeUndefined();
  });

  test("returns undefined for a JSON array", () => {
    expect(readChallenge('["url_verification","abc"]')).toBeUndefined();
    expect(readChallenge("[]")).toBeUndefined();
  });

  test("never echoes a real event back — a non-verification type yields undefined", () => {
    const event = JSON.stringify({
      type: "event_callback",
      challenge: "attacker-supplied",
      event: { type: "message", text: "hello" },
    });
    expect(readChallenge(event)).toBeUndefined();
  });

  test("returns undefined when type is missing or a near-miss", () => {
    expect(readChallenge('{"challenge":"abc"}')).toBeUndefined();
    expect(readChallenge('{"type":"URL_VERIFICATION","challenge":"abc"}')).toBeUndefined();
    expect(readChallenge('{"type":"url_verification ","challenge":"abc"}')).toBeUndefined();
  });

  test("returns undefined when the challenge is missing or not a string", () => {
    expect(readChallenge('{"type":"url_verification"}')).toBeUndefined();
    expect(readChallenge('{"type":"url_verification","challenge":123}')).toBeUndefined();
    expect(readChallenge('{"type":"url_verification","challenge":null}')).toBeUndefined();
    expect(readChallenge('{"type":"url_verification","challenge":{"v":"abc"}}')).toBeUndefined();
  });
});

describe("portInUse", () => {
  test("is false for a port nothing is listening on", async () => {
    const port = await freePort();
    expect(await portInUse(port, "127.0.0.1", 300)).toBe(false);
  });

  test("is true while a server holds the port, and false again after it closes", async () => {
    const port = await freePort();
    const server = await listenOn(port);
    expect(await portInUse(port, "127.0.0.1", 300)).toBe(true);
    await closeNetServer(server);
    expect(await portInUse(port, "127.0.0.1", 300)).toBe(false);
  });

  test("is true for a running responder's port", async () => {
    const port = await freePort();
    await start({ port });
    expect(await portInUse(port, "127.0.0.1", 300)).toBe(true);
  });
});

describe("startResponder — the Slack challenge", () => {
  test("echoes the challenge as plain text and records one challenge event", async () => {
    const port = await freePort();
    const responder = await start({ port });
    expect(responder.sawChallenge()).toBe(false);

    const res = await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "abc123" }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
    expect(responder.sawChallenge()).toBe(true);
    expect(responder.events).toHaveLength(1);
    expect(responder.events[0]?.kind).toBe("challenge");
  });

  test("a non-challenge POST gets a bare 200 and records nothing", async () => {
    const port = await freePort();
    const responder = await start({ port });

    const res = await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      body: JSON.stringify({ type: "event_callback", event: { type: "message" } }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(responder.sawChallenge()).toBe(false);
    expect(responder.events).toHaveLength(0);
  });

  test("honours a custom eventsPath and 404s the default one", async () => {
    const port = await freePort();
    const responder = await start({ port, eventsPath: "/hooks/slack" });

    const res = await fetch(`http://127.0.0.1:${port}/hooks/slack`, {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "custom-path" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("custom-path");
    expect(responder.sawChallenge()).toBe(true);

    const missed = await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "nope" }),
    });
    expect(missed.status).toBe(404);
    expect(responder.events).toHaveLength(1);
  });

  test("404s an unknown path, and a GET on the events path", async () => {
    const port = await freePort();
    const responder = await start({ port });

    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/anything/else`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/slack/events`)).status).toBe(404);
    expect(responder.events).toHaveLength(0);
  });
});

describe("startResponder — the OAuth callback", () => {
  test("resolves waitForCode with the code and serves an HTML page", async () => {
    const port = await freePort();
    const responder = await start({ port, expectedState: "st-1" });
    const pending = settle(responder.waitForCode(2000));

    const res = await fetch(`http://127.0.0.1:${port}/crewhaus/oauth/callback?code=xyz&state=st-1`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Installed");

    const result = await pending;
    expect(result).toEqual({ ok: true, value: "xyz" });
    expect(responder.events[0]?.kind).toBe("oauth-code");
  });

  test("honours a custom callbackPath", async () => {
    const port = await freePort();
    const responder = await start({ port, callbackPath: "/oauth/done" });
    const pending = settle(responder.waitForCode(2000));

    const res = await fetch(`http://127.0.0.1:${port}/oauth/done?code=from-custom-path`);
    expect(res.status).toBe(200);

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("from-custom-path");

    expect((await fetch(`http://127.0.0.1:${port}/crewhaus/oauth/callback?code=x`)).status).toBe(
      404,
    );
  });

  test("refuses a callback whose state does not match, with 400", async () => {
    const port = await freePort();
    const responder = await start({ port, expectedState: "expected-state" });
    const pending = settle(responder.waitForCode(2000));

    const res = await fetch(
      `http://127.0.0.1:${port}/crewhaus/oauth/callback?code=xyz&state=wrong-state`,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unexpected callback");

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/state mismatch/i);
    expect(responder.events[0]?.kind).toBe("oauth-error");
  });

  test("refuses a callback with no state at all when one was expected", async () => {
    const port = await freePort();
    const responder = await start({ port, expectedState: "expected-state" });
    const pending = settle(responder.waitForCode(2000));

    const res = await fetch(`http://127.0.0.1:${port}/crewhaus/oauth/callback?code=xyz`);
    expect(res.status).toBe(400);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/state mismatch/i);
  });

  test("rejects on ?error=access_denied and answers 400", async () => {
    const port = await freePort();
    const responder = await start({ port });
    const pending = settle(responder.waitForCode(2000));

    const res = await fetch(`http://127.0.0.1:${port}/crewhaus/oauth/callback?error=access_denied`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Install declined");

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/access_denied/);

    const first = responder.events[0];
    expect(first?.kind).toBe("oauth-error");
    if (first?.kind === "oauth-error") expect(first.error).toMatch(/declined/);
  });

  test("a callback with neither code nor error is a 400 that resolves nothing", async () => {
    const port = await freePort();
    const responder = await start({ port });
    const pending = settle(responder.waitForCode(400));

    const res = await fetch(`http://127.0.0.1:${port}/crewhaus/oauth/callback`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("No code in callback");
    expect(responder.events).toHaveLength(0);

    // Nothing was captured, so the only way out is the timeout.
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/no OAuth callback arrived/);
  });

  test("an empty code is treated as no code", async () => {
    const port = await freePort();
    const responder = await start({ port });

    const res = await fetch(`http://127.0.0.1:${port}/crewhaus/oauth/callback?code=`);
    expect(res.status).toBe(400);
    expect(responder.events).toHaveLength(0);
  });
});

describe("startResponder — waitForCode", () => {
  test("resolves immediately when the code arrived before the wait started", async () => {
    const port = await freePort();
    const responder = await start({ port });

    const res = await fetch(`http://127.0.0.1:${port}/crewhaus/oauth/callback?code=early`);
    expect(res.status).toBe(200);

    // Zero timeout: only the captured-code fast path can satisfy this.
    await expect(responder.waitForCode(0)).resolves.toBe("early");
  });

  test("rejects immediately when an error arrived before the wait started", async () => {
    const port = await freePort();
    const responder = await start({ port });

    const res = await fetch(`http://127.0.0.1:${port}/crewhaus/oauth/callback?error=access_denied`);
    expect(res.status).toBe(400);

    await expect(responder.waitForCode(0)).rejects.toThrow(/access_denied/);
  });

  test("times out with a message naming the timeout in seconds", async () => {
    const port = await freePort();
    const responder = await start({ port });

    const result = await settle(responder.waitForCode(600));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/no OAuth callback arrived within 1s/);
      expect(result.error.message).toMatch(/--manual-install/);
    }
  });
});

describe("startResponder — the port itself", () => {
  test("rejects with the daemon hint when the port is already taken", async () => {
    const port = await freePort();
    const squatter = await listenOn(port);
    openServers.push(squatter);

    const attempt = startResponder({ port });
    await expect(attempt).rejects.toThrow(new RegExp(`port ${port} is already in use`));
    await expect(startResponder({ port })).rejects.toThrow(/that is the harness daemon/);
  });

  test("frees the port again after stop()", async () => {
    const port = await freePort();
    const responder = await startResponder({ port });
    expect(await portInUse(port, "127.0.0.1", 300)).toBe(true);

    await responder.stop();

    const reclaimed = await listenOn(port);
    openServers.push(reclaimed);
    expect(reclaimed.listening).toBe(true);
  });

  test("stop() is safe to call twice", async () => {
    const port = await freePort();
    const responder = await startResponder({ port });
    await responder.stop();
    await responder.stop();
    expect(await portInUse(port, "127.0.0.1", 300)).toBe(false);
  });
});

describe("regression — an aborted request must not kill the run", () => {
  test("a client that drops mid-body is dropped, not escalated", async () => {
    // `for await (…of req)` REJECTS on ECONNRESET. Unhandled that is fatal,
    // and this listener sits on a public hostname for minutes with a
    // half-created Slack app on disk — the least recoverable moment there is.
    const port = await freePort();
    const responder = await startResponder({ port });
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await new Promise<void>((done) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/slack/events", method: "POST" },
          () => done(),
        );
        req.setHeader("content-length", "1000");
        req.write("{");
        // Destroy before the declared body arrives — the ECONNRESET case.
        setTimeout(() => {
          req.destroy();
          done();
        }, 20);
        req.on("error", () => done());
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(rejections).toEqual([]);
      // Still alive and serving.
      const res = await fetch(`http://127.0.0.1:${port}/slack/events`, {
        method: "POST",
        body: JSON.stringify({ type: "url_verification", challenge: "still-here" }),
      });
      expect(await res.text()).toBe("still-here");
    } finally {
      process.off("unhandledRejection", onRejection);
      await responder.stop();
    }
  });
});
