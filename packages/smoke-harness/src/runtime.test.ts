/**
 * Phase 3 — runtime smoke for the browser target.
 *
 * Gated on `ANTHROPIC_API_KEY` because it issues a real model call. Set
 * `CREWHAUS_RUNTIME_SMOKE_REQUIRED=1` in CI to make a missing key fail
 * the test instead of skip (so the opt-in GH Actions job is the only
 * place that demands the secret).
 */
import { describe, expect, test } from "bun:test";
import { runBrowserRuntimeSmoke, runtimeSmokeIsEnabled } from "./runtime.js";

const REQUIRED = process.env["CREWHAUS_RUNTIME_SMOKE_REQUIRED"] === "1";

// Generous: chromium first-launch + one model round-trip with browser tools.
const RUNTIME_SMOKE_TIMEOUT_MS = 180_000;

describe("runtime smoke — browser", () => {
  test(
    "agent calls Navigate then Screenshot and grounds its answer in the page",
    async () => {
      if (!runtimeSmokeIsEnabled()) {
        if (REQUIRED) {
          throw new Error("CREWHAUS_RUNTIME_SMOKE_REQUIRED=1 but ANTHROPIC_API_KEY is not set");
        }
        process.stdout.write("[smoke:runtime] skipped — set ANTHROPIC_API_KEY to run this test\n");
        return;
      }

      const result = await runBrowserRuntimeSmoke();
      if (result.status === "failed") {
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
      expect(result.status).toBe("ok");
    },
    RUNTIME_SMOKE_TIMEOUT_MS,
  );
});
