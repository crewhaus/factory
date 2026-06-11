import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  ToolPermissionError,
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

describe("allFsTools export", () => {
  test("contains all five tools in declared order", () => {
    expect(allFsTools.map((t) => t.name)).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
  });
});
