/**
 * v0.3.0 Goal 3 (design §4.1/§4.2, PR 16) — the `thredz:` one-knob lowering:
 * shorthand expansion, credential fail-fast, MCP synthesis riding the §4.2
 * secret machinery end-to-end (README env listing, strict-gate
 * resolvability), explicit-beats-implicit for a user-declared server, the
 * memory-backend flip, and the carried-with-note posture on the non-cli
 * memory shapes.
 */
import { describe, expect, test } from "bun:test";
import type { IrMcpStdioConfig, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { THREDZ_MCP_PACKAGE_SPEC, THREDZ_MCP_SERVER_NAME, compile, lower } from "./index";

const cliSpec = (extra: string) => `
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
${extra}
`;

function lowerCli(yaml: string): IrV0 {
  const ir = lower(parseSpec(yaml));
  if (ir.target !== "cli") throw new Error("unexpected target");
  return ir;
}

function thredzServer(ir: IrV0): IrMcpStdioConfig {
  const cfg = ir.mcp_servers[THREDZ_MCP_SERVER_NAME];
  if (cfg?.transport !== "stdio") throw new Error("expected a synthesized stdio thredz server");
  return cfg;
}

describe("thredz: lowering — shorthands and defaults (§4.1)", () => {
  test("boolean shorthand: `thredz: true` ≡ api_key $THREDZ_API_KEY, visibility private, goals on", () => {
    const ir = lowerCli(cliSpec("thredz: true"));
    expect(ir.thredz).toEqual({
      apiKey: { kind: "env", name: "THREDZ_API_KEY" },
      visibility: "private",
      // continuity is DEFAULT-ON on cli with plan on → goals mirror defaults on.
      goals: true,
    });
  });

  test("`thredz: false` is the explicit opt-out — nothing lowered, nothing synthesized", () => {
    const ir = lowerCli(cliSpec("thredz: false"));
    expect(ir.thredz).toBeUndefined();
    expect(ir.mcp_servers[THREDZ_MCP_SERVER_NAME]).toBeUndefined();
  });

  test("string shorthand: `thredz: $THREDZ_API_KEY` — THE one argument", () => {
    const ir = lowerCli(cliSpec("thredz: $THREDZ_API_KEY"));
    expect(ir.thredz?.apiKey).toEqual({ kind: "env", name: "THREDZ_API_KEY" });
  });

  test("object form carries base_url/visibility/goals/agents resolved", () => {
    const ir = lowerCli(
      cliSpec(
        [
          "thredz:",
          "  api_key: $MY_THREDZ_KEY",
          "  base_url: https://thredz.local/api",
          "  visibility: shared",
          "  goals: false",
          "  agents: my-expert",
        ].join("\n"),
      ),
    );
    expect(ir.thredz).toEqual({
      apiKey: { kind: "env", name: "MY_THREDZ_KEY" },
      baseUrl: "https://thredz.local/api",
      visibility: "shared",
      goals: false,
      agentName: "my-expert",
    });
  });

  test("agents: true derives the handle from the spec name", () => {
    const ir = lowerCli(cliSpec("thredz:\n  api_key: $THREDZ_API_KEY\n  agents: true"));
    expect(ir.thredz?.agentName).toBe("hello");
  });

  test("goals default follows continuity: `continuity: false` turns the mirror default off", () => {
    const ir = lowerCli(`${cliSpec("thredz: true")}continuity: false\n`);
    expect(ir.thredz?.goals).toBe(false);
    // plan: false keeps continuity but drops the goal surface → mirror off.
    const ir2 = lowerCli(`${cliSpec("thredz: true")}continuity:\n  plan: false\n`);
    expect(ir2.thredz?.goals).toBe(false);
  });

  test("credential fail-fast: a malformed $ref api_key fails the compile (never a baked literal)", () => {
    expect(() => lowerCli(cliSpec("thredz: $thredz_key"))).toThrow(/thredz\.api_key/);
    expect(() => lowerCli(cliSpec('thredz:\n  api_key: "${THREDZ_API_KEY}"'))).toThrow(
      /\$UPPER_SNAKE_CASE/,
    );
  });

  test("strict unions reject thredz: on non-memory shapes", () => {
    expect(() =>
      parseSpec(`
name: g
target: graph
model: claude-sonnet-4-6
entry: a
nodes:
  a:
    instructions: hi
edges: []
thredz: true
`),
    ).toThrow();
  });
});

describe("thredz: MCP synthesis (§4.1/§4.2 — the PR 5 machinery end-to-end)", () => {
  test("synthesizes the pinned npx stdio server with secret-ref env", () => {
    const ir = lowerCli(cliSpec("thredz: true"));
    expect(thredzServer(ir)).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", THREDZ_MCP_PACKAGE_SPEC],
      env: {
        THREDZ_API_KEY: { kind: "env", name: "THREDZ_API_KEY" },
        THREDZ_DEFAULT_VISIBILITY: { kind: "literal", value: "private" },
      },
    });
  });

  test("base_url and visibility land as literal env values", () => {
    const ir = lowerCli(
      cliSpec(
        "thredz:\n  api_key: $THREDZ_API_KEY\n  base_url: http://localhost:3000/api\n  visibility: shared",
      ),
    );
    expect(thredzServer(ir).env).toEqual({
      THREDZ_API_KEY: { kind: "env", name: "THREDZ_API_KEY" },
      THREDZ_API_BASE: { kind: "literal", value: "http://localhost:3000/api" },
      THREDZ_DEFAULT_VISIBILITY: { kind: "literal", value: "shared" },
    });
  });

  test("visibility defaults PRIVATE end-to-end: `thredz: true` compiles to THREDZ_DEFAULT_VISIBILITY=private in the emitted boot block", () => {
    const bundle = compile(cliSpec("thredz: true"));
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain('"THREDZ_DEFAULT_VISIBILITY":{"kind":"literal","value":"private"}');
    // The key itself is never baked — only the unresolved env ref.
    expect(agent).toContain('"THREDZ_API_KEY":{"kind":"env","name":"THREDZ_API_KEY"}');
  });

  test("a user-declared mcp_servers.thredz WINS over synthesis (explicit beats implicit)", () => {
    const ir = lowerCli(
      cliSpec(
        [
          "thredz: true",
          "mcp_servers:",
          "  thredz:",
          "    transport: stdio",
          "    command: bun",
          '    args: ["./thredz-mcp/server.ts"]',
          "    env:",
          "      THREDZ_API_KEY: $THREDZ_API_KEY",
        ].join("\n"),
      ),
    );
    const cfg = thredzServer(ir);
    expect(cfg.command).toBe("bun"); // the vendored escape hatch survives
    expect(cfg.args).toEqual(["./thredz-mcp/server.ts"]);
    // The wiring config is still carried — aliases + goal mirror ride the
    // user's server.
    expect(ir.thredz?.visibility).toBe("private");
  });

  test("other user-declared servers are preserved next to the synthesized entry (redundant-collapse safety)", () => {
    const ir = lowerCli(
      cliSpec(
        [
          "thredz: true",
          "mcp_servers:",
          "  files:",
          "    transport: stdio",
          "    command: mcp-files",
        ].join("\n"),
      ),
    );
    expect(Object.keys(ir.mcp_servers).sort()).toEqual(["files", "thredz"]);
  });

  test("the generated README lists THREDZ_API_KEY automatically (collectSecretRefs over the synthesized env)", () => {
    const bundle = compile(cliSpec("thredz: true"));
    const readme = bundle.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("- `THREDZ_API_KEY`");
  });

  test("compile({ strict: true }) passes on a thredz spec — the synthesized server introduces no unresolvable outward tool names", () => {
    expect(() => compile(cliSpec("thredz: true"), { strict: true })).not.toThrow();
  });

  test("the emitted bundle boots thredz through connectThredz BEFORE wireMemory and threads the connection", () => {
    const bundle = compile(cliSpec("thredz: true"));
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    const connectAt = agent.indexOf("const __thredz = await connectThredz(mcpHost, defaultCatalog");
    const wireAt = agent.indexOf("await wireMemory(");
    expect(connectAt).toBeGreaterThan(-1);
    expect(wireAt).toBeGreaterThan(connectAt); // MCP boot first — the flip needs the live client
    expect(agent).toContain("thredz: __thredz });");
    // The fragment carries the wiring slice, never the credential.
    expect(agent).toContain('"thredz":{"goals":true,"visibility":"private"}');
    expect(agent).not.toContain("apiKey");
    // Missing-key boot failures render the classified config report (exit 21).
    expect(agent).toContain('formatRunFailure(__report, { prefix: "crewhaus:" })');
    // The thredz server is NOT registered under namespaced names.
    expect(agent).not.toContain('registerMcpServer(mcpHost, "thredz"');
  });

  test("agents: registers the boot handle through connectThredz", () => {
    const bundle = compile(cliSpec("thredz:\n  api_key: $THREDZ_API_KEY\n  agents: true"));
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain('agentName: "hello"');
  });

  test("non-thredz bundles keep the pinned memory-before-mcp boot order byte-identically", () => {
    const yaml = cliSpec(
      ["mcp_servers:", "  files:", "    transport: stdio", "    command: mcp-files"].join("\n"),
    );
    const agent = compile(yaml).files.find((f) => f.path === "agent.ts")?.content ?? "";
    const wireAt = agent.indexOf("await wireMemory(");
    const mcpAt = agent.indexOf("const mcpHost = new McpHost();");
    expect(wireAt).toBeGreaterThan(-1);
    expect(mcpAt).toBeGreaterThan(wireAt); // the pre-thredz order, unchanged
    expect(agent).not.toContain("connectThredz");
  });
});

describe("thredz: memory-backend flip + cross-field validation (§4.3)", () => {
  test("a declared memory block flips to backend thredz", () => {
    const ir = lowerCli(`${cliSpec("thredz: true")}memory:\n  autoRecall: true\n  wiki: {}\n`);
    expect(ir.memory?.backend).toBe("thredz");
    expect(ir.memory?.autoRecall).toBe(true);
  });

  test("no memory block: nothing is synthesized into memory (the fragment carries thredz separately)", () => {
    const ir = lowerCli(cliSpec("thredz: true"));
    expect(ir.memory).toBeUndefined();
  });

  test("memory.backend thredz without the thredz: block is a compile error", () => {
    expect(() => lowerCli(`${cliSpec("")}memory:\n  backend: thredz\n`)).toThrow(
      /needs the top-level thredz: block/,
    );
  });

  test("memory.backend file alongside thredz: is a contradiction", () => {
    expect(() => lowerCli(`${cliSpec("thredz: true")}memory:\n  backend: file\n`)).toThrow(
      /contradicts the thredz: block/,
    );
  });
});

describe("thredz: emit-wired on channel + managed (Batch E, G23)", () => {
  const channelSpec = (extra: string) => `
name: chan
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  telegram:
    botToken: $TG_TOKEN
    secretToken: $TG_SECRET
routing:
  sessionKey: thread
${extra}
`;

  test("channel synthesizes mcp_servers.thredz + carries IrThredz (like cli)", () => {
    const ir = lower(parseSpec(channelSpec("thredz: true")));
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.thredz?.apiKey).toEqual({ kind: "env", name: "THREDZ_API_KEY" });
    const server = ir.mcp_servers[THREDZ_MCP_SERVER_NAME];
    if (server?.transport !== "stdio")
      throw new Error("expected a synthesized stdio thredz server");
    expect(server.args).toEqual(["-y", THREDZ_MCP_PACKAGE_SPEC]);
    expect(server.env?.["THREDZ_DEFAULT_VISIBILITY"]).toEqual({
      kind: "literal",
      value: "private",
    });
  });

  test("channel flips a declared memory block's backend to thredz", () => {
    const ir = lower(parseSpec(channelSpec("thredz: true\nmemory:\n  autoRecall: true")));
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.memory?.backend).toBe("thredz");
  });

  test("channel: memory.backend file alongside thredz is a loud contradiction", () => {
    expect(() => lower(parseSpec(channelSpec("thredz: true\nmemory:\n  backend: file")))).toThrow(
      /contradicts the thredz: block/,
    );
  });

  const managedSpec = (extra: string) => `
name: mng
target: managed
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
tenants:
  - id: t1
    budget: { maxInputTokens: 1, maxOutputTokens: 1 }
${extra}
`;

  test("managed carries IrThredz + flips backend (no mcp_servers field on the shape)", () => {
    const ir = lower(parseSpec(managedSpec("thredz: true\nmemory:\n  autoRecall: true")));
    if (ir.target !== "managed") throw new Error("unexpected target");
    expect(ir.thredz?.apiKey).toEqual({ kind: "env", name: "THREDZ_API_KEY" });
    expect(ir.memory?.backend).toBe("thredz");
    // managed has no mcp_servers key at all — the daemon synthesizes the
    // thredz server from IrThredz itself.
    expect("mcp_servers" in ir).toBe(false);
  });

  test("managed: memory.backend file alongside thredz is a loud contradiction", () => {
    expect(() => lower(parseSpec(managedSpec("thredz: true\nmemory:\n  backend: file")))).toThrow(
      /contradicts the thredz: block/,
    );
  });
});
