/**
 * Chain quantities, in and out.
 *
 * Every number a node sends is a hex QUANTITY string, and every one of them is
 * a candidate for silent precision loss: a uint256 balance does not fit in a
 * double, and neither does a chain id on some testnets. So nothing here ever
 * produces a JS number from chain data. Hex goes to `bigint`, `bigint` goes to
 * a decimal STRING on the way out, and a caller that wants arithmetic gets
 * digits it can feed to `TokenUnits` or `MoneyMultiply` rather than a float
 * that is already wrong.
 *
 * Block numbers get the same treatment even though today's heads fit in a
 * double. They are compared, subtracted and used as search bounds all over
 * this package, and one accidental `Number(...)` in that chain of operations
 * is a bug that only shows up on a chain nobody tested against.
 */
import { CrewhausError } from "@crewhaus/errors";

/** A refusal raised by this package: a bad input, a bad answer, or a scan it will not vouch for. */
export class ChainReadError extends CrewhausError {
  override readonly name = "ChainReadError";
  constructor(message: string) {
    super("tool", message);
  }
}

/** Block tags every EVM node understands; `safe`/`finalized` are post-Merge and not universal. */
export const BLOCK_TAGS = ["latest", "earliest", "pending", "safe", "finalized"] as const;
export type BlockTag = (typeof BLOCK_TAGS)[number];

export function isBlockTag(value: string): value is BlockTag {
  return (BLOCK_TAGS as ReadonlyArray<string>).includes(value);
}

/** 32 bytes of hex with the prefix: a block hash or a transaction hash. */
export function isHash32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Parse a hex QUANTITY as a bigint.
 *
 * Nodes are not consistent about the spec's "no leading zeroes" rule — Erigon
 * and several L2 sequencers pad — so padding is accepted. What is not accepted
 * is a decimal string that happens to be all digits: `"100"` from a node would
 * mean 0x100, and reading it as one hundred is a 156-block error in a search
 * bound. Anything that is not `0x`-prefixed hex is a malformed answer.
 */
export function hexToBigint(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ChainReadError(
      `${what}: expected a 0x hex quantity, got ${JSON.stringify(value)} — the endpoint answered something this package cannot read`,
    );
  }
  return BigInt(value);
}

/** The same, but a missing field is `null` rather than an error. Pre-1559 blocks have no base fee. */
export function optionalHexToBigint(value: unknown, what: string): bigint | null {
  if (value === undefined || value === null) return null;
  return hexToBigint(value, what);
}

/** A bigint as the hex QUANTITY the JSON-RPC wire format wants. */
export function toHexQuantity(value: bigint): string {
  if (value < 0n) throw new ChainReadError(`cannot encode a negative quantity (${value})`);
  return `0x${value.toString(16)}`;
}

/**
 * Accept the three shapes a caller might hand us for an integer, and refuse a
 * float or an unsafe number instead of rounding it.
 *
 * A number is allowed because a block number typed by hand is a number, and
 * refusing it would be pedantry. A number past `Number.MAX_SAFE_INTEGER` is
 * refused because by then it has ALREADY lost its low digits — accepting it
 * would be accepting a value the caller can no longer see is wrong.
 */
export function toBigint(value: string | number, what: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ChainReadError(
        `${what}: ${value} is not a safe integer — past 2^53 a JS number has already lost digits, so pass it as a string`,
      );
    }
    return BigInt(value);
  }
  const text = value.trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) {
    throw new ChainReadError(`${what}: "${value}" is not a non-negative integer`);
  }
  return BigInt(text);
}

/**
 * A unix timestamp as ISO-8601.
 *
 * Seconds, not milliseconds: an EVM block timestamp is seconds, and the
 * thousand-fold mistake produces a date in 1970 that looks like data rather
 * than like an error. A timestamp past what `Date` can express comes back
 * `null` rather than "Invalid Date", which would land in output as a string.
 */
export function unixToIso(seconds: bigint): string | null {
  const ms = seconds * 1000n;
  if (ms > 8_640_000_000_000_000n || ms < -8_640_000_000_000_000n) return null;
  return new Date(Number(ms)).toISOString();
}

/** Compact JSON — every byte returned is a byte in somebody's context window. */
export const json = (value: unknown): string => JSON.stringify(value);

/** Read a field off a node's answer without `any` and without assuming it is there. */
export function field(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

export function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChainReadError(`${what}: expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/** A hex string as lowercase, so `0xAbC…` and `0xabc…` compare and dedupe as one address. */
export function lowerHex(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new ChainReadError(`${what}: expected 0x hex, got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}
