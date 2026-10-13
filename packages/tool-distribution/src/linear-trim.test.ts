/**
 * A manifest is read without rescanning a run.
 *
 * `/^\s*class\s+…<\s*Formula\b/m` and `/^\s*version\s+"…"/m` start at every
 * line and run their `\s*` on across blank lines, so a run of blank lines
 * was rescanned from each line start in it; `/^\s*-?\s*Key:/` shares an
 * indent between two `\s*`; and `/\d+\.\d+\.\d+…/g` rescans a run of digits
 * with no version in it from every digit. Each was quadratic in the run's
 * length, on a manifest of up to 512K characters that is the model's or the
 * workspace's.
 *
 * A test that walks many generated inputs or every code unit, or reads a
 * long run through a whole parse, declares a 20 s budget, as the house does
 * for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import {
  detectKind,
  firstAtLineStart,
  parseManifest,
  versionTokensInUrl,
  wingetField,
} from "./lib/parse";

/**
 * Every regular expression run over a string holding `run` while `body`
 * runs. Each is recorded once, and one whose `/source/flags` is not in `allowed` is
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
      // Flags are part of the name here: the version-token pattern is allowed
      // sticky (tried at one place) but not global (tried at every place).
      const name = `/${this.source}/${this.flags}`;
      const seen = `${name} over ${input.length} characters`;
      if (!runs.includes(seen)) runs.push(seen);
      if (!allowed.includes(name)) throw new Error(`${name} ran over the run`);
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

const CLASS = /^\s*class\s+[A-Za-z_][A-Za-z0-9_]*\s*<\s*Formula\b/m;
const VERSION = /^\s*version\s+"([^"\n]*)"/m;
const TOKENS = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g;
const field = (key: string): RegExp => new RegExp(`^\\s*-?\\s*${key}:[ \\t]*(\\S+)`);

// Patterns the readers still run over the text, each from a fixed start:
// the sticky remainder of the formula and version lines (tried once per
// line, at its first non-blank character), the `PackageVersion:` check
// (which starts only at that literal at a line start), and the sticky
// version-token pattern (once per run of digits).
const ONE_PASS: ReadonlyArray<string> = [
  `/${/class\s+[A-Za-z_][A-Za-z0-9_]*\s*<\s*Formula\b/.source}/y`,
  `/${/version\s+"([^"\n]*)"/.source}/y`,
  `/${/^PackageVersion:[ \t]*(\S+)[ \t]*$/.source}/m`,
  `/${TOKENS.source}/y`,
];
const unlisted = (runs: ReadonlyArray<string>): string[] =>
  runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`${p} `)));

describe("the reads answer what the patterns answered", () => {
  const pieces = ["\n", " ", "\r", "\u2028", "\t", 'version "1"', "class A < Formula", "x"];

  test("firstAtLineStart and the two line-start patterns", () => {
    const inputs = [
      ...allStrings(pieces, 4),
      'class Foo < Formula\n  version "2.0"',
      " \n\tclass\n  Bar\n<\nFormula",
      'version "a\nb"\nversion "c"',
    ];
    expect(
      answers(inputs, (s) => [
        firstAtLineStart(s, /class\s+[A-Za-z_][A-Za-z0-9_]*\s*<\s*Formula\b/y) !== null,
        firstAtLineStart(s, /version\s+"([^"\n]*)"/y)?.[1],
      ]),
    ).toEqual(answers(inputs, (s) => [CLASS.test(s), VERSION.exec(s)?.[1]]));
  });

  test("wingetField and the winget field pattern", () => {
    const inputs = [
      ...allStrings([" ", "-", "\t", "Architecture:", "x", "\u00a0"], 5),
      "  - Architecture: x64",
      "-Architecture:arm64 # note",
      "Architecture:",
    ];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`${ch}- Architecture: x`, `- ${ch}Architecture: x`, `Architecture:${ch}x${ch}`);
    }
    const re = field("Architecture");
    expect(answers(inputs, (s) => wingetField(s, "Architecture"))).toEqual(
      answers(inputs, (s) => re.exec(s)?.[1]),
    );
  }, 20_000);

  test("versionTokensInUrl and the version-token pattern", () => {
    const inputs = [
      ...allStrings(["1", "2", ".", "-", "+", "a"], 6),
      "/v1.2.3/app-1.2.3-rc.1+build.5-linux.tar.gz",
      "1.2.3.4.5.6",
    ];
    expect(answers(inputs, versionTokensInUrl)).toEqual(
      answers(inputs, (s) => [...s.matchAll(TOKENS)].map((m) => m[0])),
    );
  }, 20_000);
});

describe("no pattern rescans a run in a manifest", () => {
  test("a formula with a run of blank lines before its class line", () => {
    const blanks = "\n".repeat(20_000);
    const text = `${blanks}x\nclass Foo < Formula\n${blanks}  version "1.2.3"\n`;
    // Control: the count sees the old pattern run over the blank lines.
    expect(regexRunsOver(blanks, () => CLASS.test(text)).runs).toEqual([
      `/${CLASS.source}/m over ${text.length} characters`,
    ]);
    const kind = regexRunsOver(blanks, () => detectKind(text), ONE_PASS);
    expect(unlisted(kind.runs)).toEqual([]);
    expect(kind.outcome).toBe("homebrew");
    const parsed = regexRunsOver(blanks, () => parseManifest(text, "f.rb", "homebrew"), ONE_PASS);
    expect(unlisted(parsed.runs)).toEqual([]);
    expect(parsed.outcome).toMatchObject({ ok: true, manifest: { version: "1.2.3" } });
  }, 20_000);

  test("a winget line with a long indent before something else", () => {
    const indent = " ".repeat(100_000);
    const text = `PackageVersion: 1.2.3\nInstallers:\n${indent}x\n  - Architecture: x64\n    InstallerUrl: https://e.example/a.zip\n    InstallerSha256: ${"A".repeat(64)}\n`;
    const parsed = regexRunsOver(indent, () => parseManifest(text, "w.yaml", "winget"), ONE_PASS);
    expect(unlisted(parsed.runs)).toEqual([]);
    expect(parsed.outcome).toMatchObject({
      ok: true,
      manifest: { assets: [{ label: "x64", url: "https://e.example/a.zip" }] },
    });
  });

  test("a URL with a run of digits that holds no version", () => {
    const digits = "1".repeat(100_000);
    const url = `https://e.example/${digits}x/app-1.2.3.zip`;
    const tokens = regexRunsOver(digits, () => versionTokensInUrl(url), ONE_PASS);
    expect(unlisted(tokens.runs)).toEqual([]);
    expect(tokens.outcome).toEqual(["1.2.3"]);
  });
});
