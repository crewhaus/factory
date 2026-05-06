import { describe, expect, test } from "bun:test";
import { McpClient } from "./client.js";

/**
 * T2 — contract test against the official MCP everything-server reference.
 *
 * Gated behind `CREWHAUS_RUN_MCP_CONTRACT=1` because it spawns
 * `npx -y @modelcontextprotocol/server-everything`, which:
 *   - requires npm registry network access on first run (~5–30s download).
 *   - is flaky in sandboxed CI without a warmed npx cache.
 *
 * Run on demand:
 *   CREWHAUS_RUN_MCP_CONTRACT=1 bun --filter '@crewhaus/mcp-host' test
 */

const SHOULD_RUN = process.env["CREWHAUS_RUN_MCP_CONTRACT"] === "1";

describe.skipIf(!SHOULD_RUN)("MCP everything-server contract (T2)", () => {
  test("connects, lists tools, calls echo and add", async () => {
    const client = new McpClient(
      "everything",
      {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
      { connectTimeoutMs: 90_000 },
    );
    await client.connect();
    try {
      const tools = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("add");

      const echoResult = await client.callTool("echo", { message: "hello mcp" });
      expect(echoResult.isError).toBe(false);
      expect(echoResult.content).toContain("hello mcp");

      const addResult = await client.callTool("add", { a: 2, b: 3 });
      expect(addResult.isError).toBe(false);
      expect(addResult.content).toMatch(/5/);
    } finally {
      await client.disconnect();
    }
  }, 120_000);
});
