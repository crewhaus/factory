/**
 * The one place this package talks to a chain, and the gate it talks through.
 *
 * Every JSON-RPC method dispatched from anywhere in this package passes
 * `assertReadOnlyMethod` from `@crewhaus/chain-adapter-base` FIRST. That
 * allowlist is the repo's existing statement of what a read is, and putting
 * it at this chokepoint means a bug three files away cannot dispatch
 * `eth_sendRawTransaction` — it would have to get past a check it never
 * sees. Nothing here signs, and there is nowhere to put a key.
 *
 * The seam is `ChainRpc`: one function, `(method, params) -> result`. It sits
 * ABOVE the dialler on purpose, the same way `tool-registry`'s does, so a
 * test that installs a stub never resolves a name, never opens a socket and
 * never needs egress. The production binding is a resolver the runtime sets
 * at boot from the spec's `chains[]` block, exactly as `@crewhaus/tool-evm`
 * does — this package holds no endpoint list of its own and there is no
 * caller-supplied URL anywhere in it.
 */
import type { ChainAdapter, ChainAdapterConfig } from "@crewhaus/chain-adapter-base";
import { CHAINS_BLOCK_EXAMPLE, assertReadOnlyMethod } from "@crewhaus/chain-adapter-base";
import { createEvmAdapters } from "@crewhaus/chain-adapter-evm";
import { CrewhausError } from "@crewhaus/errors";

/** A refusal raised by this package: a bad input, a broken promise, a limit. */
export class ChainCallError extends CrewhausError {
  override readonly name = "ChainCallError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

/**
 * A JSON-RPC read. `params` is the wire array; the return is the wire
 * `result`, undecoded, because every caller here wants different bytes out
 * of it.
 */
export type ChainRpc = (
  method: string,
  params: ReadonlyArray<unknown>,
  opts?: { readonly signal?: AbortSignal },
) => Promise<unknown>;

/** Boot-time binding: chain id in, transport out. */
export type ChainRpcResolver = (chainId: string) => ChainRpc | undefined;

let resolver: ChainRpcResolver | undefined;

/**
 * Bind the per-chain transports at boot. A generated daemon calls this once,
 * wiring each declared chain to its adapter; `undefined` unbinds.
 */
export function setChainRpcResolver(fn: ChainRpcResolver | undefined): void {
  resolver = fn;
}

/**
 * Adapt a `ChainAdapter` into the seam, so the runtime can hand these tools
 * the same adapters `tool-evm` already gets. `rpcRead` keeps its own
 * allowlist and boundary classification; this does not replace either.
 */
export function chainRpcFromAdapter(adapter: ChainAdapter): ChainRpc {
  return (method, params) => adapter.rpcRead(method, params);
}

/**
 * Bind the transports from the spec's `chains` block — what every generated
 * bundle, `crewhaus run` and `crewhaus eval` call at boot when a spec lists
 * one of these tools. Each chain gets the adapter `tool-evm` gets.
 */
export function bindChainCallChains(config: {
  readonly chains: ReadonlyArray<ChainAdapterConfig>;
}): void {
  const adapters = createEvmAdapters(config.chains);
  setChainRpcResolver((chainId) => {
    const adapter = adapters.get(chainId);
    return adapter === undefined ? undefined : chainRpcFromAdapter(adapter);
  });
}

/**
 * Test-only injection point, the convention every networked package here
 * follows: one transport for every chain id. `undefined` unbinds, and a
 * suite that sets it must restore it, or the next file in the same bun
 * process inherits a stub.
 */
export function _setRpc(fn: ChainRpc | undefined): void {
  resolver = fn === undefined ? undefined : () => fn;
}

/** Find the transport for a chain, or say what the operator has to wire. */
export function resolveRpc(chainId: string, toolName: string): ChainRpc {
  if (resolver === undefined) {
    throw new ChainCallError(
      `${toolName}: no chain is configured. Declare one in the spec — ${CHAINS_BLOCK_EXAMPLE}.`,
    );
  }
  const rpc = resolver(chainId);
  if (rpc === undefined) {
    throw new ChainCallError(
      `${toolName}: no chain is configured for chainId "${chainId}" — declare it in spec.chains[]`,
    );
  }
  return rpc;
}

/** The rejection a cancelled read produces. `isAbort` recognises it. */
function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : "the read was cancelled";
  return Object.assign(new Error(message), { name: "AbortError" });
}

/**
 * Dispatch one read.
 *
 * The allowlist check is here rather than at each call site because a check
 * you have to remember is a check that gets forgotten. `assertReadOnlyMethod`
 * throws a `ChainAdapterError`, which is deliberately NOT rewrapped: a
 * write-class method reaching this line is a defect in this package and
 * should arrive at the log looking like one.
 *
 * The signal is both passed down AND raced against. `ChainAdapter.rpcRead`
 * takes no signal, so a transport built on one cannot be cancelled — and a
 * `timeoutMs` that bounds nothing is a promise this package should not be
 * making. Racing means the TOOL returns on time; the request underneath it
 * may still be in flight, which is the honest limit of a seam whose other
 * side does not accept a signal.
 */
export async function rpcRead(
  rpc: ChainRpc,
  chainId: string,
  method: string,
  params: ReadonlyArray<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  assertReadOnlyMethod(chainId, method);
  // Checked before dispatch, not after: a cancelled run should not be the
  // reason a node sees one more request.
  if (signal?.aborted === true) throw abortError(signal);
  const call = rpc(method, params, signal === undefined ? {} : { signal });
  if (signal === undefined) return call;

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// reading a node's refusal
// ---------------------------------------------------------------------------

/** The JSON-RPC error object, as much of it as a thrown value tends to carry. */
export type RpcErrorShape = {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Pull the JSON-RPC error out of whatever the transport threw. Providers
 * differ: some throw the error object, some an `Error` with `.code` and
 * `.data` attached, some an `Error` wrapping one under `.cause` or `.error`.
 */
export function rpcError(err: unknown): RpcErrorShape {
  const seen = new Set<unknown>();
  let node: unknown = err;
  for (let depth = 0; depth < 4 && node !== undefined && node !== null; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    const record = asRecord(node);
    if (record === undefined) break;
    const code = record["code"];
    const message = record["message"];
    if (typeof code === "number") {
      return {
        code,
        ...(typeof message === "string" ? { message } : {}),
        ...(record["data"] !== undefined ? { data: record["data"] } : {}),
      };
    }
    node = record["error"] ?? record["cause"];
  }
  const record = asRecord(err);
  const message = record?.["message"];
  return typeof message === "string" ? { message } : { message: String(err) };
}

/** True when the failure is the caller's or the runtime's cancellation. */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  const record = asRecord(err);
  return record?.["name"] === "AbortError" || record?.["name"] === "TimeoutError";
}

/**
 * -32601 and the strings providers use instead of it.
 *
 * This is the one predicate `EvmSimulateBundle` degrades on, so it has to be
 * narrow in both directions. A node that has never heard of `eth_simulateV1`
 * is a reason to answer a lesser question; a node that timed out, or that
 * rejected the parameters, or whose simulation reverted, is NOT — degrading
 * on those would turn a transient fault into a quietly weaker answer that
 * still looks like an answer.
 */
export function isMethodUnsupported(err: unknown, signal?: AbortSignal): boolean {
  if (isAbort(err, signal)) return false;
  const { code, message } = rpcError(err);
  // -32601 is "method not found". -32004 is the "method not supported" code
  // several providers return instead; Geth and Erigon both use -32601.
  if (code === -32601 || code === -32004) return true;
  if (code !== undefined && code !== -32000 && code !== -32601 && code !== -32004) return false;
  const text = (message ?? "").toLowerCase();
  if (text.includes("revert") || text.includes("insufficient funds")) return false;
  return (
    /\bmethod\b[^.]{0,40}\bnot (?:found|supported|available|implemented|enabled)\b/.test(text) ||
    /\bunsupported method\b/.test(text) ||
    /\bunknown method\b/.test(text) ||
    /\bdoes not exist\/is not available\b/.test(text)
  );
}

/** A one-line description of a node failure, for a refusal message. */
export function rpcErrorText(err: unknown): string {
  const { code, message } = rpcError(err);
  const text = message ?? String(err);
  return code === undefined ? text : `${text} (code ${code})`;
}

// ---------------------------------------------------------------------------
// deadlines
// ---------------------------------------------------------------------------

export type Deadline = {
  readonly signal: AbortSignal;
  /** Clear the timer. Always call it, or the process keeps a handle alive. */
  cancel(): void;
};

/**
 * A deadline that also honours the runtime's own cancellation. Every tool
 * here opens one before its first byte and cancels it in a `finally`: a tool
 * that fans out over several round trips can hang in several places.
 */
export function startDeadline(ms: number, outer?: AbortSignal): Deadline {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`deadline of ${ms}ms elapsed`)), ms);
  const onOuter = (): void => ctrl.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}
