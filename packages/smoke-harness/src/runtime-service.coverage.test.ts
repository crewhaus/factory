/**
 * Deterministic coverage for `runtime-service.ts`.
 *
 * The production functions compile a runtime fixture to disk and spawn
 * the emitted bundle as a child process. We keep the REAL `compile()`
 * (the batch fixture is tiny and the compiler is well-covered elsewhere;
 * crucially, mocking the shared `@crewhaus/compiler` via process-global
 * `mock.module` leaks into sibling test files), and instead:
 *   - spy `Bun.spawn` so no real process is ever launched. The fake
 *     subprocess streams a scripted stdout/stderr and resolves `exited`
 *     with a scripted code, fully under the test's control;
 *   - spy `setTimeout`/`clearTimeout` in the one test that exercises the
 *     watchdog-kill path, so the timeout branch fires synchronously with
 *     no wall-clock delay and no dangling handle.
 *
 * `Bun.spawn`/env are restored in `afterEach` so each test starts clean
 * and nothing leaks to sibling files. The compiled bundle is written to
 * a temp dir the production `finally` removes.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  runBatchRuntimeSmoke,
  runChannelRuntimeSmoke,
  runOnchainRuntimeSmoke,
  runVoiceRuntimeSmoke,
} from "./runtime-service.js";

// ---------------------------------------------------------------------------
// env helpers — drive runtimeSmokeIsEnabled() and the per-shape gates.
// ---------------------------------------------------------------------------

const TOUCHED_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "SMOKE_SLACK_BOT_TOKEN",
  "SMOKE_SLACK_SIGNING_SECRET",
  "SMOKE_ONCHAIN_RPC",
  "SMOKE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of TOUCHED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
});

/** Real-looking key so runtimeSmokeIsEnabled() returns true. */
function enableAnthropic(): void {
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-smoke-not-test-no-call";
}

// ---------------------------------------------------------------------------
// Fake subprocess + Bun.spawn spy.
// ---------------------------------------------------------------------------

type FakeProcCfg = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

let spawnSpy: ReturnType<typeof spyOn> | undefined;
/** Records the SpawnOptions of the most recent fake spawn for assertions. */
let lastSpawnOpts: { env?: Record<string, string>; cwd?: string } | undefined;
/** Mock kill so the watchdog-kill test can assert it fired. */
const killMock = mock((_sig?: unknown) => {});

function installSpawn(cfg: FakeProcCfg): void {
  lastSpawnOpts = undefined;
  killMock.mockClear();
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
    _cmd: unknown,
    opts: unknown,
  ): ReturnType<typeof Bun.spawn> => {
    lastSpawnOpts = opts as { env?: Record<string, string>; cwd?: string };
    return {
      stdout: new Blob([cfg.stdout ?? ""]).stream(),
      stderr: new Blob([cfg.stderr ?? ""]).stream(),
      exited: Promise.resolve(cfg.exitCode ?? 0),
      kill: killMock,
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn);
}

/** A scripted stdout that satisfies every batch happy-path assertion. */
const HAPPY_BATCH_STDOUT = [
  JSON.stringify({ kind: "worker_start" }),
  JSON.stringify({ kind: "job_start", id: 1 }),
  JSON.stringify({ kind: "job_start", id: 2 }),
  "not json at all — exercises the parse-failure catch",
  "", // blank line — exercises the length===0 continue
  JSON.stringify({ noKind: true }), // valid JSON but no `kind` — skipped
  "this job replied smoke-batch-ok",
  JSON.stringify({ kind: "job_end", id: 1 }),
  JSON.stringify({ kind: "job_end", id: 2 }),
  JSON.stringify({ kind: "worker_stop" }),
].join("\n");

// ---------------------------------------------------------------------------
// batch — the only runnable shape.
// ---------------------------------------------------------------------------

describe("runBatchRuntimeSmoke", () => {
  test("skips cleanly when no Anthropic auth is configured", async () => {
    // No installSpawn — the skip branch must return before spawning.
    const result = await runBatchRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.shape).toBe("batch");
    expect(result.failures).toEqual([]);
    expect(result.skipReason).toContain("ANTHROPIC");
  });

  test("happy path: drains the queue, emits the expected event stream, status ok", async () => {
    enableAnthropic();
    process.env["ANTHROPIC_AUTH_TOKEN"] = "oauth-token-xyz"; // exercise oauth env branch
    installSpawn({ stdout: HAPPY_BATCH_STDOUT, stderr: "warn: noop\n", exitCode: 0 });

    const result = await runBatchRuntimeSmoke();

    expect(result.status).toBe("ok");
    expect(result.failures).toEqual([]);
    expect(result.shape).toBe("batch");
    expect(result.stdout).toContain("smoke-batch-ok");
    expect(result.stderr).toBe("warn: noop\n");
    // Parsed event stream excludes the blank/non-JSON/kind-less lines.
    const kinds = (result.events ?? []).map((e) => e.kind);
    expect(kinds).toEqual([
      "worker_start",
      "job_start",
      "job_start",
      "job_end",
      "job_end",
      "worker_stop",
    ]);
    // forwardAuthEnv forwarded both auth paths + the session dir extra.
    expect(lastSpawnOpts?.env?.["ANTHROPIC_API_KEY"]).toBe("sk-ant-smoke-not-test-no-call");
    expect(lastSpawnOpts?.env?.["ANTHROPIC_AUTH_TOKEN"]).toBe("oauth-token-xyz");
    expect(lastSpawnOpts?.env?.["CREWHAUS_SESSION_DIR"]).toMatch(/crewhaus-runtime-batch-session-/);
  });

  test("collects every failure when the worker misbehaves (non-zero exit, empty stream)", async () => {
    enableAnthropic();
    installSpawn({ stdout: "", stderr: "boom\n", exitCode: 3 });

    const result = await runBatchRuntimeSmoke();

    expect(result.status).toBe("failed");
    const joined = result.failures.join("\n");
    expect(joined).toContain("exited non-zero (3)");
    expect(joined).toContain('expected "worker_start"');
    expect(joined).toContain('expected "worker_stop"');
    expect(joined).toContain("expected 2 job_start events");
    expect(joined).toContain("expected 2 job_end events");
    expect(joined).toContain("smoke-batch-ok");
    // Exactly the six failures above (one per assertion).
    expect(result.failures).toHaveLength(6);
  });

  test("forwardAuthEnv omits empty/undefined auth values (only PATH forwarded)", async () => {
    // enable via a real key, but blank out oauth so its branch is skipped;
    // also set ANTHROPIC_API_KEY to a value that *enables* the run.
    enableAnthropic();
    process.env["ANTHROPIC_AUTH_TOKEN"] = ""; // empty → must NOT be forwarded
    installSpawn({ stdout: HAPPY_BATCH_STDOUT, exitCode: 0 });

    await runBatchRuntimeSmoke();

    expect(lastSpawnOpts?.env).toBeDefined();
    expect("ANTHROPIC_AUTH_TOKEN" in (lastSpawnOpts?.env ?? {})).toBe(false);
    expect(lastSpawnOpts?.env?.["ANTHROPIC_API_KEY"]).toBe("sk-ant-smoke-not-test-no-call");
    expect(lastSpawnOpts?.env?.["PATH"]).toBeDefined();
  });

  test("watchdog fires SIGKILL when the process overruns the timeout", async () => {
    enableAnthropic();
    // The fake `exited` only resolves once `kill` is invoked, so the
    // captureSubprocess Promise.all cannot settle until the watchdog
    // timer runs. We make setTimeout fire its callback synchronously so
    // there is zero wall-clock delay and no lingering handle.
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((r) => {
      resolveExited = r;
    });
    const killThenExit = mock((_sig?: unknown) => resolveExited(137));
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      ((_cmd: unknown, _opts: unknown): ReturnType<typeof Bun.spawn> =>
        ({
          stdout: new Blob([""]).stream(),
          stderr: new Blob([""]).stream(),
          exited,
          kill: killThenExit,
        }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn,
    );

    const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...a: unknown[]) => void,
    ) => {
      fn(); // run the watchdog body immediately
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => {}) as unknown as typeof clearTimeout,
    );

    try {
      const result = await runBatchRuntimeSmoke({ timeoutMs: 5 });
      // The kill was triggered by the watchdog and the worker "exited" 137.
      expect(killThenExit).toHaveBeenCalledWith("SIGKILL");
      expect(result.status).toBe("failed");
      expect(result.failures.join("\n")).toContain("exited non-zero (137)");
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// channel / onchain / voice — scaffolds: three skip layers each.
// ---------------------------------------------------------------------------

describe("runChannelRuntimeSmoke", () => {
  test("skips when Anthropic auth is missing", async () => {
    const result = await runChannelRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("ANTHROPIC");
  });

  test("skips when Slack tokens are missing", async () => {
    enableAnthropic();
    const result = await runChannelRuntimeSmoke({ timeoutMs: 1 });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("SMOKE_SLACK_BOT_TOKEN");
  });

  test("skips with the scaffold reason once Slack tokens are present", async () => {
    enableAnthropic();
    process.env["SMOKE_SLACK_BOT_TOKEN"] = "xoxb-fake";
    process.env["SMOKE_SLACK_SIGNING_SECRET"] = "signing-fake";
    const result = await runChannelRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("scaffold");
    expect(result.shape).toBe("channel");
  });
});

describe("runOnchainRuntimeSmoke", () => {
  test("skips when Anthropic auth is missing", async () => {
    const result = await runOnchainRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("ANTHROPIC");
  });

  test("skips when the chain RPC is missing", async () => {
    enableAnthropic();
    const result = await runOnchainRuntimeSmoke({ timeoutMs: 1 });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("SMOKE_ONCHAIN_RPC");
  });

  test("skips with the scaffold reason once an RPC is present", async () => {
    enableAnthropic();
    process.env["SMOKE_ONCHAIN_RPC"] = "http://127.0.0.1:8545";
    const result = await runOnchainRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("scaffold");
    expect(result.shape).toBe("onchain");
  });
});

describe("runVoiceRuntimeSmoke", () => {
  test("skips when Anthropic auth is missing", async () => {
    const result = await runVoiceRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("ANTHROPIC");
  });

  test("skips when no OpenAI key is set", async () => {
    enableAnthropic();
    const result = await runVoiceRuntimeSmoke({ timeoutMs: 1 });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("OPENAI_API_KEY");
  });

  test("scaffold reason via the OPENAI_API_KEY fallback", async () => {
    enableAnthropic();
    process.env["OPENAI_API_KEY"] = "sk-openai-fallback";
    const result = await runVoiceRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("scaffold");
  });

  test("scaffold reason via the SMOKE_OPENAI_API_KEY override", async () => {
    enableAnthropic();
    process.env["SMOKE_OPENAI_API_KEY"] = "sk-openai-override";
    const result = await runVoiceRuntimeSmoke();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toContain("scaffold");
    expect(result.shape).toBe("voice");
  });
});
