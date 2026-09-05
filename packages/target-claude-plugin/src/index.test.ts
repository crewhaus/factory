import { describe, expect, test } from "bun:test";
import type {
  IrChannelV0,
  IrCrewV0,
  IrEvalV0,
  IrGraphV0,
  IrManagedV0,
  IrNode,
  IrV0,
  IrWorkflowV0,
} from "@crewhaus/ir";
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

  test("0.3.0 — secret refs render as Claude Code ${VAR} expansions; literals as plain strings", () => {
    const ir: IrV0 = {
      ...baseCli,
      mcp_servers: {
        thredz: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "thredz-mcp@0.2.0"],
          env: {
            THREDZ_API_KEY: { kind: "env", name: "THREDZ_API_KEY" },
            THREDZ_BASE_URL: { kind: "literal", value: "https://thredz.example/api" },
          },
        },
        remote: {
          transport: "sse",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: { kind: "env", name: "API_TOKEN" } },
        },
      },
    };
    const b = emitClaudePlugin(ir, { author: { name: "x" } });
    const parsed = JSON.parse(b.files.find((f) => f.path === ".mcp.json")?.content ?? "{}");
    // Claude Code expands ${VAR} from the user's environment at load time —
    // the secret itself never lands in the plugin artifact.
    expect(parsed.thredz.env.THREDZ_API_KEY).toBe("${THREDZ_API_KEY}");
    expect(parsed.thredz.env.THREDZ_BASE_URL).toBe("https://thredz.example/api");
    expect(parsed.remote.headers.Authorization).toBe("${API_TOKEN}");
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

describe("emitClaudePlugin — channel shape", () => {
  const baseChannel: IrChannelV0 = {
    version: 0,
    name: "slackbot",
    target: "channel",
    agent: { model: "claude-sonnet-4-6", instructions: "Greet users warmly. Then help them." },
    tools: [],
    toolConfigs: {},
    channels: {
      slack: {
        botToken: { kind: "literal", value: "xoxb-fake" },
        signingSecret: { kind: "env", name: "SLACK_SIGNING_SECRET" },
      },
    },
    routing: { sessionKey: "thread" },
    mcp_servers: {},
    permissions: { rules: [] },
    subAgents: [],
    compaction: {},
  };

  test("emits the CLI-shaped SKILL.md from agent.instructions", () => {
    const b = emitClaudePlugin(baseChannel, { author: { name: "x" } });
    const skill = b.files.find((f) => f.path === "skills/slackbot/SKILL.md");
    expect(skill).toBeDefined();
    // description is the first sentence of the instructions.
    expect(skill?.content).toContain("Greet users warmly.");
    expect(skill?.content).toContain("Then help them.");
  });

  test("appends a CLAUDE_PLUGIN_NOTES.md flagging the channel daemon context", () => {
    const b = emitClaudePlugin(baseChannel, { author: { name: "x" } });
    const notes = b.files.find((f) => f.path === "CLAUDE_PLUGIN_NOTES.md");
    expect(notes).toBeDefined();
    expect(notes?.content).toContain("# Channel daemon notes");
    expect(notes?.content).toContain("target: channel");
    expect(notes?.content).toContain("lifecycle is NOT part of the");
  });

  test("forwards channel sub-agents into agents/<name>.md", () => {
    const withSub: IrChannelV0 = {
      ...baseChannel,
      subAgents: [
        {
          name: "triage",
          description: "Triage incoming messages",
          instructions: "Sort by urgency",
          tools: [],
          permissions: "inherit",
          inheritBypass: false,
        },
      ],
    };
    const b = emitClaudePlugin(withSub, { author: { name: "x" } });
    const agent = b.files.find((f) => f.path === "agents/triage.md");
    expect(agent).toBeDefined();
    expect(agent?.content).toContain("name: triage");
    expect(agent?.content).toContain("Sort by urgency");
  });

  test("a sub-agent's profile overlay (carried raw on the IR) heads the agent body", () => {
    const withOverlay: IrChannelV0 = {
      ...baseChannel,
      subAgents: [
        {
          name: "triage",
          description: "Triage incoming messages",
          instructions: "Sort by urgency",
          tools: [],
          permissions: "inherit",
          inheritBypass: false,
          model: "claude-haiku-4-5",
          modelProfile: "fast",
          overlay: "You are the fast lane.",
        },
      ],
    };
    const b = emitClaudePlugin(withOverlay, { author: { name: "x" } });
    const agent = b.files.find((f) => f.path === "agents/triage.md");
    expect(agent?.content).toContain("---\n\nYou are the fast lane.\n\nSort by urgency\n");
  });
});

describe("emitClaudePlugin — eval shape", () => {
  const baseEval: IrEvalV0 = {
    version: 0,
    name: "qa-eval",
    target: "eval",
    agent: { model: "claude-sonnet-4-6", instructions: "Answer concisely.", tools: [] },
    dataset: { name: "qa-bench", version: "v1", split: "dev" },
    graders: [{ name: "exact_match" }],
    concurrency: 4,
  };

  test("emits a single SKILL.md naming the dataset + split in its description", () => {
    const b = emitClaudePlugin(baseEval, { author: { name: "x" } });
    const skill = b.files.find((f) => f.path === "skills/qa-eval/SKILL.md");
    expect(skill).toBeDefined();
    expect(skill?.content).toContain("Eval harness over dataset qa-bench (dev)");
    expect(skill?.content).toContain("Answer concisely.");
    // eval shape emits exactly one skill (no per-grader files).
    const skillPaths = b.files.map((f) => f.path).filter((p) => p.startsWith("skills/"));
    expect(skillPaths).toEqual(["skills/qa-eval/SKILL.md"]);
  });
});

describe("emitClaudePlugin — generic agent shapes", () => {
  const managed: IrManagedV0 = {
    version: 0,
    name: "saas-bot",
    target: "managed",
    agent: { model: "claude-sonnet-4-6", instructions: "Serve every tenant." },
    tenants: [],
    permissions: { rules: [] },
    compaction: {},
  };

  test("managed emits one SKILL.md with a `<target> agent` description", () => {
    const b = emitClaudePlugin(managed, { author: { name: "x" } });
    const skill = b.files.find((f) => f.path === "skills/saas-bot/SKILL.md");
    expect(skill).toBeDefined();
    expect(skill?.content).toContain("managed agent — see body for instructions.");
    expect(skill?.content).toContain("Serve every tenant.");
  });

  // pipeline / research route through the same generic helper but with a
  // dedicated switch arm; batch / voice / browser / onchain / onchain-game
  // share a single arm. Exercise every arm so each `case` is covered.
  test.each([
    "pipeline",
    "research",
    "batch",
    "voice",
    "browser",
    "onchain",
    "onchain-game",
  ] as const)("%s target emits a generic SKILL.md", (target) => {
    const ir = {
      version: 0,
      name: `${target}-agent`,
      target,
      agent: { model: "m", instructions: `Run the ${target}.` },
      permissions: { rules: [] },
      compaction: {},
    } as unknown as IrNode;
    const b = emitClaudePlugin(ir, { author: { name: "x" } });
    const skill = b.files.find((f) => f.path === `skills/${target}-agent/SKILL.md`);
    expect(skill).toBeDefined();
    expect(skill?.content).toContain(`${target} agent — see body for instructions.`);
    expect(skill?.content).toContain(`Run the ${target}.`);
  });
});

describe("emitClaudePlugin — authored assets (item 14)", () => {
  const authored = [
    {
      path: "skills/research-topic/SKILL.md",
      content: "---\nname: research-topic\ndescription: corroborate\n---\n\nCite two sources.\n",
    },
    { path: "skills/research-topic/references/checklist.md", content: "- [ ] two sources\n" },
    { path: "commands/browse.md", content: "---\ndescription: browse\n---\nBrowse $ARGUMENTS\n" },
  ];

  test("carries authored skills + commands verbatim alongside the projection", () => {
    const b = emitClaudePlugin(baseCli, { author: { name: "x" }, assets: authored });
    const paths = b.files.map((f) => f.path);
    // The synthesized skill still ships…
    expect(paths).toContain("skills/hello-plugin/SKILL.md");
    // …and so does everything the harness author wrote, byte-for-byte.
    for (const asset of authored) {
      expect(paths).toContain(asset.path);
      expect(b.files.find((f) => f.path === asset.path)?.content).toBe(asset.content);
    }
  });

  test("an authored file overrides the synthesized file at the same path (no duplicates)", () => {
    const override = {
      path: "skills/hello-plugin/SKILL.md",
      content: "---\nname: hello-plugin\ndescription: hand-written\n---\n\nMine.\n",
    };
    const b = emitClaudePlugin(baseCli, { author: { name: "x" }, assets: [override] });
    const matches = b.files.filter((f) => f.path === "skills/hello-plugin/SKILL.md");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.content).toBe(override.content);
    // Position is preserved — the override replaces in place, it does not append.
    expect(new Set(b.files.map((f) => f.path)).size).toBe(b.files.length);
  });

  test("the README names the carried skills and commands", () => {
    const b = emitClaudePlugin(baseCli, { author: { name: "x" }, assets: authored });
    const readme = b.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("## Authored assets");
    expect(readme).toContain("`research-topic`");
    expect(readme).toContain("`/browse`");
  });

  test("no assets → no Authored assets section (unchanged legacy output)", () => {
    const b = emitClaudePlugin(baseCli, { author: { name: "x" } });
    expect(b.files.find((f) => f.path === "README.md")?.content ?? "").not.toContain(
      "Authored assets",
    );
  });

  test("assets do not disturb the plugin.json → README.md file order", () => {
    const b = emitClaudePlugin(baseCli, { author: { name: "x" }, assets: authored });
    expect(b.files[0]?.path).toBe(".claude-plugin/plugin.json");
    expect(b.files[1]?.path).toBe("README.md");
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
