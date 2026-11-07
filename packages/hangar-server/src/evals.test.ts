/**
 * Eval health says three things: healthy, regressed, or not measured. "No news"
 * must not read as good news, and a history nobody could read must not read as
 * an empty one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunIndexEntry, appendRunIndex, pinRun, readBaselines } from "@crewhaus/eval-report";
import {
  CORPUS_CASES,
  runCorpusCase,
  runCorpusEval,
  runCorpusPartial,
  runCorpusResumed,
} from "./__test__/eval-corpus";
import {
  evalHealth,
  evalHealthyFlag,
  evalRunView,
  evalSampleView,
  evalsView,
  isOptRunId,
} from "./evals";

const TMP_ROOTS: string[] = [];
function harness(): string {
  const dir = mkdtempSync(join(tmpdir(), "hangar-evals-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const SPEC = "corpus-harness";
const evalsDirOf = (dir: string): string => join(dir, ".crewhaus", "evals");

const row = (runId: string, passRate: number, ts: string, extra: Partial<RunIndexEntry> = {}) =>
  ({
    runId,
    specName: SPEC,
    specHash: "h",
    datasetName: "smoke",
    datasetHash: "d",
    passRate,
    meanScore: passRate,
    sampleCount: 2,
    ts,
    outDir: "/gone",
    ...extra,
  }) satisfies RunIndexEntry;

/** A pinned baseline at `base`, then a newer run. */
function pinned(latest: RunIndexEntry, base = row("run_base", 0.8, "2026-01-01T00:00:00Z")) {
  const dir = evalsDirOf(harness());
  appendRunIndex(base, dir);
  appendRunIndex(latest, dir);
  const pin = pinRun(base, base.ts, dir);
  if (!pin.ok) throw new Error("the baseline must be pinnable");
  return dir;
}

const NEXT = "2026-01-02T00:00:00Z";

describe("evalHealth", () => {
  test("no runs at all", () => {
    expect(evalHealth(evalsDirOf(harness()), SPEC)).toEqual({
      state: "not_measured",
      note: "no eval runs recorded",
    });
  });

  test("runs, but nothing pinned", () => {
    const dir = evalsDirOf(harness());
    appendRunIndex(row("run_a", 0.5, NEXT), dir);
    expect(evalHealth(dir, SPEC)).toEqual({ state: "not_measured", note: "no baseline pinned" });
  });

  test("a pin whose run is gone from the index", () => {
    const dir = pinned(row("run_a", 0.9, NEXT));
    const other = evalsDirOf(harness());
    appendRunIndex(row("run_a", 0.9, NEXT), other);
    writeFileSync(
      join(other, "baselines.json"),
      JSON.stringify({ [`${SPEC}::smoke`]: readBaselines(dir)[`${SPEC}::smoke`] }),
    );
    expect(evalHealth(other, SPEC)).toEqual({
      state: "not_measured",
      note: "baseline run missing from index",
    });
  });

  test.each([
    [{ partial: true }, "the latest run stopped at its budget"],
    [{ errorCount: 2, measuredCount: 0 }, "every case in the latest run errored"],
    [{ measuredCount: 0 }, "the latest run measured nothing"],
  ])("a latest run that measured nothing (%j)", (columns, note) => {
    // Its passRate of 0 would otherwise read as a regression.
    const dir = pinned(row("run_a", 0, NEXT, columns));
    expect(evalHealth(dir, SPEC)).toEqual({ state: "not_measured", note });
  });

  test("holding the baseline, and falling below it", () => {
    expect(evalHealth(pinned(row("run_a", 0.8, NEXT)), SPEC).state).toBe("healthy");
    const fell = evalHealth(pinned(row("run_a", 0.5, NEXT)), SPEC);
    expect(fell.state).toBe("regressed");
    expect(fell.note).toContain("below baseline");
  });

  test("a resumed baseline counts its newest line, not its oldest", () => {
    // Baseline run lines 0.4 then 0.9, latest 0.6: read raw, 0.6 "holds" 0.4.
    const dir = evalsDirOf(harness());
    const older = row("run_base", 0.4, "2026-01-01T00:00:00Z");
    const resumed = row("run_base", 0.9, "2026-01-01T06:00:00Z");
    appendRunIndex(older, dir);
    appendRunIndex(resumed, dir);
    appendRunIndex(row("run_a", 0.6, NEXT), dir);
    if (!pinRun(resumed, resumed.ts, dir).ok) throw new Error("must pin");
    expect(evalHealth(dir, SPEC).state).toBe("regressed");
  });

  test("an unreadable index names the file and nothing else", () => {
    const dir = evalsDirOf(harness());
    mkdirSync(join(dir, "index.jsonl"), { recursive: true });
    const health = evalHealth(dir, SPEC);
    expect(health.state).toBe("not_measured");
    expect(health.note).toBe(
      "Couldn't read the eval history: .crewhaus/evals/index.jsonl is not readable.",
    );
    expect(health.note).not.toContain(dir);
  });

  test("an unreadable pin file names itself, with no parser text", () => {
    const dir = evalsDirOf(harness());
    appendRunIndex(row("run_a", 0.5, NEXT), dir);
    writeFileSync(join(dir, "baselines.json"), "{ not json");
    expect(evalHealth(dir, SPEC)).toEqual({
      state: "not_measured",
      note: "Couldn't read the eval history: .crewhaus/evals/baselines.json is not readable.",
    });
  });
});

describe("evalHealthyFlag", () => {
  test("only a measured answer becomes a boolean", () => {
    expect(evalHealthyFlag({ state: "healthy", note: "" })).toBe(true);
    expect(evalHealthyFlag({ state: "regressed", note: "" })).toBe(false);
    expect(evalHealthyFlag({ state: "not_measured", note: "" })).toBeNull();
  });
});

describe("evalsView", () => {
  test("an unreadable history is reported, not read as no evals", () => {
    const dir = harness();
    mkdirSync(join(evalsDirOf(dir), "index.jsonl"), { recursive: true });
    const view = evalsView(dir);
    expect(view.runs).toEqual([]);
    expect(view.unreadable).toContain(".crewhaus/evals/index.jsonl");
    expect(view.unreadable).not.toContain(dir);
  });

  test("a missing history is simply empty", () => {
    expect(evalsView(harness()).unreadable).toBeNull();
  });

  test("a row that cannot be pinned says why; a clean row carries no such field", async () => {
    const dir = harness();
    await runCorpusCase(dir, "all-errored", { runId: "run_00000000000000e1" });
    await runCorpusCase(dir, "pass", { runId: "run_00000000000000e2" });
    const byId = new Map(evalsView(dir).runs.map((r) => [r.runId, r]));
    expect(byId.get("run_00000000000000e1")?.pinRefusal).toBe(
      "Every case errored, so it can't be a baseline.",
    );
    expect(byId.get("run_00000000000000e2")).not.toHaveProperty("pinRefusal");
  }, 20_000); // loads the whole eval runner

  test("the console's reason is plain words, whatever a tool is told", async () => {
    const dir = harness();
    await runCorpusPartial(dir, { runId: "run_00000000000000e3" });
    await runCorpusCase(dir, "zero-measured", { runId: "run_00000000000000e4" });
    const byId = new Map(evalsView(dir).runs.map((r) => [r.runId, r]));
    expect(byId.get("run_00000000000000e3")?.pinRefusal).toBe(
      "Stopped at its budget, so it can't be a baseline.",
    );
    expect(byId.get("run_00000000000000e4")?.pinRefusal).toBe(
      "No case got a verdict, so it can't be a baseline.",
    );
    for (const run of evalsView(dir).runs) {
      expect(run.pinRefusal).not.toContain(run.runId);
      expect(run.pinRefusal).not.toContain("budget-aborted");
    }
  }, 20_000); // loads the whole eval runner
});

describe("evalRunView reads what the runner wrote", () => {
  test.each(Object.keys(CORPUS_CASES) as Array<keyof typeof CORPUS_CASES>)(
    "%s",
    async (name) => {
      const dir = harness();
      const runId = "run_00000000000000c1";
      const { summary, row: index } = await runCorpusCase(dir, name, { runId });
      const view = evalRunView(dir, runId);
      expect(view?.stats.passRate).toBe(summary.aggregates.passRate);
      expect(view?.stats.sampleCount).toBe(summary.samples.length);
      expect(view?.stats.errorCount).toBe(index.errorCount ?? 0);
      expect(view?.stats.measuredCount).toBe(index.measuredCount ?? summary.samples.length);
      expect(view?.rows.map((r) => r.sampleId)).toEqual(Object.keys(CORPUS_CASES[name]));
      // Every row links to a directory on disk, a repeat run's trials aside.
      for (const r of view?.rows ?? []) expect(view?.sampleIds).toContain(r.dir as string);
      expect(view?.rows.every((r) => r.verdict !== "unknown")).toBe(true);
    },
    20_000,
  );

  test("a resumed run reads as its newest self", async () => {
    const dir = harness();
    const runId = "run_00000000000000c2";
    const { second } = await runCorpusResumed(dir, { runId });
    const view = evalRunView(dir, runId);
    expect(view?.stats.passRate).toBe(second.summary.aggregates.passRate);
    expect(view?.rows.map((r) => r.verdict)).toEqual(["pass", "pass"]);
  }, 20_000);

  test("a sample id that needed sanitizing joins to its directory", async () => {
    const dir = harness();
    const runId = "run_00000000000000c3";
    await runCorpusCase(dir, "sanitized", { runId });
    expect(evalRunView(dir, runId)?.rows[0]).toMatchObject({ sampleId: "a/b", dir: "a_b" });
  }, 20_000);

  test("a canary reads as one, and is not measured", async () => {
    const dir = harness();
    const runId = "run_00000000000000c4";
    await runCorpusEval(dir, { s1: "pass" }, { runId, canaries: { c1: "pass" } });
    const view = evalRunView(dir, runId);
    expect(view?.rows.find((r) => r.sampleId === "c1")?.verdict).toBe("canary");
    expect(view?.stats.measuredCount).toBe(1);
  }, 20_000);

  test("a partial run says so, though its results file records an object", async () => {
    const dir = harness();
    const runId = "run_00000000000000c5";
    await runCorpusPartial(dir, { runId });
    expect(evalRunView(dir, runId)?.stats.partial).toBe(true);
  }, 20_000);

  test("cost is the index row's, and an unpriced run's is null", async () => {
    const dir = harness();
    const runId = "run_00000000000000c6";
    await runCorpusCase(dir, "pass", { runId });
    expect(evalRunView(dir, runId)?.stats.costUsd).toBeNull();
  }, 20_000);
});

test("optimizer ids are the minted shape, and only that", () => {
  expect(isOptRunId(`opt_${Date.now().toString(16)}`)).toBe(true);
  expect(isOptRunId("run_00000000000000aa")).toBe(false);
  expect(isOptRunId("opt_")).toBe(false);
  expect(isOptRunId("opt_XYZ")).toBe(false);
  expect(isOptRunId(`opt_${"a".repeat(33)}`)).toBe(false);
});

describe("a sample's page and its run's table say the same thing", () => {
  const RUN = "run_00000000000000f1";

  test("for every verdict, read from what the runner really wrote", async () => {
    const dir = harness();
    await runCorpusEval(
      dir,
      { good: "pass", bad: "fail", broken: "error", unsure: "abstain" },
      { runId: RUN, canaries: { planted: "pass" } },
    );
    const rows = evalRunView(dir, RUN)?.rows ?? [];
    expect(rows.map((r) => [r.sampleId, r.verdict]).sort()).toEqual([
      ["bad", "fail"],
      ["broken", "error"],
      ["good", "pass"],
      ["planted", "canary"],
      ["unsure", "abstained"],
    ]);
    for (const row of rows) {
      const view = evalSampleView(dir, RUN, row.dir as string);
      expect(view?.verdict).toBe(row.verdict);
      expect(view?.note).toBe(row.note);
    }
  }, 20_000); // loads the whole eval runner

  test("a crash says so, though its grades.json reads as a plain failure", async () => {
    const dir = harness();
    await runCorpusCase(dir, "all-errored", { runId: RUN });
    const view = evalSampleView(dir, RUN, "s1");
    expect((view?.grades as { overall: { passed: boolean } }).overall.passed).toBe(false);
    expect(view?.verdict).toBe("error");
    expect(view?.note).toContain("invoker failed on s1");
  }, 20_000); // loads the whole eval runner

  test("a torn results file falls back to the sample's own record of a crash", async () => {
    const dir = harness();
    await runCorpusCase(dir, "all-errored", { runId: RUN });
    writeFileSync(join(evalsDirOf(dir), RUN, "results.json"), "{ torn");
    const view = evalSampleView(dir, RUN, "s1");
    expect(view?.verdict).toBe("error");
    expect(view?.note).toContain("invoker failed on s1");
  }, 20_000); // loads the whole eval runner

  test("with nothing recorded about it, a sample claims no verdict", async () => {
    const dir = harness();
    await runCorpusEval(dir, { s1: "fail" }, { runId: RUN });
    writeFileSync(join(evalsDirOf(dir), RUN, "results.json"), "{ torn");
    const view = evalSampleView(dir, RUN, "s1");
    expect(view?.verdict).toBeNull();
    expect(typeof view?.note).toBe("string");
  }, 20_000); // loads the whole eval runner
});
