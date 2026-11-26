/**
 * HM-189 — the ⌘K omnibox index.
 *
 * ONE index over the things an operator names out loud: harnesses (by spec
 * name, by directory, by group and tag), sessions, wiki articles, memory
 * facts, dataset and grader names, eval run ids, incidents and approvals —
 * plus ACTIONS, which are proposals the console executes only after an
 * explicit confirm.
 *
 * THREE PROPERTIES, EACH LOAD-BEARING.
 *
 * 1. **It never blocks boot.** Nothing is indexed until the first query
 *    arrives. `createOmniIndex()` allocates a map and returns; the first
 *    `search()` pays for the harnesses it needs and memoizes the result.
 *
 * 2. **It is incremental.** Each harness's entries are cached against a
 *    cheap staleness token (the mtimes of the handful of directories the
 *    index reads). A second query re-walks nothing; a query after a session
 *    lands re-walks one harness.
 *
 * 3. **Reads never mutate.** Sessions are listed by NAME from a directory
 *    scan — never `SessionStore.list()`, whose TTL eviction deletes
 *    transcripts — and every path goes through the per-file containment
 *    helpers. The index opens no transcript and parses no JSONL body: it
 *    indexes names, ids and titles, which is what a jump-to-thing box needs.
 *
 * WHAT IS DELIBERATELY NOT INDEXED. Wiki BODIES and fact TEXT are not in the
 * index — a fleet-wide full-text index is a cost this lazy structure cannot
 * pay honestly, and pretending to search bodies while only matching titles
 * is worse than saying so. Titles, tags and slugs are indexed; the wiki
 * screen's own search does full text within one harness.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_TTL_MS, emptyModel, harnessAttention, refreshModel } from "@crewhaus/attention";
import { readApproverProjection } from "@crewhaus/control-records";
import { harnessEnvFacts } from "@crewhaus/harness-supervisor";
import { APPROVALS_FILENAME } from "./approvals";
import { MAX_JSONL_LINES, SAFE_SEGMENT_RE, SESSION_JSON_RE } from "./constants";
import { readJsonlCapped } from "./jsonl";
import { MENU_ACTION_PROVIDERS } from "./menu/actions";
import { resolveInside } from "./safety";
import { reachableSessionRoot } from "./sessions";
import { liveWikiSegments } from "./store-layout";

/** What an omnibox row IS — the kind drives its icon and its deep link. */
export const OMNI_KINDS = [
  "harness",
  "group",
  "tag",
  "session",
  "wiki",
  "fact",
  "dataset",
  "grader",
  "eval-run",
  "incident",
  "approval",
  "action",
] as const;
export type OmniKind = (typeof OMNI_KINDS)[number];

export type OmniEntry = {
  readonly kind: OmniKind;
  /** Stable within a kind (a harness id, a slug, a run id, an action id). */
  readonly id: string;
  /** The text matched against and shown as the row title. */
  readonly title: string;
  /** Secondary line — never matched against, so a long path cannot outrank
   *  a real title. */
  readonly subtitle: string;
  /** Console hash route (`#/h/<id>/work/sessions/<sess>`). */
  readonly href: string;
  readonly harnessId: string | null;
  /** Where the entry comes from: the harness's name, or "Home". */
  readonly source: string;
  /** When this entry's harness was indexed (ISO time). */
  readonly indexedAt: string;
  /**
   * A harness's owner, by display name, added when a search answers and never kept in
   * the index: the index does not follow Home's access records. Absent when none.
   */
  readonly owner?: string;
};

/**
 * An action the omnibox can PROPOSE. It is never executed by the search
 * route: the console renders it, the operator confirms, and the console
 * then calls the ordinary route — so an action inherits every guard,
 * every read-only refusal and every audit trail the button beside it has.
 */
export type OmniAction = {
  readonly id: string;
  readonly label: string;
  /**
   * The `routes.js` map entry the console must call after the confirm.
   *
   * Named `route`, NOT `routeKey`: `maskDeep` redacts by key NAME and its
   * camel-case `…Key` rule would turn this field into `"[redacted]"` in
   * every response, silently. Naming around the matcher is the convention
   * (see `mask.ts`); widening it is not.
   */
  readonly route: string;
  /**
   * A versioned-API operation the console runs in place of `route`, through the same
   * receipted request as the button beside it. Absent for a `route` action.
   */
  readonly operation?: string;
  readonly params: Readonly<Record<string, string>>;
  /** The exact command that does the same thing in a terminal. */
  readonly cliTwin: string;
  /** Always true. Present so a client cannot treat any action as immediate. */
  readonly confirm: true;
};

export type OmniResults = {
  readonly query: string;
  readonly entries: readonly OmniEntry[];
  readonly actions: readonly OmniAction[];
  /** Harnesses whose entries were built for this query (the lazy cost). */
  readonly indexed: number;
  /** Entries currently held for the harnesses searched. */
  readonly size: number;
};

/** Per-harness caps — one busy harness must not own the whole result list. */
export const MAX_SESSIONS_INDEXED = 200;
export const MAX_ENTRIES_PER_HARNESS = 600;
/** Default result cap. */
export const OMNI_LIMIT = 20;

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

/**
 * Score `title` against `query`. Higher is better; 0 means "no match".
 *
 *   exact           1000
 *   prefix           600 (+ a length bonus, so "cli" beats "cli-extended")
 *   word-start       400
 *   substring        200
 *   subsequence      100 (fuzzy — every query char in order)
 *
 * Case-insensitive throughout. Deliberately simple and total: a ranking an
 * operator cannot predict is worse than no ranking at all.
 */
export function scoreMatch(title: string, query: string): number {
  const t = title.toLowerCase();
  const q = query.toLowerCase().trim();
  if (q === "") return 0;
  if (t === q) return 1000;
  const shortnessBonus = Math.max(0, 40 - t.length);
  if (t.startsWith(q)) return 600 + shortnessBonus;
  const wordStart = new RegExp(`(?:^|[\\s/_.:-])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (wordStart.test(t)) return 400 + shortnessBonus;
  if (t.includes(q)) return 200 + shortnessBonus;
  // Subsequence: cheap fuzzy, last resort.
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return 100;
  }
  return 0;
}

/** Rank entries for a query, best first, ties broken by kind order then
 *  title so results never reshuffle between identical queries. */
export function rankEntries(
  entries: readonly OmniEntry[],
  query: string,
  limit: number = OMNI_LIMIT,
): readonly OmniEntry[] {
  const kindOrder = new Map(OMNI_KINDS.map((k, i) => [k, i]));
  return entries
    .map((entry) => ({ entry, score: scoreMatch(entry.title, query) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (kindOrder.get(a.entry.kind) ?? 99) - (kindOrder.get(b.entry.kind) ?? 99) ||
        a.entry.title.localeCompare(b.entry.title),
    )
    .slice(0, limit)
    .map((row) => row.entry);
}

// ---------------------------------------------------------------------------
// Actions (pure)
// ---------------------------------------------------------------------------

/**
 * Verb → the route it maps to, its CLI twin, and how it reads in the list:
 * the providers in `menu/actions`, one per area. Each twin has to run when
 * pasted; `apps/cli/src/cli-twins.test.ts` checks them against the CLI's own
 * verb inventory.
 */
const ACTION_VERBS = MENU_ACTION_PROVIDERS;

/** Every CLI twin the omnibox can propose, for one harness directory —
 *  the surface `apps/cli/src/cli-twins.test.ts` validates against the CLI's
 *  verb inventory. */
export function actionCliTwins(dir: string): readonly string[] {
  return ACTION_VERBS.map((action) => action.cli(dir));
}

export type ActionHarness = {
  readonly id: string;
  readonly specName: string;
  readonly dir: string;
};

/**
 * Propose actions for a query of the form `<verb> <harness>`.
 *
 * Only fires when the query STARTS with a known verb: typing "restart" while
 * looking for a harness called "restart-tests" should not fill the list with
 * things that would restart daemons. The remainder must also match a
 * harness — a bare verb proposes nothing, because "start" with no object is
 * not an instruction.
 */
export function matchActions(
  query: string,
  harnesses: readonly ActionHarness[],
  limit = 5,
  /** Whether the caller holds a provider's permission on a harness; absent allows all. */
  allowed: (permission: string, harness: string) => boolean = () => true,
): readonly OmniAction[] {
  const q = query.trim().toLowerCase();
  const spaceAt = q.indexOf(" ");
  if (spaceAt <= 0) return [];
  const verb = q.slice(0, spaceAt);
  const rest = q.slice(spaceAt + 1).trim();
  if (rest === "") return [];
  const action = ACTION_VERBS.find((a) => a.verb === verb);
  if (action === undefined) return [];
  const { permission } = action;
  return harnesses
    .filter((h) => permission === undefined || allowed(permission, h.id))
    .map((h) => ({ h, score: Math.max(scoreMatch(h.specName, rest), scoreMatch(h.dir, rest)) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.h.specName.localeCompare(b.h.specName))
    .slice(0, limit)
    .map(({ h }) => ({
      id: `${action.verb}:${h.id}`,
      label: action.label(h.specName),
      route: action.route,
      ...(action.operation !== undefined ? { operation: action.operation } : {}),
      params: { id: h.id },
      cliTwin: action.cli(h.dir),
      confirm: true as const,
    }));
}

// ---------------------------------------------------------------------------
// Per-harness entry building (filesystem, capped, containment-checked)
// ---------------------------------------------------------------------------

export type IndexHarness = {
  readonly id: string;
  readonly specName: string;
  readonly dir: string;
  readonly groups: readonly string[];
  readonly tags: readonly string[];
};

/** A console address inside a harness: `#/h/<id>/<section>/<sub>[/…]`. */
const href = (id: string, section: string, sub: string, ...rest: string[]): string =>
  [`#/h/${encodeURIComponent(id)}`, section, sub, ...rest.map((r) => encodeURIComponent(r))].join(
    "/",
  );

/** Where every pending approval is decided: Home's Needs-you page. */
export const APPROVALS_HREF = "#/home/needs-you?kind=permission";

/** The env chain as the inbox fold asks of it: where the sessions folder is. */
const OMNI_FACTS = harnessEnvFacts();

/** A request's state, in the words its menu row says it. */
const ASK_STATE_WORDS: Readonly<Record<string, string>> = {
  open: "waiting for a decision",
  assigned: "waiting for a decision",
  deferred: "deferred",
  resolved: "decided",
  expired: "expired",
  superseded: "replaced by a newer request",
};
/** The states in which a request still waits on a person. */
const isWaiting = (state: string): boolean =>
  state === "open" || state === "assigned" || state === "deferred";
/** The harness list, where groups and tags are browsed. */
export const HARNESSES_HREF = "#/harnesses";

const listSafe = (dir: string | undefined): string[] => {
  if (dir === undefined) return [];
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

const mtimeOf = (path: string | undefined): number => {
  if (path === undefined) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * The staleness token for one harness: the mtimes of exactly the
 * directories this index reads. Cheap (a handful of stats), and it changes
 * the moment any of them gains a file — which is the only thing that can
 * make the cached entries wrong.
 */
export function harnessIndexToken(dir: string): string {
  const crewhaus = join(dir, ".crewhaus");
  const wikiStore = liveWikiSegments(dir);
  const reach = reachableSessionRoot(dir);
  const sessionRoot = reach.reachable ? reach.root : undefined;
  const parts = [
    mtimeOf(join(dir, "crewhaus.yaml")),
    sessionRoot === undefined ? -1 : mtimeOf(sessionRoot),
    mtimeOf(join(crewhaus, "wiki", "articles")),
    mtimeOf(wikiStore && resolveInside(dir, [...wikiStore, "articles"])),
    mtimeOf(join(crewhaus, "memories")),
    mtimeOf(join(crewhaus, "datasets")),
    mtimeOf(join(crewhaus, "evals")),
    mtimeOf(join(crewhaus, "incidents")),
    // The approvals log lives beside the sessions, wherever they resolve.
    mtimeOf(sessionRoot === undefined ? undefined : join(sessionRoot, APPROVALS_FILENAME)),
  ];
  return parts.join(":");
}

/** Build one harness's entries. Names, ids and titles only, each saying
 *  where it comes from and when it was read. */
export function buildHarnessEntries(
  harness: IndexHarness,
  nowMs: number = Date.now(),
): readonly OmniEntry[] {
  const { id, dir, specName } = harness;
  const indexedAt = new Date(nowMs).toISOString();
  const out: OmniEntry[] = [];
  const push = (entry: Omit<OmniEntry, "source" | "indexedAt">): void => {
    if (out.length < MAX_ENTRIES_PER_HARNESS) out.push({ ...entry, source: specName, indexedAt });
  };

  push({
    kind: "harness",
    id,
    title: specName,
    subtitle: dir,
    href: `#/h/${encodeURIComponent(id)}`,
    harnessId: id,
  });
  for (const group of harness.groups) {
    push({
      kind: "group",
      id: `${id}:${group}`,
      title: group,
      subtitle: `group · ${specName}`,
      href: HARNESSES_HREF,
      harnessId: id,
    });
  }
  for (const tag of harness.tags) {
    push({
      kind: "tag",
      id: `${id}:${tag}`,
      title: tag,
      subtitle: `tag · ${specName}`,
      href: HARNESSES_HREF,
      harnessId: id,
    });
  }

  // Sessions — a NAME scan of the resolved session root. Never
  // SessionStore.list(): its TTL sweep deletes transcripts, and an index
  // build is a read.
  // Only the harness's own sessions folder: one that is unreachable adds nothing.
  const reach = reachableSessionRoot(dir);
  const sessionRoot = reach.reachable ? reach.root : undefined;
  const sessions = listSafe(
    sessionRoot !== undefined && existsSync(sessionRoot) ? sessionRoot : undefined,
  )
    .filter((n) => SESSION_JSON_RE.test(n))
    .slice(-MAX_SESSIONS_INDEXED);
  for (const name of sessions) {
    const sessionId = name.replace(/\.json$/, "");
    push({
      kind: "session",
      id: sessionId,
      title: sessionId,
      subtitle: `session · ${specName}`,
      href: href(id, "work", "sessions", sessionId),
      harnessId: id,
    });
  }

  // Wiki article slugs (titles, not bodies — see the module docblock).
  const wikiStore = liveWikiSegments(dir);
  const wikiDir = wikiStore && resolveInside(dir, [...wikiStore, "articles"]);
  for (const name of listSafe(wikiDir)) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -3);
    if (!SAFE_SEGMENT_RE.test(slug)) continue;
    push({
      kind: "wiki",
      id: slug,
      title: slug.replace(/-/g, " "),
      subtitle: `wiki · ${specName}`,
      href: href(id, "knowledge", "wiki", slug),
      harnessId: id,
    });
  }

  // Memory fact FILE names (each file is one spec's fact store).
  const memDir = resolveInside(dir, [".crewhaus", "memories"]);
  for (const name of listSafe(memDir)) {
    if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue;
    push({
      kind: "fact",
      id: name,
      title: name.replace(/\.(json|jsonl)$/, ""),
      subtitle: `facts · ${specName}`,
      href: href(id, "knowledge", "memory"),
      harnessId: id,
    });
  }

  // Dataset + grader names.
  const dataDir = resolveInside(dir, [".crewhaus", "datasets"]);
  for (const name of listSafe(dataDir)) {
    push({
      kind: "dataset",
      id: name,
      title: name.replace(/\.(jsonl|json)$/, ""),
      subtitle: `dataset · ${specName}`,
      href: href(id, "quality", "datasets"),
      harnessId: id,
    });
  }
  const graderDir = resolveInside(dir, [".crewhaus", "graders"]);
  for (const name of listSafe(graderDir)) {
    push({
      kind: "grader",
      id: name,
      title: name.replace(/\.(ts|js|json)$/, ""),
      subtitle: `grader · ${specName}`,
      href: href(id, "quality", "results"),
      harnessId: id,
    });
  }

  // Eval run ids, from the run index (capped read, torn lines tolerated).
  const evalIndex = resolveInside(dir, [".crewhaus", "evals", "index.jsonl"]);
  if (evalIndex !== undefined && existsSync(evalIndex)) {
    const { objects } = readJsonlCapped(evalIndex, MAX_JSONL_LINES);
    for (const row of objects) {
      const runId = (row as { runId?: unknown }).runId;
      if (typeof runId !== "string" || runId === "") continue;
      push({
        kind: "eval-run",
        id: runId,
        title: runId,
        subtitle: `eval run · ${specName}`,
        href: href(id, "quality", "results", runId),
        harnessId: id,
      });
    }
  }

  // Incident ids (file names under .crewhaus/incidents, unresolved only).
  const incidentDir = resolveInside(dir, [".crewhaus", "incidents"]);
  for (const name of listSafe(incidentDir)) {
    if (!name.endsWith(".json") || name.endsWith(".resolved.json")) continue;
    push({
      kind: "incident",
      id: name.slice(0, -5),
      title: name.slice(0, -5),
      subtitle: `incident · ${specName}`,
      href: href(id, "setup", "security"),
      harnessId: id,
    });
  }

  // Requests waiting on a person, and the ones decided within their time to live, as the
  // inbox folds them at the contained session root (read-only and capped: never listed
  // through the store, which compacts). Each names its state in words and opens its item.
  const asked = harnessAttention(
    refreshModel(emptyModel(), dir, OMNI_FACTS),
    {
      harness: id,
      dir,
      now: nowMs,
      content: false,
      freshness: { asOf: indexedAt, mode: "direct-fold" },
    },
    { facts: OMNI_FACTS },
  );
  for (const { item } of asked.items) {
    if (item.source.kind !== "approval") continue;
    // A request about people is withheld from search: the index is shared by every caller.
    if (item.sensitivity === "people") continue;
    const settled = item.resolution === undefined ? undefined : Date.parse(item.resolution.at);
    const recent = settled !== undefined && nowMs - settled <= APPROVAL_TTL_MS;
    // A request someone took, or put off, still waits: it is found until it is settled.
    if (!isWaiting(item.state) && !recent) continue;
    const att = item.ref.slice(item.ref.lastIndexOf("/") + 1);
    const tool = item.title.params["tool"];
    push({
      kind: "approval",
      id: att,
      title: typeof tool === "string" && tool !== "" ? tool : att,
      subtitle: `${ASK_STATE_WORDS[item.state] ?? item.state} · ${specName}`,
      href: `#/home/needs-you?item=${att}`,
      harnessId: id,
    });
  }

  return out;
}

/**
 * Each harness's owner by display name, read when a search answers: the owner the
 * harness's approver list names, and the name Home's access records give that principal.
 * A harness with no list, or an owner with no name, has none.
 */
export function harnessOwnerLookup(
  harnesses: readonly { readonly id: string; readonly dir: string }[],
  names: ReadonlyMap<string, string>,
): (harnessId: string) => string | undefined {
  const dirs = new Map(harnesses.map((h) => [h.id, h.dir] as const));
  const seen = new Map<string, string | undefined>();
  return (harnessId) => {
    if (seen.has(harnessId)) return seen.get(harnessId);
    const dir = dirs.get(harnessId);
    let label: string | undefined;
    if (dir !== undefined) {
      try {
        const read = readApproverProjection(dir);
        const owner = read.state === "present" ? read.projection.owner : undefined;
        label = typeof owner === "string" ? names.get(owner) : undefined;
      } catch {
        label = undefined;
      }
    }
    seen.set(harnessId, label);
    return label;
  };
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/** What a search knows about its caller, beside the index. */
export type OmniSearchOptions = {
  /** A harness's owner, by display name, or `undefined` when none is known. */
  readonly ownerOf?: (harnessId: string) => string | undefined;
  /** Whether the caller holds `permission` on a harness, for the actions it may be offered. */
  readonly allowed?: (permission: string, harness: string) => boolean;
};

export type OmniIndex = {
  /** Query. Builds only what is stale; returns ranked entries + actions. */
  search(
    query: string,
    harnesses: readonly IndexHarness[],
    limit?: number,
    options?: OmniSearchOptions,
  ): OmniResults;
  /** Cached entry count, for the "built lazily" assertion. */
  size(): number;
  /** Drop a harness's cached entries (used when it is removed). */
  forget(harnessId: string): void;
};

export function createOmniIndex(
  deps: {
    readonly build?: (harness: IndexHarness, nowMs: number) => readonly OmniEntry[];
    readonly token?: (dir: string) => string;
    /** The clock an index build is stamped with (each entry's `indexedAt`). */
    readonly now?: () => number;
  } = {},
): OmniIndex {
  const build = deps.build ?? buildHarnessEntries;
  const token = deps.token ?? harnessIndexToken;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { token: string; entries: readonly OmniEntry[] }>();
  /** The entries indexed for these harnesses only: a search counts what its caller may see. */
  const sizeOf = (harnesses: readonly IndexHarness[]): number =>
    harnesses.reduce((n, harness) => n + (cache.get(harness.id)?.entries.length ?? 0), 0);

  return {
    search: (query, harnesses, limit = OMNI_LIMIT, options = {}) => {
      const q = typeof query === "string" ? query.trim() : "";
      if (q === "") {
        return { query: "", entries: [], actions: [], indexed: 0, size: sizeOf(harnesses) };
      }
      let indexed = 0;
      const all: OmniEntry[] = [];
      for (const harness of harnesses) {
        const current = token(harness.dir);
        const hit = cache.get(harness.id);
        if (hit === undefined || hit.token !== current) {
          const entries = build(harness, now());
          cache.set(harness.id, { token: current, entries });
          indexed += 1;
          all.push(...entries);
        } else {
          all.push(...hit.entries);
        }
      }
      const { ownerOf, allowed } = options;
      const ranked = rankEntries(all, q, limit);
      return {
        query: q,
        entries:
          ownerOf === undefined
            ? ranked
            : ranked.map((entry) => {
                if (entry.kind !== "harness" || entry.harnessId === null) return entry;
                const owner = ownerOf(entry.harnessId);
                return owner === undefined ? entry : { ...entry, owner };
              }),
        actions: matchActions(q, harnesses, 5, allowed),
        indexed,
        size: sizeOf(harnesses),
      };
    },
    size: () => cacheSize(cache),
    forget: (harnessId) => {
      cache.delete(harnessId);
    },
  };
}

function cacheSize(cache: Map<string, { entries: readonly OmniEntry[] }>): number {
  let n = 0;
  for (const value of cache.values()) n += value.entries.length;
  return n;
}
