import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openScoreboard } from "./scoreboard";

const TMP_ROOTS: string[] = [];
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-routing-store-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

// A deterministic clock so the persisted `t` field is stable across runs.
const fixedClock = () => 1_700_000_000_000;

describe("scoreboard — record + aggregate", () => {
  test("records fold into a Welford mean/variance per arm", () => {
    const sb = openScoreboard(newRoot(), { now: fixedClock });
    sb.record("hard", "opus", 1.0, { success: true, latencyMs: 100, costUsd: 0.02 });
    sb.record("hard", "opus", 0.0, { success: false, latencyMs: 300 });
    const arm = sb.score("hard", "opus");
    expect(arm).toBeDefined();
    expect(arm?.n).toBe(2);
    expect(arm?.meanReward).toBeCloseTo(0.5, 6);
    expect(arm?.varReward).toBeCloseTo(0.5, 6); // sample var of {1,0} = 0.5
    expect(arm?.meanLatencyMs).toBeCloseTo(200, 6);
    expect(arm?.meanCostUsd).toBeCloseTo(0.02, 6); // only 1 of 2 carried cost
    expect(arm?.costCount).toBe(1);
  });

  test("distinct route-keys and models are separate arms; unknown → undefined", () => {
    const sb = openScoreboard(newRoot(), { now: fixedClock });
    sb.record("hard", "opus", 0.9, { success: true, latencyMs: 100 });
    sb.record("easy", "haiku", 0.8, { success: true, latencyMs: 50 });
    expect(sb.score("hard", "opus")?.n).toBe(1);
    expect(sb.score("easy", "haiku")?.n).toBe(1);
    expect(sb.score("hard", "haiku")).toBeUndefined();
    expect(sb.snapshot().map((a) => `${a.routeKey}/${a.model}`)).toEqual([
      "easy/haiku",
      "hard/opus",
    ]);
  });

  test("the backing file is created 0600 and holds one delta line per record", () => {
    const root = newRoot();
    const sb = openScoreboard(root, { now: fixedClock });
    sb.record("hard", "opus", 1, { success: true, latencyMs: 100, costUsd: 0.02 });
    sb.record("hard", "opus", 0, { success: false, latencyMs: 100 });
    expect(existsSync(sb.path)).toBe(true);
    expect(statSync(sb.path).mode & 0o777).toBe(0o600);
    const lines = readFileSync(sb.path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toMatchObject({
      k: "hard",
      m: "opus",
      r: 1,
      s: 1,
      l: 100,
      c: 0.02,
      t: 1_700_000_000_000,
    });
    expect(JSON.parse(lines[1])).toMatchObject({ k: "hard", m: "opus", r: 0, s: 0, l: 100 });
    expect(JSON.parse(lines[1]).c).toBeUndefined();
  });
});

describe("scoreboard — durability across reopen (learning accumulates)", () => {
  test("reopening replays deltas so a second run continues the first run's arm", () => {
    const root = newRoot();
    const a = openScoreboard(root, { now: fixedClock });
    a.record("easy", "haiku", 0.8, { success: true, latencyMs: 50, costUsd: 0.001 });
    a.record("easy", "haiku", 0.6, { success: true, latencyMs: 70, costUsd: 0.001 });

    const b = openScoreboard(root, { now: fixedClock });
    expect(b.score("easy", "haiku")?.n).toBe(2);
    b.record("easy", "haiku", 1.0, { success: true, latencyMs: 40, costUsd: 0.001 });
    expect(b.score("easy", "haiku")?.n).toBe(3);
    expect(b.score("easy", "haiku")?.meanReward).toBeCloseTo((0.8 + 0.6 + 1.0) / 3, 6);
  });
});

describe("scoreboard — compaction", () => {
  test("compact() rewrites to one aggregate line per arm and preserves stats exactly", () => {
    const root = newRoot();
    const a = openScoreboard(root, { now: fixedClock });
    for (const r of [1, 0, 0.5, 0.75])
      a.record("hard", "opus", r, { success: r > 0, latencyMs: 100, costUsd: 0.02 });
    a.record("easy", "haiku", 0.9, { success: true, latencyMs: 30, costUsd: 0.001 });
    const before = a.score("hard", "opus");
    a.compact();

    const lines = readFileSync(a.path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2); // one per arm, not 5 deltas
    expect(JSON.parse(lines[0]).agg).toBe(1);

    // Reopen: aggregate line must reproduce the pre-compaction stats bit-for-bit.
    const b = openScoreboard(root, { now: fixedClock });
    const after = b.score("hard", "opus");
    expect(after?.n).toBe(before?.n);
    expect(after?.meanReward).toBeCloseTo(before?.meanReward ?? -1, 9);
    expect(after?.varReward).toBeCloseTo(before?.varReward ?? -1, 9);
    expect(after?.meanLatencyMs).toBeCloseTo(before?.meanLatencyMs ?? -1, 9);
    expect(after?.meanCostUsd).toBeCloseTo(before?.meanCostUsd ?? -1, 9);
  });

  test("aggregate line + later deltas combine correctly (parallel Welford)", () => {
    const root = newRoot();
    const a = openScoreboard(root, { now: fixedClock });
    for (const r of [1, 0]) a.record("hard", "opus", r, { success: r > 0, latencyMs: 100 });
    a.compact(); // now one agg line {n:2,...}
    const b = openScoreboard(root, { now: fixedClock });
    b.record("hard", "opus", 0.5, { success: true, latencyMs: 100 }); // appended after the agg line
    const arm = b.score("hard", "opus");
    expect(arm?.n).toBe(3);
    expect(arm?.meanReward).toBeCloseTo((1 + 0 + 0.5) / 3, 6);
    // sample variance of {1,0,0.5} = 0.25
    expect(arm?.varReward).toBeCloseTo(0.25, 6);
  });
});

describe("scoreboard — robustness", () => {
  test("a torn/garbage trailing line is ignored, not fatal", () => {
    const root = newRoot();
    const sb = openScoreboard(root, { now: fixedClock });
    sb.record("hard", "opus", 1, { success: true, latencyMs: 100 });
    // Simulate a crash mid-append by writing a partial JSON line.
    appendFileSync(sb.path, '{"v":1,"k":"hard","m":"opus","r":0.', { encoding: "utf8" });
    const reopened = openScoreboard(root, { now: fixedClock });
    expect(reopened.score("hard", "opus")?.n).toBe(1); // only the intact line counted
  });
});
