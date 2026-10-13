/**
 * The done-claim pattern's match, found by a scan.
 *
 * The pattern's "marked … as done" clause read to the end of the sentence
 * from every `marked` in it before giving back characters, so a sentence of
 * them took time quadratic in its length (40 000 characters: a sixth of a
 * second, growing fourfold with each doubling). The sentence is an agent's.
 * From every `marked` in one stretch without `.`, `?` or `!` the clause's
 * greedy body reaches the same end, and so the same last `as done`: the scan
 * finds it once per stretch. done-claim.test.ts checks the scan against the
 * pattern.
 */

/** The pattern, matched by the regex engine; it is quadratic in a run of `marked`. */
export const DONE_CLAIM_PATTERN =
  /\b(i(?:'ve| have)?(?: now| also| just)? (?:completed|finished|implemented|fixed|deployed|created|built|updated|wrote|added|shipped|migrated|merged)|(?:is|are|was|were|has been|have been)(?: now| all)? (?:complete|completed|done|finished|deployed|fixed|implemented|shipped|merged)|marked [^.?!]* as (?:done|complete))\b/i;

/** The first two alternatives and the closing `\b`, sticky: bounded, so linear. */
const SHORT_CLAIM =
  /(?:i(?:'ve| have)?(?: now| also| just)? (?:completed|finished|implemented|fixed|deployed|created|built|updated|wrote|added|shipped|migrated|merged)|(?:is|are|was|were|has been|have been)(?: now| all)? (?:complete|completed|done|finished|deployed|fixed|implemented|shipped|merged))\b/iy;

type Found = { readonly index: number; readonly end: number } | null;

const isWordChar = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f;

const isStop = (code: number): boolean => code === 0x2e || code === 0x3f || code === 0x21;

/** `word` (lowercase ASCII) at `at`, any ASCII case, as `i` matches without `u`. */
function hasFolded(text: string, at: number, word: string): boolean {
  if (at + word.length > text.length) return false;
  for (let k = 0; k < word.length; k++) {
    const want = word.charCodeAt(k);
    const got = text.charCodeAt(at + k);
    if (got !== want && !(want >= 0x61 && want <= 0x7a && got === want - 0x20)) return false;
  }
  return true;
}

/** Where ` as (?:done|complete)\b` ends at `at`, or -1. */
function asDoneEnd(text: string, at: number): number {
  if (!hasFolded(text, at, " as ")) return -1;
  for (const word of ["done", "complete"]) {
    const end = at + 4 + word.length;
    if (hasFolded(text, at + 4, word) && !isWordChar(text.charCodeAt(end))) return end;
  }
  return -1;
}

/** The match of {@link DONE_CLAIM_PATTERN} in `text`, from its start. */
export function findDoneClaim(text: string): Found {
  // The last ` as done` of the stretch that ends at `stop`, cached per stretch.
  let stretchStop = -1;
  let stretchClaimEnd = -1;
  let stretchClaimAt = -1;
  for (let at = 0; at < text.length; at++) {
    if (at > 0 && isWordChar(text.charCodeAt(at - 1))) continue;
    if (!isWordChar(text.charCodeAt(at))) continue;
    SHORT_CLAIM.lastIndex = at;
    const short = SHORT_CLAIM.exec(text);
    if (short !== null) return { index: at, end: at + short[0].length };
    if (!hasFolded(text, at, "marked ")) continue;
    const body = at + 7;
    if (body > stretchStop) {
      let stop = body;
      while (stop < text.length && !isStop(text.charCodeAt(stop))) stop++;
      stretchStop = stop;
      stretchClaimAt = -1;
      stretchClaimEnd = -1;
      for (let e = stop - 1; e >= body; e--) {
        const end = asDoneEnd(text, e);
        if (end !== -1) {
          stretchClaimAt = e;
          stretchClaimEnd = end;
          break;
        }
      }
    }
    if (stretchClaimAt >= body) return { index: at, end: stretchClaimEnd };
  }
  return null;
}

/**
 * A RegExp whose `exec` is {@link findDoneClaim}: the pattern's own source
 * and flags, so callers read and use it as before, and every `exec`, `test`
 * or `match` on it takes the scan.
 */
class ScannedDoneClaim extends RegExp {
  constructor() {
    super(DONE_CLAIM_PATTERN.source, DONE_CLAIM_PATTERN.flags);
  }

  /** Derived patterns (`split`, `matchAll`) are plain ones. */
  static override get [Symbol.species](): RegExpConstructor {
    return RegExp;
  }

  override exec(text: string): RegExpExecArray | null {
    const input = String(text);
    const found = findDoneClaim(input);
    if (found === null) return null;
    const value = input.slice(found.index, found.end);
    const match = [value, value] as unknown as RegExpExecArray;
    match.index = found.index;
    match.input = input;
    match.groups = undefined;
    return match;
  }
}

/** {@link DONE_CLAIM_PATTERN}, matched by {@link findDoneClaim}. */
export const DONE_CLAIM_SCANNED: RegExp = new ScannedDoneClaim();
