/**
 * Item 65 — `crewhaus eval --voice`: replay recorded voice sessions through
 * deterministic graders measuring latency, barge-in correctness, and transcript
 * quality — WITHOUT live audio, a microphone, or provider credentials.
 *
 * Live realtime audio is out of scope for the eval loop (non-deterministic,
 * credential-bound). Instead the replay reads persisted call-session logs — a
 * JSONL of timestamped voice events, the same discriminated union
 * `voice-runtime` emits (`session_created`, `transcript_partial/final`,
 * `audio_chunk`, `tool_use`, `interrupt`, `disconnect`) plus the barge-in
 * signal the `barge-in-controller` fires, each stamped with a `ts` (epoch ms)
 * and, for user turns, a `role`. From that timeline the graders derive:
 *
 *   - LATENCY:     time-to-first-token (first user utterance end → first
 *                  agent `transcript_partial`/`audio_chunk`), and per-turn
 *                  response latency. Graded against declared budgets.
 *   - BARGE-IN:    every `barge_in` signal must be followed by an agent
 *                  `interrupt` (the agent yielded) within a window — a missed
 *                  yield is a correctness failure.
 *   - TRANSCRIPT:  each user turn should produce a non-empty agent transcript
 *                  (ASR/response coverage) — an empty/absent response is a
 *                  transcript-quality failure.
 *
 * D46 — CONTENT grading joins them when `eval --voice --graders <g.yaml>` is
 * passed: the replayed transcript is projected onto the standard grader
 * contract (`voiceSampleFromSession`) and scored by the ordinary grader
 * stack — deterministic graders, registry packs, `llm_judge` rubrics. A
 * voice agent fails on WHAT it says, and latency budgets alone cannot
 * express "the agent quoted the wrong refund policy". A content failure
 * fails the session exactly like a latency breach; without `--graders`
 * nothing changes.
 *
 * Everything here is side-effect-free (the CLI entry file reads the replay
 * JSONL files + writes the report). Deterministic: identical input timeline →
 * identical metrics, so a fixture replays byte-stably in CI.
 */

import type { Sample } from "@crewhaus/eval-dataset";
import type { Grader, GraderCombinePolicy, RunResult } from "@crewhaus/eval-grader";

/** Thrown on a malformed replay log / bad flags. The CLI routes it through
 *  `die()`; tests assert on `.message`. */
export class VoiceEvalError extends Error {
  override readonly name = "VoiceEvalError";
}

/** One parsed replay-log line. `ts` is epoch ms; `role` marks user vs agent
 *  events (agent by default). Shape mirrors `voice-runtime`'s RealtimeEvent
 *  plus the `barge_in` controller signal. */
export type ReplayEvent = {
  readonly ts: number;
  readonly kind:
    | "session_created"
    | "transcript_partial"
    | "transcript_final"
    | "audio_chunk"
    | "tool_use"
    | "interrupt"
    | "barge_in"
    | "disconnect"
    | "error";
  readonly role?: "user" | "agent";
  readonly text?: string;
  /** For barge_in: how many consecutive speech frames triggered it. */
  readonly speechFrames?: number;
};

/** Per-call thresholds; a voice spec's `voice.eval` block would carry these.
 *  Defaults are conservative realtime targets. */
export type VoiceThresholds = {
  /** Max acceptable time-to-first-token (ms). Default 1200. */
  readonly maxTtftMs: number;
  /** Max acceptable per-turn response latency (ms). Default 2500. */
  readonly maxTurnLatencyMs: number;
  /** Max acceptable delay between a barge-in and the agent yielding (ms).
   *  Default 500. */
  readonly maxBargeInYieldMs: number;
};

export const DEFAULT_VOICE_THRESHOLDS: VoiceThresholds = {
  maxTtftMs: 1200,
  maxTurnLatencyMs: 2500,
  maxBargeInYieldMs: 500,
};

/** A parsed replay session — the events sorted by ts + a stable id. */
export type ReplaySession = {
  readonly sessionId: string;
  readonly events: ReadonlyArray<ReplayEvent>;
};

const VALID_KINDS: ReadonlySet<string> = new Set([
  "session_created",
  "transcript_partial",
  "transcript_final",
  "audio_chunk",
  "tool_use",
  "interrupt",
  "barge_in",
  "disconnect",
  "error",
]);

/**
 * Parse a replay-log JSONL blob into a sorted ReplaySession. Skips blank lines;
 * throws `VoiceEvalError` on a line that parses but is not a well-formed event
 * (bad kind / non-numeric ts) so a corrupt fixture is loud, not silently empty.
 */
export function parseReplayLog(sessionId: string, jsonl: string): ReplaySession {
  const events: ReplayEvent[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new VoiceEvalError(`replay ${sessionId}: line ${i + 1} is not valid JSON`);
    }
    if (obj === null || typeof obj !== "object") {
      throw new VoiceEvalError(`replay ${sessionId}: line ${i + 1} is not an event object`);
    }
    const rec = obj as Record<string, unknown>;
    // Accept the smoke-daemon envelope `{ kind: "voice_event", event: {...} }`
    // by unwrapping, and the flat replay shape alike.
    const inner =
      rec["kind"] === "voice_event" && typeof rec["event"] === "object" && rec["event"] !== null
        ? { ...(rec["event"] as Record<string, unknown>), ts: rec["ts"] ?? undefined }
        : rec;
    const kind = inner["kind"];
    if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
      throw new VoiceEvalError(
        `replay ${sessionId}: line ${i + 1} has unknown event kind ${JSON.stringify(kind)}`,
      );
    }
    const ts = inner["ts"];
    if (typeof ts !== "number" || !Number.isFinite(ts)) {
      throw new VoiceEvalError(
        `replay ${sessionId}: line ${i + 1} (${kind}) is missing a numeric ts (epoch ms)`,
      );
    }
    const role = inner["role"];
    const text = inner["text"];
    const speechFrames = inner["speechFrames"];
    events.push({
      ts,
      kind: kind as ReplayEvent["kind"],
      ...(role === "user" || role === "agent" ? { role } : {}),
      ...(typeof text === "string" ? { text } : {}),
      ...(typeof speechFrames === "number" ? { speechFrames } : {}),
    });
  }
  // Stable sort by ts (insertion order breaks ties — Array.sort is stable in
  // modern engines, and we compare only ts so equal-ts events keep log order).
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  return { sessionId, events: sorted };
}

/** A per-turn latency record: the user utterance end → the agent's first
 *  response token, and to the agent's final transcript. */
export type TurnLatency = {
  readonly turnIndex: number;
  /** Time-to-first-token (ms): user turn end → first agent partial/audio. */
  readonly ttftMs: number | undefined;
  /** Full turn latency (ms): user turn end → agent transcript_final. */
  readonly turnLatencyMs: number | undefined;
};

/** A barge-in outcome: whether the agent yielded (emitted `interrupt`) and how
 *  long it took. */
export type BargeInOutcome = {
  readonly atMs: number;
  readonly yielded: boolean;
  readonly yieldLatencyMs: number | undefined;
};

/** The metrics distilled from one replay session. */
export type VoiceMetrics = {
  readonly sessionId: string;
  readonly turns: ReadonlyArray<TurnLatency>;
  readonly bargeIns: ReadonlyArray<BargeInOutcome>;
  /** Count of user turns that produced a non-empty agent transcript. */
  readonly answeredTurns: number;
  readonly totalUserTurns: number;
};

/**
 * Distill latency / barge-in / transcript-coverage metrics from a replay
 * session. A "user turn" opens on a user `transcript_final` (utterance end) and
 * closes at the next user `transcript_final` (or session end). Deterministic.
 */
export function computeVoiceMetrics(session: ReplaySession): VoiceMetrics {
  const turns: TurnLatency[] = [];
  const bargeIns: BargeInOutcome[] = [];
  let answeredTurns = 0;
  let totalUserTurns = 0;

  // Index user-turn boundaries.
  const userTurnEnds: number[] = [];
  for (const ev of session.events) {
    if (ev.kind === "transcript_final" && ev.role === "user") userTurnEnds.push(ev.ts);
  }

  for (let t = 0; t < userTurnEnds.length; t++) {
    totalUserTurns += 1;
    const start = userTurnEnds[t] as number;
    const nextStart =
      t + 1 < userTurnEnds.length ? (userTurnEnds[t + 1] as number) : Number.POSITIVE_INFINITY;
    let ttftMs: number | undefined;
    let turnLatencyMs: number | undefined;
    let answered = false;
    for (const ev of session.events) {
      if (ev.ts <= start || ev.ts >= nextStart) continue;
      const isAgent = ev.role !== "user";
      if (!isAgent) continue;
      if (ttftMs === undefined && (ev.kind === "transcript_partial" || ev.kind === "audio_chunk")) {
        ttftMs = ev.ts - start;
      }
      if (ev.kind === "transcript_final") {
        turnLatencyMs = ev.ts - start;
        if (typeof ev.text === "string" && ev.text.trim() !== "") answered = true;
      }
    }
    if (answered) answeredTurns += 1;
    turns.push({ turnIndex: t, ttftMs, turnLatencyMs });
  }

  // Barge-in outcomes: each barge_in must be followed by an agent `interrupt`.
  for (const ev of session.events) {
    if (ev.kind !== "barge_in") continue;
    let yieldLatencyMs: number | undefined;
    for (const other of session.events) {
      if (other.ts < ev.ts) continue;
      if (other.kind === "interrupt") {
        yieldLatencyMs = other.ts - ev.ts;
        break;
      }
    }
    bargeIns.push({
      atMs: ev.ts,
      yielded: yieldLatencyMs !== undefined,
      yieldLatencyMs,
    });
  }

  return { sessionId: session.sessionId, turns, bargeIns, answeredTurns, totalUserTurns };
}

/** A grade for one dimension of one session. Mirrors eval-grader's GradeResult. */
export type VoiceGrade = {
  readonly passed: boolean;
  readonly score: number;
  readonly rationale: string;
};

/** LATENCY grader: every turn's TTFT ≤ maxTtftMs AND response ≤ maxTurnLatencyMs. */
export function gradeLatency(metrics: VoiceMetrics, thresholds: VoiceThresholds): VoiceGrade {
  if (metrics.turns.length === 0) {
    return { passed: false, score: 0, rationale: "no user turns to measure latency" };
  }
  const violations: string[] = [];
  let ok = 0;
  for (const turn of metrics.turns) {
    const ttftOk = turn.ttftMs !== undefined && turn.ttftMs <= thresholds.maxTtftMs;
    const latOk =
      turn.turnLatencyMs !== undefined && turn.turnLatencyMs <= thresholds.maxTurnLatencyMs;
    if (ttftOk && latOk) {
      ok += 1;
    } else if (turn.ttftMs === undefined) {
      violations.push(`turn ${turn.turnIndex}: no agent response (no TTFT)`);
    } else if (!ttftOk) {
      violations.push(`turn ${turn.turnIndex}: TTFT ${turn.ttftMs}ms > ${thresholds.maxTtftMs}ms`);
    } else if (turn.turnLatencyMs === undefined) {
      violations.push(`turn ${turn.turnIndex}: no final agent transcript (turn never completed)`);
    } else {
      violations.push(
        `turn ${turn.turnIndex}: latency ${turn.turnLatencyMs}ms > ${thresholds.maxTurnLatencyMs}ms`,
      );
    }
  }
  const score = ok / metrics.turns.length;
  return {
    passed: violations.length === 0,
    score,
    rationale:
      violations.length === 0
        ? `all ${metrics.turns.length} turns within latency budget`
        : violations.join("; "),
  };
}

/** BARGE-IN grader: every barge-in must be followed by an agent yield within
 *  maxBargeInYieldMs. A session with no barge-ins passes vacuously. */
export function gradeBargeIn(metrics: VoiceMetrics, thresholds: VoiceThresholds): VoiceGrade {
  if (metrics.bargeIns.length === 0) {
    return { passed: true, score: 1, rationale: "no barge-ins in session (vacuously correct)" };
  }
  const violations: string[] = [];
  let ok = 0;
  for (const b of metrics.bargeIns) {
    if (!b.yielded) {
      violations.push(`barge-in @${b.atMs}ms: agent never yielded`);
    } else if ((b.yieldLatencyMs as number) > thresholds.maxBargeInYieldMs) {
      violations.push(
        `barge-in @${b.atMs}ms: yielded after ${b.yieldLatencyMs}ms > ${thresholds.maxBargeInYieldMs}ms`,
      );
    } else {
      ok += 1;
    }
  }
  return {
    passed: violations.length === 0,
    score: ok / metrics.bargeIns.length,
    rationale:
      violations.length === 0
        ? `all ${metrics.bargeIns.length} barge-ins yielded within ${thresholds.maxBargeInYieldMs}ms`
        : violations.join("; "),
  };
}

/** TRANSCRIPT grader: every user turn should produce a non-empty agent
 *  response transcript. Coverage = answered / total. */
export function gradeTranscript(metrics: VoiceMetrics): VoiceGrade {
  if (metrics.totalUserTurns === 0) {
    return { passed: false, score: 0, rationale: "no user turns in session" };
  }
  const coverage = metrics.answeredTurns / metrics.totalUserTurns;
  return {
    passed: metrics.answeredTurns === metrics.totalUserTurns,
    score: coverage,
    rationale: `${metrics.answeredTurns}/${metrics.totalUserTurns} user turns got a non-empty agent transcript`,
  };
}

/** The three voice graders, by name — the registry-style pack. */
export const VOICE_GRADER_NAMES = ["voice_latency", "voice_barge_in", "voice_transcript"] as const;

/** D46 — one content grader's verdict on a replayed session's transcript. */
export type VoiceContentGrade = {
  readonly grader: string;
  readonly passed: boolean;
  readonly score: number;
  readonly rationale: string;
};

/** A per-session voice eval result — the three grades + the raw metrics. */
export type VoiceSessionResult = {
  readonly sessionId: string;
  readonly metrics: VoiceMetrics;
  readonly grades: {
    readonly voice_latency: VoiceGrade;
    readonly voice_barge_in: VoiceGrade;
    readonly voice_transcript: VoiceGrade;
  };
  /**
   * D46 — content grades from a `--graders` file, when one was passed. A
   * voice agent's primary failure mode is WHAT it says; latency and
   * barge-in are plumbing. Absent without `--graders`, so today's voice
   * eval output is byte-identical.
   */
  readonly contentGrades?: ReadonlyArray<VoiceContentGrade>;
  readonly passed: boolean;
};

/** Grade one replay session across all three dimensions. */
export function gradeVoiceSession(
  session: ReplaySession,
  thresholds: VoiceThresholds = DEFAULT_VOICE_THRESHOLDS,
): VoiceSessionResult {
  const metrics = computeVoiceMetrics(session);
  const latency = gradeLatency(metrics, thresholds);
  const bargeIn = gradeBargeIn(metrics, thresholds);
  const transcript = gradeTranscript(metrics);
  return {
    sessionId: session.sessionId,
    metrics,
    grades: { voice_latency: latency, voice_barge_in: bargeIn, voice_transcript: transcript },
    passed: latency.passed && bargeIn.passed && transcript.passed,
  };
}

/**
 * D46 — project a replayed session onto the standard grader contract so the
 * WHOLE grader stack (deterministic graders, registry packs, `llm_judge`
 * rubrics) can score what the agent actually SAID.
 *
 * The projection is deliberately literal: the graded output is the agent's
 * final transcripts in order, and the sample input is the user's — a replay
 * carries no gold, so graders that need `expected_output` (exact_match,
 * expected_contains) have nothing to compare against and say so honestly
 * rather than being fed a fabricated reference. `events`/`transcript`/
 * `toolCalls` are empty: a replay log is a call timeline, not a chat-loop
 * trace, and inventing trace events would let trajectory graders "pass" on
 * evidence that does not exist.
 */
export function voiceSampleFromSession(session: ReplaySession): {
  sample: Sample;
  run: RunResult;
} {
  const textsOf = (role: "user" | "agent"): string[] =>
    session.events
      .filter(
        (e) =>
          e.kind === "transcript_final" &&
          (role === "user" ? e.role === "user" : e.role !== "user") &&
          typeof e.text === "string" &&
          e.text.trim() !== "",
      )
      .map((e) => (e.text as string).trim());
  const first = session.events[0];
  const last = session.events[session.events.length - 1];
  const agentTurns = textsOf("agent");
  return {
    sample: { id: session.sessionId, input: textsOf("user").join("\n") },
    run: {
      agentOutput: agentTurns.join("\n"),
      events: [],
      transcript: [],
      toolCalls: [],
      turns: agentTurns.length,
      latencyMs: first !== undefined && last !== undefined ? last.ts - first.ts : 0,
    },
  };
}

/** D46 — one named content grader (already constructed by the caller, which
 *  owns judge/registry wiring). `weight` rides along for `combine: weighted`
 *  (A4/A5), defaulting to 1 exactly like the text eval. */
export type VoiceContentGrader = {
  readonly name: string;
  readonly grader: Grader;
  readonly weight?: number;
};

/**
 * D46 — run the content graders over a session's transcript. A grader that
 * THROWS (judge 429, rubric fetch failure) records a failed grade naming the
 * throw rather than aborting the whole voice eval: one flaky judge call must
 * not lose the latency verdicts for every other session — and the session
 * still fails, so a broken instrument can never read as a pass.
 */
export async function gradeVoiceContent(
  session: ReplaySession,
  graders: ReadonlyArray<VoiceContentGrader>,
): Promise<VoiceContentGrade[]> {
  const { sample, run } = voiceSampleFromSession(session);
  const grades: VoiceContentGrade[] = [];
  for (const { name, grader } of graders) {
    try {
      const result = await grader(sample, run);
      grades.push({
        grader: name,
        passed: result.passed,
        score: result.score,
        rationale: result.rationale,
      });
    } catch (err) {
      grades.push({
        grader: name,
        passed: false,
        score: 0,
        rationale: `grader threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return grades;
}

/**
 * A4/A5 — fold the content grades into ONE content verdict under the
 * graders.yaml `combine:` policy, with the same semantics `run-sample.ts`
 * applies to a text eval:
 *   all       (default) passed = AND of graders, score = unweighted mean.
 *   any       passed = OR of graders, score = max.
 *   weighted  score = Σ(w·s)/Σw; passed iff score ≥ passing_threshold (0.5).
 * A voice run that parses the full grammar must OBEY it — the silent ignore
 * (parse `combine: any`, then hardcode all-must-pass) is precisely the trust
 * hole A4/A5 closed on every other grading surface.
 */
export function combineVoiceContentGrades(
  grades: ReadonlyArray<VoiceContentGrade>,
  graders: ReadonlyArray<VoiceContentGrader>,
  policy: GraderCombinePolicy | undefined,
): { passed: boolean; score: number } {
  if (grades.length === 0) return { passed: true, score: 0 };
  switch (policy?.mode ?? "all") {
    case "any":
      return {
        passed: grades.some((g) => g.passed),
        score: Math.max(...grades.map((g) => g.score)),
      };
    case "weighted": {
      const weights = grades.map((g) => graders.find((c) => c.name === g.grader)?.weight ?? 1);
      const totalWeight = weights.reduce((s, w) => s + w, 0);
      const score =
        totalWeight === 0
          ? 0
          : grades.reduce((s, g, i) => s + g.score * (weights[i] ?? 1), 0) / totalWeight;
      return { passed: score >= (policy?.passingThreshold ?? 0.5), score };
    }
    default:
      return {
        passed: grades.every((g) => g.passed),
        score: grades.reduce((s, g) => s + g.score, 0) / grades.length,
      };
  }
}

/**
 * D46 — grade a session on latency/barge-in/transcript AND content. Content
 * failures fail the session exactly like a latency breach does (the command
 * exits non-zero on any failing session), because "answered fast and wrong"
 * is not a passing voice agent. Without graders this is `gradeVoiceSession`.
 *
 * A4/A5 — `combine` is the graders.yaml top-level policy (compiled onto
 * every entry). Absent ⇒ `all`, today's byte-identical semantics.
 */
export async function gradeVoiceSessionWithContent(
  session: ReplaySession,
  thresholds: VoiceThresholds,
  graders: ReadonlyArray<VoiceContentGrader>,
  opts: { readonly combine?: GraderCombinePolicy } = {},
): Promise<VoiceSessionResult> {
  const base = gradeVoiceSession(session, thresholds);
  if (graders.length === 0) return base;
  const contentGrades = await gradeVoiceContent(session, graders);
  const combined = combineVoiceContentGrades(contentGrades, graders, opts.combine);
  return {
    ...base,
    contentGrades,
    passed: base.passed && combined.passed,
  };
}

/** Aggregate summary across a replay set. */
export type VoiceEvalSummary = {
  readonly sessions: ReadonlyArray<VoiceSessionResult>;
  readonly passRate: number;
  readonly p50TtftMs: number | undefined;
  readonly p95TtftMs: number | undefined;
  readonly bargeInYieldRate: number;
  /**
   * D46 — (session × content grader) verdicts recorded. ABSENT (not 0)
   * without `--graders`, so a no-graders `voice-eval.json` is byte-identical
   * to the pre-D46 artifact — the same presence-gating every other additive
   * eval field uses (`flaky`, `judgeUsage`, `cliVersion`, `contentGrades`).
   */
  readonly contentGraded?: number;
  /** D46 — how many of those passed. Present iff {@link contentGraded} is. */
  readonly contentPassed?: number;
};

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Aggregate per-session results into a run summary. */
export function aggregateVoiceEval(results: ReadonlyArray<VoiceSessionResult>): VoiceEvalSummary {
  const passed = results.filter((r) => r.passed).length;
  const ttfts: number[] = [];
  let bargeInTotal = 0;
  let bargeInYielded = 0;
  for (const r of results) {
    for (const turn of r.metrics.turns) {
      if (turn.ttftMs !== undefined) ttfts.push(turn.ttftMs);
    }
    for (const b of r.metrics.bargeIns) {
      bargeInTotal += 1;
      if (b.yielded) bargeInYielded += 1;
    }
  }
  // D46 — content verdicts across every session. Presence-gated: a run
  // without --graders writes no content keys at all.
  const contentGrades = results.flatMap((r) => r.contentGrades ?? []);
  return {
    sessions: results,
    passRate: results.length === 0 ? 0 : passed / results.length,
    p50TtftMs: percentile(ttfts, 50),
    p95TtftMs: percentile(ttfts, 95),
    bargeInYieldRate: bargeInTotal === 0 ? 1 : bargeInYielded / bargeInTotal,
    ...(contentGrades.length > 0
      ? {
          contentGraded: contentGrades.length,
          contentPassed: contentGrades.filter((g) => g.passed).length,
        }
      : {}),
  };
}

/** Render a plain-text report of a voice eval run. */
export function renderVoiceReport(summary: VoiceEvalSummary): string {
  const lines: string[] = [];
  lines.push(`voice eval: ${summary.sessions.length} session(s)`);
  lines.push(`  pass rate:          ${(summary.passRate * 100).toFixed(0)}%`);
  lines.push(`  TTFT p50 / p95:     ${fmtMs(summary.p50TtftMs)} / ${fmtMs(summary.p95TtftMs)}`);
  lines.push(`  barge-in yield rate: ${(summary.bargeInYieldRate * 100).toFixed(0)}%`);
  if (summary.contentGraded !== undefined && summary.contentGraded > 0) {
    lines.push(
      `  content graders:    ${summary.contentPassed ?? 0}/${summary.contentGraded} session-grader verdicts passed`,
    );
  }
  for (const r of summary.sessions) {
    lines.push(`  ${r.passed ? "PASS" : "FAIL"} ${r.sessionId}`);
    if (!r.grades.voice_latency.passed) {
      lines.push(`    latency:    ${r.grades.voice_latency.rationale}`);
    }
    if (!r.grades.voice_barge_in.passed) {
      lines.push(`    barge-in:   ${r.grades.voice_barge_in.rationale}`);
    }
    if (!r.grades.voice_transcript.passed) {
      lines.push(`    transcript: ${r.grades.voice_transcript.rationale}`);
    }
    // D46 — content verdicts: failures always, passes tallied (a green
    // content grader is the reason to trust the whole line).
    for (const g of r.contentGrades ?? []) {
      if (!g.passed) lines.push(`    content ${g.grader}: ${g.rationale}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function fmtMs(ms: number | undefined): string {
  return ms === undefined ? "n/a" : `${ms}ms`;
}
