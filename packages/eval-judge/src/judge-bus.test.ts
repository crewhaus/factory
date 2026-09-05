/**
 * 0.6.0 (design §6.2) — judge spend on the run bus. Every judge call
 * (scalar, categorical, pairwise, and every call `createJudgeGrader` makes)
 * accepts a `bus` and publishes `model_request` / `model_response` with
 * `role: "judge"` on it, so `cost-tracker` prices the spend and a budget
 * meter subscribed to the same bus counts it. Every verdict also reports
 * the call's priced `usage` (wire model, provider, tokens, cost) so the
 * caller can stamp `eval_graded` / `judge_verdict` attribution without a
 * second pricing pass.
 *
 * Driven over a stub ProviderAdapter and a real `TraceEventBus` +
 * `createCostTracker` — no network, no `mock.module`.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderId, StreamEvent } from "@crewhaus/adapter-anthropic";
import { createCostTracker } from "@crewhaus/cost-tracker";
import {
  type ModelRequestEvent,
  type ModelResponseEvent,
  type TraceEvent,
  TraceEventBus,
} from "@crewhaus/trace-event-bus";
import { makePairwiseStubClient } from "./__test__/stub-client";
import { createJudgeGrader, judge, judgeCategorical } from "./judge";
import { judgePairwise } from "./pairwise";
import { loadCategoricalRubric, loadRubric } from "./rubric";

function stubAdapter(opts: {
  providerId?: ProviderId;
  usage: { input: number; output: number; cacheRead?: number };
  verdict?: Record<string, unknown>;
}): ProviderAdapter {
  return {
    providerId: opts.providerId ?? "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req) {
      const tool = req.tools?.[0]?.name ?? "submit_score";
      const verdict = opts.verdict ?? {
        score: 4,
        rationale: "fine",
        criterion_scores: { quality: 4 },
      };
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start", usage: { input: opts.usage.input, output: 0 } };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu", name: tool, input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(verdict) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield {
          kind: "message_delta",
          stopReason: "tool_use",
          usage: {
            input: opts.usage.input,
            output: opts.usage.output,
            ...(opts.usage.cacheRead !== undefined ? { cacheRead: opts.usage.cacheRead } : {}),
          },
        };
        yield { kind: "message_stop" };
      })();
    },
  };
}

const RUBRIC = loadRubric({
  criteria: [
    {
      name: "quality",
      description: "is it good",
      anchors: { "1": "no", "2": "meh", "3": "ok", "4": "good", "5": "great" },
    },
  ],
  passing_score: 3,
});

const SAMPLE = { id: "s1", input: "question" };
const RUN = {
  agentOutput: "answer",
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 5,
};

function makeBus(): { bus: TraceEventBus; events: TraceEvent[] } {
  const bus = new TraceEventBus({ runId: "run_judge", sessionId: "sess_judge" });
  const events: TraceEvent[] = [];
  bus.subscribe((e) => {
    events.push(e);
  });
  return { bus, events };
}

const requests = (events: TraceEvent[]): ModelRequestEvent[] =>
  events.filter((e): e is ModelRequestEvent => e.kind === "model_request");
const responses = (events: TraceEvent[]): ModelResponseEvent[] =>
  events.filter((e): e is ModelResponseEvent => e.kind === "model_response");

describe("judge() on the run bus (0.6.0 §6.2)", () => {
  test("publishes model_request + model_response with role judge, the wire model, provider and usage", async () => {
    const { bus, events } = makeBus();
    const result = await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "answer",
      adapter: stubAdapter({ usage: { input: 1000, output: 500, cacheRead: 100 } }),
      model: "claude-opus-4",
      bus,
    });
    const req = requests(events);
    const res = responses(events);
    expect(req).toHaveLength(1);
    expect(res).toHaveLength(1);
    expect(req[0]?.role).toBe("judge");
    expect(req[0]?.model).toBe("claude-opus-4");
    expect(req[0]?.provider).toBe("anthropic");
    expect(req[0]?.toolCount).toBe(1);
    expect(req[0]?.streaming).toBe(false);
    expect(res[0]?.role).toBe("judge");
    expect(res[0]?.model).toBe("claude-opus-4");
    expect(res[0]?.provider).toBe("anthropic");
    expect(res[0]?.usage).toEqual({ input: 1000, output: 500, cacheRead: 100 });
    // Request and response share one span (the runtime-core convention).
    expect(res[0]?.spanId).toBe(req[0]?.spanId as string);
    // No specModel when the caller's string IS the wire id.
    expect("specModel" in (res[0] ?? {})).toBe(false);
    // The verdict reports the priced usage: 1000×15 + 500×75 (+100 cached at 1.5) micros.
    expect(result.usage.model).toBe("claude-opus-4");
    expect(result.usage.specModel).toBe("claude-opus-4");
    expect(result.usage.provider).toBe("anthropic");
    expect(result.usage.input).toBe(1000);
    expect(result.usage.output).toBe(500);
    expect(result.usage.cacheRead).toBe(100);
    expect(result.usage.costUsdMicros).toBeGreaterThan(0);
    expect(result.usage.costUsdMicros).toBe(15_000 + 37_500 + 150);
  });

  test("a cost-tracker on the same bus prices the judge call — the spend is no longer invisible", async () => {
    const { bus, events } = makeBus();
    const tracker = createCostTracker(bus);
    await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "answer",
      adapter: stubAdapter({ usage: { input: 1000, output: 500 } }),
      model: "claude-opus-4",
      bus,
    });
    const summary = tracker.getRunCost(bus.runId);
    expect(summary.totalUsdMicros).toBe(15_000 + 37_500);
    expect(summary.byRole.judge).toBe(15_000 + 37_500);
    expect(summary.byRole.primary).toBeUndefined();
    // The accrual cost-tracker published carries the role verbatim.
    const accrual = events.find((e) => e.kind === "cost_accrual");
    expect(accrual !== undefined && "role" in accrual && accrual.role === "judge").toBe(true);
    tracker.unsubscribe();
  });

  test("an unpriced judge model reports no costUsdMicros (unknown, never free) but still publishes", async () => {
    const { bus, events } = makeBus();
    const result = await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "answer",
      adapter: stubAdapter({ usage: { input: 10, output: 2 } }),
      model: "no-such-model-for-pricing",
      bus,
    });
    expect(result.usage.costUsdMicros).toBeUndefined();
    expect(responses(events)).toHaveLength(1);
  });

  test("role and stage override the default attribution", async () => {
    const { bus, events } = makeBus();
    await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "answer",
      adapter: stubAdapter({ usage: { input: 10, output: 2 } }),
      model: "claude-opus-4",
      bus,
      role: "committee",
      stage: "member",
    });
    expect(responses(events)[0]?.role).toBe("committee");
    expect(responses(events)[0]?.stage).toBe("member");
    expect(requests(events)[0]?.stage).toBe("member");
  });

  test("no bus = no publish (the pre-0.6.0 path is byte-identical), usage still reported", async () => {
    const result = await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "answer",
      adapter: stubAdapter({ usage: { input: 10, output: 2 } }),
      model: "claude-opus-4",
    });
    expect(result.score).toBe(4);
    expect(result.usage.input).toBe(10);
  });

  test("the response is published BEFORE shape validation — a malformed verdict still meters", async () => {
    const { bus, events } = makeBus();
    await expect(
      judge({
        rubric: RUBRIC,
        sample: SAMPLE,
        agentOutput: "answer",
        adapter: stubAdapter({
          usage: { input: 10, output: 2 },
          verdict: { score: 9, rationale: "bad shape", criterion_scores: {} },
        }),
        model: "claude-opus-4",
        bus,
      }),
    ).rejects.toThrow(/invalid shape/);
    expect(responses(events)).toHaveLength(1);
    expect(responses(events)[0]?.usage).toEqual({ input: 10, output: 2 });
  });

  test("specModel rides along when the caller's string differs from the wire id", async () => {
    const { bus, events } = makeBus();
    // An injected adapter keeps the model as-is as the wire id, so exercise
    // the differing case through the router grammar with the stub adapter
    // still injected: the spec string is what the caller named.
    const result = await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "answer",
      adapter: stubAdapter({ providerId: "openai", usage: { input: 10, output: 2 } }),
      model: "gpt-4o-mini",
      bus,
    });
    // Injected adapter ⇒ wire id === spec string ⇒ no specModel; provider is the adapter's.
    expect(responses(events)[0]?.provider).toBe("openai");
    expect(result.usage.provider).toBe("openai");
    expect("specModel" in (responses(events)[0] ?? {})).toBe(false);
  });
});

describe("judgeCategorical() / pairwise / createJudgeGrader on the run bus", () => {
  test("judgeCategorical publishes with role judge and reports usage", async () => {
    const { bus, events } = makeBus();
    const rubric = loadCategoricalRubric({
      kind: "categorical",
      labels: [
        { name: "good", score: 1, description: "meets the bar" },
        { name: "bad", score: 0, description: "misses the bar" },
      ],
      passing_labels: ["good"],
    });
    const result = await judgeCategorical({
      rubric,
      sample: SAMPLE,
      agentOutput: "answer",
      adapter: stubAdapter({
        usage: { input: 20, output: 3 },
        verdict: { label: "good", rationale: "ok" },
      }),
      model: "claude-opus-4",
      bus,
    });
    expect(result.label).toBe("good");
    expect(result.usage.input).toBe(20);
    expect(result.usage.costUsdMicros).toBe(20 * 15 + 3 * 75);
    expect(responses(events)).toHaveLength(1);
    expect(responses(events)[0]?.role).toBe("judge");
  });

  test("judgePairwise publishes BOTH order calls with role judge", async () => {
    const { bus, events } = makeBus();
    await judgePairwise({
      input: "q",
      prevOutput: "a",
      newOutput: "b",
      adapter: makePairwiseStubClient(() => ({ winner: "tie", rationale: "same" })),
      model: "claude-opus-4",
      bus,
    });
    expect(responses(events)).toHaveLength(2);
    expect(responses(events).every((r) => r.role === "judge")).toBe(true);
  });

  test("createJudgeGrader threads the bus into every panelist call", async () => {
    const { bus, events } = makeBus();
    const grader = createJudgeGrader(RUBRIC, {
      adapter: stubAdapter({ usage: { input: 2, output: 1 } }),
      judges: ["judge-a", "judge-b", "judge-c"],
      bus,
    });
    await grader(SAMPLE, RUN);
    expect(
      responses(events)
        .map((r) => r.model)
        .sort(),
    ).toEqual(["judge-a", "judge-b", "judge-c"]);
    expect(responses(events).every((r) => r.role === "judge")).toBe(true);
  });

  test("createJudgeGrader without a bus publishes nothing (byte-identical default)", async () => {
    const grader = createJudgeGrader(RUBRIC, {
      adapter: stubAdapter({ usage: { input: 2, output: 1 } }),
    });
    const grade = await grader(SAMPLE, RUN);
    expect(grade.passed).toBe(true);
  });
});
