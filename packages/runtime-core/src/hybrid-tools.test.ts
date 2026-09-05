/**
 * 0.6.0 PR 8b — the two runtime seams the model-directed tools ride:
 *
 *   - `hybridTools` are appended to the effective tool list (after the
 *     caller's tools and the plugin tools; first-party wins a name
 *     collision) and advertised to the model like every other tool;
 *   - the `escalation` latch is consumed exactly once, at the loop's next
 *     model call, snapshotting `messages.length` onto the request and arming
 *     the pool's escalation latch so the rest of the turn is served by the
 *     request's target (a roster candidate) — the `model_route` line names
 *     the receipt; without a pool the request is consumed and logged, never
 *     served.
 *
 * Driven over the real `runChatLoop` with scripted pool adapters (the
 * budget.test.ts pattern) and `@crewhaus/tool-consult`'s own latch shape
 * twin, kept local so this package's tests do not depend on the tool package.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { ModelRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { type HybridEscalationLatch, type HybridEscalationRequest, runChatLoop } from "./index";

const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-hybrid-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SHARED_SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
});

const CHEAP = "claude-haiku-4-5";
const STRONG = "claude-opus-4-1";

type Step = { readonly tool: string; readonly input?: unknown } | { readonly text: string };

/** Scripted adapter: each call plays the next step (a tool_use or a text reply). */
function scriptedAdapter(
  providerId: ProviderId,
  steps: ReadonlyArray<Step>,
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
  return {
    requests,
    providerId,
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      const step = steps[Math.min(call, steps.length - 1)] ?? { text: "done" };
      const id = `tu_${providerId}_${call}`;
      call += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: 10, output: 0 } };
        if ("tool" in step) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id, name: step.tool, input: {} },
          };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input ?? {}) },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "tool_use", usage: { input: 10, output: 5 } };
        } else {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: step.text },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 10, output: 5 } };
        }
        yield { kind: "message_stop" };
      })();
    },
  };
}

/** A local twin of tool-consult's latch, exercising runtime-core's structural seam. */
function makeLatch(target: { modelString: string; profile?: string }): HybridEscalationLatch & {
  history: HybridEscalationRequest[];
  arm(reason: string): void;
} {
  const history: HybridEscalationRequest[] = [];
  let pending: (HybridEscalationRequest & { transcriptLength?: number }) | undefined;
  return {
    history,
    arm(reason) {
      pending = { receipt: history.length + 1, reason, target, turnNumber: 1 };
      history.push(pending);
    },
    pending: () => pending,
    consume(snapshot) {
      const rec = pending;
      if (rec === undefined) return undefined;
      pending = undefined;
      rec.transcriptLength = snapshot.transcriptLength;
      return rec;
    },
  };
}

/** An `Escalate` twin: arms the latch when called, returns a receipt. */
function escalateTwin(latch: ReturnType<typeof makeLatch>) {
  return buildTool({
    name: "Escalate",
    description: "escalate twin",
    inputSchema: z.object({ reason: z.string() }),
    readOnly: true,
    execute: async (input) => {
      latch.arm(input.reason);
      return JSON.stringify({ escalated: true });
    },
  });
}

function tmpScoreboard() {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-hybrid-sb-"));
  return openScoreboard(dir, { now: () => 1_700_000_000_000 });
}

describe("hybridTools — appended to the effective tool list", () => {
  test("a hybrid tool is advertised alongside the caller's tools; first-party wins a name collision", async () => {
    const adapter = scriptedAdapter("anthropic", [{ text: "hi" }]);
    const ours = buildTool({
      name: "Escalate",
      description: "the caller's own Escalate",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => "mine",
    });
    const hybrid = buildTool({
      name: "Escalate",
      description: "the hybrid Escalate",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => "hybrid",
    });
    const consult = buildTool({
      name: "Consult",
      description: "the hybrid Consult",
      inputSchema: z.object({ question: z.string() }),
      readOnly: true,
      execute: async () => "consulted",
    });
    await runChatLoop({
      model: STRONG,
      instructions: "test",
      _adapter: adapter,
      tools: [ours],
      hybridTools: [hybrid, consult],
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
    });
    const advertised = adapter.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(advertised).toContain("Consult");
    expect(advertised.filter((n) => n === "Escalate")).toHaveLength(1);
    const escalate = adapter.requests[0]?.tools?.find((t) => t.name === "Escalate");
    expect(escalate?.description).toBe("the caller's own Escalate");
  });

  test("absent hybridTools leaves a zero-tool loop zero-tool (byte-identity)", async () => {
    const adapter = scriptedAdapter("anthropic", [{ text: "hi" }]);
    await runChatLoop({
      model: STRONG,
      instructions: "test",
      _adapter: adapter,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
    });
    expect(adapter.requests[0]?.tools ?? []).toHaveLength(0);
  });
});

describe("escalation latch — consumed once at the next model call", () => {
  test("a self-escalation on the cheap arm serves the rest of the turn on the target and names the receipt", async () => {
    // Static policy: the first declared (cheap) candidate serves. Its script
    // calls Escalate, so the NEXT model call in the same turn must go to the
    // strong candidate — the latch's target — and never back to cheap.
    const cheap = scriptedAdapter("anthropic", [
      { tool: "Escalate", input: { reason: "needs multi-step reasoning" } },
      { text: "cheap should not serve again" },
    ]);
    const strong = scriptedAdapter("anthropic", [{ text: "strong answer" }]);
    const latch = makeLatch({ modelString: STRONG, profile: "strong" });
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const result = await runChatLoop({
      model: CHEAP,
      instructions: "test",
      _adapter: cheap,
      modelPool: {
        candidates: [
          { model: CHEAP, tags: ["cheap"] },
          { model: STRONG, tags: ["strong"] },
        ],
        policy: "static",
      },
      _poolAdapters: new Map([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: tmpScoreboard(),
      hybridTools: [escalateTwin(latch)],
      escalation: latch,
      permissionMode: "auto",
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hard question" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      runContext,
    });
    expect(result).toBe("strong answer");
    expect(cheap.requests).toHaveLength(1);
    expect(strong.requests).toHaveLength(1);
    // The latch was consumed exactly once, with the transcript snapshot: the
    // seed user message, the assistant tool_use, and the tool_result.
    expect(latch.pending()).toBeUndefined();
    expect(latch.history).toHaveLength(1);
    expect((latch.history[0] as { transcriptLength?: number }).transcriptLength).toBe(3);
    const routes = seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes).toHaveLength(2);
    expect(routes[0]?.model).toBe(CHEAP);
    expect(routes[1]?.model).toBe(STRONG);
    expect(routes[1]?.reason).toContain("model's own Escalate request");
    expect(routes[1]?.reason).toContain("receipt 1");
    expect(routes[1]?.reason).toContain("needs multi-step reasoning");
  });

  test("a target outside the roster falls back to the router's strongest candidate", async () => {
    const cheap = scriptedAdapter("anthropic", [
      { tool: "Escalate", input: { reason: "r" } },
      { text: "cheap again" },
    ]);
    const strong = scriptedAdapter("anthropic", [{ text: "strong" }]);
    const latch = makeLatch({ modelString: "openai/gpt-4o" });
    const result = await runChatLoop({
      model: CHEAP,
      instructions: "test",
      _adapter: cheap,
      modelPool: {
        candidates: [
          { model: CHEAP, tags: ["cheap"] },
          { model: STRONG, tags: ["strong"] },
        ],
        policy: "static",
      },
      _poolAdapters: new Map([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: tmpScoreboard(),
      hybridTools: [escalateTwin(latch)],
      escalation: latch,
      permissionMode: "auto",
      singleTurn: true,
      seedMessages: [{ role: "user", content: "q" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
    });
    expect(result).toBe("strong");
    expect(strong.requests).toHaveLength(1);
  });

  test("without a pool the request is consumed and logged — never served, never crashing", async () => {
    const adapter = scriptedAdapter("anthropic", [
      { tool: "Escalate", input: { reason: "r" } },
      { text: "same model finishes" },
    ]);
    const latch = makeLatch({ modelString: STRONG });
    const result = await runChatLoop({
      model: CHEAP,
      instructions: "test",
      _adapter: adapter,
      hybridTools: [escalateTwin(latch)],
      escalation: latch,
      permissionMode: "auto",
      singleTurn: true,
      seedMessages: [{ role: "user", content: "q" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
    });
    expect(result).toBe("same model finishes");
    expect(adapter.requests).toHaveLength(2);
    expect(latch.pending()).toBeUndefined();
  });
});
