/**
 * §7.6 lock policy, at the unified implementation: wait → steal-if-stale
 * (with a warning) → fail naming the holder pid. The two consuming stores
 * (continuity-store, wiki-store) pin their wrapper surfaces — error identity
 * and message prefixes — in their own lock tests; this file pins the shared
 * mechanics plus the `label`/`createError` seams the wrappers customize.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock, withFileLock } from "./file-lock";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "file-lock-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("acquireFileLock", () => {
  test("creates the lock file (parent dirs included) and release() removes it", async () => {
    const lockPath = join(tmp, "store", ".lock");
    const handle = await acquireFileLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    expect(handle.stolen).toBe(false);
    await handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("waits for a contended lock and wins once it frees", async () => {
    const lockPath = join(tmp, ".lock");
    const first = await acquireFileLock(lockPath);
    const second = acquireFileLock(lockPath, { waitMs: 1_000, pollMs: 10 });
    setTimeout(() => void first.release(), 50);
    const handle = await second;
    expect(handle.stolen).toBe(false);
    await handle.release();
  });

  test("fails past the deadline via createError, naming label + holder pid", async () => {
    class CustomLockError extends Error {
      override readonly name = "CustomLockError";
    }
    const lockPath = join(tmp, ".lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 4242, acquiredAt: "2026-01-01" })}\n`);
    const attempt = acquireFileLock(lockPath, {
      waitMs: 100,
      pollMs: 10,
      label: "custom-store",
      createError: (m) => new CustomLockError(m),
    });
    await expect(attempt).rejects.toThrow(CustomLockError);
    await expect(
      acquireFileLock(lockPath, {
        waitMs: 100,
        pollMs: 10,
        label: "custom-store",
        createError: (m) => new CustomLockError(m),
      }),
    ).rejects.toThrow(/custom-store: .*held by pid 4242/);
  });

  test("defaults: plain Error with the file-lock label", async () => {
    const lockPath = join(tmp, ".lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 7 })}\n`);
    await expect(acquireFileLock(lockPath, { waitMs: 80, pollMs: 10 })).rejects.toThrow(
      /^file-lock: /,
    );
  });

  test("steals a stale lock (mtime older than staleMs) and records a labeled warning", async () => {
    const lockPath = join(tmp, ".lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 999 })}\n`);
    const past = (Date.now() - 60_000) / 1000;
    await utimes(lockPath, past, past);
    const warnings: string[] = [];
    const handle = await acquireFileLock(lockPath, {
      waitMs: 500,
      staleMs: 30_000,
      pollMs: 10,
      label: "custom-store",
      onWarn: (m) => warnings.push(m),
    });
    expect(handle.stolen).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("custom-store: lock_stolen");
    expect(warnings[0]).toContain("pid 999");
    await handle.release();
  });

  test("a fresh (non-stale) lock is NOT stolen", async () => {
    const lockPath = join(tmp, ".lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 1 })}\n`);
    const warnings: string[] = [];
    await expect(
      acquireFileLock(lockPath, {
        waitMs: 80,
        staleMs: 30_000,
        pollMs: 10,
        onWarn: (m) => warnings.push(m),
      }),
    ).rejects.toThrow();
    expect(warnings).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("withFileLock", () => {
  test("serializes two writers — the second waits for the first", async () => {
    const lockPath = join(tmp, ".lock");
    const order: string[] = [];
    const a = withFileLock(
      lockPath,
      async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 60));
        order.push("a-end");
      },
      { pollMs: 5 },
    );
    await new Promise((r) => setTimeout(r, 10)); // let a acquire first
    const b = withFileLock(
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
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });
});
