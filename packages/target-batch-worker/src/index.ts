/**
 * Catalog F2 `target-batch-worker` — Section 23 BATCH.
 *
 * Codegen for the queue-worker target. Emits a single self-contained
 * daemon (`agent.ts`) that:
 *
 *   1. Constructs the configured queue adapter. `in-memory` is the default
 *      and needs no environment; `sqs` / `redis-streams` / `postgres`
 *      resolve their connection details from the environment at boot
 *      (SQS_QUEUE_URL+AWS_REGION / REDIS_URL / DATABASE_URL — G06) and
 *      fail fast with the missing variable's name.
 *   2. Optionally seeds the in-memory adapter with `queue.seedJobs`
 *      (test / smoke convenience).
 *   3. Boots a `queue-consumer` with the user's `agent` as the handler
 *      — each pulled job runs one `runChatLoop({singleTurn: true})` with
 *      the job input as the user message; the assistant's terminal text
 *      is the cached result.
 *   4. Streams JSON events to stdout (`worker_start | job_start |
 *      job_end | drain_start | drain_end | worker_stop`).
 *   5. Installs SIGTERM + SIGINT handlers that drain in-flight jobs
 *      cleanly before exit.
 *   6. Runs the boot-time self-heal janitor (ops item 36) — session TTL
 *      eviction + orphaned-tool_use report — at boot and hourly
 *      (`CREWHAUS_JANITOR=0` / `CREWHAUS_JANITOR_INTERVAL_MS` to tune).
 */
import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrBatchV0,
  renderBundleReadme,
} from "@crewhaus/ir";

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

type BuiltinToolEntry = {
  readonly package: string;
  readonly export: string;
  readonly initSymbol?: string;
};

const BUILTIN_TOOL_MAP: Record<string, BuiltinToolEntry> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  write: { package: "@crewhaus/tool-fs", export: "write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit" },
  glob: { package: "@crewhaus/tool-fs", export: "glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash" },
  webFetch: {
    package: "@crewhaus/tool-web",
    export: "webFetch",
    initSymbol: "registerWebFetchConfig",
  },
  webSearch: { package: "@crewhaus/tool-web", export: "webSearch" },
  fetch: {
    package: "@crewhaus/tool-fetch",
    export: "fetch",
    initSymbol: "registerFetchConfig",
  },
};

function resolveTools(
  toolNames: readonly string[],
  toolConfigs: Readonly<Record<string, unknown>>,
): {
  imports: string[];
  inits: string[];
  registrations: string[];
} {
  if (toolNames.length === 0) return { imports: [], inits: [], registrations: [] };
  const byPackage = new Map<string, Set<string>>();
  const inits: string[] = [];
  const registrations: string[] = [];
  for (const name of toolNames) {
    const entry = BUILTIN_TOOL_MAP[name];
    if (!entry) {
      const known = Object.keys(BUILTIN_TOOL_MAP).sort().join(", ");
      throw new TargetEmitError(`unknown tool "${name}" — known tools: ${known}`);
    }
    const set = byPackage.get(entry.package) ?? new Set<string>();
    set.add(entry.export);
    byPackage.set(entry.package, set);
    if (entry.initSymbol !== undefined) {
      const cfg = toolConfigs[name];
      if (cfg !== undefined) {
        set.add(entry.initSymbol);
        inits.push(`${entry.initSymbol}(${JSON.stringify(cfg)});`);
      }
    }
    registrations.push(`defaultCatalog.register(${entry.export});`);
  }
  const imports: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const symbols = [...(byPackage.get(pkg) ?? new Set<string>())].sort();
    imports.push(`import { ${symbols.join(", ")} } from "${pkg}";`);
  }
  return { imports, inits, registrations };
}

function renderPermissionsField(ir: IrBatchV0): string {
  const { mode, rules } = ir.permissions;
  if (mode === undefined && rules.length === 0) return "";
  const lines: string[] = [];
  if (mode !== undefined) {
    lines.push(`        permissionMode: ${escapeJsonString(mode)},`);
  }
  if (rules.length > 0) {
    const ruleLits = rules
      .map(
        (r) =>
          `            { type: ${escapeJsonString(r.type)}, pattern: ${escapeJsonString(r.pattern)}, source: "yaml" },`,
      )
      .join("\n");
    lines.push(
      [
        "        permissionRules: {",
        "          flag: [],",
        "          settings: [],",
        "          yaml: [",
        ruleLits,
        "          ],",
        "          hooks: [],",
        "          builtin: BUILTIN_DEFAULT_RULES,",
        "        },",
      ].join("\n"),
    );
  }
  return `\n${lines.join("\n")}`;
}

/**
 * Adaptive model routing — render the `modelPool` runChatLoop field.
 * JSON.stringify safely quotes the validated pool object (mirroring
 * target-cli's renderModelFailoverFields; keep the pipeline/research/batch/
 * browser copies in sync). Empty when the spec omits `model_pool`, keeping
 * bundles byte-identical.
 */
function poolField(ir: IrBatchV0, indent: string): string {
  return ir.agent.modelPool !== undefined
    ? `\n${indent}modelPool: ${JSON.stringify(ir.agent.modelPool)},`
    : "";
}

/**
 * Section 55 / item 23 — render the `failureTaxonomy` runChatLoop field.
 * Empty when the spec omits the block (mirror: target-cli +
 * target-channel-bot render the same field; keep the pipeline/research/
 * batch/browser copies in sync).
 */
function taxonomyField(ir: IrBatchV0, indent: string): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n${indent}failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Item 27 (Batch A extends it to this shape) — render the `budget`
 * runChatLoop field. Empty when the spec omits it. Mirror: target-cli +
 * target-channel-bot + target-managed render the same field. NOTE: the
 * runtime meters cost per `runChatLoop` call, so on this shape the cap is a
 * PER-JOB ceiling (every pulled job runs its own single-turn loop), not a
 * worker-lifetime one.
 */
function budgetField(ir: IrBatchV0, indent: string): string {
  if (ir.budget === undefined) return "";
  return `\n${indent}budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Loop contract 0.4 (Batch A) — thread the top-level `limits:` ceilings into
 * the per-job `runChatLoop` call as the runtime's individual top-level
 * knobs, camelCase-mirroring the IR 1:1. Every knob is emitted only when
 * declared — the runtime owns every default — so existing bundles stay
 * byte-identical. Like `budget`, the time knobs (`deadlineMs` /
 * `turnTimeoutMs`) bound ONE job's loop — size them against
 * `queue.visibilityTimeoutMs`, not the worker's lifetime. `limits.crew`
 * never reaches this shape (crew-only; the spec rejects it everywhere
 * else). Mirror: target-cli + target-channel-bot + target-managed render
 * the same fields.
 */
function limitsFields(ir: IrBatchV0, indent: string): string {
  const limits = ir.limits;
  if (limits === undefined) return "";
  const pieces: string[] = [];
  if (limits.maxToolIterations !== undefined) {
    pieces.push(`\n${indent}maxToolIterations: ${limits.maxToolIterations},`);
  }
  if (limits.maxConcurrentTools !== undefined) {
    pieces.push(`\n${indent}maxConcurrentTools: ${limits.maxConcurrentTools},`);
  }
  if (limits.contextLimit !== undefined) {
    pieces.push(`\n${indent}contextLimit: ${limits.contextLimit},`);
  }
  if (limits.deadlineMs !== undefined) {
    pieces.push(`\n${indent}deadlineMs: ${limits.deadlineMs},`);
  }
  if (limits.turnTimeoutMs !== undefined) {
    pieces.push(`\n${indent}turnTimeoutMs: ${limits.turnTimeoutMs},`);
  }
  if (limits.modelCallTimeoutMs !== undefined) {
    pieces.push(`\n${indent}modelCallTimeoutMs: ${limits.modelCallTimeoutMs},`);
  }
  if (limits.loopDetection !== undefined) {
    pieces.push(`\n${indent}loopDetection: ${JSON.stringify(limits.loopDetection)},`);
  }
  return pieces.join("");
}

/**
 * Section 9 / G05 (Batch A) — emit the `McpHost` boot block when the IR
 * carries mcp_servers. Wire-once: the host boots once in `main()` (before
 * the consumer starts) and registers every server's namespaced tools onto
 * the shared `defaultCatalog`, so EVERY pulled job's `runChatLoop` carries
 * them (`tools: defaultCatalog.list()` — no per-job reconnect). Mirror of
 * target-channel-bot's renderMcpServers (keep in sync).
 *
 * 0.3.0 — env/header values are `IrSecretRef` objects; the UNRESOLVED
 * config is embedded verbatim (so no secret value ever lands in the
 * artifact) and `resolveMcpServerConfig` materialises it from the running
 * process's environment at boot, failing fast with the variable's name
 * when a referenced env var is unset.
 *
 * Empty `mcp_servers` returns empty strings so spec files without MCP get
 * no MCP plumbing at all and prior bundles stay byte-identical.
 */
function renderMcpServers(ir: IrBatchV0): {
  imports: string[];
  bootBlock: string;
  cleanupBlock: string;
  hasAny: boolean;
} {
  const entries = Object.entries(ir.mcp_servers);
  if (entries.length === 0) {
    return { imports: [], bootBlock: "", cleanupBlock: "", hasAny: false };
  }
  const imports = [
    `import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";`,
    `import { registerMcpServer } from "@crewhaus/tool-mcp";`,
  ];
  const addLines = entries
    .map(
      ([name, cfg]) =>
        `mcpHost.addServer(${escapeJsonString(name)}, resolveMcpServerConfig(${JSON.stringify(cfg)}, { name: ${escapeJsonString(name)} }));`,
    )
    .join("\n");
  const registerLines = entries
    .map(
      ([name]) =>
        `  registerMcpServer(mcpHost, ${escapeJsonString(name)}, defaultCatalog, { onRegister: ({ fullName }) => process.stdout.write(\`[mcp] registered \${fullName}\\n\`) }),`,
    )
    .join("\n");
  const bootBlock = [
    "const mcpHost = new McpHost();",
    addLines,
    "await Promise.all([",
    registerLines,
    "]);",
  ].join("\n");
  return {
    imports,
    bootBlock,
    cleanupBlock: "await mcpHost.disconnectAll();",
    hasAny: true,
  };
}

/**
 * G06 — per-adapter queue construction. The adapter is fixed at CODEGEN
 * time (`queue.adapter` in the spec), so the bundle carries only the
 * selected backend's import + `buildQueue()` body. Non-in-memory backends
 * resolve their connection details from the environment at boot via the
 * emitted `requireQueueEnv` helper and throw ONLY when the selected
 * backend's env is missing, naming the variable; everything past the env
 * gate (SDK presence, credential chains) is `@crewhaus/queue-protocol`'s
 * own boot contract. The identifier knobs each backend needs beyond its
 * connection URL get worker-conventional defaults derived from the spec
 * name, overridable by env.
 *
 * The in-memory body is emitted BYTE-IDENTICALLY to its pre-G06 text
 * (including the now-historical unreachable `throw` arm) — the
 * `pre-continuity` byte-restore pins in packages/compiler cover the
 * in-memory batch bundle, and G06 must not disturb them.
 */
function renderQueueBuild(ir: IrBatchV0): {
  importLine: string;
  seedConst: string;
  buildFn: string;
} {
  const seedJobsLit = JSON.stringify(ir.queue.seedJobs ?? []);
  switch (ir.queue.adapter) {
    case "in-memory":
      return {
        importLine: `import { createInMemoryQueue } from "@crewhaus/queue-protocol";`,
        seedConst: `\nconst SPEC_SEED_JOBS: string[] = ${seedJobsLit};`,
        buildFn: `function buildQueue(): ReturnType<typeof createInMemoryQueue<string>> {
  if (SPEC_QUEUE_ADAPTER === "in-memory") {
    return createInMemoryQueue<string>({ initialJobs: SPEC_SEED_JOBS });
  }
  throw new Error(
    "[batch-worker] queue adapter \\"" + SPEC_QUEUE_ADAPTER +
      "\\" is not implemented in v0 — only \\"in-memory\\" is supported. " +
      "SQS / Redis Streams / Postgres adapters land in a follow-up.",
  );
}`,
      };
    case "sqs":
      return {
        importLine: `import { createSqsAdapter, type QueueAdapter } from "@crewhaus/queue-protocol";`,
        seedConst: "",
        buildFn: `${REQUIRE_QUEUE_ENV_FN}

function buildQueue(): QueueAdapter<string> {
  const queueUrl = requireQueueEnv("SQS_QUEUE_URL", "the queue's full https URL");
  const region =
    process.env["AWS_REGION"] ??
    process.env["AWS_DEFAULT_REGION"] ??
    requireQueueEnv("AWS_REGION", "the queue's AWS region, e.g. us-east-1");
  // Credentials are optional here: absent, the SDK falls back to its own
  // chain (env, profile, IAM instance role).
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
  return createSqsAdapter<string>({
    queueUrl,
    region,
    ...(accessKeyId !== undefined ? { accessKeyId } : {}),
    ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
  });
}`,
      };
    case "redis-streams":
      return {
        importLine: `import { createRedisStreamsAdapter, type QueueAdapter } from "@crewhaus/queue-protocol";`,
        seedConst: "",
        buildFn: `${REQUIRE_QUEUE_ENV_FN}

function buildQueue(): QueueAdapter<string> {
  // ioredis reads REDIS_URL when the client connects; the presence check
  // here fails fast at boot with the variable's name instead of a hung
  // first pull.
  requireQueueEnv("REDIS_URL", "redis[s]://[user:pass@]host:port[/db]");
  return createRedisStreamsAdapter<string>({
    streamKey: process.env["REDIS_STREAM_KEY"] ?? \`crewhaus:\${SPEC_NAME}:jobs\`,
    consumerGroup: process.env["REDIS_CONSUMER_GROUP"] ?? \`crewhaus:\${SPEC_NAME}:workers\`,
    consumerName: process.env["REDIS_CONSUMER_NAME"] ?? \`worker-\${process.pid}\`,
  });
}`,
      };
    case "postgres":
      return {
        importLine: `import { createPostgresAdapter, type QueueAdapter } from "@crewhaus/queue-protocol";`,
        seedConst: "",
        buildFn: `${REQUIRE_QUEUE_ENV_FN}

function buildQueue(): QueueAdapter<string> {
  // pg reads DATABASE_URL when the pool connects; the presence check here
  // fails fast at boot with the variable's name instead of a hung first
  // pull.
  requireQueueEnv("DATABASE_URL", "postgres://user:pass@host:port/db");
  const deadLetterTable = process.env["CREWHAUS_JOBS_DLQ_TABLE"];
  return createPostgresAdapter<string>({
    tableName: process.env["CREWHAUS_JOBS_TABLE"] ?? "crewhaus_jobs",
    ...(deadLetterTable !== undefined ? { deadLetterTable } : {}),
  });
}`,
      };
  }
}

/**
 * The env gate every non-in-memory `buildQueue()` opens with. Emitted (not
 * imported) so the bundle stays self-contained; the message names the
 * adapter, the variable, and its expected shape.
 */
const REQUIRE_QUEUE_ENV_FN = `function requireQueueEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(
      \`[batch-worker] queue adapter "\${SPEC_QUEUE_ADAPTER}" requires the \${name} environment variable (\${hint}) — set it and restart the worker.\`,
    );
  }
  return v;
}`;

export function emitBatchWorker(ir: IrBatchV0, opts: EmitReadmeOptions = {}): Bundle {
  const files = [{ path: "agent.ts", content: renderAgent(ir) }];
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
}

function renderAgent(ir: IrBatchV0): string {
  const { imports: builtinImports, inits, registrations } = resolveTools(ir.tools, ir.toolConfigs);
  const importBlock = builtinImports.length > 0 ? `${builtinImports.join("\n")}\n` : "";
  const initLines = inits.length > 0 ? `${inits.join("\n")}\n` : "";
  const registrationBlock =
    registrations.length > 0
      ? `\n// Spec-supplied tools registered at module load.\n${registrations.join("\n")}\n`
      : "";
  const permField = renderPermissionsField(ir);

  const queueBuild = renderQueueBuild(ir);
  const visRenewMs =
    ir.queue.visibilityRenewIntervalMs ?? Math.floor(ir.queue.visibilityTimeoutMs / 4);
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const mcp = renderMcpServers(ir);
  const mcpImportBlock = mcp.imports.length > 0 ? `${mcp.imports.join("\n")}\n` : "";
  const mcpBoot = mcp.hasAny
    ? `  // G05 — MCP servers, wired ONCE onto the shared defaultCatalog so every\n  // pulled job's runChatLoop carries the namespaced tools.\n  ${mcp.bootBlock.split("\n").join("\n  ")}\n\n`
    : "";
  const mcpShutdownCleanup = mcp.hasAny ? `\n    ${mcp.cleanupBlock}` : "";
  const mcpIdleCleanup = mcp.hasAny ? `\n        ${mcp.cleanupBlock}` : "";
  // Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks (`hooks:`).
  // IrHook is HookDef-shaped by contract (the spec ↔ hooks-engine
  // cross-check test pins the event vocabulary), so the literal threads
  // straight into the per-job runChatLoop. Declaration order from the spec
  // is preserved (hooks run in registration order). Absent/empty emits
  // nothing so existing bundles stay byte-identical.
  const specHooks = ir.hooks !== undefined && ir.hooks.length > 0 ? ir.hooks : undefined;
  const hooksImport =
    specHooks !== undefined ? `import type { HookDef } from "@crewhaus/hooks-engine";\n` : "";
  const hooksConst =
    specHooks !== undefined
      ? `\n// Loop contract 0.4 — spec-declared lifecycle hooks (registration order preserved).\nconst SPEC_HOOKS: ReadonlyArray<HookDef> = ${JSON.stringify(specHooks)};`
      : "";
  const hooksField = specHooks !== undefined ? "\n        hooks: SPEC_HOOKS," : "";
  // The queue_idle fast-exit only exists on the in-memory adapter: its
  // stats() are authoritative for "the queue is empty and nothing is in
  // flight". SQS/Redis/Postgres stats cannot cheaply distinguish "empty
  // right now" from "drained forever" (SQS pending, for one, is a
  // CloudWatch metric), so those workers run until signaled.
  const idleLoop =
    ir.queue.adapter === "in-memory"
      ? `  // For the hello-batch smoke: when the queue empties + no in-flight,
  // emit a queue_idle event and exit so the smoke can assert on a
  // clean shutdown without sending a signal. Production users will
  // typically run forever and rely on signals.
  const idleCheckMs = 200;
  while (!stopping) {
    await new Promise((r) => setTimeout(r, idleCheckMs));
    const stats = await queue.stats();
    if (stats.pending === 0 && stats.inFlight === 0 && consumer.inFlight() === 0) {
      // Idle — check once more after a short delay to avoid racing with
      // a job mid-pull.
      await new Promise((r) => setTimeout(r, idleCheckMs));
      const recheck = await queue.stats();
      if (
        recheck.pending === 0 &&
        recheck.inFlight === 0 &&
        consumer.inFlight() === 0
      ) {
        emit({ kind: "queue_idle", stats: recheck });
        janitor.stop();
        await consumer.drain();${mcpIdleCleanup}
        emit({ kind: "worker_stop", stats: await queue.stats() });
        return;
      }
    }
  }`
      : `  // Non-in-memory backend: no queue_idle fast-exit (the adapter's stats
  // cannot prove the queue is drained) — the worker runs until SIGTERM /
  // SIGINT drives the drain-and-stop path above.
  const keepAliveMs = 200;
  while (!stopping) {
    await new Promise((r) => setTimeout(r, keepAliveMs));
  }`;
  // v0.3.0 — continuity is spec-carried on this shape but not emit-wired in
  // 0.3.0 (only the five agent-loop shapes are). Surface it, 0.2.3-style.
  const continuityWarning =
    ir.continuity !== undefined
      ? "// note: continuity configured but ignored on batch in 0.3.0\n"
      : "";

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: batch, ir version: ${ir.version})
${continuityWarning}${queueBuild.importLine}
import { startConsumer } from "@crewhaus/queue-consumer";
import { createInMemoryIdempotencyStore } from "@crewhaus/idempotency-keys";
import { loadRetentionConfig } from "@crewhaus/data-retention-engine";
import { createJanitor, runChatLoop } from "@crewhaus/runtime-core";
import { createRunContext } from "@crewhaus/run-context";
import { defaultCatalog } from "@crewhaus/tool-catalog";
${permImport}${hooksImport}${mcpImportBlock}${importBlock}

${initLines}${registrationBlock}
const SPEC_NAME = ${escapeJsonString(ir.name)};
const SPEC_MODEL = ${escapeJsonString(ir.agent.model)};
const SPEC_INSTRUCTIONS = ${escapeJsonString(ir.agent.instructions)};
const SPEC_QUEUE_ADAPTER = ${escapeJsonString(ir.queue.adapter)};
const SPEC_VISIBILITY_TIMEOUT_MS = ${ir.queue.visibilityTimeoutMs};
const SPEC_VISIBILITY_RENEW_MS = ${visRenewMs};
const SPEC_MAX_RETRIES = ${ir.queue.maxRetries};
const SPEC_CONCURRENCY = ${ir.concurrency};
const SPEC_IDEMPOTENCY_WINDOW_MS = ${ir.idempotencyWindowMs};${queueBuild.seedConst}${hooksConst}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(\`\${JSON.stringify(event)}\\n\`);
}

${queueBuild.buildFn}

async function main(): Promise<void> {
  // Boot-time self-heal janitor (ops item 36): evicts expired sessions on a
  // schedule (TTL eviction otherwise only fires as a list() side-effect an
  // idle worker never triggers) and reports orphaned tool_use entries in
  // recent transcripts (report-only). Eviction honors
  // .crewhaus/retention.json (ops item 35) — the SAME pins +
  // sessions.maxAgeDays the \`crewhaus retention\` CLI enforces; a malformed
  // config fails safe (eviction disabled, worker keeps running). The report
  // goes to stderr so the stdout JSON event stream stays untouched.
  // CREWHAUS_JANITOR=0 disables entirely; CREWHAUS_JANITOR_INTERVAL_MS
  // overrides the hourly re-run (0 keeps only the boot run; the timer is
  // unref'd so the queue_idle exit path still terminates the process).
  let retentionTtlDays: number;
  let retentionPins: readonly string[] = [];
  try {
    const retention = await loadRetentionConfig(process.cwd());
    retentionTtlDays = retention.sessionMaxAgeDays;
    retentionPins = retention.pins;
  } catch (err) {
    process.stderr.write(
      \`[batch-worker] .crewhaus/retention.json unreadable — janitor session eviction disabled: \${(err as Error).message}\\n\`,
    );
    retentionTtlDays = Number.POSITIVE_INFINITY; // fail-safe: evict nothing
  }
  const janitor = createJanitor({
    sessionTtlDays: retentionTtlDays,
    pinnedSessionIds: retentionPins,
  });
  if (process.env["CREWHAUS_JANITOR"] !== "0") {
    const janitorReport = await janitor.runOnce();
    process.stderr.write(\`[janitor] \${JSON.stringify(janitorReport.steps)}\\n\`);
    janitor.start(Number(process.env["CREWHAUS_JANITOR_INTERVAL_MS"] ?? 3_600_000));
  }

${mcpBoot}  const queue = buildQueue();
  const idempotencyStore = createInMemoryIdempotencyStore<string>();
  emit({ kind: "worker_start", queueAdapter: SPEC_QUEUE_ADAPTER, concurrency: SPEC_CONCURRENCY });

  const consumer = startConsumer<string, string>({
    queue,
    handler: async (input, ctx) => {
      emit({ kind: "job_start", jobId: ctx.job.id, attempt: ctx.job.attempt });
      const runContext = createRunContext();
      const reply = await runChatLoop({
        model: SPEC_MODEL,
        instructions: SPEC_INSTRUCTIONS,${poolField(ir, "        ")}${taxonomyField(ir, "        ")}
        runContext,
        sessionName: SPEC_NAME,
        sessionTarget: "batch",
        singleTurn: true,
        seedMessages: [{ role: "user", content: input }],
        tools: defaultCatalog.list(),
        installSigintHandler: false,
        maxTokens: ${ir.agent.maxTokens ?? 1024},${budgetField(ir, "        ")}${limitsFields(ir, "        ")}${hooksField}${permField}
      });
      return reply.trim();
    },
    concurrency: SPEC_CONCURRENCY,
    visibilityTimeoutMs: SPEC_VISIBILITY_TIMEOUT_MS,
    visibilityRenewIntervalMs: SPEC_VISIBILITY_RENEW_MS,
    maxRetries: SPEC_MAX_RETRIES,
    idempotencyStore,
    idempotencyTtlMs: SPEC_IDEMPOTENCY_WINDOW_MS,
    observer: {
      onJobEnd: (job, outcome) => {
        if (outcome.kind === "ok") {
          emit({ kind: "job_end", jobId: job.id, attempt: job.attempt, status: "ok", fromCache: outcome.fromCache });
        } else {
          emit({
            kind: "job_end",
            jobId: job.id,
            attempt: job.attempt,
            status: "fail",
            reason: outcome.reason,
            error: (outcome.error as Error).message ?? String(outcome.error),
          });
        }
      },
      onDrainStart: () => emit({ kind: "drain_start", inFlight: consumer.inFlight() }),
      onDrainEnd: () => emit({ kind: "drain_end" }),
    },
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    janitor.stop();
    emit({ kind: "shutdown_received", signal });
    await consumer.drain();${mcpShutdownCleanup}
    const stats = await queue.stats();
    emit({ kind: "worker_stop", stats });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

${idleLoop}
}

main().catch((err) => {
  process.stderr.write(\`[batch-worker] fatal: \${(err as Error).message}\\n\`);
  process.exit(1);
});
`;
}
