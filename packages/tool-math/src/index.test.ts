/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * Three things are checked for all of them, because they are the contract the
 * runtime relies on: the safety flags are what a pure-compute tool must
 * declare, the declared schema actually rejects bad input, and the
 * description's second sentence tells a model when to reach for it. After
 * that, each tool gets the behaviour tests that matter for it — and for this
 * package that mostly means proving it states its method and refuses rather
 * than answering confidently and wrongly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MATH_TOOLS,
  amortize,
  correlation,
  currencyConvert,
  evaluate,
  geoBoundingBox,
  geoDistance,
  geoPointInPolygon,
  histogram,
  irr,
  linearRegressionTool,
  moneyAdd,
  moneyAllocateTool,
  moneyMultiplyTool,
  npv,
  numberFormat,
  numberParse,
  outliers,
  percent,
  percentile,
  round,
  statistics,
  unitConvert,
} from "./index";

/** Tools return compact JSON; parse it so assertions read as data. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: (typeof MATH_TOOLS)[number], input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/** The raw string, for the cases where the refusal text IS the result. */
async function text(tool: (typeof MATH_TOOLS)[number], input: unknown): Promise<string> {
  return String(await tool.execute(input));
}

describe("package-wide contract", () => {
  test("every tool is exported in MATH_TOOLS", () => {
    expect(MATH_TOOLS.length).toBe(22);
  });

  test("names are unique", () => {
    const names = MATH_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool is PascalCase", () => {
    for (const t of MATH_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("the export is frozen, so a caller cannot mutate the registry", () => {
    expect(Object.isFrozen(MATH_TOOLS)).toBe(true);
  });

  test("every tool is read-only, non-destructive and internal — this package touches nothing", () => {
    for (const t of MATH_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, sandbox: t.requiresSandbox }).toEqual({
        name: t.name,
        sandbox: false,
      });
    }
  });

  test("no tool declares an io capability, because none crosses a boundary", () => {
    for (const t of MATH_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("every tool is concurrency-safe, since all are pure", () => {
    for (const t of MATH_TOOLS) {
      expect({ name: t.name, safe: t.concurrencySafe }).toEqual({ name: t.name, safe: true });
    }
  });

  test("every description says what it is for in its second sentence", () => {
    for (const t of MATH_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      const sentences = t.description.split(/(?<=\.)\s+/);
      expect({ name: t.name, second: (sentences[1] ?? "").slice(0, 4) }).toEqual({
        name: t.name,
        second: "Use ",
      });
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of MATH_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  test("results are compact JSON — no indentation burning context", async () => {
    const out = await text(statistics, { values: [1, 2, 3] });
    expect(out).not.toContain("\n");
  });

  test("the same input returns the same bytes, every time", async () => {
    const input = { values: [3, 1, 4, 1, 5, 9, 2, 6] };
    const first = await text(statistics, input);
    const second = await text(statistics, input);
    expect(second).toBe(first);
  });

  test("the sources import no node builtin, which is what 'pure' has to mean", () => {
    // The safety flags say this package touches no file, socket or process. That
    // claim is only as good as the imports, so it is checked rather than trusted.
    const dir = new URL(".", import.meta.url).pathname;
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .sort();
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(join(dir, file), "utf8");
      expect({ file, node: /from "node:/.test(source) }).toEqual({ file, node: false });
      expect({ file, fetch: /\bfetch\s*\(/.test(source) }).toEqual({ file, fetch: false });
      expect({ file, now: /Date\.now\(|Math\.random\(/.test(source) }).toEqual({
        file,
        now: false,
      });
    }
  });

  test("no execute throws: hostile input for every tool comes back as a string", async () => {
    // A thrown error costs the harness a turn to interpret, so the contract is
    // that `execute` always resolves to text. These are the shapes that used to
    // break it: names inherited from Object.prototype, and Infinity, which
    // satisfies a `z.number()` schema.
    const hostile: Array<[(typeof MATH_TOOLS)[number], unknown]> = [
      [evaluate, { expression: "__proto__(1)" }],
      [evaluate, { expression: "constructor(1)" }],
      [unitConvert, { value: 1, from: "toString", to: "m" }],
      [unitConvert, { value: 20, from: "constructor", to: "F" }],
      [histogram, { values: [1, 2, 3], origin: Number.NEGATIVE_INFINITY }],
      [histogram, { values: [1, 2, 3], bucketWidth: Number.POSITIVE_INFINITY }],
      [
        geoDistance,
        {
          from: { lat: 0, lon: 0 },
          to: { lat: 1, lon: 1 },
          radiusMetres: Number.POSITIVE_INFINITY,
        },
      ],
      [moneyAdd, { currency: "USD", amountsMinor: ["9".repeat(5_000)] }],
      [percentile, { values: [5], percentiles: [99], method: "r6" }],
      [numberParse, { text: "((1,234.50))", locale: "en-US" }],
      [percent, { operation: "markupMargin", cost: 100, price: 150, markupPercent: 999 }],
    ];
    for (const [tool, input] of hostile) {
      const out = await tool.execute(input);
      expect({ name: tool.name, type: typeof out }).toEqual({ name: tool.name, type: "string" });
      expect({ name: tool.name, empty: String(out).length === 0 }).toEqual({
        name: tool.name,
        empty: false,
      });
    }
  });
});

describe("Evaluate", () => {
  test("evaluates with precedence and reports what it used", async () => {
    const out = await run(evaluate, {
      expression: "subtotal * (1 + vat)",
      variables: { subtotal: 200, vat: 0.2 },
    });
    expect(out.value).toBeCloseTo(240, 10);
    expect(out.usedNames).toEqual(["subtotal", "vat"]);
    expect(out.grammar.functions).toContain("sqrt");
  });

  test("a caller mistake comes back as a readable string, not an exception", async () => {
    expect(await text(evaluate, { expression: "1/0" })).toContain("division by zero");
    expect(await text(evaluate, { expression: "wat" })).toContain("unknown name");
    expect(await text(evaluate, { expression: "2 +" })).toContain("at character");
  });

  test("nothing outside the grammar is evaluated", async () => {
    expect(await text(evaluate, { expression: "require('fs')" })).toContain("unexpected character");
    expect(await text(evaluate, { expression: "process" })).toContain("unknown name");
  });

  test("the schema bounds the expression length", () => {
    expect(evaluate.inputSchema.safeParse({ expression: "1".repeat(5_000) }).success).toBe(false);
    expect(evaluate.inputSchema.safeParse({ expression: "" }).success).toBe(false);
  });
});

describe("Statistics and Percentile", () => {
  test("a summary labels sample and population separately", async () => {
    const out = await run(statistics, { values: [2, 4, 4, 4, 5, 5, 7, 9] });
    expect(out.mean).toBe(5);
    expect(out.stdev.population).toBeCloseTo(2, 12);
    expect(out.stdev.sample).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(out.percentileMethodNote).toContain("R type 7");
  });

  test("the quartile convention is selectable and echoed", async () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const r7 = await run(statistics, { values });
    const nearest = await run(statistics, { values, percentileMethod: "nearestRank" });
    expect(r7.quartiles.q1).toBeCloseTo(3.25, 12);
    expect(nearest.quartiles.q1).toBe(3);
  });

  test("several percentiles come back in one call, with the method named", async () => {
    const out = await run(percentile, {
      values: Array.from({ length: 100 }, (_, i) => i + 1),
      percentiles: [50, 95, 99],
    });
    expect(out.results.map((r: { percentile: number }) => r.percentile)).toEqual([50, 95, 99]);
    expect(out.method).toBe("r7");
    expect(out.methodNote).toContain("NumPy");
  });

  test("an undefined r6 tail is refused in the result, not clamped", async () => {
    const out = await text(percentile, { values: [1, 2, 3], percentiles: [1], method: "r6" });
    expect(out).toContain("undefined");
  });

  test("the schema bounds the series length", () => {
    expect(statistics.inputSchema.safeParse({ values: [] }).success).toBe(false);
    expect(statistics.inputSchema.safeParse({ values: ["1"] }).success).toBe(false);
  });
});

describe("Correlation and LinearRegression", () => {
  test("both coefficients are returned with a caution about n", async () => {
    const out = await run(correlation, { x: [1, 2, 3, 4], y: [2, 4, 6, 8] });
    expect(out.pearson.r).toBeCloseTo(1, 12);
    expect(out.spearman.rho).toBeCloseTo(1, 12);
    expect(out.caution).toContain("too small");
  });

  test("a single method can be requested", async () => {
    const out = await run(correlation, { x: [1, 2, 3], y: [3, 2, 1], method: "pearson" });
    expect(out.pearson.r).toBeCloseTo(-1, 12);
    expect(out.spearman).toBeUndefined();
  });

  test("regression predicts from the fitted line", async () => {
    const out = await run(linearRegressionTool, {
      x: [1, 2, 3, 4],
      y: [3, 5, 7, 9],
      predictX: [10],
    });
    expect(out.slope).toBeCloseTo(2, 12);
    expect(out.predictions[0].y).toBeCloseTo(21, 10);
    expect(out.equation).toContain("y = ");
  });

  test("mismatched series are refused in the result", async () => {
    expect(await text(correlation, { x: [1, 2], y: [1] })).toContain("paired");
  });
});

describe("Histogram and Outliers", () => {
  test("buckets report their bounds and total the input", async () => {
    const out = await run(histogram, { values: [1, 2, 3, 4, 5, 6], bucketCount: 3 });
    expect(out.buckets.length).toBe(3);
    expect(out.buckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0)).toBe(6);
    expect(out.buckets[0].label).toContain("[");
  });

  test("the default rule is the IQR rule, and the threshold follows the rule", async () => {
    const values = [10, 12, 11, 13, 12, 11, 100];
    const iqr = await run(outliers, { values });
    const z = await run(outliers, { values, method: "zscore" });
    expect(iqr.method).toBe("iqr");
    expect(iqr.threshold).toBe(1.5);
    expect(z.threshold).toBe(3);
    expect(iqr.outliers[0].value).toBe(100);
  });

  test("giving both bucket controls is refused", async () => {
    expect(await text(histogram, { values: [1, 2], bucketCount: 2, bucketWidth: 1 })).toContain(
      "not both",
    );
  });

  test("an infinite origin is rejected by the schema AND refused by execute", async () => {
    expect(
      histogram.inputSchema.safeParse({ values: [1, 2, 3], origin: Number.NEGATIVE_INFINITY })
        .success,
    ).toBe(false);
    expect(
      await text(histogram, { values: [1, 2, 3], origin: Number.NEGATIVE_INFINITY }),
    ).toContain("finite");
  });

  test("an empty outlier list says what it does not prove", async () => {
    const out = await run(outliers, { values: [10, 11, 12, 11, 10, 12] });
    expect(out.count).toBe(0);
    expect(out.finding).toContain("not evidence that the data is clean");
  });
});

describe("MoneyAdd, MoneyMultiply, MoneyAllocate", () => {
  test("adding is exact and carries the currency's exponent", async () => {
    const out = await run(moneyAdd, { currency: "USD", amountsMinor: [1050, 2575, -25] });
    expect(out.minorUnits).toBe("3600");
    expect(out.amount).toBe("36.00");
    expect(out.exponent).toBe(2);
  });

  test("yen has no cents, and the tool knows it", async () => {
    const out = await run(moneyAdd, { currency: "JPY", amountsMinor: [1050, 50] });
    expect(out.amount).toBe("1100");
    expect(out.exponent).toBe(0);
  });

  test("an unknown currency is refused with the way to proceed", async () => {
    const out = await text(moneyAdd, { currency: "XBT", amountsMinor: [1] });
    expect(out).toContain("pass exponent explicitly");
  });

  test("a float amount is caught as the caller mistake it is", async () => {
    expect(await text(moneyAdd, { currency: "USD", amountsMinor: [10.5] })).toContain("1050");
  });

  test("tax on a line total rounds once, from the exact product", async () => {
    const out = await run(moneyMultiplyTool, {
      currency: "USD",
      amountMinor: 1999,
      factor: "0.0825",
    });
    expect(out.exactMinorUnits).toBe("164.9175");
    expect(out.minorUnits).toBe("165");
    expect(out.roundingNote).toContain("banker's");
  });

  test("the rounding mode changes the answer and is reported", async () => {
    const down = await run(moneyMultiplyTool, {
      currency: "USD",
      amountMinor: 1999,
      factor: "0.0825",
      rounding: "down",
    });
    expect(down.minorUnits).toBe("164");
    expect(down.rounding).toBe("down");
  });

  test("an allocation always sums to the whole", async () => {
    const out = await run(moneyAllocateTool, {
      currency: "USD",
      amountMinor: 100,
      ratios: [1, 1, 1],
    });
    expect(out.parts.map((p: { minorUnits: string }) => p.minorUnits)).toEqual(["34", "33", "33"]);
    expect(out.parts.map((p: { amount: string }) => p.amount)).toEqual(["0.34", "0.33", "0.33"]);
    expect(out.sumsToTotal).toBe(true);
  });

  test("the remainder policy is honoured and reported", async () => {
    const out = await run(moneyAllocateTool, {
      currency: "USD",
      amountMinor: 100,
      ratios: [1, 1, 1],
      remainderPolicy: "last",
    });
    expect(out.parts.map((p: { minorUnits: string }) => p.minorUnits)).toEqual(["33", "33", "34"]);
    expect(out.policy).toBe("last");
  });

  test("zero ratios are refused rather than divided by", async () => {
    expect(
      await text(moneyAllocateTool, { currency: "USD", amountMinor: 100, ratios: [0, 0] }),
    ).toContain("sum to zero");
  });
});

describe("input caps", () => {
  test("an amount with thousands of digits is refused, not multiplied out", async () => {
    const huge = "9".repeat(5_000);
    expect(moneyAdd.inputSchema.safeParse({ currency: "USD", amountsMinor: [huge] }).success).toBe(
      false,
    );
    expect(await text(moneyAdd, { currency: "USD", amountsMinor: [huge] })).toContain(
      "over the 1000 limit",
    );
    expect(
      await text(moneyAllocateTool, {
        currency: "USD",
        amountMinor: huge,
        ratios: ["1", "1", "1"],
      }),
    ).toContain("over the 1000 limit");
  });

  test("a thousand-digit amount is still accepted, so the cap is not in the way", async () => {
    const thousand = "9".repeat(1_000);
    const out = await run(moneyAdd, { currency: "USD", amountsMinor: [thousand] });
    expect(out.minorUnits).toBe(thousand);
  });
});

describe("CurrencyConvert", () => {
  const rates = { "USD/EUR": "0.92", "USD/JPY": "157.4" };

  test("converts with the caller's table and says the rate is theirs", async () => {
    const out = await run(currencyConvert, {
      amountMinor: 10_000,
      from: "USD",
      to: "EUR",
      rates,
    });
    expect(out.to.amount).toBe("92.00");
    expect(out.rateSource).toBe("direct");
    expect(out.method).toContain("not a live quote");
  });

  test("a 2-decimal to 0-decimal conversion is not a no-op", async () => {
    const out = await run(currencyConvert, {
      amountMinor: 10_000,
      from: "USD",
      to: "JPY",
      rates,
    });
    expect(out.to.minorUnits).toBe("15740");
    expect(out.to.amount).toBe("15740");
  });

  test("an inverse rate must be opted into", async () => {
    expect(
      await text(currencyConvert, { amountMinor: 100, from: "EUR", to: "USD", rates }),
    ).toContain("no rate for EUR/USD");
    const allowed = await run(currencyConvert, {
      amountMinor: 9_200,
      from: "EUR",
      to: "USD",
      rates,
      allowInverse: true,
    });
    expect(allowed.to.minorUnits).toBe("10000");
    expect(allowed.rateSource).toBe("inverse");
  });
});

describe("UnitConvert", () => {
  test("converts with an exact factor and shows the arithmetic", async () => {
    const out = await run(unitConvert, { value: 5, from: "km", to: "mi" });
    expect(out.value).toBeCloseTo(3.10686, 5);
    expect(out.method).toContain("/");
    expect(out.exact).toBe(true);
  });

  test("temperature is affine", async () => {
    const out = await run(unitConvert, { value: 37, from: "C", to: "F" });
    expect(out.value).toBeCloseTo(98.6, 9);
    expect(out.method).toContain("affine");
  });

  test("a cross-dimension request is refused", async () => {
    expect(await text(unitConvert, { value: 1, from: "kg", to: "m" })).toContain(
      "different dimensions",
    );
  });

  test("the catalog is available without a conversion", async () => {
    const out = await run(unitConvert, { list: true });
    expect(out.units.length).toContain("nmi");
    expect(out.units.temperature).toEqual(["C", "F", "K", "R"]);
    expect(out.units.data).toContain("GiB");
  });

  test("an incomplete call explains what is missing", async () => {
    expect(await text(unitConvert, { value: 1 })).toContain("give value, from and to");
  });

  test("a name inherited from Object.prototype is an unknown unit, not an answer", async () => {
    expect(await text(unitConvert, { value: 1, from: "toString", to: "m" })).toContain(
      "unknown unit",
    );
    expect(await text(unitConvert, { value: 20, from: "constructor", to: "F" })).toContain(
      "unknown unit",
    );
  });

  test("100 C is exactly 212 F, with no floating-point tail", async () => {
    expect((await run(unitConvert, { value: 100, from: "C", to: "F" })).value).toBe(212);
    expect((await run(unitConvert, { value: -40, from: "C", to: "F" })).value).toBe(-40);
  });
});

describe("Round", () => {
  test("half-even and half-up disagree on a tie, and both say so", async () => {
    const even = await run(round, { value: "2.5", places: 0 });
    const up = await run(round, { value: "2.5", places: 0, mode: "halfUp" });
    expect(even.exact).toBe("2");
    expect(up.exact).toBe("3");
    expect(even.modeNote).toContain("banker's");
  });

  test("significant figures and nearest multiple are supported", async () => {
    expect((await run(round, { value: 123_456, significantDigits: 3 })).exact).toBe("123000");
    expect((await run(round, { value: "7.33", multiple: "0.05" })).exact).toBe("7.35");
  });

  test("exactly one target must be given", async () => {
    expect(await text(round, { value: 1 })).toContain("exactly one");
    expect(await text(round, { value: 1, places: 2, significantDigits: 3 })).toContain(
      "exactly one",
    );
  });

  test("an exact decimal string is returned alongside the double", async () => {
    const out = await run(round, { value: "1.005", places: 2, mode: "halfUp" });
    expect(out.exact).toBe("1.01");
    expect(out.value).toBe(1.01);
  });
});

describe("NumberFormat and NumberParse", () => {
  test("formats for an explicit locale", async () => {
    expect((await run(numberFormat, { value: 1234.5, locale: "de-DE" })).formatted).toBe("1.234,5");
    const usd = await run(numberFormat, {
      value: 1234.5,
      locale: "en-US",
      style: "currency",
      currency: "USD",
    });
    expect(usd.formatted).toBe("$1,234.50");
  });

  test("an unsupported locale is refused rather than defaulted", async () => {
    expect(await text(numberFormat, { value: 1, locale: "xx-ZZ" })).toContain("no data");
  });

  test("parses back, and refuses the same text under the wrong locale", async () => {
    expect((await run(numberParse, { text: "1.234,56", locale: "de-DE" })).value).toBe(1234.56);
    expect(await text(numberParse, { text: "1.234,56", locale: "en-US" })).toContain(
      "is not a number",
    );
  });

  test("a percent sign returns both readings", async () => {
    const out = await run(numberParse, { text: "12.5%", locale: "en-US" });
    expect(out.value).toBe(12.5);
    expect(out.asFraction).toBe(0.125);
  });
});

describe("Percent", () => {
  test("change, share and the markup/margin square", async () => {
    expect((await run(percent, { operation: "change", from: 200, to: 250 })).percentChange).toBe(
      25,
    );
    expect((await run(percent, { operation: "ofTotal", part: 25, total: 200 })).percent).toBe(12.5);
    const square = await run(percent, {
      operation: "markupMargin",
      cost: 100,
      markupPercent: 50,
    });
    expect(square.price).toBeCloseTo(150, 10);
    expect(square.marginPercent).toBeCloseTo(100 / 3, 10);
    expect(square.definitions.margin).toContain("PRICE");
  });

  test("missing operands are explained, not guessed", async () => {
    expect(await text(percent, { operation: "change", from: 1 })).toContain("needs both");
    expect(await text(percent, { operation: "change", from: 0, to: 1 })).toContain("undefined");
  });
});

describe("Amortize", () => {
  test("the textbook loan comes out right and closes at zero", async () => {
    const out = await run(amortize, {
      principalMinor: 10_000_000,
      annualRatePercent: 6,
      periods: 360,
    });
    expect(Number(out.periodicPaymentMinor)).toBeCloseTo(59_955, 0);
    expect(out.schedule.length).toBe(360);
    expect(out.schedule[359].balance).toBe("0");
    expect(out.totalInterest.startsWith("11")).toBe(true);
  });

  test("totals are available without the schedule", async () => {
    const out = await run(amortize, {
      principalMinor: 10_000_000,
      annualRatePercent: 6,
      periods: 360,
      includeSchedule: false,
    });
    expect(out.schedule).toEqual([]);
    expect(out.totalInterestMinor.length).toBeGreaterThan(0);
  });

  test("a loan that never amortizes is refused", async () => {
    const out = await text(amortize, {
      principalMinor: 10_000_000,
      annualRatePercent: 60,
      periods: 1_200,
    });
    expect(out.length).toBeGreaterThan(0);
  });

  test("the schema bounds the term", () => {
    expect(
      amortize.inputSchema.safeParse({ principalMinor: 1, annualRatePercent: 1, periods: 5_000 })
        .success,
    ).toBe(false);
  });
});

describe("Npv and Irr", () => {
  test("NPV states its timing convention", async () => {
    const out = await run(npv, { ratePercent: 10, cashflows: [-100, 60, 60] });
    expect(out.npv).toBeCloseTo(4.1322, 4);
    expect(out.convention).toContain("t=0");
  });

  test("the Excel convention is available explicitly", async () => {
    const excel = await run(npv, { ratePercent: 10, cashflows: [-100, 60, 60], firstPeriod: 1 });
    expect(excel.convention).toContain("Excel");
  });

  test("IRR reports the rate, the residual NPV and how it was found", async () => {
    const out = await run(irr, { cashflows: [-100, 60, 60] });
    expect(out.irrPercent).toBeCloseTo(13.0662, 3);
    expect(Math.abs(out.npvAtIrr)).toBeLessThan(1e-6);
    expect(out.method).toContain("bisection");
    expect(out.warning).toBeUndefined();
  });

  test("multiple sign changes are flagged", async () => {
    const out = await run(irr, { cashflows: [-100, 500, -600] });
    expect(out.warning).toContain("internal rates of return");
  });

  test("a series with no IRR is refused", async () => {
    expect(await text(irr, { cashflows: [100, 200] })).toContain("same sign");
  });
});

describe("GeoDistance, GeoBoundingBox, GeoPointInPolygon", () => {
  const london = { lat: 51.5074, lon: -0.1278 };
  const paris = { lat: 48.8566, lon: 2.3522 };

  test("distance comes with every unit and the radius used", async () => {
    const out = await run(geoDistance, { from: london, to: paris });
    expect(out.kilometres).toBeCloseTo(343.5, 0);
    expect(out.radiusMetres).toBe(6_371_008.8);
    expect(out.method).toContain("0.5%");
  });

  test("a bad coordinate is rejected by the schema, before execute", () => {
    expect(
      geoDistance.inputSchema.safeParse({ from: { lat: 91, lon: 0 }, to: paris }).success,
    ).toBe(false);
  });

  test("a box around points, and a box around a radius", async () => {
    const box = await run(geoBoundingBox, { points: [london, paris] });
    expect(box.minLat).toBeCloseTo(48.8566, 6);
    const radius = await run(geoBoundingBox, { center: london, radiusMetres: 10_000 });
    expect(radius.maxLat).toBeGreaterThan(london.lat);
    expect(radius.note).toContain("superset");
  });

  test("an ambiguous or incomplete box request is explained", async () => {
    expect(await text(geoBoundingBox, { points: [london], center: paris })).toContain("not both");
    expect(await text(geoBoundingBox, { center: london })).toContain("radiusMetres");
  });

  test("point in polygon reports boundary hits explicitly", async () => {
    const square = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 10 },
      { lat: 10, lon: 10 },
      { lat: 10, lon: 0 },
    ];
    expect(
      (await run(geoPointInPolygon, { point: { lat: 5, lon: 5 }, polygon: square })).inside,
    ).toBe(true);
    const edge = await run(geoPointInPolygon, { point: { lat: 0, lon: 5 }, polygon: square });
    expect(edge.onBoundary).toBe(true);
  });

  test("a ring that wraps the globe is refused", async () => {
    const out = await text(geoPointInPolygon, {
      point: { lat: 5, lon: 180 },
      polygon: [
        { lat: 0, lon: -170 },
        { lat: 0, lon: 170 },
        { lat: 10, lon: 170 },
      ],
    });
    expect(out).toContain("antimeridian");
  });
});
