import { describe, expect, test } from "bun:test";
import {
  SERVE_MCP_DEFAULT_PORT,
  SERVE_MCP_SUPPORTED_TARGET,
  SERVE_MCP_USAGE,
  ServeMcpError,
  assertServeTargetSupported,
  assertToolsModeSatisfiable,
  buildMcpSubAgentDescriptors,
  filterChildTools,
  resolveMcpToolsMode,
  resolveMcpTransport,
  resolveServePort,
} from "./serve-mcp";

describe("resolveMcpTransport", () => {
  test("--sse forces sse over any spec transport", () => {
    expect(resolveMcpTransport(true, "stdio")).toBe("sse");
    expect(resolveMcpTransport(true, undefined)).toBe("sse");
  });
  test("without --sse, the spec's expose.transport decides", () => {
    expect(resolveMcpTransport(false, "sse")).toBe("sse");
    expect(resolveMcpTransport(false, "stdio")).toBe("stdio");
  });
  test("no flag + no expose block → stdio (the default projection)", () => {
    expect(resolveMcpTransport(false, undefined)).toBe("stdio");
  });
});

describe("resolveMcpToolsMode", () => {
  test("uses the RESOLVED expose.tools value", () => {
    expect(resolveMcpToolsMode("chat")).toBe("chat");
    expect(resolveMcpToolsMode("per-subagent")).toBe("per-subagent");
  });
  test("absent expose block → chat (whole-agent projection)", () => {
    expect(resolveMcpToolsMode(undefined)).toBe("chat");
  });
});

describe("resolveServePort", () => {
  test("--port flag wins", () => {
    expect(resolveServePort("9001", "8123")).toBe(9001);
  });
  test("falls back to the env var, then the default", () => {
    expect(resolveServePort(undefined, "8123")).toBe(8123);
    expect(resolveServePort(undefined, undefined)).toBe(SERVE_MCP_DEFAULT_PORT);
    expect(resolveServePort(undefined, "")).toBe(SERVE_MCP_DEFAULT_PORT);
  });
  test("rejects a non-integer / out-of-range port", () => {
    expect(() => resolveServePort("abc", undefined)).toThrow(ServeMcpError);
    expect(() => resolveServePort("0", undefined)).toThrow(/1\.\.65535/);
    expect(() => resolveServePort("70000", undefined)).toThrow(ServeMcpError);
    expect(() => resolveServePort("80.5", undefined)).toThrow(ServeMcpError);
  });
  test("names CREWHAUS_MCP_PORT when the bad value came from the env", () => {
    expect(() => resolveServePort(undefined, "nope")).toThrow(/CREWHAUS_MCP_PORT/);
  });
});

describe("assertServeTargetSupported", () => {
  test("accepts the cli target", () => {
    expect(() => assertServeTargetSupported(SERVE_MCP_SUPPORTED_TARGET)).not.toThrow();
  });
  test("rejects a non-cli target with an actionable message", () => {
    expect(() => assertServeTargetSupported("voice")).toThrow(ServeMcpError);
    expect(() => assertServeTargetSupported("channel")).toThrow(/supports target: cli/);
  });
});

describe("assertToolsModeSatisfiable", () => {
  test("per-subagent with zero sub-agents throws", () => {
    expect(() => assertToolsModeSatisfiable("per-subagent", 0)).toThrow(ServeMcpError);
    expect(() => assertToolsModeSatisfiable("per-subagent", 0)).toThrow(/per-subagent/);
  });
  test("per-subagent with sub-agents, and chat regardless, are fine", () => {
    expect(() => assertToolsModeSatisfiable("per-subagent", 2)).not.toThrow();
    expect(() => assertToolsModeSatisfiable("chat", 0)).not.toThrow();
  });
});

describe("buildMcpSubAgentDescriptors", () => {
  test("projects name + description, dropping any extra fields", () => {
    expect(
      buildMcpSubAgentDescriptors([
        { name: "researcher", description: "digs up sources", instructions: "…" } as {
          name: string;
          description: string;
        },
        { name: "writer", description: "drafts prose" },
      ]),
    ).toEqual([
      { name: "researcher", description: "digs up sources" },
      { name: "writer", description: "drafts prose" },
    ]);
  });
});

describe("filterChildTools", () => {
  const tools = [{ name: "Read" }, { name: "Grep" }, { name: "Bash" }];
  test("keeps only the allowlisted tools, preserving parent order", () => {
    expect(filterChildTools(tools, ["Grep", "Read"]).map((t) => t.name)).toEqual(["Read", "Grep"]);
  });
  test("an empty allowlist yields an empty child catalog", () => {
    expect(filterChildTools(tools, [])).toEqual([]);
  });
  test("names not in the parent catalog are ignored", () => {
    expect(filterChildTools(tools, ["Nope", "Bash"]).map((t) => t.name)).toEqual(["Bash"]);
  });
});

describe("SERVE_MCP_USAGE", () => {
  test("documents the required --mcp flag and the --sse/--port options", () => {
    expect(SERVE_MCP_USAGE).toContain("--mcp");
    expect(SERVE_MCP_USAGE).toContain("--sse");
    expect(SERVE_MCP_USAGE).toContain("--port");
  });
});
