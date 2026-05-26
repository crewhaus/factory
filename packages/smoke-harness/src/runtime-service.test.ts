/**
 * Service-backed runtime smoke tests — Phase 3 follow-up.
 *
 * Coverage today (see RUNTIME-ACTIVATION.md for each shape's
 * activation requirements):
 *   - batch: fully implemented; runs end-to-end once ANTHROPIC_* is set.
 *   - channel/onchain/voice: scaffolds. Each gates on the service tokens
 *     it would need and skips with a pointer to the activation doc.
 *
 * Like the cli/browser runtime tests, the whole file skips cleanly
 * when no Anthropic auth is configured so per-PR CI stays key-free.
 */
import { describe, expect, test } from "bun:test";
import {
  runBatchRuntimeSmoke,
  runChannelRuntimeSmoke,
  runOnchainRuntimeSmoke,
  runVoiceRuntimeSmoke,
} from "./runtime-service.js";
import { type RuntimeSmokeResult, runtimeSmokeIsEnabled } from "./runtime.js";

const REQUIRED = process.env["CREWHAUS_RUNTIME_SMOKE_REQUIRED"] === "1";
const RUNTIME_SMOKE_TIMEOUT_MS = 180_000;

function reportFailure(result: RuntimeSmokeResult): never {
  const debug = [
    `runtime-service smoke failed for shape "${result.shape}":`,
    ...result.failures.map((f) => `  - ${f}`),
    `events: ${(result.events ?? []).map((e) => e.kind).join(" → ")}`,
    `stderr tail: ${(result.stderr ?? "").slice(-400)}`,
  ].join("\n");
  throw new Error(debug);
}

function logSkip(shape: string, reason: string): void {
  process.stdout.write(`[smoke:runtime ${shape}] skipped — ${reason}\n`);
}

function shouldSkipAnthropic(shape: string): boolean {
  if (runtimeSmokeIsEnabled()) return false;
  if (REQUIRED) {
    throw new Error(
      `CREWHAUS_RUNTIME_SMOKE_REQUIRED=1 but neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set (shape: ${shape})`,
    );
  }
  logSkip(shape, "set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY to run");
  return true;
}

describe("runtime smoke — batch (in-memory queue)", () => {
  test(
    "daemon drains the seed queue and emits worker_start/job_start×2/worker_stop",
    async () => {
      if (shouldSkipAnthropic("batch")) return;
      const result = await runBatchRuntimeSmoke();
      if (result.status === "skipped") {
        logSkip("batch", result.skipReason ?? "scaffold deferred");
        return;
      }
      if (result.status === "failed") reportFailure(result);
      expect(result.status).toBe("ok");
    },
    RUNTIME_SMOKE_TIMEOUT_MS,
  );
});

describe("runtime smoke — channel (Slack)", () => {
  test(
    "scaffold: gates on SMOKE_SLACK_* tokens (skip until activated)",
    async () => {
      if (shouldSkipAnthropic("channel")) return;
      const result = await runChannelRuntimeSmoke();
      // Scaffold currently always skips; once activated the test will
      // start asserting on the agent's response loop.
      if (result.status === "skipped") {
        logSkip("channel", result.skipReason ?? "scaffold deferred");
        return;
      }
      if (result.status === "failed") reportFailure(result);
      expect(result.status).toBe("ok");
    },
    RUNTIME_SMOKE_TIMEOUT_MS,
  );
});

describe("runtime smoke — onchain (EVM)", () => {
  test(
    "scaffold: gates on SMOKE_ONCHAIN_RPC (skip until activated)",
    async () => {
      if (shouldSkipAnthropic("onchain")) return;
      const result = await runOnchainRuntimeSmoke();
      if (result.status === "skipped") {
        logSkip("onchain", result.skipReason ?? "scaffold deferred");
        return;
      }
      if (result.status === "failed") reportFailure(result);
      expect(result.status).toBe("ok");
    },
    RUNTIME_SMOKE_TIMEOUT_MS,
  );
});

describe("runtime smoke — voice (OpenAI Realtime)", () => {
  test(
    "scaffold: gates on SMOKE_OPENAI_API_KEY / OPENAI_API_KEY (skip until activated)",
    async () => {
      if (shouldSkipAnthropic("voice")) return;
      const result = await runVoiceRuntimeSmoke();
      if (result.status === "skipped") {
        logSkip("voice", result.skipReason ?? "scaffold deferred");
        return;
      }
      if (result.status === "failed") reportFailure(result);
      expect(result.status).toBe("ok");
    },
    RUNTIME_SMOKE_TIMEOUT_MS,
  );
});
