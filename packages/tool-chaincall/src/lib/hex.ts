/**
 * Hex on the wire, integers in memory, decimal strings on the way out.
 *
 * JSON-RPC speaks two hex dialects and conflating them is a real bug class:
 * a QUANTITY is minimal-length with no leading zeros (`0x1`), and DATA is a
 * byte string with an even number of digits (`0x01`). `0x` is a legal empty
 * DATA — it is what an `eth_call` to an address with no code returns — and
 * is NOT a legal quantity.
 *
 * Nothing here ever produces a JS `number` for a chain value. A uint256 is
 * 78 decimal digits and a double carries about 15, so a balance read into a
 * number is wrong in its low bits while still printing plausibly. Quantities
 * come back as `bigint` and leave this package as decimal strings.
 */
import { ChainCallError } from "./rpc";

const LOOSE_QUANTITY = /^0x[0-9a-fA-F]+$/;
const DATA = /^0x([0-9a-fA-F]{2})*$/;

/**
 * Read a JSON-RPC QUANTITY as a bigint.
 *
 * Leading zeros are tolerated rather than refused: several providers emit
 * `0x0000…` for a zero field, and rejecting a node's own formatting habit
 * would fail a read that is perfectly well-defined. What is refused is
 * anything that is not hex at all, a decimal string that a caller mistook
 * for a quantity, and `0x` with no digits.
 */
export function quantity(value: unknown, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || !LOOSE_QUANTITY.test(value)) {
    throw new ChainCallError(
      `${what}: expected a 0x-prefixed hex quantity, got ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

/** Same, but a missing or null field is an absent value rather than an error. */
export function optionalQuantity(value: unknown, what: string): bigint | undefined {
  return value === undefined || value === null ? undefined : quantity(value, what);
}

/** Render a bigint as a minimal QUANTITY, the form the wire wants. */
export function toQuantity(value: bigint): string {
  if (value < 0n) throw new ChainCallError(`a JSON-RPC quantity cannot be negative, got ${value}`);
  return `0x${value.toString(16)}`;
}

/**
 * Validate a 0x DATA string and lowercase it. `0x` passes: an empty return
 * is the single most important value in this package, because it is what an
 * address with no code answers, and treating it as an error loses the fact.
 */
export function data(value: unknown, what: string): string {
  if (typeof value !== "string" || !DATA.test(value.trim())) {
    throw new ChainCallError(
      `${what}: expected 0x followed by an even number of hex digits, got ${JSON.stringify(value)}`,
    );
  }
  return value.trim().toLowerCase();
}

/** Byte count of a 0x DATA string. */
export function byteLength(hex: string): number {
  return (hex.length - 2) / 2;
}

/**
 * The 32-byte word at `index`, or undefined when the data is shorter.
 *
 * Returning undefined rather than a zero word is the point: a short answer
 * that gets padded reads as a real zero, and "the balance is 0" is exactly
 * the wrong thing to say about a call that did not return one.
 */
export function wordAt(hex: string, index: number): string | undefined {
  const start = 2 + index * 64;
  return hex.length >= start + 64 ? `0x${hex.slice(start, start + 64)}` : undefined;
}

/** A 32-byte word as an unsigned integer. */
export function wordToBigint(word: string): bigint {
  return BigInt(word);
}

/**
 * The address in the low 20 bytes of a word, lowercased.
 *
 * The high 12 bytes must be zero. A storage slot whose top bytes are dirty
 * is not an address that happens to have junk above it — it is a slot that
 * holds something else, and silently masking it off would report a proxy's
 * implementation as whatever the low bytes of a packed struct happen to be.
 */
export function wordToAddress(word: string, what: string): string {
  const body = word.replace(/^0x/, "").toLowerCase();
  if (body.length !== 64) throw new ChainCallError(`${what}: expected a 32-byte word`);
  if (!/^0{24}/.test(body)) {
    throw new ChainCallError(
      `${what}: the top 12 bytes of ${word} are not zero, so this slot does not hold an address`,
    );
  }
  return `0x${body.slice(24)}`;
}

/** True when a 32-byte word is all zeros: an unset slot. */
export function isZeroWord(word: string): boolean {
  return /^0x0{64}$/.test(word.toLowerCase());
}

/** A bool return value: 32 bytes, zero for false, anything else for true. */
export function wordToBool(word: string): boolean {
  return !isZeroWord(word);
}

/** The zero address, which is what an unset slot decodes to. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * A block tag or number, as the wire wants it.
 *
 * A number arrives as a decimal STRING and leaves as a quantity: a block
 * number past 2^53 is not a today problem, but the rule that no chain
 * quantity passes through a JS number has no exceptions in this package,
 * because the exceptions are what get copied.
 */
export function blockParam(blockNumber: string | undefined, blockTag: string | undefined): string {
  if (blockNumber !== undefined) {
    if (!/^\d+$/.test(blockNumber.trim())) {
      throw new ChainCallError(
        `blockNumber must be a decimal integer string, got ${JSON.stringify(blockNumber)}`,
      );
    }
    return toQuantity(BigInt(blockNumber.trim()));
  }
  return blockTag ?? "latest";
}
