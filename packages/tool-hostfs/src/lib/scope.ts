/**
 * Keeping answers inside the boundary the caller asked for, and inside the
 * one the workspace imposes.
 *
 * The OS file index knows about the whole machine. This package returns only
 * what is inside the search roots, and the roots themselves are already
 * contained to the workspace by `../paths.ts`. That ordering is the security
 * property: a query can be as broad as you like, but a path outside the roots
 * is dropped here, after the backend answered and before anything is
 * returned — so the index cannot be used to enumerate a home directory.
 *
 * The filtering happens BEFORE the limit for a different reason, a
 * correctness one. `plocate` has no way to scope a search to a directory at
 * all, so a `--limit 50` on a busy machine can come back with fifty hits that
 * are all outside the roots, and a tool that applied the caller's limit first
 * would answer "nothing here" while the matches sat just past the cap.
 */

const REGEXP_METACHARS = /[.*+?^${}()|[\]\\]/g;

function escapeRe(value: string): string {
  return value.replace(REGEXP_METACHARS, "\\$&");
}

/**
 * `**​/**​/` means exactly what `**​/` means — zero or more whole segments —
 * but compiling both of them emits two adjacent `(?:[^/]+/)*` groups, and
 * adjacent groups that can each absorb the same segments are the classic
 * catastrophic-backtracking shape: matching a 24-segment path against a
 * pattern holding twelve of them took over a SECOND here, and every extra
 * `**​/` multiplies it. The patterns are caller-supplied (`exclude`, and
 * `WatchPath`'s `match`), and the matcher runs on the same event loop the
 * watch's own deadline timer lives on, so a pattern like that does not just
 * make the tool slow — it stops the deadline from firing at all.
 *
 * Collapsing the run first is a rewrite, not a restriction: the two patterns
 * accept exactly the same paths, and the collapsed one has nothing to
 * backtrack between.
 */
function collapseDoubleStars(pattern: string): string {
  let out = pattern;
  // Bounded: every pass removes three characters, so it cannot spin.
  for (let pass = 0; pass < pattern.length; pass += 1) {
    const next = out.replace("**/**", "**");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * The regular-expression source a glob compiles to.
 *
 * Exported so the SHAPE of the compiled pattern can be asserted directly. A
 * test that measured how long a match takes would be asserting a stopwatch,
 * which this repo does not allow and a loaded CI box would make flake; the
 * number of cross-segment groups is the same fact, stated as a fact.
 */
export function globRegexSource(rawPattern: string): string {
  const pattern = collapseDoubleStars(rawPattern);
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        const after = i + 2;
        const atSegmentEnd = after >= pattern.length || pattern[after] === "/";
        if (atSegmentStart && atSegmentEnd) {
          if (after < pattern.length) {
            // A leading `**/` may also swallow the root separator, so that
            // `**/*.test.ts` matches the ABSOLUTE path `/w/src/a.test.ts`.
            // Without this the exclude patterns silently matched nothing,
            // because every path this package filters is absolute.
            source += i === 0 ? "(?:/?[^/]+/)*" : "(?:[^/]+/)*";
            i = after + 1; // consume the `/` as part of the group
            continue;
          }
          source += ".*";
          i = after;
          continue;
        }
      }
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    source += escapeRe(char);
    i += 1;
  }
  return source;
}

/**
 * Compile a slash-separated glob to a whole-path matcher.
 *
 * `*` matches within one segment, `**` spans segments, `?` is one character.
 * Written out here rather than imported: `@crewhaus/tool-fsx`'s matcher is
 * internal to that package (not on its public entry), and `Bun.Glob` would
 * make the semantics depend on a runtime rather than on this file.
 */
export function compileGlob(pattern: string): (path: string) => boolean {
  const re = new RegExp(`^${globRegexSource(pattern)}$`);
  return (path: string): boolean => re.test(path);
}

/** True when `candidate` is `root` itself or lives beneath it. */
export function isInsideRoot(candidate: string, root: string): boolean {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === base || candidate.startsWith(`${base}/`);
}

export type ScopeResult = {
  readonly kept: readonly string[];
  /** Hits the backend returned that were outside every root. */
  readonly outOfScope: number;
  /** Hits dropped by an exclude pattern. */
  readonly excluded: number;
};

/**
 * Drop everything outside the roots, then everything the excludes match.
 *
 * Order is preserved — the backend's own relevance order is part of the
 * answer, and re-sorting it would be inventing a ranking nobody measured.
 * De-duplication is by path, because two overlapping roots make `mdfind`
 * return the same file twice.
 */
export function scopeResults(
  paths: readonly string[],
  roots: readonly string[],
  excludes: readonly ((path: string) => boolean)[],
): ScopeResult {
  const kept: string[] = [];
  const seen = new Set<string>();
  let outOfScope = 0;
  let excluded = 0;
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!roots.some((root) => isInsideRoot(path, root))) {
      outOfScope += 1;
      continue;
    }
    if (excludes.some((matches) => matches(path))) {
      excluded += 1;
      continue;
    }
    kept.push(path);
  }
  return { kept, outOfScope, excluded };
}

/**
 * Drop the last entry of a listing that was cut at the output cap.
 *
 * Both backends are asked for a NUL-SEPARATED listing, so when the captured
 * stream hit its ceiling the final element is whatever fitted of a path, with
 * no separator after it. It looks exactly like a complete short path, it
 * passes the root filter (its prefix is still inside the root), and it is then
 * reported as a match — a file that does not exist, invented by the cap. So it
 * is dropped and the drop is counted, and the answer carries the truncation
 * rather than looking like a complete list of what the index holds.
 */
export function dropTruncatedTail(
  paths: readonly string[],
  truncated: boolean,
): { readonly paths: readonly string[]; readonly partialDropped: number } {
  if (!truncated || paths.length === 0) return { paths, partialDropped: 0 };
  return { paths: paths.slice(0, -1), partialDropped: 1 };
}

/** Apply the caller's limit, saying whether anything was left behind. */
export function applyLimit<T>(
  items: readonly T[],
  limit: number,
): { readonly items: readonly T[]; readonly truncated: boolean } {
  if (items.length <= limit) return { items, truncated: false };
  return { items: items.slice(0, limit), truncated: true };
}
