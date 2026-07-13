/**
 * §2.6 clearing: trash + undo, never hard-delete.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrashError, listTrash, moveToTrash, restoreFromTrash } from "./trash";

let tmp: string; // stands in for the .crewhaus dir

const fixedNow = (): Date => new Date("2026-07-13T19:04:12.000Z");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "continuity-trash-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(relPath: string, content: string): string {
  const full = join(tmp, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe("moveToTrash", () => {
  test("moves files into a timestamped snapshot preserving relative paths", async () => {
    const focus = seed("state/bot/focus.md", "focus");
    const plan = seed("state/bot/plans/plan-0001-x.md", "plan");
    const result = await moveToTrash([focus, plan], tmp, { now: fixedNow });
    expect(result.ts).toBe("2026-07-13T19-04-12");
    expect(result.moved).toEqual(["state/bot/focus.md", "state/bot/plans/plan-0001-x.md"]);
    expect(existsSync(focus)).toBe(false);
    expect(readFileSync(join(result.trashDir, "state/bot/focus.md"), "utf8")).toBe("focus");
  });

  test("moves whole directories in one rename", async () => {
    seed("state/bot/plans/plan-0001-x.md", "one");
    seed("state/bot/plans/plan-0002-y.md", "two");
    const result = await moveToTrash([join(tmp, "state/bot/plans")], tmp, { now: fixedNow });
    expect(result.moved).toEqual(["state/bot/plans"]);
    expect(existsSync(join(tmp, "state/bot/plans"))).toBe(false);
    expect(existsSync(join(result.trashDir, "state/bot/plans/plan-0002-y.md"))).toBe(true);
  });

  test("skips missing paths (clearing an empty store is a no-op)", async () => {
    const result = await moveToTrash([join(tmp, "state/bot/goals.yaml")], tmp, { now: fixedNow });
    expect(result.moved).toEqual([]);
  });

  test("collision-suffixes a second snapshot in the same second", async () => {
    seed("a.md", "1");
    seed("b.md", "2");
    const first = await moveToTrash([join(tmp, "a.md")], tmp, { now: fixedNow });
    const second = await moveToTrash([join(tmp, "b.md")], tmp, { now: fixedNow });
    expect(first.ts).toBe("2026-07-13T19-04-12");
    expect(second.ts).toBe("2026-07-13T19-04-12-2");
  });

  test("fails closed on a path outside the .crewhaus dir", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      writeFileSync(join(outside, "x.md"), "x");
      await expect(moveToTrash([join(outside, "x.md")], tmp, { now: fixedNow })).rejects.toThrow(
        TrashError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses to trash the trash", async () => {
    seed("trash/2026-01-01T00-00-00/x.md", "x");
    await expect(
      moveToTrash([join(tmp, "trash/2026-01-01T00-00-00")], tmp, { now: fixedNow }),
    ).rejects.toThrow(/refusing to trash the trash/);
  });
});

describe("listTrash + restoreFromTrash", () => {
  test("round-trip: clear → list → restore puts every file back", async () => {
    const focus = seed("state/bot/focus.md", "focus-body");
    seed("state/bot/plans/plan-0001-x.md", "plan-body");
    const { ts } = await moveToTrash([focus, join(tmp, "state/bot/plans")], tmp, { now: fixedNow });

    const snapshots = await listTrash(tmp);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]?.ts).toBe(ts);
    expect(snapshots[0]?.files).toEqual(["state/bot/focus.md", "state/bot/plans/plan-0001-x.md"]);

    const restored = await restoreFromTrash(ts, tmp);
    expect(restored.restored.sort()).toEqual([
      "state/bot/focus.md",
      "state/bot/plans/plan-0001-x.md",
    ]);
    expect(readFileSync(join(tmp, "state/bot/focus.md"), "utf8")).toBe("focus-body");
    expect(readFileSync(join(tmp, "state/bot/plans/plan-0001-x.md"), "utf8")).toBe("plan-body");
    // The emptied snapshot is gone.
    expect(await listTrash(tmp)).toEqual([]);
  });

  test("restore fails closed when a destination already exists (nothing moves)", async () => {
    const focus = seed("state/bot/focus.md", "v1");
    const { ts } = await moveToTrash([focus], tmp, { now: fixedNow });
    seed("state/bot/focus.md", "v2"); // new file written after the clear
    await expect(restoreFromTrash(ts, tmp)).rejects.toThrow(/would overwrite/);
    // The snapshot is intact and the newer file untouched.
    expect(readFileSync(join(tmp, "state/bot/focus.md"), "utf8")).toBe("v2");
    expect((await listTrash(tmp))[0]?.files).toEqual(["state/bot/focus.md"]);
  });

  test("restore validates the timestamp shape (no traversal)", async () => {
    await expect(restoreFromTrash("../../etc", tmp)).rejects.toThrow(TrashError);
  });

  test("restore of an unknown snapshot names the problem", async () => {
    await expect(restoreFromTrash("2020-01-01T00-00-00", tmp)).rejects.toThrow(/no trash snapshot/);
  });

  test("listTrash on a store with no trash returns []", async () => {
    expect(await listTrash(tmp)).toEqual([]);
  });
});
