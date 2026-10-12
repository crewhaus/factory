/**
 * Trailing runs are cut in one pass where a deny or ask reads a destination.
 *
 * `/\.+$/` over a host or a recipient, and `/\[.*$/` over a shell
 * assignment's name, try every start inside a run (of dots, of `[`) and,
 * when the run is not at the end, rescan the rest of it from each before
 * giving the start up: quadratic in the run's length. Each value is
 * whatever the call wrote, so each cut is a loop.
 *
 * `/^[A-Za-z]+\s+(.+)$/` over a rule's argument (`GET https://…`) matches
 * only when the rest holds no line break; with text between a run of
 * whitespace and a stray \r, it tried every shorter run and rescanned the
 * rest from each, quadratic in the run, on a spec's rule. That is a read too.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { type OperativeValue, compilePattern, matchesPattern } from "./index";
import { afterMethod, permissionRuleProblems } from "./rule-problems";
import { beforeSubscript, shellRestrictSpellings } from "./shell";
import { withoutTrailingDots } from "./trim";

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

const restrict = { polarity: "restrict" } as const;
const fires = (pattern: string, value: OperativeValue): boolean =>
  matchesPattern(compilePattern(pattern), "T", {}, { ...restrict, operativeValues: [value] });

// Patterns the reading runs over every value, each in one pass: anchored at
// the start (a drive letter, a URL scheme, an IPv6-mapped host, a phone
// shape), one character class, or `<([^<>]*)>`, whose repeat stops at the
// next `<` it could start from. Listed so the test says which they are.
const ONE_PASS: ReadonlyArray<string> = [
  "^[A-Za-z]:[\\\\/]",
  "^([a-z][a-z0-9+.-]*):\\/\\/([^/]*)",
  "[^*?]",
  "^\\[(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})\\]$",
  "<([^<>]*)>",
  "^\\+?[\\d\\s().-]+$",
];
const unlisted = (runs: ReadonlyArray<string>): string[] =>
  runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)));

describe("the cuts return what the regex forms returned", () => {
  test("withoutTrailingDots and /\\.+$/", () => {
    const inputs = [...allStrings([".", "a", "@"], 6), "evil.example.", "é.", "\u{1F600}.."];
    expect(answers(inputs, withoutTrailingDots)).toEqual(
      answers(inputs, (s) => s.replace(/\.+$/, "")),
    );
  });

  test("afterMethod and /^[A-Za-z]+\\s+(.+)$/", () => {
    const inputs = [
      ...allStrings(["G", "t", " ", "\t", "\r", "\u2028", "\n", "x", "*"], 5),
      "GET https://api.example/*",
      "post   https://x",
      "GET ",
      "GET  ",
      "GET \r",
    ];
    // Every code unit, in each place the pattern reads.
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`${ch} x`, `G${ch} x`, `G${ch}x`, `G ${ch}`, `G  ${ch}`, `G x${ch}`, `G ${ch}x`);
    }
    expect(answers(inputs, afterMethod)).toEqual(
      answers(inputs, (s) => /^[A-Za-z]+\s+(.+)$/.exec(s)?.[1]),
    );
  }, 20_000);

  test("beforeSubscript and /\\[.*$/", () => {
    const inputs = [
      ...allStrings(["[", "]", "a", "\r"], 5),
      ...allStrings(["[", "\n", "\u2028", "\u2029", "b"], 4),
      "arr[0]",
      "é[\u{1F600}]",
    ];
    expect(answers(inputs, beforeSubscript)).toEqual(
      answers(inputs, (s) => s.replace(/\[.*$/, "")),
    );
  });
});

describe("no pattern rescans a run in a value a deny reads", () => {
  const dots = ".".repeat(100_000);

  test("a host with a run of dots before its root dot", () => {
    const raw = `https://evil${dots}x./exfil`;
    // Control: the count sees a pattern String#replace runs over the run.
    const host = `evil${dots}x.`;
    expect(regexRunsOver(dots, () => host.replace(/\.+$/, "")).runs).toEqual([
      `/\\.+$/ over ${host.length} characters`,
    ]);
    const value: OperativeValue = { kind: "url", canonical: [new URL(raw).href], spellings: [raw] };
    const read = regexRunsOver(dots, () => fires(`T(https://evil${dots}x/**)`, value), ONE_PASS);
    expect(unlisted(read.runs)).toEqual([]);
    expect(read.outcome).toBe(true);
  }, 20_000);

  test("a recipient with a run of dots in its domain", () => {
    const value: OperativeValue = { kind: "recipient", canonical: [`ceo@corp${dots}x.`] };
    const read = regexRunsOver(dots, () => fires(`T(ceo@corp${dots}x)`, value), ONE_PASS);
    expect(unlisted(read.runs)).toEqual([]);
    expect(read.outcome).toBe(true);
  });

  test("a bare name with a run of dots before its root dot", () => {
    const value: OperativeValue = { kind: "recipient", canonical: [`db${dots}x.`] };
    const read = regexRunsOver(dots, () => fires(`T(db${dots}x)`, value), ONE_PASS);
    expect(unlisted(read.runs)).toEqual([]);
    expect(read.outcome).toBe(true);
  });

  test("an exported name with a run of [ before a quoted carriage return", () => {
    const brackets = "[".repeat(100_000);
    const line = `export 'a${brackets}\rz'=1; echo hi`;
    const read = regexRunsOver(brackets, () => shellRestrictSpellings(line), ONE_PASS);
    expect(unlisted(read.runs)).toEqual([]);
    expect(read.outcome).toContain("echo hi");
  });
});

describe("no pattern rescans a run in a spec's rule", () => {
  test("a method, a run of spaces, then text before a stray carriage return", () => {
    const spaces = " ".repeat(100_000);
    // Control: the count sees the old pattern run over the run.
    const arg = `GET${spaces}x\ry`;
    expect(regexRunsOver(spaces, () => arg.match(/^[A-Za-z]+\s+(.+)$/)).runs).toEqual([
      `/^[A-Za-z]+\\s+(.+)$/ over ${arg.length} characters`,
    ]);
    const read = regexRunsOver(
      spaces,
      () =>
        permissionRuleProblems({
          rules: [
            { type: "allow", pattern: `WebFetch(GET${spaces}x\ry)` },
            { type: "deny", pattern: `WebFetch(GET${spaces}https://a.example/*)` },
          ],
          granted: [{ name: "WebFetch", operativeArgs: [{ kind: "url" }] }],
          known: [],
          mcpServers: [],
        }).map((p) => [p.code, p.suggestion]),
      // A scheme's shape is checked anchored, and stops at the first space.
      ["^[A-Za-z][A-Za-z0-9+.-]*$"],
    );
    expect(new Set(read.runs.map((r) => r.replace(/ over .*/, "")))).toEqual(
      new Set(["/^[A-Za-z][A-Za-z0-9+.-]*$/"]),
    );
    // As before: no URL rule follows a method there, and one does here.
    expect(read.outcome).toEqual([
      ["argument-cannot-match", undefined],
      ["argument-cannot-match", "WebFetch(https://a.example/*)"],
    ]);
  });
});
