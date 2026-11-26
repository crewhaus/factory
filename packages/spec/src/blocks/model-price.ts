import {
  DEFAULT_PRICING,
  declaredPricingKey,
  resolvePricing,
} from "@crewhaus/cost-tracker/pricing";
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

/**
 * The family of an OpenAI-protocol model string: `local`, `azure`, an
 * OpenAI-compatible host's id (`groq`, `openrouter`, …) or `openai`. Every one
 * of them is priced as `openai <wire id>`, so a family is what tells two such
 * strings with one wire id apart. Undefined for any other string.
 */
export function priceFamilyOf(model: string): string | undefined {
  const key = declaredPricingKey(model);
  if (key === undefined || key.provider !== "openai") return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

/** A model string as a refusal shows it: a local model's endpoint is left out. */
function shownModel(model: string): string {
  if (!model.startsWith("local/")) return model;
  const at = model.indexOf("@");
  return at === -1 ? model : `${model.slice(0, at)}@…`;
}

/** A place a spec names a model: its label (`models.groq`, `steps[0].model`) and the string. */
export type ModelUse = { readonly label: string; readonly model: string };

/**
 * Why a price declared at `at` for `model` would also price the calls of a
 * model it does not name, or undefined when it names only its own. The
 * runtime keeps a declared price under the `(provider, wire id)` it prices
 * calls by, so every OpenAI-protocol string with that wire id shares it:
 *   - a price on a `local/`, `azure/` or compatible-host string whose key the
 *     built-in pricing table prices would also price that table model's
 *     calls (a price on an `openai/` string replaces the table's on purpose,
 *     which the compiler notes);
 *   - a price on an OpenAI-protocol string whose key one of `others` has
 *     under another family would also price that string's calls. Strings of
 *     one family (two `@url`s of one local model) share a price by design.
 * The parse check passes the spec's other `models:` profiles; the lowering
 * passes every slot of the lowered IR, which parse cannot see.
 */
export function declaredPriceKeyRefusal(
  at: string,
  model: string,
  others: ReadonlyArray<ModelUse>,
): string | undefined {
  const key = declaredPricingKey(model);
  const family = priceFamilyOf(model);
  if (key === undefined || family === undefined) return undefined;
  const priced = `${shownModel(model)} is priced as ${key.provider} ${key.modelId}`;
  if (
    family !== "openai" &&
    resolvePricing(DEFAULT_PRICING, key.provider, key.modelId) !== undefined
  ) {
    return `${at}: ${priced}, which the pricing table already prices; a declared price would also price those calls. Remove the price, or name a model the table does not price.`;
  }
  for (const other of others) {
    const otherFamily = priceFamilyOf(other.model);
    if (otherFamily === undefined || otherFamily === family) continue;
    const otherKey = declaredPricingKey(other.model);
    if (otherKey?.provider !== key.provider || otherKey.modelId !== key.modelId) continue;
    return `${at}: ${priced}, and so is ${other.label} (${shownModel(other.model)}); a declared price would also price its calls. Remove the price, or keep only one of the two models.`;
  }
  return undefined;
}

/**
 * A declared price names one model: refused when it would also price another
 * model's calls, by the built-in table or by another `models:` profile (see
 * {@link declaredPriceKeyRefusal}). Appended last to the 0.9.0 checks.
 */
export function modelPriceKeyIssues(data: Spec, custom: SpecAddIssue): void {
  const models = "models" in data ? data.models : undefined;
  if (models === undefined) return;
  const profiles = Object.entries(models);
  for (const [name, profile] of profiles) {
    if (profile.price === undefined || SENTINELS.has(profile.model)) continue;
    const others = profiles
      .filter(([other]) => other !== name)
      .map(([other, p]) => ({ label: `models.${other}`, model: p.model }));
    const refusal = declaredPriceKeyRefusal(`models.${name}.price`, profile.model, others);
    if (refusal !== undefined) custom(["models", name, "price"], refusal);
  }
}
