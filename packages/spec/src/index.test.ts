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
