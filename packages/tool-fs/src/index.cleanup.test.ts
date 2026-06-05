/**
 * Tests for the temp-file cleanup path in `Write` and `Edit`.
 *
 * Both tools stage their output in a `<abs>.tmp.<rand>` scratch file and then
 * atomically `rename` it over the target. The whole stage+rename is wrapped in
 * a try/catch whose handler runs `unlink(tmp).catch(() => {})` to remove the
 * orphaned scratch file before re-throwing the original error. The happy-path
 * tests never enter that handler, so the catch block and its `.catch(() => {})`
 * swallow-arrow stay uncovered.
 *
 * We trigger the failure with REAL filesystem state (no mocks, no fake clock):
 * a sub-directory is made read-only (mode 0o500) so the file inside is still
 * readable (Edit's pre-read succeeds) but the scratch `Bun.write` fails with
 * EACCES. That drives the catch handler; the subsequent `unlink` also fails
 * and is swallowed by the `.catch(() => {})` arrow — exactly the line we cover.
 * The directory mode is restored in afterEach so the temp tree tidies up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ToolPermissionError, edit, write } from "./index";

let tmp: string;
let originalCwd: string;
let lockedDir: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(path.join(tmpdir(), "tool-fs-cleanup-"));
  process.chdir(tmp);
  lockedDir = undefined;
});

afterEach(() => {
  // Restore write permission on any dir we locked so rmSync can clean up.
  if (lockedDir !== undefined) {
    try {
      chmodSync(lockedDir, 0o700);
    } catch {
      // best effort
    }
  }
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

/** Create a read-only sub-directory and return its absolute path. */
function makeReadOnlyDir(name: string): string {
  const dir = path.join(tmp, name);
  mkdirSync(dir);
  return dir;
}

describe("Write — scratch-file cleanup on failure", () => {
  test("re-throws and removes the scratch file when the staged write fails", async () => {
    const dir = makeReadOnlyDir("ro");
    chmodSync(dir, 0o500);
    lockedDir = dir;
    // Staging `${abs}.tmp.<rand>` inside the read-only dir fails with EACCES,
    // which propagates out after the cleanup arrow runs.
    await expect(write.execute({ path: "ro/out.txt", content: "data" })).rejects.toThrow();
    // No scratch files leaked into the directory.
    chmodSync(dir, 0o700);
    lockedDir = undefined;
    const leftover = readdirSync(dir).filter((e) => e.includes(".tmp."));
    expect(leftover).toEqual([]);
  });

  test("still validates the path before attempting any write (traversal rejected)", async () => {
    await expect(write.execute({ path: "../escape.txt", content: "x" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });
});

describe("Edit — scratch-file cleanup on failure", () => {
  test("reads the original, then re-throws and cleans up when staging fails", async () => {
    const dir = makeReadOnlyDir("ro");
    const target = path.join(dir, "f.txt");
    writeFileSync(target, "hello world");
    // Read perm remains (0o500), so Edit's pre-read of the file succeeds and the
    // unique-occurrence check passes; only the scratch write fails.
    chmodSync(dir, 0o500);
    lockedDir = dir;
    await expect(
      edit.execute({ path: "ro/f.txt", oldString: "world", newString: "there" }),
    ).rejects.toThrow();
    chmodSync(dir, 0o700);
    lockedDir = undefined;
    // Original file is untouched — the atomic swap never landed.
    expect(await Bun.file(target).text()).toBe("hello world");
    const leftover = readdirSync(dir).filter((e) => e.includes(".tmp."));
    expect(leftover).toEqual([]);
  });
});
