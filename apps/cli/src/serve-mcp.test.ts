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
  isLoopbackRequest,
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

describe("isLoopbackRequest", () => {
  /** A request with exactly these headers; `Request` itself never adds a Host or an Origin. */
  const request = (headers: Record<string, string>): Request =>
    new Request("http://127.0.0.1:8000/", { method: "POST", headers });

  test.each(["127.0.0.1:8000", "localhost:8000", "localhost", "[::1]:8000", "[::1]", "LOCALHOST"])(
    "a Host of %s names this computer",
    (host) => {
      expect(isLoopbackRequest(request({ host }))).toBe(true);
    },
  );

  test.each([
    "other.example",
    "other.example:8000",
    "127.0.0.1.other.example",
    "localhost.other.example",
    "[::1].other.example",
    "[::1",
    "127.0.0.1:8000:9",
    "localhost:8000, other.example",
    "",
  ])("a Host of '%s' does not", (host) => {
    expect(isLoopbackRequest(request({ host }))).toBe(false);
  });

  test("a request with no Host at all does not", () => {
    expect(request({}).headers.get("host")).toBeNull();
    expect(isLoopbackRequest(request({}))).toBe(false);
  });

  test.each([
    "http://127.0.0.1:1",
    "http://localhost",
    "http://localhost:3000",
    "http://[::1]:3000",
  ])("with a loopback Host, an Origin of %s names this computer", (origin) => {
    expect(isLoopbackRequest(request({ host: "127.0.0.1:8000", origin }))).toBe(true);
  });

  test.each([
    "https://other.example",
    "http://127.0.0.1.other.example",
    "http://localhost.other.example",
    "null",
    "not a url",
  ])("with a loopback Host, an Origin of %s does not", (origin) => {
    expect(isLoopbackRequest(request({ host: "127.0.0.1:8000", origin }))).toBe(false);
  });

  test("a loopback Host with no Origin is enough", () => {
    expect(isLoopbackRequest(request({ host: "127.0.0.1:8000" }))).toBe(true);
  });

  test("a loopback Origin does not make up for another Host", () => {
    expect(isLoopbackRequest(request({ host: "other.example", origin: "http://localhost" }))).toBe(
      false,
    );
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
  test("says where --sse listens", () => {
    expect(SERVE_MCP_USAGE).toContain("listens on this computer only");
  });
});
