import { describe, expect, test } from "bun:test";
import type { IrCrewV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCrew } from "./index.js";

const baseRole = {
  tools: [],
  toolConfigs: Object.freeze({}),
  subAgents: [],
};

const minimalIr: IrCrewV0 = {
  version: 0,
  name: "hello-crew",
  target: "crew",
  entry: "researcher",
  roles: [
    {
      name: "researcher",
      model: "claude-sonnet-4-6",
      instructions: "You are the researcher.",
      ...baseRole,
    },
    {
      name: "writer",
      model: "claude-sonnet-4-6",
      instructions: "You are the writer.",
      ...baseRole,
    },
    {
      name: "critic",
      model: "claude-sonnet-4-6",
      instructions: "You are the critic.",
      ...baseRole,
    },
  ],
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

describe("emitCrew", () => {
  test("emits orchestrator + daemon + per-role agent files + README (T1 bundle structure)", () => {
    const bundle = emitCrew(minimalIr);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "README.md",
      "agent_critic.ts",
      "agent_researcher.ts",
      "agent_writer.ts",
      "daemon.ts",
      "orchestrator.ts",
    ]);
  });

  test("readme: false omits the generated README.md (item 42 opt-out)", () => {
    const bundle = emitCrew(minimalIr, { readme: false });
    expect(bundle.files.some((f) => f.path === "README.md")).toBe(false);
  });

  test("orchestrator wires every role + sets entry", () => {
    const bundle = emitCrew(minimalIr);
    const orchestrator = bundle.files.find((f) => f.path === "orchestrator.ts");
    expect(orchestrator).toBeDefined();
    const code = orchestrator?.content;
    expect(code).toContain("import { Crew");
    expect(code).toContain('from "./agent_researcher.js"');
    expect(code).toContain('from "./agent_writer.js"');
    expect(code).toContain('from "./agent_critic.js"');
    expect(code).toContain('.setEntry("researcher")');
  });

  test("daemon emits JSON events to stdout in a streaming loop", () => {
    const bundle = emitCrew(minimalIr);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon).toBeDefined();
    const code = daemon?.content;
    expect(code).toContain("for await (const ev of crew.run");
    expect(code).toContain("JSON.stringify(ev)");
    expect(code).toContain("readAllStdin");
  });

  test("per-role agent file exports a RoleDefinition wrapper with model + instructions", () => {
    const bundle = emitCrew(minimalIr);
    const writer = bundle.files.find((f) => f.path === "agent_writer.ts");
    expect(writer).toBeDefined();
    const code = writer?.content;
    expect(code).toContain("export const role:");
    expect(code).toContain('"writer"');
    expect(code).toContain("You are the writer.");
    expect(code).toContain('"claude-sonnet-4-6"');
  });

  test("rejects empty crew", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      roles: [],
      entry: "x",
    };
    expect(() => emitCrew(ir)).toThrow(TargetEmitError);
  });

  test("rejects entry that doesn't match any role", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      entry: "nope",
    };
    expect(() => emitCrew(ir)).toThrow(/entry "nope"/);
  });

  test("rejects unknown tool names", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      roles: [
        {
          name: "r1",
          model: "m",
          instructions: "i",
          tools: ["nonexistent-tool"],
          toolConfigs: Object.freeze({}),
          subAgents: [],
        },
      ],
      entry: "r1",
    };
    expect(() => emitCrew(ir)).toThrow(/unknown tool "nonexistent-tool"/);
  });

  test('emits routing match table when routing.kind === "match"', () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      routing: {
        kind: "match",
        match: {
          researcher: [{ contains: "DONE", to: "writer" }],
          writer: [{ contains: "REVIEW", to: "critic" }],
        },
      },
    };
    const bundle = emitCrew(ir);
    const orch = bundle.files.find((f) => f.path === "orchestrator.ts");
    expect(orch).toBeDefined();
    expect(orch?.content).toContain("__routingTable");
    expect(orch?.content).toContain("setRouting");
    expect(orch?.content).toContain("DONE");
  });

  test("permissions block lands on the daemon's runOptions", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      permissions: {
        mode: "default",
        rules: [
          { type: "alwaysAllow", pattern: "Handoff" },
          { type: "alwaysAllow", pattern: "SendMessage" },
        ],
      },
    };
    const bundle = emitCrew(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content).toContain("BUILTIN_DEFAULT_RULES");
    expect(daemon?.content).toContain("permissionMode");
    expect(daemon?.content).toContain("Handoff");
  });
});

describe("emitCrew — failureTaxonomy field (item 23)", () => {
  test("daemon threads failureTaxonomy into crew.run options", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      failureTaxonomy: [
        { class: "rate_limited", pattern: "/429|rate.?limit/i", recovery: "retry" },
        { class: "tool_timeout", pattern: "ETIMEDOUT", recovery: "continue", hint: "slow tool" },
      ],
    };
    const daemon = emitCrew(ir).files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content ?? "").toContain("failureTaxonomy:");
    expect(daemon?.content ?? "").toContain('"recovery":"retry"');
    expect(daemon?.content ?? "").toContain('"pattern":"ETIMEDOUT"');
  });

  test("omits failureTaxonomy when the IR leaves it unset or empty", () => {
    const unset = emitCrew(minimalIr).files.find((f) => f.path === "daemon.ts");
    expect(unset?.content ?? "").not.toContain("failureTaxonomy:");
    const empty: IrCrewV0 = { ...minimalIr, failureTaxonomy: [] };
    const daemon = emitCrew(empty).files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content ?? "").not.toContain("failureTaxonomy:");
  });
});

describe("emitCrew — terminal-failure reporting (0.3.0 Goal 6)", () => {
  test("daemon renders the structured report and exits coded in both catch sites", () => {
    const daemon = emitCrew(minimalIr).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain(
      'import { formatRunFailure, toFailureReport } from "@crewhaus/errors";',
    );
    // The crew.run loop catch AND main().catch both render the report.
    const occurrences = daemon.split("toFailureReport(err)").length - 1;
    expect(occurrences).toBe(2);
    expect(daemon).toContain(
      'process.stderr.write(`${formatRunFailure(__report, { prefix: "[crew]" })}\\n`);',
    );
    expect(daemon).toContain("process.exit(__report.exitCode);");
    // The pre-0.3.0 bare one-liners are gone.
    expect(daemon).not.toContain("[crew] error: ${");
    expect(daemon).not.toContain("[crew] fatal: ${");
  });
});

describe("emitCrew — llm routing (loop contract 0.4, G08)", () => {
  const llmIr: IrCrewV0 = { ...minimalIr, routing: { kind: "llm" } };

  test('routing.kind === "llm" renders the async classify router into the orchestrator', () => {
    const orch = emitCrew(llmIr).files.find((f) => f.path === "orchestrator.ts")?.content ?? "";
    // The classify turn is a runChatLoop singleTurn on the entry role's model.
    expect(orch).toContain('import { runChatLoop } from "@crewhaus/runtime-core";');
    expect(orch).toContain(
      "builder.setRouting(async ({ input, lastRole, sessionRootDir, _adapter }) => {",
    );
    expect(orch).toContain('model: "claude-sonnet-4-6",');
    expect(orch).toContain("singleTurn: true,");
    expect(orch).toContain('sessionName: "hello-crew (llm-router)",');
    // The run-scoped passthroughs ride the RouterArgs seam.
    expect(orch).toContain("...(sessionRootDir !== undefined ? { sessionRootDir } : {}),");
    expect(orch).toContain("...(_adapter !== undefined ? { _adapter } : {}),");
    // Roster carries every role name + its instructions excerpt.
    expect(orch).toContain('{ name: "researcher", description: "You are the researcher." },');
    expect(orch).toContain('{ name: "writer", description: "You are the writer." },');
    expect(orch).toContain('{ name: "critic", description: "You are the critic." },');
    // Parse ladder + fallbacks: DONE terminates, unparseable → entry role.
    expect(orch).toContain("function __pickNextRole(reply: string, lastRole: string): string {");
    expect(orch).toContain('if (exact === "done") return lastRole;');
    expect(orch).toContain('return "researcher";');
    expect(orch).toContain("return __pickNextRole(reply, lastRole);");
    // No match-table artifacts leak into the llm variant.
    expect(orch).not.toContain("__routingTable");
  });

  test("llm-router roster truncates long role instructions at emit time", () => {
    const longInstructions = "z".repeat(600);
    const ir: IrCrewV0 = {
      ...llmIr,
      roles: [
        { ...llmIr.roles[0], instructions: longInstructions } as IrCrewV0["roles"][number],
        ...llmIr.roles.slice(1),
      ],
    };
    const orch = emitCrew(ir).files.find((f) => f.path === "orchestrator.ts")?.content ?? "";
    expect(orch).toContain(`"${"z".repeat(240)}…"`);
    expect(orch).not.toContain("z".repeat(241));
  });

  test('match routing stays untouched and renders no classify turn (kind: "match")', () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      routing: { kind: "match", match: { researcher: [{ contains: "DONE", to: "writer" }] } },
    };
    const orch = emitCrew(ir).files.find((f) => f.path === "orchestrator.ts")?.content ?? "";
    expect(orch).toContain("__routingTable");
    expect(orch).not.toContain("runChatLoop");
    expect(orch).not.toContain("__pickNextRole");
  });

  test("no routing block renders no router at all", () => {
    const orch = emitCrew(minimalIr).files.find((f) => f.path === "orchestrator.ts")?.content ?? "";
    expect(orch).not.toContain("setRouting");
    expect(orch).not.toContain("runChatLoop");
  });
});

describe("emitCrew — role-level max_tokens + thinking (loop contract 0.4)", () => {
  test("maxTokens and thinking land on the RoleDefinition literal", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      roles: [
        {
          name: "researcher",
          model: "claude-sonnet-4-6",
          instructions: "You are the researcher.",
          maxTokens: 4096,
          thinking: { budgetTokens: 2048 },
          ...baseRole,
        },
        {
          name: "writer",
          model: "claude-sonnet-4-6",
          instructions: "You are the writer.",
          thinking: { effort: "high" },
          ...baseRole,
        },
      ],
    };
    const bundle = emitCrew(ir);
    const researcher = bundle.files.find((f) => f.path === "agent_researcher.ts")?.content ?? "";
    expect(researcher).toContain("maxTokens: 4096,");
    expect(researcher).toContain('thinking: {"budgetTokens":2048},');
    const writer = bundle.files.find((f) => f.path === "agent_writer.ts")?.content ?? "";
    expect(writer).toContain('thinking: {"effort":"high"},');
    expect(writer).not.toContain("maxTokens:");
  });

  test("omitted knobs leave the role file byte-identical to pre-0.4 output", () => {
    const researcher =
      emitCrew(minimalIr).files.find((f) => f.path === "agent_researcher.ts")?.content ?? "";
    expect(researcher).not.toContain("maxTokens:");
    expect(researcher).not.toContain("thinking:");
  });
});

describe("emitCrew — role sub-agents (Section 13, G34)", () => {
  const subAgentIr: IrCrewV0 = {
    ...minimalIr,
    roles: [
      {
        name: "researcher",
        model: "claude-sonnet-4-6",
        instructions: "You are the researcher.",
        tools: ["read"],
        toolConfigs: Object.freeze({}),
        subAgents: [
          {
            name: "digger",
            description: "Deep-dive researcher",
            instructions: "Dig deep.",
            tools: ["read", "grep"],
            permissions: "inherit",
            inheritBypass: false,
          },
        ],
      },
      ...minimalIr.roles.slice(1),
    ],
  };

  test("role file renders the sub-agent map, Task tool, and RoleDefinition.subAgents", () => {
    const agent =
      emitCrew(subAgentIr).files.find((f) => f.path === "agent_researcher.ts")?.content ?? "";
    expect(agent).toContain(
      'import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";',
    );
    expect(agent).toContain('import { createTaskTool } from "@crewhaus/tool-task";');
    expect(agent).toContain(
      "const __subAgents: ReadonlyMap<string, SubAgentDefinition> = new Map<string, SubAgentDefinition>([",
    );
    expect(agent).toContain(
      '["digger", { name: "digger", description: "Deep-dive researcher", instructions: "Dig deep.", tools: ["read","grep"], permissions: "inherit", inherit_bypass: false }],',
    );
    // The Task tool joins the role's own tools; the defs also ride the
    // RoleDefinition so the orchestrator forwards them to the bridge.
    expect(agent).toContain("tools: [read, createTaskTool({ subAgents: __subAgents })],");
    expect(agent).toContain("subAgents: __subAgents,");
  });

  test("daemon injects spawnSubAgent once when any role declares sub-agents", () => {
    const daemon = emitCrew(subAgentIr).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain('import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";');
    expect(daemon).toContain("\n    spawnSubAgent,");
  });

  test("sub-agent-free crews render none of the G34 wiring", () => {
    const bundle = emitCrew(minimalIr);
    const agent = bundle.files.find((f) => f.path === "agent_researcher.ts")?.content ?? "";
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(agent).not.toContain("createTaskTool");
    expect(agent).not.toContain("__subAgents");
    expect(daemon).not.toContain("spawnSubAgent");
  });
});

describe("emitCrew — mcp_servers wiring (G05, wire-once)", () => {
  const mcpIr: IrCrewV0 = {
    ...minimalIr,
    mcp_servers: {
      docs: { transport: "stdio", command: "bunx", args: ["docs-mcp"] },
    } as IrCrewV0["mcp_servers"],
  };

  test("daemon boots one McpHost, registers into a dedicated catalog, threads extraTools", () => {
    const daemon = emitCrew(mcpIr).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain(
      'import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";',
    );
    expect(daemon).toContain('import { registerMcpServer } from "@crewhaus/tool-mcp";');
    expect(daemon).toContain('import { ToolCatalog } from "@crewhaus/tool-catalog";');
    expect(daemon).toContain("const mcpHost = new McpHost();");
    expect(daemon).toContain(
      'mcpHost.addServer("docs", resolveMcpServerConfig({"transport":"stdio","command":"bunx","args":["docs-mcp"]}, { name: "docs" }));',
    );
    expect(daemon).toContain('registerMcpServer(mcpHost, "docs", __mcpCatalog,');
    expect(daemon).toContain("const __mcpTools = __mcpCatalog.list();");
    expect(daemon).toContain("extraTools: __mcpTools,");
    // Registration logs to stderr — stdout is the JSON event stream.
    expect(daemon).toContain("process.stderr.write(`[mcp] registered ${fullName}\\n`)");
    expect(daemon).not.toContain("process.stdout.write(`[mcp]");
    // Shutdown on the clean path AND best-effort on the failure path.
    expect(daemon).toContain("\n  await mcpHost.disconnectAll();");
    expect(daemon).toContain("await mcpHost.disconnectAll().catch(() => {});");
  });

  test("mcp tools compose with the memory fabric's extraTools, user-declared first", () => {
    const ir: IrCrewV0 = { ...mcpIr, memory: { enabled: true } };
    const daemon = emitCrew(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain("extraTools: [...__mcpTools, ...__memTools],");
    // One merged tool-catalog import serves both consumers.
    expect(daemon).toContain(
      'import { ToolCatalog, type RegisteredTool } from "@crewhaus/tool-catalog";',
    );
  });

  test("mcp-free crews keep the daemon byte-identical (no host, no disconnect)", () => {
    const daemon = emitCrew(minimalIr).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).not.toContain("McpHost");
    expect(daemon).not.toContain("disconnectAll");
    expect(daemon).not.toContain("extraTools:");
  });
});

describe("emitCrew — limits / budget / hooks (loop contract 0.4)", () => {
  test("limits.crew maps onto the orchestrator caps; loop ceilings ride RunOptions.limits", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      limits: {
        maxToolIterations: 12,
        maxConcurrentTools: 2,
        contextLimit: 100000,
        deadlineMs: 600000,
        turnTimeoutMs: 120000,
        modelCallTimeoutMs: 60000,
        loopDetection: { window: 6, threshold: 3, escalation: "abort" },
        crew: { maxActivations: 24, refusalDepth: 4, maxA2aDepth: 5 },
      },
    };
    const daemon = emitCrew(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain("maxActivations: 24,");
    expect(daemon).toContain("refusalDepth: 4,");
    expect(daemon).toContain("maxA2ADepth: 5,");
    expect(daemon).toContain(
      'limits: {"maxToolIterations":12,"maxConcurrentTools":2,"contextLimit":100000,"deadlineMs":600000,"turnTimeoutMs":120000,"modelCallTimeoutMs":60000,"loopDetection":{"window":6,"threshold":3,"escalation":"abort"}},',
    );
  });

  test("partial limits render only the declared knobs", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      limits: { maxToolIterations: 3, crew: { refusalDepth: 1 } },
    };
    const daemon = emitCrew(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain('limits: {"maxToolIterations":3},');
    expect(daemon).toContain("refusalDepth: 1,");
    expect(daemon).not.toContain("maxActivations:");
    expect(daemon).not.toContain("maxA2ADepth:");
    expect(daemon).not.toContain("deadlineMs");
  });

  test("a crew-caps-only limits block renders no RunOptions.limits field", () => {
    const ir: IrCrewV0 = { ...minimalIr, limits: { crew: { maxActivations: 8 } } };
    const daemon = emitCrew(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain("maxActivations: 8,");
    expect(daemon).not.toContain("limits:");
  });

  test("budget and hooks land on crew.run options; omission stays byte-identical", () => {
    const ir: IrCrewV0 = {
      ...minimalIr,
      budget: { usdMicros: 5000000, onExceed: { kind: "stop" } },
      hooks: [
        { event: "session-start", command: "echo hi" },
        { event: "pre-tool", matcher: "Read", command: "echo pre", timeoutMs: 5000 },
      ],
    };
    const daemon = emitCrew(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain('budget: {"usdMicros":5000000,"onExceed":{"kind":"stop"}},');
    expect(daemon).toContain(
      'hooks: [{"event":"session-start","command":"echo hi"},{"event":"pre-tool","matcher":"Read","command":"echo pre","timeoutMs":5000}],',
    );

    const bare = emitCrew(minimalIr).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(bare).not.toContain("budget:");
    expect(bare).not.toContain("hooks:");
    expect(bare).not.toContain("limits:");
    expect(bare).not.toContain("maxActivations:");
  });
});

describe("emitCrew — headless ask parking (loop contract 0.4, G11)", () => {
  const daemonOf = (ir: IrCrewV0): string =>
    emitCrew(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";

  test("daemon builds the park store and threads askMode + approvals into crew.run", () => {
    // `minimalIr` declares NO mode and NO rules, so renderPermissionsField
    // emits nothing at all — the bundle where every unmatched tool resolves to
    // `ask` and parking matters most. The approval fields must survive that.
    const daemon = daemonOf(minimalIr);
    expect(daemon).not.toContain("permissionMode");
    expect(daemon).toContain(
      'import { createPendingApprovalStore, resolveSessionRootDir } from "@crewhaus/runtime-core";',
    );
    expect(daemon).toContain("const __approvalRoot = resolveSessionRootDir(undefined);");
    expect(daemon).toContain("const __approvals = createPendingApprovalStore(");
    expect(daemon).toContain('askMode: "pause",');
    expect(daemon).toContain('approvals: { store: __approvals, surface: "crew" },');
  });

  test("ask_mode: deny is fixed at emit time — and still gets the store", () => {
    const daemon = daemonOf({
      ...minimalIr,
      permissions: { ...minimalIr.permissions, askMode: "deny" },
    });
    expect(daemon).toContain('askMode: "deny",');
    // The store rides along under deny too: runtime-core branches its denial
    // wording on `approvals === undefined`, so withholding it would make a
    // deliberate operator choice read as missing plumbing.
    expect(daemon).toContain('approvals: { store: __approvals, surface: "crew" },');
  });

  test("eval-entry carries the same fields, rooted at the caller's sample dir", () => {
    const evalEntry =
      emitCrew(minimalIr, { evalEntry: true }).files.find((f) => f.path === "eval-entry.ts")
        ?.content ?? "";
    expect(evalEntry).toContain('askMode: "pause",');
    expect(evalEntry).toContain('approvals: { store: __approvals, surface: "crew" },');
    // A parked record embeds the raw tool input, so it must land in the
    // sample's own directory — not the operator's working tree (the same
    // per-sample isolation the memory fabric keeps in this file).
    expect(evalEntry).toContain(
      "const __approvalRoot = resolveSessionRootDir(__evalOpts.sessionRootDir);",
    );
  });
});
