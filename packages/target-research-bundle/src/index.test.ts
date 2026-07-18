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

describe("emitResearchBundle — mcp_servers wiring (G05, Batch A)", () => {
  const irMcp: IrResearchV0 = {
    ...baseIr,
    mcp_servers: {
      fs: { transport: "stdio", command: "npx", args: ["-y", "fs-server"] },
    },
  };

  test("boots the McpHost ONCE at module load and registers onto defaultCatalog (wire-once)", () => {
    const c = emitResearchBundle(irMcp).files[0]?.content ?? "";
    expect(c).toContain('import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";');
    expect(c).toContain('import { registerMcpServer } from "@crewhaus/tool-mcp";');
    expect(c).toContain("new McpHost();");
    expect(c).toContain('mcpHost.addServer("fs"');
    expect(c).toContain('registerMcpServer(mcpHost, "fs", defaultCatalog');
    // Module-level boot (before runOneBranch is ever defined/called) — every
    // branch's `defaultCatalog.list()` sees the registrations.
    expect(c.indexOf("new McpHost();")).toBeLessThan(c.indexOf("async function runOneBranch"));
  });

  test("secret-ref env values are embedded UNRESOLVED and resolved at boot", () => {
    const ir: IrResearchV0 = {
      ...baseIr,
      mcp_servers: {
        api: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "api-server"],
          env: { API_KEY: { kind: "env", name: "API_KEY" } },
        },
      },
    };
    const c = emitResearchBundle(ir).files[0]?.content ?? "";
    expect(c).toContain('resolveMcpServerConfig({"transport":"stdio"');
    expect(c).toContain('{"kind":"env","name":"API_KEY"}');
  });

  test("disconnects on BOTH exit paths: end of main() and the fatal catch", () => {
    const c = emitResearchBundle(irMcp).files[0]?.content ?? "";
    expect(c.split("await mcpHost.disconnectAll()").length - 1).toBe(2);
    expect(c).toContain("main().catch(async (err) => {");
    expect(c).toContain("await mcpHost.disconnectAll().catch(() => {});");
  });

  test("empty mcp_servers emits zero MCP plumbing (byte-identity guard)", () => {
    const c = emitResearchBundle(baseIr).files[0]?.content ?? "";
    expect(c).not.toContain("McpHost");
    expect(c).not.toContain("registerMcpServer");
    expect(c).toContain("main().catch((err) => {");
  });
});

describe("emitResearchBundle — loop contract 0.4 threading (Batch A)", () => {
  test("agent.max_tokens replaces the 4096 default in each branch's runChatLoop", () => {
    const ir: IrResearchV0 = { ...baseIr, agent: { ...baseIr.agent, maxTokens: 9000 } };
    const c = emitResearchBundle(ir).files[0]?.content ?? "";
    expect(c).toContain("maxTokens: 9000,");
    expect(c).not.toContain("maxTokens: 4096,");
  });

  test("an omitted max_tokens keeps the shape's 4096 default (byte-identity guard)", () => {
    const c = emitResearchBundle(baseIr).files[0]?.content ?? "";
    expect(c).toContain("maxTokens: 4096,");
  });

  test("budget threads into the branch loop (item 27 — per-branch ceiling)", () => {
    const ir: IrResearchV0 = {
      ...baseIr,
      budget: { usdMicros: 2_000_000, onExceed: { kind: "stop" } },
    };
    const c = emitResearchBundle(ir).files[0]?.content ?? "";
    expect(c).toContain('budget: {"usdMicros":2000000,"onExceed":{"kind":"stop"}},');
  });

  test("every declared limits knob threads as its runtime option", () => {
    const ir: IrResearchV0 = {
      ...baseIr,
      limits: {
        maxToolIterations: 30,
        maxConcurrentTools: 3,
        contextLimit: 150_000,
        deadlineMs: 90_000,
        turnTimeoutMs: 45_000,
        modelCallTimeoutMs: 20_000,
        loopDetection: { window: 6, threshold: 3, escalation: "abort" },
      },
    };
    const c = emitResearchBundle(ir).files[0]?.content ?? "";
    expect(c).toContain("maxToolIterations: 30,");
    expect(c).toContain("maxConcurrentTools: 3,");
    expect(c).toContain("contextLimit: 150000,");
    expect(c).toContain("deadlineMs: 90000,");
    expect(c).toContain("turnTimeoutMs: 45000,");
    expect(c).toContain("modelCallTimeoutMs: 20000,");
    expect(c).toContain('loopDetection: {"window":6,"threshold":3,"escalation":"abort"},');
  });

  test("partial limits emits only the declared knobs (runtime owns the defaults)", () => {
    const ir: IrResearchV0 = { ...baseIr, limits: { deadlineMs: 120_000 } };
    const c = emitResearchBundle(ir).files[0]?.content ?? "";
    expect(c).toContain("deadlineMs: 120000,");
    expect(c).not.toContain("maxToolIterations:");
    expect(c).not.toContain("loopDetection:");
  });

  test("no limits block → zero limits codegen (byte-identity guard)", () => {
    const c = emitResearchBundle(baseIr).files[0]?.content ?? "";
    expect(c).not.toContain("maxToolIterations:");
    expect(c).not.toContain("deadlineMs:");
  });

  test("spec hooks land as a SPEC_HOOKS const threaded into the branch loop", () => {
    const ir: IrResearchV0 = {
      ...baseIr,
      hooks: [
        { event: "post-model", command: "audit.sh", timeoutMs: 5000 },
        { event: "pre-tool", matcher: "Source", command: "log.sh" },
      ],
    };
    const c = emitResearchBundle(ir).files[0]?.content ?? "";
    expect(c).toContain('import type { HookDef } from "@crewhaus/hooks-engine";');
    expect(c).toContain("const SPEC_HOOKS: ReadonlyArray<HookDef> = ");
    // Declaration order preserved — hooks run in registration order.
    expect(c).toContain(
      '[{"event":"post-model","command":"audit.sh","timeoutMs":5000},{"event":"pre-tool","matcher":"Source","command":"log.sh"}]',
    );
    expect(c).toContain("hooks: SPEC_HOOKS,");
  });

  test("absent/empty hooks emit nothing (byte-identity guard)", () => {
    expect(emitResearchBundle(baseIr).files[0]?.content ?? "").not.toContain("SPEC_HOOKS");
    const empty: IrResearchV0 = { ...baseIr, hooks: [] };
    expect(emitResearchBundle(empty).files[0]?.content ?? "").not.toContain("SPEC_HOOKS");
  });
});

describe("emitResearchBundle — terminal-failure reporting (0.3.0 Goal 6)", () => {
  test("main().catch renders the structured report and exits with the coded status", () => {
    const content = emitResearchBundle(baseIr).files[0]?.content ?? "";
    expect(content).toContain(
      'import { formatRunFailure, toFailureReport } from "@crewhaus/errors";',
    );
    expect(content).toContain("const __report = toFailureReport(err);");
    expect(content).toContain(
      'process.stderr.write(`${formatRunFailure(__report, { prefix: "[research]" })}\\n`);',
    );
    expect(content).toContain("process.exit(__report.exitCode);");
    // The pre-0.3.0 bare fatal one-liner is gone.
    expect(content).not.toContain("[research] fatal: ${");
  });
});
