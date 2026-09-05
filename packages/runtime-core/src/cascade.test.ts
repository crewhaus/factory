/**
 * 0.6.0 §7.3 / §7.10 / §7.13 (PR 9c) — the cascade over the LIVE `runChatLoop`
 * (plan §1 acceptance item 5):
 *
 *  - a seeded failing draft on the cheap arm produces `eval_graded{verdict:
 *    fail, model: <cheap wire>, judgeModel: <judge wire>, escalatedTo}`, a
 *    `model_stage{stage: "escalate", role: "escalation", outcome: "started"}`
 *    (the ONE shape metrics count as an escalation) and a
 *    `model_response{role: "escalation", model: <strong wire>}` served through
 *    `runOneTurn(messages, { force })` (`model_route.policy: "forced"`);
 *  - the draft arm's quality is recorded ONCE, after grading, on a `v:2` line
 *    (`attributedTo: "draft"`, `wouldPass`), plus one `strategy:cascade` line;
 *  - with `clean_prompt` the escalated request's `messages` equal the pre-draft
 *    snapshot; without it the draft stays and the correction is APPENDED;
 *  - a thrown judge records no arm line and increments `ungraded`;
 *  - past `budget.judge_share` the strong rung serves directly with
 *    `reason: "judge_share_exhausted"` — the judge is never skipped silently;
 *  - `max_escalations` (default 1) leaves the last rung's answer standing;
 *  - `forcedCandidate` (the workflow / graph retry seam) runs the whole turn as
 *    the escalation stage and refuses a pool-less run at boot;
 *  - `attachRunEventSink` persists a between-loop `judge_verdict` into the
 *    run's session JSONL.
 *
 * Scripted adapters, real bus, real routing store — no `mock.module`.
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
import { createCostTracker } from "@crewhaus/cost-tracker";
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import type {
  EvalGradedEvent,
  ModelResponseEvent,
  ModelRouteEvent,
  ModelStageEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { type EvaluationTurn, type RunEvaluation, attachRunEventSink, runChatLoop } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-runtime-core-cascade-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

const CHEAP = "claude-haiku-4-5";
const STRONG = "claude-opus-4-1";
/** The judge's wire model (priced: $15/M input → 100_000 tokens = $1.50). */
const JUDGE = "claude-opus-4";

function scriptedAdapter(
  providerId: ProviderId,
  replies: ReadonlyArray<string>,
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

/**
 * A judge standing in for the compiled `judge({ …, bus })` closure: publishes
 * one priced judge-role model call on the turn's bus and returns the scripted
 * verdicts in order (a thrown entry throws).
 */
function judge(
  verdicts: ReadonlyArray<number | Error>,
  overrides: Partial<Omit<RunEvaluation, "evaluate">> = {},
  judgeInputTokens = 100,
): { evaluation: RunEvaluation; turns: EvaluationTurn[] } {
  const turns: EvaluationTurn[] = [];
  let i = 0;
  const evaluation: RunEvaluation = {
    threshold: 0.7,
    onFail: "escalate",
    maxRetries: 1,
    graderType: "llm_judge",
    ...overrides,
    evaluate: async (turn) => {
      turns.push(turn);
      const env = turn.bus.envelope();
      turn.bus.publish({
        ...env,
        kind: "model_request",
        model: JUDGE,
        provider: "anthropic",
        messageCount: 1,
        toolCount: 1,
        streaming: false,
        role: "judge",
      });
      turn.bus.publish({
        ...turn.bus.envelope(),
        spanId: env.spanId,
        kind: "model_response",
        model: JUDGE,
        provider: "anthropic",
        stopReason: "tool_use",
        usage: { input: judgeInputTokens, output: 0 },
        durationMs: 1,
        role: "judge",
      });
      const verdict = verdicts[Math.min(i, verdicts.length - 1)] ?? 1;
      i += 1;
      if (verdict instanceof Error) throw verdict;
      return { score: verdict, rationale: "scripted", judge: { model: JUDGE } };
    },
  };
  return { evaluation, turns };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "crewhaus-cascade-sb-"));
}

type ArmLine = Record<string, unknown>;
function armLines(root: string): ArmLine[] {
  return readFileSync(join(root, "routing", "arms.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ArmLine);
}

const POOL = {
  candidates: [
    { model: CHEAP, tags: ["cheap"], profile: "fast" },
    { model: STRONG, tags: ["strong"], profile: "strong" },
  ],
  policy: "static" as const,
};

type Captured = {
  seen: TraceEvent[];
  graded: EvalGradedEvent[];
  stages: ModelStageEvent[];
  routes: ModelRouteEvent[];
  responses: ModelResponseEvent[];
};
function capture(runContext = createRunContext()): Captured & { runContext: typeof runContext } {
  const seen: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => {
    seen.push(e);
  });
  return {
    runContext,
    seen,
    get graded() {
      return seen.filter((e): e is EvalGradedEvent => e.kind === "eval_graded");
    },
    get stages() {
      return seen.filter((e): e is ModelStageEvent => e.kind === "model_stage");
    },
    get routes() {
      return seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    },
    get responses() {
      return seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
    },
  };
}

const baseRun = (over: Record<string, unknown>) =>
  runChatLoop({
    model: CHEAP,
    instructions: "test",
    modelPool: POOL,
    permissionMode: "auto",
    singleTurn: true,
    seedMessages: [{ role: "user", content: "hard question" }],
    installSigintHandler: false,
    spinner: false,
    stdout: () => {},
    ...over,
  });

describe("cascade — a failing cheap draft escalates to the strong rung (acceptance item 5)", () => {
  test("clean_prompt: eval_graded{fail, model, judgeModel, escalatedTo}, model_stage{escalate}, model_response{role: escalation}, the escalated request equals the pre-draft snapshot, and the draft's quality is recorded once after grading", async () => {
    const cheap = scriptedAdapter("anthropic", ["cheap draft"]);
    const strong = scriptedAdapter("anthropic", ["strong answer"]);
    const root = tmpRoot();
    const { evaluation, turns } = judge([0.2, 0.95], { cleanPrompt: true });
    const cap = capture();
    const result = await baseRun({
      _adapter: cheap,
      _poolAdapters: new Map([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: openScoreboard(root, { now: () => 1_700_000_000_000 }),
      evaluation,
      runContext: cap.runContext,
    });
    expect(result).toBe("strong answer");
    expect(cheap.requests).toHaveLength(1);
    expect(strong.requests).toHaveLength(1);
    // The escalated request saw the PRE-DRAFT snapshot: the seed alone —
    // neither the rejected draft nor a correction.
    expect(strong.requests[0]?.messages).toEqual([{ role: "user", content: "hard question" }]);

    // Two grades: the failing draft (attributed to the cheap arm, naming the
    // rung it was handed to) and the passing escalation.
    const graded = cap.graded;
    expect(graded).toHaveLength(2);
    expect(graded[0]).toMatchObject({
      verdict: "fail",
      score: 0.2,
      model: CHEAP,
      profile: "fast",
      judgeModel: JUDGE,
      escalatedTo: STRONG,
      retryIndex: 0,
    });
    expect(graded[1]).toMatchObject({ verdict: "pass", model: STRONG, profile: "strong" });
    expect("escalatedTo" in (graded[1] ?? {})).toBe(false);
    // The grader saw the served arm and the stage of each attempt.
    expect(turns.map((t) => [t.servedModel, t.profile, t.stage])).toEqual([
      [CHEAP, "fast", "draft"],
      [STRONG, "strong", "escalate"],
    ]);

    // Exactly ONE escalation stage `started` (what metrics count), then `done`.
    const stages = cap.stages;
    expect(stages.map((s) => [s.stage, s.strategy, s.role, s.model, s.profile, s.outcome])).toEqual(
      [
        ["escalate", "cascade", "escalation", STRONG, "strong", "started"],
        ["escalate", "cascade", "escalation", STRONG, "strong", "done"],
      ],
    );
    // The draft's calls carry role "draft"; the forced re-run's, "escalation".
    const responses = cap.responses.filter((r) => r.role !== "judge");
    expect(responses.map((r) => [r.role, r.model, r.stage])).toEqual([
      ["draft", CHEAP, "draft"],
      ["escalation", STRONG, "escalate"],
    ]);
    // The forced decision is a `forced` route onto the strong candidate.
    const routes = cap.routes;
    expect(routes).toHaveLength(2);
    expect(routes[0]?.model).toBe(CHEAP);
    expect(routes[1]).toMatchObject({ model: STRONG, policy: "forced" });
    expect(routes[1]?.reason).toContain("escalated after a failing grade");

    // §7.10 — the arm lines were folded at the TURN boundary, after grading:
    // one draft line with its judged quality (once), one escalation line, one
    // strategy line. The draft's counterfactual: 0.2 < 0.95 → wouldPass 0.
    const lines = armLines(root);
    // Arms key on the SPEC model string (the profile name becomes the key in PR 10's scoped arms).
    const draftLines = lines.filter((l) => l["m"] === CHEAP);
    expect(draftLines).toHaveLength(1);
    expect(draftLines[0]).toMatchObject({
      v: 2,
      q: 0.2,
      st: "draft",
      sg: "cascade",
      at: "draft",
      wp: 0,
    });
    const escLines = lines.filter((l) => l["m"] === STRONG);
    expect(escLines).toHaveLength(1);
    expect(escLines[0]).toMatchObject({ v: 2, q: 0.95, st: "escalate", at: "escalation" });
    expect("wp" in (escLines[0] ?? {})).toBe(false);
    const strategyLines = lines.filter((l) => l["m"] === "strategy:cascade");
    expect(strategyLines).toHaveLength(1);
    expect(strategyLines[0]).toMatchObject({ v: 2, s: 1, q: 0.95, sg: "cascade", at: "strategy" });
    // Under the default `quality_source: none` the REWARD ignores quality (the
    // draft's reward is what a 0.5.x success would have earned).
    const draftReward = draftLines[0]?.["r"] as number;
    expect(draftReward).toBeGreaterThan(0.5);
    // The strategy line is the only extra: 3 lines for one cascade turn.
    expect(lines).toHaveLength(3);
  });

  test("without clean_prompt the draft stays and the correction is APPENDED as a synthetic user message (never written into the draft)", async () => {
    const cheap = scriptedAdapter("anthropic", ["cheap draft"]);
    const strong = scriptedAdapter("anthropic", ["strong answer"]);
    const { evaluation } = judge([0.1, 0.9]);
    const result = await baseRun({
      _adapter: cheap,
      _poolAdapters: new Map([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: openScoreboard(tmpRoot(), { now: () => 1 }),
      evaluation,
    });
    expect(result).toBe("strong answer");
    const msgs = strong.requests[0]?.messages ?? [];
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "user", content: "hard question" });
    expect(msgs[1]?.role).toBe("assistant");
    expect(JSON.stringify(msgs[1]?.content)).toContain("cheap draft");
    expect(msgs[2]?.role).toBe("user");
    expect(String(msgs[2]?.content)).toContain("[evaluation failed: scored 0.10, threshold 0.7]");
  });

  test("draft-verify: the grader's own correction replaces the rationale nudge (retry path) and is appended, not applied in place", async () => {
    const adapter = scriptedAdapter("anthropic", ["draft", "revised"]);
    let i = 0;
    const evaluation: RunEvaluation = {
      threshold: 1,
      onFail: "retry",
      maxRetries: 1,
      graderType: "llm_judge",
      evaluate: async () => {
        i += 1;
        return i === 1
          ? { score: 0, rationale: "off by one", correction: "Recompute the total: 2+2 is 4." }
          : { score: 1, rationale: "ok" };
      },
    };
    const result = await runChatLoop({
      model: CHEAP,
      instructions: "test",
      _adapter: adapter,
      evaluation,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "q" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
    });
    expect(result).toBe("revised");
    const retryMsgs = adapter.requests[1]?.messages ?? [];
    expect(retryMsgs).toHaveLength(3);
    expect(JSON.stringify(retryMsgs[1]?.content)).toContain("draft");
    expect(String(retryMsgs[2]?.content)).toContain(
      "Required correction: Recompute the total: 2+2 is 4.",
    );
    expect(String(retryMsgs[2]?.content)).not.toContain("Grader feedback");
  });

  test("max_escalations (default 1): a failing escalation stands with model_stage{skipped, cause: max_escalations}", async () => {
    const cheap = scriptedAdapter("anthropic", ["cheap draft"]);
    const strong = scriptedAdapter("anthropic", ["strong but still failing"]);
    const { evaluation } = judge([0.1, 0.2, 0.3]);
    const cap = capture();
    const result = await baseRun({
      _adapter: cheap,
      _poolAdapters: new Map([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: openScoreboard(tmpRoot(), { now: () => 1 }),
      evaluation,
      runContext: cap.runContext,
    });
    expect(result).toBe("strong but still failing");
    expect(strong.requests).toHaveLength(1);
    expect(cap.graded).toHaveLength(2);
    expect(cap.stages.map((s) => [s.outcome, s.cause])).toEqual([
      ["started", undefined],
      ["done", undefined],
      ["skipped", "max_escalations"],
    ]);
    // Only the first started stage counts as an escalation.
    expect(
      cap.stages.filter((s) => s.role === "escalation" && s.outcome === "started"),
    ).toHaveLength(1);
  });

  test("a thrown judge records NO arm line for the ungraded attempt and increments `ungraded`", async () => {
    const cheap = scriptedAdapter("anthropic", ["cheap draft"]);
    const strong = scriptedAdapter("anthropic", ["strong"]);
    const root = tmpRoot();
    const sb = openScoreboard(root, { now: () => 1 });
    const { evaluation } = judge([new Error("judge down")]);
    const cap = capture();
    const result = await baseRun({
      _adapter: cheap,
      _poolAdapters: new Map([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: sb,
      evaluation,
      runContext: cap.runContext,
    });
    // Fail open: the draft stands, nothing escalated.
    expect(result).toBe("cheap draft");
    expect(strong.requests).toHaveLength(0);
    expect(cap.graded).toHaveLength(0);
    expect(cap.stages).toHaveLength(0);
    const lines = armLines(root);
    expect(lines.filter((l) => l["agg"] !== 1)).toHaveLength(0); // no reward line at all
    const routeKey = cap.routes[0]?.routeKey as string;
    expect(sb.score(routeKey, CHEAP)).toMatchObject({ n: 0, ungraded: 1 });
  });

  test("past budget.judge_share the strong rung serves DIRECTLY: reason judge_share_exhausted on the route and the stage, no grade, the judge is not skipped silently", async () => {
    // Cap $10 → share $3. Each judge call is 100_000 opus tokens = $1.50, so
    // run 1 (draft graded fail, escalation graded pass) spends exactly $3 on
    // judging; run 2 on the same run-spanning meter starts past the share.
    const cheap = scriptedAdapter("anthropic", ["cheap draft"]);
    const strong = scriptedAdapter("anthropic", ["strong answer"]);
    const runContext = createRunContext();
    const meter = createCostTracker(runContext.eventBus, { suppressEvents: true });
    const cap = capture(runContext);
    const { evaluation } = judge([0.1, 0.9], {}, 100_000);
    const budget = { usdMicros: 10_000_000, onExceed: { kind: "stop" as const } };
    const common = {
      _adapter: cheap,
      _poolAdapters: new Map([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      evaluation,
      runContext,
      budget,
      budgetMeter: meter,
    };
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const first = await baseRun({
        ...common,
        _scoreboard: openScoreboard(tmpRoot(), { now: () => 1 }),
      });
      expect(first).toBe("strong answer");
      expect(cap.graded).toHaveLength(2);
      expect(cap.graded[1]?.reason).toBe("judge_share_exhausted");
      const stagesBefore = cap.stages.length;
      const second = await baseRun({
        ...common,
        _scoreboard: openScoreboard(tmpRoot(), { now: () => 1 }),
        seedMessages: [{ role: "user", content: "second question" }],
      });
      expect(second).toBe("strong answer");
      // No draft, no grade: the strong rung served directly.
      expect(cheap.requests).toHaveLength(1);
      expect(strong.requests).toHaveLength(2);
      expect(cap.graded).toHaveLength(2);
      const newStages = cap.stages.slice(stagesBefore);
      expect(newStages.map((s) => [s.stage, s.role, s.outcome, s.cause])).toEqual([
        ["escalate", "escalation", "started", "judge_share_exhausted"],
        ["escalate", "escalation", "done", undefined],
      ]);
      const lastRoute = cap.routes[cap.routes.length - 1];
      expect(lastRoute).toMatchObject({
        model: STRONG,
        policy: "forced",
        reason: "judge_share_exhausted",
      });
      // The second request saw only its own seed (a fresh single turn on the
      // strong rung), and its calls carry role "escalation".
      expect(strong.requests[1]?.messages).toEqual([{ role: "user", content: "second question" }]);
      const escalationResponses = cap.responses.filter((r) => r.role === "escalation");
      expect(escalationResponses).toHaveLength(2);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderrChunks.join("").includes("judge_share_exhausted")).toBe(true);
  });

  test("escalate without a pool leaves the verdict standing (note semantics) and warns instead of retrying on the same model", async () => {
    const adapter = scriptedAdapter("anthropic", ["only answer", "should not run"]);
    const { evaluation } = judge([0.1]);
    const cap = capture();
    const result = await runChatLoop({
      model: CHEAP,
      instructions: "test",
      _adapter: adapter,
      evaluation,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "q" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      runContext: cap.runContext,
    });
    expect(result).toBe("only answer");
    expect(adapter.requests).toHaveLength(1);
    expect(cap.graded).toHaveLength(1);
    expect(cap.graded[0]?.verdict).toBe("fail");
    expect("escalatedTo" in (cap.graded[0] ?? {})).toBe(false);
    expect(cap.stages).toHaveLength(0);
  });
});

describe("forcedCandidate — the workflow / graph retry seam", () => {
  test("a forced run serves its whole turn on the rung as an escalation stage (started → done), policy forced, role escalation", async () => {
    const cheap = scriptedAdapter("anthropic", ["cheap"]);
    const strong = scriptedAdapter("anthropic", ["strong redo"]);
    const cap = capture();
    const result = await baseRun({
      _adapter: cheap,
      _poolAdapters: new Map([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: openScoreboard(tmpRoot(), { now: () => 1 }),
      forcedCandidate: "strong",
      runContext: cap.runContext,
    });
    expect(result).toBe("strong redo");
    expect(cheap.requests).toHaveLength(0);
    expect(
      cap.stages.map((s) => [s.stage, s.strategy, s.role, s.model, s.outcome, s.cause]),
    ).toEqual([
      ["escalate", "cascade", "escalation", STRONG, "started", "retry_previous"],
      ["escalate", "cascade", "escalation", STRONG, "done", undefined],
    ]);
    expect(cap.routes[0]).toMatchObject({ model: STRONG, policy: "forced" });
    expect(cap.routes[0]?.reason).toContain("forcedCandidate");
    expect(cap.responses[0]).toMatchObject({ role: "escalation", model: STRONG });
  });

  test("a tag, a $profile and a model string all resolve; a pool-less run or an unknown arm is refused at boot", async () => {
    for (const arm of ["strong", "$strong", STRONG]) {
      const cheap = scriptedAdapter("anthropic", ["cheap"]);
      const strong = scriptedAdapter("anthropic", ["strong"]);
      const result = await baseRun({
        _adapter: cheap,
        _poolAdapters: new Map([
          [CHEAP, cheap],
          [STRONG, strong],
        ]),
        _scoreboard: openScoreboard(tmpRoot(), { now: () => 1 }),
        forcedCandidate: arm,
      });
      expect(result).toBe("strong");
    }
    await expect(
      runChatLoop({
        model: CHEAP,
        instructions: "test",
        _adapter: scriptedAdapter("anthropic", ["x"]),
        forcedCandidate: "strong",
        singleTurn: true,
        seedMessages: [{ role: "user", content: "q" }],
        installSigintHandler: false,
        spinner: false,
        stdout: () => {},
      }),
    ).rejects.toThrow(/requires a model_pool/);
    await expect(
      baseRun({
        _adapter: scriptedAdapter("anthropic", ["x"]),
        _poolAdapters: new Map([
          [CHEAP, scriptedAdapter("anthropic", ["x"])],
          [STRONG, scriptedAdapter("anthropic", ["x"])],
        ]),
        _scoreboard: openScoreboard(tmpRoot(), { now: () => 1 }),
        forcedCandidate: "nope",
      }),
    ).rejects.toThrow(/not a roster arm \(declared: fast, strong\)/);
  });
});

describe("attachRunEventSink — a durable sink for between-loop judge_verdict lines", () => {
  test("a judge_verdict published on the shared bus while no loop is live lands in the run's session JSONL; model_stage is left to the live loop's own mirror", async () => {
    const root = mkdtempSync(join(tmpdir(), "crewhaus-run-sink-"));
    const runContext = createRunContext();
    const sink = await attachRunEventSink(runContext, { sessionRootDir: root });
    expect(sink.sessionId).toBe(runContext.sessionId);
    const bus = runContext.eventBus;
    bus.publish({
      ...bus.envelope(),
      kind: "judge_verdict",
      stepOrNode: "gate",
      verdict: "fail",
      score: 0.4,
      rationale: "thin",
      judgeModel: JUDGE,
    });
    bus.publish({
      ...bus.envelope(),
      kind: "model_stage",
      stage: "escalate",
      strategy: "cascade",
      role: "escalation",
      model: STRONG,
      outcome: "started",
    });
    await sink.close();
    // Closed: a later publish is not persisted.
    bus.publish({
      ...bus.envelope(),
      kind: "judge_verdict",
      stepOrNode: "late",
      verdict: "pass",
      score: 1,
    });
    const lines = readFileSync(join(root, `${runContext.sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> });
    expect(lines.map((l) => l.kind)).toEqual(["judge_verdict"]);
    expect(lines[0]?.payload).toMatchObject({
      stepOrNode: "gate",
      verdict: "fail",
      score: 0.4,
      rationale: "thin",
      judgeModel: JUDGE,
    });
    rmSync(root, { recursive: true, force: true });
  });
});
