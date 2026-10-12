/**
 * DONE_CLAIM_REGEX is matched by a scan (done-claim.ts): its pattern read to
 * the end of a sentence from every `marked` in it, quadratic in a sentence of
 * them. The scan must match exactly where the pattern matches, and reading a
 * sentence of `marked` must not run the pattern.
 */
import { describe, expect, test } from "bun:test";
import { DONE_CLAIM_PATTERN, findDoneClaim } from "./done-claim";
import { DONE_CLAIM_REGEX, doneClaimSentences } from "./heuristics";

/** Every concatenation of up to `depth` of `pieces`, `visit`ed; returns how many. */
function everyText(pieces: readonly string[], depth: number, visit: (t: string) => void): number {
  let count = 0;
  const walk = (text: string, d: number): void => {
    visit(text);
    count++;
    if (d === depth) return;
    for (const p of pieces) walk(text + p, d + 1);
  };
  walk("", 0);
  return count;
}

/** `n` seeded pseudo-random concatenations of 1 to `maxPieces` of `pieces`. */
function randomTexts(pieces: readonly string[], n: number, maxPieces: number): string[] {
  let seed = 0x61c88647;
  const next = (bound: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let text = "";
    const length = 1 + next(maxPieces);
    for (let k = 0; k < length; k++) text += pieces[next(pieces.length)];
    out.push(text);
  }
  return out;
}

/** Where the plain pattern matches, and what its group holds. */
function byPattern(text: string): string {
  const m = new RegExp(DONE_CLAIM_PATTERN.source, DONE_CLAIM_PATTERN.flags).exec(text);
  return m === null ? "null" : JSON.stringify([m.index, m[0], m[1]]);
}

function byScan(text: string): string {
  const m = DONE_CLAIM_REGEX.exec(text);
  return m === null ? "null" : JSON.stringify([m.index, m[0], m[1]]);
}

describe("DONE_CLAIM_REGEX", () => {
  test("keeps its pattern's source and flags", () => {
    expect(DONE_CLAIM_REGEX.source).toBe(DONE_CLAIM_PATTERN.source);
    expect(DONE_CLAIM_REGEX.flags).toBe(DONE_CLAIM_PATTERN.flags);
  });

  test("matches where the pattern matches", () => {
    const pieces = [
      "marked ",
      "unmarked ",
      "Marked ",
      " as done",
      " as complete",
      "x",
      " ",
      ".",
      "?",
      "i fixed",
      "I've now shipped",
      "is done",
      "-",
      "\n",
    ];
    const differ: string[] = [];
    let claims = 0;
    const visit = (t: string): void => {
      const want = byPattern(t);
      if (want !== "null") claims++;
      if (byScan(t) !== want || DONE_CLAIM_REGEX.test(t) !== (want !== "null")) differ.push(t);
    };
    const checked = everyText(pieces, 4, visit);
    for (const t of randomTexts(pieces, 15_000, 12)) visit(t);
    for (const t of [
      "I marked the ticket as done.",
      "marked marked as done",
      "marked the item unmarked as done",
      "We marked a, then marked b as complete",
      "marked it as donezo",
      "it was marked. as done",
      "The migration has been merged and I have also deployed it.",
      "MARKED X AS DONE",
    ]) {
      visit(t);
    }
    expect(differ).toEqual([]);
    expect(checked).toBe((14 ** 5 - 1) / 13);
    expect(claims).toBeGreaterThan(5_000);
  }, 30_000);

  // Counted, not timed: the pattern is refused on the spot if the engine runs
  // it; the scan runs only the bounded first two alternatives.
  test("a sentence of `marked` is read without the pattern", () => {
    const realExec = RegExp.prototype.exec;
    const ran: string[] = [];
    const watch = (refuse: boolean): void => {
      RegExp.prototype.exec = function (this: RegExp, input: string) {
        if (this.source === DONE_CLAIM_PATTERN.source) {
          ran.push(refuse ? "refused" : "control");
          if (refuse) throw new Error("the pattern ran");
        }
        return realExec.call(this, input);
      };
    };
    let claims: string[] | Error;
    watch(true);
    try {
      claims = doneClaimSentences("marked ".repeat(2_000));
    } catch (err) {
      claims = err as Error;
    } finally {
      RegExp.prototype.exec = realExec;
    }
    // Control: the hook sees the pattern when the engine runs it.
    watch(false);
    try {
      DONE_CLAIM_PATTERN.test("marked x");
    } finally {
      RegExp.prototype.exec = realExec;
    }
    expect(ran).toEqual(["control"]);
    expect(claims).toEqual([]);
    expect(findDoneClaim(`${"marked ".repeat(2_000)}x as done`)).toEqual({ index: 0, end: 14_009 });
  }, 20_000);

  // A hang detector, not a timing: two million characters of `marked ` take
  // tens of milliseconds here; the pattern needed on the order of 10^11 steps
  // for them, minutes on any machine, so only a return to a quadratic clause
  // can reach the budget.
  test("a two-million-character sentence of `marked` is read in linear time", () => {
    expect(doneClaimSentences(`${"marked ".repeat(285_715)}x`)).toEqual([]);
    expect(doneClaimSentences(`${"marked ".repeat(285_715)}x as done`)).toHaveLength(1);
  }, 60_000);
});
