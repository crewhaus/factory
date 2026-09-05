/**
 * 0.6.0 §7.2 / §7.11 — the `preRoute` decision phase: what runs BEFORE the
 * synchronous `PolicyRouter.route()` call on every pooled model call and
 * produces the `RouteHint` the router consumes. Pure over its context (the
 * one `await` is the opt-in classifier call the loop injects), so every
 * decision replays exactly from the persisted `model_route` line.
 *
 * Order — forced → directive → rules → classifier → policy over `eligible[]`
 * (plan §7.2; the forced lane comes FIRST so a `/model` pin can never disarm
 * a budget degrade or an escalation):
 *
 *   1. eligibility (N1) — the turn's requirement vector (image blocks in the
 *      transcript, tools in play, the context size, a matched rule's
 *      `requires`) intersected with each candidate's features / declared
 *      `requires` / breaker state / `enabled` / remaining per-profile cost
 *      cap → `eligible[]`, persisted;
 *   2. forced — a budget degrade or the escalation latch names the arm
 *      (substituted by the loop; the hint records the lane). The forced arm
 *      is run through the SAME requirement check: an ineligible degrade rung
 *      gives way to the cheapest eligible roster arm, an ineligible
 *      escalation target to the strongest eligible one (§7.11: ineligible
 *      rather than a request-time error), and when nothing eligible remains
 *      the forced arm stands with `no-eligible-candidate` recorded;
 *   3. directive — the session's `/model` pin, when it is on the roster AND
 *      eligible this turn (an ineligible pin is noted and skipped);
 *   4. rules — first-match `model_pool.rules[]`; `use: <tag|arm>` forces that
 *      arm, `use: { requires }` narrows `eligible[]` and picks the cheapest
 *      survivor; the `ruleId` is persisted;
 *   5. classifier — `policy: classifier` runs the injected enum-constrained
 *      label call; any failure falls back to the heuristic policy with the
 *      reason `classifier failed`;
 *   6. otherwise the hint only carries `eligible[]` and the policy decides.
 *
 * Also here: the SYNTHETIC-message marker. runtime-core pushes five kinds of
 * non-human `role: "user"` messages onto the transcript (the grader-rationale
 * correction, the continue nudge, the tombstone retry, loop-detection
 * notices, the resume/toolset marker); they are `synthetic: true` in the
 * event log and marked in memory here so `latestHumanUserMessage` — the
 * text the rules and the classifier read — never sees them (a `/model fast`
 * echoed inside a judge's rationale must not steer routing, §7.2.1).
 * Directives themselves are parsed at the typed INPUT seams (the REPL input,
 * the single-turn seed), never from the transcript.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  type DirectiveRosterArm,
  type EligibilityCandidate,
  type EligibilityExclusionReason,
  type RouteHint,
  type RouteRule,
  type RouteSignals,
  type RuleSkip,
  type TurnRequirement,
  cheapestEligible,
  eligibleCandidates,
  evaluateRules,
  resolveDirectiveTarget,
  strongestArm,
} from "@crewhaus/model-plan";

// ---------------------------------------------------------------------------
// Synthetic-message marker
// ---------------------------------------------------------------------------

const SYNTHETIC_MESSAGES = new WeakSet<object>();

/** Mark a runtime-injected `role: "user"` message as NOT human input. Returns it. */
export function markSynthetic<T extends Anthropic.MessageParam>(message: T): T {
  SYNTHETIC_MESSAGES.add(message);
  return message;
}

/** Was this message injected by the runtime (or replayed from a `synthetic: true` log line)? */
export function isSyntheticMessage(message: Anthropic.MessageParam): boolean {
  return SYNTHETIC_MESSAGES.has(message);
}

/** The text blocks of a message joined by newlines (`""` for a tool-result-only message). */
export function messageText(message: Anthropic.MessageParam): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Does the message carry an image block (directly, not inside a tool_result)? */
export function messageHasImages(message: Anthropic.MessageParam): boolean {
  if (typeof message.content === "string") return false;
  return message.content.some((b) => b.type === "image");
}

/**
 * The latest HUMAN user message: the last `role: "user"` entry that is not
 * synthetic and carries human words or an image (a bare tool-result tail is
 * skipped). `undefined` when none exists.
 */
export function latestHumanUserMessage(
  messages: ReadonlyArray<Anthropic.MessageParam>,
): Anthropic.MessageParam | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined || m.role !== "user" || isSyntheticMessage(m)) continue;
    if (messageText(m).length > 0 || messageHasImages(m)) return m;
  }
  return undefined;
}

/**
 * The request-local copy of a user message with its `/model …` token
 * removed: a string message becomes `rest`; a block message keeps every
 * non-text block and replaces its text with `rest` (dropping the text block
 * when `rest` is empty and other blocks remain). The PERSISTED transcript
 * keeps the token — only the request copy is stripped (§7.2.1).
 */
export function stripDirectiveFromMessage(
  message: Anthropic.MessageParam,
  rest: string,
): Anthropic.MessageParam {
  if (typeof message.content === "string") return { ...message, content: rest };
  const others = message.content.filter((b) => b.type !== "text");
  const firstText = message.content.find((b): b is Anthropic.TextBlockParam => b.type === "text");
  if (rest.length === 0) {
    return others.length > 0 ? { ...message, content: others } : { ...message, content: rest };
  }
  const text: Anthropic.TextBlockParam = {
    ...(firstText ?? { type: "text", text: "" }),
    text: rest,
  };
  return { ...message, content: [text, ...others] };
}

// ---------------------------------------------------------------------------
// preRoute
// ---------------------------------------------------------------------------

/** One roster arm as `preRoute` sees it: the eligibility inputs plus its routing identity. */
export type PreRouteArm = EligibilityCandidate & {
  readonly armId: string;
  readonly modelString: string;
  readonly tags: readonly string[];
};

/** The forced lane's input: a budget degrade or the escalation latch. */
export type PreRouteForced = {
  /** The forced arm's id when it is on the roster (a non-roster degrade rung has none). */
  readonly armId?: string;
  /**
   * The eligibility inputs of a degrade rung that sits OFF the roster (a
   * roster arm is checked through `roster`). Absent → the rung's
   * eligibility is unknown and it is served as-is.
   */
  readonly candidate?: EligibilityCandidate;
  readonly lane: "budget" | "escalation";
  readonly reason: string;
};

export type PreRouteClassifierVerdict = {
  /** One of the pool's declared tags. */
  readonly label: string;
  /** Wire model id of the classifier call. */
  readonly model?: string;
  readonly costUsdMicros?: number;
};

export type PreRouteContext = {
  /** The pool's enabled candidates, declared order. */
  readonly roster: readonly PreRouteArm[];
  readonly signals: RouteSignals;
  /** The turn's requirement vector (N1). */
  readonly turn: TurnRequirement;
  readonly policy: "static" | "heuristic" | "learned" | "classifier";
  readonly forced?: PreRouteForced;
  /** The run's `/model` pin (already roster-validated); honoured only when eligible. */
  readonly pin?: string;
  readonly rules?: readonly RouteRule[];
  /**
   * The injected classifier call (`policy: classifier` only) — resolves to
   * the label, throws on any failure. Absent → "no classifier wired".
   */
  readonly classifier?: () => Promise<PreRouteClassifierVerdict>;
  /** The classifier's declared labels — the closed vocabulary a verdict must come from. */
  readonly classifierLabels?: readonly string[];
  /** Set by the loop when the classifier must not run (e.g. `judge_share_exhausted`). */
  readonly classifierSkipReason?: string;
  /** `model_pool.routing.strongTag` (default `strong`) — for the rule/classifier tag lookup. */
  readonly strongTag?: string;
};

export type PreRouteResult = {
  readonly hint: RouteHint;
  /** Eligible arm ids, declared order (the hint's `eligible`, after any rule narrowing). */
  readonly eligible: readonly string[];
  readonly excluded: ReadonlyArray<{
    readonly armId: string;
    readonly reason: EligibilityExclusionReason;
  }>;
  /** The first-match rule that steered the turn, when one did. */
  readonly ruleId?: string;
  readonly skippedRules: readonly RuleSkip[];
  readonly classifierVerdict?: PreRouteClassifierVerdict;
  /**
   * Set when the forced lane's arm was INELIGIBLE this turn (§7.11): `served`
   * names the eligible roster arm substituted for it — the cheapest for a
   * budget degrade, the strongest for an escalation — and is absent when no
   * eligible arm remained (the loop then keeps the forced arm, records
   * `no-eligible-candidate` and warns).
   */
  readonly forcedIneligible?: {
    readonly armId: string;
    readonly reason: string;
    readonly served?: string;
  };
  /**
   * Human-readable notes for the decision's `reason` — a pin that sat out,
   * a rule whose target was ineligible, a classifier failure. Never user text.
   */
  readonly notes: readonly string[];
};

export async function preRoute(ctx: PreRouteContext): Promise<PreRouteResult> {
  const base = eligibleCandidates(ctx.roster, ctx.turn);
  let eligible: readonly string[] = base.eligible;
  const excluded = [...base.excluded];
  const notes: string[] = [];
  const skippedRules: RuleSkip[] = [];
  const onRoster = (armId: string): boolean => ctx.roster.some((a) => a.armId === armId);
  const isEligible = (armId: string): boolean => eligible.includes(armId);
  const exclusionOf = (armId: string): string =>
    excluded.find((e) => e.armId === armId)?.reason ?? "not eligible";
  const directiveRoster: DirectiveRosterArm[] = ctx.roster.map((a) => ({
    armId: a.armId,
    model: a.modelString,
    tags: a.tags,
  }));
  const done = (hint: RouteHint, extra: Partial<PreRouteResult> = {}): PreRouteResult => ({
    hint,
    eligible,
    excluded,
    skippedRules,
    notes,
    ...extra,
  });
  const excludedArms = (): { readonly excludedArms?: readonly string[] } =>
    excluded.length > 0 ? { excludedArms: excluded.map((e) => e.armId) } : {};

  // 1. forced — first, so nothing below can disarm a safety lane. The forced
  //    arm still passes the N1 requirement check: a rung that cannot take
  //    the turn's images (or its transcript, or its tools) would 400, so an
  //    ineligible one gives way to an eligible roster arm — the cheapest for
  //    the budget lane (the breach still wants the least spend), the
  //    strongest for the escalation lane. With nothing eligible the forced
  //    arm stands and the loop records `no-eligible-candidate`.
  if (ctx.forced !== undefined) {
    const forced = ctx.forced;
    const forcedArmId = forced.armId ?? forced.candidate?.armId;
    const evidence = { lane: forced.lane, reason: forced.reason };
    const forcedReason: string | undefined =
      forced.armId !== undefined
        ? onRoster(forced.armId) && !isEligible(forced.armId)
          ? exclusionOf(forced.armId)
          : undefined
        : forced.candidate !== undefined
          ? eligibleCandidates([forced.candidate], ctx.turn).excluded[0]?.reason
          : undefined;
    if (forcedReason === undefined || forcedArmId === undefined) {
      return done({
        source: "forced",
        ...(forced.armId !== undefined ? { forcedArm: forced.armId } : {}),
        ...excludedArms(),
        eligible,
        evidence,
      });
    }
    const served =
      forced.lane === "budget"
        ? cheapestEligible({ eligible, excluded: [] }, ctx.roster)
        : strongestArm(
            ctx.roster.filter((a) => eligible.includes(a.armId)),
            ctx.strongTag,
          )?.armId;
    notes.push(
      `forced ${forced.lane} arm "${forcedArmId}" ineligible this turn (${forcedReason})${
        served !== undefined ? `; served ${served} instead` : ""
      }`,
    );
    return done(
      {
        source: "forced",
        ...(served !== undefined
          ? { forcedArm: served }
          : forced.armId !== undefined
            ? { forcedArm: forced.armId }
            : {}),
        ...excludedArms(),
        eligible,
        evidence: {
          ...evidence,
          ineligible: forcedArmId,
          ...(served !== undefined ? { served } : {}),
        },
      },
      {
        forcedIneligible: {
          armId: forcedArmId,
          reason: forcedReason,
          ...(served !== undefined ? { served } : {}),
        },
      },
    );
  }

  // 2. directive — the session pin, when it is on the roster and eligible.
  if (ctx.pin !== undefined) {
    if (!onRoster(ctx.pin)) {
      notes.push(`pin "${ctx.pin}" is not on the roster; routing automatically`);
    } else if (!isEligible(ctx.pin)) {
      notes.push(
        `pin "${ctx.pin}" ineligible this turn (${exclusionOf(ctx.pin)}); routing automatically`,
      );
    } else {
      return done({
        source: "directive",
        forcedArm: ctx.pin,
        ...excludedArms(),
        eligible,
        evidence: { pin: ctx.pin },
      });
    }
  }

  // 3. rules — first match wins; the id is persisted either way it resolves.
  if (ctx.rules !== undefined && ctx.rules.length > 0) {
    const result = evaluateRules(ctx.rules, ctx.signals);
    skippedRules.push(...result.skipped);
    const match = result.match;
    if (match !== undefined) {
      if (typeof match.use === "string") {
        const target = resolveDirectiveTarget(match.use, directiveRoster);
        if (target === undefined) {
          notes.push(`rule "${match.ruleId}" names "${match.use}", which is not on the roster`);
        } else if (!isEligible(target)) {
          notes.push(
            `rule "${match.ruleId}" target "${target}" ineligible this turn (${exclusionOf(target)})`,
          );
        } else {
          return done(
            {
              source: "rule",
              forcedArm: target,
              ...excludedArms(),
              eligible,
              evidence: { ruleId: match.ruleId, use: match.use },
            },
            { ruleId: match.ruleId },
          );
        }
      } else {
        // `use: { requires }` — narrow eligibility to the arms that satisfy
        // the demanded capability and pick the cheapest survivor (N1 tie-break).
        const narrowed = eligibleCandidates(ctx.roster, {
          ...ctx.turn,
          requires: { ...(ctx.turn.requires ?? {}), ...match.use.requires },
        });
        const survivors = narrowed.eligible.filter((id) => eligible.includes(id));
        if (survivors.length === 0) {
          notes.push(
            `rule "${match.ruleId}" requires ${Object.keys(match.use.requires).join(",")}, which no eligible candidate satisfies`,
          );
        } else {
          for (const e of narrowed.excluded) {
            if (!excluded.some((x) => x.armId === e.armId)) excluded.push(e);
          }
          eligible = survivors;
          const pick = cheapestEligible({ eligible: survivors, excluded: [] }, ctx.roster);
          return done(
            {
              source: "rule",
              ...(pick !== undefined ? { forcedArm: pick } : {}),
              ...excludedArms(),
              eligible,
              evidence: {
                ruleId: match.ruleId,
                requires: Object.keys(match.use.requires).join(","),
              },
            },
            { ruleId: match.ruleId },
          );
        }
      }
    }
  }

  // 4. classifier — opt-in, model-driven, always with a deterministic fallback.
  let classifierVerdict: PreRouteClassifierVerdict | undefined;
  if (ctx.policy === "classifier") {
    if (ctx.classifierSkipReason !== undefined) {
      notes.push(`classifier skipped (${ctx.classifierSkipReason}); routing heuristically`);
    } else if (ctx.classifier === undefined) {
      notes.push("classifier failed: no classifier wired; routing heuristically");
    } else {
      try {
        const verdict = await ctx.classifier();
        const labels = ctx.classifierLabels ?? [];
        if (!labels.includes(verdict.label)) {
          notes.push(
            `classifier failed: label "${verdict.label}" is not one of ${labels.join(",")}; routing heuristically`,
          );
        } else {
          classifierVerdict = verdict;
          const target = resolveDirectiveTarget(verdict.label, directiveRoster);
          if (target === undefined) {
            notes.push(
              `classifier label "${verdict.label}" names no roster arm; routing heuristically`,
            );
          } else if (!isEligible(target)) {
            notes.push(
              `classifier label "${verdict.label}" → "${target}" ineligible this turn (${exclusionOf(target)}); routing heuristically`,
            );
          } else {
            return done(
              {
                source: "classifier",
                forcedArm: target,
                ...excludedArms(),
                eligible,
                evidence: { label: verdict.label },
              },
              { classifierVerdict },
            );
          }
        }
      } catch (err) {
        notes.push(
          `classifier failed: ${err instanceof Error ? err.message : String(err)}; routing heuristically`,
        );
      }
    }
  }

  // 5. the policy decides over eligible[].
  return done(
    {
      source: eligible.length < ctx.roster.length ? "eligibility" : "none",
      ...excludedArms(),
      eligible,
      evidence: {},
    },
    classifierVerdict !== undefined ? { classifierVerdict } : {},
  );
}

/** Render a hint's evidence as `k=v` pairs for the persisted `hint.evidence` string. */
export function describeHintEvidence(evidence: Readonly<Record<string, unknown>>): string {
  return Object.entries(evidence)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}
