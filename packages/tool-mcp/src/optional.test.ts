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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  let up = false;
  let disconnects = 0;
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
      up = true;
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
    async disconnect() {
      disconnects += 1;
      up = false;
    },
    getState() {
      return (up ? { kind: "connected" } : { kind: "disconnected" }) as {
        kind: "connected" | "disconnected";
      };
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
    disconnectCount: () => disconnects,
    /** Model mcp-host's OWN reconnect landing in the background. */
    bringUp: () => {
      up = true;
    },
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

/** A workspace package's entry file, resolved from THIS file: the checkout
 *  under test, never a published release. */
const inTree = (specifier: string): string =>
  JSON.stringify(fileURLToPath(import.meta.resolve(specifier)));

/**
 * Run `body` as a real `bun` process against this checkout; return how it
 * exited and what it reported once its work was done.
 *
 * The script sits in a tmp dir with no node_modules above it, so a BARE
 * `@crewhaus/*` import there never reaches the workspace: bun's
 * auto-installer fetches the last published release from npm instead. From
 * a cold cache that is ~25 MB, so a slow registry alone could blow a 20 s
 * budget (CI run 38435291702). Nor did the auto-installed tree reliably
 * import at all: the script could die resolving a dependency, which an
 * exit-only check counted as a pass. Every import is therefore an absolute
 * path, and `--no-install` makes a stray bare specifier fail loudly, offline.
 *
 * mcp-host's REF'D reconnect ladder is the handle that would hold the
 * process open, so the script counts it through mcp-host's own timer seam
 * and reports the count: a leak fails on that number, not on how long a
 * loaded runner takes to start bun. A pending timer also exits 3, so the
 * test never waits one out; with none pending the script exits on its own,
 * which is the property under test.
 */
async function runAgainstTree(body: string): Promise<{ exitCode: number; report: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "optional-exit-"));
  const script = join(dir, "run.ts");
  try {
    await Bun.write(
      script,
      `import { McpHost } from ${inTree("@crewhaus/mcp-host")};
import { ToolCatalog } from ${inTree("@crewhaus/tool-catalog")};
import { registerOptionalMcpServer } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
const pending = new Set<unknown>();
const host = new McpHost({
  clientOptions: {
    setTimer: (cb: () => void, ms: number) => {
      const t = setTimeout(() => {
        pending.delete(t);
        cb();
      }, ms);
      pending.add(t);
      return t;
    },
    clearTimer: (t: unknown) => {
      pending.delete(t);
      clearTimeout(t as ReturnType<typeof setTimeout>);
    },
  },
});
${body}
const state = host.getClient("peer").getState().kind;
console.log(JSON.stringify({ state, pendingReconnects: pending.size }));
if (pending.size > 0) process.exit(3);
`,
    );
    const proc = Bun.spawn([process.execPath, "--no-install", script], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // No report means the script died before its work was done (an import
    // that did not resolve, say): say why, not just that it exited.
    const line = stdout.trim().split("\n").at(-1) ?? "";
    if (!line.startsWith("{")) {
      throw new Error(`the script exited ${exitCode} without reporting:\n${stderr}`);
    }
    return { exitCode, report: JSON.parse(line) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    expect(catalog.list().map((t) => t.name)).toContain("mcp__peer__ping");
    expect(lines.join("")).toContain('optional server "peer" connected — 1 tool(s) registered');
  });

  test("a failed first attempt warns, then ADOPTS when mcp-host's own reconnect lands", async () => {
    const flaky = makeFlakyHost("peer");
    const catalog = new ToolCatalog();
    const lines: string[] = [];
    const timers = makeTimers();
    flaky.failNextConnects(1);
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
    // A one-shot surface would have been disconnected; a retrying one must
    // NOT be — mcp-host's ladder is the retry.
    expect(flaky.disconnectCount()).toBe(0);

    // Still down at the first check ⇒ another check is scheduled. Crucially
    // the check does NOT issue its own connect(): mcp-host is already
    // reconnecting, and a second ladder would double the connect rate and
    // race its transport.
    const whileDown = flaky.connectCount();
    expect(timers.delays()).toEqual([10]);
    await timers.fire();
    expect(handle.connected()).toBe(false);
    expect(flaky.connectCount()).toBe(whileDown);
    expect(timers.delays()).toEqual([20]);

    // mcp-host reconnects in the background; the next check adopts the peer.
    flaky.bringUp();
    await timers.fire();
    expect(handle.connected()).toBe(true);
    expect(catalog.list().map((t) => t.name)).toContain("mcp__peer__ping");
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
    // mcp-host arms its OWN ref'd reconnect ladder off the transport close;
    // a one-shot surface must cancel it or the finished run never exits.
    expect(flaky.disconnectCount()).toBe(1);
  });

  test("retry: false does not wait for the failed client to finish closing", async () => {
    // disconnect() now waits until the failed transport has closed — for a
    // child that ignores EOF and SIGTERM, ~4 s. A boot that brings optional
    // peers up one by one must not pay that per peer.
    const flaky = makeFlakyHost("peer");
    flaky.failNextConnects(1);
    let disconnects = 0;
    (flaky.host.getClient("peer") as unknown as { disconnect: () => Promise<void> }).disconnect =
      () => {
        disconnects += 1;
        return new Promise<void>(() => undefined);
      };
    const handle = registerOptionalMcpServer(flaky.host, "peer", new ToolCatalog(), {
      retry: false,
      log: () => {},
    });
    let first: boolean | "pending" = "pending";
    void handle.firstAttempt.then((ok) => {
      first = ok;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect({ first, disconnects }).toEqual({ first: false, disconnects: 1 });
  });

  test("retry: false: a disconnect that rejects is not an unhandled rejection", async () => {
    const flaky = makeFlakyHost("peer");
    flaky.failNextConnects(1);
    (flaky.host.getClient("peer") as unknown as { disconnect: () => Promise<void> }).disconnect =
      () => Promise.reject(new Error("log sink down"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const handle = registerOptionalMcpServer(flaky.host, "peer", new ToolCatalog(), {
        retry: false,
        log: () => {},
      });
      expect(await handle.firstAttempt).toBe(false);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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
    expect(catalog.list().map((t) => t.name)).toContain("mcp__peer__ping");
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
    expect(catalog.list().map((t) => t.name)).toContain("mcp__peer__ping");
    handle.stop();
    // Stopping the watch must NOT yank tools out from under a running turn.
    expect(catalog.list().map((t) => t.name)).toContain("mcp__peer__ping");
    // And post-stop drift no longer reconciles.
    flaky.setTools([TOOL_A, TOOL_B]);
    flaky.fireChanged();
    await new Promise((r) => setTimeout(r, 0));
    expect(catalog.list().map((t) => t.name)).not.toContain("mcp__peer__echo");
  });

  test("a connected optional server stays live-reconciled (G74 watch)", async () => {
    const flaky = makeFlakyHost("peer");
    const catalog = new ToolCatalog();
    const handle = registerOptionalMcpServer(flaky.host, "peer", catalog, {});
    await handle.firstAttempt;
    flaky.setTools([TOOL_A, TOOL_B]);
    flaky.fireChanged();
    await new Promise((r) => setTimeout(r, 0));
    expect(catalog.list().map((t) => t.name)).toContain("mcp__peer__echo");
  });

  test("a one-shot surface's failed peer never holds the process open (real subprocess)", async () => {
    // The property that matters is "the process EXITS", so assert exactly
    // that. mcp-host arms its own REF'D reconnect ladder off the failed
    // connect's transport close; `retry: false` must cancel it, or a
    // finished cli/crew/workflow run hangs forever with its work done.
    const script = `const h = registerOptionalMcpServer(host, "peer", new ToolCatalog(), {
  retry: false,
  config: () => ({ transport: "stdio", command: "/nonexistent/mcp-server-binary" }),
  log: () => {},
});
await h.firstAttempt;`;
    expect(await runAgainstTree(script)).toEqual({
      exitCode: 0,
      report: { state: "closed", pendingReconnects: 0 },
    });
    // The 30 s timeout is a backstop for a handle the count cannot see, not
    // the assertion: a clean run takes well under a second.
  }, 30_000);

  test("a retrying surface exits once its host disconnects (the shape's own cleanup)", async () => {
    // A retrying peer deliberately leaves mcp-host's ladder running — that
    // IS the retry. The shapes that use it either run forever (channel,
    // batch) or call disconnectAll() when their work ends (research); this
    // pins the second, which is the one that could otherwise hang.
    const script = `const h = registerOptionalMcpServer(host, "peer", new ToolCatalog(), {
  config: () => ({ transport: "stdio", command: "/nonexistent/mcp-server-binary" }),
  log: () => {},
});
await h.firstAttempt;
h.stop();
await host.disconnectAll();`;
    expect(await runAgainstTree(script)).toEqual({
      exitCode: 0,
      report: { state: "closed", pendingReconnects: 0 },
    });
  }, 30_000);

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
