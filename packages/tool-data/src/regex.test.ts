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
import { describe, expect, test } from "bun:test";
import { jsonQuery, tableQuery } from "./index";

type Tool = typeof tableQuery;

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function call(tool: Tool, input: unknown): Promise<any> {
  const out = await tool.execute(tool.inputSchema.parse(input) as never, {} as never);
  try {
    return JSON.parse(out as string);
  } catch {
    return out;
  }
}

/** How many times a 5 ms timer fired while `body` ran: 0 means the thread was held. */
async function ticksDuring<T>(body: () => Promise<T>): Promise<{ result: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  try {
    return { result: await body(), ticks };
  } finally {
    clearInterval(timer);
  }
}

/** ~0.3 s of backtracking; polynomial, so the screen lets it through. */
const SLOW = { pattern: "a*a*a*a*b", text: "a".repeat(120) };
const CATASTROPHIC = "(a+)+!$|refund";

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
    const { result, ticks } = await ticksDuring(() =>
      call(tableQuery, {
        records: [{ name: SLOW.text }, { name: "b" }, { name: "zzz" }],
        where: { none: [{ field: "name", op: "matches", value: SLOW.pattern }] },
      }),
    );
    expect(ticks).toBeGreaterThan(0);
    expect(result.records).toEqual([{ name: "zzz" }]);
    expect(result).toMatchObject({ matched: 1, undetermined: { count: 1, rows: [0] } });
  }, 20_000);

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
    const { result, ticks } = await ticksDuring(() =>
      call(jsonQuery as Tool, {
        json: JSON.stringify({ rows: [{ name: SLOW.text }, { name: "aab" }] }),
        path: `$.rows[?(@.name =~ '${SLOW.pattern}')]`,
      }),
    );
    expect(ticks).toBeGreaterThan(0);
    // 0.7.0: count 1, truncated false, as if the first row did not match.
    expect(result).toMatchObject({
      count: 1,
      truncated: true,
      undetermined: { count: 1, paths: ["$.rows[0]"] },
    });
  }, 20_000);
});
