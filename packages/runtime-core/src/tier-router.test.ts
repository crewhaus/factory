/**
 * Item 26 — two-tier turn-difficulty router over the LIVE `runChatLoop` path.
 *
 * `modelTiers` opts (the runtime seam the spec's `agent.model_tiers` lowers
 * onto) resolve BOTH tier adapters at boot and pick one per turn from
 * deterministic signals, publishing a `model_tier_route` event. Asserts:
 *  - an easy mid-conversation turn routes to `fast`;
 *  - a hard turn (first turn / tools) routes to `default`;
 *  - a `model_tier_route` event carries tier/model/reason;
 *  - a fast-tier FAILURE escalates: the recovery retry re-runs on `default`
 *    (the misroute recovery), with an `escalated` route event.
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
import type { ModelTierRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { runChatLoop } from "./index";

const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-tier-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SHARED_SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
});

async function* okEvents(text: string): AsyncIterable<StreamEvent> {
  yield { kind: "message_start", usage: { input: 100, output: 0 } };
  yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
  yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
  yield { kind: "content_block_stop", index: 0 };
  yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 100, output: 10 } };
  yield { kind: "message_stop" };
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
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return okEvents(text);
    },
  };
}

/** Fails with a `continue`-recoverable (max_output_tokens) error while `down`. */
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
          const err = new Error("scripted fast-tier outage") as Error & { error: { type: string } };
          err.error = { type: "max_output_tokens" };
          throw err;
        }
        yield* okEvents("fast recovered");
      })();
    },
  };
}

function tierAdapters(fast: ProviderAdapter, dflt: ProviderAdapter) {
  return new Map<string, ProviderAdapter>([
    ["claude-haiku-4-5", fast],
    ["claude-sonnet-4-5", dflt],
  ]);
}

describe("runChatLoop — two-tier turn-difficulty router (item 26)", () => {
  test("first turn (task framing) routes to the default tier", async () => {
    const fast = okAdapter("anthropic", "fast");
    const dflt = okAdapter("anthropic", "default served");
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));

    const finalText = await runChatLoop({
      model: "claude-opus-4-7",
      instructions: "test",
      _adapter: okAdapter("anthropic", "primary"),
      modelTiers: { fast: "claude-haiku-4-5", default: "claude-sonnet-4-5" },
      _tierAdapters: tierAdapters(fast, dflt),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });

    expect(finalText).toBe("default served");
    const routes = seen.filter((e): e is ModelTierRouteEvent => e.kind === "model_tier_route");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ tier: "default", model: "claude-sonnet-4-5" });
    expect(routes[0]?.reason).toContain("first turn");
    // Only the default tier adapter streamed.
    expect(dflt.requests).toHaveLength(1);
    expect(fast.requests).toHaveLength(0);
  });

  test("an easy non-first turn routes to the fast tier", async () => {
    const fast = okAdapter("anthropic", "fast served");
    const dflt = okAdapter("anthropic", "default");
    const runContext = createRunContext();
    // Bump the turn number so it isn't the first turn (turnIndex 0 → default).
    runContext.turnNumber = 2;
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));

    const finalText = await runChatLoop({
      model: "claude-opus-4-7",
      instructions: "test",
      _adapter: okAdapter("anthropic", "primary"),
      modelTiers: { fast: "claude-haiku-4-5", default: "claude-sonnet-4-5" },
      _tierAdapters: tierAdapters(fast, dflt),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hi" }],
    });

    expect(finalText).toBe("fast served");
    const routes = seen.filter((e): e is ModelTierRouteEvent => e.kind === "model_tier_route");
    expect(routes[0]).toMatchObject({ tier: "fast", model: "claude-haiku-4-5" });
    expect(fast.requests).toHaveLength(1);
    expect(dflt.requests).toHaveLength(0);
  });

  test("a fast-tier FAILURE escalates: the recovery retry re-runs on default", async () => {
    // Fast tier is down; the max_output_tokens error recovers via `continue`
    // (no backoff), so the same turn immediately re-calls the model — now on
    // the escalated default tier.
    const fast = failingAdapter(() => true);
    const dflt = okAdapter("anthropic", "default rescued the turn");
    const runContext = createRunContext();
    runContext.turnNumber = 2; // easy turn → fast tier first
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));

    const finalText = await runChatLoop({
      model: "claude-opus-4-7",
      instructions: "test",
      _adapter: okAdapter("anthropic", "primary"),
      modelTiers: { fast: "claude-haiku-4-5", default: "claude-sonnet-4-5" },
      _tierAdapters: tierAdapters(fast, dflt),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "do the thing" }],
    });

    expect(finalText).toBe("default rescued the turn");
    const routes = seen.filter((e): e is ModelTierRouteEvent => e.kind === "model_tier_route");
    // First route was fast; the escalated retry was default.
    expect(routes[0]?.tier).toBe("fast");
    const escalated = routes.find((r) => r.escalated === true);
    expect(escalated).toBeDefined();
    expect(escalated?.tier).toBe("default");
    expect(escalated?.reason).toContain("escalated");
    // The fast adapter was tried once; the default served the recovery.
    expect(fast.requests).toHaveLength(1);
    expect(dflt.requests).toHaveLength(1);
  });

  test("no modelTiers → single-model path, no tier events", async () => {
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));
    await runChatLoop({
      model: "claude-opus-4-7",
      instructions: "test",
      _adapter: okAdapter("anthropic", "solo"),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hi" }],
    });
    expect(seen.filter((e) => e.kind === "model_tier_route")).toHaveLength(0);
  });
});
