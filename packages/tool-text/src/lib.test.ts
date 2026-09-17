/**
 * The pure core. Every function here is tested directly, because a bug in
 * `levenshtein` reads better as a failing unit than as a failing tool call.
 */
import { describe, expect, test } from "bun:test";
import { diffLines, diffStats, renderUnified } from "./lib/diff";
import { ENTITY_KINDS, extractEntities } from "./lib/entities";
import { escapeFor, truncateToChars, wrapText } from "./lib/format";
import { estimateTokens, lineStarts, offsetToLineCol, tokenize } from "./lib/locate";
import { compactLogLines, looksLikeError, stripTimestamps } from "./lib/log";
import {
  codeBlocks,
  markdownTable,
  parseHeadings,
  renderOutline,
  sectionBody,
  slugify,
} from "./lib/markdown";
import { glossaryReplace, normalizeText, sortLines, stripAnsi } from "./lib/normalize";
import { regexExtractAll } from "./lib/regex";
import {
  extractKeywords,
  fuzzyRank,
  jaccard,
  jaroWinkler,
  levenshtein,
  levenshteinRatio,
  nGrams,
  similarity,
} from "./lib/similarity";
import { TemplateError, classifyByRules, lookupPath, renderTemplateString } from "./lib/template";

const ESC = String.fromCharCode(27);

describe("locate", () => {
  test("lineStarts marks the offset after every newline", () => {
    expect(lineStarts("ab\ncd\n")).toEqual([0, 3, 6]);
  });

  test("offsetToLineCol is 1-based on both axes", () => {
    const starts = lineStarts("ab\ncd");
    expect(offsetToLineCol(starts, 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToLineCol(starts, 3)).toEqual({ line: 2, column: 1 });
    expect(offsetToLineCol(starts, 4)).toEqual({ line: 2, column: 2 });
  });

  test("estimateTokens rounds up so a budget is never undersold", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("tokenize lowercases and drops punctuation", () => {
    expect(tokenize("Hello, World! It's 2026.")).toEqual(["hello", "world", "it's", "2026"]);
  });
});

describe("regexExtractAll", () => {
  test("locates each match by offset and line", () => {
    const { matches } = regexExtractAll("foo\nbar foo", "foo", "", 10);
    expect(matches.length).toBe(2);
    expect(matches[0]).toMatchObject({ match: "foo", index: 0, line: 1, column: 1 });
    expect(matches[1]).toMatchObject({ match: "foo", line: 2, column: 5 });
  });

  test("returns named capture groups", () => {
    const { matches } = regexExtractAll("v1.2.3", "(?<major>\\d+)\\.(?<minor>\\d+)", "", 10);
    expect(matches[0]?.groups).toEqual({ major: "1", minor: "2" });
  });

  test("returns positional captures too", () => {
    const { matches } = regexExtractAll("a=1", "(\\w)=(\\d)", "", 10);
    expect(matches[0]?.captures).toEqual(["a", "1"]);
  });

  test("a zero-width pattern terminates instead of spinning", () => {
    const { matches } = regexExtractAll("abc", "x*", "", 100);
    expect(matches.length).toBeLessThanOrEqual(100);
    expect(matches.length).toBeGreaterThan(0);
  });

  test("respects maxMatches and reports truncation", () => {
    const { matches, truncated } = regexExtractAll("aaaa", "a", "", 2);
    expect(matches.length).toBe(2);
    expect(truncated).toBe(true);
  });

  test("does not report truncation when everything fit", () => {
    expect(regexExtractAll("aa", "a", "", 10).truncated).toBe(false);
  });

  test("honours case-insensitive flags", () => {
    expect(regexExtractAll("FOO", "foo", "i", 10).matches.length).toBe(1);
  });
});

describe("diff", () => {
  test("identical inputs produce no changes", () => {
    const ops = diffLines(["a", "b"], ["a", "b"]);
    expect(diffStats(ops)).toEqual({ added: 0, removed: 0, same: 2 });
  });

  test("counts an insertion and a deletion", () => {
    const ops = diffLines(["a", "b"], ["a", "c"]);
    const stats = diffStats(ops);
    expect(stats.added).toBe(1);
    expect(stats.removed).toBe(1);
  });

  test("finds the longest common subsequence rather than a naive pairing", () => {
    // Inserting one line in the middle should be 1 add, 0 removes.
    const ops = diffLines(["a", "b", "c"], ["a", "x", "b", "c"]);
    expect(diffStats(ops)).toEqual({ added: 1, removed: 0, same: 3 });
  });

  test("an empty original is all insertions", () => {
    expect(diffStats(diffLines([], ["a", "b"]))).toEqual({ added: 2, removed: 0, same: 0 });
  });

  test("an empty replacement is all deletions", () => {
    expect(diffStats(diffLines(["a"], []))).toEqual({ added: 0, removed: 1, same: 0 });
  });

  test("unified output carries headers, a hunk marker and signed lines", () => {
    const out = renderUnified(diffLines(["a", "b"], ["a", "c"]), "old", "new", 1);
    expect(out).toContain("--- old");
    expect(out).toContain("+++ new");
    expect(out).toContain("@@");
    expect(out).toContain("-b");
    expect(out).toContain("+c");
  });

  test("unchanged runs beyond the context window collapse", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "x"];
    const b = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "y"];
    const out = renderUnified(diffLines(a, b), "a", "b", 1);
    // Line "1" is nine lines from the change, so it must not appear.
    expect(out).not.toContain(" 1\n");
    expect(out).toContain("-x");
  });
});

describe("truncateToChars", () => {
  test("text that already fits is returned untouched", () => {
    const out = truncateToChars("short", 100, "head", "...");
    expect(out.text).toBe("short");
    expect(out.truncated).toBe(false);
  });

  test("head keeps the beginning", () => {
    const out = truncateToChars("abcdefghij", 8, "head", "..");
    expect(out.text.startsWith("abcdef")).toBe(true);
    expect(out.text.endsWith("..")).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(8);
  });

  test("tail keeps the end", () => {
    const out = truncateToChars("abcdefghij", 8, "tail", "..");
    expect(out.text.startsWith("..")).toBe(true);
    expect(out.text.endsWith("ghij")).toBe(true);
  });

  test("middle keeps both ends", () => {
    const out = truncateToChars("abcdefghij", 8, "middle", "..");
    expect(out.text.startsWith("abc")).toBe(true);
    expect(out.text.endsWith("hij")).toBe(true);
  });

  test("never exceeds the budget even when the marker is huge", () => {
    const out = truncateToChars("abcdefghij", 3, "head", "[dropped]");
    expect(out.text.length).toBeLessThanOrEqual(3);
    expect(out.truncated).toBe(true);
  });
});

describe("normalizeText", () => {
  test("CRLF folds to LF", () => {
    expect(normalizeText("a\r\nb", { eol: "lf" })).toBe("a\nb");
  });

  test("lone CR folds to LF as well", () => {
    expect(normalizeText("a\rb", { eol: "lf" })).toBe("a\nb");
  });

  test("crlf output converts back", () => {
    expect(normalizeText("a\nb", { eol: "crlf" })).toBe("a\r\nb");
  });

  test("trailing whitespace goes", () => {
    expect(normalizeText("a   \nb\t\n", { trimTrailingWhitespace: true })).toBe("a\nb\n");
  });

  test("blank runs collapse to one blank line", () => {
    expect(normalizeText("a\n\n\n\n\nb", { collapseBlankLines: true })).toBe("a\n\nb");
  });

  test("tabs expand to the requested width", () => {
    expect(normalizeText("a\tb", { tabsToSpaces: 2 })).toBe("a  b");
  });

  test("invisible characters are removed", () => {
    expect(normalizeText("a​b﻿", { stripInvisible: true })).toBe("ab");
  });

  test("unicode normalization makes composed and decomposed forms equal", () => {
    const composed = "é";
    const decomposed = "é";
    expect(normalizeText(composed, { unicode: "NFC" })).toBe(
      normalizeText(decomposed, { unicode: "NFC" }),
    );
  });

  test("a final newline can be guaranteed", () => {
    expect(normalizeText("a", { ensureFinalNewline: true })).toBe("a\n");
    expect(normalizeText("a\n", { ensureFinalNewline: true })).toBe("a\n");
  });

  test("no options means no change", () => {
    expect(normalizeText("a  \n\n\nb", {})).toBe("a  \n\n\nb");
  });
});

describe("stripAnsi", () => {
  test("colour codes are removed, text survives", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });

  test("plain text is untouched", () => {
    expect(stripAnsi("plain")).toBe("plain");
  });
});

describe("sortLines", () => {
  test("sorts ascending and drops blanks by default", () => {
    expect(sortLines("b\n\na", {})).toEqual(["a", "b"]);
  });

  test("descending reverses", () => {
    expect(sortLines("a\nb", { order: "desc" })).toEqual(["b", "a"]);
  });

  test("unique removes duplicates", () => {
    expect(sortLines("a\nb\na", { unique: true })).toEqual(["a", "b"]);
  });

  test("numeric sorts by value, not lexically", () => {
    expect(sortLines("10\n9\n100", { numeric: true })).toEqual(["9", "10", "100"]);
  });

  test("ignoreCase folds case for both sorting and uniqueness", () => {
    expect(sortLines("B\na\nA", { ignoreCase: true, unique: true })).toEqual(["a", "B"]);
  });

  test("a field index keys the sort", () => {
    const text = "x,2\ny,1";
    expect(sortLines(text, { field: 1, delimiter: "," })).toEqual(["y,1", "x,2"]);
  });
});

describe("glossaryReplace", () => {
  test("replaces whole words and counts them", () => {
    const out = glossaryReplace("use ai today", { ai: "AI" }, true, false);
    expect(out.text).toBe("use AI today");
    expect(out.replacements).toEqual({ ai: 1 });
  });

  test("whole-word mode leaves substrings alone", () => {
    const out = glossaryReplace("chain", { ai: "AI" }, true, false);
    expect(out.text).toBe("chain");
    expect(out.replacements).toEqual({});
  });

  test("substring mode does rewrite inside words", () => {
    expect(glossaryReplace("chain", { ai: "AI" }, false, false).text).toBe("chAIn");
  });

  test("longer terms win over shorter ones that are their prefix", () => {
    const out = glossaryReplace(
      "new york city",
      { "new york": "NY", "new york city": "NYC" },
      true,
      false,
    );
    expect(out.text).toBe("NYC");
  });

  test("case sensitivity is honoured", () => {
    expect(glossaryReplace("AI", { ai: "x" }, true, true).text).toBe("AI");
    expect(glossaryReplace("AI", { ai: "x" }, true, false).text).toBe("x");
  });

  test("regex metacharacters in a term are literal", () => {
    expect(glossaryReplace("a.b", { "a.b": "ok" }, false, false).text).toBe("ok");
    expect(glossaryReplace("axb", { "a.b": "ok" }, false, false).text).toBe("axb");
  });
});

describe("markdown", () => {
  const doc = [
    "# Title",
    "intro",
    "## One",
    "body one",
    "```sh",
    "# not a heading",
    "echo hi",
    "```",
    "## Two",
    "body two",
  ].join("\n");

  test("parses headings with depth and line", () => {
    const h = parseHeadings(doc);
    expect(h.map((x) => x.title)).toEqual(["Title", "One", "Two"]);
    expect(h[0]?.depth).toBe(1);
    expect(h[1]?.line).toBe(3);
  });

  test("a hash inside a fenced block is not a heading", () => {
    expect(parseHeadings(doc).some((h) => h.title === "not a heading")).toBe(false);
  });

  test("slugify matches the GitHub anchor shape", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  test("sectionBody returns one section, stopping at the next same-depth heading", () => {
    const body = sectionBody(doc, "One") as string;
    expect(body).toContain("body one");
    expect(body).not.toContain("body two");
  });

  test("sectionBody accepts a slug as well as a title", () => {
    expect(sectionBody(doc, "one")).toContain("body one");
  });

  test("an unknown section returns undefined", () => {
    expect(sectionBody(doc, "nope")).toBeUndefined();
  });

  test("a parent section includes its children", () => {
    const body = sectionBody(doc, "Title") as string;
    expect(body).toContain("body one");
    expect(body).toContain("body two");
  });

  test("renderOutline indents by relative depth", () => {
    const out = renderOutline(parseHeadings(doc), 6);
    expect(out).toContain("Title");
    expect(out).toContain("  One");
  });

  test("codeBlocks captures the language and body", () => {
    const blocks = codeBlocks(doc);
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.language).toBe("sh");
    expect(blocks[0]?.code).toContain("echo hi");
  });

  test("markdownTable pads columns and escapes pipes", () => {
    const out = markdownTable([
      { a: 1, b: "x|y" },
      { a: 22, b: "z" },
    ]);
    expect(out.split("\n")[0]).toContain("| a");
    expect(out).toContain("x\\|y");
    // header, separator, two rows
    expect(out.split("\n").length).toBe(4);
  });

  test("markdownTable honours an explicit column order", () => {
    const out = markdownTable([{ a: 1, b: 2 }], ["b", "a"]);
    expect(out.split("\n")[0]?.indexOf("b")).toBeLessThan(
      out.split("\n")[0]?.indexOf("a") as number,
    );
  });
});

describe("template", () => {
  test("lookupPath walks objects and arrays", () => {
    const data = { user: { name: "ada" }, items: [{ id: 7 }] };
    expect(lookupPath(data, "user.name")).toBe("ada");
    expect(lookupPath(data, "items.0.id")).toBe(7);
    expect(lookupPath(data, "user.missing")).toBeUndefined();
  });

  test("substitutes values", () => {
    expect(renderTemplateString("hi {{name}}", { name: "ada" }, true).text).toBe("hi ada");
  });

  test("triple braces are a synonym", () => {
    expect(renderTemplateString("{{{name}}}", { name: "x" }, true).text).toBe("x");
  });

  test("objects serialize as JSON", () => {
    expect(renderTemplateString("{{a}}", { a: { b: 1 } }, true).text).toBe('{"b":1}');
  });

  test("strict mode rejects a missing key and names it", () => {
    expect(() => renderTemplateString("{{nope}}", {}, true)).toThrow(TemplateError);
    try {
      renderTemplateString("{{nope}}", {}, true);
    } catch (err) {
      expect((err as Error).message).toContain('"nope"');
    }
  });

  test("lenient mode substitutes empty and reports what was missing", () => {
    const out = renderTemplateString("[{{nope}}]", {}, false);
    expect(out.text).toBe("[]");
    expect(out.missing).toEqual(["nope"]);
  });

  test("the same inputs always produce the same bytes", () => {
    const a = renderTemplateString("{{x}}-{{y}}", { x: 1, y: 2 }, true).text;
    const b = renderTemplateString("{{x}}-{{y}}", { x: 1, y: 2 }, true).text;
    expect(a).toBe(b);
  });
});

describe("classifyByRules", () => {
  const rules = [
    { label: "refund", patterns: ["refund", "money back"] },
    { label: "wismo", patterns: ["where is my order", "tracking"] },
  ];

  test("picks the matching label", () => {
    expect(classifyByRules("I want a refund", rules, 1, null).label).toBe("refund");
  });

  test("is case-insensitive on phrases", () => {
    expect(classifyByRules("REFUND please", rules, 1, null).label).toBe("refund");
  });

  test("more hits wins", () => {
    const out = classifyByRules("refund, money back please", rules, 1, null);
    expect(out.label).toBe("refund");
    expect(out.score).toBe(2);
  });

  test("below threshold falls back to the default label", () => {
    expect(classifyByRules("hello", rules, 1, "other").label).toBe("other");
  });

  test("no match and no default gives null", () => {
    expect(classifyByRules("hello", rules, 1, null).label).toBeNull();
  });

  test("weights shift the ranking", () => {
    const weighted = [
      { label: "a", patterns: ["x"], weight: 1 },
      { label: "b", patterns: ["y"], weight: 5 },
    ];
    expect(classifyByRules("x y", weighted, 1, null).label).toBe("b");
  });

  test("regex rules are supported", () => {
    const re = [{ label: "id", patterns: ["ORD-\\d+"], regex: true }];
    expect(classifyByRules("order ORD-42", re, 1, null).label).toBe("id");
  });

  test("ties break on label so the answer is stable", () => {
    const tie = [
      { label: "bbb", patterns: ["x"] },
      { label: "aaa", patterns: ["x"] },
    ];
    expect(classifyByRules("x", tie, 1, null).label).toBe("aaa");
  });
});

describe("entities", () => {
  test("every declared kind has a pattern", () => {
    expect(ENTITY_KINDS.length).toBeGreaterThan(10);
  });

  test("finds urls and emails", () => {
    const out = extractEntities("see https://a.com or mail me@b.org", ["url", "email"], true);
    expect(out.url?.[0]?.value).toBe("https://a.com");
    expect(out.email?.[0]?.value).toBe("me@b.org");
  });

  test("a trailing paren is not swallowed into a url", () => {
    const out = extractEntities("(see https://a.com)", ["url"], true);
    expect(out.url?.[0]?.value).toBe("https://a.com");
  });

  test("unique de-duplicates", () => {
    const out = extractEntities("a@b.com a@b.com", ["email"], true);
    expect(out.email?.length).toBe(1);
  });

  test("non-unique keeps every occurrence", () => {
    const out = extractEntities("a@b.com a@b.com", ["email"], false);
    expect(out.email?.length).toBe(2);
  });

  test("reports the line a hit was on", () => {
    const out = extractEntities("x\nORD-1", ["ticket"], true);
    expect(out.ticket?.[0]?.line).toBe(2);
  });

  test("a mention excludes the leading space from the value", () => {
    const out = extractEntities("hi @ada", ["mention"], true);
    expect(out.mention?.[0]?.value).toBe("@ada");
  });

  test("validates ipv4 octets rather than matching any dotted quad", () => {
    const out = extractEntities("1.2.3.4 and 999.1.1.1", ["ipv4"], true);
    expect(out.ipv4?.map((h) => h.value)).toEqual(["1.2.3.4"]);
  });

  test("kinds with no hits are omitted entirely", () => {
    expect(extractEntities("nothing", ["url"], true)).toEqual({});
  });

  test("an unknown kind is skipped rather than throwing", () => {
    expect(() => extractEntities("x", ["notAKind"], true)).not.toThrow();
  });
});

describe("similarity", () => {
  test("levenshtein counts single edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });

  test("levenshteinRatio is 1 for identical and 0 for wholly different", () => {
    expect(levenshteinRatio("abc", "abc")).toBe(1);
    expect(levenshteinRatio("", "")).toBe(1);
    expect(levenshteinRatio("abc", "xyz")).toBe(0);
  });

  test("jaroWinkler rewards a shared prefix", () => {
    expect(jaroWinkler("martha", "marhta")).toBeGreaterThan(0.9);
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("abc", "")).toBe(0);
  });

  test("nGrams pads so short strings still overlap", () => {
    expect(nGrams("ab", 3).size).toBeGreaterThan(0);
  });

  test("jaccard of identical sets is 1 and of disjoint sets is 0", () => {
    expect(jaccard(new Set(["a"]), new Set(["a"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  test("every method returns 1 for identical text", () => {
    for (const m of ["levenshtein", "jaro", "trigram", "tokenJaccard"] as const) {
      expect(similarity("hello world", "hello world", m)).toBeCloseTo(1, 5);
    }
  });

  test("every method stays within 0..1", () => {
    for (const m of ["levenshtein", "jaro", "trigram", "tokenJaccard"] as const) {
      const s = similarity("alpha beta", "gamma delta epsilon", m);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test("fuzzyRank orders best-first and applies the floor", () => {
    const hits = fuzzyRank("apple", ["apple", "apply", "zebra"], "jaro", 0.5, 10);
    expect(hits[0]?.candidate).toBe("apple");
    expect(hits.some((h) => h.candidate === "zebra")).toBe(false);
  });

  test("fuzzyRank respects the limit", () => {
    expect(fuzzyRank("a", ["a", "ab", "abc"], "trigram", 0, 2).length).toBe(2);
  });

  test("fuzzyRank ties break on input order, so results are stable", () => {
    const hits = fuzzyRank("x", ["same", "same"], "trigram", 0, 10);
    expect(hits.map((h) => h.index)).toEqual([0, 1]);
  });
});

describe("extractKeywords", () => {
  test("ranks repeated significant terms first", () => {
    const out = extractKeywords("compiler compiler compiler widget", 5, 3);
    expect(out[0]?.term).toBe("compiler");
    expect(out[0]?.count).toBe(3);
  });

  test("stop words are excluded", () => {
    expect(extractKeywords("the the the and", 5, 1).length).toBe(0);
  });

  test("short terms are excluded by minLength", () => {
    expect(extractKeywords("ab ab ab", 5, 3).length).toBe(0);
  });

  test("respects the limit", () => {
    expect(extractKeywords("alpha beta gamma delta", 2, 3).length).toBe(2);
  });
});

describe("wrapText", () => {
  test("wraps at the width", () => {
    const out = wrapText("aaa bbb ccc ddd", 7, "", "");
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(7);
  });

  test("a prefix is applied to every line and counted against the width", () => {
    const out = wrapText("aaa bbb ccc", 8, "> ", "");
    for (const line of out.split("\n")) {
      expect(line.startsWith("> ")).toBe(true);
      expect(line.length).toBeLessThanOrEqual(8);
    }
  });

  test("paragraph breaks survive", () => {
    expect(wrapText("one\n\ntwo", 40, "", "")).toBe("one\n\ntwo");
  });

  test("a word longer than the width is left whole rather than broken", () => {
    const long = "https://example.com/a/very/long/path/that/exceeds";
    expect(wrapText(long, 10, "", "")).toContain(long);
  });
});

describe("escapeFor", () => {
  test("regex metacharacters are escaped so the text matches literally", () => {
    const escaped = escapeFor("a.b*c", "regex");
    expect(new RegExp(escaped).test("a.b*c")).toBe(true);
    expect(new RegExp(escaped).test("axbxc")).toBe(false);
  });

  test("single-quoted shell words survive an embedded quote", () => {
    expect(escapeFor("it's", "shellSingle")).toBe(`'it'\\''s'`);
  });

  test("double-quoted shell words escape expansion characters", () => {
    expect(escapeFor("$HOME", "shellDouble")).toBe('"\\$HOME"');
  });

  test("json escaping round-trips", () => {
    const text = 'he said "hi"\n';
    expect(JSON.parse(escapeFor(text, "json"))).toBe(text);
  });

  test("html escaping neutralizes a tag", () => {
    expect(escapeFor("<script>", "html")).toBe("&lt;script&gt;");
  });

  test("a csv cell with a comma or quote gets quoted and doubled", () => {
    expect(escapeFor("a,b", "csv")).toBe('"a,b"');
    expect(escapeFor('say "hi"', "csv")).toBe('"say ""hi"""');
  });

  test("a plain csv cell is left alone", () => {
    expect(escapeFor("plain", "csv")).toBe("plain");
  });

  test("url component encoding escapes the separators", () => {
    expect(escapeFor("a b&c", "urlComponent")).toBe("a%20b%26c");
  });

  test("sql LIKE wildcards are escaped", () => {
    expect(escapeFor("100%", "sqlLike")).toBe("100\\%");
  });
});

describe("log compaction", () => {
  test("stripTimestamps replaces an ISO stamp", () => {
    expect(stripTimestamps("2026-01-02T03:04:05Z boom")).toBe("<ts> boom");
  });

  test("looksLikeError recognizes failures and ignores ordinary lines", () => {
    expect(looksLikeError("ERROR: boom")).toBe(true);
    expect(looksLikeError("connection refused")).toBe(true);
    expect(looksLikeError("compiled successfully")).toBe(false);
  });

  const opts = {
    dedupe: true,
    stripTimestamps: true,
    stripAnsiCodes: true,
    errorsFirst: true,
    maxLines: 50,
  };

  test("repeats collapse and are counted", () => {
    const out = compactLogLines("same\nsame\nsame", opts);
    expect(out.lines.length).toBe(1);
    expect(out.lines[0]?.count).toBe(3);
    expect(out.totalLines).toBe(3);
  });

  test("lines differing only by timestamp collapse together", () => {
    const log = "2026-01-01T00:00:00Z tick\n2026-01-01T00:00:01Z tick";
    expect(compactLogLines(log, opts).lines.length).toBe(1);
  });

  test("errors float to the top", () => {
    const out = compactLogLines("info one\nERROR boom\ninfo two", opts);
    expect(out.lines[0]?.line).toContain("ERROR");
  });

  test("errorsFirst off keeps chronological order", () => {
    const out = compactLogLines("info one\nERROR boom", { ...opts, errorsFirst: false });
    expect(out.lines[0]?.line).toContain("info one");
  });

  test("blank lines are dropped", () => {
    expect(compactLogLines("a\n\n\nb", opts).lines.length).toBe(2);
  });

  test("ansi codes are stripped before comparison", () => {
    const out = compactLogLines(`${ESC}[31msame${ESC}[0m\nsame`, opts);
    expect(out.lines.length).toBe(1);
  });

  test("maxLines truncates and says so", () => {
    const out = compactLogLines("a\nb\nc", { ...opts, maxLines: 2 });
    expect(out.lines.length).toBe(2);
    expect(out.truncated).toBe(true);
  });

  test("dedupe off preserves every occurrence", () => {
    const out = compactLogLines("same\nsame", { ...opts, dedupe: false });
    expect(out.lines.length).toBe(2);
  });
});
