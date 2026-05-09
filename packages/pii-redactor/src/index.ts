import { createHash, createHmac } from "node:crypto";
import { CrewhausError } from "@crewhaus/errors";
import {
  type Classifier,
  DEFAULT_PII_DETECTORS,
  type PiiDetector,
  type PiiHit,
  detectPii as detectPiiRegex,
} from "@crewhaus/grader-safety-classifiers";

/**
 * Catalog R17 `pii-redactor` — Section 39 outbound + audit redaction.
 *
 * Composable detectors, evaluated in order:
 *   1. regex      — reuses §38 `DEFAULT_PII_DETECTORS` (SSN, CC, phone,
 *                   email, IBAN); customizable per-call
 *   2. classifier — caller-supplied §38 `Classifier` (typically
 *                   `MockPiiClassifier` for tests; production uses an
 *                   ML classifier — fastText, NER, etc.)
 *   3. policy     — per-tenant allow-list of fields that should NEVER
 *                   match (overrides regex/classifier hits)
 *
 * Two modes:
 *   replace — substitute the matched text with a `[REDACTED:<kind>]`
 *             marker (default).
 *   hash    — replace with a deterministic `HMAC-SHA256(secret, value)`
 *             so analysts can correlate without seeing the value.
 *             `secret` is required when `mode: "hash"`.
 *
 * Layer R17. Pairs with `audit-log` (R-infra — redactor wires into
 * the post-tool path so audit records don't carry PII), `policy-engine`
 * (R-infra — per-tenant policies), `grader-safety-classifiers`
 * (§38 — shared regex + Classifier types).
 */

export class PiiRedactorError extends CrewhausError {
  override readonly name = "PiiRedactorError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type RedactionMode = "replace" | "hash";

export type PolicyAllowEntry = {
  readonly kind: string;
  readonly value: string | RegExp;
};

export type PiiRedactorOptions = {
  /** Defaults to §38 DEFAULT_PII_DETECTORS. Pass [] to disable regex layer. */
  readonly regexDetectors?: ReadonlyArray<PiiDetector>;
  /** Optional classifier-driven detector. */
  readonly classifier?: Classifier;
  /** Per-tenant allow-list. Matches are NOT redacted. */
  readonly policyAllowList?: ReadonlyArray<PolicyAllowEntry>;
  /** Replace (default) or hash. */
  readonly mode?: RedactionMode;
  /** Required when mode is "hash". HMAC key. */
  readonly secret?: string;
  /** Hash output prefix; default `[HASHED:<kind>:`. */
  readonly hashPrefix?: string;
  /** Hash output suffix; default `]`. */
  readonly hashSuffix?: string;
};

export type RedactionResult = {
  readonly text: string;
  readonly hits: ReadonlyArray<PiiHit>;
  readonly redactedHits: ReadonlyArray<PiiHit>;
  readonly skippedByPolicy: ReadonlyArray<PiiHit>;
};

function applyPolicyAllowList(
  hits: ReadonlyArray<PiiHit>,
  allowList: ReadonlyArray<PolicyAllowEntry>,
): { kept: ReadonlyArray<PiiHit>; skipped: ReadonlyArray<PiiHit> } {
  if (allowList.length === 0) return { kept: hits, skipped: [] };
  const kept: PiiHit[] = [];
  const skipped: PiiHit[] = [];
  for (const hit of hits) {
    const allowed = allowList.some((entry) => {
      if (entry.kind !== hit.kind) return false;
      if (typeof entry.value === "string") return entry.value === hit.value;
      return entry.value.test(hit.value);
    });
    if (allowed) skipped.push(hit);
    else kept.push(hit);
  }
  return { kept, skipped };
}

function replaceMarker(kind: string): string {
  return `[REDACTED:${kind}]`;
}

function hashMarker(
  kind: string,
  value: string,
  secret: string,
  prefix: string,
  suffix: string,
): string {
  const hex = createHmac("sha256", secret).update(value).digest("hex").slice(0, 16);
  return `${prefix}${kind}:${hex}${suffix}`;
}

function applyReplacements(
  text: string,
  hits: ReadonlyArray<PiiHit>,
  replacement: (hit: PiiHit) => string,
): string {
  if (hits.length === 0) return text;
  // Sort by descending length so we don't accidentally redact a
  // sub-string of a wider match (e.g. SSN-shaped substring inside a
  // longer numeric token).
  const sorted = [...hits].sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const hit of sorted) {
    const repl = replacement(hit);
    out = out.split(hit.value).join(repl);
  }
  return out;
}

export class PiiRedactor {
  private readonly mode: RedactionMode;
  private readonly secret: string | undefined;
  private readonly regexDetectors: ReadonlyArray<PiiDetector>;
  private readonly classifier: Classifier | undefined;
  private readonly allowList: ReadonlyArray<PolicyAllowEntry>;
  private readonly hashPrefix: string;
  private readonly hashSuffix: string;

  constructor(opts: PiiRedactorOptions = {}) {
    this.mode = opts.mode ?? "replace";
    if (this.mode === "hash" && (typeof opts.secret !== "string" || opts.secret.length === 0)) {
      throw new PiiRedactorError("PiiRedactor: mode='hash' requires a non-empty `secret`");
    }
    this.secret = opts.secret;
    this.regexDetectors = opts.regexDetectors ?? DEFAULT_PII_DETECTORS;
    this.classifier = opts.classifier;
    this.allowList = opts.policyAllowList ?? [];
    this.hashPrefix = opts.hashPrefix ?? "[HASHED:";
    this.hashSuffix = opts.hashSuffix ?? "]";
  }

  async redact(text: string): Promise<RedactionResult> {
    if (typeof text !== "string") {
      throw new PiiRedactorError("PiiRedactor.redact requires a string");
    }
    let allHits: PiiHit[] = [];
    if (this.regexDetectors.length > 0) {
      allHits.push(...detectPiiRegex(text, this.regexDetectors));
    }
    if (this.classifier !== undefined) {
      const cl = await this.classifier.classify(text);
      // Classifier doesn't return spans — only an aggregate score. We
      // record a sentinel hit so callers can see the classifier
      // weighed in. Replacement still needs concrete spans, so the
      // sentinel does not add a redaction position.
      if (cl.score >= 0.5) {
        allHits.push({ kind: "classifier", value: "" });
      }
    }
    // Dedup by (kind, value) so multiple regex passes don't redact
    // the same span twice.
    const seen = new Set<string>();
    const deduped: PiiHit[] = [];
    for (const h of allHits) {
      const key = `${h.kind}${h.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(h);
    }
    allHits = deduped;
    const { kept, skipped } = applyPolicyAllowList(allHits, this.allowList);
    const replaceableHits = kept.filter((h) => h.value.length > 0);
    const replacement = (hit: PiiHit): string =>
      this.mode === "replace"
        ? replaceMarker(hit.kind)
        : hashMarker(hit.kind, hit.value, this.secret ?? "", this.hashPrefix, this.hashSuffix);
    const out = applyReplacements(text, replaceableHits, replacement);
    return {
      text: out,
      hits: allHits,
      redactedHits: replaceableHits,
      skippedByPolicy: skipped,
    };
  }

  /**
   * Convenience for callers wiring this into `audit-log.append`. Walks a
   * plain object, redacting all string leaves (no recursion into
   * arrays-of-objects beyond one level — audit payloads are usually
   * shallow). Non-string leaves are passed through unchanged.
   */
  async redactObject<T extends Record<string, unknown>>(value: T): Promise<T> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") {
        const r = await this.redact(v);
        out[k] = r.text;
      } else if (Array.isArray(v)) {
        const arr: unknown[] = [];
        for (const item of v) {
          if (typeof item === "string") {
            const r = await this.redact(item);
            arr.push(r.text);
          } else {
            arr.push(item);
          }
        }
        out[k] = arr;
      } else {
        out[k] = v;
      }
    }
    return out as T;
  }
}

/** Convenience factory. */
export function createPiiRedactor(opts: PiiRedactorOptions = {}): PiiRedactor {
  return new PiiRedactor(opts);
}

/** Test seam: deterministic SHA-256 hex of a value (not the HMAC). */
export function _sha256ForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export { DEFAULT_PII_DETECTORS, type PiiDetector, type PiiHit, type Classifier };
