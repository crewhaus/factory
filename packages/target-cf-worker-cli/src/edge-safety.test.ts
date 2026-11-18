/**
 * The emitted cli worker, executed: `/chat` answers only with its
 * `CHAT_TOKEN` bearer, and a tool runs only when an `alwaysAllow` rule covers
 * the call. Every network call is stubbed (see `test-helpers.ts`): a refused
 * call is shown to make no request and no DNS lookup.
 */
import { describe, expect, test } from "bun:test";
import type { IrPermissions, IrV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerCli } from "./index";
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
/** A test that drives the worker spawns a `bun` subprocess per request, slow by construction on CI runners. */
const DRIVE_DEADLINE_MS = 20_000;
/** The worker's secret and the right bearer for it, made at run time. */
const CHAT_TOKEN = `chat-${crypto.randomUUID()}`;
const AUTHORIZED = { authorization: `Bearer ${CHAT_TOKEN}`, "content-type": "application/json" };
const ENV = { ANTHROPIC_API_KEY: "sk-test", CHAT_TOKEN };

const baseIr: IrV0 = {
  version: 0,
  name: "edge-cli",
  target: "cli",
  agent: { model: "claude-haiku-4-5-20251001", instructions: "You are a helpful assistant." },
  tools: [],
  toolConfigs: Object.freeze({}),
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  subAgents: [],
  compaction: {},
};

const workerOf = (ir: IrV0): string =>
  emitCfWorkerCli(ir).files.find((f) => f.path === "worker.js")?.content ?? "";

const withTools = (tools: string[], permissions: IrPermissions): IrV0 => ({
  ...baseIr,
  tools,
  permissions,
});

/** POST /chat with the right bearer. */
const chat = (worker: string, job: DriveJob = {}) =>
  drive(SRC_DIR, worker, { headers: AUTHORIZED, env: ENV, body: chatBody(), ...job });

/** A chat whose first model turn calls WebFetch on `url`. */
const webFetchChat = (worker: string, url = "https://api.example.com/data") =>
  chat(worker, { turns: [toolTurn("tu_1", "WebFetch", { url }), textTurn("done")] });

describe("cf-worker cli — /chat answers only with the CHAT_TOKEN bearer", () => {
  const worker = workerOf(baseIr);

  test(
    "no Authorization header: 401 with a Bearer challenge, and no model call",
    async () => {
      const r = await drive(SRC_DIR, worker, {
        headers: { "content-type": "application/json" },
        env: ENV,
        body: chatBody(),
        turns: [textTurn("never")],
      });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toBe("Bearer");
      expect(JSON.parse(r.raw)).toEqual({
        error: { code: "UNAUTHORIZED", message: "a valid bearer token is required" },
      });
      expect(r.calls).toBe(0);
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "a wrong token gets the identical 401",
    async () => {
      const missing = await drive(SRC_DIR, worker, { env: ENV, body: chatBody() });
      const wrong = await drive(SRC_DIR, worker, {
        headers: { authorization: `Bearer chat-${crypto.randomUUID()}` },
        env: ENV,
        body: chatBody(),
        turns: [textTurn("never")],
      });
      expect(wrong.status).toBe(401);
      expect(wrong.raw).toBe(missing.raw);
      expect(wrong.calls).toBe(0);
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "with CHAT_TOKEN unset or empty, every request is answered 503 NO_CHAT_TOKEN",
    async () => {
      for (const env of [
        { ANTHROPIC_API_KEY: "sk-test" },
        { ANTHROPIC_API_KEY: "sk-test", CHAT_TOKEN: "" },
      ]) {
        const r = await drive(SRC_DIR, worker, {
          headers: AUTHORIZED,
          env,
          body: chatBody(),
          turns: [textTurn("never")],
        });
        expect(r.status).toBe(503);
        expect((JSON.parse(r.raw) as { error: { code: string } }).error.code).toBe("NO_CHAT_TOKEN");
        expect(r.calls).toBe(0);
      }
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "the right token is served as an event stream",
    async () => {
      const r = await chat(worker, { turns: [textTurn("Hello")] });
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("text/event-stream");
      expect(r.calls).toBe(1);
      expect(parseSse(r.raw).find((e) => e.name === "done")?.data).toEqual({
        text: "Hello",
        stopReason: "end_turn",
      });
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "a CORS-simple text/plain POST from another origin, without a token, gets 401 and no model call",
    async () => {
      const r = await drive(SRC_DIR, worker, {
        headers: { origin: "https://evil.example", "content-type": "text/plain;charset=UTF-8" },
        env: ENV,
        body: chatBody(),
        turns: [textTurn("never")],
      });
      expect(r.status).toBe(401);
      expect(r.calls).toBe(0);
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "OPTIONS allows the Authorization header",
    async () => {
      const r = await drive(SRC_DIR, worker, { method: "OPTIONS", env: ENV });
      expect(r.status).toBe(204);
      expect(r.headers["access-control-allow-headers"]).toContain("Authorization");
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    'GET /health answers exactly {"ok":true}, without a token',
    async () => {
      const r = await drive(SRC_DIR, worker, { method: "GET", path: "/health", env: ENV });
      expect(r.status).toBe(200);
      expect(r.raw).toBe('{"ok":true}');
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "a public build (cf_worker.public_chat) answers with no CHAT_TOKEN and no header",
    async () => {
      const publicWorker = workerOf({ ...baseIr, cfWorker: { publicChat: true } });
      const r = await drive(SRC_DIR, publicWorker, {
        env: { ANTHROPIC_API_KEY: "sk-test" },
        body: chatBody(),
        turns: [textTurn("Hello")],
      });
      expect(r.status).toBe(200);
      expect(r.calls).toBe(1);
    },
    DRIVE_DEADLINE_MS,
  );
});

describe("cf-worker cli — a tool runs only when an alwaysAllow rule covers the call", () => {
  test(
    "no rules: WebFetch is refused as needing approval, with no request and no DNS lookup",
    async () => {
      const r = await webFetchChat(workerOf(withTools(["webFetch"], { rules: [] })));
      expect(r.error).toBeUndefined();
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
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "a deny with an allow, in either order, is refused with no request",
    async () => {
      for (const rules of [
        [
          { type: "alwaysDeny" as const, pattern: "WebFetch" },
          { type: "alwaysAllow" as const, pattern: "WebFetch" },
        ],
        [
          { type: "alwaysAllow" as const, pattern: "WebFetch" },
          { type: "alwaysDeny" as const, pattern: "WebFetch" },
        ],
      ]) {
        const r = await webFetchChat(workerOf(withTools(["webFetch"], { rules })));
        expect(r.outbound).toEqual([]);
        expect(r.dnsLookups).toBe(0);
        const [result] = toolResults(r.modelBodies[1]);
        expect(result?.["is_error"]).toBe(true);
        expect(resultText(result)).toContain(
          "an alwaysDeny rule in this worker's permissions denies",
        );
      }
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "alwaysAllow WebFetch runs it: one request, and a result that is not an error",
    async () => {
      const r = await webFetchChat(
        workerOf(
          withTools(["webFetch"], { rules: [{ type: "alwaysAllow", pattern: "WebFetch" }] }),
        ),
      );
      expect(r.outbound).toHaveLength(1);
      expect(r.outbound[0]).toMatch(/^GET https:\/\/93\.184\.215\.14\/data/);
      expect(r.dnsLookups).toBe(1);
      const [result] = toolResults(r.modelBodies[1]);
      expect(result?.["is_error"]).toBe(false);
      expect(resultText(result)).toContain("stub page body");
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "an argument-scoped allow runs its own site and refuses another",
    async () => {
      const worker = workerOf(
        withTools(["webFetch"], {
          rules: [{ type: "alwaysAllow", pattern: "WebFetch(https://api.example.com/**)" }],
        }),
      );
      const inScope = await webFetchChat(worker, "https://api.example.com/v1/items");
      expect(inScope.outbound).toHaveLength(1);
      expect(toolResults(inScope.modelBodies[1])[0]?.["is_error"]).toBe(false);
      const outOfScope = await webFetchChat(worker, "https://other.example.com/v1/items");
      expect(outOfScope.outbound).toEqual([]);
      expect(outOfScope.dnsLookups).toBe(0);
      expect(toolResults(outOfScope.modelBodies[1])[0]?.["is_error"]).toBe(true);
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "alwaysAsk is refused under ask_mode pause and deny alike, and the two workers are the same bytes",
    async () => {
      const rules = [{ type: "alwaysAsk" as const, pattern: "WebFetch" }];
      const paused = workerOf(withTools(["webFetch"], { rules, askMode: "pause" }));
      const denied = workerOf(withTools(["webFetch"], { rules, askMode: "deny" }));
      expect(paused).toBe(denied);
      for (const worker of [paused, denied]) {
        const r = await webFetchChat(worker);
        expect(r.outbound).toEqual([]);
        const [result] = toolResults(r.modelBodies[1]);
        expect(result?.["is_error"]).toBe(true);
        expect(resultText(result)).toContain("an alwaysAsk rule needs a person to approve");
      }
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "plan mode refuses a tool that is not read-only, so its checklist never reaches the model",
    async () => {
      const todoChat = (permissions: IrPermissions) =>
        chat(workerOf(withTools(["todoWrite"], permissions)), {
          turns: [
            toolTurn("tu_1", "TodoWrite", {
              todos: [{ id: "1", content: "ship it", status: "pending", priority: "high" }],
            }),
            textTurn("done"),
          ],
        });
      const rules = [{ type: "alwaysAllow" as const, pattern: "TodoWrite" }];
      // TodoWrite answers with the list as a markdown checklist.
      const CHECKLIST = "- [ ] (high) ship it";
      // The control: in default mode its allow runs it, and the checklist goes back to the model.
      const ran = await todoChat({ rules });
      expect(ran.modelBodies[1]).toContain(CHECKLIST);
      const r = await todoChat({ mode: "plan", rules });
      const [result] = toolResults(r.modelBodies[1]);
      expect(result?.["is_error"]).toBe(true);
      expect(resultText(result)).toContain("plan mode runs only read-only tools");
      expect(r.modelBodies[1]).not.toContain(CHECKLIST);
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "plan mode runs a read-only tool its allow covers",
    async () => {
      const r = await webFetchChat(
        workerOf(
          withTools(["webFetch"], {
            mode: "plan",
            rules: [{ type: "alwaysAllow", pattern: "WebFetch" }],
          }),
        ),
      );
      expect(r.outbound).toHaveLength(1);
      expect(toolResults(r.modelBodies[1])[0]?.["is_error"]).toBe(false);
    },
    DRIVE_DEADLINE_MS,
  );

  test(
    "mode auto with no rules is refused, as default is",
    async () => {
      const r = await webFetchChat(workerOf(withTools(["webFetch"], { mode: "auto", rules: [] })));
      expect(r.outbound).toEqual([]);
      const [result] = toolResults(r.modelBodies[1]);
      expect(result?.["is_error"]).toBe(true);
      expect(resultText(result)).toContain("needs approval");
    },
    DRIVE_DEADLINE_MS,
  );
});

describe("cf-worker cli — what the worker source carries", () => {
  test("CONFIG carries permissions (mode only when set) and publicChat", () => {
    expect(workerOf(baseIr)).toContain('  permissions: {"rules":[]},\n  publicChat: false,\n');
    const ruled = workerOf({
      ...baseIr,
      permissions: {
        mode: "plan",
        askMode: "deny",
        rules: [{ type: "alwaysAllow", pattern: "WebFetch" }],
      },
      cfWorker: { publicChat: true },
    });
    expect(ruled).toContain(
      '  permissions: {"mode":"plan","rules":[{"type":"alwaysAllow","pattern":"WebFetch"}]},\n  publicChat: true,\n',
    );
    expect(ruled).not.toContain("askMode");
  });

  test("the runWorkerLoop call passes the permissions, and the bearer check comes before handleChat", () => {
    const worker = workerOf(baseIr);
    expect(worker.match(/runWorkerLoop\(\{/g)).toHaveLength(1);
    expect(worker).toContain("permissions: CONFIG.permissions,");
    const check = worker.indexOf("chatAuthRefusal(");
    const handle = worker.indexOf("handleChat(");
    expect(check).toBeGreaterThan(-1);
    expect(handle).toBeGreaterThan(-1);
    expect(check).toBeLessThan(handle);
    expect(worker).toContain('"Access-Control-Allow-Headers": "Content-Type, Authorization"');
  });

  test("a justify escalation is refused at emit", () => {
    expect(() =>
      emitCfWorkerCli({ ...baseIr, limits: { loopDetection: { escalation: "justify" } } }),
    ).toThrow(TargetEmitError);
  });

  test("wrangler.toml and the README name the CHAT_TOKEN secret, or say the worker is public", () => {
    const files = new Map(emitCfWorkerCli(baseIr).files.map((f) => [f.path, f.content]));
    expect(files.get("wrangler.toml")).toContain("wrangler secret put CHAT_TOKEN");
    const readme = files.get("README.md") ?? "";
    expect(readme).toContain("wrangler secret put CHAT_TOKEN");
    expect(readme).toContain('-H "Authorization: Bearer $CHAT_TOKEN"');
    expect(readme).toContain("`NO_CHAT_TOKEN`");
    expect(readme).toContain("keeps no spend meter");
    expect(readme).not.toContain("## Tools on this worker");
    const tooled = emitCfWorkerCli({ ...baseIr, tools: ["webFetch"] }).files.find(
      (f) => f.path === "README.md",
    )?.content;
    expect(tooled).toContain("## Tools on this worker");
    const publicFiles = new Map(
      emitCfWorkerCli({ ...baseIr, cfWorker: { publicChat: true } }).files.map((f) => [
        f.path,
        f.content,
      ]),
    );
    expect(publicFiles.get("wrangler.toml")).toContain(
      "# cf_worker.public_chat: POST /chat answers without a token",
    );
    expect(publicFiles.get("wrangler.toml")).not.toContain("secret put CHAT_TOKEN");
    expect(publicFiles.get("README.md")).toContain("`POST /chat` answers without a token");
    expect(publicFiles.get("README.md")).not.toContain("secret put CHAT_TOKEN");
  });
});
