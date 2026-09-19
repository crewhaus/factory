/**
 * Recorded node shapes, and a transport that serves them.
 *
 * Nothing in this package's suite opens a socket. Every test installs one of
 * these through `_setRpc`, so the suite runs identically on a CI box with no
 * egress and never depends on somebody else's rate limit or on a public
 * endpoint being up.
 *
 * The return blobs are built with `@crewhaus/tool-onchain`'s real encoder
 * rather than pasted as hex. A hand-typed `(bool,bytes)[]` with a plausible
 * offset in it would make the decoder's own correctness untestable here: the
 * fixture and the bug would agree.
 */
import { abiEncodeCall } from "@crewhaus/tool-onchain";
import { KNOWN_INTERFACES } from "./lib/proxy";
import type { ChainRpc } from "./lib/rpc";

/** A 32-byte word holding an unsigned integer. */
export function word(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

/** A 32-byte word holding an address in its low 20 bytes. */
export function addressWord(address: string): string {
  return `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

/** A 32-byte word that is not an address: the top bytes are dirty. */
export const NON_ADDRESS_WORD =
  "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bec8";

export const ZERO_WORD = word(0);

/**
 * ABI-encode what `aggregate3` returns, through the real encoder.
 *
 * The trick is to encode a call taking exactly that argument and drop the
 * four-byte selector: the remaining bytes are the argument's encoding, which
 * is what a node hands back.
 */
export async function aggregate3Return(
  rows: ReadonlyArray<readonly [boolean, string]>,
): Promise<string> {
  const result = await abiEncodeCall.execute({
    signature: "fixture((bool,bytes)[])",
    args: [rows.map(([ok, data]) => [ok, data])],
  });
  if (typeof result !== "string") throw new Error("the encoder returned non-text content");
  const { data } = JSON.parse(result) as { data: string };
  return `0x${data.slice(10)}`;
}

/** `Error(string)` revert bytes for a given message, through the real encoder. */
export async function errorStringRevert(message: string): Promise<string> {
  const result = await abiEncodeCall.execute({ signature: "Error(string)", args: [message] });
  if (typeof result !== "string") throw new Error("the encoder returned non-text content");
  return (JSON.parse(result) as { data: string }).data;
}

/** The canonical EIP-1167 runtime bytecode delegating to `target`. */
export function minimalProxyCode(target: string): string {
  return `0x363d3d373d3d3d363d73${target.replace(/^0x/, "").toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

// ---------------------------------------------------------------------------
// the transport stub
// ---------------------------------------------------------------------------

/** A JSON-RPC error as a provider throws it: an Error carrying `code`. */
export function jsonRpcError(code: number, message: string, data?: unknown): Error {
  const err = new Error(message) as Error & { code: number; data?: unknown };
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

/** What a node says about a method it has never heard of. */
export function methodNotFound(method: string): Error {
  return jsonRpcError(-32601, `the method ${method} does not exist/is not available`);
}

export type RpcHandler = (
  params: ReadonlyArray<unknown>,
  call: number,
) => unknown | Promise<unknown>;

export type RpcStub = {
  readonly rpc: ChainRpc;
  /** Every dispatch, in order. The "nothing sends" test reads this. */
  readonly calls: Array<{ method: string; params: ReadonlyArray<unknown> }>;
  /** How many times one method was dispatched. */
  count(method: string): number;
};

/**
 * A transport built from a table of handlers.
 *
 * An unhandled method answers -32601, which is what a real node does and is
 * also the one failure this package degrades on — so a test that forgets a
 * handler exercises the degradation path loudly rather than hanging.
 */
export function rpcStub(handlers: Readonly<Record<string, RpcHandler>>): RpcStub {
  const calls: Array<{ method: string; params: ReadonlyArray<unknown> }> = [];
  const perMethod = new Map<string, number>();
  const rpc: ChainRpc = async (method, params) => {
    calls.push({ method, params });
    const seen = perMethod.get(method) ?? 0;
    perMethod.set(method, seen + 1);
    const handler = handlers[method];
    if (handler === undefined) throw methodNotFound(method);
    return handler(params, seen);
  };
  return { rpc, calls, count: (method) => perMethod.get(method) ?? 0 };
}

/** Serve a different blob to each successive `eth_call`, in order. */
export function sequentialCalls(blobs: ReadonlyArray<string>): RpcHandler {
  return (_params, index) => {
    const blob = blobs[index];
    if (blob === undefined) throw new Error(`the stub has no eth_call blob #${index}`);
    return blob;
  };
}

// ---------------------------------------------------------------------------
// ContractInspect shapes
// ---------------------------------------------------------------------------

export type InspectViews = {
  /** What supportsInterface(0xffffffff) answers. A compliant contract: false. */
  readonly sentinel?: boolean | "revert";
  /** Interface ids the contract claims. */
  readonly supports?: ReadonlyArray<string>;
  /** What implementation() answers, when it answers. */
  readonly implementationView?: string;
  /** Whether proxiableUUID() answers at all. */
  readonly proxiable?: boolean;
  /** Present only when the beacon slot is set: the beacon's implementation(). */
  readonly beaconImplementation?: string | "revert";
};

/**
 * The view rows `ContractInspect` expects, in the order it builds them:
 * the 0xffffffff sentinel, one row per probed interface id, implementation(),
 * proxiableUUID(), and the beacon's implementation() when there is a beacon.
 */
export function inspectViewRows(spec: InspectViews): Array<readonly [boolean, string]> {
  const claimed = new Set((spec.supports ?? []).map((id) => id.toLowerCase()));
  const boolRow = (value: boolean): readonly [boolean, string] => [true, word(value ? 1 : 0)];
  const revertRow: readonly [boolean, string] = [false, "0x"];

  const rows: Array<readonly [boolean, string]> = [
    spec.sentinel === "revert" ? revertRow : boolRow(spec.sentinel ?? false),
    ...KNOWN_INTERFACES.map((i) =>
      spec.sentinel === "revert" ? revertRow : boolRow(claimed.has(i.id.toLowerCase())),
    ),
    spec.implementationView === undefined
      ? revertRow
      : [true, addressWord(spec.implementationView)],
    spec.proxiable === true ? [true, word(1)] : revertRow,
  ];
  if (spec.beaconImplementation !== undefined) {
    rows.push(
      spec.beaconImplementation === "revert"
        ? revertRow
        : [true, addressWord(spec.beaconImplementation)],
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// eth_simulateV1 shapes
// ---------------------------------------------------------------------------

export type SimulatedCall = {
  readonly returnData?: string;
  readonly gasUsed?: number;
  readonly status?: 0 | 1;
  readonly logs?: ReadonlyArray<{ address: string; topics: string[]; data: string }>;
  readonly error?: { code: number; message: string };
};

/** One block of `eth_simulateV1` output. */
export function simulateV1Result(
  blockNumber: number,
  calls: ReadonlyArray<SimulatedCall>,
): unknown {
  return [
    {
      number: `0x${blockNumber.toString(16)}`,
      gasLimit: "0x1c9c380",
      gasUsed: "0x5208",
      calls: calls.map((call) => ({
        returnData: call.returnData ?? "0x",
        gasUsed: `0x${(call.gasUsed ?? 21_000).toString(16)}`,
        status: `0x${(call.status ?? 1).toString(16)}`,
        logs: call.logs ?? [],
        ...(call.error !== undefined ? { error: call.error } : {}),
      })),
    },
  ];
}

/**
 * One block of `eth_simulateV1` output with the call objects passed through
 * VERBATIM.
 *
 * `simulateV1Result` fills in `status`, `gasUsed` and `logs` for every call,
 * which makes the case worth testing — a node that leaves one of them out —
 * inexpressible. A fixture that cannot express a shape hides every bug that
 * shape causes.
 */
export function simulateV1Raw(
  blockNumber: number,
  calls: ReadonlyArray<Record<string, unknown>>,
): unknown {
  return [
    {
      number: `0x${blockNumber.toString(16)}`,
      gasLimit: "0x1c9c380",
      gasUsed: "0x5208",
      calls,
    },
  ];
}

/** An ERC-20 Transfer log, the shape a simulation returns them in. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function transferLog(
  token: string,
  from: string,
  to: string,
  amount: bigint,
): {
  address: string;
  topics: string[];
  data: string;
} {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, addressWord(from), addressWord(to)],
    data: word(amount),
  };
}

// ---------------------------------------------------------------------------
// eth_feeHistory / eth_getBlockByNumber shapes
// ---------------------------------------------------------------------------

export type BlockFixture = {
  readonly number: number;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
  readonly baseFeePerGas?: bigint;
};

export function blockResult(block: BlockFixture): unknown {
  return {
    number: `0x${block.number.toString(16)}`,
    gasUsed: `0x${block.gasUsed.toString(16)}`,
    gasLimit: `0x${block.gasLimit.toString(16)}`,
    ...(block.baseFeePerGas === undefined
      ? {}
      : { baseFeePerGas: `0x${block.baseFeePerGas.toString(16)}` }),
    hash: "0x00000000000000000000000000000000000000000000000000000000000000aa",
  };
}

export type FeeHistoryFixture = {
  readonly oldestBlock: number;
  /** blockCount + 1 entries: the last is the NEXT block's base fee. */
  readonly baseFeePerGas: ReadonlyArray<bigint>;
  readonly reward?: ReadonlyArray<ReadonlyArray<bigint>>;
  readonly baseFeePerBlobGas?: ReadonlyArray<bigint>;
};

export function feeHistoryResult(history: FeeHistoryFixture): unknown {
  const hex = (v: bigint): string => `0x${v.toString(16)}`;
  return {
    oldestBlock: `0x${history.oldestBlock.toString(16)}`,
    baseFeePerGas: history.baseFeePerGas.map(hex),
    // A float on purpose: this is what the wire carries, and the projection
    // must be proven not to use it.
    gasUsedRatio: history.baseFeePerGas.slice(0, -1).map(() => 0.5123456789),
    ...(history.reward === undefined ? {} : { reward: history.reward.map((row) => row.map(hex)) }),
    ...(history.baseFeePerBlobGas === undefined
      ? {}
      : { baseFeePerBlobGas: history.baseFeePerBlobGas.map(hex) }),
  };
}

// ---------------------------------------------------------------------------
// addresses used across the suite
// ---------------------------------------------------------------------------

export const ADDR = Object.freeze({
  proxy: "0x1111111111111111111111111111111111111111",
  implementation: "0x2222222222222222222222222222222222222222",
  admin: "0x3333333333333333333333333333333333333333",
  beacon: "0x4444444444444444444444444444444444444444",
  other: "0x5555555555555555555555555555555555555555",
  token: "0x6666666666666666666666666666666666666666",
  wallet: "0x7777777777777777777777777777777777777777",
});
