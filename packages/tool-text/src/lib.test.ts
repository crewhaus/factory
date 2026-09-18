import { afterAll, describe, expect, test } from "bun:test";
/**
 * The pure core. Every function here is tested directly, because a bug in
 * `levenshtein` reads better as a failing unit than as a failing tool call.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ParsedDiff,
  type ParsedDiffFile,
  diffLines,
  diffStats,
  parseUnifiedDiff,
  renderUnified,
} from "./lib/diff";
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

describe("parseUnifiedDiff", () => {
  test("a hunk header with no count means one line", () => {
    const parsed = parseUnifiedDiff(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-before", "+after"].join("\n"),
    );
    const hunk = parsed.files[0]?.hunks[0];
    expect({ oldCount: hunk?.oldCount, newCount: hunk?.newCount }).toEqual({
      oldCount: 1,
      newCount: 1,
    });
    expect(hunk?.lines.map((l) => l.newLine)).toEqual([null, 1]);
  });

  test("the counter starts at the header's new-file start, not at 1", () => {
    const parsed = parseUnifiedDiff(
      ["--- a/x", "+++ b/x", "@@ -100,2 +240,3 @@", " keep", "+fresh", " tail"].join("\n"),
    );
    const lines = parsed.files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.oldLine, l.newLine])).toEqual([
      [100, 240],
      [null, 241],
      [101, 242],
    ]);
  });

  test("a plain `diff -u` patch parses without any `diff --git` line", () => {
    const parsed = parseUnifiedDiff(
      [
        "--- old/a.txt\t2020-01-01 00:00:00.000000000 +0000",
        "+++ new/a.txt\t2020-01-02 00:00:00.000000000 +0000",
        "@@ -1,1 +1,1 @@",
        "-x",
        "+y",
        "--- old/b.txt\t2020-01-01 00:00:00.000000000 +0000",
        "+++ new/b.txt\t2020-01-02 00:00:00.000000000 +0000",
        "@@ -5,1 +5,1 @@",
        "-p",
        "+q",
      ].join("\n"),
    );
    // The tab-separated timestamp is not part of the path, and `old/`/`new/`
    // is not the `a/`/`b/` prefix, so neither is stripped.
    expect(parsed.files.map((f) => f.newPath)).toEqual(["new/a.txt", "new/b.txt"]);
    expect(parsed.files[1]?.hunks[0]?.lines[1]?.newLine).toBe(5);
  });

  test("format-patch's bare `---` separator does not open a file stanza", () => {
    const parsed = parseUnifiedDiff(
      [
        "From 0000000 Mon Sep 17 00:00:00 2001",
        "Subject: [PATCH] do a thing",
        "---",
        " a.txt | 2 +-",
        " 1 file changed, 1 insertion(+), 1 deletion(-)",
        "",
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ].join("\n"),
    );
    expect(parsed.files.length).toBe(1);
    expect(parsed.files[0]?.newPath).toBe("a.txt");
  });

  test("a context line stripped of its leading space still counts as context", () => {
    // Mail clients and editors trim trailing whitespace, so a blank context
    // line routinely arrives as "" rather than " ". Mis-reading it would shift
    // every later line number in the hunk.
    const parsed = parseUnifiedDiff(
      ["--- a/x", "+++ b/x", "@@ -1,3 +1,4 @@", " one", "", "+two", " three"].join("\n"),
    );
    const lines = parsed.files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.newLine])).toEqual([
      ["context", 1],
      ["context", 2],
      ["added", 3],
      ["context", 4],
    ]);
  });

  test("a truncated hunk warns instead of returning short, silent numbers", () => {
    const parsed = parseUnifiedDiff(
      ["--- a/x", "+++ b/x", "@@ -1,9 +1,9 @@", " one", "+two"].join("\n"),
    );
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.warnings[0]).toContain("truncated");
  });

  test("a combined merge hunk is refused rather than numbered wrongly", () => {
    // `@@@` carries one marker column per parent, so single-column numbering
    // would be confidently wrong — the one failure mode worth refusing.
    const parsed = parseUnifiedDiff(
      [
        "diff --cc merged.txt",
        "index 111,222..333",
        "--- a/merged.txt",
        "+++ b/merged.txt",
        "@@@ -1,2 -1,2 +1,3 @@@",
        "  same",
        "++both",
      ].join("\n"),
    );
    expect(parsed.files[0]?.hunks).toEqual([]);
    expect(parsed.warnings[0]).toContain("combined");
  });

  test("a CRLF-transported diff is not read as CRLF content", () => {
    const parsed = parseUnifiedDiff(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new"].join("\r\n"),
    );
    expect(parsed.files[0]?.hunks[0]?.lines[1]?.text).toBe("new");
  });

  test("a CRLF-content line inside an LF diff keeps its carriage return", () => {
    const parsed = parseUnifiedDiff(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old\r", "+new\r"].join("\n"),
    );
    expect(parsed.files[0]?.hunks[0]?.lines[1]?.text).toBe("new\r");
  });

  test("a hunk whose counts are too small warns rather than dropping lines", () => {
    const parsed = parseUnifiedDiff(
      ["--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", " one", "+two", "+three"].join("\n"),
    );
    expect(parsed.warnings[0]).toContain("too small");
  });

  test("format-patch's `-- ` mail signature is not mistaken for dropped content", () => {
    // The check above deliberately ignores the `-` side for exactly this line.
    const parsed = parseUnifiedDiff(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new", "-- ", "2.39.0"].join("\n"),
    );
    expect(parsed.warnings).toEqual([]);
  });

  test("a space inside or at the end of a path is part of the name", () => {
    const parsed = parseUnifiedDiff(
      ["--- a/sp ace.txt \t", "+++ b/sp ace.txt \t", "@@ -1 +1 @@", "-x", "+y"].join("\n"),
    );
    expect(parsed.files[0]?.newPath).toBe("sp ace.txt ");
  });

  test("a `diff --git` line that quotes only one side still splits", () => {
    // git quotes per path, so a rename can quote the new name alone. Real git
    // also emits `rename from`/`rename to`, but other producers may not.
    const parsed = parseUnifiedDiff(
      ['diff --git a/plain.bin "b/caf\\303\\251.bin"', "Binary files differ"].join("\n"),
    );
    expect({ old: parsed.files[0]?.oldPath, new: parsed.files[0]?.newPath }).toEqual({
      old: "plain.bin",
      new: "café.bin",
    });
  });

  test("an empty diff is an empty result", () => {
    expect(parseUnifiedDiff("")).toEqual({ files: [], warnings: [] });
  });
});

/**
 * The same parser against bytes `git` actually produced. Hand-written
 * fixtures encode what the author believes git emits; these encode what it
 * does. Every new-file line number is checked against the real file on disk,
 * which is the only assertion that can catch an off-by-one.
 */
describe("parseUnifiedDiff against real git output", () => {
  type Fixtures = {
    readonly dir: string;
    readonly diff: string;
    readonly binaryDiff: string;
    readonly parsed: ParsedDiff;
  };

  /** Never read directly — `fixtures()` builds it on first use and reuses it. */
  let built: Fixtures | null = null;

  const GIT_ENV = {
    ...process.env,
    // The runner's own gitconfig must not decide what this test sees: a global
    // `core.autocrlf`, `diff.noprefix` or `core.quotePath` would change the bytes.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
  };

  function fixtures(): Fixtures {
    if (built !== null) return built;
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-diff-"));
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
    const write = (name: string, body: string): void => {
      const target = join(dir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    };
    const numbered = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `line${i + 1}`);

    git("-c", "init.defaultBranch=main", "init", "-q", ".");
    write("src/app.ts", `${numbered(40).join("\n")}\n`);
    write("sig.txt", "head\n-- signature\ntail\n");
    write("nonl.txt", "no trailing newline");
    write("ren.txt", "moved verbatim\n");
    write("ascii.txt", "renamed onto a non-ASCII name\n");
    write("gone.txt", "this file is removed entirely\n");
    write("mode.sh", "#!/bin/sh\necho hi\n");
    write("plus.txt", "one\ntwo\n");
    write("spa ce.txt", "one\ntwo\n");
    write("café.txt", "un\ndeux\n");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0]));
    git("add", "-A");
    git("commit", "-qm", "init");

    const after = numbered(40);
    after[2] = "CHANGED3";
    after.splice(20, 0, "INSERTED");
    after.splice(35, 1);
    write("src/app.ts", `${after.join("\n")}\n`);
    // Removing `-- signature` renders as `--- signature` and adding
    // `++ replacement` renders as `+++ replacement`: back to back they are
    // byte-identical to a file header pair.
    write("sig.txt", "head\n++ replacement\ntail\n");
    write("nonl.txt", "still no trailing newline");
    git("mv", "ren.txt", "renamed.txt");
    git("mv", "ascii.txt", "rené.txt");
    write("added.txt", "brand new\nsecond\n");
    write("plus.txt", "one\n+++ b/fake.txt\n--- a/fake.txt\n@@ -1 +1 @@\ntwo\n");
    write("spa ce.txt", "one\nTWO\n");
    write("café.txt", "un\nDEUX\n");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 9, 9, 0]));
    chmodSync(join(dir, "mode.sh"), 0o755);
    rmSync(join(dir, "gone.txt"));
    git("add", "-A");

    const diff = git("diff", "--cached", "-M");
    built = {
      dir,
      diff,
      binaryDiff: git("diff", "--cached", "-M", "--binary"),
      parsed: parseUnifiedDiff(diff),
    };
    return built;
  }

  function fileAt(parsed: ParsedDiff, path: string): ParsedDiffFile {
    const hit = parsed.files.find((f) => f.newPath === path || f.oldPath === path);
    if (hit === undefined) {
      throw new Error(
        `no stanza for ${path}; got ${parsed.files.map((f) => f.newPath).join(", ")}`,
      );
    }
    return hit;
  }

  afterAll(() => {
    if (built !== null) rmSync(built.dir, { recursive: true, force: true });
  });

  // Each of these pays for building the fixture repo on the first one to run
  // (git init plus two commits' worth of work), so they carry their own budget.
  test("git's own output parses with nothing unaccounted for", () => {
    const { parsed } = fixtures();
    expect(parsed.warnings).toEqual([]);
    expect(parsed.files.map((f) => f.newPath ?? f.oldPath).sort()).toEqual([
      "added.txt",
      "bin.dat",
      "café.txt",
      "gone.txt",
      "mode.sh",
      "nonl.txt",
      "plus.txt",
      "renamed.txt",
      "rené.txt",
      "sig.txt",
      "spa ce.txt",
      "src/app.ts",
    ]);
  }, 20_000);

  test("every new-file line number indexes the real file on disk", () => {
    const { dir, parsed } = fixtures();
    let checked = 0;
    for (const file of parsed.files) {
      if (file.binary || file.newPath === null) continue;
      const actual = readFileSync(join(dir, file.newPath), "utf8").split("\n");
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.newLine === null) continue;
          expect({
            at: `${file.newPath}:${line.newLine}`,
            text: actual[line.newLine - 1],
          }).toEqual({ at: `${file.newPath}:${line.newLine}`, text: line.text });
          checked++;
        }
      }
    }
    // A parser that produced no lines would pass the loop above vacuously.
    expect(checked).toBeGreaterThan(25);
  }, 20_000);

  test("every old-file line number indexes the committed file", () => {
    const { dir, parsed } = fixtures();
    let checked = 0;
    for (const file of parsed.files) {
      if (file.binary || file.oldPath === null) continue;
      const before = execFileSync("git", ["-C", dir, "show", `HEAD:${file.oldPath}`], {
        encoding: "utf8",
        env: GIT_ENV,
      }).split("\n");
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.oldLine === null) continue;
          expect({
            at: `${file.oldPath}:${line.oldLine}`,
            text: before[line.oldLine - 1],
          }).toEqual({ at: `${file.oldPath}:${line.oldLine}`, text: line.text });
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(25);
  }, 20_000);

  test("a multi-hunk file keeps each hunk's header and restarts the counter from it", () => {
    const app = fileAt(fixtures().parsed, "src/app.ts");
    expect(
      app.hunks.map((h) => `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`),
    ).toEqual(["@@ -1,6 +1,6 @@", "@@ -18,6 +18,7 @@", "@@ -32,7 +33,6 @@"]);
    // The insertion in hunk two pushes everything after it down by one, which
    // is exactly the shift a caller editing by line number has to get right.
    const second = app.hunks[1]?.lines ?? [];
    expect(second.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 18, 18],
      ["context", 19, 19],
      ["context", 20, 20],
      ["added", null, 21],
      ["context", 21, 22],
      ["context", 22, 23],
      ["context", 23, 24],
    ]);
    expect(app.hunks[1]?.section).toBe("line17");
    expect({ added: app.added, removed: app.removed }).toEqual({ added: 2, removed: 2 });
  }, 20_000);

  test("an added line beginning with '+++' is content, not a file header", () => {
    const { parsed } = fixtures();
    const plus = fileAt(parsed, "plus.txt");
    expect(plus.hunks[0]?.lines.map((l) => [l.kind, l.newLine, l.text])).toEqual([
      ["context", 1, "one"],
      ["added", 2, "+++ b/fake.txt"],
      ["added", 3, "--- a/fake.txt"],
      ["added", 4, "@@ -1 +1 @@"],
      ["context", 5, "two"],
    ]);
    // The give-away that it was read as a header would be a phantom stanza.
    expect(parsed.files.filter((f) => f.newPath === "fake.txt")).toEqual([]);
  }, 20_000);

  test("a removed '-- x' beside an added '++ y' is not a header pair", () => {
    const sig = fileAt(fixtures().parsed, "sig.txt");
    expect(sig.hunks[0]?.lines.map((l) => [l.kind, l.newLine, l.text])).toEqual([
      ["context", 1, "head"],
      ["removed", null, "-- signature"],
      ["added", 2, "++ replacement"],
      ["context", 3, "tail"],
    ]);
  }, 20_000);

  test("a rename with no content change is a rename with no hunks", () => {
    const renamed = fileAt(fixtures().parsed, "renamed.txt");
    expect({
      oldPath: renamed.oldPath,
      newPath: renamed.newPath,
      renamed: renamed.renamed,
      status: renamed.status,
      similarity: renamed.similarity,
      hunks: renamed.hunks.length,
    }).toEqual({
      oldPath: "ren.txt",
      newPath: "renamed.txt",
      renamed: true,
      status: "renamed",
      similarity: 100,
      hunks: 0,
    });
  }, 20_000);

  test("a rename whose new name alone is quoted splits and decodes", () => {
    // git quotes per path: `diff --git a/ascii.txt "b/ren\\303\\251.txt"`.
    const accented = fileAt(fixtures().parsed, "rené.txt");
    expect({ old: accented.oldPath, new: accented.newPath, renamed: accented.renamed }).toEqual({
      old: "ascii.txt",
      new: "rené.txt",
      renamed: true,
    });
  }, 20_000);

  test("a binary stanza is flagged and carries no lines", () => {
    const bin = fileAt(fixtures().parsed, "bin.dat");
    expect({ binary: bin.binary, hunks: bin.hunks.length }).toEqual({ binary: true, hunks: 0 });
  }, 20_000);

  test("a `--binary` base85 payload does not leak into the next file", () => {
    // The payload's lines start with a length letter and would read as stray
    // content; the file after it in the diff is what proves they were skipped.
    const parsed = parseUnifiedDiff(fixtures().binaryDiff);
    expect(parsed.warnings).toEqual([]);
    expect(fileAt(parsed, "bin.dat").binary).toBe(true);
    expect(fileAt(parsed, "plus.txt").hunks[0]?.lines[1]).toEqual({
      kind: "added",
      oldLine: null,
      newLine: 2,
      text: "+++ b/fake.txt",
    });
  }, 20_000);

  test("a missing trailing newline is recorded on the line and on the file", () => {
    const nonl = fileAt(fixtures().parsed, "nonl.txt");
    expect(nonl.hunks[0]?.lines).toEqual([
      { kind: "removed", oldLine: 1, newLine: null, text: "no trailing newline", noNewline: true },
      {
        kind: "added",
        oldLine: null,
        newLine: 1,
        text: "still no trailing newline",
        noNewline: true,
      },
    ]);
    expect({ old: nonl.oldNoFinalNewline, new: nonl.newNoFinalNewline }).toEqual({
      old: true,
      new: true,
    });
  }, 20_000);

  test("a file that ends with a newline is not marked as missing one", () => {
    const app = fileAt(fixtures().parsed, "src/app.ts");
    expect({ old: app.oldNoFinalNewline, new: app.newNoFinalNewline }).toEqual({
      old: false,
      new: false,
    });
  }, 20_000);

  test("an added file has no old path and a deleted file has no new one", () => {
    const { parsed } = fixtures();
    const added = fileAt(parsed, "added.txt");
    expect({ old: added.oldPath, status: added.status }).toEqual({ old: null, status: "added" });
    expect(added.hunks[0]?.lines.map((l) => l.newLine)).toEqual([1, 2]);
    const gone = fileAt(parsed, "gone.txt");
    expect({ new: gone.newPath, status: gone.status }).toEqual({ new: null, status: "deleted" });
    expect(gone.hunks[0]?.lines[0]?.newLine).toBeNull();
  }, 20_000);

  test("a mode-change stanza carries both modes and no hunks", () => {
    const mode = fileAt(fixtures().parsed, "mode.sh");
    expect({ old: mode.oldMode, new: mode.newMode, hunks: mode.hunks.length }).toEqual({
      old: "100644",
      new: "100755",
      hunks: 0,
    });
  }, 20_000);

  test("a path with a space keeps its space, and git's tab terminator is dropped", () => {
    // git appends a tab after a `---`/`+++` path containing a space; keeping
    // it would make every later path comparison miss.
    const spaced = fileAt(fixtures().parsed, "spa ce.txt");
    expect({ old: spaced.oldPath, new: spaced.newPath }).toEqual({
      old: "spa ce.txt",
      new: "spa ce.txt",
    });
  }, 20_000);

  test("git's octal-escaped non-ASCII path is decoded back to its bytes", () => {
    // git writes `"a/caf\303\251.txt"`: two escapes for one character, so
    // decoding per code point instead of per byte yields mojibake.
    const accented = fileAt(fixtures().parsed, "café.txt");
    expect(accented.newPath).toBe("café.txt");
  }, 20_000);
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
