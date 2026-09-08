/**
 * The Models area (0.6.0 design §8.3) — the console's answer to "which model
 * served, under which settings, at what cost, and is the cheap lane winning?"
 *
 * Four reads, no writes. That is the whole posture of this module and it is
 * deliberate:
 *
 *   - **Hangar never writes arms or priors.** `@crewhaus/routing-store` is
 *     opened here purely as a reader (`openScoreboard(...).snapshot()` does
 *     no I/O beyond the initial load, and creates nothing), and every
 *     human-owned edit — the roster, strategy membership, per-profile
 *     permissions, rule targets, the conservative floor — continues to route
 *     through `crewhaus propose` and the spec write path. A console that
 *     could nudge a learned policy would be a second, unlogged operator.
 *   - **Everything is read from the same durable files the CLI reads**:
 *     `crewhaus.yaml` for the registry and the pool, `.crewhaus/routing/`
 *     for arms / freeze / priors, and the session JSONL for the route
 *     timeline. §8.1: Hangar reads the session log, not the bus, so every
 *     kind rendered here is an EVENT-LOG kind with a durable `logEvent`.
 *   - **The spec is read LENIENTLY** (`readYamlLoose`), not through
 *     `parseSpec`: a fleet console must render a harness whose spec is a
 *     schema version ahead of this manager. The same stance `yaml-scan.ts`
 *     documents for credentials and channels.
 *
 * Containment: every path goes through `ctx.contain` (per FILE — a name in
 * `.crewhaus/routing` can be a symlink), and the dispatcher masks + scrubs
 * whatever these handlers return, so a profile whose `model` string carries
 * an inlined key never reaches a browser.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_SUNSETS, findSunset } from "@crewhaus/cost-tracker";
import { resolveBundle } from "@crewhaus/harness-supervisor";
import {
  ROUTE_FREEZE_FILE,
  ROUTING_PRIORS_FILE,
  isObserveOnlyLane,
  openScoreboard,
  readRouteFreeze,
  readRoutingPriorsRaw,
} from "@crewhaus/routing-store";
import { bundleFreshness } from "./bundle-freshness";
import { SAFE_SEGMENT_RE, SESSION_JSONL_RE } from "./constants";
import { foldHarnessCosts } from "./costs";
import { absent, found, num, readJsonAt, safeContain, str } from "./evals-ops";
import { HttpError } from "./http";
import { readJsonlCapped, readTextCapped } from "./jsonl";
import type { M3Context, M3Handler } from "./m3";
import { resolveContained } from "./safety";
import { readSpecYaml } from "./schedulers";
import { resolveSessionRoot } from "./sessions";
import { registryDirName } from "./spec-edit";
import { asRecord, asString, at, readYamlLoose } from "./yaml-scan";

const STATE_DIR = ".crewhaus";
const ROUTING_SUBDIR = "routing";
const ARMS_FILE = "arms.jsonl";

/** Cap for one pinned spec text (only its hash is used). */
const MAX_PIN_BYTES = 1_000_000;

/** The routing kinds this area renders, in the order a turn produces them. */
export const ROUTING_EVENT_KINDS: readonly string[] = [
  "model_directive",
  "model_route",
  "model_tier_route",
  "model_stage",
  "model_failover",
  "judge_verdict",
];

const requireDir = (ctx: M3Context): string => {
  if (ctx.harnessDir === null) throw new HttpError(400, "not a per-harness route");
  return ctx.harnessDir;
};

// ---------------------------------------------------------------------------
// the spec half: the `models:` registry and the pool it feeds
// ---------------------------------------------------------------------------

/** One row of the `models:` profile registry, flattened for the table. */
export type ModelProfileRow = {
  readonly name: string;
  readonly model: string | null;
  /** Settings the profile declares, as `key: rendered-value` pairs. */
  readonly settings: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  /** Keys the profile declares that this manager does not itemise. */
  readonly extraKeys: readonly string[];
};

/** One `model_pool` candidate as declared (never as routed). */
export type PoolCandidateRow = {
  readonly model: string | null;
  readonly profile: string | null;
  readonly tags: readonly string[];
  readonly enabled: boolean;
};

export type PoolView = {
  readonly declared: boolean;
  readonly policy: string | null;
  readonly scope: string | null;
  readonly candidates: readonly PoolCandidateRow[];
  readonly rules: number;
  readonly strategies: readonly string[];
  readonly qualitySource: string | null;
};

/** Scalar settings a profile (or a candidate) may declare, in display order. */
const PROFILE_SETTING_KEYS = [
  "model",
  "thinking",
  "max_tokens",
  "temperature",
  "reasoning_effort",
  "instructions",
  "tools",
  "permissions",
  "tool_config",
  "rate_limits",
  "requires",
] as const;

/** Render a loose-YAML value as one short display string. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => renderValue(v)).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${renderValue(v)}`)
      .join(" ");
  }
  return String(value);
}

/** The `models:` registry, read leniently. Absent block → no rows. */
export function readModelRegistry(yamlText: string): ModelProfileRow[] {
  const models = asRecord(at(readYamlLoose(yamlText), ["models"]));
  if (models === undefined) return [];
  const rows: ModelProfileRow[] = [];
  for (const name of Object.keys(models).sort()) {
    const body = asRecord(models[name]);
    if (body === undefined) {
      // `fast: claude-haiku-4-5` — the shorthand a profile may be written as.
      const model = asString(models[name]);
      rows.push({
        name,
        model: model ?? null,
        settings: model !== undefined ? [{ key: "model", value: model }] : [],
        extraKeys: [],
      });
      continue;
    }
    const settings: Array<{ key: string; value: string }> = [];
    for (const key of PROFILE_SETTING_KEYS) {
      if (!Object.hasOwn(body, key)) continue;
      settings.push({ key, value: renderValue(body[key]) });
    }
    const itemised = new Set<string>(PROFILE_SETTING_KEYS);
    rows.push({
      name,
      model: asString(body["model"]) ?? null,
      settings,
      extraKeys: Object.keys(body)
        .filter((k) => !itemised.has(k))
        .sort(),
    });
  }
  return rows;
}

/** One declared pool plus the spec path of the host that declares it. */
export type DeclaredPool = {
  /** Dotted path to the pool, e.g. `agent.model_pool`, `crew.roles.writer.model_pool`. */
  readonly hostPath: string;
  readonly pool: PoolView;
};

/** The `PoolView` a harness with no `model_pool` anywhere gets. */
const UNDECLARED_POOL: PoolView = {
  declared: false,
  policy: null,
  scope: null,
  candidates: [],
  rules: 0,
  strategies: [],
  qualitySource: null,
};

/** The `agent.model_pool` path, and the pool a single-pool view prefers. */
const AGENT_POOL_PATH = "agent.model_pool";

/**
 * Every `model_pool` the spec declares, at ANY host, in document order.
 *
 * `model_pool` is not an `agent:` field: the schema hangs one off workflow
 * steps, graph nodes, crew roles, sub-agents, channel and managed agents and
 * the batch pipeline too. Reading only `agent.model_pool` makes the console
 * tell a crew or workflow operator "nothing is being routed" while a per-role
 * pool routes every turn — so this walks for the key the same `anywhere`
 * way `SECURITY_SURFACES` in spec-edit.ts already treats `model_pool.rules`.
 * A pool's own subtree is not re-walked: what is under it is candidates and
 * rules, never another pool.
 */
export function readPoolViews(yamlText: string): DeclaredPool[] {
  const out: DeclaredPool[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    const record = asRecord(node);
    if (record === undefined) return;
    for (const [key, value] of Object.entries(record)) {
      const child = path === "" ? key : `${path}.${key}`;
      if (key === "model_pool") {
        const body = asRecord(value);
        if (body !== undefined) out.push({ hostPath: child, pool: buildPoolView(body) });
        continue;
      }
      walk(value, child);
    }
  };
  walk(readYamlLoose(yamlText), "");
  return out;
}

/**
 * The one pool a single-pool view renders: `agent.model_pool` when it exists,
 * otherwise the first pool declared anywhere. `declared: false` only when the
 * spec declares no pool at all — never merely because the pool hangs off a
 * role, a step or a node.
 */
export function readPoolView(yamlText: string): PoolView {
  const pools = readPoolViews(yamlText);
  const agent = pools.find((p) => p.hostPath === AGENT_POOL_PATH);
  return agent?.pool ?? pools[0]?.pool ?? UNDECLARED_POOL;
}

/** One `model_pool` mapping, read leniently. */
function buildPoolView(pool: Record<string, unknown>): PoolView {
  const rawCandidates = pool["candidates"];
  const candidates: PoolCandidateRow[] = Array.isArray(rawCandidates)
    ? rawCandidates.map((entry) => {
        const body = asRecord(entry);
        if (body === undefined) {
          const model = asString(entry);
          return { model: model ?? null, profile: null, tags: [], enabled: true };
        }
        const tags = Array.isArray(body["tags"])
          ? (body["tags"] as unknown[]).map((t) => String(t))
          : [];
        const model = asString(body["model"]) ?? null;
        return {
          model,
          // `$fast` on a candidate's `model` IS the profile reference, and
          // `profile:` is the explicit spelling — either one names the row.
          profile: asString(body["profile"]) ?? (model?.startsWith("$") ? model.slice(1) : null),
          tags,
          enabled: body["enabled"] !== false,
        };
      })
    : [];
  const strategy = asRecord(pool["strategy"]);
  return {
    declared: true,
    policy: asString(pool["policy"]) ?? null,
    scope: asString(pool["scope"]) ?? null,
    candidates,
    rules: Array.isArray(pool["rules"]) ? (pool["rules"] as unknown[]).length : 0,
    strategies: strategy === undefined ? [] : Object.keys(strategy).sort(),
    qualitySource: asString(at(pool, ["reward", "quality_source"])) ?? null,
  };
}

// ---------------------------------------------------------------------------
// the routing store half: arms, freeze, priors, leaderboard
// ---------------------------------------------------------------------------

/**
 * One arm as the console renders it (an `ArmStats` plus its lane verdict).
 *
 * The routing band is served as `band`, not `routeKey`. That is not a taste
 * call: `maskDeep` redacts any camel-case `…Key` field wholesale on the way
 * out, so a field named `routeKey` would reach the browser as
 * `"[redacted]"` with no error — the naming hazard `mask.ts` documents, and
 * the convention it prescribes is to name AROUND the matcher rather than to
 * widen it. `band` is also the column `route explain` already prints.
 */
export type ArmRow = {
  readonly band: string;
  readonly model: string;
  readonly n: number;
  readonly meanReward: number;
  readonly meanQuality: number;
  readonly qualityCount: number;
  readonly meanLatencyMs: number;
  readonly meanCostUsd: number;
  readonly ungraded: number;
  /** True for an observe-only lane (`shadow:` / `quality:` prefixed keys). */
  readonly shadow: boolean;
};

/** The scoreboard, or an honest empty read. Never creates the store. */
export function readArms(ctx: M3Context): { rows: ArmRow[]; path: string | null } {
  const armsPath = safeContain(ctx, [STATE_DIR, ROUTING_SUBDIR, ARMS_FILE]);
  const root = safeContain(ctx, [STATE_DIR]);
  if (armsPath === undefined || root === undefined || !existsSync(armsPath)) {
    return { rows: [], path: armsPath ?? null };
  }
  let snapshot: ReturnType<ReturnType<typeof openScoreboard>["snapshot"]>;
  try {
    snapshot = openScoreboard(root).snapshot();
  } catch (err) {
    ctx.warn(
      `hangar-server: routing scoreboard unreadable at ${armsPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { rows: [], path: armsPath };
  }
  const rows = snapshot.map((a) => ({
    band: a.routeKey,
    model: a.model,
    n: a.n,
    meanReward: a.meanReward,
    meanQuality: a.meanQuality,
    qualityCount: a.qualityCount,
    meanLatencyMs: a.meanLatencyMs,
    meanCostUsd: a.meanCostUsd,
    ungraded: a.ungraded,
    shadow: isObserveOnlyLane(a.routeKey),
  }));
  return { rows, path: armsPath };
}

/** One leaderboard row: an arm plus its standing inside its own bucket. */
export type LeaderboardRow = ArmRow & {
  /** 1-based rank inside `band`, best mean reward first. */
  readonly rank: number;
  /** True for the arm a `learned` policy would exploit in this bucket. */
  readonly best: boolean;
  /** Reward gap to the bucket's best arm (0 for the leader). */
  readonly rewardGap: number;
};

/** Rank arms inside each bucket, best mean reward first. Pure. */
export function buildLeaderboard(rows: readonly ArmRow[]): LeaderboardRow[] {
  const byKey = new Map<string, ArmRow[]>();
  for (const row of rows) {
    const group = byKey.get(row.band) ?? [];
    group.push(row);
    byKey.set(row.band, group);
  }
  const out: LeaderboardRow[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const group = [...(byKey.get(key) ?? [])].sort(
      (a, b) => b.meanReward - a.meanReward || a.model.localeCompare(b.model),
    );
    const leader = group[0];
    group.forEach((row, i) => {
      out.push({
        ...row,
        rank: i + 1,
        best: i === 0 && row.n > 0,
        rewardGap: leader === undefined ? 0 : leader.meanReward - row.meanReward,
      });
    });
  }
  return out;
}

/**
 * The freeze marker in force, or null. A malformed marker reads as absent.
 *
 * The FILE is contained, not just `.crewhaus`: `readRouteFreeze` joins
 * `<root>/routing/freeze.json` itself and reads it with no check of its own,
 * so containing only the state dir would let a symlinked `freeze.json` pull
 * an arbitrary file's shaped fields into the browser. Containment is per
 * file (m3.ts) — a name inside a contained directory is not contained.
 */
function readFreeze(ctx: M3Context): unknown {
  const root = safeContain(ctx, [STATE_DIR]);
  if (root === undefined) return null;
  if (safeContain(ctx, [STATE_DIR, ROUTING_SUBDIR, ROUTE_FREEZE_FILE]) === undefined) return null;
  try {
    return readRouteFreeze(root) ?? null;
  } catch {
    return null;
  }
}

/** `.crewhaus/routing/priors.json`, as a presence + error report. */
function readPriors(ctx: M3Context): {
  present: boolean;
  error: string | null;
  arms: number | null;
} {
  const root = safeContain(ctx, [STATE_DIR]);
  if (root === undefined) return { present: false, error: null, arms: null };
  // Per-FILE containment, for the reason `readFreeze` states: a symlinked
  // `priors.json` would otherwise be read, and its absolute target path
  // returned to the browser inside `raw.error`.
  if (safeContain(ctx, [STATE_DIR, ROUTING_SUBDIR, ROUTING_PRIORS_FILE]) === undefined) {
    return { present: false, error: null, arms: null };
  }
  const raw = readRoutingPriorsRaw(root);
  if (raw === undefined) return { present: false, error: null, arms: null };
  if (!raw.ok) return { present: true, error: raw.error, arms: null };
  const armsBlock = asRecord((raw.raw as { arms?: unknown } | null)?.arms);
  return {
    present: true,
    error: null,
    arms: armsBlock === undefined ? null : Object.keys(armsBlock).length,
  };
}

// ---------------------------------------------------------------------------
// the session half: the route timeline
// ---------------------------------------------------------------------------

/** One durable routing line, flattened for the timeline. */
export type TimelineEntry = {
  readonly line: number;
  readonly kind: string;
  readonly ts: string | null;
  readonly turnNumber: number | null;
  readonly payload: Record<string, unknown>;
};

export type RouteTimeline = {
  readonly entries: readonly TimelineEntry[];
  readonly counts: Readonly<Record<string, number>>;
  readonly truncated: boolean;
};

/**
 * Read one session's routing lines, in file order. Both encodings are
 * accepted (event-log envelope and flat), the same way the cost fold does —
 * a hand-written line must not silently vanish from the timeline.
 */
export function readRouteTimeline(path: string): RouteTimeline {
  const read = readJsonlCapped(path);
  const entries: TimelineEntry[] = [];
  const counts: Record<string, number> = {};
  read.objects.forEach((obj, index) => {
    if (typeof obj !== "object" || obj === null) return;
    const top = obj as { kind?: unknown; ts?: unknown; payload?: unknown };
    const kind = typeof top.kind === "string" ? top.kind : "";
    if (!ROUTING_EVENT_KINDS.includes(kind)) return;
    const raw = (
      typeof top.payload === "object" && top.payload !== null ? top.payload : obj
    ) as Record<string, unknown>;
    // `routeKey` is renamed to `band` for the same reason `ArmRow` carries
    // `band`: `maskDeep` redacts a camel-case `…Key` field wholesale, so the
    // durable field name would reach the browser as `"[redacted]"`.
    const { routeKey, ...rest } = raw;
    const payload: Record<string, unknown> =
      routeKey === undefined ? rest : { ...rest, band: routeKey };
    counts[kind] = (counts[kind] ?? 0) + 1;
    entries.push({
      line: index,
      kind,
      ts: str(top.ts) ?? null,
      turnNumber: num(payload["turnNumber"]) ?? null,
      payload,
    });
  });
  return { entries, counts, truncated: read.truncated };
}

/** Session ids whose log carries at least one routing line, newest first. */
function sessionsWithRouting(dir: string): Array<{ id: string; routingLines: number }> {
  const { root } = resolveSessionRoot(dir);
  const out: Array<{ id: string; routingLines: number }> = [];
  let names: string[];
  try {
    names = readdirSync(root).filter((f) => SESSION_JSONL_RE.test(f));
  } catch {
    return out;
  }
  for (const name of names.sort().reverse()) {
    const path = resolveContained(root, name);
    if (path === undefined) continue;
    const timeline = readRouteTimeline(path);
    if (timeline.entries.length === 0) continue;
    out.push({ id: name.replace(/\.jsonl$/, ""), routingLines: timeline.entries.length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

/**
 * `GET /api/h/:id/models` — the whole area on one payload: the `models:`
 * registry, the declared pool, per-role and per-profile spend folded from
 * the session logs, the learned arms and their leaderboard.
 *
 * An un-pooled harness is NOT an error state: it has a registry (or a single
 * declared model), it has spend, and the honest answer is "no pool declared,
 * so nothing is being learned" rather than an empty screen.
 */
export const modelsOverview: M3Handler = (ctx) => {
  const dir = requireDir(ctx);
  const yamlText = readSpecYaml(dir);
  const registry = readModelRegistry(yamlText);
  // Every declared pool, at whatever host declares it — `pool` is the one a
  // single-pool reader renders (agent's, else the first), `pools` is the set
  // the tab lists so a crew/workflow/graph harness sees its per-role pools.
  const pools = readPoolViews(yamlText);
  const pool = readPoolView(yamlText);
  const costs = foldHarnessCosts(dir, ctx.now());
  const { rows, path } = readArms(ctx);
  const leaderboard = buildLeaderboard(rows);
  const spend = {
    totalUsdMicros: costs.totalUsdMicros,
    calls: costs.calls,
    rollups: costs.rollups,
    byRole: costs.byRole,
    byProfile: costs.byProfile,
    byModel: costs.byModel,
  };
  const note =
    registry.length === 0 && !pool.declared
      ? "no models: registry and no model_pool anywhere in the spec — this harness serves one declared model"
      : rows.length === 0 && pool.declared
        ? "a pool is declared but no arm has been observed yet — run the harness to accumulate learning"
        : null;
  return {
    ...found(note, "crewhaus models list"),
    registry,
    pool,
    pools,
    spend,
    arms: rows,
    leaderboard,
    armsPath: path,
    freeze: readFreeze(ctx),
    priors: readPriors(ctx),
    sessions: sessionsWithRouting(dir),
    guidance:
      pool.declared && pool.policy === "learned"
        ? "the learned policy exploits the starred arm in each band; `crewhaus route freeze` pins it"
        : pool.declared
          ? "flip the pool's policy to `learned` once every arm has enough samples — `crewhaus route propose` mines the scoreboard for that patch"
          : "declare a model_pool to route a turn between candidates; profiles in models: are what each candidate carries",
    asOf: new Date(ctx.now()).toISOString(),
  };
};

/**
 * `GET /api/h/:id/models/routes/:sess` — one run's routing timeline, read
 * from the session JSONL (§8.1: Hangar reads the log, never the bus).
 */
export const modelRoutes: M3Handler = (ctx) => {
  const dir = requireDir(ctx);
  const sessionId = ctx.params["sess"] as string;
  const { root } = resolveSessionRoot(dir);
  const path = resolveContained(root, `${sessionId}.jsonl`);
  if (path === undefined || !existsSync(path)) {
    return {
      ...absent(
        `no session log for "${sessionId}" — the timeline is read from .crewhaus/sessions/<id>.jsonl`,
        "crewhaus sessions list",
      ),
      sessionId,
      entries: [],
      counts: {},
      truncated: false,
      kinds: ROUTING_EVENT_KINDS,
    };
  }
  const timeline = readRouteTimeline(path);
  if (timeline.entries.length === 0) {
    return {
      ...absent(
        "this session recorded no routing decisions — only runs whose spec declares a model_pool, model_tiers or a hybrid strategy persist them",
        "crewhaus route explain",
      ),
      sessionId,
      entries: [],
      counts: {},
      truncated: timeline.truncated,
      kinds: ROUTING_EVENT_KINDS,
    };
  }
  return {
    ...found(
      timeline.truncated ? "the session log hit the read cap — the timeline is a prefix" : null,
      `crewhaus route explain ${sessionId}`,
    ),
    sessionId,
    entries: timeline.entries,
    counts: timeline.counts,
    truncated: timeline.truncated,
    kinds: ROUTING_EVENT_KINDS,
  };
};

/** `GET /api/h/:id/models/arms` — the learned scoreboard, read-only. */
export const modelArms: M3Handler = (ctx) => {
  requireDir(ctx);
  const { rows, path } = readArms(ctx);
  const base =
    rows.length === 0
      ? absent(
          "no routing arms recorded yet — a pooled run accumulates them in .crewhaus/routing/arms.jsonl",
          "crewhaus route status",
        )
      : found(
          "read-only: Hangar never writes an arm; `crewhaus route reset` is the kill switch and `route propose` the patch path",
          "crewhaus route status",
        );
  return {
    ...base,
    arms: rows,
    armsPath: path,
    bands: [...new Set(rows.map((r) => r.band))].sort(),
    freeze: readFreeze(ctx),
    priors: readPriors(ctx),
  };
};

/** `GET /api/h/:id/models/leaderboard` — arms ranked inside each band. */
export const modelLeaderboard: M3Handler = (ctx) => {
  requireDir(ctx);
  const { rows } = readArms(ctx);
  const leaderboard = buildLeaderboard(rows);
  const best = leaderboard.filter((r) => r.best);
  if (leaderboard.length === 0) {
    return {
      ...absent(
        "nothing to rank yet — the leaderboard is the scoreboard grouped by routing band",
        "crewhaus route status",
      ),
      leaderboard,
      best,
      bands: [],
      guidance: "run a pooled harness; each turn folds one observation into its band's arm",
    };
  }
  return {
    ...found(null, "crewhaus route status"),
    leaderboard,
    best,
    bands: [...new Set(leaderboard.map((r) => r.band))].sort(),
    guidance:
      "the starred arm in each band is what a `learned` policy exploits once every arm clears its sample floor; a shadow band observes only",
  };
};

// ---------------------------------------------------------------------------
// the advisor's inputs — folded from the same files the panels above read
// ---------------------------------------------------------------------------

/** Providers a model string may name before its `/`. Anything else is a
 *  model id that happens to contain a slash, and belongs to Anthropic. */
const PROVIDER_PREFIXES = ["anthropic", "openai", "gemini", "bedrock"] as const;

/** Split `openai/gpt-4o` into its pricing/sunset key. A bare id is Anthropic
 *  (the spec's own default), and the `vertex/` / `azure/` / `local/` hosting
 *  prefixes are stripped before the provider is read. */
export function splitModelString(modelString: string): {
  provider: string;
  modelId: string;
} {
  let rest = modelString;
  for (const host of ["vertex/", "azure/", "local/"]) {
    if (rest.startsWith(host)) rest = rest.slice(host.length);
  }
  const slash = rest.indexOf("/");
  if (slash > 0) {
    const head = rest.slice(0, slash);
    if ((PROVIDER_PREFIXES as readonly string[]).includes(head)) {
      return { provider: head, modelId: rest.slice(slash + 1) };
    }
  }
  return { provider: "anthropic", modelId: rest };
}

/**
 * Every model string the spec names, anywhere: `model:` at any depth (so
 * profiles, pool candidates, steps, nodes, roles and sub-agents are all
 * covered by one walk), plus `model_fallbacks` lists and `model_tiers` maps.
 * `$profile` references are NOT model strings and are skipped — the profile
 * they name contributes its own `model:`.
 */
export function rosterModels(yamlText: string): string[] {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    const s = asString(value);
    if (s !== undefined && !s.startsWith("$")) out.add(s);
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = asRecord(node);
    if (record === undefined) return;
    for (const [key, value] of Object.entries(record)) {
      if (key === "model") add(value);
      else if (key === "model_fallbacks" && Array.isArray(value)) for (const v of value) add(v);
      else if (key === "model_tiers") {
        const tiers = asRecord(value);
        if (tiers !== undefined) for (const v of Object.values(tiers)) add(v);
      }
      walk(value);
    }
  };
  walk(readYamlLoose(yamlText));
  return [...out].sort();
}

/** One roster model with a compiled-in retirement date. */
export type RosterSunset = {
  readonly model: string;
  readonly retiresOn: string;
  readonly replacement: string | null;
  readonly past: boolean;
};

/**
 * Sunsets for the spec's roster, from the COMPILED-IN table only (§8.2: a
 * fetched feed may never flip a gate, and this signal is read by the
 * advisor, which the fleet health board scores).
 */
export function rosterSunsets(yamlText: string, nowMs: number): RosterSunset[] {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const out: RosterSunset[] = [];
  for (const model of rosterModels(yamlText)) {
    const { provider, modelId } = splitModelString(model);
    const entry = findSunset(provider, modelId, KNOWN_SUNSETS);
    if (entry === undefined) continue;
    out.push({
      model,
      retiresOn: entry.retiresOn,
      replacement: entry.replacement ?? null,
      past: entry.retiresOn <= today,
    });
  }
  return out;
}

/** Routing volume folded across every session log under the harness. */
export type RouteStats = {
  readonly decisions: number;
  readonly escalations: number;
  readonly stages: number;
  readonly sessions: number;
};

/** Stage names that mean "the cheap lane handed this turn upward". */
const ESCALATION_STAGES = new Set(["escalate", "escalation"]);

/** Fold `model_route` / `model_stage` counts over the harness's session logs. */
export function foldRouteStats(harnessDir: string): RouteStats {
  const { root } = resolveSessionRoot(harnessDir);
  let files: string[];
  try {
    files = readdirSync(root).filter((f) => SESSION_JSONL_RE.test(f));
  } catch {
    return { decisions: 0, escalations: 0, stages: 0, sessions: 0 };
  }
  let decisions = 0;
  let escalations = 0;
  let stages = 0;
  let sessions = 0;
  for (const name of files.sort()) {
    const path = resolveContained(root, name);
    if (path === undefined) continue;
    const timeline = readRouteTimeline(path);
    if (timeline.entries.length === 0) continue;
    sessions += 1;
    for (const entry of timeline.entries) {
      if (entry.kind === "model_route" || entry.kind === "model_tier_route") decisions += 1;
      if (entry.kind !== "model_stage") continue;
      stages += 1;
      // One escalation per COMPLETED escalation stage: a `started` line and
      // its `done` twin are the same event, and a `skipped` one never ran.
      const stage = str(entry.payload["stage"])?.toLowerCase() ?? "";
      const outcome = str(entry.payload["outcome"]) ?? "";
      if (ESCALATION_STAGES.has(stage) && outcome === "done") escalations += 1;
    }
  }
  return { decisions, escalations, stages, sessions };
}

/** One registry pin compared against the bundle this harness serves. */
export type PinServeState = {
  readonly env: string;
  readonly version: string;
  readonly state: "served" | "not-served" | "cannot-compare";
  readonly detail: string;
};

/**
 * 0.6.0 §9.4 — the "restart-to-serve-pin" signal, read from the harness's own
 * registry. Nothing propagates a pin to a running daemon: `crewhaus spec pin`
 * and a canary promote both end at `.crewhaus/specs/<name>/manifest.json`,
 * and the daemon keeps serving whatever bundle it was started with.
 *
 * The comparison is `bundleFreshness` run against the PINNED spec text rather
 * than the working `crewhaus.yaml` — the exact hash comparison the CLI's
 * `daemon status` pin report makes, through the same
 * `@crewhaus/harness-supervisor` primitive. (The CLI's own reader lives in
 * `apps/cli`, which this package cannot import: `apps/cli` depends on
 * hangar-server, not the other way round.)
 */
export function readPinServeStates(
  ctx: M3Context,
  harnessDir: string,
  specName: string,
  target: string,
): PinServeState[] {
  const dirName = registryDirName(specName);
  const manifest = readJsonAt(safeContain(ctx, [STATE_DIR, "specs", dirName, "manifest.json"]));
  const pins = asRecord((manifest as { pins?: unknown } | undefined)?.pins);
  if (pins === undefined) return [];
  const bundle = resolveBundle(harnessDir, target);
  const out: PinServeState[] = [];
  for (const env of Object.keys(pins).sort()) {
    const version = asString(pins[env]);
    if (version === undefined || !SAFE_SEGMENT_RE.test(version)) continue;
    const path = safeContain(ctx, [STATE_DIR, "specs", dirName, `${version}.yaml`]);
    if (path === undefined || !existsSync(path)) {
      out.push({
        env,
        version,
        state: "cannot-compare",
        detail: `pinned version ${version} is not in the registry on disk`,
      });
      continue;
    }
    const { text } = readTextCapped(path, MAX_PIN_BYTES);
    const verdict = bundleFreshness({
      specYaml: text,
      specPath: join(harnessDir, "crewhaus.yaml"),
      outDir: bundle?.bundleDir ?? join(harnessDir, "dist"),
      entryPath: bundle?.entryPath ?? join(harnessDir, "dist", "agent.ts"),
    });
    if (!verdict.exact) {
      out.push({
        env,
        version,
        state: "cannot-compare",
        detail:
          bundle === undefined
            ? "no compiled bundle to compare against"
            : "the bundle carries no spec-hash stamp (compiled by an older crewhaus) — recompile to compare",
      });
      continue;
    }
    out.push(
      verdict.state === "fresh"
        ? {
            env,
            version,
            state: "served",
            detail: "the compiled bundle was built from this pinned spec",
          }
        : {
            env,
            version,
            state: "not-served",
            detail:
              "the bundle this harness serves was compiled from a DIFFERENT spec than the pin",
          },
    );
  }
  return out;
}
