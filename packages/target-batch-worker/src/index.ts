/**
 * Catalog F2 `target-batch-worker` — Section 23 BATCH.
 *
 * Codegen for the queue-worker target. Emits a single self-contained
 * daemon (`agent.ts`) that:
 *
 *   1. Constructs the configured queue adapter (in-memory only in v0;
 *      SQS / Redis Streams / Postgres adapters stub out at the
 *      `unsupported queue adapter` error).
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
 */
import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { Bundle, IrBatchV0 } from "@crewhaus/ir";

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

export function emitBatchWorker(ir: IrBatchV0): Bundle {
  if (ir.queue.adapter !== "in-memory") {
    // v0 only ships the in-memory adapter; the others are stubs that
    // throw at runtime so the operator sees a clean diagnostic.
    // Codegen still succeeds — we emit the daemon, but boot fails.
  }
  return { files: [{ path: "agent.ts", content: renderAgent(ir) }] };
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

  const seedJobsLit = JSON.stringify(ir.queue.seedJobs ?? []);
  const visRenewMs =
    ir.queue.visibilityRenewIntervalMs ?? Math.floor(ir.queue.visibilityTimeoutMs / 4);
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";

  return `#!/usr/bin/env bun
// Generated by crewhaus-factory. DO NOT EDIT.
// Source spec: ${ir.name} (target: batch, ir version: ${ir.version})
import { createInMemoryQueue } from "@crewhaus/queue-protocol";
import { startConsumer } from "@crewhaus/queue-consumer";
import { createInMemoryIdempotencyStore } from "@crewhaus/idempotency-keys";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createRunContext } from "@crewhaus/run-context";
import { defaultCatalog } from "@crewhaus/tool-catalog";
${permImport}${importBlock}

${initLines}${registrationBlock}
const SPEC_NAME = ${escapeJsonString(ir.name)};
const SPEC_MODEL = ${escapeJsonString(ir.agent.model)};
const SPEC_INSTRUCTIONS = ${escapeJsonString(ir.agent.instructions)};
const SPEC_QUEUE_ADAPTER = ${escapeJsonString(ir.queue.adapter)};
const SPEC_VISIBILITY_TIMEOUT_MS = ${ir.queue.visibilityTimeoutMs};
const SPEC_VISIBILITY_RENEW_MS = ${visRenewMs};
const SPEC_MAX_RETRIES = ${ir.queue.maxRetries};
const SPEC_CONCURRENCY = ${ir.concurrency};
const SPEC_IDEMPOTENCY_WINDOW_MS = ${ir.idempotencyWindowMs};
const SPEC_SEED_JOBS: string[] = ${seedJobsLit};

function emit(event: Record<string, unknown>): void {
  process.stdout.write(\`\${JSON.stringify(event)}\\n\`);
}

function buildQueue(): ReturnType<typeof createInMemoryQueue<string>> {
  if (SPEC_QUEUE_ADAPTER === "in-memory") {
    return createInMemoryQueue<string>({ initialJobs: SPEC_SEED_JOBS });
  }
  throw new Error(
    "[batch-worker] queue adapter \\"" + SPEC_QUEUE_ADAPTER +
      "\\" is not implemented in v0 — only \\"in-memory\\" is supported. " +
      "SQS / Redis Streams / Postgres adapters land in a follow-up.",
  );
}

async function main(): Promise<void> {
  const queue = buildQueue();
  const idempotencyStore = createInMemoryIdempotencyStore<string>();
  emit({ kind: "worker_start", queueAdapter: SPEC_QUEUE_ADAPTER, concurrency: SPEC_CONCURRENCY });

  const consumer = startConsumer<string, string>({
    queue,
    handler: async (input, ctx) => {
      emit({ kind: "job_start", jobId: ctx.job.id, attempt: ctx.job.attempt });
      const runContext = createRunContext();
      const reply = await runChatLoop({
        model: SPEC_MODEL,
        instructions: SPEC_INSTRUCTIONS,
        runContext,
        sessionName: SPEC_NAME,
        sessionTarget: "batch",
        singleTurn: true,
        seedMessages: [{ role: "user", content: input }],
        tools: defaultCatalog.list(),
        installSigintHandler: false,
        maxTokens: 1024,${permField}
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
    emit({ kind: "shutdown_received", signal });
    await consumer.drain();
    const stats = await queue.stats();
    emit({ kind: "worker_stop", stats });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // For the hello-batch smoke: when the queue empties + no in-flight,
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
        await consumer.drain();
        emit({ kind: "worker_stop", stats: await queue.stats() });
        return;
      }
    }
  }
}

main().catch((err) => {
  process.stderr.write(\`[batch-worker] fatal: \${(err as Error).message}\\n\`);
  process.exit(1);
});
`;
}
