/**
 * 0.6.0 PR 8b — `wireModels` constructs the model-directed pair (plan
 * §7.2.4, §7.5):
 *
 *   (a) `strategy.model_directed: true` yields `hybridTools` (`Consult`,
 *       `Escalate`) and the `escalation` latch, after the four routing keys;
 *       an absent strategy — or a `--model` override — yields neither;
 *   (b) the escalation target is `strategy.cascade.escalateTo` resolved
 *       against the roster, else the strongest candidate; `max_escalations`
 *       bounds the latch; withdrawn candidates are not on the roster;
 *   (c) the Consult runner is a NESTED `runChatLoop` on a child run context
 *       whose model events are re-published on the parent bus with
 *       `role: "consult"` under the parent's runId — so the parent's meter
 *       counts them — and the reply comes back classified + lineage-tagged
 *       through the tool.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import type { IrModelPool } from "@crewhaus/ir";
import { createRunContext } from "@crewhaus/run-context";
import type { ModelResponseEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import {
  CONSULT_INSTRUCTIONS,
  HYBRID_WIRING_KEYS,
  MODEL_WIRING_KEYS,
  buildConsultRunner,
  wireModels,
} from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-model-service-consult-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

const DIRECTED_POOL: IrModelPool = {
  candidates: [
    { model: "claude-haiku-4-5", tags: ["cheap"], profile: "fast" },
    { model: "claude-sonnet-4-6", tags: ["mid"], enabled: false },
    { model: "claude-opus-4-1", tags: ["strong"], profile: "strong" },
  ],
  policy: "heuristic",
  strategy: { modelDirected: true, maxEscalations: 2 },
};

/** A text-only scripted adapter that records every request it served. */
function textAdapter(reply: string): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "anthropic",
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
      return (async function* () {
        yield { kind: "message_start", usage: { input: 10, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 10, output: 5 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

describe("wireModels — the model-directed pair", () => {
  test("model_directed: true yields Consult + Escalate and the latch, after the routing keys", () => {
    const wired = wireModels({ modelPool: DIRECTED_POOL }, {});
    expect(Object.keys(wired)).toEqual(["modelPool", ...HYBRID_WIRING_KEYS]);
    expect(wired.hybridTools?.map((t) => t.name)).toEqual(["Consult", "Escalate"]);
    expect(wired.escalation).toBeDefined();
    expect(wired.escalation?.maxEscalations).toBe(2);
    // Default target: the strongest roster member (first strong-tagged).
    expect(wired.escalation?.target.modelString).toBe("claude-opus-4-1");
    expect(wired.escalation?.target.profile).toBe("strong");
  });

  test("a pool without the strategy key wires NOTHING extra (byte-identity), as does a --model override", () => {
    const plain = wireModels(
      { modelPool: { ...DIRECTED_POOL, strategy: { maxEscalations: 3 } } },
      {},
    );
    expect(Object.keys(plain)).toEqual(["modelPool"]);
    expect(wireModels({ modelPool: { ...DIRECTED_POOL, strategy: undefined } }, {})).toEqual({
      modelPool: { ...DIRECTED_POOL, strategy: undefined },
    });
    expect(wireModels({ modelPool: DIRECTED_POOL }, { modelOverride: "claude-opus-4-1" })).toEqual(
      {},
    );
    // The four routing keys still come first, in their pinned order.
    const full = wireModels(
      {
        modelFallbacks: ["openai/gpt-4o-mini"],
        circuitBreaker: { failureThreshold: 2 },
        modelTiers: { fast: "a", default: "b" },
        modelPool: DIRECTED_POOL,
      },
      {},
    );
    expect(Object.keys(full)).toEqual([...MODEL_WIRING_KEYS, ...HYBRID_WIRING_KEYS]);
  });

  test("the escalation target is cascade.escalateTo resolved against the roster (tag / profile / model)", () => {
    const byTag = wireModels(
      {
        modelPool: {
          ...DIRECTED_POOL,
          strategy: { modelDirected: true, cascade: { draft: "cheap", escalateTo: "mid" } },
        },
      },
      {},
    );
    // "mid" is withdrawn (enabled: false) → not on the roster → strongest.
    expect(byTag.escalation?.target.modelString).toBe("claude-opus-4-1");
    const byProfile = wireModels(
      {
        modelPool: {
          ...DIRECTED_POOL,
          strategy: { modelDirected: true, cascade: { draft: "cheap", escalateTo: "$fast" } },
        },
      },
      {},
    );
    expect(byProfile.escalation?.target.modelString).toBe("claude-haiku-4-5");
    expect(byProfile.escalation?.maxEscalations).toBe(1);
  });

  test("the Consult tool's roster excludes withdrawn candidates and refuses a non-roster `to`", async () => {
    const wired = wireModels(
      { modelPool: DIRECTED_POOL },
      { _consultRunner: async ({ target }) => ({ text: `from ${target.modelString}` }) },
    );
    const consult = wired.hybridTools?.find((t) => t.name === "Consult");
    expect(consult).toBeDefined();
    expect(consult?.description).toContain("$fast / claude-haiku-4-5");
    expect(consult?.description).not.toContain("claude-sonnet-4-6");
    expect(await consult?.execute({ question: "q" })).toBe("from claude-opus-4-1");
    expect(await consult?.execute({ question: "q", to: "fast" })).toBe("from claude-haiku-4-5");
    await expect(consult?.execute({ question: "q", to: "claude-sonnet-4-6" })).rejects.toThrow(
      /not a roster candidate/,
    );
  });
});

describe("buildConsultRunner — the nested single-turn side call", () => {
  test("runs the target through runChatLoop on a child context and re-publishes its model events on the parent bus", async () => {
    const opus = textAdapter("Consulted: the answer is 42.");
    const runner = buildConsultRunner({
      sessionName: "support",
      sessionRootDir: SESSION_ROOT,
      _consultAdapters: new Map([["claude-opus-4-1", opus]]),
    });
    const parent = createRunContext();
    parent.turnNumber = 4;
    parent.eventBus.setTurnNumber(4);
    const seen: TraceEvent[] = [];
    parent.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const reply = await runner({
      target: { modelString: "claude-opus-4-1", tags: ["strong"], profile: "strong" },
      question: "What is the answer?",
      context: "Deep Thought was asked.",
      runContext: parent,
    });
    expect(reply.text).toBe("Consulted: the answer is 42.");
    // The nested call went THROUGH runChatLoop: one request, tool-less, with
    // the consult system prompt and the question + context as the one turn.
    expect(opus.requests).toHaveLength(1);
    const req = opus.requests[0] as ProviderRequest;
    expect(req.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(req.system)).toContain(CONSULT_INSTRUCTIONS.slice(0, 40));
    const user = req.messages[req.messages.length - 1];
    expect(JSON.stringify(user?.content)).toContain("Deep Thought was asked.");
    expect(JSON.stringify(user?.content)).toContain("Question: What is the answer?");
    // The parent bus saw the child's model events, re-stamped under the
    // parent's runId / turn with role "consult" — what makes the parent's
    // cost-tracker price them and its budget meter count them.
    const requests = seen.filter((e) => e.kind === "model_request");
    const responses = seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
    expect(requests).toHaveLength(1);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.role).toBe("consult");
    expect(responses[0]?.runId).toBe(parent.runId);
    expect(responses[0]?.turnNumber).toBe(4);
    expect(responses[0]?.model).toBe("claude-opus-4-1");
    expect(responses[0]?.usage.output).toBe(5);
    // The parent's own turn counter is untouched (no phantom turns).
    expect(parent.turnNumber).toBe(4);
  });

  test("end to end through wireModels: the Consult reply is classified at origin consult and lineage-tagged", async () => {
    const opus = textAdapter("A clean consulted reply about shipping.");
    const wired = wireModels(
      { modelPool: DIRECTED_POOL },
      { sessionRootDir: SESSION_ROOT, _consultAdapters: new Map([["claude-opus-4-1", opus]]) },
    );
    const consult = wired.hybridTools?.find((t) => t.name === "Consult");
    const parent = createRunContext();
    const result = await consult?.execute({ question: "How do we ship?" }, { runContext: parent });
    expect(result).toBe("A clean consulted reply about shipping.");
    expect(parent.dataLineage?.get("A clean consulted reply about shipping.")).toBe("consult");
    // The child inherited the parent's trace, so OTel stitches both.
    expect(opus.requests).toHaveLength(1);
  });

  test("a runner without a parent context still runs (fresh child), and an unknown target without an adapter fails honestly", async () => {
    const opus = textAdapter("standalone");
    const runner = buildConsultRunner({
      sessionRootDir: SESSION_ROOT,
      _consultAdapters: new Map([["claude-opus-4-1", opus]]),
    });
    const reply = await runner({
      target: { modelString: "claude-opus-4-1", tags: [] },
      question: "q",
    });
    expect(reply.text).toBe("standalone");
  });
});
