/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and turns a thrown refusal into an error RESULT rather than
 * a crash. A tool that works when called directly but not here is a tool the
 * runtime cannot use, which is why this file exists separately.
 *
 * It also pins the distinction the whole package turns on: a token that
 * cannot be read is an ERROR, and a symbol that means two tokens is a
 * successful RESULT carrying `resolved: false` and both candidates. A caller
 * that only checks `isError` must still be unable to act on an ambiguity.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  ALICE,
  APE_NFT,
  type ChainStub,
  RIVAL_LIST,
  UNISWAP_LIST,
  USDC,
  chainStub,
  erc20,
  erc721,
  revertWith,
} from "./fixtures";
import { TOKEN_TOOLS } from "./index";
import { _setChainReader } from "./lib/chain";
import { _setMetadataFetch } from "./lib/uri";

let catalog: ToolCatalog;
let stub: ChainStub;

const NO_SUCH_TOKEN = await revertWith("ERC721: owner query for nonexistent token");

function text(result: { content: unknown }): string {
  if (typeof result.content !== "string") throw new Error("expected string content");
  return result.content;
}

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of TOKEN_TOOLS) catalog.register(tool);
  stub = chainStub({
    blockNumber: 19_000_000n,
    contracts: {
      [USDC.toLowerCase()]: erc20({
        decimals: 6n,
        symbol: "USDC",
        name: "USD Coin",
        totalSupply: 25_000_000_000_000n,
        balances: { [ALICE.toLowerCase()]: 1_500_000n },
      }),
      "0x1111111111111111111111111111111111111111": erc20({
        decimals: 6n,
        symbol: "USDC",
        name: "USD Coin",
        totalSupply: 0n,
      }),
      [APE_NFT.toLowerCase()]: erc721({
        name: "Bored Ape Yacht Club",
        symbol: "BAYC",
        owners: { "1": ALICE },
        tokenUris: { "1": "ipfs://QmMeta/1.json" },
        missingTokenRevert: NO_SUCH_TOKEN,
      }),
    },
  });
  _setChainReader(stub.reader);
});

afterEach(() => {
  _setChainReader(undefined);
  _setMetadataFetch(undefined);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(TOKEN_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of TOKEN_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("every tool can be dispatched with a minimal valid input", async () => {
    const inputs: Record<string, unknown> = {
      Erc20Balance: { chainId: 1, token: USDC, accounts: [ALICE] },
      Erc721TokenInfo: { chainId: 1, contract: APE_NFT, tokenId: "1" },
      TokenResolve: { chainId: 1, query: "USDC", lists: [UNISWAP_LIST] },
    };
    for (const tool of TOKEN_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("input is validated before execute, so a bad type never reaches the chain", async () => {
    const before = stub.reads.length;
    const result = await executeTool(
      lookup("Erc20Balance"),
      { chainId: "one", token: USDC, accounts: [ALICE] },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(true);
    expect(stub.reads.length).toBe(before);
  });

  test("an unknown field is rejected rather than ignored", async () => {
    const result = await executeTool(
      lookup("Erc20Balance"),
      { chainId: 1, token: USDC, accounts: [ALICE], decimals: 18 },
      { toolUseId: "t2" },
    );
    // A caller trying to supply decimals is trying to override the contract.
    expect(result.isError).toBe(true);
  });

  test("a refusal comes back as an error result with the reason, not a thrown crash", async () => {
    const result = await executeTool(
      lookup("Erc20Balance"),
      { chainId: 1, token: "USDC", accounts: [ALICE] },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("resolve it with TokenResolve first");
  });

  test("an ambiguity is a SUCCESSFUL result that still cannot be acted on", async () => {
    const result = await executeTool(
      lookup("TokenResolve"),
      { chainId: 1, query: "USDC", lists: [UNISWAP_LIST, RIVAL_LIST] },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(false);
    const out = JSON.parse(text(result)) as {
      resolved: boolean;
      token?: unknown;
      refusal: { code: string };
      candidates: unknown[];
    };
    expect(out.resolved).toBe(false);
    expect(out.refusal.code).toBe("ambiguous-symbol");
    expect(out.token).toBeUndefined();
    expect(out.candidates).toHaveLength(2);
  });
});

describe("the question these three answer together", () => {
  test("resolve the symbol, then read the balance of the address it resolved to", async () => {
    // The pair is the workflow, and the order is the safety property: the
    // balance tool will not take a symbol at all, so there is no path that
    // reads a balance from a ticker nobody resolved.
    const resolved = await executeTool(
      lookup("TokenResolve"),
      { chainId: 1, query: "USDC", lists: [UNISWAP_LIST] },
      { toolUseId: "w1" },
    );
    const token = (JSON.parse(text(resolved)) as { token: { address: string } }).token.address;
    expect(token).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");

    const balance = await executeTool(
      lookup("Erc20Balance"),
      { chainId: 1, token, accounts: [ALICE] },
      { toolUseId: "w2" },
    );
    expect(balance.isError).toBe(false);
    const out = JSON.parse(text(balance)) as { balances: Array<{ decimal: string }> };
    expect(out.balances[0]?.decimal).toBe("1.5");
  });

  test("the ambiguous branch of that workflow hands the caller nothing to pass on", async () => {
    const resolved = await executeTool(
      lookup("TokenResolve"),
      { chainId: 1, query: "USDC", lists: [UNISWAP_LIST, RIVAL_LIST] },
      { toolUseId: "w3" },
    );
    const out = JSON.parse(text(resolved)) as { token?: { address: string } };
    expect(out.token?.address).toBeUndefined();
  });
});
