/**
 * The named imports in a document's code blocks are read in one pass.
 *
 * `/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2|(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])([^'"]+)\5\s*\)/g`
 * read from each `import {` or `let {` on to the first `}`, so a line of
 * them with no `}`, or with one far away and no `from` after it, was read
 * again from every one: quadratic in the line, on markdown of up to 4 MiB
 * from the workspace (`DocsSymbolCheck`). `namedImports` reads each part
 * once and finds what the pattern found, checked here on every short line
 * over pieces that reach each part.
 *
 * Counted, not timed. The old pattern's back-references are not something
 * the step model in tool-text's __test__/regex-work.ts walks, so the count
 * is of the new scan's patterns, which hold to a few steps a character, and
 * of the characters it reads (__test__/scan-work.ts); a control shows the
 * pattern's shape without the back-references going past the same bound.
 * One hang detector runs a 1 MB line through `extractDocRefs`: about 15 ms
 * here, and minutes for the old pattern.
 *
 * A test that walks many generated inputs declares a 20 s budget, as the
 * house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
import { scanWork } from "./__test__/scan-work";
import { extractDocRefs } from "./lib/docs";
import { namedImports } from "./lib/import-scan";

// The pattern as it was.
const OLD =
  /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2|(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])([^'"]+)\5\s*\)/g;
// Its shape with each back-reference read as either quote, for the control.
const OLD_SHAPE =
  /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)['"]|(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])([^'"]+)['"]\s*\)/g;

const old = (line: string) =>
  [...line.matchAll(OLD)].map((m) => ({ body: m[1] ?? m[4] ?? "", spec: m[3] ?? m[6] ?? "" }));

/** Every sequence of up to `max` pieces. */
function allJoins(pieces: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => pieces.map((p) => s + p));
    for (const s of layer) out.push(s);
  }
  return out;
}

/** Seeded, so a failure names the same input every run. */
function randomTexts(pieces: ReadonlyArray<string>, count: number, maxPieces: number): string[] {
  let seed = 0x7f4a7c15;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    const n = Math.floor(next() * (maxPieces + 1));
    for (let j = 0; j < n; j++) s += pieces[Math.floor(next() * pieces.length)];
    out.push(s);
  }
  return out;
}

describe("namedImports finds what the pattern found", () => {
  test("every short line, and long generated ones", () => {
    const pieces = [
      "import ",
      "type ",
      "{",
      "}",
      "a",
      " from ",
      "'",
      '"',
      "let",
      "={",
      "require(",
      ")",
    ];
    const statements = [
      "import { a } from './m';",
      'import type {b,c} from "x"',
      "const { a } = require('./m');",
      "let{a}=require( 'x' )",
      "var {a} = require(\"y')",
      "import {a} from 'x\"",
      "import  type  { a }  from  './a'",
    ];
    const inputs = [
      ...allJoins(pieces, 4),
      ...randomTexts([...pieces, ...statements, " ", "x", "\t", "\n"], 20_000, 12),
    ];
    const differ: string[] = [];
    let found = 0;
    for (const line of inputs) {
      const want = old(line);
      if (JSON.stringify(namedImports(line)) !== JSON.stringify(want))
        differ.push(JSON.stringify(line));
      found += want.length;
    }
    expect(differ.slice(0, 5)).toEqual([]);
    expect(found).toBeGreaterThan(10_000);
  }, 20_000);
});

describe("a line of openers is read once", () => {
  // The scan's patterns take under three steps a character on these, and it
  // reads each character at most a few times. The model walks every step in
  // JavaScript, so each test declares a 20 s budget.
  const STEPS_PER_CHARACTER = 4;
  const READS_PER_CHARACTER = 8;

  test.each([
    ["let { with no }", "let{".repeat(5_000)],
    ["import { with one } at the end", `${"import {".repeat(2_500)}}`],
    ["let { with a } and no require", `${"let{".repeat(5_000)}} = require(x`],
    ["let { with an unclosed module", `${"let{".repeat(2_500)}}=require('${"a".repeat(10_000)}`],
    [
      "import { with an unclosed module",
      `${"import {".repeat(1_250)}} from '${"a".repeat(10_000)}`,
    ],
  ])(
    "%s",
    (_, line) => {
      const bound = STEPS_PER_CHARACTER * line.length;
      const counted = regexWork(bound, () =>
        scanWork(READS_PER_CHARACTER * line.length, () => namedImports(line)),
      );
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      expect(counted.value?.value).toEqual([]);
      expect(counted.value?.work).toBeLessThanOrEqual(READS_PER_CHARACTER * line.length);
      // Control: the pattern's shape goes past the bound on the same line.
      expect(regexWork(bound, () => [...line.matchAll(OLD_SHAPE)].length).steps).toBe(
        Number.POSITIVE_INFINITY,
      );
    },
    20_000,
  );

  test("through extractDocRefs", () => {
    // Every pattern the reader runs over the block takes under five steps
    // a character here; the old pattern is not one the model walks, which
    // is listed, and it reread the line from every opener.
    const doc = `\`\`\`ts\n${"let{".repeat(5_000)}\n\`\`\`\n`;
    const bound = 8 * doc.length;
    const counted = regexWork(bound, () => extractDocRefs(doc, "d.md"));
    expect(counted.unmodelled).toEqual([]);
    expect(counted.steps).toBeLessThanOrEqual(bound);
    expect(counted.value).toEqual([]);
  }, 20_000);

  // A pure hang detector: about 15 ms here; the old pattern, minutes.
  test("a 1 MB line of openers in a code block", () => {
    const doc = `\`\`\`ts\n${"let{".repeat(250_000)}\n\`\`\`\n`;
    expect(extractDocRefs(doc, "d.md")).toEqual([]);
  }, 20_000);
});
