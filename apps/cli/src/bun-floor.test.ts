import { describe, expect, test } from "bun:test";
import { BUN_FLOOR, checkBunVersion } from "./bun-floor";

describe("checkBunVersion (the Bun floor doctor enforces)", () => {
  test("the floor itself and anything newer pass", () => {
    for (const v of [BUN_FLOOR, "1.3.14", "1.4.0", "2.0.0", "1.3.12-canary.20260101"]) {
      expect(checkBunVersion(v)).toEqual({ pass: true });
    }
  });

  test("1.2 and an older 1.3 fail, naming the floor", () => {
    for (const v of ["1.2.23", "1.2.0", "1.3.0", "1.3.10", "0.9.9"]) {
      const verdict = checkBunVersion(v);
      expect(verdict.pass).toBe(false);
      expect(verdict.reason).toContain(`below the minimum ${BUN_FLOOR}`);
    }
  });

  test("an unparseable version is not a pass", () => {
    expect(checkBunVersion("canary")).toEqual({
      pass: false,
      reason: 'unparseable version "canary"',
    });
  });
});
