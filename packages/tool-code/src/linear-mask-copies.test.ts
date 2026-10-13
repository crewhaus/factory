/**
 * maskSource copies the word before a slash once, and only at the slash.
 *
 * To tell a regular expression from a division it keeps the identifier
 * before each `/`. It used to copy that identifier out at every character of
 * it, as it grew, so an identifier of length n cost n(n+1)/2 characters
 * copied, before scanImports, scanExports, scanDeclarations or stripJsonc
 * read a word of a file the workspace supplies. Now it keeps the run's
 * bounds and copies the run only when a `/` asks for it.
 *
 * Counted, not timed: the house meter counts the characters the string
 * methods copy or search, and throws past its limit, so the old copying
 * stops at once rather than after the minutes it would take. A test that
 * reads a long source declares a 20 s budget, as the house does for a test
 * that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "./__test__/js-work";
import { stripJsonc } from "./lib/deps";
import { maskSource, scanDeclarations, scanExports, scanImports } from "./lib/scan";

const masked = (src: string): string => maskSource(src).code;

describe("the word before a slash is the last one, until something else is read", () => {
  // A keyword before `/` opens a regular expression, whose body is blanked;
  // any other word, or none, makes it a division, left as it is.
  test.each([
    // Whitespace and line breaks keep the word.
    ["return \t /a b/", "return \t /   /"],
    ["in\n\n/a b/", "in\n\n/   /"],
    // A string, a template, a regular expression or a punctuator ends it.
    ['return"s"/a b/', 'return" "/a b/'],
    ["return'\\''/a b/", "return'  '/a b/"],
    ["return`t`/a b/", "return` `/a b/"],
    ["return`${x}`/a b/", "return`${x}`/a b/"],
    ["return /a/ /b c/", "return / / /b c/"],
    ["return /a/g /b c/", "return / /  /b c/"],
    ["return) /a b/", "return) /a b/"],
    ["return] /a b/", "return] /a b/"],
    ["return. /a b/", "return. /a b/"],
    // A word after the ending is the word again.
    ['"s" return /a b/', '" " return /   /'],
    ["`t` typeof /a b/", "` ` typeof /   /"],
    ["x) in /a b/", "x) in /   /"],
    // The word is the whole run, read in one piece or several.
    ["xin /a b/", "xin /a b/"],
    ["in_ /a b/", "in_ /a b/"],
    ["i$n /a b/", "i$n /a b/"],
    ["/a/g$in /b c/", "/ / $in /b c/"],
    ["a / b / c", "a / b / c"],
    ["return /a/ in /b c/", "return / / in /   /"],
  ])("%j", (src, code) => {
    expect(masked(src)).toBe(code);
  });
});

describe("a long identifier is copied out at most once", () => {
  const shapes: ReadonlyArray<readonly [string, (n: number) => string]> = [
    ["one identifier", (n) => "x".repeat(n)],
    ["an identifier, then a slash", (n) => `${"a".repeat(n)} / 2`],
    ["an import list", (n) => `import { ${"x".repeat(n)} } from "y";\n`],
    ["a declaration", (n) => `export const ${"a".repeat(n)} = 1;\n`],
    ["a JSON key", (n) => `{"${"k".repeat(n)}": ${"1".repeat(n)}}`],
  ];
  const readers: ReadonlyArray<readonly [string, (src: string) => unknown]> = [
    ["maskSource", maskSource],
    ["scanImports", scanImports],
    ["scanExports", scanExports],
    ["scanDeclarations", scanDeclarations],
    ["stripJsonc", stripJsonc],
  ];
  for (const [reader, read] of readers) {
    test(`${reader}, at n, 2n and 4n`, () => {
      for (const [shape, make] of shapes) {
        const work = [10_000, 20_000, 40_000].map((n) => {
          const src = make(n);
          // A few characters per character of the source; the old copying
          // passes this a few thousand characters in and is stopped there.
          const limit = 6 * src.length;
          const counted = jsWork(limit, () => read(src));
          expect(`${reader} over ${shape}: ${counted.work <= limit}`).toBe(
            `${reader} over ${shape}: true`,
          );
          return counted.work;
        });
        // Doubling the identifier at most doubles the work (quadratic
        // copying quadruples it).
        for (let k = 1; k < work.length; k++) {
          expect(work[k] as number).toBeLessThanOrEqual(2 * (work[k - 1] as number) + 64);
        }
      }
    }, 20_000);
  }

  test("the old copying is what the meter catches", () => {
    // Control: the copy maskSource made at each identifier character.
    const src = "x".repeat(4_000);
    const perCharacter = (): void => {
      for (let i = 0; i < src.length; i++) src.slice(0, i + 1);
    };
    expect(jsWork(Number.POSITIVE_INFINITY, perCharacter).work).toBe(
      (src.length * (src.length + 1)) / 2,
    );
    expect(jsWork(6 * src.length, perCharacter).work).toBe(Number.POSITIVE_INFINITY);
  });
});
