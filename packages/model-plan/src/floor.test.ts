/**
 * The floor (§7.10): Wilson LCB vs the floor arm's mean under the same judge;
 * the floor arm is chosen by config, else strong tag, else last declared; no
 * data suspends the check.
 */
import { describe, expect, test } from "bun:test";
import { checkFloor, normalQuantile, wilsonLowerBound } from "./floor";

describe("normalQuantile", () => {
  test("matches the standard table to 1e-6", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.995)).toBeCloseTo(2.5758293, 6);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.3263479, 6);
    expect(() => normalQuantile(0)).toThrow(RangeError);
  });
});

describe("wilsonLowerBound", () => {
  test("known value and monotonicity in n", () => {
    // p=0.8, n=30, z=1.96 → 0.6269 (standard Wilson lower bound)
    expect(wilsonLowerBound(0.8, 30, 1.959964)).toBeCloseTo(0.6269, 3);
    expect(wilsonLowerBound(0.8, 300, 1.959964)).toBeGreaterThan(
      wilsonLowerBound(0.8, 30, 1.959964),
    );
    expect(wilsonLowerBound(0.8, 0, 1.96)).toBe(0);
    expect(wilsonLowerBound(1, 10, 1.96)).toBeLessThan(1);
  });
});

describe("checkFloor", () => {
  const ARMS = [
    { armId: "fast", tags: ["cheap"], qN: 30, qMean: 0.71 },
    { armId: "mid", tags: [], qN: 200, qMean: 0.9 },
    { armId: "strong", tags: ["strong"], qN: 50, qMean: 0.86 },
  ];

  test("the flagship case: fast's LCB sits below the floor → blocked; mid clears it", () => {
    const v = checkFloor(ARMS, { arm: "strong", confidence: 0.9, tolerance: 0.02 });
    expect(v.status).toBe("ok");
    expect(v.floorArm).toBe("strong");
    expect(v.floorQuality).toBe(0.86);
    expect(v.exploitable).toEqual(["mid", "strong"]);
    expect(v.blocked.map((b) => b.armId)).toEqual(["fast"]);
    expect(v.blocked[0]?.reason).toContain("floor 0.860");
    expect(v.blocked[0]?.reason).toContain("LCB(q)=");
  });

  test("after the arm improves it becomes exploitable", () => {
    const improved = ARMS.map((a) => (a.armId === "fast" ? { ...a, qN: 300, qMean: 0.9 } : a));
    expect(checkFloor(improved, { arm: "strong" }).exploitable).toEqual(["fast", "mid", "strong"]);
  });

  test("default floor arm: strong tag, else last declared", () => {
    expect(checkFloor(ARMS).floorArm).toBe("strong");
    expect(
      checkFloor([
        { armId: "a", qN: 5, qMean: 0.5 },
        { armId: "b", qN: 5, qMean: 0.9 },
      ]).floorArm,
    ).toBe("b");
    expect(checkFloor(ARMS, { strongTag: "cheap" }).floorArm).toBe("fast");
  });

  test("a configured floor arm not in the roster falls back to the default", () => {
    expect(checkFloor(ARMS, { arm: "ghost" }).floorArm).toBe("strong");
  });

  test("floor arm without judged data suspends the check for the turn", () => {
    const v = checkFloor([
      { armId: "fast", qN: 30, qMean: 0.7 },
      { armId: "strong", tags: ["strong"], qN: 0, qMean: 0 },
    ]);
    expect(v.status).toBe("unavailable");
    expect(v.floorQuality).toBeUndefined();
    expect(v.exploitable).toEqual(["fast", "strong"]);
    expect(v.blocked).toEqual([]);
  });

  test("an empty roster is unavailable", () => {
    expect(checkFloor([]).status).toBe("unavailable");
  });

  test("a non-floor arm with no judged quality is blocked, not exploitable", () => {
    const v = checkFloor([
      { armId: "new", qN: 0, qMean: 0 },
      { armId: "strong", tags: ["strong"], qN: 50, qMean: 0.86 },
    ]);
    expect(v.exploitable).toEqual(["strong"]);
    expect(v.blocked[0]?.reason).toBe("no judged quality yet");
  });

  test("tolerance and confidence move the threshold in the expected directions", () => {
    const tight = checkFloor(ARMS, { arm: "strong", confidence: 0.99, tolerance: 0 });
    const loose = checkFloor(ARMS, { arm: "strong", confidence: 0.5, tolerance: 0.25 });
    expect(tight.exploitable.length).toBeLessThanOrEqual(loose.exploitable.length);
    expect(loose.exploitable).toContain("fast");
  });
});
