/**
 * Interop with the legacy watchme registry: the one-time seed merge and the
 * best-effort freshness mirror. The policy under test: watchme membership
 * means EXPLICITLY WATCHED — hangar-side writes (upsert/registerHook/scan/
 * server CRUD) never create a watchme row, never delete one, and never touch
 * `share`/`agentId`; only dir/specName/target freshness of a pre-existing
 * row is mirrored. Everything goes through `@crewhaus/watchme-store`'s
 * public API — the watchme file format is never touched directly, here or
 * in the implementation.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarnessRegistry as openWatchmeRegistry } from "@crewhaus/watchme-store";
import { openHangarRegistry } from "./registry";

const TMP_ROOTS: string[] = [];
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-harness-registry-interop-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function newHarnessDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const watchmeRootOf = (root: string): string => join(root, "watchme-global");

function openReg(root: string, extra: Parameters<typeof openHangarRegistry>[0] = {}) {
  return openHangarRegistry({
    root: join(root, "registry"),
    watchmeRoot: watchmeRootOf(root),
    env: {},
    ...extra,
  });
}

describe("seedFromWatchme", () => {
  test("imports watchme entries once with origin import/watchme; idempotent on re-seed", () => {
    const root = newRoot();
    const shared = newHarnessDir(root, "shared-bot");
    const plain = newHarnessDir(root, "plain-bot");
    const legacy = openWatchmeRegistry(watchmeRootOf(root), { now: () => 1_000 });
    legacy.register({ dir: shared, specName: "shared-bot", target: "channel", share: true });
    legacy.register({ dir: plain, specName: "plain-bot", target: "cli", agentId: "agent-9" });

    const reg = openReg(root, { now: () => 5_000 });
    expect(reg.seedFromWatchme()).toEqual({ imported: 2 });

    const byDir = new Map(reg.list().map((e) => [e.dir, e]));
    const sharedEntry = byDir.get(shared);
    expect(sharedEntry?.origin).toBe("import");
    expect(sharedEntry?.originDetail).toBe("watchme");
    expect(sharedEntry?.watchme.share).toBe(true);
    expect(sharedEntry?.registeredAt).toBe("1970-01-01T00:00:01.000Z");
    expect(byDir.get(plain)?.watchme.share).toBe(false);
    expect(byDir.get(plain)?.["agentId"]).toBe("agent-9"); // carried as pass-through

    // Safe to call every boot: no dupes, no rewrite churn.
    expect(reg.seedFromWatchme()).toEqual({ imported: 0 });
    expect(reg.list().length).toBe(2);
  });

  test("a dir already registered here is left untouched by the seed", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "mine-first");
    const legacy = openWatchmeRegistry(watchmeRootOf(root), { now: () => 1_000 });
    legacy.register({ dir: harness, specName: "their-name", target: "channel" });

    const reg = openReg(root, { now: () => 5_000 });
    const original = reg.upsert({ dir: harness, specName: "my-name", target: "cli" });
    expect(reg.seedFromWatchme()).toEqual({ imported: 0 });
    const kept = reg.get(harness);
    expect(kept?.id).toBe(original.id);
    expect(kept?.specName).toBe("my-name");
    expect(kept?.origin).toBe("manual");
  });

  test("no watchme registry at all seeds zero without creating anything", () => {
    const root = newRoot();
    const reg = openReg(root);
    expect(reg.seedFromWatchme()).toEqual({ imported: 0 });
    expect(existsSync(join(root, "registry", "harnesses.json"))).toBe(false);
  });
});

describe("freshness mirror (hangar → watchme)", () => {
  test("upsert of a never-watched dir creates no watchme row — not even a watchme file", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "unwatched");
    const reg = openReg(root);
    // Even a hangar row that CARRIES a share flag never enrolls: membership
    // belongs to the watchme verbs alone.
    reg.upsert({ dir: harness, specName: "unwatched", target: "cli", watchme: { share: true } });
    expect(existsSync(join(watchmeRootOf(root), "harnesses.json"))).toBe(false);
  });

  test("a share:true watchme row survives a fresh-hangar-row hook upsert", () => {
    // The F-1 clobber scenario: enrolled via `watchme start` with share:true,
    // hangar has never seen the dir, then `crewhaus run` fires the hook. The
    // fresh hangar row defaults watchme.share=false — the mirror must not
    // push that default onto the explicitly-enrolled row.
    const root = newRoot();
    const harness = newHarnessDir(root, "shared");
    const legacy = openWatchmeRegistry(watchmeRootOf(root), { now: () => 1_000 });
    legacy.register({ dir: harness, specName: "shared", target: "cli", share: true });

    const reg = openReg(root, { now: () => 2_000 });
    const hook = reg.registerHook({
      dir: harness,
      specName: "shared",
      target: "cli",
      originDetail: "run",
    });
    expect(hook.ok).toBe(true);
    expect(reg.get(harness)?.watchme.share).toBe(false); // hangar default…
    expect(legacy.list().find((e) => e.dir === harness)?.share).toBe(true); // …never mirrored
  });

  test("a refresh mirrors specName/target freshness but preserves share and agentId", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "agented");
    const legacy = openWatchmeRegistry(watchmeRootOf(root), { now: () => 1_000 });
    legacy.register({
      dir: harness,
      specName: "agented",
      target: "cli",
      share: true,
      agentId: "agent-42",
    });

    const reg = openReg(root, { now: () => 2_000 });
    reg.upsert({ dir: harness, specName: "agented-v2", target: "channel" });

    const mirrored = legacy.list().find((e) => e.dir === harness);
    expect(mirrored?.specName).toBe("agented-v2");
    expect(mirrored?.target).toBe("channel");
    expect(mirrored?.share).toBe(true);
    expect(mirrored?.agentId).toBe("agent-42");
  });

  test("hangar remove never deletes a watchme row", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "kept-watched");
    const legacy = openWatchmeRegistry(watchmeRootOf(root), { now: () => 1_000 });
    legacy.register({ dir: harness, specName: "kept-watched", target: "cli", share: true });

    const reg = openReg(root);
    reg.upsert({ dir: harness, specName: "kept-watched", target: "cli" });
    expect(reg.remove(harness)).toBe(true);
    expect(reg.get(harness)).toBeUndefined();
    // Still explicitly watched: only `watchme stop --forget` un-enrolls.
    expect(legacy.list().find((e) => e.dir === harness)?.share).toBe(true);
  });

  test("watchme stop --forget stays durable: later hangar refreshes never re-enroll", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "forgotten");
    const legacy = openWatchmeRegistry(watchmeRootOf(root), { now: () => 1_000 });
    legacy.register({ dir: harness, specName: "forgotten", target: "cli" });

    const reg = openReg(root);
    reg.upsert({ dir: harness, specName: "forgotten", target: "cli" });
    legacy.deregister(harness); // what `watchme stop --forget` does
    // The surviving hangar row keeps getting touched by command hooks…
    reg.upsert({ dir: harness, specName: "forgotten", target: "cli" });
    reg.registerHook({ dir: harness, originDetail: "run" });
    // …but the watchme registry never regains the row.
    expect(legacy.list().find((e) => e.dir === harness)).toBeUndefined();
  });

  test("relocate moves a pre-existing watchme row (share/agentId intact); never creates one", () => {
    const root = newRoot();
    const oldDir = newHarnessDir(root, "old-spot");
    const newDir = newHarnessDir(root, "new-spot");
    const legacy = openWatchmeRegistry(watchmeRootOf(root), { now: () => 1_000 });
    legacy.register({
      dir: oldDir,
      specName: "mover",
      target: "cli",
      share: true,
      agentId: "agent-7",
    });

    const reg = openReg(root);
    const entry = reg.upsert({ dir: oldDir, specName: "mover", target: "cli" });
    reg.relocate(entry.id, newDir);
    const rows = legacy.list();
    expect(rows.map((e) => e.dir)).not.toContain(oldDir);
    const moved = rows.find((e) => e.dir === newDir);
    expect(moved?.share).toBe(true);
    expect(moved?.agentId).toBe("agent-7");

    // A never-watched harness relocates without gaining a watchme row.
    const plainOld = newHarnessDir(root, "plain-old");
    const plainNew = newHarnessDir(root, "plain-new");
    const plain = reg.upsert({ dir: plainOld, specName: "plain", target: "cli" });
    reg.relocate(plain.id, plainNew);
    const dirs = legacy.list().map((e) => e.dir);
    expect(dirs).not.toContain(plainOld);
    expect(dirs).not.toContain(plainNew);
  });

  test("a failing watchme mirror never fails the primary write", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "resilient");
    // A PRE-EXISTING watchme row, so the mirror attempts a register write…
    const legacy = openWatchmeRegistry(watchmeRootOf(root), { now: () => 1_000 });
    legacy.register({ dir: harness, specName: "resilient", target: "cli" });
    const warnings: string[] = [];
    const reg = openReg(root, { onWarn: (message) => warnings.push(message) });
    // …against a read-only watchme root (reads fine, tmp-file write fails).
    chmodSync(watchmeRootOf(root), 0o500);
    try {
      const entry = reg.upsert({ dir: harness, specName: "resilient-v2", target: "cli" });
      expect(entry.id).toMatch(/^hrn_[0-9a-f]{16}$/);
      expect(reg.list().map((e) => e.dir)).toEqual([harness]);
    } finally {
      chmodSync(watchmeRootOf(root), 0o700);
    }
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain("write-through failed");
  });

  test("NO_REGISTRY suppresses the mirror too", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "frozen");
    const frozen = openReg(root, { env: { CREWHAUS_NO_REGISTRY: "1" } });
    frozen.upsert({ dir: harness, specName: "frozen", target: "cli" });
    expect(existsSync(join(watchmeRootOf(root), "harnesses.json"))).toBe(false);
  });
});
