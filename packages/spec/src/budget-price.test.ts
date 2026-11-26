/**
 * `models.<name>.price` and `budget.period` (#514, #516): the shapes they
 * take, the contradictions each refuses, and their place at the end of the
 * 0.9.0 check order.
 */
import { describe, expect, test } from "bun:test";
import { budgetPeriodIssues } from "./blocks/budget-period";
import { DELTA_090_ISSUES } from "./blocks/delta-090";
import { modelPriceIssues, modelPriceKeyIssues, priceFamilyOf } from "./blocks/model-price";
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

describe("a declared price names one model", () => {
  const FREE = { input_per_1m: 0, output_per_1m: 0 };
  const LOCAL = "http://127.0.0.1:11434/v1";
  const agentOn = (model: string, models: unknown): string =>
    `name: a\ntarget: cli\nagent: {model: ${JSON.stringify(model)}, instructions: Help.}\nmodels: ${JSON.stringify(models)}\n`;

  test("a free local model priced as a model the pricing table prices is refused, naming both", () => {
    const issues = refusals(
      agentOn("openai/gpt-4o", { free: { model: `local/gpt-4o@${LOCAL}`, price: FREE } }),
    );
    expect(issues).toEqual([
      "models.free.price: models.free.price: local/gpt-4o@… is priced as openai gpt-4o, which the pricing table already prices; a declared price would also price those calls. Remove the price, or name a model the table does not price.",
    ]);
    // The endpoint is not repeated in the reason.
    expect(issues[0]).not.toContain("11434");
  });

  test("a price on a local model another profile names under another family is refused, naming both profiles", () => {
    const issues = refusals(
      withModels({
        mine: { model: `local/my-model@${LOCAL}`, price: { input_per_1m: 1, output_per_1m: 1 } },
        hosted: { model: "groq/my-model" },
      }),
    );
    expect(issues).toEqual([
      "models.mine.price: models.mine.price: local/my-model@… is priced as openai my-model, and so is models.hosted (groq/my-model); a declared price would also price its calls. Remove the price, or keep only one of the two models.",
    ]);
  });

  test("a free local model with a key of its own parses beside a real OpenAI model", () => {
    expect(
      refusals(agentOn("openai/gpt-4o", { free: { model: `local/qwen3@${LOCAL}`, price: FREE } })),
    ).toEqual([]);
  });

  test("two endpoints of one local model share its price", () => {
    expect(
      refusals(
        withModels({
          a: { model: "local/qwen3@http://host-a:11434/v1", price: FREE },
          b: { model: "local/qwen3@http://host-b:11434/v1" },
        }),
      ),
    ).toEqual([]);
  });

  test("an Azure price for a model the table prices is refused; an openai or Bedrock price over the table parses", () => {
    expect(
      refusals(
        withModels({ az: { model: "azure/gpt-4o", price: { input_per_1m: 1, output_per_1m: 1 } } }),
      ),
    ).toEqual([
      "models.az.price: models.az.price: azure/gpt-4o is priced as openai gpt-4o, which the pricing table already prices; a declared price would also price those calls. Remove the price, or name a model the table does not price.",
    ]);
    const price = { input_per_1m: 1, output_per_1m: 1 };
    expect(refusals(withModels({ o: { model: "openai/gpt-4o", price } }))).toEqual([]);
    expect(
      refusals(withModels({ b: { model: "bedrock/us.anthropic.claude-sonnet-4-5-v1:0", price } })),
    ).toEqual([]);
  });

  test("an openai price is refused beside the same wire id under another family", () => {
    const issues = refusals(
      withModels({
        real: { model: "openai/my-model", price: { input_per_1m: 1, output_per_1m: 1 } },
        mine: { model: `local/my-model@${LOCAL}` },
      }),
    );
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain(
      "openai/my-model is priced as openai my-model, and so is models.mine",
    );
  });

  test("the families: every prefix that shares a pricing key with another, and Bedrock as one", () => {
    expect(priceFamilyOf(`local/q@${LOCAL}`)).toBe("local");
    expect(priceFamilyOf("azure/gpt-4o")).toBe("azure");
    expect(priceFamilyOf("openrouter/meta/llama-4")).toBe("openrouter");
    expect(priceFamilyOf("openai/gpt-4o")).toBe("openai");
    expect(priceFamilyOf("claude-opus-4-7")).toBe("anthropic");
    expect(priceFamilyOf("vertex/claude-sonnet-4-5")).toBe("vertex");
    expect(priceFamilyOf("gemini/gemini-2.5-pro")).toBe("gemini");
    expect(priceFamilyOf("vertex/gemini-2.5-pro")).toBe("vertex");
    expect(priceFamilyOf("bedrock/us.anthropic.claude-sonnet-4-5-v1:0")).toBe("bedrock");
    expect(priceFamilyOf("bedrock/anthropic.claude-sonnet-4-5-v1:0")).toBe("bedrock");
    for (const other of ["gpt-5", "vertex/llama", "$p", "cheapest", "constructor/gpt-4o"]) {
      expect(priceFamilyOf(other), other).toBeUndefined();
    }
  });

  test("a Vertex Claude price beside a direct Claude profile with its key is refused, naming both", () => {
    const issues = refusals(
      withModels({
        v: { model: "vertex/claude-sonnet-4-5", price: FREE },
        direct: { model: "claude-sonnet-4-5" },
      }),
    );
    expect(issues).toEqual([
      "models.v.price: models.v.price: vertex/claude-sonnet-4-5 is priced as anthropic claude-sonnet-4-5, and so is models.direct (claude-sonnet-4-5); a declared price would also price its calls. Remove the price, or keep only one of the two models.",
    ]);
  });

  test("a direct Claude price beside a Vertex profile with its key is refused the same way", () => {
    const issues = refusals(
      withModels({
        direct: { model: "claude-sonnet-4-5", price: FREE },
        v: { model: "vertex/claude-sonnet-4-5" },
      }),
    );
    expect(issues).toEqual([
      "models.direct.price: models.direct.price: claude-sonnet-4-5 is priced as anthropic claude-sonnet-4-5, and so is models.v (vertex/claude-sonnet-4-5); a declared price would also price its calls. Remove the price, or keep only one of the two models.",
    ]);
  });

  test("a Vertex Gemini price beside a gemini/ profile with its key is refused, naming both", () => {
    const issues = refusals(
      withModels({
        v: { model: "vertex/gemini-2.5-pro", price: FREE },
        g: { model: "gemini/gemini-2.5-pro" },
      }),
    );
    expect(issues).toEqual([
      "models.v.price: models.v.price: vertex/gemini-2.5-pro is priced as gemini gemini-2.5-pro, and so is models.g (gemini/gemini-2.5-pro); a declared price would also price its calls. Remove the price, or keep only one of the two models.",
    ]);
  });

  test("a Vertex price alone over the table parses, and two Bedrock regions of one model share a price", () => {
    const price = { input_per_1m: 1, output_per_1m: 1 };
    expect(refusals(withModels({ v: { model: "vertex/claude-sonnet-4-5", price } }))).toEqual([]);
    expect(refusals(withModels({ v: { model: "vertex/gemini-2.5-pro", price } }))).toEqual([]);
    expect(
      refusals(
        withModels({
          us: { model: "bedrock/us.anthropic.claude-sonnet-4-5-v1:0", price },
          eu: { model: "bedrock/eu.anthropic.claude-sonnet-4-5-v1:0" },
        }),
      ),
    ).toEqual([]);
  });

  test("the refusal comes after every older issue: an earlier error is still the one parseSpec throws", () => {
    const yaml = `${agentOn("openai/gpt-4o", { free: { model: `local/gpt-4o@${LOCAL}`, price: FREE } })}expose: {mcp: {transport: stdio, tools: per-subagent}}\n`;
    let thrown = "";
    try {
      parseSpec(yaml);
    } catch (err) {
      thrown = (err as Error).message;
    }
    expect(thrown).toContain("per-subagent");
    expect(thrown).not.toContain("models.free.price");
    const paths = parseSpecIssues(yaml).map((i) => i.path.join("."));
    expect(paths).toEqual(["expose.mcp.tools", "models.free.price"]);
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
  test("the price and period checks are appended after every older 0.9.0 check, the price-key check last", () => {
    expect(DELTA_090_ISSUES.slice(-3)).toEqual([
      modelPriceIssues,
      budgetPeriodIssues,
      modelPriceKeyIssues,
    ]);
  });
});
