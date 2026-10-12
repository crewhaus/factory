/**
 * Three line reads in the changeset lints run in one pass.
 *
 * `/\s+as\s+/` (an import list entry), `/^\s{0,3}(`{3,}|~{3,})(.*)$/` (a
 * fence line) and `/^(?:\/\/+|\/\*+|#+|\*+|--|<!--)?[\s\-*>]*$/` (the text
 * before a TODO) each try every start inside a run, or every split of one,
 * and rescan the rest of it before giving up: quadratic in the run's length.
 * A document and a diff are the workspace's or the model's, so each read is
 * a scan that gives the same answer.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { extractDocRefs } from "./lib/docs";
import { todoBody } from "./lib/rules";
import { beforeAs, fenceOpening, onlyCommentOpener } from "./lib/scan-text";

/**
 * Every regular expression run over a string holding `run` while `body`
 * runs. Each is recorded once, and one whose source is not in `allowed` is
 * refused on the spot (it throws instead of running), so a pattern that
 * would rescan the run from every position in it fails the test at once
 * instead of being waited out. `String#replace`, `match`, `split`, `search`
 * and `RegExp#test` all go through `exec` once it is replaced. Counted, not
 * timed: the machine's speed decides nothing.
 */
function regexRunsOver<T>(
  run: string,
  body: () => T,
  allowed: ReadonlyArray<string> = [],
): { runs: string[]; outcome: T | Error } {
  const runs: string[] = [];
  const realExec = RegExp.prototype.exec;
  let last: string | undefined;
  let holds = false;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (input !== last) {
      last = input;
      holds = typeof input === "string" && input.includes(run);
    }
    if (holds) {
      const seen = `/${this.source}/ over ${input.length} characters`;
      if (!runs.includes(seen)) runs.push(seen);
      if (!allowed.includes(this.source)) throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { runs, outcome: body() };
  } catch (err) {
    return { runs, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

/** Every string up to `max` characters long over `alphabet`. */
function allStrings(alphabet: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    out.push(...layer);
  }
  return out;
}

/** `[input, output]` for each input, as one string, so a failure names the input. */
function answers(inputs: ReadonlyArray<string>, f: (s: string) => unknown): string[] {
  return inputs.map((s) => `${JSON.stringify(s)} -> ${JSON.stringify(f(s))}`);
}

// Patterns the readers run over each line, each in one pass: a trailing
// \r, the line's import statement (it starts only at `import`, `const`,
// `let` or `var`, and its braces end at the first `}`), `type `, an
// anchored identifier check and the TODO marker. Listed so the test says
// which they are.
const ONE_PASS: ReadonlyArray<string> = [
  "\\r$",
  "import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*(['\"])([^'\"]+)\\2|(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*(['\"])([^'\"]+)\\5\\s*\\)",
  "\\btype\\s+",
  "^[A-Za-z_$][A-Za-z0-9_$]*$",
  "\\b(TODO|FIXME|HACK|XXX)\\b",
];
const unlisted = (runs: ReadonlyArray<string>): string[] =>
  runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)));

const OPENER = /^(?:\/\/+|\/\*+|#+|\*+|--|<!--)?[\s\-*>]*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

describe("the reads return what the regex forms returned", () => {
  test("beforeAs and split(/\\s+as\\s+/)[0]", () => {
    const inputs = [
      ...allStrings([" ", "a", "s", "x"], 6),
      "a as b",
      "a\tas\nb",
      "a  as",
      "as as as",
      "é as \u{1F600}",
    ];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`x${ch}as y`, `x as${ch}y`);
    }
    expect(answers(inputs, beforeAs)).toEqual(
      answers(inputs, (s) => s.split(/\s+as\s+/)[0] as string),
    );
  }, 20_000);

  test("fenceOpening and the fence pattern", () => {
    const inputs = [
      ...allStrings(["`", "~", " ", "a", "\r"], 6),
      "```ts",
      "   ~~~~ info",
      "    ```",
      "\u2028```x",
      "```\u2029",
    ];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`${ch}\`\`\`x`, `\`\`\`${ch}`);
    }
    expect(answers(inputs, fenceOpening)).toEqual(
      answers(inputs, (s) => {
        const m = FENCE.exec(s);
        return m === null ? null : { marker: m[1], info: m[2] };
      }),
    );
  }, 20_000);

  test("onlyCommentOpener and the opener pattern", () => {
    const inputs = [
      ...allStrings(["/", "*", "#", "-", "<", "!", " ", ">", "a"], 4),
      "// ",
      "/** ",
      "<!-- ",
      "## >",
      "x",
    ];
    for (let c = 0; c <= 0xffff; c++) inputs.push(`// ${String.fromCharCode(c)}`);
    expect(answers(inputs, onlyCommentOpener)).toEqual(answers(inputs, (s) => OPENER.test(s)));
  });
});

describe("no pattern rescans a run in a document or a diff line", () => {
  test("an import list entry with a run of spaces inside it", () => {
    const spaces = " ".repeat(100_000);
    // An entry with no ` as ` is one name, and one with spaces in it is not a
    // name at all; the aliased entry beside it still is.
    const doc = `\`\`\`ts\nimport { parseThing${spaces}x, otherThing as y } from "./thing";\n\`\`\`\n`;
    const refs = regexRunsOver(spaces, () => extractDocRefs(doc, "doc.md"), ONE_PASS);
    expect(unlisted(refs.runs)).toEqual([]);
    expect(refs.outcome).toMatchObject([{ symbol: "otherThing", evidence: "import" }]);
  });

  test("a fence line with a run of backticks before a stray carriage return", () => {
    const ticks = "`".repeat(100_000);
    const doc = `${ticks}\rx\n\`parseThing\` stays\n`;
    const refs = regexRunsOver(ticks, () => extractDocRefs(doc, "doc.md"), ONE_PASS);
    expect(unlisted(refs.runs)).toEqual([]);
    // As before, a fence whose info holds a line break is not a fence, so the
    // next line is prose.
    expect(refs.outcome).toMatchObject([{ symbol: "parseThing", evidence: "backtick" }]);
  });

  test("the text before a TODO with a run of stars that is not filler after all", () => {
    const stars = "*".repeat(100_000);
    const line = `/*${stars}x TODO: tidy */`;
    // Control: the count sees the old pattern run over the text before the TODO.
    const between = line.slice(0, line.indexOf("TODO"));
    expect(regexRunsOver(stars, () => OPENER.test(between)).runs).toEqual([
      `/${OPENER.source}/ over ${between.length} characters`,
    ]);
    const body = regexRunsOver(stars, () => todoBody(line, "js"), ONE_PASS);
    expect(unlisted(body.runs)).toEqual([]);
    expect(body.outcome).toBeUndefined();
  });
});
