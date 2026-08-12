import { McpConnectionError, McpError, McpProtocolError } from "@crewhaus/errors";
import type { Logger } from "@crewhaus/logging";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
  /**
   * Loop contract 0.4 (Batch G, G74) — invoked whenever the server sends a
   * `notifications/tools/list_changed`. The cached tool list is invalidated
   * BEFORE the handler runs, so a handler that calls {@link
   * McpClient.listTools} (or the tool-mcp re-diff/re-register path) sees the
   * fresh catalog. Also registerable after construction via {@link
   * McpClient.onToolsChanged}. Handler errors are logged and swallowed —
   * a drifting server must never wedge the run loop.
   */
  readonly onToolsChanged?: (client: McpClient) => void;
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
  /** Test/escape-hatch override. Undefined ⇒ this client builds its own
   *  transports and, for `sse`, probes the HTTP wire candidates. */
  private readonly injectedTransportFactory:
    | ((config: McpServerConfig) => McpClientLikeTransport)
    | undefined;
  /** Which HTTP wire this endpoint turned out to speak, once one handshake
   *  has succeeded — so reconnects skip the probe (#394). */
  private httpWire: HttpMcpWire | undefined;
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
  private readonly toolsChangedHandlers = new Set<(client: McpClient) => void>();

  constructor(name: string, config: McpServerConfig, opts: McpClientOptions = {}) {
    this.name = name;
    this.config = config;
    this.logger = opts.logger;
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.injectedTransportFactory = opts.transportFactory;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.eventBus = opts.eventBus;
    if (opts.onToolsChanged !== undefined) this.toolsChangedHandlers.add(opts.onToolsChanged);
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
   *
   * For `transport: "sse"` this walks the HTTP wire candidates (Streamable
   * HTTP, then legacy HTTP+SSE — see {@link httpTransportCandidates}) until
   * one completes the handshake, and REMEMBERS the winner so reconnects and
   * every later attempt go straight to it. An injected `transportFactory`
   * (tests) is always honoured verbatim and never probed.
   */
  private async tryConnect(): Promise<void> {
    const attempt = this.reconnectAttempt;
    this.state = { kind: "connecting", attempt };
    this.logger?.debug("mcp.connecting", { server: this.name, attempt });

    const candidates = this.transportCandidates();
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await this.connectWith(candidate.build(), attempt);
        if (candidate.wire !== undefined && this.httpWire === undefined) {
          this.httpWire = candidate.wire;
          this.logger?.debug("mcp.http-wire", { server: this.name, wire: candidate.wire });
        }
        return;
      } catch (err) {
        lastError = err;
        // Keep probing only while another candidate remains: the LAST
        // failure is the one the operator sees, and for a genuinely
        // unreachable peer that is the legacy transport's error, which is
        // the same message this client has always produced.
      }
    }
    throw lastError;
  }

  /** The transports to try, in order, for this config. */
  private transportCandidates(): ReadonlyArray<{
    readonly wire?: HttpMcpWire;
    readonly build: () => McpClientLikeTransport;
  }> {
    // An injected factory is the test seam AND an escape hatch; probing past
    // it would call it twice and defeat both.
    if (this.injectedTransportFactory !== undefined) {
      const factory = this.injectedTransportFactory;
      return [{ build: () => factory(this.config) }];
    }
    if (this.config.transport !== "sse") {
      return [{ build: () => defaultTransportFactory(this.config) }];
    }
    const all = httpTransportCandidates(this.config);
    // Already know which wire this endpoint speaks — go straight to it.
    const known = this.httpWire;
    return known === undefined ? all : all.filter((c) => c.wire === known);
  }

  /** One handshake attempt against one built transport. */
  private async connectWith(transport: McpClientLikeTransport, attempt: number): Promise<void> {
    void attempt;
    const sdk = this.clientFactory({
      name: "@crewhaus/mcp-host",
      version: "0.0.0",
    });

    transport.onclose = () => {
      this.handleTransportClose();
    };

    // Loop contract 0.4 (Batch G, G74) — subscribe to the server's
    // tools/list_changed notification BEFORE the handshake so a server that
    // fires it immediately post-initialize is not missed. Re-set on every
    // (re)connect because each attempt builds a fresh SDK Client. The handler
    // invalidates the tool cache and fans out to registered listeners (the
    // tool-mcp re-diff/re-register path), all guarded so a drifting server
    // never wedges the loop. The `typeof` guard tolerates minimal SDK-client
    // fakes (tests) that don't implement the Protocol notification surface.
    if (typeof sdk.setNotificationHandler === "function") {
      sdk.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.handleToolsListChanged();
      });
    }

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
      // DETACH BEFORE CLOSING (#394). `close()` fires `onclose`, which routes
      // into `handleTransportClose` — the reconnect scheduler. On the probe
      // path that is actively wrong: the FIRST candidate failing is the normal
      // way a legacy-SSE peer is discovered, and letting it arm a reconnect
      // leaves a phantom timer racing the candidate that is about to succeed.
      // A failed attempt must leave no scheduling behind it.
      transport.onclose = undefined;
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
   * Loop contract 0.4 (Batch G, G74) — force a fresh `tools/list` fetch,
   * bypassing the boot-time cache. Called by the tool-mcp re-diff path after
   * a `tools/list_changed` notification (the notification handler already
   * cleared the cache, but an explicit caller may also invoke this).
   */
  async refreshTools(): Promise<ReadonlyArray<McpToolDefinition>> {
    this.cachedTools = null;
    return this.listTools();
  }

  /**
   * Loop contract 0.4 (Batch G, G74) — register a handler fired on every
   * `tools/list_changed`. Returns an unsubscribe function. The cache is
   * already invalidated when the handler runs, so re-listing inside it sees
   * the new catalog. Multiple handlers fan out in registration order.
   */
  onToolsChanged(handler: (client: McpClient) => void): () => void {
    this.toolsChangedHandlers.add(handler);
    return () => {
      this.toolsChangedHandlers.delete(handler);
    };
  }

  /**
   * Handle a `tools/list_changed` notification: invalidate the tool cache so
   * the next `listTools()` re-fetches, then fan out to registered handlers.
   * A `closed` client ignores late notifications. Handler errors are logged
   * and swallowed — best-effort, never fatal to the run loop.
   */
  private handleToolsListChanged(): void {
    if (this.state.kind === "closed") return;
    this.logger?.info("mcp.tools_list_changed", { server: this.name });
    this.cachedTools = null;
    for (const handler of this.toolsChangedHandlers) {
      try {
        handler(this);
      } catch (err) {
        this.logger?.warn("mcp.tools_changed_handler_error", {
          server: this.name,
          error: (err as Error).message,
        });
      }
    }
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
      // (DEFAULT_INHERITED_ENV_VARS). When the config DOES declare env,
      // merge it ON TOP of that same default set — the SDK treats an
      // explicit `env` as the child's ENTIRE environment, so passing the
      // overrides alone used to strip PATH/HOME AND meant an explicitly
      // configured secret (e.g. THREDZ_API_KEY, not on the allowlist)
      // was the child's only variable while still losing everything a
      // spawned `npx`/`node` needs to run. This spread is the actual
      // secret-delivery fix: explicit keys survive the SDK allowlist.
      ...(config.env !== undefined ? { env: buildStdioChildEnv(config.env) } : {}),
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
 * `transport: "sse"` names an HTTP-mounted MCP endpoint, NOT one wire
 * protocol — so it is resolved by PROBING, newest first (#394).
 *
 * MCP has two HTTP transports. The 2024-11-05 revision's **HTTP+SSE** opens
 * with `GET` → `text/event-stream` and receives an `endpoint` event naming a
 * POST URL; the 2025-03-26 revision's **Streamable HTTP** POSTs JSON-RPC to
 * one URL and upgrades to a stream only when the server chooses. They share
 * a URL shape and nothing else, and a client aimed at the wrong one fails
 * with a content-type error rather than anything that names the mismatch.
 *
 * This mattered because our own two halves disagreed: `@crewhaus/mcp-server`
 * serves Streamable HTTP (`WebStandardStreamableHTTPServerTransport`) while
 * this client spoke only legacy HTTP+SSE — so a CrewHaus daemon exposed over
 * `expose.mcp.transport: sse` could not be consumed by a CrewHaus peer
 * declaring `mcp_servers: { peer: { transport: sse } }`. The legacy client's
 * opening GET got `400 application/json` from our own server, surfacing to
 * the operator as `SSE error: Invalid content type`.
 *
 * Order is Streamable HTTP first because it is the current revision and the
 * one our own emit serves; the legacy fallback is what keeps a third-party
 * 2024-11-05 server — the reason this config value existed at all — working
 * unchanged. Nothing about the spec surface changes: `sse` simply now means
 * "HTTP, either revision" instead of "HTTP, the old one only".
 */
export function httpTransportCandidates(
  config: Extract<McpServerConfig, { transport: "sse" }>,
): ReadonlyArray<{ readonly wire: HttpMcpWire; readonly build: () => McpClientLikeTransport }> {
  return [
    { wire: "streamable-http", build: () => streamableHttpTransport(config) },
    { wire: "http-sse", build: () => defaultTransportFactory(config) },
  ];
}

/** Which HTTP wire protocol a connected `sse` server turned out to speak. */
export type HttpMcpWire = "streamable-http" | "http-sse";

function streamableHttpTransport(
  config: Extract<McpServerConfig, { transport: "sse" }>,
): McpClientLikeTransport {
  const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
  if (config.headers !== undefined) {
    // One `requestInit` covers every request this transport makes (the POST
    // and the optional GET stream), so unlike the legacy transport there is
    // no separate EventSource fetch to patch.
    opts.requestInit = { headers: { ...config.headers } };
  }
  return new StreamableHTTPClientTransport(new URL(config.url), opts);
}

/**
 * Merge the SDK's safe default child environment (`getDefaultEnvironment()`
 * — HOME/PATH/SHELL/… per `DEFAULT_INHERITED_ENV_VARS`) with the config's
 * explicit `env`, explicit keys winning. Extracted (and exported) so the
 * merge is unit-testable without spawning a real subprocess.
 *
 * @internal exported for tests only; not part of the public package surface.
 */
export function buildStdioChildEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return { ...getDefaultEnvironment(), ...env };
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
