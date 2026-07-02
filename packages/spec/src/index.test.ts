import { describe, expect, test } from "bun:test";
import { Spec, SpecParseError, parseSpec } from "./index";

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
