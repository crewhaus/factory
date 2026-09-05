/**
 * 0.6.0 §7.2 / §7.11 — the `preRoute` decision phase, unit-tested as the
 * pure function it is: the lane ORDER (forced → directive → rules →
 * classifier → policy over eligible[]), N1 eligibility, the synthetic-
 * message marker that keeps runtime-injected user messages out of the rule
 * and classifier inputs, and the request-copy directive strip.
 */
import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderFeatures } from "@crewhaus/adapter-anthropic";
import type { RouteSignals } from "@crewhaus/model-plan";
import {
  type PreRouteArm,
  type PreRouteContext,
  isSyntheticMessage,
  latestHumanUserMessage,
  markSynthetic,
  messageText,
  preRoute,
  stripDirectiveFromMessage,
} from "./pre-route";

const FULL: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: false,
};
const BLIND: ProviderFeatures = { ...FULL, vision: false };

const FAST: PreRouteArm = {
  armId: "fast",
  modelString: "claude-haiku-4-5",
  tags: ["cheap"],
  capabilities: { features: BLIND, contextWindow: 200_000 },
  blendedPer1M: 1,
};
const MID: PreRouteArm = {
  armId: "mid",
  modelString: "claude-sonnet-5",
  tags: ["balanced"],
  capabilities: { features: FULL, contextWindow: 200_000 },
  blendedPer1M: 6,
};
const STRONG: PreRouteArm = {
  armId: "strong",
  modelString: "claude-opus-5",
  tags: ["strong"],
  capabilities: { features: FULL, contextWindow: 200_000 },
  blendedPer1M: 30,
};
const ROSTER = [FAST, MID, STRONG];

const SIGNALS: RouteSignals = {
  contextTokens: 1_000,
  toolsInPlay: false,
  turnIndex: 2,
  priorTurnToolUseCount: 0,
  userText: "please refactor this stack trace handler",
};

function ctx(over: Partial<PreRouteContext> = {}): PreRouteContext {
  return {
    roster: ROSTER,
    signals: SIGNALS,
    turn: { hasImages: false, contextTokens: SIGNALS.contextTokens, toolsInPlay: false },
    policy: "heuristic",
    ...over,
  };
}

describe("preRoute — lane order (§7.2)", () => {
  test("no lane fires → source none, every arm eligible, no forced arm", async () => {
    const r = await preRoute(ctx());
    expect(r.hint).toEqual({ source: "none", eligible: ["fast", "mid", "strong"], evidence: {} });
    expect(r.excluded).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.ruleId).toBeUndefined();
  });

  test("forced comes FIRST: a budget degrade outranks a directive pin and a matching rule", async () => {
    const r = await preRoute(
      ctx({
        forced: { armId: "fast", lane: "budget", reason: "budget_degrade" },
        pin: "strong",
        rules: [{ id: "always-mid", when: {}, use: "mid" }],
      }),
    );
    expect(r.hint.source).toBe("forced");
    expect(r.hint.forcedArm).toBe("fast");
    expect(r.hint.evidence).toEqual({ lane: "budget", reason: "budget_degrade" });
    expect(r.ruleId).toBeUndefined();
  });

  test("a non-roster degrade rung forces with no forcedArm (the loop substitutes it)", async () => {
    const r = await preRoute(ctx({ forced: { lane: "budget", reason: "budget_degrade" } }));
    expect(r.hint.source).toBe("forced");
    expect(r.hint.forcedArm).toBeUndefined();
  });

  test("the escalation latch is the forced lane too", async () => {
    const r = await preRoute(
      ctx({ forced: { armId: "strong", lane: "escalation", reason: "pool failure" }, pin: "fast" }),
    );
    expect(r.hint).toMatchObject({ source: "forced", forcedArm: "strong" });
  });

  test("directive: an eligible pin forces its arm and outranks the rules", async () => {
    const r = await preRoute(
      ctx({ pin: "mid", rules: [{ id: "code-goes-strong", when: {}, use: "strong" }] }),
    );
    expect(r.hint).toMatchObject({
      source: "directive",
      forcedArm: "mid",
      evidence: { pin: "mid" },
    });
    expect(r.ruleId).toBeUndefined();
  });

  test("directive: an ineligible pin is noted and the ladder continues to the rules", async () => {
    const r = await preRoute(
      ctx({
        pin: "fast",
        signals: { ...SIGNALS, hasImages: true },
        turn: { hasImages: true },
        rules: [{ id: "images-need-vision", when: { has_images: true }, use: "strong" }],
      }),
    );
    expect(r.hint.source).toBe("rule");
    expect(r.hint.forcedArm).toBe("strong");
    expect(r.ruleId).toBe("images-need-vision");
    expect(r.notes[0]).toContain('pin "fast" ineligible this turn (requires:vision)');
    expect(r.eligible).toEqual(["mid", "strong"]);
    expect(r.excluded).toEqual([{ armId: "fast", reason: "requires:vision" }]);
  });

  test("directive: a pin that is not on the roster is noted and skipped", async () => {
    const r = await preRoute(ctx({ pin: "ghost" }));
    expect(r.hint.source).toBe("none");
    expect(r.notes[0]).toContain('pin "ghost" is not on the roster');
  });
});

describe("preRoute — rules (§7.2.2)", () => {
  test("first match wins; a tag target resolves to the first arm carrying it; the ruleId is persisted", async () => {
    const r = await preRoute(
      ctx({
        rules: [
          { id: "disabled", when: {}, use: "fast", enabled: false },
          { id: "no-match", when: { has_images: true }, use: "fast" },
          {
            id: "code-goes-strong",
            when: { message_matches: "(?i)\\b(refactor|stack ?trace)\\b" },
            use: "strong",
          },
          { id: "later", when: {}, use: "mid" },
        ],
      }),
    );
    expect(r.hint).toMatchObject({
      source: "rule",
      forcedArm: "strong",
      evidence: { ruleId: "code-goes-strong", use: "strong" },
    });
    expect(r.ruleId).toBe("code-goes-strong");
  });

  test("use: { requires } narrows eligible[] and picks the cheapest survivor", async () => {
    const r = await preRoute(
      ctx({
        turn: { hasImages: false },
        rules: [{ id: "needs-vision", when: {}, use: { requires: { vision: true } } }],
      }),
    );
    expect(r.hint.source).toBe("rule");
    expect(r.hint.forcedArm).toBe("mid");
    expect(r.eligible).toEqual(["mid", "strong"]);
    expect(r.excluded).toEqual([{ armId: "fast", reason: "requires:vision" }]);
    expect(r.hint.evidence).toEqual({ ruleId: "needs-vision", requires: "vision" });
    expect(r.ruleId).toBe("needs-vision");
  });

  test("a rule whose target is ineligible (or off the roster, or unsatisfiable) is noted; the policy decides", async () => {
    const ineligible = await preRoute(
      ctx({
        turn: { hasImages: true },
        rules: [{ id: "cheap-anyway", when: {}, use: "cheap" }],
      }),
    );
    expect(ineligible.hint.source).toBe("eligibility");
    expect(ineligible.notes[0]).toContain('rule "cheap-anyway" target "fast" ineligible');
    const unknown = await preRoute(ctx({ rules: [{ id: "x", when: {}, use: "turbo" }] }));
    expect(unknown.notes[0]).toContain('names "turbo", which is not on the roster');
    const impossible = await preRoute(
      ctx({ rules: [{ id: "y", when: {}, use: { requires: { web_search: true } } }] }),
    );
    expect(impossible.notes[0]).toContain("no eligible candidate satisfies");
    expect(impossible.hint.source).toBe("none");
  });

  test("a synthetic user message never reaches the rules: the text signal is the latest HUMAN message", async () => {
    // The rules read `signals.userText`, which the loop derives through
    // `latestHumanUserMessage` — so a grader rationale echoing a trigger
    // phrase is invisible to `message_matches`.
    const human: Anthropic.MessageParam = { role: "user", content: "what time is it?" };
    const rationale = markSynthetic({
      role: "user",
      content: "[evaluation failed] Grader feedback: please refactor the stack trace",
    } as Anthropic.MessageParam);
    const latest = latestHumanUserMessage([human, rationale]);
    expect(latest).toBe(human);
    const r = await preRoute(
      ctx({
        signals: { ...SIGNALS, userText: messageText(latest as Anthropic.MessageParam) },
        rules: [{ id: "code-goes-strong", when: { message_matches: "refactor" }, use: "strong" }],
      }),
    );
    expect(r.hint.source).toBe("none");
    expect(r.ruleId).toBeUndefined();
  });

  test("rule guards: an invalid regex is skipped and recorded, never matched", async () => {
    const r = await preRoute(
      ctx({ rules: [{ id: "evil", when: { message_matches: "(a+)+$" }, use: "strong" }] }),
    );
    expect(r.hint.source).toBe("none");
    expect(r.skippedRules).toEqual([{ ruleId: "evil", reason: "rule_skipped:invalid-regex" }]);
  });
});

describe("preRoute — classifier (§7.2.3)", () => {
  test("a declared label resolves through the tags to an eligible arm; the verdict is persisted", async () => {
    const r = await preRoute(
      ctx({
        policy: "classifier",
        classifier: async () => ({ label: "strong", model: "claude-haiku-4-5", costUsdMicros: 12 }),
        classifierLabels: ["cheap", "strong"],
      }),
    );
    expect(r.hint).toMatchObject({
      source: "classifier",
      forcedArm: "strong",
      evidence: { label: "strong" },
    });
    expect(r.classifierVerdict).toEqual({
      label: "strong",
      model: "claude-haiku-4-5",
      costUsdMicros: 12,
    });
  });

  test("failure modes fall back to the policy with reason `classifier failed`: throw, undeclared label, no classifier wired, skipped", async () => {
    const thrown = await preRoute(
      ctx({
        policy: "classifier",
        classifier: async () => {
          throw new Error("boom");
        },
        classifierLabels: ["cheap", "strong"],
      }),
    );
    expect(thrown.hint.source).toBe("none");
    expect(thrown.notes).toEqual(["classifier failed: boom; routing heuristically"]);
    const undeclared = await preRoute(
      ctx({
        policy: "classifier",
        classifier: async () => ({ label: "turbo" }),
        classifierLabels: ["cheap", "strong"],
      }),
    );
    expect(undeclared.notes[0]).toContain(
      'classifier failed: label "turbo" is not one of cheap,strong',
    );
    expect(undeclared.classifierVerdict).toBeUndefined();
    const unwired = await preRoute(ctx({ policy: "classifier" }));
    expect(unwired.notes).toEqual([
      "classifier failed: no classifier wired; routing heuristically",
    ]);
    const skipped = await preRoute(
      ctx({
        policy: "classifier",
        classifier: async () => ({ label: "strong" }),
        classifierLabels: ["cheap", "strong"],
        classifierSkipReason: "judge_share_exhausted",
      }),
    );
    expect(skipped.notes).toEqual([
      "classifier skipped (judge_share_exhausted); routing heuristically",
    ]);
  });

  test("a classifier label whose arm is ineligible this turn is noted and the policy decides over eligible[]", async () => {
    const r = await preRoute(
      ctx({
        policy: "classifier",
        turn: { hasImages: true },
        classifier: async () => ({ label: "cheap" }),
        classifierLabels: ["cheap", "strong"],
      }),
    );
    expect(r.hint.source).toBe("eligibility");
    expect(r.eligible).toEqual(["mid", "strong"]);
    expect(r.classifierVerdict).toEqual({ label: "cheap" });
    expect(r.notes[0]).toContain('"fast" ineligible this turn (requires:vision)');
  });

  test("the classifier does not run under any other policy", async () => {
    let calls = 0;
    await preRoute(
      ctx({
        policy: "heuristic",
        classifier: async () => {
          calls += 1;
          return { label: "strong" };
        },
        classifierLabels: ["cheap", "strong"],
      }),
    );
    expect(calls).toBe(0);
  });
});

describe("preRoute — N1 eligibility (§7.11)", () => {
  test("tools in play require tool_use; a spent cost cap and a too-small context window exclude", async () => {
    const noTools: PreRouteArm = {
      ...MID,
      armId: "local",
      capabilities: { features: { ...FULL, tool_use: false }, contextWindow: 8_000 },
    };
    const spent: PreRouteArm = { ...STRONG, costCapUsdMicros: 10, spentUsdMicros: 10 };
    const r = await preRoute(
      ctx({
        roster: [FAST, noTools, spent],
        turn: { hasImages: false, toolsInPlay: true, contextTokens: 7_500 },
      }),
    );
    expect(r.eligible).toEqual(["fast"]);
    expect(r.excluded).toEqual([
      { armId: "local", reason: "requires:tool_use" },
      { armId: "strong", reason: "cost-cap-spent" },
    ]);
    expect(r.hint.source).toBe("eligibility");
    expect(r.hint.excludedArms).toEqual(["local", "strong"]);
  });

  test("an empty eligible set is reported as such (the loop serves the router's pick and warns)", async () => {
    const r = await preRoute(ctx({ roster: [FAST], turn: { hasImages: true } }));
    expect(r.eligible).toEqual([]);
    expect(r.hint.source).toBe("eligibility");
  });
});

describe("synthetic marker + directive strip", () => {
  test("markSynthetic is identity-keyed and survives array copies of the same object", () => {
    const m: Anthropic.MessageParam = {
      role: "user",
      content: "Please continue from where you left off.",
    };
    expect(isSyntheticMessage(m)).toBe(false);
    markSynthetic(m);
    expect(isSyntheticMessage([m][0] as Anthropic.MessageParam)).toBe(true);
    expect(isSyntheticMessage({ ...m })).toBe(false);
  });

  test("latestHumanUserMessage skips tool-result tails and synthetic pushes", () => {
    const human: Anthropic.MessageParam = {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
      ],
    };
    const toolResult: Anthropic.MessageParam = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42" }],
    };
    const nudge = markSynthetic({ role: "user", content: "/model fast" } as Anthropic.MessageParam);
    expect(
      latestHumanUserMessage([human, { role: "assistant", content: "x" }, toolResult, nudge]),
    ).toBe(human);
    expect(latestHumanUserMessage([toolResult, nudge])).toBeUndefined();
    expect(latestHumanUserMessage([])).toBeUndefined();
  });

  test("stripDirectiveFromMessage: string, blocks with rest, blocks without rest", () => {
    expect(stripDirectiveFromMessage({ role: "user", content: "/model strong hi" }, "hi")).toEqual({
      role: "user",
      content: "hi",
    });
    const image = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png" as const, data: "iVBORw0KGgo=" },
    };
    const blocks: Anthropic.MessageParam = {
      role: "user",
      content: [{ type: "text", text: "/model strong what is this?" }, image],
    };
    expect(stripDirectiveFromMessage(blocks, "what is this?")).toEqual({
      role: "user",
      content: [{ type: "text", text: "what is this?" }, image],
    });
    expect(stripDirectiveFromMessage(blocks, "")).toEqual({ role: "user", content: [image] });
    expect(
      stripDirectiveFromMessage(
        { role: "user", content: [{ type: "text", text: "/model strong" }] },
        "",
      ),
    ).toEqual({ role: "user", content: "" });
  });
});
