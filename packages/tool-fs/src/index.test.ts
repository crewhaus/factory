import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  DEFAULT_IGNORED_DIRS,
  ToolPermissionError,
  _setGrepLimitsForTest,
  allFsTools,
  edit,
  glob,
  grep,
  hasNestedQuantifier,
  read,
  write,
} from "./index";

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(path.join(tmpdir(), "tool-fs-"));
  process.chdir(tmp);
});

afterEach(() => {
  _setGrepLimitsForTest(undefined);
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
    const slow = "1".repeat(70);
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
    // Cubic in the line length: about 20 ms a line here, so forty of them
    // outlast a 100 ms deadline many times over, and the worker abandoned
    // at the deadline finishes its line within milliseconds.
    const slow = "1".repeat(100);
    await writeFile(path.join(tmp, "a.txt"), `1x\n${Array(40).fill(slow).join("\n")}\n`);
    _setGrepLimitsForTest({ deadlineMs: 100 });
    const result = String(await grep.execute({ pattern: "\\d+\\d+\\d+x" }));
    expect(result).toContain("scan stopped early — the 100 ms deadline passed");
    expect(result).not.toBe("no matches");
  }, 20_000);

  test("a line too long to search is named, not silently skipped", async () => {
    await writeFile(path.join(tmp, "min.js"), `short needle\n${"x".repeat(20_000)}needle\n`);
    const result = String(await grep.execute({ pattern: "needle" }));
    expect(result.split("\n")[0]).toBe("min.js:1:short needle");
    expect(result).toContain("1 line(s) longer than 10000 characters were not searched");
  });

  test("a file it could not read is counted, not taken as a miss", async () => {
    if (process.getuid?.() === 0) return; // root reads a mode-000 file anyway
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
  });

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

describe("allFsTools export", () => {
  test("contains all five tools in declared order", () => {
    expect(allFsTools.map((t) => t.name)).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
  });
});
