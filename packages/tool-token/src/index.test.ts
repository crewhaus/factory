import { afterEach, describe, expect, test } from "bun:test";
/**
 * The three tools, driven through their own `execute` against recorded chain
 * answers.
 *
 * The refusal paths get more room than the happy ones, because the refusals
 * are the product. A symbol that means two addresses, a token whose
 * `decimals()` reverts, a contract with no code at it, a tokenURI pointing at
 * somebody's internal network — each of those has a wrong answer that looks
 * exactly like a right one, and each is asserted here by its REASON rather
 * than by the fact that something failed.
 *
 * Every test drives `_setChainReader`, and the metadata seam is left unbound
 * unless a test is about fetching. Nothing here opens a socket.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  ALICE,
  APE_NFT,
  BOB,
  BROKEN,
  CYRILLIC_LIST,
  CYRILLIC_USDC,
  type ContractHandler,
  GAME_1155,
  IMPOSTOR_USDC,
  LIAR_165,
  MKR,
  NOTHING,
  NOT_A_CONTRACT,
  ONCHAIN_NFT,
  RIVAL_LIST,
  SPENDER,
  UNISWAP_LIST,
  USDC,
  answers,
  chainStub,
  encodeUint,
  erc20,
  erc721,
  erc1155,
  revertWith,
  reverts,
} from "./fixtures";
import { TOKEN_TOOLS, erc20Balance, erc721TokenInfo, tokenResolve } from "./index";
import { READ_METHODS, _setChainReader } from "./lib/chain";
import { SELECTOR } from "./lib/erc";
import { _setMetadataFetch } from "./lib/uri";

const low = (address: string): string => address.toLowerCase();
const GATEWAY = "https://gateway.example/ipfs/";

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
type Json = any;

async function call(tool: RegisteredTool, input: unknown): Promise<Json> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  const out = await tool.execute(parsed.data, {} as never);
  if (typeof out !== "string") throw new Error("expected a string result");
  return JSON.parse(out) as Json;
}

const DECIMALS_REVERT = await revertWith("decimals: not implemented");
const NO_SUCH_TOKEN = await revertWith("ERC721: owner query for nonexistent token");

/** A token whose metadata is broken in three different ways at once. */
const brokenToken: ContractHandler = (selector) => {
  if (selector === SELECTOR.decimals) return reverts(DECIMALS_REVERT);
  if (selector === SELECTOR.symbol) return NOTHING;
  if (selector === SELECTOR.name) return answers(`0x${"ff".repeat(32)}`);
  if (selector === SELECTOR.totalSupply) return answers(encodeUint(1_000n));
  if (selector === SELECTOR.balanceOf) return answers(encodeUint(42n));
  return NOTHING;
};

function mainnet(extra: Record<string, ContractHandler> = {}) {
  return chainStub({
    blockNumber: 19_000_000n,
    nativeBalances: { [low(ALICE)]: 2_500_000_000_000_000_000n, [low(BOB)]: 0n },
    contracts: {
      [low(USDC)]: erc20({
        decimals: 6n,
        symbol: "USDC",
        name: "USD Coin",
        totalSupply: 25_000_000_000_000n,
        balances: { [low(ALICE)]: 1_500_000n, [low(BOB)]: 0n },
        allowances: { [`${low(ALICE)}:${low(SPENDER)}`]: (1n << 256n) - 1n },
      }),
      [low(MKR)]: erc20({
        decimals: 18n,
        symbol: "MKR",
        name: "Maker",
        totalSupply: 1_000_000_000_000_000_000_000_000n,
        balances: { [low(ALICE)]: 2_500_000_000_000_000_000n },
        bytes32Metadata: true,
      }),
      [low(IMPOSTOR_USDC)]: erc20({
        decimals: 6n,
        symbol: "USDC",
        name: "USD Coin",
        totalSupply: 0n,
      }),
      [low(CYRILLIC_USDC)]: erc20({
        decimals: 6n,
        symbol: "USD\u0421",
        name: "USD Coin",
        totalSupply: 1n,
      }),
      [low(BROKEN)]: brokenToken,
      [low(APE_NFT)]: erc721({
        name: "Bored Ape Yacht Club",
        symbol: "BAYC",
        owners: { "1": ALICE },
        tokenUris: { "1": "ipfs://QmMeta/1.json", "2": "https://metadata.example/2.json" },
        missingTokenRevert: NO_SUCH_TOKEN,
      }),
      [low(ONCHAIN_NFT)]: erc721({
        name: "Fully On-chain",
        symbol: "OCN",
        owners: { "1": BOB },
        tokenUris: {
          "1": `data:application/json;base64,${Buffer.from(
            '{"name":"On-chain #1","image":"ipfs://QmImage","external_url":"https://example.org/1"}',
          ).toString("base64")}`,
        },
        missingTokenRevert: NO_SUCH_TOKEN,
      }),
      [low(GAME_1155)]: erc1155({
        uriTemplate: "ipfs://QmBase/{id}.json",
        balances: { [`${low(ALICE)}:5`]: 3n },
      }),
      [low(LIAR_165)]: erc721({
        name: "Definitely Real",
        symbol: "REAL",
        owners: { "1": ALICE },
        tokenUris: { "1": "ipfs://QmFake/1.json" },
        missingTokenRevert: NO_SUCH_TOKEN,
        answersEverything: true,
      }),
      ...extra,
    },
  });
}

afterEach(() => {
  _setChainReader(undefined);
  _setMetadataFetch(undefined);
});

// ---------------------------------------------------------------------------

describe("package-wide contract", () => {
  test("all three tools are exported, with unique PascalCase names", () => {
    expect(TOKEN_TOOLS).toHaveLength(3);
    const names = TOKEN_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("the safety flags say what these are: read-only reads that cross a network boundary", () => {
    for (const tool of TOKEN_TOOLS) {
      expect({ name: tool.name, readOnly: tool.readOnly }).toEqual({
        name: tool.name,
        readOnly: true,
      });
      expect({ name: tool.name, destructive: tool.destructive }).toEqual({
        name: tool.name,
        destructive: false,
      });
      expect({ name: tool.name, scope: tool.scope }).toEqual({
        name: tool.name,
        scope: "external",
      });
      expect({ name: tool.name, io: tool.ioCapability }).toEqual({
        name: tool.name,
        io: "network",
      });
      // Token names and NFT metadata are strings a stranger chose.
      expect({ name: tool.name, classify: tool.classifyOutput }).toEqual({
        name: tool.name,
        classify: true,
      });
    }
  });

  test("every description says what the tool is for", () => {
    for (const tool of TOKEN_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(100);
      expect(tool.description).toContain("Use it");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const tool of TOKEN_TOOLS) {
      expect({ name: tool.name, ok: tool.inputSchema.safeParse(42).success }).toEqual({
        name: tool.name,
        ok: false,
      });
    }
  });

  test("no schema accepts a private key, and no code path can submit a transaction", () => {
    // This package reads public state. There is no field to pass a key to and
    // no method it can emit that moves anything, and both halves of that are
    // checked here rather than asserted in a comment.
    const keys: string[] = [];
    type ZodInternals = {
      _def?: { shape?: unknown; schema?: unknown; innerType?: unknown; type?: unknown };
      shape?: unknown;
    };
    const walk = (node: unknown, depth: number): void => {
      if (depth > 8 || node === null || typeof node !== "object") return;
      const def = (node as ZodInternals)._def;
      const shape = (node as ZodInternals).shape ?? def?.shape;
      const resolved = typeof shape === "function" ? (shape as () => unknown)() : shape;
      if (resolved !== null && typeof resolved === "object") {
        for (const [key, value] of Object.entries(resolved as Record<string, unknown>)) {
          keys.push(key);
          walk(value, depth + 1);
        }
      }
      // .optional(), .refine() and .array() each wrap the schema under a
      // different key; missing one would walk past a whole nested object and
      // report "no key named privateKey" about fields it never looked at.
      if (def?.schema !== undefined) walk(def.schema, depth + 1);
      if (def?.innerType !== undefined) walk(def.innerType, depth + 1);
      if (def?.type !== undefined) walk(def.type, depth + 1);
    };
    for (const tool of TOKEN_TOOLS) walk(tool.inputSchema, 0);
    expect(keys.length).toBeGreaterThan(20);
    // Proof the walk descended past the top level: these live inside the
    // token-list array's element object, two wrappers down.
    for (const nested of ["tokens", "symbol", "decimals"]) expect(keys).toContain(nested);
    for (const forbidden of ["privateKey", "secret", "mnemonic", "seed", "keystore", "signature"]) {
      expect({
        forbidden,
        present: keys.some((k) => k.toLowerCase().includes(forbidden.toLowerCase())),
      }).toEqual({
        forbidden,
        present: false,
      });
    }

    // And the submission methods appear nowhere in the code — only, in one
    // file, inside the comment that explains why they do not.
    const dir = join(import.meta.dir, "lib");
    const sources = [
      readFileSync(join(import.meta.dir, "index.ts"), "utf8"),
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => readFileSync(join(dir, f), "utf8")),
    ];
    expect(sources.length).toBeGreaterThan(4);
    const code = sources
      .map((text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      .join("\n");
    // Guard the guard: a comment-stripper that ate the whole file would make
    // every assertion below pass without reading a line of code.
    expect(code.length).toBeGreaterThan(10_000);
    expect(code).toContain("eth_call");
    for (const forbidden of ["eth_send", "eth_sign", "signTransaction", "privateKey"]) {
      expect({ forbidden, inCode: code.includes(forbidden) }).toEqual({ forbidden, inCode: false });
    }
  });

  test("this package's own sources carry none of the characters it warns about", () => {
    // A package that flags zero-width padding in somebody else's token symbol
    // has no business hiding any in its own source, and an editor or a paste
    // will put one there eventually. U+0000 is included because it is the
    // separator the list fingerprint uses and it must live in the source as an
    // escape, not as a byte.
    const dir = join(import.meta.dir, "lib");
    const files = [
      join(import.meta.dir, "index.ts"),
      join(import.meta.dir, "fixtures.ts"),
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(dir, f)),
    ];
    const forbidden = (point: number): boolean =>
      point === 0 ||
      point === 0x00ad ||
      point === 0xfeff ||
      point === 0xfffd ||
      (point >= 0x200b && point <= 0x200f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2060 && point <= 0x2064);
    for (const file of files) {
      const found = [...readFileSync(file, "utf8")]
        .map((ch) => ch.codePointAt(0) as number)
        .filter(forbidden)
        .map((point) => `U+${point.toString(16).toUpperCase().padStart(4, "0")}`);
      expect({ file, found: [...new Set(found)] }).toEqual({ file, found: [] });
    }
    expect(files.length).toBeGreaterThan(5);
  });

  test("the read methods this package can emit are three, and all three are reads", () => {
    expect([...READ_METHODS]).toEqual(["eth_call", "eth_getBalance", "eth_getCode"]);
  });

  test("driving all three tools emits nothing but those read methods", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    await call(erc20Balance, { chainId: 1, token: USDC, accounts: [ALICE] });
    await call(erc721TokenInfo, { chainId: 1, contract: APE_NFT, tokenId: "1" });
    await call(tokenResolve, { chainId: 1, query: "USDC", lists: [UNISWAP_LIST] });
    expect(stub.reads.length).toBeGreaterThan(3);
    for (const read of stub.reads) expect(READ_METHODS).toContain(read.method);
  });
});

// ---------------------------------------------------------------------------

describe("Erc20Balance", () => {
  test("reads balances for several accounts at one block, in base units and decimal", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, { chainId: 1, token: USDC, accounts: [ALICE, BOB] });
    expect(out.token.decimals).toEqual({
      value: 6,
      source: "contract",
      note: "",
      formattable: true,
    });
    expect(out.token.symbol.value).toBe("USDC");
    expect(out.blockNumber).toBe("19000000");
    expect(out.batched).toBe(true);
    expect(out.balances).toEqual([
      { account: ALICE, raw: "1500000", decimal: "1.5" },
      { account: BOB, raw: "0", decimal: "0" },
    ]);
    expect(out.warnings).toEqual([]);
  });

  test("the whole batch is one eth_call, so the balances share a block with the decimals", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    await call(erc20Balance, { chainId: 1, token: USDC, accounts: [ALICE, BOB], checkCode: false });
    expect(stub.reads.filter((r) => r.method === "eth_call")).toHaveLength(1);
  });

  test("a bytes32 symbol — the MKR case — is decoded and reported as what it was", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, { chainId: 1, token: MKR, accounts: [ALICE] });
    expect({ value: out.token.symbol.value, encoding: out.token.symbol.encoding }).toEqual({
      value: "MKR",
      encoding: "bytes32",
    });
    expect(out.balances[0].decimal).toBe("2.5");
    expect(out.warnings.join(" ")).toContain("bytes32 rather than a string");
  });

  test("a token whose decimals() reverts is unknown, and NOT 18", async () => {
    // Scaling by an assumed 18 is how a six-decimal transfer becomes a
    // trillion-fold one. The raw base units are still exact.
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, { chainId: 1, token: BROKEN, accounts: [ALICE] });
    expect(out.token.decimals.value).toBeNull();
    expect(out.token.decimals.source).toBe("unreadable");
    expect(out.token.decimals.note).toContain("NOT 18");
    expect(out.balances[0]).toEqual({ account: ALICE, raw: "42", decimal: null });
  });

  test("a symbol that returns nothing and a name that is not UTF-8 are reported, not crashed on", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, { chainId: 1, token: BROKEN, accounts: [ALICE] });
    expect(out.token.symbol.encoding).toBe("absent");
    expect(out.token.name.encoding).toBe("undecodable");
    expect(out.warnings.join(" ")).toContain("symbol() could not be read");
  });

  test("an allowance is read alongside, and an unlimited one is named as such", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, {
      chainId: 1,
      token: USDC,
      accounts: [ALICE, BOB],
      spender: SPENDER,
    });
    expect(out.balances[0].allowance.spender).toBe(SPENDER);
    expect(out.balances[0].allowance.raw).toBe((2n ** 256n - 1n).toString());
    // Scaled by the token's six decimals, exactly — the last six digits of
    // 2^256-1 end up after the point, and none of them are lost.
    expect(out.balances[0].allowance.decimal).toBe(
      "115792089237316195423570985008687907853269984665640564039457584007913129.639935",
    );
    expect(out.balances[0].allowance.unlimited).toBe(true);
    expect(out.balances[1].allowance).toEqual({
      spender: SPENDER,
      raw: "0",
      decimal: "0",
      unlimited: false,
    });
  });

  test('"native" reads the chain\'s own currency, and says its decimals are a convention', async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, { chainId: 1, token: "native", accounts: [ALICE] });
    expect(out.token.kind).toBe("native");
    expect(out.token.decimals.source).toBe("chain-convention");
    expect(out.token.decimals.note).toContain("not a contract read");
    expect(out.balances[0]).toEqual({ account: ALICE, raw: "2500000000000000000", decimal: "2.5" });
    expect(out.blockNumber).toBe("19000000");
  });

  test("a native balance the batch could not answer is NOT a zero balance", async () => {
    // `multicall3Address` is caller input, and an aggregator that is not the
    // canonical Multicall3 need not carry `getEthBalance` at all. The answer
    // that came back was no answer; reporting it as 0 ETH is the one number a
    // gas check or a drained-wallet alarm would act on without looking.
    const stub = chainStub({ contracts: {}, withoutMulticallHelpers: true });
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, { chainId: 1, token: "native", accounts: [ALICE, BOB] });
    for (const row of out.balances) {
      expect({ raw: row.raw, decimal: row.decimal }).toEqual({ raw: null, decimal: null });
      expect(row.error).toContain("getEthBalance did not answer");
      expect(row.error).toContain("batch:false");
    }
    // And the batch that could not say which block it read is not a snapshot
    // either, which the answer has to say rather than leaving blockNumber null.
    expect(out.blockNumber).toBeNull();
    expect(out.warnings.join(" ")).toContain("cannot be pinned to a block");
  });

  test("native batch:false declares itself not a snapshot, like every other unbatched read", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, {
      chainId: 1,
      token: "native",
      accounts: [ALICE, BOB],
      batch: false,
    });
    expect(out.batched).toBe(false);
    expect(out.warnings.join(" ")).toContain("not guaranteed to be from the same block");
  });

  test("a quantity above 2^53 keeps every digit it came off the chain with", async () => {
    // The whole path — decode, scale, render — at a size where a double has
    // run out of mantissa. 2^53 is 16 digits; these are 30, and the last of
    // them is the one a float drops.
    const balance = 123_456_789_012_345_678_901_234_567_890n;
    const allowance = (1n << 90n) + 1n;
    const stub = mainnet({
      [low(USDC)]: erc20({
        decimals: 18n,
        symbol: "BIG",
        name: "Big",
        totalSupply: (1n << 255n) - 1n,
        balances: { [low(ALICE)]: balance },
        allowances: { [`${low(ALICE)}:${low(SPENDER)}`]: allowance },
      }),
    });
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, {
      chainId: 1,
      token: USDC,
      accounts: [ALICE],
      spender: SPENDER,
    });
    expect(out.balances[0].raw).toBe("123456789012345678901234567890");
    expect(out.balances[0].decimal).toBe("123456789012.34567890123456789");
    expect(out.balances[0].allowance.raw).toBe(allowance.toString());
    expect(out.balances[0].allowance.decimal).toBe("1237940039.285380274899124225");
    expect(out.balances[0].allowance.unlimited).toBe(false);
    expect(out.token.totalSupply).toBe(((1n << 255n) - 1n).toString());
  });

  test("native unbatched goes through eth_getBalance and reports no block", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, {
      chainId: 1,
      token: "native",
      accounts: [ALICE],
      batch: false,
    });
    expect(out.balances[0].raw).toBe("2500000000000000000");
    expect(stub.reads.some((r) => r.method === "eth_getBalance")).toBe(true);
  });

  test("unbatched reads warn that they are not a snapshot", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc20Balance, {
      chainId: 1,
      token: USDC,
      accounts: [ALICE],
      batch: false,
    });
    expect(out.balances[0].decimal).toBe("1.5");
    expect(out.warnings.join(" ")).toContain("not guaranteed to be from the same block");
    expect(out.blockNumber).toBeNull();
  });

  // ─── refusals ─────────────────────────────────────────────────────────────

  test("refuses a symbol where an address belongs, and says where to get one", async () => {
    _setChainReader(mainnet().reader);
    await expect(
      call(erc20Balance, { chainId: 1, token: "USDC", accounts: [ALICE] }),
    ).rejects.toThrow("resolve it with TokenResolve first");
  });

  test("refuses an address with no code rather than reporting everyone's balance as zero", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    await expect(
      call(erc20Balance, { chainId: 1, token: NOT_A_CONTRACT, accounts: [ALICE] }),
    ).rejects.toThrow("there is no contract at");
  });

  test("names WHICH account failed its checksum", async () => {
    _setChainReader(mainnet().reader);
    await expect(
      call(erc20Balance, {
        chainId: 1,
        token: USDC,
        accounts: [ALICE, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046"],
      }),
    ).rejects.toThrow("accounts[1]");
  });

  test("refuses a block tag that is not one", async () => {
    _setChainReader(mainnet().reader);
    await expect(
      call(erc20Balance, { chainId: 1, token: USDC, accounts: [ALICE], blockTag: "yesterday" }),
    ).rejects.toThrow("is not a block tag");
  });

  test("refuses when there is no chain reader, naming the spec block to write", async () => {
    await expect(
      call(erc20Balance, { chainId: 1, token: USDC, accounts: [ALICE] }),
    ).rejects.toThrow("no chain is configured, so chain 1 cannot be read. Declare it in the spec");
  });

  test("a Multicall3 that answers with something else is refused, with the way out", async () => {
    const stub = chainStub({
      contracts: { [low(USDC)]: erc20({ decimals: 6n, symbol: "U", name: "U", totalSupply: 0n }) },
      brokenBatchAnswer: "0xdeadbeef",
    });
    _setChainReader(stub.reader);
    await expect(
      call(erc20Balance, { chainId: 1, token: USDC, accounts: [ALICE] }),
    ).rejects.toThrow("batch:false");
  });

  test("the schema refuses more accounts than it will read", () => {
    const tooMany = Array.from({ length: 101 }, () => ALICE);
    expect(
      erc20Balance.inputSchema.safeParse({ chainId: 1, token: USDC, accounts: tooMany }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("TokenResolve", () => {
  test("resolves a symbol one list carries, confirmed against the contract", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(tokenResolve, { chainId: 1, query: "USDC", lists: [UNISWAP_LIST] });
    expect(out.resolved).toBe(true);
    expect(out.verified).toBe(true);
    // The checksummed form is what a caller pastes into a transaction.
    expect(out.token.address).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(out.token.decimals.value).toBe(6);
    expect(out.token.listedBy).toEqual(["uniswap-default"]);
    expect(out.listsFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("an address that two lists agree on is one candidate, not two", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const second = { id: "second", tokens: [UNISWAP_LIST.tokens[0]] };
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "USDC",
      lists: [UNISWAP_LIST, second],
    });
    expect(out.resolved).toBe(true);
    expect(out.token.listedBy).toEqual(["uniswap-default", "second"]);
  });

  test("REFUSES when two lists mean different addresses, and returns both", async () => {
    // This is the whole reason the tool exists. Neither address is returned
    // as the answer, and the caller is told to say which one it means.
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "USDC",
      lists: [UNISWAP_LIST, RIVAL_LIST],
    });
    expect(out.resolved).toBe(false);
    expect(out.refusal.code).toBe("ambiguous-symbol");
    expect(out.refusal.message).toContain("Pass the address you mean");
    expect(out.token).toBeUndefined();
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates.map((c: Json) => c.checksummed).sort()).toEqual(
      [
        "0x1111111111111111111111111111111111111111",
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ].sort(),
    );
    const impostor = out.candidates.find((c: Json) => c.address.startsWith("0x1111"));
    expect(impostor.flags).toContain("zero-total-supply");
  });

  test("a homoglyph ticker is pulled into the candidate set, so it becomes an ambiguity", async () => {
    // A literal match would have found only the real USDC and resolved it —
    // fine here, but the same list is what a later lookup of the impostor's
    // own ticker would resolve against. Widening can only refuse, never
    // mis-resolve.
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "USDC",
      lists: [UNISWAP_LIST, CYRILLIC_LIST],
    });
    expect(out.resolved).toBe(false);
    expect(out.refusal.code).toBe("ambiguous-symbol");
    const impostor = out.candidates.find((c: Json) => c.address === low(CYRILLIC_USDC));
    expect(impostor.matchedBy).toContain("symbol-confusable");
    expect(impostor.flags).toContain("confusable-match");
    expect(impostor.flags).toContain("suspicious-listed-symbol");
  });

  test("REFUSES a query that is itself a homoglyph, before reading anything", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "USD\u0421",
      lists: [UNISWAP_LIST, CYRILLIC_LIST],
    });
    expect(out.resolved).toBe(false);
    expect(out.refusal.code).toBe("confusable-query");
    expect(out.refusal.message).toContain("folds to");
    // Nothing was read: the refusal happens before any candidate is gathered.
    expect(stub.reads).toHaveLength(0);
  });

  test("REFUSES a symbol with no list to resolve it against", async () => {
    _setChainReader(mainnet().reader);
    const out = await call(tokenResolve, { chainId: 1, query: "USDC" });
    expect(out.refusal.code).toBe("no-lists");
    expect(out.refusal.message).toContain("will not pick one for you");
  });

  test("REFUSES a symbol no list carries", async () => {
    _setChainReader(mainnet().reader);
    const out = await call(tokenResolve, { chainId: 1, query: "NOTATOKEN", lists: [UNISWAP_LIST] });
    expect(out.refusal.code).toBe("no-candidates");
  });

  test("REFUSES an address whose EIP-55 checksum does not hold", async () => {
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB49",
    });
    expect(out.refusal.code).toBe("invalid-address");
    expect(out.refusal.message).toContain("checksum");
  });

  test("REFUSES the zero address", async () => {
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "0x0000000000000000000000000000000000000000",
    });
    expect(out.refusal.code).toBe("zero-address");
  });

  test("REFUSES the zero address when it arrives through a LIST rather than as the query", async () => {
    // The zero-address check used to sit on the query, so a symbol whose list
    // entry was the zero address walked straight past it — and with
    // checkCode:false there was no second line of defence either. It came
    // back resolved:true, verified:true, pointing at the burn address.
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "NUL",
      checkCode: false,
      confirmOnchain: false,
      lists: [
        {
          id: "shady-list",
          tokens: [
            {
              chainId: 1,
              address: "0x0000000000000000000000000000000000000000",
              symbol: "NUL",
              name: "Null",
              decimals: 18,
            },
          ],
        },
      ],
    });
    expect(out.resolved).toBe(false);
    expect(out.refusal.code).toBe("zero-address");
    expect(out.refusal.message).toContain("burned");
    expect(out.token).toBeUndefined();
  });

  test("REFUSES a list entry whose address is not an address, instead of resolving to none", async () => {
    // `tokens[].address` is `z.string().min(1)` — a list carries whatever it
    // carries. An entry that is not an address used to resolve with
    // token.address === "", which is what the checksummer returns for a string
    // it cannot read, and which a caller would happily pass on.
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "WEIRD",
      confirmOnchain: false,
      lists: [
        {
          id: "junk-list",
          tokens: [
            { chainId: 1, address: "not-an-address", symbol: "WEIRD", name: "Weird", decimals: 18 },
          ],
        },
      ],
    });
    expect(out.resolved).toBe(false);
    expect(out.refusal.code).toBe("invalid-list-address");
    expect(out.refusal.message).toContain("junk-list");
    expect(out.badAddress).toBe("not-an-address");
    expect(out.token).toBeUndefined();
  });

  test("a malformed list address is refused BEFORE it reaches the ABI encoder", async () => {
    // The onchain path used to hand it to encodeAggregate3, which threw
    // "call[1].target: an address starts with 0x" — a message about a batch
    // index, several frames from the list entry that caused it, and not a
    // TokenError at all.
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "WEIRD",
      lists: [
        {
          id: "junk-list",
          tokens: [
            { chainId: 1, address: "0xdeadbeef", symbol: "WEIRD", name: "Weird", decimals: 18 },
          ],
        },
      ],
    });
    expect(out.refusal.code).toBe("invalid-list-address");
    expect(stub.reads).toEqual([]);
  });

  test("a homoglyph in the contract's OWN name leaves verified false", async () => {
    // The name is the string a wallet shows a human. A Cyrillic о in it is the
    // same trick as one in the ticker, and `verified` used to ignore it —
    // reported in warnings, but true anyway, which is the field a gate reads.
    const stub = mainnet({
      [low(USDC)]: erc20({
        decimals: 6n,
        symbol: "USDC",
        name: "USD Cоin",
        totalSupply: 1n,
      }),
    });
    _setChainReader(stub.reader);
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "USDC",
      lists: [UNISWAP_LIST],
    });
    expect(out.resolved).toBe(true);
    expect(out.verified).toBe(false);
    expect(out.candidates[0].flags).toContain("suspicious-onchain-name");
    // A merely non-ASCII name is not this: plenty of real tokens have one,
    // and flagging those would make `verified` mean nothing.
    const plain = mainnet({
      [low(USDC)]: erc20({ decimals: 6n, symbol: "USDC", name: "USD 币", totalSupply: 1n }),
    });
    _setChainReader(plain.reader);
    const ok = await call(tokenResolve, { chainId: 1, query: "USDC", lists: [UNISWAP_LIST] });
    expect(ok.candidates[0].flags).not.toContain("suspicious-onchain-name");
  });

  test("REFUSES an unlisted address by default, and resolves it when told to", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const refused = await call(tokenResolve, { chainId: 1, query: BROKEN });
    expect(refused.refusal.code).toBe("unlisted");
    expect(refused.refusal.message).toContain('policy:"allow-unlisted"');

    const allowed = await call(tokenResolve, {
      chainId: 1,
      query: BROKEN,
      policy: "allow-unlisted",
    });
    expect(allowed.resolved).toBe(true);
    // Resolved, but nothing vouches for it and its decimals are unreadable.
    expect(allowed.verified).toBe(false);
    expect(allowed.candidates[0].flags).toContain("not-listed");
    expect(allowed.candidates[0].flags).toContain("decimals-unreadable");
  });

  test("REFUSES an address with no contract at it", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(tokenResolve, {
      chainId: 1,
      query: NOT_A_CONTRACT,
      policy: "allow-unlisted",
    });
    expect(out.refusal.code).toBe("not-a-contract");
    expect(out.refusal.message).toContain("somebody's wallet, or a typo");
  });

  test("REFUSES when the contract's decimals disagree with the list's", async () => {
    // Not a cosmetic disagreement: every amount computed from the wrong one
    // is off by a power of ten.
    const stub = mainnet();
    _setChainReader(stub.reader);
    const wrong = {
      id: "wrong-decimals",
      tokens: [{ chainId: 1, address: USDC, symbol: "USDC", name: "USD Coin", decimals: 18 }],
    };
    const out = await call(tokenResolve, { chainId: 1, query: "USDC", lists: [wrong] });
    expect(out.refusal.code).toBe("decimals-mismatch");
    expect(out.refusal.message).toContain("power of ten");
  });

  test("flags a symbol mismatch between the list and the contract without refusing", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const stale = {
      id: "stale",
      tokens: [{ chainId: 1, address: USDC, symbol: "USDCv1", name: "USD Coin", decimals: 6 }],
    };
    const out = await call(tokenResolve, { chainId: 1, query: "USDCv1", lists: [stale] });
    expect(out.resolved).toBe(true);
    expect(out.verified).toBe(false);
    expect(out.candidates[0].flags).toContain("symbol-mismatch");
  });

  test("REFUSES to confirm more candidates than it was allowed to", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(tokenResolve, {
      chainId: 1,
      query: "USDC",
      lists: [UNISWAP_LIST, RIVAL_LIST],
      maxCandidates: 1,
    });
    expect(out.refusal.code).toBe("too-many-candidates");
    expect(out.candidateAddresses).toHaveLength(2);
  });

  test("asking for onchain confirmation with no reader bound is a refusal, not a silent downgrade", async () => {
    await expect(
      call(tokenResolve, {
        chainId: 1,
        query: "USDC",
        lists: [UNISWAP_LIST],
        confirmOnchain: true,
      }),
    ).rejects.toThrow("confirmOnchain was asked for but no chain is configured");
  });

  test("with no reader bound and nothing asked for, it answers from the lists and says so", async () => {
    const out = await call(tokenResolve, { chainId: 1, query: "USDC", lists: [UNISWAP_LIST] });
    expect(out.resolved).toBe(true);
    expect(out.confirmedOnchain).toBe(false);
    expect(out.verified).toBe(false);
    expect(out.warnings.join(" ")).toContain("nothing was confirmed against the chain");
  });

  test("the fingerprint travels with the answer, so a later run can tell the lists moved", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const first = await call(tokenResolve, { chainId: 1, query: "USDC", lists: [UNISWAP_LIST] });
    const second = await call(tokenResolve, {
      chainId: 1,
      query: "USDC",
      lists: [{ ...UNISWAP_LIST, tokens: [...UNISWAP_LIST.tokens].reverse() }],
    });
    expect(first.listsFingerprint).toBe(second.listsFingerprint);
  });
});

// ---------------------------------------------------------------------------

describe("Erc721TokenInfo", () => {
  test("reads an ERC-721 through ERC-165, with the owner checksummed", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc721TokenInfo, { chainId: 1, contract: APE_NFT, tokenId: "1" });
    expect({ standard: out.standard, source: out.standardSource }).toEqual({
      standard: "erc721",
      source: "erc165",
    });
    expect(out.collection.name.value).toBe("Bored Ape Yacht Club");
    expect(out.ownership).toEqual({
      kind: "erc721",
      owner: ALICE,
      matchesOwnerArgument: null,
      reason: "",
    });
    expect(out.interfaces.claimsInvalidInterface).toBe(false);
  });

  test("checks the owner against one the caller already believed", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const right = await call(erc721TokenInfo, {
      chainId: 1,
      contract: APE_NFT,
      tokenId: "1",
      owner: ALICE,
    });
    expect(right.ownership.matchesOwnerArgument).toBe(true);
    const wrong = await call(erc721TokenInfo, {
      chainId: 1,
      contract: APE_NFT,
      tokenId: "1",
      owner: BOB,
    });
    expect(wrong.ownership.matchesOwnerArgument).toBe(false);
  });

  test("an ipfs tokenURI is SKIPPED when no gateway was supplied, with the reason", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc721TokenInfo, { chainId: 1, contract: APE_NFT, tokenId: "1" });
    expect(out.tokenUri.raw).toBe("ipfs://QmMeta/1.json");
    expect(out.tokenUri.plan.action).toBe("skip");
    expect(out.metadata.attempted).toBe(false);
    expect(out.metadata.reason).toContain("no ipfsGateway was supplied");
    expect(out.tokenUri.plan.reason).toContain("no ipfsGateway was supplied");
  });

  test("with a gateway the caller named, it is fetched and reported with its digest", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const body = '{"name":"Ape #1","image":"ipfs://QmImage"}';
    let dialled: string | null = null;
    _setMetadataFetch(async (req) => {
      dialled = req.url;
      return {
        status: 200,
        contentType: "application/json",
        bytes: new TextEncoder().encode(body),
      };
    });
    const out = await call(erc721TokenInfo, {
      chainId: 1,
      contract: APE_NFT,
      tokenId: "1",
      ipfsGateway: GATEWAY,
    });
    expect(dialled).toBe(`${GATEWAY}QmMeta/1.json`);
    expect(out.metadata.fetched).toBe(true);
    expect(out.metadata.json.name).toBe("Ape #1");
    expect(out.metadata.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The image is listed, and it is not fetched.
    expect(out.metadata.referencedUrls).toEqual([
      { field: "image", scheme: "ipfs", value: "ipfs://QmImage" },
    ]);
    expect(dialled).toBe(`${GATEWAY}QmMeta/1.json`);
  });

  test("an https tokenURI is skipped unless its host was allow-listed", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    let dialled = 0;
    _setMetadataFetch(async () => {
      dialled++;
      return {
        status: 200,
        contentType: "application/json",
        bytes: new TextEncoder().encode("{}"),
      };
    });
    const skipped = await call(erc721TokenInfo, { chainId: 1, contract: APE_NFT, tokenId: "2" });
    expect(skipped.metadata.reason).toContain("not a reason to dial it");
    expect(dialled).toBe(0);

    const fetched = await call(erc721TokenInfo, {
      chainId: 1,
      contract: APE_NFT,
      tokenId: "2",
      allowedHosts: ["metadata.example"],
    });
    expect(fetched.metadata.fetched).toBe(true);
    expect(dialled).toBe(1);
  });

  test("a data: URI is read with no fetcher bound at all", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc721TokenInfo, { chainId: 1, contract: ONCHAIN_NFT, tokenId: "1" });
    expect(out.metadata.source).toBe("data:");
    expect(out.metadata.json.name).toBe("On-chain #1");
    expect(out.metadata.referencedUrls.map((r: Json) => r.field).sort()).toEqual([
      "external_url",
      "image",
    ]);
  });

  test("a metadata document over the cap is skipped rather than parsed as a prefix", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    _setMetadataFetch(async () => ({
      status: 200,
      contentType: "application/json",
      bytes: new Uint8Array(5000),
    }));
    const out = await call(erc721TokenInfo, {
      chainId: 1,
      contract: APE_NFT,
      tokenId: "1",
      ipfsGateway: GATEWAY,
      maxMetadataBytes: 100,
    });
    expect(out.metadata.fetched).toBe(false);
    expect(out.metadata.reason).toContain("over the 100-byte cap");
  });

  test("ERC-1155 substitutes {id} with 64 zero-padded hex digits", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc721TokenInfo, { chainId: 1, contract: GAME_1155, tokenId: "5" });
    expect(out.standard).toBe("erc1155");
    expect(out.tokenUri.raw).toBe("ipfs://QmBase/{id}.json");
    expect(out.tokenUri.substituted).toBe(`ipfs://QmBase/${"0".repeat(63)}5.json`);
    expect(out.tokenUri.idPlaceholderSubstituted).toBe(true);
  });

  test("ERC-1155 ownership is a balance, or it is unanswerable — never a misleading null", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const without = await call(erc721TokenInfo, { chainId: 1, contract: GAME_1155, tokenId: "5" });
    expect(without.ownership).toEqual({
      kind: "erc1155",
      answerable: false,
      reason:
        "ERC-1155 has no ownerOf — a token id is held by many addresses at once. Pass owner to read balanceOf(owner, id).",
    });

    const with_ = await call(erc721TokenInfo, {
      chainId: 1,
      contract: GAME_1155,
      tokenId: "5",
      owner: ALICE,
    });
    expect(with_.ownership).toEqual({ kind: "erc1155", account: ALICE, balance: "3" });
  });

  test("an ERC-1155 balance that could not be read is not a balance of zero", async () => {
    // The same rule as the missing ownerOf above, one call along. A bare null
    // under a named account reads as "this account holds none of it", which is
    // exactly the sentence a listing check or a gate would act on.
    const paused = await revertWith("Pausable: paused");
    const stub = mainnet({
      [low(GAME_1155)]: (selector, args) => {
        if (selector === SELECTOR.balanceOf1155) return reverts(paused);
        return erc1155({ uriTemplate: "ipfs://QmBase/{id}.json", balances: {} })(selector, args);
      },
    });
    _setChainReader(stub.reader);
    const out = await call(erc721TokenInfo, {
      chainId: 1,
      contract: GAME_1155,
      tokenId: "5",
      owner: ALICE,
    });
    expect(out.ownership.balance).toBeNull();
    expect(out.ownership.answerable).toBe(false);
    // The REASON, not just the absence — an aborted read would also leave a
    // null here, and the two are different facts.
    expect(out.ownership.reason).toContain("Pausable: paused");
    expect(out.ownership.reason).toContain("not a balance of zero");
    expect(out.flags).toContain("balance-unreadable");
  });

  test("a token that was never minted reports why, instead of crashing", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc721TokenInfo, { chainId: 1, contract: APE_NFT, tokenId: "99" });
    expect(out.ownership.owner).toBeNull();
    expect(out.ownership.reason).toContain("nonexistent token");
    expect(out.flags).toContain("owner-unreadable");
  });

  test("a contract that claims the invalid interface id has its other answers discounted", async () => {
    // ERC-165 requires supportsInterface(0xffffffff) to be false. True means
    // it says yes to everything, so "yes I am an ERC-1155" means nothing.
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc721TokenInfo, { chainId: 1, contract: LIAR_165, tokenId: "1" });
    expect(out.interfaces.claimsInvalidInterface).toBe(true);
    expect(out.flags.join(" ")).toContain("bogus-erc165");
    // It falls back to what actually answered rather than to the claim.
    expect(out.standard).toBe("erc721");
    expect(out.standardSource).toContain("inferred");
  });

  test("an ERC-20 handed to the NFT tool is unknown, not an ownerless ERC-721", async () => {
    // The realistic mistake is pasting a token address into the wrong tool.
    // Reporting kind:"erc721" with a null owner would read as "this NFT has
    // no owner" instead of "this may not be an NFT".
    const stub = mainnet();
    _setChainReader(stub.reader);
    const out = await call(erc721TokenInfo, { chainId: 1, contract: USDC, tokenId: "1" });
    expect(out.standard).toBe("unknown");
    expect(out.flags).toContain("unknown-standard");
    expect(out.ownership.kind).toBe("unknown");
    expect(out.ownership.owner).toBeNull();
    expect(out.tokenUri.source).toBe("none");
  });

  test("a tokenId that is not a uint256 is refused", async () => {
    _setChainReader(mainnet().reader);
    await expect(
      call(erc721TokenInfo, { chainId: 1, contract: APE_NFT, tokenId: "one" }),
    ).rejects.toThrow("is not a token id");
  });

  test("refuses a contract with no code at it", async () => {
    _setChainReader(mainnet().reader);
    await expect(
      call(erc721TokenInfo, { chainId: 1, contract: NOT_A_CONTRACT, tokenId: "1" }),
    ).rejects.toThrow("there is no contract at");
  });

  test("refuses a gateway that is not a usable prefix", async () => {
    _setChainReader(mainnet().reader);
    await expect(
      call(erc721TokenInfo, {
        chainId: 1,
        contract: APE_NFT,
        tokenId: "1",
        ipfsGateway: "https://gateway.example/ipfs",
      }),
    ).rejects.toThrow('must end with "/"');
  });

  test("fetchMetadata:false reads the URI and stops there", async () => {
    const stub = mainnet();
    _setChainReader(stub.reader);
    let dialled = 0;
    _setMetadataFetch(async () => {
      dialled++;
      return { status: 200, contentType: "application/json", bytes: new Uint8Array(2) };
    });
    const out = await call(erc721TokenInfo, {
      chainId: 1,
      contract: APE_NFT,
      tokenId: "1",
      ipfsGateway: GATEWAY,
      fetchMetadata: false,
    });
    expect(out.tokenUri.raw).toBe("ipfs://QmMeta/1.json");
    expect(out.metadata).toEqual({ attempted: false, reason: "fetchMetadata was false" });
    expect(dialled).toBe(0);
  });
});
