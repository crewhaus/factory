/**
 * 0.6.0 §6.1 (PR 12) — routed evals.
 *
 * The pure half (mode parsing, roster resolution, the frozen score reader and
 * its digest, the served-model / route-decision folds) plus an end-to-end
 * `runEval` pass through the DEFAULT invoker with an injected `chatLoop`, so
 * the wiring is asserted without a model call and without a process-global
 * module mock.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { type ArmStats, openScoreboard } from "@crewhaus/routing-store";
import { parseSpec } from "@crewhaus/spec";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { runEval } from "./index";
import {
  DEFAULT_EVAL_LEARNING_SEED,
  armsDigest,
  candidateArmId,
  evalRoutingCandidateRef,
  foldRouteDecisions,
  foldServedModels,
  freezeArmsSnapshot,
  isStaticRouting,
  mergeServedModels,
  parseEvalRoutingMode,
  poolArmIds,
  readLiveArms,
  resolveEvalRouting,
  rosterRefs,
} from "./routing";

const TMP_ROOTS: string[] = [];
function newTempRoot(prefix = "crewhaus-routing-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const POOL_SPEC = `name: routed-eval
target: cli
models:
  fast:
    model: claude-haiku-4-5
    tags: [cheap]
    max_tokens: 512
    instructions: |
      You are the fast lane.
  strong:
    model: claude-opus-4-7
    tags: [strong]
agent:
  model: $strong
  instructions: spec instructions
  model_pool:
    policy: learned
    candidates:
      - model: $fast
      - model: $strong
`;

const PLAIN_SPEC = `name: plain-eval
target: cli
agent:
  model: claude-opus-4-7
  instructions: spec instructions
`;

function irOf(spec: string): IrV0 {
  const ir: IrNode = lower(parseSpec(spec));
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

// ---------------------------------------------------------------------------

describe("parseEvalRoutingMode", () => {
  test("accepts the three shapes and rejects everything else", () => {
    expect(parseEvalRoutingMode("static")).toBe("static");
    expect(parseEvalRoutingMode(" as-declared ")).toBe("as-declared");
    expect(parseEvalRoutingMode("candidate:$fast")).toBe("candidate:$fast");
    expect(() => parseEvalRoutingMode("candidate:")).toThrow(/name the roster member/);
    expect(() => parseEvalRoutingMode("as declared")).toThrow(
      /static \| as-declared \| candidate:/,
    );
  });

  test("candidate refs strip the $ sigil; static is the absent default", () => {
    expect(evalRoutingCandidateRef("candidate:$fast")).toBe("fast");
    expect(evalRoutingCandidateRef("candidate:claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(evalRoutingCandidateRef("as-declared")).toBeUndefined();
    expect(isStaticRouting(undefined)).toBe(true);
    expect(isStaticRouting("static")).toBe(true);
    expect(isStaticRouting("as-declared")).toBe(false);
  });
});

describe("resolveEvalRouting", () => {
  test("static resolves to the configured model and wires nothing", () => {
    const ir = irOf(POOL_SPEC);
    const resolved = resolveEvalRouting(ir, "static");
    expect(resolved.fragment).toBeUndefined();
    expect(resolved.armId).toBeUndefined();
    expect(resolved.model).toBe(ir.agent.model);
  });

  test("as-declared carries the pool and PINS learning.seed to the eval seed", () => {
    const ir = irOf(POOL_SPEC);
    const resolved = resolveEvalRouting(ir, "as-declared", { seed: 7 });
    expect(resolved.fragment?.modelPool?.policy).toBe("learned");
    expect(resolved.fragment?.modelPool?.learning?.seed).toBe("7");
    expect(resolved.learningSeed).toBe("7");
    // Absent --seed still pins — a CONSTANT, not the runId, so two runs agree.
    expect(resolveEvalRouting(ir, "as-declared").learningSeed).toBe(DEFAULT_EVAL_LEARNING_SEED);
  });

  test("as-declared on a spec with no routing at all is a loud error", () => {
    expect(() => resolveEvalRouting(irOf(PLAIN_SPEC), "as-declared")).toThrow(
      /declares no model_pool, model_tiers or model_fallbacks/,
    );
  });

  test("candidate: pins the roster member's model, params and overlay", () => {
    const ir = irOf(POOL_SPEC);
    const resolved = resolveEvalRouting(ir, "candidate:$fast");
    expect(resolved.model).toBe("claude-haiku-4-5");
    expect(resolved.armId).toBe("fast");
    expect(resolved.params?.maxTokens).toBe(512);
    expect(resolved.overlay).toContain("fast lane");
    // No pool is wired: a pinned candidate is a single-model measurement.
    expect(resolved.fragment?.modelPool).toBeUndefined();
  });

  test("candidate: also accepts the bare model string of a roster member", () => {
    expect(resolveEvalRouting(irOf(POOL_SPEC), "candidate:claude-haiku-4-5").armId).toBe("fast");
  });

  test("an unknown candidate names what IS declared instead of guessing", () => {
    expect(() => resolveEvalRouting(irOf(POOL_SPEC), "candidate:$cheep")).toThrow(
      /no such roster member/,
    );
    expect(rosterRefs(irOf(POOL_SPEC))).toContain("$fast");
    expect(poolArmIds(irOf(POOL_SPEC).agent.modelPool as never)).toEqual(["fast", "strong"]);
    const candidate = irOf(POOL_SPEC).agent.modelPool?.candidates[0];
    expect(candidateArmId(candidate as never)).toBe("fast");
  });
});

describe("freezeArmsSnapshot", () => {
  const arm = (routeKey: string, model: string, n: number, meanReward: number): ArmStats => ({
    routeKey,
    model,
    n,
    meanReward,
    varReward: 0,
    meanLatencyMs: 100,
    meanCostUsd: 0.001,
    costCount: n,
    meanQuality: 0,
    varQuality: 0,
    qualityCount: 0,
    ungraded: 0,
  });

  test("reads answer from the snapshot and every write is captured, not persisted", () => {
    const frozen = freezeArmsSnapshot([arm("hard", "fast", 12, 0.4)]);
    expect(frozen.score("hard", "fast")?.meanReward).toBe(0.4);
    expect(frozen.score("easy", "fast")).toBeUndefined();

    frozen.record("hard", "fast", 0.9, { success: true, latencyMs: 10, costUsd: 0.002 });
    frozen.ungraded("hard", "strong");
    // The read is UNCHANGED after the write — that is what "frozen" means.
    expect(frozen.score("hard", "fast")?.meanReward).toBe(0.4);
    expect(frozen.observations()).toHaveLength(1);
    expect(frozen.observations()[0]?.reward).toBe(0.9);
    expect(frozen.ungradedArms()).toEqual([{ routeKey: "hard", arm: "strong" }]);
    // No file is ever opened.
    expect(frozen.path).toBe("");
  });

  test("the digest is stable across ordering and changes with the statistics", () => {
    const a = freezeArmsSnapshot([arm("hard", "fast", 1, 0.5), arm("easy", "strong", 2, 0.6)]);
    const b = freezeArmsSnapshot([arm("easy", "strong", 2, 0.6), arm("hard", "fast", 1, 0.5)]);
    expect(a.armsDigest).toBe(b.armsDigest);
    expect(freezeArmsSnapshot([arm("hard", "fast", 2, 0.5)]).armsDigest).not.toBe(a.armsDigest);
    // Two COLD routed runs share a digest, so they compare cleanly.
    expect(freezeArmsSnapshot([]).armsDigest).toBe(armsDigest([]));
  });

  test("readLiveArms treats a harness that never learned as an empty snapshot", () => {
    expect(readLiveArms(newTempRoot())).toEqual([]);
  });
});

describe("served-model attribution", () => {
  const response = (
    model: string,
    extra: Record<string, unknown> = {},
    input = 10,
    output = 5,
  ): TraceEvent =>
    ({
      kind: "model_response",
      timestamp: "2026-09-01T00:00:00.000Z",
      sessionId: "s",
      seq: 1,
      model,
      stopReason: "end_turn",
      usage: { input, output },
      durationMs: 12,
      ...extra,
    }) as unknown as TraceEvent;

  test("a cascade turn's draft and escalation stay SEPARATE entries", () => {
    const served = foldServedModels([
      response("claude-haiku-4-5", { profile: "fast", stage: "draft" }),
      response("claude-haiku-4-5", { profile: "fast", stage: "draft" }),
      response("claude-opus-4-7", { profile: "strong", stage: "escalation" }),
      response("claude-sonnet-4-5", { role: "judge" }),
    ]);
    expect(served).toHaveLength(3);
    expect(served[0]).toMatchObject({
      wire: "claude-haiku-4-5",
      profile: "fast",
      stage: "draft",
      calls: 2,
      tokens: { input: 20, output: 10 },
    });
    expect(served[1]?.stage).toBe("escalation");
    expect(served[2]?.role).toBe("judge");
  });

  test("merging per-sample lists sums calls and tokens per (model, role, stage)", () => {
    const a = foldServedModels([response("m", { profile: "fast" })]);
    const b = foldServedModels([response("m", { profile: "fast" }, 2, 3)]);
    const merged = mergeServedModels([a, b, undefined]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ calls: 2, tokens: { input: 12, output: 8 } });
  });

  test("route decisions fold to the ARM id, never the wire model id", () => {
    const routes = foldRouteDecisions([
      {
        kind: "model_route",
        timestamp: "2026-09-01T00:00:00.000Z",
        sessionId: "s",
        seq: 1,
        routeKey: "hard",
        model: "claude-3-5-haiku-latest",
        specModel: "claude-haiku-4-5",
        profile: "fast",
        policy: "learned",
        reason: "exploit",
        explored: false,
        policyVersion: "abc",
      } as unknown as TraceEvent,
    ]);
    expect(routes).toEqual([
      {
        routeKey: "hard",
        arm: "fast",
        model: "claude-3-5-haiku-latest",
        policy: "learned",
        reason: "exploit",
        policyVersion: "abc",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// End to end through runEval's DEFAULT invoker
// ---------------------------------------------------------------------------

type ChatLoopCall = Record<string, unknown>;

/**
 * A `chatLoop` stub that answers deterministically and publishes the route +
 * response events a routed turn would publish, so the sample's served-model
 * attribution and route lines are exercised for real.
 */
function routingChatLoop(calls: ChatLoopCall[], servedModel: string, profile?: string) {
  return async (
    opts:
      | Parameters<Parameters<typeof runEval>[0]["opts"] extends never ? never : never>[0]
      | ChatLoopCall,
  ) => {
    const o = opts as ChatLoopCall;
    calls.push(o);
    const ctx = o["runContext"] as
      | { eventBus: { envelope(): Record<string, unknown>; publish(e: unknown): void } }
      | undefined;
    if (ctx !== undefined) {
      ctx.eventBus.publish({
        ...ctx.eventBus.envelope(),
        kind: "model_route",
        routeKey: "hard",
        model: servedModel,
        specModel: servedModel,
        ...(profile !== undefined ? { profile } : {}),
        policy: "learned",
        reason: "exploit",
        policyVersion: "pv1",
      });
      ctx.eventBus.publish({
        ...ctx.eventBus.envelope(),
        kind: "model_response",
        model: servedModel,
        ...(profile !== undefined ? { profile } : {}),
        stopReason: "end_turn",
        usage: { input: 4, output: 2 },
        durationMs: 3,
      });
    }
    const seed = o["seedMessages"] as Array<{ content: string }>;
    return `answer for ${seed[seed.length - 1]?.content}`;
  };
}

const SAMPLES: Sample[] = [
  { id: "a", input: "first", expected_output: "answer for first" },
  { id: "b", input: "second", expected_output: "answer for second" },
];
const GRADERS = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n").compiled;

describe("runEval — routing", () => {
  test("static wires no routing options and records no routing manifest", async () => {
    const calls: ChatLoopCall[] = [];
    const outDir = newTempRoot();
    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders: GRADERS,
      opts: {
        outDir,
        cwd: newTempRoot(),
        concurrency: 1,
        chatLoop: routingChatLoop(calls, "claude-opus-4-7") as never,
      },
    });
    expect(summary.config.routing).toBeUndefined();
    expect(calls[0]?.["modelPool"]).toBeUndefined();
    expect(calls[0]?.["_scoreboard"]).toBeUndefined();
  });

  test("as-declared threads the pool and a FROZEN scoreboard into the chat loop", async () => {
    const calls: ChatLoopCall[] = [];
    const outDir = newTempRoot();
    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders: GRADERS,
      opts: {
        outDir,
        cwd: newTempRoot(),
        concurrency: 1,
        seed: 11,
        routing: "as-declared",
        chatLoop: routingChatLoop(calls, "claude-haiku-4-5", "fast") as never,
      },
    });
    const pool = calls[0]?.["modelPool"] as { learning?: { seed?: string } } | undefined;
    expect(pool?.learning?.seed).toBe("11");
    const sb = calls[0]?.["_scoreboard"] as { path: string } | undefined;
    expect(sb).toBeDefined();
    expect(sb?.path).toBe(""); // the frozen reader is not file-backed
    expect(summary.config.routing?.mode).toBe("as-declared");
    expect(summary.config.routing?.armsDigest).toBe(armsDigest([]));
    expect(summary.config.routing?.policyVersion).toBe("pv1");
    expect(summary.config.routing?.warmArms).toBeUndefined();
  });

  test("two as-declared runs on the same seed yield IDENTICAL route lines", async () => {
    const run = async (): Promise<string> => {
      const outDir = newTempRoot();
      await runEval({
        ir: irOf(POOL_SPEC),
        dataset: { name: "d", samples: yieldSamples(SAMPLES) },
        compiledGraders: GRADERS,
        opts: {
          outDir,
          cwd: newTempRoot(),
          concurrency: 1,
          seed: 11,
          routing: "as-declared",
          chatLoop: routingChatLoop([], "claude-haiku-4-5", "fast") as never,
        },
      });
      // The DURABLE artifact, not the in-memory summary: `meta.json` is what a
      // later reader (and a human) compares.
      return readFileSync(join(outDir, "a", "meta.json"), "utf-8")
        .split("\n")
        .filter((l) => l.includes('"routes"') || l.includes('"arm"') || l.includes('"routeKey"'))
        .join("\n");
    };
    const first = await run();
    const second = await run();
    expect(first).toContain('"arm": "fast"');
    expect(second).toBe(first);
  });

  test("served models land on the sample, meta.json and the aggregates", async () => {
    const outDir = newTempRoot();
    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders: GRADERS,
      opts: {
        outDir,
        cwd: newTempRoot(),
        concurrency: 1,
        routing: "as-declared",
        chatLoop: routingChatLoop([], "claude-haiku-4-5", "fast") as never,
      },
    });
    // `model` stays the CONFIGURED model — compatibility is the whole point.
    expect(summary.config.model).toBe("claude-opus-4-7");
    expect(summary.samples[0]?.model).toBe("claude-opus-4-7");
    expect(summary.samples[0]?.servedModels?.[0]).toMatchObject({
      wire: "claude-haiku-4-5",
      profile: "fast",
      calls: 1,
    });
    expect(summary.aggregates.servedModels?.[0]).toMatchObject({
      wire: "claude-haiku-4-5",
      calls: 2,
    });
    const meta = JSON.parse(readFileSync(join(outDir, "a", "meta.json"), "utf-8"));
    expect(meta.servedModels[0].profile).toBe("fast");
    expect(meta.routes[0].arm).toBe("fast");
  });

  test("--warm-arms seeds the snapshot from live arms and DETECTS a mid-run mutation", async () => {
    const harnessRoot = newTempRoot("crewhaus-warm-");
    const live = openScoreboard(harnessRoot);
    live.record("hard", "fast", 0.42, { success: true, latencyMs: 120, costUsd: 0.001 });
    const warmDigest = armsDigest(live.snapshot());

    const calls: ChatLoopCall[] = [];
    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders: GRADERS,
      opts: {
        outDir: newTempRoot(),
        cwd: newTempRoot(),
        concurrency: 1,
        routing: "as-declared",
        warmArms: true,
        routingRootDir: harnessRoot,
        chatLoop: (async (o: ChatLoopCall) => {
          // A CONCURRENT harness learning into the same store while the
          // measurement is in flight.
          openScoreboard(harnessRoot).record("hard", "strong", 0.9, {
            success: true,
            latencyMs: 90,
          });
          return routingChatLoop(calls, "claude-haiku-4-5", "fast")(o);
        }) as never,
      },
    });

    // The measurement itself routed off the FROZEN warm snapshot …
    const sb = calls[0]?.["_scoreboard"] as { score(k: string, m: string): unknown } | undefined;
    expect(sb?.score("hard", "fast")).toMatchObject({ n: 1 });
    expect(sb?.score("hard", "strong")).toBeUndefined();
    expect(summary.config.routing?.armsDigest).toBe(warmDigest);
    expect(summary.config.routing?.warmArms).toBe(true);
    // … and the mutation is REPORTED rather than silently folded in.
    expect(summary.config.routing?.armsMutated).toBe(true);
    // The eval recorded nothing of its own into the live store.
    const after = openScoreboard(harnessRoot).snapshot();
    expect(after.find((a) => a.model === "fast")?.n).toBe(1);
  });

  test("candidate: runs the pinned arm's model, params and overlay", async () => {
    const calls: ChatLoopCall[] = [];
    const outDir = newTempRoot();
    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders: GRADERS,
      opts: {
        outDir,
        cwd: newTempRoot(),
        concurrency: 1,
        routing: "candidate:$fast",
        chatLoop: routingChatLoop(calls, "claude-haiku-4-5", "fast") as never,
      },
    });
    expect(calls[0]?.["model"]).toBe("claude-haiku-4-5");
    expect(calls[0]?.["maxTokens"]).toBe(512);
    expect(String(calls[0]?.["instructions"])).toContain("fast lane");
    expect(calls[0]?.["modelPool"]).toBeUndefined();
    expect(summary.config.routing?.armId).toBe("fast");
  });
});
