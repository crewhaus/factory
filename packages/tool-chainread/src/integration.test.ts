/**
 * The tools driven the way the runtime drives them: registered in a catalog and
 * dispatched through `executeTool`, which validates input against the declared
 * schema and turns a thrown refusal into an error RESULT rather than a crash.
 *
 * A tool that works when called directly but not here is a tool the runtime
 * cannot use, which is why this file exists separately. The refusals matter
 * most: a scan that cannot vouch for its result has to reach the model as an
 * error it can read, not as a stack trace and not as a plausible short answer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  ALICE,
  BOB,
  type Chain,
  TOKEN,
  TRANSFER_TOPIC,
  addTransferLogs,
  hash32,
  makeChain,
  rpcStub,
  topicFor,
  word,
} from "./fixtures";
import {
  CHAINREAD_TOOLS,
  _setClock,
  _setDnsLookup,
  _setFetch,
  setRpcEndpointPolicy,
  virtualClock,
} from "./index";

const RPC = "https://rpc.example.com/v2/secret-key";
const START = 1_700_000_000n;

let catalog: ToolCatalog;

function text(result: { content: unknown }): string {
  if (typeof result.content !== "string") throw new Error("expected string content");
  return result.content;
}

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

/** A small chain with one mined transfer, one revert and one waiting transaction. */
function chainWithHistory(): Chain {
  const chain = makeChain({ blocks: 200, startTimestamp: START, blockTime: 12n });
  const log = {
    blockNumber: 120n,
    logIndex: 0,
    address: TOKEN,
    topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
    data: `0x${word(4_200n)}`,
    transactionHash: hash32("tx-ok"),
  };
  chain.logs.push(log);
  chain.txs.set(hash32("tx-ok"), {
    hash: hash32("tx-ok"),
    from: ALICE,
    to: TOKEN,
    value: 0n,
    nonce: 3n,
    input: "0xa9059cbb",
    blockNumber: 120n,
  });
  chain.receipts.set(hash32("tx-ok"), {
    hash: hash32("tx-ok"),
    blockNumber: 120n,
    status: "0x1",
    gasUsed: 21_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: [log],
  });
  chain.txs.set(hash32("tx-bad"), {
    hash: hash32("tx-bad"),
    from: ALICE,
    to: BOB,
    value: 1n,
    nonce: 4n,
    input: "0x",
    blockNumber: 121n,
  });
  chain.receipts.set(hash32("tx-bad"), {
    hash: hash32("tx-bad"),
    blockNumber: 121n,
    status: "0x0",
    gasUsed: 30_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: [],
  });
  chain.nonces.set(ALICE, { latest: 5n, pending: 5n });
  return chain;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of CHAINREAD_TOOLS) catalog.register(tool);
  _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
  _setClock(virtualClock(Number(START) * 1000));
  _setFetch(rpcStub(chainWithHistory()).fetch);
  setRpcEndpointPolicy({});
});

afterEach(() => {
  _setFetch(undefined);
  _setDnsLookup(undefined);
  _setClock(undefined);
  setRpcEndpointPolicy({});
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(CHAINREAD_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of CHAINREAD_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("every tool can be dispatched with a minimal valid input", async () => {
    const inputs: Record<string, unknown> = {
      EvmGetBlock: { rpcUrl: RPC },
      EvmBlockAtTimestamp: { rpcUrl: RPC, timestamp: (START + 600n).toString() },
      EvmRpcHealth: { rpcUrl: RPC },
      EvmNonceStatus: { rpcUrl: RPC, address: ALICE },
      EvmWaitForReceipt: { rpcUrl: RPC, txHash: hash32("tx-ok") },
      EvmTransactionSummary: { rpcUrl: RPC, txHash: hash32("tx-ok") },
      EvmEventScan: { rpcUrl: RPC, fromBlock: 100, toBlock: 150 },
      OnchainTransactionsSync: { rpcUrl: RPC, address: ALICE, fromBlock: 118, toBlock: 122 },
    };
    for (const tool of CHAINREAD_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("input is validated before execute, so a bad type never reaches the network", async () => {
    const result = await executeTool(lookup("EvmGetBlock"), { rpcUrl: 42 }, { toolUseId: "t1" });
    expect(result.isError).toBe(true);
  });

  test("an unknown field is rejected rather than silently ignored", async () => {
    // Every schema here is strict: a caller that thinks it passed `blockNumber`
    // when the field is `block` should be told, not quietly given the head.
    const result = await executeTool(
      lookup("EvmGetBlock"),
      { rpcUrl: RPC, blockNumber: 5 },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
  });

  test("a refused endpoint comes back as an error result with the reason", async () => {
    const result = await executeTool(
      lookup("EvmGetBlock"),
      { rpcUrl: "http://169.254.169.254/latest/meta-data/" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("refusing to dial");
  });

  test("a timestamp before genesis is an error result, not a block-zero answer", async () => {
    const result = await executeTool(
      lookup("EvmBlockAtTimestamp"),
      { rpcUrl: RPC, timestamp: (START - 10n).toString() },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("nothing was recorded at or before");
  });

  test("a scan that cannot prove it is complete is an error result, not a short list", async () => {
    const chain = makeChain({ blocks: 4 });
    addTransferLogs(chain, 1n, 40);
    _setFetch(rpcStub(chain, { silentLogCap: 10 }).fetch);
    const result = await executeTool(
      lookup("EvmEventScan"),
      { rpcUrl: RPC, fromBlock: 0, toBlock: 3, maxSpan: 4, suspectAt: 10 },
      { toolUseId: "t5" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("refuses rather than returning a set it cannot vouch for");
  });

  test("a reverted transaction is a successful CALL with a reverted RESULT", async () => {
    // The tool did its job; the transaction failed. Collapsing those two into
    // one error is what makes a caller retry a transaction that will revert
    // again.
    const result = await executeTool(
      lookup("EvmWaitForReceipt"),
      { rpcUrl: RPC, txHash: hash32("tx-bad") },
      { toolUseId: "t6" },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result))).toMatchObject({
      outcome: "mined",
      status: "reverted",
      reverted: true,
    });
  });
});

describe("the question these tools answer together", () => {
  test("pin a moment to a block, scan that window, then explain what one transaction did", async () => {
    // The workflow the package is for: a period becomes a block range, the
    // range becomes a set of logs, and one of those logs becomes a settled
    // account of what moved.
    const at = await executeTool(
      lookup("EvmBlockAtTimestamp"),
      { rpcUrl: RPC, timestamp: (START + 120n * 12n).toString() },
      { toolUseId: "w1" },
    );
    const from = JSON.parse(text(at)).block.number as string;
    expect(from).toBe("120");

    const scan = await executeTool(
      lookup("EvmEventScan"),
      {
        rpcUrl: RPC,
        fromBlock: Number(from),
        toBlock: Number(from) + 10,
        topics: [TRANSFER_TOPIC],
      },
      { toolUseId: "w2" },
    );
    const scanned = JSON.parse(text(scan)) as {
      complete: boolean;
      logs: Array<{ transactionHash: string }>;
    };
    expect(scanned.complete).toBe(true);
    expect(scanned.logs.length).toBe(1);

    const summary = await executeTool(
      lookup("EvmTransactionSummary"),
      { rpcUrl: RPC, txHash: scanned.logs[0]?.transactionHash, perspective: BOB },
      { toolUseId: "w3" },
    );
    const explained = JSON.parse(text(summary)) as {
      status: string;
      netDeltas: { tokens: Array<{ token: string; amount: string }> };
    };
    expect(explained.status).toBe("success");
    expect(explained.netDeltas.tokens).toEqual([{ token: TOKEN, amount: "4200" }]);
  });
});
