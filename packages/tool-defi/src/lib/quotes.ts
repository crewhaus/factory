/**
 * Offchain prices from two unauthenticated public providers, with the
 * provenance that makes a number checkable.
 *
 * Two origins, both constants, neither of which takes a credential:
 *
 *   - **Frankfurter** republishes the ECB's daily euro reference rates. One
 *     fixing per TARGET business day at about 16:00 CET — so a weekend, a
 *     Christmas Day, or "today before the fixing" all resolve BACK to an
 *     earlier date, and the response says which. That returned date is the
 *     `asOf`, and it is the whole reason a reconciliation run reproduces.
 *   - **Coinbase's** `/v2/prices/{pair}/spot`, for crypto and for fiat pairs
 *     the ECB does not publish.
 *
 * **Coinbase's spot response carries no timestamp.** Not a stale one, none at
 * all: `{ "data": { "base", "currency", "amount" } }` is the whole document.
 * The survey sketch that proposed this tool assumed every provider had a
 * timestamp field to stamp `asOf` from; this one does not, and the honest
 * answer is `asOf: null` with `asOfSource: "none"` rather than the time the
 * response arrived. Stamping arrival time would make every reading look fresh
 * by construction, which is the exact failure the sketch was trying to avoid.
 *
 * It also means **a historical crypto quote is refused here**, rather than
 * served from a spot endpoint that echoes no date: a price that cannot be
 * distinguished from today's must not be labelled as last Tuesday's. The
 * refusal names the alternatives — a Chainlink round read at a pinned block,
 * or pricing the asset in a fiat pair the ECB does publish.
 *
 * Every price carries where it came from and how it was derived: a direct
 * quote, an inversion of the pair the provider actually publishes, or a cross
 * through an intermediate asset — and a cross names the intermediate and
 * carries both legs' provenance with it.
 */
import { KNOWN_CURRENCIES } from "@crewhaus/tool-math";
import {
  type Fixed,
  type PriceLiteralKind,
  divide,
  fixedFromJson,
  fromInteger,
  isPositive,
  multiply,
  toDecimalString,
} from "./decimal";
import { DefiError, type RpcOptions, getJson } from "./rpc";

/** The two origins this package reads prices from. There is no third, and no override. */
export const PROVIDER_ORIGINS = Object.freeze({
  frankfurter: "https://api.frankfurter.app",
  coinbase: "https://api.coinbase.com",
});

export type ProviderName = keyof typeof PROVIDER_ORIGINS;

export const PROVIDER_NAMES: ReadonlyArray<ProviderName> = Object.freeze([
  "frankfurter",
  "coinbase",
]);

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(Object.values(PROVIDER_ORIGINS));

/** An asset symbol, as a provider spells it. Deliberately narrow: it goes into a path. */
const SYMBOL = /^[A-Za-z0-9]{2,12}$/;

/** ISO 8601 calendar date, which is the only `at` either provider understands. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Inversion and cross division are carried to this many places.
 *
 * 1/3 has no exact decimal expansion, so an inverted quote is rounded exactly
 * once, here, with the mode named in the result. Eighteen places is more than
 * any provider publishes and matches the widest token decimalisation, so the
 * rounding is below the noise of the input rather than above it.
 */
export const INVERSION_SCALE = 18;

export type QuoteLeg = {
  readonly source: ProviderName;
  readonly endpoint: string;
  readonly pair: string;
  /** `direct` when the provider publishes this pair; `inverted` when it publishes the other one. */
  readonly derivation: "direct" | "inverted";
  readonly price: string;
  /** The provider's OWN date for this price, or null when it publishes none. */
  readonly asOf: string | null;
  readonly asOfSource: "frankfurter.date" | "none";
  /** What "this price, at this date" means for this provider. */
  readonly convention: string;
  /** Whether the number arrived as a JSON string (exact) or a JSON number (through a double). */
  readonly literal: PriceLiteralKind;
  readonly requestedAt: string | null;
};

export type Quote = {
  readonly base: string;
  readonly quote: string;
  readonly price: string;
  readonly derivation: "direct" | "inverted" | "cross";
  /** The intermediate asset a cross went through. Null when it did not cross. */
  readonly via: string | null;
  /** Every leg, in the order they were composed. One leg unless this crossed. */
  readonly legs: ReadonlyArray<QuoteLeg>;
  /**
   * The oldest `asOf` across the legs, or null when any leg publishes none. A
   * composite price is exactly as old as its oldest input, and one leg without
   * a timestamp makes the composite untimestamped rather than fresh.
   */
  readonly asOf: string | null;
  readonly notes: ReadonlyArray<string>;
};

export type QuoteValue = { readonly quote: Quote; readonly value: Fixed };

export type QuoteRequest = {
  readonly base: string;
  readonly quote: string;
  /** An ISO date. Absent means the provider's current publication. */
  readonly at?: string;
  /** Provider order. Absent picks by pair: the ECB for fiat/fiat, Coinbase otherwise. */
  readonly providers?: ReadonlyArray<ProviderName>;
  /** The intermediate to cross through when no provider publishes the pair directly. */
  readonly via?: string;
  /** Set false to refuse rather than cross. A cross is two prices, not one. */
  readonly allowCross?: boolean;
};

export function normalizeSymbol(raw: string, what: string): string {
  const text = raw.trim().toUpperCase();
  if (!SYMBOL.test(text)) {
    throw new DefiError(`${what}: "${raw}" is not an asset symbol (2 to 12 letters or digits)`);
  }
  return text;
}

function normalizeAt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!ISO_DATE.test(text)) {
    throw new DefiError(
      `at: "${raw}" is not an ISO calendar date (YYYY-MM-DD) — these providers publish by date, not by instant`,
    );
  }
  return text;
}

/**
 * Whether a code is a currency this monorepo knows.
 *
 * The table is `@crewhaus/tool-math`'s, through its public surface, rather than
 * a second ISO 4217 list in this package that would drift from it.
 */
export function isFiat(code: string): boolean {
  return KNOWN_CURRENCIES.includes(code);
}

/** Which providers to try, and in what order, for a pair nobody named providers for. */
export function defaultProviders(base: string, quote: string): ReadonlyArray<ProviderName> {
  // The ECB fixing is the reference rate a finance team reconciles against, so
  // it goes first when it can answer at all; it publishes fiat only.
  return isFiat(base) && isFiat(quote) ? ["frankfurter", "coinbase"] : ["coinbase"];
}

function assertKnownOrigin(url: URL): void {
  if (!ALLOWED_ORIGINS.has(url.origin)) {
    throw new DefiError(
      `refusing to dial "${url.origin}" — this package reads prices from ${[...ALLOWED_ORIGINS].join(" and ")} only`,
    );
  }
}

type LegOutcome =
  | { readonly ok: true; readonly leg: QuoteLeg; readonly value: Fixed }
  | { readonly ok: false; readonly reason: string };

const FRANKFURTER_CONVENTION =
  "ECB daily euro reference rate, fixed at about 16:00 CET on a TARGET business day; a request for a non-business day resolves back to the previous fixing and the date field says which one";

const COINBASE_CONVENTION =
  "Coinbase's current spot price for the pair; the endpoint publishes no timestamp, so this price has no asOf of its own";

/** Ask Frankfurter for `base -> quote`, directly. It has no inverse problem: from/to are parameters. */
async function frankfurterLeg(
  base: string,
  quote: string,
  at: string | undefined,
  options: RpcOptions,
): Promise<LegOutcome> {
  if (!isFiat(base) || !isFiat(quote)) {
    return {
      ok: false,
      reason: `frankfurter publishes ECB reference rates for currencies; ${isFiat(base) ? quote : base} is not one`,
    };
  }
  if (base === quote) {
    return { ok: false, reason: "a pair of one currency with itself is not a quote" };
  }
  const url = new URL(
    `${at ?? "latest"}?from=${base}&to=${quote}`,
    `${PROVIDER_ORIGINS.frankfurter}/`,
  );
  assertKnownOrigin(url);
  const outcome = await getJson(url.toString(), options);
  if (!outcome.ok) return { ok: false, reason: `frankfurter: ${outcome.message}` };

  const body = outcome.value as { date?: unknown; rates?: Record<string, unknown> };
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "frankfurter answered something other than an object" };
  }
  const rates = body.rates;
  if (typeof rates !== "object" || rates === null) {
    return { ok: false, reason: "frankfurter's answer carried no rates object" };
  }
  const raw = (rates as Record<string, unknown>)[quote];
  if (raw === undefined) {
    return { ok: false, reason: `frankfurter does not publish a rate for ${base}/${quote}` };
  }
  const date = typeof body.date === "string" ? body.date : null;
  if (date === null) {
    // Without the fixing date there is no provenance, and an ECB rate without
    // its date is exactly the number a reconciliation cannot reproduce.
    return {
      ok: false,
      reason: "frankfurter's answer carried no date, so the fixing it used is unknown",
    };
  }
  let price: Fixed;
  let literal: PriceLiteralKind;
  try {
    const parsed = fixedFromJson(raw, `the ${base}/${quote} rate`);
    price = parsed.value;
    literal = parsed.kind;
  } catch (err) {
    return { ok: false, reason: `frankfurter: ${(err as Error).message}` };
  }
  if (!isPositive(price)) {
    return {
      ok: false,
      reason: `frankfurter answered ${toDecimalString(price)} for ${base}/${quote}`,
    };
  }
  return {
    ok: true,
    value: price,
    leg: {
      source: "frankfurter",
      endpoint: PROVIDER_ORIGINS.frankfurter,
      pair: `${base}/${quote}`,
      derivation: "direct",
      price: toDecimalString(price),
      asOf: date,
      asOfSource: "frankfurter.date",
      convention: FRANKFURTER_CONVENTION,
      literal,
      requestedAt: at ?? null,
    },
  };
}

/** Ask Coinbase for a spot price, trying the inverse pair when the direct one is not published. */
async function coinbaseLeg(
  base: string,
  quote: string,
  at: string | undefined,
  options: RpcOptions,
): Promise<LegOutcome> {
  if (at !== undefined) {
    return {
      ok: false,
      reason:
        "coinbase's spot endpoint publishes no date and echoes none back, so a historical answer from it cannot be told apart from today's — read a Chainlink round at a pinned block with OraclePriceRead, or quote the asset against a currency the ECB publishes",
    };
  }
  if (base === quote) {
    return { ok: false, reason: "a pair of one asset with itself is not a quote" };
  }
  const direct = await coinbaseSpot(base, quote, options);
  if (direct.ok) {
    return {
      ok: true,
      value: direct.price,
      leg: {
        source: "coinbase",
        endpoint: PROVIDER_ORIGINS.coinbase,
        pair: `${base}-${quote}`,
        derivation: "direct",
        price: toDecimalString(direct.price),
        asOf: null,
        asOfSource: "none",
        convention: COINBASE_CONVENTION,
        literal: direct.literal,
        requestedAt: null,
      },
    };
  }

  const inverse = await coinbaseSpot(quote, base, options);
  if (!inverse.ok) {
    return {
      ok: false,
      reason: `coinbase publishes neither ${base}-${quote} (${direct.reason}) nor its inverse`,
    };
  }
  if (!isPositive(inverse.price)) {
    return {
      ok: false,
      reason: `coinbase answered ${toDecimalString(inverse.price)} for ${quote}-${base}`,
    };
  }
  const inverted = divide(fromInteger(1n), inverse.price, INVERSION_SCALE, "halfEven");
  return {
    ok: true,
    value: inverted,
    leg: {
      source: "coinbase",
      endpoint: PROVIDER_ORIGINS.coinbase,
      pair: `${quote}-${base}`,
      derivation: "inverted",
      price: toDecimalString(inverted),
      asOf: null,
      asOfSource: "none",
      convention: `${COINBASE_CONVENTION}; this figure is 1 divided by the published ${quote}-${base} price of ${toDecimalString(inverse.price)}, rounded half-even to ${INVERSION_SCALE} places`,
      literal: inverse.literal,
      requestedAt: null,
    },
  };
}

type SpotOutcome =
  | { readonly ok: true; readonly price: Fixed; readonly literal: PriceLiteralKind }
  | { readonly ok: false; readonly reason: string };

async function coinbaseSpot(
  base: string,
  quote: string,
  options: RpcOptions,
): Promise<SpotOutcome> {
  const url = new URL(`/v2/prices/${base}-${quote}/spot`, PROVIDER_ORIGINS.coinbase);
  assertKnownOrigin(url);
  const outcome = await getJson(url.toString(), options);
  if (!outcome.ok) return { ok: false, reason: outcome.message };
  const body = outcome.value as { data?: { amount?: unknown; currency?: unknown } };
  const data = body?.data;
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "coinbase's answer carried no data object" };
  }
  if (typeof data.currency === "string" && data.currency.toUpperCase() !== quote) {
    // A quote currency that is not the one asked for is a wrong answer, not a
    // near miss: the number would be right for some other pair.
    return {
      ok: false,
      reason: `coinbase answered in ${data.currency} for a ${base}-${quote} request`,
    };
  }
  try {
    const parsed = fixedFromJson(data.amount, `the ${base}-${quote} spot price`);
    if (!isPositive(parsed.value)) {
      return {
        ok: false,
        reason: `coinbase answered ${toDecimalString(parsed.value)} for ${base}-${quote}`,
      };
    }
    return { ok: true, price: parsed.value, literal: parsed.kind };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function tryProviders(
  providers: ReadonlyArray<ProviderName>,
  base: string,
  quote: string,
  at: string | undefined,
  options: RpcOptions,
  attempts: string[],
): Promise<LegOutcome> {
  for (const provider of providers) {
    const outcome =
      provider === "frankfurter"
        ? await frankfurterLeg(base, quote, at, options)
        : await coinbaseLeg(base, quote, at, options);
    if (outcome.ok) return outcome;
    attempts.push(`${provider} could not quote ${base}/${quote}: ${outcome.reason}`);
  }
  return { ok: false, reason: attempts.join("; ") };
}

/** The intermediates a cross tries when the caller names none. */
export const DEFAULT_CROSS_VIA: ReadonlyArray<string> = Object.freeze(["USD", "EUR"]);

/**
 * Price one asset in another, direct if a provider publishes it, inverted if
 * one publishes the other direction, crossed through an intermediate if
 * neither — and say which of the three happened, every time.
 */
export async function quotePrice(
  request: QuoteRequest,
  options: RpcOptions = {},
): Promise<QuoteValue> {
  const base = normalizeSymbol(request.base, "base");
  const quote = normalizeSymbol(request.quote, "quote");
  const at = normalizeAt(request.at);
  if (base === quote) {
    throw new DefiError(
      `base and quote are both "${base}" — a pair of an asset with itself has no price`,
    );
  }
  const providers = request.providers ?? defaultProviders(base, quote);
  if (providers.length === 0)
    throw new DefiError("providers was empty, so there is nothing to ask");

  const attempts: string[] = [];
  const direct = await tryProviders(providers, base, quote, at, options, attempts);
  if (direct.ok) {
    return {
      value: direct.value,
      quote: {
        base,
        quote,
        price: toDecimalString(direct.value),
        derivation: direct.leg.derivation,
        via: null,
        legs: [direct.leg],
        asOf: direct.leg.asOf,
        notes: direct.leg.asOf === null ? [untimestampedNote(direct.leg.source)] : [],
      },
    };
  }

  if (request.allowCross === false) {
    throw new DefiError(
      `no configured provider publishes ${base}/${quote} and crossing was not allowed: ${attempts.join("; ")}`,
    );
  }

  const candidates =
    request.via === undefined ? DEFAULT_CROSS_VIA : [normalizeSymbol(request.via, "via")];
  for (const raw of candidates) {
    const via = normalizeSymbol(raw, "via");
    if (via === base || via === quote) continue;
    // An explicit provider order applies to the LEGS too. A caller who named
    // one provider did not ask for a price composed out of a different one.
    const firstProviders = request.providers ?? defaultProviders(base, via);
    const secondProviders = request.providers ?? defaultProviders(via, quote);
    const first = await tryProviders(firstProviders, base, via, at, options, attempts);
    if (!first.ok) continue;
    const second = await tryProviders(secondProviders, via, quote, at, options, attempts);
    if (!second.ok) continue;

    // Exact: the legs' scales add, and nothing is rounded until a caller asks
    // for a number of places.
    const value = multiply(first.value, second.value);
    const legs = [first.leg, second.leg];
    const asOf = compositeAsOf(legs);
    const notes = [
      `crossed through ${via}: ${base}/${via} from ${first.leg.source}, ${via}/${quote} from ${second.leg.source}`,
    ];
    if (asOf === null) notes.push(compositeUntimestampedNote(legs));
    else if (legs.some((leg) => leg.asOf !== asOf)) {
      notes.push(
        `the legs carry different dates (${legs.map((l) => l.asOf ?? "none").join(", ")}); the older one is reported`,
      );
    }
    return {
      value,
      quote: {
        base,
        quote,
        price: toDecimalString(value),
        derivation: "cross",
        via,
        legs,
        asOf,
        notes,
      },
    };
  }

  throw new DefiError(
    `could not price ${base}/${quote} directly or through ${candidates.join(" or ")}: ${attempts.join("; ")}`,
  );
}

function untimestampedNote(source: ProviderName): string {
  return `${source} publishes no timestamp with this price, so asOf is null rather than the time the response arrived`;
}

function compositeUntimestampedNote(legs: ReadonlyArray<QuoteLeg>): string {
  const without = legs.filter((leg) => leg.asOf === null).map((leg) => leg.source);
  return `no asOf: ${[...new Set(without)].join(" and ")} publishes none, and a composite price is only as dated as its least dated leg`;
}

function compositeAsOf(legs: ReadonlyArray<QuoteLeg>): string | null {
  let oldest: string | null = null;
  for (const leg of legs) {
    if (leg.asOf === null) return null;
    if (oldest === null || leg.asOf < oldest) oldest = leg.asOf;
  }
  return oldest;
}
