/**
 * Paging `eth_getLogs`, and the part that matters: knowing when the answer is
 * incomplete.
 *
 * Public endpoints cap log queries, and they disagree about how. Some cap the
 * block span and say so in an error. Some cap the result count and say so.
 * Some cap the result count and DO NOT say so — they return two hundred logs
 * for a range that contains three hundred, with a 200 status and a
 * well-formed array, and nothing in the response distinguishes it from a range
 * that really did contain two hundred.
 *
 * That last case is the one worth writing code for. A harness that scans for
 * `Transfer` and finds nothing concludes no transfer happened; a missing log is
 * an event that did not happen, as far as everything downstream is concerned.
 * So the count is never trusted on its own: a chunk whose count is large enough
 * to be at somebody's cap is SPLIT and re-queried, and if the halves together
 * hold more logs than the whole did, the whole was truncated — proof, not a
 * heuristic about round numbers. When the split cannot go further because the
 * chunk is one block, there is nothing left to prove it with, and the scan
 * refuses instead of handing back a set it cannot vouch for.
 *
 * The cheap half is the documented cap: halve the span and retry on any error
 * the range could have caused, and when the endpoint names a workable range in
 * its error text, jump to that instead of halving down to it — clamped, never
 * trusted upward.
 */
import { ChainReadError, field, hexToBigint, lowerHex, toHexQuantity } from "./quantity";
import { type RpcClient, type RpcOutcome, failed } from "./rpc";

export type RawLog = {
  readonly address: string;
  readonly topics: ReadonlyArray<string>;
  readonly data: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly transactionIndex: number | null;
  readonly logIndex: number;
  readonly removed: boolean;
};

export type LogFilter = {
  readonly address?: ReadonlyArray<string>;
  readonly topics?: ReadonlyArray<string | ReadonlyArray<string> | null>;
};

export type ScanOptions = {
  readonly from: bigint;
  readonly to: bigint;
  /** Blocks per request to start with. Halved on a range error, and after a truncation. */
  readonly span: bigint;
  /**
   * The count at or above which a chunk is not believed without checking.
   * Default 1000, which is under every public cap this was written against, so
   * the check fires before the cap does rather than after.
   */
  readonly suspectAt: number;
  /** Refuse past this many logs rather than returning a slice of them. */
  readonly maxLogs: number;
  /** Refuse past this many requests, so one call cannot become a crawl. */
  readonly maxCalls: number;
};

export type ScanReport = {
  readonly logs: ReadonlyArray<RawLog>;
  readonly chunks: number;
  readonly calls: number;
  /** The span the scan ended up using, in blocks. Smaller than `span` means the endpoint pushed back. */
  readonly finalSpan: string;
  /** How many chunks came back truncated with no error saying so. */
  readonly silentTruncations: number;
  /** How many extra requests were spent proving a chunk was complete. */
  readonly verifications: number;
};

/**
 * How much of an error message is read looking for a range hint.
 *
 * Every provider puts the hint in the first sentence, and the rest of the
 * string is written by the endpoint — which, for a tool that dials a URL a
 * model chose, is an untrusted party with a sixteen-megabyte budget.
 */
const HINT_WINDOW = 512;

/**
 * What a provider's range complaint suggested, when it suggested anything
 * usable.
 *
 * Both quantifiers are bounded, and so is the prefix they run over. Unbounded,
 * `(\d[\d,_]*)\s*(k)?\s*blocks?` backtracks once per character of a digit run
 * for every position that run could start at, so a message that is nothing but
 * digits costs O(n²): 160k digits measured at a minute, and a full-size body
 * is not a slow call but a hang, in code that runs AFTER the request timeout
 * has already been cleared. A block span has at most a handful of digits and a
 * block number at most sixteen hex characters, so nothing real is lost.
 */
export function parseSuggestedSpan(message: string): bigint | null {
  const text = message.length > HINT_WINDOW ? message.slice(0, HINT_WINDOW) : message;
  // Alchemy names the exact range that would have worked: "[0x2932e0, 0x293acf]".
  const explicit = text.match(/\[\s*(0x[0-9a-fA-F]{1,16})\s*,\s*(0x[0-9a-fA-F]{1,16})\s*\]/);
  const lo = explicit?.[1];
  const hi = explicit?.[2];
  if (lo !== undefined && hi !== undefined) {
    const span = BigInt(hi) - BigInt(lo) + 1n;
    if (span > 0n) return span;
  }
  // "up to a 10000 block range", "limited to a 2k block range", "max 5,000 blocks".
  const named = text.match(/(\d[\d,_]{0,23})\s*(k)?\s*(?:block|blocks)\b/i);
  const digits = named?.[1];
  if (digits !== undefined) {
    const value = BigInt(digits.replace(/[,_]/g, ""));
    const scaled = named?.[2] === undefined ? value : value * 1000n;
    if (scaled > 0n) return scaled;
  }
  return null;
}

/**
 * Whether an unsuccessful call is something a smaller range might fix.
 *
 * Deliberately not a match on error text: providers phrase the same cap five
 * ways and invent new phrasings between releases, so the decision is made on
 * the SHAPE of the failure. A JSON-RPC error, an oversized body or a timeout
 * are all things a smaller range plausibly fixes. A 401, a 403 or a 429 are
 * not, and retrying them in halves turns one rejected request into sixteen —
 * a denial-of-service against the endpoint, executed by the tool that was
 * trying to be careful.
 */
export function shouldNarrow(outcome: Extract<RpcOutcome, { ok: false }>): boolean {
  if (outcome.kind === "rpcError" || outcome.kind === "tooLarge" || outcome.kind === "timeout") {
    return true;
  }
  if (outcome.kind !== "status") return false;
  const status = outcome.status ?? 0;
  return status !== 401 && status !== 403 && status !== 429;
}

export function projectLog(raw: unknown): RawLog {
  if (typeof raw !== "object" || raw === null) {
    throw new ChainReadError(`a log entry was ${JSON.stringify(raw)}, not an object`);
  }
  const topics = field(raw, "topics");
  return {
    address: lowerHex(field(raw, "address"), "log address"),
    topics: Array.isArray(topics) ? topics.map((t) => lowerHex(t, "log topic")) : [],
    data: typeof field(raw, "data") === "string" ? lowerHex(field(raw, "data"), "log data") : "0x",
    blockNumber: hexToBigint(field(raw, "blockNumber"), "log blockNumber").toString(),
    blockHash: lowerHex(field(raw, "blockHash"), "log blockHash"),
    transactionHash: lowerHex(field(raw, "transactionHash"), "log transactionHash"),
    transactionIndex:
      field(raw, "transactionIndex") === undefined
        ? null
        : Number(hexToBigint(field(raw, "transactionIndex"), "log transactionIndex")),
    logIndex: Number(hexToBigint(field(raw, "logIndex"), "log logIndex")),
    removed: field(raw, "removed") === true,
  };
}

type Budget = {
  calls: number;
  chunks: number;
  verifications: number;
  silentTruncations: number;
  span: bigint;
  /**
   * blockNumber → blockHash, for every batch the endpoint has returned,
   * including ones whose logs were later discarded. Scan-wide on purpose: the
   * re-query that proves a chunk was not truncated asks about blocks an
   * earlier request already answered, and that is exactly where a chain that
   * reorganised mid-scan becomes visible.
   */
  blockHashes: Map<string, string>;
};

/**
 * Scan a fixed block range and return every matching log, or refuse.
 *
 * The range must already be resolved to numbers by the caller. A scan whose
 * upper bound is the string `latest` is a scan whose answer changes while it
 * runs, and "complete" is not a claim anyone can make about that.
 */
export async function scanLogs(
  client: RpcClient,
  filter: LogFilter,
  options: ScanOptions,
): Promise<ScanReport> {
  if (options.from > options.to) {
    throw new ChainReadError(
      `the scan range is inverted: fromBlock ${options.from} is after toBlock ${options.to}`,
    );
  }

  const budget: Budget = {
    calls: 0,
    chunks: 0,
    verifications: 0,
    silentTruncations: 0,
    span: options.span < 1n ? 1n : options.span,
    blockHashes: new Map(),
  };

  const seen = new Set<string>();
  const collected: RawLog[] = [];

  let cursor = options.from;
  while (cursor <= options.to) {
    const end = min(cursor + budget.span - 1n, options.to);
    const logs = await fetchRange(client, filter, cursor, end, options, budget);
    for (const log of logs) admit(log, seen, collected, options);
    budget.chunks += 1;
    cursor = end + 1n;
  }

  collected.sort(byBlockThenIndex);
  return {
    logs: collected,
    chunks: budget.chunks,
    calls: budget.calls,
    finalSpan: budget.span.toString(),
    silentTruncations: budget.silentTruncations,
    verifications: budget.verifications,
  };
}

/**
 * One chunk, narrowed as often as the endpoint demands and verified when its
 * size makes it suspicious. Returns the logs for `[from, to]` in whatever order
 * they arrived; the caller sorts.
 */
async function fetchRange(
  client: RpcClient,
  filter: LogFilter,
  from: bigint,
  to: bigint,
  options: ScanOptions,
  budget: Budget,
): Promise<ReadonlyArray<RawLog>> {
  spend(budget, options);
  const outcome = await client.call("eth_getLogs", [
    {
      fromBlock: toHexQuantity(from),
      toBlock: toHexQuantity(to),
      ...(filter.address !== undefined && filter.address.length > 0
        ? { address: filter.address.length === 1 ? filter.address[0] : filter.address }
        : {}),
      ...(filter.topics !== undefined ? { topics: filter.topics } : {}),
    },
  ]);

  if (!outcome.ok) {
    if (!shouldNarrow(outcome)) {
      throw failed(outcome, `scanning blocks ${from}–${to}`);
    }
    if (from === to) {
      throw new ChainReadError(
        `blocks ${from}–${to} is a single block and this endpoint still refuses it (${outcome.message}) — there is no smaller range to fall back to, so narrow the filter (address, topics) or use an endpoint that will serve this block`,
      );
    }
    const hinted = outcome.kind === "rpcError" ? parseSuggestedSpan(outcome.message) : null;
    const current = to - from + 1n;
    // The hint is a ceiling, never a licence to grow: an endpoint that answers
    // "try 10000 blocks" to a 500-block request is describing its own limit,
    // not this request, and widening on it walks straight back into the error.
    const next = hinted !== null && hinted < current ? hinted : current / 2n;
    budget.span = clampSpan(next, budget.span);
    return splitAndFetch(client, filter, from, to, options, budget, budget.span);
  }

  const raw = outcome.result;
  if (!Array.isArray(raw)) {
    throw new ChainReadError(
      `scanning blocks ${from}–${to}: the endpoint answered eth_getLogs with ${JSON.stringify(raw)}, not an array`,
    );
  }
  const logs = raw.map(projectLog);
  vouch(logs, from, to, budget);

  if (logs.length < options.suspectAt) return logs;

  if (from === to) {
    // One block, at the cap, and no way to subdivide it — so there is no
    // evidence available either way. Returning it would be presenting an
    // unverifiable set as a complete one.
    throw new ChainReadError(
      `block ${from} alone returned ${logs.length} logs, which is at or above the ${options.suspectAt}-log mark where this endpoint may be truncating silently. A single block cannot be split to prove otherwise, so this refuses rather than returning a set it cannot vouch for: narrow the filter (address, topics), or raise suspectAt if you know this endpoint's cap is higher.`,
    );
  }

  // Large enough to be at somebody's cap. Split, re-query, and compare: if the
  // halves hold more than the whole did, the whole was truncated and nothing
  // in the response said so.
  budget.verifications += 1;
  const halves = await splitAndFetch(client, filter, from, to, options, budget, null);
  if (halves.length > logs.length) {
    budget.silentTruncations += 1;
    // Keep working at the size that was provably complete, so the rest of the
    // scan does not re-discover the same cap chunk after chunk.
    budget.span = clampSpan((to - from + 1n) / 2n, budget.span);
  }
  return halves;
}

/** Split `[from, to]` into pieces of `pieceSpan` (or two halves) and fetch each. */
async function splitAndFetch(
  client: RpcClient,
  filter: LogFilter,
  from: bigint,
  to: bigint,
  options: ScanOptions,
  budget: Budget,
  pieceSpan: bigint | null,
): Promise<ReadonlyArray<RawLog>> {
  const span = pieceSpan === null ? maxBig((to - from + 1n) / 2n, 1n) : maxBig(pieceSpan, 1n);
  const out: RawLog[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = min(cursor + span - 1n, to);
    out.push(...(await fetchRange(client, filter, cursor, end, options, budget)));
    cursor = end + 1n;
  }
  return out;
}

/**
 * Check a batch against the question that was asked, before any of it counts.
 *
 * All three checks are about an endpoint answering something other than what it
 * was asked, and all three make everything else in the scan untrustworthy — so
 * they refuse rather than filter.
 */
function vouch(logs: ReadonlyArray<RawLog>, from: bigint, to: bigint, budget: Budget): void {
  for (const log of logs) {
    const number = BigInt(log.blockNumber);
    if (number < from || number > to) {
      throw new ChainReadError(
        `the endpoint returned a log from block ${number} for a query over blocks ${from}–${to} — it is not answering the question that was asked`,
      );
    }
    if (log.removed) {
      throw new ChainReadError(
        `block ${number} returned a log marked removed, which means it belongs to a block the chain has reorganised away — rescan once the range is behind the reorg depth`,
      );
    }
    const known = budget.blockHashes.get(log.blockNumber);
    if (known === undefined) {
      budget.blockHashes.set(log.blockNumber, log.blockHash);
    } else if (known !== log.blockHash) {
      // Two requests, two different blocks at the same height: the chain
      // reorganised while this scan was running, and anything already collected
      // is from a history that no longer exists.
      throw new ChainReadError(
        `block ${number} came back with hash ${log.blockHash} after an earlier request said ${known} — the chain reorganised while this scan was running, so the result would mix two histories`,
      );
    }
  }
}

function admit(log: RawLog, seen: Set<string>, collected: RawLog[], options: ScanOptions): void {
  // The transaction hash is in the key because `logIndex` is per BLOCK in the
  // spec and per TRANSACTION on several endpoints. Keyed on the block and the
  // index alone, two logs from two transactions in one block are one log here,
  // and the one that loses is dropped under `complete: true` — the failure
  // this whole file exists to make impossible. A genuine duplicate still
  // matches on all three, so nothing is admitted twice.
  const key = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
  if (seen.has(key)) return;
  seen.add(key);
  collected.push(log);
  if (collected.length > options.maxLogs) {
    throw new ChainReadError(
      `this range holds more than maxLogs (${options.maxLogs}) matching logs — refusing to return the first ${options.maxLogs} of them, because a truncated set is indistinguishable from a complete one once it leaves here. Scan a smaller range, or raise maxLogs.`,
    );
  }
}

function spend(budget: Budget, options: ScanOptions): void {
  budget.calls += 1;
  if (budget.calls > options.maxCalls) {
    throw new ChainReadError(
      `this scan needed more than maxCalls (${options.maxCalls}) requests — the endpoint is narrowing the range faster than the range is shrinking. Scan a smaller range, or narrow the filter.`,
    );
  }
}

function clampSpan(next: bigint, current: bigint): bigint {
  const bounded = next < 1n ? 1n : next;
  return bounded < current ? bounded : current;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

function byBlockThenIndex(a: RawLog, b: RawLog): number {
  const an = BigInt(a.blockNumber);
  const bn = BigInt(b.blockNumber);
  if (an !== bn) return an < bn ? -1 : 1;
  return a.logIndex - b.logIndex;
}
