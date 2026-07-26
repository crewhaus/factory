/**
 * E51 / NEW-E-2 — dedicated OTel span mappings for the in-loop evaluation
 * verdicts (`eval_graded`, `judge_verdict`). Before this they fell into the
 * SpanTracker's generic `crewhaus.<kind>` fallback, so a trace backend saw
 * the score only as an untyped blob and could not alert on it.
 */
import { describe, expect, test } from "bun:test";
import type { EvalGradedEvent, JudgeVerdictEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { ATTR, buildEvalGradedSpan, buildJudgeVerdictSpan } from "./gen-ai-mapping";
import { SpanTracker } from "./span-tracker";
import { STATUS_ERROR, STATUS_OK } from "./types";

const env = (overrides: Record<string, unknown> = {}) => ({
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 2,
  traceId: `${"0".repeat(31)}1`,
  spanId: `${"0".repeat(15)}1`,
  timestamp: "2026-07-26T12:00:00.000Z",
  ...overrides,
});

const attrOf = (attrs: ReadonlyArray<{ key: string; value: unknown }>, key: string) =>
  attrs.find((a) => a.key === key)?.value as Record<string, unknown> | undefined;

describe("buildEvalGradedSpan", () => {
  test("a passing grade is an OK point-in-time span with typed attributes", () => {
    const ev = {
      ...env(),
      kind: "eval_graded",
      score: 0.92,
      threshold: 0.7,
      verdict: "pass",
      graderType: "llm_judge",
      retryIndex: 0,
      maxRetries: 2,
    } as EvalGradedEvent;
    const span = buildEvalGradedSpan(ev);
    expect(span.name).toBe("eval_graded.pass");
    expect(span.status.code).toBe(STATUS_OK);
    expect(span.startTimeUnixNano).toBe(span.endTimeUnixNano);
    expect(attrOf(span.attributes, ATTR.CREWHAUS_EVAL_SCORE)).toEqual({ doubleValue: 0.92 });
    expect(attrOf(span.attributes, ATTR.CREWHAUS_EVAL_THRESHOLD)).toEqual({ doubleValue: 0.7 });
    expect(attrOf(span.attributes, ATTR.CREWHAUS_EVAL_VERDICT)).toEqual({ stringValue: "pass" });
    expect(attrOf(span.attributes, ATTR.CREWHAUS_EVAL_GRADER_TYPE)).toEqual({
      stringValue: "llm_judge",
    });
    expect(attrOf(span.attributes, ATTR.CREWHAUS_EVAL_RETRY_INDEX)).toEqual({ intValue: "0" });
    expect(attrOf(span.attributes, ATTR.CREWHAUS_EVAL_MAX_RETRIES)).toEqual({ intValue: "2" });
  });

  test("a failing grade carries ERROR status and a message naming the shortfall", () => {
    const span = buildEvalGradedSpan({
      ...env(),
      kind: "eval_graded",
      score: 0.2,
      threshold: 0.8,
      verdict: "fail",
      graderType: "contains",
      retryIndex: 1,
    } as EvalGradedEvent);
    expect(span.name).toBe("eval_graded.fail");
    expect(span.status.code).toBe(STATUS_ERROR);
    expect(span.status.message).toContain("contains scored 0.20");
    expect(span.status.message).toContain("0.80");
    // maxRetries is optional on the event (older sidecars omit it).
    expect(attrOf(span.attributes, ATTR.CREWHAUS_EVAL_MAX_RETRIES)).toBeUndefined();
  });
});

describe("buildJudgeVerdictSpan", () => {
  test("a passing judge step is an OK span", () => {
    const span = buildJudgeVerdictSpan({
      ...env(),
      kind: "judge_verdict",
      stepOrNode: "quality-gate",
      verdict: "pass",
      score: 0.88,
    } as JudgeVerdictEvent);
    expect(span.name).toBe("judge_verdict.pass");
    expect(span.status.code).toBe(STATUS_OK);
    expect(attrOf(span.attributes, ATTR.CREWHAUS_JUDGE_AT)).toEqual({
      stringValue: "quality-gate",
    });
    expect(attrOf(span.attributes, ATTR.CREWHAUS_JUDGE_SCORE)).toEqual({ doubleValue: 0.88 });
    expect(attrOf(span.attributes, ATTR.CREWHAUS_JUDGE_RATIONALE)).toBeUndefined();
  });

  test("a failing judge step carries ERROR status and the rationale", () => {
    const span = buildJudgeVerdictSpan({
      ...env(),
      kind: "judge_verdict",
      stepOrNode: "quality-gate",
      verdict: "fail",
      score: 0.1,
      rationale: "the draft never cites a source",
    } as JudgeVerdictEvent);
    expect(span.status.code).toBe(STATUS_ERROR);
    expect(span.status.message).toBe("the draft never cites a source");
    expect(attrOf(span.attributes, ATTR.CREWHAUS_JUDGE_RATIONALE)).toEqual({
      stringValue: "the draft never cites a source",
    });
  });
});

describe("SpanTracker routing", () => {
  const tracked = () => {
    const spans: ReturnType<typeof buildEvalGradedSpan>[] = [];
    return { tracker: new SpanTracker((s) => spans.push(s)), spans };
  };

  test("eval_graded and judge_verdict no longer reach the generic fallback", () => {
    const { tracker, spans } = tracked();
    tracker.ingest({
      ...env(),
      kind: "eval_graded",
      score: 1,
      threshold: 1,
      verdict: "pass",
      graderType: "regex",
      retryIndex: 0,
    } as TraceEvent);
    tracker.ingest({
      ...env(),
      kind: "judge_verdict",
      stepOrNode: "gate",
      verdict: "fail",
      score: 0.3,
    } as TraceEvent);
    expect(spans.map((s) => s.name)).toEqual(["eval_graded.pass", "judge_verdict.fail"]);
    expect(spans.some((s) => s.name.startsWith("crewhaus."))).toBe(false);
  });
});
