import { ABSENT_CORPUS } from "./absent-corpus";

/**
 * The specs that pin what a declared spend setting compiles to (#514, #516):
 * absent-corpus specs plus one `budget.period` or one priced `models:`
 * profile. `__fixtures__/delta-090/budget-period.present.digests.json` and
 * `models-price.present.digests.json` pin the output, and
 * `spend-goldens.test.ts` guards the key order of what is emitted.
 */
const PERIOD_SHAPES = ["cli", "channel", "workflow"] as const;
const PRICE_SHAPES = ["cli", "workflow", "crew"] as const;

/** Every period key, so the golden pins their order. */
const PERIOD = `budget:
  usd: 5
  period:
    timezone: Europe/Berlin
    starts: "2026-01-05"
    usd: 50
    every: month
`;

/**
 * Two priced profiles declared out of model order, one a declared $0 and one
 * with both cache rates, so the golden pins the sorted keys and the row form.
 */
const PRICED = `models:
  zeta:
    model: local/qwen3@http://127.0.0.1:11434/v1
    price: {output_per_1m: 0, input_per_1m: 0}
  alpha:
    model: openrouter/meta/llama-4
    price: {cache_write_per_1m: 1.25, cache_read_per_1m: 0.1, output_per_1m: 4, input_per_1m: 1}
`;

function withEach(
  shapes: ReadonlyArray<keyof typeof ABSENT_CORPUS>,
  block: string,
  label: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const shape of shapes) out[`${shape}-${label}`] = `${ABSENT_CORPUS[shape]}${block}`;
  return out;
}

/** cli, channel and workflow, each with a monthly period in Berlin time. */
export const BUDGET_PERIOD_CORPUS: Readonly<Record<string, string>> = Object.freeze(
  withEach(PERIOD_SHAPES, PERIOD, "period"),
);

/** cli, workflow and crew, each with two priced profiles. */
export const MODELS_PRICE_CORPUS: Readonly<Record<string, string>> = Object.freeze(
  withEach(PRICE_SHAPES, PRICED, "price"),
);
