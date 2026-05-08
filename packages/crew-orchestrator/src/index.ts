/**
 * Catalog R10 `crew-orchestrator` — Section 22.
 *
 * Builds and runs a multi-role agent crew. Each role is its own
 * `runChatLoop`-backed agent; control passes between roles via
 * Section-22 primitives:
 *   - `Handoff` (`@crewhaus/agent-handoff`) for in-band baton-passes that
 *     stay in the same session (the receiver inherits the parent
 *     transcript via `resume`).
 *   - `SendMessage` (`@crewhaus/a2a-protocol`) for synchronous peer-to-
 *     peer queries that don't yield control.
 *
 * Trace topology: a single `RunContext` with one `TraceEventBus` is
 * shared across every role activation, so all spans nest under the same
 * `traceId`. `sendA2A` and `requestHandoff` annotate that bus with
 * `role_start` / `role_end` / `handoff` / `a2a_message` / `crew_done`
 * trace events. The same events also land on the JSONL `event-log` so
 * post-mortem replay can reconstruct the entire crew run.
 *
 * Refusal-loop guard: a `Handoff` chain that exceeds `refusalDepth`
 * (default 2) terminates with `HandoffRefusedError` rather than
 * looping forever.
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { CrewMailbox } from "@crewhaus/agent-context-isolation";
import { CrewhausError } from "@crewhaus/errors";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionMode,
  type RuleSet,
  emptyRuleSet,
} from "@crewhaus/permission-engine";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type {
  A2AMessageEvent,
  CrewDoneEvent,
  HandoffEvent,
  RoleEndEvent,
  RoleStartEvent,
} from "@crewhaus/trace-event-bus";

import { createSendMessageA2ATool } from "@crewhaus/a2a-protocol";
import { createHandoffTool } from "@crewhaus/agent-handoff";

export class HandoffRefusedError extends CrewhausError {
  override readonly name = "HandoffRefusedError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

export type RoleDefinition = {
  readonly model: string;
  readonly instructions: string;
  /** Per-role tools (in addition to the auto-injected Handoff + SendMessage). */
  readonly tools?: ReadonlyArray<RegisteredTool>;
  /** Override max tokens for this role's runChatLoop. Defaults to 2048. */
  readonly maxTokens?: number;
  /** Override single-turn behaviour. Defaults to true (one user→assistant turn per activation). */
  readonly singleTurn?: boolean;
};

export type RouterFn = (args: {
  input: string;
  lastRole: string | undefined;
  activation: number;
}) => string;

export type CrewEvent =
  | { kind: "role_start"; role: string; activation: number }
  | { kind: "role_end"; role: string; activation: number; output: string; durationMs: number }
  | { kind: "handoff"; from: string; to: string; reason: string; depth: number }
  | {
      kind: "a2a_message";
      from: string;
      to: string;
      payload: string;
      traceparent: string;
    }
  | {
      kind: "crew_done";
      finalRole: string;
      finalOutput: string;
      activations: number;
      durationMs: number;
    };

export type RunOptions = {
  /** Permission mode for every role's runChatLoop. Default "default". */
  readonly permissionMode?: PermissionMode;
  /** Permission rules for every role's runChatLoop. Default builtin floor. */
  readonly permissionRules?: RuleSet;
  /** Cap on consecutive handoffs before HandoffRefusedError fires. Default 2. */
  readonly refusalDepth?: number;
  /** Cap on the total number of role activations. Default 16 — keeps runaway crews bounded. */
  readonly maxActivations?: number;
  /** Cap on A2A recursion depth (peer-asks-peer-asks-peer). Default 3. */
  readonly maxA2ADepth?: number;
  /** Optional stable session id; defaults to `runContext.sessionId`. */
  readonly sessionId?: string;
  /** Override session root dir. Defaults to runtime-core's default `.crewhaus/sessions`. */
  readonly sessionRootDir?: string;
  /** Test injection backdoor: scripted ProviderAdapter shared by every role. */
  readonly _adapter?: ProviderAdapter;
};

export type RunnableCrew = {
  /** Yields `CrewEvent`s in temporal order; resolves the iterator when the crew is done. */
  run(input: string, opts?: RunOptions): AsyncIterable<CrewEvent>;
};

export type CrewBuilder = {
  addRole(name: string, def: RoleDefinition): CrewBuilder;
  setEntry(name: string): CrewBuilder;
  setRouting(router: RouterFn): CrewBuilder;
  /** Crew name surfaced in trace events + the persisted session record. */
  setName(name: string): CrewBuilder;
  compile(): RunnableCrew;
};

const DEFAULT_REFUSAL_DEPTH = 2;
const DEFAULT_MAX_ACTIVATIONS = 16;
const DEFAULT_MAX_A2A_DEPTH = 3;
const DEFAULT_MAX_TOKENS = 2048;

export function Crew(): CrewBuilder {
  const roles = new Map<string, RoleDefinition>();
  let entry: string | undefined;
  let router: RouterFn | undefined;
  let crewName = "(unnamed-crew)";

  const builder: CrewBuilder = {
    addRole(name, def) {
      if (!name || name.length === 0)
        throw new CrewhausError("config", "addRole requires a non-empty name");
      if (roles.has(name)) throw new CrewhausError("config", `role "${name}" already added`);
      roles.set(name, def);
      return builder;
    },
    setEntry(name) {
      if (!roles.has(name)) {
        throw new CrewhausError(
          "config",
          `setEntry: unknown role "${name}". Known: ${[...roles.keys()].join(", ") || "(none)"}`,
        );
      }
      entry = name;
      return builder;
    },
    setRouting(r) {
      router = r;
      return builder;
    },
    setName(n) {
      crewName = n;
      return builder;
    },
    compile() {
      if (roles.size === 0) {
        throw new CrewhausError("config", "Crew requires at least one role");
      }
      if (entry === undefined) {
        // Default: the first role added. Map preserves insertion order;
        // the size > 0 guard above proves there's a first key.
        const firstKey = roles.keys().next().value;
        if (firstKey === undefined) {
          throw new CrewhausError("config", "Crew requires at least one role");
        }
        entry = firstKey;
      }
      const compiled = compileCrew({ roles, entry, router, crewName });
      return compiled;
    },
  };
  return builder;
}

type CompileArgs = {
  roles: ReadonlyMap<string, RoleDefinition>;
  entry: string;
  router: RouterFn | undefined;
  crewName: string;
};

function compileCrew(args: CompileArgs): RunnableCrew {
  const roleNames = [...args.roles.keys()];
  return {
    run(input, opts = {}) {
      // Drive the crew via async-generator + queue: events emitted from
      // any control-flow point land in the iterator in temporal order.
      return driveCrew({ ...args, input, opts, roleNames });
    },
  };
}

async function* driveCrew(
  args: CompileArgs & { input: string; opts: RunOptions; roleNames: string[] },
): AsyncIterable<CrewEvent> {
  const refusalDepth = args.opts.refusalDepth ?? DEFAULT_REFUSAL_DEPTH;
  const maxActivations = args.opts.maxActivations ?? DEFAULT_MAX_ACTIVATIONS;
  const maxA2A = args.opts.maxA2ADepth ?? DEFAULT_MAX_A2A_DEPTH;

  const permissionMode: PermissionMode = args.opts.permissionMode ?? "default";
  // Always grant the orchestrator-owned tools (Handoff + SendMessage). Crew
  // bundles wire the user's spec rules under `yaml`; we add Handoff +
  // SendMessage allowances under `flag` so they apply regardless of the
  // user's mode + rule choices. Without this, "default" mode treats them
  // as "ask" and single-turn runChatLoop denies (no interactive prompter).
  const baseRules: RuleSet = args.opts.permissionRules ?? {
    ...emptyRuleSet,
    builtin: BUILTIN_DEFAULT_RULES,
  };
  const permissionRules: RuleSet = {
    ...baseRules,
    flag: [
      ...baseRules.flag,
      { type: "alwaysAllow", pattern: "Handoff", source: "flag" },
      { type: "alwaysAllow", pattern: "SendMessage", source: "flag" },
    ],
  };

  // Single RunContext shared across every role activation so the entire
  // crew nests under one traceId.
  const runContext: RunContext = createRunContext(
    args.opts.sessionId !== undefined ? { sessionId: args.opts.sessionId } : {},
  );

  // Open a single event-log handle for the crew session. Every role's
  // runChatLoop opens its own handle against the same path; the
  // append-sync-per-line guarantee on POSIX keeps interleaving safe.
  const eventLog: EventLog = await openEventLog(
    runContext.sessionId,
    args.opts.sessionRootDir !== undefined ? { rootDir: args.opts.sessionRootDir } : {},
  );

  const queue: CrewEvent[] = [];
  let resolveNext: ((ev: CrewEvent | "done" | "error") => void) | null = null;
  let driveError: unknown;

  function push(ev: CrewEvent): void {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(ev);
    } else {
      queue.push(ev);
    }
  }

  // Mirror every CrewEvent onto the trace bus + JSONL event log so OTel
  // and post-mortem replay both see them.
  async function recordEvent(ev: CrewEvent): Promise<void> {
    const bus = runContext.eventBus;
    if (ev.kind === "role_start") {
      bus.publish({
        ...bus.envelope(),
        kind: "role_start",
        role: ev.role,
        activation: ev.activation,
      } satisfies RoleStartEvent);
      await eventLog.append({
        kind: "role_start",
        payload: { role: ev.role, activation: ev.activation },
      });
    } else if (ev.kind === "role_end") {
      bus.publish({
        ...bus.envelope(),
        kind: "role_end",
        role: ev.role,
        activation: ev.activation,
        finalMessageBytes: Buffer.byteLength(ev.output, "utf8"),
        durationMs: ev.durationMs,
      } satisfies RoleEndEvent);
      await eventLog.append({
        kind: "role_end",
        payload: {
          role: ev.role,
          activation: ev.activation,
          outputBytes: Buffer.byteLength(ev.output, "utf8"),
          durationMs: ev.durationMs,
        },
      });
    } else if (ev.kind === "handoff") {
      bus.publish({
        ...bus.envelope(),
        kind: "handoff",
        from: ev.from,
        to: ev.to,
        reason: ev.reason,
        depth: ev.depth,
      } satisfies HandoffEvent);
      await eventLog.append({
        kind: "handoff",
        payload: { from: ev.from, to: ev.to, reason: ev.reason, depth: ev.depth },
      });
    } else if (ev.kind === "a2a_message") {
      bus.publish({
        ...bus.envelope(),
        kind: "a2a_message",
        from: ev.from,
        to: ev.to,
        messageKind: "question",
        payloadBytes: Buffer.byteLength(ev.payload, "utf8"),
        traceparent: ev.traceparent,
      } satisfies A2AMessageEvent);
      await eventLog.append({
        kind: "a2a_message",
        payload: {
          from: ev.from,
          to: ev.to,
          payloadBytes: Buffer.byteLength(ev.payload, "utf8"),
          traceparent: ev.traceparent,
        },
      });
    } else if (ev.kind === "crew_done") {
      bus.publish({
        ...bus.envelope(),
        kind: "crew_done",
        finalRole: ev.finalRole,
        totalActivations: ev.activations,
        durationMs: ev.durationMs,
      } satisfies CrewDoneEvent);
      await eventLog.append({
        kind: "crew_done",
        payload: {
          finalRole: ev.finalRole,
          activations: ev.activations,
          durationMs: ev.durationMs,
        },
      });
    }
  }

  // Pending handoff state (set by `requestHandoff`, drained by drive loop).
  let pendingHandoff: { target: string; reason: string; context?: unknown } | undefined;
  let currentRoleName = args.entry;
  let a2aDepth = 0;

  // Track activation order and total activation count.
  let activations = 0;
  let lastAccessedFrom = "(none)";
  let firstTurn = true;
  let lastOutput = "";

  // Mailbox shared across every role's runChatLoop. The orchestrator
  // mutates `currentRoleName` between activations; tools observe it via
  // `currentRole()` to stamp envelopes.
  const mailbox: CrewMailbox = {
    knownRoles: args.roleNames,
    currentRole: () => currentRoleName,
    currentTraceparent: () => runContext.eventBus.currentTraceparent(),
    requestHandoff: (target, reason, context) => {
      // Validation duplicated here in case a tool with a stale config calls in.
      if (!args.roleNames.includes(target)) {
        throw new CrewhausError("runtime", `requestHandoff: unknown target "${target}"`);
      }
      if (target === currentRoleName) {
        throw new CrewhausError("runtime", "requestHandoff: cannot hand off to self");
      }
      pendingHandoff = { target, reason, ...(context !== undefined ? { context } : {}) };
    },
    sendA2A: async (toRole, payload) => {
      if (!args.roleNames.includes(toRole)) {
        throw new CrewhausError("runtime", `sendA2A: unknown target "${toRole}"`);
      }
      if (toRole === currentRoleName) {
        throw new CrewhausError("runtime", "sendA2A: cannot send to self");
      }
      if (a2aDepth >= maxA2A) {
        return `[A2A error] depth limit ${maxA2A} reached — refusing further peer calls`;
      }
      const traceparent = runContext.eventBus.currentTraceparent();
      const fromRole = currentRoleName;
      push({ kind: "a2a_message", from: fromRole, to: toRole, payload, traceparent });
      await recordEvent({ kind: "a2a_message", from: fromRole, to: toRole, payload, traceparent });

      const peerDef = args.roles.get(toRole);
      if (peerDef === undefined) {
        return `[A2A error] missing role definition for "${toRole}"`;
      }
      a2aDepth += 1;
      const savedRole = currentRoleName;
      currentRoleName = toRole;
      try {
        const reply = await runChatLoop({
          model: peerDef.model,
          instructions: peerDef.instructions,
          runContext,
          sessionName: args.crewName,
          sessionTarget: "crew",
          ...(args.opts.sessionRootDir !== undefined
            ? { sessionRootDir: args.opts.sessionRootDir }
            : {}),
          singleTurn: true,
          seedMessages: [
            {
              role: "user",
              content: `[A2A from ${savedRole} → ${toRole}]\n\n${payload}`,
            },
          ],
          tools: composeRoleTools({
            role: toRole,
            roles: args.roleNames,
            roleTools: peerDef.tools ?? [],
          }),
          permissionMode,
          permissionRules,
          installSigintHandler: false,
          maxTokens: peerDef.maxTokens ?? DEFAULT_MAX_TOKENS,
          crewMailbox: mailbox,
          // A2A is in-band: treat every call after the first as a resume
          // so the peer sees the prior crew transcript.
          ...(firstTurn ? {} : { resume: { sessionId: runContext.sessionId } }),
          ...(args.opts._adapter !== undefined ? { _adapter: args.opts._adapter } : {}),
        });
        firstTurn = false;
        return reply;
      } finally {
        currentRoleName = savedRole;
        a2aDepth -= 1;
      }
    },
  };

  const t0 = performance.now();

  void (async () => {
    try {
      let messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: args.input },
      ];
      let consecutiveHandoffs = 0;

      while (true) {
        if (activations >= maxActivations) {
          throw new CrewhausError(
            "runtime",
            `crew exceeded maxActivations=${maxActivations}; last role was "${currentRoleName}"`,
          );
        }

        const def = args.roles.get(currentRoleName);
        if (def === undefined) {
          throw new CrewhausError("config", `unknown role "${currentRoleName}"`);
        }

        push({ kind: "role_start", role: currentRoleName, activation: activations });
        await recordEvent({ kind: "role_start", role: currentRoleName, activation: activations });

        // Reset pending handoff before each activation so the previous
        // role's request — already consumed — can't bleed in.
        pendingHandoff = undefined;

        const tStart = performance.now();
        const output: string = await runChatLoop({
          model: def.model,
          instructions: def.instructions,
          runContext,
          sessionName: args.crewName,
          sessionTarget: "crew",
          ...(args.opts.sessionRootDir !== undefined
            ? { sessionRootDir: args.opts.sessionRootDir }
            : {}),
          singleTurn: def.singleTurn ?? true,
          seedMessages: messages.map((m) => ({ role: m.role, content: m.content })),
          tools: composeRoleTools({
            role: currentRoleName,
            roles: args.roleNames,
            roleTools: def.tools ?? [],
          }),
          permissionMode,
          permissionRules,
          installSigintHandler: false,
          maxTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
          crewMailbox: mailbox,
          ...(firstTurn ? {} : { resume: { sessionId: runContext.sessionId } }),
          ...(args.opts._adapter !== undefined ? { _adapter: args.opts._adapter } : {}),
        });

        firstTurn = false;
        lastOutput = output;
        const durationMs = performance.now() - tStart;
        push({
          kind: "role_end",
          role: currentRoleName,
          activation: activations,
          output,
          durationMs,
        });
        await recordEvent({
          kind: "role_end",
          role: currentRoleName,
          activation: activations,
          output,
          durationMs,
        });

        activations += 1;

        if (pendingHandoff !== undefined) {
          consecutiveHandoffs += 1;
          if (consecutiveHandoffs > refusalDepth) {
            throw new HandoffRefusedError(`handoff refused (depth=${consecutiveHandoffs})`);
          }
          const ho: HandoffEventInternal = {
            from: currentRoleName,
            to: pendingHandoff.target,
            reason: pendingHandoff.reason,
            ...(pendingHandoff.context !== undefined ? { context: pendingHandoff.context } : {}),
          };
          push({
            kind: "handoff",
            from: ho.from,
            to: ho.to,
            reason: ho.reason,
            depth: consecutiveHandoffs,
          });
          await recordEvent({
            kind: "handoff",
            from: ho.from,
            to: ho.to,
            reason: ho.reason,
            depth: consecutiveHandoffs,
          });
          lastAccessedFrom = ho.from;
          currentRoleName = ho.to;
          messages = buildHandoffSeed(ho);
          continue;
        }

        // No pending handoff — optionally consult the routing function.
        // The default behaviour (no router) is to terminate after the
        // current role's `end_turn`.
        if (args.router !== undefined) {
          const next = args.router({
            input: output,
            lastRole: currentRoleName,
            activation: activations,
          });
          if (next !== currentRoleName && args.roleNames.includes(next)) {
            consecutiveHandoffs = 0; // a router move is not a refusal
            push({
              kind: "handoff",
              from: currentRoleName,
              to: next,
              reason: "[router] move",
              depth: 0,
            });
            await recordEvent({
              kind: "handoff",
              from: currentRoleName,
              to: next,
              reason: "[router] move",
              depth: 0,
            });
            lastAccessedFrom = currentRoleName;
            currentRoleName = next;
            messages = [{ role: "user", content: output }];
            continue;
          }
        }

        // Crew done.
        const totalDuration = performance.now() - t0;
        push({
          kind: "crew_done",
          finalRole: currentRoleName,
          finalOutput: output,
          activations,
          durationMs: totalDuration,
        });
        await recordEvent({
          kind: "crew_done",
          finalRole: currentRoleName,
          finalOutput: output,
          activations,
          durationMs: totalDuration,
        });
        break;
      }
    } catch (err) {
      driveError = err;
    } finally {
      await eventLog.close().catch(() => {});
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(driveError !== undefined ? "error" : "done");
      } else {
        // Mark sentinel by pushing a synthetic terminal so the consumer
        // exits the loop on next iteration.
        queue.push(SENTINEL_DONE);
      }
    }
    void lastAccessedFrom; // referenced for diagnostics; silence unused
    void lastOutput;
  })();

  while (true) {
    if (queue.length > 0) {
      const ev = queue.shift();
      if (ev === undefined) continue;
      if (ev === (SENTINEL_DONE as unknown as CrewEvent)) {
        if (driveError !== undefined) throw driveError;
        return;
      }
      yield ev;
      continue;
    }
    const next = await new Promise<CrewEvent | "done" | "error">((resolve) => {
      resolveNext = resolve;
    });
    if (next === "done") return;
    if (next === "error") {
      if (driveError !== undefined) throw driveError;
      return;
    }
    yield next;
  }
}

// Sentinel object (NOT a real CrewEvent) used to wake the consumer loop
// when the queue path needs an explicit terminal marker.
const SENTINEL_DONE = Object.freeze({ kind: "__crew_done_sentinel__" }) as unknown as CrewEvent;

type HandoffEventInternal = {
  from: string;
  to: string;
  reason: string;
  context?: unknown;
};

function buildHandoffSeed(
  ho: HandoffEventInternal,
): ReadonlyArray<{ role: "user" | "assistant"; content: string }> {
  const parts: string[] = [`[Handoff from ${ho.from}]\n\nReason: ${ho.reason}`];
  if (ho.context !== undefined) {
    let serialised: string;
    if (typeof ho.context === "string") {
      serialised = ho.context;
    } else {
      try {
        serialised = JSON.stringify(ho.context, null, 2);
      } catch {
        serialised = String(ho.context);
      }
    }
    parts.push(`Context:\n${serialised}`);
  }
  parts.push(
    "You now own the conversation. Continue the work end-to-end, calling tools as needed, and respond directly to the user when you are done.",
  );
  return [{ role: "user", content: parts.join("\n\n") }];
}

function composeRoleTools(args: {
  role: string;
  roles: ReadonlyArray<string>;
  roleTools: ReadonlyArray<RegisteredTool>;
}): ReadonlyArray<RegisteredTool> {
  const handoff = createHandoffTool({ from: args.role, targets: args.roles });
  const a2a = createSendMessageA2ATool({ from: args.role, targets: args.roles });
  // Spec-supplied tools first so explicit user choices win in any future
  // catalog dedup; Handoff/SendMessage are appended last and never
  // collide (no spec-side tool today is named "Handoff" or "SendMessage"
  // in a CRW bundle — channel-bot's SendMessage lives in a different
  // target shape).
  return [...args.roleTools, handoff, a2a];
}

export { createHandoffTool, createSendMessageA2ATool };
export type { CrewMailbox } from "@crewhaus/agent-context-isolation";
