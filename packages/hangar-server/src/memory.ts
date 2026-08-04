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
import { maskDeep, maskText } from "./mask";
import { resolveInside } from "./safety";

/** The exact memory areas served; anything else is a 404. */
export const MEMORY_AREAS = ["facts", "wiki", "state", "dream", "watchme"] as const;
export type MemoryArea = (typeof MEMORY_AREAS)[number];

export function isMemoryArea(area: string): area is MemoryArea {
  return (MEMORY_AREAS as readonly string[]).includes(area);
}

/**
 * A `.crewhaus` subpath that is realpath-contained inside the harness dir.
 * Every read in this module goes through it — listing a directory yields
 * names, and a name can be a symlink pointing anywhere, so containment is
 * re-checked per file rather than once per directory. undefined means the
 * path escapes (or the harness root is unreadable); callers render the area
 * as absent rather than reading.
 */
function contained(harnessDir: string, segments: readonly string[]): string | undefined {
  return resolveInside(harnessDir, [".crewhaus", ...segments]);
}

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
        // Fact text is agent-authored prose that can quote a credential it
        // saw in a tool result; mask it like any other served text.
        text: maskText(e.text),
        tags: Array.isArray(e.tags)
          ? e.tags.filter((t): t is string => typeof t === "string").map((t) => maskText(t))
          : [],
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
  const dir = contained(harnessDir, ["memories"]);
  if (dir === undefined) return { files: [] };
  const files: FactsFile[] = [];
  for (const name of listDirSafe(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const stem = name.slice(0, -".jsonl".length);
    if (!SAFE_SEGMENT_RE.test(stem)) continue;
    const path = contained(harnessDir, ["memories", name]);
    if (path === undefined) continue;
    files.push(foldFactsFile(path, stem, nowMs));
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
  const indexPath = contained(harnessDir, ["wiki", "index.json"]);
  const articlesDir = contained(harnessDir, ["wiki", "articles"]);
  const index = indexPath === undefined ? null : (readJsonSafe(indexPath) ?? null);
  const articles =
    articlesDir === undefined
      ? []
      : listDirSafe(articlesDir)
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
  return { slug, body: maskText(text), truncated };
}

// ---------------------------------------------------------------------------
// state — continuity documents (focus / plans / goals)
// ---------------------------------------------------------------------------

export type StateView = {
  readonly focus: string | null;
  readonly goals: string | null;
  readonly plans: ReadonlyArray<{ readonly file: string; readonly text: string }>;
};

function readContainedText(harnessDir: string, segments: readonly string[]): string | null {
  const path = contained(harnessDir, segments);
  if (path === undefined || !existsSync(path)) return null;
  return maskText(readTextCapped(path, MAX_TEXT_BYTES).text);
}

export function stateView(harnessDir: string): StateView {
  const plansDir = contained(harnessDir, ["state", "plans"]);
  const plans: Array<{ file: string; text: string }> = [];
  if (plansDir !== undefined) {
    for (const name of listDirSafe(plansDir)) {
      if (!name.endsWith(".md") || !SAFE_SEGMENT_RE.test(name)) continue;
      const text = readContainedText(harnessDir, ["state", "plans", name]);
      if (text === null) continue;
      plans.push({ file: name, text });
    }
  }
  return {
    focus: readContainedText(harnessDir, ["state", "focus.md"]),
    goals: readContainedText(harnessDir, ["state", "goals.yaml"]),
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
  const dreamDir = contained(harnessDir, ["dream"]);
  if (dreamDir === undefined) return { specs: [] };
  const specs: Array<{ specName: string; state: unknown }> = [];
  for (const name of listDirSafe(dreamDir)) {
    if (!SAFE_SEGMENT_RE.test(name)) continue;
    const path = contained(harnessDir, ["dream", name, "state.json"]);
    if (path === undefined) continue;
    const state = readJsonSafe(path);
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

function tail(harnessDir: string, file: string): readonly unknown[] {
  const path = contained(harnessDir, ["watchme", file]);
  if (path === undefined) return [];
  const { objects } = readJsonlCapped(path);
  return objects.slice(-MAX_TAIL_LINES).map((o) => maskDeep(o));
}

export function watchmeView(harnessDir: string): WatchmeView {
  const statePath = contained(harnessDir, ["watchme", "state.json"]);
  return {
    state: maskDeep(statePath === undefined ? null : (readJsonSafe(statePath) ?? null)),
    observationsTail: tail(harnessDir, "observations.jsonl"),
    judgmentsTail: tail(harnessDir, "judgments.jsonl"),
  };
}
