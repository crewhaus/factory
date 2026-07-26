/**
 * Wave-4 handoff — `judge calibrate --apply` writes
 * `.crewhaus/judge-calibration.json` atomically (temp file + rename).
 *
 * Why it matters: the eval runner READS this file at run start to gate
 * `llm_judge` graders that declare no `passing_score`, and a malformed read
 * only warns — so a torn file silently mis-gates a whole run. A truncated
 * calibration file was observed mid-run in a shared checkout during the
 * Wave-3 flake hunt; this pins the fix.
 *
 * Every artifact lives under an `mkdtemp` root; nothing touches the repo cwd.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JudgeCalibrationFile, writeCalibrationFileAtomic } from "./judge-calibrate";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-calib-atomic-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function file(minScore: number, pad = 0): JudgeCalibrationFile {
  return {
    version: 1,
    calibrations: {
      // A fat entry: a torn write of a small file can look valid by luck, so
      // the payload is big enough that truncation is unmistakable.
      concierge: {
        minScore,
        model: `claude-sonnet-4-5${"x".repeat(pad)}`,
        correlation: 0.8,
        bias: 0.02,
        pairCount: 42,
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    },
  };
}

describe("writeCalibrationFileAtomic", () => {
  test("writes the file (creating .crewhaus/) with a trailing newline", () => {
    const root = newTempRoot();
    const path = join(root, ".crewhaus", "judge-calibration.json");
    writeCalibrationFileAtomic(path, file(0.62));
    const text = readFileSync(path, "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    expect((JSON.parse(text) as JudgeCalibrationFile).calibrations["concierge"]?.minScore).toBe(
      0.62,
    );
  });

  test("leaves no temp litter beside the artifact", () => {
    const root = newTempRoot();
    const path = join(root, "judge-calibration.json");
    writeCalibrationFileAtomic(path, file(0.5));
    writeCalibrationFileAtomic(path, file(0.7));
    expect(readdirSync(root)).toEqual(["judge-calibration.json"]);
  });

  test("replaces an existing file wholesale (no leftover tail from the old one)", () => {
    const root = newTempRoot();
    const path = join(root, "judge-calibration.json");
    writeCalibrationFileAtomic(path, file(0.5, 5000));
    writeCalibrationFileAtomic(path, file(0.9));
    const text = readFileSync(path, "utf-8");
    expect(text).not.toContain("xxxxx");
    expect(JSON.parse(text)).toEqual(file(0.9));
  });

  test("the destination is REPLACED by rename, never truncated in place", () => {
    // The mechanism assertion. A same-thread reader cannot discriminate
    // atomic-rename from truncate-then-write (`writeFileSync` is
    // uninterruptible in one JS thread, so interleaved reads only ever land
    // BETWEEN whole writes) — but the filesystem can: rename swaps in a NEW
    // inode and leaves the old one intact, while truncate-then-write reuses
    // the destination inode. A hard link pins the old inode so the
    // difference is observable without any timing at all.
    const root = newTempRoot();
    const path = join(root, "judge-calibration.json");
    writeCalibrationFileAtomic(path, file(0.5, 5000));
    const before = statSync(path);
    const snapshot = join(root, "pinned-old-inode.json");
    linkSync(path, snapshot);

    writeCalibrationFileAtomic(path, file(0.9));

    // New inode at the destination ⇒ the write went through rename.
    expect(statSync(path).ino).not.toBe(before.ino);
    expect(statSync(snapshot).ino).toBe(before.ino);
    // The OLD bytes are untouched and whole — a truncate-then-write would
    // have rewritten them through this very link (and a torn one would have
    // left a half file here mid-write).
    const kept = readFileSync(snapshot, "utf-8");
    expect(kept).toContain("xxxxx");
    expect((JSON.parse(kept) as JudgeCalibrationFile).calibrations["concierge"]?.minScore).toBe(
      0.5,
    );
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(file(0.9));
  });

  test("replaces a READ-ONLY destination — rename needs only the directory", () => {
    // The second discriminator, and the reason the first two matter in the
    // wild: rename(2) writes the DIRECTORY entry, so it replaces a file the
    // caller cannot open for writing, while truncate-then-write dies EACCES.
    // Both properties were measured against a naive `writeFileSync`
    // implementation: it keeps the destination inode (test above) and fails
    // here. A reader loop — same-thread OR a separate process — was measured
    // NOT to discriminate: macOS/Linux serialize whole-file reads against a
    // single write(2), so ~20k interleaved cross-process reads over ~20k
    // truncate-then-write rewrites observed zero torn files. Mechanism
    // assertions, not races, are what pin this fix.
    const root = newTempRoot();
    const path = join(root, "judge-calibration.json");
    writeCalibrationFileAtomic(path, file(0.5, 5000));
    chmodSync(path, 0o444);
    try {
      writeCalibrationFileAtomic(path, file(0.9));
      const text = readFileSync(path, "utf-8");
      expect(JSON.parse(text)).toEqual(file(0.9));
      expect(text).not.toContain("xxxxx");
      expect(readdirSync(root)).toEqual(["judge-calibration.json"]);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("a failed write cleans up its temp file and rethrows", () => {
    const root = newTempRoot();
    // A directory where the destination file should be: rename fails.
    const path = join(root, "as-a-dir");
    writeFileSync(join(root, "keep.txt"), "x");
    mkdirSync(join(path, "occupied"), { recursive: true });
    expect(() => writeCalibrationFileAtomic(path, file(0.5))).toThrow();
    expect(existsSync(path)).toBe(true);
    // No `.as-a-dir.<pid>.<hex>.tmp` left behind in the parent.
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
