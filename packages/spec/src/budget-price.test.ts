/**
 * `models.<name>.price` and `budget.period` (#514, #516): the shapes they
 * take, the contradictions each refuses, and their place at the end of the
 * 0.9.0 check order.
 */
import { describe, expect, test } from "bun:test";
import { budgetPeriodIssues } from "./blocks/budget-period";
import { DELTA_090_ISSUES } from "./blocks/delta-090";
import { modelPriceIssues } from "./blocks/model-price";
import { parseSpec, parseSpecIssues } from "./index";

const CLI = "name: a\ntarget: cli\nagent: {model: claude-opus-4-7, instructions: Help.}\n";

const withModels = (models: unknown): string => `${CLI}models: ${JSON.stringify(models)}\n`;
const withBudget = (budget: unknown): string => `${CLI}budget: ${JSON.stringify(budget)}\n`;

/** The messages a spec text is refused with (empty when it parses). */
function refusals(yaml: string): string[] {
  try {
    parseSpec(yaml);
    return [];
  } catch {
    return parseSpecIssues(yaml).map((i) => `${i.path.join(".")}: ${i.message}`);
  }
}

describe("models.<name>.price", () => {
  test("a profile's price parses, a declared $0 included", () => {
    const spec = parseSpec(
      withModels({
        local: {
          model: "local/qwen3@http://127.0.0.1:11434/v1",
          price: { input_per_1m: 0, output_per_1m: 0 },
        },
        paid: {
          model: "claude-opus-4-7",
          price: {
            input_per_1m: 3,
            output_per_1m: 15,
            cache_read_per_1m: 0.3,
            cache_write_per_1m: 3.75,
          },
        },
      }),
    );
    const models = "models" in spec ? spec.models : undefined;
    expect(models?.["local"]?.price).toEqual({ input_per_1m: 0, output_per_1m: 0 });
    expect(models?.["paid"]?.price?.cache_write_per_1m).toBe(3.75);
  });

  test("a rate is between 0 and 10,000 and the block takes no other key", () => {
    expect(
      refusals(
        withModels({
          m: { model: "claude-opus-4-7", price: { input_per_1m: -1, output_per_1m: 1 } },
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      refusals(
        withModels({
          m: { model: "claude-opus-4-7", price: { input_per_1m: 1, output_per_1m: 10_001 } },
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      refusals(
        withModels({
          m: {
            model: "claude-opus-4-7",
            price: { input_per_1m: 1, output_per_1m: 1, per_call: 1 },
          },
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      refusals(withModels({ m: { model: "claude-opus-4-7", price: { input_per_1m: 1 } } })).length,
    ).toBeGreaterThan(0);
  });

  test("an inline pool candidate takes no price: it belongs to a profile", () => {
    const yaml = `${CLI.replace(
      "agent: {model: claude-opus-4-7, instructions: Help.}",
      "agent:\n  model: claude-opus-4-7\n  instructions: Help.\n  model_pool:\n    candidates:\n      - {model: claude-opus-4-7, price: {input_per_1m: 1, output_per_1m: 1}}\n",
    )}`;
    expect(refusals(yaml).length).toBeGreaterThan(0);
  });

  test("a cheapest or strongest profile declares no price", () => {
    const issues = refusals(
      withModels({ cheap: { model: "cheapest", price: { input_per_1m: 1, output_per_1m: 1 } } }),
    );
    expect(issues).toEqual([
      'models.cheap.price: models.cheap.price: a "cheapest" profile has no price of its own; it picks a model by price. Declare the price on a profile that names the model.',
    ]);
  });

  test("two profiles naming one model agree on its price", () => {
    const price = { input_per_1m: 1, output_per_1m: 2 };
    expect(
      refusals(
        withModels({
          a: { model: "local/q@http://h/v1", price },
          b: { model: "local/q@http://h/v1", price },
          c: { model: "local/q@http://h/v1" },
        }),
      ),
    ).toEqual([]);
    expect(
      refusals(
        withModels({
          a: { model: "local/q@http://h/v1", price },
          b: { model: "local/q@http://h/v1", price: { ...price, output_per_1m: 3 } },
        }),
      ),
    ).toEqual([
      "models.b.price: models.b.price differs from models.a.price for the same model: a model has one price.",
    ]);
  });

  test("two strings the runtime prices as one model carry one price", () => {
    const price = { input_per_1m: 1, output_per_1m: 2 };
    expect(
      refusals(
        withModels({
          a: { model: "local/qwen3@http://a/v1", price },
          b: { model: "local/qwen3@http://b/v1", price: { input_per_1m: 5, output_per_1m: 5 } },
        }),
      ),
    ).toEqual([
      "models.b.price: models.b.price differs from models.a.price for the same model: a model has one price.",
    ]);
    expect(
      refusals(
        withModels({
          a: { model: "bedrock/us.anthropic.claude-sonnet-4-5-v1:0", price },
          b: {
            model: "bedrock/eu.anthropic.claude-sonnet-4-5-v1:0",
            price: { ...price, output_per_1m: 9 },
          },
        }),
      ),
    ).toHaveLength(1);
    // Different models keep their own prices.
    expect(
      refusals(
        withModels({
          a: { model: "local/qwen3@http://a/v1", price },
          b: { model: "local/qwen3-coder@http://a/v1", price: { ...price, output_per_1m: 9 } },
        }),
      ),
    ).toEqual([]);
  });
});

describe("budget.period", () => {
  test("a period parses inside the budget, every field kept", () => {
    const spec = parseSpec(
      withBudget({
        usd: 5,
        period: { every: "month", usd: 50, starts: "2026-01-15", timezone: "Europe/Berlin" },
      }),
    );
    expect("budget" in spec ? spec.budget?.period : undefined).toEqual({
      every: "month",
      usd: 50,
      starts: "2026-01-15",
      timezone: "Europe/Berlin",
    });
  });

  test("an unknown zone, a date that is not a day and a month starting past the 28th are refused", () => {
    expect(
      refusals(withBudget({ usd: 5, period: { every: "day", usd: 1, timezone: "Mars/Olympus" } })),
    ).toEqual([
      'budget.period.timezone: budget.period.timezone "Mars/Olympus" is not a time zone this runtime knows; use an IANA name such as "Europe/Berlin".',
    ]);
    expect(
      refusals(withBudget({ usd: 5, period: { every: "week", usd: 1, starts: "2026-02-30" } })),
    ).toEqual(['budget.period.starts: budget.period.starts "2026-02-30" is not a calendar date.']);
    expect(
      refusals(withBudget({ usd: 5, period: { every: "month", usd: 1, starts: "2026-01-29" } })),
    ).toEqual([
      "budget.period.starts: budget.period.starts is day 29: a monthly period starts on day 1 to 28, so every month has that day.",
    ]);
    // A weekly or daily period may start on any day.
    expect(
      refusals(withBudget({ usd: 5, period: { every: "week", usd: 1, starts: "2026-01-31" } })),
    ).toEqual([]);
  });

  test("the period takes only its four keys, a positive amount and an ISO date", () => {
    for (const period of [
      { every: "year", usd: 1 },
      { every: "day", usd: 0 },
      { every: "day", usd: 1, starts: "15 Jan" },
      { every: "day", usd: 1, reset: true },
    ]) {
      expect(refusals(withBudget({ usd: 5, period })).length).toBeGreaterThan(0);
    }
  });

  test("a budget without a period parses as before", () => {
    const spec = parseSpec(withBudget({ usd: 5 }));
    expect("budget" in spec && spec.budget !== undefined && "period" in spec.budget).toBe(false);
  });
});

describe("the check order", () => {
  test("the price and period checks are appended after every older 0.9.0 check", () => {
    expect(DELTA_090_ISSUES.slice(-2)).toEqual([modelPriceIssues, budgetPeriodIssues]);
  });
});
