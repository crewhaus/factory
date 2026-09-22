import type { RegisteredTool } from "@crewhaus/tool-catalog";
/**
 * The ABI codec this package uses, which is somebody else's.
 *
 * `@crewhaus/tool-onchain` owns the encoder, the decoder, the EIP-55
 * checksum and the Multicall3 packing. It publishes the first three as
 * TOOLS rather than as functions — its module surface is `RegisteredTool`s
 * plus the multicall helpers — so this file calls those tools' `execute`
 * directly and parses the JSON they return.
 *
 * That indirection is deliberate and cheap. The alternative is a second ABI
 * encoder living here, and a second encoder is a second set of tail offsets
 * to get wrong: calldata with a misplaced offset is accepted by every node
 * and misread by the contract, which is a wrong answer rather than an error.
 * One encoder, one place it can be wrong, one place it gets fixed.
 *
 * The four-byte selectors below are constants because computing them needs
 * Keccak, which this package does not depend on. They are not trusted on
 * sight: `lib.test.ts` recomputes every one of them with `tool-onchain`'s
 * own `FunctionSelector` and fails if a digit is off.
 */
import { abiDecode, abiEncodeCall, addressCheck } from "@crewhaus/tool-onchain";
import { ChainCallError } from "./rpc";

/** Read a tool result that is known to be a JSON string. */
async function toolJson(
  tool: RegisteredTool,
  input: unknown,
  what: string,
): Promise<Record<string, unknown>> {
  const result = await tool.execute(input);
  if (typeof result !== "string") {
    throw new ChainCallError(`${what}: ${tool.name} returned non-text content`);
  }
  return JSON.parse(result) as Record<string, unknown>;
}

/** Encode a call from a signature and its arguments. Throws on a bad type. */
export async function encodeCallData(
  signature: string,
  args: ReadonlyArray<unknown>,
  what: string,
): Promise<string> {
  const out = await toolJson(abiEncodeCall, { signature, args }, what);
  const encoded = out["data"];
  if (typeof encoded !== "string") throw new ChainCallError(`${what}: could not encode the call`);
  return encoded;
}

/** Decode return data against a list of ABI types. */
export async function decodeValues(
  types: ReadonlyArray<string>,
  hex: string,
  what: string,
): Promise<unknown[]> {
  const out = await toolJson(abiDecode, { data: hex, types }, what);
  const values = out["values"];
  if (!Array.isArray(values)) throw new ChainCallError(`${what}: could not decode the result`);
  return values;
}

export type CheckedAddress = {
  /** EIP-55 mixed case, which is what goes into any output. */
  readonly address: string;
  readonly lowercase: string;
  /**
   * Whether the input CARRIED a checksum this verified. An all-lowercase
   * address is well-formed and unverifiable, and the difference matters
   * enough that it travels with the answer rather than collapsing into
   * "valid".
   */
  readonly checksumVerified: boolean;
  readonly isZero: boolean;
};

/** Validate an address through `tool-onchain`'s EIP-55 implementation. */
export async function checkAddress(raw: string, what: string): Promise<CheckedAddress> {
  const out = await toolJson(addressCheck, { address: raw }, what);
  if (out["valid"] !== true) {
    throw new ChainCallError(`${what}: ${String(out["reason"] ?? "not a valid address")}`);
  }
  return {
    address: String(out["checksummed"]),
    lowercase: String(out["lowercase"]),
    checksumVerified: out["hadChecksum"] === true,
    isZero: out["isZero"] === true,
  };
}

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

/**
 * Selectors this package builds calldata from, with the signature each one
 * is the hash of. `lib.test.ts` recomputes all of them.
 */
export const SELECTORS = Object.freeze({
  /** Multicall3, self-called inside a batch to learn the block it ran at. */
  getBlockNumber: "0x42cbb15c",
  /** Multicall3, so a native balance can be read inside a batch. */
  getEthBalance: "0x4d2301cc",
  /** ERC-20. */
  balanceOf: "0x70a08231",
  /** ERC-165. */
  supportsInterface: "0x01ffc9a7",
  /** What a transparent or UUPS proxy tends to expose as a view. */
  implementation: "0x5c60da1b",
  /** EIP-1822's marker method; also what EIP-1967 UUPS proxies implement. */
  proxiableUUID: "0x52d1902d",
} as const);

/** The signature each selector above is the Keccak prefix of. */
export const SELECTOR_SIGNATURES: Readonly<Record<keyof typeof SELECTORS, string>> = Object.freeze({
  getBlockNumber: "getBlockNumber()",
  getEthBalance: "getEthBalance(address)",
  balanceOf: "balanceOf(address)",
  supportsInterface: "supportsInterface(bytes4)",
  implementation: "implementation()",
  proxiableUUID: "proxiableUUID()",
});

/** Left-pad an address into a 32-byte argument word. */
export function addressArg(address: string): string {
  return address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

/** Right-pad a `bytes4` into its 32-byte argument word. */
export function bytes4Arg(id: string): string {
  const body = id.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(body)) {
    throw new ChainCallError(`an interface id is 0x followed by 8 hex digits, got "${id}"`);
  }
  return body.padEnd(64, "0");
}

/** `supportsInterface(interfaceId)` calldata. */
export function supportsInterfaceData(interfaceId: string): string {
  return `${SELECTORS.supportsInterface}${bytes4Arg(interfaceId)}`;
}

/** `getEthBalance(account)` calldata, for Multicall3. */
export function getEthBalanceData(account: string): string {
  return `${SELECTORS.getEthBalance}${addressArg(account)}`;
}

/** `balanceOf(account)` calldata, for an ERC-20. */
export function balanceOfData(account: string): string {
  return `${SELECTORS.balanceOf}${addressArg(account)}`;
}
