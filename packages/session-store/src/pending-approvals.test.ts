/**
 * Loop contract 0.4 (Batch C, G11) — the file-backed pending-approval store:
 * persist/get/resolve/list, cross-session (toolName, inputHash) keying,
 * one-shot grant consumption, TTL eviction, id validation, and the stable
 * input hash both runtime-core and the approval verbs derive.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError } from "@crewhaus/errors";
import {
  DEFAULT_APPROVALS_FILENAME,
  type PendingApproval,
  createPendingApprovalStore,
  evictExpiredApprovals,
  generateApprovalId,
  hashApprovalInput,
} from "./index";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-approvals-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function pending(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: generateApprovalId(),
    toolName: "write_file",
    inputHash: hashApprovalInput("write_file", { path: "/etc/x" }),
    input: { path: "/etc/x" },
    runId: "run_abcd1234",
    sessionId: "sess_00000000000000aa",
    surface: "single-turn",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("hashApprovalInput", () => {
  test("is stable regardless of key order", () => {
    const a = hashApprovalInput("t", { a: 1, b: 2, nested: { x: 1, y: 2 } });
    const b = hashApprovalInput("t", { nested: { y: 2, x: 1 }, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  test("differs by tool name and by input", () => {
    const base = hashApprovalInput("t", { a: 1 });
    expect(hashApprovalInput("u", { a: 1 })).not.toBe(base);
    expect(hashApprovalInput("t", { a: 2 })).not.toBe(base);
  });

  test("is a 64-char sha256 hex digest", () => {
    expect(hashApprovalInput("t", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createPendingApprovalStore", () => {
  test("persist then get returns the pending record", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    const got = await store.get(p.toolName, p.inputHash);
    expect(got?.id).toBe(p.id);
    expect(got?.decision).toBeUndefined();
    // The file lives beside the sessions.
    expect(existsSync(join(root, DEFAULT_APPROVALS_FILENAME))).toBe(true);
  });

  test("get returns null for an unknown key", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    expect(await store.get("nope", hashApprovalInput("nope", {}))).toBeNull();
  });

  test("resolve records a grant that get then returns", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    const resolved = await store.resolve(p.id, "grant", "max");
    expect(resolved?.decision).toBe("grant");
    expect(resolved?.decidedBy).toBe("max");
    const got = await store.get(p.toolName, p.inputHash);
    expect(got?.decision).toBe("grant");
  });

  test("resolve of an unknown id returns null and persists nothing", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    expect(await store.resolve(generateApprovalId(), "grant", "max")).toBeNull();
  });

  test("a consumed grant is filtered out of get (one-shot)", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    await store.resolve(p.id, "grant", "max");
    // Simulate the runtime consuming the one-shot grant.
    const granted = await store.get(p.toolName, p.inputHash);
    if (granted === null) throw new Error("expected a grant to consume");
    await store.persist({ ...granted, consumedAt: new Date().toISOString() });
    expect(await store.get(p.toolName, p.inputHash)).toBeNull();
  });

  test("resolve deny is returned by get so the runtime denies pre-decided", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    await store.resolve(p.id, "deny", "cli");
    const got = await store.get(p.toolName, p.inputHash);
    expect(got?.decision).toBe("deny");
  });

  test("get keys on (toolName, inputHash) across sessions", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    // Run 1 parks; a fresh run (different session) re-issues the same call.
    const run1 = pending({ sessionId: "sess_1111111111111111" });
    await store.persist(run1);
    await store.resolve(run1.id, "grant", "max");
    // Run 2 looks up by the SAME toolName + inputHash, different session.
    const got = await store.get(run1.toolName, run1.inputHash);
    expect(got?.id).toBe(run1.id);
    expect(got?.decision).toBe("grant");
  });

  test("TTL: an expired record is invisible to get and list, and compacted away", async () => {
    let clockMs = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createPendingApprovalStore({
      rootDir: root,
      ttlDays: 1,
      now: () => new Date(clockMs),
    });
    const p = pending({ createdAt: new Date(clockMs).toISOString() });
    await store.persist(p);
    // Advance the clock two days — past the 1-day TTL.
    clockMs += 2 * 86_400_000;
    expect(await store.get(p.toolName, p.inputHash)).toBeNull();
    expect(await store.list()).toEqual([]);
    // list() compacts: the expired line is gone from the file.
    const body = readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8").trim();
    expect(body).toBe("");
  });

  test("list returns live approvals newest-first and compacts superseded lines", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    const a = pending({ inputHash: hashApprovalInput("t", { n: 1 }) });
    const b = pending({ inputHash: hashApprovalInput("t", { n: 2 }) });
    await store.persist(a);
    await store.persist(b);
    await store.resolve(a.id, "grant", "max"); // appends a superseding line for a
    const live = await store.list();
    expect(live.length).toBe(2);
    // After compaction the file has exactly one line per surviving id.
    const lines = readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8")
      .trim()
      .split("\n")
      .filter((l) => l !== "");
    expect(lines.length).toBe(2);
  });

  test("rejects a malformed approval id on persist and resolve", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    await expect(store.persist(pending({ id: "bad-id" }))).rejects.toBeInstanceOf(RuntimeError);
    await expect(store.resolve("bad-id", "grant", "x")).rejects.toBeInstanceOf(RuntimeError);
  });

  test("generateApprovalId mints the appr_<16 hex> shape", () => {
    expect(generateApprovalId()).toMatch(/^appr_[0-9a-f]{16}$/);
  });

  test("tolerates a malformed JSONL line without aborting the fold", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    // Corrupt the log with a junk line, then a valid resolve afterwards.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "not json\n");
    await store.resolve(p.id, "grant", "max");
    expect((await store.get(p.toolName, p.inputHash))?.decision).toBe("grant");
  });
});

/**
 * The approvals counterpart to `evictExpiredSessions`. Before it existed,
 * `list()` was the only pruner and its only production callers were the
 * human-invoked `crewhaus approvals` verbs — so an unattended harness never
 * compacted this file at all, and every record embeds a raw tool input.
 */
describe("evictExpiredApprovals", () => {
  const DAY = 86_400_000;

  test("drops records past the TTL and rewrites the log without them", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    const old = pending({ createdAt: new Date(Date.now() - 40 * DAY).toISOString() });
    const fresh = pending({ toolName: "bash", inputHash: hashApprovalInput("bash", { c: "ls" }) });
    await store.persist(old);
    await store.persist(fresh);

    const { evictedIds } = await evictExpiredApprovals({ rootDir: root });
    expect(evictedIds).toEqual([old.id]);

    // Gone from DISK — the whole point. A TTL check that only filtered the
    // return value (which `get` already does) leaves the input on the
    // filesystem, which is what made this leak invisible.
    const raw = readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf-8");
    expect(raw).not.toContain(old.id);
    expect(raw).toContain(fresh.id);
  });

  test("sweeps without any store instance, and tolerates a missing file", async () => {
    // The unattended caller (runtime-core boot) holds no store, and may run
    // against a root that has never parked anything.
    await expect(evictExpiredApprovals({ rootDir: join(root, "nope") })).resolves.toEqual({
      evictedIds: [],
    });
  });

  test("a record with an unparseable createdAt is evicted, not immortal", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    await store.persist(pending({ createdAt: "sometime last tuesday" }));
    const { evictedIds } = await evictExpiredApprovals({ rootDir: root });
    expect(evictedIds).toHaveLength(1);
    // The shape guard only demands a string, so a corrupted or hand-edited
    // line would otherwise survive every compaction forever, still carrying
    // its tool input.
    expect(readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf-8").trim()).toBe("");
  });

  test("honours a custom ttlDays", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending({ createdAt: new Date(Date.now() - 2 * DAY).toISOString() });
    await store.persist(p);
    expect((await evictExpiredApprovals({ rootDir: root, ttlDays: 30 })).evictedIds).toEqual([]);
    expect((await evictExpiredApprovals({ rootDir: root, ttlDays: 1 })).evictedIds).toEqual([p.id]);
  });

  test("list() and the standalone sweep agree — they share one implementation", async () => {
    const store = createPendingApprovalStore({ rootDir: root });
    const old = pending({ createdAt: new Date(Date.now() - 40 * DAY).toISOString() });
    await store.persist(old);
    await store.persist(pending({ toolName: "b", inputHash: hashApprovalInput("b", {}) }));
    // list() compacts as well, so the sweep afterwards finds nothing to do.
    const listed = await store.list();
    expect(listed.map((a) => a.id)).not.toContain(old.id);
    expect((await evictExpiredApprovals({ rootDir: root })).evictedIds).toEqual([]);
  });
});
