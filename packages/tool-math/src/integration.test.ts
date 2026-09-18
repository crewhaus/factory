/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately. The second
 * half chains tools together, because the invariants that matter most in this
 * package — an allocation summing to its total, a conversion round-tripping —
 * only show up when one tool's output becomes another's input.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { MATH_TOOLS } from "./index";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

async function call(name: string, input: unknown): Promise<string> {
  const result = await executeTool(lookup(name), input, { toolUseId: `t-${name}` });
  expect({ name, isError: result.isError }).toEqual({ name, isError: false });
  return result.content;
}

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function callJson(name: string, input: unknown): Promise<any> {
  return JSON.parse(await call(name, input));
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of MATH_TOOLS) catalog.register(tool);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(MATH_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of MATH_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("Evaluate"),
      { expression: "2 + 2" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"value":4');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("Statistics"),
      { values: "not a series" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Statistics");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("UnitConvert"), { value: 1 }, { toolUseId: "t3" });
    // UnitConvert's fields are all optional by design (list mode), so this is
    // an execute-level explanation rather than a schema rejection.
    expect(result.isError).toBe(false);
    expect(result.content).toContain("give value, from and to");
    const missing = await executeTool(
      lookup("GeoDistance"),
      { from: { lat: 0, lon: 0 } },
      {
        toolUseId: "t3b",
      },
    );
    expect(missing.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("Round"),
      { value: 1.5, places: 0 },
      { toolUseId: "t4", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("Round"),
      { value: 1.5, places: 0 },
      { toolUseId: "t5", allowedPatterns: ["Round"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a caller mistake is a RESULT, not a runtime error the harness must catch", async () => {
    const result = await executeTool(
      lookup("Evaluate"),
      { expression: "1/0" },
      { toolUseId: "t6" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("division by zero");
  });

  test("every tool can be dispatched with a representative input", async () => {
    const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20];
    const inputs: Record<string, unknown> = {
      Amortize: { principalMinor: 100_000, annualRatePercent: 5, periods: 12 },
      Correlation: { x: [1, 2, 3], y: [2, 4, 7] },
      CurrencyConvert: {
        amountMinor: 1_000,
        from: "USD",
        to: "EUR",
        rates: { "USD/EUR": "0.9" },
      },
      Evaluate: { expression: "1 + 1" },
      GeoBoundingBox: { points: [{ lat: 1, lon: 2 }] },
      GeoDistance: { from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1 } },
      GeoPointInPolygon: {
        point: { lat: 1, lon: 1 },
        polygon: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 5 },
          { lat: 5, lon: 5 },
        ],
      },
      Histogram: { values: series },
      Irr: { cashflows: [-100, 60, 60] },
      LinearRegression: { x: [1, 2, 3], y: [2, 4, 6] },
      MoneyAdd: { currency: "USD", amountsMinor: [100, 200] },
      MoneyAllocate: { currency: "USD", amountMinor: 100, ratios: [1, 2] },
      MoneyMultiply: { currency: "USD", amountMinor: 100, factor: 1.5 },
      Npv: { ratePercent: 5, cashflows: [-100, 60, 60] },
      NumberFormat: { value: 1234.5, locale: "en-US" },
      NumberParse: { text: "1,234.50", locale: "en-US" },
      Outliers: { values: series },
      Percent: { operation: "change", from: 1, to: 2 },
      Percentile: { values: series, percentiles: [90] },
      Round: { value: 1.2345, places: 2 },
      Statistics: { values: series },
      UnitConvert: { value: 1, from: "km", to: "m" },
    };
    for (const tool of MATH_TOOLS) {
      const input = inputs[tool.name];
      expect({ name: tool.name, hasInput: input !== undefined }).toEqual({
        name: tool.name,
        hasInput: true,
      });
      const result = await executeTool(tool, input, { toolUseId: `all-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
      expect({ name: tool.name, empty: result.content.length === 0 }).toEqual({
        name: tool.name,
        empty: false,
      });
    }
  });
});

describe("tools chained, where the invariants live", () => {
  test("an allocation's parts add back up to the total through MoneyAdd", async () => {
    const allocation = await callJson("MoneyAllocate", {
      currency: "USD",
      amountMinor: 10_000,
      ratios: [1, 1, 1, 1, 1, 1, 7],
    });
    const parts = allocation.parts.map((p: { minorUnits: string }) => Number(p.minorUnits));
    const total = await callJson("MoneyAdd", { currency: "USD", amountsMinor: parts });
    expect(total.minorUnits).toBe("10000");
    expect(total.amount).toBe("100.00");
  });

  test("tax computed then allocated still reconciles to the taxed total", async () => {
    const tax = await callJson("MoneyMultiply", {
      currency: "USD",
      amountMinor: 19_999,
      factor: "0.0825",
    });
    const gross = await callJson("MoneyAdd", {
      currency: "USD",
      amountsMinor: [19_999, Number(tax.minorUnits)],
    });
    const split = await callJson("MoneyAllocate", {
      currency: "USD",
      amountMinor: Number(gross.minorUnits),
      ratios: [1, 1, 1],
    });
    expect(split.sumsToTotal).toBe(true);
    const back = await callJson("MoneyAdd", {
      currency: "USD",
      amountsMinor: split.parts.map((p: { minorUnits: string }) => Number(p.minorUnits)),
    });
    expect(back.minorUnits).toBe(gross.minorUnits);
  });

  test("Statistics and Percentile agree on the median for the same convention", async () => {
    const values = [5, 3, 9, 1, 7, 2, 8];
    const summary = await callJson("Statistics", { values });
    const p50 = await callJson("Percentile", { values, percentiles: [50] });
    expect(p50.results[0].value).toBe(summary.median);
    expect(p50.method).toBe(summary.percentileMethod);
  });

  test("a regression's prediction matches the same arithmetic done by Evaluate", async () => {
    const fit = await callJson("LinearRegression", { x: [1, 2, 3, 4], y: [3, 5, 7, 9] });
    const evaluated = await callJson("Evaluate", {
      expression: "slope * x + intercept",
      variables: { slope: fit.slope, intercept: fit.intercept, x: 10 },
    });
    expect(evaluated.value).toBeCloseTo(21, 9);
  });

  test("a unit conversion round-trips through the tool interface", async () => {
    const out = await callJson("UnitConvert", { value: 26.2, from: "mi", to: "km" });
    const back = await callJson("UnitConvert", { value: out.value, from: "km", to: "mi" });
    expect(back.value).toBeCloseTo(26.2, 9);
  });

  test("NumberFormat and NumberParse round-trip for a locale", async () => {
    const formatted = await callJson("NumberFormat", { value: 1234567.89, locale: "de-DE" });
    const parsed = await callJson("NumberParse", { text: formatted.formatted, locale: "de-DE" });
    expect(parsed.value).toBe(1234567.89);
  });

  test("the IRR of a series makes its NPV zero, checked by the NPV tool", async () => {
    const cashflows = [-1000, 300, 420, 680];
    const found = await callJson("Irr", { cashflows });
    const checked = await callJson("Npv", { ratePercent: found.irrPercent, cashflows });
    expect(Math.abs(checked.npv)).toBeLessThan(1e-4);
  });

  test("an amortization's interest total matches the sum of its own rows", async () => {
    const loan = await callJson("Amortize", {
      principalMinor: 2_500_000,
      annualRatePercent: "4.25",
      periods: 60,
      currency: "EUR",
    });
    const rows = loan.schedule as Array<{ interest: string; principal: string }>;
    const interest = rows.reduce((sum, row) => sum + BigInt(row.interest), 0n);
    const principal = rows.reduce((sum, row) => sum + BigInt(row.principal), 0n);
    expect(interest.toString()).toBe(loan.totalInterestMinor);
    expect(principal).toBe(2_500_000n);
  });

  test("results stay identical across repeated dispatch — nothing here is stateful", async () => {
    const input = { values: [4, 8, 15, 16, 23, 42] };
    const first = await call("Statistics", input);
    const second = await call("Statistics", input);
    const third = await call("Statistics", input);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
