import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  type RegexOutcome,
  type RegexRequest,
  type RegexSession,
  type ResultOf,
  type TestEachResult,
  openRegexSession,
  regexWorkerCounts,
} from "@crewhaus/tool-safety/regex";
import {
  DEFAULT_IGNORED_DIRS,
  READ_MAX_BYTES,
  ToolPermissionError,
  _setGrepLimitsForTest,
  _setReadMaxBytesForTest,
  allFsTools,
  edit,
  glob,
  grep,
  hasNestedQuantifier,
  read,
  write,
} from "./index";
import { requiredLiterals } from "./literals";
import { lineBudgetOf, repeatChainLength, staticLineCap } from "./repeat-chain";

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(path.join(tmpdir(), "tool-fs-"));
  process.chdir(tmp);
});

afterEach(() => {
  _setGrepLimitsForTest(undefined);
  _setReadMaxBytesForTest(undefined);
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("ToolPermissionError", () => {
  test("is a CrewhausError with code 'tool'", () => {
    const err = new ToolPermissionError("Read", "../../escape");
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.code).toBe("tool");
    expect(err.toolName).toBe("Read");
    expect(err.path).toBe("../../escape");
    expect(err.message).toContain("escapes the workspace root");
  });
});

describe("Read tool", () => {
  test("returns file content", async () => {
    await writeFile(path.join(tmp, "hello.txt"), "hi there");
    const result = await read.execute({ path: "hello.txt" });
    expect(result).toBe("hi there");
  });

  test("rejects parent-directory traversal", async () => {
    await expect(read.execute({ path: "../../../etc/passwd" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects absolute path outside workspace", async () => {
    await expect(read.execute({ path: "/etc/passwd" })).rejects.toBeInstanceOf(ToolPermissionError);
  });

  test("rejects subdir-then-traversal", async () => {
    await mkdir(path.join(tmp, "sub"));
    await expect(read.execute({ path: "sub/../../escape" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("declares readOnly + concurrencySafe", () => {
    expect(read.readOnly).toBe(true);
    expect(read.concurrencySafe).toBe(true);
    expect(read.destructive).toBe(false);
  });

  // SECURITY (CWE-59/367): resolveSafe returns the realpath and the read uses
  // O_NOFOLLOW. A legitimate IN-workspace symlink still reads (via its real
  // target); a symlink pointing OUTSIDE the workspace is rejected.
  test("reads a legitimate in-workspace symlink via its real target", async () => {
    await writeFile(path.join(tmp, "target.txt"), "real-content");
    symlinkSync(path.join(tmp, "target.txt"), path.join(tmp, "link.txt"));
    const result = await read.execute({ path: "link.txt" });
    expect(result).toBe("real-content");
  });

  test("rejects an in-workspace symlink that points outside the workspace", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "tool-fs-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "OUTSIDE SECRET");
      symlinkSync(path.join(outside, "secret.txt"), path.join(tmp, "evil.txt"));
      await expect(read.execute({ path: "evil.txt" })).rejects.toBeInstanceOf(ToolPermissionError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("Write tool", () => {
  test("writes new file content", async () => {
    const result = await write.execute({ path: "out.txt", content: "data" });
    expect(result).toContain("4 bytes");
    expect(await Bun.file(path.join(tmp, "out.txt")).text()).toBe("data");
  });

  test("overwrites existing file", async () => {
    await writeFile(path.join(tmp, "out.txt"), "old");
    await write.execute({ path: "out.txt", content: "new" });
    expect(await Bun.file(path.join(tmp, "out.txt")).text()).toBe("new");
  });

  test("leaves no temp files behind on success", async () => {
    await write.execute({ path: "out.txt", content: "data" });
    const entries = readdirSync(tmp);
    expect(entries.some((e) => e.includes(".tmp."))).toBe(false);
  });

  test("rejects path traversal", async () => {
    await expect(write.execute({ path: "../../escape.txt", content: "x" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("declares destructive", () => {
    expect(write.destructive).toBe(true);
    expect(write.readOnly).toBe(false);
    expect(write.concurrencySafe).toBe(false);
  });
});

describe("Edit tool", () => {
  test("replaces unique occurrence", async () => {
    await writeFile(path.join(tmp, "f.txt"), "hello world");
    const result = await edit.execute({
      path: "f.txt",
      oldString: "world",
      newString: "there",
    });
    expect(result).toContain("edited");
    expect(await Bun.file(path.join(tmp, "f.txt")).text()).toBe("hello there");
  });

  test("errors when oldString is absent", async () => {
    await writeFile(path.join(tmp, "f.txt"), "hello");
    await expect(
      edit.execute({ path: "f.txt", oldString: "absent", newString: "x" }),
    ).rejects.toThrow(/not found/);
  });

  test("errors when oldString is non-unique", async () => {
    await writeFile(path.join(tmp, "f.txt"), "ab ab ab");
    await expect(edit.execute({ path: "f.txt", oldString: "ab", newString: "cd" })).rejects.toThrow(
      /3 times/,
    );
  });

  test("rejects path traversal", async () => {
    await expect(
      edit.execute({ path: "../escape.txt", oldString: "x", newString: "y" }),
    ).rejects.toBeInstanceOf(ToolPermissionError);
  });
});

describe("Edit writes newString literally (C134)", () => {
  // String.prototype.replace(string, string) expands $$, $&, $` and $' in the
  // replacement: the file got something else while the diff showed newString.
  const cases: ReadonlyArray<[string, string]> = [
    ["$$ (a Makefile's escaped $)", "echo pid=$$"],
    ["$& (the matched text)", 'x="$&"'],
    ["$' (the text after the match)", "rest=$'"],
    ["$` (the text before the match)", "head=$`"],
    ["all of them, plus the group forms", "echo $$ [$&] [$`] [$'] $1 $<n>"],
  ];
  for (const [label, newString] of cases) {
    test(`newString with ${label} lands on disk exactly as written`, async () => {
      const before = "head\nPLACEHOLDER\ntail\n";
      await writeFile(path.join(tmp, "f.sh"), before);
      const result = await edit.execute({ path: "f.sh", oldString: "PLACEHOLDER", newString });
      const after = readFileSync(path.join(tmp, "f.sh"), "utf8");
      expect(after).toBe(`head\n${newString}\ntail\n`);
      // No head or tail of the file was spliced in: the line count holds.
      expect(after.split("\n").length).toBe(before.split("\n").length);
      // The diff the caller sees is what is on disk.
      expect(result).toContain(`+${newString}`);
    });
  }
});

describe("Read and Edit keep a UTF-8 byte-order mark (0.7.1 review)", () => {
  const BOM = "\uFEFF";
  test("Edit changes only the text asked for, and the BOM stays on disk", async () => {
    // Before this fix Edit wrote the file back without its BOM while the
    // diff showed line 1 unchanged: tool-safety's decoder drops a BOM.
    await writeFile(path.join(tmp, "App.cs"), `${BOM}using System;\r\nclass A {}\r\n`);
    const result = String(
      await edit.execute({ path: "App.cs", oldString: "class A {}", newString: "class B {}" }),
    );
    const bytes = readFileSync(path.join(tmp, "App.cs"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe(`${BOM}using System;\r\nclass B {}\r\n`);
    expect(result).toContain(` ${BOM}using System;`);
  });

  test("Read returns the text as the file holds it, BOM first", async () => {
    await writeFile(path.join(tmp, "data.csv"), `${BOM}name,qty\n`);
    expect(await read.execute({ path: "data.csv" })).toBe(`${BOM}name,qty\n`);
  });
});

describe("Write and Edit keep the file's permission bits (C213)", () => {
  const posixOnly = process.platform !== "win32";

  test.if(posixOnly)("an edited script stays executable", async () => {
    writeFileSync(path.join(tmp, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(path.join(tmp, "run.sh"), 0o755);
    await edit.execute({ path: "run.sh", oldString: "hi", newString: "there" });
    expect(statSync(path.join(tmp, "run.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(path.join(tmp, "run.sh"), "utf8")).toBe("#!/bin/sh\necho there\n");
  });

  test.if(posixOnly)("a private file stays private when rewritten", async () => {
    writeFileSync(path.join(tmp, "secret.env"), "K=1\n");
    chmodSync(path.join(tmp, "secret.env"), 0o600);
    await write.execute({ path: "secret.env", content: "K=2\n" });
    expect(statSync(path.join(tmp, "secret.env")).mode & 0o777).toBe(0o600);
  });

  test.if(posixOnly)(
    "a new file still gets the usual 0666-minus-umask mode, not 0600",
    async () => {
      await write.execute({ path: "fresh.txt", content: "x" });
      const umask = process.umask();
      expect(statSync(path.join(tmp, "fresh.txt")).mode & 0o777).toBe(0o666 & ~umask);
    },
  );

  test("nothing but the files themselves is left in the directory", async () => {
    writeFileSync(path.join(tmp, "a.txt"), "one");
    await write.execute({ path: "a.txt", content: "two" });
    await edit.execute({ path: "a.txt", oldString: "two", newString: "three" });
    await write.execute({ path: "b.txt", content: "new" });
    expect(readdirSync(tmp).sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("Write still creates missing parent directories, as 0.7.0 did", async () => {
    await write.execute({ path: "deep/er/c.txt", content: "made" });
    expect(readFileSync(path.join(tmp, "deep/er/c.txt"), "utf8")).toBe("made");
  });

  test("an in-workspace link is written through and stays a link", async () => {
    writeFileSync(path.join(tmp, "real.md"), "old");
    symlinkSync("real.md", path.join(tmp, "alias.md"));
    await write.execute({ path: "alias.md", content: "new" });
    expect(readFileSync(path.join(tmp, "real.md"), "utf8")).toBe("new");
    expect(lstatSync(path.join(tmp, "alias.md")).isSymbolicLink()).toBe(true);
  });
});

describe("Read and Edit read only regular files, and only so much (C074)", () => {
  test.if(process.platform !== "win32")(
    "a FIFO is refused before it is opened, so the call returns",
    async () => {
      const fifo = path.join(tmp, "pipe.txt");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      // A writer blocked in open() until someone opens the FIFO to read. If a
      // tool wrongly opened it, this writer would unblock it (so a regression
      // fails here instead of hanging the suite) and would then exit.
      const writer = Bun.spawn(["sh", "-c", `printf x > '${fifo}'`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await Bun.sleep(100);
        await expect(read.execute({ path: "pipe.txt" })).rejects.toThrow(
          /Read: "pipe\.txt" is a fifo, not a regular file; it was not opened/,
        );
        await expect(
          edit.execute({ path: "pipe.txt", oldString: "x", newString: "y" }),
        ).rejects.toThrow(/Edit: "pipe\.txt" is a fifo/);
        await Bun.sleep(200);
        // Nobody opened the FIFO: the writer is still waiting.
        expect(writer.exitCode).toBeNull();
      } finally {
        writer.kill("SIGKILL");
        await writer.exited;
      }
    },
    10_000,
  );

  test("the cap is 64 MiB, the same budget Grep reads under", () => {
    expect(READ_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  test("a file at the cap is read; one byte over is refused with its size", async () => {
    _setReadMaxBytesForTest(16);
    writeFileSync(path.join(tmp, "at.txt"), "x".repeat(16));
    writeFileSync(path.join(tmp, "over.txt"), "x".repeat(17));
    expect(await read.execute({ path: "at.txt" })).toBe("x".repeat(16));
    await expect(read.execute({ path: "over.txt" })).rejects.toThrow(
      /Read: "over\.txt" is 17 bytes, over the 16-byte limit; read part of it/,
    );
    // Edit refuses it too, and leaves it as it was.
    await expect(
      edit.execute({ path: "over.txt", oldString: "x".repeat(17), newString: "y" }),
    ).rejects.toThrow(/Edit: "over\.txt" is 17 bytes, over the 16-byte limit/);
    expect(readFileSync(path.join(tmp, "over.txt"), "utf8")).toBe("x".repeat(17));
  });

  test("a sparse file past the default cap is refused from its size, not read", async () => {
    writeFileSync(path.join(tmp, "sparse.bin"), "");
    truncateSync(path.join(tmp, "sparse.bin"), 4 * 1024 * 1024 * 1024);
    await expect(read.execute({ path: "sparse.bin" })).rejects.toThrow(
      /is 4294967296 bytes, over the 67108864-byte limit/,
    );
  });
});

describe("a dangling link's target is walked as the kernel walks it (C068)", () => {
  test("Write, Edit and Read refuse `evil -> a/y/../x` when `a/y -> ..`", async () => {
    // The workspace gets its own parent, so the escape has somewhere to land.
    const parent = mkdtempSync(path.join(tmpdir(), "tool-fs-parent-"));
    const ws = path.join(parent, "ws");
    await mkdir(path.join(ws, "a"), { recursive: true });
    process.chdir(ws);
    try {
      symlinkSync("..", path.join(ws, "a", "y"));
      symlinkSync("a/y/../landed.txt", path.join(ws, "evil"));
      await expect(write.execute({ path: "evil", content: "PWNED" })).rejects.toBeInstanceOf(
        ToolPermissionError,
      );
      await expect(
        edit.execute({ path: "evil", oldString: "a", newString: "b" }),
      ).rejects.toBeInstanceOf(ToolPermissionError);
      await expect(read.execute({ path: "evil" })).rejects.toBeInstanceOf(ToolPermissionError);
      // Neither where the kernel leads nor where the text reads was written.
      expect(readdirSync(parent).sort()).toEqual(["ws"]);
      expect(readdirSync(path.join(ws, "a"))).toEqual(["y"]);
    } finally {
      process.chdir(tmp);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("Glob tool", () => {
  test("lists matching files relative to cwd", async () => {
    await writeFile(path.join(tmp, "a.ts"), "");
    await writeFile(path.join(tmp, "b.ts"), "");
    await writeFile(path.join(tmp, "c.txt"), "");
    const result = await glob.execute({ pattern: "*.ts" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result.split("\n").sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("returns 'no matches' for empty result", async () => {
    const result = await glob.execute({ pattern: "*.zzz" });
    expect(result).toBe("no matches");
  });

  test("rejects pattern with traversal", async () => {
    await expect(glob.execute({ pattern: "../*.ts" })).rejects.toBeInstanceOf(ToolPermissionError);
  });

  test("rejects absolute pattern", async () => {
    await expect(glob.execute({ pattern: "/etc/*" })).rejects.toBeInstanceOf(ToolPermissionError);
  });
});

describe("Grep tool", () => {
  test("returns path:line:match for hits", async () => {
    await writeFile(path.join(tmp, "f.txt"), "alpha\nbeta\ngamma\n");
    const result = await grep.execute({ pattern: "beta" });
    expect(result).toBe("f.txt:2:beta");
  });

  test("returns 'no matches' when nothing matches", async () => {
    await writeFile(path.join(tmp, "f.txt"), "alpha\n");
    const result = await grep.execute({ pattern: "zzz" });
    expect(result).toBe("no matches");
  });

  test("scopes to subdirectory when path provided", async () => {
    await mkdir(path.join(tmp, "sub"));
    await writeFile(path.join(tmp, "sub", "x.txt"), "needle\n");
    await writeFile(path.join(tmp, "outside.txt"), "needle\n");
    const result = await grep.execute({ pattern: "needle", path: "sub" });
    expect(result).toContain("sub/x.txt");
    expect(result).not.toContain("outside.txt");
  });

  test("rejects path traversal in path argument", async () => {
    await expect(grep.execute({ pattern: "x", path: "../" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects malformed regex", async () => {
    await expect(grep.execute({ pattern: "(unclosed" })).rejects.toThrow(/invalid regex/);
  });

  // SECURITY: the Grep pattern is model-supplied; a catastrophic-backtracking
  // pattern run over the workspace pins a CPU core (ReDoS).
  test("rejects a nested-quantifier ReDoS pattern", async () => {
    await expect(grep.execute({ pattern: "(a+)+$" })).rejects.toThrow(/nested quantifiers/);
  });

  test("rejects the (.*a)+ ReDoS shape", async () => {
    await expect(grep.execute({ pattern: "(.*a)+" })).rejects.toThrow(/nested quantifiers/);
  });

  test("still allows a safe single-quantifier pattern", async () => {
    await writeFile(path.join(tmp, "f.txt"), "alpha\nbeta\n");
    const result = await grep.execute({ pattern: "b.+a" });
    expect(result).toBe("f.txt:2:beta");
  });
});

// A compiled bundle (`crewhaus compile -o <dir> --check`) installs thousands of
// dependency files into the workspace. Before the default-ignore list, a single
// `**/*.ts` Glob in a starter returned ~4,400 vendored files around 30 real
// ones, and Grep burned its scan budget on them.
describe("vendored-directory defaults (node_modules)", () => {
  async function plantBundle(): Promise<void> {
    await mkdir(path.join(tmp, "dist", "node_modules", "@crewhaus", "crawler"), {
      recursive: true,
    });
    await writeFile(path.join(tmp, "agent.ts"), "project needle\n");
    await writeFile(
      path.join(tmp, "dist", "node_modules", "@crewhaus", "crawler", "index.ts"),
      "vendored needle\n",
    );
  }

  test("Glob skips node_modules and says how many it hid", async () => {
    await plantBundle();
    const result = await glob.execute({ pattern: "**/*.ts" });
    if (typeof result !== "string") throw new Error("expected string result");
    const lines = result.split("\n");
    expect(lines[0]).toBe("agent.ts");
    expect(lines.filter((l) => !l.startsWith("[")).join("\n")).not.toContain("node_modules");
    expect(lines[1]).toMatch(/^\[Glob: 1 file\(s\) under node_modules\/ hidden/);
  });

  test("Glob includes node_modules when the pattern names it", async () => {
    await plantBundle();
    const result = await glob.execute({ pattern: "dist/node_modules/**/*.ts" });
    expect(result).toBe("dist/node_modules/@crewhaus/crawler/index.ts");
  });

  test("Glob adds no note when nothing was hidden", async () => {
    await writeFile(path.join(tmp, "only.ts"), "");
    const result = await glob.execute({ pattern: "**/*.ts" });
    expect(result).toBe("only.ts");
  });

  test("Grep skips node_modules by default", async () => {
    await plantBundle();
    const result = await grep.execute({ pattern: "needle" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result.split("\n")[0]).toBe("agent.ts:1:project needle");
    expect(result).not.toContain("vendored needle");
    expect(result).toMatch(/\[Grep: 1 file\(s\) under node_modules\/ hidden/);
  });

  test("Grep searches node_modules when path points inside it", async () => {
    await plantBundle();
    const result = await grep.execute({ pattern: "needle", path: "dist/node_modules" });
    expect(result).toBe("dist/node_modules/@crewhaus/crawler/index.ts:1:vendored needle");
  });

  test("__pycache__ is skipped the same way", async () => {
    await mkdir(path.join(tmp, "__pycache__"));
    await writeFile(path.join(tmp, "__pycache__", "mod.cpython-312.pyc"), "needle\n");
    await writeFile(path.join(tmp, "mod.py"), "needle\n");
    const result = await grep.execute({ pattern: "needle" });
    if (typeof result !== "string") throw new Error("expected string result");
    expect(result.split("\n")[0]).toBe("mod.py:1:needle");
    expect(result).not.toContain(".pyc");
  });

  test("DEFAULT_IGNORED_DIRS is the documented list", () => {
    expect([...DEFAULT_IGNORED_DIRS]).toEqual(["node_modules", "__pycache__"]);
  });
});

describe("hasNestedQuantifier (ReDoS guard)", () => {
  test.each(["(a+)+", "(a*)*", "(.*a)+", "((\\d+)x)*", "(.*a){10}", "(a+)+$"])(
    "flags catastrophic shape %p",
    (p) => {
      expect(hasNestedQuantifier(p)).toBe(true);
    },
  );

  test.each(["beta", "a+b", "[0-9]+", "(ab)+", "(\\d{1,3}\\.){3}\\d{1,3}", "foo|bar", "https?://"])(
    "allows safe pattern %p",
    (p) => {
      expect(hasNestedQuantifier(p)).toBe(false);
    },
  );
});

describe("Grep never reports what it did not search as a miss (C089)", () => {
  test("a line the engine gave up on is undetermined, not a non-match", async () => {
    // JavaScriptCore gives up silently, as a slow "no match". With the
    // give-up threshold at 1 ms, a cubic pattern's no-match on 70 digits (a
    // few ms) takes that path, bounded, with no pathological pattern needed.
    // The " x" keeps the line past the literal pre-filter (every match
    // holds an "x"), so it really goes to the engine.
    const slow = `${"1".repeat(70)} x`;
    await writeFile(path.join(tmp, "f.txt"), `${slow}\nbeta\n${slow}\n`);
    _setGrepLimitsForTest({ giveUpMs: 1 });
    const hit = String(await grep.execute({ pattern: "\\d+\\d+\\d+x|beta" }));
    expect(hit.split("\n")[0]).toBe("f.txt:2:beta");
    expect(hit).toContain("[grep: 2 line(s) could not be evaluated");
    expect(hit).toContain("(f.txt:1, f.txt:3)");
    const miss = String(await grep.execute({ pattern: "\\d+\\d+\\d+x" }));
    expect(miss).not.toBe("no matches");
    expect(miss.startsWith("no matches in the lines searched")).toBe(true);
  });

  test("the pattern that fooled 0.7.0 is refused before it runs", async () => {
    await writeFile(
      path.join(tmp, "f.txt"),
      `${Array.from({ length: 8 }, (_, i) => `${"0123456789abcdef".repeat(4)}${i === 4 ? "NEEDLE" : ""}`).join("\n")}\n`,
    );
    // 0.7.0 returned a bare "no matches" after six seconds, NEEDLE on line 5.
    await expect(grep.execute({ pattern: "(\\w|\\d)*!|NEEDLE" })).rejects.toThrow(
      /invalid regex pattern: overlapping alternation/,
    );
    expect(String(await grep.execute({ pattern: "NEEDLE" }))).toBe(
      `f.txt:5:${"0123456789abcdef".repeat(4)}NEEDLE`,
    );
  });

  test("the deadline is checked before every file, not every 1024 lines", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await writeFile(path.join(tmp, name), "alpha\n");
    }
    let clock = 0;
    _setGrepLimitsForTest({
      now: () => {
        clock += 1000;
        return clock;
      },
    });
    const result = String(await grep.execute({ pattern: "zzz" }));
    expect(result).toContain("scan stopped early — the 2000 ms deadline passed");
    expect(result).not.toBe("no matches");
  });

  test("a deadline reached inside a file keeps the hits found and names the rest as unsearched", async () => {
    // The worker's deadline is wall-clock time, and a real one raced the
    // worker's first progress report: on a loaded CI runner the hit on line 1
    // was found but not yet reported when 100 ms passed, and the result was
    // "no matches". So this session answers every line with the real worker,
    // then hands back what a worker stopped by the deadline after its third
    // line reports: how far it got, and the hits among the lines it answered.
    // What is under test is what Grep does with that answer.
    await writeFile(path.join(tmp, "a.txt"), "111x\nabx\n333x\ncdx\n555x\n");
    const real = openRegexSession();
    let testEachRuns = 0;
    const stoppedAfterThree: RegexSession = {
      async run<R extends RegexRequest>(request: R): Promise<RegexOutcome<ResultOf<R>>> {
        const outcome = await real.run(request);
        if (request.op !== "testEach" || outcome.status !== "ok") return outcome;
        testEachRuns++;
        const answered = outcome.result as TestEachResult;
        const completed = 3;
        const partial: TestEachResult = {
          ...answered,
          matched: answered.matched.filter((i) => i < completed),
          undetermined: answered.undetermined.filter((i) => i < completed),
          scanned: completed,
        };
        return {
          status: "timeout",
          reason: "the deadline passed",
          deadlineMs: 100,
          completed,
          partial: partial as ResultOf<R>,
        };
      },
      close: () => real.close(),
    };
    _setGrepLimitsForTest({ deadlineMs: 100, openSession: () => stoppedAfterThree });
    const result = String(await grep.execute({ pattern: "\\d+x" }));
    expect(testEachRuns).toBe(1);
    expect(result.split("\n").slice(0, 2)).toEqual(["a.txt:1:111x", "a.txt:3:333x"]);
    // Line 5 matches, but the worker never answered it: not a hit, not a miss.
    expect(result).not.toContain("555x");
    expect(result).toContain(
      "scan stopped early — the 100 ms deadline passed while searching a.txt:4; it and everything after it were not searched",
    );
  });

  test("a line too long to search is named, not silently skipped", async () => {
    await writeFile(path.join(tmp, "min.js"), `short needle\n${"x".repeat(20_000)}needle\n`);
    const result = String(await grep.execute({ pattern: "needle" }));
    expect(result.split("\n")[0]).toBe("min.js:1:short needle");
    expect(result).toContain("1 line(s) longer than 10000 characters were not searched");
  });

  // Root reads a mode-000 file anyway: skipped (and reported as a skip) there.
  test.if((process.getuid?.() ?? 0) !== 0)(
    "a file it could not read is counted, not taken as a miss",
    async () => {
      await writeFile(path.join(tmp, "locked.txt"), "needle\n");
      chmodSync(path.join(tmp, "locked.txt"), 0o000);
      try {
        const result = String(await grep.execute({ pattern: "needle" }));
        expect(result).toBe(
          "no matches in the lines searched\n[grep: 1 file(s) could not be read and were not searched]",
        );
      } finally {
        chmodSync(path.join(tmp, "locked.txt"), 0o600);
      }
    },
  );

  test("a complete search with no hits is still a plain 'no matches'", async () => {
    await writeFile(path.join(tmp, "f.txt"), "alpha\n");
    expect(await grep.execute({ pattern: "zzz" })).toBe("no matches");
  });

  test("hasNestedQuantifier covers overlapping alternation, and leaves disjoint alternation alone", () => {
    expect(hasNestedQuantifier("(\\w|\\d)*!")).toBe(true);
    expect(hasNestedQuantifier("(=|=)*x")).toBe(true);
    expect(hasNestedQuantifier("(foo|bar)+")).toBe(false);
    expect(hasNestedQuantifier("(get|set)Value")).toBe(false);
  });
});

describe("Grep searches every file, whatever its size (0.7.1 review)", () => {
  /** About 1.2 M characters of ordinary log lines: over the regex worker's 1 M input limit. */
  function bigLog(): string {
    const lines = Array.from(
      { length: 24_000 },
      (_, i) => `2026-09-26T12:00:00Z INFO request ${i} ok`,
    );
    lines[1] = "the NEEDLE is on line 2";
    lines.push("and the NEEDLE is on the last line");
    return `${lines.join("\n")}\n`;
  }

  test("a file over the worker's input limit is searched to its end, and so are the files after it", async () => {
    // 0.7.1 before this fix sent each file to the worker whole: this one
    // came back input-too-large and ENDED the scan, so neither it nor
    // src/main.ts was searched ("no matches in the lines searched").
    await writeFile(path.join(tmp, "app.log"), bigLog());
    expect(readFileSync(path.join(tmp, "app.log"), "utf8").length).toBeGreaterThan(1_000_000);
    await mkdir(path.join(tmp, "src"));
    await writeFile(path.join(tmp, "src", "main.ts"), "export const x = 'NEEDLE';\n");
    const result = String(await grep.execute({ pattern: "NEEDLE" }));
    expect(result.split("\n").sort()).toEqual(
      [
        "app.log:2:the NEEDLE is on line 2",
        "app.log:24001:and the NEEDLE is on the last line",
        "src/main.ts:1:export const x = 'NEEDLE';",
      ].sort(),
    );
  });

  test("with no literal to pre-filter on, every line goes to the worker, in batches", async () => {
    // [N][E]… names no plain character, so no line is skipped before the
    // worker: the 1.2 M characters cross it in more than one batch.
    await writeFile(path.join(tmp, "app.log"), bigLog());
    await writeFile(path.join(tmp, "z.txt"), "NEEDLE\n");
    const result = String(await grep.execute({ pattern: "[N][E][E][D][L][E]" }));
    expect(result.split("\n").sort()).toEqual(
      [
        "app.log:2:the NEEDLE is on line 2",
        "app.log:24001:and the NEEDLE is on the last line",
        "z.txt:1:NEEDLE",
      ].sort(),
    );
  });

  test("a hit past a batch boundary keeps its own file and line number", async () => {
    await writeFile(path.join(tmp, "a.txt"), `${"filler line\n".repeat(90_000)}NEEDLE a\n`);
    await writeFile(path.join(tmp, "b.txt"), "NEEDLE b\n");
    const lines = String(await grep.execute({ pattern: "[N]EEDLE" })).split("\n");
    expect(lines).toHaveLength(2);
    expect(new Set(lines)).toEqual(new Set(["a.txt:90001:NEEDLE a", "b.txt:1:NEEDLE b"]));
  });
  test("a batch the worker refuses is named as unsearched, and the scan goes on", async () => {
    // Unreachable with the real limits (the batch size IS the worker's
    // limit); held apart here to prove a refusal never ends the scan.
    // Line 1 fills a batch the worker refuses; line 2 is the next batch.
    await writeFile(path.join(tmp, "f.txt"), `${"x".repeat(45)}\nNEEDLE\n`);
    _setGrepLimitsForTest({ batchChars: 50, workerInputChars: 30 });
    const result = String(await grep.execute({ pattern: "[N]EEDLE|x" }));
    expect(result.split("\n")[0]).toBe("f.txt:2:NEEDLE");
    expect(result).toContain("[grep: 1 line(s) were not searched: the input is 46 characters");
    expect(result).not.toContain("scan stopped early");
  });
});

describe("Grep keeps 0.7.0's pace with no literal to pre-filter on (0.7.1 review)", () => {
  /*
   * 0.7.1 before its review fix took 3-4x 0.7.0's time on a 58 MB source
   * tree (5-7x on a tree of short lines), for two reasons: it waited for
   * each batch's answer before reading the next, and it sent each batch as
   * an array of strings, copied one string at a time. This used to be proved
   * by timing Grep against an in-thread loop, best of up to twelve rounds,
   * within 4x. That is a race between two clocks under whatever else the
   * machine is doing: on CI's loaded ubuntu runner it measured 4.2x and
   * failed (run 36662602185), and it failed the local full suite too. So
   * each cause is now pinned by counting what Grep does instead.
   */

  /** `files` files of `lines` source-like lines; returns the lines written. */
  async function sourceTree(dir: string, files: number, lines: number): Promise<number> {
    await mkdir(dir);
    for (let f = 0; f < files; f++) {
      const body: string[] = [];
      for (let i = 0; i < lines; i++) {
        const n = f * lines + i;
        body.push(
          `    const value${n % 89} = someFunction(argumentNumber${n % 97}, "text ${n}"); // note`,
        );
      }
      await writeFile(path.join(dir, `f${f}.ts`), `${body.join("\n")}\n`);
    }
    return files * lines;
  }

  /** A session that runs the real worker and hands each testEach request to `seen` first. */
  function recordingSession(
    seen: (request: RegexRequest) => void,
    hold?: () => Promise<void>,
  ): RegexSession {
    const real = openRegexSession();
    return {
      async run<R extends RegexRequest>(request: R): Promise<RegexOutcome<ResultOf<R>>> {
        if (request.op === "testEach") seen(request);
        const outcome = await real.run(request);
        if (request.op === "testEach" && hold !== undefined) await hold();
        return outcome;
      },
      close: () => real.close(),
    };
  }

  test("every line goes to the worker as one string per batch, and each batch is filled", async () => {
    const dir = path.join(tmp, "src");
    const total = await sourceTree(dir, 12, 400);
    const batchChars = 50_000;
    const sent: { lines: unknown; chars: number; count: number }[] = [];
    _setGrepLimitsForTest({
      batchChars,
      workerInputChars: batchChars,
      openSession: () =>
        recordingSession((request) => {
          const inputs = (request as { inputs: { lines?: unknown } }).inputs;
          const text = typeof inputs.lines === "string" ? inputs.lines : "";
          sent.push({ lines: inputs.lines, chars: text.length, count: text.split("\n").length });
        }),
    });
    const result = String(await grep.execute({ pattern: "[0-9a-f]{40}", path: "src" }));
    expect(result).toBe("no matches");
    // One string crosses to the worker per batch, never an array of lines.
    expect(sent.map((b) => typeof b.lines)).toEqual(sent.map(() => "string"));
    // Every line was sent, once (each file's text ends in a newline, and
    // the empty line after it is sent too, as 0.7.0's split sent it).
    expect(sent.reduce((n, b) => n + b.count, 0)).toBe(total + 12);
    // Batches are filled to the limit, not cut per file: all but the last
    // hold within one line of batchChars (the files are ~34 KB each).
    const longest = 90;
    expect(sent.length).toBeGreaterThanOrEqual(5);
    for (const b of sent.slice(0, -1)) expect(b.chars).toBeGreaterThan(batchChars - 2 * longest);
  }, 20_000);

  test("the next batch is read while the one before it is in the worker", async () => {
    // A batch holds more than a file, so between sending batch k and needing
    // its answer (when batch k+1 is full) the scan crosses into another
    // file, and asks the clock there, as it does before each file. The
    // session holds each answer until the scan has done that, or until
    // 10 000 event-loop turns have passed without it — which is what
    // happens if the scan waits for each answer before reading on.
    const dir = path.join(tmp, "src");
    await sourceTree(dir, 6, 400);
    let clockReads = 0;
    let readsAtSend = 0;
    const overlapped: boolean[] = [];
    _setGrepLimitsForTest({
      deadlineMs: 120_000,
      now: () => {
        clockReads++;
        return Date.now();
      },
      batchChars: 40_000,
      workerInputChars: 40_000,
      openSession: () =>
        recordingSession(
          () => {
            readsAtSend = clockReads;
          },
          async () => {
            const at = readsAtSend;
            for (let turn = 0; turn < 10_000 && clockReads === at; turn++) {
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
            overlapped.push(clockReads > at);
          },
        ),
    });
    const result = String(await grep.execute({ pattern: "[0-9a-f]{40}", path: "src" }));
    expect(result).toBe("no matches");
    // Five batches of 40 000 over six files of about 32 000.
    expect(overlapped.length).toBeGreaterThanOrEqual(5);
    // The last two have no file after them to read (the scan has ended by
    // then); every batch before them overlapped the next file's read.
    expect(overlapped.slice(0, -2)).toEqual(overlapped.slice(0, -2).map(() => true));
  }, 20_000);
});

describe("Grep bounds the work an abandoned regex worker is left with (0.7.1 review)", () => {
  test("a line a chained pattern could take minutes on is named, and leaves no worker spinning", async () => {
    // Six repeats that can split one run of word characters: on the
    // 9 000-character line that is C(9 006, 6) ways from each of 9 000
    // places. 0.7.1 first ran it and left two workers spinning for minutes
    // (the session's next Grep answered "busy"), then refused the pattern
    // outright. Now the line is not run, and the short one is.
    await writeFile(path.join(tmp, "a.txt"), `${"a".repeat(9_000)} zzz\nab!\n`);
    await writeFile(path.join(tmp, "b.txt"), "has NEEDLE\n");
    const ctx = { runContext: { sessionId: "grep-runaway" } } as never;
    const before = regexWorkerCounts().runaway;
    for (let i = 0; i < 2; i++) {
      const result = String(await grep.execute({ pattern: "\\w*\\w*\\w*\\w*\\w*\\w*!|zzz" }, ctx));
      expect(result.split("\n")[0]).toBe("a.txt:2:ab!");
      expect(result).toContain(
        "[grep: 1 line(s) longer than 64 characters were not searched — this pattern has 6 repeats or optional parts that can split the same text one after another, and these lines give them too many ways to do it",
      );
    }
    expect(regexWorkerCounts().runaway).toBe(before);
    expect(String(await grep.execute({ pattern: "NEEDLE" }, ctx))).toBe("b.txt:1:has NEEDLE");
  });

  test("a chained pattern runs on a long line where it has few ways to split it", async () => {
    // `z\w*\w*!` can begin only at a `z`: on a 6 000-character line with
    // one, its two repeats split the rest some 18 million ways, about
    // 20 ms. From every place on a line of word characters, `\w*\w*!`
    // would take minutes, so that line is not run. Line 1 is a no-match
    // that takes real time, so the give-up threshold and the deadline are
    // raised: a loaded machine must not turn "run" into "gave up".
    _setGrepLimitsForTest({ giveUpMs: 30_000, deadlineMs: 60_000 });
    await writeFile(
      path.join(tmp, "f.txt"),
      `z${"a".repeat(6_000)}\nzab!\nz${"a".repeat(2_500)}!\n`,
    );
    expect(String(await grep.execute({ pattern: "z\\w*\\w*!" }))).toBe(
      `f.txt:2:zab!\nf.txt:3:z${"a".repeat(2_500)}!`,
    );
    await writeFile(path.join(tmp, "f.txt"), `${"a".repeat(2_500)}!?\nab!\n`);
    const unanchored = String(await grep.execute({ pattern: "\\w*\\w*!\\?|q" }));
    expect(unanchored.split("\n")[0]).toBe("no matches in the lines searched");
    expect(unanchored).toContain(
      "[grep: 1 line(s) longer than 2000 characters were not searched — this pattern has 2 repeats",
    );
  });

  test("a chain with a character between its repeats runs on a long line holding few of it", async () => {
    // 0.7.1 before this refused `^.*:.*:.*:.*$` outright (four repeats)
    // and ran `<h2.*>.*</h2>` only on lines up to 2 000 characters; 0.7.0
    // answered both on these lines in milliseconds.
    const log = `2026-09-26 12:34:56 INFO server: listening on :8080 ${"x".repeat(5_000)}`;
    const html = `<ul>${"<li>item</li>".repeat(400)}</ul><h2 class="t">Title</h2>`;
    const colons = ":".repeat(3_000);
    await writeFile(path.join(tmp, "app.log"), `${log}\n${colons}\n`);
    await writeFile(path.join(tmp, "page.html"), `${html}\n`);
    const logHits = String(await grep.execute({ pattern: "^.*:.*:.*:.*$" }));
    expect(logHits.split("\n")[0]).toBe(`app.log:1:${log}`);
    // A line of nothing but colons splits billions of ways: named, not run.
    expect(logHits).toContain(
      "[grep: 1 line(s) longer than 420 characters were not searched — this pattern has 4 repeats",
    );
    expect(String(await grep.execute({ pattern: "<h2.*>.*</h2>" }))).toBe(`page.html:1:${html}`);
    expect(String(await grep.execute({ pattern: ".*/.*/.*/.*\\.ts", path: "." }))).toBe(
      "no matches",
    );
  });

  test("a line without the pattern's literal is a definite miss, however long", async () => {
    // Decided by the pre-filter: no worker, no "not searched" note.
    await writeFile(path.join(tmp, "min.js"), `${"x".repeat(50_000)}\nneedle here\n`);
    expect(String(await grep.execute({ pattern: "needle" }))).toBe("min.js:2:needle here");
  });

  test("the line cap follows the chain and whether every alternative is anchored", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((c) => staticLineCap(c, false))).toEqual([
      10_000, 10_000, 2_000, 420, 171, 95, 64,
    ]);
    // Anchored, a match attempt begins at one place, not at every one.
    expect([2, 3, 4, 5].map((c) => staticLineCap(c, true))).toEqual([10_000, 2_000, 420, 171]);
    expect(lineBudgetOf("^.*:.*:.*:.*$").lineCap).toBe(420);
    expect(lineBudgetOf("^a.*b.*c|x.*y.*z").lineCap).toBe(2_000);
    expect(lineBudgetOf("^a.*b.*c|^x.*y.*z").lineCap).toBe(10_000);
    expect(lineBudgetOf("a.*b.*c.*d").lineCap).toBe(420);
    // A chain is never refused, however long: its cap only shrinks.
    expect(lineBudgetOf(`${"a*".repeat(40)}!`).lineCap).toBeGreaterThan(0);
  });

  test.each([
    // pattern, a line it may run on, a line of the same length it may not
    ["^.*:.*:.*:.*$", `a:b:c:${"x".repeat(4_000)}`, ":".repeat(4_006)],
    [".*,.*,.*,.*,x", `${"f,".repeat(10)}${"v".repeat(200)}`, ",".repeat(220)],
    ["<h2.*>.*</h2>", `<h2>${"<p>t</p>".repeat(750)}`, "<h2>".repeat(1_501)],
    ["\\b\\d+.\\d+.\\d+.\\d+\\b", `ip 10.0.0.1 ${"z".repeat(600)}`, "1".repeat(612)],
  ] as const)("%p runs on a long line only where it splits few ways", (pattern, cheap, costly) => {
    const budget = lineBudgetOf(pattern);
    expect(cheap.length).toBeGreaterThan(budget.lineCap);
    expect(costly.length).toBe(cheap.length);
    expect(budget.admits?.(cheap)).toBe(true);
    expect(budget.admits?.(costly)).toBe(false);
  });

  test("a set it cannot count exactly is taken to be every character", () => {
    // `\s` holds non-ASCII spaces: every character of a run `\s+` can take
    // counts as a place it can hand over, so a long run of them is not run.
    expect(lineBudgetOf("\\s+x?\\s+!").admits?.(" ".repeat(5_000))).toBe(false);
    // A chain between two classes of CJK: not ASCII, so the same.
    const cjk = lineBudgetOf("[\\u4e00-\\u9fff]+[\\u4e00-\\u9fff]+!");
    expect(cjk.admits?.("\u4e2d".repeat(5_000))).toBe(false);
  });

  test("a line is costed run by run: an attempt never reads past what the pattern can take", () => {
    // `\S+@\S+\.\S+` cannot take a space, so a match attempt stays inside
    // one word: prose with many addresses splits few ways in each. Costed as
    // one run, the line was not searched (0.7.1 first: 316 of 704 hits on a
    // site's built HTML; now all 704).
    const budget = lineBudgetOf("\\S+@\\S+\\.\\S+");
    const prose = "mail a@b.io or c.d@e.org now ".repeat(200);
    const word = "a@b.io".repeat(prose.length / 6 + 1).slice(0, prose.length);
    expect(prose.length).toBeGreaterThan(budget.lineCap);
    expect(budget.admits?.(prose)).toBe(true);
    expect(budget.admits?.(word)).toBe(false);
    // The same holds where the pattern's own sets are not all ASCII.
    expect(lineBudgetOf("\\s+x?\\s+!").admits?.("word ".repeat(1_000))).toBe(true);
    // A pattern that can take any character has one run: the whole line.
    expect(lineBudgetOf(".*@.*\\..*!").admits?.(prose)).toBe(false);
  });

  test("a line where a lookahead's search could begin anywhere is not run past the cap", () => {
    // The lookahead is tried at every place before `x` is, and on a line of
    // word characters each try splits the rest three ways (600 characters
    // took 6.6 s). 0.7.1's first count read the pattern as beginning only at
    // an `x`, found none, and ran a 5 000-character line (hours).
    const budget = lineBudgetOf("(?=\\w*\\w*\\w*!)x");
    const line = "a".repeat(5_000);
    expect(budget).toMatchObject({ chain: 3, lineCap: 420 });
    expect(budget.admits?.(line) ?? false).toBe(false);
    // A lookaround with no choice inside is a few steps wherever it is tried.
    expect(lineBudgetOf("(?!\\d)z\\w*\\w*!").admits?.(`z${"a".repeat(5_000)}`)).toBe(true);
  });

  test("a run between two repeats is counted by where it occurs, not by its first character", () => {
    // `.*` can stop before any `foo`: a line of `foo` splits a thousand
    // ways, one with a couple of them only a few.
    const budget = lineBudgetOf(".*foo.*bar");
    const cheap = `${"f".repeat(300)} foo ${"x".repeat(2_000)} foo ${"f".repeat(691)}`;
    const costly = "foo".repeat(1_000).padEnd(cheap.length, "x");
    expect(cheap.length).toBe(costly.length);
    expect(cheap.length).toBeGreaterThan(budget.lineCap);
    expect(budget.admits?.(cheap)).toBe(true);
    expect(budget.admits?.(costly)).toBe(false);
  });

  test("a longer line is run only within a tenth of the budget, counted per chain step", () => {
    // `^.*:.*:.*:.*$` begins once and hands over at a `:`: on a 5 000-
    // character line with k colons that is C(k + 3, 3) splits × 5 001 × 4
    // steps against a tenth of C(2 003, 3), so 32 colons pass and 33 do not.
    // A tenth, because a no-match slower than the worker's 100 ms give-up
    // is undetermined anyway: running the line would only spend the deadline.
    const budget = lineBudgetOf("^.*:.*:.*:.*$");
    const line = (colons: number): string => ":".repeat(colons).padEnd(5_000, "x");
    expect(budget.admits?.(line(32))).toBe(true);
    expect(budget.admits?.(line(33))).toBe(false);
    // Where no match can begin at all, nothing is costly: `<h2` never occurs.
    expect(lineBudgetOf("<h2.*>.*</h2>").admits?.(">".repeat(5_000))).toBe(true);
  });

  test("a pattern with a lookbehind gets a shorter line, as the engine runs it slower", () => {
    // JavaScriptCore runs a lookbehind pattern in its interpreter: 5.5
    // times as long a step as `\w*\w*\w*!` on the same line.
    expect(staticLineCap(2, false, 8)).toBeLessThan(staticLineCap(2, false));
    expect(lineBudgetOf("(?<=b)\\w*\\w*!").lineCap).toBe(staticLineCap(2, false, 8));
    expect(lineBudgetOf("(?=b)\\w*\\w*!").lineCap).toBe(staticLineCap(2, false));
  });

  test("a run of repeats split by a repeated pair of characters is bounded like any chain", async () => {
    // 0.7.1's first count linked two repeats only through ONE character
    // every element between them could take, so `.*ab.*ab.*x` was no chain
    // at all and ran on lines up to 10 000 characters: 13 s on 1 000
    // characters of `abab…`, hours on 10 000. The line is now named.
    await writeFile(path.join(tmp, "f.txt"), `${"ab".repeat(500)}\nab ab x\n`);
    const ctx = { runContext: { sessionId: "grep-separator-chain" } } as never;
    const before = regexWorkerCounts().runaway;
    const result = String(await grep.execute({ pattern: ".*ab.*ab.*x" }, ctx));
    expect(result.split("\n")[0]).toBe("f.txt:2:ab ab x");
    expect(result).toContain(
      "[grep: 1 line(s) longer than 420 characters were not searched — this pattern has 3 repeats",
    );
    expect(regexWorkerCounts().runaway).toBe(before);
  });
});

describe("repeatChainLength", () => {
  test.each([
    ["TODO", 0],
    ["foo.*bar", 1],
    [".*foo.*", 1],
    ["\\w+\\s+\\w+!", 1],
    ["\\s+$", 1],
    ["TODO.*:.*", 1],
    [".*.*", 0],
    ["\\d+\\.\\d+", 1],
    ["(foo|bar).*baz", 1],
    ["[A-Z][a-z]+[A-Z][a-z]+", 1],
    ["(\\w+)\\s+\\1", 1],
    ["(?=.*a)(?=.*b).*c", 1],
    // A lookaround is atomic: nothing after its own end can fail inside it.
    ["(?=\\w+\\s*\\w+)x", 1],
    [".*a.*!", 2],
    ["\\w+\\s*\\w+!", 2],
    ["\\w*a\\w*!", 2],
    ["(\\w*)(\\w*)!", 2],
    ["(?:\\w*)?\\w*!", 2],
    ["x{0,100}x{0,100}!", 2],
    ["it\\(.*,.*\\)", 2],
    // A plain group is its contents: "a-b" breaks the link, as it would unwrapped.
    ["\\w*(a-b)\\w*!", 1],
    ["(?:\\s*\\w+){2}!", 2],
    // A character outside the fixed sample is compared through the pattern's own.
    ["\u1234+\u1234+!", 2],
    ["\u1234+\u1235+!", 1],
    ["a.*b.*c.*d", 3],
    ["\\d+\\d+\\d+x", 3],
    ["\\w*\\w*\\w*\\w*\\w*\\w*!|zzz", 6],
    // Two repeats link across a run of several characters when each is one
    // both can take: `.*` can stop before any `foo` (0.7.1 counted one).
    [".*foo.*bar", 2],
    [".*ab.*ab.*x", 3],
    ["\\w*foo-\\w*!", 1],
    // `:` is one `[a-z:]*` can take but `[a-z]*` cannot: the split is fixed.
    ["[a-z:]*:[a-z]*!", 1],
    // A bounded repeat is a choice point too.
    ["\\w{0,30}\\w{0,30}\\w{0,30}!", 3],
    ["a?a?a?aaa!", 3],
    ["\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}", 1],
    ["colou?r", 1],
    // So is an alternation whose branches can begin alike, and only that.
    ["(?:a|ab)(?:b|bc)x", 2],
    ["(?:a|ab)(?:c|bc)x", 1],
    ["(?:a|a)(?:a|a)(?:a|a)!", 3],
    ["(foo|bar)(baz|qux)!", 0],
    // A lookaround re-run after each choice before it ends a chain.
    ["a+(?=[^:]+x)", 2],
    ["(?=\\w*\\w*\\w*!)x", 3],
    // A backreference compares the capture's length after each choice.
    ["(a+)\\1x", 2],
    ["(?<n>a+)\\k<n>x", 2],
    ["(ab)\\1x", 0],
  ] as const)("%p has chain %p", (pattern, chain) => {
    expect(repeatChainLength(pattern)).toBe(chain);
  });

  test("a chain that nothing after it can fail is not counted", () => {
    expect(repeatChainLength("\\w+\\s*\\w+")).toBe(1);
    expect(repeatChainLength("\\w+\\s*\\w+$")).toBe(2);
  });

  test("a 1 000-character pattern is analysed in bounded time", () => {
    const started = performance.now();
    expect(repeatChainLength(`${"a*".repeat(499)}!`)).toBe(499);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("requiredLiterals (Grep's pre-filter)", () => {
  test.each([
    ["TODO|FIXME", ["TODO", "FIXME"]],
    ["foo.*bar", ["foo"]],
    ["\\w+Error", ["Error"]],
    ["^import", ["import"]],
    ["ab+c", ["a"]],
    ["(foo|bar)baz", ["baz"]],
    ["x\\.y", ["x.y"]],
    ["a{2}b", ["b"]],
    ["\\u0041BC", ["ABC"]],
    ["\\cAb", ["b"]],
    ["\\012z", ["z"]],
  ] as const)("%p requires one of %p", (pattern, literals) => {
    expect(requiredLiterals(pattern)).toEqual([...literals]);
  });

  test.each([
    "\\d+",
    "a|",
    "[N][E]",
    "(TODO)",
    `${Array.from({ length: 9 }, (_, i) => `w${i}`).join("|")}`,
  ])("%p gets no filter", (pattern) => {
    expect(requiredLiterals(pattern)).toBeUndefined();
  });

  test("never claims a literal a real match lacks (generated patterns against the engine)", () => {
    // xorshift, seeded: the same patterns on every run.
    let seed = 0x2545f491;
    const rnd = (n: number): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    const atoms = [
      "a",
      "b",
      "ab",
      "\\.",
      ".",
      "\\d",
      "\\w",
      "[ab]",
      "[^a]",
      "(a|b)",
      "(?:ab)",
      "\\b",
      "^",
      "$",
      "\\1",
      "\\x61",
      "\\u0062",
      "\\t",
      "(?=a)",
      "(?!b)",
      "\\k<n>",
      "\\01",
      "\\c",
      "\\cA",
      "\\ca",
      "{",
      "}",
      "]",
      "-",
      " ",
      "\\-",
      "(?<n>a)",
      "\\k",
      "\\u{41}",
      "\\p{L}",
      "\\x6",
      "\\c1",
      "\\08",
      "\\18",
      "\\_",
      "é",
      "u",
      "A",
      "p",
      "{L}",
      "8",
      "[\\]a]",
      "[]a",
      "[^]",
    ];
    const quantifiers = ["", "", "", "*", "+", "?", "{2}", "{1,}", "{0,2}", "*?", "+?"];
    const alphabet = "abc.1 \t-{}]\u0001<>nkb\\uApLé8_AA";
    let filtered = 0;
    let checked = 0;
    for (let p = 0; p < 16_000; p++) {
      let pattern = "";
      const n = 1 + rnd(6);
      for (let i = 0; i < n; i++) {
        pattern += `${atoms[rnd(atoms.length)]}${quantifiers[rnd(quantifiers.length)]}`;
        if (rnd(20) === 0) pattern += "|";
      }
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        continue;
      }
      const literals = requiredLiterals(pattern);
      if (literals === undefined) continue;
      filtered++;
      for (let l = 0; l < 60; l++) {
        let line = "";
        for (let k = rnd(12); k > 0; k--) line += alphabet[rnd(alphabet.length)];
        if (!re.test(line)) continue;
        checked++;
        if (!literals.some((lit) => line.includes(lit))) {
          throw new Error(
            `${JSON.stringify(pattern)} matched ${JSON.stringify(line)} without ${JSON.stringify(literals)}`,
          );
        }
      }
    }
    // The battery really exercised the filter.
    expect(filtered).toBeGreaterThan(3_000);
    expect(checked).toBeGreaterThan(3_000);
  });
});

describe("allFsTools export", () => {
  test("contains all five tools in declared order", () => {
    expect(allFsTools.map((t) => t.name)).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
  });
});
