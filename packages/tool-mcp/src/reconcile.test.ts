/**
 * Loop contract 0.4 (Batch G, G74) — live tools/list_changed re-diff and
 * SkillRef.tools catalog narrowing.
 *
 * A drift-capable fake host lets us mutate a server's advertised tools and
 * fire its `onToolsChanged` seam; the reconcile/watch path re-diffs (stable
 * schema hashing) and applies the delta to the shared catalog.
 */
import { describe, expect, test } from "bun:test";
import { McpError } from "@crewhaus/errors";
import type { McpHost, McpToolDefinition } from "@crewhaus/mcp-host";
import { buildTool } from "@crewhaus/tool-builder";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import {
  diffToolSnapshots,
  driftIsEmpty,
  hashToolSchema,
  narrowToolsForActiveSkill,
  reconcileMcpServer,
  snapshotTools,
  watchMcpServer,
} from "./index.js";

/**
 * Fake host with ONE drift-capable server. `setTools` swaps the advertised
 * list; `fireChanged` invokes the registered onToolsChanged handlers (the
 * mcp-host contract); `refreshTools` returns the current list (bypassing any
 * cache, as the real client does).
 */
function makeDriftHost(
  serverName: string,
  initial: ReadonlyArray<McpToolDefinition>,
): {
  host: McpHost;
  setTools: (t: ReadonlyArray<McpToolDefinition>) => void;
  fireChanged: () => void;
} {
  let tools = initial;
  const handlers = new Set<() => void>();
  const client = {
    name: serverName,
    async connect() {},
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
      if (name !== serverName) throw new McpError(`unknown server "${name}"`);
      return client;
    },
    has: (name: string) => name === serverName,
    list: () => [{ name: serverName, client }],
    addServer: () => {
      throw new Error("unused");
    },
    disconnectAll: async () => undefined,
  };
  return {
    host: host as unknown as McpHost,
    setTools: (t) => {
      tools = t;
    },
    fireChanged: () => {
      for (const h of handlers) h();
    },
  };
}

const OBJ = { type: "object" as const };

describe("drift hashing + diff (G74)", () => {
  test("hashToolSchema is order-insensitive on object keys", () => {
    expect(hashToolSchema({ a: 1, b: 2 })).toBe(hashToolSchema({ b: 2, a: 1 }));
    expect(hashToolSchema({ a: 1 })).not.toBe(hashToolSchema({ a: 2 }));
  });

  test("diff classifies added / removed / schema-changed", () => {
    const prev = snapshotTools([
      { name: "keep", inputSchema: OBJ },
      { name: "drop", inputSchema: OBJ },
      { name: "morph", inputSchema: { type: "object", properties: { a: {} } } },
    ]);
    const next = snapshotTools([
      { name: "keep", inputSchema: OBJ },
      { name: "morph", inputSchema: { type: "object", properties: { a: {}, b: {} } } },
      { name: "new", inputSchema: OBJ },
    ]);
    const drift = diffToolSnapshots(prev, next);
    expect(drift.added).toEqual(["new"]);
    expect(drift.removed).toEqual(["drop"]);
    expect(drift.schemaChanged).toEqual(["morph"]);
    expect(driftIsEmpty(drift)).toBe(false);
  });

  test("no previous snapshot = all added (baseline)", () => {
    const next = snapshotTools([{ name: "a", inputSchema: OBJ }]);
    expect(diffToolSnapshots(undefined, next).added).toEqual(["a"]);
  });

  test("identical snapshots = empty drift", () => {
    const s = snapshotTools([{ name: "a", inputSchema: OBJ }]);
    expect(driftIsEmpty(diffToolSnapshots(s, s))).toBe(true);
  });
});

describe("reconcileMcpServer (G74)", () => {
  test("initial reconcile against an empty snapshot registers all tools", async () => {
    const { host } = makeDriftHost("srv", [
      { name: "alpha", inputSchema: OBJ },
      { name: "beta", inputSchema: OBJ },
    ]);
    const catalog = new ToolCatalog();
    const { drift, snapshot } = await reconcileMcpServer(host, "srv", catalog, undefined);
    expect(drift.added.sort()).toEqual(["alpha", "beta"]);
    expect(catalog.has("srv__alpha")).toBe(true);
    expect(catalog.has("srv__beta")).toBe(true);
    expect(snapshot.size).toBe(2);
  });

  test("an added tool is registered; a removed tool is unregistered", async () => {
    const fx = makeDriftHost("srv", [{ name: "alpha", inputSchema: OBJ }]);
    const catalog = new ToolCatalog();
    const first = await reconcileMcpServer(fx.host, "srv", catalog, undefined);

    fx.setTools([{ name: "beta", inputSchema: OBJ }]);
    const { drift } = await reconcileMcpServer(fx.host, "srv", catalog, first.snapshot);
    expect(drift.added).toEqual(["beta"]);
    expect(drift.removed).toEqual(["alpha"]);
    expect(catalog.has("srv__alpha")).toBe(false);
    expect(catalog.has("srv__beta")).toBe(true);
  });

  test("a schema-changed tool is re-registered under the same name", async () => {
    const fx = makeDriftHost("srv", [
      { name: "alpha", inputSchema: { type: "object", properties: { a: {} } } },
    ]);
    const catalog = new ToolCatalog();
    const first = await reconcileMcpServer(fx.host, "srv", catalog, undefined);
    const before = catalog.list().find((t) => t.name === "srv__alpha");

    fx.setTools([{ name: "alpha", inputSchema: { type: "object", properties: { a: {}, b: {} } } }]);
    const { drift } = await reconcileMcpServer(fx.host, "srv", catalog, first.snapshot);
    expect(drift.schemaChanged).toEqual(["alpha"]);
    const after = catalog.list().find((t) => t.name === "srv__alpha");
    expect(after).toBeDefined();
    // The JSON-schema bytes on the catalog reflect the new advertisement.
    expect(after?.jsonSchema).not.toEqual(before?.jsonSchema);
  });

  test("an empty drift leaves the catalog untouched", async () => {
    const fx = makeDriftHost("srv", [{ name: "alpha", inputSchema: OBJ }]);
    const catalog = new ToolCatalog();
    const first = await reconcileMcpServer(fx.host, "srv", catalog, undefined);
    const { drift } = await reconcileMcpServer(fx.host, "srv", catalog, first.snapshot);
    expect(driftIsEmpty(drift)).toBe(true);
    expect(catalog.list()).toHaveLength(1);
  });
});

describe("watchMcpServer (G74)", () => {
  test("registers initially and re-diffs on a tools/list_changed fire", async () => {
    const fx = makeDriftHost("srv", [{ name: "alpha", inputSchema: OBJ }]);
    const catalog = new ToolCatalog();
    const drifts: Array<{ added: readonly string[]; removed: readonly string[] }> = [];
    const watch = await watchMcpServer(fx.host, "srv", catalog, {
      onDrift: ({ drift }) => drifts.push({ added: drift.added, removed: drift.removed }),
    });
    expect(catalog.has("srv__alpha")).toBe(true);

    fx.setTools([
      { name: "alpha", inputSchema: OBJ },
      { name: "beta", inputSchema: OBJ },
    ]);
    fx.fireChanged();
    // The reconcile is serialised on an internal promise chain; let it settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(catalog.has("srv__beta")).toBe(true);
    expect(drifts.at(-1)?.added).toEqual(["beta"]);

    watch.stop();
    fx.setTools([{ name: "alpha", inputSchema: OBJ }]);
    fx.fireChanged();
    await new Promise((r) => setTimeout(r, 0));
    // Stopped — the removal is not applied.
    expect(catalog.has("srv__beta")).toBe(true);
  });
});

describe("narrowToolsForActiveSkill (G74)", () => {
  const tool = (name: string) =>
    buildTool({ name, description: name, inputSchema: undefined, execute: async () => "ok" });
  const tools = [tool("read"), tool("write"), tool("srv__remote")];

  test("undefined allow-list imposes no restriction", () => {
    expect(narrowToolsForActiveSkill(tools, undefined)).toEqual(tools);
  });

  test("narrows to the allow-list by model-facing name (incl. namespaced MCP)", () => {
    const narrowed = narrowToolsForActiveSkill(tools, ["read", "srv__remote"]);
    expect(narrowed.map((t) => t.name)).toEqual(["read", "srv__remote"]);
  });

  test("an empty allow-list means no tools", () => {
    expect(narrowToolsForActiveSkill(tools, [])).toHaveLength(0);
  });
});
