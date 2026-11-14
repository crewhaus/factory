/**
 * Idempotency keys. A key is scoped to the caller, the harness (or Home) and the command
 * kind, and becomes a claim whose name is a plain hash of that scope and the key, so the
 * raw key is never written. A key is honoured for seven days: a claim older than that is
 * removed on the next touch, under the ledger lock, and the name can be claimed again.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@crewhaus/control-contract";
import {
  type Ledger,
  expireClaim,
  keyedDigest,
  listClaims,
  readClaim,
} from "@crewhaus/control-records";

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

/**
 * Remove every idempotency claim in a ledger older than the seven days a key is honoured,
 * each by {@link expireStaleClaim}'s own rule: listed without a lock, and the lock taken
 * only for a claim that is due. Answers how many claims were looked at, and whether the
 * listing was cut short.
 *
 * First consumer: Home's `claims` sweep.
 */
export async function expireIdempotencyClaims(
  ledger: Ledger,
  now: number,
): Promise<{ readonly checked: number; readonly truncated: boolean }> {
  const listed = listClaims(ledger, "idem");
  if (!listed.ok) {
    if (listed.code === "not-found") return { checked: 0, truncated: false };
    throw new Error(listed.reason);
  }
  for (const claim of listed.names) await expireStaleClaim(ledger, claim, now);
  return { checked: listed.names.length, truncated: listed.truncated };
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

/** What a request asks for, as its fingerprint reads it. */
export type FingerprintInput = {
  readonly kind: string;
  readonly target: string;
  /** Path parameters beyond the target, such as the variable a route unsets. */
  readonly params?: Readonly<Record<string, string>>;
  /** The query, as name and value pairs in any order. */
  readonly query?: readonly (readonly [string, string])[];
  readonly body?: Readonly<Record<string, unknown>>;
  readonly secretFields?: readonly string[];
  /** The rule a system actor acts under, when it acts under one. */
  readonly authority?: Readonly<Record<string, unknown>>;
};

/**
 * A keyed digest of what the request asks for: its kind, its target, its path parameters,
 * its query and its body without secret fields. Two requests under one key are the same
 * request only when all of these are equal, so a key reused on `/env/A` and then `/env/B`
 * is refused rather than answered as the first.
 */
export function fingerprintOf(key: CryptoKey, input: FingerprintInput): Promise<string> {
  const query = [...(input.query ?? [])]
    .map(([name, value]) => [name, value] as const)
    .sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])));
  return keyedDigest(key, FINGERPRINT_LABEL, [
    input.kind,
    input.target,
    canonicalJson({
      params: input.params ?? {},
      query,
      body: withoutSecrets(input.body ?? {}, input.secretFields ?? []),
      // Absent from every fingerprint made without one, so none of those moves.
      ...(input.authority !== undefined ? { authority: input.authority } : {}),
    }),
  ]);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
