/**
 * 0.6.0 PR 9d — the side-call closures the composition root builds (plan
 * §7.4, §7.6, §7.8, §16 Q6): every model call goes through ONE nested
 * tool-less single-turn `runChatLoop` on a child context whose events are
 * re-published on the parent bus with the side call's role, and which
 * persists NOTHING of its own; the guide caps its own spend; the shadow
 * grades blind with order-swapped pairwise judging and returns only the
 * verdict; the committee runs members one after another, picks by an
 * order-controlled judge, and runs the tie-breaker only on disagreement.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import type { IrModelPool } from "@crewhaus/ir";
import { createRunContext } from "@crewhaus/run-context";
import type { ModelResponseEvent, ModelStageEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import {
  DEFAULT_SHADOW_SAMPLE_RATE,
  GUIDE_INSTRUCTIONS,
  HYBRID_WIRING_KEYS,
  MODEL_WIRING_KEYS,
  SIDE_CALL_WIRING_KEYS,
  buildCommitteeSideCall,
  buildConsultRunner,
  buildGuideSideCall,
  buildShadowSideCall,
  hasSideCallStrategy,
  renderSideCallWiringFields,
  textOnlyTranscript,
  wireModels,
  wireSideCalls,
} from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-model-service-side-calls-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

const CHEAP = "claude-haiku-4-5";
const STRONG = "claude-opus-4-8";
const MID = "claude-sonnet-4-6";

function textAdapter(reply: string): ProviderAdapter & { requests: ProviderRequest[] } {
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

function failingAdapter(): ProviderAdapter {
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
    stream(): AsyncIterable<StreamEvent> {
      return (async function* () {
        yield { kind: "message_start", usage: { input: 1, output: 0 } };
        throw new Error("member is down");
      })();
    },
  };
}

/** A forced-tool judge stub: answers `submit_comparison` / `submit_selection`
 *  from the user text it sees (content-aware or position-biased). */
function judgeStub(
  decide: (userText: string, tool: string) => Record<string, unknown>,
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      const tool = req.tools?.[0]?.name ?? "submit_comparison";
      const userMsg = req.messages.find((m) => m.role === "user");
      const userText =
        typeof userMsg?.content === "string"
          ? userMsg.content
          : (userMsg?.content
              ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n") ?? "");
      const verdict = decide(userText, tool);
      return (async function* () {
        yield { kind: "message_start", usage: { input: 20, output: 0 } };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu_judge", name: tool, input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(verdict) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use", usage: { input: 20, output: 5 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/** Positional pick of the response block containing `needle`. */
function selectContaining(needle: string) {
  return (userText: string, tool: string): Record<string, unknown> => {
    if (tool === "submit_comparison") {
      const m = [
        ...userText.matchAll(/Response ([AB]) <<<UNTRUSTED_[0-9a-f]+>>>\n([\s\S]*?)\n<<<END_/g),
      ];
      const hit = m.find((x) => (x[2] ?? "").includes(needle));
      return { winner: (hit?.[1] ?? "A").toLowerCase(), rationale: `has ${needle}` };
    }
    const m = [
      ...userText.matchAll(/Response (\d+) <<<UNTRUSTED_[0-9a-f]+>>>\n([\s\S]*?)\n<<<END_/g),
    ];
    const hit = m.find((x) => (x[2] ?? "").includes(needle));
    return { winner: hit?.[1] ?? "1", rationale: `has ${needle}` };
  };
}

function watch() {
  const parent = createRunContext();
  parent.turnNumber = 3;
  parent.eventBus.setTurnNumber(3);
  const seen: TraceEvent[] = [];
  parent.eventBus.subscribe((e) => {
    seen.push(e);
  });
  return {
    parent,
    seen,
    responses: () => seen.filter((e): e is ModelResponseEvent => e.kind === "model_response"),
    stages: () => seen.filter((e): e is ModelStageEvent => e.kind === "model_stage"),
  };
}

const POOL: IrModelPool = {
  candidates: [
    { model: CHEAP, tags: ["cheap"], profile: "fast" },
    { model: MID, tags: ["mid"], enabled: false },
    { model: STRONG, tags: ["strong"], profile: "strong" },
  ],
  policy: "heuristic",
};
const ctxOf = (parent: ReturnType<typeof createRunContext>, text = "ship the feature") => ({
  runContext: parent,
  bus: parent.eventBus,
  turnNumber: parent.turnNumber,
  instructions: "You are the executor.",
  messages: [{ role: "user" as const, content: text }],
  signal: parent.abortSignal,
});

describe("wireModels + wireSideCalls (spread-return-{}, key order)", () => {
  test("a strategy with a guide appends `sideCalls` after the routing and hybrid keys; without one nothing is added; --model drops it", () => {
    const pool: IrModelPool = {
      ...POOL,
      strategy: { modelDirected: true, guide: { model: STRONG, modelProfile: "strong" } },
    };
    const wired = wireModels({ modelPool: pool }, {});
    expect(Object.keys(wired)).toEqual([
      "modelPool",
      ...HYBRID_WIRING_KEYS,
      ...SIDE_CALL_WIRING_KEYS,
    ]);
    expect(wired.sideCalls?.guide?.model).toBe(STRONG);
    expect(wired.sideCalls?.guide?.profile).toBe("strong");
    expect(wired.sideCalls?.shadow).toBeUndefined();
    expect(Object.keys(wireModels({ modelPool: POOL }, {}))).toEqual(["modelPool"]);
    expect(wireModels({ modelPool: pool }, { modelOverride: "m" })).toEqual({});
    expect(wireSideCalls(POOL)).toEqual({});
    expect(hasSideCallStrategy(POOL)).toBe(false);
    expect(
      hasSideCallStrategy({
        ...POOL,
        strategy: { cascade: { draft: "cheap", escalateTo: "strong" } },
      }),
    ).toBe(false);
    expect(MODEL_WIRING_KEYS).toHaveLength(4);
  });

  test("renderSideCallWiringFields: '' without a guide/shadow/committee; the spread field with the pool blob otherwise", () => {
    expect(renderSideCallWiringFields({ modelPool: POOL }, "    ", "wf")).toBe("");
    expect(renderSideCallWiringFields({}, "    ", "wf")).toBe("");
    const pool: IrModelPool = {
      ...POOL,
      strategy: { shadow: { candidate: MID, sampleRate: 0.5 } },
    };
    expect(renderSideCallWiringFields({ modelPool: pool }, "    ", 'w"f')).toBe(
      `\n    ...wireSideCalls(${JSON.stringify(pool)}, { sessionName: "w\\"f" }),`,
    );
  });
});

describe("the nested runner persists nothing (§16 Q6) — consult included", () => {
  test("a consult writes no session or event-log file", async () => {
    const before = readdirSync(SESSION_ROOT).length;
    const opus = textAdapter("consulted");
    const runner = buildConsultRunner({ _consultAdapters: new Map([[STRONG, opus]]) });
    const { parent, responses } = watch();
    const reply = await runner({
      target: { modelString: STRONG, tags: ["strong"] },
      question: "q",
      runContext: parent,
    });
    expect(reply.text).toBe("consulted");
    expect(reply.model).toBe(STRONG);
    expect(readdirSync(SESSION_ROOT).length).toBe(before);
    expect(responses().map((r) => r.role)).toEqual(["consult"]);
    expect(parent.turnNumber).toBe(3);
  });
});

describe("guide (§7.4)", () => {
  test("runs the guide model once with the executor's instructions and transcript, re-published as role guide; returns the text", async () => {
    const opus = textAdapter("1. plan\n2. execute");
    const guide = buildGuideSideCall(
      {
        ...POOL,
        strategy: {
          guide: { model: STRONG, modelProfile: "strong", every: "first_turn", maxTokens: 123 },
        },
      },
      { _consultAdapters: new Map([[STRONG, opus]]) },
    );
    expect(guide?.every).toBe("first_turn");
    expect(guide?.profile).toBe("strong");
    const { parent, responses } = watch();
    const reply = await guide?.run(ctxOf(parent));
    expect(reply).toEqual({ text: "1. plan\n2. execute" });
    expect(opus.requests).toHaveLength(1);
    const req = opus.requests[0] as ProviderRequest;
    expect(req.tools ?? []).toHaveLength(0);
    expect(req.maxTokens).toBe(123);
    expect(req.system.map((b) => b.text).join("\n")).toContain(GUIDE_INSTRUCTIONS.slice(0, 40));
    const user = JSON.stringify(req.messages[req.messages.length - 1]?.content);
    expect(user).toContain("You are the executor.");
    expect(user).toContain("User: ship the feature");
    expect(responses().map((r) => [r.role, r.stage])).toEqual([["guide", "guide"]]);
    expect(responses()[0]?.runId).toBe(parent.runId);
    expect(responses()[0]?.turnNumber).toBe(3);
  });

  test("guide.budget_usd caps the guide's own spend: past it the call is skipped with a cause", async () => {
    const haiku = textAdapter("plan");
    const guide = buildGuideSideCall(
      { ...POOL, strategy: { guide: { model: CHEAP, budgetUsd: 0.000001 } } },
      { _consultAdapters: new Map([[CHEAP, haiku]]) },
    );
    const { parent } = watch();
    expect(await guide?.run(ctxOf(parent))).toEqual({ text: "plan" });
    expect(await guide?.run(ctxOf(parent))).toEqual({
      text: null,
      cause: "guide_budget_exhausted",
    });
    expect(haiku.requests).toHaveLength(1);
  });

  test("an empty reply is a skip, not a guide block", async () => {
    const guide = buildGuideSideCall(
      { ...POOL, strategy: { guide: { model: STRONG } } },
      { _consultAdapters: new Map([[STRONG, textAdapter("   ")]]) },
    );
    expect(await guide?.run(ctxOf(watch().parent))).toEqual({ text: null, cause: "empty" });
  });
});

describe("shadow (§7.8)", () => {
  test("re-runs the request on the candidate, grades blind with order-swapped pairwise judging, returns the verdict and discards the text", async () => {
    const shadowModel = textAdapter("the shadow says: use a queue");
    const judge = judgeStub(selectContaining("shadow says"));
    const shadow = buildShadowSideCall(
      {
        ...POOL,
        strategy: {
          shadow: {
            candidate: MID,
            sampleRate: 0.25,
            gradeWith: STRONG,
            gradeWithProfile: "strong",
          },
        },
      },
      { _consultAdapters: new Map([[MID, shadowModel]]), _judgeAdapter: judge },
    );
    expect(shadow?.candidate).toBe(MID);
    expect(shadow?.sampleRate).toBe(0.25);
    const { parent, responses } = watch();
    const v = await shadow?.run({
      ...ctxOf(parent),
      primaryText: "the primary says: poll",
      primaryModel: CHEAP,
    });
    expect(v?.verdict).toBe("shadow");
    expect(v?.agreed).toBe(true);
    expect(v?.model).toBe(MID);
    expect(v?.judgeModel).toBe(STRONG);
    expect(v?.usage.output).toBe(5);
    expect(v).not.toHaveProperty("text");
    // The shadow saw the parent's instructions + the transcript, no tools.
    const req = shadowModel.requests[0] as ProviderRequest;
    expect(req.tools ?? []).toHaveLength(0);
    expect(req.system[0]?.text).toBe("You are the executor.");
    // Two judge calls (both orders), each metered on the parent bus as judge/shadow.
    expect(judge.requests).toHaveLength(2);
    expect(responses().map((r) => [r.role, r.stage])).toEqual([
      ["shadow", "shadow"],
      ["judge", "shadow"],
      ["judge", "shadow"],
    ]);
  });

  test("a position-biased judge (always A) consolidates to a tie; the default sample rate applies", async () => {
    const shadow = buildShadowSideCall(
      { ...POOL, strategy: { shadow: { candidate: MID } } },
      {
        _consultAdapters: new Map([[MID, textAdapter("shadow")]]),
        _judgeAdapter: judgeStub(() => ({ winner: "a", rationale: "first" })),
      },
    );
    expect(shadow?.sampleRate).toBe(DEFAULT_SHADOW_SAMPLE_RATE);
    const v = await shadow?.run({
      ...ctxOf(watch().parent),
      primaryText: "primary",
      primaryModel: CHEAP,
    });
    expect(v?.verdict).toBe("tie");
    expect(v?.agreed).toBe(false);
    // The judge defaulted to the strongest roster member.
    expect(v?.judgeModel).toBe(STRONG);
  });
});

describe("committee (§7.6)", () => {
  const committeePool = (
    extra: Partial<NonNullable<IrModelPool["strategy"]>["committee"]> = {},
  ): IrModelPool => ({
    ...POOL,
    strategy: { committee: { members: ["cheap", "strong"], judge: STRONG, ...extra } },
  });

  test("members run one after another (tool-less, role committee / stage member), the judge picks by content, the winner is served with member stages", async () => {
    const cheap = textAdapter("cheap answer");
    const strong = textAdapter("strong answer with because");
    const committee = buildCommitteeSideCall(committeePool(), {
      _consultAdapters: new Map([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _judgeAdapter: judgeStub(selectContaining("because")),
    });
    expect(committee?.members.map((m) => m.modelString)).toEqual([CHEAP, STRONG]);
    expect(committee?.judge).toBe(STRONG);
    const { parent, responses, stages } = watch();
    const v = await committee?.run(ctxOf(parent));
    expect(v?.text).toBe("strong answer with because");
    expect(v?.winner).toEqual({ modelString: STRONG, model: STRONG, profile: "strong" });
    expect(v?.agreed).toBe(true);
    expect(v?.escalated).toBe(false);
    expect(v?.cause).toBe("agreed");
    expect(v?.members.map((m) => [m.modelString, m.outcome, m.quality])).toEqual([
      [CHEAP, "done", 0],
      [STRONG, "done", 1],
    ]);
    expect(v?.usage).toEqual({ input: 20, output: 10, cacheRead: 0, cacheCreate: 0 });
    expect(cheap.requests[0]?.tools ?? []).toHaveLength(0);
    expect(responses().map((r) => [r.role, r.stage])).toEqual([
      ["committee", "member"],
      ["committee", "member"],
      ["judge", "committee"],
      ["judge", "committee"],
    ]);
    expect(stages().map((s) => [s.stage, s.model, s.outcome])).toEqual([
      ["member", CHEAP, "started"],
      ["member", CHEAP, "done"],
      ["member", STRONG, "started"],
      ["member", STRONG, "done"],
    ]);
  });

  test("on disagreement the tie-breaker answers (role escalation, stage tie-break) and its text is served; agreement never triggers it", async () => {
    const cheap = textAdapter("cheap");
    const strong = textAdapter("strong");
    const tieBreak = textAdapter("the tie-breaker's answer");
    const committee = buildCommitteeSideCall(
      {
        ...POOL,
        candidates: [
          ...POOL.candidates,
          { model: "claude-opus-4-1", tags: ["arbiter"], profile: "arbiter" },
        ],
        strategy: {
          committee: {
            members: ["cheap", "strong"],
            judge: STRONG,
            escalateOnDisagreement: "arbiter",
          },
        },
      },
      {
        _consultAdapters: new Map([
          [CHEAP, cheap],
          [STRONG, strong],
          ["claude-opus-4-1", tieBreak],
        ]),
        // Position-biased: always response 1 → the orders disagree.
        _judgeAdapter: judgeStub(() => ({ winner: "1", rationale: "first" })),
      },
    );
    expect(committee?.escalateOnDisagreement).toEqual({
      modelString: "claude-opus-4-1",
      profile: "arbiter",
    });
    const { parent, stages } = watch();
    const v = await committee?.run(ctxOf(parent));
    expect(v?.text).toBe("the tie-breaker's answer");
    expect(v?.escalated).toBe(true);
    expect(v?.agreed).toBe(false);
    expect(v?.cause).toBe("escalated");
    expect(v?.winner.profile).toBe("arbiter");
    expect(v?.members.map((m) => m.quality)).toEqual([0.5, 0.5, undefined]);
    expect(tieBreak.requests).toHaveLength(1);
    const tb = stages().filter((s) => s.stage === "tie-break");
    expect(tb.map((s) => [s.role, s.outcome, s.cause])).toEqual([
      ["escalation", "started", "disagreement"],
      ["escalation", "done", undefined],
    ]);
  });

  test("disagreement without a tie-breaker serves the strongest survivor and records the disagreement", async () => {
    const committee = buildCommitteeSideCall(committeePool(), {
      _consultAdapters: new Map([
        [CHEAP, textAdapter("cheap")],
        [STRONG, textAdapter("strong")],
      ]),
      _judgeAdapter: judgeStub(() => ({ winner: "1", rationale: "first" })),
    });
    const v = await committee?.run(ctxOf(watch().parent));
    expect(v?.text).toBe("strong");
    expect(v?.cause).toBe("disagreement");
    expect(v?.escalated).toBe(false);
  });

  test("a failed member is excluded; with one survivor its answer stands (single-member); with none the committee throws", async () => {
    const committee = buildCommitteeSideCall(committeePool(), {
      _consultAdapters: new Map([
        [CHEAP, failingAdapter()],
        [STRONG, textAdapter("only the strong one answered")],
      ]),
      _judgeAdapter: judgeStub(selectContaining("x")),
    });
    const { parent, stages } = watch();
    const v = await committee?.run(ctxOf(parent));
    expect(v?.text).toBe("only the strong one answered");
    expect(v?.cause).toBe("single-member");
    expect(v?.members.map((m) => m.outcome)).toEqual(["failed", "done"]);
    expect(stages().find((s) => s.model === CHEAP && s.outcome === "failed")?.cause).toContain(
      "member is down",
    );

    const none = buildCommitteeSideCall(committeePool(), {
      _consultAdapters: new Map([
        [CHEAP, failingAdapter()],
        [STRONG, failingAdapter()],
      ]),
    });
    await expect(none?.run(ctxOf(watch().parent))).rejects.toThrow(/every member failed/);
  });

  test("a member slot naming nothing on the roster, or fewer than two distinct members, fails at wire time", () => {
    expect(() => buildCommitteeSideCall(committeePool({ members: ["cheap", "nope"] }), {})).toThrow(
      /names no enabled/,
    );
    expect(() => buildCommitteeSideCall(committeePool({ members: ["cheap", "fast"] }), {})).toThrow(
      /two distinct/,
    );
  });
});

describe("textOnlyTranscript", () => {
  test("drops tool blocks, merges same-role runs, starts and ends on user", () => {
    const out = textOnlyTranscript([
      { role: "assistant", content: "stray" },
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "file" }] },
      { role: "assistant", content: "reply" },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "trailing" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "b\n\nc" },
    ]);
  });
});

describe("committee budget gate (§7.12)", () => {
  const threePool: IrModelPool = {
    candidates: [
      { model: CHEAP, tags: ["cheap"], profile: "fast" },
      { model: MID, tags: ["mid"] },
      { model: STRONG, tags: ["strong"], profile: "strong" },
    ],
    policy: "heuristic",
  };
  /** A scripted gate: `continue` for the first `allow` reads, `stop` after. */
  const gateAfter = (allow: number) => {
    let reads = 0;
    return {
      reads: () => reads,
      gate: async (): Promise<"continue" | "stop"> => {
        reads += 1;
        return reads <= allow ? "continue" : "stop";
      },
    };
  };

  test("the gate is re-read before every member: once it says stop the remaining members are excluded (skipped, cause budget) and the survivor stands", async () => {
    const cheap = textAdapter("cheap answer");
    const mid = textAdapter("mid answer");
    const strong = textAdapter("strong answer");
    const committee = buildCommitteeSideCall(
      {
        ...threePool,
        strategy: { committee: { members: ["cheap", "mid", "strong"], judge: STRONG } },
      },
      {
        _consultAdapters: new Map([
          [CHEAP, cheap],
          [MID, mid],
          [STRONG, strong],
        ]),
        _judgeAdapter: judgeStub(selectContaining("never judged")),
      },
    );
    const { parent, stages } = watch();
    const g = gateAfter(1);
    const v = await committee?.run({ ...ctxOf(parent), budgetGate: g.gate });
    // At most one priced member ran.
    expect(cheap.requests).toHaveLength(1);
    expect(mid.requests).toHaveLength(0);
    expect(strong.requests).toHaveLength(0);
    expect(v?.text).toBe("cheap answer");
    expect(v?.cause).toBe("single-member");
    expect(v?.members.map((m) => [m.modelString, m.outcome, m.cause])).toEqual([
      [CHEAP, "done", undefined],
      [MID, "skipped", "budget"],
      [STRONG, "skipped", "budget"],
    ]);
    // Latched: one "stop" is final — the third member never re-read the gate.
    expect(g.reads()).toBe(2);
    expect(stages().map((s) => [s.stage, s.model, s.outcome, s.cause])).toEqual([
      ["member", CHEAP, "started", undefined],
      ["member", CHEAP, "done", undefined],
      ["member", MID, "skipped", "budget"],
      ["member", STRONG, "skipped", "budget"],
    ]);
  });

  test("past the cap the tie-breaker is skipped (cause budget): the strongest survivor stands with the disagreement recorded", async () => {
    const tieBreak = textAdapter("the tie-breaker's answer");
    const committee = buildCommitteeSideCall(
      {
        ...POOL,
        candidates: [
          ...POOL.candidates,
          { model: "claude-opus-4-1", tags: ["arbiter"], profile: "arbiter" },
        ],
        strategy: {
          committee: {
            members: ["cheap", "strong"],
            judge: STRONG,
            escalateOnDisagreement: "arbiter",
          },
        },
      },
      {
        _consultAdapters: new Map([
          [CHEAP, textAdapter("cheap")],
          [STRONG, textAdapter("strong")],
          ["claude-opus-4-1", tieBreak],
        ]),
        // Position-biased: the orders disagree, so the tie-breaker is due.
        _judgeAdapter: judgeStub(() => ({ winner: "1", rationale: "first" })),
      },
    );
    const { parent, stages } = watch();
    // Both members pass the gate; the tie-breaker's read is the "stop".
    const v = await committee?.run({ ...ctxOf(parent), budgetGate: gateAfter(2).gate });
    expect(tieBreak.requests).toHaveLength(0);
    expect(v?.text).toBe("strong");
    expect(v?.escalated).toBe(false);
    expect(v?.cause).toBe("disagreement");
    expect(
      stages()
        .filter((s) => s.stage === "tie-break")
        .map((s) => [s.outcome, s.cause]),
    ).toEqual([["skipped", "budget"]]);
  });

  test("without a budgetGate on the context nothing is gated (a run without `budget`)", async () => {
    const cheap = textAdapter("cheap");
    const strong = textAdapter("strong with because");
    const committee = buildCommitteeSideCall(
      { ...POOL, strategy: { committee: { members: ["cheap", "strong"], judge: STRONG } } },
      {
        _consultAdapters: new Map([
          [CHEAP, cheap],
          [STRONG, strong],
        ]),
        _judgeAdapter: judgeStub(selectContaining("because")),
      },
    );
    const v = await committee?.run(ctxOf(watch().parent));
    expect(cheap.requests).toHaveLength(1);
    expect(strong.requests).toHaveLength(1);
    expect(v?.members.map((m) => m.outcome)).toEqual(["done", "done"]);
  });
});
