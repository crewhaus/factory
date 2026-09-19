/**
 * The library halves: where a trend line gets CUT, and what the readers say
 * about what they could not read.
 *
 * `index.test.ts` drives the tools. This file drives the two decisions the
 * tools are built on, because both of them are claims that cannot be checked
 * by looking at a result shape:
 *
 *   - a segment boundary is a claim that two runs measured the same thing, so
 *     every test here asserts on WHICH field moved and BETWEEN WHICH RUNS, not
 *     merely that some number of segments came back;
 *   - a reader's accounting is a claim about a file, so the fixtures contain
 *     real torn lines, real superseded rows and real malformed JSON, and the
 *     assertions are on the counts and the reasons.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wilsonCI95 } from "@crewhaus/eval-runner";
import { statsKernel } from "@crewhaus/tool-math";
import {
  EVALS_DIR,
  type Row,
  SESSIONS_DIR,
  makeWorkspace,
  row,
  writeBaselines,
  writeIndex,
  writeSession,
} from "./fixtures";
import { loadSessions } from "./lib/coverage";
import { gateAgreement } from "./lib/graders";
import { newestByTs, readIndex, readPins, rowProblem } from "./lib/history";
import { foldLineages, segmentRuns } from "./lib/lineage";
import { contain, listJsonlByRecency, parseJsonlObjects } from "./lib/read";
import { countBehindRate, wilsonDisagreement } from "./lib/run";

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

/** Segment a hand-built list of rows, in the order given. */
function segment(rows: ReadonlyArray<Row>) {
  return segmentRuns(rows as never, new Set<string>());
}

// --- where the line is cut ---------------------------------------------------

test("a graders rewrite cuts the line, and the cut names both hashes", () => {
  const { segments, boundaries } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", passRate: 0.4 }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", passRate: 0.45 }),
    row({ runId: "r3", ts: "2026-01-03T00:00:00Z", passRate: 0.9, gradersHash: "graders-2" }),
  ]);
  console.log(`SEGMENTS=${segments.length} BOUNDARIES=${boundaries.map((b) => b.kind).join(",")}`);
  expect(segments.length).toBe(2);
  const cut = boundaries.find((b) => b.kind === "break");
  expect(cut?.fromRunId).toBe("r2");
  expect(cut?.toRunId).toBe("r3");
  // `fromRunId` is where the old value was LAST seen, which is r2 here.
  expect(cut?.changed).toEqual([
    { field: "gradersHash", from: "graders-1", fromRunId: "r2", to: "graders-2" },
  ]);
  // The point of the cut: the 0.4 -> 0.9 jump is never one delta.
  expect(segments[0]?.trend?.passRateDeltaPp).toBe(5);
  expect(segments[1]?.trend).toBeNull();
  expect(segments[1]?.trendUnavailable).toMatch(/comparable run/);
  expect(segments[1]?.startedBy?.[0]?.field).toBe("gradersHash");
});

test("a hash change with an unrecorded run in between is still a cut", () => {
  // The trap a pairwise fold walks into: r2 records no gradersHash, so r1|r2
  // and r2|r3 each look merely unverified, and one line gets drawn straight
  // through a rubric change. The comparison is against the last KNOWN value.
  const { segments, boundaries } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", gradersHash: "graders-1" }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", gradersHash: undefined }),
    row({ runId: "r3", ts: "2026-01-03T00:00:00Z", gradersHash: "graders-2" }),
  ]);
  const cut = boundaries.find((b) => b.kind === "break");
  console.log(`CUT ${cut?.fromRunId}->${cut?.toRunId} ${JSON.stringify(cut?.changed)}`);
  expect(segments.length).toBe(2);
  expect(cut?.toRunId).toBe("r3");
  // The `from` names r1 — the run the value was last seen on, not r2.
  expect(cut?.changed[0]?.fromRunId).toBe("r1");
  expect(cut?.changed[0]?.from).toBe("graders-1");
});

test("a spec edit does not cut the line — that is the measurement", () => {
  const { segments, boundaries } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", specHash: "spec-1", passRate: 0.4 }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", specHash: "spec-2", passRate: 0.6 }),
  ]);
  expect(segments.length).toBe(1);
  expect(boundaries.every((b) => b.kind !== "break")).toBe(true);
  expect(boundaries[0]?.notes.join(" ")).toMatch(/spec edited since r1/);
  expect(segments[0]?.trend?.passRateDeltaPp).toBe(20);
});

test("a dataset change cuts the line", () => {
  const { segments, boundaries } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", datasetHash: "data-2" }),
  ]);
  expect(segments.length).toBe(2);
  expect(boundaries[0]?.changed[0]?.field).toBe("datasetHash");
});

test("a judge swap cuts the line", () => {
  const { segments } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", judgeModel: "judge-a" }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", judgeModel: "judge-a" }),
    row({ runId: "r3", ts: "2026-01-03T00:00:00Z", judgeModel: "judge-b" }),
  ]);
  expect(segments.map((s) => s.runCount)).toEqual([2, 1]);
});

test("a hash present on one side only is unverified, not comparable and not a cut", () => {
  const { segments, boundaries } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", gradersHash: "graders-1" }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", gradersHash: undefined }),
  ]);
  expect(segments.length).toBe(1);
  expect(segments[0]?.comparability).toBe("unverified");
  expect(boundaries[0]?.kind).toBe("unverified");
  expect(boundaries[0]?.unverified[0]).toMatchObject({ field: "gradersHash", missingOn: "later" });
  // The delta is still reported — but never as a verified one.
  expect(segments[0]?.trend).not.toBeNull();
});

test("rows a current CLI wrote read as verified; rows that predate the columns do not", () => {
  const modern = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z" }),
  ]);
  expect(modern.segments[0]?.comparability).toBe("verified");
  // judgeModel absent on BOTH is "no pinned judge", not an unknown; armsDigest
  // and policyVersion absent on an unrouted lineage are statements too.
  expect(modern.segments[0]?.unverifiedJoins).toEqual([]);

  const ancient = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", gradersHash: undefined }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", gradersHash: undefined }),
  ]);
  console.log(`ANCIENT ${JSON.stringify(ancient.segments[0]?.unverifiedJoins)}`);
  expect(ancient.segments[0]?.comparability).toBe("unverified");
  expect(ancient.segments[0]?.unverifiedJoins[0]?.missingOn).toBe("both");
});

test("a routed lineage cuts on an arm-snapshot change", () => {
  const routed = (runId: string, ts: string, armsDigest: string): Row =>
    row({ runId, ts, armId: "fast", routing: "candidate:fast", armsDigest, policyVersion: "p1" });
  const { segments, boundaries } = segment([
    routed("r1", "2026-01-01T00:00:00Z", "arms-1"),
    routed("r2", "2026-01-02T00:00:00Z", "arms-2"),
  ]);
  expect(segments.length).toBe(2);
  expect(boundaries[0]?.changed[0]?.field).toBe("armsDigest");
});

test("a partial run is kept out of the trend endpoints and named", () => {
  const { segments } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", passRate: 0.8 }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", passRate: 0.85 }),
    row({ runId: "r3", ts: "2026-01-03T00:00:00Z", passRate: 0.2, partial: true }),
  ]);
  const segmentOne = segments[0];
  console.log(
    `TREND ${JSON.stringify(segmentOne?.trend)} EXCLUDED ${JSON.stringify(segmentOne?.excluded)}`,
  );
  // Without the exclusion this reads as a 60-point collapse that nothing caused.
  expect(segmentOne?.trend?.toRunId).toBe("r2");
  expect(segmentOne?.trend?.passRateDeltaPp).toBe(5);
  expect(segmentOne?.excluded).toEqual([
    {
      runId: "r3",
      why: "budget-aborted (partial) run — its unexecuted samples were recorded as failures, so its pass rate is not a measurement",
    },
  ]);
  // It is still listed as a run that happened.
  expect(segmentOne?.points.map((p) => p.runId)).toEqual(["r1", "r2", "r3"]);
});

test("a segment of nothing but partial runs has no trend, and says why", () => {
  const { segments } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", partial: true }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", partial: true }),
  ]);
  expect(segments[0]?.trend).toBeNull();
  expect(segments[0]?.trendUnavailable).toMatch(/every run in this segment is partial/);
});

test("the delta is in percentage points, not percent", () => {
  const { segments } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", passRate: 0.4 }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", passRate: 0.5 }),
  ]);
  // +10pp. The same move as "+25%", which is the number that lies.
  expect(segments[0]?.trend?.passRateDeltaPp).toBe(10);
});

test("an unpriced run makes the segment cost a partial total, and says so", () => {
  const { segments } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", costUsd: 1.5 }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z" }),
  ]);
  expect(segments[0]?.cost).toEqual({ totalUsd: 1.5, pricedRuns: 1, unpricedRuns: 1 });
});

test("a sample-count change with no dataset change is flagged, not hidden", () => {
  const { boundaries } = segment([
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", sampleCount: 20 }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", sampleCount: 5 }),
  ]);
  expect(boundaries[0]?.notes.join(" ")).toMatch(/sample count changed 20 -> 5/);
});

test("two lineages fold separately and a per-arm lineage keeps its own key", () => {
  const folds = foldLineages(
    [
      row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
      row({ runId: "r2", ts: "2026-01-02T00:00:00Z", armId: "fast", routing: "candidate:fast" }),
    ] as never,
    new Set<string>(),
  );
  console.log(`KEYS ${folds.map((f) => f.key).join(" | ")}`);
  expect(folds.length).toBe(2);
  // The per-arm key is eval-report's, prefix and all — not a second spelling.
  expect(folds.some((f) => f.key === "shop::smoke")).toBe(true);
  expect(folds.some((f) => f.key === "arm|shop::smoke::fast")).toBe(true);
});

test("a multi-segment lineage says so in its own notes", () => {
  const folds = foldLineages(
    [
      row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
      row({ runId: "r2", ts: "2026-01-02T00:00:00Z", gradersHash: "graders-2" }),
    ] as never,
    new Set<string>(),
  );
  expect(folds[0]?.notes.join(" ")).toMatch(/2 segments, not one line/);
});

// --- what the readers say about what they could not read ---------------------

test("a torn line in the index is counted, not silently skipped", () => {
  writeIndex(root, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
    "{not json",
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z" }),
  ]);
  const read = readIndex("T", EVALS_DIR, 1024 * 1024);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  console.log(
    `LINES=${read.value.lines} PARSED=${read.value.parsedRows} TORN=${read.value.unparsedLines}`,
  );
  expect(read.value.lines).toBe(3);
  expect(read.value.entries.length).toBe(2);
  expect(read.value.unparsedLines).toBe(1);
});

test("a resumed run's superseded row is collapsed, and the collapse is counted", () => {
  writeIndex(root, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z", passRate: 0.2, sampleCount: 3 }),
    row({ runId: "r1", ts: "2026-01-01T06:00:00Z", passRate: 0.9, sampleCount: 10 }),
  ]);
  const read = readIndex("T", EVALS_DIR, 1024 * 1024);
  if (!read.ok) throw new Error(read.message);
  expect(read.value.entries.length).toBe(1);
  // The newest row wins: the truncated first attempt does not drag the figure.
  expect(read.value.entries[0]?.passRate).toBe(0.9);
  expect(read.value.supersededRows).toBe(1);
});

test("a row that is not a usable run is named, with the reason", () => {
  writeIndex(root, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ ...row({ runId: "r2", ts: "2026-01-02T00:00:00Z" }), passRate: 1.4 }),
    "42",
  ]);
  const read = readIndex("T", EVALS_DIR, 1024 * 1024);
  if (!read.ok) throw new Error(read.message);
  const reasons = read.value.unusable.map((u) => u.reason).sort();
  console.log(`UNUSABLE ${JSON.stringify(read.value.unusable)}`);
  expect(read.value.entries.length).toBe(1);
  // `42` parses as JSON and is not a run; the 1.4 pass rate is not a rate.
  expect(reasons).toEqual(["not a JSON object", "passRate 1.4 is outside 0..1"]);
});

test("a `null` line degrades the supersede collapse instead of crashing the read", () => {
  // `readRunIndex` accepts the line (JSON.parse("null") does not throw) and
  // `readRunIndexLatest` then dereferences `.runId` on it. This is the guard
  // for that upstream sharp edge: an answer, plus the reason it is degraded.
  writeIndex(root, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
    "null",
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z" }),
  ]);
  const read = readIndex("T", EVALS_DIR, 1024 * 1024);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  console.log(`COLLAPSE ${read.value.collapseFailed}`);
  expect(read.value.entries.map((e) => e.runId)).toEqual(["r1", "r2"]);
  expect(read.value.collapseFailed).toMatch(/supersede collapse/);
  expect(read.value.unusable[0]?.reason).toBe("not a JSON object");
});

test("rowProblem rejects the shapes a cast would let through", () => {
  expect(rowProblem(null)).toBe("not a JSON object");
  expect(rowProblem([])).toBe("not a JSON object");
  expect(rowProblem({ ...row({ runId: "r", ts: "t" }), passRate: "high" })).toMatch(/passRate/);
  expect(rowProblem({ ...row({ runId: "r", ts: "t" }), sampleCount: 1.5 })).toMatch(/whole count/);
  expect(rowProblem(row({ runId: "r", ts: "t" }))).toBeUndefined();
});

test("a missing index is present:false, and a missing DIRECTORY is a refusal", () => {
  mkdirSync(join(root, EVALS_DIR), { recursive: true });
  const empty = readIndex("T", EVALS_DIR, 1024);
  if (!empty.ok) throw new Error(empty.message);
  expect(empty.value.present).toBe(false);
  expect(empty.value.entries).toEqual([]);

  const absent = readIndex("T", "nowhere", 1024);
  expect(absent.ok).toBe(false);
  if (absent.ok) return;
  // The distinction: "no runs recorded" vs "I could not look".
  expect(absent.code).toBe("missing");
});

test("an index over the byte cap is refused before it is read", () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  const read = readIndex("T", EVALS_DIR, 10);
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.code).toBe("too-large");
  expect(read.message).toMatch(/over this tool's 10-byte limit/);
});

test("a malformed baselines.json is unreadable, which is not 'nothing is pinned'", () => {
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
  writeBaselines(root, "{ not json");
  const read = readIndex("T", EVALS_DIR, 1024 * 1024);
  if (!read.ok) throw new Error(read.message);
  const pins = readPins(read.value.dir, EVALS_DIR);
  expect(pins.ok).toBe(false);
  if (pins.ok) return;
  expect(pins.code).toBe("malformed");
  expect(pins.message).toMatch(/not the same as none being pinned/);
});

test("containment refuses an escape and a NUL, by reason", () => {
  const traversal = contain("T", "../outside");
  expect(traversal.ok).toBe(false);
  if (!traversal.ok) expect(traversal.code).toBe("refused");
  const nul = contain("T", "a\u0000/../../etc/passwd");
  expect(nul.ok).toBe(false);
  // Refused for the NUL specifically, before any syscall sees the path.
  if (!nul.ok) expect(nul.message).toMatch(/NUL byte/);
});

test("a symlink pointing out of the workspace is refused", () => {
  const outside = makeWorkspace();
  writeFileSync(join(outside, "secret.txt"), "x");
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  const read = contain("T", "link.txt");
  expect(read.ok).toBe(false);
  if (!read.ok) expect(read.code).toBe("refused");
});

test("JSONL accounting separates malformed lines from non-object lines", () => {
  const parsed = parseJsonlObjects('{"a":1}\n\nnope\n"text"\n[1]\n{"b":2}\n', 100);
  expect(parsed.rows.length).toBe(2);
  expect(parsed.lines).toBe(5);
  expect(parsed.malformedLines).toEqual([3]);
  expect(parsed.nonObjectLines).toEqual([4, 5]);
  expect(parsed.truncated).toBe(false);
});

test("a row cap truncates and SAYS it truncated", () => {
  const parsed = parseJsonlObjects('{"a":1}\n{"a":2}\n{"a":3}\n', 2);
  expect(parsed.rows.length).toBe(2);
  expect(parsed.truncated).toBe(true);
  // The count of lines seen is the whole file, so a caller can tell how much
  // it is missing rather than only that it is missing something.
  expect(parsed.lines).toBe(3);
});

test("the session FILE ceiling caps the read and says it capped", () => {
  writeSession(root, "a", { tools: [["Read"]], mtimeSeconds: 1_700_000_000 });
  writeSession(root, "b", { tools: [["Bash"]], mtimeSeconds: 1_700_000_100 });
  const loaded = loadSessions("T", SESSIONS_DIR, "all", {
    maxFileBytes: 1024 * 1024,
    maxEventsPerFile: 1000,
    maxFiles: 1,
  });
  if (!loaded.ok) throw new Error(loaded.message);
  // "all" is an intent, not a licence: the ceiling holds, the newest file wins,
  // and the caller is told the denominator is not the whole directory.
  expect(loaded.value.sessions.map((s) => s.sessionId)).toEqual(["b"]);
  expect(loaded.value.available).toBe(2);
  expect(loaded.value.fileCapApplied).toBe(true);
});

test("a rate whose denominator was not the sample count yields no count", () => {
  // 3 of 5 recovers exactly.
  expect(countBehindRate(3 / 5, 5)).toBe(3);
  expect(countBehindRate(2 / 3, 3)).toBe(2);
  // 0.75 over 5 samples means the denominator was 4 — an interval built on a
  // guessed numerator would be narrower than the truth.
  expect(countBehindRate(0.75, 5)).toBeUndefined();
  expect(countBehindRate(1.2, 5)).toBeUndefined();
});

// --- what "could not determine" must never be allowed to look like -----------

test("a directory that could not be LISTED is not reported as an empty one", () => {
  // Both answers carry zero names. Only one of them means "there is nothing
  // here", and a coverage report that confuses them prints "no gaps" over a
  // directory it never opened. ENOENT is used because it is the one listing
  // failure every platform and every CI uid reproduces identically — a
  // permission fixture would pass vacuously wherever the tests run as root.
  const missing = listJsonlByRecency(join(root, "no-such-sessions-dir"));
  expect(missing.names).toEqual([]);
  expect(missing.listingFailed).toBeDefined();
  expect(String(missing.listingFailed)).toMatch(/could not be listed/);
  // The node message carries the absolute path; only the errno reaches a caller.
  expect(String(missing.listingFailed)).not.toContain(root);

  mkdirSync(join(root, SESSIONS_DIR), { recursive: true });
  const empty = listJsonlByRecency(join(root, SESSIONS_DIR));
  expect(empty.names).toEqual([]);
  // THE distinction: an empty directory carries no reason, so a caller can
  // branch on presence rather than on the wording of a message.
  expect(empty.listingFailed).toBeUndefined();
});

test("a baselines.json that is valid JSON but not a map is refused, not read as empty", () => {
  // `readBaselines` is JSON.parse plus a cast, so each of these comes back
  // typed as a pin map. `null` then throws inside `Object.values`, and an
  // array silently swallows a write. Neither may reach a caller as "no pins".
  for (const content of ["null\n", "[]\n", '"nope"\n', "42\n"]) {
    writeBaselines(root, content);
    const dir = contain("T", EVALS_DIR);
    if (!dir.ok) throw new Error(dir.message);
    const pins = readPins(dir.value, EVALS_DIR);
    expect(pins.ok).toBe(false);
    if (pins.ok) throw new Error("expected a refusal");
    expect(pins.code).toBe("malformed");
    expect(pins.message).toMatch(/not the same as none being pinned/);
  }
});

test("the newest run is the newest by TIMESTAMP, not the last line of the log", () => {
  // `--resume` appends a superseding row for an older run, so the last line of
  // an append-only index is routinely not its newest run.
  const rows = [
    row({ runId: "rNew", ts: "2026-02-01T00:00:00Z" }),
    row({ runId: "rOld", ts: "2026-01-01T00:00:00Z" }),
  ] as never as ReadonlyArray<Parameters<typeof newestByTs>[0][number]>;
  const newest = newestByTs(rows);
  expect(newest.row?.runId).toBe("rNew");
  expect(newest.tsUnparseable).toBe(false);

  // An unparseable stamp is chosen by POSITION, and the caller is told so
  // rather than handed a "most recent" it cannot trust.
  const torn = [
    row({ runId: "a", ts: "not-a-date" }),
    row({ runId: "b", ts: "also-not-a-date" }),
  ] as never as ReadonlyArray<Parameters<typeof newestByTs>[0][number]>;
  const chosen = newestByTs(torn);
  expect(chosen.row?.runId).toBe("b");
  expect(chosen.tsUnparseable).toBe(true);
  expect(newestByTs([]).row).toBeUndefined();
});

test("the Wilson cross-check tolerates the two z constants and still catches a real drift", () => {
  // eval-runner rounds z to 1.959964; the kernel keeps 1.959963984540054. At a
  // 1e-9 tolerance this guard fired on every healthy run, which is how a guard
  // stops being read. The kernel's own interval must therefore pass its own
  // cross-check.
  const kernel = statsKernel.wilsonScoreInterval(5, 10);
  if (kernel === null) throw new Error("expected an interval");
  const asInterval = {
    successes: 5,
    trials: 10,
    pointEstimate: kernel.pointEstimate,
    lower: kernel.lower,
    upper: kernel.upper,
    width: kernel.width,
    note: kernel.note,
  };
  const engine = wilsonCI95(5, 10);
  if (engine === undefined) throw new Error("expected an engine interval");
  // The two really are different numbers — this test is not comparing a value
  // with itself.
  expect(engine[0]).not.toBe(asInterval.lower);
  expect(Math.abs(engine[0] - asInterval.lower)).toBeGreaterThan(1e-10);
  expect(wilsonDisagreement(engine, asInterval)).toBeUndefined();

  // A formula change, a different confidence level or a mismatched count all
  // move the bounds far more than the rounded constant can. Those must still
  // be named.
  expect(wilsonDisagreement([0.3, 0.8], asInterval)).toMatch(/have drifted/);
});

test("a gate that fails a grader which never answered says so, and keeps failing it", () => {
  const unanswered = {
    name: "silent",
    kind: "deterministic" as const,
    total: 6,
    graded: 0,
    agreements: 0,
    // `summarizeGraderTest` scores an unanswered grader 0 by design. The 0 is
    // kept — but on its own it reads as "disagreed with the humans six times".
    agreementRate: 0,
    kappa: 0,
    falsePositives: { count: 0, exemplars: [] },
    falseNegatives: { count: 0, exemplars: [] },
    abstained: { count: 4, exemplars: ["g1"] },
    errors: { count: 2, exemplars: ["g5"] },
  };
  const gate = gateAgreement(
    [{ report: unanswered } as never],
    0.8,
    (reports, min) => reports.filter((r) => r.agreementRate < min) as never,
  );
  expect(gate?.verdict).toBe("fail");
  expect(gate?.below.map((b) => b.name)).toEqual(["silent"]);
  expect(gate?.notEvaluated?.[0]?.name).toBe("silent");
  expect(String(gate?.notEvaluated?.[0]?.reason)).toMatch(/absence of evidence/);
  expect(String(gate?.reason)).toMatch(/produced no verdict at all/);
});
