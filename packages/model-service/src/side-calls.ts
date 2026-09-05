/**
 * 0.6.0 PR 9d (plan §7.4, §7.6, §7.8, §10.2, §16 Q6) — the side-call
 * closures the composition root builds from `model_pool.strategy`: the GUIDE
 * (plan-execute), the SHADOW (audition lane) and the COMMITTEE (single-turn
 * hosts only). runtime-core owns each one's lifecycle — when it runs, what
 * its text does, the `model_stage` events, the scoreboard fold — and consumes
 * them through `RunChatLoopOptions.sideCalls`; this module owns the MODEL
 * CALLS, all of which go through ONE nested-single-turn runner:
 *
 *   {@link runNestedSingleTurn} — a tool-less `runChatLoop({ singleTurn:
 *   true })` on the target model, minted with its OWN child `RunContext` and
 *   child `TraceEventBus` (`inheritTraceId`, so OTel stitches the trace),
 *   whose `model_request` / `model_response` events are re-published on the
 *   PARENT bus under the parent's envelope with the side call's `role` and
 *   `stage`, so the parent's cost-tracker prices them, its `budgetMeter`
 *   counts them under `judge_share`, and its session mirror persists them.
 *   The child runs with `persistSession: false` (§16 Q6): no child session
 *   file, no child event log — its spend and stages live in the parent's.
 *   Never `adapter.stream` directly, never a parallel `runOneTurn` (§7.6):
 *   the members of a committee run one after another, each on its own loop
 *   state.
 *
 * The Consult runner (`buildConsultRunner` in index.ts) rides the same
 * runner since this PR, which is what closes the wave-2 carry-over (a consult
 * used to persist one child session per question like a Task child).
 *
 * Classification (Pillar 3): a guide's text enters the PARENT's system region
 * and is classified + lineage-tagged by runtime-core at the injection point,
 * exactly once, at TrustOrigin "consult". Committee members' and the shadow's
 * outputs are the harness's own model output judged blind — not a boundary —
 * and the shadow's text is discarded here, never returned.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { ProviderAdapter, ProviderId } from "@crewhaus/adapter-anthropic";
import { DEFAULT_PRICING, computeCostMicros, resolvePricing } from "@crewhaus/cost-tracker";
import { judgePairwise, judgeSelect } from "@crewhaus/eval-judge";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { IrModelPoolStrategy } from "@crewhaus/ir";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import {
  type CommitteeMemberOutcome,
  type CommitteeSideCall,
  type CommitteeVerdict,
  type GuideSideCall,
  type HybridSideCalls,
  type RunChatLoopOptions,
  type ShadowSideCall,
  type SideCallTurnContext,
  runChatLoop,
} from "@crewhaus/runtime-core";
import {
  type ConsultRoster,
  type RosterCandidate,
  resolveRosterTarget,
  rosterFromPool,
  strongestOf,
} from "@crewhaus/tool-consult";
import {
  type ModelResponseEvent,
  type ModelRole,
  type ModelUsage,
  type TraceEvent,
  TraceEventBus,
} from "@crewhaus/trace-event-bus";

// ---------------------------------------------------------------------------
// Deps + the shared nested runner
// ---------------------------------------------------------------------------

/** The SDK message shape, taken from runtime-core's option so this package
 *  needs no direct SDK dependency. */
type MessageParam = NonNullable<RunChatLoopOptions["seedMessages"]>[number];
type TextBlockParam = Extract<
  Exclude<MessageParam["content"], string>[number],
  { readonly type: "text" }
>;

/**
 * The slice of a pool the side calls read — structural over `IrModelPool`
 * so the crew orchestrator's `RoleModelPool` (the runtime's widened pool
 * type) and the IR pool both fit without a cast.
 */
export type SideCallPool = {
  readonly candidates: ReadonlyArray<{
    readonly model: string;
    readonly tags: readonly string[];
    readonly profile?: string;
    readonly enabled?: false;
  }>;
  readonly routing?: { readonly strongTag?: string };
  readonly strategy?: IrModelPoolStrategy;
};

/** The slice of `WireModelsDeps` the side calls read (kept structural so
 *  index.ts stays the one place the deps type is declared). */
export type SideCallDeps = {
  readonly sessionName?: string;
  /**
   * Test injection — pre-built adapters for every nested side-call target
   * (consult, guide, shadow, committee members and tie-breaker), keyed by
   * SPEC model string. Production callers leave it undefined: the nested
   * loop resolves the target through the model-router.
   */
  readonly _consultAdapters?: ReadonlyMap<string, ProviderAdapter>;
  /** Test injection — the shadow's and committee's judge adapter. */
  readonly _judgeAdapter?: ProviderAdapter;
};

export type NestedTarget = {
  readonly modelString: string;
  readonly profile?: string;
};

export type NestedSingleTurnArgs = {
  readonly target: NestedTarget;
  readonly instructions: string;
  readonly seedMessages: ReadonlyArray<MessageParam>;
  readonly role: ModelRole;
  readonly stage?: string;
  /** The parent run's context; a fresh child is minted when absent. */
  readonly parent?: RunContext;
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  readonly sessionTarget: string;
  readonly deps: SideCallDeps;
};

export type NestedSingleTurnResult = {
  readonly text: string;
  /** Wire model id that served (the spec string until the first response). */
  readonly model: string;
  readonly provider: ProviderId;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
  /** Priced from the static table; undefined off-table. */
  readonly costUsd?: number;
};

/**
 * THE nested single-turn side call (plan §7.5 / §7.6). One tool-less turn on
 * the target through `runChatLoop` — never `adapter.stream` — on a child run
 * context whose bus inherits the parent's trace and whose model events are
 * re-published on the parent bus under the parent's envelope with `role` /
 * `stage`. Persists nothing of its own (`persistSession: false`, §16 Q6).
 */
export async function runNestedSingleTurn(
  args: NestedSingleTurnArgs,
): Promise<NestedSingleTurnResult> {
  const { parent, deps } = args;
  const childRunId = `run_${randomUUID().slice(0, 8)}`;
  const childSessionId = `sess_${randomBytes(8).toString("hex")}`;
  const childBus = new TraceEventBus({
    runId: childRunId,
    sessionId: childSessionId,
    ...(parent !== undefined
      ? {
          inheritTraceId: parent.eventBus.traceId,
          inheritParentSpanId: parent.eventBus.currentSpanId,
          logger: parent.logger,
        }
      : {}),
  });
  const child: RunContext = createRunContext({
    runId: childRunId,
    sessionId: childSessionId,
    ...(args.signal !== undefined
      ? { abortSignal: args.signal }
      : parent !== undefined
        ? { abortSignal: parent.abortSignal }
        : {}),
    ...(parent !== undefined ? { logger: parent.logger } : {}),
    eventBus: childBus,
    originStack: [...(parent?.originStack ?? []), "consult"],
  });
  const attribution = {
    role: args.role,
    ...(args.stage !== undefined ? { stage: args.stage } : {}),
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let served: { model: string; provider: ProviderId } | undefined;
  let costUsdMicros: number | undefined;
  let durationMs = 0;
  const unsubscribe = childBus.subscribe((event: TraceEvent) => {
    if (event.kind === "model_response") {
      const r = event as ModelResponseEvent;
      served = { model: r.model, provider: r.provider ?? served?.provider ?? "anthropic" };
      usage.input += r.usage.input;
      usage.output += r.usage.output;
      usage.cacheRead += r.usage.cacheRead ?? 0;
      usage.cacheCreate += r.usage.cacheCreate ?? 0;
      durationMs += r.durationMs;
      const row =
        r.provider !== undefined ? resolvePricing(DEFAULT_PRICING, r.provider, r.model) : undefined;
      if (row !== undefined) {
        costUsdMicros =
          (costUsdMicros ?? 0) +
          computeCostMicros(
            row,
            r.usage.input,
            r.usage.output,
            r.usage.cacheRead ?? 0,
            r.usage.cacheCreate ?? 0,
          );
      }
    }
    if (event.kind !== "model_request" && event.kind !== "model_response") return;
    // Re-publish on the parent so its meter, cost-tracker and session mirror
    // see the call (the child stamped the role; re-stamped defensively).
    if (parent !== undefined) {
      parent.eventBus.publish({ ...event, ...parent.eventBus.envelope(), ...attribution });
    }
  });
  const injected = deps._consultAdapters?.get(args.target.modelString);
  const t0 = performance.now();
  try {
    const text = await runChatLoop({
      model: args.target.modelString,
      instructions: args.instructions,
      tools: [],
      singleTurn: true,
      seedMessages: args.seedMessages,
      runContext: child,
      sessionName: `${deps.sessionName ?? args.sessionTarget}:${args.sessionTarget}`,
      sessionTarget: args.sessionTarget,
      modelRole: args.role,
      ...(args.stage !== undefined ? { modelStage: args.stage } : {}),
      ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      // A child's rules are the parent's business, not the disk's: the side
      // call runs no tools, so there is nothing to merge.
      settingsDir: null,
      // §16 Q6 — no child session file per side call.
      persistSession: false,
      ...(injected !== undefined ? { _adapter: injected } : {}),
    });
    return {
      text,
      model: served?.model ?? args.target.modelString,
      provider: served?.provider ?? "anthropic",
      usage,
      latencyMs: durationMs > 0 ? durationMs : performance.now() - t0,
      ...(costUsdMicros !== undefined ? { costUsd: costUsdMicros / 1_000_000 } : {}),
    };
  } finally {
    unsubscribe();
  }
}

// ---------------------------------------------------------------------------
// Transcript projection shared by the side calls
// ---------------------------------------------------------------------------

/**
 * The transcript a tool-less side call can be handed: text blocks only
 * (a `tool_use` / `tool_result` pair means nothing to a model that has no
 * tools and would orphan under a different toolset), consecutive same-role
 * messages merged, a leading assistant message dropped, ending on a user
 * message. Returns `[]` when no user text survives.
 */
export function textOnlyTranscript(messages: ReadonlyArray<MessageParam>): MessageParam[] {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is TextBlockParam => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    if (text.trim().length === 0) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === m.role) {
      last.content = `${last.content}\n\n${text}`;
    } else {
      out.push({ role: m.role, content: text });
    }
  }
  while (out.length > 0 && out[0]?.role !== "user") out.shift();
  while (out.length > 0 && out[out.length - 1]?.role !== "user") out.pop();
  return out.map((m) => ({ role: m.role, content: m.content }));
}

/** The latest user text in a transcript (the turn's input), if any. */
export function latestUserText(messages: ReadonlyArray<MessageParam>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined || m.role !== "user") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is TextBlockParam => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    if (text.trim().length > 0) return text;
  }
  return undefined;
}

function renderTranscript(messages: ReadonlyArray<MessageParam>, maxChars: number): string {
  const lines = textOnlyTranscript(messages).map(
    (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content as string}`,
  );
  const joined = lines.join("\n\n");
  return joined.length > maxChars ? `…${joined.slice(joined.length - maxChars)}` : joined;
}

function targetFor(roster: ConsultRoster, modelString: string, profile?: string): NestedTarget {
  const member = roster.find((c) => c.modelString === modelString);
  const p = profile ?? member?.profile;
  return { modelString, ...(p !== undefined ? { profile: p } : {}) };
}

function sumUsage(parts: ReadonlyArray<ModelUsage | undefined>): ModelUsage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const u of parts) {
    if (u === undefined) continue;
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead ?? 0;
    total.cacheCreate += u.cacheCreate ?? 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Guide (§7.4)
// ---------------------------------------------------------------------------

/** The guide model's system prompt — it plans; it never answers the user. */
export const GUIDE_INSTRUCTIONS =
  "You are the guide for another model that will actually answer the user. Read the executor's instructions and the conversation so far, then write concise guidance for the executor's next answer: the key steps or plan, the pitfalls to avoid, and what a good answer must contain. Write in the second person to the executor. Do not answer the user yourself, do not address the user, and do not include anything that is not guidance.";

const GUIDE_TRANSCRIPT_MAX_CHARS = 12_000;
export const DEFAULT_GUIDE_MAX_TOKENS = 400;

export function buildGuideSideCall(
  pool: SideCallPool,
  deps: SideCallDeps,
): GuideSideCall | undefined {
  const guide = pool.strategy?.guide;
  if (guide === undefined) return undefined;
  const roster = rosterFromPool(pool);
  const target = targetFor(roster, guide.model, guide.modelProfile);
  const maxTokens = guide.maxTokens ?? DEFAULT_GUIDE_MAX_TOKENS;
  const budgetUsd = guide.budgetUsd;
  let spentUsd = 0;
  return {
    every: guide.every ?? "turn",
    model: guide.model,
    ...(target.profile !== undefined ? { profile: target.profile } : {}),
    run: async (ctx: SideCallTurnContext) => {
      // `guide.budget_usd` — the guide's own spend cap inside the run: past
      // it the guide is skipped (the stage line says so), never the turn.
      if (budgetUsd !== undefined && spentUsd >= budgetUsd) {
        return { text: null, cause: "guide_budget_exhausted" };
      }
      const prompt = [
        "Executor instructions:",
        ctx.instructions,
        "",
        "Conversation so far:",
        renderTranscript(ctx.messages, GUIDE_TRANSCRIPT_MAX_CHARS) || "(no messages yet)",
        "",
        "Write the guidance for the executor's next answer.",
      ].join("\n");
      const result = await runNestedSingleTurn({
        target,
        instructions: GUIDE_INSTRUCTIONS,
        seedMessages: [{ role: "user", content: prompt }],
        role: "guide",
        stage: "guide",
        parent: ctx.runContext,
        signal: ctx.signal,
        maxTokens,
        sessionTarget: "guide",
        deps,
      });
      if (result.costUsd !== undefined) spentUsd += result.costUsd;
      const text = result.text.trim();
      return text.length > 0 ? { text } : { text: null, cause: "empty" };
    },
  };
}

// ---------------------------------------------------------------------------
// Shadow (§7.8)
// ---------------------------------------------------------------------------

export const DEFAULT_SHADOW_SAMPLE_RATE = 0.1;

export function buildShadowSideCall(
  pool: SideCallPool,
  deps: SideCallDeps,
): ShadowSideCall | undefined {
  const shadow = pool.strategy?.shadow;
  if (shadow === undefined) return undefined;
  const roster = rosterFromPool(pool);
  const target = targetFor(roster, shadow.candidate, shadow.candidateProfile);
  const strongTag = pool.routing?.strongTag;
  const judgeModel =
    shadow.gradeWith ??
    (roster.length > 0 ? strongestOf(roster, strongTag).modelString : undefined);
  return {
    candidate: shadow.candidate,
    ...(target.profile !== undefined ? { profile: target.profile } : {}),
    sampleRate: shadow.sampleRate ?? DEFAULT_SHADOW_SAMPLE_RATE,
    run: async (ctx) => {
      const seed = textOnlyTranscript(ctx.messages);
      if (seed.length === 0)
        throw new Error("shadow: the transcript carries no user text to replay");
      // The same request on the shadow candidate — the parent's instructions,
      // the text-only transcript, no tools. Its text is discarded below.
      const result = await runNestedSingleTurn({
        target,
        instructions: ctx.instructions,
        seedMessages: seed,
        role: "shadow",
        stage: "shadow",
        parent: ctx.runContext,
        signal: ctx.signal,
        sessionTarget: "shadow",
        deps,
      });
      // Blind, order-swapped pairwise grading against the primary (prev = the
      // served answer, new = the shadow's), metered on the parent bus as judge
      // spend under `judge_share`.
      const comparison = await judgePairwise({
        input: latestUserText(ctx.messages) ?? "",
        prevOutput: ctx.primaryText,
        newOutput: result.text,
        ...(judgeModel !== undefined ? { model: judgeModel } : {}),
        ...(deps._judgeAdapter !== undefined ? { adapter: deps._judgeAdapter } : {}),
        bus: ctx.bus,
        role: "judge",
        stage: "shadow",
      });
      const verdict =
        comparison.verdict === "new" ? "shadow" : comparison.verdict === "prev" ? "primary" : "tie";
      return {
        verdict,
        agreed: comparison.agreed,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        latencyMs: result.latencyMs,
        ...(judgeModel !== undefined ? { judgeModel } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Committee (§7.6)
// ---------------------------------------------------------------------------

function memberTargets(roster: ConsultRoster, slots: readonly string[], strongTag?: string) {
  const targets: RosterCandidate[] = [];
  for (const slot of slots) {
    const c = resolveRosterTarget(roster, slot, strongTag);
    if (c === undefined) {
      throw new Error(
        `wireSideCalls: committee member "${slot}" names no enabled model_pool candidate (a tag, a profile or a candidate model string)`,
      );
    }
    if (!targets.includes(c)) targets.push(c);
  }
  return targets;
}

export function buildCommitteeSideCall(
  pool: SideCallPool,
  deps: SideCallDeps,
): CommitteeSideCall | undefined {
  const committee = pool.strategy?.committee;
  if (committee === undefined) return undefined;
  const roster = rosterFromPool(pool);
  if (roster.length === 0) return undefined;
  const strongTag = pool.routing?.strongTag;
  const members = memberTargets(roster, committee.members, strongTag);
  if (members.length < 2) {
    throw new Error("wireSideCalls: a committee needs at least two distinct members");
  }
  const judgeModel = committee.judge ?? strongestOf(roster, strongTag).modelString;
  const tieBreaker =
    committee.escalateOnDisagreement !== undefined
      ? resolveRosterTarget(roster, committee.escalateOnDisagreement, strongTag)
      : undefined;
  if (committee.escalateOnDisagreement !== undefined && tieBreaker === undefined) {
    throw new Error(
      `wireSideCalls: committee.escalate_on_disagreement "${committee.escalateOnDisagreement}" names no enabled model_pool candidate`,
    );
  }
  const asTarget = (c: RosterCandidate): NestedTarget => ({
    modelString: c.modelString,
    ...(c.profile !== undefined ? { profile: c.profile } : {}),
  });
  const publishStage = (
    ctx: SideCallTurnContext,
    fields: {
      readonly stage: string;
      readonly role: ModelRole;
      readonly model: string;
      readonly profile?: string;
      readonly outcome: "started" | "done" | "failed" | "skipped";
      readonly cause?: string;
      readonly costUsdMicros?: number;
    },
  ): void => {
    ctx.bus.publish({
      ...ctx.bus.envelope(),
      kind: "model_stage",
      strategy: "committee",
      ...fields,
    });
  };
  return {
    members: members.map(asTarget),
    judge: judgeModel,
    ...(tieBreaker !== undefined ? { escalateOnDisagreement: asTarget(tieBreaker) } : {}),
    run: async (ctx: SideCallTurnContext): Promise<CommitteeVerdict> => {
      const seed = textOnlyTranscript(ctx.messages);
      if (seed.length === 0) throw new Error("committee: the transcript carries no user text");
      // Members run ONE AFTER ANOTHER — each a nested loop with its own state;
      // never a parallel `runOneTurn` (§7.6).
      const outcomes: CommitteeMemberOutcome[] = [];
      const answers: Array<{ target: RosterCandidate; text: string; usage: ModelUsage }> = [];
      // §7.12 — the run's total cap, re-read before every nested call the
      // committee makes: once reached, every call not yet made is excluded
      // (cause `budget`), never opened. Latched so one "stop" is final.
      let capReached = false;
      const budgetStops = async (): Promise<boolean> => {
        if (capReached) return true;
        if (ctx.budgetGate === undefined) return false;
        capReached = (await ctx.budgetGate()) === "stop";
        return capReached;
      };
      for (const member of members) {
        const t = asTarget(member);
        const stage = {
          stage: "member",
          role: "committee" as const,
          model: t.modelString,
          ...(t.profile !== undefined ? { profile: t.profile } : {}),
        };
        if (await budgetStops()) {
          outcomes.push({ ...t, outcome: "skipped", latencyMs: 0, cause: "budget" });
          publishStage(ctx, { ...stage, outcome: "skipped", cause: "budget" });
          continue;
        }
        publishStage(ctx, { ...stage, outcome: "started" });
        try {
          const r = await runNestedSingleTurn({
            target: t,
            instructions: ctx.instructions,
            seedMessages: seed,
            role: "committee",
            stage: "member",
            parent: ctx.runContext,
            signal: ctx.signal,
            sessionTarget: "committee",
            deps,
          });
          if (r.text.trim().length === 0) throw new Error("member returned no text");
          answers.push({ target: member, text: r.text, usage: r.usage });
          outcomes.push({
            ...t,
            model: r.model,
            outcome: "done",
            latencyMs: r.latencyMs,
            usage: r.usage,
          });
          publishStage(ctx, {
            ...stage,
            model: r.model,
            outcome: "done",
            ...(r.costUsd !== undefined ? { costUsdMicros: Math.round(r.costUsd * 1e6) } : {}),
          });
        } catch (err) {
          // §7.13 — a failed member is excluded.
          const message = err instanceof Error ? err.message : String(err);
          outcomes.push({ ...t, outcome: "failed", latencyMs: 0, cause: message });
          publishStage(ctx, { ...stage, outcome: "failed", cause: message });
        }
      }
      const served = (
        pick: { target: RosterCandidate; text: string },
        agreed: boolean,
        escalated: boolean,
        extraUsage: ModelUsage | undefined,
        cause: string,
        quality?: ReadonlyMap<string, number>,
      ): CommitteeVerdict => ({
        text: pick.text,
        winner: {
          modelString: pick.target.modelString,
          model:
            outcomes.find((o) => o.modelString === pick.target.modelString)?.model ??
            pick.target.modelString,
          ...(pick.target.profile !== undefined ? { profile: pick.target.profile } : {}),
        },
        agreed,
        escalated,
        cause,
        members: outcomes.map((o) => {
          const q = quality?.get(o.modelString);
          return q !== undefined ? { ...o, quality: q } : o;
        }),
        usage: sumUsage([...answers.map((a) => a.usage), extraUsage]),
      });
      if (answers.length === 0) {
        throw new Error("committee: every member failed");
      }
      if (answers.length === 1) {
        // Fewer than two survivors: the step falls back to the one that did.
        const only = answers[0] as (typeof answers)[number];
        return served(only, false, false, undefined, "single-member");
      }
      // `decide: judge` — the order-controlled N-way pick, metered as judge
      // spend on the parent bus.
      let selection: Awaited<ReturnType<typeof judgeSelect>> | undefined;
      try {
        selection = await judgeSelect({
          input: latestUserText(ctx.messages) ?? "",
          candidates: answers.map((a) => ({ id: a.target.modelString, output: a.text })),
          model: judgeModel,
          ...(deps._judgeAdapter !== undefined ? { adapter: deps._judgeAdapter } : {}),
          bus: ctx.bus,
          role: "judge",
          stage: "committee",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.runContext.logger.warn("committee judge failed — serving the strongest member", {
          message,
        });
      }
      if (selection?.winner !== undefined) {
        const winnerId = selection.winner;
        const pick = answers.find(
          (a) => a.target.modelString === winnerId,
        ) as (typeof answers)[number];
        const quality = new Map(
          answers.map((a) => [a.target.modelString, a.target.modelString === winnerId ? 1 : 0]),
        );
        return served(pick, true, false, undefined, "agreed", quality);
      }
      // Disagreement (or a failed judge): agreement was the acceptor; the
      // strong tie-breaker answers only now, else the strongest survivor's
      // answer stands with the disagreement recorded.
      const unresolved = new Map(answers.map((a) => [a.target.modelString, 0.5]));
      if (selection !== undefined && tieBreaker !== undefined) {
        const t = asTarget(tieBreaker);
        const stage = {
          stage: "tie-break",
          role: "escalation" as const,
          model: t.modelString,
          ...(t.profile !== undefined ? { profile: t.profile } : {}),
        };
        if (await budgetStops()) {
          // The strong tie-breaker is the committee's most expensive call:
          // past the cap the strongest survivor stands instead.
          publishStage(ctx, { ...stage, outcome: "skipped", cause: "budget" });
        } else {
          publishStage(ctx, { ...stage, outcome: "started", cause: "disagreement" });
          try {
            const r = await runNestedSingleTurn({
              target: t,
              instructions: ctx.instructions,
              seedMessages: seed,
              role: "escalation",
              stage: "tie-break",
              parent: ctx.runContext,
              signal: ctx.signal,
              sessionTarget: "committee",
              deps,
            });
            publishStage(ctx, {
              ...stage,
              model: r.model,
              outcome: "done",
              ...(r.costUsd !== undefined ? { costUsdMicros: Math.round(r.costUsd * 1e6) } : {}),
            });
            const existing = outcomes.find((o) => o.modelString === t.modelString);
            if (existing === undefined) {
              outcomes.push({
                ...t,
                model: r.model,
                outcome: "done",
                latencyMs: r.latencyMs,
                usage: r.usage,
              });
            }
            return served(
              { target: tieBreaker, text: r.text },
              false,
              true,
              r.usage,
              "escalated",
              unresolved,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            publishStage(ctx, { ...stage, outcome: "failed", cause: message });
          }
        }
      }
      const survivors: ConsultRoster = answers.map((a) => a.target);
      const strongest = strongestOf(survivors, strongTag);
      const pick = answers.find((a) => a.target === strongest) as (typeof answers)[number];
      return served(
        pick,
        false,
        false,
        undefined,
        selection === undefined ? "judge-failed" : "disagreement",
        unresolved,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// wireSideCalls — the root's entry, and its codegen twin
// ---------------------------------------------------------------------------

/** True when the pool's strategy declares a guide, a shadow or a committee. */
export function hasSideCallStrategy(pool: SideCallPool | undefined): boolean {
  const st = pool?.strategy;
  return (
    st !== undefined &&
    (st.guide !== undefined || st.shadow !== undefined || st.committee !== undefined)
  );
}

/**
 * Build the `sideCalls` option for a pool. Spread-return-`{}`: a pool whose
 * strategy declares none of the three yields `{}`, so every pre-0.6.0 loop
 * call stays byte-identical. Called once per RUN (the guide's budget cap is
 * per run), never cached across runs.
 */
export function wireSideCalls(
  pool: SideCallPool,
  deps: SideCallDeps = {},
): { readonly sideCalls?: HybridSideCalls } {
  if (!hasSideCallStrategy(pool)) return {};
  const guide = buildGuideSideCall(pool, deps);
  const shadow = buildShadowSideCall(pool, deps);
  const committee = buildCommitteeSideCall(pool, deps);
  const sideCalls: HybridSideCalls = {
    ...(guide !== undefined ? { guide } : {}),
    ...(shadow !== undefined ? { shadow } : {}),
    ...(committee !== undefined ? { committee } : {}),
  };
  return Object.keys(sideCalls).length > 0 ? { sideCalls } : {};
}

/**
 * The codegen twin of {@link wireSideCalls}: the spread field a single-turn
 * emitter (workflow step, graph node) renders onto a pooled block's
 * `runChatLoop({...})` when the pool declares a guide, a shadow or a
 * committee — `\n<indent>...wireSideCalls(<pool blob>, { sessionName }),` —
 * so the bundle constructs the closures at boot through THIS package. `""`
 * for every other pool, keeping pre-9d bundles byte-identical. The pool blob
 * is the same `JSON.stringify` every emitter already writes for `modelPool`.
 */
export function renderSideCallWiringFields(
  fragment: { readonly modelPool?: SideCallPool },
  indent: string,
  sessionName: string,
): string {
  const pool = fragment.modelPool;
  if (pool === undefined || !hasSideCallStrategy(pool)) return "";
  return `\n${indent}...wireSideCalls(${JSON.stringify(pool)}, { sessionName: ${escapeJsonString(sessionName)} }),`;
}
