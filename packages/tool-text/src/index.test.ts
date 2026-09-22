/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * Two things are checked for all of them, because they are the contract the
 * runtime relies on: the safety flags are what the tool contract expects for
 * a pure-compute tool, and the declared schema actually rejects bad input.
 * After that, each tool gets the behaviour tests that matter for it.
 */
import { describe, expect, test } from "bun:test";
import {
  TEXT_TOOLS,
  compactLog,
  countTokens,
  diffParse,
  escapeString,
  extractEntities,
  extractKeywords,
  fuzzyMatch,
  glossaryReplace,
  markdownOutline,
  markdownTable,
  normalizeText,
  regexExtract,
  renderTemplate,
  ruleClassify,
  sortLines,
  textDiff,
  textSimilarity,
  truncateToBudget,
  wrapText,
} from "./index";

/** Tools return compact JSON; parse it so assertions read as data. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: (typeof TEXT_TOOLS)[number], input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

describe("package-wide contract", () => {
  test("every tool is exported in TEXT_TOOLS", () => {
    expect(TEXT_TOOLS.length).toBe(19);
  });

  test("names are unique", () => {
    const names = TEXT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool is PascalCase", () => {
    for (const t of TEXT_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive and internal — this package touches nothing", () => {
    for (const t of TEXT_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, sandbox: t.requiresSandbox }).toEqual({
        name: t.name,
        sandbox: false,
      });
    }
  });

  test("no tool declares an io capability, because none crosses a boundary", () => {
    for (const t of TEXT_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("every tool is concurrency-safe, since all are pure", () => {
    for (const t of TEXT_TOOLS) {
      expect({ name: t.name, safe: t.concurrencySafe }).toEqual({ name: t.name, safe: true });
    }
  });

  test("every description says what it is for, not just what it is", () => {
    for (const t of TEXT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use ");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of TEXT_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });
});

describe("RegexExtract", () => {
  test("returns located matches with groups", async () => {
    const out = await run(regexExtract, {
      text: "v1.2.3 and v4.5.6",
      pattern: "v(?<major>\\d+)\\.\\d+\\.\\d+",
    });
    expect(out.count).toBe(2);
    expect(out.matches[0].groups.major).toBe("1");
    expect(out.matches[0].line).toBe(1);
  });

  test("valuesOnly drops the positional detail", async () => {
    const out = await run(regexExtract, { text: "a1 b2", pattern: "\\w\\d", valuesOnly: true });
    expect(out.values).toEqual(["a1", "b2"]);
    expect(out.matches).toBeUndefined();
  });

  test("an invalid pattern is reported, not thrown", async () => {
    const out = await regexExtract.execute({ text: "x", pattern: "(unclosed" });
    expect(String(out)).toContain("invalid regex");
  });

  test("the schema requires a non-empty pattern", () => {
    expect(regexExtract.inputSchema.safeParse({ text: "x", pattern: "" }).success).toBe(false);
  });
});

describe("TextDiff", () => {
  test("identical inputs report identical with no diff body", async () => {
    const out = await run(textDiff, { a: "same", b: "same" });
    expect(out.identical).toBe(true);
    expect(out.diff).toBeUndefined();
  });

  test("a change produces counts and a unified diff", async () => {
    const out = await run(textDiff, { a: "one\ntwo", b: "one\nthree" });
    expect(out.added).toBe(1);
    expect(out.removed).toBe(1);
    expect(out.diff).toContain("+three");
  });

  test("labels appear in the headers", async () => {
    const out = await run(textDiff, { a: "x", b: "y", aLabel: "before", bLabel: "after" });
    expect(out.diff).toContain("--- before");
    expect(out.diff).toContain("+++ after");
  });

  test("ignoreWhitespace makes an indent-only change invisible", async () => {
    const out = await run(textDiff, { a: "  x", b: "x", ignoreWhitespace: true });
    expect(out.identical).toBe(true);
  });

  test("statsOnly suppresses the body", async () => {
    const out = await run(textDiff, { a: "x", b: "y", statsOnly: true });
    expect(out.added).toBe(1);
    expect(out.diff).toBeUndefined();
  });
});

describe("DiffParse", () => {
  const sample = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,5 @@ function boot() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a;",
    " }",
    "",
  ].join("\n");

  test("every line carries its number in the new file", async () => {
    const out = await run(diffParse, { diff: sample });
    const lines = out.files[0].hunks[0].lines;
    expect(lines.map((l: { newLine: number | null }) => l.newLine)).toEqual([
      10,
      null,
      11,
      12,
      13,
      14,
    ]);
    expect(out.files[0].newPath).toBe("src/app.ts");
    expect({ added: out.added, removed: out.removed }).toEqual({ added: 2, removed: 1 });
  });

  test("the hunk's section heading survives", async () => {
    const out = await run(diffParse, { diff: sample });
    expect(out.files[0].hunks[0].section).toBe("function boot() {");
  });

  test("changedOnly drops context, keeping the line numbers it computed", async () => {
    const out = await run(diffParse, { diff: sample, changedOnly: true });
    expect(out.files[0].hunks[0].lines).toEqual([
      { kind: "removed", oldLine: 11, newLine: null, text: "const b = 2;" },
      { kind: "added", oldLine: null, newLine: 11, text: "const b = 3;" },
      { kind: "added", oldLine: null, newLine: 12, text: "const c = 4;" },
    ]);
  });

  test("summaryOnly replaces the hunks with their count", async () => {
    const out = await run(diffParse, { diff: sample, summaryOnly: true });
    expect(out.files[0].hunks).toBe(1);
  });

  test("path selects one file and reports the others when it misses", async () => {
    const hit = await run(diffParse, { diff: sample, path: "src/app.ts" });
    expect(hit.files.length).toBe(1);
    const miss = await run(diffParse, { diff: sample, path: "nope.ts" });
    expect(miss).toEqual({ found: false, path: "nope.ts", available: ["src/app.ts"] });
  });

  test("an empty diff is an empty result, not an error", async () => {
    expect(await run(diffParse, { diff: "" })).toEqual({
      files: [],
      added: 0,
      removed: 0,
      warnings: [],
    });
  });
});

describe("TruncateToBudget", () => {
  test("text within budget is unchanged", async () => {
    const out = await run(truncateToBudget, { text: "short", maxChars: 100 });
    expect(out.truncated).toBe(false);
    expect(out.text).toBe("short");
  });

  test("maxTokens is converted at four characters per token", async () => {
    const out = await run(truncateToBudget, { text: "x".repeat(100), maxTokens: 10 });
    expect(out.text.length).toBeLessThanOrEqual(40);
    expect(out.truncated).toBe(true);
  });

  test("reports what it dropped", async () => {
    const out = await run(truncateToBudget, { text: "x".repeat(100), maxChars: 20 });
    expect(out.originalChars).toBe(100);
    expect(out.droppedChars).toBeGreaterThan(0);
  });

  test("the schema demands one of the two budgets", () => {
    expect(truncateToBudget.inputSchema.safeParse({ text: "x" }).success).toBe(false);
    expect(truncateToBudget.inputSchema.safeParse({ text: "x", maxChars: 5 }).success).toBe(true);
  });
});

describe("CompactLog", () => {
  test("collapses repeats and prefixes the count", async () => {
    const out = await run(compactLog, { text: "same\nsame\nsame" });
    expect(out.distinctLines).toBe(1);
    expect(out.lines[0]).toBe("x3 same");
  });

  test("floats errors to the top and counts them", async () => {
    const out = await run(compactLog, { text: "ok one\nERROR boom\nok two" });
    expect(out.lines[0]).toContain("ERROR");
    expect(out.errorCount).toBe(1);
  });

  test("a single occurrence carries no count prefix", async () => {
    const out = await run(compactLog, { text: "only once" });
    expect(out.lines[0]).toBe("only once");
  });

  test("reports the original size so the reader knows what was hidden", async () => {
    const out = await run(compactLog, { text: "a\na\nb" });
    expect(out.totalLines).toBe(3);
    expect(out.distinctLines).toBe(2);
  });
});

describe("MarkdownOutline", () => {
  const doc = "# T\nintro\n## A\nbody a\n## B\nbody b";

  test("lists headings with lines", async () => {
    const out = await run(markdownOutline, { text: doc });
    expect(out.count).toBe(3);
    expect(out.headings.map((h: { title: string }) => h.title)).toEqual(["T", "A", "B"]);
  });

  test("maxDepth filters deeper headings", async () => {
    const out = await run(markdownOutline, { text: doc, maxDepth: 1 });
    expect(out.headings.length).toBe(1);
  });

  test("a section returns just that body", async () => {
    const out = await run(markdownOutline, { text: doc, section: "A" });
    expect(out.found).toBe(true);
    expect(out.body).toContain("body a");
    expect(out.body).not.toContain("body b");
  });

  test("a missing section lists what is available instead of failing", async () => {
    const out = await run(markdownOutline, { text: doc, section: "Z" });
    expect(out.found).toBe(false);
    expect(out.available).toEqual(["T", "A", "B"]);
  });

  test("codeBlocksOnly returns the fenced blocks", async () => {
    const out = await run(markdownOutline, {
      text: "# T\n```ts\nconst x = 1;\n```",
      codeBlocksOnly: true,
    });
    expect(out.blocks[0].language).toBe("ts");
    expect(out.blocks[0].code).toContain("const x = 1;");
  });
});

describe("RenderTemplate", () => {
  test("fills placeholders", async () => {
    const out = await run(renderTemplate, {
      template: "Release {{version}} by {{author.name}}",
      data: { version: "1.0", author: { name: "ada" } },
    });
    expect(out.text).toBe("Release 1.0 by ada");
  });

  test("strict mode is the default and reports the missing key", async () => {
    const out = await renderTemplate.execute({ template: "{{nope}}", data: {} });
    expect(String(out)).toContain('"nope"');
  });

  test("lenient mode substitutes empty and lists what was missing", async () => {
    const out = await run(renderTemplate, { template: "[{{nope}}]", data: {}, strict: false });
    expect(out.text).toBe("[]");
    expect(out.missing).toEqual(["nope"]);
  });

  test("the same input always produces the same bytes", async () => {
    const args = { template: "{{a}}{{b}}", data: { a: 1, b: 2 } };
    expect(await renderTemplate.execute(args)).toBe(await renderTemplate.execute(args));
  });
});

describe("RuleClassify", () => {
  const rules = [
    { label: "refund", patterns: ["refund", "money back"] },
    { label: "wismo", patterns: ["where is my order"] },
  ];

  test("labels by rule", async () => {
    const out = await run(ruleClassify, { text: "I need a refund", rules });
    expect(out.label).toBe("refund");
  });

  test("falls back to the default label below threshold", async () => {
    const out = await run(ruleClassify, { text: "hello", rules, defaultLabel: "other" });
    expect(out.label).toBe("other");
  });

  test("returns every label's score so a caller can see the runner-up", async () => {
    const out = await run(ruleClassify, { text: "refund", rules });
    expect(out.scores.refund).toBe(1);
  });

  test("the schema demands at least one rule with at least one pattern", () => {
    expect(ruleClassify.inputSchema.safeParse({ text: "x", rules: [] }).success).toBe(false);
    expect(
      ruleClassify.inputSchema.safeParse({ text: "x", rules: [{ label: "a", patterns: [] }] })
        .success,
    ).toBe(false);
  });

  test("a malformed regex rule is reported, not thrown", async () => {
    const out = await ruleClassify.execute({
      text: "x",
      rules: [{ label: "a", patterns: ["(unclosed"], regex: true }],
    });
    expect(String(out)).toContain("invalid rule pattern");
  });
});

describe("NormalizeText", () => {
  test("folds line endings and trims trailing space by default", async () => {
    const out = await run(normalizeText, { text: "a   \r\nb" });
    expect(out.text).toBe("a\nb");
    expect(out.changed).toBe(true);
  });

  test("reports no change when there was none", async () => {
    const out = await run(normalizeText, { text: "a\nb" });
    expect(out.changed).toBe(false);
  });

  test("two cosmetically different inputs normalize to the same bytes", async () => {
    const a = await run(normalizeText, { text: "x  \r\ny\r\n" });
    const b = await run(normalizeText, { text: "x\ny\n" });
    expect(a.text).toBe(b.text);
  });
});

describe("SortLines", () => {
  test("sorts and reports how many lines remain", async () => {
    const out = await run(sortLines, { text: "b\na\nc" });
    expect(out.text).toBe("a\nb\nc");
    expect(out.count).toBe(3);
  });

  test("unique reports what it removed", async () => {
    const out = await run(sortLines, { text: "a\na\nb", unique: true });
    expect(out.count).toBe(2);
    expect(out.removed).toBe(1);
  });

  test("numeric sorts by value", async () => {
    const out = await run(sortLines, { text: "10\n9", numeric: true });
    expect(out.text).toBe("9\n10");
  });
});

describe("CountTokens", () => {
  test("counts characters, words, lines and estimated tokens", async () => {
    const out = await run(countTokens, { text: "one two\nthree" });
    expect(out.chars).toBe(13);
    expect(out.words).toBe(3);
    expect(out.lines).toBe(2);
    expect(out.estimatedTokens).toBe(4);
  });

  test("empty text has no lines", async () => {
    const out = await run(countTokens, { text: "" });
    expect(out.lines).toBe(0);
    expect(out.estimatedTokens).toBe(0);
  });

  test("says the estimate is an estimate", async () => {
    const out = await run(countTokens, { text: "x" });
    expect(out.note).toContain("estimate");
  });
});

describe("ExtractEntities", () => {
  test("returns a flat map of values by default", async () => {
    const out = await run(extractEntities, {
      text: "mail a@b.com or see https://x.dev",
      kinds: ["email", "url"],
    });
    expect(out.email).toEqual(["a@b.com"]);
    expect(out.url).toEqual(["https://x.dev"]);
  });

  test("withOffsets returns positions instead", async () => {
    const out = await run(extractEntities, {
      text: "a@b.com",
      kinds: ["email"],
      withOffsets: true,
    });
    expect(out.email[0].index).toBe(0);
    expect(out.email[0].line).toBe(1);
  });

  test("the schema rejects an unknown kind", () => {
    expect(extractEntities.inputSchema.safeParse({ text: "x", kinds: ["notAKind"] }).success).toBe(
      false,
    );
  });

  test("the schema demands at least one kind", () => {
    expect(extractEntities.inputSchema.safeParse({ text: "x", kinds: [] }).success).toBe(false);
  });
});

describe("FuzzyMatch", () => {
  test("ranks the exact candidate first", async () => {
    const out = await run(fuzzyMatch, { query: "apple", candidates: ["apply", "apple", "zebra"] });
    expect(out.hits[0].candidate).toBe("apple");
    expect(out.hits[0].score).toBe(1);
  });

  test("the score floor filters unrelated candidates", async () => {
    const out = await run(fuzzyMatch, { query: "apple", candidates: ["zzzzz"], minScore: 0.9 });
    expect(out.hits).toEqual([]);
  });

  test("the schema demands at least one candidate", () => {
    expect(fuzzyMatch.inputSchema.safeParse({ query: "x", candidates: [] }).success).toBe(false);
  });
});

describe("TextSimilarity", () => {
  test("identical text scores 1", async () => {
    const out = await run(textSimilarity, { a: "hello", b: "hello" });
    expect(out.score).toBe(1);
  });

  test("reports which method was used", async () => {
    const out = await run(textSimilarity, { a: "a", b: "b", method: "levenshtein" });
    expect(out.method).toBe("levenshtein");
  });

  test("the score stays within range for unrelated text", async () => {
    const out = await run(textSimilarity, { a: "alpha", b: "omega beta gamma" });
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(1);
  });
});

describe("ExtractKeywords", () => {
  test("ranks the repeated significant term first", async () => {
    const out = await run(extractKeywords, {
      text: "compiler compiler widget the the the",
    });
    expect(out.keywords[0].term).toBe("compiler");
  });

  test("respects the limit", async () => {
    const out = await run(extractKeywords, { text: "alpha beta gamma delta", limit: 2 });
    expect(out.keywords.length).toBe(2);
  });
});

describe("WrapText", () => {
  test("wraps to the requested width", async () => {
    // 15 characters against a 20-column width would not wrap at all, so the
    // input has to exceed the width for this to prove anything.
    const out = (await wrapText.execute({
      text: "aaa bbb ccc ddd eee fff",
      width: 20,
    })) as string;
    expect(out).toContain("\n");
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(20);
  });

  test("a prefix quotes every line", async () => {
    const out = (await wrapText.execute({ text: "one two", width: 40, prefix: "> " })) as string;
    expect(out.startsWith("> ")).toBe(true);
  });

  test("the schema enforces a sane width", () => {
    expect(wrapText.inputSchema.safeParse({ text: "x", width: 2 }).success).toBe(false);
  });
});

describe("EscapeString", () => {
  test("escapes for a regex so the text matches itself literally", async () => {
    const out = (await escapeString.execute({ text: "a.b", target: "regex" })) as string;
    expect(new RegExp(out).test("a.b")).toBe(true);
    expect(new RegExp(out).test("axb")).toBe(false);
  });

  test("escapes for a csv cell", async () => {
    expect(await escapeString.execute({ text: "a,b", target: "csv" })).toBe('"a,b"');
  });

  test("the schema rejects an unknown target", () => {
    expect(escapeString.inputSchema.safeParse({ text: "x", target: "klingon" }).success).toBe(
      false,
    );
  });
});

describe("GlossaryReplace", () => {
  test("applies the mapping and reports the counts", async () => {
    const out = await run(glossaryReplace, {
      text: "we ship ai every day",
      mapping: { ai: "AI" },
    });
    expect(out.text).toBe("we ship AI every day");
    expect(out.replacements).toEqual({ ai: 1 });
  });

  test("whole-word is the default, so substrings are left alone", async () => {
    const out = await run(glossaryReplace, { text: "chain", mapping: { ai: "AI" } });
    expect(out.text).toBe("chain");
  });
});

describe("MarkdownTable", () => {
  test("renders a padded table with a separator row", async () => {
    const out = (await markdownTable.execute({
      rows: [
        { name: "a", n: 1 },
        { name: "bb", n: 22 },
      ],
    })) as string;
    const lines = out.split("\n");
    expect(lines.length).toBe(4);
    expect(lines[1]).toMatch(/^\|\s*-+\s*\|/);
  });

  test("an explicit column order is honoured", async () => {
    const out = (await markdownTable.execute({
      rows: [{ a: 1, b: 2 }],
      columns: ["b", "a"],
    })) as string;
    const header = out.split("\n")[0] as string;
    expect(header.indexOf("b")).toBeLessThan(header.indexOf("a"));
  });

  test("the schema demands at least one row", () => {
    expect(markdownTable.inputSchema.safeParse({ rows: [] }).success).toBe(false);
  });
});
