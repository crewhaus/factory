import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
/**
 * 0.6.0 §6.2 — the IN-LOOP judge seam: one call shape shared by every judge
 * site that is not the eval runner.
 *
 * Before this module the six in-loop judge sites — the three
 * `renderEvaluation` copies (cli / channel-bot / managed), the two
 * `JUDGE_GATE_HELPER`s (workflow / graph) and the `crewhaus run`
 * interpreter — each made a single-model `judge()` call. A spec could
 * declare `evaluation.grader.judges` / `repeats` / `temperature` / `target`
 * (or the same four on a `kind: judge` gate), the compiler lowered them into
 * `IrEvaluation` / `IrJudge`, and nothing read them: a declared panel was
 * inert. {@link gradeWithJudgePanel} closes that by routing every one of
 * those sites through `createJudgeGrader`, which is the same fan-out the
 * eval runner has always used — median over panelists, strict-majority pass,
 * per-panelist repeats folded by median.
 *
 * It exists as ONE function rather than six emitted copies for the reason
 * the emitters keep restating about their mirrored blocks: five hand-written
 * copies of a fold this subtle drift. The emitters render the rubric literal
 * (whose anchors are part of each site's prompt contract) and the panel
 * knobs; the fold, the metering and the verdict shape live here.
 */
import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult, RunResult } from "@crewhaus/eval-grader";
import type { Event as TranscriptEvent } from "@crewhaus/event-log";
import type { ModelRole, TraceEventBus } from "@crewhaus/trace-event-bus";
import { type JudgeCallUsage, type JudgeRequestParams, createJudgeGrader } from "./judge";
import type { JudgeTarget } from "./prompt-template";
import type { AnyRubric } from "./rubric";

/**
 * The §6.2 panel knobs an in-loop judge site carries, lowered 1:1 from
 * `evaluation.grader` / a `kind: judge` gate. Every field absent ⇒ one
 * single-model judge call, exactly as before this seam existed.
 */
export type JudgePanelKnobs = {
  /** The single judge model (ignored when `judges` names a panel). */
  readonly model?: string;
  /** A PANEL of judge models — one verdict per member, folded by median. */
  readonly judges?: readonly string[];
  /** Odd repeat count per judge, folded by median. */
  readonly repeats?: number;
  /** Pinned judge sampling temperature (default 0). */
  readonly temperature?: number;
  /** What the judge reads: the final output (default) or the run trajectory. */
  readonly target?: JudgeTarget;
  /** 0.6.0 §4.2 — the judge profile's pinned request params. */
  readonly params?: JudgeRequestParams;
  /** Test seam: a pre-built adapter that bypasses the model-router. */
  readonly adapter?: ProviderAdapter;
};

/**
 * One in-loop verdict, already folded across the panel and its repeats.
 *
 * `judgeModel` is the INSTRUMENT identity stamped on `eval_graded` /
 * `judge_verdict`: the single judge's wire model, or — for a panel — every
 * panelist's wire model joined with `+` in declaration order, because two
 * different panels are two different instruments and a per-arm quality
 * lineage must not average them.
 *
 * `costUsdMicros` is the SUM over every call the verdict took (panelists ×
 * repeats) and is ABSENT unless every one of those calls was priced — an
 * unpriced member makes the total unknown, never cheaper.
 */
export type InLoopJudgeVerdict = {
  /** 0..1 (the `(n − 1) / 4` projection of the folded 1–5 score). */
  readonly score: number;
  /** `score >= rubric.passing_score`, folded by strict majority on a panel. */
  readonly passed: boolean;
  readonly rationale: string;
  /** A3 — a strict majority of judges declined to score; `score` is 0. */
  readonly abstained: boolean;
  readonly judgeModel: string;
  readonly costUsdMicros?: number;
  /** How many judge model calls produced this verdict (panelists × repeats). */
  readonly calls: number;
  /** A2 — per-panelist outcomes + vote entropy, present only for a panel. */
  readonly panel?: GradeResult["panel"];
};

/**
 * Grade one in-loop attempt through `createJudgeGrader`, honouring the
 * declared panel / repeats / temperature / target / params.
 *
 * Every call the fan-out makes publishes `model_request` / `model_response`
 * on `bus` with `role: "judge"` (each panelist and each repeat reporting its
 * OWN model string), so `cost-tracker` prices them and the runtime's budget
 * meter counts them toward `budget.usd` under `budget.judge_share` — the
 * panel is inside the sub-cap, not beside it.
 */
export async function gradeWithJudgePanel(
  opts: JudgePanelKnobs & {
    readonly rubric: AnyRubric;
    readonly sample: Sample;
    readonly run: RunResult;
    readonly bus?: TraceEventBus;
    readonly role?: ModelRole;
    readonly stage?: string;
  },
): Promise<InLoopJudgeVerdict> {
  const calls: JudgeCallUsage[] = [];
  const grader = createJudgeGrader(opts.rubric, {
    ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.judges !== undefined ? { judges: opts.judges } : {}),
    ...(opts.repeats !== undefined ? { repeats: opts.repeats } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.params !== undefined ? { params: opts.params } : {}),
    ...(opts.bus !== undefined ? { bus: opts.bus } : {}),
    ...(opts.role !== undefined ? { role: opts.role } : {}),
    ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
    onCall: (usage) => {
      calls.push(usage);
    },
  });
  const grade = await grader(opts.sample, opts.run);
  const costUsdMicros = totalCostUsdMicros(calls);
  return {
    score: grade.score,
    passed: grade.passed,
    rationale: grade.rationale,
    abstained: grade.abstained === true,
    judgeModel: judgeModelIdentity(calls, opts),
    ...(costUsdMicros !== undefined ? { costUsdMicros } : {}),
    calls: calls.length,
    ...(grade.panel !== undefined ? { panel: grade.panel } : {}),
  };
}

/**
 * The instrument identity for a verdict: for a PANEL, its declared members
 * joined with `+` — the DECLARATION is authoritative, not the calls. The
 * fan-out runs `Promise.all`, so `onCall` fires in completion order (a race),
 * and de-duplicating it would collapse a panel that deliberately names one
 * model twice. Declaration order is also exactly what the emitters stamp on
 * `RunEvaluation.judgeModel` (`judgeInstrumentId` in `@crewhaus/model-service`
 * joins `panel.judges` the same way), and the §6.3 quality fingerprint is
 * keyed on it — a run-to-run permutation would re-baseline the lineage.
 *
 * For a SINGLE judge the wire model the call actually reported wins (it is
 * the router's resolution of the declared string), falling back to the
 * declared `model` when nothing reported (a stub adapter in a test).
 */
function judgeModelIdentity(calls: ReadonlyArray<JudgeCallUsage>, knobs: JudgePanelKnobs): string {
  if (knobs.judges !== undefined && knobs.judges.length > 0) return knobs.judges.join("+");
  const seen: string[] = [];
  for (const c of calls) if (!seen.includes(c.model)) seen.push(c.model);
  if (seen.length > 0) return seen.join("+");
  return knobs.model ?? "";
}

/** Sum of every call's priced spend, or `undefined` when any call was unpriced. */
function totalCostUsdMicros(calls: ReadonlyArray<JudgeCallUsage>): number | undefined {
  if (calls.length === 0) return undefined;
  let total = 0;
  for (const c of calls) {
    if (c.costUsdMicros === undefined) return undefined;
    total += c.costUsdMicros;
  }
  return total;
}

/**
 * Build the `RunResult` an in-loop judge grades. The in-loop seam has no
 * eval sample directory and no captured trace: what it has is the turn's
 * final text and the conversation as of turn completion. `target: "output"`
 * reads only `agentOutput`; `target: "transcript"` reads `transcript`, so
 * the messages are projected into the `@crewhaus/event-log` event shape
 * `renderTranscriptDigest` consumes (`user_message` / `assistant_message` /
 * `tool_use` / `tool_result`) — without it a trajectory judge would grade
 * the digest's "(no transcript recorded)" fallback and never see the run.
 *
 * `messages` is typed structurally (role + content) so this module does not
 * pull in the Anthropic SDK types; the runtime's `Anthropic.MessageParam[]`
 * satisfies it.
 *
 * `isSynthetic` carries the runtime's SYNTHETIC marker across this seam.
 * runtime-core marks its injected `role: "user"` messages (retry nudges,
 * cascade corrections, continue/tombstone prompts, the toolset marker) in a
 * module-private WeakSet, so nothing on the message object itself says so and
 * this package — which must not depend on runtime-core — cannot tell them
 * from human turns. Left unset, a `target: "transcript"` judge on attempt 2+
 * would read its OWN previous rationale presented as a user instruction; with
 * it, the projected payload carries `synthetic: true` and
 * `renderTranscriptDigest` skips those messages exactly as it does for real
 * event-log lines.
 */
export function inLoopRunResult<
  M extends { readonly role: string; readonly content: unknown } = {
    readonly role: string;
    readonly content: unknown;
  },
>(input: {
  readonly finalText: string;
  readonly messages?: ReadonlyArray<M>;
  readonly isSynthetic?: (message: M) => boolean;
}): RunResult {
  return {
    agentOutput: input.finalText,
    events: [],
    transcript: transcriptFromMessages(input.messages ?? [], input.isSynthetic),
    toolCalls: [],
    turns: 0,
    latencyMs: 0,
  };
}

/** Project conversation messages into event-log events, in block order. */
function transcriptFromMessages<M extends { readonly role: string; readonly content: unknown }>(
  messages: ReadonlyArray<M>,
  isSynthetic?: (message: M) => boolean,
): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  const push = (kind: TranscriptEvent["kind"], payload: unknown): void => {
    out.push({ ts: 0, version: 1, kind, payload });
  };
  for (const message of messages) {
    const messageKind = message.role === "user" ? "user_message" : "assistant_message";
    // The digest's own skip rule keys on this payload flag (transcript-digest
    // `messageText`), the same one the event log writes.
    const synthetic = isSynthetic?.(message) === true ? { synthetic: true } : {};
    if (typeof message.content === "string") {
      push(messageKind, { content: message.content, ...synthetic });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    // Text blocks accumulate and flush as ONE message event (the digest's
    // `messageText` joins them); a tool block flushes what came before it so
    // the projected trajectory keeps the message's own block order.
    let texts: unknown[] = [];
    const flush = (): void => {
      if (texts.length === 0) return;
      push(messageKind, { content: texts, ...synthetic });
      texts = [];
    };
    for (const raw of message.content) {
      if (typeof raw !== "object" || raw === null) continue;
      const block = raw as Record<string, unknown>;
      if (block["type"] === "text") {
        texts.push(block);
      } else if (block["type"] === "tool_use") {
        flush();
        push("tool_use", { name: block["name"], input: block["input"] });
      } else if (block["type"] === "tool_result") {
        flush();
        // `isError` — the `@crewhaus/event-log` key `renderTranscriptDigest`
        // reads (the runtime writes it as `isError: result.is_error === true`).
        // Projecting the Anthropic block's own `is_error` would leave every
        // failed tool result rendered as a successful one.
        push("tool_result", { content: block["content"], isError: block["is_error"] === true });
      }
    }
    flush();
  }
  return out;
}
