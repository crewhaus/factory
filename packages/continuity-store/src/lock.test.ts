/**
 * §7.6 lock policy: wait → steal-if-stale (with a warning) → fail naming the
 * holder pid.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityLockError, acquireLock, withLock } from "./lock";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "continuity-lock-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("acquireLock", () => {
  test("creates the lock file and release() removes it", async () => {
    const lockPath = join(tmp, "store", ".lock");
    const handle = await acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    expect(handle.stolen).toBe(false);
    await handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("waits for a contended lock and wins once it frees", async () => {
    const lockPath = join(tmp, ".lock");
    const first = await acquireLock(lockPath);
    const second = acquireLock(lockPath, { waitMs: 1_000, pollMs: 10 });
    // Free the lock shortly after — the waiter should win, not fail.
    setTimeout(() => void first.release(), 50);
    const handle = await second;
    expect(handle.stolen).toBe(false);
    await handle.release();
  });

  test("fails past the deadline with an error naming the holder pid", async () => {
    const lockPath = join(tmp, ".lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 4242, acquiredAt: "2026-01-01" })}\n`);
    await expect(acquireLock(lockPath, { waitMs: 100, pollMs: 10 })).rejects.toThrow(
      ContinuityLockError,
    );
    await expect(acquireLock(lockPath, { waitMs: 100, pollMs: 10 })).rejects.toThrow(
      /held by pid 4242/,
    );
  });

  test("steals a stale lock (mtime older than staleMs) and records a warning", async () => {
    const lockPath = join(tmp, ".lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 999 })}\n`);
    const past = (Date.now() - 60_000) / 1000;
    await utimes(lockPath, past, past);
    const warnings: string[] = [];
    const handle = await acquireLock(lockPath, {
      waitMs: 500,
      staleMs: 30_000,
      pollMs: 10,
      onWarn: (m) => warnings.push(m),
    });
    expect(handle.stolen).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("lock_stolen");
    expect(warnings[0]).toContain("pid 999");
    await handle.release();
  });

  test("a fresh (non-stale) lock is NOT stolen", async () => {
    const lockPath = join(tmp, ".lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 1 })}\n`);
    const warnings: string[] = [];
    await expect(
      acquireLock(lockPath, {
        waitMs: 80,
        staleMs: 30_000,
        pollMs: 10,
        onWarn: (m) => warnings.push(m),
      }),
    ).rejects.toThrow(ContinuityLockError);
    expect(warnings).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("withLock", () => {
  test("serializes two writers — the second waits for the first", async () => {
    const lockPath = join(tmp, ".lock");
    const order: string[] = [];
    const a = withLock(
      lockPath,
      async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 60));
        order.push("a-end");
      },
      { pollMs: 5 },
    );
    await new Promise((r) => setTimeout(r, 10)); // let a acquire first
    const b = withLock(
      lockPath,
      async () => {
        order.push("b");
      },
      { pollMs: 5 },
    );
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  test("releases the lock even when fn throws", async () => {
    const lockPath = join(tmp, ".lock");
    await expect(
      withLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });
});
