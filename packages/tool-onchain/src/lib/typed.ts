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
import { type AbiValue, encodeTuple, parseType } from "./abi";

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

/** The struct types `primary` refers to, transitively. */
function referencedTypes(
  primary: string,
  types: TypedTypes,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(primary)) return seen;
  const fields = types[primary];
  if (!fields) return seen;
  seen.add(primary);
  for (const field of fields) {
    const base = field.type.replace(/(\[\d*\])+$/, "");
    if (types[base]) referencedTypes(base, types, seen);
  }
  return seen;
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
      const fields = types[name];
      if (!fields) throw new Error(`the type "${name}" is referenced but not defined`);
      return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    })
    .join("");
}

export function typeHash(primary: string, types: TypedTypes): Uint8Array {
  return hash(encoder.encode(encodeType(primary, types)));
}

/** One field, as the 32 bytes it contributes to a struct's encoding. */
function encodeField(type: string, value: unknown, types: TypedTypes, what: string): Uint8Array {
  const arrayMatch = /^(.*)\[(\d*)\]$/.exec(type);
  if (arrayMatch) {
    if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
    const inner = arrayMatch[1] as string;
    const expected = arrayMatch[2];
    if (
      expected !== undefined &&
      expected !== "" &&
      value.length !== Number.parseInt(expected, 10)
    ) {
      throw new Error(`${what}: expected ${expected} items, got ${value.length}`);
    }
    // An array contributes the hash of its members' encodings.
    return hash(concat(value.map((item, i) => encodeField(inner, item, types, `${what}[${i}]`))));
  }

  if (types[type]) return hashStruct(type, value as Record<string, unknown>, types);

  if (type === "string") return hash(encoder.encode(String(value)));
  if (type === "bytes") {
    const text = String(value).replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]*$/.test(text)) throw new Error(`${what}: bytes must be hex`);
    const bytes = new Uint8Array(text.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    }
    return hash(bytes);
  }

  // Everything else must be an atomic ABI type. When it is not, the likely
  // mistake is a struct named in a field and left out of `types`, so say
  // both possibilities rather than only "not an ABI type".
  try {
    return encodeTuple([parseType(type)], [value as AbiValue], what);
  } catch (err) {
    throw new Error(
      `${what}: "${type}" is neither a struct defined in types nor an ABI type (${(err as Error).message})`,
    );
  }
}

export function hashStruct(
  primary: string,
  data: Record<string, unknown>,
  types: TypedTypes,
): Uint8Array {
  const fields = types[primary];
  if (!fields) throw new Error(`the type "${primary}" is not defined`);
  const parts = [typeHash(primary, types)];
  for (const field of fields) {
    if (!(field.name in data)) {
      throw new Error(
        `"${primary}" requires the field "${field.name}", which the message does not have`,
      );
    }
    parts.push(encodeField(field.type, data[field.name], types, `${primary}.${field.name}`));
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
  const structHash = hashStruct(primaryType, message, withoutDomain);
  const digest = hash(concat([new Uint8Array([0x19, 0x01]), separator, structHash]));
  return {
    digest: `0x${toHex(digest)}`,
    domainSeparator: `0x${toHex(separator)}`,
    messageHash: `0x${toHex(structHash)}`,
    typeHash: `0x${toHex(typeHash(primaryType, withoutDomain))}`,
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
