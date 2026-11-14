/**
 * The owner-keys table: the one list a spec key added since 0.9.0 is written
 * in (#514). Pure data, so anything may read it. `HUMAN_OWNED_PATHS`,
 * `OPTIMIZER_REFUSED_ROOTS`, `OPTIMIZER_REFUSED_LEAVES` and the spec editor's
 * `SECURITY_SURFACES` take their new rows from here, never by hand copy.
 *
 * The root rule: a one-segment pattern always sets `root`, because a graph
 * node, a crew role, a model profile or a sub-agent can carry the same name. A
 * node called `intent` is an obvious name for a classifier, and its prompt stays
 * tunable. A longer pattern may leave `root` off and match wherever a shape
 * places the key.
 */
export type OwnerKey = {
  /** The key's path. `"*"` matches any one segment. */
  readonly pattern: ReadonlyArray<string>;
  /** Match from the document root only. Absent: a contiguous run anywhere in the path. */
  readonly root?: true;
  /** The optimizer may never change it, whatever `OPTIMIZABLE_PATHS` lists. */
  readonly refused: boolean;
  /** The spec editor asks for the typed confirmation before writing it. */
  readonly security: boolean;
  /** Why, in the words a refusal shows. */
  readonly reason: string;
  /** The release the row landed in. */
  readonly since: "0.9.0";
};

export const DELTA_090_KEYS: ReadonlyArray<OwnerKey> = Object.freeze([
  Object.freeze({
    pattern: Object.freeze(["intent"]),
    root: true,
    refused: true,
    security: true,
    reason: "intent says what this harness is for, and only its owner changes that",
    since: "0.9.0",
  } as const),
  Object.freeze({
    pattern: Object.freeze(["evaluation", "protected"]),
    root: true,
    refused: true,
    security: true,
    reason: "whether this bar may be loosened is the owner's decision",
    since: "0.9.0",
  } as const),
  Object.freeze({
    pattern: Object.freeze(["provability", "protected"]),
    root: true,
    refused: true,
    security: true,
    reason: "whether this bar may be loosened is the owner's decision",
    since: "0.9.0",
  } as const),
  // A judge gate sits inside a workflow step or a graph node, so this row
  // matches wherever the key appears.
  Object.freeze({
    pattern: Object.freeze(["judge", "protected"]),
    refused: true,
    security: true,
    reason: "whether this gate may be loosened is the owner's decision",
    since: "0.9.0",
  } as const),
  // Both forms of `schedule:` (#514): when a harness runs and what it spends.
  // Never optimizable; no typed confirmation, since it is not a security bar.
  Object.freeze({
    pattern: Object.freeze(["schedule"]),
    root: true,
    refused: false,
    security: false,
    reason: "a schedule sets when this harness runs and what it spends; a person changes it",
    since: "0.9.0",
  } as const),
  // Both forms of `plugins:` (#522): which plugins load, and which host tools
  // each may drive without the permission engine asking.
  Object.freeze({
    pattern: Object.freeze(["plugins"]),
    root: true,
    refused: true,
    security: true,
    reason: "what a plugin may load and drive unchecked is the owner's decision",
    since: "0.9.0",
  } as const),
]);
