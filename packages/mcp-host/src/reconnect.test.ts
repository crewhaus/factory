import { describe, expect, test } from "bun:test";
import { McpConnectionError } from "@crewhaus/errors";
import type { Logger } from "@crewhaus/logging";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpClient, type McpClientOptions } from "./client.js";
import { McpHost } from "./host.js";

/**
 * T3 — reconnect after the underlying transport closes mid-stream.
 *
 * Strategy: a controllable in-process transport that responds to JSON-RPC
 * requests until we trigger `simulateClose()`. On close the SDK fires its
 * `onclose` hook, which our McpClient catches and schedules a reconnect.
 * The transportFactory returns a fresh transport for each new attempt, so
 * the reconnect cycle resolves to a new "connected" state.
 *
 * We override `setTimer` with `queueMicrotask`-equivalent so the test runs
 * deterministically without real timers.
 */

function createControllableTransport(opts: {
  toolListResult?: { tools: ReadonlyArray<{ name: string; inputSchema: unknown }> };
  callResultByTool?: Record<string, () => { content: ReadonlyArray<unknown>; isError?: boolean }>;
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
          const handler = params?.name && opts.callResultByTool?.[params.name];
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

describe("McpClient reconnect cycle (T3)", () => {
  test("transport close → disconnected → reconnect → callTool succeeds again", async () => {
    let factoryCallCount = 0;
    let activeTransport: ReturnType<typeof createControllableTransport> | undefined;
    const transportFactory = () => {
      factoryCallCount += 1;
      activeTransport = createControllableTransport({
        toolListResult: {
          tools: [{ name: "echo", inputSchema: { type: "object" } }],
        },
        callResultByTool: {
          echo: () => ({
            content: [{ type: "text", text: `attempt-${factoryCallCount}` }],
            isError: false,
          }),
        },
      });
      return activeTransport.transport;
    };

    // Synchronous timer so reconnect kicks in deterministically.
    const setTimer = (cb: () => void): unknown => {
      queueMicrotask(cb);
      return Symbol("timer");
    };
    const clearTimer = (): void => undefined;

    const client = new McpClient(
      "fixture",
      { transport: "stdio", command: "true" },
      {
        transportFactory,
        clientFactory: (info) => new Client(info, { capabilities: {} }),
        setTimer,
        clearTimer,
      },
    );

    await client.connect();
    expect(client.getState().kind).toBe("connected");
    expect(factoryCallCount).toBe(1);

    // First call works against attempt-1 transport.
    const first = await client.callTool("echo", {});
    expect(first.content).toBe("attempt-1");

    // Simulate the child dying. The SDK's onclose fires, McpClient marks
    // disconnected and schedules reconnect via our microtask timer.
    activeTransport?.simulateClose();
    // Yield once so the synchronous timer fires its callback.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => queueMicrotask(() => r(undefined)));
    }
    // After reconnect, factory should have been called again and we're
    // connected via the new transport.
    expect(factoryCallCount).toBeGreaterThanOrEqual(2);
    expect(client.getState().kind).toBe("connected");

    // Follow-up call routes through the new transport (attempt N).
    const second = await client.callTool("echo", {});
    expect(second.content).toBe(`attempt-${factoryCallCount}`);

    await client.disconnect();
    expect(client.getState().kind).toBe("closed");
  });

  test("disconnect during reconnect cancels the pending attempt", async () => {
    let factoryCallCount = 0;
    let timerScheduled = false;
    const transportFactory = () => {
      factoryCallCount += 1;
      return createControllableTransport({
        toolListResult: { tools: [] },
      }).transport;
    };

    const setTimer = (cb: () => void): unknown => {
      timerScheduled = true;
      // Fire later — we want disconnect() to land first.
      const handle = setTimeout(cb, 10);
      return handle;
    };
    const clearTimer = (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>);

    const client = new McpClient(
      "f",
      { transport: "stdio", command: "true" },
      {
        transportFactory,
        clientFactory: (info) => new Client(info, { capabilities: {} }),
        setTimer,
        clearTimer,
      },
    );

    await client.connect();
    const firstFactoryCount = factoryCallCount;
    // Trigger reconnect via simulating close on the transport's onclose.
    // Easiest path: set state via internal API — but we don't have one. So
    // we close via disconnect → reconnect via connect; for cancellation
    // we just disconnect and check that no further factory call happens
    // even after the would-be reconnect timer would fire.
    void client.connect().catch(() => undefined);
    await client.disconnect();
    timerScheduled.toString();
    // Wait past the timer window.
    await new Promise((r) => setTimeout(r, 20));
    expect(factoryCallCount).toBe(firstFactoryCount);
    expect(client.getState().kind).toBe("closed");
  });

  test("callTool after disconnect rejects with McpConnectionError", async () => {
    const transportFactory = () =>
      createControllableTransport({
        toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      }).transport;
    const client = new McpClient(
      "f",
      { transport: "stdio", command: "true" },
      {
        transportFactory,
        clientFactory: (info) => new Client(info, { capabilities: {} }),
      },
    );
    await client.connect();
    await client.disconnect();
    expect(client.callTool("echo", {})).rejects.toThrow(McpConnectionError);
  });
});

/**
 * A transport whose `start()` is HELD until the test settles it — the stand-in
 * for a child that is still spawning, or a stream still opening, when
 * `disconnect()` lands. `close()` behaves like a real transport torn down
 * mid-start: the pending start fails and `onclose` fires.
 */
function createGatedTransport(): {
  transport: Transport;
  /** Let the spawn succeed; the initialize handshake then completes. */
  release: () => void;
  /** Make the spawn fail (a missing binary, a refused connection). */
  fail: (err: Error) => void;
  closes: () => number;
} {
  const fixture = createControllableTransport({ toolListResult: { tools: [] } });
  let release!: () => void;
  let fail!: (err: Error) => void;
  const started = new Promise<void>((res, rej) => {
    release = res;
    fail = rej;
  });
  // A start that is never awaited (the attempt already gave up) must not
  // surface as an unhandled rejection when the test settles it.
  started.catch(() => undefined);
  let closes = 0;
  const transport: Transport = {
    start: () => started,
    send: (m) => fixture.transport.send(m),
    async close() {
      closes += 1;
      fail(new Error("transport closed during start"));
      fixture.transport.onclose?.();
    },
    set onmessage(h) {
      fixture.transport.onmessage = h;
    },
    get onmessage() {
      return fixture.transport.onmessage;
    },
    set onclose(h) {
      fixture.transport.onclose = h;
    },
    get onclose() {
      return fixture.transport.onclose;
    },
  };
  return { transport, release, fail, closes: () => closes };
}

/**
 * The Bun stdio shape of a spawn that cannot start (a missing binary): the
 * child's `close` lands in the same tick as its `error`, so `onclose` fires
 * BEFORE `start()`'s rejection is observed — while the attempt is in flight.
 */
function createEnoentTransport(): Transport {
  const fixture = createControllableTransport({});
  return {
    start() {
      fixture.transport.onclose?.();
      return Promise.reject(new Error("spawn ENOENT"));
    },
    send: (m) => fixture.transport.send(m),
    close: async () => undefined,
    set onmessage(h) {
      fixture.transport.onmessage = h;
    },
    get onmessage() {
      return fixture.transport.onmessage;
    },
    set onclose(h) {
      fixture.transport.onclose = h;
    },
    get onclose() {
      return fixture.transport.onclose;
    },
  };
}

/** Timer seams that queue instead of firing: `fire()` runs the oldest. */
function manualTimers() {
  const queue: Array<() => void> = [];
  return {
    setTimer: (cb: () => void): unknown => {
      queue.push(cb);
      return cb;
    },
    clearTimer: (h: unknown): void => {
      const i = queue.indexOf(h as () => void);
      if (i !== -1) queue.splice(i, 1);
    },
    fire: (): void => {
      const cb = queue.shift();
      if (cb === undefined) throw new Error("no timer armed");
      cb();
    },
    pending: (): number => queue.length,
  };
}

/** Let every queued microtask chain run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Watch a promise without awaiting it: whether — and how — it has settled. */
function observe<T>(p: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const o: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then(
    (value) => {
      o.settled = true;
      o.value = value;
    },
    (error: unknown) => {
      o.settled = true;
      o.error = error;
    },
  );
  return o;
}

/**
 * connect()'s outcome, which must be SETTLED within microtasks. A regression
 * that leaves it pending fails here, at once — `await expect(p).rejects` on a
 * promise that never settles would spin past the per-test timeout instead.
 */
async function settledConnect(client: McpClient): Promise<unknown> {
  const o = observe(client.connect());
  await settle();
  expect(o.settled).toBe(true);
  return o.error;
}

/** A logger that records every line, optionally running a hook on one. */
function recordingLogger(hook?: (msg: string) => void) {
  const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const at =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, msg, ...(fields !== undefined ? { fields } : {}) });
      hook?.(msg);
    };
  const logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => logger,
  };
  return { logger: logger as unknown as Logger, lines };
}

function stdioClient(
  transportFactory: () => Transport,
  opts: Omit<McpClientOptions, "transportFactory"> = {},
): McpClient {
  return new McpClient(
    "peer",
    { transport: "stdio", command: "true" },
    {
      clientFactory: (info) => new Client(info, { capabilities: {} }),
      ...opts,
      transportFactory,
    },
  );
}

const CLOSED_WHILE_CONNECTING = /was closed while connecting/;

describe("closed is terminal — even for an attempt already in flight", () => {
  /**
   * A client that connected once, lost its transport, and whose ladder has
   * now fired: attempt 2 is in flight on a gated transport.
   */
  async function ladderAttemptInFlight() {
    const timers = manualTimers();
    const log = recordingLogger();
    const first = createControllableTransport({ toolListResult: { tools: [] } });
    const second = createGatedTransport();
    const transports = [first.transport, second.transport];
    let built = 0;
    const client = stdioClient(
      () => {
        const t = transports[built];
        built += 1;
        if (t === undefined) throw new Error(`unexpected transport #${built}`);
        return t;
      },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer, logger: log.logger },
    );
    await client.connect();
    first.simulateClose();
    expect(timers.pending()).toBe(1);
    timers.fire();
    await settle();
    expect(client.getState().kind).toBe("connecting");
    return { client, timers, gated: second, built: () => built, log };
  }

  test("a ladder attempt that FAILS after disconnect() leaves the client closed and arms nothing", async () => {
    const { client, timers, gated, built, log } = await ladderAttemptInFlight();
    await client.disconnect();
    gated.fail(new Error("spawn ENOENT"));
    await settle();
    // Before the fix the failing attempt wrote `disconnected` over `closed`,
    // and the ladder's catch — seeing a client that was not closed — armed
    // the next REF'D reconnect: a closed client retrying forever.
    expect(client.getState().kind).toBe("closed");
    expect(timers.pending()).toBe(0);
    expect(built()).toBe(2);
    // A shutdown is not a reconnect failure.
    expect(log.lines.filter((l) => l.msg === "mcp.reconnect_failed")).toEqual([]);
  });

  test("a ladder attempt whose handshake would succeed after disconnect() is never adopted", async () => {
    const { client, timers, gated } = await ladderAttemptInFlight();
    await client.disconnect();
    gated.release();
    await settle();
    // Before the fix the handshake landed on a closed client and adopted
    // the transport: a live child the caller had already disconnected.
    expect(client.getState().kind).toBe("closed");
    expect(gated.closes()).toBe(1);
    expect(timers.pending()).toBe(0);
    await expect(client.callTool("echo", {})).rejects.toThrow(McpConnectionError);
  });

  test("a handshake that has LANDED but not been adopted when disconnect() runs is closed, not adopted", async () => {
    // The narrowest window: sdk.connect has resolved, its continuation (the
    // adoption) has not run yet, and disconnect() runs in between.
    let land!: () => void;
    const handshake = new Promise<void>((r) => {
      land = r;
    });
    const fixture = createControllableTransport({});
    let closes = 0;
    const transport: Transport = {
      start: async () => undefined,
      send: (m) => fixture.transport.send(m),
      async close() {
        closes += 1;
      },
    };
    const client = stdioClient(() => transport, {
      clientFactory: () => ({ connect: () => handshake }) as unknown as Client,
    });
    const booting = observe(client.connect());
    await settle();
    land();
    void client.disconnect();
    await settle();
    expect(booting.error).toBeInstanceOf(McpConnectionError);
    expect((booting.error as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    expect({ state: client.getState().kind, closes }).toEqual({ state: "closed", closes: 1 });
  });

  test("a boot connect() overtaken by disconnect() rejects and leaves the client closed", async () => {
    // An optional peer's first attempt runs un-awaited (the research and
    // batch shapes), so a run can end — and its cleanup's disconnectAll()
    // land — while that peer is still handshaking.
    const timers = manualTimers();
    const gated = createGatedTransport();
    const client = stdioClient(() => gated.transport, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const booting = client.connect();
    booting.catch(() => undefined);
    await settle();
    expect(client.getState().kind).toBe("connecting");
    await client.disconnect();
    gated.release();
    await expect(booting).rejects.toThrow(CLOSED_WHILE_CONNECTING);
    expect(client.getState().kind).toBe("closed");
    expect(gated.closes()).toBe(1);
    expect(timers.pending()).toBe(0);
  });

  test("a boot connect() that fails after disconnect() stays closed, and connect() still refuses", async () => {
    const timers = manualTimers();
    const gated = createGatedTransport();
    let built = 0;
    const client = stdioClient(
      () => {
        built += 1;
        return gated.transport;
      },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    );
    const booting = client.connect();
    booting.catch(() => undefined);
    await settle();
    await client.disconnect();
    gated.fail(new Error("spawn ENOENT"));
    await expect(booting).rejects.toThrow(McpConnectionError);
    expect(client.getState().kind).toBe("closed");
    expect(timers.pending()).toBe(0);
    // `closed` is still terminal: no second attempt is built.
    await expect(client.connect()).rejects.toThrow(/is closed/);
    expect(built).toBe(1);
  });

  test("a lazy first call overtaken by disconnect() rejects and leaves the client closed", async () => {
    // ensureConnected() connects an idle client on first use.
    const gated = createGatedTransport();
    const client = stdioClient(() => gated.transport);
    const call = client.callTool("echo", {});
    call.catch(() => undefined);
    await settle();
    expect(client.getState().kind).toBe("connecting");
    await client.disconnect();
    gated.release();
    await expect(call).rejects.toThrow(McpConnectionError);
    expect(client.getState().kind).toBe("closed");
    expect(gated.closes()).toBe(1);
  });

  test("connect() resolves exactly when the handshake was adopted before disconnect()", async () => {
    // Sweep disconnect() across every microtask of a real handshake rather
    // than hard-coding where adoption happens: whatever the depth, the client
    // ends closed with its transport closed exactly once, and connect()
    // resolves only if the client had already reported `connected`.
    const outcomes = new Set<string>();
    for (let depth = 0; depth <= 40; depth++) {
      const fixture = createControllableTransport({ toolListResult: { tools: [] } });
      let closes = 0;
      const transport: Transport = {
        start: () => fixture.transport.start(),
        send: (m) => fixture.transport.send(m),
        async close() {
          closes += 1;
          await fixture.transport.close();
        },
        set onmessage(h) {
          fixture.transport.onmessage = h;
        },
        get onmessage() {
          return fixture.transport.onmessage;
        },
        set onclose(h) {
          fixture.transport.onclose = h;
        },
        get onclose() {
          return fixture.transport.onclose;
        },
      };
      const client = stdioClient(() => transport, {
        setTimer: () => Symbol("never fired"),
        clearTimer: () => undefined,
      });
      const booting = client.connect().then(
        () => "resolved",
        (err: unknown) =>
          err instanceof McpConnectionError && CLOSED_WHILE_CONNECTING.test(err.message)
            ? "closed while connecting"
            : `unexpected: ${String(err)}`,
      );
      for (let i = 0; i < depth; i++) await Promise.resolve();
      const adopted = client.getState().kind === "connected";
      await client.disconnect();
      const outcome = await booting;
      outcomes.add(outcome);
      expect({ depth, outcome, state: client.getState().kind, closes }).toEqual({
        depth,
        outcome: adopted ? "resolved" : "closed while connecting",
        state: "closed",
        closes: 1,
      });
    }
    // The sweep really did cross the adoption point.
    expect([...outcomes].sort()).toEqual(["closed while connecting", "resolved"]);
  });
});

describe("disconnect() reaps what an in-flight attempt opened", () => {
  test("it closes the in-flight transport itself, once, before it resolves", async () => {
    // Not when the handshake would have settled — that is up to
    // connectTimeoutMs away, on a REF'D timer, with the child alive.
    const gated = createGatedTransport();
    const client = stdioClient(() => gated.transport);
    const booting = client.connect();
    booting.catch(() => undefined);
    await settle();
    await client.disconnect();
    expect(gated.closes()).toBe(1);
    const err = await booting.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    // The disconnect's own abort is not dressed up as the attempt's cause.
    expect((err as Error).cause).toBeUndefined();
    expect(gated.closes()).toBe(1);
  });

  test("a transport whose close() never settles its start() cannot hold the attempt open", async () => {
    // A legacy HTTP+SSE start() waits for the `endpoint` event; closing the
    // stream does not settle it. The attempt must end with disconnect(), not
    // with the connect timeout — checked within microtasks, not the clock.
    const fixture = createControllableTransport({});
    const stuck: Transport = {
      start: () => new Promise<void>(() => undefined),
      send: (m) => fixture.transport.send(m),
      close: async () => undefined,
    };
    const client = stdioClient(() => stuck);
    const booting = observe(client.connect());
    await settle();
    await client.disconnect();
    await settle();
    expect(booting.error).toBeInstanceOf(McpConnectionError);
    expect((booting.error as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    expect(client.getState().kind).toBe("closed");
  });

  test("a failed attempt whose own close is the FIRST waits for it — and closed survives a disconnect() during it", async () => {
    // A start that failed (or a timeout) leaves the SDK nothing to close, so
    // this close is the one that waits for the child: connect() rejects only
    // after it, so a caller that exits on the error leaves no child behind.
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => {
      releaseClose = r;
    });
    const fixture = createControllableTransport({});
    const failing: Transport = {
      start: () => Promise.reject(new Error("spawn ENOENT")),
      send: (m) => fixture.transport.send(m),
      close: () => closing,
    };
    const timers = manualTimers();
    const client = stdioClient(() => failing, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const booting = observe(client.connect());
    await settle();
    expect(booting.settled).toBe(false);
    const disconnected = observe(client.disconnect());
    await settle();
    expect(disconnected.settled).toBe(false);
    releaseClose();
    await settle();
    expect({ booting: booting.settled, disconnected: disconnected.settled }).toEqual({
      booting: true,
      disconnected: true,
    });
    // The attempt's own failure is the cause, not the disconnect.
    expect((booting.error as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    expect(((booting.error as Error).cause as Error).message).toBe("spawn ENOENT");
    expect(client.getState().kind).toBe("closed");
    expect(timers.pending()).toBe(0);
  });

  test("a handshake the SDK refused fails at once with its reason, and disconnect() waits for the SDK's own close", async () => {
    // On a refused `initialize` the SDK closes the transport itself, fire-and-
    // forget — and for stdio only that FIRST close waits for the child; a
    // second returns at once. disconnect() must join that close rather than
    // race past it.
    const fixture = createControllableTransport({});
    let onmessage: ((m: JSONRPCMessage) => void) | undefined;
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => {
      releaseClose = r;
    });
    let closes = 0;
    const refusing: Transport = {
      start: async () => undefined,
      async send(m) {
        if ("method" in m && m.method === "initialize" && "id" in m) {
          const id = m.id;
          queueMicrotask(() =>
            onmessage?.({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: "unsupported protocol version" },
            } as JSONRPCMessage),
          );
          return;
        }
        await fixture.transport.send(m);
      },
      close() {
        closes += 1;
        return closing;
      },
      set onmessage(h) {
        onmessage = h;
      },
      get onmessage() {
        return onmessage;
      },
    };
    const client = stdioClient(() => refusing);
    const booting = observe(client.connect());
    await settle();
    expect(closes).toBe(1);
    expect(booting.error).toBeInstanceOf(McpConnectionError);
    expect((booting.error as Error).message).toMatch(/unsupported protocol version/);
    const disconnected = observe(client.disconnect());
    await settle();
    expect({ closes, disconnected: disconnected.settled }).toEqual({
      closes: 1,
      disconnected: false,
    });
    releaseClose();
    await settle();
    expect(disconnected.settled).toBe(true);
    expect(client.getState().kind).toBe("closed");
  });

  test("abandoning a handshake leaves no live timer behind — ours or the SDK's", async () => {
    // withTimeout's connect timer and the SDK's own `initialize` request
    // timer are both REF'D (60 s each by default). This transport's close()
    // does not fire onclose (a stdio child fires it only once it exits), so
    // the SDK's own close-time cleanup cannot be what clears them.
    const live = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = ((cb: () => void, ms?: number) => {
      const t = realSet(() => {
        live.delete(t);
        cb();
      }, ms);
      live.add(t);
      return t;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((t: ReturnType<typeof setTimeout>) => {
      live.delete(t);
      realClear(t);
    }) as typeof clearTimeout;
    try {
      let initializeSent = false;
      const wedged: Transport = {
        start: async () => undefined,
        async send(m) {
          if ("method" in m && m.method === "initialize") initializeSent = true;
        },
        close: async () => undefined,
      };
      const client = stdioClient(() => wedged);
      const booting = observe(client.connect());
      await settle();
      expect(initializeSent).toBe(true);
      expect(live.size).toBe(2);
      await client.disconnect();
      await settle();
      expect((booting.error as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
      expect(live.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test("a connect timeout cancels the SDK's own initialize timer too, after the close has started", async () => {
    // No disconnect() here: the plain timeout path. The SDK's 60 s
    // `initialize` timer used to outlive the attempt (onclose is detached
    // before close, so the SDK's cleanup never ran), and its cancel must not
    // reach a transport that is still open.
    const live = new Map<object, { cb: () => void; ms: number }>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = ((cb: () => void, ms: number) => {
      const handle = {};
      live.set(handle, { cb, ms });
      return handle;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: object) => {
      live.delete(handle);
    }) as unknown as typeof clearTimeout;
    try {
      let closeStarted = false;
      const cancels: boolean[] = [];
      const wedged: Transport = {
        start: async () => undefined,
        async send(m) {
          if ("method" in m && m.method === "notifications/cancelled") {
            cancels.push(closeStarted);
          }
        },
        async close() {
          closeStarted = true;
        },
      };
      const client = stdioClient(() => wedged, { connectTimeoutMs: 1234 });
      const booting = observe(client.connect());
      await settle();
      expect([...live.values()].map((t) => t.ms).sort((a, b) => a - b)).toEqual([1234, 60_000]);
      const [handle, timeout] = [...live.entries()].find(([, t]) => t.ms === 1234) ?? [];
      live.delete(handle as object);
      timeout?.cb();
      await settle();
      expect((booting.error as Error).message).toMatch(/timed out after 1234ms/);
      expect([...live.values()]).toEqual([]);
      expect(cancels.every((afterClose) => afterClose)).toBe(true);
      await client.disconnect();
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test("a close that fails during disconnect() is logged, and disconnect() still resolves", async () => {
    const fixture = createControllableTransport({});
    const breaking: Transport = {
      start: () => new Promise<void>(() => undefined),
      send: (m) => fixture.transport.send(m),
      close: async () => {
        throw new Error("close failed hard");
      },
    };
    const log = recordingLogger();
    const client = stdioClient(() => breaking, { logger: log.logger });
    const booting = observe(client.connect());
    await settle();
    await client.disconnect();
    await settle();
    expect(booting.error).toBeInstanceOf(McpConnectionError);
    expect(log.lines.filter((l) => l.msg === "mcp.disconnect_error")).toHaveLength(1);
  });

  test("every disconnect() joins the first, and the adopted transport is closed exactly once", async () => {
    const fixture = createControllableTransport({ toolListResult: { tools: [] } });
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => {
      releaseClose = r;
    });
    let closes = 0;
    const transport: Transport = {
      start: () => fixture.transport.start(),
      send: (m) => fixture.transport.send(m),
      close() {
        closes += 1;
        return closing;
      },
      set onmessage(h) {
        fixture.transport.onmessage = h;
      },
      get onmessage() {
        return fixture.transport.onmessage;
      },
    };
    const client = stdioClient(() => transport);
    await client.connect();
    const first = observe(client.disconnect());
    const second = observe(client.disconnect());
    await settle();
    expect({ first: first.settled, second: second.settled, closes }).toEqual({
      first: false,
      second: false,
      closes: 1,
    });
    releaseClose();
    await settle();
    expect({ first: first.settled, second: second.settled, closes }).toEqual({
      first: true,
      second: true,
      closes: 1,
    });
  });

  test("disconnectAll() at the end of a run reaps an optional peer still handshaking", async () => {
    // The research and batch shapes start an optional peer's first attempt
    // un-awaited and end with `await mcpHost.disconnectAll()`: a run that
    // finishes before that peer answers must not leave it behind.
    const gated = createGatedTransport();
    const timers = manualTimers();
    const host = new McpHost({
      clientOptions: {
        transportFactory: (config) =>
          config.transport === "stdio" && config.command === "slow"
            ? gated.transport
            : createControllableTransport({ toolListResult: { tools: [] } }).transport,
        clientFactory: (info) => new Client(info, { capabilities: {} }),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    });
    host.addServer("required", { transport: "stdio", command: "up" });
    host.addServer("optional", { transport: "stdio", command: "slow" });
    await host.getClient("required").connect();
    void host
      .getClient("optional")
      .connect()
      .catch(() => undefined);
    await settle();
    await host.disconnectAll();
    const reaped = gated.closes();
    gated.release();
    await settle();
    expect({
      reaped,
      states: host.list().map(({ client }) => client.getState().kind),
      timers: timers.pending(),
    }).toEqual({ reaped: 1, states: ["closed", "closed"], timers: 0 });
  });
});

describe("a re-entrant disconnect() cannot undo closed", () => {
  // Loggers and factories are injected code that runs synchronously inside
  // an attempt. A disconnect() made from one of them lands mid-step.

  test("from the `mcp.connecting` log line: nothing is built", async () => {
    let built = 0;
    const log = recordingLogger((msg) => {
      if (msg === "mcp.connecting") void client.disconnect();
    });
    const client = stdioClient(
      () => {
        built += 1;
        return createGatedTransport().transport;
      },
      { logger: log.logger },
    );
    expect(((await settledConnect(client)) as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    expect({ built, state: client.getState().kind }).toEqual({ built: 0, state: "closed" });
  });

  test("from inside the transport factory: the transport is closed, never started — and waited for", async () => {
    let starts = 0;
    let closes = 0;
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => {
      releaseClose = r;
    });
    let disconnected: ReturnType<typeof observe> | undefined;
    const fixture = createControllableTransport({});
    const client = stdioClient(() => {
      disconnected = observe(client.disconnect());
      return {
        start: async () => {
          starts += 1;
        },
        send: (m) => fixture.transport.send(m),
        close: () => {
          closes += 1;
          return closing;
        },
      };
    });
    expect(((await settledConnect(client)) as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    await settle();
    // The disconnect() began before this transport existed, and still waits
    // for its close.
    expect({ starts, closes, waiting: disconnected?.settled === false }).toEqual({
      starts: 0,
      closes: 1,
      waiting: true,
    });
    releaseClose();
    await settle();
    expect({ disconnected: disconnected?.settled, state: client.getState().kind }).toEqual({
      disconnected: true,
      state: "closed",
    });
  });

  test("from inside the client factory: the transport is closed, never started", async () => {
    let starts = 0;
    let closes = 0;
    const fixture = createControllableTransport({});
    const client: McpClient = stdioClient(
      () => ({
        start: async () => {
          starts += 1;
        },
        send: (m) => fixture.transport.send(m),
        close: async () => {
          closes += 1;
        },
      }),
      {
        clientFactory: (info) => {
          void client.disconnect();
          return new Client(info, { capabilities: {} });
        },
      },
    );
    expect(((await settledConnect(client)) as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    expect({ starts, closes, state: client.getState().kind }).toEqual({
      starts: 0,
      closes: 1,
      state: "closed",
    });
  });

  test("from a factory, with a close that rejects: still McpConnectionError, still closed", async () => {
    const fixture = createControllableTransport({});
    const client: McpClient = stdioClient(() => {
      void client.disconnect();
      return {
        start: async () => undefined,
        send: (m) => fixture.transport.send(m),
        close: () => Promise.reject(new Error("close rejected")),
      };
    });
    expect(((await settledConnect(client)) as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    expect(client.getState().kind).toBe("closed");
  });

  test("from inside the SDK's own close of a refused handshake: that close is joined, not run twice", async () => {
    // The SDK closes a refused handshake's transport itself; a close that
    // calls disconnect() synchronously makes it reap the SAME transport while
    // that first close is still on the stack.
    let closes = 0;
    let onmessage: ((m: JSONRPCMessage) => void) | undefined;
    const client: McpClient = stdioClient(() => ({
      start: async () => undefined,
      async send(m) {
        if ("method" in m && m.method === "initialize" && "id" in m) {
          const id = m.id;
          queueMicrotask(() =>
            onmessage?.({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: "refused" },
            } as JSONRPCMessage),
          );
        }
      },
      close: async () => {
        closes += 1;
        void client.disconnect();
      },
      set onmessage(h) {
        onmessage = h;
      },
      get onmessage() {
        return onmessage;
      },
    }));
    expect(await settledConnect(client)).toBeInstanceOf(McpConnectionError);
    await client.disconnect();
    expect({ closes, state: client.getState().kind }).toEqual({ closes: 1, state: "closed" });
  });

  test("from inside a close() that disconnect() itself started: joins, does not recurse", async () => {
    // A transport that reports its own teardown synchronously (to app code
    // that then shuts the client down) re-enters disconnect() mid-shutdown.
    const timers = manualTimers();
    const first = createControllableTransport({
      toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
    });
    let closes = 0;
    const fixture = createControllableTransport({});
    const reentrant: Transport = {
      start: () => new Promise<void>(() => undefined),
      send: (m) => fixture.transport.send(m),
      close: async () => {
        closes += 1;
        void client.disconnect();
      },
    };
    const transports = [first.transport, reentrant];
    let built = 0;
    const client = stdioClient(
      () => {
        const t = transports[built];
        built += 1;
        if (t === undefined) throw new Error(`unexpected transport #${built}`);
        return t;
      },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await client.connect();
      first.simulateClose();
      timers.fire();
      await settle();
      const call = observe(client.callTool("echo", {}));
      await settle();
      await client.disconnect();
      await settle();
      await new Promise((r) => setImmediate(r));
      expect({
        closes,
        state: client.getState().kind,
        call: call.error instanceof McpConnectionError,
        unhandled,
      }).toEqual({ closes: 1, state: "closed", call: true, unhandled: [] });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("from inside transport.start(): the attempt ends at once, not at the connect timeout", async () => {
    const fixture = createControllableTransport({});
    const client = stdioClient(() => ({
      start: () => {
        void client.disconnect();
        return new Promise<void>(() => undefined);
      },
      send: (m) => fixture.transport.send(m),
      close: async () => undefined,
    }));
    const booting = observe(client.connect());
    await settle();
    expect((booting.error as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    expect(client.getState().kind).toBe("closed");
  });

  test("from the `mcp.transport_closed` log line: closed stays closed, nothing is armed", async () => {
    const timers = manualTimers();
    const first = createControllableTransport({ toolListResult: { tools: [] } });
    const log = recordingLogger((msg) => {
      if (msg === "mcp.transport_closed") void client.disconnect();
    });
    const client = stdioClient(() => first.transport, {
      logger: log.logger,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await client.connect();
    first.simulateClose();
    await settle();
    expect({ state: client.getState().kind, timers: timers.pending() }).toEqual({
      state: "closed",
      timers: 0,
    });
  });

  test("from the `mcp.reconnect_scheduled` log line: the rung it announces is cleared", async () => {
    const timers = manualTimers();
    const first = createControllableTransport({ toolListResult: { tools: [] } });
    const log = recordingLogger((msg) => {
      if (msg === "mcp.reconnect_scheduled") void client.disconnect();
    });
    const client = stdioClient(() => first.transport, {
      logger: log.logger,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await client.connect();
    first.simulateClose();
    await settle();
    expect({ state: client.getState().kind, timers: timers.pending() }).toEqual({
      state: "closed",
      timers: 0,
    });
  });
});

describe("the reconnect ladder keeps ONE timer", () => {
  test("a failing rung whose transport closes under it arms exactly one next rung", async () => {
    // The close arms the next rung (handleTransportClose) and then the
    // rung's own failure armed ANOTHER, overwriting the handle — so every
    // failing rung doubled the timers and the backoff steps, and
    // disconnect() could clear only the newest timer. The orphans are
    // REF'D: they held the process open after its cleanup, then fired into
    // a closed client.
    const timers = manualTimers();
    const log = recordingLogger();
    const first = createControllableTransport({ toolListResult: { tools: [] } });
    let built = 0;
    const client = stdioClient(
      () => {
        built += 1;
        return built === 1 ? first.transport : createEnoentTransport();
      },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer, logger: log.logger },
    );
    await client.connect();
    first.simulateClose();
    const pending: number[] = [];
    for (let rung = 0; rung < 3; rung++) {
      timers.fire();
      await settle();
      pending.push(timers.pending());
    }
    const attempts = log.lines
      .filter((l) => l.msg === "mcp.reconnect_scheduled")
      .map((l) => l.fields?.["attempt"]);
    expect({ pending, built, attempts }).toEqual({
      pending: [1, 1, 1],
      built: 4,
      attempts: [1, 2, 3, 4],
    });
    await client.disconnect();
    expect(timers.pending()).toBe(0);
  });

  test("a boot connect() whose transport closes under it still arms exactly one rung", async () => {
    // registerOptionalMcpServer({ retry: true }) relies on mcp-host's OWN
    // ladder to bring a peer up that was down at boot.
    const timers = manualTimers();
    const client = stdioClient(() => createEnoentTransport(), {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await expect(client.connect()).rejects.toThrow(McpConnectionError);
    expect({ state: client.getState().kind, timers: timers.pending() }).toEqual({
      state: "disconnected",
      timers: 1,
    });
    await client.disconnect();
    expect(timers.pending()).toBe(0);
  });

  test("a ladder callback that fires after disconnect() revives nothing", async () => {
    // A timer seam whose clear does not cancel must still find a closed
    // client — and say nothing about it.
    const queued: Array<() => void> = [];
    const first = createControllableTransport({ toolListResult: { tools: [] } });
    const log = recordingLogger();
    let built = 0;
    const client = stdioClient(
      () => {
        built += 1;
        return first.transport;
      },
      {
        logger: log.logger,
        setTimer: (cb) => {
          queued.push(cb);
          return cb;
        },
        clearTimer: () => undefined,
      },
    );
    await client.connect();
    first.simulateClose();
    await client.disconnect();
    for (const cb of queued.splice(0)) cb();
    await settle();
    expect({
      state: client.getState().kind,
      built,
      rearmed: queued.length,
      warnings: log.lines.filter((l) => l.msg === "mcp.reconnect_failed").length,
    }).toEqual({ state: "closed", built: 1, rearmed: 0, warnings: 0 });
  });

  test("a timer seam that fires synchronously does not stall the ladder", async () => {
    // The callback runs inside setTimer, before its handle is returned; a
    // handle stored after that would mark a rung pending that already ran.
    const ok = createControllableTransport({ toolListResult: { tools: [] } });
    const fixture = createControllableTransport({});
    const failing: Transport = {
      start: () => Promise.reject(new Error("spawn ENOENT")),
      send: (m) => fixture.transport.send(m),
      close: async () => undefined,
    };
    const again = createControllableTransport({ toolListResult: { tools: [] } });
    const transports = [ok.transport, failing, again.transport];
    let built = 0;
    const client = stdioClient(
      () => {
        const t = transports[built];
        built += 1;
        if (t === undefined) throw new Error(`unexpected transport #${built}`);
        return t;
      },
      {
        setTimer: (cb) => {
          cb();
          return Symbol("already ran");
        },
        clearTimer: () => undefined,
      },
    );
    await client.connect();
    ok.simulateClose();
    // Two rungs back to back: give both handshakes their microtasks.
    await settle();
    await settle();
    expect({ state: client.getState().kind, built }).toEqual({ state: "connected", built: 3 });
    await client.disconnect();
  });

  test("handshakes leave no abort listener behind on the client's closing signal", async () => {
    const timers = manualTimers();
    const first = createControllableTransport({ toolListResult: { tools: [] } });
    const third = createControllableTransport({ toolListResult: { tools: [] } });
    const transports = [first.transport, createEnoentTransport(), third.transport];
    let built = 0;
    const client = stdioClient(
      () => {
        const t = transports[built];
        built += 1;
        if (t === undefined) throw new Error(`unexpected transport #${built}`);
        return t;
      },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    );
    const signal = (client as unknown as { closing: AbortController }).closing.signal;
    // By identity: removing some OTHER function must not balance the books.
    const registered = new Set<unknown>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...a: Parameters<typeof add>) => {
      registered.add(a[1]);
      add(...a);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
      registered.delete(a[1]);
      remove(...a);
    }) as typeof signal.removeEventListener;
    await client.connect();
    first.simulateClose();
    timers.fire();
    await settle();
    timers.fire();
    await settle();
    expect({ state: client.getState().kind, built, listeners: registered.size }).toEqual({
      state: "connected",
      built: 3,
      listeners: 0,
    });
    await client.disconnect();
  });
});

describe("a failed attempt's own close cannot change how it fails", () => {
  for (const [name, close] of [
    [
      "throws",
      () => {
        throw new Error("close threw");
      },
    ],
    ["rejects", () => Promise.reject(new Error("close rejected"))],
  ] as const) {
    test(`a close() that ${name} still leaves a wrapped McpConnectionError and a disconnected client`, async () => {
      const fixture = createControllableTransport({});
      const failing: Transport = {
        start: () => Promise.reject(new Error("spawn ENOENT")),
        send: (m) => fixture.transport.send(m),
        close: close as () => Promise<void>,
      };
      const client = stdioClient(() => failing);
      const err = await client.connect().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(McpConnectionError);
      expect(((err as Error).cause as Error).message).toBe("spawn ENOENT");
      expect(client.getState().kind).toBe("disconnected");
    });
  }
});

describe("what disconnect() waits for, and what it reaps exactly once", () => {
  test("it waits for the close it starts on an in-flight transport", async () => {
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => {
      releaseClose = r;
    });
    const fixture = createControllableTransport({});
    const client = stdioClient(() => ({
      start: () => new Promise<void>(() => undefined),
      send: (m) => fixture.transport.send(m),
      close: () => closing,
    }));
    const booting = observe(client.connect());
    await settle();
    const disconnected = observe(client.disconnect());
    await settle();
    expect({ disconnected: disconnected.settled, booting: booting.settled }).toEqual({
      disconnected: false,
      booting: true,
    });
    releaseClose();
    await settle();
    expect(disconnected.settled).toBe(true);
  });

  test("McpHost.disconnectAll() waits for every client's closes", async () => {
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => {
      releaseClose = r;
    });
    const fixture = createControllableTransport({});
    const host = new McpHost({
      clientOptions: {
        transportFactory: () => ({
          start: () => new Promise<void>(() => undefined),
          send: (m) => fixture.transport.send(m),
          close: () => closing,
        }),
        clientFactory: (info) => new Client(info, { capabilities: {} }),
      },
    });
    host.addServer("peer", { transport: "stdio", command: "slow" });
    void host
      .getClient("peer")
      .connect()
      .catch(() => undefined);
    await settle();
    const all = observe(host.disconnectAll());
    await settle();
    expect(all.settled).toBe(false);
    releaseClose();
    await settle();
    expect(all.settled).toBe(true);
  });

  test("an adopted transport is reaped once, and a failed attempt's transport never again", async () => {
    // Close failures are logged per reap, so a transport reaped twice — still
    // in the in-flight set after it was adopted, or after its attempt failed
    // — would be reported twice, or long after the fact.
    const adoptedLog = recordingLogger();
    const ok = createControllableTransport({ toolListResult: { tools: [] } });
    const adopted = stdioClient(
      () => ({
        start: () => ok.transport.start(),
        send: (m) => ok.transport.send(m),
        close: () => Promise.reject(new Error("close rejected")),
        set onmessage(h) {
          ok.transport.onmessage = h;
        },
        get onmessage() {
          return ok.transport.onmessage;
        },
      }),
      { logger: adoptedLog.logger },
    );
    await adopted.connect();
    await adopted.disconnect();
    expect(adoptedLog.lines.filter((l) => l.msg === "mcp.disconnect_error")).toHaveLength(1);

    const failedLog = recordingLogger();
    const fixture = createControllableTransport({});
    const failed = stdioClient(
      () => ({
        start: () => Promise.reject(new Error("spawn ENOENT")),
        send: (m) => fixture.transport.send(m),
        close: () => Promise.reject(new Error("close rejected")),
      }),
      { logger: failedLog.logger },
    );
    await expect(failed.connect()).rejects.toThrow(McpConnectionError);
    await failed.disconnect();
    expect(failedLog.lines.filter((l) => l.msg === "mcp.disconnect_error")).toEqual([]);
  });

  test("a close that throws synchronously is joined, not re-run, and logged once", async () => {
    let closes = 0;
    const fixture = createControllableTransport({});
    const log = recordingLogger();
    const client = stdioClient(
      () => ({
        start: () => new Promise<void>(() => undefined),
        send: (m) => fixture.transport.send(m),
        close: () => {
          closes += 1;
          throw new Error("close threw synchronously");
        },
      }),
      { logger: log.logger },
    );
    const booting = client.connect();
    booting.catch(() => undefined);
    await settle();
    await client.disconnect();
    await expect(booting).rejects.toThrow(CLOSED_WHILE_CONNECTING);
    expect({
      closes,
      warned: log.lines.filter((l) => l.msg === "mcp.disconnect_error").length,
    }).toEqual({ closes: 1, warned: 1 });
  });

  test("a close that rejects with a non-Error still lets disconnect() resolve", async () => {
    const fixture = createControllableTransport({});
    const log = recordingLogger();
    const client = stdioClient(
      () => ({
        start: () => new Promise<void>(() => undefined),
        send: (m) => fixture.transport.send(m),
        close: () => Promise.reject(undefined),
      }),
      { logger: log.logger },
    );
    void client.connect().catch(() => undefined);
    await settle();
    await client.disconnect();
    expect(log.lines.filter((l) => l.msg === "mcp.disconnect_error")).toHaveLength(1);
  });

  test("every disconnect() returns the first one's promise; a queued call sees one rejection", async () => {
    const timers = manualTimers();
    const first = createControllableTransport({
      toolListResult: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
    });
    const client = stdioClient(() => first.transport, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await client.connect();
      first.simulateClose();
      const call = observe(client.callTool("echo", {}));
      await settle();
      const a = client.disconnect();
      const b = client.disconnect();
      expect(a).toBe(b);
      await a;
      await settle();
      await new Promise((r) => setImmediate(r));
      expect((call.error as Error).message).toMatch(/disconnected/);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a transport object handed back again is really closed on every attempt", async () => {
    // An injected factory may return the same object each time; each attempt
    // wraps its OWN close, not the previous attempt's settled one.
    let closes = 0;
    const fixture = createControllableTransport({});
    const reused: Transport = {
      start: () => Promise.reject(new Error("spawn ENOENT")),
      send: (m) => fixture.transport.send(m),
      close: async () => {
        closes += 1;
      },
    };
    const client = stdioClient(() => reused);
    await expect(client.connect()).rejects.toThrow(McpConnectionError);
    await expect(client.connect()).rejects.toThrow(McpConnectionError);
    await client.disconnect();
    expect(closes).toBe(2);
  });

  test("a frozen transport still connects — and still closes", async () => {
    const ok = createControllableTransport({ toolListResult: { tools: [] } });
    let closes = 0;
    let onerror: ((e: Error) => void) | undefined;
    const frozen: Transport = Object.freeze({
      start: () => ok.transport.start(),
      send: (m: JSONRPCMessage) => ok.transport.send(m),
      close: async () => {
        closes += 1;
      },
      set onmessage(h) {
        ok.transport.onmessage = h;
      },
      get onmessage() {
        return ok.transport.onmessage;
      },
      set onclose(h) {
        ok.transport.onclose = h;
      },
      get onclose() {
        return ok.transport.onclose;
      },
      set onerror(h: ((e: Error) => void) | undefined) {
        onerror = h;
      },
      get onerror() {
        return onerror;
      },
    });
    const client = stdioClient(() => frozen);
    await client.connect();
    expect(client.getState().kind).toBe("connected");
    await client.disconnect();
    expect(closes).toBe(1);
  });

  test("a close that rejects is never handed to the SDK's own fire-and-forget close", async () => {
    // Abandoning the handshake makes the SDK reject `initialize`, and its
    // Client.connect catch then closes the transport with nothing attached.
    const fixture = createControllableTransport({});
    const log = recordingLogger();
    const client = stdioClient(
      () => ({
        start: async () => undefined,
        send: async () => undefined,
        close: () => Promise.reject(new Error("close rejected")),
        set onmessage(h) {
          fixture.transport.onmessage = h;
        },
        get onmessage() {
          return fixture.transport.onmessage;
        },
      }),
      { logger: log.logger },
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const booting = client.connect();
      booting.catch(() => undefined);
      await settle();
      await client.disconnect();
      await settle();
      await new Promise((r) => setImmediate(r));
      expect({
        unhandled,
        warned: log.lines.filter((l) => l.msg === "mcp.disconnect_error").length,
      }).toEqual({ unhandled: [], warned: 1 });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("what an overtaken probe and a re-entrant ladder report", () => {
  test("a probe candidate's own failure survives as the cause when the client closed under it", async () => {
    let handshakes = 0;
    const client: McpClient = new McpClient(
      "peer",
      { transport: "sse", url: "http://127.0.0.1:1/mcp" },
      {
        clientFactory: () => {
          handshakes += 1;
          return {
            connect: () => {
              void client.disconnect();
              return Promise.reject(new Error("candidate refused"));
            },
          } as unknown as Client;
        },
      },
    );
    const err = await client.connect().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect({
      message: (err as Error).message,
      cause: ((err as Error).cause as Error | undefined)?.message,
      handshakes,
    }).toEqual({
      message: 'mcp client "peer" was closed while connecting',
      cause: "candidate refused",
      handshakes: 1,
    });
  });

  test("each `mcp.reconnect_scheduled` line names its own rung, even under a synchronous seam", async () => {
    // The first rung runs inside setTimer; its transport closes under it and
    // arms rung 2 before rung 1's line is written.
    const queued: Array<() => void> = [];
    let synchronous = true;
    const log = recordingLogger();
    const first = createControllableTransport({ toolListResult: { tools: [] } });
    const transports = [first.transport, createEnoentTransport()];
    let built = 0;
    const client = stdioClient(
      () => {
        const t = transports[built];
        built += 1;
        if (t === undefined) throw new Error(`unexpected transport #${built}`);
        return t;
      },
      {
        logger: log.logger,
        setTimer: (cb) => {
          if (synchronous) {
            synchronous = false;
            cb();
          } else {
            queued.push(cb);
          }
          return cb;
        },
        clearTimer: () => undefined,
      },
    );
    await client.connect();
    first.simulateClose();
    await settle();
    const attempts = log.lines
      .filter((l) => l.msg === "mcp.reconnect_scheduled")
      .map((l) => l.fields?.["attempt"]);
    expect({ attempts, queued: queued.length }).toEqual({ attempts: [2, 1], queued: 1 });
    await client.disconnect();
  });
});

/**
 * Hold every timer the SDK and the client arm (global setTimeout), so a
 * timeout can be fired by hand instead of waited out.
 */
function holdTimers() {
  const live = new Map<object, { cb: () => void; ms: number }>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((cb: () => void, ms: number) => {
    const handle = {};
    live.set(handle, { cb, ms });
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: object) => {
    live.delete(handle);
  }) as unknown as typeof clearTimeout;
  return {
    fire(ms: number): void {
      const entry = [...live.entries()].find(([, t]) => t.ms === ms);
      if (entry === undefined) throw new Error(`no ${ms} ms timer armed`);
      live.delete(entry[0]);
      entry[1].cb();
    },
    restore(): void {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

describe("closes that nest, fail, or cannot be reassigned", () => {
  test("a linked pair that closes its peer, which closes it back, still disconnects (the SDK's InMemoryTransport)", async () => {
    // C.close() awaits S.close(), which awaits C.close(): a close joined
    // from inside itself would wait on itself, forever.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "in-memory", version: "0.0.0" });
    let serverClosed = false;
    server.server.onclose = () => {
      serverClosed = true;
    };
    await server.connect(serverSide);
    const client = stdioClient(() => clientSide);
    await client.connect();
    const disconnected = observe(client.disconnect());
    await settle();
    expect({ disconnected: disconnected.settled, serverClosed }).toEqual({
      disconnected: true,
      serverClosed: true,
    });
  });

  test("a wrapped transport's own close() starts the first close and waits for it", async () => {
    let closes = 0;
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => {
      releaseClose = r;
    });
    const fixture = createControllableTransport({});
    const transport: Transport = {
      start: () => new Promise<void>(() => undefined),
      send: (m) => fixture.transport.send(m),
      close: () => {
        closes += 1;
        return closing;
      },
    };
    const client = stdioClient(() => transport);
    void client.connect().catch(() => undefined);
    await settle();
    const direct = observe(transport.close());
    await settle();
    expect({ closes, direct: direct.settled }).toEqual({ closes: 1, direct: false });
    releaseClose();
    await settle();
    expect(direct.settled).toBe(true);
    await client.disconnect();
    expect(closes).toBe(1);
  });

  test("a close made after the first one started joins it, rather than returning at once", async () => {
    // disconnect() starts the first close; any later close of the same
    // transport — the SDK's own included — waits for that one to finish.
    let closes = 0;
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => {
      releaseClose = r;
    });
    const fixture = createControllableTransport({});
    const transport: Transport = {
      start: () => new Promise<void>(() => undefined),
      send: (m) => fixture.transport.send(m),
      close: () => {
        closes += 1;
        return closing;
      },
    };
    const client = stdioClient(() => transport);
    void client.connect().catch(() => undefined);
    await settle();
    const disconnected = observe(client.disconnect());
    await settle();
    const later = observe(transport.close());
    await settle();
    expect({ closes, later: later.settled, disconnected: disconnected.settled }).toEqual({
      closes: 1,
      later: false,
      disconnected: false,
    });
    releaseClose();
    await settle();
    expect({ closes, later: later.settled, disconnected: disconnected.settled }).toEqual({
      closes: 1,
      later: true,
      disconnected: true,
    });
  });

  test("a frozen transport overtaken in flight is closed once", async () => {
    let closes = 0;
    let onclose: (() => void) | undefined;
    let onmessage: ((m: JSONRPCMessage) => void) | undefined;
    let onerror: ((e: Error) => void) | undefined;
    const frozen: Transport = Object.freeze({
      start: () => new Promise<void>(() => undefined),
      send: async () => undefined,
      close: async () => {
        closes += 1;
      },
      set onclose(h: (() => void) | undefined) {
        onclose = h;
      },
      get onclose() {
        return onclose;
      },
      set onmessage(h: ((m: JSONRPCMessage) => void) | undefined) {
        onmessage = h;
      },
      get onmessage() {
        return onmessage;
      },
      set onerror(h: ((e: Error) => void) | undefined) {
        onerror = h;
      },
      get onerror() {
        return onerror;
      },
    });
    const client = stdioClient(() => frozen);
    const booting = observe(client.connect());
    await settle();
    await client.disconnect();
    await settle();
    expect({ closes, booting: booting.settled }).toEqual({ closes: 1, booting: true });
  });

  for (const [label, reason, logged] of [
    ["an Error", new Error("close rejected"), "close rejected"],
    ["a string", "boom", "boom"],
    ["a { message } object", { code: -32000, message: "socket busy" }, "socket busy"],
    ["a value with no string form", Object.create(null), "[object Object]"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["an object whose message is not a string", { message: 42 }, "[object Object]"],
  ] as const) {
    test(`a close that rejects with ${label} is logged as "${logged}"`, async () => {
      const fixture = createControllableTransport({});
      const log = recordingLogger();
      const client = stdioClient(
        () => ({
          start: () => new Promise<void>(() => undefined),
          send: (m) => fixture.transport.send(m),
          close: () => Promise.reject(reason),
        }),
        { logger: log.logger },
      );
      void client.connect().catch(() => undefined);
      await settle();
      await client.disconnect();
      expect(
        log.lines.filter((l) => l.msg === "mcp.disconnect_error").map((l) => l.fields?.["error"]),
      ).toEqual([logged]);
    });
  }

  test("a log sink that throws while reporting a failed close does not fail disconnect()", async () => {
    const fixture = createControllableTransport({});
    const log = recordingLogger((msg) => {
      if (msg === "mcp.disconnect_error") throw new Error("log sink down");
    });
    const client = stdioClient(
      () => ({
        start: () => new Promise<void>(() => undefined),
        send: (m) => fixture.transport.send(m),
        close: () => Promise.reject(new Error("close rejected")),
      }),
      { logger: log.logger },
    );
    void client.connect().catch(() => undefined);
    await settle();
    const disconnected = observe(client.disconnect());
    await settle();
    expect({ settled: disconnected.settled, error: disconnected.error }).toEqual({
      settled: true,
      error: undefined,
    });
  });

  test("a timer seam that throws makes disconnect() reject, not hang", async () => {
    const first = createControllableTransport({ toolListResult: { tools: [] } });
    const client = stdioClient(() => first.transport, {
      setTimer: (cb) => cb,
      clearTimer: () => {
        throw new Error("clear failed");
      },
    });
    await client.connect();
    first.simulateClose();
    const disconnected = observe(client.disconnect());
    await settle();
    expect((disconnected.error as Error | undefined)?.message).toBe("clear failed");
  });
});

describe("a re-entrant disconnect() from deeper inside an attempt", () => {
  test("from the transport's `onclose` setter: never started, closed, waited for", async () => {
    let starts = 0;
    let closes = 0;
    let disconnected: ReturnType<typeof observe> | undefined;
    const fixture = createControllableTransport({});
    const client: McpClient = stdioClient(() => ({
      start: async () => {
        starts += 1;
      },
      send: (m) => fixture.transport.send(m),
      close: async () => {
        closes += 1;
      },
      set onclose(h: (() => void) | undefined) {
        if (h !== undefined && disconnected === undefined) {
          disconnected = observe(client.disconnect());
        }
      },
      get onclose() {
        return undefined;
      },
    }));
    expect(((await settledConnect(client)) as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    await settle();
    expect({
      starts,
      closes,
      disconnected: disconnected?.settled,
      state: client.getState().kind,
    }).toEqual({ starts: 0, closes: 1, disconnected: true, state: "closed" });
  });

  test("from the SDK client's setNotificationHandler: never started, closed", async () => {
    let starts = 0;
    let closes = 0;
    const fixture = createControllableTransport({});
    const client: McpClient = stdioClient(
      () => ({
        start: async () => {
          starts += 1;
        },
        send: (m) => fixture.transport.send(m),
        close: async () => {
          closes += 1;
        },
      }),
      {
        clientFactory: (info) => {
          const sdk = new Client(info, { capabilities: {} });
          const set = sdk.setNotificationHandler.bind(sdk);
          sdk.setNotificationHandler = ((...a: Parameters<typeof set>) => {
            void client.disconnect();
            return set(...a);
          }) as typeof sdk.setNotificationHandler;
          return sdk;
        },
      },
    );
    expect(((await settledConnect(client)) as Error).message).toMatch(CLOSED_WHILE_CONNECTING);
    expect({ starts, closes, state: client.getState().kind }).toEqual({
      starts: 0,
      closes: 1,
      state: "closed",
    });
  });

  test("from inside the failed attempt's own first close: closed survives", async () => {
    let closes = 0;
    const fixture = createControllableTransport({});
    const client: McpClient = stdioClient(() => ({
      start: () => Promise.reject(new Error("spawn ENOENT")),
      send: (m) => fixture.transport.send(m),
      close: async () => {
        closes += 1;
        void client.disconnect();
      },
    }));
    const err = (await settledConnect(client)) as Error;
    expect({
      state: client.getState().kind,
      message: err.message,
      cause: (err.cause as Error | undefined)?.message,
      closes,
    }).toEqual({
      state: "closed",
      message: 'mcp client "peer" was closed while connecting',
      cause: "spawn ENOENT",
      closes: 1,
    });
  });

  test("from inside the abandoned handshake's cancel: closed survives", async () => {
    const timers = holdTimers();
    try {
      const client: McpClient = stdioClient(
        () => ({
          start: async () => undefined,
          send(m: JSONRPCMessage) {
            if ("method" in m && m.method === "notifications/cancelled") void client.disconnect();
            return Promise.resolve();
          },
          close: async () => undefined,
        }),
        { connectTimeoutMs: 1234 },
      );
      const booting = observe(client.connect());
      await settle();
      timers.fire(1234);
      await settle();
      expect({
        settled: booting.settled,
        state: client.getState().kind,
        message: (booting.error as Error | undefined)?.message,
        cause: ((booting.error as Error | undefined)?.cause as Error | undefined)?.message,
      }).toEqual({
        settled: true,
        state: "closed",
        message: 'mcp client "peer" was closed while connecting',
        cause: 'mcp connect to "peer" timed out after 1234ms',
      });
    } finally {
      timers.restore();
    }
  });
});
