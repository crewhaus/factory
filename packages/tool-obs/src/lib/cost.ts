/**
 * What a harness spent, from its own logs.
 *
 * The runtime writes a `cost_accrual` line per model response when cost
 * tracking is on: token counts, and `costUsdMicros` computed from whatever
 * price table that process happened to hold. Two facts follow from that, and
 * they are why this module takes a rate table from the CALLER:
 *
 *   - the recorded cost is a historical artefact of the prices that were
 *     loaded at the time, so re-pricing last month's tokens at today's rates
 *     is a different and often more useful question;
 *   - a model with no price row at all is recorded at zero cost with real
 *     token counts (`unpriced: true`), and summing that column silently
 *     under-reports spend.
 *
 * So: tokens are the ground truth, the rate table is an input, and both the
 * recorded figure and the recomputed one come back side by side. A tool that
 * guessed the prices would be confidently wrong about money.
 *
 * ARITHMETIC. Everything is integer micro-USD. A rate is USD per million
 * tokens, so `tokens × usdPerMillion` is already micro-USD
 * (`tokens / 1e6 × usd × 1e6`) — no division, no float drift, one `Math.round`
 * at the end of each line item.
 */
import { type ObsEvent, asNumber, asRecord, asString, byString } from "./events";

export type TokenFields = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens: number;
  readonly cacheCreationTokens: number;
};

export type CostBucket = TokenFields & {
  readonly key: string;
  readonly calls: number;
  /** What the runtime recorded at the time, summed. */
  readonly recordedUsdMicros: number;
  /** What the caller's rate table says those tokens cost. */
  readonly computedUsdMicros: number;
  /** Calls whose model matched no row in the caller's rate table. */
  readonly unratedCalls: number;
};

/** USD per MILLION tokens, per model. Absent fields price at zero. */
export type ModelRate = {
  readonly model: string;
  readonly inputPerMillionUsd?: number;
  readonly outputPerMillionUsd?: number;
  readonly cachedReadPerMillionUsd?: number;
  readonly cacheCreationPerMillionUsd?: number;
};

export type CostReportResult = {
  readonly accruals: number;
  /** Accruals the RUNTIME could not price — real tokens, recorded cost 0. */
  readonly unpricedAccruals: number;
  /** Accruals whose model matched no row in the CALLER's rate table. */
  readonly unratedAccruals: number;
  /** Models seen with no rate row, sorted — the list to add rates for. */
  readonly modelsWithoutRate: readonly string[];
  readonly totals: Omit<CostBucket, "key">;
  readonly byModel: readonly CostBucket[];
  readonly byDay: readonly CostBucket[];
  readonly byRun: readonly CostBucket[];
};

type Mutable = {
  calls: number;
  recordedUsdMicros: number;
  computedUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  unratedCalls: number;
};

function empty(): Mutable {
  return {
    calls: 0,
    recordedUsdMicros: 0,
    computedUsdMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    unratedCalls: 0,
  };
}

function addTo(map: Map<string, Mutable>, key: string, line: Mutable): void {
  const row = map.get(key) ?? empty();
  row.calls += line.calls;
  row.recordedUsdMicros += line.recordedUsdMicros;
  row.computedUsdMicros += line.computedUsdMicros;
  row.inputTokens += line.inputTokens;
  row.outputTokens += line.outputTokens;
  row.cachedReadTokens += line.cachedReadTokens;
  row.cacheCreationTokens += line.cacheCreationTokens;
  row.unratedCalls += line.unratedCalls;
  map.set(key, row);
}

/** UTC calendar day of an epoch-ms timestamp; `unknown` when there is none. */
export function utcDay(ts: number | undefined): string {
  if (ts === undefined) return "unknown";
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
}

/**
 * Price one accrual's tokens with a rate table.
 *
 * Cache reads and cache writes fall back to the input rate when the table does
 * not price them separately, because that is the shape of every provider's
 * pricing page: a cache read is a discounted input token, not a free one, and
 * charging it at zero is a bigger error than charging it at full input price.
 * `cacheCreationPerMillionUsd` exists because the write premium is real.
 */
export function priceTokens(tokens: TokenFields, rate: ModelRate | undefined): number {
  if (rate === undefined) return 0;
  const input = rate.inputPerMillionUsd ?? 0;
  const output = rate.outputPerMillionUsd ?? 0;
  const cachedRead = rate.cachedReadPerMillionUsd ?? input;
  const cacheCreate = rate.cacheCreationPerMillionUsd ?? input;
  return Math.round(
    tokens.inputTokens * input +
      tokens.outputTokens * output +
      tokens.cachedReadTokens * cachedRead +
      tokens.cacheCreationTokens * cacheCreate,
  );
}

function bucketsOf(map: Map<string, Mutable>): CostBucket[] {
  return [...map.keys()].sort(byString).map((key) => ({ key, ...(map.get(key) as Mutable) }));
}

/**
 * Sum `cost_accrual` events by model, by UTC day and by run.
 *
 * The runner's own terminal roll-up (`summary: true`) is skipped, exactly as
 * `crewhaus incident collect` skips it, so a run total is never counted twice.
 */
export function costReport(
  events: readonly ObsEvent[],
  rates: readonly ModelRate[],
): CostReportResult {
  const rateByModel = new Map<string, ModelRate>();
  for (const rate of rates) rateByModel.set(rate.model, rate);

  const byModel = new Map<string, Mutable>();
  const byDay = new Map<string, Mutable>();
  const byRun = new Map<string, Mutable>();
  const totals = empty();
  const missingRates = new Set<string>();
  let accruals = 0;
  let unpricedAccruals = 0;
  let unratedAccruals = 0;

  for (const event of events) {
    if (event.kind !== "cost_accrual") continue;
    const payload = asRecord(event.payload);
    if (payload === undefined || payload["summary"] === true) continue;
    accruals += 1;
    if (payload["unpriced"] === true) unpricedAccruals += 1;

    const model =
      asString(payload["modelId"]) ??
      asString(payload["specModel"]) ??
      asString(payload["model"]) ??
      "unknown";
    const rate = rateByModel.get(model);
    if (rate === undefined) {
      unratedAccruals += 1;
      missingRates.add(model);
    }
    const tokens: TokenFields = {
      inputTokens: asNumber(payload["inputTokens"]) ?? 0,
      outputTokens: asNumber(payload["outputTokens"]) ?? 0,
      cachedReadTokens: asNumber(payload["cachedReadTokens"]) ?? 0,
      cacheCreationTokens: asNumber(payload["cacheCreationTokens"]) ?? 0,
    };
    const line: Mutable = {
      calls: 1,
      recordedUsdMicros: asNumber(payload["costUsdMicros"]) ?? 0,
      computedUsdMicros: priceTokens(tokens, rate),
      ...tokens,
      unratedCalls: rate === undefined ? 1 : 0,
    };

    addTo(byModel, model, line);
    addTo(byDay, utcDay(event.ts), line);
    addTo(byRun, asString(payload["runId"]) ?? asString(payload["run_id"]) ?? "unknown", line);

    totals.calls += 1;
    totals.recordedUsdMicros += line.recordedUsdMicros;
    totals.computedUsdMicros += line.computedUsdMicros;
    totals.inputTokens += tokens.inputTokens;
    totals.outputTokens += tokens.outputTokens;
    totals.cachedReadTokens += tokens.cachedReadTokens;
    totals.cacheCreationTokens += tokens.cacheCreationTokens;
    totals.unratedCalls += line.unratedCalls;
  }

  return {
    accruals,
    unpricedAccruals,
    unratedAccruals,
    modelsWithoutRate: [...missingRates].sort(byString),
    totals: { ...totals },
    byModel: bucketsOf(byModel),
    byDay: bucketsOf(byDay),
    byRun: bucketsOf(byRun),
  };
}
