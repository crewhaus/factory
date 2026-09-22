/**
 * @crewhaus/tool-chainread — what the chain actually recorded.
 *
 * Eight read-only questions about an EVM chain, answered over a public
 * JSON-RPC endpoint the caller names. `@crewhaus/tool-onchain` next door does
 * the arithmetic offline; this package is the half that dials.
 *
 * **Nothing here signs or sends.** No schema accepts a private key, a mnemonic
 * or a signed payload, and no code path can reach `eth_sendRawTransaction`:
 * every method name goes through `assertReadOnlyMethod` from
 * `@crewhaus/chain-adapter-base` before a socket opens, so the guarantee is
 * structural rather than a promise about the call sites. `index.test.ts`
 * asserts both halves.
 *
 * The recurring theme is what these tools refuse to say:
 *
 *   - `EvmWaitForReceipt` distinguishes mined-and-succeeded, mined-and-REVERTED
 *     and still-pending-at-the-deadline. A reverted transaction has a receipt,
 *     with `status: 0x0`; reporting "no receipt" for it is a lie a caller acts
 *     on by broadcasting again.
 *   - `EvmEventScan` refuses rather than returning a log set it cannot prove is
 *     complete. A missing log is an event that did not happen, as far as
 *     everything downstream is concerned.
 *   - `EvmBlockAtTimestamp` returns the last block at or before the timestamp
 *     and the block after it, so the invariant can be checked from the answer;
 *     a timestamp before genesis is a refusal, not block zero.
 *   - `EvmRpcHealth` reports what it could not determine as unknown. An
 *     endpoint that might or might not serve archive state is not an endpoint
 *     that does not.
 *   - `EvmTransactionSummary` says in its output which movements it cannot see.
 *   - `OnchainTransactionsSync` hands back `@crewhaus/tool-money`'s
 *     `Transaction` — the row shape a statement parses into — rather than a
 *     second one of its own, and PARKS a movement it cannot write as a row
 *     instead of rounding one to fit.
 *
 * Every chain quantity — wei, token amounts, nonces, block numbers — crosses
 * this boundary as a decimal STRING. A uint256 does not fit in a double. The
 * one place a `number` is unavoidable is the statement row's `amountMinor`,
 * which is not this package's field, and that is exactly where the parking is.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type BlockSelector,
  type BlockSummary,
  fetchBlock,
  headNumber,
  searchBlockAtTimestamp,
} from "./lib/blocks";
import { nowMs, sleep } from "./lib/clock";
import { getRpcEndpointPolicy } from "./lib/endpoint";
import { type AssetUnits, type SentProof, UNKNOWN_UNITS, collectHistory } from "./lib/history";
import { type LogFilter, projectLog, scanLogs } from "./lib/logs";
import {
  type BlockTag,
  ChainReadError,
  hexToBigint,
  isAddress,
  isBlockTag,
  isHash32,
  json,
  lowerHex,
  requireObject,
  toBigint,
  toHexQuantity,
  unixToIso,
} from "./lib/quantity";
import { type RpcClient, callOrThrow, openRpc } from "./lib/rpc";
import {
  type ApprovalEvent,
  type TokenMovement,
  decodeApproval,
  decodeTransfer,
  feeBreakdown,
  projectReceipt,
  projectTransaction,
} from "./lib/transfers";

export { _setFetch, type RpcFetch, type RpcOutcome, openRpc } from "./lib/rpc";
export { _setClock, type Clock, virtualClock } from "./lib/clock";
export {
  _setDnsLookup,
  type DnsLookupFn,
  type RpcEndpointPolicy,
  RpcEndpointError,
  getRpcEndpointPolicy,
  setRpcEndpointPolicy,
} from "./lib/endpoint";
export { ChainReadError } from "./lib/quantity";
export { parseSuggestedSpan, shouldNarrow, type RawLog } from "./lib/logs";
export {
  type AssetUnits,
  type HistoryReport,
  type ParkedRow,
  type RowDetail,
  type SentProof,
  collectHistory,
  toMinorUnits,
} from "./lib/history";
export {
  TRANSFER_TOPIC,
  APPROVAL_TOPIC,
  APPROVAL_FOR_ALL_TOPIC,
  TRANSFER_SINGLE_TOPIC,
  TOPIC_SIGNATURES,
  addressToTopic,
  decodeApproval,
  decodeTransfer,
  feeBreakdown,
  topicToAddress,
} from "./lib/transfers";

/** Ceilings that exist so one call cannot become a crawl of somebody's endpoint. */
const LIMITS = {
  compareEndpoints: 7,
  broadcastHashes: 32,
  addresses: 32,
  topicPositions: 4,
  topicAlternatives: 64,
  scanCalls: 512,
  defaultMaxLogs: 5_000,
  hardMaxLogs: 100_000,
  defaultSpan: 2_000n,
  searchProbes: 64,
  /** Assets a caller may declare units for in one sync. */
  assets: 64,
  /** Native value costs one request per block, so the range a sync will hydrate is bounded. */
  defaultHydratedBlocks: 256,
  hardHydratedBlocks: 10_000,
  defaultRows: 5_000,
  hardRows: 50_000,
  syncCalls: 4_096,
} as const;

const rpcUrlField = z
  .string()
  .min(8)
  .describe("the JSON-RPC endpoint to read from, e.g. https://mainnet.base.org");

const timeoutField = z
  .number()
  .int()
  .min(1_000)
  .max(120_000)
  .optional()
  .describe("per-request timeout in milliseconds; default 20000");

const blockField = z
  .union([z.string().min(1), z.number().int().nonnegative()])
  .describe('a block number, or one of "latest", "earliest", "safe", "finalized", "pending"');

const addressField = z.string().length(42).describe("a 0x-prefixed 20-byte address");

const hashField = z.string().length(66).describe("a 0x-prefixed 32-byte hash");

async function client(
  input: { readonly rpcUrl: string; readonly timeoutMs?: number },
  ctx: ToolExecuteContext | undefined,
): Promise<RpcClient> {
  return openRpc(input.rpcUrl, {
    ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
}

/**
 * Work out what a caller meant by a block.
 *
 * A tag, a 32-byte hash and a hex number all arrive as strings, and the hash is
 * distinguished by LENGTH — 66 characters including the prefix. Guessing wrong
 * sends `eth_getBlockByNumber` a hash, which most nodes answer with `null`:
 * "no such block" for a block that exists.
 */
export function parseBlockInput(value: string | number, what: string): BlockSelector {
  if (typeof value === "number") return { kind: "number", value: toBigint(value, what) };
  const text = value.trim();
  if (isBlockTag(text)) return { kind: "tag", tag: text as BlockTag };
  if (isHash32(text)) return { kind: "hash", hash: text.toLowerCase() };
  if (/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) return { kind: "number", value: toBigint(text, what) };
  throw new ChainReadError(
    `${what}: "${value}" is not a block number, a 32-byte block hash, or one of latest/earliest/safe/finalized/pending`,
  );
}

function requireAddress(value: string, what: string): string {
  if (!isAddress(value)) {
    throw new ChainReadError(`${what}: "${value}" is not a 20-byte 0x address`);
  }
  return value.toLowerCase();
}

function requireHash(value: string, what: string): string {
  if (!isHash32(value)) {
    throw new ChainReadError(`${what}: "${value}" is not a 32-byte 0x hash`);
  }
  return value.toLowerCase();
}

/** Resolve a block input to a concrete number, because a scan over a moving target is not reproducible. */
async function resolveBlockNumber(
  rpc: RpcClient,
  value: string | number,
  what: string,
): Promise<bigint> {
  const selector = parseBlockInput(value, what);
  if (selector.kind === "number") return selector.value;
  if (selector.kind === "tag" && selector.tag === "latest") return headNumber(rpc);
  if (selector.kind === "tag" && selector.tag === "earliest") return 0n;
  const block = await fetchBlock(rpc, selector);
  if (block === null || block.number === null) {
    throw new ChainReadError(
      `${what}: this endpoint has no numbered block for ${
        selector.kind === "tag" ? `"${selector.tag}"` : selector.hash
      }${
        selector.kind === "tag"
          ? ' — "pending" has no number until it is sealed, and "safe" and "finalized" are post-Merge tags that not every chain or endpoint serves'
          : ""
      }`,
    );
  }
  return BigInt(block.number);
}

// ---------------------------------------------------------------------------

export const evmGetBlock: RegisteredTool = buildTool({
  name: "EvmGetBlock",
  description:
    "Read one block's header from a JSON-RPC endpoint — number, hash, parent, timestamp (unix and ISO), gas limit and usage, base fee and transaction count — by number, by tag, or by block hash. Use it to anchor anything that needs a block: a historical read, a confirmation count, or the time a range covers. It picks getBlockByHash or getBlockByNumber from the shape of what you pass, reports a chain with no base fee as legacy rather than putting a null into your fee arithmetic, and answers a block that does not exist with found:false rather than an error, because that is a fact about the chain and not a failure.",
  inputSchema: z
    .object({
      rpcUrl: rpcUrlField,
      block: blockField.optional().describe('default "latest"'),
      includeTransactions: z
        .boolean()
        .optional()
        .describe("include the transaction hashes in the block; default false"),
      timeoutMs: timeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const rpc = await client(input, ctx);
    const selector = parseBlockInput(input.block ?? "latest", "block");
    const block = await fetchBlock(rpc, selector);
    if (block === null) {
      return json({
        found: false,
        requested: input.block ?? "latest",
        resolvedBy: selector.kind,
        note: "this endpoint has no such block — it may be ahead of the head, or the endpoint may not serve this part of the chain",
        calls: rpc.calls,
      });
    }
    return json({
      found: true,
      resolvedBy: selector.kind,
      block: {
        ...block,
        ...(input.includeTransactions === true ? {} : { transactions: undefined }),
      },
      ...(block.pending
        ? {
            note: "this is the pending block: it has no number and no hash yet, and its contents change until it is sealed",
          }
        : {}),
      calls: rpc.calls,
    });
  },
});

export const evmBlockAtTimestamp: RegisteredTool = buildTool({
  name: "EvmBlockAtTimestamp",
  description:
    "Find the block a chain was at, at a given moment: the LAST block whose timestamp is at or before the one you name, together with the block after it so the answer can be checked. Use it to pin a historical read — an end-of-quarter balance, the state before an incident — to a block number, instead of guessing from an average block time. A timestamp before the chain's first block is refused rather than answered with block zero, a timestamp at or past the head returns the head and says so, and a chain whose block timestamps run backwards is refused rather than searched, because a binary search there has no single right answer.",
  inputSchema: z
    .object({
      rpcUrl: rpcUrlField,
      timestamp: z
        .union([z.string().min(1), z.number().int()])
        .describe("unix SECONDS, or an ISO-8601 instant like 2026-03-01T00:00:00Z"),
      fromBlock: blockField.optional().describe("lower bound for the search; default 0"),
      toBlock: blockField.optional().describe("upper bound; default the current head"),
      timeoutMs: timeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const rpc = await client(input, ctx);
    const target = parseTimestamp(input.timestamp);
    const low =
      input.fromBlock === undefined
        ? 0n
        : await resolveBlockNumber(rpc, input.fromBlock, "fromBlock");
    const high =
      input.toBlock === undefined
        ? await headNumber(rpc)
        : await resolveBlockNumber(rpc, input.toBlock, "toBlock");

    const search = await searchBlockAtTimestamp(rpc, target, { low, high }, LIMITS.searchProbes);
    if (search.outcome === "beforeRange") {
      throw new ChainReadError(
        `nothing was recorded at or before ${target} (${unixToIso(target) ?? "out of range"}): the earliest block in the search range, block ${search.first.number}, is already stamped ${search.first.timestamp} (${search.first.timestampIso}). ${
          input.fromBlock === undefined
            ? "That timestamp predates this chain."
            : "Widen fromBlock if the chain is older than the bound you gave."
        }`,
      );
    }

    return json({
      invariant:
        "block is the last block whose timestamp is <= target; next is the first block after it, and its timestamp is > target",
      target: { unix: target.toString(), iso: unixToIso(target) },
      block: search.at,
      next: search.next,
      atHead: search.atHead,
      // The two numbers that make the invariant checkable without another call.
      certificate: {
        blockTimestamp: search.at.timestamp,
        targetTimestamp: target.toString(),
        nextBlockTimestamp: search.next?.timestamp ?? null,
      },
      ...(search.atHead
        ? {
            note: "the target is at or past the chain head, so this answer will change as the chain advances — there is no block after it yet",
          }
        : {}),
      searchedBlocks: { low: low.toString(), high: high.toString() },
      probes: search.probes,
      calls: rpc.calls,
    });
  },
});

/**
 * Seconds, or an ISO instant, but never milliseconds.
 *
 * `Date.now()` pasted into a tool that wants seconds is a timestamp in the year
 * 55000, which every search resolves to "at or past the head" and answers with
 * the head block — a wrong answer that looks completely ordinary. So the
 * thousand-fold mistake is refused by name.
 */
export function parseTimestamp(value: string | number): bigint {
  if (typeof value === "string" && !/^-?\d+$/.test(value.trim())) {
    const ms = Date.parse(value.trim());
    if (Number.isNaN(ms)) {
      throw new ChainReadError(
        `timestamp: "${value}" is neither unix seconds nor an ISO-8601 instant`,
      );
    }
    return BigInt(Math.floor(ms / 1000));
  }
  const seconds = toBigint(typeof value === "number" ? value : value.trim(), "timestamp");
  if (seconds > 100_000_000_000n) {
    throw new ChainReadError(
      `timestamp: ${seconds} is far past any plausible block time — this looks like milliseconds. Block timestamps are unix SECONDS; divide by 1000.`,
    );
  }
  return seconds;
}

export const evmRpcHealth: RegisteredTool = buildTool({
  name: "EvmRpcHealth",
  description:
    "Probe a JSON-RPC endpoint and report what it is and what it can serve: chain id, head block and how old that head is, and whether it keeps archive state. Use it before trusting a chain read, and to compare several endpoints against each other — two endpoints reporting different chain ids is a misconfiguration that would otherwise show up as impossible data. Archive support is decided by reading a historic balance and interpreting the failure, and when the evidence does not settle it — a chain too short to tell, an error that means something else — it reports unknown rather than false, because 'we could not tell' and 'it does not' lead to different decisions.",
  inputSchema: z
    .object({
      rpcUrl: rpcUrlField,
      compareWith: z
        .array(z.string().min(8))
        .max(LIMITS.compareEndpoints)
        .optional()
        .describe("other endpoints to probe and compare heads and chain ids against"),
      archiveProbeBlock: blockField
        .optional()
        .describe("the historic block to probe for archive state; default head - 200000"),
      staleAfterSeconds: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("head age past which the endpoint is reported stalled; default 900"),
      timeoutMs: timeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const staleAfter = BigInt(input.staleAfterSeconds ?? 900);
    const urls = [input.rpcUrl, ...(input.compareWith ?? [])];
    const probes = await Promise.all(
      urls.map((url) =>
        probeEndpoint(url, ctx, input.timeoutMs, input.archiveProbeBlock, staleAfter),
      ),
    );

    const reachable = probes.filter((p) => p.reachable);
    const chainIds = [...new Set(reachable.map((p) => p.chainId).filter((c) => c !== null))];
    const heads = reachable
      .map((p) => (p.headBlock === null ? null : BigInt(p.headBlock)))
      .filter((h): h is bigint => h !== null);
    const bestHead = heads.length === 0 ? null : heads.reduce((a, b) => (a > b ? a : b));

    return json({
      endpoints: probes.map((p) => ({
        ...p,
        lagBlocks:
          bestHead === null || p.headBlock === null
            ? null
            : (bestHead - BigInt(p.headBlock)).toString(),
      })),
      comparison:
        urls.length === 1
          ? null
          : {
              chainIdsAgree: chainIds.length <= 1,
              chainIds,
              ...(chainIds.length > 1
                ? {
                    conflict:
                      "these endpoints are not on the same chain — reading from both produces data that cannot be reconciled",
                  }
                : {}),
              bestHead: bestHead?.toString() ?? null,
            },
      // The verdict is made from facts that are stable between two calls. A
      // single latency sample behind a load balancer is not one, which is why
      // no timing is measured here at all.
      verdictRules: {
        stalledIf: `headAgeSeconds > ${staleAfter}`,
        unreachableIf: "the chainId or head probe failed",
        archiveUnknownIf:
          "the probe block is within 128 blocks of the head, or the error was not a pruning error",
      },
      policy: describePolicy(),
    });
  },
});

type EndpointProbe = {
  readonly origin: string;
  readonly reachable: boolean;
  readonly chainId: string | null;
  readonly headBlock: string | null;
  readonly headTimestamp: string | null;
  readonly headAgeSeconds: string | null;
  readonly clockSkewSuspected: boolean;
  readonly stalled: boolean | null;
  readonly archiveState: "yes" | "no" | "unknown";
  readonly archiveEvidence: string;
  readonly errors: ReadonlyArray<string>;
};

/** Phrases every major client uses when the state for a block has been pruned away. */
const PRUNED_STATE = [
  "missing trie node",
  "state is not available",
  "state not available",
  "state unavailable",
  "missing state",
  "pruned",
  "header not found",
  "not found: state",
  "distance to target block exceeds",
  "archive",
];

async function probeEndpoint(
  url: string,
  ctx: ToolExecuteContext | undefined,
  timeoutMs: number | undefined,
  archiveProbeBlock: string | number | undefined,
  staleAfter: bigint,
): Promise<EndpointProbe> {
  const errors: string[] = [];
  let rpc: RpcClient;
  try {
    rpc = await openRpc(url, {
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (err) {
    return {
      origin: safeOrigin(url),
      reachable: false,
      chainId: null,
      headBlock: null,
      headTimestamp: null,
      headAgeSeconds: null,
      clockSkewSuspected: false,
      stalled: null,
      archiveState: "unknown",
      archiveEvidence: "the endpoint was never dialled",
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }

  let chainId: string | null = null;
  const idOutcome = await rpc.call("eth_chainId", []);
  if (idOutcome.ok) {
    try {
      chainId = hexToBigint(idOutcome.result, "eth_chainId").toString();
    } catch (err) {
      // A 200, a well-formed envelope, and a chain id that is not a quantity.
      // That is this endpoint being sick, which is the fact this tool exists to
      // report — and every probe runs inside one Promise.all, so throwing here
      // lost the report for the healthy endpoints too. The sicker the endpoint,
      // the less the health check could say about anything.
      errors.push(err instanceof Error ? err.message : String(err));
    }
  } else {
    errors.push(`eth_chainId: ${idOutcome.message}`);
  }
  if (chainId === null) {
    // Clients older than the eth_chainId RPC still answer net_version, and it
    // is the same number in decimal. Worth one extra call before giving up.
    const legacy = await rpc.call("net_version", []);
    if (legacy.ok && typeof legacy.result === "string" && /^\d+$/.test(legacy.result)) {
      chainId = legacy.result;
    }
  }

  let head: BlockSummary | null = null;
  try {
    head = await fetchBlock(rpc, { kind: "tag", tag: "latest" });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const headNumberValue = head?.number === null || head === null ? null : BigInt(head.number);
  const headTs = head === null ? null : BigInt(head.timestamp);
  const ageSeconds = headTs === null ? null : BigInt(Math.floor(nowMs() / 1000)) - headTs;

  const archive =
    headNumberValue === null
      ? {
          state: "unknown" as const,
          evidence: "the head is unknown, so there is no block to probe",
        }
      : await probeArchive(rpc, headNumberValue, archiveProbeBlock);

  return {
    origin: rpc.origin,
    reachable: chainId !== null && headNumberValue !== null,
    chainId,
    headBlock: headNumberValue?.toString() ?? null,
    headTimestamp: headTs?.toString() ?? null,
    headAgeSeconds: ageSeconds?.toString() ?? null,
    // A head stamped in the future is this machine's clock disagreeing with the
    // chain's, not a fast chain. Reporting a negative age as "fresh" would hide
    // a skew that makes every other age wrong too.
    clockSkewSuspected: ageSeconds !== null && ageSeconds < -5n,
    stalled: ageSeconds === null ? null : ageSeconds > staleAfter,
    archiveState: archive.state,
    archiveEvidence: archive.evidence,
    errors,
  };
}

/**
 * Decide whether the endpoint serves historic state, by asking it for some.
 *
 * The probe block has to be more than 128 blocks behind the head, because a
 * plain full node keeps the most recent 128 blocks of state: a successful read
 * inside that window proves nothing, and a short-lived devnet is entirely
 * inside it. That case reports `unknown`, which is the honest answer — "we
 * could not tell" and "it does not" are different, and only one of them means
 * find another endpoint.
 */
async function probeArchive(
  rpc: RpcClient,
  head: bigint,
  requested: string | number | undefined,
): Promise<{ readonly state: "yes" | "no" | "unknown"; readonly evidence: string }> {
  const probe = probeBlockNumber(head, requested);

  if (head - probe <= 128n) {
    return {
      state: "unknown",
      evidence: `block ${probe} is within 128 blocks of the head (${head}), which every full node keeps — a successful read there would not distinguish an archive node from a pruning one`,
    };
  }

  const outcome = await rpc.call("eth_getBalance", [
    "0x0000000000000000000000000000000000000000",
    toHexQuantity(probe),
  ]);
  if (outcome.ok) {
    return {
      state: "yes",
      evidence: `read a balance at block ${probe} (${head - probe} behind head)`,
    };
  }
  const message = outcome.message.toLowerCase();
  if (outcome.kind === "rpcError" && PRUNED_STATE.some((p) => message.includes(p))) {
    return { state: "no", evidence: `block ${probe}: ${outcome.message}` };
  }
  return {
    state: "unknown",
    evidence: `the probe at block ${probe} failed for a reason that is not about pruning (${outcome.kind}): ${outcome.message}`,
  };
}

/** The block to ask about: the caller's, or 200k behind the head, clamped into the chain. */
function probeBlockNumber(head: bigint, requested: string | number | undefined): bigint {
  if (requested === undefined) return head > 200_000n ? head - 200_000n : 1n;
  const selector = parseBlockInput(requested, "archiveProbeBlock");
  if (selector.kind !== "number") {
    throw new ChainReadError(
      "archiveProbeBlock must be a block NUMBER — a tag would resolve to a block whose state every node still has, which proves nothing about archive support",
    );
  }
  return selector.value > head ? head : selector.value;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(unparseable url)";
  }
}

function describePolicy(): Record<string, unknown> {
  const policy = getRpcEndpointPolicy();
  return {
    allowPrivateHosts: policy.allowPrivateHosts === true,
    allowedOrigins: policy.allowedOrigins ?? null,
  };
}

export const evmNonceStatus: RegisteredTool = buildTool({
  name: "EvmNonceStatus",
  description:
    "Compare an account's latest and pending nonce and say what that means: clear, transactions waiting, a nonce gap, or — when the evidence does not support a verdict — unknown. Use it before sending anything from an account a harness manages, and to find out why a broadcast seems stuck. Pass the transaction hashes you broadcast and it will tell you which are mined, which are still in this endpoint's mempool and which it has never heard of. It degrades loudly: many endpoints do not track a public mempool and answer the pending nonce with the latest one, so a confident 'clear' from those would be wrong, and this reports the endpoint's mempool visibility instead of guessing.",
  inputSchema: z
    .object({
      rpcUrl: rpcUrlField,
      address: addressField,
      broadcast: z
        .array(
          z.object({
            hash: hashField,
            nonce: z
              .union([z.string(), z.number().int().nonnegative()])
              .optional()
              .describe(
                "the nonce you sent it with; lets a dropped tx be told apart from a replaced one",
              ),
          }),
        )
        .max(LIMITS.broadcastHashes)
        .optional()
        .describe("transactions you sent from this account and want the status of"),
      timeoutMs: timeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const rpc = await client(input, ctx);
    const address = requireAddress(input.address, "address");
    const latest = hexToBigint(
      await callOrThrow(
        rpc,
        "eth_getTransactionCount",
        [address, "latest"],
        "reading the latest nonce",
      ),
      "latest nonce",
    );
    const pending = hexToBigint(
      await callOrThrow(
        rpc,
        "eth_getTransactionCount",
        [address, "pending"],
        "reading the pending nonce",
      ),
      "pending nonce",
    );

    const rows = await Promise.all(
      (input.broadcast ?? []).map(async (entry) => {
        const hash = requireHash(entry.hash, "broadcast.hash");
        const raw = await callOrThrow(
          rpc,
          "eth_getTransactionByHash",
          [hash],
          `looking up ${hash}`,
        );
        const declared =
          entry.nonce === undefined ? null : toBigint(entry.nonce, "broadcast.nonce");
        if (raw === null || raw === undefined) {
          // The endpoint has never heard of it. With the nonce it was sent
          // with, that is decidable: if the account has already moved past
          // that nonce, something ELSE used it — a replacement, or a
          // different transaction entirely.
          const state =
            declared === null
              ? "unknownToEndpoint"
              : declared < latest
                ? "replacedOrSuperseded"
                : "notInThisMempool";
          return {
            hash,
            state,
            nonce: declared?.toString() ?? null,
            note:
              state === "replacedOrSuperseded"
                ? `the account's nonce is already ${latest}, so nonce ${declared} was consumed by a different transaction`
                : "this endpoint does not know this hash; it may never have propagated here, or it may have been evicted",
          };
        }
        const view = projectTransaction(requireObject(raw, `the transaction ${hash}`));
        return {
          hash,
          state: view.blockNumber === null ? "pendingHere" : "mined",
          nonce: view.nonce,
          blockNumber: view.blockNumber,
        };
      }),
    );

    const pendingHere = rows.filter((r) => r.state === "pendingHere");
    // The whole reason this tool cannot just subtract two numbers: an endpoint
    // that does not track the public mempool answers `pending` with `latest`,
    // and a caller reading that as "nothing is queued" broadcasts a duplicate.
    // A transaction this endpoint admits is unmined, on an account whose
    // pending nonce has not moved, proves the pending view is not mempool-aware.
    const mempoolVisible = pendingHere.length === 0 ? null : pending > latest;

    const gapEvidence = pendingHere.find(
      (row) => row.nonce !== null && BigInt(row.nonce) > pending,
    );

    const verdict =
      pending < latest
        ? "unknown"
        : mempoolVisible === false
          ? "unknown"
          : gapEvidence !== undefined
            ? "gap"
            : pending > latest
              ? "pending"
              : "clear";

    return json({
      address,
      latestNonce: latest.toString(),
      pendingNonce: pending.toString(),
      queued: pending > latest ? (pending - latest).toString() : "0",
      nextNonce: pending > latest ? pending.toString() : latest.toString(),
      verdict,
      mempoolVisible,
      broadcast: rows,
      ...(pending < latest
        ? {
            endpointInconsistent: true,
            note: "this endpoint reported a pending nonce BELOW the latest nonce, which cannot be true of one node — the two calls were probably answered by different machines behind a load balancer, so neither number can be trusted for a decision",
          }
        : {}),
      ...(mempoolVisible === false
        ? {
            note: "this endpoint reports a transaction of yours as unmined while its pending nonce has not moved past the latest one, so its pending view does not include the mempool. Treat 'clear' from this endpoint as unknown.",
          }
        : {}),
      ...(gapEvidence !== undefined
        ? {
            note: `transaction ${gapEvidence.hash} is waiting at nonce ${gapEvidence.nonce} while nothing has taken nonce ${pending} — nothing after the hole can be mined until it is filled`,
          }
        : {}),
      gapDetection:
        input.broadcast === undefined || input.broadcast.length === 0
          ? "no broadcast hashes were supplied, so a nonce gap could not be looked for: a gapped transaction sits in a node's queued pool and is invisible to both nonce counts"
          : "checked against the supplied broadcast hashes",
      calls: rpc.calls,
    });
  },
});

export const evmWaitForReceipt: RegisteredTool = buildTool({
  name: "EvmWaitForReceipt",
  description:
    "Wait, with a deadline, for a transaction to be mined, and report which of three things happened: it was mined and succeeded, it was mined and REVERTED, or the deadline passed with it still unmined. Use it after broadcasting anything. The three outcomes are the point — a reverted transaction has a receipt with status 0x0, so a tool that reports 'no receipt' for it tells a caller to broadcast again, which is how a failed transaction becomes two. It also tells a transaction this endpoint has never seen apart from one it is holding in its mempool, and can wait for a number of confirmations or for the chain's own safe/finalized tag instead of a block count.",
  inputSchema: z
    .object({
      rpcUrl: rpcUrlField,
      txHash: hashField,
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(3_600_000)
        .optional()
        .describe("how long to wait in total, in milliseconds; default 60000"),
      pollIntervalMs: z
        .number()
        .int()
        .min(100)
        .max(60_000)
        .optional()
        .describe("delay between polls; default 2000"),
      confirmations: z
        .number()
        .int()
        .min(0)
        .max(1_000)
        .optional()
        .describe("also wait until the receipt is this many blocks deep; default 0"),
      finality: z
        .enum(["confirmations", "safe", "finalized"])
        .optional()
        .describe('what "settled" means; default "confirmations"'),
      timeoutMs: timeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const rpc = await client(input, ctx);
    const hash = requireHash(input.txHash, "txHash");
    const waitMs = input.waitMs ?? 60_000;
    const intervalMs = input.pollIntervalMs ?? 2_000;
    const wanted = input.confirmations ?? 0;
    const finality = input.finality ?? "confirmations";

    const startedAt = nowMs();
    const deadline = startedAt + waitMs;
    let polls = 0;
    let everSeenInMempool = false;
    /** Held so the deadline branch can still report a receipt that arrived but was not deep enough yet. */
    let mined: { readonly receipt: ReceiptOf; readonly settled: Settlement } | null = null;

    for (;;) {
      polls += 1;
      const receiptRaw = await callOrThrow(
        rpc,
        "eth_getTransactionReceipt",
        [hash],
        `reading the receipt for ${hash}`,
      );

      if (receiptRaw !== null && receiptRaw !== undefined) {
        const receipt = projectReceipt(
          requireObject(receiptRaw, `the receipt for ${hash}`),
          projectLog,
        );
        const settled = await settlement(rpc, receipt.blockNumber, finality, wanted);
        mined = { receipt, settled };
        if (settled.settled) {
          return json(minedResult(mined, finality, polls, nowMs() - startedAt, rpc.calls));
        }
      } else {
        const txRaw = await callOrThrow(
          rpc,
          "eth_getTransactionByHash",
          [hash],
          `looking up ${hash}`,
        );
        if (txRaw !== null && txRaw !== undefined) everSeenInMempool = true;
      }

      const remaining = deadline - nowMs();
      if (remaining <= 0) {
        // A receipt that arrived but is not yet as deep as the caller asked for
        // is still a receipt. Reporting "not mined" here because the clock ran
        // out is the confusion this tool exists to remove.
        if (mined !== null) {
          return json(minedResult(mined, finality, polls, nowMs() - startedAt, rpc.calls));
        }
        return json({
          // Not an error: "still unmined after 60 seconds" is an answer, and
          // the caller's next move depends on which of the two reasons it is.
          outcome: "deadline",
          status: "notMined",
          reason: everSeenInMempool
            ? "the deadline passed while this endpoint still held the transaction in its mempool — it is unmined, not failed, and rebroadcasting the same nonce will not help"
            : "the deadline passed and this endpoint has never seen this transaction — it may not have propagated here, it may have been dropped, or it may have been sent to a different chain",
          knownToEndpoint: everSeenInMempool,
          polls,
          waitedMs: nowMs() - startedAt,
          waitMs,
          calls: rpc.calls,
        });
      }

      await sleep(Math.min(intervalMs, remaining), ctx?.signal);
    }
  },
});

type ReceiptOf = ReturnType<typeof projectReceipt>;
type Settlement = Awaited<ReturnType<typeof settlement>>;

function minedResult(
  mined: { readonly receipt: ReceiptOf; readonly settled: Settlement },
  finality: string,
  polls: number,
  elapsedMs: number,
  calls: number,
): Record<string, unknown> {
  const { receipt, settled } = mined;
  return {
    outcome: "mined",
    // The three-way answer, said plainly, because "ok: false" on a revert reads
    // the same as "ok: false" on a timeout and they are opposite instructions
    // to the caller.
    status: receipt.status,
    ...(receipt.statusReason !== undefined ? { statusReason: receipt.statusReason } : {}),
    reverted: receipt.status === "reverted",
    settled: settled.settled,
    ...(settled.settled ? {} : { settlementNote: settled.note }),
    confirmations: settled.confirmations,
    finality,
    receipt: {
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      transactionIndex: receipt.transactionIndex,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      contractAddress: receipt.contractAddress,
      logCount: receipt.logs.length,
    },
    polls,
    elapsedMs,
    calls,
  };
}

async function settlement(
  rpc: RpcClient,
  receiptBlock: string,
  finality: "confirmations" | "safe" | "finalized",
  wanted: number,
): Promise<{ readonly settled: boolean; readonly confirmations: string; readonly note: string }> {
  const mined = BigInt(receiptBlock);
  const head = await headNumber(rpc);
  const confirmations = head >= mined ? (head - mined + 1n).toString() : "0";

  if (finality === "confirmations") {
    return {
      settled: BigInt(confirmations) >= BigInt(wanted),
      confirmations,
      note: `${confirmations} of ${wanted} confirmations`,
    };
  }

  // A block count is not finality on a chain that reorganises in bursts; the
  // chain's own tag is. Not every chain or endpoint serves one, and that is a
  // refusal rather than a quiet fallback to counting — falling back would
  // report "finalized" for something that is not.
  const tagged = await fetchBlock(rpc, { kind: "tag", tag: finality });
  if (tagged === null || tagged.number === null) {
    throw new ChainReadError(
      `this endpoint does not serve the "${finality}" block tag, so finality cannot be established that way — use finality:"confirmations" with a confirmation count you trust for this chain`,
    );
  }
  const settled = BigInt(tagged.number) >= mined;
  return {
    settled,
    confirmations,
    note: `the chain's ${finality} block is ${tagged.number}; this transaction is in block ${receiptBlock}`,
  };
}

export const evmTransactionSummary: RegisteredTool = buildTool({
  name: "EvmTransactionSummary",
  description:
    "Explain one transaction in bookkeeping terms: who sent it, what it called, which tokens and how much native value moved, which approvals it granted, what it cost in fees, and the net change for an address you name. Use it to reconcile or to explain a transaction without reading raw logs. It is explicit about its own blind spots, in the output and not only in the docs: a receipt carries logs and no trace, so native value moved by a CONTRACT during the call is invisible here and the net deltas say so. Fees are computed from the fields the receipt actually has, so an OP-stack L1 data fee is added and an Arbitrum L1 charge is not double-counted.",
  inputSchema: z
    .object({
      rpcUrl: rpcUrlField,
      txHash: hashField,
      perspective: addressField
        .optional()
        .describe("compute net deltas for this address; defaults to the sender"),
      timeoutMs: timeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const rpc = await client(input, ctx);
    const hash = requireHash(input.txHash, "txHash");

    const [txRaw, receiptRaw] = await Promise.all([
      callOrThrow(rpc, "eth_getTransactionByHash", [hash], `looking up ${hash}`),
      callOrThrow(rpc, "eth_getTransactionReceipt", [hash], `reading the receipt for ${hash}`),
    ]);

    if (txRaw === null || txRaw === undefined) {
      throw new ChainReadError(
        `this endpoint has no transaction ${hash} — it may be on a different chain, it may never have propagated here, or it may have been dropped from the mempool`,
      );
    }
    const tx = projectTransaction(requireObject(txRaw, `the transaction ${hash}`));

    if (receiptRaw === null || receiptRaw === undefined) {
      return json({
        mined: false,
        note: "this transaction is known to the endpoint but has no receipt yet, so nothing about its effects is settled — there are no transfers to report and no fee to compute",
        transaction: tx,
        calls: rpc.calls,
      });
    }

    const receiptObject = requireObject(receiptRaw, `the receipt for ${hash}`);
    const receipt = projectReceipt(receiptObject, projectLog);
    const block = await fetchBlock(rpc, { kind: "number", value: BigInt(receipt.blockNumber) });

    const movements: TokenMovement[] = [];
    const approvals: ApprovalEvent[] = [];
    let undecoded = 0;
    for (const log of receipt.logs) {
      const transfer = decodeTransfer(log);
      if (transfer !== null) {
        movements.push(transfer);
        continue;
      }
      const approval = decodeApproval(log);
      if (approval !== null) {
        approvals.push(approval);
        continue;
      }
      undecoded += 1;
    }

    const fees = feeBreakdown(receiptObject, receipt);
    const who =
      input.perspective === undefined ? tx.from : requireAddress(input.perspective, "perspective");
    const deltas = netDeltas(who, tx, receipt, movements, fees);

    return json({
      mined: true,
      status: receipt.status,
      ...(receipt.statusReason !== undefined ? { statusReason: receipt.statusReason } : {}),
      transaction: tx,
      block:
        block === null
          ? null
          : { number: block.number, timestamp: block.timestamp, timestampIso: block.timestampIso },
      // A reverted transaction still costs gas and still has logs from before
      // the revert stripped — except it does not: a revert discards them. Saying
      // so is cheaper than a caller wondering why the arrays are empty.
      ...(receipt.status === "reverted"
        ? {
            note: "this transaction reverted: its state changes were discarded and it emitted no logs, but the fee below was still charged",
          }
        : {}),
      tokenTransfers: movements,
      approvals,
      undecodedLogs: undecoded,
      fees,
      netDeltas: deltas,
      completeness: {
        internalNativeTransfers: "excluded",
        why: "a receipt contains logs and no trace, so native value moved by a contract during this call leaves no record here. Only the transaction's own top-level value is counted.",
        tokenMetadata: "not resolved",
        tokenMetadataWhy:
          "amounts are raw base units. Resolving symbol and decimals costs an eth_call per token and a token contract is free to report whatever it likes; use TokenUnits with decimals you trust.",
      },
      calls: rpc.calls,
    });
  },
});

function netDeltas(
  who: string,
  tx: ReturnType<typeof projectTransaction>,
  receipt: ReturnType<typeof projectReceipt>,
  movements: ReadonlyArray<TokenMovement>,
  fees: ReturnType<typeof feeBreakdown>,
): Record<string, unknown> {
  const isSender = tx.from === who;
  // A revert discards the value transfer with everything else it did; the fee
  // is the only thing the chain keeps. Booking `tx.value` anyway put a delta
  // in this object that its own `completeWhy` said had not happened — and a
  // reconciliation reading the number rather than the prose is then wrong by
  // the whole transaction.
  const moved = receipt.status === "reverted" ? 0n : BigInt(tx.value);
  let native = 0n;
  if (isSender) native -= moved;
  if (tx.to === who) native += moved;

  const tokens = new Map<string, bigint>();
  for (const move of movements) {
    if (move.standard === "erc721") continue;
    const amount = BigInt(move.amount);
    if (move.from === who) tokens.set(move.token, (tokens.get(move.token) ?? 0n) - amount);
    if (move.to === who) tokens.set(move.token, (tokens.get(move.token) ?? 0n) + amount);
  }

  const fee = isSender && fees.totalFeeWei !== null ? BigInt(fees.totalFeeWei) : 0n;
  return {
    address: who,
    isSender,
    nativeWei: native.toString(),
    feePaidWei: fee.toString(),
    nativeWeiIncludingFee: (native - fee).toString(),
    tokens: [...tokens.entries()].map(([token, amount]) => ({ token, amount: amount.toString() })),
    nfts: movements
      .filter((m) => m.standard === "erc721" && (m.from === who || m.to === who))
      .map((m) => ({ token: m.token, tokenId: m.tokenId, direction: m.to === who ? "in" : "out" })),
    reverted: receipt.status === "reverted",
    complete: false,
    completeWhy:
      receipt.status === "reverted"
        ? "this transaction reverted, so nothing moved except the fee: the value it carried was returned and is not counted below"
        : receipt.status === "unknown"
          ? `this receipt does not record whether the call reverted (${receipt.statusReason ?? "no status field"}), so the top-level value is counted as having moved — which is wrong if it did revert`
          : "internal native transfers are not visible from a receipt, so this is complete only for the top-level value, the fee and the logged token movements",
  };
}

export const evmEventScan: RegisteredTool = buildTool({
  name: "EvmEventScan",
  description:
    "Collect every log matching a filter across a block range, paging around whatever limits the endpoint imposes, and refuse rather than return a set it cannot prove is complete. Use it to find what happened onchain over a period — transfers to an address, every emission of one event — without hand-writing the paging. Public endpoints cap log queries and disagree about how: some answer with an error naming a smaller range, and some silently return the first N logs of a range that held more. The first is handled by halving and retrying; the second is caught by re-querying a suspicious chunk in halves and comparing the counts, because a missing log is an event that, to everything downstream, did not happen.",
  inputSchema: z
    .object({
      rpcUrl: rpcUrlField,
      fromBlock: blockField,
      toBlock: blockField.optional().describe('default "latest"'),
      confirmations: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .describe("stop this many blocks short of the head, so the range is behind any reorg"),
      address: z
        .union([addressField, z.array(addressField).min(1).max(LIMITS.addresses)])
        .optional()
        .describe("only logs from this contract (or these)"),
      topics: z
        .array(z.union([z.string(), z.array(z.string()).max(LIMITS.topicAlternatives), z.null()]))
        .max(LIMITS.topicPositions)
        .optional()
        .describe("standard topic filter; topics[0] is the event signature hash"),
      maxSpan: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe("blocks per request to start from; default 2000, narrowed automatically"),
      maxLogs: z
        .number()
        .int()
        .min(1)
        .max(LIMITS.hardMaxLogs)
        .optional()
        .describe("refuse past this many logs rather than truncating; default 5000"),
      suspectAt: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("log count at which a chunk is re-checked for silent truncation; default 1000"),
      decode: z
        .boolean()
        .optional()
        .describe("also decode ERC-20/721/1155 transfers and approvals; default true"),
      timeoutMs: timeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const rpc = await client(input, ctx);

    const head = await headNumber(rpc);
    const confirmations = BigInt(input.confirmations ?? 0);
    const from = await resolveBlockNumber(rpc, input.fromBlock, "fromBlock");
    const requestedTo =
      input.toBlock === undefined ? head : await resolveBlockNumber(rpc, input.toBlock, "toBlock");
    // The range is pinned to numbers before the first query. A scan whose upper
    // bound is still the string "latest" is a scan of a moving target, and
    // "complete" is not a claim anybody can make about one.
    const to = confirmations > 0n ? minBig(requestedTo, head - confirmations) : requestedTo;

    if (to < from) {
      throw new ChainReadError(
        `there is nothing to scan: fromBlock ${from} is after toBlock ${to}${
          confirmations > 0n
            ? ` (the head is ${head}, and ${confirmations} confirmations put the upper bound at ${head - confirmations})`
            : ""
        }`,
      );
    }

    const filter: LogFilter = {
      ...(input.address === undefined
        ? {}
        : {
            address: (Array.isArray(input.address) ? input.address : [input.address]).map((a) =>
              requireAddress(a, "address"),
            ),
          }),
      ...(input.topics === undefined ? {} : { topics: normalizeTopics(input.topics) }),
    };

    const report = await scanLogs(rpc, filter, {
      from,
      to,
      span: input.maxSpan === undefined ? LIMITS.defaultSpan : BigInt(input.maxSpan),
      suspectAt: input.suspectAt ?? 1_000,
      maxLogs: input.maxLogs ?? LIMITS.defaultMaxLogs,
      maxCalls: LIMITS.scanCalls,
    });

    const decode = input.decode !== false;
    return json({
      // Only ever true. The alternative is a refusal, because a partial set and
      // a complete one are indistinguishable once they leave this tool.
      complete: true,
      range: { fromBlock: from.toString(), toBlock: to.toString(), head: head.toString() },
      logCount: report.logs.length,
      logs: report.logs,
      ...(decode
        ? {
            transfers: report.logs
              .map(decodeTransfer)
              .filter((m): m is TokenMovement => m !== null),
            approvals: report.logs
              .map(decodeApproval)
              .filter((a): a is ApprovalEvent => a !== null),
          }
        : {}),
      paging: {
        chunks: report.chunks,
        calls: report.calls,
        finalSpanBlocks: report.finalSpan,
        verifications: report.verifications,
        silentTruncations: report.silentTruncations,
        ...(report.silentTruncations > 0
          ? {
              warning: `${report.silentTruncations} chunk(s) came back truncated with nothing in the response saying so. The missing logs were recovered by re-querying in halves and the set above is complete, but this endpoint will do it again — prefer one that reports its limits, or keep maxSpan small.`,
            }
          : {}),
      },
      calls: rpc.calls,
    });
  },
});

function normalizeTopics(
  topics: ReadonlyArray<string | ReadonlyArray<string> | null>,
): ReadonlyArray<string | ReadonlyArray<string> | null> {
  return topics.map((position, index) => {
    if (position === null) return null;
    if (Array.isArray(position)) {
      return position.map((t) => lowerHex(t, `topics[${index}]`));
    }
    return lowerHex(position as string, `topics[${index}]`);
  });
}

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

const unitsField = z
  .object({
    symbol: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe("a label for the description text; nothing is read off the chain to check it"),
    decimals: z
      .number()
      .int()
      .min(0)
      .max(36)
      .optional()
      .describe("the asset's own decimals, e.g. 18 for ether, 6 for USDC"),
    minorUnitDecimals: z
      .number()
      .int()
      .min(0)
      .max(36)
      .optional()
      .describe("the ledger's minor unit for this asset; default: the asset's own base units"),
  })
  .strict();

export const onchainTransactionsSync: RegisteredTool = buildTool({
  name: "OnchainTransactionsSync",
  description:
    "Pull one address's onchain history over a block range and return it as the same normalized rows a bank statement parses into, so a wallet can be reconciled against a ledger instead of read as raw logs. It emits the row shape StatementParse produces and LedgerReconcile consumes — id, date, description, amountMinor, direction, reference, balanceMinor — with the exact uint256 kept alongside each row rather than rounded into it. Use it to close the books on a wallet, or to sync incrementally: it returns a cursor pinned to the block it actually finished at. It refuses rather than under-reporting, the way EvmEventScan does, and it says in the output which movements it cannot see at all: internal native transfers need a trace, and ERC-1155 is not collected.",
  inputSchema: z
    .object({
      rpcUrl: rpcUrlField,
      address: addressField.describe(
        "the one account to build a statement for; a statement row has no account column, so this is deliberately not a list",
      ),
      fromBlock: blockField,
      toBlock: blockField.optional().describe('default "latest"'),
      confirmations: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .describe("stop this many blocks short of the head, so the cursor is behind any reorg"),
      include: z
        .array(z.enum(["tokenTransfers", "native", "fees"]))
        .min(1)
        .max(3)
        .optional()
        .describe('what to collect; default all three. Dropping one is reported in "coverage"'),
      tokens: z
        .array(
          z
            .object({
              token: addressField,
              decimals: z.number().int().min(0).max(36),
              symbol: z.string().min(1).max(32).optional(),
              minorUnitDecimals: z.number().int().min(0).max(36).optional(),
            })
            .strict(),
        )
        .max(LIMITS.assets)
        .optional()
        .describe("the tokens whose decimals you know; nothing is read from a token contract"),
      onlyKnownTokens: z
        .boolean()
        .optional()
        .describe("scan only the tokens listed above; default true when any are listed"),
      native: unitsField
        .optional()
        .describe('units for the chain\'s own coin; default 18 decimals, symbol "native value"'),
      maxHydratedBlocks: z
        .number()
        .int()
        .min(1)
        .max(LIMITS.hardHydratedBlocks)
        .optional()
        .describe("native value costs one request per block; refuse past this many. Default 256"),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(LIMITS.hardRows)
        .optional()
        .describe("refuse past this many rows rather than truncating; default 5000"),
      maxSpan: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe("blocks per log request to start from; default 2000, narrowed automatically"),
      suspectAt: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("log count at which a chunk is re-checked for silent truncation; default 1000"),
      timeoutMs: timeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "network",
  execute: async (input, ctx) => {
    const rpc = await client(input, ctx);
    const address = requireAddress(input.address, "address");

    const include = input.include ?? ["tokenTransfers", "native", "fees"];
    const includeTokens = include.includes("tokenTransfers");
    const includeNative = include.includes("native");
    const includeFees = include.includes("fees");

    const tokenUnits = declaredTokenUnits(input.tokens);
    const nativeUnits = declaredNativeUnits(input.native);
    const onlyKnownTokens = input.onlyKnownTokens ?? tokenUnits.size > 0;
    if (input.onlyKnownTokens === true && tokenUnits.size === 0) {
      throw new ChainReadError(
        "onlyKnownTokens is true but no tokens were listed, which would scan for nothing and report it as a complete history — list the tokens, or leave onlyKnownTokens off",
      );
    }

    const head = await headNumber(rpc);
    const confirmations = BigInt(input.confirmations ?? 0);
    const from = await resolveBlockNumber(rpc, input.fromBlock, "fromBlock");
    const requestedTo =
      input.toBlock === undefined ? head : await resolveBlockNumber(rpc, input.toBlock, "toBlock");
    // Pinned to numbers before the first query, exactly as EvmEventScan does it:
    // the cursor handed back has to name a block, and a run that stopped at
    // "latest" stopped somewhere nobody can resume from.
    const to = confirmations > 0n ? minBig(requestedTo, head - confirmations) : requestedTo;

    if (to < from) {
      throw new ChainReadError(
        `there is nothing to sync: fromBlock ${from} is after toBlock ${to}${
          confirmations > 0n
            ? ` (the head is ${head}, and ${confirmations} confirmations put the upper bound at ${head - confirmations})`
            : ""
        }`,
      );
    }

    const report = await collectHistory(rpc, {
      address,
      from,
      to,
      includeTokens,
      includeNative,
      includeFees,
      tokenUnits,
      onlyKnownTokens,
      nativeUnits,
      span: input.maxSpan === undefined ? LIMITS.defaultSpan : BigInt(input.maxSpan),
      suspectAt: input.suspectAt ?? 1_000,
      maxRows: input.maxRows ?? LIMITS.defaultRows,
      maxHydratedBlocks: input.maxHydratedBlocks ?? LIMITS.defaultHydratedBlocks,
      maxCalls: LIMITS.syncCalls,
    });

    return json({
      address,
      // Only ever true, and only ever about the sources under `coverage`. A set
      // that could not be proved complete is an error, not a shorter list.
      complete: true,
      completeWhy:
        "every included source was collected over the whole pinned range or this would have been a refusal; what each source rests on, and what was not collected at all, is named in coverage",
      range: {
        fromBlock: from.toString(),
        toBlock: to.toString(),
        head: head.toString(),
        confirmations: confirmations.toString(),
      },
      // Resumable because it names the block this run actually finished at, not
      // the head at the moment it ended: the head has moved, and a cursor set
      // from it skips every block mined during the run.
      cursor: {
        nextFromBlock: (to + 1n).toString(),
        scannedThrough: to.toString(),
        note: "pass nextFromBlock as fromBlock to continue without re-reading or skipping a block",
      },
      rowCount: report.rows.length,
      /** Exactly `@crewhaus/tool-money`'s `Transaction`: feed it to LedgerReconcile as kind "lines". */
      rows: report.rows,
      /** The same rows keyed by id, with the uint256 that would not fit in one. */
      detail: report.detail,
      // Movements that are on the chain and cannot be written as a row. Not an
      // empty list because nothing happened — a list because something did.
      unrepresentable: report.unrepresentable,
      ...(report.unrepresentable.length > 0
        ? {
            unrepresentableWarning: `${report.unrepresentable.length} movement(s) could not be written as a row without rounding. They are listed above with the exact raw amount; give the asset's decimals and the ledger's minorUnitDecimals to bring them into range.`,
          }
        : {}),
      selfTransfers: report.selfTransfers,
      // The evidence for the half of `coverage` that is a claim rather than a
      // disclaimer, in the output next to it: a caller that reconciles on these
      // rows can see what the sent side was checked against.
      ...(report.sentProof === undefined ? {} : { sentProof: report.sentProof }),
      coverage: coverageOf(
        includeTokens,
        includeNative,
        includeFees,
        onlyKnownTokens,
        report.sentProof,
      ),
      paging: {
        logChunks: report.logChunks,
        logCalls: report.logCalls,
        verifications: report.verifications,
        silentTruncations: report.silentTruncations,
        hydratedBlocks: report.hydratedBlocks,
        receiptsRead: report.receiptsRead,
        ...(report.silentTruncations > 0
          ? {
              warning: `${report.silentTruncations} log chunk(s) came back truncated with nothing in the response saying so. The missing transfers were recovered by re-querying in halves and the rows above are complete, but this endpoint will do it again — prefer one that reports its limits, or keep maxSpan small.`,
            }
          : {}),
      },
      calls: rpc.calls,
    });
  },
});

/** The caller's token table, checked for the two ways it can be self-contradictory. */
function declaredTokenUnits(
  tokens:
    | ReadonlyArray<{
        readonly token: string;
        readonly decimals: number;
        readonly symbol?: string;
        readonly minorUnitDecimals?: number;
      }>
    | undefined,
): ReadonlyMap<string, AssetUnits> {
  const units = new Map<string, AssetUnits>();
  for (const entry of tokens ?? []) {
    const token = requireAddress(entry.token, "tokens[].token");
    if (units.has(token)) {
      throw new ChainReadError(
        `tokens lists ${token} twice — two sets of decimals for one token is two different answers for every row of it`,
      );
    }
    const minor = entry.minorUnitDecimals ?? entry.decimals;
    if (minor > entry.decimals) {
      throw new ChainReadError(
        `tokens[${token}]: minorUnitDecimals (${minor}) is finer than the token's own decimals (${entry.decimals}) — there are no digits there to scale up into`,
      );
    }
    units.set(token, {
      decimals: entry.decimals,
      minorUnitDecimals: minor,
      symbol: entry.symbol ?? null,
    });
  }
  return units;
}

function declaredNativeUnits(
  native:
    | { readonly symbol?: string; readonly decimals?: number; readonly minorUnitDecimals?: number }
    | undefined,
): AssetUnits {
  if (native === undefined) return UNKNOWN_UNITS;
  // 18 is the EVM native decimal count everywhere it is not overridden, and it
  // is only a default for the SCALE — the symbol is still whatever the caller
  // said, because this package never asks a chain what its coin is called.
  const decimals = native.decimals ?? 18;
  const minor = native.minorUnitDecimals ?? decimals;
  if (minor > decimals) {
    throw new ChainReadError(
      `native.minorUnitDecimals (${minor}) is finer than native.decimals (${decimals}) — there are no digits there to scale up into`,
    );
  }
  return { decimals, minorUnitDecimals: minor, symbol: native.symbol ?? null };
}

/**
 * What is in these rows and what is not, in the output rather than only in the
 * docs.
 *
 * Three of these are permanent — a receipt has no trace in it, ERC-1155 puts
 * its parties where this filter does not look, and a public endpoint has no
 * address index — and a caller who reconciles against rows that silently
 * omitted them balances to a number that is wrong by exactly what was omitted.
 */
function coverageOf(
  tokens: boolean,
  native: boolean,
  fees: boolean,
  onlyKnownTokens: boolean,
  sentProof: SentProof | undefined,
): Record<string, unknown> {
  // What the two block-sourced lines below may claim, and no more. A hydrated
  // block is one response that cannot be split, so the log scan's split-and-
  // compare proof has nothing to work with here — the account's nonce is the
  // only evidence there is, and it is evidence about the SENT side only.
  const sent =
    sentProof === undefined
      ? "not read"
      : sentProof.outcome === "proved"
        ? `proved complete against this account's nonce (${sentProof.sent} transaction(s))`
        : sentProof.outcome === "moreThanTheNonce"
          ? `${sentProof.sent} transaction(s), more than the nonce accounts for — a rollup's system transactions look like this, and nothing is missing`
          : `NOT proved: ${sentProof.why}`;
  return {
    tokenTransfers: tokens
      ? onlyKnownTokens
        ? "complete for the tokens listed in `tokens`, checked on the answer and not only in the filter; transfers of any other token were not scanned for"
        : "complete: every ERC-20 and ERC-721 Transfer log with this address as a party"
      : 'excluded: "tokenTransfers" was not in include',
    nativeTransfers: native
      ? `top-level value transfers, read from the blocks themselves. Sent: ${sent}. Received: whatever this endpoint's blocks contained — a block cannot be re-asked in halves, so a short one cannot be told from a quiet one`
      : 'excluded: "native" was not in include, so a plain coin payment is NOT in these rows',
    fees: fees
      ? `one row per transaction this address sent, charged once per transaction and never once per log. Sent: ${sent}`
      : 'excluded: "fees" was not in include, so gas spend is NOT in these rows',
    internalNativeTransfers:
      "excluded: coin moved by a CONTRACT during a call leaves no log and no receipt field. It is only visible in a trace, and debug_traceTransaction is neither on a public endpoint's free tier nor on this package's read-only allow-list",
    erc1155:
      "excluded: TransferSingle carries the operator where this filter looks for the sender, and TransferBatch keeps its amounts in data where no topic filter reaches. Neither is scanned for, rather than scanned for badly",
    tokenMetadata:
      "not resolved: decimals and symbols are only ever the ones you supplied. Reading decimals() costs an eth_call per token and a token contract is free to report whatever it likes, which turns an airdrop's dust into a five-figure row",
  };
}

/** Every tool this package registers, in the order a catalog should list them. */
export const CHAINREAD_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  evmBlockAtTimestamp,
  evmEventScan,
  evmGetBlock,
  evmNonceStatus,
  evmRpcHealth,
  evmTransactionSummary,
  evmWaitForReceipt,
  onchainTransactionsSync,
]);
