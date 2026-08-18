/**
 * #413 — the judge's pinned temperature is rejected outright by some
 * models (Anthropic Claude 5 family / Opus 4.7+: 400 "`temperature` is
 * deprecated for this model"; OpenAI reasoning models phrase it
 * "Unsupported parameter"). The adapters' model gates omit the pin for
 * the models they KNOW about; these tests cover the judge-side last line
 * of defense — `collectWithTemperatureRetry` retries exactly once with
 * the field omitted when a provider the gates don't know rejects it, in
 * all three judge paths (scalar, categorical, pairwise). All stubbed —
 * no network.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import {
  makeLabelStubClient,
  makeNaiveStubClient,
  makePairwiseStubClient,
} from "./__test__/stub-client";
import { isTemperatureRejectionError, judge, judgeCategorical } from "./judge";
import { judgePair } from "./pairwise";
import { loadCategoricalRubric } from "./rubric";
import type { Rubric } from "./rubric";

const RUBRIC: Rubric = {
  criteria: [{ name: "quality", anchors: { 1: "bad", 5: "good" } }],
  passing_score: 3,
} as unknown as Rubric;

const CATEGORICAL_RUBRIC = loadCategoricalRubric(`
kind: categorical
labels:
  - name: correct
    score: 1
    description: factually correct
  - name: wrong
    score: 0
    description: contains a factual error
passing_labels: [correct]
`);

const SAMPLE = { id: "s1", input: "what is 2+2?", expected_output: "4" };

/** The live wire shape of the failure, verbatim shape observed 2026-08-17. */
const ANTHROPIC_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error",' +
  '"message":"`temperature` is deprecated for this model. Please remove it from your request."}}';

/**
 * Wrap a stub adapter so any request CARRYING a temperature fails the
 * way a live provider does — thrown while the stream is being consumed,
 * not at stream construction — while pin-free requests reach the stub.
 * Every request (failed and retried) lands in `capture`.
 */
function rejectTemperature(
  inner: ProviderAdapter,
  capture: ProviderRequest[],
  message: string = ANTHROPIC_400,
): ProviderAdapter {
  return {
    ...inner,
    stream(req) {
      capture.push(req);
      if (req.temperature === undefined) return inner.stream(req);
      const fail = async function* (): AsyncGenerator<StreamEvent> {
        yield { kind: "message_start" };
        throw new Error(message);
      };
      return fail();
    },
  };
}

describe("isTemperatureRejectionError (#413)", () => {
  test("matches the Anthropic and OpenAI phrasings", () => {
    expect(isTemperatureRejectionError(new Error(ANTHROPIC_400))).toBe(true);
    expect(
      isTemperatureRejectionError(
        new Error("400 Unsupported parameter: 'temperature' is not supported with this model."),
      ),
    ).toBe(true);
  });

  test("does not match unrelated provider errors", () => {
    expect(isTemperatureRejectionError(new Error("529 overloaded_error"))).toBe(false);
    expect(isTemperatureRejectionError(new Error("400 max_tokens is too large"))).toBe(false);
    // "deprecated" alone isn't enough — it has to be ABOUT temperature.
    expect(isTemperatureRejectionError(new Error("model claude-2.1 is deprecated"))).toBe(false);
    expect(isTemperatureRejectionError("not even an Error")).toBe(false);
  });
});

describe("judge() retries once without the pin (#413)", () => {
  test("scalar: rejected pin → pin-free retry succeeds; both requests captured", async () => {
    const capture: ProviderRequest[] = [];
    const adapter = rejectTemperature(
      makeNaiveStubClient(() => ({
        score: 4 as const,
        rationale: "fine",
        criterion_scores: { quality: 4 },
      })),
      capture,
    );
    const usage: string[] = [];
    const result = await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "4",
      adapter,
      model: "some-future-model-the-gates-dont-know",
      onUsage: (u) => usage.push(u.model),
    });
    expect(result.score).toBe(4);
    expect(capture.length).toBe(2);
    expect(capture[0]?.temperature).toBe(0);
    expect(capture[1]?.temperature).toBeUndefined();
    expect("temperature" in (capture[1] as ProviderRequest)).toBe(false);
    // C35 — the sink fires once: only the call that produced the verdict.
    expect(usage).toEqual(["some-future-model-the-gates-dont-know"]);
  });

  test("scalar: an explicit rubric-level pin is retried the same way", async () => {
    const capture: ProviderRequest[] = [];
    const adapter = rejectTemperature(
      makeNaiveStubClient(() => ({
        score: 5 as const,
        rationale: "great",
        criterion_scores: { quality: 5 },
      })),
      capture,
    );
    const result = await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "4",
      adapter,
      temperature: 0.7,
    });
    expect(result.score).toBe(5);
    expect(capture[0]?.temperature).toBe(0.7);
    expect(capture[1]?.temperature).toBeUndefined();
  });

  test("a NON-temperature error is not retried — it rethrows after one call", async () => {
    const capture: ProviderRequest[] = [];
    const adapter = rejectTemperature(
      makeNaiveStubClient(() => ({
        score: 4 as const,
        rationale: "fine",
        criterion_scores: { quality: 4 },
      })),
      capture,
      "529 overloaded_error",
    );
    await expect(
      judge({ rubric: RUBRIC, sample: SAMPLE, agentOutput: "4", adapter }),
    ).rejects.toThrow("overloaded");
    expect(capture.length).toBe(1);
  });
});

describe("judgeCategorical() retries once without the pin (#413)", () => {
  test("categorical: rejected pin → pin-free retry succeeds", async () => {
    const capture: ProviderRequest[] = [];
    const adapter = rejectTemperature(
      makeLabelStubClient(() => ({ label: "correct", rationale: "matches" })),
      capture,
    );
    const result = await judgeCategorical({
      rubric: CATEGORICAL_RUBRIC,
      sample: SAMPLE,
      agentOutput: "4",
      adapter,
    });
    expect(result.label).toBe("correct");
    expect(capture.length).toBe(2);
    expect(capture[0]?.temperature).toBe(0);
    expect(capture[1]?.temperature).toBeUndefined();
  });
});

describe("judgePair() retries once without the pin (#413)", () => {
  test("pairwise: rejected pin → pin-free retry succeeds", async () => {
    const capture: ProviderRequest[] = [];
    const adapter = rejectTemperature(
      makePairwiseStubClient(() => ({ winner: "a", rationale: "A is sharper" })),
      capture,
    );
    const verdict = await judgePair({
      input: "q",
      outputA: "good",
      outputB: "bad",
      adapter,
    });
    expect(verdict.winner).toBe("a");
    expect(capture.length).toBe(2);
    expect(capture[0]?.temperature).toBe(0);
    expect(capture[1]?.temperature).toBeUndefined();
  });
});
