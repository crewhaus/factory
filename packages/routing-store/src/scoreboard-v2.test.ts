/**
 * 0.6.0 §7.9 / §7.10 / §6.3 (PR 10) — the completed `v:2` arm line and the
 * store's two routing-state files:
 *   - Welford quality (`qN` / `qMean` / `qM2`) survives `compact()` (qm2 is
 *     carried, so a compacted store reports the same quality variance);
 *   - `pv` / `sc` / `h` / `pf` are stamped on delta lines and a 0.5.x-shaped
 *     reader (k/m/r/l/c only) folds the line as a plain delta;
 *   - `reset_on_profile_change`: a `pf` that no longer matches the arm's
 *     lineage is skipped on load, a missing `pf` is kept, `false` keeps all;
 *   - the freeze marker round-trips, a malformed marker is reported and
 *     ignored, and `freezeScoreboard` suppresses every write;
 *   - the priors file reader is tolerant (absent → undefined, corrupt → error).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRouteFreeze,
  freezeScoreboard,
  readRouteFreeze,
  routeFreezePath,
  writeRouteFreeze,
} from "./freeze";
import { readRoutingPriorsRaw, routingPriorsPath } from "./priors-file";
import { openScoreboard } from "./scoreboard";

const TMP_ROOTS: string[] = [];
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-routing-store-v2-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const fixedClock = () => 1_700_000_000_000;

function lines(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, "routing", "arms.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** What a 0.5.x reader sees: only k / m / r / l / c. */
function legacyFold(recs: Record<string, unknown>[], k: string, m: string) {
  let n = 0;
  let sum = 0;
  for (const r of recs) {
    if (r["agg"] === 1 || r["k"] !== k || r["m"] !== m) continue;
    n += 1;
    sum += typeof r["r"] === "number" ? r["r"] : 0;
  }
  return { n, mean: n > 0 ? sum / n : 0 };
}

describe("v:2 line — provenance fields and the Welford quality accumulator", () => {
  test("pv / sc / h ride the delta line (stamped v:2) and a legacy fold ignores them", () => {
    const root = newRoot();
    const sb = openScoreboard(root, { now: fixedClock });
    sb.record("support/hard", "fast", 0.8, {
      success: true,
      latencyMs: 120,
      costUsd: 0.001,
      quality: 0.9,
      policyVersion: "pool-abc",
      scope: "support",
      harness: "helpdesk",
    });
    const [line] = lines(root);
    expect(line).toEqual({
      v: 2,
      k: "support/hard",
      m: "fast",
      r: 0.8,
      s: 1,
      l: 120,
      t: fixedClock(),
      c: 0.001,
      q: 0.9,
      pv: "pool-abc",
      sc: "support",
      h: "helpdesk",
    });
    // A 0.5.x reader folds it as one plain delta with reward 0.8.
    expect(legacyFold(lines(root), "support/hard", "fast")).toEqual({ n: 1, mean: 0.8 });
    // A plain observation keeps the exact v:1 shape.
    sb.record("easy", "fast", 0.5, { success: true, latencyMs: 10 });
    expect(lines(root)[1]).toEqual({
      v: 1,
      k: "easy",
      m: "fast",
      r: 0.5,
      s: 1,
      l: 10,
      t: fixedClock(),
    });
  });

  test("quality mean and variance are Welford-folded and survive compact() through qm2", () => {
    const root = newRoot();
    const sb = openScoreboard(root, { now: fixedClock });
    const qs = [0.9, 0.7, 0.8, 1.0, 0.6];
    for (const q of qs) sb.record("hard", "fast", 0.5, { success: true, latencyMs: 1, quality: q });
    const before = sb.score("hard", "fast");
    const mean = qs.reduce((a, b) => a + b, 0) / qs.length;
    const variance = qs.reduce((a, b) => a + (b - mean) ** 2, 0) / (qs.length - 1);
    expect(before?.qualityCount).toBe(5);
    expect(before?.meanQuality).toBeCloseTo(mean, 9);
    expect(before?.varQuality).toBeCloseTo(variance, 9);

    sb.compact();
    const [agg] = lines(root);
    expect(agg).toMatchObject({ v: 2, agg: 1, k: "hard", m: "fast", n: 5, qn: 5 });
    expect(agg?.["qs"]).toBeCloseTo(mean * 5, 9);
    expect(typeof agg?.["qm2"]).toBe("number");

    // A reopened store reports the SAME quality mean and variance, and keeps
    // folding new deltas onto the aggregate (Chan combine).
    const reopened = openScoreboard(root, { now: fixedClock });
    const after = reopened.score("hard", "fast");
    expect(after?.qualityCount).toBe(5);
    expect(after?.meanQuality).toBeCloseTo(mean, 9);
    expect(after?.varQuality).toBeCloseTo(variance, 9);
    reopened.record("hard", "fast", 0.5, { success: true, latencyMs: 1, quality: 0.5 });
    const all = [...qs, 0.5];
    const mean2 = all.reduce((a, b) => a + b, 0) / all.length;
    const var2 = all.reduce((a, b) => a + (b - mean2) ** 2, 0) / (all.length - 1);
    expect(reopened.score("hard", "fast")?.meanQuality).toBeCloseTo(mean2, 9);
    expect(reopened.score("hard", "fast")?.varQuality).toBeCloseTo(var2, 9);
  });

  test("a store that never recorded quality or lineage compacts byte-identically to a v:1 aggregate", () => {
    const root = newRoot();
    const sb = openScoreboard(root, { now: fixedClock });
    sb.record("hard", "opus", 1, { success: true, latencyMs: 100, costUsd: 0.02 });
    sb.compact();
    expect(lines(root)).toEqual([
      { v: 1, agg: 1, k: "hard", m: "opus", n: 1, mr: 1, m2: 0, ls: 100, cs: 0.02, cn: 1 },
    ]);
  });
});

describe("reset_on_profile_change — the pf lineage", () => {
  const LINEAGE = { fast: "lineage-v2" };

  function seedMixedHistory(root: string): void {
    mkdirSync(join(root, "routing"), { recursive: true });
    const stale = { v: 2, k: "hard", m: "fast", r: 0.1, s: 1, l: 5, pf: "lineage-v1" };
    const current = { v: 2, k: "hard", m: "fast", r: 0.9, s: 1, l: 5, pf: "lineage-v2" };
    const unstamped = { v: 1, k: "hard", m: "fast", r: 0.5, s: 1, l: 5 };
    const other = { v: 2, k: "hard", m: "strong", r: 0.7, s: 1, l: 5, pf: "whatever" };
    appendFileSync(
      join(root, "routing", "arms.jsonl"),
      `${[stale, current, unstamped, other].map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  }

  test("lines whose pf differs from the arm's current lineage are skipped; unstamped lines and other arms are kept", () => {
    const root = newRoot();
    seedMixedHistory(root);
    const sb = openScoreboard(root, { now: fixedClock, lineage: LINEAGE });
    const fast = sb.score("hard", "fast");
    expect(fast?.n).toBe(2); // current + unstamped, not the stale v1-lineage line
    expect(fast?.meanReward).toBeCloseTo(0.7, 9);
    // `strong` has no lineage declared → its stamped line is folded as-is.
    expect(sb.score("hard", "strong")?.n).toBe(1);
  });

  test("resetOnProfileChange: false folds the stale lineage too", () => {
    const root = newRoot();
    seedMixedHistory(root);
    const sb = openScoreboard(root, {
      now: fixedClock,
      lineage: LINEAGE,
      resetOnProfileChange: false,
    });
    expect(sb.score("hard", "fast")?.n).toBe(3);
  });

  test("without a lineage map nothing is stamped or skipped (0.5.x behaviour)", () => {
    const root = newRoot();
    seedMixedHistory(root);
    const sb = openScoreboard(root, { now: fixedClock });
    expect(sb.score("hard", "fast")?.n).toBe(3);
    sb.record("hard", "fast", 0.5, { success: true, latencyMs: 1 });
    expect("pf" in (lines(root)[4] ?? {})).toBe(false);
  });

  test("new lines and compacted aggregates carry the arm's lineage; a later lineage change resets the arm", () => {
    const root = newRoot();
    const sb = openScoreboard(root, { now: fixedClock, lineage: LINEAGE });
    sb.record("hard", "fast", 0.9, { success: true, latencyMs: 1 });
    sb.ungraded("hard", "fast");
    const [delta, ug] = lines(root);
    expect(delta).toMatchObject({ v: 2, m: "fast", pf: "lineage-v2" });
    expect(ug).toMatchObject({ v: 2, agg: 1, n: 0, ug: 1, pf: "lineage-v2" });
    sb.compact();
    expect(lines(root)).toEqual([
      {
        v: 2,
        agg: 1,
        k: "hard",
        m: "fast",
        n: 1,
        mr: 0.9,
        m2: 0,
        ls: 1,
        cs: 0,
        cn: 0,
        ug: 1,
        pf: "lineage-v2",
      },
    ]);
    // The profile changed under the arm id: the compacted history is stale.
    const reset = openScoreboard(root, { now: fixedClock, lineage: { fast: "lineage-v3" } });
    expect(reset.score("hard", "fast")).toBeUndefined();
  });
});

describe("route freeze — the marker and the read-only view", () => {
  test("write → read → clear round-trips; absent reads undefined", () => {
    const root = newRoot();
    expect(readRouteFreeze(root)).toBeUndefined();
    const written = writeRouteFreeze(root, {
      policyVersion: "pool-1234",
      reason: "incident 42",
      now: fixedClock,
    });
    expect(written).toEqual({
      version: 1,
      policyVersion: "pool-1234",
      frozenAt: new Date(fixedClock()).toISOString(),
      reason: "incident 42",
    });
    expect(existsSync(routeFreezePath(root))).toBe(true);
    expect(readRouteFreeze(root)).toEqual(written);
    expect(clearRouteFreeze(root)).toBe(true);
    expect(clearRouteFreeze(root)).toBe(false);
    expect(readRouteFreeze(root)).toBeUndefined();
  });

  test("a blank policyVersion is refused", () => {
    expect(() => writeRouteFreeze(newRoot(), { policyVersion: "  " })).toThrow(/policyVersion/);
  });

  test("a malformed marker is reported and treated as absent", () => {
    const root = newRoot();
    mkdirSync(join(root, "routing"), { recursive: true });
    const reports: string[] = [];
    appendFileSync(routeFreezePath(root), "{not json");
    expect(readRouteFreeze(root, (d) => reports.push(d))).toBeUndefined();
    rmSync(routeFreezePath(root));
    appendFileSync(routeFreezePath(root), JSON.stringify({ version: 1 }));
    expect(readRouteFreeze(root, (d) => reports.push(d))).toBeUndefined();
    rmSync(routeFreezePath(root));
    appendFileSync(routeFreezePath(root), JSON.stringify({ version: 2, policyVersion: "x" }));
    expect(readRouteFreeze(root, (d) => reports.push(d))).toBeUndefined();
    expect(reports).toHaveLength(3);
    expect(reports[0]).toMatch(/not valid JSON/);
    expect(reports[1]).toMatch(/no policyVersion/);
    expect(reports[2]).toMatch(/unsupported version 2/);
  });

  test("freezeScoreboard reads through and drops every write", () => {
    const root = newRoot();
    const live = openScoreboard(root, { now: fixedClock });
    live.record("hard", "fast", 0.9, { success: true, latencyMs: 1 });
    const frozen = freezeScoreboard(live);
    expect(frozen.path).toBe(live.path);
    expect(frozen.score("hard", "fast")?.n).toBe(1);
    frozen.record("hard", "fast", 0.1, { success: true, latencyMs: 1 });
    frozen.ungraded("hard", "fast");
    frozen.compact();
    expect(frozen.score("hard", "fast")?.n).toBe(1);
    expect(frozen.snapshot()).toEqual(live.snapshot());
    expect(lines(root)).toHaveLength(1);
  });
});

describe("priors file — raw read", () => {
  test("absent → undefined; valid JSON → raw; corrupt → error (never thrown)", () => {
    const root = newRoot();
    expect(readRoutingPriorsRaw(root)).toBeUndefined();
    mkdirSync(join(root, "routing"), { recursive: true });
    appendFileSync(routingPriorsPath(root), JSON.stringify({ version: 1, arms: [] }));
    expect(readRoutingPriorsRaw(root)).toEqual({
      ok: true,
      raw: { version: 1, arms: [] },
      path: routingPriorsPath(root),
    });
    rmSync(routingPriorsPath(root));
    appendFileSync(routingPriorsPath(root), "[oops");
    const bad = readRoutingPriorsRaw(root);
    expect(bad?.ok).toBe(false);
    if (bad === undefined || bad.ok) throw new Error("expected an error");
    expect(bad.error).toMatch(/not valid JSON/);
  });
});
