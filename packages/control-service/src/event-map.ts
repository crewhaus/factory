/**
 * Which event a control record's state is, one closed table per machine: every state of
 * the `run`, `command`, `decision` and `deployment` machines maps to an event type of the
 * taxonomy, and a decision-log line's event to a decision event (or to none, with the
 * reason). The event stream and the projector's fleet change log both read it, so an
 * event means the same thing wherever it is served.
 */
import {
  type CommandState,
  type DecisionLogEvent,
  type DecisionState,
  type DeploymentState,
  type EventType,
  type RunState,
  isEventType,
} from "@crewhaus/control-contract";

/** A run's state as its event. Both waiting states are `run.waiting`. */
export const RUN_STATE_EVENTS = Object.freeze({
  queued: "run.queued",
  preparing: "run.preparing",
  running: "run.started",
  "waiting-for-approval": "run.waiting",
  "waiting-for-input": "run.waiting",
  paused: "run.paused",
  interrupted: "run.interrupted",
  succeeded: "run.succeeded",
  failed: "run.failed",
  cancelled: "run.cancelled",
} as const satisfies Record<RunState, EventType>);

/** A receipt's state as its event. */
export const COMMAND_STATE_EVENTS = Object.freeze({
  accepted: "command.accepted",
  running: "command.started",
  unknown: "command.unknown",
  succeeded: "command.succeeded",
  failed: "command.failed",
  rejected: "command.rejected",
  cancelled: "command.cancelled",
} as const satisfies Record<CommandState, EventType>);

/** A `dec_` decision's state as its event: a grant and a deny are both decided. */
export const DECISION_STATE_EVENTS = Object.freeze({
  pending: "decision.opened",
  granted: "decision.decided",
  denied: "decision.decided",
  consumed: "decision.consumed",
  superseded: "decision.superseded",
  expired: "decision.expired",
} as const satisfies Record<DecisionState, EventType>);

/**
 * A deployment's state as its event. A move back to `active` from `disabled` is still
 * `deployment.activated`: a row carries its state, not the move, so
 * `deployment.enabled` is never produced from a row.
 */
export const DEPLOYMENT_STATE_EVENTS = Object.freeze({
  prepared: "deployment.prepared",
  active: "deployment.activated",
  superseded: "deployment.superseded",
  disabled: "deployment.disabled",
  retired: "deployment.retired",
} as const satisfies Record<DeploymentState, EventType>);

/**
 * A tool approval's decision-log line as its event. `evict` is no event: it records that
 * the asked-for record was dropped by the TTL sweep after its `expire`, which already
 * said the decision ended.
 */
export const APPROVAL_LOG_EVENTS = Object.freeze({
  park: "decision.opened",
  decide: "decision.decided",
  supersede: "decision.superseded",
  defer: "decision.deferred",
  consume: "decision.consumed",
  refuse: "decision.refused",
  expire: "decision.expired",
  evict: null,
} as const satisfies Record<DecisionLogEvent, EventType | null>);

/** The machines whose every state the tables above name. */
export const MACHINE_STATE_EVENTS = Object.freeze({
  run: RUN_STATE_EVENTS,
  command: COMMAND_STATE_EVENTS,
  decision: DECISION_STATE_EVENTS,
  deployment: DEPLOYMENT_STATE_EVENTS,
});

/** The event a machine state is, or `undefined` for a state the machine does not have. */
export function stateEventOf(
  machine: keyof typeof MACHINE_STATE_EVENTS,
  state: unknown,
): EventType | undefined {
  if (typeof state !== "string") return undefined;
  const table = MACHINE_STATE_EVENTS[machine] as Readonly<Record<string, string>>;
  const type = Object.hasOwn(table, state) ? table[state] : undefined;
  return isEventType(type) ? type : undefined;
}
