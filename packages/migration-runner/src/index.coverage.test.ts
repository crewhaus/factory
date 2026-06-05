/**
 * Supplementary coverage for `migration-runner` exercising the branches the
 * happy-path file-backed suite (`index.test.ts`) does not reach:
 *  - the default `-vN` naming fallback for a non-`vN` latest version,
 *  - a custom `newVersionName`,
 *  - the YAML parse-error plan item,
 *  - the engine-migration-error plan item,
 *  - the non-dry-run refusal that throws `MigrationRunnerError`,
 *  - specs with no versions / empty latest being skipped.
 *
 * Everything runs against a pure in-memory `RegistryAdapter` — no filesystem,
 * no network, no timers, no real clock — so it is fully deterministic and
 * leaks no handles.
 */
import { describe, expect, test } from "bun:test";
import { createDefaultEngine } from "@crewhaus/migration-engine";
import type { MigrationEngine, SpecObject } from "@crewhaus/migration-engine";
import type { RegistryAdapter } from "@crewhaus/spec-registry";
import { MigrationRunnerError, migrateAll } from "./index";

/**
 * Minimal in-memory registry. `data` maps spec name -> (version -> yaml).
 * Versions returned by `list` preserve insertion order; `migrateAll` sorts
 * them itself.
 */
function memRegistry(initial: Record<string, Record<string, string>> = {}): RegistryAdapter & {
  data: Map<string, Map<string, string>>;
} {
  const data = new Map<string, Map<string, string>>();
  for (const [name, versions] of Object.entries(initial)) {
    data.set(name, new Map(Object.entries(versions)));
  }
  // `migrateAll` only ever touches listSpecs/list/get/put; the remaining
  // RegistryAdapter members are intentionally absent (never called here).
  return {
    data,
    async listSpecs() {
      return [...data.keys()];
    },
    async list(name: string) {
      return [...(data.get(name)?.keys() ?? [])];
    },
    async get(name: string, version: string) {
      const v = data.get(name)?.get(version);
      if (v === undefined) throw new Error(`ENOENT ${name}@${version}`);
      return v;
    },
    async put(name: string, version: string, yaml: string) {
      const m = data.get(name) ?? new Map<string, string>();
      m.set(version, yaml);
      data.set(name, m);
    },
  } as unknown as RegistryAdapter & { data: Map<string, Map<string, string>> };
}

describe("migration-runner — default new-version naming fallback", () => {
  test("non-vN latest version names the new version `<latest>-v<toVersion>`", async () => {
    // latest is "release-2024" which does NOT match /^v(\d+)$/, so the
    // DEFAULT_NEW_VERSION fallback branch runs.
    const reg = memRegistry({
      a: { "release-2024": "name: a\ntarget: cli\nversion: 0\n" },
    });
    const engine = createDefaultEngine();
    const result = await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 });
    expect(result.migrated).toBe(1);
    expect(result.plan[0]?.newVersion).toBe("release-2024-v1");
    // The write landed under the fallback name, preserving the original.
    expect([...(reg.data.get("a")?.keys() ?? [])].sort()).toEqual([
      "release-2024",
      "release-2024-v1",
    ]);
  });
});

describe("migration-runner — custom newVersionName", () => {
  test("a caller-supplied namer overrides the default", async () => {
    const reg = memRegistry({
      a: { v1: "name: a\ntarget: cli\nversion: 0\n" },
    });
    const engine = createDefaultEngine();
    const seen: Array<{ latest: string; to: number }> = [];
    const result = await migrateAll({
      registry: reg,
      engine,
      fromVersion: 0,
      toVersion: 1,
      newVersionName: (latest, to) => {
        seen.push({ latest, to });
        return `${latest}__migrated`;
      },
    });
    expect(result.migrated).toBe(1);
    expect(result.plan[0]?.newVersion).toBe("v1__migrated");
    expect(seen).toEqual([{ latest: "v1", to: 1 }]);
  });
});

describe("migration-runner — parse-error plan item", () => {
  test("a spec whose latest YAML does not parse becomes a validate-fail (dry-run)", async () => {
    const reg = memRegistry({
      broken: { v1: "{ this is not valid yaml" },
    });
    const engine = createDefaultEngine();
    const result = await migrateAll({
      registry: reg,
      engine,
      fromVersion: 0,
      toVersion: 1,
      dryRun: true,
    });
    expect(result.failed).toBe(1);
    expect(result.plan[0]?.action).toBe("validate-fail");
    expect(result.plan[0]?.error).toContain("parse error:");
  });
});

describe("migration-runner — engine migration error plan item", () => {
  test("an unregistered migration step becomes a validate-fail (dry-run)", async () => {
    const reg = memRegistry({
      a: { v1: "name: a\ntarget: cli\nversion: 0\n" },
    });
    // Engine with NO steps registered -> migrate(0 -> 2) throws inside migrateAll.
    const emptyEngine = createDefaultEngine();
    emptyEngine.clear();
    const result = await migrateAll({
      registry: reg,
      engine: emptyEngine,
      fromVersion: 0,
      toVersion: 2,
      dryRun: true,
    });
    expect(result.failed).toBe(1);
    expect(result.plan[0]?.action).toBe("validate-fail");
    expect(result.plan[0]?.error).toContain("migration error:");
  });
});

describe("migration-runner — non-dry-run refusal", () => {
  test("write mode throws MigrationRunnerError when any spec fails", async () => {
    const reg = memRegistry({
      good: { v1: "name: good\ntarget: cli\nversion: 0\n" },
      bad: { v1: "{ broken yaml" },
    });
    const engine = createDefaultEngine();
    await expect(
      migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 }),
    ).rejects.toBeInstanceOf(MigrationRunnerError);
  });

  test("the thrown error names how many specs failed", async () => {
    const reg = memRegistry({
      bad: { v1: "{ broken yaml" },
    });
    const engine = createDefaultEngine();
    let caught: Error | undefined;
    try {
      await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(MigrationRunnerError);
    expect(caught?.message).toContain("1 spec(s) failed migration");
  });
});

describe("migration-runner — skip already-migrated and empty specs", () => {
  test("a spec already at/above the target version is skipped", async () => {
    const reg = memRegistry({
      a: { v1: "name: a\ntarget: cli\nversion: 5\n" },
    });
    const engine = createDefaultEngine();
    const result = await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 });
    expect(result.skipped).toBe(1);
    expect(result.migrated).toBe(0);
    expect(result.plan[0]?.action).toBe("skip");
  });

  test("a spec with no versions at all is skipped silently (no plan item)", async () => {
    const reg = memRegistry();
    // Register the spec name but give it zero versions.
    reg.data.set("empty", new Map());
    const engine = createDefaultEngine();
    const result = await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 });
    expect(result.plan.length).toBe(0);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  test("a spec whose sorted latest is an empty-string version is skipped", async () => {
    // versions === [""] -> latest === "" which is falsy, so the `!latest`
    // guard `continue`s before any get/parse.
    const reg = memRegistry();
    reg.data.set("blank", new Map([["", "name: blank\n"]]));
    const engine = createDefaultEngine();
    const result = await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 });
    expect(result.plan.length).toBe(0);
  });
});

// Keep a no-op reference to the imported types so the file documents intent
// without unused-import noise.
const _typeRefs: { e?: MigrationEngine; s?: SpecObject } = {};
void _typeRefs;
