/**
 * Record semantics: time, expiry, versions and compare-and-set.
 *
 * Nothing here reads the clock. Every tool that needs "now" takes it from the
 * caller, because a tool whose output moves on its own is not deterministic
 * and cannot be replayed, cached or tested. That is also why expiry is
 * evaluated only when the caller supplies `now`: a store that quietly drops a
 * record because a machine's clock drifted is worse than one that says it did
 * not check.
 */

/** A stored key-value record, exactly as it sits on disk. */
export type StoredRecord = {
  readonly key: string;
  readonly value: unknown;
  /** Bumped on every write; the token compare-and-set is written against. */
  readonly version: number;
  /** ISO-8601 instant, derived from a caller-supplied `now` plus a TTL. */
  readonly expiresAt?: string;
  /** The caller's `now` at the last write, when one was supplied. */
  readonly updatedAt?: string;
};

/** True for a JSON object (not an array, not null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parse a caller-supplied instant, strictly and INDEPENDENTLY OF THE MACHINE.
 *
 * `Date.parse` accepts a lot of implementation-defined nonsense ("now",
 * "Tuesday"), and two runtimes need not agree on it, so a leading `YYYY-MM-DD`
 * is required before the value is trusted.
 *
 * A date-time with no offset ("2026-01-02T03:04:05") is read as UTC, not as
 * local time. ECMAScript says the opposite — it reads such a value in the
 * machine's own zone — which would make the same `now` produce a different
 * stored timestamp and a different expiry on a laptop in New York than on a
 * runner in UTC, and this package's whole claim is that the same inputs
 * produce the same bytes. The offset is appended before parsing, so an
 * explicit `Z` or `±hh:mm` still wins and is honoured exactly.
 */
export function parseInstant(value: string): number | undefined {
  const match = INSTANT.exec(value);
  if (match === null) return undefined;
  const time = match[1];
  const zone = match[2];
  const normalized =
    time === undefined ? value : `${value.replace(" ", "T")}${zone === undefined ? "Z" : ""}`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Canonical ISO-8601 rendering, so two spellings of one instant store alike. */
export function formatInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/** The expiry instant for a record written at `nowMs` with `ttlSeconds`. */
export function expiryFrom(nowMs: number, ttlSeconds: number): string {
  return formatInstant(nowMs + Math.round(ttlSeconds * 1000));
}

/**
 * Whether a record has expired.
 *
 * `false` when the question cannot be decided at all — no `expiresAt`, no
 * caller-supplied `now`, or an `expiresAt` that cannot be parsed. Undecidable
 * reads as "not expired" on purpose: the callers pair this with an
 * `expiryChecked` flag, and hiding a record because a timestamp was unreadable
 * would lose data on a guess.
 */
export function isExpired(expiresAt: string | undefined, nowMs: number | undefined): boolean {
  if (expiresAt === undefined || nowMs === undefined) return false;
  const deadline = parseInstant(expiresAt);
  if (deadline === undefined) return false;
  return nowMs >= deadline;
}

/**
 * Compare-and-set check. `expected` of 0 means "this key must not exist yet".
 * Returns a readable explanation of the conflict, or `undefined` when the
 * write may proceed.
 */
export function casConflict(
  current: number | undefined,
  expected: number | undefined,
): string | undefined {
  if (expected === undefined) return undefined;
  if (expected === 0) {
    return current === undefined
      ? undefined
      : `expected the key to be absent but it exists at version ${current}`;
  }
  if (current === undefined) return `expected version ${expected} but the key does not exist`;
  if (current !== expected)
    return `expected version ${expected} but the current version is ${current}`;
  return undefined;
}

/** Byte length of a string's UTF-8 encoding — what a size cap should measure. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Validate a stored record's shape, so a truncated or hand-edited file is
 * reported as corrupt instead of being handed back as a record with holes.
 */
export function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isPlainObject(value)) return false;
  if (typeof value["key"] !== "string") return false;
  if (typeof value["version"] !== "number" || !Number.isFinite(value["version"])) return false;
  if (!("value" in value)) return false;
  const expires = value["expiresAt"];
  if (expires !== undefined && typeof expires !== "string") return false;
  return true;
}
