import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { SpecParseError, compile, lower } from "./index";

const MINIMAL_SPEC = `
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
`;

describe("compile", () => {
  test("emits a single-file bundle for a minimal CLI spec", () => {
    const bundle = compile(MINIMAL_SPEC);
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("generated bundle imports the runtime and configures the model", () => {
    const bundle = compile(MINIMAL_SPEC);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain('from "@crewhaus/runtime-core"');
    expect(content).toContain("runChatLoop");
    expect(content).toContain('"claude-sonnet-4-6"');
    expect(content).toContain("be helpful");
  });

  test("generated bundle escapes instructions safely (no raw injection)", () => {
    const bundle = compile(`
name: tricky
target: cli
agent:
  model: m
  instructions: |
    line "with quotes" and \\backslashes\\ and
    a newline.
`);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain(
      '"line \\"with quotes\\" and \\\\backslashes\\\\ and\\na newline.\\n"',
    );
  });

  test("propagates parse errors as SpecParseError", () => {
    expect(() => compile("not: a: valid: spec")).toThrow(SpecParseError);
  });

  test("emits no built-in tool imports when spec omits tools", () => {
    const content = compile(MINIMAL_SPEC).files[0]?.content ?? "";
    // Section 11 always wires hooks/skills/slash-commands and the catalog
    // (so a runtime-discovered Skill tool can register), but built-in tool
    // packages are still not imported when the spec doesn't request them.
    expect(content).not.toContain("@crewhaus/tool-fs");
    expect(content).not.toContain("@crewhaus/tool-bash");
    expect(content).not.toContain("@crewhaus/tool-todo");
    expect(content).not.toContain("defaultCatalog.register(read");
    expect(content).not.toContain("defaultCatalog.register(write");
    expect(content).not.toContain("defaultCatalog.register(bash");
  });

  test("emits Section 11 extension surface (hooks/skills/slash) on every CLI bundle", () => {
    const content = compile(MINIMAL_SPEC).files[0]?.content ?? "";
    expect(content).toContain('import { loadHooks } from "@crewhaus/hooks-engine";');
    expect(content).toContain(
      'import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";',
    );
    expect(content).toContain('import { loadCommands } from "@crewhaus/slash-commands";');
    expect(content).toContain("await Promise.all([");
    expect(content).toContain("loadHooks({ cwd: __cwd })");
    expect(content).toContain("discoverSkills({ cwd: __cwd })");
    expect(content).toContain("loadCommands({ cwd: __cwd })");
    expect(content).toContain("hooks: __hooks,");
    expect(content).toContain("skills: __skills,");
    expect(content).toContain("slashCommands: __slashCommands,");
  });
});

describe("compile with tools", () => {
  test("threads tools: [read] into the emitted bundle", () => {
    const content =
      compile(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
tools:
  - read
`).files[0]?.content ?? "";

    expect(content).toContain('import { defaultCatalog } from "@crewhaus/tool-catalog";');
    expect(content).toContain('import { read } from "@crewhaus/tool-fs";');
    expect(content).toContain("defaultCatalog.register(read);");
    expect(content).toContain("tools: defaultCatalog.list(),");
  });

  test("groups multiple exports from the same package into one import", () => {
    const content =
      compile(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - read
  - write
  - bash
`).files[0]?.content ?? "";

    // tool-fs exports get a single grouped import (sorted: read, write).
    expect(content).toContain('import { read, write } from "@crewhaus/tool-fs";');
    expect(content).toContain('import { bash } from "@crewhaus/tool-bash";');
    expect(content).toContain("defaultCatalog.register(read);");
    expect(content).toContain("defaultCatalog.register(write);");
    expect(content).toContain("defaultCatalog.register(bash);");
  });

  test("rejects unknown tool names at compile time", () => {
    expect(() =>
      compile(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - bogus
`),
    ).toThrow(/unknown tool "bogus"/);
  });
});

const MINIMAL_WORKFLOW_SPEC = `
name: hello-workflow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: list
    instructions: list files
    tools:
      - bash
  - name: summarize
    instructions: summarize what you found
`;

describe("compile with mcp_servers (Section 9)", () => {
  test("threads a stdio MCP server into the emitted bundle", () => {
    const content =
      compile(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
mcp_servers:
  fs:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
`).files[0]?.content ?? "";

    expect(content).toContain('import { McpHost } from "@crewhaus/mcp-host";');
    expect(content).toContain('import { registerMcpServer } from "@crewhaus/tool-mcp";');
    expect(content).toContain('import { defaultCatalog } from "@crewhaus/tool-catalog";');
    expect(content).toContain("new McpHost();");
    expect(content).toContain('mcpHost.addServer("fs",');
    expect(content).toContain('"transport":"stdio"');
    expect(content).toContain('"command":"npx"');
    expect(content).toContain("await Promise.all([");
    expect(content).toContain('registerMcpServer(mcpHost, "fs", defaultCatalog,');
    expect(content).toContain("tools: defaultCatalog.list(),");
    expect(content).toContain("try {");
    expect(content).toContain("await mcpHost.disconnectAll();");
  });

  test("threads SSE MCP servers and works alongside built-in tools", () => {
    const content =
      compile(`
name: dual
target: cli
agent:
  model: m
  instructions: i
tools:
  - bash
mcp_servers:
  remote:
    transport: sse
    url: https://example.com/sse
`).files[0]?.content ?? "";

    // Single defaultCatalog import even though both built-ins and MCP use it.
    const matches = content.match(/from "@crewhaus\/tool-catalog"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(content).toContain('import { bash } from "@crewhaus/tool-bash";');
    expect(content).toContain('mcpHost.addServer("remote",');
    expect(content).toContain('"transport":"sse"');
    expect(content).toContain('"url":"https://example.com/sse"');
  });

  test("emits no MCP plumbing when mcp_servers is omitted", () => {
    const content = compile(MINIMAL_SPEC).files[0]?.content ?? "";
    expect(content).not.toContain("@crewhaus/mcp-host");
    expect(content).not.toContain("@crewhaus/tool-mcp");
    expect(content).not.toContain("McpHost");
    expect(content).not.toContain("disconnectAll");
    expect(content).not.toContain("try {");
  });
});

describe("compile workflow target", () => {
  test("emits a single-file bundle for a workflow spec", () => {
    const bundle = compile(MINIMAL_WORKFLOW_SPEC);
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("generated workflow bundle imports runChatLoop and contains both step instructions", () => {
    const content = compile(MINIMAL_WORKFLOW_SPEC).files[0]?.content ?? "";
    expect(content).toContain('import { runChatLoop } from "@crewhaus/runtime-core";');
    expect(content).toContain('"list files"');
    expect(content).toContain('"summarize what you found"');
    // Both steps share the workflow-level model.
    expect(content).toContain('"claude-sonnet-4-6"');
  });

  test("generated workflow bundle threads per-step tools (Section 11 weaves Skill tool in)", () => {
    const content = compile(MINIMAL_WORKFLOW_SPEC).files[0]?.content ?? "";
    expect(content).toContain('import { bash } from "@crewhaus/tool-bash";');
    // Spec-declared tools appear in both branches of the skill conditional.
    expect(content).toContain("tools: __skillTool ? [bash, __skillTool] : [bash],");
  });

  test("per-step model override is resolved at lower-time and emitted", () => {
    const content =
      compile(`
name: w
target: workflow
model: default-model
steps:
  - name: a
    instructions: ai
    model: override-model
  - name: b
    instructions: bi
`).files[0]?.content ?? "";
    expect(content).toContain('"override-model"');
    expect(content).toContain('"default-model"');
  });

  test("rejects an unknown tool name in any workflow step", () => {
    expect(() =>
      compile(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
    tools:
      - bogus
`),
    ).toThrow(/unknown tool "bogus"/);
  });

  test("propagates parse errors as SpecParseError for invalid workflow YAML", () => {
    expect(() =>
      compile(`
name: w
target: workflow
model: m
steps: []
`),
    ).toThrow(SpecParseError);
  });
});

describe("compile channel target (Section 12)", () => {
  test("emits a 4-file bundle for a minimal channel spec", () => {
    const bundle = compile(`
name: hello-channel
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be a good bot
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
`);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["agent.ts", "daemon.ts", "gateway.ts", "session-router.ts"]);
  });

  test("env-ref secrets lower into process.env reads in daemon.ts", () => {
    const bundle = compile(`
name: hello-channel
target: channel
agent:
  model: m
  instructions: i
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
`);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain('process.env["SLACK_BOT_TOKEN"]');
    expect(daemon).toContain('process.env["SLACK_SIGNING_SECRET"]');
    expect(daemon).toContain("missing required env vars");
  });

  test("literal secrets are embedded verbatim and skip the env-check block", () => {
    const bundle = compile(`
name: hello-channel
target: channel
agent:
  model: m
  instructions: i
channels:
  slack:
    botToken: xoxb-literal-token
    signingSecret: literal-signing-secret
routing:
  sessionKey: user
`);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain('"xoxb-literal-token"');
    expect(daemon).toContain('"literal-signing-secret"');
    expect(daemon).not.toContain("missing required env vars");
  });

  test("agent.tools threaded through agent + tool registration", () => {
    const bundle = compile(`
name: hello-channel
target: channel
agent:
  model: m
  instructions: i
  tools:
    - read
    - sendMessage
channels:
  slack:
    botToken: x
    signingSecret: y
routing:
  sessionKey: thread
permissions:
  rules:
    - type: alwaysAllow
      pattern: SendMessage
`);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain('import { read } from "@crewhaus/tool-fs";');
    expect(daemon).toContain('import { sendMessage } from "@crewhaus/tool-message-channel";');
    expect(daemon).toContain("defaultCatalog.register(read);");
    expect(daemon).toContain("defaultCatalog.register(sendMessage);");
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain('pattern: "SendMessage"');
  });
});

describe("lower — compaction block (Pillar 2 curator wiring)", () => {
  test("preserves curator fields verbatim on the IR", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
compaction:
  model: claude-haiku-4
  curate: true
  dedupeThreshold: 0.85
  relevanceTopK: 7
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.compaction).toEqual({
      model: "claude-haiku-4",
      curate: true,
      dedupeThreshold: 0.85,
      relevanceTopK: 7,
    });
  });

  test("omits undefined curator fields from the IR (no false defaults)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
compaction:
  curate: true
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.compaction).toEqual({ curate: true });
    expect("dedupeThreshold" in ir.compaction).toBe(false);
    expect("relevanceTopK" in ir.compaction).toBe(false);
    expect("model" in ir.compaction).toBe(false);
  });

  test("empty compaction object lowers to empty IR compaction", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.compaction).toEqual({});
  });

  test("compile() succeeds end-to-end with curator config (no emitter rejection)", () => {
    const bundle = compile(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
compaction:
  curate: true
  dedupeThreshold: 0.9
  relevanceTopK: 10
`);
    expect(bundle.files).toHaveLength(1);
  });
});
