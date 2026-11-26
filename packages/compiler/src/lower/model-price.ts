import {
  DEFAULT_PRICING,
  type PricingRow,
  declaredPricingKey,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import { CompilerError } from "@crewhaus/errors";
import type { IrDeclaredPricing, IrModelPrice, IrModelProfiles, IrNode } from "@crewhaus/ir";
import { enumerateModelSlots } from "@crewhaus/ir/slots";
import { declaredPriceKeyRefusal } from "@crewhaus/spec/model-price";

/**
 * The structural pin: a declared price is a pricing-table row, both ways, so
 * the runtime merges it into the table as is (`mergeDeclaredPricing`). A drift
 * in either type fails this compile.
 */
type AssertTrue<T extends true> = T;
type _IrModelPriceIsPricingRow = AssertTrue<
  IrModelPrice extends PricingRow ? (PricingRow extends IrModelPrice ? true : false) : false
>;

/** `models.<name>.price` as the spec spells it. */
export type SpecModelPrice = {
  readonly input_per_1m: number;
  readonly output_per_1m: number;
  readonly cache_read_per_1m?: number;
  readonly cache_write_per_1m?: number;
};

/**
 * Lower a profile's `price` to the pricing-table row form, only when it is
 * declared: a profile without one lowers to the same keys as before.
 */
export function lowerModelPrice(price: SpecModelPrice | undefined): { price?: IrModelPrice } {
  if (price === undefined) return {};
  return {
    price: {
      inputPer1M: price.input_per_1m,
      outputPer1M: price.output_per_1m,
      ...(price.cache_read_per_1m !== undefined
        ? { cachedReadPer1M: price.cache_read_per_1m }
        : {}),
      ...(price.cache_write_per_1m !== undefined
        ? { cacheWritePer1M: price.cache_write_per_1m }
        : {}),
    },
  };
}

/**
 * Whether a declared price replaces a row the installed pricing table already
 * has for `model` (the compiler's `model-price-overrides-table` notice).
 */
export function priceOverridesTable(model: string): boolean {
  const key = declaredPricingKey(model);
  return (
    key !== undefined && resolvePricing(DEFAULT_PRICING, key.provider, key.modelId) !== undefined
  );
}

/**
 * Every declared price in the lowered registry, keyed by the profile's
 * resolved model string in code-unit order, for each model-wiring block.
 * Returns `{}` when no profile declares a price, so every other spec lowers
 * to the same bytes. Two profiles naming one model carry one price (the
 * spec refuses two different ones).
 */
export function lowerDeclaredPricing(registry: IrModelProfiles): {
  declaredPricing?: IrDeclaredPricing;
} {
  const rows = new Map<string, IrModelPrice>();
  for (const profile of Object.values(registry)) {
    if (profile.price !== undefined && !rows.has(profile.model)) {
      rows.set(profile.model, profile.price);
    }
  }
  if (rows.size === 0) return {};
  const sorted = [...rows.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const declaredPricing: Record<string, IrModelPrice> = {};
  for (const model of sorted) declaredPricing[model] = rows.get(model) as IrModelPrice;
  return { declaredPricing };
}

/**
 * A declared price names one model, in the lowered IR too: refused with a
 * `CompilerError` when any model slot (`@crewhaus/ir/slots`: an inline pool
 * candidate, a step, node or role model, a judge, compaction, …) would be
 * priced by a declared row it does not name. The parse check
 * (`modelPriceKeyIssues`) sees the `models:` profiles only; this sees every
 * slot, by the same rule. A spec that declares no price is not read.
 */
export function assertDeclaredPricesNameOneModel(ir: IrNode): void {
  const registry = (ir as { readonly models?: IrModelProfiles }).models;
  if (registry === undefined) return;
  const priced = Object.entries(registry).filter(([, p]) => p.price !== undefined);
  if (priced.length === 0) return;
  const uses = enumerateModelSlots(ir)
    .filter((slot) => slot.kind !== "federation")
    .map((slot) => ({ label: slot.label, model: slot.model }));
  for (const [name, profile] of priced) {
    const refusal = declaredPriceKeyRefusal(`models.${name}.price`, profile.model, uses);
    if (refusal !== undefined) throw new CompilerError(refusal);
  }
}
