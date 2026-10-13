/**
 * An `exclude` entry is cut to its walked path in one pass.
 *
 * `p.replace(/^\.\/+|\/+$/g, "")` tried `\/+$` from every slash of a run
 * that does not reach the end, reading the rest of the run from each:
 * quadratic in the run. `ChecksumVerify` takes 64 entries of up to 1,024
 * characters a call, which was about 100 million steps. `excludeKey` gives
 * what the replace gave, checked here on every short entry, and its work is
 * counted with the model in __test__/regex-work.ts: it runs no pattern, and
 * the old replace goes past the same bound. Both walk many inputs, so each
 * declares a 20 s budget, as the house does for a test that is slow by
 * construction.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "./__test__/regex-work";
import { excludeKey } from "./integrity";

const OLD = /^\.\/+|\/+$/g;

/** Every string up to `max` characters long over `alphabet`. */
function allStrings(alphabet: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    for (const s of layer) out.push(s);
  }
  return out;
}

describe("excludeKey", () => {
  test("gives what the replace gave", () => {
    const differ = allStrings([".", "/", "a"], 9).filter(
      (p) => excludeKey(p) !== p.replace(OLD, ""),
    );
    expect(differ).toEqual([]);
  }, 20_000);

  test("reads a run of slashes once", () => {
    const entries = Array.from({ length: 64 }, (_, i) => `${"/".repeat(1_023)}${i}`);
    const bound = 64 * 1_024;
    const counted = regexWork(bound, () => entries.map(excludeKey));
    expect(counted.steps).toBeLessThanOrEqual(bound);
    expect(counted.value?.[0]).toBe(`${"/".repeat(1_023)}0`);
    // Control: the count sees the old replace go past the bound.
    expect(regexWork(bound, () => entries.map((p) => p.replace(OLD, ""))).steps).toBe(
      Number.POSITIVE_INFINITY,
    );
  }, 20_000);
});
