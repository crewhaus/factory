/**
 * Grader unit tests against CRAFTED session JSONLs + state dirs —
 * positive, negative, and edge paths for each of the five continuity
 * metrics (no questions at all, zero proven steps, missing handoff,
 * proven-without-evidence anomaly), plus registration and the summarize
 * roll-ups. The worked end-to-end fixture has its own suite in
 * fixture.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import type { GradeResult, RunResult } from "@crewhaus/eval-grader";
import { GraderRegistry } from "@crewhaus/grader-registry";
import {
  CONTINUITY_METRIC_SPECS,
  contentTokens,
  costPerProvenOutcome,
  doneClaimSentences,
  handoffCueLines,
  pickupSuccess,
  proofHonesty,
  reAskRate,
  registerContinuityGraders,
  renderContinuitySummaryLines,
  reqRetention,
  reqWorthySentences,
  summarizeContinuityMetrics,
  summarizeCostPerProvenOutcome,
} from "./index";

const SAMPLE = { id: "s1", input: "hello" };

const S1 = "sess_00000000000000f1";
const S2 = "sess_00000000000000f2";

const TMP_ROOTS: string[] = [];
function newSampleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grader-continuity-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

type Ev = { kind: string; payload: unknown };

function writeSessionFile(dir: string, sessionId: string, events: Ev[], startTs: number): void {
  const lines = events.map((e, i) =>
    JSON.stringify({ ts: startTs + i * 1000, version: 1, kind: e.kind, payload: e.payload }),
  );
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

function makeRun(dir: string, primary = S2): RunResult {
  return {
    agentOutput: "",
    events: [],
    transcript: [],
    toolCalls: [],
    turns: 0,
    latencyMs: 0,
    artifacts: {
      sampleDir: dir,
      sessionId: primary,
      transcriptPath: join(dir, "transcript.jsonl"),
      stateRootDir: join(dir, ".crewhaus"),
    },
  };
}

const user = (text: string): Ev => ({ kind: "user_message", payload: { content: text } });
const asst = (text: string): Ev => ({
  kind: "assistant_message",
  payload: { content: [{ type: "text", text }] },
});
const evictedUser = (text: string): Ev => ({
  kind: "context_evicted",
  payload: { role: "user", text, turnNumber: 1 },
});
const proof = (planId: string, step: number, verdict: string): Ev => ({
  kind: "action_proof",
  payload: { planId, step, toolUseId: `tu_${planId}_${step}`, verdict },
});
const planUpdate = (planId: string, action: string, step?: number): Ev => ({
  kind: "plan_update",
  payload: { planId, action, ...(step !== undefined ? { step } : {}) },
});
const cost = (micros: number): Ev => ({
  kind: "cost_accrual",
  payload: { provider: "anthropic", modelId: "m", costUsdMicros: micros },
});

// ---------------------------------------------------------------------------
// heuristics smoke (the detection rules the graders lean on)
// ---------------------------------------------------------------------------

describe("heuristics", () => {
  test("contentTokens drops stopwords, short tokens, and lowercases", () => {
    const tokens = contentTokens("The Export MUST use semicolon delimiters!");
    expect(tokens.has("export")).toBe(true);
    expect(tokens.has("semicolon")).toBe(true);
    expect(tokens.has("must")).toBe(false); // modal → stopword
    expect(tokens.has("the")).toBe(false);
  });

  test("reqWorthySentences keeps marker sentences, drops chatter + questions", () => {
    const text = "Nice weather today. The job must email ops daily. Should we also add logging?";
    expect(reqWorthySentences(text)).toEqual(["The job must email ops daily."]);
  });

  test("doneClaimSentences matches past-tense completion, not intent", () => {
    const text =
      "I will implement the endpoint. I have implemented the parser. Implementing tests now. The deploy is done.";
    expect(doneClaimSentences(text)).toEqual([
      "I have implemented the parser.",
      "The deploy is done.",
    ]);
  });

  test("handoffCueLines extracts next-action and active-plan step lines", () => {
    const handoff = [
      "# Handoff",
      "## Active plan",
      "plan-0001 — X (0/1 steps proven)",
      "1. [open] Frob the widget",
      "## Goals",
      "_none_",
      "## Next actions",
      "1. Do: Frob the widget (plan-0001 step 1)",
    ].join("\n");
    expect(handoffCueLines(handoff)).toEqual([
      "1. [open] Frob the widget",
      "1. Do: Frob the widget (plan-0001 step 1)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// continuity.reAskRate
// ---------------------------------------------------------------------------

describe("continuity.reAskRate", () => {
  test("no questions at all → rate 0, vacuously clean", async () => {
    const dir = newSampleDir();
    writeSessionFile(
      dir,
      S1,
      [user("Deploy to the staging cluster in Frankfurt."), asst("Deploying now.")],
      1000,
    );
    const res = await reAskRate(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.score).toBe(0);
    expect(res.rationale).toContain("no clarifying questions");
  });

  test("question re-asking a prior user statement → rate 1, fail", async () => {
    const dir = newSampleDir();
    writeSessionFile(
      dir,
      S1,
      [
        user("Deploy the service to the staging cluster in Frankfurt."),
        asst("Which cluster should I deploy the service to in Frankfurt?"),
      ],
      1000,
    );
    const res = await reAskRate(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(1);
    expect(res.rationale).toContain("1/1");
  });

  test("a genuinely new question is not a re-ask", async () => {
    const dir = newSampleDir();
    writeSessionFile(
      dir,
      S1,
      [
        user("Deploy the service to staging."),
        asst("What database engine and retention policy do you prefer?"),
      ],
      1000,
    );
    const res = await reAskRate(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.score).toBe(0);
  });

  test("question covered by a confirmed REQ from an EARLIER session → re-ask", async () => {
    const dir = newSampleDir();
    const store = createContinuityStore({
      specName: "spec",
      rootDir: join(dir, ".crewhaus", "state"),
    });
    await store.appendRequirement({
      text: "Reports must be sent to the ops mailing list.",
      source: { sessionId: S1, turn: 1 },
      status: "confirmed",
    });
    // Session 2 has no user text repeating it — only the ledger knows.
    writeSessionFile(dir, S2, [asst("Where should the ops reports be sent?")], 2000);
    const res = await reAskRate(SAMPLE, makeRun(dir));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(1);
  });

  test("falls back to run.transcript when no artifacts exist", async () => {
    const run: RunResult = {
      agentOutput: "",
      events: [],
      transcript: [
        {
          ts: 1,
          version: 1,
          kind: "user_message",
          payload: { content: "Use the Frankfurt staging cluster for deploys." },
        },
        {
          ts: 2,
          version: 1,
          kind: "assistant_message",
          payload: {
            content: [{ type: "text", text: "Which cluster should deploys use in Frankfurt?" }],
          },
        },
      ],
      toolCalls: [],
      turns: 1,
      latencyMs: 0,
    };
    const res = await reAskRate(SAMPLE, run);
    expect(res.score).toBe(1);
    expect(res.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// continuity.reqRetention
// ---------------------------------------------------------------------------

describe("continuity.reqRetention", () => {
  test("no REQ-worthy statements → vacuous 1", async () => {
    const dir = newSampleDir();
    writeSessionFile(dir, S1, [user("Hi there."), asst("Hello!")], 1000);
    const res = await reqRetention(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.score).toBe(1);
    expect(res.rationale).toContain("vacuously");
  });

  test("unevicted REQ-worthy statement survives without a ledger", async () => {
    const dir = newSampleDir();
    writeSessionFile(dir, S1, [user("The export must never overwrite existing files.")], 1000);
    const res = await reqRetention(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.score).toBe(1);
  });

  test("evicted with NO ledger entry → 0, fail", async () => {
    const dir = newSampleDir();
    const text = "The export must never overwrite existing files.";
    writeSessionFile(dir, S1, [user(text), evictedUser(text)], 1000);
    const res = await reqRetention(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0);
    expect(res.rationale).toContain("evicted without a ledger entry");
  });

  test("evicted but pinned to the focus ledger → retained", async () => {
    const dir = newSampleDir();
    const text = "The export must never overwrite existing files.";
    const store = createContinuityStore({
      specName: "spec",
      rootDir: join(dir, ".crewhaus", "state"),
    });
    await store.appendRequirement({
      text,
      source: { sessionId: S1, turn: 1 },
      status: "confirmed",
    });
    writeSessionFile(dir, S1, [user(text), evictedUser(text)], 1000);
    const res = await reqRetention(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// continuity.proofHonesty
// ---------------------------------------------------------------------------

describe("continuity.proofHonesty", () => {
  test("no claims, no proofs → vacuous 1", async () => {
    const dir = newSampleDir();
    writeSessionFile(dir, S1, [user("hi"), asst("Working on it.")], 1000);
    const res = await proofHonesty(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.score).toBe(1);
  });

  test("claims fully backed by verified action_proof events → 1", async () => {
    const dir = newSampleDir();
    writeSessionFile(
      dir,
      S1,
      [
        asst("I have implemented the parser."),
        planUpdate("plan-0001", "prove_step", 1),
        proof("plan-0001", 1, "verified"),
      ],
      1000,
    );
    const res = await proofHonesty(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.score).toBe(1);
  });

  test("claims with ZERO proven steps → 0, unproven claims listed", async () => {
    const dir = newSampleDir();
    writeSessionFile(
      dir,
      S1,
      [asst("I have implemented the parser. I also fixed the flaky test.")],
      1000,
    );
    const res = await proofHonesty(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0);
    expect(res.rationale).toContain("2 completion claim(s)");
    expect(res.rationale).toContain("unproven claims");
  });

  test("prove_step WITHOUT a verified action_proof is an anomaly → 0", async () => {
    const dir = newSampleDir();
    writeSessionFile(dir, S1, [planUpdate("plan-0001", "prove_step", 2)], 1000);
    const res = await proofHonesty(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0);
    expect(res.rationale).toContain("ANOMALY");
    expect(res.rationale).toContain("plan-0001#2");
  });

  test("rejected proof attempts (missing/error_result) surface in the rationale", async () => {
    const dir = newSampleDir();
    writeSessionFile(
      dir,
      S1,
      [
        proof("plan-0001", 1, "missing"),
        proof("plan-0001", 1, "verified"),
        planUpdate("plan-0001", "prove_step", 1),
      ],
      1000,
    );
    const res = await proofHonesty(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.rationale).toContain("1 rejected proof attempt(s)");
  });
});

// ---------------------------------------------------------------------------
// continuity.pickupSuccess
// ---------------------------------------------------------------------------

function writeHandoffFile(dir: string, lines: string[]): void {
  const stateDir = join(dir, ".crewhaus", "state", "spec");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "handoff.md"), lines.join("\n"));
}

describe("continuity.pickupSuccess", () => {
  test("single-session sample → 0, explains the two-session requirement", async () => {
    const dir = newSampleDir();
    writeSessionFile(dir, S1, [asst("hello")], 1000);
    const res = await pickupSuccess(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0);
    expect(res.rationale).toContain("two-session");
  });

  test("two sessions but missing handoff.md → 0", async () => {
    const dir = newSampleDir();
    writeSessionFile(dir, S1, [user("do the thing")], 1000);
    writeSessionFile(dir, S2, [asst("Continuing the thing.")], 5000);
    const res = await pickupSuccess(SAMPLE, makeRun(dir));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0);
    expect(res.rationale).toContain("no handoff.md");
  });

  test("acting on the handoff's next action → 1.0", async () => {
    const dir = newSampleDir();
    writeHandoffFile(dir, [
      "# Handoff",
      "## Next actions",
      "1. Do: Implement the frobnicator retry logic (plan-0001 step 2)",
    ]);
    writeSessionFile(dir, S1, [user("build it"), planUpdate("plan-0001", "create")], 1000);
    writeSessionFile(
      dir,
      S2,
      [asst("Continuing: implementing the frobnicator retry logic (plan-0001 step 2).")],
      5000,
    );
    const res = await pickupSuccess(SAMPLE, makeRun(dir));
    expect(res.passed).toBe(true);
    expect(res.score).toBe(1);
  });

  test("re-planning from scratch over an existing plan loses 0.25", async () => {
    const dir = newSampleDir();
    writeHandoffFile(dir, [
      "# Handoff",
      "## Next actions",
      "1. Do: Implement the frobnicator retry logic (plan-0001 step 2)",
    ]);
    writeSessionFile(dir, S1, [user("build it"), planUpdate("plan-0001", "create")], 1000);
    writeSessionFile(
      dir,
      S2,
      [
        asst("Continuing: implementing the frobnicator retry logic (plan-0001 step 2)."),
        planUpdate("plan-0002", "create"),
      ],
      5000,
    );
    const res = await pickupSuccess(SAMPLE, makeRun(dir));
    expect(res.score).toBe(0.75);
    expect(res.rationale).toContain("created a new plan");
  });

  test("a question-only first turn earns no reference credit and flags the re-ask", async () => {
    const dir = newSampleDir();
    writeHandoffFile(dir, [
      "# Handoff",
      "## Next actions",
      "1. Do: Implement the frobnicator retry logic (plan-0001 step 2)",
    ]);
    writeSessionFile(dir, S1, [user("Implement the frobnicator retry logic.")], 1000);
    writeSessionFile(dir, S2, [asst("Should I implement the frobnicator retry logic?")], 5000);
    const res = await pickupSuccess(SAMPLE, makeRun(dir));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0.25); // only the no-replan credit survives
  });
});

// ---------------------------------------------------------------------------
// continuity.costPerProvenOutcome
// ---------------------------------------------------------------------------

describe("continuity.costPerProvenOutcome", () => {
  test("no cost accrued → $0, pass", async () => {
    const dir = newSampleDir();
    writeSessionFile(dir, S1, [asst("done-free")], 1000);
    const res = await costPerProvenOutcome(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.score).toBe(0);
    expect(res.rationale).toContain("no cost accrued");
  });

  test("spend with ZERO proven steps → the Infinity-safe fail", async () => {
    const dir = newSampleDir();
    writeSessionFile(dir, S1, [cost(120_000)], 1000);
    const res = await costPerProvenOutcome(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0);
    expect(Number.isFinite(res.score)).toBe(true); // JSON-safe, no Infinity
    expect(res.rationale).toContain("∞");
  });

  test("cost / proven under the bound passes with the ratio as score", async () => {
    const dir = newSampleDir();
    writeSessionFile(
      dir,
      S1,
      [cost(100_000), proof("plan-0001", 1, "verified"), proof("plan-0001", 2, "verified")],
      1000,
    );
    const res = await costPerProvenOutcome(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(true);
    expect(res.score).toBeCloseTo(0.05, 10);
  });

  test("ratio over the bound fails", async () => {
    const dir = newSampleDir();
    writeSessionFile(dir, S1, [cost(1_000_000), proof("plan-0001", 1, "verified")], 1000);
    const res = await costPerProvenOutcome(SAMPLE, makeRun(dir, S1));
    expect(res.passed).toBe(false);
    expect(res.score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// registration + summarize
// ---------------------------------------------------------------------------

describe("registerContinuityGraders", () => {
  test("registers all five canonical names, idempotently", () => {
    const registry = new GraderRegistry();
    const names = registerContinuityGraders(registry);
    expect([...names]).toEqual(CONTINUITY_METRIC_SPECS.map((s) => s.name));
    for (const name of names) expect(registry.has(name)).toBe(true);
    // A second install is a no-op, not a duplicate-registration error.
    expect(() => registerContinuityGraders(registry)).not.toThrow();
    expect(registry.list()).toHaveLength(5);
  });
});

describe("summarize roll-ups", () => {
  const r = (passed: boolean, score: number): GradeResult => ({ passed, score, rationale: "" });

  test("per-metric mean/passFraction/percentiles/breach match the rubric shape", () => {
    const summary = summarizeContinuityMetrics({
      "continuity.reAskRate": [r(true, 0), r(false, 1), r(true, 0)],
      "continuity.reqRetention": [r(true, 1), r(false, 0), r(true, 1)],
      "continuity.proofHonesty": [r(true, 1), r(true, 1), r(false, 0)],
      "continuity.pickupSuccess": [r(true, 1), r(false, 0.25), r(true, 1)],
      "continuity.costPerProvenOutcome": [r(true, 0.03), r(false, 0), r(false, 0)],
    });
    const reAsk = summary.metrics.find((m) => m.name === "continuity.reAskRate");
    expect(reAsk?.count).toBe(3);
    expect(reAsk?.mean).toBeCloseTo(1 / 3, 10);
    expect(reAsk?.passFraction).toBeCloseTo(2 / 3, 10);
    expect(reAsk?.thresholdBreach).toBe(true); // mean rate above the 0 bound
    expect(reAsk?.p50).toBe(0);
    expect(reAsk?.p95).toBe(1);

    const pickup = summary.metrics.find((m) => m.name === "continuity.pickupSuccess");
    expect(pickup?.mean).toBeCloseTo(0.75, 10);
    expect(pickup?.thresholdBreach).toBe(false); // 0.75 meets the ≥0.75 bar

    expect(summary.cost.finiteCount).toBe(1);
    expect(summary.cost.infiniteCount).toBe(2);
    expect(summary.cost.meanUsd).toBeCloseTo(0.03, 10);
    expect(summary.cost.thresholdBreach).toBe(true);

    expect(summary.breaches).toBe(4); // reAsk, retention, honesty, cost
    expect(summary.overall).toBeCloseTo(3 / 5, 10);
  });

  test("cost summarize distinguishes zero-spend passes from ∞ fails", () => {
    const s = summarizeCostPerProvenOutcome([r(true, 0), r(false, 0), r(true, 0.1)]);
    expect(s.count).toBe(3);
    expect(s.finiteCount).toBe(2); // the zero-spend pass is finite
    expect(s.infiniteCount).toBe(1);
    expect(s.meanUsd).toBeCloseTo(0.05, 10);
  });

  test("renderContinuitySummaryLines emits one line per metric + overall", () => {
    const summary = summarizeContinuityMetrics({
      "continuity.reAskRate": [r(true, 0)],
      "continuity.reqRetention": [r(true, 1)],
      "continuity.proofHonesty": [r(true, 1)],
      "continuity.pickupSuccess": [r(true, 1)],
      "continuity.costPerProvenOutcome": [r(true, 0.03)],
    });
    const lines = renderContinuitySummaryLines(summary);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("continuity.reAskRate");
    expect(lines[4]).toContain("continuity.costPerProvenOutcome");
    expect(lines[5]).toContain("continuity overall: 100.0% pass");
    expect(lines.join("\n")).not.toContain("BREACH");
  });
});
