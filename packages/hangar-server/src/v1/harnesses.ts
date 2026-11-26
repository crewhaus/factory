/**
 * Harnesses through the API: the fleet's overview rows, one harness, what it can do and
 * how it is. A row's records part comes from the harness's overview read model, caught up
 * in memory, or a bounded fold of its records when there is none (no read writes a
 * projection); a fleet list counts only the harnesses the caller may read.
 *
 * A row also names the purpose its spec declares (`intent.purpose`) and its owner's
 * display name, each absent when there is none to show. One harness's row says what the
 * caller may do there (`you`), from Home's access records, so a control the caller may
 * not use is shown with its reason instead of failing when pressed.
 */
import {
  APPROVAL_ID_RE,
  CAPABILITY_NAMES,
  type CapabilityDescriptor,
  type HarnessDisplayState,
  RUN_CONTROL_KEYS,
  type RunControlShape,
  SHAPE_RUN_CONTROLS,
} from "@crewhaus/control-contract";
import {
  type Heartbeat,
  readApproverProjection,
  readHeartbeat,
  readOperatorRecord,
} from "@crewhaus/control-records";
import {
  OVERVIEW_PROJECTION,
  RUN_ADAPTER_SHAPES,
  operatorStateOf,
  readModel,
  runBundleRefusal,
  servedOverview,
} from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { parseYamlOnly } from "@crewhaus/spec-patch/commit";
import { pendingApprovalsOf } from "../approvals";
import { ATTENTION_PROJECTION, attentionCountsOf } from "./attention";
import { readSpecText } from "./budget";
import type { DaemonStatus, V1Context, V1Handler } from "./context";
import { type DecidedByReader, decidedByReader } from "./decided-by";
import { V1Error } from "./errors";
import { emptyOf, fleetSnapshot } from "./lists";
import { harnessOf, liveDirOf, visibleHarnesses } from "./resolve";

/** The daemon's last heartbeat, read contained and capped; `undefined` when none is there. */
export function heartbeatOf(dir: string): Partial<Heartbeat> | undefined {
  return readHeartbeat(dir);
}

/** A harness's display state: what its operator record and its daemon say now. Reads only. */
export async function displayOf(
  ctx: V1Context,
  entry: HangarHarnessEntry,
  dir: string | undefined,
) {
  if (dir === undefined) {
    return { state: "disconnected" as HarnessDisplayState, enforcement: "enforced" as const };
  }
  const operator = readOperatorRecord(dir);
  const record = operator.state === "present" ? operator.record : undefined;
  const daemon = await ctx.deps.observedDaemonState(entry);
  const beat = daemon === "running" || daemon === "draining" ? heartbeatOf(dir) : undefined;
  const disabled = operator.state === "unreadable" || record?.deployment?.disabled === true;
  const paused = operator.state === "unreadable" || record?.intake?.paused === true;
  let state: HarnessDisplayState;
  if (disabled) state = "disabled";
  else if (daemon === "draining") state = "draining";
  else if (paused && (daemon === "running" || daemon === "starting")) state = "paused";
  else if (daemon === "running" || daemon === "starting") state = "running";
  else if (daemon === "crashed") state = "crashed";
  else if (daemon === "unknown") state = "disconnected";
  else state = "stopped";
  // A control a running daemon has not confirmed is recorded, not yet enforced.
  const live = daemon === "running" || daemon === "draining" || daemon === "starting";
  const unconfirmed =
    live && ((paused && beat?.paused !== true) || (disabled && beat?.disabled !== true));
  return {
    state,
    enforcement: unconfirmed ? ("recorded-not-enforced" as const) : ("enforced" as const),
  };
}

/** The most of a purpose a row carries: what the spec's `intent.purpose` allows. */
const PURPOSE_MAX = 500;

/** The purpose a harness's spec declares, trimmed; `undefined` when none or unreadable. */
export function purposeOf(dir: string): string | undefined {
  const text = readSpecText(dir);
  if (text === undefined) return undefined;
  let doc: unknown;
  try {
    doc = parseYamlOnly(text);
  } catch {
    return undefined;
  }
  const intent = (doc as { intent?: unknown } | null)?.intent;
  if (typeof intent !== "object" || intent === null) return undefined;
  const purpose = (intent as { purpose?: unknown }).purpose;
  if (typeof purpose !== "string") return undefined;
  const trimmed = purpose.trim();
  return trimmed === "" || trimmed.length > PURPOSE_MAX ? undefined : trimmed;
}

/** The permissions behind each control a harness's header offers, by the key `you` answers. */
export const YOU_PERMISSIONS = {
  control: "h.control",
  deploy: "h.deploy",
  retire: "h.retire",
  accessView: "h.access.view",
  budgetExtend: "h.budget.extend",
  delegationPropose: "h.delegation.propose",
} as const;

/**
 * One harness's overview row: its records' part from the overview read model, caught up
 * (or folded on the spot when there is none), and what the daemon is doing now. A missing
 * folder says only that its operator state is unknown.
 */
export async function overviewOf(
  ctx: V1Context,
  entry: HangarHarnessEntry,
  names: DecidedByReader = decidedByReader(ctx),
) {
  const dir = liveDirOf(entry);
  const now = ctx.deps.now();
  const model =
    dir === undefined
      ? undefined
      : readModel(ctx.deps.hangarRoot, entry.id, dir, OVERVIEW_PROJECTION, now);
  const projection = dir === undefined ? undefined : readApproverProjection(dir);
  const owner = projection?.state === "present" ? projection.projection.owner : undefined;
  const records =
    model === undefined
      ? { operatorState: operatorStateOf(undefined, undefined) }
      : servedOverview(model.state);
  // Tool approvals are counted from the approvals file, where every daemon parks them and
  // where Home's other surfaces count them (a relocated session root included); the other
  // open decisions come from the decision records. A sessions folder outside the harness
  // makes the count unknown: the row says so and carries no count.
  const pending = dir === undefined || model === undefined ? undefined : pendingApprovalsOf(dir);
  const approvalsUnreachable = dir !== undefined && model !== undefined && pending === undefined;
  const openDecisions =
    pending === undefined || model === undefined
      ? undefined
      : pending + Object.keys(model.state.open).filter((id) => !APPROVAL_ID_RE.test(id)).length;
  // An area's own overview projections, beside the core's.
  const areas: Record<string, unknown> = {};
  if (dir !== undefined) {
    for (const { area, projection: other } of ctx.projections) {
      if (other.overview !== true || area === "core") continue;
      const read = readModel(ctx.deps.hangarRoot, entry.id, dir, other, now);
      // Attention counts the Advisor's findings Home gathered too, so every band is whole.
      const shown =
        other === (ATTENTION_PROJECTION as unknown)
          ? attentionCountsOf(ctx.deps.hangarRoot, entry.id, dir, read.state, now)
          : other.served === undefined
            ? read.state
            : other.served(read.state, dir, now);
      areas[area] = { ...((areas[area] as object | undefined) ?? {}), [other.name]: shown };
    }
  }
  const ownerLabel = names.labelOf(owner);
  const purpose = dir === undefined ? undefined : purposeOf(dir);
  return {
    id: entry.id,
    slug: entry.slug ?? entry.specName,
    ...(typeof owner === "string" ? { owner } : {}),
    ...(ownerLabel !== undefined ? { ownerLabel } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
    createdAt: entry.registeredAt,
    display: await displayOf(ctx, entry, dir),
    ...(approvalsUnreachable ? withoutCount(records) : records),
    ...(openDecisions !== undefined ? { openDecisions } : {}),
    ...(approvalsUnreachable ? { approvalsUnreachable: true as const } : {}),
    ...(Object.keys(areas).length > 0 ? { areas } : {}),
    asOf: new Date(now).toISOString(),
    ...(model !== undefined ? { stale: model.stale } : {}),
    freshness: model?.freshness ?? ("direct-fold" as const),
  };
}

/** The records' part of a row without its decision count: a count that cannot be whole. */
function withoutCount(records: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { openDecisions: _unknown, ...rest } = records;
  return rest;
}

function epochOf(ctx: V1Context): number {
  const read = ctx.deps.home.signIn.snapshot();
  return read.state === "present" ? read.snapshot.epoch : 0;
}

const list: V1Handler = async (ctx) => {
  if (ctx.query["cursor"] !== undefined) {
    throw new V1Error({
      status: 400,
      code: "invalid",
      reason: "cursor",
      message: "This list is one page; it takes no cursor.",
    });
  }
  const limitText = ctx.query["limit"];
  const limit = limitText === undefined ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new V1Error({
      status: 400,
      code: "invalid",
      reason: "limit",
      message: "limit is 1 to 500.",
    });
  }
  const snapshotAt = fleetSnapshot(epochOf(ctx));
  const visible = [...visibleHarnesses(ctx.deps)].sort((a, b) => (a.id < b.id ? -1 : 1));
  const items = [];
  const names = decidedByReader(ctx);
  for (const entry of visible.slice(0, limit)) items.push(await overviewOf(ctx, entry, names));
  const total = ctx.deps.registry.list().filter((e) => e.archived === undefined).length;
  return {
    status: 200,
    body: {
      items,
      snapshotAt,
      ...(visible.length > limit
        ? { truncated: { reason: "page_limit", verb: "crewhaus harness list" } }
        : {}),
      ...emptyOf(
        items,
        total > 0 ? "no-access" : "no-data",
        total > 0
          ? "Ask the owner of this Home for access to a harness."
          : "Register one with `crewhaus harness add <dir>`.",
      ),
    },
  };
};

const get: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  // What the header offers: each control, by whether Home's access records allow it here.
  const you: Record<string, boolean> = {};
  for (const [key, permission] of Object.entries(YOU_PERMISSIONS)) {
    you[key] = ctx.access.authorize(permission, { harness: entry.id }).allow;
  }
  return {
    status: 200,
    body: { ...(await overviewOf(ctx, entry)), you },
    scrubDir: liveDirOf(entry),
  };
};

const NOT_RUNNING = "The daemon is not running, so it cannot say what this build supports.";

function fromDaemon(
  key: string,
  shape: CapabilityDescriptor | undefined,
  status: DaemonStatus,
): CapabilityDescriptor {
  if (shape !== undefined && shape.supported === false) return shape;
  if (!status.ok) return { supported: "unknown", reason: NOT_RUNNING };
  const said = status.body["capabilities"];
  if (!Array.isArray(said)) {
    return { supported: "unknown", reason: "This build does not say what it supports." };
  }
  return said.includes(key)
    ? { supported: true }
    : { supported: false, reason: "This build does not support it.", verb: null };
}

/**
 * `runs.create` for one harness, from the run adapter its shape has: a managed daemon
 * answers for itself (a daemon that is not running is "unknown"); a job shape's build must
 * be one that checks a run's input where the run starts; every other shape names its own
 * intake.
 */
function runsCreateOf(
  entry: HangarHarnessEntry,
  dir: string | undefined,
  status: DaemonStatus,
  shape: CapabilityDescriptor | undefined,
): CapabilityDescriptor {
  const adapter = RUN_ADAPTER_SHAPES[entry.target as RunControlShape];
  if (adapter === undefined || adapter === "daemon" || shape === undefined) {
    return shape?.supported === false
      ? shape
      : {
          supported: false,
          reason: `A ${entry.target} harness does not start runs this way.`,
          verb: null,
        };
  }
  if (dir === undefined) return { supported: "unknown", reason: "The harness folder is missing." };
  // The build is read first: a managed daemon that is offline still has a build on disk.
  const old = runBundleRefusal(dir, entry.target);
  if (old !== undefined) {
    return { supported: false, reason: old.message, verb: old.verb ?? "crewhaus compile" };
  }
  if (adapter === "managed") {
    if (!status.ok) return { supported: "unknown", reason: "The executor is offline." };
    return fromDaemon("runs.create", shape, status);
  }
  return { supported: true };
}

const capabilities: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOf(entry);
  const status: DaemonStatus =
    dir === undefined
      ? { ok: false, reason: "the harness folder is missing" }
      : await ctx.deps.observedDaemonStatus(entry);
  const row = (
    SHAPE_RUN_CONTROLS as Readonly<Record<string, Record<string, CapabilityDescriptor>>>
  )[entry.target as RunControlShape];
  const out: Record<string, CapabilityDescriptor> = {};
  for (const key of RUN_CONTROL_KEYS) {
    const shape =
      row?.[key] ??
      ({
        supported: false,
        reason: `A ${entry.target} harness has no run controls.`,
        verb: null,
      } as const);
    out[key] = fromDaemon(key, shape, status);
  }
  // Starting a run: the adapter table decides, the one admission reads too.
  out["runs.create"] = runsCreateOf(entry, dir, status, row?.["runs.create"]);
  out["runs.clientRunId"] =
    RUN_ADAPTER_SHAPES[entry.target as RunControlShape] === "managed"
      ? fromDaemon("runs.clientRunId", undefined, status)
      : {
          supported: false,
          reason: "Only a managed daemon takes a client's own run id.",
          verb: null,
        };
  const beat = dir === undefined ? undefined : heartbeatOf(dir);
  out["runs.ledger"] =
    beat?.runLedger === false
      ? {
          supported: false,
          reason: "Run tracking is off for this harness.",
          verb: null,
        }
      : fromDaemon("runs.ledger", undefined, status);
  out["decisions.consumeChecks"] = {
    supported: "unknown",
    reason: "This build does not report how it checks a grant before using it.",
  };
  out["events.trace"] = {
    supported: "unknown",
    reason: "This build does not report whether it records a trace.",
  };
  for (const provider of ctx.capabilityProviders) {
    if ((CAPABILITY_NAMES as readonly string[]).includes(provider.key)) {
      out[provider.key] = await provider.answer(entry, ctx);
    }
  }
  return { status: 200, body: { harness: entry.id, capabilities: out }, scrubDir: dir };
};

const health: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOf(entry);
  const beat = dir === undefined ? undefined : heartbeatOf(dir);
  const at = beat?.at === undefined ? Number.NaN : Date.parse(beat.at);
  const status = dir === undefined ? undefined : await ctx.deps.observedDaemonStatus(entry);
  return {
    status: 200,
    body: {
      harness: entry.id,
      ...(Number.isNaN(at) ? {} : { heartbeatAgeMs: Math.max(0, ctx.deps.now() - at) }),
      ...(status !== undefined ? { controlReachable: status.ok } : {}),
      ...(typeof beat?.activeRuns === "number" ? { backlog: beat.activeRuns } : {}),
      ...(dir === undefined ? { recovery: "The harness folder is missing." } : {}),
    },
    scrubDir: dir,
  };
};

export const HARNESS_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "harnesses.list": list,
  "harnesses.get": get,
  "harnesses.capabilities": capabilities,
  "harnesses.health": health,
};
