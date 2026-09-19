/**
 * Block headers, and the search over their timestamps.
 *
 * The search is the reason this file is not three lines long. "Which block was
 * the chain at on 1 March?" is asked by every reconciliation, every
 * backtest and every "what did the contract hold at the end of the quarter",
 * and the answer is used as a `blockTag` in later reads — so a wrong answer is
 * not a wrong number on a screen, it is a whole report computed against the
 * wrong state.
 *
 * The invariant is written down in one place, here, and the result carries the
 * evidence for it:
 *
 *     the returned block is the LAST block whose timestamp is <= the target,
 *     and the block after it has a timestamp > the target.
 *
 * Both halves are checked before the answer is returned. Half an invariant —
 * "a block at or before the timestamp" — is satisfied by the genesis block,
 * which is why it is not the contract.
 */
import {
  type BlockTag,
  ChainReadError,
  field,
  hexToBigint,
  lowerHex,
  optionalHexToBigint,
  requireObject,
  toHexQuantity,
  unixToIso,
} from "./quantity";
import { type RpcClient, callOrThrow } from "./rpc";

export type BlockSelector =
  | { readonly kind: "number"; readonly value: bigint }
  | { readonly kind: "tag"; readonly tag: BlockTag }
  | { readonly kind: "hash"; readonly hash: string };

/**
 * A block header, projected.
 *
 * Every quantity is a decimal STRING. `gasUsed` fits in a double today and
 * `baseFeePerGas` does not always — and having two conventions in one object is
 * how the wrong one gets copied into the next file.
 */
export type BlockSummary = {
  /** `null` only for the pending block, which has not been assigned one yet. */
  readonly number: string | null;
  readonly hash: string | null;
  readonly parentHash: string | null;
  readonly timestamp: string;
  readonly timestampIso: string | null;
  readonly gasLimit: string | null;
  readonly gasUsed: string | null;
  /**
   * `null` on a pre-1559 block and on chains that never adopted it. Reported
   * next to `feeMarket` so a caller reads "this chain has no base fee" rather
   * than putting a null into a fee calculation.
   */
  readonly baseFeePerGas: string | null;
  readonly feeMarket: "eip1559" | "legacy";
  readonly miner: string | null;
  readonly transactionCount: number | null;
  readonly transactions?: ReadonlyArray<string>;
  readonly pending: boolean;
};

export function selectorToRpc(selector: BlockSelector): {
  readonly method: string;
  readonly params: ReadonlyArray<unknown>;
} {
  if (selector.kind === "hash") {
    return { method: "eth_getBlockByHash", params: [selector.hash, false] };
  }
  const tag = selector.kind === "tag" ? selector.tag : toHexQuantity(selector.value);
  return { method: "eth_getBlockByNumber", params: [tag, false] };
}

export function describeSelector(selector: BlockSelector): string {
  if (selector.kind === "hash") return `block ${selector.hash}`;
  if (selector.kind === "tag") return `block "${selector.tag}"`;
  return `block ${selector.value}`;
}

/**
 * Fetch one header, or `null` when the chain has no such block.
 *
 * A node answers an unknown block with `result: null` and no error, which is
 * the one JSON-RPC shape that most resembles success. Collapsing it into an
 * exception would lose the distinction a caller needs: "block 99999999 does not
 * exist yet" is an answer about the chain, while "the endpoint refused" is not.
 */
export async function fetchBlock(
  client: RpcClient,
  selector: BlockSelector,
): Promise<BlockSummary | null> {
  const { method, params } = selectorToRpc(selector);
  // Always the hash list, never the hydrated bodies. Nothing in this package
  // reads a transaction out of a block — `EvmTransactionSummary` fetches the
  // one it was asked about — and hydrating pulls a megabyte of transaction
  // objects to throw all but their hashes away.
  const raw = await callOrThrow(client, method, params, `reading ${describeSelector(selector)}`);
  if (raw === null || raw === undefined) return null;
  return projectBlock(requireObject(raw, `the answer for ${describeSelector(selector)}`));
}

export function projectBlock(raw: Record<string, unknown>): BlockSummary {
  const numberField = raw["number"];
  const pending = numberField === null || numberField === undefined;
  const base = optionalHexToBigint(raw["baseFeePerGas"], "baseFeePerGas");
  const timestamp = hexToBigint(raw["timestamp"], "block timestamp");
  const txs = raw["transactions"];
  // A node asked for the hash list answers with strings, and one that hydrates
  // anyway answers with objects. Reading only the first shape is how
  // `includeTransactions` became a field that silently returned nothing: the
  // hashes were there, in a form this did not recognise.
  const hashes = Array.isArray(txs) ? hashesOf(txs) : undefined;

  return {
    number: pending ? null : hexToBigint(numberField, "block number").toString(),
    hash: typeof raw["hash"] === "string" ? lowerHex(raw["hash"], "block hash") : null,
    parentHash:
      typeof raw["parentHash"] === "string" ? lowerHex(raw["parentHash"], "parentHash") : null,
    timestamp: timestamp.toString(),
    timestampIso: unixToIso(timestamp),
    gasLimit: optionalHexToBigint(raw["gasLimit"], "gasLimit")?.toString() ?? null,
    gasUsed: optionalHexToBigint(raw["gasUsed"], "gasUsed")?.toString() ?? null,
    baseFeePerGas: base === null ? null : base.toString(),
    feeMarket: base === null ? "legacy" : "eip1559",
    miner: typeof raw["miner"] === "string" ? lowerHex(raw["miner"], "miner") : null,
    transactionCount: Array.isArray(txs) ? txs.length : null,
    ...(hashes !== undefined ? { transactions: hashes } : {}),
    pending,
  };
}

/** The hashes out of a `transactions` array, in either of the two shapes a node sends. */
function hashesOf(txs: ReadonlyArray<unknown>): ReadonlyArray<string> | undefined {
  const out: string[] = [];
  for (const entry of txs) {
    if (typeof entry === "string") {
      out.push(entry.toLowerCase());
      continue;
    }
    const hash = typeof entry === "object" && entry !== null ? field(entry, "hash") : undefined;
    if (typeof hash !== "string") return undefined;
    out.push(hash.toLowerCase());
  }
  return out;
}

/** The head block number, read once so a scan or a search works against a fixed chain tip. */
export async function headNumber(client: RpcClient): Promise<bigint> {
  const raw = await callOrThrow(client, "eth_blockNumber", [], "reading the head block number");
  return hexToBigint(raw, "eth_blockNumber");
}

// ---------------------------------------------------------------------------
// the search
// ---------------------------------------------------------------------------

type Sample = { readonly number: bigint; readonly timestamp: bigint };

export type TimestampSearch =
  | {
      readonly outcome: "found";
      /** The last block at or before the target. */
      readonly at: BlockSummary;
      /** The first block strictly after it, or `null` when the target is at or past the head. */
      readonly next: BlockSummary | null;
      readonly atHead: boolean;
      readonly probes: number;
    }
  | {
      /** Every block in the bracket is later than the target — there is nothing at or before it. */
      readonly outcome: "beforeRange";
      readonly first: BlockSummary;
      readonly probes: number;
    };

/**
 * Binary search for the last block at or before `target`.
 *
 * Deliberately NOT interpolated. Estimating a block from an average block time
 * converges in fewer probes on a chain with a steady block time and badly on
 * one that changed (Ethereum before and after the Merge is two different
 * chains by this measure), and the failure mode of a bad estimate is extra
 * probes at best and a wrong bracket at worst. Bisection over twenty million
 * blocks is twenty-five probes, every one of which narrows a bracket that is
 * provably still correct. When a caller already knows roughly where to look,
 * `fromBlock`/`toBlock` cut the bracket and the probe count with it.
 *
 * Non-decreasing timestamps are the assumption the whole search rests on, and
 * the assumption is CHECKED rather than trusted: every sample is compared with
 * every other, and a pair that goes backwards is a refusal naming both blocks.
 * A chain where that happens is a chain where "the block at 09:00" has more
 * than one answer, and picking one silently is the lie.
 */
export async function searchBlockAtTimestamp(
  client: RpcClient,
  target: bigint,
  bracket: { readonly low: bigint; readonly high: bigint },
  maxProbes = 64,
): Promise<TimestampSearch> {
  const samples: Sample[] = [];
  let probes = 0;

  const probe = async (number: bigint): Promise<BlockSummary> => {
    probes += 1;
    if (probes > maxProbes) {
      throw new ChainReadError(
        `the timestamp search used more than ${maxProbes} probes over blocks ${bracket.low}–${bracket.high} — the bracket is implausibly wide or the endpoint is answering inconsistently`,
      );
    }
    const block = await fetchBlock(client, { kind: "number", value: number });
    if (block === null) {
      throw new ChainReadError(
        `block ${number} is inside the search bracket ${bracket.low}–${bracket.high} but the endpoint says it does not exist — the bracket is wrong, or this endpoint is not serving the whole chain`,
      );
    }
    record(samples, { number, timestamp: BigInt(block.timestamp) });
    return block;
  };

  let low = bracket.low;
  let high = bracket.high;
  if (low > high) {
    throw new ChainReadError(`search bracket is inverted: ${low} > ${high}`);
  }

  const lowBlock = await probe(low);
  if (BigInt(lowBlock.timestamp) > target) {
    // Nothing at or before the target exists in this bracket. For the default
    // bracket that means the timestamp predates genesis; returning block 0
    // anyway — "the earliest block we have" — is the answer a caller would
    // silently use to query state that did not exist.
    return { outcome: "beforeRange", first: lowBlock, probes };
  }

  if (high === low) {
    return { outcome: "found", at: lowBlock, next: null, atHead: true, probes };
  }

  const highBlock = await probe(high);
  if (BigInt(highBlock.timestamp) <= target) {
    // The target is at or past the tip of the bracket. The head is the honest
    // answer and `next: null` says why there is nothing after it: this answer
    // will change as the chain advances.
    return { outcome: "found", at: highBlock, next: null, atHead: true, probes };
  }

  // Invariant from here: timestamp(low) <= target < timestamp(high).
  let lowSummary = lowBlock;
  let highSummary = highBlock;
  while (high - low > 1n) {
    const mid = low + (high - low) / 2n;
    const midBlock = await probe(mid);
    if (BigInt(midBlock.timestamp) <= target) {
      low = mid;
      lowSummary = midBlock;
    } else {
      high = mid;
      highSummary = midBlock;
    }
  }

  return { outcome: "found", at: lowSummary, next: highSummary, atHead: false, probes };
}

/**
 * Keep the samples, and refuse the moment two of them disagree about time's
 * direction. Cheap: the search takes at most a few dozen samples, so the
 * pairwise comparison is free next to one RPC round trip.
 */
function record(samples: Sample[], next: Sample): void {
  for (const seen of samples) {
    const earlier = seen.number < next.number ? seen : next;
    const later = seen.number < next.number ? next : seen;
    if (earlier.number === later.number) continue;
    if (earlier.timestamp > later.timestamp) {
      throw new ChainReadError(
        `this chain's block timestamps go backwards — block ${earlier.number} is stamped ${earlier.timestamp} but the later block ${later.number} is stamped ${later.timestamp}. A binary search over timestamps has no single right answer here, so this refuses rather than returning one of several.`,
      );
    }
  }
  samples.push(next);
}
