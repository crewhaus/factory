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
 * Section 15 will plumb real token usage through; today we stamp a zero
 * placeholder so the result type is stable.
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import {
  type CreateIsolatedContextOptions,
  type IsolatedContext,
  type ParentRunHandle,
  type SpawnSubAgentOptions,
  type SubAgentFailure,
  type SubAgentMessage,
  type SubAgentResult,
  type ToolCallRecord,
  createIsolatedContext,
} from "@crewhaus/agent-context-isolation";
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import {
  type FailureReport,
  RunFailedError,
  isRunFailedError,
  toFailureReport,
} from "@crewhaus/errors";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import { buildFailureReport, classify } from "@crewhaus/recovery-engine";
import { tagContent } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";

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
  opts: SpawnSubAgentOptions,
): Promise<SubAgentResult> {
  const sessionRootDir = opts.sessionRootDir ?? parent.sessionRootDir;
  const isoOpts: CreateIsolatedContextOptions = {
    name: opts.def.name,
    instructions: opts.def.instructions,
    tools: opts.childTools,
    ...(opts.def.model !== undefined ? { model: opts.def.model } : {}),
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
  });

  const t0SubAgent = performance.now();
  let finalMessage = "";
  let isError = false;
  let errorMessage: string | undefined;
  let childFailure: SubAgentFailure | undefined;
  let escalation: RunFailedError | undefined;

  try {
    finalMessage = await runChatLoop({
      model: opts.def.model ?? parent.model,
      instructions: opts.def.instructions,
      runContext: child.runContext,
      sessionName: opts.def.name,
      sessionTarget: "subagent",
      singleTurn: true,
      seedMessages: [{ role: "user", content: opts.prompt }],
      tools: opts.childTools,
      permissionMode: opts.permissionMode,
      permissionRules: opts.permissionRules,
      installSigintHandler: false,
      maxTokens: parent.maxTokens,
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
      if (childFailure.report.class === "billing" || childFailure.report.class === "auth") {
        escalation =
          err instanceof RunFailedError ? err : new RunFailedError(childFailure.report, err);
      }
    }
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
  }

  return {
    finalMessage,
    transcript,
    toolCalls,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(childFailure !== undefined ? { failure: childFailure } : {}),
  };
}

export { spawnSubAgent as default };
