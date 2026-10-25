/**
 * What a proof tool reads off the call's `ToolExecuteContext`: the run's
 * session, its trace bus, its event log and where its session logs live.
 *
 * The runtime threads its `RunContext` through `ctx.runContext` where it can
 * and always through the opaque bridge (`ctx.bridge.runContext`, the field
 * tool-code-execution's `resolveEventBus` and tool-plan's `identityOf` read).
 * The bridge also carries the run's `eventLog`, its `sessionRootDir` and
 * whether a sandbox backend is wired (`RuntimeBridge`,
 * packages/agent-context-isolation). All of it is read STRUCTURALLY, so this
 * package imports no runtime wiring, and every field is optional: a bare
 * unit call (a test, a CLI verb) has none of it, and the tools then work
 * against the defaults rather than failing.
 */
import type { ToolExecuteContext } from "@crewhaus/tool-catalog";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

/** The session-id shape every session store and log enforces. */
const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;
/** provability's spec-name rule (`proofsRoot` refuses anything else). */
const SPEC_NAME_REGEX = /^[a-zA-Z0-9_\-.]+$/;

/** The slice of a `RunContext` the tools read. */
export type RunContextLike = {
  readonly sessionId?: unknown;
  readonly turnNumber?: unknown;
  readonly eventBus?: TraceEventBus;
  readonly logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
  /** Not on today's `RunContext`; read when a runtime carries it (design §7). */
  readonly specName?: unknown;
};

/** The slice of an event log the tools append to. */
export type EventLogLike = {
  append(event: { readonly kind: "proof_checked"; readonly payload: unknown }): Promise<void>;
};

/** The slice of `RuntimeBridge` the tools read. */
export type BridgeLike = {
  readonly runContext?: RunContextLike;
  readonly eventLog?: EventLogLike;
  readonly sessionRootDir?: unknown;
  readonly sandboxAvailable?: unknown;
};

function bridgeOf(ctx: ToolExecuteContext | undefined): BridgeLike | undefined {
  const bridge = ctx?.bridge;
  return typeof bridge === "object" && bridge !== null ? (bridge as BridgeLike) : undefined;
}

/** The run's context: `ctx.runContext` first, the bridge's otherwise. */
export function runContextOf(ctx: ToolExecuteContext | undefined): RunContextLike | undefined {
  return (ctx?.runContext as RunContextLike | undefined) ?? bridgeOf(ctx)?.runContext;
}

/** The run's session id, when it has a well-formed one. */
export function sessionIdOf(ctx: ToolExecuteContext | undefined): string | undefined {
  const id = runContextOf(ctx)?.sessionId;
  return typeof id === "string" && SESSION_ID_REGEX.test(id) ? id : undefined;
}

/** The run's trace bus, or undefined off the loop (publishing is then a no-op). */
export function eventBusOf(ctx: ToolExecuteContext | undefined): TraceEventBus | undefined {
  const bus = runContextOf(ctx)?.eventBus;
  return bus !== undefined && typeof bus.publish === "function" ? bus : undefined;
}

/** The run's session event log, when the runtime handed one over. */
export function eventLogOf(ctx: ToolExecuteContext | undefined): EventLogLike | undefined {
  const log = bridgeOf(ctx)?.eventLog;
  return log !== undefined && typeof log.append === "function" ? log : undefined;
}

/** Where the run's session logs live, when the runtime said. */
export function sessionRootOf(ctx: ToolExecuteContext | undefined): string | undefined {
  const dir = bridgeOf(ctx)?.sessionRootDir;
  return typeof dir === "string" && dir !== "" ? dir : undefined;
}

/** Whether the loop was told a sandbox backend is wired (`runChatLoop({ sandboxAvailable })`). */
export function bridgeSandboxAvailable(ctx: ToolExecuteContext | undefined): boolean {
  return bridgeOf(ctx)?.sandboxAvailable === true;
}

/** The spec name the run carries, when it carries a valid one. */
export function specNameOf(ctx: ToolExecuteContext | undefined): string | undefined {
  const name = runContextOf(ctx)?.specName;
  return typeof name === "string" && SPEC_NAME_REGEX.test(name) && !/^\.+$/.test(name)
    ? name
    : undefined;
}

/** Log a warning on the run's logger; silent off the loop. Never throws. */
export function warn(
  ctx: ToolExecuteContext | undefined,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  try {
    runContextOf(ctx)?.logger?.warn(msg, fields);
  } catch {
    // A logger that throws must not turn a finished check into a failure.
  }
}
