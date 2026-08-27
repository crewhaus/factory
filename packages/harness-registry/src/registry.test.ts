import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHangarRegistry, registerHarnessHook } from "./registry";
import type { OpenHangarRegistryOptions } from "./registry";

const TMP_ROOTS: string[] = [];
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-harness-registry-"));
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

/** Open a registry fully isolated from the real environment and the real
 *  watchme root (write-through lands under the temp root). */
function openReg(root: string, extra: OpenHangarRegistryOptions = {}) {
  return openHangarRegistry({
    root: join(root, "registry"),
    watchmeRoot: join(root, "watchme-global"),
    env: {},
    ...extra,
  });
}

const regFile = (root: string): string => join(root, "registry", "harnesses.json");
const readRaw = (root: string): Record<string, unknown> =>
  JSON.parse(readFileSync(regFile(root), "utf8")) as Record<string, unknown>;

const ID_RE = /^hrn_[0-9a-f]{16}$/;

describe("upsert + minting", () => {
  test("first upsert creates a 0600 v2 document with a minted hrn_ id and defaults", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "helpdesk");
    const reg = openReg(root, { now: () => 1_000 });
    const entry = reg.upsert({ dir: harness, specName: "helpdesk", target: "cli" });

    expect(entry.id).toMatch(ID_RE);
    expect(entry.registeredAt).toBe("1970-01-01T00:00:01.000Z");
    expect(entry.lastSeen).toBe("1970-01-01T00:00:01.000Z");
    expect(entry.origin).toBe("manual");
    expect(entry.groups).toEqual([]);
    expect(entry.tags).toEqual([]);
    expect(entry.pinned).toBe(false);
    expect(entry.notes).toBe("");
    expect(entry.kind).toBe("local");
    expect(entry.watchme).toEqual({ share: false });
    expect(entry.remotes).toEqual([]);
    expect(entry.missingSince).toBeNull();

    expect(statSync(regFile(root)).mode & 0o777).toBe(0o600);
    const raw = readRaw(root);
    expect(raw["v"]).toBe(2);
    expect((raw["harnesses"] as unknown[]).length).toBe(1);
    expect(raw["scanRoots"]).toEqual([]);
    expect(raw["groups"]).toEqual([]);
  });

  test("id and registeredAt are stable across upserts; lastSeen/specName/target refresh", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "helpdesk");
    let clock = 1_000;
    const reg = openReg(root, { now: () => clock });
    const first = reg.upsert({ dir: harness, specName: "helpdesk", target: "cli" });
    clock = 2_000;
    const second = reg.upsert({ dir: harness, specName: "helpdesk-v2", target: "channel" });

    expect(second.id).toBe(first.id);
    expect(second.registeredAt).toBe(first.registeredAt);
    expect(second.lastSeen).toBe("1970-01-01T00:00:02.000Z");
    expect(second.specName).toBe("helpdesk-v2");
    expect(second.target).toBe("channel");
    expect(reg.list().length).toBe(1);

    // Stability survives a reopen (persisted, not per-handle).
    const reopened = openReg(root).get(harness);
    expect(reopened?.id).toBe(first.id);
  });

  test("a refresh never clobbers groups/tags/pinned/notes, and origin stays first-registration", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "helpdesk");
    const reg = openReg(root, { now: () => 1_000 });
    reg.upsert({
      dir: harness,
      specName: "h",
      target: "cli",
      origin: "scan",
      originDetail: "boot",
    });
    reg.setGroups(harness, ["prod"]);
    reg.setTags(harness, ["slack"]);
    reg.setPinned(harness, true);
    reg.setHidden(harness, true);
    reg.setNotes(harness, "keep me");

    const refreshed = reg.upsert({
      dir: harness,
      specName: "h2",
      target: "channel",
      origin: "run-hook",
      originDetail: "run",
      groups: ["ignored"],
      tags: ["ignored"],
      pinned: false,
      notes: "ignored",
    });
    expect(refreshed.groups).toEqual(["prod"]);
    expect(refreshed.tags).toEqual(["slack"]);
    expect(refreshed.pinned).toBe(true);
    expect(refreshed.hidden).toBe(true);
    expect(refreshed.notes).toBe("keep me");
    expect(refreshed.origin).toBe("scan");
    expect(refreshed.originDetail).toBe("boot");
    expect(refreshed.specName).toBe("h2");
  });

  test("upsert defaults specName to the dir basename and target to unknown", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "bare-bot");
    const entry = openReg(root).upsert({ dir: harness });
    expect(entry.specName).toBe("bare-bot");
    expect(entry.target).toBe("unknown");
  });

  test("upsert refreshes watchme.share and remotes when provided", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "sharer");
    const reg = openReg(root);
    reg.upsert({ dir: harness, specName: "s", target: "cli" });
    const updated = reg.upsert({
      dir: harness,
      watchme: { share: true },
      remotes: [{ kind: "fly", app: "s" }],
    });
    expect(updated.watchme.share).toBe(true);
    expect(updated.remotes).toEqual([{ kind: "fly", app: "s" }]);
  });
});

describe("get / remove / relocate", () => {
  test("get works by dir and by id", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "helpdesk");
    const reg = openReg(root);
    const entry = reg.upsert({ dir: harness, specName: "h", target: "cli" });
    expect(reg.get(harness)?.id).toBe(entry.id);
    expect(reg.get(entry.id)?.dir).toBe(harness);
    expect(reg.get("hrn_0000000000000000")).toBeUndefined();
    expect(reg.get(join(root, "nope"))).toBeUndefined();
  });

  test("remove deletes the registry row only — the directory survives", () => {
    const root = newRoot();
    const a = newHarnessDir(root, "a");
    const b = newHarnessDir(root, "b");
    const reg = openReg(root);
    const entryA = reg.upsert({ dir: a, specName: "a", target: "cli" });
    reg.upsert({ dir: b, specName: "b", target: "cli" });

    expect(reg.remove(entryA.id)).toBe(true);
    expect(reg.remove(entryA.id)).toBe(false);
    expect(reg.list().map((e) => e.dir)).toEqual([b]);
    expect(existsSync(a)).toBe(true);
    expect(reg.remove(b)).toBe(true);
    expect(reg.list()).toEqual([]);
  });

  test("relocate keeps the id, moves the dir, clears missingSince", () => {
    const root = newRoot();
    const oldDir = newHarnessDir(root, "old-home");
    const reg = openReg(root, { now: () => 5_000 });
    const entry = reg.upsert({ dir: oldDir, specName: "mover", target: "cli" });
    rmSync(oldDir, { recursive: true, force: true });
    expect(reg.list()[0]?.missingSince).not.toBeNull();

    const newDir = newHarnessDir(root, "new-home");
    const moved = reg.relocate(entry.id, newDir);
    expect(moved?.id).toBe(entry.id);
    expect(moved?.dir).toBe(newDir);
    expect(moved?.missingSince).toBeNull();
    expect(reg.list().map((e) => e.dir)).toEqual([newDir]);

    expect(reg.relocate("hrn_0000000000000000", newDir)).toBeUndefined();
  });

  test("relocate onto another entry's dir throws", () => {
    const root = newRoot();
    const a = newHarnessDir(root, "a");
    const b = newHarnessDir(root, "b");
    const reg = openReg(root);
    const entryA = reg.upsert({ dir: a, specName: "a", target: "cli" });
    reg.upsert({ dir: b, specName: "b", target: "cli" });
    expect(() => reg.relocate(entryA.id, b)).toThrow(/already registered/);
  });
});

describe("missing-dir stamping", () => {
  test("list stamps missingSince, persists it, never prunes, and clears it on return", () => {
    const root = newRoot();
    const doomed = newHarnessDir(root, "doomed");
    const alive = newHarnessDir(root, "alive");
    let clock = 1_000;
    const reg = openReg(root, { now: () => clock });
    reg.upsert({ dir: doomed, specName: "doomed", target: "cli" });
    reg.upsert({ dir: alive, specName: "alive", target: "cli" });

    rmSync(doomed, { recursive: true, force: true });
    clock = 9_000;
    const listed = reg.list();
    expect(listed.length).toBe(2); // NEVER silently pruned
    const stamped = listed.find((e) => e.dir === doomed);
    expect(stamped?.missingSince).toBe("1970-01-01T00:00:09.000Z");

    // The stamp persisted to disk, and the file still holds both rows.
    const raw = readRaw(root);
    expect((raw["harnesses"] as unknown[]).length).toBe(2);
    const onDisk = (raw["harnesses"] as Record<string, unknown>[]).find((e) => e["dir"] === doomed);
    expect(onDisk?.["missingSince"]).toBe("1970-01-01T00:00:09.000Z");

    // Dir comes back → stamp cleared (and persisted).
    mkdirSync(doomed, { recursive: true });
    clock = 10_000;
    expect(reg.list().find((e) => e.dir === doomed)?.missingSince).toBeNull();
    const healedRow = (readRaw(root)["harnesses"] as Record<string, unknown>[]).find(
      (e) => e["dir"] === doomed,
    );
    expect(healedRow?.["missingSince"]).toBeNull();
  });

  test("an existing missingSince stamp is not re-stamped on later lists", () => {
    const root = newRoot();
    const doomed = newHarnessDir(root, "doomed");
    let clock = 1_000;
    const reg = openReg(root, { now: () => clock });
    reg.upsert({ dir: doomed, specName: "doomed", target: "cli" });
    rmSync(doomed, { recursive: true, force: true });
    clock = 2_000;
    reg.list();
    clock = 3_000;
    expect(reg.list()[0]?.missingSince).toBe("1970-01-01T00:00:02.000Z");
  });

  test("list({includeMissing: false}) filters missing entries from the view only", () => {
    const root = newRoot();
    const doomed = newHarnessDir(root, "doomed");
    const alive = newHarnessDir(root, "alive");
    const reg = openReg(root);
    reg.upsert({ dir: doomed, specName: "doomed", target: "cli" });
    reg.upsert({ dir: alive, specName: "alive", target: "cli" });
    rmSync(doomed, { recursive: true, force: true });

    expect(reg.list({ includeMissing: false }).map((e) => e.dir)).toEqual([alive]);
    expect(reg.list().length).toBe(2);
    expect((readRaw(root)["harnesses"] as unknown[]).length).toBe(2);
  });

  test("an upsert of a missing-stamped dir clears the stamp", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "flappy");
    const reg = openReg(root);
    reg.upsert({ dir: harness, specName: "f", target: "cli" });
    rmSync(harness, { recursive: true, force: true });
    reg.list();
    mkdirSync(harness, { recursive: true });
    expect(reg.upsert({ dir: harness }).missingSince).toBeNull();
  });
});

describe("migrate-on-read (v1 lift)", () => {
  test("a v1 watchme-format document lifts to v2 with minted ids and ISO timestamps", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "legacy");
    const registryRoot = join(root, "registry");
    mkdirSync(registryRoot, { recursive: true });
    writeFileSync(
      regFile(root),
      JSON.stringify({
        v: 1,
        harnesses: [
          {
            dir: harness,
            specName: "legacy",
            target: "cli",
            share: true,
            agentId: "agent-7",
            registeredAt: 1_000,
            lastSeen: 2_000,
          },
        ],
      }),
      "utf8",
    );

    const reg = openReg(root, { now: () => 5_000 });
    const listed = reg.list();
    expect(listed.length).toBe(1);
    const entry = listed[0];
    expect(entry?.id).toMatch(ID_RE);
    expect(entry?.origin).toBe("import");
    expect(entry?.originDetail).toBe("watchme");
    expect(entry?.registeredAt).toBe("1970-01-01T00:00:01.000Z");
    expect(entry?.lastSeen).toBe("1970-01-01T00:00:02.000Z");
    expect(entry?.watchme.share).toBe(true);
    expect(entry?.["share"]).toBeUndefined(); // moved into the watchme block
    expect(entry?.["agentId"]).toBe("agent-7"); // unknown field carried along

    // list() healed the file to v2, persisting the minted id.
    const raw = readRaw(root);
    expect(raw["v"]).toBe(2);
    const persisted = (raw["harnesses"] as Record<string, unknown>[])[0];
    expect(persisted?.["id"]).toBe(entry?.id);

    // A fresh handle sees the SAME id: minting happened once.
    expect(openReg(root).list()[0]?.id).toBe(entry?.id);
  });

  test("a read never creates a registry file that does not exist", () => {
    const root = newRoot();
    const reg = openReg(root);
    expect(reg.list()).toEqual([]);
    expect(existsSync(regFile(root))).toBe(false);
  });

  test("a garbage file reads as empty and is not clobbered by the read; the next write heals it", () => {
    const root = newRoot();
    const registryRoot = join(root, "registry");
    mkdirSync(registryRoot, { recursive: true });
    writeFileSync(regFile(root), "{ not json", "utf8");
    const reg = openReg(root);
    expect(reg.list()).toEqual([]);
    expect(readFileSync(regFile(root), "utf8")).toBe("{ not json"); // read left it alone
    const harness = newHarnessDir(root, "healer");
    reg.upsert({ dir: harness, specName: "healer", target: "cli" });
    expect(readRaw(root)["v"]).toBe(2);
    expect(reg.list().length).toBe(1);
  });

  test("list() degrades to the computed view when a missing-dir stamp cannot persist", () => {
    // Read surfaces must survive an unwritable registry root (root-owned
    // ~/.crewhaus, read-only home fs): the stamp heal is best-effort, the
    // entries still come back, and the failure is reported via onWarn.
    const root = newRoot();
    const harness = newHarnessDir(root, "doomed");
    const warnings: string[] = [];
    const reg = openReg(root, { onWarn: (message) => warnings.push(message) });
    reg.upsert({ dir: harness, specName: "doomed", target: "cli" });
    rmSync(harness, { recursive: true, force: true }); // → next list wants to stamp
    chmodSync(join(root, "registry"), 0o500); // readable, unwritable
    try {
      const listed = reg.list();
      expect(listed.length).toBe(1);
      expect(typeof listed[0]?.missingSince).toBe("string"); // stamped in the view…
    } finally {
      chmodSync(join(root, "registry"), 0o700);
    }
    // …but not on disk, and the read did not throw.
    const persisted = (readRaw(root)["harnesses"] as Record<string, unknown>[])[0];
    expect(persisted?.["missingSince"]).toBeNull();
    expect(warnings.some((w) => w.includes("could not persist"))).toBe(true);
  });

  test("list() degrades on an unwritable root with a pending v1 lift, then heals when writable", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "legacy-ro");
    const registryRoot = join(root, "registry");
    mkdirSync(registryRoot, { recursive: true });
    const v1 = JSON.stringify({
      v: 1,
      harnesses: [
        {
          dir: harness,
          specName: "legacy-ro",
          target: "cli",
          registeredAt: 1_000,
          lastSeen: 2_000,
        },
      ],
    });
    writeFileSync(regFile(root), v1, "utf8");
    const warnings: string[] = [];
    const reg = openReg(root, { onWarn: (message) => warnings.push(message) });
    chmodSync(registryRoot, 0o500);
    let liftedId: string | undefined;
    try {
      const listed = reg.list(); // lift wants persisting — write fails, view survives
      expect(listed.length).toBe(1);
      liftedId = listed[0]?.id;
      expect(liftedId).toMatch(ID_RE);
      expect(readFileSync(regFile(root), "utf8")).toBe(v1); // still v1 on disk
      expect(warnings.some((w) => w.includes("could not persist"))).toBe(true);
    } finally {
      chmodSync(registryRoot, 0o700);
    }
    // Once the root is writable again the same handle heals with the SAME id.
    const healed = reg.list();
    expect(healed[0]?.id).toBe(liftedId);
    expect(readRaw(root)["v"]).toBe(2);
  });

  test("malformed rows inside an otherwise-valid file are skipped", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "ok");
    const registryRoot = join(root, "registry");
    mkdirSync(registryRoot, { recursive: true });
    writeFileSync(
      regFile(root),
      JSON.stringify({
        v: 2,
        harnesses: [
          { id: "hrn_00000000000000aa", dir: harness, specName: "ok", target: "cli" },
          { specName: "no-dir" },
          "not an entry",
          42,
        ],
        scanRoots: [{ notDir: true }],
        groups: [{ color: "#fff" }],
      }),
      "utf8",
    );
    const reg = openReg(root);
    expect(reg.list().map((e) => e.specName)).toEqual(["ok"]);
    expect(reg.listScanRoots()).toEqual([]);
    expect(reg.listGroups()).toEqual([]);
  });
});

describe("unknown-field preservation (additive-format discipline)", () => {
  test("top-level, entry-level, nested-watchme, scan-root, and group extras survive a rewrite", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "future");
    const other = newHarnessDir(root, "other");
    const registryRoot = join(root, "registry");
    mkdirSync(registryRoot, { recursive: true });
    writeFileSync(
      regFile(root),
      JSON.stringify({
        v: 2,
        futureTop: { keep: "me" },
        harnesses: [
          {
            id: "hrn_00000000000000ab",
            dir: harness,
            specName: "future",
            target: "cli",
            registeredAt: "2026-01-01T00:00:00.000Z",
            lastSeen: "2026-01-01T00:00:00.000Z",
            futureField: 7,
            watchme: { share: true, futureShare: "x" },
            remotes: [{ kind: "custom", futureRemote: true }],
          },
        ],
        scanRoots: [{ dir: join(root, "scans"), futureScan: "y" }],
        groups: [{ name: "prod", order: 1, color: "#4f9", futureGroup: "z" }],
      }),
      "utf8",
    );

    // Trigger a full read-merge-write.
    const reg = openReg(root);
    reg.upsert({ dir: other, specName: "other", target: "cli" });

    const raw = readRaw(root);
    expect(raw["futureTop"]).toEqual({ keep: "me" });
    const rows = raw["harnesses"] as Record<string, unknown>[];
    const kept = rows.find((e) => e["dir"] === harness);
    expect(kept?.["futureField"]).toBe(7);
    expect((kept?.["watchme"] as Record<string, unknown>)["futureShare"]).toBe("x");
    expect((kept?.["remotes"] as Record<string, unknown>[])[0]?.["futureRemote"]).toBe(true);
    expect((raw["scanRoots"] as Record<string, unknown>[])[0]?.["futureScan"]).toBe("y");
    expect((raw["groups"] as Record<string, unknown>[])[0]?.["futureGroup"]).toBe("z");
  });
});

describe("multi-writer race", () => {
  test("a write that lands between read and rename is retried, not clobbered", () => {
    const root = newRoot();
    const dirA = newHarnessDir(root, "writer-a");
    const dirB = newHarnessDir(root, "writer-b");
    const other = openReg(root);
    let reads = 0;
    let injected = false;
    const racer = openReg(root, {
      hooks: {
        afterRead: () => {
          reads += 1;
          if (!injected) {
            injected = true;
            // A competing same-machine writer lands while we compute.
            other.upsert({ dir: dirB, specName: "b", target: "cli" });
          }
        },
      },
    });

    racer.upsert({ dir: dirA, specName: "a", target: "cli" });
    expect(reads).toBeGreaterThanOrEqual(2); // the fingerprint check forced a re-read
    // BOTH rows survived: the retry merged instead of clobbering.
    expect(
      openReg(root)
        .list()
        .map((e) => e.dir)
        .sort(),
    ).toEqual([dirA, dirB].sort());
  });
});

describe("CREWHAUS_NO_REGISTRY", () => {
  test("every write is a no-op; reads still work", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "seen");
    const ghost = newHarnessDir(root, "ghost");
    const writer = openReg(root);
    writer.upsert({ dir: harness, specName: "seen", target: "cli" });
    writer.addGroup({ name: "prod", color: "#4f9" });
    const before = readFileSync(regFile(root), "utf8");

    const frozen = openReg(root, { env: { CREWHAUS_NO_REGISTRY: "1" } });
    expect(frozen.disabled).toBe(true);
    // Reads work.
    expect(frozen.list().map((e) => e.dir)).toEqual([harness]);
    expect(frozen.get(harness)?.specName).toBe("seen");
    expect(frozen.listGroups().map((g) => g.name)).toEqual(["prod"]);
    // Writes are no-ops (results are computed, nothing persists).
    frozen.upsert({ dir: ghost, specName: "ghost", target: "cli" });
    expect(frozen.remove(harness)).toBe(false);
    frozen.setNotes(harness, "scribble");
    frozen.addGroup({ name: "dev" });
    frozen.addScanRoot({ dir: join(root, "scans") });
    expect(frozen.seedFromWatchme()).toEqual({ imported: 0 });
    expect(readFileSync(regFile(root), "utf8")).toBe(before);

    // Missing-dir stamping is computed for the view but NOT persisted.
    rmSync(harness, { recursive: true, force: true });
    const stamped = frozen.list();
    expect(stamped[0]?.missingSince).not.toBeNull();
    expect(readFileSync(regFile(root), "utf8")).toBe(before);
  });

  test("a never-written registry stays absent under NO_REGISTRY", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "h");
    const frozen = openReg(root, { env: { CREWHAUS_NO_REGISTRY: "1" } });
    frozen.upsert({ dir: harness, specName: "h", target: "cli" });
    expect(existsSync(regFile(root))).toBe(false);
  });
});

describe("registerHook", () => {
  test("registers with origin run-hook and returns {ok: true, id}", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "hooked");
    const reg = openReg(root);
    const result = reg.registerHook({
      dir: harness,
      specName: "hooked",
      target: "cli",
      originDetail: "run",
    });
    expect(result.ok).toBe(true);
    expect(result.id).toMatch(ID_RE);
    const entry = reg.get(harness);
    expect(entry?.origin).toBe("run-hook");
    expect(entry?.originDetail).toBe("run");
  });

  test("respects CREWHAUS_NO_REGISTRY", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "hooked");
    const frozen = openReg(root, { env: { CREWHAUS_NO_REGISTRY: "1" } });
    const result = frozen.registerHook({ dir: harness, originDetail: "run" });
    expect(result.ok).toBe(false);
    expect(existsSync(regFile(root))).toBe(false);
  });

  test("never throws — a broken registry root swallows into {ok: false}", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "hooked");
    const blocker = join(root, "a-file");
    writeFileSync(blocker, "not a directory", "utf8");
    // Registry root nested UNDER a regular file: mkdir must fail.
    const result = registerHarnessHook(
      { dir: harness, originDetail: "run" },
      { root: join(blocker, "sub"), watchmeRoot: join(root, "watchme-global"), env: {} },
    );
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});

describe("environment resolution", () => {
  test("CREWHAUS_REGISTRY_ROOT points at the directory containing harnesses.json", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "enved");
    const reg = openHangarRegistry({
      env: { CREWHAUS_REGISTRY_ROOT: join(root, "custom-root") },
      watchmeRoot: join(root, "watchme-global"),
    });
    expect(reg.path).toBe(join(root, "custom-root", "harnesses.json"));
    reg.upsert({ dir: harness, specName: "enved", target: "cli" });
    expect(existsSync(join(root, "custom-root", "harnesses.json"))).toBe(true);
  });

  test("an explicit root option wins over the env var", () => {
    const root = newRoot();
    const reg = openHangarRegistry({
      root: join(root, "explicit"),
      env: { CREWHAUS_REGISTRY_ROOT: join(root, "from-env") },
      watchmeRoot: join(root, "watchme-global"),
    });
    expect(reg.path).toBe(join(root, "explicit", "harnesses.json"));
  });
});

describe("groups", () => {
  test("addGroup appends in order and is idempotent by name", () => {
    const root = newRoot();
    const reg = openReg(root);
    expect(reg.addGroup({ name: "prod", color: "#4f9" })).toEqual({
      name: "prod",
      order: 1,
      color: "#4f9",
    });
    expect(reg.addGroup({ name: "dev" }).order).toBe(2);
    expect(reg.addGroup({ name: "prod" }).order).toBe(1); // no dupe
    expect(reg.listGroups().map((g) => g.name)).toEqual(["prod", "dev"]);
  });

  test("members walk in DECLARED order, undeclared ones last and stable by name", () => {
    const root = newRoot();
    const reg = openReg(root);
    // Registered in the opposite order on purpose: a walk that follows
    // insertion order would pass a weaker test and fail a real fleet.
    for (const [name, order] of [
      ["chief", 3],
      ["zulu", undefined],
      ["archivist", 2],
      ["alpha", undefined],
      ["secretary", 1],
    ] as const) {
      const dir = newHarnessDir(root, name);
      reg.upsert({ dir, specName: name, target: "channel" });
      reg.setGroups(dir, ["crew"]);
      if (order !== undefined) reg.setGroupOrder(dir, "crew", order);
    }
    expect(reg.groupMembers("crew").map((e) => e.specName)).toEqual([
      "secretary",
      "archivist",
      "chief",
      "alpha",
      "zulu",
    ]);
  });

  test("an order is per GROUP, and clearing it removes the key rather than nulling it", () => {
    const root = newRoot();
    const dir = newHarnessDir(root, "member");
    const reg = openReg(root);
    reg.upsert({ dir, specName: "m", target: "channel" });
    reg.setGroups(dir, ["crew", "canary"]);
    reg.setGroupOrder(dir, "crew", 2);
    reg.setGroupOrder(dir, "canary", 1);
    expect(reg.get(dir)?.groupOrder).toEqual({ crew: 2, canary: 1 });

    reg.setGroupOrder(dir, "crew", undefined);
    expect(reg.get(dir)?.groupOrder).toEqual({ canary: 1 });
    reg.setGroupOrder(dir, "canary", undefined);
    // The whole field goes, so an entry that never used ordering does not
    // grow an empty object in the file.
    expect(reg.get(dir)?.groupOrder).toBeUndefined();
  });

  test("an order survives a reread — it is registry state, not a session value", () => {
    const root = newRoot();
    const dir = newHarnessDir(root, "member");
    openReg(root).upsert({ dir, specName: "m", target: "channel" });
    openReg(root).setGroups(dir, ["crew"]);
    openReg(root).setGroupOrder(dir, "crew", 4);
    expect(openReg(root).get(dir)?.groupOrder).toEqual({ crew: 4 });
  });

  test("a non-member's order is stored but never consulted", () => {
    const root = newRoot();
    const dir = newHarnessDir(root, "member");
    const reg = openReg(root);
    reg.upsert({ dir, specName: "m", target: "channel" });
    reg.setGroupOrder(dir, "crew", 1);
    expect(reg.groupMembers("crew")).toEqual([]);
  });

  test("updateGroup renames the def and rewrites entry membership", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "member");
    const reg = openReg(root);
    reg.upsert({ dir: harness, specName: "m", target: "cli" });
    reg.addGroup({ name: "prod" });
    reg.addGroup({ name: "dev" });
    reg.setGroups(harness, ["prod"]);

    const renamed = reg.updateGroup("prod", { name: "production", color: "#0f0" });
    expect(renamed).toMatchObject({ name: "production", color: "#0f0" });
    expect(reg.get(harness)?.groups).toEqual(["production"]);
    expect(() => reg.updateGroup("production", { name: "dev" })).toThrow(/already exists/);
    expect(reg.updateGroup("nope", { color: "#000" })).toBeUndefined();
  });

  test("removeGroup drops the def and strips membership", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "member");
    const reg = openReg(root);
    reg.upsert({ dir: harness, specName: "m", target: "cli" });
    reg.addGroup({ name: "prod" });
    reg.setGroups(harness, ["prod", "loose-tag-like"]);
    expect(reg.removeGroup("prod")).toBe(true);
    expect(reg.removeGroup("prod")).toBe(false);
    expect(reg.listGroups()).toEqual([]);
    expect(reg.get(harness)?.groups).toEqual(["loose-tag-like"]);
  });

  test("reorderGroups renumbers listed-first, unlisted keep relative order", () => {
    const root = newRoot();
    const reg = openReg(root);
    reg.addGroup({ name: "a" });
    reg.addGroup({ name: "b" });
    reg.addGroup({ name: "c" });
    const next = reg.reorderGroups(["c", "a"]);
    expect(next.map((g) => [g.name, g.order])).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 3],
    ]);
    expect(reg.listGroups().map((g) => g.name)).toEqual(["c", "a", "b"]);
  });
});

describe("scan roots", () => {
  test("addScanRoot applies defaults and upserts by dir", () => {
    const root = newRoot();
    const scans = join(root, "scans");
    const reg = openReg(root);
    expect(reg.addScanRoot({ dir: scans })).toEqual({
      dir: scans,
      depth: 6,
      auto: true,
      rescanIntervalMin: 15,
      lastScanAt: null,
    });
    const updated = reg.addScanRoot({ dir: scans, depth: 3, auto: false });
    expect(updated.depth).toBe(3);
    expect(updated.auto).toBe(false);
    expect(reg.listScanRoots().length).toBe(1);
  });

  test("updateScanRoot stamps lastScanAt; removeScanRoot deletes", () => {
    const root = newRoot();
    const scans = join(root, "scans");
    const reg = openReg(root);
    reg.addScanRoot({ dir: scans });
    const updated = reg.updateScanRoot(scans, { lastScanAt: "2026-08-03T00:00:00.000Z" });
    expect(updated?.lastScanAt).toBe("2026-08-03T00:00:00.000Z");
    expect(reg.updateScanRoot(join(root, "nope"), { depth: 1 })).toBeUndefined();
    expect(reg.removeScanRoot(scans)).toBe(true);
    expect(reg.removeScanRoot(scans)).toBe(false);
    expect(reg.listScanRoots()).toEqual([]);
  });
});

describe("file shape", () => {
  test("entries sort by dir for a stable file", () => {
    const root = newRoot();
    const b = newHarnessDir(root, "bbb");
    const a = newHarnessDir(root, "aaa");
    const reg = openReg(root);
    reg.upsert({ dir: b, specName: "b", target: "cli" });
    reg.upsert({ dir: a, specName: "a", target: "cli" });
    const raw = readRaw(root)["harnesses"] as Record<string, unknown>[];
    expect(raw.map((e) => e["dir"])).toEqual([a, b]);
  });
});
