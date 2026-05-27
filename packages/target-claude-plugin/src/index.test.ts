import { describe, expect, test } from "bun:test";
import type { IrCrewV0, IrGraphV0, IrV0, IrWorkflowV0 } from "@crewhaus/ir";
import { TargetClaudePluginError, emitClaudePlugin } from "./index";

const baseCli: IrV0 = {
  version: 0,
  name: "hello-plugin",
  target: "cli",
  agent: { model: "claude-sonnet-4-6", instructions: "Be helpful." },
  tools: [],
  toolConfigs: {},
  mcp_servers: {},
  permissions: { rules: [] },
  subAgents: [],
  compaction: {},
};

const baseWorkflow: IrWorkflowV0 = {
  version: 0,
  name: "summarize-then-translate",
  target: "workflow",
  steps: [
    {
      name: "summarize",
      instructions: "Summarize the input.",
      model: "m",
      tools: [],
      toolConfigs: {},
    },
    {
      name: "translate",
      instructions: "Translate the summary to French.",
      model: "m",
      tools: [],
      toolConfigs: {},
    },
  ],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
};

const baseGraph: IrGraphV0 = {
  version: 0,
  name: "plan-then-execute",
  target: "graph",
  entry: "planner",
  nodes: [
    { name: "planner", instructions: "Make a plan", model: "m", tools: [], toolConfigs: {} },
    { name: "executor", instructions: "Execute", model: "m", tools: [], toolConfigs: {} },
  ],
  edges: [{ from: "planner", to: "executor" }],
  permissions: { rules: [] },
  compaction: {},
};

const baseCrew: IrCrewV0 = {
  version: 0,
  name: "research-crew",
  target: "crew",
  entry: "researcher",
  roles: [
    {
      name: "researcher",
      model: "m",
      instructions: "Do research.",
      tools: [],
      toolConfigs: {},
      subAgents: [],
    },
    {
      name: "writer",
      model: "m",
      instructions: "Write the report.",
      tools: [],
      toolConfigs: {},
      subAgents: [],
    },
  ],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
};

describe("emitClaudePlugin — universal files", () => {
  test("always emits plugin.json and README.md", () => {
    const b = emitClaudePlugin(baseCli, { author: { name: "Test" } });
    const paths = b.files.map((f) => f.path);
    expect(paths).toContain(".claude-plugin/plugin.json");
    expect(paths).toContain("README.md");
  });

  test("plugin.json has the minimal Anthropic schema", () => {
    const b = emitClaudePlugin(baseCli, {
      author: { name: "Test Author", email: "x@y.z" },
      description: "test description",
    });
    const file = b.files.find((f) => f.path === ".claude-plugin/plugin.json");
    expect(file).toBeDefined();
    const parsed = JSON.parse(file?.content ?? "{}");
    expect(parsed.name).toBe("hello-plugin");
    expect(parsed.description).toBe("test description");
    expect(parsed.author.name).toBe("Test Author");
    expect(parsed.author.email).toBe("x@y.z");
    // No extra fields beyond what Anthropic requires.
    expect(Object.keys(parsed).sort()).toEqual(["author", "description", "name"]);
  });

  test("omits .mcp.json when mcp_servers is empty", () => {
    const b = emitClaudePlugin(baseCli, { author: { name: "x" } });
    expect(b.files.find((f) => f.path === ".mcp.json")).toBeUndefined();
  });

  test("emits .mcp.json when mcp_servers is populated", () => {
    const ir: IrV0 = {
      ...baseCli,
      mcp_servers: {
        fs: { transport: "stdio", command: "npx", args: ["-y", "fs"] },
      },
    };
    const b = emitClaudePlugin(ir, { author: { name: "x" } });
    const mcp = b.files.find((f) => f.path === ".mcp.json");
    expect(mcp).toBeDefined();
    expect(JSON.parse(mcp?.content ?? "{}").fs.transport).toBe("stdio");
  });
});

describe("emitClaudePlugin — per-shape emission", () => {
  test("cli emits one SKILL.md and one agent per sub-agent", () => {
    const ir: IrV0 = {
      ...baseCli,
      subAgents: [
        {
          name: "reviewer",
          description: "Reviews code",
          instructions: "Find bugs",
          tools: [],
          permissions: "inherit",
          inheritBypass: false,
        },
      ],
    };
    const b = emitClaudePlugin(ir, { author: { name: "x" } });
    expect(b.files.some((f) => f.path === "skills/hello-plugin/SKILL.md")).toBe(true);
    expect(b.files.some((f) => f.path === "agents/reviewer.md")).toBe(true);
  });

  test("workflow emits one SKILL.md per step", () => {
    const b = emitClaudePlugin(baseWorkflow, { author: { name: "x" } });
    const skillPaths = b.files.map((f) => f.path).filter((p) => p.startsWith("skills/"));
    expect(skillPaths).toContain("skills/summarize-then-translate-summarize/SKILL.md");
    expect(skillPaths).toContain("skills/summarize-then-translate-translate/SKILL.md");
  });

  test("graph emits one top-level SKILL.md plus one per node", () => {
    const b = emitClaudePlugin(baseGraph, { author: { name: "x" } });
    const skillPaths = b.files.map((f) => f.path).filter((p) => p.startsWith("skills/"));
    expect(skillPaths).toContain("skills/plan-then-execute/SKILL.md");
    expect(skillPaths).toContain("skills/plan-then-execute-planner/SKILL.md");
    expect(skillPaths).toContain("skills/plan-then-execute-executor/SKILL.md");
  });

  test("crew emits SKILL.md for entry role and one agent per role", () => {
    const b = emitClaudePlugin(baseCrew, { author: { name: "x" } });
    expect(b.files.some((f) => f.path === "skills/research-crew/SKILL.md")).toBe(true);
    expect(b.files.some((f) => f.path === "agents/researcher.md")).toBe(true);
    expect(b.files.some((f) => f.path === "agents/writer.md")).toBe(true);
  });
});

describe("SKILL.md frontmatter", () => {
  test("uses minimal name + description frontmatter", () => {
    const b = emitClaudePlugin(baseCli, { author: { name: "x" } });
    const skill = b.files.find((f) => f.path === "skills/hello-plugin/SKILL.md");
    expect(skill?.content).toMatch(/^---\nname: hello-plugin\ndescription: /);
    expect(skill?.content).toContain("Be helpful.");
  });
});

describe("emitClaudePlugin — error handling", () => {
  test("throws on unsupported target shape", () => {
    expect(() =>
      emitClaudePlugin({ target: "unknown-shape" } as never, {
        author: { name: "x" },
      }),
    ).toThrow(TargetClaudePluginError);
  });
});
