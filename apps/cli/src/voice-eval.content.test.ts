/**
 * D46 — `eval --voice --graders <g.yaml>`: content grading joins the latency
 * pack. A voice agent fails on WHAT it says, and a latency budget cannot
 * express "the agent quoted the wrong refund policy".
 *
 * Graders are injected as plain functions (that IS the grader contract), so
 * these tests exercise the real projection + failure semantics without a
 * judge, credentials, or a network.
 */
import { describe, expect, test } from "bun:test";
import type { Grader } from "@crewhaus/eval-grader";
import {
  DEFAULT_VOICE_THRESHOLDS,
  type ReplaySession,
  aggregateVoiceEval,
  combineVoiceContentGrades,
  gradeVoiceContent,
  gradeVoiceSession,
  gradeVoiceSessionWithContent,
  renderVoiceReport,
  voiceSampleFromSession,
} from "./voice-eval";

/** A clean two-turn call: both turns answered well inside the budgets. */
function goodSession(sessionId = "call-1", agentTexts = ["We refund within 30 days.", "Bye."]) {
  const session: ReplaySession = {
    sessionId,
    events: [
      { ts: 1000, kind: "session_created" },
      { ts: 1100, kind: "transcript_final", role: "user", text: "what is the refund window?" },
      { ts: 1300, kind: "transcript_partial", role: "agent", text: "We…" },
      { ts: 1600, kind: "transcript_final", role: "agent", text: agentTexts[0] as string },
      { ts: 2000, kind: "transcript_final", role: "user", text: "thanks" },
      { ts: 2200, kind: "transcript_partial", role: "agent", text: "B…" },
      { ts: 2400, kind: "transcript_final", role: "agent", text: agentTexts[1] as string },
      { ts: 2500, kind: "disconnect" },
    ],
  };
  return session;
}

const passing: Grader = async () => ({ passed: true, score: 1, rationale: "content ok" });
const failing: Grader = async () => ({
  passed: false,
  score: 0,
  rationale: "said 14 days, policy is 30",
});

describe("voiceSampleFromSession (the projection)", () => {
  test("grades the AGENT's final transcripts, keyed by session id", () => {
    const { sample, run } = voiceSampleFromSession(goodSession());
    expect(sample.id).toBe("call-1");
    expect(run.agentOutput).toBe("We refund within 30 days.\nBye.");
    expect(run.turns).toBe(2);
  });

  test("the sample input is the USER's turns (what the agent was answering)", () => {
    const { sample } = voiceSampleFromSession(goodSession());
    expect(sample.input).toBe("what is the refund window?\nthanks");
  });

  test("no gold is invented — a replay carries none", () => {
    expect(voiceSampleFromSession(goodSession()).sample.expected_output).toBeUndefined();
  });

  test("no trace events are fabricated (trajectory graders must not 'pass' on nothing)", () => {
    const { run } = voiceSampleFromSession(goodSession());
    expect(run.events).toEqual([]);
    expect(run.transcript).toEqual([]);
    expect(run.toolCalls).toEqual([]);
    expect(run.latencyMs).toBe(1500);
  });

  test("partials and empty finals are excluded from the graded text", () => {
    const session: ReplaySession = {
      sessionId: "c",
      events: [
        { ts: 1, kind: "transcript_final", role: "user", text: "hi" },
        { ts: 2, kind: "transcript_partial", role: "agent", text: "par" },
        { ts: 3, kind: "transcript_final", role: "agent", text: "   " },
        { ts: 4, kind: "transcript_final", role: "agent", text: "real answer" },
      ],
    };
    expect(voiceSampleFromSession(session).run.agentOutput).toBe("real answer");
  });
});

describe("gradeVoiceContent", () => {
  test("records one verdict per grader, in declaration order", async () => {
    const grades = await gradeVoiceContent(goodSession(), [
      { name: "mentions_policy", grader: passing },
      { name: "no_promises", grader: failing },
    ]);
    expect(grades.map((g) => g.grader)).toEqual(["mentions_policy", "no_promises"]);
    expect(grades.map((g) => g.passed)).toEqual([true, false]);
    expect(grades[1]?.rationale).toContain("policy is 30");
  });

  test("a THROWING grader becomes a failed verdict naming the throw, never a crash", async () => {
    const boom: Grader = async () => {
      throw new Error("judge 429");
    };
    const grades = await gradeVoiceContent(goodSession(), [{ name: "judge", grader: boom }]);
    expect(grades).toHaveLength(1);
    expect(grades[0]?.passed).toBe(false);
    expect(grades[0]?.rationale).toBe("grader threw: judge 429");
  });
});

describe("gradeVoiceSessionWithContent", () => {
  test("without graders it is exactly gradeVoiceSession (no contentGrades key)", async () => {
    const session = goodSession();
    const withNone = await gradeVoiceSessionWithContent(session, DEFAULT_VOICE_THRESHOLDS, []);
    expect(withNone).toEqual(gradeVoiceSession(session, DEFAULT_VOICE_THRESHOLDS));
    expect(withNone.contentGrades).toBeUndefined();
  });

  test("passing content keeps a latency-clean session green", async () => {
    const result = await gradeVoiceSessionWithContent(goodSession(), DEFAULT_VOICE_THRESHOLDS, [
      { name: "mentions_policy", grader: passing },
    ]);
    expect(result.passed).toBe(true);
    expect(result.contentGrades).toHaveLength(1);
  });

  test("a content FAILURE fails the session, exactly like a latency breach", async () => {
    const result = await gradeVoiceSessionWithContent(goodSession(), DEFAULT_VOICE_THRESHOLDS, [
      { name: "no_wrong_policy", grader: failing },
    ]);
    // Latency/barge-in/transcript all pass…
    expect(result.grades.voice_latency.passed).toBe(true);
    expect(result.grades.voice_transcript.passed).toBe(true);
    // …and the session still fails, which is what makes the CLI exit 1.
    expect(result.passed).toBe(false);
  });

  test("a latency breach still fails even when content passes", async () => {
    const slow: ReplaySession = {
      sessionId: "slow",
      events: [
        { ts: 0, kind: "transcript_final", role: "user", text: "hi" },
        { ts: 9000, kind: "transcript_partial", role: "agent", text: "…" },
        { ts: 9500, kind: "transcript_final", role: "agent", text: "eventually" },
      ],
    };
    const result = await gradeVoiceSessionWithContent(slow, DEFAULT_VOICE_THRESHOLDS, [
      { name: "content", grader: passing },
    ]);
    expect(result.grades.voice_latency.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe("combine policy (A4/A5) — the voice path OBEYS the parsed grammar", () => {
  const graders = [
    { name: "c_pass", grader: passing },
    { name: "c_fail", grader: failing },
  ];

  test("combine: any — one passing content grader keeps the session green", async () => {
    const result = await gradeVoiceSessionWithContent(
      goodSession(),
      DEFAULT_VOICE_THRESHOLDS,
      graders,
      { combine: { mode: "any" } },
    );
    expect(result.contentGrades?.map((g) => g.passed)).toEqual([true, false]);
    // Under the hardcoded all-must-pass this session FAILED and exited 1,
    // silently ignoring the `combine: any` the file declared.
    expect(result.passed).toBe(true);
  });

  test("combine: all (and absent) still requires every content grader", async () => {
    for (const opts of [{}, { combine: { mode: "all" as const } }]) {
      const result = await gradeVoiceSessionWithContent(
        goodSession(),
        DEFAULT_VOICE_THRESHOLDS,
        graders,
        opts,
      );
      expect(result.passed).toBe(false);
    }
  });

  test("combine: weighted gates the weighted mean on passing_threshold", async () => {
    const weighted = [
      { name: "c_pass", grader: passing, weight: 3 },
      { name: "c_fail", grader: failing, weight: 1 },
    ];
    // 0.75 ≥ 0.5 default cut ⇒ content passes despite one failing grader.
    const lenient = await gradeVoiceSessionWithContent(
      goodSession(),
      DEFAULT_VOICE_THRESHOLDS,
      weighted,
      { combine: { mode: "weighted" } },
    );
    expect(lenient.passed).toBe(true);
    // …and a stricter declared cut fails the same evidence.
    const strict = await gradeVoiceSessionWithContent(
      goodSession(),
      DEFAULT_VOICE_THRESHOLDS,
      weighted,
      { combine: { mode: "weighted", passingThreshold: 0.9 } },
    );
    expect(strict.passed).toBe(false);
  });

  test("the fold matches run-sample's semantics for each mode", () => {
    const grades = [
      { grader: "a", passed: true, score: 1, rationale: "" },
      { grader: "b", passed: false, score: 0.2, rationale: "" },
    ];
    const entries = [
      { name: "a", grader: passing, weight: 1 },
      { name: "b", grader: failing, weight: 1 },
    ];
    expect(combineVoiceContentGrades(grades, entries, undefined)).toEqual({
      passed: false,
      score: 0.6,
    });
    expect(combineVoiceContentGrades(grades, entries, { mode: "any" })).toEqual({
      passed: true,
      score: 1,
    });
    expect(combineVoiceContentGrades(grades, entries, { mode: "weighted" })).toEqual({
      passed: true,
      score: 0.6,
    });
  });
});

describe("summary + report", () => {
  test("the aggregate counts content verdicts across sessions", async () => {
    const results = await Promise.all([
      gradeVoiceSessionWithContent(goodSession("a"), DEFAULT_VOICE_THRESHOLDS, [
        { name: "c1", grader: passing },
        { name: "c2", grader: failing },
      ]),
      gradeVoiceSessionWithContent(goodSession("b"), DEFAULT_VOICE_THRESHOLDS, [
        { name: "c1", grader: passing },
        { name: "c2", grader: passing },
      ]),
    ]);
    const summary = aggregateVoiceEval(results);
    expect(summary.contentGraded).toBe(4);
    expect(summary.contentPassed).toBe(3);
    expect(summary.passRate).toBe(0.5);
  });

  test("content-free runs OMIT the content keys entirely (byte-identical JSON)", () => {
    const summary = aggregateVoiceEval([
      gradeVoiceSession(goodSession(), DEFAULT_VOICE_THRESHOLDS),
    ]);
    // Presence-gated like every other additive eval field: a no-`--graders`
    // voice-eval.json must not grow `"contentGraded": 0` keys.
    expect(summary.contentGraded).toBeUndefined();
    expect(summary.contentPassed).toBeUndefined();
    expect(Object.keys(summary)).not.toContain("contentGraded");
    expect(JSON.stringify(summary)).not.toContain("contentGraded");
    expect(renderVoiceReport(summary)).not.toContain("content graders");
  });

  test("the report names the failing content grader and its rationale", async () => {
    const result = await gradeVoiceSessionWithContent(goodSession(), DEFAULT_VOICE_THRESHOLDS, [
      { name: "no_wrong_policy", grader: failing },
    ]);
    const text = renderVoiceReport(aggregateVoiceEval([result]));
    expect(text).toContain("FAIL call-1");
    expect(text).toContain("content no_wrong_policy: said 14 days, policy is 30");
    expect(text).toContain("content graders:    0/1");
  });
});
