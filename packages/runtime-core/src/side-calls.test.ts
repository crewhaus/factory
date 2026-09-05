/**
 * 0.6.0 PR 9d — the side-call lifecycle runtime-core owns (plan §7.4, §7.6,
 * §7.8, §8.1, §16 Q6):
 *
 *   - GUIDE: runs once per strategy turn before the first model call; its
 *     text lands in the VOLATILE system region after the continuity tail and
 *     after the cache-marked frozen prefix (the cache regression pin), is
 *     classified at TrustOrigin "consult" and lineage-tagged; a failure is
 *     non-fatal; `model_stage` marks every transition.
 *   - SHADOW: scheduled after the answer is final, on the sampled share of
 *     turns, never changes the served text, records BOTH arms into the
 *     `shadow:<band>` lane the router never reads.
 *   - COMMITTEE: replaces the single-turn host's primary turn with the
 *     closure's verdict; refused outside singleTurn.
 *   - `persistSession: false`: no session / event-log file is written.
 *
 * Driven over the real `runChatLoop` with scripted adapters and scripted
 * side-call closures (the hybrid-tools.test.ts pattern).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { RuntimeError } from "@crewhaus/errors";
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import type { ModelRouteEvent, ModelStageEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import {
  type CommitteeVerdict,
  type HybridSideCalls,
  type ShadowVerdict,
  type SideCallTurnContext,
  runChatLoop,
} from "./index";

const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-side-calls-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SHARED_SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
});

const CHEAP = "claude-haiku-4-5";
const STRONG = "claude-opus-4-1";

function textAdapter(
  providerId: ProviderId,
  replies: readonly string[],
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
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
      const text = replies[Math.min(call, replies.length - 1)] ?? "done";
      call += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: 10, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 10, output: 5 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

function tmpScoreboard() {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-side-calls-sb-"));
  return openScoreboard(dir, { now: () => 1_700_000_000_000 });
}

const POOL = {
  candidates: [
    { model: CHEAP, tags: ["cheap"], profile: "fast" },
    { model: STRONG, tags: ["strong"], profile: "strong" },
  ],
  policy: "static" as const,
};

function watch(runContext = createRunContext()) {
  const seen: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => {
    seen.push(e);
  });
  const stages = () => seen.filter((e): e is ModelStageEvent => e.kind === "model_stage");
  const routes = () => seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
  return { runContext, seen, stages, routes };
}

const base = (adapter: ProviderAdapter, sideCalls: HybridSideCalls, extra: object = {}) => ({
  model: CHEAP,
  instructions: "You are the executor.",
  _adapter: adapter,
  modelPool: POOL,
  _poolAdapters: new Map([
    [CHEAP, adapter],
    [STRONG, adapter],
  ]),
  _scoreboard: tmpScoreboard(),
  sideCalls,
  singleTurn: true as const,
  seedMessages: [{ role: "user" as const, content: "ship the feature" }],
  installSigintHandler: false,
  spinner: false,
  stdout: () => {},
  ...extra,
});

describe("guide (§7.4)", () => {
  test("guide text is appended after the continuity tail and after the cache marker, classified and lineage-tagged; stages started → done", async () => {
    const adapter = textAdapter("anthropic", ["executed"]);
    const guideCalls: SideCallTurnContext[] = [];
    const { runContext, stages } = watch();
    const result = await runChatLoop(
      base(
        adapter,
        {
          guide: {
            every: "turn",
            model: STRONG,
            profile: "strong",
            run: async (ctx) => {
              guideCalls.push(ctx);
              return { text: "1. read the spec\n2. implement\n3. test" };
            },
          },
        },
        {
          runContext,
          continuity: { loadPlan: async () => "<current_plan>\nold plan\n</current_plan>" },
        },
      ),
    );
    expect(result).toBe("executed");
    expect(guideCalls).toHaveLength(1);
    expect(guideCalls[0]?.turnNumber).toBe(1);
    expect(guideCalls[0]?.instructions).toBe("You are the executor.");
    expect(guideCalls[0]?.messages.map((m) => m.role)).toEqual(["user"]);
    // Placement: system = [frozen prefix (cache-marked) …, continuity tail, <guide>].
    const system = adapter.requests[0]?.system ?? [];
    const texts = system.map((b) => b.text);
    const planIdx = texts.findIndex((t) => t.includes("<current_plan>"));
    const guideIdx = texts.findIndex((t) => t.startsWith("<guide>"));
    const lastMarked = system.reduce((acc, b, i) => (b.cache_control !== undefined ? i : acc), -1);
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(guideIdx).toBeGreaterThan(planIdx);
    expect(lastMarked).toBeGreaterThanOrEqual(0);
    expect(guideIdx).toBeGreaterThan(lastMarked);
    expect(system[guideIdx]?.cache_control).toBeUndefined();
    expect(texts[guideIdx]).toBe("<guide>\n1. read the spec\n2. implement\n3. test\n</guide>");
    // Pillar 3: classified at origin consult and lineage-tagged.
    expect(runContext.dataLineage?.get("1. read the spec\n2. implement\n3. test")).toBe("consult");
    const guideStages = stages().filter((s) => s.stage === "guide");
    expect(guideStages.map((s) => s.outcome)).toEqual(["started", "done"]);
    expect(guideStages[0]?.role).toBe("guide");
    expect(guideStages[0]?.strategy).toBe("guide");
    expect(guideStages[0]?.model).toBe(STRONG);
    expect(guideStages[0]?.profile).toBe("strong");
  });

  test("runs ONCE per strategy turn — an evaluation retry inside the turn does not re-plan; first_turn writes the plan store", async () => {
    const adapter = textAdapter("anthropic", ["draft", "revised"]);
    let guideRuns = 0;
    const saved: string[] = [];
    let grades = 0;
    const result = await runChatLoop(
      base(
        adapter,
        {
          guide: {
            every: "first_turn",
            model: STRONG,
            run: async () => {
              guideRuns += 1;
              return { text: "the plan" };
            },
          },
        },
        {
          continuity: {
            loadPlan: async () => null,
            savePlan: async (text: string) => {
              saved.push(text);
            },
          },
          evaluation: {
            evaluate: async () => ({ score: grades++ === 0 ? 0 : 1 }),
            threshold: 0.5,
            onFail: "retry" as const,
            maxRetries: 1,
            graderType: "test",
          },
        },
      ),
    );
    expect(result).toBe("revised");
    expect(adapter.requests).toHaveLength(2);
    expect(guideRuns).toBe(1);
    expect(saved).toEqual(["the plan"]);
    // The block stays for the re-run (plan-execute: plan once, execute).
    for (const req of adapter.requests) {
      expect(req.system.some((b) => b.text === "<guide>\nthe plan\n</guide>")).toBe(true);
    }
  });

  test("a guide failure is non-fatal (turn proceeds unguided, stage failed); a null reply is skipped", async () => {
    const adapter = textAdapter("anthropic", ["unguided"]);
    const { runContext, stages } = watch();
    const result = await runChatLoop(
      base(
        adapter,
        {
          guide: {
            every: "turn",
            model: STRONG,
            run: async () => {
              throw new Error("guide model down");
            },
          },
        },
        { runContext },
      ),
    );
    expect(result).toBe("unguided");
    expect(adapter.requests[0]?.system.some((b) => b.text.startsWith("<guide>"))).toBe(false);
    const g = stages().filter((s) => s.stage === "guide");
    expect(g.map((s) => s.outcome)).toEqual(["started", "failed"]);
    expect(g[1]?.cause).toContain("guide model down");

    const adapter2 = textAdapter("anthropic", ["ok"]);
    const w2 = watch();
    await runChatLoop(
      base(
        adapter2,
        {
          guide: {
            every: "turn",
            model: STRONG,
            run: async () => ({ text: null, cause: "nothing to add" }),
          },
        },
        { runContext: w2.runContext },
      ),
    );
    const g2 = w2.stages().filter((s) => s.stage === "guide");
    expect(g2.map((s) => s.outcome)).toEqual(["started", "skipped"]);
    expect(g2[1]?.cause).toBe("nothing to add");
  });

  test("past the judge_share the guide is skipped, never silently", async () => {
    const adapter = textAdapter("anthropic", ["ok"]);
    const { runContext, stages } = watch();
    let ran = 0;
    await runChatLoop(
      base(
        adapter,
        {
          guide: {
            every: "turn",
            model: STRONG,
            run: async () => {
              ran += 1;
              return { text: "plan" };
            },
          },
        },
        {
          runContext,
          // A zero judge_share is exhausted from the first read.
          budget: { usdMicros: 5_000_000, judgeShare: 0, onExceed: { kind: "stop" as const } },
        },
      ),
    );
    expect(ran).toBe(0);
    const g = stages().filter((s) => s.stage === "guide");
    expect(g.map((s) => [s.outcome, s.cause])).toEqual([["skipped", "judge_share_exhausted"]]);
  });

  test("absent sideCalls leaves the request byte-identical (no guide block, no stage events)", async () => {
    const adapter = textAdapter("anthropic", ["plain"]);
    const { runContext, stages } = watch();
    await runChatLoop(base(adapter, {}, { runContext }));
    expect(adapter.requests[0]?.system.some((b) => b.text.includes("<guide>"))).toBe(false);
    expect(stages()).toEqual([]);
  });
});

describe("shadow (§7.8)", () => {
  const verdictOf = (verdict: ShadowVerdict["verdict"], model = STRONG): ShadowVerdict => ({
    verdict,
    agreed: true,
    model,
    provider: "anthropic",
    usage: { input: 10, output: 5 },
    latencyMs: 42,
    judgeModel: STRONG,
  });

  test("runs after the primary answered on the sampled share, never changes the served text, records both arms into the shadow lane", async () => {
    const adapter = textAdapter("anthropic", ["primary answer"]);
    const shadowCalls: Array<SideCallTurnContext & { primaryText: string; primaryModel: string }> =
      [];
    const { runContext, stages, routes } = watch();
    const opts = base(
      adapter,
      {
        shadow: {
          candidate: STRONG,
          profile: "strong",
          sampleRate: 1,
          run: async (ctx) => {
            shadowCalls.push(ctx);
            return verdictOf("shadow");
          },
        },
      },
      { runContext },
    );
    const result = await runChatLoop(opts);
    expect(result).toBe("primary answer");
    expect(shadowCalls).toHaveLength(1);
    expect(shadowCalls[0]?.primaryText).toBe("primary answer");
    expect(shadowCalls[0]?.primaryModel).toBe(CHEAP);
    // The shadow saw exactly the messages the primary answered (the seed,
    // not the assistant reply).
    expect(shadowCalls[0]?.messages.map((m) => m.role)).toEqual(["user"]);
    const s = stages().filter((x) => x.stage === "shadow");
    expect(s.map((x) => x.outcome)).toEqual(["started", "done"]);
    expect(s[1]?.cause).toBe("shadow");
    expect(s[1]?.role).toBe("shadow");
    // Both arms landed in the observe-only lane under the primary's band.
    const band = routes()[0]?.routeKey;
    expect(band).toBeDefined();
    const key = `shadow:${band}`;
    const sb = opts._scoreboard;
    expect(sb.score(key, STRONG)?.n).toBe(1);
    expect(sb.score(key, CHEAP)?.n).toBe(1);
    expect(sb.score(key, STRONG)?.meanReward ?? 0).toBeGreaterThan(
      sb.score(key, CHEAP)?.meanReward ?? 1,
    );
    // The live arm is untouched by the shadow (one primary observation only).
    expect(sb.score(band as string, CHEAP)?.n).toBe(1);
    expect(sb.score(band as string, STRONG)).toBeUndefined();
  });

  test("sample_rate 0 skips every turn (stage skipped, cause sample_rate); a shadow equal to the served arm is skipped", async () => {
    const adapter = textAdapter("anthropic", ["a"]);
    const w = watch();
    let ran = 0;
    await runChatLoop(
      base(
        adapter,
        {
          shadow: {
            candidate: STRONG,
            sampleRate: 0,
            run: async () => {
              ran += 1;
              return verdictOf("tie");
            },
          },
        },
        { runContext: w.runContext },
      ),
    );
    expect(ran).toBe(0);
    expect(w.stages().map((s) => [s.stage, s.outcome, s.cause])).toEqual([
      ["shadow", "skipped", "sample_rate"],
    ]);

    const w2 = watch();
    await runChatLoop(
      base(
        textAdapter("anthropic", ["b"]),
        { shadow: { candidate: CHEAP, sampleRate: 1, run: async () => verdictOf("tie", CHEAP) } },
        { runContext: w2.runContext },
      ),
    );
    expect(w2.stages().map((s) => [s.outcome, s.cause])).toEqual([["skipped", "same-as-primary"]]);
  });

  test("a shadow failure is dropped: served text unchanged, stage failed, nothing recorded", async () => {
    const adapter = textAdapter("anthropic", ["served"]);
    const w = watch();
    const opts = base(
      adapter,
      {
        shadow: {
          candidate: STRONG,
          sampleRate: 1,
          run: async () => {
            throw new Error("shadow timeout");
          },
        },
      },
      { runContext: w.runContext },
    );
    expect(await runChatLoop(opts)).toBe("served");
    const s = w.stages().filter((x) => x.stage === "shadow");
    expect(s.map((x) => x.outcome)).toEqual(["started", "failed"]);
    expect(s[1]?.cause).toContain("shadow timeout");
    expect(opts._scoreboard.snapshot().filter((a) => a.routeKey.startsWith("shadow:"))).toEqual([]);
  });
});

describe("committee (§7.6)", () => {
  const verdict: CommitteeVerdict = {
    text: "the committee's answer",
    winner: { modelString: STRONG, model: STRONG, profile: "strong" },
    agreed: true,
    escalated: false,
    members: [
      { modelString: CHEAP, model: CHEAP, outcome: "done", latencyMs: 5, quality: 0 },
      { modelString: STRONG, model: STRONG, outcome: "done", latencyMs: 7, quality: 1 },
    ],
    usage: { input: 20, output: 10 },
  };

  test("on a single-turn host the verdict IS the turn: the primary never runs, the text is served and logged, the stage names the winner", async () => {
    const adapter = textAdapter("anthropic", ["primary must not run"]);
    const w = watch();
    const calls: SideCallTurnContext[] = [];
    const result = await runChatLoop(
      base(
        adapter,
        {
          committee: {
            members: [{ modelString: CHEAP }, { modelString: STRONG }],
            judge: STRONG,
            run: async (ctx) => {
              calls.push(ctx);
              return verdict;
            },
          },
        },
        { runContext: w.runContext },
      ),
    );
    expect(result).toBe("the committee's answer");
    expect(adapter.requests).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages.map((m) => m.role)).toEqual(["user"]);
    const c = w.stages().filter((s) => s.stage === "committee");
    expect(c.map((s) => s.outcome)).toEqual(["started", "done"]);
    expect(c[1]?.model).toBe(STRONG);
    expect(c[1]?.profile).toBe("strong");
    expect(c[1]?.cause).toBe("agreed");
  });

  test("a committee that cannot decide falls back to the primary turn (stage failed)", async () => {
    const adapter = textAdapter("anthropic", ["primary fallback"]);
    const w = watch();
    const result = await runChatLoop(
      base(
        adapter,
        {
          committee: {
            members: [{ modelString: CHEAP }, { modelString: STRONG }],
            judge: STRONG,
            run: async () => {
              throw new Error("all members failed");
            },
          },
        },
        { runContext: w.runContext },
      ),
    );
    expect(result).toBe("primary fallback");
    expect(adapter.requests).toHaveLength(1);
    const c = w.stages().filter((s) => s.stage === "committee");
    expect(c.map((s) => s.outcome)).toEqual(["started", "failed"]);
  });

  test("a committee outside singleTurn mode is refused at boot", async () => {
    const adapter = textAdapter("anthropic", ["x"]);
    await expect(
      runChatLoop({
        ...base(adapter, {
          committee: {
            members: [{ modelString: CHEAP }, { modelString: STRONG }],
            judge: STRONG,
            run: async () => verdict,
          },
        }),
        singleTurn: false,
        seedMessages: [],
      } as never),
    ).rejects.toThrow(RuntimeError);
  });
});

describe("persistSession: false (§16 Q6)", () => {
  test("writes no session or event-log file, serves the turn, publishes normally; refuses resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "crewhaus-ephemeral-"));
    const adapter = textAdapter("anthropic", ["ephemeral reply"]);
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const result = await runChatLoop({
      model: CHEAP,
      instructions: "i",
      _adapter: adapter,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "q" }],
      persistSession: false,
      sessionRootDir: root,
      runContext,
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
    });
    expect(result).toBe("ephemeral reply");
    expect(readdirSync(root)).toEqual([]);
    expect(seen.some((e) => e.kind === "model_response")).toBe(true);
    await expect(
      runChatLoop({
        model: CHEAP,
        instructions: "i",
        _adapter: adapter,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "q" }],
        persistSession: false,
        resume: { sessionId: runContext.sessionId },
        installSigintHandler: false,
        spinner: false,
        stdout: () => {},
      }),
    ).rejects.toThrow(/persistSession: false/);
    rmSync(root, { recursive: true, force: true });
  });

  test("the default still persists (a session file appears)", async () => {
    const root = mkdtempSync(join(tmpdir(), "crewhaus-persisted-"));
    await runChatLoop({
      model: CHEAP,
      instructions: "i",
      _adapter: textAdapter("anthropic", ["r"]),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "q" }],
      sessionRootDir: root,
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
    });
    expect(readdirSync(root).some((f) => f.endsWith(".json"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
