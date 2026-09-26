/**
 * CopyPath and MovePath write only inside the workspace: every destination
 * path, not just the destination root (security-11#0, flag-truth-6#0), and
 * every link from where the copy or move puts it (security-11#2).
 *
 * On 0.7.0 `buildPlan` joined each leaf onto the destination and checked it
 * only as text, then `mkdirSync`/`copyFileSync`/`rmSync` followed a
 * symlinked directory already sitting under the destination: a planted
 * `dst/sub -> ~/.ssh` received the source's bytes, and with `overwrite` an
 * outside file was deleted and replaced. dryRun listed only the in-workspace
 * spelling, so an approver saw nothing wrong.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { _setMoveRenameForTest, copyPath, movePath } from "./index";

const originalCwd = process.cwd();
/** The workspace's PARENT, so a link climbing out of the workspace has somewhere to land. */
let parent: string;
let ws: string;
let out: string;

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-copy-"));
  ws = path.join(parent, "ws");
  out = path.join(parent, "outside");
  mkdirSync(ws);
  mkdirSync(out);
  process.chdir(ws);
  write("src/sub/file.txt", "payload");
});

afterEach(() => {
  _setMoveRenameForTest(undefined);
  process.chdir(originalCwd);
  rmSync(parent, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const abs = path.join(ws, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

async function call(tool: RegisteredTool, input: unknown): Promise<string> {
  const result = await tool.execute(input);
  if (typeof result !== "string") throw new Error("expected a string result");
  return result;
}

describe("CopyPath never writes through a symlinked directory under its destination", () => {
  beforeEach(() => {
    mkdirSync(path.join(ws, "dst"));
    symlinkSync(out, path.join(ws, "dst/sub"));
  });

  test("the copy is refused, names the link, and nothing lands outside", async () => {
    const result = await call(copyPath, { source: "src", destination: "dst" });
    expect(result).not.toContain('"copied":true');
    expect(JSON.parse(result)).toMatchObject({ copied: false, code: "is-symlink" });
    expect(result).toContain('\\"dst/sub\\" is a symbolic link');
    expect(readdirSync(out)).toEqual([]);
  });

  test("with overwrite, an outside FILE keeps its bytes", async () => {
    writeFileSync(path.join(out, "file.txt"), "ORIGINAL");
    const result = await call(copyPath, { source: "src", destination: "dst", overwrite: true });
    expect(result).not.toContain('"copied":true');
    expect(readFileSync(path.join(out, "file.txt"), "utf8")).toBe("ORIGINAL");
  });

  test("with overwrite, an outside DIRECTORY where a file would go is not deleted", async () => {
    mkdirSync(path.join(out, "file.txt"));
    writeFileSync(path.join(out, "file.txt", "child"), "kept");
    const result = await call(copyPath, { source: "src", destination: "dst", overwrite: true });
    expect(result).not.toContain('"copied":true');
    expect(readFileSync(path.join(out, "file.txt", "child"), "utf8")).toBe("kept");
  });

  test("dryRun refuses the same way, and does not report whether an outside path exists", async () => {
    writeFileSync(path.join(out, "file.txt"), "ORIGINAL");
    const withFile = await call(copyPath, { source: "src", destination: "dst", dryRun: true });
    rmSync(path.join(out, "file.txt"));
    const without = await call(copyPath, { source: "src", destination: "dst", dryRun: true });
    expect(withFile).not.toContain("dst/sub/file.txt");
    expect(JSON.parse(withFile)).toMatchObject({ copied: false, code: "is-symlink" });
    // The same answer whether or not the outside file is there: no oracle.
    expect(withFile).toBe(without);
  });

  test("POLICY: a symlinked directory that stays inside the workspace is refused too", async () => {
    // The strict policy (GNU `cp -R` refuses to merge a directory into a
    // symlink too): a copy writes only into real directories under its
    // destination, so what a leaf's path leads to is what the plan checked.
    rmSync(path.join(ws, "dst/sub"));
    mkdirSync(path.join(ws, "real-sub"));
    symlinkSync("../real-sub", path.join(ws, "dst/sub"));
    const result = await call(copyPath, { source: "src", destination: "dst" });
    expect(JSON.parse(result)).toMatchObject({ copied: false, code: "is-symlink" });
    expect(existsSync(path.join(ws, "real-sub/file.txt"))).toBe(false);
  });
});

describe("a link is judged from where the copy or move puts it (C068 chain)", () => {
  beforeEach(() => {
    mkdirSync(path.join(ws, "a/b"), { recursive: true });
    // Inside the workspace where it is: a/b/../.. is the workspace root.
    symlinkSync("../..", path.join(ws, "a/b/up"));
  });

  test("copying a relative link one level up, where it would lead out, is refused", async () => {
    const first = await call(copyPath, { source: "a/b/up", destination: "dst2/sub" });
    expect(JSON.parse(first)).toMatchObject({ copied: false, code: "escapes-root" });
    expect(first).toContain("would lead outside the workspace once copied");
    expect(existsSync(path.join(ws, "dst2/sub"))).toBe(false);
    // So the second step of the chain has nothing to write through.
    const second = await call(copyPath, { source: "src", destination: "dst2" });
    expect(JSON.parse(second)).toMatchObject({ copied: true });
    expect(existsSync(path.join(parent, "file.txt"))).toBe(false);
    expect(readFileSync(path.join(ws, "dst2/sub/file.txt"), "utf8")).toBe("payload");
  });

  test("a tree whose relative link stays inside at the new depth still copies, byte for byte", async () => {
    write("tree/a.txt", "A");
    symlinkSync("a.txt", path.join(ws, "tree/alias"));
    const result = JSON.parse(await call(copyPath, { source: "tree", destination: "copy/tree" }));
    expect(result).toMatchObject({ copied: true, files: 1, symlinks: 1 });
    expect(lstatSync(path.join(ws, "copy/tree/alias")).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(ws, "copy/tree/alias"), "utf8")).toBe("A");
  });

  test("MovePath of a tree whose link escapes at the new depth is refused, dryRun included", async () => {
    mkdirSync(path.join(ws, "deep/x/y"), { recursive: true });
    // deep/x/y/../../.. is the workspace root; y/../../.. is two levels above it.
    symlinkSync("../../..", path.join(ws, "deep/x/y/up"));
    for (const dryRun of [true, false]) {
      const result = await call(movePath, { source: "deep/x/y", destination: "y", dryRun });
      expect(JSON.parse(result)).toMatchObject({ moved: false, code: "escapes-root" });
    }
    expect(lstatSync(path.join(ws, "deep/x/y/up")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(ws, "y"))).toBe(false);
  });
});

describe("the verifiers' C068 cases, as they wrote them", () => {
  beforeEach(() => {
    mkdirSync(path.join(ws, "src/d1/d2"), { recursive: true });
    write("src/target.txt", "inside");
    // Leads to src/target.txt where it sits; one level up from the root at depth 1.
    symlinkSync("../../target.txt", path.join(ws, "src/d1/d2/l"));
  });

  test("CopyPath of the directory to depth 1 is refused, dryRun included, and plants nothing", async () => {
    for (const dryRun of [true, false]) {
      const r = JSON.parse(
        await call(copyPath, { source: "src/d1/d2", destination: "dest2", dryRun }),
      );
      expect(r).toMatchObject({ copied: false, code: "escapes-root" });
    }
    expect(() => lstatSync(path.join(ws, "dest2/l"))).toThrow();
  });

  test("MovePath of the single link to depth 0 is refused, and the link stays where it was", async () => {
    const m = JSON.parse(await call(movePath, { source: "src/d1/d2/l", destination: "l" }));
    expect(m).toMatchObject({ moved: false, code: "escapes-root" });
    expect(lstatSync(path.join(ws, "src/d1/d2/l")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(ws, "l"))).toBe(false);
  });

  test("the same depth elsewhere still resolves inside, so it copies", async () => {
    mkdirSync(path.join(ws, "src/e1"));
    const r = JSON.parse(await call(copyPath, { source: "src/d1/d2", destination: "src/e1/e2" }));
    expect(r).toMatchObject({ copied: true, symlinks: 1 });
    expect(readFileSync(path.join(ws, "src/e1/e2/l"), "utf8")).toBe("inside");
  });
});

describe("a link that leads out exactly where it did adds no reach, so it copies and moves as on 0.7.0", () => {
  // A virtualenv's interpreter is an absolute link out of the workspace.
  beforeEach(() => {
    writeFileSync(path.join(out, "python3"), "#!interpreter\n");
    write("proj/main.py", "print(1)\n");
    mkdirSync(path.join(ws, "proj/.venv/bin"), { recursive: true });
    symlinkSync(path.join(out, "python3"), path.join(ws, "proj/.venv/bin/python"));
  });

  test("CopyPath copies the tree, keeps the link's text, and names it", async () => {
    const r = JSON.parse(await call(copyPath, { source: "proj", destination: "proj-copy" }));
    expect(r).toMatchObject({
      copied: true,
      files: 1,
      symlinks: 1,
      outsideLinks: ["proj-copy/.venv/bin/python"],
      outsideLinkCount: 1,
    });
    expect(r.outsideLinkNote).toContain("exactly where the originals do");
    expect(lstatSync(path.join(ws, "proj-copy/.venv/bin/python")).isSymbolicLink()).toBe(true);
    // The interpreter's bytes were never copied in.
    expect(readdirSync(path.join(ws, "proj-copy/.venv/bin"))).toEqual(["python"]);
  });

  test("MovePath renames the tree, dryRun first, and names the link both times", async () => {
    const dry = JSON.parse(
      await call(movePath, { source: "proj", destination: "apps/proj", dryRun: true }),
    );
    expect(dry).toMatchObject({ dryRun: true, outsideLinks: ["apps/proj/.venv/bin/python"] });
    mkdirSync(path.join(ws, "apps"));
    const moved = JSON.parse(await call(movePath, { source: "proj", destination: "apps/proj" }));
    expect(moved).toMatchObject({ moved: true, outsideLinks: ["apps/proj/.venv/bin/python"] });
    expect(existsSync(path.join(ws, "proj"))).toBe(false);
    expect(readFileSync(path.join(ws, "apps/proj/main.py"), "utf8")).toBe("print(1)\n");
  });

  test("across a filesystem boundary the fallback copy keeps it too", async () => {
    _setMoveRenameForTest(() => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    });
    const moved = JSON.parse(await call(movePath, { source: "proj", destination: "proj2" }));
    expect(moved).toMatchObject({ moved: true, outsideLinks: ["proj2/.venv/bin/python"] });
    expect(existsSync(path.join(ws, "proj"))).toBe(false);
    expect(lstatSync(path.join(ws, "proj2/.venv/bin/python")).isSymbolicLink()).toBe(true);
  });

  test("a relative link that already led out is refused where it would lead further out", async () => {
    // a/esc/up -> ../../.. leads to the workspace's parent; with a/esc moved
    // or copied to the root, it would lead one level above that.
    mkdirSync(path.join(ws, "a/esc"), { recursive: true });
    symlinkSync("../../..", path.join(ws, "a/esc/up"));
    for (const tool of [copyPath, movePath]) {
      const r = JSON.parse(await call(tool, { source: "a/esc", destination: "esc" }));
      expect(r).toMatchObject({ code: "escapes-root" });
      expect(r.reason).toContain('"a/esc/up"');
    }
    expect(lstatSync(path.join(ws, "a/esc/up")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(ws, "esc"))).toBe(false);
    // At the same depth elsewhere it leads exactly where it did: kept.
    mkdirSync(path.join(ws, "b"));
    const same = JSON.parse(await call(copyPath, { source: "a/esc", destination: "b/esc" }));
    expect(same).toMatchObject({ copied: true, outsideLinks: ["b/esc/up"] });
  });

  test("an ordinary copy reports no outside links at all", async () => {
    const r = JSON.parse(await call(copyPath, { source: "src", destination: "plain" }));
    expect(r.copied).toBe(true);
    expect("outsideLinks" in r).toBe(false);
  });
});

describe("the EXDEV fallback of MovePath is the contained copy, then the delete", () => {
  const exdev = (): void => {
    throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
  };

  test("an ordinary tree still moves, .git and links included", async () => {
    write("pkg/.git/HEAD", "ref: refs/heads/main\n");
    write("pkg/lib/a.txt", "A");
    symlinkSync("lib/a.txt", path.join(ws, "pkg/alias"));
    _setMoveRenameForTest(exdev);
    const result = JSON.parse(await call(movePath, { source: "pkg", destination: "moved/pkg" }));
    expect(result).toMatchObject({ moved: true });
    expect(existsSync(path.join(ws, "pkg"))).toBe(false);
    // 0.7.0's walk skipped .git, then the delete removed the only copy of it.
    expect(readFileSync(path.join(ws, "moved/pkg/.git/HEAD"), "utf8")).toBe(
      "ref: refs/heads/main\n",
    );
    expect(readFileSync(path.join(ws, "moved/pkg/alias"), "utf8")).toBe("A");
  });

  test("a FIFO in the tree refuses the fallback copy instead of blocking on it", async () => {
    const fifo = path.join(ws, "src/pipe");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) return; // no mkfifo on this host
    _setMoveRenameForTest(exdev);
    const result = await call(movePath, { source: "src", destination: "elsewhere" });
    expect(JSON.parse(result)).toMatchObject({ moved: false, code: "not-regular-file" });
    expect(result).toContain("was left where it is");
    expect(readFileSync(path.join(ws, "src/sub/file.txt"), "utf8")).toBe("payload");
  });
});

describe("a copied file never replaces a directory", () => {
  test("a file copied onto a directory is refused even with overwrite", async () => {
    write("dir-here/child.txt", "kept");
    const result = await call(copyPath, {
      source: "src/sub/file.txt",
      destination: "dir-here",
      overwrite: true,
    });
    expect(JSON.parse(result)).toMatchObject({ copied: false, code: "exists" });
    expect(readFileSync(path.join(ws, "dir-here/child.txt"), "utf8")).toBe("kept");
  });

  test("a plain overwrite of an in-workspace file still replaces its bytes", async () => {
    write("dst/sub/file.txt", "old");
    const result = JSON.parse(
      await call(copyPath, { source: "src", destination: "dst", overwrite: true }),
    );
    expect(result).toMatchObject({ copied: true, overwrites: 1 });
    expect(readFileSync(path.join(ws, "dst/sub/file.txt"), "utf8")).toBe("payload");
  });
});
