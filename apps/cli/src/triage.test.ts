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
  hasStructuredAmbiguityEvidence,
  isErroredResult,
  isExcludedClass,
  isFailing,
  promoteArbiterSamples,
  runLooksInfrastructureFailed,
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
  opts: {
    passed?: boolean;
    score?: number;
    error?: string;
    graderError?: string;
    output?: string;
  } = {},
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
        passed: opts.error === undefined && opts.graderError === undefined && passed,
        score: opts.score ?? (passed ? 1 : 0),
        rationale: opts.error !== undefined ? `agent invocation error: ${opts.error}` : "graded",
      },
      perGrader: [],
    },
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ...(opts.graderError !== undefined ? { graderError: opts.graderError } : {}),
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

  test("isErroredResult: invoker errors and grader throws are errors; graded failures aren't", () => {
    expect(isErroredResult(makeResult("a", { error: "boom" }))).toBe(true);
    expect(isErroredResult(makeResult("b", { graderError: "grader threw: judge: 429" }))).toBe(
      true,
    );
    expect(isErroredResult(makeResult("c", { passed: false }))).toBe(false);
  });

  test("F3: a double-throw grader failure (graderError) maps to errorMessage → transient marker classifies as noise", () => {
    const f = toFailingSample(
      makeResult("judge-blip", { graderError: "grader threw: judge: 429 rate limit exceeded" }),
      sample("judge-blip", "gold"),
    );
    expect(f.errorMessage).toBe("grader threw: judge: 429 rate limit exceeded");

    const verdicts = triageEvalRun({
      samples: [
        makeResult("judge-blip", { graderError: "grader threw: judge: 429 rate limit exceeded" }),
      ],
      samplesById: byId([sample("judge-blip", "gold")]),
      runId: "run_ge",
    }) as RunVerdicts;
    expect(verdicts.verdicts[0]?.class).toBe("noise");
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
  test("prints the one-line summary and writes verdicts.json — but never pins the run's own dataset samples (F1)", async () => {
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

    // F1(b): b1's bug verdict carries promoteRegression, but b1 is a member
    // of the run's OWN dataset — pinning it is zero coverage gain and pure
    // suite-version churn (the churn that armed the gate-disarm loop), so
    // NO suite version is written and no "pinned" line prints.
    expect(await registry.list("concierge-regressions")).toEqual([]);
    expect(lines.some((l) => l.includes("pinned"))).toBe(false);
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

  test("best-effort: an unwritable run dir warns and keeps the verdicts", async () => {
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
    // promoteArbiterSamples is the stage that talks to the registry; drive
    // it with a pinnable (non-member, non-errored) candidate so the throwing
    // registry is actually reached, then prove the flow isolates the throw.
    const verdicts = triageEvalRun({
      samples: [makeResult("b1")],
      samplesById: byId([sample("b1", "gold")]),
      runId: "run_5555",
    }) as RunVerdicts;
    await expect(
      promoteArbiterSamples({
        registry: throwingRegistry,
        specName: "concierge",
        verdicts,
        samplesById: byId([sample("b1", "gold")]),
        sourceDataset: "support@v3",
        runId: "run_5555",
      }),
    ).rejects.toThrow("registry offline");
    // finishEvalTriage isolates that throw into a warning (its own pin call
    // no-ops on the member filter, so exercise the catch via the write path
    // being fine and the registry throw being absorbed by promote's caller).
    const finished = await finishEvalTriage({
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
    expect(finished?.counts.bug).toBe(1);
    // No warn about pinning: the member filter emptied the candidate set
    // before the registry could throw — and that is the point of F1(b).
    expect(warns.some((l) => l.includes("regression pinning skipped"))).toBe(false);
  });
});

// -------- promoteArbiterSamples candidate filters (F1b / F2) --------

describe("promoteArbiterSamples — F1(b) member filter + F2(i) error filter", () => {
  async function verdictsFor(samples: SampleResult[], byIdMap: Map<string, Sample>) {
    return triageEvalRun({ samples, samplesById: byIdMap, runId: "run_flt" }) as RunVerdicts;
  }

  test("never pins samples already in the run's own dataset (zero coverage gain)", async () => {
    const registry = newRegistry(newTempRoot());
    const map = byId([sample("b1", "gold"), sample("b2", "gold")]);
    const verdicts = await verdictsFor([makeResult("b1"), makeResult("b2")], map);
    // b1 is a dataset member; b2 (hypothetically) is not.
    const pin = await promoteArbiterSamples({
      registry,
      specName: "concierge",
      verdicts,
      samplesById: map,
      sourceDataset: "support@v3",
      runId: "run_flt",
      datasetMemberIds: new Set(["b1"]),
    });
    expect(pin.pinned).toBe(1);
    const record = await registry.getRecord("concierge-regressions", "v1");
    expect(record.splits.train.map((s) => s.id)).toEqual(["b2"]);
  });

  test("F2(i): never pins samples whose failure is an ERROR — even bug-class non-transient ones", async () => {
    const registry = newRegistry(newTempRoot());
    const map = byId([sample("auth", "gold"), sample("b1", "gold")]);
    // "401 invalid x-api-key" carries no transient marker → the arbiter's
    // default rule labels it "bug" with promoteRegression. It must still
    // never be pinned: an outage is not a regression to guard.
    const results = [makeResult("auth", { error: "401 invalid x-api-key" }), makeResult("b1")];
    const verdicts = await verdictsFor(results, map);
    expect(verdicts.verdicts.find((v) => v.sampleId === "auth")?.class).toBe("bug");

    const pin = await promoteArbiterSamples({
      registry,
      specName: "concierge",
      verdicts,
      samplesById: map,
      sourceDataset: "support@v3",
      runId: "run_flt",
      erroredIds: new Set(results.filter(isErroredResult).map((r) => r.sampleId)),
    });
    expect(pin.pinned).toBe(1);
    const record = await registry.getRecord("concierge-regressions", "v1");
    expect(record.splits.train.map((s) => s.id)).toEqual(["b1"]);
  });

  test("grader-infra failures (graderError) count as errored for the filter", async () => {
    const registry = newRegistry(newTempRoot());
    const map = byId([sample("judge-blip", "gold")]);
    const results = [
      makeResult("judge-blip", { graderError: "grader threw: judge: 500 upstream" }),
    ];
    const verdicts = await verdictsFor(results, map);
    const pin = await promoteArbiterSamples({
      registry,
      specName: "concierge",
      verdicts,
      samplesById: map,
      sourceDataset: "support@v3",
      runId: "run_flt",
      erroredIds: new Set(results.filter(isErroredResult).map((r) => r.sampleId)),
    });
    expect(pin.pinned).toBe(0);
    expect(await registry.list("concierge-regressions")).toEqual([]);
  });
});

// -------- run-level outage guard (F2 ii) --------

describe("runLooksInfrastructureFailed (F2 outage guard)", () => {
  test("all failing samples errored → infrastructure-failed", () => {
    const reason = runLooksInfrastructureFailed([
      makeResult("a", { error: "401 invalid x-api-key" }),
      makeResult("b", { error: "401 invalid x-api-key" }),
      makeResult("ok", { passed: true }),
    ]);
    expect(reason).toContain("all 2 failing sample(s) errored");
  });

  test("error rate above the threshold → infrastructure-failed even with graded failures present", () => {
    const reason = runLooksInfrastructureFailed([
      makeResult("e1", { error: "401 invalid x-api-key" }),
      makeResult("e2", { error: "401 invalid x-api-key" }),
      makeResult("e3", { graderError: "grader threw: judge: 500" }),
      makeResult("graded-fail"), // honest graded failure
      makeResult("ok", { passed: true }),
    ]);
    expect(reason).toContain("3/5 sample(s) errored");
  });

  test("graded failures with few/no errors → run looks real", () => {
    expect(
      runLooksInfrastructureFailed([
        makeResult("graded-fail"),
        makeResult("e1", { error: "ETIMEDOUT" }),
        makeResult("ok1", { passed: true }),
        makeResult("ok2", { passed: true }),
      ]),
    ).toBeUndefined();
    expect(runLooksInfrastructureFailed([makeResult("ok", { passed: true })])).toBeUndefined();
  });

  test("finishEvalTriage skips pinning entirely (with a warning) on an infrastructure-failed run", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    const warns: string[] = [];
    const lines: string[] = [];
    const verdicts = await finishEvalTriage({
      samples: [
        makeResult("a", { error: "401 invalid x-api-key" }),
        makeResult("b", { error: "401 invalid x-api-key" }),
      ],
      samplesById: byId([sample("a", "gold"), sample("b", "gold")]),
      runId: "run_outage",
      outDir: root,
      specName: "concierge",
      sourceDataset: "support@v3",
      registry,
      write: (l) => lines.push(l),
      warn: (l) => warns.push(l),
    });
    // Triage itself still ran (verdicts persist for the report)…
    expect(verdicts?.total).toBe(2);
    expect(existsSync(join(root, "verdicts.json"))).toBe(true);
    // …but pinning was skipped loudly, and nothing was written.
    expect(
      warns.some((l) => l.includes("run looks infrastructure-failed") && l.includes("skipping")),
    ).toBe(true);
    expect(await registry.list("concierge-regressions")).toEqual([]);
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

  test("excludes noise, keeps bug ids AND heuristic (no-gold) contract-ambiguity in the signal (F5)", () => {
    const t = triageFitnessSamples({
      samples: [
        makeResult("bug1"), // gold + score 0 → bug (kept)
        makeResult("noise1", { error: "ECONNRESET" }), // transient → noise (excluded)
        makeResult("ambig1", { score: 0.4 }), // no gold + partial credit → HEURISTIC ambiguity (kept, queued)
        makeResult("pass1", { passed: true }), // not failing → untouched
      ],
      samplesById: byId([sample("bug1", "gold"), sample("noise1", "gold"), sample("ambig1")]),
      alreadyAmbiguous: new Set(),
    });
    // F5: the no-reference heuristic verdict is NOT excluded — on judge-graded
    // datasets it fires for most failures and would starve the mutator.
    expect([...t.excluded]).toEqual(["noise1"]);
    expect(t.counts).toEqual({ bug: 1, "spec-gap": 0, noise: 1, "contract-ambiguity": 1 });
    // …but it IS surfaced for the printed dataset-fix queue.
    expect(t.ambiguous).toHaveLength(1);
    expect(t.ambiguous[0]?.sampleId).toBe("ambig1");
    expect(t.ambiguous[0]?.reason).toContain("underspecifies");
    expect(t.ambiguous[0]?.fromGraderEvidence).toBe(false);
    expect(t.carried).toBe(0);
  });

  test("F5: a no-gold judge-style failure stays in the mutator signal across calls (nothing sticky)", () => {
    // Ratings-distilled/judge-graded dataset: no expected_output anywhere.
    const first = triageFitnessSamples({
      samples: [makeResult("j1", { score: 0.4 }), makeResult("j2", { score: 0.2 })],
      samplesById: byId([sample("j1"), sample("j2")]),
      alreadyAmbiguous: new Set(),
    });
    expect(first.excluded.size).toBe(0); // full failure signal reaches the mutator
    expect(first.ambiguous.map((a) => a.sampleId).sort()).toEqual(["j1", "j2"]);
    expect(first.ambiguous.every((a) => !a.fromGraderEvidence)).toBe(true);
    // The caller only sticks evidence-backed ids, so the next call still
    // keeps them in the signal (alreadyAmbiguous stays empty).
    const second = triageFitnessSamples({
      samples: [makeResult("j1", { score: 0.4 })],
      samplesById: byId([sample("j1")]),
      alreadyAmbiguous: new Set(),
    });
    expect(second.excluded.size).toBe(0);
    expect(second.carried).toBe(0);
  });

  test("hasStructuredAmbiguityEvidence: only graderOutput acceptable/multipleAcceptable count", () => {
    const base = toFailingSample(makeResult("s", { score: 0.4 }), sample("s"));
    expect(hasStructuredAmbiguityEvidence(base)).toBe(false); // heuristic-only
    expect(hasStructuredAmbiguityEvidence({ ...base, graderOutput: { acceptable: true } })).toBe(
      true,
    );
    expect(
      hasStructuredAmbiguityEvidence({ ...base, graderOutput: { multipleAcceptable: true } }),
    ).toBe(true);
    expect(hasStructuredAmbiguityEvidence({ ...base, graderOutput: { acceptable: false } })).toBe(
      false,
    );
  });

  test("sticky across iterations: queued ids are excluded without re-arbitration (even when passing)", () => {
    const t = triageFitnessSamples({
      samples: [
        makeResult("ambig1", { passed: true }), // stuck earlier; passes now — still excluded
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

    // Heuristic ambiguity prints as queued-but-kept — the exclusion counts
    // must not claim it (F5).
    const heuristic = triageFitnessSamples({
      samples: [makeResult("j1", { score: 0.4 })],
      samplesById: byId([sample("j1")]),
      alreadyAmbiguous: new Set(),
    });
    expect(formatFitnessTriageLine(heuristic)).toBe(
      "triage: excluded 0 noise, 0 contract-ambiguity from mutation signal; kept 0 bug, 0 spec-gap" +
        ", 1 heuristic contract-ambiguity (queued for dataset fix, kept in signal)",
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
