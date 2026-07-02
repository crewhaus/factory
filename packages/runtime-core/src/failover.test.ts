/**
 * Item 22 — provider failover chain over the LIVE `runChatLoop` path:
 * `modelFallbacks` + `circuitBreaker` opts (the runtime seam the spec's
 * `agent.model_fallbacks` / `agent.circuit_breaker` lower onto) build a
 * model-router failover chain around the primary adapter.
 *
 * Asserts the full observable contract:
 *  - primary failure trips its breaker → the SAME turn recovers onto the
 *    fallback (recovery-engine re-calls, the chain reroutes);
 *  - `model_failover` trace event with from/to/reason;
 *  - `model_response` (the cost-tracker pricing key) carries the SERVING
 *    candidate's wire model id + provider + specModel — pricing follows the
 *    switch;
 *  - the stderr failover note (advisor-events persistence has not landed);
 *  - a missing-credential fallback warns at boot without failing the run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { createRunContext } from "@crewhaus/run-context";
import type {
  ModelFailoverEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { runChatLoop } from "./index";

const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-failover-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SHARED_SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
});

/**
 * Primary that fails with a max_output_tokens-shaped error while `down` is
 * true. That class recovers via `continue` (no backoff sleep), so the same
 * turn immediately re-calls the model — and the chain, its breaker now open
 * at failureThreshold 1, reroutes to the fallback.
 */
function failingAdapter(down: () => boolean): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return (async function* () {
        if (down()) {
          const err = new Error("scripted primary outage") as Error & {
            error: { type: string };
          };
          err.error = { type: "max_output_tokens" };
          throw err;
        }
        yield* okEvents("primary says hi");
      })();
    },
  };
}

function okAdapter(
  providerId: ProviderId,
  text: string,
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId,
    features: {
      caching: "automatic",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return (async function* () {
        yield* okEvents(text);
      })();
    },
  };
}

async function* okEvents(text: string): AsyncIterable<StreamEvent> {
  yield { kind: "message_start", usage: { input: 100, output: 0 } };
  yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
  yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
  yield { kind: "content_block_stop", index: 0 };
  yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 100, output: 10 } };
  yield { kind: "message_stop" };
}

function captureStderr(): { lines: () => string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines: () => chunks.join("").split("\n"),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

describe("runChatLoop — spec-declared failover chain (item 22)", () => {
  test("primary outage fails over mid-run; events + pricing follow the serving candidate", async () => {
    const primary = failingAdapter(() => true);
    const fallback = okAdapter("openai", "fallback says hi");
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    let finalText: string;
    try {
      finalText = await runChatLoop({
        model: "claude-opus-4-7",
        instructions: "test",
        _adapter: primary,
        _failoverAdapters: new Map([["openai/gpt-4o-mini", fallback]]),
        modelFallbacks: ["openai/gpt-4o-mini"],
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
        runContext,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "hello" }],
      });
    } finally {
      stderr.restore();
    }

    expect(finalText).toBe("fallback says hi");

    // The failover event fired with the routing identities + reason.
    const failovers = seen.filter((e): e is ModelFailoverEvent => e.kind === "model_failover");
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({
      from: "claude-opus-4-7",
      to: "openai/gpt-4o-mini",
      reason: "breaker_open",
    });

    // model_response — cost-tracker's pricing key — carries the SERVING
    // candidate's wire id/provider, not the boot-time primary constants.
    const responses = seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      model: "gpt-4o-mini",
      specModel: "openai/gpt-4o-mini",
      provider: "openai",
    });

    // model_request events: first planned the primary, the recovery re-call
    // planned the fallback (the breaker was already open by then).
    const requests = seen.filter((e): e is ModelRequestEvent => e.kind === "model_request");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: "claude-opus-4-7", provider: "anthropic" });
    expect(requests[1]).toMatchObject({ model: "gpt-4o-mini", provider: "openai" });

    // The fallback adapter received ITS wire model id, and — cross-provider,
    // caching !== explicit — no anthropic cache_control markers.
    expect(fallback.requests).toHaveLength(1);
    expect(fallback.requests[0]?.model).toBe("gpt-4o-mini");
    for (const block of fallback.requests[0]?.system ?? []) {
      expect(block.cache_control).toBeUndefined();
    }

    // Advisor-events persistence hasn't landed — the stderr note is the
    // non-trace surface for the switch.
    const note = stderr.lines().find((l) => l.includes("[failover]"));
    expect(note).toContain("claude-opus-4-7 → openai/gpt-4o-mini (breaker_open)");
  });

  test("missing-credential fallback warns at boot, run proceeds on the primary", async () => {
    const primary = failingAdapter(() => false);
    const runContext = createRunContext();
    // Hermetic: the groq fallback must NOT resolve on machines that happen
    // to carry a real key.
    const prevGroqKey = process.env["GROQ_API_KEY"];
    process.env["GROQ_API_KEY"] = undefined;
    const stderr = captureStderr();
    let finalText: string;
    try {
      finalText = await runChatLoop({
        model: "claude-opus-4-7",
        instructions: "test",
        _adapter: primary,
        modelFallbacks: ["groq/llama-3.3-70b"],
        runContext,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "hello" }],
      });
    } finally {
      stderr.restore();
      if (prevGroqKey !== undefined) process.env["GROQ_API_KEY"] = prevGroqKey;
    }
    expect(finalText).toBe("primary says hi");
    const warning = stderr.lines().find((l) => l.startsWith("[failover] fallback"));
    expect(warning).toContain('"groq/llama-3.3-70b" is unavailable');
  }, 20_000);

  test("no fallbacks + no breaker keeps the single-adapter path untouched", async () => {
    const primary = failingAdapter(() => false);
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const finalText = await runChatLoop({
      model: "claude-opus-4-7",
      instructions: "test",
      _adapter: primary,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(finalText).toBe("primary says hi");
    expect(seen.some((e) => e.kind === "model_failover")).toBe(false);
    const responses = seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
    expect(responses[0]?.model).toBe("claude-opus-4-7");
    expect(responses[0]?.specModel).toBeUndefined();
  });
});
