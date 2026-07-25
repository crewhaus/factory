import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportError } from "./errors";
import {
  BASELINES_FILENAME,
  type BaselineEntry,
  INDEX_FILENAME,
  type RunIndexEntry,
  appendRunIndex,
  baselineKey,
  getBaseline,
  hashDatasetFile,
  readBaselines,
  readRunIndex,
  setBaseline,
} from "./history";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-history-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeEntry(runId: string, overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId,
    specName: "concierge",
    specHash: "abc123",
    datasetName: "smoke",
    datasetHash: "d".repeat(64),
    passRate: 0.8,
    meanScore: 0.75,
    sampleCount: 5,
    ts: "2026-07-01T00:00:00.000Z",
    outDir: `/abs/evals/${runId}`,
    ...overrides,
  };
}

function makePin(runId: string, overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    specName: "concierge",
    datasetName: "smoke",
    runId,
    outDir: `/abs/evals/${runId}`,
    datasetHash: "d".repeat(64),
    ts: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("hashDatasetFile", () => {
  test("sha256 of the file bytes, stable across calls", () => {
    const dir = newTempRoot();
    const path = join(dir, "dataset.jsonl");
    const content = '{"id":"q1","input":"hi"}\n';
    writeFileSync(path, content);
    const expected = createHash("sha256").update(content).digest("hex");
    expect(hashDatasetFile(path)).toBe(expected);
    expect(hashDatasetFile(path)).toBe(expected);
  });

  test("different bytes produce different hashes", () => {
    const dir = newTempRoot();
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, '{"id":"q1"}\n');
    writeFileSync(b, '{"id":"q2"}\n');
    expect(hashDatasetFile(a)).not.toBe(hashDatasetFile(b));
  });
});

describe("run index (index.jsonl)", () => {
  test("append then read round-trips, oldest first", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    appendRunIndex(makeEntry("run_aaaa1111aaaa1111"), evalsDir);
    appendRunIndex(makeEntry("run_bbbb2222bbbb2222", { passRate: 1 }), evalsDir);
    const entries = readRunIndex(evalsDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.runId).toBe("run_aaaa1111aaaa1111");
    expect(entries[1]?.runId).toBe("run_bbbb2222bbbb2222");
    expect(entries[1]?.passRate).toBe(1);
    // One JSON object per line on disk.
    const raw = readFileSync(join(evalsDir, INDEX_FILENAME), "utf-8");
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
  });

  test("gradersHash/judgeModel round-trip when present and stay absent when omitted", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    appendRunIndex(
      makeEntry("run_aaaa1111aaaa1111", {
        gradersHash: "g".repeat(64),
        judgeModel: "judge-model-x",
      }),
      evalsDir,
    );
    // A legacy-shaped entry (no instrument fields) in the same index.
    appendRunIndex(makeEntry("run_bbbb2222bbbb2222"), evalsDir);
    const [instrumented, legacy] = readRunIndex(evalsDir);
    expect(instrumented?.gradersHash).toBe("g".repeat(64));
    expect(instrumented?.judgeModel).toBe("judge-model-x");
    expect(legacy?.gradersHash).toBeUndefined();
    expect(legacy?.judgeModel).toBeUndefined();
  });

  test("missing index file reads as empty", () => {
    expect(readRunIndex(join(newTempRoot(), "nope"))).toEqual([]);
  });

  test("corrupt/torn lines are skipped, valid lines survive", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    appendRunIndex(makeEntry("run_aaaa1111aaaa1111"), evalsDir);
    appendFileSync(join(evalsDir, INDEX_FILENAME), '{"runId":"run_torn\n');
    appendRunIndex(makeEntry("run_bbbb2222bbbb2222"), evalsDir);
    const entries = readRunIndex(evalsDir);
    expect(entries.map((e) => e.runId)).toEqual(["run_aaaa1111aaaa1111", "run_bbbb2222bbbb2222"]);
  });
});

describe("baselines (baselines.json)", () => {
  test("getBaseline is undefined before any pin; missing file reads as {}", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    expect(readBaselines(evalsDir)).toEqual({});
    expect(getBaseline("concierge", "smoke", evalsDir)).toBeUndefined();
  });

  test("set then get round-trips, keyed by (spec, dataset)", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    setBaseline(makePin("run_aaaa1111aaaa1111"), evalsDir);
    setBaseline(makePin("run_bbbb2222bbbb2222", { datasetName: "full" }), evalsDir);
    expect(getBaseline("concierge", "smoke", evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    expect(getBaseline("concierge", "full", evalsDir)?.runId).toBe("run_bbbb2222bbbb2222");
    expect(getBaseline("other-spec", "smoke", evalsDir)).toBeUndefined();
    expect(existsSync(join(evalsDir, BASELINES_FILENAME))).toBe(true);
  });

  test("re-pinning a key overwrites without touching other keys", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    setBaseline(makePin("run_aaaa1111aaaa1111"), evalsDir);
    setBaseline(makePin("run_cccc3333cccc3333", { datasetName: "full" }), evalsDir);
    setBaseline(makePin("run_bbbb2222bbbb2222"), evalsDir);
    expect(getBaseline("concierge", "smoke", evalsDir)?.runId).toBe("run_bbbb2222bbbb2222");
    expect(getBaseline("concierge", "full", evalsDir)?.runId).toBe("run_cccc3333cccc3333");
  });

  test("gradersHash/judgeModel round-trip on pins and stay absent when omitted", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    setBaseline(
      makePin("run_aaaa1111aaaa1111", { gradersHash: "g".repeat(64), judgeModel: "judge-model-x" }),
      evalsDir,
    );
    setBaseline(makePin("run_bbbb2222bbbb2222", { datasetName: "full" }), evalsDir);
    const instrumented = getBaseline("concierge", "smoke", evalsDir);
    expect(instrumented?.gradersHash).toBe("g".repeat(64));
    expect(instrumented?.judgeModel).toBe("judge-model-x");
    const legacy = getBaseline("concierge", "full", evalsDir);
    expect(legacy?.gradersHash).toBeUndefined();
    expect(legacy?.judgeModel).toBeUndefined();
  });

  test("malformed baselines.json throws ReportError", () => {
    const evalsDir = newTempRoot();
    writeFileSync(join(evalsDir, BASELINES_FILENAME), "{ not json,, }");
    expect(() => readBaselines(evalsDir)).toThrow(ReportError);
    expect(() => readBaselines(evalsDir)).toThrow(/failed to parse/);
  });

  test("baselineKey separates spec and dataset", () => {
    expect(baselineKey("a", "b")).toBe("a::b");
  });
});
