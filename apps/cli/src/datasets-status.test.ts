/**
 * B17 + B21 — unit tests for the datasets status/card read-side: the
 * run-history join grammar, the saturation (always-passing) computation,
 * the status rendering, and the markdown datasheet. Pure — run outcomes are
 * injected, no filesystem.
 */
import { describe, expect, test } from "bun:test";
import type { DatasetRecord } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import type { LintFinding } from "./dataset-lint";
import {
  type RunSampleOutcome,
  type StatusRunEntry,
  computeDatasetStatus,
  entryMatchesVersion,
  provenanceBreakdown,
  renderDatasetCard,
  statusSummaryLines,
  statusTableRows,
} from "./datasets-status";

const NOW = new Date("2026-07-25T12:00:00.000Z");

const sample = (id: string, input: string, source?: string): Sample => ({
  id,
  input,
  ...(source !== undefined ? { metadata: { source } } : {}),
});

function record(overrides: Partial<DatasetRecord> = {}): DatasetRecord {
  return {
    name: "smoke",
    version: "v1",
    splits: {
      train: [sample("t1", "a", "synthetic"), sample("t2", "b")],
      dev: [sample("d1", "c", "production_log")],
    },
    sampleHashes: { train: ["h1", "h2"], dev: ["h3"] },
    createdAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

function entry(overrides: Partial<StatusRunEntry>): StatusRunEntry {
  return {
    runId: "run_1",
    datasetName: "smoke@v1",
    datasetHash: "hash",
    ts: "2026-07-21T00:00:00.000Z",
    outDir: "/runs/1",
    passRate: 1,
    ...overrides,
  };
}

describe("datasets status — run-history join grammar (B17)", () => {
  test("matches exact, #split-pinned, and +regressions-unioned names only", () => {
    expect(entryMatchesVersion("smoke", "v1", "smoke@v1")).toBe(true);
    expect(entryMatchesVersion("smoke", "v1", "smoke@v1#test")).toBe(true);
    expect(entryMatchesVersion("smoke", "v1", "smoke@v1+regressions@v2")).toBe(true);
    expect(entryMatchesVersion("smoke", "v1", "smoke@v10")).toBe(false);
    expect(entryMatchesVersion("smoke", "v1", "smoke@v2")).toBe(false);
    expect(entryMatchesVersion("smoke", "v1", "smoke2@v1")).toBe(false);
  });
});

describe("datasets status — computeDatasetStatus (B17)", () => {
  const outcomes = new Map<string, RunSampleOutcome[]>();
  const loadOutcomes = async (outDir: string) => outcomes.get(outDir);

  test("joins runs per version, computes age, and counts test burn", async () => {
    outcomes.clear();
    const report = await computeDatasetStatus({
      name: "smoke",
      versions: [
        { version: "v1", record: record() },
        {
          version: "v2",
          record: record({
            version: "v2",
            createdAt: "2026-07-25T00:00:00.000Z",
            releases: [
              { version: "v2", runId: "run_9", ts: "2026-07-25T01:00:00.000Z", passRate: 0.8 },
            ],
          }),
        },
      ],
      entries: [
        entry({ runId: "run_1", datasetName: "smoke@v1" }),
        entry({ runId: "run_2", datasetName: "smoke@v1#dev", ts: "2026-07-22T00:00:00.000Z" }),
        entry({ runId: "run_9", datasetName: "smoke@v2#test" }),
        entry({ runId: "run_x", datasetName: "other@v1" }),
      ],
      now: NOW,
      loadOutcomes,
    });
    expect(report.versions.length).toBe(2);
    const v1 = report.versions[0];
    expect(v1?.ageDays).toBe(5);
    expect(v1?.runCount).toBe(2);
    expect(v1?.lastRunTs).toBe("2026-07-22T00:00:00.000Z");
    expect(v1?.testRunCount).toBe(0);
    expect(v1?.releaseCount).toBe(0);
    const v2 = report.versions[1];
    expect(v2?.ageDays).toBe(0);
    expect(v2?.runCount).toBe(1);
    expect(v2?.testRunCount).toBe(1);
    expect(v2?.releaseCount).toBe(1);
    expect(report.runsJoined).toBe(3);
    expect(report.totalReleases).toBe(1);
    // No outcomes loadable → no saturation block.
    expect(report.saturation).toBeUndefined();
  });

  test("always-passing needs ≥2 appearances and zero failures", async () => {
    outcomes.clear();
    outcomes.set("/runs/1", [
      { sampleId: "a", passed: true },
      { sampleId: "b", passed: true },
      { sampleId: "c", passed: false },
    ]);
    outcomes.set("/runs/2", [
      { sampleId: "a", passed: true },
      { sampleId: "b", passed: false },
      { sampleId: "d", passed: true }, // appears once — not enough evidence
    ]);
    const report = await computeDatasetStatus({
      name: "smoke",
      versions: [{ version: "v1", record: record() }],
      entries: [
        entry({ runId: "run_1", outDir: "/runs/1" }),
        entry({ runId: "run_2", outDir: "/runs/2" }),
        entry({ runId: "run_3", outDir: "/runs/unreadable" }),
      ],
      now: NOW,
      loadOutcomes,
    });
    expect(report.saturation?.runsConsidered).toBe(2);
    expect(report.saturation?.alwaysPassing).toEqual(["a"]);
    const lines = statusSummaryLines(report);
    expect(lines.some((l) => l.includes("rotation candidates: a"))).toBe(true);
  });

  test("the saturation window is the CHRONOLOGICAL last N even when runs interleave across versions", async () => {
    outcomes.clear();
    // Index order (oldest-first): a v2 run FIRST, then two newer v1 runs —
    // the shape of re-running v1 baselines after v2 evals started. A
    // per-version join (v1 runs then v2 runs) would slice a tail of
    // [r3, r1] — dropping the recent r2 while keeping the stale r1.
    outcomes.set("/runs/r1", [{ sampleId: "b", passed: true }]);
    outcomes.set("/runs/r2", [{ sampleId: "a", passed: true }]);
    outcomes.set("/runs/r3", [{ sampleId: "a", passed: true }]);
    const report = await computeDatasetStatus({
      name: "smoke",
      versions: [
        { version: "v1", record: record() },
        { version: "v2", record: record({ version: "v2" }) },
      ],
      entries: [
        entry({
          runId: "r1",
          datasetName: "smoke@v2",
          ts: "2026-07-21T00:00:00.000Z",
          outDir: "/runs/r1",
        }),
        entry({
          runId: "r2",
          datasetName: "smoke@v1",
          ts: "2026-07-22T00:00:00.000Z",
          outDir: "/runs/r2",
        }),
        entry({
          runId: "r3",
          datasetName: "smoke@v1#dev",
          ts: "2026-07-23T00:00:00.000Z",
          outDir: "/runs/r3",
        }),
      ],
      now: NOW,
      lastN: 2,
      loadOutcomes,
    });
    // Window = [r2, r3]: "a" appears twice, always passing; "b" (only in
    // the stale r1) contributes nothing.
    expect(report.saturation?.runsConsidered).toBe(2);
    expect(report.saturation?.alwaysPassing).toEqual(["a"]);
  });

  test("lastN bounds the saturation window to the newest joined runs", async () => {
    outcomes.clear();
    outcomes.set("/runs/old", [{ sampleId: "old-only", passed: true }]);
    outcomes.set("/runs/n1", [{ sampleId: "a", passed: true }]);
    outcomes.set("/runs/n2", [{ sampleId: "a", passed: true }]);
    const report = await computeDatasetStatus({
      name: "smoke",
      versions: [{ version: "v1", record: record() }],
      entries: [
        entry({ runId: "r0", outDir: "/runs/old" }),
        entry({ runId: "r1", outDir: "/runs/n1" }),
        entry({ runId: "r2", outDir: "/runs/n2" }),
      ],
      now: NOW,
      lastN: 2,
      loadOutcomes,
    });
    expect(report.saturation?.runsConsidered).toBe(2);
    expect(report.saturation?.alwaysPassing).toEqual(["a"]);
  });

  test("status table rows render one line per version", async () => {
    outcomes.clear();
    const report = await computeDatasetStatus({
      name: "smoke",
      versions: [{ version: "v1", record: record() }],
      entries: [],
      now: NOW,
      loadOutcomes,
    });
    const rows = statusTableRows(report);
    expect(rows.length).toBe(1);
    expect(rows[0]?.[0]).toBe("v1");
    expect(rows[0]?.[1]).toBe("5d");
    expect(rows[0]?.[4]).toBe("-"); // no test split
  });
});

describe("datasets card — renderDatasetCard (B21)", () => {
  test("renders splits, provenance, release history, and the lint summary", () => {
    const rec = record({
      splits: {
        train: [sample("t1", "a", "synthetic"), sample("t2", "b")],
        dev: [sample("d1", "c", "production_log")],
        test: [sample("x1", "q", "human_authored")],
      },
      sampleHashes: { train: ["h1", "h2"], dev: ["h3"], test: ["h4"] },
      releases: [{ version: "v1", runId: "run_7", ts: "2026-07-24T00:00:00.000Z", passRate: 0.75 }],
    });
    const samples = [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])];
    const findings: LintFinding[] = [
      { rule: "duplicate-id", severity: "error", message: 'duplicate sample id "t1"' },
    ];
    const card = renderDatasetCard({
      name: "smoke",
      version: "v1",
      record: rec,
      provenance: provenanceBreakdown(samples),
      lintFindings: findings,
      runCount: 3,
      now: NOW,
    });
    expect(card).toContain("# Dataset card — smoke@v1");
    expect(card).toContain("| train | 2 | 2 |");
    expect(card).toContain("| test | 1 | 1 |");
    expect(card).toContain("| synthetic | 1 | 25% |");
    expect(card).toContain("| (untagged) | 1 | 25% |");
    expect(card).toContain("| 2026-07-24T00:00:00.000Z | run_7 | 75.0% |");
    expect(card).toContain("**Test-split burn:** 1 release(s)");
    expect(card).toContain("**Indexed eval runs:** 3");
    expect(card).toContain("1 error(s), 0 warning(s)");
    expect(card).toContain("`duplicate-id`");
  });

  test("an unreleased, clean dataset says so", () => {
    const rec = record();
    const card = renderDatasetCard({
      name: "smoke",
      version: "v1",
      record: rec,
      provenance: provenanceBreakdown([...rec.splits.train, ...rec.splits.dev]),
      lintFindings: [],
      runCount: 0,
      now: NOW,
    });
    expect(card).toContain("Test split never released");
    expect(card).toContain("Clean — 0 errors, 0 warnings");
  });
});
