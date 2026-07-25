/**
 * A2 — multi-model judge panels (`createJudgeGrader({ judges: [...] })`).
 *
 * The stub adapter is model-aware (the scorer receives `req.model`), so one
 * adapter can hand every panelist a different verdict — exactly how the
 * real path works, since `judge()` threads each panelist's model string
 * into its ProviderRequest.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { makeNaiveStubClient } from "./__test__/stub-client";
import {
  JudgeError,
  PANEL_NEEDS_REVIEW_ENTROPY,
  createJudgeGrader,
  loadRubric,
  normalizedVoteEntropy,
} from "./index";

const RUBRIC_YAML = `
criteria:
  - name: correctness
    description: The answer matches what was expected.
    anchors:
      "1": wrong
      "2": partial
      "3": ok
      "4": correct
      "5": correct and concise
passing_score: 4
`;

const RUN = {
  agentOutput: "c",
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 100,
};

const SAMPLE = { id: "s1", input: "a", expected_output: "b" };

type StubVerdict = {
  score: 1 | 2 | 3 | 4 | 5;
  rationale: string;
  criterion_scores: Record<string, number>;
  abstain?: boolean;
  confidence?: number;
};

/** Model-keyed stub: each panelist model gets its own fixed verdict. */
function makePanelStub(verdicts: Record<string, StubVerdict>): ProviderAdapter {
  return makeNaiveStubClient((_user, _system, model) => {
    const v = verdicts[model];
    if (v === undefined) throw new Error(`stub has no verdict for model ${model}`);
    return v;
  });
}

/** Wrap an adapter to record every ProviderRequest (order preserved). */
function withCapture(adapter: ProviderAdapter): {
  adapter: ProviderAdapter;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  const baseStream = adapter.stream.bind(adapter);
  return {
    requests,
    adapter: {
      ...adapter,
      stream: (req: ProviderRequest) => {
        requests.push(req);
        return baseStream(req);
      },
    },
  };
}

describe("normalizedVoteEntropy (A2)", () => {
  test("unanimous votes read 0; an even split reads 1", () => {
    expect(normalizedVoteEntropy(3, 3)).toBe(0);
    expect(normalizedVoteEntropy(0, 5)).toBe(0);
    expect(normalizedVoteEntropy(1, 2)).toBeCloseTo(1);
    expect(normalizedVoteEntropy(0, 0)).toBe(0);
  });

  test("2–1 and 3–2 splits exceed the review cut; 4–1 does not", () => {
    expect(normalizedVoteEntropy(2, 3)).toBeGreaterThan(PANEL_NEEDS_REVIEW_ENTROPY);
    expect(normalizedVoteEntropy(3, 5)).toBeGreaterThan(PANEL_NEEDS_REVIEW_ENTROPY);
    expect(normalizedVoteEntropy(4, 5)).toBeLessThan(PANEL_NEEDS_REVIEW_ENTROPY);
  });
});

describe("createJudgeGrader — judges panel (A2)", () => {
  const verdict = (score: 1 | 2 | 3 | 4 | 5, extra: Partial<StubVerdict> = {}): StubVerdict => ({
    score,
    rationale: `scored ${score}`,
    criterion_scores: { correctness: score },
    ...extra,
  });

  test("median score, majority pass, per-panelist scores + entropy + needsReview", async () => {
    const rubric = loadRubric(RUBRIC_YAML); // passing_score 4
    const adapter = makePanelStub({ m1: verdict(3), m2: verdict(4), m3: verdict(5) });
    const grader = createJudgeGrader(rubric, { adapter, judges: ["m1", "m2", "m3"] });
    const result = await grader(SAMPLE, RUN);

    expect(result.passed).toBe(true); // votes 2/3 pass (m2, m3)
    expect(result.score).toBeCloseTo(0.75); // median 4 → (4-1)/4
    expect(result.panel?.panelists).toEqual([
      { model: "m1", score: 3, passed: false },
      { model: "m2", score: 4, passed: true },
      { model: "m3", score: 5, passed: true },
    ]);
    // 2–1 vote → normalized entropy ≈ 0.918 > 0.8 ⇒ flagged for review.
    expect(result.panel?.voteEntropy).toBeCloseTo(normalizedVoteEntropy(2, 3));
    expect(result.needsReview).toBe(true);
    expect(result.rationale).toContain("panel of 3");
    expect(result.rationale).toContain("m1=3, m2=4, m3=5");
    expect(result.rationale).toContain("votes 2/3 pass");
    // A12 — detail is the mean per criterion over the scored panelists.
    expect(result.detail).toEqual({ correctness: 4 });
    expect("abstained" in result).toBe(false);
  });

  test("a unanimous panel has entropy 0 and NO needsReview key", async () => {
    const rubric = loadRubric(RUBRIC_YAML);
    const adapter = makePanelStub({ m1: verdict(4), m2: verdict(4), m3: verdict(4) });
    const grader = createJudgeGrader(rubric, { adapter, judges: ["m1", "m2", "m3"] });
    const result = await grader(SAMPLE, RUN);
    expect(result.passed).toBe(true);
    expect(result.panel?.voteEntropy).toBe(0);
    expect("needsReview" in result).toBe(false);
  });

  test("a 4–1 split stays below the review cut", async () => {
    const rubric = loadRubric(RUBRIC_YAML);
    const adapter = makePanelStub({
      m1: verdict(4),
      m2: verdict(4),
      m3: verdict(4),
      m4: verdict(5),
      m5: verdict(2),
    });
    const grader = createJudgeGrader(rubric, {
      adapter,
      judges: ["m1", "m2", "m3", "m4", "m5"],
    });
    const result = await grader(SAMPLE, RUN);
    expect(result.passed).toBe(true); // 4/5 pass
    expect(result.panel?.voteEntropy).toBeCloseTo(normalizedVoteEntropy(4, 5));
    expect("needsReview" in result).toBe(false);
  });

  test("an even panel's tied vote conservatively fails and flags review", async () => {
    const rubric = loadRubric(RUBRIC_YAML); // passing_score 4
    const adapter = makePanelStub({ m1: verdict(4), m2: verdict(2) });
    const grader = createJudgeGrader(rubric, { adapter, judges: ["m1", "m2"] });
    const result = await grader(SAMPLE, RUN);
    expect(result.passed).toBe(false); // 1/2 is not a strict majority
    expect(result.score).toBeCloseTo(0.5); // median (2+4)/2 = 3 → (3-1)/4
    expect(result.panel?.voteEntropy).toBeCloseTo(1);
    expect(result.needsReview).toBe(true);
  });

  test("a strict majority of abstaining panelists makes the verdict abstained (no needsReview)", async () => {
    const rubric = loadRubric(RUBRIC_YAML);
    const adapter = makePanelStub({
      m1: verdict(3, { abstain: true, rationale: "no evidence" }),
      m2: verdict(3, { abstain: true }),
      m3: verdict(5),
    });
    const grader = createJudgeGrader(rubric, { adapter, judges: ["m1", "m2", "m3"] });
    const result = await grader(SAMPLE, RUN);
    expect(result.abstained).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.rationale).toContain("2/3 panelists abstained");
    expect(result.rationale).toContain("no evidence");
    // The per-panelist evidence still rides along for the human reviewer …
    expect(result.panel?.panelists).toEqual([
      { model: "m1", passed: false, abstained: true },
      { model: "m2", passed: false, abstained: true },
      { model: "m3", score: 5, passed: true },
    ]);
    // … but the sample routes to needs-human, never double-listed as review.
    expect("needsReview" in result).toBe(false);
    expect("detail" in result).toBe(false);
  });

  test("a minority abstain leaves the median and votes to the scored panelists", async () => {
    const rubric = loadRubric(RUBRIC_YAML); // passing_score 4
    const adapter = makePanelStub({
      m1: verdict(3, { abstain: true }),
      m2: verdict(4),
      m3: verdict(2),
    });
    const grader = createJudgeGrader(rubric, { adapter, judges: ["m1", "m2", "m3"] });
    const result = await grader(SAMPLE, RUN);
    expect("abstained" in result).toBe(false);
    expect(result.score).toBeCloseTo(0.5); // median of [2, 4] = 3
    expect(result.passed).toBe(false); // 1/2 pass — not a strict majority
    expect(result.panel?.voteEntropy).toBeCloseTo(1);
    expect(result.needsReview).toBe(true);
  });

  test("judges + repeats compose: repeats apply per panelist (k×m calls)", async () => {
    const rubric = loadRubric(RUBRIC_YAML); // passing_score 4
    const { adapter, requests } = withCapture(makePanelStub({ m1: verdict(4), m2: verdict(2) }));
    const grader = createJudgeGrader(rubric, { adapter, judges: ["m1", "m2"], repeats: 3 });
    const result = await grader(SAMPLE, RUN);

    expect(requests).toHaveLength(6); // 3 repeats × 2 panelists
    expect(requests.filter((r) => r.model === "m1")).toHaveLength(3);
    expect(requests.filter((r) => r.model === "m2")).toHaveLength(3);
    // Each panelist's own verdict is its repeats-median; the panel then votes.
    expect(result.panel?.panelists).toEqual([
      { model: "m1", score: 4, passed: true },
      { model: "m2", score: 2, passed: false },
    ]);
    expect(result.passed).toBe(false); // 1/2 tie fails conservatively
    expect(result.needsReview).toBe(true);
    // Per-panelist rationales carry the repeats fold (visible via representative).
    expect(result.rationale).toContain("median of 3 repeats");
  });

  test("panel calls stay temperature-pinned (0 by default, override threads)", async () => {
    const rubric = loadRubric(RUBRIC_YAML);
    const { adapter, requests } = withCapture(makePanelStub({ m1: verdict(4), m2: verdict(4) }));
    const grader = createJudgeGrader(rubric, { adapter, judges: ["m1", "m2"] });
    await grader(SAMPLE, RUN);
    expect(requests).toHaveLength(2);
    for (const req of requests) expect(req.temperature).toBe(0);
  });

  test("judges overrides opts.model", async () => {
    const rubric = loadRubric(RUBRIC_YAML);
    const { adapter, requests } = withCapture(makePanelStub({ mA: verdict(4) }));
    const grader = createJudgeGrader(rubric, { adapter, model: "ignored-model", judges: ["mA"] });
    const result = await grader(SAMPLE, RUN);
    expect(requests.map((r) => r.model)).toEqual(["mA"]);
    expect(result.passed).toBe(true);
    // A single-model panel is degenerate but legal: entropy 0, panel recorded.
    expect(result.panel?.voteEntropy).toBe(0);
  });

  test("panel confidence is the mean of the reported panelist confidences", async () => {
    const rubric = loadRubric(RUBRIC_YAML);
    const adapter = makePanelStub({
      m1: verdict(4, { confidence: 0.9 }),
      m2: verdict(4, { confidence: 0.5 }),
      m3: verdict(4),
    });
    const grader = createJudgeGrader(rubric, { adapter, judges: ["m1", "m2", "m3"] });
    const result = await grader(SAMPLE, RUN);
    expect(result.confidence).toBeCloseTo(0.7);
  });

  test("an empty judges array is rejected at grader build time", () => {
    const rubric = loadRubric(RUBRIC_YAML);
    expect(() => createJudgeGrader(rubric, { judges: [] })).toThrow(JudgeError);
  });

  test("backward compat: no judges option leaves the single-judge shape untouched", async () => {
    const rubric = loadRubric(RUBRIC_YAML);
    const adapter = makeNaiveStubClient(() => ({
      score: 4,
      rationale: "ok",
      criterion_scores: { correctness: 4 },
    }));
    const grader = createJudgeGrader(rubric, { adapter });
    const result = await grader(SAMPLE, RUN);
    expect(Object.keys(result).sort()).toEqual(["detail", "passed", "rationale", "score"]);
    expect(result.rationale).toBe("judge=4 (need ≥4): ok");
  });
});
