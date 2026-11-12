import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINES_FILENAME,
  type RunIndexEntry,
  baselineKeyFor,
  lineageOfEntry,
  readBaselines,
} from "./history";
import { measurementProblem, pinFromIndexEntry, pinRefusal, pinRun } from "./pin";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-pin-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
  runId: "run_a",
  specName: "shop",
  specHash: "h",
  datasetName: "smoke",
  datasetHash: "d",
  passRate: 1,
  meanScore: 1,
  sampleCount: 3,
  ts: "2026-11-01T00:00:00.000Z",
  outDir: "/abs/run_a",
  ...overrides,
});

describe("what a run cannot be pinned for", () => {
  test("a budget-aborted run: its aborted samples read as failures", () => {
    const refusal = pinRefusal(entry({ partial: true, errorCount: 1 }));
    expect(refusal?.code).toBe("partial");
    expect(refusal?.reason).toContain("partial (budget-aborted)");
    expect(refusal?.reason).toContain("regression read as a recovery");
  });

  test("a run from another lineage, when the caller named one", () => {
    const key = baselineKeyFor(lineageOfEntry(entry()));
    const fast = entry({ armId: "fast", routing: "candidate:fast" });
    const refusal = pinRefusal(fast, { lineageKey: key });
    expect(refusal?.code).toBe("lineage_mismatch");
    expect(refusal?.reason).toContain(`not ${key}`);
    expect(pinRefusal(fast)).toBeUndefined();
    expect(pinRefusal(entry(), { lineageKey: key })).toBeUndefined();
  });

  test("a run in which every case errored", () => {
    const refusal = pinRefusal(entry({ errorCount: 3, measuredCount: 0 }));
    expect(refusal?.code).toBe("all_errored");
    expect(refusal?.reason).toContain("every case errored");
  });

  test("a run with no verdict at all, and a run with no samples", () => {
    const abstained = pinRefusal(entry({ measuredCount: 0 }));
    expect(abstained?.code).toBe("nothing_measured");
    expect(abstained?.reason).toContain("measured nothing");
    expect(pinRefusal(entry({ sampleCount: 0 }))?.code).toBe("nothing_measured");
  });

  test("the checks run in order: partial, then lineage, then what was measured", () => {
    const key = baselineKeyFor(lineageOfEntry(entry()));
    const fast = { armId: "fast", routing: "candidate:fast" } as const;
    const all = { errorCount: 3, measuredCount: 0 };
    expect(pinRefusal(entry({ partial: true, ...fast }), { lineageKey: key })?.code).toBe(
      "partial",
    );
    expect(pinRefusal(entry({ ...fast, ...all }), { lineageKey: key })?.code).toBe(
      "lineage_mismatch",
    );
    expect(pinRefusal(entry(all))?.code).toBe("all_errored");
  });
});

describe("what a run can be pinned despite", () => {
  test("a clean row, and an old row with no columns", () => {
    expect(pinRefusal(entry())).toBeUndefined();
    expect(measurementProblem(entry())).toBeUndefined();
  });

  test("two of three errored: the one verdict left is still a measurement", () => {
    expect(pinRefusal(entry({ errorCount: 2, measuredCount: 1 }))).toBeUndefined();
  });

  test("a canary beside a measured sample", () => {
    expect(pinRefusal(entry({ sampleCount: 2, measuredCount: 1 }))).toBeUndefined();
  });

  test("a row that does not say how many samples it had is not read as all errored", () => {
    const { sampleCount: _gone, ...torn } = entry();
    expect(measurementProblem(torn as RunIndexEntry)).toBeUndefined();
  });
});

describe("pinFromIndexEntry", () => {
  test("every lineage and instrument column survives, in a stable order", () => {
    const outcome = pinFromIndexEntry(
      entry({
        specSource: "/abs/crewhaus.yaml",
        gradersHash: "g",
        judgeModel: "j",
        p95LatencyMs: 12,
        costUsd: 0.5,
        armId: "fast",
        routing: "candidate:fast",
        policyVersion: "p",
        armsDigest: "a",
      }),
      "2026-11-02T00:00:00.000Z",
    );
    if (!outcome.ok) throw new Error("expected a pin");
    expect(Object.entries(outcome.pin)).toEqual([
      ["specName", "shop"],
      ["datasetName", "smoke"],
      ["runId", "run_a"],
      ["specSource", "/abs/crewhaus.yaml"],
      ["outDir", "/abs/run_a"],
      ["datasetHash", "d"],
      ["gradersHash", "g"],
      ["judgeModel", "j"],
      ["p95LatencyMs", 12],
      ["costUsd", 0.5],
      ["armId", "fast"],
      ["routing", "candidate:fast"],
      ["policyVersion", "p"],
      ["armsDigest", "a"],
      ["ts", "2026-11-02T00:00:00.000Z"],
    ]);
  });

  test("absent columns stay absent, and a refusal carries no pin", () => {
    const outcome = pinFromIndexEntry(entry(), "t");
    if (!outcome.ok) throw new Error("expected a pin");
    expect(Object.keys(outcome.pin)).toEqual([
      "specName",
      "datasetName",
      "runId",
      "outDir",
      "datasetHash",
      "ts",
    ]);
    expect(pinFromIndexEntry(entry({ partial: true }), "t")).toMatchObject({
      ok: false,
      refusal: { code: "partial" },
    });
  });
});

describe("pinRun", () => {
  test("a refusal leaves the file absent", () => {
    const evalsDir = newTempRoot();
    const outcome = pinRun(entry({ errorCount: 3, measuredCount: 0 }), "t", evalsDir);
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(evalsDir, BASELINES_FILENAME))).toBe(false);
  });

  test("a pinnable run is written under its own lineage", () => {
    const evalsDir = newTempRoot();
    const outcome = pinRun(entry(), "2026-11-02T00:00:00.000Z", evalsDir);
    expect(outcome.ok).toBe(true);
    expect(readBaselines(evalsDir)["shop::smoke"]?.runId).toBe("run_a");
  });

  test("the writer's own refusal still throws", () => {
    const evalsDir = newTempRoot();
    writeFileSync(join(evalsDir, BASELINES_FILENAME), "[]");
    expect(() => pinRun(entry(), "t", evalsDir)).toThrow(/not a JSON object/);
  });
});

describe("a pin over a different instrument records the re-anchor", () => {
  test("a manual pin over another instrument is marked manual, naming the run it replaced", () => {
    const evalsDir = newTempRoot();
    expect(pinRun(entry({ runId: "run_a", gradersHash: "g1" }), "t1", evalsDir).ok).toBe(true);
    const replaced = pinRun(entry({ runId: "run_b", gradersHash: "g2" }), "t2", evalsDir, {
      cmd: "crewhaus eval-report baseline set",
    });
    expect(replaced.ok && replaced.pin.rebaselined).toEqual({
      from: "run_a",
      reason: "manual",
      cmd: "crewhaus eval-report baseline set",
    });
    expect(readBaselines(evalsDir)["shop::smoke"]?.rebaselined?.from).toBe("run_a");
  });

  test("over the same instrument, or where a field is unverifiable, there is no mark", () => {
    const evalsDir = newTempRoot();
    pinRun(entry({ runId: "run_a", gradersHash: "g1" }), "t1", evalsDir);
    const same = pinRun(entry({ runId: "run_b", gradersHash: "g1" }), "t2", evalsDir, { cmd: "x" });
    expect(same.ok && same.pin.rebaselined).toBeUndefined();
    // A calibration digest on one side of two rows cannot be told from an old row.
    const oneSided = pinRun(
      entry({ runId: "run_c", gradersHash: "g1", calibrationDigest: "c" }),
      "t3",
      evalsDir,
      { cmd: "x" },
    );
    expect(oneSided.ok && oneSided.pin.rebaselined).toBeUndefined();
  });

  test("a caller's own re-anchor is recorded as given", () => {
    const evalsDir = newTempRoot();
    const pinned = pinRun(entry(), "t", evalsDir, {
      rebaselined: { reason: "reset", cmd: "crewhaus eval --rebaseline" },
    });
    expect(pinned.ok && pinned.pin.rebaselined).toEqual({
      reason: "reset",
      cmd: "crewhaus eval --rebaseline",
    });
  });

  test("the pin carries the run's calibration and plugin digests", () => {
    const outcome = pinFromIndexEntry(
      entry({ calibrationDigest: "c", pluginsDigest: "p", armsDigest: "a" }),
      "t",
    );
    if (!outcome.ok) throw new Error("expected a pin");
    expect(Object.keys(outcome.pin).slice(-4)).toEqual([
      "armsDigest",
      "calibrationDigest",
      "pluginsDigest",
      "ts",
    ]);
  });
});
