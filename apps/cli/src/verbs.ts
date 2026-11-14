/**
 * The CLI's verb inventory: every top-level `crewhaus <verb>` the dispatch in
 * `index.ts` answers, with the sub-verbs and flags each accepts. It is the one
 * list a command shown anywhere else (a Home screen, a hint, a doc) is checked
 * against, and `apps/cli/verbs.json` is this inventory generated for readers
 * outside the repository.
 *
 * Two kinds of verb:
 *
 *   - **Legacy verbs** dispatch inline in `index.ts` and parse their flags with
 *     one of the `arg-schemas.ts` schemas. Each has one row in
 *     {@link LEGACY_VERBS}.
 *   - **Families** live in their own `<verb>-cmd.ts` module and export
 *     `CLI_FAMILY`: the sub-verbs and the flags each one's parser takes. The
 *     module's parser reads its flags from that object, so the inventory and
 *     the parser cannot disagree.
 *
 * The rule later changes follow:
 *
 *   - A NEW verb is a `<verb>-cmd.ts` module exporting `CLI_FAMILY` (declared
 *     `as const satisfies CliFamily`), plus one dispatch line in `index.ts`.
 *   - A new sub-verb or flag on a legacy verb edits that verb's row here, or
 *     its `arg-schemas.ts` schema (append-only).
 *   - A new top-level legacy row fails CI (`verbs.test.ts` pins the count).
 *
 * `since` is the first release that shipped the verb; "0.8.0" stands for
 * "present in 0.8.0 or earlier". A deprecated verb names its replacement and
 * the release it goes away in, and {@link deprecationNotice} is the one
 * sentence the CLI prints for it.
 *
 * Side-effect-free, and imported by nothing the `crewhaus` binary runs: the
 * family modules import only its types.
 */
import type { FlagSpec, ParseArgsSchema } from "@crewhaus/infra-utils";
import * as SCHEMAS from "./arg-schemas";

/** How a family flag consumes argv: `value` once, `values` repeatably, `boolean` never. */
export type FlagKind = "value" | "boolean" | "values";
export type VerbFlagSpec = Readonly<Record<string, FlagKind>>;
/** The name of an `arg-schemas.ts` export. */
export type SchemaName = keyof typeof SCHEMAS;
export type Lifecycle = { readonly since: string } & (
  | { readonly status?: "stable" }
  | { readonly status: "deprecated"; readonly removal: string; readonly use: string }
);

export type LegacyVerb = Lifecycle & {
  readonly verb: string;
  /** What the tokens after the verb (or after its sub-verb) parse under. */
  readonly schema?: SchemaName;
  /**
   * The sub-verbs, each with the schema its tokens parse under: `null` is the
   * verb's own `schema`. The key `""` means the bare verb is valid.
   */
  readonly sub?: Readonly<Record<string, SchemaName | null>>;
  /**
   * A first token that is not a `sub` key is the verb's own positional, and
   * ALL tokens parse under `schema` (`eval <spec>`, `dream <spec>`). Without
   * it, a first token that is not a key is refused.
   */
  readonly positionalFirst?: true;
  /** Where `index.ts` checks the sub-verb: in the verb's `case` block, or in its handler. */
  readonly subCheckedBy?: "dispatch" | "handler";
};

export type FamilySub = { readonly flags: VerbFlagSpec };

export type CliFamily = Lifecycle & {
  readonly verb: string;
  /** The sub-verb a bare `crewhaus <verb> [--flags]` runs (hangar: `serve`). */
  readonly bare?: string;
  readonly sub: Readonly<Record<string, FamilySub>>;
};

export type InventoryEntry =
  | ({ readonly kind: "legacy" } & LegacyVerb)
  | ({ readonly kind: "family" } & CliFamily);

/** The composed inventory: every verb, sorted by name. */
export type Inventory = { readonly entries: readonly InventoryEntry[] };

/** One flag as `verbs.json` publishes it. */
export type FlagDocument = {
  readonly name: string;
  readonly short?: string;
  readonly takesValue: boolean;
  /** A family flag that may be given more than once. */
  readonly repeatable?: true;
};

export type VerbDocument = {
  readonly verb: string;
  readonly kind: "legacy" | "family";
  readonly since: string;
  readonly status: "stable" | "deprecated";
  readonly removal?: string;
  readonly use?: string;
  /** The sub-verb a bare family verb runs. */
  readonly bare?: string;
  /** Sub-verbs, `""` for a valid bare verb; `flags: null` when nothing declares them. */
  readonly sub: Readonly<Record<string, { readonly flags: readonly FlagDocument[] | null }>> | null;
  /** The verb's own flags; `null` when it has none declared. */
  readonly flags: readonly FlagDocument[] | null;
};

/** What `apps/cli/verbs.json` holds. No CLI version: a release never changes it. */
export type VerbsDocument = {
  readonly version: 1;
  readonly verbs: readonly VerbDocument[];
};

/**
 * The one documented exception to "a verb has at most two levels":
 * `crewhaus fleet run <verb> …` passes everything after `run` to each
 * harness as its own command, so a third word is that command, not a
 * sub-verb of `fleet run`.
 */
export const NESTED_VERB_EXCEPTIONS: readonly string[] = Object.freeze(["fleet run"]);

const SUB_KEY_RE = /^[a-z][a-z0-9-]*$/;
const VERB_RE = /^[a-z][a-z0-9-]*$/;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** `since` for every verb present in 0.8.0 or earlier. */
const V0_8_0 = "0.8.0";

/**
 * One row per legacy dispatch label in `index.ts`, sorted by verb. The four
 * families (`access`, `daemon`, `hangar`, `harness`) are not here: their
 * modules declare themselves.
 */
export const LEGACY_VERBS: readonly LegacyVerb[] = deepFreeze<LegacyVerb[]>([
  { verb: "advise", since: V0_8_0, schema: "ADVISE_SCHEMA" },
  {
    verb: "approvals",
    since: V0_8_0,
    schema: "APPROVALS_SCHEMA",
    sub: {
      "": null,
      list: null,
      show: null,
      grant: null,
      deny: null,
      supersede: null,
      defer: null,
      rules: null,
      revoke: null,
    },
    subCheckedBy: "dispatch",
  },
  {
    verb: "audit",
    since: V0_8_0,
    schema: "AUDIT_SCHEMA",
    sub: { verify: null },
    subCheckedBy: "dispatch",
  },
  { verb: "build-image", since: V0_8_0, schema: "BUILD_IMAGE_SCHEMA" },
  {
    verb: "channel",
    since: V0_8_0,
    schema: "CHANNEL_SCHEMA",
    sub: { provision: null, verify: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "cloud",
    since: V0_8_0,
    schema: "CLOUD_SCHEMA",
    sub: { deploy: null, teardown: null },
    subCheckedBy: "dispatch",
  },
  { verb: "compile", since: V0_8_0, schema: "COMPILE_SCHEMA" },
  {
    verb: "compliance",
    since: V0_8_0,
    schema: "COMPLIANCE_SCHEMA",
    sub: { evidence: null },
    subCheckedBy: "dispatch",
  },
  { verb: "context", since: V0_8_0, schema: "CONTEXT_SCHEMA" },
  { verb: "cost-summary", since: V0_8_0, schema: "COST_SUMMARY_SCHEMA" },
  {
    verb: "dataset",
    since: V0_8_0,
    schema: "DATASET_SCHEMA",
    sub: { mine: null, synthesize: null, "refresh-goldens": null, audit: null, lint: null },
    subCheckedBy: "handler",
  },
  {
    verb: "datasets",
    since: V0_8_0,
    schema: "DATASETS_SCHEMA",
    sub: {
      list: null,
      get: null,
      put: null,
      verify: null,
      status: null,
      release: null,
      card: null,
      holdout: null,
      uses: null,
    },
    subCheckedBy: "handler",
  },
  {
    verb: "deploy",
    since: V0_8_0,
    schema: "DEPLOY_SCHEMA",
    sub: {
      fly: "CLOUD_DEPLOY_SCHEMA",
      render: "CLOUD_DEPLOY_SCHEMA",
      railway: "CLOUD_DEPLOY_SCHEMA",
      heroku: "CLOUD_DEPLOY_SCHEMA",
      promote: null,
      rollback: null,
      canary: null,
      activate: "DEPLOY_ACTIVATE_SCHEMA",
      list: "DEPLOY_ACTIVATE_SCHEMA",
    },
    subCheckedBy: "handler",
  },
  { verb: "dev", since: V0_8_0, schema: "DEV_SCHEMA" },
  { verb: "distill", since: V0_8_0, schema: "DISTILL_SCHEMA" },
  { verb: "doctor", since: V0_8_0, schema: "DOCTOR_SCHEMA" },
  {
    verb: "dream",
    since: V0_8_0,
    schema: "DREAM_CLI_SCHEMA",
    sub: { run: null, status: null, init: null },
    positionalFirst: true,
    subCheckedBy: "dispatch",
  },
  {
    verb: "egress",
    since: V0_8_0,
    schema: "EGRESS_SCHEMA",
    sub: { review: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "eval",
    since: V0_8_0,
    schema: "EVAL_SCHEMA",
    sub: {
      coverage: "EVAL_COVERAGE_SCHEMA",
      suite: "EVAL_SUITE_SCHEMA",
      plan: "EVAL_PLAN_SCHEMA",
      leaderboard: "EVAL_LEADERBOARD_SCHEMA",
      history: "EVAL_REPORT_SCHEMA",
      baseline: "EVAL_REPORT_SCHEMA",
      baselines: "EVAL_REPORT_SCHEMA",
      diff: "EVAL_REPORT_SCHEMA",
    },
    positionalFirst: true,
    subCheckedBy: "dispatch",
  },
  {
    verb: "eval-report",
    since: V0_8_0,
    schema: "EVAL_REPORT_SCHEMA",
    sub: { diff: null, history: null, trends: null, export: null, baseline: null },
    subCheckedBy: "handler",
  },
  {
    verb: "experiment",
    since: V0_8_0,
    schema: "EXPERIMENT_SCHEMA",
    sub: { "": null, status: null, record: null, assign: null },
    subCheckedBy: "handler",
  },
  {
    verb: "export",
    since: V0_8_0,
    schema: "EXPORT_SCHEMA",
    sub: { "claude-plugin": null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "failures",
    since: V0_8_0,
    schema: "FAILURES_SCHEMA",
    sub: { report: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "faq",
    since: V0_8_0,
    schema: "FAQ_SCHEMA",
    sub: { distill: null },
    subCheckedBy: "handler",
  },
  {
    verb: "federation",
    since: V0_8_0,
    schema: "FEDERATION_SCHEMA",
    sub: { discover: null },
    subCheckedBy: "dispatch",
  },
  { verb: "feedback", since: V0_8_0, schema: "FEEDBACK_SCHEMA" },
  {
    verb: "fewshot",
    since: V0_8_0,
    schema: "FEWSHOT_SCHEMA",
    sub: { harvest: null, show: null },
    subCheckedBy: "handler",
  },
  {
    verb: "fleet",
    since: V0_8_0,
    schema: "FLEET_SCHEMA",
    sub: { "": null, list: null, status: null, run: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "flywheel",
    since: V0_8_0,
    schema: "FLYWHEEL_SCHEMA",
    sub: { init: null, run: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "graders",
    since: V0_8_0,
    sub: {
      suggest: "GRADERS_SUGGEST_SCHEMA",
      test: "GRADERS_TEST_SCHEMA",
      card: "GRADERS_CARD_SCHEMA",
    },
    subCheckedBy: "dispatch",
  },
  {
    verb: "incident",
    since: V0_8_0,
    schema: "INCIDENT_SCHEMA",
    sub: { collect: null },
    subCheckedBy: "dispatch",
  },
  { verb: "init", since: V0_8_0, schema: "INIT_SCHEMA" },
  { verb: "intents", since: V0_8_0, schema: "INTENTS_SCHEMA" },
  {
    verb: "judge",
    since: V0_8_0,
    schema: "JUDGE_SCHEMA",
    sub: { calibrate: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "justification",
    since: V0_8_0,
    schema: "JUSTIFICATION_SCHEMA",
    sub: { calibrate: null, preflight: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "knowledge",
    since: V0_8_0,
    schema: "KNOWLEDGE_SCHEMA",
    sub: { "": null, sync: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "lessons",
    since: V0_8_0,
    schema: "LESSONS_SCHEMA",
    sub: { update: null, retire: null },
    subCheckedBy: "handler",
  },
  { verb: "lint", since: V0_8_0, schema: "LINT_SCHEMA" },
  { verb: "loadtest", since: V0_8_0, schema: "LOADTEST_SCHEMA" },
  {
    verb: "mcp",
    since: V0_8_0,
    schema: "MCP_SCHEMA",
    sub: { doctor: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "memory",
    since: V0_8_0,
    schema: "MEMORY_SCHEMA",
    sub: { list: null, show: null, forget: null, sweep: null, correct: null, mark: null },
    subCheckedBy: "handler",
  },
  {
    verb: "migrate",
    since: V0_8_0,
    schema: "MIGRATE_MEMORIES_SCHEMA",
    sub: { memories: null },
    subCheckedBy: "dispatch",
  },
  { verb: "migrate-all", since: V0_8_0, schema: "MIGRATE_SCHEMA" },
  {
    verb: "model",
    since: V0_8_0,
    schema: "MODEL_SCHEMA",
    sub: { "right-size": null },
    subCheckedBy: "dispatch",
  },
  { verb: "model-scan", since: V0_8_0, schema: "MODEL_SCAN_SCHEMA" },
  {
    verb: "models",
    since: V0_8_0,
    sub: { "": null, list: null, explain: null, audit: null, propose: null },
    subCheckedBy: "handler",
  },
  {
    verb: "onchain",
    since: V0_8_0,
    schema: "ONCHAIN_SCHEMA",
    sub: { tune: null, sentinel: null },
    subCheckedBy: "dispatch",
  },
  { verb: "optimize", since: V0_8_0, schema: "OPTIMIZE_SCHEMA" },
  {
    verb: "permissions",
    since: V0_8_0,
    schema: "PERMISSIONS_SCHEMA",
    sub: { suggest: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "pii",
    since: V0_8_0,
    schema: "PII_SCHEMA",
    sub: { tune: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "plugins",
    since: V0_8_0,
    schema: "PLUGINS_SCHEMA",
    sub: {
      "": null,
      list: null,
      search: null,
      install: null,
      uninstall: null,
      outdated: null,
      publish: null,
      grants: null,
      grant: null,
      revoke: null,
    },
    subCheckedBy: "handler",
  },
  {
    verb: "pricing",
    since: V0_8_0,
    schema: "PRICING_SCHEMA",
    sub: { sync: null, show: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "propose",
    since: V0_8_0,
    schema: "PROPOSE_SCHEMA",
  },
  {
    verb: "provability",
    since: V0_8_0,
    schema: "PROVABILITY_SCHEMA",
    sub: { "": null, show: null, check: null, audit: null, checkers: null, prune: null },
    subCheckedBy: "handler",
  },
  { verb: "rate", since: V0_8_0, schema: "RATE_SCHEMA" },
  {
    verb: "redteam",
    since: V0_8_0,
    schema: "REDTEAM_SCHEMA",
    sub: { "": null, generate: null, report: null },
    subCheckedBy: "handler",
  },
  {
    verb: "retention",
    since: V0_8_0,
    schema: "RETENTION_SCHEMA",
    sub: { sweep: null, export: null, purge: null },
    subCheckedBy: "dispatch",
  },
  { verb: "retire", since: V0_8_0, schema: "RETIRE_SCHEMA" },
  {
    verb: "review",
    since: V0_8_0,
    schema: "REVIEW_SCHEMA",
    sub: { "": null, list: null, next: null, resolve: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "route",
    since: V0_8_0,
    sub: {
      status: null,
      reset: null,
      explain: null,
      freeze: null,
      promote: null,
      propose: null,
    },
    subCheckedBy: "handler",
  },
  { verb: "run", since: V0_8_0, schema: "RUN_SCHEMA" },
  {
    verb: "runs",
    since: V0_8_0,
    schema: "RUNS_SCHEMA",
    sub: { resume: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "sandbox",
    since: V0_8_0,
    schema: "SANDBOX_SCHEMA",
    sub: { doctor: null },
    subCheckedBy: "dispatch",
  },
  { verb: "scaffold-evals", since: V0_8_0, schema: "SCAFFOLD_EVALS_SCHEMA" },
  {
    verb: "schedule",
    since: V0_8_0,
    schema: "SCHEDULE_SCHEMA",
    sub: { "": null, generate: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "secrets",
    since: V0_8_0,
    schema: "SECRETS_SCHEMA",
    sub: { doctor: null, rotate: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "security",
    since: V0_8_0,
    sub: { digest: "SECURITY_SCHEMA", corpus: "SECURITY_CORPUS_SCHEMA" },
    subCheckedBy: "dispatch",
  },
  { verb: "serve", since: V0_8_0, schema: "SERVE_SCHEMA" },
  {
    verb: "services",
    since: V0_8_0,
    schema: "SERVICES_SCHEMA",
    sub: { setup: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "sessions",
    since: V0_8_0,
    schema: "SESSIONS_SCHEMA",
    sub: { summarize: null, export: null, tail: null },
    subCheckedBy: "handler",
  },
  {
    verb: "spec",
    since: V0_8_0,
    schema: "SPEC_SCHEMA",
    sub: { put: null, list: null, get: null, pin: null, alias: null, log: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "state",
    since: V0_8_0,
    schema: "STATE_SCHEMA",
    sub: { backup: null, restore: null, clear: null, trash: null },
    subCheckedBy: "dispatch",
  },
  {
    verb: "templates",
    since: V0_8_0,
    schema: "TEMPLATES_SCHEMA",
    sub: { "": null, list: null, search: null, use: null },
    subCheckedBy: "handler",
  },
  {
    verb: "tools",
    since: V0_8_0,
    schema: "TOOLS_SCHEMA",
    sub: { list: null, categories: null, show: null, search: null, suggest: null, audit: null },
    subCheckedBy: "dispatch",
  },
  { verb: "upgrade", since: V0_8_0, schema: "UPGRADE_SCHEMA" },
  { verb: "version", since: V0_8_0 },
  {
    verb: "watchme",
    since: V0_8_0,
    schema: "WATCHME_SCHEMA",
    sub: {
      "": null,
      start: null,
      stop: null,
      status: null,
      report: null,
      intents: null,
      synthesize: null,
      publish: null,
    },
    subCheckedBy: "dispatch",
  },
  {
    verb: "wiki",
    since: V0_8_0,
    schema: "WIKI_SCHEMA",
    sub: {
      list: null,
      show: null,
      search: null,
      stats: null,
      write: null,
      archive: null,
      rollback: null,
    },
    subCheckedBy: "handler",
  },
]);

/** Every verb, legacy rows and the families the caller loaded, sorted by name. */
export function composeInventory(families: readonly CliFamily[]): Inventory {
  const entries: InventoryEntry[] = [
    ...LEGACY_VERBS.map((row) => ({ kind: "legacy" as const, ...row })),
    ...families.map((family) => ({ kind: "family" as const, ...family })),
  ];
  entries.sort((a, b) => (a.verb < b.verb ? -1 : a.verb > b.verb ? 1 : 0));
  return { entries };
}

/** The inventory entry for `verb`, if there is one. */
export function findVerb(inv: Inventory, verb: string): InventoryEntry | undefined {
  return inv.entries.find((entry) => entry.verb === verb);
}

/** The schema an `arg-schemas.ts` export name resolves to, if it does. */
export function schemaNamed(name: string): ParseArgsSchema | undefined {
  const value = (SCHEMAS as Readonly<Record<string, unknown>>)[name];
  return value !== null &&
    typeof value === "object" &&
    Array.isArray((value as ParseArgsSchema).flags)
    ? (value as ParseArgsSchema)
    : undefined;
}

function lifecycleReasons(entry: InventoryEntry): string[] {
  const reasons: string[] = [];
  if (typeof entry.since !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.since)) {
    reasons.push(`${entry.verb}: "since" must be a release like 0.9.0`);
  }
  const status = (entry as { status?: string }).status;
  if (status === "deprecated") {
    const loose = entry as { removal?: unknown; use?: unknown };
    if (typeof loose.removal !== "string" || loose.removal === "") {
      reasons.push(
        `${entry.verb}: a deprecated verb names the release it goes away in ("removal")`,
      );
    }
    if (typeof loose.use !== "string" || loose.use === "") {
      reasons.push(`${entry.verb}: a deprecated verb names its replacement ("use")`);
    }
  } else if (status !== undefined && status !== "stable") {
    reasons.push(`${entry.verb}: unknown status "${String(status)}"`);
  }
  return reasons;
}

/**
 * Why this inventory is unsound, one reason per defect; `[]` when it is
 * sound. Refuses a name used twice, a deprecated verb without `removal` or
 * `use`, a family sub-verb with a sub-verb of its own (two levels only, bar
 * {@link NESTED_VERB_EXCEPTIONS}), a sub-verb key outside `[a-z][a-z0-9-]*`
 * other than the bare marker `""`, `positionalFirst` on a row with no
 * schema, and a schema name `arg-schemas.ts` does not export.
 */
export function validateInventory(inv: Inventory): readonly string[] {
  const reasons: string[] = [];
  const seen = new Map<string, string>();
  for (const entry of inv.entries) {
    const previous = seen.get(entry.verb);
    if (previous !== undefined) {
      reasons.push(`"${entry.verb}" is declared twice (${previous} and ${entry.kind})`);
    }
    seen.set(entry.verb, entry.kind);
    if (!VERB_RE.test(entry.verb)) reasons.push(`"${entry.verb}" is not a verb name`);
    reasons.push(...lifecycleReasons(entry));
    if (entry.kind === "legacy") {
      if (entry.schema !== undefined && schemaNamed(entry.schema) === undefined) {
        reasons.push(`${entry.verb}: schema ${entry.schema} is not an arg-schemas.ts export`);
      }
      if (entry.positionalFirst === true && entry.schema === undefined) {
        reasons.push(`${entry.verb}: positionalFirst needs a schema for the verb's own positional`);
      }
      for (const [key, schema] of Object.entries(entry.sub ?? {})) {
        if (key !== "" && !SUB_KEY_RE.test(key)) {
          reasons.push(`${entry.verb}: sub-verb "${key}" is not a sub-verb name`);
        }
        if (schema !== null && schemaNamed(schema) === undefined) {
          reasons.push(`${entry.verb} ${key}: schema ${schema} is not an arg-schemas.ts export`);
        }
      }
    } else {
      if (entry.bare !== undefined && entry.sub[entry.bare] === undefined) {
        reasons.push(`${entry.verb}: bare runs "${entry.bare}", which is not a sub-verb`);
      }
      for (const [key, sub] of Object.entries(entry.sub)) {
        if (!SUB_KEY_RE.test(key)) {
          reasons.push(`${entry.verb}: sub-verb "${key}" is not a sub-verb name`);
        }
        if ("sub" in sub && !NESTED_VERB_EXCEPTIONS.includes(`${entry.verb} ${key}`)) {
          reasons.push(
            `${entry.verb} ${key}: a sub-verb has no sub-verbs of its own (two levels only)`,
          );
        }
        for (const [flag, kind] of Object.entries(sub.flags ?? {})) {
          if (kind !== "value" && kind !== "values" && kind !== "boolean") {
            reasons.push(`${entry.verb} ${key} --${flag}: unknown flag kind "${String(kind)}"`);
          }
        }
      }
    }
  }
  return reasons;
}

function schemaFlags(schema: SchemaName | undefined): readonly FlagDocument[] | null {
  if (schema === undefined) return null;
  const resolved = schemaNamed(schema);
  if (resolved === undefined) return null;
  return resolved.flags.map((flag: FlagSpec) => ({
    name: flag.name,
    ...(flag.short !== undefined ? { short: flag.short } : {}),
    takesValue: flag.takesValue === true,
  }));
}

function familyFlags(flags: VerbFlagSpec): readonly FlagDocument[] {
  return Object.entries(flags).map(([name, kind]) => ({
    name,
    takesValue: kind !== "boolean",
    ...(kind === "values" ? { repeatable: true as const } : {}),
  }));
}

function lifecycleDocument(
  entry: InventoryEntry,
): Pick<VerbDocument, "since" | "status" | "removal" | "use"> {
  if (entry.status === "deprecated") {
    return { since: entry.since, status: "deprecated", removal: entry.removal, use: entry.use };
  }
  return { since: entry.since, status: "stable" };
}

/** The inventory as `apps/cli/verbs.json` publishes it, flags resolved to names. */
export function inventoryDocument(inv: Inventory): VerbsDocument {
  const verbs = inv.entries.map((entry): VerbDocument => {
    if (entry.kind === "legacy") {
      const sub =
        entry.sub === undefined
          ? null
          : Object.fromEntries(
              Object.entries(entry.sub).map(([key, schema]) => [
                key,
                { flags: schemaFlags(schema ?? entry.schema) },
              ]),
            );
      return {
        verb: entry.verb,
        kind: "legacy",
        ...lifecycleDocument(entry),
        sub,
        flags: schemaFlags(entry.schema),
      };
    }
    return {
      verb: entry.verb,
      kind: "family",
      ...lifecycleDocument(entry),
      ...(entry.bare !== undefined ? { bare: entry.bare } : {}),
      sub: Object.fromEntries(
        Object.entries(entry.sub).map(([key, sub]) => [key, { flags: familyFlags(sub.flags) }]),
      ),
      flags: null,
    };
  });
  return { version: 1, verbs };
}

/** The one sentence the CLI prints when a deprecated verb runs. */
export function deprecationNotice(e: {
  readonly verb: string;
  readonly use: string;
  readonly removal: string;
}): string {
  return `crewhaus ${e.verb} is deprecated; use crewhaus ${e.use}. ${e.verb} goes away in ${e.removal}.`;
}
