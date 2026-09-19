/**
 * Every tool, through its own `execute`, against a recorded chain.
 *
 * The package-wide block at the top is the contract the runtime relies on, and
 * two claims in it are load-bearing: nothing here signs, so no schema accepts a
 * private key, and nothing here sends, so no method that submits a transaction
 * is ever dispatched — asserted against the requests the endpoint actually
 * received, not against the source.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ALICE,
  APPROVAL_TOPIC,
  BOB,
  type Chain,
  ROUTER,
  type RpcStub,
  type StubOptions,
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
  evmBlockAtTimestamp,
  evmEventScan,
  evmGetBlock,
  evmNonceStatus,
  evmRpcHealth,
  evmTransactionSummary,
  evmWaitForReceipt,
  setRpcEndpointPolicy,
  virtualClock,
} from "./index";

const RPC = "https://rpc.example.com/v2/secret-key";
const OTHER_RPC = "https://backup.example.com";
const START = 1_700_000_000n;

let stub: RpcStub;

function serve(chain: Chain, options: StubOptions = {}): RpcStub {
  stub = rpcStub(chain, options);
  _setFetch(stub.fetch);
  return stub;
}

beforeEach(() => {
  _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
  _setClock(virtualClock(Number(START) * 1000));
  setRpcEndpointPolicy({});
});

afterEach(() => {
  _setFetch(undefined);
  _setDnsLookup(undefined);
  _setClock(undefined);
  setRpcEndpointPolicy({});
});

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and these tools read only its signal.
const ctx = {} as any;

/**
 * Every field NAME a schema accepts, nested ones included.
 *
 * The names are what matters and the descriptions are not: "topics[0] is the
 * event signature hash" contains the word `signature` while accepting nothing
 * of the sort, and a check over the serialised schema would fail on it and
 * teach everyone to loosen the check.
 */
// biome-ignore lint/suspicious/noExplicitAny: walking zod's internals is the only way to see nested field names.
function schemaKeys(schema: any, depth = 0): string[] {
  if (schema === undefined || schema === null || depth > 6) return [];
  const def = schema._def ?? {};
  if (typeof schema.shape === "object" && schema.shape !== null) {
    return Object.entries(schema.shape).flatMap(([key, value]) => [
      key,
      ...schemaKeys(value, depth + 1),
    ]);
  }
  if (def.innerType !== undefined) return schemaKeys(def.innerType, depth + 1);
  if (def.schema !== undefined) return schemaKeys(def.schema, depth + 1);
  if (def.type !== undefined) return schemaKeys(def.type, depth + 1);
  if (Array.isArray(def.options))
    return def.options.flatMap((o: unknown) => schemaKeys(o, depth + 1));
  return [];
}

async function call<T = Record<string, unknown>>(
  tool: (typeof CHAINREAD_TOOLS)[number],
  input: unknown,
): Promise<T> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return JSON.parse((await tool.execute(parsed.data, ctx)) as string) as T;
}

/** A chain with one successful transfer, one revert, and one still in the mempool. */
function busyChain(): Chain {
  const chain = makeChain({ blocks: 300, startTimestamp: START, blockTime: 12n });
  const transferLog = {
    blockNumber: 100n,
    logIndex: 0,
    address: TOKEN,
    topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
    data: `0x${word(2_500_000n)}`,
    transactionHash: hash32("tx-ok"),
  };
  const approvalLog = {
    blockNumber: 100n,
    logIndex: 1,
    address: TOKEN,
    topics: [APPROVAL_TOPIC, topicFor(ALICE), topicFor(ROUTER)],
    data: `0x${word((1n << 256n) - 1n)}`,
    transactionHash: hash32("tx-ok"),
  };
  chain.logs.push(transferLog, approvalLog);

  chain.txs.set(hash32("tx-ok"), {
    hash: hash32("tx-ok"),
    from: ALICE,
    to: TOKEN,
    value: 1_000_000_000_000_000n,
    nonce: 7n,
    input: "0xa9059cbb",
    blockNumber: 100n,
  });
  chain.receipts.set(hash32("tx-ok"), {
    hash: hash32("tx-ok"),
    blockNumber: 100n,
    status: "0x1",
    gasUsed: 21_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: [transferLog, approvalLog],
  });

  chain.txs.set(hash32("tx-bad"), {
    hash: hash32("tx-bad"),
    from: ALICE,
    // Non-zero on purpose. A reverted transaction that carried no value makes
    // every net-delta assertion pass whether or not the revert is accounted
    // for, which is how a wrong delta survives a test suite.
    to: ROUTER,
    value: 3_000_000_000_000_000_000n,
    nonce: 8n,
    input: "0x38ed1739",
    blockNumber: 101n,
  });
  chain.receipts.set(hash32("tx-bad"), {
    hash: hash32("tx-bad"),
    blockNumber: 101n,
    // A revert HAS a receipt. Everything about this tool package turns on not
    // reporting that as "no receipt".
    status: "0x0",
    gasUsed: 45_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: [],
  });

  chain.txs.set(hash32("tx-pending"), {
    hash: hash32("tx-pending"),
    from: ALICE,
    to: BOB,
    value: 5n,
    nonce: 9n,
    input: "0x",
    blockNumber: null,
  });

  chain.nonces.set(ALICE, { latest: 9n, pending: 10n });
  return chain;
}

// ---------------------------------------------------------------------------

describe("package-wide contract", () => {
  test("every tool is exported in CHAINREAD_TOOLS, with a unique PascalCase name", () => {
    expect(CHAINREAD_TOOLS.length).toBe(7);
    const names = CHAINREAD_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive, and declares that it crosses the network", () => {
    for (const tool of CHAINREAD_TOOLS) {
      expect({
        name: tool.name,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        scope: tool.scope,
        io: tool.ioCapability,
      }).toEqual({
        name: tool.name,
        readOnly: true,
        destructive: false,
        scope: "external",
        io: "network",
      });
    }
  });

  test("no schema accepts a private key, and no tool ever dispatches a sending method", async () => {
    // The two halves of the same claim. The first is about what a caller can
    // hand in; the second is about what leaves. Neither is a promise about the
    // call sites — the schemas and the endpoint's own request log are checked.
    const shapes = CHAINREAD_TOOLS.flatMap((tool) => schemaKeys(tool.inputSchema));
    // A scan that finds nothing passes every "is X absent" check it is given.
    // So the scanner's own reach is asserted first: these are field names that
    // ARE there, including the nested ones.
    expect(shapes).toContain("rpcUrl");
    expect(shapes).toContain("broadcast");
    expect(shapes).toContain("nonce");
    expect(shapes).toContain("confirmations");
    expect(shapes.length).toBeGreaterThan(30);

    for (const forbidden of [
      "privateKey",
      "secret",
      "mnemonic",
      "seed",
      "keystore",
      "signature",
      "signedTransaction",
      "rawTransaction",
      "signer",
    ]) {
      const present = shapes.some((key) => key.toLowerCase().includes(forbidden.toLowerCase()));
      expect({ forbidden, present }).toEqual({ forbidden, present: false });
    }

    const chain = busyChain();
    serve(chain);
    await call(evmGetBlock, { rpcUrl: RPC });
    await call(evmBlockAtTimestamp, { rpcUrl: RPC, timestamp: (START + 120n).toString() });
    await call(evmRpcHealth, { rpcUrl: RPC });
    await call(evmNonceStatus, { rpcUrl: RPC, address: ALICE });
    await call(evmWaitForReceipt, { rpcUrl: RPC, txHash: hash32("tx-ok") });
    await call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-ok") });
    await call(evmEventScan, { rpcUrl: RPC, fromBlock: 90, toBlock: 110 });

    const sending = stub.requests
      .map((r) => r.method)
      .filter((m) => /send|sign|submit|unlock|import/i.test(m));
    expect(sending).toEqual([]);
    // And everything it DID ask for is a read.
    expect(
      [...new Set(stub.requests.map((r) => r.method))].every((m) => m.startsWith("eth_")),
    ).toBe(true);
  });

  test("every description says what the tool is for", () => {
    for (const tool of CHAINREAD_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.description).toContain("Use it");
    }
  });

  test("a refused endpoint is refused before any request is made", async () => {
    serve(makeChain());
    await expect(call(evmGetBlock, { rpcUrl: "http://169.254.169.254/" })).rejects.toThrow(
      /refusing to dial/,
    );
    expect(stub.requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("EvmGetBlock", () => {
  test("by number, by tag and by hash all reach the same block", async () => {
    const chain = makeChain({ blocks: 50, startTimestamp: START, blockTime: 12n });
    serve(chain);
    const byNumber = await call(evmGetBlock, { rpcUrl: RPC, block: 10 });
    const byHash = await call(evmGetBlock, { rpcUrl: RPC, block: hash32("block-10") });
    const byTag = await call(evmGetBlock, { rpcUrl: RPC, block: "latest" });

    expect((byNumber.block as { number: string }).number).toBe("10");
    expect(byNumber.resolvedBy).toBe("number");
    expect(byHash.resolvedBy).toBe("hash");
    expect((byHash.block as { number: string }).number).toBe("10");
    expect((byTag.block as { number: string }).number).toBe("49");
  });

  test("a 32-byte hash is routed to getBlockByHash, not to getBlockByNumber", async () => {
    // Both arrive as 0x strings, and sending a hash to getBlockByNumber gets a
    // null back: "no such block" for a block that exists.
    const chain = makeChain({ blocks: 8 });
    serve(chain);
    await call(evmGetBlock, { rpcUrl: RPC, block: hash32("block-3") });
    expect(stub.count("eth_getBlockByHash")).toBe(1);
    expect(stub.count("eth_getBlockByNumber")).toBe(0);
  });

  test("timestamps come back as unix seconds AND as an ISO instant", async () => {
    serve(makeChain({ blocks: 8, startTimestamp: START, blockTime: 12n }));
    const result = await call(evmGetBlock, { rpcUrl: RPC, block: 2 });
    const block = result.block as { timestamp: string; timestampIso: string };
    expect(block.timestamp).toBe((START + 24n).toString());
    expect(block.timestampIso).toBe(new Date(Number(START + 24n) * 1000).toISOString());
  });

  test("a chain with no base fee is reported as legacy, not as a null to do maths with", async () => {
    serve(makeChain({ blocks: 4, baseFee: null }));
    const result = await call(evmGetBlock, { rpcUrl: RPC, block: 1 });
    expect(result.block).toMatchObject({ baseFeePerGas: null, feeMarket: "legacy" });
  });

  test("a block that does not exist is found:false, which is a fact about the chain", async () => {
    serve(makeChain({ blocks: 4 }));
    const result = await call(evmGetBlock, { rpcUrl: RPC, block: 99_999 });
    expect(result.found).toBe(false);
    expect(result.note).toContain("ahead of the head");
  });

  test("the pending block has no number and no hash, and the answer says so", async () => {
    serve(makeChain({ blocks: 10 }));
    const result = await call(evmGetBlock, { rpcUrl: RPC, block: "pending" });
    expect(result.block).toMatchObject({ number: null, hash: null, pending: true });
    expect(result.note).toContain("no number and no hash");
  });

  test("includeTransactions actually returns the hashes it says it returns", async () => {
    // The trap: asking for hashes hydrated the block into full transaction
    // OBJECTS, which are not strings, so the projection dropped the list and
    // the caller got transactionCount with nothing to go with it — a documented
    // field that silently is not there, paid for with a much larger response.
    const chain = makeChain({ blocks: 5 });
    for (const [i, label] of ["a", "b"].entries()) {
      chain.txs.set(hash32(label), {
        hash: hash32(label),
        from: ALICE,
        to: BOB,
        value: BigInt(i + 1),
        nonce: BigInt(i),
        input: "0x",
        blockNumber: 2n,
      });
    }
    serve(chain);
    const withTx = await call(evmGetBlock, { rpcUrl: RPC, block: 2, includeTransactions: true });
    expect(withTx.block).toMatchObject({
      transactionCount: 2,
      transactions: [hash32("a"), hash32("b")],
    });

    const withoutTx = await call(evmGetBlock, { rpcUrl: RPC, block: 2 });
    expect((withoutTx.block as Record<string, unknown>).transactions).toBeUndefined();
    expect((withoutTx.block as { transactionCount: number }).transactionCount).toBe(2);
  });

  test("a value that is neither a number, a tag nor a hash is refused", async () => {
    serve(makeChain());
    await expect(call(evmGetBlock, { rpcUrl: RPC, block: "yesterday" })).rejects.toThrow(
      /not a block number/,
    );
  });
});

// ---------------------------------------------------------------------------

describe("EvmBlockAtTimestamp", () => {
  const chain = () => makeChain({ blocks: 500, startTimestamp: START, blockTime: 12n });

  test("returns the last block at or before the target, with the next block as evidence", async () => {
    serve(chain());
    const result = await call(evmBlockAtTimestamp, {
      rpcUrl: RPC,
      timestamp: (START + 125n).toString(),
    });
    expect((result.block as { number: string }).number).toBe("10");
    expect((result.next as { number: string }).number).toBe("11");
    expect(result.certificate).toEqual({
      blockTimestamp: (START + 120n).toString(),
      targetTimestamp: (START + 125n).toString(),
      nextBlockTimestamp: (START + 132n).toString(),
    });
    expect(result.invariant).toContain("last block whose timestamp is <= target");
  });

  test("an ISO instant is accepted and means the same as its unix seconds", async () => {
    serve(chain());
    const iso = new Date(Number(START + 120n) * 1000).toISOString();
    const result = await call(evmBlockAtTimestamp, { rpcUrl: RPC, timestamp: iso });
    expect((result.block as { number: string }).number).toBe("10");
  });

  test("a timestamp before genesis is REFUSED, not answered with block zero", async () => {
    serve(chain());
    // Block 0 satisfies "a block at or before the timestamp" only if you drop
    // the first half of the invariant, and a caller would then read state from
    // before the chain existed.
    await expect(
      call(evmBlockAtTimestamp, { rpcUrl: RPC, timestamp: (START - 1n).toString() }),
    ).rejects.toThrow(/nothing was recorded at or before/);
  });

  test("a timestamp past the head returns the head and says the answer will move", async () => {
    serve(chain());
    const result = await call(evmBlockAtTimestamp, {
      rpcUrl: RPC,
      timestamp: (START + 10_000_000n).toString(),
    });
    expect({ number: (result.block as { number: string }).number, next: result.next }).toEqual({
      number: "499",
      next: null,
    });
    expect(result.atHead).toBe(true);
    expect(result.note).toContain("will change as the chain advances");
  });

  test("the genesis timestamp itself resolves to block zero", async () => {
    serve(chain());
    const result = await call(evmBlockAtTimestamp, { rpcUrl: RPC, timestamp: START.toString() });
    expect((result.block as { number: string }).number).toBe("0");
  });

  test("milliseconds are refused by name rather than resolved to the head", async () => {
    serve(chain());
    // Date.now() pasted in would otherwise answer "the head", every time,
    // looking entirely ordinary.
    await expect(
      call(evmBlockAtTimestamp, { rpcUrl: RPC, timestamp: "1700000000000" }),
    ).rejects.toThrow(/looks like milliseconds/);
  });

  test("a narrower bracket costs fewer probes and gives the same answer", async () => {
    serve(chain());
    const wide = await call(evmBlockAtTimestamp, {
      rpcUrl: RPC,
      timestamp: (START + 125n).toString(),
    });
    serve(chain());
    const narrow = await call(evmBlockAtTimestamp, {
      rpcUrl: RPC,
      timestamp: (START + 125n).toString(),
      fromBlock: 5,
      toBlock: 20,
    });
    expect((narrow.block as { number: string }).number).toBe(
      (wide.block as { number: string }).number,
    );
    expect(Number(narrow.probes)).toBeLessThan(Number(wide.probes));
  });
});

// ---------------------------------------------------------------------------

describe("EvmRpcHealth", () => {
  test("reports the chain id, the head, and how old the head is", async () => {
    const chain = makeChain({ blocks: 1_000, startTimestamp: START, blockTime: 12n });
    // Thirty seconds after the head block was stamped. The clock is injected,
    // so head age is a computed fact here rather than a race with the suite.
    _setClock(virtualClock((Number(START) + 999 * 12 + 30) * 1000));
    serve(chain);
    const result = await call(evmRpcHealth, { rpcUrl: RPC });
    const [endpoint] = result.endpoints as Array<Record<string, unknown>>;
    expect(endpoint).toMatchObject({
      chainId: "8453",
      headBlock: "999",
      reachable: true,
      headAgeSeconds: "30",
      stalled: false,
      clockSkewSuspected: false,
    });
  });

  test("an endpoint answering nonsense is reported, not allowed to take the others down", async () => {
    // This tool's whole job is to say which endpoint is sick. A malformed
    // answer from one of them threw out of the Promise.all and lost every
    // endpoint's report — so the sicker the endpoint, the less the health
    // check could say about anything.
    const good = rpcStub(makeChain({ blocks: 300, startTimestamp: START, blockTime: 12n }));
    _setFetch(async (req, pinnedIp) => {
      if (new URL(req.url).origin !== new URL(OTHER_RPC).origin) return good.fetch(req, pinnedIp);
      const body = (await req.clone().json()) as { id: number; method: string };
      // A 200, a well-formed envelope, and a chain id that is not a quantity.
      if (body.method === "eth_chainId" || body.method === "net_version") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: 8453 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return good.fetch(req, pinnedIp);
    });

    const result = await call(evmRpcHealth, { rpcUrl: RPC, compareWith: [OTHER_RPC] });
    const [first, second] = result.endpoints as Array<Record<string, unknown>>;
    expect(first).toMatchObject({ reachable: true, chainId: "8453" });
    expect(second).toMatchObject({ reachable: false, chainId: null });
    expect((second?.errors as string[]).join(" ")).toContain("0x hex quantity");
  });

  test("a client too old for eth_chainId is asked net_version instead", async () => {
    // Pre-2018 clients, and a few L2 devnets, answer eth_chainId with "method
    // not found" and net_version with the same number in decimal. One extra
    // call is cheaper than reporting a working endpoint as unreachable.
    const good = rpcStub(makeChain({ blocks: 300, startTimestamp: START, blockTime: 12n }));
    _setFetch(async (req, pinnedIp) => {
      const body = (await req.clone().json()) as { id: number; method: string };
      if (body.method !== "eth_chainId") return good.fetch(req, pinnedIp);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "the method eth_chainId does not exist" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await call(evmRpcHealth, { rpcUrl: RPC });
    const [endpoint] = result.endpoints as Array<Record<string, unknown>>;
    expect(endpoint).toMatchObject({ reachable: true, chainId: "8453" });
    expect((endpoint?.errors as string[]).join(" ")).toContain("eth_chainId");
  });

  test("a head stamped in the future is clock skew, not a fresh chain", async () => {
    const chain = makeChain({ blocks: 1_000, startTimestamp: START, blockTime: 12n });
    _setClock(virtualClock(Number(START) * 1000));
    serve(chain);
    const result = await call(evmRpcHealth, { rpcUrl: RPC });
    const [endpoint] = result.endpoints as Array<Record<string, unknown>>;
    // A negative age reported as "fresh" would hide a skew that makes every
    // other age in the report wrong too.
    expect(endpoint).toMatchObject({ headAgeSeconds: "-11988", clockSkewSuspected: true });
  });

  test("a head older than the staleness threshold is reported stalled", async () => {
    const chain = makeChain({ blocks: 100, startTimestamp: START, blockTime: 12n });
    _setClock(virtualClock((Number(START) + 99 * 12 + 5_000) * 1000));
    serve(chain);
    const result = await call(evmRpcHealth, { rpcUrl: RPC, staleAfterSeconds: 900 });
    const [endpoint] = result.endpoints as Array<Record<string, unknown>>;
    expect(endpoint).toMatchObject({ stalled: true, headAgeSeconds: "5000" });
  });

  test("archive support is yes when a historic balance reads", async () => {
    serve(makeChain({ blocks: 1_000 }), { archive: "yes" });
    const result = await call(evmRpcHealth, { rpcUrl: RPC });
    const [endpoint] = result.endpoints as Array<Record<string, unknown>>;
    expect(endpoint?.archiveState).toBe("yes");
  });

  test("a pruning error is no, and the evidence is the error itself", async () => {
    serve(makeChain({ blocks: 1_000 }), { archive: "no" });
    const result = await call(evmRpcHealth, { rpcUrl: RPC });
    const [endpoint] = result.endpoints as Array<Record<string, unknown>>;
    expect(endpoint?.archiveState).toBe("no");
    expect(endpoint?.archiveEvidence).toContain("missing trie node");
  });

  test("an error that is not about pruning is UNKNOWN, not no", async () => {
    // "We could not tell" and "it does not" lead to different decisions, and
    // only one of them means find another endpoint.
    serve(makeChain({ blocks: 1_000 }), { archive: "error" });
    const result = await call(evmRpcHealth, { rpcUrl: RPC });
    const [endpoint] = result.endpoints as Array<Record<string, unknown>>;
    expect(endpoint?.archiveState).toBe("unknown");
    expect(endpoint?.archiveEvidence).toContain("not about pruning");
  });

  test("a chain too short to tell is unknown, because every full node keeps 128 blocks", async () => {
    serve(makeChain({ blocks: 20 }), { archive: "no" });
    const result = await call(evmRpcHealth, { rpcUrl: RPC });
    const [endpoint] = result.endpoints as Array<Record<string, unknown>>;
    expect(endpoint?.archiveState).toBe("unknown");
    expect(endpoint?.archiveEvidence).toContain("within 128 blocks of the head");
  });

  test("two endpoints on different chains is a conflict, said out loud", async () => {
    const mainnet = rpcStub(makeChain({ blocks: 500, chainId: 1n }));
    const other = rpcStub(makeChain({ blocks: 500, chainId: 8453n }));
    _setFetch(async (req, ip) =>
      new URL(req.url).hostname === "rpc.example.com"
        ? mainnet.fetch(req, ip)
        : other.fetch(req, ip),
    );
    const result = await call(evmRpcHealth, { rpcUrl: RPC, compareWith: [OTHER_RPC] });
    const comparison = result.comparison as Record<string, unknown>;
    expect(comparison.chainIdsAgree).toBe(false);
    expect(comparison.conflict).toContain("not on the same chain");
  });

  test("an unreachable endpoint is reported, not thrown, so the others still answer", async () => {
    const good = rpcStub(makeChain({ blocks: 500 }));
    const bad = rpcStub(makeChain({ blocks: 500 }), { unreachable: true });
    _setFetch(async (req, ip) =>
      new URL(req.url).hostname === "rpc.example.com" ? good.fetch(req, ip) : bad.fetch(req, ip),
    );
    const result = await call(evmRpcHealth, { rpcUrl: RPC, compareWith: [OTHER_RPC] });
    const endpoints = result.endpoints as Array<Record<string, unknown>>;
    expect(endpoints[0]?.reachable).toBe(true);
    expect(endpoints[1]?.reachable).toBe(false);
    expect(endpoints[1]?.archiveState).toBe("unknown");
    expect((endpoints[1]?.errors as string[]).length).toBeGreaterThan(0);
  });

  test("the endpoint policy the operator bound is reported with the verdict", async () => {
    setRpcEndpointPolicy({ allowedOrigins: ["https://rpc.example.com"] });
    serve(makeChain({ blocks: 500 }));
    const result = await call(evmRpcHealth, { rpcUrl: RPC });
    expect(result.policy).toEqual({
      allowPrivateHosts: false,
      allowedOrigins: ["https://rpc.example.com"],
    });
  });
});

// ---------------------------------------------------------------------------

describe("EvmNonceStatus", () => {
  test("nothing queued is clear", async () => {
    const chain = makeChain({ blocks: 100 });
    chain.nonces.set(ALICE, { latest: 5n, pending: 5n });
    serve(chain);
    const result = await call(evmNonceStatus, { rpcUrl: RPC, address: ALICE });
    expect(result).toMatchObject({
      latestNonce: "5",
      pendingNonce: "5",
      queued: "0",
      verdict: "clear",
    });
  });

  test("a pending nonce ahead of the latest one is transactions waiting", async () => {
    const chain = makeChain({ blocks: 100 });
    chain.nonces.set(ALICE, { latest: 5n, pending: 8n });
    serve(chain);
    const result = await call(evmNonceStatus, { rpcUrl: RPC, address: ALICE });
    expect(result).toMatchObject({ verdict: "pending", queued: "3", nextNonce: "8" });
  });

  test("an endpoint with no mempool view degrades to unknown instead of saying clear", async () => {
    // This is the whole correctness story: many public endpoints answer the
    // pending nonce with the latest one, and a confident "clear" from those is
    // how a harness broadcasts a duplicate.
    const chain = makeChain({ blocks: 100 });
    chain.nonces.set(ALICE, { latest: 5n, pending: 8n });
    chain.txs.set(hash32("waiting"), {
      hash: hash32("waiting"),
      from: ALICE,
      to: BOB,
      value: 1n,
      nonce: 5n,
      input: "0x",
      blockNumber: null,
    });
    serve(chain, { mempoolAware: false });
    const result = await call(evmNonceStatus, {
      rpcUrl: RPC,
      address: ALICE,
      broadcast: [{ hash: hash32("waiting") }],
    });
    expect(result).toMatchObject({ verdict: "unknown", mempoolVisible: false });
    expect(String(result.note)).toContain("does not include the mempool");
  });

  test("a transaction waiting past the pending nonce proves a gap", async () => {
    const chain = makeChain({ blocks: 100 });
    chain.nonces.set(ALICE, { latest: 5n, pending: 6n });
    chain.txs.set(hash32("gapped"), {
      hash: hash32("gapped"),
      from: ALICE,
      to: BOB,
      value: 1n,
      nonce: 9n,
      input: "0x",
      blockNumber: null,
    });
    serve(chain);
    const result = await call(evmNonceStatus, {
      rpcUrl: RPC,
      address: ALICE,
      broadcast: [{ hash: hash32("gapped") }],
    });
    expect(result.verdict).toBe("gap");
    expect(String(result.note)).toContain("nothing has taken nonce 6");
  });

  test("a hash the endpoint has forgotten, at a nonce already consumed, was replaced", async () => {
    const chain = makeChain({ blocks: 100 });
    chain.nonces.set(ALICE, { latest: 9n, pending: 9n });
    serve(chain);
    const result = await call(evmNonceStatus, {
      rpcUrl: RPC,
      address: ALICE,
      broadcast: [{ hash: hash32("vanished"), nonce: 4 }],
    });
    const [row] = result.broadcast as Array<Record<string, unknown>>;
    expect(row?.state).toBe("replacedOrSuperseded");
    expect(String(row?.note)).toContain("consumed by a different transaction");
  });

  test("a pending nonce BELOW the latest cannot be one node, and is reported as unusable", async () => {
    const chain = makeChain({ blocks: 100 });
    chain.nonces.set(ALICE, { latest: 9n, pending: 4n });
    serve(chain);
    const result = await call(evmNonceStatus, { rpcUrl: RPC, address: ALICE });
    expect(result).toMatchObject({ verdict: "unknown", endpointInconsistent: true });
    expect(String(result.note)).toContain("load balancer");
  });

  test("with no broadcast hashes it says a gap could not be looked for", async () => {
    const chain = makeChain({ blocks: 100 });
    chain.nonces.set(ALICE, { latest: 2n, pending: 2n });
    serve(chain);
    const result = await call(evmNonceStatus, { rpcUrl: RPC, address: ALICE });
    expect(String(result.gapDetection)).toContain("invisible to both nonce counts");
  });
});

// ---------------------------------------------------------------------------

describe("EvmWaitForReceipt", () => {
  test("mined and succeeded", async () => {
    serve(busyChain());
    const result = await call(evmWaitForReceipt, { rpcUrl: RPC, txHash: hash32("tx-ok") });
    expect(result).toMatchObject({ outcome: "mined", status: "success", reverted: false });
    expect((result.receipt as { blockNumber: string }).blockNumber).toBe("100");
  });

  test("mined and REVERTED is not the same as no receipt", async () => {
    // The distinction the whole tool exists for: a caller told "no receipt"
    // broadcasts again, and a failed transaction becomes two.
    serve(busyChain());
    const result = await call(evmWaitForReceipt, { rpcUrl: RPC, txHash: hash32("tx-bad") });
    expect(result).toMatchObject({ outcome: "mined", status: "reverted", reverted: true });
    expect((result.receipt as { gasUsed: string }).gasUsed).toBe("45000");
  });

  test("the deadline passes with the transaction still in the mempool", async () => {
    serve(busyChain());
    const result = await call(evmWaitForReceipt, {
      rpcUrl: RPC,
      txHash: hash32("tx-pending"),
      waitMs: 10_000,
      pollIntervalMs: 1_000,
    });
    // Asserting the REASON, not just that it did not succeed: an abort and a
    // revert would both fail a bare ok:false check.
    expect(result).toMatchObject({
      outcome: "deadline",
      status: "notMined",
      knownToEndpoint: true,
    });
    expect(String(result.reason)).toContain("still held the transaction in its mempool");
    expect(result.polls).toBe(11);
  });

  test("the deadline passes on a transaction this endpoint has never seen", async () => {
    serve(busyChain());
    const result = await call(evmWaitForReceipt, {
      rpcUrl: RPC,
      txHash: hash32("never-broadcast"),
      waitMs: 4_000,
      pollIntervalMs: 2_000,
    });
    expect(result).toMatchObject({ outcome: "deadline", knownToEndpoint: false });
    expect(String(result.reason)).toContain("never seen this transaction");
  });

  test("it polls until the receipt appears, and stops as soon as it does", async () => {
    const chain = busyChain();
    const late = {
      hash: hash32("tx-pending"),
      blockNumber: 150n,
      status: "0x1" as const,
      gasUsed: 21_000n,
      effectiveGasPrice: 1_000_000_000n,
      logs: [],
    };
    const base = rpcStub(chain);
    let receiptPolls = 0;
    _setFetch(async (req, ip) => {
      const clone = req.clone();
      const body = (await clone.json()) as { method: string };
      if (body.method === "eth_getTransactionReceipt") {
        receiptPolls += 1;
        if (receiptPolls === 3) chain.receipts.set(hash32("tx-pending"), late);
      }
      return base.fetch(req, ip);
    });
    const result = await call(evmWaitForReceipt, {
      rpcUrl: RPC,
      txHash: hash32("tx-pending"),
      waitMs: 60_000,
      pollIntervalMs: 1_000,
    });
    expect(result).toMatchObject({ outcome: "mined", status: "success", polls: 3 });
  });

  test("a receipt that is not yet deep enough still reports as mined at the deadline", async () => {
    // The clock running out does not un-mine a transaction. Reporting
    // "notMined" here is the confusion this tool exists to remove.
    serve(busyChain());
    const result = await call(evmWaitForReceipt, {
      rpcUrl: RPC,
      txHash: hash32("tx-ok"),
      confirmations: 1_000,
      waitMs: 3_000,
      pollIntervalMs: 1_000,
    });
    expect(result).toMatchObject({ outcome: "mined", status: "success", settled: false });
    expect(String(result.settlementNote)).toContain("of 1000 confirmations");
  });

  test("confirmations are counted against the head", async () => {
    serve(busyChain());
    const result = await call(evmWaitForReceipt, {
      rpcUrl: RPC,
      txHash: hash32("tx-ok"),
      confirmations: 10,
    });
    expect(result).toMatchObject({ settled: true, confirmations: "200" });
  });

  test("the finalized tag settles it when the chain serves one", async () => {
    serve(busyChain());
    const result = await call(evmWaitForReceipt, {
      rpcUrl: RPC,
      txHash: hash32("tx-ok"),
      finality: "finalized",
    });
    expect(result).toMatchObject({ settled: true, finality: "finalized" });
  });

  test("an endpoint with no finalized tag is a refusal, not a quiet fallback to counting", async () => {
    serve(busyChain(), { noFinalityTags: true });
    await expect(
      call(evmWaitForReceipt, {
        rpcUrl: RPC,
        txHash: hash32("tx-ok"),
        finality: "finalized",
      }),
    ).rejects.toThrow(/does not serve the "finalized" block tag/);
  });
});

// ---------------------------------------------------------------------------

describe("EvmTransactionSummary", () => {
  test("decodes the transfers, the approval and the fee", async () => {
    serve(busyChain());
    const result = await call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-ok") });
    expect(result.status).toBe("success");
    expect(result.tokenTransfers).toEqual([
      { standard: "erc20", token: TOKEN, from: ALICE, to: BOB, amount: "2500000", logIndex: 0 },
    ]);
    expect((result.approvals as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: "approval",
      spender: ROUTER,
      unlimited: true,
    });
    expect(result.fees).toMatchObject({
      model: "eip1559",
      totalFeeWei: (21_000n * 1_000_000_000n).toString(),
    });
  });

  test("it says, in the output, what it cannot see", async () => {
    // The trap is a net delta that claims to be complete: it reconciles, and it
    // is wrong whenever a contract moved native value.
    serve(busyChain());
    const result = await call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-ok") });
    expect(result.completeness).toMatchObject({
      internalNativeTransfers: "excluded",
      tokenMetadata: "not resolved",
    });
    expect((result.netDeltas as { complete: boolean }).complete).toBe(false);
  });

  test("net deltas for the sender include the fee and the value that left", async () => {
    serve(busyChain());
    const result = await call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-ok") });
    const deltas = result.netDeltas as Record<string, unknown>;
    expect(deltas).toMatchObject({
      address: ALICE,
      isSender: true,
      nativeWei: "-1000000000000000",
      feePaidWei: (21_000n * 1_000_000_000n).toString(),
    });
    expect(deltas.tokens).toEqual([{ token: TOKEN, amount: "-2500000" }]);
  });

  test("net deltas from the recipient's perspective are the other direction", async () => {
    serve(busyChain());
    const result = await call(evmTransactionSummary, {
      rpcUrl: RPC,
      txHash: hash32("tx-ok"),
      perspective: BOB,
    });
    const deltas = result.netDeltas as Record<string, unknown>;
    expect(deltas).toMatchObject({ isSender: false, feePaidWei: "0" });
    expect(deltas.tokens).toEqual([{ token: TOKEN, amount: "2500000" }]);
  });

  test("a reverted transaction is summarised as reverted, with the fee it still cost", async () => {
    serve(busyChain());
    const result = await call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-bad") });
    expect(result.status).toBe("reverted");
    expect(String(result.note)).toContain("emitted no logs, but the fee below was still charged");
    expect((result.fees as { totalFeeWei: string }).totalFeeWei).toBe(
      (45_000n * 1_000_000_000n).toString(),
    );
  });

  test("a reverted transaction moved no value, and the deltas say the same as the note", async () => {
    // The worst shape of wrong: `completeWhy` says "nothing moved except the
    // fee" in the same object where `nativeWei` books three ether out of the
    // sender's account. A revert discards the value transfer with everything
    // else; only the fee is charged. A reconciliation trusting this is off by
    // the whole transaction.
    serve(busyChain());
    const result = await call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-bad") });
    const fee = (45_000n * 1_000_000_000n).toString();
    expect(result.netDeltas).toMatchObject({
      isSender: true,
      nativeWei: "0",
      feePaidWei: fee,
      nativeWeiIncludingFee: `-${fee}`,
      reverted: true,
    });

    // And the recipient of a reverted transfer received nothing either.
    const asRouter = await call(evmTransactionSummary, {
      rpcUrl: RPC,
      txHash: hash32("tx-bad"),
      perspective: ROUTER,
    });
    expect(asRouter.netDeltas).toMatchObject({ nativeWei: "0", feePaidWei: "0" });
  });

  test("a pre-Byzantium receipt does not decide the deltas either way", async () => {
    // No status field, so whether the call reverted is simply not recorded.
    // Counting the value as moved is the convention, and the output has to say
    // that it IS a convention — mapping the third case onto either of the other
    // two is how a summary becomes confidently wrong.
    const chain = busyChain();
    const existing = chain.receipts.get(hash32("tx-ok"));
    if (existing === undefined) throw new Error("fixture");
    chain.receipts.set(hash32("tx-ok"), { ...existing, status: null, root: hash32("state-root") });
    serve(chain);
    const result = await call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-ok") });
    expect(result.status).toBe("unknown");
    const deltas = result.netDeltas as Record<string, unknown>;
    expect(deltas).toMatchObject({ reverted: false, nativeWei: "-1000000000000000" });
    expect(String(deltas.completeWhy)).toContain("wrong if it did revert");
  });

  test("an unmined transaction has nothing settled, and says so instead of inventing it", async () => {
    serve(busyChain());
    const result = await call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-pending") });
    expect(result.mined).toBe(false);
    expect(String(result.note)).toContain("no receipt yet");
  });

  test("a hash this endpoint has never seen is a refusal that names the possibilities", async () => {
    serve(busyChain());
    await expect(
      call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("nowhere") }),
    ).rejects.toThrow(/may be on a different chain/);
  });

  test("an OP-stack receipt has its L1 data fee added to the total", async () => {
    const chain = busyChain();
    const existing = chain.receipts.get(hash32("tx-ok"));
    if (existing === undefined) throw new Error("fixture");
    chain.receipts.set(hash32("tx-ok"), { ...existing, l1Fee: 10_000_000_000_000_000n });
    serve(chain);
    const result = await call(evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-ok") });
    expect(result.fees).toMatchObject({
      model: "op-stack",
      totalFeeWei: (21_000n * 1_000_000_000n + 10_000_000_000_000_000n).toString(),
    });
  });
});

// ---------------------------------------------------------------------------

describe("EvmEventScan", () => {
  test("collects the logs across a range and decodes the transfers", async () => {
    const chain = makeChain({ blocks: 100 });
    addTransferLogs(chain, 10n, 2);
    addTransferLogs(chain, 60n, 1);
    serve(chain);
    const result = await call(evmEventScan, { rpcUrl: RPC, fromBlock: 0, toBlock: 99 });
    expect(result.complete).toBe(true);
    expect(result.logCount).toBe(3);
    expect((result.transfers as Array<Record<string, unknown>>).length).toBe(3);
  });

  test("two logs an endpoint numbers the same way are two logs, not one", async () => {
    // `logIndex` is per BLOCK in the spec, and several endpoints number it per
    // TRANSACTION instead. Keyed on (blockHash, logIndex) alone, two logs from
    // two transactions in one block collided and the second was dropped — and
    // dropped silently, under `complete: true`, which is the one claim this
    // tool makes that has to be true. Nothing else in the scan can catch it:
    // splitting the range finds the same collision in each half.
    const chain = makeChain({ blocks: 10 });
    for (const [i, label] of ["tx-a", "tx-b"].entries()) {
      chain.logs.push({
        blockNumber: 5n,
        logIndex: 0,
        address: TOKEN,
        topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
        data: `0x${word(BigInt(111 * (i + 1)))}`,
        transactionHash: hash32(label),
      });
    }
    serve(chain);
    const result = await call(evmEventScan, { rpcUrl: RPC, fromBlock: 0, toBlock: 9 });
    expect({ complete: result.complete, logCount: result.logCount }).toEqual({
      complete: true,
      logCount: 2,
    });
    expect((result.transfers as Array<{ amount: string }>).map((t) => t.amount).sort()).toEqual([
      "111",
      "222",
    ]);
  });

  test("a uint256 crosses the whole path as digits, never as a double", async () => {
    // Every quantity here is past 2^53, and the last digits of each are the
    // point: one `Number(...)` anywhere on the path rounds a balance to the
    // nearest few thousand wei and nothing downstream can tell.
    const AMOUNT = (1n << 255n) + 123_456_789n;
    const BLOCK = (1n << 56n) + 9n;
    const chain = makeChain({ blocks: 4 });
    chain.blocks.push({
      number: BLOCK,
      timestamp: START + 48n,
      hash: hash32("huge"),
      baseFeePerGas: 1_000_000_000n,
    });
    chain.head = BLOCK;
    chain.logs.push({
      blockNumber: BLOCK,
      logIndex: 0,
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
      data: `0x${word(AMOUNT)}`,
      transactionHash: hash32("huge-tx"),
    });
    serve(chain);

    const result = await call(evmEventScan, {
      rpcUrl: RPC,
      fromBlock: BLOCK.toString(),
      toBlock: BLOCK.toString(),
    });
    expect(result.logCount).toBe(1);
    expect((result.logs as Array<{ blockNumber: string }>)[0]?.blockNumber).toBe(BLOCK.toString());
    expect((result.transfers as Array<{ amount: string }>)[0]?.amount).toBe(AMOUNT.toString());
    expect(result.range).toMatchObject({ fromBlock: BLOCK.toString(), toBlock: BLOCK.toString() });

    // And the same number read back through EvmGetBlock, which is where a
    // block number past 2^53 would otherwise be rounded into a neighbour.
    const block = await call(evmGetBlock, { rpcUrl: RPC, block: BLOCK.toString() });
    expect((block.block as { number: string }).number).toBe(BLOCK.toString());
  });

  test("the range is pinned to numbers, so `latest` cannot move under the scan", async () => {
    const chain = makeChain({ blocks: 50 });
    addTransferLogs(chain, 5n, 1);
    serve(chain);
    const result = await call(evmEventScan, { rpcUrl: RPC, fromBlock: 0 });
    expect(result.range).toEqual({ fromBlock: "0", toBlock: "49", head: "49" });
  });

  test("confirmations keep the scan behind the head", async () => {
    const chain = makeChain({ blocks: 50 });
    serve(chain);
    const result = await call(evmEventScan, { rpcUrl: RPC, fromBlock: 0, confirmations: 12 });
    expect((result.range as { toBlock: string }).toBlock).toBe("37");
  });

  test("a topic filter is passed through and narrows the result", async () => {
    const chain = makeChain({ blocks: 40 });
    addTransferLogs(chain, 5n, 2);
    chain.logs.push({
      blockNumber: 6n,
      logIndex: 0,
      address: TOKEN,
      topics: [APPROVAL_TOPIC, topicFor(ALICE), topicFor(ROUTER)],
      data: `0x${word(1n)}`,
      transactionHash: hash32("approve"),
    });
    serve(chain);
    const result = await call(evmEventScan, {
      rpcUrl: RPC,
      fromBlock: 0,
      toBlock: 39,
      topics: [TRANSFER_TOPIC],
    });
    expect(result.logCount).toBe(2);
  });

  test("a silent truncation is caught, recovered and reported as a warning", async () => {
    const chain = makeChain({ blocks: 64 });
    for (let block = 0; block < 8; block++) addTransferLogs(chain, BigInt(block), 5);
    serve(chain, { silentLogCap: 10 });
    const result = await call(evmEventScan, {
      rpcUrl: RPC,
      fromBlock: 0,
      toBlock: 63,
      maxSpan: 64,
      suspectAt: 10,
    });
    expect(result.logCount).toBe(40);
    const paging = result.paging as Record<string, unknown>;
    expect(Number(paging.silentTruncations)).toBeGreaterThan(0);
    expect(String(paging.warning)).toContain("truncated with nothing in the response saying so");
  });

  test("a truncation that cannot be disproved is refused rather than returned", async () => {
    const chain = makeChain({ blocks: 4 });
    addTransferLogs(chain, 2n, 40);
    serve(chain, { silentLogCap: 10 });
    await expect(
      call(evmEventScan, { rpcUrl: RPC, fromBlock: 0, toBlock: 3, maxSpan: 4, suspectAt: 10 }),
    ).rejects.toThrow(/refuses rather than returning a set it cannot vouch for/);
  });

  test("more logs than maxLogs is refused, never sliced", async () => {
    const chain = makeChain({ blocks: 16 });
    for (let block = 0; block < 16; block++) addTransferLogs(chain, BigInt(block), 4);
    serve(chain);
    await expect(
      call(evmEventScan, { rpcUrl: RPC, fromBlock: 0, toBlock: 15, maxLogs: 20 }),
    ).rejects.toThrow(/refusing to return the first 20/);
  });

  test("a range the endpoint caps is paged automatically", async () => {
    const chain = makeChain({ blocks: 300 });
    addTransferLogs(chain, 7n, 1);
    addTransferLogs(chain, 250n, 1);
    serve(chain, { maxRangeBlocks: 25n });
    const result = await call(evmEventScan, { rpcUrl: RPC, fromBlock: 0, toBlock: 299 });
    expect(result.logCount).toBe(2);
    expect((result.paging as { finalSpanBlocks: string }).finalSpanBlocks).toBe("25");
  });

  test("an empty range after confirmations is a refusal that explains the arithmetic", async () => {
    serve(makeChain({ blocks: 20 }));
    await expect(
      call(evmEventScan, { rpcUrl: RPC, fromBlock: 15, confirmations: 12 }),
    ).rejects.toThrow(/nothing to scan/);
  });
});
