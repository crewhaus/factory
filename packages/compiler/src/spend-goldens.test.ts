/**
 * `budget.period` and `models.<name>.price` (#514, #516): what each compiles
 * to when declared, with its key order guarded, and that a spec declaring
 * neither keeps its bytes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSpec } from "@crewhaus/spec";
import { CORPUS_TODAY, corpusFileDigests } from "./__fixtures__/delta-090/regenerate";
import { ABSENT_CORPUS } from "./absent-corpus";
import { compile, lower } from "./index";
import { lowerBudgetPeriod } from "./lower/budget-period";
import { lowerDeclaredPricing, lowerModelPrice } from "./lower/model-price";
import { BUDGET_PERIOD_CORPUS, MODELS_PRICE_CORPUS } from "./spend-corpus";

function digestsOf(name: string): Record<string, Record<string, string>> {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/delta-090/${name}`, import.meta.url), "utf8"),
  ) as Record<string, Record<string, string>>;
}

/** Every emitted file's text, joined. */
const emitted = (yaml: string): string =>
  compile(yaml, { today: CORPUS_TODAY })
    .files.map((f) => f.content)
    .join("\n");

describe("budget.period", () => {
  const present = digestsOf("budget-period.present.digests.json");

  test("the present golden covers exactly the three specs", () => {
    expect(Object.keys(present)).toEqual(["channel-period", "cli-period", "workflow-period"]);
  });

  for (const [name, yaml] of Object.entries(BUDGET_PERIOD_CORPUS)) {
    test(`${name}: every file matches the present golden`, () => {
      expect(corpusFileDigests(yaml)).toEqual(present[name] as Record<string, string>);
    });

    test(`${name}: the period is emitted inside the budget, keys in order`, () => {
      const text = emitted(yaml);
      const at = text.indexOf(
        '"period":{"every":"month","usdMicros":50000000,"starts":"2026-01-05","timezone":"Europe/Berlin"}',
      );
      expect(at).toBeGreaterThan(-1);
    });
  }

  test("lowers to USD-micros, its optional keys only when declared", () => {
    expect(lowerBudgetPeriod(undefined)).toEqual({});
    expect(lowerBudgetPeriod({ every: "day", usd: 1.2345675 })).toEqual({
      period: { every: "day", usdMicros: 1_234_568 },
    });
  });

  test("a budget without a period lowers to the keys it always had", () => {
    const ir = lower(parseSpec(`${ABSENT_CORPUS.cli}budget: {usd: 5}\n`)) as {
      budget?: Record<string, unknown>;
    };
    expect(Object.keys(ir.budget ?? {})).toEqual(["usdMicros", "onExceed"]);
  });
});

describe("models.<name>.price", () => {
  const present = digestsOf("models-price.present.digests.json");

  test("the present golden covers exactly the three specs", () => {
    expect(Object.keys(present)).toEqual(["cli-price", "crew-price", "workflow-price"]);
  });

  for (const [name, yaml] of Object.entries(MODELS_PRICE_CORPUS)) {
    test(`${name}: every file matches the present golden`, () => {
      expect(corpusFileDigests(yaml)).toEqual(present[name] as Record<string, string>);
    });

    test(`${name}: declaredPricing is rendered once per loop block, sorted, in the row form`, () => {
      const text = emitted(yaml);
      const rendered =
        'declaredPricing: {"local/qwen3@http://127.0.0.1:11434/v1":{"inputPer1M":0,"outputPer1M":0},"openrouter/meta/llama-4":{"inputPer1M":1,"outputPer1M":4,"cachedReadPer1M":0.1,"cacheWritePer1M":1.25}},';
      expect(text.indexOf(rendered)).toBeGreaterThan(-1);
    });
  }

  test("an absent price renders nothing, and a profile without one lowers to its old keys", () => {
    expect(emitted(ABSENT_CORPUS.cli)).not.toContain("declaredPricing");
    const unpriced = `${ABSENT_CORPUS.cli}models:\n  main: {model: claude-haiku-4-5}\n`;
    expect(emitted(unpriced)).not.toContain("declaredPricing");
    const ir = lower(parseSpec(unpriced)) as { models?: Record<string, object> };
    expect(Object.keys(ir.models?.["main"] ?? {})).toEqual(["profile", "model"]);
  });

  test("a priced profile used in a pool keeps the price off the candidate", () => {
    const yaml = `name: p
target: cli
agent:
  model: $main
  instructions: Help.
  model_pool:
    candidates:
      - {model: $main}
      - {model: claude-opus-4-7}
models:
  main:
    model: local/qwen3@http://127.0.0.1:11434/v1
    price: {input_per_1m: 1, output_per_1m: 2}
`;
    const ir = lower(parseSpec(yaml)) as {
      agent: { modelPool?: { candidates: object[] }; declaredPricing?: object };
    };
    for (const c of ir.agent.modelPool?.candidates ?? []) expect("price" in c).toBe(false);
    expect(ir.agent.declaredPricing).toEqual({
      "local/qwen3@http://127.0.0.1:11434/v1": { inputPer1M: 1, outputPer1M: 2 },
    });
  });

  test("a price over a table row is announced; one the table lacks is not", () => {
    const over = compile(
      `${ABSENT_CORPUS.cli}models:\n  m: {model: claude-opus-4-7, price: {input_per_1m: 1, output_per_1m: 1}}\n`,
      { today: CORPUS_TODAY },
    );
    expect(over.warnings.map((w) => w.code)).toContain("model-price-overrides-table");
    const fresh = compile(MODELS_PRICE_CORPUS["cli-price"] as string, { today: CORPUS_TODAY });
    expect(fresh.warnings.map((w) => w.code)).not.toContain("model-price-overrides-table");
  });

  test("the lowering helpers return nothing for nothing", () => {
    expect(lowerModelPrice(undefined)).toEqual({});
    expect(lowerDeclaredPricing({})).toEqual({});
    expect(lowerDeclaredPricing({ a: { profile: "a", model: "m" } })).toEqual({});
  });
});
