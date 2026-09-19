/**
 * Shaping an `eth_simulateV1` bundle, and reading the two different answers
 * a node can give back.
 *
 * The honest-degradation rule lives here. `eth_simulateV1` runs an ordered
 * list of calls against one block WITH the state each call leaves behind
 * visible to the next — that chaining is the entire question a bundle asks.
 * `eth_call` cannot do it. Every call an `eth_call` fallback makes starts
 * from the same unmodified block, so "approve then swap" becomes "approve,
 * and separately, a swap against a block where the approval never happened",
 * which reverts or, worse, does not.
 *
 * So the fallback answers a DIFFERENT question and says so: `mode` names the
 * mechanism, `chained` is false, and the effects a chained run would have
 * produced — logs, balance deltas — are not present at all. Emitting the
 * subset that happens to be computable is the failure mode worth designing
 * against: a policy gate reading `logs: []` cannot tell "no events" from
 * "events were not observable", and the first reading is a green light.
 */
import { decodeRevertData } from "@crewhaus/tool-onchain";
import type { RevertReason } from "@crewhaus/tool-onchain";
import { data as asData, optionalQuantity, quantity } from "./hex";
import { ChainCallError, rpcError } from "./rpc";

/** One call in a bundle. No signature, no nonce, no key: nothing is sent. */
export type SimCall = {
  readonly from?: string;
  readonly to: string;
  readonly data?: string;
  /** Native value in wei, as a decimal string. */
  readonly value?: string;
  /** Gas cap for this call, as a decimal string. */
  readonly gas?: string;
};

export type SimLog = {
  readonly address: string;
  readonly topics: ReadonlyArray<string>;
  readonly data: string;
};

export type SimCallResult = {
  readonly index: number;
  readonly status: "success" | "reverted";
  /** Absent when the node returned no gas figure. Never defaulted to "0". */
  readonly gasUsed?: string;
  readonly returnData: string;
  readonly revert?: RevertReason;
  /**
   * Present only when the node returned a log list for this call, and only in
   * `eth_simulateV1` mode. An empty array means "this call emitted nothing";
   * the key being ABSENT means the node did not report logs at all, which is
   * a different fact and must not be collapsed into the first one.
   */
  readonly logs?: ReadonlyArray<SimLog>;
  /** The node's own message for a call that failed before execution. */
  readonly error?: string;
};

/** Turn a decimal-string amount into the wire's hex quantity. */
function toWireQuantity(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text)) {
    throw new ChainCallError(
      `${what} must be a decimal integer string, got ${JSON.stringify(value)}`,
    );
  }
  return `0x${BigInt(text).toString(16)}`;
}

/** The wire object for one call, with absent fields omitted rather than nulled. */
export function toWireCall(call: SimCall, index: number): Record<string, unknown> {
  const value = toWireQuantity(call.value, `calls[${index}].value`);
  const gas = toWireQuantity(call.gas, `calls[${index}].gas`);
  return {
    to: call.to,
    ...(call.from !== undefined ? { from: call.from } : {}),
    ...(call.data !== undefined ? { input: asData(call.data, `calls[${index}].data`) } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(gas !== undefined ? { gas } : {}),
  };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChainCallError(`${what}: expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

export type SimulatedBlock = {
  readonly blockNumber: string;
  readonly calls: ReadonlyArray<SimCallResult>;
};

/**
 * Read the one block `eth_simulateV1` returns for a one-block bundle.
 *
 * The call count is checked before anything is read out of it, for the same
 * reason a Multicall3 blob's count is: results are positional, and a node
 * that returned fewer than were sent would otherwise have every later result
 * attributed to the wrong call.
 */
export function parseSimulateV1(raw: unknown, expectedCalls: number): SimulatedBlock {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ChainCallError(
      `eth_simulateV1 returned ${Array.isArray(raw) ? "no blocks" : "something that is not a list of blocks"}`,
    );
  }
  if (raw.length > 1) {
    throw new ChainCallError(
      `eth_simulateV1 returned ${raw.length} blocks for a one-block bundle — refusing to guess which one holds the answer`,
    );
  }
  const block = asRecord(raw[0], "eth_simulateV1's block");
  const calls = block["calls"];
  if (!Array.isArray(calls)) {
    throw new ChainCallError("eth_simulateV1's block carries no call results");
  }
  if (calls.length !== expectedCalls) {
    throw new ChainCallError(
      `eth_simulateV1 returned ${calls.length} result(s) for ${expectedCalls} call(s) — refusing to pair them up, because results are matched by position and nothing in them names the call they answer`,
    );
  }

  return {
    blockNumber: quantity(block["number"], "the simulated block's number").toString(),
    calls: calls.map((entry, index) => readCallResult(entry, index)),
  };
}

function readCallResult(entry: unknown, index: number): SimCallResult {
  const record = asRecord(entry, `eth_simulateV1's result for call ${index}`);
  const returnData = asData(
    record["returnData"] ?? "0x",
    `eth_simulateV1's returnData for call ${index}`,
  );
  const status = optionalQuantity(record["status"], `the status of call ${index}`);
  if (status === undefined && record["error"] === undefined) {
    // An outcome nobody reported is not an outcome that held. Defaulting to
    // "success" here is how a bundle whose result the node never stated walks
    // through a gate that only reads `status`.
    throw new ChainCallError(
      `eth_simulateV1 returned a result for call ${index} carrying neither a status nor an error, so this node did not say whether the call succeeded. Reading that as a success would turn an answer nobody gave into a green light, so the bundle is refused instead.`,
    );
  }
  const failed = status === undefined ? true : status === 0n;
  const gasUsed = optionalQuantity(record["gasUsed"], `gasUsed on call ${index}`);
  const rawLogs = record["logs"];
  // Absence, not emptiness — the same rule the eth_call fallback keeps. A node
  // that returned no log list for this call did not say the call emitted
  // nothing; `logs: []` is the one reading a policy gate acts on and is wrong
  // about, so the key is left off entirely and the caller is told why.
  const logs = Array.isArray(rawLogs) ? rawLogs.map((log, i) => readLog(log, index, i)) : undefined;
  const nodeError = asRecord(record["error"] ?? {}, `the error on call ${index}`)["message"];

  return {
    index,
    status: failed ? "reverted" : "success",
    // A chain quantity the node did not report stays absent. "0" is a gas
    // figure, and a call that looks free is a call somebody will believe is.
    ...(gasUsed !== undefined ? { gasUsed: gasUsed.toString() } : {}),
    returnData,
    // A revert's bytes are the returnData: `Error(string)`, a `Panic`, or a
    // custom error's selector. `decodeRevertData` keeps the hex when it
    // cannot read them rather than inventing a message.
    ...(failed ? { revert: decodeRevertData(returnData) } : {}),
    ...(logs !== undefined ? { logs } : {}),
    ...(typeof nodeError === "string" ? { error: nodeError } : {}),
  };
}

function readLog(entry: unknown, callIndex: number, logIndex: number): SimLog {
  const record = asRecord(entry, `log ${logIndex} of call ${callIndex}`);
  const topics = record["topics"];
  return {
    address: String(record["address"] ?? ""),
    topics: Array.isArray(topics) ? topics.map((t) => String(t)) : [],
    data: asData(record["data"] ?? "0x", `log ${logIndex} of call ${callIndex}`),
  };
}

/**
 * Read an `eth_call` refusal as a revert when it carries revert bytes.
 *
 * Geth-family nodes answer a reverted `eth_call` with error code 3 and the
 * revert data in `error.data`. Everything else — a bad parameter, a node
 * that cannot serve the block — has no such bytes, and is not a revert.
 */
export function revertFromCallError(err: unknown): RevertReason | undefined {
  const { data: payload } = rpcError(err);
  if (typeof payload !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(payload)) return undefined;
  return decodeRevertData(payload);
}

/**
 * The chaining limitation, worded for what the fallback actually did.
 *
 * "Every call was evaluated against the same unmodified block" is only true
 * when the calls carried a block NUMBER. Sending a tag once per call lets the
 * head move between them, which is the same silent inconsistency `EvmMulticall`
 * refuses to produce — so when the height could not be pinned the sentence
 * says that instead of asserting a block they may not share.
 */
export function unchainedLimitation(pinnedBlock: string | null): string {
  return pinnedBlock === null
    ? "state is NOT chained, AND these calls do not even share a block: the block tag could not be resolved to a height, so each eth_call resolved it on its own and the head may have moved between them"
    : `state is NOT chained: every call was evaluated against block ${pinnedBlock}, unmodified, so a call that depends on an earlier call's effect (an approval before a transfer, a deposit before a withdraw) did not see it`;
}

/** What a fallback result is missing, said in full rather than implied. */
export const FALLBACK_LIMITATIONS: ReadonlyArray<string> = Object.freeze([
  "logs are omitted entirely rather than reported per call — an eth_call answers with return data only, and an empty log list would read as 'this emitted no events'",
  "balance deltas are omitted entirely — without chaining there is no after-state to difference against",
  "gas is per call against the unmodified block, so the figures do not add up to what the sequence would cost",
]);
