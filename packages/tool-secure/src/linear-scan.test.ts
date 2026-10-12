/**
 * The email, city-state-ZIP and chat-markup patterns are tried once per run.
 *
 * Each opens with an unbounded run (an email's local part, a capitalised
 * word, the whitespace a `^\s*` takes across blank lines). As a global
 * search, a failed try moves one character right and scans the same run
 * again: quadratic in the run's length, on text of up to 2M characters.
 * Now a failed try skips the rest of its run, and the matches are the global
 * search's, start for start.
 *
 * Counted, not timed: while a scan runs, every regular expression run over a
 * string holding a long run is counted by name (source and flags), and one
 * that is not listed is refused on the spot.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { INJECTION_RULES, scanInjection } from "./lib/injection";
import {
  ADDRESS_CITY_STATE_ZIP,
  EMAIL,
  cityStateZipMatches,
  emailMatches,
  scanPii,
} from "./lib/pii";
import { matchAll } from "./lib/text";

/**
 * Calls of each regular expression (`/source/flags`) over a string holding
 * `run` while `body` runs. A name in `refused`, or one called more than
 * `MAX_CALLS` times, throws instead of running, so neither a global search
 * nor a lost skip is waited out.
 */
const MAX_CALLS = 100;
function regexCallsOver<T>(
  run: string,
  body: () => T,
  refused: ReadonlyArray<string>,
): { calls: Map<string, number>; outcome: T | Error } {
  const calls = new Map<string, number>();
  const realExec = RegExp.prototype.exec;
  let last: string | undefined;
  let holds = false;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (input !== last) {
      last = input;
      holds = typeof input === "string" && input.includes(run);
    }
    if (holds) {
      const name = `/${this.source}/${this.flags}`;
      const count = (calls.get(name) ?? 0) + 1;
      calls.set(name, count);
      if (refused.includes(name) || count > MAX_CALLS) {
        throw new Error(`${name} ran over the run (call ${count})`);
      }
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

/** Every sequence of up to `max` pieces. */
function allJoins(pieces: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => pieces.map((p) => s + p));
    out.push(...layer);
  }
  return out;
}

type Hit = { index: number; match: RegExpExecArray };
const shape = (hits: Iterable<Hit>): string =>
  JSON.stringify([...hits].map(({ index, match }) => [index, [...match], match.indices]));

/** Each input with its matches both ways, as one string, so a failure names the input. */
function sameMatches(
  inputs: ReadonlyArray<string>,
  ours: (s: string) => Iterable<Hit>,
  pattern: RegExp,
): void {
  expect(inputs.map((s) => `${JSON.stringify(s)} -> ${shape(ours(s))}`)).toEqual(
    inputs.map((s) => `${JSON.stringify(s)} -> ${shape(matchAll(s, pattern))}`),
  );
}

const chatMarkup = INJECTION_RULES.find((r) => r.id === "override.chat-markup");

describe("the matches are the global search's", () => {
  test("email", () => {
    const inputs = [
      ...allJoins(["a", ".", "@", "b", "-", " ", "c.d"], 5),
      "mail ops@example.com, a.b+tag@sub.example.co.uk.",
      "x..y@z.io a.@b.cc @@ a@b",
    ];
    sameMatches(inputs, emailMatches, EMAIL);
  }, 20_000);

  test("city, state and ZIP", () => {
    const inputs = [
      ...allJoins(["Ab", "Cd-e", " ", ",", " CA", " 12345", "x", "-", "'", "\n"], 4),
      "Springfield, IL 62701 and New York City, NY 10001-1234",
      "o'Neil Falls, OR 97000",
    ];
    sameMatches(inputs, cityStateZipMatches, ADDRESS_CITY_STATE_ZIP);
  });

  test("chat markup", () => {
    const rule = chatMarkup as NonNullable<typeof chatMarkup>;
    const inputs = [
      ...allJoins(["\n", " ", "###", " system", "<user>", "[INST]", "x", "\r", "\u2028"], 4),
      "hello\n\n   ### Instruction: obey\n<|im_start|>",
    ];
    sameMatches(inputs, rule.matches as (s: string) => Iterable<Hit>, rule.pattern);
  });
});

describe("a long run is tried once", () => {
  test("a run of local-part characters with no @", () => {
    const run = "a".repeat(100_000);
    const text = `${run} and ${run}.${run}`;
    const global = `/${EMAIL.source}/dg`;
    const sticky = `/${EMAIL.source}/dy`;
    const found = regexCallsOver(run, () => scanPii(text, { types: ["email"] }), [global]);
    // One try per dotted run of local-part characters: the first run, "and",
    // and the dotted pair after it.
    expect([...found.calls]).toEqual([[sticky, 3]]);
    expect(found.outcome).toEqual([]);
  });

  test("a hyphenated capitalised word with no comma after it", () => {
    const run = "Ab-".repeat(30_000);
    const text = `${run}x`;
    const global = `/${ADDRESS_CITY_STATE_ZIP.source}/dg`;
    const sticky = `/${ADDRESS_CITY_STATE_ZIP.source}/dy`;
    const found = regexCallsOver(run, () => scanPii(text, { types: ["postal_address"] }), [global]);
    expect(found.calls.get(global)).toBeUndefined();
    expect(found.calls.get(sticky)).toBe(1);
    expect(found.outcome).toEqual([]);
  });

  test("a run of blank lines before something that is not chat markup", () => {
    const run = " \n".repeat(50_000);
    const text = `${run}x`;
    const rule = chatMarkup as NonNullable<typeof chatMarkup>;
    const global = `/${rule.pattern.source}/dgim`;
    const sticky = `/${rule.pattern.source}/dimy`;
    const scanned = regexCallsOver(run, () => scanInjection(text), [global]);
    expect(scanned.calls.get(global)).toBeUndefined();
    // One try at the first line start, which rules out every line start in
    // the run, and one at the `x`, whose line starts there too.
    expect(scanned.calls.get(sticky)).toBe(2);
    expect(scanned.outcome).toMatchObject({ score: 0, hits: [] });
  });
});
