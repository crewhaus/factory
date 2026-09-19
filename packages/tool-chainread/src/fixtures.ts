/**
 * A recorded chain, and an RPC endpoint that serves it.
 *
 * No test in this package opens a socket. The stub below answers the ten
 * JSON-RPC methods these tools use, from data built here, and its knobs are the
 * ways a real public endpoint misbehaves: a block-span cap that errors with a
 * suggested range, a result cap that errors, a result cap that SILENTLY
 * truncates, a pruned archive, a mempool the endpoint cannot see, and an HTTP
 * layer that rate-limits. Those knobs are the fixtures that matter — the happy
 * path is the easy half.
 *
 * Every request is recorded in `requests`, so a test can assert what a tool
 * actually asked for: that a scan halved its range, that a search spent the
 * probes it claimed, that a poll stopped when it said it did.
 */
import type { RpcFetch } from "./lib/rpc";

/** A deterministic 32-byte hash from a label, so fixtures are readable in a diff. */
export function hash32(label: string): string {
  const hex = [...label].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `0x${(hex + "0".repeat(64)).slice(0, 64)}`;
}

/** A deterministic 20-byte address from a label. */
export function address20(label: string): string {
  const hex = [...label].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `0x${(hex + "0".repeat(40)).slice(0, 40)}`;
}

const hex = (value: bigint): string => `0x${value.toString(16)}`;

export const TOKEN = address20("token");
export const ALICE = address20("alice");
export const BOB = address20("bob");
export const ROUTER = address20("router");

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

export function topicFor(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

export function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

export type FixtureBlock = {
  readonly number: bigint;
  readonly timestamp: bigint;
  readonly hash: string;
  readonly baseFeePerGas: bigint | null;
};

export type FixtureLog = {
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly address: string;
  readonly topics: ReadonlyArray<string>;
  readonly data: string;
  readonly transactionHash: string;
};

export type FixtureTx = {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly value: bigint;
  readonly nonce: bigint;
  readonly input: string;
  readonly blockNumber: bigint | null;
};

export type FixtureReceipt = {
  readonly hash: string;
  readonly blockNumber: bigint;
  readonly status: "0x1" | "0x0" | null;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint | null;
  readonly l1Fee?: bigint;
  readonly gasUsedForL1?: bigint;
  readonly root?: string;
  /** Set only by a contract creation, which is the one case a transaction has no `to`. */
  readonly contractAddress?: string;
  /** The transaction's place in its block, as the chain numbers it. Default 0. */
  readonly transactionIndex?: number;
  readonly logs: ReadonlyArray<FixtureLog>;
};

export type Chain = {
  readonly chainId: bigint;
  blocks: FixtureBlock[];
  logs: FixtureLog[];
  txs: Map<string, FixtureTx>;
  receipts: Map<string, FixtureReceipt>;
  /** address → { latest, pending } nonce. */
  nonces: Map<string, { latest: bigint; pending: bigint }>;
  head: bigint;
  /** Tagged blocks the chain serves; a chain that serves neither is the pre-Merge case. */
  safe: bigint | null;
  finalized: bigint | null;
};

export type ChainOptions = {
  readonly chainId?: bigint;
  readonly blocks?: number;
  readonly startTimestamp?: bigint;
  readonly blockTime?: bigint;
  readonly baseFee?: bigint | null;
};

export function makeChain(options: ChainOptions = {}): Chain {
  const count = options.blocks ?? 100;
  const start = options.startTimestamp ?? 1_700_000_000n;
  const step = options.blockTime ?? 12n;
  const blocks: FixtureBlock[] = [];
  for (let i = 0; i < count; i++) {
    const number = BigInt(i);
    blocks.push({
      number,
      timestamp: start + number * step,
      hash: hash32(`block-${i}`),
      baseFeePerGas: options.baseFee === undefined ? 1_000_000_000n : options.baseFee,
    });
  }
  return {
    chainId: options.chainId ?? 8453n,
    blocks,
    logs: [],
    txs: new Map(),
    receipts: new Map(),
    nonces: new Map(),
    head: BigInt(count - 1),
    safe: BigInt(Math.max(0, count - 32)),
    finalized: BigInt(Math.max(0, count - 64)),
  };
}

/** Add `count` ERC-20 Transfer logs to one block, from ALICE to BOB. */
export function addTransferLogs(
  chain: Chain,
  blockNumber: bigint,
  count: number,
  token = TOKEN,
): void {
  const existing = chain.logs.filter((l) => l.blockNumber === blockNumber).length;
  for (let i = 0; i < count; i++) {
    chain.logs.push({
      blockNumber,
      logIndex: existing + i,
      address: token,
      topics: [TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
      data: `0x${word(BigInt(1_000 + i))}`,
      transactionHash: hash32(`tx-${blockNumber}-${i}`),
    });
  }
}

export function blockOf(chain: Chain, number: bigint): FixtureBlock | undefined {
  return chain.blocks.find((b) => b.number === number);
}

function renderBlock(chain: Chain, block: FixtureBlock, hydrate: boolean): Record<string, unknown> {
  const txs = [...chain.txs.values()].filter((t) => t.blockNumber === block.number);
  return {
    number: hex(block.number),
    hash: block.hash,
    parentHash:
      block.number === 0n ? hash32("genesis-parent") : hash32(`block-${block.number - 1n}`),
    timestamp: hex(block.timestamp),
    gasLimit: hex(30_000_000n),
    gasUsed: hex(15_000_000n),
    ...(block.baseFeePerGas === null ? {} : { baseFeePerGas: hex(block.baseFeePerGas) }),
    miner: address20("miner"),
    transactions: hydrate ? txs.map((t) => renderTx(t)) : txs.map((t) => t.hash),
  };
}

function renderTx(tx: FixtureTx): Record<string, unknown> {
  return {
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: hex(tx.value),
    nonce: hex(tx.nonce),
    input: tx.input,
    gas: hex(210_000n),
    gasPrice: hex(1_500_000_000n),
    maxFeePerGas: hex(2_000_000_000n),
    maxPriorityFeePerGas: hex(100_000_000n),
    type: "0x2",
    blockNumber: tx.blockNumber === null ? null : hex(tx.blockNumber),
    blockHash: tx.blockNumber === null ? null : hash32(`block-${tx.blockNumber}`),
    transactionIndex: tx.blockNumber === null ? null : "0x0",
  };
}

function renderLog(log: FixtureLog): Record<string, unknown> {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: hex(log.blockNumber),
    blockHash: hash32(`block-${log.blockNumber}`),
    transactionHash: log.transactionHash,
    transactionIndex: "0x0",
    logIndex: hex(BigInt(log.logIndex)),
    removed: false,
  };
}

function renderReceipt(receipt: FixtureReceipt): Record<string, unknown> {
  return {
    transactionHash: receipt.hash,
    blockNumber: hex(receipt.blockNumber),
    blockHash: hash32(`block-${receipt.blockNumber}`),
    transactionIndex: hex(BigInt(receipt.transactionIndex ?? 0)),
    gasUsed: hex(receipt.gasUsed),
    ...(receipt.status === null ? {} : { status: receipt.status }),
    ...(receipt.root === undefined ? {} : { root: receipt.root }),
    ...(receipt.effectiveGasPrice === null
      ? {}
      : { effectiveGasPrice: hex(receipt.effectiveGasPrice) }),
    ...(receipt.l1Fee === undefined ? {} : { l1Fee: hex(receipt.l1Fee) }),
    ...(receipt.gasUsedForL1 === undefined ? {} : { gasUsedForL1: hex(receipt.gasUsedForL1) }),
    contractAddress: receipt.contractAddress ?? null,
    logs: receipt.logs.map(renderLog),
  };
}

export type StubOptions = {
  /** Error when a getLogs span exceeds this, naming a range that would have worked. */
  readonly maxRangeBlocks?: bigint;
  /** Error when more than this many logs match — the "query returned more than N results" family. */
  readonly maxResults?: number;
  /** Return the first N matches and say nothing. This is the one that needs catching. */
  readonly silentLogCap?: number;
  /** `no` prunes historic state; `error` fails the probe for an unrelated reason. */
  readonly archive?: "yes" | "no" | "error";
  /** When false, the pending nonce equals the latest one however full the mempool is. */
  readonly mempoolAware?: boolean;
  /** Answer every request with this HTTP status instead. */
  readonly httpStatus?: number;
  /** Throw from the dialer, as an unreachable host does. */
  readonly unreachable?: boolean;
  /** Serve neither `safe` nor `finalized`, as a pre-Merge or minimal endpoint does. */
  readonly noFinalityTags?: boolean;
};

export type RpcStub = {
  readonly fetch: RpcFetch;
  /** Every request, in order: `{ method, params }`. */
  readonly requests: Array<{ readonly method: string; readonly params: ReadonlyArray<unknown> }>;
  /** Requests for one method, for the assertions that count probes or polls. */
  count(method: string): number;
};

/** Build an endpoint that serves `chain`, misbehaving in whatever way `options` says. */
export function rpcStub(chain: Chain, options: StubOptions = {}): RpcStub {
  const requests: Array<{ method: string; params: ReadonlyArray<unknown> }> = [];

  const stub: RpcStub = {
    requests,
    count: (method) => requests.filter((r) => r.method === method).length,
    fetch: async (req) => {
      if (options.unreachable === true) throw new TypeError("connect ECONNREFUSED");
      const body = (await req.json()) as {
        id: number;
        method: string;
        params?: ReadonlyArray<unknown>;
      };
      const params = body.params ?? [];
      requests.push({ method: body.method, params });

      if (options.httpStatus !== undefined && options.httpStatus !== 200) {
        return new Response(`{"error":"rate limited"}`, { status: options.httpStatus });
      }

      const answer = dispatch(chain, options, body.method, params);
      const envelope =
        "error" in answer
          ? { jsonrpc: "2.0", id: body.id, error: answer.error }
          : { jsonrpc: "2.0", id: body.id, result: answer.result };
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return stub;
}

type Answer = { result: unknown } | { error: { code: number; message: string } };

function dispatch(
  chain: Chain,
  options: StubOptions,
  method: string,
  params: ReadonlyArray<unknown>,
): Answer {
  switch (method) {
    case "eth_chainId":
      return { result: hex(chain.chainId) };
    case "net_version":
      return { result: chain.chainId.toString() };
    case "eth_blockNumber":
      return { result: hex(chain.head) };
    case "eth_getBlockByNumber": {
      const tag = params[0] as string;
      const hydrate = params[1] === true;
      const number = resolveTag(chain, options, tag);
      if (number === null) return { result: null };
      const block = blockOf(chain, number);
      if (block === undefined) return { result: null };
      const rendered = renderBlock(chain, block, hydrate);
      // The pending block is the head's contents with no identity yet: a node
      // answers it with number and hash both null.
      if (tag === "pending") return { result: { ...rendered, number: null, hash: null } };
      return { result: rendered };
    }
    case "eth_getBlockByHash": {
      const wanted = (params[0] as string).toLowerCase();
      const block = chain.blocks.find((b) => b.hash === wanted);
      return { result: block === undefined ? null : renderBlock(chain, block, params[1] === true) };
    }
    case "eth_getTransactionByHash": {
      const tx = chain.txs.get((params[0] as string).toLowerCase());
      return { result: tx === undefined ? null : renderTx(tx) };
    }
    case "eth_getTransactionReceipt": {
      const receipt = chain.receipts.get((params[0] as string).toLowerCase());
      return { result: receipt === undefined ? null : renderReceipt(receipt) };
    }
    case "eth_getTransactionCount": {
      const who = (params[0] as string).toLowerCase();
      const account = chain.nonces.get(who) ?? { latest: 0n, pending: 0n };
      const tag = params[1];
      if (typeof tag === "string" && tag.startsWith("0x")) {
        // A HISTORICAL nonce, which is account state and not a counter the node
        // keeps lying around: a pruned endpoint refuses it exactly as it
        // refuses a historical balance, and a sync that proves its block
        // coverage against this has to cope with both answers.
        const at = BigInt(tag);
        if (options.archive === "no" && chain.head - at > 128n) {
          return { error: { code: -32000, message: "missing trie node 0xabc (path )" } };
        }
        const mined = [...chain.txs.values()].filter(
          (t) => t.blockNumber !== null && t.from.toLowerCase() === who,
        );
        // Derived from the chain's own transactions so the two answers cannot
        // disagree by accident: a test that wants them to disagree says so.
        const base = chain.nonces.has(who) ? account.latest : BigInt(mined.length);
        const after = mined.filter((t) => (t.blockNumber as bigint) > at).length;
        const value = base - BigInt(after);
        return { result: hex(value < 0n ? 0n : value) };
      }
      const wantsPending = tag === "pending";
      // An endpoint with no mempool view answers both tags with the mined
      // count, which is the case that makes a naive "pending === latest means
      // clear" read wrong.
      if (wantsPending && options.mempoolAware !== false) return { result: hex(account.pending) };
      return { result: hex(account.latest) };
    }
    case "eth_getBalance": {
      const at = params[1] as string;
      const number = at.startsWith("0x") && at.length < 20 ? BigInt(at) : chain.head;
      if (options.archive === "no" && chain.head - number > 128n) {
        return { error: { code: -32000, message: "missing trie node 0xabc (path )" } };
      }
      if (options.archive === "error" && chain.head - number > 128n) {
        return { error: { code: -32601, message: "the method eth_getBalance does not exist" } };
      }
      return { result: hex(1_234_000_000_000_000_000n) };
    }
    case "eth_getLogs":
      return getLogs(chain, options, params[0] as Record<string, unknown>);
    default:
      return { error: { code: -32601, message: `the method ${method} does not exist` } };
  }
}

function resolveTag(chain: Chain, options: StubOptions, tag: string): bigint | null {
  if (tag === "latest") return chain.head;
  if (tag === "earliest") return 0n;
  if (tag === "pending") return chain.head;
  if (tag === "safe" || tag === "finalized") {
    if (options.noFinalityTags === true) return null;
    return tag === "safe" ? chain.safe : chain.finalized;
  }
  return BigInt(tag);
}

function getLogs(chain: Chain, options: StubOptions, filter: Record<string, unknown>): Answer {
  const from = BigInt(filter["fromBlock"] as string);
  const to = BigInt(filter["toBlock"] as string);
  const span = to - from + 1n;

  if (options.maxRangeBlocks !== undefined && span > options.maxRangeBlocks) {
    // Alchemy's shape: it names a range that would have worked, in hex.
    const suggestedTo = from + options.maxRangeBlocks - 1n;
    return {
      error: {
        code: -32600,
        message: `Log response size exceeded. You can make eth_getLogs requests with up to a ${options.maxRangeBlocks} block range; based on your parameters this block range should work: [${hex(from)}, ${hex(suggestedTo)}]`,
      },
    };
  }

  const addressFilter = filter["address"];
  const addresses =
    addressFilter === undefined
      ? null
      : new Set(
          (Array.isArray(addressFilter) ? addressFilter : [addressFilter]).map((a) =>
            String(a).toLowerCase(),
          ),
        );
  const topics = filter["topics"] as
    | ReadonlyArray<string | ReadonlyArray<string> | null>
    | undefined;

  const matched = chain.logs
    .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
    .filter((log) => addresses === null || addresses.has(log.address.toLowerCase()))
    .filter((log) => topicsMatch(log, topics))
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    );

  if (options.maxResults !== undefined && matched.length > options.maxResults) {
    return {
      error: {
        code: -32005,
        message: `query returned more than ${options.maxResults} results`,
      },
    };
  }
  if (options.silentLogCap !== undefined && matched.length > options.silentLogCap) {
    // The dangerous one: a 200, a well-formed array, and nothing saying it is
    // short. This is what the scanner has to catch without being told.
    return { result: matched.slice(0, options.silentLogCap).map(renderLog) };
  }
  return { result: matched.map(renderLog) };
}

function topicsMatch(
  log: FixtureLog,
  topics: ReadonlyArray<string | ReadonlyArray<string> | null> | undefined,
): boolean {
  if (topics === undefined) return true;
  return topics.every((position, index) => {
    if (position === null) return true;
    const actual = log.topics[index];
    if (actual === undefined) return false;
    const wanted = Array.isArray(position) ? position : [position];
    return wanted.some((t) => String(t).toLowerCase() === actual.toLowerCase());
  });
}
