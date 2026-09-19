/**
 * Reading several contracts as one answer.
 *
 * Every read in a valuation has to come from ONE block height. A balance from
 * block N and a price from block N+1 is a number that never existed, and it
 * looks exactly like a number that did. Two things enforce that here:
 *
 *   1. The block is PINNED first — `eth_blockNumber`, then every read at that
 *      hex tag — so a batch is consistent whether it goes out as one
 *      Multicall3 call or as several plain `eth_call`s.
 *   2. Multicall3 is an OPTIMISATION, not the mechanism. It is used when the
 *      operator has pinned its address for the chain, because one round trip
 *      beats forty; a chain without a pinned deployment reads the same forty
 *      values at the same pinned block, one call at a time. A tool that
 *      required Multicall3 would be wrong on every chain that predates it.
 *
 * The packing and unpacking is `@crewhaus/tool-onchain`'s `encodeAggregate3` /
 * `decodeAggregate3`, not a local copy: the argument is an array of dynamic
 * tuples and the offsets are the part that goes wrong silently.
 *
 * One shape difference the two paths must not leak: under Multicall3 a
 * sub-call that reverts comes back as `success: false` with its revert bytes,
 * while a plain `eth_call` that reverts comes back as a JSON-RPC error. Both
 * land here as the same `CallOutcome` row, so nothing downstream has to know
 * which path it took.
 */
import { decodeAggregate3, encodeAggregate3 } from "@crewhaus/tool-onchain";
import { sanitizeContractText } from "./abi";
import { type RpcOptions, ethCall, mapPool } from "./rpc";

/** One read to issue. */
export type BatchCall = {
  readonly to: string;
  readonly data: string;
  /** What this read is, for the failure message. */
  readonly label: string;
};

/** One read's answer, at the position of the call that asked for it. */
export type CallOutcome =
  | { readonly ok: true; readonly data: string }
  | { readonly ok: false; readonly reason: string };

/** How many plain `eth_call`s are in flight at once when there is no Multicall3. */
const CALL_CONCURRENCY = 6;

export type BatchOptions = RpcOptions & {
  /** The chain's Multicall3 deployment, when the operator has pinned one. */
  readonly multicall3?: string;
};

export async function batchCalls(
  endpoint: string,
  calls: ReadonlyArray<BatchCall>,
  blockTag: string,
  options: BatchOptions = {},
): Promise<ReadonlyArray<CallOutcome>> {
  if (calls.length === 0) return [];
  if (options.multicall3 !== undefined && calls.length > 1) {
    return batchThroughMulticall(endpoint, calls, blockTag, options.multicall3, options);
  }
  return mapPool(calls, CALL_CONCURRENCY, async (call) => {
    const outcome = await ethCall(endpoint, call.to, call.data, blockTag, options);
    return outcome.ok
      ? ({ ok: true, data: outcome.value } as const)
      : ({ ok: false, reason: `${call.label}: ${outcome.message}` } as const);
  });
}

async function batchThroughMulticall(
  endpoint: string,
  calls: ReadonlyArray<BatchCall>,
  blockTag: string,
  multicall3: string,
  options: RpcOptions,
): Promise<ReadonlyArray<CallOutcome>> {
  const request = encodeAggregate3(
    calls.map((call) => ({ target: call.to, callData: call.data, allowFailure: true })),
    multicall3,
  );
  const outcome = await ethCall(endpoint, request.to, request.data, blockTag, options);
  if (!outcome.ok) {
    // The batch itself failed, so there is no per-call answer to hand back.
    // Every row carries the same reason rather than one row failing and the
    // rest reading as empty.
    return calls.map((call) => ({
      ok: false,
      reason: `${call.label}: the Multicall3 batch failed — ${outcome.message}`,
    }));
  }
  let rows: ReadonlyArray<{
    success: boolean;
    returnData: string;
    revert: { reason: string | null } | null;
  }>;
  try {
    rows = decodeAggregate3(outcome.value, calls.length);
  } catch (err) {
    return calls.map((call) => ({
      ok: false,
      reason: `${call.label}: the Multicall3 answer could not be read — ${(err as Error).message}`,
    }));
  }
  return rows.map((row, index) => {
    const call = calls[index] as BatchCall;
    if (row.success) return { ok: true, data: row.returnData } as const;
    // A revert string is written by the contract, and this one ends up in a
    // tool result and then in a model's context. It is capped and scrubbed for
    // the same reason `description()` is: a `revert(...)` is a free-text field
    // an attacker controls, and a newline in it lets it impersonate the lines
    // around it.
    const reason = row.revert?.reason;
    const safe = reason === null || reason === undefined ? null : sanitizeContractText(reason).text;
    return {
      ok: false,
      reason: `${call.label}: the call reverted${safe === null ? "" : ` — ${safe}`}`,
    } as const;
  });
}
