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

// Section 21 — pipeline vector-store backend selection. The IR/spec union
// was widened from the `in-memory`-only literal to every implemented
// backend (in-memory | lance | qdrant | pinecone | weaviate); lower() passes
// the id through and the emitter wires it into createVectorStore. HTTP
// backends also carry url/collection/apiKey so the bundle is runnable.
describe("lower/compile — pipeline vector backend (Section 21)", () => {
  const PIPELINE_SPEC = (retrieve: string) => `
name: doc-bot
target: pipeline
agent:
  model: claude-sonnet-4-6
  instructions: answer using Retrieve
retrieve:
${retrieve}
indexing:
  chunkStrategy: fixed
  chunkSize: 200
  chunkOverlap: 0
  documents:
    - id: doc-1
      text: the quick brown fox
`;

  test("a lance spec lowers with vectorBackend: lance", () => {
    const ir = lower(parseSpec(PIPELINE_SPEC("  embedderModel: mock/det\n  vectorBackend: lance")));
    if (ir.target !== "pipeline") throw new Error("unexpected target");
    expect(ir.retrieve.vectorBackend).toBe("lance");
  });

  test('a lance spec compiles to createVectorStore({ backend: "lance" })', () => {
    const bundle = compile(PIPELINE_SPEC("  embedderModel: mock/det\n  vectorBackend: lance"));
    const agent = bundle.files[0]?.content ?? "";
    expect(agent).toContain('createVectorStore({ backend: "lance" })');
  });

  test("an omitted vectorBackend still defaults to in-memory (unchanged call)", () => {
    const bundle = compile(PIPELINE_SPEC("  embedderModel: mock/det"));
    const agent = bundle.files[0]?.content ?? "";
    expect(agent).toContain('createVectorStore({ backend: "in-memory" })');
  });

  test("an http backend surfaces url + collection + env-ref apiKey into the call", () => {
    const bundle = compile(
      PIPELINE_SPEC(
        [
          "  embedderModel: mock/det",
          "  vectorBackend: qdrant",
          "  url: https://qdrant.example",
          "  collection: docs",
          "  apiKey: $QDRANT_API_KEY",
        ].join("\n"),
      ),
    );
    const agent = bundle.files[0]?.content ?? "";
    expect(agent).toContain(
      'createVectorStore({ backend: "qdrant", url: "https://qdrant.example", apiKey: process.env["QDRANT_API_KEY"], collection: "docs" })',
    );
  });

  test("a literal apiKey lowers to a literal (env-ref is opt-in via $VAR)", () => {
    const ir = lower(
      parseSpec(
        PIPELINE_SPEC(
          [
            "  embedderModel: mock/det",
            "  vectorBackend: pinecone",
            "  url: https://pinecone.example",
            "  collection: docs",
            "  apiKey: pc-literal-key",
          ].join("\n"),
        ),
      ),
    );
    if (ir.target !== "pipeline") throw new Error("unexpected target");
    expect(ir.retrieve.apiKey).toEqual({ kind: "literal", value: "pc-literal-key" });
  });

  test("an http backend without url is rejected at parse time", () => {
    expect(() =>
      compile(
        PIPELINE_SPEC("  embedderModel: mock/det\n  vectorBackend: qdrant\n  collection: docs"),
      ),
    ).toThrow(/requires retrieve\.url/);
  });

  test("an http backend without collection is rejected at parse time", () => {
    expect(() =>
      compile(
        PIPELINE_SPEC(
          "  embedderModel: mock/det\n  vectorBackend: weaviate\n  url: https://weaviate.example",
        ),
      ),
    ).toThrow(/requires retrieve\.collection/);
  });
});

// FR-004 — Pillar 3 security block lowered into ir.security.
describe("lower — security block (Pillar 3 intent-gate judge)", () => {
  test("populates ir.security.justification verbatim (judge + model)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
security:
  justification:
    judge: claude
    model: claude-haiku-4-5
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.security).toEqual({
      justification: { judge: "claude", model: "claude-haiku-4-5" },
    });
  });

  test("omits the judge model when the spec omits it (no false default)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  justification:
    judge: claude
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.security).toEqual({ justification: { judge: "claude" } });
    expect("model" in (ir.security?.justification ?? {})).toBe(false);
  });

  test("absent security block leaves ir.security undefined (spread-out)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.security).toBeUndefined();
    expect("security" in ir).toBe(false);
  });

  test("security block present but justification omitted leaves ir.security undefined", () => {
    // A `security: {}` block carries no justification choice, so the run
    // path falls back to rule-based; the IR field stays absent.
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security: {}
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.security).toBeUndefined();
  });
});

// FR-006 — Pillar 3 sink-side egress-matcher selector lowered into
// ir.security.egressMatcher. This is the seam that closes the "flag parsed
// but not threaded" gap: the run path reads ir.security.egressMatcher and
// constructs the matcher, so a verbatim lowering assertion is the proof the
// selector actually reaches generated/run code rather than being dropped.
describe("lower — security.egressMatcher (Pillar 3 sink-side matcher, FR-006)", () => {
  test("lowers egressMatcher: semantic verbatim into ir.security", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  egressMatcher: semantic
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.security).toEqual({ egressMatcher: "semantic" });
  });

  test("lowers egressMatcher: substring verbatim (the explicit default)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  egressMatcher: substring
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.security).toEqual({ egressMatcher: "substring" });
  });

  test("a lone egressMatcher (no justification) still produces ir.security — the block is NOT dropped", () => {
    // Regression guard for the old lowerSecurity early-return that bailed
    // whenever justification was absent, which would have silently dropped a
    // standalone egressMatcher selector.
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  egressMatcher: semantic
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.security).toBeDefined();
    expect(ir.security?.egressMatcher).toBe("semantic");
    expect("justification" in (ir.security ?? {})).toBe(false);
  });

  test("egressMatcher coexists with justification — both lower into the same block", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  justification:
    judge: claude
    model: claude-haiku-4-5
  egressMatcher: semantic
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.security).toEqual({
      justification: { judge: "claude", model: "claude-haiku-4-5" },
      egressMatcher: "semantic",
    });
  });

  test("absent egressMatcher leaves the field off ir.security (justification still lowers alone)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  justification:
    judge: rule-based
`);
    const ir = lower(spec);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.security).toEqual({ justification: { judge: "rule-based" } });
    expect("egressMatcher" in (ir.security ?? {})).toBe(false);
  });
});

describe("lower — wallet keyRef policy (Section 47, #159 CWE-798)", () => {
  const ONCHAIN_SPEC = (keyRef: string) => `
name: treasury-daemon
target: onchain
agent:
  model: m
  instructions: i
chains:
  - id: base-mainnet
    kind: evm
    rpcUrls:
      - $BASE_RPC
    rpcPolicy: single
    finality:
      kind: confirmations
      count: 12
    reorgTolerant: true
wallets:
  - id: treasurer
    chainId: base-mainnet
    custody: local
    signingPolicy: automated
    keyRef: "${keyRef}"
contracts:
  - id: treasury
    chainId: base-mainnet
    address: "0xTREASURY"
    abiRef: abi://safe
triggers:
  - kind: block
    chainId: base-mainnet
    scanIntervalMs: 30000
`;

  test("lowers a $ENV_REF wallet keyRef into an env reference", () => {
    const ir = lower(parseSpec(ONCHAIN_SPEC("$TREASURER_KEY")));
    if (ir.target !== "onchain") throw new Error("unexpected target");
    expect(ir.wallets[0]?.keyRef).toEqual({ kind: "env", name: "TREASURER_KEY" });
  });

  test("lowers a kms:// wallet keyRef handle as a literal", () => {
    const ir = lower(parseSpec(ONCHAIN_SPEC("kms://aws/treasurer-key")));
    if (ir.target !== "onchain") throw new Error("unexpected target");
    expect(ir.wallets[0]?.keyRef).toEqual({ kind: "literal", value: "kms://aws/treasurer-key" });
  });

  test("rejects a raw hex private key wallet keyRef", () => {
    expect(() =>
      lower(
        parseSpec(
          ONCHAIN_SPEC("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
        ),
      ),
    ).toThrow(/raw private key/);
  });

  test("rejects an arbitrary literal wallet keyRef that is not an env ref or handle", () => {
    expect(() => lower(parseSpec(ONCHAIN_SPEC("my-secret-passphrase")))).toThrow(
      /not a permitted signing-key reference/,
    );
  });

  test("compile() embeds an env-ref keyRef and binds contractAddresses (#151)", () => {
    const bundle = compile(ONCHAIN_SPEC("$TREASURER_KEY"));
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain('process.env["TREASURER_KEY"]');
    expect(agent).toContain('"contractAddresses":{"treasury":"0xTREASURY"}');
  });

  test("compile() fails closed on a raw hex private key keyRef", () => {
    expect(() =>
      compile(ONCHAIN_SPEC("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")),
    ).toThrow(/raw private key/);
  });
});

describe("compile({ strict: true }) — FR-002 sink-side scope gate", () => {
  // An outward-by-name tool referenced in a spec (here a dynamic MCP sink the
  // compiler cannot resolve to a scope:"external" tool offline). This lowers
  // fine (the spec schema accepts any non-empty tool string) but is an
  // unverifiable external sink — the gate must refuse it BEFORE emit.
  const SPEC_WITH_MCP_SINK = `
name: leaky
target: cli
agent:
  model: m
  instructions: i
tools:
  - mcp__evil__exfiltrate
`;

  // Clean spec: only internal-compute built-ins. No outward names.
  const SPEC_INTERNAL_TOOLS = `
name: clean
target: cli
agent:
  model: m
  instructions: i
tools:
  - read
  - bash
`;

  test("fails on an outward-named sink referenced by the spec", () => {
    expect(() => compile(SPEC_WITH_MCP_SINK, { strict: true })).toThrow(/\[strict\]/);
    expect(() => compile(SPEC_WITH_MCP_SINK, { strict: true })).toThrow(/mcp__evil__exfiltrate/);
  });

  test('the strict failure names the expected remedy (scope: "external")', () => {
    expect(() => compile(SPEC_WITH_MCP_SINK, { strict: true })).toThrow(/scope: "external"/);
  });

  test("passes a spec whose tools are all internal-compute built-ins", () => {
    const bundle = compile(SPEC_INTERNAL_TOOLS, { strict: true });
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("nested tool sites (workflow steps) are audited too", () => {
    const spec = `
name: leaky-flow
target: workflow
model: m
steps:
  - name: reach-out
    instructions: send it
    tools:
      - mcp__slack__send
`;
    expect(() => compile(spec, { strict: true })).toThrow(/mcp__slack__send/);
  });

  test("DEFAULT (no strict) does NOT run the gate — backwards compatible", () => {
    // Without { strict: true } the outward-named spec is not gated by scope
    // (it would instead fall through to the emitter's own resolution); the
    // gate is strictly opt-in so existing compile() callers are unchanged.
    // A clean spec compiles identically with and without the flag.
    const withFlag = compile(SPEC_INTERNAL_TOOLS, { strict: true }).files[0]?.content;
    const without = compile(SPEC_INTERNAL_TOOLS).files[0]?.content;
    expect(without).toBe(withFlag);
  });
});
