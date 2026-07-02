#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";
import { SpecParseError, compile, lower } from "@crewhaus/compiler";
import { buildContextBundle, discoverRoots } from "@crewhaus/context-bundle";
import { DEFAULT_PRICING, computeCacheSavingsMicros, resolvePricing } from "@crewhaus/cost-tracker";
import {
  type DatasetRecord,
  type DatasetSplit,
  compareVersions,
  createFileBackedRegistry,
  latestVersion,
} from "@crewhaus/dataset-registry";
import { CrewhausError } from "@crewhaus/errors";
import { type Sample, loadDataset } from "@crewhaus/eval-dataset";
import { type CompiledGrader, parseGradersConfig } from "@crewhaus/eval-grader";
import { optimizeSpec } from "@crewhaus/eval-optimizer-orchestrator";
import {
  type RunIndexEntry,
  buildMatrix,
  diffReports,
  formatUsd,
  hashDatasetFile,
  loadRun,
  readBaselines,
  readRunIndex,
  renderMatrix,
  renderReport,
  setBaseline,
} from "@crewhaus/eval-report";
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
import { type Spec, parseSpec } from "@crewhaus/spec";
import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { registerMcpServer } from "@crewhaus/tool-mcp";
import { createTaskTool } from "@crewhaus/tool-task";
import { type CostAccrualEvent, type ProviderId, TraceEventBus } from "@crewhaus/trace-event-bus";
// Item 15 — `optimize --from-advice` (eval-gated apply of the advisor's
// SpecPatches: suggestions-file validation, the accept/reject/compose loop
// with injected compile/eval hooks, decisions.json + write-back stamping),
// in a side-effect-free module so it is unit-testable (this entry file runs
// an argv switch on import).
import {
  AdviceApplyError,
  type AdvicePatchDecision,
  type ParsedAdvicePatch,
  applyAdvicePatches,
  assertFromAdviceFlagsCompatible,
  buildAdviceDecisionsFile,
  formatAdviceDecisionLine,
  parseSuggestionsFile,
  stampAdviceWriteBack,
} from "./advice-apply";
// Item 14 — `crewhaus advise` rule library (session-JSONL aggregation +
// threshold rules + suggestions.json/report.html builders), in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import).
import {
  type AdviceFinding,
  type SessionEvents,
  buildAdviceContext,
  buildSuggestionsFile,
  formatFindingLines,
  parseJsonlObjects as parseAdviseJsonl,
  renderAdviceHtml,
  runAdviceRules,
} from "./advise-rules";
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
// Item 1 — the feedback.autoDistill consumer (watermarked ratings →
// versioned `<spec>-ratings` registry datasets at run teardown) and the
// REPL exit-rating gating logic, in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import {
  DISTILL_STATE_RELPATH,
  EXIT_RATING_PROMPT,
  EXIT_RATING_TIMEOUT_MS,
  countAssistantTurns,
  maybeAutoDistill,
  parseExitRatingKey,
  shouldPromptExitRating,
} from "./autodistill";
// Item 61 — `crewhaus channel provision|verify` core (adapter-derived Slack
// manifest, Telegram setWebhook, Discord interactions-endpoint registration,
// doctor-style scope/webhook probes), in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import {
  ChannelApiError,
  type ChannelCheck,
  InvalidBaseUrlError,
  InvalidPlatformFlagError,
  SLACK_MANIFEST_FILENAME,
  buildDiscordProvision,
  buildSlackManifest,
  buildTelegramProvision,
  describeVerifyProbes,
  discordNextSteps,
  joinBaseUrl,
  performDiscordProvision,
  performTelegramSetWebhook,
  renderSlackManifestYaml,
  resolvePlatformsFlag,
  slackNextSteps,
  summarizeChannelChecks,
  verifyDiscordChannel,
  verifySlackChannel,
  verifyTelegramChannel,
} from "./channel-provision";
// Item 44 — `crewhaus init --ci`: the eval-on-PR CI gate scaffold
// (.github/workflows/crewhaus-eval.yml — two fresh runs diffed via the
// item-3 baseline machinery + `eval --gate`), in a side-effect-free module
// so it is unit-testable (this entry file runs an argv switch on import).
import { EVAL_CI_WORKFLOW_RELPATH, buildEvalCiWorkflowYaml } from "./ci-scaffold";
// Item 34 — scheduling ergonomics for `compliance evidence` (--period current
// resolution + the empty-evidence gate), side-effect-free for the same reason.
import { findEmptyControls, resolvePeriodFlag } from "./compliance-schedule";
// Item 17 (completion) — `doctor --context-pressure` (fold persisted
// recovery/compaction events into the pressure report + command hints), in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import).
import {
  DEFAULT_CONTEXT_PRESSURE_SESSIONS,
  buildContextPressureReport,
  formatContextPressureLines,
} from "./context-pressure";
// Item 12 — dataset-registry CLI plumbing (the `datasets` subcommand family,
// `distill --register` promotion, and the `--dataset registry:` shorthand
// shared by eval + optimize), in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import {
  DEFAULT_SPLIT_SPEC,
  DatasetRefError,
  defaultDatasetsRoot,
  isDatasetSplit,
  parseNameVersion,
  parseRegistryRef,
  parseSplitSpec,
  recordToJsonl,
  registerDataset,
  resolveRegistryRef,
} from "./datasets";
// Model-aware doctor credential checks (provider parsed from the cwd spec's
// agent.model via the model-router grammar), in a side-effect-free module so
// it is unit-testable (this entry file runs an argv switch on import).
// Item 61 added the channel-target env check (only fires when the cwd spec
// lowers to a channel IR).
import { buildChannelEnvChecks, buildCredentialChecks, extractSpecModel } from "./doctor-checks";
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
// Run-history item 3 — post-eval index append + baseline diff/gate/promote,
// in a side-effect-free module so it is unit-testable (this entry file runs
// an argv switch on import).
import { datasetFilterMatches, finishEvalRun } from "./eval-history";
// Item 11 — `eval --models` benchmark matrix: flag parsing/validation, cell
// slugs, the failure-isolated cell loop, and the cost-tracker pricing seam,
// in a side-effect-free module so it is unit-testable (this entry file runs
// an argv switch on import).
import {
  MatrixArgError,
  assertMatrixFlagsCompatible,
  assignCellSlugs,
  defaultMatrixPricing,
  parseModelsFlag,
  runMatrixCells,
} from "./eval-matrix";
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
// Item 45 — `crewhaus flywheel init|run`: the packaged nightly
// self-improvement loop (knob/default resolution, the accept-then-write
// loop with injected steps, the report, and the workflow scaffold), in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import).
import {
  CONVENTIONAL_DATASET,
  CONVENTIONAL_GRADERS,
  FLYWHEEL_WORKFLOW_RELPATH,
  FlywheelConfigError,
  type FlywheelDataResolution,
  type FlywheelKnobs,
  type FlywheelOptimizeOutcome,
  buildFlywheelWorkflowYaml,
  formatFlywheelKnobsGuide,
  formatFlywheelReport,
  resolveFlywheelData,
  resolveFlywheelKnobs,
  runFlywheelLoop,
  scaffoldWorkflowFile,
  specIsDirty,
} from "./flywheel";
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
// Item 9 — per-spec regression suite: post-accept pinning of optimize
// recoveries + the eval-side default union, in a side-effect-free module so
// it is unit-testable (this entry file runs an argv switch on import).
import {
  applyRegressionUnionGuarded,
  isRegistrySafeName,
  pinRecoveriesAfterOptimize,
} from "./regression-pin";
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
// Item 18 — `crewhaus tools` namespace (list/suggest/audit + the loadToolMap
// ↔ BUILTIN_TOOL_MAP sync floor), in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import {
  CLI_RUNTIME_TOOL_KEYS,
  auditTools,
  buildToolList,
  buildToolUsage,
  formatAuditLines,
  formatSuggestLines,
  formatToolListLines,
  suggestTools,
} from "./tools-cli";
// Item 7 — failure-arbiter wiring: post-eval triage (verdicts.json + report
// section + one-line summary + bug-sample pinning) and the optimize-side
// failure-signal pre-filter, in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import {
  finishEvalTriage,
  formatDatasetFixQueue,
  formatFitnessTriageLine,
  tapSamples,
  triageFitnessSamples,
} from "./triage";
// CLI version resolution (embedded --define constant → package.json), shared
// with compile-check.ts's dependency pinning.
import { cliVersion } from "./version";

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
    // Item 33 — post-compile verification of the just-emitted bundle
    // (shape assertion → bun install → credential-free liveness boot).
    // See compile-check.ts; wired at the very end of the compile path.
    { name: "check", takesValue: false },
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
  flags: [
    // Item 44 — also scaffold the eval-on-PR CI workflow. Composable with
    // an existing harness: `init --ci` in a dir that already has a
    // crewhaus.yaml adds just the workflow.
    { name: "ci", takesValue: false },
    // Overwrite an existing scaffolded workflow (never the spec).
    { name: "force", takesValue: false },
    { name: "help", short: "h" },
  ],
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
    // Item 17 — context-pressure report over recent sessions (truncation
    // recoveries, compaction fires, snip-vs-autocompact, spec knobs +
    // advise/optimize command hints). Report, not gate: exit 0 always.
    { name: "context-pressure", takesValue: false },
    // How many most-recent sessions --context-pressure scans (default 20).
    { name: "sessions", takesValue: true },
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
    // Item 15 — apply `crewhaus advise` SpecPatches (suggestions.json) via
    // the eval-gated accept/reject/compose loop instead of running the
    // mutation search. Mutually exclusive with --mutator/--iterations;
    // --dataset/--graders/--ratings still resolve as usual (the apply path
    // needs an eval).
    { name: "from-advice", takesValue: true },
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
    // Item 9 — skip pinning an accepted patch's fail→pass recoveries into
    // the per-spec `<specName>-regressions` registry dataset.
    { name: "no-pin-regressions", takesValue: false },
    // Item 7 — opt out of the runner's default one-shot retry of ERRORED
    // samples inside each candidate's fitness eval (mirrors `eval --no-retry`).
    { name: "no-retry", takesValue: false },
    // Item 46 — after a successful --write-back the working spec changed, so
    // the same auto-register + changelog flow as `compile` runs; this is the
    // explicit opt-out (mirrors `compile --no-register`).
    { name: "no-register", takesValue: false },
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 45 — `crewhaus flywheel run|init`. Knobs mirror the demo's
// FLYWHEEL_* env names (flag > env > default — see ./flywheel.ts).
const FLYWHEEL_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "budget-usd", takesValue: true },
    { name: "iterations", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "mutator", takesValue: true },
    // Run the whole loop (evals + optimize + acceptance gate) but never
    // write the spec, register, or pin — a rehearsal run.
    { name: "dry-run", takesValue: false },
    // Invariant: the flywheel refuses to run over uncommitted spec changes
    // (a rejected write-back could not be told apart from the user's own
    // edits). This is the explicit opt-out.
    { name: "allow-dirty", takesValue: false },
    // `flywheel init` — overwrite an existing workflow scaffold.
    { name: "force", takesValue: false },
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
    // Item 11 — benchmark matrix: run the same dataset+graders once per
    // model; each cell writes to <out>/<model-slug>/. Incompatible with
    // --gate/--no-promote (cells skip the run-history lineage entirely).
    { name: "models", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // Run-history item 3 — exit non-zero when the run regresses against the
    // pinned (spec, dataset) baseline (regression-runner gate, strict
    // defaults: any pass-rate drop or sample-level pass→fail flip fails).
    { name: "gate", takesValue: false },
    // Run-history item 3 — keep the existing baseline pin instead of
    // auto-promoting this run on gate pass (also skips the first-run pin).
    { name: "no-promote", takesValue: false },
    // Item 9 — skip the default union of the per-spec
    // `<specName>-regressions` registry dataset into the loaded dataset.
    // Item 7 — ALSO skips the failure-arbiter's bug-sample pin into that
    // suite (opting out of regression-suite integration means no writes
    // to it either).
    { name: "no-regressions", takesValue: false },
    // Item 7 — opt out of the runner's default one-shot retry of ERRORED
    // samples (infra noise, not graded failures).
    { name: "no-retry", takesValue: false },
    { name: "help", short: "h" },
  ],
};

const EVAL_REPORT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    // `history` / `baseline show` filters.
    { name: "spec", takesValue: true },
    { name: "dataset", takesValue: true },
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

const ADVISE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "all" },
    { name: "json" },
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const TOOLS_SCHEMA: ParseArgsSchema = {
  flags: [{ name: "sessions", takesValue: true }, { name: "json" }, { name: "help", short: "h" }],
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
    // Item 12 — promote the distilled samples into the dataset registry as a
    // new auto-bumped version of <name> (deterministic 70/15/15
    // train/dev/test split), consumable as `--dataset registry:<name>`.
    // -o becomes optional when given; plain file output stays the default.
    { name: "register", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 12 — the dataset-registry CLI face (`datasets list|get|put`).
const DATASETS_SCHEMA: ParseArgsSchema = {
  flags: [
    // `put` — the file to import (any @crewhaus/eval-dataset format).
    { name: "file", takesValue: true },
    // `get` — print one split verbatim instead of the all-splits merge.
    // `put` — import everything into this single named split.
    { name: "split", takesValue: true },
    // `put` — train/dev[/test] percentages for the deterministic split.
    { name: "split-spec", takesValue: true },
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

const CHANNEL_SCHEMA: ParseArgsSchema = {
  flags: [
    // Item 61 — `channel provision|verify` platform selection + daemon origin.
    { name: "platform", takesValue: true },
    { name: "base-url", takesValue: true },
    // provision only: directory the Slack manifest YAML is written into.
    { name: "out", short: "o", takesValue: true },
    // print every network call (redacted) without performing it.
    { name: "dry-run", takesValue: false },
    // provision (discord) only: overwrite a DIFFERENT pre-existing
    // interactions_endpoint_url — read-before-write refuses without it
    // (mirrors `state restore --force`).
    { name: "force", takesValue: false },
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
    { name: "no-record" },
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
    "                  [--check]            verify the emitted bundle (shape assertion + install + liveness boot)",
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
    "       [--judge-model <model>] [--concurrency N] [--seed N] [-o <out-dir>]",
    "       [--gate]                       exit non-zero on regression vs the pinned baseline",
    "       [--no-promote]                 keep the existing baseline pin after this run",
    "       [--models <m1,m2,...>]         benchmark matrix: run the dataset once per model",
    "                                      (cells write to <out>/<model-slug>/; emits matrix.json",
    "                                      + index.html; incompatible with --gate/--no-promote)",
    "       --dataset also accepts registry:<name>[@version][#split] (Section 29 registry)",
    "  eval-report diff <prev> <new>        compare two eval runs and emit a diff report",
    "       [-o <out-dir>]",
    "  eval-report history                  list recorded runs (.crewhaus/evals/index.jsonl)",
    "       [--spec <name>] [--dataset <name>]",
    "  eval-report baseline show            print pinned baselines (.crewhaus/evals/baselines.json)",
    "       [--spec <name>] [--dataset <name>]",
    "  eval-report baseline set <runId>     pin a recorded run as its (spec, dataset) baseline",
    "  optimize <spec.yaml> --dataset <data> --graders <graders.yaml>",
    "       (--dataset also accepts registry:<name>[@version][#split])",
    "       [--mutator rule-based|claude] [--iterations N] [--seed N]",
    "       [--ratings <session>|all]            distill user ratings into the training set (Pillar 2)",
    "       [--budget-usd N]                     stop a model-driven run before it exceeds $N (FR-003)",
    "       [--write-back] [-o <out-dir>]        active eval-driven optimization (Pillar 2)",
    "  flywheel run [spec.yaml]             the nightly self-improvement loop, one command (item 45):",
    "       compile gate → baseline eval → optimize → after eval → acceptance",
    "       gate (pass_rate strictly up AND zero regressions) → write-back on",
    "       accept; a rejected patch never touches the spec.",
    "       [--dataset <data>] [--graders <g.yaml>] [--budget-usd N] [--iterations N]",
    "       [--seed N] [--concurrency N] [--mutator rule-based|claude]",
    "       [--dry-run] [--allow-dirty]",
    "  flywheel init [--force]              scaffold .github/workflows/crewhaus-flywheel.yml",
    "       (nightly cron + manual dispatch; accepted improvements arrive as",
    "       PRs for human review — never auto-merged)",
    "  init [name]                          scaffold a new crewhaus.yaml",
    "       [--ci]                          also scaffold .github/workflows/crewhaus-eval.yml —",
    "                                       eval-gated spec PRs (base vs PR spec, two fresh runs,",
    "                                       score-delta PR comment, check fails on regression);",
    "                                       with an existing crewhaus.yaml, adds just the workflow",
    "       [--force]                       overwrite an existing scaffolded workflow",
    "  doctor                               check environment health",
    "       [--philosophy-alignment [--json] [--baseline | --accept-baseline]]  pillar audit + scope-audit drift gate (item 49)",
    "  context --bundle [-o <file>]         emit a single-markdown orientation manifest",
    "       [--factory-root <p>] [--docs-root <p>] [--demos-root <p>]",
    "  cost-summary --session <id>          summarize cost_accrual events for a session",
    "  advise [--session <id> | --all]      mine session logs for spec advice (item 14)",
    "       [--json] [-o <dir>]             writes suggestions.json + report.html (default .crewhaus/advice)",
    "  tools list                           list every builtin tool + its metadata (item 18)",
    "  tools suggest [spec.yaml]            rank builtins against agent.instructions (keyword match)",
    "  tools audit [--sessions N|all]       mine tool_stats vs. grants — unused/failing/readOnly",
    "  rate --session <id> [--turn N]       rate an assistant turn 👍/👎, ⭐, or 0–1",
    "       (--thumbs up|down | --stars 1-5 | --score 0-1) [--comment <t>]",
    "  feedback --session <id> --text <msg> attach a comment/correction to a turn",
    "       [--turn N] [--correction <better answer>]",
    "  distill --session <id> -o <ds.jsonl> turn ratings into an eval dataset + graders",
    "       [--all-sessions] [--graders-out <g.yaml>] [--min-score F]",
    "       [--register <name>]            also promote a new dataset version into the registry",
    "  datasets list                        all registered datasets + versions (Section 29)",
    "  datasets get <name>[@version]        print a dataset's samples as JSONL",
    "       [--split train|dev|test]",
    "  datasets put <name> --file <f.jsonl> import a file as a new auto-bumped version",
    "       [--split-spec 70/15/15 | --split train]",
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
    "       [--platform <p>] [--push]        (--push records the registry manifest digest in",
    "       [--no-record]                     docker/digests.json; --no-record opts out. Local",
    "                                         --load builds record nothing — not pullable)",
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
    "  channel provision <spec.yaml>        one-command platform app setup for a channel spec (item 61):",
    "       --base-url <public-url>         slack app manifest YAML, telegram setWebhook, discord",
    "       [--platform slack|telegram|discord|all]  interactions endpoint + invite URL",
    "       [-o <dir>] [--dry-run] [--force]",
    "  channel verify <spec.yaml>           scope doctor: slack auth.test + granted scopes,",
    "       [--platform ...] [--dry-run]    telegram getWebhookInfo, discord application fetch",
    "       [--base-url <public-url>]       (exit 1 on missing scopes / mismatched webhook)",
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

function printVersion(): void {
  // Resolution (embedded --define constant → apps/cli/package.json) lives in
  // version.ts so compile-check.ts can pin dependencies to the same version.
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
      "usage: crewhaus compile <spec.yaml> [-o <out-dir>] [--emit-ir] [--check]\n" +
        "                        [--allow-unmarked-sinks] [--no-readme] [--no-register]\n" +
        "  --emit-ir  Skip code emission; print the lowered IR as JSON to\n" +
        "             stdout (or to <out-dir>/ir.json when -o is set).\n" +
        "  --check    After emitting, verify the bundle: run the target shape's\n" +
        "             smoke assertion, `bun install` its deps in the out-dir, and\n" +
        "             boot it once credential-free (liveness only — shapes whose\n" +
        "             boot needs live credentials/servers degrade to a reported\n" +
        "             gate). One green/red verdict line; red exits 1.\n" +
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
  const check = args.flags["check"] === true;
  if (check && emitIr) die("--check verifies emitted files — it cannot combine with --emit-ir");
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

  // Item 33 — `--check`: verify the just-emitted bundle. Wired at the very
  // end of the compile path so a plain compile is byte-for-byte unaffected.
  if (check) {
    const { runCompileCheck } = await import("./compile-check");
    // compile() already succeeded, so lowering again for the target
    // discriminator cannot throw here.
    const target = lower(parseSpec(yamlText)).target;
    const result = await runCompileCheck({ target, bundle, outDir: absOut });
    for (const step of result.steps) {
      if (step.status === "failed" && step.detail !== undefined) {
        process.stderr.write(`crewhaus: [check] ${step.step}: ${step.detail}\n`);
      }
    }
    process.stdout.write(`${result.line}\n`);
    if (!result.green) process.exit(1);
  }
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

/**
 * Finding 7 — GitHub only reads workflows from `.github/workflows` at the
 * REPO ROOT; a scaffold written inside a nested harness dir never runs.
 * Resolve where a scaffolded workflow must land: the git toplevel of
 * `harnessAbsDir` when it is inside a work tree, else `fallbackRoot` (the
 * cwd — no repo exists yet, so the user's `git init` will land there).
 * `harnessDir` is the harness's root-relative POSIX path ("" = the harness
 * IS the root) for the workflow's `defaults.run.working-directory`.
 */
function resolveWorkflowRoot(
  harnessAbsDir: string,
  fallbackRoot: string,
): { root: string; harnessDir: string } {
  const top = spawnSync("git", ["-C", harnessAbsDir, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  });
  const toplevel = top.status === 0 ? top.stdout.trim() : "";
  // realpath both sides so symlinked paths (macOS /tmp → /private/tmp) do
  // not derail the relative() computation against git's resolved toplevel.
  const root = toplevel !== "" ? toplevel : realpathSync(fallbackRoot);
  const rel = relative(root, realpathSync(harnessAbsDir));
  if (rel === "" || rel === ".") return { root, harnessDir: "" };
  // A harness outside the resolved root (odd, but possible with an absolute
  // [name] arg) scaffolds beside itself rather than inventing a prefix.
  if (rel.startsWith("..") || isAbsolute(rel)) return { root: harnessAbsDir, harnessDir: "" };
  return { root, harnessDir: rel.split(sep).join("/") };
}

function runInit(args: ParsedArgs): void {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus init [name] [--ci] [--force]\n" +
        "  --ci     Also scaffold .github/workflows/crewhaus-eval.yml — the eval-on-PR\n" +
        "           gate (item 44): PRs touching crewhaus.yaml or eval/** run the base\n" +
        "           branch's spec and the PR's spec on the PR's dataset+graders (two\n" +
        "           fresh runs, pinned seed, --concurrency 1), post the score-delta\n" +
        "           table as a PR comment, and fail the check on `eval --gate` failure\n" +
        "           (any pass-rate drop or per-sample pass→fail flip). In a directory\n" +
        "           that already has a crewhaus.yaml, `init --ci` adds just the workflow.\n" +
        "           The workflow is written to .github/workflows at the GIT REPO ROOT\n" +
        "           (GitHub only reads it there); for a harness in a subdirectory its\n" +
        "           working-directory and paths filter point back at the harness.\n" +
        "  --force  Overwrite an existing scaffolded workflow (never the spec).\n",
    );
    return;
  }
  const ci = args.flags["ci"] === true;
  const nameArg = args.positional[0];
  const targetDir = typeof nameArg === "string" ? resolve(nameArg) : process.cwd();
  const specName = typeof nameArg === "string" ? nameArg : basename(targetDir);
  const targetFile = join(targetDir, "crewhaus.yaml");

  if (existsSync(targetFile)) {
    // Item 44 — `init --ci` composes with an existing harness: keep the
    // spec, add just the workflow. Without --ci the historical refusal
    // stands (a bare `init` must never touch existing work).
    if (!ci) die(`${targetFile} already exists — refusing to overwrite`);
    process.stdout.write(`kept ${targetFile} (already exists)\n`);
  } else {
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
  }

  if (ci) {
    // Item 44 — the eval-on-PR CI gate. Finding 7: GitHub only reads
    // .github/workflows at the REPO ROOT, so the workflow lands there (git
    // toplevel, cwd fallback), with its working-directory/paths filter
    // pointed back at the harness when the spec lives in a subdirectory.
    try {
      const { root: wfRoot, harnessDir } = resolveWorkflowRoot(targetDir, process.cwd());
      const scaffolded = scaffoldWorkflowFile({
        rootDir: wfRoot,
        relPath: EVAL_CI_WORKFLOW_RELPATH,
        content: buildEvalCiWorkflowYaml({ harnessDir }),
        force: args.flags["force"] === true,
      });
      process.stdout.write(`wrote ${scaffolded.path}\n`);
      if (harnessDir !== "") {
        process.stdout.write(
          `    (workflow written at the repo root, not in ${harnessDir}/ — GitHub only reads\n` +
            `    .github/workflows there; its working-directory and paths filter point at ${harnessDir}/)\n`,
        );
      }
      const filterBase = harnessDir === "" ? "" : `${harnessDir}/`;
      process.stdout.write(
        `ci: set the ANTHROPIC_API_KEY repo secret; PRs touching ${filterBase}crewhaus.yaml or\n` +
          `    ${filterBase}eval/** are then evaled against the base branch and gated on regressions.\n`,
      );
    } catch (err) {
      if (err instanceof FlywheelConfigError) die(err.message);
      throw err;
    }
  }

  // The runtime resolves the spec and the `.crewhaus/` session store from
  // the current working directory, so guide the user to run from inside
  // the harness directory (where crewhaus.yaml lives), not from here.
  const rel = relative(process.cwd(), targetDir);
  const cd = rel === "" ? "" : `cd ${rel} && `;
  process.stdout.write(`next: ${cd}crewhaus run crewhaus.yaml\n`);
  logger.debug("init.success", { target: targetFile, ci });
}

/**
 * Built-in tool name → RegisteredTool, populated lazily so that subcommands
 * which don't need tools (init, doctor) don't pay the import cost. Mirror of
 * `BUILTIN_TOOL_MAP` in packages/target-cli/src/index.ts — keep them in sync.
 */
async function loadToolMap(): Promise<Record<string, RegisteredTool>> {
  const [fs, bash, todo, web, image, fetchPkg, imageGen, docIngest, codegraph, codeExec] =
    await Promise.all([
      import("@crewhaus/tool-fs"),
      import("@crewhaus/tool-bash"),
      import("@crewhaus/tool-todo"),
      import("@crewhaus/tool-web"),
      import("@crewhaus/tool-image"),
      import("@crewhaus/tool-fetch"),
      import("@crewhaus/tool-image-generation"),
      import("@crewhaus/tool-document-ingest"),
      import("@crewhaus/tool-codegraph"),
      import("@crewhaus/tool-code-execution"),
    ]);
  const map: Record<string, RegisteredTool> = {
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
    // Section 18 — sandboxed code execution. These MUST be resolvable at
    // `crewhaus run` time: `BUILTIN_TOOL_MAP` in target-cli lets a spec's
    // `tools: [python]` COMPILE, so omitting them here made a compilable CLI
    // spec crash at run with "unknown tool". The two maps are kept in sync
    // (guarded by tools-cli's map-sync test).
    python: codeExec.python,
    javascript: codeExec.javascript,
    shell: codeExec.shell,
    imageGenerate: imageGen.imageGenerate,
    ingestDocument: docIngest.ingestDocument,
    // Pillar 2 — AST-aware code intelligence (recipe 54).
    codegraphSearch: codegraph.codegraphSearch,
    codegraphCallers: codegraph.codegraphCallers,
    codegraphCallees: codegraph.codegraphCallees,
    codegraphImpact: codegraph.codegraphImpact,
  };
  // Item 18 map-sync floor: this map's keys ARE the canonical runtime tool
  // list. `CLI_RUNTIME_TOOL_KEYS` mirrors them (so the map-sync test can
  // compare against target-cli's BUILTIN_TOOL_MAP without importing the whole
  // entry file), and `tools list`/`tools audit` resolve `.name`/metadata off
  // this map. Assert the mirror never drifts from the real map.
  const built = Object.keys(map).sort();
  const mirror = [...CLI_RUNTIME_TOOL_KEYS].sort();
  if (built.length !== mirror.length || built.some((k, i) => k !== mirror[i])) {
    throw new Error(
      `loadToolMap keys drifted from CLI_RUNTIME_TOOL_KEYS (tools-cli.ts) — update the mirror. built=${built.join(",")} mirror=${mirror.join(",")}`,
    );
  }
  return map;
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
        "  --model accepts the full router grammar: claude-* (Anthropic), openai/<m>, gemini/<m>, bedrock/<id> (geo prefixes tolerated), local/<m>@<url>\n" +
        "  A spec with a feedback: block asks `rate this session? [g]ood / [b]ad / [enter] skip`\n" +
        "  on clean REPL exit (one keystroke, 10s timeout, TTY only — never when piped). Opt out\n" +
        "  with CREWHAUS_NO_EXIT_RATING=1 or feedback.exitPrompt: false. With feedback.autoDistill\n" +
        "  enabled, accumulated ratings are auto-distilled into the `<specName>-ratings` registry\n" +
        "  dataset at teardown (item 1) — see `crewhaus optimize --help`.\n",
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

  // Item 1 — post-session feedback teardown: the one-keystroke exit rating
  // prompt (TTY only) and the feedback.autoDistill consumer. Runs only on a
  // clean REPL exit (runChatLoop returned; a throw above skips it) and is
  // best-effort — a teardown failure never turns a successful session into
  // a non-zero exit. Deliberately CLI teardown code (the in-process analogue
  // of where the stop hook fires), NOT a spawned hook: hooks run
  // credential-stripped, and the distill/registry path needs the caller's
  // full environment.
  try {
    await runFeedbackTeardown(ir, resumeId);
  } catch (err) {
    process.stderr.write(
      `[feedback] teardown skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
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
      "usage: crewhaus doctor [--philosophy-alignment [--json] [--baseline | --accept-baseline]]\n" +
        "                       [--liveness] [--context-pressure [--sessions N]]\n" +
        "  --philosophy-alignment   audit the codebase + examples against the three architectural pillars\n" +
        "  --json                   persist findings (stable ids) to .crewhaus/scope-audit/<date>.json\n" +
        "                           and print the snapshot JSON (item 49)\n" +
        "  --baseline               diff findings against .crewhaus/scope-audit/baseline.json; exit\n" +
        "                           non-zero ONLY on NEW findings (accepted legacy findings never block)\n" +
        "  --accept-baseline        promote the current findings to the accepted baseline\n" +
        "  --liveness               process-liveness probe: exit 0 immediately, no credential or\n" +
        "                           spec checks (for container HEALTHCHECKs / k8s exec probes)\n" +
        "  --context-pressure       report truncation recoveries, compaction fires per session\n" +
        "                           (snip vs autocompact split), and the cwd spec's max_tokens/\n" +
        "                           compaction knobs over the last N sessions (--sessions N,\n" +
        "                           default 20). When the advise thresholds trip, prints the\n" +
        "                           exact commands that close the tuning loop:\n" +
        "                             crewhaus advise --all -o . && crewhaus optimize crewhaus.yaml \\\n" +
        "                               --from-advice suggestions.json --write-back ...\n" +
        "                           Always exits 0 — a report, not a gate.\n" +
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
  if (args.flags["context-pressure"]) {
    runDoctorContextPressure(args);
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
  let specText: string | undefined;
  if (existsSync(specPath)) {
    try {
      specText = readFileSync(specPath, "utf-8");
    } catch {
      specText = undefined;
    }
  }
  const specModel = specText !== undefined ? extractSpecModel(specText) : undefined;
  checks.push(...buildCredentialChecks(specModel, process.env));

  // Item 61 — channel-target env checks: only when the cwd spec lowers to a
  // channel IR (other shapes contribute nothing), one check per configured
  // slack/telegram/discord platform asserting its required secret env-refs
  // are set. Live platform probes live in `crewhaus channel verify`.
  if (specText !== undefined) {
    checks.push(...buildChannelEnvChecks(specText, process.env));
  }

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
 * Item 17 (completion) — `crewhaus doctor --context-pressure` (wiring only;
 * the fold + formatting live in ./context-pressure). Reads the N most
 * recent session logs by mtime ("recent" means what ran last — session ids
 * are random hex, so name order carries no recency), builds the pressure
 * report against the cwd spec's knobs, and prints it. A report, not a
 * gate: this path always exits 0 — thresholds tripping print the exact
 * advise/optimize commands instead of failing doctor.
 */
function runDoctorContextPressure(args: ParsedArgs): void {
  const limit = intFlag(args, "sessions") ?? DEFAULT_CONTEXT_PRESSURE_SESSIONS;
  if (limit < 1) {
    die(`invalid --sessions "${args.flags["sessions"]}" — must be a positive integer`);
  }

  const sessionsDir = join(process.cwd(), ".crewhaus", "sessions");
  const files = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))
    : [];
  const recent = files
    .map((f) => {
      const file = join(sessionsDir, f);
      return { file, sessionId: f.replace(/\.jsonl$/, ""), mtimeMs: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
  const sessions: SessionEvents[] = recent.map((r) => ({
    sessionId: r.sessionId,
    objects: parseAdviseJsonl(readFileSync(r.file, "utf-8")),
  }));

  // The cwd spec surfaces the current knobs next to the pressure numbers;
  // a missing/broken spec degrades to one report line — never a block.
  let spec: Spec | undefined;
  const specPath = join(process.cwd(), "crewhaus.yaml");
  if (existsSync(specPath)) {
    try {
      spec = parseSpec(readFileSync(specPath, "utf-8"));
    } catch {
      spec = undefined;
    }
  }

  const report = buildContextPressureReport(sessions, spec !== undefined ? { spec } : {});
  for (const line of formatContextPressureLines(report)) {
    process.stdout.write(`${line}\n`);
  }
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
        "[--improvement-threshold F] [--budget-usd N] [--from-advice <suggestions.json>] " +
        "[--write-back] [--no-register] [--no-pin-regressions] [--no-retry] [-o <out-dir>]\n" +
        "  --dataset takes a file path or registry:<name>[@version][#split] (Section 29 registry;\n" +
        "  default version: latest). A registry record with populated train AND dev splits is\n" +
        "  used as-is; otherwise the selected samples get the inline 70/30 split. The test\n" +
        "  split is never optimized against unless #test is explicitly given.\n" +
        "  User-rating loops (item 1): --ratings <session>|all distills feedback inline for\n" +
        "  this run only (unchanged). A spec with feedback.autoDistill maintains a VERSIONED\n" +
        "  `<specName>-ratings` registry dataset at run teardown instead — consume it here\n" +
        "  (and in `crewhaus eval`) as --dataset registry:<specName>-ratings (latest by\n" +
        "  default, or pin @vN).\n" +
        "  When a patch is accepted (with or without --write-back), the dev samples that flipped\n" +
        "  fail→pass are pinned into the <specName>-regressions registry dataset (a new version\n" +
        "  unioning the previous one, deduped by sample id) so `crewhaus eval` guards them by\n" +
        "  default. --no-pin-regressions skips the pin.\n" +
        "  Inside each candidate's fitness eval, samples that ERROR (provider timeout, 429,\n" +
        "  grader throw — infra noise) are retried once by default, exactly like `crewhaus\n" +
        "  eval`; --no-retry disables the retry so every first attempt stands.\n" +
        "  After each candidate's eval the failure arbiter triages failing dev samples;\n" +
        "  noise (flaky infra) and contract-ambiguity confirmed by structured grader output\n" +
        "  (bad gold) are excluded from the failure signal the mutator sees. Contract-\n" +
        "  ambiguity inferred only from a missing gold answer stays IN the signal (on\n" +
        "  judge-graded/no-gold datasets it is the signal); both kinds collect into a\n" +
        "  dataset-fix queue printed at the end of the run.\n" +
        "  A successful --write-back auto-registers the rewritten spec in the local\n" +
        "  registry (.crewhaus/specs) with a changelog entry carrying the run's\n" +
        "  score delta and patch rationale — same flow as `crewhaus compile`;\n" +
        "  --no-register opts out. See `crewhaus spec log <name>`.\n" +
        "  --from-advice <suggestions.json> applies the validated SpecPatches `crewhaus advise`\n" +
        "  emitted (agent.max_tokens, compaction.curate, …) instead of running the mutation\n" +
        "  search — mutually exclusive with --mutator/--iterations. Each patch is applied\n" +
        "  in-memory, compile-gated, and evaluated on the dev split against ONE baseline eval\n" +
        "  of the unpatched spec. Acceptance: the regression gate must pass (no pass-rate drop,\n" +
        "  no per-sample pass→fail flip), but strict improvement is NOT required — advisor\n" +
        "  patches tune config for latency/cost/robustness, so an equal pass rate with zero\n" +
        "  regressions accepts; the delta is printed and persisted either way. Accepted\n" +
        "  patches compose (patch k+1 applies on top of the accepted spec); rejected patches\n" +
        "  are reported with their eval delta. Artifacts land under <out>/advice/ (baseline +\n" +
        "  per-patch eval dirs, decisions.json, patched.yaml). The source spec is only touched\n" +
        "  with --write-back (same conventions as the search path: provenance header +\n" +
        "  auto-register + regression pinning).\n" +
        "  The nightly advisor loop composes:\n" +
        "    crewhaus advise --all -o . && \\\n" +
        "    crewhaus optimize crewhaus.yaml --from-advice suggestions.json --write-back \\\n" +
        "      --dataset eval/dataset.jsonl --graders eval/graders.yaml\n",
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  // Item 15 — `--from-advice` replaces the mutation search: the knobs that
  // steer it have nothing to act on, so the combination is rejected up
  // front (before any dataset is loaded or eval is paid for).
  const fromAdviceFlag = strFlag(args, "from-advice");
  if (fromAdviceFlag !== undefined) {
    try {
      assertFromAdviceFlagsCompatible({
        mutator: typeof args.flags["mutator"] === "string",
        iterations: typeof args.flags["iterations"] === "string",
      });
    } catch (err) {
      if (err instanceof AdviceApplyError) die(err.message);
      throw err;
    }
  }
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
  // Item 7 — the fitness evals inherit the runner's noise auto-retry
  // (default ON, consistent with `crewhaus eval`); `--no-retry` opts out.
  const retryErrors = args.flags["no-retry"] !== true;
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
  type OptimizerSample = { id: string; input: string; expected_output?: string };
  const toOptimizerSample = (s: Sample): OptimizerSample => ({
    id: s.id,
    input: s.input,
    ...(s.expected_output !== undefined ? { expected_output: s.expected_output } : {}),
  });
  const samples: OptimizerSample[] = [];
  // Item 9 — the ORIGINAL samples by id, captured before toOptimizerSample
  // strips expected_tools/metadata, so post-accept regression pinning
  // appends each recovered sample as it lives in the source dataset (a
  // pinned sample must re-grade the same way under `crewhaus eval`).
  const originalById = new Map<string, Sample>();
  const remember = <T extends Sample>(list: ReadonlyArray<T>): ReadonlyArray<T> => {
    for (const s of list) if (!originalById.has(s.id)) originalById.set(s.id, s);
    return list;
  };
  let datasetName = "ratings";
  // Item 12 — a registry:<name>[@version][#split] dataset whose record
  // carries BOTH a populated train and dev split (and no explicit #split) is
  // used as-is instead of being re-split inline; the record's split
  // assignment is the reproducible source of truth. Otherwise the selected
  // samples join the pool below and get the inline 70/30 split. The
  // registry's test split never enters optimization unless #test is
  // explicitly given.
  let registrySplits: { train: OptimizerSample[]; dev: OptimizerSample[] } | undefined;
  if (typeof datasetPath === "string") {
    let registryRef: ReturnType<typeof parseRegistryRef>;
    try {
      registryRef = parseRegistryRef(datasetPath);
    } catch (err) {
      if (err instanceof DatasetRefError) die(err.message);
      throw err;
    }
    if (registryRef !== undefined) {
      const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
      let resolved: Awaited<ReturnType<typeof resolveRegistryRef>>;
      try {
        resolved = await resolveRegistryRef(registry, registryRef);
      } catch (err) {
        if (err instanceof DatasetRefError || err instanceof CrewhausError) die(err.message);
        throw err;
      }
      datasetName = resolved.datasetName;
      const { record } = resolved;
      if (
        registryRef.split === undefined &&
        record.splits.train.length > 0 &&
        record.splits.dev.length > 0
      ) {
        registrySplits = {
          train: remember(record.splits.train).map(toOptimizerSample),
          dev: remember(record.splits.dev).map(toOptimizerSample),
        };
      } else if (registryRef.split !== undefined) {
        samples.push(...remember(resolved.samples).map(toOptimizerSample));
      } else {
        // Only one populated split — pool train+dev and re-split inline.
        samples.push(...remember(record.splits.train).map(toOptimizerSample));
        samples.push(...remember(record.splits.dev).map(toOptimizerSample));
      }
    } else {
      const dataset = await loadDataset(resolve(datasetPath));
      datasetName = dataset.name;
      for await (const s of dataset.samples) {
        remember([s]);
        samples.push(toOptimizerSample(s));
      }
    }
  }
  if (ratingsDistill !== undefined) {
    // Ratings are training signal, never a held-out dev set — with registry
    // splits in play they extend train; otherwise they join the pool.
    remember(ratingsDistill.samples);
    if (registrySplits !== undefined) registrySplits.train.push(...ratingsDistill.samples);
    else samples.push(...ratingsDistill.samples);
  }

  let trainSet: OptimizerSample[];
  let devSet: OptimizerSample[];
  if (registrySplits !== undefined) {
    trainSet = registrySplits.train;
    devSet = registrySplits.dev;
  } else {
    if (samples.length === 0) die(`dataset "${datasetName}" yielded zero samples`);
    // Train/dev split: 70/30 deterministic split by sample id ordering.
    const splitIdx = Math.max(1, Math.floor(samples.length * 0.7));
    trainSet = samples.slice(0, splitIdx);
    devSet = samples.slice(splitIdx);
    if (devSet.length === 0) {
      die(
        `dataset has ${samples.length} samples — need at least 2 (70/30 split needs a dev split)`,
      );
    }
  }

  // Item 15 — `--from-advice`: the eval-gated apply path for the advisor's
  // SpecPatches. Branches here because it shares everything above (dataset/
  // graders/ratings resolution, the dev split, the run dirs) and nothing
  // below (no mutation search, no fitness fn, no mutator).
  if (fromAdviceFlag !== undefined) {
    await runOptimizeFromAdvice({
      fromAdvicePath: fromAdviceFlag,
      absSpec,
      specPath,
      runId,
      outDir,
      compiled,
      devSet,
      datasetName,
      concurrency,
      seed,
      retryErrors,
      writeBack,
      noRegister: args.flags["no-register"] === true,
      pinRegressions: args.flags["no-pin-regressions"] !== true,
      originalById,
    });
    return;
  }

  // Index the dev set by id so the fitness fn can join each graded
  // sample-result back to the input + reference it was scored against.
  const devById = new Map(devSet.map((s) => [s.id, s]));

  // Item 9 — per-fitness-call sequence number. Folded into each candidate's
  // eval dir name so two same-length candidate prompts can't overwrite each
  // other's persisted run (the post-accept regression pinning diffs the
  // baseline dir against the winner's dir, so both must survive intact).
  let evalCallSeq = 0;

  // Item 7 — cross-iteration dataset-fix queue: sampleId → arbiter reason
  // for every dev sample the failure arbiter classified contract-ambiguity.
  // The queue prints at the end of optimize. Only the ids whose verdict is
  // backed by structured grader evidence ALSO join the sticky exclusion set
  // below — those stay excluded from the mutator's failure signal for the
  // rest of the run (the dataset/contract problem doesn't change with the
  // candidate prompt). Heuristic (no-gold) verdicts are queued but stay in
  // the signal: on judge-graded datasets they ARE the failure signal.
  const datasetFixQueue = new Map<string, string>();
  const stickyAmbiguous = new Set<string>();

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
    evalCallSeq += 1;
    const summary = await runEvalLib({
      ir,
      dataset: { name: datasetName, samples: makeAsyncIterable(devSet) },
      compiledGraders: compiled,
      opts: {
        outDir: join(
          outDir,
          "evals",
          `${String(evalCallSeq).padStart(3, "0")}_${prompt.length}_${ir.agent.instructions.length}`,
        ),
        concurrency,
        seed,
        retryErrors,
      },
    });
    // Item 7 — failure-arbiter pre-filter: classify this candidate's failing
    // samples and withhold noise (flaky infra) and contract-ambiguity (bad
    // gold) from the failure signal the mutator sees — mutating the prompt
    // against them wastes mutation budget. Contract-ambiguity ids join the
    // sticky dataset-fix queue above. Best-effort: a triage error keeps the
    // unfiltered grades (the pre-item-7 behaviour) rather than failing the
    // fitness call. The aggregate passRate is NOT filtered — the search
    // score stays honest; only the mutator's per-sample window narrows.
    let excludedFromSignal: ReadonlySet<string> = new Set<string>();
    try {
      const triage = triageFitnessSamples({
        samples: summary.samples,
        samplesById: originalById,
        alreadyAmbiguous: stickyAmbiguous,
      });
      for (const a of triage.ambiguous) {
        datasetFixQueue.set(a.sampleId, a.reason);
        // Only evidence-backed ambiguity is sticky-excluded (see above).
        if (a.fromGraderEvidence) stickyAmbiguous.add(a.sampleId);
      }
      excludedFromSignal = triage.excluded;
      const line = formatFitnessTriageLine(triage);
      if (line !== undefined) process.stdout.write(`[optimize] ${line}\n`);
    } catch (err) {
      process.stderr.write(
        `[optimize] triage skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const grades = summary.samples
      .filter((r) => !excludedFromSignal.has(r.sampleId))
      .map((r) => {
        const dev = devById.get(r.sampleId);
        return {
          input: dev?.input ?? r.sampleId,
          score: r.grades.overall.score,
          ...(dev?.expected_output !== undefined ? { expected: dev.expected_output } : {}),
          rationale: r.grades.overall.rationale,
        };
      });
    // Item 9 — report where this measurement's eval run was persisted so
    // the optimizer can surface the baseline/winner dirs for pinning.
    return { score: summary.aggregates.passRate, grades, runDir: summary.outDir };
  };

  const mutator = args.flags["mutator"];
  let mutatorImpl: import("@crewhaus/prompt-optimizer").MutationProvider | undefined;
  if (mutator === "claude") {
    mutatorImpl = await createClaudeMutatorForSpec(absSpec);
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
    // Item 9 — the patch was accepted (with or without --write-back): the
    // dev samples that flipped fail→pass between the baseline eval run and
    // the winning candidate's are exactly the behaviors the patch fixed.
    // Pin them into the per-spec regression suite so `crewhaus eval` keeps
    // guarding them even if the training dataset later churns. Best-effort:
    // a pinning failure must not fail an otherwise successful optimize.
    try {
      const pin = await pinRecoveriesAfterOptimize({
        registry: createFileBackedRegistry({ rootDir: defaultDatasetsRoot() }),
        specName: parseSpec(readFileSync(absSpec, "utf-8")).name,
        pin: args.flags["no-pin-regressions"] !== true,
        ...(result.baselineEvalDir !== undefined ? { baselineRunDir: result.baselineEvalDir } : {}),
        ...(result.bestEvalDir !== undefined ? { candidateRunDir: result.bestEvalDir } : {}),
        // Original (un-stripped) samples — see `originalById` above.
        samplesById: originalById,
        sourceDataset: datasetName,
        optimizeRunId: runId,
      });
      if (pin !== undefined && pin.pinned > 0) {
        process.stdout.write(
          `[optimize] pinned ${pin.pinned} recovered samples → ${pin.suiteName}@${pin.version}\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[optimize] regression pinning skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  } else {
    process.stdout.write(
      `[optimize] no improvement above threshold ${improvementThreshold}; source untouched.\n`,
    );
  }

  // Item 7 — surface the queued contract-ambiguity samples: these need a
  // dataset/contract fix, not more prompt mutations, which is why they were
  // withheld from the mutator's failure signal above. Empty queue → silent.
  for (const line of formatDatasetFixQueue(datasetFixQueue)) {
    process.stdout.write(`[optimize] ${line}\n`);
  }
}

/**
 * Item 15 — the `optimize --from-advice` body (wiring only; the accept/
 * reject/compose loop lives in ./advice-apply). Reuses the exact seams the
 * search path uses: `lower(parseSpec(...))` as the offline compile gate and
 * one `runEvalLib` pass per candidate over the resolved dev split — then
 * mirrors the flywheel's applyAccepted conventions on `--write-back`
 * (provenance header via `stampAdviceWriteBack` → write source → auto-
 * register + changelog → best-effort regression pinning). Without
 * `--write-back` the source is never touched: the stamped YAML lands at
 * `<out>/advice/patched.yaml` next to decisions.json and the eval dirs.
 */
async function runOptimizeFromAdvice(opts: {
  readonly fromAdvicePath: string;
  readonly absSpec: string;
  readonly specPath: string;
  readonly runId: string;
  readonly outDir: string;
  readonly compiled: ReadonlyArray<CompiledGrader>;
  readonly devSet: ReadonlyArray<{ id: string; input: string; expected_output?: string }>;
  readonly datasetName: string;
  readonly concurrency: number;
  readonly seed: number;
  readonly retryErrors: boolean;
  readonly writeBack: boolean;
  readonly noRegister: boolean;
  readonly pinRegressions: boolean;
  readonly originalById: ReadonlyMap<string, Sample>;
}): Promise<void> {
  const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

  let suggestionsText: string;
  try {
    suggestionsText = readFileSync(resolve(opts.fromAdvicePath), "utf-8");
  } catch (err) {
    die(`could not read ${opts.fromAdvicePath}: ${(err as Error).message}`);
  }
  let patches: ParsedAdvicePatch[];
  try {
    patches = parseSuggestionsFile(suggestionsText);
  } catch (err) {
    if (err instanceof AdviceApplyError) die(err.message);
    throw err;
  }
  if (patches.length === 0) {
    process.stdout.write(
      `[optimize] ${opts.fromAdvicePath} carries no spec patches — nothing to apply (advice-only findings are report-only; see the advise report.html)\n`,
    );
    return;
  }

  const sourceYaml = readFileSync(opts.absSpec, "utf-8");
  const adviceDir = join(opts.outDir, "advice");
  mkdirSync(adviceDir, { recursive: true });

  process.stdout.write(
    `[optimize] runId=${opts.runId} spec=${opts.specPath} dataset=${opts.datasetName} ` +
      `(${opts.devSet.length} dev) from-advice=${opts.fromAdvicePath} patches=${patches.length}\n`,
  );

  // Injected seams (see applyAdvicePatches in ./advice-apply): the same
  // offline parse→lower gate and per-candidate eval pass the search path's
  // fitness fn uses, persisted under <out>/advice/<label>/.
  const compileCheck = (yaml: string, _label: string): void => {
    lower(parseSpec(yaml));
  };
  const evalRun = async (label: string, yaml: string) => {
    const evalIr = lower(parseSpec(yaml));
    if (evalIr.target !== "cli") {
      die(`crewhaus optimize --from-advice only supports target: cli (got "${evalIr.target}")`);
    }
    const summary = await runEvalLib({
      ir: evalIr,
      dataset: { name: opts.datasetName, samples: makeAsyncIterable(opts.devSet) },
      compiledGraders: opts.compiled,
      opts: {
        outDir: join(adviceDir, label),
        concurrency: opts.concurrency,
        seed: opts.seed,
        retryErrors: opts.retryErrors,
      },
    });
    process.stdout.write(
      `[optimize] ${label} eval: pass_rate=${pct(summary.aggregates.passRate)} ` +
        `mean_score=${summary.aggregates.meanScore.toFixed(3)} errors=${summary.aggregates.errorCount}\n`,
    );
    return summary;
  };

  let result: Awaited<ReturnType<typeof applyAdvicePatches>>;
  try {
    result = await applyAdvicePatches({ sourceYaml, patches, hooks: { compileCheck, evalRun } });
  } catch (err) {
    // The baseline compile/eval gate failed — a spec the compiler rejects
    // (or a dataset that can't run) must die cleanly, like the search path.
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }

  // decisions.json — the per-patch audit trail (accepted/rejected + reason
  // + eval delta + eval dir), next to the baseline and patch-NNN eval dirs.
  const decisionsFile = buildAdviceDecisionsFile({
    runId: opts.runId,
    generatedAt: new Date().toISOString(),
    source: opts.fromAdvicePath,
    baseline: result.baseline,
    decisions: result.decisions,
  });
  writeFileSync(join(adviceDir, "decisions.json"), JSON.stringify(decisionsFile, null, 2), {
    mode: 0o600,
  });

  for (const d of result.decisions) {
    process.stdout.write(`[optimize] ${formatAdviceDecisionLine(d)}\n`);
  }
  process.stdout.write(`[optimize] decisions: ${join(adviceDir, "decisions.json")}\n`);

  if (result.accepted === 0 || result.finalSummary === undefined) {
    process.stdout.write(
      `[optimize] 0/${result.decisions.length} advice patches accepted — spec untouched.\n`,
    );
    return;
  }

  const passRateBefore = result.baseline.aggregates.passRate;
  const passRateAfter = result.finalSummary.aggregates.passRate;
  const stamped = stampAdviceWriteBack({
    runId: opts.runId,
    yaml: result.finalYaml,
    passRateBefore,
    passRateAfter,
    patchesEvaluated: result.decisions.length,
  });
  // The composed accepted spec is always persisted as an artifact
  // (accept-then-write: the source is only touched by --write-back below).
  writeFileSync(join(adviceDir, "patched.yaml"), stamped, { mode: 0o600 });
  // Aggregate patch.json so `spec log` provenance (autoRegisterSpecVersion
  // reads its `rationale`) names what this write-back was.
  const acceptedDecisions = result.decisions.filter(
    (d): d is AdvicePatchDecision & { status: "accepted" } => d.status === "accepted",
  );
  const acceptedIds = acceptedDecisions.map((d) => d.findingId ?? d.patch.path.join("."));
  writeFileSync(
    join(adviceDir, "patch.json"),
    JSON.stringify(
      {
        rationale:
          `advisor: accepted ${result.accepted}/${result.decisions.length} advice patch(es) ` +
          `[${acceptedIds.join(", ")}]; pass_rate ${pct(passRateBefore)} → ${pct(passRateAfter)}`,
        patches: acceptedDecisions.map((d) => d.patch),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.stdout.write(
    `[optimize] accepted ${result.accepted}/${result.decisions.length} advice patches ` +
      `(pass_rate ${pct(passRateBefore)} → ${pct(passRateAfter)}, Δ ${((passRateAfter - passRateBefore) * 100).toFixed(1)} pts)\n`,
  );

  if (!opts.writeBack) {
    process.stdout.write(
      `[optimize] patched YAML saved to ${join(adviceDir, "patched.yaml")}. Re-run with --write-back to apply it to the source spec.\n`,
    );
    return;
  }

  // --write-back: the flywheel applyAccepted conventions — stamped source
  // write, auto-register + changelog, best-effort regression pinning.
  writeFileSync(opts.absSpec, stamped);
  process.stdout.write(`[optimize] wrote patched YAML to ${opts.absSpec}\n`);
  if (!opts.noRegister) {
    await autoRegisterSpec(stamped, { patchJsonPath: join(adviceDir, "patch.json") });
  }
  try {
    const pin = await pinRecoveriesAfterOptimize({
      registry: createFileBackedRegistry({ rootDir: defaultDatasetsRoot() }),
      specName: parseSpec(sourceYaml).name,
      pin: opts.pinRegressions,
      baselineRunDir: result.baseline.outDir,
      candidateRunDir: result.finalSummary.outDir,
      samplesById: opts.originalById,
      sourceDataset: opts.datasetName,
      optimizeRunId: opts.runId,
    });
    if (pin !== undefined && pin.pinned > 0) {
      process.stdout.write(
        `[optimize] pinned ${pin.pinned} recovered samples → ${pin.suiteName}@${pin.version}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[optimize] regression pinning skipped: ${err instanceof Error ? err.message : String(err)}\n`,
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

/**
 * Build the model-driven Claude mutation provider for a spec — shared by
 * `optimize --mutator claude` and the flywheel's default mutator. Resolves
 * via the model-router so non-Anthropic specs drive their own provider:
 * the resolved adapter + STRIPPED wire modelId replace the old hardcoded
 * createAnthropicAdapter() + verbatim prefixed string (which made
 * `--mutator claude` a silent no-op for openai/gemini/bedrock/local specs
 * — every mutation call failed and the provider fell back).
 */
async function createClaudeMutatorForSpec(
  absSpec: string,
): Promise<import("@crewhaus/prompt-optimizer").MutationProvider> {
  const { createClaudeMutationProvider } = await import("@crewhaus/prompt-optimizer-claude");
  const { resolveModel } = await import("@crewhaus/model-router");
  const ir = lower(parseSpec(readFileSync(absSpec, "utf-8")));
  const mutatorModel = ir.target === "cli" ? ir.agent.model : "claude-sonnet-4-5";
  const resolution = await resolveModel(mutatorModel);
  return createClaudeMutationProvider({
    adapter: resolution.adapter,
    model: resolution.modelId,
  });
}

// -------- item 45: crewhaus flywheel init|run --------

/**
 * Invariant guard: the flywheel must never run over uncommitted spec
 * changes — after an accepted write-back, `git diff` on the spec must mean
 * "the flywheel improved this", not "the flywheel's change is tangled with
 * the user's half-finished edit". Outside a git work tree the check is
 * moot (nothing to tangle with) and the run proceeds, mirroring the demo
 * script's NO_GIT path.
 */
function gitSpecStatus(absSpec: string): { inRepo: boolean; dirty: boolean } {
  const dir = dirname(absSpec);
  const inside = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf-8",
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { inRepo: false, dirty: false };
  }
  const status = spawnSync("git", ["-C", dir, "status", "--porcelain", "--", absSpec], {
    encoding: "utf-8",
  });
  return { inRepo: true, dirty: specIsDirty(status.stdout ?? "") };
}

/**
 * Item 45 — `crewhaus flywheel init|run`. `run` executes the complete
 * nightly self-improvement loop in-process (no shelling out to crewhaus
 * subcommands): compile gate → baseline eval → optimize (accept-then-write:
 * NO write-back during the search) → post-patch compile → after eval →
 * acceptance gate (pass_rate strictly up AND zero per-sample regressions,
 * via the run-history `gateRuns`) → on accept, the same write-back
 * semantics as `optimize --write-back` (provenance header + auto-register
 * + changelog + regression pin). A rejected patch never touches the spec.
 * `init` scaffolds the nightly GitHub Actions workflow (PRs for human
 * review, never auto-merged).
 */
async function runFlywheelCmd(args: ParsedArgs, action: "init" | "run"): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      `usage:\n  crewhaus flywheel run [spec.yaml] [--dataset <data>] [--graders <graders.yaml>]\n      [--budget-usd N] [--iterations N] [--seed N] [--concurrency N]\n      [--mutator rule-based|claude] [--dry-run] [--allow-dirty]\n  crewhaus flywheel init [--force]\n\n  \`run\` executes the nightly self-improvement loop in one command:\n  compile gate → baseline eval → optimize (budget-capped; claude mutator\n  by default when an ANTHROPIC credential is present, rule-based fallback\n  otherwise) → post-patch compile → after eval → acceptance gate. The\n  patch is applied to the spec ONLY when pass_rate strictly improved with\n  zero per-sample regressions (the same strict gate \`eval --gate\` uses);\n  an accepted write-back then runs the standard auto-register + changelog\n  + regression-pin flow. A rejected patch never touches disk. --dry-run\n  runs everything but never writes.\n\n  Defaults: <spec> is ./crewhaus.yaml; --dataset falls back to\n  ${CONVENTIONAL_DATASET} then registry:<spec>-ratings (when the spec has a\n  feedback: block and ratings were distilled); --graders falls back to\n  ${CONVENTIONAL_GRADERS}; conventional paths resolve from the SPEC's directory,\n  not the cwd, so a spec passed by path brings its own eval/ files. When the\n  dataset is a registry ref (including the ratings fallback), the before/after\n  acceptance evals run over ALL splits — test included — matching \`eval\`'s\n  registry semantics; per-split acceptance gating is a future knob. The\n  optimizer only ever rewrites agent.instructions (OPTIMIZABLE_PATHS) —\n  permissions: stay exactly as a human reviewed them. The flywheel refuses to\n  run over uncommitted spec changes (--allow-dirty opts out).\n\n  \`init\` scaffolds .github/workflows/crewhaus-flywheel.yml: nightly cron +\n  workflow_dispatch, budget knobs as env, PR creation via gh for HUMAN\n  review — the workflow never merges on its own. Refuses to overwrite an\n  existing workflow without --force.\n\n${formatFlywheelKnobsGuide()
        .map((l) => `  ${l}`)
        .join("\n")}\n`,
    );
    return;
  }
  if (action === "init") {
    runFlywheelInit(args);
    return;
  }
  await runFlywheelRun(args);
}

function runFlywheelInit(args: ParsedArgs): void {
  // Finding 7: GitHub only reads .github/workflows at the REPO ROOT — write
  // there (git toplevel, cwd fallback) and point the workflow's
  // working-directory (and its root-anchored artifact path) back at the
  // harness when it lives in a subdirectory.
  const { root: wfRoot, harnessDir } = resolveWorkflowRoot(process.cwd(), process.cwd());
  let scaffolded: ReturnType<typeof scaffoldWorkflowFile>;
  try {
    scaffolded = scaffoldWorkflowFile({
      rootDir: wfRoot,
      relPath: FLYWHEEL_WORKFLOW_RELPATH,
      content: buildFlywheelWorkflowYaml({ harnessDir }),
      force: args.flags["force"] === true,
    });
  } catch (err) {
    if (err instanceof FlywheelConfigError) die(err.message);
    throw err;
  }
  process.stdout.write(`wrote ${scaffolded.path}\n`);
  if (harnessDir !== "") {
    process.stdout.write(
      `    (workflow written at the repo root, not in ${harnessDir}/ — GitHub only reads\n` +
        `    .github/workflows there; its working-directory and artifact path point at ${harnessDir}/)\n`,
    );
  }
  for (const line of formatFlywheelKnobsGuide()) process.stdout.write(`${line}\n`);
  process.stdout.write(
    "next: commit the workflow and set the ANTHROPIC_API_KEY + FLYWHEEL_GH_TOKEN repo\n" +
      "      secrets. The flywheel then runs nightly; accepted improvements arrive as\n" +
      "      PRs for human review — it never merges on its own.\n",
  );
}

async function runFlywheelRun(args: ParsedArgs): Promise<void> {
  const specPath = args.positional[0] ?? "crewhaus.yaml";
  const absSpec = resolve(specPath);
  if (!existsSync(absSpec)) {
    die(
      `spec not found at ${absSpec} — run from the harness directory (standalone-harness convention) or pass <spec.yaml>`,
    );
  }
  const dryRun = args.flags["dry-run"] === true;

  // Invariant: never run over uncommitted spec changes (see gitSpecStatus).
  const git = gitSpecStatus(absSpec);
  if (git.inRepo && git.dirty) {
    if (args.flags["allow-dirty"] !== true) {
      die(
        `${specPath} has uncommitted changes — the flywheel refuses to run over a dirty spec (an accepted write-back would tangle with your edits). Commit or stash first, or pass --allow-dirty.`,
      );
    }
    process.stderr.write(
      `crewhaus: [flywheel] warning: running over a dirty ${specPath} (--allow-dirty)\n`,
    );
  }

  let knobs: FlywheelKnobs;
  try {
    knobs = resolveFlywheelKnobs({ flags: args.flags, env: process.env });
  } catch (err) {
    if (err instanceof FlywheelConfigError) die(err.message);
    throw err;
  }

  const sourceYaml = readFileSync(absSpec, "utf-8");
  let ir: ReturnType<typeof lower>;
  try {
    ir = lower(parseSpec(sourceYaml));
  } catch (err) {
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
  if (ir.target !== "cli") {
    die(
      `crewhaus flywheel only supports target: cli (got "${ir.target}") — eval/optimize v0 are cli-only`,
    );
  }

  // Dataset/graders defaults: flag > standalone-harness convention >
  // (dataset only) the `<spec>-ratings` registry dataset the feedback
  // flywheel feeds. Conventional paths resolve from the SPEC's directory
  // (matching the dirty-check's spec-dir behavior), so a spec passed by
  // path from a sibling dir finds its own eval/ files; --dataset/--graders
  // flag paths stay cwd-relative, per the harness convention.
  const specDir = dirname(absSpec);
  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  let ratingsRegistered = false;
  const ratingsName = `${ir.name}-ratings`;
  if (ir.feedback !== undefined && isRegistrySafeName(ratingsName)) {
    try {
      ratingsRegistered = (await latestVersion(registry, ratingsName)) !== undefined;
    } catch {
      // An unreadable registry just means no ratings default.
    }
  }
  const datasetFlag = strFlag(args, "dataset");
  const gradersFlag = strFlag(args, "graders");
  let data: FlywheelDataResolution;
  try {
    data = resolveFlywheelData({
      ...(datasetFlag !== undefined ? { datasetFlag } : {}),
      ...(gradersFlag !== undefined ? { gradersFlag } : {}),
      specName: ir.name,
      specDir,
      hasConventionalDataset: existsSync(join(specDir, CONVENTIONAL_DATASET)),
      hasConventionalGraders: existsSync(join(specDir, CONVENTIONAL_GRADERS)),
      ratingsRegistered,
    });
  } catch (err) {
    if (err instanceof FlywheelConfigError) die(err.message);
    throw err;
  }

  let gradersYaml: string;
  try {
    gradersYaml = readFileSync(resolve(data.graders), "utf-8");
  } catch (err) {
    die(`could not read ${data.graders}: ${(err as Error).message}`);
  }
  const { compiled } = parseGradersConfig(gradersYaml);

  // Materialize the dataset once (file path or registry: ref) — the same
  // sample set feeds the before eval, the optimizer's dev evals, and the
  // after eval, so the acceptance diff compares like with like.
  const samples: Sample[] = [];
  let datasetName: string;
  let datasetHash: string;
  let registrySplits: { train: Sample[]; dev: Sample[] } | undefined;
  let registryRef: ReturnType<typeof parseRegistryRef>;
  try {
    registryRef = parseRegistryRef(data.dataset);
  } catch (err) {
    if (err instanceof DatasetRefError) die(err.message);
    throw err;
  }
  if (registryRef !== undefined) {
    let resolved: Awaited<ReturnType<typeof resolveRegistryRef>>;
    try {
      resolved = await resolveRegistryRef(registry, registryRef);
    } catch (err) {
      if (err instanceof DatasetRefError || err instanceof CrewhausError) die(err.message);
      throw err;
    }
    datasetName = resolved.datasetName;
    datasetHash = resolved.datasetHash;
    samples.push(...resolved.samples);
    // Item 12 — a record with populated train AND dev splits (and no
    // explicit #split) is the optimizer's reproducible source of truth;
    // the test split never enters optimization (mirrors `optimize`).
    const { record } = resolved;
    if (
      registryRef.split === undefined &&
      record.splits.train.length > 0 &&
      record.splits.dev.length > 0
    ) {
      registrySplits = { train: [...record.splits.train], dev: [...record.splits.dev] };
    }
  } else {
    const absDataset = resolve(data.dataset);
    const dataset = await loadDataset(absDataset);
    datasetName = dataset.name;
    datasetHash = hashDatasetFile(absDataset);
    for await (const s of dataset.samples) samples.push(s);
  }
  if (samples.length === 0) die(`dataset "${datasetName}" yielded zero samples`);

  // Optimizer train/dev sets (mirrors `optimize`: registry splits when both
  // populated, else the deterministic inline 70/30 split).
  type OptimizerSample = { id: string; input: string; expected_output?: string };
  const toOptimizerSample = (s: Sample): OptimizerSample => ({
    id: s.id,
    input: s.input,
    ...(s.expected_output !== undefined ? { expected_output: s.expected_output } : {}),
  });
  const originalById = new Map(samples.map((s) => [s.id, s] as const));
  let trainSet: OptimizerSample[];
  let devSet: OptimizerSample[];
  if (registrySplits !== undefined) {
    trainSet = registrySplits.train.map(toOptimizerSample);
    devSet = registrySplits.dev.map(toOptimizerSample);
  } else {
    if (samples.length < 2) {
      die(
        `dataset has ${samples.length} sample(s) — the optimizer needs at least 2 (70/30 train/dev split)`,
      );
    }
    const splitIdx = Math.max(1, Math.floor(samples.length * 0.7));
    trainSet = samples.slice(0, splitIdx).map(toOptimizerSample);
    devSet = samples.slice(splitIdx).map(toOptimizerSample);
  }
  const devById = new Map(devSet.map((s) => [s.id, s] as const));

  // Mutator: flag > credential-aware default (claude when an Anthropic
  // credential is present, rule-based fallback otherwise — the loop still
  // runs and gates, only the rewrites are deterministic).
  const mutatorFlag = strFlag(args, "mutator");
  let mutatorChoice: "rule-based" | "claude";
  if (mutatorFlag !== undefined) {
    if (mutatorFlag !== "rule-based" && mutatorFlag !== "claude") {
      die(`unknown --mutator "${mutatorFlag}" — supported: rule-based, claude`);
    }
    mutatorChoice = mutatorFlag;
  } else {
    const hasAnthropicCred =
      (process.env["ANTHROPIC_API_KEY"] ?? "") !== "" ||
      (process.env["ANTHROPIC_AUTH_TOKEN"] ?? "") !== "";
    mutatorChoice = hasAnthropicCred ? "claude" : "rule-based";
    if (!hasAnthropicCred) {
      process.stderr.write(
        "crewhaus: [flywheel] no ANTHROPIC credential — falling back to the rule-based mutator (model-driven rewrites disabled)\n",
      );
    }
  }
  const mutatorImpl =
    mutatorChoice === "claude" ? await createClaudeMutatorForSpec(absSpec) : undefined;

  const runId = `fly_${Date.now().toString(16)}`;
  const outRoot = resolve(join(".crewhaus", "flywheel", runId));
  mkdirSync(outRoot, { recursive: true });
  process.stdout.write(
    `[flywheel] runId=${runId} spec=${specPath} dataset=${datasetName} ` +
      `(${samples.length} samples; ${trainSet.length} train / ${devSet.length} dev) ` +
      `mutator=${mutatorChoice} iterations=${knobs.iterations} budget=$${knobs.budgetUsd.toFixed(2)} ` +
      `seed=${knobs.seed} concurrency=${knobs.concurrency}${dryRun ? " DRY-RUN" : ""}\n`,
  );

  // ---- injected steps (see runFlywheelLoop in ./flywheel.ts) ----

  const compileCheck = (yaml: string): void => {
    // Offline parse → lower. Throws SpecParseError / CompilerError (both
    // CrewhausError) on a spec the compiler rejects.
    lower(parseSpec(yaml));
  };

  const evalRun = async (label: "before" | "after", yaml: string) => {
    const evalIr = lower(parseSpec(yaml));
    if (evalIr.target !== "cli") {
      throw new Error(`flywheel eval requires target: cli (got "${evalIr.target}")`);
    }
    process.stdout.write(
      `[flywheel] ${label} eval: ${samples.length} samples → ${join(outRoot, label)}\n`,
    );
    const summary = await runEvalLib({
      ir: evalIr,
      dataset: { name: datasetName, samples: makeAsyncIterable(samples) },
      compiledGraders: compiled,
      opts: {
        outDir: join(outRoot, label),
        concurrency: knobs.concurrency,
        seed: knobs.seed,
        datasetHash,
        retryErrors: true,
      },
    });
    process.stdout.write(
      `[flywheel] ${label} pass_rate=${(summary.aggregates.passRate * 100).toFixed(1)}% ` +
        `mean_score=${summary.aggregates.meanScore.toFixed(3)} errors=${summary.aggregates.errorCount}\n`,
    );
    return summary;
  };

  // Item 7 — same failure-arbiter pre-filter as `optimize` (noise and
  // evidence-backed contract-ambiguity are withheld from the mutator's
  // failure signal; the queue prints at the end of the run).
  const datasetFixQueue = new Map<string, string>();
  const stickyAmbiguous = new Set<string>();
  let evalCallSeq = 0;
  const fitness = async (
    prompt: string,
  ): Promise<import("@crewhaus/prompt-optimizer").FitnessResult> => {
    const yamlText = readFileSync(absSpec, "utf-8");
    const parsedTarget = parseSpec(yamlText).target;
    const { applySpecPatch } = await import("@crewhaus/spec-patch");
    const { yaml: patchedYaml } = applySpecPatch(yamlText, {
      target: parsedTarget as never,
      path: ["agent", "instructions"],
      op: "replace",
      value: prompt,
    });
    let candidateIr: ReturnType<typeof lower>;
    try {
      candidateIr = lower(parseSpec(patchedYaml));
    } catch (err) {
      if (err instanceof SpecParseError) {
        process.stderr.write("[flywheel] candidate compiled invalid spec, skipping\n");
        return { score: 0 };
      }
      throw err;
    }
    if (candidateIr.target !== "cli") return { score: 0 };
    evalCallSeq += 1;
    const summary = await runEvalLib({
      ir: candidateIr,
      dataset: { name: datasetName, samples: makeAsyncIterable(devSet) },
      compiledGraders: compiled,
      opts: {
        outDir: join(
          outRoot,
          "optimize",
          "evals",
          `${String(evalCallSeq).padStart(3, "0")}_${prompt.length}`,
        ),
        concurrency: knobs.concurrency,
        seed: knobs.seed,
        retryErrors: true,
      },
    });
    let excludedFromSignal: ReadonlySet<string> = new Set<string>();
    try {
      const triage = triageFitnessSamples({
        samples: summary.samples,
        samplesById: originalById,
        alreadyAmbiguous: stickyAmbiguous,
      });
      for (const a of triage.ambiguous) {
        datasetFixQueue.set(a.sampleId, a.reason);
        if (a.fromGraderEvidence) stickyAmbiguous.add(a.sampleId);
      }
      excludedFromSignal = triage.excluded;
      const line = formatFitnessTriageLine(triage);
      if (line !== undefined) process.stdout.write(`[flywheel] ${line}\n`);
    } catch (err) {
      process.stderr.write(
        `[flywheel] triage skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const grades = summary.samples
      .filter((r) => !excludedFromSignal.has(r.sampleId))
      .map((r) => {
        const dev = devById.get(r.sampleId);
        return {
          input: dev?.input ?? r.sampleId,
          score: r.grades.overall.score,
          ...(dev?.expected_output !== undefined ? { expected: dev.expected_output } : {}),
          rationale: r.grades.overall.rationale,
        };
      });
    return { score: summary.aggregates.passRate, grades, runDir: summary.outDir };
  };

  let optimizeResult: Awaited<ReturnType<typeof optimizeSpec>> | undefined;
  const optimizeStep = async (): Promise<FlywheelOptimizeOutcome> => {
    process.stdout.write(
      `[flywheel] optimize: ${knobs.iterations} iteration(s), budget $${knobs.budgetUsd.toFixed(2)}, instructions only (permissions are never optimizer-patchable)\n`,
    );
    const traceBus = new TraceEventBus({ runId, sessionId: runId });
    const result = await optimizeSpec({
      specPath: absSpec,
      fitness,
      trainSet,
      devSet,
      iterations: knobs.iterations,
      seed: knobs.seed,
      outDir: join(outRoot, "optimize"),
      // Accept-then-write: the search NEVER writes the source; the patch is
      // applied by applyAccepted only after the acceptance gate passes.
      writeBack: false,
      runId,
      traceBus,
      budgetUsd: knobs.budgetUsd,
      ...(mutatorImpl !== undefined ? { mutator: mutatorImpl } : {}),
    });
    optimizeResult = result;
    process.stdout.write(
      `[flywheel] optimize: dev score ${result.scoreBefore.toFixed(3)} → ${result.scoreAfter.toFixed(3)} ` +
        `spend ${result.spend.totalUsd}` +
        `${result.stoppedReason === "budget-reached" ? " (stopped: budget reached)" : ""}\n`,
    );
    return {
      applied: result.applied,
      patchedYaml: result.patchedYaml,
      runId: result.runId,
      outDir: result.outDir,
      scoreBefore: result.scoreBefore,
      scoreAfter: result.scoreAfter,
      mutatorName: mutatorChoice,
      iterations: knobs.iterations,
      spendUsd: result.spend.totalUsd,
    };
  };

  const applyAccepted = async (outcome: FlywheelOptimizeOutcome): Promise<void> => {
    // The kept `optimize --write-back` semantics: stamp the provenance
    // header spec-changelog distills, write the source, then auto-register
    // (+ changelog) and pin the fail→pass recoveries into the per-spec
    // regression suite — exactly what a successful --write-back does.
    const { formatWriteBackHeader } = await import("@crewhaus/spec-patch");
    const stamped = `${formatWriteBackHeader({
      runId: outcome.runId,
      mutator: outcome.mutatorName,
      scoreBefore: outcome.scoreBefore,
      scoreAfter: outcome.scoreAfter,
      iterations: outcome.iterations,
    })}${outcome.patchedYaml}`;
    writeFileSync(absSpec, stamped);
    process.stdout.write(`[flywheel] wrote patched YAML to ${absSpec}\n`);
    await autoRegisterSpec(stamped, { patchJsonPath: join(outcome.outDir, "patch.json") });
    try {
      const pin = await pinRecoveriesAfterOptimize({
        registry,
        specName: ir.name,
        pin: true,
        ...(optimizeResult?.baselineEvalDir !== undefined
          ? { baselineRunDir: optimizeResult.baselineEvalDir }
          : {}),
        ...(optimizeResult?.bestEvalDir !== undefined
          ? { candidateRunDir: optimizeResult.bestEvalDir }
          : {}),
        samplesById: originalById,
        sourceDataset: datasetName,
        optimizeRunId: outcome.runId,
      });
      if (pin !== undefined && pin.pinned > 0) {
        process.stdout.write(
          `[flywheel] pinned ${pin.pinned} recovered samples → ${pin.suiteName}@${pin.version}\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[flywheel] regression pinning skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  const result = await runFlywheelLoop({
    sourceYaml,
    dryRun,
    hooks: { compileCheck, evalRun, optimize: optimizeStep, applyAccepted },
  });

  // The demo's step-4 diff artifact (before vs after, side by side), for
  // the PR body / a human eyeball. Informational — never fails the run.
  if (result.before !== undefined && result.after !== undefined) {
    try {
      const diff = diffReports(
        await loadRun(join(outRoot, "before")),
        await loadRun(join(outRoot, "after")),
      );
      const diffDir = join(outRoot, "diff");
      mkdirSync(diffDir, { recursive: true });
      writeFileSync(join(diffDir, "index.html"), diff.html);
      writeFileSync(join(diffDir, "diff.json"), diff.json);
    } catch {
      // Same sample ids on both sides by construction; a diff failure here
      // only costs the artifact.
    }
  }

  // Item 7 — surface the queued contract-ambiguity samples (dataset fixes,
  // not prompt mutations). Empty queue → silent.
  for (const line of formatDatasetFixQueue(datasetFixQueue)) {
    process.stdout.write(`[flywheel] ${line}\n`);
  }

  for (const line of formatFlywheelReport(result, {
    specPath,
    datasetName,
    sampleCount: samples.length,
    budgetUsd: knobs.budgetUsd,
    artifactsDir: outRoot,
  })) {
    process.stdout.write(`[flywheel] ${line}\n`);
  }

  // Rejection/no-improvement is success-by-doing-nothing (exit 0, like the
  // demo); a patch the compiler rejects is an optimizer bug — exit 1.
  if (result.outcome === "patch-compile-failed") die(result.reason);
}

/** Materialize a streaming dataset. Only invoked lazily by the item-9
 *  regression union once a `<specName>-regressions` suite actually exists,
 *  so the streaming file-dataset path stays streaming when there is none. */
async function collectSamples(iter: AsyncIterable<Sample>): Promise<Sample[]> {
  const out: Sample[] = [];
  for await (const s of iter) out.push(s);
  return out;
}

async function runEvalSubcommand(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus eval <spec.yaml> --dataset <data> --graders <graders.yaml> " +
        "[--judge-model <model>] [--concurrency N] [--seed N] [-o <out-dir>] " +
        "[--gate] [--no-promote] [--no-regressions] [--no-retry] [--models <m1,m2,...>]\n" +
        "  --dataset takes a file path (jsonl/csv/yaml/http) or registry:<name>[@version][#split]\n" +
        "  — a Section 29 dataset-registry ref (.crewhaus/datasets, or CREWHAUS_DATASETS_DIR).\n" +
        "  Default version: latest; default samples: the union of all splits (give #train,\n" +
        "  #dev, or #test to eval one split). Runs key into the history index/baselines as\n" +
        "  <name>@<version>[#split] with a content hash derived from the record's sample hashes.\n" +
        "  -o defaults to .crewhaus/evals/<runId>. Every run is appended to\n" +
        "  .crewhaus/evals/index.jsonl and diffed against the pinned baseline for its\n" +
        "  (spec, dataset) pair (.crewhaus/evals/baselines.json). The first run for a\n" +
        "  pair pins the baseline; later runs auto-promote when the regression gate\n" +
        "  passes. --no-promote keeps the existing pin; --gate exits non-zero when the\n" +
        "  gate fails (any pass-rate drop or sample-level pass→fail flip).\n" +
        "  When the registry contains <specName>-regressions (pinned by `crewhaus optimize`),\n" +
        "  its samples are unioned into the dataset by default (dedupe by id, primary wins).\n" +
        "  When the union actually ADDS samples, datasetName/datasetHash reflect it\n" +
        "  (`+regressions@vX` suffix + folded hash), so the first adding union starts a new\n" +
        "  baseline lineage by design; a union that adds nothing keeps the primary identity\n" +
        "  (and lineage) untouched. --no-regressions skips the union.\n" +
        "  Samples whose run ERRORS (provider timeout, 429, a grader/judge throw — infra\n" +
        "  noise, not a graded failure) are retried once by default; the retried outcome\n" +
        "  replaces the errored one and is tagged retried:true in results.json (the summary\n" +
        "  line and run index report the retried count). --no-retry disables the retry.\n" +
        "  After the run, every failing sample is triaged by the failure arbiter into\n" +
        "  bug / spec-gap / noise / contract-ambiguity: verdicts land in <out>/verdicts.json\n" +
        "  + a report section + a one-line `triage:` summary. Triage never pins samples the\n" +
        "  run's own dataset already contains, never pins errored samples, and skips pinning\n" +
        "  entirely when the run looks infrastructure-failed. Best-effort — a triage failure\n" +
        "  never fails the eval. Matrix cells (--models) skip triage.\n" +
        "  --judge-model accepts the full router grammar (claude-*, openai/<m>, gemini/<m>,\n" +
        "  bedrock/<id>, local/<m>@<url>); the default judge claude-sonnet-4-5 requires\n" +
        "  Anthropic credentials (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY)\n" +
        "  --models <m1,m2,...> runs a benchmark matrix: the SAME dataset (resolved once,\n" +
        "  regression union included) and graders once per model, patching the spec's\n" +
        "  agent.model in-memory like `run --model`. Model strings take the full router\n" +
        "  grammar and are validated before the first cell runs. Each cell writes a full\n" +
        "  run dir to <out>/<model-slug>/ (default out: .crewhaus/evals/matrix_<id>), so\n" +
        "  `eval-report diff` works on any pair of cells; the matrix root gets matrix.json\n" +
        "  + index.html (pass rate, mean score, latency, tokens, projected $/1k samples —\n" +
        "  unknown pricing shows n/a). Matrix cells skip the run-history index/baselines\n" +
        "  (they are comparisons, not lineage), so --gate/--no-promote are rejected. A\n" +
        "  cell that crashes (bad credentials, 404 model) records an error row and the\n" +
        "  remaining cells still run; the command then exits non-zero.\n",
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
  const gateRequested = args.flags["gate"] === true;
  const promote = args.flags["no-promote"] !== true;

  // Item 11 — `--models` benchmark matrix. Validate the flag combo and every
  // model string (full router grammar) up front: a typo in model 3 must fail
  // before cell 1 burns tokens.
  const modelsFlag = args.flags["models"];
  let matrixModels: string[] | undefined;
  if (typeof modelsFlag === "string") {
    try {
      assertMatrixFlagsCompatible({
        gate: gateRequested,
        noPromote: args.flags["no-promote"] === true,
      });
      matrixModels = parseModelsFlag(modelsFlag);
    } catch (err) {
      if (err instanceof MatrixArgError) die(err.message);
      throw err;
    }
  }

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

  // Item 12 — `--dataset registry:<name>[@version][#split]` resolves via the
  // Section 29 dataset registry instead of loadDataset. datasetName becomes
  // `<name>@<version>[#split]` and datasetHash a stable digest of the
  // record's per-sample content hashes, so the item-3 run-index/baseline
  // features key on registry content exactly like they key on file bytes.
  // Bare paths keep the pre-existing loadDataset + hashDatasetFile path.
  let dataset: { name: string; samples: AsyncIterable<Sample> };
  let datasetHash: string;
  let registryRef: ReturnType<typeof parseRegistryRef>;
  try {
    registryRef = parseRegistryRef(datasetPath);
  } catch (err) {
    if (err instanceof DatasetRefError) die(err.message);
    throw err;
  }
  if (registryRef !== undefined) {
    const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
    let resolved: Awaited<ReturnType<typeof resolveRegistryRef>>;
    try {
      resolved = await resolveRegistryRef(registry, registryRef);
    } catch (err) {
      if (err instanceof DatasetRefError || err instanceof CrewhausError) die(err.message);
      throw err;
    }
    if (resolved.samples.length === 0) {
      die(`dataset "${resolved.datasetName}" yielded zero samples`);
    }
    dataset = { name: resolved.datasetName, samples: makeAsyncIterable(resolved.samples) };
    datasetHash = resolved.datasetHash;
  } else {
    const absDataset = resolve(datasetPath);
    dataset = await loadDataset(absDataset);
    // Content hash of the dataset file — recorded in run.json/results.json and
    // the run-history index so lineage changes are detectable later.
    datasetHash = hashDatasetFile(absDataset);
  }

  // Item 9 — union the per-spec regression suite (<specName>-regressions,
  // pinned by `crewhaus optimize`) into the loaded dataset by default,
  // deduped by sample id (the primary dataset wins on collision). A union
  // that ADDS samples changes the run's sample keyset, so datasetName gets a
  // `+regressions@vX` suffix and datasetHash folds the suite's content hash
  // in — the item-3 run index/baselines then key on the honest union lineage
  // (the first adding union starts a new baseline lineage by design); a
  // union that adds nothing keeps the primary identity so the existing
  // lineage stays comparable. Best-effort AND stream-loss-proof: a broken
  // suite record warns and falls back to the (already materialized when
  // consumed) primary samples — see applyRegressionUnionGuarded.
  {
    const outcome = await applyRegressionUnionGuarded({
      registry: createFileBackedRegistry({ rootDir: defaultDatasetsRoot() }),
      specName: ir.name,
      includeRegressions: args.flags["no-regressions"] !== true,
      ...(registryRef !== undefined ? { primaryRegistryName: registryRef.name } : {}),
      primary: dataset,
      datasetHash,
    });
    dataset = { name: outcome.datasetName, samples: outcome.samples };
    datasetHash = outcome.datasetHash;
    if (outcome.union !== undefined && outcome.union.added > 0) {
      process.stdout.write(
        `[eval] + ${outcome.union.added} regression samples from ${outcome.union.suiteName}@${outcome.union.suiteVersion}\n`,
      );
    }
  }

  // Item 7 — the runner's noise auto-retry is ON by default; `--no-retry`
  // opts out (threaded into matrix cells and the single-run path alike).
  const retryErrors = args.flags["no-retry"] !== true;

  // Item 11 — matrix mode: everything above (spec lowering, graders, item-12
  // registry resolution, item-9 regression union) ran ONCE, so every model
  // sees the identical sample set. The matrix path never reaches the item-3
  // finishEvalRun flow below — nor the item-7 triage (matrix cells are model
  // comparisons; per-cell verdicts/pins would write N conflicting triages).
  if (matrixModels !== undefined) {
    return runEvalMatrixCommand({
      ir,
      models: matrixModels,
      datasetName: dataset.name,
      samples: await collectSamples(dataset.samples),
      datasetHash,
      compiled,
      retryErrors,
      ...(typeof outDirArg === "string" ? { outDirArg } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
    });
  }

  // Item 7 — tee the samples flowing into the runner so post-eval triage can
  // join each failing SampleResult back to its dataset Sample (reference +
  // metadata) and pin bug-class samples as they live in the source dataset.
  const triageSamplesById = new Map<string, Sample>();
  dataset = { name: dataset.name, samples: tapSamples(dataset.samples, triageSamplesById) };

  const outDest =
    typeof outDirArg === "string" ? resolve(outDirArg) : join(".crewhaus", "evals", "<runId>");
  process.stdout.write(`[eval] running ${dataset.name}: ${compiled.length} graders → ${outDest}\n`);

  const summary = await runEvalLib({
    ir,
    dataset,
    compiledGraders: compiled,
    opts: {
      ...(typeof outDirArg === "string" ? { outDir: resolve(outDirArg) } : {}),
      datasetHash,
      retryErrors,
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
    },
  });
  // With -o omitted the runner picks .crewhaus/evals/<runId> relative to the
  // cwd — resolve to an absolute path for the report + history index.
  const absOut = resolve(summary.outDir);

  // Item 7 — failure-arbiter triage: classify every failing sample into
  // bug / spec-gap / noise / contract-ambiguity, persist verdicts.json next
  // to results.json, print the one-line `triage:` summary, and pin the
  // promoteRegression (bug-class) samples into <specName>-regressions.
  // finishEvalTriage is best-effort by construction (warns, never throws);
  // the outer catch is belt-and-braces so triage can NEVER fail the eval.
  let triageVerdicts: Awaited<ReturnType<typeof finishEvalTriage>>;
  try {
    triageVerdicts = await finishEvalTriage({
      samples: summary.samples,
      samplesById: triageSamplesById,
      runId: summary.runId,
      outDir: absOut,
      specName: ir.name,
      sourceDataset: dataset.name,
      registry: createFileBackedRegistry({ rootDir: defaultDatasetsRoot() }),
      pin: args.flags["no-regressions"] !== true,
    });
  } catch (err) {
    process.stderr.write(
      `[eval] triage skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Render report (with the triage section when the run had failures).
  const loaded = await loadRun(absOut);
  const rendered = renderReport(
    loaded,
    triageVerdicts !== undefined ? { verdicts: triageVerdicts } : {},
  );
  writeFileSync(join(absOut, "index.html"), rendered.html);

  // Item 7/F12 — surface retry activity: how many recorded outcomes replaced
  // an errored first attempt (also recorded in the run index as retriedCount).
  const retriedCount = summary.samples.filter((s) => s.retried === true).length;
  process.stdout.write(
    `[eval] runId=${summary.runId} pass_rate=${(summary.aggregates.passRate * 100).toFixed(1)}% ` +
      `mean_score=${summary.aggregates.meanScore.toFixed(3)} ` +
      `errors=${summary.aggregates.errorCount} ` +
      `tokens=${summary.aggregates.totalTokens.input}/${summary.aggregates.totalTokens.output}` +
      `${retriedCount > 0 ? ` (${retriedCount} retried)` : ""}\n`,
  );
  process.stdout.write(`[eval] report: ${join(absOut, "index.html")}\n`);

  // Run-history: append to the index, diff/gate against the pinned baseline,
  // and promote per policy (see apps/cli/src/eval-history.ts).
  const finish = await finishEvalRun({
    summary,
    specName: ir.name,
    datasetHash,
    outDir: absOut,
    gateRequested,
    promote,
  });
  if (finish.gateFailed) {
    die(`eval --gate: ${finish.gateReason ?? "regression gate failed"}`);
  }
}

/**
 * Item 11 — `eval --models` matrix execution: one cell per model over the
 * already-resolved sample set, each patching the lowered ir's `agent.model`
 * in-memory (the same one-line substitution `run --model` does) and writing
 * a full run dir to `<root>/<model-slug>/`. Cells deliberately skip the
 * item-3 finishEvalRun index/baseline/gate flow — they are comparisons, not
 * lineage runs. One cell crashing records an error row and the loop
 * continues; ANY crashed cell maps to a non-zero exit after the matrix is
 * rendered (distinct from cells that ran with failing samples, which is a
 * normal result).
 */
async function runEvalMatrixCommand(opts: {
  readonly ir: Extract<ReturnType<typeof lower>, { target: "cli" }>;
  readonly models: ReadonlyArray<string>;
  readonly datasetName: string;
  readonly samples: ReadonlyArray<Sample>;
  readonly datasetHash: string;
  readonly compiled: ReadonlyArray<CompiledGrader>;
  /** Item 7 — `!--no-retry`, threaded into every cell's runner options. */
  readonly retryErrors: boolean;
  readonly outDirArg?: string;
  readonly concurrency?: number;
  readonly seed?: number;
  readonly judgeModel?: string;
}): Promise<void> {
  const rootDir =
    typeof opts.outDirArg === "string"
      ? resolve(opts.outDirArg)
      : resolve(join(".crewhaus", "evals", `matrix_${randomBytes(8).toString("hex")}`));
  mkdirSync(rootDir, { recursive: true });
  process.stdout.write(
    `[eval] matrix: ${opts.models.length} models × ${opts.samples.length} samples ` +
      `(${opts.datasetName}) → ${rootDir}\n`,
  );

  const cells = await runMatrixCells({
    models: opts.models,
    slugs: assignCellSlugs(opts.models),
    rootDir,
    runCell: async (model, cellOutDir) => {
      const summary = await runEvalLib({
        ir: { ...opts.ir, agent: { ...opts.ir.agent, model } },
        dataset: { name: opts.datasetName, samples: makeAsyncIterable(opts.samples) },
        compiledGraders: opts.compiled,
        opts: {
          outDir: cellOutDir,
          datasetHash: opts.datasetHash,
          retryErrors: opts.retryErrors,
          ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
        },
      });
      // Same per-cell artifact set as a single-model run (results.json +
      // index.html), so `eval-report diff <cellA> <cellB>` works on any pair.
      writeFileSync(join(cellOutDir, "index.html"), renderReport(await loadRun(cellOutDir)).html);
      return summary;
    },
  });

  const matrix = buildMatrix(cells, { pricing: defaultMatrixPricing() });
  const rendered = renderMatrix(matrix);
  writeFileSync(join(rootDir, "matrix.json"), rendered.json);
  writeFileSync(join(rootDir, "index.html"), rendered.html);

  writeTable(
    ["model", "status", "pass_rate", "mean_score", "p95_latency", "est_$/1k"],
    matrix.rows.map((r) => [
      r.model,
      r.status === "ok" ? "ok" : "ERROR",
      r.passRate !== undefined ? `${(r.passRate * 100).toFixed(1)}%` : "n/a",
      r.meanScore !== undefined ? r.meanScore.toFixed(3) : "n/a",
      r.p95LatencyMs !== undefined ? `${Math.round(r.p95LatencyMs)}ms` : "n/a",
      r.costPer1kSamplesUsd !== undefined ? formatUsd(r.costPer1kSamplesUsd) : "n/a",
    ]),
  );
  process.stdout.write(`[eval] matrix json: ${join(rootDir, "matrix.json")}\n`);
  process.stdout.write(`[eval] matrix report: ${join(rootDir, "index.html")}\n`);

  const crashed = matrix.rows.filter((r) => r.status === "error");
  if (crashed.length > 0) {
    const names = crashed.map((r) => r.model).join(", ");
    die(`eval --models: ${crashed.length}/${matrix.rows.length} cell(s) failed to run: ${names}`);
  }
}

async function runEvalReport(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus eval-report <action>\n" +
        "  diff <prev> <new> [-o <out-dir>]            compare two eval runs and emit a diff report\n" +
        "  history [--spec <name>] [--dataset <name>]  list recorded runs (.crewhaus/evals/index.jsonl)\n" +
        "  baseline show [--spec <n>] [--dataset <n>]  print pinned baselines (.crewhaus/evals/baselines.json)\n" +
        "  baseline set <runId>                        pin a recorded run as its (spec, dataset) baseline\n" +
        "  --dataset matches the recorded name exactly OR with a `+` suffix segment, so\n" +
        "  `--dataset smoke` also finds runs recorded under the regression-suite union\n" +
        "  name `smoke+regressions@vX`.\n",
    );
    return;
  }
  const action = args.positional[0];
  switch (action) {
    case "diff":
      await runEvalReportDiff(args);
      return;
    case "history":
      runEvalReportHistory(args);
      return;
    case "baseline":
      runEvalReportBaseline(args);
      return;
    default:
      die(`eval-report: unknown action "${action ?? ""}" — supported: diff, history, baseline`);
  }
}

async function runEvalReportDiff(args: ParsedArgs): Promise<void> {
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

/** Filter helper shared by `history` and `baseline show`. The dataset
 *  filter also matches `<filter>+…` union names — see datasetFilterMatches. */
function matchesEvalFilters(args: ParsedArgs, specName: string, datasetName: string): boolean {
  const specFilter = args.flags["spec"];
  const datasetFilter = args.flags["dataset"];
  if (typeof specFilter === "string" && specName !== specFilter) return false;
  if (typeof datasetFilter === "string" && !datasetFilterMatches(datasetFilter, datasetName)) {
    return false;
  }
  return true;
}

/** Render rows as space-padded columns (last column unpadded). */
function writeTable(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: ReadonlyArray<string>): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? c.length)))
      .join("  ")
      .trimEnd();
  process.stdout.write(`${line(header)}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}

function runEvalReportHistory(args: ParsedArgs): void {
  const entries = readRunIndex().filter((e) => matchesEvalFilters(args, e.specName, e.datasetName));
  if (entries.length === 0) {
    process.stdout.write(
      `[eval-report] no recorded runs match (${join(".crewhaus", "evals", "index.jsonl")})\n`,
    );
    return;
  }
  // Mark the run(s) currently pinned as a baseline with `*`.
  const pinnedRunIds = new Set(Object.values(readBaselines()).map((b) => b.runId));
  writeTable(
    [
      "ts",
      "runId",
      "spec",
      "dataset",
      "pass_rate",
      "mean_score",
      "samples",
      "retried",
      "base",
      "outDir",
    ],
    entries.map((e) => [
      e.ts,
      e.runId,
      e.specName,
      e.datasetName,
      `${(e.passRate * 100).toFixed(1)}%`,
      e.meanScore.toFixed(3),
      String(e.sampleCount),
      // Additive field — entries recorded before it existed read as 0.
      String(e.retriedCount ?? 0),
      pinnedRunIds.has(e.runId) ? "*" : "",
      e.outDir,
    ]),
  );
}

function runEvalReportBaseline(args: ParsedArgs): void {
  const sub = args.positional[1];
  switch (sub) {
    case "show": {
      const pins = Object.values(readBaselines()).filter((b) =>
        matchesEvalFilters(args, b.specName, b.datasetName),
      );
      if (pins.length === 0) {
        process.stdout.write(
          `[eval-report] no baselines pinned (${join(".crewhaus", "evals", "baselines.json")})\n`,
        );
        return;
      }
      writeTable(
        ["spec", "dataset", "runId", "pinned_at", "outDir"],
        pins.map((b) => [b.specName, b.datasetName, b.runId, b.ts, b.outDir]),
      );
      return;
    }
    case "set": {
      const runId = args.positional[2];
      if (typeof runId !== "string") die("eval-report baseline set: missing <runId>");
      // Latest index entry wins if a runId somehow appears twice.
      const index = readRunIndex();
      let entry: RunIndexEntry | undefined;
      for (let i = index.length - 1; i >= 0; i--) {
        if (index[i]?.runId === runId) {
          entry = index[i];
          break;
        }
      }
      if (entry === undefined) {
        die(
          `eval-report baseline set: runId "${runId}" not found in ` +
            `${join(".crewhaus", "evals", "index.jsonl")} — run \`crewhaus eval-report history\``,
        );
      }
      setBaseline({
        specName: entry.specName,
        datasetName: entry.datasetName,
        runId: entry.runId,
        outDir: entry.outDir,
        datasetHash: entry.datasetHash,
        ts: new Date().toISOString(),
      });
      process.stdout.write(
        `[eval-report] baseline set: ${entry.specName}/${entry.datasetName} → ${entry.runId}\n`,
      );
      return;
    }
    default:
      die(`eval-report baseline: unknown action "${sub ?? ""}" — supported: show, set`);
  }
}

/**
 * Item 12 — `crewhaus datasets <action>`: the CLI face of Section 29's
 * dataset-registry (versioned, split-aware datasets under `.crewhaus/datasets`
 * or CREWHAUS_DATASETS_DIR — the same root the emitted eval-bundle harness
 * reads). Mirrors eval-report's action-dispatch pattern; the resolution and
 * split logic lives in `./datasets` so it is unit-testable.
 */
async function runDatasets(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus datasets <action>\n" +
        "  list                                        all datasets + versions (split sizes, createdAt)\n" +
        "  get <name>[@version] [--split train|dev|test]\n" +
        "                                              print samples as JSONL to stdout. Default: the\n" +
        "                                              latest version, all splits merged with a top-level\n" +
        "                                              `split` column; --split prints one split verbatim\n" +
        "  put <name> --file <data.jsonl|csv|yaml> [--split-spec 70/15/15 | --split train]\n" +
        "                                              import a dataset file as a new auto-bumped version\n" +
        "                                              (v1, v2, …). Split assignment is deterministic —\n" +
        "                                              stable by sample-id hash, no RNG — per the\n" +
        "                                              train/dev[/test] percentages (default 70/15/15);\n" +
        "                                              --split puts every sample into one named split\n" +
        "  registry root: .crewhaus/datasets (override with CREWHAUS_DATASETS_DIR)\n",
    );
    return;
  }
  const action = args.positional[0];
  try {
    switch (action) {
      case "list":
        await runDatasetsList();
        return;
      case "get":
        await runDatasetsGet(args);
        return;
      case "put":
        await runDatasetsPut(args);
        return;
      default:
        die(`datasets: unknown action "${action ?? ""}" — supported: list, get, put`);
    }
  } catch (err) {
    // DatasetRegistryError (invalid name/version, missing record) and the
    // ./datasets ref/spec errors both map to a clean one-line failure.
    if (err instanceof CrewhausError || err instanceof DatasetRefError) die(err.message);
    throw err;
  }
}

async function runDatasetsList(): Promise<void> {
  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  const names = [...(await registry.listDatasets())].sort();
  const rows: string[][] = [];
  for (const name of names) {
    for (const version of [...(await registry.list(name))].sort(compareVersions)) {
      try {
        const record = await registry.getRecord(name, version);
        rows.push([
          name,
          version,
          String(record.splits.train.length),
          String(record.splits.dev.length),
          record.splits.test !== undefined ? String(record.splits.test.length) : "-",
          record.createdAt,
        ]);
      } catch {
        // A torn/foreign file must not take down the whole listing.
      }
    }
  }
  if (rows.length === 0) {
    process.stdout.write(`[datasets] no datasets registered (${defaultDatasetsRoot()})\n`);
    return;
  }
  writeTable(["dataset", "version", "train", "dev", "test", "createdAt"], rows);
}

/** Validate a `--split` value or die (undefined when the flag is absent). */
function splitFlag(args: ParsedArgs): DatasetSplit | undefined {
  const flag = args.flags["split"];
  if (typeof flag !== "string") return undefined;
  if (!isDatasetSplit(flag)) die(`invalid --split "${flag}" — expected train, dev, or test`);
  return flag;
}

async function runDatasetsGet(args: ParsedArgs): Promise<void> {
  const refStr = args.positional[1];
  if (typeof refStr !== "string") die("datasets get: missing <name>[@version]");
  const split = splitFlag(args);
  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  const { name, version } = parseNameVersion(refStr);
  const resolvedVersion = version ?? (await latestVersion(registry, name));
  if (resolvedVersion === undefined) {
    die(`dataset "${name}" has no versions in the registry (${defaultDatasetsRoot()})`);
  }
  const record = await registry.getRecord(name, resolvedVersion);
  if (split !== undefined && record.splits[split] === undefined) {
    die(`split "${split}" not present in "${name}@${resolvedVersion}"`);
  }
  process.stdout.write(recordToJsonl(record, split));
}

async function runDatasetsPut(args: ParsedArgs): Promise<void> {
  const name = args.positional[1];
  if (typeof name !== "string") die("datasets put: missing <name>");
  const filePath = args.flags["file"];
  if (typeof filePath !== "string") die("datasets put: missing --file <dataset.jsonl>");
  const split = splitFlag(args);
  const splitSpecFlag = args.flags["split-spec"];
  if (split !== undefined && typeof splitSpecFlag === "string") {
    die("datasets put: --split and --split-spec are mutually exclusive");
  }
  const splitSpec =
    typeof splitSpecFlag === "string" ? parseSplitSpec(splitSpecFlag) : DEFAULT_SPLIT_SPEC;

  const dataset = await loadDataset(resolve(filePath));
  const samples: Sample[] = [];
  for await (const s of dataset.samples) samples.push(s);
  if (samples.length === 0) die(`datasets put: ${filePath} yielded zero samples`);

  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  const rec = await registerDataset({
    registry,
    name,
    samples,
    ...(split !== undefined ? { split } : { splitSpec }),
  });
  process.stdout.write(
    `[datasets] put ${rec.name}@${rec.version} ` +
      `(train ${rec.splits.train.length} / dev ${rec.splits.dev.length} / ` +
      `test ${rec.splits.test?.length ?? 0}) — use with --dataset registry:${rec.name}\n`,
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

// -------- advise: trace-mining spec advisor (item 14) --------

/**
 * `crewhaus advise [--session <id> | --all] [--json] [-o <dir>]` — build an
 * AdviceContext from `.crewhaus/sessions` JSONLs (+ `.crewhaus/audit`
 * records), run the advise-rules library, print ranked findings with
 * evidence, and write two artifacts into the out dir (default
 * `.crewhaus/advice`): `suggestions.json` (the validated SpecPatch list a
 * future `optimize --from-advice` consumes) and a self-contained
 * `report.html`. With neither `--session` nor `--all`, mines all sessions.
 *
 * The spec (for patch suggestions) is the cwd `crewhaus.yaml` per the
 * standalone-harness convention; a missing or unparseable spec downgrades
 * patch suggestions to advice text rather than blocking the mining.
 */
async function runAdvise(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus advise [--session <id> | --all] [--json] [-o <dir>]\n" +
        "\n" +
        "mines .crewhaus/sessions (+ .crewhaus/audit) for spec advice:\n" +
        "  repeated tool failures, max_tokens truncation pressure, compaction\n" +
        "  thrash, permission-ask churn, stop-reason anomalies\n" +
        "\n" +
        "  --session <id>  mine one session (default: all sessions)\n" +
        "  --json          print machine-readable findings to stdout\n" +
        "  -o <dir>        artifact dir for suggestions.json + report.html\n" +
        "                  (default .crewhaus/advice)\n",
    );
    return;
  }
  const sessionFlag = strFlag(args, "session");
  if (sessionFlag !== undefined && args.flags["all"] === true) {
    die("--session and --all are mutually exclusive");
  }

  const sessionsDir = join(process.cwd(), ".crewhaus", "sessions");
  const sessionFiles: string[] = [];
  if (sessionFlag !== undefined) {
    const file = join(sessionsDir, `${sessionFlag}.jsonl`);
    if (!existsSync(file)) die(`session log not found at ${file}`);
    sessionFiles.push(file);
  } else {
    if (!existsSync(sessionsDir)) {
      die(`no session logs found at ${sessionsDir} — run the agent first, then advise`);
    }
    for (const f of readdirSync(sessionsDir).sort()) {
      if (f.endsWith(".jsonl")) sessionFiles.push(join(sessionsDir, f));
    }
    if (sessionFiles.length === 0) {
      die(`no session logs found at ${sessionsDir} — run the agent first, then advise`);
    }
  }
  const sessions: SessionEvents[] = sessionFiles.map((file) => ({
    sessionId: basename(file).replace(/\.jsonl$/, ""),
    objects: parseAdviseJsonl(readFileSync(file, "utf-8")),
  }));

  // Audit records are optional context (kind counts land in the report's
  // future rules); a missing dir is the common case and skips silently.
  const auditDir = join(process.cwd(), ".crewhaus", "audit");
  const auditObjects: unknown[] = [];
  if (existsSync(auditDir)) {
    for (const f of readdirSync(auditDir).sort()) {
      if (!f.endsWith(".jsonl")) continue;
      auditObjects.push(...parseAdviseJsonl(readFileSync(join(auditDir, f), "utf-8")));
    }
  }

  // The cwd spec enables patch suggestions; without one (or with a broken
  // one) rules fall back to advice text — mining must not block on it.
  let spec: Spec | undefined;
  const specPath = join(process.cwd(), "crewhaus.yaml");
  if (existsSync(specPath)) {
    try {
      spec = parseSpec(readFileSync(specPath, "utf-8"));
    } catch (err) {
      process.stderr.write(
        `[advise] crewhaus.yaml did not parse (${(err as Error).message}) — patch suggestions downgraded to advice\n`,
      );
    }
  }

  const ctx = buildAdviceContext(sessions, auditObjects);
  const findings: AdviceFinding[] = runAdviceRules(ctx, spec !== undefined ? { spec } : {});
  const generatedAt = new Date().toISOString();
  const suggestions = buildSuggestionsFile(findings, ctx.sessionIds, generatedAt);

  const outDir = strFlag(args, "out") ?? join(process.cwd(), ".crewhaus", "advice");
  mkdirSync(outDir, { recursive: true });
  const suggestionsPath = join(outDir, "suggestions.json");
  const reportPath = join(outDir, "report.html");
  writeFileSync(suggestionsPath, `${JSON.stringify(suggestions, null, 2)}\n`);
  writeFileSync(
    reportPath,
    renderAdviceHtml({ findings, sessionIds: ctx.sessionIds, generatedAt }),
  );

  if (args.flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify({ sessionIds: ctx.sessionIds, findings, suggestions: suggestions.suggestions })}\n`,
    );
    return;
  }
  process.stdout.write(
    `advisor: ${findings.length} finding${findings.length === 1 ? "" : "s"} across ${ctx.sessionIds.length} session${ctx.sessionIds.length === 1 ? "" : "s"}\n`,
  );
  if (findings.length === 0) {
    process.stdout.write("no findings — the mined sessions look healthy\n");
  }
  for (const f of findings) {
    for (const line of formatFindingLines(f)) {
      process.stdout.write(`${line}\n`);
    }
  }
  process.stdout.write(`[advise] suggestions: ${suggestionsPath}\n`);
  process.stdout.write(`[advise] report: ${reportPath}\n`);
}

// -------- shared: read the N most-recent session logs by mtime --------

/**
 * Read the `limit` most-recently-modified session JSONLs (or ALL when
 * `limit === "all"`) from `.crewhaus/sessions`, folded into `SessionEvents`.
 * "Recent" is by mtime — session ids are random hex, so name order carries
 * no recency (mirrors `runDoctorContextPressure`). A missing dir yields an
 * empty list; the caller decides whether that is an error.
 */
function readRecentSessionEvents(limit: number | "all"): SessionEvents[] {
  const sessionsDir = join(process.cwd(), ".crewhaus", "sessions");
  if (!existsSync(sessionsDir)) return [];
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  const ranked = files
    .map((f) => {
      const file = join(sessionsDir, f);
      return { file, sessionId: f.replace(/\.jsonl$/, ""), mtimeMs: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chosen = limit === "all" ? ranked : ranked.slice(0, limit);
  return chosen.map((r) => ({
    sessionId: r.sessionId,
    objects: parseAdviseJsonl(readFileSync(r.file, "utf-8")),
  }));
}

/** Parse the `--sessions N|all` flag shared by tools audit + future miners. */
function parseSessionsFlag(args: ParsedArgs, dflt: number): number | "all" {
  const raw = strFlag(args, "sessions");
  if (raw === undefined) return dflt;
  if (raw === "all") return "all";
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) {
    die(`invalid --sessions "${raw}" — must be a positive integer or "all"`);
  }
  return n;
}

// -------- tools: builtin discovery + usage audit (item 18) --------

/**
 * `crewhaus tools <list|suggest|audit>` — the observer/advisor face over the
 * built-in tool catalog.
 *
 *   list             every builtin (name/description/scope/io/readOnly/…).
 *   suggest [spec]   deterministic keyword implication over agent.instructions
 *                    (default spec: cwd crewhaus.yaml).
 *   audit [--sessions N|all]  mine tool_stats across sessions vs. the spec's
 *                    grants — unused / failing / learned-readOnly. ADVICE-ONLY
 *                    (tools: is not optimizer-whitelisted; every edit is a
 *                    human-review suggestion).
 */
async function runTools(action: string, args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus tools <list|suggest|audit>\n" +
        "\n" +
        "  list                     print every builtin tool + its metadata\n" +
        "  suggest [spec.yaml]      rank builtins against agent.instructions\n" +
        "                           (deterministic keyword match; default spec\n" +
        "                           is ./crewhaus.yaml)\n" +
        "  audit [--sessions N|all] mine tool_stats across sessions vs. the\n" +
        "                           spec's tools: grants — unused / failing /\n" +
        "                           learned-readOnly (advice-only; tools: is not\n" +
        "                           optimizer-whitelisted)\n" +
        "\n" +
        "  --json  machine-readable output\n",
    );
    return;
  }
  const jsonMode = args.flags["json"] === true;
  const toolMap = await loadToolMap();

  if (action === "list") {
    const rows = buildToolList(toolMap);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify({ tools: rows }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${rows.length} builtin tool(s):\n`);
    for (const line of formatToolListLines(rows)) process.stdout.write(`${line}\n`);
    return;
  }

  if (action === "suggest") {
    const specPath = args.positional[0] ?? join(process.cwd(), "crewhaus.yaml");
    if (!existsSync(specPath)) {
      die(`spec not found at ${specPath} — pass a spec path or run from a harness dir`);
    }
    let spec: Spec;
    try {
      spec = parseSpec(readFileSync(specPath, "utf-8"));
    } catch (err) {
      die(`${specPath} did not parse: ${(err as Error).message}`);
    }
    const specRecord = spec as unknown as Record<string, unknown>;
    const agent = specRecord["agent"] as Record<string, unknown> | undefined;
    const instructions = typeof agent?.["instructions"] === "string" ? agent["instructions"] : "";
    const specTools = Array.isArray(specRecord["tools"])
      ? (specRecord["tools"] as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const result = suggestTools(instructions, specTools, CLI_RUNTIME_TOOL_KEYS, toolMap);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    for (const line of formatSuggestLines(result)) process.stdout.write(`${line}\n`);
    return;
  }

  if (action === "audit") {
    const limit = parseSessionsFlag(args, DEFAULT_AUDIT_SESSIONS);
    const sessions = readRecentSessionEvents(limit);
    if (sessions.length === 0) {
      die(
        `no session logs found at ${join(process.cwd(), ".crewhaus", "sessions")} — run the agent first, then audit`,
      );
    }
    // The cwd spec supplies the grant list; without one we still report the
    // failing/read-only findings mined purely from usage.
    let specTools: string[] = [];
    let hasExplicitToolList = false;
    const specPath = join(process.cwd(), "crewhaus.yaml");
    if (existsSync(specPath)) {
      try {
        const spec = parseSpec(readFileSync(specPath, "utf-8")) as unknown as Record<
          string,
          unknown
        >;
        if (Array.isArray(spec["tools"])) {
          specTools = (spec["tools"] as unknown[]).filter(
            (t): t is string => typeof t === "string",
          );
          hasExplicitToolList = true;
        }
      } catch (err) {
        process.stderr.write(
          `[tools audit] crewhaus.yaml did not parse (${(err as Error).message}) — auditing usage only\n`,
        );
      }
    }
    const usage = buildToolUsage(sessions);
    const result = auditTools({ sessions, specTools, usage, toolMap, hasExplicitToolList });
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `tools audit: ${result.findings.length} finding(s) across ${result.sessionIds.length} session(s)\n`,
    );
    for (const line of formatAuditLines(result)) process.stdout.write(`${line}\n`);
    return;
  }

  die(`tools action must be one of: list, suggest, audit (got "${action}")`);
}

/** Default sessions the `tools audit` miner scans (mirrors context-pressure). */
const DEFAULT_AUDIT_SESSIONS = 20;

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
        "[--graders-out <graders.yaml>] [--min-score F] [--judge] [--judge-model <model>] " +
        "[--register <name>]\n" +
        "  --register promotes the distilled samples into the Section 29 dataset registry\n" +
        "  (.crewhaus/datasets, or CREWHAUS_DATASETS_DIR) as a new auto-bumped version of\n" +
        "  <name> with the deterministic default 70/15/15 train/dev/test split (stable by\n" +
        "  sample-id hash), printing <name>@<version>. -o is optional when --register is\n" +
        "  given; without --register the plain file output is unchanged.\n",
    );
    return;
  }
  const outPath = args.flags["out"];
  const registerName = args.flags["register"];
  if (typeof outPath !== "string" && typeof registerName !== "string") {
    die("missing -o <dataset.jsonl> (or --register <name> to promote into the registry)");
  }
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

  // Plain file output — unchanged default; skipped only when the caller went
  // registry-only (--register without -o).
  let absOut: string | undefined;
  if (typeof outPath === "string") {
    absOut = resolve(outPath);
    mkdirSync(dirname(absOut), { recursive: true });
    writeFileSync(absOut, samplesToJsonl(result.samples), { mode: 0o600 });
  }

  const gradersOut = args.flags["graders-out"];
  if (typeof gradersOut === "string") {
    const absGraders = resolve(gradersOut);
    mkdirSync(dirname(absGraders), { recursive: true });
    writeFileSync(absGraders, gradersConfigToYaml(result.graders), { mode: 0o600 });
  }

  const { stats } = result;
  process.stdout.write(
    `[distill] ${stats.matchedTurns} rated turn(s) → ${result.samples.length} sample(s) ` +
      `(${stats.positives} positive, ${stats.negatives} low-rated)` +
      `${absOut !== undefined ? ` → ${absOut}` : ""}\n`,
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

  // Item 12 — versioned promotion into the Section 29 dataset registry: a new
  // auto-bumped version of <name> with the deterministic default 70/15/15
  // train/dev/test split (stable by sample-id hash — see datasets.ts).
  if (typeof registerName === "string") {
    const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
    try {
      const rec = await registerDataset({
        registry,
        name: registerName,
        samples: result.samples,
        splitSpec: DEFAULT_SPLIT_SPEC,
      });
      process.stdout.write(
        `[distill] registered ${rec.name}@${rec.version} ` +
          `(train ${rec.splits.train.length} / dev ${rec.splits.dev.length} / ` +
          `test ${rec.splits.test?.length ?? 0}) — use with --dataset registry:${rec.name}\n`,
      );
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
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

/**
 * Item 1 — post-session feedback teardown for the cli run path. Two halves,
 * both gated on the compiled spec's `feedback:` block:
 *
 *  1. Exit rating prompt: on a clean REPL exit with ≥1 assistant turn, a
 *     TTY, and no opt-out (CREWHAUS_NO_EXIT_RATING / feedback.exitPrompt:
 *     false), ask `rate this session? [g]ood / [b]ad / [enter] skip` — one
 *     keystroke, 10s timeout, appended to the session's event log via the
 *     same `user_feedback` record `crewhaus rate` writes (source "cli",
 *     rating the last turn). NEVER prompts in non-TTY/piped mode.
 *
 *  2. autoDistill consumer: when `feedback.autoDistill` is enabled and the
 *     accumulated store (all sessions + the web-UI feedback dir) holds
 *     enough unprocessed ratings past the watermark, run the existing
 *     distill() and register the result as a new version of the
 *     `<specName>-ratings` registry dataset (see ./autodistill.ts) —
 *     consumable as `--dataset registry:<specName>-ratings` by eval and
 *     optimize.
 */
async function runFeedbackTeardown(
  ir: Extract<ReturnType<typeof lower>, { target: "cli" }>,
  resumeId: string | undefined,
): Promise<void> {
  if (ir.feedback === undefined) return;

  // Resolve the session that just ran: the resumed id, else the most recent
  // session recorded for this spec name (the same resolution --continue
  // uses; runChatLoop does not return its sessionId).
  let sessionId = resumeId;
  if (sessionId === undefined) {
    const store = createSessionStore();
    const sessions = await store.list();
    sessionId = sessions.find((s: { name: string }) => s.name === ir.name)?.id;
  }

  // ---- half 1: the exit rating prompt ----
  if (sessionId !== undefined && existsSync(sessionJsonlPath(sessionId))) {
    const turns = deriveTurns(readSessionEvents(sessionId));
    const decision = shouldPromptExitRating({
      stdinIsTTY: process.stdin.isTTY === true,
      env: process.env,
      feedback: ir.feedback,
      assistantTurns: countAssistantTurns(turns),
    });
    if (decision.prompt && turns.length > 0) {
      const choice = parseExitRatingKey(await readExitRatingKey(EXIT_RATING_TIMEOUT_MS));
      if (choice !== "skip") {
        const turnNumber = (turns[turns.length - 1] as DerivedTurn).turnNumber;
        const record = buildFeedbackRecord({
          id: `fb_${randomBytes(6).toString("hex")}`,
          sessionId,
          turnNumber,
          ts: new Date().toISOString(),
          source: "cli",
          thumbs: choice,
        });
        const log = await openEventLog(sessionId, {
          rootDir: join(process.cwd(), SESSIONS_SUBDIR),
        });
        await log.append({ kind: FEEDBACK_EVENT_KIND, payload: record });
        process.stdout.write(
          `[feedback] recorded ${choice === "up" ? "good" : "bad"} on ${sessionId} turn ${turnNumber}\n`,
        );
      }
    }
  }

  // ---- half 2: the autoDistill consumer ----
  if (ir.feedback.autoDistill !== true) return;
  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const turns: SessionTurn[] = [];
  const records: FeedbackRecord[] = [];
  for (const id of listSessionIds(sessionsDir)) {
    const events = readSessionEvents(id);
    for (const t of deriveTurns(events)) turns.push({ ...t, sessionId: id });
    records.push(...extractFeedbackRecords(events));
  }
  records.push(...readFeedbackDir(join(process.cwd(), FEEDBACK_SUBDIR)));
  await maybeAutoDistill({
    specName: ir.name,
    feedback: ir.feedback,
    turns,
    records,
    registry: createFileBackedRegistry({ rootDir: defaultDatasetsRoot() }),
    stateFilePath: join(process.cwd(), DISTILL_STATE_RELPATH),
  });
}

/**
 * One raw-mode keystroke with a timeout (undefined on timeout or when
 * stdin is unusable). Thin IO by design — the prompt gate and the key
 * mapping are the unit-tested functions in ./autodistill.ts.
 */
async function readExitRatingKey(timeoutMs: number): Promise<string | undefined> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true || stdin.destroyed) return undefined;
  process.stdout.write(EXIT_RATING_PROMPT);
  return await new Promise<string | undefined>((resolveKey) => {
    let done = false;
    const finish = (v: string | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolveKey(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const onData = (chunk: Buffer | string): void => finish(chunk.toString());
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
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
 * Section 32 — `crewhaus build-image <target> --tag <tag> [--platform <p>] [--push] [--no-record]`.
 * Wraps `docker buildx build` for the per-target Dockerfiles in
 * @crewhaus/docker-images. Item 47: after a successful PUSHED build the
 * image's registry manifest digest is recorded in docker/digests.json by
 * default (the maintenance the lockfile header always promised);
 * `--no-record` opts out. A local `--load` build records nothing — its image
 * ID is a config digest that `docker pull repo@sha256:…` cannot resolve, so
 * the CLI says so instead of writing an unpullable pin.
 */
async function runBuildImage(rest: ReadonlyArray<string>): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: crewhaus build-image <target> --tag <tag> [--platform <p>] [--push] [--no-record]\n" +
          "  --push       push to the registry and record the pushed image's registry\n" +
          "               manifest digest into docker/digests.json (the only pullable pin)\n" +
          "  --no-record  skip recording the pushed image's digest into docker/digests.json\n" +
          "  Local (--load) builds record nothing: a local image ID is a config digest,\n" +
          "  not a registry digest — `docker pull repo@<id>` would fail.\n",
      );
      return;
    }
    if (a === "--push" || a === "--no-record") {
      flags.set(a.slice(2), true);
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
  const record = flags.get("no-record") !== true;

  const { buildImageAndRecord, digestsPath, isTargetShape } = await import(
    "@crewhaus/docker-images"
  );
  if (!isTargetShape(target)) {
    die(`unknown target shape: ${target}`);
  }
  try {
    const result = await buildImageAndRecord({
      target,
      tag,
      platform: typeof platform === "string" ? platform : undefined,
      push,
      record,
    });
    process.stdout.write(`built crewhaus/${result.target}:${result.tag}\n`);
    if (result.recorded && result.digest !== undefined) {
      process.stdout.write(
        `recorded ${result.digest} for ${result.target}:${result.tag} → ${digestsPath()}\n`,
      );
    } else if (record && result.recordSkippedReason !== undefined) {
      // Informational, not a warning: a --load build has no pullable digest
      // to record, and pretending otherwise is the exact lie item 47 retires.
      process.stdout.write(`crewhaus: [build-image] ${result.recordSkippedReason}\n`);
    } else if (record && result.recordError !== undefined) {
      // The image exists; a failed digest lookup/record must not fail the
      // build — but a silently stale lockfile is the exact lie item 47
      // retires, so say it out loud.
      process.stderr.write(
        `crewhaus: warning: image built but its digest was not recorded: ${result.recordError}\n`,
      );
    }
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

/**
 * Item 61 — `crewhaus channel provision|verify <spec.yaml>`: one-command
 * platform-side setup + scope doctor for channel-target specs. Everything is
 * derived from the spec + the adapters' actual API usage (see
 * channel-provision.ts for the per-platform derivations and the two design
 * decisions: Slack is emit-and-instruct only because the manifest API needs
 * an app configuration token the adapter/spec never carry, and Discord
 * registers the interactions endpoint — its adapter is webhook-based, not
 * gateway-websocket-based — but not application commands, because the spec
 * declares no command list and the adapter routes any command name).
 *
 * `--dry-run` prints every network call with secrets redacted (env-refs as
 * `$NAME`, inline literals as `[redacted]`) and performs nothing.
 */
async function runChannel(args: ParsedArgs, action: "provision" | "verify"): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus channel provision <spec.yaml> --base-url <public-url>\n" +
        "                                  [--platform slack|telegram|discord|all] [-o <dir>]\n" +
        "                                  [--dry-run] [--force]\n" +
        "       crewhaus channel verify <spec.yaml> [--platform slack|telegram|discord|all]\n" +
        "                                  [--base-url <public-url>] [--dry-run]\n" +
        "\n" +
        "  provision — platform-side app setup derived from the spec + compiled daemon:\n" +
        "    slack     write <dir>/slack-app-manifest.yaml (the bot scopes + event\n" +
        "              subscriptions the adapter actually needs; request URL =\n" +
        "              <base-url>/slack/events) and print the console steps. No --apply:\n" +
        "              Slack's manifest API needs an app *configuration* token, which\n" +
        "              neither the adapter nor the spec carries.\n" +
        "    telegram  CALL setWebhook with url = <base-url>/telegram/events and the\n" +
        "              spec's secretToken (the exact value the adapter verifies on every\n" +
        "              inbound POST via X-Telegram-Bot-Api-Secret-Token).\n" +
        "    discord   PATCH applications/@me interactions_endpoint_url =\n" +
        "              <base-url>/discord/events (start the daemon first — Discord\n" +
        "              validates the endpoint live) and print the invite URL with\n" +
        "              adapter-derived permission bits. Slash commands are NOT\n" +
        "              auto-registered: the spec declares no command list and the\n" +
        "              adapter routes any command name to the agent.\n" +
        "  verify — doctor-style probes, ✓/~/✗ per check, exit 1 on hard failures:\n" +
        "    slack     auth.test + granted scopes (x-oauth-scopes) vs the needed set\n" +
        "    telegram  getWebhookInfo url / allowed_updates / pending updates / last error\n" +
        "    discord   applications/@me id / verify_key / interactions endpoint\n" +
        "  --base-url  the daemon's publicly reachable origin (required for provision;\n" +
        "              on verify it upgrades the webhook-URL checks from ~ to ✓/✗)\n" +
        "  --dry-run   print every network call (secrets redacted) without performing it\n" +
        "  --force     discord provision reads applications/@me first and REFUSES to\n" +
        "              overwrite an interactions_endpoint_url that differs from the\n" +
        "              daemon route; --force replaces it (and reports what it was)\n",
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
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
    // parseSpec throws SpecParseError; lower() can throw CompilerError — both
    // extend CrewhausError, so render as a clean one-liner.
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
  if (ir.target !== "channel") {
    die(
      `channel ${action} requires a channel-target spec (got target "${ir.target}") — the platform config lives in the spec's channels block`,
    );
  }

  const platformFlag = args.flags["platform"];
  let selection: ReturnType<typeof resolvePlatformsFlag>;
  try {
    selection = resolvePlatformsFlag(
      typeof platformFlag === "string" ? platformFlag : undefined,
      ir.channels,
    );
  } catch (err) {
    if (err instanceof InvalidPlatformFlagError) die(err.message);
    throw err;
  }
  for (const p of selection.unsupported) {
    process.stdout.write(
      `note: channels.${p} is configured but \`channel ${action}\` does not support it yet (slack|telegram|discord)\n`,
    );
  }

  const dryRun = args.flags["dry-run"] === true;
  const baseUrlFlag = args.flags["base-url"];
  const baseUrl = typeof baseUrlFlag === "string" ? baseUrlFlag : undefined;
  if (baseUrl !== undefined) {
    try {
      joinBaseUrl(baseUrl, "/");
    } catch (err) {
      if (err instanceof InvalidBaseUrlError) die(err.message);
      throw err;
    }
  }
  const channelReactions = ir.feedback?.channelReactions === true;

  if (action === "provision") {
    if (baseUrl === undefined) {
      die(
        "missing --base-url <public-url> — the daemon's publicly reachable origin (e.g. https://bot.example.com); every platform points at a route under it (slack request_url, telegram webhook url, discord interactions endpoint)",
      );
    }
    const outFlag = args.flags["out"];
    const outDir = typeof outFlag === "string" ? resolve(outFlag) : process.cwd();
    process.stdout.write(
      `channel provision: ${ir.name} (${selection.platforms.join(", ")})${dryRun ? " (dry run)" : ""}\n`,
    );

    for (const platform of selection.platforms) {
      if (platform === "slack" && ir.channels.slack !== undefined) {
        const manifest = buildSlackManifest({ name: ir.name, channelReactions }, baseUrl);
        const manifestYaml = renderSlackManifestYaml(manifest);
        const manifestPath = join(outDir, SLACK_MANIFEST_FILENAME);
        process.stdout.write("\nslack:\n");
        if (dryRun) {
          process.stdout.write(`  would write ${manifestPath}:\n`);
          for (const line of manifestYaml.trimEnd().split("\n")) {
            process.stdout.write(`    ${line}\n`);
          }
        } else {
          mkdirSync(outDir, { recursive: true });
          writeFileSync(manifestPath, manifestYaml);
          process.stdout.write(`  wrote ${manifestPath}\n`);
        }
        for (const line of slackNextSteps(ir.channels.slack, manifestPath)) {
          process.stdout.write(`  ${line}\n`);
        }
      }

      if (platform === "telegram" && ir.channels.telegram !== undefined) {
        const provision = buildTelegramProvision(ir.channels.telegram, baseUrl, process.env);
        process.stdout.write("\ntelegram:\n");
        if (dryRun) {
          process.stdout.write(`  would POST ${provision.display.endpoint}\n`);
          process.stdout.write(`  payload: ${JSON.stringify(provision.display.payload)}\n`);
          if (provision.missingEnv.length > 0) {
            process.stdout.write(
              `  note: a live run needs ${provision.missingEnv.map((m) => `$${m.envName}`).join(", ")} set\n`,
            );
          }
        } else if (provision.missingEnv.length > 0) {
          die(
            `channel provision (telegram): unset env: ${provision.missingEnv
              .map((m) => `${m.label} → $${m.envName}`)
              .join(", ")} — export them (or use --dry-run to print the call)`,
          );
        } else {
          try {
            const description = await performTelegramSetWebhook(provision);
            process.stdout.write(`  ✓ setWebhook: ${description}\n`);
            process.stdout.write(
              `    url ${provision.display.payload.url}, secret_token ${provision.display.payload.secret_token}, allowed_updates ${provision.display.payload.allowed_updates.join("/")}\n`,
            );
          } catch (err) {
            if (err instanceof ChannelApiError) die(err.message);
            throw err;
          }
        }
      }

      if (platform === "discord" && ir.channels.discord !== undefined) {
        const provision = buildDiscordProvision(ir.channels.discord, baseUrl, process.env);
        process.stdout.write("\ndiscord:\n");
        if (dryRun) {
          process.stdout.write(
            `  would PATCH ${provision.display.endpoint} (Authorization: ${provision.display.authorization})\n`,
          );
          process.stdout.write(`  payload: ${JSON.stringify(provision.display.payload)}\n`);
          process.stdout.write(
            "  note: a live run first GETs applications/@me — a pre-existing\n" +
              "        interactions_endpoint_url that differs from the payload above is\n" +
              "        only replaced with --force (without it, provision refuses)\n",
          );
          if (provision.missingEnv.length > 0) {
            process.stdout.write(
              `  note: a live run needs ${provision.missingEnv.map((m) => `$${m.envName}`).join(", ")} set\n`,
            );
          }
          for (const line of discordNextSteps(provision.display.inviteUrl)) {
            process.stdout.write(`  ${line}\n`);
          }
        } else if (provision.missingEnv.length > 0) {
          die(
            `channel provision (discord): unset env: ${provision.missingEnv
              .map((m) => `${m.label} → $${m.envName}`)
              .join(", ")} — export them (or use --dry-run to print the call)`,
          );
        } else {
          try {
            const result = await performDiscordProvision(provision, fetch, {
              force: args.flags["force"] === true,
            });
            process.stdout.write(
              `  ✓ interactions endpoint set to ${provision.display.payload.interactions_endpoint_url}\n`,
            );
            if (result.replacedPrevious && result.previousEndpoint !== undefined) {
              process.stdout.write(
                `    replaced previous endpoint ${result.previousEndpoint} (--force)\n`,
              );
            }
          } catch (err) {
            if (err instanceof ChannelApiError) die(err.message);
            throw err;
          }
          for (const line of discordNextSteps(provision.inviteUrl ?? provision.display.inviteUrl)) {
            process.stdout.write(`  ${line}\n`);
          }
        }
      }
    }
    return;
  }

  // action === "verify"
  process.stdout.write(
    `channel verify: ${ir.name} (${selection.platforms.join(", ")})${dryRun ? " (dry run)" : ""}\n`,
  );
  if (dryRun) {
    for (const platform of selection.platforms) {
      for (const line of describeVerifyProbes(platform, ir.channels, process.env)) {
        process.stdout.write(`  ${line}\n`);
      }
    }
    return;
  }
  const verifyOpts = {
    env: process.env,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
  const checks: ChannelCheck[] = [];
  for (const platform of selection.platforms) {
    if (platform === "slack" && ir.channels.slack !== undefined) {
      checks.push(
        ...(await verifySlackChannel(ir.channels.slack, { channelReactions }, verifyOpts)),
      );
    } else if (platform === "telegram" && ir.channels.telegram !== undefined) {
      checks.push(...(await verifyTelegramChannel(ir.channels.telegram, verifyOpts)));
    } else if (platform === "discord" && ir.channels.discord !== undefined) {
      checks.push(...(await verifyDiscordChannel(ir.channels.discord, verifyOpts)));
    }
  }
  const summary = summarizeChannelChecks(checks);
  for (const line of summary.lines) {
    process.stdout.write(`  ${line}\n`);
  }
  process.exit(summary.exitCode);
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
  case "flywheel": {
    const action = rest[0] ?? "";
    if (action !== "init" && action !== "run") {
      die(`flywheel action must be "init" or "run" (got "${action}")`);
    }
    // Mirror `run`'s policy: every structured failure in the loop (model
    // routing, provider auth, the orchestrator, …) extends CrewhausError —
    // route the family through die() for a clean one-liner.
    try {
      await runFlywheelCmd(parseFor(rest.slice(1), FLYWHEEL_SCHEMA), action);
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "doctor":
    await runDoctor(parseFor(rest, DOCTOR_SCHEMA));
    break;
  case "context":
    runContext(parseFor(rest, CONTEXT_SCHEMA));
    break;
  case "cost-summary":
    await runCostSummary(parseFor(rest, COST_SUMMARY_SCHEMA));
    break;
  case "advise":
    await runAdvise(parseFor(rest, ADVISE_SCHEMA));
    break;
  case "tools": {
    const action = rest[0] ?? "";
    if (action !== "list" && action !== "suggest" && action !== "audit") {
      die(`tools action must be one of: list, suggest, audit (got "${action}")`);
    }
    await runTools(action, parseFor(rest.slice(1), TOOLS_SCHEMA));
    break;
  }
  case "rate":
    await runRate(parseFor(rest, RATE_SCHEMA));
    break;
  case "feedback":
    await runFeedbackCmd(parseFor(rest, FEEDBACK_SCHEMA));
    break;
  case "distill":
    await runDistill(parseFor(rest, DISTILL_SCHEMA));
    break;
  case "datasets":
    await runDatasets(parseFor(rest, DATASETS_SCHEMA));
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
  case "channel": {
    const action = rest[0] ?? "";
    if (action !== "provision" && action !== "verify") {
      die(`channel action must be "provision" or "verify" (got "${action}")`);
    }
    await runChannel(parseFor(rest.slice(1), CHANNEL_SCHEMA), action);
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
