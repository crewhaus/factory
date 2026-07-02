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
