/**
 * Item 4 — unit tests for the graders-suggest core (evidence extraction
 * from run artifacts, deterministic clustering, deterministic grader
 * drafting, the rubric-prompt pure halves, review-file rendering, the
 * distill floor-grader hook contract) plus CLI integration for
 * `crewhaus graders suggest` over seeded run dirs.
 *
 * CLI tests follow datasets-cli.test.ts's posture: stdout assertions are
 * avoided (Bun 1.3.x spawn-pipe capture is unreliable under `bun test`) —
 * assert on exit codes and on-disk artifacts instead. The spawned env
 * carries only PATH, so no model call is ever attempted.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { type LoadedRun, loadRun } from "@crewhaus/eval-report";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { type FeedbackRecord, type SessionTurn, synthesizeGraders } from "./feedback";
import {
  DEFAULT_SUGGESTED_GRADERS_FILE,
  FLOOR_GRADER_HINT,
  type FailureEvidence,
  GradersSuggestError,
  type PassExemplar,
  RUBRIC_SUGGESTION_SYSTEM,
  buildRubricSuggestionPrompt,
  cleanRationale,
  clusterFailures,
  criterionEvidence,
  draftGradersForThemes,
  evidenceFromFeedback,
  evidenceFromRun,
  isFloorGraderConfig,
  normalizeEvidenceTokens,
  parseRubricSuggestion,
  parseRunsFlag,
  renderSuggestedGradersYaml,
  toolNamesFromEventsJsonl,
} from "./graders-suggest";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-graders-suggest-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

// -------- run-dir seeding --------

type SeedSample = {
  readonly sampleId: string;
  readonly passed: boolean;
  readonly output: string;
  readonly perGrader: Array<{
    name: string;
    passed: boolean;
    rationale: string;
    abstained?: boolean;
  }>;
  readonly toolNames?: string[];
  readonly error?: string;
  /** A3 — the sample outcome was abstained (judge declined, nothing else failed). */
  readonly abstained?: boolean;
};

function sampleResult(seed: SeedSample): SampleResult {
  const perGrader = seed.perGrader.map((g) => ({
    name: g.name,
    passed: g.passed,
    score: g.passed ? 1 : 0,
    rationale: g.rationale,
    ...(g.abstained === true ? { abstained: true } : {}),
  }));
  return {
    sampleId: seed.sampleId,
    sessionId: "sess_0123456789abcdef",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:00:01.000Z",
    latencyMs: 1000,
    turns: 1,
    tokens: { input: 10, output: 10 },
    model: "claude-sonnet-4-6",
    agentOutput: seed.output,
    grades: {
      overall: {
        passed: seed.passed,
        score: seed.passed ? 1 : 0,
        rationale: perGrader
          .map((g) => `[${g.name}: ${g.passed ? "✓" : "✗"}] ${g.rationale}`)
          .join(" & "),
        ...(seed.abstained === true ? { abstained: true } : {}),
      },
      perGrader,
    },
    ...(seed.error !== undefined ? { error: seed.error } : {}),
  };
}

/** Write a loadRun-compatible run dir: results.json + per-sample dirs with
 *  grades.json / events.jsonl — the artifacts eval-runner persists. */
function seedRunDir(dir: string, runId: string, seeds: ReadonlyArray<SeedSample>): void {
  mkdirSync(dir, { recursive: true });
  const samples = seeds.map(sampleResult);
  const summary: EvalRunSummary = {
    runId,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:01:00.000Z",
    samples,
    aggregates: {
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: 0.5,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 1000,
      p95LatencyMs: 1000,
      totalTokens: { input: 100, output: 100 },
      errorCount: seeds.filter((s) => s.error !== undefined).length,
    },
    config: {
      specHash: "spec-hash",
      datasetName: "seeded",
      graderNames: ["cited", "used_tools"],
      model: "claude-sonnet-4-6",
      concurrency: 1,
    },
    outDir: dir,
  };
  writeFileSync(join(dir, "results.json"), JSON.stringify(summary, null, 2));
  for (const seed of seeds) {
    const sampleDir = join(dir, seed.sampleId.replace(/[^A-Za-z0-9_.-]/g, "_"));
    mkdirSync(sampleDir, { recursive: true });
    const result = sampleResult(seed);
    writeFileSync(join(sampleDir, "grades.json"), JSON.stringify(result.grades, null, 2));
    const events = (seed.toolNames ?? []).map((toolName, i) =>
      JSON.stringify({
        kind: "tool_call_end",
        toolName,
        toolUseId: `use_${i}`,
        isError: false,
        timestamp: "2026-07-01T00:00:00.500Z",
      }),
    );
    writeFileSync(
      join(sampleDir, "events.jsonl"),
      events.length > 0 ? `${events.join("\n")}\n` : "",
    );
  }
}

const CITATION_FAIL = 'output missing "Source:"';
const TOOL_FAIL = "tool subsequence not found: expected [Read] got []";

function seedStandardRun(dir: string, runId: string): void {
  seedRunDir(dir, runId, [
    {
      sampleId: "s1",
      passed: false,
      output: "Answer without citation.",
      perGrader: [{ name: "cited", passed: false, rationale: CITATION_FAIL }],
    },
    {
      sampleId: "s2",
      passed: false,
      output: "Another answer, still no citation.",
      perGrader: [{ name: "cited", passed: false, rationale: CITATION_FAIL }],
    },
    {
      sampleId: "s3",
      passed: false,
      output: "I looked at docs but gave no citation.",
      perGrader: [{ name: "used_tools", passed: false, rationale: TOOL_FAIL }],
    },
    {
      sampleId: "s4",
      passed: true,
      output: "Done. Source: docs/guide.md",
      perGrader: [{ name: "cited", passed: true, rationale: 'output contains "Source:"' }],
      toolNames: ["Read", "Grep", "Read"],
    },
    {
      sampleId: "s5",
      passed: false,
      output: "",
      perGrader: [{ name: "cited", passed: false, rationale: "grader threw: judge 429" }],
      error: "provider 500",
    },
  ]);
}

// -------- flag parsing --------

describe("parseRunsFlag", () => {
  it("parses last:N and last N", () => {
    expect(parseRunsFlag("last:5")).toEqual({ kind: "last", n: 5 });
    expect(parseRunsFlag("last 3")).toEqual({ kind: "last", n: 3 });
    expect(parseRunsFlag("LAST:1")).toEqual({ kind: "last", n: 1 });
  });

  it("treats anything else as a run dir and rejects last:0", () => {
    expect(parseRunsFlag(".crewhaus/evals/run_x")).toEqual({
      kind: "dir",
      dir: ".crewhaus/evals/run_x",
    });
    expect(() => parseRunsFlag("last:0")).toThrow(GradersSuggestError);
  });
});

// -------- evidence extraction --------

describe("cleanRationale", () => {
  it("strips combinator markers and the judge prefix", () => {
    expect(cleanRationale('[cited: ✗] output missing "Source:"')).toBe('output missing "Source:"');
    expect(cleanRationale("judge=2 (need ≥3): response lacks any citation")).toBe(
      "response lacks any citation",
    );
  });

  it("strips the NEW-HUNT-2 panel-median judge prefix", () => {
    expect(
      cleanRationale(
        "judge=3.5 (median of 3 repeats [3, abstain, 4], agreement 1/2, need ≥4): missing citations",
      ),
    ).toBe("missing citations");
  });

  it("drops infra noise entirely", () => {
    expect(cleanRationale("grader threw: judge 429")).toBe("");
    expect(cleanRationale("agent invocation error: provider timeout")).toBe("");
  });

  it("drops A3 abstained rationales entirely (needs-human, not a failure theme)", () => {
    expect(cleanRationale("judge abstained (need ≥4): agent output is empty")).toBe("");
    expect(
      cleanRationale(
        "judge abstained (2/3 repeats abstained [abstain, 3, abstain], need ≥4): input truncated",
      ),
    ).toBe("");
  });
});

describe("toolNamesFromEventsJsonl", () => {
  it("collects unique tool_call_end names, tolerating junk lines", () => {
    const text = [
      "not json",
      JSON.stringify({ kind: "tool_call_start", toolName: "Read", toolUseId: "u1" }),
      JSON.stringify({ kind: "tool_call_end", toolName: "Read", toolUseId: "u1", isError: false }),
      JSON.stringify({ kind: "tool_call_end", toolName: "Grep", toolUseId: "u2", isError: false }),
      JSON.stringify({ kind: "tool_call_end", toolName: "Read", toolUseId: "u3", isError: false }),
    ].join("\n");
    expect(toolNamesFromEventsJsonl(text)).toEqual(["Read", "Grep"]);
    expect(toolNamesFromEventsJsonl("")).toEqual([]);
  });
});

describe("criterionEvidence", () => {
  it("surfaces low judge criterionScores where present", () => {
    const grades = JSON.stringify({
      overall: { passed: false, score: 0.25, rationale: "judge=2 (need ≥3): weak" },
      perGrader: [
        {
          name: "judge_quality",
          passed: false,
          score: 0.25,
          rationale: "judge=2 (need ≥3): weak",
          criterionScores: { citations: 1, tone: 4, accuracy: 2 },
        },
      ],
    });
    const got = criterionEvidence(grades, "s1", "run_a");
    expect(got).toEqual([
      {
        sampleId: "s1",
        runId: "run_a",
        source: "judge_quality:criterion",
        text: "judge criterion accuracy scored 2/5",
      },
      {
        sampleId: "s1",
        runId: "run_a",
        source: "judge_quality:criterion",
        text: "judge criterion citations scored 1/5",
      },
    ]);
  });

  it("is empty for today's grades.json shape (no criterionScores) and junk", () => {
    expect(
      criterionEvidence(JSON.stringify({ perGrader: [{ name: "x", rationale: "r" }] }), "s", "r"),
    ).toEqual([]);
    expect(criterionEvidence("not json", "s", "r")).toEqual([]);
    expect(criterionEvidence("", "s", "r")).toEqual([]);
  });
});

describe("evidenceFromRun (seeded run dir via loadRun)", () => {
  it("extracts failing rationales + pass exemplars and skips errored samples", async () => {
    const root = newTempRoot();
    const dir = join(root, "run_a");
    seedStandardRun(dir, "run_000000000000000a");
    const loaded: LoadedRun = await loadRun(dir);
    const { failures, passes } = evidenceFromRun(loaded);

    // s5 (errored) contributes nothing; s1/s2/s3 contribute one rationale each.
    expect(failures.map((f) => f.sampleId)).toEqual(["s1", "s2", "s3"]);
    expect(failures[0]?.source).toBe("cited");
    expect(failures[0]?.text).toBe(CITATION_FAIL);
    expect(failures[0]?.output).toBe("Answer without citation.");

    expect(passes).toHaveLength(1);
    expect(passes[0]?.sampleId).toBe("s4");
    expect(passes[0]?.toolNames).toEqual(["Read", "Grep"]);
  });

  it("A3: skips abstained samples wholesale and abstained perGrader placeholders", async () => {
    const root = newTempRoot();
    const dir = join(root, "run_b");
    seedRunDir(dir, "run_000000000000000b", [
      {
        // Sample outcome abstained (judge declined, nothing else failed):
        // the conservative passed:false placeholder is NOT failure evidence.
        sampleId: "a1",
        passed: false,
        abstained: true,
        output: "",
        perGrader: [
          {
            name: "judge_q",
            passed: false,
            abstained: true,
            rationale: "judge abstained (need ≥3): agent output is empty",
          },
        ],
      },
      {
        // A real failure beside an abstaining judge: keep the real failing
        // grader's rationale, drop the abstention placeholder.
        sampleId: "a2",
        passed: false,
        output: "Wrong answer.",
        perGrader: [
          {
            name: "judge_q",
            passed: false,
            abstained: true,
            rationale: "judge abstained (need ≥3): missing context",
          },
          { name: "cited", passed: false, rationale: CITATION_FAIL },
        ],
      },
    ]);
    const loaded: LoadedRun = await loadRun(dir);
    const { failures, passes } = evidenceFromRun(loaded);

    expect(failures.map((f) => `${f.sampleId}:${f.source}`)).toEqual(["a2:cited"]);
    expect(failures[0]?.text).toBe(CITATION_FAIL);
    expect(passes).toHaveLength(0);
  });
});

describe("evidenceFromFeedback", () => {
  const turn = (n: number, output: string, toolNames: string[] = []): SessionTurn => ({
    sessionId: "sess_0123456789abcdef",
    turnNumber: n,
    input: `question ${n}`,
    output,
    toolNames,
  });
  const record = (n: number, overrides: Partial<FeedbackRecord>): FeedbackRecord => ({
    schemaVersion: 1,
    id: `fb_${n}`,
    sessionId: "sess_0123456789abcdef",
    turnNumber: n,
    modality: "binary",
    rating: {},
    source: "cli",
    ts: `2026-07-01T00:00:0${n}.000Z`,
    ...overrides,
  });

  it("splits down-rated comments from up-rated exemplars", () => {
    const turns = [turn(1, "Good answer with Source: a.md", ["Read"]), turn(2, "Bad answer")];
    const records = [
      record(1, { rating: { thumbs: "up" }, comment: "love the citations" }),
      record(2, { rating: { thumbs: "down" }, comment: "no sources cited at all" }),
      record(3, { rating: { thumbs: "down" }, comment: "unmatched turn — skipped" }),
    ];
    const got = evidenceFromFeedback(turns, records, 0.7);
    expect(got.passes).toHaveLength(1);
    expect(got.passes[0]?.output).toBe("Good answer with Source: a.md");
    expect(got.passes[0]?.toolNames).toEqual(["Read"]);
    expect(got.positiveComments).toEqual(["love the citations"]);
    expect(got.failures).toHaveLength(1);
    expect(got.failures[0]?.source).toBe("user_feedback");
    expect(got.failures[0]?.text).toBe("no sources cited at all");
    expect(got.failures[0]?.runId).toBe("feedback");
  });

  it("ignores down-rated turns without comments (no clustering signal)", () => {
    const got = evidenceFromFeedback(
      [turn(1, "meh")],
      [record(1, { rating: { thumbs: "down" } })],
      0.7,
    );
    expect(got.failures).toEqual([]);
    expect(got.passes).toEqual([]);
  });
});

// -------- clustering --------

function evidence(
  sampleId: string,
  text: string,
  overrides: Partial<FailureEvidence> = {},
): FailureEvidence {
  return { sampleId, runId: "run_a", source: "g", text, ...overrides };
}

describe("clusterFailures", () => {
  it("groups similar rationales and separates dissimilar ones", () => {
    const themes = clusterFailures([
      evidence("s1", 'output missing "Source:" citation'),
      evidence("s2", 'output missing "Source:" citation link'),
      evidence("s3", "tool subsequence not found: expected [Read]"),
    ]);
    expect(themes).toHaveLength(2);
    expect(themes[0]?.items).toHaveLength(2);
    expect(themes[0]?.sampleIds).toEqual(["s1", "s2"]);
    expect(themes[1]?.sampleIds).toEqual(["s3"]);
    // Labels come from the most frequent normalized tokens.
    expect(themes[0]?.tokens).toContain("missing");
  });

  it("is deterministic and input-order independent", () => {
    const items = [
      evidence("s1", 'output missing "Source:" citation'),
      evidence("s2", 'output missing "Source:" citation link'),
      evidence("s3", "tool subsequence not found: expected [Read]"),
      evidence("s4", "tool subsequence not found: expected [Grep]"),
    ];
    const a = clusterFailures(items);
    const b = clusterFailures([...items].reverse());
    expect(a).toEqual(b);
  });

  it("drops items with no token signal", () => {
    expect(clusterFailures([evidence("s1", "a b c")])).toEqual([]);
  });

  it("normalizeEvidenceTokens drops stopwords and grader boilerplate", () => {
    expect(normalizeEvidenceTokens('output missing "Source:" from the answer')).toEqual([
      "missing",
      "source",
      "answer",
    ]);
  });
});

// -------- deterministic drafting --------

describe("draftGradersForThemes", () => {
  const pass = (output: string, toolNames: string[] = []): PassExemplar => ({
    sampleId: `p${output.length}`,
    runId: "run_a",
    output,
    toolNames,
  });

  it("drafts tool_call_sequence when the theme mentions tools and passes share them", () => {
    const themes = clusterFailures([
      evidence("s3", TOOL_FAIL),
      evidence("s6", "tool subsequence not found: expected [Read] got [Bash]"),
    ]);
    const { suggestions, undrafted } = draftGradersForThemes(themes, [
      pass("Found it in src/index.ts", ["Read", "Grep"]),
      pass("It lives in src/feedback.ts", ["Read"]),
    ]);
    expect(undrafted).toEqual([]);
    expect(suggestions).toHaveLength(1);
    const spec = suggestions[0]?.spec;
    if (spec?.type !== "tool_call_sequence") throw new Error(`expected tools, got ${spec?.type}`);
    expect(spec.expected).toEqual(["Read"]);
    expect(spec.mode).toBe("set");
    expect(suggestions[0]?.evidence[0]).toContain("2 failing rationale(s)");
  });

  it("drafts json_path when every up-rated output is a JSON object with a common key", () => {
    const themes = clusterFailures([
      evidence("s1", "response body was not the agreed json contract"),
      evidence("s2", "response body missing the agreed json contract"),
    ]);
    const { suggestions } = draftGradersForThemes(themes, [
      pass('{"answer": 42, "sources": ["a.md"]}'),
      pass('{"answer": 7}'),
    ]);
    const spec = suggestions[0]?.spec;
    if (spec?.type !== "json_path") throw new Error(`expected json_path, got ${spec?.type}`);
    expect(spec.path).toBe("$.answer");
  });

  it("drafts a prefix regex when up-rated outputs share a format prefix", () => {
    const themes = clusterFailures([
      evidence("s1", "reply skipped the required summary heading format"),
      evidence("s2", "reply ignored the required summary heading format"),
    ]);
    const { suggestions } = draftGradersForThemes(themes, [
      pass("SUMMARY: deploy went fine"),
      pass("SUMMARY: deploy failed at step 2"),
    ]);
    const spec = suggestions[0]?.spec;
    if (spec?.type !== "regex") throw new Error(`expected regex, got ${spec?.type}`);
    expect(spec.pattern).toBe("^SUMMARY: deploy");
    // The drafted pattern actually matches the up-rated outputs.
    expect(new RegExp(spec.pattern).test("SUMMARY: deploy went fine")).toBe(true);
  });

  it("drafts contains with a token common in up-rated and rare in failing outputs", () => {
    const themes = clusterFailures([
      evidence("s1", "answer gave no citation for its claims", {
        output: "I looked at docs but cited nothing.",
      }),
      evidence("s2", "answer gave zero citation for the claims", {
        output: "Trust me, docs say so.",
      }),
    ]);
    const { suggestions } = draftGradersForThemes(themes, [
      pass("Done. Source: docs/guide.md"),
      pass("Complete. Source: docs/setup.md"),
    ]);
    const spec = suggestions[0]?.spec;
    if (spec?.type !== "contains") throw new Error(`expected contains, got ${spec?.type}`);
    expect(spec.substring).toBe("source");
    expect(spec.case_insensitive).toBe(true);
  });

  it("reports themes with no deterministic signal as undrafted", () => {
    const themes = clusterFailures([evidence("s1", "tone felt robotic and abrupt")]);
    const { suggestions, undrafted } = draftGradersForThemes(themes, []);
    expect(suggestions).toEqual([]);
    expect(undrafted).toHaveLength(1);
  });

  it("is deterministic (same evidence → identical suggestions)", () => {
    const items = [
      evidence("s1", 'output missing "Source:" citation'),
      evidence("s2", 'output missing "Source:" citation link'),
    ];
    const passes = [pass("Done. Source: docs/guide.md"), pass("Complete. Source: docs/setup.md")];
    const a = draftGradersForThemes(clusterFailures(items), passes);
    const b = draftGradersForThemes(clusterFailures([...items].reverse()), passes);
    expect(a).toEqual(b);
  });
});

// -------- model-drafted rubric pure halves --------

describe("rubric suggestion (pure halves)", () => {
  it("buildRubricSuggestionPrompt folds themes and clipped exemplars", () => {
    const themes = clusterFailures([
      evidence("s1", 'output missing "Source:" citation'),
      evidence("s2", 'output missing "Source:" citation link'),
    ]);
    const prompt = buildRubricSuggestionPrompt(
      ["Done. Source: docs/guide.md"],
      themes[0]?.items ?? [],
      themes,
    );
    expect(prompt).toContain("FAILURE THEMES:");
    expect(prompt).toContain("GOOD 1:");
    expect(prompt).toContain("BAD 1 (g):");
    expect(RUBRIC_SUGGESTION_SYSTEM).toContain('"anchors"');
  });

  it("parseRubricSuggestion builds a complete single-criterion llm_judge grader", () => {
    const raw = `Sure! ${JSON.stringify({
      name: "Citation Quality",
      description: "Judge whether the response cites concrete sources.",
      anchors: { "1": "a", "2": "b", "3": "c", "4": "d", "5": "e" },
      passing_score: 4,
    })}`;
    const spec = parseRubricSuggestion(raw, "claude-sonnet-4-6");
    if (spec?.type !== "llm_judge") throw new Error("expected llm_judge");
    expect(spec.name).toBe("citation_quality");
    expect(spec.rubric.criteria).toHaveLength(1);
    expect(spec.rubric.criteria[0]?.anchors["5"]).toBe("e");
    expect(spec.rubric.passing_score).toBe(4);
    expect(spec.model).toBe("claude-sonnet-4-6");
  });

  it("returns undefined on any shape failure (missing anchor, junk)", () => {
    expect(parseRubricSuggestion("no json at all")).toBeUndefined();
    expect(
      parseRubricSuggestion(
        JSON.stringify({
          name: "x",
          description: "d",
          anchors: { "1": "a", "2": "b", "3": "c", "4": "d" },
        }),
      ),
    ).toBeUndefined();
    expect(parseRubricSuggestion(JSON.stringify({ description: "" }))).toBeUndefined();
  });
});

// -------- review-file rendering + the distill hook contract --------

describe("renderSuggestedGradersYaml", () => {
  const suggestions = () => {
    const themes = clusterFailures([
      evidence("s1", 'output missing "Source:" citation'),
      evidence("s2", 'output missing "Source:" citation link'),
    ]);
    return draftGradersForThemes(themes, [
      {
        sampleId: "p1",
        runId: "run_a",
        output: "Done. Source: docs/guide.md",
        toolNames: [],
      },
      {
        sampleId: "p2",
        runId: "run_a",
        output: "Complete. Source: docs/setup.md",
        toolNames: [],
      },
    ]).suggestions;
  };

  it("documents the hard-AND collapse and the adopt-ONE advice in the header", () => {
    const yaml = renderSuggestedGradersYaml(suggestions(), {
      specName: "helper",
      runsSeen: 2,
      failureCount: 2,
      feedbackCount: 1,
      undraftedLabels: ["tone robotic abrupt"],
    });
    expect(yaml).toContain("hard-ANDs");
    expect(yaml).toContain("Adopt ONE grader");
    expect(yaml).toContain("REVIEW FILE — never applied automatically");
    expect(yaml).toContain('for spec "helper"');
    expect(yaml).toContain("2 eval run(s) + 1 user feedback comment(s)");
    expect(yaml).toContain("tone robotic abrupt");
  });

  it("precedes each grader with its evidence comment and stays parseable", () => {
    const yaml = renderSuggestedGradersYaml(suggestions(), {
      runsSeen: 1,
      failureCount: 2,
      feedbackCount: 0,
      undraftedLabels: [],
    });
    const lines = yaml.split("\n");
    const graderLine = lines.findIndex((l) => l.startsWith("  - name:"));
    expect(graderLine).toBeGreaterThan(0);
    expect(lines[graderLine - 2]).toContain("# evidence:");
    expect(lines[graderLine - 1]).toContain("# drafted from 2 up-rated output(s)");
    // The review file is a valid graders.yaml.
    const { config } = parseGradersConfig(yaml);
    expect(config.graders.length).toBeGreaterThan(0);
  });

  it("throws when nothing was drafted", () => {
    expect(() =>
      renderSuggestedGradersYaml([], {
        runsSeen: 0,
        failureCount: 0,
        feedbackCount: 0,
        undraftedLabels: [],
      }),
    ).toThrow(GradersSuggestError);
  });
});

describe("distill floor-grader hook contract", () => {
  it("fires exactly on the floor config distill's synthesis emits", () => {
    // The no-signal path of feedback.ts's synthesis is the hook trigger.
    expect(isFloorGraderConfig(synthesizeGraders([], []))).toBe(true);
    expect(
      isFloorGraderConfig({
        graders: [
          { name: "preferred_tools", type: "tool_call_sequence", expected: ["Read"], mode: "set" },
        ],
      }),
    ).toBe(false);
    expect(
      isFloorGraderConfig({ graders: [{ name: "other_regex", type: "regex", pattern: "\\S" }] }),
    ).toBe(false);
    expect(FLOOR_GRADER_HINT).toContain("crewhaus graders suggest");
  });
});

// -------- CLI integration (seeded run dirs; env carries no creds) --------

const CWD_SPEC = `name: helper
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You answer questions about the codebase, citing file paths.
`;

function seedIndexedRun(root: string, runId: string): string {
  const dir = join(root, ".crewhaus", "evals", runId);
  seedStandardRun(dir, runId);
  const entry = {
    runId,
    specName: "helper",
    specHash: "spec-hash",
    datasetName: "seeded",
    datasetHash: "dataset-hash",
    passRate: 0.2,
    meanScore: 0.2,
    sampleCount: 5,
    ts: "2026-07-01T00:01:00.000Z",
    outDir: dir,
  };
  const evalsDir = join(root, ".crewhaus", "evals");
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(join(evalsDir, "index.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a" });
  return dir;
}

describe("crewhaus graders suggest (CLI)", () => {
  it("drafts a review file from indexed runs and guards overwrites", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CWD_SPEC);
    seedIndexedRun(root, "run_000000000000000a");

    const first = await runCli(["graders", "suggest"], root);
    expect(first.exitCode).toBe(0);
    const outPath = join(root, DEFAULT_SUGGESTED_GRADERS_FILE);
    expect(existsSync(outPath)).toBe(true);
    const yaml = readFileSync(outPath, "utf-8");
    expect(yaml).toContain("hard-ANDs");
    expect(yaml).toContain("# evidence:");
    // The review file parses as a real graders config.
    const { config } = parseGradersConfig(yaml);
    expect(config.graders.length).toBeGreaterThan(0);
    // Deterministic drafting: the seeded tool-failure theme yields the shared
    // pass tools.
    expect(yaml).toContain("tool_call_sequence");

    // No --force → refuse; --force → replace.
    expect((await runCli(["graders", "suggest"], root)).exitCode).toBe(1);
    expect((await runCli(["graders", "suggest", "--force"], root)).exitCode).toBe(0);
  });

  it("accepts an explicit --runs <dir> without any index", async () => {
    const root = newTempRoot();
    const runDir = join(root, "some-run");
    seedStandardRun(runDir, "run_000000000000000b");
    const got = await runCli(["graders", "suggest", "--runs", runDir, "-o", "review.yaml"], root);
    expect(got.exitCode).toBe(0);
    expect(existsSync(join(root, "review.yaml"))).toBe(true);
  });

  it("fails cleanly with no evidence and rejects unknown actions", async () => {
    const root = newTempRoot();
    expect((await runCli(["graders", "suggest"], root)).exitCode).toBe(1);
    expect((await runCli(["graders", "propose"], root)).exitCode).toBe(1);
  });
});
