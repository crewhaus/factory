/**
 * Isolated tests for the lazy `getOrCreateSandbox()` path and the
 * `getCodeExecutionConfig()` getter.
 *
 * The main `index.test.ts` always registers an explicit `sandbox`, so
 * `activeSandbox` is set directly and `createSandbox()` is never called —
 * leaving the lazy-construction branch (and its four optional config
 * spreads) uncovered. Here we register a config WITHOUT a sandbox and stub
 * `@crewhaus/sandbox`'s `createSandbox` so no real Docker/Podman sandbox is
 * ever constructed (no child processes, no network, no I/O).
 *
 * `mock.module` mutates the process-global module registry, and Bun does NOT
 * give each test file a fresh module graph — all files in a `bun test` run
 * share one process, in nondeterministic order. The stub therefore lives in
 * its own file AND is torn down in `afterAll` by re-mocking the real module,
 * so it cannot leak into `index.test.ts` when this file runs first.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type {
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxOptions,
} from "@crewhaus/sandbox";

// SNAPSHOT of the real module, captured BEFORE the mock below so afterAll can
// reinstall it. The spread matters: an ESM namespace is a live view, so after
// `mock.module` patches the module its properties resolve to the stub —
// restoring from the namespace would reinstall the stub.
const realSandboxModule = { ...(await import("@crewhaus/sandbox")) };

// Records every `createSandbox` call so we can assert the config is threaded
// through. The returned sandbox is a fully in-memory stub whose run method
// never touches a container.
const createCalls: SandboxOptions[] = [];

const runStub = async (opts: SandboxExecOptions): Promise<SandboxExecResult> => ({
  stdout: `ran:${opts.image}`,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
});

function stubSandbox(): Sandbox {
  return {
    backend: "noop" as const,
    exec: runStub,
    close: async (): Promise<void> => {},
  };
}

mock.module("@crewhaus/sandbox", () => ({
  createSandbox: (opts: SandboxOptions = {}): Sandbox => {
    createCalls.push(opts);
    return stubSandbox();
  },
}));

// Import the unit under test AFTER the stub is registered so its
// `import { createSandbox } from "@crewhaus/sandbox"` binding resolves to the
// stub above instead of the real container factory.
const { _resetCodeExecutionConfig, getCodeExecutionConfig, registerCodeExecutionConfig, python } =
  await import("./index");

afterEach(() => {
  _resetCodeExecutionConfig();
  createCalls.length = 0;
});

afterAll(() => {
  // Reinstall the real module so the stub cannot outlive this file.
  mock.module("@crewhaus/sandbox", () => realSandboxModule);
});

describe("getCodeExecutionConfig", () => {
  test("returns the registered config object", () => {
    registerCodeExecutionConfig({
      allowedImages: ["python:3.13-slim"],
      defaultTimeoutMs: 9_000,
    });
    const cfg = getCodeExecutionConfig();
    expect(cfg.allowedImages).toEqual(["python:3.13-slim"]);
    expect(cfg.defaultTimeoutMs).toBe(9_000);
  });

  test("defaults to an empty config after reset", () => {
    _resetCodeExecutionConfig();
    expect(getCodeExecutionConfig()).toEqual({});
  });
});

describe("getOrCreateSandbox — lazy construction (no explicit sandbox)", () => {
  test("constructs a sandbox lazily, threading every optional field", async () => {
    registerCodeExecutionConfig({
      backend: "noop",
      allowedImages: ["python:3.13-slim"],
      mountWhitelist: ["/srv"],
      defaultTimeoutMs: 12_345,
    });

    const out = (await python.execute({ code: "print(1)" })) as string;
    expect(out).toContain("[exit] 0");

    // Factory called exactly once with all four optional fields present
    // (covers every conditional spread in getOrCreateSandbox).
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({
      backend: "noop",
      allowedImages: ["python:3.13-slim"],
      mountWhitelist: ["/srv"],
      defaultTimeoutMs: 12_345,
    });
  });

  test("caches the lazily-created sandbox across calls (single construction)", async () => {
    registerCodeExecutionConfig({ backend: "noop" });
    await python.execute({ code: "x" });
    await python.execute({ code: "y" });
    // Second call hits the `activeSandbox !== undefined` early-return.
    expect(createCalls).toHaveLength(1);
  });

  test("omits optional fields entirely when the config leaves them unset", async () => {
    // Register with no sandbox and no optional knobs → every conditional spread
    // takes its false branch, producing an empty options object.
    registerCodeExecutionConfig({});
    await python.execute({ code: "x" });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({});
  });
});
