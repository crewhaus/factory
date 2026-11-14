/**
 * Harnesses through the API: the fleet's overview rows, one harness, what it can do and
 * how it is. Every row is a direct fold of the harness's own records (no projection is
 * written by a read); a fleet list counts only the harnesses the caller may read.
 */
import {
  CAPABILITY_NAMES,
  type CapabilityDescriptor,
  type HarnessDisplayState,
  RUN_CONTROL_KEYS,
  type RunControlShape,
  SHAPE_RUN_CONTROLS,
} from "@crewhaus/control-contract";
import {
  controlPaths,
  readApproverProjection,
  readDeployments,
  readOperatorRecord,
} from "@crewhaus/control-records";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { pendingApprovalCount } from "../approvals";
import { readTextCapped } from "../jsonl";
import { resolveContained } from "../safety";
import type { DaemonStatus, V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { emptyOf, fleetSnapshot } from "./lists";
import { harnessOf, liveDirOf, visibleHarnesses } from "./resolve";

type Beat = {
  readonly at?: string;
  readonly paused?: boolean;
  readonly disabled?: boolean;
  readonly runLedger?: boolean;
  readonly activeRuns?: number | null;
};

/** The daemon's last heartbeat, read contained and capped; `undefined` when none is there. */
export function heartbeatOf(dir: string): Beat | undefined {
  const path = resolveContained(dir, controlPaths(dir).heartbeatFile);
  if (path === undefined) return undefined;
  const { text } = readTextCapped(path, 16 * 1024);
  if (text === "") return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Beat) : undefined;
  } catch {
    return undefined;
  }
}

async function displayOf(ctx: V1Context, entry: HangarHarnessEntry, dir: string | undefined) {
  if (dir === undefined) {
    return { state: "disconnected" as HarnessDisplayState, enforcement: "enforced" as const };
  }
  const operator = readOperatorRecord(dir);
  const record = operator.state === "present" ? operator.record : undefined;
  const daemon = await ctx.deps.daemonState(entry);
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

/** One harness's overview row. */
export async function overviewOf(ctx: V1Context, entry: HangarHarnessEntry) {
  const dir = liveDirOf(entry);
  const deployments = dir === undefined ? undefined : readDeployments(dir);
  const active = deployments?.state === "present" ? deployments.active : undefined;
  const artifact = active?.["artifact"] as { specHash?: unknown } | undefined;
  const projection = dir === undefined ? undefined : readApproverProjection(dir);
  const owner = projection?.state === "present" ? projection.projection.owner : undefined;
  const beat = dir === undefined ? undefined : heartbeatOf(dir);
  return {
    id: entry.id,
    slug: entry.slug ?? entry.specName,
    ...(typeof owner === "string" ? { owner } : {}),
    createdAt: entry.registeredAt,
    display: await displayOf(ctx, entry, dir),
    ...(typeof artifact?.specHash === "string" ? { deployedSpecHash: artifact.specHash } : {}),
    ...(active !== undefined ? { activeDeployment: String(active["id"]) } : {}),
    ...(dir !== undefined ? { openDecisions: pendingApprovalCount(dir) } : {}),
    ...(typeof beat?.at === "string" ? { lastVerifiedContactAt: beat.at } : {}),
    asOf: new Date(ctx.deps.now()).toISOString(),
    freshness: "direct-fold" as const,
  };
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
  for (const entry of visible.slice(0, limit)) items.push(await overviewOf(ctx, entry));
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
  return { status: 200, body: await overviewOf(ctx, entry), scrubDir: liveDirOf(entry) };
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

const capabilities: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOf(entry);
  const status: DaemonStatus =
    dir === undefined
      ? { ok: false, reason: "the harness folder is missing" }
      : await ctx.deps.daemonStatus(entry);
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
  const status = dir === undefined ? undefined : await ctx.deps.daemonStatus(entry);
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
