import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
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

describe("scoreboard — 0.6.0 §7.9/§7.10 v:2 lines (PR 9c): judged quality, attribution, ungraded", () => {
  test("a plain observation still writes the exact v:1 line (byte-identity)", () => {
    const sb = openScoreboard(newRoot(), { now: fixedClock });
    sb.record("hard", "opus", 1, { success: true, latencyMs: 100, costUsd: 0.02 });
    const line = readFileSync(sb.path, "utf8").trim();
    expect(line).toBe(
      '{"v":1,"k":"hard","m":"opus","r":1,"s":1,"l":100,"t":1700000000000,"c":0.02}',
    );
    const arm = sb.score("hard", "opus");
    expect(arm?.meanQuality).toBe(0);
    expect(arm?.qualityCount).toBe(0);
    expect(arm?.ungraded).toBe(0);
  });

  test("quality + strategy attribution write a v:2 delta with q/st/sg/at/wp and fold the quality mean", () => {
    const sb = openScoreboard(newRoot(), { now: fixedClock });
    sb.record("hard", "haiku", 0.4, {
      success: true,
      latencyMs: 100,
      quality: 0.25,
      stage: "draft",
      strategy: "cascade",
      attributedTo: "draft",
      wouldPass: false,
    });
    sb.record("hard", "haiku", 0.9, { success: true, latencyMs: 80, quality: 0.75 });
    const lines = readFileSync(sb.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      v: 2,
      k: "hard",
      m: "haiku",
      r: 0.4,
      q: 0.25,
      st: "draft",
      sg: "cascade",
      at: "draft",
      wp: 0,
    });
    expect(lines[1]).toMatchObject({ v: 2, q: 0.75 });
    expect(lines[1].st).toBeUndefined();
    const arm = sb.score("hard", "haiku");
    expect(arm?.n).toBe(2);
    expect(arm?.qualityCount).toBe(2);
    expect(arm?.meanQuality).toBeCloseTo(0.5, 9);
    // The reward itself is whatever the caller computed — the store never re-derives it.
    expect(arm?.meanReward).toBeCloseTo(0.65, 9);
  });

  test("a 0.5.x-shaped reader folds a v:2 delta as a plain delta; a v:1 line folds unchanged on the new reader", () => {
    const root = newRoot();
    const sb = openScoreboard(root, { now: fixedClock });
    mkdirSync(join(root, "routing"), { recursive: true });
    // Hand-written lines: one v:1 (an older writer) and one v:2 (this release).
    appendFileSync(
      sb.path,
      '{"v":1,"k":"hard","m":"opus","r":1,"s":1,"l":100,"t":1}\n' +
        '{"v":2,"k":"hard","m":"opus","r":0.5,"s":1,"l":100,"t":2,"q":0.5,"st":"escalate","sg":"cascade","at":"escalation"}\n',
    );
    const reopened = openScoreboard(root, { now: fixedClock });
    const arm = reopened.score("hard", "opus");
    expect(arm?.n).toBe(2);
    expect(arm?.meanReward).toBeCloseTo(0.75, 9);
    expect(arm?.qualityCount).toBe(1);
    expect(arm?.meanQuality).toBeCloseTo(0.5, 9);
    // What a 0.5.x reader sees: it reads only k/m/r/l/c — the reward fold is
    // identical, i.e. the extra keys are invisible to it (pinned by re-folding
    // the same lines with the new keys stripped).
    const strippedRoot = newRoot();
    const stripped = openScoreboard(strippedRoot, { now: fixedClock });
    mkdirSync(join(strippedRoot, "routing"), { recursive: true });
    appendFileSync(
      stripped.path,
      '{"v":1,"k":"hard","m":"opus","r":1,"s":1,"l":100,"t":1}\n' +
        '{"v":1,"k":"hard","m":"opus","r":0.5,"s":1,"l":100,"t":2}\n',
    );
    const legacy = openScoreboard(strippedRoot, { now: fixedClock });
    expect(legacy.score("hard", "opus")?.meanReward).toBeCloseTo(arm?.meanReward ?? -1, 12);
    expect(legacy.score("hard", "opus")?.n).toBe(arm?.n ?? -1);
  });

  test("ungraded() increments the arm counter, persists as an n:0 aggregate line (never a reward), and survives reopen + compact", () => {
    const root = newRoot();
    const sb = openScoreboard(root, { now: fixedClock });
    sb.record("hard", "haiku", 0.8, { success: true, latencyMs: 100, quality: 0.8 });
    sb.ungraded("hard", "haiku");
    sb.ungraded("hard", "haiku");
    expect(sb.score("hard", "haiku")?.ungraded).toBe(2);
    expect(sb.score("hard", "haiku")?.n).toBe(1); // no reward line was recorded
    const lines = readFileSync(sb.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[1]).toEqual({
      v: 2,
      agg: 1,
      k: "hard",
      m: "haiku",
      n: 0,
      ug: 1,
      t: 1_700_000_000_000,
    });
    expect(lines[1].r).toBeUndefined();

    const reopened = openScoreboard(root, { now: fixedClock });
    expect(reopened.score("hard", "haiku")?.ungraded).toBe(2);
    expect(reopened.score("hard", "haiku")?.n).toBe(1);
    expect(reopened.score("hard", "haiku")?.meanQuality).toBeCloseTo(0.8, 9);

    reopened.compact();
    const agg = readFileSync(reopened.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ v: 2, agg: 1, n: 1, qs: 0.8, qn: 1, ug: 2 });
    const again = openScoreboard(root, { now: fixedClock });
    expect(again.score("hard", "haiku")).toMatchObject({
      n: 1,
      ungraded: 2,
      qualityCount: 1,
      meanQuality: 0.8,
    });
  });

  test("compact() on a store that never recorded quality writes no qs/qn/ug keys (byte-identical aggregate lines)", () => {
    const sb = openScoreboard(newRoot(), { now: fixedClock });
    sb.record("hard", "opus", 1, { success: true, latencyMs: 100, costUsd: 0.02 });
    sb.compact();
    const line = readFileSync(sb.path, "utf8").trim();
    expect(line).toBe(
      '{"v":1,"agg":1,"k":"hard","m":"opus","n":1,"mr":1,"m2":0,"ls":100,"cs":0.02,"cn":1}',
    );
  });
});
