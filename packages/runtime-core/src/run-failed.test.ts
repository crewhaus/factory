/**
 * v0.3.0 Goal 6 — the `halt` recovery action surfaces as a RunFailedError,
 * and every terminal failure leaves ONE structured `run_failed` behind on
 * both the trace bus and the session event log, published BEFORE the throw.
 *
 * A billing/auth-classified provider error must stop the run on the FIRST
 * model call (no tombstone detour, no backoff retries) and reject with a
 * RunFailedError whose `report` carries the class, raw provider text,
 * remediation, and coded exit status. Everything unclassified keeps the
 * pre-0.3.0 `RuntimeError("recovery failed: …")` path — that regression
 * guard lives here too, as does the inverse: successful runs and
 * non-terminal recoveries emit NO run_failed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { CrewhausError, RunFailedError, RuntimeError } from "@crewhaus/errors";
import { createRunContext } from "@crewhaus/run-context";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { runChatLoop } from "./index";

// Route session-store/event-log writes to a per-file tmpdir so tests do
// not pollute `.crewhaus/sessions/` in the repo.
const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-runtime-core-run-failed-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

/** Adapter whose every stream() call throws `err`; counts invocations. */
function alwaysThrowingAdapter(err: unknown): {
  adapter: ProviderAdapter;
  calls: () => number;
} {
  let calls = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: () => {
      calls++;
      // eslint-style async generator that throws before yielding anything.
      return (async function* () {
        throw err;
        // biome-ignore lint/correctness/noUnreachable: keeps the function a generator
        yield undefined as never;
      })();
    },
  };
  return { adapter, calls: () => calls };
}

// Real Anthropic out-of-credit shape as normalised by adapter-anthropic
// (AdapterError duck type: providerId + status + error envelope).
const BILLING_ERROR = Object.assign(
  new Error(
    "400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  ),
  {
    providerId: "anthropic",
    status: 400,
    error: {
      type: "invalid_request_error",
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
  },
);

describe("runChatLoop — halt surfaces as RunFailedError", () => {
  test("a billing error halts the run on the first model call with the classified report", async () => {
    const { adapter, calls } = alwaysThrowingAdapter(BILLING_ERROR);
    let caught: unknown;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: adapter,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "bypass",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("billing");
    expect(caught.report.exitCode).toBe(31);
    expect(caught.report.title).toBe("provider account out of funding");
    expect(caught.report.detail).toContain("Your credit balance is too low");
    expect(caught.report.remediation).toContain("https://console.anthropic.com");
    // The offending provider error rides along as the cause.
    expect(caught.cause).toBe(BILLING_ERROR);
    // Halt is immediate: exactly ONE model call — no tombstone re-request,
    // no backoff retries (the pre-0.3.0 path made 2+ calls here).
    expect(calls()).toBe(1);
  });

  test("a runtime 401 halts with the auth report (exit 30)", async () => {
    const authError = Object.assign(new Error("401 invalid x-api-key"), {
      providerId: "anthropic",
      status: 401,
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
    const { adapter, calls } = alwaysThrowingAdapter(authError);
    let caught: unknown;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: adapter,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "bypass",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("auth");
    expect(caught.report.exitCode).toBe(30);
    expect(calls()).toBe(1);
  });

  test("RunFailedError is caught by the existing CrewhausError handling (crewhaus run's die())", async () => {
    const { adapter } = alwaysThrowingAdapter(BILLING_ERROR);
    let caught: unknown;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: adapter,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "bypass",
      });
    } catch (err) {
      caught = err;
    }
    // apps/cli's run path does `if (err instanceof CrewhausError) die(err.message)`;
    // both checks below are what keeps `crewhaus run` printing a clean line.
    expect(caught).toBeInstanceOf(CrewhausError);
    expect((caught as CrewhausError).message).toContain("run stopped — ");
  });

  test("regression: an unclassifiable error still fails with the generic RuntimeError", async () => {
    const { adapter } = alwaysThrowingAdapter(
      Object.assign(new Error("something the taxonomy cannot classify"), {
        name: "WeirdError",
      }),
    );
    let caught: unknown;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: adapter,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "bypass",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RuntimeError);
    expect(caught).not.toBeInstanceOf(RunFailedError);
    expect((caught as RuntimeError).message).toMatch(/recovery failed/);
  });
});

// ---------------------------------------------------------------------------
// PR 3 — the structured `run_failed` surface: published to the trace bus AND
// appended to the session event log BEFORE the terminal throw.
// ---------------------------------------------------------------------------

/** Text-only adapter: one clean end_turn response per call. */
function happyAdapter(): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: () =>
      (async function* () {
        yield { kind: "message_start", usage: { input: 10, output: 0 } } as const;
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: 10, output: 2 },
        } as const;
        yield { kind: "message_stop" } as const;
      })(),
  };
}

/** Throws `err` on the FIRST stream() call, then answers cleanly. */
function failOnceAdapter(err: unknown): ProviderAdapter {
  let calls = 0;
  const happy = happyAdapter();
  return {
    ...happy,
    stream: (req) => {
      calls += 1;
      if (calls === 1) {
        return (async function* () {
          throw err;
          // biome-ignore lint/correctness/noUnreachable: keeps the function a generator
          yield undefined as never;
        })();
      }
      return happy.stream(req);
    },
  };
}

type LoggedLine = { kind: string; payload?: Record<string, unknown> };

function readSessionLines(rootDir: string): LoggedLine[] {
  const out: LoggedLine[] = [];
  for (const file of readdirSync(rootDir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(rootDir, file), "utf-8").split("\n")) {
      if (line === "") continue;
      out.push(JSON.parse(line) as LoggedLine);
    }
  }
  return out;
}

async function runCollecting(
  adapter: ProviderAdapter,
): Promise<{ events: TraceEvent[]; logged: LoggedLine[]; caught: unknown }> {
  const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-run-failed-surface-"));
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((ev) => {
    events.push(ev);
  });
  let caught: unknown;
  try {
    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext,
      sessionRootDir: rootDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "bypass",
    });
  } catch (err) {
    caught = err;
  }
  const logged = readSessionLines(rootDir);
  rmSync(rootDir, { recursive: true, force: true });
  return { events, logged, caught };
}

describe("run_failed — published + logged on the terminal paths (PR 3)", () => {
  test("halt: exactly one run_failed on the bus with the classified payload", async () => {
    const { adapter } = alwaysThrowingAdapter(BILLING_ERROR);
    const { events, caught } = await runCollecting(adapter);
    expect(caught).toBeInstanceOf(RunFailedError);

    const runFailed = events.filter((ev) => ev.kind === "run_failed");
    expect(runFailed.length).toBe(1);
    const ev = runFailed[0];
    if (ev?.kind !== "run_failed") throw new Error("unreachable");
    expect(ev.class).toBe("billing");
    expect(ev.exitCode).toBe(31);
    expect(ev.message).toBe(
      'provider account out of funding: Anthropic said: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."',
    );
    expect(ev.remediation).toBe(
      "add credits at https://console.anthropic.com/settings/billing, then rerun.",
    );
    // Envelope conventions hold like any other bus event.
    expect(ev.runId.length).toBeGreaterThan(0);
    expect(ev.sessionId.length).toBeGreaterThan(0);

    // The error_recovered companion now carries the first-class halt action.
    const recovered = events.filter((ev2) => ev2.kind === "error_recovered");
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.kind === "error_recovered" && recovered[0].action).toBe("halt");
  });

  test("halt: the same payload is appended to the session event log before the throw", async () => {
    const { adapter } = alwaysThrowingAdapter(BILLING_ERROR);
    const { logged } = await runCollecting(adapter);
    const lines = logged.filter((l) => l.kind === "run_failed");
    expect(lines.length).toBe(1);
    expect(lines[0]?.payload).toEqual({
      class: "billing",
      message:
        'provider account out of funding: Anthropic said: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."',
      remediation: "add credits at https://console.anthropic.com/settings/billing, then rerun.",
      exitCode: 31,
    });
  });

  test("generic fail: synthesizes a best-effort report (class unknown, exit 1)", async () => {
    const { adapter } = alwaysThrowingAdapter(
      Object.assign(new Error("something the taxonomy cannot classify"), {
        name: "WeirdError",
      }),
    );
    const { events, logged, caught } = await runCollecting(adapter);
    expect(caught).toBeInstanceOf(RuntimeError);
    expect(caught).not.toBeInstanceOf(RunFailedError);

    const runFailed = events.filter((ev) => ev.kind === "run_failed");
    expect(runFailed.length).toBe(1);
    const ev = runFailed[0];
    if (ev?.kind !== "run_failed") throw new Error("unreachable");
    expect(ev.class).toBe("unknown");
    expect(ev.exitCode).toBe(1);
    expect(ev.message.startsWith("recovery failed: ")).toBe(true);
    expect(ev.message).toContain("something the taxonomy cannot classify");
    expect(ev.remediation).toBeUndefined();

    const lines = logged.filter((l) => l.kind === "run_failed");
    expect(lines.length).toBe(1);
    expect(lines[0]?.payload?.["class"]).toBe("unknown");
    expect(lines[0]?.payload?.["exitCode"]).toBe(1);
  });

  test("regression: a successful run emits NO run_failed (bus or log)", async () => {
    const { events, logged, caught } = await runCollecting(happyAdapter());
    expect(caught).toBeUndefined();
    expect(events.filter((ev) => ev.kind === "run_failed").length).toBe(0);
    expect(logged.filter((l) => l.kind === "run_failed").length).toBe(0);
  });

  test("regression: a NON-terminal recovery (tombstone → success) emits NO run_failed", async () => {
    // A plain 400 classifies as invalid_request → tombstone (no halt): the
    // second model call succeeds, so the run ends cleanly.
    const invalidRequest = Object.assign(new Error("400 malformed block"), {
      status: 400,
      error: { type: "invalid_request_error", message: "malformed block" },
    });
    const { events, logged, caught } = await runCollecting(failOnceAdapter(invalidRequest));
    expect(caught).toBeUndefined();
    const recovered = events.filter((ev) => ev.kind === "error_recovered");
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.kind === "error_recovered" && recovered[0].action).toBe("tombstone");
    expect(events.filter((ev) => ev.kind === "run_failed").length).toBe(0);
    expect(logged.filter((l) => l.kind === "run_failed").length).toBe(0);
  });
});
