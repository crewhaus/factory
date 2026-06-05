import { McpConnectionError, McpError, McpProtocolError } from "@crewhaus/errors";
import type { Logger } from "@crewhaus/logging";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { nextBackoffMs } from "./backoff.js";
import type {
  McpCallOptions,
  McpCallResult,
  McpClientState,
  McpServerConfig,
  McpToolDefinition,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const QUEUE_CAP = 16;

/**
 * Transport abstraction so tests can inject a fake without a real subprocess.
 * Aliased to the SDK's `Transport` so factory implementations satisfy
 * `Client.connect()` directly. Tests build minimal compliant fakes.
 */
export type McpClientLikeTransport = Transport;

export type McpClientOptions = {
  readonly logger?: Logger;
  /** Override the SDK Client factory (tests). */
  readonly clientFactory?: (info: { name: string; version: string }) => Client;
  /** Override the transport factory (tests). */
  readonly transportFactory?: (config: McpServerConfig) => McpClientLikeTransport;
  /** Connect timeout in ms; default 60_000. Applies to each individual attempt. */
  readonly connectTimeoutMs?: number;
  /** Per-call default timeout in ms; default 60_000. */
  readonly callTimeoutMs?: number;
  /** Override the timer scheduler (tests). */
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Optional Section 15 trace bus. When supplied, every callTool emits paired mcp_call_start/end events. */
  readonly eventBus?: TraceEventBus;
};

/**
 * Per-server MCP client. Wraps an SDK `Client` + transport with a minimal
 * connect / listTools / callTool / disconnect API and proactive reconnect.
 *
 * State machine:
 *   idle → connecting → connected
 *                ↑          ↓ (transport.onclose)
 *                └─── disconnected
 *                          ↓ (disconnect())
 *                        closed
 *
 * `closed` is terminal — a closed client never reconnects.
 *
 * In-flight `callTool` promises during a transport close reject with
 * `McpConnectionError`. New `callTool` requests during disconnect await
 * `connectedDeferred`, which resolves on the next successful reconnect (or
 * rejects if `disconnect()` is called while waiting). Queue cap = 16.
 */
export class McpClient {
  readonly name: string;
  private readonly config: McpServerConfig;
  private readonly logger: Logger | undefined;
  private readonly clientFactory: (info: { name: string; version: string }) => Client;
  private readonly transportFactory: (config: McpServerConfig) => McpClientLikeTransport;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly eventBus: TraceEventBus | undefined;

  private state: McpClientState = { kind: "idle" };
  private sdk: Client | null = null;
  private transport: McpClientLikeTransport | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private cachedTools: ReadonlyArray<McpToolDefinition> | null = null;
  private connectedDeferred: PromiseDeferred<void> = createDeferred();
  private queuedWaiters = 0;

  constructor(name: string, config: McpServerConfig, opts: McpClientOptions = {}) {
    this.name = name;
    this.config = config;
    this.logger = opts.logger;
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.transportFactory = opts.transportFactory ?? defaultTransportFactory;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.eventBus = opts.eventBus;
    // The initial connectedDeferred can sit unresolved indefinitely (until
    // first connect() or disconnect()). Attach a no-op catch so a later
    // disconnect-without-await doesn't surface as an unhandled rejection.
    void this.connectedDeferred.promise.catch(() => undefined);
  }

  getState(): McpClientState {
    return this.state;
  }

  /**
   * Establish the connection. Resolves once the SDK initialize handshake
   * completes. If already connected, returns immediately.
   */
  async connect(): Promise<void> {
    if (this.state.kind === "connected") return;
    if (this.state.kind === "closed") {
      throw new McpConnectionError(`mcp client "${this.name}" is closed`);
    }
    await this.tryConnect();
  }

  /**
   * Build transport + SDK Client, run the initialize handshake. Single
   * attempt — reconnect orchestration lives in `scheduleReconnect`.
   */
  private async tryConnect(): Promise<void> {
    const attempt = this.reconnectAttempt;
    this.state = { kind: "connecting", attempt };
    this.logger?.debug("mcp.connecting", { server: this.name, attempt });

    const transport = this.transportFactory(this.config);
    const sdk = this.clientFactory({
      name: "@crewhaus/mcp-host",
      version: "0.0.0",
    });

    transport.onclose = () => {
      this.handleTransportClose();
    };

    try {
      // SDK's `connect()` calls transport.start() and runs the initialize
      // handshake. Wrap it in a connect-timeout so a wedged child doesn't
      // hang the boot sequence forever.
      await withTimeout(
        sdk.connect(transport),
        this.connectTimeoutMs,
        () =>
          new McpConnectionError(
            `mcp connect to "${this.name}" timed out after ${this.connectTimeoutMs}ms`,
          ),
      );
    } catch (err) {
      // Best-effort cleanup: SDK's connect may have partially started the
      // transport. Closing it (and ignoring secondary errors) prevents
      // leaked subprocesses.
      try {
        await transport.close();
      } catch {
        // intentionally swallowed: we are already in the error path
      }
      this.state = { kind: "disconnected", cause: err };
      throw wrapAsConnectionError(err, `mcp connect to "${this.name}" failed`);
    }

    this.sdk = sdk;
    this.transport = transport;
    this.state = { kind: "connected" };
    this.reconnectAttempt = 0;
    const deferred = this.connectedDeferred;
    this.connectedDeferred = createDeferred();
    void this.connectedDeferred.promise.catch(() => undefined);
    deferred.resolve();
    this.logger?.info("mcp.connected", { server: this.name });
  }

  /**
   * Called from the SDK transport's `onclose` hook. If the user closed us
   * deliberately we're in `closed` state and do nothing. Otherwise we drop
   * to `disconnected` and schedule a reconnect.
   */
  private handleTransportClose(): void {
    if (this.state.kind === "closed") return;
    this.logger?.warn("mcp.transport_closed", { server: this.name });
    this.sdk = null;
    this.transport = null;
    this.state = { kind: "disconnected" };
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state.kind === "closed") return;
    const delay = nextBackoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.logger?.info("mcp.reconnect_scheduled", {
      server: this.name,
      attempt: this.reconnectAttempt,
      delayMs: delay,
    });
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      void this.tryConnect().catch((err) => {
        this.logger?.warn("mcp.reconnect_failed", {
          server: this.name,
          attempt: this.reconnectAttempt,
          error: (err as Error).message,
        });
        if (this.state.kind !== "closed") this.scheduleReconnect();
      });
    }, delay);
  }

  /** Returns the cached tool list, populating it on first use post-connect. */
  async listTools(): Promise<ReadonlyArray<McpToolDefinition>> {
    if (this.cachedTools !== null) return this.cachedTools;
    await this.ensureConnected();
    const sdk = this.sdk;
    if (!sdk) throw new McpConnectionError(`mcp client "${this.name}" lost connection`);
    let result: {
      tools: ReadonlyArray<{ name: string; description?: string; inputSchema: unknown }>;
    };
    try {
      result = await sdk.listTools();
    } catch (err) {
      throw new McpProtocolError(`mcp listTools "${this.name}" failed`, err);
    }
    const tools: McpToolDefinition[] = result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    this.cachedTools = Object.freeze(tools);
    return this.cachedTools;
  }

  /**
   * Dispatch a tool call. Awaits reconnection if currently disconnected
   * (queue cap = 16). On `signal` abort or transport close while waiting,
   * rejects with `McpConnectionError`.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: McpCallOptions = {},
  ): Promise<McpCallResult> {
    if (opts.signal?.aborted) {
      throw new McpConnectionError(`mcp call "${this.name}.${name}" aborted before dispatch`);
    }
    await this.ensureConnected(opts.signal);
    const sdk = this.sdk;
    if (!sdk) throw new McpConnectionError(`mcp client "${this.name}" lost connection`);

    const timeoutMs = opts.timeoutMs ?? this.callTimeoutMs;
    const bus = this.eventBus;
    const startEnv = bus?.envelope();
    if (bus && startEnv) {
      bus.publish({
        ...startEnv,
        kind: "mcp_call_start",
        server: this.name,
        toolName: name,
      });
    }
    const t0 = performance.now();
    let raw: unknown;
    try {
      raw = await sdk.callTool(
        { name, arguments: args },
        // Force the new content-array result shape; the SDK's compat result
        // type unions in `{ toolResult: unknown }` which we don't surface.
        CallToolResultSchema,
        {
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          timeout: timeoutMs,
        },
      );
    } catch (err) {
      if (bus && startEnv) {
        bus.publish({
          ...bus.envelope(),
          spanId: startEnv.spanId,
          kind: "mcp_call_end",
          server: this.name,
          toolName: name,
          isError: true,
          durationMs: performance.now() - t0,
        });
      }
      throw wrapAsCallError(err, `mcp call "${this.name}.${name}" failed`);
    }

    const reduced = reduceCallResult(
      raw as { content?: ReadonlyArray<unknown>; isError?: boolean },
    );
    if (bus && startEnv) {
      bus.publish({
        ...bus.envelope(),
        spanId: startEnv.spanId,
        kind: "mcp_call_end",
        server: this.name,
        toolName: name,
        isError: reduced.isError === true,
        durationMs: performance.now() - t0,
      });
    }
    return reduced;
  }

  /**
   * Wait until the client is `connected`. New requests during reconnect
   * queue here; the queue is capped at 16 to prevent runaway buildup if the
   * server is permanently down.
   */
  private async ensureConnected(signal?: AbortSignal): Promise<void> {
    if (this.state.kind === "connected") return;
    if (this.state.kind === "closed") {
      throw new McpConnectionError(`mcp client "${this.name}" is closed`);
    }
    if (this.state.kind === "idle") {
      // First-call lazy connect path is unusual (host normally calls connect
      // explicitly during boot) but we honour it for hand-rolled callers.
      await this.tryConnect();
      return;
    }
    if (this.queuedWaiters >= QUEUE_CAP) {
      throw new McpConnectionError(
        `mcp client "${this.name}" reconnect queue full (${QUEUE_CAP}); rejecting new calls`,
      );
    }
    this.queuedWaiters += 1;
    try {
      await raceWithSignal(
        this.connectedDeferred.promise,
        signal,
        () => new McpConnectionError(`mcp call "${this.name}" aborted while waiting for reconnect`),
      );
    } finally {
      this.queuedWaiters -= 1;
    }
  }

  /**
   * Hard close — no further reconnect attempts. Pending `connectedDeferred`
   * waiters are rejected. Safe to call repeatedly.
   */
  async disconnect(): Promise<void> {
    if (this.state.kind === "closed") return;
    this.state = { kind: "closed" };
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Only reject the pending deferred if there are queued waiters; an
    // un-awaited rejection here would surface as an unhandled promise.
    if (this.queuedWaiters > 0) {
      const deferred = this.connectedDeferred;
      deferred.reject(new McpConnectionError(`mcp client "${this.name}" disconnected`));
    }
    // Replace with a fresh deferred so `connectedDeferred` is never left in a
    // rejected state. The client is now `closed` (terminal): every reconnect
    // path is guarded on `closed`, so this deferred is never awaited or
    // rejected again — hence no `.catch()` is needed here.
    this.connectedDeferred = createDeferred();

    const t = this.transport;
    this.sdk = null;
    this.transport = null;
    if (t) {
      try {
        await t.close();
      } catch (err) {
        this.logger?.warn("mcp.disconnect_error", {
          server: this.name,
          error: (err as Error).message,
        });
      }
    }
  }
}

function defaultClientFactory(info: { name: string; version: string }): Client {
  return new Client(info, { capabilities: {} });
}

function defaultTransportFactory(config: McpServerConfig): McpClientLikeTransport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ? [...config.args] : undefined,
      // `env: undefined` makes the SDK fall back to its safe default
      // (DEFAULT_INHERITED_ENV_VARS). Pass through user overrides as-is.
      ...(config.env !== undefined ? { env: { ...config.env } } : {}),
    });
  }
  // SSE — the SDK accepts a URL and request init; we layer headers via
  // requestInit so the SSE GET and the POST messages both carry them.
  const sseOpts: ConstructorParameters<typeof SSEClientTransport>[1] = {};
  if (config.headers !== undefined) {
    sseOpts.eventSourceInit = { fetch: makeSseFetch(config.headers) };
    sseOpts.requestInit = { headers: { ...config.headers } };
  }
  return new SSEClientTransport(new URL(config.url), sseOpts);
}

/**
 * Build the `eventSourceInit.fetch` wrapper that layers the configured static
 * `headers` onto every SSE GET. Extracted (and exported) so it can be unit-
 * tested without standing up a real EventSource — the SDK only invokes it
 * once the transport actually connects.
 *
 * @internal exported for tests only; not part of the public package surface.
 */
export function makeSseFetch(
  headers: Readonly<Record<string, string>>,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return (url, init) =>
    fetch(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), ...headers },
    });
}

/**
 * Reduce an MCP `CallToolResult` to a single string. Text blocks are joined
 * with `\n`; non-text blocks become deterministic placeholders so the model
 * sees a meaningful result rather than `[object Object]`.
 */
function reduceCallResult(raw: {
  content?: ReadonlyArray<unknown>;
  isError?: boolean;
}): McpCallResult {
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (b === null || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    } else if (block["type"] === "image") {
      const mime = typeof block["mimeType"] === "string" ? block["mimeType"] : "unknown";
      parts.push(`[image: ${mime}]`);
    } else if (block["type"] === "audio") {
      const mime = typeof block["mimeType"] === "string" ? block["mimeType"] : "unknown";
      parts.push(`[audio: ${mime}]`);
    } else if (block["type"] === "resource") {
      const resource = block["resource"];
      const uri =
        resource !== null && typeof resource === "object" && "uri" in resource
          ? String((resource as { uri: unknown }).uri)
          : "unknown";
      parts.push(`[resource: ${uri}]`);
    } else if (typeof block["type"] === "string") {
      parts.push(`[${block["type"]}]`);
    }
  }
  return {
    content: parts.join("\n"),
    isError: raw.isError === true,
  };
}

function wrapAsConnectionError(err: unknown, fallback: string): McpError {
  if (err instanceof McpError) return err;
  const msg = err instanceof Error ? `${fallback}: ${err.message}` : fallback;
  return new McpConnectionError(msg, err);
}

function wrapAsCallError(err: unknown, fallback: string): McpError {
  if (err instanceof McpError) return err;
  const name = (err as { name?: unknown }).name;
  if (name === "AbortError") {
    return new McpConnectionError(fallback, err);
  }
  const msg = err instanceof Error ? `${fallback}: ${err.message}` : fallback;
  return new McpProtocolError(msg, err);
}

type PromiseDeferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function createDeferred<T>(): PromiseDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, buildErr: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(buildErr()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  buildErr: () => Error,
): Promise<T> {
  if (signal === undefined) return promise;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(buildErr());
    };
    if (signal.aborted) {
      reject(buildErr());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
