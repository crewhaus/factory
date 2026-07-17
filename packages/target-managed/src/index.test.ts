import { describe, expect, test } from "bun:test";
import { CrewhausError } from "@crewhaus/errors";
import type { IrManagedV0 } from "@crewhaus/ir";
import { TargetEmitError, emitManaged } from "./index";

const ir: IrManagedV0 = {
  version: 0,
  name: "hello-managed",
  target: "managed",
  agent: {
    model: "claude-sonnet-4-6",
    instructions: "You are a managed-daemon agent.",
  },
  tenants: [
    {
      id: "tenant-a",
      budget: { maxInputTokens: 100_000, maxOutputTokens: 20_000 },
    },
    {
      id: "tenant-b",
      budget: { maxInputTokens: 50_000, maxOutputTokens: 10_000 },
    },
  ],
  permissions: { rules: [] },
  compaction: {},
};

describe("emitManaged", () => {
  test("returns agent.ts + daemon.ts + the generated README.md (item 42)", () => {
    const bundle = emitManaged(ir);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "agent.ts", "daemon.ts"]);
  });

  test("readme: false restores the two-file bundle (item 42 opt-out)", () => {
    const bundle = emitManaged(ir, { readme: false });
    expect(bundle.files.map((f) => f.path).sort()).toEqual(["agent.ts", "daemon.ts"]);
  });

  test("daemon.ts wires gateway-server with JWT secret env check", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content).toContain("CREWHAUS_GATEWAY_JWT_SECRET");
    expect(daemon?.content).toContain("createGatewayServer");
    expect(daemon?.content).toContain("Refusing to start");
  });

  test("daemon.ts emits per-tenant overrides for both tenants", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content).toContain('"tenant-a"');
    expect(daemon?.content).toContain('"tenant-b"');
    expect(daemon?.content).toContain("100000");
    expect(daemon?.content).toContain("50000");
  });

  test("daemon.ts wires graceful SIGTERM/SIGINT handlers", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content).toContain("SIGTERM");
    expect(daemon?.content).toContain("SIGINT");
  });

  test("daemon.ts wires a pluggable budget store into the gateway (ops #36)", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain('import { createBudgetStore } from "@crewhaus/durable-state"');
    expect(daemon).toContain("CREWHAUS_BUDGET_STORE");
    expect(daemon).toContain('createBudgetStore(process.env.CREWHAUS_BUDGET_STORE ?? "memory")');
    // The SAME store instance must reach the gateway (budget enforcement)
    // and the janitor (crash-leaked reservation cleanup).
    expect(daemon).toContain("budgetStore: BUDGET_STORE");
  });

  test("daemon.ts boots the self-heal janitor with tenant session roots (ops #36)", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain('import { createJanitor } from "@crewhaus/runtime-core"');
    expect(daemon).toContain("createJanitor({");
    expect(daemon).toContain("budgetStore: BUDGET_STORE");
    expect(daemon).toContain(
      "sessionRootDirs: Object.values(tenantOverrides).map((t) => t.sessionRoot)",
    );
    // Boot-time runOnce, env kill-switch, and configurable hourly interval.
    expect(daemon).toContain('process.env.CREWHAUS_JANITOR !== "0"');
    expect(daemon).toContain("await janitor.runOnce()");
    expect(daemon).toContain(
      "janitor.start(Number(process.env.CREWHAUS_JANITOR_INTERVAL_MS ?? 3_600_000))",
    );
    // Both signal handlers halt the interval.
    expect(daemon.split("janitor.stop();").length - 1).toBe(2);
  });

  test("daemon.ts janitor honors .crewhaus/retention.json (ops-review F2)", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    // The SAME loader the retention CLI uses, so the two paths cannot drift.
    expect(daemon).toContain(
      'import { loadRetentionConfig } from "@crewhaus/data-retention-engine"',
    );
    expect(daemon).toContain("await loadRetentionConfig(process.cwd())");
    expect(daemon).toContain("sessionTtlDays: RETENTION_TTL_DAYS");
    expect(daemon).toContain("pinnedSessionIds: RETENTION_PINS");
    // A malformed config fails safe: eviction disabled, daemon keeps serving.
    expect(daemon).toContain("RETENTION_TTL_DAYS = Number.POSITIVE_INFINITY");
    expect(daemon).toContain("janitor session eviction disabled");
  });

  test("daemon.ts janitor sweeps fallback tenants via TENANTS_ROOT (ops-review F6)", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    // gateway-server's buildTenant fallback serves arbitrary authenticated
    // tenants — the janitor must re-enumerate the parent of all tenant roots,
    // not just the spec-declared overrides.
    expect(daemon).toContain("tenantsRootDir: TENANTS_ROOT");
  });

  test("daemon.ts reservation clear is boot-only with a multi-writer opt-out (ops-review F3)", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    // CREWHAUS_JANITOR_CLEAR_RESERVATIONS=0 must remove the budget store from
    // the janitor entirely (no clear ever happens).
    expect(daemon).toContain('process.env.CREWHAUS_JANITOR_CLEAR_RESERVATIONS !== "0"');
    expect(daemon).toContain("? { budgetStore: BUDGET_STORE }");
    // The comments must not oversell multi-writer sqlite sharing: boot-clear
    // is scoped to single-writer deployments by durable-state's contract.
    expect(daemon).toContain("SINGLE-writer");
    expect(daemon).toContain("CREWHAUS_JANITOR_CLEAR_RESERVATIONS=0");
  });

  test("agent.ts has runOneTurn signature with tenantId + sessionId + input", () => {
    const bundle = emitManaged(ir);
    const agent = bundle.files.find((f) => f.path === "agent.ts");
    expect(agent?.content).toContain("runOneTurn");
    expect(agent?.content).toContain("tenantId");
    expect(agent?.content).toContain("sessionId");
  });

  test("includes the standard generated header in every code file", () => {
    const bundle = emitManaged(ir);
    for (const f of bundle.files.filter((x) => x.path.endsWith(".ts"))) {
      expect(f.content).toContain("DO NOT EDIT");
    }
    // The README carries its own generation marker instead.
    const readme = bundle.files.find((f) => f.path === "README.md");
    expect(readme?.content).toContain("Generated by CrewHaus");
  });
});

describe("TargetEmitError", () => {
  test("is a compiler-coded CrewhausError carrying message and cause", () => {
    const cause = new Error("underlying");
    const err = new TargetEmitError("emit failed", cause);
    expect(err).toBeInstanceOf(TargetEmitError);
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.name).toBe("TargetEmitError");
    expect(err.code).toBe("compiler");
    expect(err.message).toBe("emit failed");
    expect(err.cause).toBe(cause);
  });

  test("constructs without a cause", () => {
    const err = new TargetEmitError("emit failed");
    expect(err.name).toBe("TargetEmitError");
    expect(err.code).toBe("compiler");
    expect(err.cause).toBeUndefined();
    // Serializes through the CrewhausError contract.
    expect(err.toJSON()).toEqual({
      name: "TargetEmitError",
      code: "compiler",
      message: "emit failed",
      cause: undefined,
    });
  });
});

describe("emitManaged — provider failover chain (item 22)", () => {
  test("agent.ts threads modelFallbacks + circuitBreaker into runChatLoop when set", () => {
    const irFailover: IrManagedV0 = {
      ...ir,
      agent: {
        ...ir.agent,
        modelFallbacks: ["openai/gpt-4o-mini"],
        circuitBreaker: { cooldownMs: 5000 },
      },
    };
    const agentTs = emitManaged(irFailover).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain('modelFallbacks: ["openai/gpt-4o-mini"],');
    expect(agentTs).toContain('circuitBreaker: {"cooldownMs":5000},');
  });

  test("agent.ts omits both fields when the IR leaves them unset", () => {
    const agentTs = emitManaged(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).not.toContain("modelFallbacks:");
    expect(agentTs).not.toContain("circuitBreaker:");
  });
});

describe("emitManaged — run-level budget field (item 27)", () => {
  test("agent.ts threads budget into runChatLoop when set", () => {
    const irBudget: IrManagedV0 = {
      ...ir,
      budget: { usdMicros: 4_000_000, onExceed: { kind: "degrade", model: "openai/gpt-4o-mini" } },
    };
    const agentTs = emitManaged(irBudget).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain('budget: {"usdMicros":4000000');
    expect(agentTs).toContain('"model":"openai/gpt-4o-mini"');
  });

  test("agent.ts omits budget when the IR leaves it unset", () => {
    const agentTs = emitManaged(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).not.toContain("budget:");
  });
});

describe("emitManaged — SLO wiring (ops item 37)", () => {
  const sloIr: IrManagedV0 = {
    ...ir,
    observability: {
      slo: { ttftMs: 1400, windowMs: 300_000, mitigation: ["alert", "pause-intake"] },
    },
  };

  test("daemon.ts wires the durable intake gate into gateway admission (F3 reader)", () => {
    const daemon = emitManaged(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    // The reader is unconditional — an operator/monitor can pause a running
    // daemon even for a spec without a declared SLO block.
    expect(daemon).toContain("intakeGate: readIntakeGate");
    expect(daemon).toContain(".crewhaus/slo/intake.json");
    expect(daemon).toContain("function readIntakeGate");
    expect(daemon).toContain('import { readFileSync } from "node:fs"');
  });

  test("agent.ts threads sloTargets into runChatLoop when the spec declares SLO (F4)", () => {
    const agentTs = emitManaged(sloIr).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain("sloTargets:");
    expect(agentTs).toContain('"ttftMs":1400');
    expect(agentTs).toContain('"mitigation":["alert","pause-intake"]');
  });

  test("agent.ts omits sloTargets when the spec has no observability block", () => {
    const agentTs = emitManaged(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).not.toContain("sloTargets:");
  });
});

describe("emitManaged — terminal-failure reporting (0.3.0 Goal 6)", () => {
  test("daemon renders a classified report on stderr and rethrows — the daemon keeps serving", () => {
    const daemon = emitManaged(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain(
      'import { formatRunFailure, isRunFailedError } from "@crewhaus/errors";',
    );
    // runOneTurn is wrapped: classified failures print the report…
    expect(daemon).toContain("if (isRunFailedError(err)) {");
    expect(daemon).toContain(
      'process.stderr.write(`${formatRunFailure(err.report, { prefix: "[managed]" })}\\n`);',
    );
    // …then rethrow to the gateway (error response, not process death).
    expect(daemon).toContain("throw err;");
    const catchIdx = daemon.indexOf("if (isRunFailedError(err)) {");
    const rethrowIdx = daemon.indexOf("throw err;", catchIdx);
    expect(rethrowIdx).toBeGreaterThan(catchIdx);
    // No process.exit rides in that catch block.
    expect(daemon.slice(catchIdx, rethrowIdx)).not.toContain("process.exit");
  });
});

describe("emitManaged — agent loop knobs (loop contract 0.4, Batch A)", () => {
  test("agent.ts threads maxTokens into runChatLoop when set", () => {
    const irMax: IrManagedV0 = { ...ir, agent: { ...ir.agent, maxTokens: 4096 } };
    const agentTs = emitManaged(irMax).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain("maxTokens: 4096,");
  });

  test("agent.ts threads the budget-tokens thinking form verbatim", () => {
    const irThink: IrManagedV0 = {
      ...ir,
      agent: { ...ir.agent, thinking: { budgetTokens: 8192 } },
    };
    const agentTs = emitManaged(irThink).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain('thinking: {"budgetTokens":8192},');
  });

  test("agent.ts threads the effort thinking form verbatim", () => {
    const irThink: IrManagedV0 = { ...ir, agent: { ...ir.agent, thinking: { effort: "high" } } };
    const agentTs = emitManaged(irThink).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain('thinking: {"effort":"high"},');
  });

  test("agent.ts threads per-tool rateLimits including the catch-all bucket", () => {
    const irRate: IrManagedV0 = {
      ...ir,
      agent: {
        ...ir.agent,
        rateLimits: { web_search: { rpm: 30, burst: 5 }, "*": { rpm: 120 } },
      },
    };
    const agentTs = emitManaged(irRate).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain('rateLimits: {"web_search":{"rpm":30,"burst":5},"*":{"rpm":120}},');
  });

  test("agent.ts omits all three knobs when the IR leaves them unset", () => {
    const agentTs = emitManaged(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).not.toContain("maxTokens:");
    expect(agentTs).not.toContain("thinking:");
    expect(agentTs).not.toContain("rateLimits:");
  });
});

describe("emitManaged — hard runtime ceilings (limits, loop contract 0.4)", () => {
  const limitsIr: IrManagedV0 = {
    ...ir,
    limits: {
      maxToolIterations: 40,
      maxConcurrentTools: 4,
      contextLimit: 150_000,
      deadlineMs: 600_000,
      turnTimeoutMs: 120_000,
      modelCallTimeoutMs: 90_000,
      loopDetection: { window: 6, threshold: 3, escalation: "justify" },
    },
  };

  test("agent.ts threads every declared ceiling as a flat runChatLoop field", () => {
    const agentTs = emitManaged(limitsIr).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain("maxToolIterations: 40,");
    expect(agentTs).toContain("maxConcurrentTools: 4,");
    expect(agentTs).toContain("contextLimit: 150000,");
    expect(agentTs).toContain("deadlineMs: 600000,");
    expect(agentTs).toContain("turnTimeoutMs: 120000,");
    expect(agentTs).toContain("modelCallTimeoutMs: 90000,");
    expect(agentTs).toContain('loopDetection: {"window":6,"threshold":3,"escalation":"justify"},');
  });

  test("a partial limits block emits ONLY the declared knobs — the runtime owns defaults", () => {
    const partialIr: IrManagedV0 = { ...ir, limits: { maxToolIterations: 25 } };
    const agentTs = emitManaged(partialIr).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain("maxToolIterations: 25,");
    expect(agentTs).not.toContain("maxConcurrentTools:");
    expect(agentTs).not.toContain("contextLimit:");
    expect(agentTs).not.toContain("deadlineMs:");
    expect(agentTs).not.toContain("turnTimeoutMs:");
    expect(agentTs).not.toContain("modelCallTimeoutMs:");
    expect(agentTs).not.toContain("loopDetection:");
  });

  test("agent.ts omits every ceiling when the IR has no limits block", () => {
    const agentTs = emitManaged(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).not.toContain("maxToolIterations:");
    expect(agentTs).not.toContain("maxConcurrentTools:");
    expect(agentTs).not.toContain("contextLimit:");
    expect(agentTs).not.toContain("deadlineMs:");
    expect(agentTs).not.toContain("turnTimeoutMs:");
    expect(agentTs).not.toContain("modelCallTimeoutMs:");
    expect(agentTs).not.toContain("loopDetection:");
  });
});

describe("emitManaged — spec-declared lifecycle hooks (loop contract 0.4)", () => {
  test("agent.ts threads hooks as a HookDef[] literal in declaration order", () => {
    const hooksIr: IrManagedV0 = {
      ...ir,
      hooks: [
        { event: "pre-tool", matcher: "bash", command: "./guard.sh", timeoutMs: 5000 },
        { event: "stop", command: "./notify.sh" },
      ],
    };
    const agentTs = emitManaged(hooksIr).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain(
      'hooks: [{"event":"pre-tool","matcher":"bash","command":"./guard.sh","timeoutMs":5000},{"event":"stop","command":"./notify.sh"}],',
    );
    // Declaration order is semantics — pre-tool must precede stop.
    expect(agentTs.indexOf('"event":"pre-tool"')).toBeLessThan(agentTs.indexOf('"event":"stop"'));
  });

  test("agent.ts omits the hooks field when the IR carries none (absent or empty)", () => {
    const agentTs = emitManaged(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).not.toContain("hooks:");
    const emptyIr: IrManagedV0 = { ...ir, hooks: [] };
    const emptyAgent = emitManaged(emptyIr).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(emptyAgent).not.toContain("hooks:");
  });
});

describe("emitManaged — run budget vs per-tenant budgets (loop contract 0.4)", () => {
  test("top-level budget threads into runChatLoop while per-tenant gateway budgets keep overriding", () => {
    const irBoth: IrManagedV0 = {
      ...ir,
      budget: { usdMicros: 2_500_000, onExceed: { kind: "abort" } },
    };
    const bundle = emitManaged(irBoth);
    const agentTs = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    // Run-level spend cap rides runChatLoop in agent.ts…
    expect(agentTs).toContain('budget: {"usdMicros":2500000');
    // …while the per-tenant token budgets stay in the daemon's TENANT_OVERRIDES
    // and continue to gate admission at the gateway, unchanged.
    expect(daemon).toContain("budget: { maxInputTokens: 100000, maxOutputTokens: 20000 }");
    expect(daemon).toContain("budget: { maxInputTokens: 50000, maxOutputTokens: 10000 }");
    expect(daemon).toContain("budgetStore: BUDGET_STORE");
  });
});

describe("emitManaged — dream janitor step (v0.3.0 PR 14, §6.3)", () => {
  const dreamIr: IrManagedV0 = {
    ...ir,
    memory: { dream: { everyMs: 86_400_000, mode: "full", budgetUsd: 0.5 } },
  };

  test("registers a per-tenant deterministic dream step into the janitor", () => {
    const daemon = emitManaged(dreamIr).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).toContain('import { createDreamJanitorStep } from "@crewhaus/memory-service";');
    expect(daemon).toContain("const DREAM_STEP = createDreamJanitorStep(");
    expect(daemon).toContain("tenantsRootDir: TENANTS_ROOT,");
    expect(daemon).toContain("steps: DREAM_STEP !== null ? [DREAM_STEP] : [],");
    // The multi-tenant janitor never fires the model phase — the emitted
    // deps carry NO modelPhase and the block says why.
    expect(daemon).not.toContain("modelPhase");
    expect(daemon).toContain("per-tenant `crewhaus dream run` cron");
  });

  test("the embedded fragment carries the dream schedule", () => {
    const daemon = emitManaged(dreamIr).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    const match = daemon.match(/createDreamJanitorStep\((\{.*?\}), \{/);
    const fragment = JSON.parse(match?.[1] ?? "{}") as {
      memory?: { dream?: { everyMs: number; mode: string; budgetUsd?: number } };
    };
    expect(fragment.memory?.dream).toEqual({ everyMs: 86_400_000, mode: "full", budgetUsd: 0.5 });
  });

  test("no dream schedule → zero dream codegen", () => {
    const daemon = emitManaged(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(daemon).not.toContain("createDreamJanitorStep");
    expect(daemon).not.toContain("DREAM_STEP");
  });
});

describe("emitManaged — evaluation block (loop contract 0.4, Batch B, G02)", () => {
  const agentContent = (overrides: Partial<IrManagedV0>): string =>
    emitManaged({ ...ir, ...overrides }).files.find((f) => f.path === "agent.ts")?.content ?? "";

  test("llm_judge: agent.ts carries the eval-judge wiring threaded into runOneTurn", () => {
    const agent = agentContent({
      evaluation: {
        grader: {
          type: "llm_judge",
          criteria: "answers cite a source",
          model: "claude-haiku-4-5",
        },
        threshold: 0.8,
        onFail: "retry",
        maxRetries: 2,
      },
    });
    expect(agent).toContain('import type { RunEvaluation } from "@crewhaus/runtime-core";');
    expect(agent).toContain('import { judge } from "@crewhaus/eval-judge";');
    expect(agent).toContain("const __evaluation: RunEvaluation = {");
    expect(agent).toContain('graderType: "llm_judge",');
    expect(agent).toContain('model: "claude-haiku-4-5",');
    expect(agent).toContain('description: "answers cite a source",');
    expect(agent).toContain("threshold: 0.8,");
    expect(agent).toContain('onFail: "retry",');
    expect(agent).toContain("maxRetries: 2,");
    expect(agent).toContain("evaluate: async ({ finalText }) => {");
    expect(agent).toContain("agentOutput: finalText,");
    expect(agent).toContain("(__verdict.score - 1) / 4");
    expect(agent).toContain("evaluation: __evaluation,");
  });

  test("llm_judge: the judge model defaults to the shape's primary model and the resolved default threshold is honored", () => {
    const agent = agentContent({
      evaluation: {
        grader: { type: "llm_judge", criteria: "be kind" },
        onFail: "retry",
        maxRetries: 1,
      },
    });
    expect(agent).toContain('model: "claude-sonnet-4-6",');
    expect(agent).toContain('description: "be kind",');
    expect(agent).toContain("threshold: 0.7,");
  });

  test("contains: emits a pure fn (no eval-judge import; documented threshold 1)", () => {
    const agent = agentContent({
      evaluation: {
        grader: { type: "contains", value: "DONE" },
        onFail: "halt",
        maxRetries: 3,
      },
    });
    expect(agent).not.toContain("@crewhaus/eval-judge");
    expect(agent).toContain('graderType: "contains",');
    expect(agent).toContain("threshold: 1,");
    expect(agent).toContain('finalText.includes("DONE")');
    expect(agent).toContain('onFail: "halt",');
    expect(agent).toContain("evaluation: __evaluation,");
  });

  test("regex: emits a pure fn with a per-call lastIndex reset", () => {
    const agent = agentContent({
      evaluation: {
        grader: { type: "regex", value: "\\d+ items" },
        onFail: "note",
        maxRetries: 1,
      },
    });
    expect(agent).toContain('const __evalRegex = new RegExp("\\\\d+ items");');
    expect(agent).toContain('graderType: "regex",');
    expect(agent).toContain("threshold: 1,");
    expect(agent).toContain("__evalRegex.lastIndex = 0;");
    expect(agent).toContain("__evalRegex.test(finalText)");
    expect(agent).toContain('onFail: "note",');
    expect(agent).toContain("evaluation: __evaluation,");
  });

  test("no evaluation block → no evaluation wiring in any emitted file (byte-identity guard)", () => {
    for (const f of emitManaged(ir).files) {
      expect(f.content).not.toContain("evaluation:");
      expect(f.content).not.toContain("__evaluation");
      expect(f.content).not.toContain("@crewhaus/eval-judge");
    }
  });
});

describe("emitManaged — runs.subscribe per-run bus registry (contract item 3)", () => {
  const daemonOf = (over: Partial<IrManagedV0> = {}): string =>
    emitManaged({ ...ir, ...over }).files.find((f) => f.path === "daemon.ts")?.content ?? "";

  test("daemon imports run-context and holds a tenant-fenced per-run bus registry", () => {
    const daemon = daemonOf();
    expect(daemon).toContain(
      'import { createRunContext, type RunContext } from "@crewhaus/run-context";',
    );
    expect(daemon).toContain(
      'const RUN_BUSES = new Map<string, { tenantId: string; bus: RunContext["eventBus"] }>();',
    );
    expect(daemon).toContain("function registerRunBus(runId: string, tenantId: string,");
    // Bounded so completed runs' buffers don't accumulate forever.
    expect(daemon).toContain("RUN_BUSES.size > RUN_BUS_CAP");
  });

  test("resolveRunEvents fences by tenant and replays-then-live-streams the bus atomically", () => {
    const daemon = daemonOf();
    expect(daemon).toContain("resolveRunEvents: ({ runId, tenant }) => {");
    // Tenant fence: unknown OR cross-tenant runId → undefined → 404.
    expect(daemon).toContain(
      "if (entry === undefined || entry.tenantId !== tenant.id) return undefined;",
    );
    // Atomic snapshot (ring buffer) + live subscribe (no gap between).
    expect(daemon).toContain("const replay = bus.recent();");
    expect(daemon).toContain("const close = bus.subscribe(listener);");
    expect(daemon).toContain("return { replay, close };");
  });

  test("each run mints + registers its bus up front and returns that runId", () => {
    const daemon = daemonOf();
    expect(daemon).toContain("const runId = `run_${Math.random().toString(36).slice(2, 10)}`;");
    expect(daemon).toContain("const runContext = createRunContext({ runId, sessionId });");
    expect(daemon).toContain("registerRunBus(runId, tenant.id, runContext.eventBus);");
    // The response runId is the registered bus's runId (the id a client
    // subscribes with) — not a second, throwaway id.
    expect(daemon).toContain("return { runId, sessionId, tenantId: tenant.id, reply };");
    expect(daemon).not.toContain(
      "return { runId: `run_${Math.random().toString(36).slice(2, 10)}`,",
    );
    // runId is minted BEFORE the run is registered and executed (match the
    // CALL site, not the `function registerRunBus(runId…)` definition).
    const callIdx = daemon.indexOf("registerRunBus(runId, tenant.id,");
    expect(callIdx).toBeGreaterThan(-1);
    expect(daemon.indexOf("const runId = ")).toBeLessThan(callIdx);
    expect(callIdx).toBeLessThan(daemon.indexOf("await runOneTurn("));
  });

  test("the run's trace context is threaded into runOneTurn via extraOptions", () => {
    const daemon = daemonOf();
    expect(daemon).toContain("extraOptions: {");
    expect(daemon).toContain("runContext,");
  });
});

describe("emitManaged — G48 durable justification/egress audit sinks (managed slice)", () => {
  test("the per-tenant hash-chained audit log is wired as both durable sinks", () => {
    const daemon = emitManaged(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    // The SAME `log` used for policy audit is threaded as both sinks, so
    // intent-gate + egress verdicts are tamper-evidenced per tenant.
    expect(daemon).toContain("justificationAuditSink: log,");
    expect(daemon).toContain("egressAuditSink: log,");
    // Both ride the runOneTurn extraOptions (the audit log lives in the daemon,
    // not agent.ts).
    const optIdx = daemon.indexOf("extraOptions: {");
    expect(optIdx).toBeGreaterThan(-1);
    expect(daemon.indexOf("justificationAuditSink: log,")).toBeGreaterThan(optIdx);
    expect(daemon.indexOf("egressAuditSink: log,")).toBeGreaterThan(optIdx);
  });
});

describe("emitManaged — observability block threading (loop contract 0.4, Batch C, G26)", () => {
  const daemonOf = (observability?: IrManagedV0["observability"]): string =>
    emitManaged(observability === undefined ? ir : { ...ir, observability }).files.find(
      (f) => f.path === "daemon.ts",
    )?.content ?? "";

  test("a spec with no observability block gets NO observability env stamping (behavior-stable)", () => {
    const daemon = daemonOf();
    // Threading is gated on a declared block — an observability-silent spec is
    // left byte/behavior-stable (no forced fleet-wide cost tracking).
    expect(daemon).not.toContain("CREWHAUS_COST_TRACKING");
    expect(daemon).not.toContain("apply the spec's `observability` block");
    expect(daemon).not.toContain("CREWHAUS_TRACE");
    expect(daemon).not.toContain("CREWHAUS_METRICS");
    expect(daemon).not.toContain("CREWHAUS_ALERTS");
    expect(daemon).not.toContain("CREWHAUS_INCIDENTS");
    expect(daemon).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });

  test("any declared observability block defaults cost tracking ON (keystone `?? true`)", () => {
    // Even a slo-only or metrics-only block turns cost ON by default…
    for (const obs of [
      { slo: { ttftMs: 1400, mitigation: ["alert"] as const } },
      { metrics: { enabled: true } },
    ] satisfies IrManagedV0["observability"][]) {
      const daemon = daemonOf(obs);
      expect(daemon).toContain('process.env["CREWHAUS_COST_TRACKING"] ??= "1";');
      // …stamped before the gateway is constructed (match the construction, not
      // the `import { createGatewayServer }` line).
      expect(daemon.indexOf("CREWHAUS_COST_TRACKING")).toBeLessThan(
        daemon.indexOf("const gateway = createGatewayServer("),
      );
    }
  });

  test("explicit cost:{enabled:false} in a declared block opts out (explicit off wins)", () => {
    // The block is present (metrics on) so threading runs, but cost is off.
    const daemon = daemonOf({ cost: { enabled: false }, metrics: { enabled: true } });
    expect(daemon).not.toContain("CREWHAUS_COST_TRACKING");
    expect(daemon).toContain('process.env["CREWHAUS_METRICS"] ??= "stdout";');
  });

  test("trace pretty/json attach the printer; ring/off attach none (buffer retained)", () => {
    expect(daemonOf({ trace: { level: "pretty" } })).toContain(
      'process.env["CREWHAUS_TRACE"] ??= "pretty";',
    );
    expect(daemonOf({ trace: { level: "json" } })).toContain(
      'process.env["CREWHAUS_TRACE"] ??= "json";',
    );
    // ring is the default (buffer only, needed for runs.subscribe replay) — no
    // printer env; off degrades to the same (a true buffer-off would break SSE).
    expect(daemonOf({ trace: { level: "ring" } })).not.toContain("CREWHAUS_TRACE");
    expect(daemonOf({ trace: { level: "off" } })).not.toContain("CREWHAUS_TRACE");
  });

  test("metrics / alerts / incidents are opt-in ON when declared", () => {
    expect(daemonOf({ metrics: { enabled: true } })).toContain(
      'process.env["CREWHAUS_METRICS"] ??= "stdout";',
    );
    expect(daemonOf({ alerts: { enabled: true } })).toContain(
      'process.env["CREWHAUS_ALERTS"] ??= "1";',
    );
    expect(daemonOf({ incidents: { enabled: true } })).toContain(
      'process.env["CREWHAUS_INCIDENTS"] ??= "1";',
    );
    // …and stay off when explicitly disabled.
    expect(daemonOf({ metrics: { enabled: false } })).not.toContain("CREWHAUS_METRICS");
  });

  test("otel endpoint is stamped literally, and a $VAR is resolved from env at boot", () => {
    expect(daemonOf({ otel: { endpoint: "http://localhost:4318" } })).toContain(
      'process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??= "http://localhost:4318";',
    );
    const varDaemon = daemonOf({ otel: { endpoint: "$OTLP_URL" } });
    expect(varDaemon).toContain('const __otel = process.env["OTLP_URL"];');
    expect(varDaemon).toContain('process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??= __otel;');
    // A bare `otel: {}` (no endpoint) stamps nothing.
    expect(daemonOf({ otel: {} })).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });

  test("declaring an SLO block activates the monitor env gate (targets ride agent.ts)", () => {
    const bundle = emitManaged({
      ...ir,
      observability: { slo: { ttftMs: 1400, windowMs: 300_000, mitigation: ["alert"] } },
    });
    const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
    const agent = bundle.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(daemon).toContain('process.env["CREWHAUS_SLO"] ??= "1";');
    // The targets themselves still ride agent.ts's runChatLoop call (unchanged).
    expect(agent).toContain("sloTargets:");
    expect(agent).toContain('"ttftMs":1400');
  });
});
