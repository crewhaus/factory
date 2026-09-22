/**
 * Driving a Multicall3 batch: pack, one `eth_call`, unpack.
 *
 * The packing and unpacking are `@crewhaus/tool-onchain`'s
 * `encodeAggregate3` / `decodeAggregate3` — this file adds only the round
 * trip and the distinction the whole batch idea rests on:
 *
 *   - a SUB-CALL that reverted is a row, with `success: false` and its
 *     revert bytes;
 *   - the BATCH failing is an exception, because there are then no rows at
 *     all and the caller's next move is different.
 *
 * `decodeAggregate3` already refuses a blob whose result count does not
 * match the batch that was sent. That refusal is load-bearing: results are
 * matched by position and nothing in them names the call they answer, so a
 * short answer zipped against the calls sent attributes every result after
 * the gap to the wrong contract.
 */
import { decodeAggregate3, encodeAggregate3 } from "@crewhaus/tool-onchain";
import type { Aggregate3Result, Call3 } from "@crewhaus/tool-onchain";
import { data as asData } from "./hex";
import { ChainCallError, type ChainRpc, isAbort, rpcErrorText, rpcRead } from "./rpc";

export type { Aggregate3Result, Call3 };

/**
 * Send one `aggregate3` and return the per-call rows.
 *
 * `block` is a tag or a quantity and is passed through verbatim; pinning it
 * to a number is the caller's job, because only the caller knows whether it
 * is sending one batch or five.
 */
export async function runAggregate3(
  rpc: ChainRpc,
  chainId: string,
  calls: ReadonlyArray<Call3>,
  multicall3Address: string,
  block: string,
  signal: AbortSignal,
  what: string,
): Promise<ReadonlyArray<Aggregate3Result>> {
  const request = encodeAggregate3(calls, multicall3Address);
  let raw: unknown;
  try {
    raw = await rpcRead(
      rpc,
      chainId,
      "eth_call",
      [{ to: request.to, data: request.data }, block],
      signal,
    );
  } catch (err) {
    // A cancellation passes through unchanged. Dressing it as "the batch
    // failed" would send a caller looking for a missing Multicall3 deploy
    // when what actually happened is that their deadline ran out.
    if (isAbort(err, signal)) throw err;
    // The aggregate call itself failing is not a sub-call reverting. It means
    // the batch never ran: no Multicall3 at that address on this chain, a
    // block the node has pruned, a gas cap the batch went past, or a sub-call
    // with allowFailure:false taking the whole batch down with it.
    throw new ChainCallError(
      `${what}: the Multicall3 batch itself failed at ${request.to} — ${rpcErrorText(err)}`,
      err,
    );
  }
  return decodeAggregate3(asData(raw, `${what}: the batch's return data`), request.callCount);
}

/** Split into runs of at most `size`, preserving order. */
export function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
