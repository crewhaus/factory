import { afterEach, describe, expect, test } from "bun:test";
import { McpConnectionError, McpError, McpProtocolError } from "@crewhaus/errors";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpClient, makeSseFetch } from "./client.js";
import type { McpServerConfig } from "./types.js";

/**
 * Strict-coverage companion to index/reconnect/security tests. Targets the
 * lines/functions the thematic suites leave uncovered in `client.ts`:
 *   - connect-timeout error builder (withTimeout buildErr)            (144-145)
 *   - reconnect-attempt failure path + re-schedule                   (198-203)
 *   - defaultClientFactory (real SDK Client, fake transport)         (376)
 *   - defaultTransportFactory stdio + SSE branches                   (380-402)
 *   - wrapAsConnectionError (McpError passthrough + non-Error)       (445-447)
 *   - wrapAsCallError (McpError / AbortError / non-Error)            (451-457)
 *   - raceWithSignal (already-aborted, abort-while-waiting, resolve) (491-516)
 *   - eventBus mcp_call_start/end on success and on error
 *
 * Everything is in-process: no real subprocess, socket, or wall-clock. The
 * one timer-sensitive test (connect timeout) overrides global setTimeout/
 * clearTimeout to fire synchronously and restores them in afterEach.
 */

const STDIO_CFG: McpServerConfig = { transport: "stdio", command: "true" };

/**
 * Controllable in-process Transport mirroring the fixtures in the sibling
 * test files. Drives the JSON-RPC initialize / tools/list / tools/call loop
 * via `onmessage`, and exposes `simulateClose()` to fire the SDK `onclose`
 * hook on demand.
 */
function createControllableTransport(opts: {
  toolListResult?: {
    tools: ReadonlyArray<{ name: string; description?: string; inputSchema: unknown }>;
  };
  callResultByTool?: Record<string, () => { content: ReadonlyArray<unknown>; isError?: boolean }>;
  onCloseCalled?: () => void;
}): {
  transport: Transport;
  simulateClose: () => void;
} {
  let onmessage: ((m: JSONRPCMessage) => void) | undefined;
  let onclose: (() => void) | undefined;
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      if (!("method" in message) || !("id" in message)) return;
      const req = message as { id: string | number; method: string; params?: unknown };
      let result: unknown;
      switch (req.method) {
        case "initialize":
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "0.0.0" },
          };
          break;
        case "tools/list":
          result = opts.toolListResult ?? { tools: [] };
          break;
        case "tools/call": {
          const params = req.params as { name?: string; arguments?: unknown };
          const handler = params?.name ? opts.callResultByTool?.[params.name] : undefined;
          result = handler
            ? handler()
            : { content: [{ type: "text", text: "ok" }], isError: false };
          break;
        }
        default:
          queueMicrotask(() =>
            onmessage?.({
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32601, message: `unknown method ${req.method}` },
            } as JSONRPCMessage),
          );
          return;
      }
      queueMicrotask(() => onmessage?.({ jsonrpc: "2.0", id: req.id, result } as JSONRPCMessage));
    },
    async close() {
      opts.onCloseCalled?.();
      onclose?.();
    },
    set onmessage(handler: ((m: JSONRPCMessage) => void) | undefined) {
      onmessage = handler;
    },
    get onmessage() {
      return onmessage;
    },
    set onclose(handler: (() => void) | undefined) {
      onclose = handler;
    },
    get onclose() {
      return onclose;
    },
  };
  return {
    transport,
    simulateClose: () => onclose?.(),
  };
}

/** Yield the microtask queue a few times so queued JSON-RPC replies land. */
async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => queueMicrotask(() => r(undefined)));
  }
}

/**
 * Await a promise expected to reject and return the thrown value. Using an
 * explicit try/catch (rather than pre-capturing `expect(p).rejects`) keeps
 * bun's async-rejection tracking from wedging when the rejection is triggered
 * later in the test body while a sibling promise stays pending.
 */
async function catchErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    throw new Error("expected promise to reject, but it resolved");
  } catch (err) {
    return err;
  }
}

describe("McpClient — connect timeout (withTimeout buildErr, 144-145)", () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  test("a wedged sdk.connect rejects with the timeout McpConnectionError", async () => {
    // `withTimeout` uses the global setTimeout/clearTimeout. Override them so
    // the timeout fires synchronously (no wall-clock) and is cleared cleanly.
    let firedCb: (() => void) | null = null;
    let cleared = false;
    globalThis.setTimeout = ((cb: () => void) => {
      firedCb = cb;
      return 1234 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: unknown) => {
      if (handle === 1234) cleared = true;
    }) as typeof clearTimeout;

    let transportClosed = false;
    const fixture = createControllableTransport({
      onCloseCalled: () => {
        transportClosed = true;
      },
    });

    // SDK Client stub whose connect() never settles → only the timeout wins.
    const hangingClient = {
      connect: () => new Promise<void>(() => undefined),
    } as unknown as Client;

    const client = new McpClient("wedged", STDIO_CFG, {
      transportFactory: () => fixture.transport,
      clientFactory: () => hangingClient,
      connectTimeoutMs: 50,
    });

    const connectPromise = client.connect();
    // Fire the timeout callback the override captured.
    expect(firedCb).not.toBeNull();
    (firedCb as unknown as () => void)();

    await expect(connectPromise).rejects.toThrow(McpConnectionError);
    // Build the message again to assert the buildErr branch (144-145) ran.
    await connectPromise.catch((err: unknown) => {
      expect((err as Error).message).toContain("timed out after 50ms");
    });
    // Error path closed the transport (best-effort cleanup) and timer cleared.
    expect(transportClosed).toBe(true);
    expect(cleared).toBe(true);
    expect(client.getState().kind).toBe("disconnected");
  });
});

describe("McpClient — reconnect attempt failure re-schedules (198-203)", () => {
  test("a failing reconnect logs reconnect_failed and schedules the next attempt", async () => {
    // First connect succeeds; after the transport closes, the *reconnect*
    // attempt fails (its sdk.connect rejects), exercising the catch block at
    // 198-203 (warn + re-schedule). The second reconnect then succeeds.
    let connectCalls = 0;
    const warnLogs: Array<{ msg: string; meta: unknown }> = [];
    const logger = {
      debug() {},
      info() {},
      warn(msg: string, meta: unknown) {
        warnLogs.push({ msg, meta });
      },
      error() {},
      child() {
        return logger;
      },
    } as unknown as import("@crewhaus/logging").Logger;

    const goodTransport = () =>
      createControllableTransport({
        toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      });
    let active = goodTransport();
    const transportFactory = () => {
      active = goodTransport();
      return active.transport;
    };

    // clientFactory: real handshake via fixture, except the *first reconnect*
    // (2nd connect overall) which throws synchronously.
    const clientFactory = (info: { name: string; version: string }): Client => {
      connectCalls += 1;
      if (connectCalls === 2) {
        return {
          connect: () => Promise.reject(new Error("reconnect boom")),
        } as unknown as Client;
      }
      return new Client(info, { capabilities: {} });
    };

    // Synchronous reconnect timer so scheduling resolves deterministically.
    const timers: Array<() => void> = [];
    const setTimer = (cb: () => void): unknown => {
      timers.push(cb);
      queueMicrotask(() => {
        const next = timers.shift();
        next?.();
      });
      return Symbol("t");
    };
    const clearTimer = (): void => undefined;

    const client = new McpClient("recon", STDIO_CFG, {
      transportFactory,
      clientFactory,
      setTimer,
      clearTimer,
      logger,
    });

    await client.connect();
    expect(client.getState().kind).toBe("connected");
    expect(connectCalls).toBe(1);

    // Kill the transport → handleTransportClose → scheduleReconnect.
    active.simulateClose();
    await flushMicrotasks(12);

    // The failing reconnect (connectCalls === 2) must have logged and the
    // catch must have scheduled another attempt that succeeded.
    expect(connectCalls).toBeGreaterThanOrEqual(3);
    expect(warnLogs.some((l) => l.msg === "mcp.reconnect_failed")).toBe(true);
    const failed = warnLogs.find((l) => l.msg === "mcp.reconnect_failed");
    // tryConnect wraps the raw cause via wrapAsConnectionError, so the logged
    // message is the wrapped connection-error message.
    expect((failed?.meta as { error?: string })?.error).toContain("reconnect boom");
    expect(client.getState().kind).toBe("connected");

    // A call now routes through the recovered transport.
    const r = await client.callTool("echo", {});
    expect(r.isError).toBe(false);

    await client.disconnect();
  });

  test("disconnect clears the held reconnect timer so no attempt fires (345-348)", async () => {
    // Connect succeeds, the transport closes (→ scheduleReconnect sets a timer
    // we hold), then disconnect() runs while that timer is pending. disconnect
    // must clearTimer it (lines 345-348) so the captured callback is dropped
    // and the client stays closed — even if we try to fire the stale handle.
    let connectCount = 0;
    const clientFactory = (info: { name: string; version: string }): Client => {
      connectCount += 1;
      return new Client(info, { capabilities: {} });
    };
    let active = createControllableTransport({ toolListResult: { tools: [] } });
    const transportFactory = () => {
      active = createControllableTransport({ toolListResult: { tools: [] } });
      return active.transport;
    };

    const held: { cb: (() => void) | null } = { cb: null };
    let cleared = false;
    const setTimer = (cb: () => void): unknown => {
      held.cb = cb;
      return "HANDLE";
    };
    const clearTimer = (h: unknown): void => {
      if (h === "HANDLE") {
        cleared = true;
        held.cb = null;
      }
    };

    const client = new McpClient("down", STDIO_CFG, {
      transportFactory,
      clientFactory,
      setTimer,
      clearTimer,
    });

    await client.connect();
    expect(connectCount).toBe(1);
    // Transport dies → handleTransportClose → scheduleReconnect holds a timer.
    active.simulateClose();
    await flushMicrotasks();
    expect(client.getState().kind).toBe("disconnected");
    expect(held.cb).not.toBeNull();

    // disconnect() while the reconnect timer is pending must clear it.
    await client.disconnect();
    expect(client.getState().kind).toBe("closed");
    expect(cleared).toBe(true);
    expect(held.cb).toBeNull();
    // No second connect happened (the reconnect never ran).
    expect(connectCount).toBe(1);
  });

  test("default setTimer/clearTimer wrappers are used when not overridden (93-94)", async () => {
    // Omit setTimer/clearTimer so the constructor's default lambdas
    // (`(cb,ms) => setTimeout(...)` / `(h) => clearTimeout(...)`) are exercised.
    // We schedule a reconnect by closing the transport, then immediately
    // disconnect — which clears the just-scheduled real timer before its
    // backoff (~1s) elapses, so nothing fires and no handle leaks.
    let fixture = createControllableTransport({ toolListResult: { tools: [] } });
    let handedOut = false;
    const client = new McpClient("default-timers", STDIO_CFG, {
      transportFactory: () => {
        if (!handedOut) {
          handedOut = true;
          return fixture.transport;
        }
        fixture = createControllableTransport({ toolListResult: { tools: [] } });
        return fixture.transport;
      },
      clientFactory: (info) => new Client(info, { capabilities: {} }),
      // setTimer / clearTimer intentionally omitted → defaults.
    });
    await client.connect();
    expect(client.getState().kind).toBe("connected");
    // Transport close → scheduleReconnect → default setTimer registers a real
    // timeout (held by the McpClient as reconnectTimer).
    fixture.simulateClose();
    expect(client.getState().kind).toBe("disconnected");
    // disconnect → default clearTimer cancels the pending real timeout.
    await client.disconnect();
    expect(client.getState().kind).toBe("closed");
    // Give the (now-cancelled) backoff window a microtask turn to prove the
    // reconnect callback never runs.
    await flushMicrotasks();
    expect(client.getState().kind).toBe("closed");
  });

  test("disconnect rejects the original (never-replaced) deferred + its no-op catch (99,351-353)", async () => {
    // The constructor's initial connectedDeferred (with the no-op catch at
    // line 99) is only *replaced* on a successful connect. If the first
    // connect FAILS we stay on that original deferred. We then park a waiter
    // on it (signalless callTool while disconnected) and disconnect — which
    // rejects the original deferred, firing both the queued-waiter rejection
    // and the line-99 no-op catch.
    let attempt = 0;
    const clientFactory = (info: { name: string; version: string }): Client => {
      attempt += 1;
      if (attempt === 1) {
        // First (explicit connect) attempt fails → disconnected, original
        // deferred preserved.
        return { connect: () => Promise.reject(new Error("first down")) } as unknown as Client;
      }
      return new Client(info, { capabilities: {} });
    };
    let live = createControllableTransport({ toolListResult: { tools: [] } });
    const transportFactory = () => {
      live = createControllableTransport({ toolListResult: { tools: [] } });
      return live.transport;
    };
    const setTimer = (): unknown => Symbol("held"); // hold the reconnect forever
    const clearTimer = (): void => undefined;

    const client = new McpClient("orig", STDIO_CFG, {
      transportFactory,
      clientFactory,
      setTimer,
      clearTimer,
    });

    // Explicit connect fails → disconnected (reconnect scheduled but held).
    const err = await catchErr(client.connect());
    expect(err).toBeInstanceOf(McpConnectionError);
    expect(client.getState().kind).toBe("disconnected");

    // Park a signalless waiter on the original deferred.
    const parked = client.callTool("echo", {});
    await flushMicrotasks(2);
    // disconnect → queuedWaiters > 0 → reject(originalDeferred) → catch(99).
    await client.disconnect();
    const parkedErr = await catchErr(parked);
    expect(parkedErr).toBeInstanceOf(McpConnectionError);
    expect((parkedErr as Error).message).toContain("disconnected");
    expect(client.getState().kind).toBe("closed");
  });
});

describe("defaultClientFactory (376) — real SDK Client over a fake transport", () => {
  test("omitting clientFactory uses the SDK Client and completes the handshake", async () => {
    const fixture = createControllableTransport({
      toolListResult: {
        tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }],
      },
    });
    // No clientFactory → defaultClientFactory builds a real `new Client(...)`.
    const client = new McpClient("realclient", STDIO_CFG, {
      transportFactory: () => fixture.transport,
    });
    await client.connect();
    expect(client.getState().kind).toBe("connected");
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    await client.disconnect();
    expect(client.getState().kind).toBe("closed");
  });
});

describe("defaultTransportFactory (380-402) — real transports, never started", () => {
  // We use the *real* default transportFactory (constructs StdioClientTransport
  // / SSEClientTransport — lazy, no spawn/socket until .start()) and a
  // clientFactory whose connect() rejects immediately so .start() is never
  // reached. No subprocess, no network.
  const failingClientFactory = (): Client =>
    ({
      connect: () => Promise.reject(new Error("no-start")),
    }) as unknown as Client;

  test("stdio branch: command/args/env are constructed without spawning", async () => {
    const cfg: McpServerConfig = {
      transport: "stdio",
      command: "true",
      args: ["--flag", "value"],
      env: { CREWHAUS_TEST: "1" },
    };
    const client = new McpClient("stdio-real", cfg, {
      clientFactory: failingClientFactory,
      // transportFactory intentionally omitted → defaultTransportFactory.
    });
    await expect(client.connect()).rejects.toThrow(McpConnectionError);
    expect(client.getState().kind).toBe("disconnected");
  });

  test("stdio branch without args/env still constructs", async () => {
    const cfg: McpServerConfig = { transport: "stdio", command: "true" };
    const client = new McpClient("stdio-bare", cfg, {
      clientFactory: failingClientFactory,
    });
    await expect(client.connect()).rejects.toThrow(McpConnectionError);
  });

  test("sse branch with headers builds eventSourceInit + requestInit", async () => {
    const cfg: McpServerConfig = {
      transport: "sse",
      url: "http://127.0.0.1:1/sse",
      headers: { Authorization: "Bearer xyz", "X-Crewhaus": "1" },
    };
    const client = new McpClient("sse-headers", cfg, {
      clientFactory: failingClientFactory,
    });
    await expect(client.connect()).rejects.toThrow(McpConnectionError);
    expect(client.getState().kind).toBe("disconnected");
  });

  test("sse branch without headers builds a bare transport", async () => {
    const cfg: McpServerConfig = {
      transport: "sse",
      url: "http://127.0.0.1:1/sse",
    };
    const client = new McpClient("sse-bare", cfg, {
      clientFactory: failingClientFactory,
    });
    await expect(client.connect()).rejects.toThrow(McpConnectionError);
  });
});

describe("makeSseFetch — the SSE eventSourceInit.fetch wrapper", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("merges configured headers over the per-request init headers", async () => {
    // The wrapper is normally invoked only when SSEClientTransport opens its
    // EventSource. We stub global fetch and call the wrapper directly so its
    // body (header merge) runs deterministically, no socket.
    let seenUrl: string | URL | undefined;
    let seenInit: RequestInit | undefined;
    globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    const wrapped = makeSseFetch({ Authorization: "Bearer T", "X-Static": "s" });
    const res = await wrapped("http://example.test/sse", {
      method: "GET",
      headers: { "X-Static": "request-value", "X-Other": "keep" },
    });
    expect(res).toBeInstanceOf(Response);
    expect(seenUrl).toBe("http://example.test/sse");
    expect(seenInit?.method).toBe("GET");
    // Static config header wins over the per-request value; unrelated headers kept.
    expect(seenInit?.headers).toEqual({
      "X-Static": "s",
      "X-Other": "keep",
      Authorization: "Bearer T",
    });
  });

  test("works when the per-request init is undefined", async () => {
    let seenInit: RequestInit | undefined;
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      seenInit = init;
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    const wrapped = makeSseFetch({ "X-Only": "1" });
    await wrapped("http://example.test/sse");
    expect(seenInit?.headers).toEqual({ "X-Only": "1" });
  });
});

describe("wrapAsConnectionError (445-447)", () => {
  test("an McpError thrown by sdk.connect passes through verbatim", async () => {
    // sdk.connect rejects with an McpProtocolError; wrapAsConnectionError must
    // return it unchanged (instanceof McpError branch at 446).
    const original = new McpProtocolError("already-typed connect failure");
    const client = new McpClient("typed", STDIO_CFG, {
      transportFactory: () => createControllableTransport({}).transport,
      clientFactory: () => ({ connect: () => Promise.reject(original) }) as unknown as Client,
    });
    await expect(client.connect()).rejects.toBe(original);
  });

  test("a non-Error rejection yields the bare fallback message (447)", async () => {
    // sdk.connect rejects with a non-Error (string) → fallback w/o `: msg`.
    const client = new McpClient("nonerr", STDIO_CFG, {
      transportFactory: () => createControllableTransport({}).transport,
      clientFactory: () =>
        ({ connect: () => Promise.reject("plain string failure") }) as unknown as Client,
    });
    await expect(client.connect()).rejects.toThrow(McpConnectionError);
    await client.connect().catch((err: unknown) => {
      expect((err as Error).message).toBe('mcp connect to "nonerr" failed');
      expect((err as McpConnectionError).cause).toBe("plain string failure");
    });
  });
});

describe("wrapAsCallError (451-457)", () => {
  const cfg = STDIO_CFG;

  test("an McpError from sdk.callTool passes through verbatim (452)", async () => {
    const typed = new McpProtocolError("typed call failure");
    const fixture = createControllableTransport({
      toolListResult: { tools: [{ name: "t", inputSchema: { type: "object" } }] },
    });
    const realClient = new Client({ name: "x", version: "0" }, { capabilities: {} });
    // Patch callTool to reject with an McpError after a real connect.
    const client = new McpClient("c", cfg, {
      transportFactory: () => fixture.transport,
      clientFactory: () => realClient,
    });
    await client.connect();
    (realClient as unknown as { callTool: () => Promise<never> }).callTool = () =>
      Promise.reject(typed);
    await expect(client.callTool("t", {})).rejects.toBe(typed);
    await client.disconnect();
  });

  test("an AbortError becomes McpConnectionError (454-455)", async () => {
    const fixture = createControllableTransport({
      toolListResult: { tools: [{ name: "t", inputSchema: { type: "object" } }] },
    });
    const realClient = new Client({ name: "x", version: "0" }, { capabilities: {} });
    const client = new McpClient("c", cfg, {
      transportFactory: () => fixture.transport,
      clientFactory: () => realClient,
    });
    await client.connect();
    const abortErr = Object.assign(new Error("operation aborted"), { name: "AbortError" });
    (realClient as unknown as { callTool: () => Promise<never> }).callTool = () =>
      Promise.reject(abortErr);
    await expect(client.callTool("t", {})).rejects.toThrow(McpConnectionError);
    await client
      .callTool("t", {})
      .catch((err: unknown) => expect((err as McpConnectionError).cause).toBe(abortErr));
    await client.disconnect();
  });

  test("a generic Error becomes McpProtocolError with `: message` (457)", async () => {
    const fixture = createControllableTransport({
      toolListResult: { tools: [{ name: "t", inputSchema: { type: "object" } }] },
    });
    const realClient = new Client({ name: "x", version: "0" }, { capabilities: {} });
    const client = new McpClient("c", cfg, {
      transportFactory: () => fixture.transport,
      clientFactory: () => realClient,
    });
    await client.connect();
    (realClient as unknown as { callTool: () => Promise<never> }).callTool = () =>
      Promise.reject(new Error("kaboom"));
    await expect(client.callTool("t", {})).rejects.toThrow(McpProtocolError);
    await client.callTool("t", {}).catch((err: unknown) => {
      expect((err as Error).message).toBe('mcp call "c.t" failed: kaboom');
    });
    await client.disconnect();
  });

  test("a non-Error rejection becomes McpProtocolError with the bare fallback (457)", async () => {
    const fixture = createControllableTransport({
      toolListResult: { tools: [{ name: "t", inputSchema: { type: "object" } }] },
    });
    const realClient = new Client({ name: "x", version: "0" }, { capabilities: {} });
    const client = new McpClient("c", cfg, {
      transportFactory: () => fixture.transport,
      clientFactory: () => realClient,
    });
    await client.connect();
    (realClient as unknown as { callTool: () => Promise<never> }).callTool = () =>
      Promise.reject({ name: "weird", payload: 42 });
    await client.callTool("t", {}).catch((err: unknown) => {
      expect(err).toBeInstanceOf(McpProtocolError);
      expect((err as Error).message).toBe('mcp call "c.t" failed');
    });
    await client.disconnect();
  });
});

describe("raceWithSignal (491-516) via ensureConnected during reconnect", () => {
  /**
   * `raceWithSignal` only runs when `callTool` is invoked while the client is
   * `disconnected` (so `ensureConnected` awaits `connectedDeferred`) AND a
   * signal is supplied. We connect, fire the live transport's `onclose` to
   * drop into `disconnected` with the reconnect timer *held* (never fired),
   * then issue a signalled call that parks on the deferred.
   */
  function buildHarness(): {
    client: McpClient;
    closeLive: () => void;
    fireReconnect: () => void;
  } {
    let live = createControllableTransport({
      toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
    });
    let firstHandedOut = false;
    const transportFactory = () => {
      if (!firstHandedOut) {
        firstHandedOut = true;
        return live.transport;
      }
      live = createControllableTransport({
        toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      });
      return live.transport;
    };
    let heldTimer: (() => void) | null = null;
    const setTimer = (cb: () => void): unknown => {
      heldTimer = cb;
      return Symbol("t");
    };
    const clearTimer = (): void => {
      heldTimer = null;
    };
    const client = new McpClient("sig", STDIO_CFG, {
      transportFactory,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
      setTimer,
      clearTimer,
    });
    return {
      client,
      closeLive: () => live.simulateClose(),
      fireReconnect: () => heldTimer?.(),
    };
  }

  test("signal === undefined short-circuits to the raw promise (496) — control", async () => {
    // ensureConnected with no signal while disconnected returns the deferred
    // promise directly (raceWithSignal early-return at 496). We fire the
    // reconnect so it resolves and the call completes.
    const h = buildHarness();
    await h.client.connect();
    h.closeLive();
    await flushMicrotasks();
    expect(h.client.getState().kind).toBe("disconnected");
    const callP = h.client.callTool("echo", {}); // no signal
    h.fireReconnect();
    await flushMicrotasks();
    const r = await callP;
    expect(r.isError).toBe(false);
    await h.client.disconnect();
  });

  test("pre-aborted signal trips the dispatch guard before the race (243)", async () => {
    // A signal already aborted at dispatch is caught by callTool's own guard
    // (line 243) and never reaches raceWithSignal — documents why the
    // signal.aborted check inside the race is defensive (see note below).
    const h = buildHarness();
    await h.client.connect();
    h.closeLive();
    await flushMicrotasks();
    expect(h.client.getState().kind).toBe("disconnected");

    const ac = new AbortController();
    ac.abort();
    const err = await catchErr(h.client.callTool("echo", {}, { signal: ac.signal }));
    expect(err).toBeInstanceOf(McpConnectionError);
    expect((err as Error).message).toContain("aborted before dispatch");
    await h.client.disconnect();
  });

  test("abort while parked on the deferred rejects via the abort listener (498-500,506)", async () => {
    const h = buildHarness();
    await h.client.connect();
    h.closeLive();
    await flushMicrotasks();
    expect(h.client.getState().kind).toBe("disconnected");

    const ac = new AbortController();
    const callP = h.client.callTool("echo", {}, { signal: ac.signal });
    // Abort while the call is parked inside raceWithSignal awaiting the
    // deferred → onAbort listener fires (498-500), removeEventListener + reject.
    await flushMicrotasks(2);
    ac.abort();
    const err = await catchErr(callP);
    expect(err).toBeInstanceOf(McpConnectionError);
    expect((err as Error).message).toContain("aborted while waiting for reconnect");
    await h.client.disconnect();
  });

  test("deferred resolves first → race resolves and removes the abort listener (507-511)", async () => {
    const h = buildHarness();
    await h.client.connect();
    h.closeLive();
    await flushMicrotasks();
    expect(h.client.getState().kind).toBe("disconnected");

    const ac = new AbortController();
    const callP = h.client.callTool("echo", {}, { signal: ac.signal });
    // Fire the reconnect so connect succeeds and connectedDeferred resolves,
    // which resolves the race's promise branch (507-511) before any abort.
    h.fireReconnect();
    await flushMicrotasks();
    const r = await callP;
    expect(r.isError).toBe(false);
    // Aborting now must be a no-op (listener already removed).
    ac.abort();
    await flushMicrotasks();
    await h.client.disconnect();
  });

  test("deferred rejects (disconnect mid-wait) → race rejects branch (512-515)", async () => {
    const h = buildHarness();
    await h.client.connect();
    h.closeLive();
    await flushMicrotasks();
    expect(h.client.getState().kind).toBe("disconnected");

    const ac = new AbortController();
    const callP = h.client.callTool("echo", {}, { signal: ac.signal });
    // Park, then disconnect() — which rejects the pending connectedDeferred
    // (queuedWaiters > 0). The race's reject branch (512-515) propagates it.
    await flushMicrotasks(2);
    await h.client.disconnect();
    const err = await catchErr(callP);
    expect(err).toBeInstanceOf(McpConnectionError);
  });
});

describe("eventBus mcp_call_start / mcp_call_end", () => {
  function busFixture() {
    const events: TraceEvent[] = [];
    const bus = new TraceEventBus({ runId: "r", sessionId: "s" });
    bus.subscribe((e) => {
      events.push(e);
    });
    return { bus, events };
  }

  test("successful callTool emits paired start/end with isError false", async () => {
    const { bus, events } = busFixture();
    const fixture = createControllableTransport({
      toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      callResultByTool: {
        echo: () => ({ content: [{ type: "text", text: "hi" }], isError: false }),
      },
    });
    const client = new McpClient("bus", STDIO_CFG, {
      transportFactory: () => fixture.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
      eventBus: bus,
    });
    await client.connect();
    const r = await client.callTool("echo", {});
    expect(r.content).toBe("hi");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("mcp_call_start");
    expect(kinds).toContain("mcp_call_end");
    const start = events.find((e) => e.kind === "mcp_call_start") as {
      server: string;
      toolName: string;
      spanId: string;
    };
    const end = events.find((e) => e.kind === "mcp_call_end") as {
      server: string;
      toolName: string;
      spanId: string;
      isError: boolean;
      durationMs: number;
    };
    expect(start.server).toBe("bus");
    expect(start.toolName).toBe("echo");
    // Paired events reuse the same spanId.
    expect(end.spanId).toBe(start.spanId);
    expect(end.isError).toBe(false);
    expect(typeof end.durationMs).toBe("number");
    await client.disconnect();
  });

  test("isError result emits mcp_call_end with isError true", async () => {
    const { bus, events } = busFixture();
    const fixture = createControllableTransport({
      toolListResult: { tools: [{ name: "bad", inputSchema: { type: "object" } }] },
      callResultByTool: {
        bad: () => ({ content: [{ type: "text", text: "nope" }], isError: true }),
      },
    });
    const client = new McpClient("bus", STDIO_CFG, {
      transportFactory: () => fixture.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
      eventBus: bus,
    });
    await client.connect();
    const r = await client.callTool("bad", {});
    expect(r.isError).toBe(true);
    const end = events.find((e) => e.kind === "mcp_call_end") as { isError: boolean };
    expect(end.isError).toBe(true);
    await client.disconnect();
  });

  test("callTool error path emits mcp_call_end with isError true (274-283)", async () => {
    const { bus, events } = busFixture();
    const fixture = createControllableTransport({
      toolListResult: { tools: [{ name: "boom", inputSchema: { type: "object" } }] },
    });
    const realClient = new Client({ name: "x", version: "0" }, { capabilities: {} });
    const client = new McpClient("bus", STDIO_CFG, {
      transportFactory: () => fixture.transport,
      clientFactory: () => realClient,
      eventBus: bus,
    });
    await client.connect();
    (realClient as unknown as { callTool: () => Promise<never> }).callTool = () =>
      Promise.reject(new Error("call exploded"));
    await expect(client.callTool("boom", {})).rejects.toThrow(McpProtocolError);
    const end = events.find((e) => e.kind === "mcp_call_end") as {
      isError: boolean;
      spanId: string;
    };
    const start = events.find((e) => e.kind === "mcp_call_start") as { spanId: string };
    expect(end.isError).toBe(true);
    expect(end.spanId).toBe(start.spanId);
    await client.disconnect();
  });
});

describe("disconnect error path (367-371) + idle lazy-connect (315-319)", () => {
  test("transport.close() throwing during disconnect is logged and swallowed", async () => {
    const warnLogs: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn(msg: string) {
        warnLogs.push(msg);
      },
      error() {},
      child() {
        return logger;
      },
    } as unknown as import("@crewhaus/logging").Logger;
    let onclose: (() => void) | undefined;
    let onmessage: ((m: JSONRPCMessage) => void) | undefined;
    const throwingTransport: Transport = {
      async start() {},
      async send(message: JSONRPCMessage) {
        if (!("method" in message) || !("id" in message)) return;
        const req = message as { id: string | number; method: string };
        const result =
          req.method === "initialize"
            ? {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "f", version: "0" },
              }
            : {};
        queueMicrotask(() => onmessage?.({ jsonrpc: "2.0", id: req.id, result } as JSONRPCMessage));
      },
      async close() {
        throw new Error("close failed hard");
      },
      set onmessage(h) {
        onmessage = h;
      },
      get onmessage() {
        return onmessage;
      },
      set onclose(h) {
        onclose = h;
      },
      get onclose() {
        return onclose;
      },
    };
    const client = new McpClient("dc", STDIO_CFG, {
      transportFactory: () => throwingTransport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
      logger,
    });
    await client.connect();
    // Must not reject even though transport.close() throws.
    await client.disconnect();
    expect(client.getState().kind).toBe("closed");
    expect(warnLogs).toContain("mcp.disconnect_error");
  });

  test("callTool from idle triggers the lazy first-call connect (315-319)", async () => {
    const fixture = createControllableTransport({
      toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      callResultByTool: {
        echo: () => ({ content: [{ type: "text", text: "lazy" }], isError: false }),
      },
    });
    const client = new McpClient("lazy", STDIO_CFG, {
      transportFactory: () => fixture.transport,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
    });
    expect(client.getState().kind).toBe("idle");
    // No explicit connect(): callTool must lazily connect from idle.
    const r = await client.callTool("echo", {});
    expect(r.content).toBe("lazy");
    expect(client.getState().kind).toBe("connected");
    await client.disconnect();
  });

  test("reconnect queue cap rejects the 17th waiter (321-324)", async () => {
    // Park QUEUE_CAP (16) waiters on the deferred, then the 17th is rejected.
    let live = createControllableTransport({
      toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
    });
    let first = false;
    const transportFactory = () => {
      if (!first) {
        first = true;
        return live.transport;
      }
      live = createControllableTransport({
        toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      });
      return live.transport;
    };
    const setTimer = (): unknown => Symbol("held"); // hold reconnect forever
    const clearTimer = (): void => undefined;
    const client = new McpClient("cap", STDIO_CFG, {
      transportFactory,
      clientFactory: (info) => new Client(info, { capabilities: {} }),
      setTimer,
      clearTimer,
    });
    await client.connect();
    live.simulateClose();
    await flushMicrotasks();
    expect(client.getState().kind).toBe("disconnected");

    const parked: Array<Promise<unknown>> = [];
    for (let i = 0; i < 16; i++) {
      const p = client.callTool("echo", {}).catch((e) => e);
      parked.push(p);
    }
    await flushMicrotasks(2);
    // 17th call exceeds QUEUE_CAP → rejects synchronously-ish.
    await expect(client.callTool("echo", {})).rejects.toThrow(/reconnect queue full/);
    // Cleanup: disconnect rejects the 16 parked waiters.
    await client.disconnect();
    await Promise.all(parked);
  });
});
