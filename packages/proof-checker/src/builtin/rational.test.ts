import { describe, expect, test } from "bun:test";
import { CheckFailure } from "./budget";
import {
  RAT_MAX_BITS,
  add,
  cmp,
  div,
  eq,
  isDecimal,
  mul,
  parseDecimal,
  pow,
  rat,
  ratToString,
  sub,
} from "./rational";

describe("exact rationals", () => {
  test("decimals are exact: 0.1 + 0.2 = 0.3", () => {
    expect(eq(add(parseDecimal("0.1"), parseDecimal("0.2")), parseDecimal("0.3"))).toBe(true);
  });

  test("fractions reduce and keep a positive denominator", () => {
    expect(rat(6n, -4n)).toEqual({ n: -3n, d: 2n });
    expect(parseDecimal("10.50")).toEqual({ n: 21n, d: 2n });
    expect(parseDecimal("007")).toEqual({ n: 7n, d: 1n });
  });

  test("arithmetic and comparison", () => {
    const third = div(rat(1n), rat(3n));
    expect(eq(mul(third, rat(3n)), rat(1n))).toBe(true);
    expect(eq(sub(rat(1n), third), rat(2n, 3n))).toBe(true);
    expect(cmp(third, parseDecimal("0.333"))).toBe(1);
    expect(cmp(rat(-1n), rat(0n))).toBe(-1);
    expect(cmp(rat(2n, 4n), rat(1n, 2n))).toBe(0);
  });

  test("division by zero is an error, never a value", () => {
    expect(() => div(rat(1n), rat(0n))).toThrow(CheckFailure);
    expect(() => rat(1n, 0n)).toThrow(/division by zero/);
  });

  test("powers: non-negative integer exponents only", () => {
    expect(pow(rat(2n), rat(10n))).toEqual(rat(1024n));
    expect(pow(rat(1n, 2n), rat(3n))).toEqual(rat(1n, 8n));
    expect(pow(rat(5n), rat(0n))).toEqual(rat(1n));
    expect(() => pow(rat(2n), rat(-1n))).toThrow(/non-negative integer/);
    expect(() => pow(rat(2n), rat(1n, 2n))).toThrow(/non-negative integer/);
  });

  test("0, 1 and -1 raise to any exponent without growing", () => {
    expect(pow(rat(1n), rat(10n ** 30n))).toEqual(rat(1n));
    expect(pow(rat(-1n), rat(10n ** 30n))).toEqual(rat(1n));
    expect(pow(rat(-1n), rat(10n ** 30n + 1n))).toEqual(rat(-1n));
    expect(pow(rat(0n), rat(10n ** 30n))).toEqual(rat(0n));
  });

  test("sizes are capped: a huge power is refused before it is computed", () => {
    expect(() => pow(rat(10n), rat(10n ** 10n))).toThrow(/too large|bits/);
    expect(() => pow(rat(3n), rat(BigInt(RAT_MAX_BITS)))).toThrow(/bits/);
  });

  test("the size estimate is not pessimistic: powers under the cap are computed", () => {
    // 2^5000 has 5001 bits; the old estimate (bits(2) · 5000 = 10000) refused it.
    expect(pow(rat(2n), rat(5000n)).n).toBe(2n ** 5000n);
    expect(pow(rat(3n), rat(5000n)).n).toBe(3n ** 5000n); // 7925 bits
    expect(pow(rat(1n, 2n), rat(BigInt(RAT_MAX_BITS - 1))).d).toBe(2n ** BigInt(RAT_MAX_BITS - 1));
    // 2^8192 has 8193 bits: refused before computing; 3^6000 (9510 bits) after.
    expect(() => pow(rat(2n), rat(BigInt(RAT_MAX_BITS)))).toThrow(/a power grows past/);
    expect(() => pow(rat(3n), rat(6000n))).toThrow(/bits/);
    expect(() => rat(1n << BigInt(RAT_MAX_BITS))).toThrow(/bits/);
  });

  test("display: integers, exact decimals, otherwise n/d", () => {
    expect(ratToString(rat(42n))).toBe("42");
    expect(ratToString(rat(21n, 2n))).toBe("10.5");
    expect(ratToString(rat(-1n, 8n))).toBe("-0.125");
    expect(ratToString(rat(1n, 3n))).toBe("1/3");
    expect(ratToString(rat(-7n, 6n))).toBe("-7/6");
    expect(isDecimal(rat(1n, 40n))).toBe(true);
    expect(isDecimal(rat(1n, 3n))).toBe(false);
  });
});
