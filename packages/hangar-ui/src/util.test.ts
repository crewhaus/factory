/**
 * Unit tests for the browser-side pure helpers. The assets are plain ES
 * modules with no DOM usage at import time, so bun imports them directly —
 * the exact file the browser runs is the file under test.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as util from "../assets/js/util.js";

const NOW = Date.parse("2026-08-03T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("fmtRelativeTime", () => {
  test("just now / minutes / hours / days", () => {
    expect(util.fmtRelativeTime(iso(-10_000), NOW)).toBe("just now");
    expect(util.fmtRelativeTime(iso(-5 * 60_000), NOW)).toBe("5m ago");
    expect(util.fmtRelativeTime(iso(-3 * HOUR), NOW)).toBe("3h ago");
    expect(util.fmtRelativeTime(iso(-6 * DAY), NOW)).toBe("6d ago");
  });

  test("future timestamps read as 'in …'", () => {
    expect(util.fmtRelativeTime(iso(2 * HOUR), NOW)).toBe("in 2h");
  });

  test("absent/invalid → em dash", () => {
    expect(util.fmtRelativeTime(null, NOW)).toBe("—");
    expect(util.fmtRelativeTime("not-a-date", NOW)).toBe("—");
  });
});

describe("fmtUsd / fmtPct / fmtCount", () => {
  test("usd tiers", () => {
    expect(util.fmtUsd(0)).toBe("$0.00");
    expect(util.fmtUsd(0.0042)).toBe("$0.0042");
    expect(util.fmtUsd(1.234)).toBe("$1.23");
    expect(util.fmtUsd(1234.5)).toBe("$1,235");
    expect(util.fmtUsd(null)).toBe("—");
  });

  test("pct", () => {
    expect(util.fmtPct(0.875)).toBe("87.5%");
    expect(util.fmtPct(1)).toBe("100%");
    expect(util.fmtPct(0.9)).toBe("90%");
    // 0.55 * 100 carries float dust; the label must not
    expect(util.fmtPct(0.55)).toBe("55%");
    expect(util.fmtPct(undefined)).toBe("—");
  });

  test("count", () => {
    expect(util.fmtCount(7)).toBe("7");
    expect(util.fmtCount(null)).toBe("—");
  });
});

describe("dirTail / clampText", () => {
  test("dirTail keeps the last segments", () => {
    expect(util.dirTail("/home/max/harnesses/support-bot")).toBe("harnesses/support-bot");
    expect(util.dirTail("/home/max/harnesses/support-bot", 1)).toBe("support-bot");
    expect(util.dirTail("", 2)).toBe("");
  });

  test("clampText truncates with an ellipsis", () => {
    expect(util.clampText("short", 10)).toBe("short");
    expect(util.clampText("a".repeat(20), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("ttlCountdown", () => {
  test("counts down against the 30-day default", () => {
    const fresh = util.ttlCountdown(iso(-1 * DAY), NOW);
    expect(fresh.expired).toBe(false);
    expect(fresh.label).toBe("expires in 29d");
  });

  test("hours granularity near expiry, then expired", () => {
    const near = util.ttlCountdown(iso(-30 * DAY + 5 * HOUR), NOW);
    expect(near.label).toBe("expires in 5h");
    const gone = util.ttlCountdown(iso(-31 * DAY), NOW);
    expect(gone.expired).toBe(true);
    expect(gone.label).toBe("expired");
  });

  test("unknown timestamp stays honest", () => {
    expect(util.ttlCountdown(null, NOW).label).toBe("—");
  });
});

describe("compareValues + sortRows", () => {
  test("numbers numeric, strings case-insensitive, empties last", () => {
    expect(util.compareValues(2, 10)).toBeLessThan(0);
    expect(util.compareValues("Beta", "alpha")).toBeGreaterThan(0);
    expect(util.compareValues(null, "x")).toBeGreaterThan(0);
    expect(util.compareValues("x", undefined)).toBeLessThan(0);
    expect(util.compareValues(null, null)).toBe(0);
  });

  test("sortRows is stable, directional, and pins first", () => {
    const rows = [
      { name: "c", pinned: false },
      { name: "a", pinned: false },
      { name: "b", pinned: true },
    ];
    const asc = util.sortRows(rows, (r: { name: string }) => r.name, "asc");
    expect(asc.map((r: { name: string }) => r.name)).toEqual(["b", "a", "c"]);
    const desc = util.sortRows(rows, (r: { name: string }) => r.name, "desc");
    expect(desc.map((r: { name: string }) => r.name)).toEqual(["b", "c", "a"]);
  });
});

describe("normalizeRows", () => {
  test("accepts both a bare array and {harnesses:[…]}, with tolerant fields", () => {
    const row = {
      id: "hrn_0123456789abcdef",
      dir: "/tmp/x/support-bot",
      specName: "support-bot",
      target: "channel",
      capabilities: ["thredz", "budget"],
      sessions: 4,
    };
    const a = util.normalizeRows([row]);
    const b = util.normalizeRows({ harnesses: [row] });
    expect(a).toEqual(b);
    expect(a[0].budgeted).toBe(true);
    expect(a[0].groups).toEqual([]);
    expect(a[0].missingSince).toBeNull();
  });

  test("junk feeds normalize to empty, junk rows to safe defaults", () => {
    expect(util.normalizeRows(null)).toEqual([]);
    expect(util.normalizeRows({ nope: 1 })).toEqual([]);
    const [r] = util.normalizeRows([{}]);
    expect(r.id).toBe("");
    expect(r.pinned).toBe(false);
    expect(r.lastEval).toBeNull();
  });
});

describe("evalHealth / needsAttention / rollupLine", () => {
  test("healthy flag drives the dot; text always present", () => {
    expect(util.evalHealth({ passRate: 1, healthy: true })).toEqual({
      state: "pass",
      label: "100%",
    });
    expect(util.evalHealth({ passRate: 0.6, healthy: false })).toEqual({
      state: "fail",
      label: "60%",
    });
    expect(util.evalHealth({ passRate: 0.8 }).state).toBe("unknown");
    expect(util.evalHealth(null)).toEqual({ state: "none", label: "no evals" });
  });

  test("rollup counts attention rows (missing or failing evals)", () => {
    const rows = util.normalizeRows([
      { id: "a", dir: "/a" },
      { id: "b", dir: "/b", missingSince: "2026-08-01T00:00:00Z" },
      { id: "c", dir: "/c", lastEval: { passRate: 0.5, healthy: false } },
    ]);
    expect(util.rollupLine(rows)).toBe("3 harnesses · 2 need attention");
    expect(util.rollupLine(rows.slice(0, 1))).toBe("1 harness");
  });
});

describe("deriveSmartGroups", () => {
  const rows = util.normalizeRows([
    { id: "f", dir: "/f", lastEval: { passRate: 0.2, healthy: false }, capabilities: ["budget"] },
    { id: "t", dir: "/t", capabilities: ["thredz", "budget"], groups: ["prod"] },
    { id: "r", dir: "/r", lastSeen: iso(-HOUR), capabilities: ["budget"] },
    { id: "m", dir: "/m", missingSince: iso(-2 * DAY), capabilities: ["budget"] },
    { id: "u", dir: "/u" },
  ]);
  const groups = new Map(
    util
      .deriveSmartGroups(rows, NOW)
      .map((g: { id: string; rows: { id: string }[] }) => [g.id, g.rows.map((r) => r.id)]),
  );

  test("the six computed groups, in members", () => {
    expect(groups.get("failing-evals")).toEqual(["f"]);
    expect(groups.get("unbudgeted")).toEqual(["u"]);
    expect(groups.get("has-thredz")).toEqual(["t"]);
    expect(groups.get("recently-active")).toEqual(["r"]);
    expect(groups.get("ungrouped")).toEqual(["f", "r", "m", "u"]);
    expect(groups.get("missing")).toEqual(["m"]);
  });

  test("recently-active respects the 48h window and never counts the future", () => {
    const stale = util.normalizeRows([{ id: "s", dir: "/s", lastSeen: iso(-3 * DAY) }]);
    expect(util.smartGroupMatch("recently-active", stale[0], NOW)).toBe(false);
    const future = util.normalizeRows([{ id: "x", dir: "/x", lastSeen: iso(HOUR) }]);
    expect(util.smartGroupMatch("recently-active", future[0], NOW)).toBe(false);
  });
});

describe("sparklinePath / barRects", () => {
  test("path spans the box and needs two points", () => {
    expect(util.sparklinePath([1])).toBe("");
    expect(util.sparklinePath([])).toBe("");
    const path = util.sparklinePath([0, 1], 120, 28, 2);
    expect(path).toBe("M2 26 L118 2");
  });

  test("flat series draws a midline", () => {
    const path = util.sparklinePath([5, 5, 5], 120, 28, 2);
    expect(path).toBe("M2 14 L60 14 L118 14");
  });

  test("bars scale to max and keep a sliver for zero days", () => {
    const rects = util.barRects([0, 10], 100, 40, 0);
    expect(rects).toHaveLength(2);
    expect(rects[0].h).toBe(0.5);
    expect(rects[1].h).toBe(39);
    expect(rects[1].y).toBe(1);
    expect(util.barRects([], 100, 40)).toEqual([]);
  });
});
