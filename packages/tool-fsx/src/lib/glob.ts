/**
 * The glob matcher, with the semantics git and shell globs share.
 *
 * This is the one matcher the package uses, for `FindFiles` name patterns,
 * `Tree` exclusions and `.gitignore` rules, so that a pattern means the same
 * thing everywhere. It is deliberately not Bun.Glob: its treatment of `/` is
 * spelled out here rather than inherited.
 *
 * Supported: `*` (any run of characters except `/`), `**` as a whole path
 * segment (any number of segments, including none), `?` (one character except
 * `/`), `[abc]` / `[a-z]` / `[!abc]` / `[^abc]` character classes, and `\` to
 * escape the next character. Everything else is literal. A character is one
 * UTF-16 code unit, as it was when patterns compiled to a RegExp.
 *
 * WHY NOT A REGEXP. Patterns used to compile to one, each `*` becoming
 * `[^/]*`. A backtracking engine tries every way of dividing the text
 * between the stars, so `*a*a*a*a*a*a*b` against a name of eighty `a`s took
 * about four seconds, and a 255-character name, hours, synchronously, where
 * no timeout or abort signal can reach it. A committed `.gitignore` line and
 * one long file name were enough to hang `Tree`, which plan mode runs without
 * asking (security-11#4). Here a pattern is split into path segments and
 * matched with the two-pointer wildcard algorithm inside a segment, and a
 * table over (pattern segment, path segment) pairs across segments: the cost
 * is bounded by the product of the lengths, whatever the pattern.
 */

/** One element of a segment pattern: a single character's test, or a star. */
type Token =
  | { readonly kind: "star" }
  | { readonly kind: "any" }
  | { readonly kind: "char"; readonly ch: string }
  | {
      readonly kind: "class";
      readonly negated: boolean;
      readonly singles: string;
      readonly ranges: ReadonlyArray<readonly [number, number]>;
    };

/** A pattern segment: a token list, or a `**` segment. */
type Segment =
  | { readonly kind: "tokens"; readonly tokens: readonly Token[]; readonly fixed: number }
  /** `**` followed by `/`: zero or more whole, non-empty path segments. */
  | { readonly kind: "globstar" }
  /** A trailing `**`: everything below this point, at least one more segment. */
  | { readonly kind: "rest" };

const STAR: Token = { kind: "star" };
const ANY: Token = { kind: "any" };

/** What splitting a pattern on its separators yields, before `**` is recognised. */
type RawSegment = { tokens: Token[]; bareGlobstar: boolean };

/**
 * Parse a character class starting at `start` (the `[`). Returns undefined
 * for an unterminated class, which the caller treats as a literal `[`.
 */
function parseClass(pattern: string, start: number): { token: Token; next: number } | undefined {
  let j = start + 1;
  let negated = false;
  if (pattern[j] === "!" || pattern[j] === "^") {
    negated = true;
    j += 1;
  }
  const members: Array<{ ch: string; escaped: boolean }> = [];
  // A `]` immediately after the (optional) negation is a literal member.
  if (pattern[j] === "]") {
    members.push({ ch: "]", escaped: true });
    j += 1;
  }
  while (j < pattern.length && pattern[j] !== "]") {
    const ch = pattern[j] as string;
    if (ch === "\\") {
      const next = pattern[j + 1];
      if (next === undefined) return undefined;
      members.push({ ch: next, escaped: true });
      j += 2;
      continue;
    }
    members.push({ ch, escaped: false });
    j += 1;
  }
  if (j >= pattern.length) return undefined;
  let singles = "";
  const ranges: Array<[number, number]> = [];
  for (let k = 0; k < members.length; k++) {
    const here = members[k] as { ch: string; escaped: boolean };
    const dash = members[k + 1];
    const end = members[k + 2];
    // `x-y` is a range; a `-` first, last or escaped is itself.
    if (dash !== undefined && !dash.escaped && dash.ch === "-" && end !== undefined) {
      const lo = here.ch.charCodeAt(0);
      const hi = end.ch.charCodeAt(0);
      // An out-of-order range matches nothing (a RegExp refused to compile it).
      if (lo <= hi) ranges.push([lo, hi]);
      k += 2;
      continue;
    }
    singles += here.ch;
  }
  return { token: { kind: "class", negated, singles, ranges }, next: j + 1 };
}

/**
 * Split a pattern into segments on every `/` outside a class (escaped or
 * not: `\/` matched a slash before, and still does), tokenising each.
 */
function splitPattern(pattern: string): RawSegment[] {
  const segments: RawSegment[] = [];
  let tokens: Token[] = [];
  let starsOnly = 0; // unescaped `*`s in this segment, while it holds nothing else
  let other = false;
  const endSegment = (): void => {
    segments.push({ tokens, bareGlobstar: starsOnly === 2 && !other });
    tokens = [];
    starsOnly = 0;
    other = false;
  };
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "/") {
      endSegment();
      i += 1;
      continue;
    }
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        tokens.push({ kind: "char", ch: "\\" });
        other = true;
        i += 1;
        continue;
      }
      if (next === "/") {
        endSegment();
      } else {
        tokens.push({ kind: "char", ch: next });
        other = true;
      }
      i += 2;
      continue;
    }
    if (c === "*") {
      // Runs of stars collapse: `a**b` is `a*b`, and one star is enough to
      // keep the two-pointer walk linear in its backtracking.
      if (tokens[tokens.length - 1]?.kind !== "star") tokens.push(STAR);
      starsOnly += 1;
      i += 1;
      continue;
    }
    other = true;
    if (c === "?") {
      tokens.push(ANY);
      i += 1;
      continue;
    }
    if (c === "[") {
      const parsed = parseClass(pattern, i);
      if (parsed === undefined) {
        // Unterminated class — the bracket is literal, as shells treat it.
        tokens.push({ kind: "char", ch: "[" });
        i += 1;
        continue;
      }
      tokens.push(parsed.token);
      i = parsed.next;
      continue;
    }
    tokens.push({ kind: "char", ch: c });
    i += 1;
  }
  endSegment();
  return segments;
}

function compileSegments(pattern: string): Segment[] {
  const raw = splitPattern(pattern);
  const out: Segment[] = [];
  for (let k = 0; k < raw.length; k++) {
    const seg = raw[k] as RawSegment;
    if (seg.bareGlobstar) {
      if (k === raw.length - 1) {
        out.push({ kind: "rest" });
      } else if (out[out.length - 1]?.kind !== "globstar") {
        // `**/**/x` means exactly what `**/x` means.
        out.push({ kind: "globstar" });
      }
      continue;
    }
    const fixed = seg.tokens.filter((t) => t.kind !== "star").length;
    out.push({ kind: "tokens", tokens: seg.tokens, fixed });
  }
  // `**/` directly before a trailing `**` adds nothing to it.
  if (out[out.length - 1]?.kind === "rest") {
    while (out[out.length - 2]?.kind === "globstar") out.splice(out.length - 2, 1);
  }
  return out;
}

function tokenMatches(token: Token, code: number, ch: string): boolean {
  switch (token.kind) {
    case "any":
      return true;
    case "char":
      return token.ch === ch;
    case "class": {
      let hit = token.singles.includes(ch);
      if (!hit) {
        for (const [lo, hi] of token.ranges) {
          if (code >= lo && code <= hi) {
            hit = true;
            break;
          }
        }
      }
      return hit !== token.negated;
    }
    default:
      return false;
  }
}

/**
 * One path segment against one token list: the two-pointer wildcard walk,
 * which only ever returns to the LAST star, so it runs in
 * O(tokens × characters) where a regex tried every split between stars.
 */
function matchSegment(seg: { tokens: readonly Token[]; fixed: number }, s: string): boolean {
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
      tokenMatches(token, s.charCodeAt(i), s[i] as string)
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
 * A pattern's segments against a path's, as a table: `row[si]` answers
 * "do segments pi.. match path segments si..", filled from the end, one row
 * per pattern segment. O(pattern segments × path segments) segment matches.
 */
function matchSegments(segments: readonly Segment[], parts: readonly string[]): boolean {
  const n = parts.length;
  let fixed = 0;
  for (const seg of segments) if (seg.kind === "tokens") fixed += 1;
  if (fixed > n) return false;
  // Past the last pattern segment only the end of the path matches.
  let next: boolean[] = new Array<boolean>(n + 1).fill(false);
  next[n] = true;
  for (let pi = segments.length - 1; pi >= 0; pi--) {
    const seg = segments[pi] as Segment;
    const row: boolean[] = new Array<boolean>(n + 1).fill(false);
    for (let si = n; si >= 0; si--) {
      if (seg.kind === "rest") {
        // Everything below, but there must be something: `src/**` is not `src`.
        row[si] = si < n;
      } else if (seg.kind === "globstar") {
        row[si] = (next[si] as boolean) || (si < n && parts[si] !== "" && (row[si + 1] as boolean));
      } else {
        row[si] = si < n && (next[si + 1] as boolean) && matchSegment(seg, parts[si] as string);
      }
    }
    next = row;
  }
  return next[0] as boolean;
}

/** Compile a glob once into a whole-string test, for matching many subjects. */
export function compileGlob(pattern: string): (subject: string) => boolean {
  const segments = compileSegments(pattern);
  return (subject: string) => matchSegments(segments, subject.split("/"));
}

/** True when `value` matches `pattern` end to end. */
export function matchGlob(pattern: string, value: string): boolean {
  return compileGlob(pattern)(value);
}
