/**
 * The emitted workflow worker, executed: `/chat` answers only with its
 * `CHAT_TOKEN` bearer, a tool runs only when an `alwaysAllow` rule covers the
 * call, and `limits.deadline_ms` bounds the whole run. Every network call is
 * stubbed (see `test-helpers.ts`).
 */
import { describe, expect, test } from "bun:test";
import type { IrPermissions, IrWorkflowStep, IrWorkflowV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerWorkflow } from "./index";
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

const step = (name: string, over: Partial<IrWorkflowStep> = {}): IrWorkflowStep => ({
  name,
  instructions: `Do ${name}.`,
  model: "claude-haiku-4-5-20251001",
  tools: [],
  toolConfigs: Object.freeze({}),
  ...over,
});

const baseIr: IrWorkflowV0 = {
  version: 0,
  name: "edge-flow",
  target: "workflow",
  steps: [step("one"), step("two"), step("three")],
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

const workerOf = (ir: IrWorkflowV0): string =>
  emitCfWorkerWorkflow(ir).files.find((f) => f.path === "worker.js")?.content ?? "";

/** A one-step workflow whose step carries `tools`. */
const toolFlow = (tools: string[], permissions: IrPermissions): IrWorkflowV0 => ({
  ...baseIr,
  steps: [step("fetcher", { tools })],
  permissions,
});

const chat = (worker: string, job: DriveJob = {}) =>
  drive(SRC_DIR, worker, { headers: AUTHORIZED, env: ENV, body: chatBody(), ...job });

const webFetchChat = (worker: string) =>
  chat(worker, {
    turns: [toolTurn("tu_1", "WebFetch", { url: "https://api.example.com/data" }), textTurn("ok")],
  });

describe("cf-worker workflow — /chat answers only with the CHAT_TOKEN bearer", () => {
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
    const r = await chat(worker, { turns: [textTurn("a"), textTurn("b"), textTurn("c")] });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.calls).toBe(3);
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
      turns: [textTurn("a"), textTurn("b"), textTurn("c")],
    });
    expect(r.status).toBe(200);
    expect(r.calls).toBe(3);
  });
});

describe("cf-worker workflow — a tool runs only when an alwaysAllow rule covers the call", () => {
  test("no rules: WebFetch is refused as needing approval, with no request and no DNS lookup", async () => {
    const r = await webFetchChat(workerOf(toolFlow(["webFetch"], { rules: [] })));
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
      const r = await webFetchChat(workerOf(toolFlow(["webFetch"], { rules })));
      expect(r.outbound).toEqual([]);
      expect(r.dnsLookups).toBe(0);
      expect(toolResults(r.modelBodies[1])[0]?.["is_error"]).toBe(true);
    }
    // The control: the allow alone runs it.
    const ran = await webFetchChat(workerOf(toolFlow(["webFetch"], { rules: [allow] })));
    expect(ran.outbound).toHaveLength(1);
    expect(toolResults(ran.modelBodies[1])[0]?.["is_error"]).toBe(false);
  });
});

describe("cf-worker workflow — limits.deadline_ms bounds the whole run", () => {
  // A clock the model stub moves by 1000 ms on each call, so every step's
  // model call takes a second of it.
  const run = (limits: IrWorkflowV0["limits"]) =>
    chat(workerOf({ ...baseIr, ...(limits !== undefined ? { limits } : {}) }), {
      turns: [textTurn("a"), textTurn("b"), textTurn("c")],
      clockStep: 1000,
    });

  test("a step that would start past the deadline is not started, and the run says so", async () => {
    const r = await run({ deadlineMs: 1500 });
    expect(r.calls).toBe(2);
    const events = parseSse(r.raw);
    expect(events.some((e) => e.name === "done")).toBe(false);
    expect(events.find((e) => e.name === "error")?.data["message"]).toBe(
      'step "three": run deadline exceeded: the run exceeded its 1500ms deadline before this step started',
    );
  });

  test("without deadline_ms every step runs", async () => {
    const r = await run(undefined);
    expect(r.calls).toBe(3);
    expect(parseSse(r.raw).some((e) => e.name === "done")).toBe(true);
  });

  test("the run's start is stamped once and each step is handed what remains", () => {
    const worker = workerOf({ ...baseIr, limits: { deadlineMs: 1500 } });
    expect(worker.match(/const runStartedAt = platform\.now\(\);/g)).toHaveLength(1);
    const stamp = worker.indexOf("const runStartedAt = platform.now();");
    const loop = worker.indexOf("for (let i = 0; i < total; i++)");
    const handed = worker.indexOf(
      "limits: { ...CONFIG.limits, deadlineMs: Math.max(1, CONFIG.limits.deadlineMs - elapsed) },",
    );
    expect(stamp).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(handed).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(loop);
    expect(loop).toBeLessThan(handed);
    // CONFIG keeps the declared value.
    expect(worker).toContain('limits: {"deadlineMs":1500},');
    // Without the key, no step is handed a deadline.
    const plain = workerOf({ ...baseIr, limits: { maxToolIterations: 3 } });
    expect(plain).not.toContain("runStartedAt");
    expect(plain).not.toContain("deadlineMs");
  });
});

describe("cf-worker workflow — what the worker source carries", () => {
  test("CONFIG carries permissions and publicChat, and every step's loop gets the permissions", () => {
    const worker = workerOf({
      ...baseIr,
      permissions: { mode: "auto", rules: [{ type: "alwaysAsk", pattern: "Fetch" }] },
    });
    expect(worker).toContain(
      '  permissions: {"mode":"auto","rules":[{"type":"alwaysAsk","pattern":"Fetch"}]},\n  publicChat: false,\n',
    );
    expect(worker.match(/runWorkerLoop\(\{/g)).toHaveLength(1);
    expect(worker).toContain("permissions: CONFIG.permissions,");
    expect(workerOf(baseIr)).toContain('  permissions: {"rules":[]},\n');
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
      emitCfWorkerWorkflow({ ...baseIr, limits: { loopDetection: { escalation: "justify" } } }),
    ).toThrow(
      "limits.loop_detection.escalation: justify needs the intent gate, which a worker does not run — use warn or abort",
    );
  });

  test("a judge step is refused at emit, naming the step", () => {
    const gated: IrWorkflowV0 = {
      ...baseIr,
      steps: [
        step("draft"),
        step("gate", { kind: "judge", judge: { criteria: "no secrets", threshold: 0.9 } as never }),
        step("final"),
      ],
    };
    expect(() => emitCfWorkerWorkflow(gated)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerWorkflow(gated)).toThrow(
      'cf-worker-workflow does not run judge gates (step "gate" is kind: judge); use the local workflow target for a gated workflow',
    );
  });
});
