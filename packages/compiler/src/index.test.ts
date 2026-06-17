import { describe, expect, test } from "bun:test";
import type { IrNode } from "@crewhaus/ir";
import { type Spec, parseSpec } from "@crewhaus/spec";
import {
  SpecParseError,
  assertChainGameLowered,
  assertToolScopesStrict,
  compile,
  lower,
} from "./index";

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

describe("assertToolScopesStrict (exported gate, used directly by non-CLI emit paths)", () => {
  test("throws CompilerError when an IR references an outward-by-name sink", () => {
    const ir = lower(
      parseSpec(`
name: leaky
target: cli
agent:
  model: m
  instructions: i
tools:
  - mcp__evil__exfiltrate
`),
    );
    expect(() => assertToolScopesStrict(ir)).toThrow(/\[strict\]/);
    expect(() => assertToolScopesStrict(ir)).toThrow(/mcp__evil__exfiltrate/);
  });

  test("is a no-op for an IR whose tools are all internal-compute built-ins", () => {
    const ir = lower(
      parseSpec(`
name: clean
target: cli
agent:
  model: m
  instructions: i
tools:
  - read
  - bash
`),
    );
    expect(() => assertToolScopesStrict(ir)).not.toThrow();
  });

  test("audits the six definitionally-outward built-in names (not just mcp__*)", () => {
    // SendMessage is in OUTWARD_TOOL_NAMES — the gate must flag it even though
    // it is not an mcp__ sink. Drives the OUTWARD_TOOL_NAMES branch of
    // isOutwardName from compile()'s perspective.
    const ir = lower(
      parseSpec(`
name: msg
target: cli
agent:
  model: m
  instructions: i
tools:
  - SendMessage
`),
    );
    expect(() => assertToolScopesStrict(ir)).toThrow(/SendMessage/);
  });
});

describe("compile({ applyIrPasses: true }) — Section 28 ir-passes opt-in", () => {
  test("runs the passes pipeline and still emits a bundle (minimal CLI is a pass-through)", () => {
    const bundle = compile(MINIMAL_SPEC, { applyIrPasses: true });
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("a minimal CLI spec emits identical output with and without the passes flag", () => {
    const withPasses = compile(MINIMAL_SPEC, { applyIrPasses: true }).files[0]?.content;
    const without = compile(MINIMAL_SPEC).files[0]?.content;
    expect(withPasses).toBe(without);
  });
});

describe("lower — CLI banner + TUI block (Phase 3 §3.3 / Phase 2 M2.2)", () => {
  test("lowers a random-mode banner with taglines and a non-basic tui", () => {
    const ir = lower(
      parseSpec(`
name: cl
target: cli
agent:
  model: m
  instructions: i
cli:
  banner:
    taglineMode: random
    taglines:
      - hello
      - world
  tui: rich
`),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.cli).toEqual({
      banner: { taglineMode: "random", taglines: ["hello", "world"] },
      tui: "rich",
    });
  });

  test("a cli block with neither banner nor a non-basic tui lowers to an empty cli object", () => {
    // banner omitted (so the banner spread is skipped) and tui defaults to
    // "basic" (so the tui spread is skipped) → ir.cli is present but empty.
    const ir = lower(
      parseSpec(`
name: cl
target: cli
agent:
  model: m
  instructions: i
cli:
  tui: basic
`),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.cli).toEqual({});
  });

  test("a banner without a tui override carries the banner and omits tui", () => {
    const ir = lower(
      parseSpec(`
name: cl
target: cli
agent:
  model: m
  instructions: i
cli:
  banner:
    taglineMode: static
    taglines:
      - solo tagline
`),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.cli).toEqual({
      banner: { taglineMode: "static", taglines: ["solo tagline"] },
    });
    expect("tui" in (ir.cli ?? {})).toBe(false);
  });

  test("compile() succeeds end-to-end with a banner + rich tui CLI spec", () => {
    const bundle = compile(`
name: cl
target: cli
agent:
  model: m
  instructions: i
cli:
  banner:
    taglineMode: static
    taglines:
      - ready
  tui: rich
`);
    expect(bundle.files).toHaveLength(1);
  });
});

describe("lower/compile — graph target (Section 19)", () => {
  const GRAPH_SPEC = `
name: g
target: graph
model: graph-model
entry: a
nodes:
  a:
    instructions: do a
    model: node-model
    tools:
      - bash
    hitl:
      prompt: approve a?
  b:
    instructions: do b
edges:
  - from: a
    to: b
`;

  test("emits a bundle and preserves node order, per-node model + hitl prompt", () => {
    const ir = lower(parseSpec(GRAPH_SPEC));
    if (ir.target !== "graph") throw new Error("unexpected target");
    expect(ir.nodes.map((n) => n.name)).toEqual(["a", "b"]);
    expect(ir.nodes[0]?.model).toBe("node-model");
    // node "b" inherits the graph-level model fallback.
    expect(ir.nodes[1]?.model).toBe("graph-model");
    expect(ir.nodes[0]).toHaveProperty("hitlPrompt", "approve a?");
    expect(ir.nodes[1]).not.toHaveProperty("hitlPrompt");
    expect(ir.edges).toEqual([{ from: "a", to: "b" }]);
    const bundle = compile(GRAPH_SPEC);
    expect(bundle.files.length).toBeGreaterThan(0);
  });
});

describe("lower/compile — managed target (Section 20)", () => {
  test("lowers tenant budgets verbatim and emits a multi-file bundle", () => {
    const spec = `
name: mg
target: managed
agent:
  model: m
  instructions: i
tenants:
  - id: t1
    budget:
      maxInputTokens: 1000
      maxOutputTokens: 2000
`;
    const ir = lower(parseSpec(spec));
    if (ir.target !== "managed") throw new Error("unexpected target");
    expect(ir.tenants).toEqual([
      { id: "t1", budget: { maxInputTokens: 1000, maxOutputTokens: 2000 } },
    ]);
    const bundle = compile(spec);
    expect(bundle.files.map((f) => f.path)).toContain("daemon.ts");
  });
});

describe("lower/compile — crew target (Section 22)", () => {
  const CREW_SPEC = `
name: cr
target: crew
model: crew-model
entry: lead
roles:
  lead:
    instructions: lead it
    tools:
      - bash
    tool_config:
      bash:
        timeout: 1000
    sub_agents:
      helper-sub:
        description: helps
        instructions: help out
  zebra:
    instructions: trail role
    model: zebra-model
routing:
  kind: match
  match:
    lead:
      - contains: hi
        to: zebra
`;

  test("sorts roles by name, resolves per-role model fallback, lowers routing", () => {
    const ir = lower(parseSpec(CREW_SPEC));
    if (ir.target !== "crew") throw new Error("unexpected target");
    // Roles are sorted: "lead" < "zebra".
    expect(ir.roles.map((r) => r.name)).toEqual(["lead", "zebra"]);
    // "lead" omits model → inherits crew-level fallback; "zebra" overrides.
    expect(ir.roles[0]?.model).toBe("crew-model");
    expect(ir.roles[1]?.model).toBe("zebra-model");
    // Sub-agents lowered on the role.
    expect(ir.roles[0]?.subAgents).toHaveLength(1);
    expect(ir.roles[0]?.subAgents[0]?.name).toBe("helper-sub");
    expect(ir.routing).toEqual({
      kind: "match",
      match: { lead: [{ contains: "hi", to: "zebra" }] },
    });
    const bundle = compile(CREW_SPEC);
    expect(bundle.files.length).toBeGreaterThan(0);
  });

  test("omits routing from the IR when the spec has no routing block", () => {
    const ir = lower(
      parseSpec(`
name: cr2
target: crew
model: m
entry: only
roles:
  only:
    instructions: solo
`),
    );
    if (ir.target !== "crew") throw new Error("unexpected target");
    expect("routing" in ir).toBe(false);
  });

  test("lowers an llm routing block without a match map", () => {
    const ir = lower(
      parseSpec(`
name: cr3
target: crew
model: m
entry: only
roles:
  only:
    instructions: solo
routing:
  kind: llm
`),
    );
    if (ir.target !== "crew") throw new Error("unexpected target");
    expect(ir.routing).toEqual({ kind: "llm" });
  });
});

describe("lower/compile — research target (Section 23 RES)", () => {
  test("lowers retrieve allowlists + optional vectorBackend and emits", () => {
    const spec = `
name: rs
target: research
agent:
  model: m
  instructions: i
goal: find stuff
branchingFactor: 4
maxDurationMs: 120000
retrieve:
  allowedOrigins:
    - https://example.com
  allowedFileRoots:
    - /tmp/docs
  vectorBackend: lance
tools:
  - bash
`;
    const ir = lower(parseSpec(spec));
    if (ir.target !== "research") throw new Error("unexpected target");
    expect(ir.goal).toBe("find stuff");
    expect(ir.branchingFactor).toBe(4);
    expect(ir.retrieve.allowedOrigins).toEqual(["https://example.com"]);
    expect(ir.retrieve.allowedFileRoots).toEqual(["/tmp/docs"]);
    expect(ir.retrieve.vectorBackend).toBe("lance");
    expect(compile(spec).files.length).toBeGreaterThan(0);
  });

  test("omits vectorBackend from retrieve when the spec omits it", () => {
    const ir = lower(
      parseSpec(`
name: rs2
target: research
agent:
  model: m
  instructions: i
goal: g
`),
    );
    if (ir.target !== "research") throw new Error("unexpected target");
    expect("vectorBackend" in ir.retrieve).toBe(false);
  });
});

describe("lower/compile — batch target (Section 23 BATCH)", () => {
  test("lowers queue config (renew interval + seed jobs) and emits", () => {
    const spec = `
name: bt
target: batch
agent:
  model: m
  instructions: i
queue:
  adapter: in-memory
  visibilityTimeoutMs: 15000
  visibilityRenewIntervalMs: 5000
  maxRetries: 5
  seedJobs:
    - "{\\"x\\":1}"
concurrency: 8
idempotencyWindowMs: 30000
tools:
  - bash
`;
    const ir = lower(parseSpec(spec));
    if (ir.target !== "batch") throw new Error("unexpected target");
    expect(ir.queue.adapter).toBe("in-memory");
    expect(ir.queue.visibilityRenewIntervalMs).toBe(5000);
    expect(ir.queue.seedJobs).toEqual(['{"x":1}']);
    expect(ir.concurrency).toBe(8);
    expect(compile(spec).files.length).toBeGreaterThan(0);
  });

  test("omits optional queue fields when the spec omits them", () => {
    const ir = lower(
      parseSpec(`
name: bt2
target: batch
agent:
  model: m
  instructions: i
queue:
  adapter: in-memory
`),
    );
    if (ir.target !== "batch") throw new Error("unexpected target");
    expect("visibilityRenewIntervalMs" in ir.queue).toBe(false);
    expect("seedJobs" in ir.queue).toBe(false);
  });
});

describe("lower/compile — voice target (Section 24 VOICE)", () => {
  test("lowers voice block + optional telephony and emits", () => {
    const spec = `
name: vc
target: voice
agent:
  model: m
  instructions: i
voice:
  provider: openai
  voiceId: nova
  vad: server
  bargeInTriggerFrames: 5
  bargeInWindowMs: 300
telephony:
  provider: twilio
tools:
  - bash
`;
    const ir = lower(parseSpec(spec));
    if (ir.target !== "voice") throw new Error("unexpected target");
    expect(ir.voice.provider).toBe("openai");
    expect(ir.voice.voiceId).toBe("nova");
    expect(ir.telephony).toEqual({ provider: "twilio" });
    expect(compile(spec).files.length).toBeGreaterThan(0);
  });

  test("omits telephony from the IR when the spec omits it", () => {
    const ir = lower(
      parseSpec(`
name: vc2
target: voice
agent:
  model: m
  instructions: i
voice:
  provider: vapi
`),
    );
    if (ir.target !== "voice") throw new Error("unexpected target");
    expect("telephony" in ir).toBe(false);
  });
});

describe("lower/compile — browser target (Section 25 BROW)", () => {
  test("lowers driver (startUrl) + grounding model override and emits", () => {
    const spec = `
name: br
target: browser
agent:
  model: agent-model
  instructions: i
driver:
  backend: chromium
  viewport:
    width: 800
    height: 600
  startUrl: https://example.com/
groundingModel: ground-model
tools:
  - bash
`;
    const ir = lower(parseSpec(spec));
    if (ir.target !== "browser") throw new Error("unexpected target");
    expect(ir.driver.backend).toBe("chromium");
    expect(ir.driver.viewport).toEqual({ width: 800, height: 600 });
    expect(ir.driver).toHaveProperty("startUrl", "https://example.com/");
    expect(ir.groundingModel).toBe("ground-model");
    expect(compile(spec).files.length).toBeGreaterThan(0);
  });

  test("defaults groundingModel to the agent model and omits startUrl when absent", () => {
    const ir = lower(
      parseSpec(`
name: br2
target: browser
agent:
  model: only-model
  instructions: i
`),
    );
    if (ir.target !== "browser") throw new Error("unexpected target");
    expect(ir.groundingModel).toBe("only-model");
    expect("startUrl" in ir.driver).toBe(false);
  });
});

describe("lower/compile — eval target (Section 29)", () => {
  test("lowers dataset + graders (with/without opts) + seed and emits", () => {
    const spec = `
name: ev
target: eval
agent:
  model: m
  instructions: i
  tools:
    - bash
dataset:
  name: ds
  version: v1
  split: test
graders:
  - name: exact
    opts:
      k: 1
  - name: contains
seed: 42
`;
    const ir = lower(parseSpec(spec));
    if (ir.target !== "eval") throw new Error("unexpected target");
    expect(ir.dataset).toEqual({ name: "ds", version: "v1", split: "test" });
    expect(ir.graders[0]).toEqual({ name: "exact", opts: { k: 1 } });
    expect(ir.graders[1]).toEqual({ name: "contains" });
    expect(ir.seed).toBe(42);
    expect(compile(spec).files.length).toBeGreaterThan(0);
  });

  test("omits seed from the IR when the spec omits it", () => {
    const ir = lower(
      parseSpec(`
name: ev2
target: eval
agent:
  model: m
  instructions: i
dataset:
  name: ds
  version: v1
graders:
  - name: exact
`),
    );
    if (ir.target !== "eval") throw new Error("unexpected target");
    expect("seed" in ir).toBe(false);
  });
});

describe("lower/compile — onchain target (Section 47)", () => {
  // Exercises all three trigger kinds, kms:// keyRef, quorum rpcPolicy,
  // safe finality, tx policy with maxValueUsd, and the emit dispatch.
  const ONCHAIN_SPEC = `
name: oc
target: onchain
agent:
  model: m
  instructions: i
chains:
  - id: base
    kind: evm
    rpcUrls:
      - $RPC
    rpcPolicy: quorum
    finality:
      kind: safe
    reorgTolerant: false
wallets:
  - id: w
    chainId: base
    custody: kms
    signingPolicy: policy-gated
    keyRef: kms://aws/key
contracts:
  - id: c
    chainId: base
    address: "0xC"
    abiRef: abi://c
transaction_policy:
  defaultWriteApproval: policy
  maxValueUsd: 1000
  maxValueWei: "1000000000000000000"
  allowedContracts:
    - c
  simulationRequired: false
triggers:
  - kind: event
    chainId: base
    contract: c
    event: Transfer
    filter:
      from: "0x0"
  - kind: event
    chainId: base
    contract: c
    event: Approval
  - kind: block
    chainId: base
    scanIntervalMs: 30000
  - kind: address
    chainId: base
    address: "0xWATCH"
    direction: in
`;

  test("lowers chains/wallets/contracts/tx-policy and all trigger kinds, then emits", () => {
    const ir = lower(parseSpec(ONCHAIN_SPEC));
    if (ir.target !== "onchain") throw new Error("unexpected target");
    expect(ir.chains[0]?.finality).toEqual({ kind: "safe" });
    expect(ir.chains[0]?.rpcPolicy).toBe("quorum");
    expect(ir.wallets[0]?.keyRef).toEqual({ kind: "literal", value: "kms://aws/key" });
    expect(ir.transactionPolicy.maxValueUsd).toBe(1000);
    // SECURITY: the native-token spend ceiling must reach the IR (and thence
    // the emitted policy) so wallet-engine's only enforceable value cap works.
    expect(ir.transactionPolicy.maxValueWei).toBe("1000000000000000000");
    expect(ir.triggers.map((t) => t.kind)).toEqual(["event", "event", "block", "address"]);
    // event trigger with filter retains it; the second event trigger omits it.
    const firstEvent = ir.triggers[0];
    if (firstEvent?.kind !== "event") throw new Error("expected event trigger");
    expect(firstEvent).toHaveProperty("filter");
    const secondEvent = ir.triggers[1];
    if (secondEvent?.kind !== "event") throw new Error("expected event trigger");
    expect("filter" in secondEvent).toBe(false);
    expect(compile(ONCHAIN_SPEC).files.length).toBeGreaterThan(0);
  });

  test("rejects a malformed maxValueWei (not a wei amount) at parse time", () => {
    const bad = ONCHAIN_SPEC.replace('"1000000000000000000"', '"5 ETH"');
    expect(() => parseSpec(bad)).toThrow();
  });

  test("accepts a 0x-hex maxValueWei", () => {
    const hex = ONCHAIN_SPEC.replace('"1000000000000000000"', '"0xde0b6b3a7640000"');
    const ir = lower(parseSpec(hex));
    if (ir.target !== "onchain") throw new Error("unexpected target");
    expect(ir.transactionPolicy.maxValueWei).toBe("0xde0b6b3a7640000");
  });

  test("applies tx-policy + wallet defaults when the spec omits both blocks", () => {
    // No wallets, no transaction_policy → onchain branch fills the defaults.
    const ir = lower(
      parseSpec(`
name: oc2
target: onchain
agent:
  model: m
  instructions: i
chains:
  - id: base
    kind: evm
    rpcUrls:
      - $RPC
    finality:
      kind: finalized
triggers:
  - kind: block
    chainId: base
    scanIntervalMs: 60000
`),
    );
    if (ir.target !== "onchain") throw new Error("unexpected target");
    expect(ir.wallets).toEqual([]);
    expect(ir.contracts).toEqual([]);
    expect(ir.transactionPolicy).toEqual({
      defaultWriteApproval: "required",
      allowedContracts: [],
      simulationRequired: true,
    });
    expect(ir.chains[0]?.finality).toEqual({ kind: "finalized" });
  });
});

describe("lower/compile — onchain-game target (Section 47)", () => {
  const GAME_SPEC = (extra: string) => `
name: og
target: onchain-game
agent:
  model: m
  instructions: i
chain:
  id: base
  kind: evm
  rpcUrls:
    - $RPC
  finality:
    kind: confirmations
    count: 3
wallet:
  id: w
  chainId: base
  custody: local
  signingPolicy: automated
  keyRef: $WK
game:
  contract:
    id: gc
    chainId: base
    address: "0xGAME"
    abiRef: abi://game
  stateReader: readState
${extra}
tools:
  - bash
`;

  test("inlines chain/wallet/contract, lowers all optional game fields, then emits", () => {
    const ir = lower(
      parseSpec(
        GAME_SPEC(
          [
            "  actionsContract: doMove",
            "  moveTimeoutMs: 5000",
            "  objective: win the game",
            "  turnSemantics: real-time",
          ].join("\n"),
        ),
      ),
    );
    if (ir.target !== "onchain-game") throw new Error("unexpected target");
    expect(ir.chain.id).toBe("base");
    expect(ir.chain.finality).toEqual({ kind: "confirmations", count: 3 });
    expect(ir.wallet.keyRef).toEqual({ kind: "env", name: "WK" });
    expect(ir.game.contract.address).toBe("0xGAME");
    expect(ir.game).toHaveProperty("actionsContract", "doMove");
    expect(ir.game).toHaveProperty("moveTimeoutMs", 5000);
    expect(ir.game).toHaveProperty("objective", "win the game");
    expect(ir.game.turnSemantics).toBe("real-time");
    expect(compile(GAME_SPEC("  actionsContract: doMove"))).toBeDefined();
  });

  test("omits all optional game fields when the spec provides only the required ones", () => {
    const ir = lower(parseSpec(GAME_SPEC("")));
    if (ir.target !== "onchain-game") throw new Error("unexpected target");
    expect("actionsContract" in ir.game).toBe(false);
    expect("moveTimeoutMs" in ir.game).toBe(false);
    expect("objective" in ir.game).toBe(false);
    // turnSemantics has a schema default of "turn-based".
    expect(ir.game.turnSemantics).toBe("turn-based");
    // No transaction_policy block → default policy is applied.
    expect(ir.transactionPolicy).toEqual({
      defaultWriteApproval: "required",
      allowedContracts: [],
      simulationRequired: true,
    });
  });
});

describe("lower — channel secret lowering for every channel kind (Section 12)", () => {
  test("lowers telegram, discord, whatsapp and imessage secrets to env refs", () => {
    const ir = lower(
      parseSpec(`
name: ch
target: channel
agent:
  model: m
  instructions: i
channels:
  telegram:
    botToken: $TG_BOT
    secretToken: $TG_SECRET
  discord:
    applicationId: $DC_APP
    botToken: $DC_BOT
    publicKeyHex: $DC_KEY
  whatsapp:
    phoneNumberId: $WA_PHONE
    accessToken: $WA_TOKEN
    appSecret: $WA_SECRET
  imessage:
    chatDbPath: $IM_DB
    cursorPath: $IM_CURSOR
routing:
  sessionKey: user
`),
    );
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.channels.telegram?.botToken).toEqual({ kind: "env", name: "TG_BOT" });
    expect(ir.channels.telegram?.secretToken).toEqual({ kind: "env", name: "TG_SECRET" });
    expect(ir.channels.discord?.applicationId).toEqual({ kind: "env", name: "DC_APP" });
    expect(ir.channels.discord?.botToken).toEqual({ kind: "env", name: "DC_BOT" });
    expect(ir.channels.discord?.publicKeyHex).toEqual({ kind: "env", name: "DC_KEY" });
    expect(ir.channels.whatsapp?.phoneNumberId).toEqual({ kind: "env", name: "WA_PHONE" });
    expect(ir.channels.whatsapp?.accessToken).toEqual({ kind: "env", name: "WA_TOKEN" });
    expect(ir.channels.whatsapp?.appSecret).toEqual({ kind: "env", name: "WA_SECRET" });
    expect(ir.channels.imessage?.chatDbPath).toEqual({ kind: "env", name: "IM_DB" });
    expect(ir.channels.imessage?.cursorPath).toEqual({ kind: "env", name: "IM_CURSOR" });
  });

  test("lowers a Slack appToken when present (optional third secret)", () => {
    const ir = lower(
      parseSpec(`
name: ch
target: channel
agent:
  model: m
  instructions: i
channels:
  slack:
    botToken: $SLACK_BOT
    signingSecret: $SLACK_SIGN
    appToken: $SLACK_APP
routing:
  sessionKey: thread
`),
    );
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.channels.slack?.appToken).toEqual({ kind: "env", name: "SLACK_APP" });
  });

  test("rejects a credential field that looks like a malformed env ref instead of baking it as a literal", () => {
    // A value starting with `$` that is not a valid `$UPPER_SNAKE` env ref is
    // almost always a typo'd reference (lowercase, leading digit, ${...} braces)
    // — it must fail compilation rather than silently ship a broken credential.
    for (const bad of ["$slack_token", "$1PASSWORD", "${SLACK_BOT_TOKEN}"]) {
      expect(() =>
        compile(`
name: ch
target: channel
agent:
  model: m
  instructions: i
channels:
  slack:
    botToken: "${bad}"
    signingSecret: $SLACK_SIGN
routing:
  sessionKey: thread
`),
      ).toThrow(/looks like an environment reference but is not a valid one/);
    }
  });

  test("a genuine literal credential (no leading $) still lowers to a literal", () => {
    const ir = lower(
      parseSpec(`
name: ch
target: channel
agent:
  model: m
  instructions: i
channels:
  slack:
    botToken: xoxb-real-literal
    signingSecret: deadbeef
routing:
  sessionKey: thread
`),
    );
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.channels.slack?.botToken).toEqual({ kind: "literal", value: "xoxb-real-literal" });
  });

  test("imessage path fields keep permissive lowering (a $-prefixed path is a literal, not an error)", () => {
    // Path-like fields are NOT credential-shaped: a literal value such as
    // `$HOME/Library/...` is legitimate and must not trip the strict check.
    const ir = lower(
      parseSpec(`
name: ch
target: channel
agent:
  model: m
  instructions: i
channels:
  imessage:
    chatDbPath: $HOME/Library/Messages/chat.db
routing:
  sessionKey: thread
`),
    );
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.channels.imessage?.chatDbPath).toEqual({
      kind: "literal",
      value: "$HOME/Library/Messages/chat.db",
    });
  });

  test("omits empty imessage config (no chatDbPath/cursorPath) — both optional", () => {
    const ir = lower(
      parseSpec(`
name: ch
target: channel
agent:
  model: m
  instructions: i
channels:
  imessage: {}
routing:
  sessionKey: thread
`),
    );
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.channels.imessage).toEqual({});
  });
});

describe("lower — sub-agents normalisation (Section 13)", () => {
  test("sorts sub-agents by name and applies inherit/inherit_bypass/tools defaults", () => {
    const ir = lower(
      parseSpec(`
name: cl
target: cli
agent:
  model: m
  instructions: i
  sub_agents:
    zeta:
      description: z
      instructions: zi
    alpha:
      description: a
      instructions: ai
      tools:
        - bash
      model: alpha-model
      permissions: scoped
      inherit_bypass: true
`),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    // Sorted by name: alpha < zeta.
    expect(ir.subAgents.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    const alpha = ir.subAgents[0];
    expect(alpha?.tools).toEqual(["bash"]);
    expect(alpha?.model).toBe("alpha-model");
    expect(alpha?.permissions).toBe("scoped");
    expect(alpha?.inheritBypass).toBe(true);
    // zeta uses the lower-time defaults.
    const zeta = ir.subAgents[1];
    expect(zeta?.tools).toEqual([]);
    expect(zeta?.permissions).toBe("inherit");
    expect(zeta?.inheritBypass).toBe(false);
    expect("model" in (zeta ?? {})).toBe(false);
  });
});

describe("lower — tool_config + failure_taxonomy normalisation", () => {
  test("freezes a non-empty tool_config map onto the IR", () => {
    const ir = lower(
      parseSpec(`
name: cl
target: cli
agent:
  model: m
  instructions: i
tools:
  - bash
tool_config:
  bash:
    timeout: 2500
`),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.toolConfigs).toEqual({ bash: { timeout: 2500 } });
    expect(Object.isFrozen(ir.toolConfigs)).toBe(true);
  });

  test("lowers failure_taxonomy entries, preserving order and per-entry hint presence", () => {
    const ir = lower(
      parseSpec(`
name: cl
target: cli
agent:
  model: m
  instructions: i
failure_taxonomy:
  - class: net
    pattern: ETIMEDOUT
    recovery: retry
    hint: back off and retry
  - class: fatal
    pattern: SIGKILL
    recovery: fail
`),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.failureTaxonomy).toEqual([
      { class: "net", pattern: "ETIMEDOUT", recovery: "retry", hint: "back off and retry" },
      { class: "fatal", pattern: "SIGKILL", recovery: "fail" },
    ]);
  });

  test("omits failureTaxonomy from the IR for an empty failure_taxonomy list", () => {
    // An explicit empty array lowers the same as an omitted block.
    const ir = lower(
      parseSpec(`
name: cl
target: cli
agent:
  model: m
  instructions: i
failure_taxonomy: []
`),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect("failureTaxonomy" in ir).toBe(false);
  });
});

describe("lower — heartbeat duration parsing (Phase 3 §3.1)", () => {
  // The channel heartbeat is the only call site of parseDurationToMs. Each unit
  // is exercised through a parsed, valid channel spec so the lowering is real.
  const channelWith = (every: string): Spec =>
    parseSpec(`
name: ch
target: channel
agent:
  model: m
  instructions: i
channels:
  slack:
    botToken: x
    signingSecret: y
routing:
  sessionKey: thread
heartbeat:
  every: ${every}
  instructions: tick
gateway:
  port: 9090
  ui: false
`);

  test.each([
    ["500ms", 500],
    ["45s", 45_000],
    ["30m", 1_800_000],
    ["2h", 7_200_000],
  ])("parses %s heartbeat to %d ms and threads gateway config", (every, expectedMs) => {
    const ir = lower(channelWith(every));
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.heartbeat?.everyMs).toBe(expectedMs);
    expect(ir.heartbeat?.instructions).toBe("tick");
    expect(ir.gateway).toEqual({ port: 9090, ui: false });
  });
});

describe("lower — defensive guards reached via the exported lower() entry point", () => {
  // lower() is a public, exported entry point with documented preconditions
  // (callers that drive it directly rather than through compile()/parseSpec).
  // These tests feed it Spec-typed objects that the static type permits but
  // parseSpec's runtime validation would reject, to cover the guards that
  // exist precisely for that direct-call surface.

  test("onchain with an empty chains[] throws (guard at the onchain branch)", () => {
    const badOnchain = {
      version: 0,
      name: "oc",
      target: "onchain",
      agent: { model: "m", instructions: "i" },
      chains: [],
      wallets: [],
      contracts: [],
      transaction_policy: {
        defaultWriteApproval: "required",
        allowedContracts: [],
        simulationRequired: true,
      },
      triggers: [{ kind: "block", chainId: "base", scanIntervalMs: 30000 }],
      idempotencyWindowMs: 60000,
    } as unknown as Spec;
    expect(() => lower(badOnchain)).toThrow(/onchain target requires chains\[\] to be non-empty/);
  });

  test("a channel heartbeat duration that escaped spec validation throws", () => {
    const badChannel = {
      name: "ch",
      target: "channel",
      agent: { model: "m", instructions: "i" },
      channels: { slack: { botToken: "x", signingSecret: "y" } },
      routing: { sessionKey: "thread" },
      heartbeat: { every: "bogus", instructions: "i" },
    } as unknown as Spec;
    expect(() => lower(badChannel)).toThrow(/invalid duration "bogus"/);
  });

  test("an unknown target throws the assertNever exhaustiveness guard in lower()", () => {
    const unknownTarget = { name: "x", target: "does-not-exist" } as unknown as Spec;
    expect(() => lower(unknownTarget)).toThrow(/unreachable/);
  });
});

describe("assertChainGameLowered (exported onchain-game lowering guard)", () => {
  const CHAIN = {
    id: "base",
    kind: "evm",
    rpcUrls: [{ kind: "env", name: "RPC" }],
    rpcPolicy: "single",
    finality: { kind: "finalized" },
    reorgTolerant: false,
  } as const;
  const WALLET = {
    id: "w",
    chainId: "base",
    custody: "local",
    signingPolicy: "automated",
  } as const;
  const CONTRACT = { id: "gc", chainId: "base", address: "0xGAME", abiRef: "abi://game" } as const;

  test("returns the non-optional triple when all three lowered values are present", () => {
    const out = assertChainGameLowered(CHAIN, WALLET, CONTRACT);
    expect(out).toEqual({ chain: CHAIN, wallet: WALLET, contract: CONTRACT });
    // Identity preserved — no copies are made.
    expect(out.chain).toBe(CHAIN);
    expect(out.wallet).toBe(WALLET);
    expect(out.contract).toBe(CONTRACT);
  });

  test.each([
    ["chain", undefined, WALLET, CONTRACT],
    ["wallet", CHAIN, undefined, CONTRACT],
    ["contract", CHAIN, WALLET, undefined],
  ] as const)("throws when the lowered %s is undefined", (_label, chain, wallet, contract) => {
    expect(() => assertChainGameLowered(chain, wallet, contract)).toThrow(
      /onchain-game lowering failed to produce chain\/wallet\/contract/,
    );
  });
});

describe("type re-exports are reachable from the package entry", () => {
  test("IrNode type round-trips a lowered value (compile-time + runtime smoke)", () => {
    const ir: IrNode = lower(parseSpec(MINIMAL_SPEC));
    expect(ir.target).toBe("cli");
  });
});
