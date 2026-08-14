/**
 * #406 — optional MCP peers (`registerOptionalMcpServer`): degrade at boot,
 * retry in the background, register on arrival.
 *
 * A fake host whose ONE server can be told to fail its next N connect
 * attempts drives the ladder deterministically through the injected timer
 * seams — no sleeping. The config-thunk path (deferred resolveMcpServerConfig
 * + addServer inside the never-throw boundary) is driven by a thunk that
 * throws like an unset-env-var ConfigError would.
 */
import { describe, expect, test } from "bun:test";
import { McpError } from "@crewhaus/errors";
import type { McpHost, McpServerConfig, McpToolDefinition } from "@crewhaus/mcp-host";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import { registerOptionalMcpServer } from "./index.js";

const TOOL_A: McpToolDefinition = {
  name: "ping",
  description: "Ping the peer.",
  inputSchema: { type: "object", properties: {} },
};

const TOOL_B: McpToolDefinition = {
  name: "echo",
  description: "Echo a payload.",
  inputSchema: { type: "object", properties: {} },
};

/**
 * Fake host with one flaky server. `failNextConnects(n)` makes the next n
 * connect() calls reject; `setTools` swaps the advertised list and
 * `fireChanged` fires the onToolsChanged seam (the G74 contract). `added`
 * records addServer calls so the config-thunk path is observable.
 */
function makeFlakyHost(serverName: string, opts: { registered?: boolean } = {}) {
  let tools: ReadonlyArray<McpToolDefinition> = [TOOL_A];
  let failuresLeft = 0;
  let connects = 0;
  const handlers = new Set<() => void>();
  const added: Array<{ name: string; config: McpServerConfig }> = [];
  let known = opts.registered !== false;
  const client = {
    name: serverName,
    async connect() {
      connects += 1;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new McpError("connect ECONNREFUSED 127.0.0.1:9\nsecond line");
      }
    },
    async listTools() {
      return tools;
    },
    async refreshTools() {
      return tools;
    },
    onToolsChanged(h: () => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    async callTool(_n: string, args: Record<string, unknown>) {
      return { content: JSON.stringify(args), isError: false };
    },
    async disconnect() {},
    getState() {
      return { kind: "connected" } as const;
    },
  };
  const host = {
    getClient: (name: string) => {
      if (name !== serverName || !known) throw new McpError(`unknown server "${name}"`);
      return client;
    },
    has: (name: string) => known && name === serverName,
    list: () => (known ? [{ name: serverName, client }] : []),
    addServer: (name: string, config: McpServerConfig) => {
      added.push({ name, config });
      known = true;
      return client;
    },
    disconnectAll: async () => undefined,
  };
  return {
    host: host as unknown as McpHost,
    added,
    failNextConnects: (n: number) => {
      failuresLeft = n;
    },
    connectCount: () => connects,
    setTools: (t: ReadonlyArray<McpToolDefinition>) => {
      tools = t;
    },
    fireChanged: () => {
      for (const h of handlers) h();
    },
  };
}

/** Injectable timer seams: scheduled callbacks queue up; `fire()` runs the
 *  next one. Nothing sleeps. */
function makeTimers() {
  const queue: Array<{ cb: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  return {
    setTimer: (cb: () => void, ms: number) => {
      const handle = { cb, ms };
      queue.push(handle);
      return handle;
    },
    clearTimer: (h: unknown) => {
      cleared.push(h);
      const i = queue.indexOf(h as { cb: () => void; ms: number });
      if (i !== -1) queue.splice(i, 1);
    },
    fire: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("no timer scheduled");
      next.cb();
      // Let the async run() settle.
      await new Promise((r) => setTimeout(r, 0));
    },
    pending: () => queue.length,
    delays: () => queue.map((q) => q.ms),
    cleared,
  };
}

describe("registerOptionalMcpServer", () => {
  test("first attempt success registers tools and reports connected", async () => {
    const { host } = makeFlakyHost("peer");
    const catalog = new ToolCatalog();
    const lines: string[] = [];
    const handle = registerOptionalMcpServer(host, "peer", catalog, {
      log: (l) => lines.push(l),
    });
    expect(await handle.firstAttempt).toBe(true);
    expect(handle.connected()).toBe(true);
    expect(catalog.list().map((t) => t.name)).toContain("peer__ping");
    expect(lines.join("")).toContain('optional server "peer" connected — 1 tool(s) registered');
  });

  test("failed first attempt warns, then a background retry connects", async () => {
    const flaky = makeFlakyHost("peer");
    const catalog = new ToolCatalog();
    const lines: string[] = [];
    const timers = makeTimers();
    flaky.failNextConnects(2);
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {
      log: (l) => lines.push(l),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      backoffMs: (attempt) => attempt * 10,
    });
    expect(await handle.firstAttempt).toBe(false);
    expect(handle.connected()).toBe(false);
    // The warning names the server, keeps the error to its FIRST line, and
    // says the boot continues.
    const warned = lines.join("");
    expect(warned).toContain('optional server "peer" unreachable');
    expect(warned).toContain("ECONNREFUSED");
    expect(warned).not.toContain("second line");
    expect(warned).toContain("retrying in the background");
    expect(catalog.list()).toHaveLength(0);
    // Ladder: attempt 1 scheduled at 10ms; still failing → attempt 2 at 20ms.
    expect(timers.delays()).toEqual([10]);
    await timers.fire();
    expect(handle.connected()).toBe(false);
    expect(timers.delays()).toEqual([20]);
    // Peer comes up; the next retry lands the tools.
    await timers.fire();
    expect(handle.connected()).toBe(true);
    expect(catalog.list().map((t) => t.name)).toContain("peer__ping");
    expect(lines.join("")).toContain("after 2 retries");
    expect(timers.pending()).toBe(0);
  });

  test("retry: false degrades once and never schedules", async () => {
    const flaky = makeFlakyHost("peer");
    const catalog = new ToolCatalog();
    const lines: string[] = [];
    const timers = makeTimers();
    flaky.failNextConnects(1);
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {
      retry: false,
      log: (l) => lines.push(l),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(await handle.firstAttempt).toBe(false);
    expect(timers.pending()).toBe(0);
    expect(lines.join("")).toContain("continuing without its tools for this run");
    expect(lines.join("")).not.toContain("retrying in the background");
  });

  test("config thunk: resolution + addServer run inside the boundary", async () => {
    const flaky = makeFlakyHost("peer", { registered: false });
    const catalog = new ToolCatalog();
    const config: McpServerConfig = { transport: "stdio", command: "peer-server" };
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {
      config: () => config,
    });
    expect(await handle.firstAttempt).toBe(true);
    expect(flaky.added).toEqual([{ name: "peer", config }]);
    expect(catalog.list().map((t) => t.name)).toContain("peer__ping");
  });

  test("config thunk failure (unset env var) degrades permanently — no retry", async () => {
    const flaky = makeFlakyHost("peer", { registered: false });
    const catalog = new ToolCatalog();
    const lines: string[] = [];
    const timers = makeTimers();
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {
      config: () => {
        throw new McpError("environment variable PEER_API_KEY is not set\ndetail line");
      },
      log: (l) => lines.push(l),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(await handle.firstAttempt).toBe(false);
    expect(handle.connected()).toBe(false);
    // Permanent: an env var does not appear mid-process, so even the default
    // retry contract schedules nothing.
    expect(timers.pending()).toBe(0);
    const warned = lines.join("");
    expect(warned).toContain('optional server "peer" not configured');
    expect(warned).toContain("PEER_API_KEY");
    expect(warned).not.toContain("detail line");
    expect(flaky.added).toHaveLength(0);
  });

  test("stop() cancels a pending retry", async () => {
    const flaky = makeFlakyHost("peer");
    const catalog = new ToolCatalog();
    const timers = makeTimers();
    flaky.failNextConnects(1);
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await handle.firstAttempt;
    expect(timers.pending()).toBe(1);
    handle.stop();
    expect(timers.pending()).toBe(0);
    expect(timers.cleared).toHaveLength(1);
  });

  test("stop() after connect stops the watch but leaves tools registered", async () => {
    const flaky = makeFlakyHost("peer");
    const catalog = new ToolCatalog();
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {});
    await handle.firstAttempt;
    expect(catalog.list().map((t) => t.name)).toContain("peer__ping");
    handle.stop();
    // Stopping the watch must NOT yank tools out from under a running turn.
    expect(catalog.list().map((t) => t.name)).toContain("peer__ping");
    // And post-stop drift no longer reconciles.
    flaky.setTools([TOOL_A, TOOL_B]);
    flaky.fireChanged();
    await new Promise((r) => setTimeout(r, 0));
    expect(catalog.list().map((t) => t.name)).not.toContain("peer__echo");
  });

  test("a connected optional server stays live-reconciled (G74 watch)", async () => {
    const flaky = makeFlakyHost("peer");
    const catalog = new ToolCatalog();
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {});
    await handle.firstAttempt;
    flaky.setTools([TOOL_A, TOOL_B]);
    flaky.fireChanged();
    await new Promise((r) => setTimeout(r, 0));
    expect(catalog.list().map((t) => t.name)).toContain("peer__echo");
  });

  test("the default retry timer is unref'd — it never holds a process open", async () => {
    const flaky = makeFlakyHost("peer");
    const catalog = new ToolCatalog();
    flaky.failNextConnects(1);
    // No injected timer seams: this exercises the REAL setTimeout path. The
    // research shape ends by returning from main(), so a ref'd retry timer
    // would hang the process forever after the run finished.
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {
      backoffMs: () => 60_000,
    });
    await handle.firstAttempt;
    // Bun/Node expose the handle count; an unref'd timer is not counted.
    const refCount = (
      process as unknown as { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.();
    if (refCount !== undefined) {
      expect(refCount.some((h) => String(h).includes("Timeout"))).toBe(false);
    }
    handle.stop();
  });

  test("never throws: an unknown server name degrades and retries", async () => {
    const flaky = makeFlakyHost("peer", { registered: false });
    const catalog = new ToolCatalog();
    const lines: string[] = [];
    const timers = makeTimers();
    // No config thunk AND the host has no such server — getClient throws;
    // the boundary catches it.
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {
      log: (l) => lines.push(l),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(await handle.firstAttempt).toBe(false);
    expect(lines.join("")).toContain('optional server "peer" failed');
    expect(timers.pending()).toBe(1);
    handle.stop();
  });
});
