/**
 * The token-standard call surface: the selectors, the interface ids, and the
 * reading of what comes back.
 *
 * This is a narrow codec, not a second copy of `tool-onchain`'s general ABI
 * coder, and the reason is the whole point of this file. A general decoder is
 * told what type to expect and fails when the bytes are not that type. The
 * tokens that break harnesses are exactly the ones whose bytes are not that
 * type: `symbol()` on MKR returns a `bytes32`, not a `string`; `decimals()`
 * on some very old tokens reverts or is simply absent; an EOA answers every
 * call with `0x`. Reading those needs the raw words and a documented
 * fallback, which is a different job from "decode this as a string".
 *
 * Every selector and interface id below is a literal, and every one of them
 * is derived from its signature in `lib.test.ts` through `tool-onchain`'s
 * `FunctionSelector`. A literal that drifts fails a test rather than
 * producing calldata a node accepts and a contract misreads.
 */

/** Four-byte selectors for the calls this package makes. */
export const SELECTOR = Object.freeze({
  /** ERC-20 `balanceOf(address)`. */
  balanceOf: "0x70a08231",
  /** ERC-20 `allowance(address,address)`. */
  allowance: "0xdd62ed3e",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  totalSupply: "0x18160ddd",
  ownerOf: "0x6352211e",
  tokenURI: "0xc87b56dd",
  /** ERC-1155 `uri(uint256)`. */
  uri: "0x0e89341c",
  /** ERC-1155 `balanceOf(address,uint256)` — a different selector from ERC-20's. */
  balanceOf1155: "0x00fdd58e",
  supportsInterface: "0x01ffc9a7",
  /** Multicall3's own helpers, callable inside the same batch. */
  getEthBalance: "0x4d2301cc",
  getBlockNumber: "0x42cbb15c",
} as const);

/**
 * ERC-165 interface ids. Each is the XOR of the selectors of the functions in
 * its interface, and `lib.test.ts` recomputes each one from that function
 * list rather than trusting the literal.
 */
export const INTERFACE_ID = Object.freeze({
  erc165: "0x01ffc9a7",
  erc721: "0x80ac58cd",
  erc721Metadata: "0x5b5e139f",
  erc721Enumerable: "0x780e9d63",
  erc1155: "0xd9b67a26",
  erc1155MetadataUri: "0x0e89341c",
  /**
   * Not an interface. ERC-165 requires `supportsInterface(0xffffffff)` to
   * answer FALSE, so a contract that says true here answers true to
   * everything and its other answers mean nothing.
   */
  invalid: "0xffffffff",
} as const);

/** A decoded string longer than this is not a symbol or a name. */
export const MAX_STRING_BYTES = 4096;

const HEX_BODY = /^[0-9a-fA-F]*$/;

export function hexToBytes(hex: string, what = "data"): Uint8Array {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error(`${what}: an odd number of hex digits`);
  if (!HEX_BODY.test(body)) throw new Error(`${what}: not hex`);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** A 32-byte word holding a right-aligned address. */
export function addressWord(address: string): string {
  const body = address.replace(/^0x/i, "").toLowerCase();
  if (body.length !== 40) throw new Error(`an address is 20 bytes, got ${body.length / 2}`);
  return body.padStart(64, "0");
}

/** A 32-byte word holding a right-aligned unsigned integer. */
export function uintWord(value: bigint): string {
  if (value < 0n) throw new Error(`${value} is negative, and the type is unsigned`);
  if (value >= 1n << 256n) throw new Error(`${value} does not fit in a uint256`);
  return value.toString(16).padStart(64, "0");
}

/**
 * A 32-byte word holding a LEFT-aligned `bytes4`.
 *
 * Fixed bytes are left-aligned and integers right-aligned. Getting this
 * backwards makes every `supportsInterface` answer false, which reads as "not
 * an NFT" rather than as a bug.
 */
export function bytes4Word(id: string): string {
  const body = id.replace(/^0x/i, "").toLowerCase();
  if (body.length !== 8) throw new Error(`an interface id is 4 bytes, got "${id}"`);
  return body.padEnd(64, "0");
}

/** Assemble calldata from a selector and pre-padded words. */
export function callData(selector: string, ...words: ReadonlyArray<string>): string {
  return `${selector}${words.join("")}`;
}

// ---------------------------------------------------------------------------
// reading the answer
// ---------------------------------------------------------------------------

const WORD = 32;

/** Read one 32-byte word as an unsigned integer, or null when it is not there. */
export function decodeUint(data: string): bigint | null {
  const bytes = hexToBytes(data, "return data");
  if (bytes.length < WORD) return null;
  let value = 0n;
  for (const b of bytes.subarray(0, WORD)) value = (value << 8n) | BigInt(b);
  return value;
}

/**
 * Read one word as an address.
 *
 * The top 12 bytes must be zero. A word with anything up there is not an
 * address the caller can use, and masking it off would turn a contract's
 * garbage into a plausible destination.
 */
export function decodeAddressValue(data: string): string | null {
  const bytes = hexToBytes(data, "return data");
  if (bytes.length < WORD) return null;
  for (let i = 0; i < 12; i++) if (bytes[i] !== 0) return null;
  return `0x${bytesToHex(bytes.subarray(12, WORD))}`;
}

/** Read one word as a bool. Anything other than 0 or 1 is not a bool. */
export function decodeBool(data: string): boolean | null {
  const value = decodeUint(data);
  if (value === null || value > 1n) return null;
  return value === 1n;
}

/** How a text field was actually encoded on the wire. */
export type StringEncoding = "string" | "bytes32" | "absent" | "undecodable";

export type StringRead = {
  readonly value: string | null;
  readonly encoding: StringEncoding;
  /** Why it came out this way. Empty when the answer was an ordinary string. */
  readonly note: string;
  /** The raw bytes, always, so an unreadable answer is still actionable. */
  readonly raw: string;
};

/** UTF-8, strictly. A symbol that is not text must not come back as U+FFFD replacement characters. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function decodeBytes32Text(word: Uint8Array, raw: string, note: string): StringRead {
  let end = word.length;
  while (end > 0 && word[end - 1] === 0) end--;
  const body = word.subarray(0, end);
  if (body.some((b) => b === 0)) {
    // Interior NULs mean this is not a NUL-padded string, whatever the
    // trailing zeros suggested.
    return { value: null, encoding: "undecodable", note: `${note}interior NUL bytes`, raw };
  }
  try {
    return { value: strictUtf8.decode(body), encoding: "bytes32", note, raw };
  } catch {
    return { value: null, encoding: "undecodable", note: `${note}not valid UTF-8`, raw };
  }
}

/**
 * Read `symbol()` or `name()` from whatever the token actually returned.
 *
 * Three shapes are real and all three are in production:
 *
 *   - a normal dynamic `string` (offset, length, bytes);
 *   - exactly one word, which is the `bytes32` form MKR and several other
 *     2017-era tokens use — the ABI was not settled when they deployed;
 *   - nothing at all, because the function is absent or reverted.
 *
 * The third is reported as `absent`, never as an empty name. "" and "we could
 * not read it" are different facts and a caller displaying the first as the
 * second shows a blank where a warning belongs.
 */
export function decodeStringish(data: string): StringRead {
  const raw = data.startsWith("0x") ? data : `0x${data}`;
  const bytes = hexToBytes(data, "return data");
  if (bytes.length === 0) {
    return { value: null, encoding: "absent", note: "the call returned no data", raw };
  }
  if (bytes.length === WORD) {
    return decodeBytes32Text(bytes, raw, "returned bytes32 rather than string; ");
  }
  if (bytes.length >= WORD * 2) {
    const offset = decodeUint(data) as bigint;
    const length = decodeUint(`0x${bytesToHex(bytes.subarray(WORD, WORD * 2))}`) as bigint;
    const wellFormed =
      offset === 32n &&
      length <= BigInt(bytes.length - WORD * 2) &&
      length <= BigInt(MAX_STRING_BYTES);
    if (wellFormed) {
      const body = bytes.subarray(WORD * 2, WORD * 2 + Number(length));
      try {
        return { value: strictUtf8.decode(body), encoding: "string", note: "", raw };
      } catch {
        return { value: null, encoding: "undecodable", note: "not valid UTF-8", raw };
      }
    }
    if (length > BigInt(MAX_STRING_BYTES)) {
      return {
        value: null,
        encoding: "undecodable",
        note: `declares ${length} bytes, past the ${MAX_STRING_BYTES}-byte cap for a symbol or a name`,
        raw,
      };
    }
    // A blob that is neither a well-formed string nor one word. The first word
    // is still the most likely place a bytes32 symbol is sitting.
    return decodeBytes32Text(
      bytes.subarray(0, WORD),
      raw,
      "not a well-formed dynamic string; read the first word as bytes32; ",
    );
  }
  return {
    value: null,
    encoding: "undecodable",
    note: `${bytes.length} bytes is neither a word nor a dynamic string`,
    raw,
  };
}

/**
 * The 64-hex-digit, zero-padded, LOWERCASE form of a token id, for the `{id}`
 * placeholder in an ERC-1155 URI.
 *
 * The spec is explicit and almost everyone gets it wrong: it is not the
 * decimal id and not `0x`-prefixed. A gateway handed `{id}` replaced with "1"
 * returns a 404, or worse, somebody else's metadata.
 */
export function padTokenIdHex(tokenId: bigint): string {
  if (tokenId < 0n) throw new Error(`a token id cannot be negative, got ${tokenId}`);
  if (tokenId >= 1n << 256n) throw new Error(`${tokenId} does not fit in a uint256`);
  return tokenId.toString(16).padStart(64, "0");
}
