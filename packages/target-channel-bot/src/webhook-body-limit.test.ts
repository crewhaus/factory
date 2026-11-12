/**
 * The emitted gateway reads a webhook body only up to a limit, and before it
 * verifies anything.
 *
 * Runs the REAL generated `gateway.ts`, written beside the package sources so
 * its `@crewhaus/*` imports resolve, with a stub adapter that counts its
 * `verify` calls and checks an HMAC over the body it is handed. Every body is
 * a counting stream, so "the read stopped" is a number of bytes pulled, never
 * a stopwatch or an RSS reading.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IrChannelV0 } from "@crewhaus/ir";
import { emitChannelBot } from "./index.js";

const MIN_IR: IrChannelV0 = {
  version: 0,
  name: "demo",
  target: "channel",
  agent: { model: "claude-sonnet-4-6", instructions: "be helpful" },
  tools: [],
  toolConfigs: {},
  channels: {
    slack: {
      botToken: { kind: "env", name: "SLACK_BOT_TOKEN" },
      signingSecret: { kind: "env", name: "SLACK_SIGNING_SECRET" },
    },
  },
  routing: { sessionKey: "thread" },
  mcp_servers: {},
  permissions: { rules: [] },
  subAgents: [],
  compaction: {},
};

/** Built from parts so no signing-secret-shaped literal sits in the source. */
const STUB_KEY = ["stub", "hmac", "material"].join("-");

const sign = (body: string): string => createHmac("sha256", STUB_KEY).update(body).digest("hex");

type GatewayModule = {
  createGateway(config: {
    adapters: ReadonlyMap<string, unknown>;
    sessionRouter: unknown;
    maxBodyBytes?: number;
  }): { handle(req: Request): Promise<Response> };
};

let dir = "";
let mod: GatewayModule;

beforeAll(async () => {
  const gateway = emitChannelBot(MIN_IR).files.find((f) => f.path === "gateway.ts");
  if (gateway === undefined) throw new Error("no gateway.ts emitted");
  dir = mkdtempSync(join(import.meta.dir, ".webhook-limit-"));
  writeFileSync(join(dir, "gateway.ts"), gateway.content);
  mod = (await import(join(dir, "gateway.ts"))) as GatewayModule;
});

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

/** A stub adapter: verify() checks the HMAC over the body it was handed. */
function stubAdapter() {
  const seen = { verifyCalls: 0, bodies: [] as string[] };
  const adapter = {
    id: "slack",
    verify(req: { headers: Headers; body: string }): boolean {
      seen.verifyCalls++;
      seen.bodies.push(req.body);
      return req.headers.get("x-stub-signature") === sign(req.body);
    },
    parseInbound: () => ({ kind: "skip" as const }),
    parseInteraction: () => ({ kind: "other" as const }),
    sendReply: async () => {},
    setTyping: async () => {},
  };
  return { adapter, seen };
}

const router = {
  handle: async () => {},
  handleReaction: async () => {},
  resumeApproval: async () => {},
};

/**
 * A body of `chunks` × `chunkBytes` bytes that counts what is pulled from it
 * and whether it was cancelled.
 */
function countingBody(chunks: number, chunkBytes: number) {
  const counter = { pulled: 0, cancelled: false };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) {
        controller.close();
        return;
      }
      sent++;
      counter.pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
    cancel() {
      counter.cancelled = true;
    },
  });
  return { stream, counter };
}

function post(path: string, body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

const LIMIT = 4096;

for (const path of ["/slack/events", "/slack/actions"]) {
  describe(`the emitted gateway's ${path} route holds a body to the limit`, () => {
    test("a signed body at the limit verifies, with the body intact (the control)", async () => {
      const { adapter, seen } = stubAdapter();
      const gw = mod.createGateway({
        adapters: new Map([["slack", adapter]]),
        sessionRouter: router,
        maxBodyBytes: LIMIT,
      });
      const body = "a".repeat(LIMIT);
      const res = await gw.handle(post(path, body, { "x-stub-signature": sign(body) }));
      expect(res.status).toBe(200);
      expect(seen.verifyCalls).toBe(1);
      expect(seen.bodies[0]).toBe(body);
      // A wrong signature is still refused: the limit changed nothing after it.
      const bad = await gw.handle(post(path, body, { "x-stub-signature": "0" }));
      expect(bad.status).toBe(401);
    });

    test("a declared Content-Length over the limit is 413 with nothing read and verify never called", async () => {
      const { adapter, seen } = stubAdapter();
      const gw = mod.createGateway({
        adapters: new Map([["slack", adapter]]),
        sessionRouter: router,
        maxBodyBytes: LIMIT,
      });
      const { stream, counter } = countingBody(64, 1024);
      const res = await gw.handle(
        post(path, stream, { "content-length": String(64 * 1024), "x-stub-signature": "0" }),
      );
      expect(res.status).toBe(413);
      expect(await res.text()).toContain(`${LIMIT} bytes`);
      expect(seen.verifyCalls).toBe(0);
      // At most what the stream queued on its own before anyone read it.
      expect(counter.pulled).toBeLessThanOrEqual(1024);
    });

    test("a streamed body that passes the limit is 413, and the read stops there", async () => {
      const { adapter, seen } = stubAdapter();
      const gw = mod.createGateway({
        adapters: new Map([["slack", adapter]]),
        sessionRouter: router,
        maxBodyBytes: LIMIT,
      });
      // 1 MiB on offer in 1 KiB chunks, with no Content-Length.
      const { stream, counter } = countingBody(1024, 1024);
      const res = await gw.handle(post(path, stream, { "x-stub-signature": "0" }));
      expect(res.status).toBe(413);
      expect(seen.verifyCalls).toBe(0);
      expect(counter.cancelled).toBe(true);
      // The limit plus the chunk that crossed it, and the one the stream may
      // have queued ahead: nowhere near the megabyte on offer.
      expect(counter.pulled).toBeGreaterThan(LIMIT);
      expect(counter.pulled).toBeLessThanOrEqual(LIMIT + 2 * 1024);
    });

    test("a malformed Content-Length is refused before verify", async () => {
      const { adapter, seen } = stubAdapter();
      const gw = mod.createGateway({
        adapters: new Map([["slack", adapter]]),
        sessionRouter: router,
        maxBodyBytes: LIMIT,
      });
      for (const length of ["12abc", "-1", "1e3", "4, 4"]) {
        const res = await gw.handle(post(path, "abcd", { "content-length": length }));
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("invalid content-length");
      }
      expect(seen.verifyCalls).toBe(0);
    });
  });
}

describe("CHANNEL_WEBHOOK_MAX_BYTES moves the gateway's limit", () => {
  const saved = process.env["CHANNEL_WEBHOOK_MAX_BYTES"];
  afterAll(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "CHANNEL_WEBHOOK_MAX_BYTES");
    else process.env["CHANNEL_WEBHOOK_MAX_BYTES"] = saved;
  });

  test("with no limit passed, the gateway reads it from the environment", async () => {
    process.env["CHANNEL_WEBHOOK_MAX_BYTES"] = "2048";
    const { adapter, seen } = stubAdapter();
    const gw = mod.createGateway({
      adapters: new Map([["slack", adapter]]),
      sessionRouter: router,
    });
    const small = "b".repeat(2048);
    expect(
      (await gw.handle(post("/slack/events", small, { "x-stub-signature": sign(small) }))).status,
    ).toBe(200);
    const large = "b".repeat(2049);
    expect(
      (await gw.handle(post("/slack/events", large, { "x-stub-signature": sign(large) }))).status,
    ).toBe(413);
    expect(seen.verifyCalls).toBe(1);
  });

  test("unset, the limit is 1 MiB", async () => {
    Reflect.deleteProperty(process.env, "CHANNEL_WEBHOOK_MAX_BYTES");
    const { adapter, seen } = stubAdapter();
    const gw = mod.createGateway({
      adapters: new Map([["slack", adapter]]),
      sessionRouter: router,
    });
    const at = "c".repeat(1024 * 1024);
    expect(
      (await gw.handle(post("/slack/events", at, { "x-stub-signature": sign(at) }))).status,
    ).toBe(200);
    const over = `${at}c`;
    expect((await gw.handle(post("/slack/events", over))).status).toBe(413);
    expect(seen.verifyCalls).toBe(1);
  });
});

describe("the emitted daemon holds the public port to the same limit", () => {
  test("Bun.serve gets maxRequestBodySize and the gateway gets maxBodyBytes, from one resolved limit", () => {
    const daemon = emitChannelBot(MIN_IR).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    const required = [
      'import { resolveWebhookBodyLimit } from "@crewhaus/gateway-protocol/body-limit";',
      "const __webhookBodyLimit = resolveWebhookBodyLimit(process.env);",
      "    maxBodyBytes: __webhookBodyLimit.maxBytes,\n  });",
      "    port,\n    maxRequestBodySize: __webhookBodyLimit.maxBytes,\n",
    ];
    expect(required.filter((text) => !daemon.includes(text))).toEqual([]);
  });

  test("behind a real Bun.serve with that limit, a streamed body over it is still 413", async () => {
    const { adapter, seen } = stubAdapter();
    const gw = mod.createGateway({
      adapters: new Map([["slack", adapter]]),
      sessionRouter: router,
      maxBodyBytes: LIMIT,
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      maxRequestBodySize: LIMIT,
      fetch: (req) => gw.handle(req),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/slack/events`;
      // Declared over the limit: the server answers before the gateway runs.
      const declared = await fetch(url, { method: "POST", body: "d".repeat(LIMIT + 1) });
      expect(declared.status).toBe(413);
      // Chunked: the server lets it through (it checks a declared length
      // only), and the gateway's count stops it.
      const { stream } = countingBody(64, 1024);
      const chunked = await fetch(url, {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit);
      expect(chunked.status).toBe(413);
      expect(seen.verifyCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
