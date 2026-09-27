/**
 * Tests for the failure path of `Write` and `Edit`.
 *
 * Both tools stage their output in a temp beside the target (tool-safety's
 * writeFileSafe: an O_EXCL, randomly named, hidden file) and then rename it
 * over the target. When staging fails, nothing may be left behind and the
 * target must be untouched.
 *
 * We trigger the failure with REAL filesystem state (no mocks, no fake clock):
 * a sub-directory is made read-only (mode 0o500) so the file inside is still
 * readable (Edit's pre-read succeeds) but the temp cannot be created. Root
 * ignores directory modes, so these two tests are skipped (reported as
 * skips, not passes) when the suite runs as root, as in a devcontainer.
 * The directory mode is restored in afterEach so the temp tree tidies up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ToolPermissionError, edit, write } from "./index";

/** Running as root defeats a mode-based unwritable directory; these tests are skipped, not faked. */
const canTestUnwritable = (process.getuid?.() ?? 0) !== 0;

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
  test.if(canTestUnwritable)(
    "refuses, names why, and leaves nothing behind when the staged write fails",
    async () => {
      const dir = makeReadOnlyDir("ro");
      chmodSync(dir, 0o500);
      lockedDir = dir;
      // Creating the temp inside the read-only dir fails with EACCES.
      await expect(write.execute({ path: "ro/out.txt", content: "data" })).rejects.toThrow(
        /"ro\/out\.txt" cannot be written: EACCES/,
      );
      chmodSync(dir, 0o700);
      lockedDir = undefined;
      // Nothing at all leaked into the directory: no temp, no partial file.
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  test("still validates the path before attempting any write (traversal rejected)", async () => {
    await expect(write.execute({ path: "../escape.txt", content: "x" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });
});

describe("Edit — scratch-file cleanup on failure", () => {
  test.if(canTestUnwritable)(
    "reads the original, then refuses and leaves the file alone when staging fails",
    async () => {
      const dir = makeReadOnlyDir("ro");
      const target = path.join(dir, "f.txt");
      writeFileSync(target, "hello world");
      // Read perm remains (0o500), so Edit's pre-read of the file succeeds and the
      // unique-occurrence check passes; only the scratch write fails.
      chmodSync(dir, 0o500);
      lockedDir = dir;
      await expect(
        edit.execute({ path: "ro/f.txt", oldString: "world", newString: "there" }),
      ).rejects.toThrow(/"ro\/f\.txt" cannot be written: EACCES/);
      chmodSync(dir, 0o700);
      lockedDir = undefined;
      // Original file is untouched — the atomic swap never landed — and no
      // temp was left beside it.
      expect(await Bun.file(target).text()).toBe("hello world");
      expect(readdirSync(dir)).toEqual(["f.txt"]);
    },
  );
});
