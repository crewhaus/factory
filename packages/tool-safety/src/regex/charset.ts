/**
 * Sets of code points, for the static regex screen.
 *
 * The screen only ever asks two questions of a set — "could these two atoms
 * match the same character?" and "is this character in it?" — so a set is a
 * sorted list of inclusive ranges and nothing more.
 *
 * Every set the screen builds is an OVER-approximation of what the engine
 * would really match. That is the property that keeps the screen on the safe
 * side: a set that is too large can only make two atoms look like they
 * overlap when they do not, which refuses a pattern that was fine. A set that
 * is too small would let an overlapping pattern through. When a construct is
 * too awkward to model exactly (a `v`-mode class, a Unicode property escape),
 * it becomes {@link UNIVERSAL}.
 */

export const MAX_CODE_POINT = 0x10ffff;

/** Flat `[lo0, hi0, lo1, hi1, …]`, sorted, non-overlapping, non-adjacent. */
export type CharSet = readonly number[];

export const EMPTY: CharSet = [];
export const UNIVERSAL: CharSet = [0, MAX_CODE_POINT];

export function single(cp: number): CharSet {
  return [cp, cp];
}

export function range(lo: number, hi: number): CharSet {
  return lo <= hi ? [lo, hi] : [hi, lo];
}

/** Normalise any list of ranges into a {@link CharSet}. */
export function fromRanges(ranges: ReadonlyArray<readonly [number, number]>): CharSet {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [lo, hi] of sorted) {
    const last = out.length - 1;
    if (last >= 1 && lo <= (out[last] as number) + 1) {
      out[last] = Math.max(out[last] as number, hi);
    } else {
      out.push(lo, hi);
    }
  }
  return out;
}

function pairs(set: CharSet): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < set.length; i += 2) out.push([set[i] as number, set[i + 1] as number]);
  return out;
}

export function union(...sets: ReadonlyArray<CharSet>): CharSet {
  return fromRanges(sets.flatMap(pairs));
}

export function complement(set: CharSet): CharSet {
  const out: number[] = [];
  let next = 0;
  for (const [lo, hi] of pairs(set)) {
    if (lo > next) out.push(next, lo - 1);
    next = hi + 1;
  }
  if (next <= MAX_CODE_POINT) out.push(next, MAX_CODE_POINT);
  return out;
}

export function has(set: CharSet, cp: number): boolean {
  let lo = 0;
  let hi = set.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = set[mid * 2] as number;
    const b = set[mid * 2 + 1] as number;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** True when the two sets share at least one code point. */
export function intersects(a: CharSet, b: CharSet): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const aLo = a[i] as number;
    const aHi = a[i + 1] as number;
    const bLo = b[j] as number;
    const bHi = b[j + 1] as number;
    if (aHi < bLo) i += 2;
    else if (bHi < aLo) j += 2;
    else return true;
  }
  return false;
}

export function isEmpty(set: CharSet): boolean {
  return set.length === 0;
}

// ─── Named classes ──────────────────────────────────────────────────────────

export const DIGIT: CharSet = [0x30, 0x39];

/** `[A-Za-z0-9_]` — the `\w` of every mode; `i` + `u`/`v` widen it via {@link fold}. */
export const WORD: CharSet = fromRanges([
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
]);

/** ECMAScript WhiteSpace ∪ LineTerminator — exactly what `\s` matches. */
export const SPACE: CharSet = fromRanges([
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]);

const LINE_TERMINATORS: CharSet = fromRanges([
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
]);

/** What `.` matches: everything but a line terminator, or everything under `s`. */
export function dot(dotAll: boolean): CharSet {
  return dotAll ? UNIVERSAL : complement(LINE_TERMINATORS);
}

// ─── Case folding ───────────────────────────────────────────────────────────

/**
 * Case-equivalence classes over the BMP, built once on first use.
 *
 * Under `i` the engine compares canonicalised characters, and the two
 * canonicalisations (`toUpperCase` without `u`, simple case folding with it)
 * are not each other's inverse: `ſ` upper-cases to `S`, but nothing lower-
 * cases to `ſ`. Joining every code point with BOTH of its single-code-point
 * mappings, transitively, yields classes that contain every character either
 * mode could treat as equal — a superset, which is the safe direction.
 *
 * Astral code points are not folded (the Deseret and Adlam pairs, say). A
 * pattern that relies on those overlapping under `i` can slip past the
 * screen; the deadline still bounds it.
 */
type FoldIndex = {
  /** Every code point that has a case partner, ascending. */
  readonly members: Int32Array;
  /** For each entry of `members`, its whole class (itself included). */
  readonly classes: ReadonlyArray<readonly number[]>;
};

let foldIndex: FoldIndex | undefined;

function buildFoldIndex(): FoldIndex {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as number;
    return root;
  };
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent.set(ra, rb);
    if (!parent.has(rb)) parent.set(rb, rb);
  };
  for (let cp = 0; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCharCode(cp);
    for (const mapped of [ch.toUpperCase(), ch.toLowerCase()]) {
      if (mapped === ch) continue;
      const code = mapped.codePointAt(0) as number;
      // Only single-code-point mappings take part in regex canonicalisation.
      if (String.fromCodePoint(code) !== mapped) continue;
      if (!parent.has(cp)) parent.set(cp, cp);
      if (!parent.has(code)) parent.set(code, code);
      join(cp, code);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (const cp of parent.keys()) {
    const root = find(cp);
    const list = byRoot.get(root) ?? [];
    list.push(cp);
    byRoot.set(root, list);
  }
  const pairs: Array<[number, readonly number[]]> = [];
  for (const list of byRoot.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a - b);
    for (const cp of list) pairs.push([cp, list]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return {
    members: Int32Array.from(pairs, ([cp]) => cp),
    classes: pairs.map(([, list]) => list),
  };
}

/** Index of the first entry of `members` that is >= `cp`. */
function lowerBound(members: Int32Array, cp: number): number {
  let lo = 0;
  let hi = members.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((members[mid] as number) < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Recently folded sets. The screen folds the same few sets over and over. */
const foldMemo = new Map<string, CharSet>();
const FOLD_MEMO_ENTRIES = 512;

/**
 * The set closed under case equivalence: if any member of a case class is in
 * the set, every member is. Exact for the BMP.
 *
 * Its cost depends on how many case-paired characters the set holds, not on
 * the number of classes: each range is located in a sorted index by binary
 * search, so a single literal costs a few comparisons. Results are memoised.
 * `charge` is told what the work costs, and the set's key, whether or not
 * the memo answers, so a caller's accounting does not depend on what was
 * folded before.
 */
export function fold(set: CharSet, charge?: (units: number, key: string) => void): CharSet {
  const key = set.join(",");
  charge?.(foldCost(set), key);
  const hit = foldMemo.get(key);
  if (hit !== undefined) return hit;
  foldIndex ??= buildFoldIndex();
  const { members, classes } = foldIndex;
  const extra: Array<[number, number]> = [];
  for (let r = 0; r + 1 < set.length; r += 2) {
    const lo = set[r] as number;
    const hi = set[r + 1] as number;
    for (let i = lowerBound(members, lo); i < members.length; i++) {
      if ((members[i] as number) > hi) break;
      for (const cp of classes[i] as readonly number[]) if (!has(set, cp)) extra.push([cp, cp]);
    }
  }
  const out = extra.length === 0 ? set : union(set, fromRanges(extra));
  if (foldMemo.size >= FOLD_MEMO_ENTRIES) foldMemo.clear();
  foldMemo.set(key, out);
  return out;
}

/**
 * The cost {@link fold} pays for `set` when it is not memoised, in the
 * screen's work units: one per range, plus one per case-paired member it
 * visits.
 */
function foldCost(set: CharSet): number {
  foldIndex ??= buildFoldIndex();
  const { members } = foldIndex;
  let cost = 1;
  for (let r = 0; r + 1 < set.length; r += 2) {
    cost +=
      1 + lowerBound(members, (set[r + 1] as number) + 1) - lowerBound(members, set[r] as number);
  }
  return cost;
}
