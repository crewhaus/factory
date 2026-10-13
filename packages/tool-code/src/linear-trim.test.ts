/**
 * Three line reads in the dependency and import scanners run in one pass.
 *
 * `/\/\/.*$/` and `/^require\s+(.*)$/` over a go.mod line, and
 * `/\s+as\s+([\w$]+)$/` over an import or export list entry, each try every
 * start inside a run (of slashes, of spaces) and, when what follows the run
 * is not what they need, rescan the rest of it from each before giving the
 * start up: quadratic in the run's length. A go.mod and a source file are the
 * workspace's, so each read is a scan instead.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { beforeLineComment, parseGoMod, requireBody } from "./lib/deps";
import { aliasAfterAs, scanExports, scanImports } from "./lib/scan";

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

// Patterns the scanners run over the whole text or line. On these texts each
// reads the run at most once: the run holds no `import`, quote, `;` or
// `}` that would start or end their longer searches, and the declaration
// patterns are anchored at a statement's start. (The import pattern's own
// super-linear shape, a run of spaces inside an `import { … }` clause, is
// outside this change.) Listed so the test says which they are.
const ONE_PASS: ReadonlyArray<string> = [
  "\\r$",
  "\\/\\/\\s*indirect",
  "^require\\s*\\($",
  "\\bimport\\s+(?<type>type\\s+)?(?<clause>[^;'\"]*?)\\s*from\\s*(?<q>['\"])(?<spec>[^'\"\\n]*)\\k<q>",
  "\\bexport\\s+(?<type>type\\s+)?(?<clause>\\*(?:\\s+as\\s+[\\w$]+)?|\\{[^}]*\\})\\s*from\\s*(?<q>['\"])(?<spec>[^'\"\\n]*)\\k<q>",
  "\\{([^}]*)\\}",
  "\\btype\\s+",
  "\\s+",
  "\\bimport\\s*\\(\\s*(?<q>['\"])(?<spec>[^'\"\\n]*)\\k<q>",
  "\\brequire\\s*\\(\\s*(?<q>['\"])(?<spec>[^'\"\\n]*)\\k<q>",
  "\\bimport\\s*(?<q>['\"])(?<spec>[^'\"\\n]*)\\k<q>",
  "^(?<mods>(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?)function(?<gen>\\s*\\*)?\\s+([A-Za-z_$][\\w$]*)",
  "^(?<mods>(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?)class\\s+([A-Za-z_$][\\w$]*)",
  "^(?<mods>(?:export\\s+)?(?:declare\\s+)?)interface\\s+([A-Za-z_$][\\w$]*)",
  "^(?<mods>(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?)enum\\s+([A-Za-z_$][\\w$]*)",
  "^(?<mods>(?:export\\s+)?(?:declare\\s+)?)type\\s+([A-Za-z_$][\\w$]*)",
  "^(?<mods>(?:export\\s+)?(?:declare\\s+)?)(?:namespace|module)\\s+([A-Za-z_$][\\w$]*)",
  "^(?<mods>(?:export\\s+)?(?:declare\\s+)?)(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)",
  "\\bexport\\s+(?<type>type\\s+)?\\{(?<body>[^}]*)\\}(?<tail>\\s*from\\s*['\"][^'\"\\n]*['\"])?",
  "\\bexport\\s+\\*(?:\\s+as\\s+(?<ns>[\\w$]+))?\\s*from\\s*(?<q>['\"])(?<spec>[^'\"\\n]*)\\k<q>",
  "\\bexport\\s+default\\s+(?![\\s{])",
];
const unlisted = (runs: ReadonlyArray<string>): string[] =>
  runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)));

describe("the reads return what the regex forms returned", () => {
  test("beforeLineComment and /\\/\\/.*$/", () => {
    const inputs = [
      ...allStrings(["/", "a", "\r"], 6),
      ...allStrings(["/", "\n", "\u2028", "\u2029", " "], 4),
      "require x v1 // indirect",
      "é // \u{1F600}",
    ];
    expect(answers(inputs, beforeLineComment)).toEqual(
      answers(inputs, (s) => s.replace(/\/\/.*$/, "")),
    );
  });

  test("requireBody and /^require\\s+(.*)$/", () => {
    const inputs = [
      ...allStrings([" ", "a", "\r", "\t"], 4).map((s) => `require${s}`),
      ...allStrings([" ", "\n", "\u2028", "x"], 4).map((s) => `require${s}`),
      "require golang.org/x/net v0.1.0",
      "requires x",
      " require x",
      "require",
    ];
    // Every code unit, as the space after `require` and as the text after it.
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`require${ch}x`, `require ${ch}`);
    }
    expect(answers(inputs, requireBody)).toEqual(
      answers(inputs, (s) => /^require\s+(.*)$/.exec(s)?.[1]),
    );
  }, 20_000);

  test("aliasAfterAs and /\\s+as\\s+([\\w$]+)$/", () => {
    const alias = (s: string): string | undefined => /\s+as\s+([\w$]+)$/.exec(s)?.[1];
    const inputs = [
      ...allStrings([" ", "a", "s", "$"], 6),
      "x as y",
      "x  as\t$y_1",
      "x as as",
      "default as Foo",
      "é as \u{1F600}",
      "x AS y",
    ];
    // Every code unit, in each of the four places the pattern reads.
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`x${ch}as y`, `x as${ch}y`, `x as y${ch}`, `x as ${ch}`);
    }
    expect(answers(inputs, aliasAfterAs)).toEqual(answers(inputs, alias));
  }, 20_000);
});

describe("no pattern rescans a run in what the workspace holds", () => {
  test("a go.mod line with a run of slashes or spaces before a stray carriage return", () => {
    const slashes = "/".repeat(100_000);
    const spaces = " ".repeat(100_000);
    const text = [
      "module example.com/m",
      `require a.example/x v1.0.0 ${slashes}\rz`,
      `require${spaces}\ry v2`,
      "require b.example/y v2.0.0 // indirect",
    ].join("\n");
    for (const [run, pattern] of [
      [slashes, /\/\/.*$/],
      [spaces, /^require\s+(.*)$/],
    ] as const) {
      // Control: the count sees each old pattern run over its run.
      const line = text.split("\n").find((l) => l.includes(run)) as string;
      expect(regexRunsOver(run, () => pattern.exec(line)).runs).toEqual([
        `/${pattern.source}/ over ${line.length} characters`,
      ]);
      const parsed = regexRunsOver(run, () => parseGoMod(text), ONE_PASS);
      expect(unlisted(parsed.runs)).toEqual([]);
      // As before: a require whose rest holds a line break is not one, and
      // `\s` takes a carriage return inside the whitespace after `require`.
      expect(
        (parsed.outcome as ReturnType<typeof parseGoMod>).map(
          (d) => `${d.name} ${d.range} ${d.scope}`,
        ),
      ).toEqual(["b.example/y v2.0.0 optional", "y v2 prod"]);
    }
  });

  test("an export list entry with a run of spaces inside it", () => {
    const spaces = " ".repeat(100_000);
    const src = `export { a${spaces}b, c as d } from "./x";\n`;
    const imported = regexRunsOver(spaces, () => scanImports(src), ONE_PASS);
    expect(unlisted(imported.runs)).toEqual([]);
    expect(imported.outcome).toEqual([
      { specifier: "./x", line: 1, kind: "export-from", typeOnly: false, names: ["a", "d"] },
    ]);
    const exported = regexRunsOver(spaces, () => scanExports(src), ONE_PASS);
    expect(unlisted(exported.runs)).toEqual([]);
    expect(exported.outcome).toEqual([
      { name: "a", line: 1, kind: "named", from: "./x" },
      { name: "d", line: 1, kind: "named", from: "./x" },
    ]);
  }, 20_000);
});
