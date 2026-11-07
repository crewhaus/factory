/**
 * Read-only views over the documented memory-fabric stores. Exactly five
 * subtrees are allowlisted — facts (memories), wiki, state (continuity),
 * dream, watchme. Every read is tolerant; text and tails are capped, and a
 * fact file is read whole up to `MAX_FACT_FILE_BYTES`, because its last line
 * can decide its first fact's status. This module never writes, never compacts, and never sweeps: the memory fabric's
 * supersede-never-delete invariant means the manager renders lifecycle
 * status (folded from tombstones) instead of ever touching a file.
 *
 * Formats consumed (from the store packages' own docs):
 *   memories/<spec>.jsonl        — entry lines {id, text, tags, createdAt,
 *                                  expiresAt?} + tombstone lines
 *                                  {tombstone: "superseded"|"expired",
 *                                  target, supersededBy?}
 *   wiki/<spec>/index.json       — {version, articles: slug → {title, tags, …}}
 *   wiki/<spec>/articles/<slug>.md — frontmatter + markdown body
 *   state/<spec>/focus.md, goals.yaml,
 *   state/<spec>/plans/plan-*.md — continuity text documents
 *   dream/<spec>/state.json      — dream scheduler state
 *   watchme/state.json           — watchme cursor state
 *   watchme/observations.jsonl,
 *   watchme/judgments.jsonl      — append-only aggregates (tail rendered)
 *
 * The wiki and state stores carry two layouts: the spec-scoped one above,
 * which a live harness has, and the older flat `wiki/…`, `state/…`. The store
 * is chosen once per area by `store-layout.ts`, the same rule the write routes
 * use, so these reads show the files a save would touch.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { parseArticle } from "@crewhaus/wiki-store";
import { MAX_TAIL_LINES, MAX_TEXT_BYTES, SAFE_SEGMENT_RE } from "./constants";
import { readJsonlCapped, readTextCapped } from "./jsonl";
import { maskDeep, maskText } from "./mask";
import { foldFacts } from "./memory-ops";
import { resolveInside } from "./safety";
import {
  STATE_STORE_PROBE,
  type WikiAuthority,
  liveSpecName,
  liveStore,
  liveWikiSegments,
  wikiAuthorityOf,
  wikiIndexArticles,
} from "./store-layout";

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
  /** Exact counts; null when the file is too large to read (unknown, not 0). */
  readonly live: number | null;
  readonly superseded: number | null;
  readonly expired: number | null;
  /** The newest rows, in file order. */
  readonly items: readonly FactItem[];
  readonly truncated: boolean;
  readonly tooLarge: boolean;
};

/** Fold one memories JSONL: entries + append-only tombstones → status rows. */
export function foldFactsFile(path: string, specName: string, nowMs: number): FactsFile {
  const folded = foldFacts(path, nowMs);
  return {
    specName,
    live: folded.counts?.live ?? null,
    superseded: folded.counts?.superseded ?? null,
    expired: folded.counts?.expired ?? null,
    items: folded.items.map((row) => ({
      id: row.id,
      text: row.text,
      tags: row.tags,
      createdAt: row.createdAt,
      status: row.status,
    })),
    truncated: folded.truncated,
    tooLarge: folded.tooLarge,
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
  /** The index.json slug map, whichever shape the file carries (may be null). */
  readonly index: unknown;
  /** Slugs in the chosen store (its articles dir is the authority). */
  readonly articles: readonly string[];
  /** Where this harness's wiki lives. */
  readonly authority: WikiAuthority;
};

export function wikiView(harnessDir: string): WikiListView {
  const authority = wikiAuthorityOf(harnessDir);
  const store = liveWikiSegments(harnessDir);
  if (store === undefined) return { index: null, articles: [], authority };
  const indexPath = resolveInside(harnessDir, [...store, "index.json"]);
  const articlesDir = resolveInside(harnessDir, [...store, "articles"]);
  const index = indexPath === undefined ? null : wikiIndexArticles(readJsonSafe(indexPath));
  const articles =
    articlesDir === undefined
      ? []
      : listDirSafe(articlesDir)
          .filter((n) => n.endsWith(".md"))
          // Per FILE: a listed name can be a symlink out of the harness, and
          // a row the article route would refuse is not a row.
          .filter((n) => resolveInside(harnessDir, [...store, "articles", n]) !== undefined)
          .map((n) => n.slice(0, -".md".length))
          .filter((slug) => SAFE_SEGMENT_RE.test(slug));
  return { index: maskDeep(index), articles, authority };
}

export type WikiArticleView = {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  /** The version this body was read at; null when the file has no frontmatter. */
  readonly version: number | null;
  readonly truncated: boolean;
};

/**
 * One article, parsed — slug shape-checked AND realpath-contained. The store
 * is chosen per directory, never per file: on a tree holding both layouts a
 * slug only the flat side has is a 404, because a save would write a new
 * spec-scoped article rather than that file.
 *
 * Returning the body without its frontmatter is what lets the editor save it
 * back; a raw read would nest the frontmatter inside the body on every edit.
 * A file that cannot be read is absent, not an empty article, for the same
 * reason.
 */
export function wikiArticle(harnessDir: string, slug: string): WikiArticleView | undefined {
  if (!SAFE_SEGMENT_RE.test(slug)) return undefined;
  const store = liveWikiSegments(harnessDir);
  if (store === undefined) return undefined;
  const path = resolveInside(harnessDir, [...store, "articles", `${slug}.md`]);
  if (path === undefined) return undefined;
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    size = stat.size;
  } catch {
    return undefined;
  }
  const { text, truncated } = readTextCapped(path, MAX_TEXT_BYTES);
  if (text === "" && size > 0) return undefined;
  try {
    const article = parseArticle(text);
    return {
      slug,
      title: maskText(article.title),
      body: maskText(article.body),
      version: article.version,
      truncated,
    };
  } catch {
    // No usable frontmatter (a hand-written file, or a pre-store article):
    // the document as it is, with no version of its own to claim.
    return { slug, title: maskText(slug), body: maskText(text), version: null, truncated };
  }
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
  const path = resolveInside(harnessDir, segments);
  if (path === undefined || !existsSync(path)) return null;
  return maskText(readTextCapped(path, MAX_TEXT_BYTES).text);
}

export function stateView(harnessDir: string): StateView {
  const store = liveStore(harnessDir, "state", liveSpecName(harnessDir), STATE_STORE_PROBE);
  if (store === undefined) return { focus: null, goals: null, plans: [] };
  const plansDir = resolveInside(harnessDir, [...store.segments, "plans"]);
  const plans: Array<{ file: string; text: string }> = [];
  if (plansDir !== undefined) {
    for (const name of listDirSafe(plansDir)) {
      if (!name.endsWith(".md") || !SAFE_SEGMENT_RE.test(name)) continue;
      const text = readContainedText(harnessDir, [...store.segments, "plans", name]);
      if (text === null) continue;
      plans.push({ file: name, text });
    }
  }
  return {
    focus: readContainedText(harnessDir, [...store.segments, "focus.md"]),
    goals: readContainedText(harnessDir, [...store.segments, "goals.yaml"]),
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
