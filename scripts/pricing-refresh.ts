#!/usr/bin/env bun
/**
 * Pricing refresh — propose, never apply.
 *
 * Fetches two INDEPENDENT public pricing datasets, compares them against the
 * committed `DEFAULT_PRICING`, and prints a reviewable drift report. It never
 * writes `pricing.ts`. A human moves numbers, and `scripts/pricing-audit.ts`'s
 * goldens are the record of what a human accepted.
 *
 * WHY TWO SOURCES, AND WHY EXACT-MATCH ONLY
 * -----------------------------------------
 * Both rules were paid for empirically while building this.
 *
 * Two sources: a single dataset is wrong often enough to matter. LiteLLM
 * carries `gemini-1.5-flash` with an output cost of exactly 0 — a free-tier
 * artifact that, auto-applied, would have zeroed a live row. Requiring a
 * second, independently-maintained source to agree kills that class outright.
 *
 * Exact-match only: the obvious implementation resolves a committed prefix by
 * scanning the dataset for keys that start with it. That is what produced the
 * one genuinely dangerous false positive in testing — `mistral.mistral-large`
 * prefix-matched a *different* variant (Mistral Large 2407 / Large 3, priced
 * $1.50–$4.50) and reported the correct $4.00 row as 2x drift. AWS's own price
 * list confirmed the committed value was right. Auto-applying that "fix" would
 * have corrupted a correct row. So: an exact key match or nothing. A prefix row
 * with no exact counterpart is reported as UNMATCHED for a human to look at,
 * never silently resolved to a neighbour.
 *
 * Rows deliberately excluded from drift proposals:
 *   - bare-family fallbacks (`claude-opus`, `anthropic.claude-sonnet`, …).
 *     These are semantic catch-alls, not models; no dataset has a counterpart
 *     and "drift" against one is meaningless.
 *   - anything already retired per `KNOWN_SUNSETS`. Retired rows are kept on
 *     purpose so historical audit-log re-aggregation still resolves, and they
 *     legitimately hold prices no current feed still lists.
 *
 * Run: `bun scripts/pricing-refresh.ts [--json] [--fixture <dir>]`
 * Exit 0 = no actionable drift, 1 = drift a human should look at, 2 = fetch failed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PRICING,
  KNOWN_SUNSETS,
  type PricingTable,
  type ProviderId,
} from "../packages/cost-tracker/src/index";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

/** $ per million, input/output. */
export type Quote = { readonly inputPer1M: number; readonly outputPer1M: number };
export type SourceIndex = ReadonlyMap<string, Quote>;

export type Verdict =
  | "ok"
  | "drift"
  | "sources-disagree"
  | "unmatched"
  | "excluded-fallback"
  | "excluded-retired";

export type Row = {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly committed: Quote;
  readonly litellm?: Quote;
  readonly openrouter?: Quote;
  readonly verdict: Verdict;
  readonly note: string;
};

/** Version separators differ across datasets (`4-5` vs `4.5`); fold them. */
export function normalizeKey(k: string): string {
  return k.replace(/\./g, "-").toLowerCase();
}

/** A row with no version digits is a bare-family catch-all, not a model. */
export function isFamilyFallback(modelId: string): boolean {
  return !/\d/.test(modelId.split(".").pop() ?? modelId);
}

export function isRetired(provider: ProviderId, modelId: string, today: string): boolean {
  const entries = KNOWN_SUNSETS[provider] ?? [];
  return entries.some(
    (e) =>
      e.retiresOn <= today &&
      (modelId === e.modelIdPrefix || modelId.startsWith(`${e.modelIdPrefix}-`)),
  );
}

/** Build the per-provider candidate keys to try, most specific first. */
export function candidateKeys(provider: ProviderId, modelId: string): string[] {
  const n = normalizeKey(modelId);
  switch (provider) {
    case "anthropic":
      return [n];
    case "openai":
      return [n];
    case "gemini":
      // The Developer API namespace first: it is the surface a bare
      // `gemini-*` spec string actually calls.
      return [`gemini/${n}`, n];
    case "bedrock":
      return [n];
    default:
      return [n];
  }
}

export function openRouterKeys(provider: ProviderId, modelId: string): string[] {
  const n = normalizeKey(modelId);
  switch (provider) {
    case "anthropic":
      return [`anthropic/${n}`];
    case "openai":
      return [`openai/${n}`];
    case "gemini":
      return [`google/${n}`];
    // OpenRouter does not namespace Bedrock deployments; no counterpart.
    default:
      return [];
  }
}

function lookup(index: SourceIndex, keys: readonly string[]): Quote | undefined {
  for (const k of keys) {
    const hit = index.get(k);
    if (hit) return hit;
  }
  return undefined;
}

const EPS = 1e-9;
function same(a: Quote, b: Quote): boolean {
  return (
    Math.abs(a.inputPer1M - b.inputPer1M) < EPS && Math.abs(a.outputPer1M - b.outputPer1M) < EPS
  );
}

/** Pure core: classify every committed row against the two indexes. */
export function compare(
  table: PricingTable,
  litellm: SourceIndex,
  openrouter: SourceIndex,
  today: string,
): Row[] {
  const out: Row[] = [];
  for (const [provider, rows] of Object.entries(table.providers)) {
    for (const [modelId, committed] of Object.entries(rows as Record<string, Quote>)) {
      const p = provider as ProviderId;
      const base = { provider: p, modelId, committed } as const;

      if (isFamilyFallback(modelId)) {
        out.push({
          ...base,
          verdict: "excluded-fallback",
          note: "bare-family catch-all — no dataset counterpart by design",
        });
        continue;
      }
      if (isRetired(p, modelId, today)) {
        out.push({
          ...base,
          verdict: "excluded-retired",
          note: "retired per KNOWN_SUNSETS — row kept for historical re-aggregation",
        });
        continue;
      }

      const l = lookup(litellm, candidateKeys(p, modelId));
      const o = lookup(openrouter, openRouterKeys(p, modelId));
      const found = [l, o].filter((q): q is Quote => q !== undefined);

      if (found.length === 0) {
        out.push({
          ...base,
          verdict: "unmatched",
          note: "no EXACT key in either dataset — resolve by hand; never prefix-guess a neighbour",
        });
        continue;
      }
      if (found.length === 2 && !same(found[0] as Quote, found[1] as Quote)) {
        out.push({
          ...base,
          ...(l ? { litellm: l } : {}),
          ...(o ? { openrouter: o } : {}),
          verdict: "sources-disagree",
          note: "the two datasets disagree — do not act on either without a third check",
        });
        continue;
      }
      const ref = found[0] as Quote;
      const single = found.length === 1;
      out.push({
        ...base,
        ...(l ? { litellm: l } : {}),
        ...(o ? { openrouter: o } : {}),
        verdict: same(committed, ref) ? "ok" : "drift",
        note: single ? "single source only — corroborate before acting" : "two sources agree",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- IO layer

export function indexLiteLLM(doc: Record<string, unknown>): SourceIndex {
  const m = new Map<string, Quote>();
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v !== "object" || v === null) continue;
    const r = v as Record<string, unknown>;
    const i = r["input_cost_per_token"];
    const o = r["output_cost_per_token"];
    if (typeof i !== "number" || typeof o !== "number") continue;
    m.set(normalizeKey(k), { inputPer1M: i * 1e6, outputPer1M: o * 1e6 });
  }
  return m;
}

export function indexOpenRouter(doc: { data?: unknown }): SourceIndex {
  const m = new Map<string, Quote>();
  const data = Array.isArray(doc.data) ? doc.data : [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = e["id"];
    const pricing = e["pricing"];
    if (typeof id !== "string" || typeof pricing !== "object" || pricing === null) continue;
    const p = pricing as Record<string, unknown>;
    const i = Number(p["prompt"]);
    const o = Number(p["completion"]);
    if (!Number.isFinite(i) || !Number.isFinite(o)) continue;
    m.set(normalizeKey(id), { inputPer1M: i * 1e6, outputPer1M: o * 1e6 });
  }
  return m;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function fmt(q?: Quote): string {
  return q ? `${q.inputPer1M}/${q.outputPer1M}` : "—";
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const fixtureAt = argv.indexOf("--fixture");
  const today = new Date().toISOString().slice(0, 10);

  let litellmDoc: unknown;
  let openrouterDoc: unknown;
  try {
    if (fixtureAt !== -1) {
      const dir = argv[fixtureAt + 1] as string;
      litellmDoc = JSON.parse(readFileSync(join(dir, "litellm.json"), "utf8"));
      openrouterDoc = JSON.parse(readFileSync(join(dir, "openrouter.json"), "utf8"));
    } else {
      [litellmDoc, openrouterDoc] = await Promise.all([
        fetchJson(LITELLM_URL),
        fetchJson(OPENROUTER_URL),
      ]);
    }
  } catch (err) {
    // Fail loudly. A refresh that silently reports "no drift" because the
    // network was down is worse than one that does not run at all.
    console.error(`✗ could not fetch pricing sources: ${(err as Error).message}`);
    console.error("::error title=Pricing refresh could not fetch sources::see log");
    process.exit(2);
  }

  const rows = compare(
    DEFAULT_PRICING,
    indexLiteLLM(litellmDoc as Record<string, unknown>),
    indexOpenRouter(openrouterDoc as { data?: unknown }),
    today,
  );

  const drift = rows.filter((r) => r.verdict === "drift");
  const disagree = rows.filter((r) => r.verdict === "sources-disagree");
  const unmatched = rows.filter((r) => r.verdict === "unmatched");
  const ok = rows.filter((r) => r.verdict === "ok");

  if (asJson) {
    console.log(JSON.stringify({ table: DEFAULT_PRICING.version, today, rows }, null, 2));
  } else {
    console.log(
      `Pricing refresh — committed table v${DEFAULT_PRICING.version}, checked ${today}\n`,
    );
    for (const r of drift) {
      console.log(
        `✗ DRIFT   ${r.provider}/${r.modelId}\n    committed ${fmt(r.committed)}  litellm ${fmt(r.litellm)}  openrouter ${fmt(r.openrouter)}\n    ${r.note}`,
      );
    }
    for (const r of disagree) {
      console.log(
        `~ SPLIT   ${r.provider}/${r.modelId}  litellm ${fmt(r.litellm)} vs openrouter ${fmt(r.openrouter)} — ${r.note}`,
      );
    }
    for (const r of unmatched) {
      console.log(
        `~ NOMATCH ${r.provider}/${r.modelId} (committed ${fmt(r.committed)}) — ${r.note}`,
      );
    }
    console.log(
      `\nok=${ok.length}  drift=${drift.length}  sources-disagree=${disagree.length}  unmatched=${unmatched.length}  excluded=${rows.length - ok.length - drift.length - disagree.length - unmatched.length}`,
    );
    if (drift.length > 0) {
      console.log(
        "\nNothing was changed. Review each DRIFT row against the provider's own pricing page,\n" +
          "then update pricing.ts AND the goldens in scripts/pricing-audit.ts together.",
      );
    }
  }

  if (drift.length > 0) {
    console.log(
      `::error title=Pricing drift detected::${drift.length} row(s) differ from two agreeing upstream sources`,
    );
    process.exit(1);
  }
}
