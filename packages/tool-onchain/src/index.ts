/**
 * @crewhaus/tool-onchain — the onchain arithmetic, offline.
 *
 * Everything here is pure: no RPC, no network, no keys. These are the
 * calculations that must be right before a transaction is composed, and that
 * a model will sometimes get plausibly wrong — calldata with a misplaced
 * offset, an address with a typo no checksum caught, a `minOut` computed in
 * floating point, an EIP-712 digest over the wrong type string.
 *
 * **Nothing here signs anything.** No private key is accepted, read or
 * handled. `TypedDataHash` computes the digest a wallet would sign, which is
 * what lets a signature request be CHECKED before it is approved: hash the
 * message a human was actually shown and compare it against what the dapp
 * asked for.
 *
 * Integers are `bigint` or decimal strings. A uint256 does not fit in a
 * double, and reading a balance as a number silently loses its low bits.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { keccak256Hex } from "@crewhaus/tool-encode";
import { z } from "zod";
import { type AbiValue, decodeData, encodeCall, parseSignature, selectorOf } from "./lib/abi";
import { formatUnits, parseUnits, validateAddress } from "./lib/address";
import {
  healthFactorBps,
  maximumIn,
  minimumOut,
  priceImpactBps,
  rescaleDecimals,
  shareBps,
} from "./lib/defi";
import { personalSignHash, typedDataDigest } from "./lib/typed";

const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = { args: 256, types: 64, hexChars: 2_000_000 } as const;

/** Accepts a bigint-safe integer: a decimal or hex string, or a safe number. */
const integerish = z.union([z.string(), z.number().int(), z.bigint()]);

const bigintFrom = (value: string | number | bigint, what: string): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${what}: ${value} is past the safe integer range, so it has already lost precision — pass it as a string`,
      );
    }
    return BigInt(value);
  }
  const text = value.trim();
  if (!/^-?(0x[0-9a-fA-F]+|\d+)$/.test(text))
    throw new Error(`${what}: "${value}" is not an integer`);
  return BigInt(text);
};

// ---------------------------------------------------------------------------

export const abiEncodeCall: RegisteredTool = buildTool({
  name: "AbiEncodeCall",
  description:
    "Build the calldata for a contract call from a function signature and its arguments, returning the 0x hex and the four-byte selector. Use it instead of having a model assemble words by hand: every value is padded into a 32-byte slot, dynamic values move to a tail and leave an offset behind, and a wrong offset produces calldata a node accepts and a contract misreads. Handles uint/int of any width, address, bool, fixed and dynamic bytes, string, arrays and tuples. It composes calldata and never sends it.",
  inputSchema: z.object({
    signature: z.string().min(3).describe("e.g. transfer(address,uint256)"),
    args: z
      .array(z.unknown())
      .max(LIMITS.args)
      .describe("one per parameter; integers as strings or numbers, bytes as 0x hex"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { name, types } = parseSignature(input.signature);
    const canonical = `${name}(${types.map((t) => t.canonical).join(",")})`;
    const data = encodeCall(input.signature, input.args as ReadonlyArray<AbiValue>);
    return json({
      data,
      selector: `0x${selectorOf(canonical)}`,
      // The canonical form is what the selector is hashed over, and it can
      // differ from what was written: `uint` is `uint256` here.
      canonicalSignature: canonical,
      argumentTypes: types.map((t) => t.canonical),
      bytes: (data.length - 2) / 2,
    });
  },
});

export const abiDecode: RegisteredTool = buildTool({
  name: "AbiDecode",
  description:
    "Decode ABI-encoded hex — an eth_call result, a log's data, a transaction's arguments, revert data — into named, typed values. Use it to read a contract's answer without a model squinting at 32-byte words. Integers come back as decimal STRINGS so a uint256 survives JSON intact; addresses come back lowercase and hex-prefixed. Data that ends early is an error rather than a plausible short answer.",
  inputSchema: z.object({
    data: z.string().max(LIMITS.hexChars).describe("0x hex, without a function selector"),
    types: z.array(z.string()).min(1).max(LIMITS.types).describe('e.g. ["uint256", "address"]'),
    names: z.array(z.string()).max(LIMITS.types).optional().describe("labels for the values"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const values = decodeData(input.types, input.data);
    const names = input.names ?? [];
    return json({
      values,
      named:
        names.length === 0
          ? undefined
          : Object.fromEntries(values.map((v, i) => [names[i] ?? `arg${i}`, v])),
      types: input.types,
    });
  },
});

export const functionSelector: RegisteredTool = buildTool({
  name: "FunctionSelector",
  description:
    "Compute the four-byte selector of a function signature, or the 32-byte topic of an event signature, with Keccak-256. Use it to identify what a transaction calls, to build a log filter, or to check that a selector in a block explorer is what you think. It canonicalises the signature first — `uint` becomes `uint256`, which changes the answer — so it agrees with what a compiler produces rather than with what was typed.",
  inputSchema: z.object({
    signature: z
      .string()
      .min(3)
      .describe("e.g. transfer(address,uint256) or Transfer(address,address,uint256)"),
    kind: z
      .enum(["function", "event"])
      .optional()
      .describe("function (4 bytes, default) or event (32)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { name, types } = parseSignature(input.signature);
    const canonical = `${name}(${types.map((t) => t.canonical).join(",")})`;
    const full = keccak256Hex(canonical);
    return json({
      canonicalSignature: canonical,
      selector: `0x${full.slice(0, 8)}`,
      topic: `0x${full}`,
      value: input.kind === "event" ? `0x${full}` : `0x${full.slice(0, 8)}`,
      canonicalised: canonical !== input.signature.trim(),
    });
  },
});

export const addressCheck: RegisteredTool = buildTool({
  name: "AddressCheck",
  description:
    "Validate an Ethereum address and return its EIP-55 checksummed form. Use it before composing any transfer: an address is 20 raw bytes with no check digits of its own, and EIP-55 adds a checksum by varying the case of the hex — so a mixed-case address can be verified and a typo caught, while an all-lowercase one cannot be. The result says which of those happened rather than letting a bare 'valid' be read as 'verified', and flags the zero address.",
  inputSchema: z.object({
    address: z.string().min(1),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => json(validateAddress(input.address)),
});

export const typedDataHash: RegisteredTool = buildTool({
  name: "TypedDataHash",
  description:
    "Compute the EIP-712 digest a wallet would sign, together with the domain separator, the struct hash and the encoded type string. Use it to CHECK a signature request before approving it: hash the message a human was actually shown and compare it against what the dapp asked for. It also computes the EIP-191 personal_sign hash. It computes digests and never signs — no private key is accepted anywhere in this package.",
  inputSchema: z
    .object({
      domain: z
        .object({
          name: z.string().optional(),
          version: z.string().optional(),
          chainId: integerish.optional(),
          verifyingContract: z.string().optional(),
          salt: z.string().optional(),
        })
        .optional(),
      types: z
        .record(z.array(z.object({ name: z.string(), type: z.string() })))
        .optional()
        .describe("the EIP-712 type definitions; EIP712Domain is ignored if present"),
      primaryType: z.string().optional(),
      message: z.record(z.unknown()).optional(),
      /** The EIP-191 path, which needs none of the above. */
      personalSignMessage: z
        .string()
        .optional()
        .describe("hash this as a personal_sign message instead"),
    })
    .refine(
      (v) =>
        v.personalSignMessage !== undefined ||
        (v.domain !== undefined &&
          v.types !== undefined &&
          v.primaryType !== undefined &&
          v.message !== undefined),
      {
        message:
          "give either personalSignMessage, or all of domain, types, primaryType and message",
      },
    ),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    if (input.personalSignMessage !== undefined) {
      return json({
        scheme: "eip191",
        digest: personalSignHash(input.personalSignMessage),
        messageBytes: new TextEncoder().encode(input.personalSignMessage).length,
      });
    }
    return json({
      scheme: "eip712",
      ...typedDataDigest(
        input.domain as Record<string, never>,
        input.types as Record<string, Array<{ name: string; type: string }>>,
        input.primaryType as string,
        input.message as Record<string, unknown>,
      ),
      note: "this is the digest a wallet would sign; nothing here signs it",
    });
  },
});

export const tokenUnits: RegisteredTool = buildTool({
  name: "TokenUnits",
  description:
    "Convert between a decimal amount and a token's base units, exactly, in either direction. This is token decimals, not physical units — `UnitConvert` in @crewhaus/tool-math converts metres and kilograms. Use it for every amount that goes into a transaction: `0.1 * 1e18` in floating point is not 10^17, and the difference is real money. It refuses an amount with more decimal places than the token has rather than dropping the extra digits, and it converts between two different decimalisations — six-decimal USDC and eighteen-decimal DAI hold the same amount as integers a trillion apart.",
  inputSchema: z
    .object({
      amount: z.string().min(1).describe("a decimal amount, or base units when toDecimal is set"),
      decimals: z
        .number()
        .int()
        .min(0)
        .max(77)
        .describe("the token's decimals; 18 for ether, 6 for USDC"),
      toDecimal: z
        .boolean()
        .optional()
        .describe("treat `amount` as base units and render it as a decimal"),
      toDecimals: z
        .number()
        .int()
        .min(0)
        .max(77)
        .optional()
        .describe("rescale base units to another token's decimals"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    if (input.toDecimals !== undefined) {
      const base = bigintFrom(input.amount, "amount");
      return json({
        baseUnits: rescaleDecimals(base, input.decimals, input.toDecimals),
        fromDecimals: input.decimals,
        toDecimals: input.toDecimals,
      });
    }
    if (input.toDecimal) {
      const base = bigintFrom(input.amount, "amount");
      return json({
        decimal: formatUnits(base, input.decimals),
        baseUnits: base.toString(),
        decimals: input.decimals,
      });
    }
    const base = parseUnits(input.amount, input.decimals);
    return json({ baseUnits: base.toString(), decimal: input.amount, decimals: input.decimals });
  },
});

export const defiMath: RegisteredTool = buildTool({
  name: "DefiMath",
  description:
    "Do the fixed-point arithmetic a swap or a lending position needs: the minimum output for a slippage tolerance, the maximum input for an exact-output swap, price impact against a reference mid, a pool share, and a health factor. Use it because these are integer calculations in base units where the DIRECTION of a rounding error matters — a minimum is rounded down and a maximum up, since rounding a bound the wrong way rejects a swap that was inside tolerance or accepts one that was not. Slippage is basis points, never a percentage, because a percentage invites a decimal and a decimal invites a float.",
  inputSchema: z.discriminatedUnion("operation", [
    z.object({
      operation: z.literal("minimumOut"),
      quotedOut: integerish.describe("base units the quote promises"),
      slippageBps: z.number().int().min(0).max(10_000),
    }),
    z.object({
      operation: z.literal("maximumIn"),
      quotedIn: integerish,
      slippageBps: z.number().int().min(0).max(10_000),
    }),
    z.object({
      operation: z.literal("priceImpact"),
      executionPrice: integerish,
      referencePrice: integerish,
    }),
    z.object({ operation: z.literal("share"), part: integerish, total: integerish }),
    z.object({
      operation: z.literal("healthFactor"),
      collateralBase: integerish,
      debtBase: integerish,
      liquidationThresholdBps: z.number().int().min(0).max(10_000),
    }),
  ]),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    switch (input.operation) {
      case "minimumOut":
        return json(minimumOut(bigintFrom(input.quotedOut, "quotedOut"), input.slippageBps));
      case "maximumIn":
        return json({
          quotedIn: bigintFrom(input.quotedIn, "quotedIn").toString(),
          slippageBps: input.slippageBps,
          maxIn: maximumIn(bigintFrom(input.quotedIn, "quotedIn"), input.slippageBps),
        });
      case "priceImpact":
        return json({
          impactBps: priceImpactBps(
            bigintFrom(input.executionPrice, "executionPrice"),
            bigintFrom(input.referencePrice, "referencePrice"),
          ),
        });
      case "share":
        return json({
          shareBps: shareBps(bigintFrom(input.part, "part"), bigintFrom(input.total, "total")),
        });
      default: {
        const health = healthFactorBps(
          bigintFrom(input.collateralBase, "collateralBase"),
          bigintFrom(input.debtBase, "debtBase"),
          input.liquidationThresholdBps,
        );
        return json({
          healthFactorBps: health,
          liquidatable: health === null ? false : health < 10_000,
          // No debt has no health factor. Reporting Infinity would be read as
          // safe by a caller comparing against a threshold, and NaN as unsafe.
          note: health === null ? "no debt, so there is no health factor" : "",
        });
      }
    }
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const ONCHAIN_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  abiDecode,
  abiEncodeCall,
  addressCheck,
  defiMath,
  functionSelector,
  typedDataHash,
  tokenUnits,
]);
