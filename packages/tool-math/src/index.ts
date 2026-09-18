/**
 * @crewhaus/tool-math — deterministic numeric tools.
 *
 * Every tool here is pure: no filesystem, no network, no clock, no
 * randomness. Same input, same bytes, every time. That is what lets a harness
 * call them freely, and what makes their answers checkable.
 *
 * The failure mode this package is built against is SILENT WRONGNESS — a
 * float answer to a money question, a percentile computed by a convention the
 * caller did not expect, a markup reported as a margin. So:
 *
 *   - money is integer minor units and exact decimals, never floats;
 *   - every method that has competing conventions (percentiles, rounding,
 *     outlier rules, NPV timing) names the one it used IN THE RESULT;
 *   - a question the data cannot answer gets a refusal with the reason, not a
 *     plausible number.
 *
 * Each tool is a thin wrapper over a function in `./lib`, which is where the
 * behaviour is tested.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type Decimal,
  DecimalError,
  ROUNDING_MODES,
  ROUNDING_MODE_NOTES,
  type RoundingMode,
  decimalToNumber,
  decimalToString,
  parseDecimal,
  roundToMultiple,
  roundToPlaces,
  roundToSignificant,
  trimTrailingZeros,
} from "./lib/decimal";
import { EXPR_CONSTANTS, EXPR_FUNCTIONS, ExprError, evaluateExpression } from "./lib/expr";
import {
  FinanceError,
  amortize as amortizeFn,
  irr as irrFn,
  markupMargin,
  npv as npvFn,
  percentChange,
  percentOfTotal,
} from "./lib/finance";
import {
  EARTH_RADIUS_M,
  GeoError,
  type Point,
  boundingBoxAround,
  boundingBoxOf,
  haversineDistance,
  pointInPolygon,
} from "./lib/geo";
import {
  CURRENCY_MINOR_UNITS,
  KNOWN_CURRENCIES,
  MoneyError,
  REMAINDER_POLICIES,
  convertMinor,
  describeMoney,
  formatMinor,
  lookupRate,
  minorUnitExponent,
  moneyAllocate,
  moneyMultiply,
  moneySum,
  toMinor,
} from "./lib/money";
import { NumberFormatError, formatNumber, parseLocaleNumber } from "./lib/numfmt";
import {
  OUTLIER_METHODS,
  PERCENTILE_METHODS,
  PERCENTILE_METHOD_NOTES,
  type PercentileMethod,
  StatsError,
  findOutliers,
  histogram as histogramFn,
  linearRegression,
  pearson,
  percentile as percentileFn,
  spearman,
  summarize,
} from "./lib/stats";
import { UnitError, convertUnits, unitCatalog } from "./lib/units";

/** Compact JSON — no indentation, since the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

/**
 * Caps on input size. These bound the work AND the memory: a zod `.max()` on
 * an array is checked before `execute` ever sees it, so an oversized request
 * is refused at the schema, not after it has been materialized.
 */
const MAX_SERIES = 200_000;
const MAX_RATIOS = 10_000;
const MAX_CASHFLOWS = 2_000;
const MAX_POLYGON_VERTICES = 50_000;

/**
 * Turn a known refusal into a readable string. A caller mistake is an answer
 * ("here is why I cannot do that"), not an exception: a thrown error costs the
 * harness a turn to interpret. Anything that is NOT one of this package's own
 * error types is a bug and is re-thrown.
 */
function refusal(err: unknown): string {
  if (err instanceof ExprError) return `${err.message} (at character ${err.position})`;
  if (
    err instanceof StatsError ||
    err instanceof DecimalError ||
    err instanceof MoneyError ||
    err instanceof UnitError ||
    err instanceof FinanceError ||
    err instanceof GeoError ||
    err instanceof NumberFormatError
  ) {
    return err.message;
  }
  throw err;
}

const roundingModeSchema = z.enum(ROUNDING_MODES);
/**
 * A number, or a decimal string for exactness. The string is length-capped to
 * the same order as `parseDecimal`'s digit limit: a "number" of a hundred
 * thousand digits is not a quantity anyone means, and the bigint arithmetic
 * behind money and rounding is superlinear in its length.
 */
const numericString = z.union([z.number().finite(), z.string().min(1).max(1_100)]);
const seriesSchema = z
  .array(z.number().finite())
  .min(1)
  .max(MAX_SERIES)
  .describe("a series of finite numbers");
const pointSchema = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
  })
  .describe("degrees; {lat, lon} objects only — GeoJSON's [lon, lat] order is too easy to reverse");

/** Parse a decimal-ish input, re-labelling the failure with the field name. */
function decimalField(value: number | string, field: string): Decimal {
  try {
    return parseDecimal(value);
  } catch (err) {
    if (err instanceof DecimalError) throw new DecimalError(`${field}: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

export const evaluate: RegisteredTool = buildTool({
  name: "Evaluate",
  description:
    "Evaluate an arithmetic expression with a real tokenizer and parser — no eval(), no new Function(), and nothing outside a fixed grammar. Use for any calculation a model would otherwise do in its head: + - * / % ^, parentheses, unary minus, caller-supplied variables, and the functions abs, min, max, round, floor, ceil, sqrt, pow, log (base 10), ln, exp, sin, cos and tan (radians). Precedence is + - < * / % < unary minus < ^, so -2^2 is -4 as in mathematics, NOT 4 as in Excel; % is the remainder with the sign of the dividend; any step producing NaN or Infinity is refused rather than returned.",
  inputSchema: z.object({
    expression: z.string().min(1).max(4_000).describe("the expression to evaluate"),
    variables: z
      .record(z.number().finite())
      .optional()
      .describe("named finite values the expression may reference; shadows pi and e"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const result = evaluateExpression(input.expression, { variables: input.variables ?? {} });
      return json({
        value: result.value,
        expression: input.expression,
        usedNames: result.usedNames,
        usedFunctions: result.usedFunctions,
        grammar: {
          operators: ["+", "-", "*", "/", "%", "^"],
          functions: EXPR_FUNCTIONS,
          constants: Object.keys(EXPR_CONSTANTS).sort(),
          notes:
            "log is base 10 and ln is natural; trigonometric functions take radians; -2^2 = -4",
        },
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export const statistics: RegisteredTool = buildTool({
  name: "Statistics",
  description:
    "Summarize a numeric series: count, sum, mean, median, mode(s), variance and standard deviation reported BOTH as sample (n-1) and population (n), min, max, range and quartiles. Use instead of asking a model to add up a column — and read the labels, because sample and population differ, and the quartiles follow a named percentile convention (r7 by default, which is what NumPy, R and Excel's QUARTILE.INC use).",
  inputSchema: z.object({
    values: seriesSchema,
    percentileMethod: z
      .enum(PERCENTILE_METHODS)
      .optional()
      .describe("quartile convention: r7 (default), r6 (Excel PERCENTILE.EXC) or nearestRank"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const method: PercentileMethod = input.percentileMethod ?? "r7";
      return json(summarize(input.values, method));
    } catch (err) {
      return refusal(err);
    }
  },
});

export const percentile: RegisteredTool = buildTool({
  name: "Percentile",
  description:
    "Compute one or more percentiles of a series by an explicitly chosen convention. Use when the exact convention matters — r7 (linear interpolation, h=(n-1)p; NumPy/R default, Excel PERCENTILE.INC), r6 (h=(n+1)p; Excel PERCENTILE.EXC, refused outside [1/(n+1), n/(n+1)] where it is undefined rather than clamped, including for a single observation) and nearestRank (ceil(p*n), always an observed value) give different answers on the same data, and the result says which was used.",
  inputSchema: z.object({
    values: seriesSchema,
    percentiles: z
      .array(z.number().min(0).max(100))
      .min(1)
      .max(100)
      .describe("percentiles as 0..100, e.g. [50, 95, 99]"),
    method: z.enum(PERCENTILE_METHODS).optional().describe("defaults to r7"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const method: PercentileMethod = input.method ?? "r7";
      const results = input.percentiles.map((p) => ({
        percentile: p,
        value: percentileFn(input.values, p / 100, method),
      }));
      return json({
        count: input.values.length,
        method,
        methodNote: PERCENTILE_METHOD_NOTES[method],
        results,
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

export const correlation: RegisteredTool = buildTool({
  name: "Correlation",
  description:
    "Correlate two paired series with Pearson's r (linear, on the raw values) and Spearman's rho (monotonic, on tie-averaged ranks). Use to check whether two measurements move together — and heed the reported n: correlation over a handful of points is close to meaningless, r says nothing about causation, and a constant series returns null rather than a fake zero.",
  inputSchema: z.object({
    x: seriesSchema,
    y: seriesSchema,
    method: z.enum(["pearson", "spearman", "both"]).optional().describe("defaults to both"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const method = input.method ?? "both";
      const n = input.x.length;
      const out: Record<string, unknown> = {
        n,
        method,
        caution:
          n < 10
            ? `n=${n} is too small to support a claim: a correlation this short is dominated by noise`
            : "correlation is not causation, and both measures only detect the shape they are built for",
      };
      if (method !== "spearman") {
        const r = pearson(input.x, input.y);
        out["pearson"] = {
          r,
          r2: r === null ? null : r * r,
          note: "linear association on raw values",
        };
      }
      if (method !== "pearson") {
        out["spearman"] = {
          rho: spearman(input.x, input.y),
          note: "monotonic association on midranks (ties averaged)",
        };
      }
      return json(out);
    } catch (err) {
      return refusal(err);
    }
  },
});

export const linearRegressionTool: RegisteredTool = buildTool({
  name: "LinearRegression",
  description:
    "Fit y = slope*x + intercept by ordinary least squares and report slope, intercept, r, r squared and the residual standard error. Use to quantify a trend or to predict y at given x values (pass predictX); note that OLS minimizes VERTICAL error, so regressing x on y gives a different line, and r squared is the share of variance explained, not a measure of whether the model is appropriate.",
  inputSchema: z.object({
    x: seriesSchema,
    y: seriesSchema,
    predictX: z
      .array(z.number().finite())
      .max(1_000)
      .optional()
      .describe("x values to evaluate the fitted line at"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const fit = linearRegression(input.x, input.y);
      const predictions = (input.predictX ?? []).map((x) => ({
        x,
        y: fit.intercept + fit.slope * x,
      }));
      return json({
        ...fit,
        equation: `y = ${fit.slope} * x + ${fit.intercept}`,
        predictions,
        method: "ordinary least squares, minimizing vertical squared error",
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

export const histogram: RegisteredTool = buildTool({
  name: "Histogram",
  description:
    "Bucket a series into equal-width bins and report each bucket's bounds and count. Use to see a distribution's shape before trusting its mean; give either bucketCount or bucketWidth (not both), and note that every bucket is half-open [lo, hi) except the last, which is closed so the maximum value has somewhere to land.",
  inputSchema: z.object({
    values: seriesSchema,
    bucketCount: z.number().int().min(1).max(10_000).optional().describe("defaults to 10"),
    bucketWidth: z.number().finite().positive().optional().describe("alternative to bucketCount"),
    origin: z
      .number()
      .finite()
      .optional()
      .describe("left edge of the first bucket; defaults to the minimum"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      // Both are passed through when both are given, so the refusal comes from
      // the one place that owns the rule rather than one silently winning.
      const options: { bucketCount?: number; bucketWidth?: number; origin?: number } = {};
      if (input.bucketWidth !== undefined) options.bucketWidth = input.bucketWidth;
      if (input.bucketCount !== undefined) options.bucketCount = input.bucketCount;
      if (input.bucketCount === undefined && input.bucketWidth === undefined) {
        options.bucketCount = 10;
      }
      if (input.origin !== undefined) options.origin = input.origin;
      return json(histogramFn(input.values, options));
    } catch (err) {
      return refusal(err);
    }
  },
});

export const outliers: RegisteredTool = buildTool({
  name: "Outliers",
  description:
    "Flag outliers by an explicitly named rule: the IQR rule (outside Q1-k*IQR or Q3+k*IQR, Tukey's fence, k=1.5 by default, what a box plot draws) or the z-score rule (more than k sample standard deviations from the mean, k=3 by default). Use the IQR rule unless the data is known to be near-normal — the z-score rule is computed from statistics the outliers themselves distort, and the result always states the rule, the threshold and the resulting bounds. An empty result means nothing crossed THAT fence at THAT threshold; it is not a clean bill of health, and the returned `finding` says so, because neither rule can see a shifted distribution, a wrong unit or a cluster of errors that moved the bounds with it.",
  inputSchema: z.object({
    values: seriesSchema,
    method: z.enum(OUTLIER_METHODS).optional().describe("defaults to iqr"),
    threshold: z
      .number()
      .positive()
      .max(100)
      .optional()
      .describe("k; defaults to 1.5 for iqr and 3 for zscore"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const method = input.method ?? "iqr";
      const threshold = input.threshold ?? (method === "iqr" ? 1.5 : 3);
      return json(findOutliers(input.values, method, threshold));
    } catch (err) {
      return refusal(err);
    }
  },
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const currencyField = z
  .string()
  .length(3)
  .describe("ISO 4217 code, e.g. USD, EUR, JPY — decides the minor-unit exponent");
const exponentField = z
  .number()
  .int()
  .min(0)
  .max(6)
  .optional()
  .describe("minor-unit exponent override for a currency not in the table (JPY-like is 0)");
const minorField = numericString.describe(
  "a whole number of MINOR units: $10.50 is 1050, ¥1050 is 1050",
);

export const moneyAdd: RegisteredTool = buildTool({
  name: "MoneyAdd",
  description:
    "Add and subtract money exactly, as integer minor units in one currency. Use for any total that will be invoiced: amounts are cents (or yen, or fils) carried in bigints, so nothing is lost to binary floating point, and the currency's ISO 4217 minor-unit exponent is applied rather than assumed — an unknown code is refused instead of being treated as 2 decimals.",
  inputSchema: z.object({
    currency: currencyField,
    amountsMinor: z
      .array(minorField)
      .min(1)
      .max(MAX_RATIOS)
      .describe("whole minor units; negative values subtract"),
    exponent: exponentField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const exponent = minorUnitExponent(input.currency, input.exponent);
      const amounts = input.amountsMinor.map((a, i) => toMinor(a, `amountsMinor[${i}]`));
      const total = moneySum(amounts);
      return json({
        ...describeMoney(total, input.currency, exponent),
        addends: amounts.length,
        method: "exact integer arithmetic on minor units; no rounding was needed or applied",
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

export const moneyMultiplyTool: RegisteredTool = buildTool({
  name: "MoneyMultiply",
  description:
    "Multiply a money amount by an exact decimal factor — a tax rate, a quantity, a discount — and round once to whole minor units. Use for line totals and tax: the factor is parsed as a decimal rather than a float (1999 * 0.0825 is computed on the digits, not on the nearest double), the exact unrounded product is reported alongside the rounded one, and the rounding mode is named (half-even by default, which is what accounting expects).",
  inputSchema: z.object({
    currency: currencyField,
    amountMinor: minorField,
    factor: numericString.describe('a decimal factor, e.g. 0.0825 or "3"'),
    rounding: roundingModeSchema.optional().describe("defaults to halfEven (banker's rounding)"),
    exponent: exponentField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const exponent = minorUnitExponent(input.currency, input.exponent);
      const mode: RoundingMode = input.rounding ?? "halfEven";
      const amount = toMinor(input.amountMinor, "amountMinor");
      const factor = decimalField(input.factor, "factor");
      const { rounded, exact } = moneyMultiply(amount, factor, mode);
      return json({
        ...describeMoney(rounded, input.currency, exponent),
        exactMinorUnits: decimalToString(trimTrailingZeros(exact)),
        factor: decimalToString(factor),
        rounding: mode,
        roundingNote: ROUNDING_MODE_NOTES[mode],
        method: "exact decimal product, rounded to whole minor units exactly once at the end",
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

export const moneyAllocateTool: RegisteredTool = buildTool({
  name: "MoneyAllocate",
  description:
    "Split a money amount across ratios so the parts sum EXACTLY back to the whole. Use for any share-out — splitting a bill, apportioning a discount across line items, allocating tax — because rounding each share independently is the classic invoice bug that loses or invents a cent; this uses the largest-remainder method, hands the leftover minor units out one at a time by a named policy, and the result always reconciles.",
  inputSchema: z.object({
    currency: currencyField,
    amountMinor: minorField,
    ratios: z
      .array(numericString)
      .min(1)
      .max(MAX_RATIOS)
      .describe("non-negative weights; they need not sum to 1 or to 100"),
    remainderPolicy: z
      .enum(REMAINDER_POLICIES)
      .optional()
      .describe("who gets the leftover minor units: largest (default), first or last"),
    exponent: exponentField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const exponent = minorUnitExponent(input.currency, input.exponent);
      const amount = toMinor(input.amountMinor, "amountMinor");
      const ratios = input.ratios.map((r, i) => decimalField(r, `ratios[${i}]`));
      const result = moneyAllocate(amount, ratios, input.remainderPolicy ?? "largest", exponent);
      const sum = result.parts.reduce((total, part) => total + BigInt(part.minorUnits), 0n);
      return json({
        currency: input.currency.toUpperCase(),
        exponent,
        total: describeMoney(amount, input.currency, exponent),
        parts: result.parts,
        remainderUnits: result.remainderUnits,
        policy: result.policy,
        // Asserted here as well as in the tests: the invariant is the feature.
        sumsToTotal: sum === amount,
        method: result.method,
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

export const currencyConvert: RegisteredTool = buildTool({
  name: "CurrencyConvert",
  description:
    "Convert money between currencies using a rate table the CALLER supplies. Use when the rates come from your own source of truth — this tool has no network and no built-in rates, because a live rate would make the answer depend on the minute it ran; both currencies' minor-unit exponents are applied (USD 2 decimals to JPY 0 is not a no-op), the arithmetic is exact until a single final rounding, and an inverted rate is only used if you allow it, since inverting a quote is not what a dealer would sell you.",
  inputSchema: z.object({
    amountMinor: minorField,
    from: currencyField,
    to: currencyField,
    rates: z
      .record(numericString)
      .describe('rate table keyed "USD/EUR" meaning 1 USD buys this many EUR'),
    allowInverse: z
      .boolean()
      .optional()
      .describe("use 1/rate when only the opposite direction is listed; default false"),
    rounding: roundingModeSchema.optional().describe("defaults to halfEven"),
    fromExponent: exponentField,
    toExponent: exponentField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const fromExponent = minorUnitExponent(input.from, input.fromExponent);
      const toExponent = minorUnitExponent(input.to, input.toExponent);
      const mode: RoundingMode = input.rounding ?? "halfEven";
      const { rate, source, key } = lookupRate(
        input.rates,
        input.from,
        input.to,
        input.allowInverse ?? false,
      );
      const amount = toMinor(input.amountMinor, "amountMinor");
      const converted = convertMinor(amount, rate, fromExponent, toExponent, mode);
      return json({
        from: describeMoney(amount, input.from, fromExponent),
        to: describeMoney(converted, input.to, toExponent),
        rate: decimalToString(rate),
        rateKey: key,
        rateSource: source,
        rounding: mode,
        roundingNote: ROUNDING_MODE_NOTES[mode],
        method:
          "amount * rate, adjusted for both minor-unit exponents, computed exactly and rounded once; the rate is the caller's, not a live quote",
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

// ---------------------------------------------------------------------------
// Units, rounding, formatting
// ---------------------------------------------------------------------------

export const unitConvert: RegisteredTool = buildTool({
  name: "UnitConvert",
  description:
    "Convert a value between units of length, mass, volume, temperature, time, area, speed, data size, pressure or energy. Use rather than recalling a factor: the definitional factors here are exact (1 in = 0.0254 m, 1 lb = 0.45359237 kg), temperature is converted AFFINELY (an offset and a ratio relative to kelvin, never a factor) in a single step, so 100 C is exactly 212 F, US and imperial volumes are distinct units (gal_us vs gal_uk), cross-dimension requests are refused, and months and years are deliberately absent because they have no fixed length. Pass list: true to see every supported unit.",
  inputSchema: z.object({
    value: z.number().finite().optional().describe("the quantity to convert"),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    list: z.boolean().optional().describe("return the catalog of supported units instead"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      if (input.list === true) {
        return json({
          units: unitCatalog(),
          note: "temperature converts affinely (C, F, K, R); everything else by an exact or conventional factor",
        });
      }
      if (input.value === undefined || input.from === undefined || input.to === undefined) {
        return "give value, from and to — or list: true to see the supported units";
      }
      return json(convertUnits(input.value, input.from, input.to));
    } catch (err) {
      return refusal(err);
    }
  },
});

export const round: RegisteredTool = buildTool({
  name: "Round",
  description:
    "Round a number to decimal places, to significant figures, or to the nearest multiple, with the rounding mode named. Use whenever the mode matters: halfEven (banker's rounding, the accounting default, 2.5 -> 2) and halfUp (2.5 -> 3) disagree on every tie, and ceiling/floor/up/down disagree everywhere. The value is rounded on its exact decimal digits, not through binary floating point, and both an exact decimal string and the nearest double are returned.",
  inputSchema: z.object({
    value: numericString.describe("a number, or a decimal string for exactness"),
    places: z.number().int().min(0).max(100).optional().describe("decimal places"),
    significantDigits: z.number().int().min(1).max(100).optional(),
    multiple: numericString.optional().describe("round to the nearest multiple of this, e.g. 0.05"),
    mode: roundingModeSchema.optional().describe("defaults to halfEven"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const chosen = [input.places, input.significantDigits, input.multiple].filter(
        (v) => v !== undefined,
      );
      if (chosen.length !== 1) {
        return "give exactly one of places, significantDigits or multiple";
      }
      const mode: RoundingMode = input.mode ?? "halfEven";
      const value = decimalField(input.value, "value");
      let rounded: Decimal;
      let how: string;
      if (input.places !== undefined) {
        rounded = roundToPlaces(value, input.places, mode);
        how = `to ${input.places} decimal place(s)`;
      } else if (input.significantDigits !== undefined) {
        rounded = roundToSignificant(value, input.significantDigits, mode);
        how = `to ${input.significantDigits} significant figure(s)`;
      } else {
        const step = decimalField(input.multiple as number | string, "multiple");
        rounded = roundToMultiple(value, step, mode);
        how = `to the nearest multiple of ${decimalToString(step)}`;
      }
      return json({
        value: decimalToNumber(rounded),
        exact: decimalToString(rounded),
        input: decimalToString(value),
        mode,
        modeNote: ROUNDING_MODE_NOTES[mode],
        method: `rounded ${how} on the exact decimal digits of the input`,
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

export const numberFormat: RegisteredTool = buildTool({
  name: "NumberFormat",
  description:
    "Format a number for a named locale with grouping, fraction digits, percent or currency, via Intl. Use to render a figure for a human without a model guessing at separators — the locale is required and an unsupported tag is refused rather than silently falling back to the machine's default. One caveat, unique in this package: the exact glyphs come from the runtime's ICU data, so they are stable for a given runtime but not guaranteed across runtime versions.",
  inputSchema: z.object({
    value: z.number().finite(),
    locale: z.string().min(2).max(40).describe('a BCP 47 tag, e.g. "en-US", "de-DE", "ja-JP"'),
    style: z.enum(["decimal", "currency", "percent"]).optional().describe("defaults to decimal"),
    currency: z.string().length(3).optional().describe('required when style is "currency"'),
    currencyDisplay: z.enum(["symbol", "code", "name", "narrowSymbol"]).optional(),
    minimumFractionDigits: z.number().int().min(0).max(20).optional(),
    maximumFractionDigits: z.number().int().min(0).max(20).optional(),
    useGrouping: z.boolean().optional(),
    notation: z.enum(["standard", "compact", "scientific", "engineering"]).optional(),
    signDisplay: z.enum(["auto", "always", "never", "exceptZero"]).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const options = {
        locale: input.locale,
        style: input.style ?? "decimal",
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.currencyDisplay !== undefined ? { currencyDisplay: input.currencyDisplay } : {}),
        ...(input.minimumFractionDigits !== undefined
          ? { minimumFractionDigits: input.minimumFractionDigits }
          : {}),
        ...(input.maximumFractionDigits !== undefined
          ? { maximumFractionDigits: input.maximumFractionDigits }
          : {}),
        ...(input.useGrouping !== undefined ? { useGrouping: input.useGrouping } : {}),
        ...(input.notation !== undefined ? { notation: input.notation } : {}),
        ...(input.signDisplay !== undefined ? { signDisplay: input.signDisplay } : {}),
      } as const;
      const result = formatNumber(input.value, options);
      return json({
        formatted: result.formatted,
        locale: result.locale,
        style: result.resolved.style,
        numberingSystem: result.resolved.numberingSystem,
        note: result.note,
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

export const numberParse: RegisteredTool = buildTool({
  name: "NumberParse",
  description:
    'Parse a locale-formatted number back to a plain number, given the locale explicitly. Use on figures scraped from documents or spreadsheets: "1.234,56" is 1234.56 in de-DE and is REFUSED in en-US rather than guessed at, grouping is validated before separators are stripped (so "1234.56" under de-DE is refused, not read as 123456), one pair of accounting parentheses means negative while nested or unbalanced ones are refused, and a percent sign is reported with both readings so neither is implicit.',
  inputSchema: z.object({
    text: z.string().min(1).max(1_000),
    locale: z.string().min(2).max(40).describe('the locale the text was written for, e.g. "de-DE"'),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      return json(parseLocaleNumber(input.text, input.locale));
    } catch (err) {
      return refusal(err);
    }
  },
});

// ---------------------------------------------------------------------------
// Percentages and finance
// ---------------------------------------------------------------------------

export const percent: RegisteredTool = buildTool({
  name: "Percent",
  description:
    "Compute a percent change, a share of a total, or the markup/margin square — the three that are routinely confused. Use it rather than doing the arithmetic loosely: change is (to-from)/|from|*100 and is undefined from zero; ofTotal is part/total*100; markup is profit over COST while margin is profit over PRICE, so a 50% markup is a 33.3% margin, and markupMargin completes all four values from EXACTLY two, refusing a third rather than ignoring it, and reports both definitions.",
  inputSchema: z.object({
    operation: z.enum(["change", "ofTotal", "markupMargin"]),
    from: z.number().finite().optional().describe("change: the starting value"),
    to: z.number().finite().optional().describe("change: the ending value"),
    part: z.number().finite().optional().describe("ofTotal: the part"),
    total: z.number().finite().optional().describe("ofTotal: the whole"),
    cost: z.number().finite().optional().describe("markupMargin"),
    price: z.number().finite().optional().describe("markupMargin"),
    markupPercent: z.number().finite().optional().describe("markupMargin"),
    marginPercent: z.number().finite().optional().describe("markupMargin"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      if (input.operation === "change") {
        if (input.from === undefined || input.to === undefined) {
          return "change needs both from and to";
        }
        return json(percentChange(input.from, input.to));
      }
      if (input.operation === "ofTotal") {
        if (input.part === undefined || input.total === undefined) {
          return "ofTotal needs both part and total";
        }
        return json(percentOfTotal(input.part, input.total));
      }
      return json(
        markupMargin({
          ...(input.cost !== undefined ? { cost: input.cost } : {}),
          ...(input.price !== undefined ? { price: input.price } : {}),
          ...(input.markupPercent !== undefined ? { markupPercent: input.markupPercent } : {}),
          ...(input.marginPercent !== undefined ? { marginPercent: input.marginPercent } : {}),
        }),
      );
    } catch (err) {
      return refusal(err);
    }
  },
});

export const amortize: RegisteredTool = buildTool({
  name: "Amortize",
  description:
    "Build a loan amortization schedule: the level payment, and the interest, principal and remaining balance for every period, plus the total interest. Use for any loan question — every amount is whole minor units computed with exact rational interest (balance * rate / (100 * periodsPerYear)) rounded once per period with a named mode, and the final payment is adjusted so the balance closes at exactly zero, which is why the last row differs by a cent. A payment that cannot cover the first period's interest is refused rather than amortized into a fantasy.",
  inputSchema: z.object({
    principalMinor: minorField,
    annualRatePercent: numericString.describe(
      "annual nominal rate as a PERCENT, e.g. 6.5 not 0.065",
    ),
    periods: z.number().int().min(1).max(1_200).describe("total number of payments"),
    periodsPerYear: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("defaults to 12 (monthly)"),
    currency: currencyField.optional().describe("defaults to USD-like 2 decimals"),
    exponent: exponentField,
    rounding: roundingModeSchema.optional().describe("defaults to halfEven"),
    includeSchedule: z
      .boolean()
      .optional()
      .describe("include every period's row; default true, set false for totals only"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const currency = input.currency ?? "USD";
      const exponent = minorUnitExponent(currency, input.exponent);
      const mode: RoundingMode = input.rounding ?? "halfEven";
      const result = amortizeFn({
        principalMinor: toMinor(input.principalMinor, "principalMinor"),
        annualRatePercent: decimalField(input.annualRatePercent, "annualRatePercent"),
        periods: input.periods,
        periodsPerYear: input.periodsPerYear ?? 12,
        mode,
        includeSchedule: input.includeSchedule ?? true,
      });
      return json({
        currency: currency.toUpperCase(),
        exponent,
        periodicPayment: formatMinor(BigInt(result.periodicPaymentMinor), exponent),
        finalPayment: formatMinor(BigInt(result.finalPaymentMinor), exponent),
        totalPaid: formatMinor(BigInt(result.totalPaidMinor), exponent),
        totalInterest: formatMinor(BigInt(result.totalInterestMinor), exponent),
        periodicPaymentMinor: result.periodicPaymentMinor,
        totalInterestMinor: result.totalInterestMinor,
        periods: result.periods,
        periodRatePercent: result.periodRatePercent,
        rounding: mode,
        schedule: result.schedule,
        method: result.method,
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

export const npv: RegisteredTool = buildTool({
  name: "Npv",
  description:
    "Net present value of a cashflow series at a given discount rate. Use for investment comparisons, and mind the timing convention: here cashflows[0] sits at t=0 and is NOT discounted, which is the textbook definition, while Excel's NPV() discounts its first argument one full period — pass firstPeriod: 1 to reproduce Excel. The rate is a PERCENT per period (5 means 5%), and the per-period discounted values are returned so the arithmetic is auditable.",
  inputSchema: z.object({
    ratePercent: z
      .number()
      .finite()
      .describe("discount rate per period as a PERCENT, e.g. 8 for 8%"),
    cashflows: z
      .array(z.number().finite())
      .min(1)
      .max(MAX_CASHFLOWS)
      .describe("one value per period; negative is an outflow"),
    firstPeriod: z
      .union([z.literal(0), z.literal(1)])
      .optional()
      .describe("0 (default): cashflows[0] is at t=0. 1: Excel's NPV() convention"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const result = npvFn(input.ratePercent / 100, input.cashflows, input.firstPeriod ?? 0);
      return json({
        npv: result.npv,
        ratePercent: input.ratePercent,
        periods: input.cashflows.length,
        discounted: result.discounted,
        convention: result.convention,
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

export const irr: RegisteredTool = buildTool({
  name: "Irr",
  description:
    "Internal rate of return: the discount rate at which a cashflow series has zero NPV, found by bisection. Use when comparing returns rather than absolute values — bisection is used because it cannot diverge the way Newton-Raphson can, the tolerance and iteration cap are reported with the answer, the NPV at that rate is shown so you can see how close to zero it is, and a series that changes sign more than once is flagged, because it can have several IRRs and returning one silently would be a lie.",
  inputSchema: z.object({
    cashflows: z
      .array(z.number().finite())
      .min(2)
      .max(MAX_CASHFLOWS)
      .describe("one value per period starting at t=0; must include both signs"),
    tolerance: z
      .number()
      .positive()
      .max(0.1)
      .optional()
      .describe("bracket width to stop at; defaults to 1e-9"),
    maxIterations: z.number().int().min(1).max(10_000).optional().describe("defaults to 200"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const result = irrFn(input.cashflows, input.tolerance ?? 1e-9, input.maxIterations ?? 200);
      return json({
        irrPercent: result.irr * 100,
        irr: result.irr,
        npvAtIrr: result.npvAtIrr,
        iterations: result.iterations,
        tolerance: result.tolerance,
        signChanges: result.signChanges,
        method: result.method,
        ...(result.warning !== undefined ? { warning: result.warning } : {}),
      });
    } catch (err) {
      return refusal(err);
    }
  },
});

// ---------------------------------------------------------------------------
// Geospatial
// ---------------------------------------------------------------------------

export const geoDistance: RegisteredTool = buildTool({
  name: "GeoDistance",
  description:
    "Great-circle distance between two coordinates by the haversine formula, in metres, kilometres, miles and nautical miles, plus the initial bearing. Use for distances between places on Earth: the sphere modelled is the IUGG mean radius 6371008.8 m, which is stated in the result because a spherical model differs from the WGS-84 ellipsoid by up to about 0.5% — fine for logistics, not for surveying. Coordinates are {lat, lon} objects in degrees, never GeoJSON's [lon, lat] pairs.",
  inputSchema: z.object({
    from: pointSchema,
    to: pointSchema,
    radiusMetres: z
      .number()
      .finite()
      .positive()
      .optional()
      .describe("sphere radius; defaults to the Earth's mean radius 6371008.8 m"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      return json(haversineDistance(input.from, input.to, input.radiusMetres ?? EARTH_RADIUS_M));
    } catch (err) {
      return refusal(err);
    }
  },
});

export const geoBoundingBox: RegisteredTool = buildTool({
  name: "GeoBoundingBox",
  description:
    "Compute a latitude/longitude bounding box, either around a set of points or around a centre and a radius. Use as the cheap pre-filter before an exact distance test — the radius box is always a superset of the circle, so it never drops a point that is genuinely in range. Longitude wraps, so the narrower of the two candidate boxes wins and crossesAntimeridian says when minLon is greater than maxLon; near the poles the box widens to every longitude, which is reported rather than hidden.",
  inputSchema: z.object({
    points: z.array(pointSchema).min(1).max(100_000).optional().describe("box around these points"),
    center: pointSchema.optional().describe("box around this centre, with radiusMetres"),
    radiusMetres: z.number().finite().positive().max(20_037_508).optional(),
    earthRadiusMetres: z.number().finite().positive().optional().describe("defaults to 6371008.8"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      if (input.points !== undefined && input.center !== undefined) {
        return "give either points or center+radiusMetres, not both";
      }
      if (input.points !== undefined) return json(boundingBoxOf(input.points));
      if (input.center !== undefined && input.radiusMetres !== undefined) {
        return json(
          boundingBoxAround(
            input.center,
            input.radiusMetres,
            input.earthRadiusMetres ?? EARTH_RADIUS_M,
          ),
        );
      }
      return "give either points, or center together with radiusMetres";
    } catch (err) {
      return refusal(err);
    }
  },
});

export const geoPointInPolygon: RegisteredTool = buildTool({
  name: "GeoPointInPolygon",
  description:
    "Test whether a coordinate falls inside a polygon ring, by ray casting with the even-odd rule. Use for geofencing and territory assignment: the ring may be open or closed, a point lying exactly on an edge is detected and reported as onBoundary rather than decided by floating-point luck, and the test is planar in lon/lat — so a ring spanning more than 180 degrees of longitude is refused instead of being read inside-out across the antimeridian.",
  inputSchema: z.object({
    point: pointSchema,
    polygon: z
      .array(pointSchema)
      .min(3)
      .max(MAX_POLYGON_VERTICES)
      .describe("the ring's vertices in order; the first vertex may be repeated at the end"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      return json(pointInPolygon(input.point as Point, input.polygon as Point[]));
    } catch (err) {
      return refusal(err);
    }
  },
});

/** The currency table, exported so a caller can check a code before using it. */
export { CURRENCY_MINOR_UNITS, KNOWN_CURRENCIES };

/**
 * The nonparametric kernel (Mann-Whitney, Wilson, Cohen's kappa, PSI, robust
 * location and spread), exported as a namespace rather than flattened: it has
 * its own `median` and `quantile`, and colliding those with `./lib/stats`'s
 * differently-behaved pair in one flat surface is how a caller ends up with
 * the throwing one where they wanted the null-returning one.
 *
 * Registers no tool — every one of these is a number a CI gate decides on, and
 * a gate calls a library, not a model.
 */
export * as statsKernel from "./lib/stats-kernel";

/** Every tool this package registers, in the order a catalog should list them. */
export const MATH_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
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
]);
