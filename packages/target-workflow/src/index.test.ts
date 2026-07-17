import { describe, expect, test } from "bun:test";
import type { IrWorkflowV0 } from "@crewhaus/ir";
import { TargetEmitError, emitWorkflow } from "./index";

const TWO_STEP_IR: IrWorkflowV0 = {
  version: 0,
  name: "demo",
  target: "workflow",
  steps: [
    {
      name: "list",
      instructions: "list files",
      model: "claude-sonnet-4-6",
      tools: ["bash"],
      toolConfigs: {},
    },
    {
      name: "summarize",
      instructions: "summarize",
      model: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
    },
  ],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
};

describe("emitWorkflow", () => {
  test("emits agent.ts plus the generated README.md (item 42)", () => {
    const bundle = emitWorkflow(TWO_STEP_IR);
    expect(bundle.files).toHaveLength(2);
    expect(bundle.files[0]?.path).toBe("agent.ts");
    expect(bundle.files[1]?.path).toBe("README.md");
    expect(bundle.files[1]?.content).toContain("| Target | `workflow` |");
  });

  test("readme: false restores the single-file bundle (item 42 opt-out)", () => {
    const bundle = emitWorkflow(TWO_STEP_IR, { readme: false });
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("generated agent imports runChatLoop from runtime-core", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).toContain('import { runChatLoop } from "@crewhaus/runtime-core";');
  });

  test("only step 1 reads from stdin", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    const matches = c.match(/await readStdinToEnd\(\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("each step appears in order", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).toContain("// ── Step 1/2: list ──");
    expect(c).toContain("// ── Step 2/2: summarize ──");
    expect(c.indexOf("Step 1/2: list")).toBeLessThan(c.indexOf("Step 2/2: summarize"));
  });

  test("each step calls runChatLoop with singleTurn: true", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    const matches = c.match(/singleTurn: true/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test("priorOutput is threaded between steps", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).toContain("priorOutput = await runChatLoop");
    expect(c).toContain("Output of previous step");
  });

  test("step 1 falls back to a non-empty placeholder when stdin is empty", () => {
    // Anthropic rejects empty user content with a 400; the generated code
    // must fall back to something non-empty.
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).toContain('stdinInput || "begin"');
  });

  test("readStdinToEnd short-circuits when stdin is a TTY (no piped input)", () => {
    // Without this check the for-await loop blocks forever on an
    // interactive terminal — the symptom users hit when they run
    // `bun run run:hello-workflow` without piping anything in.
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).toContain("process.stdin.isTTY");
  });

  test("tools imports are deduped and grouped by package", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [
        {
          name: "a",
          instructions: "i",
          model: "m",
          tools: ["read", "bash"],
          toolConfigs: {},
        },
        {
          name: "b",
          instructions: "i",
          model: "m",
          tools: ["read", "write"], // read appears twice — dedupe expected
          toolConfigs: {},
        },
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain('import { read, write } from "@crewhaus/tool-fs";');
    expect(c).toContain('import { bash } from "@crewhaus/tool-bash";');
    // Standalone "import { read }" should NOT appear (deduped/grouped).
    expect(c).not.toMatch(/import \{ read \} from "@crewhaus\/tool-fs"/);
  });

  test("per-step tools field reflects that step's tools (Section 11 weaves the Skill tool in)", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [
        { name: "a", instructions: "i", model: "m", tools: ["bash"], toolConfigs: {} },
        { name: "b", instructions: "i", model: "m", tools: ["read"], toolConfigs: {} },
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    // Step's spec-declared tools appear in both branches of the
    // skill-tool conditional. The conditional itself is the Section 11
    // weave: when skills are discovered at runtime, __skillTool is the
    // synthetic Skill(name) tool produced by createSkillTool.
    expect(c).toContain("tools: __skillTool ? [bash, __skillTool] : [bash],");
    expect(c).toContain("tools: __skillTool ? [read, __skillTool] : [read],");
  });

  test("steps without tools still emit a Section 11 skill-aware tools field", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [{ name: "a", instructions: "i", model: "m", tools: [], toolConfigs: {} }],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain("tools: __skillTool ? [__skillTool] : [],");
  });

  test("emits Section 11 extension surface (hooks/skills/slash) shared across steps", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).toContain('import { loadHooks } from "@crewhaus/hooks-engine";');
    expect(c).toContain(
      'import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";',
    );
    expect(c).toContain('import { loadCommands } from "@crewhaus/slash-commands";');
    // Discovery happens once at the top of main() and is shared across steps.
    expect(c).toContain("loadHooks({ cwd: __cwd })");
    expect(c).toContain("discoverSkills({ cwd: __cwd })");
    expect(c).toContain("loadCommands({ cwd: __cwd })");
    // Each step threads the shared discovery through runChatLoop.
    const hookFieldMatches = c.match(/hooks: __hooks,/g) ?? [];
    expect(hookFieldMatches.length).toBe(2);
  });

  test("rejects unknown tool names at emit time", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [{ name: "a", instructions: "i", model: "m", tools: ["bogus"], toolConfigs: {} }],
    };
    expect(() => emitWorkflow(ir)).toThrow(TargetEmitError);
    expect(() => emitWorkflow(ir)).toThrow(/unknown tool "bogus"/);
  });

  test("escapes instructions and model strings safely", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [
        {
          name: "tricky",
          instructions: 'has "quotes" and \\backslashes\\',
          model: 'm-"x"',
          tools: [],
          toolConfigs: {},
        },
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain('"has \\"quotes\\" and \\\\backslashes\\\\"');
    expect(c).toContain('"m-\\"x\\""');
  });

  test("uses each step's resolved model verbatim (per-step model overrides)", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [
        { name: "a", instructions: "i", model: "model-a", tools: [], toolConfigs: {} },
        { name: "b", instructions: "i", model: "model-b", tools: [], toolConfigs: {} },
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain('model: "model-a"');
    expect(c).toContain('model: "model-b"');
  });

  test("emits permissionMode and permissionRules when configured", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      permissions: {
        mode: "auto",
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysDeny", pattern: "Bash(rm**)" },
        ],
      },
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain('permissionMode: "auto"');
    expect(c).toContain("permissionRules:");
    expect(c).toContain('{ type: "alwaysAllow", pattern: "Read", source: "yaml" }');
    expect(c).toContain('{ type: "alwaysDeny", pattern: "Bash(rm**)", source: "yaml" }');
    expect(c).toContain('import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";');
  });

  test("omits permissions block when neither mode nor rules are set", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).not.toContain("permissionMode");
    expect(c).not.toContain("permissionRules");
    expect(c).not.toContain("BUILTIN_DEFAULT_RULES");
  });
});

describe("emitWorkflow — failureTaxonomy field (item 23)", () => {
  test("threads failureTaxonomy into every step's runChatLoop call", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      failureTaxonomy: [
        { class: "rate_limited", pattern: "/429|rate.?limit/i", recovery: "retry" },
        { class: "tool_timeout", pattern: "ETIMEDOUT", recovery: "continue", hint: "slow tool" },
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    const matches = c.match(/failureTaxonomy:/g) ?? [];
    expect(matches.length).toBe(2); // one per step
    expect(c).toContain('"recovery":"retry"');
    expect(c).toContain('"pattern":"ETIMEDOUT"');
  });

  test("omits failureTaxonomy when the IR leaves it unset or empty", () => {
    expect(emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
    const empty: IrWorkflowV0 = { ...TWO_STEP_IR, failureTaxonomy: [] };
    expect(emitWorkflow(empty).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
  });
});

describe("emitWorkflow — limits (loop contract 0.4)", () => {
  const LIMITS_IR: IrWorkflowV0 = {
    ...TWO_STEP_IR,
    limits: {
      maxToolIterations: 40,
      maxConcurrentTools: 2,
      contextLimit: 120000,
      deadlineMs: 600000,
      turnTimeoutMs: 90000,
      modelCallTimeoutMs: 30000,
      loopDetection: { window: 40, threshold: 3, escalation: "warn" },
    },
  };

  test("threads the per-call ceilings into EVERY step's runChatLoop call", () => {
    const c = emitWorkflow(LIMITS_IR).files[0]?.content ?? "";
    for (const field of [
      "maxToolIterations: 40,",
      "maxConcurrentTools: 2,",
      "contextLimit: 120000,",
      "turnTimeoutMs: 90000,",
      "modelCallTimeoutMs: 30000,",
      'loopDetection: {"window":40,"threshold":3,"escalation":"warn"},',
    ]) {
      expect(c.split(field).length - 1).toBe(2); // one per step
    }
  });

  test("deadline_ms bounds the WHOLE run: stamped once, guarded before each step", () => {
    const c = emitWorkflow(LIMITS_IR).files[0]?.content ?? "";
    expect(c.match(/const __deadlineAt = Date\.now\(\) \+ 600000;/g) ?? []).toHaveLength(1);
    expect(c.match(/if \(Date\.now\(\) >= __deadlineAt\) \{/g) ?? []).toHaveLength(2);
    // The guard stops with a non-zero exit code via exitCode + return (never
    // process.exit, which would skip the MCP finally teardown).
    expect(c.match(/process\.exitCode = 1;/g) ?? []).toHaveLength(2);
    expect(c).toContain("stopping before step 1/2: list");
    expect(c).toContain("stopping before step 2/2: summarize");
    expect(c).not.toContain("process.exit(1)");
    // The stamp sits at the very top of main(), BEFORE the extension
    // discovery, so hook/skill/slash boot time counts against the ceiling.
    expect(c.indexOf("const __deadlineAt")).toBeLessThan(c.indexOf("loadHooks({ cwd: __cwd })"));
  });

  test("each step's call arms the runtime deadline timer with the REMAINING budget, never the full ceiling", () => {
    const c = emitWorkflow(LIMITS_IR).files[0]?.content ?? "";
    // Passing `deadlineMs: 600000` per call would grant each step the full
    // whole-run ceiling (N steps = N× the budget); the remaining-budget
    // expression keeps the workflow ceiling binding mid-step, and the
    // Math.max floor still arms the timer on a razor-edge remainder.
    const field = "deadlineMs: Math.max(1, __deadlineAt - Date.now()),";
    expect(c.split(field).length - 1).toBe(2); // one per step
    expect(c).not.toContain("deadlineMs: 600000");
  });

  test("partial limits emit only the declared knobs", () => {
    const ir: IrWorkflowV0 = { ...TWO_STEP_IR, limits: { turnTimeoutMs: 5000 } };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c.split("turnTimeoutMs: 5000,").length - 1).toBe(2);
    expect(c).not.toContain("maxToolIterations:");
    expect(c).not.toContain("maxConcurrentTools:");
    expect(c).not.toContain("contextLimit:");
    expect(c).not.toContain("deadlineMs:");
    expect(c).not.toContain("modelCallTimeoutMs:");
    expect(c).not.toContain("loopDetection:");
    expect(c).not.toContain("__deadlineAt");
  });

  test("omits every limits surface when the IR carries no limits block", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    for (const s of [
      "maxToolIterations",
      "maxConcurrentTools",
      "contextLimit",
      "deadlineMs",
      "turnTimeoutMs",
      "modelCallTimeoutMs",
      "loopDetection",
      "__deadlineAt",
      "[limits]",
    ]) {
      expect(c).not.toContain(s);
    }
  });
});

describe("emitWorkflow — per-step thinking + max_tokens (loop contract 0.4)", () => {
  test("each step keeps its own maxTokens/thinking values", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [
        {
          name: "a",
          instructions: "i",
          model: "m",
          maxTokens: 4096,
          thinking: { budgetTokens: 2048 },
          tools: [],
          toolConfigs: {},
        },
        {
          name: "b",
          instructions: "i",
          model: "m",
          thinking: { effort: "high" },
          tools: [],
          toolConfigs: {},
        },
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c.match(/maxTokens: 4096,/g) ?? []).toHaveLength(1);
    expect(c).toContain('thinking: {"budgetTokens":2048},');
    expect(c).toContain('thinking: {"effort":"high"},');
  });

  test("omits maxTokens/thinking when the step leaves them unset", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).not.toContain("maxTokens:");
    expect(c).not.toContain("thinking:");
  });
});

describe("emitWorkflow — budget field (item 27, Batch A shape extension)", () => {
  test("threads the spend cap into every step's call (each step meters its own loop in v0)", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      budget: { usdMicros: 5_000_000, onExceed: { kind: "degrade", model: "cheap-model" } },
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    const field =
      'budget: {"usdMicros":5000000,"onExceed":{"kind":"degrade","model":"cheap-model"}},';
    expect(c.split(field).length - 1).toBe(2);
  });

  test("omits budget when the IR leaves it unset", () => {
    expect(emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "").not.toContain("budget:");
  });
});

describe("emitWorkflow — spec-declared hooks (loop contract 0.4)", () => {
  const HOOKS_IR: IrWorkflowV0 = {
    ...TWO_STEP_IR,
    hooks: [
      { event: "pre-tool", matcher: "bash", command: "./guard.sh", timeoutMs: 3000 },
      { event: "stop", command: "./notify.sh" },
    ],
  };

  test("declares the typed spec-hook const and concats after the discovered hooks", () => {
    const c = emitWorkflow(HOOKS_IR).files[0]?.content ?? "";
    expect(c).toContain('import { type HookDef, loadHooks } from "@crewhaus/hooks-engine";');
    expect(c).toContain(
      'const __specHooks: ReadonlyArray<HookDef> = [{"event":"pre-tool","matcher":"bash","command":"./guard.sh","timeoutMs":3000},{"event":"stop","command":"./notify.sh"}];',
    );
    // Spec hooks layer BELOW the discovered settings.json layers: spec
    // first, then user → project — later-wins keeps the settings layers
    // authoritative (the permission RuleSet's settings-over-yaml
    // precedence; same ordering as target-cli and the run interpreter).
    expect(c).toContain("const __allHooks = [...__specHooks, ...__hooks];");
    expect(c.match(/hooks: __allHooks,/g) ?? []).toHaveLength(2);
    expect(c).not.toContain("hooks: __hooks,");
  });

  test("without spec hooks the discovered-only surface is unchanged", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).toContain('import { loadHooks } from "@crewhaus/hooks-engine";');
    expect(c).not.toContain("HookDef");
    expect(c).not.toContain("__specHooks");
    expect(c.match(/hooks: __hooks,/g) ?? []).toHaveLength(2);
  });

  test("an empty hooks array emits the unchanged discovered-only surface", () => {
    const ir: IrWorkflowV0 = { ...TWO_STEP_IR, hooks: [] };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).not.toContain("__specHooks");
    expect(c.match(/hooks: __hooks,/g) ?? []).toHaveLength(2);
  });
});

describe("emitWorkflow — wire-once MCP servers (G05)", () => {
  // TWO_STEP_IR: step 1 declares tools (bash), step 2 is tool-free.
  const MCP_IR: IrWorkflowV0 = {
    ...TWO_STEP_IR,
    mcp_servers: {
      docs: {
        transport: "stdio",
        command: "bunx",
        args: ["docs-mcp"],
        env: { DOCS_TOKEN: { kind: "env", name: "DOCS_TOKEN" } },
      },
      search: { transport: "sse", url: "https://mcp.example.com/sse" },
    },
  };

  test("boots ONE shared McpHost + catalog before the steps (ignored-note retired)", () => {
    const c = emitWorkflow(MCP_IR).files[0]?.content ?? "";
    expect(c).not.toContain("does not yet wire them up");
    expect(c).toContain('import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";');
    expect(c).toContain('import { ToolCatalog } from "@crewhaus/tool-catalog";');
    expect(c).toContain('import { registerMcpServer } from "@crewhaus/tool-mcp";');
    expect(c.match(/new McpHost\(\)/g) ?? []).toHaveLength(1);
    expect(c).toContain('__mcpHost.addServer("docs", resolveMcpServerConfig(');
    expect(c).toContain('__mcpHost.addServer("search", resolveMcpServerConfig(');
    expect(c.match(/registerMcpServer\(__mcpHost, /g) ?? []).toHaveLength(2);
    expect(c).toContain("const __mcpTools = __mcpCatalog.list();");
    // Registration is observable, mirroring target-cli's boot lines.
    expect(c).toContain("[mcp] registered ");
  });

  test("embeds the UNRESOLVED secret ref so no env value lands in the artifact", () => {
    const c = emitWorkflow(MCP_IR).files[0]?.content ?? "";
    expect(c).toContain('"env":{"DOCS_TOKEN":{"kind":"env","name":"DOCS_TOKEN"}}');
    expect(c).toContain('{ name: "docs" }');
    expect(c).toContain('{ name: "search" }');
  });

  test("steps that declare tools receive the MCP tools; tool-free steps stay tool-free", () => {
    const c = emitWorkflow(MCP_IR).files[0]?.content ?? "";
    expect(c).toContain(
      "tools: __skillTool ? [bash, ...__mcpTools, __skillTool] : [bash, ...__mcpTools],",
    );
    // Step 2 declares no tools — no built-ins AND no MCP tools.
    expect(c).toContain("tools: __skillTool ? [__skillTool] : [],");
  });

  test("the step sequence runs inside try/finally that disconnects the host", () => {
    const c = emitWorkflow(MCP_IR).files[0]?.content ?? "";
    expect(c).toContain("try {");
    expect(c).toContain("} finally {");
    expect(c).toContain("await __mcpHost.disconnectAll();");
    // Step bodies sit inside the try — one extra indent level.
    expect(c).toContain("    // ── Step 1/2: list ──");
    expect(c).toContain("    // ── Step 2/2: summarize ──");
    // Boot precedes the try; disconnect follows the last step.
    expect(c.indexOf("new McpHost()")).toBeLessThan(c.indexOf("try {"));
    expect(c.indexOf("Step 2/2")).toBeLessThan(c.indexOf("disconnectAll"));
  });

  test("a deadline stop inside the try releases the host via finally (return, not exit)", () => {
    const ir: IrWorkflowV0 = { ...MCP_IR, limits: { deadlineMs: 1000 } };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain("return;");
    expect(c).not.toContain("process.exit(1)");
    // Deadline stamps at boot (outside the try); guards run inside it.
    expect(c.indexOf("const __deadlineAt")).toBeLessThan(c.indexOf("try {"));
    expect(c.indexOf("if (Date.now() >= __deadlineAt)")).toBeGreaterThan(c.indexOf("try {"));
  });

  test("servers declared but NO step declares tools: boot is skipped, a note surfaces", () => {
    const ir: IrWorkflowV0 = {
      ...MCP_IR,
      steps: MCP_IR.steps.map((s) => ({ ...s, tools: [] })),
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain("// note: mcp_servers configured but no step declares tools");
    expect(c).not.toContain("McpHost");
    expect(c).not.toContain("__mcpTools");
  });

  test("no MCP servers: no host, no try/finally, no note (byte-stability)", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).not.toContain("McpHost");
    expect(c).not.toContain("__mcpTools");
    expect(c).not.toContain("finally");
    expect(c).not.toContain("note: mcp_servers");
  });
});
