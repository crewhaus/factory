/**
 * The emitted graph worker, executed: `/chat` answers only with its
 * `CHAT_TOKEN` bearer, and a tool runs only when an `alwaysAllow` rule covers
 * the call. Every network call is stubbed (see `test-helpers.ts`).
 */
import { describe, expect, test } from "bun:test";
import type { IrGraphNode, IrGraphV0, IrPermissions } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerGraph } from "./index";
import {
  type DriveJob,
  chatBody,
  drive,
  parseSse,
  resultText,
  textTurn,
  toolResults,
  toolTurn,
} from "./test-helpers";

const SRC_DIR = import.meta.dir;
/** The worker's secret and the right bearer for it, made at run time. */
const CHAT_TOKEN = `chat-${crypto.randomUUID()}`;
const AUTHORIZED = { authorization: `Bearer ${CHAT_TOKEN}`, "content-type": "application/json" };
const ENV = { ANTHROPIC_API_KEY: "sk-test", CHAT_TOKEN };

const node = (name: string, over: Partial<IrGraphNode> = {}): IrGraphNode => ({
  name,
  instructions: `Do ${name}.`,
  model: "claude-haiku-4-5-20251001",
  tools: [],
  toolConfigs: Object.freeze({}),
  ...over,
});

const baseIr: IrGraphV0 = {
  version: 0,
  name: "edge-graph",
  target: "graph",
  entry: "plan",
  nodes: [node("plan"), node("act")],
  edges: [{ from: "plan", to: "act" }],
  permissions: { rules: [] },
  compaction: {},
};

const workerOf = (ir: IrGraphV0): string =>
  emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content ?? "";

/** A one-node graph whose node carries `tools`. */
const toolGraph = (tools: string[], permissions: IrPermissions): IrGraphV0 => ({
  ...baseIr,
  entry: "fetcher",
  nodes: [node("fetcher", { tools })],
  edges: [],
  permissions,
});

const chat = (worker: string, job: DriveJob = {}) =>
  drive(SRC_DIR, worker, { headers: AUTHORIZED, env: ENV, body: chatBody(), ...job });

const webFetchChat = (worker: string) =>
  chat(worker, {
    turns: [toolTurn("tu_1", "WebFetch", { url: "https://api.example.com/data" }), textTurn("ok")],
  });

describe("cf-worker graph — /chat answers only with the CHAT_TOKEN bearer", () => {
  const worker = workerOf(baseIr);

  test("no Authorization header: 401 with a Bearer challenge, and no model call", async () => {
    const r = await drive(SRC_DIR, worker, { env: ENV, body: chatBody(), turns: [textTurn("x")] });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBe("Bearer");
    expect(r.calls).toBe(0);
  });

  test("a wrong token gets the identical 401", async () => {
    const missing = await drive(SRC_DIR, worker, { env: ENV, body: chatBody() });
    const wrong = await drive(SRC_DIR, worker, {
      headers: { authorization: `Bearer chat-${crypto.randomUUID()}` },
      env: ENV,
      body: chatBody(),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.raw).toBe(missing.raw);
    expect(wrong.calls).toBe(0);
  });

  test("with CHAT_TOKEN unset or empty, every request is answered 503 NO_CHAT_TOKEN", async () => {
    for (const env of [
      { ANTHROPIC_API_KEY: "sk-test" },
      { ANTHROPIC_API_KEY: "sk-test", CHAT_TOKEN: "" },
    ]) {
      const r = await drive(SRC_DIR, worker, { headers: AUTHORIZED, env, body: chatBody() });
      expect(r.status).toBe(503);
      expect((JSON.parse(r.raw) as { error: { code: string } }).error.code).toBe("NO_CHAT_TOKEN");
      expect(r.calls).toBe(0);
    }
  });

  test("the right token is served as an event stream", async () => {
    const r = await chat(worker, { turns: [textTurn("a"), textTurn("b")] });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.calls).toBe(2);
  });

  test("a CORS-simple text/plain POST from another origin, without a token, gets 401", async () => {
    const r = await drive(SRC_DIR, worker, {
      headers: { origin: "https://evil.example", "content-type": "text/plain;charset=UTF-8" },
      env: ENV,
      body: chatBody(),
    });
    expect(r.status).toBe(401);
    expect(r.calls).toBe(0);
  });

  test("OPTIONS allows the Authorization header", async () => {
    const r = await drive(SRC_DIR, worker, { method: "OPTIONS", env: ENV });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-headers"]).toContain("Authorization");
  });

  test('GET /health answers exactly {"ok":true}', async () => {
    const r = await drive(SRC_DIR, worker, { method: "GET", path: "/health", env: ENV });
    expect(r.status).toBe(200);
    expect(r.raw).toBe('{"ok":true}');
  });

  test("a public build answers with no CHAT_TOKEN and no header", async () => {
    const r = await drive(SRC_DIR, workerOf({ ...baseIr, cfWorker: { publicChat: true } }), {
      env: { ANTHROPIC_API_KEY: "sk-test" },
      body: chatBody(),
      turns: [textTurn("a"), textTurn("b")],
    });
    expect(r.status).toBe(200);
    expect(r.calls).toBe(2);
  });
});

describe("cf-worker graph — a tool runs only when an alwaysAllow rule covers the call", () => {
  test("no rules: WebFetch is refused as needing approval, with no request and no DNS lookup", async () => {
    const r = await webFetchChat(workerOf(toolGraph(["webFetch"], { rules: [] })));
    expect(r.calls).toBe(2);
    expect(r.outbound).toEqual([]);
    expect(r.dnsLookups).toBe(0);
    const [result] = toolResults(r.modelBodies[1]);
    expect(result?.["is_error"]).toBe(true);
    expect(resultText(result)).toContain("needs approval, and this worker has nobody to give it");
    const decision = parseSse(r.raw).find(
      (e) => e.name === "trace" && e.data["kind"] === "permission_decision",
    );
    expect(decision?.data).toMatchObject({ toolName: "WebFetch", decision: "ask" });
  });

  test("a deny with an allow, in either order, is refused with no request", async () => {
    const deny = { type: "alwaysDeny" as const, pattern: "WebFetch" };
    const allow = { type: "alwaysAllow" as const, pattern: "WebFetch" };
    for (const rules of [
      [deny, allow],
      [allow, deny],
    ]) {
      const r = await webFetchChat(workerOf(toolGraph(["webFetch"], { rules })));
      expect(r.outbound).toEqual([]);
      expect(r.dnsLookups).toBe(0);
      expect(toolResults(r.modelBodies[1])[0]?.["is_error"]).toBe(true);
    }
    // The control: the allow alone runs it.
    const ran = await webFetchChat(workerOf(toolGraph(["webFetch"], { rules: [allow] })));
    expect(ran.outbound).toHaveLength(1);
    expect(toolResults(ran.modelBodies[1])[0]?.["is_error"]).toBe(false);
  });
});

describe("cf-worker graph — what the worker source carries", () => {
  test("CONFIG carries permissions and publicChat, and every node's loop gets the permissions", () => {
    const worker = workerOf({
      ...baseIr,
      permissions: { mode: "plan", rules: [{ type: "alwaysAllow", pattern: "WebFetch" }] },
      cfWorker: { publicChat: true },
    });
    expect(worker).toContain(
      '  permissions: {"mode":"plan","rules":[{"type":"alwaysAllow","pattern":"WebFetch"}]},\n  publicChat: true,\n',
    );
    expect(worker.match(/runWorkerLoop\(\{/g)).toHaveLength(1);
    expect(worker).toContain("permissions: CONFIG.permissions,");
    expect(workerOf(baseIr)).toContain('  permissions: {"rules":[]},\n  publicChat: false,\n');
  });

  test("the bearer check comes before handleChat", () => {
    const worker = workerOf(baseIr);
    const check = worker.indexOf("chatAuthRefusal(");
    const handle = worker.indexOf("handleChat(");
    expect(check).toBeGreaterThan(-1);
    expect(handle).toBeGreaterThan(-1);
    expect(check).toBeLessThan(handle);
  });

  test("a justify escalation is refused at emit", () => {
    expect(() =>
      emitCfWorkerGraph({ ...baseIr, limits: { loopDetection: { escalation: "justify" } } }),
    ).toThrow(
      "limits.loop_detection.escalation: justify needs the intent gate, which a worker does not run — use warn or abort",
    );
  });

  test("a judge node is refused at emit, naming the node", () => {
    const gated: IrGraphV0 = {
      ...baseIr,
      nodes: [
        node("plan"),
        node("gate", { kind: "judge", judge: { criteria: "no secrets", threshold: 0.9 } as never }),
        node("act"),
      ],
      edges: [
        { from: "plan", to: "gate" },
        { from: "gate", to: "act" },
      ],
    };
    expect(() => emitCfWorkerGraph(gated)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(gated)).toThrow(
      'cf-worker-graph does not run judge gates (node "gate" is kind: judge); use the local graph target for a gated graph',
    );
  });

  test("an edge with a when condition is refused at emit, naming the edge", () => {
    const conditional: IrGraphV0 = {
      ...baseIr,
      edges: [{ from: "plan", to: "act", when: { key: "plan", equals: "safe" } }],
    };
    expect(() => emitCfWorkerGraph(conditional)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(conditional)).toThrow(
      'cf-worker-graph does not evaluate edge conditions (edge "plan" → "act" has when); use the local graph target for a conditional graph',
    );
    // The same edge without the condition emits.
    expect(emitCfWorkerGraph(baseIr).files.length).toBeGreaterThan(0);
  });
});
