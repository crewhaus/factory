import { describe, expect, test } from "bun:test";
import type { IrResearchV0 } from "@crewhaus/ir";
import { TargetEmitError, emitResearchBundle } from "./index.js";

const baseIr: IrResearchV0 = {
  version: 0,
  name: "hello-research",
  target: "research",
  agent: { model: "claude-haiku-4-5-20251001", instructions: "Be brief." },
  goal: "test goal",
  branchingFactor: 3,
  maxDurationMs: 60_000,
  retrieve: {
    allowedOrigins: ["https://docs.anthropic.com"],
    allowedFileRoots: ["/tmp"],
  },
  tools: [],
  toolConfigs: Object.freeze({}),
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

describe("emitResearchBundle", () => {
  test("emits agent.ts plus the generated README.md (T1 bundle structure, item 42)", () => {
    const bundle = emitResearchBundle(baseIr);
    expect(bundle.files).toHaveLength(2);
    expect(bundle.files[0]?.path).toBe("agent.ts");
    expect(bundle.files[1]?.path).toBe("README.md");
  });

  test("readme: false restores the single-file bundle (item 42 opt-out)", () => {
    const bundle = emitResearchBundle(baseIr, { readme: false });
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("agent.ts wires planner + crawler + citation-tracker + report-writer", () => {
    const bundle = emitResearchBundle(baseIr);
    const code = bundle.files[0]?.content ?? "";
    expect(code).toContain("@crewhaus/planner");
    expect(code).toContain("@crewhaus/crawler");
    expect(code).toContain("@crewhaus/citation-tracker");
    expect(code).toContain("@crewhaus/report-writer");
    expect(code).toContain("createSourceTool");
    expect(code).toContain("createCiteFactTool");
  });

  test("CLI parser handles --goal / --resume / --branching", () => {
    const code = emitResearchBundle(baseIr).files[0]?.content ?? "";
    expect(code).toContain('"--goal"');
    expect(code).toContain('"--resume"');
    expect(code).toContain('"--branching"');
  });

  test("emits run_start / branch_start / branch_end / run_done events", () => {
    const code = emitResearchBundle(baseIr).files[0]?.content ?? "";
    expect(code).toContain('"run_start"');
    expect(code).toContain('"branch_start"');
    expect(code).toContain('"branch_end"');
    expect(code).toContain('"run_done"');
  });

  test("wires alwaysAllow rules for Source + CiteFact at the flag layer", () => {
    const code = emitResearchBundle(baseIr).files[0]?.content ?? "";
    expect(code).toContain('pattern: "Source"');
    expect(code).toContain('pattern: "CiteFact"');
  });

  test("rejects unknown spec-side tool names at compile time", () => {
    const ir: IrResearchV0 = { ...baseIr, tools: ["nonexistent"] };
    expect(() => emitResearchBundle(ir)).toThrow(TargetEmitError);
  });

  test("permissions block: passes spec yaml-source rules through, plus the flag-layer Source/CiteFact allowances", () => {
    const ir: IrResearchV0 = {
      ...baseIr,
      permissions: {
        mode: "default",
        rules: [{ type: "alwaysAllow", pattern: "Read" }],
      },
    };
    const code = emitResearchBundle(ir).files[0]?.content ?? "";
    expect(code).toContain('permissionMode: "default"');
    expect(code).toContain('pattern: "Read"');
    expect(code).toContain('pattern: "Source"');
    expect(code).toContain('pattern: "CiteFact"');
  });

  test("hard-codes ALLOWED_ORIGINS + ALLOWED_FILE_ROOTS so the daemon's crawler is locked to the spec", () => {
    const code = emitResearchBundle(baseIr).files[0]?.content ?? "";
    expect(code).toContain('"https://docs.anthropic.com"');
    expect(code).toContain('"/tmp"');
  });
});

describe("emitResearchBundle — failureTaxonomy field (item 23)", () => {
  test("threads failureTaxonomy into the branch runChatLoop call", () => {
    const ir: IrResearchV0 = {
      ...baseIr,
      failureTaxonomy: [
        { class: "rate_limited", pattern: "/429|rate.?limit/i", recovery: "retry" },
        { class: "tool_timeout", pattern: "ETIMEDOUT", recovery: "continue", hint: "slow tool" },
      ],
    };
    const c = emitResearchBundle(ir).files[0]?.content ?? "";
    expect(c).toContain("failureTaxonomy:");
    expect(c).toContain('"recovery":"retry"');
    expect(c).toContain('"pattern":"ETIMEDOUT"');
  });

  test("omits failureTaxonomy when the IR leaves it unset or empty", () => {
    expect(emitResearchBundle(baseIr).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
    const empty: IrResearchV0 = { ...baseIr, failureTaxonomy: [] };
    expect(emitResearchBundle(empty).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
  });
});
