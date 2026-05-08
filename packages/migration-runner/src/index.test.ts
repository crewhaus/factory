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
