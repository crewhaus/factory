import { describe, expect, test } from "bun:test";
import {
  type FetchLike,
  buildInventory,
  claudeDesktopConfigPath,
  detectProviders,
  formatInventory,
  localBaseUrl,
  parseMcpConfig,
  probeLocalEndpoint,
} from "./doctor-detect";

describe("detectProviders", () => {
  test("infers each provider from its env vars", () => {
    const providers = detectProviders({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
      GEMINI_API_KEY: "g",
      AWS_PROFILE: "prod",
    });
    expect(providers.map((p) => p.id).sort()).toEqual(["anthropic", "bedrock", "gemini", "openai"]);
  });

  test("empty env yields no providers", () => {
    expect(detectProviders({})).toEqual([]);
  });

  test("records which env var made a provider look reachable", () => {
    const [p] = detectProviders({ OPENAI_BASE_URL: "http://vllm:8000/v1" });
    expect(p?.id).toBe("openai");
    expect(p?.via).toEqual(["OPENAI_BASE_URL"]);
  });
});

describe("localBaseUrl", () => {
  test("prefers OPENAI_BASE_URL when set", () => {
    expect(localBaseUrl({ OPENAI_BASE_URL: "http://vllm:8000/v1" })).toBe("http://vllm:8000/v1");
  });
  test("falls back to the Ollama default (LOCAL_DEFAULT_BASE_URL)", () => {
    expect(localBaseUrl({})).toBe("http://localhost:11434/v1");
  });
});

describe("probeLocalEndpoint", () => {
  test("lists model ids from a reachable /models response", async () => {
    const fetchImpl: FetchLike = async (url) => {
      expect(url).toBe("http://localhost:11434/v1/models");
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "llama3.2" }, { id: "qwen2.5" }] }),
      };
    };
    const result = await probeLocalEndpoint("http://localhost:11434/v1", fetchImpl);
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual(["llama3.2", "qwen2.5"]);
  });

  test("degrades to unreachable on a thrown fetch (connection refused)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await probeLocalEndpoint("http://localhost:11434/v1", fetchImpl);
    expect(result.reachable).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("degrades on a non-200 status", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const result = await probeLocalEndpoint("http://x/v1", fetchImpl);
    expect(result.reachable).toBe(false);
    expect(result.error).toBe("HTTP 503");
  });

  test("tolerates a malformed body (no data array)", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ nope: true }),
    });
    const result = await probeLocalEndpoint("http://x/v1", fetchImpl);
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual([]);
  });
});

describe("parseMcpConfig", () => {
  test("parses stdio + sse servers from a .mcp.json", () => {
    const text = JSON.stringify({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
        remote: { url: "https://mcp.example.com/sse" },
      },
    });
    const servers = parseMcpConfig(text, ".mcp.json");
    expect(servers).toEqual([
      {
        name: "fs",
        source: ".mcp.json",
        transport: "stdio",
        detail: "npx -y @modelcontextprotocol/server-filesystem /tmp",
      },
      {
        name: "remote",
        source: ".mcp.json",
        transport: "sse",
        detail: "https://mcp.example.com/sse",
      },
    ]);
  });

  test("tolerates malformed JSON (returns [])", () => {
    expect(parseMcpConfig("{not json", ".mcp.json")).toEqual([]);
  });

  test("tolerates a missing mcpServers key", () => {
    expect(parseMcpConfig(JSON.stringify({ other: 1 }), "x")).toEqual([]);
  });

  test("marks an entry with neither command nor url as unknown transport", () => {
    const text = JSON.stringify({ mcpServers: { weird: { foo: "bar" } } });
    expect(parseMcpConfig(text, "x")).toEqual([
      { name: "weird", source: "x", transport: "unknown" },
    ]);
  });
});

describe("buildInventory", () => {
  const okFetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "llama3.2" }] }),
  });

  test("assembles providers + local + mcp from injected seams", async () => {
    const inv = await buildInventory({
      env: { OPENAI_API_KEY: "sk" },
      fetchImpl: okFetch,
      readConfig: (p) =>
        p.endsWith(".mcp.json")
          ? JSON.stringify({ mcpServers: { fs: { command: "npx" } } })
          : undefined,
      configPaths: [".mcp.json", "/home/u/claude_desktop_config.json"],
    });
    expect(inv.providers.map((p) => p.id)).toEqual(["openai"]);
    expect(inv.local.reachable).toBe(true);
    expect(inv.local.models).toEqual(["llama3.2"]);
    expect(inv.mcpServers.map((s) => s.name)).toEqual(["fs"]);
  });

  test("de-dups an MCP server declared in two configs (first source wins)", async () => {
    const inv = await buildInventory({
      env: {},
      fetchImpl: okFetch,
      readConfig: (p) =>
        p === "a.json"
          ? JSON.stringify({ mcpServers: { dup: { command: "a" } } })
          : JSON.stringify({ mcpServers: { dup: { command: "b" }, extra: { command: "c" } } }),
      configPaths: ["a.json", "b.json"],
    });
    const dup = inv.mcpServers.find((s) => s.name === "dup");
    expect(dup?.source).toBe("a.json");
    expect(dup?.detail).toBe("a");
    expect(inv.mcpServers.map((s) => s.name).sort()).toEqual(["dup", "extra"]);
  });

  test("skipProbe reports the endpoint as not-probed without calling fetch", async () => {
    let called = false;
    const inv = await buildInventory({
      env: {},
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      readConfig: () => undefined,
      configPaths: [],
      skipProbe: true,
    });
    expect(called).toBe(false);
    expect(inv.local.reachable).toBe(false);
    expect(inv.local.error).toBe("probe skipped");
  });
});

describe("formatInventory", () => {
  test("renders providers, local models, and MCP servers", () => {
    const text = formatInventory({
      providers: [{ id: "openai", label: "OpenAI", via: ["OPENAI_API_KEY"] }],
      local: { baseUrl: "http://localhost:11434/v1", reachable: true, models: ["llama3.2"] },
      mcpServers: [{ name: "fs", source: ".mcp.json", transport: "stdio", detail: "npx" }],
    });
    expect(text).toContain("OpenAI");
    expect(text).toContain("llama3.2");
    expect(text).toContain("fs [stdio]");
  });

  test("renders the empty/none cases", () => {
    const text = formatInventory({
      providers: [],
      local: { baseUrl: "http://localhost:11434/v1", reachable: false, models: [], error: "down" },
      mcpServers: [],
    });
    expect(text).toContain("(none — no provider env vars visible)");
    expect(text).toContain("not reachable (down)");
    expect(text).toContain("(none found)");
  });
});

describe("claudeDesktopConfigPath", () => {
  test("macOS uses ~/Library/Application Support", () => {
    expect(claudeDesktopConfigPath("darwin", { HOME: "/Users/x" })).toBe(
      "/Users/x/Library/Application Support/Claude/claude_desktop_config.json",
    );
  });
  test("windows uses %APPDATA%", () => {
    expect(claudeDesktopConfigPath("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" })).toBe(
      "C:\\Users\\x\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
    );
  });
  test("linux has no official build → undefined", () => {
    expect(claudeDesktopConfigPath("linux", {})).toBeUndefined();
  });
});
