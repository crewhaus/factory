/**
 * The tools against a real filesystem.
 *
 * Every test builds a throwaway directory under the OS temp dir, chdir's
 * into it (the workspace root is `process.cwd()`, as in `@crewhaus/tool-fs`)
 * and removes it afterwards. Nothing is ever written inside the repository,
 * and no filesystem call is mocked: a mocked `lstat` would prove nothing
 * about whether these tools handle a symlink correctly, which is most of
 * what they have to get right.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { auditToolScopes } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { buildTar, buildZip } from "./archive-fixtures";
import {
  FSX_TOOLS,
  ToolPermissionError,
  archiveCreate,
  archiveExtract,
  archiveList,
  concatFiles,
  copyPath,
  diskUsage,
  fileHash,
  findFiles,
  frontmatterRead,
  frontmatterWrite,
  makeDirectory,
  movePath,
  notebookEdit,
  notebookRead,
  readLines,
  removePath,
  splitFile,
  stat,
  tailFile,
  tempDir,
  touchFile,
  tree,
} from "./index";
import { describeFailure, runProcess } from "./proc";

const originalCwd = process.cwd();
let tmp: string;
/** Directories created outside the workspace by containment tests. */
let outsiders: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  for (const dir of outsiders) rmSync(dir, { recursive: true, force: true });
  outsiders = [];
});

function outside(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-outside-"));
  outsiders.push(dir);
  return dir;
}

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: RegisteredTool, input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function write(rel: string, contents: string): string {
  const abs = path.join(tmp, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  return abs;
}

function commandExists(name: string): boolean {
  try {
    return Bun.spawnSync(["which", name]).exitCode === 0;
  } catch {
    return false;
  }
}

const hasTar = commandExists("tar");
const hasZip = commandExists("zip") && commandExists("unzip");
const hasGit = commandExists("git");

// ---------------------------------------------------------------------------

describe("package contract", () => {
  const readers = new Set([
    "Stat",
    "FileHash",
    "Tree",
    "DiskUsage",
    "FindFiles",
    "ReadLines",
    "TailFile",
    "ArchiveList",
    "FrontmatterRead",
    "NotebookRead",
  ]);
  const spawners = new Set(["ArchiveCreate", "ArchiveExtract"]);

  test("every tool is exported in FSX_TOOLS, with unique PascalCase names", () => {
    expect(FSX_TOOLS.length).toBe(22);
    const names = FSX_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("reads are read-only and concurrency-safe; writes are neither", () => {
    for (const tool of FSX_TOOLS) {
      const isReader = readers.has(tool.name);
      expect({ name: tool.name, readOnly: tool.readOnly }).toEqual({
        name: tool.name,
        readOnly: isReader,
      });
      expect({ name: tool.name, destructive: tool.destructive }).toEqual({
        name: tool.name,
        destructive: !isReader,
      });
      // A write must not run alongside a sibling; a read may.
      expect({ name: tool.name, concurrencySafe: tool.concurrencySafe }).toEqual({
        name: tool.name,
        concurrencySafe: isReader,
      });
    }
  });

  test("only the tools that spawn an archiver declare a process boundary", () => {
    for (const tool of FSX_TOOLS) {
      const spawns = spawners.has(tool.name);
      expect({ name: tool.name, scope: tool.scope }).toEqual({
        name: tool.name,
        scope: spawns ? "external" : "internal",
      });
      expect({ name: tool.name, io: tool.ioCapability }).toEqual({
        name: tool.name,
        io: spawns ? "process" : undefined,
      });
    }
  });

  test("the repo-wide scope audit finds nothing to complain about", () => {
    expect(auditToolScopes(FSX_TOOLS)).toEqual([]);
  });

  test("no tool claims to need a sandbox — none runs untrusted code", () => {
    for (const tool of FSX_TOOLS) {
      expect({ name: tool.name, sandbox: tool.requiresSandbox }).toEqual({
        name: tool.name,
        sandbox: false,
      });
    }
  });

  test("every description tells the model when to reach for it", () => {
    for (const tool of FSX_TOOLS) {
      const sentences = tool.description.split(". ");
      expect({ name: tool.name, second: sentences[1]?.slice(0, 4) }).toEqual({
        name: tool.name,
        second: "Use ",
      });
    }
  });

  test("every tool's schema rejects a wrong-typed input", () => {
    for (const tool of FSX_TOOLS) {
      expect({ name: tool.name, ok: tool.inputSchema.safeParse({ path: 42 }).success }).toEqual({
        name: tool.name,
        ok: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe("path containment", () => {
  const cases: Array<[string, RegisteredTool, (p: string) => unknown]> = [
    ["Stat", stat, (p) => ({ path: p })],
    ["FileHash", fileHash, (p) => ({ path: p })],
    ["Tree", tree, (p) => ({ path: p })],
    ["DiskUsage", diskUsage, (p) => ({ path: p })],
    ["FindFiles", findFiles, (p) => ({ path: p })],
    ["ReadLines", readLines, (p) => ({ path: p })],
    ["TailFile", tailFile, (p) => ({ path: p })],
    ["MakeDirectory", makeDirectory, (p) => ({ path: p })],
    ["TouchFile", touchFile, (p) => ({ path: p })],
    ["RemovePath", removePath, (p) => ({ path: p })],
    ["CopyPath", copyPath, (p) => ({ source: p, destination: "copy" })],
    ["CopyPath destination", copyPath, (p) => ({ source: "a.txt", destination: p })],
    ["MovePath", movePath, (p) => ({ source: p, destination: "moved" })],
    ["SplitFile", splitFile, (p) => ({ path: p, maxBytes: 10 })],
    ["ConcatFiles", concatFiles, (p) => ({ paths: [p], destination: "out.bin" })],
    ["ConcatFiles destination", concatFiles, (p) => ({ paths: ["a.txt"], destination: p })],
    ["ArchiveList", archiveList, (p) => ({ path: p })],
    ["ArchiveCreate", archiveCreate, (p) => ({ source: p, output: "out.tar" })],
    ["ArchiveExtract", archiveExtract, (p) => ({ archive: p, destination: "dest" })],
    ["FrontmatterRead", frontmatterRead, (p) => ({ path: p })],
    ["FrontmatterWrite", frontmatterWrite, (p) => ({ path: p, data: { a: 1 } })],
    ["NotebookRead", notebookRead, (p) => ({ path: p })],
    ["NotebookEdit", notebookEdit, (p) => ({ path: p, mode: "delete", index: 0 })],
    ["TempDir", tempDir, (p) => ({ name: "scratch", base: p })],
    // The secondary destinations, which are just as caller-supplied as the
    // primary path and would be just as useful to aim at /etc.
    ["SplitFile outputDir", splitFile, (p) => ({ path: "a.txt", maxBytes: 10, outputDir: p })],
    ["ArchiveExtract destination", archiveExtract, (p) => ({ archive: "a.txt", destination: p })],
  ];

  test("a relative path climbing out of the workspace is refused", async () => {
    write("a.txt", "x");
    for (const [label, tool, makeInput] of cases) {
      const promise = tool.execute(makeInput("../escaped"));
      await expect(promise).rejects.toThrow(ToolPermissionError);
      expect({ label, refused: true }).toEqual({ label, refused: true });
    }
  });

  test("an absolute path outside the workspace is refused", async () => {
    write("a.txt", "x");
    const target = path.join(outside(), "secret.txt");
    writeFileSync(target, "secret");
    for (const [, tool, makeInput] of cases) {
      await expect(tool.execute(makeInput(target))).rejects.toThrow(ToolPermissionError);
    }
    expect(readFileSync(target, "utf8")).toBe("secret");
  });

  test("a symlink inside the workspace pointing out of it is refused", async () => {
    write("a.txt", "x");
    const elsewhere = outside();
    writeFileSync(path.join(elsewhere, "secret.txt"), "secret");
    symlinkSync(elsewhere, path.join(tmp, "escape"));
    for (const [, tool, makeInput] of cases) {
      await expect(tool.execute(makeInput("escape/secret.txt"))).rejects.toThrow(
        ToolPermissionError,
      );
    }
  });

  test("the workspace root itself is not deletable", async () => {
    expect(await run(removePath, { path: "." })).toContain("refusing to delete the workspace root");
  });
});

// ---------------------------------------------------------------------------

describe("Stat and FileHash", () => {
  test("a regular file reports size, mode, mtime and a sha256", async () => {
    write("a.txt", "hello");
    utimesSync(path.join(tmp, "a.txt"), 1_700_000, 1_700_000);
    const result = await run(stat, { path: "a.txt" });
    expect(result.exists).toBe(true);
    expect(result.type).toBe("file");
    expect(result.size).toBe(5);
    expect(result.mtime).toBe("1970-01-20T16:13:20.000Z");
    expect(result.permissions).toMatch(/^rw/);
    // The same digest openssl would give for "hello".
    expect(result.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  test("the sha256 is what a later conditional write should compare against", async () => {
    write("a.txt", "hello");
    const before = await run(stat, { path: "a.txt" });
    write("a.txt", "hello!");
    const after = await run(stat, { path: "a.txt" });
    expect(after.sha256).not.toBe(before.sha256);
  });

  test("hashing can be turned off for a big file", async () => {
    write("a.txt", "hello");
    expect((await run(stat, { path: "a.txt", hash: false })).sha256).toBeUndefined();
  });

  test("a symlink is described as itself, not as its target", async () => {
    write("real.txt", "hello");
    symlinkSync(path.join(tmp, "real.txt"), path.join(tmp, "link.txt"));
    const result = await run(stat, { path: "link.txt" });
    expect(result.type).toBe("symlink");
    expect(result.linkTarget).toBe(path.join(tmp, "real.txt"));
    expect(result.linkTargetInsideWorkspace).toBe(true);
    expect(result.linkBroken).toBe(false);
    expect(result.sha256).toBeUndefined();
  });

  test("a broken symlink says so instead of failing", async () => {
    symlinkSync(path.join(tmp, "gone.txt"), path.join(tmp, "dangling"));
    const result = await run(stat, { path: "dangling" });
    expect(result.type).toBe("symlink");
    expect(result.linkBroken).toBe(true);
  });

  test("a missing path is reported, not thrown", async () => {
    expect(await run(stat, { path: "nope.txt" })).toEqual({ path: "nope.txt", exists: false });
  });

  test("FileHash streams the three algorithms", async () => {
    write("a.txt", "hello");
    expect((await run(fileHash, { path: "a.txt" })).hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect((await run(fileHash, { path: "a.txt", algorithm: "md5" })).hash).toBe(
      "5d41402abc4b2a76b9719d911017c592",
    );
    expect((await run(fileHash, { path: "a.txt", algorithm: "sha1" })).hash).toBe(
      "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
    );
  });

  test("a file larger than one read chunk hashes identically to a single read", async () => {
    const big = "x".repeat(700_000);
    write("big.txt", big);
    const hashed = await run(fileHash, { path: "big.txt" });
    expect(hashed.bytes).toBe(700_000);
    expect(hashed.hash).toBe(new Bun.CryptoHasher("sha256").update(big).digest("hex"));
  });

  test("hashing a directory is a message, not a crash", async () => {
    mkdirSync(path.join(tmp, "dir"));
    expect(await run(fileHash, { path: "dir" })).toContain("not a regular file");
  });
});

// ---------------------------------------------------------------------------

describe("Tree", () => {
  beforeEach(() => {
    write("src/b.ts", "b");
    write("src/a.ts", "a");
    write("src/deep/c.ts", "c");
    write("node_modules/dep/index.js", "dep");
    write("README.md", "readme");
    write(".gitignore", "node_modules/\n");
    write(".hidden", "h");
  });

  test("entries are sorted and the shape is readable", async () => {
    const out = await run(tree, { path: ".", maxDepth: 2, sizes: false });
    expect(out.split("\n")).toEqual([
      "./",
      "├── README.md",
      "└── src/",
      "    ├── a.ts",
      "    ├── b.ts",
      "    └── deep/",
      "        └── …(depth limit)",
      "",
      "2 directories, 3 files (listing cut short by a depth or entry cap)",
    ]);
  });

  test(".gitignore hides what git would hide", async () => {
    const out = await run(tree, { path: ".", maxDepth: 3 });
    expect(out).not.toContain("node_modules");
  });

  test("turning .gitignore off shows it again", async () => {
    const out = await run(tree, { path: ".", maxDepth: 3, respectGitignore: false });
    expect(out).toContain("node_modules");
  });

  test("dot-files are hidden unless asked for", async () => {
    expect(await run(tree, { path: "." })).not.toContain(".hidden");
    expect(await run(tree, { path: ".", includeHidden: true })).toContain(".hidden");
  });

  test("exclude patterns drop entries by name or by relative path", async () => {
    expect(await run(tree, { path: ".", exclude: ["*.md"] })).not.toContain("README.md");
    expect(await run(tree, { path: ".", maxDepth: 3, exclude: ["src/deep"] })).not.toContain(
      "deep",
    );
  });

  test("the entry cap is reported rather than silently applied", async () => {
    const out = await run(tree, { path: ".", maxEntries: 2 });
    expect(out).toContain("cut short");
    expect(out).toContain("more)");
  });

  test("the same call twice returns the same bytes", async () => {
    const a = await tree.execute({ path: ".", maxDepth: 3 });
    const b = await tree.execute({ path: ".", maxDepth: 3 });
    expect(a).toBe(b);
  });

  test("pointing it at a file says so", async () => {
    expect(await run(tree, { path: "README.md" })).toContain("not a directory");
  });
});

describe("gitignore against the real thing", () => {
  test.if(hasGit)("our verdicts match `git check-ignore` on a real repository", async () => {
    Bun.spawnSync(["git", "init", "-q"], { cwd: tmp });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: tmp });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: tmp });
    write(
      ".gitignore",
      ["*.log", "!keep.log", "build/", "/root-only.txt", "**/generated", ""].join("\n"),
    );
    write("sub/.gitignore", "!nested.log\n");
    const paths = [
      "app.log",
      "keep.log",
      "build/out.js",
      "root-only.txt",
      "sub/root-only.txt",
      "sub/generated/x.js",
      "sub/nested.log",
      "src/main.ts",
    ];
    for (const rel of paths) write(rel, "x");

    const ours = new Set<string>();
    const listed = await run(findFiles, {
      path: ".",
      name: "*",
      type: "any",
      includeHidden: true,
      limit: 5000,
    });
    for (const match of listed.matches) ours.add(match.path);

    for (const rel of paths) {
      const gitIgnores =
        Bun.spawnSync(["git", "check-ignore", "-q", rel], { cwd: tmp }).exitCode === 0;
      expect({ rel, hidden: !ours.has(rel) }).toEqual({ rel, hidden: gitIgnores });
    }
  });
});

// ---------------------------------------------------------------------------

describe("DiskUsage", () => {
  test("directories roll up and come back largest first", async () => {
    write("small/a.txt", "a");
    write("big/b.txt", "b".repeat(1000));
    write("big/nested/c.txt", "c".repeat(500));
    const result = await run(diskUsage, { path: ".", maxDepth: 2 });
    expect(result.totalBytes).toBe(1501);
    expect(result.files).toBe(3);
    expect(result.directories[0]).toEqual({
      path: "big",
      bytes: 1500,
      size: "1.5 KiB",
      files: 2,
    });
    expect(result.directories.map((d: { path: string }) => d.path)).toEqual([
      "big",
      "big/nested",
      "small",
    ]);
  });

  test("the report depth does not change the totals", async () => {
    write("a/b/c/deep.txt", "x".repeat(100));
    const shallow = await run(diskUsage, { path: ".", maxDepth: 1 });
    expect(shallow.totalBytes).toBe(100);
    expect(shallow.directories).toEqual([{ path: "a", bytes: 100, size: "100 B", files: 1 }]);
  });
});

// ---------------------------------------------------------------------------

describe("FindFiles", () => {
  beforeEach(() => {
    write("src/one.ts", "1");
    write("src/two.ts", "22");
    write("docs/three.md", "333");
    mkdirSync(path.join(tmp, "empty"));
    utimesSync(path.join(tmp, "src/one.ts"), 1_000_000, 1_000_000);
    utimesSync(path.join(tmp, "src/two.ts"), 2_000_000, 2_000_000);
  });

  test("a name glob matches the basename, and a slashed one the path", async () => {
    expect(
      (await run(findFiles, { name: "*.ts" })).matches.map((m: { path: string }) => m.path),
    ).toEqual(["src/one.ts", "src/two.ts"]);
    expect(
      (await run(findFiles, { name: "docs/*.md" })).matches.map((m: { path: string }) => m.path),
    ).toEqual(["docs/three.md"]);
  });

  test("results are sorted by path regardless of how the tree was walked", async () => {
    const paths = (await run(findFiles, { name: "*", limit: 100 })).matches.map(
      (m: { path: string }) => m.path,
    );
    expect(paths).toEqual([...paths].sort());
  });

  test("type selects directories and symlinks too", async () => {
    symlinkSync(path.join(tmp, "src/one.ts"), path.join(tmp, "alias.ts"));
    expect(
      (await run(findFiles, { type: "dir" })).matches.map((m: { path: string }) => m.path),
    ).toEqual(["docs", "empty", "src"]);
    expect(
      (await run(findFiles, { type: "symlink" })).matches.map((m: { path: string }) => m.path),
    ).toEqual(["alias.ts"]);
  });

  test("size bounds are inclusive", async () => {
    const result = await run(findFiles, { minSize: 2, maxSize: 2 });
    expect(result.matches.map((m: { path: string }) => m.path)).toEqual(["src/two.ts"]);
  });

  test("mtime bounds come from the caller as ISO strings", async () => {
    const between = new Date(1_500_000_000).toISOString();
    const after = await run(findFiles, { modifiedAfter: between, name: "*.ts" });
    expect(after.matches.map((m: { path: string }) => m.path)).toEqual(["src/two.ts"]);
    const before = await run(findFiles, { modifiedBefore: between, name: "*.ts" });
    expect(before.matches.map((m: { path: string }) => m.path)).toEqual(["src/one.ts"]);
  });

  test("an unreadable date is a message, not a silent epoch bound", async () => {
    expect(await run(findFiles, { modifiedAfter: "last tuesday" })).toContain(
      "not a date I can read",
    );
    expect(
      await run(findFiles, { modifiedAfter: "2024-01-02", modifiedBefore: "2024-01-01" }),
    ).toContain("nothing could match");
  });

  test("the limit is applied after sorting, and the total is still reported", async () => {
    const result = await run(findFiles, { name: "*.ts", limit: 1 });
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].path).toBe("src/one.ts");
  });
});

// ---------------------------------------------------------------------------

describe("ReadLines and TailFile", () => {
  beforeEach(() => {
    write("log.txt", Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"));
  });

  test("a range comes back with the right lines", async () => {
    const result = await run(readLines, { path: "log.txt", start: 5, end: 7 });
    expect(result.lines).toEqual(["line 5", "line 6", "line 7"]);
    expect(result.start).toBe(5);
    expect(result.end).toBe(7);
  });

  test("asking past the end returns what exists and says so", async () => {
    const result = await run(readLines, { path: "log.txt", start: 199, end: 400 });
    expect(result.lines).toEqual(["line 199", "line 200"]);
    expect(result.endOfFile).toBe(true);
  });

  test("maxLines caps the range even when end is far away", async () => {
    const result = await run(readLines, { path: "log.txt", start: 1, end: 200, maxLines: 3 });
    expect(result.returned).toBe(3);
    expect(result.requestedEnd).toBe(3);
  });

  test("a multi-byte character split across read chunks survives", async () => {
    // Long enough that the emoji lands in the middle of a 256 KiB read.
    const filler = "a".repeat(300_000);
    write("wide.txt", `${filler}\n🎉 done\n`);
    const result = await run(readLines, { path: "wide.txt", start: 2, end: 2 });
    expect(result.lines).toEqual(["🎉 done"]);
  });

  test("the tail is the last N lines", async () => {
    const result = await run(tailFile, { path: "log.txt", lines: 3 });
    expect(result.lines).toEqual(["line 198", "line 199", "line 200"]);
    expect(result.wholeFileScanned).toBe(true);
  });

  test("a file shorter than the request returns all of it", async () => {
    write("short.txt", "only\n");
    const result = await run(tailFile, { path: "short.txt", lines: 10 });
    expect(result.lines).toEqual(["only"]);
  });

  test("a scan-back cap drops the partial first line rather than reporting half of it", async () => {
    const result = await run(tailFile, { path: "log.txt", lines: 500, maxBytes: 1024 });
    expect(result.wholeFileScanned).toBe(false);
    expect(result.returned).toBeLessThan(200);
    expect(result.lines.at(-1)).toBe("line 200");
    for (const line of result.lines) expect(line).toMatch(/^line \d+$/);
  });

  test("a multi-byte character straddling a backwards read is not mangled", async () => {
    write("wide.txt", `${"b".repeat(300_000)}\n🎉 tail\n`);
    const result = await run(tailFile, { path: "wide.txt", lines: 1, maxBytes: 64 * 1024 * 1024 });
    expect(result.lines).toEqual(["🎉 tail"]);
  });
});

// ---------------------------------------------------------------------------

describe("MakeDirectory, TouchFile and TempDir", () => {
  test("directories are created with their parents and are idempotent", async () => {
    expect(await run(makeDirectory, { path: "a/b/c" })).toEqual({
      path: "a/b/c",
      created: true,
      existed: false,
    });
    expect(await run(makeDirectory, { path: "a/b/c" })).toEqual({
      path: "a/b/c",
      created: false,
      existed: true,
    });
    expect(existsSync(path.join(tmp, "a/b/c"))).toBe(true);
  });

  test("a file in the way is reported", async () => {
    write("thing", "x");
    expect(await run(makeDirectory, { path: "thing" })).toContain("not a directory");
  });

  test("touch creates an empty file and leaves an existing one alone", async () => {
    expect((await run(touchFile, { path: "marker" })).created).toBe(true);
    expect(readFileSync(path.join(tmp, "marker"), "utf8")).toBe("");
    write("kept.txt", "contents");
    const again = await run(touchFile, { path: "kept.txt" });
    expect(again.created).toBe(false);
    expect(again.timestampsSet).toBe(false);
    expect(readFileSync(path.join(tmp, "kept.txt"), "utf8")).toBe("contents");
  });

  test("a supplied mtime is what gets set", async () => {
    write("t.txt", "x");
    const when = "2021-06-01T12:00:00.000Z";
    expect((await run(touchFile, { path: "t.txt", mtime: when })).mtime).toBe(when);
    expect((await run(stat, { path: "t.txt" })).mtime).toBe(when);
  });

  test("a scratch directory is named by the caller, so it is the same every time", async () => {
    const first = await run(tempDir, { name: "work" });
    expect(first).toEqual({ path: ".tmp/work", created: true, existed: false, cleared: false });
    write(".tmp/work/leftover", "x");
    const second = await run(tempDir, { name: "work" });
    expect(second.existed).toBe(true);
    expect(existsSync(path.join(tmp, ".tmp/work/leftover"))).toBe(true);
    const third = await run(tempDir, { name: "work", clear: true });
    expect(third.cleared).toBe(true);
    expect(existsSync(path.join(tmp, ".tmp/work/leftover"))).toBe(false);
  });

  test("a name that is really a path is refused", async () => {
    expect(await run(tempDir, { name: "../escape" })).toContain("not a usable directory name");
    expect(await run(tempDir, { name: "a/b" })).toContain("not a usable directory name");
  });
});

// ---------------------------------------------------------------------------

describe("CopyPath, MovePath and RemovePath", () => {
  beforeEach(() => {
    write("src/a.txt", "aaa");
    write("src/nested/b.txt", "bb");
  });

  test("a directory copy reproduces the tree", async () => {
    const result = await run(copyPath, { source: "src", destination: "dest" });
    expect(result).toMatchObject({ copied: true, files: 2, directories: 2, bytes: 5 });
    expect(readFileSync(path.join(tmp, "dest/nested/b.txt"), "utf8")).toBe("bb");
  });

  test("an existing destination is refused, and named", async () => {
    write("dest/a.txt", "old");
    const refused = await run(copyPath, { source: "src", destination: "dest" });
    expect(refused.copied).toBe(false);
    expect(refused.conflicts).toEqual(["dest/a.txt"]);
    expect(readFileSync(path.join(tmp, "dest/a.txt"), "utf8")).toBe("old");
  });

  test("overwrite replaces the conflicting files", async () => {
    write("dest/a.txt", "old");
    const result = await run(copyPath, { source: "src", destination: "dest", overwrite: true });
    expect(result.copied).toBe(true);
    expect(readFileSync(path.join(tmp, "dest/a.txt"), "utf8")).toBe("aaa");
  });

  test("dryRun reports exactly what a real copy would do, and writes nothing", async () => {
    write("dest/a.txt", "old");
    const planned = await run(copyPath, {
      source: "src",
      destination: "dest",
      overwrite: true,
      dryRun: true,
    });
    expect(planned).toMatchObject({ dryRun: true, copied: false, files: 2, overwrites: 1 });
    expect(planned.wouldOverwrite).toEqual(["dest/a.txt"]);
    expect(readFileSync(path.join(tmp, "dest/a.txt"), "utf8")).toBe("old");
    const real = await run(copyPath, { source: "src", destination: "dest", overwrite: true });
    expect(real.files).toBe(planned.files);
    expect(real.bytes).toBe(planned.bytes);
  });

  test("a symlink is copied as a link, not as what it points at", async () => {
    symlinkSync("a.txt", path.join(tmp, "src/alias"));
    await run(copyPath, { source: "src", destination: "dest" });
    const copied = await run(stat, { path: "dest/alias" });
    expect(copied.type).toBe("symlink");
    expect(copied.linkTarget).toBe("a.txt");
  });

  test("copying a directory into itself is refused", async () => {
    expect(await run(copyPath, { source: "src", destination: "src/inner" })).toContain(
      "into itself",
    );
  });

  test("move renames, and refuses to clobber unless told", async () => {
    write("other.txt", "keep");
    const refused = await run(movePath, { source: "src/a.txt", destination: "other.txt" });
    expect(refused.moved).toBe(false);
    expect(readFileSync(path.join(tmp, "other.txt"), "utf8")).toBe("keep");

    const done = await run(movePath, {
      source: "src/a.txt",
      destination: "other.txt",
      overwrite: true,
    });
    expect(done.moved).toBe(true);
    expect(readFileSync(path.join(tmp, "other.txt"), "utf8")).toBe("aaa");
    expect(existsSync(path.join(tmp, "src/a.txt"))).toBe(false);
  });

  test("a move dryRun leaves the source where it is", async () => {
    const planned = await run(movePath, { source: "src", destination: "elsewhere", dryRun: true });
    expect(planned).toMatchObject({ dryRun: true, moved: false });
    expect(existsSync(path.join(tmp, "src"))).toBe(true);
  });

  test("remove needs recursive for a directory with contents", async () => {
    const refused = await run(removePath, { path: "src" });
    expect(refused).toContain("pass recursive: true");
    expect(existsSync(path.join(tmp, "src"))).toBe(true);
  });

  test("a remove dryRun counts what would go without going", async () => {
    const planned = await run(removePath, { path: "src", recursive: true, dryRun: true });
    expect(planned).toMatchObject({
      dryRun: true,
      removed: false,
      files: 2,
      directories: 2,
      bytes: 5,
    });
    expect(existsSync(path.join(tmp, "src"))).toBe(true);
    const done = await run(removePath, { path: "src", recursive: true });
    expect(done).toMatchObject({ removed: true, files: 2, directories: 2 });
    expect(existsSync(path.join(tmp, "src"))).toBe(false);
  });

  test("removing a symlink removes the link, never its target", async () => {
    symlinkSync(path.join(tmp, "src/a.txt"), path.join(tmp, "alias"));
    expect((await run(removePath, { path: "alias" })).removed).toBe(true);
    expect(existsSync(path.join(tmp, "alias"))).toBe(false);
    expect(readFileSync(path.join(tmp, "src/a.txt"), "utf8")).toBe("aaa");
  });

  test("a missing path is an error unless missingOk says otherwise", async () => {
    expect(await run(removePath, { path: "ghost" })).toContain("no such path");
    expect(await run(removePath, { path: "ghost", missingOk: true })).toEqual({
      path: "ghost",
      removed: false,
      existed: false,
    });
  });
});

// ---------------------------------------------------------------------------

describe("SplitFile and ConcatFiles", () => {
  test("a byte split round-trips through a concat", async () => {
    const body = "0123456789".repeat(100);
    write("data.bin", body);
    const split = await run(splitFile, { path: "data.bin", maxBytes: 300 });
    expect(split.count).toBe(4);
    expect(split.parts.map((p: { bytes: number }) => p.bytes)).toEqual([300, 300, 300, 100]);
    const joined = await run(concatFiles, {
      paths: split.parts.map((p: { path: string }) => p.path),
      destination: "rejoined.bin",
    });
    expect(joined.bytes).toBe(1000);
    expect(readFileSync(path.join(tmp, "rejoined.bin"), "utf8")).toBe(body);
  });

  test("a line split keeps whole lines and round-trips too", async () => {
    const body = `${Array.from({ length: 10 }, (_, i) => `row ${i}`).join("\n")}\n`;
    write("rows.csv", body);
    const split = await run(splitFile, { path: "rows.csv", maxLines: 4 });
    expect(split.parts.map((p: { lines: number }) => p.lines)).toEqual([4, 4, 2]);
    await run(concatFiles, {
      paths: split.parts.map((p: { path: string }) => p.path),
      destination: "rows-again.csv",
    });
    expect(readFileSync(path.join(tmp, "rows-again.csv"), "utf8")).toBe(body);
  });

  test("a line split counts bytes, so multi-byte content is not corrupted", async () => {
    const body = "héllo\nwörld\n🎉\n";
    write("utf8.txt", body);
    const split = await run(splitFile, { path: "utf8.txt", maxLines: 1 });
    await run(concatFiles, {
      paths: split.parts.map((p: { path: string }) => p.path),
      destination: "utf8-again.txt",
    });
    expect(readFileSync(path.join(tmp, "utf8-again.txt"), "utf8")).toBe(body);
  });

  test("existing parts are refused unless overwrite is set", async () => {
    write("data.bin", "0123456789");
    write("data.bin.part0001", "old");
    const refused = await run(splitFile, { path: "data.bin", maxBytes: 5 });
    expect(refused.split).toBe(false);
    expect(refused.conflicts).toEqual(["data.bin.part0001"]);
    expect((await run(splitFile, { path: "data.bin", maxBytes: 5, overwrite: true })).split).toBe(
      true,
    );
  });

  test("a dry run names the parts without creating them", async () => {
    write("data.bin", "0123456789");
    const planned = await run(splitFile, { path: "data.bin", maxBytes: 4, dryRun: true });
    expect(planned.parts.map((p: { path: string }) => p.path)).toEqual([
      "data.bin.part0001",
      "data.bin.part0002",
      "data.bin.part0003",
    ]);
    expect(existsSync(path.join(tmp, "data.bin.part0001"))).toBe(false);
  });

  test("setting both or neither size option is a schema error", () => {
    expect(splitFile.inputSchema.safeParse({ path: "a", maxBytes: 1, maxLines: 1 }).success).toBe(
      false,
    );
    expect(splitFile.inputSchema.safeParse({ path: "a" }).success).toBe(false);
  });

  test("a separator lands between the files and nowhere else", async () => {
    write("a.txt", "A");
    write("b.txt", "B");
    await run(concatFiles, { paths: ["a.txt", "b.txt"], destination: "out.txt", separator: "\n" });
    expect(readFileSync(path.join(tmp, "out.txt"), "utf8")).toBe("A\nB");
  });

  test("the destination may not also be a source", async () => {
    write("a.txt", "A");
    expect(await run(concatFiles, { paths: ["a.txt"], destination: "a.txt" })).toContain(
      "also one of the sources",
    );
  });
});

// ---------------------------------------------------------------------------

describe("archives", () => {
  test("ArchiveList reads a hand-built tar without shelling out", async () => {
    writeFileSync(
      path.join(tmp, "bundle.tar"),
      buildTar([
        { name: "pkg/", kind: "dir" },
        { name: "pkg/b.txt", data: "bb" },
        { name: "pkg/a.txt", data: "a" },
      ]),
    );
    const result = await run(archiveList, { path: "bundle.tar" });
    expect(result.format).toBe("tar");
    expect(result.count).toBe(3);
    expect(result.entries.map((e: { name: string }) => e.name)).toEqual([
      "pkg/",
      "pkg/a.txt",
      "pkg/b.txt",
    ]);
    expect(result.unsafeEntries).toEqual([]);
  });

  test("ArchiveList flags a member whose path escapes", async () => {
    writeFileSync(path.join(tmp, "evil.zip"), buildZip([{ name: "../escaped.txt", data: "x" }]));
    const result = await run(archiveList, { path: "evil.zip" });
    expect(result.format).toBe("zip");
    expect(result.unsafeEntries).toEqual(["../escaped.txt"]);
  });

  test("a file that is not an archive is refused with a reason", async () => {
    write("notes.txt", "hello");
    expect(await run(archiveList, { path: "notes.txt" })).toContain("not a tar, tar.gz or zip");
  });

  test("ArchiveExtract refuses a zip-slip archive and writes nothing", async () => {
    writeFileSync(
      path.join(tmp, "evil.zip"),
      buildZip([
        { name: "safe.txt", data: "fine" },
        { name: "../escaped.txt", data: "pwned" },
      ]),
    );
    mkdirSync(path.join(tmp, "dest"));
    const result = await run(archiveExtract, { archive: "evil.zip", destination: "dest" });
    expect(result.extracted).toBe(false);
    expect(result.reason).toBe("unsafe archive");
    expect(result.refused).toEqual(["../escaped.txt (path escapes the destination)"]);
    expect(existsSync(path.join(tmp, "escaped.txt"))).toBe(false);
    expect(readdirSync(path.join(tmp, "dest"))).toEqual([]);
  });

  test("ArchiveExtract refuses a tar-slip archive the same way", async () => {
    writeFileSync(
      path.join(tmp, "evil.tar"),
      buildTar([
        { name: "good/a.txt", data: "ok" },
        { name: "../../escaped.txt", data: "pwned" },
      ]),
    );
    mkdirSync(path.join(tmp, "dest"));
    const result = await run(archiveExtract, { archive: "evil.tar", destination: "dest" });
    expect(result.extracted).toBe(false);
    expect(result.refusedCount).toBe(1);
    expect(readdirSync(path.join(tmp, "dest"))).toEqual([]);
  });

  test("ArchiveExtract refuses a symlink member pointing out of the destination", async () => {
    writeFileSync(
      path.join(tmp, "link.tar"),
      buildTar([{ name: "pkg/passwd", kind: "symlink", linkTarget: "/etc/passwd" }]),
    );
    mkdirSync(path.join(tmp, "dest"));
    const result = await run(archiveExtract, { archive: "link.tar", destination: "dest" });
    expect(result.extracted).toBe(false);
    expect(result.refused[0]).toContain("link points outside");
  });

  test("a tar whose members all stay put is accepted", async () => {
    writeFileSync(path.join(tmp, "ok.tar"), buildTar([{ name: "pkg/a.txt", data: "hello" }]));
    const listed = await run(archiveList, { path: "ok.tar" });
    expect(listed.unsafeEntries).toEqual([]);
  });

  test.if(hasTar)("a tar round-trips: create, list, extract", async () => {
    write("payload/a.txt", "aaa");
    write("payload/nested/b.txt", "bb");
    const created = await run(archiveCreate, { source: "payload", output: "bundle.tar.gz" });
    expect(created.created).toBe(true);
    expect(created.format).toBe("tar.gz");
    expect(created.entries).toBeGreaterThan(0);

    const listed = await run(archiveList, { path: "bundle.tar.gz" });
    expect(listed.entries.some((e: { name: string }) => e.name.endsWith("nested/b.txt"))).toBe(
      true,
    );

    const extracted = await run(archiveExtract, { archive: "bundle.tar.gz", destination: "out" });
    expect(extracted.extracted).toBe(true);
    expect(extracted.entries).toEqual(["payload"]);
    expect(readFileSync(path.join(tmp, "out/payload/nested/b.txt"), "utf8")).toBe("bb");
    expect(existsSync(path.join(tmp, "out/.crewhaus-extract"))).toBe(false);
  });

  test.if(hasTar)("an existing output is refused, and dryRun changes nothing", async () => {
    write("payload/a.txt", "aaa");
    await run(archiveCreate, { source: "payload", output: "bundle.tar" });
    const refused = await run(archiveCreate, { source: "payload", output: "bundle.tar" });
    expect(refused.created).toBe(false);
    const planned = await run(archiveExtract, {
      archive: "bundle.tar",
      destination: "out",
      dryRun: true,
    });
    expect(planned).toMatchObject({ dryRun: true, extracted: false, topLevel: ["payload"] });
    expect(existsSync(path.join(tmp, "out"))).toBe(false);
  });

  test.if(hasTar)("extracting over an existing entry needs overwrite", async () => {
    write("payload/a.txt", "aaa");
    await run(archiveCreate, { source: "payload", output: "bundle.tar" });
    mkdirSync(path.join(tmp, "out"), { recursive: true });
    write("out/payload/a.txt", "old");
    const refused = await run(archiveExtract, { archive: "bundle.tar", destination: "out" });
    expect(refused.extracted).toBe(false);
    expect(refused.conflicts).toEqual(["payload"]);
    expect(readFileSync(path.join(tmp, "out/payload/a.txt"), "utf8")).toBe("old");
    const done = await run(archiveExtract, {
      archive: "bundle.tar",
      destination: "out",
      overwrite: true,
    });
    expect(done.extracted).toBe(true);
    expect(readFileSync(path.join(tmp, "out/payload/a.txt"), "utf8")).toBe("aaa");
  });

  test.if(hasZip)("a zip round-trips through the same two tools", async () => {
    write("payload/a.txt", "aaa");
    const created = await run(archiveCreate, { source: "payload", output: "bundle.zip" });
    expect(created.format).toBe("zip");
    const extracted = await run(archiveExtract, { archive: "bundle.zip", destination: "out" });
    expect(extracted.extracted).toBe(true);
    expect(readFileSync(path.join(tmp, "out/payload/a.txt"), "utf8")).toBe("aaa");
  });

  test.if(hasTar)("an archive written inside the directory being archived is refused", async () => {
    write("payload/a.txt", "aaa");
    expect(await run(archiveCreate, { source: "payload", output: "payload/self.tar" })).toContain(
      "inside the directory being archived",
    );
  });

  test("a timeout is part of the schema, so a hung archiver cannot run forever", () => {
    expect(
      archiveCreate.inputSchema.safeParse({ source: "a", output: "b.tar", timeout: 5000 }).success,
    ).toBe(true);
    expect(
      archiveCreate.inputSchema.safeParse({ source: "a", output: "b.tar", timeout: 10 }).success,
    ).toBe(false);
  });

  test("a member under a .git directory is delivered, not silently dropped", async () => {
    // The staging directory used to be drained with the listing walker, which
    // skips `.git` unconditionally — so extracting a repository archive
    // reported success while deleting every `.git` member with the staging
    // directory it left behind.
    writeFileSync(
      path.join(tmp, "repo.tar"),
      buildTar([
        { name: "proj/", kind: "dir" },
        { name: "proj/file.txt", data: "hi" },
        { name: ".git/", kind: "dir" },
        { name: ".git/config", data: "[core]\n" },
      ]),
    );
    const result = await run(archiveExtract, { archive: "repo.tar", destination: "out" });
    expect(result.extracted).toBe(true);
    expect(result.entries).toEqual([".git", "proj"]);
    expect(readFileSync(path.join(tmp, "out/.git/config"), "utf8")).toBe("[core]\n");
    expect(existsSync(path.join(tmp, "out/.crewhaus-extract"))).toBe(false);
  });

  test("a zip symlink escaping the destination is refused even under a .git path", async () => {
    // Both gates used to miss this one: the zip parser did not read a
    // symlink's target, so the name check had nothing to judge, and the
    // post-extraction check walked with the `.git`-skipping walker. The link
    // landed in the workspace pointing at /etc/passwd.
    writeFileSync(
      path.join(tmp, "evil.zip"),
      buildZip([
        { name: "proj/.git/", kind: "dir" },
        { name: "proj/.git/pwn", kind: "symlink", linkTarget: "/etc/passwd" },
      ]),
    );
    const result = await run(archiveExtract, { archive: "evil.zip", destination: "out" });
    expect(result.extracted).toBe(false);
    expect(result.refused).toEqual(["proj/.git/pwn -> /etc/passwd (link points outside)"]);
    expect(existsSync(path.join(tmp, "out/proj"))).toBe(false);
  });

  test("a zip symlink staying inside the destination is still allowed", async () => {
    writeFileSync(
      path.join(tmp, "ok.zip"),
      buildZip([
        { name: "pkg/real.txt", data: "hello" },
        { name: "pkg/alias.txt", kind: "symlink", linkTarget: "real.txt" },
      ]),
    );
    const listed = await run(archiveList, { path: "ok.zip" });
    expect(listed.entries).toContainEqual({
      name: "pkg/alias.txt",
      kind: "symlink",
      size: "real.txt".length,
      linkTarget: "real.txt",
    });
    const planned = await run(archiveExtract, {
      archive: "ok.zip",
      destination: "out",
      dryRun: true,
    });
    expect(planned.dryRun).toBe(true);
    expect(planned.extracted).toBe(false);
  });

  test("a .tar.gz that declares more content than fits in memory is refused", async () => {
    // A gzip of a few hundred bytes expands to whatever it likes, so the cap
    // on the file's size on disk caps nothing. The declared size is checked
    // before anything is decompressed.
    const real = Bun.gzipSync(new TextEncoder().encode("not actually a tar"));
    const bomb = Buffer.from(real);
    bomb.writeUInt32LE(4_000_000_000, bomb.length - 4); // claim 4 GB of content
    writeFileSync(path.join(tmp, "bomb.tar.gz"), bomb);
    const result = await run(archiveList, { path: "bomb.tar.gz" });
    expect(result).toContain("over the");
    expect(result).toContain("limit for reading one in memory");
  });

  test("a member named after the staging directory is refused, not half-extracted", async () => {
    // It used to collide with the directory the extraction is promoted out
    // of: the rename threw ENOENT out of the tool and the `finally` deleted
    // the staging tree, so every other member vanished too.
    writeFileSync(
      path.join(tmp, "s.tar"),
      buildTar([
        { name: ".crewhaus-extract/", kind: "dir" },
        { name: ".crewhaus-extract/x.txt", data: "boom" },
        { name: "good.txt", data: "ok" },
      ]),
    );
    const result = await run(archiveExtract, { archive: "s.tar", destination: "out" });
    expect(result.extracted).toBe(false);
    expect(result.refused[0]).toContain("collides with the staging directory");
    expect(existsSync(path.join(tmp, "out/good.txt"))).toBe(false);
  });

  test.if(hasTar)("a source whose name looks like an option is packed, not obeyed", async () => {
    // `zip -r -X out.zip -x` is a malformed exclude, and a better-chosen
    // name would have changed what the archiver did. The member list is
    // terminated with `--` so a caller cannot reach the archiver's options
    // through a directory name.
    write("-x/inner.txt", "payload");
    const created = await run(archiveCreate, { source: "-x", output: "dash.tar" });
    expect(created.created).toBe(true);
    const listed = await run(archiveList, { path: "dash.tar" });
    expect(listed.entries.some((e: { name: string }) => e.name.endsWith("-x/inner.txt"))).toBe(
      true,
    );
  });
});

describe("a wrong-typed destination is answered, not thrown", () => {
  // Each of these used to reach a syscall that throws (EISDIR, EEXIST,
  // ERR_FS_EISDIR) and escape the tool as an exception rather than as the
  // message the caller can act on.
  test("ConcatFiles onto a directory", async () => {
    write("a.txt", "A");
    mkdirSync(path.join(tmp, "out"));
    expect(await run(concatFiles, { paths: ["a.txt"], destination: "out", overwrite: true })).toBe(
      "out is a dir, not a regular file",
    );
  });

  test("SplitFile into a file", async () => {
    write("data.bin", "0123456789");
    write("notadir", "x");
    expect(await run(splitFile, { path: "data.bin", maxBytes: 4, outputDir: "notadir" })).toBe(
      "notadir is a file, not a directory",
    );
  });

  test("ArchiveCreate over a directory", async () => {
    write("payload/a.txt", "a");
    mkdirSync(path.join(tmp, "out.tar"));
    expect(
      await run(archiveCreate, { source: "payload", output: "out.tar", overwrite: true }),
    ).toContain("not an archive file this tool may replace");
    expect(existsSync(path.join(tmp, "out.tar"))).toBe(true);
  });

  test("ArchiveExtract into a file", async () => {
    writeFileSync(path.join(tmp, "ok.tar"), buildTar([{ name: "pkg/a.txt", data: "x" }]));
    write("dest", "in the way");
    expect(await run(archiveExtract, { archive: "ok.tar", destination: "dest" })).toBe(
      "dest is a file, not a directory to extract into",
    );
    expect(readFileSync(path.join(tmp, "dest"), "utf8")).toBe("in the way");
  });
});

describe("spawning", () => {
  test("a process that would never exit is killed at its deadline", async () => {
    // The schema having a `timeout` field proves nothing about whether it is
    // enforced; this runs a process that would outlive the test suite.
    const started = Date.now();
    const result = await runProcess(["sleep", "60"], { cwd: tmp, timeoutMs: 400 });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(elapsed).toBeLessThan(15_000);
    expect(describeFailure(["sleep"], result)).toContain("exceeding its timeout");
  });

  test("a missing executable is reported rather than thrown", async () => {
    const result = await runProcess(["crewhaus-no-such-binary"], { cwd: tmp, timeoutMs: 5000 });
    expect(result.missing).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(describeFailure(["crewhaus-no-such-binary"], result)).toContain("is not installed");
  });

  test("an aborted turn does not leave the child running", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runProcess(["sleep", "60"], {
      cwd: tmp,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("front matter", () => {
  test("reading returns structured data and leaves the file alone", async () => {
    write("doc.md", "---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n# Body\n");
    const result = await run(frontmatterRead, { path: "doc.md" });
    expect(result.hasFrontmatter).toBe(true);
    expect(result.data).toEqual({ title: "Hello", tags: ["a", "b"] });
    expect(result.keys).toEqual(["tags", "title"]);
    expect(result.bodyChars).toBe("# Body\n".length);
  });

  test("a file with no front matter says so", async () => {
    write("doc.md", "# Just a heading\n");
    expect(await run(frontmatterRead, { path: "doc.md" })).toMatchObject({ hasFrontmatter: false });
  });

  test("YAML outside the subset is refused with the line", async () => {
    write("doc.md", "---\nmeta:\n  nested: 1\n---\nbody\n");
    expect(await run(frontmatterRead, { path: "doc.md" })).toContain("nested mappings");
  });

  test("writing merges, keeps key order, and leaves the body byte-identical", async () => {
    write("doc.md", "---\ntitle: Hello\nstatus: draft\n---\n# Body\n\nparagraph\n");
    const result = await run(frontmatterWrite, {
      path: "doc.md",
      data: { status: "published", tags: ["x"] },
    });
    expect(result.written).toBe(true);
    expect(readFileSync(path.join(tmp, "doc.md"), "utf8")).toBe(
      "---\ntitle: Hello\nstatus: published\ntags:\n  - x\n---\n# Body\n\nparagraph\n",
    );
  });

  test("removeKeys drops keys, and merge:false replaces the block", async () => {
    write("doc.md", "---\na: 1\nb: 2\n---\nbody\n");
    await run(frontmatterWrite, { path: "doc.md", data: {}, removeKeys: ["a"] });
    expect(readFileSync(path.join(tmp, "doc.md"), "utf8")).toBe("---\nb: 2\n---\nbody\n");
    await run(frontmatterWrite, { path: "doc.md", data: { c: 3 }, merge: false });
    expect(readFileSync(path.join(tmp, "doc.md"), "utf8")).toBe("---\nc: 3\n---\nbody\n");
  });

  test("front matter is added to a document that had none", async () => {
    write("doc.md", "# Body\n");
    await run(frontmatterWrite, { path: "doc.md", data: { title: "New" } });
    expect(readFileSync(path.join(tmp, "doc.md"), "utf8")).toBe("---\ntitle: New\n---\n# Body\n");
  });

  test("a no-op write reports no change and does not touch the file", async () => {
    write("doc.md", "---\na: 1\n---\nbody\n");
    const before = await run(stat, { path: "doc.md" });
    const result = await run(frontmatterWrite, { path: "doc.md", data: { a: 1 } });
    expect(result).toMatchObject({ changed: false, written: false });
    expect((await run(stat, { path: "doc.md" })).sha256).toBe(before.sha256);
  });

  test("dryRun shows the block it would write", async () => {
    write("doc.md", "---\na: 1\n---\nbody\n");
    const planned = await run(frontmatterWrite, { path: "doc.md", data: { b: 2 }, dryRun: true });
    expect(planned.frontmatter).toBe("a: 1\nb: 2");
    expect(readFileSync(path.join(tmp, "doc.md"), "utf8")).toBe("---\na: 1\n---\nbody\n");
  });

  test("unparseable existing front matter is not silently replaced", async () => {
    write("doc.md", "---\nmeta:\n  nested: 1\n---\nbody\n");
    const result = await run(frontmatterWrite, { path: "doc.md", data: { a: 1 } });
    expect(result).toContain("fix or remove the front matter");
    expect(readFileSync(path.join(tmp, "doc.md"), "utf8")).toContain("nested: 1");
  });
});

// ---------------------------------------------------------------------------

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
    metadata: { kernelspec: { name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  };

  beforeEach(() => {
    write("nb.ipynb", `${JSON.stringify(notebook, null, 1)}\n`);
  });

  test("cells come back with their sources and flattened outputs", async () => {
    const result = await run(notebookRead, { path: "nb.ipynb" });
    expect(result.totalCells).toBe(2);
    expect(result.cells[0]).toEqual({ index: 0, type: "markdown", source: "# Title\n" });
    expect(result.cells[1].outputs).toEqual([{ type: "stream:stdout", text: "1\n" }]);
  });

  test("outputs can be left out, and cells filtered by type", async () => {
    const result = await run(notebookRead, {
      path: "nb.ipynb",
      includeOutputs: false,
      cellType: "code",
    });
    expect(result.cells.length).toBe(1);
    expect(result.cells[0].outputs).toBeUndefined();
  });

  test("a file that is not a notebook is refused with a reason", async () => {
    write("bad.ipynb", "{}");
    expect(await run(notebookRead, { path: "bad.ipynb" })).toContain('no "cells" array');
  });

  test("replacing a code cell clears its stale output on disk", async () => {
    const result = await run(notebookEdit, {
      path: "nb.ipynb",
      mode: "replace",
      index: 1,
      source: "print(2)\n",
    });
    expect(result).toMatchObject({ written: true, totalCells: 2 });
    const reread = await run(notebookRead, { path: "nb.ipynb" });
    expect(reread.cells[1].source).toBe("print(2)\n");
    expect(reread.cells[1].outputs).toBeUndefined();
  });

  test("insert and delete change the cell count", async () => {
    await run(notebookEdit, {
      path: "nb.ipynb",
      mode: "insert",
      index: 0,
      cellType: "markdown",
      source: "intro",
    });
    expect((await run(notebookRead, { path: "nb.ipynb" })).totalCells).toBe(3);
    await run(notebookEdit, { path: "nb.ipynb", mode: "delete", index: 0 });
    expect((await run(notebookRead, { path: "nb.ipynb" })).totalCells).toBe(2);
  });

  test("an out-of-range index names the valid range and writes nothing", async () => {
    const before = readFileSync(path.join(tmp, "nb.ipynb"), "utf8");
    expect(await run(notebookEdit, { path: "nb.ipynb", mode: "delete", index: 42 })).toContain(
      "0..1",
    );
    expect(readFileSync(path.join(tmp, "nb.ipynb"), "utf8")).toBe(before);
  });

  test("a replace without a source is refused before the file is read", async () => {
    expect(await run(notebookEdit, { path: "nb.ipynb", mode: "replace", index: 0 })).toContain(
      "needs a source",
    );
  });

  test("the rewritten file keeps Jupyter's formatting", async () => {
    await run(notebookEdit, { path: "nb.ipynb", mode: "replace", index: 0, source: "# New\n" });
    const text = readFileSync(path.join(tmp, "nb.ipynb"), "utf8");
    expect(text.startsWith('{\n "cells": [')).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).metadata.kernelspec.name).toBe("python3");
  });
});

// ---------------------------------------------------------------------------

describe("determinism", () => {
  test("repeated reads of an unchanged tree return identical bytes", async () => {
    write("a/one.txt", "1");
    write("a/two.txt", "22");
    write("b/three.txt", "333");
    for (const call of [
      () => stat.execute({ path: "a/one.txt" }),
      () => tree.execute({ path: "." }),
      () => diskUsage.execute({ path: "." }),
      () => findFiles.execute({ name: "*.txt" }),
      () => archiveList.execute({ path: "a" }),
    ]) {
      expect(await call()).toBe(await call());
    }
  });

  test("an unreadable directory is skipped rather than failing the walk", async () => {
    write("readable/a.txt", "a");
    mkdirSync(path.join(tmp, "locked"));
    write("locked/secret.txt", "s");
    chmodSync(path.join(tmp, "locked"), 0o000);
    try {
      const out = await run(tree, { path: ".", maxDepth: 2 });
      expect(out).toContain("readable");
      expect(out).toContain("locked");
    } finally {
      chmodSync(path.join(tmp, "locked"), 0o755);
    }
  });
});
