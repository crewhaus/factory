/**
 * Phase 3 — runtime smoke for the runnable target shapes (cli, browser).
 *
 * Gated on `ANTHROPIC_AUTH_TOKEN` (Claude OAuth) or `ANTHROPIC_API_KEY`
 * because both shapes issue a real model call. Set
 * `CREWHAUS_RUNTIME_SMOKE_REQUIRED=1` in CI to make a missing credential
 * fail the test instead of skip (so the opt-in GH Actions job is the
 * only place that demands the secret).
 */
import { describe, expect, test } from "bun:test";
import {
  type RuntimeSmokeResult,
  runBrowserRuntimeSmoke,
  runCliRuntimeSmoke,
  runtimeSmokeIsEnabled,
} from "./runtime.js";

const REQUIRED = process.env["CREWHAUS_RUNTIME_SMOKE_REQUIRED"] === "1";

// Generous: chromium first-launch + one model round-trip with browser tools
// is the slowest path; cli runs in well under this but reuses the budget.
const RUNTIME_SMOKE_TIMEOUT_MS = 180_000;

function reportFailure(result: RuntimeSmokeResult): never {
  // Surface enough detail to debug a CI failure without re-running
  // locally: tool sequence, final text, stderr tail.
  const debug = [
    `runtime smoke failed for shape "${result.shape}":`,
    ...result.failures.map((f) => `  - ${f}`),
    `tool_use sequence: ${(result.events ?? [])
      .filter((e) => e.kind === "tool_use")
      .map((e) => (e.payload as { name?: string }).name ?? "<unknown>")
      .join(" → ")}`,
    `finalText: ${result.finalText ?? "<none>"}`,
    `stderr tail: ${(result.stderr ?? "").slice(-400)}`,
  ].join("\n");
  throw new Error(debug);
}

function shouldSkip(shape: string): boolean {
  if (runtimeSmokeIsEnabled()) return false;
  if (REQUIRED) {
    throw new Error(
      `CREWHAUS_RUNTIME_SMOKE_REQUIRED=1 but neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set (shape: ${shape})`,
    );
  }
  process.stdout.write(
    `[smoke:runtime ${shape}] skipped — set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY to run\n`,
  );
  return true;
}

describe("runtime smoke — browser", () => {
  test(
    "agent calls Navigate then Screenshot and grounds its answer in the page",
    async () => {
      if (shouldSkip("browser")) return;
      const result = await runBrowserRuntimeSmoke();
      if (result.status === "failed") reportFailure(result);
      expect(result.status).toBe("ok");
    },
    RUNTIME_SMOKE_TIMEOUT_MS,
  );
});

describe("runtime smoke — cli", () => {
  test(
    "agent calls read on a randomised file and grounds its answer in the contents",
    async () => {
      if (shouldSkip("cli")) return;
      const result = await runCliRuntimeSmoke();
      if (result.status === "failed") reportFailure(result);
      expect(result.status).toBe("ok");
    },
    RUNTIME_SMOKE_TIMEOUT_MS,
  );
});
