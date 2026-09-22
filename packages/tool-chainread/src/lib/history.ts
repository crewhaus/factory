/**
 * One address's onchain history, in the row shape a reconciler already
 * consumes.
 *
 * The row shape is NOT this package's. `@crewhaus/tool-money` owns
 * `Transaction` — the shape `StatementParse` produces and
 * `@crewhaus/tool-ledger`'s `LedgerReconcile` consumes — and it is imported
 * here rather than re-declared, because a second declaration of it is a shape
 * that drifts the first time a field is added, and an onchain history that
 * cannot be reconciled against a bank statement is the whole point of the tool
 * gone.
 *
 * What that costs, and what is done about it: `amountMinor` is a JS `number`,
 * and a uint256 is not. Nothing here rounds to fit. An amount that does not
 * survive the conversion exactly — dust below the ledger's smallest unit, or a
 * magnitude past `Number.MAX_SAFE_INTEGER`, which 0.01 ETH in wei already is —
 * is PARKED with the exact raw value and a named reason rather than emitted as
 * a row that reconciles to the wrong number. An empty history and an
 * unrepresentable one are different answers.
 *
 * Three sources, and only three, because a public endpoint has no index by
 * address:
 *
 *   1. **Logged token transfers**, from `eth_getLogs` filtered on the Transfer
 *      topic with the address in the from or the to position. Paged by
 *      `scanLogs` — the same code `EvmEventScan` uses, so the silent-truncation
 *      proof, the reorg check and the refusal-rather-than-a-prefix behaviour
 *      are the tested ones rather than a second implementation of them.
 *   2. **Native value and gas**, from hydrating each block in the range and
 *      picking out the transactions this address sent or received. One request
 *      per block, so the range is bounded and a range past the bound is a
 *      refusal, not a quiet token-only answer.
 *   3. Nothing else. Internal native transfers need a trace, ERC-1155 puts its
 *      parties in different topic positions and its batch amounts in data where
 *      no filter reaches, and an explorer's address index is not a public RPC.
 *      All three are reported as excluded in the output, not only here.
 */
import type { Transaction } from "@crewhaus/tool-money";
import { type LogFilter, type RawLog, projectLog, scanLogs } from "./logs";
import {
  ChainReadError,
  field,
  hexToBigint,
  requireObject,
  toHexQuantity,
  unixToIso,
} from "./quantity";
import { type RpcClient, callOrThrow } from "./rpc";
import {
  TRANSFER_TOPIC,
  addressToTopic,
  decodeTransfer,
  feeBreakdown,
  projectReceipt,
  projectTransaction,
} from "./transfers";

/** `amountMinor` is a `number`, so this is the ceiling every row has to clear. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * What a caller knows about one asset's units.
 *
 * `decimals` is never read off the chain. Resolving it costs an `eth_call` per
 * token and a token contract is free to report whatever it likes — an airdrop
 * whose `decimals()` returns 2 turns a dust transfer into a five-figure row.
 * So it arrives from the caller or it stays `null`, and `null` means the raw
 * base units are used as the minor units, which is exact.
 */
export type AssetUnits = {
  readonly decimals: number | null;
  /** The ledger's minor unit for this asset. Defaults to `decimals`, i.e. base units. */
  readonly minorUnitDecimals: number | null;
  readonly symbol: string | null;
};

export const UNKNOWN_UNITS: AssetUnits = Object.freeze({
  decimals: null,
  minorUnitDecimals: null,
  symbol: null,
});

export type HistoryOptions = {
  /** Exactly one address: a statement is one account's, and the row shape has no account column. */
  readonly address: string;
  readonly from: bigint;
  readonly to: bigint;
  readonly includeTokens: boolean;
  readonly includeNative: boolean;
  readonly includeFees: boolean;
  /** Lowercased token address → units. Also the scan's address filter when `onlyKnownTokens`. */
  readonly tokenUnits: ReadonlyMap<string, AssetUnits>;
  readonly onlyKnownTokens: boolean;
  readonly nativeUnits: AssetUnits;
  /** Blocks per `eth_getLogs` request to start from; narrowed by `scanLogs` as the endpoint pushes back. */
  readonly span: bigint;
  readonly suspectAt: number;
  readonly maxRows: number;
  readonly maxHydratedBlocks: number;
  readonly maxCalls: number;
};

/**
 * Everything about a row that the `Transaction` shape has nowhere to put.
 *
 * Keyed by the row's `id`, so the exact uint256 is one lookup away and is never
 * the thing that got rounded. A reconciler reads `rows`; an auditor reads this.
 */
export type RowDetail = {
  readonly id: string;
  readonly kind: "token" | "native" | "fee";
  readonly standard: "erc20" | "erc721" | "native" | "fee";
  readonly asset: string;
  readonly symbol: string | null;
  readonly assetDecimals: number | null;
  readonly minorUnitDecimals: number | null;
  /** The chain's own number, in base units, as a decimal string. Never a double. */
  readonly rawAmount: string;
  readonly tokenId: string | null;
  readonly counterparty: string | null;
  readonly txHash: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly timestamp: string;
  readonly timestampIso: string | null;
  /**
   * The transaction's own status, in the three values a receipt actually has.
   * `unknown` is a pre-Byzantium receipt, which carries a state root instead
   * and does not record whether the call reverted — collapsing that onto
   * `false` would assert a success the chain never claimed.
   */
  readonly status: "success" | "reverted" | "unknown";
  readonly feeModel?: string;
};

/** A movement that exists on the chain and cannot be written as a row. Never dropped, never rounded. */
export type ParkedRow = {
  readonly id: string;
  readonly reason: "belowMinorUnit" | "exceedsSafeInteger" | "timestampOutOfRange" | "undecodable";
  readonly why: string;
  readonly asset: string;
  readonly rawAmount: string | null;
  readonly txHash: string;
  readonly blockNumber: string;
};

/**
 * Whether the blocks the endpoint served held every transaction this address
 * SENT over the range — and, when that could not be established, why not.
 *
 * A hydrated block is one response that cannot be split, so the split-and-
 * compare proof the log scan uses has nothing to work with here. The account's
 * own nonce is the oracle instead: it goes up once per transaction sent, so its
 * rise across the range is the number of transactions that must be in those
 * blocks. Fewer is a refusal — every one missed is a fee row and possibly a
 * payment. The count is never reported as proved when the nonce could not be
 * read: a pruned endpoint answers a historical `eth_getTransactionCount` with
 * an error, and "could not check" is not "checked".
 */
export type SentProof =
  | { readonly outcome: "proved"; readonly sent: number }
  | {
      readonly outcome: "moreThanTheNonce";
      readonly sent: number;
      readonly nonceAccountsFor: number;
      readonly why: string;
    }
  | { readonly outcome: "unproved"; readonly sent: number; readonly why: string };

export type HistoryReport = {
  readonly rows: ReadonlyArray<Transaction>;
  readonly detail: ReadonlyArray<RowDetail>;
  readonly unrepresentable: ReadonlyArray<ParkedRow>;
  readonly logChunks: number;
  readonly logCalls: number;
  readonly silentTruncations: number;
  readonly verifications: number;
  readonly hydratedBlocks: number;
  readonly receiptsRead: number;
  /** Transfers where this address is both parties: they move nothing, so they are not rows. */
  readonly selfTransfers: number;
  /** Absent when no block was hydrated, because then nothing claims to have read what it sent. */
  readonly sentProof?: SentProof;
};

/** One movement, before it is asked whether it fits in a row. */
type Movement = {
  readonly id: string;
  readonly kind: "token" | "native" | "fee";
  readonly standard: "erc20" | "erc721" | "native" | "fee";
  readonly asset: string;
  readonly tokenId: string | null;
  readonly counterparty: string | null;
  readonly raw: bigint;
  readonly direction: "debit" | "credit";
  readonly txHash: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  /** Sorted on, so the order is this code's and not the order a provider happened to answer in. */
  readonly ordinal: number;
  readonly status: "success" | "reverted" | "unknown";
  readonly feeModel?: string;
};

type Budget = {
  readonly client: RpcClient;
  readonly maxCalls: number;
  logChunks: number;
  logCalls: number;
  silentTruncations: number;
  verifications: number;
  hydratedBlocks: number;
  receiptsRead: number;
  /** blockNumber → blockHash, across BOTH sources. Where a chain moving under the sync shows itself. */
  readonly blockHashes: Map<string, string>;
  readonly timestamps: Map<string, bigint>;
};

/**
 * Collect the history, or refuse.
 *
 * The range must already be resolved to numbers and pinned by the caller. A
 * sync whose upper bound is still the string `latest` cannot hand back a cursor
 * anybody can resume from, because the block it stopped at is not a block it
 * can name.
 */
export async function collectHistory(
  client: RpcClient,
  options: HistoryOptions,
): Promise<HistoryReport> {
  if (options.from > options.to) {
    throw new ChainReadError(
      `the sync range is inverted: fromBlock ${options.from} is after toBlock ${options.to}`,
    );
  }

  const budget: Budget = {
    client,
    maxCalls: options.maxCalls,
    logChunks: 0,
    logCalls: 0,
    silentTruncations: 0,
    verifications: 0,
    hydratedBlocks: 0,
    receiptsRead: 0,
    blockHashes: new Map(),
    timestamps: new Map(),
  };

  const movements: Movement[] = [];
  let selfTransfers = 0;
  let sentProof: SentProof | undefined;
  const parked: ParkedRow[] = [];

  if (options.includeTokens) {
    const logs = await scanTransfers(client, options, budget);
    for (const log of logs) {
      const decoded = decodeTransfer(log);
      if (decoded === null) {
        // A log carrying the Transfer topic that does not decode is not an
        // absent transfer. Parking it keeps "there was nothing" and "there was
        // something I could not read" apart, which is the distinction a
        // reconciliation is built on.
        parked.push({
          id: `${log.transactionHash}:log:${log.logIndex}`,
          reason: "undecodable",
          why: "this log carries the Transfer topic but not the topics a Transfer event has, so what moved cannot be read from it",
          asset: log.address,
          rawAmount: null,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
        });
        continue;
      }
      // The filter asked the endpoint for logs with this address in a topic.
      // The DECODED parties are what the row is built from, and they are what
      // is checked: a filter is a request, not a proof, and acting on the
      // request while the answer says something else is how a row lands on the
      // wrong side of a ledger.
      const isSender = decoded.from === options.address;
      const isRecipient = decoded.to === options.address;
      if (!isSender && !isRecipient) {
        throw new ChainReadError(
          `the endpoint returned a Transfer in ${log.transactionHash} between ${decoded.from} and ${decoded.to}, neither of which is ${options.address} — it is not answering the question that was asked`,
        );
      }
      if (isSender && isRecipient) {
        // A transfer to oneself changes no balance. One row would be a debit
        // that never happened; two rows would net to zero through a
        // reconciliation that then has two unmatched lines.
        selfTransfers += 1;
        continue;
      }
      if (decoded.standard === "erc1155") {
        // The filter asked for the ERC-20/721 Transfer topic, so a
        // TransferSingle cannot be an answer to it. Labelling it erc20 and
        // moving on would put a multi-token amount in a row that says it is a
        // fungible one.
        throw new ChainReadError(
          `the endpoint returned an ERC-1155 TransferSingle in ${log.transactionHash} for a filter on the ERC-20/721 Transfer topic — it is not answering the question that was asked`,
        );
      }
      movements.push({
        id: `${log.transactionHash}:log:${log.logIndex}`,
        kind: "token",
        standard: decoded.standard,
        asset: decoded.token,
        tokenId: decoded.tokenId ?? null,
        counterparty: isSender ? decoded.to : decoded.from,
        raw: BigInt(decoded.amount),
        direction: isSender ? "debit" : "credit",
        txHash: log.transactionHash,
        blockNumber: BigInt(log.blockNumber),
        blockHash: log.blockHash,
        ordinal: log.logIndex,
        // A revert discards the logs with everything else, so a log that exists
        // is a call that succeeded. Nothing is inferred here beyond that.
        status: "success",
      });
    }
  }

  if (options.includeNative || options.includeFees) {
    const native = await scanBlocksForNative(client, options, budget);
    movements.push(...native.movements);
    selfTransfers += native.selfTransfers;
    sentProof = native.sentProof;
  }

  const { rows, detail, parked: moreParked } = await toRows(movements, options, budget);
  parked.push(...moreParked);

  // Parked movements count against the ceiling too. They are the same
  // movements, carried in a different array because they would not fit a row,
  // and a caller that has to read all of them has the same problem whichever
  // array they are in.
  if (rows.length + parked.length > options.maxRows) {
    throw new ChainReadError(
      `this range holds more than maxRows (${options.maxRows}) movements for ${options.address} — ${rows.length} row(s) and ${parked.length} that could not be written as one. Refusing to return the first ${options.maxRows} of them, because a truncated statement is indistinguishable from a complete one once it leaves here. Sync a smaller range, or raise maxRows.`,
    );
  }

  return {
    rows,
    detail,
    unrepresentable: parked,
    logChunks: budget.logChunks,
    logCalls: budget.logCalls,
    silentTruncations: budget.silentTruncations,
    verifications: budget.verifications,
    hydratedBlocks: budget.hydratedBlocks,
    receiptsRead: budget.receiptsRead,
    selfTransfers,
    ...(sentProof === undefined ? {} : { sentProof }),
  };
}

// ---------------------------------------------------------------------------
// source 1: logged token transfers
// ---------------------------------------------------------------------------

/**
 * Two scans, because an address is a party to a Transfer in two different topic
 * positions and no single filter matches either-or across positions.
 *
 * ERC-20 and ERC-721 share the topic and the positions, so both come out of
 * these two. ERC-1155 does not — `TransferSingle` carries the operator at
 * position 1 and the parties at 2 and 3, and `TransferBatch` keeps its amounts
 * in data — and it is reported as excluded rather than scanned for badly.
 */
async function scanTransfers(
  client: RpcClient,
  options: HistoryOptions,
  budget: Budget,
): Promise<ReadonlyArray<RawLog>> {
  const topic = addressToTopic(options.address);
  // The allow-list is applied in the filter the endpoint sees, not after the
  // logs come back: an unrestricted scan of a busy address pulls in every
  // airdrop that ever touched it, and the cheapest place to not have those is
  // to not fetch them.
  //
  // ONE value drives both the request and the check on the answer. A filter is
  // a request, not a proof — the same reason the decoded parties are checked
  // below — and an endpoint that ignores `address` answers with every token
  // that touched the wallet. Those rows would land in a reconciliation under a
  // `coverage` line saying they were never scanned for, which is how an
  // attacker-supplied airdrop becomes a credit in somebody's books.
  const allowed =
    options.onlyKnownTokens && options.tokenUnits.size > 0
      ? new Set(options.tokenUnits.keys())
      : null;
  const addressFilter = allowed === null ? {} : { address: [...allowed] };

  const outgoing: LogFilter = { ...addressFilter, topics: [TRANSFER_TOPIC, topic] };
  const incoming: LogFilter = { ...addressFilter, topics: [TRANSFER_TOPIC, null, topic] };

  const seen = new Set<string>();
  const merged: RawLog[] = [];
  for (const filter of [outgoing, incoming]) {
    const report = await scanLogs(client, filter, {
      from: options.from,
      to: options.to,
      span: options.span,
      suspectAt: options.suspectAt,
      maxLogs: options.maxRows,
      maxCalls: Math.max(1, options.maxCalls - client.calls),
    });
    budget.logChunks += report.chunks;
    budget.logCalls += report.calls;
    budget.silentTruncations += report.silentTruncations;
    budget.verifications += report.verifications;
    for (const log of report.logs) {
      if (allowed !== null && !allowed.has(log.address)) {
        throw new ChainReadError(
          `the endpoint returned a ${log.address} log for a filter that named ${allowed.size} token(s), and that is not one of them — it is not answering the question that was asked, and a token nobody listed has no decimals here to be read in`,
        );
      }
      rememberBlockHash(budget, log.blockNumber, log.blockHash, "a log");
      // `scanLogs` dedupes within one scan; a transfer between two accounts the
      // caller happens to hold both of comes back from BOTH scans, and the key
      // is the same three fields for the same reason it is there.
      const key = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(log);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// source 2: native value and gas, from the blocks themselves
// ---------------------------------------------------------------------------

/**
 * Hydrate every block in the range and keep the transactions this address was a
 * party to.
 *
 * There is no `eth_getTransactionsByAddress`. This is the only way to see a
 * plain value transfer over a public endpoint, and it costs one request per
 * block — so the range is bounded, and a range past the bound is a refusal.
 * Returning the token rows alone and calling it a history is the failure this
 * package is organised against: a wallet's ETH payments would simply not be in
 * the statement, and nothing in it would say so.
 */
async function scanBlocksForNative(
  client: RpcClient,
  options: HistoryOptions,
  budget: Budget,
): Promise<{
  readonly movements: ReadonlyArray<Movement>;
  readonly selfTransfers: number;
  readonly sentProof: SentProof;
}> {
  const span = options.to - options.from + 1n;
  if (span > BigInt(options.maxHydratedBlocks)) {
    throw new ChainReadError(
      `blocks ${options.from}–${options.to} is ${span} blocks and native value can only be read by hydrating each one, which is over maxHydratedBlocks (${options.maxHydratedBlocks}). Sync a narrower range, raise maxHydratedBlocks, or drop "native" and "fees" from include — but then the rows are logged token transfers only, and a native payment will be missing from them.`,
    );
  }

  const movements: Movement[] = [];
  let selfTransfers = 0;
  /** Every transaction the blocks showed this address SENDING, row or no row. */
  let sent = 0;

  for (let number = options.from; number <= options.to; number += 1n) {
    spend(budget, `hydrating block ${number}`);
    const raw = await callOrThrow(
      client,
      "eth_getBlockByNumber",
      [toHexQuantity(number), true],
      `hydrating block ${number}`,
    );
    if (raw === null || raw === undefined) {
      throw new ChainReadError(
        `block ${number} is inside the pinned sync range ${options.from}–${options.to} but this endpoint says it does not exist — the range is wrong, or this endpoint is not serving the whole chain`,
      );
    }
    budget.hydratedBlocks += 1;
    const block = requireObject(raw, `block ${number}`);
    requireBlockNumber(block, number);
    const blockHash = stringField(block, "hash", `block ${number}`);
    rememberBlockHash(budget, number.toString(), blockHash.toLowerCase(), "a hydrated block");
    budget.timestamps.set(
      number.toString(),
      hexToBigint(field(block, "timestamp"), `block ${number} timestamp`),
    );

    const entries = field(block, "transactions");
    if (!Array.isArray(entries)) {
      throw new ChainReadError(
        `block ${number} came back with no transactions array, so whether this address moved native value in it cannot be read`,
      );
    }
    for (let position = 0; position < entries.length; position++) {
      const entry = entries[position];
      if (typeof entry === "string") {
        // The endpoint ignored `fullTransactions: true` and answered with
        // hashes. Filtering an array of hashes on `from` matches nothing, and
        // nothing about that empty result looks different from a block this
        // address was not in — a prefix of the history that reads as complete.
        throw new ChainReadError(
          `block ${number} came back as a list of transaction hashes although it was asked for full transactions, so its native transfers cannot be read. This endpoint ignores the fullTransactions flag: use one that honours it, or drop "native" and "fees" from include and accept a token-only statement.`,
        );
      }
      const tx = projectTransaction(requireObject(entry, `a transaction in block ${number}`));
      const isSender = tx.from === options.address;
      const isRecipient = tx.to === options.address;
      // Counted before anything can skip it: the proof below is about what the
      // BLOCKS held, not about what became a row. A zero-value send still
      // raised the nonce, and leaving it out here would turn the proof into a
      // second statement of the row rules.
      if (isSender) sent += 1;
      if (!isSender && !isRecipient) continue;

      // The receipt is read for the REVERT STATUS as much as for the fee: a
      // reverted transaction's value transfer is discarded with the rest of its
      // state changes, so crediting `tx.value` without reading the status books
      // money that was returned. It is skipped only when neither row could come
      // out of it — a zero-value transaction this address did not send.
      const needsReceipt =
        (options.includeNative && BigInt(tx.value) > 0n) || (options.includeFees && isSender);
      if (!needsReceipt) continue;

      spend(budget, `reading the receipt for ${tx.hash}`);
      const receiptRaw = await callOrThrow(
        client,
        "eth_getTransactionReceipt",
        [tx.hash],
        `reading the receipt for ${tx.hash}`,
      );
      if (receiptRaw === null || receiptRaw === undefined) {
        throw new ChainReadError(
          `transaction ${tx.hash} is in block ${number} but this endpoint has no receipt for it, so whether it reverted cannot be read — and a reverted transaction moved nothing. Refusing rather than booking a movement that may not have happened.`,
        );
      }
      budget.receiptsRead += 1;
      const receiptObject = requireObject(receiptRaw, `the receipt for ${tx.hash}`);
      const receipt = projectReceipt(receiptObject, projectLog);
      const reverted = receipt.status === "reverted";

      if (options.includeNative && BigInt(tx.value) > 0n && !reverted) {
        if (isSender && isRecipient) {
          selfTransfers += 1;
        } else {
          movements.push({
            id: `${tx.hash}:native`,
            kind: "native",
            standard: "native",
            asset: "native",
            tokenId: null,
            // A contract creation has no `to`. The value went to the contract
            // the receipt names, and "an unnamed party" for it would be a row
            // nobody can trace.
            counterparty: isSender ? (tx.to ?? receipt.contractAddress) : tx.from,
            raw: BigInt(tx.value),
            direction: isSender ? "debit" : "credit",
            txHash: tx.hash,
            blockNumber: number,
            blockHash: blockHash.toLowerCase(),
            ordinal: ordinalOf(receipt, position),
            status: receipt.status,
          });
        }
      }

      // One fee row per transaction SENT, keyed on the transaction. The wallet
      // can appear in a dozen logs of one swap; a fee attributed per log
      // charges the gas a dozen times and the reconciliation is off by exactly
      // that. Fees never come from the log path, so it cannot happen here.
      if (options.includeFees && isSender) {
        const fees = feeBreakdown(receiptObject, receipt);
        if (fees.totalFeeWei !== null && BigInt(fees.totalFeeWei) > 0n) {
          movements.push({
            id: `${tx.hash}:fee`,
            kind: "fee",
            standard: "fee",
            asset: "native",
            tokenId: null,
            counterparty: null,
            raw: BigInt(fees.totalFeeWei),
            direction: "debit",
            txHash: tx.hash,
            blockNumber: number,
            blockHash: blockHash.toLowerCase(),
            ordinal: ordinalOf(receipt, position),
            status: receipt.status,
            feeModel: fees.model,
          });
        }
      }
    }
  }

  return { movements, selfTransfers, sentProof: await proveSent(client, options, budget, sent) };
}

/**
 * Check the blocks against the account's own nonce, and refuse when they are
 * short.
 *
 * Two reads, whatever the range. A nonce rises by one per transaction sent, so
 * its rise across the range is exactly how many this address must appear as the
 * sender of — and a hydrated block that came back short is otherwise invisible,
 * because there is no second way to ask for it.
 *
 * MORE transactions than the nonce accounts for is not a refusal: OP-stack
 * deposits and other system transactions appear in blocks without raising an
 * ordinary nonce, and refusing there would make this unusable on the chains it
 * is most often pointed at. Nothing is missing in that direction, and the
 * count is reported rather than swallowed.
 */
async function proveSent(
  client: RpcClient,
  options: HistoryOptions,
  budget: Budget,
  sent: number,
): Promise<SentProof> {
  const at = await nonceAt(client, budget, options.address, options.to);
  // Block zero has no predecessor to read, and an account's nonce before the
  // chain existed is zero for every account.
  const before =
    options.from === 0n
      ? { ok: true as const, value: 0n }
      : await nonceAt(client, budget, options.address, options.from - 1n);

  if (!at.ok || !before.ok) {
    const why = !at.ok ? at.why : !before.ok ? before.why : "";
    return {
      outcome: "unproved",
      sent,
      why: `this endpoint would not serve this account's nonce at a block in the range (${why}), so whether its blocks held every transaction this address sent could not be checked. A pruned endpoint answers historical state this way; an archive one does not.`,
    };
  }

  const expected = at.value - before.value;
  if (expected < 0n) {
    return {
      outcome: "unproved",
      sent,
      why: `this endpoint says the account's nonce FELL from ${before.value} to ${at.value} across blocks ${options.from}–${options.to}, which no chain does — the two reads are not from one history, so neither is evidence about these blocks`,
    };
  }
  if (BigInt(sent) < expected) {
    throw new ChainReadError(
      `this endpoint's blocks showed ${sent} transaction(s) sent by ${options.address} over blocks ${options.from}–${options.to}, but its own nonce for that account rose by ${expected} across the same range — at least ${expected - BigInt(sent)} transaction it sent is missing from the blocks it served, and each one is a fee and possibly a payment. Refusing rather than returning a statement that is short by an unknown amount: sync a narrower range, or use an endpoint that serves whole blocks.`,
    );
  }
  if (BigInt(sent) > expected) {
    return {
      outcome: "moreThanTheNonce",
      sent,
      nonceAccountsFor: Number(expected),
      why: "the blocks held more transactions from this address than its nonce rose by, which is what a system or deposit transaction looks like on a rollup. Nothing is missing; the extra ones are in the rows",
    };
  }
  return { outcome: "proved", sent };
}

type NonceRead =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly why: string };

/**
 * One historical nonce, or the reason there is none.
 *
 * Returned rather than thrown: a pruned endpoint refusing state from before its
 * window is a fact about the endpoint, not a reason to throw away a sync that
 * is otherwise fine. The caller decides what an unreadable answer means.
 */
async function nonceAt(
  client: RpcClient,
  budget: Budget,
  address: string,
  block: bigint,
): Promise<NonceRead> {
  spend(budget, `reading this account's nonce at block ${block}`);
  const outcome = await client.call("eth_getTransactionCount", [address, toHexQuantity(block)]);
  if (!outcome.ok) return { ok: false, why: `at block ${block}: ${outcome.message}` };
  try {
    return { ok: true, value: hexToBigint(outcome.result, `the nonce at block ${block}`) };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// movements become rows, or become parked
// ---------------------------------------------------------------------------

async function toRows(
  movements: ReadonlyArray<Movement>,
  options: HistoryOptions,
  budget: Budget,
): Promise<{
  readonly rows: ReadonlyArray<Transaction>;
  readonly detail: ReadonlyArray<RowDetail>;
  readonly parked: ReadonlyArray<ParkedRow>;
}> {
  const ordered = [...movements].sort(byBlockThenKindThenOrdinal);
  const rows: Transaction[] = [];
  const detail: RowDetail[] = [];
  const parked: ParkedRow[] = [];

  for (const movement of ordered) {
    const timestamp = await timestampOf(budget, movement.blockNumber);
    const iso = unixToIso(timestamp);
    const date = calendarDate(iso);
    if (iso === null || date === null) {
      parked.push({
        id: movement.id,
        reason: "timestampOutOfRange",
        why: `block ${movement.blockNumber} is stamped ${timestamp}, which is past what a calendar date can express — the row has no date to carry`,
        asset: movement.asset,
        rawAmount: movement.raw.toString(),
        txHash: movement.txHash,
        blockNumber: movement.blockNumber.toString(),
      });
      continue;
    }

    const units = unitsFor(movement, options);
    const scaled = toMinorUnits(movement.raw, units);
    if (!scaled.ok) {
      parked.push({
        id: movement.id,
        reason: scaled.reason,
        why: scaled.why,
        asset: movement.asset,
        rawAmount: movement.raw.toString(),
        txHash: movement.txHash,
        blockNumber: movement.blockNumber.toString(),
      });
      continue;
    }

    rows.push({
      id: movement.id,
      // A calendar date in UTC, because a block timestamp is UTC and nothing on
      // the chain knows the ledger's timezone. A movement just before midnight
      // local time lands on the chain's day, not the bookkeeper's.
      date,
      description: describe(movement, units),
      // Negative for money leaving the account, which is the convention the row
      // shape documents and every consumer of it relies on. Zero is written as
      // zero rather than `-0`, which some consumers print and none of them mean.
      amountMinor:
        scaled.value === 0 ? 0 : movement.direction === "debit" ? -scaled.value : scaled.value,
      direction: movement.direction,
      reference: movement.txHash,
      // No running balance. It would need an opening balance per asset that
      // nothing here has, and a computed one would be a number a reconciliation
      // trusts and should not.
      balanceMinor: null,
    });
    detail.push({
      id: movement.id,
      kind: movement.kind,
      standard: movement.standard,
      asset: movement.asset,
      symbol: units.symbol,
      assetDecimals: units.decimals,
      minorUnitDecimals: units.minorUnitDecimals ?? units.decimals,
      rawAmount: movement.raw.toString(),
      tokenId: movement.tokenId,
      counterparty: movement.counterparty,
      txHash: movement.txHash,
      blockNumber: movement.blockNumber.toString(),
      blockHash: movement.blockHash,
      timestamp: timestamp.toString(),
      timestampIso: iso,
      status: movement.status,
      ...(movement.feeModel === undefined ? {} : { feeModel: movement.feeModel }),
    });
  }

  return { rows, detail, parked };
}

type Scaled =
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false;
      readonly reason: "belowMinorUnit" | "exceedsSafeInteger";
      readonly why: string;
    };

/**
 * A base-unit amount as the ledger's minor units, exactly or not at all.
 *
 * Both failures are real and neither is rounding's business. Wei is eighteen
 * decimals and `Number.MAX_SAFE_INTEGER` is about nine thousandths of one ETH,
 * so a plain ETH payment does not fit in this field at all until the caller
 * says what unit the ledger keeps ETH in — and 0.5 USDC does not fit a
 * cent-denominated ledger however it is asked.
 */
export function toMinorUnits(raw: bigint, units: AssetUnits): Scaled {
  const drop =
    units.decimals === null || units.minorUnitDecimals === null
      ? 0
      : units.decimals - units.minorUnitDecimals;
  if (drop < 0) {
    throw new ChainReadError(
      `minorUnitDecimals (${units.minorUnitDecimals}) is finer than the asset's own decimals (${units.decimals}) — there are no digits there to scale up into`,
    );
  }
  const divisor = 10n ** BigInt(drop);
  const remainder = raw % divisor;
  if (remainder !== 0n) {
    return {
      ok: false,
      reason: "belowMinorUnit",
      why: `${raw} base units is ${remainder} short of a whole minor unit at ${drop} decimal places — rounding it would put a number in the ledger that the chain does not contain`,
    };
  }
  const quotient = raw / divisor;
  if (quotient > MAX_SAFE) {
    return {
      ok: false,
      reason: "exceedsSafeInteger",
      why: `${quotient} minor units is past Number.MAX_SAFE_INTEGER (${MAX_SAFE}), and the row's amountMinor is a JS number — name this asset's decimals and the ledger's minorUnitDecimals so it scales into range, rather than taking a value that has already lost its low digits`,
    };
  }
  return { ok: true, value: Number(quotient) };
}

/**
 * Which units a movement is measured in.
 *
 * An ERC-721 is counted in whole tokens and has no decimals to scale by — a
 * declared `decimals` for that contract would be about something else, and
 * dividing a count of one by it produces either dust or a zero.
 */
function unitsFor(movement: Movement, options: HistoryOptions): AssetUnits {
  if (movement.asset === "native") return options.nativeUnits;
  const declared = options.tokenUnits.get(movement.asset);
  if (movement.standard === "erc721") {
    return { decimals: null, minorUnitDecimals: null, symbol: declared?.symbol ?? null };
  }
  return declared ?? UNKNOWN_UNITS;
}

/**
 * The `YYYY-MM-DD` the row shape wants, or `null` when the instant cannot be
 * written that way.
 *
 * `Date.prototype.toISOString` switches to the EXPANDED year format outside
 * 0000–9999 — a block stamped in the year 33658 serialises as
 * `+033658-…`, and slicing ten characters off that gives `+033658-0`, which is
 * not a date and which `LedgerReconcile`'s schema rejects at the far end of the
 * pipeline rather than here. So the slice is validated, not assumed.
 */
export function calendarDate(iso: string | null): string | null {
  if (iso === null) return null;
  const date = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function describe(movement: Movement, units: AssetUnits): string {
  const asset = units.symbol ?? (movement.asset === "native" ? "native value" : movement.asset);
  if (movement.kind === "fee") {
    return `gas fee for ${movement.txHash}${movement.status === "reverted" ? " (the transaction reverted; the fee was still charged)" : ""}`;
  }
  // A pre-Byzantium receipt does not record whether the call reverted, and this
  // row counts the value as having moved. That is a convention, not a reading,
  // and it travels with the row because the row is what a bookkeeper sees.
  const caveat =
    movement.status === "unknown"
      ? " (this receipt records no status, so whether the call reverted is not known and the value is counted as moved)"
      : "";
  const way = movement.direction === "debit" ? "to" : "from";
  const other = movement.counterparty ?? "an unnamed party";
  if (movement.standard === "erc721") {
    return `ERC-721 ${asset} #${movement.tokenId ?? "?"} ${way} ${other}${caveat}`;
  }
  if (movement.kind === "native") return `${asset} transfer ${way} ${other}${caveat}`;
  return `ERC-20 ${asset} transfer ${way} ${other}${caveat}`;
}

/**
 * A total order that does not depend on anything a provider chose.
 *
 * Block number, then kind, then the movement's own index — the log's own
 * `logIndex` and the receipt's own `transactionIndex`, both assigned by the
 * chain — then the id as the final tiebreak, so two runs against the same range
 * produce byte-identical rows. Sorting on the order logs or transactions
 * happened to ARRIVE in would be sorting on the endpoint's mood.
 */
function byBlockThenKindThenOrdinal(a: Movement, b: Movement): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  const rank = (m: Movement): number => (m.kind === "native" ? 0 : m.kind === "token" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// the shared bookkeeping both sources write into
// ---------------------------------------------------------------------------

/**
 * A block's timestamp, read once.
 *
 * The hydrated path already has it. The log path does not, and a row needs a
 * date — so one header per distinct block that produced a row, cached, and a
 * block that has vanished between the scan and this read is a refusal rather
 * than a row dated from somewhere else.
 */
async function timestampOf(budget: Budget, number: bigint): Promise<bigint> {
  const key = number.toString();
  const known = budget.timestamps.get(key);
  if (known !== undefined) return known;
  spend(budget, `reading the header of block ${number}`);
  const raw = await callOrThrow(
    budget.client,
    "eth_getBlockByNumber",
    [toHexQuantity(number), false],
    `reading the header of block ${number}`,
  );
  if (raw === null || raw === undefined) {
    throw new ChainReadError(
      `block ${number} produced a row but this endpoint now says it has no such block — the chain moved under the sync, so the rows would mix two histories`,
    );
  }
  const block = requireObject(raw, `block ${number}`);
  requireBlockNumber(block, number);
  rememberBlockHash(
    budget,
    key,
    stringField(block, "hash", `block ${number}`).toLowerCase(),
    "a block header",
  );
  const timestamp = hexToBigint(field(block, "timestamp"), `block ${number} timestamp`);
  budget.timestamps.set(key, timestamp);
  return timestamp;
}

/**
 * One height, one hash — across the log scan, the hydrated blocks and the
 * header reads alike.
 *
 * Each source sees the chain at a different moment, so this is where a reorg
 * mid-sync becomes visible: a statement assembled from two histories reconciles
 * against neither.
 */
function rememberBlockHash(budget: Budget, number: string, hash: string, source: string): void {
  const known = budget.blockHashes.get(number);
  if (known === undefined) {
    budget.blockHashes.set(number, hash);
    return;
  }
  if (known !== hash) {
    throw new ChainReadError(
      `block ${number} came back with hash ${hash} from ${source} after an earlier request said ${known} — the chain reorganised while this sync was running, so the rows would mix two histories. Re-run with more confirmations.`,
    );
  }
}

function spend(budget: Budget, what: string): void {
  if (budget.client.calls >= budget.maxCalls) {
    throw new ChainReadError(
      `this sync needed more than maxCalls (${budget.maxCalls}) requests and stopped before ${what} — refusing to return a partial history. Sync a smaller range, or narrow it with tokens.`,
    );
  }
}

/**
 * The body has to be the block that was asked for.
 *
 * Every row's date and every entry in the reorg map is keyed by the number in
 * the REQUEST while its contents come out of the RESPONSE, so an endpoint that
 * answers block 123 with block 456 dates a movement from somewhere else and
 * pins the wrong hash at that height. The log scan already refuses a log from
 * outside the range it asked about; this is the same check on the other source.
 */
function requireBlockNumber(block: Record<string, unknown>, asked: bigint): void {
  const answered = hexToBigint(field(block, "number"), `block ${asked}: its own number`);
  if (answered !== asked) {
    throw new ChainReadError(
      `block ${asked} was asked for and the endpoint answered with block ${answered} — it is not answering the question that was asked, so nothing in that body can be dated or hashed to the block it was requested for`,
    );
  }
}

/**
 * A transaction's place in its block, as the CHAIN numbers it.
 *
 * The receipt carries `transactionIndex`, and it is read rather than the
 * position in the array the endpoint sent: the array's order is the endpoint's
 * to choose, and sorting on it makes the row order a property of which provider
 * answered. The position is the fallback for an endpoint that omits the field,
 * which is the only case where there is nothing better.
 */
function ordinalOf(
  receipt: { readonly transactionIndex: number | null },
  position: number,
): number {
  return receipt.transactionIndex ?? position;
}

function stringField(source: Record<string, unknown>, key: string, what: string): string {
  const value = field(source, key);
  if (typeof value !== "string") {
    throw new ChainReadError(`${what}: expected a string ${key}, got ${JSON.stringify(value)}`);
  }
  return value;
}
