/**
 * `@crewhaus/tool-consult` — the two MODEL-DIRECTED hybrid tools of the
 * 0.6.0 model-plan release (plan §7.2.4, §7.5; module brief 309), registered
 * by `@crewhaus/model-service`'s `wireModels` only when the pool declares
 * `strategy.model_directed: true`.
 *
 * `Consult({ question, context?, to? })` — the serving model asks a ROSTER
 * sibling (the strongest candidate by default) one question and gets one
 * answer back as a tool result. The runner it is built with performs a nested
 * single-turn `runChatLoop({ singleTurn: true, tools: [], sessionTarget:
 * "consult", modelRole: "consult" })` — through `runChatLoop`, never
 * `adapter.stream`, so `model_request` / `model_response`, `cost_accrual` and
 * budget metering hold (§7.5). The tool itself is pure over that runner.
 *
 * Posture (the `Task` precedent, `@crewhaus/tool-task`): `readOnly: true`,
 * `concurrencySafe: true`, `scope: "internal"`, no `ioCapability` — the socket
 * is opened by the adapter layer inside the runtime's own metered loop, not
 * by the tool. It never joins `BUILTIN_BOOKKEEPING_RULES` (whose contract is
 * "no network, no process boundary"): it takes the mode default like `Task`
 * in default and auto modes, and is allowed in plan mode as a side-effect-free
 * tool (the `WebFetch` convention). An operator who needs it auto-allowed
 * headless writes a spec `yaml` permission rule, which outranks builtin.
 *
 * Pillar 3 — classification happens ONCE, here. The reply re-enters the
 * parent's context through `classifyBoundary(reply, { origin: "consult" })`
 * (block on malicious, the `skill` / `memory` tier) followed by
 * `tagContent(ctx, reply, "consult")` for the sink-side egress fabric — the
 * sub-agent-spawner pattern. The tool therefore sets `classifyOutput: false`
 * so the runtime does not re-classify the same text at origin `"tool"` (the
 * double pass AGENTS.md Pillar 3 rule 6 forbids).
 *
 * Allowlist — `Consult.to` is a model-filled argument. It resolves ONLY
 * against the roster (`model_pool.candidates`): a profile name, a tag, or the
 * exact candidate model string. Anything else is refused with an `is_error`
 * tool result; nothing model-filled can ever name a model outside the spec
 * (§10.1), and no adapter is resolved from model text at runtime.
 *
 * `Escalate({ reason })` — the serving model admits the turn is beyond it.
 * The tool records `model_stage { stage: "escalate", cause: "self" }`,
 * captures a receipt on the {@link EscalationLatch} and returns it. The LOOP
 * consumes the latch: in this release the rest of the turn is served by the
 * escalation target (runtime-core's existing strongest-candidate latch); the
 * clean-prompt re-run through `runOneTurn(messages, { force })` lands with the
 * cascade (PR 9c) on the same latch seam. `strategy.max_escalations`
 * (default 1) bounds it: past the cap the call records
 * `model_stage { outcome: "skipped", cause: "max_escalations" }` and returns a
 * not-a-failure receipt (§7.13).
 *
 * Failure taxonomy (§7.13): a consult failure or timeout returns `is_error`
 * and the parent turn continues; the tool never throws past the executor.
 */
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { CrewhausError } from "@crewhaus/errors";
import { type RunContext, tagContent } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import type { ModelStageEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { z } from "zod";

export const CONSULT_TOOL_NAME = "Consult";
export const ESCALATE_TOOL_NAME = "Escalate";

/** The `strategy` name stamped on every `model_stage` these tools publish. */
export const MODEL_DIRECTED_STRATEGY = "model_directed";

/** The default `strong` tag (mirrors `@crewhaus/model-router`'s `STRONG_TAG`). */
const DEFAULT_STRONG_TAG = "strong";

export class ConsultError extends CrewhausError {
  override readonly name = "ConsultError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

// ---------------------------------------------------------------------------
// The roster — the allowlist every model-filled model argument resolves against
// ---------------------------------------------------------------------------

/**
 * One roster member: a `model_pool.candidates[]` entry as the tools see it.
 * `modelString` is the spec grammar string (the stable arm identity);
 * `profile` is the `models:` profile it was declared under, when any;
 * `modelId` the wire id when the caller already resolved it (for events).
 */
export type RosterCandidate = {
  readonly modelString: string;
  readonly tags: readonly string[];
  readonly profile?: string;
  readonly modelId?: string;
};

export type ConsultRoster = ReadonlyArray<RosterCandidate>;

/**
 * Build the roster from a pool's candidates, dropping withdrawn ones
 * (`enabled: false` never becomes an arm — the same rule runtime-core's pool
 * boot applies). Structural over the IR candidate so the IR package is not a
 * dependency here.
 */
export function rosterFromPool(pool: {
  readonly candidates: ReadonlyArray<{
    readonly model: string;
    readonly tags: readonly string[];
    readonly profile?: string;
    readonly enabled?: false;
  }>;
}): ConsultRoster {
  return pool.candidates
    .filter((c) => c.enabled !== false)
    .map((c) => ({
      modelString: c.model,
      tags: c.tags,
      ...(c.profile !== undefined ? { profile: c.profile } : {}),
    }));
}

/**
 * The strongest roster member — the first `strongTag`-tagged candidate, else
 * the last declared (the router's `escalation()` / `strongest()` convention
 * and the compiler's `strongest` sentinel, plan §4.3).
 */
export function strongestOf(
  roster: ConsultRoster,
  strongTag: string = DEFAULT_STRONG_TAG,
): RosterCandidate {
  const last = roster[roster.length - 1];
  if (last === undefined) {
    throw new ConsultError(
      "tool-consult: the roster is empty — a pool needs one enabled candidate",
    );
  }
  return roster.find((c) => c.tags.includes(strongTag)) ?? last;
}

/**
 * Resolve a model-filled `to` against the roster: the exact candidate model
 * string, a profile name (with or without the `$` sigil), or a tag (the
 * first candidate carrying it; for the strong tag the strongest). Returns
 * `undefined` when nothing matches — the caller refuses.
 */
export function resolveRosterTarget(
  roster: ConsultRoster,
  to: string,
  strongTag: string = DEFAULT_STRONG_TAG,
): RosterCandidate | undefined {
  const wanted = to.trim();
  if (wanted.length === 0) return undefined;
  const byModel = roster.find((c) => c.modelString === wanted);
  if (byModel !== undefined) return byModel;
  const profileName = wanted.startsWith("$") ? wanted.slice(1) : wanted;
  const byProfile = roster.find((c) => c.profile === profileName);
  if (byProfile !== undefined) return byProfile;
  if (wanted === strongTag) return strongestOf(roster, strongTag);
  return roster.find((c) => c.tags.includes(wanted));
}

function describeRoster(roster: ConsultRoster): string {
  return roster
    .map((c) => {
      const names = [c.profile !== undefined ? `$${c.profile}` : undefined, c.modelString].filter(
        (n): n is string => n !== undefined,
      );
      return `${names.join(" / ")}${c.tags.length > 0 ? ` [${c.tags.join(", ")}]` : ""}`;
    })
    .join("; ");
}

/**
 * The run context a tool call carries — `ctx.runContext` when the executor
 * threads it, else the opaque runtime bridge's `runContext` (runtime-core
 * hands the bridge on every run; the tool-wiki / skills-registry pattern).
 */
function runContextOf(ctx: ToolExecuteContext | undefined): RunContext | undefined {
  if (ctx?.runContext !== undefined) return ctx.runContext;
  const bridge = ctx?.bridge as { runContext?: RunContext } | undefined;
  return bridge?.runContext;
}

function publishStage(
  bus: TraceEventBus | undefined,
  fields: Omit<ModelStageEvent, keyof ReturnType<TraceEventBus["envelope"]> | "kind">,
): void {
  if (bus === undefined) return;
  bus.publish({ ...bus.envelope(), kind: "model_stage", ...fields });
}

// ---------------------------------------------------------------------------
// Consult
// ---------------------------------------------------------------------------

const consultInputSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe("The one question to put to the consulted model. Be specific; it has no tools."),
  context: z
    .string()
    .optional()
    .describe(
      "Optional supporting context (the relevant excerpt, not the whole transcript) the consulted model needs to answer.",
    ),
  to: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Which roster candidate to consult: a profile name, a tag, or the candidate's model string as declared in model_pool.candidates. Defaults to the strongest candidate.",
    ),
});

export type ConsultInput = z.infer<typeof consultInputSchema>;

/** What the runner is asked to do: one question, one roster target. */
export type ConsultRequest = {
  readonly target: RosterCandidate;
  readonly question: string;
  readonly context?: string;
  /** The PARENT run's context — the runner mints the child from it. */
  readonly runContext?: RunContext;
  readonly signal?: AbortSignal;
};

export type ConsultReply = {
  readonly text: string;
  /** Wire model id that actually served, when the runner knows it. */
  readonly model?: string;
};

/**
 * The nested single-turn side call, injected by the composition root
 * (`@crewhaus/model-service` builds it over `runChatLoop`). Kept as a
 * closure so this package stays free of the runtime and the tool is unit-
 * testable with a scripted runner.
 */
export type ConsultRunner = (req: ConsultRequest) => Promise<ConsultReply>;

export type CreateConsultToolOptions = {
  readonly roster: ConsultRoster;
  readonly run: ConsultRunner;
  /** The pool's `routing.strongTag` (default `"strong"`). */
  readonly strongTag?: string;
  /** Override the default target (a roster selector, resolved like `to`). */
  readonly defaultTo?: string;
};

export function createConsultTool(opts: CreateConsultToolOptions): RegisteredTool {
  const strongTag = opts.strongTag ?? DEFAULT_STRONG_TAG;
  if (opts.roster.length === 0) {
    throw new ConsultError("createConsultTool: the roster is empty");
  }
  const defaultTarget =
    opts.defaultTo !== undefined
      ? resolveRosterTarget(opts.roster, opts.defaultTo, strongTag)
      : strongestOf(opts.roster, strongTag);
  if (defaultTarget === undefined) {
    throw new ConsultError(
      `createConsultTool: defaultTo ${JSON.stringify(opts.defaultTo)} names no roster candidate (roster: ${describeRoster(opts.roster)})`,
    );
  }
  const description = `Ask another model of this harness's roster one question and get its answer back. Use it when a hard sub-question needs a stronger (or differently specialised) model than you: pass a precise \`question\` and only the \`context\` it needs. The consulted model has no tools and sees nothing else. Optional \`to\` picks the roster candidate (default: the strongest, ${defaultTarget.profile !== undefined ? `$${defaultTarget.profile}` : defaultTarget.modelString}). Roster: ${describeRoster(opts.roster)}.`;

  return buildTool({
    name: CONSULT_TOOL_NAME,
    description,
    inputSchema: consultInputSchema,
    // §7.5 — the Task / WebFetch posture: side-effect-free, parallel-safe,
    // internal (the adapter layer opens the socket inside the metered loop).
    readOnly: true,
    concurrencySafe: true,
    destructive: false,
    scope: "internal",
    // Classified exactly once, at THIS boundary, at origin "consult" — the
    // runtime's post-tool pass at origin "tool" is skipped (Pillar 3 rule 6).
    classifyOutput: false,
    execute: async (input, ctx) => {
      const target =
        input.to !== undefined
          ? resolveRosterTarget(opts.roster, input.to, strongTag)
          : defaultTarget;
      if (target === undefined) {
        // §10.1 — a model-filled model argument is allowlist-validated; nothing
        // resolves an adapter from model text. Refused as an is_error result.
        throw new ConsultError(
          `Consult refused: "${input.to}" is not a roster candidate — name a profile, a tag, or a declared model string (roster: ${describeRoster(opts.roster)})`,
        );
      }
      const runContext = runContextOf(ctx);
      const bus = runContext?.eventBus;
      const model = target.modelId ?? target.modelString;
      // The one boundary pass for EVERYTHING this tool hands back — reply,
      // empty-reply notice, failure message: classify at origin "consult",
      // substitute the redaction notice on a malicious verdict, otherwise
      // lineage-tag the exact content the parent will see. Exactly once per
      // result (the runtime skips its own pass for this tool).
      const admit = async (content: string): Promise<string> => {
        const boundary = await classifyBoundary(content, { origin: "consult" });
        if (boundary.action === "redact" && boundary.redacted !== undefined) {
          return boundary.redacted;
        }
        if (runContext !== undefined) tagContent(runContext, content, "consult");
        return content;
      };
      const stage = {
        stage: "consult",
        strategy: MODEL_DIRECTED_STRATEGY,
        role: "consult" as const,
        model,
        ...(target.profile !== undefined ? { profile: target.profile } : {}),
      };
      publishStage(bus, { ...stage, outcome: "started", cause: "self" });
      let reply: ConsultReply;
      try {
        reply = await opts.run({
          target,
          question: input.question,
          ...(input.context !== undefined ? { context: input.context } : {}),
          ...(runContext !== undefined ? { runContext } : {}),
          ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
        });
      } catch (err) {
        // §7.13 — consult failure / timeout: is_error, the parent continues.
        // The error text is the nested loop's / provider's message — as
        // attacker-shaped as a reply (a proxy's error body, a sibling's
        // refusal text) and, because this tool sets `classifyOutput: false`,
        // NOT re-scrubbed by the runtime's post-tool pass: it crosses the same
        // boundary here before it becomes the is_error content.
        publishStage(bus, { ...stage, outcome: "failed", cause: "consult failed" });
        const message = await admit(
          `Consult failed (${model}): ${err instanceof Error ? err.message : String(err)}`,
        );
        throw new ConsultError(message, err);
      }
      publishStage(bus, {
        ...stage,
        ...(reply.model !== undefined ? { model: reply.model } : {}),
        outcome: "done",
        cause: "self",
      });
      const text = reply.text.trim();
      if (text.length === 0) {
        return admit(`[consult] ${model} returned no text.`);
      }
      // Pillar 3 source side — the reply is a roster sibling's model output
      // shaped by whatever the question carried; it re-enters the parent's
      // context verbatim, so it is classified at origin "consult" (block on
      // malicious) and, when it passes, lineage-tagged for the egress fabric.
      return admit(text);
    },
  });
}

// ---------------------------------------------------------------------------
// Escalate — the receipt and the latch
// ---------------------------------------------------------------------------

const escalateInputSchema = z.object({
  reason: z
    .string()
    .min(1)
    .describe(
      "Why this turn needs a stronger model (one sentence). Recorded as the escalation receipt.",
    ),
});

export type EscalateInput = z.infer<typeof escalateInputSchema>;

/** One accepted self-escalation, as recorded on the latch. */
export type EscalationRequest = {
  /** 1-based receipt number within the run. */
  readonly receipt: number;
  readonly reason: string;
  /** The roster candidate the escalation targets. */
  readonly target: RosterCandidate;
  /** The parent run's turn number when the model asked. */
  readonly turnNumber: number;
  readonly requestedAt: string;
  /** `messages.length` when the loop consumed the request (its pre-escalation snapshot). */
  transcriptLength?: number;
  /** Set when the loop has consumed the request. */
  consumedAt?: string;
};

/**
 * The seam between the `Escalate` tool and the loop. The tool `request`s;
 * the loop `consume`s exactly once per request, at its next model call,
 * snapshotting `messages.length` onto the record. `history()` is the receipt
 * trail (`route explain`, the escalation-precision advise rule). Bounded by
 * `maxEscalations` — the (N+1)th request is refused, not an error.
 */
export type EscalationLatch = {
  readonly target: RosterCandidate;
  readonly maxEscalations: number;
  /** Accepted escalations so far (including a pending, not-yet-consumed one). */
  readonly count: number;
  request(reason: string, turnNumber: number): EscalationRequest | undefined;
  pending(): EscalationRequest | undefined;
  consume(snapshot: { readonly transcriptLength: number }): EscalationRequest | undefined;
  history(): ReadonlyArray<EscalationRequest>;
};

export type CreateEscalationLatchOptions = {
  readonly target: RosterCandidate;
  /** `strategy.max_escalations` (default 1). */
  readonly maxEscalations?: number;
};

export function createEscalationLatch(opts: CreateEscalationLatchOptions): EscalationLatch {
  const max = Math.max(0, Math.floor(opts.maxEscalations ?? 1));
  const records: EscalationRequest[] = [];
  let pending: EscalationRequest | undefined;
  return {
    target: opts.target,
    maxEscalations: max,
    get count(): number {
      return records.length;
    },
    request(reason, turnNumber) {
      if (records.length >= max) return undefined;
      const rec: EscalationRequest = {
        receipt: records.length + 1,
        reason,
        target: opts.target,
        turnNumber,
        requestedAt: new Date().toISOString(),
      };
      records.push(rec);
      pending = rec;
      return rec;
    },
    pending() {
      return pending;
    },
    consume(snapshot) {
      const rec = pending;
      if (rec === undefined) return undefined;
      pending = undefined;
      rec.transcriptLength = snapshot.transcriptLength;
      rec.consumedAt = new Date().toISOString();
      return rec;
    },
    history() {
      return records;
    },
  };
}

export type CreateEscalateToolOptions = {
  readonly latch: EscalationLatch;
};

export function createEscalateTool(opts: CreateEscalateToolOptions): RegisteredTool {
  const { latch } = opts;
  const targetName =
    latch.target.profile !== undefined ? `$${latch.target.profile}` : latch.target.modelString;
  return buildTool({
    name: ESCALATE_TOOL_NAME,
    description: `Hand this turn to the stronger model (${targetName}) when it is beyond you — a multi-step reasoning chain, an ambiguous or high-stakes answer, a task you keep failing. Give a one-sentence \`reason\`. At most ${latch.maxEscalations} escalation${latch.maxEscalations === 1 ? "" : "s"} per run; the receipt tells you whether it was accepted.`,
    inputSchema: escalateInputSchema,
    // Side-effect-free beyond the in-memory latch: allowed in plan mode, auto-
    // allowed in auto mode, asks in default mode (never bookkeeping-allowed).
    readOnly: true,
    concurrencySafe: false,
    destructive: false,
    scope: "internal",
    execute: async (input, ctx) => {
      const runContext = runContextOf(ctx);
      const bus = runContext?.eventBus;
      const turnNumber = runContext?.turnNumber ?? 0;
      const stage = {
        stage: "escalate",
        strategy: MODEL_DIRECTED_STRATEGY,
        role: "escalation" as const,
        model: latch.target.modelId ?? latch.target.modelString,
        ...(latch.target.profile !== undefined ? { profile: latch.target.profile } : {}),
      };
      const rec = latch.request(input.reason, turnNumber);
      if (rec === undefined) {
        // §7.13 — `max_escalations` reached: not a failure. The last rung's
        // answer stands; the model is told to finish with what it has.
        publishStage(bus, { ...stage, outcome: "skipped", cause: "max_escalations" });
        return JSON.stringify({
          escalated: false,
          reason: "max_escalations",
          maxEscalations: latch.maxEscalations,
          message: `Escalation not accepted: the run's ${latch.maxEscalations} escalation${latch.maxEscalations === 1 ? " has" : "s have"} been used. Answer with what you have.`,
        });
      }
      publishStage(bus, { ...stage, outcome: "started", cause: "self" });
      return JSON.stringify({
        escalated: true,
        receipt: rec.receipt,
        to: latch.target.modelString,
        ...(latch.target.profile !== undefined ? { profile: latch.target.profile } : {}),
        reason: rec.reason,
        message: `Escalation accepted (receipt ${rec.receipt}/${latch.maxEscalations}): the rest of this turn is served by ${targetName}. Continue from where you left off.`,
      });
    },
  });
}
