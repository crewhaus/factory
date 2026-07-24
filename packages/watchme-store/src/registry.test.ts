import { afterAll, describe, expect, test } from "bun:test";
import {
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
import { openHarnessRegistry } from "./registry";

const TMP_ROOTS: string[] = [];
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-watchme-registry-"));
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

describe("harness registry — register/list/deregister", () => {
  test("register creates a 0600 {v:1} document and list returns the entry", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "helpdesk");
    const reg = openHarnessRegistry(join(root, "global"), { now: () => 1_000 });
    reg.register({ dir: harness, specName: "helpdesk", target: "cli", agentId: "agent-1" });

    const path = join(root, "global", "harnesses.json");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).v).toBe(1);
    expect(reg.list()).toEqual([
      {
        dir: harness,
        specName: "helpdesk",
        target: "cli",
        agentId: "agent-1",
        registeredAt: 1_000,
        lastSeen: 1_000,
      },
    ]);
  });

  test("upsert by dir keeps registeredAt, refreshes lastSeen and descriptive fields", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "helpdesk");
    let clock = 1_000;
    const reg = openHarnessRegistry(join(root, "global"), { now: () => clock });
    reg.register({ dir: harness, specName: "helpdesk", target: "cli" });
    clock = 2_000;
    reg.register({ dir: harness, specName: "helpdesk-v2", target: "channel" });

    const entries = reg.list();
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      specName: "helpdesk-v2",
      target: "channel",
      registeredAt: 1_000,
      lastSeen: 2_000,
    });
  });

  test("deregister removes the entry durably", () => {
    const root = newRoot();
    const a = newHarnessDir(root, "a");
    const b = newHarnessDir(root, "b");
    const reg = openHarnessRegistry(join(root, "global"), { now: () => 1 });
    reg.register({ dir: a, specName: "a", target: "cli" });
    reg.register({ dir: b, specName: "b", target: "cli" });
    reg.deregister(a);
    expect(reg.list().map((e) => e.dir)).toEqual([b]);
  });

  test("entries sort by dir for a stable file", () => {
    const root = newRoot();
    const b = newHarnessDir(root, "bbb");
    const a = newHarnessDir(root, "aaa");
    const reg = openHarnessRegistry(join(root, "global"), { now: () => 1 });
    reg.register({ dir: b, specName: "b", target: "cli" });
    reg.register({ dir: a, specName: "a", target: "cli" });
    expect(reg.list().map((e) => e.dir)).toEqual([a, b]);
  });
});

describe("harness registry — tolerance", () => {
  test("entries whose dir vanished are dropped from list() and reported", () => {
    const root = newRoot();
    const alive = newHarnessDir(root, "alive");
    const doomed = newHarnessDir(root, "doomed");
    const warnings: string[] = [];
    const reg = openHarnessRegistry(join(root, "global"), {
      now: () => 1,
      onWarn: (message) => warnings.push(message),
    });
    reg.register({ dir: alive, specName: "alive", target: "cli" });
    reg.register({ dir: doomed, specName: "doomed", target: "cli" });
    rmSync(doomed, { recursive: true, force: true });

    expect(reg.list().map((e) => e.dir)).toEqual([alive]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(doomed);
    // Pruning is read-side only: the file still holds both entries (a
    // remounted volume would bring the harness back).
    const onDisk = JSON.parse(readFileSync(join(root, "global", "harnesses.json"), "utf8"));
    expect(onDisk.harnesses.length).toBe(2);
  });

  test("a garbage registry file reads as empty and the next register heals it", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "helpdesk");
    const globalRoot = join(root, "global");
    mkdirSync(globalRoot, { recursive: true });
    writeFileSync(join(globalRoot, "harnesses.json"), "{ not json", "utf8");
    const reg = openHarnessRegistry(globalRoot, { now: () => 1 });
    expect(reg.list()).toEqual([]);
    reg.register({ dir: harness, specName: "helpdesk", target: "cli" });
    expect(reg.list().length).toBe(1);
  });

  test("malformed rows inside an otherwise-valid file are skipped", () => {
    const root = newRoot();
    const harness = newHarnessDir(root, "helpdesk");
    const globalRoot = join(root, "global");
    mkdirSync(globalRoot, { recursive: true });
    writeFileSync(
      join(globalRoot, "harnesses.json"),
      JSON.stringify({
        v: 1,
        harnesses: [
          { dir: harness, specName: "helpdesk", target: "cli", registeredAt: 1, lastSeen: 1 },
          { dir: 42, specName: "bogus" },
          "not an entry",
        ],
      }),
      "utf8",
    );
    expect(
      openHarnessRegistry(globalRoot)
        .list()
        .map((e) => e.specName),
    ).toEqual(["helpdesk"]);
  });
});
