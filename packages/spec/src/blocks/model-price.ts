import { declaredPricingKey } from "@crewhaus/cost-tracker/pricing";
import { z } from "zod";
import type { Spec } from "../index";
import type { SpecAddIssue } from "./delta-090";

/** The most a declared rate may be, in USD per million tokens. */
export const MAX_PRICE_PER_1M = 10_000;

const rate = z.number().min(0).max(MAX_PRICE_PER_1M);

/**
 * `models.<name>.price` (#514, #516): what this model costs, in USD per
 * million tokens. A model nothing can price has an unknown cost, never $0;
 * a declared price makes it known, a declared `0` included. Every budget and
 * total of the harness prices the model's calls with it. Declared on a
 * `models:` profile only, never on an inline pool candidate. Only a person
 * sets it: a price is what budgets are measured with, so the optimizer
 * refuses it (`packages/spec-patch/src/owner-keys.ts`).
 */
export const modelPriceBlock = z
  .object({
    input_per_1m: rate,
    output_per_1m: rate,
    cache_read_per_1m: rate.optional(),
    cache_write_per_1m: rate.optional(),
  })
  .strict()
  .optional()
  .describe(
    "what this model costs, in USD per million tokens; makes an unpriced model's cost known",
  );

const SENTINELS = new Set(["cheapest", "strongest"]);

/** Two prices for one model, compared field by field. */
function samePrice(
  a: NonNullable<z.infer<typeof modelPriceBlock>>,
  b: NonNullable<z.infer<typeof modelPriceBlock>>,
): boolean {
  return (
    a.input_per_1m === b.input_per_1m &&
    a.output_per_1m === b.output_per_1m &&
    a.cache_read_per_1m === b.cache_read_per_1m &&
    a.cache_write_per_1m === b.cache_write_per_1m
  );
}

/**
 * The key a model's price is kept under: the `(provider, wire id)` the
 * runtime prices its calls by, so two strings naming one model (another
 * `@url`, another Bedrock region) share it. A string the router would refuse
 * keys as written.
 */
function priceKeyOf(model: string): string {
  const key = declaredPricingKey(model);
  return key === undefined ? `raw\u0000${model}` : `${key.provider}\u0000${key.modelId}`;
}

/**
 * A price belongs to one model: a `cheapest` / `strongest` profile has none
 * (the model it resolves to is chosen by price), and profiles naming the same
 * model, as the runtime prices it, declare the same price or only one of
 * them does.
 */
export function modelPriceIssues(data: Spec, custom: SpecAddIssue): void {
  const models = "models" in data ? data.models : undefined;
  if (models === undefined) return;
  const first = new Map<
    string,
    { name: string; price: NonNullable<z.infer<typeof modelPriceBlock>> }
  >();
  for (const [name, profile] of Object.entries(models)) {
    const price = profile.price;
    if (price === undefined) continue;
    if (SENTINELS.has(profile.model)) {
      custom(
        ["models", name, "price"],
        `models.${name}.price: a "${profile.model}" profile has no price of its own; it picks a model by price. Declare the price on a profile that names the model.`,
      );
      continue;
    }
    const key = priceKeyOf(profile.model);
    const seen = first.get(key);
    if (seen === undefined) {
      first.set(key, { name, price });
    } else if (!samePrice(seen.price, price)) {
      custom(
        ["models", name, "price"],
        `models.${name}.price differs from models.${seen.name}.price for the same model: a model has one price.`,
      );
    }
  }
}
