/**
 * C27 — the closed-form CI helpers, checked against published values:
 * Wilson score intervals from the standard binomial-CI tables, t critical
 * values from the printed Student t table, and a textbook t interval.
 */
import { describe, expect, test } from "bun:test";
import { meanCI95, tCritical975, wilsonCI95 } from "./stats";

describe("wilsonCI95 (C27)", () => {
  test("8/10 matches the published Wilson interval (0.4902, 0.9433)", () => {
    const ci = wilsonCI95(8, 10);
    expect(ci).toBeDefined();
    const [lo, hi] = ci as [number, number];
    expect(lo).toBeCloseTo(0.4902, 3);
    expect(hi).toBeCloseTo(0.9433, 3);
  });

  test("10/10 stays inside [0,1] with the known 0.7225 lower bound", () => {
    const [lo, hi] = wilsonCI95(10, 10) as [number, number];
    expect(lo).toBeCloseTo(0.7225, 3);
    expect(hi).toBeCloseTo(1, 6);
  });

  test("0/10 mirrors 10/10 around 0.5", () => {
    const [lo, hi] = wilsonCI95(0, 10) as [number, number];
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(0.2775, 3);
  });

  test("interval tightens as n grows at fixed p̂", () => {
    const small = wilsonCI95(4, 8) as [number, number];
    const large = wilsonCI95(400, 800) as [number, number];
    expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
    // At n=800 the interval hugs p̂=0.5 to within ±0.04.
    expect(large[0]).toBeGreaterThan(0.46);
    expect(large[1]).toBeLessThan(0.54);
  });

  test("n=0 yields no interval (never a fabricated one)", () => {
    expect(wilsonCI95(0, 0)).toBeUndefined();
  });
});

describe("tCritical975 (C27)", () => {
  test("tabulated values: df 1, 4, 30", () => {
    expect(tCritical975(1)).toBeCloseTo(12.706, 3);
    expect(tCritical975(4)).toBeCloseTo(2.776, 3);
    expect(tCritical975(30)).toBeCloseTo(2.042, 3);
  });

  test("Fisher expansion beyond the table matches the printed values", () => {
    expect(tCritical975(40)).toBeCloseTo(2.021, 3);
    expect(tCritical975(60)).toBeCloseTo(2.0, 3);
    expect(tCritical975(120)).toBeCloseTo(1.98, 3);
  });

  test("converges to the normal critical value at large df", () => {
    expect(tCritical975(100000)).toBeCloseTo(1.96, 3);
  });

  test("rejects non-positive / fractional df loudly", () => {
    expect(() => tCritical975(0)).toThrow(RangeError);
    expect(() => tCritical975(2.5)).toThrow(RangeError);
  });
});

describe("meanCI95 (C27)", () => {
  test("textbook interval: [1..5] → 3 ± 2.776·(√2.5/√5)", () => {
    const [lo, hi] = meanCI95([1, 2, 3, 4, 5]) as [number, number];
    expect(lo).toBeCloseTo(3 - 1.963, 3);
    expect(hi).toBeCloseTo(3 + 1.963, 3);
  });

  test("identical samples yield a zero-width interval at the mean", () => {
    const [lo, hi] = meanCI95([0.7, 0.7, 0.7]) as [number, number];
    expect(lo).toBeCloseTo(0.7, 9);
    expect(hi).toBeCloseTo(0.7, 9);
  });

  test("fewer than 2 values yields no interval", () => {
    expect(meanCI95([])).toBeUndefined();
    expect(meanCI95([0.5])).toBeUndefined();
  });
});
