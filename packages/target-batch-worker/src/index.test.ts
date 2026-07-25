import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IrBatchV0 } from "@crewhaus/ir";
import { TargetEmitError, emitBatchWorker } from "./index.js";

const baseIr: IrBatchV0 = {
  version: 0,
  name: "hello-batch",
  target: "batch",
  agent: {
    model: "claude-haiku-4-5-20251001",
    instructions: "You are a batch worker.",
  },
  queue: {
    adapter: "in-memory",
    visibilityTimeoutMs: 30_000,
    maxRetries: 3,
    seedJobs: ["job 1 input", "job 2 input"],
  },
  concurrency: 4,
  idempotencyWindowMs: 60_000,
  tools: [],
  toolConfigs: Object.freeze({}),
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

describe("emitBatchWorker", () => {
  test("emits agent.ts plus the generated README.md (T1 bundle structure, item 42)", () => {
    const bundle = emitBatchWorker(baseIr);
    expect(bundle.files).toHaveLength(2);
    expect(bundle.files[0]?.path).toBe("agent.ts");
    expect(bundle.files[1]?.path).toBe("README.md");
  });

  test("readme: false restores the single-file bundle (item 42 opt-out)", () => {
    const bundle = emitBatchWorker(baseIr, { readme: false });
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("agent.ts wires queue-protocol + queue-consumer + idempotency-keys", () => {
    const code = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(code).toContain("@crewhaus/queue-protocol");
    expect(code).toContain("@crewhaus/queue-consumer");
    expect(code).toContain("@crewhaus/idempotency-keys");
    expect(code).toContain("createInMemoryQueue");
    expect(code).toContain("startConsumer");
  });

  test("seeds the in-memory queue with the spec's seedJobs", () => {
    const code = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(code).toContain('"job 1 input"');
    expect(code).toContain('"job 2 input"');
    expect(code).toContain("initialJobs: SPEC_SEED_JOBS");
  });

  test("hard-codes concurrency / visibilityTimeoutMs / idempotencyWindowMs from the spec", () => {
    const code = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(code).toContain("SPEC_CONCURRENCY = 4");
    expect(code).toContain("SPEC_VISIBILITY_TIMEOUT_MS = 30000");
    expect(code).toContain("SPEC_IDEMPOTENCY_WINDOW_MS = 60000");
    expect(code).toContain("SPEC_MAX_RETRIES = 3");
  });

  test("emits SIGTERM/SIGINT shutdown handlers and a queue_idle exit path", () => {
    const code = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(code).toContain('process.on("SIGINT"');
    expect(code).toContain('process.on("SIGTERM"');
    expect(code).toContain('"queue_idle"');
    expect(code).toContain('"worker_stop"');
  });

  test("boots the self-heal janitor before consuming (ops #36)", () => {
    const code = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(code).toContain('import { createJanitor, runChatLoop } from "@crewhaus/runtime-core"');
    expect(code).toContain("const janitor = createJanitor({");
    // Boot-time runOnce, env kill-switch, and configurable hourly interval.
    expect(code).toContain('process.env["CREWHAUS_JANITOR"] !== "0"');
    expect(code).toContain("await janitor.runOnce()");
    expect(code).toContain(
      'janitor.start(Number(process.env["CREWHAUS_JANITOR_INTERVAL_MS"] ?? 3_600_000))',
    );
    // The report goes to stderr so the stdout JSON event stream is untouched.
    expect(code).toContain("process.stderr.write(`[janitor]");
    // Both the signal path and the queue_idle exit path halt the interval.
    expect(code.split("janitor.stop();").length - 1).toBe(2);
  });

  test("janitor honors .crewhaus/retention.json pins + TTL (ops-review F2)", () => {
    const code = emitBatchWorker(baseIr).files[0]?.content ?? "";
    // The SAME loader the retention CLI uses, so the two paths cannot drift.
    expect(code).toContain('import { loadRetentionConfig } from "@crewhaus/data-retention-engine"');
    expect(code).toContain("await loadRetentionConfig(process.cwd())");
    expect(code).toContain("sessionTtlDays: retentionTtlDays");
    expect(code).toContain("pinnedSessionIds: retentionPins");
    // A malformed config fails safe: eviction disabled, worker keeps running.
    expect(code).toContain("retentionTtlDays = Number.POSITIVE_INFINITY");
    expect(code).toContain("janitor session eviction disabled");
  });

  test("the in-memory buildQueue text is byte-stable (pre-continuity pin guard)", () => {
    // The compiler's pre-continuity byte-restore fixtures pin the in-memory
    // batch bundle EXACTLY — including this historical (now unreachable)
    // throw arm. G06 must not disturb it.
    const code = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(code).toContain('if (SPEC_QUEUE_ADAPTER === "in-memory") {');
    expect(code).toContain("not implemented in v0");
    expect(code).not.toContain("requireQueueEnv");
  });

  test("rejects unknown spec-side tool names at compile time", () => {
    const ir: IrBatchV0 = {
      ...baseIr,
      tools: ["nonexistent"],
    };
    expect(() => emitBatchWorker(ir)).toThrow(TargetEmitError);
  });

  test("permissions block: passes spec yaml-source rules through", () => {
    const ir: IrBatchV0 = {
      ...baseIr,
      permissions: {
        mode: "default",
        rules: [{ type: "alwaysAllow", pattern: "Read" }],
      },
    };
    const code = emitBatchWorker(ir).files[0]?.content ?? "";
    expect(code).toContain('permissionMode: "default"');
    expect(code).toContain('pattern: "Read"');
    expect(code).toContain("BUILTIN_DEFAULT_RULES");
  });
});

describe("emitBatchWorker — env-driven queue adapters (G06, Batch A)", () => {
  const withAdapter = (adapter: IrBatchV0["queue"]["adapter"]): IrBatchV0 => ({
    ...baseIr,
    queue: { adapter, visibilityTimeoutMs: 30_000, maxRetries: 3 },
  });

  test("sqs: buildQueue resolves SQS_QUEUE_URL + region from env and fails fast when missing", () => {
    const c = emitBatchWorker(withAdapter("sqs")).files[0]?.content ?? "";
    expect(c).toContain(
      'import { createSqsAdapter, type QueueAdapter } from "@crewhaus/queue-protocol";',
    );
    expect(c).toContain('requireQueueEnv("SQS_QUEUE_URL"');
    expect(c).toContain('process.env["AWS_REGION"]');
    expect(c).toContain('process.env["AWS_DEFAULT_REGION"]');
    expect(c).toContain("createSqsAdapter<string>({");
    // Credentials stay optional — the SDK's own chain is the fallback.
    expect(c).toContain('process.env["AWS_ACCESS_KEY_ID"]');
    expect(c).not.toContain('requireQueueEnv("AWS_ACCESS_KEY_ID"');
    // The env gate names the adapter, the variable, and its shape.
    expect(c).toContain(
      "requires the ${name} environment variable (${hint}) — set it and restart the worker.",
    );
    // No in-memory plumbing leaks into an sqs bundle.
    expect(c).not.toContain("createInMemoryQueue");
    expect(c).not.toContain("SPEC_SEED_JOBS");
    expect(c).not.toContain("not implemented in v0");
  });

  test("redis-streams: buildQueue gates on REDIS_URL and derives stream identifiers from the spec name (env-overridable)", () => {
    const c = emitBatchWorker(withAdapter("redis-streams")).files[0]?.content ?? "";
    expect(c).toContain(
      'import { createRedisStreamsAdapter, type QueueAdapter } from "@crewhaus/queue-protocol";',
    );
    expect(c).toContain('requireQueueEnv("REDIS_URL"');
    expect(c).toContain(
      'streamKey: process.env["REDIS_STREAM_KEY"] ?? `crewhaus:${SPEC_NAME}:jobs`,',
    );
    expect(c).toContain(
      'consumerGroup: process.env["REDIS_CONSUMER_GROUP"] ?? `crewhaus:${SPEC_NAME}:workers`,',
    );
    expect(c).toContain(
      'consumerName: process.env["REDIS_CONSUMER_NAME"] ?? `worker-${process.pid}`,',
    );
    expect(c).not.toContain("createInMemoryQueue");
  });

  test("postgres: buildQueue gates on DATABASE_URL with env-overridable table names", () => {
    const c = emitBatchWorker(withAdapter("postgres")).files[0]?.content ?? "";
    expect(c).toContain(
      'import { createPostgresAdapter, type QueueAdapter } from "@crewhaus/queue-protocol";',
    );
    expect(c).toContain('requireQueueEnv("DATABASE_URL"');
    expect(c).toContain('tableName: process.env["CREWHAUS_JOBS_TABLE"] ?? "crewhaus_jobs",');
    expect(c).toContain('process.env["CREWHAUS_JOBS_DLQ_TABLE"]');
    expect(c).not.toContain("createInMemoryQueue");
  });

  test("non-in-memory workers run until signaled — no queue_idle fast-exit", () => {
    const c = emitBatchWorker(withAdapter("sqs")).files[0]?.content ?? "";
    expect(c).not.toContain('"queue_idle"');
    expect(c).toContain("const keepAliveMs = 200;");
    // Only the signal path stops the janitor now.
    expect(c.split("janitor.stop();").length - 1).toBe(1);
  });

  test("the in-memory queue_idle fast-exit is untouched (byte-identity guard)", () => {
    const c = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(c).toContain('"queue_idle"');
    expect(c).not.toContain("keepAliveMs");
  });
});

describe("emitBatchWorker — mcp_servers wiring (G05, Batch A)", () => {
  const irMcp: IrBatchV0 = {
    ...baseIr,
    mcp_servers: {
      fs: { transport: "stdio", command: "npx", args: ["-y", "fs-server"] },
    },
  };

  test("boots the McpHost ONCE before the consumer and registers onto defaultCatalog (wire-once)", () => {
    const c = emitBatchWorker(irMcp).files[0]?.content ?? "";
    expect(c).toContain('import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";');
    expect(c).toContain('import { registerMcpServer } from "@crewhaus/tool-mcp";');
    expect(c).toContain("new McpHost();");
    expect(c).toContain('mcpHost.addServer("fs"');
    expect(c).toContain('registerMcpServer(mcpHost, "fs", defaultCatalog');
    // Wired before the queue/consumer boot so the first pulled job already
    // sees the namespaced tools on defaultCatalog.
    expect(c.indexOf("new McpHost();")).toBeLessThan(c.indexOf("const queue = buildQueue();"));
    expect(c.indexOf("new McpHost();")).toBeLessThan(c.indexOf("const consumer = startConsumer"));
  });

  test("secret-ref env values are embedded UNRESOLVED and resolved at boot", () => {
    const ir: IrBatchV0 = {
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
    const c = emitBatchWorker(ir).files[0]?.content ?? "";
    expect(c).toContain('resolveMcpServerConfig({"transport":"stdio"');
    expect(c).toContain('{"kind":"env","name":"API_KEY"}');
  });

  test("disconnects on BOTH exit paths: signal shutdown and queue_idle", () => {
    const c = emitBatchWorker(irMcp).files[0]?.content ?? "";
    expect(c.split("await mcpHost.disconnectAll();").length - 1).toBe(2);
  });

  test("empty mcp_servers emits zero MCP plumbing (byte-identity guard)", () => {
    const c = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(c).not.toContain("McpHost");
    expect(c).not.toContain("registerMcpServer");
  });
});

describe("emitBatchWorker — loop contract 0.4 threading (Batch A)", () => {
  test("agent.max_tokens replaces the 1024 default in the per-job runChatLoop", () => {
    const ir: IrBatchV0 = { ...baseIr, agent: { ...baseIr.agent, maxTokens: 7000 } };
    const c = emitBatchWorker(ir).files[0]?.content ?? "";
    expect(c).toContain("maxTokens: 7000,");
    expect(c).not.toContain("maxTokens: 1024,");
  });

  test("an omitted max_tokens keeps the shape's 1024 default (byte-identity guard)", () => {
    const c = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(c).toContain("maxTokens: 1024,");
  });

  test("budget threads into the per-job loop (item 27 — per-job ceiling)", () => {
    const ir: IrBatchV0 = {
      ...baseIr,
      budget: { usdMicros: 5_000_000, onExceed: { kind: "degrade", model: "cheap-model" } },
    };
    const c = emitBatchWorker(ir).files[0]?.content ?? "";
    expect(c).toContain(
      'budget: {"usdMicros":5000000,"onExceed":{"kind":"degrade","model":"cheap-model"}},',
    );
  });

  test("every declared limits knob threads as its runtime option", () => {
    const ir: IrBatchV0 = {
      ...baseIr,
      limits: {
        maxToolIterations: 12,
        maxConcurrentTools: 2,
        contextLimit: 100_000,
        deadlineMs: 25_000,
        turnTimeoutMs: 20_000,
        modelCallTimeoutMs: 15_000,
        loopDetection: { window: 4, threshold: 2, escalation: "warn" },
      },
    };
    const c = emitBatchWorker(ir).files[0]?.content ?? "";
    expect(c).toContain("maxToolIterations: 12,");
    expect(c).toContain("maxConcurrentTools: 2,");
    expect(c).toContain("contextLimit: 100000,");
    expect(c).toContain("deadlineMs: 25000,");
    expect(c).toContain("turnTimeoutMs: 20000,");
    expect(c).toContain("modelCallTimeoutMs: 15000,");
    expect(c).toContain('loopDetection: {"window":4,"threshold":2,"escalation":"warn"},');
  });

  test("partial limits emits only the declared knobs (runtime owns the defaults)", () => {
    const ir: IrBatchV0 = { ...baseIr, limits: { maxConcurrentTools: 2 } };
    const c = emitBatchWorker(ir).files[0]?.content ?? "";
    expect(c).toContain("maxConcurrentTools: 2,");
    expect(c).not.toContain("maxToolIterations:");
    expect(c).not.toContain("loopDetection:");
  });

  test("no limits block → zero limits codegen (byte-identity guard)", () => {
    const c = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(c).not.toContain("maxToolIterations:");
    expect(c).not.toContain("deadlineMs:");
  });

  test("spec hooks land as a SPEC_HOOKS const threaded into the per-job loop", () => {
    const ir: IrBatchV0 = {
      ...baseIr,
      hooks: [
        { event: "pre-tool", matcher: "Bash", command: "guard.sh", timeoutMs: 3000 },
        { event: "stop", command: "notify.sh" },
      ],
    };
    const c = emitBatchWorker(ir).files[0]?.content ?? "";
    expect(c).toContain('import type { HookDef } from "@crewhaus/hooks-engine";');
    expect(c).toContain("const SPEC_HOOKS: ReadonlyArray<HookDef> = ");
    // Declaration order preserved — hooks run in registration order.
    expect(c).toContain(
      '[{"event":"pre-tool","matcher":"Bash","command":"guard.sh","timeoutMs":3000},{"event":"stop","command":"notify.sh"}]',
    );
    expect(c).toContain("hooks: SPEC_HOOKS,");
  });

  test("absent/empty hooks emit nothing (byte-identity guard)", () => {
    expect(emitBatchWorker(baseIr).files[0]?.content ?? "").not.toContain("SPEC_HOOKS");
    const empty: IrBatchV0 = { ...baseIr, hooks: [] };
    expect(emitBatchWorker(empty).files[0]?.content ?? "").not.toContain("SPEC_HOOKS");
  });
});

describe("emitBatchWorker — failureTaxonomy field (item 23)", () => {
  test("threads failureTaxonomy into the per-job runChatLoop call", () => {
    const ir: IrBatchV0 = {
      ...baseIr,
      failureTaxonomy: [
        { class: "rate_limited", pattern: "/429|rate.?limit/i", recovery: "retry" },
        { class: "tool_timeout", pattern: "ETIMEDOUT", recovery: "continue", hint: "slow tool" },
      ],
    };
    const c = emitBatchWorker(ir).files[0]?.content ?? "";
    expect(c).toContain("failureTaxonomy:");
    expect(c).toContain('"recovery":"retry"');
    expect(c).toContain('"pattern":"ETIMEDOUT"');
  });

  test("omits failureTaxonomy when the IR leaves it unset or empty", () => {
    expect(emitBatchWorker(baseIr).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
    const empty: IrBatchV0 = { ...baseIr, failureTaxonomy: [] };
    expect(emitBatchWorker(empty).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
  });
});

describe("emitBatchWorker — schedule: wake loop (Batch F, temporal contract)", () => {
  const withInterval: IrBatchV0 = {
    ...baseIr,
    schedule: { kind: "interval", everyMs: 3_600_000, instructions: "Reconcile ledgers." },
  };
  const withCron: IrBatchV0 = {
    ...baseIr,
    schedule: { kind: "cron", cron: "*/15 * * * *", jitterMs: 500 },
  };

  test("no schedule → agent.ts stays byte-identical (no schedule plumbing)", () => {
    const code = emitBatchWorker(baseIr).files[0]?.content ?? "";
    expect(code).not.toContain("armSchedule");
    expect(code).not.toContain("@crewhaus/durable-execution");
    expect(code).not.toContain("scheduled_wake");
    // unscheduled in-memory worker keeps the idle fast-exit path.
    expect(code).toContain("queue_idle");
  });

  test("interval schedule arms armSchedule and enqueues the wake prompt as a job", () => {
    const code = emitBatchWorker(withInterval).files[0]?.content ?? "";
    expect(code).toContain('import { armSchedule } from "@crewhaus/durable-execution";');
    expect(code).toContain('armSchedule({"kind":"interval","everyMs":3600000}');
    expect(code).toContain("const jobId = await queue.enqueue(__scheduleInstructions);");
    expect(code).toContain('emit({ kind: "scheduled_wake", tick: __scheduleTick, jobId });');
    expect(code).toContain("Reconcile ledgers.");
    expect(code).toContain("__schedule.cancel();");
  });

  test("a scheduled in-memory worker drops the idle fast-exit for the keep-alive loop", () => {
    const code = emitBatchWorker(withInterval).files[0]?.content ?? "";
    // No queue_idle fast-exit — the scheduler is a long-running cron daemon.
    expect(code).not.toContain('emit({ kind: "queue_idle"');
    expect(code).toContain("const keepAliveMs = 200;");
  });

  test("cron schedule carries the verbatim cron + jitter (no instructions in the literal)", () => {
    const code = emitBatchWorker(withCron).files[0]?.content ?? "";
    expect(code).toContain('armSchedule({"kind":"cron","cron":"*/15 * * * *","jitterMs":500}');
    expect(code).toContain('"[scheduled wake]"'); // default prompt when instructions absent
    expect(code).toContain('kind: "schedule_armed"');
  });

  test("cancel runs before drain in the shutdown path", () => {
    const code = emitBatchWorker(withInterval).files[0]?.content ?? "";
    const shutdownIdx = code.indexOf("const shutdown = async");
    const cancelIdx = code.indexOf("__schedule.cancel();", shutdownIdx);
    const drainIdx = code.indexOf("await consumer.drain();", shutdownIdx);
    expect(cancelIdx).toBeGreaterThan(shutdownIdx);
    expect(cancelIdx).toBeLessThan(drainIdx);
  });
});

/**
 * Audit item 22 — the emitted worker's observable output (its stdout JSON
 * event stream) never contained a model reply: `onJobEnd` published only
 * status fields, so a batch take was made entirely of status JSON and the
 * work product was recoverable only from the session transcript. (The live
 * batch runtime smoke asserts the model's magic token appears in the
 * worker's stdout — an assertion nothing could satisfy.)
 *
 * These tests lift the emitted `onJobEnd` observer out of the generated
 * source, load it as a real module, and RUN it against a stub `emit`, so
 * the assertion is on behaviour rather than on the presence of a substring.
 */
describe("emitBatchWorker — job_end carries the handler result (item 22)", () => {
  type Emitted = Record<string, unknown>;
  type Observer = {
    onJobEnd: (job: { id: string; attempt: number }, outcome: unknown) => void;
  };

  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Slice the `observer.onJobEnd` property out of the emitted agent.ts and
   * re-host it in a throwaway module that takes `emit` as a parameter. The
   * emitted handler closes over nothing but its own arguments and globals,
   * so this runs the generated code unmodified.
   */
  async function emittedObserver(): Promise<{ observer: Observer; emitted: Emitted[] }> {
    const code = emitBatchWorker(baseIr, { readme: false }).files[0]?.content ?? "";
    const start = code.indexOf("onJobEnd:");
    const end = code.indexOf("onDrainStart:", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-batch-observer-"));
    tmpDirs.push(dir);
    const file = join(dir, "observer.ts");
    writeFileSync(
      file,
      `export function makeObserver(emit: (e: Record<string, unknown>) => void) {\n  return {\n    ${code.slice(start, end)}  };\n}\n`,
    );
    const mod = (await import(pathToFileURL(file).href)) as {
      makeObserver: (emit: (e: Emitted) => void) => Observer;
    };
    const emitted: Emitted[] = [];
    return { observer: mod.makeObserver((e) => void emitted.push(e)), emitted };
  }

  test("a successful job_end includes the reply verbatim + its byte size", async () => {
    const { observer, emitted } = await emittedObserver();
    observer.onJobEnd(
      { id: "job_00000001", attempt: 1 },
      { kind: "ok", value: "a single concise sentence.", fromCache: false },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      kind: "job_end",
      jobId: "job_00000001",
      attempt: 1,
      status: "ok",
      fromCache: false,
      resultBytes: 26,
      result: "a single concise sentence.",
    });
  });

  test("resultBytes counts UTF-8 bytes, not code units", async () => {
    const { observer, emitted } = await emittedObserver();
    observer.onJobEnd(
      { id: "job_00000002", attempt: 1 },
      { kind: "ok", value: "né", fromCache: true },
    );
    expect(emitted[0]?.["resultBytes"]).toBe(3);
    expect(emitted[0]?.["fromCache"]).toBe(true);
  });

  test("CREWHAUS_BATCH_EMIT_RESULT=0 drops the payload but keeps resultBytes", async () => {
    const { observer, emitted } = await emittedObserver();
    const EMIT_RESULT_ENV = "CREWHAUS_BATCH_EMIT_RESULT";
    const prev = process.env[EMIT_RESULT_ENV];
    process.env[EMIT_RESULT_ENV] = "0";
    try {
      observer.onJobEnd(
        { id: "job_00000003", attempt: 1 },
        { kind: "ok", value: "sensitive", fromCache: false },
      );
    } finally {
      if (prev === undefined) delete process.env[EMIT_RESULT_ENV];
      else process.env[EMIT_RESULT_ENV] = prev;
    }
    expect(emitted[0]).not.toHaveProperty("result");
    expect(emitted[0]?.["resultBytes"]).toBe(9);
  });

  test("a failed job_end still carries reason + error and no result", async () => {
    const { observer, emitted } = await emittedObserver();
    observer.onJobEnd(
      { id: "job_00000004", attempt: 3 },
      { kind: "fail", reason: "permanent", error: new Error("boom") },
    );
    expect(emitted[0]).toEqual({
      kind: "job_end",
      jobId: "job_00000004",
      attempt: 3,
      status: "fail",
      reason: "permanent",
      error: "boom",
    });
  });
});

describe("emitBatchWorker — emitted scheduled bundle is syntactically valid TS", () => {
  test("Bun.Transpiler parses the scheduled agent.ts", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    const ir: IrBatchV0 = {
      ...baseIr,
      schedule: { kind: "interval", everyMs: 3_600_000, instructions: "tick" },
    };
    const code = emitBatchWorker(ir, { readme: false }).files[0]?.content ?? "";
    expect(() => t.transformSync(code)).not.toThrow();
  });
});
