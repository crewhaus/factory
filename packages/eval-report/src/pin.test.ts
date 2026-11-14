import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINES_FILENAME,
  type RunIndexEntry,
  baselineKeyFor,
  lineageOfEntry,
  readBaselines,
} from "./history";
import {
  measurementProblem,
  pinFromIndexEntry,
  pinRefusal,
  pinRun,
  sameInstrumentRefusal,
} from "./pin";

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

  test("a regrade or a preview of another run, and pinRun writes nothing for it", () => {
    for (const purpose of ["regrade", "preview"] as const) {
      const refusal = pinRefusal(entry({ purpose, regradeOf: "run_src" }));
      expect(refusal?.code).toBe("regrade");
      expect(refusal?.reason).toContain(`is a ${purpose} of run run_src`);
    }
    const root = newTempRoot();
    const outcome = pinRun(entry({ purpose: "regrade", regradeOf: "run_src" }), "t", root);
    expect(outcome.ok).toBe(false);
    expect(existsSync(join(root, BASELINES_FILENAME))).toBe(false);
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

describe("a pin that keeps only same-instrument runs requires the instrument to be verifiably the same", () => {
  test("a graders hash recorded on one side only refuses the pin, and the file is byte-identical", () => {
    const evalsDir = newTempRoot();
    expect(pinRun(entry({ runId: "run_a", gradersHash: "g1" }), "t1", evalsDir).ok).toBe(true);
    const before = readFileSync(join(evalsDir, BASELINES_FILENAME));
    const outcome = pinRun(entry({ runId: "run_b" }), "t2", evalsDir, {
      sameInstrumentOnly: true,
      cmd: "x",
    });
    if (outcome.ok) throw new Error("pinned");
    expect(outcome.refusal.code).toBe("reanchor");
    expect(outcome.refusal.reason).toContain("gradersHash, recorded on one side only");
    expect(readFileSync(join(evalsDir, BASELINES_FILENAME)).equals(before)).toBe(true);
  });

  test("without sameInstrumentOnly the same pin is made, with no re-anchor mark", () => {
    const evalsDir = newTempRoot();
    pinRun(entry({ runId: "run_a", gradersHash: "g1" }), "t1", evalsDir);
    const outcome = pinRun(entry({ runId: "run_b" }), "t2", evalsDir, { cmd: "x" });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.pin.rebaselined).toBeUndefined();
  });

  test("the same instrument, the same run, or nothing replaced, is no refusal", () => {
    const pinned = pinFromIndexEntry(entry({ runId: "run_a", gradersHash: "g1" }), "t");
    if (!pinned.ok) throw new Error("expected a pin");
    expect(sameInstrumentRefusal(entry({ runId: "run_b", gradersHash: "g1" }), pinned.pin)).toBe(
      undefined,
    );
    expect(sameInstrumentRefusal(entry({ runId: "run_a" }), pinned.pin)).toBeUndefined();
    expect(sameInstrumentRefusal(entry({ runId: "run_b" }), undefined)).toBeUndefined();
  });

  test("a changed field is named without the one-sided note", () => {
    const pinned = pinFromIndexEntry(entry({ runId: "run_a", gradersHash: "g1" }), "t");
    if (!pinned.ok) throw new Error("expected a pin");
    const refused = sameInstrumentRefusal(entry({ runId: "run_b", gradersHash: "g2" }), pinned.pin);
    expect(refused?.code).toBe("reanchor");
    expect(refused?.reason).toContain("(gradersHash)");
  });
});

describe("a pin over a changed protected criterion needs the owner, on every path", () => {
  const guarded = (runId: string, digest: string) =>
    entry({ runId, outDir: `/abs/${runId}`, protectedCriteria: [{ id: "dates", digest }] });

  test("refused without an owner check, or when it says no, and the file is left as it was", () => {
    const root = newTempRoot();
    expect(pinRun(guarded("run_a", "d1"), "t1", root).ok).toBe(true);
    const before = readBaselines(root);
    for (const opts of [
      {},
      { ownerCheck: () => ({ ok: false as const, reason: "not the owner" }) },
    ]) {
      const outcome = pinRun(guarded("run_b", "d2"), "t2", root, opts);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.refusal.code).toBe("protected");
        expect(outcome.refusal.reason).toContain(
          "protected criterion dates is measured differently",
        );
        expect(outcome.refusal.reason).toContain("`crewhaus eval --rebaseline --reason <code>`");
      }
      expect(readBaselines(root)).toEqual(before);
    }
    // Unprotected, or gone: the same answer.
    const gone = pinRun(entry({ runId: "run_c", outDir: "/abs/run_c" }), "t3", root);
    expect(!gone.ok && gone.refusal.reason).toContain("dates is gone or unprotected");
  });

  test("with the owner it is pinned and marked; an unchanged one needs nobody", () => {
    const root = newTempRoot();
    pinRun(guarded("run_a", "d1"), "t1", root);
    let asked = 0;
    const outcome = pinRun(guarded("run_b", "d2"), "t2", root, {
      cmd: "test",
      ownerCheck: () => {
        asked += 1;
        return { ok: true };
      },
    });
    expect(asked).toBe(1);
    expect(outcome.ok && outcome.pin.rebaselined).toEqual({
      from: "run_a",
      reason: "manual",
      cmd: "test",
      protectedChange: true,
    });
    expect(outcome.ok && outcome.pin.protectedCriteria).toEqual([{ id: "dates", digest: "d2" }]);
    const same = pinRun(guarded("run_c", "d2"), "t3", root, {
      ownerCheck: () => {
        asked += 1;
        return { ok: false, reason: "never asked" };
      },
    });
    expect(same.ok).toBe(true);
    expect(asked).toBe(1);
  });

  test("a plan that names the pin it replaces is refused the same way", () => {
    const replaced = pinFromIndexEntry(guarded("run_a", "d1"), "t1");
    if (!replaced.ok) throw new Error("expected a pin");
    const outcome = pinFromIndexEntry(guarded("run_b", "d2"), "t2", { replaced: replaced.pin });
    expect(!outcome.ok && outcome.refusal.code).toBe("protected");
  });
});
