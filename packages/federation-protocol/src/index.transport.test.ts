import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
/**
 * Coverage for the production `defaultTransport` path — the branch that issues
 * a real `node:https` POST with mTLS + cert pinning (src/index.ts lines
 * 212-272). `federationCall` only reaches `defaultTransport` when no
 * `transport` override is supplied.
 *
 * To stay fully deterministic — no real socket, no TLS handshake, no wall-clock
 * timers — we replace `node:https.request` with a hand-driven fake via
 * `mock.module`. The fake captures the assembled `RequestOptions` (so we can
 * call `checkServerIdentity` directly) and hands back a `FakeClientRequest`
 * (an `EventEmitter`) so the test drives the `error` / `timeout` lifecycle, and
 * a `FakeResponse` (also an `EventEmitter`) so the test drives `data` / `end`.
 *
 * `mock.module` mutates the shared module registry, so the module under test is
 * imported with `await import("./index")` AFTER the stub is registered (its
 * `import { request as httpsRequest } from "node:https"` binding then resolves
 * to the fake). `afterEach` restores the real `node:https` and clears per-test
 * state so nothing leaks between tests or into sibling test files.
 *
 * NO-HANG CONTRACT — every `federationCall(...)` promise in this file is made
 * to settle before the test ends:
 *   - happy / end paths resolve naturally once `res` emits `end`;
 *   - paths that only inspect `checkServerIdentity` settle by emitting a
 *     request `"error"` and asserting the call REJECTS;
 *   - the error / timeout paths assert `.rejects`.
 * We deliberately never emit a response-stream `"error"`: `defaultTransport`
 * registers no `res.on("error")` listener, so such a promise could never settle
 * (that exact omission is what hung the previous version of this file). See the
 * note at the bottom for why that single branch is intentionally not exercised.
 */
import { EventEmitter } from "node:events";
import type { PeerCertificate } from "node:tls";

const realHttps = require("node:https") as typeof import("node:https");

/** Minimal stand-in for the response `IncomingMessage` (`data` / `end`). */
class FakeResponse extends EventEmitter {
  statusCode?: number;
}

/**
 * Minimal stand-in for `ClientRequest`. It is an `EventEmitter` so the
 * transport can attach `error` / `timeout` listeners. `write` / `end` record
 * what was sent; `destroy(err)` mirrors Node by surfacing the destroy reason as
 * an `error` event on the next microtask — which is how the production timeout
 * handler ultimately rejects the promise.
 */
class FakeClientRequest extends EventEmitter {
  written = "";
  ended = false;
  destroyedWith: unknown = undefined;
  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }
  end(): void {
    this.ended = true;
  }
  destroy(err?: unknown): void {
    this.destroyedWith = err;
    if (err) queueMicrotask(() => this.emit("error", err));
  }
}

/** What each invocation of the fake `request` captures for the test to drive. */
type Capture = {
  opts: import("node:https").RequestOptions;
  req: FakeClientRequest;
  cb: (res: FakeResponse) => void;
  res?: FakeResponse;
};

let lastCall: Capture | undefined;

/**
 * Behaviour selector, reset to `"manual"` after every test:
 *  - "respond": on the next microtask deliver a response, emit `respondChunks`,
 *               then `end` (happy path — promise resolves).
 *  - "manual":  capture `opts` / `req` only; the test drives every event and is
 *               responsible for settling the promise (reject via req `error`).
 */
let mode: "respond" | "manual" = "manual";
let respondStatus: number | undefined = 200;
let respondChunks: Buffer[] = [];

mock.module("node:https", () => ({
  ...realHttps,
  request: (opts: import("node:https").RequestOptions, cb: (res: FakeResponse) => void) => {
    const req = new FakeClientRequest();
    const call: Capture = { opts, req, cb };
    lastCall = call;
    if (mode === "respond") {
      // Deliver the response only after the synchronous body of
      // `defaultTransport` has run `req.write(body)` / `req.end()`.
      queueMicrotask(() => {
        const res = new FakeResponse();
        res.statusCode = respondStatus;
        call.res = res;
        cb(res);
        for (const c of respondChunks) res.emit("data", c);
        res.emit("end");
      });
    }
    return req;
  },
}));

// Import AFTER registering the mock so the static `node:https` binding inside
// `defaultTransport` resolves to the fake.
const { FEDERATION_VERSION, FederationProtocolError, federationCall, fingerprintCert } =
  await import("./index");
const { makeFixtureCertSet } = await import("./test-helpers");

type Creds = {
  caCertPem: string;
  clientCertPem: string;
  clientKeyPem: string;
  pinnedFingerprint: string;
};

let creds: Creds;
const baseEnvelope = {
  version: FEDERATION_VERSION,
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  federation: {
    from: { deployment: "deployment-a", role: "researcher" },
    to: { deployment: "deployment-b", role: "code-reviewer" },
    mtls: { client_cert_subject: "CN=deployment-a" },
  },
  kind: "question" as const,
  payload: "review the patch",
};

beforeAll(() => {
  const c = makeFixtureCertSet();
  creds = {
    caCertPem: c.caCertPem,
    clientCertPem: c.clientCertPem,
    clientKeyPem: c.clientKeyPem,
    pinnedFingerprint: c.pinnedFingerprint,
  };
});

afterEach(() => {
  lastCall = undefined;
  mode = "manual";
  respondStatus = 200;
  respondChunks = [];
});

// Restore the genuine `node:https` so the stub cannot outlive this file.
afterAll(() => {
  mock.module("node:https", () => realHttps);
});

/**
 * Drive the pinned-cert check for an in-flight call, then settle the call by
 * rejecting it (the production code has no other exit once the request is live
 * and no response is delivered). Returns whatever `checkServerIdentity`
 * returned so the caller can assert on it.
 */
async function inspectThenSettle(
  call: Promise<unknown>,
  peer: Partial<PeerCertificate>,
): Promise<Error | undefined> {
  // Let the synchronous request-assembly body of defaultTransport run.
  await Promise.resolve();
  const check = lastCall?.opts.checkServerIdentity;
  expect(typeof check).toBe("function");
  const result = check?.(
    "deployment-b.example",
    peer as unknown as Parameters<NonNullable<typeof check>>[1],
  );
  // Settle the dangling promise so no handle is left open.
  lastCall?.req.emit("error", new Error("teardown"));
  await expect(call).rejects.toThrow();
  return result as Error | undefined;
}

describe("defaultTransport (real node:https path, request mocked)", () => {
  test("rejects a non-https url before issuing any request", async () => {
    await expect(
      federationCall({
        url: "http://deployment-b.example/federation",
        envelope: baseEnvelope,
        credentials: creds,
      }),
    ).rejects.toThrow(/federation transport requires https:\/\/, got http:/);
    // The guard returns before `httpsRequest` is ever called.
    expect(lastCall).toBeUndefined();
  });

  test("happy path POSTs the encoded envelope and resolves with status + body", async () => {
    mode = "respond";
    respondStatus = 200;
    respondChunks = [Buffer.from('{"reply":', "utf8"), Buffer.from('"ack"}', "utf8")];

    const result = await federationCall({
      url: "https://deployment-b.example:8443/federation?trace=1",
      envelope: baseEnvelope,
      credentials: creds,
    });

    expect(result).toEqual({ status: 200, body: '{"reply":"ack"}' });

    // Request options were assembled from the URL.
    const opts = lastCall?.opts;
    expect(opts?.method).toBe("POST");
    expect(opts?.protocol).toBe("https:");
    expect(opts?.hostname).toBe("deployment-b.example");
    expect(opts?.port).toBe("8443");
    expect(opts?.path).toBe("/federation?trace=1");
    expect(opts?.rejectUnauthorized).toBe(true);
    expect(opts?.ca).toBe(creds.caCertPem);
    expect(opts?.cert).toBe(creds.clientCertPem);
    expect(opts?.key).toBe(creds.clientKeyPem);

    // The body written to the socket is the encoded envelope.
    const written = lastCall?.req.written ?? "";
    expect(JSON.parse(written)).toEqual(baseEnvelope);
    expect(lastCall?.req.ended).toBe(true);

    // Headers reflect the encoded body.
    const headers = opts?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Content-Length"]).toBe(Buffer.byteLength(written, "utf8").toString());
    expect(headers["X-Crewhaus-Federation-Version"]).toBe(FEDERATION_VERSION);
  });

  test("defaults the port to 443 and path to '/' when the url omits them", async () => {
    mode = "respond";
    respondStatus = 204;
    respondChunks = [];
    const result = await federationCall({
      url: "https://deployment-b.example",
      envelope: baseEnvelope,
      credentials: creds,
    });
    expect(result).toEqual({ status: 204, body: "" });
    const opts = lastCall?.opts;
    expect(opts?.port).toBe(443); // `u.port || 443` — empty string → numeric default
    expect(opts?.path).toBe("/"); // empty pathname → "/"
  });

  test("resolves status 0 when the response carries no statusCode", async () => {
    mode = "respond";
    respondStatus = undefined; // exercise `res.statusCode ?? 0`
    respondChunks = [Buffer.from("hi", "utf8")];
    const result = await federationCall({
      url: "https://deployment-b.example/federation",
      envelope: baseEnvelope,
      credentials: creds,
    });
    expect(result).toEqual({ status: 0, body: "hi" });
  });

  test("checkServerIdentity accepts a peer cert whose fingerprint matches the pin", async () => {
    const call = federationCall({
      url: "https://deployment-b.example/federation",
      envelope: baseEnvelope,
      credentials: creds,
      timeoutMs: 5_000,
    });
    // Node yields fingerprint256 colon-separated + upper-case; the transport
    // strips ":" and lower-cases before comparing.
    const pinnedColon = creds.pinnedFingerprint.toUpperCase().replace(/(..)(?=.)/g, "$1:");
    const ok = await inspectThenSettle(call, { fingerprint256: pinnedColon });
    expect(ok).toBeUndefined();
  });

  test("checkServerIdentity rejects a peer cert whose fingerprint differs from the pin", async () => {
    const call = federationCall({
      url: "https://deployment-b.example/federation",
      envelope: baseEnvelope,
      credentials: creds,
    });
    const wrong = await inspectThenSettle(call, { fingerprint256: "AA:BB:CC" });
    expect(wrong).toBeInstanceOf(Error);
    expect((wrong as Error).message).toMatch(/cert-pin mismatch/);
  });

  test("checkServerIdentity treats a missing fingerprint256 as '' (mismatch)", async () => {
    const call = federationCall({
      url: "https://deployment-b.example/federation",
      envelope: baseEnvelope,
      credentials: creds,
    });
    // No fingerprint256 → `?? ""` → "" !== pin → Error with empty fp in message.
    const res = await inspectThenSettle(call, {});
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/peer fingerprint {2}!= pinned/);
  });

  test("rejects with a FederationProtocolError when the request emits 'error'", async () => {
    const call = federationCall({
      url: "https://deployment-b.example/federation",
      envelope: baseEnvelope,
      credentials: creds,
    });
    await Promise.resolve(); // let the request assemble + write/end
    expect(lastCall?.req.ended).toBe(true);
    lastCall?.req.emit("error", new Error("ECONNREFUSED boom"));
    await expect(call).rejects.toThrow(/federation transport error: ECONNREFUSED boom/);
    await call.catch((e) => {
      expect(e).toBeInstanceOf(FederationProtocolError);
      // The original socket error is preserved as the cause.
      expect((e as InstanceType<typeof FederationProtocolError>).cause).toBeInstanceOf(Error);
    });
  });

  test("on 'timeout' it destroys the request and rejects with the configured timeout", async () => {
    const call = federationCall({
      url: "https://deployment-b.example/federation",
      envelope: baseEnvelope,
      credentials: creds,
      timeoutMs: 1234,
    });
    await Promise.resolve();
    expect(lastCall?.opts.timeout).toBe(1234);
    // Fire the socket timeout: the handler calls req.destroy(err); our fake
    // surfaces that destroy reason as an `error` event, which rejects.
    lastCall?.req.emit("timeout");
    await expect(call).rejects.toThrow(/federation transport timeout after 1234ms/);
    expect(lastCall?.req.destroyedWith).toBeInstanceOf(FederationProtocolError);
  });

  test("uses the default 30s timeout when none is supplied", async () => {
    const call = federationCall({
      url: "https://deployment-b.example/federation",
      envelope: baseEnvelope,
      credentials: creds,
    });
    await Promise.resolve();
    expect(lastCall?.opts.timeout).toBe(30_000);
    // Settle so no handle dangles.
    lastCall?.req.emit("error", new Error("teardown"));
    await expect(call).rejects.toThrow();
  });

  test("fingerprintCert agrees with the pin the transport compares against", () => {
    // Anchors the colon-stripping / lower-casing contract checkServerIdentity
    // relies on: the helper and the pin must agree on the same canonical form.
    expect(fingerprintCert(creds.clientCertPem)).toBe(creds.pinnedFingerprint);
  });
});

/*
 * Intentionally NOT covered: the response-stream-error branch.
 *
 * `defaultTransport`'s response handler (src/index.ts) registers only
 * `res.on("data")` and `res.on("end")` — there is no `res.on("error")`. If a
 * response stream were to emit `"error"` mid-body, the returned Promise would
 * neither resolve nor reject; it would hang forever (and Node would treat it as
 * an unhandled stream error). Driving that branch from a test is therefore
 * impossible without leaving an unsettled promise / open handle, which is the
 * exact defect that hung the previous incarnation of this file. Every other
 * line of the transport (212-272) is exercised above with a settling promise,
 * so this omission does not reduce coverage of any reachable line/function.
 */
