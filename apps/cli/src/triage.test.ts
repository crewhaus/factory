/**
 * Unit tests for the item-7 failure-arbiter wiring (`triage.ts`):
 * arbitration from run artifacts (SampleResult + dataset Sample →
 * FailingSample, with the expected_output → reference mapping), verdict
 * persistence (verdicts.json), the post-eval `finishEvalTriage` flow
 * (summary line, promoteRegression → pinRecoveredSamples with
 * failure-arbiter provenance, best-effort isolation of every stage), and
 * the optimize-side failure-signal pre-filter (noise + contract-ambiguity
 * excluded, bug/spec-gap kept, sticky cross-iteration exclusion). The
 * registry is the real file-backed one rooted in a temp dir; no
 * LLM/credentials needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DatasetRegistry, createFileBackedRegistry } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import type { SampleResult } from "@crewhaus/eval-runner";
import {
  type RunVerdicts,
  actionPromotesRegression,
  finishEvalTriage,
  formatDatasetFixQueue,
  formatFitnessTriageLine,
  formatTriageSummary,
  isExcludedClass,
  isFailing,
  tapSamples,
  toFailingSample,
  triageEvalRun,
  triageFitnessSamples,
  writeRunVerdicts,
} from "./triage";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-triage-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function newRegistry(root: string): DatasetRegistry {
  return createFileBackedRegistry({ rootDir: join(root, "datasets") });
}

const sample = (id: string, expected?: string): Sample => ({
  id,
  input: `input ${id}`,
  ...(expected !== undefined ? { expected_output: expected } : {}),
});

function makeResult(
  id: string,
  opts: { passed?: boolean; score?: number; error?: string; output?: string } = {},
): SampleResult {
  const passed = opts.passed ?? false;
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: opts.output ?? (passed ? "correct" : "wrong"),
    grades: {
      overall: {
        passed: opts.error === undefined && passed,
        score: opts.score ?? (passed ? 1 : 0),
        rationale: opts.error !== undefined ? `agent invocation error: ${opts.error}` : "graded",
      },
      perGrader: [],
    },
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

function byId(samples: Sample[]): Map<string, Sample> {
  return new Map(samples.map((s) => [s.id, s]));
}

// -------- arbitration from run artifacts --------

describe("toFailingSample / triageEvalRun (arbitration from run artifacts)", () => {
  test("expected_output surfaces as the arbiter's `reference`: partial credit with gold → bug, without gold → contract-ambiguity", () => {
    const verdicts = triageEvalRun({
      samples: [makeResult("with-gold", { score: 0.4 }), makeResult("no-gold", { score: 0.4 })],
      samplesById: byId([sample("with-gold", "the answer"), sample("no-gold")]),
      runId: "run_a",
    });
    expect(verdicts).toBeDefined();
    const classes = new Map((verdicts as RunVerdicts).verdicts.map((v) => [v.sampleId, v.class]));
    expect(classes.get("with-gold")).toBe("bug");
    expect(classes.get("no-gold")).toBe("contract-ambiguity");
  });

  test("SampleResult.error with a transient marker → noise; non-transient error → bug", () => {
    const verdicts = triageEvalRun({
      samples: [
        makeResult("timeout", { error: "ETIMEDOUT connecting to model provider" }),
        makeResult("hard-fail", { error: "invalid tool schema" }),
      ],
      samplesById: byId([sample("timeout", "x"), sample("hard-fail", "y")]),
      runId: "run_b",
    });
    const classes = new Map((verdicts as RunVerdicts).verdicts.map((v) => [v.sampleId, v.class]));
    expect(classes.get("timeout")).toBe("noise");
    expect(classes.get("hard-fail")).toBe("bug");
  });

  test("passing samples are not arbitrated; an all-passing run yields undefined", () => {
    expect(
      triageEvalRun({
        samples: [makeResult("ok", { passed: true })],
        samplesById: byId([sample("ok", "x")]),
        runId: "run_c",
      }),
    ).toBeUndefined();
  });

  test("counts + dominant class + recommended action roll up via aggregate()", () => {
    const verdicts = triageEvalRun({
      samples: [
        makeResult("b1"),
        makeResult("b2"),
        makeResult("n1", { error: "rate limit exceeded" }),
        makeResult("ok", { passed: true }),
      ],
      samplesById: byId([sample("b1", "x"), sample("b2", "y"), sample("n1", "z"), sample("ok")]),
      runId: "run_d",
      now: () => new Date("2026-07-01T12:00:00Z"),
    }) as RunVerdicts;
    expect(verdicts.total).toBe(3);
    expect(verdicts.counts).toEqual({ bug: 2, "spec-gap": 0, noise: 1, "contract-ambiguity": 0 });
    expect(verdicts.dominantClass).toBe("bug");
    expect(verdicts.recommendedAction).toEqual({ kind: "fix-impl", promoteRegression: true });
    expect(verdicts.source).toBe("failure-arbiter");
    expect(verdicts.arbitratedAt).toBe("2026-07-01T12:00:00.000Z");
  });

  test("a result missing from the dataset tee degrades to a stand-in sample instead of throwing", () => {
    const verdicts = triageEvalRun({
      samples: [makeResult("ghost", { score: 0 })],
      samplesById: new Map(),
      runId: "run_e",
    }) as RunVerdicts;
    // score 0 + no reference → NOT contract-ambiguity; falls to the bug default.
    expect(verdicts.verdicts[0]?.class).toBe("bug");
  });

  test("isFailing: errors and graded failures fail; passes don't", () => {
    expect(isFailing(makeResult("a", { error: "boom" }))).toBe(true);
    expect(isFailing(makeResult("b", { passed: false }))).toBe(true);
    expect(isFailing(makeResult("c", { passed: true }))).toBe(false);
  });

  test("toFailingSample carries actual output, score, and errorMessage through", () => {
    const f = toFailingSample(
      makeResult("s", { score: 0.25, error: "boom", output: "partial" }),
      sample("s", "gold"),
    );
    expect(f.actual).toBe("partial");
    expect(f.score).toBe(0.25);
    expect(f.errorMessage).toBe("boom");
    expect((f.sample as { reference?: unknown }).reference).toBe("gold");
    expect(f.graderOutput).toBeUndefined();
  });
});

// -------- formatting + persistence --------

describe("triage formatting + verdict persistence", () => {
  test("formatTriageSummary prints all four classes in fixed order", () => {
    expect(formatTriageSummary({ bug: 2, "spec-gap": 1, noise: 3, "contract-ambiguity": 1 })).toBe(
      "triage: 2 bug, 1 spec-gap, 3 noise, 1 contract-ambiguity",
    );
  });

  test("writeRunVerdicts persists verdicts.json next to results.json", () => {
    const dir = newTempRoot();
    const verdicts = triageEvalRun({
      samples: [makeResult("b1")],
      samplesById: byId([sample("b1", "x")]),
      runId: "run_f",
      now: () => new Date("2026-07-01T12:00:00Z"),
    }) as RunVerdicts;
    const path = writeRunVerdicts(dir, verdicts);
    expect(path).toBe(join(dir, "verdicts.json"));
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.source).toBe("failure-arbiter");
    expect(parsed.counts.bug).toBe(1);
    expect(parsed.verdicts[0]).toMatchObject({
      sampleId: "b1",
      class: "bug",
      action: { kind: "fix-impl", promoteRegression: true },
    });
  });
});

// -------- finishEvalTriage (post-eval flow) --------

describe("finishEvalTriage (post-eval flow)", () => {
  test("prints the one-line summary, writes verdicts.json, and pins bug samples with failure-arbiter provenance", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    const lines: string[] = [];
    const warns: string[] = [];
    const verdicts = await finishEvalTriage({
      samples: [
        makeResult("b1"),
        makeResult("n1", { error: "rate limit exceeded" }),
        makeResult("ok", { passed: true }),
      ],
      samplesById: byId([sample("b1", "gold"), sample("n1", "gold"), sample("ok", "gold")]),
      runId: "run_1111",
      outDir: root,
      specName: "concierge",
      sourceDataset: "support@v3",
      registry,
      write: (l) => lines.push(l),
      warn: (l) => warns.push(l),
      now: () => new Date("2026-07-01T12:00:00Z"),
    });

    expect(warns).toEqual([]);
    expect(verdicts?.total).toBe(2);
    expect(lines).toContain("[eval] triage: 1 bug, 0 spec-gap, 1 noise, 0 contract-ambiguity");
    expect(existsSync(join(root, "verdicts.json"))).toBe(true);

    // promoteRegression wiring: ONLY the bug sample (fix-impl carries the
    // flag) is pinned; the noise sample (calibrate-verifier) is not.
    const record = await registry.getRecord("concierge-regressions", "v1");
    expect(record.splits.train.map((s) => s.id)).toEqual(["b1"]);
    expect(record.splits.train[0]?.metadata?.["regression_pin"]).toEqual({
      optimizeRunId: "run_1111",
      pinnedAt: "2026-07-01T12:00:00.000Z",
      sourceDataset: "support@v3",
      source: "failure-arbiter",
    });
    expect(lines.some((l) => l.includes("pinned 1 bug sample(s) → concierge-regressions@v1"))).toBe(
      true,
    );
  });

  test("returns undefined and stays silent when nothing failed", async () => {
    const lines: string[] = [];
    const verdicts = await finishEvalTriage({
      samples: [makeResult("ok", { passed: true })],
      samplesById: byId([sample("ok", "x")]),
      runId: "run_2222",
      outDir: newTempRoot(),
      specName: "concierge",
      sourceDataset: "support@v3",
      write: (l) => lines.push(l),
      warn: (l) => lines.push(l),
    });
    expect(verdicts).toBeUndefined();
    expect(lines).toEqual([]);
  });

  test("pin: false (--no-regressions) skips the registry write but still triages", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    const verdicts = await finishEvalTriage({
      samples: [makeResult("b1")],
      samplesById: byId([sample("b1", "gold")]),
      runId: "run_3333",
      outDir: root,
      specName: "concierge",
      sourceDataset: "support@v3",
      registry,
      pin: false,
      write: () => {},
      warn: () => {},
    });
    expect(verdicts?.counts.bug).toBe(1);
    expect(existsSync(join(root, "verdicts.json"))).toBe(true);
    await expect(registry.getRecord("concierge-regressions", "v1")).rejects.toThrow();
  });

  test("best-effort: an unwritable run dir warns, keeps the verdicts, and still pins", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    // outDir points at a FILE, so writing <outDir>/verdicts.json throws.
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const warns: string[] = [];
    const verdicts = await finishEvalTriage({
      samples: [makeResult("b1")],
      samplesById: byId([sample("b1", "gold")]),
      runId: "run_4444",
      outDir: blocker,
      specName: "concierge",
      sourceDataset: "support@v3",
      registry,
      write: () => {},
      warn: (l) => warns.push(l),
    });
    expect(verdicts?.counts.bug).toBe(1);
    expect(warns.some((l) => l.includes("verdicts.json not written"))).toBe(true);
    const record = await registry.getRecord("concierge-regressions", "v1");
    expect(record.splits.train.map((s) => s.id)).toEqual(["b1"]);
  });

  test("best-effort: a throwing registry warns and never breaks the flow", async () => {
    const throwingRegistry: DatasetRegistry = {
      put: () => Promise.reject(new Error("registry offline")),
      get: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("registry offline")),
        }),
      }),
      getRecord: () => Promise.reject(new Error("registry offline")),
      list: () => Promise.reject(new Error("registry offline")),
      listDatasets: () => Promise.reject(new Error("registry offline")),
    };
    const warns: string[] = [];
    const verdicts = await finishEvalTriage({
      samples: [makeResult("b1")],
      samplesById: byId([sample("b1", "gold")]),
      runId: "run_5555",
      outDir: newTempRoot(),
      specName: "concierge",
      sourceDataset: "support@v3",
      registry: throwingRegistry,
      write: () => {},
      warn: (l) => warns.push(l),
    });
    expect(verdicts?.counts.bug).toBe(1);
    expect(warns.some((l) => l.includes("regression pinning skipped"))).toBe(true);
  });
});

// -------- optimize pre-filter --------

describe("triageFitnessSamples (optimize failure-signal pre-filter)", () => {
  test("exclusion policy: noise + contract-ambiguity excluded, bug + spec-gap kept", () => {
    expect(isExcludedClass("noise")).toBe(true);
    expect(isExcludedClass("contract-ambiguity")).toBe(true);
    expect(isExcludedClass("bug")).toBe(false);
    expect(isExcludedClass("spec-gap")).toBe(false);
  });

  test("excludes noise + contract-ambiguity ids, keeps bug ids, and reports counts + reasons", () => {
    const t = triageFitnessSamples({
      samples: [
        makeResult("bug1"), // gold + score 0 → bug (kept)
        makeResult("noise1", { error: "ECONNRESET" }), // transient → noise (excluded)
        makeResult("ambig1", { score: 0.4 }), // no gold + partial credit → ambiguity (excluded)
        makeResult("pass1", { passed: true }), // not failing → untouched
      ],
      samplesById: byId([sample("bug1", "gold"), sample("noise1", "gold"), sample("ambig1")]),
      alreadyAmbiguous: new Set(),
    });
    expect([...t.excluded].sort()).toEqual(["ambig1", "noise1"]);
    expect(t.counts).toEqual({ bug: 1, "spec-gap": 0, noise: 1, "contract-ambiguity": 1 });
    expect(t.ambiguous).toHaveLength(1);
    expect(t.ambiguous[0]?.sampleId).toBe("ambig1");
    expect(t.ambiguous[0]?.reason).toContain("underspecifies");
    expect(t.carried).toBe(0);
  });

  test("sticky across iterations: queued ids are excluded without re-arbitration (even when passing)", () => {
    const t = triageFitnessSamples({
      samples: [
        makeResult("ambig1", { passed: true }), // queued earlier; passes now — still excluded
        makeResult("bug1"),
      ],
      samplesById: byId([sample("ambig1"), sample("bug1", "gold")]),
      alreadyAmbiguous: new Set(["ambig1"]),
    });
    expect([...t.excluded]).toEqual(["ambig1"]);
    expect(t.carried).toBe(1);
    // Not re-counted: this call's fresh arbitration saw only bug1.
    expect(t.counts).toEqual({ bug: 1, "spec-gap": 0, noise: 0, "contract-ambiguity": 0 });
    expect(t.ambiguous).toHaveLength(0);
  });

  test("promoteRegression flag detection is structural", () => {
    expect(actionPromotesRegression({ kind: "fix-impl", promoteRegression: true })).toBe(true);
    expect(actionPromotesRegression({ kind: "calibrate-verifier" })).toBe(false);
    expect(actionPromotesRegression({ kind: "refine-contract", restartImpl: true })).toBe(false);
  });

  test("formatFitnessTriageLine: quiet on no-op, observable counts otherwise", () => {
    const quiet = triageFitnessSamples({
      samples: [makeResult("bug1")],
      samplesById: byId([sample("bug1", "gold")]),
      alreadyAmbiguous: new Set(),
    });
    expect(formatFitnessTriageLine(quiet)).toBeUndefined();

    const noisy = triageFitnessSamples({
      samples: [makeResult("noise1", { error: "rate limit" }), makeResult("bug1")],
      samplesById: byId([sample("noise1", "g"), sample("bug1", "g")]),
      alreadyAmbiguous: new Set(["old-ambig"]),
    });
    expect(formatFitnessTriageLine(noisy)).toBe(
      "triage: excluded 1 noise, 0 contract-ambiguity from mutation signal; kept 1 bug, 0 spec-gap",
    );
  });

  test("formatDatasetFixQueue: empty → no lines; entries render id + reason", () => {
    expect(formatDatasetFixQueue(new Map())).toEqual([]);
    const lines = formatDatasetFixQueue(
      new Map([
        ["s7", "the contract underspecifies the desired behavior"],
        ["s9", "multiple acceptable outputs"],
      ]),
    );
    expect(lines[0]).toBe(
      "dataset-fix queue: 2 contract-ambiguity sample(s) — fix the dataset/contract, not the prompt:",
    );
    expect(lines[1]).toBe("  - s7: the contract underspecifies the desired behavior");
    expect(lines[2]).toBe("  - s9: multiple acceptable outputs");
  });
});

// -------- sample tee --------

describe("tapSamples", () => {
  test("tees every sample into the sink (first id wins) and yields all through", async () => {
    async function* src(): AsyncIterable<Sample> {
      yield sample("a", "first");
      yield { id: "a", input: "shadowed duplicate" };
      yield sample("b");
    }
    const sink = new Map<string, Sample>();
    const seen: string[] = [];
    for await (const s of tapSamples(src(), sink)) seen.push(s.input);
    expect(seen).toEqual(["input a", "shadowed duplicate", "input b"]);
    expect(sink.size).toBe(2);
    expect(sink.get("a")?.expected_output).toBe("first");
  });
});
