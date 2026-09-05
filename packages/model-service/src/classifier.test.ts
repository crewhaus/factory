/**
 * 0.6.0 PR 9b — `wireModels` constructs the `policy: classifier` label call
 * (plan §7.2.3): `routeClassifier` is present only when the (non-overridden)
 * pool declares `policy: classifier` AND a `classifier:` block; it runs
 * `@crewhaus/eval-judge`'s `classifyRouteLabel` on the classifier model,
 * publishing on the bus the loop hands in with `role: "classifier"`, and
 * returns the label plus its priced cost. Failures propagate (the loop's
 * `preRoute` turns them into the heuristic fallback).
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import type { IrModelPool } from "@crewhaus/ir";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { CLASSIFIER_WIRING_KEYS, MODEL_WIRING_KEYS, wireModels } from "./index";

const CLASSIFIED_POOL: IrModelPool = {
  candidates: [
    { model: "claude-haiku-4-5", tags: ["cheap"], profile: "fast" },
    { model: "claude-opus-4-1", tags: ["strong"], profile: "strong" },
  ],
  policy: "classifier",
  classifier: {
    model: "claude-haiku-4-5",
    labels: { cheap: "simple lookup", strong: "multi-step reasoning" },
    maxTokens: 16,
  },
};

function labelAdapter(label: string): ProviderAdapter & { requests: ProviderRequest[] } {
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
        yield { kind: "message_start", usage: { input: 30, output: 0 } };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu_1", name: "submit_route_label", input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ label }) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use", usage: { input: 30, output: 4 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

describe("wireModels — routeClassifier (§7.2.3)", () => {
  test("policy classifier + classifier block → the modelPool key then routeClassifier; nothing else changes", () => {
    const wired = wireModels({ modelPool: CLASSIFIED_POOL }, {});
    expect(Object.keys(wired)).toEqual(["modelPool", ...CLASSIFIER_WIRING_KEYS]);
    expect(wired.modelPool).toBe(CLASSIFIED_POOL);
    expect(typeof wired.routeClassifier).toBe("function");
  });

  test("no classifier block, another policy, or a --model override wires no classifier", () => {
    const { classifier: _c, ...noBlock } = CLASSIFIED_POOL;
    expect(Object.keys(wireModels({ modelPool: noBlock }, {}))).toEqual(["modelPool"]);
    expect(
      Object.keys(wireModels({ modelPool: { ...CLASSIFIED_POOL, policy: "heuristic" } }, {})),
    ).toEqual(["modelPool"]);
    expect(
      Object.keys(wireModels({ modelPool: CLASSIFIED_POOL }, { modelOverride: "claude-sonnet-5" })),
    ).toEqual([]);
    expect(MODEL_WIRING_KEYS).not.toContain("routeClassifier");
  });

  test("the classifier runs the label call on the run bus with role classifier and returns label + priced cost", async () => {
    const adapter = labelAdapter("strong");
    const wired = wireModels({ modelPool: CLASSIFIED_POOL }, { _classifierAdapter: adapter });
    const bus = new TraceEventBus({ runId: "run_x", sessionId: "sess_x" });
    const seen: TraceEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const verdict = await wired.routeClassifier?.({
      userText: "please refactor this stack trace handler",
      labels: ["cheap", "strong"],
      bus,
      signal: new AbortController().signal,
    });
    expect(verdict).toMatchObject({ label: "strong", model: "claude-haiku-4-5" });
    expect(typeof verdict?.costUsdMicros).toBe("number");
    const req = adapter.requests[0];
    expect(req?.maxTokens).toBe(16);
    expect(req?.toolChoice).toEqual({ type: "tool", name: "submit_route_label" });
    expect(seen.map((e) => e.kind)).toEqual(["model_request", "model_response"]);
    for (const e of seen) expect((e as { role?: string }).role).toBe("classifier");
  });

  test("an undeclared label propagates as a throw (the loop falls back to heuristic)", async () => {
    const wired = wireModels(
      { modelPool: CLASSIFIED_POOL },
      { _classifierAdapter: labelAdapter("turbo") },
    );
    await expect(
      wired.routeClassifier?.({
        userText: "hi",
        labels: ["cheap", "strong"],
        bus: new TraceEventBus({ runId: "run_y", sessionId: "sess_y" }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });
});
