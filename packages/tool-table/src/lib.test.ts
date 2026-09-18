/**
 * The pure core: profiling, reconciliation, linkage, reshaping and
 * fixed-width parsing.
 *
 * The cases that matter are the ones where a tool could plausibly guess and
 * be wrong — a duplicate key, a pivot collision, a short line, a Gmail
 * address — because each of those produces output that looks right.
 */
import { describe, expect, test } from "bun:test";
import { classifyCell, profileTable } from "./lib/profile";
import {
  diffTables,
  editDistance,
  linkRecords,
  normalizeContact,
  normalizeField,
  similarity,
} from "./lib/reconcile";
import { parseFixedWidth, shardRows, toLong, toWide } from "./lib/reshape";

describe("column classification", () => {
  test("each shape is recognised", () => {
    expect(classifyCell("42")).toBe("integer");
    expect(classifyCell("-3.5")).toBe("decimal");
    expect(classifyCell("2026-01-02")).toBe("date");
    expect(classifyCell("2026-01-02T03:04:05Z")).toBe("datetime");
    expect(classifyCell("true")).toBe("boolean");
    expect(classifyCell("hello")).toBe("string");
    expect(classifyCell("  ")).toBe("empty");
  });

  test("0 and 1 are integers, not booleans", () => {
    // Calling a column of counts a flag is a worse error than the reverse,
    // and an all-0/1 column is visible in `top` either way.
    expect(classifyCell("0")).toBe("integer");
    expect(classifyCell("1")).toBe("integer");
  });
});

describe("profiling", () => {
  const headers = ["id", "name", "qty", "note", "const"];
  const rows = [
    ["1", "Alice", "10", "", "k"],
    ["2", "Bob", "20", "x", "k"],
    ["3", "Carol", "", "", "k"],
    ["3", "Carol", "", "", "k"],
  ];

  test("counts, types, nulls and distinct values are per column", () => {
    const profile = profileTable(headers, rows);
    const byName = Object.fromEntries(profile.columns.map((c) => [c.name, c]));
    expect(profile.rows).toBe(4);
    expect(byName["id"]?.type).toBe("integer");
    expect(byName["qty"]?.nulls).toBe(2);
    expect(byName["qty"]?.nullFraction).toBe(0.5);
    expect(byName["name"]?.distinct).toBe(3);
    expect(byName["qty"]).toMatchObject({ min: 10, max: 20 });
  });

  test("a column with more than one non-empty type is mixed, and says which", () => {
    const profile = profileTable(["v"], [["1"], ["two"], ["3"]]);
    expect(profile.columns[0]?.type).toBe("mixed");
    expect(profile.columns[0]?.types).toEqual({ integer: 2, string: 1 });
  });

  test("duplicate rows and constant columns are reported", () => {
    const profile = profileTable(headers, rows);
    expect(profile.duplicateRows).toBe(1);
    expect(profile.constantColumns).toEqual(["const"]);
  });

  test("a candidate key must be unique AND complete", () => {
    // `qty` has distinct non-null values but two nulls, so it cannot key a
    // join; offering it would be worse than offering nothing.
    const profile = profileTable(headers, rows);
    expect(profile.candidateKeys).toEqual([]);
    const clean = profileTable(["k"], [["a"], ["b"], ["c"]]);
    expect(clean.candidateKeys).toEqual(["k"]);
  });

  test("an empty column is named as empty rather than as a string column", () => {
    const profile = profileTable(["e"], [[""], [""]]);
    expect(profile.columns[0]?.type).toBe("empty");
    expect(profile.emptyColumns).toEqual(["e"]);
  });

  test("null tokens are configurable and counted as nulls", () => {
    const profile = profileTable(["v"], [["N/A"], ["1"]], { nullTokens: ["N/A"] });
    expect(profile.columns[0]).toMatchObject({ nulls: 1, type: "integer" });
  });
});

describe("table diff", () => {
  const before = [
    { id: "1", qty: "10" },
    { id: "2", qty: "20" },
    { id: "3", qty: "30" },
  ];
  const after = [
    { id: "1", qty: "11" },
    { id: "2", qty: "20" },
    { id: "4", qty: "40" },
  ];

  test("added, removed, changed and unchanged are separated", () => {
    const diff = diffTables(before, after, ["id"]);
    expect(diff.added).toEqual([{ id: "4", qty: "40" }]);
    expect(diff.removed).toEqual([{ id: "3", qty: "30" }]);
    expect(diff.changed).toEqual([
      { key: '["1"]', changes: [{ column: "qty", from: "10", to: "11" }] },
    ]);
    expect(diff.unchanged).toBe(1);
  });

  test("a duplicate key is reported rather than resolved", () => {
    // With a duplicate there is no fact about which row became which, and
    // picking one makes a diff that looks authoritative and is arbitrary.
    const diff = diffTables([...before, { id: "1", qty: "99" }], after, ["id"]);
    expect(diff.duplicateKeys).toEqual([{ key: '["1"]', side: "before", count: 2 }]);
  });

  test("a compound key works and ignored columns are not compared", () => {
    const a = [{ a: "1", b: "2", updated: "t1" }];
    const b = [{ a: "1", b: "2", updated: "t2" }];
    expect(diffTables(a, b, ["a", "b"]).changed).toHaveLength(1);
    expect(diffTables(a, b, ["a", "b"], ["updated"]).unchanged).toBe(1);
  });

  test("columns present on only one side are named", () => {
    const diff = diffTables([{ id: "1", old: "x" }], [{ id: "1", fresh: "y" }], ["id"]);
    expect(diff.columnsOnlyInBefore).toEqual(["old"]);
    expect(diff.columnsOnlyInAfter).toEqual(["fresh"]);
  });

  test("a key column that is not in the table is an error, not an empty diff", () => {
    expect(() => diffTables(before, after, ["nope"])).toThrow(/not in the before table/);
    expect(() => diffTables(before, after, [])).toThrow(/at least one key column/);
  });
});

describe("contact normalization", () => {
  test("Gmail dots and +tags fold, and only for Gmail", () => {
    // Treating a.b@other.com as ab@other.com merges two different people.
    expect(normalizeContact({ email: "A.B+work@Gmail.com" }).email).toBe("ab@gmail.com");
    expect(normalizeContact({ email: "a.b@other.com" }).email).toBe("a.b@other.com");
    expect(normalizeContact({ email: "a.b+t@googlemail.com" }).email).toBe("ab@gmail.com");
  });

  test("a +tag is dropped for any domain, since it is an alias everywhere it works", () => {
    expect(normalizeContact({ email: "user+news@other.com" }).email).toBe("user@other.com");
  });

  test("every fold is named, so nothing is silently merged", () => {
    const result = normalizeContact({ email: "A.B+work@Gmail.com" });
    expect(result.notes).toContain("dropped an email +tag");
    expect(result.notes).toContain("folded gmail dots");
  });

  test("a phone keeps its international form and says when it assumed one", () => {
    expect(normalizeContact({ phone: "+44 20 7946 0958" }).phone).toBe("+442079460958");
    expect(normalizeContact({ phone: "0044 20 7946 0958" }).phone).toBe("+442079460958");
    const assumed = normalizeContact({ phone: "(020) 7946 0958", defaultCountryCode: "44" });
    expect(assumed.phone).toBe("+442079460958");
    expect(assumed.notes.some((n) => n.includes("assumed country code"))).toBe(true);
  });

  test("without a country code the number stays national and says so", () => {
    const result = normalizeContact({ phone: "(020) 7946 0958" });
    expect(result.phone).toBe("02079460958");
    expect(result.notes.some((n) => n.includes("may not compare across regions"))).toBe(true);
  });

  test("a name key drops titles and ignores word order", () => {
    expect(normalizeContact({ name: "Dr Jane Smith" }).nameKey).toBe("jane smith");
    expect(normalizeContact({ name: "Smith, Jane" }).nameKey).toBe("jane smith");
  });

  test("a company key drops the legal suffix", () => {
    expect(normalizeContact({ company: "Acme Ltd." }).company).toBe("acme");
    expect(normalizeContact({ company: "ACME, Inc" }).company).toBe("acme");
  });

  test("the original is never discarded", () => {
    expect(normalizeContact({ name: "Dr Jane Smith" }).name).toBe("Dr Jane Smith");
  });
});

describe("record linkage", () => {
  const left = [{ name: "Dr Jane Smith", email: "A.B+work@Gmail.com" }];
  const right = [{ name: "Smith Jane", email: "ab@gmail.com" }];

  test("without normalization these do not match, which is honest", () => {
    const result = linkRecords(left, right, [{ field: "name", compare: "fuzzy", weight: 1 }]);
    expect(result.matched).toHaveLength(0);
  });

  test("with normalization they do, and the evidence says why", () => {
    const result = linkRecords(left, right, [
      { field: "name", compare: "fuzzy", weight: 1, normalize: "name" },
    ]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.evidence[0]).toMatchObject({ field: "name", similarity: 1 });
  });

  test("a pair between the floors is returned for review, not accepted", () => {
    const result = linkRecords(
      [{ name: "Jonathan Smith" }],
      [{ name: "Jonathon Smyth" }],
      [{ field: "name", compare: "fuzzy", weight: 1, threshold: 0.5 }],
      { accept: 0.95, review: 0.5 },
    );
    expect(result.matched).toHaveLength(0);
    expect(result.review).toHaveLength(1);
  });

  test("a record is used once: two candidates is a question, not two matches", () => {
    const result = linkRecords(
      [{ k: "same" }],
      [{ k: "same" }, { k: "same" }],
      [{ field: "k", compare: "exact", weight: 1 }],
    );
    expect(result.matched).toHaveLength(1);
    expect(result.unmatchedRight).toHaveLength(1);
  });

  test("an empty field on either side contributes nothing rather than matching", () => {
    const result = linkRecords(
      [{ a: "", b: "x" }],
      [{ a: "", b: "x" }],
      [
        { field: "a", compare: "exact", weight: 1 },
        { field: "b", compare: "exact", weight: 1 },
      ],
      { review: 0.4 },
    );
    // Only `b` counted, so the score is 0.5 of the total weight — an empty
    // field matching an empty field would have made this a perfect 1.0.
    expect(result.matched).toHaveLength(0);
    expect(result.review[0]?.score).toBe(0.5);
    expect(result.review[0]?.evidence.map((e) => e.field)).toEqual(["b"]);
  });

  test("a fuzzy comparison is bounded, so cost does not explode with value length", () => {
    // Edit distance is quadratic in the length, so the real cost is
    // comparisons TIMES length squared — and a cap on comparisons alone
    // bounds the wrong quantity. Thirty against thirty, with 3,000-character
    // values, is only 900 comparisons and took forty-five seconds.
    const long = (i: number) => ({ v: `${"x".repeat(3_000)}${i}` });
    const left = Array.from({ length: 30 }, (_, i) => long(i));
    const right = Array.from({ length: 30 }, (_, i) => long(i));
    const started = performance.now();
    linkRecords(left, right, [{ field: "v", compare: "fuzzy", weight: 1 }]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("rules that sum to no weight are refused", () => {
    expect(() => linkRecords(left, right, [])).toThrow(/at least one rule/);
  });

  test("edit distance and similarity behave at the edges", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(similarity("same", "same")).toBe(1);
    expect(similarity("", "")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });

  test("normalizeField routes to the right canonicalizer", () => {
    expect(normalizeField("Dr Jane Smith", "name")).toBe("jane smith");
    expect(normalizeField("A.B@Gmail.com", "email")).toBe("ab@gmail.com");
    expect(normalizeField("Acme Ltd", "company")).toBe("acme");
    expect(normalizeField("  MiXeD  ", undefined)).toBe("mixed");
  });
});

describe("reshaping", () => {
  const wide = [
    { region: "N", jan: "10", feb: "20" },
    { region: "S", jan: "30", feb: "" },
  ];

  test("wide to long drops empty cells unless asked to keep them", () => {
    expect(toLong(wide, ["region"], ["jan", "feb"])).toHaveLength(3);
    expect(toLong(wide, ["region"], ["jan", "feb"], { keepEmpty: true })).toHaveLength(4);
  });

  test("the output column names can be chosen, and cannot collide with an id", () => {
    const rows = toLong(wide, ["region"], ["jan"], { variableName: "month", valueName: "amount" });
    expect(rows[0]).toEqual({ region: "N", month: "jan", amount: "10" });
    expect(() => toLong(wide, ["region"], ["jan"], { variableName: "region" })).toThrow(
      /cannot also be/,
    );
  });

  test("long to wide fills absent cells and sorts the new columns", () => {
    const long = [
      { region: "N", month: "jan", v: "10" },
      { region: "N", month: "feb", v: "20" },
      { region: "S", month: "jan", v: "30" },
    ];
    const result = toWide(long, ["region"], "month", "v", { fill: "-" });
    expect(result.columns).toEqual(["region", "feb", "jan"]);
    expect(result.rows).toEqual([
      { region: "N", feb: "20", jan: "10" },
      { region: "S", feb: "-", jan: "30" },
    ]);
  });

  test("pivoting on a high-cardinality column is refused, not answered", () => {
    // An id or a timestamp gives a column per row: a table nobody can read
    // rather than an error anybody notices.
    const rows = Array.from({ length: 3_000 }, (_, i) => ({ k: "one", m: `v${i}`, val: "1" }));
    expect(() => toWide(rows, ["k"], "m", "val")).toThrow(/distinct values/);
    expect(() => toWide(rows, ["k"], "m", "val", { maxColumns: 5_000 })).not.toThrow();
  });

  test("a repeated identifier and variable is a collision, reported not resolved", () => {
    // Silently taking the last makes a pivot that looks complete and is
    // wrong in a way nothing downstream can detect.
    const long = [
      { r: "N", m: "jan", v: "10" },
      { r: "N", m: "jan", v: "99" },
    ];
    const result = toWide(long, ["r"], "m", "v");
    expect(result.collisions).toEqual([{ key: '["N"]', variable: "jan", count: 2 }]);
    expect(result.rows[0]?.["jan"]).toBe("10");
  });
});

describe("sharding", () => {
  const header = ["a", "b"];
  const rows = Array.from({ length: 5 }, (_, i) => [String(i), `v${i}`]);

  test("every shard carries the header", () => {
    // A split that put it only on the first piece leaves the rest needing it
    // grafted back on, which is how a column ends up shifted.
    const { shards, bodies } = shardRows(header, rows, { maxRows: 2 });
    expect(shards).toHaveLength(3);
    for (const body of bodies) expect(body.startsWith("a,b\n")).toBe(true);
  });

  test("shards report where they start, and the rows add up", () => {
    const { shards } = shardRows(header, rows, { maxRows: 2 });
    expect(shards.map((s) => s.firstRow)).toEqual([1, 3, 5]);
    expect(shards.reduce((sum, s) => sum + s.rows, 0)).toBe(5);
  });

  test("cells needing quotes are quoted", () => {
    const { bodies } = shardRows(["a"], [['x,y"z']], { maxRows: 10 });
    expect(bodies[0]).toContain('"x,y""z"');
  });

  test("with no bound at all it is an error rather than one huge shard", () => {
    expect(() => shardRows(header, rows, {})).toThrow(/maxRows or maxBytes/);
  });
});

describe("fixed width", () => {
  const fields = [
    { name: "name", start: 1, length: 10 },
    { name: "qty", start: 11, length: 4 },
    { name: "st", start: 15, length: 2 },
  ];

  test("positions are 1-based and inclusive, as layout documents state them", () => {
    const result = parseFixedWidth("ALICE     0010NY\n", fields);
    expect(result.rows[0]).toEqual({ name: "ALICE", qty: "0010", st: "NY" });
  });

  test("a short line is reported rather than padded", () => {
    // Padding turns a truncated record into one with empty trailing fields
    // that read as real data.
    const result = parseFixedWidth("ALICE     0010NY\nSHORT\n", fields);
    expect(result.shortLines).toEqual([{ line: 2, length: 5 }]);
    expect(result.rows).toHaveLength(2);
  });

  test("trimming is on by default and can be turned off per field", () => {
    const padded = parseFixedWidth("ALICE     0010NY\n", [
      { name: "name", start: 1, length: 10, trim: false },
    ]);
    expect(padded.rows[0]?.["name"]).toBe("ALICE     ");
  });

  test("header lines can be skipped, and blank lines are ignored", () => {
    const result = parseFixedWidth("HEADER\nALICE     0010NY\n\n", fields, { skipLines: 1 });
    expect(result.rows).toHaveLength(1);
  });

  test("a zero or negative position is refused", () => {
    expect(() => parseFixedWidth("x", [{ name: "a", start: 0, length: 1 }])).toThrow(/1-based/);
    expect(() => parseFixedWidth("x", [])).toThrow(/at least one field/);
  });
});
