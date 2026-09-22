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
  address20,
  hash32,
  makeChain,
  rpcStub,
  topicFor,
  word,
} from "./fixtures";
import {
  CHAINREAD_TOOLS,
  TRANSFER_SINGLE_TOPIC,
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
  onchainTransactionsSync,
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
    expect(CHAINREAD_TOOLS.length).toBe(8);
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
    // EVERY tool's traffic, not most of it: a claim about what leaves this
    // package is worth what the request log covers, and a tool added without a
    // line here would be a tool the claim was never about. The coverage check
    // below is what makes that impossible to forget.
    const exercised: ReadonlyArray<[(typeof CHAINREAD_TOOLS)[number], unknown]> = [
      [evmGetBlock, { rpcUrl: RPC }],
      [evmBlockAtTimestamp, { rpcUrl: RPC, timestamp: (START + 120n).toString() }],
      [evmRpcHealth, { rpcUrl: RPC }],
      [evmNonceStatus, { rpcUrl: RPC, address: ALICE }],
      [evmWaitForReceipt, { rpcUrl: RPC, txHash: hash32("tx-ok") }],
      [evmTransactionSummary, { rpcUrl: RPC, txHash: hash32("tx-ok") }],
      [evmEventScan, { rpcUrl: RPC, fromBlock: 90, toBlock: 110 }],
      [
        onchainTransactionsSync,
        {
          rpcUrl: RPC,
          address: ALICE,
          fromBlock: 100,
          toBlock: 101,
          native: { decimals: 18, minorUnitDecimals: 9 },
        },
      ],
    ];
    expect(exercised.map(([tool]) => tool.name).sort()).toEqual(
      CHAINREAD_TOOLS.map((tool) => tool.name).sort(),
    );
    for (const [tool, input] of exercised) await call(tool, input);

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

// ---------------------------------------------------------------------------

/**
 * A wallet with the four things a statement has to get right: a coin payment
 * too large for the row's number field, a swap whose gas must be charged once
 * however many logs the wallet appears in, an incoming payment, and a revert
 * that moved nothing and still cost money.
 */
function walletChain(): Chain {
  const chain = makeChain({ blocks: 40, startTimestamp: START, blockTime: 12n });
  const usdc = TOKEN;
  const other = address20("token2");

  chain.txs.set(hash32("tx-send"), {
    hash: hash32("tx-send"),
    from: ALICE,
    to: BOB,
    // One whole coin. 1e18 wei is two hundred times Number.MAX_SAFE_INTEGER,
    // which is the entire reason this tool cannot just put wei in a row.
    value: 1_000_000_000_000_000_000n,
    nonce: 1n,
    input: "0x",
    blockNumber: 10n,
  });
  chain.receipts.set(hash32("tx-send"), {
    hash: hash32("tx-send"),
    blockNumber: 10n,
    status: "0x1",
    gasUsed: 21_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: [],
  });

  // One transaction, three logs the wallet is a party to. A fee attributed per
  // log would charge this gas three times.
  const swapLogs = [
    {
      blockNumber: 12n,
      logIndex: 0,
      address: usdc,
      topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(ROUTER)],
      data: `0x${word(1_000_000n)}`,
      transactionHash: hash32("tx-swap"),
    },
    {
      blockNumber: 12n,
      logIndex: 1,
      address: other,
      topics: [TRANSFER_TOPIC, topicFor(ROUTER), topicFor(ALICE)],
      data: `0x${word(2_000_000n)}`,
      transactionHash: hash32("tx-swap"),
    },
    {
      blockNumber: 12n,
      logIndex: 2,
      address: usdc,
      topics: [TRANSFER_TOPIC, topicFor(ROUTER), topicFor(ALICE)],
      data: `0x${word(3_000_000n)}`,
      transactionHash: hash32("tx-swap"),
    },
    // Two other parties entirely: it must not reach the rows, and the filter is
    // what keeps it out.
    {
      blockNumber: 12n,
      logIndex: 3,
      address: usdc,
      topics: [TRANSFER_TOPIC, topicFor(BOB), topicFor(ROUTER)],
      data: `0x${word(9_000_000n)}`,
      transactionHash: hash32("tx-swap"),
    },
  ];
  chain.logs.push(...swapLogs);
  chain.txs.set(hash32("tx-swap"), {
    hash: hash32("tx-swap"),
    from: ALICE,
    to: ROUTER,
    value: 0n,
    nonce: 2n,
    input: "0x38ed1739",
    blockNumber: 12n,
  });
  chain.receipts.set(hash32("tx-swap"), {
    hash: hash32("tx-swap"),
    blockNumber: 12n,
    status: "0x1",
    gasUsed: 150_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: swapLogs,
  });

  chain.txs.set(hash32("tx-recv"), {
    hash: hash32("tx-recv"),
    from: BOB,
    to: ALICE,
    value: 2_000_000_000n,
    nonce: 0n,
    input: "0x",
    blockNumber: 14n,
  });
  chain.receipts.set(hash32("tx-recv"), {
    hash: hash32("tx-recv"),
    blockNumber: 14n,
    status: "0x1",
    gasUsed: 21_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: [],
  });

  chain.txs.set(hash32("tx-fail"), {
    hash: hash32("tx-fail"),
    from: ALICE,
    to: ROUTER,
    // Non-zero on purpose: a reverted transfer that carried nothing proves
    // nothing about whether the revert was accounted for.
    value: 4_000_000_000n,
    nonce: 3n,
    input: "0x38ed1739",
    blockNumber: 16n,
  });
  chain.receipts.set(hash32("tx-fail"), {
    hash: hash32("tx-fail"),
    blockNumber: 16n,
    status: "0x0",
    gasUsed: 45_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: [],
  });

  return chain;
}

const ROW_FIELDS = [
  "amountMinor",
  "balanceMinor",
  "date",
  "description",
  "direction",
  "id",
  "reference",
];

type SyncResult = {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly detail: ReadonlyArray<Record<string, unknown>>;
  readonly unrepresentable: ReadonlyArray<Record<string, unknown>>;
  readonly coverage: Record<string, string>;
  readonly cursor: Record<string, string>;
  readonly paging: Record<string, unknown>;
  readonly rowCount: number;
  readonly selfTransfers: number;
  readonly complete: boolean;
};

async function sync(input: Record<string, unknown>): Promise<SyncResult> {
  return call<SyncResult>(onchainTransactionsSync, input);
}

const NATIVE_GWEI = { decimals: 18, minorUnitDecimals: 9, symbol: "ETH" };

describe("OnchainTransactionsSync", () => {
  test("a row is tool-money's Transaction, field for field and nothing else", async () => {
    // The shape is not this package's to extend. A row with one extra key is a
    // row LedgerReconcile's strict schema rejects, and the reconciliation this
    // tool exists for never runs.
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      native: NATIVE_GWEI,
    });
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(ROW_FIELDS);
      expect(typeof row.amountMinor).toBe("number");
      expect(Number.isSafeInteger(row.amountMinor)).toBe(true);
      expect(String(row.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("money leaving is a debit with a NEGATIVE amount, money arriving is a credit", async () => {
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      native: NATIVE_GWEI,
    });
    for (const row of result.rows) {
      const amount = row.amountMinor as number;
      expect({ direction: row.direction, negative: amount < 0 }).toEqual({
        direction: amount < 0 ? "debit" : "credit",
        negative: amount < 0,
      });
    }
    const sent = result.rows.find((r) => r.id === `${hash32("tx-send")}:native`);
    expect(sent?.amountMinor).toBe(-1_000_000_000);
    const received = result.rows.find((r) => r.id === `${hash32("tx-recv")}:native`);
    expect(received?.amountMinor).toBe(2);
  });

  test("the exact uint256 travels BESIDE the row, because it does not fit inside one", async () => {
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      native: NATIVE_GWEI,
    });
    const detail = result.detail.find((d) => d.id === `${hash32("tx-send")}:native`);
    expect(detail?.rawAmount).toBe("1000000000000000000");
    expect(detail?.blockNumber).toBe("10");
  });

  test("a coin payment past MAX_SAFE_INTEGER is PARKED with its exact amount, not rounded", async () => {
    // 1e18 wei against a ledger that keeps wei. Rounding it to the nearest
    // representable double would put a number in the books the chain does not
    // contain, and a reconciliation that balanced against it would be wrong by
    // however much the double lost.
    serve(walletChain());
    const result = await sync({ rpcUrl: RPC, address: ALICE, fromBlock: 0, toBlock: 20 });
    const parked = result.unrepresentable.find((p) => p.id === `${hash32("tx-send")}:native`);
    expect(parked?.reason).toBe("exceedsSafeInteger");
    expect(parked?.rawAmount).toBe("1000000000000000000");
    expect(result.rows.some((r) => r.id === `${hash32("tx-send")}:native`)).toBe(false);
    // And it is not silence: the caller is told the rows are short and why.
    expect(String((result as unknown as Record<string, unknown>).unrepresentableWarning)).toContain(
      "could not be written as a row without rounding",
    );
  });

  test("naming the ledger's unit brings the same payment into range", async () => {
    // The parked row and this row are the same movement. The difference is
    // entirely the caller saying what unit the books keep, which is a thing
    // only the caller knows.
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      native: NATIVE_GWEI,
    });
    expect(result.unrepresentable.length).toBe(0);
    expect(result.rows.find((r) => r.id === `${hash32("tx-send")}:native`)?.amountMinor).toBe(
      -1_000_000_000,
    );
  });

  test("dust below the ledger's minor unit is parked rather than rounded away", async () => {
    const chain = makeChain({ blocks: 10, startTimestamp: START, blockTime: 12n });
    chain.logs.push({
      blockNumber: 4n,
      logIndex: 0,
      address: TOKEN,
      // Six-decimal token, two-decimal ledger: 1.234567 is not a whole number
      // of cents and no rounding of it is the amount that moved.
      topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
      data: `0x${word(1_234_567n)}`,
      transactionHash: hash32("tx-dust"),
    });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 9,
      include: ["tokenTransfers"],
      tokens: [{ token: TOKEN, decimals: 6, minorUnitDecimals: 2, symbol: "USDC" }],
    });
    expect(result.rows.length).toBe(0);
    expect(result.unrepresentable[0]?.reason).toBe("belowMinorUnit");
    expect(result.unrepresentable[0]?.rawAmount).toBe("1234567");
  });

  test("a whole number of minor units scales exactly", async () => {
    const chain = makeChain({ blocks: 10, startTimestamp: START, blockTime: 12n });
    chain.logs.push({
      blockNumber: 4n,
      logIndex: 0,
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topicFor(BOB), topicFor(ALICE)],
      data: `0x${word(1_000_000n)}`,
      transactionHash: hash32("tx-clean"),
    });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 9,
      include: ["tokenTransfers"],
      tokens: [{ token: TOKEN, decimals: 6, minorUnitDecimals: 2, symbol: "USDC" }],
    });
    expect(result.rows.length).toBe(1);
    expect({ amount: result.rows[0]?.amountMinor, direction: result.rows[0]?.direction }).toEqual({
      amount: 100,
      direction: "credit",
    });
    expect(String(result.rows[0]?.description)).toContain("USDC");
  });

  test("gas is charged ONCE per transaction, however many logs the wallet is in", async () => {
    // The swap puts this wallet in three logs of one transaction. A fee row per
    // log triples the gas, and the reconciliation is off by exactly that.
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 12,
      toBlock: 12,
      native: NATIVE_GWEI,
    });
    const fees = result.rows.filter((r) => String(r.id).endsWith(":fee"));
    expect(fees.length).toBe(1);
    expect(fees[0]?.amountMinor).toBe(-150_000);
    expect(result.rows.filter((r) => String(r.id).includes(":log:")).length).toBe(3);
  });

  test("a reverted transaction moved nothing, and still cost the fee", async () => {
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 16,
      toBlock: 16,
      native: NATIVE_GWEI,
    });
    expect(result.rows.some((r) => r.id === `${hash32("tx-fail")}:native`)).toBe(false);
    const fee = result.rows.find((r) => r.id === `${hash32("tx-fail")}:fee`);
    expect(fee?.amountMinor).toBe(-45_000);
    expect(String(fee?.description)).toContain("reverted");
  });

  test("a transfer to oneself is not a row, because it moved no balance", async () => {
    const chain = makeChain({ blocks: 10, startTimestamp: START, blockTime: 12n });
    chain.logs.push({
      blockNumber: 3n,
      logIndex: 0,
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(ALICE)],
      data: `0x${word(500n)}`,
      transactionHash: hash32("tx-self"),
    });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 9,
      include: ["tokenTransfers"],
    });
    expect({ rows: result.rows.length, self: result.selfTransfers }).toEqual({ rows: 0, self: 1 });
  });

  test("a token whose decimals nobody stated is base units, never a guessed eighteen", async () => {
    const chain = makeChain({ blocks: 10, startTimestamp: START, blockTime: 12n });
    chain.logs.push({
      blockNumber: 2n,
      logIndex: 0,
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topicFor(BOB), topicFor(ALICE)],
      data: `0x${word(4_242n)}`,
      transactionHash: hash32("tx-unknown"),
    });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 9,
      include: ["tokenTransfers"],
    });
    expect(result.rows[0]?.amountMinor).toBe(4_242);
    expect({
      decimals: result.detail[0]?.assetDecimals,
      symbol: result.detail[0]?.symbol,
    }).toEqual({ decimals: null, symbol: null });
  });

  test("an endpoint truncating its log answers silently is caught, and the rows are complete", async () => {
    const chain = makeChain({ blocks: 64, startTimestamp: START, blockTime: 12n });
    for (let block = 0; block < 8; block++) {
      for (let i = 0; i < 5; i++) {
        chain.logs.push({
          blockNumber: BigInt(block),
          logIndex: i,
          address: TOKEN,
          topics: [TRANSFER_TOPIC, topicFor(BOB), topicFor(ALICE)],
          data: `0x${word(BigInt(100 + i))}`,
          transactionHash: hash32(`tx-${block}-${i}`),
        });
      }
    }
    serve(chain, { silentLogCap: 10 });
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 63,
      include: ["tokenTransfers"],
      maxSpan: 64,
      suspectAt: 10,
    });
    expect(result.rowCount).toBe(40);
    expect(Number(result.paging.silentTruncations)).toBeGreaterThan(0);
    expect(String(result.paging.warning)).toContain("truncated with nothing in the response");
  });

  test("a truncation that cannot be disproved is REFUSED, not returned as a short statement", async () => {
    const chain = makeChain({ blocks: 4, startTimestamp: START, blockTime: 12n });
    for (let i = 0; i < 40; i++) {
      chain.logs.push({
        blockNumber: 2n,
        logIndex: i,
        address: TOKEN,
        topics: [TRANSFER_TOPIC, topicFor(BOB), topicFor(ALICE)],
        data: `0x${word(BigInt(i + 1))}`,
        transactionHash: hash32(`tx-many-${i}`),
      });
    }
    serve(chain, { silentLogCap: 10 });
    await expect(
      sync({
        rpcUrl: RPC,
        address: ALICE,
        fromBlock: 0,
        toBlock: 3,
        include: ["tokenTransfers"],
        maxSpan: 4,
        suspectAt: 10,
      }),
    ).rejects.toThrow(/refuses rather than returning a set it cannot vouch for/);
  });

  test("an endpoint that ignores fullTransactions is a refusal, not an empty native history", async () => {
    // The dangerous shape for this path: a block answered as a list of HASHES
    // matches nothing when filtered on `from`, and an empty result reads
    // exactly like a block this wallet was never in.
    const chain = walletChain();
    const stubbed = rpcStub(chain);
    _setFetch(async (req, ip) => {
      const res = await stubbed.fetch(req, ip);
      const body = (await res.json()) as { result?: unknown };
      const block = body.result;
      if (typeof block === "object" && block !== null && "transactions" in block) {
        const asRecord = block as Record<string, unknown>;
        const txs = asRecord.transactions;
        if (Array.isArray(txs)) {
          asRecord.transactions = txs.map((t) =>
            typeof t === "object" && t !== null ? (t as Record<string, unknown>).hash : t,
          );
        }
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    await expect(
      sync({ rpcUrl: RPC, address: ALICE, fromBlock: 10, toBlock: 10, native: NATIVE_GWEI }),
    ).rejects.toThrow(/ignores the fullTransactions flag/);
  });

  test("a range too wide to hydrate is refused, not answered with token rows only", async () => {
    serve(walletChain());
    await expect(
      sync({ rpcUrl: RPC, address: ALICE, fromBlock: 0, toBlock: 39, maxHydratedBlocks: 8 }),
    ).rejects.toThrow(/over maxHydratedBlocks/);
  });

  test("a mined transaction with no receipt is refused rather than booked as having moved", async () => {
    // Without the status there is no way to know whether the value transfer
    // happened, and a reverted one did not. Guessing either way books a
    // movement that may not exist.
    const chain = walletChain();
    chain.receipts.delete(hash32("tx-send"));
    serve(chain);
    await expect(
      sync({ rpcUrl: RPC, address: ALICE, fromBlock: 10, toBlock: 10, native: NATIVE_GWEI }),
    ).rejects.toThrow(/whether it reverted cannot be read/);
  });

  test("a Transfer between two other parties means the endpoint answered a different question", async () => {
    const chain = walletChain();
    const stubbed = rpcStub(chain);
    _setFetch(async (req, ip) => {
      const res = await stubbed.fetch(req, ip);
      const body = (await res.json()) as { result?: unknown };
      if (Array.isArray(body.result)) {
        body.result = (body.result as Array<Record<string, unknown>>).map((log) => ({
          ...log,
          topics: [TRANSFER_TOPIC, topicFor(BOB), topicFor(ROUTER)],
        }));
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    await expect(
      sync({
        rpcUrl: RPC,
        address: ALICE,
        fromBlock: 12,
        toBlock: 12,
        include: ["tokenTransfers"],
      }),
    ).rejects.toThrow(/not answering the question that was asked/);
  });

  test("what was left out is named in the output, not only in the docs", async () => {
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      include: ["tokenTransfers"],
    });
    expect(result.coverage.nativeTransfers).toContain("excluded");
    expect(result.coverage.fees).toContain("excluded");
    expect(result.coverage.internalNativeTransfers).toContain("excluded");
    expect(result.coverage.erc1155).toContain("excluded");
    expect(result.coverage.tokenMetadata).toContain("not resolved");
    // And nothing native was collected, so no native row can have slipped in.
    expect(result.rows.every((r) => String(r.id).includes(":log:"))).toBe(true);
  });

  test("the cursor names the block this run finished at, not the head", async () => {
    // A cursor taken from the head at the end of the run skips every block
    // mined while it ran. This one is the pinned upper bound plus one.
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      confirmations: 10,
      include: ["tokenTransfers"],
    });
    expect({ next: result.cursor.nextFromBlock, through: result.cursor.scannedThrough }).toEqual({
      next: "30",
      through: "29",
    });
  });

  test("listing tokens narrows the filter the endpoint sees, before anything is decoded", async () => {
    // The spam gate is the request, not a filter applied to the answer: an
    // unrestricted scan of a busy wallet fetches every airdrop that ever
    // touched it.
    const stub = serve(walletChain());
    await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      include: ["tokenTransfers"],
      tokens: [{ token: TOKEN, decimals: 6, symbol: "USDC" }],
    });
    const scans = stub.requests.filter((r) => r.method === "eth_getLogs");
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      const filter = scan.params[0] as Record<string, unknown>;
      // One address goes on the wire bare and several go as an array; both are
      // the same filter, and what matters is that it is on the REQUEST.
      const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
      expect(addresses).toEqual([TOKEN]);
    }
  });

  test("onlyKnownTokens with nothing to know is refused, not a complete-looking empty statement", async () => {
    serve(walletChain());
    await expect(
      sync({
        rpcUrl: RPC,
        address: ALICE,
        fromBlock: 0,
        toBlock: 20,
        include: ["tokenTransfers"],
        onlyKnownTokens: true,
      }),
    ).rejects.toThrow(/would scan for nothing and report it as a complete history/);
  });

  test("one token cannot be given two sets of decimals", async () => {
    serve(walletChain());
    await expect(
      sync({
        rpcUrl: RPC,
        address: ALICE,
        fromBlock: 0,
        toBlock: 20,
        tokens: [
          { token: TOKEN, decimals: 6 },
          { token: TOKEN, decimals: 18 },
        ],
      }),
    ).rejects.toThrow(/twice/);
  });

  test("a minor unit finer than the asset itself is refused rather than invented", async () => {
    serve(walletChain());
    await expect(
      sync({
        rpcUrl: RPC,
        address: ALICE,
        fromBlock: 0,
        toBlock: 20,
        native: { decimals: 18, minorUnitDecimals: 24 },
      }),
    ).rejects.toThrow(/no digits there to scale up into/);
  });

  test("the same range twice produces byte-identical rows", async () => {
    // Nothing in the ordering depends on which order the endpoint answered in,
    // and nothing depends on a clock.
    serve(walletChain());
    const first = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      native: NATIVE_GWEI,
    });
    serve(walletChain());
    const second = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      native: NATIVE_GWEI,
    });
    expect(JSON.stringify(second.rows)).toBe(JSON.stringify(first.rows));
    expect(first.rows.map((r) => r.id)).toEqual([
      `${hash32("tx-send")}:native`,
      `${hash32("tx-send")}:fee`,
      `${hash32("tx-swap")}:log:0`,
      `${hash32("tx-swap")}:log:1`,
      `${hash32("tx-swap")}:log:2`,
      `${hash32("tx-swap")}:fee`,
      `${hash32("tx-recv")}:native`,
      `${hash32("tx-fail")}:fee`,
    ]);
  });

  test("every row carries its transaction hash as the reference a reconciler groups on", async () => {
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      native: NATIVE_GWEI,
    });
    for (const row of result.rows) {
      expect(String(row.reference)).toMatch(/^0x[0-9a-f]{64}$/);
      expect(String(row.id).startsWith(String(row.reference))).toBe(true);
      // No running balance is claimed: there is no opening balance to run it
      // from, and a computed one is a number a reconciliation would trust.
      expect(row.balanceMinor).toBe(null);
    }
  });

  test("an inverted range after confirmations is a refusal that explains the arithmetic", async () => {
    serve(makeChain({ blocks: 20, startTimestamp: START, blockTime: 12n }));
    await expect(
      sync({ rpcUrl: RPC, address: ALICE, fromBlock: 15, confirmations: 12 }),
    ).rejects.toThrow(/nothing to sync/);
  });
});

describe("OnchainTransactionsSync — a date the row shape cannot hold", () => {
  test("a block stamped outside four-digit years parks the row instead of dating it wrong", async () => {
    // The row's date is YYYY-MM-DD. A block in the year 33658 serialises with
    // an expanded year, and ten characters off the front of that is a string
    // that looks like a date and is not one.
    const chain = makeChain({ blocks: 6, startTimestamp: 1_000_000_000_000n, blockTime: 12n });
    chain.logs.push({
      blockNumber: 2n,
      logIndex: 0,
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topicFor(BOB), topicFor(ALICE)],
      data: `0x${word(7n)}`,
      transactionHash: hash32("tx-far-future"),
    });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 5,
      include: ["tokenTransfers"],
    });
    expect(result.rows.length).toBe(0);
    expect(result.unrepresentable[0]?.reason).toBe("timestampOutOfRange");
  });
});

describe("OnchainTransactionsSync — what is not a fungible amount", () => {
  test("an NFT is one token, whatever decimals the caller declared for that contract", async () => {
    // Three topics is a fungible transfer and four is one specific NFT. A count
    // of one divided by a token's decimals is dust, and a token id read as an
    // amount is a five-hundred-quintillion-unit row.
    const chain = makeChain({ blocks: 8, startTimestamp: START, blockTime: 12n });
    chain.logs.push({
      blockNumber: 3n,
      logIndex: 0,
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topicFor(BOB), topicFor(ALICE), `0x${word(7n)}`],
      data: "0x",
      transactionHash: hash32("tx-nft"),
    });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 7,
      include: ["tokenTransfers"],
      tokens: [{ token: TOKEN, decimals: 18, symbol: "PUNK" }],
    });
    expect(result.rows.length).toBe(1);
    expect({ amount: result.rows[0]?.amountMinor, direction: result.rows[0]?.direction }).toEqual({
      amount: 1,
      direction: "credit",
    });
    expect({
      standard: result.detail[0]?.standard,
      tokenId: result.detail[0]?.tokenId,
      decimals: result.detail[0]?.assetDecimals,
    }).toEqual({ standard: "erc721", tokenId: "7", decimals: null });
    expect(String(result.rows[0]?.description)).toContain("#7");
  });

  test("an ERC-1155 answered to an ERC-20 filter is a refusal, not a row labelled erc20", async () => {
    const chain = walletChain();
    const stubbed = rpcStub(chain);
    _setFetch(async (req, ip) => {
      const res = await stubbed.fetch(req, ip);
      const body = (await res.json()) as { result?: unknown };
      if (Array.isArray(body.result) && body.result.length > 0) {
        body.result = (body.result as Array<Record<string, unknown>>).map((log) => ({
          ...log,
          topics: [TRANSFER_SINGLE_TOPIC, topicFor(ROUTER), topicFor(ALICE), topicFor(BOB)],
          data: `0x${word(9n)}${word(5n)}`,
        }));
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    await expect(
      sync({
        rpcUrl: RPC,
        address: ALICE,
        fromBlock: 12,
        toBlock: 12,
        include: ["tokenTransfers"],
      }),
    ).rejects.toThrow(/ERC-1155 TransferSingle .* not answering the question that was asked/);
  });
});

describe("OnchainTransactionsSync — a receipt that does not say", () => {
  test("a pre-Byzantium receipt does not decide the row, and the row says so", async () => {
    // It carries a state root instead of a status and simply does not record
    // whether the call reverted. The value is counted as moved — a convention,
    // not a reading — and the caveat rides on the row, which is what a
    // bookkeeper actually sees.
    const chain = makeChain({ blocks: 8, startTimestamp: START, blockTime: 12n });
    chain.txs.set(hash32("tx-old"), {
      hash: hash32("tx-old"),
      from: ALICE,
      to: BOB,
      value: 3_000_000_000n,
      nonce: 0n,
      input: "0x",
      blockNumber: 4n,
    });
    chain.receipts.set(hash32("tx-old"), {
      hash: hash32("tx-old"),
      blockNumber: 4n,
      status: null,
      root: hash32("state-root"),
      gasUsed: 21_000n,
      effectiveGasPrice: 1_000_000_000n,
      logs: [],
    });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 4,
      toBlock: 4,
      include: ["native"],
      native: NATIVE_GWEI,
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.amountMinor).toBe(-3);
    expect(String(result.rows[0]?.description)).toContain("whether the call reverted is not known");
    expect(result.detail[0]?.status).toBe("unknown");
  });

  test("a contract creation names the contract it funded, not an unnamed party", async () => {
    const created = address20("newcontract");
    const chain = makeChain({ blocks: 8, startTimestamp: START, blockTime: 12n });
    chain.txs.set(hash32("tx-deploy"), {
      hash: hash32("tx-deploy"),
      from: ALICE,
      // A contract creation is the one transaction with no `to`.
      to: null,
      value: 5_000_000_000n,
      nonce: 0n,
      input: "0x60806040",
      blockNumber: 5n,
    });
    chain.receipts.set(hash32("tx-deploy"), {
      hash: hash32("tx-deploy"),
      blockNumber: 5n,
      status: "0x1",
      gasUsed: 100_000n,
      effectiveGasPrice: 1_000_000_000n,
      contractAddress: created,
      logs: [],
    });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 5,
      toBlock: 5,
      include: ["native"],
      native: NATIVE_GWEI,
    });
    const row = result.rows.find((r) => r.id === `${hash32("tx-deploy")}:native`);
    expect(String(row?.description)).toContain(created);
    expect(result.detail.find((d) => d.id === `${hash32("tx-deploy")}:native`)?.counterparty).toBe(
      created,
    );
  });
});

describe("OnchainTransactionsSync — the endpoint answering a different question", () => {
  /** Serve `chain`, with every answer rewritten on the way out as a broken provider's would be. */
  function serveRewritten(
    chain: Chain,
    rewrite: (method: string, result: unknown) => unknown,
    dropFilterKey?: string,
  ): RpcStub {
    const stubbed = rpcStub(chain);
    stub = stubbed;
    _setFetch(async (req, ip) => {
      const body = (await req.json()) as {
        id: number;
        method: string;
        params?: ReadonlyArray<unknown>;
      };
      let params = body.params ?? [];
      if (dropFilterKey !== undefined && body.method === "eth_getLogs") {
        const filter = { ...(params[0] as Record<string, unknown>) };
        filter[dropFilterKey] = undefined;
        params = [filter];
      }
      const res = await stubbed.fetch(
        new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify({ ...body, params }),
        }),
        ip,
      );
      const envelope = (await res.json()) as Record<string, unknown>;
      if ("result" in envelope) envelope.result = rewrite(body.method, envelope.result);
      return new Response(JSON.stringify(envelope), { status: 200 });
    });
    return stubbed;
  }

  test("a token nobody listed, from an endpoint that ignored the allow-list, is refused", async () => {
    // The allow-list goes out in the filter — and is checked on the way back,
    // because a filter is a request and not a proof. An endpoint that drops it
    // answers with every airdrop that ever touched the wallet, and those rows
    // would land in a reconciliation under a `coverage` line saying they were
    // never scanned for. The same trap as a Transfer between two strangers,
    // one field over.
    const chain = makeChain({ blocks: 12, startTimestamp: START, blockTime: 12n });
    const spam = address20("spamtoken");
    for (const [i, token] of [TOKEN, spam].entries()) {
      chain.logs.push({
        blockNumber: 4n,
        logIndex: i,
        address: token,
        topics: [TRANSFER_TOPIC, topicFor(ROUTER), topicFor(ALICE)],
        data: `0x${word(BigInt(1_000_000 * (i + 1)))}`,
        transactionHash: hash32(`tx-${i}`),
      });
    }
    serveRewritten(chain, (_method, result) => result, "address");
    await expect(
      sync({
        rpcUrl: RPC,
        address: ALICE,
        fromBlock: 0,
        toBlock: 8,
        include: ["tokenTransfers"],
        tokens: [{ token: TOKEN, decimals: 6, symbol: "USDC" }],
      }),
    ).rejects.toThrow(/is not one of them — it is not answering the question that was asked/);
  });

  test("the listed token still reconciles when the endpoint honours the filter", async () => {
    // The other half of the check above: it refuses an answer it did not ask
    // for, and nothing else.
    const chain = makeChain({ blocks: 12, startTimestamp: START, blockTime: 12n });
    chain.logs.push({
      blockNumber: 4n,
      logIndex: 0,
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topicFor(ROUTER), topicFor(ALICE)],
      data: `0x${word(1_000_000n)}`,
      transactionHash: hash32("tx-0"),
    });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 8,
      include: ["tokenTransfers"],
      tokens: [{ token: TOKEN, decimals: 6, symbol: "USDC" }],
    });
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.amountMinor).toBe(1_000_000);
  });

  test("a block answered with a different block's body is refused, not dated from it", async () => {
    // Every row's date and every entry in the reorg map is keyed by the number
    // in the REQUEST while its contents come out of the RESPONSE.
    const chain = walletChain();
    serveRewritten(chain, (method, result) => {
      if (method !== "eth_getBlockByNumber" || result === null) return result;
      const block = result as Record<string, unknown>;
      return block.number === "0xa" ? { ...block, number: "0x1f4" } : result;
    });
    await expect(
      sync({
        rpcUrl: RPC,
        address: ALICE,
        fromBlock: 10,
        toBlock: 10,
        include: ["native"],
        native: NATIVE_GWEI,
      }),
    ).rejects.toThrow(/block 10 was asked for and the endpoint answered with block 500/);
  });
});

describe("OnchainTransactionsSync — what the blocks held, checked against the nonce", () => {
  test("a hydrated block that came back short is caught, and refused", async () => {
    // The log scan proves a chunk was not truncated by splitting it. A block
    // cannot be split — it is one response — so the account's own nonce is the
    // oracle: it rises once per transaction sent, and a block that dropped one
    // leaves the two numbers apart. Without this the statement is simply short
    // by a payment and a fee, and says `complete: true`.
    const chain = makeChain({ blocks: 12, startTimestamp: START, blockTime: 12n });
    for (const [i, label] of ["tx-a", "tx-b"].entries()) {
      chain.txs.set(hash32(label), {
        hash: hash32(label),
        from: ALICE,
        to: BOB,
        value: 2_000_000_000n,
        nonce: BigInt(i),
        input: "0x",
        blockNumber: 4n,
      });
      chain.receipts.set(hash32(label), {
        hash: hash32(label),
        blockNumber: 4n,
        status: "0x1",
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n,
        logs: [],
      });
    }
    const stubbed = rpcStub(chain);
    stub = stubbed;
    _setFetch(async (req, ip) => {
      const res = await stubbed.fetch(req, ip);
      const body = (await res.json()) as { result?: unknown };
      const block = body.result;
      if (typeof block === "object" && block !== null && "transactions" in block) {
        const txs = (block as Record<string, unknown>).transactions;
        // The dangerous shape: a 200, a well-formed block, and one transaction
        // fewer than it holds. Nothing in the response says so.
        if (Array.isArray(txs) && txs.length > 1) {
          (block as Record<string, unknown>).transactions = [txs[0]];
        }
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    await expect(
      sync({
        rpcUrl: RPC,
        address: ALICE,
        fromBlock: 0,
        toBlock: 8,
        include: ["native", "fees"],
        native: NATIVE_GWEI,
      }),
    ).rejects.toThrow(
      /nonce for that account rose by 2 across the same range — at least 1 transaction it sent is missing/,
    );
  });

  test("an intact range is proved, and the proof travels with the rows", async () => {
    // The other side of the same check: it has to pass on a chain that is
    // whole, or the refusal above is just a tool that never works.
    serve(walletChain());
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      native: NATIVE_GWEI,
    });
    expect((result as unknown as Record<string, unknown>).sentProof).toEqual({
      outcome: "proved",
      sent: 3,
    });
    expect(result.coverage.nativeTransfers).toContain(
      "proved complete against this account's nonce",
    );
    expect(result.coverage.fees).toContain("proved complete against this account's nonce");
  });

  test("an endpoint that will not serve a historical nonce cannot prove it, and says so", async () => {
    // A pruned endpoint answers state from before its window with an error.
    // That is not evidence that the blocks were whole, and reporting it as one
    // would be the whole point of this check thrown away — so the verdict is
    // "not proved", named, in the output the caller reads.
    const chain = walletChain();
    // A head far past the range, because pruning is about distance from the
    // head: 128 blocks is what every full node keeps.
    for (let i = 40; i < 200; i++) {
      chain.blocks.push({
        number: BigInt(i),
        timestamp: START + BigInt(i) * 12n,
        hash: hash32(`block-${i}`),
        baseFeePerGas: 1_000_000_000n,
      });
    }
    chain.head = 199n;
    serve(chain, { archive: "no" });
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 10,
      toBlock: 16,
      native: NATIVE_GWEI,
    });
    const proof = (result as unknown as Record<string, unknown>).sentProof as Record<
      string,
      unknown
    >;
    expect(proof.outcome).toBe("unproved");
    expect(String(proof.why)).toContain("would not serve this account's nonce");
    expect(result.coverage.nativeTransfers).toContain("NOT proved");
    // And the rows are still there: an unprovable count is not a reason to
    // throw away a sync, only a reason not to call it proved.
    expect(result.rowCount).toBeGreaterThan(0);
  });

  test("a rollup's system transactions are more than the nonce, and that is not a refusal", async () => {
    // A deposit or system transaction appears in a block without raising an
    // ordinary nonce. Refusing there would make this unusable on the chains it
    // is most often pointed at, and nothing is missing in that direction.
    const chain = walletChain();
    // The nonce map says ALICE has sent one transaction ever; the blocks show
    // three. That is the rollup shape, in the direction that loses nothing.
    chain.nonces.set(ALICE, { latest: 1n, pending: 1n });
    serve(chain);
    const result = await sync({
      rpcUrl: RPC,
      address: ALICE,
      fromBlock: 0,
      toBlock: 20,
      native: NATIVE_GWEI,
    });
    const proof = (result as unknown as Record<string, unknown>).sentProof as Record<
      string,
      unknown
    >;
    expect({ outcome: proof.outcome, sent: proof.sent, nonce: proof.nonceAccountsFor }).toEqual({
      outcome: "moreThanTheNonce",
      sent: 3,
      nonce: 1,
    });
    expect(result.rows.some((r) => String(r.id).endsWith(":fee"))).toBe(true);
  });
});

describe("OnchainTransactionsSync — an order that is the chain's, not the provider's", () => {
  /** Two payments in ONE block, numbered by the chain 0 and 1. */
  function twoInOneBlock(): Chain {
    const chain = makeChain({ blocks: 12, startTimestamp: START, blockTime: 12n });
    for (const [i, label] of ["tx-first", "tx-second"].entries()) {
      chain.txs.set(hash32(label), {
        hash: hash32(label),
        from: ALICE,
        to: BOB,
        value: BigInt(i + 1) * 1_000_000_000n,
        nonce: BigInt(i),
        input: "0x",
        blockNumber: 4n,
      });
      chain.receipts.set(hash32(label), {
        hash: hash32(label),
        blockNumber: 4n,
        status: "0x1",
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n,
        transactionIndex: i,
        logs: [],
      });
    }
    return chain;
  }

  const ROWS = { rpcUrl: RPC, address: ALICE, fromBlock: 0, toBlock: 8, include: ["native"] };

  test("a provider that reverses a block's transaction list gets the same rows in the same order", async () => {
    // The position in the array is the ENDPOINT's choice; `transactionIndex` is
    // the chain's. Sorting on the first makes the row order a property of which
    // provider answered, and two syncs of one range then differ in a diff for
    // no reason on the chain.
    serve(twoInOneBlock());
    const straight = await sync({ ...ROWS, native: NATIVE_GWEI });
    const stubbed = rpcStub(twoInOneBlock());
    stub = stubbed;
    _setFetch(async (req, ip) => {
      const res = await stubbed.fetch(req, ip);
      const body = (await res.json()) as { result?: unknown };
      const block = body.result;
      if (typeof block === "object" && block !== null && "transactions" in block) {
        const txs = (block as Record<string, unknown>).transactions;
        if (Array.isArray(txs))
          (block as Record<string, unknown>).transactions = [...txs].reverse();
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const reversed = await sync({ ...ROWS, native: NATIVE_GWEI });
    expect(straight.rows.map((r) => r.id)).toEqual([
      `${hash32("tx-first")}:native`,
      `${hash32("tx-second")}:native`,
    ]);
    expect(JSON.stringify(reversed.rows)).toBe(JSON.stringify(straight.rows));
  });
});
