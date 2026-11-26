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
  /**
   * What started it, from its first row: the trigger's kind, its lane, the door it came
   * through, the channel's platform and whether a wake did.
   */
  trigger?: string;
  lane?: string;
  via?: string;
  platform?: string;
  synthetic?: true;
  /** A newer row's trigger, while the newest row carries one: the summary reads it first. */
  newestTrigger?: TriggerSkeleton;
  startedAt?: string;
  endedAt?: string;
};

/** A run row's trigger, its codes only. */
export type TriggerSkeleton = {
  kind: string;
  lane?: string;
  via?: string;
  platform?: string;
  synthetic?: true;
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

/** A row's trigger as the skeleton keeps it; `undefined` when it records none. */
function triggerSkeletonOf(value: unknown): TriggerSkeleton | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const t = value as Readonly<Record<string, unknown>>;
  const kind = codeOf(t["kind"]);
  if (kind === undefined) return undefined;
  const lane = codeOf(t["lane"]);
  const via = codeOf(t["via"]);
  const source = t["source"];
  const platform =
    typeof source === "object" && source !== null && !Array.isArray(source)
      ? codeOf((source as Readonly<Record<string, unknown>>)["platform"])
      : undefined;
  return {
    kind,
    ...(lane !== undefined ? { lane } : {}),
    ...(via !== undefined ? { via } : {}),
    ...(platform !== undefined ? { platform } : {}),
    ...(t["synthetic"] === true ? { synthetic: true as const } : {}),
  };
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
  const trigger = triggerSkeletonOf(row["trigger"]);
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
    // The first row's trigger: the one a summary reads when the newest row has none.
    skeleton = { state: runState };
    if (trigger !== undefined) {
      const { kind, ...first } = trigger;
      Object.assign(skeleton, { trigger: kind, ...first });
    }
    state.runs[id] = skeleton;
  } else if (trigger !== undefined) {
    skeleton.newestTrigger = trigger;
  } else {
    Reflect.deleteProperty(skeleton, "newestTrigger");
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
  // The first execution its rows name, as the folds read it.
  const execution = matching(row["execution"], EXECUTION_ID_RE);
  if (execution !== undefined && skeleton.execution === undefined) skeleton.execution = execution;
  const parent = matching(row["parent"], CANONICAL_RUN_ID_RE);
  if (parent !== undefined && skeleton.parent === undefined) {
    skeleton.parent = parent;
    listed(state.children, parent, id);
  }
  const continues = matching(row["continues"], CANONICAL_RUN_ID_RE);
  if (continues !== undefined) skeleton.continues = continues;
  // As the newest row says: the summary reads the state's companions from it.
  const continuedIn = matching(row["continuedIn"], CANONICAL_RUN_ID_RE);
  if (continuedIn !== undefined) skeleton.continuedIn = continuedIn;
  else Reflect.deleteProperty(skeleton, "continuedIn");
  const workItem = matching(row["workItem"], WORK_ID_RE);
  if (workItem !== undefined && skeleton.workItem === undefined) {
    skeleton.workItem = workItem;
    listed(state.byWork, workItem, id);
  }
  const failureClass = codeOf(row["failureClass"]);
  if (failureClass !== undefined) skeleton.failureClass = failureClass;
  else Reflect.deleteProperty(skeleton, "failureClass");
  const decision = codeOf(row["decision"]);
  if (decision !== undefined) skeleton.decision = decision;
  return state;
}

/** A trigger skeleton as a run row records it. */
function triggerRowOf(t: TriggerSkeleton): Readonly<Record<string, unknown>> {
  const { platform, ...rest } = t;
  return { ...rest, ...(platform !== undefined ? { source: { platform } } : {}) };
}

/** A skeleton as the run row `loadRun` reads: the trigger the summary would read. */
function rowOf(id: string, skeleton: InspectRunSkeleton): RunRow {
  const {
    trigger,
    lane,
    via,
    platform,
    synthetic,
    newestTrigger,
    startedAt: _startedAt,
    endedAt: _endedAt,
    ...rest
  } = skeleton;
  const first: TriggerSkeleton | undefined =
    trigger !== undefined
      ? {
          kind: trigger,
          ...(lane !== undefined ? { lane } : {}),
          ...(via !== undefined ? { via } : {}),
          ...(platform !== undefined ? { platform } : {}),
          ...(synthetic === true ? { synthetic } : {}),
        }
      : undefined;
  const shown = newestTrigger ?? first;
  return { id, ...rest, ...(shown !== undefined ? { trigger: triggerRowOf(shown) } : {}) };
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
