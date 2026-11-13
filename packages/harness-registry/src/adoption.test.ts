import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REGISTRY_FILENAME } from "./doc";
import { HARNESS_IDENTITY_REL, readHarnessIdentityFile } from "./identity";
import { isAdopted, openHangarRegistry, runsOwnCode, slugOf } from "./registry";

const roots: string[] = [];
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-adoption-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const ID_A = "hrn_00000000000000aa";
const ID_B = "hrn_00000000000000bb";

function harnessDir(root: string, name: string, id?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "crewhaus.yaml"), `name: ${name}\ntarget: cli\n`);
  if (id !== undefined) {
    const file = join(dir, HARNESS_IDENTITY_REL);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, id, createdAt: "t" }));
  }
  return dir;
}

function registry(root: string, now = () => Date.parse("2026-11-12T00:00:00.000Z")) {
  return openHangarRegistry({
    root: join(root, "registry"),
    watchmeRoot: join(root, "watchme"),
    hangarRoot: join(root, "hangar"),
    env: {},
    now,
  });
}

describe("a harness's own id", () => {
  test("a new row takes the id its harness.json names", () => {
    const root = newRoot();
    const entry = registry(root).upsert({ dir: harnessDir(root, "bot", ID_A), specName: "bot" });
    expect(entry.id).toBe(ID_A);
    expect(entry.identity).toBeUndefined();
  });

  test("a copy of a registered harness mints its own id and says whose fork it is", () => {
    const root = newRoot();
    const reg = registry(root);
    reg.upsert({ dir: harnessDir(root, "bot", ID_A), specName: "bot" });
    const copy = reg.upsert({ dir: harnessDir(root, "bot-copy", ID_A), specName: "bot" });
    expect(copy.id).not.toBe(ID_A);
    expect(copy.identity).toBe(`fork-of ${ID_A}`);
  });

  test("a row whose harness.json names an unregistered id is re-keyed, and the map says so", () => {
    const root = newRoot();
    const reg = registry(root);
    const dir = harnessDir(root, "bot");
    const first = reg.upsert({ dir, specName: "bot" });
    const file = join(dir, HARNESS_IDENTITY_REL);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, id: ID_B, createdAt: "t" }));
    const again = reg.upsert({ dir, specName: "bot" });
    expect(again.id).toBe(ID_B);
    const lines = readFileSync(join(root, "hangar", "control", "id-map.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ from: first.id, to: ID_B, dir });
  });

  test("the reader is tolerant and never writes", () => {
    const root = newRoot();
    const dir = harnessDir(root, "bot");
    expect(readHarnessIdentityFile(dir)).toBeUndefined();
    expect(existsSync(join(dir, ".crewhaus"))).toBe(false);
    const file = join(dir, HARNESS_IDENTITY_REL);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    expect(readHarnessIdentityFile(dir)).toBeUndefined();
  });
});

describe("slugs", () => {
  test("new rows get a unique lower-kebab slug from the spec name", () => {
    const root = newRoot();
    const reg = registry(root);
    expect(slugOf("My Support Bot")).toBe("my-support-bot");
    const a = reg.upsert({ dir: harnessDir(root, "a"), specName: "My Bot" });
    const b = reg.upsert({ dir: harnessDir(root, "b"), specName: "My Bot" });
    const c = reg.upsert({ dir: harnessDir(root, "c"), specName: "my_bot" });
    expect([a.slug, b.slug, c.slug]).toEqual(["my-bot", "my-bot-2", "my-bot-3"]);
  });
});

describe("adoption", () => {
  test("adopt records home; relocate drops it", () => {
    const root = newRoot();
    const reg = registry(root);
    const entry = reg.upsert({ dir: harnessDir(root, "bot"), specName: "bot" });
    const adopted = reg.adopt(entry.id, `local:#${"a".repeat(64)}`);
    expect(adopted?.home).toEqual({
      adoptedAt: "2026-11-12T00:00:00.000Z",
      by: `local:#${"a".repeat(64)}`,
    });
    const moved = reg.relocate(entry.id, harnessDir(root, "bot-moved"));
    expect(moved?.home).toBeUndefined();
    expect(reg.get(entry.id)?.home).toBeUndefined();
  });

  test("a row registered before adoption began counts as adopted at a new directory only once adopted there", () => {
    const root = newRoot();
    let now = Date.parse("2026-11-01T00:00:00.000Z");
    const reg = registry(root, () => now);
    const entry = reg.upsert({ dir: harnessDir(root, "bot"), specName: "bot" });
    // The registry as an earlier release wrote it: no adoptionSince.
    const file = join(root, "registry", REGISTRY_FILENAME);
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    Reflect.deleteProperty(doc, "adoptionSince");
    writeFileSync(file, JSON.stringify(doc));
    now = Date.parse("2026-11-12T00:00:00.000Z");
    const legacy = registry(root, () => now);
    expect(
      isAdopted(legacy.get(entry.id) as NonNullable<ReturnType<typeof legacy.get>>, undefined),
    ).toBe(true);
    const moved = legacy.relocate(entry.id, harnessDir(root, "bot-moved"));
    expect(moved?.relocatedAt).toBe("2026-11-12T00:00:00.000Z");
    const since = legacy.adoptionSince();
    expect(since).toBeDefined();
    expect(Date.parse(entry.registeredAt)).toBeLessThan(Date.parse(since ?? ""));
    expect(isAdopted(legacy.get(entry.id) as NonNullable<typeof moved>, since)).toBe(false);
    // Adopted at its new directory, it counts again.
    legacy.adopt(entry.id, `local:#${"a".repeat(64)}`);
    expect(isAdopted(legacy.get(entry.id) as NonNullable<typeof moved>, since)).toBe(true);
  });

  test("adoptionSince is stamped by the first write, with that write's own time", () => {
    const root = newRoot();
    let now = Date.parse("2026-11-12T00:00:00.000Z");
    const reg = registry(root, () => now);
    expect(reg.adoptionSince()).toBeUndefined();
    const entry = reg.upsert({ dir: harnessDir(root, "bot"), specName: "bot" });
    expect(reg.adoptionSince()).toBe(entry.registeredAt);
    // A row registered by the stamping write itself is not before it.
    expect(isAdopted(entry, reg.adoptionSince())).toBe(false);
    now += 60_000;
    reg.upsert({ dir: harnessDir(root, "later"), specName: "later" });
    expect(reg.adoptionSince()).toBe(entry.registeredAt);
  });

  test("isAdopted: absent stamp, a row before it, a row after it, an adopted row", () => {
    const row = (registeredAt: string, home?: { adoptedAt: string; by: string }) =>
      ({ registeredAt, ...(home !== undefined ? { home } : {}) }) as unknown as Parameters<
        typeof isAdopted
      >[0];
    const since = "2026-11-12T00:00:00.000Z";
    expect(isAdopted(row("2026-11-13T00:00:00.000Z"), undefined)).toBe(true);
    expect(isAdopted(row("2026-11-11T00:00:00.000Z"), since)).toBe(true);
    expect(isAdopted(row(since), since)).toBe(false);
    expect(isAdopted(row("2026-11-13T00:00:00.000Z"), since)).toBe(false);
    expect(isAdopted(row("2026-11-13T00:00:00.000Z", { adoptedAt: "t", by: "x" }), since)).toBe(
      true,
    );
  });
});

describe("runsOwnCode", () => {
  test("only a row adopted with crewhaus harness adopt runs its own code", () => {
    const root = newRoot();
    let now = Date.parse("2026-11-01T00:00:00.000Z");
    const reg = registry(root, () => now);
    const entry = reg.upsert({ dir: harnessDir(root, "bot"), specName: "bot" });
    // The registry as an earlier release wrote it: the row predates adoption.
    const file = join(root, "registry", REGISTRY_FILENAME);
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    Reflect.deleteProperty(doc, "adoptionSince");
    writeFileSync(file, JSON.stringify(doc));
    now = Date.parse("2026-11-12T00:00:00.000Z");
    const legacy = registry(root, () => now);
    const grandfathered = legacy.get(entry.id) as NonNullable<ReturnType<typeof legacy.get>>;
    // It keeps group start, and still gets Home's own code.
    expect(isAdopted(grandfathered, legacy.adoptionSince())).toBe(true);
    expect(runsOwnCode(grandfathered)).toBe(false);
    // A row registered under this release without adopting: neither.
    const fresh = legacy.upsert({ dir: harnessDir(root, "fresh"), specName: "fresh" });
    expect(runsOwnCode(fresh)).toBe(false);
    // Adopted, it runs its own; relocated, it no longer does.
    legacy.adopt(entry.id, `local:#${"a".repeat(64)}`);
    expect(runsOwnCode(legacy.get(entry.id) as typeof grandfathered)).toBe(true);
    legacy.relocate(entry.id, harnessDir(root, "bot-moved"));
    expect(runsOwnCode(legacy.get(entry.id) as typeof grandfathered)).toBe(false);
  });
});

test("registering and reading a git-clean harness leaves its working tree clean", () => {
  const root = newRoot();
  const dir = harnessDir(root, "clean");
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  if (git("init", "-q").status !== 0) return; // no git on this machine
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const reg = registry(root);
  reg.upsert({ dir, specName: "clean" });
  reg.list();
  reg.get(dir);
  readHarnessIdentityFile(dir);
  expect(git("status", "--porcelain").stdout).toBe("");
});
