/**
 * Every tool this package registers, through its own `execute`.
 *
 * The package-wide block is the contract the runtime relies on, and one
 * claim in it is load-bearing: nothing here signs, so no schema anywhere
 * accepts a private key.
 */
import { describe, expect, test } from "bun:test";
import {
  ONCHAIN_TOOLS,
  abiDecode,
  abiEncodeCall,
  addressCheck,
  defiMath,
  functionSelector,
  tokenUnits,
  typedDataHash,
} from "./index";

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

async function raw(tool: (typeof ONCHAIN_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return tool.execute(parsed.data, ctx);
}

async function call<T = Record<string, unknown>>(
  tool: (typeof ONCHAIN_TOOLS)[number],
  input: unknown,
): Promise<T> {
  return JSON.parse(await raw(tool, input)) as T;
}

describe("package-wide contract", () => {
  test("every tool is exported in ONCHAIN_TOOLS", () => {
    expect(ONCHAIN_TOOLS.length).toBe(7);
  });

  test("names are unique and PascalCase", () => {
    const names = ONCHAIN_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ONCHAIN_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive and internal — none reaches a chain", () => {
    for (const t of ONCHAIN_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("no schema anywhere accepts a private key", () => {
    // The package computes digests and calldata; signing is a different job
    // with different consequences, and there is no field to pass a key to.
    const shapes = ONCHAIN_TOOLS.map((t) =>
      JSON.stringify(Object.keys((t.inputSchema as never as { shape?: object }).shape ?? {})),
    ).join(" ");
    for (const forbidden of ["privateKey", "secret", "mnemonic", "seed", "keystore"]) {
      expect({ forbidden, present: shapes.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  test("every description says what it is for", () => {
    for (const t of ONCHAIN_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use it");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of ONCHAIN_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });
});

describe("AbiEncodeCall", () => {
  test("produces real calldata and reports the canonical signature", async () => {
    const result = await call<{ data: string; selector: string; canonicalSignature: string }>(
      abiEncodeCall,
      {
        signature: "transfer(address,uint)",
        args: [VITALIK, "1000000000000000000"],
      },
    );
    expect(result.selector).toBe("0xa9059cbb");
    expect(result.canonicalSignature).toBe("transfer(address,uint256)");
    expect(result.data).toStartWith("0xa9059cbb");
  });

  test("a value that does not fit is an error, not truncated calldata", async () => {
    await expect(raw(abiEncodeCall, { signature: "f(uint8)", args: ["256"] })).rejects.toThrow(
      /uint8/,
    );
  });
});

describe("AbiDecode", () => {
  test("decodes and can name the values", async () => {
    const result = await call<{ named: Record<string, unknown> }>(abiDecode, {
      data: `0x${"0".repeat(62)}2a`,
      types: ["uint256"],
      names: ["balance"],
    });
    expect(result.named).toEqual({ balance: "42" });
  });

  test("truncated data is an error", async () => {
    await expect(raw(abiDecode, { data: "0x00", types: ["uint256"] })).rejects.toThrow(/truncated/);
  });
});

describe("FunctionSelector", () => {
  test("gives the event topic everybody knows", async () => {
    const result = await call<{ topic: string; value: string }>(functionSelector, {
      signature: "Transfer(address,address,uint256)",
      kind: "event",
    });
    expect(result.topic).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(result.value).toBe(result.topic);
  });

  test("reports when canonicalising changed the signature", async () => {
    const result = await call<{ canonicalised: boolean; selector: string }>(functionSelector, {
      signature: "transfer(address,uint)",
    });
    expect(result.canonicalised).toBe(true);
    expect(result.selector).toBe("0xa9059cbb");
  });
});

describe("AddressCheck", () => {
  test("a checksummed address verifies", async () => {
    expect(await call(addressCheck, { address: VITALIK })).toMatchObject({
      valid: true,
      hadChecksum: true,
      checksummed: VITALIK,
    });
  });

  test("a lowercase address is valid but unverified, and says so", async () => {
    const result = await call<{ valid: boolean; hadChecksum: boolean; reason: string }>(
      addressCheck,
      {
        address: VITALIK.toLowerCase(),
      },
    );
    expect(result).toMatchObject({ valid: true, hadChecksum: false });
    expect(result.reason).toContain("cannot be detected");
  });

  test("a typo in a checksummed address is caught", async () => {
    expect(
      await call(addressCheck, { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046" }),
    ).toMatchObject({
      valid: false,
    });
  });
});

describe("TypedDataHash", () => {
  test("computes the specification's digest and says it did not sign it", async () => {
    const result = await call<{ digest: string; note: string; scheme: string }>(typedDataHash, {
      domain: {
        name: "Ether Mail",
        version: "1",
        chainId: 1,
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      },
      types: {
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
        Mail: [
          { name: "from", type: "Person" },
          { name: "to", type: "Person" },
          { name: "contents", type: "string" },
        ],
      },
      primaryType: "Mail",
      message: {
        from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
        to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
        contents: "Hello, Bob!",
      },
    });
    expect(result.scheme).toBe("eip712");
    expect(result.digest).toBe(
      "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2",
    );
    expect(result.note).toContain("nothing here signs it");
  });

  test("the EIP-191 path needs nothing else", async () => {
    const result = await call<{ scheme: string; digest: string }>(typedDataHash, {
      personalSignMessage: "Hello, world!",
    });
    expect(result.scheme).toBe("eip191");
    expect(result.digest).toBe(
      "0xb453bd4e271eed985cbab8231da609c4ce0a9cf1f763b6c1594e76315510e0f1",
    );
  });

  test("a half-specified EIP-712 request is rejected by the schema", () => {
    expect(typedDataHash.inputSchema.safeParse({ primaryType: "Mail" }).success).toBe(false);
  });
});

describe("TokenUnits", () => {
  test("converts both ways exactly", async () => {
    expect(await call(tokenUnits, { amount: "0.1", decimals: 18 })).toMatchObject({
      baseUnits: "100000000000000000",
    });
    expect(
      await call(tokenUnits, { amount: "100000000000000000", decimals: 18, toDecimal: true }),
    ).toMatchObject({
      decimal: "0.1",
    });
  });

  test("rescales between two decimalisations", async () => {
    expect(
      await call(tokenUnits, { amount: "1000000", decimals: 6, toDecimals: 18 }),
    ).toMatchObject({
      baseUnits: "1000000000000000000",
    });
  });

  test("too many decimal places is refused rather than truncated", async () => {
    await expect(raw(tokenUnits, { amount: "0.1234567", decimals: 6 })).rejects.toThrow(
      /silently dropped/,
    );
  });
});

describe("DefiMath", () => {
  test("a minimum out is rounded down", async () => {
    expect(
      await call(defiMath, {
        operation: "minimumOut",
        quotedOut: "1000000000000000000",
        slippageBps: 50,
      }),
    ).toMatchObject({
      minOut: "995000000000000000",
    });
  });

  test("no debt has no health factor and is not liquidatable", async () => {
    expect(
      await call(defiMath, {
        operation: "healthFactor",
        collateralBase: "1500",
        debtBase: "0",
        liquidationThresholdBps: 8000,
      }),
    ).toMatchObject({ healthFactorBps: null, liquidatable: false });
  });

  test("an unknown operation is rejected by the schema", () => {
    expect(defiMath.inputSchema.safeParse({ operation: "guess", a: 1 }).success).toBe(false);
  });
});
