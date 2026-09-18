/**
 * ABI encoding and decoding.
 *
 * Producing calldata by hand is exactly the kind of work that looks easy and
 * is not: every value is padded into a 32-byte word, dynamic values move to
 * a tail and leave an offset behind, and a wrong offset produces calldata
 * that a node accepts and a contract misreads. A model asked to do this will
 * sometimes produce something plausible, and the transaction is irreversible.
 *
 * Integers are handled as `bigint` throughout. A `uint256` does not fit in a
 * double, and reading one as a number silently loses the low bits of any
 * balance above about nine quadrillion wei — which is nine thousandths of an
 * ether.
 */
import { keccak256, toHex } from "@crewhaus/tool-encode";

const WORD = 32;

export type AbiValue = string | bigint | boolean | number | AbiValue[];

/** A parsed ABI type. Tuples carry their components. */
export type AbiType = {
  readonly base: string;
  readonly bits: number;
  /** -1 for a dynamic array, a length for a fixed one, null when not an array. */
  readonly arrayLength: number | null;
  readonly child: AbiType | null;
  readonly components: ReadonlyArray<AbiType>;
  readonly dynamic: boolean;
  /** Canonical form, which is what the selector is computed over. */
  readonly canonical: string;
};

const INT_RE = /^(u?int)(\d*)$/;
const BYTES_RE = /^bytes(\d*)$/;

/** Split a top-level comma list, respecting nested parentheses and brackets. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

export function parseType(raw: string): AbiType {
  const text = raw.trim();
  if (text === "") throw new Error("an empty string is not an ABI type");

  // Array suffix, innermost last: `uint256[2][]` is a dynamic array of
  // fixed-length-2 arrays, so the LAST suffix is the outer type.
  const arrayMatch = /^(.*)\[(\d*)\]$/.exec(text);
  if (arrayMatch) {
    const child = parseType(arrayMatch[1] as string);
    const length = arrayMatch[2] === "" ? -1 : Number.parseInt(arrayMatch[2] as string, 10);
    if (length === 0)
      throw new Error(`"${text}" has a zero-length array, which cannot hold a value`);
    return {
      base: "array",
      bits: 0,
      arrayLength: length,
      child,
      components: [],
      dynamic: length === -1 || child.dynamic,
      canonical: `${child.canonical}[${length === -1 ? "" : length}]`,
    };
  }

  if (text.startsWith("(") && text.endsWith(")")) {
    const components = splitTop(text.slice(1, -1)).map(parseType);
    return {
      base: "tuple",
      bits: 0,
      arrayLength: null,
      child: null,
      components,
      dynamic: components.some((c) => c.dynamic),
      canonical: `(${components.map((c) => c.canonical).join(",")})`,
    };
  }

  if (text === "address") {
    return {
      base: "address",
      bits: 160,
      arrayLength: null,
      child: null,
      components: [],
      dynamic: false,
      canonical: "address",
    };
  }
  if (text === "bool") {
    return {
      base: "bool",
      bits: 8,
      arrayLength: null,
      child: null,
      components: [],
      dynamic: false,
      canonical: "bool",
    };
  }
  if (text === "string") {
    return {
      base: "string",
      bits: 0,
      arrayLength: null,
      child: null,
      components: [],
      dynamic: true,
      canonical: "string",
    };
  }

  const intMatch = INT_RE.exec(text);
  if (intMatch) {
    // Bare `uint` and `int` mean 256 bits, and the canonical form — the one
    // the selector is hashed over — always spells it out.
    const bits = intMatch[2] === "" ? 256 : Number.parseInt(intMatch[2] as string, 10);
    if (bits % 8 !== 0 || bits < 8 || bits > 256) {
      throw new Error(
        `"${text}" is not a valid integer width; it must be a multiple of 8 from 8 to 256`,
      );
    }
    return {
      base: intMatch[1] as string,
      bits,
      arrayLength: null,
      child: null,
      components: [],
      dynamic: false,
      canonical: `${intMatch[1]}${bits}`,
    };
  }

  const bytesMatch = BYTES_RE.exec(text);
  if (bytesMatch) {
    if (bytesMatch[1] === "") {
      return {
        base: "bytes",
        bits: 0,
        arrayLength: null,
        child: null,
        components: [],
        dynamic: true,
        canonical: "bytes",
      };
    }
    const size = Number.parseInt(bytesMatch[1] as string, 10);
    if (size < 1 || size > 32)
      throw new Error(`"${text}" is not a valid fixed bytes size; it must be 1 to 32`);
    return {
      base: "bytesN",
      bits: size * 8,
      arrayLength: null,
      child: null,
      components: [],
      dynamic: false,
      canonical: `bytes${size}`,
    };
  }

  throw new Error(`"${text}" is not an ABI type this understands`);
}

function hexToBytes(raw: string, what: string): Uint8Array {
  const text = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (text.length % 2 !== 0) throw new Error(`${what} has an odd number of hex digits`);
  if (!/^[0-9a-fA-F]*$/.test(text)) throw new Error(`${what} is not hex`);
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Two's complement into a 32-byte word, big-endian. */
function wordFromBigInt(value: bigint, signed: boolean, bits: number, what: string): Uint8Array {
  const limit = 1n << BigInt(bits);
  let v = value;
  if (signed) {
    const half = limit >> 1n;
    if (v >= half || v < -half) {
      throw new Error(`${what}: ${value} does not fit in an int${bits}`);
    }
    if (v < 0n) v += limit;
  } else {
    if (v < 0n) throw new Error(`${what}: ${value} is negative, and the type is unsigned`);
    if (v >= limit) throw new Error(`${what}: ${value} does not fit in a uint${bits}`);
  }
  const out = new Uint8Array(WORD);
  for (let i = WORD - 1; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  // A negative value sign-extends to the full word.
  if (signed && value < 0n) {
    const bytes = bits / 8;
    for (let i = 0; i < WORD - bytes; i++) out[i] = 0xff;
  }
  return out;
}

function toBigInt(value: AbiValue, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`${what}: ${value} is not an integer`);
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${what}: ${value} is past the safe integer range, so it has already lost precision — pass it as a string or a bigint`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^-?(0x[0-9a-fA-F]+|\d+)$/.test(text))
      throw new Error(`${what}: "${value}" is not an integer`);
    return BigInt(text);
  }
  throw new Error(`${what}: expected an integer`);
}

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const padRight = (bytes: Uint8Array): Uint8Array => {
  const padded = new Uint8Array(Math.ceil(bytes.length / WORD) * WORD);
  padded.set(bytes);
  return padded;
};

/** Encode one value. Returns head and tail; dynamic values put bytes in the tail. */
function encodeValue(
  type: AbiType,
  value: AbiValue,
  what: string,
): { head: Uint8Array; tail: Uint8Array } {
  const none = new Uint8Array(0);

  if (type.base === "array") {
    const child = type.child as AbiType;
    if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
    if (type.arrayLength !== -1 && value.length !== type.arrayLength) {
      throw new Error(`${what}: expected ${type.arrayLength} items, got ${value.length}`);
    }
    const body = encodeTuple(
      value.map(() => child),
      value,
      what,
    );
    if (type.arrayLength === -1) {
      return {
        head: none,
        tail: concat([wordFromBigInt(BigInt(value.length), false, 256, what), body]),
      };
    }
    return type.dynamic ? { head: none, tail: body } : { head: body, tail: none };
  }

  if (type.base === "tuple") {
    if (!Array.isArray(value)) throw new Error(`${what}: expected an array of components`);
    if (value.length !== type.components.length) {
      throw new Error(
        `${what}: expected ${type.components.length} components, got ${value.length}`,
      );
    }
    const body = encodeTuple(type.components, value, what);
    return type.dynamic ? { head: none, tail: body } : { head: body, tail: none };
  }

  if (type.base === "string" || type.base === "bytes") {
    const bytes =
      type.base === "string"
        ? new TextEncoder().encode(String(value))
        : hexToBytes(String(value), what);
    return {
      head: none,
      tail: concat([wordFromBigInt(BigInt(bytes.length), false, 256, what), padRight(bytes)]),
    };
  }

  if (type.base === "address") {
    const bytes = hexToBytes(String(value), what);
    if (bytes.length !== 20)
      throw new Error(`${what}: an address is 20 bytes, got ${bytes.length}`);
    const word = new Uint8Array(WORD);
    word.set(bytes, 12);
    return { head: word, tail: none };
  }

  if (type.base === "bool") {
    if (typeof value !== "boolean") throw new Error(`${what}: expected true or false`);
    return { head: wordFromBigInt(value ? 1n : 0n, false, 8, what), tail: none };
  }

  if (type.base === "bytesN") {
    const bytes = hexToBytes(String(value), what);
    const size = type.bits / 8;
    if (bytes.length !== size)
      throw new Error(`${what}: bytes${size} needs ${size} bytes, got ${bytes.length}`);
    // Fixed bytes are LEFT-aligned; integers are right-aligned. Getting this
    // backwards produces a word a contract reads as a completely different
    // value.
    const word = new Uint8Array(WORD);
    word.set(bytes, 0);
    return { head: word, tail: none };
  }

  return {
    head: wordFromBigInt(toBigInt(value, what), type.base === "int", type.bits, what),
    tail: none,
  };
}

/** Head/tail encoding for a list of types, which is what a tuple is. */
export function encodeTuple(
  types: ReadonlyArray<AbiType>,
  values: ReadonlyArray<AbiValue>,
  what = "argument",
): Uint8Array {
  const parts = types.map((type, i) => encodeValue(type, values[i] as AbiValue, `${what}[${i}]`));
  // Each dynamic value occupies one word in the head, holding the offset of
  // its bytes from the start of THIS tuple — not from the start of the call.
  const headSize = types.reduce(
    (sum, type, i) => sum + (type.dynamic ? WORD : (parts[i] as { head: Uint8Array }).head.length),
    0,
  );

  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = headSize;
  for (const [i, type] of types.entries()) {
    const part = parts[i] as { head: Uint8Array; tail: Uint8Array };
    if (type.dynamic) {
      heads.push(wordFromBigInt(BigInt(tailOffset), false, 256, what));
      tails.push(part.tail);
      tailOffset += part.tail.length;
    } else {
      heads.push(part.head);
    }
  }
  return concat([...heads, ...tails]);
}

/** The canonical signature a selector is hashed over. */
export function canonicalSignature(name: string, types: ReadonlyArray<AbiType>): string {
  return `${name}(${types.map((t) => t.canonical).join(",")})`;
}

export function selectorOf(signature: string): string {
  return toHex(keccak256(new TextEncoder().encode(signature))).slice(0, 8);
}

/** Split `transfer(address,uint256)` into its name and parsed argument types. */
export function parseSignature(signature: string): { name: string; types: AbiType[] } {
  const open = signature.indexOf("(");
  if (open === -1 || !signature.trim().endsWith(")")) {
    throw new Error(`"${signature}" is not a function signature — expected name(type,type)`);
  }
  const name = signature.slice(0, open).trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`"${name}" is not a valid function name`);
  }
  const inner = signature.slice(open + 1, signature.lastIndexOf(")"));
  return { name, types: inner.trim() === "" ? [] : splitTop(inner).map(parseType) };
}

export function encodeCall(signature: string, args: ReadonlyArray<AbiValue>): string {
  const { name, types } = parseSignature(signature);
  if (args.length !== types.length) {
    throw new Error(`${name} takes ${types.length} argument(s), ${args.length} given`);
  }
  const canonical = canonicalSignature(name, types);
  return `0x${selectorOf(canonical)}${toHex(encodeTuple(types, args))}`;
}

// ---------------------------------------------------------------------------

/** Decoded values use strings for integers, so a uint256 survives JSON. */
export type Decoded = string | boolean | Decoded[];

function wordAt(data: Uint8Array, offset: number, what: string): Uint8Array {
  if (offset + WORD > data.length) {
    throw new Error(
      `${what}: the data ends before offset ${offset}, so it is truncated or mistyped`,
    );
  }
  return data.subarray(offset, offset + WORD);
}

function bigIntFromWord(word: Uint8Array, signed: boolean, bits: number): bigint {
  let value = 0n;
  for (const byte of word) value = (value << 8n) | BigInt(byte);
  if (!signed) return value;
  const limit = 1n << BigInt(bits);
  const half = limit >> 1n;
  const truncated = value & (limit - 1n);
  return truncated >= half ? truncated - limit : truncated;
}

function decodeValue(type: AbiType, data: Uint8Array, offset: number, what: string): Decoded {
  if (type.base === "array") {
    const child = type.child as AbiType;
    if (type.arrayLength === -1) {
      const length = Number(bigIntFromWord(wordAt(data, offset, what), false, 256));
      if (length * WORD > data.length) {
        throw new Error(`${what}: claims ${length} items, more than the data could hold`);
      }
      return decodeTuple(new Array<AbiType>(length).fill(child), data, offset + WORD, what);
    }
    return decodeTuple(
      new Array<AbiType>(type.arrayLength as number).fill(child),
      data,
      offset,
      what,
    );
  }
  if (type.base === "tuple") return decodeTuple(type.components, data, offset, what);

  if (type.base === "string" || type.base === "bytes") {
    const length = Number(bigIntFromWord(wordAt(data, offset, what), false, 256));
    const start = offset + WORD;
    if (start + length > data.length) {
      throw new Error(`${what}: declares ${length} bytes, past the end of the data`);
    }
    const bytes = data.subarray(start, start + length);
    return type.base === "string" ? new TextDecoder().decode(bytes) : `0x${toHex(bytes)}`;
  }

  const word = wordAt(data, offset, what);
  if (type.base === "address") return `0x${toHex(word.subarray(12))}`;
  if (type.base === "bool") {
    const value = bigIntFromWord(word, false, 256);
    if (value > 1n)
      throw new Error(`${what}: a bool word holds ${value}, which is neither true nor false`);
    return value === 1n;
  }
  if (type.base === "bytesN") return `0x${toHex(word.subarray(0, type.bits / 8))}`;
  return bigIntFromWord(word, type.base === "int", type.bits).toString();
}

export function decodeTuple(
  types: ReadonlyArray<AbiType>,
  data: Uint8Array,
  base = 0,
  what = "value",
): Decoded[] {
  const out: Decoded[] = [];
  let head = base;
  for (const [i, type] of types.entries()) {
    const label = `${what}[${i}]`;
    if (type.dynamic) {
      const offset = Number(bigIntFromWord(wordAt(data, head, label), false, 256));
      // An offset is relative to the start of the enclosing tuple. Treating
      // it as absolute reads the wrong bytes and usually still "works".
      out.push(decodeValue(type, data, base + offset, label));
      head += WORD;
    } else {
      out.push(decodeValue(type, data, head, label));
      head += staticSize(type);
    }
  }
  return out;
}

/** How many bytes a static type occupies in a head. */
function staticSize(type: AbiType): number {
  if (type.base === "tuple") return type.components.reduce((s, c) => s + staticSize(c), 0);
  if (type.base === "array")
    return (type.arrayLength as number) * staticSize(type.child as AbiType);
  return WORD;
}

export function decodeData(typeList: ReadonlyArray<string>, hex: string): Decoded[] {
  const types = typeList.map(parseType);
  return decodeTuple(types, hexToBytes(hex, "data"));
}
