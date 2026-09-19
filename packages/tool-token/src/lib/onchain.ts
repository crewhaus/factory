/**
 * The bridge to `@crewhaus/tool-onchain`, which owns the arithmetic.
 *
 * EIP-55 checksumming and decimal↔base-unit conversion are NOT re-implemented
 * here. Both are short enough to look trivial and both have a failure mode
 * that is silent: a checksum derived from a keccak that is really SHA3-256
 * validates nothing, and a `formatUnits` that rounds loses the low digits of
 * a balance without saying so. The repository already has one of each,
 * checked against the EIP's own vectors, so this package calls those rather
 * than becoming the second copy that disagrees.
 *
 * They arrive as tools rather than as functions because `tool-onchain`
 * publishes only its tool surface. That makes these wrappers `async` for work
 * that is pure — a real cost, paid a handful of times per call, and cheaper
 * than a second EIP-55.
 */
import { addressCheck, tokenUnits } from "@crewhaus/tool-onchain";

/** What `AddressCheck` says about one address. */
export type AddressVerdict = {
  readonly valid: boolean;
  /** The EIP-55 mixed-case form; "" when the input is not a well-formed address. */
  readonly checksummed: string;
  /** The comparison key. Addresses are compared lowercased, never checksummed. */
  readonly lowercase: string;
  /** True when the input carried a checksum that was verified, not merely a shape. */
  readonly hadChecksum: boolean;
  readonly isZero: boolean;
  readonly reason: string;
};

/**
 * `ToolExecuteResult` is a union of a string and a structured content block.
 * Both of these tools return the string arm; anything else means the tool
 * changed shape underneath us, and saying so beats a cast that decodes
 * garbage.
 */
async function textResult(result: unknown, tool: string): Promise<string> {
  const value = await result;
  if (typeof value !== "string") throw new Error(`${tool} did not return a string result`);
  return value;
}

export async function checkAddress(raw: string): Promise<AddressVerdict> {
  return JSON.parse(
    await textResult(addressCheck.execute({ address: raw }), "AddressCheck"),
  ) as AddressVerdict;
}

/**
 * Render base units as an exact decimal string.
 *
 * `decimals` is the token's own answer, never a default. There is no path
 * through this file that supplies 18 for a token that did not say 18.
 */
export async function formatUnits(baseUnits: bigint, decimals: number): Promise<string> {
  const out = JSON.parse(
    await textResult(
      tokenUnits.execute({ amount: baseUnits.toString(), decimals, toDecimal: true }),
      "TokenUnits",
    ),
  ) as { decimal: string };
  return out.decimal;
}

/**
 * The widest decimals `TokenUnits` will convert. A token reporting more than
 * this is reported with its raw balance and no decimal form: uint8 decimals
 * goes to 255, and nothing legitimate is out there at 200.
 */
export const MAX_FORMATTABLE_DECIMALS = 77;
