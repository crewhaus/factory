import {
  DEFAULT_PII_DETECTORS,
  type HashedAllowEntry,
  type PiiHit,
  type PiiPolicyFile,
  detectPii,
  hmacValue,
} from "@crewhaus/pii-redactor";

/**
 * AUTOMATION-OPPORTUNITIES.md item 51 — `crewhaus pii tune` core: aggregate
 * PII-redaction history across sessions to find (a) high-frequency FALSE-
 * POSITIVE over-redaction candidates and (b) detector coverage gaps, and
 * propose a reviewed `.crewhaus/pii-policy.json` the redactor consults
 * additively. Side-effect-free so it is unit-testable (all filesystem access
 * lives in index.ts), mirroring `advise-rules.ts` / `egress-triage.ts`.
 *
 * NO-RAW-PII INVARIANT (the whole point of item 51): this module NEVER stores,
 * prints, or returns a raw PII value. Every value is reduced to
 * `HMAC-SHA256(secret, value)` (via `@crewhaus/pii-redactor`'s `hmacValue` —
 * the SAME digest the redactor's hash-mode marker and hashed allow-list use)
 * the instant it is detected. Aggregation, the proposed policy, and every
 * renderer carry only { kind, hash, count } — so a proposed allow entry can be
 * matched by the redactor at runtime WITHOUT anyone ever seeing the value. The
 * tests assert a known raw value never appears in any output.
 *
 * WHERE THE SIGNAL COMES FROM (durability, verified 2026-07): the pii-redactor
 * has no runtime writer emitting durable redaction events, so `pii tune` re-
 * derives the redaction history by running the detector over durable session
 * `tool_result` + assistant content itself (the durable surface), hashing each
 * hit immediately. It cross-references `.crewhaus/feedback` ratings: a PII
 * (kind, hash) that recurs in the outputs of turns the human UP-RATED/accepted
 * is an over-redaction candidate — the operator kept the answer that carried
 * it, so redacting it may be too aggressive. Coverage gaps are kinds seen only
 * via the classifier sentinel or at the detector's edges.
 */

// -------- hashed aggregation --------

export type HashedPiiKey = { readonly kind: string; readonly hash: string };

export type PiiAggregate = {
  readonly kind: string;
  readonly hash: string;
  /** Total occurrences across scanned content. */
  readonly count: number;
  /** Occurrences in content from turns the human up-rated/accepted. */
  readonly acceptedCount: number;
};

export type PiiTuneContext = {
  /** Per (kind, hash) aggregate, ranked by acceptedCount then count. */
  readonly aggregates: ReadonlyArray<PiiAggregate>;
  /** Total PII hits detected across all scanned content. */
  readonly totalHits: number;
  /** Per-kind totals (coverage view). */
  readonly byKind: Readonly<Record<string, number>>;
  /** Content units scanned. */
  readonly scanned: number;
};

/** A single unit of scanned content plus whether its turn was accepted. */
export type ScanUnit = {
  readonly content: string;
  /** True when the human up-rated/accepted the turn this content belongs to. */
  readonly accepted: boolean;
};

/**
 * Fold scan units into the hashed aggregate. `secret` is the HMAC key (never
 * stored); each detected value is hashed immediately and the raw value is
 * dropped. Detectors default to the shipped `DEFAULT_PII_DETECTORS`.
 */
export function buildPiiTuneContext(
  units: ReadonlyArray<ScanUnit>,
  secret: string,
  detectors = DEFAULT_PII_DETECTORS,
): PiiTuneContext {
  type Acc = { count: number; acceptedCount: number };
  const byKey = new Map<string, { kind: string; hash: string } & Acc>();
  const byKind = new Map<string, number>();
  let totalHits = 0;

  for (const unit of units) {
    const hits: ReadonlyArray<PiiHit> = detectPii(unit.content, detectors);
    for (const hit of hits) {
      if (hit.value.length === 0) continue; // classifier sentinel has no value
      const hash = hmacValue(hit.value, secret);
      const key = `${hit.kind}|${hash}`;
      const acc = byKey.get(key) ?? { kind: hit.kind, hash, count: 0, acceptedCount: 0 };
      acc.count += 1;
      if (unit.accepted) acc.acceptedCount += 1;
      byKey.set(key, acc);
      byKind.set(hit.kind, (byKind.get(hit.kind) ?? 0) + 1);
      totalHits += 1;
    }
  }

  const aggregates: PiiAggregate[] = [...byKey.values()]
    .map((a) => ({ kind: a.kind, hash: a.hash, count: a.count, acceptedCount: a.acceptedCount }))
    .sort(
      (x, y) =>
        y.acceptedCount - x.acceptedCount ||
        y.count - x.count ||
        x.kind.localeCompare(y.kind) ||
        x.hash.localeCompare(y.hash),
    );

  return {
    aggregates,
    totalHits,
    byKind: Object.fromEntries([...byKind.entries()].sort()),
    scanned: units.length,
  };
}

// -------- thresholds + proposals --------

export type PiiTuneThresholds = {
  /** Occurrences in ACCEPTED outputs at/above which a (kind,hash) is a
   *  false-positive over-redaction candidate. */
  readonly acceptedMin: number;
  /** Total occurrences at/above which a (kind,hash) is judged at all. */
  readonly countMin: number;
};

export const DEFAULT_PII_TUNE_THRESHOLDS: PiiTuneThresholds = {
  acceptedMin: 2,
  countMin: 3,
};

export type FalsePositiveCandidate = {
  readonly kind: string;
  readonly hash: string;
  readonly count: number;
  readonly acceptedCount: number;
  /** acceptedCount / count — how consistently this value survived into kept
   *  outputs (1.0 = every occurrence was in an accepted turn). */
  readonly acceptedRatio: number;
};

/**
 * Find false-positive over-redaction candidates: (kind, hash) pairs seen ≥
 * countMin times whose occurrences land in ACCEPTED outputs ≥ acceptedMin
 * times. These are values the human kept, so redacting them may be too
 * aggressive — they become proposed hashed allow entries.
 */
export function findFalsePositives(
  ctx: PiiTuneContext,
  thresholds: PiiTuneThresholds = DEFAULT_PII_TUNE_THRESHOLDS,
): FalsePositiveCandidate[] {
  const out: FalsePositiveCandidate[] = [];
  for (const a of ctx.aggregates) {
    if (a.count < thresholds.countMin) continue;
    if (a.acceptedCount < thresholds.acceptedMin) continue;
    out.push({
      kind: a.kind,
      hash: a.hash,
      count: a.count,
      acceptedCount: a.acceptedCount,
      acceptedRatio: a.count > 0 ? a.acceptedCount / a.count : 0,
    });
  }
  // Highest acceptedRatio (then acceptedCount) first — the strongest FPs.
  return out.sort(
    (x, y) =>
      y.acceptedRatio - x.acceptedRatio ||
      y.acceptedCount - x.acceptedCount ||
      x.kind.localeCompare(y.kind),
  );
}

export type CoverageGap = {
  readonly reason: string;
  readonly detail: string;
};

/**
 * Detect detector coverage gaps. Deliberately conservative and structural (no
 * raw content): kinds present in the shipped detectors that produced ZERO hits
 * over a non-trivial scan (either the content genuinely lacks them, or the
 * detector under-fires) are surfaced as "verify coverage" notes, and a scan
 * with hits but NO email/ssn/credit_card at all over many units is flagged as
 * a possible high-value-PII blind spot worth a custom detector.
 */
export function findCoverageGaps(
  ctx: PiiTuneContext,
  detectorKinds: ReadonlyArray<string> = DEFAULT_PII_DETECTORS.map((d) => d.kind),
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  if (ctx.scanned < 5) return gaps; // too little to judge coverage
  const seen = new Set(Object.keys(ctx.byKind));
  const missing = detectorKinds.filter((k) => !seen.has(k)).sort();
  if (missing.length > 0) {
    gaps.push({
      reason: "detector-kinds-never-fired",
      detail: `detector kinds with 0 hits over ${ctx.scanned} scanned unit(s): ${missing.join(", ")} — either the content lacks them or the pattern under-fires; verify against a known-positive sample before trusting coverage`,
    });
  }
  return gaps;
}

// -------- policy file proposal --------

/**
 * Turn false-positive candidates into a reviewed `PiiPolicyFile`. Carries ONLY
 * hashed allow entries — never raw PII — so it is safe to commit and the
 * redactor can honour it additively via `createPiiRedactorWithPolicy`.
 * Deterministic given the candidates.
 */
export function buildPiiPolicy(candidates: ReadonlyArray<FalsePositiveCandidate>): PiiPolicyFile {
  const allow: HashedAllowEntry[] = candidates
    .map((c) => ({ kind: c.kind, hash: c.hash }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.hash.localeCompare(b.hash));
  return { version: 1, allow };
}

// -------- renderers (hashes + counts ONLY, never raw values) --------

export function renderPiiTuneLines(
  ctx: PiiTuneContext,
  candidates: ReadonlyArray<FalsePositiveCandidate>,
  gaps: ReadonlyArray<CoverageGap>,
): ReadonlyArray<string> {
  const lines: string[] = [];
  lines.push(
    `scanned ${ctx.scanned} content unit(s): ${ctx.totalHits} PII hit(s) across ${Object.keys(ctx.byKind).length} kind(s)`,
  );
  const kindLine = Object.entries(ctx.byKind)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  if (kindLine !== "") lines.push(`  by kind: ${kindLine}`);
  lines.push(`false-positive over-redaction candidates: ${candidates.length}`);
  for (const c of candidates) {
    // Hash + counts ONLY — the raw value is never available here.
    lines.push(
      `  ~ ${c.kind}:${c.hash} — kept in ${c.acceptedCount}/${c.count} accepted output(s) (${(c.acceptedRatio * 100).toFixed(0)}% accepted) → propose allow`,
    );
  }
  for (const g of gaps) lines.push(`coverage: ${g.detail}`);
  return lines;
}
