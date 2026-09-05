/**
 * Catalog R10 `sub-agent-spawner` — Section 13.
 *
 * `spawnSubAgent(parent, opts)` is the only export. It:
 *   1. mints a fresh `IsolatedContext` (own runId / sessionId / event log /
 *      state-store / abort tree) from `agent-context-isolation`,
 *   2. records `sub_agent_start` on the PARENT's event log so the child's
 *      lifecycle is visible from the parent's transcript,
 *   3. runs `runChatLoop({ singleTurn: true, runContext: child.runContext, … })`
 *      with the child's filtered tool catalog and resolved permissions,
 *   4. replays the child's event log to harvest the transcript + tool calls,
 *   5. records `sub_agent_end` on the parent log (success or failure), and
 *   6. returns a `SubAgentResult`.
 *
 * `runChatLoop` opens its own `EventLog` handle against the child's
 * sessionId; that's fine — `openEventLog` uses `appendFileSync` (atomic per
 * line on POSIX) so the spawner's pre-opened handle and the runtime's
 * handle write to the same file without locking. The spawner reads the
 * file back after `runChatLoop` returns.
 *
 * No cycle with `runtime-core`: the spawner depends on runtime-core
 * (consumer→provider). runtime-core does NOT depend on the spawner — the
 * codegen / interpreter inject `spawnSubAgent` into `runChatLoop`'s options
 * so the bridge can hand it to the Task tool.
 *
 * Loop contract 0.4 (Batch C, G57): the child's real token usage is now
 * aggregated from the `model_response` events on its own bus and rolled into
 * `SubAgentResult.usage` (replacing the Section-13 zero placeholder), so the
 * parent's Task tool can fold child spend into its run accounting.
 *
 * 0.6.0 §7.7 / §10.2 — sub-agent routing end to end:
 *   - the child's definition carries its own routing quartet and params, and
 *     the spawner spreads them into the child `runChatLoop` (a child routes
 *     itself exactly as an agent block would; it never inherits the parent's
 *     router — see `ParentRoutingProjection` for the inherit / never list);
 *   - `inheritRouting: true` runs the child on the arm the parent's router
 *     SERVED for the spawning turn (the bridge's `routing.served`), default
 *     off so `bridge.model` stays the declared primary;
 *   - a Task call's `profile` argument (validated by the Task tool against the
 *     definition's allowlist, re-checked here fail-closed) pins the child to
 *     one of its resolved `allowedProfiles` options for that call;
 *   - `budgetShare` gives the child its own `budget` — a sub-cap under the run
 *     cap, `stop` on breach (a non-fatal classified child failure);
 *   - the child's PRICED spend is re-published on the PARENT bus as ONE
 *     `cost_accrual{role: "subagent", summary: true}` roll-up before the
 *     spawn returns — today that spend was dropped between the child's bus
 *     and the parent's, so `budget`, `cost-summary` and Hangar never saw it;
 *   - `sub_agent_start` / `sub_agent_end` carry the child's `model` and
 *     `profile`.
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import {
  type CreateIsolatedContextOptions,
  type IsolatedContext,
  type ParentRunHandle,
  type SpawnSubAgentOptions,
  type SubAgentDefinition,
  type SubAgentFailure,
  type SubAgentMessage,
  type SubAgentResult,
  type ToolCallRecord,
  createIsolatedContext,
  subAgentProfileAllowlist,
} from "@crewhaus/agent-context-isolation";
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { createCostTracker } from "@crewhaus/cost-tracker";
import {
  type FailureReport,
  RunFailedError,
  isRunFailedError,
  toFailureReport,
} from "@crewhaus/errors";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import { type FederationRouter, classifyRouterError } from "@crewhaus/federation-router";
import { buildFailureReport, classify } from "@crewhaus/recovery-engine";
import { tagContent } from "@crewhaus/run-context";
import { type RunChatLoopOptions, runChatLoop } from "@crewhaus/runtime-core";
import type { CostAccrualEvent, ModelResponseEvent, ProviderId } from "@crewhaus/trace-event-bus";

/**
 * Item 2 (G31) — the federation extension to {@link SpawnSubAgentOptions}. A
 * sub-agent whose runtime `def` carries `federation.url` (mirroring
 * `IrSubAgentDefinition.federation`) is routed to a REMOTE peer through the
 * injected `@crewhaus/federation-router` instead of being spawned in-process.
 *
 * The router is DEPLOY-scoped — built once with this deployment's mTLS
 * credentials + peer discovery and injected by the runtime alongside
 * `spawnSubAgent` — while `def.federation.url` selects the peer per call. All
 * three fields are optional so existing (non-federated) callers pass plain
 * `SpawnSubAgentOptions` unchanged; the function stays assignable to
 * `SpawnSubAgentFn`.
 */
export type FederatedSpawnOptions = SpawnSubAgentOptions & {
  /** Deploy-scoped router. REQUIRED whenever the spawned `def` is federated. */
  readonly federationRouter?: FederationRouter;
  /** This deployment's id — `federation.from.deployment`. Defaults to "local". */
  readonly fromDeployment?: string;
  /** The caller's role — `federation.from.role`. Defaults to "agent". */
  readonly fromRole?: string;
};

/** Runtime `def` widened with the federated-peer reference (mirrors `IrSubAgentDefinition.federation`). */
type MaybeFederatedDef = SubAgentDefinition & { readonly federation?: { readonly url: string } };

/**
 * v0.3.0 §7.1 — classify a child terminal error at the spawner boundary.
 * A `RunFailedError` (the child loop's recovery already halted with a
 * report) passes its report through verbatim; everything else runs through
 * recovery-engine's `classify` + `buildFailureReport` for the terminal
 * classes and falls back to the generic `toFailureReport` shape otherwise.
 * `failureClass` keeps the finer classify verdict even when the report
 * falls back to the generic class — the parent model sees the honest bucket.
 */
function classifyChildFailure(err: unknown): SubAgentFailure {
  if (isRunFailedError(err)) {
    return { failureClass: err.report.class, report: err.report };
  }
  const klass = classify(err);
  const report: FailureReport =
    klass === "billing"
      ? buildFailureReport("billing_exhausted", err)
      : klass === "auth"
        ? buildFailureReport("auth_invalid", err)
        : klass === "rate_limit"
          ? buildFailureReport("rate_limited", err)
          : toFailureReport(err);
  return { failureClass: klass, report };
}

/**
 * 0.6.0 §7.7 — the model plan a child loop runs on, resolved from the
 * definition, the parent's routing projection and the Task call's `profile`.
 *
 *   - `declared`  — the default: `def.model` (else the parent's declared
 *                   primary), the child's own params and routing quartet;
 *   - `inherited` — `def.inheritRouting: true` and the bridge projected a
 *                   served arm: that arm's spec model is the child's primary
 *                   (its `profile` is stamped for attribution); the child's
 *                   own params and quartet still apply — a child with its own
 *                   `model_pool` routes itself, the inherited model is only its
 *                   nominal primary;
 *   - `pinned`    — the Task call named one of `def.allowedProfiles`: the child
 *                   runs single-model on that option (its params, overlay and
 *                   failover chain); the definition's `model_pool` /
 *                   `model_tiers` do not route this call.
 *
 * `profile` is re-checked against the allowlist here even though the Task
 * tool validated it first: a model-filled model argument fails closed at every
 * layer (§10.1). A `profile` that restates the child's own identity (its
 * profile name or model string) is accepted and yields the default plan.
 */
export type ChildLoopPlan = {
  readonly source: "declared" | "inherited" | "pinned";
  readonly model: string;
  readonly profile?: string;
  readonly instructions: string;
  readonly maxTokens: number;
  readonly loopOptions: Pick<
    RunChatLoopOptions,
    | "thinking"
    | "temperature"
    | "modelFallbacks"
    | "circuitBreaker"
    | "modelTiers"
    | "modelPool"
    | "budget"
  >;
};

export function resolveChildLoopPlan(
  parent: ParentRunHandle,
  def: SubAgentDefinition,
  profile: string | undefined,
): ChildLoopPlan {
  // §7.7 — `budget_share`: a sub-cap under the parent's run cap. Inert when the
  // parent declares no budget (nothing to take a share of).
  const parentCapMicros = parent.routing?.budgetUsdMicros;
  const budget: Pick<RunChatLoopOptions, "budget"> =
    def.budgetShare !== undefined && parentCapMicros !== undefined
      ? {
          budget: {
            usdMicros: Math.max(0, Math.round(parentCapMicros * def.budgetShare)),
            onExceed: { kind: "stop" },
          },
        }
      : {};
  if (profile !== undefined) {
    const allowed = subAgentProfileAllowlist(def, parent.model);
    if (!allowed.includes(profile)) {
      throw new Error(
        `sub-agent "${def.name}": profile "${profile}" is not allowed — allowed: ${allowed.join(", ")}`,
      );
    }
    const option = def.allowedProfiles?.find((o) => o.profile === profile);
    if (option !== undefined) {
      return {
        source: "pinned",
        model: option.model,
        profile: option.profile,
        instructions:
          option.overlay !== undefined
            ? `${option.overlay}\n\n${def.instructions}`
            : def.instructions,
        maxTokens: option.maxTokens ?? def.maxTokens ?? parent.maxTokens,
        loopOptions: {
          ...(option.thinking !== undefined ? { thinking: option.thinking } : {}),
          ...(option.temperature !== undefined ? { temperature: option.temperature } : {}),
          ...(option.modelFallbacks !== undefined ? { modelFallbacks: option.modelFallbacks } : {}),
          ...(option.circuitBreaker !== undefined ? { circuitBreaker: option.circuitBreaker } : {}),
          ...budget,
        },
      };
    }
    // The argument restated the child's own identity — the default plan.
  }
  const served = def.inheritRouting === true ? parent.routing?.served : undefined;
  const model = served?.model ?? def.model ?? parent.model;
  const label = served !== undefined ? served.profile : def.modelProfile;
  return {
    source: served !== undefined ? "inherited" : "declared",
    model,
    ...(label !== undefined ? { profile: label } : {}),
    instructions: def.instructions,
    maxTokens: def.maxTokens ?? parent.maxTokens,
    loopOptions: {
      ...(def.thinking !== undefined ? { thinking: def.thinking } : {}),
      ...(def.temperature !== undefined ? { temperature: def.temperature } : {}),
      ...(def.modelFallbacks !== undefined ? { modelFallbacks: def.modelFallbacks } : {}),
      ...(def.circuitBreaker !== undefined ? { circuitBreaker: def.circuitBreaker } : {}),
      ...(def.modelTiers !== undefined ? { modelTiers: def.modelTiers } : {}),
      ...(def.modelPool !== undefined ? { modelPool: def.modelPool } : {}),
      ...budget,
    },
  };
}

/**
 * Spawn one sub-agent run.
 *
 * Failure semantics (v0.3.0 §7.1):
 *   - The parent's abort cascading into the child is reported as a
 *     `sub_agent_end` with `isError: true` and the legacy cancellation
 *     message in `finalMessage` (nothing to classify — the parent is
 *     stopping anyway).
 *   - Any other child terminal error is CLASSIFIED (see
 *     `classifyChildFailure`). Non-fatal classes return a result whose
 *     `failure` carries `{failureClass, report}` and whose `finalMessage`
 *     is the structured JSON — the Task tool surfaces it as an honest
 *     `is_error` tool result and the parent run continues.
 *   - A billing/auth-class failure ESCALATES: after the `sub_agent_end`
 *     bookkeeping (bracket integrity for capture/proof walkers) the spawner
 *     rethrows `RunFailedError` so the parent's recovery halts the whole
 *     run with the child's report — "a billing failure anywhere ends the
 *     run with the billing message".
 */
export async function spawnSubAgent(
  parent: ParentRunHandle,
  opts: FederatedSpawnOptions,
): Promise<SubAgentResult> {
  // Item 2 (G31) — a sub-agent wired to a remote peer
  // (`sub_agents.<name>.federation.url`) is routed through the federation
  // router, NOT spawned locally. Branch before minting a local
  // IsolatedContext / child runChatLoop.
  const federation = (opts.def as MaybeFederatedDef).federation;
  if (federation !== undefined) {
    return spawnFederatedSubAgent(parent, opts, federation);
  }
  const sessionRootDir = opts.sessionRootDir ?? parent.sessionRootDir;
  // 0.6.0 §7.7 — resolve the child's model plan BEFORE minting anything: a
  // disallowed `profile` fails closed with nothing spawned and no bracket
  // opened (the Task tool already refused it; this is the second gate).
  const plan = resolveChildLoopPlan(parent, opts.def, opts.profile);
  const planAttribution = {
    model: plan.model,
    ...(plan.profile !== undefined ? { profile: plan.profile } : {}),
  };
  const isoOpts: CreateIsolatedContextOptions = {
    name: opts.def.name,
    instructions: plan.instructions,
    tools: opts.childTools,
    model: plan.model,
    ...(sessionRootDir !== undefined ? { sessionRootDir } : {}),
  };
  const child: IsolatedContext = await createIsolatedContext(parent, isoOpts);

  await parent.eventLog.append({
    kind: "sub_agent_start",
    payload: {
      name: opts.def.name,
      childSessionId: child.sessionId,
      childRunId: child.runContext.runId,
      prompt: opts.prompt,
      toolCount: opts.childTools.length,
      permissionMode: opts.permissionMode,
      ...planAttribution,
    },
  });

  // Section 15: also publish on the parent bus so OTel/metrics see the boundary.
  // Use the same spanId for start/end so the OTel exporter pairs them.
  const parentBus = parent.runContext.eventBus;
  const subAgentEnvelope = parentBus.envelope();
  parentBus.publish({
    ...subAgentEnvelope,
    kind: "sub_agent_start",
    name: opts.def.name,
    childRunId: child.runContext.runId,
    childSessionId: child.sessionId,
    toolCount: opts.childTools.length,
    promptBytes: Buffer.byteLength(opts.prompt, "utf8"),
    ...planAttribution,
  });

  // Loop contract 0.4 (Batch C, G57) — aggregate the child's real token usage
  // instead of stamping the Section-13 zero placeholder. The child loop
  // publishes one `model_response` per model call on its OWN bus
  // (`child.runContext.eventBus`); we sum their `usage` here and roll the
  // total into `SubAgentResult.usage`, which the parent's Task tool folds into
  // its run accounting. Subscribing to the child bus (rather than re-reading
  // the event log) keeps this independent of the opt-in cost/advisor mirrors —
  // token usage is never persisted to the child's JSONL by default.
  let childInputTokens = 0;
  let childOutputTokens = 0;
  let childCacheReadTokens = 0;
  let childCacheCreationTokens = 0;
  let childCalls = 0;
  let childLastProvider: ProviderId | undefined;
  let childLastWireModel: string | undefined;
  const usageUnsubscribe = child.runContext.eventBus.subscribe((ev) => {
    if (ev.kind === "model_response") {
      const resp = ev as ModelResponseEvent;
      childInputTokens += resp.usage.input;
      childOutputTokens += resp.usage.output;
      childCacheReadTokens += resp.usage.cacheRead ?? 0;
      childCacheCreationTokens += resp.usage.cacheCreate ?? 0;
      childCalls += 1;
      childLastProvider = resp.provider ?? "anthropic";
      childLastWireModel = resp.model;
    }
  });
  // 0.6.0 §7.7 / §10.2 — PRICE the child's calls on its own bus (events
  // suppressed: the child loop's own observability publishes its per-call
  // accruals on the child bus already) so ONE roll-up can be re-published on
  // the parent bus below. Priced with the same default table the parent's
  // budget meter uses.
  const childCostTracker = createCostTracker(child.runContext.eventBus, { suppressEvents: true });

  const t0SubAgent = performance.now();
  let finalMessage = "";
  let isError = false;
  let errorMessage: string | undefined;
  let childFailure: SubAgentFailure | undefined;
  let escalation: RunFailedError | undefined;

  try {
    finalMessage = await runChatLoop({
      // 0.6.0 §7.7 — the resolved plan: declared primary / the parent's served
      // arm (`inheritRouting`) / a pinned allowed profile, with the child's own
      // params, routing quartet and `budget_share` sub-cap spread below.
      model: plan.model,
      instructions: plan.instructions,
      runContext: child.runContext,
      sessionName: opts.def.name,
      sessionTarget: "subagent",
      singleTurn: true,
      seedMessages: [{ role: "user", content: opts.prompt }],
      tools: opts.childTools,
      permissionMode: opts.permissionMode,
      permissionRules: opts.permissionRules,
      // #383 — NEVER re-load the harness settings file in a child loop: the
      // child's RuleSet was narrowed by resolveChildPermissions from the
      // parent's already-merged rules, and a re-merged standing allow in the
      // `settings` layer would outrank a replace-mode child's `yaml` deny.
      settingsDir: null,
      installSigintHandler: false,
      maxTokens: plan.maxTokens,
      // 0.6.0 (design §8.1) — every model event the child publishes on its own
      // bus is attributed `role: "subagent"`, like the roll-up on the parent's.
      modelRole: "subagent",
      ...plan.loopOptions,
      ...(sessionRootDir !== undefined ? { sessionRootDir } : {}),
      // v0.3.0 §7.1 — thread the parent's seams into the child loop:
      //   - memory: recall ON (the parent's recall closure, so recalled
      //     context reaches the child's system prompt through the same
      //     injected seam; autoRecall respects the parent's setting),
      //     capture OFF by construction (`SubAgentMemorySeam` cannot carry
      //     the write closures — parents own memory writes).
      //   - skills: the child loop renders the skills prompt block (the
      //     Skill tool itself already inherits via the catalog).
      //   - failureTaxonomy: the child's recovery consults the same named
      //     classes as the parent.
      //   - continuity: READ-ONLY — `loadPlan` renders the plan tail;
      //     `ledger: false` plus the absent onPlanDirty/onHandoff closures
      //     mean a child never writes the parent's plan-store state
      //     through the seam.
      ...(parent.memory !== undefined ? { memory: parent.memory } : {}),
      ...(parent.skills !== undefined && parent.skills.length > 0 ? { skills: parent.skills } : {}),
      ...(parent.failureTaxonomy !== undefined ? { failureTaxonomy: parent.failureTaxonomy } : {}),
      ...(parent.continuity !== undefined
        ? { continuity: { loadPlan: parent.continuity.loadPlan, ledger: false } }
        : {}),
      //   - approvals: Loop contract 0.4 (G11) parking. The child inherits the
      //     parent's ask_mode and the SAME store. Nothing is narrowed here,
      //     unlike memory/continuity — a park is a run-level pause, and the
      //     store is keyed on (toolName, inputHash) across sessions, so the
      //     grant issued for a child's call is found when it is re-issued.
      //     Without these a child loop is non-interactive with nothing to park
      //     against, so its every `ask` collapsed to a deny no matter what the
      //     parent's spec asked for.
      ...(parent.askMode !== undefined ? { askMode: parent.askMode } : {}),
      ...(parent.approvals !== undefined ? { approvals: parent.approvals } : {}),
      ...(opts._client !== undefined ? { _adapter: opts._client as ProviderAdapter } : {}),
    });
  } catch (err) {
    isError = true;
    errorMessage = (err as Error).message ?? String(err);
    if (!isRunFailedError(err) && classify(err) === "user_aborted") {
      // The parent's abort cascaded into the child — nothing to classify;
      // keep the legacy cancellation shape (the parent is stopping anyway).
      finalMessage = `[sub-agent error] ${errorMessage}`;
    } else {
      // v0.3.0 §7.1 — classify instead of swallowing into a string. The
      // structured content is what the Task tool surfaces (is_error: true)
      // for the non-fatal classes; billing/auth escalate below AFTER the
      // sub_agent_end bookkeeping so the parent transcript keeps a closed
      // bracket for capture/proof walkers.
      childFailure = classifyChildFailure(err);
      finalMessage = JSON.stringify({
        isError: true,
        failureClass: childFailure.failureClass,
        report: childFailure.report,
      });
      // `approval_pending` escalates alongside billing/auth, for a DIFFERENT
      // reason: those are fatal, a park is RESUMABLE and the parent is the
      // only thing that can be resumed. Swallowing it into an `is_error` tool
      // result loses the one signal every consumer keys on — exit code 36 and
      // `report.class` (`crewhaus failures` explicitly classifies it as a
      // non-failure, `fleet` renders it as "needs approval", the channel bot
      // posts its approve/deny prompt) — and leaves the model free to retry
      // the Task, re-firing `approvals.notify` and prompting the operator
      // again for a decision already pending.
      if (
        childFailure.report.class === "billing" ||
        childFailure.report.class === "auth" ||
        childFailure.report.class === "approval_pending"
      ) {
        escalation =
          err instanceof RunFailedError ? err : new RunFailedError(childFailure.report, err);
      }
    }
  }

  // The child loop has returned (or thrown) — every `model_response` it was
  // going to emit has been observed, so stop listening.
  usageUnsubscribe();
  const childSpend = childCostTracker.getRunCost(child.runContext.runId);
  const childPricingMisses = childCostTracker.pricingMisses();
  childCostTracker.unsubscribe();

  // 0.6.0 §7.6 / §10.2 — re-publish the child's spend on the PARENT bus as ONE
  // summary accrual, so the parent's `budgetMeter` (keyed on the parent
  // `bus.runId`) counts it, `cost-summary` totals it and Hangar / OTel see it
  // under `role: "subagent"`. `summary: true` marks it a roll-up (never a
  // per-call line); cost-tracker folds a role-bearing summary from another bus
  // and still ignores the optimizer's role-less run total. Published BEFORE
  // `sub_agent_end` so the accrual sits inside the child's bracket, and only
  // when the child made a model call at all. `modelId` is the wire model that
  // served the child's LAST call (a child pool may have served several — the
  // child's own session log has the per-call lines).
  if (childCalls > 0 && childLastProvider !== undefined && childLastWireModel !== undefined) {
    const unpriced =
      childSpend.totalUsdMicros === 0 &&
      childPricingMisses > 0 &&
      childInputTokens + childOutputTokens > 0;
    const accrual: CostAccrualEvent = {
      ...parentBus.envelope(),
      spanId: subAgentEnvelope.spanId,
      kind: "cost_accrual",
      role: "subagent",
      summary: true,
      provider: childLastProvider,
      modelId: childLastWireModel,
      ...(plan.model !== childLastWireModel ? { specModel: plan.model } : {}),
      ...(plan.profile !== undefined ? { profile: plan.profile } : {}),
      inputTokens: childInputTokens,
      outputTokens: childOutputTokens,
      cachedReadTokens: childCacheReadTokens,
      cacheCreationTokens: childCacheCreationTokens,
      costUsdMicros: childSpend.totalUsdMicros,
      ...(unpriced ? { unpriced: true } : {}),
    };
    parentBus.publish(accrual);
  }

  // Read the child's event log back to assemble transcript + tool calls.
  // Use a fresh handle (the runtime closed its handle in its `finally`).
  const reopened: EventLog = await openEventLog(
    child.sessionId,
    sessionRootDir !== undefined ? { rootDir: sessionRootDir } : {},
  );
  const transcript: SubAgentMessage[] = [];
  const toolCalls: ToolCallRecord[] = [];
  for await (const ev of reopened.read()) {
    if (ev.kind === "user_message" || ev.kind === "assistant_message") {
      const p = ev.payload as { content: unknown };
      transcript.push({
        role: ev.kind === "user_message" ? "user" : "assistant",
        content: p.content,
      });
    } else if (ev.kind === "tool_use") {
      const p = ev.payload as { id: string; name: string; input: unknown };
      toolCalls.push({ id: p.id, name: p.name, input: p.input });
    }
  }
  await reopened.close();

  await parent.eventLog.append({
    kind: "sub_agent_end",
    payload: {
      name: opts.def.name,
      childSessionId: child.sessionId,
      isError,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(childFailure !== undefined ? { failureClass: childFailure.failureClass } : {}),
      finalMessageLength: finalMessage.length,
      toolCallCount: toolCalls.length,
      ...planAttribution,
    },
  });

  parentBus.publish({
    ...parentBus.envelope(),
    spanId: subAgentEnvelope.spanId,
    kind: "sub_agent_end",
    name: opts.def.name,
    childRunId: child.runContext.runId,
    childSessionId: child.sessionId,
    isError,
    ...(childFailure !== undefined ? { failureClass: childFailure.failureClass } : {}),
    toolCallCount: toolCalls.length,
    finalMessageBytes: Buffer.byteLength(finalMessage, "utf8"),
    durationMs: performance.now() - t0SubAgent,
    ...planAttribution,
  });

  await child.close();

  // v0.3.0 §7.1 escalation — a billing/auth-class child failure ends the
  // WHOLE run: rethrow the child's classified report now that the bracket
  // bookkeeping is complete (sub_agent_end appended, bus notified, child
  // closed). tool-executor and the streaming executor deliberately let a
  // RunFailedError pass, and the parent loop's recovery halts with this
  // exact report.
  if (escalation !== undefined) throw escalation;

  // Pillar 3 boundary site — re-classify the child's final message
  // before handing it back to the parent's context. The child ran
  // runChatLoop with its OWN classification on each tool result, but
  // those classifiers only saw the truncated previews of tool outputs.
  // A polymorphic jailbreak that the child's model absorbed and surfaced
  // in its summary would otherwise reach the parent's context window
  // intact — see [recipe 41](https://github.com/crewhaus/demos/blob/main/walkthroughs/41-security-fabric.md).
  // We replace `finalMessage` with the redaction notice on a malicious
  // verdict; suspicious is kept (the warn-action emits a trace event
  // through the classifier; nothing else to do here).
  if (!isError && finalMessage.length > 0) {
    const boundary = await classifyBoundary(finalMessage, { origin: "subagent" });
    if (boundary.action === "redact" && boundary.redacted !== undefined) {
      finalMessage = boundary.redacted;
    } else {
      // Pillar 3 sink-side fabric — content the parent will see needs to
      // be retrievable by the egress classifier on subsequent external-
      // tool calls. tagContent stores the content under origin "subagent"
      // so a later fetch/web/mcp call that smuggles this text triggers a
      // warn/block depending on the sink scope.
      tagContent(parent.runContext, finalMessage, "subagent");
    }
  } else if (childFailure !== undefined) {
    // The classified-failure branch is a boundary too — see admitChildFailure.
    ({ failure: childFailure, finalMessage } = await admitChildFailure(
      parent,
      childFailure,
      "subagent",
    ));
  }

  return {
    finalMessage,
    transcript,
    toolCalls,
    usage: { input_tokens: childInputTokens, output_tokens: childOutputTokens },
    ...(childFailure !== undefined ? { failure: childFailure } : {}),
  };
}

/**
 * Item 2 (G31) — route a federated sub-agent call to a REMOTE peer.
 *
 * Unlike a local spawn there is NO child IsolatedContext / runChatLoop: the
 * peer owns its own run. We still bracket the call with `sub_agent_start` /
 * `sub_agent_end` on the parent's log + bus (so capture/proof walkers and
 * observability see a closed boundary), route the prompt through the injected
 * router, and map the peer's `{ reply }` onto a `SubAgentResult`. The router
 * has ALREADY boundary-classified the peer reply at origin "federation"
 * (redacting a malicious verdict); we tag the safe reply into the PARENT's
 * lineage here — the deploy-scoped router can't hold this per-spawn RunContext.
 *
 * Follow-up (noted in the batch return): the remote peer's token spend isn't
 * locally metered (usage stays zero) and the remote transcript isn't visible
 * across the federation boundary (transcript/toolCalls stay empty) — both
 * await the deeper A2A task lifecycle (a pollable Task carrying usage +
 * history).
 */
async function spawnFederatedSubAgent(
  parent: ParentRunHandle,
  opts: FederatedSpawnOptions,
  federation: { readonly url: string },
): Promise<SubAgentResult> {
  const childRunId = `fedrun_${fedId()}`;
  const childSessionId = `fedsess_${fedId()}`;

  await parent.eventLog.append({
    kind: "sub_agent_start",
    payload: {
      name: opts.def.name,
      childSessionId,
      childRunId,
      prompt: opts.prompt,
      toolCount: 0,
      permissionMode: opts.permissionMode,
      // Federation marker — the payload type is `unknown`, so this rides
      // alongside the local-spawn fields and flags the boundary as remote.
      federation: federation.url,
    },
  });

  const parentBus = parent.runContext.eventBus;
  const subAgentEnvelope = parentBus.envelope();
  parentBus.publish({
    ...subAgentEnvelope,
    kind: "sub_agent_start",
    name: opts.def.name,
    childRunId,
    childSessionId,
    toolCount: 0,
    promptBytes: Buffer.byteLength(opts.prompt, "utf8"),
  });

  const t0 = performance.now();
  let finalMessage = "";
  let isError = false;
  let errorMessage: string | undefined;
  let childFailure: SubAgentFailure | undefined;

  const router = opts.federationRouter;
  if (router === undefined) {
    // A declared federated sub-agent with no injected router is a deploy
    // misconfiguration. Fail it as a non-fatal classified error (the parent
    // model sees an honest is_error and continues) rather than silently
    // spawning the WRONG (local) agent.
    isError = true;
    const report = toFailureReport(
      new Error(
        `sub-agent "${opts.def.name}" declares federation.url ${federation.url} but no federation router was injected — the runtime must supply \`federationRouter\` in the spawn options`,
      ),
    );
    childFailure = { failureClass: "config", report };
    errorMessage = report.detail;
    finalMessage = JSON.stringify({ isError: true, failureClass: "config", report });
  } else {
    try {
      const { reply } = await router.call({
        fromRole: opts.fromRole ?? "agent",
        // `federation.url` is the peer's base URL; its hostname is the
        // discovery `deployment` id (endpoint + cert-pin fingerprint come from
        // the peer's `/.well-known/crewhaus.json`). The remote role addressed
        // is the local sub-agent name.
        to: { deployment: deploymentFromUrl(federation.url), role: opts.def.name },
        payload: opts.prompt,
        kind: "question",
      });
      finalMessage = reply;
    } catch (err) {
      isError = true;
      errorMessage = (err as Error).message ?? String(err);
      // Map the router/protocol error onto the recovery taxonomy for the
      // parent-visible failureClass. Federation failures do NOT escalate the
      // whole run (unlike a local child's billing/auth): a single unreachable
      // or mis-pinned peer is a delegation the parent can route around.
      const hint = classifyRouterError(err as Error);
      const failureClass =
        hint.kind === "retry" ? "network" : hint.kind === "tombstone" ? "auth" : "unknown";
      const report = toFailureReport(err);
      childFailure = { failureClass, report };
      finalMessage = JSON.stringify({ isError: true, failureClass, report });
    }
  }

  await parent.eventLog.append({
    kind: "sub_agent_end",
    payload: {
      name: opts.def.name,
      childSessionId,
      isError,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(childFailure !== undefined ? { failureClass: childFailure.failureClass } : {}),
      finalMessageLength: finalMessage.length,
      toolCallCount: 0,
      federation: federation.url,
    },
  });

  parentBus.publish({
    ...parentBus.envelope(),
    spanId: subAgentEnvelope.spanId,
    kind: "sub_agent_end",
    name: opts.def.name,
    childRunId,
    childSessionId,
    isError,
    ...(childFailure !== undefined ? { failureClass: childFailure.failureClass } : {}),
    toolCallCount: 0,
    finalMessageBytes: Buffer.byteLength(finalMessage, "utf8"),
    durationMs: performance.now() - t0,
  });

  // Pillar 3 sink-side — the router already redacted a malicious peer reply at
  // origin "federation"; tag the (safe) reply into the parent's data-lineage so
  // a later external-scope tool call that smuggles it triggers the egress
  // classifier. A failure's `report.detail` (the router's / peer's error text)
  // goes through the same failure boundary as a local child's — see
  // admitChildFailure.
  if (!isError && finalMessage.length > 0) {
    tagContent(parent.runContext, finalMessage, "federation");
  } else if (childFailure !== undefined) {
    ({ failure: childFailure, finalMessage } = await admitChildFailure(
      parent,
      childFailure,
      "federation",
    ));
  }

  return {
    finalMessage,
    transcript: [],
    toolCalls: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(childFailure !== undefined ? { failure: childFailure } : {}),
  };
}

/**
 * Pillar 3 boundary site for the FAILURE branch of a spawn. `report.detail`
 * is the child's raw error text — an MCP server's error string, a provider's
 * message, a peer's protocol error, whatever the child's last step surfaced —
 * so it is just as attacker-controllable as a final message, and the Task
 * tool re-throws it verbatim (`SubAgentFailedError`) as the
 * `{isError, failureClass, report}` content the parent model reads. Task sets
 * `classifyOutput: false` (AGENTS.md rule 6: the spawner boundary is THE
 * classification site), so the runtime's own post-tool pass at origin "tool"
 * — which used to scrub AND lineage-tag error results as well — no longer
 * runs for it; without this pass the failure path would reach the parent
 * unclassified and untagged.
 *
 * Classifies the detail at the spawn's origin; on a malicious verdict the
 * redaction notice replaces the detail in the report (and the re-serialised
 * JSON) the parent sees; either way the content the parent WILL see — the
 * structured JSON, which the Task tool re-serialises with the same key order,
 * so the egress classifier's substring scan finds it and its detail line
 * verbatim — is tagged for the sink-side fabric. The `sub_agent_end` record
 * written before this keeps the raw detail: it is the operator's log, not
 * model context.
 */
async function admitChildFailure(
  parent: ParentRunHandle,
  failure: SubAgentFailure,
  origin: "subagent" | "federation",
): Promise<{ failure: SubAgentFailure; finalMessage: string }> {
  let admitted = failure;
  const detail = failure.report.detail;
  if (detail.length > 0) {
    const boundary = await classifyBoundary(detail, { origin });
    if (boundary.action === "redact" && boundary.redacted !== undefined) {
      admitted = {
        failureClass: failure.failureClass,
        report: { ...failure.report, detail: boundary.redacted },
      };
    }
  }
  const finalMessage = JSON.stringify({
    isError: true,
    failureClass: admitted.failureClass,
    report: admitted.report,
  });
  tagContent(parent.runContext, finalMessage, origin);
  return { failure: admitted, finalMessage };
}

/** Discovery `deployment` id for a peer base URL — the hostname (no port; the
 *  discovery id charset forbids `:`, and the port rides in the well-known
 *  `endpoint`). Falls back to the raw string when it isn't a parseable URL. */
function deploymentFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

let __fedSeq = 0;
/** Short unique-ish id for a federated boundary's synthetic run/session ids. */
function fedId(): string {
  __fedSeq = (__fedSeq + 1) & 0xffff;
  return `${Date.now().toString(36)}${__fedSeq.toString(36).padStart(3, "0")}`;
}

export { spawnSubAgent as default };
