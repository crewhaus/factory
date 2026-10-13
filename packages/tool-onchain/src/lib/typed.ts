/**
 * EIP-712 typed-data hashing and EIP-191 message hashing.
 *
 * This computes the digest a wallet signs. It does NOT sign: no private key
 * is accepted, read or handled anywhere in this package. Producing the
 * digest is arithmetic over a schema and can be checked; holding a key is a
 * different job with different consequences.
 *
 * The value of computing it separately is that a signature request can be
 * checked BEFORE it is approved — a digest computed from the message a human
 * was actually shown, compared against the one the dapp asked for.
 */
import { keccak256, toHex } from "@crewhaus/tool-encode";
import {
  type AbiType,
  type AbiValue,
  MAX_TYPE_DEPTH,
  bytesArg,
  encodeTuple,
  parseType,
} from "./abi";

export type TypedField = { readonly name: string; readonly type: string };
export type TypedTypes = Readonly<Record<string, ReadonlyArray<TypedField>>>;

const encoder = new TextEncoder();
const hash = (bytes: Uint8Array): Uint8Array => keccak256(bytes);

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

/**
 * The outermost array suffix of `type` — `Foo[2][]` is `Foo[2]` with a
 * dynamic suffix — or `undefined` when it has none. Read from the end, one
 * character at a time: the regex this replaces backtracked in the square of
 * the type's length, and a type string is the caller's.
 */
function outerArraySuffix(type: string): { inner: string; length: string } | undefined {
  if (type.charCodeAt(type.length - 1) !== CLOSE_BRACKET) return undefined;
  let i = type.length - 2;
  while (i >= 0 && isDigit(type.charCodeAt(i))) i--;
  if (i < 0 || type.charCodeAt(i) !== OPEN_BRACKET) return undefined;
  return { inner: type.slice(0, i), length: type.slice(i + 1, -1) };
}

/** `type` without its array suffixes, and how many it had, in one pass. */
function withoutArraySuffixes(type: string): { base: string; depth: number } {
  let base = type;
  let depth = 0;
  for (let suffix = outerArraySuffix(base); suffix !== undefined; ) {
    base = suffix.inner;
    depth++;
    suffix = outerArraySuffix(base);
  }
  return { base, depth };
}

/** The struct types `primary` refers to, transitively. */
function referencedTypes(
  primary: string,
  types: TypedTypes,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(primary)) return seen;
  const fields = structFields(types, primary);
  if (!fields) return seen;
  seen.add(primary);
  for (const field of fields) {
    const { base } = withoutArraySuffixes(field.type);
    if (structFields(types, base)) referencedTypes(base, types, seen);
  }
  return seen;
}

/**
 * The fields of the struct `name`, when `types` DEFINES it — an own property.
 *
 * A plain lookup walks the prototype chain, so a type named `constructor` or
 * `toString` "exists" in every types object: a field of that type was then
 * hashed as a struct whose field list is a function, instead of being refused
 * as a type nobody defined.
 */
function structFields(types: TypedTypes, name: string): ReadonlyArray<TypedField> | undefined {
  return Object.hasOwn(types, name) ? types[name] : undefined;
}

/**
 * `encodeType`: the primary struct first, then every referenced struct in
 * alphabetical order. The order is part of the standard — a different order
 * gives a different type hash and therefore a signature no verifier accepts.
 */
export function encodeType(primary: string, types: TypedTypes): string {
  const referenced = [...referencedTypes(primary, types)].filter((t) => t !== primary).sort();
  return [primary, ...referenced]
    .map((name) => {
      const fields = structFields(types, name);
      if (!fields) throw new Error(`the type "${name}" is referenced but not defined`);
      return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    })
    .join("");
}

export function typeHash(primary: string, types: TypedTypes): Uint8Array {
  return hash(encoder.encode(encodeType(primary, types)));
}

/**
 * One digest's hashing: the types, and each struct's type hash computed
 * once. `hashStruct` needs the type hash of its struct for EVERY instance,
 * and computing it re-encodes every struct that one refers to — so a
 * message of many small instances cost its count times the size of the
 * types.
 */
type Hashing = { readonly types: TypedTypes; readonly typeHashes: Map<string, Uint8Array> };

function cachedTypeHash(ctx: Hashing, primary: string): Uint8Array {
  let known = ctx.typeHashes.get(primary);
  if (known === undefined) {
    known = typeHash(primary, ctx.types);
    ctx.typeHashes.set(primary, known);
  }
  return known;
}

/** A caller's text in a refusal, cut to a length a message can carry. */
function clip(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 80)}… (${text.length} characters)`;
}

/**
 * Every struct `primary` reaches, checked before anything is hashed: each
 * field's type must be a struct `types` defines (with array suffixes, at
 * most as many as an ABI type may nest) or an ABI type the coder parses.
 * Checked on use alone, a struct referenced but never instantiated (in an
 * empty array) went into the encoded type unexamined, and the digest came
 * back "ok" over a type string no wallet would accept.
 */
function checkTypes(primary: string, types: TypedTypes): void {
  if (!structFields(types, primary)) throw new Error(`the type "${clip(primary)}" is not defined`);
  for (const name of referencedTypes(primary, types)) {
    for (const field of structFields(types, name) ?? []) {
      const what = `${clip(name)}.${clip(field.name)}`;
      const { base, depth } = withoutArraySuffixes(field.type);
      if (structFields(types, base)) {
        if (depth > MAX_TYPE_DEPTH) {
          throw new Error(
            `${what}: "${clip(field.type)}" nests arrays more than ${MAX_TYPE_DEPTH} levels deep`,
          );
        }
        continue;
      }
      try {
        parseType(field.type);
      } catch (err) {
        throw new Error(
          `${what}: "${clip(field.type)}" is neither a struct defined in types nor an ABI type (${(err as Error).message})`,
        );
      }
    }
  }
}

/** One field, as the 32 bytes it contributes to a struct's encoding. */
function encodeField(ctx: Hashing, type: string, value: unknown, what: string): Uint8Array {
  const types = ctx.types;
  const array = outerArraySuffix(type);
  if (array) {
    if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
    const expected = array.length;
    if (expected !== "" && value.length !== Number.parseInt(expected, 10)) {
      throw new Error(`${what}: expected ${expected} items, got ${value.length}`);
    }
    // An array contributes the hash of its members' encodings.
    return hash(
      concat(value.map((item, i) => encodeField(ctx, array.inner, item, `${what}[${i}]`))),
    );
  }

  if (structFields(types, type)) return structHash(ctx, type, value);

  if (type === "string") {
    // A number or a boolean reads as the text it prints as. An object does
    // not: String({}) is "[object Object]", a value nobody was shown.
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`${what}: a string field takes text, not ${describeValue(value)}`);
    }
    return hash(encoder.encode(String(value)));
  }
  // The coder's own strict decoder: an odd digit count is refused rather
  // than its last nibble dropped, which made 0xabc hash as 0xab.
  if (type === "bytes") return hash(bytesArg(value, what));

  // Everything else must be an atomic ABI type. When it is not, the likely
  // mistake is a struct named in a field and left out of `types`, so say
  // both possibilities rather than only "not an ABI type".
  let parsed: AbiType;
  try {
    parsed = parseType(type);
  } catch (err) {
    throw new Error(
      `${what}: "${type}" is neither a struct defined in types nor an ABI type (${(err as Error).message})`,
    );
  }
  // Outside the try: a value the type refuses — an address whose checksum
  // fails — is the value's problem, not an unknown type's.
  return encodeTuple([parsed], [value as AbiValue], what);
}

/** What a value is, for a refusal: "an array", "null", "a number". */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

export function hashStruct(primary: string, data: unknown, types: TypedTypes): Uint8Array {
  return structHash({ types, typeHashes: new Map() }, primary, data);
}

function structHash(ctx: Hashing, primary: string, data: unknown): Uint8Array {
  const fields = structFields(ctx.types, primary);
  if (!fields) throw new Error(`the type "${primary}" is not defined`);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`"${primary}" expects an object for its fields, got ${describeValue(data)}`);
  }
  const record = data as Record<string, unknown>;
  const parts = [cachedTypeHash(ctx, primary)];
  for (const field of fields) {
    // An OWN field. `in` also sees what every object inherits, so a message
    // missing "toString" was hashed over the source text of
    // Object.prototype.toString — a digest of a value nobody was shown —
    // instead of being refused like any other missing field.
    if (!Object.hasOwn(record, field.name)) {
      throw new Error(
        `"${primary}" requires the field "${field.name}", which the message does not have`,
      );
    }
    parts.push(encodeField(ctx, field.type, record[field.name], `${primary}.${field.name}`));
  }
  return hash(concat(parts));
}

export type Domain = {
  readonly name?: string;
  readonly version?: string;
  readonly chainId?: number | string;
  readonly verifyingContract?: string;
  readonly salt?: string;
};

/**
 * The domain separator.
 *
 * Only the fields actually present are included, in the standard's order.
 * Including an absent field, or reordering them, changes the separator and
 * therefore binds the signature to a domain nobody will verify against.
 */
export function domainSeparator(domain: Domain): Uint8Array {
  const order: Array<[keyof Domain, string]> = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "uint256"],
    ["verifyingContract", "address"],
    ["salt", "bytes32"],
  ];
  const present = order.filter(([key]) => domain[key] !== undefined);
  const types: TypedTypes = {
    EIP712Domain: present.map(([name, type]) => ({ name: name as string, type })),
  };
  return hashStruct("EIP712Domain", domain as Record<string, unknown>, types);
}

export type TypedDataResult = {
  readonly digest: string;
  readonly domainSeparator: string;
  readonly messageHash: string;
  readonly typeHash: string;
  readonly encodedType: string;
  readonly primaryType: string;
};

/** The EIP-712 digest: keccak256(0x1901 then domainSeparator then hashStruct). */
export function typedDataDigest(
  domain: Domain,
  types: TypedTypes,
  primaryType: string,
  message: Record<string, unknown>,
): TypedDataResult {
  // A caller may pass the full JSON payload, EIP712Domain included; it is
  // defined by the standard and must not take part in encodeType.
  const withoutDomain: TypedTypes = Object.fromEntries(
    Object.entries(types).filter(([name]) => name !== "EIP712Domain"),
  );
  const separator = domainSeparator(domain);
  checkTypes(primaryType, withoutDomain);
  const ctx: Hashing = { types: withoutDomain, typeHashes: new Map() };
  const messageHash = structHash(ctx, primaryType, message);
  const digest = hash(concat([new Uint8Array([0x19, 0x01]), separator, messageHash]));
  return {
    digest: `0x${toHex(digest)}`,
    domainSeparator: `0x${toHex(separator)}`,
    messageHash: `0x${toHex(messageHash)}`,
    typeHash: `0x${toHex(cachedTypeHash(ctx, primaryType))}`,
    encodedType: encodeType(primaryType, withoutDomain),
    primaryType,
  };
}

/**
 * The 0x19 byte that begins every EIP-191 signed payload.
 *
 * Built from its code point rather than written as an escape: a formatter
 * that rewrites the escape into the raw byte would put a control character
 * into this file, and a file carrying one is not parsed identically by every
 * engine. The same rewrite once broke this repository's CI.
 */
const EIP191_PREFIX = String.fromCharCode(0x19);

/**
 * EIP-191 `personal_sign`.
 *
 * The prefix is what stops a signed message from being replayable as a
 * transaction. The length is the BYTE length, not the character count, so
 * any non-ASCII character hashes differently if that is got wrong.
 */
export function personalSignHash(message: string): string {
  const bytes = encoder.encode(message);
  const prefix = encoder.encode(`${EIP191_PREFIX}Ethereum Signed Message:\n${bytes.length}`);
  return `0x${toHex(hash(concat([prefix, bytes])))}`;
}
