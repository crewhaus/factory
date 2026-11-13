/**
 * What a candidate spec adds to the tool surface its base had: a recording of tool
 * results stands in for a check only when this is empty.
 */
import { describe, expect, test } from "bun:test";
import { addedToolSurface } from "./quality-runners";

function spec(tools: string[], servers: Record<string, string>): string {
  const lines = [
    "name: shop",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-5",
    "  instructions: Help the customer.",
    `tools: [${tools.join(", ")}]`,
  ];
  const names = Object.keys(servers);
  if (names.length > 0) {
    lines.push("mcp_servers:");
    for (const name of names) {
      lines.push(`  ${name}:`, "    transport: stdio", `    command: ${servers[name]}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

describe("addedToolSurface", () => {
  const base = spec(["read"], { fs: "npx" });

  test("equal specs add nothing", () => {
    expect(addedToolSurface(base, base)).toEqual([]);
  });

  test("a spec that drops a tool adds nothing", () => {
    expect(addedToolSurface(spec(["read", "write"], { fs: "npx" }), base)).toEqual([]);
  });

  test("a new MCP server is named", () => {
    expect(addedToolSurface(base, spec(["read"], { fs: "npx", web: "npx" }))).toEqual(["web"]);
  });

  test("an MCP server under the same name with another command is named", () => {
    expect(addedToolSurface(base, spec(["read"], { fs: "bunx" }))).toEqual(["fs"]);
  });

  test("a tool the base does not name is named", () => {
    expect(addedToolSurface(base, spec(["read", "write"], { fs: "npx" }))).toEqual(["write"]);
  });

  test("a spec that cannot be read answers that it cannot tell", () => {
    expect(addedToolSurface(base, "name: [unclosed\n")).toBeUndefined();
    expect(addedToolSurface("target: 3\n", base)).toBeUndefined();
  });
});
