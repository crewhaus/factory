/**
 * Idempotency keys. A key is scoped to the caller, the harness (or Home) and the command
 * kind, and becomes a claim whose name is a plain hash of that scope and the key, so the
 * raw key is never written. A key is honoured for seven days: a claim older than that is
 * removed on the next touch, under the ledger lock, and the name can be claimed again.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@crewhaus/control-contract";
import { type Ledger, expireClaim, keyedDigest, readClaim } from "@crewhaus/control-records";

export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The digest label of a request's fingerprint. Stored digests join forever: a pin. */
export const FINGERPRINT_LABEL = "command-fingerprint";

export type IdempotencyScope = {
  readonly actor: string;
  /** A harness id, or `home`. */
  readonly harness: string;
  readonly kind: string;
};

/** `idem/<first 32 hex of sha256(scope, key)>`. */
export function idempotencyClaim(scope: IdempotencyScope, value: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([scope.actor, scope.harness, scope.kind, value]))
    .digest("hex");
  return `idem/${hash.slice(0, 32)}`;
}

/** Remove the claim when it is older than the seven days a key is honoured. */
export async function expireStaleClaim(ledger: Ledger, claim: string, now: number): Promise<void> {
  const read = readClaim(ledger, claim);
  if (!read.ok) return;
  const notBefore = now - IDEMPOTENCY_TTL_MS;
  const at = Date.parse(read.content.at);
  if (Number.isFinite(at) && at < notBefore) await expireClaim(ledger, claim, notBefore);
}

/** The body without the fields that hold a secret, so no receipt hashes a credential. */
export function withoutSecrets(
  body: Readonly<Record<string, unknown>>,
  secretFields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(body)) {
    if (!secretFields.includes(name)) out[name] = value;
  }
  return out;
}

/**
 * A keyed digest of what the request asks for: its kind, its target and its body without
 * secret fields. Two requests under one key are the same request when these are equal.
 */
export function fingerprintOf(
  key: CryptoKey,
  kind: string,
  target: string,
  body: Readonly<Record<string, unknown>>,
  secretFields: readonly string[],
): Promise<string> {
  return keyedDigest(key, FINGERPRINT_LABEL, [
    kind,
    target,
    canonicalJson(withoutSecrets(body, secretFields)),
  ]);
}
