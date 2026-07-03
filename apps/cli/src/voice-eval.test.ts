import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VOICE_THRESHOLDS,
  type ReplayEvent,
  VoiceEvalError,
  aggregateVoiceEval,
  computeVoiceMetrics,
  gradeBargeIn,
  gradeLatency,
  gradeTranscript,
  gradeVoiceSession,
  parseReplayLog,
  renderVoiceReport,
} from "./voice-eval";

/** Build a replay-log JSONL from event tuples at runtime (no fixture files). */
function jsonl(events: Array<Partial<ReplayEvent> & { ts: number; kind: string }>): string {
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** A clean 1-turn call: user speaks (ends at 1000), agent answers fast. */
const CLEAN = jsonl([
  { ts: 0, kind: "session_created" },
  { ts: 1000, kind: "transcript_final", role: "user", text: "what's the weather" },
  { ts: 1300, kind: "transcript_partial", role: "agent", text: "It" },
  { ts: 1900, kind: "transcript_final", role: "agent", text: "It is sunny." },
  { ts: 2000, kind: "disconnect" },
]);

describe("parseReplayLog (#65)", () => {
  test("parses + sorts events by ts", () => {
    const session = parseReplayLog("sess_1", CLEAN);
    expect(session.events).toHaveLength(5);
    expect(session.events[0]?.kind).toBe("session_created");
    // out-of-order input sorts stably by ts
    const shuffled = jsonl([
      { ts: 500, kind: "transcript_final", role: "agent", text: "hi" },
      { ts: 100, kind: "session_created" },
    ]);
    const s2 = parseReplayLog("sess_2", shuffled);
    expect(s2.events[0]?.ts).toBe(100);
  });

  test("unwraps the smoke-daemon voice_event envelope", () => {
    const wrapped = `${JSON.stringify({ ts: 5, kind: "voice_event", event: { kind: "interrupt", role: "agent" } })}\n`;
    const s = parseReplayLog("sess_w", wrapped);
    expect(s.events[0]?.kind).toBe("interrupt");
    expect(s.events[0]?.ts).toBe(5);
  });

  test("throws on a bad kind or missing ts", () => {
    expect(() => parseReplayLog("s", `${JSON.stringify({ ts: 1, kind: "nonsense" })}\n`)).toThrow(
      VoiceEvalError,
    );
    expect(() => parseReplayLog("s", `${JSON.stringify({ kind: "interrupt" })}\n`)).toThrow(
      /missing a numeric ts/,
    );
    expect(() => parseReplayLog("s", "{ not json\n")).toThrow(/not valid JSON/);
  });
});

describe("computeVoiceMetrics (#65)", () => {
  test("derives TTFT + turn latency for a clean turn", () => {
    const m = computeVoiceMetrics(parseReplayLog("sess_1", CLEAN));
    expect(m.totalUserTurns).toBe(1);
    expect(m.answeredTurns).toBe(1);
    expect(m.turns[0]?.ttftMs).toBe(300); // 1300 - 1000
    expect(m.turns[0]?.turnLatencyMs).toBe(900); // 1900 - 1000
  });

  test("flags a barge-in that the agent yielded to", () => {
    const withBarge = jsonl([
      { ts: 1000, kind: "transcript_final", role: "user", text: "stop" },
      { ts: 1100, kind: "audio_chunk", role: "agent" },
      { ts: 1200, kind: "barge_in", role: "user", speechFrames: 4 },
      { ts: 1350, kind: "interrupt", role: "agent" },
    ]);
    const m = computeVoiceMetrics(parseReplayLog("sess_b", withBarge));
    expect(m.bargeIns).toHaveLength(1);
    expect(m.bargeIns[0]?.yielded).toBe(true);
    expect(m.bargeIns[0]?.yieldLatencyMs).toBe(150);
  });

  test("a barge-in with no following interrupt is a missed yield", () => {
    const missed = jsonl([
      { ts: 1000, kind: "transcript_final", role: "user", text: "stop" },
      { ts: 1100, kind: "audio_chunk", role: "agent" },
      { ts: 1200, kind: "barge_in", role: "user", speechFrames: 4 },
    ]);
    const m = computeVoiceMetrics(parseReplayLog("sess_m", missed));
    expect(m.bargeIns[0]?.yielded).toBe(false);
  });
});

describe("voice graders (#65)", () => {
  test("gradeLatency passes a fast turn, fails a slow one", () => {
    const clean = computeVoiceMetrics(parseReplayLog("s", CLEAN));
    expect(gradeLatency(clean, DEFAULT_VOICE_THRESHOLDS).passed).toBe(true);

    const slow = jsonl([
      { ts: 0, kind: "transcript_final", role: "user", text: "hi" },
      { ts: 5000, kind: "transcript_partial", role: "agent", text: "..." },
      { ts: 6000, kind: "transcript_final", role: "agent", text: "hello" },
    ]);
    const g = gradeLatency(
      computeVoiceMetrics(parseReplayLog("s", slow)),
      DEFAULT_VOICE_THRESHOLDS,
    );
    expect(g.passed).toBe(false);
    expect(g.rationale).toContain("TTFT");
  });

  test("gradeBargeIn passes vacuously with no barge-ins, fails a missed yield", () => {
    const clean = computeVoiceMetrics(parseReplayLog("s", CLEAN));
    expect(gradeBargeIn(clean, DEFAULT_VOICE_THRESHOLDS).passed).toBe(true);

    const missed = jsonl([
      { ts: 1000, kind: "transcript_final", role: "user", text: "stop" },
      { ts: 1100, kind: "audio_chunk", role: "agent" },
      { ts: 1200, kind: "barge_in", role: "user", speechFrames: 4 },
    ]);
    const g = gradeBargeIn(
      computeVoiceMetrics(parseReplayLog("s", missed)),
      DEFAULT_VOICE_THRESHOLDS,
    );
    expect(g.passed).toBe(false);
    expect(g.rationale).toContain("never yielded");
  });

  test("gradeTranscript flags a user turn with no agent response", () => {
    const silent = jsonl([
      { ts: 1000, kind: "transcript_final", role: "user", text: "hello?" },
      { ts: 2000, kind: "disconnect" },
    ]);
    const g = gradeTranscript(computeVoiceMetrics(parseReplayLog("s", silent)));
    expect(g.passed).toBe(false);
    expect(g.score).toBe(0);
  });
});

describe("gradeVoiceSession + aggregate (#65)", () => {
  test("a clean session passes all three dimensions", () => {
    const r = gradeVoiceSession(parseReplayLog("sess_clean", CLEAN));
    expect(r.passed).toBe(true);
    expect(r.grades.voice_latency.passed).toBe(true);
    expect(r.grades.voice_barge_in.passed).toBe(true);
    expect(r.grades.voice_transcript.passed).toBe(true);
  });

  test("aggregate reports pass rate + TTFT percentiles + barge-in yield rate", () => {
    const good = gradeVoiceSession(parseReplayLog("g", CLEAN));
    const badBarge = gradeVoiceSession(
      parseReplayLog(
        "b",
        jsonl([
          { ts: 1000, kind: "transcript_final", role: "user", text: "stop" },
          { ts: 1100, kind: "audio_chunk", role: "agent" },
          { ts: 1200, kind: "barge_in", role: "user", speechFrames: 4 },
          { ts: 1300, kind: "transcript_final", role: "agent", text: "ok" },
        ]),
      ),
    );
    const summary = aggregateVoiceEval([good, badBarge]);
    expect(summary.passRate).toBe(0.5);
    expect(summary.p50TtftMs).toBeDefined();
    expect(summary.bargeInYieldRate).toBe(0); // the one barge-in never yielded
    const report = renderVoiceReport(summary);
    expect(report).toContain("voice eval: 2 session(s)");
    expect(report).toContain("FAIL b");
  });
});
