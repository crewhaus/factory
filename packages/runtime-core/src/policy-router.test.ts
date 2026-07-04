/**
 * Adaptive model routing (`agent.model_pool`) over the LIVE `runChatLoop` path.
 *
 * `modelPool` opts (the runtime seam the spec's `agent.model_pool` lowers onto)
 * resolve every candidate adapter at boot and pick one per turn via the
 * PolicyRouter, publishing a `model_route` event and folding each turn's
 * outcome into the injected reward scoreboard. Asserts:
 *  - `heuristic`: a hard turn routes to the strong candidate, an easy turn to
 *    the cheap one;
 *  - a successful turn records a positive reward on the served arm;
 *  - `learned`: an empty scoreboard EXPLORES least-sampled-first across runs
 *    (deterministic round-robin), so selection improves with usage;
 *  - a candidate FAILURE escalates to the strongest candidate and records the
 *    failure;
 *  - no `modelPool` → single-model path, no `model_route` events.
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
import { type Scoreboard, openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import type { ModelRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { runChatLoop } from "./index";

const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-pool-tests-"));
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

function okAdapter(text: string): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "anthropic" as ProviderId,
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
    providerId: "anthropic" as ProviderId,
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
          const err = new Error("scripted candidate outage") as Error & { error: { type: string } };
          err.error = { type: "max_output_tokens" };
          throw err;
        }
        yield* okEvents("recovered");
      })();
    },
  };
}

const HAIKU = "claude-haiku-4-5";
const OPUS = "claude-opus-4-8";
const POOL_CANDIDATES = [
  { model: HAIKU, tags: ["cheap"] },
  { model: OPUS, tags: ["strong"] },
];

function poolAdapters(cheap: ProviderAdapter, strong: ProviderAdapter) {
  return new Map<string, ProviderAdapter>([
    [HAIKU, cheap],
    [OPUS, strong],
  ]);
}

const TMP_ROOTS: string[] = [];
function tmpScoreboard(): Scoreboard {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-pool-sb-"));
  TMP_ROOTS.push(dir);
  return openScoreboard(dir, { now: () => 1_700_000_000_000 });
}
afterAll(() => {
  for (const d of TMP_ROOTS) rmSync(d, { recursive: true, force: true });
});

describe("runChatLoop — adaptive model routing (model_pool)", () => {
  test("heuristic: a hard turn (first turn) routes to the strong candidate", async () => {
    const cheap = okAdapter("cheap served");
    const strong = okAdapter("strong served");
    const sb = tmpScoreboard();
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));

    const finalText = await runChatLoop({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: { candidates: POOL_CANDIDATES, policy: "heuristic" },
      _poolAdapters: poolAdapters(cheap, strong),
      _scoreboard: sb,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });

    expect(finalText).toBe("strong served");
    const routes = seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ routeKey: "hard", model: OPUS, policy: "heuristic" });
    expect(routes[0]?.policyVersion).toMatch(/^pool-/);
    expect(strong.requests).toHaveLength(1);
    expect(cheap.requests).toHaveLength(0);
    // A successful turn records a positive reward on the served arm.
    const arm = sb.score("hard", OPUS);
    expect(arm?.n).toBe(1);
    expect(arm?.meanReward).toBeGreaterThan(0);
  });

  test("heuristic: an easy (non-first, tool-less) turn routes to the cheap candidate", async () => {
    const cheap = okAdapter("cheap served");
    const strong = okAdapter("strong served");
    const runContext = createRunContext();
    runContext.turnNumber = 2; // not the first turn
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));

    const finalText = await runChatLoop({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: { candidates: POOL_CANDIDATES, policy: "heuristic" },
      _poolAdapters: poolAdapters(cheap, strong),
      _scoreboard: tmpScoreboard(),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hi" }],
    });

    expect(finalText).toBe("cheap served");
    const routes = seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes[0]).toMatchObject({ routeKey: "easy", model: HAIKU, policy: "heuristic" });
    expect(cheap.requests).toHaveLength(1);
    expect(strong.requests).toHaveLength(0);
  });

  test("learned: explores least-sampled-first across runs, improving with usage", async () => {
    const sb = tmpScoreboard();
    const learnedOpts = () => ({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: {
        candidates: POOL_CANDIDATES,
        policy: "learned" as const,
        learning: { minSamplesPerArm: 5 },
      },
      _scoreboard: sb,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "framing turn" }],
    });

    // Run 1 (first turn → hard band, empty scoreboard): explores candidates[0].
    const cheap1 = okAdapter("cheap");
    const strong1 = okAdapter("strong");
    const rc1 = createRunContext();
    const seen1: TraceEvent[] = [];
    rc1.eventBus.subscribe((e) => seen1.push(e));
    await runChatLoop({
      ...learnedOpts(),
      _poolAdapters: poolAdapters(cheap1, strong1),
      runContext: rc1,
    });
    const route1 = seen1.find((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(route1).toMatchObject({ routeKey: "hard", model: HAIKU, explored: true });
    expect(cheap1.requests).toHaveLength(1);

    // Run 2 (same scoreboard, hard band): haiku now has 1 sample, opus 0 →
    // the least-sampled arm is now opus, so exploration moves on to it.
    const cheap2 = okAdapter("cheap");
    const strong2 = okAdapter("strong");
    const rc2 = createRunContext();
    const seen2: TraceEvent[] = [];
    rc2.eventBus.subscribe((e) => seen2.push(e));
    await runChatLoop({
      ...learnedOpts(),
      _poolAdapters: poolAdapters(cheap2, strong2),
      runContext: rc2,
    });
    const route2 = seen2.find((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(route2).toMatchObject({ routeKey: "hard", model: OPUS, explored: true });
    expect(strong2.requests).toHaveLength(1);

    // Both arms in the `hard` band now carry a recorded observation.
    expect(sb.score("hard", HAIKU)?.n).toBe(1);
    expect(sb.score("hard", OPUS)?.n).toBe(1);
  });

  test("a candidate FAILURE escalates to the strongest candidate and records the failure", async () => {
    const cheap = failingAdapter(() => true); // the cheap pick is down
    const strong = okAdapter("strong rescued the turn");
    const sb = tmpScoreboard();
    const runContext = createRunContext();
    runContext.turnNumber = 2; // easy turn → cheap candidate first
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));

    const finalText = await runChatLoop({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: { candidates: POOL_CANDIDATES, policy: "heuristic" },
      _poolAdapters: poolAdapters(cheap, strong),
      _scoreboard: sb,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "do the thing" }],
    });

    expect(finalText).toBe("strong rescued the turn");
    const routes = seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes[0]?.model).toBe(HAIKU); // first pick was the cheap candidate
    const escalated = routes.find((r) => r.reason.includes("escalated"));
    expect(escalated?.model).toBe(OPUS);
    expect(cheap.requests).toHaveLength(1);
    expect(strong.requests).toHaveLength(1);
    // The failed cheap arm recorded a zero-reward observation; strong recorded success.
    expect(sb.score("easy", HAIKU)?.meanReward).toBe(0);
    expect(sb.score("easy", OPUS)?.meanReward).toBeGreaterThan(0);
  });

  test("no modelPool → single-model path, no model_route events", async () => {
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));
    await runChatLoop({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("solo"),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hi" }],
    });
    expect(seen.filter((e) => e.kind === "model_route")).toHaveLength(0);
  });
});
