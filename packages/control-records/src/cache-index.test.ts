/**
 * Home's read-model files: the fleet's change log keeps a dense seq per epoch and starts
 * a new epoch when its state is gone, nudges are taken once, and projection names stay
 * clear of what the index already holds.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CACHE_INDEX_DIR,
  appendFleetChanges,
  fleetChangesLedger,
  isProjectionName,
  projectionRel,
  readFleetState,
  readIndexRecord,
  takeNudgeMarkers,
  writeIndexRecord,
  writeNudgeMarker,
} from "./cache-index";
import { resume } from "./cursor";
import { removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const HRN = "hrn_0123456789abcdef";
const CAPS = { maxLines: 1000, maxBytes: 1024 * 1024 };

const seqsOf = (root: string) =>
  resume({ runs: fleetChangesLedger(root) }, undefined, CAPS).items.map((item) =>
    item.kind === "line" ? [item.record["epoch"], item.record["seq"]] : item.kind,
  );

describe("the fleet change log", () => {
  test("seq is dense from 1, fleet.json follows it, and an empty append writes nothing", async () => {
    const root = tempDir();
    expect(readFleetState(root)).toEqual({ state: "absent" });
    const first = await appendFleetChanges(root, [{ type: "a" }, { type: "b", seq: 99, id: "x" }]);
    if (!first.ok) throw new Error(first.reason);
    expect(first).toMatchObject({ seq: 2, appended: 2 });
    expect(Number.isSafeInteger(first.epoch) && first.epoch > 0).toBe(true);
    const second = await appendFleetChanges(root, [{ type: "c" }]);
    expect(second).toMatchObject({ ok: true, epoch: first.epoch, seq: 3, appended: 1 });
    expect(seqsOf(root)).toEqual([
      [first.epoch, 1],
      [first.epoch, 2],
      [first.epoch, 3],
    ]);
    const state = join(root, CACHE_INDEX_DIR, "fleet.json");
    const before = statSync(state).mtimeMs;
    expect(await appendFleetChanges(root, [])).toMatchObject({ ok: true, seq: 3, appended: 0 });
    expect(statSync(state).mtimeMs).toBe(before);
    if (process.platform !== "win32") expect(statSync(state).mode & 0o777).toBe(0o600);
    expect(readFleetState(root)).toEqual({
      state: "present",
      fleet: { v: 1, epoch: first.epoch, seq: 3 },
    });
  });

  test("lines landed after a stale fleet.json are never numbered twice", async () => {
    const root = tempDir();
    const first = await appendFleetChanges(root, [{ type: "a" }]);
    if (!first.ok) throw new Error(first.reason);
    // A crash between the lines and the state write leaves the state one behind.
    writeIndexRecord(root, "fleet.json", { v: 1, epoch: first.epoch, seq: 0 });
    await appendFleetChanges(root, [{ type: "b" }]);
    expect(seqsOf(root)).toEqual([
      [first.epoch, 1],
      [first.epoch, 2],
    ]);
  });

  test("a deleted fleet.json starts a new epoch at seq 1; an unreadable one appends nothing", async () => {
    const root = tempDir();
    const first = await appendFleetChanges(root, [{ type: "a" }]);
    if (!first.ok) throw new Error(first.reason);
    rmSync(join(root, CACHE_INDEX_DIR, "fleet.json"));
    const second = await appendFleetChanges(root, [{ type: "b" }]);
    if (!second.ok) throw new Error(second.reason);
    expect(second.epoch).not.toBe(first.epoch);
    expect(second.seq).toBe(1);
    writeFileSync(join(root, CACHE_INDEX_DIR, "fleet.json"), "torn");
    expect(readFleetState(root).state).toBe("unreadable");
    const refused = await appendFleetChanges(root, [{ type: "c" }]);
    expect(refused.ok).toBe(false);
    expect(seqsOf(root)).toHaveLength(2);
  });
});

describe("nudges", () => {
  test("a marker is taken once, and only for a harness id under a projection name", () => {
    const root = tempDir();
    expect(writeNudgeMarker(root, "overview", HRN)).toEqual({ ok: true });
    expect(writeNudgeMarker(root, "overview", HRN)).toEqual({ ok: true });
    expect(writeNudgeMarker(root, "overview", "../x").ok).toBe(false);
    expect(writeNudgeMarker(root, "refs", HRN).ok).toBe(false);
    const dir = join(root, CACHE_INDEX_DIR, "overview");
    if (process.platform !== "win32") {
      expect(statSync(join(dir, `nudge-${HRN}`)).mode & 0o777).toBe(0o600);
    }
    writeFileSync(join(dir, "nudge-not-a-harness"), "");
    expect(takeNudgeMarkers(root, ["overview", "runs"])).toEqual([HRN]);
    expect(readdirSync(dir)).toEqual(["nudge-not-a-harness"]);
    expect(takeNudgeMarkers(root, ["overview"])).toEqual([]);
  });
});

describe("projection names and files", () => {
  test("a name taken by the index, or shaped like a harness id, is not a projection's", () => {
    for (const name of ["overview", "runs", "attention-items"]) {
      expect(isProjectionName(name)).toBe(true);
    }
    for (const name of ["fleet", "fleet-changes", "refs", HRN, "Runs", "a/b", "", "1x"]) {
      expect([name, isProjectionName(name)]).toEqual([name, false]);
    }
    expect(projectionRel(HRN, "runs")).toBe(join(HRN, "runs.json"));
    expect(() => projectionRel("..", "runs")).toThrow();
  });

  test("written whole at 0600, read back; absent and unreadable are told apart", () => {
    const root = tempDir();
    expect(readIndexRecord(root, projectionRel(HRN, "runs"), 1024)).toEqual({ state: "absent" });
    expect(writeIndexRecord(root, projectionRel(HRN, "runs"), { v: 1, state: {} })).toEqual({
      ok: true,
    });
    expect(readIndexRecord(root, projectionRel(HRN, "runs"), 1024)).toEqual({
      state: "present",
      body: { v: 1, state: {} },
    });
    const file = join(root, CACHE_INDEX_DIR, projectionRel(HRN, "runs"));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "x".repeat(2048));
    expect(readIndexRecord(root, projectionRel(HRN, "runs"), 1024).state).toBe("unreadable");
    mkdirSync(join(root, "elsewhere"));
    expect(existsSync(join(root, CACHE_INDEX_DIR, "fleet.json"))).toBe(false);
  });
});
