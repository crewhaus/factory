/**
 * The pure core: profiling, reconciliation, linkage, reshaping and
 * fixed-width parsing.
 *
 * The cases that matter are the ones where a tool could plausibly guess and
 * be wrong — a duplicate key, a pivot collision, a short line, a Gmail
 * address — because each of those produces output that looks right.
 */
import { describe, expect, test } from "bun:test";
import { statsKernel } from "@crewhaus/tool-math";
import { DriftError, chiSquareHomogeneity, chiSquareUpperTail, compareDrift } from "./lib/drift";
import {
  type CategoricalDrift,
  type NumericDrift,
  type TableProfile,
  classifyCell,
  profileTable,
  quantileEdges,
  reservoirSample,
} from "./lib/profile";
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

// ---------------------------------------------------------------------------
// Drift: the capture, the statistics, and the comparison.
//
// The case that matters most here is not an error — it is the number that
// comes back looking entirely reasonable and means nothing, which is what a
// PSI over freshly-derived bins always is.

const asRows = (values: ReadonlyArray<string | number>): string[][] =>
  values.map((v) => [String(v)]);

function numericDrift(profile: TableProfile, column: string): NumericDrift {
  const drift = profile.columns.find((c) => c.name === column)?.drift;
  if (drift?.kind !== "numeric") {
    throw new Error(`expected a numeric capture for "${column}", got ${String(drift?.kind)}`);
  }
  return drift;
}

function categoricalDrift(profile: TableProfile, column: string): CategoricalDrift {
  const drift = profile.columns.find((c) => c.name === column)?.drift;
  if (drift?.kind !== "categorical") {
    throw new Error(`expected a categorical capture for "${column}", got ${String(drift?.kind)}`);
  }
  return drift;
}

/** 0.0, 0.1, ... 99.9 — a thousand values, evenly spread. */
const SPREAD = Array.from({ length: 1000 }, (_, i) => i / 10);
/** The same shape, moved bodily to 500..599.9. */
const MOVED = SPREAD.map((v) => v + 500);

describe("drift capture", () => {
  test("a profile without the option is byte-for-byte what it always was", () => {
    const plain = profileTable(["x"], asRows([1, 2, 3]));
    expect(plain.driftCapture).toBeUndefined();
    expect(plain.columns[0]?.drift).toBeUndefined();
    // Serialized, an absent capture leaves no trace at all — which is what
    // "backward compatible" has to mean for a stored artifact.
    expect(JSON.stringify(plain)).not.toContain("drift");
  });

  test("a numeric column carries quantile edges spanning its range, and counts over the whole column", () => {
    const profile = profileTable(["x"], asRows(SPREAD), { drift: {} });
    const drift = numericDrift(profile, "x");
    expect(drift.edges[0]).toBe(0);
    expect(drift.edges[drift.edges.length - 1]).toBe(99.9);
    expect(drift.edges).toHaveLength(11);
    expect(drift.counts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(drift.n).toBe(1000);
    expect(drift.unbinnable).toBeNull();
  });

  test("quantile edges collapse on ties, and the surviving bin count is what comes back", () => {
    // Six zeros and four distinct values: five of the eleven quantiles are 0.
    // Keeping them would make zero-width bins nothing can ever land in.
    const edges = quantileEdges([0, 0, 0, 0, 0, 0, 1, 2, 3, 4], 10);
    expect(edges).toHaveLength(6);
    expect(edges[0]).toBe(0);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]).toBeGreaterThan(edges[i - 1] as number);
    }
  });

  test("a constant column is unbinnable, and says so instead of shipping one bin", () => {
    const profile = profileTable(["x"], asRows([5, 5, 5, 5]), { drift: {} });
    const drift = numericDrift(profile, "x");
    expect(drift.edges).toEqual([]);
    expect(drift.unbinnable).toContain("constant at 5");
    expect(quantileEdges([5, 5, 5], 10)).toEqual([]);
  });

  test("the value sample is a seeded reservoir, so the same file profiles identically twice", () => {
    const once = numericDrift(profileTable(["x"], asRows(SPREAD), { drift: {} }), "x");
    const twice = numericDrift(profileTable(["x"], asRows(SPREAD), { drift: {} }), "x");
    expect(once.sample).toEqual(twice.sample);
    expect(once.sample).toHaveLength(500);
    expect(once.sampled).toBe(true);
    // A reservoir, not the first 500 — an export sorted by date would
    // otherwise be sampled as "January", which is not a sample of the year.
    expect(once.sample).not.toEqual(SPREAD.slice(0, 500));
  });

  test("a smaller column is kept whole rather than sampled", () => {
    const drift = numericDrift(profileTable(["x"], asRows([3, 1, 2]), { drift: {} }), "x");
    expect(drift.sampled).toBe(false);
    expect(drift.sample).toEqual([1, 2, 3]);
    expect(reservoirSample([1, 2, 3], 10, 1)).toEqual([1, 2, 3]);
  });

  test("a categorical column carries its counts, and says when the list was capped", () => {
    const rows = asRows(["a", "a", "a", "b", "b", "c"]);
    const whole = categoricalDrift(profileTable(["s"], rows, { drift: {} }), "s");
    expect(whole.valueCounts).toEqual({ a: 3, b: 2, c: 1 });
    expect(whole.truncated).toBe(false);
    expect(whole.otherCount).toBe(0);

    const capped = categoricalDrift(
      profileTable(["s"], rows, { drift: { maxCategories: 2 } }),
      "s",
    );
    expect(capped.truncated).toBe(true);
    expect(capped.distinct).toBe(3);
    expect(capped.otherCount).toBe(1);
  });

  test("a column that is mostly numbers is compared as numbers, and names what it could not parse", () => {
    const drift = numericDrift(
      profileTable(["x"], asRows([1, 2, 3, 4, 5, 6, "oops"]), { drift: {} }),
      "x",
    );
    expect(drift.n).toBe(6);
    expect(drift.unparsed).toBe(1);
  });

  test("a column that is mostly text is compared as labels", () => {
    const drift = categoricalDrift(
      profileTable(["x"], asRows(["a", "b", "c", "d", 1]), { drift: {} }),
      "x",
    );
    expect(drift.distinct).toBe(5);
  });

  test("supplied edges are used verbatim, and out-of-range values are counted, not folded in", () => {
    const profile = profileTable(["x"], asRows([1, 5, 50, 500]), {
      drift: { edges: { x: [0, 10, 20] } },
    });
    const drift = numericDrift(profile, "x");
    expect(drift.edges).toEqual([0, 10, 20]);
    expect(drift.counts).toEqual([2, 0]);
    expect(drift.above).toBe(2);
    expect(drift.below).toBe(0);
  });

  test("the capture header records the settings it was taken under", () => {
    const profile = profileTable(["x"], asRows([1, 2]), {
      nullTokens: ["NIL"],
      drift: { bins: 4, seed: 9, sampleSize: 7, maxCategories: 3 },
    });
    expect(profile.driftCapture).toEqual({
      version: 1,
      binsRequested: 4,
      maxCategories: 3,
      sampleSize: 7,
      seed: 9,
      // Carried because the current side has to be read with the SAME list,
      // or a null-rate jump is a difference between two token lists.
      nullTokens: ["NIL"],
    });
  });
});

describe("chi-square upper tail", () => {
  test("the textbook critical values come back as 0.05", () => {
    expect(chiSquareUpperTail(3.841459, 1)).toBeCloseTo(0.05, 6);
    expect(chiSquareUpperTail(5.991465, 2)).toBeCloseTo(0.05, 6);
    expect(chiSquareUpperTail(16.918978, 9)).toBeCloseTo(0.05, 6);
    expect(chiSquareUpperTail(6.634897, 1)).toBeCloseTo(0.01, 6);
  });

  test("with one degree of freedom it agrees with the kernel's normal tail", () => {
    // Q(1/2, x/2) is erfc(sqrt(x/2)) = 2 * P(Z > sqrt(x)) exactly, so the
    // normal tail already in @crewhaus/tool-math is an independent oracle for
    // this whole incomplete-gamma implementation — including its far tail,
    // where the series and the continued fraction swap over.
    for (const x of [0.01, 0.5, 1, 2, 3.5, 7, 20, 50]) {
      expect(chiSquareUpperTail(x, 1)).toBeCloseTo(
        2 * statsKernel.normalUpperTail(Math.sqrt(x)),
        12,
      );
    }
  });

  test("a statistic of zero is a p of one, and a bad df is refused", () => {
    expect(chiSquareUpperTail(0, 3)).toBe(1);
    expect(chiSquareUpperTail(-1, 3)).toBe(1);
    expect(() => chiSquareUpperTail(1, 0)).toThrow(DriftError);
    expect(() => chiSquareUpperTail(Number.NaN, 1)).toThrow(/finite statistic/);
  });
});

describe("chi-square test of homogeneity", () => {
  test("the 2x2 case matches R's chisq.test(correct = FALSE)", () => {
    // matrix(c(30, 20, 10, 40), nrow = 2) -> X-squared = 16.667, df = 1,
    // p-value = 4.4557e-05.
    const result = chiSquareHomogeneity({ a: 30, b: 10 }, { a: 20, b: 40 });
    expect(result.chiSquare).toBeCloseTo(16.6667, 4);
    expect(result.df).toBe(1);
    expect(result.p).toBeCloseTo(4.4557e-5, 9);
    expect(result.approximationValid).toBe(true);
  });

  test("two identical distributions give exactly zero", () => {
    const result = chiSquareHomogeneity({ a: 10, b: 20 }, { a: 10, b: 20 });
    expect(result.chiSquare).toBe(0);
    expect(result.p).toBe(1);
  });

  test("a category on one side only stays in the table", () => {
    // Dropping it to avoid the zero is how a column that gained a whole new
    // value tests as unchanged.
    const result = chiSquareHomogeneity({ a: 100, b: 100 }, { a: 100, b: 100, c: 100 });
    expect(result.categories).toBe(3);
    expect(result.chiSquare).toBeGreaterThan(50);
  });

  test("a category counted zero on both sides is dropped rather than made a cell", () => {
    // Its column total would be zero, so both its expected counts would be
    // 0/0 and it would inflate df with a cell holding no observation.
    const result = chiSquareHomogeneity({ a: 10, ghost: 0 }, { b: 10, ghost: 0 });
    expect(result.categories).toBe(2);
    expect(result.df).toBe(1);
    expect(Number.isFinite(result.chiSquare)).toBe(true);
  });

  test("rare categories break Cochran's condition and the result says so", () => {
    const result = chiSquareHomogeneity({ a: 20, rare: 1 }, { a: 20, rare: 1 });
    expect(result.cellsBelowFive).toBeGreaterThan(0);
    expect(result.approximationValid).toBe(false);
    expect(result.note).toContain("unreliable");
  });

  test("an empty side, or a single shared category, yields no p at all", () => {
    const empty = chiSquareHomogeneity({ a: 5 }, {});
    expect(empty.p).toBeNull();
    expect(empty.note).toContain("needs both");
    const oneLabel = chiSquareHomogeneity({ a: 5 }, { a: 9 });
    expect(oneLabel.p).toBeNull();
    expect(oneLabel.note).toContain("no distribution over labels");
  });
});

describe("compareDrift", () => {
  const reference = profileTable(["x"], asRows(SPREAD), { drift: {} });
  const againstStoredEdges = profileTable(["x"], asRows(MOVED), {
    drift: { edges: { x: numericDrift(reference, "x").edges } },
  });
  const againstFreshEdges = profileTable(["x"], asRows(MOVED), { drift: {} });

  test("the whole point: stored edges see the shift, fresh edges see nothing", () => {
    const honest = compareDrift(reference, againstStoredEdges, { epsilon: 1e-3 });
    const psi = honest.columns[0]?.psi;
    expect(psi?.band).toBe("significant");
    expect(psi?.value).toBeGreaterThan(10);
    // Every current value is above the reference's largest bin edge, which is
    // the loudest drift signal there is and the one clamping would hide.
    expect(psi?.outOfRange).toEqual({ below: 0, above: 1000 });

    // Had the same two captures been lined up by POSITION — the mistake this
    // design exists to prevent — the index would have been exactly zero: ten
    // deciles against ten deciles, whatever numbers are in them.
    const naive = statsKernel.populationStabilityIndex(
      numericDrift(reference, "x").counts,
      numericDrift(againstFreshEdges, "x").counts,
      { epsilon: 1e-3 },
    );
    expect(naive.psi).toBe(0);
  });

  test("a column binned against different edges is refused, not answered", () => {
    const report = compareDrift(reference, againstFreshEdges, { epsilon: 1e-3 });
    expect(report.columns[0]?.psi).toBeNull();
    expect(report.columns[0]?.notes.join(" ")).toContain("different edges");
    expect(report.columns[0]?.notes.join(" ")).toContain("no meaning");
  });

  test("epsilon moves the verdict across all three bands, which is why it is an input", () => {
    // One decile of the reference empties out entirely: the classic case.
    const base = profileTable(["x"], asRows(SPREAD), { drift: {} });
    const edges = numericDrift(base, "x").edges;
    const emptiedTopDecile = SPREAD.filter((v) => v < 89.91);
    const today = profileTable(["x"], asRows(emptiedTopDecile), { drift: { edges: { x: edges } } });
    const bands = [1e-3, 1e-2, 0.05].map(
      (epsilon) => compareDrift(base, today, { epsilon }).columns[0]?.psi?.band,
    );
    expect(bands).toEqual(["significant", "moderate", "stable"]);
  });

  test("a PSI that leaned on the floor says so", () => {
    const base = profileTable(["x"], asRows(SPREAD), { drift: {} });
    const edges = numericDrift(base, "x").edges;
    const today = profileTable(["x"], asRows(SPREAD.filter((v) => v < 89.91)), {
      drift: { edges: { x: edges } },
    });
    const psi = compareDrift(base, today, { epsilon: 1e-3 }).columns[0]?.psi;
    expect(psi?.epsilonApplied).toBe(true);
    expect(psi?.note).toContain("epsilon floor");
  });

  test("a reference with no drift capture is refused with the command that fixes it", () => {
    const bare = profileTable(["x"], asRows([1, 2, 3]));
    expect(() => compareDrift(bare, againstStoredEdges, { epsilon: 1e-3 })).toThrow(DriftError);
    expect(() => compareDrift(bare, againstStoredEdges, { epsilon: 1e-3 })).toThrow(
      /driftProfile true/,
    );
  });

  test("schema drift names what was added, removed, retyped and re-axised", () => {
    const before = profileTable(
      ["kept", "gone", "flips"],
      [
        ["1", "a", "1"],
        ["2", "b", "2"],
      ],
      {
        drift: {},
      },
    );
    const after = profileTable(
      ["kept", "arrived", "flips"],
      [
        ["1", "a", "alpha"],
        ["2", "b", "beta"],
      ],
      {
        drift: {},
      },
    );
    const report = compareDrift(before, after, { epsilon: 1e-3 });
    expect(report.schema.added).toEqual(["arrived"]);
    expect(report.schema.removed).toEqual(["gone"]);
    expect(report.schema.retyped).toEqual([
      { column: "flips", reference: "integer", current: "string" },
    ]);
    expect(report.schema.kindChanged).toEqual([
      { column: "flips", reference: "numeric", current: "categorical" },
    ]);
    const flips = report.columns.find((c) => c.column === "flips");
    expect(flips?.kind).toBe("incomparable");
    expect(flips?.psi).toBeNull();
    // The comparison it CAN still make is still made.
    expect(flips?.distinct).toEqual({ reference: 2, current: 2, ratio: 1 });
  });

  test("null-rate and cardinality are reported even where no distribution test applies", () => {
    const before = profileTable(["s"], asRows(["a", "b", "c", "d"]), { drift: {} });
    const after = profileTable(["s"], [["a"], [""], [""], [""]], { drift: {} });
    const column = compareDrift(before, after, { epsilon: 1e-3 }).columns[0];
    expect(column?.nulls).toEqual({ reference: 0, current: 0.75, increase: 0.75 });
    expect(column?.distinct).toEqual({ reference: 4, current: 1, ratio: 0.25 });
  });

  test("a capped category list means new categories cannot be named, so none are", () => {
    // With a truncated list there is no way to tell a genuinely new value from
    // one that was always there and merely rare. "Three new payment methods
    // appeared" is a sentence somebody acts on.
    const before = profileTable(["s"], asRows(["a", "a", "b", "c"]), {
      drift: { maxCategories: 2 },
    });
    const after = profileTable(["s"], asRows(["a", "a", "b", "z"]), {
      drift: { maxCategories: 2 },
    });
    const column = compareDrift(before, after, { epsilon: 1e-3 }).columns[0];
    expect(column?.newCategories).toBeNull();
    expect(column?.chiSquare).toBeNull();
    expect(column?.notes.join(" ")).toContain("maxCategories");
  });

  test("an uncapped categorical column names what arrived and what left", () => {
    const before = profileTable(["s"], asRows(["a", "a", "b", "b"]), { drift: {} });
    const after = profileTable(["s"], asRows(["a", "a", "z", "z"]), { drift: {} });
    const column = compareDrift(before, after, { epsilon: 1e-3 }).columns[0];
    expect(column?.newCategories).toEqual(["z"]);
    expect(column?.droppedCategories).toEqual(["b"]);
    expect(column?.chiSquare?.p).not.toBeNull();
  });

  test("a constant reference column gets no PSI and the reason why", () => {
    const before = profileTable(["x"], asRows([7, 7, 7]), { drift: {} });
    const after = profileTable(["x"], asRows([7, 8, 9]), { drift: {} });
    const column = compareDrift(before, after, { epsilon: 1e-3 }).columns[0];
    expect(column?.psi).toBeNull();
    expect(column?.notes.join(" ")).toContain("constant at 7");
  });

  test("two profiles taken under different null-token lists are flagged", () => {
    const before = profileTable(["s"], asRows(["a", "NA"]), { nullTokens: ["NA"], drift: {} });
    const after = profileTable(["s"], asRows(["a", "NA"]), { nullTokens: [], drift: {} });
    const report = compareDrift(before, after, { epsilon: 1e-3 });
    expect(report.notes.join(" ")).toContain("null-token lists");
  });

  test("with no thresholds, ok is true and says it means nothing was checked", () => {
    const report = compareDrift(reference, againstStoredEdges, { epsilon: 1e-3 });
    expect(report.gate).toMatchObject({ configured: false, ok: true, failures: [] });
    expect(report.gate.note).toContain("not because nothing drifted");
  });

  test("configured thresholds trip on what they were set for", () => {
    const report = compareDrift(reference, againstStoredEdges, {
      epsilon: 1e-3,
      thresholds: { psi: 0.25, rowCountRatio: 1.1 },
    });
    expect(report.gate.ok).toBe(false);
    expect(report.gate.failures.join(" ")).toContain("PSI");
    // Both files have a thousand rows, so the row-count gate must NOT fire.
    expect(report.gate.failures.join(" ")).not.toContain("row count");
  });

  test("a p the kernel itself calls invalid cannot trip the p-value gate", () => {
    // Four values against four: the normal approximation to U is off by tens
    // of percent this small. Gating a release on that p is a coin flip with a
    // decimal point, so the gate skips it and the note carries the reason.
    const before = profileTable(["x"], asRows([1, 2, 3, 4]), { drift: {} });
    const after = profileTable(["x"], asRows([90, 91, 92, 93]), {
      drift: {
        edges: {
          x: numericDrift(profileTable(["x"], asRows([1, 2, 3, 4]), { drift: {} }), "x").edges,
        },
      },
    });
    const report = compareDrift(before, after, {
      epsilon: 1e-3,
      thresholds: { pValue: 0.5 },
    });
    const column = report.columns[0];
    expect(column?.mannWhitney?.normalApproximationValid).toBe(false);
    expect(column?.mannWhitney?.p).not.toBeNull();
    expect(report.gate.failures.join(" ")).not.toContain("rank test");
    expect(column?.notes.join(" ")).toContain("below the 8-per-sample rule");
  });

  test("a valid p does trip it, and the rank test reads the direction of the move", () => {
    const before = profileTable(["x"], asRows(SPREAD), { drift: {} });
    const report = compareDrift(before, againstStoredEdges, {
      epsilon: 1e-3,
      thresholds: { pValue: 0.01 },
    });
    const mw = report.columns[0]?.mannWhitney;
    expect(mw?.normalApproximationValid).toBe(true);
    // z is signed from the reference sample, so a negative z means the
    // reference sits lower — today's data moved up, which it did.
    expect(mw?.z).toBeLessThan(0);
    expect(report.gate.failures.join(" ")).toContain("rank test p");
  });

  test("today's column with no parseable numbers gets no PSI and no invented one", () => {
    const before = profileTable(["x"], asRows(SPREAD), { drift: {} });
    const edges = numericDrift(before, "x").edges;
    const after = profileTable(["x"], asRows(["n/a", "n/a", "n/a"]), {
      drift: { edges: { x: edges } },
    });
    const column = compareDrift(before, after, { epsilon: 1e-3 }).columns[0];
    expect(column?.psi).toBeNull();
    expect(column?.notes.join(" ")).toContain("no values that parse as numbers");
  });

  test("every PSI bin can be returned when the three heaviest are not enough", () => {
    const wide = compareDrift(reference, againstStoredEdges, {
      epsilon: 1e-3,
      includeBins: true,
    }).columns[0];
    const narrow = compareDrift(reference, againstStoredEdges, { epsilon: 1e-3 }).columns[0];
    expect(narrow?.psi?.bins).toHaveLength(3);
    expect(wide?.psi?.bins).toHaveLength(wide?.psi?.binCount ?? 0);
    expect(wide?.psi?.binCount).toBe(12);
  });
});

/**
 * The gate's own failure mode: a threshold that was configured, could not be
 * evaluated, and was reported as holding. Every case below is a feed that is
 * visibly broken and a `gate.ok` that used to come back true.
 */
describe("a threshold that could not be checked is not a threshold that held", () => {
  const reference = profileTable(["x"], asRows(SPREAD), { drift: {} });
  const edges = numericDrift(reference, "x").edges;

  test("a numeric column that stopped parsing does not pass a PSI gate", () => {
    // The upstream feed starts quoting amounts with thousands separators, so
    // not one value parses. PSI is refused — correctly — and the refusal used
    // to leave failures empty under the note "every configured threshold held".
    const today = profileTable(["x"], asRows(SPREAD.map((v) => `"${v.toFixed(1)}"`)), {
      drift: { edges: { x: edges } },
    });
    const gate = compareDrift(reference, today, {
      epsilon: 1e-3,
      thresholds: { psi: 0.25, pValue: 0.01 },
    }).gate;
    expect(gate.ok).toBe(false);
    expect(gate.failures).toEqual([]);
    // The REASON, not just the verdict: a gate that fails for the wrong reason
    // is the next bug. `ok === false` is also what a real breach returns.
    expect(gate.unchecked.join(" ")).toContain("the PSI threshold 0.25 was not checked");
    expect(gate.unchecked.join(" ")).toContain("no values that parse as numbers");
    expect(gate.note).toContain("never got to look");
  });

  test("a column binned against different edges does not pass a PSI gate", () => {
    const fresh = profileTable(["x"], asRows(MOVED), { drift: {} });
    const gate = compareDrift(reference, fresh, { epsilon: 1e-3, thresholds: { psi: 0.25 } }).gate;
    expect(gate.ok).toBe(false);
    expect(gate.unchecked.join(" ")).toContain("different edges");
  });

  test("a capped category list does not pass a new-category gate", () => {
    // The refusal to NAME new categories is right; passing the gate that was
    // set to catch them is not. This is the column most likely to be capped —
    // a high-cardinality label — and the gate people put on it.
    const before = profileTable(["s"], asRows(["a", "a", "b", "c"]), {
      drift: { maxCategories: 2 },
    });
    const after = profileTable(["s"], asRows(["a", "a", "b", "z"]), {
      drift: { maxCategories: 2 },
    });
    const gate = compareDrift(before, after, {
      epsilon: 1e-3,
      thresholds: { newCategories: 0 },
    }).gate;
    expect(gate.ok).toBe(false);
    expect(gate.unchecked.join(" ")).toContain("the new-category threshold 0 was not checked");
    expect(gate.unchecked.join(" ")).toContain("maxCategories");
  });

  test("a column that vanished does not pass the per-column gates set on it", () => {
    const before = profileTable(
      ["kept", "gone"],
      [
        ["1", "1"],
        ["2", "2"],
      ],
      { drift: {} },
    );
    const after = profileTable(["kept"], [["1"], ["2"]], { drift: {} });
    const gate = compareDrift(before, after, { epsilon: 1e-3, thresholds: { psi: 0.25 } }).gate;
    expect(gate.ok).toBe(false);
    expect(gate.unchecked.join(" ")).toContain('"gone"');
    expect(gate.unchecked.join(" ")).toContain("not in today's data");
  });

  test("an invalid p stays out of failures, but does not count as holding either", () => {
    // Four against four: the kernel itself calls the approximation invalid, so
    // it must not be reported as a breach — and must not be reported as a pass.
    const before = profileTable(["x"], asRows([1, 2, 3, 4]), { drift: {} });
    const after = profileTable(["x"], asRows([90, 91, 92, 93]), {
      drift: { edges: { x: numericDrift(before, "x").edges } },
    });
    const gate = compareDrift(before, after, { epsilon: 1e-3, thresholds: { pValue: 0.5 } }).gate;
    expect(gate.failures.join(" ")).not.toContain("rank test");
    expect(gate.ok).toBe(false);
    expect(gate.unchecked.join(" ")).toContain("below the 8-per-sample rule");
  });

  test("a gate with every measurement in hand still passes, and says nothing went unchecked", () => {
    // The other half of the claim: fail-closed must not mean fail-always. A
    // categorical column has no PSI and a numeric one has no categories, and
    // neither absence is a gap.
    const before = profileTable(
      ["x", "s"],
      SPREAD.map((v, i) => [String(v), i % 2 === 0 ? "a" : "b"]),
      { drift: {} },
    );
    const after = profileTable(
      ["x", "s"],
      SPREAD.map((v, i) => [String(v), i % 2 === 0 ? "a" : "b"]),
      {
        drift: { edges: { x: numericDrift(before, "x").edges } },
      },
    );
    const gate = compareDrift(before, after, {
      epsilon: 1e-3,
      thresholds: {
        psi: 0.1,
        pValue: 0.01,
        newCategories: 0,
        cardinalityRatio: 1.5,
        schemaDrift: true,
      },
    }).gate;
    expect(gate).toMatchObject({ ok: true, failures: [], unchecked: [] });
    expect(gate.note).toBe("every configured threshold held");
  });
});

describe("column names and cell values are data, not identifiers", () => {
  test("a category literally called __proto__ is counted, not swallowed", () => {
    // On a plain `{}` the assignment hits Object.prototype's accessor and the
    // entry disappears — while `truncated` still says false and `otherCount`
    // still says zero, so the capture claims a complete list that is missing a
    // category, and the value that arrived today is never named as new.
    const before = profileTable(["s"], asRows(["a", "a", "b", "b"]), { drift: {} });
    const after = profileTable(["s"], asRows(["a", "a", "__proto__", "__proto__"]), { drift: {} });
    const capture = categoricalDrift(after, "s");
    expect(capture.valueCounts).toEqual({ ["__proto__"]: 2, a: 2 });
    expect(capture.truncated).toBe(false);
    // The capture's own invariant: the kept counts plus the overflow are the
    // non-null cells. A swallowed key breaks it silently.
    const kept = Object.values(capture.valueCounts).reduce((a, b) => a + b, 0);
    expect(kept + capture.otherCount).toBe(capture.counted);

    const column = compareDrift(before, after, {
      epsilon: 1e-3,
      thresholds: { newCategories: 0 },
    });
    expect(column.columns[0]?.newCategories).toEqual(["__proto__"]);
    expect(column.columns[0]?.chiSquare?.categories).toBe(3);
    expect(column.gate.failures.join(" ")).toContain("__proto__");
  });

  test("a column named __proto__ that the reference could not bin does not crash the comparison", () => {
    // The edges map has no entry for it, and on a plain object the miss reads
    // back as Object.prototype — not undefined, so the column is forced down
    // the numeric path with an "edges" whose length is undefined, and
    // `binCounts` dies in `new Array(NaN)` three frames down.
    const before = profileTable(["__proto__"], asRows([5, 5, 5]), { drift: {} });
    const after = profileTable(["__proto__"], asRows([1, 2, 3]), { drift: { edges: {} } });
    expect(numericDrift(after, "__proto__").edges.length).toBeGreaterThan(1);
    const report = compareDrift(before, after, { epsilon: 1e-3 });
    expect(report.columns[0]?.notes.join(" ")).toContain("constant at 5");
  });

  test("a repeated header is reported, not compared against whichever column came last", () => {
    // Both reference columns called "s" would be matched to today's LAST "s",
    // so two IDENTICAL files came back saying "s" gained two categories and
    // lost two — a false alarm nobody can reproduce by looking at the data.
    const rows = [
      ["open", "US"],
      ["open", "US"],
      ["closed", "GB"],
      ["closed", "GB"],
    ];
    const before = profileTable(["s", "s"], rows, { drift: {} });
    const after = profileTable(["s", "s"], rows, { drift: {} });
    const report = compareDrift(before, after, {
      epsilon: 1e-3,
      thresholds: { newCategories: 0 },
    });
    expect(report.columns).toEqual([]);
    expect(report.notes.join(" ")).toContain('no comparison for "s"');
    expect(report.notes.join(" ")).toContain("Rename them upstream");
    // And it must not pass a gate it never evaluated.
    expect(report.gate.ok).toBe(false);
    expect(report.gate.failures).toEqual([]);
    expect(report.gate.unchecked.join(" ")).toContain("more than one column carries that name");
  });
});

describe("a baseline somebody edited by hand", () => {
  const good = profileTable(["x"], asRows(SPREAD), { drift: {} });
  const today = profileTable(["x"], asRows(MOVED), {
    drift: { edges: { x: numericDrift(good, "x").edges } },
  });
  const bend = (mutate: (drift: Record<string, unknown>) => void): TableProfile => {
    const copy = JSON.parse(JSON.stringify(good)) as TableProfile;
    mutate((copy.columns[0] as { drift: Record<string, unknown> }).drift);
    return copy;
  };

  test("counts that no longer match the edges are refused by column, before the sum", () => {
    // The kernel's own guard fires from three frames down as "reference has 5
    // bins and current has 12", naming no column. That is the error nobody can
    // act on, which is why this is checked here.
    const column = compareDrift(
      bend((d) => {
        d["counts"] = [1, 2, 3];
      }),
      today,
      { epsilon: 1e-3 },
    ).columns[0];
    expect(column?.psi).toBeNull();
    expect(column?.notes.join(" ")).toContain('no PSI for "x"');
    expect(column?.notes.join(" ")).toContain("hand-edited");
  });

  test("a missing out-of-range count is refused rather than summed as undefined", () => {
    const column = compareDrift(
      bend((d) => {
        d["below"] = undefined as unknown as number;
      }),
      today,
      { epsilon: 1e-3 },
    ).columns[0];
    expect(column?.psi).toBeNull();
    expect(column?.notes.join(" ")).toContain("not a count");
  });

  test("a value sample holding a non-number gets no rank test, by column name", () => {
    const column = compareDrift(
      bend((d) => {
        d["sample"] = [1, 2, Number.NaN];
      }),
      today,
      { epsilon: 1e-3 },
    ).columns[0];
    expect(column?.mannWhitney).toBeNull();
    expect(column?.notes.join(" ")).toContain("not a finite number");
    // The PSI is independent of the sample, so it still comes back.
    expect(column?.psi?.value).toBeGreaterThan(10);
  });
});
