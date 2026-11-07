/**
 * Every object's lifecycle, as data. `MACHINES` is the only export of this table:
 * a state list, a transition map and a recovery owner are read through it, and a
 * move is checked with `canTransition`.
 *
 * A fold applies only legal transitions. An illegal row is kept and shown as an
 * anomaly, never applied.
 */
import type { CORE_MODULE } from "./areas/core.js";
import { type ComposedModule, MODULES } from "./areas/index.js";
import type { MachineDef } from "./areas/types.js";
import { deepFreeze } from "./util.js";

export type MachineName = ComposedModule extends infer M
  ? M extends { readonly machines: infer Table }
    ? keyof Table & string
    : never
  : never;

export const MACHINES: Readonly<Record<MachineName, MachineDef>> = deepFreeze(
  Object.assign({}, ...MODULES.map((module) => module.machines)),
);

/** Whether this object may move from one state to the other. Unknown names answer `false`. */
export function canTransition(machine: string, from: string, to: string): boolean {
  if (!Object.hasOwn(MACHINES, machine)) return false;
  const { transitions } = MACHINES[machine as MachineName];
  if (!Object.hasOwn(transitions, from)) return false;
  return transitions[from]?.includes(to) ?? false;
}

type CoreMachines = (typeof CORE_MODULE)["machines"];

export type RunState = CoreMachines["run"]["states"][number];
export type CommandState = CoreMachines["command"]["states"][number];
export type DecisionState = CoreMachines["decision"]["states"][number];
export type DeploymentState = CoreMachines["deployment"]["states"][number];

/** Derived from the operator record, the supervisor and the heartbeat; never stored. */
export const HARNESS_DISPLAY_STATES = deepFreeze([
  "running",
  "paused",
  "draining",
  "stopped",
  "crashed",
  "disabled",
  "disconnected",
] as const);

export type HarnessDisplayState = (typeof HARNESS_DISPLAY_STATES)[number];

/** A control a bundle cannot enforce reads `recorded-not-enforced`, never as done. */
export type HarnessEnforcement = "enforced" | "recorded-not-enforced";

export type HarnessDisplay = {
  readonly state: HarnessDisplayState;
  readonly enforcement: HarnessEnforcement;
};
