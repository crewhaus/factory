/**
 * Realpath containment: shape checks stop `../`, the realpath check stops a
 * symlink planted inside the tree from walking a read out of it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafePathSegment, resolveContained, resolveInside } from "./containment";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

/** `<tmp>/root` with `sub/ok.txt` in it, and `<tmp>/outside.txt` beside it. */
function layout(): { workspace: string; root: string; outside: string } {
  const workspace = mkdtempSync(join(tmpdir(), "containment-"));
  scratch.push(workspace);
  const root = join(workspace, "root");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", "ok.txt"), "fine");
  const outside = join(workspace, "outside.txt");
  writeFileSync(outside, "OUTSIDE");
  return { workspace, root, outside };
}

describe("isSafePathSegment", () => {
  test("rejects separators, dots, NUL, the empty string and overlong names", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b", "..\\..", "x".repeat(513)]) {
      expect(`${JSON.stringify(bad.slice(0, 12))}:${isSafePathSegment(bad)}`).toBe(
        `${JSON.stringify(bad.slice(0, 12))}:false`,
      );
    }
  });

  test("accepts one plain name, dots inside it included", () => {
    for (const ok of [
      "sess_0123456789abcdef",
      "run_00000000000000a1.log",
      "...",
      "x".repeat(512),
    ]) {
      expect(isSafePathSegment(ok)).toBe(true);
    }
  });
});

describe("resolveInside", () => {
  test("allows an in-tree read, and a file that does not exist yet", () => {
    const { root } = layout();
    expect(resolveInside(root, ["sub", "ok.txt"])).toBe(join(root, "sub", "ok.txt"));
    expect(resolveInside(root, ["sub", "new.txt"])).toBe(join(root, "sub", "new.txt"));
    expect(resolveInside(root, ["not", "yet", "there.txt"])).toBe(
      join(root, "not", "yet", "there.txt"),
    );
  });

  test("refuses traversal, a separator inside a segment, and NUL", () => {
    const { root } = layout();
    expect(resolveInside(root, ["..", "outside.txt"])).toBeUndefined();
    expect(resolveInside(root, ["sub", "..", "..", "outside.txt"])).toBeUndefined();
    expect(resolveInside(root, ["sub/../../outside.txt"])).toBeUndefined();
    expect(resolveInside(root, ["a\0b"])).toBeUndefined();
  });

  test("refuses everything under a root that does not exist", () => {
    const { workspace } = layout();
    expect(resolveInside(join(workspace, "missing"), ["file.txt"])).toBeUndefined();
  });
});

describe("resolveContained", () => {
  test("takes a candidate relative to the root, or absolute", () => {
    const { root, outside } = layout();
    expect(resolveContained(root, "sub/ok.txt")).toBe(join(root, "sub", "ok.txt"));
    expect(resolveContained(root, join(root, "sub", "ok.txt"))).toBe(join(root, "sub", "ok.txt"));
    expect(resolveContained(root, outside)).toBeUndefined();
  });

  test("a sibling whose name starts with the root's is outside it", () => {
    const { workspace, root } = layout();
    const sibling = `${root}-evil`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "file.txt"), "SIBLING");
    expect(resolveContained(root, join(sibling, "file.txt"))).toBeUndefined();
    expect(resolveContained(root, root)).toBe(root);
    expect(resolveContained(workspace, join(sibling, "file.txt"))).toBe(join(sibling, "file.txt"));
  });
});

// Symlinks need privileges Windows runners do not grant by default.
describe.skipIf(process.platform === "win32")("symlinks", () => {
  test("a file or directory symlink that escapes the root does not resolve", () => {
    const { workspace, root, outside } = layout();
    symlinkSync(outside, join(root, "sub", "sneaky.txt"));
    expect(resolveInside(root, ["sub", "sneaky.txt"])).toBeUndefined();
    symlinkSync(workspace, join(root, "sub", "updir"));
    expect(resolveInside(root, ["sub", "updir", "outside.txt"])).toBeUndefined();
    // …including for a file that does not exist yet beneath it.
    expect(resolveInside(root, ["sub", "updir", "created-later.txt"])).toBeUndefined();
  });

  test("a symlink that stays inside the root resolves", () => {
    const { root } = layout();
    symlinkSync(join(root, "sub"), join(root, "alias"));
    expect(resolveInside(root, ["alias", "ok.txt"])).toBe(join(root, "alias", "ok.txt"));
  });
});
