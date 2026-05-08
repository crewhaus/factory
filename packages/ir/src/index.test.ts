import { describe, expect, test } from "bun:test";
import type {
  Bundle,
  IrChannelV0,
  IrCompaction,
  IrMcpServerConfig,
  IrMcpServers,
  IrNode,
  IrPermissionRule,
  IrPermissions,
  IrSecretRef,
  IrSubAgentDefinition,
  IrToolConfigs,
  IrV0,
  IrWorkflowStep,
  IrWorkflowV0,
} from "./index";

/**
 * The ir package is type-only — every export is a `type`. These tests
 * construct representative instances of each shape and exercise the
 * discriminated unions so the structural contract is locked in. If any
 * later refactor renames a field or weakens a literal, this file fails to
 * compile (caught by `bun test` before the unit assertions run).
 */
describe("IrV0 (cli target)", () => {
  test("a minimal cli IR satisfies all required fields", () => {
    const ir: IrV0 = {
      version: 0,
      name: "hello",
      target: "cli",
      agent: { model: "claude-sonnet-4-6", instructions: "be helpful" },
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      subAgents: [],
      compaction: {},
    };
    expect(ir.version).toBe(0);
    expect(ir.target).toBe("cli");
    expect(ir.agent.model).toBe("claude-sonnet-4-6");
  });

  test("permissions.mode is one of default | plan | auto (never bypass)", () => {
    const perm: IrPermissions = { mode: "plan", rules: [] };
    expect(perm.mode).toBe("plan");
    // @ts-expect-error — bypass is not a legal IR mode (CLI flag only)
    const _illegal: IrPermissions = { mode: "bypass", rules: [] };
    void _illegal;
  });

  test("permission rule types are restricted to the three grammar values", () => {
    const rule: IrPermissionRule = { type: "alwaysAllow", pattern: "Read" };
    expect(rule.type).toBe("alwaysAllow");
    // @ts-expect-error — typo not allowed
    const _bad: IrPermissionRule = { type: "alwaysAllowed", pattern: "x" };
    void _bad;
  });
});

describe("IrWorkflowV0 (workflow target)", () => {
  test("workflow IR carries an ordered step array, each with a resolved model", () => {
    const step1: IrWorkflowStep = {
      name: "list",
      instructions: "list the files",
      model: "claude-sonnet-4-6",
      tools: ["bash"],
      toolConfigs: {},
    };
    const step2: IrWorkflowStep = {
      name: "summarise",
      instructions: "summarise the listing",
      model: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
    };
    const ir: IrWorkflowV0 = {
      version: 0,
      name: "two-step",
      target: "workflow",
      steps: [step1, step2],
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.steps.length).toBe(2);
    expect(ir.steps[0]?.model).toBe(step1.model);
  });
});

describe("IrChannelV0 (channel target)", () => {
  test("channel IR carries channels + routing + secret refs", () => {
    const literal: IrSecretRef = { kind: "literal", value: "xoxb-fake" };
    const envRef: IrSecretRef = { kind: "env", name: "SLACK_SIGNING_SECRET" };
    const ir: IrChannelV0 = {
      version: 0,
      name: "slackbot",
      target: "channel",
      agent: { model: "claude-sonnet-4-6", instructions: "be helpful" },
      tools: [],
      toolConfigs: {},
      channels: { slack: { botToken: literal, signingSecret: envRef } },
      routing: { sessionKey: "thread" },
      mcp_servers: {},
      permissions: { rules: [] },
      subAgents: [],
      compaction: {},
    };
    expect(ir.target).toBe("channel");
    expect(ir.channels.slack?.botToken.kind).toBe("literal");
    expect(ir.channels.slack?.signingSecret.kind).toBe("env");
    expect(ir.routing.sessionKey).toBe("thread");
  });

  test("sessionKey is restricted to thread | user | channel", () => {
    // @ts-expect-error — random string is not a legal sessionKey
    const _bad: IrChannelV0["routing"] = { sessionKey: "random" };
    void _bad;
  });
});

describe("IrNode discriminated union narrowing", () => {
  test("switching on `target` narrows correctly", () => {
    const cliNode: IrNode = {
      version: 0,
      name: "x",
      target: "cli",
      agent: { model: "m", instructions: "i" },
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      subAgents: [],
      compaction: {},
    };
    const workflowNode: IrNode = {
      version: 0,
      name: "x",
      target: "workflow",
      steps: [],
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    const channelNode: IrNode = {
      version: 0,
      name: "x",
      target: "channel",
      agent: { model: "m", instructions: "i" },
      tools: [],
      toolConfigs: {},
      channels: {},
      routing: { sessionKey: "thread" },
      mcp_servers: {},
      permissions: { rules: [] },
      subAgents: [],
      compaction: {},
    };

    function describeNode(n: IrNode): string {
      switch (n.target) {
        case "cli":
          return `cli:${n.agent.model}`;
        case "workflow":
          return `workflow:${n.steps.length}`;
        case "channel":
          return `channel:${n.routing.sessionKey}`;
      }
    }

    expect(describeNode(cliNode)).toBe("cli:m");
    expect(describeNode(workflowNode)).toBe("workflow:0");
    expect(describeNode(channelNode)).toBe("channel:thread");
  });
});

describe("IrMcpServers", () => {
  test("stdio + sse configs both satisfy IrMcpServerConfig", () => {
    const stdio: IrMcpServerConfig = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    };
    const sse: IrMcpServerConfig = {
      transport: "sse",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer x" },
    };
    const servers: IrMcpServers = { everything: stdio, remote: sse };
    expect(servers["everything"]?.transport).toBe("stdio");
    expect(servers["remote"]?.transport).toBe("sse");
  });
});

describe("Bundle shape", () => {
  test("Bundle carries a list of {path, content} files", () => {
    const bundle: Bundle = {
      files: [
        { path: "agent.ts", content: "// hello" },
        { path: "package.json", content: "{}" },
      ],
    };
    expect(bundle.files.length).toBe(2);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });
});

describe("IrSubAgentDefinition (Section 13)", () => {
  test("a sub-agent with `inherit` permissions has no allow/deny lists", () => {
    const def: IrSubAgentDefinition = {
      name: "summariser",
      description: "summarise its input in two sentences",
      instructions: "be concise",
      tools: [],
      permissions: "inherit",
      inheritBypass: false,
    };
    expect(def.permissions).toBe("inherit");
    expect(def.inheritBypass).toBe(false);
  });

  test("a sub-agent with `scoped` permissions limits to listed tools", () => {
    const def: IrSubAgentDefinition = {
      name: "code-reviewer",
      description: "review diffs",
      instructions: "look for bugs",
      tools: ["read", "grep"],
      permissions: "scoped",
      inheritBypass: false,
    };
    expect(def.permissions).toBe("scoped");
    expect(def.tools).toEqual(["read", "grep"]);
  });

  test("a sub-agent with explicit allow/deny lists narrows further", () => {
    const def: IrSubAgentDefinition = {
      name: "auditor",
      description: "audits a folder",
      instructions: "report findings",
      tools: ["read", "grep"],
      permissions: { allow: ["Read", "Grep(**/src/**)"], deny: ["Bash"] },
      inheritBypass: false,
    };
    if (typeof def.permissions === "string") expect.unreachable();
    expect(def.permissions.allow).toEqual(["Read", "Grep(**/src/**)"]);
    expect(def.permissions.deny).toEqual(["Bash"]);
  });

  test("inheritBypass: true is allowed for explicit opt-in propagation", () => {
    const def: IrSubAgentDefinition = {
      name: "trusted",
      description: "trusted helper",
      instructions: "do its job",
      tools: [],
      permissions: "inherit",
      inheritBypass: true,
    };
    expect(def.inheritBypass).toBe(true);
  });

  test("optional model override is allowed", () => {
    const def: IrSubAgentDefinition = {
      name: "haiku-helper",
      description: "fast helper",
      instructions: "be quick",
      tools: [],
      model: "claude-haiku-4-5",
      permissions: "inherit",
      inheritBypass: false,
    };
    expect(def.model).toBe("claude-haiku-4-5");
  });
});

describe("IrToolConfigs (Section 14)", () => {
  test("opaque per-tool config blob is keyed by tool name", () => {
    const configs: IrToolConfigs = {
      WebFetch: { allowed_domains: ["example.com"], timeoutMs: 30_000 },
      Fetch: { allowed_origins: ["https://api.github.com"] },
    };
    expect((configs["WebFetch"] as { allowed_domains: string[] }).allowed_domains).toEqual([
      "example.com",
    ]);
    expect(Object.keys(configs).length).toBe(2);
  });

  test("empty toolConfigs is valid (lower-time default)", () => {
    const configs: IrToolConfigs = {};
    expect(Object.keys(configs).length).toBe(0);
  });
});

describe("IrCompaction (Section 17)", () => {
  test("an empty compaction block is valid (defaults to agent model)", () => {
    const c: IrCompaction = {};
    expect(c.model).toBeUndefined();
  });

  test("compaction.model overrides the autocompact summarisation model", () => {
    const c: IrCompaction = { model: "openai/gpt-4o-mini" };
    expect(c.model).toBe("openai/gpt-4o-mini");
  });
});
