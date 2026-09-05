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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { buildTool } from "@crewhaus/tool-builder";
import type { ModelRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
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

/** Read the persisted model_route lines from a session's event log. */
function persistedRoutes(sessionId: string): Array<Record<string, unknown>> {
  const file = join(SHARED_SESSION_ROOT, `${sessionId}.jsonl`);
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { kind?: string; payload?: unknown })
    .filter((e) => e.kind === "model_route")
    .map((e) => e.payload as Record<string, unknown>);
}

describe("runChatLoop — model_route persistence + online exploration", () => {
  test("persists each turn's model_route decision to the session event log", async () => {
    const cheap = okAdapter("cheap served");
    const strong = okAdapter("strong served");
    const runContext = createRunContext();
    const finalText = await runChatLoop({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: { candidates: POOL_CANDIDATES, policy: "heuristic" },
      _poolAdapters: poolAdapters(cheap, strong),
      _scoreboard: tmpScoreboard(),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(finalText).toBe("strong served"); // first turn → hard → strong
    const routes = persistedRoutes(runContext.sessionId);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      turnNumber: 1,
      routeKey: "hard",
      model: OPUS,
      policy: "heuristic",
      explored: false,
    });
  });

  test("learned + explorationRate 1 explores a non-best arm and persists explored:true", async () => {
    // Seed the scoreboard so both hard-band arms are past a floor of 1, with
    // HAIKU the best — ε=1 then forces a non-best (OPUS) exploration pick.
    const sb = tmpScoreboard();
    sb.record("hard", HAIKU, 0.9, { success: true, latencyMs: 100 });
    sb.record("hard", OPUS, 0.1, { success: true, latencyMs: 100 });
    const cheap = okAdapter("cheap served");
    const strong = okAdapter("strong served");
    const runContext = createRunContext();
    const finalText = await runChatLoop({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: {
        candidates: POOL_CANDIDATES,
        policy: "learned",
        learning: { minSamplesPerArm: 1, explorationRate: 1, seed: "fixed-seed" },
      },
      _poolAdapters: poolAdapters(cheap, strong),
      _scoreboard: sb,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "framing" }], // first turn → hard band
    });
    // HAIKU is the best arm, so ε-greedy explore serves the non-best OPUS.
    expect(finalText).toBe("strong served");
    expect(strong.requests).toHaveLength(1);
    const routes = persistedRoutes(runContext.sessionId);
    expect(routes[0]).toMatchObject({ routeKey: "hard", model: OPUS, explored: true });
    expect(String(routes[0]?.reason)).toContain("ε-greedy explore");
  });
});

/**
 * 0.6.0 §4.4 pin — the loop feeds the router `toolsInPlay` as the RUN-WIDE
 * union advertisement (`anthropicTools.length > 0`), computed BEFORE a
 * candidate is chosen. Registering one tool makes every non-first turn
 * "hard" for every candidate, whichever of them could serve the tool. Later
 * per-candidate toolsets (§5) must not change this band.
 */
describe("runChatLoop — toolsInPlay routes on the union advertisement (0.6.0 §4.4 pin)", () => {
  test("one registered tool → a non-first turn lands in the hard band (strong candidate)", async () => {
    const cheap = okAdapter("cheap");
    const strong = okAdapter("strong");
    const runContext = createRunContext();
    runContext.turnNumber = 2; // non-first: only the tool signal can make it hard
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));
    const probe = buildTool({
      name: "probe",
      description: "never called",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => "unused",
    });
    await runChatLoop({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: { candidates: POOL_CANDIDATES, policy: "heuristic" },
      _poolAdapters: poolAdapters(cheap, strong),
      _scoreboard: tmpScoreboard(),
      tools: [probe],
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    const route = seen.find((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(route?.routeKey).toBe("hard");
    expect(route?.reason).toContain("tools in play");
    expect(route?.model).toBe(OPUS);
    expect(strong.requests).toHaveLength(1);
    expect(cheap.requests).toHaveLength(0);
    // The request carried the union list — every candidate is sent the same
    // advertisement, which is exactly what the band was computed from.
    expect(strong.requests[0]?.tools?.map((t) => t.name)).toContain("probe");
  });
});

describe("runChatLoop — 0.6.0 PR 7 pool widening (enabled: false, policy: classifier)", () => {
  test("a candidate declared enabled: false never becomes an arm", async () => {
    const cheap = okAdapter("cheap served");
    const strong = okAdapter("strong served");
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));
    // A hard (first) turn would route to the strong candidate — but it is withdrawn.
    const finalText = await runChatLoop({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: {
        candidates: [
          { model: HAIKU, tags: ["cheap"] },
          { model: OPUS, tags: ["strong"], enabled: false },
        ],
        policy: "heuristic",
      },
      _poolAdapters: poolAdapters(cheap, strong),
      _scoreboard: tmpScoreboard(),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(finalText).toBe("cheap served");
    expect(strong.requests).toHaveLength(0);
    const routes = seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes[0]?.model).toBe(HAIKU);
  });

  test("policy: classifier with no classifier wired routes heuristically, recording `classifier failed`", async () => {
    const cheap = okAdapter("cheap served");
    const strong = okAdapter("strong served");
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));
    const finalText = await runChatLoop({
      model: "claude-sonnet-5",
      instructions: "test",
      _adapter: okAdapter("primary"),
      modelPool: { candidates: POOL_CANDIDATES, policy: "classifier" },
      _poolAdapters: poolAdapters(cheap, strong),
      _scoreboard: tmpScoreboard(),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(finalText).toBe("strong served");
    const routes = seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes[0]).toMatchObject({ routeKey: "hard", model: OPUS, policy: "heuristic" });
    expect(routes[0]?.reason).toContain("classifier failed: no classifier wired");
  });
});
