import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { readOperatorRecord } from "./operator";
import { writeOperatorRecord } from "./operator-write";
import {
  UNREADABLE_OPERATOR,
  controlFile,
  jsonLine,
  plant,
  removeTempDirs,
  snapshotTree,
  tempDir,
} from "./test-helpers";

afterAll(removeTempDirs);

const PAUSE = { paused: true, since: "2026-11-13T00:00:00.000Z", by: "prn_a", cmd: "cmd_1" };
const DISABLE = { disabled: true, since: "2026-11-13T01:00:00.000Z", by: "prn_b", cmd: "cmd_2" };

function onDisk(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(controlFile(root, "operator.json"), "utf8"));
}

describe("writeOperatorRecord", () => {
  test("an absent record starts at rev 1 and stopped; a second write keeps the other block", async () => {
    const root = tempDir();
    const first = await writeOperatorRecord(root, { intake: PAUSE });
    expect(first).toEqual({
      ok: true,
      record: { v: 1, rev: 1, intake: PAUSE, deployment: null, desired: "stopped" },
    });
    expect(onDisk(root)).toEqual({
      v: 1,
      rev: 1,
      intake: PAUSE,
      deployment: null,
      desired: "stopped",
    });
    if (process.platform !== "win32") {
      expect(statSync(controlFile(root, "operator.json")).mode & 0o777).toBe(0o600);
      expect(statSync(controlFile(root)).mode & 0o777).toBe(0o700);
    }
    const second = await writeOperatorRecord(root, { deployment: DISABLE, desired: "running" });
    expect(second).toEqual({
      ok: true,
      record: { v: 1, rev: 2, intake: PAUSE, deployment: DISABLE, desired: "running" },
    });
  });

  test("a top-level field this release does not know survives a write", async () => {
    const root = tempDir();
    plant(
      controlFile(root, "operator.json"),
      jsonLine({ v: 1, rev: 4, desired: "running", later: { kept: true } }),
    );
    const answer = await writeOperatorRecord(root, { intake: PAUSE });
    expect(answer.ok).toBe(true);
    expect(onDisk(root)).toEqual({
      v: 1,
      rev: 5,
      intake: PAUSE,
      deployment: null,
      desired: "running",
      later: { kept: true },
    });
  });

  test("a block replaces the block whole, and a quiet pause keeps its null notice", async () => {
    const root = tempDir();
    await writeOperatorRecord(root, { intake: { ...PAUSE, notice: null } });
    expect(onDisk(root)["intake"]).toEqual({ ...PAUSE, notice: null });
    await writeOperatorRecord(root, { intake: { paused: false, since: "x", by: "prn_c" } });
    expect(onDisk(root)["intake"]).toEqual({ paused: false, since: "x", by: "prn_c" });
  });

  test("two writes started together both land, one rev each", async () => {
    const root = tempDir();
    const [a, b] = await Promise.all([
      writeOperatorRecord(root, { intake: PAUSE }),
      writeOperatorRecord(root, { deployment: DISABLE }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const revs = [a, b].map((w) => (w.ok ? w.record.rev : -1)).sort();
    expect(revs).toEqual([1, 2]);
    expect(onDisk(root)).toMatchObject({ rev: 2, intake: PAUSE, deployment: DISABLE });
  });

  for (const [name, plantIt] of Object.entries(UNREADABLE_OPERATOR)) {
    test(`an unreadable record (${name}) is never written`, async () => {
      const root = tempDir();
      plantIt(root);
      const before = snapshotTree(root);
      const answer = await writeOperatorRecord(root, { intake: { paused: false } });
      expect(answer.ok).toBe(false);
      if (answer.ok) throw new Error("unreachable");
      expect(answer.reason).toContain("operator.json");
      expect(answer.reason).toContain("can't be read");
      expect(snapshotTree(root)).toEqual(before);
    });
  }

  test("every reader in this process answers the new record at once", async () => {
    const root = tempDir();
    const frozen = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-13T12:00:00.000Z"));
    try {
      expect(readOperatorRecord(root)).toEqual({ state: "absent" });
      const answer = await writeOperatorRecord(root, { deployment: DISABLE });
      expect(answer.ok).toBe(true);
      // The clock never moved, so only the writer's refresh can make this answer.
      expect(readOperatorRecord(root)).toMatchObject({
        state: "present",
        record: { rev: 1, deployment: DISABLE },
      });
    } finally {
      frozen.mockRestore();
    }
  });
});
