/**
 * The one way this package learns anything from a chain — and the reason it
 * is the only way.
 *
 * **There is no dialling code in `@crewhaus/tool-token`.** No URL, no fetch,
 * no socket. Every chain read leaves through `_setChainReader`, which the
 * runtime binds at boot and every test in this package drives from recorded
 * answers. Two things follow, and both are the point:
 *
 *   1. A test cannot reach a public RPC endpoint even by accident. There is
 *      nothing under the seam to reach it with. A suite that dialled a real
 *      node would fail on a CI runner with no egress and flake on somebody
 *      else's rate limit.
 *   2. The set of JSON-RPC methods this package can emit is three, they are
 *      listed below, and {@link assertReadMethod} refuses anything else
 *      before it reaches the reader. `eth_sendTransaction` and
 *      `eth_sendRawTransaction` are not reachable from any code path here;
 *      `index.test.ts` asserts it.
 *
 * Reads are batched through Multicall3 by default, because a hundred balances
 * read one at a time are a hundred balances from up to a hundred different
 * blocks. `getBlockNumber()` rides along in the same batch so the answer says
 * which block it is a snapshot of.
 */
import type { ChainAdapter } from "@crewhaus/chain-adapter-base";
import { CrewhausError } from "@crewhaus/errors";
import {
  MULTICALL3_ADDRESS,
  type RevertReason,
  decodeAggregate3,
  encodeAggregate3,
} from "@crewhaus/tool-onchain";
import { SELECTOR, addressWord, callData, decodeUint } from "./erc";

/** A refusal this package makes: a bad input, a missing seam, an unreadable answer. */
export class TokenError extends CrewhausError {
  override readonly name = "TokenError";
  constructor(message: string) {
    super("tool", message);
  }
}

/**
 * Every JSON-RPC method this package is allowed to emit. All three are reads
 * of public state. Nothing on this list can move a token, and nothing that
 * could is reachable from here.
 */
export const READ_METHODS = Object.freeze(["eth_call", "eth_getBalance", "eth_getCode"] as const);

export type ChainReadMethod = (typeof READ_METHODS)[number];

export type ChainRead = {
  readonly chainId: number;
  readonly method: ChainReadMethod;
  readonly params: ReadonlyArray<unknown>;
};

/** What the runtime binds: one function, one read, one answer. */
export type ChainReader = (read: ChainRead) => Promise<unknown>;

const unbound: ChainReader = async (read) => {
  throw new TokenError(
    `no chain reader is bound, so chain ${read.chainId} cannot be read. This package contains no RPC client of its own: the runtime binds one with _setChainReader(), and chainReaderFromAdapters() wires it from the spec's chains[] block in one line.`,
  );
};

let reader: ChainReader = unbound;

/**
 * Bind the chain reader. The runtime calls this at boot; tests call it with a
 * stub over recorded answers. `undefined` restores the unbound state, and a
 * suite that installs a stub must restore it or the next file in the same bun
 * process inherits it.
 */
export function _setChainReader(fn: ChainReader | undefined): void {
  reader = fn ?? unbound;
}

/** True when something is bound — the tools report this rather than failing late. */
export function hasChainReader(): boolean {
  return reader !== unbound;
}

export function assertReadMethod(method: string): asserts method is ChainReadMethod {
  if (!(READ_METHODS as ReadonlyArray<string>).includes(method)) {
    throw new TokenError(
      `${method} is not one of the read methods this package emits (${READ_METHODS.join(", ")}). Nothing here signs or submits anything.`,
    );
  }
}

/**
 * Wire the seam to `chain-adapter-base` adapters, which is what a compiled
 * bundle has. The adapter applies its own read-only allowlist underneath, so
 * a write method would be refused twice.
 */
export function chainReaderFromAdapters(
  resolve: (chainId: string) => ChainAdapter | undefined,
): ChainReader {
  return async (read) => {
    assertReadMethod(read.method);
    const adapter = resolve(String(read.chainId));
    if (adapter === undefined) {
      throw new TokenError(
        `no chain adapter is registered for chain ${read.chainId}; declare it in the spec's chains[] block`,
      );
    }
    return adapter.rpcRead(read.method, read.params);
  };
}

async function rpc(read: ChainRead): Promise<unknown> {
  assertReadMethod(read.method);
  return reader(read);
}

function asHex(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new TokenError(
      `${what}: expected 0x-prefixed hex from the node, got ${JSON.stringify(value)?.slice(0, 120) ?? "undefined"}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------

/** One call in a read, keyed so results are never matched up by position here. */
export type BatchCall = {
  /** The caller's own label. Results come back in a map under it. */
  readonly key: string;
  readonly target: string;
  readonly callData: string;
};

/** What one call answered. A revert is an outcome, not an exception. */
export type CallOutcome = {
  readonly ok: boolean;
  /** Return data on success, revert data on failure. */
  readonly data: string;
  readonly revert: RevertReason | null;
  /**
   * What the node said when it refused the call outright, on the unbatched
   * path. Null on the batched path, where a revert arrives as data and
   * `revert` carries it.
   */
  readonly error: string | null;
};

export type BatchResult = {
  readonly outcomes: ReadonlyMap<string, CallOutcome>;
  /** The block the batch was read at, when Multicall3 was asked. */
  readonly blockNumber: string | null;
  readonly batched: boolean;
  readonly callCount: number;
};

const BLOCK_TAG = /^(latest|earliest|pending|safe|finalized|0x[0-9a-fA-F]+)$/;

export function checkBlockTag(tag: string): string {
  if (!BLOCK_TAG.test(tag)) {
    throw new TokenError(
      `"${tag}" is not a block tag; use latest, safe, finalized, earliest, pending, or a 0x hex block number`,
    );
  }
  return tag;
}

/**
 * Run a set of calls, batched through Multicall3 when asked.
 *
 * Batched is the default because it is the only way the answers are
 * consistent with each other: one `eth_call` evaluates every sub-call at one
 * block, so a balance and the decimals it is scaled by cannot come from
 * either side of a rebase. The unbatched path exists for chains where
 * Multicall3 is not deployed, and it says so in the result rather than
 * quietly producing a snapshot that is not one.
 *
 * A sub-call that reverts comes back as an outcome with `ok: false`. The
 * BATCH failing is a different event — a Multicall3 address with no contract
 * at it, a node that answered something else — and that throws, because
 * nothing in the answer can be trusted to be about the calls that were sent.
 */
export async function readCalls(opts: {
  readonly chainId: number;
  readonly calls: ReadonlyArray<BatchCall>;
  readonly blockTag: string;
  readonly batch: boolean;
  readonly multicall3Address?: string;
}): Promise<BatchResult> {
  const blockTag = checkBlockTag(opts.blockTag);
  const outcomes = new Map<string, CallOutcome>();
  if (opts.calls.length === 0) {
    return { outcomes, blockNumber: null, batched: false, callCount: 0 };
  }

  if (!opts.batch) {
    for (const call of opts.calls) {
      try {
        const answer = await rpc({
          chainId: opts.chainId,
          method: "eth_call",
          params: [{ to: call.target, data: call.callData }, blockTag],
        });
        outcomes.set(call.key, {
          ok: true,
          data: asHex(answer, call.key),
          revert: null,
          error: null,
        });
      } catch (err) {
        // A refusal from this package — an unbound seam, a method that is not
        // a read — is about the whole call, not about this one sub-call, and
        // burying it as one of N per-call errors hides the one line that says
        // what to fix.
        if (err instanceof TokenError) throw err;
        // An unbatched eth_call cannot report a revert as data — the node
        // errors instead. Recording it as this one call's failure is what
        // keeps a token whose `decimals()` reverts from taking its balances
        // down with it, which is the whole reason the batched path sets
        // allowFailure.
        outcomes.set(call.key, {
          ok: false,
          data: "0x",
          revert: null,
          error: (err as Error).message,
        });
      }
    }
    return { outcomes, blockNumber: null, batched: false, callCount: opts.calls.length };
  }

  const multicall = opts.multicall3Address ?? MULTICALL3_ADDRESS;
  const blockKey = "\u0000blockNumber";
  const packed = [
    { key: blockKey, target: multicall, callData: callData(SELECTOR.getBlockNumber) },
    ...opts.calls,
  ];
  const request = encodeAggregate3(
    packed.map((c) => ({ target: c.target, callData: c.callData, allowFailure: true })),
    multicall,
  );

  const answer = await rpc({
    chainId: opts.chainId,
    method: "eth_call",
    params: [{ to: request.to, data: request.data }, blockTag],
  });

  let rows: ReadonlyArray<{ success: boolean; returnData: string; revert: RevertReason | null }>;
  try {
    rows = decodeAggregate3(asHex(answer, "the Multicall3 batch"), request.callCount);
  } catch (err) {
    throw new TokenError(
      `the Multicall3 batch at ${request.to} did not answer with results: ${(err as Error).message}. If this chain has no Multicall3 deployment at that address, pass multicall3Address, or batch:false to read the calls one at a time.`,
    );
  }

  for (const [i, call] of packed.entries()) {
    const row = rows[i] as { success: boolean; returnData: string; revert: RevertReason | null };
    outcomes.set(call.key, {
      ok: row.success,
      data: row.returnData,
      revert: row.revert,
      error: null,
    });
  }

  const block = outcomes.get(blockKey);
  outcomes.delete(blockKey);
  const blockNumber = block?.ok === true ? (decodeUint(block.data)?.toString() ?? null) : null;
  return { outcomes, blockNumber, batched: true, callCount: opts.calls.length };
}

/** The native balance, which is not a contract call and so is never in the batch. */
export async function readNativeBalance(
  chainId: number,
  address: string,
  blockTag: string,
): Promise<bigint> {
  const answer = await rpc({
    chainId,
    method: "eth_getBalance",
    params: [address, checkBlockTag(blockTag)],
  });
  // A quantity is at least `0x0`. Bare `0x` is what a node returns when it
  // has nothing to say, and reading it as zero is the mistake this whole
  // package exists to stop: an unanswered balance becoming "this account is
  // empty", which is a sentence a gas check or a drain alarm acts on.
  if (typeof answer !== "string" || !/^0x[0-9a-fA-F]+$/.test(answer)) {
    throw new TokenError(
      `eth_getBalance answered ${JSON.stringify(answer)}, which is not a quantity — a balance is at least 0x0, and "0x" is an absent answer rather than a zero one`,
    );
  }
  return BigInt(answer);
}

/** The native balance inside the batch, via Multicall3's own `getEthBalance`. */
export function nativeBalanceCall(key: string, account: string, multicall: string): BatchCall {
  return {
    key,
    target: multicall,
    callData: callData(SELECTOR.getEthBalance, addressWord(account)),
  };
}

/**
 * Whether there is code at an address.
 *
 * An address with no code is not a token — it is somebody's wallet, or a
 * typo. Every `eth_call` against it answers `0x`, which a decoder reads as
 * "this token has no symbol" rather than as "this is not a token".
 */
export async function readHasCode(
  chainId: number,
  address: string,
  blockTag: string,
): Promise<{ hasCode: boolean; codeSize: number }> {
  const answer = await rpc({
    chainId,
    method: "eth_getCode",
    params: [address, checkBlockTag(blockTag)],
  });
  const hex = asHex(answer, "eth_getCode");
  const codeSize = (hex.length - 2) / 2;
  return { hasCode: codeSize > 0, codeSize };
}
