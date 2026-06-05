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

  test("prometheus() renders every counter and histogram series in one document", () => {
    const r = new Registry();
    // Populate one of each metric so the exposition body is non-trivial and
    // every Counter/Histogram .prometheus() path runs with real series data.
    r.turnsTotal.inc();
    r.toolCallsTotal.inc({ tool: "Bash" });
    r.tokensTotal.inc({ direction: "in" }, 100);
    r.errorsTotal.inc({ kind: "OverloadedError" });
    r.turnDurationSeconds.observe(0.5);
    r.toolDurationSeconds.observe(0.01, { tool: "Bash" });
    r.modelTtftSeconds.observe(0.2);

    const text = r.prometheus();
    // All seven metric families present in the single rendered document.
    expect(text).toContain("crewhaus_turns_total 1");
    expect(text).toContain('crewhaus_tool_calls_total{tool="Bash"} 1');
    expect(text).toContain('crewhaus_tokens_total{direction="in"} 100');
    expect(text).toContain('crewhaus_errors_total{kind="OverloadedError"} 1');
    expect(text).toContain("crewhaus_turn_duration_seconds_count 1");
    expect(text).toContain('crewhaus_tool_duration_seconds_count{tool="Bash"} 1');
    expect(text).toContain("crewhaus_model_ttft_seconds_count 1");
  });
});

describe("Counter / Histogram series + empty-label paths", () => {
  test("Counter.series() returns the accumulated value snapshot", () => {
    const c = new Counter("c_total", "help");
    c.inc();
    c.inc({ k: "v" }, 2);
    const series = c.series();
    expect(series).toHaveLength(2);
    // Unlabeled series renders with no brace suffix in prometheus().
    expect(c.prometheus()).toContain("c_total 1");
  });

  test("Histogram.series() reflects bucket counts after observe()", () => {
    const h = new Histogram("h_seconds", "help", [1, 10]);
    h.observe(0.5);
    const series = h.series();
    expect(series).toHaveLength(1);
    expect(series[0]?.counts).toEqual([1, 1]);
    expect(series[0]?.total).toBe(1);
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
