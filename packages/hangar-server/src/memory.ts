/**
 * Read-only views over the documented memory-fabric stores. Exactly five
 * subtrees are allowlisted — facts (memories), wiki, state (continuity),
 * dream, watchme — and every read is tolerant + capped. This module never
 * writes, never compacts, and never sweeps: the memory fabric's
 * supersede-never-delete invariant means the manager renders lifecycle
 * status (folded from tombstones) instead of ever touching a file.
 *
 * Formats consumed (from the store packages' own docs):
 *   memories/<spec>.jsonl        — entry lines {id, text, tags, createdAt,
 *                                  expiresAt?} + tombstone lines
 *                                  {tombstone: "superseded"|"expired",
 *                                  target, supersededBy?}
 *   wiki/index.json              — slug → {title, tags, …} cache
 *   wiki/articles/<slug>.md      — frontmatter + markdown body
 *   state/focus.md, goals.yaml,
 *   state/plans/plan-*.md        — continuity text documents
 *   dream/<spec>/state.json      — dream scheduler state
 *   watchme/state.json           — watchme cursor state
 *   watchme/observations.jsonl,
 *   watchme/judgments.jsonl      — append-only aggregates (tail rendered)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_MEMORY_ITEMS, MAX_TAIL_LINES, MAX_TEXT_BYTES, SAFE_SEGMENT_RE } from "./constants";
import { readJsonlCapped, readTextCapped } from "./jsonl";
import { maskDeep } from "./mask";
import { resolveInside } from "./safety";

/** The exact memory areas served; anything else is a 404. */
export const MEMORY_AREAS = ["facts", "wiki", "state", "dream", "watchme"] as const;
export type MemoryArea = (typeof MEMORY_AREAS)[number];

export function isMemoryArea(area: string): area is MemoryArea {
  return (MEMORY_AREAS as readonly string[]).includes(area);
}

const crewhausDir = (harnessDir: string): string => join(harnessDir, ".crewhaus");

function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// facts — memories/*.jsonl folded, tombstone-aware
// ---------------------------------------------------------------------------

export type FactItem = {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly status: "live" | "superseded" | "expired";
};

export type FactsFile = {
  /** File stem (the spec name the store writes under). */
  readonly specName: string;
  readonly live: number;
  readonly superseded: number;
  readonly expired: number;
  readonly items: readonly FactItem[];
  readonly truncated: boolean;
};

type RawTombstone = { tombstone?: unknown; target?: unknown };
type RawEntry = {
  id?: unknown;
  text?: unknown;
  tags?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  supersededBy?: unknown;
};

/** Fold one memories JSONL: entries + append-only tombstones → status rows. */
export function foldFactsFile(path: string, specName: string, nowMs: number): FactsFile {
  const read = readJsonlCapped(path);
  const superseded = new Set<string>();
  const expiredByTombstone = new Set<string>();
  for (const obj of read.objects) {
    const t = obj as RawTombstone;
    if (t.tombstone === "superseded" && typeof t.target === "string") superseded.add(t.target);
    else if (t.tombstone === "expired" && typeof t.target === "string") {
      expiredByTombstone.add(t.target);
    }
  }
  const items: FactItem[] = [];
  let live = 0;
  let supersededCount = 0;
  let expiredCount = 0;
  for (const obj of read.objects) {
    const e = obj as RawEntry & RawTombstone;
    if (e.tombstone !== undefined) continue;
    if (typeof e.id !== "string" || typeof e.text !== "string") continue;
    let status: FactItem["status"] = "live";
    if (superseded.has(e.id) || typeof e.supersededBy === "string") status = "superseded";
    else if (
      expiredByTombstone.has(e.id) ||
      (typeof e.expiresAt === "number" && e.expiresAt < nowMs)
    ) {
      status = "expired";
    }
    if (status === "live") live += 1;
    else if (status === "superseded") supersededCount += 1;
    else expiredCount += 1;
    if (items.length < MAX_MEMORY_ITEMS) {
      items.push({
        id: e.id,
        text: e.text,
        tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : [],
        createdAt: typeof e.createdAt === "string" ? e.createdAt : "",
        status,
      });
    }
  }
  return {
    specName,
    live,
    superseded: supersededCount,
    expired: expiredCount,
    items,
    truncated: read.truncated || items.length >= MAX_MEMORY_ITEMS,
  };
}

export function factsView(harnessDir: string, nowMs: number): { files: readonly FactsFile[] } {
  const dir = join(crewhausDir(harnessDir), "memories");
  const files: FactsFile[] = [];
  for (const name of listDirSafe(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const stem = name.slice(0, -".jsonl".length);
    if (!SAFE_SEGMENT_RE.test(stem)) continue;
    files.push(foldFactsFile(join(dir, name), stem, nowMs));
  }
  return { files };
}

// ---------------------------------------------------------------------------
// wiki — index.json + article list (+ one article body)
// ---------------------------------------------------------------------------

export type WikiListView = {
  /** The index.json cache, passed through tolerantly (may be null). */
  readonly index: unknown;
  /** Slugs present on disk (the articles dir is the authority). */
  readonly articles: readonly string[];
};

export function wikiView(harnessDir: string): WikiListView {
  const wikiDir = join(crewhausDir(harnessDir), "wiki");
  const index = readJsonSafe(join(wikiDir, "index.json")) ?? null;
  const articles = listDirSafe(join(wikiDir, "articles"))
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.slice(0, -".md".length))
    .filter((slug) => SAFE_SEGMENT_RE.test(slug));
  return { index: maskDeep(index), articles };
}

export type WikiArticleView = {
  readonly slug: string;
  readonly body: string;
  readonly truncated: boolean;
};

/** One article body — slug shape-checked AND realpath-contained. */
export function wikiArticle(harnessDir: string, slug: string): WikiArticleView | undefined {
  if (!SAFE_SEGMENT_RE.test(slug)) return undefined;
  const path = resolveInside(harnessDir, [".crewhaus", "wiki", "articles", `${slug}.md`]);
  if (path === undefined || !existsSync(path)) return undefined;
  const { text, truncated } = readTextCapped(path, MAX_TEXT_BYTES);
  return { slug, body: text, truncated };
}

// ---------------------------------------------------------------------------
// state — continuity documents (focus / plans / goals)
// ---------------------------------------------------------------------------

export type StateView = {
  readonly focus: string | null;
  readonly goals: string | null;
  readonly plans: ReadonlyArray<{ readonly file: string; readonly text: string }>;
};

export function stateView(harnessDir: string): StateView {
  const stateDir = join(crewhausDir(harnessDir), "state");
  const focusPath = join(stateDir, "focus.md");
  const goalsPath = join(stateDir, "goals.yaml");
  const plans: Array<{ file: string; text: string }> = [];
  for (const name of listDirSafe(join(stateDir, "plans"))) {
    if (!name.endsWith(".md") || !SAFE_SEGMENT_RE.test(name)) continue;
    plans.push({
      file: name,
      text: readTextCapped(join(stateDir, "plans", name), MAX_TEXT_BYTES).text,
    });
  }
  return {
    focus: existsSync(focusPath) ? readTextCapped(focusPath, MAX_TEXT_BYTES).text : null,
    goals: existsSync(goalsPath) ? readTextCapped(goalsPath, MAX_TEXT_BYTES).text : null,
    plans,
  };
}

// ---------------------------------------------------------------------------
// dream — dream/<spec>/state.json per spec dir
// ---------------------------------------------------------------------------

export type DreamView = {
  readonly specs: ReadonlyArray<{ readonly specName: string; readonly state: unknown }>;
};

export function dreamView(harnessDir: string): DreamView {
  const dreamDir = join(crewhausDir(harnessDir), "dream");
  const specs: Array<{ specName: string; state: unknown }> = [];
  for (const name of listDirSafe(dreamDir)) {
    if (!SAFE_SEGMENT_RE.test(name)) continue;
    const state = readJsonSafe(join(dreamDir, name, "state.json"));
    if (state !== undefined) specs.push({ specName: name, state: maskDeep(state) });
  }
  return { specs };
}

// ---------------------------------------------------------------------------
// watchme — state.json + aggregate tails
// ---------------------------------------------------------------------------

export type WatchmeView = {
  readonly state: unknown;
  readonly observationsTail: readonly unknown[];
  readonly judgmentsTail: readonly unknown[];
};

function tail(path: string): readonly unknown[] {
  const { objects } = readJsonlCapped(path);
  return objects.slice(-MAX_TAIL_LINES).map((o) => maskDeep(o));
}

export function watchmeView(harnessDir: string): WatchmeView {
  const dir = join(crewhausDir(harnessDir), "watchme");
  return {
    state: maskDeep(readJsonSafe(join(dir, "state.json")) ?? null),
    observationsTail: tail(join(dir, "observations.jsonl")),
    judgmentsTail: tail(join(dir, "judgments.jsonl")),
  };
}
