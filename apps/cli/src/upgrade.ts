import type { MigrationEngine, SpecObject } from "@crewhaus/migration-engine";
import { type SpecDiffEntry, diffSpecYaml, specHasPath } from "@crewhaus/spec-patch";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Item 43 — `crewhaus upgrade`. The single-spec upgrade assistant: detect the
 * cwd spec's schema version, run the migration-engine chain up to the CLI's
 * current spec version, validate the migrated spec, and show a diff. `--write`
 * applies.
 *
 * Distinct from `crewhaus migrate-all` (which walks the whole spec-REGISTRY):
 * `upgrade` operates on the working spec FILE the author edits. Crucially it
 * passes a `validate` callback — the CLI's `migrate-all` passed none, so a
 * migrated spec was written UNCHECKED; here every migrated spec must parse
 * before it can be written.
 *
 * v0.3.0 (PR 20) — the assistant also carries RELEASE notes: informational,
 * per-spec 0.2.x→0.3.0 prompts (see {@link collect030UpgradeNotes}). They are
 * deliberately NOT `Migration` entries on the engine: 0.3.0 changes zero spec
 * SYNTAX (old specs parse unchanged — no schema-version bump to migrate), it
 * changes compile-time BEHAVIOR (default-on continuity, MCP env/header secret
 * lowering) and store formats (`crewhaus migrate memories`). Notes never
 * mutate the spec; each one tells the author the exact line or command.
 *
 * Side-effect-free: `planUpgrade` is a pure function over the spec text + an
 * injected engine + validator. The CLI wrapper reads/writes the file and prints.
 */

export type UpgradeAction = "up-to-date" | "upgrade" | "ahead" | "validate-fail";

/** One informational 0.2.x→0.3.0 prompt for the spec being upgraded. */
export type UpgradeNote = {
  /** Stable identity for tests/tooling (`continuity-default-on`, …). */
  readonly id: string;
  /** One-line headline. */
  readonly title: string;
  /** Follow-up lines, rendered indented under the headline. */
  readonly body: ReadonlyArray<string>;
};

/** The agent-loop shapes on which 0.3.0's continuity fabric is default-on. */
const CONTINUITY_DEFAULT_ON_TARGETS: ReadonlySet<string> = new Set([
  "cli",
  "channel",
  "managed",
  "research",
  "crew",
]);

/**
 * v0.3.0 (PR 20) — collect the 0.2.x→0.3.0 release notes that apply to THIS
 * spec. Pure over the YAML text; returns `[]` for unparseable YAML (the plan
 * itself reports that) and for specs the release doesn't affect.
 *
 *   - `continuity-default-on`: an agent-loop spec with no textual
 *     `continuity:` key recompiles with the continuity fabric wired; the note
 *     offers the one-line `continuity: false` pin that restores the 0.2.x
 *     bundle byte-for-byte.
 *   - `migrate-memories`: a `memory:` spec has fact stores under
 *     `.crewhaus/memories/` — the note points at the idempotent
 *     `crewhaus migrate memories` v2 backfill.
 *   - `mcp-secret-lowering`: `mcp_servers` env/headers values are now lowered
 *     through the `$UPPER_SNAKE` secret machinery — resolved from the running
 *     process env at boot, with malformed `$…` refs under credential-shaped
 *     keys failing compilation (behavior note, no spec change needed).
 */
export function collect030UpgradeNotes(yamlText: string): ReadonlyArray<UpgradeNote> {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const spec = parsed as Record<string, unknown>;
  const target = typeof spec["target"] === "string" ? spec["target"] : "";
  const notes: UpgradeNote[] = [];

  if (CONTINUITY_DEFAULT_ON_TARGETS.has(target) && !specHasPath(yamlText, ["continuity"])) {
    notes.push({
      id: "continuity-default-on",
      title: "0.3.0 recompiles this spec with continuity ON by default",
      body: [
        "Persistent focus/plans/goals, the requirements ledger, and teardown",
        "handoff.md are wired without a spec change (the release's one sanctioned",
        "behavior change). Want the exact 0.2.x bundle back? Add one line:",
        "  continuity: false   # restores the previous bundle byte-for-byte",
      ],
    });
  }

  if (specHasPath(yamlText, ["memory"])) {
    notes.push({
      id: "migrate-memories",
      title: "existing fact stores can take the optional v2 backfill",
      body: [
        "0.3.0 memory entries carry provenance/TTL/status fields; old stores keep",
        "reading as-is. Run `crewhaus migrate memories [--dry-run]` once to",
        "backfill .crewhaus/memories/*.jsonl in place (idempotent).",
      ],
    });
  }

  const mcpServers = spec["mcp_servers"];
  if (typeof mcpServers === "object" && mcpServers !== null && !Array.isArray(mcpServers)) {
    const affected = Object.entries(mcpServers as Record<string, unknown>)
      .filter(([, cfg]) => {
        if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) return false;
        const c = cfg as Record<string, unknown>;
        return c["env"] !== undefined || c["headers"] !== undefined;
      })
      .map(([name]) => name);
    if (affected.length > 0) {
      notes.push({
        id: "mcp-secret-lowering",
        title: `mcp_servers env/headers are now secret-lowered (${affected.join(", ")})`,
        body: [
          "Values route through the $UPPER_SNAKE secret machinery: `$VAR` resolves",
          "from the RUNNING process env at boot (no longer baked into the bundle),",
          "and a malformed `$…` ref under a credential-shaped key (*_KEY / *_TOKEN /",
          "*_SECRET / *_PASSWORD, Authorization, x-api-key) now fails compilation.",
          "Recompile and make sure those variables are exported where the harness runs.",
        ],
      });
    }
  }

  return notes;
}

export type UpgradePlan = {
  readonly action: UpgradeAction;
  /** The spec's current schema version (`version ?? 0`). */
  readonly fromVersion: number;
  /** The CLI's current spec-schema version (engine.latestVersion()). */
  readonly toVersion: number;
  /** The migrated YAML — present only for `action: "upgrade"`. */
  readonly migratedYaml?: string;
  /** Field-level diff (old → migrated) — present for `action: "upgrade"`. */
  readonly diff?: ReadonlyArray<SpecDiffEntry>;
  /** Failure detail for `action: "validate-fail"`. */
  readonly error?: string;
  /**
   * v0.3.0 — the informational 0.2.x→0.3.0 release notes that apply to this
   * spec (see {@link collect030UpgradeNotes}). Present for every parseable
   * spec, INCLUDING `up-to-date`: the schema-version stamp is orthogonal to
   * the release's behavior changes.
   */
  readonly notes?: ReadonlyArray<UpgradeNote>;
};

/**
 * Compute the upgrade plan for a spec's YAML against `engine`.
 *
 *   - `up-to-date`  : the spec is already at the current version → no-op.
 *   - `ahead`       : the spec's version is HIGHER than the CLI supports
 *                     (a newer-CLI-authored spec) → refuse, don't downgrade.
 *   - `upgrade`     : migrate up, validate, and produce the diff.
 *   - `validate-fail`: the migrated spec failed the injected validator (the
 *                     migration produced an invalid spec) — never written.
 *
 * `validate` receives the migrated spec object + throws on invalid (the CLI
 * wires `parseSpec(stringifyYaml(spec))`). Migrations that throw are reported
 * as `validate-fail` too, so a broken migration chain never crashes upgrade.
 */
export function planUpgrade(
  yamlText: string,
  engine: MigrationEngine,
  validate: (spec: SpecObject) => void,
): UpgradePlan {
  const toVersion = engine.latestVersion();
  let parsed: SpecObject;
  try {
    parsed = parseYaml(yamlText) as SpecObject;
  } catch (err) {
    return {
      action: "validate-fail",
      fromVersion: 0,
      toVersion,
      error: `spec is not parseable YAML: ${(err as Error).message}`,
    };
  }
  const fromVersion = (parsed?.version ?? 0) | 0;
  const notes = collect030UpgradeNotes(yamlText);

  if (fromVersion === toVersion) {
    return { action: "up-to-date", fromVersion, toVersion, notes };
  }
  if (fromVersion > toVersion) {
    return { action: "ahead", fromVersion, toVersion, notes };
  }

  let migrated: SpecObject;
  try {
    migrated = engine.migrate(parsed, toVersion);
  } catch (err) {
    return {
      action: "validate-fail",
      fromVersion,
      toVersion,
      error: `migration failed: ${(err as Error).message}`,
    };
  }
  // Validate the migrated spec BEFORE offering it for write (the fix for the
  // "migrated specs written unchecked" gap).
  try {
    validate(migrated);
  } catch (err) {
    return {
      action: "validate-fail",
      fromVersion,
      toVersion,
      error: `migrated spec failed validation: ${(err as Error).message}`,
    };
  }
  const migratedYaml = stringifyYaml(migrated);
  const diff = diffSpecYaml(yamlText, migratedYaml);
  return { action: "upgrade", fromVersion, toVersion, migratedYaml, diff, notes };
}

/**
 * Build the validate callback the CLI passes to {@link planUpgrade}: it
 * stringifies the migrated spec object and runs it through the injected
 * `parse` (the CLI wires `parseSpec`). Kept here so the CLI wrapper does not
 * need its own `yaml` import — the fix for `migrate-all` writing migrated specs
 * unchecked is one shared, tested helper.
 */
export function makeSpecValidator(parse: (yaml: string) => unknown): (spec: SpecObject) => void {
  return (spec: SpecObject): void => {
    parse(stringifyYaml(spec));
  };
}

/** Render the 0.2.x→0.3.0 notes block (empty string when no notes apply). */
function formatUpgradeNotes(notes: ReadonlyArray<UpgradeNote> | undefined): string {
  if (notes === undefined || notes.length === 0) return "";
  const lines: string[] = [
    "",
    "  0.2.x → 0.3.0 notes for this spec (informational — nothing is rewritten):",
  ];
  for (const note of notes) {
    lines.push(`  • ${note.title}`);
    for (const bodyLine of note.body) {
      lines.push(`      ${bodyLine}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Render an upgrade plan as the human-readable report. `write` toggles the
 *  "would apply" vs "applied" wording; returns the block. */
export function formatUpgradePlan(plan: UpgradePlan, write: boolean): string {
  switch (plan.action) {
    case "up-to-date":
      return `upgrade: spec is already at the current version (v${plan.toVersion}) — nothing to do.\n${formatUpgradeNotes(plan.notes)}`;
    case "ahead":
      return `upgrade: spec version v${plan.fromVersion} is NEWER than this CLI supports (v${plan.toVersion}).\n  Upgrade the CLI (\`chvm use latest\` / \`brew upgrade crewhaus\` / \`npm i -g crewhaus\`) rather than downgrading the spec.\n`;
    case "validate-fail":
      return `upgrade: cannot migrate — ${plan.error}\n`;
    case "upgrade": {
      const lines: string[] = [];
      lines.push(`upgrade: v${plan.fromVersion} → v${plan.toVersion}`);
      const diff = plan.diff ?? [];
      if (diff.length === 0) {
        lines.push("  (no field-level changes — a version stamp only)");
      } else {
        for (const d of diff) {
          if (d.kind === "added") lines.push(`  + ${d.path}: ${d.after}`);
          else if (d.kind === "removed") lines.push(`  - ${d.path}: ${d.before}`);
          else lines.push(`  ~ ${d.path}: ${d.before} → ${d.after}`);
        }
      }
      lines.push("");
      lines.push(
        write
          ? "  applied — spec rewritten in place."
          : "  dry-run — re-run with --write to apply.",
      );
      return `${lines.join("\n")}\n${formatUpgradeNotes(plan.notes)}`;
    }
  }
}
