import { describe, expect, test } from "bun:test";
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
  test("emits a single agent.ts file (T1 bundle structure)", () => {
    const bundle = emitBatchWorker(baseIr);
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

  test("non-in-memory adapter compiles, but boot throws (clean diagnostic)", () => {
    const ir: IrBatchV0 = {
      ...baseIr,
      queue: { ...baseIr.queue, adapter: "sqs" },
    };
    const code = emitBatchWorker(ir).files[0]?.content ?? "";
    expect(code).toContain('"in-memory"');
    expect(code).toContain("not implemented in v0");
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
