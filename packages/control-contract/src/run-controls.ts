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
    "runs.create": RUNS_CREATE[shape],
  };
}

/**
 * Whether the control API can start a run of each shape: the shapes whose entry reads its
 * input (a cli turn, a crew brief, the seed of a workflow or a graph, a managed run's
 * input) start one, and the others name their own intake. Each `true` cell is held by a
 * truth test that reads the shape's compiled entry.
 */
const RUNS_CREATE: Readonly<Record<RunControlShape, CapabilityDescriptor>> = {
  cli: { supported: true },
  crew: { supported: true },
  workflow: { supported: true },
  graph: { supported: true },
  managed: { supported: true },
  channel: {
    supported: false,
    reason: "A channel harness takes its work as messages: message it in the channel.",
    verb: null,
  },
  batch: {
    supported: false,
    reason: "A batch harness takes its work from its queue: enqueue it.",
    verb: null,
  },
  voice: {
    supported: false,
    reason: "A voice harness takes its work as calls.",
    verb: null,
  },
  pipeline: {
    supported: false,
    reason: "A pipeline harness's build reads no input, so there is nothing to start it with.",
    verb: null,
  },
  research: {
    supported: false,
    reason: "A research harness's build reads no input, so there is nothing to start it with.",
    verb: null,
  },
  browser: {
    supported: false,
    reason: "A browser harness takes its task in the terminal.",
    verb: "crewhaus run crewhaus.yaml --prompt <text>",
  },
};

/** Every run-control shape, with one descriptor per run-control key. */
export const SHAPE_RUN_CONTROLS: Readonly<
  Record<RunControlShape, Readonly<Record<RunControlKey, CapabilityDescriptor>>>
> = deepFreeze(
  Object.fromEntries(RUN_CONTROL_SHAPES.map((shape) => [shape, cellsFor(shape)])) as Record<
    RunControlShape,
    Record<RunControlKey, CapabilityDescriptor>
  >,
);
