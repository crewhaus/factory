import { type MigrationEngine, type SpecObject, findModelPools } from "@crewhaus/migration-engine";
import { migrateSpecYaml } from "@crewhaus/migration-runner";
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
 * 0.6.0 (§9.2) — the migration is now COMMENT-PRESERVING: each step's
 * `edits()` is applied through the spec-patch CST writer (shared with
 * `migrate-all` via `migrateSpecYaml`), so `upgrade --write` no longer
 * flattens the author's comments and key order. Only a step that supplies no
 * edits falls back to re-serialising the object, and the plan says so.
 *
 * The assistant also carries RELEASE notes: informational, per-spec prompts
 * about behaviour a release changed WITHOUT a spec-syntax change (see
 * {@link UPGRADE_NOTES_TABLE} — one row per release since 0.3.0). They are
 * deliberately NOT `Migration` entries on the engine: a note tells the author
 * the exact line or command; it never mutates the spec.
 *
 * Side-effect-free: `planUpgrade` is a pure function over the spec text + an
 * injected engine + validator. The CLI wrapper reads/writes the file and prints.
 */

export type UpgradeAction = "up-to-date" | "upgrade" | "ahead" | "validate-fail";

/** One informational release note for the spec being upgraded. */
export type UpgradeNote = {
  /** Stable identity for tests/tooling (`continuity-default-on`, …). */
  readonly id: string;
  /** The release whose behaviour change this note describes (`0.3.0`, `0.6.0`). */
  readonly release: string;
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

function parseSpecObject(yamlText: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
  const spec = parseSpecObject(yamlText);
  if (spec === undefined) return [];
  const release = "0.3.0";
  const target = typeof spec["target"] === "string" ? spec["target"] : "";
  const notes: UpgradeNote[] = [];

  if (CONTINUITY_DEFAULT_ON_TARGETS.has(target) && !specHasPath(yamlText, ["continuity"])) {
    notes.push({
      id: "continuity-default-on",
      release,
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
      release,
      title: "existing fact stores can take the optional v2 backfill",
      body: [
        "0.3.0 memory entries carry provenance/TTL/status fields; old stores keep",
        "reading as-is. Run `crewhaus migrate memories [--dry-run]` once to",
        "backfill .crewhaus/memories/*.jsonl in place (idempotent).",
      ],
    });
  }

  const mcpServers = spec["mcp_servers"];
  if (isRecord(mcpServers)) {
    const affected = Object.entries(mcpServers)
      .filter(([, cfg]) => {
        if (!isRecord(cfg)) return false;
        return cfg["env"] !== undefined || cfg["headers"] !== undefined;
      })
      .map(([name]) => name);
    if (affected.length > 0) {
      notes.push({
        id: "mcp-secret-lowering",
        release,
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

/** Does any workflow step / graph node run a `kind: judge` gate? */
function hasJudgeGate(spec: Record<string, unknown>): boolean {
  const steps = spec["steps"];
  if (Array.isArray(steps) && steps.some((s) => isRecord(s) && s["kind"] === "judge")) return true;
  const nodes = spec["nodes"];
  if (isRecord(nodes) && Object.values(nodes).some((n) => isRecord(n) && n["kind"] === "judge")) {
    return true;
  }
  return false;
}

/**
 * 0.6.0 (§9.2, §14) — the 0.5.x→0.6.0 release notes. The release's SANCTIONED
 * behaviour changes are all bug fixes, and each one gets a note on exactly the
 * specs it touches:
 *
 *   - `crew-role-pools-live`: a crew role's `model_pool` / `model_tiers` /
 *     `model_fallbacks` used to be emitted and never read; it is live now.
 *   - `budget-every-call`: `budget` now gates every model call — tool
 *     iterations included, and on single-turn hosts — instead of one REPL
 *     turn boundary; `budget.scope: session` is the daemon-shaped option.
 *   - `judge-spend-metered`: in-loop and gate judge spend rides the run bus
 *     with `role: judge`, so it counts against `budget` under `judge_share`
 *     (default 0.3 of the cap) and appears in `cost-summary`.
 *   - `degrade-under-pool`: `budget.on_exceed.degrade` under a pool restricts
 *     eligibility instead of swapping an adapter the pool overwrote.
 *   - `route-reset-learned-pool` (§6.3): MIGRATION_1_TO_2 states a learned
 *     pool's `reward.quality_source: none` explicitly; changing the source
 *     later is a lineage change, and `crewhaus route reset` is the reset.
 */
export function collect060UpgradeNotes(yamlText: string): ReadonlyArray<UpgradeNote> {
  const spec = parseSpecObject(yamlText);
  if (spec === undefined) return [];
  const release = "0.6.0";
  const target = typeof spec["target"] === "string" ? spec["target"] : "";
  const notes: UpgradeNote[] = [];
  const pools = findModelPools(spec as SpecObject);

  if (target === "crew" && isRecord(spec["roles"])) {
    const routed = Object.entries(spec["roles"])
      .filter(
        ([, role]) =>
          isRecord(role) &&
          (role["model_pool"] !== undefined ||
            role["model_tiers"] !== undefined ||
            role["model_fallbacks"] !== undefined),
      )
      .map(([name]) => name);
    if (routed.length > 0) {
      notes.push({
        id: "crew-role-pools-live",
        release,
        title: `crew per-role model routing is LIVE for roles ${routed.join(", ")}`,
        body: [
          "Before 0.6.0 a role's model_pool / model_tiers / model_fallbacks was",
          "emitted into the bundle and never read — every role served on its",
          "declared model. The orchestrator now routes each role through its own",
          "block. Remove the block from a role to keep its previous behaviour.",
        ],
      });
    }
  }

  const budget = spec["budget"];
  if (budget !== undefined) {
    notes.push({
      id: "budget-every-call",
      release,
      title: "budget is now enforced on every model call, single-turn hosts included",
      body: [
        "0.5.x checked the cap once per REPL turn, so a one-turn run (channel,",
        "managed, workflow step) and a long tool loop were never stopped. 0.6.0",
        "gates each model call — tool iterations too — and severs an in-flight",
        "tool loop at the cap (a classified crewhaus_budget failure). Daemons that",
        "want the cap to span a conversation set `budget.scope: session`.",
      ],
    });
  }

  if (spec["evaluation"] !== undefined || hasJudgeGate(spec)) {
    notes.push({
      id: "judge-spend-metered",
      release,
      title: "judge spend is now metered into budget under judge_share",
      body: [
        "In-loop `evaluation` graders and `kind: judge` gates publish their usage",
        "on the run bus (role: judge), so it is priced, counted against `budget`",
        "(bounded by `budget.judge_share`, default 0.3 of the cap) and listed in",
        "`crewhaus cost-summary`. Tune the share if a judge-heavy spec now trips.",
      ],
    });
  }

  if (
    isRecord(budget) &&
    isRecord(budget["on_exceed"]) &&
    budget["on_exceed"]["degrade"] !== undefined &&
    pools.length > 0
  ) {
    notes.push({
      id: "degrade-under-pool",
      release,
      title: "budget.on_exceed.degrade under a model_pool now takes effect",
      body: [
        "0.5.x swapped an adapter the pool overwrote on the very next call (and",
        "logged a model_failover that never happened). 0.6.0 makes the degrade",
        "rung the forced candidate once the cap is breached (policy: forced,",
        "reason: budget_degrade). Drop `degrade` to keep the pool unconstrained.",
      ],
    });
  }

  const learned = pools.filter((site) => site.pool["policy"] === "learned");
  if (learned.length > 0) {
    notes.push({
      id: "route-reset-learned-pool",
      release,
      title: "learned pools: reward.quality_source is now stated explicitly (none)",
      body: [
        "The v2 migration writes `reward: { quality_source: none }` on each learned",
        "pool so the default steering the reward is visible. `none` keeps every",
        "arm in .crewhaus/routing/arms.jsonl valid; switching to in_loop / shadow /",
        "promoted later is a lineage change — run `crewhaus route reset` then.",
      ],
    });
  }

  return notes;
}

/** One row of the per-release upgrade-notes table. */
export type UpgradeNotesRelease = {
  /** The release the notes describe. */
  readonly release: string;
  /** The version range being upgraded FROM, for the rendered header. */
  readonly from: string;
  /** Collects the notes that apply to a spec (pure over its YAML text). */
  readonly collect: (yamlText: string) => ReadonlyArray<UpgradeNote>;
};

/**
 * 0.6.0 §9.2 — the per-release upgrade-notes table, generalising the 0.3.0
 * collector: one row per release whose behaviour changed without a
 * spec-syntax change. Rendered oldest-first so an author two releases behind
 * reads the notes in the order the changes shipped.
 */
export const UPGRADE_NOTES_TABLE: ReadonlyArray<UpgradeNotesRelease> = Object.freeze([
  { release: "0.3.0", from: "0.2.x", collect: collect030UpgradeNotes },
  { release: "0.6.0", from: "0.5.x", collect: collect060UpgradeNotes },
]);

/** Every release's notes that apply to this spec, oldest release first. */
export function collectUpgradeNotes(yamlText: string): ReadonlyArray<UpgradeNote> {
  return UPGRADE_NOTES_TABLE.flatMap((row) => row.collect(yamlText));
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
  /**
   * 0.6.0 — whether `migratedYaml` kept the source's comments and key order
   * (every step declared `edits()`). Present for `action: "upgrade"`.
   */
  readonly commentsPreserved?: boolean;
  /** Failure detail for `action: "validate-fail"`. */
  readonly error?: string;
  /**
   * The informational release notes that apply to this spec (see
   * {@link collectUpgradeNotes}). Present for every parseable spec,
   * INCLUDING `up-to-date`: the schema-version stamp is orthogonal to a
   * release's behavior changes.
   */
  readonly notes?: ReadonlyArray<UpgradeNote>;
};

/**
 * Compute the upgrade plan for a spec's YAML against `engine`.
 *
 *   - `up-to-date`  : the spec is already at the current version → no-op.
 *   - `ahead`       : the spec's version is HIGHER than the CLI supports
 *                     (a newer-CLI-authored spec) → refuse, don't downgrade.
 *   - `upgrade`     : migrate up (comment-preserving), validate, and diff.
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
  const notes = collectUpgradeNotes(yamlText);

  if (fromVersion === toVersion) {
    return { action: "up-to-date", fromVersion, toVersion, notes };
  }
  if (fromVersion > toVersion) {
    return { action: "ahead", fromVersion, toVersion, notes };
  }

  let migrated: ReturnType<typeof migrateSpecYaml>;
  try {
    migrated = migrateSpecYaml(yamlText, engine, toVersion);
  } catch (err) {
    return {
      action: "validate-fail",
      fromVersion,
      toVersion,
      error: `migration failed: ${(err as Error).message}`,
    };
  }
  // Validate the migrated spec BEFORE offering it for write (the fix for the
  // "migrated specs written unchecked" gap). The CST path already re-parsed
  // the text through the live union; this is the caller's own gate on top.
  try {
    validate(migrated.spec);
  } catch (err) {
    return {
      action: "validate-fail",
      fromVersion,
      toVersion,
      error: `migrated spec failed validation: ${(err as Error).message}`,
    };
  }
  const diff = diffSpecYaml(yamlText, migrated.yaml);
  return {
    action: "upgrade",
    fromVersion,
    toVersion,
    migratedYaml: migrated.yaml,
    diff,
    commentsPreserved: migrated.commentsPreserved,
    notes,
  };
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

/**
 * 0.6.0 §9.2 — the `crewhaus doctor` drift signal. A 0.5.x CLI parses and
 * compiles a `version: 2` spec with 0.5.x semantics rather than refusing it
 * (`versionField` is a plain optional int), so `upgrade`'s `ahead` message
 * was the only place a spec/CLI mismatch ever surfaced. Doctor now reads the
 * same drift through `planUpgrade` and reports it as a WARN — never a
 * failure: a spec behind the CLI still compiles and runs.
 */
export function buildSpecVersionCheck(
  yamlText: string,
  engine: MigrationEngine,
): { readonly label: string; readonly pass: true; readonly warn?: true; readonly reason?: string } {
  const plan = planUpgrade(yamlText, engine, () => undefined);
  switch (plan.action) {
    case "up-to-date":
      return { label: `spec schema version (v${plan.toVersion}, current)`, pass: true };
    case "upgrade":
      return {
        label: "spec schema version",
        pass: true,
        warn: true,
        reason: `spec is BEHIND this CLI (v${plan.fromVersion} → v${plan.toVersion}) — run \`crewhaus upgrade\` (dry-run) then \`crewhaus upgrade --write\`; the migration keeps comments and key order`,
      };
    case "ahead":
      return {
        label: "spec schema version",
        pass: true,
        warn: true,
        reason: `spec is AHEAD of this CLI (v${plan.fromVersion} > v${plan.toVersion}) — it compiles with this CLI's older semantics; upgrade the CLI (\`chvm use latest\`) to honour it`,
      };
    case "validate-fail":
      return {
        label: "spec schema version",
        pass: true,
        warn: true,
        reason: `could not determine drift — ${plan.error ?? "the spec did not migrate cleanly"}`,
      };
  }
}

/** Render the release-notes block (empty string when no notes apply). */
function formatUpgradeNotes(notes: ReadonlyArray<UpgradeNote> | undefined): string {
  if (notes === undefined || notes.length === 0) return "";
  const lines: string[] = [];
  for (const row of UPGRADE_NOTES_TABLE) {
    const own = notes.filter((n) => n.release === row.release);
    if (own.length === 0) continue;
    lines.push(
      "",
      `  ${row.from} → ${row.release} notes for this spec (informational — nothing is rewritten):`,
    );
    for (const note of own) {
      lines.push(`  • ${note.title}`);
      for (const bodyLine of note.body) {
        lines.push(`      ${bodyLine}`);
      }
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
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
      lines.push(
        plan.commentsPreserved === false
          ? "  note: a migration step in this chain supplies no edit list — comments and key order are re-serialised."
          : "  comments and key order are preserved.",
      );
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
