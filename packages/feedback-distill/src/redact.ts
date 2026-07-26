/**
 * The shared sync PII/secret redaction every rating/mining ingestion surface
 * applies before free text can land in a dataset (B23).
 *
 * Lives here — beside `distill()` — because the daemon janitor step (D39)
 * runs unattended in a COMPILED bundle and must redact exactly the way the
 * `crewhaus distill` / `dataset mine` / `dataset synthesize` toolchain does.
 * `apps/cli`'s `dataset-audit.ts` / `dataset-mine.ts` re-export these, so
 * there is one detector set and one algorithm for the whole codebase.
 */
import {
  DEFAULT_PII_DETECTORS,
  type PiiDetector,
  type PiiHit,
  detectPii,
} from "@crewhaus/pii-redactor";

/**
 * Credential-shaped token detector. The shapes are the SAME patterns used for
 * credential masking elsewhere in the repo (`packages/ir/src/redact.ts` /
 * `packages/spec-patch/src/redact.ts`), reused rather than reinvented so the
 * whole codebase agrees on what a "credential-shaped token" looks like:
 *
 *   - `sk-…`            OpenAI/Anthropic/Stripe-style secret keys
 *   - `gh[oprsu]_…`      GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
 *   - `xox[abprs]-…`     Slack tokens
 *   - `AKIA…`            AWS access key ids
 *   - `Bearer <token>`   bearer auth headers pasted into prose
 *   - a 32+ char opaque token preceded by key/token/secret/password/
 *     credential context (so ordinary long ids/hashes in prose survive)
 *
 * A single `PiiDetector` combining all of the above via alternation, given
 * `detectPii`/`PiiRedactor` only accept one `regex` per detector kind.
 */
export const SECRET_KEY_DETECTOR: PiiDetector = {
  kind: "secret",
  regex:
    /\bsk-[A-Za-z0-9_-]{8,}\b|\bgh[oprsu]_[A-Za-z0-9]{16,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bAKIA[A-Z0-9]{12,}\b|\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*|\b(?:api[-_ ]?)?(?:key|token|secret|password|credential)s?\b["'\s:=-]{0,5}[A-Za-z0-9+/_-]{32,}/gi,
};

/** The full ingestion detector set: the shared PII defaults plus the
 *  secret/API-key detector above. One source of truth for "what the rating,
 *  mining and synthesis surfaces redact". */
export const INGESTION_PII_DETECTORS: ReadonlyArray<PiiDetector> = [
  ...DEFAULT_PII_DETECTORS,
  SECRET_KEY_DETECTOR,
];

/** Dedupe hits by (kind, value) in first-seen order — the same collapse
 *  `PiiRedactor.redact` applies so multiple detector passes over the same
 *  span never redact (or count) it twice. */
export function dedupePiiHits(hits: ReadonlyArray<PiiHit>): PiiHit[] {
  const seen = new Set<string>();
  const out: PiiHit[] = [];
  for (const h of hits) {
    const key = `${h.kind}${h.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * Deterministic SYNC redaction over the shared detector set — the regex-only
 * mirror of `createPiiRedactor({ regexDetectors: INGESTION_PII_DETECTORS })
 * .redact(text).text`: deduped hits, empty-value sentinels dropped, wider
 * matches replaced first (so an SSN-shaped substring inside a longer token
 * never splits its enclosing match), each occurrence replaced with the
 * redactor's `[REDACTED:<kind>]` marker. Same input → same output, and text
 * with no hits comes back byte-identical.
 */
export function redactText(
  text: string,
  detectors: ReadonlyArray<PiiDetector> = INGESTION_PII_DETECTORS,
): string {
  const hits = dedupePiiHits(detectPii(text, detectors)).filter((h) => h.value.length > 0);
  if (hits.length === 0) return text;
  const sorted = [...hits].sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const hit of sorted) {
    out = out.split(hit.value).join(`[REDACTED:${hit.kind}]`);
  }
  return out;
}
