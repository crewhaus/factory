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
import { MAX_JSONL_LINES, SAFE_SEGMENT_RE, SESSION_JSON_RE } from "./constants";
import { readJsonlCapped } from "./jsonl";
import { resolveInside } from "./safety";
import { resolveSessionRoot } from "./sessions";

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
  /** Console hash route (`#/h/<id>/sessions/<sess>`). */
  readonly href: string;
  readonly harnessId: string | null;
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
  /** Total entries currently held. */
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

/** Verb → the route it maps to, its CLI twin, and how it reads in the list. */
const ACTION_VERBS: ReadonlyArray<{
  readonly verb: string;
  readonly route: string;
  readonly cli: (dir: string) => string;
  readonly label: (name: string) => string;
}> = [
  {
    verb: "start",
    route: "procStart",
    cli: (dir) => `crewhaus daemon start --dir ${dir}`,
    label: (name) => `Start ${name}`,
  },
  {
    verb: "stop",
    route: "procStop",
    cli: (dir) => `crewhaus daemon stop --dir ${dir}`,
    label: (name) => `Stop ${name}`,
  },
  {
    verb: "restart",
    route: "procRestart",
    cli: (dir) => `crewhaus daemon restart --dir ${dir}`,
    label: (name) => `Restart ${name}`,
  },
  {
    verb: "drain",
    route: "procDrain",
    cli: (dir) => `crewhaus daemon drain --dir ${dir}`,
    label: (name) => `Drain ${name}`,
  },
];

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
): readonly OmniAction[] {
  const q = query.trim().toLowerCase();
  const spaceAt = q.indexOf(" ");
  if (spaceAt <= 0) return [];
  const verb = q.slice(0, spaceAt);
  const rest = q.slice(spaceAt + 1).trim();
  if (rest === "") return [];
  const action = ACTION_VERBS.find((a) => a.verb === verb);
  if (action === undefined) return [];
  return harnesses
    .map((h) => ({ h, score: Math.max(scoreMatch(h.specName, rest), scoreMatch(h.dir, rest)) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.h.specName.localeCompare(b.h.specName))
    .slice(0, limit)
    .map(({ h }) => ({
      id: `${action.verb}:${h.id}`,
      label: action.label(h.specName),
      route: action.route,
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

const href = (id: string, tab: string, ...rest: string[]): string =>
  [`#/h/${encodeURIComponent(id)}`, tab, ...rest.map((r) => encodeURIComponent(r))]
    .filter((s) => s !== "")
    .join("/");

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
  const parts = [
    mtimeOf(join(dir, "crewhaus.yaml")),
    mtimeOf(resolveSessionRoot(dir).root),
    mtimeOf(join(crewhaus, "wiki", "articles")),
    mtimeOf(join(crewhaus, "memories")),
    mtimeOf(join(crewhaus, "datasets")),
    mtimeOf(join(crewhaus, "evals")),
    mtimeOf(join(crewhaus, "incidents")),
    mtimeOf(join(crewhaus, "approvals.jsonl")),
  ];
  return parts.join(":");
}

/** Build one harness's entries. Names, ids and titles only. */
export function buildHarnessEntries(harness: IndexHarness): readonly OmniEntry[] {
  const { id, dir, specName } = harness;
  const out: OmniEntry[] = [];
  const push = (entry: OmniEntry): void => {
    if (out.length < MAX_ENTRIES_PER_HARNESS) out.push(entry);
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
      href: "#/",
      harnessId: id,
    });
  }
  for (const tag of harness.tags) {
    push({
      kind: "tag",
      id: `${id}:${tag}`,
      title: tag,
      subtitle: `tag · ${specName}`,
      href: "#/",
      harnessId: id,
    });
  }

  // Sessions — a NAME scan of the resolved session root. Never
  // SessionStore.list(): its TTL sweep deletes transcripts, and an index
  // build is a read.
  const sessionRoot = resolveSessionRoot(dir).root;
  const sessions = listSafe(existsSync(sessionRoot) ? sessionRoot : undefined)
    .filter((n) => SESSION_JSON_RE.test(n))
    .slice(-MAX_SESSIONS_INDEXED);
  for (const name of sessions) {
    const sessionId = name.replace(/\.json$/, "");
    push({
      kind: "session",
      id: sessionId,
      title: sessionId,
      subtitle: `session · ${specName}`,
      href: href(id, "sessions", sessionId),
      harnessId: id,
    });
  }

  // Wiki article slugs (titles, not bodies — see the module docblock).
  const wikiDir = resolveInside(dir, [".crewhaus", "wiki", "articles"]);
  for (const name of listSafe(wikiDir)) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -3);
    if (!SAFE_SEGMENT_RE.test(slug)) continue;
    push({
      kind: "wiki",
      id: slug,
      title: slug.replace(/-/g, " "),
      subtitle: `wiki · ${specName}`,
      href: href(id, "memory", "wiki", slug),
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
      href: href(id, "memory"),
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
      href: href(id, "data"),
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
      href: href(id, "evals"),
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
        href: href(id, "evals", runId),
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
      href: href(id, "security"),
      harnessId: id,
    });
  }

  // Pending approval ids — folded, never listed through the store (its
  // list() COMPACTS the ledger, and indexing is a read).
  const approvals = resolveInside(dir, [".crewhaus", "approvals.jsonl"]);
  if (approvals !== undefined && existsSync(approvals)) {
    const { objects } = readJsonlCapped(approvals, MAX_JSONL_LINES);
    const seen = new Set<string>();
    for (const row of objects) {
      const approvalId = (row as { id?: unknown }).id;
      const toolName = (row as { toolName?: unknown }).toolName;
      if (typeof approvalId !== "string" || approvalId === "" || seen.has(approvalId)) continue;
      seen.add(approvalId);
      push({
        kind: "approval",
        id: approvalId,
        title: typeof toolName === "string" && toolName !== "" ? toolName : approvalId,
        subtitle: `approval · ${specName}`,
        href: "#/approvals",
        harnessId: id,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export type OmniIndex = {
  /** Query. Builds only what is stale; returns ranked entries + actions. */
  search(query: string, harnesses: readonly IndexHarness[], limit?: number): OmniResults;
  /** Cached entry count, for the "built lazily" assertion. */
  size(): number;
  /** Drop a harness's cached entries (used when it is removed). */
  forget(harnessId: string): void;
};

export function createOmniIndex(
  deps: {
    readonly build?: (harness: IndexHarness) => readonly OmniEntry[];
    readonly token?: (dir: string) => string;
  } = {},
): OmniIndex {
  const build = deps.build ?? buildHarnessEntries;
  const token = deps.token ?? harnessIndexToken;
  const cache = new Map<string, { token: string; entries: readonly OmniEntry[] }>();

  return {
    search: (query, harnesses, limit = OMNI_LIMIT) => {
      const q = typeof query === "string" ? query.trim() : "";
      if (q === "") {
        return { query: "", entries: [], actions: [], indexed: 0, size: cacheSize(cache) };
      }
      let indexed = 0;
      const all: OmniEntry[] = [];
      for (const harness of harnesses) {
        const current = token(harness.dir);
        const hit = cache.get(harness.id);
        if (hit === undefined || hit.token !== current) {
          const entries = build(harness);
          cache.set(harness.id, { token: current, entries });
          indexed += 1;
          all.push(...entries);
        } else {
          all.push(...hit.entries);
        }
      }
      return {
        query: q,
        entries: rankEntries(all, q, limit),
        actions: matchActions(q, harnesses),
        indexed,
        size: cacheSize(cache),
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
