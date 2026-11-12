import { describe, expect, test } from "bun:test";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import type { RunIndexEntry } from "./history";
import { INSTRUMENT_FIELDS, instrumentChanges, instrumentOf } from "./instrument";

function summary(config: Partial<EvalRunSummary["config"]> = {}): EvalRunSummary {
  return {
    runId: "run_x",
    startedAt: "2026-11-01T00:00:00Z",
    endedAt: "2026-11-01T00:00:01Z",
    samples: [],
    aggregates: {
      passRate: 1,
      meanScore: 1,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 1,
      p95LatencyMs: 1,
      totalTokens: { input: 0, output: 0 },
      errorCount: 0,
    },
    config: {
      specHash: "s",
      datasetName: "d",
      graderNames: [],
      model: "m",
      concurrency: 1,
      ...config,
    },
    outDir: "/x",
  };
}

function row(extra: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId: "run_r",
    specName: "s",
    specHash: "h",
    datasetName: "d",
    datasetHash: "dh",
    passRate: 1,
    meanScore: 1,
    sampleCount: 1,
    ts: "2026-11-01T00:00:00Z",
    outDir: "/x",
    ...extra,
  };
}

const calibration = (minScore: number) => ({
  judgeCalibration: {
    path: ".crewhaus/judge-calibration.json",
    applied: [{ grader: "j", specKey: "s", minScore, passingScore: 1 + 4 * minScore }],
  },
});

describe("instrumentOf", () => {
  test("reads a summary's instrument, its calibration digest and its routing", () => {
    const i = instrumentOf(
      summary({
        gradersHash: "g",
        judgeModel: "j",
        pluginsDigest: "p",
        cliVersion: "0.9.0",
        routing: { mode: "as-declared", armsDigest: "a", policyVersion: "v" },
        ...calibration(0.5),
      }),
    );
    expect(i).toMatchObject({
      source: "summary",
      routed: true,
      cliVersion: "0.9.0",
      gradersHash: "g",
      judgeModel: "j",
      pluginsDigest: "p",
      armsDigest: "a",
      policyVersion: "v",
    });
    expect(i.calibrationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(instrumentOf(summary()).calibrationDigest).toBeUndefined();
  });

  test("reads a row's columns, and a row is routed by its arm", () => {
    expect(instrumentOf(row({ armId: "fast", gradersHash: "g" }))).toMatchObject({
      source: "row",
      routed: true,
      gradersHash: "g",
    });
    expect(instrumentOf(row()).routed).toBe(false);
  });
});

describe("instrumentChanges", () => {
  test("every field present on both sides and different is a change", () => {
    for (const field of INSTRUMENT_FIELDS) {
      const a = row({ [field]: "one", armId: "x" });
      const b = row({ [field]: "two", armId: "x" });
      expect(instrumentChanges(a, b)).toEqual([{ field, from: "one", to: "two" }]);
      expect(instrumentChanges(a, a)).toEqual([]);
    }
  });

  test("a judge pinned on one side only is a change, on rows and on summaries", () => {
    expect(instrumentChanges(row({ judgeModel: "j" }), row())).toEqual([
      { field: "judgeModel", from: "j" },
    ]);
    expect(instrumentChanges(summary(), summary({ judgeModel: "j" }))).toEqual([
      { field: "judgeModel", to: "j" },
    ]);
  });

  test("a graders hash on one side only is unverified", () => {
    expect(instrumentChanges(summary({ gradersHash: "g" }), summary())).toEqual([
      { field: "gradersHash", from: "g", unverified: true },
    ]);
  });

  test("a calibration on one side only is a change between summaries and unverified against a row", () => {
    const calibrated = summary(calibration(0.5));
    const changes = instrumentChanges(summary(), calibrated);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ field: "calibrationDigest" });
    expect(changes[0]?.unverified).toBeUndefined();
    // A row written before the column cannot be told from an uncalibrated run.
    expect(instrumentChanges(row(), calibrated)[0]).toMatchObject({
      field: "calibrationDigest",
      unverified: true,
    });
    // A different calibration is a change wherever it is read.
    expect(instrumentChanges(calibrated, summary(calibration(0.75))).map((c) => c.field)).toEqual([
      "calibrationDigest",
    ]);
  });

  test("a plugin digest on one side only is a change only when the absent side recorded it (0.9.0 or later)", () => {
    const plugged = summary({ pluginsDigest: "p", cliVersion: "0.9.0" });
    expect(instrumentChanges(summary({ cliVersion: "0.9.1" }), plugged)).toEqual([
      { field: "pluginsDigest", to: "p" },
    ]);
    for (const cliVersion of [undefined, "0.8.2", "garbled"]) {
      const before = summary(cliVersion !== undefined ? { cliVersion } : {});
      expect(instrumentChanges(before, plugged)).toEqual([
        { field: "pluginsDigest", to: "p", unverified: true },
      ]);
    }
    expect(instrumentChanges(row(), row({ pluginsDigest: "p" }))).toEqual([
      { field: "pluginsDigest", to: "p", unverified: true },
    ]);
  });

  test("an arm snapshot or policy on one side only is unverified on a routed lineage and nothing on an unrouted one", () => {
    expect(
      instrumentChanges(row({ armId: "fast", armsDigest: "a" }), row({ armId: "fast" })),
    ).toEqual([{ field: "armsDigest", from: "a", unverified: true }]);
    expect(instrumentChanges(row({ policyVersion: "v" }), row())).toEqual([]);
  });

  test("cliVersion and specHash are notes, never changes", () => {
    expect(
      instrumentChanges(
        summary({ cliVersion: "0.9.0", specHash: "a" }),
        summary({ cliVersion: "0.9.1", specHash: "b" }),
      ),
    ).toEqual([]);
  });
});
