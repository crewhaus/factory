/**
 * Interop with the legacy watchme registry: the one-time seed merge and the
 * best-effort write-through that keeps `harnesses.json` (v2) and the
 * watchme `harnesses.json` (v1) in sync. Everything goes through
 * `@crewhaus/watchme-store`'s public API — the watchme file format is never
 * touched directly, here or in the implementation.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("write-through (dual-write)", () => {
  test("upsert writes through to the watchme registry; remove deregisters", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "synced");
    const reg = openReg(root, { now: () => 1_000 });
    reg.upsert({ dir: harness, specName: "synced", target: "cli", watchme: { share: true } });

    const legacy = openWatchmeRegistry(watchmeRootOf(root), { onWarn: () => {} });
    const mirrored = legacy.list().find((e) => e.dir === harness);
    expect(mirrored?.specName).toBe("synced");
    expect(mirrored?.target).toBe("cli");
    expect(mirrored?.share).toBe(true);

    reg.remove(harness);
    expect(legacy.list().find((e) => e.dir === harness)).toBeUndefined();
  });

  test("a refresh preserves the agentId the watchme registry already had", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "agented");
    const legacy = openWatchmeRegistry(watchmeRootOf(root), { now: () => 1_000 });
    legacy.register({ dir: harness, specName: "agented", target: "cli", agentId: "agent-42" });

    const reg = openReg(root, { now: () => 2_000 });
    reg.upsert({ dir: harness, specName: "agented-v2", target: "channel" });

    const mirrored = legacy.list().find((e) => e.dir === harness);
    expect(mirrored?.specName).toBe("agented-v2");
    expect(mirrored?.agentId).toBe("agent-42");
  });

  test("relocate moves the watchme row to the new dir", () => {
    const root = newRoot();
    const oldDir = newHarnessDir(root, "old-spot");
    const newDir = newHarnessDir(root, "new-spot");
    const reg = openReg(root);
    const entry = reg.upsert({ dir: oldDir, specName: "mover", target: "cli" });
    reg.relocate(entry.id, newDir);

    const legacy = openWatchmeRegistry(watchmeRootOf(root), { onWarn: () => {} });
    const dirs = legacy.list().map((e) => e.dir);
    expect(dirs).toContain(newDir);
    expect(dirs).not.toContain(oldDir);
  });

  test("a failing watchme write-through never fails the primary write", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "resilient");
    const blocker = join(root, "a-file");
    // watchme root nested under a regular FILE → its mkdir must fail.
    mkdirSync(join(root, "registry"), { recursive: true });
    writeFileSync(blocker, "not a dir", "utf8");
    const warnings: string[] = [];
    const reg = openHangarRegistry({
      root: join(root, "registry"),
      watchmeRoot: join(blocker, "watchme"),
      env: {},
      onWarn: (message) => warnings.push(message),
    });
    const entry = reg.upsert({ dir: harness, specName: "resilient", target: "cli" });
    expect(entry.id).toMatch(/^hrn_[0-9a-f]{16}$/);
    expect(reg.list().map((e) => e.dir)).toEqual([harness]);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain("write-through failed");
  });

  test("NO_REGISTRY suppresses the write-through too", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "frozen");
    const frozen = openReg(root, { env: { CREWHAUS_NO_REGISTRY: "1" } });
    frozen.upsert({ dir: harness, specName: "frozen", target: "cli" });
    expect(existsSync(join(watchmeRootOf(root), "harnesses.json"))).toBe(false);
  });

  test("both files stay in agreement after a mixed sequence", () => {
    const root = newRoot();
    const a = newHarnessDir(root, "a");
    const b = newHarnessDir(root, "b");
    const reg = openReg(root);
    reg.upsert({ dir: a, specName: "a", target: "cli" });
    reg.upsert({ dir: b, specName: "b", target: "channel", watchme: { share: true } });
    reg.remove(a);

    const legacy = openWatchmeRegistry(watchmeRootOf(root), { onWarn: () => {} });
    expect(legacy.list().map((e) => e.dir)).toEqual([b]);
    expect(reg.list().map((e) => e.dir)).toEqual([b]);

    // The watchme file is 0600, as its own store writes it.
    const watchmeFile = join(watchmeRootOf(root), "harnesses.json");
    expect(readFileSync(watchmeFile, "utf8")).toContain(b);
  });
});
