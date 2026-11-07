/**
 * Run ids come in several forms from several minters. `classifyRunId` tells them
 * apart without naming more than the grammar can know: a `run_<16 hex>` is an
 * execution, an eval run, a research run or a job log, and only its location can
 * say which, so it answers `hex16` and lists the ref kinds to try.
 */
import { CANONICAL_RUN_ID_RE, EXECUTION_RUN_ID_RE, GRAPH_RUN_ID_RE } from "./ids.js";

export type RunIdFamily =
  | "canonical"
  | "hex16"
  | "hex8"
  | "literal"
  | "base36"
  | "workflow"
  | "graph"
  | "federation"
  | "unknown";

export type RunIdClass = {
  readonly family: RunIdFamily;
  readonly refKinds: readonly string[];
};

const HEX8_RE = /^run_[0-9a-f]{8}$/;
const BASE36_RE = /^run_[0-9a-z]{1,8}$/;
const WORKFLOW_RE = /^wf_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FEDERATION_RE = /^fedrun_[0-9a-z]+$/;

const NO_KINDS: readonly string[] = Object.freeze([]);
const RUN_KIND: readonly string[] = Object.freeze(["run"]);
const HEX16_KINDS: readonly string[] = Object.freeze(["exec", "evalrun"]);

/** Which run-id form this is. Total: anything else answers `unknown`. */
export function classifyRunId(id: unknown): RunIdClass {
  if (typeof id !== "string") return { family: "unknown", refKinds: NO_KINDS };
  if (CANONICAL_RUN_ID_RE.test(id)) return { family: "canonical", refKinds: RUN_KIND };
  if (EXECUTION_RUN_ID_RE.test(id)) return { family: "hex16", refKinds: HEX16_KINDS };
  if (HEX8_RE.test(id)) return { family: "hex8", refKinds: RUN_KIND };
  // A bridge's placeholder, never routed, though it fits the base36 shape.
  if (id === "run_channel") return { family: "literal", refKinds: NO_KINDS };
  if (BASE36_RE.test(id)) return { family: "base36", refKinds: RUN_KIND };
  if (WORKFLOW_RE.test(id)) return { family: "workflow", refKinds: NO_KINDS };
  if (GRAPH_RUN_ID_RE.test(id)) return { family: "graph", refKinds: NO_KINDS };
  if (FEDERATION_RE.test(id)) return { family: "federation", refKinds: NO_KINDS };
  return { family: "unknown", refKinds: NO_KINDS };
}
