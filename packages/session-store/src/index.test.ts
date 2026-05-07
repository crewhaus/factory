import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./index";

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
