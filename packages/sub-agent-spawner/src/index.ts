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
import type Anthropic from "@anthropic-ai/sdk";
import {
  type CreateIsolatedContextOptions,
  type IsolatedContext,
  type ParentRunHandle,
  type SpawnSubAgentOptions,
  type SubAgentMessage,
  type SubAgentResult,
  type ToolCallRecord,
  createIsolatedContext,
} from "@crewhaus/agent-context-isolation";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import { runChatLoop } from "@crewhaus/runtime-core";

/**
 * Spawn one sub-agent run. Throws only if `runChatLoop` itself throws
 * non-abort (the abort case is reported as a `sub_agent_end` with
 * `isError: true` and the cancellation message in `finalMessage`).
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
      ...(opts._client !== undefined
        ? { client: opts._client as Anthropic, isOAuth: opts._isOAuth }
        : {}),
    });
  } catch (err) {
    isError = true;
    errorMessage = (err as Error).message ?? String(err);
    // Make the failure visible in the result rather than re-throwing — the
    // Task tool surfaces this as a `tool_result` so the parent model can
    // recover. Re-throwing would crash the parent's turn.
    finalMessage = `[sub-agent error] ${errorMessage}`;
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
    toolCallCount: toolCalls.length,
    finalMessageBytes: Buffer.byteLength(finalMessage, "utf8"),
    durationMs: performance.now() - t0SubAgent,
  });

  await child.close();

  return {
    finalMessage,
    transcript,
    toolCalls,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

export { spawnSubAgent as default };
