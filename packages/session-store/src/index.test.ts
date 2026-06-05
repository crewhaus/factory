import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenancyError, buildTenant, withTenant } from "@crewhaus/tenancy";
import { createSessionStore } from "./index";

// Snapshot the genuine node:fs/promises implementation ONCE, before any test
// installs a mock. Bun's `mock.module` mutates the live module namespace in
// place, so we copy the concrete function *values* into plain locals here —
// these references stay genuine even after the namespace is later mocked,
// which lets mocked stat/unlink pass through without recursing into themselves.
const REAL_FS_PROMISES = { ...(await import("node:fs/promises")) };
const realStat = REAL_FS_PROMISES.stat;
const realUnlink = REAL_FS_PROMISES.unlink;
// `mock.module` registrations accumulate and `mock.restore()` does not reliably
// undo them, so suites that mock fs restore the real module via this snapshot
// in their own afterEach.
const restoreRealFsPromises = () => {
  mock.module("node:fs/promises", () => ({ ...REAL_FS_PROMISES }));
};

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-session-store-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("session-store — create / get", () => {
  test("create generates a sess_<16hex> id and persists the file", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const session = await store.create({ name: "test", target: "cli", model: "claude-x" });
    expect(session.id).toMatch(/^sess_[0-9a-f]{16}$/);
    expect(session.name).toBe("test");
    expect(session.target).toBe("cli");
    expect(session.model).toBe("claude-x");
    expect(session.lastTurnIndex).toBe(0);
    expect(session.createdAt).toBe(session.updatedAt);
    expect(existsSync(join(rootDir, `${session.id}.json`))).toBe(true);
  });

  test("get returns the persisted session", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const created = await store.create({ name: "x", target: "cli", model: "m" });
    const got = await store.get(created.id);
    expect(got).toEqual(created);
  });

  test("get returns null for a missing session", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const got = await store.get("sess_0000000000000000");
    expect(got).toBeNull();
  });

  test("create honours an explicit id", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const session = await store.create({
      id: "sess_deadbeefcafebabe",
      name: "x",
      target: "cli",
      model: "m",
    });
    expect(session.id).toBe("sess_deadbeefcafebabe");
  });
});

describe("session-store — malformed-file parsing (parseSession)", () => {
  test("get throws RuntimeError on malformed JSON", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const id = "sess_0123456789abcdef";
    writeFileSync(join(rootDir, `${id}.json`), "{ this is not valid json");
    await expect(store.get(id)).rejects.toThrow(/malformed JSON for "sess_0123456789abcdef"/);
  });

  test("get throws RuntimeError on an unexpected JSON shape", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const id = "sess_fedcba9876543210";
    // Valid JSON, but missing the required Session fields.
    writeFileSync(join(rootDir, `${id}.json`), JSON.stringify({ id, notASession: true }));
    await expect(store.get(id)).rejects.toThrow(
      /unexpected JSON shape for "sess_fedcba9876543210"/,
    );
  });
});

describe("session-store — id validation", () => {
  test("rejects path-traversal attempts", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    await expect(store.get("../escape")).rejects.toThrow(/invalid sessionId/);
    await expect(store.delete("etc/passwd")).rejects.toThrow(/invalid sessionId/);
    await expect(
      store.create({ id: "../escape", name: "x", target: "cli", model: "m" }),
    ).rejects.toThrow(/invalid sessionId/);
  });

  test("rejects ids missing the prefix or with the wrong hex length", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    await expect(store.get("notasession")).rejects.toThrow(/invalid sessionId/);
    await expect(store.get("sess_short")).rejects.toThrow(/invalid sessionId/);
    await expect(store.get("sess_xxxxxxxxxxxxxxxx")).rejects.toThrow(/invalid sessionId/);
  });
});

describe("session-store — update / delete", () => {
  test("update merges the patch and bumps updatedAt", async () => {
    const rootDir = newTempRoot();
    let clock = new Date("2026-05-06T12:00:00Z").getTime();
    const store = createSessionStore({
      rootDir,
      now: () => new Date(clock),
    });
    const created = await store.create({ name: "n", target: "cli", model: "m" });
    clock += 1000;
    const updated = await store.update(created.id, { lastTurnIndex: 7, name: "n2" });
    expect(updated.lastTurnIndex).toBe(7);
    expect(updated.name).toBe("n2");
    expect(updated.target).toBe("cli");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);

    const reread = await store.get(created.id);
    expect(reread).toEqual(updated);
  });

  test("update rejects a missing session", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    await expect(store.update("sess_0000000000000000", { lastTurnIndex: 1 })).rejects.toThrow(
      /cannot update missing session/,
    );
  });

  test("delete unlinks both the session file and a sibling event log", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const created = await store.create({ name: "x", target: "cli", model: "m" });
    const log = join(rootDir, `${created.id}.jsonl`);
    writeFileSync(log, '{"kind":"user_message","payload":{}}\n');
    await store.delete(created.id);
    expect(existsSync(join(rootDir, `${created.id}.json`))).toBe(false);
    expect(existsSync(log)).toBe(false);
  });

  test("delete on a missing session is a no-op", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    await store.delete("sess_0000000000000000");
  });
});

describe("session-store — list and TTL eviction", () => {
  test("list returns surviving sessions sorted by updatedAt desc", async () => {
    const rootDir = newTempRoot();
    let clock = new Date("2026-05-06T12:00:00Z").getTime();
    const store = createSessionStore({
      rootDir,
      now: () => new Date(clock),
    });
    const a = await store.create({ name: "a", target: "cli", model: "m" });
    clock += 1000;
    const b = await store.create({ name: "b", target: "cli", model: "m" });
    clock += 1000;
    const c = await store.create({ name: "c", target: "cli", model: "m" });

    const listed = await store.list();
    expect(listed.map((s) => s.id)).toEqual([c.id, b.id, a.id]);
  });

  test("T3 — backdating an mtime to >30 days evicts the file and its event log", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const a = await store.create({ name: "a", target: "cli", model: "m" });
    const b = await store.create({ name: "b", target: "cli", model: "m" });
    const c = await store.create({ name: "c", target: "cli", model: "m" });

    // Sibling event log for `a` so we can confirm it gets evicted too.
    const aLog = join(rootDir, `${a.id}.jsonl`);
    writeFileSync(aLog, '{"version":1,"ts":1,"kind":"user_message","payload":{}}\n');
    expect(existsSync(aLog)).toBe(true);

    // Backdate `a`'s session file mtime to 35 days ago.
    const old = new Date(Date.now() - 35 * 86_400_000);
    utimesSync(join(rootDir, `${a.id}.json`), old, old);
    expect(statSync(join(rootDir, `${a.id}.json`)).mtimeMs).toBeLessThan(
      Date.now() - 30 * 86_400_000,
    );

    const survivors = await store.list();
    const ids = survivors.map((s) => s.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id);
    expect(survivors.length).toBe(2);

    expect(existsSync(join(rootDir, `${a.id}.json`))).toBe(false);
    expect(existsSync(aLog)).toBe(false);
    expect(existsSync(join(rootDir, `${b.id}.json`))).toBe(true);
  });

  test("list returns [] when the root dir does not exist yet", async () => {
    const rootDir = join(newTempRoot(), "subdir-not-created");
    const store = createSessionStore({ rootDir });
    expect(await store.list()).toEqual([]);
  });

  test("list skips files that do not match the sess_ id format", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const a = await store.create({ name: "a", target: "cli", model: "m" });
    writeFileSync(join(rootDir, "stray.json"), "{}");
    writeFileSync(join(rootDir, "sess_short.json"), "{}");
    const listed = await store.list();
    expect(listed.length).toBe(1);
    expect(listed[0]?.id).toBe(a.id);
  });

  test("list is best-effort: a malformed surviving file is skipped, not fatal", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const good = await store.create({ name: "good", target: "cli", model: "m" });
    // A well-named, recently-mtimed file that survives the regex + TTL + stat
    // checks but throws inside readSession() when its JSON is parsed.
    const badId = "sess_badbadbadbad0000";
    writeFileSync(join(rootDir, `${badId}.json`), "{ not valid json");

    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const listed = await store.list();
      // The malformed file is logged-and-skipped; the good session survives.
      expect(listed.map((s) => s.id)).toEqual([good.id]);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]?.[0]).toContain(`skipping malformed session "${badId}"`);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("custom ttlDays is honoured", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir, ttlDays: 1 });
    const a = await store.create({ name: "a", target: "cli", model: "m" });
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(join(rootDir, `${a.id}.json`), old, old);
    const listed = await store.list();
    expect(listed).toEqual([]);
  });
});

describe("session-store — list stat() TOCTOU race (ENOENT skip)", () => {
  afterEach(() => {
    restoreRealFsPromises();
  });

  test("a file vanishing between readdir and stat is skipped, not fatal", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const present = await store.create({ name: "present", target: "cli", model: "m" });
    const racedId = "sess_aaaaaaaaaaaaaaaa";
    // Create a real file so readdir() returns it, but stat() will report it gone.
    writeFileSync(join(rootDir, `${racedId}.json`), "{}");

    const racedPath = join(rootDir, `${racedId}.json`);
    mock.module("node:fs/promises", () => ({
      ...REAL_FS_PROMISES,
      stat: async (p: string) => {
        if (typeof p === "string" && p === racedPath) {
          const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return realStat(p);
      },
    }));

    const listed = await store.list();
    // The raced file is silently skipped; the present session survives.
    expect(listed.map((s) => s.id)).toEqual([present.id]);
  });

  test("eviction swallows unlink rejections (best-effort .catch arrows)", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const a = await store.create({ name: "a", target: "cli", model: "m" });
    // Backdate so `a` is evicted on the next list().
    const old = new Date(Date.now() - 35 * 86_400_000);
    utimesSync(join(rootDir, `${a.id}.json`), old, old);

    // Make BOTH unlink calls (session file + sibling log) reject so the
    // `.catch(() => undefined)` callback bodies at the eviction site execute.
    mock.module("node:fs/promises", () => ({
      ...REAL_FS_PROMISES,
      unlink: async () => {
        throw new Error("EPERM: operation not permitted");
      },
    }));

    // Eviction must not throw even though every unlink rejects.
    const listed = await store.list();
    expect(listed).toEqual([]);
  });

  test("delete swallows a sibling-log unlink rejection", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const a = await store.create({ name: "a", target: "cli", model: "m" });

    const logPath = join(rootDir, `${a.id}.jsonl`);
    // Session-file unlink succeeds; the sibling-log unlink rejects, which the
    // trailing `.catch(() => undefined)` in delete() must swallow.
    mock.module("node:fs/promises", () => ({
      ...REAL_FS_PROMISES,
      unlink: async (p: string) => {
        if (typeof p === "string" && p === logPath) {
          throw new Error("EPERM: operation not permitted");
        }
        return realUnlink(p);
      },
    }));

    await store.delete(a.id);
    expect(existsSync(join(rootDir, `${a.id}.json`))).toBe(false);
  });

  test("a non-ENOENT stat error aborts the listing", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const present = await store.create({ name: "present", target: "cli", model: "m" });
    const targetPath = join(rootDir, `${present.id}.json`);
    mock.module("node:fs/promises", () => ({
      ...REAL_FS_PROMISES,
      stat: async (p: string) => {
        if (typeof p === "string" && p === targetPath) {
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realStat(p);
      },
    }));

    await expect(store.list()).rejects.toThrow(/EACCES/);
  });
});

describe("session-store — cross-tenant fencing (CWE-1230)", () => {
  test("inside tenantA, a store rooted under tenantB fails closed", async () => {
    const tenantsRoot = newTempRoot();
    const tenantA = buildTenant("tenant-a", { tenantsRoot });
    const tenantB = buildTenant("tenant-b", { tenantsRoot });
    // Store rooted under tenantB while the active context is tenantA — every
    // resolved file path escapes tenantA's sessionRoot, so reads/writes throw.
    const store = createSessionStore({ rootDir: tenantB.sessionRoot });
    await withTenant(tenantA, async () => {
      await expect(
        store.create({ id: "sess_aaaaaaaaaaaaaaaa", name: "x", target: "cli", model: "m" }),
      ).rejects.toThrow(TenancyError);
      await expect(store.get("sess_aaaaaaaaaaaaaaaa")).rejects.toThrow(
        /cross-tenant access denied/,
      );
    });
  });

  test("inside tenantA, a store rooted under tenantA succeeds", async () => {
    const tenantsRoot = newTempRoot();
    const tenantA = buildTenant("tenant-a", { tenantsRoot });
    const store = createSessionStore({ rootDir: tenantA.sessionRoot });
    await withTenant(tenantA, async () => {
      const created = await store.create({ name: "ok", target: "cli", model: "m" });
      const got = await store.get(created.id);
      expect(got?.id).toBe(created.id);
    });
  });

  test("no active tenant — behaviour is unchanged (no fencing)", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const created = await store.create({ name: "ok", target: "cli", model: "m" });
    expect(await store.get(created.id)).toEqual(created);
  });
});
