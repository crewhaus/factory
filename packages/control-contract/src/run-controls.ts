/**
 * What each shape can do with the operator's run controls, as a tri-state descriptor
 * per shape and per key. A cell is `true` only once a truth test says so; until then it
 * is `false` with the reason and the real command that fills the gap, or `unknown`
 * with the reason, never `true` on trust. Control-plane data, not IR.
 *
 * The shapes are the compiler's targets that run work an operator controls. `eval`,
 * `onchain` and `onchain-game` have no run controls: an eval harness is graded, not
 * operated, and an on-chain build answers to its chain. The five keys are the
 * run-control capabilities; `runs.ledger`, `decisions.consumeChecks` and `events.trace`
 * are answered per bundle and per daemon, never per shape.
 *
 * A harness's own answer (`harnesses.capabilities`) combines this table with what its
 * bundle and its daemon say: a shape that cannot do something never can, whatever a
 * bundle claims.
 */
import type { CapabilityDescriptor } from "./capabilities.js";
import { deepFreeze } from "./util.js";

export const RUN_CONTROL_SHAPES = deepFreeze([
  "cli",
  "workflow",
  "channel",
  "graph",
  "managed",
  "pipeline",
  "crew",
  "research",
  "batch",
  "voice",
  "browser",
] as const);

export type RunControlShape = (typeof RUN_CONTROL_SHAPES)[number];

export const RUN_CONTROL_KEYS = deepFreeze([
  "controls.pauseIntake",
  "controls.cancelRun",
  "controls.drain",
  "controls.disable",
  "runs.create",
] as const);

export type RunControlKey = (typeof RUN_CONTROL_KEYS)[number];

/** Shapes that keep running and take work as it arrives. */
const LONG_RUNNING: ReadonlySet<RunControlShape> = new Set([
  "channel",
  "managed",
  "batch",
  "voice",
]);

const NOT_CHECKED: CapabilityDescriptor = {
  supported: "unknown",
  reason: "Not yet checked for this shape.",
};

function cellsFor(shape: RunControlShape): Readonly<Record<RunControlKey, CapabilityDescriptor>> {
  const runsOnce = !LONG_RUNNING.has(shape);
  const noIntake: CapabilityDescriptor = {
    supported: false,
    reason: `A ${shape} harness runs once per command, so it has no intake to pause or drain.`,
    verb: null,
  };
  return {
    "controls.pauseIntake": runsOnce ? noIntake : NOT_CHECKED,
    "controls.cancelRun": NOT_CHECKED,
    "controls.drain": runsOnce ? noIntake : NOT_CHECKED,
    "controls.disable": NOT_CHECKED,
    "runs.create": {
      supported: false,
      reason: "Starting a run through the control API is not served yet.",
      verb: null,
    },
  };
}

/** Every run-control shape, with one descriptor per run-control key. */
export const SHAPE_RUN_CONTROLS: Readonly<
  Record<RunControlShape, Readonly<Record<RunControlKey, CapabilityDescriptor>>>
> = deepFreeze(
  Object.fromEntries(RUN_CONTROL_SHAPES.map((shape) => [shape, cellsFor(shape)])) as Record<
    RunControlShape,
    Record<RunControlKey, CapabilityDescriptor>
  >,
);
