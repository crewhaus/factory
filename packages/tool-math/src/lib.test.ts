/**
 * The pure core. Every function is tested directly here, because a bug in
 * `divideRound` reads better as a failing unit than as a failing tool call.
 *
 * Where a result depends on a convention (percentile method, rounding mode,
 * sample vs population) the expected value is one that can be checked by hand
 * or against a named reference — R, NumPy, Excel — and the reference is in
 * the test name.
 */
import { describe, expect, test } from "bun:test";
import {
  ROUNDING_MODES,
  type RoundingMode,
  decimalToString,
  divideRound,
  parseDecimal,
  roundToMultiple,
  roundToPlaces,
  roundToSignificant,
  trimTrailingZeros,
} from "./lib/decimal";
import { EXPR_MAX_DEPTH, ExprError, evaluateExpression, tokenizeExpression } from "./lib/expr";
import { amortize, irr, markupMargin, npv, percentChange, percentOfTotal } from "./lib/finance";
import {
  EARTH_RADIUS_M,
  boundingBoxAround,
  boundingBoxOf,
  haversineDistance,
  pointInPolygon,
} from "./lib/geo";
import {
  CURRENCY_MINOR_UNITS,
  convertMinor,
  formatMinor,
  lookupRate,
  minorUnitExponent,
  moneyAllocate,
  moneyMultiply,
  moneySum,
  toMinor,
} from "./lib/money";
import { formatNumber, parseLocaleNumber } from "./lib/numfmt";
import {
  compensatedSum,
  findOutliers,
  histogram,
  linearRegression,
  mean,
  median,
  modes,
  pearson,
  percentile,
  quartiles,
  rank,
  sortedCopy,
  spearman,
  stdev,
  summarize,
  variance,
} from "./lib/stats";
import { convertUnits, resolveUnit, unitCatalog } from "./lib/units";

const evaluate = (source: string, variables: Record<string, number> = {}): number =>
  evaluateExpression(source, { variables }).value;

// ---------------------------------------------------------------------------

describe("expr — grammar", () => {
  test("arithmetic follows precedence, not left to right", () => {
    expect(evaluate("2 + 3 * 4")).toBe(14);
    expect(evaluate("(2 + 3) * 4")).toBe(20);
  });

  test("^ is right-associative", () => {
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
  });

  test("unary minus binds looser than ^, so -2^2 is -4 (mathematics, not Excel)", () => {
    expect(evaluate("-2^2")).toBe(-4);
    expect(evaluate("(-2)^2")).toBe(4);
  });

  test("unary minus binds tighter than multiplication", () => {
    expect(evaluate("-2*3")).toBe(-6);
    expect(evaluate("2^-2")).toBe(0.25);
  });

  test("% is the remainder and takes the sign of the dividend", () => {
    expect(evaluate("7 % 3")).toBe(1);
    expect(evaluate("-7 % 3")).toBe(-1);
  });

  test("functions cover the documented set, with log base 10 and ln natural", () => {
    expect(evaluate("abs(-3)")).toBe(3);
    expect(evaluate("min(4, 2, 9)")).toBe(2);
    expect(evaluate("max(4, 2, 9)")).toBe(9);
    expect(evaluate("round(2.5)")).toBe(3);
    expect(evaluate("round(-2.5)")).toBe(-3);
    expect(evaluate("floor(2.9)")).toBe(2);
    expect(evaluate("ceil(2.1)")).toBe(3);
    expect(evaluate("sqrt(16)")).toBe(4);
    expect(evaluate("pow(2, 10)")).toBe(1024);
    expect(evaluate("log(1000)")).toBeCloseTo(3, 12);
    expect(evaluate("ln(exp(1))")).toBeCloseTo(1, 12);
    expect(evaluate("sin(0)")).toBe(0);
    expect(evaluate("cos(0)")).toBe(1);
    expect(evaluate("tan(0)")).toBe(0);
  });

  test("variables and constants resolve, and a variable shadows a constant", () => {
    expect(evaluate("price * (1 + vat)", { price: 100, vat: 0.2 })).toBeCloseTo(120, 10);
    expect(evaluate("pi")).toBeCloseTo(Math.PI, 15);
    expect(evaluate("e", { e: 42 })).toBe(42);
  });

  test("the result reports which names and functions were used", () => {
    const result = evaluateExpression("max(a, b) + a", { variables: { a: 1, b: 2 } });
    expect(result.usedNames).toEqual(["a", "b"]);
    expect(result.usedFunctions).toEqual(["max"]);
  });

  test("whitespace is insignificant", () => {
    expect(evaluate("  1\t+\n2 ")).toBe(3);
  });
});

describe("expr — refusals", () => {
  const refuses = (source: string, fragment: string): void => {
    let message = "";
    try {
      evaluate(source);
    } catch (err) {
      expect(err).toBeInstanceOf(ExprError);
      message = (err as ExprError).message;
    }
    expect(message).toContain(fragment);
  };

  test("nothing outside the grammar is executable — no JavaScript reaches a runtime", () => {
    refuses("process.exit(1)", 'unexpected character "."');
    refuses("globalThis", "unknown name");
    refuses("1; 2", 'unexpected character ";"');
    refuses("[1,2]", 'unexpected character "["');
    refuses("a => a", "unexpected character");
    refuses('"str"', "unexpected character");
    refuses("2 ** 3", '"**" is not an operator');
  });

  test("an unknown function is named, with the supported set", () => {
    refuses("frobnicate(1)", "unknown function");
    refuses("sqrt", "is a function");
  });

  test("hex and digit separators are refused rather than reinterpreted", () => {
    refuses("0x10", "only decimal numbers");
    refuses("1_000", "digit separators");
  });

  test("division and remainder by zero are refused, not Infinity or NaN", () => {
    refuses("1/0", "division by zero");
    refuses("1%0", "remainder by zero");
  });

  test("a non-finite intermediate is refused rather than returned", () => {
    refuses("sqrt(-1)", "not a finite number");
    refuses("1e308 * 10", "not a finite number");
  });

  test("unbalanced parentheses and stray tokens are located", () => {
    refuses("(1 + 2", 'expected ")"');
    refuses("1 + ", "expected a number");
    refuses("1 2", "after a complete expression");
  });

  test("wrong arity is refused", () => {
    refuses("pow(2)", "takes 2 argument");
    refuses("abs()", "takes 1 argument");
  });

  test("caps bound the work: length, token count and nesting depth", () => {
    expect(() => tokenizeExpression("1+".repeat(3_000))).toThrow(/over the 4000 limit/);
    const deep = `${"(".repeat(EXPR_MAX_DEPTH + 5)}1${")".repeat(EXPR_MAX_DEPTH + 5)}`;
    expect(() => evaluate(deep)).toThrow(/nests deeper/);
  });

  test("a non-finite variable is refused", () => {
    expect(() => evaluate("x", { x: Number.NaN })).toThrow(/finite/);
  });
});

// ---------------------------------------------------------------------------

describe("decimal — exact arithmetic", () => {
  test("parsing handles plain, signed and exponent forms", () => {
    expect(decimalToString(parseDecimal("12.34"))).toBe("12.34");
    expect(decimalToString(parseDecimal("-0.007"))).toBe("-0.007");
    expect(decimalToString(parseDecimal("1e3"))).toBe("1000");
    expect(decimalToString(parseDecimal("1.5e-3"))).toBe("0.0015");
    expect(decimalToString(parseDecimal(0.1))).toBe("0.1");
  });

  test("junk is refused rather than coerced", () => {
    for (const bad of ["", "1,234", "abc", "1.2.3", "$5", "0x10", " 1 2 "]) {
      expect(() => parseDecimal(bad)).toThrow();
    }
    expect(() => parseDecimal(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  test("0.1 + 0.2 is exactly 0.3, which binary floating point cannot say", () => {
    const sum = trimTrailingZeros({
      unscaled: parseDecimal("0.1").unscaled + parseDecimal("0.2").unscaled,
      scale: 1,
    });
    expect(decimalToString(sum)).toBe("0.3");
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  test("every rounding mode does what its name says, on both signs", () => {
    // 25/10 = 2.5 exactly, the tie every mode disagrees about.
    const expected: Record<RoundingMode, [bigint, bigint]> = {
      halfUp: [3n, -3n],
      halfEven: [2n, -2n],
      halfDown: [2n, -2n],
      ceiling: [3n, -2n],
      floor: [2n, -3n],
      up: [3n, -3n],
      down: [2n, -2n],
    };
    for (const mode of ROUNDING_MODES) {
      const [positive, negative] = expected[mode];
      expect({ mode, v: divideRound(25n, 10n, mode) }).toEqual({ mode, v: positive });
      expect({ mode, v: divideRound(-25n, 10n, mode) }).toEqual({ mode, v: negative });
    }
  });

  test("halfEven really alternates, which is the point of banker's rounding", () => {
    expect(divideRound(15n, 10n, "halfEven")).toBe(2n);
    expect(divideRound(25n, 10n, "halfEven")).toBe(2n);
    expect(divideRound(35n, 10n, "halfEven")).toBe(4n);
    expect(divideRound(45n, 10n, "halfEven")).toBe(4n);
  });

  test("an exact quotient is never bumped by any mode", () => {
    for (const mode of ROUNDING_MODES) {
      expect(divideRound(20n, 10n, mode)).toBe(2n);
      expect(divideRound(-20n, 10n, mode)).toBe(-2n);
    }
  });

  test("rounding to decimal places works on the digits the caller wrote", () => {
    expect(decimalToString(roundToPlaces(parseDecimal("1.005"), 2, "halfUp"))).toBe("1.01");
    expect(decimalToString(roundToPlaces(parseDecimal("1.005"), 2, "halfEven"))).toBe("1.00");
    expect(decimalToString(roundToPlaces(parseDecimal("2.675"), 2, "halfUp"))).toBe("2.68");
    expect(decimalToString(roundToPlaces(parseDecimal("1.4"), 0, "halfUp"))).toBe("1");
  });

  test("significant figures round above and below the decimal point", () => {
    expect(decimalToString(roundToSignificant(parseDecimal("123456"), 3, "halfUp"))).toBe("123000");
    expect(decimalToString(roundToSignificant(parseDecimal("0.00123456"), 3, "halfUp"))).toBe(
      "0.00123",
    );
    expect(decimalToString(roundToSignificant(parseDecimal("0"), 3, "halfUp"))).toBe("0");
    expect(decimalToString(roundToSignificant(parseDecimal("-98765"), 2, "halfUp"))).toBe("-99000");
  });

  test("rounding to a multiple handles fractional steps exactly", () => {
    expect(
      decimalToString(roundToMultiple(parseDecimal("7.31"), parseDecimal("0.05"), "halfUp")),
    ).toBe("7.3");
    expect(
      decimalToString(roundToMultiple(parseDecimal("7.33"), parseDecimal("0.05"), "halfUp")),
    ).toBe("7.35");
    expect(decimalToString(roundToMultiple(parseDecimal("17"), parseDecimal("5"), "halfUp"))).toBe(
      "15",
    );
    expect(() => roundToMultiple(parseDecimal("1"), parseDecimal("0"), "halfUp")).toThrow(
      /greater than zero/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("stats — descriptive", () => {
  const sample = [2, 4, 4, 4, 5, 5, 7, 9];

  test("compensated summation does not drift the way a naive sum does", () => {
    const values = [1e16, 1, -1e16, 1];
    expect(compensatedSum(values)).toBe(2);
  });

  test("mean, median and mode", () => {
    expect(mean(sample)).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(modes(sample)).toEqual({ values: [4], count: 3 });
  });

  test("a bimodal series reports BOTH modes, sorted", () => {
    expect(modes([1, 1, 2, 2, 3])).toEqual({ values: [1, 2], count: 2 });
  });

  test("all-distinct data has no mode at all", () => {
    expect(modes([1, 2, 3])).toEqual({ values: [], count: 1 });
  });

  test("variance and stdev are reported both ways and the two differ", () => {
    const v = variance(sample);
    expect(v.population).toBeCloseTo(4, 12);
    expect(v.sample).toBeCloseTo(32 / 7, 12);
    expect(stdev(sample).population).toBeCloseTo(2, 12);
    expect(stdev(sample).sample).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  test("sample variance of a single value is null, not zero", () => {
    expect(variance([5]).sample).toBeNull();
    expect(variance([5]).population).toBe(0);
  });

  test("sortedCopy never mutates its input", () => {
    const original = [3, 1, 2];
    expect(sortedCopy(original)).toEqual([1, 2, 3]);
    expect(original).toEqual([3, 1, 2]);
  });

  test("summarize reports the convention it used", () => {
    const summary = summarize([1, 2, 3, 4], "nearestRank");
    expect(summary.percentileMethod).toBe("nearestRank");
    expect(summary.percentileMethodNote).toContain("nearest rank");
    expect(summary.range).toBe(3);
    expect(summary.count).toBe(4);
  });

  test("an empty series is refused", () => {
    expect(() => summarize([])).toThrow(/empty/);
  });

  test("a non-finite value is refused with its index", () => {
    expect(() => summarize([1, Number.NaN])).toThrow(/values\[1\]/);
  });
});

describe("stats — percentile conventions", () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  test("the three conventions give three different answers for p25 on 1..10", () => {
    expect(percentile(ten, 0.25, "r7")).toBeCloseTo(3.25, 12);
    expect(percentile(ten, 0.25, "r6")).toBeCloseTo(2.75, 12);
    expect(percentile(ten, 0.25, "nearestRank")).toBe(3);
  });

  test("r7 matches NumPy's default at the median and the extremes", () => {
    expect(percentile(ten, 0.5, "r7")).toBe(5.5);
    expect(percentile(ten, 0, "r7")).toBe(1);
    expect(percentile(ten, 1, "r7")).toBe(10);
  });

  test("r6 refuses the tails it cannot define rather than clamping", () => {
    expect(() => percentile(ten, 0.05, "r6")).toThrow(/undefined/);
    expect(() => percentile(ten, 0.99, "r6")).toThrow(/undefined/);
  });

  test("nearestRank always returns an observed value", () => {
    for (let p = 0; p <= 100; p += 5) {
      expect(ten).toContain(percentile(ten, p / 100, "nearestRank"));
    }
  });

  test("quartiles are consistent with the percentile function", () => {
    const q = quartiles(sortedCopy(ten), "r7");
    expect(q.q1).toBeCloseTo(3.25, 12);
    expect(q.q2).toBe(5.5);
    expect(q.q3).toBeCloseTo(7.75, 12);
    expect(q.iqr).toBeCloseTo(4.5, 12);
  });

  test("a fraction outside 0..1 is refused", () => {
    expect(() => percentile(ten, 1.5, "r7")).toThrow(/between 0 and 1/);
  });
});

describe("stats — correlation and regression", () => {
  test("Pearson is 1 for a perfect line and -1 for a perfect inverse", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 12);
  });

  test("Spearman sees a monotone curve that Pearson only partly sees", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [1, 4, 9, 16, 25];
    expect(spearman(x, y)).toBeCloseTo(1, 12);
    expect(pearson(x, y) as number).toBeLessThan(1);
  });

  test("ranks average their ties, which is what Spearman requires", () => {
    expect(rank([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  test("a constant series gives null, not a fabricated zero", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  test("mismatched or too-short series are refused", () => {
    expect(() => pearson([1, 2], [1])).toThrow(/paired/);
    expect(() => pearson([1], [1])).toThrow(/at least 2/);
  });

  test("regression recovers a known line exactly", () => {
    const fit = linearRegression([1, 2, 3, 4], [3, 5, 7, 9]);
    expect(fit.slope).toBeCloseTo(2, 12);
    expect(fit.intercept).toBeCloseTo(1, 12);
    expect(fit.r2).toBeCloseTo(1, 12);
    expect(fit.n).toBe(4);
  });

  test("r squared falls below 1 for scattered data", () => {
    const fit = linearRegression([1, 2, 3, 4], [3, 6, 6, 9]);
    expect(fit.r2).toBeLessThan(1);
    expect(fit.r2).toBeGreaterThan(0.5);
  });

  test("a vertical relationship has no least-squares line and is refused", () => {
    expect(() => linearRegression([2, 2, 2], [1, 2, 3])).toThrow(/no line of best fit/);
  });
});

describe("stats — histogram and outliers", () => {
  test("bucket counts total the input and the last bucket is closed", () => {
    const h = histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { bucketCount: 5 });
    expect(h.buckets.map((b) => b.count)).toEqual([2, 2, 2, 2, 2]);
    expect(h.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(10);
    expect(h.bucketWidth).toBeCloseTo(1.8, 12);
    expect(h.intervals).toContain("[lo, hi]");
  });

  test("bucketWidth is an alternative to bucketCount, never both", () => {
    const h = histogram([0, 1, 2, 3, 4, 5], { bucketWidth: 2 });
    expect(h.bucketCount).toBe(3);
    expect(h.buckets.map((b) => b.count)).toEqual([2, 2, 2]);
    expect(() => histogram([1, 2], { bucketCount: 2, bucketWidth: 1 })).toThrow(/not both/);
  });

  test("a constant series collapses to one bucket instead of dividing by zero", () => {
    const h = histogram([7, 7, 7], { bucketCount: 4 });
    expect(h.bucketCount).toBe(1);
    expect(h.buckets[0]?.count).toBe(3);
  });

  test("the IQR rule flags the far value and reports its fence", () => {
    const report = findOutliers([10, 12, 11, 13, 12, 11, 100], "iqr", 1.5);
    expect(report.outliers.map((o) => o.value)).toEqual([100]);
    expect(report.methodNote).toContain("Tukey");
    expect(report.bounds.upper).toBeLessThan(100);
  });

  test("the z-score rule uses the SAMPLE standard deviation and says so", () => {
    const report = findOutliers([1, 1, 1, 1, 1, 1, 1, 1, 1, 30], "zscore", 2);
    expect(report.outliers.map((o) => o.value)).toEqual([30]);
    expect(report.methodNote).toContain("n-1");
  });

  test("identical data is refused by both rules rather than flagging nothing usefully", () => {
    expect(() => findOutliers([5, 5, 5, 5], "zscore", 3)).toThrow(/identical/);
    expect(() => findOutliers([5, 5, 5, 5], "iqr", 1.5)).toThrow(/interquartile range is 0/);
  });

  test("too little data for the rule is refused, not guessed at", () => {
    expect(() => findOutliers([1, 2], "zscore", 3)).toThrow(/at least 3/);
    expect(() => findOutliers([1, 2, 3], "iqr", 1.5)).toThrow(/at least 4/);
  });
});

// ---------------------------------------------------------------------------

describe("money — minor units", () => {
  test("the ISO 4217 table carries the exponent, and yen is not cents", () => {
    expect(minorUnitExponent("USD")).toBe(2);
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("KWD")).toBe(3);
    expect(CURRENCY_MINOR_UNITS["EUR"]).toBe(2);
  });

  test("an unknown code is refused rather than assumed to have 2 decimals", () => {
    expect(() => minorUnitExponent("XYZ")).toThrow(/not in this package's ISO 4217 table/);
    expect(minorUnitExponent("XYZ", 0)).toBe(0);
  });

  test("a fractional minor amount is a caller mistake and is named as one", () => {
    expect(() => toMinor(10.5)).toThrow(/\$10\.50 is 1050/);
    expect(toMinor("1050")).toBe(1050n);
    expect(toMinor(-250)).toBe(-250n);
  });

  test("formatting respects the exponent", () => {
    expect(formatMinor(1050n, 2)).toBe("10.50");
    expect(formatMinor(1050n, 0)).toBe("1050");
    expect(formatMinor(1050n, 3)).toBe("1.050");
    expect(formatMinor(-5n, 2)).toBe("-0.05");
  });

  test("addition is exact where floats are not", () => {
    const cents = Array.from({ length: 10 }, () => 10n);
    expect(moneySum(cents)).toBe(100n);
    // The float equivalent of summing ten 0.1s does not reach 1.
    expect(Array.from({ length: 10 }, () => 0.1).reduce((a, b) => a + b, 0)).not.toBe(1);
  });

  test("multiplication rounds once, from the exact product", () => {
    const { rounded, exact } = moneyMultiply(1999n, parseDecimal("0.0825"), "halfEven");
    expect(decimalToString(exact)).toBe("164.9175");
    expect(rounded).toBe(165n);
    expect(moneyMultiply(1999n, parseDecimal("0.0825"), "down").rounded).toBe(164n);
  });
});

describe("money — allocation", () => {
  const allocate = (
    total: bigint,
    ratios: string[],
    policy: "largest" | "first" | "last" = "largest",
  ) =>
    moneyAllocate(
      total,
      ratios.map((r) => parseDecimal(r)),
      policy,
      2,
    );

  test("the classic case: a dollar in three equal shares", () => {
    const result = allocate(100n, ["1", "1", "1"]);
    expect(result.parts.map((p) => p.minorUnits)).toEqual(["34", "33", "33"]);
    expect(result.remainderUnits).toBe(1);
  });

  test("five cents across three shares", () => {
    expect(allocate(5n, ["1", "1", "1"]).parts.map((p) => p.minorUnits)).toEqual(["2", "2", "1"]);
  });

  test("uneven ratios go to the largest remainder first", () => {
    const result = allocate(1000n, ["3", "3", "4"]);
    expect(result.parts.map((p) => p.minorUnits)).toEqual(["300", "300", "400"]);
    const odd = allocate(1001n, ["3", "3", "4"]);
    expect(odd.parts.map((p) => p.minorUnits)).toEqual(["300", "300", "401"]);
  });

  test("the policy decides who gets the leftovers, deterministically", () => {
    expect(allocate(100n, ["1", "1", "1"], "first").parts.map((p) => p.minorUnits)).toEqual([
      "34",
      "33",
      "33",
    ]);
    expect(allocate(100n, ["1", "1", "1"], "last").parts.map((p) => p.minorUnits)).toEqual([
      "33",
      "33",
      "34",
    ]);
  });

  test("a zero ratio gets nothing, even when units are left over", () => {
    const result = allocate(100n, ["1", "0", "1", "1"]);
    expect(result.parts[1]?.minorUnits).toBe("0");
    expect(result.parts.map((p) => p.minorUnits)).toEqual(["34", "0", "33", "33"]);
  });

  test("negative totals mirror positive ones", () => {
    expect(allocate(-100n, ["1", "1", "1"]).parts.map((p) => p.minorUnits)).toEqual([
      "-34",
      "-33",
      "-33",
    ]);
  });

  test("percentages that do not divide cleanly still reconcile", () => {
    const result = allocate(10_000n, ["0.3333", "0.3333", "0.3334"]);
    const sum = result.parts.reduce((total, p) => total + BigInt(p.minorUnits), 0n);
    expect(sum).toBe(10_000n);
  });

  test("THE INVARIANT: the parts always sum to the whole, over many shapes", () => {
    // A deterministic linear congruential generator — no clock, no Math.random,
    // so a failure here is reproducible from the source alone.
    let seed = 20_260_917;
    const nextInt = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    for (let i = 0; i < 500; i++) {
      const total = BigInt(nextInt(2_000_000) - 1_000_000);
      const count = 1 + nextInt(9);
      const ratios = Array.from({ length: count }, () => String(nextInt(100)));
      if (ratios.every((r) => r === "0")) ratios[0] = "1";
      for (const policy of ["largest", "first", "last"] as const) {
        const result = allocate(total, ratios, policy);
        const sum = result.parts.reduce((acc, p) => acc + BigInt(p.minorUnits), 0n);
        expect({ i, policy, sum }).toEqual({ i, policy, sum: total });
      }
    }
  });

  test("ratios that are all zero, or negative, are refused", () => {
    expect(() => allocate(100n, ["0", "0"])).toThrow(/sum to zero/);
    expect(() => allocate(100n, ["-1", "2"])).toThrow(/not be negative/);
  });
});

describe("money — currency conversion", () => {
  const rates = { "USD/EUR": "0.92", "USD/JPY": "157.4" };

  test("a direct rate is applied exactly and rounded once", () => {
    const { rate, source } = lookupRate(rates, "USD", "EUR", false);
    expect(source).toBe("direct");
    expect(convertMinor(10_000n, rate, 2, 2, "halfEven")).toBe(9_200n);
  });

  test("the minor-unit exponents of BOTH currencies are honoured", () => {
    const { rate } = lookupRate(rates, "USD", "JPY", false);
    // $100.00 -> 15740 yen, not 1574000 minor units of a 2-decimal currency.
    expect(convertMinor(10_000n, rate, 2, 0, "halfEven")).toBe(15_740n);
  });

  test("an identity conversion needs no rate", () => {
    expect(lookupRate({}, "USD", "USD", false).source).toBe("identity");
  });

  test("inverting a quote is opt-in, because a dealer's inverse is not 1/x", () => {
    expect(() => lookupRate(rates, "EUR", "USD", false)).toThrow(/no rate for EUR\/USD/);
    const inverse = lookupRate(rates, "EUR", "USD", true);
    expect(inverse.source).toBe("inverse");
    expect(convertMinor(9_200n, inverse.rate, 2, 2, "halfEven")).toBe(10_000n);
  });

  test("six-letter and punctuated keys normalize to the same pair", () => {
    expect(lookupRate({ USDEUR: 2 }, "USD", "EUR", false).rate.unscaled).toBe(2n);
    expect(lookupRate({ "usd-eur": 2 }, "USD", "EUR", false).rate.unscaled).toBe(2n);
  });

  test("a missing or non-positive rate is refused", () => {
    expect(() => lookupRate({}, "USD", "GBP", true)).toThrow(/no rate/);
    expect(() => lookupRate({ "USD/GBP": "0" }, "USD", "GBP", false)).toThrow(/greater than zero/);
    expect(() => lookupRate({ "USD/GBP": "par" }, "USD", "GBP", false)).toThrow(/not a decimal/);
  });
});

// ---------------------------------------------------------------------------

describe("units", () => {
  test("definitional factors are exact", () => {
    expect(convertUnits(1, "in", "m").value).toBe(0.0254);
    expect(convertUnits(1, "mi", "ft").value).toBeCloseTo(5280, 9);
    expect(convertUnits(1, "lb", "g").value).toBeCloseTo(453.59237, 9);
    expect(convertUnits(1, "kWh", "J").value).toBe(3_600_000);
    expect(convertUnits(1, "GiB", "MiB").value).toBe(1024);
    expect(convertUnits(1, "GB", "MB").value).toBeCloseTo(1000, 9);
  });

  test("the exactness of the factors used is reported", () => {
    expect(convertUnits(1, "in", "m").exact).toBe(true);
    expect(convertUnits(1, "psi", "Pa").exact).toBe(false);
  });

  test("temperature is affine, not a scale factor", () => {
    expect(convertUnits(100, "C", "F").value).toBeCloseTo(212, 9);
    expect(convertUnits(0, "C", "F").value).toBeCloseTo(32, 9);
    expect(convertUnits(-40, "C", "F").value).toBeCloseTo(-40, 9);
    expect(convertUnits(0, "C", "K").value).toBeCloseTo(273.15, 9);
    expect(convertUnits(0, "F", "R").value).toBeCloseTo(459.67, 9);
    expect(convertUnits(100, "C", "F").method).toContain("affine");
  });

  test("a temperature below absolute zero is refused", () => {
    expect(() => convertUnits(-300, "C", "F")).toThrow(/absolute zero/);
  });

  test("temperature does not convert to anything else", () => {
    expect(() => convertUnits(1, "C", "m")).toThrow(/dimension of its own/);
  });

  test("cross-dimension conversion names both dimensions", () => {
    expect(() => convertUnits(1, "m", "s")).toThrow(/different dimensions/);
  });

  test("US and imperial volumes are distinct units", () => {
    const us = convertUnits(1, "gal_us", "l").value;
    const uk = convertUnits(1, "gal_uk", "l").value;
    expect(us).toBeCloseTo(3.785411784, 9);
    expect(uk).toBeCloseTo(4.54609, 9);
    expect(us).not.toBeCloseTo(uk, 3);
  });

  test("an ambiguous abbreviation is refused with the candidates", () => {
    const resolved = resolveUnit("b");
    expect(resolved).toHaveProperty("ambiguous");
    expect(() => convertUnits(1, "b", "B")).toThrow(/matches more than one unit/);
  });

  test("an unknown unit points at the catalog", () => {
    expect(() => convertUnits(1, "smoot", "m")).toThrow(/unknown unit "smoot"/);
  });

  test("months and years are deliberately absent from the time units", () => {
    const catalog = unitCatalog();
    expect(catalog["time"]).not.toContain("mo");
    expect(catalog["time"]).not.toContain("yr");
    expect(catalog["temperature"]).toEqual(["C", "F", "K", "R"]);
  });

  test("round-tripping returns the original value", () => {
    for (const [from, to] of [
      ["km", "mi"],
      ["kg", "lb"],
      ["l", "gal_us"],
      ["h", "s"],
      ["C", "F"],
    ] as const) {
      const forward = convertUnits(12.5, from, to).value;
      expect(convertUnits(forward, to, from).value).toBeCloseTo(12.5, 9);
    }
  });
});

// ---------------------------------------------------------------------------

describe("finance — percentages", () => {
  test("percent change is relative to the starting value", () => {
    expect(percentChange(200, 250).percentChange).toBeCloseTo(25, 12);
    expect(percentChange(250, 200).percentChange).toBeCloseTo(-20, 12);
  });

  test("change from zero is refused, not reported as infinite", () => {
    expect(() => percentChange(0, 5)).toThrow(/undefined/);
  });

  test("share of a total", () => {
    const result = percentOfTotal(25, 200);
    expect(result.percent).toBeCloseTo(12.5, 12);
    expect(result.remainder).toBe(175);
    expect(() => percentOfTotal(1, 0)).toThrow(/undefined/);
  });

  test("a 50% markup is a 33.3% margin — the confusion this tool exists for", () => {
    const result = markupMargin({ cost: 100, markupPercent: 50 });
    expect(result.price).toBeCloseTo(150, 12);
    expect(result.marginPercent).toBeCloseTo(100 / 3, 10);
  });

  test("the square closes from any two values", () => {
    expect(markupMargin({ cost: 100, price: 150 }).markupPercent).toBeCloseTo(50, 12);
    expect(markupMargin({ price: 150, marginPercent: 100 / 3 }).cost).toBeCloseTo(100, 10);
    expect(markupMargin({ price: 150, markupPercent: 50 }).cost).toBeCloseTo(100, 10);
    expect(markupMargin({ cost: 100, marginPercent: 100 / 3 }).price).toBeCloseTo(150, 10);
  });

  test("impossible or underdetermined inputs are refused", () => {
    expect(() => markupMargin({ cost: 100 })).toThrow(/exactly two/);
    expect(() => markupMargin({ cost: 100, marginPercent: 100 })).toThrow(/100% or more/);
  });
});

describe("finance — amortization", () => {
  const schedule = (over: Partial<Parameters<typeof amortize>[0]> = {}) =>
    amortize({
      principalMinor: 10_000_000n,
      annualRatePercent: parseDecimal("6"),
      periods: 360,
      periodsPerYear: 12,
      mode: "halfEven",
      includeSchedule: true,
      ...over,
    });

  test("the payment matches the standard annuity formula", () => {
    // $100,000 at 6% nominal over 30 years is the textbook $599.55/month.
    expect(Number(schedule().periodicPaymentMinor)).toBeCloseTo(59_955, 0);
  });

  test("the balance closes at exactly zero and the rows reconcile", () => {
    const result = schedule();
    expect(result.schedule.length).toBe(360);
    expect(result.schedule[359]?.balance).toBe("0");
    const paid = result.schedule.reduce((sum, row) => sum + BigInt(row.payment), 0n);
    const interest = result.schedule.reduce((sum, row) => sum + BigInt(row.interest), 0n);
    const principal = result.schedule.reduce((sum, row) => sum + BigInt(row.principal), 0n);
    expect(principal).toBe(10_000_000n);
    expect(paid).toBe(principal + interest);
    expect(paid.toString()).toBe(result.totalPaidMinor);
    expect(interest.toString()).toBe(result.totalInterestMinor);
  });

  test("the final payment absorbs the rounding drift", () => {
    const result = schedule();
    expect(result.finalPaymentMinor).not.toBe(result.periodicPaymentMinor);
    expect(
      Math.abs(Number(result.finalPaymentMinor) - Number(result.periodicPaymentMinor)),
    ).toBeLessThan(200);
  });

  test("a zero-rate loan is just a division, and still closes exactly", () => {
    const result = schedule({ annualRatePercent: parseDecimal("0"), periods: 7 });
    expect(result.totalInterestMinor).toBe("0");
    expect(result.totalPaidMinor).toBe("10000000");
  });

  test("interest is exact rational arithmetic, not a float rate", () => {
    const result = schedule({ periods: 1 });
    // One period at 6%/12 on $100,000 is exactly $500.00.
    expect(result.schedule[0]?.interest).toBe("50000");
  });

  test("a schedule can be suppressed when only the totals are wanted", () => {
    const result = schedule({ includeSchedule: false });
    expect(result.schedule).toEqual([]);
    expect(result.totalInterestMinor.length).toBeGreaterThan(0);
  });

  test("nonsense inputs are refused", () => {
    expect(() => schedule({ principalMinor: 0n })).toThrow(/greater than zero/);
    expect(() => schedule({ periods: 0 })).toThrow(/between 1 and/);
    expect(() => schedule({ annualRatePercent: parseDecimal("-1") })).toThrow(/not be negative/);
  });
});

describe("finance — NPV and IRR", () => {
  test("NPV discounts from t=0 by default", () => {
    const result = npv(0.1, [-100, 60, 60], 0);
    expect(result.npv).toBeCloseTo(4.1322, 4);
    expect(result.discounted[0]).toBe(-100);
  });

  test("firstPeriod 1 reproduces Excel's NPV(), which differs by (1+r)", () => {
    const textbook = npv(0.1, [-100, 60, 60], 0).npv;
    const excel = npv(0.1, [-100, 60, 60], 1).npv;
    expect(excel).toBeCloseTo(textbook / 1.1, 10);
  });

  test("a rate of -100% or lower is refused", () => {
    expect(() => npv(-1, [1, 2], 0)).toThrow(/-100%/);
  });

  test("IRR zeroes the NPV of the series it was computed from", () => {
    const result = irr([-100, 60, 60], 1e-9, 200);
    expect(result.irr).toBeCloseTo(0.130662, 5);
    expect(Math.abs(result.npvAtIrr)).toBeLessThan(1e-6);
    expect(result.method).toContain("bisection");
  });

  test("a series with one sign change carries no multiple-root warning", () => {
    expect(irr([-1000, 300, 400, 500], 1e-9, 200).warning).toBeUndefined();
  });

  test("several sign changes are flagged, because several IRRs can exist", () => {
    const result = irr([-100, 500, -600], 1e-9, 200);
    expect(result.signChanges).toBe(2);
    expect(result.warning).toContain("can exist");
  });

  test("a series that cannot have an IRR is refused rather than answered", () => {
    expect(() => irr([100, 200, 300], 1e-9, 200)).toThrow(/same sign/);
  });

  test("the tolerance and iteration cap are bounded", () => {
    expect(() => irr([-1, 2], 0, 200)).toThrow(/tolerance/);
    expect(() => irr([-1, 2], 1e-9, 0)).toThrow(/maxIterations/);
  });
});

// ---------------------------------------------------------------------------

describe("geo", () => {
  const london = { lat: 51.5074, lon: -0.1278 };
  const paris = { lat: 48.8566, lon: 2.3522 };

  test("one degree of longitude at the equator is the radius times pi/180", () => {
    const d = haversineDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, EARTH_RADIUS_M);
    expect(d.metres).toBeCloseTo((EARTH_RADIUS_M * Math.PI) / 180, 3);
  });

  test("London to Paris is about 343 km, and the units agree with each other", () => {
    const d = haversineDistance(london, paris, EARTH_RADIUS_M);
    expect(d.kilometres).toBeCloseTo(343.5, 0);
    expect(d.miles).toBeCloseTo(d.metres / 1609.344, 9);
    expect(d.nauticalMiles).toBeCloseTo(d.metres / 1852, 9);
    expect(d.method).toContain("6371008.8");
  });

  test("distance is symmetric and zero to itself", () => {
    expect(haversineDistance(london, paris, EARTH_RADIUS_M).metres).toBeCloseTo(
      haversineDistance(paris, london, EARTH_RADIUS_M).metres,
      6,
    );
    expect(haversineDistance(london, london, EARTH_RADIUS_M).metres).toBe(0);
  });

  test("the initial bearing points the right way", () => {
    expect(
      haversineDistance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }, EARTH_RADIUS_M)
        .initialBearingDegrees,
    ).toBeCloseTo(0, 6);
    expect(
      haversineDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, EARTH_RADIUS_M)
        .initialBearingDegrees,
    ).toBeCloseTo(90, 6);
  });

  test("coordinates outside the valid ranges are refused", () => {
    expect(() => haversineDistance({ lat: 91, lon: 0 }, london, EARTH_RADIUS_M)).toThrow(
      /latitude/,
    );
    expect(() => haversineDistance({ lat: 0, lon: 181 }, london, EARTH_RADIUS_M)).toThrow(
      /longitude/,
    );
  });

  test("a bounding box contains its points", () => {
    const box = boundingBoxOf([london, paris, { lat: 50, lon: 1 }]);
    expect(box.minLat).toBeCloseTo(48.8566, 6);
    expect(box.maxLat).toBeCloseTo(51.5074, 6);
    expect(box.minLon).toBeCloseTo(-0.1278, 6);
    expect(box.maxLon).toBeCloseTo(2.3522, 6);
    expect(box.crossesAntimeridian).toBe(false);
  });

  test("points either side of the antimeridian take the short way round", () => {
    const box = boundingBoxOf([
      { lat: 0, lon: 179 },
      { lat: 0, lon: -179 },
    ]);
    expect(box.crossesAntimeridian).toBe(true);
    expect(box.minLon).toBe(179);
    expect(box.maxLon).toBe(-179);
    expect(box.note).toContain("minLon > maxLon");
  });

  test("a radius box is a superset of its circle", () => {
    const center = { lat: 51.5, lon: -0.12 };
    const box = boundingBoxAround(center, 10_000, EARTH_RADIUS_M);
    const north = { lat: center.lat + 0.08, lon: center.lon };
    expect(haversineDistance(center, north, EARTH_RADIUS_M).metres).toBeLessThan(10_000);
    expect(north.lat).toBeLessThanOrEqual(box.maxLat);
    expect(box.minLat).toBeLessThan(center.lat);
    expect(box.note).toContain("superset");
  });

  test("a radius reaching a pole widens to every longitude", () => {
    const box = boundingBoxAround({ lat: 89.9, lon: 0 }, 100_000, EARTH_RADIUS_M);
    expect(box.minLon).toBe(-180);
    expect(box.maxLon).toBe(180);
    expect(box.note).toContain("pole");
  });

  test("point in polygon: inside, outside and on the boundary", () => {
    const square = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 10 },
      { lat: 10, lon: 10 },
      { lat: 10, lon: 0 },
    ];
    expect(pointInPolygon({ lat: 5, lon: 5 }, square).inside).toBe(true);
    expect(pointInPolygon({ lat: 15, lon: 5 }, square).inside).toBe(false);
    const edge = pointInPolygon({ lat: 0, lon: 5 }, square);
    expect(edge.onBoundary).toBe(true);
    expect(edge.inside).toBe(true);
    const vertex = pointInPolygon({ lat: 10, lon: 10 }, square);
    expect(vertex.onBoundary).toBe(true);
  });

  test("a concave ring is handled by the even-odd rule", () => {
    const uShape = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 10 },
      { lat: 10, lon: 10 },
      { lat: 10, lon: 7 },
      { lat: 3, lon: 7 },
      { lat: 3, lon: 3 },
      { lat: 10, lon: 3 },
      { lat: 10, lon: 0 },
    ];
    expect(pointInPolygon({ lat: 1, lon: 5 }, uShape).inside).toBe(true);
    expect(pointInPolygon({ lat: 8, lon: 5 }, uShape).inside).toBe(false);
  });

  test("a closed ring (first vertex repeated) gives the same answer as an open one", () => {
    const open = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 4 },
      { lat: 4, lon: 4 },
      { lat: 4, lon: 0 },
    ];
    const closed = [...open, { lat: 0, lon: 0 }];
    expect(pointInPolygon({ lat: 2, lon: 2 }, closed)).toEqual(
      pointInPolygon({ lat: 2, lon: 2 }, open),
    );
  });

  test("a ring that would wrap the globe is refused, not read inside-out", () => {
    const wide = [
      { lat: 0, lon: -170 },
      { lat: 0, lon: 170 },
      { lat: 10, lon: 170 },
    ];
    expect(() => pointInPolygon({ lat: 5, lon: 180 }, wide)).toThrow(/antimeridian/);
  });

  test("a degenerate ring is refused", () => {
    expect(() =>
      pointInPolygon({ lat: 0, lon: 0 }, [
        { lat: 0, lon: 0 },
        { lat: 1, lon: 1 },
      ]),
    ).toThrow(/at least 3/);
  });
});

// ---------------------------------------------------------------------------

describe("numfmt", () => {
  test("formatting follows the locale, not the machine", () => {
    expect(formatNumber(1234.56, { locale: "en-US", style: "decimal" }).formatted).toBe("1,234.56");
    expect(formatNumber(1234.56, { locale: "de-DE", style: "decimal" }).formatted).toBe("1.234,56");
    expect(
      formatNumber(1050, { locale: "ja-JP", style: "currency", currency: "JPY" }).formatted,
    ).toContain("1,050");
  });

  test("an unsupported or malformed locale is refused, never silently defaulted", () => {
    expect(() => formatNumber(1, { locale: "xx-ZZ", style: "decimal" })).toThrow(/no data/);
    expect(() => formatNumber(1, { locale: "not a locale", style: "decimal" })).toThrow(/BCP 47/);
  });

  test("currency style needs a currency", () => {
    expect(() => formatNumber(1, { locale: "en-US", style: "currency" })).toThrow(/currency code/);
  });

  test("parsing is the inverse of formatting, per locale", () => {
    for (const locale of ["en-US", "de-DE", "fr-FR", "en-IN", "ja-JP"]) {
      const formatted = formatNumber(1234567.89, { locale, style: "decimal" }).formatted;
      expect({ locale, value: parseLocaleNumber(formatted, locale).value }).toEqual({
        locale,
        value: 1234567.89,
      });
    }
  });

  test("the same string means different numbers in different locales", () => {
    expect(parseLocaleNumber("1.234,56", "de-DE").value).toBe(1234.56);
    expect(() => parseLocaleNumber("1.234,56", "en-US")).toThrow();
  });

  test("a mis-grouped number is refused rather than silently multiplied by 100", () => {
    // Under de-DE "." is the GROUP separator, so "1234.56" is not 1234.56.
    expect(() => parseLocaleNumber("1234.56", "de-DE")).toThrow(/not a valid first group/);
  });

  test("currency symbols and percent signs are reported, not silently dropped", () => {
    const money = parseLocaleNumber("$1,234.50", "en-US");
    expect(money.value).toBe(1234.5);
    expect(money.currencySymbolStripped).toBe("$");
    const percent = parseLocaleNumber("12.5%", "en-US");
    expect(percent.value).toBe(12.5);
    expect(percent.hadPercentSign).toBe(true);
    expect(percent.asFraction).toBe(0.125);
  });

  test("accounting parentheses mean negative", () => {
    expect(parseLocaleNumber("(1,234.50)", "en-US").value).toBe(-1234.5);
  });

  test("a locale minus sign and a Unicode minus both parse", () => {
    expect(parseLocaleNumber("−1234.5", "en-US").value).toBe(-1234.5);
  });

  test("non-Latin digits parse for their locale", () => {
    const arabic = formatNumber(1234.5, { locale: "ar-EG", style: "decimal" }).formatted;
    expect(parseLocaleNumber(arabic, "ar-EG").value).toBeCloseTo(1234.5, 9);
  });

  test("text that is not a number is refused with what it reduced to", () => {
    expect(() => parseLocaleNumber("abc", "en-US")).toThrow(/is not a number/);
    expect(() => parseLocaleNumber("1.2.3", "en-US")).toThrow();
  });
});
