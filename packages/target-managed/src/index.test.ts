import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("emitManaged — builtin tools + tool_config (loop contract 0.4, Batch F, G81)", () => {
  const agentOf = (i: IrManagedV0): string =>
    emitManaged(i).files.find((f) => f.path === "agent.ts")?.content ?? "";

  test("registers spec tools on defaultCatalog at module load and unions them per turn", () => {
    const c = agentOf({ ...ir, tools: ["webSearch", "read"] });
    expect(c).toContain('import { defaultCatalog } from "@crewhaus/tool-catalog";');
    expect(c).toContain('import { read } from "@crewhaus/tool-fs";');
    expect(c).toContain('import { webSearch } from "@crewhaus/tool-web";');
    expect(c).toContain("defaultCatalog.register(webSearch);");
    expect(c).toContain("defaultCatalog.register(read);");
    // No memory fabric on this fixture → the per-turn tool set IS the catalog.
    expect(c).toContain("tools: defaultCatalog.list(),");
  });

  test("applies tool_config inits before the register call (fetch)", () => {
    const c = agentOf({
      ...ir,
      tools: ["fetch"],
      toolConfigs: { fetch: { allowedHosts: ["api.example.com"] } },
    });
    expect(c).toMatch(/import \{ fetch, registerFetchConfig \} from "@crewhaus\/tool-fetch";/);
    expect(c).toContain('registerFetchConfig({"allowedHosts":["api.example.com"]});');
    const initIdx = c.indexOf("registerFetchConfig(");
    const regIdx = c.indexOf("defaultCatalog.register(fetch);");
    expect(initIdx).toBeGreaterThan(-1);
    expect(regIdx).toBeGreaterThan(initIdx);
  });

  test("a shared initSymbol (python/javascript/shell) is emitted exactly once", () => {
    const c = agentOf({
      ...ir,
      tools: ["python", "javascript", "shell"],
      toolConfigs: { codeExecution: { image: "python:3.12" } },
    });
    // The config registrar is CALLED exactly once even though three tools share it.
    expect(c.split("registerCodeExecutionConfig(").length - 1).toBe(1);
    expect(c).toContain('registerCodeExecutionConfig({"image":"python:3.12"});');
    // …and all three tool exports register.
    expect(c).toContain("defaultCatalog.register(python);");
    expect(c).toContain("defaultCatalog.register(javascript);");
    expect(c).toContain("defaultCatalog.register(shell);");
  });

  test("tools union with the per-turn memory tools when the memory fabric is on", () => {
    const c = agentOf({
      ...ir,
      tools: ["webSearch"],
      memory: { enabled: true, wiki: { enabled: true } },
    });
    expect(c).toContain("defaultCatalog.register(webSearch);");
    expect(c).toContain("tools: [...__memTools, ...defaultCatalog.list()],");
  });

  test("an unknown tool throws TargetEmitError naming the offender", () => {
    expect(() => emitManaged({ ...ir, tools: ["nopeTool"] })).toThrow(TargetEmitError);
    try {
      emitManaged({ ...ir, tools: ["nopeTool"] });
    } catch (e) {
      expect((e as Error).message).toContain('unknown tool "nopeTool"');
      expect((e as Error).message).toContain("known tools:");
    }
  });

  test("no tools block → no catalog wiring beyond thredz/knowledge (byte-stable)", () => {
    const c = agentOf(ir);
    expect(c).not.toContain("defaultCatalog.register(");
    expect(c).not.toContain("@crewhaus/tool-fs");
    expect(c).not.toContain("@crewhaus/tool-web");
  });
});

describe("emitManaged — schedule wake loop (loop contract 0.4, Batch F, ITEM 7)", () => {
  const daemonOf = (i: IrManagedV0): string =>
    emitManaged(i).files.find((f) => f.path === "daemon.ts")?.content ?? "";

  test("interval schedule arms a setInterval wake per declared tenant", () => {
    const daemon = daemonOf({ ...ir, schedule: { kind: "interval", everyMs: 3_600_000 } });
    expect(daemon).toContain("async function __fireScheduledWake()");
    expect(daemon).toContain("for (const __tenantId of Object.keys(TENANT_OVERRIDES))");
    expect(daemon).toContain("__scheduleTimer = setInterval(async () => {");
    expect(daemon).toContain("}, 3600000);");
    expect(daemon).toContain('if (process.env.CREWHAUS_SCHEDULE !== "0")');
    // Fresh session per tick + classified error handling keeps the daemon up.
    expect(daemon).toContain('const __sessionId = `sess_${randomBytes(8).toString("hex")}`;');
    expect(daemon).toContain("if (isRunFailedError(__err)) {");
    // The timer is cleared on shutdown (both signals).
    expect(daemon.split("clearInterval(__scheduleTimer)").length - 1).toBe(2);
  });

  test("interval jitter adds a randomized pre-tick delay", () => {
    const daemon = daemonOf({
      ...ir,
      schedule: { kind: "interval", everyMs: 6_000, jitterMs: 500 },
    });
    expect(daemon).toContain("const __jitterMs = Math.floor(Math.random() * 500);");
  });

  test("cron schedule emits the minute-ticker + matcher and carries the expression verbatim", () => {
    const daemon = daemonOf({
      ...ir,
      schedule: { kind: "cron", cron: "0 */6 * * *", timezone: "America/New_York" },
    });
    expect(daemon).toContain("function __cronMatches(expr: string, date: Date): boolean");
    expect(daemon).toContain("function __cronFieldMatches(field: string, value: number): boolean");
    expect(daemon).toContain('const __cronExpr = "0 */6 * * *";');
    expect(daemon).toContain("if (!__cronMatches(__cronExpr, __now)) return;");
    // 30s ticker, deduped to one fire per matching minute.
    expect(daemon).toContain("}, 30_000);");
    expect(daemon).toContain("if (__minuteKey === __lastCronMinute) return;");
  });

  test("the schedule instructions default when the spec omits them, else ride verbatim", () => {
    const dflt = daemonOf({ ...ir, schedule: { kind: "interval", everyMs: 1000 } });
    expect(dflt).toContain("Scheduled wake tick — check for due work and act on it.");
    const custom = daemonOf({
      ...ir,
      schedule: { kind: "interval", everyMs: 1000, instructions: "sweep the outbox" },
    });
    expect(custom).toContain('const __SCHEDULE_INSTRUCTIONS = "sweep the outbox";');
  });

  test("no schedule block → no wake-loop codegen (byte-stable)", () => {
    const daemon = daemonOf(ir);
    expect(daemon).not.toContain("__fireScheduledWake");
    expect(daemon).not.toContain("__scheduleTimer");
    expect(daemon).not.toContain("CREWHAUS_SCHEDULE");
    expect(daemon).not.toContain("__cronMatches");
  });
});

describe("emitManaged — resume-path idempotency (loop contract 0.4, Batch F, ITEM 7)", () => {
  const daemonOf = (i: IrManagedV0): string =>
    emitManaged(i).files.find((f) => f.path === "daemon.ts")?.content ?? "";

  test("runs.continue with a prior sessionId reseats history and dedupes via withIdempotency", () => {
    const daemon = daemonOf(ir);
    expect(daemon).toContain(
      'import {\n  createInMemoryIdempotencyStore,\n  idempotencyKey,\n  withIdempotency,\n} from "@crewhaus/idempotency-keys";',
    );
    expect(daemon).toContain("const RESUME_IDEM_STORE = createInMemoryIdempotencyStore<string>();");
    expect(daemon).toContain(
      'const isResume = method === "runs.continue" && p.sessionId !== undefined;',
    );
    // The resume path passes `resume` into runOneTurn's extraOptions…
    expect(daemon).toContain("...(isResume ? { resume: { sessionId } } : {}),");
    // …and wraps execution in withIdempotency keyed on (tenant, session, input).
    expect(daemon).toContain(
      "const guarded = withIdempotency<undefined, string>(() => executeTurn(), {",
    );
    expect(daemon).toContain("idempotencyKey(`${tenant.id}:${sessionId}:${p.input}`, 0)");
    // runs.create still runs a fresh turn (no idempotency wrap).
    expect(daemon).toContain("reply = await executeTurn();");
  });

  test("the audit sinks + runContext still ride the resume-aware extraOptions", () => {
    const daemon = daemonOf(ir);
    const optIdx = daemon.indexOf("extraOptions: {");
    expect(optIdx).toBeGreaterThan(-1);
    expect(daemon.indexOf("justificationAuditSink: log,")).toBeGreaterThan(optIdx);
    expect(daemon.indexOf("egressAuditSink: log,")).toBeGreaterThan(optIdx);
  });
});

describe("emitManaged — permission wiring for the tools the target installs itself", () => {
  const agentOf = (i: IrManagedV0): string =>
    emitManaged(i).files.find((f) => f.path === "agent.ts")?.content ?? "";

  // What the compiler produces for a managed spec that declares NO
  // `continuity:` block — continuity is default-on, so the memory fabric (and
  // its FocusRead/PlanRead/… tool surface) is wired without the spec asking.
  const withContinuity: IrManagedV0 = {
    ...ir,
    continuity: { plan: true, proof: "ladder", ledger: true, handoff: true, scope: "spec" },
  };

  test("the fabric's own tools are granted, so a spec with no permissions block still works", () => {
    const agent = agentOf(withContinuity);
    // The grant is derived from the very array the fabric registered into —
    // not a hard-coded tool list that can drift from what wireMemory wires.
    expect(agent).toContain("const __memToolRules: PermissionRule[] = __memTools.map((t) => ({");
    expect(agent).toContain('type: "alwaysAllow",');
    expect(agent).toContain("pattern: t.name,");
    expect(agent).toContain("builtin: [...BUILTIN_DEFAULT_RULES, ...__memToolRules],");
    expect(agent).toContain('import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";');
    expect(agent).toContain('import type { PermissionRule } from "@crewhaus/permission-engine";');
    // Declared before the runChatLoop call that consumes it.
    expect(agent.indexOf("const __memToolRules")).toBeLessThan(
      agent.indexOf("return await runChatLoop({"),
    );
  });

  test("the grant covers exactly the tool set handed to the model", () => {
    const agent = agentOf(withContinuity);
    // `tools:` and the rule mapping read the same array, so every tool the
    // model can see has a matching allowance and nothing else is widened.
    expect(agent).toContain("tools: __memTools,");
    expect(agent).toContain("__memTools.map((t) => ({");
  });

  test("the grant sits at the builtin layer so a spec rule overrides it", () => {
    // builtin is the LOWEST-priority source in permission-engine's
    // SOURCE_PRIORITY, so a spec-declared rule on the same tool wins.
    const agent = agentOf({
      ...withContinuity,
      permissions: { rules: [{ type: "alwaysDeny", pattern: "FocusWrite" }] },
    });
    expect(agent).toContain('{ type: "alwaysDeny", pattern: "FocusWrite", source: "yaml" },');
    expect(agent).toContain("builtin: [...BUILTIN_DEFAULT_RULES, ...__memToolRules],");
    expect(agent.indexOf("yaml: [")).toBeLessThan(agent.indexOf("builtin: ["));
  });

  test("spec-declared permissions.mode and permissions.rules reach runChatLoop", () => {
    const agent = agentOf({
      ...ir,
      permissions: {
        mode: "auto",
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysDeny", pattern: "Bash(rm**)" },
        ],
      },
    });
    expect(agent).toContain('permissionMode: "auto",');
    expect(agent).toContain('{ type: "alwaysAllow", pattern: "Read", source: "yaml" },');
    expect(agent).toContain('{ type: "alwaysDeny", pattern: "Bash(rm**)", source: "yaml" },');
  });

  test("spec permissions without a memory fabric never reference __memToolRules", () => {
    // `__memToolRules` only exists inside the fabric block; emitting a
    // reference to it without the fabric would be a ReferenceError at boot.
    const agent = agentOf({
      ...ir,
      permissions: { mode: "default", rules: [{ type: "alwaysAllow", pattern: "Read" }] },
    });
    expect(agent).toContain("builtin: BUILTIN_DEFAULT_RULES,");
    expect(agent).not.toContain("__memToolRules");
  });

  test("no fabric and no permissions block emits no permission wiring at all", () => {
    const agent = agentOf(ir);
    expect(agent).not.toContain("permissionRules");
    expect(agent).not.toContain("permissionMode");
    expect(agent).not.toContain("@crewhaus/permission-engine");
  });

  test("Bun.Transpiler parses the emitted agent.ts with the permission wiring", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    expect(() =>
      t.transformSync(
        agentOf({
          ...withContinuity,
          permissions: { mode: "default", rules: [{ type: "alwaysAllow", pattern: "Read" }] },
        }),
      ),
    ).not.toThrow();
  });
});

describe("emitManaged — the default session id honors session-store's id contract", () => {
  const daemonOf = (i: IrManagedV0): string =>
    emitManaged(i).files.find((f) => f.path === "daemon.ts")?.content ?? "";

  // Verbatim from packages/session-store/src/index.ts (ID_REGEX). session-store
  // is not a dependency of this package, so the contract is restated here; if it
  // ever changes there, this test is the thing that has to move with it.
  const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

  const workDir = mkdtempSync(join(tmpdir(), "crewhaus-managed-sessid-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  /**
   * `runs.create` mints a session id when the caller omits one. Lift that exact
   * expression out of the emitted daemon and RUN it the way a compiled bundle
   * runs it — write it to a file, execute it with the same Bun — rather than
   * asserting on its spelling. The defect this guards against was a perfectly
   * readable base36 expression that produced store-invalid ids ~99.99% of the
   * time; only executing it catches that class.
   */
  function mintDefaultSessionIds(daemon: string, count: number): string[] {
    const match = daemon.match(/\n\s*const sessionId = p\.sessionId \?\? (.+);\n/);
    expect(match).not.toBeNull();
    const expr = (match as RegExpMatchArray)[1];
    const file = join(workDir, "mint.ts");
    writeFileSync(
      file,
      [
        'import { randomBytes } from "node:crypto";',
        "const p: { sessionId?: string } = {};",
        `for (let i = 0; i < ${count}; i += 1) {`,
        `  const sessionId = p.sessionId ?? ${expr};`,
        "  console.log(sessionId);",
        "}",
      ].join("\n"),
    );
    const proc = Bun.spawnSync([process.execPath, file], {
      env: { PATH: process.env["PATH"] ?? "" },
    });
    if (proc.exitCode !== 0) {
      throw new Error(`session-id snippet failed: ${proc.stderr.toString()}`);
    }
    return proc.stdout.toString().trim().split("\n");
  }

  test("every minted default id matches sess_<16 hex>", () => {
    const ids = mintDefaultSessionIds(daemonOf(ir), 500);
    expect(ids).toHaveLength(500);
    const invalid = ids.filter((id) => !SESSION_ID_REGEX.test(id));
    // Report a sample so a regression names the shape it produced.
    expect({ count: invalid.length, sample: invalid.slice(0, 3) }).toEqual({
      count: 0,
      sample: [],
    });
  });

  test("minted ids are distinct — one run must not land on another run's session", () => {
    const ids = mintDefaultSessionIds(daemonOf(ir), 500);
    expect(new Set(ids).size).toBe(500);
  });

  test("the mint uses crypto randomBytes, the same source session-store uses", () => {
    const daemon = daemonOf(ir);
    const importLine = 'import { randomBytes } from "node:crypto";';
    expect(daemon).toContain(importLine);
    expect(daemon).toContain(
      'const sessionId = p.sessionId ?? `sess_${randomBytes(8).toString("hex")}`;',
    );
    // The import has to precede the use or the emitted daemon does not run.
    expect(daemon.indexOf(importLine)).toBeLessThan(
      daemon.indexOf("const sessionId = p.sessionId ??"),
    );
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

describe("emitManaged — thredz emit-wired (Loop contract 0.4, Batch E, G23)", () => {
  // The managed shape has NO mcp_servers field; the compiler's
  // lowerThredzWiredNoMcp resolves ir.thredz + flips memory.backend but
  // synthesizes no server — this emitter synthesizes the stdio server itself.
  const thredzIr: IrManagedV0 = {
    ...ir,
    memory: { enabled: true, backend: "thredz", autoRecall: true, autoCapture: true },
    continuity: { plan: true, proof: "ladder", ledger: true, handoff: true, scope: "spec" },
    thredz: {
      apiKey: { kind: "env", name: "THREDZ_API_KEY" },
      visibility: "private",
      goals: true,
      agentName: "managed-bot",
    },
  };
  const agentOf = (i: IrManagedV0): string =>
    emitManaged(i).files.find((f) => f.path === "agent.ts")?.content ?? "";

  test("agent.ts synthesizes the thredz stdio server and boots connectThredz once at module load", () => {
    const c = agentOf(thredzIr);
    expect(c).toContain('import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";');
    expect(c).toContain('import { connectThredz } from "@crewhaus/memory-service";');
    expect(c).toContain('import { defaultCatalog } from "@crewhaus/tool-catalog";');
    // The synthesized server: version-pinned npx, secret-ref API key, resolved
    // visibility (never left to the server default).
    expect(c).toContain('"args":["-y","thredz-mcp@0.2.0"]');
    expect(c).toContain('"THREDZ_API_KEY":{"kind":"env","name":"THREDZ_API_KEY"}');
    expect(c).toContain('"THREDZ_DEFAULT_VISIBILITY":{"kind":"literal","value":"private"}');
    expect(c).toContain("const __thredzHost = new McpHost();");
    expect(c).toContain("const __thredz = await connectThredz(__thredzHost, defaultCatalog");
    expect(c).toContain('agentName: "managed-bot"');
    // A missing key is a config failure (structured report + coded exit).
    expect(c).toContain("const __report = toFailureReport(__err);");
    // No 0.2.3-style ignored-note comment survives.
    expect(c).not.toContain("thredz configured but ignored");
  });

  test("agent.ts threads the live connection into the per-turn wireMemory call and unions the catalog aliases", () => {
    const c = agentOf(thredzIr);
    expect(c).toContain("thredz: __thredz,");
    // The thredz-backed wiki path returns no local tools; the agent reaches the
    // hosted vocabulary through the bare-name aliases on defaultCatalog.
    expect(c).toContain("tools: [...__memTools, ...defaultCatalog.list()],");
    // The fragment carries the thredz block for the backend flip.
    expect(c).toContain('"thredz":{');
  });

  test("a self-hosted baseUrl rides THREDZ_API_BASE as a literal", () => {
    const c = agentOf({
      ...thredzIr,
      thredz: {
        apiKey: { kind: "env", name: "THREDZ_API_KEY" },
        visibility: "private",
        goals: true,
        agentName: "managed-bot",
        baseUrl: "https://thredz.internal",
      },
    });
    expect(c).toContain('"THREDZ_API_BASE":{"kind":"literal","value":"https://thredz.internal"}');
  });

  test("no thredz block → no McpHost, connectThredz, or defaultCatalog union (byte-stable)", () => {
    const c = agentOf(ir);
    expect(c).not.toContain("connectThredz");
    expect(c).not.toContain("McpHost");
    expect(c).not.toContain("defaultCatalog.list()");
  });
});

describe("emitManaged — memory.embedder curator/fact-store dep (Loop contract 0.4, Batch E)", () => {
  test("memory.embedder constructs the embedder once and threads it as deps.embedder", () => {
    const c =
      emitManaged({
        ...ir,
        memory: { enabled: true, embedder: "mock/deterministic", wiki: { enabled: true } },
      }).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(c).toContain('import { createEmbedder } from "@crewhaus/embedder";');
    expect(c).toContain('const __memEmbedder = createEmbedder({ model: "mock/deterministic" });');
    expect(c).toContain("embedder: __memEmbedder,");
  });

  test("no memory.embedder → no createEmbedder import (byte-stable)", () => {
    const c =
      emitManaged({
        ...ir,
        memory: { enabled: true, wiki: { enabled: true } },
      }).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(c).not.toContain("createEmbedder");
    expect(c).not.toContain("__memEmbedder");
  });
});

describe("emitManaged — knowledge RAG block (Loop contract 0.4, Batch E, G22)", () => {
  const agentOf = (i: IrManagedV0): string =>
    emitManaged(i).files.find((f) => f.path === "agent.ts")?.content ?? "";
  const knowledgeIr: IrManagedV0 = {
    ...ir,
    knowledge: {
      vectorBackend: "in-memory",
      defaultK: 5,
      chunkSize: 400,
      chunkOverlap: 0,
      sources: [{ kind: "path", path: "docs/manual.md" }],
    },
  };

  test("ingests the corpus at module load, registers the tool, and unions defaultCatalog.list()", () => {
    const c = agentOf(knowledgeIr);
    expect(c).toContain(
      'import { knowledgeRetrieve, resolveKnowledgeEmbedder } from "@crewhaus/tool-retrieve";',
    );
    expect(c).toContain('import { defaultCatalog } from "@crewhaus/tool-catalog";');
    expect(c).toContain("const __knowledgeTool = await knowledgeRetrieve({");
    expect(c).toContain('{"kind":"path","path":"docs/manual.md"}');
    expect(c).toContain("defaultCatalog.register(__knowledgeTool);");
    // With no memory fabric on this fixture, tools resolves to the catalog.
    expect(c).toContain("tools: defaultCatalog.list(),");
  });

  test("knowledge + memory fabric unions the per-turn memory tools with the catalog", () => {
    const c = agentOf({
      ...knowledgeIr,
      memory: { enabled: true, embedder: "mock/deterministic" },
    });
    expect(c).toContain("tools: [...__memTools, ...defaultCatalog.list()],");
    // memory.embedder still threads as the fact-store/curator embedder.
    expect(c).toContain('const __memEmbedder = createEmbedder({ model: "mock/deterministic" });');
    expect(c).toContain("embedder: __memEmbedder,");
  });

  test("no knowledge block → no RAG wiring (byte-stable)", () => {
    const c = agentOf(ir);
    expect(c).not.toContain("knowledgeRetrieve");
    expect(c).not.toContain("__knowledgeTool");
  });
});

describe("emitManaged — prompt-cache rotation persistence (Loop contract 0.4, Batch E, G78)", () => {
  const agentOf = (i: IrManagedV0): string =>
    emitManaged(i).files.find((f) => f.path === "agent.ts")?.content ?? "";

  test("constructs a per-spec rotation store and threads the §2.5 read/persist seam", () => {
    const c = agentOf(ir);
    expect(c).toContain(
      'import { createPromptCacheRotationStore } from "@crewhaus/prompt-cache-manager";',
    );
    expect(c).toContain(
      'const __promptCacheStore = createPromptCacheRotationStore({ specName: "hello-managed" });',
    );
    expect(c).toContain("promptCacheLastRotatedAt: await __promptCacheStore.read(),");
    expect(c).toContain(
      "onPromptCacheRotated: (rotatedAt) => __promptCacheStore.write(rotatedAt),",
    );
  });
});
