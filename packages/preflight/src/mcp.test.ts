import { describe, expect, test } from "bun:test";
import { mcpDryRunItems } from "./mcp";

describe("mcpDryRunItems", () => {
  test("unset env refs predict the exact boot ConfigError (blocking)", () => {
    const items = mcpDryRunItems(
      {
        thredz: {
          transport: "stdio",
          command: "bun",
          args: ["server.ts"],
          env: { THREDZ_API_KEY: "$THREDZ_API_KEY" },
        },
      },
      {},
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.level).toBe("blocking");
    expect(items[0]?.message).toContain("will not boot");
    expect(items[0]?.message).toContain("environment variable THREDZ_API_KEY is not set");
    expect(items[0]?.message).toContain('mcp server "thredz" env THREDZ_API_KEY');
    expect(items[0]?.envVar).toBe("THREDZ_API_KEY");
  });

  test("set env refs resolve to info; empty string counts as unset", () => {
    const servers = {
      thredz: {
        transport: "stdio" as const,
        command: "bun",
        env: { THREDZ_API_KEY: "$THREDZ_API_KEY" },
      },
    };
    const ok = mcpDryRunItems(servers, { THREDZ_API_KEY: "value" });
    expect(ok[0]?.level).toBe("info");
    const empty = mcpDryRunItems(servers, { THREDZ_API_KEY: "" });
    expect(empty[0]?.level).toBe("blocking");
  });

  test("$-shaped literals that will never expand are warn (G75 lint)", () => {
    const items = mcpDryRunItems(
      {
        files: {
          transport: "stdio",
          command: "bun",
          // Lowercase / braced values are NOT valid spec env refs — they
          // ship verbatim and the transports never expand them.
          env: { WORKDIR: "$workdir", MODE: "${MODE}" },
        },
      },
      {},
    );
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.level).toBe("warn");
      expect(item.message).toContain("NOT expanded by the MCP transports");
    }
  });

  test("malformed $… on a credential-shaped key predicts the compile failure (blocking)", () => {
    const items = mcpDryRunItems(
      {
        api: {
          transport: "sse",
          url: "https://mcp.example.com/sse",
          headers: { "x-api-key": "${API_KEY}" },
        },
      },
      {},
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.level).toBe("blocking");
    expect(items[0]?.message).toContain("compilation will fail");
    expect(items[0]?.message).toContain("$UPPER_SNAKE_CASE");
  });

  test("credential-shaped literals pasted into the spec are warn", () => {
    const literal = ["not", "a", "real", "credential", "0000"].join("-");
    const items = mcpDryRunItems(
      {
        api: {
          transport: "sse",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: `Bearer ${literal}` },
        },
        tool: {
          transport: "stdio",
          command: "bun",
          env: { SERVICE_TOKEN: literal },
        },
      },
      {},
    );
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.level).toBe("warn");
      expect(item.message).toContain("inline literal");
      expect(item.message).toContain("prefer a $ENV ref");
      // The value itself must never be echoed into the report.
      expect(item.message).not.toContain(literal);
    }
  });

  test("plain non-credential literals and absent blocks contribute nothing", () => {
    expect(mcpDryRunItems(undefined, {})).toEqual([]);
    expect(
      mcpDryRunItems(
        { files: { transport: "stdio", command: "bun", env: { WORKDIR: "/tmp/work" } } },
        {},
      ),
    ).toEqual([]);
  });
});

describe("mcpDryRunItems — optional servers (#406)", () => {
  test("required: false surfaces the optional contract as info", () => {
    const items = mcpDryRunItems(
      {
        peer: { transport: "sse", url: "https://peer.example/sse", required: false },
      },
      {},
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("mcp.peer.optional");
    expect(items[0]?.level).toBe("info");
    expect(items[0]?.message).toContain("optional (required: false)");
    expect(items[0]?.message).toContain("degrades");
  });

  test("an unset env ref on an OPTIONAL server warns instead of blocking", () => {
    const items = mcpDryRunItems(
      {
        peer: {
          transport: "sse",
          url: "https://peer.example/sse",
          headers: { Authorization: "$PEER_TOKEN" },
          required: false,
        },
      },
      {},
    );
    const ref = items.find((i) => i.id === "mcp.peer.header.Authorization");
    expect(ref?.level).toBe("warn");
    expect(ref?.message).toContain("optional server will be skipped");
    expect(ref?.message).toContain("PEER_TOKEN");
    // The same ref on a required server stays blocking.
    const blocking = mcpDryRunItems(
      {
        peer: {
          transport: "sse",
          url: "https://peer.example/sse",
          headers: { Authorization: "$PEER_TOKEN" },
        },
      },
      {},
    );
    expect(blocking.find((i) => i.id === "mcp.peer.header.Authorization")?.level).toBe("blocking");
  });

  test("required: true is not flagged as optional", () => {
    const items = mcpDryRunItems(
      {
        peer: { transport: "sse", url: "https://peer.example/sse", required: true },
      },
      {},
    );
    expect(items.find((i) => i.id === "mcp.peer.optional")).toBeUndefined();
  });
});
