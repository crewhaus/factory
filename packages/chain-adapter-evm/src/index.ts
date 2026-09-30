/**
 * Section 47 — `chain-adapter-evm`.
 *
 * Concrete EVM JSON-RPC adapter. Implements the `ChainAdapter` contract
 * from `@crewhaus/chain-adapter-base` for any EVM-compatible chain
 * (Ethereum, Base, Arbitrum, Optimism, Polygon, …). Dispatches
 * read-only methods against the configured `rpcUrls`, applies the
 * `rpcPolicy` (single / fallback / quorum), classifies every response
 * via the §41 boundary classifier with `origin: "chain"`, and decodes
 * standard JSON-RPC envelopes.
 *
 * Catalog layer: R5 (protocol hosts). Slice 0 surface = reads only;
 * sends and signs land in slice 1 with `wallet-engine`.
 */
import {
  type ChainAdapter,
  type ChainAdapterConfig,
  ChainAdapterError,
  type RpcReadOptions,
  assertReadOnlyMethod,
  classifyChainPayload,
  orderRpcUrls,
} from "@crewhaus/chain-adapter-base";
import { readResponseBounded, withRawBody } from "@crewhaus/tool-safety/streams";

/**
 * A read's deadline when the caller names none: across every URL it tries,
 * so a fallback list cannot multiply it. Under `fallback` each URL has a
 * share of it before the next is asked too (see {@link fallbackDispatch});
 * under `quorum` the voters that answered in time decide.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * The most bytes of a JSON-RPC response this reads, decoded. A large
 * eth_getLogs or Multicall3 answer runs to megabytes; nothing a node should
 * send runs to more, and a body is held in memory whole.
 */
export const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: ReadonlyArray<unknown>;
};

type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: number; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0";
      readonly id: number;
      readonly error: { readonly code: number; readonly message: string };
    };

/**
 * Construct an EVM adapter. The optional `fetchImpl` argument exists
 * for tests — production callers omit it and the adapter uses the
 * global `fetch`. The adapter is stateless; create it once at boot
 * and reuse across requests.
 */
export function createEvmAdapter(
  config: ChainAdapterConfig,
  fetchImpl: typeof fetch = fetch,
): ChainAdapter {
  let nextId = 1;

  return {
    chainId: config.chainId,
    config,

    async rpcRead(
      method: string,
      params: ReadonlyArray<unknown>,
      opts?: RpcReadOptions,
    ): Promise<unknown> {
      assertReadOnlyMethod(config.chainId, method);
      const urls = orderRpcUrls(config.rpcUrls, config.rpcPolicy);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new ChainAdapterError(
          config.chainId,
          method,
          `timeoutMs ${timeoutMs} is not a duration`,
        );
      }
      const deadline = AbortSignal.timeout(timeoutMs);
      const call: Dispatch = {
        chainId: config.chainId,
        method,
        params,
        fetchImpl,
        id: nextId++,
        signal: opts?.signal === undefined ? deadline : AbortSignal.any([opts.signal, deadline]),
        timeoutMs,
        deadlineAt: Date.now() + timeoutMs,
        callerCancelled: () => opts?.signal?.aborted === true,
        cancelled: () =>
          opts?.signal?.aborted === true
            ? "the read was cancelled"
            : deadline.aborted
              ? `no answer within ${timeoutMs} ms`
              : undefined,
        ...(opts?.bypassCache !== undefined ? { bypassCache: opts.bypassCache } : {}),
      };
      if (config.rpcPolicy === "quorum") return quorumDispatch(urls, call);
      // "single" was reduced to one URL by orderRpcUrls; "fallback"
      // iterates the full list and stops on the first success.
      return fallbackDispatch(urls, call);
    },
  };
}

/**
 * One adapter per declared chain, keyed by chain id — what a bundle builds
 * from the spec's `chains` block at boot, and what every chain-reading tool
 * package binds its seam to. Each RPC URL must be an absolute http(s) URL; a
 * refusal names the position, never the URL, whose path is where a provider
 * keeps its key.
 */
export function createEvmAdapters(
  chains: ReadonlyArray<ChainAdapterConfig>,
): ReadonlyMap<string, ChainAdapter> {
  const out = new Map<string, ChainAdapter>();
  chains.forEach((chain, i) => {
    if (chain.rpcUrls.length === 0) {
      throw new ChainAdapterError(chain.chainId, "boot", `chains[${i}] has no rpcUrls`);
    }
    chain.rpcUrls.forEach((raw, j) => {
      let url: URL | undefined;
      try {
        url = new URL(raw);
      } catch {
        url = undefined;
      }
      if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
        throw new ChainAdapterError(
          chain.chainId,
          "boot",
          `chains[${i}].rpcUrls[${j}] is not an absolute http(s) URL`,
        );
      }
    });
    if (out.has(chain.chainId)) {
      throw new ChainAdapterError(
        chain.chainId,
        "boot",
        `chains[${i}] repeats chain id "${chain.chainId}"`,
      );
    }
    out.set(chain.chainId, createEvmAdapter(chain));
  });
  return out;
}

/**
 * An RPC endpoint as a message may name it: scheme, host and port. Providers
 * put the API key in the path (`/v2/<key>`), and an error travels into tool
 * results and transcripts.
 */
function endpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "the RPC endpoint";
  }
}

/** One read, as every URL it is sent to sees it. */
type Dispatch = {
  readonly chainId: string;
  readonly method: string;
  readonly params: ReadonlyArray<unknown>;
  readonly fetchImpl: typeof fetch;
  readonly id: number;
  /** The caller's signal and the read's deadline, together. */
  readonly signal: AbortSignal;
  /** The read's whole budget, and when (epoch ms) it runs out. */
  readonly timeoutMs: number;
  readonly deadlineAt: number;
  /** True once the CALLER cancelled — as opposed to the deadline passing. */
  readonly callerCancelled: () => boolean;
  /** Why the read was stopped, once it was; undefined while it may go on. */
  readonly cancelled: () => string | undefined;
  readonly bypassCache?: boolean;
};

/** One URL's attempt: the read's signal, plus its own, so a settled read closes the rest. */
function attemptOn(call: Dispatch): { readonly call: Dispatch; readonly stop: () => void } {
  const own = new AbortController();
  return {
    call: { ...call, signal: AbortSignal.any([call.signal, own.signal]) },
    stop: () => own.abort(),
  };
}

/**
 * `fallback`: the URLs in order, each with a share of the read's deadline.
 *
 * The next URL is asked when the one before it fails — or has not answered
 * within its share (what is left of the deadline, split among the URLs not
 * yet asked). A slow URL is not dropped when that happens: it keeps its
 * chance, the first answer from either wins, and the rest are closed. So a
 * primary that stalls cannot spend the whole deadline and leave a healthy
 * secondary unasked, and a primary that is merely slow still answers.
 * The read's own deadline and the caller's cancel end every attempt.
 */
function fallbackDispatch(urls: readonly string[], call: Dispatch): Promise<unknown> {
  const { chainId, method } = call;
  return new Promise<unknown>((resolve, reject) => {
    const stops: Array<() => void> = [];
    let next = 0;
    let pending = 0;
    let done = false;
    let lastError: unknown;
    let hedge: ReturnType<typeof setTimeout> | undefined;
    /** Settle once, closing every attempt still out — all but `winner`, whose answer this is. */
    const finish = (settle: () => void, winner?: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(hedge);
      call.signal.removeEventListener("abort", onStop);
      for (const stop of stops) if (stop !== winner) stop();
      settle();
    };
    const onStop = (): void =>
      finish(() =>
        reject(
          new ChainAdapterError(
            chainId,
            method,
            call.cancelled() ?? "the read was stopped",
            undefined,
            { timedOut: !call.callerCancelled() },
          ),
        ),
      );
    const launch = (): void => {
      clearTimeout(hedge);
      if (done || next >= urls.length) return;
      const url = urls[next++] as string;
      const attempt = attemptOn(call);
      stops.push(attempt.stop);
      pending++;
      dispatchOne(url, attempt.call).then(
        (value) => finish(() => resolve(value), attempt.stop),
        (err: unknown) => {
          pending--;
          lastError = err;
          if (done) return;
          if (call.cancelled() !== undefined) {
            onStop();
            return;
          }
          if (next < urls.length) launch();
          else if (pending === 0) {
            finish(() =>
              reject(
                new ChainAdapterError(
                  chainId,
                  method,
                  `all ${urls.length} RPC URL(s) failed`,
                  lastError,
                ),
              ),
            );
          }
        },
      );
      if (next < urls.length) {
        // This URL's share: what is left, split among it and those after it.
        const share = Math.max(0, call.deadlineAt - Date.now()) / (urls.length - next + 1);
        hedge = setTimeout(launch, share);
      }
    };
    if (call.signal.aborted) {
      onStop();
      return;
    }
    call.signal.addEventListener("abort", onStop, { once: true });
    launch();
  });
}

/**
 * `quorum`: every URL at once, and the answer is the value a strict majority
 * of them returned — as soon as it has one, so a slow voter does not hold an
 * agreed answer back, and is closed. A voter that fails, or has not answered
 * when the deadline passes, counts as not agreeing; the read fails when no
 * value can reach the threshold any more. The caller's cancel ends it
 * outright.
 */
function quorumDispatch(urls: readonly string[], call: Dispatch): Promise<unknown> {
  const { chainId, method } = call;
  const threshold = Math.floor(urls.length / 2) + 1;
  return new Promise<unknown>((resolve, reject) => {
    const stops: Array<() => void> = [];
    // Compared by JSON serialization, so structural equality is bit-exact.
    const counts = new Map<string, { readonly value: unknown; n: number }>();
    let answered = 0;
    let settled = 0;
    let done = false;
    /** Settle once, closing every voter still out — all but `winner`, whose answer this is. */
    const finish = (settle: () => void, winner?: () => void): void => {
      if (done) return;
      done = true;
      call.signal.removeEventListener("abort", onStop);
      for (const stop of stops) if (stop !== winner) stop();
      settle();
    };
    const fail = (why: string, timedOut = false): void =>
      finish(() => reject(new ChainAdapterError(chainId, method, why, undefined, { timedOut })));
    const noQuorum = (): string =>
      answered === 0
        ? "quorum failed: every RPC URL rejected"
        : `quorum failed: no value reached threshold ${threshold}/${urls.length}`;
    const onStop = (): void => {
      if (call.callerCancelled()) {
        fail("the read was cancelled");
        return;
      }
      fail(
        answered === 0
          ? `no answer within ${call.timeoutMs} ms`
          : `${noQuorum()} — ${answered} of ${urls.length} answered within ${call.timeoutMs} ms`,
        true,
      );
    };
    /** Settle once no value can reach the threshold with the voters still out. */
    const decideIfLost = (): void => {
      const best = Math.max(0, ...[...counts.values()].map((c) => c.n));
      if (best + (urls.length - settled) < threshold) fail(noQuorum());
    };
    if (call.signal.aborted) {
      onStop();
      return;
    }
    call.signal.addEventListener("abort", onStop, { once: true });
    for (const url of urls) {
      const attempt = attemptOn(call);
      stops.push(attempt.stop);
      dispatchOne(url, attempt.call).then(
        (value) => {
          if (done) return;
          settled++;
          answered++;
          const key = JSON.stringify(value);
          const tally = counts.get(key) ?? { value, n: 0 };
          tally.n += 1;
          counts.set(key, tally);
          if (tally.n >= threshold) {
            finish(() => resolve(tally.value), attempt.stop);
            return;
          }
          decideIfLost();
        },
        () => {
          if (done) return;
          settled++;
          decideIfLost();
        },
      );
    }
  });
}

async function dispatchOne(url: string, call: Dispatch): Promise<unknown> {
  const { chainId, method, params, id } = call;
  const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  let res: Response;
  try {
    // The body stays encoded until the bounded reader decodes it, so a
    // compressed answer cannot inflate past the cap before it is counted.
    res = await call.fetchImpl(
      url,
      withRawBody({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: call.signal,
      }) as RequestInit,
    );
  } catch (err) {
    // No `cause`: a dialler's error can quote the URL it failed on, and a
    // provider keeps its key in the URL's path.
    const message = (err as Error).message.split(url).join(endpointLabel(url));
    throw new ChainAdapterError(chainId, method, `network error: ${message}`);
  }
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // already closed
    }
    throw new ChainAdapterError(chainId, method, `HTTP ${res.status} from ${endpointLabel(url)}`);
  }
  const read = await readResponseBounded(res, {
    maxBytes: MAX_RPC_RESPONSE_BYTES,
    signal: call.signal,
  });
  if (!read.ok) {
    throw new ChainAdapterError(
      chainId,
      method,
      `the response from ${endpointLabel(url)} could not be read: ${read.code === "aborted" ? (call.cancelled() ?? "the read was stopped") : read.reason}`,
    );
  }
  if (read.truncated) {
    // Parsing a prefix is not an option — half a JSON-RPC answer is either
    // an error or, worse, a shorter plausible one.
    throw new ChainAdapterError(
      chainId,
      method,
      `the response from ${endpointLabel(url)} is larger than ${MAX_RPC_RESPONSE_BYTES} bytes — refusing to read it`,
    );
  }
  const text = read.text;

  // Pillar 3: classify the raw response BEFORE parsing. The classifier
  // operates on text — JSON-RPC error messages, decoded log strings,
  // and any other vector through which an attacker could plant a
  // malicious payload all hit the classifier first.
  const boundary = await classifyChainPayload(text, {
    ...(call.bypassCache !== undefined ? { bypassCache: call.bypassCache } : {}),
  });
  if (boundary.action === "redact") {
    // The verbatim node response is suspected of carrying an injection
    // payload — refuse to bubble it up. The caller sees an error
    // rather than a redaction-string masquerading as data.
    throw new ChainAdapterError(
      chainId,
      method,
      "response from RPC node was classified malicious and refused",
    );
  }

  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(text) as JsonRpcResponse;
  } catch (err) {
    throw new ChainAdapterError(chainId, method, "response was not valid JSON", err);
  }
  if ("error" in parsed) {
    throw new ChainAdapterError(
      chainId,
      method,
      `RPC error ${parsed.error.code}: ${parsed.error.message}`,
    );
  }
  return parsed.result;
}
