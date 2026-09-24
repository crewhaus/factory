/**
 * extension-path#16 — an MCP tool's trust flags can be tightened by the spec
 * (`mcp_servers.<n>.tool_flags`, carried on the server's config) and by the
 * server's own annotations, and by nothing in the loosening direction.
 *
 * Why it matters: auto mode allows every non-read-only, non-destructive tool
 * without asking, which before 0.7.1 was every MCP tool — a remote
 * `delete_repo` ran unasked. `destructive` is what makes auto mode ask.
 */
import { describe, expect, test } from "bun:test";
import { McpError } from "@crewhaus/errors";
import type { McpHost, McpToolDefinition, McpToolFlagsConfig } from "@crewhaus/mcp-host";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import {
  type RegisterMcpServerOptions,
  hashToolSchema,
  reconcileMcpServer,
  registerMcpServer,
  resolveMcpToolFlags,
  snapshotTools,
} from "./index.js";

function fakeHost(
  serverName: string,
  tools: () => ReadonlyArray<McpToolDefinition>,
  toolFlags?: McpToolFlagsConfig,
): McpHost {
  const client = {
    name: serverName,
    toolFlags,
    async connect() {},
    async listTools() {
      return tools();
    },
    async refreshTools() {
      return tools();
    },
    async callTool() {
      return { content: "ok", isError: false };
    },
    getState: () => ({ kind: "connected" }) as const,
  };
  return {
    getClient: (name: string) => {
      if (name !== serverName) throw new McpError(`unknown server "${name}"`);
      return client;
    },
    has: (name: string) => name === serverName,
  } as unknown as McpHost;
}

const schema = { type: "object" };
const flagsOf = (catalog: ToolCatalog, name: string) => {
  const t = catalog.get(name);
  if (t === undefined) throw new Error(`${name} not registered`);
  return {
    readOnly: t.readOnly,
    destructive: t.destructive,
    requireJustification: t.requireJustification,
  };
};

describe("resolveMcpToolFlags", () => {
  const none: RegisterMcpServerOptions = {};
  const remote = (annotations?: McpToolDefinition["annotations"]) => ({
    name: "delete_repo",
    ...(annotations !== undefined ? { annotations } : {}),
  });

  test("with nothing set, an MCP tool is neither read-only nor destructive, as in 0.7.0", () => {
    expect(resolveMcpToolFlags(none, "gh", remote(), undefined)).toEqual({
      concurrencySafe: false,
      readOnly: false,
      destructive: false,
      requireJustification: false,
    });
  });

  test("the spec's defaults and per_tool turn flags on", () => {
    expect(
      resolveMcpToolFlags(none, "gh", remote(), { defaults: { destructive: true } }).destructive,
    ).toBe(true);
    const perTool = { perTool: { delete_repo: { requireJustification: true as const } } };
    expect(resolveMcpToolFlags(none, "gh", remote(), perTool).requireJustification).toBe(true);
    // The registered name works as a key too.
    const namespaced = { perTool: { mcp__gh__delete_repo: { destructive: true as const } } };
    expect(resolveMcpToolFlags(none, "gh", remote(), namespaced).destructive).toBe(true);
  });

  test("the spec cannot turn a caller's flag off", () => {
    const caller: RegisterMcpServerOptions = {
      defaults: { destructive: true, requireJustification: true },
    };
    // Nothing in the spec's type can say false; an empty entry changes nothing.
    expect(resolveMcpToolFlags(caller, "gh", remote(), { defaults: {} })).toMatchObject({
      destructive: true,
      requireJustification: true,
    });
  });

  test("a server's destructiveHint: true and readOnlyHint: false tighten; the opposite hints do not loosen", () => {
    expect(
      resolveMcpToolFlags(none, "gh", remote({ destructiveHint: true }), undefined),
    ).toMatchObject({ destructive: true, readOnly: false });
    // A caller that marked the server's tools read-only is overruled by the
    // server saying a tool is not.
    const readOnlyCaller: RegisterMcpServerOptions = { defaults: { readOnly: true } };
    expect(
      resolveMcpToolFlags(readOnlyCaller, "gh", remote({ readOnlyHint: false }), undefined)
        .readOnly,
    ).toBe(false);
    // The loosening directions are claims a remote server cannot make stick.
    expect(
      resolveMcpToolFlags(none, "gh", remote({ readOnlyHint: true, destructiveHint: false }), {
        defaults: { destructive: true },
      }),
    ).toMatchObject({ readOnly: false, destructive: true });
  });

  test("a destructive tool is never read-only: read-only is a grant", () => {
    const readOnlyCaller: RegisterMcpServerOptions = { defaults: { readOnly: true } };
    expect(
      resolveMcpToolFlags(readOnlyCaller, "gh", remote(), { defaults: { destructive: true } }),
    ).toMatchObject({ readOnly: false, destructive: true });
  });
});

describe("registerMcpServer reads the flags off the server's config", () => {
  test("a spec-flagged remote delete is destructive — what makes auto mode ask", async () => {
    const tools: McpToolDefinition[] = [
      { name: "delete_repo", inputSchema: schema },
      { name: "list_repos", inputSchema: schema },
    ];
    const catalog = new ToolCatalog();
    await registerMcpServer(
      fakeHost("gh", () => tools, { perTool: { delete_repo: { destructive: true } } }),
      "gh",
      catalog,
    );
    expect(flagsOf(catalog, "mcp__gh__delete_repo").destructive).toBe(true);
    expect(flagsOf(catalog, "mcp__gh__list_repos").destructive).toBe(false);
  });

  test("the server's own destructiveHint tightens with no spec at all", async () => {
    const catalog = new ToolCatalog();
    await registerMcpServer(
      fakeHost("gh", () => [
        { name: "drop", inputSchema: schema, annotations: { destructiveHint: true } },
      ]),
      "gh",
      catalog,
    );
    expect(flagsOf(catalog, "mcp__gh__drop")).toEqual({
      readOnly: false,
      destructive: true,
      requireJustification: false,
    });
  });

  test("a hint that changes mid-run re-registers the tool with the tighter flags", async () => {
    let tools: McpToolDefinition[] = [{ name: "drop", inputSchema: schema }];
    const host = fakeHost("gh", () => tools);
    const catalog = new ToolCatalog();
    const first = await reconcileMcpServer(host, "gh", catalog, undefined);
    expect(flagsOf(catalog, "mcp__gh__drop").destructive).toBe(false);
    tools = [{ name: "drop", inputSchema: schema, annotations: { destructiveHint: true } }];
    const second = await reconcileMcpServer(host, "gh", catalog, first.snapshot);
    expect(second.drift.schemaChanged).toEqual(["drop"]);
    expect(flagsOf(catalog, "mcp__gh__drop").destructive).toBe(true);
  });

  test("a tool without hints snapshots exactly as before", () => {
    const plain = snapshotTools([{ name: "x", inputSchema: schema }]);
    const hinted = snapshotTools([
      { name: "x", inputSchema: schema, annotations: { destructiveHint: true } },
    ]);
    expect(plain.get("x")).toBe(hashToolSchema(schema));
    expect(hinted.get("x")).not.toBe(plain.get("x"));
  });
});
