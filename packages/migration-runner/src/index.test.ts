/**
 * Section 28 — `migration-runner` tests:
 *  - T3 dry-run + write cycle on fixture registry
 *  - T9 idempotence (re-running yields zero changes)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultEngine } from "@crewhaus/migration-engine";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import { migrateAll } from "./index";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "migration-runner-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("migration-runner — T3 dry-run + write cycle", () => {
  test("plan includes every spec at the source version", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const engine = createDefaultEngine();
    await reg.put(
      "a",
      "v1",
      "name: a\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
    );
    await reg.put(
      "b",
      "v1",
      "name: b\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
    );
    const result = await migrateAll({
      registry: reg,
      engine,
      fromVersion: 0,
      toVersion: 1,
      dryRun: true,
    });
    expect(result.migrated).toBe(2);
    expect(result.plan.every((p) => p.action === "migrate")).toBe(true);
  });

  test("dry-run does not write new versions", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const engine = createDefaultEngine();
    await reg.put(
      "a",
      "v1",
      "name: a\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
    );
    await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1, dryRun: true });
    expect(await reg.list("a")).toEqual(["v1"]);
  });

  test("write mode adds a new version while preserving old", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const engine = createDefaultEngine();
    await reg.put(
      "a",
      "v1",
      "name: a\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
    );
    await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 });
    const versions = [...(await reg.list("a"))].sort();
    expect(versions).toEqual(["v1", "v2"]);
    const v2 = await reg.get("a", "v2");
    expect(v2).toContain("version: 1");
  });

  test("validate hook can reject migrated spec", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const engine = createDefaultEngine();
    await reg.put(
      "good",
      "v1",
      "name: good\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
    );
    await reg.put(
      "bad",
      "v1",
      "name: bad\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
    );
    const result = await migrateAll({
      registry: reg,
      engine,
      fromVersion: 0,
      toVersion: 1,
      dryRun: true,
      validate: (_spec, name) => {
        if (name === "bad") throw new Error("forbidden");
      },
    });
    expect(result.failed).toBe(1);
    expect(result.migrated).toBe(1);
  });
});

describe("migration-runner — T9 idempotence", () => {
  test("re-running with same target version skips already-migrated specs", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const engine = createDefaultEngine();
    await reg.put(
      "a",
      "v1",
      "name: a\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
    );
    await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 });
    const second = await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 });
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 §9.2 — comment-preserving writer, validation, the downward walk
// ---------------------------------------------------------------------------

import {
  MigrationEngine,
  MigrationIrreversibleError,
  NOOP_0_TO_1,
} from "@crewhaus/migration-engine";
import { MigrationRunnerError, applyMigrationEdits, migrateSpecYaml } from "./index";

const COMMENTED_LEARNED = [
  "# fleet spec — keep this header",
  "name: a",
  "target: cli",
  "version: 1",
  "agent:",
  "  model: claude-sonnet-4-5   # the primary",
  "  instructions: y",
  "  model_pool:",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }  # cheap arm",
  "      - { model: claude-opus-4-8, tags: [strong] }",
  "    policy: learned",
  "",
].join("\n");

describe("migration-runner — 0.6.0 comment-preserving writer", () => {
  test("migrate-all writes the v2 text with every comment and the key order intact", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("a", "v1", COMMENTED_LEARNED);
    const result = await migrateAll({
      registry: reg,
      engine: createDefaultEngine(),
      fromVersion: 1,
      toVersion: 2,
    });
    expect(result.migrated).toBe(1);
    expect(result.plan[0]?.commentsPreserved).toBe(true);
    const v2 = await reg.get("a", "v2");
    expect(v2).toContain("# fleet spec — keep this header");
    expect(v2).toMatch(/claude-sonnet-4-5 +# the primary/);
    expect(v2).toContain("# cheap arm");
    expect(v2).toContain("version: 2");
    expect(v2).not.toContain("version: 1");
    // The learned pool's default is now explicit, appended under the pool.
    expect(v2).toContain("    reward:\n      quality_source: none");
    // Key order: `name` still leads, `agent` still follows `version`.
    expect(v2.indexOf("name: a")).toBeLessThan(v2.indexOf("version: 2"));
    expect(v2.indexOf("version: 2")).toBeLessThan(v2.indexOf("agent:"));
    // Old `version: 0/1` specs stay untouched in the registry (rollback).
    expect(await reg.get("a", "v1")).toBe(COMMENTED_LEARNED);
  });

  test("a step without edits() re-serialises and the plan says so", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put(
      "a",
      "v1",
      "# header\nname: a\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
    );
    const engine = new MigrationEngine();
    engine.register({
      from: 0,
      to: 1,
      up: (s) => ({ ...s, version: 1 }),
      down: (s) => ({ ...s, version: 0 }),
    });
    const result = await migrateAll({ registry: reg, engine, fromVersion: 0, toVersion: 1 });
    expect(result.plan[0]?.commentsPreserved).toBe(false);
    expect(await reg.get("a", "v2")).not.toContain("# header");
  });

  test("the injected validator gates the CST path too (the fleet path now validates)", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put("a", "v1", COMMENTED_LEARNED);
    const result = await migrateAll({
      registry: reg,
      engine: createDefaultEngine(),
      fromVersion: 1,
      toVersion: 2,
      dryRun: true,
      validate: (spec) => {
        if (spec.version === 2) throw new Error("rejected by the live union");
      },
    });
    expect(result.failed).toBe(1);
    expect(result.plan[0]?.error).toContain("rejected by the live union");
  });
});

describe("migration-runner — the downward walk makes `irreversible` reachable", () => {
  function lossyEngine(): MigrationEngine {
    const e = new MigrationEngine();
    e.register(NOOP_0_TO_1);
    e.register({
      from: 1,
      to: 2,
      irreversible: true,
      up: (s) => ({ ...s, version: 2 }),
      down: (s) => ({ ...s, version: 1 }),
    });
    return e;
  }

  test("an UPWARD run still skips specs at or above the target (byte-identical behaviour)", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put(
      "a",
      "v1",
      "name: a\ntarget: cli\nversion: 2\nagent:\n  model: x\n  instructions: y\n",
    );
    const result = await migrateAll({
      registry: reg,
      engine: lossyEngine(),
      fromVersion: 0,
      toVersion: 1,
    });
    expect(result.skipped).toBe(1);
    expect(result.plan[0]?.action).toBe("skip");
  });

  test("a DOWNWARD run across an irreversible step is a validate-fail item, never a silent skip", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put(
      "a",
      "v1",
      "name: a\ntarget: cli\nversion: 2\nagent:\n  model: x\n  instructions: y\n",
    );
    const result = await migrateAll({
      registry: reg,
      engine: lossyEngine(),
      fromVersion: 2,
      toVersion: 1,
      dryRun: true,
    });
    expect(result.failed).toBe(1);
    expect(result.plan[0]?.action).toBe("validate-fail");
    expect(result.plan[0]?.error).toContain("irreversible");
    // Write mode refuses the whole run.
    let caught: unknown;
    try {
      await migrateAll({ registry: reg, engine: lossyEngine(), fromVersion: 2, toVersion: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationRunnerError);
    expect(await reg.list("a")).toEqual(["v1"]);
  });

  test("a DOWNWARD run across a reversible step writes the downgraded version (re-serialised)", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put(
      "a",
      "v1",
      "name: a\ntarget: cli\nversion: 2\nagent:\n  model: x\n  instructions: y\n",
    );
    const result = await migrateAll({
      registry: reg,
      engine: createDefaultEngine(),
      fromVersion: 2,
      toVersion: 1,
    });
    expect(result.migrated).toBe(1);
    expect(result.plan[0]?.commentsPreserved).toBe(false);
    expect(await reg.get("a", "v2")).toContain("version: 1");
  });

  test("the engine itself throws MigrationIrreversibleError through migrateSpecYaml", () => {
    expect(() => migrateSpecYaml("version: 2\nname: a\n", lossyEngine(), 0)).toThrow(
      MigrationIrreversibleError,
    );
  });
});

describe("applyMigrationEdits — the CST applier", () => {
  test("upserts, creates intermediate maps, deletes idempotently, keeps comments", () => {
    const src = "# top\nname: a   # trailing\nagent:\n  model: x\n";
    const out = applyMigrationEdits(src, [
      { path: ["version"], value: 2 },
      { path: ["agent", "model_pool", "reward", "quality_source"], value: "none" },
      { path: ["nope"] },
    ]);
    expect(out).toContain("# top");
    expect(out).toMatch(/name: a +# trailing/);
    expect(out).toContain("version: 2");
    expect(out).toContain("quality_source: none");
    expect(applyMigrationEdits(src, [])).toBe(src);
  });

  test("a sequence index past the end is refused (the CST would null-pad)", () => {
    expect(() =>
      applyMigrationEdits("steps:\n  - a\n", [{ path: ["steps", 3, "x"], value: 1 }]),
    ).toThrow(MigrationRunnerError);
  });

  test("edits() that disagree with up() fail loudly instead of writing one thing and reporting another", () => {
    const e = new MigrationEngine();
    e.register({
      from: 0,
      to: 1,
      up: (s) => ({ ...s, version: 1, extra: true }),
      down: (s) => ({ ...s, version: 0 }),
      edits: () => [{ path: ["version"], value: 1 }],
    });
    expect(() => migrateSpecYaml("name: a\n", e, 1)).toThrow(/edits\(\) and up\(\) disagree/);
  });
});
