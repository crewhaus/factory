import { describe, expect, test } from "bun:test";
import { SPEC_HOOK_EVENTS, Spec, SpecParseError, parseSpec } from "./index";

describe("parseSpec", () => {
  test("parses a minimal valid CLI spec", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
`);
    expect(spec.name).toBe("hello");
    expect(spec.target).toBe("cli");
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.model).toBe("claude-sonnet-4-6");
    expect(spec.agent.instructions).toBe("be helpful");
  });

  // Codegen-injection backstop (#147/#148): names flow verbatim into generated
  // comments, file paths, JSON manifests and frontmatter — reject the breakout
  // characters at parse time so no emitter can be tricked downstream.
  describe("name safe-charset backstop", () => {
    const cli = (name: string) =>
      `\ntarget: cli\nagent:\n  model: m\n  instructions: be helpful\nname: ${name}\n`;
    test.each([
      ["a newline (block/line-comment escape)", '"line one\\nglobalThis.x=1"'],
      ["a block-comment terminator */", '"safe */ code /* x"'],
      ["a slash (path traversal in plugin emitters)", '"../../etc/evil"'],
      ["a double-quote (JSON manifest break-out)", '"a\\", \\"dependencies\\": {}"'],
      ["a backtick (template-literal escape)", '"a`+code+`b"'],
    ])("rejects a name containing %s", (_label, name) => {
      expect(() => parseSpec(cli(name))).toThrow(SpecParseError);
    });

    test("accepts ordinary names (letters, digits, space, . _ - :)", () => {
      const spec = parseSpec(cli('"My Agent v1.2 - prod:eu"'));
      expect(spec.name).toBe("My Agent v1.2 - prod:eu");
    });
  });

  test("preserves multi-line block-scalar instructions", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: |
    line one.
    line two.
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.instructions).toBe("line one.\nline two.\n");
  });

  test("rejects spec with missing required fields", () => {
    expect(() => parseSpec("name: hello")).toThrow(SpecParseError);
  });

  test("rejects spec with unknown top-level fields (strict mode)", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
extra: nope
`),
    ).toThrow(SpecParseError);
  });

  test("rejects an unsupported target", () => {
    expect(() =>
      parseSpec(`
name: hello
target: voice
agent:
  model: m
  instructions: i
`),
    ).toThrow(SpecParseError);
  });

  test("rejects malformed YAML", () => {
    expect(() => parseSpec("{[\nname: oops")).toThrow(SpecParseError);
  });

  test("error message points at the failing path", () => {
    try {
      parseSpec(`
name: hello
target: cli
agent:
  model: ""
  instructions: ok
`);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SpecParseError);
      expect((err as Error).message).toContain("agent.model");
    }
  });
});

describe("parseSpec tools field", () => {
  test("parses a CLI spec with a tools array", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - read
  - write
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.tools).toEqual(["read", "write"]);
  });

  test("tools field is optional (omitted means undefined)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.tools).toBeUndefined();
  });

  test("rejects non-string tool entries", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - 123
`),
    ).toThrow(SpecParseError);
  });

  test("rejects empty-string tool names", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - ""
`),
    ).toThrow(SpecParseError);
  });
});

// SECURITY: the code-execution config blob is compiled verbatim into
// `registerCodeExecutionConfig(...)` and the sandbox boundary validates
// images/mounts against THIS same blob — so a spec must NOT be able to
// supply its own sandbox allowlist/backend/mounts. Those keys are owned by
// trusted operator config (CLI / CREWHAUS_SANDBOX* env), never a spec file.
// The blob can arrive under codeExecution/code_execution OR the per-tool
// keys python/javascript/shell (target-cli reads the per-tool key first),
// so every one of those must be rejected.
describe("tool_config code-execution sandbox-override hardening", () => {
  const codeExecKeys = [
    "codeExecution",
    "code_execution",
    "python",
    "javascript",
    "shell",
  ] as const;
  const overrideKeys = [
    ["backend", "backend: noop"],
    ["allowedImages", "allowedImages:\n      - evil/image:latest"],
    ["allowed_images", "allowed_images:\n      - evil/image:latest"],
    ["mountWhitelist", 'mountWhitelist:\n      - "/"'],
    ["mount_whitelist", 'mount_whitelist:\n      - "/"'],
    ["images", "images:\n      python: evil/image:latest"],
    ["mounts", "mounts:\n      /etc: /host-etc"],
    ["sandbox", "sandbox: noop"],
  ] as const;

  const specWith = (cfgKey: string, body: string) =>
    `\nname: hello\ntarget: cli\nagent:\n  model: m\n  instructions: i\ntools:\n  - python\ntool_config:\n  ${cfgKey}:\n    ${body}\n`;

  for (const cfgKey of codeExecKeys) {
    for (const [label, body] of overrideKeys) {
      test(`rejects sandbox-override key "${label}" under tool_config.${cfgKey}`, () => {
        expect(() => parseSpec(specWith(cfgKey, body))).toThrow(SpecParseError);
      });
    }

    test(`allows non-security knobs under tool_config.${cfgKey}`, () => {
      const spec = parseSpec(specWith(cfgKey, "defaultTimeoutMs: 5000\n    warmPoolSize: 2"));
      if (spec.target !== "cli") expect.unreachable();
      expect(spec.tool_config?.[cfgKey]).toEqual({
        defaultTimeoutMs: 5000,
        warmPoolSize: 2,
      });
    });
  }

  test("does not constrain non-code-execution tool configs (fetch stays opaque)", () => {
    const spec = parseSpec(
      "\nname: hello\ntarget: cli\nagent:\n  model: m\n  instructions: i\ntools:\n  - fetch\ntool_config:\n  fetch:\n    allowedImages:\n      - anything\n    backend: whatever\n",
    );
    if (spec.target !== "cli") expect.unreachable();
    // `fetch` is not a code-execution tool, so its config is forwarded
    // verbatim — these keys are meaningless there and harmless.
    expect(spec.tool_config?.["fetch"]).toEqual({
      allowedImages: ["anything"],
      backend: "whatever",
    });
  });
});

describe("Spec schema", () => {
  test("schema is exported as a runtime value (Zod)", () => {
    expect(typeof Spec.safeParse).toBe("function");
  });
});

describe("parseSpec workflow target", () => {
  test("parses a minimal valid workflow spec", () => {
    const spec = parseSpec(`
name: hello-workflow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: only-step
    instructions: do the thing
`);
    expect(spec.target).toBe("workflow");
    if (spec.target !== "workflow") expect.unreachable();
    expect(spec.name).toBe("hello-workflow");
    expect(spec.model).toBe("claude-sonnet-4-6");
    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0]?.name).toBe("only-step");
    expect(spec.steps[0]?.instructions).toBe("do the thing");
    expect(spec.steps[0]?.model).toBeUndefined();
    expect(spec.steps[0]?.tools).toBeUndefined();
  });

  test("parses a workflow spec with multiple steps and per-step tools", () => {
    const spec = parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
    tools:
      - bash
  - name: b
    instructions: bi
`);
    if (spec.target !== "workflow") expect.unreachable();
    expect(spec.steps).toHaveLength(2);
    expect(spec.steps[0]?.tools).toEqual(["bash"]);
    expect(spec.steps[1]?.tools).toBeUndefined();
  });

  test("parses a workflow spec with per-step model override", () => {
    const spec = parseSpec(`
name: w
target: workflow
model: default-model
steps:
  - name: a
    instructions: ai
    model: override-model
  - name: b
    instructions: bi
`);
    if (spec.target !== "workflow") expect.unreachable();
    expect(spec.steps[0]?.model).toBe("override-model");
    expect(spec.steps[1]?.model).toBeUndefined();
  });

  test("rejects a workflow spec with no steps", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
steps: []
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow step with empty instructions", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ""
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow step with empty name", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: ""
    instructions: ai
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow spec missing top-level model", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
steps:
  - name: a
    instructions: ai
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow spec with extra top-level field (strict)", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
extra: nope
steps:
  - name: a
    instructions: ai
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow step with unknown field (strict)", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
    bogus: 1
`),
    ).toThrow(SpecParseError);
  });

  describe("permissions block", () => {
    test("accepts a cli spec with permissions: mode + rules", () => {
      const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
permissions:
  mode: auto
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysDeny
      pattern: Bash(rm**)
`);
      expect(spec.target).toBe("cli");
      if (spec.target !== "cli") return;
      expect(spec.permissions?.mode).toBe("auto");
      expect(spec.permissions?.rules).toHaveLength(2);
    });

    test("accepts a workflow spec with permissions block", () => {
      const spec = parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
permissions:
  mode: plan
`);
      expect(spec.target).toBe("workflow");
      if (spec.target !== "workflow") return;
      expect(spec.permissions?.mode).toBe("plan");
    });

    test("rejects mode: bypass in cli spec with a friendly security message", () => {
      expect(() =>
        parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
permissions:
  mode: bypass
`),
      ).toThrow(SpecParseError);
      expect(() =>
        parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
permissions:
  mode: bypass
`),
      ).toThrow(/bypass mode is only available via the --permission-mode CLI flag/);
    });

    test("rejects mode: bypass in workflow spec", () => {
      expect(() =>
        parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
permissions:
  mode: bypass
`),
      ).toThrow(SpecParseError);
    });

    test("rejects unknown rule type", () => {
      expect(() =>
        parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
permissions:
  rules:
    - type: neverAllow
      pattern: Read
`),
      ).toThrow(SpecParseError);
    });
  });
});

describe("parseSpec channel target (Section 12)", () => {
  test("parses a minimal valid channel spec", () => {
    const spec = parseSpec(`
name: hello-channel
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be a good bot
channels:
  slack:
    botToken: xoxb-test
    signingSecret: shh
routing:
  sessionKey: thread
`);
    expect(spec.target).toBe("channel");
    if (spec.target !== "channel") expect.unreachable();
    expect(spec.agent.model).toBe("claude-sonnet-4-6");
    expect(spec.channels.slack?.botToken).toBe("xoxb-test");
    expect(spec.routing.sessionKey).toBe("thread");
    expect(spec.agent.tools).toBeUndefined();
  });

  test("parses a channel spec with agent.tools and permissions", () => {
    const spec = parseSpec(`
name: hello-channel
target: channel
agent:
  model: m
  instructions: i
  tools:
    - read
    - bash
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
    appToken: $SLACK_APP_TOKEN
routing:
  sessionKey: user
permissions:
  rules:
    - type: alwaysAllow
      pattern: Read
`);
    if (spec.target !== "channel") expect.unreachable();
    expect(spec.agent.tools).toEqual(["read", "bash"]);
    expect(spec.channels.slack?.appToken).toBe("$SLACK_APP_TOKEN");
    expect(spec.routing.sessionKey).toBe("user");
    expect(spec.permissions?.rules).toHaveLength(1);
  });

  test("rejects a channel spec missing the channels block", () => {
    expect(() =>
      parseSpec(`
name: hello-channel
target: channel
agent:
  model: m
  instructions: i
routing:
  sessionKey: thread
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a channel spec with empty channels block (no slack)", () => {
    expect(() =>
      parseSpec(`
name: hello-channel
target: channel
agent:
  model: m
  instructions: i
channels: {}
routing:
  sessionKey: thread
`),
    ).toThrow(/at least one channel/);
  });

  test("rejects a channel spec missing routing", () => {
    expect(() =>
      parseSpec(`
name: hello-channel
target: channel
agent:
  model: m
  instructions: i
channels:
  slack:
    botToken: x
    signingSecret: y
`),
    ).toThrow(SpecParseError);
  });

  test("rejects an invalid sessionKey", () => {
    expect(() =>
      parseSpec(`
name: hello-channel
target: channel
agent:
  model: m
  instructions: i
channels:
  slack:
    botToken: x
    signingSecret: y
routing:
  sessionKey: workspace
`),
    ).toThrow(SpecParseError);
  });

  test("rejects an unknown channel adapter (strict)", () => {
    expect(() =>
      parseSpec(`
name: hello-channel
target: channel
agent:
  model: m
  instructions: i
channels:
  telegram:
    botToken: x
routing:
  sessionKey: thread
`),
    ).toThrow(SpecParseError);
  });

  test("rejects mode: bypass in channel spec", () => {
    expect(() =>
      parseSpec(`
name: hello-channel
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
permissions:
  mode: bypass
`),
    ).toThrow(SpecParseError);
  });
});

describe("parseSpec mcp_servers block (Section 9)", () => {
  test("parses a CLI spec with a stdio MCP server", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
mcp_servers:
  fs:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    env:
      DEBUG: "1"
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.mcp_servers).toBeDefined();
    const fs = spec.mcp_servers?.["fs"];
    expect(fs?.transport).toBe("stdio");
    if (fs?.transport !== "stdio") expect.unreachable();
    expect(fs.command).toBe("npx");
    expect(fs.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(fs.env).toEqual({ DEBUG: "1" });
  });

  test("parses a CLI spec with an SSE MCP server", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
mcp_servers:
  remote:
    transport: sse
    url: https://example.com/sse
    headers:
      Authorization: "Bearer x"
`);
    if (spec.target !== "cli") expect.unreachable();
    const remote = spec.mcp_servers?.["remote"];
    expect(remote?.transport).toBe("sse");
    if (remote?.transport !== "sse") expect.unreachable();
    expect(remote.url).toBe("https://example.com/sse");
    expect(remote.headers).toEqual({ Authorization: "Bearer x" });
  });

  test("parses a workflow spec with mcp_servers", () => {
    const spec = parseSpec(`
name: w
target: workflow
model: m
mcp_servers:
  fs:
    transport: stdio
    command: foo
steps:
  - name: a
    instructions: ai
`);
    if (spec.target !== "workflow") expect.unreachable();
    expect(spec.mcp_servers?.["fs"]).toBeDefined();
  });

  test("mcp_servers field is optional", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.mcp_servers).toBeUndefined();
  });

  test("rejects an MCP config missing the discriminator", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
mcp_servers:
  fs:
    command: npx
`),
    ).toThrow(SpecParseError);
  });

  test("rejects an unknown transport value", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
mcp_servers:
  fs:
    transport: ftp
    command: x
`),
    ).toThrow(SpecParseError);
  });

  test("rejects an stdio config with stray sse fields (strict mode)", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
mcp_servers:
  fs:
    transport: stdio
    command: x
    url: https://nope
`),
    ).toThrow(SpecParseError);
  });

  test("rejects an SSE config with non-URL url", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
mcp_servers:
  fs:
    transport: sse
    url: not-a-url
`),
    ).toThrow(SpecParseError);
  });
});

describe("parseSpec — CLI banner (Phase 3 §3.3)", () => {
  test("accepts a banner block with taglineMode and taglines", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
cli:
  banner:
    taglineMode: random
    taglines:
      - "🦞 first"
      - "🦞 second"
`);
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.cli?.banner?.taglineMode).toBe("random");
    expect(spec.cli?.banner?.taglines).toEqual(["🦞 first", "🦞 second"]);
  });

  test("defaults taglineMode to 'static' when omitted", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
cli:
  banner:
    taglines: ["only one"]
`);
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.cli?.banner?.taglineMode).toBe("static");
  });

  test("rejects empty taglines array", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
cli:
  banner:
    taglines: []
`),
    ).toThrow(SpecParseError);
  });

  test("rejects invalid taglineMode", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
cli:
  banner:
    taglineMode: invalid
    taglines: ["t"]
`),
    ).toThrow(SpecParseError);
  });
});

describe("parseSpec — gateway (Phase 3 §3.4)", () => {
  test("accepts a gateway block with port + ui", () => {
    const spec = parseSpec(`
name: hello
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
gateway:
  port: 19001
  ui: true
`);
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.gateway?.port).toBe(19001);
    expect(spec.gateway?.ui).toBe(true);
  });

  test("ui defaults to false when omitted", () => {
    const spec = parseSpec(`
name: hello
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
gateway:
  port: 8080
`);
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.gateway?.ui).toBe(false);
  });

  test("rejects invalid port (out of range)", () => {
    expect(() =>
      parseSpec(`
name: hello
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
gateway:
  port: 99999
`),
    ).toThrow(SpecParseError);
  });

  test("gateway is optional", () => {
    const spec = parseSpec(`
name: hello
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
`);
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.gateway).toBeUndefined();
  });
});

describe("parseSpec — heartbeat (Phase 3 §3.1)", () => {
  test("accepts a heartbeat block with duration and instructions", () => {
    const spec = parseSpec(`
name: hello
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
heartbeat:
  every: 2h
  instructions: wake and decide
`);
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.heartbeat?.every).toBe("2h");
    expect(spec.heartbeat?.instructions).toBe("wake and decide");
  });

  test.each(["2h", "30m", "60s", "500ms"])("accepts duration string %s", (every: string) => {
    const spec = parseSpec(`
name: hello
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
heartbeat:
  every: ${every}
  instructions: tick
`);
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.heartbeat?.every).toBe(every);
  });

  test("rejects invalid duration format", () => {
    expect(() =>
      parseSpec(`
name: hello
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
heartbeat:
  every: "2 hours"
  instructions: tick
`),
    ).toThrow(SpecParseError);
  });

  test("heartbeat is optional", () => {
    const spec = parseSpec(`
name: hello
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
`);
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.heartbeat).toBeUndefined();
  });
});

describe("parseSpec — compaction block (Section 17 + Pillar 2 curator)", () => {
  test("accepts the curator opt-in + tuning knobs", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
compaction:
  model: claude-haiku-4
  curate: true
  dedupeThreshold: 0.88
  relevanceTopK: 5
`);
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.compaction).toEqual({
      model: "claude-haiku-4",
      curate: true,
      dedupeThreshold: 0.88,
      relevanceTopK: 5,
    });
  });

  test("each curator field is independently optional", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
compaction:
  curate: true
`);
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.compaction).toEqual({ curate: true });
  });

  test("rejects dedupeThreshold > 1 (cosine outputs cap at 1)", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
compaction:
  dedupeThreshold: 1.5
`),
    ).toThrow(SpecParseError);
  });

  test("rejects dedupeThreshold <= 0", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
compaction:
  dedupeThreshold: 0
`),
    ).toThrow(SpecParseError);
  });

  test("rejects non-integer relevanceTopK", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
compaction:
  relevanceTopK: 3.5
`),
    ).toThrow(SpecParseError);
  });

  test("rejects relevanceTopK <= 0", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
compaction:
  relevanceTopK: 0
`),
    ).toThrow(SpecParseError);
  });

  test("rejects unknown keys inside the compaction block (strict)", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
compaction:
  enableMagic: true
`),
    ).toThrow(SpecParseError);
  });
});

// FR-004 — Pillar 3 security block (intent-gate judge selection).
describe("parseSpec security.justification", () => {
  test("parses a cli spec with security.justification.judge=claude + model", () => {
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
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.security?.justification?.judge).toBe("claude");
    expect(spec.security?.justification?.model).toBe("claude-haiku-4-5");
  });

  test("judge defaults to rule-based when the justification block omits it", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  justification: {}
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.security?.justification?.judge).toBe("rule-based");
  });

  test("rejects an unknown judge enum value", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  justification:
    judge: gpt-omniscient
`),
    ).toThrow(SpecParseError);
  });

  test("rejects unknown keys inside the security block (strict)", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  enableTelepathy: true
`),
    ).toThrow(SpecParseError);
  });

  test("security block is optional — a spec without it still parses", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.security).toBeUndefined();
  });
});

// Item 1 — the response-feedback block's teardown consumers: autoDistill
// (versioned ratings datasets at CLI run teardown) and exitPrompt (the REPL
// exit rating prompt gate — additive optional field).
describe("parseSpec feedback block (autoDistill + exitPrompt)", () => {
  test("parses autoDistill and exitPrompt as plain booleans", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
feedback:
  autoDistill: true
  exitPrompt: false
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.feedback?.autoDistill).toBe(true);
    expect(spec.feedback?.exitPrompt).toBe(false);
  });

  test("both are optional — a bare feedback block parses (modality defaults)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
feedback: {}
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.feedback?.modality).toBe("binary");
    expect(spec.feedback?.autoDistill).toBeUndefined();
    expect(spec.feedback?.exitPrompt).toBeUndefined();
  });

  test("rejects a typo'd sub-key (strict)", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
feedback:
  exitPromt: false
`),
    ).toThrow(SpecParseError);
  });
});

// FR-006 — Pillar 3 sink-side fabric (egress matcher selector).
describe("parseSpec security.egressMatcher", () => {
  test("parses a cli spec with security.egressMatcher: semantic", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  egressMatcher: semantic
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.security?.egressMatcher).toBe("semantic");
  });

  test("parses security.egressMatcher: substring (the explicit default)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  egressMatcher: substring
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.security?.egressMatcher).toBe("substring");
  });

  test("rejects an unknown egressMatcher enum value (strict)", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  egressMatcher: telepathic
`),
    ).toThrow(SpecParseError);
  });

  test("egressMatcher coexists with justification in the same security block", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  justification:
    judge: claude
  egressMatcher: semantic
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.security?.justification?.judge).toBe("claude");
    expect(spec.security?.egressMatcher).toBe("semantic");
  });

  test("egressMatcher is optional — a security block without it still parses", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
security:
  justification: {}
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.security?.egressMatcher).toBeUndefined();
  });
});

describe("parseSpec pipeline target — vector backend (Section 21)", () => {
  const PIPELINE = (retrieve: string) => `
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

  test("defaults vectorBackend to in-memory when omitted", () => {
    const spec = parseSpec(PIPELINE("  embedderModel: mock/det"));
    if (spec.target !== "pipeline") expect.unreachable();
    expect(spec.retrieve.vectorBackend).toBe("in-memory");
  });

  test("accepts the file backend (lance) with no extra config", () => {
    const spec = parseSpec(PIPELINE("  embedderModel: mock/det\n  vectorBackend: lance"));
    if (spec.target !== "pipeline") expect.unreachable();
    expect(spec.retrieve.vectorBackend).toBe("lance");
  });

  test("accepts an http backend with url + collection + apiKey", () => {
    const spec = parseSpec(
      PIPELINE(
        [
          "  embedderModel: mock/det",
          "  vectorBackend: qdrant",
          "  url: https://qdrant.example",
          "  collection: docs",
          "  apiKey: $QDRANT_API_KEY",
        ].join("\n"),
      ),
    );
    if (spec.target !== "pipeline") expect.unreachable();
    expect(spec.retrieve.vectorBackend).toBe("qdrant");
    expect(spec.retrieve.url).toBe("https://qdrant.example");
    expect(spec.retrieve.collection).toBe("docs");
    expect(spec.retrieve.apiKey).toBe("$QDRANT_API_KEY");
  });

  test("rejects an unknown backend id", () => {
    expect(() => parseSpec(PIPELINE("  embedderModel: mock/det\n  vectorBackend: faiss"))).toThrow(
      SpecParseError,
    );
  });

  test("rejects an http backend missing url", () => {
    expect(() =>
      parseSpec(PIPELINE("  embedderModel: mock/det\n  vectorBackend: qdrant\n  collection: docs")),
    ).toThrow(/requires retrieve\.url/);
  });

  test("rejects an http backend missing collection", () => {
    expect(() =>
      parseSpec(
        PIPELINE(
          "  embedderModel: mock/det\n  vectorBackend: pinecone\n  url: https://pinecone.example",
        ),
      ),
    ).toThrow(/requires retrieve\.collection/);
  });
});

describe("parseSpec crew target cross-field invariants (Section 22)", () => {
  // Two-role crew with a configurable `entry:` line and an optional trailing
  // routing block, so each post-parse invariant is exercised through a real
  // Zod-valid spec (the cross-field checks run only after safeParse succeeds).
  const CREW = (entry: string, routing = "") => `
name: team
target: crew
model: m
entry: ${entry}
roles:
  lead:
    instructions: coordinate the crew
  worker:
    instructions: do the work
${routing}`;

  test("parses a valid crew with match routing and threads roles/entry/routing", () => {
    const spec = parseSpec(
      CREW(
        "lead",
        [
          "routing:",
          "  kind: match",
          "  match:",
          "    lead:",
          "      - contains: help",
          "        to: worker",
        ].join("\n"),
      ),
    );
    if (spec.target !== "crew") expect.unreachable();
    expect(Object.keys(spec.roles)).toEqual(["lead", "worker"]);
    expect(spec.entry).toBe("lead");
    expect(spec.routing).toEqual({
      kind: "match",
      match: { lead: [{ contains: "help", to: "worker" }] },
    });
  });

  test("accepts llm routing (no match block) — the match-validation loop is skipped", () => {
    const spec = parseSpec(CREW("lead", ["routing:", "  kind: llm"].join("\n")));
    if (spec.target !== "crew") expect.unreachable();
    expect(spec.routing).toEqual({ kind: "llm" });
  });

  test("accepts a crew with no routing block at all", () => {
    const spec = parseSpec(CREW("worker"));
    if (spec.target !== "crew") expect.unreachable();
    expect(spec.routing).toBeUndefined();
    expect(spec.entry).toBe("worker");
  });

  test("rejects a crew whose roles record is empty", () => {
    expect(() => parseSpec("name: t\ntarget: crew\nmodel: m\nentry: lead\nroles: {}\n")).toThrow(
      /crew target requires at least one role/,
    );
  });

  test("rejects a crew whose entry does not name a declared role", () => {
    expect(() => parseSpec(CREW("ghost"))).toThrow(
      /crew\.entry "ghost" must name one of crew\.roles \(got: lead, worker\)/,
    );
  });

  test("rejects routing whose match source role is not a declared role", () => {
    expect(() =>
      parseSpec(
        CREW(
          "lead",
          [
            "routing:",
            "  kind: match",
            "  match:",
            "    ghost:",
            "      - contains: x",
            "        to: worker",
          ].join("\n"),
        ),
      ),
    ).toThrow(/crew\.routing\.match\["ghost"\]: source role not in crew\.roles/);
  });

  test("rejects routing whose match target role is not a declared role", () => {
    expect(() =>
      parseSpec(
        CREW(
          "lead",
          [
            "routing:",
            "  kind: match",
            "  match:",
            "    lead:",
            "      - contains: x",
            "        to: ghost",
          ].join("\n"),
        ),
      ),
    ).toThrow(/crew\.routing\.match\["lead"\]\.to = "ghost" — target role not in crew\.roles/);
  });
});

// Section 28 (#43) — the OPTIONAL `version:` field. The riskiest change of the
// batch: it touches the strict discriminated union. These tests are the
// back-compat proof — old (unversioned) specs AND version-stamped specs both
// parse, across every target member of the union.
describe("parseSpec version field (#43 spec version stamping)", () => {
  const CLI_NO_VERSION =
    "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";

  test("BACK-COMPAT: an old spec with NO version field still parses (version undefined)", () => {
    const spec = parseSpec(CLI_NO_VERSION) as { version?: number };
    expect(spec.version).toBeUndefined();
  });

  test("a version-stamped spec (what a migration writes) parses and carries the version", () => {
    const spec = parseSpec(
      "name: t\ntarget: cli\nversion: 1\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n",
    ) as { version?: number };
    expect(spec.version).toBe(1);
  });

  test("version: 0 (the unversioned baseline made explicit) parses", () => {
    const spec = parseSpec(
      "name: t\ntarget: cli\nversion: 0\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n",
    ) as { version?: number };
    expect(spec.version).toBe(0);
  });

  test("a negative version is rejected (non-negative int)", () => {
    expect(() =>
      parseSpec("name: t\ntarget: cli\nversion: -1\nagent:\n  model: m\n  instructions: hi\n"),
    ).toThrow(SpecParseError);
  });

  test("a non-integer version is rejected", () => {
    expect(() =>
      parseSpec("name: t\ntarget: cli\nversion: 1.5\nagent:\n  model: m\n  instructions: hi\n"),
    ).toThrow(SpecParseError);
  });

  test("the version field is accepted on EVERY target member of the strict union", () => {
    // A representative minimal spec per target, each stamped version: 1. If the
    // field were missing from any union member, that member's `.strict()` would
    // reject the stamp — so this asserts the additive change reached all 14.
    const specs: Record<string, string> = {
      cli: "name: t\ntarget: cli\nversion: 1\nagent:\n  model: m\n  instructions: hi\n",
      workflow:
        "name: t\ntarget: workflow\nversion: 1\nmodel: m\nsteps:\n  - name: s\n    instructions: go\n",
      channel:
        "name: t\ntarget: channel\nversion: 1\nagent:\n  model: m\n  instructions: hi\nchannels:\n  slack:\n    botToken: xoxb-test\n    signingSecret: shh\nrouting:\n  sessionKey: thread\n",
      graph:
        "name: t\ntarget: graph\nversion: 1\nmodel: m\nentry: a\nnodes:\n  a:\n    instructions: go\nedges: []\n",
      managed:
        "name: t\ntarget: managed\nversion: 1\nagent:\n  model: m\n  instructions: hi\ntenants:\n  - id: t1\n    budget:\n      maxInputTokens: 100\n      maxOutputTokens: 100\n",
      pipeline:
        "name: t\ntarget: pipeline\nversion: 1\nagent:\n  model: m\n  instructions: hi\nretrieve:\n  embedderModel: mock/det\nindexing:\n  documents:\n    - id: doc-1\n      text: hi\n",
      crew: "name: t\ntarget: crew\nversion: 1\nmodel: m\nentry: lead\nroles:\n  lead:\n    instructions: go\n",
      research:
        "name: t\ntarget: research\nversion: 1\nagent:\n  model: m\n  instructions: hi\ngoal: find things\n",
      batch:
        "name: t\ntarget: batch\nversion: 1\nagent:\n  model: m\n  instructions: hi\nqueue:\n  adapter: in-memory\n",
      voice:
        "name: t\ntarget: voice\nversion: 1\nagent:\n  model: m\n  instructions: hi\nvoice:\n  provider: openai\n",
      browser: "name: t\ntarget: browser\nversion: 1\nagent:\n  model: m\n  instructions: hi\n",
      eval: "name: t\ntarget: eval\nversion: 1\nagent:\n  model: m\n  instructions: hi\ndataset:\n  name: d\n  version: v1\ngraders:\n  - name: g\n",
      onchain:
        "name: t\ntarget: onchain\nversion: 1\nagent:\n  model: m\n  instructions: hi\nchains:\n  - id: base\n    kind: evm\n    rpcUrls:\n      - https://rpc.example\n    finality:\n      kind: confirmations\n      count: 12\ncontracts:\n  - id: treasury\n    chainId: base\n    address: '0xtreasury'\n    abiRef: abi://safe\ntriggers:\n  - kind: event\n    chainId: base\n    contract: treasury\n    event: Transfer\n",
      "onchain-game":
        "name: t\ntarget: onchain-game\nversion: 1\nagent:\n  model: m\n  instructions: hi\nchain:\n  id: base\n  kind: evm\n  rpcUrls:\n    - https://rpc.example\n  finality:\n    kind: confirmations\n    count: 1\nwallet:\n  id: player\n  chainId: base\n  custody: local\ngame:\n  contract:\n    id: game\n    chainId: base\n    address: '0xgame'\n    abiRef: abi://game\n  stateReader: readState\n",
    };
    expect(Object.keys(specs)).toHaveLength(14);
    for (const [target, yaml] of Object.entries(specs)) {
      const spec = parseSpec(yaml) as { version?: number; target: string };
      expect(spec.target).toBe(target);
      expect(spec.version).toBe(1);
    }
  });

  test("the version field is OPTIONAL on the 5 target members added for full-14 coverage above", () => {
    // Companion to the EVERY-member test: each of the 5 shapes that test adds
    // (channel, pipeline, batch, onchain, onchain-game) also parses with NO
    // version field, and `.version` is undefined — the same back-compat proof
    // the CLI_NO_VERSION test above gives for `cli`, extended to these 5.
    const specsNoVersion: Record<string, string> = {
      channel:
        "name: t\ntarget: channel\nagent:\n  model: m\n  instructions: hi\nchannels:\n  slack:\n    botToken: xoxb-test\n    signingSecret: shh\nrouting:\n  sessionKey: thread\n",
      pipeline:
        "name: t\ntarget: pipeline\nagent:\n  model: m\n  instructions: hi\nretrieve:\n  embedderModel: mock/det\nindexing:\n  documents:\n    - id: doc-1\n      text: hi\n",
      batch:
        "name: t\ntarget: batch\nagent:\n  model: m\n  instructions: hi\nqueue:\n  adapter: in-memory\n",
      onchain:
        "name: t\ntarget: onchain\nagent:\n  model: m\n  instructions: hi\nchains:\n  - id: base\n    kind: evm\n    rpcUrls:\n      - https://rpc.example\n    finality:\n      kind: confirmations\n      count: 12\ncontracts:\n  - id: treasury\n    chainId: base\n    address: '0xtreasury'\n    abiRef: abi://safe\ntriggers:\n  - kind: event\n    chainId: base\n    contract: treasury\n    event: Transfer\n",
      "onchain-game":
        "name: t\ntarget: onchain-game\nagent:\n  model: m\n  instructions: hi\nchain:\n  id: base\n  kind: evm\n  rpcUrls:\n    - https://rpc.example\n  finality:\n    kind: confirmations\n    count: 1\nwallet:\n  id: player\n  chainId: base\n  custody: local\ngame:\n  contract:\n    id: game\n    chainId: base\n    address: '0xgame'\n    abiRef: abi://game\n  stateReader: readState\n",
    };
    for (const [target, yaml] of Object.entries(specsNoVersion)) {
      const spec = parseSpec(yaml) as { version?: number; target: string };
      expect(spec.target).toBe(target);
      expect(spec.version).toBeUndefined();
    }
  });
});

describe("agent.model_fallbacks + agent.circuit_breaker (item 22)", () => {
  const cliWithAgent = (agentLines: string): string =>
    [
      "name: hello",
      "target: cli",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: hi",
      agentLines,
    ].join("\n");

  test("parses model_fallbacks + circuit_breaker on the cli agent block", () => {
    const spec = parseSpec(
      cliWithAgent(
        [
          "  model_fallbacks:",
          "    - openai/gpt-4o-mini",
          "    - groq/llama-3.3-70b",
          "  circuit_breaker:",
          "    failureThreshold: 3",
          "    windowMs: 60000",
          "    cooldownMs: 30000",
        ].join("\n"),
      ),
    );
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.agent.model_fallbacks).toEqual(["openai/gpt-4o-mini", "groq/llama-3.3-70b"]);
    expect(spec.agent.circuit_breaker).toEqual({
      failureThreshold: 3,
      windowMs: 60000,
      cooldownMs: 30000,
    });
  });

  test("model_fallbacks entries follow the agent.model validation rules (non-empty strings)", () => {
    expect(() => parseSpec(cliWithAgent('  model_fallbacks:\n    - ""'))).toThrow(
      /model_fallbacks/,
    );
    expect(() => parseSpec(cliWithAgent("  model_fallbacks: []"))).toThrow(/model_fallbacks/);
  });

  test("circuit_breaker is strict: a typo'd knob (halfOpenProbes) fails the parse", () => {
    expect(() => parseSpec(cliWithAgent("  circuit_breaker:\n    halfOpenProbes: 2"))).toThrow(
      /circuit_breaker/,
    );
  });

  test("channel agent block accepts the same fields", () => {
    const spec = parseSpec(
      [
        "name: bot",
        "target: channel",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: hi",
        "  model_fallbacks:",
        "    - openai/gpt-4o-mini",
        "  circuit_breaker:",
        "    cooldownMs: 5000",
        "channels:",
        "  slack:",
        "    botToken: $SLACK_BOT_TOKEN",
        "    signingSecret: $SLACK_SIGNING_SECRET",
        "routing:",
        "  sessionKey: thread",
      ].join("\n"),
    );
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.agent.model_fallbacks).toEqual(["openai/gpt-4o-mini"]);
    expect(spec.agent.circuit_breaker).toEqual({ cooldownMs: 5000 });
  });

  test("managed agent block accepts the same fields", () => {
    const spec = parseSpec(
      [
        "name: mg",
        "target: managed",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: hi",
        "  model_fallbacks:",
        "    - openai/gpt-4o-mini",
        "tenants:",
        "  - id: t1",
        "    budget:",
        "      maxInputTokens: 1",
        "      maxOutputTokens: 1",
      ].join("\n"),
    );
    if (spec.target !== "managed") throw new Error("unexpected target");
    expect(spec.agent.model_fallbacks).toEqual(["openai/gpt-4o-mini"]);
  });

  test("shapes without the wiring still reject the fields (strict agent blocks)", () => {
    expect(() =>
      parseSpec(
        [
          "name: bt",
          "target: batch",
          "agent:",
          "  model: m",
          "  instructions: i",
          "  model_fallbacks:",
          "    - openai/gpt-4o-mini",
          "queue:",
          "  adapter: in-memory",
        ].join("\n"),
      ),
    ).toThrow(/model_fallbacks/);
  });
});

describe("failure_taxonomy switch-model recovery action (item 23)", () => {
  test("accepts recovery: switch-model", () => {
    const spec = parseSpec(
      [
        "name: c",
        "target: cli",
        "agent:",
        "  model: m",
        "  instructions: i",
        "failure_taxonomy:",
        "  - class: overloaded",
        "    pattern: /529/",
        "    recovery: switch-model",
      ].join("\n"),
    );
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.failure_taxonomy?.[0]?.recovery).toBe("switch-model");
  });

  test("still rejects an unknown recovery value", () => {
    expect(() =>
      parseSpec(
        [
          "name: c",
          "target: cli",
          "agent:",
          "  model: m",
          "  instructions: i",
          "failure_taxonomy:",
          "  - class: x",
          "    pattern: y",
          "    recovery: reboot",
        ].join("\n"),
      ),
    ).toThrow();
  });
});

describe("run-level budget cap block (item 27)", () => {
  const cli = (budgetLines: string): string =>
    ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", budgetLines].join("\n");

  test("parses a stop budget", () => {
    const spec = parseSpec(cli("budget:\n  usd: 5\n  on_exceed:\n    action: stop"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.budget?.usd).toBe(5);
    expect(spec.budget?.on_exceed).toEqual({ action: "stop" });
  });

  test("parses a degrade ladder", () => {
    const spec = parseSpec(
      cli("budget:\n  usd: 12.5\n  on_exceed:\n    action: degrade\n    model: claude-haiku-4-5"),
    );
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.budget?.on_exceed).toEqual({ action: "degrade", model: "claude-haiku-4-5" });
  });

  test("on_exceed defaults to stop", () => {
    const spec = parseSpec(cli("budget:\n  usd: 1"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.budget?.on_exceed).toEqual({ action: "stop" });
  });

  test("rejects usd <= 0, unknown action, and a degrade without model", () => {
    expect(() => parseSpec(cli("budget:\n  usd: 0"))).toThrow();
    expect(() => parseSpec(cli("budget:\n  usd: 1\n  on_exceed:\n    action: nope"))).toThrow();
    expect(() => parseSpec(cli("budget:\n  usd: 1\n  on_exceed:\n    action: degrade"))).toThrow();
  });

  // Loop contract 0.4 (Batch A) — budget joined workflow/graph/crew/research/
  // batch/browser, so the strict-rejection canary moved to voice (still
  // outside the budget-carrying set).
  test("shapes without the wiring reject the budget block (strict)", () => {
    expect(() =>
      parseSpec(
        [
          "name: vc",
          "target: voice",
          "agent:",
          "  model: m",
          "  instructions: i",
          "budget:",
          "  usd: 1",
          "voice:",
          "  provider: openai",
        ].join("\n"),
      ),
    ).toThrow();
  });
});

describe("parseSpec agent.model_pool", () => {
  const withPool = (poolYaml: string) =>
    parseSpec(
      [
        "name: pooled",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-5",
        "  instructions: be helpful",
        ...poolYaml.split("\n"),
      ].join("\n"),
    );

  test("parses a valid pool; tags default to [] and policy to heuristic", () => {
    const spec = withPool(
      [
        "  model_pool:",
        "    candidates:",
        "      - model: claude-haiku-4-5",
        "        tags: [cheap, fast]",
        "      - model: claude-opus-4-8",
      ].join("\n"),
    );
    if (spec.target !== "cli") expect.unreachable();
    const pool = spec.agent.model_pool;
    expect(pool).toBeDefined();
    expect(pool?.candidates.map((c) => c.model)).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
    expect(pool?.candidates[0].tags).toEqual(["cheap", "fast"]);
    expect(pool?.candidates[1].tags).toEqual([]); // defaulted
    expect(pool?.policy).toBe("heuristic"); // defaulted
  });

  test("parses objective / routing / learning knobs", () => {
    const spec = withPool(
      [
        "  model_pool:",
        "    policy: learned",
        "    candidates:",
        "      - model: claude-haiku-4-5",
        "        tags: [cheap]",
        "      - model: claude-opus-4-8",
        "        tags: [strong]",
        "    objective: { quality: 0.6, cost: 0.3, latency: 0.1 }",
        "    routing: { contextTokenThreshold: 8000, strongTag: strong, cheapTag: cheap }",
        "    learning: { minSamplesPerArm: 40, costRefUsd: 0.02, latencyRefMs: 3000 }",
      ].join("\n"),
    );
    if (spec.target !== "cli") expect.unreachable();
    const pool = spec.agent.model_pool;
    expect(pool?.policy).toBe("learned");
    expect(pool?.objective).toEqual({ quality: 0.6, cost: 0.3, latency: 0.1 });
    expect(pool?.routing?.strongTag).toBe("strong");
    expect(pool?.learning?.minSamplesPerArm).toBe(40);
  });

  test("rejects a pool with fewer than two candidates", () => {
    expect(() =>
      withPool(["  model_pool:", "    candidates:", "      - model: claude-haiku-4-5"].join("\n")),
    ).toThrow(SpecParseError);
  });

  test("rejects an invalid policy", () => {
    expect(() =>
      withPool(
        [
          "  model_pool:",
          "    policy: bandit",
          "    candidates:",
          "      - model: a",
          "      - model: b",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });

  test("rejects unknown fields inside a candidate (strict)", () => {
    expect(() =>
      withPool(
        [
          "  model_pool:",
          "    candidates:",
          "      - model: a",
          "        weight: 3",
          "      - model: b",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });

  test("model_pool is mutually exclusive with model_tiers", () => {
    expect(() =>
      withPool(
        [
          "  model_tiers: { fast: claude-haiku-4-5, default: claude-opus-4-8 }",
          "  model_pool:",
          "    candidates:",
          "      - model: claude-haiku-4-5",
          "      - model: claude-opus-4-8",
        ].join("\n"),
      ),
    ).toThrow(/mutually exclusive/);
  });

  test("model_pool is mutually exclusive with model_fallbacks", () => {
    expect(() =>
      withPool(
        [
          "  model_fallbacks: [claude-opus-4-8]",
          "  model_pool:",
          "    candidates:",
          "      - model: claude-haiku-4-5",
          "      - model: claude-opus-4-8",
        ].join("\n"),
      ),
    ).toThrow(/mutually exclusive/);
  });

  test("model_pool is accepted on channel and managed agent blocks", () => {
    const channel = parseSpec(
      [
        "name: pooled-channel",
        "target: channel",
        "agent:",
        "  model: claude-sonnet-5",
        "  instructions: help",
        "  model_pool:",
        "    candidates:",
        "      - model: claude-haiku-4-5",
        "      - model: claude-opus-4-8",
        "channels:",
        "  slack:",
        "    botToken: xoxb-test",
        "    signingSecret: shh",
        "routing:",
        "  sessionKey: thread",
      ].join("\n"),
    );
    if (channel.target !== "channel") expect.unreachable();
    expect(channel.agent.model_pool?.candidates.length).toBe(2);

    const managed = parseSpec(
      [
        "name: pooled-managed",
        "target: managed",
        "agent:",
        "  model: claude-sonnet-5",
        "  instructions: help",
        "  model_pool:",
        "    candidates:",
        "      - model: claude-haiku-4-5",
        "      - model: claude-opus-4-8",
        "tenants:",
        "  - id: acme",
        "    budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }",
      ].join("\n"),
    );
    if (managed.target !== "managed") expect.unreachable();
    expect(managed.agent.model_pool?.policy).toBe("heuristic");
  });
});

// ---------------------------------------------------------------------------
// Loop contract 0.4 (Batch A) — limits / thinking / hooks / rate_limits /
// streaming / compaction+memory extensions / graph when+parallel / budget +
// max_tokens shape coverage.
// ---------------------------------------------------------------------------

describe("Batch A — top-level limits block", () => {
  const cli = (lines: string): string =>
    ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", lines].join("\n");

  test("parses every base field on cli", () => {
    const spec = parseSpec(
      cli(
        [
          "limits:",
          "  max_tool_iterations: 25",
          "  max_concurrent_tools: 4",
          "  context_limit: 180000",
          "  deadline_ms: 600000",
          "  turn_timeout_ms: 120000",
          "  model_call_timeout_ms: 60000",
          "  loop_detection:",
          "    window: 10",
          "    threshold: 3",
          "    escalation: justify",
        ].join("\n"),
      ),
    );
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.limits).toEqual({
      max_tool_iterations: 25,
      max_concurrent_tools: 4,
      context_limit: 180000,
      deadline_ms: 600000,
      turn_timeout_ms: 120000,
      model_call_timeout_ms: 60000,
      loop_detection: { window: 10, threshold: 3, escalation: "justify" },
    });
  });

  test.each([
    ["a zero max_tool_iterations", "limits:\n  max_tool_iterations: 0"],
    ["a negative deadline_ms", "limits:\n  deadline_ms: -1"],
    ["a fractional turn_timeout_ms", "limits:\n  turn_timeout_ms: 1.5"],
    [
      "a loop_detection threshold of 1 (int>1 required)",
      "limits:\n  loop_detection:\n    threshold: 1",
    ],
    ["an unknown escalation", "limits:\n  loop_detection:\n    escalation: explode"],
    ["an unknown sub-key (strict)", "limits:\n  max_turns: 5"],
  ])("rejects %s", (_label, lines) => {
    expect(() => parseSpec(cli(lines))).toThrow(SpecParseError);
  });

  test("limits.crew is accepted on the crew shape only", () => {
    const crew = (limitsLines: string): string =>
      [
        "name: cr",
        "target: crew",
        "model: m",
        "entry: lead",
        "roles:",
        "  lead:",
        "    instructions: lead it",
        limitsLines,
      ].join("\n");
    const spec = parseSpec(
      crew(
        [
          "limits:",
          "  max_tool_iterations: 9",
          "  crew:",
          "    max_activations: 12",
          "    refusal_depth: 0",
          "    max_a2a_depth: 3",
        ].join("\n"),
      ),
    );
    if (spec.target !== "crew") expect.unreachable();
    expect(spec.limits?.crew).toEqual({
      max_activations: 12,
      refusal_depth: 0,
      max_a2a_depth: 3,
    });
    // refusal_depth is int>=0; max_activations int>0.
    expect(() => parseSpec(crew("limits:\n  crew:\n    refusal_depth: -1"))).toThrow(
      SpecParseError,
    );
    expect(() => parseSpec(crew("limits:\n  crew:\n    max_activations: 0"))).toThrow(
      SpecParseError,
    );
    // The base limits block everywhere else rejects the crew sub-block.
    expect(() => parseSpec(cli("limits:\n  crew:\n    max_activations: 3"))).toThrow(
      SpecParseError,
    );
  });

  test("limits parses on channel/managed/workflow/graph/research/batch/browser and is rejected on voice/pipeline/eval", () => {
    const limits = "limits:\n  max_tool_iterations: 7";
    const accepted: string[] = [
      [
        "name: ch",
        "target: channel",
        "agent:",
        "  model: m",
        "  instructions: i",
        "channels:",
        "  slack:",
        "    botToken: xoxb-1",
        "    signingSecret: s",
        "routing:",
        "  sessionKey: thread",
        limits,
      ].join("\n"),
      [
        "name: mg",
        "target: managed",
        "agent:",
        "  model: m",
        "  instructions: i",
        "tenants:",
        "  - id: t1",
        "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
        limits,
      ].join("\n"),
      [
        "name: wf",
        "target: workflow",
        "model: m",
        "steps:",
        "  - name: one",
        "    instructions: do it",
        limits,
      ].join("\n"),
      [
        "name: g",
        "target: graph",
        "model: m",
        "entry: a",
        "nodes:",
        "  a:",
        "    instructions: do a",
        limits,
      ].join("\n"),
      [
        "name: re",
        "target: research",
        "agent:",
        "  model: m",
        "  instructions: i",
        "goal: learn",
        limits,
      ].join("\n"),
      [
        "name: bt",
        "target: batch",
        "agent:",
        "  model: m",
        "  instructions: i",
        "queue:",
        "  adapter: in-memory",
        limits,
      ].join("\n"),
      ["name: br", "target: browser", "agent:", "  model: m", "  instructions: i", limits].join(
        "\n",
      ),
    ];
    for (const yaml of accepted) {
      const spec = parseSpec(yaml);
      expect(
        (spec as { limits?: { max_tool_iterations?: number } }).limits?.max_tool_iterations,
      ).toBe(7);
    }
    expect(() =>
      parseSpec(
        [
          "name: vc",
          "target: voice",
          "agent:",
          "  model: m",
          "  instructions: i",
          "voice:",
          "  provider: openai",
          limits,
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
    expect(() =>
      parseSpec(
        [
          "name: pl",
          "target: pipeline",
          "agent:",
          "  model: m",
          "  instructions: i",
          "retrieve:",
          "  embedderModel: e",
          "indexing:",
          "  documents:",
          "    - id: d1",
          "      text: t",
          limits,
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
    expect(() =>
      parseSpec(
        [
          "name: ev",
          "target: eval",
          "agent:",
          "  model: m",
          "  instructions: i",
          "dataset:",
          "  name: d",
          "  version: v1",
          "graders:",
          "  - name: g",
          limits,
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });
});

describe("Batch A — thinking selector (exactly one form)", () => {
  const cli = (lines: string): string =>
    ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", lines].join("\n");

  test("parses the budget_tokens form on the cli agent", () => {
    const spec = parseSpec(cli("  thinking:\n    budget_tokens: 4096"));
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.thinking).toEqual({ budget_tokens: 4096 });
  });

  test("parses the effort form on the cli agent", () => {
    const spec = parseSpec(cli("  thinking:\n    effort: high"));
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.thinking).toEqual({ effort: "high" });
  });

  test.each([
    ["both forms at once", "  thinking:\n    budget_tokens: 4096\n    effort: low"],
    ["neither form (empty object)", "  thinking: {}"],
    ["a sub-floor budget (1024 floor)", "  thinking:\n    budget_tokens: 512"],
    ["an unknown effort", "  thinking:\n    effort: max"],
    ["an unknown sub-key (strict)", "  thinking:\n    tokens: 4096"],
  ])("rejects %s", (_label, lines) => {
    expect(() => parseSpec(cli(lines))).toThrow(SpecParseError);
  });

  test("accepted at step/node/role granularity and on channel/managed agents", () => {
    const wf = parseSpec(
      [
        "name: wf",
        "target: workflow",
        "model: m",
        "steps:",
        "  - name: one",
        "    instructions: do it",
        "    max_tokens: 9000",
        "    thinking:",
        "      effort: low",
      ].join("\n"),
    );
    if (wf.target !== "workflow") expect.unreachable();
    expect(wf.steps[0]?.thinking).toEqual({ effort: "low" });
    expect(wf.steps[0]?.max_tokens).toBe(9000);

    const g = parseSpec(
      [
        "name: g",
        "target: graph",
        "model: m",
        "entry: a",
        "nodes:",
        "  a:",
        "    instructions: do a",
        "    max_tokens: 2048",
        "    thinking:",
        "      budget_tokens: 2048",
      ].join("\n"),
    );
    if (g.target !== "graph") expect.unreachable();
    expect(g.nodes["a"]?.thinking).toEqual({ budget_tokens: 2048 });
    expect(g.nodes["a"]?.max_tokens).toBe(2048);

    const cr = parseSpec(
      [
        "name: cr",
        "target: crew",
        "model: m",
        "entry: lead",
        "roles:",
        "  lead:",
        "    instructions: lead it",
        "    max_tokens: 4096",
        "    thinking:",
        "      effort: medium",
      ].join("\n"),
    );
    if (cr.target !== "crew") expect.unreachable();
    expect(cr.roles["lead"]?.thinking).toEqual({ effort: "medium" });
    expect(cr.roles["lead"]?.max_tokens).toBe(4096);

    const ch = parseSpec(
      [
        "name: ch",
        "target: channel",
        "agent:",
        "  model: m",
        "  instructions: i",
        "  max_tokens: 12000",
        "  thinking:",
        "    effort: low",
        "channels:",
        "  slack:",
        "    botToken: xoxb-1",
        "    signingSecret: s",
        "routing:",
        "  sessionKey: thread",
      ].join("\n"),
    );
    if (ch.target !== "channel") expect.unreachable();
    expect(ch.agent.thinking).toEqual({ effort: "low" });
    expect(ch.agent.max_tokens).toBe(12000);

    const mg = parseSpec(
      [
        "name: mg",
        "target: managed",
        "agent:",
        "  model: m",
        "  instructions: i",
        "  max_tokens: 6000",
        "  thinking:",
        "    budget_tokens: 8192",
        "tenants:",
        "  - id: t1",
        "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
      ].join("\n"),
    );
    if (mg.target !== "managed") expect.unreachable();
    expect(mg.agent.thinking).toEqual({ budget_tokens: 8192 });
    expect(mg.agent.max_tokens).toBe(6000);
  });
});

describe("Batch A — hooks block", () => {
  const cli = (lines: string): string =>
    ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", lines].join("\n");

  test("parses a hooks array with every field", () => {
    const spec = parseSpec(
      cli(
        [
          "hooks:",
          "  - event: pre-tool",
          "    matcher: Bash",
          "    command: ./guard.sh",
          "    timeout_ms: 3000",
          "  - event: session-start",
          "    command: echo hi",
        ].join("\n"),
      ),
    );
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.hooks).toEqual([
      { event: "pre-tool", matcher: "Bash", command: "./guard.sh", timeout_ms: 3000 },
      { event: "session-start", command: "echo hi" },
    ]);
  });

  test.each([
    ["an unknown event name", "hooks:\n  - event: on-tool\n    command: x"],
    ["a missing command", "hooks:\n  - event: stop"],
    ["a zero timeout_ms", "hooks:\n  - event: stop\n    command: x\n    timeout_ms: 0"],
    ["an unknown sub-key (strict)", "hooks:\n  - event: stop\n    command: x\n    cwd: /tmp"],
  ])("rejects %s", (_label, lines) => {
    expect(() => parseSpec(cli(lines))).toThrow(SpecParseError);
  });

  test("hooks are rejected on shapes outside the limits set (voice)", () => {
    expect(() =>
      parseSpec(
        [
          "name: vc",
          "target: voice",
          "agent:",
          "  model: m",
          "  instructions: i",
          "voice:",
          "  provider: openai",
          "hooks:",
          "  - event: stop",
          "    command: x",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });

  test("SPEC_HOOK_EVENTS is exported for the hooks-engine cross-check", () => {
    expect(SPEC_HOOK_EVENTS).toContain("pre-tool");
    expect(SPEC_HOOK_EVENTS).toContain("alert");
    expect(SPEC_HOOK_EVENTS.length).toBe(10);
  });
});

describe("Batch A — agent.streaming and agent.rate_limits", () => {
  const cli = (lines: string): string =>
    ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", lines].join("\n");

  test("streaming parses on cli and is rejected on channel (cli-only)", () => {
    const spec = parseSpec(cli("  streaming: true"));
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.streaming).toBe(true);
    expect(() =>
      parseSpec(
        [
          "name: ch",
          "target: channel",
          "agent:",
          "  model: m",
          "  instructions: i",
          "  streaming: true",
          "channels:",
          "  slack:",
          "    botToken: xoxb-1",
          "    signingSecret: s",
          "routing:",
          "  sessionKey: thread",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });

  test("rate_limits parses tool buckets and the * catch-all", () => {
    const spec = parseSpec(
      cli(
        [
          "  rate_limits:",
          "    Bash:",
          "      rpm: 30",
          "      burst: 5",
          '    "*":',
          "      rpm: 120",
        ].join("\n"),
      ),
    );
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.rate_limits).toEqual({
      Bash: { rpm: 30, burst: 5 },
      "*": { rpm: 120 },
    });
  });

  test.each([
    ["a zero rpm", "  rate_limits:\n    Bash:\n      rpm: 0"],
    ["a missing rpm", "  rate_limits:\n    Bash:\n      burst: 5"],
    ["an unknown sub-key (strict)", "  rate_limits:\n    Bash:\n      rpm: 5\n      per: minute"],
  ])("rejects %s", (_label, lines) => {
    expect(() => parseSpec(cli(lines))).toThrow(SpecParseError);
  });
});

describe("Batch A — compaction threshold/snip + memory embedder", () => {
  const cli = (lines: string): string =>
    ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", lines].join("\n");

  test("parses threshold + snip window", () => {
    const spec = parseSpec(
      cli("compaction:\n  threshold: 0.85\n  snip_keep_head: 3\n  snip_keep_tail: 8"),
    );
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.compaction).toEqual({ threshold: 0.85, snip_keep_head: 3, snip_keep_tail: 8 });
  });

  test.each([
    ["a threshold below 0.5", "compaction:\n  threshold: 0.4"],
    ["a threshold above 0.99", "compaction:\n  threshold: 1"],
    ["a zero snip_keep_head", "compaction:\n  snip_keep_head: 0"],
    ["a fractional snip_keep_tail", "compaction:\n  snip_keep_tail: 2.5"],
  ])("rejects %s", (_label, lines) => {
    expect(() => parseSpec(cli(lines))).toThrow(SpecParseError);
  });

  test("threshold bounds are inclusive (0.5 and 0.99 parse)", () => {
    const lo = parseSpec(cli("compaction:\n  threshold: 0.5"));
    if (lo.target !== "cli") expect.unreachable();
    expect(lo.compaction?.threshold).toBe(0.5);
    const hi = parseSpec(cli("compaction:\n  threshold: 0.99"));
    if (hi.target !== "cli") expect.unreachable();
    expect(hi.compaction?.threshold).toBe(0.99);
  });

  test("memory.embedder parses alongside wiki.embedder", () => {
    const spec = parseSpec(
      cli(
        ["memory:", "  embedder: builtin:hash", "  wiki:", "    embedder: builtin:hash"].join("\n"),
      ),
    );
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.memory?.embedder).toBe("builtin:hash");
    expect(spec.memory?.wiki?.embedder).toBe("builtin:hash");
    expect(() => parseSpec(cli('memory:\n  embedder: ""'))).toThrow(SpecParseError);
  });
});

describe("Batch A — budget extended to the six new shapes", () => {
  test("workflow/graph/crew/research/batch/browser accept budget", () => {
    const budget = "budget:\n  usd: 2";
    const specs: string[] = [
      [
        "name: wf",
        "target: workflow",
        "model: m",
        "steps:",
        "  - name: s",
        "    instructions: i",
        budget,
      ].join("\n"),
      [
        "name: g",
        "target: graph",
        "model: m",
        "entry: a",
        "nodes:",
        "  a:",
        "    instructions: i",
        budget,
      ].join("\n"),
      [
        "name: cr",
        "target: crew",
        "model: m",
        "entry: lead",
        "roles:",
        "  lead:",
        "    instructions: i",
        budget,
      ].join("\n"),
      [
        "name: re",
        "target: research",
        "agent:",
        "  model: m",
        "  instructions: i",
        "goal: g",
        budget,
      ].join("\n"),
      [
        "name: bt",
        "target: batch",
        "agent:",
        "  model: m",
        "  instructions: i",
        "queue:",
        "  adapter: in-memory",
        budget,
      ].join("\n"),
      ["name: br", "target: browser", "agent:", "  model: m", "  instructions: i", budget].join(
        "\n",
      ),
    ];
    for (const yaml of specs) {
      const spec = parseSpec(yaml);
      expect((spec as { budget?: { usd: number } }).budget?.usd).toBe(2);
    }
  });
});

describe("Batch A — agent.max_tokens on research/batch/browser (not pipeline)", () => {
  test("research/batch/browser accept agent.max_tokens", () => {
    const re = parseSpec(
      [
        "name: re",
        "target: research",
        "agent:",
        "  model: m",
        "  instructions: i",
        "  max_tokens: 9000",
        "goal: g",
      ].join("\n"),
    );
    if (re.target !== "research") expect.unreachable();
    expect(re.agent.max_tokens).toBe(9000);

    const bt = parseSpec(
      [
        "name: bt",
        "target: batch",
        "agent:",
        "  model: m",
        "  instructions: i",
        "  max_tokens: 7000",
        "queue:",
        "  adapter: in-memory",
      ].join("\n"),
    );
    if (bt.target !== "batch") expect.unreachable();
    expect(bt.agent.max_tokens).toBe(7000);

    const br = parseSpec(
      [
        "name: br",
        "target: browser",
        "agent:",
        "  model: m",
        "  instructions: i",
        "  max_tokens: 5000",
      ].join("\n"),
    );
    if (br.target !== "browser") expect.unreachable();
    expect(br.agent.max_tokens).toBe(5000);
  });

  test("pipeline still rejects agent.max_tokens (strict)", () => {
    expect(() =>
      parseSpec(
        [
          "name: pl",
          "target: pipeline",
          "agent:",
          "  model: m",
          "  instructions: i",
          "  max_tokens: 5000",
          "retrieve:",
          "  embedderModel: e",
          "indexing:",
          "  documents:",
          "    - id: d1",
          "      text: t",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });
});

describe("Batch A — graph edges[].when + parallel", () => {
  const graph = (lines: string): string =>
    [
      "name: g",
      "target: graph",
      "model: m",
      "entry: a",
      "nodes:",
      "  a:",
      "    instructions: do a",
      "  b:",
      "    instructions: do b",
      "  c:",
      "    instructions: do c",
      lines,
    ].join("\n");

  test("parses the equals form and the exists form", () => {
    const spec = parseSpec(
      graph(
        [
          "edges:",
          "  - from: a",
          "    to: b",
          "    when:",
          "      key: a",
          "      equals: approve",
          "  - from: a",
          "    to: c",
          "    when:",
          "      key: a",
          "      exists: true",
        ].join("\n"),
      ),
    );
    if (spec.target !== "graph") expect.unreachable();
    expect(spec.edges[0]?.when).toEqual({ key: "a", equals: "approve" });
    expect(spec.edges[1]?.when).toEqual({ key: "a", exists: true });
  });

  test("equals accepts numbers and booleans (including false)", () => {
    const spec = parseSpec(
      graph(
        [
          "edges:",
          "  - from: a",
          "    to: b",
          "    when:",
          "      key: a",
          "      equals: 3",
          "  - from: a",
          "    to: c",
          "    when:",
          "      key: a",
          "      equals: false",
        ].join("\n"),
      ),
    );
    if (spec.target !== "graph") expect.unreachable();
    expect(spec.edges[0]?.when).toEqual({ key: "a", equals: 3 });
    expect(spec.edges[1]?.when).toEqual({ key: "a", equals: false });
  });

  test.each([
    [
      "both equals and exists",
      "edges:\n  - from: a\n    to: b\n    when:\n      key: a\n      equals: x\n      exists: true",
    ],
    ["neither form", "edges:\n  - from: a\n    to: b\n    when:\n      key: a"],
    [
      "exists: false (literal true only)",
      "edges:\n  - from: a\n    to: b\n    when:\n      key: a\n      exists: false",
    ],
    [
      "an unknown sub-key (strict)",
      "edges:\n  - from: a\n    to: b\n    when:\n      key: a\n      matches: x",
    ],
  ])("rejects %s", (_label, lines) => {
    expect(() => parseSpec(graph(lines))).toThrow(SpecParseError);
  });

  test("when.key must name a declared node (parse-level cross-check)", () => {
    expect(() =>
      parseSpec(
        graph("edges:\n  - from: a\n    to: b\n    when:\n      key: ghost\n      exists: true"),
      ),
    ).toThrow(/when\.key "ghost" must name a declared node/);
  });

  test("parallel parses groups of >= 2 declared nodes", () => {
    const spec = parseSpec(graph("edges:\n  - from: a\n    to: b\nparallel:\n  - [b, c]"));
    if (spec.target !== "graph") expect.unreachable();
    expect(spec.parallel).toEqual([["b", "c"]]);
  });

  test("parallel rejects singleton groups and undeclared members", () => {
    expect(() => parseSpec(graph("parallel:\n  - [b]"))).toThrow(SpecParseError);
    expect(() => parseSpec(graph("parallel:\n  - [b, ghost]"))).toThrow(
      /parallel\[0\] references "ghost"/,
    );
  });
});
