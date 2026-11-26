/**
 * What the work and workspace halves of the runtime area share: the harness's spec facts, the
 * command head and caller, a refusal as its error, and the item a ref names. Function
 * declarations only, so either half may be loaded first.
 */
import { ERROR_CODES, type ErrorCode, isId, parseRef } from "@crewhaus/control-contract";
import {
  type WorkCaller,
  type WorkCommandRefusal,
  type WorkHead,
  isServiceActor,
  workRefOf,
} from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { openForReadSync } from "@crewhaus/tool-safety/fs";
import { type WorkSpecFacts, openWorkStore, workSpecFacts } from "@crewhaus/tool-work/work-items";
import { declaredCadences } from "../schedulers";
import { readYamlLoose } from "../yaml-scan";
import type { V1Context } from "./context";
import { V1Error } from "./errors";
import { entryOf, liveDirOf, visibleHarnesses } from "./resolve";

/** The most bytes of a spec this module reads. */
const SPEC_MAX_BYTES = 1024 * 1024;

export type SpecRead = WorkSpecFacts & {
  /** Whether the spec could be read at all. */
  readonly read: boolean;
  readonly schedules: boolean;
};

/** What the harness's spec says about work items, read contained. Never throws. */
export function workSpecOf(dir: string): SpecRead {
  for (const name of ["crewhaus.yaml", "crewhaus.yml"]) {
    const read = openForReadSync(dir, name, { maxBytes: SPEC_MAX_BYTES, followLeafSymlink: false });
    if (!read.ok) continue;
    if (read.truncated) return { tools: false, read: false, schedules: false };
    const cadences = declaredCadences(read.text);
    const schedules =
      cadences.heartbeat !== undefined ||
      cadences.schedule !== undefined ||
      (cadences.scheduleLanes?.length ?? 0) > 0;
    return { ...workSpecFacts(readYamlLoose(read.text)), read: true, schedules };
  }
  return { tools: false, read: false, schedules: false };
}

export function headOf(ctx: V1Context, entry: HangarHarnessEntry, dir: string): WorkHead {
  const spec = workSpecOf(dir);
  return {
    harnessDir: dir,
    harness: entry.id,
    target: entry.target,
    specName: entry.specName,
    ...(spec.read ? { tools: spec.tools } : {}),
    now: ctx.deps.now,
  };
}

/** A person or a service, as the work rules take a caller. */
export function callerOf(ctx: V1Context): WorkCaller {
  const service =
    ctx.access.caller.via === "service" ||
    (ctx.actor !== undefined && isServiceActor(ctx.deps.hangarRoot, ctx.actor));
  return { role: service ? "service" : "person" };
}

/** Accepting, declining and correcting the ranking are a person's acts. */
export function humanOnly(ctx: V1Context, act: string): void {
  if (callerOf(ctx).role === "service") {
    throw new V1Error({
      status: 403,
      code: "forbidden",
      reason: "human_only",
      message: `${act} is a person's act; a service credential cannot do it.`,
    });
  }
}

export function refusalError(refusal: WorkCommandRefusal): V1Error {
  const status =
    refusal.reason === "not_served"
      ? 501
      : ((ERROR_CODES as Readonly<Record<string, { statuses: readonly number[] }>>)[refusal.code]
          ?.statuses[0] ?? 500);
  return new V1Error({
    status,
    code: refusal.code as ErrorCode,
    reason: refusal.reason,
    message: refusal.message,
    ...(refusal.verb !== undefined && refusal.verb !== null ? { verb: refusal.verb } : {}),
    ...(refusal.current !== undefined ? { current: refusal.current } : {}),
    ...(refusal.field !== undefined ? { details: { field: refusal.field } } : {}),
  });
}

export type Located = {
  readonly entry: HangarHarnessEntry;
  readonly dir: string;
  readonly wi: string;
};

export function missingItem(): V1Error {
  return new V1Error({
    status: 404,
    code: "not_found",
    reason: "work_unknown",
    message: "No work item has that ref here.",
  });
}

function holds(dir: string, wi: string): boolean {
  const read = openWorkStore(dir).get(wi);
  return !("ok" in read);
}

/**
 * The work item `{ref}` names, in a harness the caller may read: `<harness>/work/<wi>`, or
 * a bare `wi_…` with `?harness=`. Without either it is 422 `harness_needed` with the
 * harnesses the caller may read that hold it, never a guess.
 */
export function locate(ctx: V1Context): Located {
  const raw = ctx.params["ref"] ?? "";
  const lookIn = (entry: HangarHarnessEntry | undefined, wi: string): Located | undefined => {
    const dir = entry === undefined ? undefined : liveDirOf(entry);
    if (entry === undefined || dir === undefined || !ctx.access.canRead(entry.id)) return undefined;
    return holds(dir, wi) ? { entry, dir, wi } : undefined;
  };
  if (!isId("wi", raw)) {
    const parsed = parseRef(raw);
    if ("error" in parsed || parsed.kind !== "work") throw missingItem();
    const found = lookIn(entryOf(ctx.deps, parsed.scope), parsed.id);
    if (found === undefined) throw missingItem();
    return found;
  }
  const hint = ctx.query["harness"];
  if (hint !== undefined) {
    const found = lookIn(entryOf(ctx.deps, hint), raw);
    if (found === undefined) throw missingItem();
    return found;
  }
  const candidates = visibleHarnesses(ctx.deps)
    .map((entry) => lookIn(entry, raw))
    .filter((f): f is Located => f !== undefined);
  throw new V1Error({
    status: 422,
    code: "invalid",
    reason: "harness_needed",
    message: "Say which harness with ?harness=, or name the item as <harness>/work/<wi>.",
    details: {
      candidates: candidates.map((f) => ({
        kind: "work",
        ref: workRefOf(f.entry.id, raw),
        href: `/#/h/${f.entry.id}/work/items/${raw}`,
      })),
    },
  });
}
