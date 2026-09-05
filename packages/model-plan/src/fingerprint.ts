/**
 * Stable fingerprints (§4.4 `poolFingerprint`, §7.11 priors, §7.2.2 signal
 * hashes). Pure and dependency-free: a canonical JSON serialisation (keys
 * sorted recursively, `undefined` members dropped) hashed with 64-bit
 * FNV-1a, so the same plan produces the same fingerprint in every process
 * and on every runtime — including the edge, where `node:crypto` may be
 * unavailable. Not a cryptographic digest and not meant as one: it detects
 * CHANGE (a setting edited, a rule toggled), which is what `policyVersion`
 * and the priors staleness check need.
 */

/** Canonical JSON: object keys sorted at every depth, `undefined` dropped, arrays kept in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/** 64-bit FNV-1a over the UTF-16 code units of `text`, as 16 lowercase hex chars. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Fingerprint of a whole plan input — the FULL profile plus rules, strategy
 * and reward (§4.4: `{policy, model, tags, objective}` alone would leave
 * `policyVersion` unchanged when a setting changes). Any JSON-shaped value
 * is accepted; callers pass the pool/profile object they hold.
 */
export function planFingerprint(plan: unknown): string {
  return fnv1a64(canonicalJson(plan));
}

/** Fingerprint of one profile — the per-profile lineage key (§6.3 `reset_on_profile_change`). */
export function profileFingerprint(profile: unknown): string {
  return planFingerprint(profile);
}
