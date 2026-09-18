/**
 * Glob → RegExp, with the semantics git and shell globs share.
 *
 * This is the one matcher the package uses, for `FindFiles` name patterns,
 * `Tree` exclusions and `.gitignore` rules, so that a pattern means the same
 * thing everywhere. It is deliberately not Bun.Glob: the gitignore rules need
 * a *source* string they can anchor themselves, and a matcher whose treatment
 * of `/` is spelled out rather than inherited.
 *
 * Supported: `*` (any run of characters except `/`), `**` as a whole path
 * segment (any number of segments, including none), `?` (one character except
 * `/`), `[abc]` / `[a-z]` / `[!abc]` character classes, and `\` to escape the
 * next character. Everything else is literal.
 */

const REGEXP_METACHARS = /[.*+?^${}()|[\]\\]/g;

/** What a `**\/` segment compiles to: zero or more whole path segments. */
const SEGMENTS_GROUP = "(?:[^/]+/)*";

/** Escape one character for literal use inside a RegExp. */
function escapeRe(ch: string): string {
  return ch.replace(REGEXP_METACHARS, "\\$&");
}

/**
 * Compile a slash-separated glob to a RegExp source that matches a whole
 * path. The result is unanchored — callers add `^`/`$` (or a prefix) so they
 * control whether the pattern is anchored to a directory.
 */
export function globToRegExpSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;

    if (c === "\\") {
      const next = pattern[i + 1];
      if (next !== undefined) {
        out += escapeRe(next);
        i += 2;
        continue;
      }
      out += "\\\\";
      i += 1;
      continue;
    }

    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` is only special as a complete path segment; `a**b` is just `a*b`.
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        const afterStars = i + 2;
        const atSegmentEnd = afterStars >= pattern.length || pattern[afterStars] === "/";
        if (atSegmentStart && atSegmentEnd) {
          if (afterStars < pattern.length) {
            // `**/` — zero or more leading path segments. Adjacent groups are
            // collapsed: `**/**/x` means exactly what `**/x` means, but two
            // nested `(?:...)*` give the engine an exponential number of ways
            // to split the same input, so `**/` repeated a dozen times turns
            // a non-match into a walk that never returns.
            if (!out.endsWith(SEGMENTS_GROUP)) out += SEGMENTS_GROUP;
            i = afterStars + 1;
          } else {
            // Trailing `**` — everything below this point.
            out += ".*";
            i = afterStars;
          }
          continue;
        }
      }
      out += "[^/]*";
      i += 1;
      continue;
    }

    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }

    if (c === "[") {
      const compiled = compileCharClass(pattern, i);
      if (compiled === undefined) {
        // Unterminated class — treat the bracket as a literal, as shells do.
        out += "\\[";
        i += 1;
        continue;
      }
      out += compiled.source;
      i = compiled.next;
      continue;
    }

    out += escapeRe(c);
    i += 1;
  }
  return out;
}

function compileCharClass(
  pattern: string,
  start: number,
): { source: string; next: number } | undefined {
  let j = start + 1;
  let source = "[";
  const first = pattern[j];
  if (first === "!" || first === "^") {
    source += "^";
    j += 1;
  }
  // A `]` immediately after the (optional) negation is a literal member.
  if (pattern[j] === "]") {
    source += "\\]";
    j += 1;
  }
  while (j < pattern.length && pattern[j] !== "]") {
    const ch = pattern[j] as string;
    if (ch === "\\") {
      const next = pattern[j + 1];
      if (next === undefined) return undefined;
      source += `\\${next.replace(REGEXP_METACHARS, "\\$&")}`;
      j += 2;
      continue;
    }
    // `-` keeps its range meaning; `[` and `^` must not start a nested class.
    source += ch === "[" || ch === "^" ? `\\${ch}` : ch;
    j += 1;
  }
  if (j >= pattern.length) return undefined;
  return { source: `${source}]`, next: j + 1 };
}

/** Compile a glob into an anchored, whole-string matcher. */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globToRegExpSource(pattern)}$`);
}

/** True when `value` matches `pattern` end to end. */
export function matchGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}
