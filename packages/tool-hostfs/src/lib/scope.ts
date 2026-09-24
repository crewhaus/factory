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

/**
 * `**​/**​/` means exactly what `**​/` means — zero or more whole segments —
 * so a run of them is collapsed to one before matching. It used to matter
 * because two adjacent RegExp groups that could each absorb the same
 * segments backtracked catastrophically; the matcher below no longer
 * backtracks, but the collapse still keeps the table small.
 */
export function collapseDoubleStars(pattern: string): string {
  let out = pattern;
  // Bounded: every pass removes three characters, so it cannot spin.
  for (let pass = 0; pass < pattern.length; pass += 1) {
    const next = out.replace("**/**", "**");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** One element of a segment pattern. */
type Token =
  | { readonly kind: "star" }
  | { readonly kind: "any" }
  | { readonly kind: "char"; readonly ch: string };

type Segment =
  | { readonly kind: "tokens"; readonly tokens: readonly Token[]; readonly fixed: number }
  /**
   * `**` followed by `/`: zero or more whole, non-empty segments. The
   * LEADING one (the pattern starts with it) may also take one empty segment
   * before each of them, so `**​/*.test.ts` matches the ABSOLUTE path
   * `/w/src/a.test.ts`, whose first segment is empty: every path this
   * package filters is absolute.
   */
  | { readonly kind: "globstar"; readonly leading: boolean }
  /** A trailing `**`: at least one more segment, of anything. */
  | { readonly kind: "rest" };

const STAR: Token = { kind: "star" };
const ANY: Token = { kind: "any" };

/**
 * Split a pattern into segments on `/`. `*` is any run within a segment, `?`
 * one character (one UTF-16 unit) within it, and every other character is
 * literal, `[` and `\` included: this package has never had classes or
 * escapes, and a pattern keeps meaning what it meant.
 */
function compileSegments(rawPattern: string): Segment[] {
  const raw = collapseDoubleStars(rawPattern).split("/");
  const out: Segment[] = [];
  for (let k = 0; k < raw.length; k++) {
    const text = raw[k] as string;
    if (text === "**") {
      out.push(k === raw.length - 1 ? { kind: "rest" } : { kind: "globstar", leading: k === 0 });
      continue;
    }
    const tokens: Token[] = [];
    for (const ch of text.split("")) {
      if (ch === "*") {
        // `a**b` is `a*b`; one star keeps the walk's backtracking linear.
        if (tokens[tokens.length - 1]?.kind !== "star") tokens.push(STAR);
      } else if (ch === "?") {
        tokens.push(ANY);
      } else {
        tokens.push({ kind: "char", ch });
      }
    }
    out.push({ kind: "tokens", tokens, fixed: tokens.filter((t) => t.kind !== "star").length });
  }
  return out;
}

/**
 * One path segment against one token list: the two-pointer wildcard walk,
 * which only ever returns to the LAST star, so it runs in
 * O(tokens × characters) where a RegExp tried every split between stars.
 */
function matchSegment(
  seg: { readonly tokens: readonly Token[]; readonly fixed: number },
  s: string,
): boolean {
  if (seg.fixed > s.length) return false;
  const tokens = seg.tokens;
  let p = 0;
  let i = 0;
  let starP = -1;
  let starI = 0;
  while (i < s.length) {
    const token = tokens[p];
    if (
      token !== undefined &&
      token.kind !== "star" &&
      (token.kind === "any" || token.ch === s[i])
    ) {
      p += 1;
      i += 1;
    } else if (token?.kind === "star") {
      starP = p;
      starI = i;
      p += 1;
    } else if (starP !== -1) {
      p = starP + 1;
      starI += 1;
      i = starI;
    } else {
      return false;
    }
  }
  while (tokens[p]?.kind === "star") p += 1;
  return p === tokens.length;
}

/**
 * A pattern's segments against a path's, as a table: `row[si]` answers "do
 * pattern segments pi.. match path segments si..", filled from the end, one
 * row per pattern segment. O(pattern segments × path segments) segment
 * matches, whatever the pattern.
 */
function matchSegments(segments: readonly Segment[], parts: readonly string[]): boolean {
  const n = parts.length;
  let next: boolean[] = new Array<boolean>(n + 2).fill(false);
  next[n] = true;
  for (let pi = segments.length - 1; pi >= 0; pi--) {
    const seg = segments[pi] as Segment;
    const row: boolean[] = new Array<boolean>(n + 2).fill(false);
    for (let si = n; si >= 0; si--) {
      if (seg.kind === "rest") {
        row[si] = si < n;
      } else if (seg.kind === "globstar") {
        const here = parts[si];
        row[si] =
          (next[si] as boolean) ||
          (here !== undefined && here !== "" && (row[si + 1] as boolean)) ||
          (seg.leading &&
            here === "" &&
            parts[si + 1] !== undefined &&
            parts[si + 1] !== "" &&
            (row[si + 2] as boolean));
      } else {
        row[si] = si < n && (next[si + 1] as boolean) && matchSegment(seg, parts[si] as string);
      }
    }
    next = row;
  }
  return next[0] as boolean;
}

/**
 * Compile a slash-separated glob to a whole-path matcher.
 *
 * `*` matches within one segment, `**` spans segments, `?` is one character.
 * It is not a RegExp: each `*` used to compile to `[^/]*`, and a backtracking
 * engine tries every way of dividing a segment between the stars, so
 * `*a*a*a*a*a*a*a*a*a*a*z` against a long file name took minutes,
 * synchronously, where neither WatchPath's deadline nor the turn's abort
 * signal can reach it (C162). The patterns are caller-supplied: WatchPath's
 * `match`, run per event, and OsIndexSearch's `exclude`, run per hit. Here a
 * pattern is matched segment by segment with the two-pointer walk, so the
 * cost is bounded by the product of the lengths. `lib.test.ts` holds the old
 * RegExp translation as an oracle and checks the two agree.
 */
export function compileGlob(pattern: string): (path: string) => boolean {
  const segments = compileSegments(pattern);
  return (path: string): boolean => matchSegments(segments, path.split("/"));
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
