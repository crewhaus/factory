/**
 * Unit tests for the pure pieces: glob compilation, `.gitignore` semantics,
 * formatting, the front-matter subset, notebook handling and the two archive
 * parsers. These need no filesystem — the tools' real behaviour is tested
 * against real files in `index.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { buildTar, buildZip, crc32 } from "./archive-fixtures";
import {
  ArchiveFormatError,
  detectArchiveFormat,
  readArchiveEntries,
  readTarEntries,
  readZipEntries,
} from "./lib/archive-format";
import {
  formatBytes,
  formatModeOctal,
  formatModeSymbolic,
  isoFromMs,
  parseInstant,
  renderTree,
} from "./lib/format";
import {
  FrontmatterError,
  parseFrontmatter,
  renderDocument,
  serializeFrontmatter,
  splitFrontmatter,
} from "./lib/frontmatter";
import { compileIgnoreRule, isIgnored, parseGitignore } from "./lib/gitignore";
import { globToRegExpSource, matchGlob } from "./lib/glob";
import {
  NotebookError,
  applyNotebookEdit,
  cellSource,
  parseNotebook,
  serializeNotebook,
  summarizeOutputs,
  toSourceLines,
} from "./lib/notebook";

describe("glob", () => {
  test("* does not cross a path separator", () => {
    expect(matchGlob("*.ts", "index.ts")).toBe(true);
    expect(matchGlob("*.ts", "src/index.ts")).toBe(false);
    expect(matchGlob("src/*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/deep/index.ts")).toBe(false);
  });

  test("** as a whole segment crosses separators, including none", () => {
    expect(matchGlob("**/*.ts", "index.ts")).toBe(true);
    expect(matchGlob("**/*.ts", "a/b/index.ts")).toBe(true);
    expect(matchGlob("src/**/x.ts", "src/x.ts")).toBe(true);
    expect(matchGlob("src/**/x.ts", "src/a/b/x.ts")).toBe(true);
    expect(matchGlob("src/**", "src/a/b")).toBe(true);
    expect(matchGlob("src/**", "src")).toBe(false);
  });

  test("** inside a segment is just a star", () => {
    expect(matchGlob("a**b", "axxb")).toBe(true);
    expect(matchGlob("a**b", "ax/xb")).toBe(false);
  });

  test("? matches one character but not a separator", () => {
    expect(matchGlob("a?c", "abc")).toBe(true);
    expect(matchGlob("a?c", "a/c")).toBe(false);
  });

  test("character classes, including negation and ranges", () => {
    expect(matchGlob("[ab].txt", "a.txt")).toBe(true);
    expect(matchGlob("[!ab].txt", "a.txt")).toBe(false);
    expect(matchGlob("[!ab].txt", "c.txt")).toBe(true);
    expect(matchGlob("v[0-9].json", "v7.json")).toBe(true);
    expect(matchGlob("v[0-9].json", "vx.json")).toBe(false);
  });

  test("a backslash escapes the next character", () => {
    expect(matchGlob("a\\*b", "a*b")).toBe(true);
    expect(matchGlob("a\\*b", "axb")).toBe(false);
  });

  test("regex metacharacters in the pattern stay literal", () => {
    expect(matchGlob("a+b(c).txt", "a+b(c).txt")).toBe(true);
    expect(matchGlob("a.txt", "axtxt")).toBe(false);
  });

  test("an unterminated class degrades to a literal bracket", () => {
    expect(globToRegExpSource("[abc")).toBe("\\[abc");
    expect(matchGlob("[abc", "[abc")).toBe(true);
  });
});

describe("gitignore", () => {
  const layerOf = (content: string, base = "") => [{ base, rules: parseGitignore(content) }];

  test("a slash-free pattern matches the basename at any depth", () => {
    const layers = layerOf("build\n");
    expect(isIgnored(layers, "build", true)).toBe(true);
    expect(isIgnored(layers, "a/b/build", true)).toBe(true);
    expect(isIgnored(layers, "a/buildx", true)).toBe(false);
  });

  test("a pattern with a slash is anchored to the file's directory", () => {
    const layers = layerOf("a/build\n");
    expect(isIgnored(layers, "a/build", true)).toBe(true);
    expect(isIgnored(layers, "x/a/build", true)).toBe(false);
  });

  test("a leading slash anchors without making the pattern look nested", () => {
    const layers = layerOf("/root.txt\n");
    expect(isIgnored(layers, "root.txt", false)).toBe(true);
    expect(isIgnored(layers, "sub/root.txt", false)).toBe(false);
  });

  test("a trailing slash restricts the rule to directories", () => {
    const layers = layerOf("cache/\n");
    expect(isIgnored(layers, "cache", true)).toBe(true);
    expect(isIgnored(layers, "cache", false)).toBe(false);
  });

  test("the last matching rule wins, so a negation re-includes", () => {
    const layers = layerOf("*.log\n!keep.log\n");
    expect(isIgnored(layers, "a.log", false)).toBe(true);
    expect(isIgnored(layers, "keep.log", false)).toBe(false);
  });

  test("order matters: a later ignore beats an earlier negation", () => {
    const layers = layerOf("!keep.log\n*.log\n");
    expect(isIgnored(layers, "keep.log", false)).toBe(true);
  });

  test("a deeper .gitignore overrides a shallower one", () => {
    const layers = [
      { base: "", rules: parseGitignore("*.log\n") },
      { base: "sub", rules: parseGitignore("!important.log\n") },
    ];
    expect(isIgnored(layers, "top.log", false)).toBe(true);
    expect(isIgnored(layers, "sub/important.log", false)).toBe(false);
    expect(isIgnored(layers, "sub/other.log", false)).toBe(true);
  });

  test("a nested file governs only paths beneath it", () => {
    const layers = [{ base: "sub", rules: parseGitignore("secret.txt\n") }];
    expect(isIgnored(layers, "sub/secret.txt", false)).toBe(true);
    expect(isIgnored(layers, "secret.txt", false)).toBe(false);
  });

  test("comments and blank lines are skipped, and \\# escapes a hash", () => {
    const rules = parseGitignore("# a comment\n\n\\#hash\n");
    expect(rules.length).toBe(1);
    expect(isIgnored([{ base: "", rules }], "#hash", false)).toBe(true);
  });

  test("trailing whitespace is stripped unless it is escaped", () => {
    expect(isIgnored(layerOf("temp   \n"), "temp", false)).toBe(true);
    expect(isIgnored(layerOf("temp\\ \n"), "temp ", false)).toBe(true);
    expect(isIgnored(layerOf("temp\\ \n"), "temp", false)).toBe(false);
  });

  test("** patterns work in all three positions", () => {
    expect(isIgnored(layerOf("**/dist\n"), "a/b/dist", true)).toBe(true);
    expect(isIgnored(layerOf("dist/**\n"), "dist/a/b.txt", false)).toBe(true);
    expect(isIgnored(layerOf("a/**/c\n"), "a/b/c", false)).toBe(true);
    expect(isIgnored(layerOf("a/**/c\n"), "a/c", false)).toBe(true);
  });

  test("an empty or bang-only line compiles to nothing", () => {
    expect(compileIgnoreRule("   ")).toBeUndefined();
    expect(compileIgnoreRule("!")).toBeUndefined();
  });
});

describe("format helpers", () => {
  test("bytes are exact below a kibibyte and scaled above it", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GiB");
  });

  test("modes render as octal and as ls-style permissions", () => {
    expect(formatModeOctal(0o100644)).toBe("0644");
    expect(formatModeSymbolic(0o100644)).toBe("rw-r--r--");
    expect(formatModeSymbolic(0o100755)).toBe("rwxr-xr-x");
    expect(formatModeSymbolic(0o104755)).toBe("rwsr-xr-x");
    expect(formatModeSymbolic(0o101777)).toBe("rwxrwxrwt");
  });

  test("instants parse, and a nonsense string is undefined rather than zero", () => {
    expect(parseInstant("2024-03-01T00:00:00Z")).toBe(Date.parse("2024-03-01T00:00:00Z"));
    expect(parseInstant("not a date")).toBeUndefined();
    expect(isoFromMs(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  test("the tree renderer draws connectors and an elision marker", () => {
    const out = renderTree("root/", [
      { name: "a", kind: "dir", children: [{ name: "b.txt", kind: "file", size: 3 }] },
      { name: "c", kind: "dir", children: [], elided: "…(depth limit)" },
    ]);
    expect(out.split("\n")).toEqual([
      "root/",
      "├── a/",
      "│   └── b.txt  3 B",
      "└── c/",
      "    └── …(depth limit)",
    ]);
  });
});

describe("front matter", () => {
  test("a fenced block splits into yaml and body", () => {
    const split = splitFrontmatter("---\ntitle: x\n---\nbody here\n");
    expect(split.found).toBe(true);
    expect(split.yaml).toBe("title: x");
    expect(split.body).toBe("body here\n");
  });

  test("no fence, or an unclosed fence, is not front matter", () => {
    expect(splitFrontmatter("# just markdown").found).toBe(false);
    expect(splitFrontmatter("---\ntitle: x\nnever closed").found).toBe(false);
  });

  test("scalars parse to their types", () => {
    const data = parseFrontmatter(
      ["title: Hello", "count: 42", "ratio: 1.5", "draft: true", "owner: null", "empty: ~"].join(
        "\n",
      ),
    );
    expect(data).toEqual({
      title: "Hello",
      count: 42,
      ratio: 1.5,
      draft: true,
      owner: null,
      empty: null,
    });
  });

  test("quoted strings keep what a plain scalar would have eaten", () => {
    const data = parseFrontmatter(['a: "1.5"', "b: 'it''s fine'", 'c: "line\\nbreak"'].join("\n"));
    expect(data["a"]).toBe("1.5");
    expect(data["b"]).toBe("it's fine");
    expect(data["c"]).toBe("line\nbreak");
  });

  test("a comment after a plain scalar is dropped, but not inside quotes", () => {
    expect(parseFrontmatter("a: value # note")["a"]).toBe("value");
    expect(parseFrontmatter('a: "value # note"')["a"]).toBe("value # note");
  });

  test("flow and block sequences both parse", () => {
    expect(parseFrontmatter("tags: [a, b, 3]")["tags"]).toEqual(["a", "b", 3]);
    expect(parseFrontmatter("tags:\n  - a\n  - b\n")["tags"]).toEqual(["a", "b"]);
    expect(parseFrontmatter("tags: []")["tags"]).toEqual([]);
  });

  test("everything outside the subset is refused by name", () => {
    expect(() => parseFrontmatter("a:\n  b: nested")).toThrow(FrontmatterError);
    expect(() => parseFrontmatter("a: |\n  block")).toThrow(FrontmatterError);
    expect(() => parseFrontmatter("a: &anchor x")).toThrow(FrontmatterError);
    expect(() => parseFrontmatter("a: 1\na: 2")).toThrow(/duplicate key/);
    expect(() => parseFrontmatter("a: {b: 1}")).toThrow(/nested mappings/);
    expect(() => parseFrontmatter("no colon here")).toThrow(/expected "key: value"/);
  });

  test("serializing quotes only what needs it", () => {
    const yaml = serializeFrontmatter({
      plain: "hello world",
      numberish: "1.5",
      reserved: "true",
      real: 1.5,
      flag: false,
      nothing: null,
      list: ["a", 2],
      blank: "",
    });
    expect(yaml.split("\n")).toEqual([
      'blank: ""',
      "flag: false",
      "list:",
      "  - a",
      "  - 2",
      "nothing: null",
      'numberish: "1.5"',
      "plain: hello world",
      "real: 1.5",
      'reserved: "true"',
    ]);
  });

  test("existing keys keep their order and new ones are appended sorted", () => {
    const yaml = serializeFrontmatter({ zeta: 1, alpha: 2, beta: 3 }, ["zeta", "beta"]);
    expect(yaml.split("\n")).toEqual(["zeta: 1", "beta: 3", "alpha: 2"]);
  });

  test("parse and serialize round-trip through a document", () => {
    const original = "---\ntitle: Hello\ntags:\n  - a\n  - b\n---\nbody\n";
    const split = splitFrontmatter(original);
    const data = parseFrontmatter(split.yaml);
    const rebuilt = renderDocument(
      serializeFrontmatter(data, Object.keys(data)),
      split.body,
      split.eol,
    );
    expect(rebuilt).toBe(original);
  });
});

describe("notebooks", () => {
  const notebook = {
    cells: [
      { cell_type: "markdown", source: ["# Title\n"], metadata: {} },
      {
        cell_type: "code",
        source: ["print(1)\n"],
        metadata: {},
        execution_count: 3,
        outputs: [{ output_type: "stream", name: "stdout", text: ["1\n"] }],
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };

  test("a non-notebook is refused with a reason", () => {
    expect(() => parseNotebook("{ not json")).toThrow(NotebookError);
    expect(() => parseNotebook("[]")).toThrow(/top level/);
    expect(() => parseNotebook('{"x":1}')).toThrow(/no "cells" array/);
    expect(() => parseNotebook('{"cells":[{"cell_type":"code"}]}')).toThrow(/"source"/);
  });

  test("source survives both storage shapes", () => {
    expect(cellSource({ cell_type: "code", source: ["a\n", "b"] })).toBe("a\nb");
    expect(cellSource({ cell_type: "code", source: "a\nb" })).toBe("a\nb");
  });

  test("text splits into the line array nbformat stores", () => {
    expect(toSourceLines("")).toEqual([]);
    expect(toSourceLines("a")).toEqual(["a"]);
    expect(toSourceLines("a\nb")).toEqual(["a\n", "b"]);
    expect(toSourceLines("a\n")).toEqual(["a\n"]);
  });

  test("outputs flatten, and binary bundles are described not inlined", () => {
    const summaries = summarizeOutputs(
      [
        { output_type: "stream", name: "stderr", text: ["oops\n"] },
        { output_type: "error", ename: "ValueError", evalue: "bad" },
        { output_type: "display_data", data: { "image/png": "AAAA" } },
        { output_type: "execute_result", data: { "text/plain": ["7"] } },
      ],
      100,
    );
    expect(summaries[0]).toEqual({ type: "stream:stderr", text: "oops\n" });
    expect(summaries[1]).toEqual({ type: "error", text: "ValueError: bad" });
    expect(summaries[2]?.text).toBe("[non-text output: image/png (4 chars)]");
    expect(summaries[3]?.text).toBe("7");
  });

  test("a long output is clipped with a count of what was dropped", () => {
    const [only] = summarizeOutputs([{ output_type: "stream", text: "x".repeat(50) }], 10);
    expect(only?.text).toBe(`${"x".repeat(10)}…[+40 chars]`);
  });

  test("replacing a code cell clears its stale outputs", () => {
    const edited = applyNotebookEdit(notebook, { mode: "replace", index: 1, source: "print(2)\n" });
    expect(edited.cells[1]?.["outputs"]).toEqual([]);
    expect(edited.cells[1]?.["execution_count"]).toBeNull();
    expect(edited.cells[1]?.source).toEqual(["print(2)\n"]);
    // The original object is untouched.
    expect(notebook.cells[1]?.outputs?.length).toBe(1);
  });

  test("insert and delete move the cell list", () => {
    const inserted = applyNotebookEdit(notebook, {
      mode: "insert",
      index: 0,
      cellType: "markdown",
      source: "intro",
    });
    expect(inserted.cells.length).toBe(3);
    expect(inserted.cells[0]?.cell_type).toBe("markdown");
    expect(applyNotebookEdit(notebook, { mode: "delete", index: 0 }).cells.length).toBe(1);
  });

  test("an out-of-range index says what the range is", () => {
    expect(() => applyNotebookEdit(notebook, { mode: "delete", index: 9 })).toThrow(/0\.\.1/);
    expect(() =>
      applyNotebookEdit(notebook, { mode: "insert", index: 2, cellType: "code", source: "" }),
    ).not.toThrow();
  });

  test("serialization matches Jupyter's one-space indent and trailing newline", () => {
    const text = serializeNotebook(notebook);
    expect(text.startsWith('{\n "cells": [')).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("archive parsing", () => {
  test("crc32 matches the known check value", () => {
    expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);
  });

  test("tar entries come back with names, sizes and kinds", () => {
    const entries = readTarEntries(
      buildTar([
        { name: "pkg/", kind: "dir" },
        { name: "pkg/a.txt", data: "hello" },
        { name: "pkg/link", kind: "symlink", linkTarget: "a.txt" },
      ]),
    );
    expect(entries.map((e) => [e.name, e.kind, e.size])).toEqual([
      ["pkg/", "dir", 0],
      ["pkg/a.txt", "file", 5],
      ["pkg/link", "symlink", 0],
    ]);
    expect(entries[2]?.linkTarget).toBe("a.txt");
  });

  test("a tar member whose name escapes is reported verbatim, not sanitized", () => {
    const entries = readTarEntries(buildTar([{ name: "../escaped.txt", data: "x" }]));
    expect(entries[0]?.name).toBe("../escaped.txt");
  });

  test("a truncated tar is refused rather than half-read", () => {
    const full = buildTar([{ name: "a.txt", data: "hello" }]);
    expect(() => readTarEntries(full.subarray(0, 515))).toThrow(ArchiveFormatError);
  });

  test("zip entries are read from the central directory", () => {
    const entries = readZipEntries(
      buildZip([
        { name: "pkg", kind: "dir" },
        { name: "pkg/a.txt", data: "hello" },
      ]),
    );
    expect(entries.map((e) => [e.name, e.kind, e.size])).toEqual([
      ["pkg/", "dir", 0],
      ["pkg/a.txt", "file", 5],
    ]);
  });

  test("a zip symlink member is recognised by its unix mode", () => {
    const entries = readZipEntries(
      buildZip([{ name: "link", kind: "symlink", linkTarget: "../out" }]),
    );
    expect(entries[0]?.kind).toBe("symlink");
  });

  test("bytes that are not an archive are refused", () => {
    expect(() => readZipEntries(Buffer.from("not a zip"))).toThrow(/no end-of-central-directory/);
  });

  test("format detection prefers the magic bytes over the name", () => {
    expect(detectArchiveFormat(buildZip([{ name: "a", data: "b" }]), "thing.tar")).toBe("zip");
    expect(detectArchiveFormat(buildTar([{ name: "a", data: "b" }]), "thing.zip")).toBe("tar");
    expect(detectArchiveFormat(Buffer.from([0x1f, 0x8b, 0x08]), "x")).toBe("tar.gz");
    expect(detectArchiveFormat(Buffer.from("plain"), "x.txt")).toBeUndefined();
  });
});

describe("archive parsing — formats in the wild", () => {
  /**
   * A header in GNU tar's OWN format: magic "ustar " (trailing space) and
   * version " \0", rather than POSIX's "ustar\0" + "00". This is what GNU
   * tar writes by default, so it is what most archives made on Linux look
   * like; an exact-match on "ustar" rejects every one of them.
   */
  function gnuTarHeader(name: string, size: number): Buffer {
    const block = Buffer.alloc(512, 0);
    block.write(name, 0, "ascii");
    block.write("0000644\0", 100, "ascii");
    block.write("0000000\0", 108, "ascii");
    block.write("0000000\0", 116, "ascii");
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    block.write("00000000000\0", 136, "ascii");
    block.write("        ", 148, "ascii");
    block.write("0", 156, "ascii");
    block.write("ustar  \0", 257, "ascii");
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    return block;
  }

  test("a GNU-format tar is read, not rejected as 'bad magic'", () => {
    const data = Buffer.alloc(512, 0);
    data.write("hi");
    const tar = Buffer.concat([gnuTarHeader("a.txt", 2), data, Buffer.alloc(1024, 0)]);
    expect(readTarEntries(tar)).toEqual([{ name: "a.txt", size: 2, kind: "file" }]);
    expect(detectArchiveFormat(tar, "a.tar")).toBe("tar");
  });

  test("bytes with a genuinely wrong magic are still rejected", () => {
    const block = gnuTarHeader("a.txt", 0);
    block.write("rubbish", 257, "ascii");
    expect(() => readTarEntries(Buffer.concat([block, Buffer.alloc(1024, 0)]))).toThrow(
      ArchiveFormatError,
    );
  });

  test("a zip symlink's target is read from its data, where a zip keeps it", () => {
    // Without this the pre-extraction check has nothing to judge a zip
    // symlink by, and an escaping link reaches the filesystem.
    const entries = readZipEntries(
      buildZip([{ name: "pkg/pwn", kind: "symlink", linkTarget: "/etc/passwd" }]),
    );
    expect(entries[0]).toEqual({
      name: "pkg/pwn",
      size: "/etc/passwd".length,
      kind: "symlink",
      linkTarget: "/etc/passwd",
    });
  });

  test("a gzip that expands past the limit is refused before it is expanded", () => {
    // 2 MiB of zeros compresses to about two kilobytes: capping the file on
    // disk caps nothing at all about what reading it costs.
    const bomb = Bun.gzipSync(new Uint8Array(2 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => readArchiveEntries(bomb, "tar.gz", 64 * 1024)).toThrow(ArchiveFormatError);
    // With room for it the same bytes decompress fine — the refusal above is
    // the limit doing its job, not the payload being malformed. (Two MiB of
    // zeros IS a valid, empty tar: an all-zero block is the end marker.)
    expect(readArchiveEntries(bomb, "tar.gz", 8 * 1024 * 1024)).toEqual([]);
  });
});

describe("glob compilation is bounded", () => {
  test("repeated globstars collapse instead of compounding", () => {
    // `**/` twelve deep used to compile to twelve nested `(?:...)*` groups,
    // giving the engine an exponential number of ways to split a path — a
    // non-matching subject took the best part of a second, and a few more
    // segments would never have come back at all.
    const pattern = `${"**/".repeat(12)}zzz`;
    expect(globToRegExpSource(pattern)).toBe("(?:[^/]+/)*zzz");
    const subject = `${Array.from({ length: 24 }, (_, i) => `seg${i}`).join("/")}/nope`;
    const started = Date.now();
    expect(matchGlob(pattern, subject)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test("collapsing does not change what the pattern means", () => {
    expect(matchGlob("**/**/a.ts", "x/y/a.ts")).toBe(true);
    expect(matchGlob("**/**/a.ts", "a.ts")).toBe(true);
    expect(matchGlob("**/**/a.ts", "x/y/b.ts")).toBe(false);
    expect(matchGlob("src/**/a.ts", "src/x/a.ts")).toBe(true);
    expect(matchGlob("src/**/a.ts", "other/x/a.ts")).toBe(false);
  });
});
