#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";
import { SpecParseError, compile, lower } from "@crewhaus/compiler";
import { buildContextBundle, discoverRoots } from "@crewhaus/context-bundle";
import { DEFAULT_PRICING, computeCacheSavingsMicros, resolvePricing } from "@crewhaus/cost-tracker";
import { CrewhausError } from "@crewhaus/errors";
import { loadDataset } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { optimizeSpec } from "@crewhaus/eval-optimizer-orchestrator";
import { diffReports, loadRun, renderReport } from "@crewhaus/eval-report";
import { runEval as runEvalLib } from "@crewhaus/eval-runner";
import { openEventLog } from "@crewhaus/event-log";
import { loadHooks } from "@crewhaus/hooks-engine";
import {
  ArgParseError,
  type ParseArgsSchema,
  type ParsedArgs,
  parseArgs,
} from "@crewhaus/infra-utils";
import { GENERATED_README_MARKER } from "@crewhaus/ir";
import { createLogger } from "@crewhaus/logging";
import { McpHost } from "@crewhaus/mcp-host";
import {
  BUILTIN_DEFAULT_RULES,
  type JustificationJudge,
  PermissionConfigError,
  type PermissionMode,
  type RuleSet,
  parsePermissionsConfig,
  tagRules,
} from "@crewhaus/permission-engine";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createSessionStore } from "@crewhaus/session-store";
import { createSkillTool, discoverSkills } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
import { parseSpec } from "@crewhaus/spec";
import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { registerMcpServer } from "@crewhaus/tool-mcp";
import { createTaskTool } from "@crewhaus/tool-task";
import { type CostAccrualEvent, type ProviderId, TraceEventBus } from "@crewhaus/trace-event-bus";
// Item 34 — `crewhaus audit verify` plumbing (anchor-flag parsing + per-check
// summary + doctor mapping), in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import {
  type AnchorFlagChoice,
  InvalidAnchorFlagError,
  buildAuditIntegrityCheck,
  resolveAnchorFlag,
  summarizeVerifyResult,
} from "./audit-verify";
// Item 34 — scheduling ergonomics for `compliance evidence` (--period current
// resolution + the empty-evidence gate), side-effect-free for the same reason.
import { findEmptyControls, resolvePeriodFlag } from "./compliance-schedule";
// Model-aware doctor credential checks (provider parsed from the cwd spec's
// agent.model via the model-router grammar), in a side-effect-free module so
// it is unit-testable (this entry file runs an argv switch on import).
import { buildCredentialChecks, extractSpecModel } from "./doctor-checks";
// FR-006 — Pillar 3 sink-side egress-matcher selection (the substring/semantic
// selector lowered to ir.security.egressMatcher). Side-effect-free + lazily
// imports the optional semantic package only when "semantic" is selected, so
// the default path pulls in no embedding dependency.
import {
  DEFAULT_EGRESS_EMBEDDER_MODEL,
  type EgressMatcherChoice,
  InvalidEgressMatcherChoiceError,
  createEgressMatcher,
  resolveEgressMatcherChoice,
} from "./egress-matcher";
// Response-feedback core — pure, side-effect-free so it is unit-testable
// (this entry file runs an argv switch on import). Powers `rate`/`feedback`
// (capture) and `distill` (ratings → eval dataset + graders).
import {
  type DerivedTurn,
  FEEDBACK_EVENT_KIND,
  type FeedbackRecord,
  type FeedbackSource,
  type SessionTurn,
  buildFeedbackRecord,
  deriveTurns,
  distill as distillFeedback,
  extractFeedbackRecords,
  gradersConfigToYaml,
  samplesToJsonl,
} from "./feedback";
// FR-004 — Pillar 3 intent-gate judge + durable audit-sink resolution, in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import).
import {
  InvalidJudgeChoiceError,
  type JudgeChoice,
  createJustificationJudge,
  openJustificationAuditSink,
  resolveJudgeChoice,
} from "./justification-gate";
// Item 35 — `crewhaus retention` sweep/export/purge (scheduled GDPR/TTL
// enforcement over the on-disk session + audit stores), in a side-effect-free
// module so it is unit-testable AND callable as a library by a future daemon
// janitor (no boot wiring here — see retention.ts).
import {
  InvalidRetentionDateError,
  RetentionConfigError,
  formatEnforcementReport,
  formatExportReport,
  parseRetentionDate,
  runRetentionExport,
  runRetentionPurge,
  runRetentionSweep,
} from "./retention";
// FR-002 — Pillar 3 sink-side scope gate, shared by `compile --strict` and
// `doctor --philosophy-alignment`. Kept in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import { auditSpecToolNames, auditToolScopes, collectToolNames } from "./scope-audit";
// Item 49 — scope-audit drift watch (stable finding ids, snapshot
// persistence, baseline diff gate, boundary-drift detector), in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import).
import {
  type PhilosophyFinding,
  ScopeAuditBaselineError,
  buildScopeAuditSnapshot,
  detectBoundaryDrift,
  diffScopeAuditSnapshots,
  loadScopeAuditSnapshot,
  renderGateReport,
  scopeAuditBaselinePath,
  scopeAuditDir,
  scopeAuditSnapshotPath,
} from "./scope-audit-drift";
// Item 48 — `crewhaus security digest` core (windowed rollup over
// .crewhaus/audit + session event logs, text/json/html renderers, webhook
// notify), in a side-effect-free module so it is unit-testable (this entry
// file runs an argv switch on import).
import {
  InvalidSinceFlagError,
  NotifyError,
  buildSecurityDigest,
  notifySecurityDigest,
  parseSinceFlag,
  renderSecurityDigestHtml,
  renderSecurityDigestText,
} from "./security-digest";
// Item 69 — `crewhaus state backup|restore` core (tarball snapshot of the
// cwd `.crewhaus` state dir + full/merge restore), in a module with no
// import-time side effects so it is unit-testable (this entry file runs an
// argv switch on import).
import {
  StateBackupError,
  createStateBackup,
  defaultBackupFileName,
  mergeAllFromArchive,
  mergeFeedbackFromArchive,
  parseExcludeGlobs,
  restoreStateArchive,
} from "./state-backup";

/**
 * crewhaus — slice-scope CLI.
 * Subcommands:
 *   compile <spec.yaml> -o <out-dir>     parse → IR → emit bundle to disk
 *   compile <spec.yaml> --emit-ir        parse → IR → print IR JSON (no codegen)
 *   run <spec.yaml> [--model <model>]    compile in-memory and execute the agent
 *   init [name]                          scaffold a new crewhaus.yaml
 *   doctor                               check environment health
 *
 * Future (per catalog F4 spec-cli): deploy, eval, watch.
 *
 * User-facing messages (status, errors) go directly to stdout/stderr for clean
 * UX. The logger is for diagnostic events visible only when CREWHAUS_LOG_LEVEL
 * is set to debug (or CREWHAUS_LOG=json for machine-readable traces).
 */

const logger = createLogger({ bindings: { app: "crewhaus" } });

const COMPILE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    { name: "emit-ir", takesValue: false },
    // FR-002 — the strict scope gate (fail the build when an outward-reaching
    // tool is left at a non-"external" scope) now runs by DEFAULT on every
    // compile. `--strict` is retained as an accepted no-op so existing
    // invocations and CI scripts keep working; the gate fires with or without
    // it (see whitepaper §6).
    { name: "strict", takesValue: false },
    // FR-002 — explicit opt-out for users who knowingly bypass the gate (e.g.
    // an outward sink whose external scope is verified out of band). Either
    // spelling disables the gate; both are accepted so neither reach is a
    // surprise. Without one of these flags an unmarked outward/io-capable tool
    // FAILS the compile.
    { name: "allow-unmarked-sinks", takesValue: false },
    { name: "no-strict-scope", takesValue: false },
    // Item 42 — README emission into the bundle is DEFAULT-ON; this is the
    // explicit opt-out for users who post-process bundles and don't want
    // the extra file.
    { name: "no-readme", takesValue: false },
    // Item 46 — auto-registration of the compiled spec into the local
    // spec-registry (with a distilled CHANGELOG.md entry) is DEFAULT-ON;
    // this is the explicit opt-out.
    { name: "no-register", takesValue: false },
    { name: "help", short: "h" },
  ],
};

const RUN_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "model", takesValue: true },
    { name: "permission-mode", takesValue: true },
    { name: "resume", takesValue: true },
    { name: "continue", takesValue: false },
    { name: "prompt", takesValue: true },
    // FR-004 — select the Pillar 3 intent-gate judge for this run.
    // rule-based (default) | claude. Overrides the spec's
    // security.justification.judge when supplied.
    { name: "justification-judge", takesValue: true },
    // FR-004 — disable the durable `permission_justification_evaluated`
    // audit-log record (on by default for `run`). The ephemeral trace-bus
    // event is unaffected; this only skips opening `.crewhaus/audit`.
    { name: "no-justification-audit", takesValue: false },
    // FR-006 — select the Pillar 3 sink-side egress matcher for this run.
    // substring (default) | semantic. Overrides the spec's
    // security.egressMatcher when supplied.
    { name: "egress-matcher", takesValue: true },
    // FR-006 — embedder model for the "semantic" egress matcher (the
    // @crewhaus/embedder prefix grammar, e.g. openai/text-embedding-3-small,
    // mock/deterministic). Flag > CREWHAUS_EGRESS_EMBEDDER env > default.
    { name: "egress-embedder", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

const VALID_PERMISSION_MODES = ["default", "plan", "auto", "bypass"] as const;
type CliPermissionMode = (typeof VALID_PERMISSION_MODES)[number];

function isValidPermissionMode(s: string): s is CliPermissionMode {
  return (VALID_PERMISSION_MODES as readonly string[]).includes(s);
}

const INIT_SCHEMA: ParseArgsSchema = {
  flags: [{ name: "help", short: "h" }],
};

const DOCTOR_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "philosophy-alignment", takesValue: false },
    // Item 49 — scope-audit drift watch (compose with --philosophy-alignment):
    //   --json             persist findings to .crewhaus/scope-audit/<date>.json
    //                      (stable ids) and print the snapshot JSON
    //   --baseline         diff against .crewhaus/scope-audit/baseline.json;
    //                      exit non-zero ONLY on NEW findings
    //   --accept-baseline  promote the current findings to the baseline
    { name: "json", takesValue: false },
    { name: "baseline", takesValue: false },
    { name: "accept-baseline", takesValue: false },
    // Process-liveness only — exit 0 fast, no credential/spec checks. The
    // probe target for container HEALTHCHECKs and k8s exec probes.
    { name: "liveness", takesValue: false },
    { name: "help", short: "h" },
  ],
};

const CONTEXT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "bundle", takesValue: false },
    { name: "out", short: "o", takesValue: true },
    { name: "factory-root", takesValue: true },
    { name: "docs-root", takesValue: true },
    { name: "demos-root", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const OPTIMIZE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    // Inline-distill user ratings into the training set (Pillar 2 — close the
    // loop from real feedback). Value: a session id (sess_<16 hex>) or "all".
    // Synthesizes the dataset (and, when --graders is omitted, the graders too).
    { name: "ratings", takesValue: true },
    { name: "min-score", takesValue: true },
    { name: "mutator", takesValue: true },
    { name: "iterations", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "improvement-threshold", takesValue: true },
    // FR-003 — dollar ceiling for model-driven runs (composes with --iterations).
    { name: "budget-usd", takesValue: true },
    { name: "write-back", takesValue: false },
    // Item 46 — after a successful --write-back the working spec changed, so
    // the same auto-register + changelog flow as `compile` runs; this is the
    // explicit opt-out (mirrors `compile --no-register`).
    { name: "no-register", takesValue: false },
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const EVAL_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "judge-model", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const EVAL_REPORT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const COST_SUMMARY_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "tenant", takesValue: true },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const RATE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "turn", takesValue: true },
    { name: "thumbs", takesValue: true },
    { name: "stars", takesValue: true },
    { name: "score", takesValue: true },
    { name: "comment", takesValue: true },
    { name: "rater", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const FEEDBACK_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "turn", takesValue: true },
    { name: "text", takesValue: true },
    { name: "correction", takesValue: true },
    { name: "rater", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const DISTILL_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "all-sessions", takesValue: false },
    { name: "out", short: "o", takesValue: true },
    { name: "graders-out", takesValue: true },
    { name: "min-score", takesValue: true },
    { name: "judge", takesValue: false },
    { name: "judge-model", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const STATE_SCHEMA: ParseArgsSchema = {
  flags: [
    // backup
    { name: "out", short: "o", takesValue: true },
    { name: "exclude", takesValue: true },
    // restore
    { name: "into", takesValue: true },
    { name: "merge", takesValue: true },
    { name: "force", takesValue: false },
    { name: "help", short: "h" },
  ],
};

const SANDBOX_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "probe", takesValue: false },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const COMPLIANCE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "framework", takesValue: true },
    // Item 34 — collect every registered framework in one (schedulable) run.
    { name: "all-frameworks", takesValue: false },
    { name: "control", takesValue: true },
    // Accepts a literal period label (e.g. 2026-Q2) or "current" (the current
    // UTC quarter) so a cron job never hardcodes a stale label.
    { name: "period", takesValue: true },
    { name: "audit-dir", takesValue: true },
    { name: "out-dir", takesValue: true },
    { name: "signing-key-env", takesValue: true },
    // Item 34 / ops-review F4 — opt IN to the empty-evidence tripwire: with
    // this flag a control that collected 0 records exits 1 (for scheduled
    // runs); the default is exit 0 with a warning so documented bare
    // invocations keep working.
    { name: "fail-on-empty", takesValue: false },
    { name: "help", short: "h" },
  ],
};

const AUDIT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dir", takesValue: true },
    { name: "anchor", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const RETENTION_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dry-run", takesValue: false },
    { name: "dir", takesValue: true },
    { name: "since", takesValue: true },
    { name: "before", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const SECURITY_SCHEMA: ParseArgsSchema = {
  flags: [
    // Item 48 — `security digest` rollup window: 7d (default), 30d, or ISO.
    { name: "since", takesValue: true },
    { name: "format", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // POST the JSON digest to a webhook (plain fetch — see security-digest.ts
    // for the deliberate no-channel-adapter decision + the Slack wrapper note).
    { name: "notify", takesValue: true },
    // Harness root that owns `.crewhaus/` (mirrors `retention --dir`).
    { name: "dir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const SECRETS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "backend", takesValue: true },
    { name: "root-dir", takesValue: true },
    { name: "value", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const SPEC_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root-dir", takesValue: true },
    { name: "tenant", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const DEPLOY_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root-dir", takesValue: true },
    { name: "tenant", takesValue: true },
    { name: "actor", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const MIGRATE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root-dir", takesValue: true },
    { name: "from", takesValue: true },
    { name: "to", takesValue: true },
    { name: "dry-run" },
    { name: "help", short: "h" },
  ],
};

const BUILD_IMAGE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "tag", takesValue: true },
    { name: "platform", takesValue: true },
    { name: "push" },
    { name: "help", short: "h" },
  ],
};

const CLOUD_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "provider", takesValue: true },
    { name: "region", takesValue: true },
    { name: "tier", takesValue: true },
    { name: "image-tag", takesValue: true },
    { name: "working-dir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const FEDERATION_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "srv-domain", takesValue: true },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};

function usageText(): string {
  return [
    "usage: crewhaus <subcommand> [args]",
    "",
    "subcommands:",
    "  compile <spec.yaml> -o <out-dir>     compile a spec to a runnable bundle",
    "                                       (fails if an outward tool is left non-external — FR-002)",
    "                  [--allow-unmarked-sinks]  opt out of the external-sink scope gate",
    "  compile <spec.yaml> --emit-ir        print the lowered IR as JSON (debug)",
    "  run <spec.yaml> [--model <model>]    compile in-memory and execute the agent",
    "                  [--resume <id>]      resume a specific session (cli targets only)",
    "                  [--continue]         resume the most-recent session (cli targets only)",
    "                  [--prompt <text>]    initial user prompt (browser targets; defaults to stdin)",
    "                  [--justification-judge rule-based|claude]  Pillar 3 intent-gate judge (FR-004)",
    "                  [--egress-matcher substring|semantic]  Pillar 3 sink-side matcher (FR-006)",
    "                  [--egress-embedder <model>]  embedder for --egress-matcher semantic",
    "  eval <spec.yaml> --dataset <data>    run the agent against a dataset and grade",
    "       --graders <graders.yaml>       (deterministic graders + LLM-as-judge)",
    "       [--judge-model <model>] [--concurrency N] [--seed N] -o <out-dir>",
    "  eval-report diff <prev> <new>        compare two eval runs and emit a diff report",
    "       [-o <out-dir>]",
    "  optimize <spec.yaml> --dataset <data> --graders <graders.yaml>",
    "       [--mutator rule-based|claude] [--iterations N] [--seed N]",
    "       [--ratings <session>|all]            distill user ratings into the training set (Pillar 2)",
    "       [--budget-usd N]                     stop a model-driven run before it exceeds $N (FR-003)",
    "       [--write-back] [-o <out-dir>]        active eval-driven optimization (Pillar 2)",
    "  init [name]                          scaffold a new crewhaus.yaml",
    "  doctor                               check environment health",
    "       [--philosophy-alignment [--json] [--baseline | --accept-baseline]]  pillar audit + scope-audit drift gate (item 49)",
    "  context --bundle [-o <file>]         emit a single-markdown orientation manifest",
    "       [--factory-root <p>] [--docs-root <p>] [--demos-root <p>]",
    "  cost-summary --session <id>          summarize cost_accrual events for a session",
    "  rate --session <id> [--turn N]       rate an assistant turn 👍/👎, ⭐, or 0–1",
    "       (--thumbs up|down | --stars 1-5 | --score 0-1) [--comment <t>]",
    "  feedback --session <id> --text <msg> attach a comment/correction to a turn",
    "       [--turn N] [--correction <better answer>]",
    "  distill --session <id> -o <ds.jsonl> turn ratings into an eval dataset + graders",
    "       [--all-sessions] [--graders-out <g.yaml>] [--min-score F]",
    "  state backup [-o <file.tar.gz>]      snapshot the cwd .crewhaus state dir to a tarball (item 69)",
    "       [--exclude <glob,glob>]",
    "  state restore <file.tar.gz>          restore a snapshot (refuses a non-empty .crewhaus)",
    "       [--into <dir>] [--force] [--merge feedback|all]",
    "  secrets doctor                       list known secrets via the configured backend",
    "  secrets rotate <name> [--value V]    rotate a named secret (file backend)",
    "  spec put|list|get|pin|alias|log ...  versioned spec storage + changelog (Section 28 spec-registry)",
    "  deploy promote|rollback ...          re-pin a spec for an environment (Section 28)",
    "  migrate-all --from N --to N          batch-migrate every spec in the registry",
    "  build-image <target> --tag <tag>     build the docker image for a target shape (Section 32)",
    "       [--platform <p>] [--push]",
    "  cloud deploy --provider <p>          deploy a managed CrewHaus cluster (Section 32)",
    "       --region <r> [--tier <t>] [--image-tag <tag>]",
    "  cloud teardown --provider <p>        tear down a managed cluster",
    "       --region <r>",
    "  federation discover <deployment>     resolve a federated peer's endpoint + cert fingerprint (Section 34)",
    "       [--srv-domain <d>] [--format json|yaml]",
    "  sandbox doctor [--probe]             list registered sandbox images + healthcheck status (Section 36)",
    "       [--format json|table]",
    "  compliance evidence                  collect SOC 2 / ISO 27001 / HIPAA evidence (Section 39)",
    "       (--framework <id> | --all-frameworks) [--control <id>]",
    "       --period <p>|current [--audit-dir <d>] [--out-dir <d>]",
    "       [--signing-key-env <ENV>] [--fail-on-empty]",
    "  audit verify [--dir <auditDir>]      verify the hash-chained audit log (tamper check)",
    "       [--anchor file:<path>]          cross-check an append-only file anchor store",
    "  retention sweep [--dry-run]          scheduled GDPR/TTL enforcement over .crewhaus stores",
    "       [--dir <root>]                  (sessions expire by .crewhaus/retention.json; audit is export-only)",
    "  retention export <outDir>            right-to-export: copy session/audit records out",
    "       [--since <date>] [--dry-run] [--dir <root>]",
    "  retention purge [--before <date>]    right-to-delete: purge expired records now",
    "       [--dry-run] [--dir <root>]",
    "  security digest [--since 7d|30d|ISO] triage rollup of denials/egress/injection from .crewhaus stores (item 48)",
    "       [--format text|json|html] [-o <dir>] [--notify <url>] [--dir <root>]",
    "  version                              print the CLI version (also: --version, -v)",
    "",
  ].join("\n");
}

/** No subcommand given (or a parse error) — usage to stderr, exit 1. */
function usage(): never {
  process.stderr.write(usageText());
  process.exit(1);
}

/**
 * Explicit `-h`/`--help` at the top level — usage to stdout, exit 0. Help was
 * requested, so it is not an error; this matches every subcommand's own
 * `--help` (stdout, exit 0) and lets `crewhaus --help` work in `set -e` health
 * checks instead of looking like a broken CLI.
 */
function help(): never {
  process.stdout.write(usageText());
  process.exit(0);
}

function die(message: string): never {
  process.stderr.write(`crewhaus: ${message}\n`);
  process.exit(1);
}

// Substituted at build time by @crewhaus/single-binary-cli's `bun build
// --compile --define` — standalone binaries have no package.json on disk.
declare const CREWHAUS_EMBEDDED_VERSION: string | undefined;

/**
 * Resolve the CLI version string: the build-time embedded constant when this
 * is a standalone binary, else package.json. Undefined when neither source
 * is available (`version` dies on it; the backup manifest stamps "unknown").
 */
function cliVersion(): string | undefined {
  if (typeof CREWHAUS_EMBEDDED_VERSION === "string") return CREWHAUS_EMBEDDED_VERSION;
  // The package ships src/ directly (bin → src/index.ts) and tsc -b also
  // emits dist/, so resolve package.json relative to this module — one level
  // up lands on apps/cli/package.json from either tree, and on
  // node_modules/@crewhaus/cli/package.json when installed.
  try {
    return (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
        version: string;
      }
    ).version;
  } catch {
    return undefined;
  }
}

function printVersion(): void {
  const version = cliVersion();
  if (version === undefined) die("could not locate package.json to determine the version");
  process.stdout.write(`${version}\n`);
}

function parseFor(rest: ReadonlyArray<string>, schema: ParseArgsSchema): ParsedArgs {
  try {
    return parseArgs(rest, schema);
  } catch (err) {
    if (err instanceof ArgParseError) die(err.message);
    throw err;
  }
}

async function runCompile(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus compile <spec.yaml> [-o <out-dir>] [--emit-ir]\n" +
        "                        [--allow-unmarked-sinks] [--no-readme] [--no-register]\n" +
        "  --emit-ir  Skip code emission; print the lowered IR as JSON to\n" +
        "             stdout (or to <out-dir>/ir.json when -o is set).\n" +
        "\n" +
        "  Every emitted bundle includes a generated README.md documenting\n" +
        "  the harness (name/target/model), its tools and MCP servers, the\n" +
        "  env vars it needs, and how to launch it. A previously generated\n" +
        "  README.md in the out-dir is refreshed on recompile; a README.md\n" +
        "  NOT generated by crewhaus (no generation marker) is kept as-is\n" +
        "  with a notice.\n" +
        "  --no-readme  Skip the generated README.md.\n" +
        "\n" +
        "  A successful bundle compile also auto-registers the spec in the\n" +
        "  local registry (.crewhaus/specs): when no stored version matches\n" +
        "  the spec's content hash, the next vN is put and a distilled entry\n" +
        "  (field-level diff vs the previous version, plus optimizer\n" +
        "  provenance for written-back specs) is appended to the per-spec\n" +
        "  CHANGELOG.md — render it with `crewhaus spec log <name>`.\n" +
        "  Recompiling an unchanged spec is a no-op (`unchanged <name>@<v>`).\n" +
        "  --no-register  Skip the registry auto-put + changelog entry.\n" +
        "\n" +
        "  FR-002 — the strict scope gate runs by DEFAULT: the build fails\n" +
        "  (exit 1) if any I/O-capable tool the spec uses is left at a\n" +
        '  non-"external" scope. It flags:\n' +
        "    (a) a resolvable built-in whose declared io-capability or\n" +
        "        outward name disagrees with its scope;\n" +
        "    (b) an outward-by-name sink — any mcp__* tool or known outward\n" +
        '        built-in — that cannot be resolved to a scope:"external"\n' +
        "        tool offline (its egress scope is unverifiable at compile\n" +
        "        time, so the gate refuses it).\n" +
        "  A non-outward custom tool whose name carries no signal is left to\n" +
        "  the live `doctor --philosophy-alignment` audit / runtime egress\n" +
        "  fabric.\n" +
        "\n" +
        "  --allow-unmarked-sinks   Opt out of the gate for this compile (alias:\n" +
        "             --no-strict-scope). Use only when you knowingly bypass it.\n" +
        "  --strict   Accepted no-op — the gate is already on by default.\n",
    );
    return;
  }
  const specPath = args.positional[0];
  const outDir = args.flags["out"];
  const emitIr = args.flags["emit-ir"] === true;
  // FR-002 — the strict scope gate is DEFAULT-ON. It runs unless the user
  // explicitly opts out with --allow-unmarked-sinks (or its alias
  // --no-strict-scope). `--strict` is now a no-op kept for back-compat.
  const allowUnmarkedSinks =
    args.flags["allow-unmarked-sinks"] === true || args.flags["no-strict-scope"] === true;
  const strict = !allowUnmarkedSinks;
  // Item 42 — generated bundle README, DEFAULT-ON; --no-readme opts out.
  const readme = args.flags["no-readme"] !== true;
  // Item 46 — registry auto-put + changelog, DEFAULT-ON; --no-register opts out.
  const register = args.flags["no-register"] !== true;
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  if (!emitIr && typeof outDir !== "string") die("missing -o <out-dir>");

  const absSpec = resolve(specPath);
  logger.debug("compile.start", { spec: absSpec, out: outDir, emitIr, strict, allowUnmarkedSinks });

  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }

  // FR-006 — `security.egressMatcher: semantic` is now emitted into the
  // standalone cli bundle by `@crewhaus/target-cli` (it constructs
  // `@crewhaus/egress-matcher-semantic` with an injected embedder and threads
  // it into the bundle's `runChatLoop({ egressMatcher })`), so a compiled
  // artifact honours the selection WITHOUT the `run` path. No compile-time
  // warning is needed anymore — emission replaced the warn-only shim.

  // FR-002 — strict scope gate, now DEFAULT-ON. Lower the spec (pure), resolve
  // every referenced built-in tool name to its RegisteredTool, and audit scopes
  // BEFORE any emission. Runs for both --emit-ir and bundle modes so the gate
  // can't be sidestepped by mode choice. `lower()` only carries tool NAMES, not
  // scope, so resolution via loadToolMap() is what surfaces the real
  // RegisteredTool.scope. Skipped only when the user opts out explicitly with
  // --allow-unmarked-sinks (strict === false).
  if (strict) {
    await runStrictScopeGate(yamlText);
  }

  if (emitIr) {
    let ir: ReturnType<typeof lower>;
    try {
      ir = lower(parseSpec(yamlText));
    } catch (err) {
      // parseSpec throws SpecParseError; lower() can throw CompilerError (e.g. a
      // malformed credential env-ref). Both extend CrewhausError — route the
      // family through die() for a clean one-liner instead of a raw stack trace.
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    const json = `${JSON.stringify(ir, null, 2)}\n`;
    if (typeof outDir === "string") {
      const absOut = resolve(outDir);
      mkdirSync(absOut, { recursive: true });
      const irPath = join(absOut, "ir.json");
      writeFileSync(irPath, json);
      process.stdout.write(`wrote ${irPath}\n`);
    } else {
      process.stdout.write(json);
    }
    logger.debug("compile.emit-ir.success", { out: outDir ?? "stdout" });
    return;
  }

  const absOut = resolve(outDir as string);

  let bundle: ReturnType<typeof compile>;
  try {
    bundle = compile(yamlText, { readme });
  } catch (err) {
    // compile() runs parse → lower → emit. parseSpec throws SpecParseError;
    // each target emitter throws its own TargetEmitError (e.g. an unresolvable
    // tool name once the default-on scope gate has been bypassed with
    // --allow-unmarked-sinks). Both — like every structured failure in this
    // pipeline — extend CrewhausError, so route the whole family through die()
    // for a clean one-line error + exit 1 instead of letting the emitter crash
    // escape as an uncaught stack trace. A non-CrewhausError (a genuine bug)
    // still propagates with its full stack for debugging.
    if (err instanceof CrewhausError) {
      die(err.message);
    }
    throw err;
  }

  mkdirSync(absOut, { recursive: true });
  for (const file of bundle.files) {
    const fullPath = join(absOut, file.path);
    // Item 42 — never silently clobber a USER-AUTHORED README.md. A README
    // we generated earlier carries GENERATED_README_MARKER and is refreshed
    // like any other bundle file; one without the marker is kept, with a
    // notice (pass --no-readme to silence).
    if (file.path === "README.md" && existsSync(fullPath)) {
      let existing: string;
      try {
        existing = readFileSync(fullPath, "utf-8");
      } catch {
        existing = "";
      }
      if (!existing.includes(GENERATED_README_MARKER)) {
        process.stdout.write(
          `kept ${fullPath} (not generated by crewhaus — pass --no-readme to skip README emission)\n`,
        );
        continue;
      }
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
    process.stdout.write(`wrote ${fullPath}\n`);
  }
  process.stdout.write(`compiled bundle (${bundle.files.length} file(s)) → ${absOut}\n`);
  // Item 46 — auto-register the just-compiled spec in the local registry so
  // registry state tracks working files without a manual `crewhaus spec put`.
  // Bundle mode only: --emit-ir streams JSON to stdout, which a status line
  // would corrupt. Runs AFTER the success line — a compile that failed never
  // registers.
  if (register) await autoRegisterSpec(yamlText);
  logger.debug("compile.success", { files: bundle.files.length, out: absOut });
}

/**
 * Item 46 — shared auto-register hook for `compile` and `optimize
 * --write-back` (wiring only; the logic lives in ./spec-changelog). Content-
 * hash gated: prints one quiet line — `registered <name>@<vN>` on a new put,
 * `unchanged <name>@<v>` when some stored version already carries this exact
 * content. Registration is a convenience, not a gate: any failure warns on
 * stderr and never fails the parent command.
 */
async function autoRegisterSpec(
  yamlText: string,
  hooks: { patchJsonPath?: string } = {},
): Promise<void> {
  try {
    const specName = parseSpec(yamlText).name;
    const rootDir = join(process.cwd(), ".crewhaus", "specs");
    const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
    const { autoRegisterSpecVersion } = await import("./spec-changelog");
    const result = await autoRegisterSpecVersion({
      registry: createFileBackedRegistry({ rootDir }),
      registryRootDir: rootDir,
      specName,
      yaml: yamlText,
      // Default patch.json resolution for changelog provenance: the header's
      // runId under the standard optimize root (cwd-relative, matching where
      // `crewhaus optimize` writes when -o is omitted).
      optimizeRootDir: join(process.cwd(), ".crewhaus", "optimize"),
      ...(hooks.patchJsonPath !== undefined ? { patchJsonPath: hooks.patchJsonPath } : {}),
    });
    process.stdout.write(`${result.status} ${result.name}@${result.version}\n`);
  } catch (err) {
    process.stderr.write(`[register] skipped: ${(err as Error).message}\n`);
  }
}

/**
 * FR-002 — the `compile --strict` enforcement body. Lowers the spec, resolves
 * the tool names it references to their RegisteredTools, and runs the shared
 * `auditToolScopes`. On any finding, writes a `[strict]` diagnostic per
 * tool to stderr and exits 1 BEFORE emitting. Shares the exact audit with
 * `crewhaus doctor --philosophy-alignment`.
 */
async function runStrictScopeGate(yamlText: string): Promise<void> {
  let ir: ReturnType<typeof lower>;
  try {
    ir = lower(parseSpec(yamlText));
  } catch (err) {
    // SpecParseError (parse) and CompilerError (lower, e.g. a malformed
    // credential env-ref) both extend CrewhausError — render as a clean die()
    // one-liner rather than an uncaught stack trace.
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
  const toolNames = collectToolNames(ir);
  if (toolNames.length === 0) return;

  const toolMap = await loadToolMap();
  // `loadToolMap` is keyed by the camelCase spec key (`webSearch`), which is how
  // a top-level `tools:` list names its tools. But a sub-agent `tools:` list
  // names tools by their REGISTERED name (PascalCase, e.g. `WebSearch`) — the
  // runtime child-catalog filter (`buildChildCatalog` in tool-task) matches on
  // `RegisteredTool.name`, not the spec key. `collectToolNames` gathers BOTH
  // forms from the IR, so also index the map by registered name; otherwise an
  // outward sub-agent sink like `WebSearch` fails to resolve and is wrongly
  // flagged as an unverifiable external sink (it resolves to a built-in whose
  // scope IS statically "external"). A genuinely unknown name (`mcp__*`, a typo)
  // still resolves to undefined under both keys and is still gated.
  const byRegisteredName: Record<string, RegisteredTool> = {};
  for (const tool of Object.values(toolMap)) byRegisteredName[tool.name] = tool;
  // Shared, name-independent audit (see scope-audit.ts):
  //   - resolvable built-ins are checked by capability/outward-name vs scope;
  //   - an outward-by-name sink we CANNOT resolve to a scope:"external" tool
  //     offline (a custom outward name, or any `mcp__*` dynamic sink) is a
  //     finding, because --strict refuses to emit a bundle that reaches a
  //     sink whose external scope it cannot verify at compile time.
  const findings = auditSpecToolNames(toolNames, (name) => toolMap[name] ?? byRegisteredName[name]);
  if (findings.length > 0) {
    for (const f of findings) {
      process.stderr.write(`crewhaus: [strict] tool "${f.toolName}" ${f.reason}\n`);
    }
    process.stderr.write(
      `crewhaus: [strict] ${findings.length} scope finding(s) — refusing to emit. Set scope: "external" on each tool above, or pass --allow-unmarked-sinks to bypass the gate.\n`,
    );
    process.exit(1);
  }
}

function runInit(args: ParsedArgs): void {
  if (args.flags["help"]) {
    process.stdout.write("usage: crewhaus init [name]\n");
    return;
  }
  const nameArg = args.positional[0];
  const targetDir = typeof nameArg === "string" ? resolve(nameArg) : process.cwd();
  const specName = typeof nameArg === "string" ? nameArg : basename(targetDir);
  const targetFile = join(targetDir, "crewhaus.yaml");

  if (existsSync(targetFile)) {
    die(`${targetFile} already exists — refusing to overwrite`);
  }

  mkdirSync(targetDir, { recursive: true });
  const yamlText = `name: ${specName}
target: cli
agent:
  model: claude-opus-4-7
  instructions: |
    You are a helpful assistant. Replace these instructions with your
    agent's actual behavior, persona, and constraints.
`;
  writeFileSync(targetFile, yamlText);
  process.stdout.write(`wrote ${targetFile}\n`);
  // The runtime resolves the spec and the `.crewhaus/` session store from
  // the current working directory, so guide the user to run from inside
  // the harness directory (where crewhaus.yaml lives), not from here.
  const rel = relative(process.cwd(), targetDir);
  const cd = rel === "" ? "" : `cd ${rel} && `;
  process.stdout.write(`next: ${cd}crewhaus run crewhaus.yaml\n`);
  logger.debug("init.success", { target: targetFile });
}

/**
 * Built-in tool name → RegisteredTool, populated lazily so that subcommands
 * which don't need tools (init, doctor) don't pay the import cost. Mirror of
 * `BUILTIN_TOOL_MAP` in packages/target-cli/src/index.ts — keep them in sync.
 */
async function loadToolMap(): Promise<Record<string, RegisteredTool>> {
  const [fs, bash, todo, web, image, fetchPkg, imageGen, docIngest, codegraph] = await Promise.all([
    import("@crewhaus/tool-fs"),
    import("@crewhaus/tool-bash"),
    import("@crewhaus/tool-todo"),
    import("@crewhaus/tool-web"),
    import("@crewhaus/tool-image"),
    import("@crewhaus/tool-fetch"),
    import("@crewhaus/tool-image-generation"),
    import("@crewhaus/tool-document-ingest"),
    import("@crewhaus/tool-codegraph"),
  ]);
  return {
    read: fs.read,
    write: fs.write,
    edit: fs.edit,
    glob: fs.glob,
    grep: fs.grep,
    bash: bash.bash,
    todoWrite: todo.todoWrite,
    webFetch: web.webFetch,
    webSearch: web.webSearch,
    readImage: image.readImage,
    fetch: fetchPkg.fetch,
    imageGenerate: imageGen.imageGenerate,
    ingestDocument: docIngest.ingestDocument,
    // Pillar 2 — AST-aware code intelligence (recipe 54).
    codegraphSearch: codegraph.codegraphSearch,
    codegraphCallers: codegraph.codegraphCallers,
    codegraphCallees: codegraph.codegraphCallees,
    codegraphImpact: codegraph.codegraphImpact,
  };
}

/**
 * Section 14 — apply per-tool config from the IR's `toolConfigs` map by
 * calling each tool's registration function. Mirror of the codegen-emitted
 * init calls in target-cli/target-channel-bot. Keep in sync.
 */
async function applyToolConfigs(
  toolNames: readonly string[],
  toolConfigs: Readonly<Record<string, unknown>>,
): Promise<void> {
  const used = new Set(toolNames);
  if (used.has("fetch") && toolConfigs["fetch"] !== undefined) {
    const { registerFetchConfig } = await import("@crewhaus/tool-fetch");
    registerFetchConfig(toolConfigs["fetch"] as Parameters<typeof registerFetchConfig>[0]);
  }
  if (used.has("webFetch") && toolConfigs["webFetch"] !== undefined) {
    const { registerWebFetchConfig } = await import("@crewhaus/tool-web");
    registerWebFetchConfig(toolConfigs["webFetch"] as Parameters<typeof registerWebFetchConfig>[0]);
  }
}

/**
 * Build the layered permission rule set from the IR (yaml source) and an
 * optional `.crewhaus/settings.json` (settings source). The flag and hooks
 * sources are placeholders for future sections (no rules yet, just modes).
 *
 * All non-flag config goes through `parsePermissionsConfig` which rejects
 * `mode: bypass` (defense in depth on top of the spec parser's check).
 */
function buildRuleSet(
  yamlRules: ReadonlyArray<{ type: "alwaysAllow" | "alwaysDeny" | "alwaysAsk"; pattern: string }>,
  cwd: string,
): RuleSet {
  let settings: RuleSet["settings"] = [];
  const settingsPath = join(cwd, ".crewhaus", "settings.json");
  if (existsSync(settingsPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (err) {
      die(`failed to parse ${settingsPath}: ${(err as Error).message}`);
    }
    // Section 11 introduced top-level keys (`hooks`) into settings.json.
    // Only parse the `permissions` sub-object — never the bare root —
    // so hooks/skills/slash-command keys don't trip the strict permission
    // validator. If the file has no `permissions` block, treat as empty.
    const root = (raw as { permissions?: unknown }).permissions;
    if (root !== undefined) {
      try {
        const parsed = parsePermissionsConfig(root, "settings");
        settings = tagRules(parsed.rules, "settings");
      } catch (err) {
        if (err instanceof PermissionConfigError) die(err.message);
        throw err;
      }
    }
  }
  return {
    flag: [],
    settings,
    yaml: tagRules(yamlRules, "yaml"),
    hooks: [],
    builtin: BUILTIN_DEFAULT_RULES,
  };
}

/**
 * FR-004 — resolve the Pillar 3 intent-gate judge for a `run`. Precedence:
 * `--justification-judge` flag > spec `security.justification.judge` >
 * `"rule-based"`. Returns `undefined` for the rule-based path so the
 * caller omits `justificationJudge` from `runChatLoop` and runtime-core
 * falls back to `ruleBasedJustificationJudge` (the documented default for
 * tests/offline runs). For `"claude"` it lazily imports the adapter +
 * `@crewhaus/justification-judge-claude` (matching the run path's existing
 * lazy-import style) so the model-backed judge code only loads when
 * actually selected. An unknown value `die()`s.
 */
async function resolveJustificationJudge(
  args: ParsedArgs,
  securityJustification: { judge?: JudgeChoice; model?: string } | undefined,
): Promise<JustificationJudge | undefined> {
  const flag = args.flags["justification-judge"];
  const flagValue = typeof flag === "string" ? flag : undefined;
  let choice: JudgeChoice;
  try {
    choice = resolveJudgeChoice(flagValue, securityJustification);
  } catch (err) {
    if (err instanceof InvalidJudgeChoiceError) die(err.message);
    throw err;
  }
  return createJustificationJudge(choice, securityJustification?.model);
}

/**
 * FR-006 — resolve the Pillar 3 sink-side egress matcher for a `run`.
 * Precedence: `--egress-matcher` flag > spec `security.egressMatcher` (lowered
 * to `ir.security.egressMatcher`) > `"substring"`. Returns `undefined` for the
 * substring path so the caller omits `egressMatcher` from `runChatLoop` and
 * runtime-core stays on the built-in `substringMatcher` (the default egress
 * path then pulls in no embedding dependency). For `"semantic"` it lazily
 * imports `@crewhaus/embedder` + `@crewhaus/egress-matcher-semantic` and
 * constructs a `SemanticEgressMatcher`; the embedder model comes from
 * `--egress-embedder` > `CREWHAUS_EGRESS_EMBEDDER` env >
 * `DEFAULT_EGRESS_EMBEDDER_MODEL`. An unknown matcher value `die()`s.
 */
async function resolveEgressMatcher(
  args: ParsedArgs,
  irEgressMatcher: EgressMatcherChoice | undefined,
): Promise<import("@crewhaus/egress-classifier").EgressMatcher | undefined> {
  const flag = args.flags["egress-matcher"];
  const flagValue = typeof flag === "string" ? flag : undefined;
  let choice: EgressMatcherChoice;
  try {
    choice = resolveEgressMatcherChoice(flagValue, irEgressMatcher);
  } catch (err) {
    if (err instanceof InvalidEgressMatcherChoiceError) die(err.message);
    throw err;
  }
  const embedderFlag = args.flags["egress-embedder"];
  const embedderModel =
    (typeof embedderFlag === "string" ? embedderFlag : undefined) ??
    process.env["CREWHAUS_EGRESS_EMBEDDER"] ??
    DEFAULT_EGRESS_EMBEDDER_MODEL;
  return createEgressMatcher(choice, { embedderModel });
}

async function runRun(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus run <spec.yaml> [--model <model>] [--permission-mode <default|plan|auto|bypass>] [--resume <sessionId> | --continue] [--prompt <text>] [--justification-judge rule-based|claude] [--egress-matcher substring|semantic] [--egress-embedder <model>]\n" +
        "  --model accepts the full router grammar: claude-* (Anthropic), openai/<m>, gemini/<m>, bedrock/<id> (geo prefixes tolerated), local/<m>@<url>\n",
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");

  const absSpec = resolve(specPath);
  logger.debug("run.start", { spec: absSpec });

  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }

  let ir: ReturnType<typeof lower>;
  try {
    ir = lower(parseSpec(yamlText));
  } catch (err) {
    if (err instanceof SpecParseError) die(err.message);
    throw err;
  }

  if (ir.target === "cli") return runRunCli(args, ir, specPath);
  if (ir.target === "browser") return runRunBrowser(args, ir);
  die(
    `crewhaus run supports target: cli or browser (got "${ir.target}"). Other target shapes are compile-only — see PACKAGES.md.`,
  );
}

/**
 * cli-target run path. Multi-turn interactive REPL, session-store backed,
 * loads hooks/skills/slash-commands/sub-agents from the user's workspace,
 * and wires every spec-declared MCP server.
 */
async function runRunCli(
  args: ParsedArgs,
  ir: Extract<ReturnType<typeof lower>, { target: "cli" }>,
  specPath: string,
): Promise<void> {
  const resumeFlag = args.flags["resume"];
  const continueFlag = args.flags["continue"] === true;
  if (typeof resumeFlag === "string" && continueFlag) {
    die("--resume and --continue are mutually exclusive");
  }
  let resumeId: string | undefined;
  if (typeof resumeFlag === "string") {
    if (!SESSION_ID_REGEX.test(resumeFlag)) {
      die(`invalid --resume sessionId "${resumeFlag}" — expected sess_<16 hex>`);
    }
    resumeId = resumeFlag;
  }

  // --continue resolves to the most-recently-updated session for this
  // spec's name, scoped to the current working directory's session
  // store. session-store's list() returns sessions sorted by updatedAt
  // descending, with a TTL-based eviction sweep as a side effect.
  if (continueFlag) {
    const store = createSessionStore();
    const sessions = await store.list();
    const match = sessions.find((s: { name: string }) => s.name === ir.name);
    if (match === undefined) {
      const absSpec = resolve(specPath);
      die(
        `no prior session for spec "${ir.name}" in ${process.cwd()}/.crewhaus/sessions/. Sessions are stored under the directory you run from — start one from the harness directory with: cd ${dirname(absSpec)} && crewhaus run ${basename(absSpec)}`,
      );
    }
    resumeId = match.id;
    process.stdout.write(
      `[continue] resuming session ${match.id} (last updated ${match.updatedAt})\n`,
    );
  }

  let tools: RegisteredTool[] = [];
  if (ir.tools.length > 0) {
    // Section 14 — apply per-tool config (e.g. registerFetchConfig) before
    // loading the tools so first-call execution sees the registered config.
    await applyToolConfigs(ir.tools, ir.toolConfigs);
    const toolMap = await loadToolMap();
    tools = ir.tools.map((name) => {
      const tool = toolMap[name];
      if (!tool) {
        const known = Object.keys(toolMap).sort().join(", ");
        die(`unknown tool "${name}" — known tools: ${known}`);
      }
      return tool;
    });
  }

  // Section 9 — connect to declared MCP servers and register their remote
  // tools alongside the built-ins. Mirror of the codegen path in
  // @crewhaus/target-cli (renderMcpServers); keep them in sync.
  let mcpHost: McpHost | undefined;
  if (Object.keys(ir.mcp_servers).length > 0) {
    const host = new McpHost({ logger });
    mcpHost = host;
    for (const [name, cfg] of Object.entries(ir.mcp_servers)) {
      host.addServer(name, cfg);
    }
    const tempCatalog = new ToolCatalog();
    for (const t of tools) tempCatalog.register(t);
    await Promise.all(
      Object.keys(ir.mcp_servers).map((name) =>
        registerMcpServer(host, name, tempCatalog, {
          onRegister: ({ fullName }) => process.stdout.write(`[mcp] registered ${fullName}\n`),
        }),
      ),
    );
    tools = tempCatalog.list().slice();
  }

  const modelOverride = args.flags["model"];
  const model = typeof modelOverride === "string" ? modelOverride : ir.agent.model;

  // Permission mode resolution: CLI flag > spec > "default".
  // bypass is reachable only via the flag (the spec parser has already
  // rejected `mode: bypass`).
  const flagMode = args.flags["permission-mode"];
  let permissionMode: PermissionMode;
  if (typeof flagMode === "string") {
    if (!isValidPermissionMode(flagMode)) {
      die(
        `invalid --permission-mode "${flagMode}" — allowed: ${VALID_PERMISSION_MODES.join(", ")}`,
      );
    }
    permissionMode = flagMode;
  } else if (ir.permissions.mode !== undefined) {
    permissionMode = ir.permissions.mode;
  } else {
    permissionMode = "default";
  }

  const permissionRules = buildRuleSet(ir.permissions.rules, process.cwd());

  // FR-004 — resolve the Pillar 3 intent-gate judge (flag > spec > rule-based).
  // undefined leaves runtime-core on `ruleBasedJustificationJudge`.
  const justificationJudge = await resolveJustificationJudge(args, ir.security?.justification);
  // FR-004 — open the durable audit sink the intent gate appends a
  // `permission_justification_evaluated` record to. On by default for `run`
  // (rooted at .crewhaus/audit); `--no-justification-audit` skips it. undefined
  // leaves runtime-core writing only the ephemeral trace-bus event.
  const justificationAuditSink = await openJustificationAuditSink({
    cwd: process.cwd(),
    enabled: args.flags["no-justification-audit"] !== true,
  });

  // FR-006 — resolve the Pillar 3 sink-side egress matcher (flag > spec >
  // substring). undefined leaves runtime-core on the built-in
  // `substringMatcher`; `"semantic"` constructs the optional
  // `@crewhaus/egress-matcher-semantic` with an injected embedder. The
  // placement (IR-wired, every external sink) and the warn/block policy are
  // unchanged — only *how* lineage matches are detected.
  const egressMatcher = await resolveEgressMatcher(args, ir.security?.egressMatcher);

  // Section 11 — discover hooks, skills, and slash commands from the user's
  // workspace. Hooks come from `~/.crewhaus/settings.json` + `<cwd>/.crewhaus/settings.json`;
  // skills from `~/.crewhaus/skills/*/SKILL.md` + project-equivalent; slash
  // commands from `<cwd>/.crewhaus/commands/*.md`. When skills are present,
  // a synthetic `Skill(name)` tool is appended to the tool list so the
  // model can lazily fetch each skill's body.
  const cwd = process.cwd();
  const [hooks, skills, slashCommands] = await Promise.all([
    loadHooks({ cwd }),
    discoverSkills({ cwd }),
    loadCommands({ cwd }),
  ]);
  if (skills.length > 0) {
    tools.push(createSkillTool(skills));
    process.stdout.write(
      `[skills] ${skills.length} available: ${skills.map((s) => s.name).join(", ")}\n`,
    );
  }
  if (hooks.length > 0) process.stdout.write(`[hooks] ${hooks.length} loaded\n`);
  if (slashCommands.size > 0) {
    process.stdout.write(
      `[slash] ${slashCommands.size} commands: ${[...slashCommands.keys()].join(", ")}\n`,
    );
  }

  // Section 13 — when the IR carries inline sub-agent definitions, build the
  // registry, register the Task tool, and inject `spawnSubAgent` so the
  // runtime can populate the bridge for framework-aware tools.
  let subAgents: ReadonlyMap<string, SubAgentDefinition> | undefined;
  if (ir.subAgents.length > 0) {
    subAgents = new Map(
      ir.subAgents.map((d) => [
        d.name,
        {
          name: d.name,
          description: d.description,
          instructions: d.instructions,
          tools: d.tools,
          ...(d.model !== undefined ? { model: d.model } : {}),
          permissions: d.permissions,
          inherit_bypass: d.inheritBypass,
        } satisfies SubAgentDefinition,
      ]),
    );
    tools.push(createTaskTool({ subAgents }));
    process.stdout.write(
      `[sub-agents] ${subAgents.size} available: ${[...subAgents.keys()].join(", ")}\n`,
    );
  }

  try {
    await runChatLoop({
      model,
      instructions: ir.agent.instructions,
      tools,
      permissionMode,
      permissionRules,
      sessionName: ir.name,
      sessionTarget: ir.target,
      hooks,
      skills,
      slashCommands,
      ...(subAgents !== undefined ? { subAgents, spawnSubAgent } : {}),
      ...(ir.target === "cli" && ir.agent.maxTokens !== undefined
        ? { maxTokens: ir.agent.maxTokens }
        : {}),
      ...(resumeId !== undefined ? { resume: { sessionId: resumeId } } : {}),
      ...(justificationJudge !== undefined ? { justificationJudge } : {}),
      ...(justificationAuditSink !== undefined ? { justificationAuditSink } : {}),
      ...(egressMatcher !== undefined ? { egressMatcher } : {}),
    });
  } finally {
    if (mcpHost) await mcpHost.disconnectAll();
  }
}

/**
 * browser-target run path. Single-turn: read one prompt (from --prompt or
 * stdin), drive a chromium session via @crewhaus/computer-use-driver,
 * disconnect cleanly. Mirrors the codegen template in
 * packages/target-browser-driver/src/index.ts — keep them in sync.
 *
 * V0 deliberately omits MCP, hooks, skills, slash commands, and sub-agents:
 * runChatLoop runs with `singleTurn: true`, so multi-turn-only features
 * aren't load-bearing here. The cli path keeps them. The browser bundle
 * emitter (`@crewhaus/target-browser-driver`) honors ir.tools +
 * ir.toolConfigs and similarly skips mcp_servers / compaction — extend
 * both in lockstep if that ever changes.
 */
async function runRunBrowser(
  args: ParsedArgs,
  ir: Extract<ReturnType<typeof lower>, { target: "browser" }>,
): Promise<void> {
  if (args.flags["resume"] !== undefined || args.flags["continue"] === true) {
    die("--resume and --continue are not supported for target: browser (single-turn)");
  }

  const promptFlag = args.flags["prompt"];
  let prompt: string;
  if (typeof promptFlag === "string" && promptFlag.length > 0) {
    prompt = promptFlag;
  } else if (process.stdin.isTTY) {
    die("no prompt — pass --prompt <text> or pipe input on stdin");
  } else {
    prompt = (await readAllStdin()).trim();
    if (prompt.length === 0) {
      die("no prompt — pass --prompt <text> or pipe non-empty input on stdin");
    }
  }

  let tools: RegisteredTool[] = [];
  if (ir.tools.length > 0) {
    await applyToolConfigs(ir.tools, ir.toolConfigs);
    const toolMap = await loadToolMap();
    tools = ir.tools.map((name) => {
      const tool = toolMap[name];
      if (!tool) {
        const known = Object.keys(toolMap).sort().join(", ");
        die(`unknown tool "${name}" — known tools: ${known}`);
      }
      return tool;
    });
  }

  const modelOverride = args.flags["model"];
  const model = typeof modelOverride === "string" ? modelOverride : ir.agent.model;

  const flagMode = args.flags["permission-mode"];
  let permissionMode: PermissionMode;
  if (typeof flagMode === "string") {
    if (!isValidPermissionMode(flagMode)) {
      die(
        `invalid --permission-mode "${flagMode}" — allowed: ${VALID_PERMISSION_MODES.join(", ")}`,
      );
    }
    permissionMode = flagMode;
  } else if (ir.permissions.mode !== undefined) {
    permissionMode = ir.permissions.mode;
  } else {
    permissionMode = "default";
  }

  const permissionRules = buildRuleSet(ir.permissions.rules, process.cwd());

  // FR-004 — honour --justification-judge on the browser one-shot path too.
  // The browser spec shape carries no `security` block, so this is
  // flag-only (flag > rule-based); both run paths thread the same judge
  // into the same gate inside runChatLoop.
  const justificationJudge = await resolveJustificationJudge(args, undefined);
  // FR-006 — honour --egress-matcher on the browser one-shot path too. The
  // browser spec shape carries no `security` block, so this is flag-only
  // (flag > substring); both run paths thread the same matcher into the same
  // egress check inside runChatLoop.
  const egressMatcher = await resolveEgressMatcher(args, undefined);
  // FR-004 — same durable audit sink as the cli path, so a justification-gated
  // browser tool also writes the `permission_justification_evaluated` record.
  const justificationAuditSink = await openJustificationAuditSink({
    cwd: process.cwd(),
    enabled: args.flags["no-justification-audit"] !== true,
  });

  // Lazy-import the browser-runtime packages so cli/init/doctor invocations
  // don't pay the playwright + computer-use-driver load cost.
  const [{ createDriver }, navigate, screenCapture, mouseKeyboard, visionGrounding] =
    await Promise.all([
      import("@crewhaus/computer-use-driver"),
      import("@crewhaus/tool-navigate"),
      import("@crewhaus/tool-screen-capture"),
      import("@crewhaus/tool-mouse-keyboard"),
      import("@crewhaus/tool-vision-grounding"),
    ]);

  const driver = createDriver({
    backend: ir.driver.backend,
    viewport: ir.driver.viewport,
  });

  emitEvent({ kind: "browser_start", backend: ir.driver.backend });
  await driver.connect();
  try {
    if (ir.driver.startUrl !== undefined) {
      await driver.goto(ir.driver.startUrl);
      emitEvent({ kind: "navigated", url: ir.driver.startUrl });
    }

    const navigateTool = navigate.createNavigateTool({ driver });
    const screenshotTool = screenCapture.createScreenshotTool({ driver });
    const mk = mouseKeyboard.createAllMouseKeyboardTools({ driver });
    const findElement = visionGrounding.createFindElementTool({
      driver,
      model: ir.groundingModel,
    });
    const allTools: RegisteredTool[] = [
      navigateTool,
      screenshotTool,
      mk.click,
      mk.type,
      mk.key,
      mk.scroll,
      findElement,
      ...tools,
    ];

    const finalText = await runChatLoop({
      model,
      instructions: ir.agent.instructions,
      tools: allTools,
      permissionMode,
      permissionRules,
      sessionName: ir.name,
      sessionTarget: "browser",
      singleTurn: true,
      seedMessages: [{ role: "user", content: prompt }],
      ...(justificationJudge !== undefined ? { justificationJudge } : {}),
      ...(justificationAuditSink !== undefined ? { justificationAuditSink } : {}),
      ...(egressMatcher !== undefined ? { egressMatcher } : {}),
      installSigintHandler: false,
      maxTokens: 4096,
    });
    emitEvent({ kind: "browser_done", finalText });
  } finally {
    await driver.disconnect();
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function emitEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

type DoctorCheck = { label: string; pass: boolean; reason?: string; warn?: boolean };

function checkBunVersion(version: string): { pass: boolean; reason?: string } {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return { pass: false, reason: `unparseable version "${version}"` };
  }
  const ok = major > 1 || (major === 1 && minor >= 2);
  return ok ? { pass: true } : { pass: false, reason: `bun ${version} is below minimum 1.2.0` };
}

function runContext(args: ParsedArgs): void {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus context --bundle [-o <file>]\n" +
        "  Emits a single-markdown manifest of the spec schema, recipe index,\n" +
        "  module catalog headings, and getting-started guide. Designed for\n" +
        "  piping into an agent's system prompt or for caching as the answer\n" +
        '  to "give me CrewHaus context."\n' +
        "\n" +
        "  --factory-root <p>   override factory checkout (default: $CREWHAUS_FACTORY_ROOT\n" +
        "                       or sibling-walk from cwd)\n" +
        "  --docs-root <p>      override docs checkout\n" +
        "  --demos-root <p>     override demos checkout\n",
    );
    return;
  }
  if (args.flags["bundle"] !== true) {
    die("missing --bundle (the only mode currently supported)");
  }

  const factoryOverride = args.flags["factory-root"];
  const docsOverride = args.flags["docs-root"];
  const demosOverride = args.flags["demos-root"];
  const env = {
    ...process.env,
    ...(typeof factoryOverride === "string" ? { CREWHAUS_FACTORY_ROOT: factoryOverride } : {}),
    ...(typeof docsOverride === "string" ? { CREWHAUS_DOCS_ROOT: docsOverride } : {}),
    ...(typeof demosOverride === "string" ? { CREWHAUS_DEMOS_ROOT: demosOverride } : {}),
  };

  let roots: ReturnType<typeof discoverRoots>;
  try {
    roots = discoverRoots({ env });
  } catch (err) {
    die((err as Error).message);
  }

  const bundle = buildContextBundle({
    factoryRoot: roots.factoryRoot,
    docsRoot: roots.docsRoot,
    demosRoot: roots.demosRoot,
  });

  const outFile = args.flags["out"];
  if (typeof outFile === "string") {
    const abs = resolve(outFile);
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(abs, bundle.markdown);
    process.stderr.write(
      `wrote bundle: ${abs} (${bundle.markdown.length} chars, ${bundle.sources.length} sources)\n`,
    );
    return;
  }
  process.stdout.write(bundle.markdown);
}

async function runDoctor(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus doctor [--philosophy-alignment [--json] [--baseline | --accept-baseline]] [--liveness]\n" +
        "  --philosophy-alignment   audit the codebase + examples against the three architectural pillars\n" +
        "  --json                   persist findings (stable ids) to .crewhaus/scope-audit/<date>.json\n" +
        "                           and print the snapshot JSON (item 49)\n" +
        "  --baseline               diff findings against .crewhaus/scope-audit/baseline.json; exit\n" +
        "                           non-zero ONLY on NEW findings (accepted legacy findings never block)\n" +
        "  --accept-baseline        promote the current findings to the accepted baseline\n" +
        "  --liveness               process-liveness probe: exit 0 immediately, no credential or\n" +
        "                           spec checks (for container HEALTHCHECKs / k8s exec probes)\n" +
        "\n" +
        "  Credential checks are model-aware: doctor parses the cwd crewhaus.yaml's\n" +
        "  agent.model (claude-*, openai/*, gemini/*, bedrock/*, local/<m>@<url>) and\n" +
        "  checks the matching provider's env; other providers report informationally.\n",
    );
    return;
  }
  // --liveness: pure process-liveness for container/k8s probes. The doctor
  // binary booting far enough to parse argv IS the signal — no credential or
  // spec checks (a probe must not flap on missing keys or a spec-less image).
  if (args.flags["liveness"]) {
    process.stdout.write("ok\n");
    process.exit(0);
  }
  if (args.flags["philosophy-alignment"]) {
    await runDoctorPhilosophyAlignment(args);
    return;
  }
  // Item 49 — the drift-watch flags only make sense on the philosophy audit.
  for (const flag of ["json", "baseline", "accept-baseline"] as const) {
    if (args.flags[flag] === true) {
      die(`--${flag} requires --philosophy-alignment`);
    }
  }

  const checks: DoctorCheck[] = [];

  // Model-aware provider credentials: read the cwd spec's agent.model (when
  // present + parseable) and check the MATCHING provider's env. Falls back to
  // the legacy Anthropic-first check when no model is extractable. See
  // doctor-checks.ts for the full policy (bedrock/local are informational).
  const specPath = join(process.cwd(), "crewhaus.yaml");
  let specModel: string | undefined;
  if (existsSync(specPath)) {
    try {
      specModel = extractSpecModel(readFileSync(specPath, "utf-8"));
    } catch {
      specModel = undefined;
    }
  }
  checks.push(...buildCredentialChecks(specModel, process.env));

  const bunCheck = checkBunVersion(Bun.version);
  checks.push({
    label: `Bun runtime (${Bun.version})`,
    pass: bunCheck.pass,
    reason: bunCheck.reason,
  });

  checks.push({
    label: "crewhaus.yaml in cwd",
    pass: existsSync(specPath),
    reason: existsSync(specPath) ? undefined : `not found at ${specPath} — run \`crewhaus init\``,
  });

  // Item 34 — audit-log integrity. When the cwd carries a `.crewhaus/audit`
  // store (the run path's justification gate writes one by default), walk the
  // hash chain so doctor surfaces tampering. Skipped entirely when no store
  // exists — a fresh checkout must not warn about a log it never wrote.
  const auditDir = join(process.cwd(), ".crewhaus", "audit");
  if (existsSync(auditDir)) {
    const { verify: verifyAuditLog } = await import("@crewhaus/audit-log");
    checks.push(buildAuditIntegrityCheck(await verifyAuditLog(auditDir)));
  }

  for (const c of checks) {
    if (c.warn && c.pass) {
      process.stdout.write(`~ ${c.label}: ${c.reason ?? "informational"}\n`);
    } else if (c.pass) {
      process.stdout.write(`✓ ${c.label}\n`);
    } else {
      process.stdout.write(`✗ ${c.label}: ${c.reason ?? "failed"}\n`);
    }
  }

  const allPass = checks.every((c) => c.pass);
  process.stdout.write(allPass ? "\nall checks passed.\n" : "\nsome checks failed.\n");
  process.exit(allPass ? 0 : 1);
}

/**
 * Workstream D — collect the `--philosophy-alignment` findings. Audits the
 * repo against the three architectural pillars (compiler-as-protagonist,
 * eval-is-active, security-is-fabric). Item 49 gave every finding a stable
 * (class, file, symbol) identity so the drift watch can persist/diff them,
 * and added the boundary-drift detector on top of the six-site check.
 */
async function collectPhilosophyFindings(): Promise<PhilosophyFinding[]> {
  const findings: PhilosophyFinding[] = [];

  // Pillar 1 — compiler-as-protagonist. The IR-discriminated-union is
  // the contract; the architecture doc must reference the IR variants.
  // Canonical docs live off-repo at github.com/crewhaus/docs; we look
  // for a sibling checkout (../docs/) in the developer workspace and
  // warn-skip when absent rather than failing the audit.
  const archDocPath = resolve(process.cwd(), "..", "docs", "COMPILER-ARCHITECTURE.md");
  if (existsSync(archDocPath)) {
    const content = readFileSync(archDocPath, "utf8");
    const referencesIrVariants =
      content.includes("IrV0") && content.includes("IrPipelineV0") && content.includes("IrGraphV0");
    findings.push({
      class: "pillar-doc",
      file: "../docs/COMPILER-ARCHITECTURE.md",
      symbol: "ir-variants",
      label: "Pillar 1 — ../docs/COMPILER-ARCHITECTURE.md references IR variants",
      pass: referencesIrVariants,
      ...(referencesIrVariants
        ? {}
        : { reason: "doc exists but does not enumerate the IR-discriminated-union variants" }),
    });
  } else {
    findings.push({
      class: "pillar-doc",
      file: "../docs/COMPILER-ARCHITECTURE.md",
      symbol: "sibling-checkout",
      label: "Pillar 1 — COMPILER-ARCHITECTURE.md (sibling checkout)",
      pass: true,
      warn: true,
      reason:
        "sibling ../docs not cloned; canonical docs at github.com/crewhaus/docs — clone alongside factory/ to enable this check",
    });
  }

  // Pillar 2 — eval is active. The eval-optimizer-orchestrator must
  // be in the workspace and the optimize CLI subcommand must exist.
  const orchestratorPkg = join(
    process.cwd(),
    "packages",
    "eval-optimizer-orchestrator",
    "package.json",
  );
  findings.push({
    class: "package-presence",
    file: "packages/eval-optimizer-orchestrator/package.json",
    symbol: "eval-optimizer-orchestrator",
    label: "Pillar 2 — eval-optimizer-orchestrator package present",
    pass: existsSync(orchestratorPkg),
    ...(existsSync(orchestratorPkg)
      ? {}
      : { reason: "Workstream B did not land — install or rebuild" }),
  });

  const specPatchPkg = join(process.cwd(), "packages", "spec-patch", "package.json");
  findings.push({
    class: "package-presence",
    file: "packages/spec-patch/package.json",
    symbol: "spec-patch",
    label: "Pillar 2 — spec-patch package present",
    pass: existsSync(specPatchPkg),
    ...(existsSync(specPatchPkg) ? {} : { reason: "Workstream B did not land" }),
  });

  // Pillar 3 — security is a fabric. The boundary-classifier package
  // must exist and be referenced by the canonical boundary sites
  // (tool-mcp, sub-agent-spawner, skills-registry, compaction-autocompact,
  // federation-router, channel-adapter-base).
  const boundaryPkg = join(process.cwd(), "packages", "boundary-classifier", "package.json");
  findings.push({
    class: "package-presence",
    file: "packages/boundary-classifier/package.json",
    symbol: "boundary-classifier",
    label: "Pillar 3 — boundary-classifier package present",
    pass: existsSync(boundaryPkg),
    ...(existsSync(boundaryPkg) ? {} : { reason: "Workstream C did not land" }),
  });

  const boundarySites: ReadonlyArray<{ name: string; path: string }> = [
    { name: "tool-mcp", path: "packages/tool-mcp/src/index.ts" },
    { name: "sub-agent-spawner", path: "packages/sub-agent-spawner/src/index.ts" },
    { name: "skills-registry", path: "packages/skills-registry/src/index.ts" },
    { name: "compaction-autocompact", path: "packages/compaction-autocompact/src/index.ts" },
    { name: "federation-router", path: "packages/federation-router/src/index.ts" },
    { name: "channel-adapter-base", path: "packages/channel-adapter-base/src/index.ts" },
  ];
  for (const site of boundarySites) {
    const filePath = join(process.cwd(), site.path);
    if (!existsSync(filePath)) {
      findings.push({
        class: "boundary-site",
        file: site.path,
        symbol: site.name,
        label: `Pillar 3 — ${site.name} source present`,
        pass: false,
        reason: `${site.path} not found`,
      });
      continue;
    }
    const body = readFileSync(filePath, "utf8");
    const classifies = body.includes("classifyBoundary") || body.includes("boundary-classifier");
    findings.push({
      class: "boundary-site",
      file: site.path,
      symbol: site.name,
      label: `Pillar 3 — ${site.name} calls classifyBoundary`,
      pass: classifies,
      ...(classifies
        ? {}
        : { reason: `no reference to classifyBoundary in ${site.path} — security regression` }),
    });
  }

  // Item 49 — boundary-site DRIFT. The six-site list above only re-checks
  // KNOWN sites; this scans every package for cross-trust ingress signals
  // (same read-the-source substring mechanism) and flags a NEW ingress that
  // never references the classification fabric. Report-only here (warn);
  // the --baseline gate is what fails, and only on NEW findings.
  findings.push(...detectBoundaryDrift(process.cwd()));

  // FR-002 — Pillar 3 sink-side. Audit the full built-in tool map: every
  // outward-reaching built-in must carry scope: "external" so the egress
  // classifier fires on it. Uses the SAME `auditToolScopes` helper as
  // `compile --strict` (acceptance: the two paths share one implementation).
  // Importing the tool packages is heavier than the rest of doctor, so it's
  // confined to this --philosophy-alignment branch.
  const toolMap = await loadToolMap();
  const scopeFindings = auditToolScopes(Object.values(toolMap));
  if (scopeFindings.length === 0) {
    findings.push({
      class: "tool-scope",
      file: "",
      symbol: "all-builtin-outward-tools",
      label: 'Pillar 3 — all built-in outward tools scope:"external"',
      pass: true,
    });
  } else {
    for (const f of scopeFindings) {
      findings.push({
        class: "tool-scope",
        file: "",
        symbol: f.toolName,
        label: `Pillar 3 — tool "${f.toolName}" outward but scope!="external"`,
        pass: false,
        reason: f.reason,
      });
    }
  }

  // Contributor compass exists at project root. AGENTS.md is the canonical
  // vendor-neutral convention (agents.md); CLAUDE.md is accepted as a fallback
  // for repos still on the Claude Code-specific naming.
  const agentsmd = join(process.cwd(), "AGENTS.md");
  const claudemd = join(process.cwd(), "CLAUDE.md");
  const hasContributorCompass = existsSync(agentsmd) || existsSync(claudemd);
  findings.push({
    class: "contributor-doc",
    file: "AGENTS.md",
    symbol: "contributor-compass",
    label: "Contributor doc — AGENTS.md (or CLAUDE.md) at project root",
    pass: hasContributorCompass,
    ...(hasContributorCompass ? {} : { reason: "missing — contributors will drift" }),
  });

  return findings;
}

/**
 * Workstream D + item 49 — `crewhaus doctor --philosophy-alignment
 * [--json] [--baseline | --accept-baseline]`.
 *
 * Plain mode is unchanged: print ✓/~/✗ per check, exit 0 on green / 1 on
 * any hard finding (boundary-drift reports are warn-tier and never fail
 * plain mode). The drift-watch modes:
 *
 *   --json             persist the actionable findings (stable ids) to
 *                      `.crewhaus/scope-audit/<YYYY-MM-DD>.json` and print
 *                      the snapshot JSON to stdout (status lines → stderr).
 *   --baseline         diff against `.crewhaus/scope-audit/baseline.json`
 *                      following regression-runner's gate() shape; exit
 *                      non-zero ONLY on NEW findings — legacy accepted
 *                      findings never block. A missing baseline fails when
 *                      findings exist (a gate nobody armed must not pass).
 *   --accept-baseline  promote the current findings to the baseline (and
 *                      write the dated snapshot); exits 0.
 */
async function runDoctorPhilosophyAlignment(args: ParsedArgs): Promise<void> {
  const jsonMode = args.flags["json"] === true;
  const baselineMode = args.flags["baseline"] === true;
  const acceptMode = args.flags["accept-baseline"] === true;
  if (baselineMode && acceptMode) {
    die("--baseline and --accept-baseline are mutually exclusive");
  }

  const findings = await collectPhilosophyFindings();
  const snapshot = buildScopeAuditSnapshot(findings);
  const rootDir = process.cwd();

  // Human-readable per-check lines. In --json mode they move to stderr so
  // stdout stays a clean machine surface (mirroring `context -o`'s split).
  const statusOut = jsonMode
    ? (line: string): void => void process.stderr.write(line)
    : (line: string): void => void process.stdout.write(line);
  for (const f of findings) {
    if (f.warn && f.pass) {
      statusOut(`~ ${f.label}: ${f.reason ?? "skipped"}\n`);
    } else if (f.pass) {
      statusOut(`✓ ${f.label}\n`);
    } else {
      statusOut(`✗ ${f.label}: ${f.reason ?? "failed"}\n`);
    }
  }

  // Snapshot persistence: --json always writes the dated file;
  // --accept-baseline additionally writes baseline.json.
  if (jsonMode || acceptMode) {
    mkdirSync(scopeAuditDir(rootDir), { recursive: true });
    const snapshotPath = scopeAuditSnapshotPath(rootDir, () => Date.now());
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    statusOut(`wrote ${snapshotPath}\n`);
  }

  if (acceptMode) {
    mkdirSync(scopeAuditDir(rootDir), { recursive: true });
    const baselinePath = scopeAuditBaselinePath(rootDir);
    writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    statusOut(
      `accepted ${snapshot.findings.length} finding(s) as the baseline → ${baselinePath}\n`,
    );
    if (jsonMode) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    process.exit(0);
  }

  if (baselineMode) {
    let baseline: ReturnType<typeof loadScopeAuditSnapshot>;
    try {
      baseline = loadScopeAuditSnapshot(scopeAuditBaselinePath(rootDir));
    } catch (err) {
      if (err instanceof ScopeAuditBaselineError) die(err.message);
      throw err;
    }
    const gate = diffScopeAuditSnapshots(baseline, snapshot);
    for (const line of renderGateReport(gate)) statusOut(`${line}\n`);
    if (jsonMode) process.stdout.write(`${JSON.stringify({ snapshot, gate }, null, 2)}\n`);
    process.exit(gate.verdict === "pass" ? 0 : 1);
  }

  if (jsonMode) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);

  const allPass = findings.every((f) => f.pass);
  statusOut(
    allPass
      ? "\nphilosophy alignment: green. All three pillars intact.\n"
      : `\nphilosophy alignment: ${findings.filter((f) => !f.pass).length} finding(s). See [/AGENTS.md](AGENTS.md) for invariants.\n`,
  );
  process.exit(allPass ? 0 : 1);
}

/**
 * Workstream B — `crewhaus optimize <spec> --dataset <data> --graders
 * <graders.yaml> [--mutator rule-based|claude] [--iterations N]
 * [--budget-usd N] [--write-back] [-o <out-dir>]`. Closes the
 * active-optimisation loop.
 *
 * Loads the spec + dataset + graders, builds a fitness function that
 * re-runs `eval-runner` for every candidate prompt, delegates to
 * `optimizeSpec`, and prints the resulting score delta + spend summary +
 * patch path. FR-003: `--budget-usd N` bounds a model-driven run by a
 * dollar ceiling (the orchestrator stops before a mutation call that
 * would exceed it); it composes with `--iterations` (first bound wins)
 * and is inert on rule-based runs (which make no model calls → $0). A
 * `TraceEventBus` is threaded into `optimizeSpec` so each call's
 * `cost_accrual` and the terminal aggregate spend summary land on the
 * standard observability bus on this real path (CREWHAUS_TRACE_COST=1
 * echoes them to stderr); the run-total $ also prints to stdout.
 */
async function runOptimize(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus optimize <spec.yaml> (--dataset <data> --graders <graders.yaml> | --ratings <session>) " +
        "[--min-score F] [--mutator rule-based|claude] [--iterations N] [--seed N] [--concurrency N] " +
        "[--improvement-threshold F] [--budget-usd N] [--write-back] [--no-register] [-o <out-dir>]\n" +
        "  A successful --write-back auto-registers the rewritten spec in the local\n" +
        "  registry (.crewhaus/specs) with a changelog entry carrying the run's\n" +
        "  score delta and patch rationale — same flow as `crewhaus compile`;\n" +
        "  --no-register opts out. See `crewhaus spec log <name>`.\n",
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  const datasetPath = args.flags["dataset"];
  const gradersPath = args.flags["graders"];
  const ratingsArg = args.flags["ratings"];
  if (typeof datasetPath !== "string" && typeof ratingsArg !== "string") {
    die("missing --dataset <data> (or --ratings <session> to distill one from feedback)");
  }
  if (typeof gradersPath !== "string" && typeof ratingsArg !== "string") {
    die("missing --graders <graders.yaml> (or --ratings to synthesize one from feedback)");
  }
  const ratingsMinScore = floatFlag(args, "min-score") ?? 0.7;
  if (ratingsMinScore < 0 || ratingsMinScore > 1) {
    die(`invalid --min-score "${ratingsMinScore}" — must be in [0,1]`);
  }
  const ratingsDistill =
    typeof ratingsArg === "string" ? distillRatings(ratingsArg, ratingsMinScore) : undefined;

  const iterationsFlag = args.flags["iterations"];
  const seedFlag = args.flags["seed"];
  const thresholdFlag = args.flags["improvement-threshold"];
  const iterations = typeof iterationsFlag === "string" ? Number.parseInt(iterationsFlag, 10) : 10;
  const seed = typeof seedFlag === "string" ? Number.parseInt(seedFlag, 10) : 0xcafe;
  const improvementThreshold =
    typeof thresholdFlag === "string" ? Number.parseFloat(thresholdFlag) : 0.01;
  if (Number.isNaN(iterations) || iterations < 1) {
    die(`invalid --iterations "${iterationsFlag}" — must be positive integer`);
  }

  // Per-candidate eval concurrency. Each iteration runs a full eval pass on
  // the dev set; on a low provider rate-limit tier a high fan-out trips 429s,
  // so this is exposed (mirroring `crewhaus eval --concurrency`) and defaults
  // to 4. The nightly flywheel sets `--concurrency 1` on constrained tiers.
  const concurrencyFlag = args.flags["concurrency"];
  const concurrency =
    typeof concurrencyFlag === "string" ? Number.parseInt(concurrencyFlag, 10) : 4;
  if (Number.isNaN(concurrency) || concurrency < 1) {
    die(`invalid --concurrency "${concurrencyFlag}" — must be a positive integer`);
  }

  // FR-003 — optional dollar budget for model-driven runs. Omit → today's
  // behaviour (iterations cap only). On a rule-based run the gate is inert
  // (no model calls → $0), so passing it is harmless.
  const budgetFlag = args.flags["budget-usd"];
  let budgetUsd: number | undefined;
  if (typeof budgetFlag === "string") {
    budgetUsd = Number.parseFloat(budgetFlag);
    if (Number.isNaN(budgetUsd) || budgetUsd <= 0) {
      die(`invalid --budget-usd "${budgetFlag}" — must be a positive number`);
    }
  }

  const writeBack = args.flags["write-back"] === true;
  const outDirArg = args.flags["out"];
  const absSpec = resolve(specPath);
  const runId = `opt_${Date.now().toString(16)}`;
  const outDir =
    typeof outDirArg === "string"
      ? resolve(outDirArg)
      : resolve(join(".crewhaus", "optimize", runId));

  let gradersYaml: string;
  if (typeof gradersPath === "string") {
    try {
      gradersYaml = readFileSync(resolve(gradersPath), "utf-8");
    } catch (err) {
      die(`could not read ${gradersPath}: ${(err as Error).message}`);
    }
  } else {
    // No --graders: use the grader synthesized from the ratings (guaranteed
    // present here because the missing-flags gate required --ratings).
    gradersYaml = (ratingsDistill as { gradersYaml: string }).gradersYaml;
  }
  const { compiled } = parseGradersConfig(gradersYaml);

  // Materialize the training set once — we'll re-iterate per fitness call. It
  // is the union of the file dataset (if any) and the distilled ratings (if
  // any); at least one is present per the missing-flags gate above.
  const samples: Array<{ id: string; input: string; expected_output?: string }> = [];
  let datasetName = "ratings";
  if (typeof datasetPath === "string") {
    const dataset = await loadDataset(resolve(datasetPath));
    datasetName = dataset.name;
    for await (const s of dataset.samples) {
      samples.push({
        id: s.id,
        input: s.input,
        ...(s.expected_output !== undefined ? { expected_output: s.expected_output } : {}),
      });
    }
  }
  if (ratingsDistill !== undefined) samples.push(...ratingsDistill.samples);
  if (samples.length === 0) die(`dataset "${datasetName}" yielded zero samples`);

  // Train/dev split: 70/30 deterministic split by sample id ordering.
  const splitIdx = Math.max(1, Math.floor(samples.length * 0.7));
  const trainSet = samples.slice(0, splitIdx);
  const devSet = samples.slice(splitIdx);
  if (devSet.length === 0) {
    die(`dataset has ${samples.length} samples — need at least 2 (70/30 split needs a dev split)`);
  }

  // Index the dev set by id so the fitness fn can join each graded
  // sample-result back to the input + reference it was scored against.
  const devById = new Map(devSet.map((s) => [s.id, s]));

  // Fitness fn: patch the spec with the candidate prompt, lower to IR,
  // run eval-runner, and return the pass-rate PLUS per-sample grades. The
  // aggregate `passRate` still drives the search (unchanged scoring); the
  // grades are additive — they carry each sample's overall score and the
  // grader's rationale to the mutator (via OptimizerState.bestGrades) so
  // a model-driven rewrite can target the samples the prompt actually
  // fails and the reason it fails them. Each call is one full eval pass.
  const fitness = async (
    prompt: string,
  ): Promise<import("@crewhaus/prompt-optimizer").FitnessResult> => {
    const yamlText = readFileSync(absSpec, "utf-8");
    // Re-parse to capture spec.target without depending on the
    // orchestrator's extractCurrentPrompt internals.
    const parsedTarget = parseSpec(yamlText).target;
    // Build a patch and apply it in-memory (no disk write — fitness is
    // pure with respect to the source file).
    const { applySpecPatch } = await import("@crewhaus/spec-patch");
    const { yaml: patchedYaml } = applySpecPatch(yamlText, {
      target: parsedTarget as never,
      path: ["agent", "instructions"],
      op: "replace",
      value: prompt,
    });
    let ir: ReturnType<typeof lower>;
    try {
      ir = lower(parseSpec(patchedYaml));
    } catch (err) {
      if (err instanceof SpecParseError) {
        process.stderr.write("[optimize] candidate compiled invalid spec, skipping\n");
        return { score: 0 };
      }
      throw err;
    }
    if (ir.target !== "cli") {
      die(`crewhaus optimize v0 only supports target: cli (got "${ir.target}")`);
    }
    const summary = await runEvalLib({
      ir,
      dataset: { name: datasetName, samples: makeAsyncIterable(devSet) },
      compiledGraders: compiled,
      opts: {
        outDir: join(outDir, "evals", `${prompt.length}_${ir.agent.instructions.length}`),
        concurrency,
        seed,
      },
    });
    const grades = summary.samples.map((r) => {
      const dev = devById.get(r.sampleId);
      return {
        input: dev?.input ?? r.sampleId,
        score: r.grades.overall.score,
        ...(dev?.expected_output !== undefined ? { expected: dev.expected_output } : {}),
        rationale: r.grades.overall.rationale,
      };
    });
    return { score: summary.aggregates.passRate, grades };
  };

  const mutator = args.flags["mutator"];
  let mutatorImpl: import("@crewhaus/prompt-optimizer").MutationProvider | undefined;
  if (mutator === "claude") {
    const { createClaudeMutationProvider } = await import("@crewhaus/prompt-optimizer-claude");
    const { resolveModel } = await import("@crewhaus/model-router");
    const ir = lower(parseSpec(readFileSync(absSpec, "utf-8")));
    const mutatorModel = ir.target === "cli" ? ir.agent.model : "claude-sonnet-4-5";
    // Resolve via the model-router so non-Anthropic specs drive their own
    // provider: the resolved adapter + STRIPPED wire modelId replace the old
    // hardcoded createAnthropicAdapter() + verbatim prefixed string (which
    // made `--mutator claude` a silent no-op for openai/gemini/bedrock/local
    // specs — every mutation call failed and the provider fell back).
    const resolution = await resolveModel(mutatorModel);
    mutatorImpl = createClaudeMutationProvider({
      adapter: resolution.adapter,
      model: resolution.modelId,
    });
  } else if (mutator !== undefined && mutator !== "rule-based") {
    die(`unknown --mutator "${mutator}" — supported: rule-based, claude`);
  }

  process.stdout.write(
    `[optimize] runId=${runId} spec=${specPath} dataset=${datasetName} ` +
      `(${trainSet.length} train / ${devSet.length} dev) iterations=${iterations} ` +
      `mutator=${mutator ?? "rule-based"}\n`,
  );

  // FR-003 — thread a real trace bus into the optimize run so the per-call
  // `cost_accrual` events AND the terminal aggregate summary land on the
  // standard observability bus on the actual `crewhaus optimize` path — not
  // only when a unit test injects a bus. The spend total still prints to
  // stdout below (unchanged default UX); set CREWHAUS_TRACE_COST=1 to also
  // echo each bus cost event to stderr for live observability.
  const traceBus = new TraceEventBus({ runId, sessionId: runId });
  if (process.env["CREWHAUS_TRACE_COST"] === "1") {
    traceBus.subscribe((e) => {
      if (e.kind !== "cost_accrual") return;
      const ev = e as CostAccrualEvent;
      const label = ev.summary === true ? "cost-total" : "cost-call";
      process.stderr.write(
        `[optimize] ${label} provider=${ev.provider} model=${ev.modelId} ` +
          `in=${ev.inputTokens} out=${ev.outputTokens} micros=${ev.costUsdMicros}\n`,
      );
    });
  }

  const result = await optimizeSpec({
    specPath: absSpec,
    fitness,
    trainSet,
    devSet,
    iterations,
    seed,
    improvementThreshold,
    outDir,
    writeBack,
    runId,
    traceBus,
    ...(mutatorImpl !== undefined ? { mutator: mutatorImpl } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  });

  process.stdout.write(
    `[optimize] score: ${result.scoreBefore.toFixed(3)} → ${result.scoreAfter.toFixed(3)} ` +
      `(Δ ${result.improvement >= 0 ? "+" : ""}${result.improvement.toFixed(3)})\n`,
  );
  // FR-003 — spend summary: total $ + model-call count, and whether the
  // dollar budget (not the iterations cap) ended the run.
  const spendStop =
    result.stoppedReason === "budget-reached"
      ? ` (stopped: budget reached, $${budgetUsd?.toFixed(2)} cap)\n`
      : "\n";
  process.stdout.write(
    `[optimize] spend: ${result.spend.totalUsd} over ${result.spend.perIteration.length} model call(s)${spendStop}`,
  );
  process.stdout.write(`[optimize] patch: ${join(result.outDir, "patch.json")}\n`);
  if (result.applied) {
    if (result.writtenTo) {
      process.stdout.write(`[optimize] wrote patched YAML to ${result.writtenTo}\n`);
      // Item 46 — a successful write-back changed the working spec, so run
      // the same auto-register + changelog flow as `compile`. Re-read the
      // written file (it now carries the formatWriteBackHeader stamp the
      // changelog distills) and pass this run's own patch.json explicitly —
      // a custom -o relocates it away from .crewhaus/optimize/<runId>/.
      if (args.flags["no-register"] !== true) {
        await autoRegisterSpec(readFileSync(result.writtenTo, "utf-8"), {
          patchJsonPath: join(result.outDir, "patch.json"),
        });
      }
    } else {
      process.stdout.write(
        `[optimize] patch ready (improvement ≥ ${improvementThreshold}). Re-run with --write-back to apply.\n`,
      );
    }
  } else {
    process.stdout.write(
      `[optimize] no improvement above threshold ${improvementThreshold}; source untouched.\n`,
    );
  }
}

function makeAsyncIterable<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

async function runEvalSubcommand(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus eval <spec.yaml> --dataset <data> --graders <graders.yaml> " +
        "[--judge-model <model>] [--concurrency N] [--seed N] -o <out-dir>\n" +
        "  --judge-model accepts the full router grammar (claude-*, openai/<m>, gemini/<m>,\n" +
        "  bedrock/<id>, local/<m>@<url>); the default judge claude-sonnet-4-5 requires\n" +
        "  Anthropic credentials (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY)\n",
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  const datasetPath = args.flags["dataset"];
  const gradersPath = args.flags["graders"];
  const outDirArg = args.flags["out"];
  if (typeof datasetPath !== "string") die("missing --dataset <data>");
  if (typeof gradersPath !== "string") die("missing --graders <graders.yaml>");
  if (typeof outDirArg !== "string") die("missing -o <out-dir>");

  const concurrencyFlag = args.flags["concurrency"];
  const seedFlag = args.flags["seed"];
  const judgeModelFlag = args.flags["judge-model"];
  const concurrency =
    typeof concurrencyFlag === "string" ? Number.parseInt(concurrencyFlag, 10) : undefined;
  const seed = typeof seedFlag === "string" ? Number.parseInt(seedFlag, 10) : undefined;
  if (concurrency !== undefined && (Number.isNaN(concurrency) || concurrency < 1)) {
    die(`invalid --concurrency "${concurrencyFlag}" — must be positive integer`);
  }
  if (seed !== undefined && Number.isNaN(seed)) {
    die(`invalid --seed "${seedFlag}" — must be integer`);
  }

  const absSpec = resolve(specPath);
  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }
  let ir: ReturnType<typeof lower>;
  try {
    ir = lower(parseSpec(yamlText));
  } catch (err) {
    if (err instanceof SpecParseError) die(err.message);
    throw err;
  }
  if (ir.target !== "cli") {
    die(`crewhaus eval only supports target: cli (got "${ir.target}")`);
  }

  let gradersYaml: string;
  try {
    gradersYaml = readFileSync(resolve(gradersPath), "utf-8");
  } catch (err) {
    die(`could not read ${gradersPath}: ${(err as Error).message}`);
  }
  const { compiled } = parseGradersConfig(gradersYaml);
  const dataset = await loadDataset(resolve(datasetPath));

  const absOut = resolve(outDirArg);
  process.stdout.write(`[eval] running ${dataset.name}: ${compiled.length} graders → ${absOut}\n`);

  const summary = await runEvalLib({
    ir,
    dataset,
    compiledGraders: compiled,
    opts: {
      outDir: absOut,
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
    },
  });

  // Render report
  const loaded = await loadRun(absOut);
  const rendered = renderReport(loaded);
  writeFileSync(join(absOut, "index.html"), rendered.html);

  process.stdout.write(
    `[eval] runId=${summary.runId} pass_rate=${(summary.aggregates.passRate * 100).toFixed(1)}% ` +
      `mean_score=${summary.aggregates.meanScore.toFixed(3)} ` +
      `errors=${summary.aggregates.errorCount} ` +
      `tokens=${summary.aggregates.totalTokens.input}/${summary.aggregates.totalTokens.output}\n`,
  );
  process.stdout.write(`[eval] report: ${join(absOut, "index.html")}\n`);
}

async function runEvalReport(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write("usage: crewhaus eval-report diff <prev> <new> [-o <out-dir>]\n");
    return;
  }
  const action = args.positional[0];
  if (action !== "diff") die(`eval-report: unknown action "${action ?? ""}" — supported: diff`);

  const prev = args.positional[1];
  const next = args.positional[2];
  if (typeof prev !== "string" || typeof next !== "string") {
    die("eval-report diff: missing <prev> <new>");
  }

  const outArg = args.flags["out"];
  const prevLoaded = await loadRun(prev);
  const nextLoaded = await loadRun(next);
  const result = diffReports(prevLoaded, nextLoaded);

  if (typeof outArg === "string") {
    const absOut = resolve(outArg);
    mkdirSync(absOut, { recursive: true });
    writeFileSync(join(absOut, "index.html"), result.html);
    writeFileSync(join(absOut, "diff.json"), result.json);
    process.stdout.write(`[eval-report] diff: ${join(absOut, "index.html")}\n`);
  } else {
    process.stdout.write(result.html);
  }
  process.stdout.write(
    `[eval-report] regressions=${result.diff.regressions.length} ` +
      `recoveries=${result.diff.recoveries.length} ` +
      `score_shifts=${result.diff.scoreShifts.length} ` +
      `unchanged=${result.diff.unchanged}\n`,
  );
}

/**
 * Section 27 — `crewhaus cost-summary [--session <id>] [--tenant <id>]
 * [--format json|text]`. Reads `cost_accrual` events out of an `event-log`
 * (or aggregates the per-day audit-log records) and prints a USD summary.
 *
 * v0 ships with the per-session readout — pass `--session <id>` to read
 * the JSONL transcript at `.crewhaus/sessions/<id>.jsonl` and aggregate
 * the cost_accrual events embedded in there. Tenant aggregation lands in
 * §31's studio-server cost dashboard.
 */
/** Per-(provider/model) cache-economics accumulator for `cost-summary`. */
type CacheStats = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
};

/** Cache hit ratio = cachedReadTokens / (inputTokens + cachedReadTokens); 0 when no input observed. */
function cacheHitRatio(s: CacheStats): number {
  const denominator = s.inputTokens + s.cachedReadTokens;
  return denominator === 0 ? 0 : s.cachedReadTokens / denominator;
}

/**
 * Realized savings for one provider/model bucket, repriced from the current
 * DEFAULT_PRICING (the accrual carries `(provider, modelId)` — exactly the
 * `resolvePricing` key). Unknown provider/model → undefined (savings cannot
 * be priced; tokens and hit ratio still report).
 */
function cacheSavingsMicros(provider: string, modelId: string, s: CacheStats): number | undefined {
  const row = resolvePricing(DEFAULT_PRICING, provider as ProviderId, modelId);
  if (!row) return undefined;
  return computeCacheSavingsMicros(row, s.cachedReadTokens, s.cacheCreationTokens);
}

function formatCacheLine(s: CacheStats, savings: number | undefined): string {
  const hitPct = (cacheHitRatio(s) * 100).toFixed(1);
  const savingsStr = savings === undefined ? "n/a" : `$${(savings / 1_000_000).toFixed(4)}`;
  return (
    `read=${s.cachedReadTokens} write=${s.cacheCreationTokens} ` +
    `hit=${hitPct}% savings=${savingsStr}`
  );
}

async function runCostSummary(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus cost-summary --session <id> [--format json|text]\n" +
        "\n" +
        "cache economics columns (per provider/model and total):\n" +
        "  read     prompt-cache READ tokens (billed at the discounted cached rate)\n" +
        "  write    prompt-cache WRITE tokens (billed at a premium over input)\n" +
        "  hit      cache hit ratio = cachedReadTokens / (inputTokens + cachedReadTokens)\n" +
        "  savings  realized savings = (cached reads at the full input price)\n" +
        "           - (cached reads at the discounted rate)\n" +
        "           - (cache-write premium paid above the normal input price)\n",
    );
    return;
  }
  const session = args.flags["session"];
  const format = args.flags["format"] ?? "text";
  if (typeof session !== "string") die("missing --session <id>");

  const sessionFile = join(process.cwd(), ".crewhaus", "sessions", `${session}.jsonl`);
  if (!existsSync(sessionFile)) {
    die(`session log not found at ${sessionFile}`);
  }
  const lines = readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter((l) => l !== "");
  let totalMicros = 0;
  const byProvider: Record<string, number> = {};
  let count = 0;
  const totalCache: CacheStats = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
  };
  // Keyed "provider/modelId"; insertion order == first-seen order, stable for output.
  const byModel = new Map<string, { provider: string; modelId: string; stats: CacheStats }>();
  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "kind" in parsed &&
      (parsed as { kind?: string }).kind === "cost_accrual"
    ) {
      // event-log writes a `{ ts, version, kind, payload }` envelope, so the
      // cost fields live under `payload`. Fall back to top-level fields so a
      // hand-written/flat cost_accrual line still aggregates. Every token
      // field is optional — logs persisted before cache economics landed
      // carry only provider/costUsdMicros (or no cacheCreationTokens) and
      // must keep parsing.
      type AccrualFields = {
        provider?: string;
        modelId?: string;
        costUsdMicros?: number;
        inputTokens?: number;
        outputTokens?: number;
        cachedReadTokens?: number;
        cacheCreationTokens?: number;
      };
      const e = parsed as AccrualFields & { payload?: AccrualFields };
      const provider = e.payload?.provider ?? e.provider;
      const micros = e.payload?.costUsdMicros ?? e.costUsdMicros;
      if (typeof provider === "string" && typeof micros === "number") {
        totalMicros += micros;
        byProvider[provider] = (byProvider[provider] ?? 0) + micros;
        count++;
        const modelId = e.payload?.modelId ?? e.modelId;
        const delta: CacheStats = {
          inputTokens: e.payload?.inputTokens ?? e.inputTokens ?? 0,
          outputTokens: e.payload?.outputTokens ?? e.outputTokens ?? 0,
          cachedReadTokens: e.payload?.cachedReadTokens ?? e.cachedReadTokens ?? 0,
          cacheCreationTokens: e.payload?.cacheCreationTokens ?? e.cacheCreationTokens ?? 0,
        };
        totalCache.inputTokens += delta.inputTokens;
        totalCache.outputTokens += delta.outputTokens;
        totalCache.cachedReadTokens += delta.cachedReadTokens;
        totalCache.cacheCreationTokens += delta.cacheCreationTokens;
        if (typeof modelId === "string") {
          const key = `${provider}/${modelId}`;
          const bucket = byModel.get(key) ?? {
            provider,
            modelId,
            stats: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0 },
          };
          bucket.stats.inputTokens += delta.inputTokens;
          bucket.stats.outputTokens += delta.outputTokens;
          bucket.stats.cachedReadTokens += delta.cachedReadTokens;
          bucket.stats.cacheCreationTokens += delta.cacheCreationTokens;
          byModel.set(key, bucket);
        }
      }
    }
  }
  // Total savings = Σ per-model savings (rates are per-model, so pricing must
  // resolve per bucket). Unpriced buckets contribute nothing — same "miss ⇒
  // $0, never crash" contract as the tracker itself.
  let totalSavings = 0;
  const modelRows: Array<{
    key: string;
    stats: CacheStats;
    savings: number | undefined;
  }> = [];
  for (const [key, { provider, modelId, stats }] of byModel) {
    const savings = cacheSavingsMicros(provider, modelId, stats);
    if (savings !== undefined) totalSavings += savings;
    modelRows.push({ key, stats, savings });
  }
  const totalDollars = totalMicros / 1_000_000;
  if (format === "json") {
    // Additive fields only — `session`/`count`/`totalUsdMicros`/`byProvider`
    // keep their exact pre-cache-economics shape.
    const cacheByModel: Record<
      string,
      CacheStats & { cacheHitRatio: number; cacheSavingsUsdMicros: number | null }
    > = {};
    for (const row of modelRows) {
      cacheByModel[row.key] = {
        ...row.stats,
        cacheHitRatio: cacheHitRatio(row.stats),
        cacheSavingsUsdMicros: row.savings ?? null,
      };
    }
    process.stdout.write(
      `${JSON.stringify({
        session,
        count,
        totalUsdMicros: totalMicros,
        byProvider,
        inputTokens: totalCache.inputTokens,
        outputTokens: totalCache.outputTokens,
        cachedReadTokens: totalCache.cachedReadTokens,
        cacheCreationTokens: totalCache.cacheCreationTokens,
        cacheHitRatio: cacheHitRatio(totalCache),
        cacheSavingsUsdMicros: totalSavings,
        cacheByModel,
      })}\n`,
    );
  } else {
    process.stdout.write(`session: ${session}\n`);
    process.stdout.write(`accrual events: ${count}\n`);
    process.stdout.write(`total: $${totalDollars.toFixed(4)}\n`);
    for (const [p, m] of Object.entries(byProvider)) {
      process.stdout.write(`  ${p}: $${(m / 1_000_000).toFixed(4)}\n`);
    }
    process.stdout.write(`cache: ${formatCacheLine(totalCache, totalSavings)}\n`);
    for (const row of modelRows) {
      process.stdout.write(`  ${row.key}: ${formatCacheLine(row.stats, row.savings)}\n`);
    }
  }
}

// -------- response feedback: rate / feedback / distill --------

const SESSIONS_SUBDIR = join(".crewhaus", "sessions");
const FEEDBACK_SUBDIR = join(".crewhaus", "feedback");

function sessionJsonlPath(session: string): string {
  return join(process.cwd(), SESSIONS_SUBDIR, `${session}.jsonl`);
}

/** Parse a JSONL blob into objects, skipping blank/malformed lines. */
function parseJsonlObjects(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A single malformed line must not abort a read.
    }
  }
  return out;
}

function readSessionEvents(session: string): Array<{ kind?: string; payload?: unknown }> {
  const file = sessionJsonlPath(session);
  if (!existsSync(file)) die(`session log not found at ${file}`);
  return parseJsonlObjects(readFileSync(file, "utf-8")) as Array<{
    kind?: string;
    payload?: unknown;
  }>;
}

function strFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

function intFlag(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags[name];
  if (typeof v !== "string") return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) die(`invalid --${name} "${v}" — must be an integer`);
  return n;
}

function floatFlag(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags[name];
  if (typeof v !== "string") return undefined;
  const n = Number.parseFloat(v);
  if (Number.isNaN(n)) die(`invalid --${name} "${v}" — must be a number`);
  return n;
}

/** Resolve --turn against the transcript-derived turns; default to the last. */
function resolveTurn(args: ParsedArgs, turns: ReadonlyArray<DerivedTurn>): number {
  const flag = args.flags["turn"];
  const last = turns[turns.length - 1] as DerivedTurn;
  if (typeof flag !== "string") return last.turnNumber;
  const n = Number.parseInt(flag, 10);
  if (Number.isNaN(n)) die(`invalid --turn "${flag}" — must be an integer`);
  if (!turns.some((t) => t.turnNumber === n)) {
    die(`turn ${n} not found — session has turns 1..${turns.length}`);
  }
  return n;
}

/** Shared capture path for `rate` and `feedback`: validate the session, derive
 *  turns, build a FeedbackRecord, and append it as a `user_feedback` event. */
async function captureFeedback(
  args: ParsedArgs,
  source: FeedbackSource,
  fields: {
    thumbs?: "up" | "down";
    stars?: number;
    score?: number;
    comment?: string;
    correction?: string;
    rater?: string;
  },
): Promise<void> {
  const session = args.flags["session"];
  if (typeof session !== "string") die("missing --session <id>");
  if (!SESSION_ID_REGEX.test(session))
    die(`invalid --session "${session}" — expected sess_<16 hex>`);
  const turns = deriveTurns(readSessionEvents(session));
  if (turns.length === 0) die(`session ${session} has no user turns to rate`);
  const turnNumber = resolveTurn(args, turns);

  let record: FeedbackRecord;
  try {
    record = buildFeedbackRecord({
      id: `fb_${randomBytes(6).toString("hex")}`,
      sessionId: session,
      turnNumber,
      ts: new Date().toISOString(),
      source,
      ...fields,
    });
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const log = await openEventLog(session, { rootDir: join(process.cwd(), SESSIONS_SUBDIR) });
  await log.append({ kind: FEEDBACK_EVENT_KIND, payload: record });
  process.stdout.write(`recorded ${record.modality} feedback on ${session} turn ${turnNumber}\n`);
}

async function runRate(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus rate --session <id> [--turn N] " +
        "(--thumbs up|down | --stars 1-5 | --score 0-1) [--comment <text>] [--rater <who>]\n",
    );
    return;
  }
  const thumbsFlag = args.flags["thumbs"];
  let thumbs: "up" | "down" | undefined;
  if (typeof thumbsFlag === "string") {
    if (thumbsFlag !== "up" && thumbsFlag !== "down")
      die(`--thumbs must be "up" or "down" (got "${thumbsFlag}")`);
    thumbs = thumbsFlag;
  }
  const stars = intFlag(args, "stars");
  const score = floatFlag(args, "score");
  if (thumbs === undefined && stars === undefined && score === undefined) {
    die("give one of --thumbs up|down, --stars 1-5, or --score 0-1");
  }
  await captureFeedback(args, "cli", {
    ...(thumbs !== undefined ? { thumbs } : {}),
    ...(stars !== undefined ? { stars } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(strFlag(args, "comment") !== undefined ? { comment: strFlag(args, "comment") } : {}),
    ...(strFlag(args, "rater") !== undefined ? { rater: strFlag(args, "rater") } : {}),
  });
}

async function runFeedbackCmd(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus feedback --session <id> [--turn N] --text <msg> [--correction <better answer>] [--rater <who>]\n",
    );
    return;
  }
  const text = strFlag(args, "text");
  const correction = strFlag(args, "correction");
  if (text === undefined && correction === undefined) {
    die("give --text <msg> and/or --correction <better answer>");
  }
  await captureFeedback(args, "cli", {
    ...(text !== undefined ? { comment: text } : {}),
    ...(correction !== undefined ? { correction } : {}),
    ...(strFlag(args, "rater") !== undefined ? { rater: strFlag(args, "rater") } : {}),
  });
}

/** List `sess_*` ids that have a transcript under `.crewhaus/sessions`. */
function listSessionIds(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .filter((id) => SESSION_ID_REGEX.test(id));
}

/** Read bare FeedbackRecords from `.crewhaus/feedback/*.jsonl` (the web-UI host
 *  sink, which has no event-log handle). */
function readFeedbackDir(feedbackDir: string): FeedbackRecord[] {
  if (!existsSync(feedbackDir)) return [];
  const objects: unknown[] = [];
  for (const f of readdirSync(feedbackDir)) {
    if (!f.endsWith(".jsonl")) continue;
    objects.push(...parseJsonlObjects(readFileSync(join(feedbackDir, f), "utf-8")));
  }
  return extractFeedbackRecords(objects);
}

async function runDistill(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus distill (--session <id> | --all-sessions) -o <dataset.jsonl> " +
        "[--graders-out <graders.yaml>] [--min-score F] [--judge] [--judge-model <model>]\n",
    );
    return;
  }
  const outPath = args.flags["out"];
  if (typeof outPath !== "string") die("missing -o <dataset.jsonl>");
  const allSessions = args.flags["all-sessions"] === true;
  const session = args.flags["session"];
  if (!allSessions && typeof session !== "string")
    die("missing --session <id> (or --all-sessions)");
  if (typeof session === "string" && !SESSION_ID_REGEX.test(session)) {
    die(`invalid --session "${session}" — expected sess_<16 hex>`);
  }
  const minScore = floatFlag(args, "min-score") ?? 0.7;
  if (minScore < 0 || minScore > 1) die(`invalid --min-score "${minScore}" — must be in [0,1]`);
  const useJudge = args.flags["judge"] === true;
  const judgeModel = args.flags["judge-model"];

  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const sessionIds = allSessions ? listSessionIds(sessionsDir) : [session as string];
  if (sessionIds.length === 0) die(`no sessions found under ${sessionsDir}`);

  // Derive turns per session (tagged with the sessionId join key) and gather
  // feedback from both the in-transcript events and the web-UI feedback dir.
  const turns: SessionTurn[] = [];
  const feedback: FeedbackRecord[] = [];
  for (const id of sessionIds) {
    const events = readSessionEvents(id);
    for (const t of deriveTurns(events)) turns.push({ ...t, sessionId: id });
    feedback.push(...extractFeedbackRecords(events));
  }
  feedback.push(...readFeedbackDir(join(process.cwd(), FEEDBACK_SUBDIR)));

  if (feedback.length === 0) {
    die("no feedback found — record some with `crewhaus rate` / `crewhaus feedback` first");
  }

  const result = distillFeedback(turns, feedback, {
    minScore,
    ...(useJudge ? { judge: true } : {}),
    ...(typeof judgeModel === "string" ? { judgeModel } : {}),
  });
  for (const w of result.warnings) process.stderr.write(`[distill] warning: ${w}\n`);
  if (result.samples.length === 0) die("no rated turns could be matched to the transcript(s)");

  const absOut = resolve(outPath);
  mkdirSync(dirname(absOut), { recursive: true });
  writeFileSync(absOut, samplesToJsonl(result.samples), { mode: 0o600 });

  const gradersOut = args.flags["graders-out"];
  if (typeof gradersOut === "string") {
    const absGraders = resolve(gradersOut);
    mkdirSync(dirname(absGraders), { recursive: true });
    writeFileSync(absGraders, gradersConfigToYaml(result.graders), { mode: 0o600 });
  }

  const { stats } = result;
  process.stdout.write(
    `[distill] ${stats.matchedTurns} rated turn(s) → ${result.samples.length} sample(s) ` +
      `(${stats.positives} positive, ${stats.negatives} low-rated) → ${absOut}\n`,
  );
  if (typeof gradersOut === "string") {
    const g = result.graders.graders[0];
    process.stdout.write(`[distill] grader: ${g?.name} (${g?.type}) → ${resolve(gradersOut)}\n`);
  }
  if (stats.unmatchedFeedback > 0) {
    process.stdout.write(
      `[distill] ${stats.unmatchedFeedback} rating(s) had no matching turn (skipped)\n`,
    );
  }
}

/**
 * Inline-distill ratings for `crewhaus optimize --ratings`. `ratingsArg` is a
 * session id or "all". Returns optimizer-shaped samples plus a synthesized
 * graders.yaml (used only when the user did not pass their own --graders).
 */
function distillRatings(
  ratingsArg: string,
  minScore: number,
): {
  samples: Array<{ id: string; input: string; expected_output?: string }>;
  gradersYaml: string;
} {
  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  let sessionIds: string[];
  if (ratingsArg === "all") {
    sessionIds = listSessionIds(sessionsDir);
  } else {
    if (!SESSION_ID_REGEX.test(ratingsArg)) {
      die(`invalid --ratings "${ratingsArg}" — expected a session id (sess_<16 hex>) or "all"`);
    }
    sessionIds = [ratingsArg];
  }
  if (sessionIds.length === 0) die(`no sessions found under ${sessionsDir}`);

  const turns: SessionTurn[] = [];
  const feedback: FeedbackRecord[] = [];
  for (const id of sessionIds) {
    const events = readSessionEvents(id);
    for (const t of deriveTurns(events)) turns.push({ ...t, sessionId: id });
    feedback.push(...extractFeedbackRecords(events));
  }
  feedback.push(...readFeedbackDir(join(process.cwd(), FEEDBACK_SUBDIR)));
  if (feedback.length === 0) {
    die(
      "no feedback found for --ratings — record some with `crewhaus rate` / `crewhaus feedback` first",
    );
  }

  const result = distillFeedback(turns, feedback, { minScore });
  for (const w of result.warnings) process.stderr.write(`[optimize] ratings warning: ${w}\n`);
  const samples = result.samples.map((s) => ({
    id: s.id,
    input: s.input,
    ...(s.expected_output !== undefined ? { expected_output: s.expected_output } : {}),
  }));
  return { samples, gradersYaml: gradersConfigToYaml(result.graders) };
}

// -------- state backup / restore (item 69) --------

/** Label for the default backup file name: the cwd spec's harness name when
 *  a parseable crewhaus.yaml is present, else the cwd basename. */
function stateBackupLabel(): string {
  const specPath = join(process.cwd(), "crewhaus.yaml");
  if (existsSync(specPath)) {
    try {
      return parseSpec(readFileSync(specPath, "utf-8")).name;
    } catch {
      // Unparseable spec — fall through to the directory name.
    }
  }
  return basename(process.cwd());
}

/**
 * Item 69 — `crewhaus state <backup|restore>`. The cwd-local `.crewhaus/`
 * dir is a harness's entire accumulated state; `backup` snapshots it to a
 * transportable tarball, `restore` unpacks it (full replace or additive
 * merges). The heavy lifting lives in ./state-backup; this is flag parsing
 * + output only, per house pattern.
 */
async function runState(args: ParsedArgs, action: "backup" | "restore"): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus state backup [-o <file.tar.gz>] [--exclude <glob,glob>]\n" +
        "  crewhaus state restore <file.tar.gz> [--into <dir>] [--merge feedback|all] [--force]\n" +
        "\n" +
        "backup: archive the cwd .crewhaus/ state dir (sessions, feedback,\n" +
        "  memories, datasets, spec registry, optimize runs, durable-state\n" +
        "  sqlite) to a gzipped tarball. Default name:\n" +
        "  crewhaus-state-<harnessname-or-dir>-<date>.tar.gz. The archive\n" +
        "  carries a backup-manifest.json (created ts, source dir, crewhaus\n" +
        "  version, per-subdir file/byte counts). sqlite files are snapshotted\n" +
        "  via a read-only bun:sqlite serialize so a live writer cannot tear\n" +
        "  the copy; if a snapshot fails the raw bytes are copied and the\n" +
        "  manifest records sqliteConsistent: false. Source files are never\n" +
        "  modified.\n" +
        "  --exclude   comma-separated globs matched against paths relative to\n" +
        "              .crewhaus; a bare pattern also matches file/dir names\n" +
        '              anywhere (e.g. --exclude "sessions,*.sqlite").\n' +
        "\n" +
        "restore: unpack a backup into <dir>/.crewhaus (default: cwd). By\n" +
        "  default it REFUSES to overwrite an existing non-empty .crewhaus.\n" +
        "  --force            full replace — the existing dir is first moved\n" +
        "                     aside to .crewhaus.bak-<ts>, never deleted\n" +
        "  --merge feedback   fold ONLY the archive's feedback records\n" +
        "                     (session user_feedback events + feedback/*.jsonl)\n" +
        "                     into the local store, deduped per (session, turn)\n" +
        "                     with the same merge `crewhaus distill` uses —\n" +
        "                     closes the deployed-bot feedback transport gap\n" +
        "  --merge all        additive per-file copy: only files that don't\n" +
        "                     exist locally are written; existing files are\n" +
        "                     skipped (and reported)\n" +
        "\n" +
        "out of scope (by design): S3/R2 upload — sync the tarball with your\n" +
        "  own tooling (aws s3 cp, rclone, …); scheduled backups — pair with\n" +
        "  cron for now (a templates/ convention is landing separately).\n",
    );
    return;
  }

  if (action === "backup") {
    const excludeGlobs = parseExcludeGlobs(strFlag(args, "exclude"));
    const outFile = resolve(
      strFlag(args, "out") ?? defaultBackupFileName(stateBackupLabel(), new Date()),
    );
    try {
      const result = await createStateBackup({
        stateDir: join(process.cwd(), ".crewhaus"),
        outFile,
        excludeGlobs,
        crewhausVersion: cliVersion() ?? "unknown",
      });
      for (const w of result.warnings) process.stderr.write(`[state] warning: ${w}\n`);
      if (result.excluded.length > 0) {
        process.stdout.write(`[state] excluded ${result.excluded.length} file(s) via --exclude\n`);
      }
      const { totals } = result.manifest;
      process.stdout.write(
        `backed up ${totals.files} file(s) (${totals.bytes} bytes) → ${result.outFile}\n`,
      );
    } catch (err) {
      if (err instanceof StateBackupError) die(err.message);
      throw err;
    }
    return;
  }

  const archive = args.positional[0];
  if (typeof archive !== "string") die("missing <file.tar.gz>");
  const archiveFile = resolve(archive);
  const intoDir = strFlag(args, "into") ?? process.cwd();
  const merge = strFlag(args, "merge");
  const force = args.flags["force"] === true;
  if (merge !== undefined && force) {
    die("--merge and --force are mutually exclusive (merge is additive; force replaces)");
  }
  if (merge !== undefined && merge !== "feedback" && merge !== "all") {
    die(`invalid --merge "${merge}" — expected "feedback" or "all"`);
  }

  try {
    if (merge === "feedback") {
      const r = await mergeFeedbackFromArchive({ archiveFile, intoDir });
      process.stdout.write(
        `[state] ${r.archivedRecords} archived feedback record(s): ` +
          `${r.added} new, ${r.updated} updated fold(s), ${r.unchanged} already present (deduped)\n`,
      );
      if (r.wroteFile !== undefined) {
        process.stdout.write(`merged feedback → ${r.wroteFile}\n`);
      } else {
        process.stdout.write("nothing to merge — the local store already has it all\n");
      }
    } else if (merge === "all") {
      const r = await mergeAllFromArchive({ archiveFile, intoDir });
      for (const rel of r.skipped) {
        process.stdout.write(`[state] skipped ${rel} (exists locally — kept)\n`);
      }
      process.stdout.write(
        `merged ${r.copied.length} new file(s) into ${r.stateDir} ` +
          `(${r.skipped.length} existing file(s) kept)\n`,
      );
    } else {
      const r = await restoreStateArchive({ archiveFile, intoDir, force });
      for (const w of r.warnings) process.stderr.write(`[state] warning: ${w}\n`);
      if (r.movedAsideTo !== undefined) {
        process.stdout.write(`moved existing state aside → ${r.movedAsideTo}\n`);
      }
      process.stdout.write(`restored ${r.filesRestored} file(s) → ${r.stateDir}\n`);
    }
  } catch (err) {
    if (err instanceof StateBackupError) die(err.message);
    throw err;
  }
}

/**
 * Section 27 — `crewhaus secrets <action> <name> [opts]`. Two actions:
 *   doctor                 list configured secrets and report missing
 *   rotate <name>          rotate the named secret (file backend)
 */
async function runSecrets(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus secrets doctor [--backend env-var|file] [--root-dir <dir>]\n" +
        "  crewhaus secrets rotate <name> [--value <new-value>] [--backend ...]\n",
    );
    return;
  }
  const backendIdFlag = args.flags["backend"];
  const backendId = typeof backendIdFlag === "string" ? backendIdFlag : "env-var";
  const rootDirFlag = args.flags["root-dir"];
  const rootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "secrets");
  const { createSecrets, createEnvVarBackend, createFileBackend } = await import(
    "@crewhaus/secrets-manager"
  );
  // The `vault` backend exists in @crewhaus/secrets-manager but is not wired
  // into the CLI (it needs an address/auth story the CLI does not yet expose).
  // Fail loudly rather than silently degrading a security-sensitive flag to the
  // env-var backend — a silent fallback would, e.g., make `secrets doctor`
  // cheerfully list process env var names as if they were Vault secrets.
  let backend: ReturnType<typeof createFileBackend>;
  if (backendId === "env-var") {
    backend = createEnvVarBackend();
  } else if (backendId === "file") {
    backend = createFileBackend({ rootDir });
  } else if (backendId === "vault") {
    die(
      "vault backend is not wired into the CLI in this build — construct it programmatically via createVaultBackend(), or use --backend env-var|file",
    );
  } else {
    die(`unknown secrets backend "${backendId}" (expected: env-var | file)`);
  }
  const secrets = createSecrets({ backend });

  if (action === "doctor") {
    const known = (await backend.list?.()) ?? [];
    process.stdout.write(`backend: ${backend.id}\n`);
    process.stdout.write(`known: ${known.length} secret(s)\n`);
    for (const n of known) process.stdout.write(`  - ${n}\n`);
    return;
  }

  if (action === "rotate") {
    const name = args.positional[0];
    if (typeof name !== "string") die("missing <name>");
    const value = args.flags["value"];
    const newValue = await secrets.rotate(name, {
      ...(typeof value === "string" ? { newValue: value } : {}),
    });
    process.stdout.write(`rotated ${name} (${newValue.length} chars) via ${backend.id} backend\n`);
    return;
  }

  die(`unknown secrets action "${action}" (expected: doctor | rotate)`);
}

/**
 * Section 28 — `crewhaus spec <action> ...` subcommands wrap the
 * spec-registry. Actions: put / get / list / pin / alias / log (item 46 —
 * render the per-spec CHANGELOG.md that auto-registration and `put` keep
 * beside the registry manifest, newest entry first).
 */
async function runSpec(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus spec put <name> <version> <spec.yaml> [--root-dir <dir>]\n" +
        "  crewhaus spec list <name>                                   list versions\n" +
        "  crewhaus spec get <name> <version>                          print yaml\n" +
        "  crewhaus spec pin <name> <env> <version> [--tenant <id>]   pin env → version\n" +
        "  crewhaus spec alias <name> <env> [--tenant <id>]            resolve env → version\n" +
        "  crewhaus spec log <name> [--root-dir <dir>]                 print the changelog (newest first;\n" +
        '                                                              display names sanitize as on compile: "My Agent" → My-Agent)\n',
    );
    return;
  }
  const rootDirFlag = args.flags["root-dir"];
  const rootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "specs");
  const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
  const reg = createFileBackedRegistry({ rootDir });
  const tenantFlag = args.flags["tenant"];
  const tenantId = typeof tenantFlag === "string" ? tenantFlag : undefined;

  if (action === "put") {
    const name = args.positional[0];
    const version = args.positional[1];
    const filePath = args.positional[2];
    if (typeof name !== "string") die("missing <name>");
    if (typeof version !== "string") die("missing <version>");
    if (typeof filePath !== "string") die("missing <spec.yaml>");
    const yaml = readFileSync(resolve(filePath), "utf-8");
    // Item 46 — capture the previous latest version (manifest order) BEFORE
    // the put so the changelog entry carries a field-level diff against it.
    const { appendChangelogEntry } = await import("./spec-changelog");
    const prior = await reg.manifest(name);
    const prevVersion = prior.versions[prior.versions.length - 1];
    let previousYaml: string | undefined;
    if (prevVersion !== undefined) {
      try {
        previousYaml = await reg.get(name, prevVersion);
      } catch {
        // Manifest-listed version whose file vanished — entry is diff-less.
      }
    }
    await reg.put(name, version, yaml);
    appendChangelogEntry({
      registryRootDir: rootDir,
      name,
      version,
      yaml,
      ...(previousYaml !== undefined ? { previousYaml } : {}),
      optimizeRootDir: join(process.cwd(), ".crewhaus", "optimize"),
    });
    process.stdout.write(`stored ${name}@${version} (${yaml.length} bytes)\n`);
    return;
  }
  if (action === "log") {
    const rawName = args.positional[0];
    if (typeof rawName !== "string") die("missing <name>");
    // Item 46 (review F3): compile/write-back auto-registration stores under
    // the SANITIZED registry grammar (`registrySpecName("My Agent")` →
    // `My-Agent`), so the lookup must run the same sanitation or a display
    // name dies here while its changelog sits one transform away. Names
    // already in the registry grammar (every `spec put` name) pass through
    // unchanged.
    const { registrySpecName } = await import("./spec-changelog");
    const name = registrySpecName(rawName);
    if (name !== rawName) {
      process.stdout.write(`showing log for ${name} (sanitized from "${rawName}")\n`);
    }
    // Validate the name through the registry's own grammar (same floor as
    // put/get) so a crafted name can't path-traverse out of the root.
    try {
      await reg.manifest(name);
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    const changelogPath = join(rootDir, name, "CHANGELOG.md");
    if (!existsSync(changelogPath)) {
      die(
        `no changelog for "${name}" — nothing registered yet (compile the spec or \`crewhaus spec put\` first)`,
      );
    }
    process.stdout.write(readFileSync(changelogPath, "utf-8"));
    return;
  }
  if (action === "list") {
    const name = args.positional[0];
    if (typeof name !== "string") die("missing <name>");
    const versions = await reg.list(name);
    for (const v of versions) process.stdout.write(`${v}\n`);
    return;
  }
  if (action === "get") {
    const name = args.positional[0];
    const version = args.positional[1];
    if (typeof name !== "string") die("missing <name>");
    if (typeof version !== "string") die("missing <version>");
    process.stdout.write(await reg.get(name, version));
    return;
  }
  if (action === "pin") {
    const name = args.positional[0];
    const env = args.positional[1];
    const version = args.positional[2];
    if (typeof name !== "string") die("missing <name>");
    if (typeof env !== "string") die("missing <env>");
    if (typeof version !== "string") die("missing <version>");
    if (tenantId !== undefined) {
      await reg.pinForTenant(tenantId, name, env, version);
      process.stdout.write(`pinned tenant=${tenantId} ${name} ${env} → ${version}\n`);
    } else {
      await reg.pin(name, env, version);
      process.stdout.write(`pinned ${name} ${env} → ${version}\n`);
    }
    return;
  }
  if (action === "alias") {
    const name = args.positional[0];
    const env = args.positional[1];
    if (typeof name !== "string") die("missing <name>");
    if (typeof env !== "string") die("missing <env>");
    const v =
      tenantId !== undefined
        ? await reg.aliasForTenant(tenantId, name, env)
        : await reg.aliasFor(name, env);
    if (!v) die(`no pin for ${name} ${env}`);
    process.stdout.write(`${v}\n`);
    return;
  }
  die(`unknown spec action "${action}" (expected: put | list | get | pin | alias | log)`);
}

/**
 * Section 28 — `crewhaus deploy <action> ...` subcommands wrap the
 * deployment-controller. Actions: promote / rollback.
 */
async function runDeploy(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus deploy promote <name> <fromEnv> <toEnv>  copy env pin\n" +
        "  crewhaus deploy rollback <name> <env> <version>   re-pin env to version\n",
    );
    return;
  }
  const rootDirFlag = args.flags["root-dir"];
  const rootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "specs");
  const auditDir = join(process.cwd(), ".crewhaus", "audit");
  const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
  const { openAuditLog } = await import("@crewhaus/audit-log");
  const { createDeploymentController } = await import("@crewhaus/deployment-controller");
  const reg = createFileBackedRegistry({ rootDir });
  const audit = await openAuditLog({ rootDir: auditDir });
  const tenantFlag = args.flags["tenant"];
  const actorFlag = args.flags["actor"];
  const tenantId = typeof tenantFlag === "string" ? tenantFlag : undefined;
  const actor = typeof actorFlag === "string" ? actorFlag : undefined;
  const ctrl = createDeploymentController({
    registry: reg,
    auditLog: audit,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(actor !== undefined ? { actor } : {}),
  });

  if (action === "promote") {
    const name = args.positional[0];
    const fromEnv = args.positional[1];
    const toEnv = args.positional[2];
    if (typeof name !== "string") die("missing <name>");
    if (typeof fromEnv !== "string") die("missing <fromEnv>");
    if (typeof toEnv !== "string") die("missing <toEnv>");
    const rec = await ctrl.promote(name, fromEnv, toEnv);
    process.stdout.write(
      `promoted ${name} ${fromEnv} → ${toEnv} (now pinned to ${rec.toVersion})\n`,
    );
    return;
  }
  if (action === "rollback") {
    const name = args.positional[0];
    const env = args.positional[1];
    const version = args.positional[2];
    if (typeof name !== "string") die("missing <name>");
    if (typeof env !== "string") die("missing <env>");
    if (typeof version !== "string") die("missing <version>");
    const rec = await ctrl.rollback(name, env, version);
    process.stdout.write(
      `rolled back ${name} ${env} → ${version} (was ${rec.fromVersion ?? "unset"})\n`,
    );
    return;
  }
  die(`unknown deploy action "${action}" (expected: promote | rollback)`);
}

/**
 * Section 28 — `crewhaus migrate-all --from <ver> --to <ver> [--dry-run]`.
 * Walks every spec in the registry and applies the migration chain.
 */
async function runMigrateAll(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus migrate-all --from <ver> --to <ver> [--dry-run] [--root-dir <dir>]\n",
    );
    return;
  }
  const fromFlag = args.flags["from"];
  const toFlag = args.flags["to"];
  if (typeof fromFlag !== "string") die("missing --from <ver>");
  if (typeof toFlag !== "string") die("missing --to <ver>");
  const fromVersion = Number.parseInt(fromFlag, 10);
  const toVersion = Number.parseInt(toFlag, 10);
  if (Number.isNaN(fromVersion) || Number.isNaN(toVersion)) {
    die("--from / --to must be integers");
  }
  const rootDirFlag = args.flags["root-dir"];
  const rootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "specs");
  const dryRun = args.flags["dry-run"] === true;
  const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
  const { createDefaultEngine } = await import("@crewhaus/migration-engine");
  const { migrateAll } = await import("@crewhaus/migration-runner");
  const result = await migrateAll({
    registry: createFileBackedRegistry({ rootDir }),
    engine: createDefaultEngine(),
    fromVersion,
    toVersion,
    dryRun,
  });
  for (const item of result.plan) {
    const arrow = item.newVersion ? ` → ${item.newVersion}` : "";
    const err = item.error ? `   ERROR: ${item.error}` : "";
    process.stdout.write(
      `${item.action.padEnd(15)} ${item.name}@${item.latestVersion}${arrow}${err}\n`,
    );
  }
  const dryNote = dryRun ? " (dry-run)" : "";
  process.stdout.write(
    `[migrate-all] migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed}${dryNote}\n`,
  );
  if (result.failed > 0) process.exit(1);
}

/**
 * Section 32 — `crewhaus build-image <target> --tag <tag> [--platform <p>] [--push]`.
 * Wraps `docker buildx build` for the per-target Dockerfiles in
 * @crewhaus/docker-images.
 */
async function runBuildImage(rest: ReadonlyArray<string>): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: crewhaus build-image <target> --tag <tag> [--platform <p>] [--push]\n",
      );
      return;
    }
    if (a === "--push") {
      flags.set("push", true);
      continue;
    }
    if (a === "--tag" || a === "--platform") {
      const v = rest[i + 1];
      if (typeof v !== "string") die(`${a} requires a value`);
      flags.set(a.slice(2), v);
      i++;
      continue;
    }
    positional.push(a);
  }
  const target = positional[0];
  if (typeof target !== "string") die("missing <target> (one of cli, workflow, channel, ...)");
  const tag = flags.get("tag");
  if (typeof tag !== "string") die("missing --tag <tag>");
  const platform = flags.get("platform");
  const push = flags.get("push") === true;

  const { buildImage, isTargetShape } = await import("@crewhaus/docker-images");
  if (!isTargetShape(target)) {
    die(`unknown target shape: ${target}`);
  }
  try {
    const result = await buildImage({
      target,
      tag,
      platform: typeof platform === "string" ? platform : undefined,
      push,
    });
    process.stdout.write(`built crewhaus/${result.target}:${result.tag}\n`);
  } catch (err) {
    die(`build-image: ${(err as Error).message}`);
  }
}

/**
 * Section 32 — `crewhaus cloud deploy|teardown --provider <p> --region <r>`.
 * Composite recipe: terraform-up + helm-chart + kustomize overlay.
 */
async function runCloud(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      `usage: crewhaus cloud ${action} --provider <aws|gcp|azure|aws-localstack> --region <r> [--tier <dev|default|production>] [--image-tag <tag>]\n`,
    );
    return;
  }
  const provider = args.flags["provider"];
  const region = args.flags["region"];
  if (typeof provider !== "string") die("missing --provider");
  if (typeof region !== "string") die("missing --region");
  const tierFlag = args.flags["tier"];
  const imageTagFlag = args.flags["image-tag"];
  const workingDirFlag = args.flags["working-dir"];

  const cloudMod = await import("@crewhaus/crewhaus-cloud");
  if (!cloudMod.isCloudProvider(provider)) {
    die(`unknown provider: ${provider} (allowed: ${cloudMod.listProviders().join(", ")})`);
  }
  const config = {
    ...cloudMod.defaultCloudConfig(provider, region),
    ...(typeof tierFlag === "string" ? { tier: tierFlag as "dev" | "default" | "production" } : {}),
    ...(typeof imageTagFlag === "string" ? { imageTag: imageTagFlag } : {}),
  };

  if (action === "deploy") {
    const result = await cloudMod.deployCloud({
      config,
      workingDir: typeof workingDirFlag === "string" ? workingDirFlag : undefined,
    });
    process.stdout.write(`${cloudMod.summariseDeploy(result)}\n`);
    return;
  }
  if (action === "teardown") {
    await cloudMod.teardownCloud({
      config,
      workingDir: typeof workingDirFlag === "string" ? workingDirFlag : undefined,
    });
    process.stdout.write(`teardown complete for ${config.clusterName}\n`);
    return;
  }
  die(`unknown cloud action "${action}" (expected: deploy | teardown)`);
}

/**
 * Section 34 — `crewhaus federation discover <deployment> [--srv-domain <d>] [--format json|yaml]`.
 * Resolves a peer's endpoint + supportedShapes + publicKeyFingerprint via
 * .well-known/crewhaus.json, optionally seeded by a DNS SRV lookup.
 */
async function runFederation(rest: ReadonlyArray<string>): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: crewhaus federation discover <deployment> [--srv-domain <d>] [--format json|yaml]\n",
      );
      return;
    }
    if (a === "--srv-domain" || a === "--format") {
      const v = rest[i + 1];
      if (typeof v !== "string") die(`${a} requires a value`);
      flags.set(a.slice(2), v);
      i++;
      continue;
    }
    positional.push(a);
  }
  const deployment = positional[0];
  if (typeof deployment !== "string") die("missing <deployment>");
  const { discoverDeployment } = await import("@crewhaus/federation-discovery");
  try {
    const config: { srvDomain?: string } = {};
    const srv = flags.get("srv-domain");
    if (typeof srv === "string") config.srvDomain = srv;
    const record = await discoverDeployment(deployment, config);
    const format = flags.get("format") ?? "json";
    if (format === "yaml") {
      const yaml = [
        `endpoint: ${record.endpoint}`,
        `version: ${record.version}`,
        "supportedShapes:",
        ...record.supportedShapes.map((s) => `  - ${s}`),
        `publicKeyFingerprint: ${record.publicKeyFingerprint}`,
      ].join("\n");
      process.stdout.write(`${yaml}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    }
  } catch (err) {
    die(`federation discover: ${(err as Error).message}`);
  }
}

/**
 * Item 34 — `crewhaus audit verify` walks the hash-chained audit log at
 * `.crewhaus/audit` (the same store the `run` justification gate writes and
 * `compliance evidence` reads) via `@crewhaus/audit-log`'s `verify()`,
 * prints a per-check summary, and exits non-zero on any tamper finding.
 * `--anchor file:<path>` additionally cross-checks the chain tip against a
 * file-backed AnchorStore; a requested anchor that could NOT be consulted
 * also exits 1 (a scheduled tamper check must not silently skip its
 * strongest witness). Designed as a cron/CI tripwire.
 */
async function runAuditVerify(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus audit verify [--dir <auditDir>] [--anchor file:<path>]\n" +
        "  Walks every day file of the hash-chained audit log, verifying each\n" +
        "  record's hash, the prevHash links, the gapless seq run from 0, and\n" +
        "  the on-host _chain-tail.json anchor (tail-truncation detection).\n" +
        "  --dir <auditDir>       audit log root (default: ./.crewhaus/audit)\n" +
        "  --anchor file:<path>   also cross-check the append-only file anchor\n" +
        "                         store at <path> (mirror of the tail written\n" +
        "                         when the log was opened with a FileAnchorStore)\n" +
        "  Exit code: 0 intact; 1 on any tamper finding, or when a requested\n" +
        "  --anchor store held no anchor to cross-check.\n",
    );
    return;
  }
  const dirFlag = args.flags["dir"];
  const auditDir =
    typeof dirFlag === "string" ? resolve(dirFlag) : join(process.cwd(), ".crewhaus", "audit");

  let anchorChoice: AnchorFlagChoice | undefined;
  try {
    const anchorFlag = args.flags["anchor"];
    anchorChoice = resolveAnchorFlag(typeof anchorFlag === "string" ? anchorFlag : undefined);
  } catch (err) {
    if (err instanceof InvalidAnchorFlagError) die(err.message);
    throw err;
  }

  const auditLog = await import("@crewhaus/audit-log");
  // verify() defaults logId to the rootDir it is given; the CLI passes the
  // resolved absolute dir, matching openAuditLog's default logId for logs
  // opened at the same absolute root (e.g. the run path's justification sink).
  const result = await auditLog.verify(
    auditDir,
    anchorChoice !== undefined
      ? { anchorStore: new auditLog.FileAnchorStore(resolve(anchorChoice.path)) }
      : {},
  );

  process.stdout.write(`audit verify: ${auditDir}\n`);
  const summary = summarizeVerifyResult(result, {
    anchorRequested: anchorChoice !== undefined,
  });
  for (const line of summary.lines) {
    process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write(
    summary.exitCode === 0 ? "\naudit log intact.\n" : "\naudit verification FAILED.\n",
  );
  if (summary.exitCode !== 0) process.exit(1);
}

/**
 * Section 39 — `crewhaus compliance evidence` collects SOC 2 / ISO 27001 /
 * HIPAA evidence bundles by walking an audit-log root and writing signed
 * bundles to `.crewhaus/compliance/<framework>/<controlId>/<period>.json`.
 *
 * Usage:
 *   crewhaus compliance evidence --framework soc2 --period 2026-Q2 \
 *     [--control CC6.1] [--audit-dir <d>] [--out-dir <d>] \
 *     [--signing-key-env CREWHAUS_COMPLIANCE_SIGNING_KEY]
 *
 * Item 34 scheduling ergonomics: `--period current` resolves the current UTC
 * quarter and `--all-frameworks` loops every registered framework, so one
 * cron line can collect everything, every quarter. A control that collects 0
 * records is always REPORTED as an evidence gap; with `--fail-on-empty` it
 * also fails the run (exit 1) so a scheduled run trips loudly instead of
 * hiding the gap until audit time. The default stays exit 0 with a warning
 * (ops-review F4): bare `crewhaus compliance evidence ...` invocations are
 * documented externally and must not start failing on quiet periods.
 */
async function runCompliance(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus compliance evidence (--framework <id> | --all-frameworks)\n" +
        "    [--control <id>] --period <p>|current [--audit-dir <d>] [--out-dir <d>]\n" +
        "    [--signing-key-env <ENV>] [--fail-on-empty]\n" +
        '  --period current    resolve the current UTC quarter (e.g. "2026-Q3") so a\n' +
        "                      scheduled run never hardcodes a stale label\n" +
        "  --all-frameworks    collect every registered framework in one run\n" +
        "  --fail-on-empty     exit 1 when any control collected 0 records — the\n" +
        "                      tripwire for scheduled/cron runs. Default: exit 0 with\n" +
        "                      a warning naming each empty control (evidence gap)\n",
    );
    return;
  }
  if (action !== "evidence") {
    die(`unknown compliance action "${action}" (expected: evidence)`);
  }
  const frameworkFlag = args.flags["framework"];
  const allFrameworks = args.flags["all-frameworks"] === true;
  const controlFlag = args.flags["control"];
  const periodFlag = args.flags["period"];
  if (typeof frameworkFlag === "string" && allFrameworks) {
    die("--framework and --all-frameworks are mutually exclusive");
  }
  if (typeof frameworkFlag !== "string" && !allFrameworks) {
    die("--framework <id> is required (or pass --all-frameworks)");
  }
  if (allFrameworks && typeof controlFlag === "string") {
    die("--control is framework-specific — it cannot combine with --all-frameworks");
  }
  if (typeof periodFlag !== "string") {
    die('--period <p> is required (accepts "current" for the current UTC quarter)');
  }
  const period = resolvePeriodFlag(periodFlag);

  const auditDirFlag = args.flags["audit-dir"];
  const outDirFlag = args.flags["out-dir"];
  const auditDir =
    typeof auditDirFlag === "string" ? auditDirFlag : join(process.cwd(), ".crewhaus", "audit");
  const outDir =
    typeof outDirFlag === "string" ? outDirFlag : join(process.cwd(), ".crewhaus", "compliance");

  const signingKeyEnv = args.flags["signing-key-env"];
  const signingKey =
    typeof signingKeyEnv === "string" ? (process.env[signingKeyEnv] ?? undefined) : undefined;
  if (typeof signingKeyEnv === "string" && signingKey === undefined) {
    die(`signing key env var "${signingKeyEnv}" is not set`);
  }

  const { createComplianceCollector } = await import("@crewhaus/compliance-controls");
  const auditLog = await import("@crewhaus/audit-log");
  const auditSource = {
    async *read(): AsyncIterable<
      Awaited<ReturnType<typeof auditLog.openAuditLog>>["read"] extends () => AsyncIterable<infer T>
        ? T
        : never
    > {
      // Use the verify shape to walk every record without re-running hash chain
      // logic — auditLog.openAuditLog().read() is the supported public API.
      const log = await auditLog.openAuditLog({ rootDir: auditDir });
      for await (const r of log.read()) {
        yield r;
      }
    },
  };

  const collector = createComplianceCollector({ auditSource, outputDir: outDir });

  // --all-frameworks loops every framework the registered controls span (the
  // built-ins today: soc2, iso27001, hipaa — plus anything registered on top),
  // derived from the collector itself so the flag never drifts from the
  // package's actual coverage.
  const frameworks = allFrameworks
    ? [...new Set(collector.listControls().map((c) => c.frameworkId))].sort()
    : [frameworkFlag as string];

  const collectOpts = {
    period,
    ...(signingKey !== undefined ? { signingKey } : {}),
  };
  type EvidenceBundle = Awaited<ReturnType<typeof collector.collect>>;
  const bundles: EvidenceBundle[] = [];
  if (typeof controlFlag === "string") {
    // Mutual exclusion above guarantees exactly one framework here.
    bundles.push(await collector.collect(frameworks[0] as string, controlFlag, collectOpts));
  } else {
    for (const framework of frameworks) {
      bundles.push(...(await collector.collectAll(framework, collectOpts)));
    }
  }

  for (const b of bundles) {
    const path = collector.writeBundle(b);
    process.stdout.write(
      `${b.frameworkId}/${b.controlId} ${period}: ${b.recordCount} records → ${path}\n`,
    );
  }

  // Item 34 / ops-review F4 — the empty-evidence gate. A control that
  // collected 0 records is a gap an auditor cannot be shown evidence for, so
  // it is ALWAYS reported. `--fail-on-empty` (the scheduled/cron tripwire —
  // the shipped compliance-evidence.yml template passes it) turns the report
  // into exit 1 so the gap trips the schedule NOW instead of surfacing at
  // audit time; the bare-invocation default stays exit 0 with a warning, so
  // externally documented interactive usage keeps working. Bundles are still
  // written above either way (the non-empty ones remain valid evidence).
  const empty = findEmptyControls(bundles);
  if (empty.length > 0) {
    const gap = `evidence gap — ${empty.length} control(s) collected 0 records for ${period}: ${empty.join(", ")}`;
    if (args.flags["fail-on-empty"] === true) {
      die(`${gap} (--fail-on-empty)`);
    }
    process.stderr.write(
      `crewhaus: warning: ${gap} (pass --fail-on-empty to make this fail scheduled runs)\n`,
    );
  }
}

/**
 * Section 36 — `crewhaus sandbox <action>`. Single action today: `doctor`.
 *   doctor              list registered sandbox images + healthcheck status
 *
 * `--probe` runs each registered image's healthcheck argv via the configured
 * sandbox backend (docker / podman / noop). Without `--probe` the command
 * just snapshots the in-process registry — useful for verifying that the
 * polyglot images are wired up after a fresh `crewhaus install`.
 */
async function runSandbox(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" + "  crewhaus sandbox doctor [--probe] [--format json|table]\n",
    );
    return;
  }
  if (action !== "doctor") die(`unknown sandbox action "${action}" (expected: doctor)`);

  const formatFlag = args.flags["format"];
  const format = typeof formatFlag === "string" ? formatFlag : "table";
  if (format !== "json" && format !== "table") {
    die(`--format must be "json" or "table" (got "${format}")`);
  }
  const wantProbe = args.flags["probe"] === true;

  const reg = await import("@crewhaus/sandbox-image-registry");
  // Touch the registry so the §18 trio bootstraps.
  reg.listSandboxImages();

  let statuses = reg.snapshotImageStatuses();
  if (wantProbe) {
    const sandboxMod = await import("@crewhaus/sandbox");
    const sandbox = sandboxMod.createSandbox({
      allowedImages: reg.listAllowedImageRefs(),
    });
    statuses = await reg.runHealthchecks(async (entry) => {
      const result = await sandbox.exec({
        image: entry.image,
        argv: [...entry.healthcheck.command],
        timeoutMs: entry.healthcheck.timeoutMs ?? 5_000,
      });
      return { exitCode: result.exitCode, stderr: result.stderr };
    });
    await sandbox.close();
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
    return;
  }
  process.stdout.write("registered sandbox images:\n");
  const summaries = reg.listSandboxImages();
  const byId = new Map(statuses.map((s) => [s.id, s]));
  for (const e of summaries) {
    const s = byId.get(e.id);
    const mark = s?.healthy ? "✓" : wantProbe ? "✗" : "•";
    const tail = s?.healthy
      ? `last healthy ${s.lastHealthyAt}`
      : (s?.lastError ?? (wantProbe ? "no probe result" : "not yet probed"));
    process.stdout.write(`  ${mark} ${e.id.padEnd(10)} ${e.image.padEnd(28)} ${tail}\n`);
  }
}

/**
 * Item 35 — `crewhaus retention <action>`: scheduled GDPR/TTL enforcement
 * over a harness directory's two on-disk stores.
 *
 *   sweep  [--dry-run]        delete expired sessions (mtime-keyed, same rule
 *                             as session-store's list() eviction), honoring
 *                             `.crewhaus/retention.json` pins + audit windows.
 *   export <outDir> [--since] right-to-export: copy matching records out as
 *          [--dry-run]        raw files (originals untouched).
 *   purge  [--before <date>]  right-to-delete: same rules as sweep, restricted
 *          [--dry-run]        to records older than the cutoff.
 *
 * `--dry-run` is honored by EVERY action (ops-review F1): report-only, no
 * deletion, no files written, no audit evidence. Filter flags are per-action
 * (`--since` export-only, `--before` purge-only) and rejected — never
 * silently ignored — elsewhere.
 *
 * Audit data (`.crewhaus/audit`) is enumerated + exportable but NEVER deleted:
 * audit-log's verify() hash chain spans every day file, so deleting any record
 * or day file — even the oldest — breaks tamper verification of everything
 * after it (see retention.ts, HarnessRecordStore.delete). Real (non-dry-run)
 * runs append a `retention_enforcement` record to `.crewhaus/audit`, so
 * enforcement itself is tamper-evidenced. Designed as a cron target; the
 * heavy lifting lives in retention.ts so a daemon janitor can call it too.
 */
async function runRetention(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus retention sweep [--dry-run] [--dir <root>]\n" +
        "  crewhaus retention export <outDir> [--since <date>] [--dry-run] [--dir <root>]\n" +
        "  crewhaus retention purge [--before <date>] [--dry-run] [--dir <root>]\n" +
        "  Enforces .crewhaus/retention.json over the harness stores:\n" +
        "    sessions (.crewhaus/sessions)  expire by file mtime after sessions.maxAgeDays\n" +
        "                                   (default 30, session-store's TTL); pinned ids survive\n" +
        "    audit (.crewhaus/audit)        NEVER deleted — verify()'s hash chain spans every\n" +
        "                                   day file, so any deletion breaks tamper verification.\n" +
        "                                   Export-only.\n" +
        "  Active auditWindows in the config defer ALL deletion. Real runs append a\n" +
        "  retention_enforcement record to .crewhaus/audit; --dry-run appends nothing.\n" +
        "  --dry-run          report what the action would do; touch nothing on disk\n" +
        "                     (sweep/purge: delete nothing; export: write nothing)\n" +
        "  --dir <root>       harness root directory (default: cwd)\n" +
        "  --since <date>     export only: records at/after this ISO date\n" +
        "  --before <date>    purge only: records older than this ISO date\n" +
        "  A flag on an action that does not support it is an error, never silently\n" +
        "  ignored (--since is export-only; --before is purge-only).\n",
    );
    return;
  }
  const dirFlag = args.flags["dir"];
  const rootDir = typeof dirFlag === "string" ? resolve(dirFlag) : process.cwd();
  const dryRun = args.flags["dry-run"] === true;
  const sinceFlag = args.flags["since"];
  const beforeFlag = args.flags["before"];
  // Ops-review F1: an accepted-and-ignored filter flag is a trap — an
  // operator who typed `sweep --before <date>` believed they bounded the
  // deletion set. Unsupported combos are rejected per action.
  if (typeof sinceFlag === "string" && action !== "export") {
    die(
      `--since is not supported by "retention ${action}" — it filters exports only (use "retention purge --before <date>" to bound deletion)`,
    );
  }
  if (typeof beforeFlag === "string" && action !== "purge") {
    die(
      `--before is not supported by "retention ${action}" — it bounds purges only (use "retention export --since <date>" to filter an export)`,
    );
  }
  try {
    if (action === "sweep") {
      const report = await runRetentionSweep({ rootDir, dryRun });
      process.stdout.write(`retention sweep: ${rootDir}${dryRun ? " (dry run)" : ""}\n`);
      for (const line of formatEnforcementReport(report)) {
        process.stdout.write(`  ${line}\n`);
      }
      return;
    }
    if (action === "export") {
      const outDir = args.positional[0];
      if (typeof outDir !== "string") die("missing <outDir>");
      const since =
        typeof sinceFlag === "string" ? parseRetentionDate("--since", sinceFlag) : undefined;
      const report = await runRetentionExport({
        rootDir,
        outDir,
        dryRun,
        ...(since !== undefined ? { since } : {}),
      });
      process.stdout.write(
        `retention export: ${rootDir} → ${report.outDir}${dryRun ? " (dry run)" : ""}\n`,
      );
      for (const line of formatExportReport(report)) {
        process.stdout.write(`  ${line}\n`);
      }
      return;
    }
    // Dispatch guarantees: action === "purge".
    const before =
      typeof beforeFlag === "string" ? parseRetentionDate("--before", beforeFlag) : undefined;
    const report = await runRetentionPurge({
      rootDir,
      dryRun,
      ...(before !== undefined ? { before } : {}),
    });
    process.stdout.write(`retention purge: ${rootDir}${dryRun ? " (dry run)" : ""}\n`);
    for (const line of formatEnforcementReport(report)) {
      process.stdout.write(`  ${line}\n`);
    }
  } catch (err) {
    if (err instanceof RetentionConfigError || err instanceof InvalidRetentionDateError) {
      die(err.message);
    }
    throw err;
  }
}

/**
 * Item 48 — `crewhaus security digest [--since 7d|30d|<ISO>] [--format
 * text|json|html] [-o <dir>] [--notify <url>] [--dir <root>]`. Walks the
 * cwd (or --dir) harness's `.crewhaus/audit` + `.crewhaus/sessions` stores
 * and emits a ranked warn/deny rollup: top justification-denied tools (with
 * judge identity + confidence), judge deny rate, policy-engine denials,
 * injection rule-id hits (from session redaction notices), and — the day a
 * writer lands for the declared-but-writerless `egress_decision` kind — top
 * warn/block egress sinks + origins. See security-digest.ts for exactly
 * which audit kinds have writers today and the design decisions (local HTML
 * helper, plain-fetch notify).
 *
 * The digest is a report, not a gate: it exits 0 even when the window is
 * full of denials. The one loud failure is `--notify` — a scheduled digest
 * whose notification silently failed would fabricate assurance, so a
 * non-2xx/unreachable webhook exits 1.
 */
async function runSecurityDigest(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus security digest [--since 7d|30d|<ISO>] [--format text|json|html]\n" +
        "                                [-o <dir>] [--notify <url>] [--dir <root>]\n" +
        "  --since <w>     rollup window: a trailing day window (7d default, e.g. 30d)\n" +
        "                  or an ISO date/datetime lower bound\n" +
        "  --format <f>    text (default), json (the machine shape --notify POSTs),\n" +
        "                  or html (self-contained page, eval-report styling)\n" +
        "  -o <dir>        write security-digest.<ext> into <dir> instead of stdout\n" +
        "  --notify <url>  POST the JSON digest to a webhook (plain fetch; Slack\n" +
        "                  incoming webhooks need a { text } wrapper — front one with\n" +
        "                  a proxy that forwards { text: <rendered text> })\n" +
        "  --dir <root>    harness root that owns .crewhaus/ (default: cwd)\n",
    );
    return;
  }
  const formatFlag = args.flags["format"];
  const format = typeof formatFlag === "string" ? formatFlag : "text";
  if (format !== "text" && format !== "json" && format !== "html") {
    die(`--format must be "text", "json" or "html" (got "${format}")`);
  }
  const dirFlag = args.flags["dir"];
  const rootDir = typeof dirFlag === "string" ? resolve(dirFlag) : process.cwd();
  const sinceFlag = args.flags["since"];

  let digest: ReturnType<typeof buildSecurityDigest>;
  try {
    const window = parseSinceFlag(typeof sinceFlag === "string" ? sinceFlag : undefined);
    digest = buildSecurityDigest({ rootDir, window });
  } catch (err) {
    if (err instanceof InvalidSinceFlagError) die(err.message);
    throw err;
  }

  const rendered =
    format === "json"
      ? `${JSON.stringify(digest, null, 2)}\n`
      : format === "html"
        ? renderSecurityDigestHtml(digest)
        : `security digest: ${rootDir}\n${renderSecurityDigestText(digest)
            .map((l) => `  ${l}`)
            .join("\n")}\n`;

  const outFlag = args.flags["out"];
  if (typeof outFlag === "string") {
    const outDir = resolve(outFlag);
    mkdirSync(outDir, { recursive: true });
    const ext = format === "text" ? "txt" : format;
    const outPath = join(outDir, `security-digest.${ext}`);
    writeFileSync(outPath, rendered);
    process.stdout.write(`wrote ${outPath}\n`);
  } else {
    process.stdout.write(rendered);
  }

  const notifyFlag = args.flags["notify"];
  if (typeof notifyFlag === "string") {
    try {
      await notifySecurityDigest(notifyFlag, digest);
      process.stdout.write(`notified ${notifyFlag}\n`);
    } catch (err) {
      if (err instanceof NotifyError) die(err.message);
      throw err;
    }
  }
}

const argv = process.argv.slice(2);
const subcommand = argv[0] ?? "";
const rest = argv.slice(1);

switch (subcommand) {
  case "compile":
    await runCompile(parseFor(rest, COMPILE_SCHEMA));
    break;
  case "init":
    runInit(parseFor(rest, INIT_SCHEMA));
    break;
  case "run":
    // Mirror runCompile's policy: every structured failure in the run
    // pipeline (ConfigError from the model-router, ProviderAuthError from
    // an adapter, RuntimeError, …) extends CrewhausError — route the
    // family through die() for a clean one-line error + exit 1 instead of
    // a raw stack trace. A non-CrewhausError (a genuine bug) still
    // propagates with its full stack for debugging.
    try {
      await runRun(parseFor(rest, RUN_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "eval":
    await runEvalSubcommand(parseFor(rest, EVAL_SCHEMA));
    break;
  case "eval-report":
    await runEvalReport(parseFor(rest, EVAL_REPORT_SCHEMA));
    break;
  case "optimize":
    await runOptimize(parseFor(rest, OPTIMIZE_SCHEMA));
    break;
  case "doctor":
    await runDoctor(parseFor(rest, DOCTOR_SCHEMA));
    break;
  case "context":
    runContext(parseFor(rest, CONTEXT_SCHEMA));
    break;
  case "cost-summary":
    await runCostSummary(parseFor(rest, COST_SUMMARY_SCHEMA));
    break;
  case "rate":
    await runRate(parseFor(rest, RATE_SCHEMA));
    break;
  case "feedback":
    await runFeedbackCmd(parseFor(rest, FEEDBACK_SCHEMA));
    break;
  case "distill":
    await runDistill(parseFor(rest, DISTILL_SCHEMA));
    break;
  case "state": {
    const action = rest[0] ?? "";
    if (action !== "backup" && action !== "restore") {
      die(`state action must be "backup" or "restore" (got "${action}")`);
    }
    await runState(parseFor(rest.slice(1), STATE_SCHEMA), action);
    break;
  }
  case "secrets": {
    const action = rest[0] ?? "";
    if (action !== "doctor" && action !== "rotate") {
      die(`secrets action must be "doctor" or "rotate" (got "${action}")`);
    }
    await runSecrets(parseFor(rest.slice(1), SECRETS_SCHEMA), action);
    break;
  }
  case "spec": {
    const action = rest[0] ?? "";
    if (!["put", "list", "get", "pin", "alias", "log"].includes(action)) {
      die(`spec action must be one of: put, list, get, pin, alias, log (got "${action}")`);
    }
    await runSpec(parseFor(rest.slice(1), SPEC_SCHEMA), action);
    break;
  }
  case "deploy": {
    const action = rest[0] ?? "";
    if (action !== "promote" && action !== "rollback") {
      die(`deploy action must be "promote" or "rollback" (got "${action}")`);
    }
    await runDeploy(parseFor(rest.slice(1), DEPLOY_SCHEMA), action);
    break;
  }
  case "migrate-all":
    await runMigrateAll(parseFor(rest, MIGRATE_SCHEMA));
    break;
  case "build-image":
    await runBuildImage(rest);
    break;
  case "cloud": {
    const action = rest[0] ?? "";
    if (action !== "deploy" && action !== "teardown") {
      die(`cloud action must be "deploy" or "teardown" (got "${action}")`);
    }
    await runCloud(parseFor(rest.slice(1), CLOUD_SCHEMA), action);
    break;
  }
  case "federation": {
    const action = rest[0] ?? "";
    if (action !== "discover") {
      die(`federation action must be "discover" (got "${action}")`);
    }
    await runFederation(rest.slice(1));
    break;
  }
  case "sandbox": {
    const action = rest[0] ?? "";
    if (action !== "doctor") {
      die(`sandbox action must be "doctor" (got "${action}")`);
    }
    await runSandbox(parseFor(rest.slice(1), SANDBOX_SCHEMA), action);
    break;
  }
  case "compliance": {
    const action = rest[0] ?? "";
    if (action !== "evidence") {
      die(`compliance action must be "evidence" (got "${action}")`);
    }
    await runCompliance(parseFor(rest.slice(1), COMPLIANCE_SCHEMA), action);
    break;
  }
  case "audit": {
    const action = rest[0] ?? "";
    if (action !== "verify") {
      die(`audit action must be "verify" (got "${action}")`);
    }
    await runAuditVerify(parseFor(rest.slice(1), AUDIT_SCHEMA));
    break;
  }
  case "retention": {
    const action = rest[0] ?? "";
    if (action !== "sweep" && action !== "export" && action !== "purge") {
      die(`retention action must be one of: sweep, export, purge (got "${action}")`);
    }
    await runRetention(parseFor(rest.slice(1), RETENTION_SCHEMA), action);
    break;
  }
  case "security": {
    const action = rest[0] ?? "";
    if (action !== "digest") {
      die(`security action must be "digest" (got "${action}")`);
    }
    await runSecurityDigest(parseFor(rest.slice(1), SECURITY_SCHEMA));
    break;
  }
  case "version":
  case "-v":
  case "--version":
    printVersion();
    break;
  case "-h":
  case "--help":
    help();
    break;
  case "":
    usage();
    break;
  default:
    die(`unknown subcommand: ${subcommand}`);
}
