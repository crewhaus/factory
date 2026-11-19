/**
 * A model's declared price (`models.<name>.price`, #514), in USD per million
 * tokens. Structurally `@crewhaus/cost-tracker`'s `PricingRow`, so a declared
 * row merges into the pricing table as is; the compiler pins the two together
 * (`packages/compiler/src/lower/model-price.ts`).
 */
export type IrModelPrice = {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly cachedReadPer1M?: number;
  readonly cacheWritePer1M?: number;
};

/**
 * Every declared price of a harness, keyed by the resolved model string the
 * profile names, in code-unit order of the key. Carried on each model-wiring
 * block only when some profile declares a price; the runtime merges it over
 * the pricing table it prices every call with.
 */
export type IrDeclaredPricing = Readonly<Record<string, IrModelPrice>>;
