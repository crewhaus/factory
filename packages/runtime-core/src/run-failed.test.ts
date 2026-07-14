/**
 * v0.3.0 Goal 6 — the `halt` recovery action surfaces as a RunFailedError.
 *
 * A billing/auth-classified provider error must stop the run on the FIRST
 * model call (no tombstone detour, no backoff retries) and reject with a
 * RunFailedError whose `report` carries the class, raw provider text,
 * remediation, and coded exit status. Everything unclassified keeps the
 * pre-0.3.0 `RuntimeError("recovery failed: …")` path — that regression
 * guard lives here too. The `run_failed` trace event and coded process
 * exits land in the follow-up PR.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { CrewhausError, RunFailedError, RuntimeError } from "@crewhaus/errors";
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
