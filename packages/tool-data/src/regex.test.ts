/**
 * TableQuery `matches` and JsonQuery `=~` never run a caller's pattern on
 * the caller's thread, and one they could not answer is never "no match".
 *
 * 0.7.0 compiled the pattern per record and ran it synchronously (C073):
 * TableQuery took 423 ms for one record and 1.7 s for four with a
 * catastrophic pattern, and when the engine gave up it answered "no match",
 * so a `none` exclusion returned the very row it was written to stop and
 * JsonQuery reported zero matches. JsonQuery also answered an invalid
 * pattern with zero matches, silently.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setRegexAnswersSessionForTest } from "@crewhaus/tool-schema";
import { jsonQuery, tableQuery } from "./index";

type Tool = typeof tableQuery;
type RegexSession = ReturnType<NonNullable<Parameters<typeof _setRegexAnswersSessionForTest>[0]>>;
type TestEachAnswer = { matched: number[]; undetermined: number[] };

/**
 * Polynomial, so the screen lets it through, and about 0.3 s of backtracking
 * over this text here: the worker reads a no-match that slow as the engine
 * giving up, so the answer is undetermined. That raced the machine: on an
 * engine three times faster it is a definite "no", and on a loaded runner it
 * can outlast the call's deadline instead. So the worker sessions the tools
 * open in this file answer SLOW over this text as the worker answers an
 * input the engine gave up on, without running it, and send every other
 * question to the real worker with the give-up threshold out of reach (at the
 * real 100 ms, a worker thread stalled that long inside a definite no-match
 * reads as giving up too). No clock decides an answer here; each call's 5 s
 * deadline only stops a hang.
 */
const SLOW = { pattern: "a*a*a*a*b", text: "a".repeat(120) };
const CATASTROPHIC = "(a+)+!$|refund";

/** SLOW questions sent to a worker session. */
let askedWorker = 0;
/** SLOW runs over its text on the caller's thread, where nothing can stop them. */
let onThisThread = 0;

function givesUpOnSlow(real: RegexSession): RegexSession {
  return {
    run: async (request) => {
      const asked = request as { op: string; pattern?: string; inputs?: unknown };
      if (asked.op !== "testEach" || asked.pattern !== SLOW.pattern) {
        return real.run({ ...request, giveUpMs: 60_000 });
      }
      askedWorker += 1;
      const inputs = asked.inputs as ReadonlyArray<string>;
      // The real worker answers SLOW over every other input; over its text,
      // the answer is what a testEach run with onGiveUp "skip" gives for an
      // input the engine gave up on: listed as undetermined.
      const others = inputs.flatMap((input, i) => (input === SLOW.text ? [] : [i]));
      const slow = inputs.flatMap((input, i) => (input === SLOW.text ? [i] : []));
      let answer: TestEachAnswer = { matched: [], undetermined: [] };
      if (others.length > 0) {
        const outcome = await real.run({
          ...request,
          inputs: others.map((i) => inputs[i] as string),
          maxMatches: others.length,
          giveUpMs: 60_000,
        });
        if (outcome.status !== "ok") return outcome;
        answer = outcome.result as unknown as TestEachAnswer;
      }
      const back = (list: number[]): number[] => list.map((k) => others[k] as number);
      return {
        status: "ok",
        result: {
          matched: back(answer.matched),
          scanned: inputs.length,
          truncated: false,
          undetermined: [...slow, ...back(answer.undetermined)].sort((a, b) => a - b),
        },
      } as never;
    },
    close: () => real.close(),
  };
}

beforeEach(() => {
  askedWorker = 0;
  onThisThread = 0;
  _setRegexAnswersSessionForTest(givesUpOnSlow);
});

afterEach(() => {
  _setRegexAnswersSessionForTest(undefined);
});

/** Run a tool. A run of SLOW over its text on this thread, as in 0.7.0, is counted and refused. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function call(tool: Tool, input: unknown): Promise<any> {
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, text: string) {
    if (this.source === SLOW.pattern && text === SLOW.text) {
      onThisThread += 1;
      throw new Error(`/${this.source}/ ran over the text on the caller's thread`);
    }
    return realExec.call(this, text);
  };
  let out: unknown;
  try {
    out = await tool.execute(tool.inputSchema.parse(input) as never, {} as never);
  } finally {
    RegExp.prototype.exec = realExec;
  }
  try {
    return JSON.parse(out as string);
  } catch {
    return out;
  }
}

describe("TableQuery matches", () => {
  test("a pattern that backtracks exponentially is an invalid filter, not a pass", async () => {
    const out = await call(tableQuery, {
      records: [{ name: `${"a".repeat(30)}! refund` }],
      where: { none: [{ field: "name", op: "matches", value: CATASTROPHIC }] },
    });
    // 0.7.0: {matched: 1}, the row the exclusion was written to stop.
    expect(out).toMatch(/^invalid filter: invalid regex for name: .*nested-quantifier/);
  });

  test("a row whose pattern has no answer is neither returned nor ruled out", async () => {
    const result = await call(tableQuery, {
      records: [{ name: SLOW.text }, { name: "b" }, { name: "zzz" }],
      where: { none: [{ field: "name", op: "matches", value: SLOW.pattern }] },
    });
    // Asked of the worker, and never run here.
    expect(askedWorker).toBe(1);
    expect(onThisThread).toBe(0);
    expect(result.records).toEqual([{ name: "zzz" }]);
    expect(result).toMatchObject({ matched: 1, undetermined: { count: 1, rows: [0] } });
  });

  test("answered patterns filter as 0.7.0 did, across all, any and none", async () => {
    const records = [
      { sku: "AB-1", note: "ok" },
      { sku: "ab-2", note: "hold" },
      { sku: "CD-3", note: "ok" },
      { sku: "XY-4" },
    ];
    const out = await call(tableQuery, {
      records,
      where: {
        all: [{ field: "sku", op: "matches", value: "^[A-Z]{2}-\\d$" }],
        any: [
          { field: "note", op: "matches", value: "^ok$" },
          { field: "sku", op: "matches", value: "^XY" },
        ],
        none: [{ field: "sku", op: "matches", value: "^CD" }],
      },
    });
    expect(out.records.map((r: { sku: string }) => r.sku)).toEqual(["AB-1", "XY-4"]);
    expect(out.undetermined).toBeUndefined();
  });
});

describe("JsonQuery =~", () => {
  const doc = JSON.stringify({
    groups: [
      { name: "alpha", items: [{ id: "x1" }, { id: "y2" }] },
      { name: "beta", items: [{ id: "x3" }] },
      { name: "apex", items: [{ id: "x4" }, { id: "x5" }] },
    ],
  });

  test("filters under filters are answered in rounds, with 0.7.0's matches", async () => {
    const out = await call(jsonQuery as Tool, {
      json: doc,
      path: "$.groups[?(@.name =~ '^a')].items[?(@.id =~ '^x')].id",
      valuesOnly: true,
    });
    expect(out).toEqual({ count: 3, truncated: false, values: ["x1", "x4", "x5"] });
  });

  test("an invalid or refused pattern is a bad path, not zero matches", async () => {
    const invalid = await call(jsonQuery as Tool, {
      json: doc,
      path: "$.groups[?(@.name =~ '(')]",
    });
    expect(invalid).toMatch(
      /^invalid path: the filter's regex \/\(\/ was not run: .*invalid-syntax/,
    );
    const refused = await call(jsonQuery as Tool, {
      json: JSON.stringify({ rows: [{ name: "aaaa!" }] }),
      path: "$.rows[?(@.name =~ '(a+)+$')]",
    });
    expect(refused).toMatch(/nested-quantifier/);
  });

  test("a node whose filter has no answer is named, and the list is not complete", async () => {
    const result = await call(jsonQuery as Tool, {
      json: JSON.stringify({ rows: [{ name: SLOW.text }, { name: "aab" }] }),
      path: `$.rows[?(@.name =~ '${SLOW.pattern}')]`,
    });
    expect(askedWorker).toBe(1);
    expect(onThisThread).toBe(0);
    // 0.7.0: count 1, truncated false, as if the first row did not match.
    expect(result).toMatchObject({
      count: 1,
      truncated: true,
      undetermined: { count: 1, paths: ["$.rows[0]"] },
    });
  });
});
