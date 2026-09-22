/**
 * The tool halves: what these five tools RETURN, and what they refuse.
 *
 * `lib.test.ts` covers the segmentation and the readers. This file drives each
 * tool end to end against real files in a real temporary workspace, because
 * every claim in this package is a claim about a result a gate will act on:
 *
 *   - no trend delta ever spans a cut. Asserted by checking the ENDPOINTS of
 *     every segment's trend against that segment's own runs, not by counting
 *     segments;
 *   - a refusal is asserted by its REASON, never by "it did not succeed" — a
 *     thrown error, a timeout or a missing file would satisfy the weaker test;
 *   - `dryRun` resolves through the same code as the real write, asserted by
 *     comparing what it said it WOULD write with what the real call then DID
 *     write, and by checking the file is untouched in between;
 *   - the destructive tool is checked against the FILE after every refusal,
 *     because "it returned an error" is not "it wrote nothing".
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTAINS_YAML,
  EVALS_DIR,
  JUDGE_YAML,
  REGISTRY_YAML,
  SESSIONS_DIR,
  goldens,
  makeWorkspace,
  pin,
  row,
  sample,
  writeBaselines,
  writeDataset,
  writeIndex,
  writeRun,
  writeSession,
} from "./fixtures";
import {
  EVALOPS_TOOLS,
  evalAggregate,
  evalBaselinePin,
  evalCoverage,
  evalHistory,
  graderMetaTest,
} from "./index";

let root: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  root = makeWorkspace();
  process.chdir(root);
});
afterEach(() => {
  process.chdir(previousCwd);
});

type Json = Record<string, unknown>;

async function call(
  tool: { execute: (i: unknown) => Promise<unknown> },
  input: Json,
): Promise<Json> {
  return JSON.parse(String(await tool.execute(input))) as Json;
}

const baselinesPath = (): string => join(root, EVALS_DIR, "baselines.json");

// --- EvalHistory -------------------------------------------------------------

test("a trend is cut at the graders change, and no delta spans the cut", async () => {
  writeIndex(root, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", passRate: 0.4 }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", passRate: 0.5 }),
    row({ runId: "r3", ts: "2026-01-03T00:00:00Z", passRate: 0.95, gradersHash: "graders-2" }),
    row({ runId: "r4", ts: "2026-01-04T00:00:00Z", passRate: 0.9, gradersHash: "graders-2" }),
  ]);
  const out = await call(evalHistory, {});
  const lineages = out["lineages"] as Json[];
  const segments = lineages[0]?.["segments"] as Json[];
  console.log(`SEGMENTS ${JSON.stringify(segments.map((s) => [s["index"], s["trend"]]))}`);
  expect(out["ok"]).toBe(true);
  expect(segments.length).toBe(2);

  // THE assertion: every trend's endpoints belong to its own segment, so no
  // reported delta can have been measured across the instrument change.
  for (const segment of segments) {
    const trend = segment["trend"] as Json | null;
    if (trend === null) continue;
    const ids = (segment["points"] as Json[]).map((p) => p["runId"]);
    expect(ids).toContain(trend["fromRunId"]);
    expect(ids).toContain(trend["toRunId"]);
  }
  // Whole-lineage first-to-last would be +50pp. The honest answers are +10 and -5.
  const deltas = segments.map((s) => (s["trend"] as Json | null)?.["passRateDeltaPp"]);
  expect(deltas).toEqual([10, -5]);
  const boundaries = lineages[0]?.["boundaries"] as Json[];
  expect(boundaries.some((b) => b["kind"] === "break")).toBe(true);
});

test("history says how many index lines it could not read", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }), "{torn"]);
  const out = await call(evalHistory, {});
  expect(out["runsRead"]).toBe(1);
  expect(out["unparsedLines"]).toBe(1);
  expect(String(out["unparsedLinesNote"])).toMatch(/not a run that never happened/);
});

test("a missing evals directory is a refusal, not an empty history", async () => {
  const out = await call(evalHistory, { evalsDir: ".crewhaus/nope" });
  expect(out["ok"]).toBe(false);
  expect(out["code"]).toBe("missing");
  expect(String(out["error"])).toMatch(/does not exist or is unreadable/);
});

test("a filter that matches nothing says so, and lists what IS there", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  const out = await call(evalHistory, { spec: "other" });
  expect(out["matchedRuns"]).toBe(0);
  expect(String(out["note"])).toMatch(/the index is not empty/);
  expect(out["availableSpecs"]).toEqual(["shop"]);
});

test("the dataset filter matches a union dataset's suffixed name", async () => {
  writeIndex(root, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", datasetName: "smoke" }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", datasetName: "smoke+regressions@v1" }),
    row({ runId: "r3", ts: "2026-01-03T00:00:00Z", datasetName: "smoke2" }),
  ]);
  const out = await call(evalHistory, { dataset: "smoke" });
  expect(out["matchedRuns"]).toBe(2);
});

test("drilling into a run lists its failures and keeps abstentions out of them", async () => {
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "ok", passed: true }),
      sample({ sampleId: "bad", passed: false, score: 0.1 }),
      sample({ sampleId: "undecided", passed: false, abstained: true }),
      sample({ sampleId: "crashed", passed: false, error: "invoker exploded" }),
    ],
  });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  const out = await call(evalHistory, { runId: "r1" });
  const run = out["run"] as Json;
  const failing = (run["failingSamples"] as Json[]).map((s) => s["sampleId"]);
  console.log(`FAILING ${failing.join(",")} ABSTAINED=${run["abstainedCount"]}`);
  expect(failing).toEqual(["bad", "crashed"]);
  // An abstention is a verdict nobody produced, so it is counted apart rather
  // than listed as a failure someone has to fix.
  expect(run["abstainedCount"]).toBe(1);
  expect(run["erroredCount"]).toBe(1);
  expect(run["lineageKey"]).toBe("shop::smoke");
});

test("drilling into a run whose directory is gone says so instead of reporting no failures", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  const out = await call(evalHistory, { runId: "r1" });
  const run = out["run"] as Json;
  expect(run["failingSamples"]).toBeUndefined();
  expect(String(run["samplesUnavailable"])).toMatch(/does not exist|not an eval run directory/);
});

test("an unknown runId is refused and the refusal names what is known", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  const out = await call(evalHistory, { runId: "nope" });
  expect(out["ok"]).toBe(false);
  expect(out["knownRunIds"]).toEqual(["r1"]);
});

test("an unreadable baselines file does not stop a history, and no run is marked pinned", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  writeBaselines(root, "{ not json");
  const out = await call(evalHistory, {});
  console.log(`PINS ${out["baselinesUnreadable"]}`);
  expect(out["ok"]).toBe(true);
  // Without this line the absence of a pinned mark would read as "nothing is
  // pinned" rather than "the pins could not be read".
  expect(String(out["baselinesUnreadable"])).toMatch(/could not be parsed/);
  const points = ((out["lineages"] as Json[])[0]?.["segments"] as Json[])[0]?.["points"] as Json[];
  expect(points[0]?.["pinned"]).toBeUndefined();
});

// --- EvalAggregate -----------------------------------------------------------

test("a recomputation that agrees with the file says so, and the pass rate keeps its interval", async () => {
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "a", passed: true }),
      sample({ sampleId: "b", passed: true }),
      sample({ sampleId: "c", passed: false }),
    ],
    aggregates: { passRate: 2 / 3, meanScore: 2 / 3 },
  });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  console.log(`AGG ${JSON.stringify(out["intervals"])}`);
  expect(out["ok"]).toBe(true);
  expect(out["declaredAgrees"]).toBe(true);
  const interval = (out["intervals"] as Json)["passRate"] as Json;
  expect(interval["successes"]).toBe(2);
  expect(interval["trials"]).toBe(3);
  // 2 of 3 is not "67%": the interval is most of the unit line.
  expect(Number(interval["width"])).toBeGreaterThan(0.6);
});

test("a published aggregate that its own samples do not support is named, field by field", async () => {
  writeRun(root, "r1", {
    samples: [sample({ sampleId: "a", passed: false }), sample({ sampleId: "b", passed: false })],
    // The file claims everything passed. Its samples say otherwise.
    aggregates: { passRate: 1, meanScore: 1 },
  });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  const deltas = out["declaredDeltas"] as Json[];
  console.log(`DELTAS ${JSON.stringify(deltas)}`);
  expect(out["declaredAgrees"]).toBe(false);
  expect(deltas.map((d) => d["field"]).sort()).toEqual(["meanScore", "passRate"]);
  expect(deltas.find((d) => d["field"] === "passRate")?.["recomputed"]).toBe(0);
  expect(String(out["declaredNote"])).toMatch(/describe different runs/);
});

test("pass@k and pass^k carry intervals built from the exact trial counts", async () => {
  // 3 of 5 samples had at least one passing trial; 1 of 5 passed every trial.
  const trials = (any: boolean, all: boolean) =>
    all
      ? [{ passed: true }, { passed: true }]
      : any
        ? [{ passed: true }, { passed: false }]
        : [{ passed: false }, { passed: false }];
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "a", passed: true, trials: trials(true, true) }),
      sample({ sampleId: "b", passed: true, trials: trials(true, false) }),
      sample({ sampleId: "c", passed: false, trials: trials(true, false) }),
      sample({ sampleId: "d", passed: false, trials: trials(false, false) }),
      sample({ sampleId: "e", passed: false, trials: trials(false, false) }),
    ],
  });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  const intervals = out["intervals"] as Json;
  const atK = intervals["passAtK"] as Json;
  console.log(`PASSATK ${JSON.stringify(atK)}`);
  expect(atK["successes"]).toBe(3);
  expect(atK["trials"]).toBe(5);
  expect(atK["pointEstimate"]).toBeCloseTo(0.6, 10);
  // The whole reason the interval is here: 3 of 5 spans "broken" and "fine".
  expect(Number(atK["lower"])).toBeLessThan(0.3);
  expect(Number(atK["upper"])).toBeGreaterThan(0.85);
  expect((intervals["passHatK"] as Json)["successes"]).toBe(1);
}, 20_000);

test("a sample the engine's fold cannot read is named, and the result says it is incomplete", async () => {
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "a", passed: true }),
      // An older persisted run with no tokens block: the fold dereferences it.
      sample({ sampleId: "b", passed: false, tokens: null }),
    ],
  });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  const unusable = out["unusableSamples"] as Json[];
  console.log(`UNUSABLE ${JSON.stringify(unusable)}`);
  expect(out["ok"]).toBe(true);
  expect(out["complete"]).toBe(false);
  expect(unusable[0]).toEqual({
    sampleId: "b",
    reason: "tokens.input/tokens.output are not numbers",
  });
  expect(String(out["unusableNote"])).toMatch(/smaller denominator/);
});

test("a subset reports what it selected, what it could not find, and skips the file comparison", async () => {
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "a", passed: true, metadata: { family: "billing" } }),
      sample({ sampleId: "b", passed: false, metadata: { family: "billing" } }),
      sample({ sampleId: "c", passed: true, metadata: { family: "search" } }),
    ],
    aggregates: { passRate: 2 / 3, meanScore: 2 / 3 },
  });
  const slice = await call(evalAggregate, {
    run: join(EVALS_DIR, "r1"),
    metadataKey: "family",
    metadataValue: "billing",
  });
  expect((slice["aggregates"] as Json)["passRate"]).toBe(0.5);
  expect((slice["selection"] as Json)["selected"]).toBe(2);
  expect(String(slice["declaredComparison"])).toMatch(/subset/);

  const missing = await call(evalAggregate, {
    run: join(EVALS_DIR, "r1"),
    sampleIds: ["a", "ghost"],
  });
  // A smaller selection with no word about the id that was not there is a
  // different question answered under the same name.
  expect((missing["selection"] as Json)["missingIds"]).toEqual(["ghost"]);
});

test("an empty selection is not a run where everything failed", async () => {
  writeRun(root, "r1", {
    samples: [sample({ sampleId: "a", passed: true, metadata: { family: "billing" } })],
  });
  const out = await call(evalAggregate, {
    run: join(EVALS_DIR, "r1"),
    metadataKey: "family",
    metadataValue: "nothing-matches-this",
  });
  console.log(`EMPTY ${out["emptySelection"]}`);
  // The fold's zero and a total failure produce the same aggregate block.
  expect((out["aggregates"] as Json)["passRate"]).toBe(0);
  expect(out["aggregatedSamples"]).toBe(0);
  expect(String(out["emptySelection"])).toMatch(/not that everything failed/);
  const unavailable = (out["intervals"] as Json)["unavailable"] as Json[];
  expect(String(unavailable[0]?.["reason"])).toMatch(/no sample in this selection was graded/);
});

test("a runId resolves through the index, and an unrecorded one is refused with the reason", async () => {
  writeRun(root, "r1", { samples: [sample({ sampleId: "a", passed: true })] });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  const found = await call(evalAggregate, { runId: "r1" });
  expect(found["ok"]).toBe(true);
  expect(found["runId"]).toBe("r1");

  const absent = await call(evalAggregate, { runId: "r9" });
  expect(absent["ok"]).toBe(false);
  expect(String(absent["error"])).toMatch(/no run "r9"/);
});

test("aggregate refuses both a path and an id, and neither", async () => {
  const both = await call(evalAggregate, { run: "x", runId: "y" });
  const neither = await call(evalAggregate, {});
  for (const out of [both, neither]) {
    expect(out["ok"]).toBe(false);
    expect(out["code"]).toBe("bad-input");
  }
});

test("a results.json outside the workspace is refused by containment", async () => {
  const outside = makeWorkspace();
  writeFileSync(join(outside, "results.json"), "{}");
  const out = await call(evalAggregate, { run: join(outside, "results.json") });
  expect(out["ok"]).toBe(false);
  expect(out["code"]).toBe("refused");
});

// --- EvalBaselinePin ---------------------------------------------------------

test("a lineage with no pin is reported as one, because that gate passes vacuously", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  const out = await call(evalBaselinePin, { action: "show", spec: "shop", dataset: "smoke" });
  console.log(`SHOW ${JSON.stringify(out["warnings"])}`);
  expect(out["pinned"]).toBeNull();
  expect(out["vacuousGateRisk"]).toBe(true);
  expect(String((out["warnings"] as string[])[0])).toMatch(/passes vacuously/);
});

test("pinning a partial run is refused, by the reason and not just by failing", async () => {
  writeRun(root, "r1", { samples: [sample({ sampleId: "a" })] });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z", partial: true })]);
  const out = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "r1",
  });
  expect(out["ok"]).toBe(false);
  expect(String(out["error"])).toMatch(/partial \(budget-aborted\)/);
  expect(String(out["error"])).toMatch(/regression read as a recovery/);
  // Nothing was written.
  expect(() => readFileSync(baselinesPath(), "utf8")).toThrow();
});

test("a run from another arm cannot be pinned onto this lineage's key, and the sibling pin survives", async () => {
  writeRun(root, "fast1", { samples: [sample({ sampleId: "a" })] });
  writeIndex(root, [
    row({ runId: "fast1", ts: "2026-01-01T00:00:00Z", armId: "fast", routing: "candidate:fast" }),
  ]);
  writeBaselines(root, {
    "shop::smoke": pin(row({ runId: "old", ts: "2025-12-01T00:00:00Z" })),
  });
  const before = readFileSync(baselinesPath(), "utf8");
  const out = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "fast1",
  });
  console.log(`MISMATCH ${out["error"]}`);
  expect(out["ok"]).toBe(false);
  expect(String(out["error"])).toMatch(/belongs to lineage arm\|shop::smoke::fast/);
  // The trap this refusal exists for: the legacy pin is untouched, byte for byte.
  expect(readFileSync(baselinesPath(), "utf8")).toBe(before);
});

test("dryRun writes nothing and predicts exactly what the real call then writes", async () => {
  writeRun(root, "r1", { samples: [sample({ sampleId: "a" })] });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z", costUsd: 0.25 })]);
  const dry = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "r1",
    dryRun: true,
  });
  expect(dry["committed"]).toBe(false);
  expect(dry["changes"]).toBe(true);
  expect(() => readFileSync(baselinesPath(), "utf8")).toThrow();

  const real = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "r1",
  });
  expect(real["committed"]).toBe(true);
  // One planner, two callers: a preview that computed its own answer is how
  // tool-hostfs predicted a destination the real call never used.
  expect(real["wrote"]).toEqual(dry["wouldWrite"] as Json);
  const onDisk = JSON.parse(readFileSync(baselinesPath(), "utf8")) as Json;
  expect(onDisk["shop::smoke"]).toEqual(real["wrote"] as Json);
});

test("the vacuous-gate flag describes the state the call LEAVES behind", async () => {
  writeRun(root, "r1", { samples: [sample({ sampleId: "a" })] });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  // A dry run wrote nothing, so the lineage is still unpinned.
  const dry = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "r1",
    dryRun: true,
  });
  expect(dry["vacuousGateRisk"]).toBe(true);

  const real = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "r1",
  });
  expect(real["vacuousGateRisk"]).toBe(false);

  const cleared = await call(evalBaselinePin, { action: "clear", spec: "shop", dataset: "smoke" });
  expect(cleared["vacuousGateRisk"]).toBe(true);
});

test("a pin records the run's own timestamp, not the clock", async () => {
  writeRun(root, "r1", { samples: [sample({ sampleId: "a" })] });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  await call(evalBaselinePin, { action: "set", spec: "shop", dataset: "smoke", runId: "r1" });
  const onDisk = JSON.parse(readFileSync(baselinesPath(), "utf8")) as Json;
  expect((onDisk["shop::smoke"] as Json)["ts"]).toBe("2026-01-01T00:00:00Z");
});

test("a committed clear reports the state it LEAVES, not the pin it removed", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  writeBaselines(root, { "shop::smoke": pin(row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })) });
  const out = await call(evalBaselinePin, { action: "clear", spec: "shop", dataset: "smoke" });
  expect(out["committed"]).toBe(true);
  // `pinned` is what the call FOUND — reported on its own it reads as "this
  // lineage is pinned to r1", which is the opposite of what just happened.
  expect((out["pinned"] as Json)["runId"]).toBe("r1");
  expect(out["pinnedAfter"]).toBeNull();
  expect(out["vacuousGateRisk"]).toBe(true);
  expect(JSON.parse(readFileSync(baselinesPath(), "utf8"))).toEqual({});
});

test("clearing removes the named pin and leaves every sibling in place", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  writeBaselines(root, {
    "shop::smoke": pin(row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })),
    "shop::other": pin(row({ runId: "r2", ts: "2026-01-01T00:00:00Z", datasetName: "other" })),
  });
  const out = await call(evalBaselinePin, { action: "clear", spec: "shop", dataset: "smoke" });
  expect(out["committed"]).toBe(true);
  const onDisk = JSON.parse(readFileSync(baselinesPath(), "utf8")) as Json;
  expect(Object.keys(onDisk)).toEqual(["shop::other"]);
  expect(String((out["warnings"] as string[]).join(" "))).toMatch(/nothing to fail against/);
});

test("clearing a lineage that has no pin changes nothing and says the file is unchanged", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  writeBaselines(root, {});
  const before = readFileSync(baselinesPath(), "utf8");
  const out = await call(evalBaselinePin, { action: "clear", spec: "shop", dataset: "gone" });
  expect(out["committed"]).toBe(false);
  expect(String((out["warnings"] as string[]).join(" "))).toMatch(
    /not the same as a pin having been removed/,
  );
  expect(readFileSync(baselinesPath(), "utf8")).toBe(before);
});

test("an unreadable baselines file is refused rather than overwritten", async () => {
  writeRun(root, "r1", { samples: [sample({ sampleId: "a" })] });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  writeBaselines(root, "{ this is not json");
  const before = readFileSync(baselinesPath(), "utf8");
  const out = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "r1",
  });
  expect(out["ok"]).toBe(false);
  expect(out["code"]).toBe("malformed");
  // Writing here would have destroyed every pin in the file, including the
  // lineages this call never named.
  expect(readFileSync(baselinesPath(), "utf8")).toBe(before);
});

test("pinning a run whose results.json is gone is refused, not written hopefully", async () => {
  writeRun(root, "r1", { samples: [sample({ sampleId: "a" })] });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  rmSync(join(root, EVALS_DIR, "r1"), { recursive: true, force: true });
  const out = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "r1",
  });
  expect(out["ok"]).toBe(false);
  expect(String(out["error"])).toMatch(/results\.json could not be read|is not a file/);
});

test("a routing value that is not a routing mode is refused", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  const out = await call(evalBaselinePin, {
    action: "show",
    spec: "shop",
    dataset: "smoke",
    routing: "candidate:",
  });
  expect(out["ok"]).toBe(false);
  expect(String(out["error"])).toMatch(/is not a routing mode/);
});

test("a per-arm lineage is not told the legacy pin is its baseline", async () => {
  writeIndex(root, [
    row({ runId: "fast1", ts: "2026-01-01T00:00:00Z", armId: "fast", routing: "candidate:fast" }),
  ]);
  writeBaselines(root, {
    "shop::smoke": pin(row({ runId: "old", ts: "2025-12-01T00:00:00Z" })),
  });
  const out = await call(evalBaselinePin, {
    action: "show",
    spec: "shop",
    dataset: "smoke",
    armId: "fast",
    routing: "candidate:fast",
  });
  expect(out["pinned"]).toBeNull();
  expect(out["key"]).toBe("arm|shop::smoke::fast");
  expect(String((out["warnings"] as string[]).join(" "))).toMatch(
    /measures a different instrument/,
  );
});

// --- EvalCoverage ------------------------------------------------------------

test("coverage over zero sessions is a refusal, never 'no gaps'", async () => {
  mkdirSync(join(root, SESSIONS_DIR), { recursive: true });
  writeDataset(root, "eval/dataset.jsonl", [{ id: "s1", input: "x", expected_tools: ["Read"] }]);
  const out = await call(evalCoverage, { dataset: "eval/dataset.jsonl" });
  console.log(`NOSESSIONS ${out["error"]}`);
  expect(out["ok"]).toBe(false);
  expect(String(out["error"])).toMatch(/would read as full coverage/);
  expect(JSON.stringify(out)).not.toMatch(/no coverage gaps/);
});

test("a production tool the dataset never exercises is a ranked gap with an interval", async () => {
  for (let i = 1; i <= 5; i += 1) {
    writeSession(root, `s${i}`, {
      // Three of five sessions call the MCP tool; all five read.
      tools: i <= 3 ? [["Read", "mcp__jira__CreateIssue"]] : [["Read"]],
      inputs: ["please file the ticket"],
      mtimeSeconds: 1_700_000_000 + i,
    });
  }
  writeDataset(root, "eval/dataset.jsonl", [{ id: "s1", input: "x", expected_tools: ["Read"] }]);
  const out = await call(evalCoverage, { dataset: "eval/dataset.jsonl" });
  const gaps = out["gaps"] as Json[];
  console.log(`GAPS ${JSON.stringify(gaps.map((g) => [g["subject"], g["sessions"], g["share"]]))}`);
  expect(out["sessionsScanned"]).toBe(5);
  const mcp = gaps.find((g) => g["subject"] === "mcp__jira__CreateIssue");
  expect(mcp?.["kind"]).toBe("mcp-tool");
  expect(mcp?.["sessions"]).toBe(3);
  // 3 of 5 is not a 60% gap: the interval spans most of the line.
  const share = mcp?.["share"] as Json;
  expect(Number(share["width"])).toBeGreaterThan(0.4);
  // Read is exercised by the dataset, so it is not a gap.
  expect(gaps.some((g) => g["subject"] === "Read")).toBe(false);
  // Budget, not a stopwatch: five session files, a dataset and a fold. CI runs
  // this on a loaded two-core box, so the local figure is not the judge.
}, 20_000);

test("a session file that cannot be read is named, and does not inflate the denominator", async () => {
  writeSession(root, "good", { tools: [["Read"]], mtimeSeconds: 1_700_000_000 });
  // A directory wearing a session file's name: readable as an entry, not as a file.
  mkdirSync(join(root, SESSIONS_DIR, "broken.jsonl"), { recursive: true });
  writeDataset(root, "eval/dataset.jsonl", [{ id: "s1", input: "x" }]);
  const out = await call(evalCoverage, { dataset: "eval/dataset.jsonl" });
  const accounting = out["readAccounting"] as Json;
  console.log(`SKIPPED ${JSON.stringify(accounting["sessionsSkipped"])}`);
  expect(out["sessionsScanned"]).toBe(1);
  expect(out["sessionsAvailable"]).toBe(2);
  expect((accounting["sessionsSkipped"] as Json[])[0]?.["file"]).toBe("broken.jsonl");
});

test("a torn line inside a session is counted rather than swallowed", async () => {
  writeSession(root, "s1", {
    tools: [["Read"]],
    extraLines: ["{not json", "42"],
    mtimeSeconds: 1_700_000_000,
  });
  writeDataset(root, "eval/dataset.jsonl", [{ id: "s1", input: "x" }]);
  const out = await call(evalCoverage, { dataset: "eval/dataset.jsonl" });
  expect((out["readAccounting"] as Json)["malformedSessionLines"]).toBe(2);
});

test("a tool the last recorded run really called is not reported as a gap", async () => {
  writeSession(root, "s1", { tools: [["Bash"]], mtimeSeconds: 1_700_000_000 });
  writeDataset(root, "eval/dataset.jsonl", [{ id: "s1", input: "x" }]);
  writeRun(root, "r1", {
    samples: [sample({ sampleId: "a" })],
    events: { a: ["Bash"] },
  });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);

  const withRun = await call(evalCoverage, { dataset: "eval/dataset.jsonl" });
  console.log(`RUNEVENTS ${JSON.stringify(withRun["runEvents"])}`);
  expect(withRun["hasRunEvents"]).toBe(true);
  expect((withRun["gaps"] as Json[]).some((g) => g["subject"] === "Bash")).toBe(false);

  // Without the run's events the same dataset leaves Bash uncovered — and the
  // result says which of the two situations it is in.
  const without = await call(evalCoverage, {
    dataset: "eval/dataset.jsonl",
    includeRunEvents: false,
  });
  expect(without["hasRunEvents"]).toBe(false);
  expect((without["gaps"] as Json[]).some((g) => g["subject"] === "Bash")).toBe(true);
});

test('"all" reads every session rather than the default window', async () => {
  for (let i = 1; i <= 3; i += 1) {
    writeSession(root, `s${i}`, { tools: [[`Tool${i}`]], mtimeSeconds: 1_700_000_000 + i });
  }
  writeDataset(root, "eval/dataset.jsonl", [{ id: "s1", input: "x" }]);
  const out = await call(evalCoverage, {
    dataset: "eval/dataset.jsonl",
    sessions: "all",
    includeRunEvents: false,
  });
  expect(out["sessionsScanned"]).toBe(3);
  expect((out["gaps"] as Json[]).map((g) => g["subject"]).sort()).toEqual([
    "Tool1",
    "Tool2",
    "Tool3",
  ]);
}, 20_000);

test("a missing dataset is refused before any gap is reported", async () => {
  writeSession(root, "s1", { tools: [["Read"]], mtimeSeconds: 1_700_000_000 });
  const out = await call(evalCoverage, { dataset: "eval/missing.jsonl" });
  expect(out["ok"]).toBe(false);
  expect(out["code"]).toBe("missing");
});

// --- GraderMetaTest ----------------------------------------------------------

test("a deterministic grader is replayed and its false positives are named", async () => {
  const out = await call(graderMetaTest, {
    gradersYaml: CONTAINS_YAML,
    goldenJsonl: goldens([
      { id: "g1", output: "all ok here", expected: true },
      { id: "g2", output: "ok but wrong", expected: false },
      { id: "g3", output: "nothing", expected: false },
      { id: "g4", output: "ok", expected: true },
    ]),
  });
  const grader = (out["graders"] as Json[])[0] as Json;
  console.log(`META ${JSON.stringify(grader["confusion"])} rate=${grader["agreementRate"]}`);
  expect(grader["graded"]).toBe(4);
  expect(grader["agreements"]).toBe(3);
  // g2 is the one that matters: the grader passed what a human failed.
  expect((grader["falsePositives"] as Json)["exemplars"]).toEqual(["g2"]);
  expect((grader["confusion"] as Json)["falsePositives"]).toBe(1);
  const interval = grader["agreementInterval"] as Json;
  expect(interval["successes"]).toBe(3);
  expect(interval["trials"]).toBe(4);
  expect(Number(interval["lower"])).toBeLessThan(0.75);
});

test("a judge grader is skipped because this tool makes no model call, and says exactly that", async () => {
  const out = await call(graderMetaTest, {
    gradersYaml: JUDGE_YAML,
    goldenJsonl: goldens([{ id: "g1", output: "ok", expected: true }]),
  });
  const skipped = out["skipped"] as Json[];
  console.log(`SKIPPED ${JSON.stringify(skipped)}`);
  expect(out["testedCount"]).toBe(0);
  expect(String(skipped[0]?.["reason"])).toMatch(/offline by construction/);
  // Not "no credentials": setting a key would not change this answer.
  expect(String(skipped[0]?.["reason"])).not.toMatch(/ANTHROPIC_API_KEY/);
});

test("a registry grader is skipped rather than resolved, and says why", async () => {
  const out = await call(graderMetaTest, {
    gradersYaml: REGISTRY_YAML,
    goldenJsonl: goldens([{ id: "g1", output: "ok", expected: true }]),
  });
  expect(out["testedCount"]).toBe(0);
  expect(String((out["skipped"] as Json[])[0]?.["reason"])).toMatch(/third-party code/);
});

test("an agreement floor that could not be evaluated is unknown, never a pass", async () => {
  const out = await call(graderMetaTest, {
    gradersYaml: JUDGE_YAML,
    goldenJsonl: goldens([{ id: "g1", output: "ok", expected: true }]),
    minAgreement: 0.9,
  });
  const gate = out["gate"] as Json;
  console.log(`GATE ${JSON.stringify(gate)}`);
  expect(gate["verdict"]).toBe("unknown");
  expect(String(gate["reason"])).toMatch(/never evaluated — this is not a pass/);
});

test("the floor fails the graders below it and names them", async () => {
  const out = await call(graderMetaTest, {
    gradersYaml: CONTAINS_YAML,
    goldenJsonl: goldens([
      { id: "g1", output: "ok", expected: false },
      { id: "g2", output: "ok", expected: false },
      { id: "g3", output: "ok", expected: true },
    ]),
    minAgreement: 0.9,
  });
  const gate = out["gate"] as Json;
  expect(gate["verdict"]).toBe("fail");
  expect((gate["below"] as Json[])[0]?.["name"]).toBe("has_ok");
});

test("a lopsided golden set is flagged, and the two kappa conventions are both reported", async () => {
  const out = await call(graderMetaTest, {
    gradersYaml: CONTAINS_YAML,
    goldenJsonl: goldens([
      { id: "g1", output: "ok", expected: true },
      { id: "g2", output: "ok", expected: true },
      { id: "g3", output: "ok", expected: true },
    ]),
  });
  const grader = (out["graders"] as Json[])[0] as Json;
  const detail = grader["kappaDetail"] as Json;
  console.log(
    `KAPPA eval-ops=${grader["kappa"]} kernel=${detail["kappa"]} degenerate=${detail["degenerate"]}`,
  );
  // 100% agreement on a constant label set measures nothing, and the result
  // has to say so rather than hand back a number that reads as perfect.
  expect(grader["agreementRate"]).toBe(1);
  expect(detail["degenerate"]).toBe(true);
  expect(grader["marginals"]).toMatchObject({
    humanPassRate: 1,
    graderPassRate: 1,
    lopsided: true,
  });
  // The note names WHICH rater is lopsided — a grader that says pass to
  // everything collapses kappa exactly as a one-sided golden file does, and
  // blaming the golden set for it would send the reader to fix the wrong file.
  expect(String(grader["marginalsNote"])).toMatch(/^the human labels are lopsided/);
  expect(String(grader["marginalsNote"])).toMatch(/about the label distribution/);
  // The repository holds two kappa implementations that differ here. Both
  // numbers are reported and the disagreement is named.
  expect(String(detail["disagreesWithEvalOps"])).toMatch(/degenerate case/);
});

test("a config past the grader ceiling is refused before a single replay", async () => {
  const many = `graders:\n${Array.from(
    { length: 201 },
    (_unused, i) => `  - name: g${i}\n    type: contains\n    substring: ok\n`,
  ).join("")}`;
  const out = await call(graderMetaTest, {
    gradersYaml: many,
    goldenJsonl: goldens([{ id: "g1", output: "ok", expected: true }]),
  });
  expect(out["ok"]).toBe(false);
  expect(out["code"]).toBe("too-large");
  expect(String(out["error"])).toMatch(/201 graders is over this tool's 200 limit/);
}, 20_000);

test("a golden file with a stray field is refused with its line number", async () => {
  const out = await call(graderMetaTest, {
    gradersYaml: CONTAINS_YAML,
    goldenJsonl: '{"id":"g1","input":"q","agent_output":"ok","expected_passed":true,"typo":1}\n',
  });
  expect(out["ok"]).toBe(false);
  expect(String(out["error"])).toMatch(/golden line 1/);
});

test("malformed graders YAML is the caller's input, not a crash", async () => {
  const out = await call(graderMetaTest, {
    gradersYaml: "graders: [ { name: x, type: nonsense } ]",
    goldenJsonl: goldens([{ id: "g1", output: "ok", expected: true }]),
  });
  expect(out["ok"]).toBe(false);
  expect(out["code"]).toBe("bad-input");
});

test("a graders source given twice, or not at all, is refused", async () => {
  const both = await call(graderMetaTest, {
    graders: "g.yaml",
    gradersYaml: CONTAINS_YAML,
    goldenJsonl: goldens([{ id: "g1", output: "ok", expected: true }]),
  });
  expect(both["ok"]).toBe(false);
  const none = await call(graderMetaTest, {
    goldenJsonl: goldens([{ id: "g1", output: "ok", expected: true }]),
  });
  expect(none["ok"]).toBe(false);
});

test("a resumed run is one row, and the trend uses the figures it finished with", async () => {
  writeIndex(root, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", passRate: 0.9 }),
    // The interrupted attempt, recorded first...
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", passRate: 0.1, sampleCount: 2 }),
    // ...and the superseding row the resume appended under the SAME id.
    row({ runId: "r2", ts: "2026-01-02T06:00:00Z", passRate: 0.8, sampleCount: 10 }),
  ]);
  const out = await call(evalHistory, {});
  const segments = (out["lineages"] as Json[])[0]?.["segments"] as Json[];
  const trend = segments[0]?.["trend"] as Json;
  console.log(`RESUMED superseded=${out["supersededRows"]} delta=${trend["passRateDeltaPp"]}`);
  expect(out["runsRead"]).toBe(2);
  expect(out["supersededRows"]).toBe(1);
  // Counting the truncated attempt would report a 80-point collapse and then a
  // recovery, neither of which happened.
  expect(trend["passRateDeltaPp"]).toBe(-10);
  expect((segments[0]?.["points"] as Json[]).length).toBe(2);
});

test("an abstained sample leaves the pass-rate denominator, and the interval follows it", async () => {
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "a", passed: true }),
      sample({ sampleId: "b", passed: true }),
      sample({ sampleId: "c", passed: false, abstained: true }),
    ],
  });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  const interval = (out["intervals"] as Json)["passRate"] as Json;
  console.log(
    `ABSTAINED ${JSON.stringify(interval)} needsHuman=${(out["aggregates"] as Json)["needsHuman"]}`,
  );
  // Two graded samples, both passing — NOT 2 of 3. The denominator is
  // recovered from the aggregate's own abstention count rather than assumed
  // to be the sample count, which would have produced a narrower, wrong
  // interval around a lower, wrong rate.
  expect(interval["successes"]).toBe(2);
  expect(interval["trials"]).toBe(2);
  expect((out["aggregates"] as Json)["passRate"]).toBe(1);
  expect((out["aggregates"] as Json)["needsHuman"]).toBe(1);
});

test("a fully covered dataset really does report zero gaps", async () => {
  // The positive control for the zero-sessions refusal: if this case did not
  // exist, "no gaps" could mean the tool simply never found anything to say.
  writeSession(root, "s1", { tools: [["Read", "Bash"]], mtimeSeconds: 1_700_000_000 });
  writeDataset(root, "eval/dataset.jsonl", [
    { id: "s1", input: "x", expected_tools: ["Read", "Bash"] },
  ]);
  const out = await call(evalCoverage, { dataset: "eval/dataset.jsonl", includeRunEvents: false });
  expect(out["ok"]).toBe(true);
  expect(out["gapCount"]).toBe(0);
  expect(out["sessionsScanned"]).toBe(1);
}, 20_000);

test("re-pinning across an instrument change warns that it re-baselines", async () => {
  writeRun(root, "r2", { samples: [sample({ sampleId: "a" })] });
  writeIndex(root, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", gradersHash: "graders-2" }),
  ]);
  writeBaselines(root, { "shop::smoke": pin(row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })) });
  const out = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "r2",
  });
  expect(out["committed"]).toBe(true);
  expect(String((out["warnings"] as string[]).join(" "))).toMatch(
    /gradersHash graders-1 -> graders-2/,
  );
});

test("the newest sessions are the ones read when the count is capped", async () => {
  // mtimes are SET, not inherited: the ordering under test is the tool's, not
  // the filesystem's opinion of how fast the test wrote three files.
  writeSession(root, "old", { tools: [["Older"]], mtimeSeconds: 1_700_000_000 });
  writeSession(root, "mid", { tools: [["Middle"]], mtimeSeconds: 1_700_000_100 });
  writeSession(root, "new", { tools: [["Newest"]], mtimeSeconds: 1_700_000_200 });
  writeDataset(root, "eval/dataset.jsonl", [{ id: "s1", input: "x" }]);
  const out = await call(evalCoverage, {
    dataset: "eval/dataset.jsonl",
    sessions: 1,
    includeRunEvents: false,
  });
  const subjects = (out["gaps"] as Json[]).map((g) => g["subject"]);
  expect(out["sessionsScanned"]).toBe(1);
  expect(out["sessionsAvailable"]).toBe(3);
  expect(subjects).toEqual(["Newest"]);
}, 20_000);

// --- the package's own shape -------------------------------------------------

test("no tool schema has a field to pass a credential to", () => {
  for (const tool of EVALOPS_TOOLS) {
    const shape = JSON.stringify(tool.inputSchema);
    for (const field of ["apiKey", "token", "password", "secret", "judgeModel"]) {
      expect({ tool: tool.name, field, present: shape.includes(field) }).toEqual({
        tool: tool.name,
        field,
        present: false,
      });
    }
  }
});

test("only the pin tool writes, and it declares itself destructive", () => {
  const flags = EVALOPS_TOOLS.map((t) => ({
    name: t.name,
    readOnly: t.readOnly,
    destructive: t.destructive,
    concurrencySafe: t.concurrencySafe,
  }));
  console.log(`FLAGS ${JSON.stringify(flags)}`);
  expect(flags.filter((f) => f.destructive).map((f) => f.name)).toEqual(["EvalBaselinePin"]);
  for (const flag of flags) {
    // A read-only tool is concurrency-safe here and the writer is not: the
    // baselines file is rewritten whole, so two concurrent writes lose one.
    expect(flag.concurrencySafe).toBe(flag.readOnly);
  }
  expect(EVALOPS_TOOLS.map((t) => t.name)).toEqual([
    "EvalAggregate",
    "EvalBaselinePin",
    "EvalCoverage",
    "EvalHistory",
    "GraderMetaTest",
  ]);
});

test("no tool reaches the network or spawns a process", () => {
  for (const tool of EVALOPS_TOOLS) {
    expect({ name: tool.name, io: tool.ioCapability, scope: tool.scope }).toEqual({
      name: tool.name,
      io: undefined,
      scope: "internal",
    });
  }
});

// --- the answers that must never be reported as definite ---------------------

test('a run that published no aggregates does not come back "agreeing" with its samples', async () => {
  // The exact shape this project keeps re-committing: an unparseable total
  // reported as `agrees: true`. This results.json declares nothing at all, so
  // there is nothing for its samples to agree WITH.
  writeRun(root, "r1", { samples: [sample({ sampleId: "a", passed: true })] });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  expect(out["ok"]).toBe(true);
  expect(out["declaredAgrees"]).toBeNull();
  expect(out["declaredFieldsCompared"]).toEqual([]);
  expect(String(out["declaredComparisonUnavailable"])).toMatch(/no "aggregates" block/);
  // And it is explicitly not the same answer as a real agreement.
  expect(out["declaredNote"]).toBeUndefined();
});

test("a declared figure that is not a number is named, never skipped into agreement", async () => {
  writeRun(root, "r1", {
    samples: [sample({ sampleId: "a", passed: true })],
    // meanScore matches the recomputation exactly; passRate is a STRING. The
    // comparison used to skip it silently and report agreement on the strength
    // of the one field it could read.
    aggregates: { passRate: "1.0", meanScore: 1 },
  });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  expect(out["declaredFieldsCompared"]).toEqual(["meanScore"]);
  const uncomparable = out["declaredUncomparableFields"] as Json[];
  expect(uncomparable.map((u) => u["field"])).toEqual(["passRate"]);
  expect(String(uncomparable[0]?.["reason"])).toMatch(/which is not a number/);
  // NOT `true`. meanScore agrees, but the field a gate actually reads could
  // not be checked at all, and "some of it agrees" is not "it agrees".
  expect(out["declaredAgrees"]).toBeNull();
  expect(String(out["declaredComparisonUnavailable"])).toMatch(
    /passRate could not be checked at all/,
  );
});

test("a recomputation missing samples reaches no verdict about the published figures", async () => {
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "a", passed: true }),
      sample({ sampleId: "b", passed: true, tokens: null }),
    ],
    aggregates: { passRate: 1, meanScore: 1 },
  });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  expect(out["complete"]).toBe(false);
  // Every recomputed denominator shrank, so a delta here would measure the
  // dropped sample rather than the file. "Could not tell" is the honest answer.
  expect(out["declaredAgrees"]).toBeNull();
  expect(String(out["declaredComparisonUnavailable"])).toMatch(/smaller than the file's/);
});

test("a sample with no perGrader block is named, and the rest of the run still aggregates", async () => {
  const base = sample({ sampleId: "b", passed: false }) as Record<string, unknown>;
  // The shape an older persisted run has: `grades` without `perGrader`.
  // `aggregate()` iterates that field on every non-errored sample, so one such
  // row used to refuse the WHOLE call. Rebuilt without the key rather than
  // deleted, so what the fixture writes is exactly what is described.
  const { perGrader: _dropped, ...gradesWithoutPerGrader } = base["grades"] as Record<
    string,
    unknown
  >;
  const broken = { ...base, grades: gradesWithoutPerGrader };
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "a", passed: true }),
      broken,
      sample({ sampleId: "c", passed: true }),
    ],
  });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  expect(out["ok"]).toBe(true);
  expect(out["complete"]).toBe(false);
  const unusable = out["unusableSamples"] as Json[];
  expect(unusable.map((u) => u["sampleId"])).toEqual(["b"]);
  expect(String(unusable[0]?.["reason"])).toMatch(/perGrader/);
  // The two readable samples were still folded — the point of naming a bad
  // sample instead of refusing the file.
  expect(out["aggregatedSamples"]).toBe(2);
  expect((out["aggregates"] as Json)["passRate"]).toBe(1);
});

test("the Wilson cross-check stays quiet on a run whose two intervals agree", async () => {
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "a", passed: true }),
      sample({ sampleId: "b", passed: true }),
      sample({ sampleId: "c", passed: false }),
      sample({ sampleId: "d", passed: false }),
    ],
  });
  const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1") });
  // Both intervals were computed, so this is not passing for want of one.
  expect((out["aggregates"] as Json)["passRateCI95"]).toBeDefined();
  expect((out["intervals"] as Json)["passRate"]).toBeDefined();
  // The guard fired on every healthy run at its old 1e-9 tolerance, purely
  // because the two z constants are rounded differently.
  expect(out["intervalDrift"]).toBeUndefined();
});

test("a metadata key naming an inherited property selects nothing, not everything", async () => {
  writeRun(root, "r1", {
    samples: [
      sample({ sampleId: "a", passed: true, metadata: { family: "x" } }),
      sample({ sampleId: "b", passed: false, metadata: { family: "y" } }),
    ],
  });
  // `{}["__proto__"]` and `{}["toString"]` are defined on every parsed object,
  // so a bare `meta[key] !== undefined` made these two keys select EVERY
  // sample and report it as the slice the caller named.
  for (const key of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
    const out = await call(evalAggregate, { run: join(EVALS_DIR, "r1"), metadataKey: key });
    expect((out["selection"] as Json)["selected"]).toBe(0);
    expect(String(out["emptySelection"])).toMatch(/not that everything failed/);
  }
  // A key a sample really carries still selects it.
  const real = await call(evalAggregate, {
    run: join(EVALS_DIR, "r1"),
    metadataKey: "family",
    metadataValue: "y",
  });
  expect((real["selection"] as Json)["selected"]).toBe(1);
});

test("a baselines.json holding a JSON array refuses the pin instead of reporting a write", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  writeRun(root, "r1", { samples: [sample()] });
  writeBaselines(root, "[]\n");
  const before = readFileSync(baselinesPath(), "utf8");
  const out = await call(evalBaselinePin, {
    action: "set",
    spec: "shop",
    dataset: "smoke",
    runId: "r1",
  });
  // `setBaseline` assigns a string key to an ARRAY and `JSON.stringify` drops
  // it, so this used to answer `committed: true` with `wrote: {...}` over a
  // file that still said `[]` — a gate left with nothing to fail against and a
  // caller told its baseline was pinned.
  expect(out["ok"]).toBe(false);
  expect(out["code"]).toBe("malformed");
  expect(String(out["error"])).toMatch(/not a map of lineage key to pinned run/);
  expect(readFileSync(baselinesPath(), "utf8")).toBe(before);
});

test("a baselines.json holding null does not crash a history listing", async () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  writeBaselines(root, "null\n");
  // `Object.values(null)` threw straight out of a read-only tool.
  const out = await call(evalHistory, {});
  expect(out["ok"]).toBe(true);
  expect(String(out["baselinesUnreadable"])).toMatch(/not the same as none being pinned/);
  expect(out["baselinesPresent"]).toBeUndefined();
});

test("a truncated accounting list says how many rows it left out", async () => {
  const rows: Array<ReturnType<typeof row> | string> = [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
  ];
  // 150 rows that parse as JSON objects but are not runs — more than any one
  // list in a result names.
  for (let i = 0; i < 150; i += 1)
    rows.push(JSON.stringify({ runId: `bad${i}`, specName: "shop" }));
  writeIndex(root, rows);
  const out = await call(evalHistory, {});
  expect(out["runsRead"]).toBe(1);
  // The count is the honest number; the list is a sample of it and says so.
  expect(out["unusableRowCount"]).toBe(150);
  expect((out["unusableRows"] as Json[]).length).toBe(100);
  expect(out["unusableRowsOmitted"]).toBe(50);
  expect(String(out["unusableRowsOmittedNote"])).toMatch(/not all of them/);
});

test("a line that parses but is not a run is counted, not crashed on", async () => {
  writeIndex(root, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
    // `readRunIndex` used to accept this line (JSON.parse("null") does not
    // throw) and the collapse then dereferenced `.runId` and threw, which
    // this tool reported as a `collapseFailed` degradation. The shared reader
    // skips it now, so the result is a clean one: the line is accounted for
    // as unreadable and every figure below it stands.
    "null",
  ]);
  const out = await call(evalHistory, {});
  expect(out["ok"]).toBe(true);
  expect(out["collapseFailed"]).toBeUndefined();
  expect(out["runsRead"]).toBe(1);
  expect(out["unusableRowCount"]).toBe(0);
  expect(out["unparsedLines"]).toBe(1);
  // The count is not silent: a recorded run that cannot be read is not a run
  // that never happened, so the result says what the number means.
  expect(String(out["unparsedLinesNote"])).toMatch(/not a JSON object/);
});

test("coverage reads the newest run by timestamp, not the last line of the index", async () => {
  writeIndex(root, [
    row({ runId: "rNew", ts: "2026-02-01T00:00:00Z" }),
    row({ runId: "rOld", ts: "2026-01-01T00:00:00Z" }),
  ]);
  writeRun(root, "rNew", { samples: [sample()], events: { a: ["Write"] } });
  writeRun(root, "rOld", { samples: [sample()], events: { a: ["Read"] } });
  writeSession(root, "s1", { tools: [["Read"], ["Write"]], mtimeSeconds: 1_700_000_000 });
  writeDataset(root, "d.jsonl", [{ input: "x" }]);
  const out = await call(evalCoverage, { dataset: "d.jsonl" });
  const runEvents = out["runEvents"] as Json;
  expect(runEvents["available"]).toBe(true);
  expect(runEvents["runId"]).toBe("rNew");
  expect(runEvents["orderedByPosition"]).toBeUndefined();
  // Write came from the newest run's events, so it is covered; Read did not.
  const gaps = (out["gaps"] as Json[]).map((g) => g["subject"]);
  expect(gaps).toContain("Read");
  expect(gaps).not.toContain("Write");
});

test("the session cap message names the cap that actually applied", async () => {
  for (let i = 0; i < 4; i += 1) {
    writeSession(root, `s${i}`, { tools: [["Read"]], mtimeSeconds: 1_700_000_000 + i });
  }
  writeDataset(root, "d.jsonl", [{ input: "x", expected_tools: ["Write"] }]);
  const out = await call(evalCoverage, {
    dataset: "d.jsonl",
    sessions: 2,
    includeRunEvents: false,
  });
  expect(out["sessionsScanned"]).toBe(2);
  expect(out["sessionsAvailable"]).toBe(4);
  const note = String((out["readAccounting"] as Json)["sessionFileCapApplied"]);
  // It used to quote this tool's 2,000-file ceiling whichever cap had run, so
  // a caller who asked for 2 of 4 was told 2,000 files had been opened.
  expect(note).toMatch(/only the 2 most recent session files were opened, as requested/);
  expect(note).not.toContain("2000");
});

test("the agreement floor holds exactly AT the threshold", async () => {
  // 3 of 4 agreements: exactly 0.75. `belowFloor` is `<`, so the floor is a
  // minimum that a grader sitting on it MEETS.
  const golden = goldens([
    { id: "g1", output: "ok", expected: true },
    { id: "g2", output: "no", expected: false },
    { id: "g3", output: "ok", expected: false },
    { id: "g4", output: "ok", expected: true },
  ]);
  const at = await call(graderMetaTest, {
    gradersYaml: CONTAINS_YAML,
    goldenJsonl: golden,
    minAgreement: 0.75,
  });
  expect(((at["graders"] as Json[])[0] as Json)["agreementRate"]).toBe(0.75);
  expect((at["gate"] as Json)["verdict"]).toBe("pass");
  // A hair above it fails, so the test above is not passing because the gate
  // never fires.
  const above = await call(graderMetaTest, {
    gradersYaml: CONTAINS_YAML,
    goldenJsonl: golden,
    minAgreement: 0.7500001,
  });
  expect((above["gate"] as Json)["verdict"]).toBe("fail");
});
