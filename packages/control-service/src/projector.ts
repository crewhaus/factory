/**
 * Home's read models (#507, #513): projections folded from a harness's control records
 * into `<hangarRoot>/cache/index/<hrn>/<name>.json`, and the fleet's change log beside
 * them. Everything here is rebuilt from records: delete `cache/index/` and the next pass
 * writes it again, the same apart from when it was written.
 *
 * - A projection names its sources (ledgers, read through `resume`) and a fold. A pass
 *   resumes from the cursor it saved; a reset or an eviction in a source rebuilds it from
 *   the start of what is retained. Nothing is written when nothing moved.
 * - Only the projector writes. A read takes the saved state and folds, in memory, the
 *   lines past its cursor, or folds from the start when there is no projection; no read
 *   builds or writes one.
 * - The fleet change log gets one line per change a pass observes in a harness's
 *   overview: an operator move, an activation, a run's state, a decision opened or
 *   decided, and contact turning fresh or stale. A first projection is a baseline and
 *   logs nothing.
 * - `nudge` moves a harness to the front of the next pass, in this process; another
 *   process leaves a marker (`writeNudgeMarker`) that the next pass takes.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type CursorSources,
  EVENT_TAXONOMY,
  type EventType,
  HARNESS_ID_RE,
  MACHINES,
  canTransition,
  encodeCursor,
  parseRef,
} from "@crewhaus/control-contract";
import {
  type Heartbeat,
  type LedgerRecord,
  type OperatorRead,
  type RecordSource,
  type ResumeAnswer,
  type ResumeCaps,
  type ResumeItem,
  type ResumeSources,
  appendFleetChanges,
  createOperatorReader,
  decisionsLedger,
  deploymentsLedger,
  keepFleetSegments,
  positionsAtEnd,
  projectionRel,
  readHeartbeat,
  readIndexRecord,
  resume,
  runsLedger,
  takeNudgeMarkers,
  writeIndexRecord,
  writeNudgeMarker,
} from "@crewhaus/control-records";
import { DECISION_LOG_DIR } from "@crewhaus/session-store";
import { APPROVAL_LOG_EVENTS, stateEventOf } from "./event-map";

/**
 * A harness's decision log as a read source, rooted at the harness itself: every path
 * under it, `.crewhaus/sessions` included, is realpath-contained in the harness, so a
 * read of it sees that harness's own decision log and no other's. For reads only; it
 * takes no lock and no claim.
 *
 * First consumers: {@link OVERVIEW_PROJECTION} and Home's harness event stream.
 */
export function harnessApprovalsSource(harnessDir: string): RecordSource {
  return {
    root: harnessDir,
    records: { dir: join(".crewhaus", "sessions", DECISION_LOG_DIR) },
  };
}

// ---------------------------------------------------------------------------
// The operator state (what a harness's operator record and its daemon's beat say)
// ---------------------------------------------------------------------------

export type OperatorState = "unreadable" | "disabled" | "paused" | "enabled" | "unknown";

/**
 * A harness's operator state, from its daemon's last beat and its operator record, in
 * this order:
 *
 * 1. the beat says the daemon could not read its operator record: `unreadable`, whatever
 *    else the beat or the record says;
 * 2. the record cannot be read here: `unreadable`;
 * 3. the record is there: `disabled`, `paused`, or `enabled`, from its deployment and
 *    intake blocks;
 * 4. there is no record: what the beat says, or `enabled` with no beat (no record is the
 *    daemon's own default);
 * 5. nothing could be read at all (no harness directory): `unknown`.
 *
 * Pure.
 */
export function operatorStateOf(
  beat: Partial<Heartbeat> | undefined,
  operator: OperatorRead | undefined,
): OperatorState {
  if (beat?.operatorUnreadable === true) return "unreadable";
  if (operator === undefined) return "unknown";
  if (operator.state === "unreadable") return "unreadable";
  if (operator.state === "present") {
    if (operator.record.deployment?.disabled === true) return "disabled";
    if (operator.record.intake?.paused === true) return "paused";
    return "enabled";
  }
  if (beat === undefined) return "enabled";
  if (beat.disabled === true) return "disabled";
  if (beat.paused === true) return "paused";
  return "enabled";
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * One read model of one harness. `fold` is handed the pass's own copy of the state, so it
 * may update it in place and return it; it reads nothing but the item. `refresh` adds what
 * no ledger holds (the operator record, the beat): it answers the same object when nothing
 * changed.
 */
export type Projection<S = unknown> = {
  readonly name: string;
  /** Served on the harness's overview rows under `areas.<area>`. */
  readonly overview?: true;
  empty(): S;
  fold(state: S, item: ResumeItem): S;
  sources(harnessDir: string): ResumeSources;
  refresh?(state: S, harnessDir: string, now: number): S;
};

/** At most this many run ids are kept by a model; past it the oldest-seen go first. */
export const RUN_MODEL_MAX = 20_000;

/** A run ledger's own fields, never part of a run as served. */
export const RUN_BOOKKEEPING: ReadonlySet<string> = new Set(["claim", "gen", "repaired"]);

/** A daemon's beat is fresh contact for this long: three of its 15-second beats. */
export const CONTACT_FRESH_MS = 45_000;

/** A run row as served: its newest row, the ledger's own fields left out. */
export function servedRunRow(record: LedgerRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record)) {
    if (!RUN_BOOKKEEPING.has(name)) out[name] = value;
  }
  return out;
}

export type RunsState = {
  /** The newest row of each run, by id, oldest-seen first. */
  rows: Record<string, Record<string, unknown>>;
  /** Some run ids were dropped past {@link RUN_MODEL_MAX}. */
  truncated?: true;
};

/** Keep `id` in a capped map: an id past the cap pushes the oldest-seen one out. */
function capped<T>(map: Record<string, T>, id: string, value: T): boolean {
  let dropped = false;
  if (!Object.hasOwn(map, id)) {
    const keys = Object.keys(map);
    if (keys.length >= RUN_MODEL_MAX) {
      delete map[keys[0] as string];
      dropped = true;
    }
  }
  map[id] = value;
  return dropped;
}

/** `runs`: the newest row per run, as `runs.get` serves it. */
export const RUNS_PROJECTION: Projection<RunsState> = {
  name: "runs",
  empty: () => ({ rows: {} }),
  sources: (dir) => ({ runs: runsLedger(dir) }),
  fold(state, item) {
    if (item.kind !== "line") return state;
    const id = item.record["id"];
    if (typeof id !== "string") return state;
    if (capped(state.rows, id, servedRunRow(item.record))) state.truncated = true;
    return state;
  },
};

export type OverviewState = {
  /** Each run's newest state, by id, oldest-seen first. */
  runStates: Record<string, string>;
  lastRun?: { id: string; state: string; at?: string };
  /** Each deployment's state and spec hash, by id. */
  deployments: Record<string, { state: string; specHash?: string; activatedAt?: string }>;
  /** Open decisions, tool approvals and `dec_` ones, by id. */
  open: Record<string, true>;
  operatorState: OperatorState;
  heartbeatAt?: string;
  contact: "fresh" | "stale" | "none";
  truncated?: true;
};

/** Whether a machine allows a row's state after the one before it, as a fold judges it. */
function legalMove(machine: "deployment" | "decision", from: string | undefined, to: string) {
  return from === undefined
    ? (MACHINES[machine].entry as readonly string[]).includes(to)
    : canTransition(machine, from, to);
}

const OPEN_APPROVAL_EVENTS: ReadonlySet<string> = new Set(["park", "defer"]);

/** This module's own reader of operator records, asked with `refresh`: always read now. */
const operatorNow = createOperatorReader();

function contactOf(at: string | undefined, now: number): OverviewState["contact"] {
  if (at === undefined) return "none";
  const when = Date.parse(at);
  if (Number.isNaN(when)) return "none";
  return now - when <= CONTACT_FRESH_MS ? "fresh" : "stale";
}

/**
 * `overview`: what a harness's overview row reads from its records: the active
 * deployment and its spec hash, run counts by state and the last run, the open
 * decisions, the operator state and the daemon's last beat.
 */
export const OVERVIEW_PROJECTION: Projection<OverviewState> = {
  name: "overview",
  empty: () => ({
    runStates: {},
    deployments: {},
    open: {},
    operatorState: "unknown",
    contact: "none",
  }),
  sources: (dir) => ({
    runs: runsLedger(dir),
    deployments: deploymentsLedger(dir),
    decisions: decisionsLedger(dir),
    approvals: harnessApprovalsSource(dir),
  }),
  fold(state, item) {
    if (item.kind !== "line") return state;
    const record = item.record;
    switch (item.source) {
      case "runs": {
        const id = record["id"];
        const run = record["state"];
        if (typeof id !== "string" || typeof run !== "string") return state;
        if (capped(state.runStates, id, run)) state.truncated = true;
        const at = typeof record["at"] === "string" ? record["at"] : undefined;
        state.lastRun = { id, state: run, ...(at !== undefined ? { at } : {}) };
        return state;
      }
      case "deployments": {
        const id = record["id"];
        const to = record["state"];
        if (typeof id !== "string" || typeof to !== "string") return state;
        const prior = state.deployments[id];
        if (!legalMove("deployment", prior?.state, to)) return state;
        const artifact = record["artifact"] as { specHash?: unknown } | undefined;
        const specHash =
          typeof artifact?.specHash === "string" ? artifact.specHash : prior?.specHash;
        const activatedAt =
          typeof record["activatedAt"] === "string" ? record["activatedAt"] : prior?.activatedAt;
        state.deployments[id] = {
          state: to,
          ...(specHash !== undefined ? { specHash } : {}),
          ...(activatedAt !== undefined ? { activatedAt } : {}),
        };
        return state;
      }
      case "decisions": {
        const id = record["id"];
        const to = record["state"];
        if (typeof id !== "string" || typeof to !== "string") return state;
        if (to === "pending") state.open[id] = true;
        else delete state.open[id];
        return state;
      }
      case "approvals": {
        const id = record["decision"];
        const event = record["event"];
        if (typeof id !== "string" || typeof event !== "string") return state;
        if (OPEN_APPROVAL_EVENTS.has(event)) state.open[id] = true;
        else delete state.open[id];
        return state;
      }
      default:
        return state;
    }
  },
  refresh(state, dir, now) {
    const beat = readHeartbeat(dir);
    const operatorState = operatorStateOf(beat, operatorNow.refresh(dir));
    const heartbeatAt = typeof beat?.at === "string" ? beat.at : undefined;
    const contact = contactOf(heartbeatAt, now);
    if (
      operatorState === state.operatorState &&
      heartbeatAt === state.heartbeatAt &&
      contact === state.contact
    ) {
      return state;
    }
    const { heartbeatAt: _old, ...rest } = state;
    return {
      ...rest,
      operatorState,
      contact,
      ...(heartbeatAt !== undefined ? { heartbeatAt } : {}),
    };
  },
};

/** The core's projections, in the order a pass writes them. */
export const CORE_PROJECTIONS: readonly Projection<unknown>[] = [
  OVERVIEW_PROJECTION as Projection<unknown>,
  RUNS_PROJECTION as Projection<unknown>,
];

/** What an overview projection serves on a harness's row. */
export function servedOverview(state: OverviewState): Record<string, unknown> {
  const runCounts: Record<string, number> = {};
  for (const run of Object.values(state.runStates)) runCounts[run] = (runCounts[run] ?? 0) + 1;
  let active: string | undefined;
  let activeAt = Number.NEGATIVE_INFINITY;
  for (const [id, deployment] of Object.entries(state.deployments)) {
    if (deployment.state !== "active") continue;
    const at = Date.parse(deployment.activatedAt ?? "");
    const when = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (active === undefined || when >= activeAt) {
      active = id;
      activeAt = when;
    }
  }
  const specHash = active === undefined ? undefined : state.deployments[active]?.specHash;
  return {
    ...(active !== undefined ? { activeDeployment: active } : {}),
    ...(specHash !== undefined ? { deployedSpecHash: specHash } : {}),
    runCounts,
    ...(state.lastRun !== undefined ? { lastRun: state.lastRun } : {}),
    openDecisions: Object.keys(state.open).length,
    operatorState: state.operatorState,
    ...(state.heartbeatAt !== undefined ? { lastVerifiedContactAt: state.heartbeatAt } : {}),
    ...(state.truncated === true ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Projection files and reads
// ---------------------------------------------------------------------------

export type ProjectionFile<S = unknown> = {
  readonly v: 1;
  readonly cursor: CursorSources;
  readonly asOf: string;
  readonly state: S;
};

export type ProjectionRead<S = unknown> =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly file: ProjectionFile<S> }
  | { readonly state: "unreadable"; readonly reason: string };

/** A projection file is a few megabytes at most; past this it is not one. */
const PROJECTION_MAX_BYTES = 64 * 1024 * 1024;

function isCursorSources(value: unknown): value is CursorSources {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (Object.keys(value).length === 0) return true;
  try {
    encodeCursor({ v: 1, kind: "vector", sources: value as CursorSources });
    return true;
  } catch {
    return false;
  }
}

/** One harness's saved projection. Never writes. */
export function readProjection<S = unknown>(
  hangarRoot: string,
  hrn: string,
  name: string,
): ProjectionRead<S> {
  let read: ReturnType<typeof readIndexRecord>;
  try {
    read = readIndexRecord(hangarRoot, projectionRel(hrn, name), PROJECTION_MAX_BYTES);
  } catch (err) {
    return { state: "unreadable", reason: (err as Error).message };
  }
  if (read.state !== "present") return read;
  const { v, cursor, asOf, state } = read.body;
  if (v !== 1 || !isCursorSources(cursor) || typeof asOf !== "string" || state === undefined) {
    return { state: "unreadable", reason: `the ${name} projection of ${hrn} is not one` };
  }
  return { state: "present", file: { v: 1, cursor, asOf, state: state as S } };
}

/** How a read model was served: caught up from a saved projection, or folded on the spot. */
export type ModelRead<S> = {
  readonly state: S;
  readonly freshness: "projection" | "direct-fold";
  /** The fold stopped at its caps: the answer is behind the records. */
  readonly stale: boolean;
};

/** What a read folds in memory past a projection's cursor, or from the start without one. */
export const READ_CAPS: ResumeCaps = { maxLines: 5_000, maxBytes: 8 * 1024 * 1024 };

function needsRebuild(answer: ResumeAnswer): boolean {
  return answer.items.some(
    (item) => item.kind === "reset" || (item.kind === "gap" && item.reason === "evicted"),
  );
}

/** Whether a resume stopped at its caps (some source read as many lines as it may). */
function hitCaps(answer: ResumeAnswer, caps: ResumeCaps): boolean {
  const per = new Map<string, number>();
  for (const item of answer.items) per.set(item.source, (per.get(item.source) ?? 0) + 1);
  return [...per.values()].some((count) => count >= caps.maxLines);
}

function foldAll<S>(projection: Projection<S>, state: S, items: readonly ResumeItem[]): S {
  let out = state;
  for (const item of items) out = projection.fold(out, item);
  return out;
}

/** The projection folded from the start of its sources, in memory, under `caps`. */
export function directFold<S>(
  projection: Projection<S>,
  harnessDir: string,
  now: number,
  caps: ResumeCaps = READ_CAPS,
): ModelRead<S> {
  const answer = resume(projection.sources(harnessDir), undefined, caps);
  let state = foldAll(projection, projection.empty(), answer.items);
  if (projection.refresh !== undefined) state = projection.refresh(state, harnessDir, now);
  return { state, freshness: "direct-fold", stale: hitCaps(answer, caps) };
}

/**
 * A harness's read model as of now: its saved projection with the lines past its cursor
 * folded in memory, or, when there is none (or it no longer fits its records), a fold from
 * the start. A projection already at the end of its sources opens no record file. Never
 * writes.
 */
export function readModel<S>(
  hangarRoot: string,
  hrn: string,
  harnessDir: string,
  projection: Projection<S>,
  now: number,
  caps: ResumeCaps = READ_CAPS,
): ModelRead<S> {
  return (
    caughtUpModel(hangarRoot, hrn, harnessDir, projection, now, caps) ??
    directFold(projection, harnessDir, now, caps)
  );
}

/**
 * A saved projection with the lines past its cursor folded in memory; `undefined` when
 * there is none, it cannot be read, or its records no longer fit its cursor. A projection
 * already at the end of its sources opens no record file. Never writes.
 */
export function caughtUpModel<S>(
  hangarRoot: string,
  hrn: string,
  harnessDir: string,
  projection: Projection<S>,
  now: number,
  caps: ResumeCaps = READ_CAPS,
): ModelRead<S> | undefined {
  const saved = readProjection<S>(hangarRoot, hrn, projection.name);
  if (saved.state !== "present") return undefined;
  const sources = projection.sources(harnessDir);
  let state = structuredClone(saved.file.state);
  let stale = false;
  if (!positionsAtEnd(sources, saved.file.cursor)) {
    const answer = resume(sources, saved.file.cursor, caps);
    if (needsRebuild(answer)) return undefined;
    state = foldAll(projection, state, answer.items);
    stale = hitCaps(answer, caps);
  }
  if (projection.refresh !== undefined) state = projection.refresh(state, harnessDir, now);
  return { state, freshness: "projection", stale };
}

// ---------------------------------------------------------------------------
// Nudges
// ---------------------------------------------------------------------------

const nudged = new Set<string>();

/** The harness a command's target names: `home/harness/<hrn>`, or `<hrn>/<kind>/<id>`. */
export function harnessOfTarget(target: string): string | undefined {
  const parsed = parseRef(target);
  if ("error" in parsed) return undefined;
  const harness = parsed.kind === "harness" ? parsed.id : parsed.scope;
  return HARNESS_ID_RE.test(harness) ? harness : undefined;
}

/**
 * Move a harness to the front of the next projector pass, in this process. `name` is the
 * projection the change touched; every projection of the harness is brought up to date.
 */
export function nudge(name: string, harness: string): void {
  if (HARNESS_ID_RE.test(harness) && name !== "") nudged.add(harness);
}

/**
 * After a command's receipt is written in another process than Home's: leave the marker
 * the next pass takes, for the harness the receipt's target names. With no Home on this
 * machine (its root is not there) there is no one to tell, and nothing is written. A
 * marker that cannot be written is warned about; the command stands.
 */
export function nudgeFromReceipt(
  hangarRoot: string,
  target: string,
  warn: (message: string) => void,
): void {
  const harness = harnessOfTarget(target);
  if (harness === undefined || !existsSync(hangarRoot)) return;
  try {
    const written = writeNudgeMarker(hangarRoot, OVERVIEW_PROJECTION.name, harness);
    if (!written.ok) warn(`control-service: Home was not told of this change: ${written.reason}`);
  } catch (err) {
    warn(`control-service: Home was not told of this change: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

/** What one pass resumes per source of a projection. */
export const PASS_CAPS: ResumeCaps = { maxLines: 20_000, maxBytes: 16 * 1024 * 1024 };

/** How many fleet log segments retention keeps. */
export const FLEET_SEGMENTS_KEPT = 8;

export type ProjectHarness = { readonly id: string; readonly dir: string };

export type ProjectOptions = {
  readonly hangarRoot: string;
  readonly harnesses: readonly ProjectHarness[];
  readonly projections?: readonly Projection<unknown>[];
  readonly now: number;
  readonly caps?: ResumeCaps;
};

export type ProjectReport = {
  /** Harness ids in the order they were projected. */
  readonly order: readonly string[];
  /** `<hrn>/<name>` of each projection written. */
  readonly written: readonly string[];
  /** `<hrn>/<name>` of each projection rebuilt from the start. */
  readonly rebuilt: readonly string[];
  /** Lines appended to the fleet change log. */
  readonly appended: number;
  readonly failed: ReadonlyArray<{ readonly at: string; readonly reason: string }>;
};

type FleetChange = Record<string, unknown>;

/** The fleet lines one harness's overview moving from `before` to `after` stands for. */
function overviewChanges(
  harness: string,
  before: OverviewState,
  after: OverviewState,
  at: string,
): FleetChange[] {
  const out: FleetChange[] = [];
  const line = (type: EventType, fields: Record<string, unknown> = {}): void => {
    out.push({
      v: 1,
      type,
      at,
      ingestedAt: at,
      harness,
      sensitivity: EVENT_TAXONOMY[type].sensitivity,
      ...fields,
    });
  };
  const move = operatorMoveOf(before.operatorState, after.operatorState);
  if (move !== undefined) line(move, { payload: { operatorState: after.operatorState } });
  const activeBefore = servedOverview(before)["activeDeployment"];
  const activeAfter = servedOverview(after)["activeDeployment"];
  if (activeAfter !== undefined && activeAfter !== activeBefore) {
    line("deployment.activated", { deployment: activeAfter });
  }
  for (const [id, state] of Object.entries(after.runStates)) {
    if (before.runStates[id] === state) continue;
    const type = stateEventOf("run", state);
    if (type !== undefined) line(type, { run: id, payload: { state } });
  }
  for (const id of Object.keys(after.open)) {
    if (before.open[id] !== true) line("decision.opened", { decision: id });
  }
  for (const id of Object.keys(before.open)) {
    if (after.open[id] !== true) line("decision.decided", { decision: id });
  }
  const wasFresh = before.contact === "fresh";
  const isFresh = after.contact === "fresh";
  if (wasFresh !== isFresh && after.contact !== "none") {
    line("harness.heartbeat", { payload: { contact: after.contact } });
  }
  return out;
}

/**
 * The `harness.*` event a move between operator states is. Only moves among `disabled`,
 * `paused` and `enabled` have one; a move into or out of `unreadable` or `unknown` is read
 * from the overview.
 */
export function operatorMoveOf(from: OperatorState, to: OperatorState): EventType | undefined {
  const known = new Set<OperatorState>(["disabled", "paused", "enabled"]);
  if (from === to || !known.has(from) || !known.has(to)) return undefined;
  if (to === "disabled") return "harness.disabled";
  if (from === "disabled") return "harness.enabled";
  return to === "paused" ? "harness.paused" : "harness.resumed";
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One projector pass: for each harness, nudged ones first, every projection is resumed
 * from its saved cursor (a reset or an eviction rebuilds it from the start of what is
 * retained) and written whole when it moved; the Home-level `refs` index is written when
 * it moved; the changes the overviews show are appended to the fleet change log, whose
 * retention then keeps its newest {@link FLEET_SEGMENTS_KEPT} segments. A pass with
 * nothing new writes nothing.
 *
 * First consumer: Home's `projector` sweep.
 */
export async function projectOnce(options: ProjectOptions): Promise<ProjectReport> {
  const { hangarRoot, now } = options;
  const projections = options.projections ?? CORE_PROJECTIONS;
  const caps = options.caps ?? PASS_CAPS;
  const at = new Date(now).toISOString();
  const written: string[] = [];
  const rebuilt: string[] = [];
  const failed: Array<{ at: string; reason: string }> = [];
  const changes: FleetChange[] = [];

  const first = new Set<string>([
    ...nudged,
    ...takeNudgeMarkers(
      hangarRoot,
      projections.map((p) => p.name),
    ),
  ]);
  nudged.clear();
  const order = [
    ...options.harnesses.filter((h) => first.has(h.id)),
    ...options.harnesses.filter((h) => !first.has(h.id)),
  ];

  const refs: Record<string, string[]> = {};
  for (const harness of order) {
    for (const projection of projections) {
      const key = `${harness.id}/${projection.name}`;
      try {
        const saved = readProjection(hangarRoot, harness.id, projection.name);
        const sources = projection.sources(harness.dir);
        let state =
          saved.state === "present" ? structuredClone(saved.file.state) : projection.empty();
        let cursor: CursorSources = saved.state === "present" ? saved.file.cursor : {};
        let moved = saved.state !== "present";
        if (saved.state !== "present" || !positionsAtEnd(sources, cursor)) {
          let answer = resume(sources, saved.state === "present" ? cursor : undefined, caps);
          if (needsRebuild(answer)) {
            rebuilt.push(key);
            state = projection.empty();
            answer = resume(sources, undefined, caps);
          }
          state = foldAll(projection, state, answer.items);
          moved ||= answer.items.length > 0 || !sameJson(answer.next, cursor);
          cursor = answer.next;
        }
        if (projection.refresh !== undefined) {
          const refreshed = projection.refresh(state, harness.dir, now);
          moved ||= refreshed !== state;
          state = refreshed;
        }
        if (projection.name === RUNS_PROJECTION.name) {
          for (const id of Object.keys((state as RunsState).rows)) {
            const list = refs[id] ?? [];
            list.push(harness.id);
            refs[id] = list;
          }
        }
        if (projection.name === OVERVIEW_PROJECTION.name && saved.state === "present") {
          changes.push(
            ...overviewChanges(
              harness.id,
              saved.file.state as OverviewState,
              state as OverviewState,
              at,
            ),
          );
        }
        if (!moved) continue;
        const file: ProjectionFile = { v: 1, cursor, asOf: at, state };
        const done = writeIndexRecord(
          hangarRoot,
          projectionRel(harness.id, projection.name),
          file as unknown as Record<string, unknown>,
        );
        if (done.ok) written.push(key);
        else failed.push({ at: key, reason: done.reason });
      } catch (err) {
        failed.push({ at: key, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const savedRefs = readIndexRecord(hangarRoot, "refs.json", PROJECTION_MAX_BYTES);
  const sortedRefs = Object.fromEntries(Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : 1)));
  if (savedRefs.state !== "present" || !sameJson(savedRefs.body["ids"], sortedRefs)) {
    const done = writeIndexRecord(hangarRoot, "refs.json", { v: 1, asOf: at, ids: sortedRefs });
    if (!done.ok) failed.push({ at: "refs", reason: done.reason });
  }

  let appended = 0;
  if (changes.length > 0) {
    const answer = await appendFleetChanges(hangarRoot, changes);
    if (answer.ok) appended = answer.appended;
    else failed.push({ at: "fleet-changes", reason: answer.reason });
  }
  const kept = await keepFleetSegments(hangarRoot, FLEET_SEGMENTS_KEPT);
  if (!kept.ok) failed.push({ at: "fleet-changes", reason: kept.reason });
  return { order: order.map((h) => h.id), written, rebuilt, appended, failed };
}

/**
 * The harnesses a bare run id is recorded in, from the `refs` index: `undefined` when the
 * index is absent or does not name it. Never writes.
 */
export function harnessesOfRun(hangarRoot: string, runId: string): readonly string[] | undefined {
  const read = readIndexRecord(hangarRoot, "refs.json", PROJECTION_MAX_BYTES);
  if (read.state !== "present") return undefined;
  const ids = read.body["ids"];
  if (typeof ids !== "object" || ids === null || Array.isArray(ids)) return undefined;
  const found = (ids as Record<string, unknown>)[runId];
  return Array.isArray(found) && found.every((h) => typeof h === "string")
    ? (found as string[])
    : undefined;
}
