/**
 * Unit tests for the item-15 `optimize --from-advice` core: suggestions-file
 * validation, the flag-exclusivity guard, the gate-pass acceptance semantics
 * (equal-or-better with zero regressions — strict improvement NOT required),
 * and the accept/reject/compose loop with injected compile/eval hooks — no
 * LLM/credentials needed anywhere in this file.
 */
import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { parseWriteBackHeader } from "@crewhaus/spec-patch";
import {
  AdviceApplyError,
  type AdviceApplyHooks,
  type ParsedAdvicePatch,
  applyAdvicePatches,
  assertFromAdviceFlagsCompatible,
  buildAdviceDecisionsFile,
  evaluateAdvicePatchAcceptance,
  formatAdviceDecisionLine,
  parseSuggestionsFile,
  patchLabel,
  stampAdviceWriteBack,
} from "./advice-apply";

// -------- fixtures --------

const SOURCE_YAML = [
  "name: hello",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: help",
  "",
].join("\n");

const MAX_TOKENS_PATCH: ParsedAdvicePatch = {
  findingId: "truncation-pressure",
  summary: "2 max_output_tokens truncation recoveries",
  patch: {
    target: "cli",
    path: ["agent", "max_tokens"],
    op: "add",
    value: 16384,
    rationale: "advise: 2 max_output_tokens truncation recoveries observed",
  },
};

const CURATE_PATCH: ParsedAdvicePatch = {
  findingId: "compaction-thrash",
  patch: { target: "cli", path: ["compaction", "curate"], op: "add", value: true },
};

function makeSample(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-07-02T00:00:00Z",
    endedAt: "2026-07-02T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-sonnet-4-6",
    agentOutput: passed ? "correct" : "wrong",
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "wrong answer" },
      perGrader: [{ name: "contains", passed, score, rationale: "" }],
    },
  };
}

function makeSummary(runId: string, samples: SampleResult[]): EvalRunSummary {
  const passRate =
    samples.length === 0
      ? Number.NaN
      : samples.filter((s) => s.grades.overall.passed).length / samples.length;
  return {
    runId,
    startedAt: "2026-07-02T00:00:00Z",
    endedAt: "2026-07-02T00:00:30Z",
    samples,
    aggregates: {
      passRate,
      meanScore:
        samples.length === 0
          ? Number.NaN
          : samples.reduce((sum, s) => sum + s.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10 * samples.length, output: 20 * samples.length },
      errorCount: 0,
    },
    config: {
      specHash: "abc123",
      datasetName: "smoke",
      graderNames: ["contains"],
      model: "claude-sonnet-4-6",
      concurrency: 1,
    },
    outDir: `/tmp/advice-test/${runId}`,
  };
}

const ALL_PASS = [makeSample("s1", true, 1), makeSample("s2", true, 1)];
const ONE_FAIL = [makeSample("s1", true, 1), makeSample("s2", false, 0)];
const OTHER_FAIL = [makeSample("s1", false, 0), makeSample("s2", true, 1)];

/** Hooks that log calls and serve per-label summaries (default: all-pass). */
function makeHooks(opts: {
  log: string[];
  yamlByLabel?: Map<string, string>;
  summaries?: Record<string, EvalRunSummary>;
  failCompileFor?: string;
}): AdviceApplyHooks {
  return {
    compileCheck: (_yaml, label) => {
      opts.log.push(`compile:${label}`);
      if (opts.failCompileFor === label) throw new Error("bad candidate yaml");
    },
    evalRun: async (label, yaml) => {
      opts.log.push(`eval:${label}`);
      opts.yamlByLabel?.set(label, yaml);
      return opts.summaries?.[label] ?? makeSummary(label, ALL_PASS);
    },
  };
}

// -------- suggestions-file validation --------

describe("parseSuggestionsFile", () => {
  test("parses a valid advise suggestions.json into patches", () => {
    const text = JSON.stringify({
      generatedAt: "2026-07-02T00:00:00Z",
      sessionIds: ["sess_00000000000000ad"],
      suggestions: [
        {
          findingId: "truncation-pressure",
          severity: "warn",
          summary: "2 truncation recoveries",
          patch: MAX_TOKENS_PATCH.patch,
        },
        { findingId: "compaction-thrash", severity: "warn", patch: CURATE_PATCH.patch },
      ],
    });
    const patches = parseSuggestionsFile(text);
    expect(patches).toHaveLength(2);
    expect(patches[0]?.findingId).toBe("truncation-pressure");
    expect(patches[0]?.summary).toBe("2 truncation recoveries");
    expect(patches[0]?.patch).toEqual(MAX_TOKENS_PATCH.patch);
    expect(patches[1]?.patch.path).toEqual(["compaction", "curate"]);
  });

  test("rejects non-JSON and non-suggestions shapes at the file level", () => {
    expect(() => parseSuggestionsFile("not json {")).toThrow(AdviceApplyError);
    expect(() => parseSuggestionsFile("not json {")).toThrow(/not valid JSON/);
    expect(() => parseSuggestionsFile('{"findings": []}')).toThrow(/"suggestions" array/);
    expect(() => parseSuggestionsFile('["bare", "array"]')).toThrow(/"suggestions" array/);
  });

  test("rejects invalid patches with a clear per-entry error", () => {
    const withPatch = (patch: unknown, findingId?: string): string =>
      JSON.stringify({
        suggestions: [{ ...(findingId !== undefined ? { findingId } : {}), patch }],
      });
    expect(() => parseSuggestionsFile(JSON.stringify({ suggestions: ["x"] }))).toThrow(
      /suggestions\[0\] must be an object/,
    );
    expect(() => parseSuggestionsFile(withPatch(undefined))).toThrow(
      /suggestions\[0\]: patch must be an object/,
    );
    expect(() =>
      parseSuggestionsFile(withPatch({ target: "cli", path: [], op: "add", value: 1 })),
    ).toThrow(/patch\.path must be a non-empty array/);
    expect(() =>
      parseSuggestionsFile(
        withPatch({ target: "cli", path: ["agent", "max_tokens"], op: "bump", value: 1 }, "t-p"),
      ),
    ).toThrow(/suggestions\[0\] \(t-p\): patch\.op must be one of replace\|add\|remove/);
    expect(() =>
      parseSuggestionsFile(withPatch({ target: "cli", path: ["agent", "max_tokens"], op: "add" })),
    ).toThrow(/patch\.value is required for op "add"/);
    expect(() =>
      parseSuggestionsFile(withPatch({ target: "", path: ["a"], op: "remove" })),
    ).toThrow(/patch\.target must be a non-empty string/);
  });

  test("op remove needs no value; an empty suggestions list parses to []", () => {
    const removeOnly = JSON.stringify({
      suggestions: [{ patch: { target: "cli", path: ["agent", "max_tokens"], op: "remove" } }],
    });
    expect(parseSuggestionsFile(removeOnly)).toHaveLength(1);
    expect(parseSuggestionsFile(JSON.stringify({ suggestions: [] }))).toEqual([]);
  });
});

// -------- flag exclusivity --------

describe("assertFromAdviceFlagsCompatible", () => {
  test("passes when neither search knob is set", () => {
    expect(() =>
      assertFromAdviceFlagsCompatible({ mutator: false, iterations: false }),
    ).not.toThrow();
  });

  test("rejects --mutator and --iterations by name", () => {
    expect(() => assertFromAdviceFlagsCompatible({ mutator: true, iterations: false })).toThrow(
      /--from-advice is mutually exclusive with --mutator/,
    );
    expect(() => assertFromAdviceFlagsCompatible({ mutator: false, iterations: true })).toThrow(
      /--from-advice is mutually exclusive with --iterations/,
    );
  });
});

// -------- acceptance semantics --------

describe("evaluateAdvicePatchAcceptance", () => {
  test("EQUAL pass rate with zero regressions ACCEPTS (config-patch semantics)", () => {
    const v = evaluateAdvicePatchAcceptance(
      makeSummary("before", ALL_PASS),
      makeSummary("after", ALL_PASS),
    );
    expect(v.accepted).toBe(true);
    expect(v.reason).toContain("held at 100.0%");
    expect(v.reason).toContain("strict improvement not required");
    expect(v.regressions).toBe(0);
  });

  test("strict improvement accepts with the delta in the reason", () => {
    const v = evaluateAdvicePatchAcceptance(
      makeSummary("before", ONE_FAIL),
      makeSummary("after", ALL_PASS),
    );
    expect(v.accepted).toBe(true);
    expect(v.reason).toContain("50.0% → 100.0%");
    expect(v.recoveries).toBe(1);
  });

  test("any pass-rate drop rejects", () => {
    const v = evaluateAdvicePatchAcceptance(
      makeSummary("before", ALL_PASS),
      makeSummary("after", ONE_FAIL),
    );
    expect(v.accepted).toBe(false);
    expect(v.regressions).toBe(1);
  });

  test("a flat pass rate hiding a sample flip rejects (strict gate)", () => {
    const v = evaluateAdvicePatchAcceptance(
      makeSummary("before", ONE_FAIL),
      makeSummary("after", OTHER_FAIL),
    );
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain("sample regressions despite a flat pass rate");
    expect(v.regressions).toBe(1);
    expect(v.recoveries).toBe(1);
  });

  test("incomparable (NaN) pass rates reject fail-closed", () => {
    const v = evaluateAdvicePatchAcceptance(
      makeSummary("before", []),
      makeSummary("after", ALL_PASS),
    );
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain("fail-closed");
  });
});

// -------- the loop: accept/reject/compose --------

describe("applyAdvicePatches", () => {
  test("baseline runs ONCE; accepted patches compose onto one final spec", async () => {
    const log: string[] = [];
    const yamlByLabel = new Map<string, string>();
    const result = await applyAdvicePatches({
      sourceYaml: SOURCE_YAML,
      patches: [MAX_TOKENS_PATCH, CURATE_PATCH],
      hooks: makeHooks({ log, yamlByLabel }),
    });
    expect(log).toEqual([
      "compile:baseline",
      "eval:baseline",
      "compile:patch-001",
      "eval:patch-001",
      "compile:patch-002",
      "eval:patch-002",
    ]);
    // Patch 2's candidate was built ON TOP of accepted patch 1.
    expect(yamlByLabel.get("patch-002")).toContain("max_tokens: 16384");
    expect(result.accepted).toBe(2);
    expect(result.decisions.map((d) => d.status)).toEqual(["accepted", "accepted"]);
    expect(result.finalYaml).toContain("max_tokens: 16384");
    expect(result.finalYaml).toContain("curate: true");
    expect(result.finalSummary?.runId).toBe("patch-002");
    expect(result.decisions[0]?.evalDir).toBe("/tmp/advice-test/patch-001");
    expect(result.decisions[0]?.passRateBefore).toBe(1);
    expect(result.decisions[0]?.passRateAfter).toBe(1);
  });

  test("a rejected patch never enters the accumulation; later patches apply on the source", async () => {
    const log: string[] = [];
    const yamlByLabel = new Map<string, string>();
    const result = await applyAdvicePatches({
      sourceYaml: SOURCE_YAML,
      patches: [MAX_TOKENS_PATCH, CURATE_PATCH],
      hooks: makeHooks({
        log,
        yamlByLabel,
        summaries: {
          baseline: makeSummary("baseline", ALL_PASS),
          // Patch 1 regresses a sample → rejected.
          "patch-001": makeSummary("patch-001", ONE_FAIL),
          "patch-002": makeSummary("patch-002", ALL_PASS),
        },
      }),
    });
    expect(result.accepted).toBe(1);
    expect(result.decisions[0]?.status).toBe("rejected");
    expect(result.decisions[0]?.passRateAfter).toBe(0.5);
    expect(result.decisions[1]?.status).toBe("accepted");
    // Patch 2 was applied on the UNTOUCHED source (patch 1 never landed).
    expect(yamlByLabel.get("patch-002")).not.toContain("max_tokens");
    expect(result.finalYaml).toContain("curate: true");
    expect(result.finalYaml).not.toContain("max_tokens");
    expect(result.finalSummary?.runId).toBe("patch-002");
  });

  test("non-whitelisted and cross-target patches reject WITHOUT spending an eval", async () => {
    const log: string[] = [];
    const result = await applyAdvicePatches({
      sourceYaml: SOURCE_YAML,
      patches: [
        {
          findingId: "sneaky",
          patch: { target: "cli", path: ["permissions", "mode"], op: "add", value: "auto" },
        },
        { patch: { target: "pipeline", path: ["agent", "max_tokens"], op: "add", value: 1 } },
      ],
      hooks: makeHooks({ log }),
    });
    expect(result.accepted).toBe(0);
    expect(result.decisions[0]?.status).toBe("rejected");
    expect(result.decisions[0]?.reason).toContain("OPTIMIZABLE_PATHS");
    expect(result.decisions[1]?.reason).toContain('does not match spec target "cli"');
    // Only the baseline eval ran — invalid patches are free.
    expect(log.filter((l) => l.startsWith("eval:"))).toEqual(["eval:baseline"]);
    expect(result.finalYaml).toBe(SOURCE_YAML);
  });

  test("an apply conflict (add over an existing path) rejects and the loop continues", async () => {
    const log: string[] = [];
    const result = await applyAdvicePatches({
      sourceYaml: SOURCE_YAML,
      patches: [
        // agent.instructions is whitelisted, but "add" conflicts: it exists.
        { patch: { target: "cli", path: ["agent", "instructions"], op: "add", value: "x" } },
        CURATE_PATCH,
      ],
      hooks: makeHooks({ log }),
    });
    expect(result.decisions[0]?.status).toBe("rejected");
    expect(result.decisions[0]?.reason).toContain("patch failed to apply");
    expect(result.decisions[1]?.status).toBe("accepted");
    expect(result.accepted).toBe(1);
  });

  test("a candidate that fails the compile gate rejects without an eval", async () => {
    const log: string[] = [];
    const result = await applyAdvicePatches({
      sourceYaml: SOURCE_YAML,
      patches: [MAX_TOKENS_PATCH],
      hooks: makeHooks({ log, failCompileFor: "patch-001" }),
    });
    expect(result.decisions[0]?.status).toBe("rejected");
    expect(result.decisions[0]?.reason).toContain("failed to compile");
    expect(log.filter((l) => l.startsWith("eval:"))).toEqual(["eval:baseline"]);
  });

  test("a baseline compile failure propagates — nothing was spent yet", async () => {
    const log: string[] = [];
    await expect(
      applyAdvicePatches({
        sourceYaml: SOURCE_YAML,
        patches: [MAX_TOKENS_PATCH],
        hooks: makeHooks({ log, failCompileFor: "baseline" }),
      }),
    ).rejects.toThrow("bad candidate yaml");
    expect(log).toEqual(["compile:baseline"]);
  });
});

// -------- artifacts + write-back stamping --------

describe("advice artifacts", () => {
  test("stampAdviceWriteBack produces the standard provenance header (mutator: advisor)", () => {
    const stamped = stampAdviceWriteBack({
      runId: "opt_advice1",
      yaml: SOURCE_YAML,
      passRateBefore: 0.5,
      passRateAfter: 1,
      patchesEvaluated: 2,
      timestamp: "2026-07-02T00:00:00Z",
    });
    expect(stamped.endsWith(SOURCE_YAML)).toBe(true);
    const header = parseWriteBackHeader(stamped);
    expect(header?.runId).toBe("opt_advice1");
    expect(header?.mutator).toBe("advisor");
    expect(header?.iterations).toBe(2);
    expect(header?.scoreBefore).toBe(0.5);
    expect(header?.scoreAfter).toBe(1);
  });

  test("buildAdviceDecisionsFile counts accepted/evaluated and carries the baseline", () => {
    const decisions = [
      { index: 1, patch: MAX_TOKENS_PATCH.patch, status: "accepted" as const, reason: "ok" },
      { index: 2, patch: CURATE_PATCH.patch, status: "rejected" as const, reason: "nope" },
    ];
    const file = buildAdviceDecisionsFile({
      runId: "opt_x",
      generatedAt: "2026-07-02T00:00:00Z",
      source: "suggestions.json",
      baseline: makeSummary("baseline", ONE_FAIL),
      decisions,
    });
    expect(file.evaluated).toBe(2);
    expect(file.accepted).toBe(1);
    expect(file.baseline.passRate).toBe(0.5);
    expect(file.baseline.evalDir).toBe("/tmp/advice-test/baseline");
    expect(file.decisions).toHaveLength(2);
  });

  test("patchLabel + formatAdviceDecisionLine render the audit line", () => {
    expect(patchLabel(1)).toBe("patch-001");
    expect(patchLabel(12)).toBe("patch-012");
    const line = formatAdviceDecisionLine({
      index: 1,
      findingId: "truncation-pressure",
      patch: MAX_TOKENS_PATCH.patch,
      status: "accepted",
      reason: "pass_rate held at 100.0% with zero regressions",
    });
    expect(line).toContain("patch-001 truncation-pressure");
    expect(line).toContain("add agent.max_tokens → 16384");
    expect(line).toContain("ACCEPTED");
    const removeLine = formatAdviceDecisionLine({
      index: 2,
      patch: { target: "cli", path: ["agent", "max_tokens"], op: "remove" },
      status: "rejected",
      reason: "r",
    });
    expect(removeLine).toContain("remove agent.max_tokens —");
  });
});
