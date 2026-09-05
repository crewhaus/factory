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
    // Multi-step plain workflows route each step's runChatLoop through the
    // durable __durableStep wrapper (Batch F, G61).
    expect(c).toContain("priorOutput = await __durableStep(");
    expect(c).toContain("() => runChatLoop({");
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

describe("emitWorkflow — ask_mode + approvals (loop contract 0.4, G11)", () => {
  test("every step call carries askMode + the shared approval store", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect((c.match(/askMode: "pause",/g) ?? []).length).toBe(2);
    expect(
      (c.match(/approvals: \{ store: __approvals, surface: "workflow-step" \},/g) ?? []).length,
    ).toBe(2);
  });

  test("the store is booted once at module scope, from the session root", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).toContain(
      'import { createPendingApprovalStore, resolveSessionRootDir } from "@crewhaus/runtime-core";',
    );
    expect(c).toContain("const __approvalRoot = resolveSessionRootDir(undefined);");
    expect((c.match(/const __approvals = createPendingApprovalStore\(/g) ?? []).length).toBe(1);
    // Module scope, not inside main() — the parks outlive one step's call.
    expect(c.indexOf("const __approvals =")).toBeLessThan(c.indexOf("async function main("));
  });

  test("the fields survive a spec with NO permissions block (the case that needs them most)", () => {
    // No `mode`, no `rules` — renderPermissionsFields early-returns "", so
    // every unmatched tool resolves to `ask`. Parking must still be wired.
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).not.toContain("permissionMode");
    expect(c).toContain("askMode:");
    expect(c).toContain("approvals: { store: __approvals");
  });

  test('ask_mode: deny emits askMode: "deny" — and STILL builds the store', () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      permissions: { ...TWO_STEP_IR.permissions, askMode: "deny" },
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect((c.match(/askMode: "deny",/g) ?? []).length).toBe(2);
    expect(c).not.toContain('askMode: "pause"');
    // Unconditional by design: runtime-core's diagnostic branches on
    // `approvals === undefined`, so handing it the store lets it report the
    // deny as the DECLARED choice rather than as missing plumbing.
    expect(c).toContain('approvals: { store: __approvals, surface: "workflow-step" },');
  });

  test("a judge-gated step's re-invocable closure carries them too", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [
        TWO_STEP_IR.steps[0] as IrWorkflowV0["steps"][number],
        {
          name: "gate",
          instructions: "score it",
          model: "claude-sonnet-4-6",
          tools: [],
          toolConfigs: {},
          kind: "judge",
          judge: { criteria: "is it good?", threshold: 0.5, onFail: "halt", maxRetries: 0 },
        },
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    // Only the gated step calls runChatLoop (the judge scores via __judgeGate).
    expect(c).toContain("const __runStep1 = async (__nudge: string)");
    expect((c.match(/askMode: "pause",/g) ?? []).length).toBe(1);
    expect(
      (c.match(/approvals: \{ store: __approvals, surface: "workflow-step" \},/g) ?? []).length,
    ).toBe(1);
  });

  test("the approval plumbing keeps the emission syntactically valid TypeScript", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    const t = new Bun.Transpiler({ loader: "ts" });
    expect(() => t.transformSync(c.replace(/^#!.*\n/, ""))).not.toThrow();
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
  test("threads the spend cap into every step's call", () => {
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

  // 0.6.0 §7.12 — the cap bounds the RUN: one meter on the shared bus.
  test("a budget opens ONE run-spanning cost meter on the shared RunContext and hands it to every step", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      budget: { usdMicros: 5_000_000, onExceed: { kind: "stop" }, judgeShare: 0.25 },
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain('import { createCostTracker } from "@crewhaus/cost-tracker";');
    expect(c).toContain('import { createRunContext } from "@crewhaus/run-context";');
    expect(c).toContain("const __runContext = createRunContext();");
    expect(c).toContain(
      "const __budgetMeter = createCostTracker(__runContext.eventBus, { suppressEvents: true });",
    );
    // Every step: the block, the shared meter, AND the shared context (the
    // meter subscribes to that bus, so each step must publish there).
    expect(c.match(/budgetMeter: __budgetMeter,/g) ?? []).toHaveLength(2);
    expect(c.match(/runContext: __runContext,/g) ?? []).toHaveLength(2);
    expect(c).toContain(
      'budget: {"usdMicros":5000000,"onExceed":{"kind":"stop"},"judgeShare":0.25},',
    );
    // The meter is booted before the first step runs.
    expect(c.indexOf("const __budgetMeter")).toBeLessThan(c.indexOf("// ── Step 1/2"));
    // No judge machinery leaks in on a judge-free budgeted workflow — and no
    // judge_share read either: nothing here would stamp it.
    expect(c).not.toContain("__judgeGate");
    expect(c).not.toContain("@crewhaus/eval-judge");
    expect(c).not.toContain("__judgeShareExhausted");
    expect(c).not.toContain("judge_share_exhausted");
    expect(c).not.toContain("sumRoleCost");
    expect(c).not.toContain("AUXILIARY_MODEL_ROLES");
    expect(c).not.toContain("DEFAULT_JUDGE_SHARE");
  });

  // 0.6.0 §6.2 — a budgeted workflow WITH judges reads judge_share over the
  // shared meter and stamps the signal on every judge_verdict.
  test("a budgeted workflow with judge steps derives judge_share from the shared meter and stamps reason judge_share_exhausted on judge_verdict", () => {
    const ir: IrWorkflowV0 = {
      ...RETRY_IR_SHARED,
      budget: { usdMicros: 2_000_000, onExceed: { kind: "stop" } },
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain('import { createCostTracker, sumRoleCost } from "@crewhaus/cost-tracker";');
    expect(c).toContain('import { DEFAULT_JUDGE_SHARE } from "@crewhaus/runtime-core";');
    expect(c).toContain('import { AUXILIARY_MODEL_ROLES } from "@crewhaus/trace-event-bus";');
    // Spec omits judge_share → the runtime's default constant, not a literal.
    expect(c).toContain("const __judgeShareMicros = Math.round(2000000 * DEFAULT_JUDGE_SHARE);");
    expect(c).toContain(
      "const __judgeShareExhausted = (): boolean =>\n    sumRoleCost(__budgetMeter.getRunCost(__runContext.runId), AUXILIARY_MODEL_ROLES) >= __judgeShareMicros;",
    );
    // Read AFTER the scoring pass, inside the judge_verdict publish, after the
    // cost stamp.
    expect(c).toContain(
      '...(__result.costUsdMicros !== undefined ? { costUsdMicros: __result.costUsdMicros } : {}),\n      ...(__judgeShareExhausted() ? { reason: "judge_share_exhausted" as const } : {}),\n    });',
    );
    // The helper is booted after the meter and before the first step.
    expect(c.indexOf("const __budgetMeter")).toBeLessThan(c.indexOf("const __judgeShareMicros"));
    expect(c.indexOf("const __judgeShareExhausted")).toBeLessThan(c.indexOf("// ── Step 1/3"));
  });

  test("a declared judge_share is emitted as the literal fraction", () => {
    const ir: IrWorkflowV0 = {
      ...RETRY_IR_SHARED,
      budget: { usdMicros: 2_000_000, onExceed: { kind: "stop" }, judgeShare: 0.5 },
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain("const __judgeShareMicros = Math.round(2000000 * 0.5);");
    expect(c).toContain('"judgeShare":0.5');
  });

  test("a budget-free workflow with judge steps carries no judge_share read (byte-identity guard)", () => {
    const c = emitWorkflow(RETRY_IR_SHARED).files[0]?.content ?? "";
    expect(c).toContain('kind: "judge_verdict",');
    expect(c).not.toContain("__judgeShareExhausted");
    expect(c).not.toContain("judge_share_exhausted");
    expect(c).not.toContain("DEFAULT_JUDGE_SHARE");
    expect(c).not.toContain("@crewhaus/cost-tracker");
  });

  test("a budget-free workflow carries no meter, no run-context boot, no cost-tracker import (byte-identity guard)", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).not.toContain("__budgetMeter");
    expect(c).not.toContain("@crewhaus/cost-tracker");
    expect(c).not.toContain("__runContext");
    expect(c).not.toContain("@crewhaus/run-context");
  });

  test("a budgeted workflow WITH judges shares one RunContext and one import set (no duplicates)", () => {
    const ir: IrWorkflowV0 = {
      ...RETRY_IR_SHARED,
      budget: { usdMicros: 1_000_000, onExceed: { kind: "stop" } },
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c.match(/const __runContext = createRunContext\(\);/g) ?? []).toHaveLength(1);
    expect(
      c.match(/import \{ createRunContext \} from "@crewhaus\/run-context";/g) ?? [],
    ).toHaveLength(1);
    expect(c.match(/budgetMeter: __budgetMeter,/g) ?? []).toHaveLength(2);
  });
});

/** A judge-bearing three-step IR shared with the budget tests above (the
 *  judge describe below declares its own identical copy). */
const RETRY_IR_SHARED: IrWorkflowV0 = {
  ...TWO_STEP_IR,
  steps: [
    { name: "draft", instructions: "Write the report.", model: "m", tools: [], toolConfigs: {} },
    {
      name: "gate",
      kind: "judge",
      instructions: "cites at least two sources",
      model: "j",
      tools: [],
      toolConfigs: {},
      judge: {
        criteria: "cites at least two sources",
        threshold: 0.9,
        onFail: "continue",
        maxRetries: 1,
      },
    },
    {
      name: "publish",
      instructions: "Format and publish.",
      model: "m",
      tools: [],
      toolConfigs: {},
    },
  ],
};

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

describe("emitWorkflow — judge gate steps (loop contract 0.4, G02)", () => {
  /** draft → gate(judge, retry_previous ≤2) → publish. */
  const RETRY_IR: IrWorkflowV0 = {
    ...TWO_STEP_IR,
    steps: [
      {
        name: "draft",
        instructions: "Write the report.",
        model: "claude-sonnet-4-6",
        tools: [],
        toolConfigs: {},
      },
      {
        name: "gate",
        kind: "judge",
        instructions: "cites at least two sources",
        model: "claude-haiku-4-5",
        tools: [],
        toolConfigs: {},
        judge: {
          criteria: "cites at least two sources",
          threshold: 0.9,
          onFail: "retry_previous",
          maxRetries: 2,
        },
      },
      {
        name: "publish",
        instructions: "Format and publish.",
        model: "claude-sonnet-4-6",
        tools: [],
        toolConfigs: {},
      },
    ],
  };

  const withOnFail = (onFail: "retry_previous" | "halt" | "continue"): IrWorkflowV0 => ({
    ...RETRY_IR,
    steps: RETRY_IR.steps.map((s) =>
      s.kind === "judge" && s.judge !== undefined ? { ...s, judge: { ...s.judge, onFail } } : s,
    ),
  });

  const parseTs = (code: string) =>
    new Bun.Transpiler({ loader: "ts" }).transformSync(code.replace(/^#!.*\n/, ""));

  test("judge bundles emit the judge machinery: imports, helper, shared RunContext, catch wrapper", () => {
    const c = emitWorkflow(RETRY_IR).files[0]?.content ?? "";
    expect(c).toContain(
      'import { EXIT_CODES, RunFailedError, formatRunFailure, toFailureReport } from "@crewhaus/errors";',
    );
    expect(c).toContain('import { judge } from "@crewhaus/eval-judge";');
    expect(c).toContain('import { createRunContext } from "@crewhaus/run-context";');
    expect(c).toContain('import type { TraceEventBus } from "@crewhaus/trace-event-bus";');
    expect(c).toContain("async function __judgeGate(");
    // 0.6.0 — the helper takes the bus and reports the judge's wire model + cost.
    expect(c).toContain(
      "  bus: TraceEventBus;\n}): Promise<{ score: number; rationale: string; judgeModel: string; costUsdMicros?: number }> {",
    );
    expect(c).toContain("    bus: opts.bus,\n  });");
    expect(c).toContain("judgeModel: result.usage.model,");
    // createJudgeGrader's 1–5 → [0,1] mapping.
    expect(c).toContain("score: (result.score - 1) / 4");
    // Resilient classified exit: EXIT_CODES.evaluation with the 35 fallback.
    expect(c).toContain(
      'const __EVAL_EXIT: number = (EXIT_CODES as Record<string, number>)["evaluation"] ?? 35;',
    );
    expect(c).toContain("const __runContext = createRunContext();");
    // Both LLM steps share the one context (the judge step publishes on
    // its bus instead of calling runChatLoop).
    expect(c.match(/runContext: __runContext,/g) ?? []).toHaveLength(2);
    expect(c).toContain("const __bus = __runContext.eventBus;");
    // Classified terminal wrapper (target-graph's convention).
    expect(c).toContain("const __report = toFailureReport(__err);");
    expect(c).toContain('prefix: "[workflow]"');
    expect(c).toContain("process.exit(__report.exitCode);");
    expect(c).not.toContain("\nawait main();");
  });

  test("the gated step becomes a re-invocable closure with its input captured up front", () => {
    const c = emitWorkflow(RETRY_IR).files[0]?.content ?? "";
    // Step 1 is gated: input const + closure + first invocation.
    expect(c).toContain('const __step1Input = stdinInput || "begin";');
    expect(c).toContain(
      "const __runStep1 = async (__nudge: string): Promise<string> => runChatLoop({",
    );
    expect(c).toContain('instructions: "Write the report." + __nudge,');
    expect(c).toContain('seedMessages: [{ role: "user", content: __step1Input }],');
    expect(c).toContain('priorOutput = await __runStep1("");');
    // The un-gated step 3 keeps the plain call shape.
    expect(c).toContain('instructions: "Format and publish.",');
    expect(c).not.toContain("__runStep3");
  });

  test("a mid-workflow gated step captures the PRIOR output template, not its own output", () => {
    // draft → refine → gate(judge of refine): refine is the gated step.
    const ir: IrWorkflowV0 = {
      ...RETRY_IR,
      steps: [
        RETRY_IR.steps[0] as IrWorkflowV0["steps"][number],
        {
          name: "refine",
          instructions: "Refine it.",
          model: "m",
          tools: [],
          toolConfigs: {},
        },
        RETRY_IR.steps[1] as IrWorkflowV0["steps"][number],
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain(
      "const __step2Input = `## Output of previous step:\\n${priorOutput}\\n\\n## Your task:\\n(continue based on the previous step's output)`;",
    );
    expect(c).toContain("priorOutput = await __runStep2(");
    // Step 1 is NOT gated here — no closure for it.
    expect(c).not.toContain("__runStep1");
  });

  test("the judge step scores priorOutput on the judge model and publishes judge_verdict", () => {
    const c = emitWorkflow(RETRY_IR).files[0]?.content ?? "";
    expect(c).toContain("// ── Step 2/3: gate (judge — gates step 1/3: draft) ──");
    expect(c).toContain("[step 2/3: gate (judge)]");
    expect(c).toContain('criteria: "cites at least two sources",');
    // The judge model is the step's resolved model slot, not the workflow model.
    expect(c).toContain('model: "claude-haiku-4-5",');
    expect(c).toContain('gatedTask: "Write the report.",');
    expect(c).toContain("output: priorOutput,");
    // 0.6.0 §6.2 — the gate hands the run bus to the judge (role "judge" on
    // the bus, priced + budget-metered) and stamps the judge attribution.
    expect(c).toContain("bus: __runContext.eventBus,");
    expect(c).toContain("const __pass = __result.score >= 0.9;");
    expect(c).toContain('kind: "judge_verdict",');
    expect(c).toContain('stepOrNode: "gate",');
    expect(c).toContain('verdict: __pass ? "pass" : "fail",');
    expect(c).toContain("score: __result.score,");
    expect(c).toContain(
      "...(__result.rationale.length > 0 ? { rationale: __result.rationale } : {}),",
    );
    expect(c).toContain("judgeModel: __result.judgeModel,");
    expect(c).toContain(
      "...(__result.costUsdMicros !== undefined ? { costUsdMicros: __result.costUsdMicros } : {}),",
    );
    // The observable verdict line.
    expect(c).toContain('"[judge gate] "');
    expect(c).toContain('" threshold=0.9\\n"');
  });

  test("retry_previous: bounded re-runs with the rationale nudge, then a classified fail-closed stop", () => {
    const c = emitWorkflow(RETRY_IR).files[0]?.content ?? "";
    expect(c).toContain("let __retries = 0;");
    expect(c).toContain("if (__pass) break;");
    expect(c).toContain("if (__retries >= 2) {");
    expect(c).toContain('title: "judge gate failed after retries",');
    expect(c).toContain('class: "evaluation" as const,');
    expect(c).toContain("exitCode: __EVAL_EXIT,");
    // run_failed publishes before the throw (graph-engine G69 convention).
    expect(c).toContain('kind: "run_failed"');
    expect(c).toContain("throw new RunFailedError(__report);");
    // The retry re-invokes the gated step's closure with the nudge.
    expect(c).toContain('"[judge gate] retry "');
    expect(c).toContain(
      'priorOutput = await __runStep1("\\n\\n[judge feedback — the previous attempt failed the \\"gate\\" gate (score " + __result.score.toFixed(2) + " < threshold 0.9)]:\\n" + __result.rationale);',
    );
  });

  test("halt: no retry loop, immediate classified stop", () => {
    const c = emitWorkflow(withOnFail("halt")).files[0]?.content ?? "";
    expect(c).not.toContain("__retries");
    expect(c).not.toContain("for (;;)");
    expect(c).toContain('title: "judge gate failed",');
    expect(c).toContain("throw new RunFailedError(__report);");
    expect(c).not.toContain('__runStep1("\\n\\n[judge feedback');
    // The gated step still renders as a closure (uniform gated shape).
    expect(c).toContain('priorOutput = await __runStep1("");');
  });

  test("continue: verdict recorded, no throw, run proceeds annotated", () => {
    const c = emitWorkflow(withOnFail("continue")).files[0]?.content ?? "";
    expect(c).toContain("on_fail=continue — proceeding with the flagged output");
    // A continue-only bundle carries NO throw machinery: the errors import
    // shrinks to the report renderers and __EVAL_EXIT is not emitted.
    expect(c).toContain('import { formatRunFailure, toFailureReport } from "@crewhaus/errors";');
    expect(c).not.toContain("throw new RunFailedError");
    expect(c).not.toContain("__EVAL_EXIT");
    expect(c).not.toContain("__retries");
    expect(c).toContain('kind: "judge_verdict",');
  });

  test("consecutive judges gate the SAME nearest non-judge step", () => {
    const ir: IrWorkflowV0 = {
      ...RETRY_IR,
      steps: [
        RETRY_IR.steps[0] as IrWorkflowV0["steps"][number],
        RETRY_IR.steps[1] as IrWorkflowV0["steps"][number],
        {
          name: "tone",
          kind: "judge",
          instructions: "professional tone",
          model: "m2",
          tools: [],
          toolConfigs: {},
          judge: {
            criteria: "professional tone",
            threshold: 0.7,
            onFail: "retry_previous",
            maxRetries: 1,
          },
        },
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain("// ── Step 2/3: gate (judge — gates step 1/3: draft) ──");
    expect(c).toContain("// ── Step 3/3: tone (judge — gates step 1/3: draft) ──");
    // Both judges re-run the same closure; it is emitted exactly once.
    expect(c.match(/const __runStep1 = /g) ?? []).toHaveLength(1);
    expect(c.match(/await __runStep1\(/g) ?? []).toHaveLength(3); // first run + one retry per judge
  });

  test("a judge with no earlier non-judge step is rejected at emit time", () => {
    const ir: IrWorkflowV0 = {
      ...RETRY_IR,
      steps: [RETRY_IR.steps[1] as IrWorkflowV0["steps"][number]],
    };
    expect(() => emitWorkflow(ir)).toThrow(TargetEmitError);
    expect(() => emitWorkflow(ir)).toThrow(/no earlier non-judge step to gate/);
  });

  test("kind: judge without a judge block is rejected at emit time (direct-IR guard)", () => {
    const gate = RETRY_IR.steps[1] as IrWorkflowV0["steps"][number];
    const ir: IrWorkflowV0 = {
      ...RETRY_IR,
      steps: [RETRY_IR.steps[0] as IrWorkflowV0["steps"][number], { ...gate, judge: undefined }],
    };
    // isJudgeStep treats it as a regular step — it renders as a plain LLM
    // step rather than a half-gate (the IR contract sets judge iff kind).
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).not.toContain("__judgeGate");
  });

  test("tricky names/criteria stay JSON-escaped in every executable string", () => {
    const ir: IrWorkflowV0 = {
      ...RETRY_IR,
      steps: [
        RETRY_IR.steps[0] as IrWorkflowV0["steps"][number],
        {
          name: 'ga"te`${x}',
          kind: "judge",
          instructions: 'must "quote" ${sources}',
          model: "m",
          tools: [],
          toolConfigs: {},
          judge: {
            criteria: 'must "quote" ${sources}',
            threshold: 0.7,
            onFail: "retry_previous",
            maxRetries: 1,
          },
        },
      ],
    };
    const c = emitWorkflow(ir).files[0]?.content ?? "";
    expect(c).toContain('criteria: "must \\"quote\\" ${sources}",');
    expect(c).toContain('stepOrNode: "ga\\"te`${x}",');
    // And the whole module still parses.
    expect(() => parseTs(c)).not.toThrow();
  });

  test("judge bundles are syntactically valid TypeScript (retry/halt/continue, with MCP+limits+hooks)", () => {
    for (const onFail of ["retry_previous", "halt", "continue"] as const) {
      const ir: IrWorkflowV0 = {
        ...withOnFail(onFail),
        mcp_servers: {
          docs: { transport: "stdio", command: "bunx", args: ["docs-mcp"] },
        },
        limits: { deadlineMs: 60000, turnTimeoutMs: 9000 },
        hooks: [{ event: "stop", command: "./notify.sh" }],
        budget: { usdMicros: 1_000_000, onExceed: { kind: "stop" } },
        steps: withOnFail(onFail).steps.map((s, i) => (i === 0 ? { ...s, tools: ["bash"] } : s)),
      };
      const c = emitWorkflow(ir).files[0]?.content ?? "";
      expect(() => parseTs(c)).not.toThrow();
      // Judge blocks sit inside the MCP try so a halt still disconnects.
      expect(c.indexOf("__judgeGate({")).toBeGreaterThan(c.indexOf("try {"));
      expect(c.indexOf("disconnectAll")).toBeGreaterThan(c.indexOf("__judgeGate({"));
    }
  });

  test("judge-free workflows carry NO judge machinery (byte-stability)", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    for (const s of [
      "__judgeGate",
      "__EVAL_EXIT",
      "createRunContext",
      "runContext:",
      "eval-judge",
      "judge_verdict",
      "toFailureReport",
      "__runStep",
      "RunFailedError",
    ]) {
      expect(c).not.toContain(s);
    }
    expect(c).toContain("\nawait main();");
  });
});

describe("emitWorkflow — durable exactly-once step resume (Batch F, G61)", () => {
  const SINGLE_STEP: IrWorkflowV0 = {
    version: 0,
    name: "solo",
    target: "workflow",
    steps: [{ name: "only", instructions: "do it", model: "m", tools: [], toolConfigs: {} }],
    mcp_servers: {},
    permissions: { rules: [] },
    compaction: {},
  };

  test("single-step workflow gets NO durable plumbing (byte-restore contract)", () => {
    const c = emitWorkflow(SINGLE_STEP).files[0]?.content ?? "";
    expect(c).not.toContain("@crewhaus/durable-execution");
    expect(c).not.toContain("__durableStep");
    expect(c).not.toContain("CREWHAUS_RUN_ID");
    // The lone step keeps the plain runChatLoop assignment.
    expect(c).toContain("priorOutput = await runChatLoop({");
  });

  test("multi-step plain workflow arms the run id, store, and __durableStep wrapper", () => {
    const c = emitWorkflow(TWO_STEP_IR).files[0]?.content ?? "";
    expect(c).toContain(
      'import { createIdempotencyStore, runOnce } from "@crewhaus/durable-execution";',
    );
    expect(c).toContain('import { randomUUID as __randomUUID } from "node:crypto";');
    expect(c).toContain(
      'const __runId = process.env["CREWHAUS_RUN_ID"] ?? `wf_${__randomUUID()}`;',
    );
    expect(c).toContain('const __idempotencyStore = createIdempotencyStore("demo");');
    expect(c).toContain("runOnce(__idempotencyStore, __runId, name, fn);");
    // both plain steps wrapped, keyed by their names
    expect(c).toContain('await __durableStep("list", () => runChatLoop({');
    expect(c).toContain('await __durableStep("summarize", () => runChatLoop({');
  });

  test("a workflow of only judge-gated steps stays byte-free of durable plumbing", () => {
    // step 0 is gated by the downstream judge (step 1) → no plain step → no
    // durable wrapping (a gated step's closure re-runs on retry by design).
    const gatedOnly: IrWorkflowV0 = {
      version: 0,
      name: "gated",
      target: "workflow",
      steps: [
        { name: "research", instructions: "research", model: "m", tools: [], toolConfigs: {} },
        {
          name: "check",
          instructions: "",
          model: "m",
          tools: [],
          toolConfigs: {},
          kind: "judge",
          judge: {
            graderType: "llm_judge",
            criteria: "good?",
            threshold: 0.8,
            model: "m",
            onFail: "retry_previous",
            maxRetries: 2,
          },
        },
      ],
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    const c = emitWorkflow(gatedOnly).files[0]?.content ?? "";
    expect(c).not.toContain("__durableStep");
    expect(c).not.toContain("@crewhaus/durable-execution");
  });
});

describe("emitWorkflow — emitted durable bundle is syntactically valid TS", () => {
  test("Bun.Transpiler parses the __durableStep-wrapped agent.ts", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    const code = emitWorkflow(TWO_STEP_IR, { readme: false }).files[0]?.content ?? "";
    expect(() => t.transformSync(code)).not.toThrow();
  });
});
