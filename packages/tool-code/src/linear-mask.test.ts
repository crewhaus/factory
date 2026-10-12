/**
 * maskSource reads each identifier character once.
 *
 * To tell a regular expression from a division it keeps the identifier
 * before each `/`, and it found that identifier by walking back over the
 * whole run at every character of it: quadratic in an identifier's length,
 * before scanImports, scanExports or SymbolOutline read a word of a source
 * file the workspace supplies. Now each character is walked back over once.
 *
 * Counted, not timed: the identifier test is a regular expression, so a hook
 * on `exec` counts its calls, and throws past the bound so the old walk
 * stops at once rather than after the minutes it would take. A test that
 * reads a long source declares a 20 s budget, as the house does for a test
 * that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { maskSource, scanExports, scanImports } from "./lib/scan";

const IDENT = "[A-Za-z0-9_$]";

/** `body`'s calls of the identifier test, refused past `max`. */
function identifierTests<T>(max: number, body: () => T): { calls: number; outcome: T | Error } {
  const realExec = RegExp.prototype.exec;
  let calls = 0;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (this.source === IDENT) {
      calls += 1;
      if (calls > max) throw new Error(`/${IDENT}/ ran ${calls} times`);
    }
    return realExec.call(this, input);
  };
  try {
    return { calls, outcome: body() };
  } catch (err) {
    return { calls, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

const masked = (src: string): string => maskSource(src).code;

describe("the word before a slash is the whole identifier", () => {
  // A keyword before `/` opens a regular expression, whose body is blanked;
  // any other identifier makes it a division, left as it is.
  test.each([
    ["return /a b/", "return /   /"],
    ["typeof/a b/", "typeof/   /"],
    ["xreturn /a b/", "xreturn /a b/"],
    ["return_ /a b/", "return_ /a b/"],
    ["$return /a b/", "$return /a b/"],
    ["a return /a b/", "a return /   /"],
    ["a.return /a b/", "a.return /   /"],
    ["return\n/a b/", "return\n/   /"],
    ['"s"return /a b/', '" "return /   /'],
    ["x = return1 /a b/", "x = return1 /a b/"],
    [`${"a".repeat(5_000)}return /a b/`, `${"a".repeat(5_000)}return /a b/`],
    [`${"a".repeat(5_000)} return /a b/`, `${"a".repeat(5_000)} return /   /`],
  ])("%j", (src, code) => {
    expect(masked(src)).toBe(code);
  });
});

describe("a long identifier is read once", () => {
  for (const [label, src] of [
    ["underscores", "_".repeat(100_000)],
    ["letters, then a keyword's slash", `${"a".repeat(100_000)}return /x/`],
    ["many words", "ab cd ".repeat(20_000)],
  ] as const) {
    test(label, () => {
      // One test of each character, and one more where a walk back stops.
      const counted = identifierTests(2 * src.length, () => masked(src));
      expect(counted.outcome).toBe(src);
      expect(counted.calls).toBeLessThanOrEqual(2 * src.length);
    }, 20_000);
  }

  test("through the import and export scans", () => {
    const src = `import { ${"a".repeat(100_000)} } from "x";\nexport const b = 1;\n`;
    for (const scan of [scanImports, scanExports]) {
      const counted = identifierTests(4 * src.length, () => scan(src));
      expect(counted.outcome).not.toBeInstanceOf(Error);
    }
  }, 20_000);
});
