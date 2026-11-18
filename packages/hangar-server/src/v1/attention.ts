/**
 * The attention area in Home (#517, #513): one list of everything that needs a person
 * across the harnesses the caller may read, served read-only from `@crewhaus/attention`.
 *
 * - `attention.list`, `attention.get` and `attention.metrics` read each visible harness's
 *   attention read model (the projection Home's projector keeps, or a fold on the spot
 *   when there is none yet), add the Advisor findings Home last gathered for it, and
 *   group failed runs across those harnesses only. Harnesses are filtered before anything
 *   is counted, so a group never names or counts one the caller may not read.
 * - Tool input and question text (`body`) reach only a caller who may read that harness's
 *   content; the router's one masker masks it on the way out.
 * - A harness whose sessions folder lies outside it is named in `unreachable` whether or
 *   not anything is listed.
 * - No read gathers Advisor findings: the `attention-advisor` sweep does, a few harnesses
 *   a minute, off the request path, and keeps them in Home's index.
 */
import {
  type AdvisorFinding,
  type AttentionProjection,
  type HarnessAttention,
  advisorSnapshotRecord,
  advisorSnapshotRel,
  assembleInbox,
  attentionListBody,
  attentionProjection,
  harnessAttention,
  metricsOf,
  readAdvisorSnapshot,
  windowMs,
} from "@crewhaus/attention";
import {
  ATTENTION_BANDS,
  ATTENTION_ID_RE,
  ATTENTION_KINDS,
  type AttentionItem,
  attentionRef,
  parseRef,
} from "@crewhaus/control-contract";
import { writeIndexRecord } from "@crewhaus/control-records";
import { type Projection, readModel } from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { harnessEnvFacts } from "@crewhaus/harness-supervisor";
import type { Sweep } from "../scheduler-host";
import type { HomePorts } from "../sweeps";
import type { HomeAreaRuntime } from "./areas";
import type { RefResolver, V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { fleetSnapshot } from "./lists";
import { entryOf, liveDirOf, visibleHarnesses } from "./resolve";

/** The env chain as the attention fold asks of it: names, where they are set, the session root. */
const HOME_FACTS = harnessEnvFacts();

/** The attention read model Home's projector keeps, one file per harness. */
export const ATTENTION_PROJECTION: AttentionProjection = attentionProjection(HOME_FACTS);

const iso = (ms: number): string => new Date(ms).toISOString();

/** One harness's items, read from its model as of now, with Home's Advisor findings for it. */
export function harnessAttentionOf(
  hangarRoot: string,
  entry: Pick<HangarHarnessEntry, "id">,
  dir: string,
  now: number,
  content: boolean,
): HarnessAttention {
  const read = readModel(hangarRoot, entry.id, dir, ATTENTION_PROJECTION, now);
  const advisor = readAdvisorSnapshot(hangarRoot, entry.id);
  return harnessAttention(
    read.state,
    {
      harness: entry.id,
      dir,
      now,
      content,
      freshness: { asOf: iso(now), mode: read.freshness, ...(read.stale ? { stale: true } : {}) },
    },
    { facts: HOME_FACTS, ...(advisor !== undefined ? { advisor } : {}) },
  );
}

function invalid(reason: string, message: string): V1Error {
  return new V1Error({ status: 400, code: "invalid", reason, message });
}

/** One of a closed list, or 400 naming the field. */
function oneOf<T extends string>(
  query: Readonly<Record<string, string>>,
  name: string,
  list: readonly T[],
): T | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (!(list as readonly string[]).includes(value)) {
    throw invalid(name, `${name} is one of: ${list.join(", ")}.`);
  }
  return value as T;
}

type Scope = {
  /** The harnesses read, after the caller's visibility and the `harness` filter. */
  readonly harnesses: ReadonlyArray<{ readonly entry: HangarHarnessEntry; readonly dir: string }>;
  /** How many harnesses the caller may read, before the `harness` filter. */
  readonly visible: number;
};

/** The visible harnesses this request reads: filtered BEFORE anything is folded or counted. */
function scopeOf(ctx: V1Context): Scope {
  const visible = visibleHarnesses(ctx.deps);
  const hint = ctx.query["harness"];
  const named = hint === undefined ? undefined : entryOf(ctx.deps, hint);
  const harnesses = visible
    .filter((entry) => hint === undefined || entry.id === named?.id)
    .flatMap((entry) => {
      const dir = liveDirOf(entry);
      return dir === undefined ? [] : [{ entry, dir }];
    });
  return { harnesses, visible: visible.length };
}

function perHarnessOf(ctx: V1Context, scope: Scope, now: number): HarnessAttention[] {
  return scope.harnesses.map(({ entry, dir }) =>
    harnessAttentionOf(ctx.deps.hangarRoot, entry, dir, now, ctx.access.canReadContent(entry.id)),
  );
}

function snapshotAtOf(ctx: V1Context): string {
  const read = ctx.deps.home.signIn.snapshot();
  return fleetSnapshot(read.state === "present" ? read.snapshot.epoch : 0);
}

const list: V1Handler = async (ctx) => {
  const raw = ctx.query["limit"];
  const limit = raw === undefined ? 50 : Number(raw);
  if (ctx.query["cursor"] !== undefined) {
    throw invalid("cursor", "This list is one page and takes no cursor.");
  }
  if (raw !== undefined && (!/^[0-9]{1,3}$/.test(raw) || limit < 1 || limit > 500)) {
    throw invalid("limit", "limit is a whole number from 1 to 500.");
  }
  const kind = oneOf(ctx.query, "kind", ATTENTION_KINDS);
  const band = oneOf(ctx.query, "band", ATTENTION_BANDS);
  const state = oneOf(ctx.query, "state", ["open", "all"] as const) ?? "open";
  const now = ctx.deps.now();
  const scope = scopeOf(ctx);
  const inbox = assembleInbox(perHarnessOf(ctx, scope, now), now, {
    state,
    ...(kind !== undefined ? { kind } : {}),
    ...(band !== undefined ? { band } : {}),
  });
  const names = new Map(
    scope.harnesses.map(({ entry }) => [entry.id, entry.slug ?? entry.specName]),
  );
  return {
    status: 200,
    body: attentionListBody(inbox, {
      limit,
      filtered: kind !== undefined || band !== undefined || ctx.query["harness"] !== undefined,
      visible: scope.visible,
      nameOf: (id) => names.get(id),
      snapshotAt: snapshotAtOf(ctx),
    }),
  };
};

const MISSING = (): V1Error =>
  new V1Error({
    status: 404,
    code: "not_found",
    reason: "attention_unknown",
    message: "No item has that ref here.",
  });

/** The `att_` id a `{ref}` names: the full `home/attention/…` ref or a bare id. */
function idOfRef(raw: string): string | undefined {
  if (ATTENTION_ID_RE.test(raw)) return raw;
  const parsed = parseRef(raw);
  if ("error" in parsed || parsed.kind !== "attention" || parsed.scope !== "home") {
    return undefined;
  }
  return ATTENTION_ID_RE.test(parsed.id) ? parsed.id : undefined;
}

/**
 * One item, found among the harnesses the caller may read only, in any state. An unknown
 * ref and one about a harness the caller may not read answer the same 404.
 */
function findItem(ctx: V1Context, raw: string): { item: AttentionItem; dir?: string } {
  const id = idOfRef(raw);
  if (id === undefined) throw MISSING();
  const now = ctx.deps.now();
  const scope = scopeOf(ctx);
  const inbox = assembleInbox(perHarnessOf(ctx, scope, now), now, { state: "all" });
  const ref = attentionRef(id);
  const item = inbox.all.find((candidate) => candidate.ref === ref);
  if (item === undefined) throw MISSING();
  const dir =
    item.harness === undefined
      ? undefined
      : scope.harnesses.find((h) => h.entry.id === item.harness)?.dir;
  return dir === undefined ? { item } : { item, dir };
}

const get: V1Handler = async (ctx) => {
  const { item, dir } = findItem(ctx, ctx.params["ref"] ?? "");
  return { status: 200, body: item, ...(dir !== undefined ? { scrubDir: dir } : {}) };
};

const metrics: V1Handler = async (ctx) => {
  const since = ctx.query["since"] ?? "30d";
  const span = windowMs(since);
  if (span === undefined) throw invalid("since", "since is a window like 30d, 12h or 90m.");
  const now = ctx.deps.now();
  const scope = scopeOf(ctx);
  const perHarness = perHarnessOf(ctx, scope, now);
  const inbox = assembleInbox(perHarness, now, { state: "all" });
  return {
    status: 200,
    body: {
      ...metricsOf({ items: inbox.all, decisions: inbox.decisions }, { since: now - span, now }),
      harnesses: scope.harnesses.length,
      ...(inbox.unreachable.length > 0 ? { unreachable: inbox.unreachable } : {}),
    },
  };
};

/** `refs.resolve` for `home/attention/att_…`: where the item opens, and its revision. */
const resolveAttention: RefResolver = async (ctx, ref) => {
  const { item, dir } = findItem(ctx, `${ref.scope}/${ref.kind}/${ref.id}`);
  const href = `/#/home/needs-you?item=${ref.id}`;
  const base = ctx.deps.baseUrl;
  return {
    status: 200,
    body: {
      kind: "attention",
      href,
      ...(base !== undefined ? { url: `${base.replace(/\/+$/, "")}${href}` } : {}),
      rev: `${item.state}:${item.evidenceRev}`,
      summary: `An item that needs a person: ${item.kind}`,
    },
    ...(dir !== undefined ? { scrubDir: dir } : {}),
  };
};

// ---------------------------------------------------------------------------
// The Advisor snapshot sweep
// ---------------------------------------------------------------------------

/** How often the sweep runs, and how old a harness's snapshot is before it is gathered again. */
export const ADVISOR_SWEEP_EVERY_MS = 60_000;

/** At most this many harnesses are gathered on one tick. */
export const ADVISOR_SWEEP_PER_TICK = 4;

/**
 * The sweep that keeps each harness's Advisor snapshot: on each tick, at most
 * {@link ADVISOR_SWEEP_PER_TICK} harnesses whose snapshot is older than a minute, oldest
 * first, through Home's `advisorItems` port (it runs the preflight; no read does). A
 * harness whose gathering failed waits a minute before it is tried again, so one that
 * keeps failing never holds back the rest.
 */
export function advisorSnapshotSweep(): Sweep<HomePorts> {
  const tried = new Map<string, number>();
  return {
    name: "attention-advisor",
    everyMs: ADVISOR_SWEEP_EVERY_MS,
    run: async ({ home, now, warn }) => {
      const gather = home.advisorItems;
      if (gather === undefined) return;
      const due = home
        .liveHarnesses()
        .map((harness) => {
          const snapshot = readAdvisorSnapshot(home.hangarRoot, harness.id);
          const at = snapshot === undefined ? Number.NEGATIVE_INFINITY : Date.parse(snapshot.at);
          const last = Math.max(
            Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY,
            tried.get(`${home.hangarRoot}\0${harness.id}`) ?? Number.NEGATIVE_INFINITY,
          );
          return { harness, last };
        })
        .filter(({ last }) => now - last >= ADVISOR_SWEEP_EVERY_MS)
        .sort((a, b) => a.last - b.last || (a.harness.id < b.harness.id ? -1 : 1))
        .slice(0, ADVISOR_SWEEP_PER_TICK);
      for (const { harness } of due) {
        tried.set(`${home.hangarRoot}\0${harness.id}`, now);
        let items: readonly AdvisorFinding[];
        try {
          items = await gather(harness);
        } catch (err) {
          warn(
            `the Advisor findings of ${harness.id} were not gathered: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const written = writeIndexRecord(
          home.hangarRoot,
          advisorSnapshotRel(harness.id),
          advisorSnapshotRecord(iso(now), items),
        );
        if (!written.ok) {
          warn(`the Advisor findings of ${harness.id} were not kept: ${written.reason}`);
        }
      }
    },
  };
}

export const ATTENTION_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "attention.list": list,
  "attention.get": get,
  "attention.metrics": metrics,
};

/** The attention area's entry. */
export const HOME_ATTENTION: HomeAreaRuntime = {
  area: "attention",
  sweeps: [advisorSnapshotSweep()],
  handlers: ATTENTION_HANDLERS,
  refResolvers: { attention: resolveAttention },
  projections: [ATTENTION_PROJECTION as unknown as Projection<unknown>],
};
