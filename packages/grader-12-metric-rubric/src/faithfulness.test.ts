import { describe, expect, test } from "bun:test";
import type { Sample } from "@crewhaus/eval-dataset";
import type { Grader, RunResult } from "@crewhaus/eval-grader";
import { GraderRegistry } from "@crewhaus/grader-registry";
import {
  GROUNDING_COVERAGE,
  MIN_CLAIM_TOKENS,
  TWELVE_METRIC_SPECS,
  TWELVE_METRIC_THRESHOLDS,
  answerFaithfulness,
  answerRelevance,
  claimSentences,
  hallucinationRate,
  register12MetricRubric,
  summarize12MetricRubric,
} from "./index";

type TranscriptEvent = RunResult["transcript"][number];

function ev(kind: TranscriptEvent["kind"], payload: unknown, ts = 1): TranscriptEvent {
  return { ts, version: 1, kind, payload };
}

function makeRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    agentOutput: "",
    events: [],
    transcript: [],
    toolCalls: [],
    turns: 1,
    latencyMs: 100,
    ...overrides,
  };
}

const sample: Sample = { id: "s1", input: "What is the current temperature in Berlin?" };

/** Grounded fixture: the answer's single claim is fully covered by the
 *  tool_result evidence (and partially by the user question). */
function groundedRun(): RunResult {
  return makeRun({
    agentOutput: "The current temperature in Berlin is 18 celsius.",
    transcript: [
      ev("user_message", { content: "What is the current temperature in Berlin?" }),
      ev("tool_result", {
        toolUseId: "tu_1",
        content: "Weather report Berlin: current temperature 18 celsius, humidity 60 percent",
        isError: false,
      }),
      ev("assistant_message", { content: "The current temperature in Berlin is 18 celsius." }),
    ],
  });
}

/** Same evidence, but the answer adds a fabricated second claim. */
function fabricatedRun(): RunResult {
  const base = groundedRun();
  return makeRun({
    transcript: base.transcript,
    agentOutput:
      "The current temperature in Berlin is 18 celsius. Tomorrow brings heavy snowfall across Bavaria per the forecast.",
  });
}

describe("claimSentences", () => {
  test("extracts declarative sentences with enough content tokens", () => {
    const claims = claimSentences(
      "The deploy pipeline uses three staging environments. Should we add another? Done.",
    );
    expect(claims).toEqual(["The deploy pipeline uses three staging environments."]);
  });

  test("excludes questions and content-free sentences", () => {
    expect(claimSentences("Is the database migration finished? OK. Sure!")).toEqual([]);
  });

  test("MIN_CLAIM_TOKENS is the floor", () => {
    // "server restarted cleanly" = exactly 3 content tokens.
    expect(MIN_CLAIM_TOKENS).toBe(3);
    expect(claimSentences("Server restarted cleanly.")).toEqual(["Server restarted cleanly."]);
  });
});

describe("twelve.answerFaithfulness", () => {
  test("claim grounded via tool_result passes at ≥0.95", async () => {
    const r = await answerFaithfulness(sample, groundedRun());
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.rationale).toMatch(/1\/1 claim\(s\) grounded/);
  });

  test("fabricated claim drops the grounded fraction below threshold", async () => {
    const r = await answerFaithfulness(sample, fabricatedRun());
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.passed).toBe(false);
    expect(r.rationale).toMatch(/snowfall/); // the ungrounded claim is named
  });

  test("claims with zero evidence are unverifiable and fail", async () => {
    const r = await answerFaithfulness(
      sample,
      makeRun({ agentOutput: "The Berlin office headcount doubled last quarter.", transcript: [] }),
    );
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  test("vacuous case: zero evidence AND zero claims passes with rationale", async () => {
    const r = await answerFaithfulness(sample, makeRun({ agentOutput: "OK.", transcript: [] }));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.rationale).toMatch(/vacuous pass/);
  });

  test("no claims but evidence present is vacuously faithful", async () => {
    const run = makeRun({ agentOutput: "Sure!", transcript: groundedRun().transcript });
    const r = await answerFaithfulness(sample, run);
    expect(r.passed).toBe(true);
    expect(r.rationale).toMatch(/no verifiable claims/);
  });

  test("synthetic user messages never ground a claim", async () => {
    const r = await answerFaithfulness(
      sample,
      makeRun({
        agentOutput: "The quarterly revenue target increased significantly.",
        transcript: [
          ev("user_message", {
            content: "quarterly revenue target increased significantly",
            synthetic: true,
          }),
        ],
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });
});

describe("twelve.hallucinationRate", () => {
  test("fully grounded run scores rate 0 and passes", async () => {
    const r = await hallucinationRate(sample, groundedRun());
    expect(r.score).toBe(0);
    expect(r.passed).toBe(true);
  });

  test("fabricated claim drives the rate over the 0.02 upper bound and fails", async () => {
    const r = await hallucinationRate(sample, fabricatedRun());
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.score).toBeGreaterThan(TWELVE_METRIC_THRESHOLDS.hallucinationRate);
    expect(r.passed).toBe(false);
    expect(r.rationale).toMatch(/ungrounded/);
  });

  test("vacuous case passes with rate 0 and rationale", async () => {
    const r = await hallucinationRate(sample, makeRun({ agentOutput: "OK.", transcript: [] }));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(0);
    expect(r.rationale).toMatch(/vacuous pass/);
  });
});

describe("twelve.answerRelevance", () => {
  test("answer covering the question's content tokens passes at ≥0.9", async () => {
    const r = await answerRelevance(sample, groundedRun());
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  test("irrelevant answer fails", async () => {
    const r = await answerRelevance(
      sample,
      makeRun({ agentOutput: "Cats enjoy cardboard boxes enormously." }),
    );
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  test("empty sample input degrades to the transcript's first user message", async () => {
    const emptyInput: Sample = { id: "s2", input: "" };
    const r = await answerRelevance(emptyInput, groundedRun());
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  test("content-free question is a vacuous pass", async () => {
    const s: Sample = { id: "s3", input: "Hi?" };
    const r = await answerRelevance(s, makeRun({ agentOutput: "Hello." }));
    expect(r.passed).toBe(true);
    expect(r.rationale).toMatch(/vacuous/);
  });
});

describe("direction semantics", () => {
  test("spec directions: faithfulness/relevance higher-is-better, hallucination lower", () => {
    const byName = new Map(TWELVE_METRIC_SPECS.map((s) => [s.name, s]));
    expect(byName.get("twelve.answerFaithfulness")).toMatchObject({
      threshold: 0.95,
      higherIsBetter: true,
    });
    expect(byName.get("twelve.answerRelevance")).toMatchObject({
      threshold: 0.9,
      higherIsBetter: true,
    });
    expect(byName.get("twelve.hallucinationRate")).toMatchObject({
      threshold: 0.02,
      higherIsBetter: false,
    });
  });

  test("hallucinationRate score 0 passes (lower is better)", async () => {
    const r = await hallucinationRate(sample, groundedRun());
    expect(r.score).toBe(0);
    expect(r.passed).toBe(true);
  });

  test("summarize respects the lower-is-better direction in breach detection", () => {
    const clean = summarize12MetricRubric({
      "twelve.hallucinationRate": [{ passed: true, score: 0, rationale: "" }],
    });
    const cleanMetric = clean.metrics.find((m) => m.name === "twelve.hallucinationRate");
    expect(cleanMetric?.thresholdBreach).toBe(false);

    const dirty = summarize12MetricRubric({
      "twelve.hallucinationRate": [{ passed: false, score: 0.5, rationale: "" }],
    });
    const dirtyMetric = dirty.metrics.find((m) => m.name === "twelve.hallucinationRate");
    expect(dirtyMetric?.thresholdBreach).toBe(true);
  });
});

describe("registration", () => {
  test("register12MetricRubric installs the real graders, not always-fail stubs", async () => {
    const reg = new GraderRegistry();
    register12MetricRubric(reg);
    const faithfulness = reg.lookup("twelve.answerFaithfulness");
    const rate = reg.lookup("twelve.hallucinationRate");
    const relevance = reg.lookup("twelve.answerRelevance");
    expect((await faithfulness(sample, groundedRun())).passed).toBe(true);
    expect((await rate(sample, groundedRun())).passed).toBe(true);
    expect((await relevance(sample, groundedRun())).passed).toBe(true);
  });

  test("pre-registered grader under a reserved name is not clobbered", async () => {
    const custom: Grader = async () => ({ passed: false, score: 0.123, rationale: "custom" });
    const reg = new GraderRegistry();
    reg.register("twelve.answerFaithfulness", custom);
    register12MetricRubric(reg);
    const r = await reg.lookup("twelve.answerFaithfulness")(sample, groundedRun());
    expect(r.rationale).toBe("custom");
  });

  test("plugin override still wins via upsert after registration", async () => {
    const custom: Grader = async () => ({ passed: true, score: 1, rationale: "plugin" });
    const reg = new GraderRegistry();
    register12MetricRubric(reg);
    // discoverPluginGraders registers plugins LAST via upsert — same path.
    reg.upsert("twelve.hallucinationRate", custom);
    const r = await reg.lookup("twelve.hallucinationRate")(sample, fabricatedRun());
    expect(r.rationale).toBe("plugin");
  });
});

describe("GROUNDING_COVERAGE boundary", () => {
  test("a claim at exactly 0.6 coverage is grounded", async () => {
    expect(GROUNDING_COVERAGE).toBe(0.6);
    // Claim tokens: gateway, latency, doubled, overnight, monday (5);
    // evidence covers gateway, latency, doubled (3/5 = 0.6).
    const run = makeRun({
      agentOutput: "Gateway latency doubled overnight monday.",
      transcript: [
        ev("tool_result", {
          toolUseId: "tu_1",
          content: "gateway latency doubled",
          isError: false,
        }),
      ],
    });
    const r = await answerFaithfulness(sample, run);
    expect(r.score).toBe(1);
  });
});
