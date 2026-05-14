import { describe, expect, test } from "bun:test";
import type {
  Bundle,
  IrBatchQueueAdapter,
  IrBatchV0,
  IrBrowserBackend,
  IrBrowserV0,
  IrChannelV0,
  IrCompaction,
  IrCrewRole,
  IrCrewV0,
  IrEvalV0,
  IrGraphEdge,
  IrGraphNode,
  IrGraphV0,
  IrManagedTenant,
  IrManagedV0,
  IrMcpServerConfig,
  IrMcpServers,
  IrNode,
  IrPermissionRule,
  IrPermissions,
  IrPipelineDocument,
  IrPipelineV0,
  IrResearchV0,
  IrSecretRef,
  IrSubAgentDefinition,
  IrToolConfigs,
  IrV0,
  IrVoiceProvider,
  IrVoiceV0,
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
    const graphNode: IrNode = {
      version: 0,
      name: "x",
      target: "graph",
      entry: "plan",
      nodes: [
        {
          name: "plan",
          instructions: "plan the work",
          model: "m",
          tools: [],
          toolConfigs: {},
        },
        {
          name: "act",
          instructions: "act on the plan",
          model: "m",
          tools: [],
          toolConfigs: {},
        },
      ],
      edges: [{ from: "plan", to: "act" }],
      permissions: { rules: [] },
      compaction: {},
    };
    const managedNode: IrNode = {
      version: 0,
      name: "x",
      target: "managed",
      agent: { model: "m", instructions: "i" },
      tenants: [
        { id: "t1", budget: { maxInputTokens: 1000, maxOutputTokens: 1000 } },
        { id: "t2", budget: { maxInputTokens: 2000, maxOutputTokens: 2000 } },
      ],
      permissions: { rules: [] },
      compaction: {},
    };
    const pipelineNode: IrNode = {
      version: 0,
      name: "x",
      target: "pipeline",
      agent: { model: "m", instructions: "i" },
      retrieve: {
        embedderModel: "openai/text-embedding-3-small",
        vectorBackend: "in-memory",
        defaultK: 5,
      },
      indexing: {
        chunkStrategy: "fixed",
        chunkSize: 512,
        chunkOverlap: 50,
        documents: [
          { id: "d1", text: "hello" },
          { id: "d2", text: "world" },
          { id: "d3", text: "of pipelines" },
        ],
      },
      permissions: { rules: [] },
      compaction: {},
    };
    const crewNode: IrNode = {
      version: 0,
      name: "x",
      target: "crew",
      entry: "researcher",
      roles: [
        {
          name: "researcher",
          model: "m",
          instructions: "research",
          tools: [],
          toolConfigs: {},
          subAgents: [],
        },
        {
          name: "writer",
          model: "m",
          instructions: "write",
          tools: [],
          toolConfigs: {},
          subAgents: [],
        },
      ],
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    const researchNode: IrNode = {
      version: 0,
      name: "x",
      target: "research",
      agent: { model: "m", instructions: "i" },
      goal: "study GRPH risks",
      branchingFactor: 3,
      maxDurationMs: 300_000,
      retrieve: { allowedOrigins: ["https://example.com"], allowedFileRoots: [] },
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    const batchNode: IrNode = {
      version: 0,
      name: "x",
      target: "batch",
      agent: { model: "m", instructions: "i" },
      queue: {
        adapter: "in-memory",
        visibilityTimeoutMs: 30_000,
        maxRetries: 3,
        seedJobs: ["job-1"],
      },
      concurrency: 4,
      idempotencyWindowMs: 60_000,
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    const voiceNode: IrNode = {
      version: 0,
      name: "x",
      target: "voice",
      agent: { model: "m", instructions: "i" },
      voice: {
        provider: "openai",
        voiceId: "alloy",
        vad: "server",
        bargeInTriggerFrames: 3,
        bargeInWindowMs: 200,
      },
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    const browserNode: IrNode = {
      version: 0,
      name: "x",
      target: "browser",
      agent: { model: "m", instructions: "i" },
      driver: {
        backend: "chromium",
        viewport: { width: 1280, height: 800 },
        startUrl: "https://example.com",
      },
      groundingModel: "m",
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    const evalNode: IrNode = {
      version: 0,
      name: "x",
      target: "eval",
      agent: { model: "m", instructions: "i", tools: [] },
      dataset: { name: "smoke", version: "v1", split: "dev" },
      graders: [{ name: "exact_match" }, { name: "judge", opts: { rubric: "concise" } }],
      concurrency: 4,
    };

    function describeNode(n: IrNode): string {
      switch (n.target) {
        case "cli":
          return `cli:${n.agent.model}`;
        case "workflow":
          return `workflow:${n.steps.length}`;
        case "channel":
          return `channel:${n.routing.sessionKey}`;
        case "graph":
          return `graph:${n.nodes.length}`;
        case "managed":
          return `managed:${n.tenants.length}`;
        case "pipeline":
          return `pipeline:${n.indexing.documents.length}`;
        case "crew":
          return `crew:${n.roles.length}`;
        case "research":
          return `research:${n.branchingFactor}`;
        case "batch":
          return `batch:${n.queue.adapter}`;
        case "voice":
          return `voice:${n.voice.provider}`;
        case "browser":
          return `browser:${n.driver.backend}`;
        case "eval":
          return `eval:${n.dataset.name}@${n.dataset.version}`;
        case "onchain":
          return `onchain:${n.triggers.length}`;
        case "onchain-game":
          return `onchain-game:${n.game.turnSemantics}`;
      }
    }

    expect(describeNode(cliNode)).toBe("cli:m");
    expect(describeNode(workflowNode)).toBe("workflow:0");
    expect(describeNode(channelNode)).toBe("channel:thread");
    expect(describeNode(graphNode)).toBe("graph:2");
    expect(describeNode(managedNode)).toBe("managed:2");
    expect(describeNode(pipelineNode)).toBe("pipeline:3");
    expect(describeNode(crewNode)).toBe("crew:2");
    expect(describeNode(researchNode)).toBe("research:3");
    expect(describeNode(batchNode)).toBe("batch:in-memory");
    expect(describeNode(voiceNode)).toBe("voice:openai");
    expect(describeNode(browserNode)).toBe("browser:chromium");
    expect(describeNode(evalNode)).toBe("eval:smoke@v1");
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

describe("IrGraphV0 (Section 19)", () => {
  test("a 3-node graph with an entry + edges has every required field", () => {
    const plan: IrGraphNode = {
      name: "plan",
      instructions: "plan the steps",
      model: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
    };
    const act: IrGraphNode = {
      name: "act",
      instructions: "carry out the plan",
      model: "claude-sonnet-4-6",
      tools: ["bash"],
      toolConfigs: {},
    };
    const summarise: IrGraphNode = {
      name: "summarise",
      instructions: "summarise the result",
      model: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
    };
    const planAct: IrGraphEdge = { from: "plan", to: "act" };
    const actSum: IrGraphEdge = { from: "act", to: "summarise" };
    const ir: IrGraphV0 = {
      version: 0,
      name: "three-step",
      target: "graph",
      entry: "plan",
      nodes: [plan, act, summarise],
      edges: [planAct, actSum],
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.entry).toBe("plan");
    expect(ir.nodes.length).toBe(3);
    expect(ir.edges.length).toBe(2);
    expect(ir.nodes[0]?.hitlPrompt).toBeUndefined();
  });

  test("a node with hitlPrompt opts the run into HITL pause/resume", () => {
    const node: IrGraphNode = {
      name: "approve",
      instructions: "ask the user before continuing",
      model: "m",
      tools: [],
      toolConfigs: {},
      hitlPrompt: "ok to proceed?",
    };
    expect(node.hitlPrompt).toBe("ok to proceed?");
  });
});

describe("IrManagedV0 (Section 20)", () => {
  test("a managed daemon IR carries a tenant table and per-tenant budgets", () => {
    const t1: IrManagedTenant = {
      id: "tenant-a",
      budget: { maxInputTokens: 100_000, maxOutputTokens: 50_000 },
    };
    const t2: IrManagedTenant = {
      id: "tenant-b",
      budget: { maxInputTokens: 200_000, maxOutputTokens: 100_000 },
    };
    const ir: IrManagedV0 = {
      version: 0,
      name: "saas-bot",
      target: "managed",
      agent: { model: "claude-sonnet-4-6", instructions: "be helpful" },
      tenants: [t1, t2],
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.tenants.length).toBe(2);
    expect(ir.tenants[0]?.id).toBe("tenant-a");
    expect(ir.tenants[1]?.budget.maxInputTokens).toBe(200_000);
  });

  test("an empty tenant table is structurally valid (lower-time fail-loud lives in the spec parser)", () => {
    const ir: IrManagedV0 = {
      version: 0,
      name: "empty",
      target: "managed",
      agent: { model: "m", instructions: "i" },
      tenants: [],
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.tenants.length).toBe(0);
  });
});

describe("IrPipelineV0 (Section 21)", () => {
  test("a pipeline IR carries retrieve config + indexing pipeline + agent block", () => {
    const docs: IrPipelineDocument[] = [
      { id: "doc-1", text: "hello world" },
      { id: "doc-2", text: "rag stack", metadata: { source: "readme" } },
    ];
    const ir: IrPipelineV0 = {
      version: 0,
      name: "doc-bot",
      target: "pipeline",
      agent: { model: "claude-sonnet-4-6", instructions: "answer using Retrieve" },
      retrieve: {
        embedderModel: "openai/text-embedding-3-small",
        vectorBackend: "in-memory",
        defaultK: 5,
      },
      indexing: {
        chunkStrategy: "markdown",
        chunkSize: 1024,
        chunkOverlap: 100,
        documents: docs,
      },
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.retrieve.vectorBackend).toBe("in-memory");
    expect(ir.indexing.documents.length).toBe(2);
    expect(ir.indexing.documents[1]?.metadata?.["source"]).toBe("readme");
  });

  test("chunkStrategy is restricted to fixed | semantic | markdown", () => {
    const _bad: IrPipelineV0["indexing"] = {
      // @ts-expect-error — random string is not a legal chunkStrategy
      chunkStrategy: "random",
      chunkSize: 0,
      chunkOverlap: 0,
      documents: [],
    };
    void _bad;
  });

  test("vectorBackend is restricted to in-memory in v0", () => {
    const _bad: IrPipelineV0["retrieve"] = {
      embedderModel: "x",
      // @ts-expect-error — qdrant/pinecone/lance are roadmap, not yet in v0
      vectorBackend: "qdrant",
      defaultK: 5,
    };
    void _bad;
  });
});

describe("IrCrewV0 (Section 22)", () => {
  test("a crew IR carries an entry role + role table; sub-agents inherited per role", () => {
    const researcher: IrCrewRole = {
      name: "researcher",
      model: "claude-sonnet-4-6",
      instructions: "gather facts",
      tools: ["WebFetch"],
      toolConfigs: {},
      subAgents: [],
    };
    const writer: IrCrewRole = {
      name: "writer",
      model: "claude-sonnet-4-6",
      instructions: "synthesise into a post",
      tools: [],
      toolConfigs: {},
      subAgents: [
        {
          name: "outline-helper",
          description: "draft an outline",
          instructions: "produce a 5-bullet outline",
          tools: [],
          permissions: "inherit",
          inheritBypass: false,
        },
      ],
    };
    const ir: IrCrewV0 = {
      version: 0,
      name: "research-crew",
      target: "crew",
      entry: "researcher",
      roles: [researcher, writer],
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.entry).toBe("researcher");
    expect(ir.roles.length).toBe(2);
    expect(ir.roles[1]?.subAgents.length).toBe(1);
  });

  test("optional routing.match maps source-role → next-role on substring match", () => {
    const ir: IrCrewV0 = {
      version: 0,
      name: "router-crew",
      target: "crew",
      entry: "researcher",
      roles: [],
      routing: {
        kind: "match",
        match: {
          researcher: [{ contains: "DONE", to: "writer" }],
        },
      },
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.routing?.kind).toBe("match");
    expect(ir.routing?.match?.["researcher"]?.[0]?.to).toBe("writer");
  });

  test("routing.kind is restricted to match | llm", () => {
    // @ts-expect-error — random string is not a legal routing kind
    const _bad: IrCrewV0["routing"] = { kind: "random" };
    void _bad;
  });
});

describe("IrResearchV0 (Section 23 — RES)", () => {
  test("a research IR carries goal + branchingFactor + retrieve allowlists", () => {
    const ir: IrResearchV0 = {
      version: 0,
      name: "doc-research",
      target: "research",
      agent: { model: "claude-sonnet-4-6", instructions: "research deeply" },
      goal: "what gates the BROW shape",
      branchingFactor: 4,
      maxDurationMs: 30 * 60 * 1000,
      retrieve: {
        allowedOrigins: ["https://docs.example.com"],
        allowedFileRoots: ["/tmp/research"],
        vectorBackend: "in-memory",
      },
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.branchingFactor).toBe(4);
    expect(ir.retrieve.allowedOrigins).toEqual(["https://docs.example.com"]);
    expect(ir.retrieve.vectorBackend).toBe("in-memory");
  });

  test("retrieve.allowedOrigins / allowedFileRoots can both be empty (fail-closed)", () => {
    const ir: IrResearchV0 = {
      version: 0,
      name: "locked-down",
      target: "research",
      agent: { model: "m", instructions: "i" },
      goal: "x",
      branchingFactor: 1,
      maxDurationMs: 1000,
      retrieve: { allowedOrigins: [], allowedFileRoots: [] },
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.retrieve.allowedOrigins.length).toBe(0);
    expect(ir.retrieve.allowedFileRoots.length).toBe(0);
  });
});

describe("IrBatchV0 (Section 23 — BATCH)", () => {
  test("a batch IR carries queue config + concurrency + idempotency window", () => {
    const ir: IrBatchV0 = {
      version: 0,
      name: "queue-worker",
      target: "batch",
      agent: { model: "claude-haiku-4-5", instructions: "process the job" },
      queue: {
        adapter: "redis-streams",
        visibilityTimeoutMs: 30_000,
        visibilityRenewIntervalMs: 10_000,
        maxRetries: 5,
      },
      concurrency: 8,
      idempotencyWindowMs: 24 * 60 * 60 * 1000,
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.queue.adapter).toBe("redis-streams");
    expect(ir.concurrency).toBe(8);
    expect(ir.idempotencyWindowMs).toBe(86_400_000);
  });

  test("queue.adapter is restricted to in-memory | sqs | redis-streams | postgres", () => {
    const valid: IrBatchQueueAdapter[] = ["in-memory", "sqs", "redis-streams", "postgres"];
    expect(valid.length).toBe(4);
    // @ts-expect-error — kafka is not a legal queue adapter in v0
    const _bad: IrBatchQueueAdapter = "kafka";
    void _bad;
  });

  test("seedJobs only populated when adapter === 'in-memory' (test/smoke convenience)", () => {
    const ir: IrBatchV0 = {
      version: 0,
      name: "seeded",
      target: "batch",
      agent: { model: "m", instructions: "i" },
      queue: {
        adapter: "in-memory",
        visibilityTimeoutMs: 30_000,
        maxRetries: 3,
        seedJobs: ["job-a", "job-b", "job-c"],
      },
      concurrency: 2,
      idempotencyWindowMs: 60_000,
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.queue.seedJobs?.length).toBe(3);
  });
});

describe("IrVoiceV0 (Section 24 — VOICE)", () => {
  test("a voice IR carries provider + voiceId + barge-in trigger config", () => {
    const ir: IrVoiceV0 = {
      version: 0,
      name: "phone-bot",
      target: "voice",
      agent: { model: "claude-sonnet-4-6", instructions: "greet the caller" },
      voice: {
        provider: "openai",
        voiceId: "alloy",
        vad: "server",
        bargeInTriggerFrames: 3,
        bargeInWindowMs: 200,
      },
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.voice.provider).toBe("openai");
    expect(ir.voice.bargeInTriggerFrames).toBe(3);
    expect(ir.voice.vad).toBe("server");
  });

  test("optional telephony adapter wires Twilio / LiveKit / in-memory smoke", () => {
    const ir: IrVoiceV0 = {
      version: 0,
      name: "twilio-bot",
      target: "voice",
      agent: { model: "m", instructions: "i" },
      voice: {
        provider: "vapi",
        voiceId: "default",
        vad: "server",
        bargeInTriggerFrames: 2,
        bargeInWindowMs: 150,
      },
      telephony: { provider: "twilio" },
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.telephony?.provider).toBe("twilio");
  });

  test("provider is restricted to openai | vapi", () => {
    const valid: IrVoiceProvider[] = ["openai", "vapi"];
    expect(valid.length).toBe(2);
    // @ts-expect-error — google realtime is not yet in v0
    const _bad: IrVoiceProvider = "google";
    void _bad;
  });
});

describe("IrBrowserV0 (Section 25 — BROW)", () => {
  test("a browser IR carries driver backend + viewport + grounding model", () => {
    const ir: IrBrowserV0 = {
      version: 0,
      name: "ops-bot",
      target: "browser",
      agent: { model: "claude-sonnet-4-6", instructions: "navigate the dashboard" },
      driver: {
        backend: "chromium",
        viewport: { width: 1280, height: 800 },
        startUrl: "https://example.com/login",
      },
      groundingModel: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.driver.backend).toBe("chromium");
    expect(ir.driver.viewport.width).toBe(1280);
    expect(ir.driver.startUrl).toBe("https://example.com/login");
  });

  test("driver.backend is restricted to host | chromium | remote", () => {
    const valid: IrBrowserBackend[] = ["host", "chromium", "remote"];
    expect(valid.length).toBe(3);
    // @ts-expect-error — firefox-driver isn't a legal backend in v0
    const _bad: IrBrowserBackend = "firefox-driver";
    void _bad;
  });

  test("startUrl is optional; daemon skips goto() when absent", () => {
    const ir: IrBrowserV0 = {
      version: 0,
      name: "no-start",
      target: "browser",
      agent: { model: "m", instructions: "i" },
      driver: { backend: "chromium", viewport: { width: 800, height: 600 } },
      groundingModel: "m",
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(ir.driver.startUrl).toBeUndefined();
  });
});

describe("IrEvalV0 (Section 29 — EVAL target)", () => {
  test("an eval IR carries dataset reference + graders + concurrency", () => {
    const ir: IrEvalV0 = {
      version: 0,
      name: "smoke-eval",
      target: "eval",
      agent: {
        model: "claude-sonnet-4-6",
        instructions: "answer concisely",
        tools: ["read"],
      },
      dataset: { name: "qa-bench", version: "v1", split: "dev" },
      graders: [{ name: "exact_match" }, { name: "judge", opts: { rubric: "concise + correct" } }],
      concurrency: 4,
      seed: 42,
    };
    expect(ir.dataset.split).toBe("dev");
    expect(ir.graders.length).toBe(2);
    expect(ir.graders[1]?.opts?.["rubric"]).toBe("concise + correct");
    expect(ir.concurrency).toBe(4);
    expect(ir.seed).toBe(42);
  });

  test("dataset.split is restricted to train | dev | test", () => {
    // @ts-expect-error — random string is not a legal split
    const _bad: IrEvalV0["dataset"] = { name: "x", version: "v1", split: "validation" };
    void _bad;
  });

  test("seed is optional; runner falls back to provider-default temperature", () => {
    const ir: IrEvalV0 = {
      version: 0,
      name: "no-seed",
      target: "eval",
      agent: { model: "m", instructions: "i", tools: [] },
      dataset: { name: "x", version: "v1", split: "dev" },
      graders: [],
      concurrency: 1,
    };
    expect(ir.seed).toBeUndefined();
  });
});
