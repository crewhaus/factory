/**
 * Unit tests for the item-17 `doctor --context-pressure` core: the event
 * fold (truncation continues, compaction fires per session, snip vs
 * autocompact), the spec-knob surface, the advise-threshold trips + exact
 * command hints, and the report formatting. Pure — no filesystem, no model.
 */
import { describe, expect, test } from "bun:test";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { DEFAULT_ADVICE_THRESHOLDS, type SessionEvents } from "./advise-rules";
import {
  CONTEXT_PRESSURE_COMMANDS,
  DEFAULT_CONTEXT_PRESSURE_SESSIONS,
  buildContextPressureReport,
  formatContextPressureLines,
} from "./context-pressure";

function line(kind: string, payload: unknown): unknown {
  return { ts: 1, version: 1, kind, payload };
}

function session(sessionId: string, objects: unknown[]): SessionEvents {
  return { sessionId, objects };
}

function specOf(yaml: string): Spec {
  return parseSpec(yaml);
}

const QUIET = [
  line("user_message", { content: "q" }),
  line("assistant_message", { content: [{ type: "text", text: "a" }] }),
];

describe("buildContextPressureReport", () => {
  test("zero sessions → healthy report, no commands", () => {
    const report = buildContextPressureReport([]);
    expect(report.sessionCount).toBe(0);
    expect(report.truncationContinues).toBe(0);
    expect(report.compactionTotal).toBe(0);
    expect(report.avgCompactionsPerSession).toBe(0);
    expect(report.snipRatio).toBeUndefined();
    expect(report.tripped).toEqual([]);
    expect(report.commands).toEqual([]);
    expect(report.spec.present).toBe(false);
  });

  test("counts continue-recoveries as truncation pressure; retry/compact don't count", () => {
    const report = buildContextPressureReport([
      session("sess_a", [
        ...QUIET,
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 1 }),
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 2 }),
        line("recovery", { errorName: "RateLimitError", action: "retry", depth: 1 }),
        line("recovery", { errorName: "ContextWindowError", action: "compact", depth: 1 }),
      ]),
    ]);
    expect(report.truncationContinues).toBe(2);
    // ≥ DEFAULT_ADVICE_THRESHOLDS.truncationContinues (2) → tripped.
    expect(report.tripped).toEqual(["truncation-pressure"]);
    expect(report.commands).toEqual([...CONTEXT_PRESSURE_COMMANDS]);
  });

  test("compaction fires: total/avg/max per session + snip-vs-autocompact ratio", () => {
    const report = buildContextPressureReport([
      session("sess_a", [
        line("compaction", { kind: "snip", before: 40, after: 30 }),
        line("compaction", { kind: "snip", before: 44, after: 30 }),
        line("compaction", { kind: "autocompact", before: 50, after: 10 }),
      ]),
      session("sess_b", [line("compaction", { kind: "reactive", before: 60, after: 12 })]),
      session("sess_c", QUIET),
      session("sess_d", QUIET),
    ]);
    expect(report.compactionTotal).toBe(4);
    expect(report.sessionsWithCompaction).toBe(2);
    expect(report.avgCompactionsPerSession).toBe(1);
    expect(report.maxCompactionsPerSession).toBe(3);
    expect(report.maxCompactionSessionId).toBe("sess_a");
    expect(report.compactionKinds).toEqual({ snip: 2, autocompact: 1, reactive: 1, unknown: 0 });
    expect(report.snipRatio).toBeCloseTo(0.5);
    // 3 in one session ≥ compactionsPerSession (3) → thrash tripped.
    expect(report.tripped).toEqual(["compaction-thrash"]);
  });

  test("kind-untagged compaction events count but leave the ratio underivable", () => {
    const report = buildContextPressureReport([
      session("sess_a", [line("compaction", { before: 40, after: 30 })]),
    ]);
    expect(report.compactionTotal).toBe(1);
    expect(report.compactionKinds.unknown).toBe(1);
    expect(report.snipRatio).toBeUndefined();
  });

  test("below-threshold pressure stays healthy (uses the advise thresholds)", () => {
    const report = buildContextPressureReport([
      session("sess_a", [
        line("recovery", { action: "continue" }),
        line("compaction", { kind: "snip", before: 4, after: 2 }),
        line("compaction", { kind: "snip", before: 4, after: 2 }),
      ]),
    ]);
    expect(report.truncationContinues).toBe(1);
    expect(DEFAULT_ADVICE_THRESHOLDS.truncationContinues).toBeGreaterThan(1);
    expect(report.tripped).toEqual([]);
    expect(report.commands).toEqual([]);
  });

  test("threshold overrides are honored", () => {
    const report = buildContextPressureReport(
      [session("sess_a", [line("recovery", { action: "continue" })])],
      { thresholds: { truncationContinues: 1 } },
    );
    expect(report.tripped).toEqual(["truncation-pressure"]);
  });

  test("surfaces the spec's max_tokens and compaction knobs", () => {
    const spec = specOf(
      [
        "name: hello",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: help",
        "  max_tokens: 4096",
        "compaction:",
        "  curate: true",
        "  dedupeThreshold: 0.9",
        "  relevanceTopK: 12",
        "",
      ].join("\n"),
    );
    const report = buildContextPressureReport([], { spec });
    expect(report.spec).toEqual({
      present: true,
      maxTokens: 4096,
      compactionCurate: true,
      compactionDedupeThreshold: 0.9,
      compactionRelevanceTopK: 12,
    });
  });

  test("old-vintage logs (no advisor kinds) and malformed payloads fold cleanly", () => {
    const report = buildContextPressureReport([
      session("sess_a", [
        ...QUIET,
        line("tool_use", { id: "tu_1", name: "Fetch", input: {} }),
        line("recovery", "not-an-object"),
        { notALoggedLine: true },
        null,
      ]),
    ]);
    expect(report.truncationContinues).toBe(0);
    expect(report.compactionTotal).toBe(0);
    expect(report.tripped).toEqual([]);
  });

  test("default session window constant is 20", () => {
    expect(DEFAULT_CONTEXT_PRESSURE_SESSIONS).toBe(20);
  });
});

describe("formatContextPressureLines", () => {
  test("tripped report prints the exact advise/optimize command hints", () => {
    const report = buildContextPressureReport([
      session("sess_a", [
        line("recovery", { action: "continue" }),
        line("recovery", { action: "continue" }),
        line("compaction", { kind: "snip", before: 4, after: 2 }),
      ]),
    ]);
    const text = formatContextPressureLines(report).join("\n");
    expect(text).toContain("truncation recoveries: 2 max_output_tokens continue(s)");
    expect(text).toContain("pressure:              truncation-pressure tripped");
    expect(text).toContain("crewhaus advise --all -o .");
    expect(text).toContain(
      "crewhaus optimize crewhaus.yaml --from-advice suggestions.json --write-back --dataset eval/dataset.jsonl --graders eval/graders.yaml",
    );
    expect(text).toContain("100% free snips");
  });

  test("healthy report has no next-commands and says so", () => {
    const text = formatContextPressureLines(buildContextPressureReport([])).join("\n");
    expect(text).toContain("healthy — no advise thresholds tripped");
    expect(text).not.toContain("crewhaus advise");
    expect(text).toContain("not derivable (no kind-tagged compaction events)");
    expect(text).toContain("no parseable crewhaus.yaml in cwd");
  });

  test("spec lines render defaults and explicit knobs distinctly", () => {
    const bare = specOf(
      ["name: h", "target: cli", "agent:", "  model: m", "  instructions: i", ""].join("\n"),
    );
    const bareText = formatContextPressureLines(
      buildContextPressureReport([], { spec: bare }),
    ).join("\n");
    expect(bareText).toContain("spec agent.max_tokens: not set (runtime default 8192)");
    expect(bareText).toContain("spec compaction.curate: off (default)");

    const tuned = specOf(
      [
        "name: h",
        "target: cli",
        "agent:",
        "  model: m",
        "  instructions: i",
        "  max_tokens: 16384",
        "compaction:",
        "  curate: false",
        "",
      ].join("\n"),
    );
    const tunedText = formatContextPressureLines(
      buildContextPressureReport([], { spec: tuned }),
    ).join("\n");
    expect(tunedText).toContain("spec agent.max_tokens: 16384");
    expect(tunedText).toContain("spec compaction.curate: off (explicit)");
  });
});
