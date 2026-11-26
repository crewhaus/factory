/**
 * `@crewhaus/wiki-store/erasure`: removing articles for good, driven only by the erasure
 * door. Every other edit keeps the version it replaces; these two do not, so they act only on
 * a grant the door minted: one whose scope is this store's own root and spec, and that names
 * the slug or the sessions.
 *
 * - {@link erase} removes one article: its file, every kept version and its index entry.
 * - {@link eraseVersions} removes the versions written in the named sessions. An article
 *   whose current version goes rolls back to the newest version left, or goes with it.
 *
 * Both hold the store's lock, resolve every path inside the store before anything is
 * unlinked, rebuild `index.json` from the articles left, and find nothing on a re-run.
 */
import {
  type Stats,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type ErasureGrant, erasureTargets } from "@crewhaus/control-contract/knowledge";
import { openForReadSync, resolveContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import {
  ARTICLE_MAX_BYTES,
  type WikiArticle,
  WikiStoreError,
  extractWikilinks,
  isWikiSlug,
  parseArticle,
  withLock,
} from "./index";

/** The store a purge acts on. */
export type WikiErasureAt = { readonly rootDir: string; readonly specName: string };

export type WikiErasure = {
  /** Articles removed. */
  readonly articles: number;
  /** Versions removed, an article's current one included. */
  readonly versions: number;
  /** Articles whose current version is an earlier one now. */
  readonly rolledBack: number;
};

const NOTHING: WikiErasure = { articles: 0, versions: 0, rolledBack: 0 };
const SPEC_NAME_RE = /^[a-zA-Z0-9_\-.]+$/;
const VERSION_FILE_RE = /^([1-9]\d*)\.md$/;

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function targetsOf(at: WikiErasureAt, grant: ErasureGrant): ReadonlySet<string> {
  if (!SPEC_NAME_RE.test(at.specName) || /^\.+$/.test(at.specName)) {
    throw new WikiStoreError(`invalid specName "${at.specName}"`);
  }
  const root = resolve(at.rootDir);
  const targets = erasureTargets(grant, {
    store: "wiki",
    spec: at.specName,
    sameRoot: (given) => sameDir(given, root),
  });
  if (targets === undefined) {
    throw new WikiStoreError(
      `this erasure does not cover the ${at.specName} wiki in ${at.rootDir}`,
    );
  }
  return targets;
}

/** The store's files, contained. */
function filesOf(at: WikiErasureAt) {
  const storeDir = resolve(at.rootDir, at.specName);

  /** What is at `rel`, inside the store; `undefined` when nothing is. */
  function found(rel: string): { readonly real: string; readonly stats: Stats } | undefined {
    const at = resolveContained(storeDir, rel, { followLeaf: false });
    if (!at.ok) {
      if (at.code === "not-found") return undefined;
      throw new WikiStoreError(`refusing to erase ${rel} in the wiki store: ${at.reason}`);
    }
    try {
      return { real: at.real, stats: lstatSync(at.real) };
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /** Remove a file, or a link at its name; a directory there is refused. */
  function removeFile(rel: string): boolean {
    const at = found(rel);
    if (at === undefined) return false;
    if (at.stats.isDirectory()) {
      throw new WikiStoreError(`refusing to erase ${rel} in the wiki store: it is a directory`);
    }
    unlinkSync(at.real);
    return true;
  }

  /** A directory that is really one, or `undefined` when nothing is there. */
  function directory(rel: string): string | undefined {
    const at = found(rel);
    if (at === undefined) return undefined;
    if (!at.stats.isDirectory()) {
      throw new WikiStoreError(`refusing to erase ${rel} in the wiki store: not a directory`);
    }
    return at.real;
  }

  /** The files in a store directory; none when it is not there. */
  function names(rel: string): string[] {
    const dir = directory(rel);
    if (dir === undefined) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  }

  function removeDir(rel: string): void {
    const dir = directory(rel);
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }

  function read(rel: string): string | undefined {
    const got = openForReadSync(storeDir, rel, {
      maxBytes: ARTICLE_MAX_BYTES,
      followLeafSymlink: false,
    });
    if (!got.ok) {
      if (got.code === "not-found") return undefined;
      throw new WikiStoreError(`refusing to read ${rel} in the wiki store: ${got.reason}`);
    }
    return got.truncated ? undefined : got.text;
  }

  function write(rel: string, text: string): void {
    const written = writeFileSafe(storeDir, rel, text, { overwrite: true, mode: 0o600 });
    if (!written.ok) {
      throw new WikiStoreError(`refusing to write ${rel} in the wiki store: ${written.reason}`);
    }
  }

  /** Remove a directory that holds nothing any more. */
  function removeEmptyDir(rel: string): void {
    const dir = directory(rel);
    if (dir === undefined) return;
    try {
      rmdirSync(dir);
    } catch {
      // Something is still in it.
    }
  }

  return { storeDir, found, removeFile, removeDir, removeEmptyDir, names, read, write };
}

type Files = ReturnType<typeof filesOf>;

const articleRel = (slug: string): string => join("articles", `${slug}.md`);
const versionsRel = (slug: string): string => join("versions", slug);

function slugsIn(files: Files): string[] {
  return files
    .names("articles")
    .filter((name) => name.endsWith(".md") && isWikiSlug(name.slice(0, -3)))
    .map((name) => name.slice(0, -3));
}

function tryParse(text: string | undefined): WikiArticle | undefined {
  if (text === undefined) return undefined;
  try {
    return parseArticle(text);
  } catch {
    return undefined;
  }
}

/** Write `index.json` from the articles that are left, replacing a link planted at its name. */
function rebuildIndex(files: Files): void {
  const articles: Record<string, unknown> = {};
  for (const slug of slugsIn(files)) {
    const article = tryParse(files.read(articleRel(slug)));
    if (article === undefined) continue;
    articles[slug] = {
      title: article.title,
      tags: [...article.tags],
      confidence: article.confidence,
      verified: article.verified,
      version: article.version,
      updatedAt: article.updatedAt,
      links: extractWikilinks(article.body, article.slug),
      status: article.status,
    };
  }
  const index = join(files.storeDir, "index.json");
  try {
    if (lstatSync(index).isSymbolicLink()) unlinkSync(index);
  } catch {
    // Nothing there yet.
  }
  files.write("index.json", `${JSON.stringify({ version: 1, articles }, null, 2)}\n`);
}

function locked<T>(files: Files, fn: () => T): Promise<T> {
  return withLock(join(files.storeDir, ".lock"), async () => fn());
}

/** Whether the store has anything of this article: its file, a version, or an index entry. */
function holds(files: Files, slug: string): boolean {
  if ([articleRel(slug), versionsRel(slug)].some((rel) => files.found(rel) !== undefined)) {
    return true;
  }
  if (files.found("index.json")?.stats.isFile() !== true) return false;
  return files.read("index.json")?.includes(`"${slug}"`) === true;
}

/** Remove one article, its kept versions and its index entry. */
export async function erase(
  at: WikiErasureAt,
  slug: string,
  grant: ErasureGrant,
): Promise<WikiErasure> {
  const targets = targetsOf(at, grant);
  if (!isWikiSlug(slug) || !targets.has(slug)) {
    throw new WikiStoreError("this erasure does not name the article it was given");
  }
  const files = filesOf(at);
  if (!holds(files, slug)) return NOTHING;
  return locked(files, () => {
    const kept = files.names(versionsRel(slug)).filter((name) => VERSION_FILE_RE.test(name));
    files.removeDir(versionsRel(slug));
    const gone = files.removeFile(articleRel(slug));
    rebuildIndex(files);
    return { articles: gone ? 1 : 0, versions: kept.length + (gone ? 1 : 0), rolledBack: 0 };
  });
}

/** Remove the versions written in these sessions, rolling an article back where it must be. */
export async function eraseVersions(
  at: WikiErasureAt,
  opts: { readonly sessions: readonly string[] },
  grant: ErasureGrant,
): Promise<WikiErasure> {
  const targets = targetsOf(at, grant);
  for (const session of opts.sessions) {
    if (!targets.has(session)) {
      throw new WikiStoreError("this erasure does not name every conversation it was given");
    }
  }
  const sessions = new Set(opts.sessions);
  const files = filesOf(at);
  const written = (article: WikiArticle | undefined): boolean =>
    article?.createdBy !== undefined && sessions.has(article.createdBy.sessionId);
  if (sessions.size === 0 || versionsWrittenIn(at, opts.sessions).length === 0) return NOTHING;
  return locked(files, () => {
    let articles = 0;
    let versions = 0;
    let rolledBack = 0;
    for (const slug of slugsIn(files)) {
      const dir = versionsRel(slug);
      const left: number[] = [];
      let removed = 0;
      for (const name of files.names(dir)) {
        const n = Number(VERSION_FILE_RE.exec(name)?.[1]);
        if (!Number.isSafeInteger(n)) continue;
        if (written(tryParse(files.read(join(dir, name))))) {
          if (files.removeFile(join(dir, name))) removed += 1;
        } else {
          left.push(n);
        }
      }
      if (written(tryParse(files.read(articleRel(slug))))) {
        removed += 1;
        const newest = left.length > 0 ? Math.max(...left) : undefined;
        const text = newest !== undefined ? files.read(join(dir, `${newest}.md`)) : undefined;
        if (text !== undefined && newest !== undefined) {
          files.write(articleRel(slug), text);
          files.removeFile(join(dir, `${newest}.md`));
          rolledBack += 1;
        } else {
          files.removeFile(articleRel(slug));
          articles += 1;
        }
      }
      versions += removed;
      if (removed > 0) files.removeEmptyDir(dir);
    }
    rebuildIndex(files);
    return { articles, versions, rolledBack };
  });
}

/** Every version written in these sessions, the current ones included. Reads only. */
export function versionsWrittenIn(
  at: WikiErasureAt,
  sessions: readonly string[],
): readonly { readonly slug: string; readonly version: number; readonly current: boolean }[] {
  const wanted = new Set(sessions);
  const files = filesOf(at);
  const out: { slug: string; version: number; current: boolean }[] = [];
  const note = (slug: string, text: string | undefined, current: boolean): void => {
    const article = tryParse(text);
    if (article?.createdBy === undefined || !wanted.has(article.createdBy.sessionId)) return;
    out.push({ slug, version: article.version, current });
  };
  for (const slug of slugsIn(files)) {
    note(slug, files.read(articleRel(slug)), true);
    const dir = versionsRel(slug);
    for (const name of files.names(dir)) {
      if (VERSION_FILE_RE.test(name)) note(slug, files.read(join(dir, name)), false);
    }
  }
  return out;
}
