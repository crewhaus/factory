/**
 * The inspector's read model of one harness's run ledger: per run, the content-free
 * skeleton a summary needs (its session and place in it, its execution, the runs around
 * it, its work item, its state and trigger, when it started and ended), plus the runs
 * each run started (`children`), the runs each work item had (`byWork`) and the runs of
 * each session (`bySession`). Pure: `fold` reads only the item it is handed, so folding
 * the same ledger from empty twice gives equal states. Home wraps it into its projector,
 * which keeps it caught up; a read hands {@link rowsFromModel}'s rows to `loadRun` instead
 * of reading the ledger again.
 *
 * At most {@link INSPECT_MODEL_MAX} runs are kept; past it the oldest-seen go first, and
 * the state says it was capped.
 */
import { CANONICAL_RUN_ID_RE, SESSION_ID_RE } from "@crewhaus/control-contract";
import type { ResumeItem } from "@crewhaus/control-records";
import type { RunRow } from "./load";

/** As many runs as Home's run read model keeps. */
export const INSPECT_MODEL_MAX = 20_000;

/** What the inspector keeps of one run: nothing a person wrote. */
export type InspectRunSkeleton = {
  state: string;
  session?: string;
  sessionAt?: number;
  execution?: string;
  parent?: string;
  continues?: string;
  continuedIn?: string;
  workItem?: string;
  failureClass?: string;
  /** The approval the run waits on, when it waits on one. */
  decision?: string;
  /** What started it: the trigger's kind, its lane and whether a wake did. */
  trigger?: string;
  lane?: string;
  synthetic?: true;
  startedAt?: string;
  endedAt?: string;
};

export type InspectModel = {
  runs: Record<string, InspectRunSkeleton>;
  /** Parent run → the runs it started, in the order they appeared. */
  children: Record<string, string[]>;
  /** Work item → the runs that served it, in the order they appeared. */
  byWork: Record<string, string[]>;
  /** Session → its runs, in the order they appeared. */
  bySession: Record<string, string[]>;
  truncated?: true;
};

const TERMINAL = new Set(["interrupted", "succeeded", "failed", "cancelled"]);

/** A closed code a skeleton may hold: anything else is left out. */
const CODE_RE = /^[A-Za-z0-9_.:@#/-]{1,128}$/;
const WORK_ID_RE = /^wi_[0-9a-hjkmnp-tv-z]{26}$/;
const EXECUTION_ID_RE = /^run_[0-9a-f]{16}$/;

function codeOf(value: unknown): string | undefined {
  return typeof value === "string" && CODE_RE.test(value) ? value : undefined;
}

function matching(value: unknown, re: RegExp): string | undefined {
  return typeof value === "string" && re.test(value) ? value : undefined;
}

export function emptyInspectModel(): InspectModel {
  return { runs: {}, children: {}, byWork: {}, bySession: {} };
}

/** Add `run` to the list under `key`, once. */
function listed(map: Record<string, string[]>, key: string, run: string): void {
  const list = Object.hasOwn(map, key) ? (map[key] as string[]) : [];
  if (!list.includes(run)) list.push(run);
  map[key] = list;
}

/** Drop `run` from every list, for a run pushed out at the cap. */
function unlisted(map: Record<string, string[]>, run: string): void {
  for (const [key, list] of Object.entries(map)) {
    const kept = list.filter((id) => id !== run);
    if (kept.length === 0) delete map[key];
    else if (kept.length !== list.length) map[key] = kept;
  }
}

/** Fold one run-ledger item into the model, in place. */
export function foldInspectModel(state: InspectModel, item: ResumeItem): InspectModel {
  if (item.kind !== "line") return state;
  const row = item.record;
  const id = matching(row["id"], CANONICAL_RUN_ID_RE);
  const runState = codeOf(row["state"]);
  if (id === undefined || runState === undefined) return state;
  let skeleton = Object.hasOwn(state.runs, id) ? state.runs[id] : undefined;
  if (skeleton === undefined) {
    const ids = Object.keys(state.runs);
    if (ids.length >= INSPECT_MODEL_MAX) {
      const oldest = ids[0] as string;
      delete state.runs[oldest];
      unlisted(state.children, oldest);
      unlisted(state.byWork, oldest);
      unlisted(state.bySession, oldest);
      state.truncated = true;
    }
    skeleton = { state: runState };
    state.runs[id] = skeleton;
  }
  skeleton.state = runState;
  const at = typeof row["at"] === "string" && CODE_RE.test(row["at"]) ? row["at"] : undefined;
  if (skeleton.startedAt === undefined && at !== undefined) skeleton.startedAt = at;
  if (TERMINAL.has(runState) && at !== undefined) skeleton.endedAt = at;
  const session = matching(row["session"], SESSION_ID_RE);
  if (session !== undefined && skeleton.session === undefined) {
    skeleton.session = session;
    listed(state.bySession, session, id);
  }
  const sessionAt = row["sessionAt"];
  if (
    skeleton.sessionAt === undefined &&
    typeof sessionAt === "number" &&
    Number.isSafeInteger(sessionAt) &&
    sessionAt >= 0
  ) {
    skeleton.sessionAt = sessionAt;
  }
  const execution = matching(row["execution"], EXECUTION_ID_RE);
  if (execution !== undefined) skeleton.execution = execution;
  const parent = matching(row["parent"], CANONICAL_RUN_ID_RE);
  if (parent !== undefined && skeleton.parent === undefined) {
    skeleton.parent = parent;
    listed(state.children, parent, id);
  }
  const continues = matching(row["continues"], CANONICAL_RUN_ID_RE);
  if (continues !== undefined) skeleton.continues = continues;
  const continuedIn = matching(row["continuedIn"], CANONICAL_RUN_ID_RE);
  if (continuedIn !== undefined) skeleton.continuedIn = continuedIn;
  const workItem = matching(row["workItem"], WORK_ID_RE);
  if (workItem !== undefined && skeleton.workItem === undefined) {
    skeleton.workItem = workItem;
    listed(state.byWork, workItem, id);
  }
  const failureClass = codeOf(row["failureClass"]);
  if (failureClass !== undefined) skeleton.failureClass = failureClass;
  const decision = codeOf(row["decision"]);
  if (decision !== undefined) skeleton.decision = decision;
  const trigger = row["trigger"];
  if (typeof trigger === "object" && trigger !== null && !Array.isArray(trigger)) {
    const t = trigger as Readonly<Record<string, unknown>>;
    const kind = codeOf(t["kind"]);
    if (kind !== undefined) skeleton.trigger = kind;
    const lane = codeOf(t["lane"]);
    if (lane !== undefined) skeleton.lane = lane;
    if (t["synthetic"] === true) skeleton.synthetic = true;
  }
  return state;
}

/** A skeleton as the run row `loadRun` reads. */
function rowOf(id: string, skeleton: InspectRunSkeleton): RunRow {
  const { trigger, lane, synthetic, startedAt: _startedAt, endedAt: _endedAt, ...rest } = skeleton;
  return {
    id,
    ...rest,
    ...(trigger !== undefined
      ? {
          trigger: {
            kind: trigger,
            ...(lane !== undefined ? { lane } : {}),
            ...(synthetic === true ? { synthetic } : {}),
          },
        }
      : {}),
  };
}

/**
 * The rows `loadRun` needs for `run`, from the model: the run's, and those of every run
 * of its session and every run that continues it, one row each. `undefined` when the
 * model does not hold the run (it was capped out, or not folded yet): read the ledger.
 */
export function rowsFromModel(
  model: InspectModel,
  run: string,
): ReadonlyMap<string, readonly RunRow[]> | undefined {
  if (!Object.hasOwn(model.runs, run)) return undefined;
  const own = model.runs[run] as InspectRunSkeleton;
  const ids = new Set<string>([run]);
  if (own.session !== undefined && Object.hasOwn(model.bySession, own.session)) {
    for (const id of model.bySession[own.session] as string[]) ids.add(id);
  }
  for (const [id, skeleton] of Object.entries(model.runs)) {
    if (skeleton.continues === run) ids.add(id);
  }
  const out = new Map<string, readonly RunRow[]>();
  for (const id of ids) {
    const skeleton = Object.hasOwn(model.runs, id) ? model.runs[id] : undefined;
    if (skeleton !== undefined) out.set(id, [rowOf(id, skeleton)]);
  }
  return out;
}

/** The runs `run` started, from the model, in the order they appeared. */
export function childrenFromModel(model: InspectModel, run: string): readonly string[] {
  return Object.hasOwn(model.children, run) ? [...(model.children[run] as string[])] : [];
}

/** The runs that served work item `wi`, newest first, at most `limit`. */
export function runsOfWork(model: InspectModel, wi: string, limit: number): readonly string[] {
  const all = Object.hasOwn(model.byWork, wi) ? (model.byWork[wi] as string[]) : [];
  return [...all].reverse().slice(0, limit);
}
