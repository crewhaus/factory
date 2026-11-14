/**
 * The heartbeat file: written whole, at `0600`, with no temp file left beside it, and
 * only inside the harness.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { type Heartbeat, writeHeartbeat } from "./heartbeat";
import { controlPaths } from "./paths";
import { removeTempDirs, snapshotTree, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const BEAT: Heartbeat = {
  v: 1,
  pid: 4242,
  at: "2026-11-12T00:00:00.000Z",
  operatorRev: 3,
  paused: true,
  disabled: false,
  operatorUnreadable: false,
  activeRuns: 2,
  runLedger: true,
};

const RUN_DIR = join(".crewhaus", "run");

describe("writeHeartbeat", () => {
  test("writes exactly the heartbeat's fields at 0600, and leaves no temp file", () => {
    const root = tempDir();
    const extra = { ...BEAT, note: "not a heartbeat field" } as Heartbeat;
    expect(writeHeartbeat(root, extra)).toEqual({ ok: true });
    const file = join(root, controlPaths(root).heartbeatFile);
    const body = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "activeRuns",
        "at",
        "disabled",
        "operatorRev",
        "operatorUnreadable",
        "paused",
        "pid",
        "runLedger",
        "v",
      ].sort(),
    );
    expect(body).toEqual({ ...BEAT });
    if (process.platform !== "win32") {
      // Windows has no POSIX mode bits.
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, RUN_DIR)).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(root, RUN_DIR))).toEqual(["control-heartbeat.json"]);
  });

  test("a later beat replaces the file whole and keeps its mode", () => {
    const root = tempDir();
    writeHeartbeat(root, BEAT);
    const next = { ...BEAT, at: "2026-11-12T00:00:15.000Z", operatorRev: null, activeRuns: null };
    expect(writeHeartbeat(root, next)).toEqual({ ok: true });
    const file = join(root, controlPaths(root).heartbeatFile);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(next);
    if (process.platform !== "win32") {
      // Windows has no POSIX mode bits.
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(join(root, RUN_DIR))).toEqual(["control-heartbeat.json"]);
  });

  test("a link at .crewhaus/run that leads out of the harness is refused, and nothing lands outside", () => {
    const root = tempDir();
    const outside = tempDir();
    mkdirSync(join(root, ".crewhaus"));
    symlinkSync(outside, join(root, RUN_DIR));
    const before = snapshotTree(outside);
    const answer = writeHeartbeat(root, BEAT);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason.length).toBeGreaterThan(0);
    expect(snapshotTree(outside)).toEqual(before);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a directory at the heartbeat's name is refused, not thrown", () => {
    const root = tempDir();
    mkdirSync(join(root, controlPaths(root).heartbeatFile), { recursive: true });
    const answer = writeHeartbeat(root, BEAT);
    expect(answer.ok).toBe(false);
  });
});
