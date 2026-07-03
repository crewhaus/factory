import { describe, expect, test } from "bun:test";
import { MigrationEngine, type SpecObject, createDefaultEngine } from "@crewhaus/migration-engine";
import { parseSpec } from "@crewhaus/spec";
import { stringify as stringifyYaml } from "yaml";
import { formatUpgradePlan, planUpgrade } from "./upgrade";

const CLI_SPEC = "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";

/** The real CLI validator: a migrated spec must parse through the live union. */
const parseSpecValidator = (spec: SpecObject): void => {
  parseSpec(stringifyYaml(spec));
};

describe("planUpgrade — drift detection + validated migration chain", () => {
  test("an unversioned spec migrates to the current version (default engine: v1)", () => {
    const plan = planUpgrade(CLI_SPEC, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("upgrade");
    expect(plan.fromVersion).toBe(0);
    expect(plan.toVersion).toBe(1);
    // The NOOP 0→1 stamps version:1; the migrated YAML re-parses.
    expect(plan.migratedYaml).toBeDefined();
    const reparsed = parseSpec(plan.migratedYaml ?? "") as { version?: number };
    expect(reparsed.version).toBe(1);
  });

  test("a spec already at the current version is up-to-date (no-op)", () => {
    const stamped = `version: 1\n${CLI_SPEC}`;
    const plan = planUpgrade(stamped, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("up-to-date");
  });

  test("a spec AHEAD of the CLI is refused, not downgraded", () => {
    const ahead = `version: 5\n${CLI_SPEC}`;
    const plan = planUpgrade(ahead, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("ahead");
    expect(plan.fromVersion).toBe(5);
    expect(plan.toVersion).toBe(1);
  });

  test("the diff surfaces the version-stamp field the migration adds", () => {
    const plan = planUpgrade(CLI_SPEC, createDefaultEngine(), parseSpecValidator);
    const diff = plan.diff ?? [];
    expect(diff.some((d) => d.path === "version")).toBe(true);
  });

  test("VALIDATE CALLBACK: a migration that produces an invalid spec is caught, not written", () => {
    // A rogue engine whose up() sets an unsafe name — parseSpec rejects it. This
    // is exactly the gap the CLI's migrate-all left open (no validate callback).
    const rogue = new MigrationEngine();
    rogue.register({
      from: 0,
      to: 1,
      up: (s) => ({ ...s, version: 1, name: "bad/name" }),
      down: (s) => ({ ...s, version: 0 }),
    });
    const plan = planUpgrade(CLI_SPEC, rogue, parseSpecValidator);
    expect(plan.action).toBe("validate-fail");
    expect(plan.error).toContain("failed validation");
    // No migratedYaml is offered for write.
    expect(plan.migratedYaml).toBeUndefined();
  });

  test("a migration chain that throws is reported as validate-fail, not crashing", () => {
    const broken = new MigrationEngine();
    // latestVersion() is 2 (max `to`), but the 0→1 step is missing → engine
    // throws when asked to migrate 0→2.
    broken.register({
      from: 1,
      to: 2,
      up: (s) => ({ ...s, version: 2 }),
      down: (s) => ({ ...s, version: 1 }),
    });
    const plan = planUpgrade(CLI_SPEC, broken, parseSpecValidator);
    expect(plan.action).toBe("validate-fail");
    expect(plan.error).toContain("migration failed");
  });

  test("unparseable YAML → validate-fail", () => {
    const plan = planUpgrade("{not: yaml: :", createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("validate-fail");
  });
});

describe("formatUpgradePlan", () => {
  test("up-to-date wording", () => {
    const plan = planUpgrade(`version: 1\n${CLI_SPEC}`, createDefaultEngine(), parseSpecValidator);
    expect(formatUpgradePlan(plan, false)).toContain("already at the current version");
  });

  test("dry-run vs write wording on an upgrade", () => {
    const plan = planUpgrade(CLI_SPEC, createDefaultEngine(), parseSpecValidator);
    expect(formatUpgradePlan(plan, false)).toContain("dry-run");
    expect(formatUpgradePlan(plan, true)).toContain("applied");
  });

  test("ahead wording points at upgrading the CLI", () => {
    const plan = planUpgrade(`version: 5\n${CLI_SPEC}`, createDefaultEngine(), parseSpecValidator);
    expect(formatUpgradePlan(plan, false)).toContain("NEWER than this CLI");
  });

  test("validate-fail wording carries the error", () => {
    const plan = planUpgrade("{not: yaml: :", createDefaultEngine(), parseSpecValidator);
    expect(formatUpgradePlan(plan, false)).toContain("cannot migrate");
  });
});
