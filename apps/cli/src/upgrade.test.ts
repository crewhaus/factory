import { describe, expect, test } from "bun:test";
import { MigrationEngine, type SpecObject, createDefaultEngine } from "@crewhaus/migration-engine";
import { parseSpec } from "@crewhaus/spec";
import { stringify as stringifyYaml } from "yaml";
import { collect030UpgradeNotes, formatUpgradePlan, planUpgrade } from "./upgrade";

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

describe("collect030UpgradeNotes — the 0.2.x→0.3.0 release notes (PR 20)", () => {
  test("(a) an agent-loop spec with no continuity key gets the `continuity: false` pin offer", () => {
    const notes = collect030UpgradeNotes(CLI_SPEC);
    const continuity = notes.find((n) => n.id === "continuity-default-on");
    expect(continuity).toBeDefined();
    expect(continuity?.title).toContain("continuity ON by default");
    expect(continuity?.body.join("\n")).toContain("continuity: false");
    expect(continuity?.body.join("\n")).toContain("byte-for-byte");
  });

  test("(a) an explicit continuity key — either form — silences the pin offer", () => {
    expect(
      collect030UpgradeNotes(`${CLI_SPEC}continuity: false\n`).some(
        (n) => n.id === "continuity-default-on",
      ),
    ).toBe(false);
    expect(
      collect030UpgradeNotes(`${CLI_SPEC}continuity:\n  focusMaxChars: 2048\n`).some(
        (n) => n.id === "continuity-default-on",
      ),
    ).toBe(false);
  });

  test("(a) non-agent-loop shapes are not offered the pin (continuity is not default-on there)", () => {
    const workflow = "name: w\ntarget: workflow\nsteps:\n  - name: s1\n    prompt: hi\n";
    expect(collect030UpgradeNotes(workflow).some((n) => n.id === "continuity-default-on")).toBe(
      false,
    );
  });

  test("(b) a memory: spec is pointed at `crewhaus migrate memories`; a memoryless one is not", () => {
    const withMemory = `${CLI_SPEC}memory:\n  enabled: true\n`;
    const note = collect030UpgradeNotes(withMemory).find((n) => n.id === "migrate-memories");
    expect(note?.body.join("\n")).toContain("crewhaus migrate memories");
    expect(collect030UpgradeNotes(CLI_SPEC).some((n) => n.id === "migrate-memories")).toBe(false);
  });

  test("(c) mcp_servers env/headers are flagged BY SERVER NAME as secret-lowered", () => {
    const withMcp = `${CLI_SPEC}mcp_servers:\n  github:\n    transport: stdio\n    command: npx\n    args: ["-y", "@modelcontextprotocol/server-github"]\n    env:\n      GITHUB_PERSONAL_ACCESS_TOKEN: $GITHUB_TOKEN\n  plain:\n    transport: stdio\n    command: echo\n`;
    const note = collect030UpgradeNotes(withMcp).find((n) => n.id === "mcp-secret-lowering");
    expect(note).toBeDefined();
    expect(note?.title).toContain("github");
    expect(note?.title).not.toContain("plain"); // no env/headers → unaffected
    expect(note?.body.join("\n")).toContain("fails compilation");
  });

  test("unparseable YAML yields no notes (the plan reports the parse failure)", () => {
    expect(collect030UpgradeNotes("{not: yaml: :")).toEqual([]);
  });

  test("notes ride the plan and render for both `upgrade` and `up-to-date`", () => {
    const dryRun = planUpgrade(CLI_SPEC, createDefaultEngine(), parseSpecValidator);
    expect(dryRun.action).toBe("upgrade");
    const rendered = formatUpgradePlan(dryRun, false);
    expect(rendered).toContain("0.2.x → 0.3.0 notes");
    expect(rendered).toContain("continuity: false");

    const upToDate = planUpgrade(
      `version: 1\n${CLI_SPEC}`,
      createDefaultEngine(),
      parseSpecValidator,
    );
    expect(upToDate.action).toBe("up-to-date");
    expect(formatUpgradePlan(upToDate, false)).toContain("0.2.x → 0.3.0 notes");
  });

  test("a spec no note applies to renders exactly as before (no empty notes block)", () => {
    const pinned = "version: 1\nname: w\ntarget: workflow\nsteps:\n  - name: s1\n    prompt: hi\n";
    const plan = planUpgrade(pinned, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("up-to-date");
    expect(formatUpgradePlan(plan, false)).toBe(
      "upgrade: spec is already at the current version (v1) — nothing to do.\n",
    );
  });
});
