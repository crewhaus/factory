/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — runtime-helper tests:
 * `createBridgeInvoker` over stub entry modules and the `guardHistorySamples`
 * load-time history gate.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeInvokeRequest,
  type BridgeSample,
  type EvalBridge,
  EvalBridgeRuntimeError,
  createBridgeInvoker,
  guardHistorySamples,
} from "./runtime";

const req = (sample: BridgeSample, sessionRootDir: string): BridgeInvokeRequest => ({
  sample,
  runContext: { sessionId: "sess_0123456789abcdef" },
  sessionRootDir,
});

const workflowBridge: EvalBridge = {
  sourceTarget: "workflow",
  kind: "workflow-run",
  chatCapable: false,
  entryImport: "../agent.ts",
};

describe("createBridgeInvoker — runForEval kinds", () => {
  test("wraps the entry's runForEval, threading runContext/sessionRootDir/sessionId", async () => {
    const calls: Array<{ input: string; opts: Record<string, unknown> }> = [];
    const entry = {
      runForEval: async (input: string, opts: Record<string, unknown> = {}) => {
        calls.push({ input, opts });
        return `out:${input}`;
      },
    };
    const invoker = createBridgeInvoker(workflowBridge, entry);
    const result = await invoker(req({ id: "s1", input: "hello" }, "/tmp/x"));
    expect(result.agentOutput).toBe("out:hello");
    expect(calls).toHaveLength(1);
    const opts = calls[0]?.opts ?? {};
    expect(opts["sessionRootDir"]).toBe("/tmp/x");
    expect(opts["sessionId"]).toBe("sess_0123456789abcdef");
    expect((opts["runContext"] as { sessionId: string }).sessionId).toBe("sess_0123456789abcdef");
    // Non-chat shape: no history is forwarded even if a sample carried one
    // (the load-time guard would have rejected it first).
    expect("history" in opts).toBe(false);
  });

  test("chat-capable kinds forward sample history to the entry", async () => {
    let seen: Record<string, unknown> = {};
    const entry = {
      runForEval: async (_input: string, opts: Record<string, unknown> = {}) => {
        seen = opts;
        return "reply";
      },
    };
    const bridge: EvalBridge = {
      sourceTarget: "channel",
      kind: "channel-resume-turn",
      chatCapable: true,
      entryImport: "../eval-entry.ts",
    };
    const invoker = createBridgeInvoker(bridge, entry);
    const history = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello!" },
    ];
    await invoker(req({ id: "s2", input: "follow-up", history }, "/tmp/y"));
    expect(seen["history"]).toEqual(history);
  });

  test("the _adapter test seam threads through to the entry", async () => {
    let seen: Record<string, unknown> = {};
    const entry = {
      runForEval: async (_i: string, opts: Record<string, unknown> = {}) => {
        seen = opts;
        return "ok";
      },
    };
    const adapter = { providerId: "scripted" };
    const invoker = createBridgeInvoker(workflowBridge, entry, { _adapter: adapter });
    await invoker(req({ id: "s3", input: "x" }, "/tmp/z"));
    expect(seen["_adapter"]).toBe(adapter);
  });

  test("a missing entry export fails loudly with the recompile hint", () => {
    expect(() => createBridgeInvoker(workflowBridge, {})).toThrow(EvalBridgeRuntimeError);
    expect(() => createBridgeInvoker(workflowBridge, {})).toThrow(/runForEval\(\)/);
    expect(() => createBridgeInvoker(workflowBridge, {})).toThrow(/--with-eval-harness/);
  });

  test("non-entry kinds refuse createBridgeInvoker (default invoker owns them)", () => {
    const bridge: EvalBridge = { sourceTarget: "voice", kind: "voice-replay", chatCapable: true };
    expect(() => createBridgeInvoker(bridge, {})).toThrow(/default single-turn invoker/);
  });
});

describe("createBridgeInvoker — gateway-request (managed)", () => {
  test("drives runOneTurn with a per-sample tenant + extraOptions seams", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bridge-managed-"));
    try {
      const calls: Array<Record<string, unknown>> = [];
      const entry = {
        runOneTurn: async (args: Record<string, unknown>) => {
          calls.push(args);
          return "gateway reply";
        },
      };
      const bridge: EvalBridge = {
        sourceTarget: "managed",
        kind: "gateway-request",
        chatCapable: true,
        entryImport: "../agent.ts",
      };
      const invoker = createBridgeInvoker(bridge, entry, { _adapter: { providerId: "s" } });
      const history = [{ role: "user" as const, content: "earlier" }];
      const result = await invoker(req({ id: "m1", input: "now", history }, tmp));
      expect(result.agentOutput).toBe("gateway reply");
      const args = calls[0] ?? {};
      expect(args["tenantId"]).toBe("eval");
      expect(args["sessionId"]).toBe("sess_0123456789abcdef");
      expect(args["input"]).toBe("now");
      // Per-sample tenant rooted INSIDE the sample dir (memory isolation).
      const tenant = args["tenant"] as { id: string; sessionRoot: string };
      expect(tenant.id).toBe("eval");
      expect(tenant.sessionRoot.startsWith(tmp)).toBe(true);
      const extra = args["extraOptions"] as Record<string, unknown>;
      expect(extra["sessionRootDir"]).toBe(tmp);
      // History + the graded input override the dispatcher's single-seed.
      expect(extra["seedMessages"]).toEqual([
        { role: "user", content: "earlier" },
        { role: "user", content: "now" },
      ]);
      expect(extra["_adapter"]).toEqual({ providerId: "s" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("guardHistorySamples — the load-time history gate", () => {
  async function* samples(list: readonly BridgeSample[]): AsyncIterable<BridgeSample> {
    for (const s of list) yield s;
  }
  const collect = async (iter: AsyncIterable<BridgeSample>) => {
    const out: BridgeSample[] = [];
    for await (const s of iter) out.push(s);
    return out;
  };

  test("passes history-less samples through untouched for any shape", async () => {
    const list = [
      { id: "a", input: "1" },
      { id: "b", input: "2" },
    ];
    const out = await collect(
      guardHistorySamples(samples(list), { sourceTarget: "workflow", chatCapable: false }),
    );
    expect(out).toEqual(list);
  });

  test("rejects a history-carrying sample against an entry-driven non-chat shape, loudly", async () => {
    const list: BridgeSample[] = [
      { id: "ok", input: "1" },
      { id: "multi", input: "2", history: [{ role: "user", content: "hi" }] },
    ];
    const bridge = {
      sourceTarget: "graph",
      chatCapable: false,
      entryImport: "../agent.ts",
    } as const;
    await expect(collect(guardHistorySamples(samples(list), bridge))).rejects.toThrow(
      EvalBridgeRuntimeError,
    );
    await expect(collect(guardHistorySamples(samples(list), bridge))).rejects.toThrow(
      /sample "multi" carries a multi-turn history.*target: graph.*compiled runtime entry \(\.\.\/agent\.ts\)/,
    );
  });

  test("an ENTRY-LESS bridge keeps its history samples (the default invoker seeds them)", async () => {
    // research / browser / onchain / onchain-game / batch / voice bridge to the
    // eval-runner's DEFAULT single-turn invoker, which is itself a chat loop
    // and seeds `history` natively (Wave-3 B14). Rejecting here would revoke a
    // shipped capability for no runtime reason.
    const list: BridgeSample[] = [
      { id: "multi", input: "2", history: [{ role: "user", content: "hi" }] },
    ];
    for (const sourceTarget of ["research", "browser", "onchain", "batch"]) {
      const out = await collect(
        guardHistorySamples(samples(list), { sourceTarget, chatCapable: false }),
      );
      expect(out).toEqual(list);
    }
  });

  test("chat-capable shapes keep their history samples", async () => {
    const list: BridgeSample[] = [
      { id: "multi", input: "2", history: [{ role: "user", content: "hi" }] },
    ];
    const out = await collect(
      guardHistorySamples(samples(list), { sourceTarget: "pipeline", chatCapable: true }),
    );
    expect(out).toEqual(list);
  });
});
