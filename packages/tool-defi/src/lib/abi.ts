/**
 * The handful of ABI shapes this package reads, and nothing more.
 *
 * `@crewhaus/tool-onchain` owns the general ABI coder for this monorepo, but
 * its entrypoint exports the coder as TOOLS (`AbiEncodeCall`, `AbiDecode`,
 * `FunctionSelector`) rather than as functions, and this package does not
 * reach past another package's entrypoint or widen it while sibling packages
 * are being written into the same checkout. What is left is small and fixed:
 * every call here is a view function with at most two static arguments, and
 * every answer is a run of 32-byte words plus, in one case, a string.
 *
 * The selectors below are CONSTANTS, not computed — there is no Keccak in this
 * package's dependency set. That is only safe because it is checked: `lib.test.ts`
 * puts every one of them through tool-onchain's `FunctionSelector` tool, and
 * puts every decoder in this file through its `AbiDecode`, so a wrong constant
 * or a mis-sliced word fails the suite rather than reading the wrong storage
 * slot in production.
 */

export class AbiError extends Error {
  override readonly name = "AbiError";
}

/**
 * Four-byte selectors, each with the canonical signature it was hashed over.
 *
 * Canonical matters: `balanceOf(address)` and `balanceOf(address owner)` hash
 * the same because parameter names are not part of the signature, but `uint`
 * and `uint256` do NOT — the first is not canonical and hashes differently.
 */
export const SELECTORS = Object.freeze({
  /** `decimals()` — ERC-20, and a Chainlink aggregator's answer scale. */
  decimals: "0x313ce567",
  /** `description()` — a Chainlink feed's own label, e.g. "ETH / USD". */
  description: "0x7284e416",
  /** `latestRoundData()` — (uint80,int256,uint256,uint256,uint80). */
  latestRoundData: "0xfeaf968c",
  /** `balanceOf(address)` — ERC-20, and an ERC-4626 share balance. */
  balanceOf: "0x70a08231",
  /** `getPriceUnsafe(bytes32)` — Pyth: (int64,uint64,int32,uint256). */
  getPriceUnsafe: "0x96834ad3",
  /** `getUserAccountData(address)` — Aave v3 Pool: six uint256. */
  getUserAccountData: "0xbf92857c",
  /** `convertToAssets(uint256)` — ERC-4626. */
  convertToAssets: "0x07a2d13a",
  /** `asset()` — ERC-4626's underlying token. */
  asset: "0x38d52e0f",
  /** `borrowBalanceOf(address)` — Compound v3 Comet, in base-token units. */
  borrowBalanceOf: "0x374c49b4",
  /** `baseToken()` — Compound v3 Comet's single borrowable asset. */
  baseToken: "0xc55dae63",
  /** `collateralBalanceOf(address,address)` — Compound v3 Comet. */
  collateralBalanceOf: "0x5c2549ee",
  /** `isLiquidatable(address)` — Compound v3 Comet's own verdict, not a derived one. */
  isLiquidatable: "0x042e02cf",
} as const);

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

/**
 * Shape-check an address and lowercase it.
 *
 * Shape only: verifying an EIP-55 checksum needs Keccak, which this package
 * does not have. `AddressCheck` in `@crewhaus/tool-onchain` is the tool that
 * catches a typo in a mixed-case address, and every tool description here
 * points a caller at it — reading the wrong contract is not an error this can
 * detect for itself, it is a wrong answer.
 */
export function normalizeAddress(raw: string, what: string): string {
  const text = raw.trim();
  if (!HEX_ADDRESS.test(text)) {
    throw new AbiError(
      `${what}: "${raw}" is not an address (0x followed by 40 hex characters) — run AddressCheck on it first`,
    );
  }
  return text.toLowerCase();
}

export function normalizeBytes32(raw: string, what: string): string {
  const text = raw.trim();
  if (!HEX_BYTES32.test(text)) {
    throw new AbiError(`${what}: "${raw}" is not 0x followed by 64 hex characters`);
  }
  return text.toLowerCase();
}

/** Calldata for a view function that takes no arguments. */
export function callNoArgs(selector: string): string {
  return selector;
}

/** Calldata for one `address` argument: left-padded into a 32-byte word. */
export function callWithAddress(selector: string, address: string, what: string): string {
  return selector + normalizeAddress(address, what).slice(2).padStart(64, "0");
}

/** Calldata for two `address` arguments, in declaration order. */
export function callWithAddresses(
  selector: string,
  first: string,
  second: string,
  what: string,
): string {
  return (
    selector +
    normalizeAddress(first, `${what} (first argument)`).slice(2).padStart(64, "0") +
    normalizeAddress(second, `${what} (second argument)`).slice(2).padStart(64, "0")
  );
}

/** Calldata for one `uint256` argument. */
export function callWithUint256(selector: string, value: bigint, what: string): string {
  if (value < 0n) throw new AbiError(`${what}: a uint256 argument must not be negative`);
  const hex = value.toString(16);
  if (hex.length > 64) throw new AbiError(`${what}: ${value} does not fit in a uint256`);
  return selector + hex.padStart(64, "0");
}

/** Calldata for one `bytes32` argument. */
export function callWithBytes32(selector: string, value: string, what: string): string {
  return selector + normalizeBytes32(value, what).slice(2);
}

function hexBody(data: string, what: string): string {
  const text = data.trim();
  if (!HEX_DATA.test(text)) {
    throw new AbiError(`${what}: expected 0x followed by an even number of hex characters`);
  }
  return text.slice(2);
}

/**
 * Split return data into exactly `count` unsigned 32-byte words.
 *
 * Exactly, not at least: a contract that answered with fewer words than its
 * signature promises did not answer the question, and an address with no code
 * answers `0x` — which zero-pads into a perfectly plausible price of zero if
 * anyone lets it. `@crewhaus/tool-onchain`'s decoder takes the same line.
 */
export function decodeWords(data: string, count: number, what: string): bigint[] {
  const body = hexBody(data, what);
  if (body.length === 0) {
    throw new AbiError(
      `${what}: the call returned no data — the address has no code, or the function does not exist on it`,
    );
  }
  if (body.length !== count * 64) {
    throw new AbiError(
      `${what}: expected ${count} 32-byte word(s) (${count * 32} bytes), got ${body.length / 2}`,
    );
  }
  const words: bigint[] = [];
  for (let i = 0; i < count; i++) {
    words.push(BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`));
  }
  return words;
}

/**
 * Reinterpret an unsigned word as a signed integer of `bits` width.
 *
 * A Chainlink `answer` is an int256 and a Pyth `expo` is an int32, and both
 * are genuinely negative in the wild: `expo` is almost always negative, and a
 * feed reporting a negative answer is the signal that something is wrong with
 * it. Read unsigned, that same feed reports about 1.15e77 and the position
 * built on it looks spectacularly solvent.
 */
export function asSigned(word: bigint, bits: number): bigint {
  if (!Number.isInteger(bits) || bits <= 0 || bits > 256) {
    throw new AbiError(`asSigned: ${bits} is not a supported integer width`);
  }
  const modulus = 1n << BigInt(bits);
  const masked = word & (modulus - 1n);
  return masked >= modulus >> 1n ? masked - modulus : masked;
}

/**
 * Read a 32-byte word as an `address`.
 *
 * The low 20 bytes are the address; the upper 12 are padding that the ABI says
 * is zero and that nothing on the receiving end enforces. `@crewhaus/tool-onchain`'s
 * decoder takes the low 20 bytes and ignores the rest, so this does too —
 * formatting the WHOLE word instead produces a 66-character string that is not
 * an address, which every downstream address check then rejects, so one
 * non-conforming contract takes out the read rather than the padding it
 * violated. The dirty padding is reported rather than swallowed: it is also
 * what calling the wrong function on the right contract looks like.
 */
export function addressFromWord(word: bigint): { address: string; paddingDirty: boolean } {
  const low = word & ((1n << 160n) - 1n);
  return {
    address: `0x${low.toString(16).padStart(40, "0")}`,
    paddingDirty: word !== low,
  };
}

/** A contract-supplied label longer than this is not a label. "ETH / USD" is nine. */
export const MAX_CONTRACT_TEXT_CHARS = 128;

/**
 * Make a contract-supplied string safe to put in a result.
 *
 * Every string in this package's output that did not come from the caller came
 * from a contract, and a contract's bytes are written by whoever deployed it —
 * which, for a feed address a caller was handed, is not the caller. A real
 * aggregator's `description()` is nine characters; a long one is not a label,
 * it is somebody using the one free-text field here as a way into the reader's
 * context. Control characters go the same way: a newline in returned bytes
 * lets them impersonate the lines printed around them.
 *
 * Truncation is REPORTED, never silent — a label quietly cut at 128 characters
 * is a different label, and "this address is the pair you meant" is exactly the
 * check a shortened one would pass by accident.
 */
export function sanitizeContractText(
  raw: string,
  maxChars: number = MAX_CONTRACT_TEXT_CHARS,
): { text: string; truncated: boolean; hadControlCharacters: boolean } {
  let hadControlCharacters = false;
  let out = "";
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      hadControlCharacters = true;
      out += "\uFFFD";
      continue;
    }
    out += character;
  }
  const truncated = [...out].length > maxChars;
  return {
    text: truncated ? `${[...out].slice(0, maxChars).join("")}\u2026` : out,
    truncated,
    hadControlCharacters,
  };
}

/**
 * Decode return data holding one dynamic `string`.
 *
 * Head word is a byte OFFSET from the start of the data, not an index; the
 * word at that offset is the byte length, and the bytes follow it padded up to
 * a word boundary. Treating the offset as a length is the classic misread, and
 * it produces a plausible short string rather than an error.
 *
 * `maxBytes` is a refusal, not a truncation: a node may return up to
 * MAX_RESPONSE_BYTES, so without it a contract can hand back a megabyte of
 * text that this would decode in full and carry into somebody's context window.
 */
export function decodeString(data: string, what: string, maxBytes = 1024): string {
  const body = hexBody(data, what);
  if (body.length < 128) {
    throw new AbiError(
      `${what}: a returned string needs at least two words, got ${body.length / 2} bytes`,
    );
  }
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`));
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0 || offset * 2 + 64 > body.length) {
    throw new AbiError(
      `${what}: the string's offset word (${offset}) does not point inside the data`,
    );
  }
  const lengthAt = offset * 2;
  const length = Number(BigInt(`0x${body.slice(lengthAt, lengthAt + 64)}`));
  if (!Number.isSafeInteger(length) || lengthAt + 64 + length * 2 > body.length) {
    throw new AbiError(`${what}: the string claims ${length} bytes, past the end of the data`);
  }
  if (length > maxBytes) {
    throw new AbiError(
      `${what}: the string is ${length} bytes, past the ${maxBytes} this reads from a contract — a label that long is not a label`,
    );
  }
  const bytes = body.slice(lengthAt + 64, lengthAt + 64 + length * 2);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Number.parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder("utf-8", { fatal: false }).decode(out);
}

/** The largest uint256, which several protocols use to mean "unbounded". */
export const UINT256_MAX = (1n << 256n) - 1n;
