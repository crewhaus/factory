/**
 * §7.6 lock-policy tests: O_EXCL acquisition, contended fail-with-pid after
 * the wait deadline, stale-steal (>staleMs mtime) with the lock_stolen
 * warning, and release-then-reacquire.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiLockError, acquireLock, withLock } from "./lock";

let tmp: string;
let lockPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wiki-lock-"));
  lockPath = join(tmp, ".lock");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("acquireLock", () => {
  test("acquires, records the pid, releases, and reacquires", async () => {
    const handle = await acquireLock(lockPath, { waitMs: 100, pollMs: 5 });
    expect(handle.stolen).toBe(false);
    await handle.release();
    const again = await acquireLock(lockPath, { waitMs: 100, pollMs: 5 });
    await again.release();
  });

  test("a held lock fails after the deadline, naming the holder pid", async () => {
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 424242, acquiredAt: "2026-07-01T00:00:00.000Z" })}\n`,
    );
    let caught: unknown;
    try {
      await acquireLock(lockPath, { waitMs: 60, pollMs: 5, staleMs: 60_000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WikiLockError);
    expect((caught as Error).message).toContain("424242");
    expect((caught as Error).message).toContain("waited 60ms");
  });

  test("a stale lock (> staleMs) is stolen with a lock_stolen warning", async () => {
    writeFileSync(lockPath, `${JSON.stringify({ pid: 99999 })}\n`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    const warnings: string[] = [];
    const handle = await acquireLock(lockPath, {
      waitMs: 500,
      pollMs: 5,
      staleMs: 30_000,
      onWarn: (m) => warnings.push(m),
    });
    expect(handle.stolen).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("lock_stolen");
    expect(warnings[0]).toContain("99999");
    await handle.release();
  });
});

describe("withLock", () => {
  test("serializes two writers and always releases (even on throw)", async () => {
    const order: string[] = [];
    await withLock(lockPath, async () => {
      order.push("first");
    });
    await expect(
      withLock(lockPath, async () => {
        order.push("second");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The throwing holder released — a third writer still gets in.
    await withLock(
      lockPath,
      async () => {
        order.push("third");
      },
      { waitMs: 100, pollMs: 5 },
    );
    expect(order).toEqual(["first", "second", "third"]);
  });
});
