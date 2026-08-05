#!/usr/bin/env bun
/**
 * Pricing audit — the standing guard on `DEFAULT_PRICING` / `DEFAULT_CAPABILITIES`.
 *
 * WHY THIS EXISTS
 * ---------------
 * A pricing row that is wrong fails silently. `resolvePricing` returns
 * `undefined` for an id no row matches, and `cost-tracker` treats that as a
 * pricing MISS and charges **$0** rather than throwing — deliberately, so an
 * unmapped id never crashes an in-flight run. The consequence is that the two
 * worst outcomes are both invisible:
 *
 *   - a current model that no row covers bills nothing, forever;
 *   - a current model that falls through to a legacy family base bills at the
 *     legacy rate (Opus 4.5 inheriting the `claude-opus-4` base billed $15/$75
 *     against a real $5/$25 — a 3x overcharge that every other check passes).
 *
 * Nothing in the test suite caught either class, because `feed.test.ts`
 * deliberately pins fixed clocks so wall-clock drift can never turn CI red.
 * That is the right call for that file and it is exactly why staleness needs a
 * separate home: this one.
 *
 * SHAPE
 * -----
 * Pure core + thin IO, per `release-prep.ts`. Every check is a pure function of
 * the committed tables plus an injected `now`, so the co-located test drives it
 * with a PINNED date and the suite stays hermetic. Only the CLI entrypoint
 * reads the wall clock, and only the scheduled workflow runs the CLI.
 *
 * Run: `bun scripts/pricing-audit.ts [--now YYYY-MM-DD] [--max-age-days N]`
 * Exit 0 = clean (warnings allowed), 1 = at least one error.
 */
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_PRICING,
  KNOWN_SUNSETS,
  type PricingTable,
  type ProviderId,
  classifyPricingStaleness,
  resolvePricing,
} from "../packages/cost-tracker/src/index";

export type Severity = "error" | "warn";

export type Finding = {
  readonly check: string;
  readonly severity: Severity;
  readonly message: string;
};

/**
 * Freshness threshold in days. 120 mirrors the value already hardcoded at
 * `apps/cli/src/index.ts` (`pricing show`) and `model-scan.ts`, so there is
 * exactly one number to change if the policy moves. Warn at half of it.
 */
export const MAX_AGE_DAYS = 120;

/**
 * Golden prices for models the repo actively ships, each cross-checked against
 * TWO independent public datasets on the date below before being pinned here.
 *
 * This is the check that would have caught the real drift: `gemini-2.5-pro`
 * sat at a $5 output rate against a real $10 (a 2x undercharge) and
 * `gemini-2.5-flash` at $0.15/$0.60 against $0.30/$2.50, both silently, for as
 * long as anyone had been looking.
 *
 * It is deliberately a PINNED EXPECTATION, not a live fetch: a test that
 * reaches the network is a test that fails on a plane, and a billing table
 * should never change because an upstream JSON moved while nobody was reading.
 * `pricing-refresh.ts` is the half that talks to the network; it proposes, a
 * human disposes, and the accepted numbers land here.
 *
 * WHEN A PRICE LEGITIMATELY CHANGES: update the row in `pricing.ts` AND the
 * golden here in the same commit, and move `VERIFIED_ON` forward.
 */
export const VERIFIED_ON = "2026-07-31";

export const GOLDEN_PRICES: ReadonlyArray<{
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly inputPer1M: number;
  readonly outputPer1M: number;
}> = [
  // --- anthropic ---
  { provider: "anthropic", modelId: "claude-opus-5", inputPer1M: 5.0, outputPer1M: 25.0 },
  { provider: "anthropic", modelId: "claude-opus-4-8", inputPer1M: 5.0, outputPer1M: 25.0 },
  { provider: "anthropic", modelId: "claude-opus-4-5", inputPer1M: 5.0, outputPer1M: 25.0 },
  { provider: "anthropic", modelId: "claude-sonnet-4-6", inputPer1M: 3.0, outputPer1M: 15.0 },
  { provider: "anthropic", modelId: "claude-haiku-4-5", inputPer1M: 1.0, outputPer1M: 5.0 },
  { provider: "anthropic", modelId: "claude-fable-5", inputPer1M: 10.0, outputPer1M: 50.0 },
  // --- openai ---
  { provider: "openai", modelId: "gpt-5.1", inputPer1M: 1.25, outputPer1M: 10.0 },
  { provider: "openai", modelId: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10.0 },
  { provider: "openai", modelId: "o3", inputPer1M: 2.0, outputPer1M: 8.0 },
  { provider: "openai", modelId: "o4-mini", inputPer1M: 1.1, outputPer1M: 4.4 },
  // --- gemini ---
  { provider: "gemini", modelId: "gemini-3-pro", inputPer1M: 2.0, outputPer1M: 12.0 },
  { provider: "gemini", modelId: "gemini-2.5-pro", inputPer1M: 1.25, outputPer1M: 10.0 },
  { provider: "gemini", modelId: "gemini-2.5-flash", inputPer1M: 0.3, outputPer1M: 2.5 },
  { provider: "gemini", modelId: "gemini-2.5-flash-lite", inputPer1M: 0.1, outputPer1M: 0.4 },
  // --- bedrock ---
  { provider: "bedrock", modelId: "anthropic.claude-opus-5", inputPer1M: 5.0, outputPer1M: 25.0 },
  {
    provider: "bedrock",
    modelId: "anthropic.claude-haiku-4-5",
    inputPer1M: 1.0,
    outputPer1M: 5.0,
  },
];

/**
 * Every provider must keep a bare-family catch-all so that a model released
 * tomorrow prices at the current-generation rate instead of $0. Bedrock had
 * none, which is why it was the worse half: an id no row spelled out matched
 * NOTHING there, while the same gap on the first-party side merely mispriced.
 */
export const REQUIRED_FALLBACKS: ReadonlyArray<{
  readonly provider: ProviderId;
  readonly prefixes: readonly string[];
}> = [
  { provider: "anthropic", prefixes: ["claude-opus", "claude-sonnet", "claude-haiku"] },
  {
    provider: "bedrock",
    prefixes: ["anthropic.claude-opus", "anthropic.claude-sonnet", "anthropic.claude-haiku"],
  },
];

/** A future-major probe per family — the id a next release would plausibly use. */
const NEXT_MAJOR_PROBES: ReadonlyArray<{ provider: ProviderId; modelId: string }> = [
  { provider: "anthropic", modelId: "claude-opus-9" },
  { provider: "anthropic", modelId: "claude-sonnet-9" },
  { provider: "bedrock", modelId: "anthropic.claude-opus-9" },
  { provider: "bedrock", modelId: "anthropic.claude-haiku-9" },
];

/** GOLDEN — pinned prices still hold. */
export function checkGolden(table: PricingTable = DEFAULT_PRICING): Finding[] {
  const out: Finding[] = [];
  for (const g of GOLDEN_PRICES) {
    const row = resolvePricing(table, g.provider, g.modelId);
    if (row === undefined) {
      out.push({
        check: "golden",
        severity: "error",
        message: `${g.provider}/${g.modelId} resolves to NO pricing row — it bills $0. Add a row in pricing.ts.`,
      });
      continue;
    }
    if (row.inputPer1M !== g.inputPer1M || row.outputPer1M !== g.outputPer1M) {
      out.push({
        check: "golden",
        severity: "error",
        message: `${g.provider}/${g.modelId} prices ${row.inputPer1M}/${row.outputPer1M} but the golden (two-source verified ${VERIFIED_ON}) is ${g.inputPer1M}/${g.outputPer1M}. If the price genuinely moved, update pricing.ts AND the golden together and bump VERIFIED_ON.`,
      });
    }
  }
  return out;
}

/** FALLBACK — family catch-alls exist and actually catch a future major. */
export function checkFallbacks(table: PricingTable = DEFAULT_PRICING): Finding[] {
  const out: Finding[] = [];
  for (const { provider, prefixes } of REQUIRED_FALLBACKS) {
    const declared = table.providers[provider] ?? {};
    for (const p of prefixes) {
      if (!(p in declared)) {
        out.push({
          check: "fallback",
          severity: "error",
          message: `${provider} is missing the bare-family fallback row "${p}" — a future ${p}-* id would bill $0.`,
        });
      }
    }
  }
  for (const probe of NEXT_MAJOR_PROBES) {
    if (resolvePricing(table, probe.provider, probe.modelId) === undefined) {
      out.push({
        check: "fallback",
        severity: "error",
        message: `${probe.provider}/${probe.modelId} (next-major probe) resolves to NO row — it would bill $0.`,
      });
    }
  }
  return out;
}

/**
 * COHERENCE — the three tables' headers all assert they are maintained
 * one-to-one. Nothing enforced it, and `bedrock/meta.llama3-1` had
 * capabilities but no resolvable price: any candidate enumerated at that key
 * priced at $0.
 */
export function checkCoherence(table: PricingTable = DEFAULT_PRICING): Finding[] {
  const out: Finding[] = [];
  const caps = DEFAULT_CAPABILITIES.providers ?? {};
  for (const [provider, capTable] of Object.entries(caps)) {
    for (const key of Object.keys(capTable as Record<string, unknown>)) {
      if (resolvePricing(table, provider as ProviderId, key) === undefined) {
        out.push({
          check: "coherence",
          severity: "error",
          message: `capabilities key ${provider}/"${key}" has no resolvable pricing row — anything enumerated there bills $0.`,
        });
      }
    }
  }
  return out;
}

/**
 * SUNSET — a retired model keeping a pricing row is fine and intended
 * (historical audit-log re-aggregation must still resolve), so that is a WARN.
 * A sunset whose declared `replacement` does not itself price is an ERROR:
 * that is the migration target, and it billing $0 defeats the entry.
 */
export function checkSunsets(now: Date, table: PricingTable = DEFAULT_PRICING): Finding[] {
  const out: Finding[] = [];
  const today = now.toISOString().slice(0, 10);
  for (const [provider, entries] of Object.entries(KNOWN_SUNSETS)) {
    for (const e of entries) {
      if (e.retiresOn <= today && resolvePricing(table, provider as ProviderId, e.modelIdPrefix)) {
        out.push({
          check: "sunset",
          severity: "warn",
          message: `${provider}/${e.modelIdPrefix} retired ${e.retiresOn} and still carries a live pricing row (kept for historical re-aggregation — drop it only if no audit log references it).`,
        });
      }
      if (
        e.replacement !== undefined &&
        resolvePricing(table, provider as ProviderId, e.replacement) === undefined
      ) {
        out.push({
          check: "sunset",
          severity: "error",
          message: `${provider}/${e.modelIdPrefix} names replacement "${e.replacement}", which resolves to NO pricing row — the migration target would bill $0.`,
        });
      }
    }
  }
  return out;
}

/**
 * FRESHNESS — classify `DEFAULT_PRICING` DIRECTLY, never via
 * `loadUserPricing()`. On a CI runner an empty `~` makes that return
 * `DEFAULT_PRICING` by accident rather than by intent, and on a dev machine
 * any installed feed masks a stale built-in entirely.
 */
export function checkFreshness(now: Date, maxAgeDays = MAX_AGE_DAYS): Finding[] {
  const status = classifyPricingStaleness(DEFAULT_PRICING, now, maxAgeDays);
  if (status.stale) {
    return [{ check: "freshness", severity: "error", message: status.reason }];
  }
  const halfway = classifyPricingStaleness(DEFAULT_PRICING, now, Math.floor(maxAgeDays / 2));
  if (halfway.stale) {
    return [
      {
        check: "freshness",
        severity: "warn",
        message: `pricing table v${DEFAULT_PRICING.version} is over ${Math.floor(maxAgeDays / 2)} days old — run \`bun scripts/pricing-refresh.ts\` to check for upstream drift.`,
      },
    ];
  }
  return [];
}

/** Run every hermetic check. `now` is injected so the test suite stays clock-free. */
export function auditPricing(
  now: Date,
  opts: { readonly maxAgeDays?: number; readonly includeFreshness?: boolean } = {},
): Finding[] {
  return [
    ...checkGolden(),
    ...checkFallbacks(),
    ...checkCoherence(),
    ...checkSunsets(now),
    ...(opts.includeFreshness === false ? [] : checkFreshness(now, opts.maxAgeDays)),
  ];
}

function parseArgs(argv: readonly string[]): { now: Date; maxAgeDays: number } {
  let now = new Date();
  let maxAgeDays = MAX_AGE_DAYS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--now" && argv[i + 1] !== undefined) {
      const parsed = new Date(`${argv[++i]}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) {
        console.error("✗ --now must be YYYY-MM-DD");
        process.exit(1);
      }
      now = parsed;
    } else if (argv[i] === "--max-age-days" && argv[i + 1] !== undefined) {
      maxAgeDays = Number(argv[++i]);
    }
  }
  return { now, maxAgeDays };
}

if (import.meta.main) {
  const { now, maxAgeDays } = parseArgs(process.argv.slice(2));
  const findings = auditPricing(now, { maxAgeDays });
  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");

  for (const w of warns) console.log(`~ [${w.check}] ${w.message}`);
  for (const e of errors) console.log(`✗ [${e.check}] ${e.message}`);
  if (findings.length === 0) console.log("✓ pricing audit clean");

  console.log(
    `\nPricing audit — table v${DEFAULT_PRICING.version}, goldens verified ${VERIFIED_ON}. Errors: ${errors.length}  Warnings: ${warns.length}`,
  );
  if (errors.length > 0) {
    console.log(
      `::error title=Pricing audit failed::${errors.length} pricing error(s). A miss bills $0 and a misresolution bills the wrong rate — both silently.`,
    );
    process.exit(1);
  }
}
