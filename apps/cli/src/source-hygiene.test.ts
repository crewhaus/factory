import { describe, expect, test } from "bun:test";
/**
 * Source-level hygiene checks that span every package.
 *
 * These are not about behaviour. They pin properties of the SOURCE that no
 * unit test can see and that a formatter can quietly undo.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Every .ts file under a directory, skipping build output and deps. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Control characters that have no business appearing literally in source.
 * Tab, newline and carriage return are ordinary and excluded.
 *
 * Assembled from code points at runtime, NOT written as a regex literal and
 * not written as an escaped string either. Both of those get rewritten: given
 * a literal the formatter turns the escapes into raw bytes, and given
 * `new RegExp("…")` it folds the whole thing back into a literal. Either way
 * the guard would end up carrying the bytes it exists to find, and would
 * match itself. `String.fromCharCode` cannot be folded, so this survives.
 */
const RAW_CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);

/** A regex literal's character class, e.g. the `/[…]` of `/[a-z]/g`. */
const REGEX_CLASS = /\/\[[^\]\n]*\]/g;

describe("no regex literal carries raw control bytes", () => {
  /**
   * The formatter rewrites `\x00`-style escapes INSIDE a regex literal into
   * the bytes they denote, and a file carrying literal control characters is
   * not parsed identically by every engine: Bun 1.3.14 accepted
   * `/[<NUL>-<US><DEL>]/` while 1.3.11 rejected the same class as "range out
   * of order". That shipped green locally and failed in CI, in two packages
   * at once, because the local and CI runtimes disagreed.
   *
   * Passing an escaped STRING to `new RegExp` survives formatting, because
   * the escapes are string escapes rather than pattern text.
   */
  test("control characters are written as escapes, not as the bytes themselves", () => {
    const offenders: string[] = [];
    // Every tree CI compiles, not just packages/ — the failure is a parse
    // error, so it lands wherever the byte is.
    const roots = ["packages", "apps", "scripts"].map((d) => join(REPO_ROOT, d));
    for (const file of roots.flatMap((r) => sourceFiles(r))) {
      const text = readFileSync(file, "utf-8");
      // Cheap reject first: most files carry no control byte at all.
      if (!RAW_CONTROL.test(text)) continue;
      for (const [i, line] of text.split("\n").entries()) {
        for (const cls of line.match(REGEX_CLASS) ?? []) {
          if (RAW_CONTROL.test(cls)) {
            offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the guard actually detects one when it is there", () => {
    // Proof the matcher works, without putting a raw byte in this file: build
    // the offending line the way a formatter would have left it.
    const nul = String.fromCharCode(0);
    const del = String.fromCharCode(0x7f);
    const mangled = `if (/[${nul}-${del}]/.test(x)) return false;`;
    const found = (mangled.match(REGEX_CLASS) ?? []).some((c) => RAW_CONTROL.test(c));
    expect(found).toBe(true);
  });

  test("an ordinary regex literal is not flagged", () => {
    const fine = "const RE = /[A-Za-z0-9_-]+/g;";
    const found = (fine.match(REGEX_CLASS) ?? []).some((c) => RAW_CONTROL.test(c));
    expect(found).toBe(false);
  });
});
