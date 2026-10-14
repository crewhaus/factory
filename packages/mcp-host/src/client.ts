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
  McpToolFlagsConfig,
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
 * `closed` is terminal — a closed client never reconnects. That includes an
 * attempt already IN FLIGHT when `disconnect()` lands (a boot `connect()`, a
 * ladder rung, a lazy first call): `disconnect()` closes its transport, and
 * the attempt rejects instead of adopting a connection or writing any state.
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
  /** True while walking the HTTP wire candidates. A candidate failing is the
   *  EXPECTED way the other wire is discovered, so its close must not arm the
   *  reconnect ladder (#394). */
  private probing = false;
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
  /** Transports of attempts still in flight: built, not yet adopted. The
   *  adopted one lives in `transport`; these are the children still spawning
   *  and the streams still opening, which `disconnect()` must reap too. */
  private readonly inFlight = new Set<McpClientLikeTransport>();
  /** Every close this client has started and not yet seen finish — those
   *  of failed attempts included — so `disconnect()` can wait them out. */
  private readonly reaping = new Set<Promise<void>>();
  /** Aborted by `disconnect()`. Read after every await of an attempt — an
   *  attempt that finds it aborted was overtaken and may only clean up after
   *  itself — and raced by each handshake, so none outlives the client. */
  private readonly closing = new AbortController();
  /** The first `disconnect()`, which every later call joins. */
  private disconnecting: Promise<void> | undefined;
  private cachedTools: ReadonlyArray<McpToolDefinition> | null = null;
  private connectedDeferred: PromiseDeferred<void> = createDeferred();
  private queuedWaiters = 0;
  private readonly toolsChangedHandlers = new Set<(client: McpClient) => void>();

  /** The trust flags the spec set on this server's tools, from its config. */
  get toolFlags(): McpToolFlagsConfig | undefined {
    return this.config.toolFlags;
  }

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
   * completes. If already connected, returns immediately. Rejects with
   * `McpConnectionError` if `disconnect()` lands before the handshake is
   * adopted — whatever the handshake would have done.
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
    // connect() and ensureConnected() check `closed` themselves, so only a
    // ladder rung can get here on a closed client — through an injected
    // timer seam whose clear does not cancel, say. It must not write
    // `connecting` over `closed`; the rung's catch swallows the throw.
    if (this.closing.signal.aborted) {
      throw new McpConnectionError(`mcp client "${this.name}" is closed`);
    }
    const attempt = this.reconnectAttempt;
    this.state = { kind: "connecting", attempt };
    this.logger?.debug("mcp.connecting", { server: this.name, attempt });

    const candidates = this.transportCandidates();
    let lastError: unknown;
    // While probing, a candidate's close must not schedule anything: the
    // whole point is that failures here are EXPECTED.
    this.probing = candidates.length > 1;
    for (const candidate of candidates) {
      // Closed before this candidate was built — mid-probe, while the one
      // before it was in flight, or by a re-entrant `disconnect()` (from the
      // log line above, say). Building it would spawn a child, or open a
      // stream and a server session, for a client its caller has closed.
      if (this.closing.signal.aborted) {
        lastError ??= this.closedWhileConnecting();
        break;
      }
      try {
        await this.connectWith(candidate.build(), attempt);
        this.probing = false;
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
    this.probing = false;
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
    closeOnce(transport);
    const sdk = this.clientFactory({
      name: "@crewhaus/mcp-host",
      version: "0.0.0",
    });

    transport.onclose = () => {
      this.handleTransportClose(transport);
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

    // Closed while this candidate was being set up — by a re-entrant
    // `disconnect()` from a factory, the `onclose` setter or the SDK client's
    // setNotificationHandler. Never start it; the `disconnect()` waits for
    // this close (reaped synchronously, before its first check).
    if (this.closing.signal.aborted) {
      void this.reap(transport);
      throw this.closedWhileConnecting();
    }
    // In flight until adopted or failed: `disconnect()` reaps it from here.
    this.inFlight.add(transport);
    // Cancels the SDK's `initialize` request if this handshake is abandoned.
    // That request holds its own REF'D timer (60 s), which only the SDK's
    // close-time cleanup clears — and the catch below detaches the hook that
    // runs it.
    const handshake = new AbortController();
    try {
      // SDK's `connect()` calls transport.start() and runs the initialize
      // handshake. Wrap it in a connect-timeout so a wedged child doesn't
      // hang the boot sequence forever — and race `disconnect()`, so a
      // transport whose close() never settles its start() cannot either.
      await withTimeout(
        sdk.connect(transport, { signal: handshake.signal }),
        this.connectTimeoutMs,
        () =>
          new McpConnectionError(
            `mcp connect to "${this.name}" timed out after ${this.connectTimeoutMs}ms`,
          ),
        this.closing.signal,
      );
    } catch (err) {
      this.inFlight.delete(transport);
      // DETACH BEFORE CLOSING (#394). `close()` fires `onclose`, which routes
      // into `handleTransportClose` — the reconnect scheduler. On the probe
      // path that is actively wrong: the FIRST candidate failing is the normal
      // way a legacy-SSE peer is discovered, and letting it arm a reconnect
      // leaves a phantom timer racing the candidate that is about to succeed.
      // A failed attempt must leave no scheduling behind it.
      transport.onclose = undefined;
      // Best-effort cleanup: SDK's connect may have partially started the
      // transport. Closing it (and ignoring secondary errors) prevents
      // leaked subprocesses. If the SDK or `disconnect()` closed it first,
      // this joins that close — for stdio, the one that waits for the child —
      // and does not wait for it: how slowly a refused child exits (up to
      // ~4 s if it ignores EOF and SIGTERM) must not decide how fast the
      // attempt fails, and `disconnect()` waits for it anyway. When this IS
      // the first close (a timeout, a start that failed), wait, as this
      // always has: a caller that exits on the error must not leave a child.
      const first = !closeStarted(transport);
      const closed = this.reap(transport);
      // With `onclose` detached, the SDK's close-time cleanup never runs, so
      // cancel the handshake to clear its own `initialize` timer (REF'D,
      // 60 s). Only once the close has started: its `notifications/cancelled`
      // then has no live transport to go out on.
      handshake.abort();
      if (first) await closed;
      // Overtaken by `disconnect()` — before or during that close: its
      // `closed` must survive this attempt. Keep the attempt's own failure as
      // the cause, not the disconnect's abort.
      if (this.closing.signal.aborted) {
        throw this.closedWhileConnecting(err === this.closing.signal.reason ? undefined : err);
      }
      this.state = { kind: "disconnected", cause: err };
      throw wrapAsConnectionError(err, `mcp connect to "${this.name}" failed`);
    }

    this.inFlight.delete(transport);
    // The handshake landed after `disconnect()`, which has already taken this
    // transport and started closing it: adopting it would hand a closed
    // client a live connection.
    if (this.closing.signal.aborted) throw this.closedWhileConnecting();

    this.sdk = sdk;
    this.transport = transport;
    this.state = { kind: "connected" };
    this.reconnectAttempt = 0;
    // A timer armed before this handshake landed (a probe candidate's close
    // racing the candidate that succeeded) would reconnect a healthy client
    // and orphan this very transport. Cancel it.
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
  /**
   * A transport closed. Only the CURRENT one may drive the reconnect ladder.
   *
   * The guard is not defensive dressing (#394): the SDK's own
   * `Client.connect` catch calls `void this.close()` on a failed handshake,
   * which fires `onclose` BEFORE our catch can detach it — so on the
   * `transport: "sse"` probe path, the first candidate failing (the normal
   * way a legacy HTTP+SSE peer is discovered) armed a reconnect timer that
   * then raced the candidate about to succeed. The result was a healthy
   * connection spontaneously reconnecting, each phantom attempt orphaning a
   * live stream and a server-side session.
   */
  private handleTransportClose(closed?: McpClientLikeTransport): void {
    // A close from a transport we have already replaced — or from a probe
    // candidate we never adopted — says nothing about the live connection.
    if (closed !== undefined && this.transport !== null && closed !== this.transport) return;
    if (this.probing && (closed === undefined || closed !== this.transport)) return;
    if (this.state.kind === "closed") return;
    this.sdk = null;
    this.transport = null;
    this.state = { kind: "disconnected" };
    // Logged only once the state is written: a log sink that calls
    // `disconnect()` must not have its `closed` overwritten here.
    this.logger?.warn("mcp.transport_closed", { server: this.name });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state.kind === "closed") return;
    // ONE rung at a time. A failing rung whose transport closed under it has
    // already armed the next one (via handleTransportClose); arming another
    // here overwrote that handle, so every such failure doubled the timers
    // and left all but the newest out of `disconnect()`'s reach — REF'D.
    if (this.reconnectTimer !== null) return;
    const delay = nextBackoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    const attempt = this.reconnectAttempt;
    // A seam may run the callback synchronously, inside setTimer: only a
    // handle whose callback has not run yet marks a rung as pending, or the
    // guard above would silence the ladder for good.
    let fired = false;
    const handle = this.setTimer(() => {
      fired = true;
      this.reconnectTimer = null;
      void this.tryConnect().catch((err) => {
        // Closed before or during this rung: nothing to retry, and a
        // shutdown is not a reconnect failure worth a warning.
        if (this.state.kind === "closed") return;
        this.logger?.warn("mcp.reconnect_failed", {
          server: this.name,
          attempt: this.reconnectAttempt,
          error: (err as Error).message,
        });
        this.scheduleReconnect();
      });
    }, delay);
    if (!fired) this.reconnectTimer = handle;
    // Logged only once the rung is armed, so a log sink that calls
    // `disconnect()` finds the handle to clear.
    this.logger?.info("mcp.reconnect_scheduled", {
      server: this.name,
      attempt,
      delayMs: delay,
    });
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
    const tools: McpToolDefinition[] = result.tools.map((t) => {
      const annotations = trustHints((t as { annotations?: unknown }).annotations);
      return {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(annotations !== undefined ? { annotations } : {}),
      };
    });
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
   * waiters are rejected. An attempt still in flight is ended too: its
   * transport is closed here and the attempt rejects. Resolves once every
   * close this client has started has finished — for stdio, once each
   * direct child has exited or been sent SIGKILL (a transport whose close()
   * never settles holds it forever, as an adopted one always has — and a
   * close() that awaits its own client's disconnect() waits on itself).
   * Safe to call repeatedly: every call joins the first.
   */
  disconnect(): Promise<void> {
    if (this.disconnecting === undefined) {
      // Joinable BEFORE the shutdown runs a line: a close it starts may call
      // disconnect() again, synchronously, and must join — not start a
      // second shutdown that recurses into the same close.
      const done = createDeferred<void>();
      this.disconnecting = done.promise;
      this.shutdown().then(done.resolve, done.reject);
    }
    return this.disconnecting;
  }

  private async shutdown(): Promise<void> {
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
    // Reap what an attempt in flight opened — a child still spawning, a
    // stream still opening — along with the adopted transport.
    const warn = (err: unknown): void => {
      this.logger?.warn("mcp.disconnect_error", {
        server: this.name,
        error: describeFailure(err),
      });
    };
    for (const x of [...(t ? [t] : []), ...this.inFlight]) void this.reap(x, warn);
    this.inFlight.clear();
    // End every handshake still racing, so none waits out its connect
    // timeout on a client that is already closed.
    this.closing.abort();
    // Resolve only once every close has finished: these, and those of
    // attempts that had already failed and are still closing their own
    // transport. Yield before the first check: a `disconnect()` made from
    // inside a factory returns to an attempt that then reaps the transport
    // it was building, synchronously — after this line, before the next.
    do await Promise.all(this.reaping);
    while (this.reaping.size > 0);
  }

  /**
   * Close `transport`, keeping the close where `disconnect()` can wait for
   * it. Never rejects: a close failure goes to `onError`, or nowhere.
   */
  private reap(transport: McpClientLikeTransport, onError?: (err: unknown) => void): Promise<void> {
    // Every transport reaped here went through closeOnce; the fallback is
    // only defensive.
    const close = firstClose.get(transport)?.start ?? (() => transport.close());
    const done: Promise<void> = (async () => {
      await close();
    })()
      .catch((err) => {
        try {
          onError?.(err);
        } catch {
          // a failing log sink must not fail the reap
        }
      })
      .finally(() => {
        this.reaping.delete(done);
      });
    this.reaping.add(done);
    return done;
  }

  /** What an attempt overtaken by `disconnect()` rejects with. Its own
   *  failure, if it had one, is kept as the cause. */
  private closedWhileConnecting(cause?: unknown): McpConnectionError {
    return new McpConnectionError(`mcp client "${this.name}" was closed while connecting`, cause);
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
/**
 * The two trust hints a server's `ToolAnnotations` may carry that bear on a
 * permission decision, kept only when they are booleans; anything else in the
 * annotations (a title, idempotency, open-world) is dropped here.
 */
function trustHints(raw: unknown): McpToolDefinition["annotations"] {
  if (raw === null || typeof raw !== "object") return undefined;
  const { readOnlyHint, destructiveHint } = raw as Record<string, unknown>;
  const out: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
  if (typeof readOnlyHint === "boolean") out.readOnlyHint = readOnlyHint;
  if (typeof destructiveHint === "boolean") out.destructiveHint = destructiveHint;
  return Object.keys(out).length > 0 ? out : undefined;
}

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

/**
 * `promise`, unless `ms` pass or `signal` aborts first. The abort joins the
 * SAME race rather than wrapping it: every promise layer between a handshake
 * landing and its adoption is another microtask, and the reconnect tests
 * count them.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  buildErr: () => Error,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, rej) => {
        if (signal?.aborted) {
          rej(signal.reason);
          return;
        }
        timer = setTimeout(() => rej(buildErr()), ms);
        if (signal !== undefined) {
          onAbort = () => rej(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

/** Each transport's own `close`, before {@link closeOnce} wrapped it. */
const unwrappedClose = new WeakMap<McpClientLikeTransport, () => Promise<void>>();
/** A wrapped transport's first close: start (or join) it, rejection and all;
 *  and whether anyone has started it yet. */
const firstClose = new WeakMap<
  McpClientLikeTransport,
  { readonly start: () => Promise<void>; readonly started: () => boolean }
>();

/** Whether `transport`'s first close has started — by anyone, the SDK
 *  included. */
function closeStarted(transport: McpClientLikeTransport): boolean {
  return firstClose.get(transport)?.started() ?? false;
}

/**
 * Make `transport.close()` join its first call for the rest of this attempt.
 * The SDK's own `Client.connect` catch closes a failed handshake's transport
 * fire-and-forget, and for stdio only that FIRST close waits for the child to
 * exit — a second returns at once. Joining it is what lets `disconnect()`
 * wait for the child instead of racing past it.
 */
function closeOnce(transport: McpClientLikeTransport): void {
  // Re-wrapped per attempt (an injected factory may hand back the same
  // object), always around the transport's own close.
  const close = unwrappedClose.get(transport) ?? transport.close.bind(transport);
  unwrappedClose.set(transport, close);
  let first: Promise<void> | undefined;
  let inside = false;
  const start = (): Promise<void> => {
    if (first === undefined) {
      // Set before the close runs a line, so a re-entrant close joins it
      // instead of starting a second one.
      const settled = createDeferred<void>();
      first = settled.promise;
      inside = true;
      let running: Promise<void>;
      try {
        running = (async () => close())();
      } finally {
        inside = false;
      }
      running.then(settled.resolve, settled.reject);
    }
    return first;
  };
  firstClose.set(transport, { start, started: () => first !== undefined });
  try {
    // Every caller but `reap()` — the SDK's fire-and-forget close among them
    // — gets a close that cannot reject: none of them handles a rejection.
    // One made from INSIDE the first close (a linked pair closing its peer,
    // which closes it back: the SDK's InMemoryTransport) must not wait on
    // the close it is part of.
    transport.close = () => (inside ? Promise.resolve() : start().catch(() => undefined));
  } catch {
    // A transport whose `close` cannot be reassigned keeps it: our closes
    // still join through `firstClose`; only the SDK's own goes unjoined.
  }
}

/** A close failure's message for the log: never throws, keeps a `{ message }`. */
function describeFailure(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    const message = (err as { message?: unknown } | null | undefined)?.message;
    return typeof message === "string" ? message : String(err);
  } catch {
    return Object.prototype.toString.call(err);
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
