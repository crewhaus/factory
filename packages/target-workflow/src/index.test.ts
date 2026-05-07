import { describe, expect, test } from "bun:test";
import type { IrWorkflowV0 } from "@crewhaus/ir";
import { TargetEmitError, emitWorkflow } from "./index";

const TWO_STEP_IR: IrWorkflowV0 = {
  version: 0,
  name: "demo",
  target: "workflow",
  steps: [
    { name: "list", instructions: "list files", model: "claude-sonnet-4-6", tools: ["bash"] },
    { name: "summarize", instructions: "summarize", model: "claude-sonnet-4-6", tools: [] },
  ],
  mcp_servers: {},
  permissions: { rules: [] },
};

describe("emitWorkflow", () => {
  test("emits a single-file bundle named agent.ts", () => {
    const bundle = emitWorkflow(TWO_STEP_IR);
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

  test("tools imports are deduped and grouped by package", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [
        {
          name: "a",
          instructions: "i",
          model: "m",
          tools: ["read", "bash"],
        },
        {
          name: "b",
          instructions: "i",
          model: "m",
          tools: ["read", "write"], // read appears twice — dedupe expected
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
        { name: "a", instructions: "i", model: "m", tools: ["bash"] },
        { name: "b", instructions: "i", model: "m", tools: ["read"] },
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
      steps: [{ name: "a", instructions: "i", model: "m", tools: [] }],
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
      steps: [{ name: "a", instructions: "i", model: "m", tools: ["bogus"] }],
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
        { name: "a", instructions: "i", model: "model-a", tools: [] },
        { name: "b", instructions: "i", model: "model-b", tools: [] },
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
