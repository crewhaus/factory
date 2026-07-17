import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrManagedV0,
  renderBundleReadme,
} from "@crewhaus/ir";
import { memoryFragmentFromIr } from "@crewhaus/memory-service";

/**
 * Emit a managed-daemon bundle. Generates `daemon.ts` that wires:
 *   - `@crewhaus/gateway-server` listening on `process.env.PORT`
 *     (default 3000) with the JWT secret from
 *     `process.env.CREWHAUS_GATEWAY_JWT_SECRET`,
 *   - per-tenant routing via `@crewhaus/tenancy`,
 *   - per-tenant audit log via `@crewhaus/audit-log`,
 *   - the runChatLoop dispatcher inside `runs.create` / `runs.continue`,
 *   - a pluggable `@crewhaus/durable-state` BudgetStore
 *     (`CREWHAUS_BUDGET_STORE=sqlite:<path>` for restart-safe accounting)
 *     shared with the boot-time self-heal janitor (ops item 36), which
 *     clears crash-leaked reservations ONCE at boot (single-writer only —
 *     `CREWHAUS_JANITOR_CLEAR_RESERVATIONS=0` opts out for multi-writer
 *     deployments), evicts expired sessions under the harness's
 *     `.crewhaus/retention.json` policy (pins + sessions.maxAgeDays, the
 *     same contract `crewhaus retention` enforces) across ALL tenant roots
 *     (spec-declared and fallback), and reports orphaned tool_use entries —
 *     boot run + hourly re-run (`CREWHAUS_JANITOR=0` /
 *     `CREWHAUS_JANITOR_INTERVAL_MS` to tune).
 *
 * The agent.ts emitted alongside is shape-compatible with the cli
 * target so existing tools, hooks, skills, and slash commands surface
 * inside the managed daemon without rewrite.
 *
 * Layer F2. Pairs with `gateway-server`, `tenancy`, `audit-log`,
 * `policy-engine`.
 */
export function emitManaged(ir: IrManagedV0, opts: EmitReadmeOptions = {}): Bundle {
  const files = [
    { path: "agent.ts", content: renderAgent(ir) },
    { path: "daemon.ts", content: renderDaemon(ir) },
  ];
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
}

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * Item 22 — render the failover-chain runChatLoop fields from the IR agent
 * block, indented for the generated `runOneTurn` body. Empty when the spec
 * declared neither field so existing bundles stay byte-identical. Mirror:
 * target-cli + target-channel-bot render the same fields — keep the three
 * in sync.
 */
function renderModelFailoverFields(ir: IrManagedV0): string {
  const pieces: string[] = [];
  const fallbacks = ir.agent.modelFallbacks;
  if (fallbacks !== undefined && fallbacks.length > 0) {
    pieces.push(`\n    modelFallbacks: [${fallbacks.map((m) => escapeJsonString(m)).join(", ")}],`);
  }
  if (ir.agent.circuitBreaker !== undefined) {
    pieces.push(`\n    circuitBreaker: ${JSON.stringify(ir.agent.circuitBreaker)},`);
  }
  // Item 26 — two-tier router (mirror of target-cli). Absent when unset.
  if (ir.agent.modelTiers !== undefined) {
    pieces.push(`\n    modelTiers: ${JSON.stringify(ir.agent.modelTiers)},`);
  }
  // Adaptive model routing — the N-candidate pool (mirror of target-cli).
  if (ir.agent.modelPool !== undefined) {
    pieces.push(`\n    modelPool: ${JSON.stringify(ir.agent.modelPool)},`);
  }
  return pieces.join("");
}

/**
 * Section 55 / item 23 — render the `failureTaxonomy` runChatLoop field,
 * indented for the generated `runOneTurn` body. Empty when the spec omits
 * the block. Mirror: target-cli + target-channel-bot render the same field.
 */
function renderFailureTaxonomyField(ir: IrManagedV0): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n    failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Item 27 — render the `budget` runChatLoop field, indented for the
 * generated `runOneTurn` body. Empty when the spec omits it. Mirror:
 * target-cli + target-channel-bot render the same field. This is the
 * RUN-level spend cap; the per-tenant token budgets in daemon.ts
 * (TENANT_OVERRIDES → gateway budget enforcement) are a separate ceiling
 * and continue to override at admission regardless of this field.
 */
function renderBudgetField(ir: IrManagedV0): string {
  if (ir.budget === undefined) return "";
  return `\n    budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Loop contract 0.4 (Batch A) — render the agent-block loop knobs
 * (`maxTokens`, `thinking`, `rateLimits`) as runChatLoop fields, indented
 * for the generated `runOneTurn` body. Empty when the spec declares none of
 * them so existing bundles stay byte-identical. `thinking` is the IrThinking
 * union verbatim ({ budgetTokens } → `ProviderRequest.thinking`; { effort }
 * → `ProviderRequest.reasoningEffort` via the adapter's
 * EFFORT_THINKING_BUDGET_TOKENS table); `rateLimits` is the per-tool
 * `{ rpm, burst? }` record keyed by tool name or `"*"`. Mirror: target-cli +
 * target-channel-bot render the same fields — keep the three in sync.
 */
function renderAgentLoopFields(ir: IrManagedV0): string {
  const pieces: string[] = [];
  if (ir.agent.maxTokens !== undefined) {
    pieces.push(`\n    maxTokens: ${ir.agent.maxTokens},`);
  }
  if (ir.agent.thinking !== undefined) {
    pieces.push(`\n    thinking: ${JSON.stringify(ir.agent.thinking)},`);
  }
  if (ir.agent.rateLimits !== undefined) {
    pieces.push(`\n    rateLimits: ${JSON.stringify(ir.agent.rateLimits)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — render the top-level `limits:` ceilings as
 * FLAT runChatLoop fields (matching runtime-core's existing flat
 * `maxToolIterations`/`maxConcurrentTools`/`contextLimit` options), indented
 * for the generated `runOneTurn` body. Each knob is emitted only when the
 * spec declared it — the runtime owns per-knob defaults, so an absent knob
 * must stay absent rather than pin today's default into the bundle.
 * `limits.crew` never appears on this shape (spec rejects it outside crew).
 * Mirror: target-cli + target-channel-bot render the same fields.
 */
function renderLimitsFields(ir: IrManagedV0): string {
  const limits = ir.limits;
  if (limits === undefined) return "";
  const pieces: string[] = [];
  if (limits.maxToolIterations !== undefined) {
    pieces.push(`\n    maxToolIterations: ${limits.maxToolIterations},`);
  }
  if (limits.maxConcurrentTools !== undefined) {
    pieces.push(`\n    maxConcurrentTools: ${limits.maxConcurrentTools},`);
  }
  if (limits.contextLimit !== undefined) {
    pieces.push(`\n    contextLimit: ${limits.contextLimit},`);
  }
  if (limits.deadlineMs !== undefined) {
    pieces.push(`\n    deadlineMs: ${limits.deadlineMs},`);
  }
  if (limits.turnTimeoutMs !== undefined) {
    pieces.push(`\n    turnTimeoutMs: ${limits.turnTimeoutMs},`);
  }
  if (limits.modelCallTimeoutMs !== undefined) {
    pieces.push(`\n    modelCallTimeoutMs: ${limits.modelCallTimeoutMs},`);
  }
  if (limits.loopDetection !== undefined) {
    pieces.push(`\n    loopDetection: ${JSON.stringify(limits.loopDetection)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — render the spec-declared `hooks:` entries as
 * the `hooks` runChatLoop field, indented for the generated `runOneTurn`
 * body. IrHook is shape-identical to hooks-engine's HookDef, so the JSON
 * literal is a valid `HookDef[]` in the generated bundle (declaration order
 * preserved — hook firing order is semantics). The managed shape discovers
 * no settings.json hooks (unlike cli), so the spec list is the whole array.
 * Empty/absent → no field. Mirror: target-cli + target-channel-bot.
 */
function renderHooksField(ir: IrManagedV0): string {
  if (ir.hooks === undefined || ir.hooks.length === 0) return "";
  return `\n    hooks: ${JSON.stringify(ir.hooks)},`;
}

/**
 * Ops item 37 — render the `sloTargets` runChatLoop field from
 * `observability.slo`, indented for the generated `runOneTurn` body. The IR is a
 * numbers + literal-union object (safe to JSON.stringify). Emitting it attaches
 * the SLO monitor per turn (gated by CREWHAUS_SLO) so a deployed managed bundle
 * gets SLO SENSING + the `alert` rung. The daemon separately consults the
 * durable intake gate at admission (F3). The registry-backed pause/rollback
 * mitigation ladder is driven by the CLI `run`/monitor context (which has the
 * spec-registry + deployment-controller); a per-turn managed agent degrades to
 * sensing+alert. Empty when the spec omits the block.
 */
function renderSloField(ir: IrManagedV0): string {
  const slo = ir.observability?.slo;
  if (slo === undefined) return "";
  return `\n    sloTargets: ${JSON.stringify(slo)},`;
}

/**
 * v0.3.0 PR 11 — the managed shape's memory-fabric wiring state. `wired`
 * when the IR carries an enabled `memory` block and/or a `continuity` block
 * (DEFAULT-ON in 0.3.0 — only `continuity: false` removes it). Scope is
 * `spec`, tenant-fenced: `runOneTurn` receives the request's Tenant and
 * threads it into `wireMemory`, which re-roots every store under the
 * tenant's directory with the stores' own fail-closed path fencing (§2.7 —
 * commingling tenants' plans/wikis is a data-isolation bug, not a gap).
 */
function memoryFabric(ir: IrManagedV0): { wired: boolean; fragmentJson: string } {
  const memoryOn = ir.memory !== undefined && ir.memory.enabled !== false;
  const continuityOn = ir.continuity !== undefined;
  const wired = memoryOn || continuityOn;
  const fragmentJson = wired
    ? JSON.stringify(
        memoryFragmentFromIr({
          name: ir.name,
          ...(memoryOn ? { memory: ir.memory } : {}),
          ...(continuityOn ? { continuity: ir.continuity } : {}),
          // v0.3.0 Goal 2 (PR 17) — learning rides the fragment: wireMemory
          // renders the learning-loop skill + gates in /study /reflect.
          ...(ir.learning !== undefined ? { learning: ir.learning } : {}),
        }),
      )
    : "";
  return { wired, fragmentJson };
}

function renderAgent(ir: IrManagedV0): string {
  const fabric = memoryFabric(ir);
  const memImports = fabric.wired
    ? `
import { wireMemory } from "@crewhaus/memory-service";
import { createSkillTool } from "@crewhaus/skills-registry";
import type { Tenant } from "@crewhaus/tenancy";
import type { RegisteredTool } from "@crewhaus/tool-catalog";`
    : "";
  const tenantArgField = fabric.wired
    ? `
  /** v0.3.0 — the request's tenant; fences every memory-fabric store. */
  readonly tenant: Tenant;`
    : "";
  const memBlock = fabric.wired
    ? `
  // v0.3.0 — the memory fabric, wired per turn through the ONE stable
  // composition-root call (design §1 principle 1), tenant-fenced (§2.7).
  const __memTools: RegisteredTool[] = [];
  const __memWired = await wireMemory(${fabric.fragmentJson}, {
    catalog: { register: (t: RegisteredTool) => { __memTools.push(t); } },
    cwd: process.cwd(),
    tenant: args.tenant,
    sessionScope: args.sessionId,
  });
  const __skills = __memWired.options.skills ?? [];
  if (__skills.length > 0) __memTools.push(createSkillTool(__skills));
`
    : "";
  const memRunFields = fabric.wired
    ? `
    tools: __memTools,
    ...__memWired.options,`
    : "";
  // v0.3.0 Goal 3 — thredz is spec-carried on this shape but not emit-wired
  // in this release (the one-knob backend flip ships on cli). Surface it,
  // 0.2.3-style, so nobody wonders why their wiki stayed local.
  const thredzWarning =
    ir.thredz !== undefined
      ? "// note: thredz configured but ignored on managed in 0.3.0 — the Thredz backend flip is wired on the cli shape (design §4)\n"
      : "";
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: managed, ir version: ${ir.version})
${thredzWarning}import { runChatLoop } from "@crewhaus/runtime-core";
import type { RunChatLoopOptions } from "@crewhaus/runtime-core";${memImports}

export type ManagedAgentArgs = {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly input: string;${tenantArgField}
  readonly extraOptions?: Partial<RunChatLoopOptions>;
};

export async function runOneTurn(args: ManagedAgentArgs): Promise<string> {
${memBlock}  return await runChatLoop({
    model: ${escapeJsonString(ir.agent.model)},
    instructions: ${escapeJsonString(ir.agent.instructions)},${renderAgentLoopFields(ir)}${renderModelFailoverFields(ir)}${renderFailureTaxonomyField(ir)}${renderBudgetField(ir)}${renderLimitsFields(ir)}${renderHooksField(ir)}${renderSloField(ir)}
    sessionName: args.sessionId,
    sessionTarget: "managed",
    seedMessages: [{ role: "user", content: args.input }],
    singleTurn: true,${memRunFields}
    ...(args.extraOptions ?? {}),
  });
}
`;
}

function renderDaemon(ir: IrManagedV0): string {
  // v0.3.0 — thread the request's Tenant into runOneTurn so the memory
  // fabric's stores are tenant-fenced (§2.7).
  const tenantField = memoryFabric(ir).wired ? ", tenant" : "";
  // v0.3.0 PR 14 (§6.3) — the dream consolidation step, registered into the
  // existing boot+hourly janitor tick. Multi-tenant daemons run the
  // DETERMINISTIC phase per tenant (tenantsRootDir mode — re-enumerated
  // each run, exactly like the janitor's own session sweep); the model
  // phase is deliberately never fired from a multi-tenant janitor:
  // per-tenant model spend needs an explicit operator decision (a
  // per-tenant `crewhaus dream run` cron).
  const dreamOn =
    ir.memory !== undefined && ir.memory.enabled !== false && ir.memory.dream !== undefined;
  const dreamImport = dreamOn
    ? `import { createDreamJanitorStep } from "@crewhaus/memory-service";\n`
    : "";
  const dreamStepBlock = dreamOn
    ? `
// v0.3.0 §6.3 — scheduled memory consolidation (dream), deterministic per
// tenant, due-checked against <tenantRoot>/dream/<spec>/state.json each
// tick. CREWHAUS_DREAM=0 disables; CREWHAUS_DREAM_INTERVAL_MS overrides the
// cadence. The model phase is never fired from a multi-tenant janitor —
// per-tenant model spend needs an explicit operator decision: schedule a
// per-tenant \`crewhaus dream run\` cron for full consolidation.
const DREAM_STEP = createDreamJanitorStep(${memoryFabric(ir).fragmentJson}, {
  cwd: process.cwd(),
  tenantsRootDir: TENANTS_ROOT,
});
`
    : "";
  const dreamStepsField = dreamOn ? "\n  steps: DREAM_STEP !== null ? [DREAM_STEP] : []," : "";
  const tenantList = ir.tenants
    .map(
      (t) =>
        `  ${escapeJsonString(t.id)}: { id: ${escapeJsonString(
          t.id,
        )}, budget: { maxInputTokens: ${t.budget.maxInputTokens}, maxOutputTokens: ${t.budget.maxOutputTokens} } }`,
    )
    .join(",\n");
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: managed, ir version: ${ir.version})
import { loadRetentionConfig } from "@crewhaus/data-retention-engine";
import { createBudgetStore } from "@crewhaus/durable-state";
import { formatRunFailure, isRunFailedError } from "@crewhaus/errors";
import { createGatewayServer } from "@crewhaus/gateway-server";
import { auditPolicyDecision, evaluatePolicy } from "@crewhaus/policy-engine";
${dreamImport}import { createJanitor } from "@crewhaus/runtime-core";
import { buildTenant, type Tenant } from "@crewhaus/tenancy";
import { runOneTurn } from "./agent.ts";

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
const TENANTS_ROOT = process.env.CREWHAUS_TENANTS_ROOT ?? "/tmp/crewhaus-tenants";
const PORT = Number(process.env.PORT ?? 3000);
const ENV_JWT_SECRET = process.env.CREWHAUS_GATEWAY_JWT_SECRET;
if (ENV_JWT_SECRET !== undefined && ENV_JWT_SECRET.length < 16) {
  console.error(
    "[managed] CREWHAUS_GATEWAY_JWT_SECRET is set but too short (min 16 chars). Refusing to start.",
  );
  process.exit(1);
}
const JWT_SECRET: string = ENV_JWT_SECRET ?? randomBytes(24).toString("hex");
if (ENV_JWT_SECRET === undefined) {
  // Dev-mode autogeneration. The doc-side contract is that the operator
  // copies this line and re-exports it for subsequent runs (otherwise
  // every restart invalidates previously-minted tokens). In production,
  // set CREWHAUS_GATEWAY_JWT_SECRET explicitly.
  console.error(
    \`[managed] no CREWHAUS_GATEWAY_JWT_SECRET in env — generated a one-shot dev secret. Export it to re-use:\\n  export CREWHAUS_GATEWAY_JWT_SECRET=\${JWT_SECRET}\`,
  );
}

const TENANT_OVERRIDES: Record<string, Partial<Tenant>> = {
${tenantList}
};

const tenantOverrides: Record<string, Tenant> = {};
for (const [id, override] of Object.entries(TENANT_OVERRIDES)) {
  tenantOverrides[id] = { ...buildTenant(id, { tenantsRoot: TENANTS_ROOT }), ...override };
}

// Budget accounting backend (audit R3). Default in-memory; set
// CREWHAUS_BUDGET_STORE=sqlite:<path> so recorded usage and in-flight
// reservations survive restarts and are shared by every process on this
// host. CAVEAT: durable-state scopes the janitor's boot-time
// clearReservations() to SINGLE-writer deployments — when several writer
// processes share one sqlite store, one process booting would zero the
// others' live reservations, so ALSO set
// CREWHAUS_JANITOR_CLEAR_RESERVATIONS=0 on every process.
const BUDGET_STORE = createBudgetStore(process.env.CREWHAUS_BUDGET_STORE ?? "memory");

// Retention policy (.crewhaus/retention.json, ops item 35): the janitor
// honors the SAME pins + sessions.maxAgeDays the \`crewhaus retention\` CLI
// enforces — a daemon evicting on the bare 30-day default would delete
// sessions the operator pinned or configured to keep longer. A malformed
// config file fails safe: eviction is disabled (never guess a deletion
// policy), and the daemon keeps serving.
let RETENTION_TTL_DAYS: number;
let RETENTION_PINS: readonly string[] = [];
try {
  const retention = await loadRetentionConfig(process.cwd());
  RETENTION_TTL_DAYS = retention.sessionMaxAgeDays;
  RETENTION_PINS = retention.pins;
} catch (err) {
  console.error(
    \`[managed] .crewhaus/retention.json unreadable — janitor session eviction disabled: \${(err as Error).message}\`,
  );
  RETENTION_TTL_DAYS = Number.POSITIVE_INFINITY; // fail-safe: evict nothing
}

// Boot-time self-heal janitor (ops item 36): clears crash-leaked budget
// reservations ONCE at boot (durable-state's documented single-writer boot
// contract — a process that died between tryReserve and release leaks its
// reservation in the sqlite backend; the attempt is boot-only and NEVER
// retried, since a later clear would zero live reservations), evicts
// expired sessions under the retention policy above, and reports orphaned
// tool_use entries in recent transcripts (report-only). Session roots:
// the spec-declared tenants below PLUS every tenant directory under
// TENANTS_ROOT, re-enumerated each run — gateway-server's buildTenant
// fallback serves ANY authenticated tenant id, not just the declared ones.
// CREWHAUS_JANITOR=0 disables entirely; CREWHAUS_JANITOR_INTERVAL_MS
// overrides the hourly re-run (0 keeps only the boot run);
// CREWHAUS_JANITOR_CLEAR_RESERVATIONS=0 skips the reservation clear
// (REQUIRED for multi-writer sqlite deployments — see BUDGET_STORE above).
${dreamStepBlock}const janitor = createJanitor({
  ...(process.env.CREWHAUS_JANITOR_CLEAR_RESERVATIONS !== "0"
    ? { budgetStore: BUDGET_STORE }
    : {}),
  sessionRootDirs: Object.values(tenantOverrides).map((t) => t.sessionRoot),
  tenantsRootDir: TENANTS_ROOT,
  sessionTtlDays: RETENTION_TTL_DAYS,
  pinnedSessionIds: RETENTION_PINS,${dreamStepsField}
});
if (process.env.CREWHAUS_JANITOR !== "0") {
  const janitorReport = await janitor.runOnce();
  console.error(\`[managed] janitor: \${JSON.stringify(janitorReport.steps)}\`);
  janitor.start(Number(process.env.CREWHAUS_JANITOR_INTERVAL_MS ?? 3_600_000));
}

// Ops item 37 — SLO intake gate. The CLI \`run\`/monitor path (registry-backed)
// flips \`.crewhaus/slo/intake.json\` { paused } on a SUSTAINED SLO breach (and
// back to false on recovery). The daemon consults it at request admission and
// sheds load down the same 429 budget_exceeded path while paused. Read is cached
// for 1s so admission stays hot; a missing/corrupt file fails OPEN (admit).
const INTAKE_GATE_PATH = \`\${process.cwd()}/.crewhaus/slo/intake.json\`;
let __intakeCache: { paused: boolean; reason?: string } = { paused: false };
let __intakeCacheAt = 0;
function readIntakeGate(): { paused: boolean; reason?: string } {
  const nowMs = Date.now();
  if (nowMs - __intakeCacheAt < 1000) return __intakeCache;
  __intakeCacheAt = nowMs;
  try {
    const raw = readFileSync(INTAKE_GATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { paused?: unknown; reason?: unknown };
    __intakeCache =
      parsed.paused === true
        ? { paused: true, ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}) }
        : { paused: false };
  } catch {
    __intakeCache = { paused: false }; // no/corrupt gate → admit (fail open)
  }
  return __intakeCache;
}

const gateway = createGatewayServer({
  jwtSecret: JWT_SECRET,
  tenantsRoot: TENANTS_ROOT,
  tenantOverrides,
  budgetStore: BUDGET_STORE,
  intakeGate: readIntakeGate,
  handler: async ({ method, params, tenant }) => {
    if (method === "runs.create" || method === "runs.continue") {
      const p = params as { input: string; sessionId?: string };
      const sessionId = p.sessionId ?? \`sess_\${Math.random().toString(36).slice(2, 18).padEnd(16, "0")}\`;
      const log = await gateway.getAuditLog(tenant);
      const policy = evaluatePolicy(
        { toolName: "runChatLoop", sideEffect: "external", input: p.input, tenantId: tenant.id },
      );
      await auditPolicyDecision(log, { toolName: "runChatLoop", input: p.input, tenantId: tenant.id }, policy);
      if (policy.decision === "deny") {
        throw new Error(\`policy denied: \${policy.reason ?? "no reason"}\`);
      }
      let reply: string;
      try {
        reply = await runOneTurn({ tenantId: tenant.id, sessionId, input: p.input${tenantField} });
      } catch (err) {
        // v0.3.0 Goal 6 — a classified terminal failure (billing/auth/…)
        // renders its structured report on the daemon's stderr, then
        // rethrows so the gateway maps it to an error response. The daemon
        // itself keeps serving — one tenant's dead provider account must
        // not take the process down.
        if (isRunFailedError(err)) {
          process.stderr.write(\`\${formatRunFailure(err.report, { prefix: "[managed]" })}\\n\`);
        }
        throw err;
      }
      const inputTokens = Math.ceil(p.input.length / 4);
      const outputTokens = Math.ceil(reply.length / 4);
      await gateway.recordUsage(tenant.id, { input: inputTokens, output: outputTokens });
      await log.append({
        kind: "model_call",
        payload: { tenantId: tenant.id, sessionId, inputTokens, outputTokens },
      });
      return { runId: \`run_\${Math.random().toString(36).slice(2, 10)}\`, sessionId, tenantId: tenant.id, reply };
    }
    if (method === "runs.cancel") {
      return { ok: true };
    }
    if (method === "audit.tail") {
      const log = await gateway.getAuditLog(tenant);
      const rows: unknown[] = [];
      for await (const r of log.read()) rows.push(r);
      return { rows };
    }
    return { ok: true, method };
  },
});

const handle = await gateway.listen(PORT);
console.error(\`[managed] gateway listening on :\${handle.port}\`);

process.on("SIGTERM", async () => {
  console.error("[managed] SIGTERM — closing gateway");
  janitor.stop();
  await handle.close();
  process.exit(0);
});
process.on("SIGINT", async () => {
  console.error("[managed] SIGINT — closing gateway");
  janitor.stop();
  await handle.close();
  process.exit(0);
});
`;
}
