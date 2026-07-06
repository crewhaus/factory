/**
 * Adaptive model routing — integration: a LOWERED SPEC drives the pool router
 * on the `crewhaus run` (interpreted cli) path.
 *
 * The unit layers live in their own packages (spec parse, lowering + codegen
 * round-trip, PolicyRouter selection, live-loop wiring in runtime-core). This
 * test walks the same path `crewhaus run` does: YAML → parseSpec → lower →
 * thread `ir.agent.modelPool` into the runtime seam — proving the spec's
 * `model_pool` declaration is what actually routes (previously the interpreted
 * run path threaded `model_tiers`/`model_fallbacks` but silently dropped
 * `model_pool`, so `crewhaus run` ignored it while compiled bundles honoured it).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { lower, parseSpec } from "@crewhaus/compiler";
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import type { ModelRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";

const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-pool-int-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SHARED_SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
});

const POOL_SPEC = `
name: pool-int
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be adaptive
  model_pool:
    policy: heuristic
    candidates:
      - { model: claude-haiku-4-5, tags: [cheap] }
      - { model: claude-opus-4-1, tags: [strong] }
`;

function stubAdapter(text: string): ProviderAdapter {
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
    stream(_req: ProviderRequest): AsyncIterable<StreamEvent> {
      return (async function* () {
        yield { kind: "message_start", usage: { input: 1, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

describe("model_pool from a lowered spec (crewhaus run path)", () => {
  test("lowering surfaces model_pool on the cli IR agent", () => {
    const ir = lower(parseSpec(POOL_SPEC));
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.agent.modelPool?.policy).toBe("heuristic");
    expect(ir.agent.modelPool?.candidates.map((c) => c.model)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-1",
    ]);
  });

  test("threading the lowered model_pool into runChatLoop routes per turn", async () => {
    const ir = lower(parseSpec(POOL_SPEC));
    if (ir.target !== "cli") throw new Error("unexpected target");
    const runContext = createRunContext();
    const routes: ModelRouteEvent[] = [];
    runContext.eventBus.subscribe((e: TraceEvent) => {
      if (e.kind === "model_route") routes.push(e);
    });
    const sbDir = mkdtempSync(join(tmpdir(), "crewhaus-pool-int-sb-"));
    // Mirror runRun's opts threading (apps/cli runRun → runChatLoop).
    const finalText = await runChatLoop({
      model: ir.agent.model,
      instructions: ir.agent.instructions,
      ...(ir.agent.modelPool !== undefined ? { modelPool: ir.agent.modelPool } : {}),
      _adapter: stubAdapter("primary"),
      _poolAdapters: new Map([
        ["claude-haiku-4-5", stubAdapter("cheap")],
        ["claude-opus-4-1", stubAdapter("strong")],
      ]),
      _scoreboard: openScoreboard(sbDir),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    // First turn (task framing) → hard band → the strong-tagged candidate.
    expect(finalText).toBe("strong");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      routeKey: "hard",
      model: "claude-opus-4-1",
      policy: "heuristic",
    });
    rmSync(sbDir, { recursive: true, force: true });
  });
});
