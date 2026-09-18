import { describe, expect, test } from "bun:test";
/**
 * The pure functions under `./lib`.
 *
 * The rule engine is tested through real unified diffs rather than through a
 * hand-built `ParsedDiff`, because the thing most worth protecting is the
 * line number a finding carries: a fixture that asserts the parser's output
 * would agree with itself and with nothing else.
 */
import { parseUnifiedDiff } from "@crewhaus/tool-text";
import {
  DEFAULT_IGNORED,
  buildTokenIndex,
  checkRefs,
  codeSpans,
  extractDocRefs,
  isDistinctive,
  referenceOf,
} from "./lib/docs";
import {
  OPT_IN_RULES,
  RULE_IDS,
  activeRules,
  isCommentLine,
  languageOf,
  lintParsedDiff,
  looksLikeCommentedCode,
  unknownRuleIds,
} from "./lib/rules";

/**
 * Conflict markers are assembled rather than typed out. A literal run of
 * seven `<` in a committed file is the shape every merge tool, editor and CI
 * grep in the world looks for, and this package's own test file should not
 * be the thing that trips them.
 */
const OURS = "<".repeat(7);
const SPLIT = "=".repeat(7);
const THEIRS = ">".repeat(7);

/** A one-file diff whose added lines start at `newStart` in the new file. */
function diffWith(path: string, added: readonly string[], newStart = 10): string {
  const head = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  const body = [
    `@@ -${newStart},1 +${newStart},${added.length + 1} @@`,
    " unchanged context line",
    ...added.map((line) => `+${line}`),
  ];
  return [...head, ...body, ""].join("\n");
}

const lint = (diff: string, options = {}) => lintParsedDiff(parseUnifiedDiff(diff), options);

describe("languageOf", () => {
  test("maps by extension, including the ones that share a language", () => {
    expect(languageOf("src/a.ts")).toBe("js");
    expect(languageOf("src/a.tsx")).toBe("js");
    expect(languageOf("scripts/run.py")).toBe("python");
    expect(languageOf("cmd/main.go")).toBe("go");
    expect(languageOf("config/app.yaml")).toBe("config");
    expect(languageOf("README.md")).toBe("markdown");
  });

  test("a file with no extension, or a dotfile, is not guessed at", () => {
    expect(languageOf("Makefile")).toBe("other");
    expect(languageOf("path/.gitignore")).toBe("other");
  });

  test("a dot in a directory name does not become the extension", () => {
    expect(languageOf("my.dir/Dockerfile")).toBe("other");
  });
});

describe("isCommentLine", () => {
  test("a whole-line comment is one; a trailing comment is not", () => {
    expect(isCommentLine("  // gone", "js")).toBe(true);
    expect(isCommentLine("const x = 1; // kept", "js")).toBe(false);
    expect(isCommentLine("# python note", "python")).toBe(true);
    expect(isCommentLine("# python note", "js")).toBe(false);
  });
});

describe("looksLikeCommentedCode", () => {
  test("recognises the shapes commented-out code actually has", () => {
    expect(looksLikeCommentedCode("const x = compute(y);")).toBe(true);
    expect(looksLikeCommentedCode("doTheThing(a, b);")).toBe(true);
    expect(looksLikeCommentedCode("if (ready) {")).toBe(true);
    expect(looksLikeCommentedCode("self.value = other.value")).toBe(true);
  });

  test("prose is left alone, which is the whole point of the veto", () => {
    expect(looksLikeCommentedCode("the parser already counted the lines")).toBe(false);
    expect(looksLikeCommentedCode("returns the number of files we skipped")).toBe(false);
    expect(looksLikeCommentedCode("---------------------------")).toBe(false);
    expect(looksLikeCommentedCode("https://example.com/spec#section")).toBe(false);
  });

  test("a TODO belongs to the other rule, not this one", () => {
    expect(looksLikeCommentedCode("TODO: call finish(x);")).toBe(false);
  });
});

describe("rule selection", () => {
  test("the heuristic rule is off until it is asked for", () => {
    for (const id of OPT_IN_RULES) expect(activeRules().has(id)).toBe(false);
    expect(activeRules({ enable: ["commentedCode"] }).has("commentedCode")).toBe(true);
  });

  test("disable wins over enable, so a caller can always silence a rule", () => {
    const active = activeRules({ enable: ["commentedCode"], disable: ["commentedCode"] });
    expect(active.has("commentedCode")).toBe(false);
  });

  test("an id that is not a rule is reported rather than ignored", () => {
    expect(unknownRuleIds(["debugger", "consoleLogs", "typo"])).toEqual(["consoleLogs", "typo"]);
    expect(unknownRuleIds([...RULE_IDS])).toEqual([]);
  });
});

describe("lintParsedDiff line numbers", () => {
  test("a finding carries the line number in the NEW file", () => {
    // context at 10, then the added lines at 11, 12, 13.
    const diff = diffWith("src/a.ts", ["const a = 1;", "debugger;", "const b = 2;"], 10);
    const result = lint(diff);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.line).toBe(12);
    expect(result.findings[0]?.file).toBe("src/a.ts");
  });

  test("numbering survives several hunks in one file", () => {
    const diff = [
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,2 @@",
      " first",
      "+debugger;",
      "@@ -40,1 +41,2 @@",
      " fortieth",
      "+debugger;",
      "",
    ].join("\n");
    expect(lint(diff).findings.map((f) => f.line)).toEqual([2, 42]);
  });

  test("a removed line never produces a finding", () => {
    const diff = [
      "diff --git a/src/c.ts b/src/c.ts",
      "--- a/src/c.ts",
      "+++ b/src/c.ts",
      "@@ -5,2 +5,1 @@",
      "-debugger;",
      " kept",
      "",
    ].join("\n");
    const result = lint(diff);
    expect(result.findings).toEqual([]);
    expect(result.addedLinesScanned).toBe(0);
  });
});

describe("the rules", () => {
  test("a focused test is an error, in every spelling", () => {
    const diff = diffWith("src/a.test.ts", [
      'it.only("x", () => {});',
      'describe.only("y", () => {});',
      'test.only.each([1])("z", () => {});',
      'fit("w", () => {});',
    ]);
    const result = lint(diff);
    expect(result.findings.map((f) => f.rule)).toEqual([
      "focusedTest",
      "focusedTest",
      "focusedTest",
      "focusedTest",
    ]);
    expect(result.counts.bySeverity.error).toBe(4);
  });

  test("console.error and console.warn are left alone; log and debug are not", () => {
    const diff = diffWith("src/a.ts", [
      "console.error(err);",
      "console.warn(msg);",
      "console.log(value);",
      "console.debug(value);",
    ]);
    const rules = lint(diff).findings.map((f) => `${f.rule}@${f.line}`);
    expect(rules).toEqual(["consoleLog@13", "consoleLog@14"]);
  });

  test("a commented-out call is not a live call", () => {
    const diff = diffWith("src/a.ts", ["// console.log(value);", "// debugger;"]);
    expect(lint(diff).findings).toEqual([]);
  });

  test("a rule that does not apply to the language does not run", () => {
    // `debugger` is a JavaScript statement; in Python it is a variable name.
    const diff = diffWith("scripts/run.py", ["debugger = build_debugger()"]);
    expect(lint(diff).findings).toEqual([]);
  });

  test("an unmistakable conflict marker is reported", () => {
    const diff = diffWith("src/a.ts", [`${OURS} HEAD`, "const a = 1;", SPLIT, `${THEIRS} main`]);
    const findings = lint(diff).findings.filter((f) => f.rule === "conflictMarker");
    expect(findings.map((f) => f.line)).toEqual([11, 13, 14]);
  });

  test("a bare row of equals signs is NOT a conflict marker on its own", () => {
    // Markdown underlines a heading exactly like this, which is why the weak
    // marker only counts in a file that also gained a strong one.
    const diff = diffWith("README.md", ["Heading", SPLIT]);
    expect(lint(diff).findings.filter((f) => f.rule === "conflictMarker")).toEqual([]);
  });

  test("@ts-ignore is reported and @ts-expect-error is not", () => {
    const diff = diffWith("src/a.ts", ["// @ts-ignore", "// @ts-expect-error a real reason"]);
    const findings = lint(diff).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("suppression");
    expect(findings[0]?.message).toContain("@ts-expect-error");
  });

  test("a TODO without a ticket is reported; one with a ticket is not", () => {
    const diff = diffWith("src/a.ts", [
      "// TODO: come back to this",
      "// TODO(CH-42): come back to this",
      "// FIXME see https://example.com/issues/7",
    ]);
    const findings = lint(diff).findings;
    expect(findings.map((f) => f.line)).toEqual([11]);
  });

  test("a TODO mid-sentence is prose about todos, not a ticketless TODO", () => {
    // This rule's own source and this repository's comments are full of the
    // word; a marker that does not OPEN the comment is talk, not a note.
    const diff = diffWith("src/a.ts", [
      "// a TODO with no ticket is how work gets lost",
      "/** What counts as a ticket reference on a TODO. */",
    ]);
    expect(lint(diff).findings).toEqual([]);
  });

  test("a TODO after code on the same line is still a TODO", () => {
    const diff = diffWith("src/a.ts", ["const x = compute(); // TODO: make this lazy"]);
    expect(lint(diff).findings.map((f) => f.rule)).toEqual(["ticketlessTodo"]);
  });

  test("a suppression named in code or in a string is not a suppression", () => {
    // The rule table in this package writes the directive as data; so does
    // every test name about it. Only a comment can actually suppress.
    const diff = diffWith("src/a.ts", [
      'const what = "@ts-ignore";',
      "const re = /@ts-nocheck/;",
      "// @ts-ignore this one is real",
    ]);
    const findings = lint(diff).findings;
    expect(findings.map((f) => f.line)).toEqual([13]);
  });

  test("a statement quoted inside a string after a comment opener stays quiet", () => {
    // `["// debugger;"]` is a fixture, not a statement. A line-local rule
    // cannot tell them apart, so it takes the quiet reading.
    const diff = diffWith("src/a.test.ts", ['const lines = ["// debugger;", "// it.only("];']);
    expect(lint(diff).findings).toEqual([]);
  });

  test("a TODO in a string literal is not a note to a maintainer", () => {
    const diff = diffWith("src/a.ts", ['const banner = "TODO list";']);
    expect(lint(diff).findings).toEqual([]);
  });

  test("a caller's own ticket pattern replaces the default", () => {
    const diff = diffWith("src/a.ts", ["// TODO(CH-42): later"]);
    const findings = lint(diff, { ticketPattern: /JIRA-\d+/ }).findings;
    expect(findings.map((f) => f.rule)).toEqual(["ticketlessTodo"]);
  });

  test("a home directory is an error and a temp directory is a warning", () => {
    const home = ["/", "Users", "someone", "code", "fixture.json"].join("/");
    const diff = diffWith("src/a.ts", [
      `const fixture = "${home}";`,
      'const tmp = "/var/folders/rz/abc/T/thing";',
    ]);
    const findings = lint(diff).findings;
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([
      ["machinePath", "error"],
      ["machinePath", "warning"],
    ]);
  });

  test("a relative path that merely contains the word users is not a machine path", () => {
    const diff = diffWith("src/a.ts", ['import { users } from "./db/users/index";']);
    expect(lint(diff).findings).toEqual([]);
  });

  test("an operator pattern adds to the built-in machine paths", () => {
    const diff = diffWith("src/a.ts", ['const share = "//buildserver-07/artifacts";']);
    expect(lint(diff).findings).toEqual([]);
    const withPattern = lint(diff, { machinePathPatterns: [/\/\/buildserver-\d+\//] });
    expect(withPattern.findings.map((f) => f.rule)).toEqual(["machinePath"]);
  });

  test("CRLF is reported once per file, with the first line and the count", () => {
    const diff = diffWith("src/a.ts", ["const a = 1;\r", "const b = 2;\r", "const c = 3;\r"]);
    const findings = lint(diff).findings.filter((f) => f.rule === "crlf");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(11);
    expect(findings[0]?.message).toContain("3 added lines");
  });

  test("a very long added line is flagged as probably generated", () => {
    // The default budget is 1000, not 500: this repository's own tool
    // descriptions run past 500 characters and are not generated content.
    const diff = diffWith("src/a.ts", [`const blob = "${"x".repeat(1_200)}";`]);
    expect(lint(diff).findings.map((f) => f.rule)).toEqual(["longLine"]);
    expect(lint(diff, { maxLineChars: 10_000 }).findings).toEqual([]);
    expect(lint(diffWith("src/a.ts", ["x".repeat(600)])).findings).toEqual([]);
  });

  test("a file that adds more than the budget is reported once, without a line", () => {
    const many = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`);
    const result = lint(diffWith("src/generated.ts", many), { maxAddedLinesPerFile: 10 });
    const findings = result.findings.filter((f) => f.rule === "oversizedFile");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBeNull();
    expect(findings[0]?.message).toContain("30 added lines");
  });

  test("commented-out code is silent by default and warns when enabled", () => {
    const diff = diffWith("src/a.ts", ["// const old = compute(y);"]);
    expect(lint(diff).findings).toEqual([]);
    const enabled = lint(diff, { enable: ["commentedCode"] }).findings;
    expect(enabled.map((f) => [f.rule, f.severity])).toEqual([["commentedCode", "warning"]]);
  });

  test("an enabled heuristic still leaves a prose comment alone", () => {
    const diff = diffWith("src/a.ts", ["// the parser already counted these lines for us"]);
    expect(lint(diff, { enable: ["commentedCode"] }).findings).toEqual([]);
  });

  test("a config file is never scanned for commented-out code", () => {
    const diff = diffWith("deploy/values.yaml", ["#   replicas: 3"]);
    expect(lint(diff, { enable: ["commentedCode"] }).findings).toEqual([]);
  });
});

describe("what lintParsedDiff refuses to look at", () => {
  test("a binary stanza is skipped and said to be skipped", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "GIT binary patch",
      "literal 8",
      "zcmeAS@N?(olHy`uVBq!ia0vp^",
      "",
    ].join("\n");
    const result = lint(diff);
    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([{ file: "logo.png", why: "binary file — no text to lint" }]);
  });

  test("a pure rename has nothing to scan and is not reported as skipped", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");
    const result = lint(diff);
    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.filesScanned).toBe(0);
  });

  test("a rename WITH edits is scanned — those added lines are new code", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 88%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -3,1 +3,2 @@",
      " kept",
      "+debugger;",
      "",
    ].join("\n");
    const result = lint(diff);
    expect(result.findings.map((f) => [f.file, f.line, f.rule])).toEqual([
      ["src/new.ts", 4, "debugger"],
    ]);
  });

  test("a truncated patch comes back with the parser's warning, not a clean bill", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,4 @@",
      " kept",
      "+one",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff).warnings.join(" ")).toContain("truncated");
  });
});

describe("caps", () => {
  test("maxFindings cuts the list but never the counts", () => {
    const many = Array.from({ length: 12 }, () => "debugger;");
    const result = lint(diffWith("src/a.ts", many), { maxFindings: 5 });
    expect(result.findings).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.counts.byRule.debugger).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// docs

describe("referenceOf", () => {
  test("accepts the shapes that are unambiguously symbols", () => {
    expect(referenceOf("parseUnifiedDiff")).toEqual({
      symbol: "parseUnifiedDiff",
      base: "parseUnifiedDiff",
    });
    expect(referenceOf("catalog.register()")).toEqual({
      symbol: "catalog.register()",
      base: "catalog",
    });
    expect(referenceOf("Repo.run")).toEqual({ symbol: "Repo.run", base: "Repo" });
  });

  test("rejects everything a backtick is more often used for", () => {
    for (const span of [
      "npm install --save",
      "--force",
      "src/index.ts",
      "GET /v1/things",
      "a + b",
      "",
      "2026-01-01",
    ]) {
      expect(referenceOf(span)).toBeUndefined();
    }
  });
});

describe("isDistinctive", () => {
  test("API-shaped names pass and English words do not", () => {
    expect(isDistinctive("parseUnifiedDiff")).toBe(true);
    expect(isDistinctive("ToolCatalog")).toBe(true);
    expect(isDistinctive("MAX_TIMEOUT")).toBe(true);
    expect(isDistinctive("build")).toBe(false);
    expect(isDistinctive("format")).toBe(false);
  });
});

describe("extractDocRefs", () => {
  const doc = "docs/guide.md";

  test("a backticked identifier in prose is a reference", () => {
    const refs = extractDocRefs("Call `parseUnifiedDiff` first.\n", doc);
    expect(refs.map((r) => [r.symbol, r.line, r.evidence])).toEqual([
      ["parseUnifiedDiff", 1, "backtick"],
    ]);
  });

  test("a plain word is skipped unless the document wrote it as a call", () => {
    expect(extractDocRefs("Run `build` to build.\n", doc)).toEqual([]);
    expect(extractDocRefs("Run `build()` to build.\n", doc).map((r) => r.symbol)).toEqual([
      "build()",
    ]);
  });

  test("the same symbol twice is one reference, not two findings", () => {
    const refs = extractDocRefs("`parseUnifiedDiff` and again `parseUnifiedDiff`.\n", doc);
    expect(refs).toHaveLength(1);
  });

  test("a named import from a local module counts; one from a dependency does not", () => {
    const text = [
      "Example:",
      "",
      "```ts",
      'import { parseUnifiedDiff, type ParsedDiff } from "@crewhaus/tool-text";',
      'import { useState } from "react";',
      'import { helper } from "./helper";',
      "```",
      "",
    ].join("\n");
    const refs = extractDocRefs(text, doc, { localPrefixes: ["@crewhaus/"] });
    expect(refs.map((r) => r.symbol).sort()).toEqual(["ParsedDiff", "helper", "parseUnifiedDiff"]);
    expect(refs.every((r) => r.evidence === "import")).toBe(true);
  });

  test("an aliased import records the exported name, not the document's alias", () => {
    const text = ["```ts", 'import { realName as localAlias } from "./mod";', "```", ""].join("\n");
    expect(extractDocRefs(text, doc).map((r) => r.symbol)).toEqual(["realName"]);
  });

  test("prose inside a fenced block is not mined for identifiers", () => {
    const text = ["```sh", "crewhaus runTheThing --now", "```", ""].join("\n");
    expect(extractDocRefs(text, doc)).toEqual([]);
  });

  test("a fence closes only with its own marker", () => {
    const text = ["~~~", "`notASymbolYet`", "```", "`stillInsideTheFence`", "~~~", ""].join("\n");
    expect(extractDocRefs(text, doc)).toEqual([]);
  });

  test("the ignore list and the built-in stoplist both apply", () => {
    expect(DEFAULT_IGNORED.has("TypeScript")).toBe(true);
    const refs = extractDocRefs("`TypeScript` and `myHelper` and `otherHelper`.\n", doc, {
      ignore: ["myHelper"],
    });
    expect(refs.map((r) => r.symbol)).toEqual(["otherHelper"]);
  });

  test("include narrows what is collected", () => {
    const text = [
      "`backtickedName` before.",
      "```ts",
      'import { fromFence } from "./m";',
      "```",
      "",
    ].join("\n");
    expect(extractDocRefs(text, doc, { include: "imports" }).map((r) => r.symbol)).toEqual([
      "fromFence",
    ]);
    expect(extractDocRefs(text, doc, { include: "backticks" }).map((r) => r.symbol)).toEqual([
      "backtickedName",
    ]);
  });
});

describe("codeSpans", () => {
  test("reads the spans a markdown line actually has", () => {
    expect(codeSpans("Call `parseUnifiedDiff` then `lintParsedDiff`.")).toEqual([
      "parseUnifiedDiff",
      "lintParsedDiff",
    ]);
    expect(codeSpans("no code here")).toEqual([]);
    expect(codeSpans("an unclosed `run of one")).toEqual([]);
    // A doubled delimiter is what lets a span hold a backtick of its own.
    expect(codeSpans("``a `b` c``")).toEqual(["a ", " c"]);
  });

  test("a long unclosed run of backticks is scanned once, not once per offset", () => {
    // The regex this replaced — /(`+)([^`]+?)\1/g — re-walked the whole run
    // from every offset inside it, so this input took minutes and a
    // four-megabyte document never came back at all. The assertion is that
    // the call RETURNS with the right answer; before the fix it does not.
    const run = `x${"`".repeat(300_000)}`;
    expect(codeSpans(run)).toEqual([]);
    // A real span before the hostile run is still read, and the run itself
    // closes nothing — the same answer the regex gave, at linear cost.
    expect(codeSpans(`\`realSymbolHere\` then ${run}`)).toEqual(["realSymbolHere"]);
  }, 20_000); // pays for a 300k-character line on a loaded runner

  test("a document made of backticks does not hang the extractor", () => {
    const doc = `prose ${"`".repeat(120_000)} more prose\n\`realSymbolHere\` is here.\n`;
    expect(extractDocRefs(doc, "docs/hostile.md").map((r) => r.symbol)).toEqual(["realSymbolHere"]);
  }, 20_000); // same budget: the pre-fix cost is quadratic in the run length
});

describe("buildTokenIndex", () => {
  test("indexes identifiers wherever they are, comments and strings included", () => {
    const index = buildTokenIndex(
      'const a = 1; // mentionsHelper\nconst s = "inAString";\n',
      new Set(),
    );
    expect(index.has("mentionsHelper")).toBe(true);
    expect(index.has("inAString")).toBe(true);
  });
});

describe("checkRefs", () => {
  const index = new Set(["parseUnifiedDiff", "lintParsedDiff", "ToolCatalog", "buildTool"]);
  const ref = (symbol: string, doc = "docs/a.md", line = 1): DocRefLike => ({
    symbol,
    base: symbol,
    doc,
    line,
    evidence: "backtick",
    context: symbol,
  });
  type DocRefLike = Parameters<typeof checkRefs>[0][number];

  test("a symbol still in the tree is not reported", () => {
    const result = checkRefs([ref("parseUnifiedDiff")], index);
    expect(result.missing).toEqual([]);
    expect(result.resolved).toBe(1);
  });

  test("a symbol that is gone is reported, when the document otherwise resolves", () => {
    const refs = [
      ref("parseUnifiedDiff"),
      ref("lintParsedDiff"),
      ref("ToolCatalog"),
      ref("renamedAwayLastYear", "docs/a.md", 9),
    ];
    const result = checkRefs(refs, index);
    expect(result.missing.map((m) => [m.symbol, m.line])).toEqual([["renamedAwayLastYear", 9]]);
  });

  test("a document that resolves almost nothing is withheld, not reported as dead", () => {
    // The expensive failure: pointed at the wrong tree, every symbol "gone".
    const refs = ["alpha", "beta", "gamma", "delta"].map((s) => ref(`${s}Widget`));
    const result = checkRefs([...refs, ref("buildTool")], index);
    expect(result.missing).toEqual([]);
    expect(result.withheld).toBe(4);
    expect(result.coverage[0]?.suppressed).toContain("probably does not describe this tree");
  });

  test("the wrong-tree guard is decided AT the threshold, not just past it", () => {
    // "at least this share must resolve" — so a document sitting exactly on
    // the ratio is reported, and one a hair under it is withheld.
    const exactly = [ref("parseUnifiedDiff"), ref("goneA"), ref("goneB"), ref("goneC")];
    expect(checkRefs(exactly, index).missing).toHaveLength(3); // 1/4 === 0.25
    const justUnder = [...exactly, ref("goneD")];
    const under = checkRefs(justUnder, index); // 1/5 === 0.2
    expect(under.missing).toEqual([]);
    expect(under.withheld).toBe(4);
  });

  test("the guard can be turned off by a caller who knows better", () => {
    const refs = ["alpha", "beta", "gamma", "delta"].map((s) => ref(`${s}Widget`));
    const result = checkRefs(refs, index, { reportUnmatchedDocs: true });
    expect(result.missing).toHaveLength(4);
    expect(result.withheld).toBe(0);
  });

  test("the guard is per document, so one bad page does not silence a good one", () => {
    const good = [
      ref("parseUnifiedDiff", "docs/good.md"),
      ref("lintParsedDiff", "docs/good.md"),
      ref("goneFromGood", "docs/good.md", 3),
    ];
    const bad = ["alpha", "beta", "gamma", "delta"].map((s) => ref(`${s}Widget`, "docs/bad.md"));
    const result = checkRefs([...good, ...bad], index);
    expect(result.missing.map((m) => m.doc)).toEqual(["docs/good.md"]);
    expect(result.withheld).toBe(4);
  });

  test("maxFindings caps the list and SAYS it capped it", () => {
    // A capped list is indistinguishable from a complete one unless the cap
    // is reported: `coverage` counts the whole document either way, so a
    // reader who fixes all three has no way to learn there were ten.
    const refs = Array.from({ length: 10 }, (_, i) => ref(`goneSymbol${i}`, "docs/a.md", i + 1));
    const result = checkRefs([...refs, ref("buildTool")], index, {
      maxFindings: 3,
      minResolvedRatio: 0,
    });
    expect(result.missing).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.references - result.resolved).toBe(10);
  });

  test("a list that fits is not called truncated", () => {
    const result = checkRefs([ref("goneSymbol"), ref("buildTool")], index, {
      minResolvedRatio: 0,
    });
    expect(result.missing).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });
});
