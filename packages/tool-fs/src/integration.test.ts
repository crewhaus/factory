/**
 * Integration test: wire ToolCatalog + buildTool + validateToolInput +
 * matchesPattern + executeTool around the real fs tools. Verifies the
 * path-traversal defense surfaces through executeTool's catch path with
 * isError:true and a permission-flavored message.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { allFsTools } from "./index";

let tmp: string;
let originalCwd: string;
let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(path.join(tmpdir(), "tool-fs-int-"));
  process.chdir(tmp);
  catalog = new ToolCatalog();
  for (const t of allFsTools) catalog.register(t);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("integration: tool-fs through executeTool", () => {
  test("Write → Read round-trips through the executor", async () => {
    const w = await executeTool(
      lookup("Write"),
      { path: "x.txt", content: "hi" },
      { toolUseId: "w1" },
    );
    expect(w.isError).toBe(false);

    const r = await executeTool(lookup("Read"), { path: "x.txt" }, { toolUseId: "r1" });
    expect(r.isError).toBe(false);
    expect(r.content).toBe("hi");
  });

  test("path traversal is caught and returned as isError", async () => {
    const result = await executeTool(
      lookup("Read"),
      { path: "../../../etc/passwd" },
      { toolUseId: "p1" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes the workspace root|rejected path/);
  });

  test("invalid input (missing path) is caught by validate before execute", async () => {
    const result = await executeTool(lookup("Read"), {}, { toolUseId: "v1" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Read");
  });

  test("permission pattern allowedPatterns:['Read'] rejects Write", async () => {
    const result = await executeTool(
      lookup("Write"),
      { path: "x.txt", content: "y" },
      { toolUseId: "perm1", allowedPatterns: ["Read"] },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not permitted");
  });

  test("permission pattern allowedPatterns:['Read'] permits Read", async () => {
    await writeFile(path.join(tmp, "ok.txt"), "ok");
    const result = await executeTool(
      lookup("Read"),
      { path: "ok.txt" },
      { toolUseId: "perm2", allowedPatterns: ["Read"] },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("Edit non-unique error surfaces through executeTool as isError", async () => {
    await writeFile(path.join(tmp, "f.txt"), "ab ab");
    const result = await executeTool(
      lookup("Edit"),
      { path: "f.txt", oldString: "ab", newString: "cd" },
      { toolUseId: "e1" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("2 times");
  });

  test("Glob output flows through executeTool", async () => {
    await writeFile(path.join(tmp, "a.md"), "");
    await writeFile(path.join(tmp, "b.md"), "");
    const result = await executeTool(lookup("Glob"), { pattern: "*.md" }, { toolUseId: "g1" });
    expect(result.isError).toBe(false);
    if (typeof result.content !== "string") throw new Error("expected string content");
    expect(result.content.split("\n").sort()).toEqual(["a.md", "b.md"]);
  });
});

// Regression — issue #149 (CWE-59). The lexical check blocks `../` escapes,
// but an in-root symlink whose target is outside the workspace also escapes.
// These plant such symlinks and assert every path-taking tool rejects them.
describe("integration: tool-fs symlink containment (#149)", () => {
  test("Read through an in-root symlink to an out-of-root file is rejected", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "tool-fs-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "TOPSECRET");
      symlinkSync(path.join(outside, "secret.txt"), path.join(tmp, "link.txt"));
      const r = await executeTool(lookup("Read"), { path: "link.txt" }, { toolUseId: "sl1" });
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/escapes the workspace root|rejected path/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("Write through an in-root symlinked directory to outside is rejected", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "tool-fs-outside-"));
    try {
      symlinkSync(outside, path.join(tmp, "escape"));
      const w = await executeTool(
        lookup("Write"),
        { path: "escape/evil.txt", content: "x" },
        { toolUseId: "sl2" },
      );
      expect(w.isError).toBe(true);
      expect(w.content).toMatch(/escapes the workspace root|rejected path/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("Edit through an in-root symlink to an out-of-root file is rejected", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "tool-fs-outside-"));
    try {
      await writeFile(path.join(outside, "target.txt"), "aaa");
      symlinkSync(path.join(outside, "target.txt"), path.join(tmp, "elink.txt"));
      const r = await executeTool(
        lookup("Edit"),
        { path: "elink.txt", oldString: "aaa", newString: "bbb" },
        { toolUseId: "sl3" },
      );
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/escapes the workspace root|rejected path/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("Grep with a base path that escapes via symlink is rejected", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "tool-fs-outside-"));
    try {
      await writeFile(path.join(outside, "f.txt"), "needle");
      symlinkSync(outside, path.join(tmp, "glink"));
      const r = await executeTool(
        lookup("Grep"),
        { pattern: "needle", path: "glink" },
        { toolUseId: "sl4" },
      );
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/escapes the workspace root|rejected path/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an in-root symlink to an in-root file still works (no over-blocking)", async () => {
    await writeFile(path.join(tmp, "real.txt"), "hello");
    symlinkSync(path.join(tmp, "real.txt"), path.join(tmp, "good-link.txt"));
    const r = await executeTool(lookup("Read"), { path: "good-link.txt" }, { toolUseId: "sl5" });
    expect(r.isError).toBe(false);
    expect(r.content).toBe("hello");
  });
});

// Regression — the DANGLING-symlink variant of #149. `existsSync` follows
// symlinks, so a link whose target is missing answers false: a containment
// check that probes with it walks straight past the link, treats it as a
// plain missing leaf, and re-appends the name to the realpath'd parent, so
// the check passes. `open(…, "w")` then follows the link and creates the
// target OUTSIDE the workspace. Probing with `lstat` instead — a dangling
// link is a NAME that exists — keeps the link in the resolved part of the
// path, where one `readlink` hop shows where the write would really land.
describe("integration: tool-fs dangling-symlink containment", () => {
  // One attempt per writing tool, each aimed at the symlink it is handed.
  const writeAttempts: ReadonlyArray<[string, (link: string) => unknown]> = [
    ["Write", (link) => ({ path: link, content: "PWNED" })],
    ["Edit", (link) => ({ path: link, oldString: "aaa", newString: "PWNED" })],
  ];

  test("the attempts below cover every writing tool in the package", () => {
    const writers = allFsTools
      .filter((t) => t.destructive)
      .map((t) => t.name)
      .sort();
    expect(writeAttempts.map(([name]) => name).sort()).toEqual(writers);
  });

  test("every writing tool refuses a dangling symlink pointing outside", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "tool-fs-outside-"));
    try {
      for (const [name, makeInput] of writeAttempts) {
        const target = path.join(outside, `pwned-${name}.txt`);
        const link = `dangling-${name}.txt`;
        symlinkSync(target, path.join(tmp, link));
        const r = await executeTool(lookup(name), makeInput(link), { toolUseId: `dang-${name}` });
        // Refused as a containment failure, not as an incidental ENOENT.
        expect({ tool: name, isError: r.isError }).toEqual({ tool: name, isError: true });
        expect(String(r.content)).toMatch(/escapes the workspace root/);
        // Nothing was created outside, and the link itself was left alone —
        // before the fix, Write's rename replaced the link with a real file.
        expect({ tool: name, escaped: existsSync(target) }).toEqual({ tool: name, escaped: false });
        const stillLink = lstatSync(path.join(tmp, link)).isSymbolicLink();
        expect({ tool: name, stillLink }).toEqual({ tool: name, stillLink: true });
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a dangling symlink that stays inside the workspace is still honoured", async () => {
    // The mirror of the test above: refusing every dangling link would also
    // "pass" it, so check that an in-workspace one is written THROUGH to the
    // target it names, rather than refused or overwritten as a plain file.
    mkdirSync(path.join(tmp, "sub"));
    const realTarget = path.join(tmp, "sub", "made.txt");
    symlinkSync(realTarget, path.join(tmp, "inside.txt"));

    const w = await executeTool(
      lookup("Write"),
      { path: "inside.txt", content: "aaa" },
      { toolUseId: "in1" },
    );
    expect(w.isError).toBe(false);
    expect(readFileSync(realTarget, "utf8")).toBe("aaa");
    expect(lstatSync(path.join(tmp, "inside.txt")).isSymbolicLink()).toBe(true);

    // And the link, no longer dangling, still works for the next tool.
    const e = await executeTool(
      lookup("Edit"),
      { path: "inside.txt", oldString: "aaa", newString: "bbb" },
      { toolUseId: "in2" },
    );
    expect(e.isError).toBe(false);
    expect(readFileSync(realTarget, "utf8")).toBe("bbb");
  });

  test("a dangling symlinked DIRECTORY pointing outside is refused", async () => {
    // The escape does not need the leaf to be the link: a link standing in
    // for a directory that does not exist yet is walked past the same way,
    // and Bun.write creates missing parents on the way to the target.
    const outside = mkdtempSync(path.join(tmpdir(), "tool-fs-outside-"));
    try {
      const missing = path.join(outside, "made-by-write");
      symlinkSync(missing, path.join(tmp, "dlink"));
      const r = await executeTool(
        lookup("Write"),
        { path: "dlink/evil.txt", content: "PWNED" },
        { toolUseId: "dang-dir" },
      );
      expect(r.isError).toBe(true);
      expect(String(r.content)).toMatch(/escapes the workspace root/);
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// Regression — a RELATIVE symlink target must be resolved against the
// directory that actually CONTAINS the link, not the link's lexical parent.
// The two differ exactly when that parent is itself reached through a
// symlink, and following one `readlink` hop is what first makes the
// difference reachable: the leaf now stays in the RESOLVED part of the path,
// so measuring it from the wrong directory names a location the caller's
// path does not lead to.
describe("integration: tool-fs relative dangling-link base", () => {
  test("an outward directory link holding a relative dangling link is refused", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "tool-fs-outside-"));
    try {
      mkdirSync(path.join(outside, "realdir"));
      // `pdir` leaves the workspace, so `l` really lives in <outside>/realdir
      // and "../escape.bin" truly lands at <outside>/escape.bin. Measured
      // from the LEXICAL parent <tmp>/pdir it reads as <tmp>/escape.bin — an
      // in-root path, which is how the wrong base turns a refusal into a
      // silent redirect.
      symlinkSync(path.join(outside, "realdir"), path.join(tmp, "pdir"));
      symlinkSync("../escape.bin", path.join(outside, "realdir", "l"));

      const r = await executeTool(
        lookup("Write"),
        { path: "pdir/l", content: "PWNED" },
        { toolUseId: "relbase" },
      );
      expect(r.isError).toBe(true);
      expect(String(r.content)).toMatch(/escapes the workspace root/);
      expect(existsSync(path.join(outside, "escape.bin"))).toBe(false);
      // Nor quietly redirected to the in-root path the lexical reading names.
      expect(existsSync(path.join(tmp, "escape.bin"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
