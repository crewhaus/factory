import { describe, expect, test } from "bun:test";
import { MigrationEngine, type SpecObject, createDefaultEngine } from "@crewhaus/migration-engine";
import { parseSpec } from "@crewhaus/spec";
import { stringify as stringifyYaml } from "yaml";
import {
  UPGRADE_NOTES_TABLE,
  buildSpecVersionCheck,
  collect030UpgradeNotes,
  collect060UpgradeNotes,
  collectUpgradeNotes,
  formatUpgradePlan,
  planUpgrade,
} from "./upgrade";

const CLI_SPEC = "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";

/** The real CLI validator: a migrated spec must parse through the live union. */
const parseSpecValidator = (spec: SpecObject): void => {
  parseSpec(stringifyYaml(spec));
};

describe("planUpgrade — drift detection + validated migration chain", () => {
  test("an unversioned spec migrates to the current version (default engine: v2)", () => {
    const plan = planUpgrade(CLI_SPEC, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("upgrade");
    expect(plan.fromVersion).toBe(0);
    expect(plan.toVersion).toBe(2);
    // 0→1 then 1→2 stamp version:2; the migrated YAML re-parses.
    expect(plan.migratedYaml).toBeDefined();
    const reparsed = parseSpec(plan.migratedYaml ?? "") as { version?: number };
    expect(reparsed.version).toBe(2);
    expect(plan.commentsPreserved).toBe(true);
  });

  test("a spec already at the current version is up-to-date (no-op)", () => {
    const stamped = `version: 2\n${CLI_SPEC}`;
    const plan = planUpgrade(stamped, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("up-to-date");
  });

  test("a spec AHEAD of the CLI is refused, not downgraded", () => {
    const ahead = `version: 5\n${CLI_SPEC}`;
    const plan = planUpgrade(ahead, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("ahead");
    expect(plan.fromVersion).toBe(5);
    expect(plan.toVersion).toBe(2);
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
    const plan = planUpgrade(`version: 2\n${CLI_SPEC}`, createDefaultEngine(), parseSpecValidator);
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
      `version: 2\n${CLI_SPEC}`,
      createDefaultEngine(),
      parseSpecValidator,
    );
    expect(upToDate.action).toBe("up-to-date");
    expect(formatUpgradePlan(upToDate, false)).toContain("0.2.x → 0.3.0 notes");
  });

  test("a spec no note applies to renders exactly as before (no empty notes block)", () => {
    const pinned = "version: 2\nname: w\ntarget: workflow\nsteps:\n  - name: s1\n    prompt: hi\n";
    const plan = planUpgrade(pinned, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("up-to-date");
    expect(formatUpgradePlan(plan, false)).toBe(
      "upgrade: spec is already at the current version (v2) — nothing to do.\n",
    );
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 §9.2 — the real migration: v1 → v2, comment-preserving (acceptance item 16)
// ---------------------------------------------------------------------------

const COMMENTED_V1 = [
  "# support harness — DO NOT lose this header",
  "version: 1",
  "name: support",
  "target: cli",
  "agent:",
  "  model: claude-opus-4-8      # the strong primary",
  "  instructions: |",
  "    Help the customer.",
  "  model_pool:",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }   # cheap arm",
  "      - { model: claude-opus-4-8, tags: [strong] }",
  "    policy: learned                                  # learns from arms.jsonl",
  "",
].join("\n");

describe("planUpgrade — v1 → v2 (MIGRATION_1_TO_2) preserves comments and key order", () => {
  test("upgrade --dry-run prints v1 → v2 with every comment intact", () => {
    const plan = planUpgrade(COMMENTED_V1, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("upgrade");
    expect(plan.fromVersion).toBe(1);
    expect(plan.toVersion).toBe(2);
    expect(plan.commentsPreserved).toBe(true);
    const out = plan.migratedYaml ?? "";
    expect(out).toContain("# support harness — DO NOT lose this header");
    expect(out).toMatch(/claude-opus-4-8 +# the strong primary/);
    expect(out).toMatch(/# cheap arm/);
    expect(out).toMatch(/policy: learned +# learns from arms.jsonl/);
    // The version stamp is edited IN PLACE (it keeps its position at the top).
    expect(
      out.startsWith("# support harness — DO NOT lose this header\nversion: 2\nname: support\n"),
    ).toBe(true);
    // The learned pool's reward default is made explicit; the block scalar survives.
    expect(out).toContain("    reward:\n      quality_source: none");
    expect(out).toContain("  instructions: |\n    Help the customer.");
    expect(parseSpec(out).version).toBe(2);

    const rendered = formatUpgradePlan(plan, false);
    expect(rendered).toContain("upgrade: v1 → v2");
    expect(rendered).toContain("~ version: 1 → 2");
    expect(rendered).toContain('+ agent.model_pool.reward: {"quality_source":"none"}');
    expect(rendered).toContain("comments and key order are preserved");
    expect(rendered).toContain("dry-run");
  });

  test("a heuristic pool gets only the stamp — the diff is the version line alone", () => {
    const heuristic = COMMENTED_V1.replace("policy: learned", "policy: heuristic");
    const plan = planUpgrade(heuristic, createDefaultEngine(), parseSpecValidator);
    expect(plan.diff?.map((d) => d.path)).toEqual(["version"]);
    expect(plan.migratedYaml).not.toContain("reward");
  });

  test("the 0 → 2 chain is comment-preserving end to end (both steps declare edits)", () => {
    const unversioned = COMMENTED_V1.replace("version: 1\n", "");
    const plan = planUpgrade(unversioned, createDefaultEngine(), parseSpecValidator);
    expect(plan.action).toBe("upgrade");
    expect(plan.commentsPreserved).toBe(true);
    expect(plan.migratedYaml).toContain("# support harness — DO NOT lose this header");
    expect(plan.migratedYaml).toContain("version: 2");
  });

  test("a chain with an edit-less step re-serialises and the report says so", () => {
    const engine = new MigrationEngine();
    engine.register({
      from: 0,
      to: 1,
      up: (s) => ({ ...s, version: 1 }),
      down: (s) => ({ ...s, version: 0 }),
    });
    const plan = planUpgrade(`# header\n${CLI_SPEC}`, engine, parseSpecValidator);
    expect(plan.action).toBe("upgrade");
    expect(plan.commentsPreserved).toBe(false);
    expect(plan.migratedYaml).not.toContain("# header");
    expect(formatUpgradePlan(plan, false)).toContain("re-serialised");
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 §9.2 — the per-release upgrade-notes table
// ---------------------------------------------------------------------------

describe("collect060UpgradeNotes — the 0.5.x→0.6.0 release notes", () => {
  test("the table carries one row per release, oldest first", () => {
    expect(UPGRADE_NOTES_TABLE.map((r) => r.release)).toEqual(["0.3.0", "0.6.0"]);
    expect(UPGRADE_NOTES_TABLE.map((r) => r.from)).toEqual(["0.2.x", "0.5.x"]);
  });

  test("a crew whose role routes gets `crew-role-pools-live`; a plain crew does not", () => {
    const routed = [
      "name: cr",
      "target: crew",
      "model: claude-sonnet-4-5",
      "entry: lead",
      "roles:",
      "  lead:",
      "    instructions: lead it",
      "  writer:",
      "    instructions: write",
      "    model_tiers: { fast: claude-haiku-4-5, default: claude-sonnet-4-5 }",
      "",
    ].join("\n");
    const note = collect060UpgradeNotes(routed).find((n) => n.id === "crew-role-pools-live");
    expect(note?.title).toContain("writer");
    expect(note?.title).not.toContain("lead");
    expect(note?.release).toBe("0.6.0");
    const plain =
      "name: cr\ntarget: crew\nmodel: m\nentry: lead\nroles:\n  lead:\n    instructions: x\n";
    expect(collect060UpgradeNotes(plain).some((n) => n.id === "crew-role-pools-live")).toBe(false);
  });

  test("a budget: spec is told the cap now gates every model call", () => {
    const notes = collect060UpgradeNotes(`${CLI_SPEC}budget:\n  usd: 1\n`);
    const note = notes.find((n) => n.id === "budget-every-call");
    expect(note?.body.join("\n")).toContain("budget.scope: session");
    expect(collect060UpgradeNotes(CLI_SPEC).some((n) => n.id === "budget-every-call")).toBe(false);
  });

  test("an evaluation: spec (or a kind: judge step) is told judge spend is metered under judge_share", () => {
    const withEval = `${CLI_SPEC}evaluation:\n  grader:\n    type: llm_judge\n    criteria: good\n`;
    expect(
      collect060UpgradeNotes(withEval)
        .find((n) => n.id === "judge-spend-metered")
        ?.body.join("\n"),
    ).toContain("judge_share");
    const withGate =
      "name: w\ntarget: workflow\nmodel: m\nsteps:\n  - name: a\n    instructions: x\n  - name: g\n    kind: judge\n    judge:\n      criteria: ok\n";
    expect(collect060UpgradeNotes(withGate).some((n) => n.id === "judge-spend-metered")).toBe(true);
    expect(collect060UpgradeNotes(CLI_SPEC).some((n) => n.id === "judge-spend-metered")).toBe(
      false,
    );
  });

  test("a learned pool gets the `crewhaus route reset` note and, with degrade, the degrade note", () => {
    const notes = collect060UpgradeNotes(
      `${COMMENTED_V1}budget:\n  usd: 1\n  on_exceed:\n    degrade:\n      model: claude-haiku-4-5\n`,
    );
    expect(notes.find((n) => n.id === "route-reset-learned-pool")?.body.join("\n")).toContain(
      "crewhaus route reset",
    );
    expect(notes.some((n) => n.id === "degrade-under-pool")).toBe(true);
    // A heuristic pool: neither.
    const heuristic = collect060UpgradeNotes(
      COMMENTED_V1.replace("policy: learned", "policy: heuristic"),
    );
    expect(heuristic.some((n) => n.id === "route-reset-learned-pool")).toBe(false);
  });

  test("notes from both releases ride the plan, grouped under their own headers", () => {
    const plan = planUpgrade(
      `${COMMENTED_V1}budget:\n  usd: 1\n`,
      createDefaultEngine(),
      parseSpecValidator,
    );
    const releases = new Set((plan.notes ?? []).map((n) => n.release));
    expect(releases).toEqual(new Set(["0.3.0", "0.6.0"]));
    const rendered = formatUpgradePlan(plan, false);
    expect(rendered).toContain("0.2.x → 0.3.0 notes for this spec");
    expect(rendered).toContain("0.5.x → 0.6.0 notes for this spec");
    expect(rendered.indexOf("0.2.x → 0.3.0")).toBeLessThan(rendered.indexOf("0.5.x → 0.6.0"));
    expect(collectUpgradeNotes("{not: yaml: :")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 §9.2 — doctor's "spec behind / ahead of CLI" drift signal
// ---------------------------------------------------------------------------

describe("buildSpecVersionCheck — the doctor drift signal", () => {
  test("a spec behind the CLI is a WARN naming `crewhaus upgrade`, never a failure", () => {
    const check = buildSpecVersionCheck(`version: 1\n${CLI_SPEC}`, createDefaultEngine());
    expect(check.pass).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.reason).toContain("BEHIND");
    expect(check.reason).toContain("crewhaus upgrade");
  });

  test("a spec ahead of the CLI warns and points at chvm use latest", () => {
    const check = buildSpecVersionCheck(`version: 9\n${CLI_SPEC}`, createDefaultEngine());
    expect(check.warn).toBe(true);
    expect(check.reason).toContain("AHEAD");
    expect(check.reason).toContain("chvm use latest");
  });

  test("a current spec passes without a warn", () => {
    const check = buildSpecVersionCheck(`version: 2\n${CLI_SPEC}`, createDefaultEngine());
    expect(check.pass).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.label).toContain("v2");
  });
});
