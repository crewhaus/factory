/**
 * Article text is read without a pattern that rescans a run: links are found
 * with `indexOf` (`/\[\[([^\]]+)\]\]/g` was quadratic in a run of `[`), and
 * the body's trailing whitespace goes with `trimEnd()`.
 */
import { describe, expect, test } from "bun:test";
import { scanWork } from "./__test__/scan-work";
import { type WikiArticle, extractWikilinks, parseArticle, serializeArticle } from "./index";
import { wikilinkInners } from "./wikilinks";

/** What the link pattern captured, the way `matchAll` reported it. */
const byPattern = (body: string): string[] =>
  [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1] ?? "");

/** `/\s+$/` run by `search`, which JavaScriptCore does not turn into a trim. */
const withoutTrailingSpace = (text: string): string => {
  const at = text.search(/\s+$/);
  return at === -1 ? text : text.slice(0, at);
};

/**
 * Runs `body` with every regular expression run over a text holding `run`
 * refused on the spot and recorded, unless its source is in `allowed`.
 * Replacing `RegExp.prototype.exec` routes every String and RegExp method
 * that runs a pattern through it (the control below checks that for
 * `String#matchAll`); restored after.
 */
function patternsOver<T>(
  run: string,
  allowed: readonly string[],
  body: () => T,
): { refused: string[]; outcome: T | Error } {
  const refused: string[] = [];
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (typeof input === "string" && input.includes(run) && !allowed.includes(this.source)) {
      refused.push(`/${this.source}/`);
      throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { refused, outcome: body() };
  } catch (err) {
    return { refused, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

const article = (body: string): WikiArticle => ({
  slug: "a",
  title: "A",
  tags: [],
  confidence: 0.5,
  verified: false,
  version: 1,
  sources: [],
  status: "draft",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  body,
});

describe("wikilinkInners", () => {
  test("finds what the pattern found", () => {
    const cases = [
      "",
      "no links",
      "[[a]]",
      "[[a]][[b]]",
      "see [[Some Page|label]] and [[other]].",
      "[[]]",
      "[[]]]",
      "[[a]b]]",
      "[[[a]]",
      "[[[[a]]",
      "[[a]]]]",
      "[[a\nb]]",
      "[[ ]]",
      "[[a] ]]",
      "[[a",
      "a]]",
      "[[é|日本]]",
      "[[😀]]",
      `${"[".repeat(50)}a]]`,
      `${"[[".repeat(50)}x`,
    ];
    for (const body of cases) {
      expect(`${JSON.stringify(body)} → ${JSON.stringify(wikilinkInners(body))}`).toBe(
        `${JSON.stringify(body)} → ${JSON.stringify(byPattern(body))}`,
      );
    }
  });

  test("agrees with the pattern on every text of up to seven characters from [, ], a, | and a newline", () => {
    const alphabet = ["[", "]", "a", "|", "\n"];
    let checked = 0;
    const differ: string[] = [];
    const visit = (body: string): void => {
      if (JSON.stringify(wikilinkInners(body)) !== JSON.stringify(byPattern(body))) {
        differ.push(body);
      }
      checked++;
      if (body.length === 7) return;
      for (const c of alphabet) visit(body + c);
    };
    visit("");
    expect(differ).toEqual([]);
    expect(checked).toBe((5 ** 8 - 1) / 4);
  }, 20_000);
});

describe("trimEnd strips what /\\s+$/ stripped", () => {
  test("for every UTF-16 code unit, trailing and before a letter", () => {
    const differ: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const c = String.fromCharCode(code);
      for (const text of [`a${c}${c}`, `${c}a`, `${c}`]) {
        if (text.trimEnd() !== withoutTrailingSpace(text)) differ.push(code);
      }
    }
    expect(differ).toEqual([]);
  }, 20_000);
});

// Counted, not timed: a pattern run over the run is refused and recorded.
// The link scan's own reads are counted below.
describe("long runs in a body", () => {
  test("a run of [ with no closing ]] runs no pattern", () => {
    const run = "[".repeat(10_000);
    const body = "[[".repeat(500_000);
    // Control: the hook sees the pattern String#matchAll runs.
    expect(patternsOver(run, [], () => byPattern(body)).refused).toEqual([
      "/\\[\\[([^\\]]+)\\]\\]/",
    ]);
    const alone = patternsOver(run, [], () => extractWikilinks(body));
    expect(alone.refused).toEqual([]);
    expect(alone.outcome).toEqual([]);
    // A closing ]] after the run makes the whole run one link's text, as it
    // did for the pattern; turning that text into a slug runs two patterns
    // that need no suffix (whitespace to "-", the anchored slug check).
    const slugging = ["\\s+", "^[a-z0-9][a-z0-9-]{0,127}$"];
    const links = patternsOver(run, slugging, () => extractWikilinks(`${body} [[real-page]]`));
    expect(links.refused).toEqual([]);
    expect(links.outcome).toEqual([]);
    const after = patternsOver(run, slugging, () => extractWikilinks(`[[real-page]] ${body}`));
    expect(after.refused).toEqual([]);
    expect(after.outcome).toEqual(["real-page"]);
  });

  test("a run of whitespace inside a body is serialized and parsed without a pattern over it", () => {
    const run = " ".repeat(10_000);
    const body = `x${" ".repeat(1_000_000)}y`;
    const written = patternsOver(run, [], () => serializeArticle(article(`${body} \n\t `)));
    expect(written.refused).toEqual([]);
    const raw = written.outcome as string;
    expect(raw.endsWith(`\n\n${body}\n`)).toBe(true);
    // The leading-newline strip is anchored at the start: one attempt, linear.
    const read = patternsOver(run, ["^\\r?\\n+"], () => parseArticle(raw));
    expect(read.refused).toEqual([]);
    expect((read.outcome as WikiArticle).body).toBe(body);
  });
});

// Counted, not timed: a scan can rescan a run with no pattern at all, if it
// resumes one character on instead of after what it has read. So the link
// scan's own reads are counted (__test__/scan-work.ts) over runs shaped to
// make it rescan, and held to a few per character: a rescan reads the rest of
// the run from every place in it and stops at the bound at once.
describe("the link scan reads a long run a bounded number of times", () => {
  const N = 20_000;
  const PER_CHARACTER = 8;
  const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const cases: ReadonlyArray<readonly [string, string, number]> = [
    ["a run of [ with no ]", "[".repeat(N), 0],
    ["a run of [ before one ]", `${"[".repeat(N)}]`, 0],
    ["a run of [ before ]]", `${"[".repeat(N)}]]`, 1],
    ["[[ and one ] again and again", fill("[[a]"), 0],
    ["links one after another", fill("[[a]]"), N / 5],
  ];
  for (const [label, body, links] of cases) {
    test(label, () => {
      const most = PER_CHARACTER * body.length;
      const { value, work } = scanWork(most, () => wikilinkInners(body));
      expect(work).toBeLessThanOrEqual(most);
      // The count sees the run being read; a scan that read it some other
      // way would read as no work here.
      expect(work).toBeGreaterThanOrEqual(body.length);
      expect(value?.length).toBe(links);
    });
  }
});
