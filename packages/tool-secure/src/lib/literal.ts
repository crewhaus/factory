/**
 * A literal phrase, found in linear time, exactly where
 * `new RegExp(escaped, "g")` or `"gi"` finds it.
 *
 * ContentPolicyCheck's `*_phrase` rules ran as an escaped regex on the
 * caller's thread. Case-sensitive, JavaScriptCore finds a literal quickly;
 * case-insensitive (the default) it tries the whole phrase at every position,
 * so the scan costs the text's length times the phrase's. Neither is capped:
 * four rules of `a`×50 000 then `b` over 2 000 000 `a`s held the process for
 * 16.6 s without one event-loop turn (C073's residual, bounds review).
 *
 * Here the text and the phrase are folded to one code unit per character the
 * way the regex `i` flag compares them, and searched with Knuth-Morris-Pratt:
 * each text position is passed once, whatever the phrase. Matches are what a
 * global regex reports: leftmost, not overlapping, at UTF-16 code-unit
 * offsets.
 */

/** Where one match starts, and the text it covers (the text's own spelling). */
export type LiteralMatch = { readonly index: number; readonly match: string };

/** Every match counted, the first few located. */
export type LiteralFound = {
  readonly matches: ReadonlyArray<LiteralMatch>;
  readonly count: number;
};

/** Canonical code unit per code unit, filled on first use; -1 is "not yet". */
const CANONICAL = new Int32Array(0x10000).fill(-1);

/**
 * The code unit the regex `i` flag (without `u`) compares `c` as: the
 * ECMAScript Canonicalize — its upper case when that is one code unit, and not
 * ASCII for a non-ASCII `c` — as this engine's own tables have it. The
 * engine's case tables can be older than `toUpperCase`'s (Bun 1.3's upper-cases
 * U+019B to U+A7DC, which its regex does not match), so a pairing the regex
 * does not make is not made here either.
 */
export function canonicalUnit(c: number): number {
  const known = CANONICAL[c] as number;
  if (known !== -1) return known;
  let out = c;
  if (c < 0x80) {
    if (c >= 0x61 && c <= 0x7a) out = c - 0x20;
  } else {
    const upper = String.fromCharCode(c).toUpperCase();
    if (upper.length === 1) {
      const u = upper.charCodeAt(0);
      if (u >= 0x80 && u !== c && regexFolds(c, u)) out = u;
    }
  }
  CANONICAL[c] = out;
  return out;
}

function regexFolds(a: number, b: number): boolean {
  return new RegExp(`^\\u${a.toString(16).padStart(4, "0")}$`, "i").test(String.fromCharCode(b));
}

/** `text`'s code units, each folded as the regex `i` flag compares it. */
function foldUnits(text: string): Uint16Array {
  const out = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = canonicalUnit(text.charCodeAt(i));
  return out;
}

function rawUnits(text: string): Uint16Array {
  const out = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** KMP's failure function: for each prefix, its longest proper border. */
function borders(p: Uint16Array): Int32Array {
  const f = new Int32Array(p.length);
  let k = 0;
  for (let i = 1; i < p.length; i++) {
    while (k > 0 && p[i] !== p[k]) k = f[k - 1] as number;
    if (p[i] === p[k]) k += 1;
    f[i] = k;
  }
  return f;
}

/**
 * Searches one text for many phrases. The case-folded text is prepared once,
 * on first need, and shared by every case-insensitive phrase.
 */
export class LiteralSearch {
  #folded: string | undefined;

  constructor(private readonly text: string) {}

  #hay(caseSensitive: boolean): string {
    if (caseSensitive) return this.text;
    if (this.#folded === undefined) {
      this.#folded = Buffer.from(foldUnits(this.text).buffer).toString("utf16le");
    }
    return this.#folded;
  }

  /**
   * Every match of `phrase`, counted in full, with the first `keep` located.
   * An empty phrase matches at every position, as an empty regex does.
   *
   * Knuth-Morris-Pratt, except that from a standing start it jumps to the
   * next place the phrase's first two code units occur: no match can start
   * anywhere else, and a two-unit search passes each position once, so the
   * whole search still does. On prose that jump is most of the text.
   */
  find(phrase: string, caseSensitive: boolean, keep: number): LiteralFound {
    const text = this.text;
    const length = phrase.length;
    const matches: LiteralMatch[] = [];
    if (length === 0) {
      for (let i = 0; i <= text.length && matches.length < keep; i++) {
        matches.push({ index: i, match: "" });
      }
      return { matches, count: text.length + 1 };
    }
    if (length > text.length) return { matches, count: 0 };
    const hay = this.#hay(caseSensitive);
    const p = caseSensitive ? rawUnits(phrase) : foldUnits(phrase);
    const head = String.fromCharCode(...p.subarray(0, 2));
    const f = borders(p);
    let k = 0;
    let count = 0;
    for (let i = 0; i < hay.length; i++) {
      if (k === 0) {
        const next = hay.indexOf(head, i);
        if (next === -1) break;
        i = next;
      }
      const ch = hay.charCodeAt(i);
      while (k > 0 && ch !== p[k]) k = f[k - 1] as number;
      if (ch === p[k]) k += 1;
      if (k === length) {
        count += 1;
        if (matches.length < keep) {
          const at = i + 1 - length;
          matches.push({ index: at, match: text.slice(at, i + 1) });
        }
        // Not overlapping: the next match starts after this one ends.
        k = 0;
      }
    }
    return { matches, count };
  }
}
