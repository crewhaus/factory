/**
 * Multicall3 request packing and result unpacking.
 *
 * One `eth_call` against Multicall3 answers a hundred questions at one block
 * height, which is the only way to read a hundred balances that are
 * consistent with each other. The packing is where it goes wrong: the
 * argument is an array of dynamic tuples, so every element leaves an offset
 * behind — relative to the start of the array's DATA, not to the call — and
 * a wrong offset produces calldata a node accepts and the contract misreads.
 *
 * Two things this is careful about, because both are how a batch read turns
 * into a wrong number rather than an error:
 *
 *   1. **A failed sub-call is data.** With `allowFailure` set, the batch
 *      succeeds and the failed entry carries `success: false` and its revert
 *      bytes. That is different from the batch itself failing, and the two
 *      must not arrive at a caller looking the same: a sub-call revert comes
 *      back as a row, a blob this cannot read is thrown.
 *   2. **Results are matched by POSITION.** Nothing in the return blob names
 *      the call it answers. A blob holding a different number of results than
 *      the batch sent is therefore refused rather than zipped up to the
 *      shorter of the two, because a balance read against the wrong token is
 *      worse than no balance at all.
 *
 * Pure, like the rest of this package: this builds the bytes of a read and
 * reads the bytes back. It does not dial anything, and nothing here composes
 * or submits a transaction.
 */
import { type AbiValue, type Decoded, decodeData, encodeCall } from "./abi";
import { validateAddress } from "./address";

/**
 * Where Multicall3 is deployed on most chains, via a deterministic deploy.
 *
 * It is a DEFAULT, never a constant baked into the calldata path: the deploy
 * is only canonical where somebody ran it, and a chain that predates it, an
 * L2 with its own deployment, or a local fork can all have it elsewhere.
 * Every entry point here takes the address as an argument.
 */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** The canonical signature, which is what the selector is hashed over. */
export const AGGREGATE3_SIGNATURE = "aggregate3((address,bool,bytes)[])";

/** `0x82ad56cb` — the four bytes a block explorer shows for a Multicall3 batch. */
export const AGGREGATE3_SELECTOR = "0x82ad56cb";

/** What `aggregate3` returns: one `(bool success, bytes returnData)` per call. */
export const AGGREGATE3_RETURN_TYPE = "(bool,bytes)[]";

/** `Error(string)` — a `revert("...")` or a failed `require` with a message. */
export const ERROR_STRING_SELECTOR = "0x08c379a0";

/** `Panic(uint256)` — a failed `assert`, an overflow, a bad index. */
export const PANIC_SELECTOR = "0x4e487b71";

/**
 * The panic codes Solidity documents. A code outside this table decodes to a
 * code with no reason attached rather than to a guess.
 */
export const PANIC_REASONS: Readonly<Record<string, string>> = Object.freeze({
  "0x00": "a generic compiler-inserted panic",
  "0x01": "an assert argument evaluated to false",
  "0x11": "arithmetic overflowed or underflowed outside an unchecked block",
  "0x12": "division or modulo by zero",
  "0x21": "a value was converted into an enum that has no such member",
  "0x22": "a storage byte array is incorrectly encoded",
  "0x31": "pop() on an empty array",
  "0x32": "an array index is out of bounds or negative",
  "0x41": "too much memory was allocated, or an array was created too large",
  "0x51": "a zero-initialised variable of internal function type was called",
});

/** One call in a batch. */
export type Call3 = {
  /** The contract to call. */
  readonly target: string;
  /** Its calldata, 0x hex. `0x` is legal and reaches the fallback. */
  readonly callData: string;
  /**
   * Whether this call reverting is allowed to be data.
   *
   * Omitted means TRUE, which is the point of `aggregate3`: the batch still
   * succeeds and this entry carries `success: false` with its revert bytes.
   * Set it false only when this call failing should take the whole batch
   * down with it — then there are no partial results to read at all.
   */
  readonly allowFailure?: boolean;
};

/** A packed batch: what to send, and where. */
export type Aggregate3Request = {
  /** The Multicall3 address the calldata is meant for, EIP-55 checksummed. */
  readonly to: string;
  /** The calldata, 0x hex. */
  readonly data: string;
  readonly selector: string;
  /** How many results the answer must hold. Decoding checks it. */
  readonly callCount: number;
};

/** What a sub-call's revert bytes turned out to say. */
export type RevertKind = "none" | "string" | "panic" | "unknown";

export type RevertReason = {
  readonly kind: RevertKind;
  /** The decoded reason, or null when the bytes do not carry one. Never invented. */
  readonly reason: string | null;
  /** The four-byte error selector, when the data is long enough to have one. */
  readonly selector: string | null;
  /** The panic code as hex, e.g. `0x11`. Panics only. */
  readonly panicCode: string | null;
  /** The raw bytes, always, so an unrecognised custom error is still actionable. */
  readonly data: string;
};

/** One call's answer, at the position of the call that produced it. */
export type Aggregate3Result = {
  /** The index of the call in the batch that was sent. */
  readonly index: number;
  readonly success: boolean;
  /** Return data on success, revert data on failure. Both are 0x hex. */
  readonly returnData: string;
  /** The revert, decoded, when this call failed. Null when it succeeded. */
  readonly revert: RevertReason | null;
};

function checkedAddress(raw: string, what: string): string {
  const result = validateAddress(raw);
  if (!result.valid) throw new Error(`${what}: ${result.reason}`);
  return result.checksummed;
}

function checkedBytes(raw: string, what: string): string {
  const text = raw.trim();
  // An odd number of hex digits is a truncated paste, and the ABI coder would
  // otherwise report it as an argument problem several frames from here.
  if (!/^0x([0-9a-fA-F]{2})*$/.test(text)) {
    throw new Error(`${what}: expected 0x followed by an even number of hex digits, got "${raw}"`);
  }
  return text.toLowerCase();
}

/**
 * Pack a batch into `aggregate3` calldata.
 *
 * `multicall3Address` defaults to {@link MULTICALL3_ADDRESS} and is returned
 * as `to`; pass a chain's own deployment when it has one. An empty batch is
 * legal and encodes to an empty array — a caller assembling a batch from a
 * filtered list should not have to special-case the day the filter matches
 * nothing.
 */
export function encodeAggregate3(
  calls: ReadonlyArray<Call3>,
  multicall3Address: string = MULTICALL3_ADDRESS,
): Aggregate3Request {
  const to = checkedAddress(multicall3Address, "the Multicall3 address");
  const tuples: AbiValue[] = calls.map((call, i) => [
    checkedAddress(call.target, `call[${i}].target`),
    call.allowFailure ?? true,
    checkedBytes(call.callData, `call[${i}].callData`),
  ]);
  return {
    to,
    data: encodeCall(AGGREGATE3_SIGNATURE, [tuples]),
    selector: AGGREGATE3_SELECTOR,
    callCount: calls.length,
  };
}

/**
 * Decode `(bool,bytes)[]` back into per-call results, in the order sent.
 *
 * `expectedCalls` is the length of the batch that produced this blob, and a
 * mismatch throws: the results carry no identity of their own, so pairing a
 * short answer with the calls that were sent silently attributes each result
 * to the wrong call.
 *
 * A sub-call that reverted is NOT an exception — it is a row with
 * `success: false`. What throws is the batch's own answer being unreadable,
 * which is a different event with a different fix.
 */
export function decodeAggregate3(
  returnData: string,
  expectedCalls: number,
): ReadonlyArray<Aggregate3Result> {
  if (!Number.isInteger(expectedCalls) || expectedCalls < 0) {
    throw new Error(`expectedCalls must be a non-negative integer, got ${expectedCalls}`);
  }

  let rows: Decoded;
  try {
    [rows] = decodeData([AGGREGATE3_RETURN_TYPE], returnData) as [Decoded];
  } catch (err) {
    // Said as a batch-level failure on purpose: an unreadable blob means the
    // aggregate call itself did not return what Multicall3 returns — a wrong
    // address, a reverted batch, an empty answer from an address with no code
    // — and none of those are a sub-call reverting.
    throw new Error(
      `the batch's own return data is not ${AGGREGATE3_RETURN_TYPE}, so no sub-call result can be read from it: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(rows)) {
    throw new Error("the batch's own return data did not decode to an array of results");
  }
  if (rows.length !== expectedCalls) {
    throw new Error(
      `the batch returned ${rows.length} result(s) for ${expectedCalls} call(s) — refusing to pair them up, because results are matched by position and nothing in them names the call they answer`,
    );
  }

  return rows.map((row, index) => {
    const [success, bytes] = Array.isArray(row) ? row : [];
    if (typeof success !== "boolean" || typeof bytes !== "string") {
      throw new Error(`result ${index} is not a (bool, bytes) pair`);
    }
    return {
      index,
      success,
      returnData: bytes,
      revert: success ? null : decodeRevertData(bytes),
    };
  });
}

/**
 * Read revert bytes as the reason they carry.
 *
 * `Error(string)` and `Panic(uint256)` have known selectors and decode to
 * something a human can act on. Anything else — a custom error, four bytes
 * of nothing in particular — keeps its hex and gets no message: a guess at
 * what an unknown selector means is worse than the hex, because the hex is
 * at least searchable.
 */
export function decodeRevertData(revertData: string): RevertReason {
  const data = checkedBytes(revertData, "revert data");
  const byteLength = (data.length - 2) / 2;
  const plain = { reason: null, selector: null, panicCode: null, data } as const;

  // A bare `revert()`, a failed transfer to an address with no code, or a
  // call that ran out of gas all come back empty. There is no message to be
  // had, and "reverted" is not one.
  if (byteLength === 0) return { kind: "none", ...plain };
  if (byteLength < 4) return { kind: "unknown", ...plain };

  const selector = data.slice(0, 10);
  const payload = `0x${data.slice(10)}`;
  const unknown = { kind: "unknown", reason: null, selector, panicCode: null, data } as const;

  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const [message] = decodeData(["string"], payload);
      if (typeof message === "string") {
        return { kind: "string", reason: message, selector, panicCode: null, data };
      }
    } catch {
      // A payload that does not decode falls through to the hex. Throwing
      // here would lose the other results in the same batch over one
      // contract's malformed revert.
    }
    return unknown;
  }

  if (selector === PANIC_SELECTOR) {
    try {
      const [code] = decodeData(["uint256"], payload);
      if (typeof code === "string") {
        const panicCode = `0x${BigInt(code).toString(16).padStart(2, "0")}`;
        return {
          kind: "panic",
          reason: PANIC_REASONS[panicCode] ?? null,
          selector,
          panicCode,
          data,
        };
      }
    } catch {
      // As above: unreadable bytes stay bytes.
    }
    return unknown;
  }

  return unknown;
}
