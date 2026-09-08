/**
 * 0.6.0 §6.3 (PR 14) — `model_pool.reward.quality_source`, over the LIVE
 * `runChatLoop`.
 *
 * The claim under test is narrow and load-bearing: a judged quality reaches
 * the REWARD only when the spec opts in with `quality_source: in_loop`. Under
 * the default `none` the quality is still PERSISTED on the `v:2` line (so the
 * offline join, `route status` and a later `route promote` can read it) but
 * every reward the scoreboard folds is byte-identical to what 0.5.x folded —
 * which is what makes this release's headline routing feature safe to ship
 * on by default.
 *
 * Both directions are asserted against `computeReward` itself rather than
 * against a hard-coded number, so the test pins the WIRING (which observation
 * the reward was computed from), not the reward function's tuning.
 *
 * Also pinned here: §7.9's `stage` / `strategy` on the durable `model_route`
 * line. `watchme report --feed-routing` joins delayed quality PER STAGE, and
 * the stage it joins on is the one stamped here.
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
import { computeReward, openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import type { ModelRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { type EvaluationTurn, type RunEvaluation, runChatLoop } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-runtime-core-quality-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

const CHEAP = "claude-haiku-4-5";
const STRONG = "claude-opus-4-1";
const CHEAP_ARM = "fast";
const JUDGE = "claude-opus-4";

function scriptedAdapter(providerId: ProviderId, reply: string): ProviderAdapter {
  return {
    providerId,
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
        yield { kind: "message_start", usage: { input: 10, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 10, output: 5 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/**
 * A judge returning one scripted score. `on_fail: escalate` puts the turn on
 * the cascade path — the one that defers its member-arm lines to the
 * strategy-turn boundary and stamps the judged quality on them (§6.3 item 2),
 * so a `v:2` line carries `q` under EVERY quality source and the reward is
 * the only thing that moves. The score clears the threshold, so the turn is a
 * single graded stage and no escalation confounds the comparison.
 */
function judge(score: number): { evaluation: RunEvaluation; turns: EvaluationTurn[] } {
  const turns: EvaluationTurn[] = [];
  const evaluation: RunEvaluation = {
    threshold: 0.5,
    onFail: "escalate",
    maxRetries: 0,
    graderType: "llm_judge",
    evaluate: async (turn) => {
      turns.push(turn);
      return { score, rationale: "scripted", judge: { model: JUDGE } };
    },
  };
  return { evaluation, turns };
}

const POOL = {
  candidates: [
    { model: CHEAP, tags: ["cheap"], profile: "fast" },
    { model: STRONG, tags: ["strong"], profile: "strong" },
  ],
  policy: "static" as const,
};

type ArmLine = Record<string, unknown>;
function armLines(root: string): ArmLine[] {
  return readFileSync(join(root, "routing", "arms.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ArmLine);
}

/** Run one graded, pooled turn and return the arm lines it recorded. */
async function gradedTurn(
  qualitySource: "none" | "in_loop" | undefined,
  score = 0.6,
  graded = true,
): Promise<{ lines: ArmLine[]; routes: ModelRouteEvent[] }> {
  const cheap = scriptedAdapter("anthropic", "an answer");
  const strong = scriptedAdapter("anthropic", "a stronger answer");
  const root = mkdtempSync(join(tmpdir(), "crewhaus-quality-sb-"));
  const { evaluation } = judge(score);
  const runContext = createRunContext();
  const seen: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => {
    seen.push(e);
  });
  await runChatLoop({
    model: CHEAP,
    instructions: "test",
    modelPool: qualitySource === undefined ? POOL : { ...POOL, reward: { qualitySource } },
    permissionMode: "auto",
    singleTurn: true,
    seedMessages: [{ role: "user", content: "a question" }],
    installSigintHandler: false,
    spinner: false,
    stdout: () => {},
    _adapter: cheap,
    _poolAdapters: new Map([
      [CHEAP, cheap],
      [STRONG, strong],
    ]),
    _scoreboard: openScoreboard(root, { now: () => 1_700_000_000_000 }),
    ...(graded ? { evaluation } : {}),
    runContext,
  });
  return {
    lines: armLines(root),
    routes: seen.filter((e): e is ModelRouteEvent => e.kind === "model_route"),
  };
}

/** Recompute the reward the line's own observation implies, with/without quality. */
function rewardOf(line: ArmLine, withQuality: boolean): number {
  const obs = {
    success: line["s"] === 1,
    latencyMs: typeof line["l"] === "number" ? line["l"] : 0,
    ...(typeof line["c"] === "number" ? { costUsd: line["c"] } : {}),
    ...(withQuality && typeof line["q"] === "number" ? { quality: line["q"] } : {}),
  };
  return computeReward(obs);
}

describe("reward.quality_source — quality reaches the arm only under in_loop", () => {
  test("default (absent reward block): the judged quality is PERSISTED but the reward is byte-identical to a 0.5.x reward", async () => {
    const { lines } = await gradedTurn(undefined, 0.6);
    const arm = lines.find((l) => l["m"] === CHEAP_ARM);
    expect(arm).toBeDefined();
    // The `v:2` line carries the judged quality — that is what the offline
    // join, `route status` and `route promote` read.
    expect(arm?.["q"]).toBe(0.6);
    const recorded = arm?.["r"] as number;
    // …and the reward folded is the one computed WITHOUT it.
    expect(recorded).toBeCloseTo(rewardOf(arm as ArmLine, false), 12);
    // The two are genuinely different numbers, so the assertion has teeth: a
    // 0.6 quality scores strictly worse than the absent-quality default of 1.
    expect(rewardOf(arm as ArmLine, true)).toBeLessThan(recorded);
  });

  test("explicit `quality_source: none` behaves exactly like the absent block", async () => {
    const { lines } = await gradedTurn("none", 0.6);
    const arm = lines.find((l) => l["m"] === CHEAP_ARM);
    expect(arm?.["q"]).toBe(0.6);
    expect(arm?.["r"] as number).toBeCloseTo(rewardOf(arm as ArmLine, false), 12);
  });

  test("`quality_source: in_loop`: the SAME turn folds the judged quality into the reward", async () => {
    const { lines } = await gradedTurn("in_loop", 0.6);
    const arm = lines.find((l) => l["m"] === CHEAP_ARM);
    expect(arm).toBeDefined();
    expect(arm?.["q"]).toBe(0.6);
    expect(arm?.["r"] as number).toBeCloseTo(rewardOf(arm as ArmLine, true), 12);
    // And it is NOT the quality-free reward — the two paths diverge.
    expect(arm?.["r"] as number).toBeLessThan(rewardOf(arm as ArmLine, false));
  });

  test("a PERFECT judged score makes the two sources agree on the same line — the divergence is the quality term alone", async () => {
    // Quality 1 is exactly `computeReward`'s absent-quality default, so the
    // in_loop reward for a perfect turn equals the quality-free reward of that
    // very same observation. (Compared WITHIN one run: the latency term is
    // measured wall clock and never comparable across runs.)
    const { lines } = await gradedTurn("in_loop", 1);
    const arm = lines.find((l) => l["m"] === CHEAP_ARM);
    expect(arm?.["q"]).toBe(1);
    expect(arm?.["r"] as number).toBeCloseTo(rewardOf(arm as ArmLine, true), 12);
    expect(rewardOf(arm as ArmLine, true)).toBeCloseTo(rewardOf(arm as ArmLine, false), 12);
  });

  test("the cascade's route line carries stage + strategy (§7.9 — what --feed-routing joins on)", async () => {
    const { routes } = await gradedTurn(undefined, 0.9);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ stage: "draft", strategy: "cascade" });
  });

  test("a plain pooled turn (no evaluation) keeps the pre-0.6.0 route-line shape — no stage, no strategy", async () => {
    const { routes, lines } = await gradedTurn(undefined, 0.9, false);
    expect(routes).toHaveLength(1);
    expect("stage" in (routes[0] as object)).toBe(false);
    expect("strategy" in (routes[0] as object)).toBe(false);
    // …and nothing grades it, so its arm line carries no quality and no
    // strategy attribution (the `v:2` stamp is PR 10's routing provenance,
    // which every pooled line carries).
    const arm = lines.find((l) => l["m"] === CHEAP_ARM);
    expect(arm?.["q"]).toBeUndefined();
    expect(arm?.["st"]).toBeUndefined();
    expect(arm?.["sg"]).toBeUndefined();
    expect(arm?.["r"] as number).toBeCloseTo(rewardOf(arm as ArmLine, false), 12);
  });
});
