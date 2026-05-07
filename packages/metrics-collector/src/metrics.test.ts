/**
 * T1 unit tests — counter, histogram, exposition format spot-checks plus
 * env-parsing for the sink spec.
 */
import { describe, expect, test } from "bun:test";
import { parseEnv } from "./index";
import { Counter, Histogram, Registry } from "./registry";

describe("Counter", () => {
  test("increments and renders Prometheus exposition", () => {
    const c = new Counter("foo_total", "test counter");
    c.inc();
    c.inc({ x: "a" }, 3);
    c.inc({ x: "a" });
    c.inc({ x: "b" });
    const text = c.prometheus();
    expect(text).toContain("# HELP foo_total test counter");
    expect(text).toContain("# TYPE foo_total counter");
    expect(text).toContain("foo_total 1");
    expect(text).toContain('foo_total{x="a"} 4');
    expect(text).toContain('foo_total{x="b"} 1');
  });
});

describe("Histogram", () => {
  test("observe places samples in the correct buckets", () => {
    const h = new Histogram("dur_seconds", "test", [0.1, 1, 5]);
    h.observe(0.05);
    h.observe(0.5);
    h.observe(2);
    h.observe(10);
    const series = h.series();
    expect(series).toHaveLength(1);
    const s = series[0];
    if (!s) throw new Error("expected one series");
    // 0.05 in 0.1,1,5; 0.5 in 1,5; 2 in 5; 10 nowhere
    expect(s.counts).toEqual([1, 2, 3]);
    expect(s.total).toBe(4);
    expect(s.sum).toBeCloseTo(12.55);
    const text = h.prometheus();
    expect(text).toContain('dur_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('dur_seconds_bucket{le="1"} 2');
    expect(text).toContain('dur_seconds_bucket{le="5"} 3');
    expect(text).toContain('dur_seconds_bucket{le="+Inf"} 4');
    expect(text).toContain("dur_seconds_count 4");
  });
});

describe("Registry", () => {
  test("jsonSnapshot exposes counters and histograms with bucket boundaries", () => {
    const r = new Registry();
    r.turnsTotal.inc();
    r.turnDurationSeconds.observe(0.5);
    const snap = r.jsonSnapshot();
    expect(snap.counters["crewhaus_turns_total"]?.[0]?.value).toBe(1);
    const turnHist = snap.histograms["crewhaus_turn_duration_seconds"]?.[0];
    expect(turnHist).toBeDefined();
    expect(turnHist?.total).toBe(1);
    expect(turnHist?.buckets.length).toBeGreaterThan(0);
  });
});

describe("parseEnv", () => {
  test("returns undefined for unset / empty / invalid values", () => {
    expect(parseEnv(undefined)).toBeUndefined();
    expect(parseEnv("")).toBeUndefined();
    expect(parseEnv("file")).toBeUndefined();
    expect(parseEnv("textfile:")).toBeUndefined();
    expect(parseEnv("http:")).toBeUndefined();
    expect(parseEnv("http:abc")).toBeUndefined();
  });
  test("recognizes the four sink specs", () => {
    expect(parseEnv("stdout")).toEqual({ kind: "stdout" });
    expect(parseEnv("textfile")).toEqual({ kind: "textfile" });
    expect(parseEnv("textfile:/tmp/m.prom")).toEqual({ kind: "textfile", path: "/tmp/m.prom" });
    expect(parseEnv("http:8765")).toEqual({ kind: "http", port: 8765 });
  });
});
