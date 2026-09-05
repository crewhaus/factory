#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
  type SubAgentDefinition,
  foldSubAgentOverlay,
  subAgentDefinitionFromIr,
} from "@crewhaus/agent-context-isolation";
// Type-only — the concrete factories are dynamically imported inside the
// deploy/propose handlers (lazy boot); the approval gate helper needs the
// registry/audit types for its signature.
import type { AuditLog } from "@crewhaus/audit-log";
import { SpecParseError, compile, lower } from "@crewhaus/compiler";
import { buildContextBundle, discoverRoots } from "@crewhaus/context-bundle";
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_PRICING,
  type PricingTable,
  classifyPricingStaleness,
  computeCacheSavingsMicros,
  createCostTracker,
  parsePricingFeed,
  pickNewestPricing,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import {
  type DatasetRecord,
  type DatasetSplit,
  type ReleaseEntry,
  appendReleaseEntry,
  compareVersions,
  createFileBackedRegistry,
  latestVersion,
  overallDatasetHash,
  verifySplitHashes,
} from "@crewhaus/dataset-registry";
// Loop contract 0.4 (Batch A) — `memory.embedder`: the run path constructs
// the fact-store embedder and hands it to wireMemory as `deps.embedder`,
// which memory-service prefers over the fragment's `wiki.embedder` (the
// documented fallback order `embedder` → `wiki.embedder`).
import { createEmbedder } from "@crewhaus/embedder";
import { CrewhausError, RunFailedError } from "@crewhaus/errors";
import { type Sample, loadDataset } from "@crewhaus/eval-dataset";
import {
  type CompiledGrader,
  type Grader,
  type GraderCombinePolicy,
  type GradersConfig,
  parseGradersConfig,
} from "@crewhaus/eval-grader";
// "Watch me" (design/watch-me.md §7 phase 2) — the injection-hardened judge
// prompt, reused verbatim for the watchme judge phase built on runChatLoop.
import {
  type Rubric,
  buildJudgePrompt,
  createJudgeGrader,
  loadCategoricalRubric,
  loadRubric,
} from "@crewhaus/eval-judge";
import {
  MULTI_PROMPT_TARGETS,
  type OptimizableStage,
  extractCurrentPrompt as extractInstructions,
  findStage,
  formatStageNames,
  listOptimizableStages,
  optimizeSpec,
} from "@crewhaus/eval-optimizer-orchestrator";
import {
  type ExportRunInput,
  type LoadedRun,
  type RunIndexEntry,
  buildExportRows,
  buildMatrix,
  buildTrends,
  diffInstrumentWarnings,
  diffReports,
  formatPairwiseLines,
  formatSignificanceLine,
  formatSliceDeltaLines,
  formatTrendSummaryLines,
  formatUsd,
  hashDatasetFile,
  loadRun,
  readBaselines,
  readRunIndexLatest,
  renderMatrix,
  renderReport,
  renderTrends,
  rowsToCsv,
  rowsToJsonl,
  setBaseline,
  trendTable,
} from "@crewhaus/eval-report";
import {
  type EvalRunSummary,
  type GraderLookup,
  createExamRunner,
  defaultGraderRegistry,
  resolveRegistryGrader,
  runEval as runEvalLib,
  warnUnconsumedCombinePolicy,
} from "@crewhaus/eval-runner";
import { openEventLog } from "@crewhaus/event-log";
// Hangar F-1 — best-effort harness self-registration: run/compile/eval/dev
// record the cwd in the machine-wide registry (`~/.crewhaus/harnesses.json`)
// after a spec resolves. The hook never throws and honours
// CREWHAUS_NO_REGISTRY=1, so call sites need no try/catch.
import { registerHarnessHook } from "@crewhaus/harness-registry";
import { loadHooks, runHooks } from "@crewhaus/hooks-engine";
import {
  ArgParseError,
  type ParseArgsSchema,
  type ParsedArgs,
  assertNever,
  parseArgs,
} from "@crewhaus/infra-utils";
import { GENERATED_README_MARKER, type IrBudget, projectLoop } from "@crewhaus/ir";
import { createLogger } from "@crewhaus/logging";
import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";
// Item 1 (G30) — the MCP-server projection runtime. `crewhaus serve --mcp`
// builds `invoke` from the run interpreter's turn function and hands it here.
import { type McpInvoke, type McpServerHandle, createMcpServer } from "@crewhaus/mcp-server";
// PR 10 — the memory fabric's composition root: `crewhaus run` makes the
// same one stable wireMemory call compiled bundles emit. PR 16 adds
// connectThredz (the §4.3 backend flip's boot helper — bare-name MCP tool
// aliases + degrade-on-failure).
import {
  type ThredzConnection,
  connectThredz,
  memoryFragmentFromIr,
  runDreamBootCatchUp,
  wireMemory,
} from "@crewhaus/memory-service";
import { createMemoryStore } from "@crewhaus/memory-store";
// Item 10 (G89) — the default public plugin registry (registry.crewhaus.ai)
// `crewhaus plugins list/search` fall back to when no --registry / env is set.
import { DEFAULT_MODULE_REGISTRY_URL } from "@crewhaus/module-marketplace-client";
import {
  BUILTIN_DEFAULT_RULES,
  type JustificationJudge,
  PermissionConfigError,
  type PermissionMode,
  type RuleSet,
  appendSettingsRule,
  parsePermissionsConfig,
  tagRules,
} from "@crewhaus/permission-engine";
// Item 3 (G32) — plugin activation. `crewhaus run` activates the spec's
// `plugins:` (and the `--plugins` override) in-process exactly like a compiled
// bundle's boot (`renderPlugins` in @crewhaus/target-cli).
import { activatePlugins, createDefaultPluginRuntime } from "@crewhaus/plugin-loader";
// Adaptive model routing — `crewhaus route status|reset` inspects/clears the
// per-(routeKey, model) reward scoreboard behind `agent.model_pool`; advise
// mines the same scoreboard into pool-policy suggestions.
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import {
  type AgentIdentityFile,
  type RunChatLoopOptions,
  resolveSessionRootDir,
  runChatLoop,
} from "@crewhaus/runtime-core";
import {
  type PendingApproval,
  type PendingApprovalStore,
  createPendingApprovalStore,
  createSessionStore,
  evictExpiredSessions,
} from "@crewhaus/session-store";
import { type SkillRef, createSkillTool, discoverSkills } from "@crewhaus/skills-registry";
import { type SlashCommand, loadCommands } from "@crewhaus/slash-commands";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { specHasPath } from "@crewhaus/spec-patch";
import type { RegistryAdapter } from "@crewhaus/spec-registry";
import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";
// Item 4 (§59) — `crewhaus export claude-plugin` emits an Anthropic-compatible
// plugin directory from any IR variant.
import { TargetClaudePluginError, emitClaudePlugin } from "@crewhaus/target-claude-plugin";
// Phase 3 §3.3 — `cli.banner` is rendered from the SAME module the cli emitter
// inlines into a compiled bundle, so `crewhaus run` and `bun dist/agent.ts`
// print byte-identical banners.
import { renderBanner, shouldPrintBanner } from "@crewhaus/target-cli";
// Item 10 (G89) — the default public template registry (registry.crewhaus.ai)
// `crewhaus templates list/search` fall back to when no --registry / env is set.
import { DEFAULT_TEMPLATE_REGISTRY_URL } from "@crewhaus/template-marketplace-client";
import { buildTool } from "@crewhaus/tool-builder";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { registerMcpServer, registerOptionalMcpServer } from "@crewhaus/tool-mcp";
import { createTaskTool } from "@crewhaus/tool-task";
import { type CostAccrualEvent, type ProviderId, TraceEventBus } from "@crewhaus/trace-event-bus";
// "Watch me" (design/watch-me.md §2) — the durable per-harness digest store,
// the global cross-harness registry, and the quality→shadow-arm join behind
// `crewhaus watchme`.
import {
  type HarnessEntry,
  joinQualityToArms,
  openHarnessRegistry,
  openWatchmeStore,
} from "@crewhaus/watchme-store";
// 0.3.0 memory release (design §3.1, PR 9) — the local wiki substrate behind
// `crewhaus wiki list|show|search|stats`.
import { WikiVersionConflictError, createWikiStore } from "@crewhaus/wiki-store";
import { parseDocument } from "yaml";
import { z } from "zod";
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
// Item 31 — alert-watchdog delivery sink builder (audit append + settings.json
// alert hook + webhook), in a side-effect-free module so it is unit-testable
// (this entry file runs an argv switch on import).
import { alertWebhookFromSettings, buildAlertSink } from "./alert-sink";
// Item 59 — approval-gated promotion. The protected-env policy + quorum
// decision for `deploy promote --require-approval`, in a side-effect-free
// module so it is unit-testable (this entry file runs an argv switch on
// import). The gate runs BEFORE the deployment-controller flips the pin.
import {
  type ApprovalDecisionInput,
  ApprovalGateError,
  type PrCheckReader,
  buildGovernancePayload,
  decideApproval,
  loadEnvironmentsConfig,
  policyForEnv,
  prReferencesVersion,
  readApprovals,
  rollupConclusion,
} from "./approval-gate";
// Loop contract 0.4 (Batch C, G11) — the `crewhaus approvals` verbs' pure
// rendering layer (the file-backed store wiring lives in the handler below).
import { formatApprovalDetail, formatApprovalsTable } from "./approvals-cli";
import {
  ADVISE_SCHEMA,
  APPROVALS_SCHEMA,
  AUDIT_SCHEMA,
  BUILD_IMAGE_SCHEMA,
  CHANNEL_SCHEMA,
  CLOUD_DEPLOY_SCHEMA,
  CLOUD_SCHEMA,
  COMPILE_SCHEMA,
  COMPLIANCE_SCHEMA,
  CONTEXT_SCHEMA,
  COST_SUMMARY_SCHEMA,
  DATASETS_SCHEMA,
  DATASET_SCHEMA,
  DEPLOY_SCHEMA,
  DEV_SCHEMA,
  DISTILL_SCHEMA,
  DOCTOR_SCHEMA,
  EGRESS_SCHEMA,
  EVAL_COVERAGE_SCHEMA,
  EVAL_PLAN_SCHEMA,
  EVAL_REPORT_SCHEMA,
  EVAL_SCHEMA,
  EVAL_SUITE_SCHEMA,
  EXPERIMENT_SCHEMA,
  EXPORT_SCHEMA,
  FAILURES_SCHEMA,
  FAQ_SCHEMA,
  FEDERATION_SCHEMA,
  FEEDBACK_SCHEMA,
  FEWSHOT_SCHEMA,
  FLEET_SCHEMA,
  FLYWHEEL_SCHEMA,
  GRADERS_CARD_SCHEMA,
  GRADERS_SUGGEST_SCHEMA,
  GRADERS_TEST_SCHEMA,
  INCIDENT_SCHEMA,
  INIT_SCHEMA,
  INTENTS_SCHEMA,
  JUDGE_SCHEMA,
  JUSTIFICATION_SCHEMA,
  KNOWLEDGE_SCHEMA,
  LESSONS_SCHEMA,
  LINT_SCHEMA,
  LOADTEST_SCHEMA,
  MCP_SCHEMA,
  MEMORY_SCHEMA,
  MIGRATE_MEMORIES_SCHEMA,
  MIGRATE_SCHEMA,
  MODEL_SCAN_SCHEMA,
  MODEL_SCHEMA,
  ONCHAIN_SCHEMA,
  OPTIMIZE_SCHEMA,
  PERMISSIONS_SCHEMA,
  PII_SCHEMA,
  PLUGINS_SCHEMA,
  PRICING_SCHEMA,
  PROPOSE_SCHEMA,
  RATE_SCHEMA,
  REDTEAM_SCHEMA,
  RETENTION_SCHEMA,
  RETIRE_SCHEMA,
  REVIEW_SCHEMA,
  RUNS_SCHEMA,
  RUN_SCHEMA,
  SANDBOX_SCHEMA,
  SCAFFOLD_EVALS_SCHEMA,
  SCHEDULE_SCHEMA,
  SECRETS_SCHEMA,
  SECURITY_CORPUS_SCHEMA,
  SECURITY_SCHEMA,
  SERVE_SCHEMA,
  SESSIONS_SCHEMA,
  SPEC_SCHEMA,
  STATE_SCHEMA,
  TEMPLATES_SCHEMA,
  TOOLS_SCHEMA,
  UPGRADE_SCHEMA,
  WATCHME_SCHEMA,
  WIKI_SCHEMA,
} from "./arg-schemas";
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
// versioned `<spec>-ratings` registry datasets at run teardown), in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import). The block's exit-rating half lives in the RUNTIME
// (@crewhaus/runtime-core's exit-rating module) so compiled bundles get it too.
import { DISTILL_STATE_RELPATH, maybeAutoDistill } from "./autodistill";
// Local-bundle dependency manifest: `compile` writes the same synthesized
// pin-to-CLI-version package.json that `--check` installs against, so the
// documented standalone flow (`bun install` + `bun agent.ts` in the out-dir)
// resolves the emitted `@crewhaus/*` imports.
import { ensureBundleManifest } from "./bundle-manifest";
// Loop contract 0.4 (Batch F, item 6) — the cf-worker emit switch shared with
// the compiler-worker's remote `POST /compile { emitAs: "cf-worker" }`, so
// `crewhaus compile --emit-as cf-worker` emits the same Worker bundle locally.
import { emitCfWorkerBundle } from "./cf-worker-emit";
// Item 61 — `crewhaus channel provision|verify` core (adapter-derived Slack
// manifest, Telegram setWebhook, Discord interactions-endpoint registration,
// doctor-style scope/webhook probes), in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import {
  CHANNEL_PLATFORMS,
  ChannelApiError,
  type ChannelCheck,
  InvalidBaseUrlError,
  InvalidPlatformFlagError,
  SLACK_MANIFEST_FILENAME,
  buildDiscordProvision,
  buildSlackManifest,
  buildTelegramProvision,
  channelEnvChecks,
  collectProvisionMissingEnv,
  describeVerifyProbes,
  discordNextSteps,
  joinBaseUrl,
  modelCredentialChecks,
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
import {
  EVAL_CI_WORKFLOW_RELPATH,
  SENTINEL_WORKFLOW_RELPATH,
  buildEvalCiWorkflowYaml,
  buildSentinelDriftWorkflowYaml,
} from "./ci-scaffold";
// Loop contract 0.4 (Batch F, item 5) — the engine-free half of
// `crewhaus deploy <fly|render|railway|heroku>` (provider registry, shape/token
// gates, app-name + summary helpers). The handler dynamic-imports the matching
// @crewhaus/cloud-adapter-* engine.
import {
  CLOUD_DEPLOY_PROVIDERS,
  CLOUD_DEPLOY_TARGET_SHAPES,
  type CloudDeployProviderName,
  cloudDeployTokenPresent,
  defaultCloudDeployBaseImage,
  formatCloudDeployNextSteps,
  isCloudDeployProvider,
  isCloudDeployTargetShape,
  resolveCloudDeployAppName,
} from "./cloud-deploy";
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
// B23 — `crewhaus dataset audit` (offline PII/secret scan of an existing
// dataset) + the shared sync redaction the distill/mine ingestion surfaces
// apply, in a side-effect-free module so it is unit-testable (this entry
// file runs an argv switch on import).
import {
  auditSamples,
  containsRedactionMarker,
  redactDatasetText,
  redactSample,
  renderAuditReport,
} from "./dataset-audit";
// Wave 3 cluster C (B26/NEW-HUNT-10/B18) — the offline dataset lint engine
// behind `crewhaus dataset lint` and the `crewhaus eval` preflight, in a
// side-effect-free module mirroring dataset-audit.ts.
import {
  type LintFinding,
  type LintGraderSpec,
  graderNeedsGold,
  lintDataset,
  lintGraderSpecOf,
  preflightLint,
  renderLintFindings,
} from "./dataset-lint";
// Item 2 — `crewhaus dataset mine` + `dataset synthesize`: grow the dataset
// from production struggle signals + PII-redacted stress variants, in a
// side-effect-free module so it is unit-testable (this entry file runs an argv
// switch on import).
import {
  type MineCandidate,
  SYNTHESIZE_PII_DETECTORS,
  buildStressVariants,
  candidateToSample,
  clip as clipText,
  dedupeCandidates,
  egressBlocksFromAudit,
  mineSession,
  parseReviewKey,
  renderCandidateList,
  variantToSample,
} from "./dataset-mine";
// Item 12 — dataset-registry CLI plumbing (the `datasets` subcommand family,
// `distill --register` promotion, and the `--dataset registry:` shorthand
// shared by eval + optimize), in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import {
  DEFAULT_SPLIT_SPEC,
  DatasetRefError,
  REGISTRY_PREFIX,
  defaultDatasetsRoot,
  inspectRegistryRef,
  isDatasetSplit,
  nextVersion,
  parseNameVersion,
  parseRegistryRef,
  parseSplitSpec,
  promoteVerifiedSynthetics,
  recordToJsonl,
  refuseTestSplitRef,
  registerDataset,
  registryDatasetName,
  resolveRegistryRef,
  samplesForSplits,
  splitsPresent,
} from "./datasets";
// Wave 3 cluster C (B17/B21) — the `datasets status` freshness/saturation
// report + the `datasets card` markdown datasheet, side-effect-free (run
// history + per-run outcomes injected here).
import {
  computeDatasetStatus,
  entryMatchesVersion,
  provenanceBreakdown,
  renderDatasetCard,
  statusSummaryLines,
  statusTableRows,
} from "./datasets-status";
// Item 29 — `crewhaus deploy canary` eval-gated ramp orchestration, in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import). The heavy I/O (per-version eval, registry pins,
// audit) is injected here in index.ts.
import {
  CanaryRampError,
  driveCanaryRamp,
  makeCanaryEvalGate,
  makeTrafficSplitRecorder,
  parseTrafficSteps,
} from "./deploy-canary";
// Loop contract 0.4 (Batch F, item 2) — `crewhaus dev`: the supervised-child
// state machine + trace-line scanner + entry-point map (unit-tested); the CLI
// wraps them with real Bun.spawn + fs.watch below.
import {
  type DevChildHandle,
  createDevSupervisor,
  devEntrypointFor,
  isDevDaemonTarget,
} from "./dev";
// Model-aware doctor credential checks (provider parsed from the cwd spec's
// agent.model via the model-router grammar), in a side-effect-free module so
// it is unit-testable (this entry file runs an argv switch on import).
// Item 61 added the channel-target env check (only fires when the cwd spec
// lowers to a channel IR).
import {
  buildChannelEnvChecks,
  buildCredentialChecks,
  extractSpecModel,
  providerCredentialsSatisfied,
  providerEnvStubs,
  selectedProvider,
} from "./doctor-checks";
// Item 40 — `doctor --detect` (read-only inventory) and `doctor --fix`
// (mechanical remediation) live in side-effect-free modules so this entry file
// (which runs an argv switch on import) stays testable.
import {
  type FetchLike,
  buildInventory,
  claudeDesktopConfigPath,
  formatInventory,
} from "./doctor-detect";
import {
  type FixAction,
  type FixFs,
  formatFixPlan,
  planCrewhausDirs,
  planEnvStubs,
  planScaffoldSpec,
  planScopeFix,
} from "./doctor-fix";
// v0.3.0 Goal 6 — `doctor --probe`: opt-in ~1-token live call per
// configured provider, catching unfunded/invalid keys before a long run.
import { buildProbePlan, probeResultsToChecks, runProviderProbes } from "./doctor-probe";
// v0.3.0 PR 14 — `crewhaus dream run|status|init` (design §6.3), in a
// side-effect-free module; only the dispatch registration lives here.
import { DREAM_CLI_SCHEMA, runDreamCommand } from "./dream-cli";
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
// AUTOMATION-OPPORTUNITIES.md item 20 — `crewhaus egress review` core (triage
// durable egress_decision + rule-based justification-denial history into
// learned security spec suggestions), side-effect-free so it is unit-testable.
import {
  buildEgressTriageContext,
  formatEgressFindingLines,
  runEgressTriage,
} from "./egress-triage";
// Item 10 — `compile --with-eval-harness`: project a non-cli shape's lowered IR
// into a sibling target: eval bundle (+ per-shape invoker selection), in a
// side-effect-free module so it is unit-testable (this entry file does the IO).
import {
  EVAL_BRIDGE_SUBDIR,
  EvalBridgeError,
  describeBridge,
  projectEvalIr,
  selectInvoker,
} from "./eval-bridge";
// Item 6 — `crewhaus eval coverage`: production-vs-eval behavior gap
// detection, in a side-effect-free module so it is unit-testable (this entry
// file runs an argv switch on import).
import {
  type CoverageGraderSpec,
  DEFAULT_COVERAGE_GRADER_RUNS,
  DEFAULT_COVERAGE_SESSIONS,
  EvalCoverageError,
  type RunGradesText,
  buildEvalCoverage,
  buildProdBehavior,
  computeCoverage,
  computeGraderCoverage,
  coverageFileName,
  coverageGraderSpecOf,
  parseCoverageFormat,
  parseSessionsFlag,
  renderCoverage,
} from "./eval-coverage";
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
// Loop contract 0.4 (Batch B) — shared eval-loop CLI helpers: the G14
// default-registry construction rule, the G56 partial-credit fitness figure
// the optimize/flywheel search ranks by, and the `[eval]` stdout block
// (partial_score / loop metrics / pass@k–pass^k / failure classes / judge
// calibration notes), in a side-effect-free module so all of it is
// unit-testable (this entry file runs an argv switch on import).
import {
  evalRunCost,
  evalRunOutputLines,
  fitnessScore,
  graderRegistryForCompiled,
} from "./eval-output";
// A1 — `eval-report diff --pairwise`: credential gate + the order-swapped
// judging loop, in a side-effect-free module so both are unit-testable
// with an injected stub adapter.
import {
  judgeRunsPairwise,
  pairwiseCredentialError,
  resolvePairwiseJudgeModel,
} from "./eval-pairwise";
// C28 — `crewhaus eval plan`: the offline sample-size helper (pure
// arithmetic + the pilot reader), in its own side-effect-free module.
import { EvalPlanError, planSampleSize, renderEvalPlan } from "./eval-plan";
// Item 30 — model-drift sentinel comparison logic, in a side-effect-free
// module so it is unit-testable (this entry file runs an argv switch on
// import). The fresh run + baseline load happen in index.ts; this decides drift.
import { evaluateSentinel } from "./eval-sentinel";
// NEW-HUNT-8 — `crewhaus eval suite`: the CI-tier manifest (strict schema,
// tier selection, per-entry argument lowering, threshold + suite verdicts).
// The run loop itself lives below, so entries take the exact same code path a
// hand-typed `crewhaus eval` takes.
import {
  type EntryAggregates,
  EvalSuiteError,
  SUITE_TIERS,
  type SuiteEntryOutcome,
  type SuiteManifest,
  type SuiteTier,
  aggregateSuite,
  buildEntryEvalArgs,
  entryAggregatesFromResults,
  evaluateEntryThresholds,
  parseSuiteManifest,
  parseTierFlag,
  renderSuiteSummary,
  selectTier,
  suitePreflight,
} from "./eval-suite";
// E51 — offline eval results flow to the configured exporters. Presence-gated
// (no exporter env ⇒ `undefined`, zero overhead) and never fatal.
import { attachEvalTelemetry, evalRunSummaryMetrics } from "./eval-telemetry";
// E50 — `crewhaus experiment status`: per-version outcome/rating deltas with
// Wilson intervals and a min-n refusal, in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import { runExperimentCommand } from "./experiment";
// G63 — `crewhaus failures report`: cluster run_failed + incident records and
// (optionally) draft failure_taxonomy entries. Pure transform (FS reads live
// in the handler below).
import {
  type FailureRecord,
  clusterFailures as clusterFailureRecords,
  proposeTaxonomy,
  renderFailuresTable,
  renderTaxonomyYaml,
} from "./failures";
// Item #55 — distill recurring user questions into an auto-discovered FAQ skill.
import { buildFaqSkill, distillFaq } from "./faq";
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
  formatAgreementLines,
  gradersConfigToYaml,
  mergeFeedback,
  normalizeRating,
  samplesToJsonl,
} from "./feedback";
// Item #54 — few-shot pool harvesting (side-effect-free; FS + redactor wiring
// lives here in index.ts). Powers `fewshot harvest` and `optimize --few-shot`.
import {
  type FewShotExample,
  excludeOverlappingExamples,
  fewShotOverlapKey,
  formatFewShotForPrompt,
  harvestFewShot,
  isFewShotExample,
  mergePools,
  poolToJsonl,
} from "./fewshot";
// Item 58 — `crewhaus fleet list|status|run`: cross-harness discovery,
// inventory/health rollup, and bulk read-only ops, in a side-effect-free
// module so it is unit-testable (this entry file runs an argv switch on
// import). Discovery + aggregation are pure reads; the bulk runner spawns
// per-harness `crewhaus` invocations through an injected seam.
import {
  type BuildInventoryDeps,
  type BulkRunResult,
  type EvalHealthReader,
  FLEET_USAGE,
  FleetError,
  type FleetRunner,
  type HarnessInventory,
  type LastEvalEntry,
  type RunFleetBulkReport,
  buildFleetInventory,
  buildHarnessHealth,
  fleetSelfInvokeArgv,
  formatBulkReport,
  formatInventory as formatFleetInventory,
  formatHealth,
  matchesFilter,
  resolveBulkCommand,
  runFleetBulk,
} from "./fleet";
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
  type FlywheelGateSplit,
  type FlywheelKnobs,
  type FlywheelOptimizeOutcome,
  buildFlywheelWorkflowYaml,
  formatDatasetSourceLine,
  formatFlywheelKnobsGuide,
  formatFlywheelReport,
  formatGateSplitLine,
  formatRatingsShadowWarning,
  gateSplitRefusal,
  parseGateSplit,
  resolveFlywheelData,
  resolveFlywheelKnobs,
  runFlywheelLoop,
  scaffoldWorkflowFile,
  specIsDirty,
} from "./flywheel";
// NEW-HUNT-11 — `crewhaus graders card`: render the graders.yaml as the
// deterministic markdown rubric card (the measurement-instrument
// documentation artifact). Side-effect-free module; this entry file parses
// flags, computes the run-history gradersHash, and does the file IO.
import { renderGradersCard } from "./graders-card";
// Item 4 — `crewhaus graders suggest`: deterministic failure-rationale
// clustering + draft grader suites (plus the pure halves of the
// model-drafted llm_judge rubric), in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import {
  DEFAULT_SUGGESTED_GRADERS_FILE,
  DEFAULT_SUGGEST_RUNS,
  FLOOR_GRADER_HINT,
  type FailureEvidence,
  GradersSuggestError,
  type PassExemplar,
  RUBRIC_SUGGESTION_SYSTEM,
  type RunsSelector,
  type SuggestedGrader,
  buildRubricSuggestionPrompt,
  clusterFailures,
  draftGradersForThemes,
  evidenceFromFeedback,
  evidenceFromRun,
  isFloorGraderConfig,
  parseRubricSuggestion,
  parseRunsFlag,
  renderSuggestedGradersYaml,
} from "./graders-suggest";
// E48 — `crewhaus graders test`: meta-eval every grader in a graders.yaml
// against a labeled golden-verdict set (strict line-numbered parsing, the
// runEval-mirroring resolution with judge credential/transcript skips, the
// per-grader agreement/kappa/FP-FN statistics, and the --min-agreement
// gate), in a side-effect-free module so all of it is unit-testable (this
// entry file runs an argv switch on import).
import {
  type GraderTestReport,
  GradersTestError,
  belowFloor,
  parseGoldenVerdicts,
  renderGradersTestReport,
  replayGraderOnGoldens,
  resolveTestGraders,
  summarizeGraderTest,
} from "./graders-test";
// Item 32 — incident bundle assembly (trigger classification, audit-window
// join, cost summary, eval-report-styled render), in a side-effect-free module
// so it is unit-testable (this entry file runs an argv switch on import).
import {
  type IncidentKind,
  assembleIncidentBundle,
  matchAuditRecordsByWindow,
  summarizeCost,
} from "./incident";
// Item 39 / v0.3.0 §2.9 — `crewhaus init --interactive`: the conversational
// harness-designer interview (persisted, resumable runChatLoop session) plus
// the scripted no-credentials fallback, in importable modules so this entry
// file stays testable.
import {
  INIT_INTERVIEW_SAVED_NOTE,
  conversationalPathAllowed,
  runConversationalInterview,
} from "./init-conversation";
import {
  type ScriptedAnswers,
  type ScriptedShape,
  buildScriptedSpec,
  isScriptedShape,
} from "./init-interactive";
// Item 67 — `crewhaus intents`: cluster user_message inputs across sessions +
// rank by frequency / satisfaction / failure. Side-effect-free (this entry file
// reads sessions + feedback and redacts the rendered examples).
import {
  IntentsError,
  type TurnSignal,
  clusterIntents,
  orderedTurnsFromSessions,
  redactDigest,
  renderIntentsHtml,
  renderIntentsJson,
  renderIntentsText,
} from "./intents";
// Item 8 — `crewhaus judge calibrate`: pair human ratings with llm_judge
// scores and compute agreement/bias/ROC-cut, in a side-effect-free module so
// the statistics are unit-testable (this entry file runs an argv switch on
// import).
import {
  type CalibrationPair,
  DEFAULT_JUDGE_CUT,
  type DatasetPairCandidate,
  type JudgeCalibrationFile,
  buildCalibrationCard,
  buildCalibrationFile,
  dropDuplicateCandidates,
  extractDatasetCalibrationPairs,
  renderCalibrationCard,
  writeCalibrationFileAtomic,
} from "./judge-calibrate";
// AUTOMATION-OPPORTUNITIES.md item 52 — `crewhaus justification calibrate` +
// `justification preflight` core (replay the intent gate over durable
// permission_justification_evaluated records, compare to per-tool outcome,
// propose a confidence threshold, flag disagreements). Side-effect-free.
import {
  buildToolOutcomes,
  calibrateJustification,
  extractJustificationRecords,
  preflightJustification,
  renderCalibrationLines,
  renderPreflightLines,
} from "./justification-calibrate";
// FR-004 — Pillar 3 intent-gate judge + durable audit-sink resolution, in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import).
import {
  InvalidJudgeChoiceError,
  type JudgeChoice,
  asEgressAuditSink,
  createJustificationJudge,
  openSecurityAuditSink,
  resolveJudgeChoice,
} from "./justification-gate";
// Loop contract 0.4 (Batch E, G22) — `knowledge:` RAG ingestion for the
// interpreter path: load sources, chunk/embed/index, and register the shared
// `Retrieve` tool. Side-effect-free module (embedder/fetch/glob seams injected)
// so the ingest flow is unit-testable without a provider key or the network.
import { ingestKnowledge } from "./knowledge-ingest";
// Item 63 — cross-harness knowledge sync: shared memories / graders / prompt
// fragments moved between a harness and a fleet-level store, dedupe-by-hash,
// provenance-tagged, PII/token-redacted on push. Side-effect-free module so
// it is unit-testable (this entry file runs an argv switch on import); the
// redactor is injected.
import {
  KnowledgeSyncError,
  type PullPlan,
  type PushPlan,
  type Redactor,
  SHARED_DIR_DEFAULT,
  applyPull,
  applyPush,
  buildKnowledgeRedactor,
  formatPullReport,
  formatPushReport,
  fragmentContentHash,
  harnessOptedIn,
  memoryContentHash,
  planPull,
  planPush,
  readHarnessGraders,
  readHarnessMemories,
  readHarnessPrompts,
  readSharedFragments,
  readSharedMemories,
} from "./knowledge-sync";
// Item #56 — auto-maintained LESSONS.md + per-user preference files.
import {
  mergeLessons,
  mineLessons,
  minePreferences,
  parseLessonsMd,
  renderLessonsMd,
  renderPreferencesMd,
} from "./lessons";
// Item 41 — `crewhaus lint` (parse + ir-passes collect-all + scope audit) and
// `compile --watch` (debounced re-validate loop) live in side-effect-free
// modules so this entry file stays testable.
import {
  type LintResult,
  formatLintJson,
  formatLintText,
  nearestToolName,
  runLint,
  suggestSafeName,
  suggestSecretFix,
} from "./lint";
// Item 68 — `crewhaus loadtest`: concurrency benchmark + deploy gate for daemon
// shapes. The runner drives an injected LoadDriver; side-effect-free (this entry
// file builds the real driver + writes the report).
import {
  type GateThresholds,
  type LoadDriver,
  LoadtestError,
  type RequestOutcome,
  evaluateGate,
  renderLoadtestHtml,
  renderLoadtestText,
  runLoadtest,
} from "./loadtest";
// Loop contract 0.4 (Batch A) — interpreter-side threading of the
// loop-contract spec keys (limits / thinking / streaming / rate_limits /
// spec hooks / compaction tuning) + the compile-warning formatter, in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import). Mirror: @crewhaus/target-cli codegen threads the
// same fields into compiled bundles — keep the two in sync.
import {
  type AskMode,
  VALID_ASK_MODES,
  evaluationRunOptions,
  formatCompileWarning,
  isValidAskMode,
  loopContractRunOptions,
  mergeSpecHooks,
  modelRoutingRunOptions,
  resolveAskMode,
  resolveStreaming,
} from "./loop-contract";
// Loop contract 0.4 (Batch B, G42) — the human-readable `compile
// --emit-loop` rendering of `projectLoop`'s wire-contract projection, in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import).
import { formatLoopProjection } from "./loop-view";
// Item 60 — the marketplace CLI core: registry-source resolution, the
// outdated freshness compare, list/outdated formatters, and the publish PR
// plan, in a side-effect-free module so it is unit-testable (this entry file
// runs an argv switch on import). Network is behind an injected fetch seam.
import {
  MarketplaceCliError,
  type OutdatedRow,
  type PublishDraftLike,
  type PublishPrDriver,
  type PublishPrPlan,
  buildPublishPrPlan,
  computeOutdated,
  createHttpModuleRegistrySource,
  createLocalModuleRegistrySource,
  defaultPluginRegistryPath,
  defaultPluginsDir,
  defaultTemplateWorkspaceDir,
  formatOutdated,
  formatPluginList,
  installedVersions,
  resolveRegistryRef as resolveMarketplaceRegistryRef,
} from "./marketplace-cli";
// Item 38 — `crewhaus mcp doctor` core: per-server health scoring, listTools
// drift diff, quarantine decision — in a side-effect-free module (this entry
// file runs an argv switch on import) mirroring doctor-checks.ts.
import {
  type McpServerSnapshot,
  type McpStatsPayload,
  buildSnapshot,
  decideQuarantine,
  diffSnapshots,
  formatDriftReport,
  formatHealthReport,
  quarantineNotice,
  safeMcpFileName,
  scoreMcpHealth,
} from "./mcp-doctor";
// 0.3.0 memory release (design §3.4) — `crewhaus memory list|show|forget|sweep`
// helpers + the `crewhaus migrate memories` schema-v2 backfill.
import {
  MEMORIES_SUBDIR,
  formatMigrateMemoriesReport,
  listMemorySpecs,
  migrateMemories,
  renderMemoryList,
  renderMemoryShow,
  resolveMemorySpec,
} from "./memory-cli";
// D36 (Wave 5, cluster O) — compile ONE optimizer candidate of a multi-stage
// spec and wrap its compiled runtime entry in the Wave-4 bridge invoker, so
// `crewhaus optimize` measures workflow/graph/crew/pipeline candidates on the
// artifact they actually ship. Side-effect-free module (importEntry seam).
// D38 (Wave 5, cluster O) — the EXPERIMENTAL §56 meta-harness mutator, in a
// side-effect-free module with an injectable adapter so its meta-prompt and
// degenerate paths are unit-testable without credentials.
import {
  META_HARNESS_EXPERIMENTAL_NOTICE,
  createMetaHarnessMutatorForSpec,
} from "./meta-harness-mutator";
// 0.6.0 §10.1 — the spec-level model-plan checks lint and doctor share.
import { auditModelPlan } from "./model-plan-lint";
// Item 24 — market scan + doctor --models + pricing sync core, in a
// side-effect-free module (this entry file runs an argv switch on import).
import {
  type ScanCell,
  buildMarketScan,
  buildModelChecks,
  buildProposalArtifact,
  buildScanCandidates,
  writeModelField,
} from "./model-scan";
// Item 66 — `crewhaus onchain tune|sentinel`: mine wallet-engine receipt +
// simulation history to propose a tuned transaction_policy and flag anomalous
// spend. Side-effect-free (this entry file reads history + writes patch/report).
import {
  type CurrentPolicy,
  OnchainTuneError,
  type SpendAnomaly,
  detectAnomalies,
  detectAnomaliesSelfCompare,
  learnSpendBaseline,
  parseReceiptHistory,
  proposePolicy,
  renderSentinelReport,
  renderTuneReport,
} from "./onchain-tune";
import {
  BridgedCandidateError,
  prepareBridgedCandidate,
  runStagedOptimize,
  writeBackStagedResult,
} from "./optimize-stages";
// Item 16 — `crewhaus permissions suggest` (mine persisted ask/deny history
// into reviewable settings.json permission rules), in a side-effect-free
// module so it is unit-testable (this entry file runs an argv switch on
// import). Permissions are EXCLUDED from OPTIMIZABLE_PATHS — `--apply` is
// always an interactive human confirm, never eval-gated auto-apply.
import {
  type PermissionSuggestion,
  aggregateAsks,
  applyToSettingsRoot,
  diffPermissions,
  existingSettingsRules,
  formatSettingsDiff,
  formatSuggestionLines,
  rankSuggestions,
  readOnlyByName,
} from "./permissions-suggest";
// AUTOMATION-OPPORTUNITIES.md item 51 — `crewhaus pii tune` core (hashed
// redaction-history aggregation → false-positive over-redaction candidates +
// coverage gaps → reviewed .crewhaus/pii-policy.json). Side-effect-free; never
// stores/returns raw PII (only HMAC hashes + counts).
import {
  type ScanUnit,
  buildPiiPolicy,
  buildPiiTuneContext,
  findCoverageGaps,
  findFalsePositives,
  renderPiiTuneLines,
} from "./pii-tune";
// Item 3 (G32) — `plugins:` activation resolution for `run`/`dev` + the
// `--plugins` override. Pure name resolution (unit-testable); the real
// `activatePlugins` / dev spec-override wiring is below in this entry file.
import { parsePluginsFlag, resolvePluginNames } from "./plugin-activation";
// Item 4 (§59) — `crewhaus export claude-plugin` helpers: author / out-dir
// resolution, the harness's authored `.crewhaus/` skills + commands (item 14),
// and the post-emit smoke check (the emitted plugin.json / .mcp.json parse).
// The disk write + `emitClaudePlugin` call live below.
import {
  collectHarnessPluginAssets,
  resolveClaudePluginAuthor,
  resolveExportOutDir,
  smokeCheckClaudePluginBundle,
} from "./plugin-export";
// Item 59 — PR-based optimize/advise proposals. `crewhaus propose` packages a
// spec change into a review artifact + opens a PR (never auto-merges), in a
// side-effect-free module so it is unit-testable (this entry file runs an argv
// switch on import). Assembly is pure; git/gh live behind an injected driver.
import {
  type GitPrDriver,
  type OpenedPr,
  ProposeError,
  type ProposeSource,
  assembleProposal,
  buildProposalAuditPayload,
  buildProposalPrPlan,
} from "./propose";
// E49 — `crewhaus redteam generate|report`: the behaviour-taxonomy attack
// generator (deterministic + offline; attack strings composed from inert
// parts) and the attack-success-rate report. Pure module — the registry
// write, the graders file and the optional model call live here.
import {
  DEFAULT_REDTEAM_COUNT,
  DEFAULT_REDTEAM_TAXONOMY,
  REDTEAM_AUGMENT_SYSTEM,
  RedteamError,
  type RedteamRunSample,
  type RedteamTaxonomy,
  buildRedteamAugmentPrompt,
  buildRedteamGradersYaml,
  computeRedteamReport,
  generateRedteamSamples,
  modelVariantToSample,
  parseRedteamTaxonomy,
  parseRedteamVariants,
  renderRedteamReport,
} from "./redteam";
// Item 5 — `crewhaus dataset refresh-goldens`: reconcile user corrections +
// up-rated turns against an existing dataset's golds, proposing (or applying
// as a NEW version) updated golds. Side-effect-free so it is unit-testable.
import {
  DEFAULT_REFRESH_MIN_SCORE,
  type RunSampleOutcome,
  applyProposals,
  reconcileGoldens,
  renderProposals,
} from "./refresh-goldens";
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
// Item 64 — `crewhaus retire`: audited harness decommissioning (active-pin
// refusal, ordered non-destructive-then-archive steps, retirement log). The
// orchestration + refusal are pure; heavy steps are an injected seam. In a
// side-effect-free module so it is unit-testable (this entry file runs an argv
// switch on import).
import {
  RetireError,
  type RetirementSteps,
  type StepOutcome,
  buildRetirementPlan,
  formatPlan,
  formatRetirementResult,
  runRetirement,
} from "./retire";
// Wave 3 (B20) — the persistent human-review queue
// (.crewhaus/review/queue.jsonl): pure entry builders/formatters + the
// append-only JSONL store, in a side-effect-free module so it is
// unit-testable. Fed by eval (needs_human/needs_review), distill (rater
// disagreements), and dataset mine (quarantine pointers); drained by
// `crewhaus review list|next|resolve`.
import {
  REVIEW_KINDS,
  type ReviewKind,
  enqueueReviewEntries,
  entriesFromEvalRun,
  entriesFromQuarantine,
  entriesFromRaterTies,
  formatReviewItem,
  formatReviewList,
  nextOpenEntry,
  readReviewQueue,
  resolveReviewEntry,
} from "./review-queue";
// Item 25 — model right-sizing downshift search core (pure enumeration + cost
// projection + $/score ranking); side-effect-free so it is unit-testable.
import {
  type BaselineEvalOutcome,
  type ModelSlot,
  type SlotEvalOutcome,
  buildRightSizeReport,
  enumerateSlotCandidates,
} from "./right-size";
import { runRoute } from "./route";
// v0.3.0 Goal 6 — canonical terminal-failure rendering: die() and the
// `crewhaus run` failure path both route through renderCliFailure so a
// RunFailedError prints its structured report + coded exit while every
// other fatal keeps the classic `crewhaus: <message>` one-liner + exit 1.
import { CONTINUE_NOTE, renderCliFailure } from "./run-failure";
// Loop contract 0.4 (Batch C, G26) — pure resolution of `run --trace` + the
// cost-on-by-default env, applied by `applyRunObservabilityEnv` below.
import {
  TRACE_LEVELS,
  isValidTraceLevel,
  resolveCostEnv,
  resolveTraceEnv,
  resolveWatchmeEnv,
} from "./run-observability";
// Loop contract 0.4 (Batch F, item 7, CLI half) — `crewhaus runs resume`
// spec-resolution + session-id helpers (engine-free, unit-tested).
import { RunsError, isRunsSessionId, resolveRunsResumeSpecPath } from "./runs";
// Item 13 — `crewhaus scaffold-evals` + `init --with-evals`: day-one eval
// assets generated from the spec (deterministic template / one-shot model
// sample stubs + a single spec-goal llm_judge or floor grader), in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import).
import {
  DEFAULT_SCAFFOLD_SAMPLES,
  SCAFFOLD_GENERATION_SYSTEM,
  SCAFFOLD_GRADERS_HEADER,
  ScaffoldEvalsError,
  type ScaffoldGenerator,
  type ScaffoldInfo,
  applyEvalTemplate,
  buildSampleGenerationPrompt,
  buildScaffoldGraders,
  buildScaffoldSamples,
  checkNoOverwrite,
  extractScaffoldInfo,
  feedbackBlockSuggestion,
  goldCapNote,
  mergeInputs,
  parseModelSampleInputs,
  templateSampleInputs,
  unknownTemplateMessage,
} from "./scaffold-evals";
// D41 — `crewhaus schedule generate`: the off-GitHub scheduling shim
// (prints cron/launchd/systemd text; installs nothing).
import {
  ScheduleGenerateError,
  buildSchedule,
  parseScheduleRunner,
  parseScheduleTarget,
  renderSchedule,
} from "./schedule-generate";
// FR-002 — Pillar 3 sink-side scope gate, shared by `compile --strict` and
// `doctor --philosophy-alignment`. Kept in a side-effect-free module so it is
// unit-testable (this entry file runs an argv switch on import).
import { auditSpecToolNames, auditToolScopes, collectToolNames } from "./scope-audit";
// Item 49 — scope-audit drift watch (stable finding ids, snapshot
// persistence, baseline diff gate, boundary-drift detector), in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import).
import {
  BOUNDARY_SITES,
  type PhilosophyFinding,
  ScopeAuditBaselineError,
  auditBoundarySite,
  buildScopeAuditSnapshot,
  detectBoundaryDrift,
  diffScopeAuditSnapshots,
  loadScopeAuditSnapshot,
  renderGateReport,
  scopeAuditBaselinePath,
  scopeAuditDir,
  scopeAuditSnapshotPath,
} from "./scope-audit-drift";
// AUTOMATION-OPPORTUNITIES.md item 50 — `crewhaus security corpus` core
// (regression dataset grown from blocked-attempt residue + CI-usable
// regression check + reviewed candidate detector rules), side-effect-free so
// it is unit-testable (this entry file runs an argv switch on import).
import {
  SecurityCorpusError,
  buildSecurityCorpus,
  candidateRulesPath,
  checkSecurityCorpus,
  clusterCandidateRules,
  corpusDir,
  corpusPath,
  harvestBlockedAttempts,
  harvestNearMisses,
  loadSecurityCorpus,
  parseCorpusSince,
  renderCorpusBuildLines,
  renderCorpusCheckLines,
} from "./security-corpus";
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
// Item 1 (G30) — `crewhaus serve --mcp` projection helpers: transport / tools-
// mode / port / sub-agent-descriptor resolution + the target guard. Pure; the
// runtime wiring (build `invoke` from the run interpreter, bind the transport)
// lives below in this entry file.
import {
  SERVE_MCP_DEFAULT_PORT,
  SERVE_MCP_USAGE,
  ServeMcpError,
  assertServeTargetSupported,
  assertToolsModeSatisfiable,
  buildMcpSubAgentDescriptors,
  filterChildTools,
  resolveMcpToolsMode,
  resolveMcpTransport,
  resolveServePort,
} from "./serve-mcp";
// Loop contract 0.4 (Batch B, G53) — `sessions export --format trajectories`
// assembly ((state, action, observation, reward) tuples from session event
// logs + trace events, terminal-sparse reward ladder), in a side-effect-free
// module so it is unit-testable (this entry file runs an argv switch on
// import).
import {
  type TrajectoryStep,
  assembleTrajectory,
  parseJsonlLoose,
  trajectoryStepsToJsonl,
} from "./sessions-export";
// Item #57 — summarize sessions into a durable index before TTL eviction.
import {
  SESSIONS_INDEX_DIRNAME,
  parseSessionLog,
  summarizeSessionIntoIndex,
} from "./sessions-index";
// Loop contract 0.4 (Batch F, item 2) — `sessions tail`: pure event formatting,
// follow-cursor diffing, and newest-session selection (unit-tested); the CLI
// wraps them with the fs read + poll loop.
import { type SessionTailCursor, advanceSessionTail, pickSessionToTail } from "./sessions-tail";
// Item 37 — SLO/TTFT doctor probe + mitigation-ladder sink, in side-effect-free
// modules (this entry file runs an argv switch on import) mirroring
// doctor-checks.ts / alert-sink.ts.
import { runSloProbe } from "./slo-doctor";
import { buildSloSink, intakeGatePayload, lastKnownGoodFromAuditRecords } from "./slo-sink";
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
// v0.3.0 Goal 3 — `doctor --probe`'s thredz check (wiki_stats round-trip
// through the spec's synthesized/user-declared thredz MCP server).
import { probeThredz, thredzProbeTarget, thredzProbeToCheck } from "./thredz-probe";
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
// Item 43 — `crewhaus upgrade`: single-spec version-drift detection + validated
// migration chain, in a side-effect-free module so this entry file stays
// testable.
import {
  buildSpecVersionCheck,
  formatUpgradePlan,
  makeSpecValidator,
  planUpgrade,
} from "./upgrade";
// The top-level `crewhaus` help text — pure string data (~31 KB), so it lives
// beside this entry file rather than in it. `usage()`/`help()` below still own
// the stream + exit code.
import { EVAL_USAGE, usageText } from "./usage-text";
// CLI version resolution (embedded --define constant → package.json), shared
// with bundle-manifest.ts's dependency pinning.
import { cliVersion } from "./version";
// Item 65 — `crewhaus eval --voice`: replay recorded call-session logs through
// the voice grader pack (latency / barge-in / transcript). Side-effect-free
// (this entry file reads the replay JSONLs + writes the report).
import {
  DEFAULT_VOICE_THRESHOLDS,
  VoiceEvalError,
  type VoiceSessionResult,
  type VoiceThresholds,
  aggregateVoiceEval,
  gradeVoiceSessionWithContent,
  parseReplayLog,
  renderVoiceReport,
} from "./voice-eval";
import { type Watcher, createWatchController, formatCycleLine } from "./watch";
// "Watch me" (design/watch-me.md §11) — the observe-and-learn verbs behind
// `crewhaus watchme`: lifecycle (start/stop/status) in ./watchme, the
// phase-1/phase-2 report core in ./watchme-report, mimic-spec synthesis in
// ./watchme-synthesize. All three are pure modules with injected seams; this
// entry file wires the real ones (fs, pricing, graders, scoreboard, redactor,
// wiki store, the runChatLoop judge phase).
import {
  WatchmeError,
  formatWatchmeStatus,
  resolveWatchmeSpecPath,
  watchmeStart,
  watchmeStatus,
  watchmeStop,
} from "./watchme";
import {
  type HarnessSlice,
  type SharedWatchmeFinding,
  type WatchmeJudgePhase,
  type WatchmeReportDeps,
  WatchmeReportError,
  type WatchmeReportResult,
  buildCounterfactuals,
  nodeReportFs,
  runWatchmeAllReport,
  runWatchmeReport,
} from "./watchme-report";
import { WatchmeSynthesizeError, runWatchmeSynthesize } from "./watchme-synthesize";
// 0.3.0 memory release (design §3.1/§3.2, PR 9) — `crewhaus wiki
// list|show|search|stats` helpers over @crewhaus/wiki-store.
import {
  WIKI_SUBDIR,
  listWikiSpecs,
  renderWikiList,
  renderWikiSearch,
  renderWikiShow,
  renderWikiStats,
  resolveWikiSpec,
} from "./wiki-cli";

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

const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

const VALID_PERMISSION_MODES = ["default", "plan", "auto", "bypass"] as const;
type CliPermissionMode = (typeof VALID_PERMISSION_MODES)[number];

function isValidPermissionMode(s: string): s is CliPermissionMode {
  return (VALID_PERMISSION_MODES as readonly string[]).includes(s);
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

/**
 * Fatal-error exit. A plain string (or any non-RunFailed CrewhausError)
 * keeps the classic one-liner `crewhaus: <message>` + exit 1; a
 * `RunFailedError` (v0.3.0 Goal 6) renders its structured report via
 * `formatRunFailure()` and exits with the report's coded status, so
 * callers can simply `die(err)` and the taxonomy does the rest.
 */
function die(message: string | CrewhausError): never {
  const rendered = renderCliFailure(message);
  process.stderr.write(`${rendered.text}\n`);
  process.exit(rendered.exitCode);
}

function printVersion(): void {
  // Resolution (embedded --define constant → apps/cli/package.json) lives in
  // version.ts so compile-check.ts can pin dependencies to the same version.
  const version = cliVersion();
  if (version === undefined) die("could not locate package.json to determine the version");
  process.stdout.write(`${version}\n`);
}

/**
 * C33 — the reproducibility manifest's CLI half, as a spreadable opts
 * fragment. The runner records bun/platform itself but cannot know which
 * binary invoked it, and EVERY `runEvalLib` call in this file writes a real,
 * loadable, diffable run directory — the matrix cells, `model scan`, the
 * flywheel's before/after evals, optimize fitness runs and the version ramp
 * included. One helper so a new call site cannot forget it. Memoized:
 * `cliVersion()` reads package.json off disk.
 */
let cliVersionOptCache: { cliVersion?: string } | undefined;
function cliVersionOpt(): { readonly cliVersion?: string } {
  if (cliVersionOptCache === undefined) {
    const v = cliVersion();
    cliVersionOptCache = v !== undefined ? { cliVersion: v } : {};
  }
  return cliVersionOptCache;
}

function parseFor(rest: ReadonlyArray<string>, schema: ParseArgsSchema): ParsedArgs {
  try {
    return parseArgs(rest, schema);
  } catch (err) {
    if (err instanceof ArgParseError) die(err.message);
    throw err;
  }
}

/**
 * Hangar F-1 — best-effort harness self-registration: record that a command
 * touched the harness rooted at `dir` in the machine-wide registry, origin
 * `run-hook`. `dir` defaults to the CWD — correct for `run`/`eval`, where
 * the standalone-harness convention makes the cwd the harness root. Compile
 * and dev pass `dirname(absSpec)` instead: both are routinely invoked from
 * OUTSIDE the harness (`crewhaus compile path/to/crewhaus.yaml -o …`), and
 * registering the invoker's cwd would pollute the registry with a non-
 * harness row whose specName churns to whatever compiled last.
 * `registerHarnessHook` never throws and honours CREWHAUS_NO_REGISTRY, so
 * callers need no try/catch.
 *
 * Ephemeral-dir guard: under the DEFAULT registry root, a harness dir
 * inside the OS temp directory is skipped — compiles/runs against temp
 * fixtures (`bun test` drives dozens per suite, scratch experiments more)
 * would otherwise fill the real `~/.crewhaus/harnesses.json` with
 * guaranteed-dead rows the registry never auto-prunes. An explicit
 * CREWHAUS_REGISTRY_ROOT means the caller took control of registry
 * placement (a test, a sandboxed manager), so every dir registers there.
 */
function registerHarnessCwd(fields: {
  readonly dir?: string;
  readonly specName?: string;
  readonly target?: string;
  readonly originDetail: "run" | "compile" | "eval" | "dev";
}): void {
  let dir = fields.dir ?? process.cwd();
  try {
    // Physical path, like process.cwd() reports: a spec reached through a
    // symlink spelling (macOS /var → /private/var) must not mint a second
    // registry row for the same harness.
    dir = realpathSync(dir);
  } catch {
    // Unresolvable (racing delete) — register the resolved spelling as-is.
  }
  const explicitRoot = process.env["CREWHAUS_REGISTRY_ROOT"];
  if (explicitRoot === undefined || explicitRoot === "") {
    // The guard cannot rely on tmpdir() alone: it follows $TMPDIR, which a
    // spawned child often lacks, while the cwd may live under the parent's
    // per-user temp. So compare against tmpdir() (both spellings — macOS's
    // is a /var → /private/var symlink while process.cwd() is physical) AND
    // the canonical POSIX temp roots (/tmp; macOS's per-user /var/folders).
    // The literals never match on Windows, where tmpdir() (TEMP/TMP) rules.
    const tempRoots = new Set<string>([
      tmpdir(),
      "/tmp",
      "/private/tmp",
      "/var/folders",
      "/private/var/folders",
    ]);
    try {
      tempRoots.add(realpathSync(tmpdir()));
    } catch {
      // tmpdir unresolvable — the literal spellings still guard
    }
    if ([...tempRoots].some((t) => dir === t || dir.startsWith(`${t}${sep}`))) return;
  }
  registerHarnessHook({
    dir,
    ...(fields.specName !== undefined ? { specName: fields.specName } : {}),
    ...(fields.target !== undefined ? { target: fields.target } : {}),
    originDetail: fields.originDetail,
  });
}

/**
 * The {@link registerHarnessCwd} entry for command paths that hold the spec
 * TEXT and its resolved absolute path. Registers the spec file's own
 * directory (the dir that actually roots the harness), NOT the invoker's
 * cwd. Parses tolerantly: an unparseable spec registers nothing (the
 * command surfaces the real error itself).
 */
function registerHarnessTouch(yamlText: string, absSpec: string, originDetail: "compile"): void {
  let name: string | undefined;
  let target: string | undefined;
  try {
    const spec = parseSpec(yamlText) as unknown as { name?: unknown; target?: unknown };
    name = typeof spec.name === "string" ? spec.name : undefined;
    target = typeof spec.target === "string" ? spec.target : undefined;
  } catch {
    return; // the spec did not resolve — nothing to register
  }
  registerHarnessCwd({
    dir: dirname(absSpec),
    ...(name !== undefined ? { specName: name } : {}),
    ...(target !== undefined ? { target } : {}),
    originDetail,
  });
}

async function runCompile(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus compile <spec.yaml> [-o <out-dir>] [--emit-ir] [--emit-loop [--json]] [--check]\n" +
        "                        [--emit-as local|cf-worker] [--allow-unmarked-sinks] [--no-readme] [--no-register]\n" +
        "  --emit-as  local (default) emits the standalone Bun bundle; cf-worker\n" +
        "             emits the Cloudflare-Worker bundle (worker.js + wrangler.toml\n" +
        "             + package.json) — the SAME bundle the studio's remote compiler\n" +
        "             (compiler-worker POST /compile) serves. Supported for\n" +
        "             target=cli|workflow|graph; other shapes are rejected. Incompatible\n" +
        "             with --emit-ir/--emit-loop/--check/--with-eval-harness.\n" +
        "  --emit-ir  Skip code emission; print the lowered IR as JSON to\n" +
        "             stdout (or to <out-dir>/ir.json when -o is set).\n" +
        "  --emit-loop  Skip code emission; print the canonical agent-loop\n" +
        "             projection (projectLoop of the lowered IR) — the exact\n" +
        "             wire shape the studio /builder renders and the\n" +
        "             compiler-worker's POST /loop returns. Human-readable by\n" +
        "             default; --json prints the raw LoopProjection JSON; with\n" +
        "             -o it writes <out-dir>/loop.json instead. A read-only\n" +
        "             view: nothing is emitted, and (matching POST /loop) the\n" +
        "             FR-002 scope gate does not run, so you can inspect the\n" +
        "             loop of a spec whose tool scopes still need fixing.\n" +
        "  --check    After emitting, verify the bundle: run the target shape's\n" +
        "             smoke assertion, `bun install` its deps in the out-dir, and\n" +
        "             boot it once credential-free (liveness only — shapes whose\n" +
        "             boot needs live credentials/servers degrade to a reported\n" +
        "             gate). One green/red verdict line; red exits 1.\n" +
        "\n" +
        "  Every local bundle is emitted with a package.json declaring the\n" +
        "  @crewhaus/* packages its entrypoint imports, pinned to this CLI's\n" +
        "  version — `bun install` in the out-dir, then the README's launch\n" +
        "  line, runs the bundle standalone. A package.json already in the\n" +
        "  out-dir that crewhaus did not write is kept, not overwritten.\n" +
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
        "  --with-eval-harness  Also emit an eval bridge — a target: eval bundle\n" +
        "             projected from THIS (non-cli) shape — into <out-dir>/eval/,\n" +
        "             so the shape can consume its distilled feedback through\n" +
        "             eval/optimize/flywheel. The bridge is RUNTIME-INVOKING:\n" +
        "             workflow/graph/crew/pipeline samples drive the shape's\n" +
        "             compiled bundle end-to-end (the primary bundle gains an\n" +
        "             exported eval entry under this flag), channel samples run\n" +
        "             the bot's real runTurn via a loopback, managed samples\n" +
        "             drive the gateway's runOneTurn dispatcher; the remaining\n" +
        "             shapes run their agent + real tools through the\n" +
        "             single-turn loop (strategy printed per compile). Sample\n" +
        "             `history` seeds only chat-capable shapes\n" +
        "             (channel/managed/voice/pipeline); other shapes reject\n" +
        "             history-carrying samples loudly at dataset load.\n" +
        "             Rejected for cli (use `crewhaus eval` directly).\n" +
        "  --eval-dataset <name>  Dataset the bridge consumes (default\n" +
        "             <specName>-eval).\n" +
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
        "\n" +
        "  Compile warnings always print as one line per warning:\n" +
        "    crewhaus: warning[<code>] <path>: <message>\n" +
        "  Codes today: accepted-but-unwired (a spec key a shape ACCEPTS but\n" +
        "  whose emitter does not wire yet — legal-but-inert config),\n" +
        "  edge-unsafe-tool (a custom tool whose edge-safety the cf-worker\n" +
        "  flavour cannot verify offline), channel-reactions-join\n" +
        "  (informational — reaction feedback attributes to the exact turn\n" +
        "  only once the outbound-ts join file accumulates), and the 0.6.0\n" +
        "  model-plan-* / model-sunset / model-capabilities-unknown /\n" +
        "  model-strongest-crosses-provider notices (a model slot the\n" +
        "  shape, slot or current runtime cannot honour, or a model fact\n" +
        "  worth knowing).\n" +
        "  --strict   Escalate compile warnings to errors: any remediable\n" +
        "             warning fails the compile (exit 1) before files are\n" +
        "             written. Informational codes (channel-reactions-join,\n" +
        "             cli-autodistill-toolchain, model-plan-pending-runtime,\n" +
        "             model-capabilities-unknown, model-sunset,\n" +
        "             model-strongest-crosses-provider) still print but\n" +
        "             never fail --strict. (The FR-002 scope\n" +
        "             gate is on by default regardless of this flag;\n" +
        "             --allow-unmarked-sinks is its only opt-out.)\n",
    );
    return;
  }
  const specPath = args.positional[0];
  const outDir = args.flags["out"];
  const emitIr = args.flags["emit-ir"] === true;
  // Loop contract 0.4 (Batch B, G42) — `--emit-loop` is a print mode like
  // --emit-ir: exactly one of them may own stdout, and neither emits files
  // for --check to verify.
  const emitLoop = args.flags["emit-loop"] === true;
  const check = args.flags["check"] === true;
  if (check && emitIr) die("--check verifies emitted files — it cannot combine with --emit-ir");
  if (check && emitLoop) die("--check verifies emitted files — it cannot combine with --emit-loop");
  if (emitIr && emitLoop) {
    die("--emit-ir and --emit-loop are mutually exclusive (each owns stdout)");
  }
  // Loop contract 0.4 (Batch F, item 6) — `--emit-as <local|cf-worker>` picks
  // the bundle flavour. `local` (default) is the standalone bundle every prior
  // release emitted; `cf-worker` emits the Cloudflare-Worker bundle — the same
  // one the compiler-worker's remote POST /compile { emitAs } serves — for
  // target=cli|workflow|graph. The two print-only modes and the shape-boot
  // --check assume the local bundle, so cf-worker is incompatible with them.
  const emitAsFlag = args.flags["emit-as"];
  const emitAs = typeof emitAsFlag === "string" ? emitAsFlag : "local";
  if (emitAs !== "local" && emitAs !== "cf-worker") {
    die(`--emit-as must be "local" or "cf-worker" (got "${emitAs}")`);
  }
  const emitCfWorker = emitAs === "cf-worker";
  if (emitCfWorker) {
    if (emitIr) die("--emit-as cf-worker cannot combine with --emit-ir (each owns the output)");
    if (emitLoop) die("--emit-as cf-worker cannot combine with --emit-loop (each owns the output)");
    if (check) {
      die(
        "--emit-as cf-worker cannot combine with --check (the smoke boot assumes a local Bun bundle, not a Worker)",
      );
    }
    if (args.flags["with-eval-harness"] === true) {
      die(
        "--emit-as cf-worker cannot combine with --with-eval-harness (the eval bridge projects a local bundle)",
      );
    }
  }
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
  if (!emitIr && !emitLoop && typeof outDir !== "string") die("missing -o <out-dir>");

  // Loop contract 0.4 (Batch A) — `--strict` escalates compile warnings
  // (accepted-but-unwired spec keys) to errors. Distinct from the FR-002
  // scope gate above, which is default-on and governed solely by
  // --allow-unmarked-sinks.
  const strictWarnings = args.flags["strict"] === true;

  // Item 41 — `--watch`: re-run parse→lint→compile on every change. Delegates
  // to the watch controller, which drives one `compileOnceForWatch` cycle per
  // debounced change. `--check` is incompatible (a watch cycle is an in-place
  // re-validate, not a full install+boot verify).
  if (args.flags["watch"] === true) {
    if (check) die("--watch and --check are incompatible (a watch cycle re-validates in place)");
    await runCompileWatch({ specPath, strict, readme });
    return;
  }

  const absSpec = resolve(specPath);
  logger.debug("compile.start", { spec: absSpec, out: outDir, emitIr, strict, allowUnmarkedSinks });

  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }

  // Hangar F-1 — self-register the harness the moment its spec resolves,
  // ahead of the mode branches below so every compile flavour (bundle,
  // --emit-ir, --emit-loop) records the touch. Registers dirname(absSpec) —
  // compile is routinely invoked from outside the harness dir. Skips
  // silently when the spec does not parse — the pipeline below surfaces the
  // real error.
  registerHarnessTouch(yamlText, absSpec, "compile");

  // FR-006 — `security.egressMatcher: semantic` is now emitted into the
  // standalone cli bundle by `@crewhaus/target-cli` (it constructs
  // `@crewhaus/egress-matcher-semantic` with an injected embedder and threads
  // it into the bundle's `runChatLoop({ egressMatcher })`), so a compiled
  // artifact honours the selection WITHOUT the `run` path. No compile-time
  // warning is needed anymore — emission replaced the warn-only shim.

  // Loop contract 0.4 (Batch B, G42) — `--emit-loop`: parse → lower →
  // projectLoop, print, done. Deliberately runs BEFORE the FR-002 scope gate
  // below: the projection is a read-only VIEW (no artifact is produced, so
  // there is nothing whose egress scopes need gating), and it must return
  // exactly what the compiler-worker's POST /loop endpoint (which runs no
  // gate) returns for the same YAML — including specs the gate would refuse,
  // so an operator can SEE the loop before fixing scopes.
  if (emitLoop) {
    let ir: ReturnType<typeof lower>;
    try {
      ir = lower(parseSpec(yamlText));
    } catch (err) {
      // parseSpec throws SpecParseError; lower() can throw CompilerError.
      // Both extend CrewhausError — clean one-liner instead of a stack trace.
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    const projection = projectLoop(ir);
    if (typeof outDir === "string") {
      const absOut = resolve(outDir);
      mkdirSync(absOut, { recursive: true });
      const loopPath = join(absOut, "loop.json");
      writeFileSync(loopPath, `${JSON.stringify(projection, null, 2)}\n`);
      process.stdout.write(`wrote ${loopPath}\n`);
    } else if (args.flags["json"] === true) {
      process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
    } else {
      for (const line of formatLoopProjection(projection)) {
        process.stdout.write(`${line}\n`);
      }
    }
    logger.debug("compile.emit-loop.success", { out: outDir ?? "stdout" });
    return;
  }

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

  const withEvalHarness = args.flags["with-eval-harness"] === true;
  let bundle: ReturnType<typeof compile>;
  if (emitCfWorker) {
    // Loop contract 0.4 (Batch F, item 6) — the cf-worker emit path drives
    // lower() + the target-cf-worker-* emitters directly (mirroring the
    // compiler-worker's remote arm), not the local compile(). The offline
    // scope gate runs inside emitCfWorkerBundle (the same assertToolScopesStrict
    // the Worker applies), and any emitter refusal (an unsupported target, a
    // tool the edge doesn't yet run) is a CompilerError → clean one-liner.
    try {
      const cfIr = lower(parseSpec(yamlText));
      bundle = { files: emitCfWorkerBundle(cfIr, { readme }).files, warnings: [] };
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
  } else {
    try {
      // Cluster S — `--with-eval-harness` asks the compiler for the shape's
      // eval-entry bundle variant (see CompileOptions.evalEntry) instead of
      // re-emitting it here from a second, bare `lower(parseSpec(...))`: the
      // artifact written under the flag must come out of the same pipeline
      // as the one written without it.
      bundle = compile(yamlText, { readme, ...(withEvalHarness ? { evalEntry: true } : {}) });
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
  }

  // Loop contract 0.4 (Batch A) — compile warnings ALWAYS print, one line
  // per warning (code + path + message; stderr so stdout stays the clean
  // `wrote …` stream). With --strict any REMEDIABLE warning fails the
  // compile HERE — before any file is written, so a strict-failed build
  // emits nothing.
  for (const warning of bundle.warnings) {
    process.stderr.write(`crewhaus: ${formatCompileWarning(warning)}\n`);
  }
  // D40 — channel-reactions-join is INFORMATIONAL: it fires on a fully
  // wired, correctly configured feature (the outbound-ts join file just has
  // to accumulate at runtime), so no spec edit can ever clear it. Escalating
  // it would make --strict permanently unusable for every reactions-enabled
  // channel spec; it still prints above, but only remediable codes
  // (accepted-but-unwired, edge-unsafe-tool) escalate.
  //
  // Item 1 — cli-autodistill-toolchain is informational for the same reason:
  // `feedback.autoDistill` is honoured by `crewhaus run`, so the only "fix"
  // would be deleting a working spec key. The heads-up says which half of the
  // block a compiled bundle carries; it must never fail a strict compile.
  //
  // 0.6.0 PR 7 — four model-plan codes are informational for the same reason:
  // model-plan-pending-runtime fires on a key the 0.6.0 plan tells authors to
  // adopt (its runtime consumer lands in a later PR-train row, so the only
  // "fix" is deleting it); model-capabilities-unknown fires on any model the
  // offline table does not know (a local / new model is not a spec defect);
  // model-strongest-crosses-provider is a heads-up about a second credential,
  // not a defect; and model-sunset is a wall-clock notice that would make a
  // 0.5.x pool that compiled under --strict yesterday fail today (past
  // `retiresOn` a `models:` profile is already a hard error at lower time).
  const INFORMATIONAL_WARNING_CODES = new Set([
    "channel-reactions-join",
    "cli-autodistill-toolchain",
    "model-plan-pending-runtime",
    "model-capabilities-unknown",
    "model-strongest-crosses-provider",
    "model-sunset",
  ]);
  const escalatedWarnings = bundle.warnings.filter((w) => !INFORMATIONAL_WARNING_CODES.has(w.code));
  if (strictWarnings && escalatedWarnings.length > 0) {
    die(
      `--strict: ${escalatedWarnings.length} compile warning(s) escalated to errors (see lines above)`,
    );
  }

  // (Cluster S — the eval-entry bundle variant is selected INSIDE compile()
  // above via `evalEntry`, so `--with-eval-harness` and a plain compile share
  // one pipeline. `--emit-as cf-worker` already refused the flag.)

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
  // Local bundles carry bare `@crewhaus/*` imports and nothing declaring
  // them — synthesize the pinned manifest so `bun install` in the out-dir
  // makes the emitted entrypoint runnable standalone. (The cf-worker
  // emitters ship their own package.json; a user-authored one is kept.)
  // F-5 — the manifest carries the SOURCE SPEC's hash + the compiling
  // crewhaus version, so a manager can tell "bundle is stale vs crewhaus.yaml"
  // exactly instead of guessing from mtimes.
  const manifest = ensureBundleManifest(bundle.files, absOut, { specYaml: yamlText });
  if (manifest.action === "wrote") {
    process.stdout.write(`wrote ${manifest.path}\n`);
  } else if (manifest.action === "kept") {
    process.stdout.write(
      `kept ${manifest.path} (pre-existing — the pinned @crewhaus manifest was NOT written; delete it and recompile, or declare the bundle's @crewhaus deps there yourself)\n`,
    );
  }
  process.stdout.write(
    `compiled ${emitCfWorker ? "cf-worker " : ""}bundle (${bundle.files.length} file(s)) → ${absOut}\n`,
  );
  // Item 46 — auto-register the just-compiled spec in the local registry so
  // registry state tracks working files without a manual `crewhaus spec put`.
  // Bundle mode only: --emit-ir streams JSON to stdout, which a status line
  // would corrupt. Runs AFTER the success line — a compile that failed never
  // registers.
  if (register) await autoRegisterSpec(yamlText);
  logger.debug("compile.success", { files: bundle.files.length, out: absOut });

  // Item 10 — `--with-eval-harness`: project this shape's lowered IR into a
  // sibling `target: eval` bundle so a non-cli shape can consume its own
  // distilled feedback through eval/optimize/flywheel. Emitted into
  // <out-dir>/eval/. A cli/eval spec is rejected (nothing to bridge). Runs
  // AFTER the primary bundle so a plain compile is byte-for-byte unaffected.
  if (args.flags["with-eval-harness"] === true) {
    const { emitEval } = await import("@crewhaus/target-eval-bundle");
    // compile() already succeeded, so re-lowering for projection cannot throw.
    const sourceIr = lower(parseSpec(yamlText));
    const evalDatasetFlag = strFlag(args, "eval-dataset");
    let projected: ReturnType<typeof projectEvalIr>;
    try {
      projected = projectEvalIr(sourceIr, {
        ...(evalDatasetFlag !== undefined ? { datasetName: evalDatasetFlag } : {}),
      });
    } catch (err) {
      if (err instanceof EvalBridgeError) die(err.message);
      throw err;
    }
    const strategy = selectInvoker(sourceIr.target);
    const evalOut = join(absOut, EVAL_BRIDGE_SUBDIR);
    mkdirSync(evalOut, { recursive: true });
    // Cluster S — the bundle is emitted as a BRIDGE: it drives the shape's
    // compiled runtime entry (when one exists) and gates history-carrying
    // samples against non-chat shapes at dataset load.
    // C33 — the bundle bakes in the version that emitted it, so its run.json
    // carries the same reproducibility manifest a `crewhaus eval` run does
    // (bunVersion/platform are computed inside runEval). Same version the
    // emitted package.json pins.
    const bundleCliVersion = cliVersion();
    const evalBundle = emitEval(projected, {
      readme,
      ...(bundleCliVersion !== undefined ? { cliVersion: bundleCliVersion } : {}),
      bridge: {
        sourceTarget: sourceIr.target,
        kind: strategy.kind,
        chatCapable: strategy.chatCapable,
        ...(strategy.entryImport !== undefined ? { entryImport: strategy.entryImport } : {}),
      },
    });
    for (const file of evalBundle.files) {
      const fullPath = join(evalOut, file.path);
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
    // The eval bridge is its own local bundle in <out-dir>/eval/ — it needs
    // its own manifest for the same standalone-run reason as the primary.
    // The eval bridge is projected FROM this same spec, so it carries the same
    // stamp: recompiling the primary bundle is what refreshes both.
    const evalManifest = ensureBundleManifest(evalBundle.files, evalOut, { specYaml: yamlText });
    if (evalManifest.action === "wrote") {
      process.stdout.write(`wrote ${evalManifest.path}\n`);
    } else if (evalManifest.action === "kept") {
      process.stdout.write(
        `kept ${evalManifest.path} (pre-existing — the pinned @crewhaus manifest was NOT written; delete it and recompile, or declare the bundle's @crewhaus deps there yourself)\n`,
      );
    }
    process.stdout.write(`${describeBridge(projected, strategy)}\n`);
  }

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
 * Item 41 — the tool-name resolver shared by `lint` and its `--fix` nearest-
 * match. Returns a `(name) => RegisteredTool | undefined` that resolves BOTH
 * the camelCase spec key (`webSearch`) and the registered PascalCase name
 * (`WebSearch`, used in sub-agent `tools:`), matching the strict-scope gate.
 * The camelCase keys + PascalCase names are also returned as the legal-name
 * candidate set for nearest-match typo suggestions.
 */
async function buildToolResolver(): Promise<{
  resolve: (name: string) => RegisteredTool | undefined;
  candidates: string[];
}> {
  const toolMap = await loadToolMap();
  const byRegisteredName: Record<string, RegisteredTool> = {};
  for (const tool of Object.values(toolMap)) byRegisteredName[tool.name] = tool;
  const candidates = [
    ...new Set([...Object.keys(toolMap), ...Object.keys(byRegisteredName)]),
  ].sort();
  return {
    resolve: (name) => toolMap[name] ?? byRegisteredName[name],
    candidates,
  };
}

/**
 * Item 41 — `crewhaus lint [--fix] [--format text|json]`. Runs the check-only
 * pipeline (`runLint`: parse + ir-passes collect-all + scope audit) over the
 * cwd (or a named) spec WITHOUT emitting, so the §47 chain / graph-crew
 * well-formedness checks that the CLI compile path skips surface for authors.
 * `--fix` applies mechanical corrections (unknown tool → nearest match, `$SECRET`
 * typo → `$UPPER_SNAKE_CASE`, unsafe name → sanitised) then re-lints. Exit 1 on
 * any error finding.
 */
async function runLintCommand(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus lint [spec.yaml] [--fix] [--format text|json]\n" +
        "  Check-only: parseSpec + compile ir-passes (§47 chain / graph-crew\n" +
        "  well-formedness, which the CLI compile path skips) + tool-scope audit,\n" +
        "  WITHOUT emitting a bundle. Defaults to ./crewhaus.yaml.\n" +
        "  --format json   structured {message,path,severity,rule} findings for editors/CI.\n" +
        "                  IR passes are fail-fast per pass; json mode runs each pass\n" +
        "                  independently (collect-all) so one violation doesn't hide others.\n" +
        "  --fix           apply mechanical fixes: unknown tool name → nearest match,\n" +
        "                  $secret typo → $UPPER_SNAKE_CASE, unsafe name → sanitised.\n" +
        "                  A typo equidistant from tools of DIFFERENT capability (e.g.\n" +
        "                  read-only vs mutating) is printed as a suggestion instead of\n" +
        "                  auto-applied.\n",
    );
    return;
  }
  const format = args.flags["format"];
  if (format !== undefined && format !== "text" && format !== "json") {
    die(`--format must be "text" or "json" (got "${format}")`);
  }
  const specArg = args.positional[0];
  const absSpec = resolve(
    typeof specArg === "string" ? specArg : join(process.cwd(), "crewhaus.yaml"),
  );
  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }

  const { resolve: resolveTool, candidates } = await buildToolResolver();

  if (args.flags["fix"] === true) {
    const {
      text: fixedYaml,
      applied,
      suggested,
    } = applyLintFixes(yamlText, candidates, resolveTool);
    if (applied.length > 0) {
      writeFileSync(absSpec, fixedYaml);
      for (const line of applied) process.stdout.write(`fixed: ${line}\n`);
      yamlText = fixedYaml;
    }
    for (const line of suggested) process.stdout.write(`suggestion: ${line}\n`);
    if (applied.length === 0 && suggested.length === 0) {
      process.stdout.write("lint --fix: no mechanical fixes applicable.\n");
    }
  }

  const result = runLint(yamlText, resolveTool);
  process.stdout.write(format === "json" ? formatLintJson(result) : formatLintText(result));
  process.exit(result.ok ? 0 : 1);
}

/**
 * Item 41 — apply `lint --fix`'s mechanical corrections to a spec's YAML by
 * scanning the raw text for the three fixable classes and rewriting the token
 * in place. Text-level (not spec-patch) because two of the three classes —
 * an unsafe `name:` and a mistyped tool in a `tools:` list — must be fixed
 * BEFORE the spec can parse, and spec-patch requires a parseable document.
 * Returns the rewritten text + a description of each applied fix.
 *
 * `resolveTool` (same resolver `buildToolResolver` returns) supplies the
 * read-only/mutating capability signal `nearestToolName` uses to detect a
 * cross-capability typo — e.g. `Reit` is Levenshtein-2 from BOTH `Read`
 * (read-only) and `Edit` (mutating). Such a typo is NOT auto-applied (the
 * line is left untouched); it is instead returned in `suggested` as a
 * printed "did you mean X or Y?" line so the author picks, rather than the
 * fixer silently rewriting to whichever tie-break happened to win.
 */
function applyLintFixes(
  yamlText: string,
  toolCandidates: readonly string[],
  resolveTool: (name: string) => RegisteredTool | undefined,
): { text: string; applied: string[]; suggested: string[] } {
  const applied: string[] = [];
  const suggested: string[] = [];
  const getReadOnly = (candidateName: string): boolean | undefined =>
    resolveTool(candidateName)?.readOnly;
  const lines = yamlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // Unsafe `name:` value → sanitised.
    const nameMatch = /^(\s*name:\s*)(.+?)(\s*)$/.exec(line);
    if (nameMatch?.[2] !== undefined) {
      const raw = stripQuotes(nameMatch[2]);
      const safe = suggestSafeName(raw);
      if (safe !== undefined) {
        lines[i] = `${nameMatch[1]}${safe}`;
        applied.push(`name "${raw}" → "${safe}" (unsafe characters)`);
        continue;
      }
    }

    // A `- toolName` list item that is an unknown tool near a legal name.
    const toolMatch = /^(\s*-\s*)([A-Za-z]\w*)(\s*)$/.exec(line);
    if (toolMatch?.[2] !== undefined) {
      const nearest = nearestToolName(toolMatch[2], toolCandidates, undefined, getReadOnly);
      if (nearest?.kind === "match") {
        lines[i] = `${toolMatch[1]}${nearest.name}`;
        applied.push(`tool "${toolMatch[2]}" → "${nearest.name}" (nearest match)`);
        continue;
      }
      if (nearest?.kind === "ambiguous") {
        const options = nearest.candidates.map((c) => `"${c}"`).join(" or ");
        suggested.push(
          `tool "${toolMatch[2]}" — did you mean ${options}? (not auto-fixed — ambiguous across tool capabilities)`,
        );
        continue;
      }
    }

    // A credential value that looks like a malformed env ref → $UPPER_SNAKE_CASE.
    const secretMatch = /^(\s*\w+:\s*)(\$\S+)(\s*)$/.exec(line);
    if (secretMatch?.[2] !== undefined) {
      const fixed = suggestSecretFix(stripQuotes(secretMatch[2]));
      if (fixed !== undefined) {
        lines[i] = `${secretMatch[1]}${fixed}`;
        applied.push(`secret "${secretMatch[2]}" → "${fixed}" ($UPPER_SNAKE_CASE)`);
      }
    }
  }
  return { text: lines.join("\n"), applied, suggested };
}

/** Strip a single pair of surrounding single/double quotes from a scalar. */
function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Item 41 — `compile --watch`. Watches the spec + `.crewhaus/commands` + skills
 * dirs and re-runs a parse→lint→compile (in-memory) cycle on every debounced
 * change, printing one green/red status per cycle. Ctrl-C-clean: the SIGINT
 * handler stops the controller and closes the fs watchers.
 */
async function runCompileWatch(opts: {
  readonly specPath: string;
  readonly strict: boolean;
  readonly readme: boolean;
}): Promise<void> {
  const absSpec = resolve(opts.specPath);
  const specDir = dirname(absSpec);
  const { resolve: resolveTool } = await buildToolResolver();

  // Watch the spec file plus the two sibling authoring dirs, when present.
  const watchPaths = [absSpec, join(specDir, ".crewhaus", "commands"), join(specDir, "skills")];
  const { watch } = await import("node:fs");
  const handles: Array<{ close(): void }> = [];
  const subscribers: Array<() => void> = [];
  const watcher: Watcher = {
    subscribe: (cb) => subscribers.push(cb),
    close: () => {
      for (const h of handles) {
        try {
          h.close();
        } catch {
          // A path that vanished mid-watch closes with an error; ignore.
        }
      }
    },
  };
  for (const p of watchPaths) {
    if (!existsSync(p)) continue;
    try {
      const h = watch(p, { recursive: true }, () => {
        for (const cb of subscribers) cb();
      });
      handles.push(h);
    } catch {
      // Non-fatal: an unwatchable path just isn't watched.
    }
  }

  const runCycle = async (): Promise<{ green: boolean; line: string }> => {
    let text: string;
    try {
      text = readFileSync(absSpec, "utf-8");
    } catch (err) {
      return {
        green: false,
        line: formatCycleLine(false, `read failed: ${(err as Error).message}`),
      };
    }
    const result = runLint(text, resolveTool);
    if (!result.ok) {
      const first = result.findings[0];
      const detail = first ? `${result.findings.length} finding(s): ${first.message}` : "findings";
      return { green: false, line: formatCycleLine(false, `lint ✗ — ${detail}`) };
    }
    // Lint clean → compile in-memory (no emit) to confirm the emitters accept it.
    try {
      compile(text, { readme: opts.readme, strict: opts.strict });
      return { green: true, line: formatCycleLine(true, `${basename(absSpec)} ok`) };
    } catch (err) {
      const message = err instanceof CrewhausError ? err.message : (err as Error).message;
      return { green: false, line: formatCycleLine(false, `compile ✗ — ${message}`) };
    }
  };

  const controller = createWatchController({
    watcher,
    timer: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) },
    debounceMs: 150,
    runCycle,
    print: (line) => process.stdout.write(`${line}\n`),
  });

  process.stdout.write(
    `watching ${basename(absSpec)} (+ .crewhaus/commands, skills) — Ctrl-C to stop\n`,
  );
  // Run one cycle immediately so the user sees the current status.
  const initial = await runCycle();
  process.stdout.write(`${initial.line}\n`);

  await new Promise<void>((resolveWatch) => {
    const onSigint = (): void => {
      controller.stop();
      process.stdout.write("\nwatch stopped.\n");
      process.off("SIGINT", onSigint);
      resolveWatch();
    };
    process.on("SIGINT", onSigint);
  });
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
      "usage: crewhaus init [name] [--ci] [--with-evals] [--sentinel] [--suite <s.yaml>] [--force]\n" +
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
        "  --with-evals  Also scaffold eval/dataset.jsonl + eval/graders.yaml (item 13)\n" +
        "           — the flywheel's conventional paths — so the fresh harness can run\n" +
        "           `crewhaus eval` on day one. Always OFFLINE template mode (init never\n" +
        "           requires credentials): deterministic sample stubs derived from the\n" +
        "           spec's instructions + the safe non-empty-answer floor grader. Run\n" +
        "           `crewhaus scaffold-evals` later (with credentials) for model-derived\n" +
        "           inputs and a spec-goal llm_judge rubric. With an existing\n" +
        "           crewhaus.yaml, adds just the missing eval assets.\n" +
        "  --sentinel  Also scaffold .github/workflows/sentinel-drift.yml (item 30) — the\n" +
        "           nightly model-drift sentinel: re-run a seed-pinned sentinel dataset\n" +
        "           against the UNCHANGED spec and diff against a frozen baseline run; any\n" +
        "           flip/score-shift when specHash AND dataset-hash are unchanged is\n" +
        "           provider drift and fails the job. Freeze + commit the baseline once by\n" +
        "           hand (init never runs a live eval); the printed note says how.\n" +
        "  --suite <suite.yaml>  Scaffold the TIERED workflows (NEW-HUNT-8) against a suite\n" +
        "           manifest instead: with --ci, PRs run `eval suite --tier fast --gate`\n" +
        "           (base spec first to pin each entry's baseline, exactly like the\n" +
        "           single-eval gate) and a nightly cron runs `--tier nightly`; with\n" +
        "           --sentinel, the drift cron gains a nightly-tier step beside the probe.\n" +
        "           The path is harness-relative (the jobs' working-directory), and a\n" +
        "           manifest you have not written yet warns rather than failing init.\n" +
        "           Without --suite both scaffolds are byte-identical to before.\n" +
        "  --force  Overwrite an existing scaffolded workflow or eval assets (never\n" +
        "           the spec).\n",
    );
    return;
  }
  const ci = args.flags["ci"] === true;
  const withEvals = args.flags["with-evals"] === true;
  const sentinelInit = args.flags["sentinel"] === true;
  const nameArg = args.positional[0];
  const targetDir = typeof nameArg === "string" ? resolve(nameArg) : process.cwd();
  // NEW-HUNT-8 — the optional suite manifest the scaffolded workflows drive.
  // Stored HARNESS-relative: the jobs' working-directory is the harness, and
  // every path inside the manifest resolves from there too.
  const suiteFlag = strFlag(args, "suite");
  let suiteRel: string | undefined;
  if (suiteFlag !== undefined) {
    if (!ci && !sentinelInit) {
      die("--suite applies to --ci / --sentinel (it selects the tiered workflow to scaffold)");
    }
    const rel = relative(targetDir, resolve(suiteFlag));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      die(
        `--suite "${suiteFlag}" must live inside the harness directory (${targetDir}) — the scaffolded job's working-directory is the harness`,
      );
    }
    suiteRel = rel;
  }
  const specName = typeof nameArg === "string" ? nameArg : basename(targetDir);
  const targetFile = join(targetDir, "crewhaus.yaml");

  if (existsSync(targetFile)) {
    // Item 44 — `init --ci` composes with an existing harness: keep the
    // spec, add just the workflow (item 13's --with-evals composes the same
    // way for the eval assets). Without either flag the historical refusal
    // stands (a bare `init` must never touch existing work).
    if (!ci && !withEvals && !sentinelInit) {
      die(`${targetFile} already exists — refusing to overwrite`);
    }
    process.stdout.write(`kept ${targetFile} (already exists)\n`);
  } else {
    mkdirSync(targetDir, { recursive: true });
    const yamlText = `name: ${specName}
target: cli
agent:
  model: claude-opus-5
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
        // NEW-HUNT-8 — with --suite this is the TIERED workflow (fast tier on
        // PRs, nightly tier on a cron); without it, the single-eval gate
        // exactly as before.
        content: buildEvalCiWorkflowYaml({
          harnessDir,
          ...(suiteRel !== undefined ? { suite: suiteRel } : {}),
        }),
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
      if (suiteRel !== undefined) {
        process.stdout.write(
          `ci: tiered on ${filterBase}${suiteRel} — the fast tier gates PRs, the nightly tier runs on\n    a cron. Wire \`crewhaus eval suite --tier release --gate\` into your release job.\n`,
        );
        // The emitted YAML hard-codes both jobs' tiers — check the manifest
        // declares them rather than letting the nightly cron discover it.
        warnSuiteManifestGaps(targetDir, suiteRel, ["fast", "nightly"]);
      }
    } catch (err) {
      if (err instanceof FlywheelConfigError) die(err.message);
      throw err;
    }
  }

  // Item 30 — `init --sentinel`: scaffold the nightly model-drift sentinel
  // cron. Lands at the repo root (finding 7) with its working-directory
  // pointed back at a nested harness. The frozen baseline must be produced +
  // committed once by hand (init never runs a live eval) — the workflow
  // comments + the printed note say how.
  if (sentinelInit) {
    try {
      const { root: wfRoot, harnessDir } = resolveWorkflowRoot(targetDir, process.cwd());
      const scaffolded = scaffoldWorkflowFile({
        rootDir: wfRoot,
        relPath: SENTINEL_WORKFLOW_RELPATH,
        content: buildSentinelDriftWorkflowYaml({
          harnessDir,
          // NEW-HUNT-8 — with --suite the cron ALSO runs the nightly tier
          // (complementary signals: provider drift vs tier regression).
          ...(suiteRel !== undefined ? { suite: suiteRel } : {}),
        }),
        force: args.flags["force"] === true,
      });
      process.stdout.write(`wrote ${scaffolded.path}\n`);
      const filterBase = harnessDir === "" ? "" : `${harnessDir}/`;
      process.stdout.write(
        `sentinel: set the ANTHROPIC_API_KEY repo secret, add a seed-pinned\n    ${filterBase}eval/sentinel.jsonl, then freeze the baseline once:\n    crewhaus eval ${filterBase}crewhaus.yaml --dataset ${filterBase}eval/sentinel.jsonl \\\n      --graders ${filterBase}eval/graders.yaml --seed 1 -o ${filterBase}eval/sentinel-baseline\n    and commit ${filterBase}eval/sentinel-baseline. The nightly cron then flags provider drift.\n`,
      );
      if (suiteRel !== undefined) {
        process.stdout.write(
          `sentinel: the same cron also runs \`crewhaus eval suite ${suiteRel} --tier nightly --gate\`\n`,
        );
        warnSuiteManifestGaps(targetDir, suiteRel, ["nightly"]);
      }
    } catch (err) {
      if (err instanceof FlywheelConfigError) die(err.message);
      throw err;
    }
  }

  // Item 13 — `init --with-evals`: day-one eval assets, ALWAYS in offline
  // template mode (init must never require credentials). Existing assets are
  // kept unless --force; the spec is never touched.
  if (withEvals) {
    const evalDir = join(targetDir, "eval");
    const datasetPath = join(evalDir, "dataset.jsonl");
    const gradersPath = join(evalDir, "graders.yaml");
    const blocked = checkNoOverwrite(
      [datasetPath, gradersPath],
      existsSync,
      args.flags["force"] === true,
    );
    if (blocked !== undefined) {
      process.stdout.write(
        `kept existing eval assets in ${evalDir} (--force overwrites scaffolded eval assets, never the spec)\n`,
      );
    } else {
      try {
        const info = extractScaffoldInfo(readFileSync(targetFile, "utf-8"));
        const written = writeScaffoldAssets({
          info,
          outDir: evalDir,
          inputs: templateSampleInputs(info, DEFAULT_SCAFFOLD_SAMPLES),
          generator: "template",
          online: false,
        });
        process.stdout.write(
          `wrote ${written.datasetPath} (${written.sampleCount} sample stubs)\n`,
        );
        process.stdout.write(
          `wrote ${written.gradersPath} (${written.graderName} floor grader — edit into real graders,\n`,
        );
        process.stdout.write(
          "    or run `crewhaus scaffold-evals crewhaus.yaml --force` with credentials for a\n" +
            "    spec-goal llm_judge rubric)\n",
        );
      } catch (err) {
        // An existing-but-unscaffoldable spec (unparseable, no instructions)
        // must not fail the rest of init — report and continue.
        if (err instanceof ScaffoldEvalsError || err instanceof CrewhausError) {
          process.stderr.write(`crewhaus: eval scaffolding skipped: ${err.message}\n`);
        } else {
          throw err;
        }
      }
    }
  }

  // The runtime resolves the spec and the `.crewhaus/` session store from
  // the current working directory, so guide the user to run from inside
  // the harness directory (where crewhaus.yaml lives), not from here.
  const rel = relative(process.cwd(), targetDir);
  const cd = rel === "" ? "" : `cd ${rel} && `;
  process.stdout.write(`next: ${cd}crewhaus run crewhaus.yaml\n`);
  if (withEvals) {
    process.stdout.write(
      `next: ${cd}crewhaus eval crewhaus.yaml --dataset ${join("eval", "dataset.jsonl")} --graders ${join("eval", "graders.yaml")}\n`,
    );
  }
  logger.debug("init.success", { target: targetFile, ci, withEvals });
}

/**
 * NEW-HUNT-8 — `init --ci|--sentinel --suite <path>` scaffolds a workflow
 * that RUNS that manifest, at the tiers named in `referencedTiers`.
 * Scaffolding before authoring the manifest is legitimate (the workflow is
 * the thing you commit first), so a missing manifest warns rather than
 * failing init — but it must warn, or the first CI run is the thing that
 * discovers the typo.
 *
 * When the manifest DOES exist, the tiers it declares are checked against the
 * ones the emitted YAML runs: a fast-only suite scaffolded with `--ci` gets a
 * nightly CRON job whose `eval suite --tier nightly` dies with "suite declares
 * no nightly tier" every night. A recurring red scheduled workflow caused by a
 * scaffold/manifest mismatch is precisely the false alarm the sentinel exists
 * to avoid, so say it now — while the operator is still looking.
 */
function warnSuiteManifestGaps(
  harnessDir: string,
  suiteRel: string,
  referencedTiers: ReadonlyArray<SuiteTier>,
): void {
  const abs = join(harnessDir, suiteRel);
  if (!existsSync(abs)) {
    process.stderr.write(
      `crewhaus: warning: ${abs} does not exist yet — the scaffolded workflow\n    will fail until you add the suite manifest (see \`crewhaus eval suite --help\`)\n`,
    );
    return;
  }
  let manifest: SuiteManifest;
  try {
    manifest = parseSuiteManifest(readFileSync(abs, "utf-8"));
  } catch (err) {
    process.stderr.write(
      `crewhaus: warning: ${abs} is not a valid suite manifest (${(err as Error).message}) —\n    the scaffolded workflow will fail until it parses\n`,
    );
    return;
  }
  const declared = SUITE_TIERS.filter((t) => (manifest.tiers[t]?.length ?? 0) > 0);
  const missing = referencedTiers.filter((t) => !declared.includes(t));
  if (missing.length === 0) return;
  process.stderr.write(
    `crewhaus: warning: the scaffolded workflow runs ${missing.map((t) => `--tier ${t}`).join(" and ")}, but\n` +
      `    ${suiteRel} declares only: ${declared.join(", ")} — ${missing.length === 1 ? "that job" : "those jobs"} will fail every run\n` +
      `    until the tier${missing.length === 1 ? "" : "s"} exist${missing.length === 1 ? "s" : ""} (or you drop the job from the workflow)\n`,
  );
}

// -------- item 13: crewhaus scaffold-evals (+ the init --with-evals core) --------

type ScaffoldAssetsWritten = {
  readonly datasetPath: string;
  readonly gradersPath: string;
  readonly sampleCount: number;
  readonly graderName: string;
  readonly graderType: string;
};

/**
 * Generate + write `dataset.jsonl` and `graders.yaml` under `outDir`.
 * Shared by `scaffold-evals` and `init --with-evals` (which always calls it
 * offline). The caller has already run the {@link checkNoOverwrite} guard.
 */
function writeScaffoldAssets(opts: {
  readonly info: ScaffoldInfo;
  readonly outDir: string;
  readonly inputs: ReadonlyArray<string>;
  readonly generator: ScaffoldGenerator;
  /** True → the spec-goal llm_judge rubric; false → the floor grader. */
  readonly online: boolean;
  /** Explicit --model, baked into the emitted llm_judge grader. */
  readonly judgeModel?: string;
}): ScaffoldAssetsWritten {
  const samples = buildScaffoldSamples(opts.info, opts.inputs, opts.generator);
  const graders = buildScaffoldGraders(opts.info, {
    online: opts.online,
    ...(opts.judgeModel !== undefined ? { model: opts.judgeModel } : {}),
  });
  mkdirSync(opts.outDir, { recursive: true });
  const datasetPath = join(opts.outDir, "dataset.jsonl");
  const gradersPath = join(opts.outDir, "graders.yaml");
  writeFileSync(datasetPath, samplesToJsonl(samples));
  writeFileSync(gradersPath, gradersConfigToYaml(graders, SCAFFOLD_GRADERS_HEADER));
  const g = graders.graders[0];
  return {
    datasetPath,
    gradersPath,
    sampleCount: samples.length,
    graderName: g?.name ?? "",
    graderType: g?.type ?? "",
  };
}

/**
 * One model call through the same model-router path `optimize --mutator
 * claude` uses (`resolveModel` → adapter.stream → collectFinalMessage).
 * Shared by scaffold-evals sample generation (item 13) and the `graders
 * suggest` rubric draft (item 4). Lazy imports keep the credential-free
 * paths free of provider deps.
 */
async function oneShotModelText(opts: {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens?: number;
}): Promise<string> {
  const { resolveModel } = await import("@crewhaus/model-router");
  const { collectFinalMessage, extractFirstText } = await import("@crewhaus/adapter-anthropic");
  const resolution = await resolveModel(opts.model);
  const final = await collectFinalMessage(
    resolution.adapter.stream({
      model: resolution.modelId,
      system: [{ type: "text", text: opts.system }],
      messages: [{ role: "user", content: opts.prompt }],
      maxTokens: opts.maxTokens ?? 2048,
    }),
  );
  return extractFirstText(final) ?? "";
}

async function runScaffoldEvals(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus scaffold-evals <spec.yaml> [-o <out-dir>] [--samples N] [--model <m>]\n" +
        "                                 [--template <family>] [--force]\n" +
        "  Generate starter eval assets FROM the spec itself (item 13), so a day-one\n" +
        "  harness can run `crewhaus eval` before its first user rating lands:\n" +
        "    dataset.jsonl   N sample stubs (default 8) whose inputs derive from\n" +
        "                    agent.instructions — via ONE model call (model-router\n" +
        "                    grammar; the spec's own model by default) when credentials\n" +
        "                    are visible, else a deterministic template that parses the\n" +
        "                    instruction sentences into task-shaped prompts. Tools the\n" +
        "                    spec declares are recorded as expected_tools where a\n" +
        "                    prompt obviously implies them.\n" +
        "    graders.yaml    exactly ONE starter grader (stacking graders hard-ANDs\n" +
        "                    their scores): a spec-goal llm_judge rubric with all five\n" +
        "                    anchors pre-filled when credentials exist, else the safe\n" +
        "                    non-empty-answer floor grader.\n" +
        "  --template <family> (E47) starts from the first-party eval-template library\n" +
        "  instead: a `grader-template` manifest whose graders.yaml is copied VERBATIM\n" +
        "  (fully anchored rubrics, one grader — stacking hard-ANDs) plus its seed\n" +
        "  dataset, topped up to --samples N with the spec-derived stubs — EXCEPT for a\n" +
        "  family whose every grader needs a gold answer (`classify`), where the dataset\n" +
        "  stops at the gold-carrying seeds: a generated stub has no expected_output, so\n" +
        "  topping up would write samples that auto-fail. The families\n" +
        "  below are EMBEDDED in the CLI (no download, nothing to verify), and they\n" +
        "  are the ONLY names --template resolves today: this flag does not read a\n" +
        "  template registry. The `grader-template` manifest kind rides\n" +
        "  template-registry's Ed25519 signing + trust root so a registry CAN carry\n" +
        "  and verify one (`templates list` shows it as [eval-template]), but no\n" +
        "  consumer fetches it yet — registry distribution of eval assets is wired,\n" +
        "  not finished.\n" +
        "  Families:\n" +
        "    rag        grounded QA over retrieved context (groundedness/relevance/attribution)\n" +
        "    summarize  faithfulness, coverage, concision\n" +
        "    extract    field accuracy, completeness, output shape\n" +
        "    support    resolution quality + policy/tone compliance\n" +
        "    safety     categorical refusal label (incl. an over-refusal label + benign control)\n" +
        "    classify   deterministic expected_contains against the sample's gold label\n" +
        "  Template mode is OFFLINE by construction — templates are static content, so\n" +
        "  no model call happens on that path (--model is refused with it). An unknown\n" +
        "  family lists the available ones instead of guessing. Templates are copied as\n" +
        "  REVIEW files: nothing is auto-wired into a gate.\n" +
        "  -o defaults to eval/ next to the spec (the flywheel's conventional paths).\n" +
        "  Existing eval assets are never overwritten without --force.\n" +
        "  If the spec lacks a feedback: block, a suggested one is printed (never\n" +
        "  auto-applied) — ratings are what later upgrade these stubs via `distill`.\n",
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
  let info: ScaffoldInfo;
  try {
    info = extractScaffoldInfo(yamlText);
  } catch (err) {
    if (err instanceof ScaffoldEvalsError || err instanceof CrewhausError) die(err.message);
    throw err;
  }
  const n = intFlag(args, "samples") ?? DEFAULT_SCAFFOLD_SAMPLES;
  if (n < 1) die(`invalid --samples "${args.flags["samples"]}" — must be a positive integer`);
  const outArg = strFlag(args, "out");
  const outDir = outArg !== undefined ? resolve(outArg) : join(dirname(absSpec), "eval");
  const blocked = checkNoOverwrite(
    [join(outDir, "dataset.jsonl"), join(outDir, "graders.yaml")],
    existsSync,
    args.flags["force"] === true,
  );
  if (blocked !== undefined) die(blocked);

  // E47 — template mode: copy a first-party family's reviewed eval assets
  // instead of drafting new ones. Returns before ANY model consideration —
  // the offline guarantee is structural, not a code path that happens to
  // skip the call.
  const templateFlag = strFlag(args, "template");
  if (templateFlag !== undefined) {
    if (strFlag(args, "model") !== undefined) {
      die(
        "--template and --model are mutually exclusive — an eval template is static content, so template mode never calls a model",
      );
    }
    const { firstPartyGraderTemplates, graderTemplateCatalog, validateGraderTemplate } =
      await import("@crewhaus/template-registry");
    const catalog = graderTemplateCatalog();
    let manifest: Awaited<ReturnType<ReturnType<typeof firstPartyGraderTemplates>["fetch"]>>;
    try {
      manifest = await firstPartyGraderTemplates().fetch(templateFlag);
    } catch {
      die(unknownTemplateMessage(templateFlag, catalog));
    }
    const shape = validateGraderTemplate(manifest);
    if (!shape.ok || manifest.evalAssets === undefined) {
      die(`eval-template "${templateFlag}" is malformed: ${shape.reason ?? "no eval assets"}`);
    }
    // The family's graders.yaml is written verbatim into the harness, so it
    // must PARSE before anything lands on disk — and the parse is also what
    // tells us whether its graders need a gold answer on every sample.
    let templateGraders: GradersConfig;
    try {
      templateGraders = parseGradersConfig(manifest.evalAssets.gradersYaml).config;
    } catch (err) {
      die(
        `eval-template "${templateFlag}" carries an unparseable graders.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // ONE predicate with `dataset lint` and the eval preflight: a family
    // whose every grader needs expected_output (classify's
    // `expected_contains`) must not be topped up with gold-less stubs — they
    // would auto-fail and cap the score at seeds/--samples.
    const requiresGold =
      templateGraders.graders.length > 0 &&
      templateGraders.graders.every((g) => graderNeedsGold(lintGraderSpecOf(g)));
    const applied = applyEvalTemplate({
      info,
      family: manifest.name,
      version: manifest.version,
      assets: manifest.evalAssets,
      samples: n,
      ...(requiresGold ? { requiresGold: true } : {}),
    });
    mkdirSync(outDir, { recursive: true });
    const templateDatasetPath = join(outDir, "dataset.jsonl");
    const templateGradersPath = join(outDir, "graders.yaml");
    writeFileSync(templateDatasetPath, samplesToJsonl(applied.samples));
    writeFileSync(templateGradersPath, applied.gradersYaml);
    process.stdout.write(
      `[scaffold-evals] template ${manifest.name}@${manifest.version}: wrote ${applied.samples.length} sample(s) ` +
        `(${applied.seedCount} from the family, ${applied.stubCount} spec-derived) → ${templateDatasetPath}\n`,
    );
    process.stdout.write(
      `[scaffold-evals] graders: the family's reviewed rubric, copied verbatim → ${templateGradersPath}\n`,
    );
    if (applied.goldCapped) {
      process.stdout.write(
        `[scaffold-evals] ${goldCapNote(manifest.name, applied.seedCount, n)}\n`,
      );
    }
    if (manifest.evalAssets.notes !== undefined) {
      process.stdout.write(
        `[scaffold-evals] before you gate on it: ${manifest.evalAssets.notes}\n`,
      );
    }
    printScaffoldNextSteps(absSpec, info, templateDatasetPath, templateGradersPath);
    return;
  }

  // Mode selection: an explicit --model opts into the model path outright;
  // otherwise the spec's own model is used when its provider credentials are
  // visible (shared check with `crewhaus doctor`). No credentials → the
  // deterministic template fallback, never a doomed call.
  const modelFlag = strFlag(args, "model");
  const model = modelFlag ?? info.model;
  let online =
    model !== undefined &&
    (modelFlag !== undefined || providerCredentialsSatisfied(model, process.env));
  const templateInputs = templateSampleInputs(info, n);
  let inputs: ReadonlyArray<string> = templateInputs;
  let generator: ScaffoldGenerator = "template";
  if (online && model !== undefined) {
    try {
      const raw = await oneShotModelText({
        model,
        system: SCAFFOLD_GENERATION_SYSTEM,
        prompt: buildSampleGenerationPrompt(info, n),
      });
      const parsed = parseModelSampleInputs(raw, n);
      if (parsed.length === 0) throw new Error("model returned no usable inputs");
      // A short model response tops up from the template so the dataset is
      // always the full N stubs.
      inputs = mergeInputs(parsed, templateInputs, n);
      generator = "model";
    } catch (err) {
      process.stderr.write(
        `[scaffold-evals] model generation failed (${err instanceof Error ? err.message : String(err)}) — falling back to the deterministic template\n`,
      );
      online = false;
    }
  }

  const written = writeScaffoldAssets({
    info,
    outDir,
    inputs,
    generator,
    online,
    ...(modelFlag !== undefined ? { judgeModel: modelFlag } : {}),
  });
  process.stdout.write(
    `[scaffold-evals] wrote ${written.sampleCount} sample stub(s) (${generator} mode) → ${written.datasetPath}\n`,
  );
  process.stdout.write(
    `[scaffold-evals] grader: ${written.graderName} (${written.graderType}) → ${written.gradersPath}\n`,
  );
  if (!online) {
    process.stdout.write(
      "[scaffold-evals] offline mode: the floor grader only checks for a non-empty answer —\n" +
        "    re-run with credentials (or --model) for a spec-goal llm_judge rubric, or edit\n" +
        "    the graders by hand\n",
    );
  }
  printScaffoldNextSteps(absSpec, info, written.datasetPath, written.gradersPath);
}

/**
 * The shared tail of every `scaffold-evals` mode (spec-derived and E47
 * template alike): the `feedback:` block suggestion when the spec has none,
 * and the ready-to-paste eval command. The runtime resolves eval assets
 * relative to the invocation cwd, so the command is printed as run from the
 * spec's directory.
 */
function printScaffoldNextSteps(
  absSpec: string,
  info: ScaffoldInfo,
  datasetPath: string,
  gradersPath: string,
): void {
  if (!info.hasFeedback) {
    const indented = feedbackBlockSuggestion()
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    process.stdout.write(
      `[scaffold-evals] the spec has no feedback: block — add this to ${basename(absSpec)} to start\n` +
        `    collecting the ratings that later upgrade these stubs (not auto-applied):\n${indented}\n`,
    );
  }
  const specDir = dirname(absSpec);
  const rel = relative(process.cwd(), specDir);
  const cd = rel === "" ? "" : `cd ${rel} && `;
  process.stdout.write(
    `next: ${cd}crewhaus eval ${basename(absSpec)} --dataset ${relative(specDir, datasetPath)} --graders ${relative(specDir, gradersPath)}\n`,
  );
}

/**
 * Item 39 — a line-buffered stdin reader for the scripted questionnaire.
 *
 * Built on readline's `"line"` event with a queue rather than sequential
 * `rl.question()` calls: under Bun, chained `question()` calls against a PIPED
 * stdin (all answers arriving in one chunk) deliver only the first line and
 * then hang. The event+queue design drains every buffered line, so each
 * `ask()` returns the next line (or "" once stdin closes). Thin by design; the
 * questionnaire logic lives in the pure `buildScriptedSpec`.
 */
function createLineReader(): { ask(prompt: string): Promise<string>; close(): void } {
  const rl = createInterface({ input: process.stdin });
  const queue: string[] = [];
  const waiters: Array<(v: string) => void> = [];
  let ended = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    ended = true;
    for (const w of waiters.splice(0)) w("");
  });
  return {
    ask: (prompt: string): Promise<string> => {
      process.stdout.write(prompt);
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued.trim());
      if (ended) return Promise.resolve("");
      return new Promise<string>((resolveLine) => waiters.push((v) => resolveLine(v.trim())));
    },
    close: () => rl.close(),
  };
}

/**
 * Item 39 / v0.3.0 §2.9 — `crewhaus init --interactive`. Interview the user
 * and emit a `parseSpec`-validated crewhaus.yaml.
 *
 * Three paths:
 *   - Credentials + a TTY → the CONVERSATIONAL interview (PR 18): a
 *     persisted, resumable `runChatLoop` session with `ask_user` +
 *     `emit_spec` and no forced toolChoice, the continuity fabric on
 *     (requirements ledger, focus pinning, handoff) spec-scoped as
 *     `init-<dirname>` under the target directory. Validation errors return
 *     to the conversation as tool errors; a terminal failure prints the
 *     classified FailureReport plus the saved-interview resume hint;
 *     `--resume` restarts the session with the ledger intact.
 *   - Credentials but no TTY (or `--yes`) → the conversational path is
 *     refused (same convention as the other interactive verbs) and the
 *     scripted questionnaire runs instead.
 *   - No credentials → the scripted stdin questionnaire
 *     (name/shape/model/tools), byte-identical to pre-0.3.0, still emitting
 *     a `parseSpec`-validated spec via `buildScriptedSpec`.
 *
 * Reuses `runInit`'s exists-check/refuse-overwrite + standalone-dir guidance,
 * and composes with `--detect` (#40) to prefill the default model from a
 * reachable local endpoint / provider.
 */
async function runInitInteractive(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus init --interactive [name] [--detect] [--resume] [--yes]\n" +
        "  Interview-driven spec authoring. With credentials and a TTY, an agent runs a\n" +
        "  real multi-turn interview (persisted + resumable; every draft is validated\n" +
        "  against the live spec schema in-conversation). Without credentials, a scripted\n" +
        "  questionnaire (name/shape/model/tools) still emits a validated spec.\n" +
        "  --detect  prefill the default model from a reachable local endpoint/provider.\n" +
        "  --resume  continue a saved interview session where it stopped.\n" +
        "  --yes     skip the conversation; use the scripted questionnaire.\n",
    );
    return;
  }
  const nameArg = args.positional[0];
  const targetDir = typeof nameArg === "string" ? resolve(nameArg) : process.cwd();
  const specName = typeof nameArg === "string" ? nameArg : basename(targetDir);
  const targetFile = join(targetDir, "crewhaus.yaml");

  // Reuse runInit's refuse-overwrite invariant: --interactive must never
  // clobber existing work.
  if (existsSync(targetFile)) {
    die(`${targetFile} already exists — refusing to overwrite`);
  }

  // Item 39 ↔ #40 — compose with --detect to prefill a default model. When a
  // local endpoint is reachable, offer its first model as `local/<m>@<url>`;
  // otherwise fall back to the standard claude default.
  let defaultModel = "claude-opus-5";
  if (args.flags["detect"] === true) {
    const prefill = await detectDefaultModel();
    if (prefill !== undefined) defaultModel = prefill;
  }

  // Credential-gated path selection: try to resolve the default model's
  // adapter. A resolution failure (no credentials / missing optional adapter)
  // degrades to the scripted questionnaire — byte-identical messaging.
  const interviewer = await tryBuildInterviewer(defaultModel);
  const conversational = conversationalPathAllowed({
    stdinIsTTY: process.stdin.isTTY === true,
    assumeYes: args.flags["yes"] === true,
  });

  let yaml: string;
  let mappingLines: readonly string[] = [];
  if (interviewer !== undefined && conversational.allowed) {
    // v0.3.0 §2.9 — the conversational interview owns stdin via runChatLoop's
    // REPL (no line reader here: a second readline would steal input).
    process.stdout.write(
      args.flags["resume"] === true
        ? `interactive spec authoring (model: ${interviewer.modelId}) — resuming your saved interview.\n`
        : `interactive spec authoring (model: ${interviewer.modelId}). Describe the agent you want to build.\n`,
    );
    try {
      const result = await runConversationalInterview({
        targetDir,
        specName: `init-${basename(targetDir)}`,
        model: defaultModel,
        resume: args.flags["resume"] === true,
      });
      yaml = result.yaml;
      mappingLines = result.mappingLines;
    } catch (err) {
      // A classified terminal failure (billing/auth/token exhaustion) prints
      // the PR-3 FailureReport with the saved-interview hint and the coded
      // exit — the session + ledger are on disk, `--resume` continues.
      if (err instanceof RunFailedError) {
        const rendered = renderCliFailure(err, { notes: [INIT_INTERVIEW_SAVED_NOTE] });
        process.stderr.write(`${rendered.text}\n`);
        process.exit(rendered.exitCode);
      }
      throw err;
    }
  } else {
    if (args.flags["resume"] === true) {
      die(
        "crewhaus init --interactive --resume needs the conversational interview (model credentials and an interactive terminal)",
      );
    }
    const reader = createLineReader();
    try {
      if (interviewer === undefined) {
        process.stdout.write(
          "no model credentials detected — falling back to the scripted questionnaire.\n",
        );
      } else {
        process.stdout.write(
          `${conversational.reason ?? "conversational interview unavailable"} — falling back to the scripted questionnaire.\n`,
        );
      }
      yaml = (await runScriptedQuestionnaire({ reader, specName, defaultModel })).yaml;
    } finally {
      reader.close();
    }
  }

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetFile, yaml);
  process.stdout.write(`wrote ${targetFile}\n`);
  // v0.3.0 §2.9 — the REQ → spec-field mapping the model produced before
  // emit_spec, surfaced as the interview's closing summary.
  if (mappingLines.length > 0) {
    process.stdout.write(
      `requirements → spec mapping (from the interview):\n${mappingLines.map((l) => `  ${l}`).join("\n")}\n`,
    );
  }
  const rel = relative(process.cwd(), targetDir);
  const cd = rel === "" ? "" : `cd ${rel} && `;
  process.stdout.write(`next: ${cd}crewhaus run crewhaus.yaml\n`);
  logger.debug("init.interactive.success", { target: targetFile });
}

/**
 * Item 39 — the scripted (no-credentials) questionnaire. Collects the answers
 * `buildScriptedSpec` needs over stdin and returns the validated spec. A
 * validation failure (e.g. an unsafe name) re-prompts the offending field.
 */
async function runScriptedQuestionnaire(opts: {
  readonly reader: { ask(prompt: string): Promise<string> };
  readonly specName: string;
  readonly defaultModel: string;
}): Promise<{ yaml: string }> {
  const { ask } = opts.reader;
  const name = (await ask(`harness name [${opts.specName}]: `)) || opts.specName;
  const shapeInput = (await ask("target shape (cli | workflow | research) [cli]: ")) || "cli";
  const shape: ScriptedShape = isScriptedShape(shapeInput) ? shapeInput : "cli";
  if (!isScriptedShape(shapeInput)) {
    process.stdout.write(
      `  "${shapeInput}" is not scriptable here — defaulting to cli (use the model interview for other shapes).\n`,
    );
  }
  const model = (await ask(`model [${opts.defaultModel}]: `)) || opts.defaultModel;
  const instructions =
    (await ask("one-line instructions for the agent: ")) || "You are a helpful assistant.";
  const toolsLine = await ask("tools (comma-separated names, or blank): ");
  const tools = toolsLine
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const goal = shape === "research" ? (await ask("research goal: ")) || instructions : undefined;
  const answers: ScriptedAnswers = {
    name,
    shape,
    model,
    instructions,
    ...(tools.length > 0 ? { tools } : {}),
    ...(goal !== undefined ? { goal } : {}),
  };
  // buildScriptedSpec validates via parseSpec; a bad answer throws
  // SpecParseError, which the caller's CrewhausError catch routes through die().
  return buildScriptedSpec(answers);
}

/**
 * Item 39 / v0.3.0 §2.9 — credential gate for the conversational interview.
 * Resolves the model's adapter via the same `resolveModel` path the
 * scaffold-evals/mutator use; returns undefined when no credentials/adapter
 * are available so the caller degrades to the scripted questionnaire. The
 * interview itself runs on `runChatLoop` (init-conversation.ts), which
 * resolves the model again through the normal router path — the single-shot
 * forced-`emit_spec` propose closure this used to carry is gone (PR 18).
 */
async function tryBuildInterviewer(
  model: string,
): Promise<{ readonly modelId: string } | undefined> {
  try {
    const { resolveModel } = await import("@crewhaus/model-router");
    const resolution = await resolveModel(model);
    return { modelId: resolution.modelId };
  } catch {
    return undefined;
  }
}

/**
 * Item 39 ↔ #40 — best-effort default-model prefill for `--interactive
 * --detect`: probe the local endpoint and, if it advertises models, return the
 * first as a `local/<model>@<baseUrl>` string. Undefined when nothing is
 * reachable so the caller keeps the claude default. Never throws.
 */
async function detectDefaultModel(): Promise<string | undefined> {
  try {
    const { probeLocalEndpoint, localBaseUrl } = await import("./doctor-detect");
    const baseUrl = localBaseUrl(process.env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const local = await probeLocalEndpoint(baseUrl, async (url) => {
        const res = await fetch(url, { signal: controller.signal });
        return { ok: res.ok, status: res.status, json: () => res.json() };
      });
      const first = local.reachable ? local.models[0] : undefined;
      return first !== undefined ? `local/${first}@${baseUrl}` : undefined;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
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
    bashOutput: bash.bashOutput,
    killShell: bash.killShell,
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
  // Section 18 — code-execution tools (python/javascript/shell) share a single
  // `registerCodeExecutionConfig`. Mirror target-cli's resolveTools: honor a
  // per-tool config (first one seen) or the shared `codeExecution`/
  // `code_execution` alias, register once. Without this the run path ignored
  // tool_config for code-exec tools that the compiled bundle applies.
  if (used.has("python") || used.has("javascript") || used.has("shell")) {
    const cfg =
      toolConfigs["python"] ??
      toolConfigs["javascript"] ??
      toolConfigs["shell"] ??
      toolConfigs["codeExecution"] ??
      toolConfigs["code_execution"];
    if (cfg !== undefined) {
      const { registerCodeExecutionConfig } = await import("@crewhaus/tool-code-execution");
      registerCodeExecutionConfig(cfg as Parameters<typeof registerCodeExecutionConfig>[0]);
    }
  }
}

/**
 * Section 18 — resolve `sandboxAvailable` for the `run` path from the
 * `CREWHAUS_SANDBOX` env var, using the SAME grammar the compiled bundle
 * emits (`packages/target-cli` renderRun): unset defaults to `"docker"`
 * (available); any value whose lowercase is `"noop"` disables the sandbox
 * floor (code-exec tools are then denied by permission-engine's
 * `requiresSandbox` floor). Pure — reads only the passed env snapshot.
 */
export function resolveSandboxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["CREWHAUS_SANDBOX"] ?? "docker").toLowerCase() !== "noop";
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
 * Loop contract 0.4 (Batch C, G11) — the `askMode` + `approvals` fragment
 * spread into every non-interactive `runChatLoop` this CLI drives.
 *
 * Both halves are required for a headless `ask` to PARK rather than deny in
 * place: runtime-core's branch is `approvals !== undefined && askMode ===
 * "pause"`. The spec field, the IR lowering, the runtime park logic, the
 * `crewhaus approvals` verbs and `crewhaus runs resume` all shipped — only
 * this fragment was missing, so `permissions.ask_mode: pause` was silently
 * inert on every interpreter path and `createPendingApprovalStore` had no
 * production caller at all.
 *
 * The store root comes from `resolveSessionRootDir`, NOT `process.cwd()`:
 * parks then land beside the session files they belong to, and inside a
 * tenant's rebased root when one is active — a process-global
 * `.crewhaus/sessions` would pool one tenant's pending approvals (including
 * the tool input echoed in the record) into another tenant's directory.
 *
 * The store is passed under `"deny"` too, even though that mode never parks.
 * It costs nothing — `createPendingApprovalStore` does no I/O until something
 * is actually persisted, so a deny-mode run still writes no `approvals.jsonl`
 * — and it keeps the runtime's own diagnostic honest: runtime-core picks
 * between "(no approvals store wired)" and '(ask_mode: "deny")' by testing
 * whether a store was supplied, so withholding it would blame missing plumbing
 * for what is a deliberate operator choice. Getting that wrong is precisely
 * how this defect stayed invisible.
 *
 * The REPL is unaffected either way — runtime-core prefers its interactive
 * `askApproval` prompter, and only falls through to this when there is no
 * one to ask.
 */
function approvalRunOptions(
  args: ParsedArgs,
  permissions: { readonly askMode?: AskMode },
): Pick<RunChatLoopOptions, "askMode" | "approvals"> {
  const rootDir = resolveSessionRootDir(undefined);
  return {
    askMode: resolveAskMode(args.flags["ask-mode"], permissions.askMode),
    approvals: { store: createPendingApprovalStore(rootDir !== undefined ? { rootDir } : {}) },
  };
}

/**
 * Reject an invalid `--ask-mode` at the TOP of a command, before any boot
 * work. Separate from `approvalRunOptions` because that runs inline in the
 * `runChatLoop({...})` literal — far too late for a `die()` (a process.exit)
 * to unwind a launched browser or a connected MCP server.
 */
function assertValidAskModeFlag(args: ParsedArgs): void {
  const flag = args.flags["ask-mode"];
  if (typeof flag === "string" && !isValidAskMode(flag)) {
    die(`invalid --ask-mode "${flag}" — allowed: ${VALID_ASK_MODES.join(", ")}`);
  }
}

/** The root a run's sessions and approvals actually live under. */
function sessionRootDir(): string {
  return resolveSessionRootDir(undefined) ?? join(process.cwd(), SESSIONS_SUBDIR);
}

/**
 * A session store rooted where `runChatLoop` actually writes — tenant root,
 * else `CREWHAUS_SESSION_DIR`, else `<cwd>/.crewhaus/sessions`.
 *
 * The bare `createSessionStore()` these call sites used defaults to the
 * cwd-relative path only, so with `CREWHAUS_SESSION_DIR` set a run wrote its
 * transcript to one directory while `--continue` and `runs resume` looked in
 * another and reported "no session". That was survivable while nothing
 * depended on it; it is not now, because `runs resume` is half of the
 * documented park → grant → resume flow this CLI finally supports.
 */
function openRunSessionStore(): ReturnType<typeof createSessionStore> {
  const rootDir = resolveSessionRootDir(undefined);
  return createSessionStore(rootDir !== undefined ? { rootDir } : {});
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
      "usage: crewhaus run <spec.yaml> [--model <model>] [--permission-mode <default|plan|auto|bypass>] [--ask-mode <pause|deny>] [--resume <sessionId> | --continue] [--prompt <text>] [--streaming] [--trace off|ring|pretty|json] [--budget-usd <n>] [--justification-judge rule-based|claude] [--egress-matcher substring|semantic] [--egress-embedder <model>]\n" +
        "  --prompt <text> runs a single turn non-interactively and prints the reply, then exits (no REPL) — for scripting/CI; composes with --resume/--continue\n" +
        "  --ask-mode <pause|deny> overrides the spec's permissions.ask_mode for a tool permission that resolves to `ask` with no interactive surface to prompt on:\n" +
        "    pause (default) parks the run — persists a pending approval, exits 36 — so `crewhaus approvals grant <id>` + `crewhaus runs resume <session>` can re-drive it pre-approved;\n" +
        "    deny refuses the call in place and lets the turn continue with the denial explained to the model. The REPL always prompts on stdin regardless.\n" +
        "  --model accepts the full router grammar: claude-* (Anthropic), openai/<m>, gemini/<m>, bedrock/<id> (geo prefixes tolerated), local/<m>@<url>\n" +
        '  --plugins <a,b,c> overrides the spec\'s plugins: list for this run (installed plugin names, comma-separated; --plugins "" activates none)\n' +
        "  --streaming dispatches tools mid-stream (as each tool_use block completes) instead of after the full response; the spec's agent.streaming sets the default, the flag forces it on\n" +
        "  --trace <level> overrides the spec's observability.trace.level for this run: pretty/json attach the structured-event-printer, ring keeps only the bus ring buffer (default), off suppresses the printer; the flag wins over the spec block and CREWHAUS_TRACE\n" +
        "  Cost tracking is ON by default (accrues per-call spend; set observability.cost.enabled: false to disable, CREWHAUS_COST_INLINE=1 to print a per-call line, `crewhaus cost-summary --session <id>` to total it after the run)\n" +
        "  --budget-usd <n> caps this run's model spend in dollars: it sets/overrides the spec budget.usd ceiling and keeps the spec's on_exceed ladder (stop when the spec has none).\n" +
        "    Interplay with the spec's limits: block — the budget cap and the limits ceilings (max_tool_iterations, max_concurrent_tools, context_limit, deadline_ms, turn_timeout_ms,\n" +
        "    model_call_timeout_ms, loop_detection) are enforced INDEPENDENTLY; whichever bound trips first governs. The budget check gates EVERY model call (tool iterations\n" +
        "    included — a breach mid-turn ends the run with the classified crewhaus_budget failure at a request boundary; the REPL's pre-turn check still ends an idle run cleanly),\n" +
        "    while the limits ceilings bound the CURRENT turn/run. --budget-usd never widens a limit and limits: never raises the spend cap. budget.scope: session seeds the meter on --resume.\n" +
        "  A spec with a feedback: block asks `rate this session? [g]ood / [b]ad / [enter] skip`\n" +
        "  on clean REPL exit (one keystroke, 10s timeout, TTY only — never when piped; the prompt\n" +
        "  lives in the runtime, so a COMPILED bundle asks it too). Opt out with\n" +
        "  CREWHAUS_NO_EXIT_RATING=1 or feedback.exitPrompt: false. With feedback.autoDistill\n" +
        "  enabled, accumulated ratings are auto-distilled into the `<specName>-ratings` registry\n" +
        "  dataset at teardown (item 1, this path only — a compiled bundle captures ratings but\n" +
        "  does not distill them; `crewhaus distill --register` does) — see `crewhaus optimize --help`.\n",
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  // Reject a bad --ask-mode HERE, before anything boots. `die()` is a
  // process.exit, so validating it where it is consumed (inline in the
  // runChatLoop literal) would skip the browser path's
  // `finally { driver.disconnect() }` and orphan a headless Chromium on a typo.
  assertValidAskModeFlag(args);

  // Item 41 — `run --watch`: the same debounced parse→lint→compile re-validate
  // loop as `compile --watch`, an authoring aid that does NOT re-launch the
  // agent (which would require tearing down a live REPL/session on every edit).
  if (args.flags["watch"] === true) {
    await runCompileWatch({ specPath, strict: true, readme: true });
    return;
  }

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

  // Hangar F-1 — the spec resolved: self-register the cwd (the harness root
  // per the standalone-harness convention) in the machine-wide registry.
  // Never throws; CREWHAUS_NO_REGISTRY=1 opts out.
  registerHarnessCwd({ specName: ir.name, target: ir.target, originDetail: "run" });

  // Loop contract 0.4 (Batch C, G26) — apply the run's observability toggles to
  // the env the runtime's subscriber layer reads, mirroring what a compiled
  // bundle stamps at boot (cost-on-by-default; trace printer for pretty/json).
  applyRunObservabilityEnv(args, ir);

  if (ir.target === "cli") return runRunCli(args, ir, specPath);
  if (ir.target === "browser") return runRunBrowser(args, ir);
  die(
    `crewhaus run supports target: cli or browser (got "${ir.target}"). Other target shapes are compile-only — see PACKAGES.md.`,
  );
}

/**
 * Loop contract 0.4 (Batch C, G26) — apply this run's observability env, so
 * `crewhaus run` honours the spec's `observability` block exactly like a
 * compiled bundle (which stamps the same env at boot). The precedence rules
 * live in the pure `run-observability` module (unit-tested); this only
 * validates the flag and mutates `process.env` before the runtime's env-driven
 * subscriber layer attaches.
 *
 * - trace: `--trace` flag > `observability.trace.level` > `"ring"`. `pretty`/
 *   `json` attach the structured-event-printer; `ring`/`off` attach no printer.
 *   The FLAG wins absolutely over the spec block and ambient `CREWHAUS_TRACE`.
 * - cost: ON by default unless the spec sets `observability.cost.enabled:
 *   false` (it prints nothing on its own; `CREWHAUS_COST_INLINE=1` surfaces a
 *   per-call line, `cost-summary` totals it after the run).
 */
function applyRunObservabilityEnv(args: ParsedArgs, ir: ReturnType<typeof lower>): void {
  const obs = (
    ir as {
      observability?: {
        trace?: { level?: string };
        cost?: { enabled?: boolean };
      };
    }
  ).observability;

  const traceFlag = args.flags["trace"];
  if (typeof traceFlag === "string" && !isValidTraceLevel(traceFlag)) {
    die(`--trace must be one of: ${TRACE_LEVELS.join(", ")} (got "${traceFlag}")`);
  }
  const trace = resolveTraceEnv(
    typeof traceFlag === "string" ? traceFlag : undefined,
    obs?.trace?.level,
    process.env["CREWHAUS_TRACE"],
  );
  if (trace !== undefined) process.env["CREWHAUS_TRACE"] = trace;

  const cost = resolveCostEnv(obs?.cost?.enabled, process.env["CREWHAUS_COST_TRACKING"]);
  if (cost !== undefined) process.env["CREWHAUS_COST_TRACKING"] = cost;

  // "Watch me" (design/watch-me.md §6.3) — same junction as the G26 stamps:
  // spec-opted full capture OR a `crewhaus watchme start`ed harness turns the
  // runtime capture tap's env on; an already-set ambient env wins (the `??=`
  // semantics the compiled-bundle boot stamps share).
  const irWatchme = (ir as { watchme?: { enabled: boolean; capture: string } }).watchme;
  const watchme = resolveWatchmeEnv(
    irWatchme !== undefined ? irWatchme.enabled && irWatchme.capture === "full" : undefined,
    openWatchmeStore(join(process.cwd(), ".crewhaus")).state().watching,
    process.env["CREWHAUS_WATCHME"],
  );
  if (watchme !== undefined) process.env["CREWHAUS_WATCHME"] = watchme;
}

/**
 * Loop contract 0.4 (Batch F, item 7, CLI half) — `crewhaus runs resume
 * <session> [--spec <path>] [--prompt <text>] [--model <m>] …`.
 *
 * Re-drives a persisted cli session: resolves the spec backing it (`--spec`, or
 * `crewhaus.yaml` in the cwd), confirms the session exists AND belongs to that
 * spec, then hands off to the SAME resumed run path `run --resume` uses
 * (`runRunCli` → `runChatLoop({ resume: { sessionId } })`, which replays the
 * transcript and continues). The dedicated verb is the natural home for
 * re-driving a run a headless session PARKED (`permissions.ask_mode: pause`,
 * exit 36) after `crewhaus approvals grant/deny` resolved the park — the
 * recorded decision is consumed as the loop continues. Passes `--prompt`
 * through for a one-shot continuation, or resumes the interactive REPL.
 */
async function runRunsResume(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] === true) {
    process.stdout.write(
      "usage: crewhaus runs resume <session> [--spec <path>] [--prompt <text>] [--model <m>]\n" +
        "                        [--ask-mode <pause|deny>] [--trace off|ring|pretty|json]\n" +
        "                        [--budget-usd <n>] [--streaming]\n" +
        "  Re-drives a persisted cli session (a sess_<16 hex> id) — replaying its\n" +
        "  transcript and continuing the loop. The session store keeps only\n" +
        "  name/target/model, so the spec is resolved from --spec, else\n" +
        "  crewhaus.yaml in the cwd (sessions live under the dir you run from,\n" +
        "  or under CREWHAUS_SESSION_DIR when it is set).\n" +
        "  Typical use: after a headless run PARKED on a pending approval\n" +
        "  (permissions.ask_mode: pause, exit 36) and `crewhaus approvals grant`\n" +
        "  resolved it — `runs resume --prompt <text>` re-issues the parked call\n" +
        "  pre-approved (the grant is one-shot). Without --prompt this resumes the\n" +
        "  interactive REPL, where an `ask` prompts on stdin instead.\n" +
        "  --prompt <text> runs one more turn non-interactively and exits.\n" +
        "  --ask-mode <pause|deny> overrides the spec's permissions.ask_mode,\n" +
        "  exactly as on `crewhaus run`.\n",
    );
    return;
  }
  const sessionId = args.positional[0];
  if (typeof sessionId !== "string") {
    die(
      "missing <session> — a sess_<16 hex> id (list live sessions with `crewhaus sessions tail`)",
    );
  }
  if (!isRunsSessionId(sessionId)) {
    die(`invalid <session> "${sessionId}" — expected sess_<16 hex>`);
  }

  // Resolve the spec backing the resume (--spec, else cwd/crewhaus.yaml).
  let specPath: string;
  try {
    specPath = resolveRunsResumeSpecPath(strFlag(args, "spec"), process.cwd());
  } catch (err) {
    if (err instanceof RunsError) die(err.message);
    throw err;
  }

  let yamlText: string;
  try {
    yamlText = readFileSync(specPath, "utf-8");
  } catch (err) {
    die(`could not read ${specPath}: ${(err as Error).message}`);
  }
  let ir: ReturnType<typeof lower>;
  try {
    ir = lower(parseSpec(yamlText));
  } catch (err) {
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
  if (ir.target !== "cli") {
    die(
      `runs resume supports target: cli (got "${ir.target}") — only the cli loop persists a resumable session transcript.`,
    );
  }

  // Confirm the session exists AND belongs to this spec before re-driving — a
  // mismatched name means the wrong spec was resolved, which would replay one
  // agent's transcript into another's instructions.
  const store = openRunSessionStore();
  const session = await store.get(sessionId);
  if (session === null) {
    die(
      `no session "${sessionId}" under ${sessionRootDir()}. Run from the harness directory that owns it, or check the id with \`crewhaus sessions tail\`.`,
    );
  }
  if (session.name !== ir.name) {
    die(
      `session "${sessionId}" belongs to spec "${session.name}", but ${specPath} is "${ir.name}". Pass --spec for the session's own spec.`,
    );
  }

  applyRunObservabilityEnv(args, ir);
  // Hand off to the shared resumed run path with the resume flag synthesized —
  // the exact machinery `run --resume` drives, so a resumed session behaves
  // identically whichever verb reached it.
  const resumeArgs: ParsedArgs = {
    positional: [specPath],
    flags: { ...args.flags, resume: sessionId },
  };
  await runRunCli(resumeArgs, ir, specPath);
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
    const store = openRunSessionStore();
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

  // `--prompt <text>` runs ONE turn non-interactively and exits (no REPL) —
  // the cli analogue of the browser target's --prompt and `claude -p`, for
  // scripting/CI/pipelines. The final assistant message is written to stdout.
  // Composes with --resume/--continue (one more turn on a resumed session).
  const promptFlag = args.flags["prompt"];
  let oneShotPrompt: string | undefined;
  if (typeof promptFlag === "string") {
    const trimmed = promptFlag.trim();
    if (trimmed.length === 0) {
      die("--prompt requires non-empty text");
    }
    oneShotPrompt = trimmed;
  }

  // Phase 3 §3.3 — the spec's `cli.banner`, printed on cold start. This used
  // to be codegen-only: a compiled bundle showed the brand, `crewhaus run`
  // never read `ir.cli`, so an authored banner was invisible to everyone who
  // ran the spec directly. Both surfaces now render from the same module
  // (@crewhaus/target-cli's `renderBanner`, which the emitted snippet is
  // pinned to by a parity test), and a resumed session doesn't re-banner —
  // the `--resume`/`--continue` behaviour the spec block always documented.
  const banner = ir.cli?.banner;
  if (
    banner !== undefined &&
    shouldPrintBanner({ banner, resumed: resumeId !== undefined, env: process.env })
  ) {
    process.stdout.write(renderBanner(ir.name, banner));
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
  // Item 38 — synthetic notice appended to the agent instructions when the MCP
  // auto-quarantine withdraws a server's tools (built in the block below).
  let mcpQuarantineNotice: string | undefined;
  // v0.3.0 Goal 3 — the thredz server (synthesized by the compiler, or the
  // user's own vendored entry) boots through connectThredz: its wiki+goals
  // tools land under their BARE names (§4.3, one vocabulary across
  // backends) and boot failure DEGRADES (null → wireMemory falls back to
  // local files with a warning) instead of failing the run.
  let thredzConn: ThredzConnection | null = null;
  const thredzWired = ir.thredz !== undefined && ir.mcp_servers["thredz"] !== undefined;
  if (Object.keys(ir.mcp_servers).length > 0) {
    const host = new McpHost({ logger });
    mcpHost = host;
    for (const [name, cfg] of Object.entries(ir.mcp_servers)) {
      // 0.3.0 — env/header values are IrSecretRef; resolve them from the
      // interpreter process's environment (fail-fast, names the variable).
      // #406 — optional servers are NOT added here: their config resolution
      // + addServer run inside registerOptionalMcpServer's never-throw
      // boundary below (an unset env var on an optional peer must degrade,
      // not kill the run).
      if (cfg.required === false && !(thredzWired && name === "thredz")) continue;
      host.addServer(name, resolveMcpServerConfig(cfg, { name }));
    }
    const tempCatalog = new ToolCatalog();
    for (const t of tools) tempCatalog.register(t);
    if (thredzWired) {
      thredzConn = await connectThredz(host, tempCatalog, {
        log: (line) => process.stdout.write(line),
        ...(ir.thredz?.agentName !== undefined ? { agentName: ir.thredz.agentName } : {}),
      });
    }
    // #406 — `required: false` servers degrade instead of failing the run.
    // The interpreter's tool list freezes right below, so the optional path
    // is degrade-only (retry: false): tools absent for this run.
    await Promise.all(
      Object.entries(ir.mcp_servers)
        .filter(([name, cfg]) => !(thredzWired && name === "thredz") && cfg.required !== false)
        .map(([name]) =>
          registerMcpServer(host, name, tempCatalog, {
            onRegister: ({ fullName }) => process.stdout.write(`[mcp] registered ${fullName}\n`),
          }),
        ),
    );
    for (const [name, cfg] of Object.entries(ir.mcp_servers)) {
      if ((thredzWired && name === "thredz") || cfg.required !== false) continue;
      const { required: _requiredFlag, ...wireCfg } = cfg as typeof cfg & { required?: false };
      await registerOptionalMcpServer(host, name, tempCatalog, {
        retry: false,
        config: () => resolveMcpServerConfig(wireCfg, { name }),
        log: (line) => process.stdout.write(line),
        onRegister: ({ fullName }) => process.stdout.write(`[mcp] registered ${fullName}\n`),
      }).firstAttempt;
    }
    tools = tempCatalog.list().slice();

    // Item 38 — runtime auto-quarantine. `crewhaus mcp doctor` persists the set
    // of chronically-failing servers to `.crewhaus/mcp/quarantine.json`; here we
    // withdraw those servers' namespaced (`<server>__<tool>`) tools from the
    // catalog so the model can't call them, and append a synthetic notice to the
    // instructions (mirroring loop-detection's warning injection) so the model
    // routes around them. Opt out with --no-mcp-quarantine. Auto-restore is
    // implicit: once `mcp doctor` clears a server from the set (a probe / recent
    // session showed it healthy), the next run registers its tools normally.
    if (args.flags["no-mcp-quarantine"] !== true) {
      const quarantinePath = join(process.cwd(), ".crewhaus", "mcp", "quarantine.json");
      let quarantinedServers: string[] = [];
      if (existsSync(quarantinePath)) {
        try {
          const parsed = JSON.parse(readFileSync(quarantinePath, "utf-8")) as { servers?: unknown };
          if (Array.isArray(parsed.servers)) {
            quarantinedServers = parsed.servers.filter(
              (s): s is string => typeof s === "string" && s in ir.mcp_servers,
            );
          }
        } catch {
          // corrupt gate — ignore (never fail a run on a bad quarantine file).
        }
      }
      if (quarantinedServers.length > 0) {
        const prefixes = quarantinedServers.map((s) => `${s}__`);
        tools = tools.filter((t) => !prefixes.some((p) => t.name.startsWith(p)));
        mcpQuarantineNotice = quarantinedServers
          .map((s) => quarantineNotice(s, "flagged chronically failing by `crewhaus mcp doctor`"))
          .join("\n");
        process.stdout.write(
          `[mcp] quarantined ${quarantinedServers.length} server(s): ${quarantinedServers.join(", ")} — pass --no-mcp-quarantine to override\n`,
        );
      }
    }
  }

  // Loop contract 0.4 (Batch E, G22) — `knowledge:` RAG. When the spec
  // declares a knowledge block, ingest every source at boot and register the
  // shared `Retrieve` tool alongside the built-ins/MCP tools, mirroring the
  // cli/channel/managed emitters. The embedder model resolves per G76
  // (`knowledge.embedder → memory.embedder → memory.wiki.embedder → default`);
  // the store never degrades to BM25, so a missing provider key fails loudly.
  if (ir.knowledge !== undefined) {
    const retrieveTool = await ingestKnowledge(ir.knowledge, {
      cwd: process.cwd(),
      ...(ir.memory?.embedder !== undefined ? { memoryEmbedder: ir.memory.embedder } : {}),
      ...(ir.memory?.wiki?.embedder !== undefined ? { wikiEmbedder: ir.memory.wiki.embedder } : {}),
      log: (line) => process.stdout.write(line),
    });
    tools.push(retrieveTool);
  }

  const modelOverride = args.flags["model"];
  const model = typeof modelOverride === "string" ? modelOverride : ir.agent.model;

  // Loop contract 0.4 (Batch A) — streaming tool dispatch: `--streaming`
  // forces it on; otherwise the spec's `agent.streaming` is carried
  // verbatim; neither → absent (runtime default false). One diagnostic
  // line so the mode is observable (mirrors the [sandbox] convention).
  const streaming = resolveStreaming(args.flags["streaming"] === true, ir.agent.streaming);
  if (streaming === true) {
    process.stdout.write("[streaming] mid-stream tool dispatch enabled\n");
  }

  // Item 27 — run-level spend cap: `--budget-usd <n>` (flag) > spec `budget`.
  // The flag sets/overrides the dollar ceiling and keeps the spec's on_exceed
  // ladder (defaulting to `stop` when the spec has no budget block). Absent
  // flag + absent spec block → no cap.
  const budgetUsdFlag = args.flags["budget-usd"];
  let runBudget: IrBudget | undefined;
  if (typeof budgetUsdFlag === "string") {
    const usd = Number.parseFloat(budgetUsdFlag);
    if (!Number.isFinite(usd) || usd <= 0) {
      die(`invalid --budget-usd "${budgetUsdFlag}" — expected a positive dollar amount`);
    }
    runBudget = {
      usdMicros: Math.round(usd * 1_000_000),
      onExceed: ir.target === "cli" ? (ir.budget?.onExceed ?? { kind: "stop" }) : { kind: "stop" },
      // 0.6.0 — the flag overrides the ceiling only; the spec's `scope`
      // (when declared) rides along like its `on_exceed` ladder does.
      ...(ir.target === "cli" && ir.budget?.scope !== undefined ? { scope: ir.budget.scope } : {}),
    };
  } else if (ir.target === "cli" && ir.budget !== undefined) {
    runBudget = ir.budget;
  }

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
  // FR-004 / item 20 — open the shared durable audit sink both Pillar 3 gates
  // append to (rooted at .crewhaus/audit): the intent gate writes
  // `permission_justification_evaluated`, and the egress classifier writes
  // `egress_decision` for non-pass verdicts (so `crewhaus egress review` can
  // triage them offline). One log = one hash chain. On by default for `run`;
  // `--no-justification-audit` skips it. undefined leaves runtime-core writing
  // only the ephemeral trace-bus events.
  const securityAuditSink = await openSecurityAuditSink({
    cwd: process.cwd(),
    enabled: args.flags["no-justification-audit"] !== true,
  });
  const justificationAuditSink = securityAuditSink;
  const egressAuditSink = asEgressAuditSink(securityAuditSink);

  // FR-006 — resolve the Pillar 3 sink-side egress matcher (flag > spec >
  // substring). undefined leaves runtime-core on the built-in
  // `substringMatcher`; `"semantic"` constructs the optional
  // `@crewhaus/egress-matcher-semantic` with an injected embedder. The
  // placement (IR-wired, every external sink) and the warn/block policy are
  // unchanged — only *how* lineage matches are detected.
  const egressMatcher = await resolveEgressMatcher(args, ir.security?.egressMatcher);

  // Item 3 (G32) — plugin activation, the same split boot a compiled bundle
  // runs (renderPlugins in @crewhaus/target-cli): activate EARLY so the plugins'
  // `<plugin>/skills` dirs feed skill discovery below, and register their tools
  // LATE (after built-in/skill/memory/sub-agent tools) so a first-party name
  // wins the collision. `--plugins <a,b>` overrides the spec's `plugins:` list
  // (an empty override activates none); absent → the spec list, so a spec with
  // no `plugins:` and no flag activates nothing (the pre-Batch-G path).
  const pluginNames = resolvePluginNames(ir.plugins, strFlag(args, "plugins"));
  let pluginSkillDirs: readonly string[] = [];
  let pluginTools: readonly RegisteredTool[] = [];
  if (pluginNames.length > 0) {
    const activated = await activatePlugins({
      names: pluginNames,
      ...createDefaultPluginRuntime({
        allowUnsigned: process.env["CREWHAUS_PLUGIN_ALLOW_UNSIGNED"] === "1",
      }),
    });
    pluginSkillDirs = activated.skillDirs;
    pluginTools = activated.tools;
    process.stdout.write(
      `[plugins] ${activated.loaded.length} activated: ${pluginNames.join(", ")}\n`,
    );
    for (const warning of activated.warnings) process.stdout.write(`[plugins] ${warning}\n`);
  }

  // Section 11 — discover hooks, skills, and slash commands from the user's
  // workspace. Hooks come from `~/.crewhaus/settings.json` + `<cwd>/.crewhaus/settings.json`;
  // skills from `~/.crewhaus/skills/*/SKILL.md` + project-equivalent (plus the
  // activated plugins' skill dirs); slash commands from `<cwd>/.crewhaus/commands/*.md`.
  // When skills are present, a synthetic `Skill(name)` tool is appended to the
  // tool list so the model can lazily fetch each skill's body.
  const cwd = process.cwd();
  const [settingsHooks, discoveredSkills, discoveredCommands] = await Promise.all([
    loadHooks({ cwd }),
    discoverSkills({ cwd, ...(pluginSkillDirs.length > 0 ? { pluginDirs: pluginSkillDirs } : {}) }),
    loadCommands({ cwd }),
  ]);
  // Loop contract 0.4 (Batch A) — spec-declared `hooks:` layer BELOW the
  // settings.json layers: spec entries first, then loadHooks()' user →
  // project entries (aggregateDecisions' later-wins mutate merge keeps the
  // user's/project's overrides authoritative — the permission RuleSet's
  // settings-over-yaml precedence). Everything downstream (the alert/SLO
  // sinks' event filters AND runChatLoop) reads the MERGED list, so a spec
  // hook is a full citizen of every hook surface.
  const hooks = mergeSpecHooks(ir.hooks, settingsHooks);

  // Feature #53 / v0.3.0 PR 11 — memory + continuity, wired through the
  // composition root. The SAME `wireMemory(fragment, deps)` call a compiled
  // bundle emits runs here: it constructs the stores, registers the tools
  // (into this run's local tool list via the registrar shim), and returns
  // the runChatLoop seams. Continuity is DEFAULT-ON for the cli target —
  // `ir.continuity` is present unless the spec opted out with
  // `continuity: false` (the compiler dropped the key at lower time, so
  // opted-out specs run exactly the pre-0.3.0 path — no flag needed).
  // When continuity is on, the composition root owns the skill/command
  // surface (builtin `continuity` skill + commands merged at LOWEST
  // precedence with ~/.crewhaus + project entries) and the interpreter
  // adopts it wholesale, exactly like a compiled bundle — registering the
  // Skill tool from its own discovery would strand the builtin skill.
  let skills: ReadonlyArray<SkillRef> = discoveredSkills;
  let slashCommands: ReadonlyMap<string, SlashCommand> = discoveredCommands;
  let memoryRunOpt: Parameters<typeof runChatLoop>[0]["memory"];
  let continuityRunOpt: Parameters<typeof runChatLoop>[0]["continuity"];
  if (
    (ir.memory !== undefined && ir.memory.enabled !== false) ||
    ir.continuity !== undefined ||
    ir.thredz !== undefined
  ) {
    const wiredMemory = await wireMemory(memoryFragmentFromIr(ir), {
      catalog: {
        register: (tool) => {
          tools.push(tool);
        },
      },
      cwd: process.cwd(),
      log: (line) => process.stdout.write(line),
      // Loop contract 0.4 (Batch A) — top-level fact-store embedder (spec
      // `memory.embedder`): constructed here and handed to wireMemory as
      // `deps.embedder`, which memory-service's resolveEmbedder prefers
      // over the fragment's `wiki.embedder` — the documented fallback
      // order (`embedder` → `wiki.embedder`). Mirrors target-cli codegen.
      ...(ir.memory !== undefined && ir.memory.enabled !== false && ir.memory.embedder !== undefined
        ? { embedder: createEmbedder({ model: ir.memory.embedder }) }
        : {}),
      // v0.3.0 Goal 3 — the live connection (or null after a boot failure,
      // which wireMemory degrades from). Absent when thredz is off.
      ...(ir.thredz !== undefined ? { thredz: thredzConn } : {}),
      // v0.3.0 Goal 2 (§3.3, PR 17) — the first-class exam: `/exam` drives
      // the run_exam tool, which invokes the eval library programmatically
      // (no agent-shells-to-`crewhaus` hack, no Bash permission needed).
      ...(ir.learning?.exam !== undefined
        ? {
            examRunner: createExamRunner({
              specName: ir.name,
              model,
              instructions: ir.agent.instructions,
              fragment: memoryFragmentFromIr(ir),
              cwd: process.cwd(),
              ...(ir.thredz !== undefined ? { thredz: thredzConn } : {}),
            }),
          }
        : {}),
    });
    memoryRunOpt = wiredMemory.options.memory;
    continuityRunOpt = wiredMemory.options.continuity;
    if (wiredMemory.options.skills !== undefined) skills = wiredMemory.options.skills;
    if (wiredMemory.options.slashCommands !== undefined) {
      slashCommands = wiredMemory.options.slashCommands;
    }
    // v0.3.0 PR 14 (§6.3) — boot-time dream catch-up: when the schedule is
    // overdue, run the DETERMINISTIC phase only (sub-second, zero spend).
    // Unattended model spend is never a side effect of starting a session —
    // the full consolidation stays behind `crewhaus dream`.
    if (ir.memory?.dream !== undefined) {
      const dreamNote = await runDreamBootCatchUp(memoryFragmentFromIr(ir), {
        cwd: process.cwd(),
      });
      if (dreamNote !== null) process.stdout.write(`${dreamNote}\n`);
    }
  }

  if (skills.length > 0) {
    tools.push(createSkillTool(skills));
    process.stdout.write(
      `[skills] ${skills.length} available: ${skills.map((s) => s.name).join(", ")}\n`,
    );
  }
  if (hooks.length > 0) {
    const specHookCount = ir.hooks?.length ?? 0;
    process.stdout.write(
      `[hooks] ${hooks.length} loaded${specHookCount > 0 ? ` (${specHookCount} from spec)` : ""}\n`,
    );
  }
  if (slashCommands.size > 0) {
    process.stdout.write(
      `[slash] ${slashCommands.size} commands: ${[...slashCommands.keys()].join(", ")}\n`,
    );
  }

  // Item 31 — alert watchdog delivery. The watchdog itself is gated inside
  // runtime-core by CREWHAUS_ALERTS; here we build its optional delivery sink
  // (audit append + settings.json `alert` hook + `alerts.webhook` POST) so a
  // breach lands durably + off-box. Only opened when CREWHAUS_ALERTS is set —
  // no audit-log file / hook wiring otherwise. undefined leaves the watchdog
  // with just its trace event + snapshot.
  const alertsEnabled =
    process.env["CREWHAUS_ALERTS"] === "1" || process.env["CREWHAUS_ALERTS"] === "true";
  let alertSink: ReturnType<typeof buildAlertSink>;
  if (alertsEnabled) {
    const { openAuditLog } = await import("@crewhaus/audit-log");
    const alertAudit = await openAuditLog({ rootDir: join(cwd, ".crewhaus", "audit") });
    // Read alerts.webhook from settings.json (best-effort; a parse error here
    // must not block the run — the permission path already surfaces bad JSON).
    let webhookUrl: string | undefined;
    const settingsPath = join(cwd, ".crewhaus", "settings.json");
    if (existsSync(settingsPath)) {
      try {
        webhookUrl = alertWebhookFromSettings(JSON.parse(readFileSync(settingsPath, "utf-8")));
      } catch {
        // ignore — buildRuleSet already dies loudly on malformed settings.json.
      }
    }
    const alertHooks = hooks.filter((h) => h.event === "alert");
    alertSink = buildAlertSink({
      audit: alertAudit,
      ...(alertHooks.length > 0
        ? {
            runAlertHooks: async (event, payload, matcherKey): Promise<void> => {
              await runHooks(event, payload, alertHooks, { matcherKey });
            },
          }
        : {}),
      ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    });
  }

  // Item 37 — SLO monitor targets + mitigation ladder. Targets come from the
  // lowered `observability.slo` block; the monitor itself is gated inside
  // runtime-core by CREWHAUS_SLO. Here we build its injected mitigation sink:
  //   - audit        → the same .crewhaus/audit hash chain the alert sink uses;
  //   - alert        → reuses the settings.json alert hook / webhook;
  //   - pause-intake → flips the durable .crewhaus/slo/intake.json gate the
  //                    gateway/managed daemon reads for its 429 budget_exceeded
  //                    path (only meaningful for those shapes; harmless else);
  //   - rollback     → auto-rollback the "prod" env pin via the deployment-
  //                    controller when the cwd carries a spec-registry.
  // Only opened when CREWHAUS_SLO is set AND the spec declared SLO targets.
  const sloEnabled = process.env["CREWHAUS_SLO"] === "1" || process.env["CREWHAUS_SLO"] === "true";
  const sloIr = (ir as { observability?: { slo?: import("@crewhaus/runtime-core").SloTargets } })
    .observability?.slo;
  let sloTargets: import("@crewhaus/runtime-core").SloTargets | undefined;
  let sloSink: ReturnType<typeof buildSloSink>;
  if (sloEnabled && sloIr !== undefined) {
    sloTargets = sloIr;
    const { openAuditLog } = await import("@crewhaus/audit-log");
    const sloAudit = await openAuditLog({ rootDir: join(cwd, ".crewhaus", "audit") });
    // Read alerts.webhook again (independent best-effort; same source as alerts).
    let webhookUrl: string | undefined;
    const settingsPath = join(cwd, ".crewhaus", "settings.json");
    if (existsSync(settingsPath)) {
      try {
        webhookUrl = alertWebhookFromSettings(JSON.parse(readFileSync(settingsPath, "utf-8")));
      } catch {
        // ignore — surfaced elsewhere.
      }
    }
    const alertHooks = hooks.filter((h) => h.event === "alert");
    const wantsAlert = sloTargets.mitigation.includes("alert");
    const wantsPause = sloTargets.mitigation.includes("pause-intake");
    const wantsRollback = sloTargets.mitigation.includes("rollback");
    sloSink = buildSloSink({
      audit: sloAudit,
      ...(wantsAlert
        ? {
            alert: async (event): Promise<void> => {
              const payload = { ...event.breach, sessionId: event.sessionId, rung: event.rung };
              if (alertHooks.length > 0) {
                await runHooks("alert", payload, alertHooks, { matcherKey: "metric" });
              }
              if (webhookUrl !== undefined) {
                try {
                  await fetch(webhookUrl, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(payload),
                  });
                } catch (err) {
                  process.stderr.write(
                    `[slo] alert webhook failed: ${err instanceof Error ? err.message : String(err)}\n`,
                  );
                }
              }
            },
          }
        : {}),
      ...(wantsPause
        ? {
            pauseIntake: async (paused, reason): Promise<void> => {
              const gatePath = join(cwd, ".crewhaus", "slo", "intake.json");
              mkdirSync(dirname(gatePath), { recursive: true });
              writeFileSync(
                gatePath,
                `${JSON.stringify(intakeGatePayload(paused, reason), null, 2)}\n`,
              );
              process.stderr.write(
                `[slo] intake ${paused ? "PAUSED" : "resumed"} → ${gatePath} (${reason})\n`,
              );
            },
          }
        : {}),
      ...(wantsRollback
        ? {
            rollback: async (event): Promise<void> => {
              // Auto-rollback the "prod" env pin to the prior version via the
              // deployment-controller. Requires a cwd spec-registry; degrades to
              // an audited no-op (a warning) when none exists.
              const specRootDir = join(cwd, ".crewhaus", "spec-registry");
              if (!existsSync(specRootDir)) {
                process.stderr.write(
                  "[slo] rollback requested but no .crewhaus/spec-registry — skipping (alert/pause-intake still applied)\n",
                );
                return;
              }
              const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
              const { createDeploymentController } = await import(
                "@crewhaus/deployment-controller"
              );
              const registry = createFileBackedRegistry({ rootDir: specRootDir });
              const current = await registry.aliasFor(ir.name, "prod");
              // LAST-KNOWN-GOOD, not a lexicographic guess: the version that was
              // pinned to prod immediately BEFORE `current`, read from the
              // deployment-controller's `deployment_action` audit history. A
              // lexicographic sort would pick e.g. v2 out of [v1,v2,v9,v10] as
              // "the last non-current version" and roll production back to an
              // arbitrary/ancient release. Never guess when flipping a prod pin.
              const prior = lastKnownGoodFromAuditRecords(
                readAuditRecords(),
                ir.name,
                "prod",
                current,
              );
              if (prior === undefined) {
                process.stderr.write(
                  "[slo] rollback: no recorded last-known-good predecessor in deployment_action history — skipping (refusing to guess a prod pin; alert/pause-intake still applied)\n",
                );
                return;
              }
              // Guard: the predecessor must still exist in the registry (a
              // deleted version can't be re-pinned; the controller would throw).
              const versions = await registry.list(ir.name);
              if (!versions.includes(prior)) {
                process.stderr.write(
                  `[slo] rollback: last-known-good ${prior} no longer in registry — skipping\n`,
                );
                return;
              }
              const controller = createDeploymentController({
                registry,
                auditLog: sloAudit,
                actor: "slo-monitor",
              });
              await controller.rollback(ir.name, "prod", prior);
              process.stderr.write(
                `[slo] auto-rolled-back ${ir.name} prod → ${prior} (last-known-good; SLO breach: ${event.breach.detail})\n`,
              );
            },
          }
        : {}),
    });
  }

  // Item #56 — resolve the current user's preference file (flag > env) so the
  // runtime injects `.crewhaus/preferences/<user>.md` at run start. Absent when
  // no user is identified or the file doesn't exist yet.
  const preferenceFiles: string[] = [];
  const userId = strFlag(args, "user") ?? process.env["CREWHAUS_USER"];
  if (typeof userId === "string" && userId.trim() !== "") {
    const prefsFile = join(process.cwd(), PREFERENCES_SUBDIR, preferenceFileName(userId));
    if (existsSync(prefsFile)) {
      preferenceFiles.push(prefsFile);
      process.stdout.write(`[memory] injecting preferences for user "${userId}"\n`);
    }
  }

  // Section 13 — when the IR carries inline sub-agent definitions, build the
  // registry, register the Task tool, and inject `spawnSubAgent` so the
  // runtime can populate the bridge for framework-aware tools.
  let subAgents: ReadonlyMap<string, SubAgentDefinition> | undefined;
  if (ir.subAgents.length > 0) {
    // 0.6.0 §7.7 — the ONE IR → runtime mapping (routing quartet, params,
    // budget_share, inherit_routing, allowed_profiles ride along), in parity
    // with the emitted `__subAgents` literal.
    subAgents = new Map(ir.subAgents.map((d) => [d.name, subAgentDefinitionFromIr(d)]));
    tools.push(createTaskTool({ subAgents }));
    process.stdout.write(
      `[sub-agents] ${subAgents.size} available: ${[...subAgents.keys()].join(", ")}\n`,
    );
  }

  // Item 3 (G32) — register the activated plugins' tools LAST so a plugin tool
  // named after a built-in / skill / memory / MCP / sub-agent tool is skipped
  // (first-party wins the collision), mirroring the compiled bundle's
  // register-late boot.
  for (const t of pluginTools) {
    if (tools.some((existing) => existing.name === t.name)) {
      process.stdout.write(
        `[plugins] tool "${t.name}" already registered — plugin contribution skipped\n`,
      );
      continue;
    }
    tools.push(t);
  }

  // Section 18 — wire the sandbox floor for code-execution tools. #18 made
  // python/javascript/shell RESOLVABLE at run time, but the run path never set
  // `sandboxAvailable`, so permission-engine's `requiresSandbox` floor denied
  // every code-exec call even with a real backend. Mirror the compiled
  // bundle (target-cli renderRun): resolve availability from CREWHAUS_SANDBOX
  // and thread it into runChatLoop. Only relevant when the spec declares a
  // code-exec tool; emit a one-line diagnostic so the state is observable.
  const hasCodeExecTools = ir.tools.some(
    (t) => t === "python" || t === "javascript" || t === "shell",
  );
  const sandboxAvailable = resolveSandboxAvailable();
  if (hasCodeExecTools) {
    if (!sandboxAvailable) {
      process.stdout.write(
        "[sandbox] disabled (CREWHAUS_SANDBOX=noop) — python/javascript/shell calls will be denied by the sandbox floor\n",
      );
    } else if (process.env["CREWHAUS_SANDBOX"] === undefined) {
      process.stdout.write(
        "[sandbox] assuming docker — set CREWHAUS_SANDBOX (docker|podman) to select a backend, or CREWHAUS_SANDBOX=noop to disable code execution\n",
      );
    } else {
      process.stdout.write(
        `[sandbox] backend "${process.env["CREWHAUS_SANDBOX"]}" — python/javascript/shell enabled (still require an alwaysAllow rule)\n`,
      );
    }
  }

  let oneShotResult: string | undefined;
  // v0.3.0 Goal 6 — a RunFailedError is remembered (not rethrown) so the
  // finally still disconnects MCP servers, then rendered below with the
  // resume hint + the report's coded exit. Everything else propagates to
  // the `case "run"` catch → die() one-liner, exactly as before.
  let runFailure: RunFailedError | undefined;
  try {
    oneShotResult = await runChatLoop({
      model,
      instructions:
        mcpQuarantineNotice !== undefined
          ? `${ir.agent.instructions}\n\n${mcpQuarantineNotice}`
          : ir.agent.instructions,
      tools,
      permissionMode,
      permissionRules,
      // G11 — honours `permissions.ask_mode` / `--ask-mode`. Inert on the
      // REPL shape (runtime-core prefers its stdin prompter); load-bearing
      // under `--prompt`, where an `ask` used to deny in place.
      ...approvalRunOptions(args, ir.permissions),
      sessionName: ir.name,
      sessionTarget: ir.target,
      hooks,
      skills,
      slashCommands,
      // `--prompt` → run exactly one turn from the seeded prompt and return
      // its final message (no interactive REPL). runChatLoop's singleTurn
      // mode also suppresses the `you>` / `agent ready` chrome.
      ...(oneShotPrompt !== undefined
        ? { singleTurn: true, seedMessages: [{ role: "user" as const, content: oneShotPrompt }] }
        : {}),
      ...(hasCodeExecTools ? { sandboxAvailable } : {}),
      // Item 1 — the spec's `feedback:` block. The exit rating prompt lives in
      // the RUNTIME (so a compiled bundle gets it too, not just this path);
      // only the two switches it consumes are threaded. The autoDistill
      // consumer stays in this file's teardown — it registers a versioned
      // registry dataset for `eval`/`optimize`, a toolchain step.
      ...(ir.feedback !== undefined
        ? {
            feedback: {
              ...(ir.feedback.enabled !== undefined ? { enabled: ir.feedback.enabled } : {}),
              ...(ir.feedback.exitPrompt !== undefined
                ? { exitPrompt: ir.feedback.exitPrompt }
                : {}),
            },
          }
        : {}),
      ...(subAgents !== undefined ? { subAgents, spawnSubAgent } : {}),
      ...(ir.target === "cli" && ir.agent.maxTokens !== undefined
        ? { maxTokens: ir.agent.maxTokens }
        : {}),
      // Thread `compaction.model` so auto-compaction summarizes on the
      // spec's chosen (typically cheaper) model instead of the primary.
      // The compiler already resolves the `cheapest` sentinel to a concrete
      // id, so this is a raw model string. Mirrors the target-cli emitter.
      ...(ir.target === "cli" && ir.compaction.model !== undefined
        ? { compactionModel: ir.compaction.model }
        : {}),
      // Loop contract 0.4 (Batch A) — limits ceilings (incl. loop_detection),
      // agent.thinking, agent.rate_limits, and the compaction tuning knobs
      // (threshold / snip_keep_head / snip_keep_tail → compactionThreshold /
      // snipKeepHead / snipKeepTail), mirrored 1:1 from the target-cli
      // codegen (see loop-contract.ts for the option-name contract).
      ...loopContractRunOptions(ir),
      // Loop contract 0.4 (Batch A) — streaming tool dispatch
      // (--streaming flag > spec agent.streaming > absent).
      ...(streaming !== undefined ? { streaming } : {}),
      // Item 22 / item 26 / adaptive model routing — the primary agent's
      // routing quartet (`model_fallbacks` + `circuit_breaker`, `model_tiers`,
      // `model_pool`) through the 0.6.0 composition root
      // (`@crewhaus/model-service`'s `wireModels`, plan §2 stance 4) — the
      // SAME call the compiled cli bundle's rendered fields evaluate to, so
      // `crewhaus run` routes (and learns) exactly like the bundle. A `--model`
      // override is an explicit routing decision authored against a different
      // primary, so it drops the chain, tiers and pool (the breaker stays).
      ...modelRoutingRunOptions(ir.agent, modelOverride, { sessionName: ir.name }),
      // 0.6.0 PR 8b (wave-1 carry-over) — the in-loop `evaluation:` block,
      // built from the resolved IR exactly as the compiled cli bundle's
      // `renderEvaluation` does (llm_judge on the run bus with role "judge",
      // contains / regex pure), so `crewhaus run` grades, retries, halts and
      // meters judge spend like the bundle. Absent block → spreads nothing.
      ...evaluationRunOptions(ir),
      // Section 55 / item 23 — thread the spec's failure_taxonomy so
      // recovery-engine consults the user's named error classes (including
      // the `switch-model` verdict) before its built-in flow.
      ...(ir.failureTaxonomy !== undefined && ir.failureTaxonomy.length > 0
        ? { failureTaxonomy: ir.failureTaxonomy }
        : {}),
      // Item 27 — run-level spend cap (--budget-usd flag > spec `budget`).
      ...(runBudget !== undefined ? { budget: runBudget } : {}),
      ...(resumeId !== undefined ? { resume: { sessionId: resumeId } } : {}),
      ...(justificationJudge !== undefined ? { justificationJudge } : {}),
      ...(justificationAuditSink !== undefined ? { justificationAuditSink } : {}),
      ...(egressAuditSink !== undefined ? { egressAuditSink } : {}),
      ...(egressMatcher !== undefined ? { egressMatcher } : {}),
      ...(alertSink !== undefined ? { alertSink } : {}),
      // Item 37 — SLO monitor targets + injected mitigation ladder (gated by
      // CREWHAUS_SLO inside runtime-core).
      ...(sloTargets !== undefined ? { sloTargets } : {}),
      ...(sloSink !== undefined ? { sloSink } : {}),
      // Item 32 — stamp the spec name into any auto-assembled incident capture
      // (gated by CREWHAUS_INCIDENTS inside runtime-core).
      incidentSpec: { name: ir.name },
      ...(memoryRunOpt !== undefined ? { memory: memoryRunOpt } : {}),
      // v0.3.0 Goal 1 — the continuity seam (plan tail + requirements ledger
      // + teardown handoff), default-on unless the spec said
      // `continuity: false`.
      ...(continuityRunOpt !== undefined ? { continuity: continuityRunOpt } : {}),
      // Item #56 — inject the current user's preference file at run start (via
      // the project-memory auto-load path). LESSONS.md is auto-loaded already
      // as a canonical memory file, so no extra wiring is needed for it.
      ...(preferenceFiles.length > 0 ? { preferenceFiles } : {}),
    });
  } catch (err) {
    if (!(err instanceof RunFailedError)) throw err;
    runFailure = err;
  } finally {
    if (mcpHost) await mcpHost.disconnectAll();
  }

  // v0.3.0 Goal 6 — render the classified terminal report (billing/auth/
  // rate-limit/…) with the resume hint when this spec has a persisted
  // session, then exit with the report's coded status. The design §8.2
  // out-of-funding example ends exactly like this.
  if (runFailure !== undefined) {
    const notes: string[] = [];
    try {
      const store = openRunSessionStore();
      const sessions = await store.list();
      if (sessions.some((s: { name: string }) => s.name === ir.name)) {
        notes.push(CONTINUE_NOTE);
      }
    } catch {
      // Best-effort: the resume hint must never mask the real failure.
    }
    const rendered = renderCliFailure(runFailure, { notes });
    process.stderr.write(`${rendered.text}\n`);
    process.exit(rendered.exitCode);
  }

  // One-shot (`--prompt`): emit the final assistant message to stdout so it
  // can be piped/captured. The REPL path streams as it goes and returns the
  // same trailing text, so only print it in one-shot mode.
  if (oneShotPrompt !== undefined && oneShotResult !== undefined) {
    process.stdout.write(`${oneShotResult}\n`);
  }

  // Item 1 — post-session feedback teardown: the feedback.autoDistill
  // consumer. Runs only on a clean REPL exit (runChatLoop returned; a throw
  // above skips it) and is best-effort — a teardown failure never turns a
  // successful session into a non-zero exit. Deliberately CLI teardown code
  // (the in-process analogue of where the stop hook fires), NOT a spawned
  // hook: hooks run credential-stripped, and the distill/registry path needs
  // the caller's full environment. (The exit rating prompt already fired
  // INSIDE runChatLoop — the runtime owns it so compiled bundles have it too.)
  try {
    await runFeedbackTeardown(ir);
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
  // FR-004 / item 20 — same shared durable audit sink as the cli path, so a
  // justification-gated browser tool writes `permission_justification_evaluated`
  // and a non-pass egress verdict writes `egress_decision`.
  const securityAuditSink = await openSecurityAuditSink({
    cwd: process.cwd(),
    enabled: args.flags["no-justification-audit"] !== true,
  });
  const justificationAuditSink = securityAuditSink;
  const egressAuditSink = asEgressAuditSink(securityAuditSink);

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

  // SECURITY — `driver.allowPrivateTargets` relaxes BOTH SSRF layers together:
  // the chromium backend's DNS-pinning proxy here, and the Navigate tool's
  // pre-goto guard below. Relaxing one alone is worse than relaxing neither —
  // with only the guard waived the proxy still answers loopback with its own
  // 403 body, which RENDERS, so the agent screenshots a block page and reports
  // whatever it can make of it rather than failing cleanly.
  const allowPrivateTargets = ir.driver.allowPrivateTargets === true;
  const driver = createDriver({
    backend: ir.driver.backend,
    viewport: ir.driver.viewport,
    ...(allowPrivateTargets ? { ssrfProxy: false } : {}),
  });

  emitEvent({ kind: "browser_start", backend: ir.driver.backend });
  await driver.connect();
  try {
    if (ir.driver.startUrl !== undefined) {
      await driver.goto(ir.driver.startUrl);
      emitEvent({ kind: "navigated", url: ir.driver.startUrl });
    }

    const navigateTool = navigate.createNavigateTool({
      driver,
      ...(allowPrivateTargets ? { allowPrivateTargets: true } : {}),
    });
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
      // G11 — always load-bearing here: this shape is non-interactive by
      // construction (it rejects a TTY with no --prompt).
      ...approvalRunOptions(args, ir.permissions),
      sessionName: ir.name,
      sessionTarget: "browser",
      singleTurn: true,
      seedMessages: [{ role: "user", content: prompt }],
      ...(justificationJudge !== undefined ? { justificationJudge } : {}),
      ...(justificationAuditSink !== undefined ? { justificationAuditSink } : {}),
      ...(egressAuditSink !== undefined ? { egressAuditSink } : {}),
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

/**
 * Loop contract 0.4 (Batch C, item 4) — read-only render of this project's
 * agent identity fingerprint for `crewhaus doctor`. Reads
 * `.crewhaus/identity.json` (the Ed25519 keypair minted on a run's first boot)
 * and returns the `agentId` line; deliberately never mints one — doctor must
 * not write during a read-only probe (a run mints it). An absent file is
 * informational; a corrupt file is flagged.
 */
function describeAgentIdentityLine(cwd: string): string {
  const path = join(cwd, ".crewhaus", "identity.json");
  if (!existsSync(path)) {
    return "~ agent identity: not yet minted (created on first `crewhaus run`)";
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentIdentityFile>;
    if (typeof parsed.agentId === "string" && parsed.agentId.length > 0) {
      const algo = typeof parsed.algorithm === "string" ? parsed.algorithm : "ed25519";
      return `✓ agent identity: ${parsed.agentId} (${algo}; stamped on every trace + audit record)`;
    }
  } catch {
    // fall through to the corrupt-file note
  }
  return `✗ agent identity: ${path} is unreadable or malformed (delete it to re-mint on next run)`;
}

/**
 * Loop contract 0.4 (Batch F, item 2) — compile a spec IN MEMORY and emit it to
 * a fresh temp dir, returning that dir (the child's cwd) + the target shape, or
 * a structured error (a broken edit). No README, no registry side effects — a
 * throwaway build for the dev child.
 */
function devCompileAndEmit(
  absSpec: string,
  pluginsOverride?: readonly string[],
):
  | { readonly ok: true; readonly cwd: string; readonly target: string; readonly specName: string }
  | { readonly ok: false; readonly error: string } {
  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    return { ok: false, error: `read failed: ${(err as Error).message}` };
  }
  // Item 3 (G32) — `dev --plugins` overrides the spec's `plugins:` list for the
  // launched child. The compiled bundle activates `ir.plugins` at boot (there
  // is no runtime override), so rewrite the key in the YAML doc before compile;
  // an empty override serializes `plugins: []`, which lowers to "activate none".
  if (pluginsOverride !== undefined) {
    try {
      const doc = parseDocument(yamlText);
      doc.set("plugins", [...pluginsOverride]);
      yamlText = doc.toString();
    } catch (err) {
      return { ok: false, error: `--plugins override failed: ${(err as Error).message}` };
    }
  }
  let bundle: ReturnType<typeof compile>;
  let target: string;
  let specName: string;
  try {
    bundle = compile(yamlText, { readme: false });
    const devIr = lower(parseSpec(yamlText));
    target = devIr.target;
    specName = devIr.name;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof CrewhausError ? err.message : (err as Error).message,
    };
  }
  const cwd = mkdtempSync(join(tmpdir(), "crewhaus-dev-"));
  for (const file of bundle.files) {
    const full = join(cwd, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
  }
  return { ok: true, cwd, target, specName };
}

/**
 * The env a dev child boots with: the parent env plus `CREWHAUS_TRACE=pretty`
 * (item 2) when the user has not set it, so each turn streams as a pretty trace
 * — the live per-turn view — out of the box.
 */
function devChildEnv(): Record<string, string | undefined> {
  return { ...process.env, CREWHAUS_TRACE: process.env["CREWHAUS_TRACE"] ?? "pretty" };
}

/**
 * Forward a child stream to `out` byte-for-byte (no latency) AND surface each
 * COMPLETE line to `onLine` (for turn scanning). A trailing partial line is
 * flushed when the stream ends.
 */
async function devForwardAndScan(
  stream: ReadableStream<Uint8Array>,
  out: NodeJS.WriteStream,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  // Bun's ReadableStream is async-iterable.
  for await (const chunk of stream) {
    out.write(chunk as Uint8Array);
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) onLine(buffer);
}

/**
 * Loop contract 0.4 (Batch F, item 2) — `crewhaus dev <spec> [--once]
 * [--debounce <ms>]`.
 *
 * Compiles the spec in memory, emits it to a temp dir, and runs the bundle's
 * entrypoint (`agent.ts` / `daemon.ts` per shape) as a SUPERVISED child with
 * `CREWHAUS_TRACE=pretty` on by default. Every change to the spec (or the
 * sibling `.crewhaus/commands` / `skills` dirs) recompiles in memory and — on a
 * clean build — relaunches the child; a broken edit keeps the running child and
 * prints the error. A daemon-shape crash restarts (bounded). Each completed
 * turn prints a `[dev]` summary line. Ctrl-C tears the child down. `--once`
 * runs one launch to completion (the scriptable boot check) and exits with the
 * child's code.
 */
async function runDev(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] === true) {
    process.stdout.write(
      "usage: crewhaus dev <spec.yaml> [--once] [--debounce <ms>] [--plugins <a,b>]\n" +
        "  Compiles the spec in memory, runs the emitted bundle as a supervised\n" +
        "  child (CREWHAUS_TRACE=pretty by default — turns stream live), and\n" +
        "  recompiles + relaunches it on every spec / .crewhaus/commands / skills\n" +
        "  change. A broken edit keeps the running child; a crashed daemon shape\n" +
        "  restarts (bounded). Each completed turn prints a [dev] summary. Ctrl-C\n" +
        "  stops. --once launches one run to completion and exits with its code\n" +
        "  (a credential-free boot check for CI). --debounce sets the change-\n" +
        "  coalescing window in ms (default 150). --plugins <a,b,c> overrides the\n" +
        '  spec\'s plugins: list compiled into the child (--plugins "" activates none).\n',
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  const absSpec = resolve(specPath);

  // Item 3 (G32) — a present `--plugins` overrides the spec's `plugins:` list in
  // every compile of the child (initial + each recompile); absent → the spec's
  // list compiles unchanged, keeping the emitted bundle byte-identical.
  const pluginsFlag = strFlag(args, "plugins");
  const pluginsOverride = pluginsFlag !== undefined ? parsePluginsFlag(pluginsFlag) : undefined;

  // Initial in-memory compile + emit. A broken spec fails fast here (exit 1);
  // nothing is launched.
  const initial = devCompileAndEmit(absSpec, pluginsOverride);
  if (!initial.ok) die(`dev: ${initial.error}`);
  // Hangar F-1 — the spec compiled, so it resolved: self-register the spec
  // file's own directory (dev's watch root — NOT the invoker's cwd, which
  // may be elsewhere, and not the throwaway temp dir the child runs in).
  // Never throws; CREWHAUS_NO_REGISTRY=1 opts out.
  registerHarnessCwd({
    dir: dirname(absSpec),
    specName: initial.specName,
    target: initial.target,
    originDetail: "dev",
  });
  const target = initial.target;
  const entry = devEntrypointFor(target);
  const childEnv = devChildEnv();

  // The real spawn seam: run `bun <entry>` in the emitted dir, forwarding stdio
  // and surfacing complete output lines for turn scanning.
  const spawnChild = (opts: {
    readonly entry: string;
    readonly cwd: string;
    readonly onLine: (line: string) => void;
    readonly onExit: (code: number | null) => void;
  }): DevChildHandle => {
    const proc = Bun.spawn(["bun", opts.entry], {
      cwd: opts.cwd,
      env: childEnv,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Forward + scan both streams (detached — they resolve when the child's
    // streams close). Best-effort: a forwarding error must not crash the dev
    // loop, so swallow it (the exit code is the source of truth).
    void devForwardAndScan(proc.stdout, process.stdout, opts.onLine).catch(() => {});
    void devForwardAndScan(proc.stderr, process.stderr, opts.onLine).catch(() => {});
    void proc.exited.then((code) => opts.onExit(code));
    return {
      pid: proc.pid,
      kill: () => {
        try {
          proc.kill();
        } catch {
          // Already gone.
        }
      },
    };
  };

  // --once: launch one run to completion (stdio inherited) and exit with its
  // code — no watch loop, no scanning. The CI/boot-check path.
  if (args.flags["once"] === true) {
    process.stderr.write(`[dev] launching ${entry} once (${target}) in ${initial.cwd}\n`);
    const proc = Bun.spawn(["bun", entry], {
      cwd: initial.cwd,
      env: childEnv,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    process.stderr.write(`[dev] child exited (code ${code})\n`);
    process.exit(code);
  }

  // Watch the spec + the sibling authoring dirs, mirroring `compile --watch`.
  const specDir = dirname(absSpec);
  const watchPaths = [absSpec, join(specDir, ".crewhaus", "commands"), join(specDir, "skills")];
  const { watch } = await import("node:fs");
  const handles: Array<{ close(): void }> = [];
  const subscribers: Array<() => void> = [];
  const watcher: Watcher = {
    subscribe: (cb) => subscribers.push(cb),
    close: () => {
      for (const h of handles) {
        try {
          h.close();
        } catch {
          // A path that vanished mid-watch closes with an error; ignore.
        }
      }
    },
  };
  for (const p of watchPaths) {
    if (!existsSync(p)) continue;
    try {
      handles.push(
        watch(p, { recursive: true }, () => {
          for (const cb of subscribers) cb();
        }),
      );
    } catch {
      // Non-fatal: an unwatchable path just isn't watched.
    }
  }

  const debounceMs = intFlag(args, "debounce") ?? 150;
  process.stderr.write(
    `[dev] watching ${basename(absSpec)} (+ .crewhaus/commands, skills) — Ctrl-C to stop\n`,
  );
  const supervisor = createDevSupervisor({
    entry,
    isDaemon: isDevDaemonTarget(target),
    initialCwd: initial.cwd,
    spawn: spawnChild,
    recompile: () => devCompileAndEmit(absSpec, pluginsOverride),
    watcher,
    timer: {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    debounceMs,
    print: (line) => process.stderr.write(`${line}\n`),
  });

  await new Promise<void>((resolveDev) => {
    const onSigint = (): void => {
      supervisor.stop();
      process.off("SIGINT", onSigint);
      process.stderr.write("\n[dev] stopped.\n");
      resolveDev();
    };
    process.on("SIGINT", onSigint);
  });
}

/**
 * Item 4 (§59) — `crewhaus export claude-plugin <spec> [--out <dir>]`. Emits an
 * Anthropic-compatible Claude Code plugin directory from any target shape via
 * the pure `emitClaudePlugin`, SMOKE-TESTS the projection (the required
 * plugin.json + any .mcp.json parse and carry their keys) BEFORE writing, then
 * writes the files under the chosen out dir. Structured failures
 * (SpecParseError / TargetClaudePluginError) route through die() upstream.
 */
async function runExportClaudePlugin(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] === true) {
    process.stdout.write(
      "usage: crewhaus export claude-plugin <spec.yaml> [--out <dir>] [--force]\n" +
        "                       [--author <name>] [--author-email <email>] [--description <text>]\n" +
        "                       [--no-assets]\n" +
        "  Emits an Anthropic-compatible Claude Code plugin directory from the spec:\n" +
        "  .claude-plugin/plugin.json, README.md, skills/<name>/SKILL.md, one\n" +
        "  agents/<name>.md per sub-agent, and .mcp.json when the spec declares\n" +
        "  mcp_servers. The harness's authored assets travel too — the spec dir's\n" +
        "  .crewhaus/skills/<name>/** become skills/<name>/**, and its\n" +
        "  .crewhaus/commands/<name>.md become commands/<name>.md; pass --no-assets\n" +
        "  to emit the spec projection alone. Drop the emitted dir under\n" +
        "  ~/.claude/plugins/ (or a project .claude/plugins/) to load the agent's\n" +
        "  skills inside Claude Code. Default output dir is ./<plugin-name>; --force\n" +
        "  overwrites a non-empty dir. The emitted plugin.json / .mcp.json are\n" +
        "  smoke-checked before anything is written.\n",
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
    if (err instanceof SpecParseError) die(err.message);
    throw err;
  }

  // Item 14 — carry the harness's AUTHORED surface (`.crewhaus/skills/**`,
  // `.crewhaus/commands/*.md`, resolved beside the spec — the standalone-harness
  // convention) into the plugin, so the export is not a strictly smaller agent
  // than the harness. A malformed authored SKILL.md fails the export rather than
  // shipping a plugin Claude Code would refuse to load.
  const assets =
    args.flags["no-assets"] === true
      ? { files: [], skipped: [], issues: [] }
      : collectHarnessPluginAssets(dirname(absSpec));
  if (assets.issues.length > 0) {
    die(
      `export claude-plugin: unusable authored asset(s):\n  - ${assets.issues.join("\n  - ")}\n  fix the file, or pass --no-assets to export the spec projection alone`,
    );
  }
  for (const path of assets.skipped) {
    process.stderr.write(`[export] skipped non-text authored asset ${path}\n`);
  }

  const descriptionFlag = strFlag(args, "description");
  const bundle = emitClaudePlugin(ir, {
    author: resolveClaudePluginAuthor(strFlag(args, "author"), strFlag(args, "author-email")),
    ...(descriptionFlag !== undefined && descriptionFlag.trim() !== ""
      ? { description: descriptionFlag.trim() }
      : {}),
    ...(assets.files.length > 0 ? { assets: assets.files } : {}),
  });

  // Smoke-test the projection BEFORE writing — a malformed plugin.json /
  // .mcp.json fails loudly instead of leaving a broken plugin dir on disk. The
  // target-claude-plugin package tests content shape; this asserts the emitted
  // DIRECTORY is loadable (the required files parse + carry their keys).
  const issues = smokeCheckClaudePluginBundle(bundle.files);
  if (issues.length > 0) {
    die(
      `export claude-plugin: emitted bundle failed the smoke check:\n  - ${issues.join("\n  - ")}`,
    );
  }

  const outDir = resolveExportOutDir(strFlag(args, "out"), process.cwd(), ir.name);
  if (existsSync(outDir) && readdirSync(outDir).length > 0 && args.flags["force"] !== true) {
    die(`refusing to overwrite non-empty ${outDir} — pass --force to overwrite`);
  }
  mkdirSync(outDir, { recursive: true });
  for (const file of bundle.files) {
    const full = join(outDir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
  }
  const hasMcp = bundle.files.some((f) => f.path === ".mcp.json");
  // Item 14 — name what the harness contributed, so a silent "the authored
  // skills didn't travel" regression is visible on the one line the user reads.
  const carriedSkills = new Set(
    assets.files.flatMap((f) => f.path.match(/^skills\/([^/]+)\//)?.[1] ?? []),
  ).size;
  const carriedCommands = assets.files.filter((f) => f.path.startsWith("commands/")).length;
  const carriedParts = [
    ...(carriedSkills > 0
      ? [`${carriedSkills} authored skill${carriedSkills === 1 ? "" : "s"}`]
      : []),
    ...(carriedCommands > 0
      ? [`${carriedCommands} authored command${carriedCommands === 1 ? "" : "s"}`]
      : []),
  ];
  const carried = carriedParts.length > 0 ? `, incl. ${carriedParts.join(" + ")}` : "";
  process.stdout.write(
    `exported ${ir.name} (${ir.target}) → ${outDir} — ${bundle.files.length} files${hasMcp ? ", incl. .mcp.json" : ""}${carried}, smoke check ✓\n`,
  );
}

/**
 * Item 1 (G30) — `crewhaus serve --mcp <spec> [--sse]`. Compiles the spec in
 * memory, builds the projected agent's `invoke` from the SAME interpreter turn
 * function `crewhaus run` drives (see {@link buildServeRuntime}), and binds it
 * to the requested transport via `@crewhaus/mcp-server` so the agent becomes a
 * tool inside Claude Code / an IDE / another CrewHaus runtime.
 *
 * The transport/tools-mode resolve from the spec's `expose.mcp` block and the
 * `--sse`/`--port` flags (`./serve-mcp`). stdio OWNS stdout (the JSON-RPC
 * channel), so for stdio every other stdout write — the agent's own
 * diagnostics AND runtime-core status lines — is redirected to stderr for the
 * whole serve and the transport is handed a PRIVATE writable bound to the
 * original stdout; a `[memory]`/`[mcp]` notice can never corrupt the protocol.
 */
async function runServeMcp(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] === true) {
    process.stdout.write(SERVE_MCP_USAGE);
    return;
  }
  if (args.flags["mcp"] !== true) {
    die(
      "crewhaus serve requires --mcp (the only projection kind today) — see `crewhaus serve --help`",
    );
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  // Before any MCP server is connected — `die()` is a process.exit and would
  // skip the daemon's cleanup path.
  assertValidAskModeFlag(args);
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
  assertServeTargetSupported(ir.target);
  const cliIr = ir as Extract<ReturnType<typeof lower>, { target: "cli" }>;

  const expose = cliIr.expose?.mcp;
  const transport = resolveMcpTransport(args.flags["sse"] === true, expose?.transport);
  const toolsMode = resolveMcpToolsMode(expose?.tools);
  assertToolsModeSatisfiable(toolsMode, cliIr.subAgents.length);
  const port =
    transport === "sse"
      ? resolveServePort(strFlag(args, "port"), process.env["CREWHAUS_MCP_PORT"])
      : SERVE_MCP_DEFAULT_PORT;

  // stdio → keep the agent's stdout off the JSON-RPC channel (see the docblock).
  let protocolStdout: Writable | undefined;
  let restoreStdout: (() => void) | undefined;
  if (transport === "stdio") {
    const originalWrite = process.stdout.write;
    const boundOriginal = originalWrite.bind(process.stdout);
    protocolStdout = new Writable({
      write(chunk, _enc, cb): void {
        boundOriginal(chunk as string | Uint8Array);
        cb();
      },
    });
    (process.stdout as { write: typeof process.stdout.write }).write = ((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) =>
      (process.stderr.write as (c: string | Uint8Array, ...a: unknown[]) => boolean)(
        chunk,
        ...rest,
      )) as typeof process.stdout.write;
    restoreStdout = () => {
      (process.stdout as { write: typeof process.stdout.write }).write = originalWrite;
    };
  }

  const runtime = await buildServeRuntime(args, cliIr);
  const version = cliVersion();
  const handle = createMcpServer({
    invoke: runtime.invoke,
    transport,
    tools: toolsMode,
    ...(toolsMode === "per-subagent"
      ? { subAgents: buildMcpSubAgentDescriptors(cliIr.subAgents) }
      : {}),
    name: cliIr.name,
    ...(version !== undefined ? { version } : {}),
    instructions: `Calls the "${cliIr.name}" CrewHaus agent. Each tool call runs one agent turn and returns its final reply.`,
    chatToolDescription: `Send a message to the "${cliIr.name}" agent and get its reply.`,
  });

  let sseServer: ReturnType<typeof Bun.serve> | undefined;
  if (handle.transport === "stdio") {
    await handle.listen(protocolStdout !== undefined ? { stdout: protocolStdout } : undefined);
    process.stdout.write(
      `[serve] MCP stdio server for "${cliIr.name}" ready (tools: ${toolsMode}) — add it to your MCP client's config\n`,
    );
  } else {
    sseServer = Bun.serve({ port, fetch: (req) => handle.fetch(req) });
    process.stdout.write(
      `[serve] MCP SSE server for "${cliIr.name}" on http://localhost:${port} (tools: ${toolsMode}) — POST MCP requests to /\n`,
    );
  }

  const shutdown = async (): Promise<void> => {
    await handle.close().catch(() => {});
    if (sseServer !== undefined) sseServer.stop();
    await runtime.cleanup();
    protocolStdout?.end();
    restoreStdout?.();
  };

  // The transport (stdio reader / Bun.serve) keeps the loop alive; SIGINT — or,
  // for stdio, the parent closing our stdin — tears everything down and exits.
  await new Promise<void>((resolveServe) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      void shutdown().then(() => {
        process.stderr.write("\n[serve] stopped.\n");
        resolveServe();
      });
    };
    process.on("SIGINT", finish);
    if (handle.transport === "stdio") {
      process.stdin.once("end", finish);
      process.stdin.once("close", finish);
    }
  });
}

/**
 * Item 1 (G30) — build the projected agent's `invoke` (+ a `cleanup`) from the
 * SAME interpreter wiring `crewhaus run` uses (`runRunCli`): resolve the model,
 * load the built-in / knowledge / memory / sub-agent / plugin / MCP tools,
 * compile the permission rules, and assemble the `runChatLoop` options. Each
 * MCP tool call runs ONE turn (`singleTurn`) from the caller's message and
 * resolves with the final assistant text. Turns are serialized — one agent
 * instance, one turn at a time (which also keeps the stdio stdout redirect
 * single-flight safe).
 *
 * Under `tools: "per-subagent"` a call carrying `context.subAgent` runs THAT
 * sub-agent's turn instead: its own instructions + model and its `tools:`
 * allowlist (a v0 simplification — the parent permission rules still apply; the
 * sub-agent's `permissions:` scoping is not yet remapped here, see the batch-G
 * CLI report).
 *
 * Deliberately a FOCUSED mirror of `runRunCli` (like `runRunBrowser`): the
 * REPL-only surfaces — session store / resume, the exit-rating teardown, the
 * alert & SLO sinks, incident capture, the budget cap, the MCP quarantine
 * notice — are omitted; a served projection is stateless per call. Keep the
 * tool / permission / model wiring in step with `runRunCli` when either moves.
 */
async function buildServeRuntime(
  args: ParsedArgs,
  ir: Extract<ReturnType<typeof lower>, { target: "cli" }>,
): Promise<{ invoke: McpInvoke; cleanup: () => Promise<void> }> {
  // Built-in tools (Section 14 per-tool config applied first).
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

  // Item 3 (G32) — activate plugins EARLY so their skill dirs feed discovery;
  // their tools register LATE (first-party wins a name collision), mirroring
  // the compiled bundle's split boot. Honours the spec `plugins:` + `--plugins`.
  const pluginNames = resolvePluginNames(ir.plugins, strFlag(args, "plugins"));
  let pluginSkillDirs: readonly string[] = [];
  let pluginTools: readonly RegisteredTool[] = [];
  if (pluginNames.length > 0) {
    const activated = await activatePlugins({
      names: pluginNames,
      ...createDefaultPluginRuntime({
        allowUnsigned: process.env["CREWHAUS_PLUGIN_ALLOW_UNSIGNED"] === "1",
      }),
    });
    pluginSkillDirs = activated.skillDirs;
    pluginTools = activated.tools;
    process.stdout.write(
      `[plugins] ${activated.loaded.length} activated: ${pluginNames.join(", ")}\n`,
    );
    for (const warning of activated.warnings) process.stdout.write(`[plugins] ${warning}\n`);
  }

  // MCP servers — connect + register remote tools (thredz through connectThredz,
  // degrade-on-failure). Mirror of runRunCli / the target-cli codegen.
  let mcpHost: McpHost | undefined;
  let thredzConn: ThredzConnection | null = null;
  const thredzWired = ir.thredz !== undefined && ir.mcp_servers["thredz"] !== undefined;
  if (Object.keys(ir.mcp_servers).length > 0) {
    const host = new McpHost({ logger });
    mcpHost = host;
    for (const [name, cfg] of Object.entries(ir.mcp_servers)) {
      // #406 — optional servers are NOT added here: their config resolution
      // + addServer run inside registerOptionalMcpServer's never-throw
      // boundary below.
      if (cfg.required === false && !(thredzWired && name === "thredz")) continue;
      host.addServer(name, resolveMcpServerConfig(cfg, { name }));
    }
    const tempCatalog = new ToolCatalog();
    for (const t of tools) tempCatalog.register(t);
    if (thredzWired) {
      thredzConn = await connectThredz(host, tempCatalog, {
        log: (line) => process.stdout.write(line),
        ...(ir.thredz?.agentName !== undefined ? { agentName: ir.thredz.agentName } : {}),
      });
    }
    // #406 — `required: false` servers degrade instead of failing the run;
    // the tool list freezes right below, so degrade-only (retry: false).
    await Promise.all(
      Object.entries(ir.mcp_servers)
        .filter(([name, cfg]) => !(thredzWired && name === "thredz") && cfg.required !== false)
        .map(([name]) =>
          registerMcpServer(host, name, tempCatalog, {
            onRegister: ({ fullName }) => process.stdout.write(`[mcp] registered ${fullName}\n`),
          }),
        ),
    );
    for (const [name, cfg] of Object.entries(ir.mcp_servers)) {
      if ((thredzWired && name === "thredz") || cfg.required !== false) continue;
      const { required: _requiredFlag, ...wireCfg } = cfg as typeof cfg & { required?: false };
      await registerOptionalMcpServer(host, name, tempCatalog, {
        retry: false,
        config: () => resolveMcpServerConfig(wireCfg, { name }),
        log: (line) => process.stdout.write(line),
        onRegister: ({ fullName }) => process.stdout.write(`[mcp] registered ${fullName}\n`),
      }).firstAttempt;
    }
    tools = tempCatalog.list().slice();
  }

  // Knowledge RAG — ingest sources + register the shared Retrieve tool.
  if (ir.knowledge !== undefined) {
    const retrieveTool = await ingestKnowledge(ir.knowledge, {
      cwd: process.cwd(),
      ...(ir.memory?.embedder !== undefined ? { memoryEmbedder: ir.memory.embedder } : {}),
      ...(ir.memory?.wiki?.embedder !== undefined ? { wikiEmbedder: ir.memory.wiki.embedder } : {}),
      log: (line) => process.stdout.write(line),
    });
    tools.push(retrieveTool);
  }

  const modelOverride = args.flags["model"];
  const model = typeof modelOverride === "string" ? modelOverride : ir.agent.model;
  const streaming = resolveStreaming(args.flags["streaming"] === true, ir.agent.streaming);

  const flagMode = args.flags["permission-mode"];
  let permissionMode: PermissionMode;
  if (typeof flagMode === "string") {
    if (!isValidPermissionMode(flagMode)) {
      die(
        `invalid --permission-mode "${flagMode}" — allowed: ${VALID_PERMISSION_MODES.join(", ")}`,
      );
    }
    permissionMode = flagMode;
  } else {
    permissionMode = ir.permissions.mode ?? "default";
  }
  const permissionRules = buildRuleSet(ir.permissions.rules, process.cwd());
  const justificationJudge = await resolveJustificationJudge(args, ir.security?.justification);
  const egressMatcher = await resolveEgressMatcher(args, ir.security?.egressMatcher);

  // Skills / hooks / slash commands — plugin skill dirs feed skill discovery.
  const cwd = process.cwd();
  const [settingsHooks, discoveredSkills, discoveredCommands] = await Promise.all([
    loadHooks({ cwd }),
    discoverSkills({ cwd, ...(pluginSkillDirs.length > 0 ? { pluginDirs: pluginSkillDirs } : {}) }),
    loadCommands({ cwd }),
  ]);
  const hooks = mergeSpecHooks(ir.hooks, settingsHooks);

  // Memory + continuity + thredz (the same wireMemory a compiled bundle emits;
  // the REPL-only exam/dream boot niceties are omitted for a served projection).
  let skills: ReadonlyArray<SkillRef> = discoveredSkills;
  let slashCommands: ReadonlyMap<string, SlashCommand> = discoveredCommands;
  let memoryRunOpt: Parameters<typeof runChatLoop>[0]["memory"];
  let continuityRunOpt: Parameters<typeof runChatLoop>[0]["continuity"];
  if (
    (ir.memory !== undefined && ir.memory.enabled !== false) ||
    ir.continuity !== undefined ||
    ir.thredz !== undefined
  ) {
    const wiredMemory = await wireMemory(memoryFragmentFromIr(ir), {
      catalog: {
        register: (tool) => {
          tools.push(tool);
        },
      },
      cwd,
      log: (line) => process.stdout.write(line),
      ...(ir.memory !== undefined && ir.memory.enabled !== false && ir.memory.embedder !== undefined
        ? { embedder: createEmbedder({ model: ir.memory.embedder }) }
        : {}),
      ...(ir.thredz !== undefined ? { thredz: thredzConn } : {}),
    });
    memoryRunOpt = wiredMemory.options.memory;
    continuityRunOpt = wiredMemory.options.continuity;
    if (wiredMemory.options.skills !== undefined) skills = wiredMemory.options.skills;
    if (wiredMemory.options.slashCommands !== undefined) {
      slashCommands = wiredMemory.options.slashCommands;
    }
  }

  if (skills.length > 0) tools.push(createSkillTool(skills));

  // Sub-agents — the Task tool (chat mode) + the routing map (per-subagent).
  let subAgents: ReadonlyMap<string, SubAgentDefinition> | undefined;
  if (ir.subAgents.length > 0) {
    // 0.6.0 §7.7 — the ONE IR → runtime mapping (routing quartet, params,
    // budget_share, inherit_routing, allowed_profiles ride along), in parity
    // with the emitted `__subAgents` literal.
    subAgents = new Map(ir.subAgents.map((d) => [d.name, subAgentDefinitionFromIr(d)]));
    tools.push(createTaskTool({ subAgents }));
  }

  // Plugin tools register LAST — a plugin tool named after a built-in / skill /
  // MCP tool is skipped so first-party wins the collision.
  for (const t of pluginTools) {
    if (tools.some((existing) => existing.name === t.name)) {
      process.stdout.write(
        `[plugins] tool "${t.name}" already registered — plugin contribution skipped\n`,
      );
      continue;
    }
    tools.push(t);
  }

  const hasCodeExecTools = ir.tools.some(
    (t) => t === "python" || t === "javascript" || t === "shell",
  );
  const sandboxAvailable = resolveSandboxAvailable();

  // 0.6.0 §7.8 — serve hosts ONE single-turn run per inbound message, and a
  // reply is one the caller is waiting on: the loop hands an in-flight shadow
  // (the audition lane's re-run plus its judging) here instead of awaiting it
  // at the run's teardown, so the reply returns as soon as the served text is
  // final. Every drained shadow is awaited in `cleanup`, before the process
  // exits — chained, so a long-lived server holds one promise, not a list.
  let sideCallsSettled: Promise<void> = Promise.resolve();
  const sideCallDrain = (settled: Promise<void>): void => {
    sideCallsSettled = sideCallsSettled.then(() => settled);
  };

  // The loop options shared by every turn (primary agent OR a routed sub-agent).
  const commonOptions = {
    permissionMode,
    permissionRules,
    sideCallDrain,
    // G11 — the MCP daemon is the most headless surface there is (under stdio
    // transport stdout is even redirected to stderr), so an `ask` here has
    // never had anywhere to go. Threaded once here, covering the primary turn
    // and the per-sub-agent turn below.
    ...approvalRunOptions(args, ir.permissions),
    sessionName: ir.name,
    sessionTarget: ir.target,
    hooks,
    skills,
    slashCommands,
    singleTurn: true as const,
    ...(hasCodeExecTools ? { sandboxAvailable } : {}),
    ...(ir.agent.maxTokens !== undefined ? { maxTokens: ir.agent.maxTokens } : {}),
    ...(ir.compaction.model !== undefined ? { compactionModel: ir.compaction.model } : {}),
    ...loopContractRunOptions(ir),
    ...(streaming !== undefined ? { streaming } : {}),
    ...(ir.failureTaxonomy !== undefined && ir.failureTaxonomy.length > 0
      ? { failureTaxonomy: ir.failureTaxonomy }
      : {}),
    ...(justificationJudge !== undefined ? { justificationJudge } : {}),
    ...(egressMatcher !== undefined ? { egressMatcher } : {}),
  };

  // The primary agent's per-RUN options. Built fresh for every MCP invocation
  // rather than once per process because the model-routing fragment is no
  // longer a bag of plain values: under `model_pool.strategy.model_directed`
  // `wireModels` constructs the `Escalate` tool and its escalation latch,
  // whose contract is "at most `max_escalations` per RUN". One `serve`
  // process hosts many runs (one per inbound message), so a latch shared
  // across them would let the first caller's escalation exhaust every later
  // caller's allowance — and a request left pending by one invocation would
  // be consumed by another caller's first model call. The fragment is cheap
  // and synchronous; rebuilding it per message is the per-run seam.
  //   - routing: the same `wireModels` call runRunCli spreads, so the two
  //     interpreter paths cannot drift (0.6.0 PR 8a; before it this copy
  //     dropped `circuitBreaker` under `--model` while runRunCli kept it).
  //   - evaluation (0.6.0 PR 8b): the in-loop `evaluation:` block on the
  //     primary agent only (sub-agent invocations are not graded by the
  //     parent's evaluation), the same helper runRunCli spreads.
  const primaryOptionsForRun = () => ({
    ...commonOptions,
    model,
    instructions: ir.agent.instructions,
    tools,
    ...modelRoutingRunOptions(ir.agent, modelOverride, { sessionName: ir.name }),
    ...evaluationRunOptions(ir),
    ...(subAgents !== undefined ? { subAgents, spawnSubAgent } : {}),
    ...(memoryRunOpt !== undefined ? { memory: memoryRunOpt } : {}),
    ...(continuityRunOpt !== undefined ? { continuity: continuityRunOpt } : {}),
  });

  // One agent, one turn at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const invoke: McpInvoke = (message, context) =>
    serialize(() => {
      if (context.subAgent !== undefined) {
        const def = subAgents?.get(context.subAgent);
        if (def === undefined) {
          throw new ServeMcpError(`unknown sub-agent "${context.subAgent}"`);
        }
        return runChatLoop({
          ...commonOptions,
          model: def.model ?? model,
          // An MCP-exposed sub-agent has no Task `profile` to pin: it runs on
          // its declared plan, so the default profile's overlay heads its prompt.
          instructions: foldSubAgentOverlay(def.instructions, def.overlay),
          // `def.tools` is the sub-agent's resolved allowlist (always concrete
          // from the IR; `?? []` only satisfies the optional runtime type).
          tools: filterChildTools(tools, def.tools ?? []),
          seedMessages: [{ role: "user" as const, content: message }],
        });
      }
      return runChatLoop({
        ...primaryOptionsForRun(),
        seedMessages: [{ role: "user" as const, content: message }],
      });
    });

  const cleanup = async (): Promise<void> => {
    // §7.8 — drained shadows settle (their verdicts are what the audition
    // lane records) before the MCP peers this process opened go away.
    await sideCallsSettled;
    if (mcpHost !== undefined) await mcpHost.disconnectAll();
  };

  return { invoke, cleanup };
}

async function runDoctor(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus doctor [--philosophy-alignment [--json] [--baseline | --accept-baseline]]\n" +
        "                       [--liveness] [--context-pressure [--sessions N]] [--probe]\n" +
        "  --philosophy-alignment   audit the codebase + examples against the three architectural pillars\n" +
        "  --json                   persist findings (stable ids) to .crewhaus/scope-audit/<date>.json\n" +
        "                           and print the snapshot JSON (item 49)\n" +
        "  --baseline               diff findings against .crewhaus/scope-audit/baseline.json; exit\n" +
        "                           non-zero ONLY on NEW findings (accepted legacy findings never block)\n" +
        "  --accept-baseline        promote the current findings to the accepted baseline\n" +
        "  --liveness               process-liveness probe: exit 0 immediately, no credential or\n" +
        "                           spec checks (for container HEALTHCHECKs / k8s exec probes)\n" +
        "  --slo | --ttft           compare recent p95 TTFT (.crewhaus/metrics/sessions.jsonl)\n" +
        "                           against the cwd spec's observability.slo.ttft_ms; on a breach,\n" +
        "                           name faster candidate models to eval. Exit 1 on breach, else 0\n" +
        "                           (container-HEALTHCHECK / k8s exec-probe semantics)\n" +
        "  --context-pressure       report truncation recoveries, compaction fires per session\n" +
        "                           (snip vs autocompact split), and the cwd spec's max_tokens/\n" +
        "                           compaction knobs over the last N sessions (--sessions N,\n" +
        "                           default 20). When the advise thresholds trip, prints the\n" +
        "                           exact commands that close the tuning loop:\n" +
        "                             crewhaus advise --all -o . && crewhaus optimize crewhaus.yaml \\\n" +
        "                               --from-advice suggestions.json --write-back ...\n" +
        "                           Always exits 0 — a report, not a gate.\n" +
        "  --detect                 inventory what's REACHABLE right now: model providers\n" +
        "                           (from env), the local Ollama/vLLM endpoint's models\n" +
        "                           (OPENAI_BASE_URL or http://localhost:11434/v1), and MCP\n" +
        "                           servers from .mcp.json / Claude Desktop config. Read-only.\n" +
        "       [--no-probe]        skip the localhost HTTP probe (offline / CI)\n" +
        "  --fix                    apply the mechanical remediations doctor otherwise only\n" +
        "                           prints: scaffold a missing crewhaus.yaml, create .crewhaus/,\n" +
        "                           mark outward tools scope:external via a CST spec-patch, and\n" +
        "                           append commented .env stubs. DRY-RUN IS THE DEFAULT — without\n" +
        "                           --fix, doctor prints the diff it WOULD apply.\n" +
        "  --probe                  OPT-IN live credential probe: one ~1-token call per\n" +
        "                           configured provider (the cwd spec's model verbatim, plus a\n" +
        "                           cheap default for other providers with env set), catching\n" +
        "                           unfunded accounts (billing) and invalid keys (auth) before\n" +
        "                           a long run dies on them. Spends fractional-cent tokens, so\n" +
        "                           it is never on by default. Failures fail doctor (exit 1).\n" +
        "                           When the cwd spec carries `thredz:`, also runs one live\n" +
        "                           wiki_stats round-trip through the thredz MCP server —\n" +
        "                           disabled keys (thredz_billing) and plan caps (thredz_quota)\n" +
        "                           surface here instead of degrading a long run.\n" +
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
  if (args.flags["models"]) {
    runDoctorModels();
    return;
  }
  if (args.flags["slo"] || args.flags["ttft"]) {
    await runDoctorSlo();
    return;
  }
  if (args.flags["detect"]) {
    await runDoctorDetect(args);
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

  // 0.6.0 §9.2 — the spec/CLI schema-version drift signal. A spec behind (or
  // ahead of) this CLI still compiles — the check is a WARN with the exact
  // `crewhaus upgrade` / `chvm use latest` remedy, never a failure.
  if (specText !== undefined) {
    const { createDefaultEngine } = await import("@crewhaus/migration-engine");
    checks.push(buildSpecVersionCheck(specText, createDefaultEngine()));
  }

  // v0.3.0 Goal 6 — `--probe`: opt-in ~1-token live call per configured
  // provider (the spec's model verbatim + cheap defaults for other
  // configured providers), catching unfunded/invalid keys pre-run. Failures
  // classify through recovery-engine (billing/auth/rate_limit) so the ✗
  // line names the fix class, and they gate doctor's exit like any check.
  if (args.flags["probe"]) {
    const plan = buildProbePlan(specModel, process.env);
    if (plan.length === 0) {
      process.stdout.write("~ live probe: no configured providers to probe\n");
    } else {
      checks.push(...probeResultsToChecks(await runProviderProbes(plan)));
    }
    // v0.3.0 Goal 3 (§4.4) — when the cwd spec carries `thredz:`, probe the
    // configured server with one live wiki_stats round-trip so a disabled
    // key (billing lapse) or plan cap surfaces BEFORE a long run degrades
    // on it. Classified through the same choke point the run path uses.
    if (specText !== undefined) {
      const thredzTarget = thredzProbeTarget(specText);
      if (thredzTarget !== undefined) {
        checks.push(thredzProbeToCheck(await probeThredz(thredzTarget)));
      }
    }
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

  // Loop contract 0.4 (Batch C, item 4) — surface this project's agent
  // identity fingerprint (the `agentId` stamped onto every trace envelope +
  // audit record) so an operator can correlate traces/audits to this agent.
  // Read-only: doctor never mints one (a run does, on first boot) — an absent
  // file is reported informationally, not created.
  process.stdout.write(`${describeAgentIdentityLine(process.cwd())}\n`);

  for (const c of checks) {
    if (c.warn && c.pass) {
      process.stdout.write(`~ ${c.label}: ${c.reason ?? "informational"}\n`);
    } else if (c.pass) {
      process.stdout.write(`✓ ${c.label}\n`);
    } else {
      process.stdout.write(`✗ ${c.label}: ${c.reason ?? "failed"}\n`);
    }
  }

  // Item 40 — the mechanical remediation planner. `--fix` OR dry-run (default):
  // plan the safe fixes over the checks just run and either print the diff
  // (dry-run) or apply it (--fix). Runs after the check report so the operator
  // sees WHAT failed before WHAT would be fixed. A crash here never masks the
  // check verdict below.
  await runDoctorFix({ apply: args.flags["fix"] === true, specPath, specModel });

  const allPass = checks.every((c) => c.pass);
  process.stdout.write(allPass ? "\nall checks passed.\n" : "\nsome checks failed.\n");
  process.exit(allPass ? 0 : 1);
}

/**
 * Item 24 — `~/.crewhaus/pricing/` feed dir. The newest dated feed there
 * overrides `DEFAULT_PRICING` for cost projections; a broken feed is a loud
 * error (never a silent $0 regression). Returns the effective table.
 */
function pricingDir(): string {
  return join(homedir(), ".crewhaus", "pricing");
}

function loadUserPricing(): PricingTable {
  const dir = pricingDir();
  if (!existsSync(dir)) return DEFAULT_PRICING;
  const feeds: PricingTable[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const text = readFileSync(join(dir, name), "utf-8");
    // Let a parse error propagate as a CLI failure — a corrupt feed silently
    // billing $0 is exactly the gap doctor --models exists to close.
    feeds.push(parsePricingFeed(text));
  }
  return pickNewestPricing(feeds);
}

/**
 * Item 24 — `crewhaus doctor --models`. Reads the cwd spec's agent.model (+
 * compaction.model when present), and flags: models missing from the pricing
 * table (silently billed $0), pricing-table staleness, and known sunsets.
 * Exits non-zero only on a hard pricing MISS (a warn — stale/sunset — never
 * fails); a report, model-advisory flavour of doctor.
 */
function runDoctorModels(): void {
  const specPath = join(process.cwd(), "crewhaus.yaml");
  let agentModel: string | undefined;
  const auxModels: Array<{ slot: string; model: string }> = [];
  const sentinelResolutions: Array<{ slot: string; resolved: string }> = [];
  if (existsSync(specPath)) {
    try {
      const rawSpec = parseSpec(readFileSync(specPath, "utf-8"));
      const ir = lower(rawSpec);
      const agent = (ir as { agent?: { model?: unknown } }).agent;
      if (agent !== undefined && typeof agent.model === "string") agentModel = agent.model;
      const compaction = (ir as { compaction?: { model?: unknown } }).compaction;
      if (compaction !== undefined && typeof compaction.model === "string") {
        auxModels.push({ slot: "compaction.model", model: compaction.model });
        // Item 25 — surface what `cheapest` resolved to: the RAW spec said
        // "cheapest", the lowered IR carries the concrete model.
        const rawCompaction = (rawSpec as { compaction?: { model?: unknown } }).compaction;
        if (rawCompaction?.model === "cheapest") {
          sentinelResolutions.push({ slot: "compaction.model", resolved: compaction.model });
        }
      }
      const subAgents = (ir as { subAgents?: ReadonlyArray<{ name?: string; model?: unknown }> })
        .subAgents;
      for (const sa of subAgents ?? []) {
        if (typeof sa.model === "string") {
          auxModels.push({ slot: `sub-agent ${sa.name ?? "?"}.model`, model: sa.model });
        }
      }
    } catch {
      // tolerant: a non-cli / unparseable spec still gets a table-freshness check
    }
  }
  const pricing = loadUserPricing();
  const checks = buildModelChecks(agentModel, { pricing, auxModels });
  let anyFail = false;
  for (const c of checks) {
    if (c.warn && c.pass) {
      process.stdout.write(`~ ${c.label}: ${c.reason ?? "informational"}\n`);
    } else if (c.pass) {
      process.stdout.write(`✓ ${c.label}\n`);
    } else {
      anyFail = true;
      process.stdout.write(`✗ ${c.label}: ${c.reason ?? "failed"}\n`);
    }
  }
  for (const s of sentinelResolutions) {
    process.stdout.write(`ℹ ${s.slot}: "cheapest" resolved to ${s.resolved}\n`);
  }
  if (agentModel === undefined) {
    process.stdout.write(
      "~ no agent.model in the cwd crewhaus.yaml — only the pricing table was checked\n",
    );
  }
  process.stdout.write(anyFail ? "\nsome model checks failed.\n" : "\nmodel checks passed.\n");
  process.exit(anyFail ? 1 : 0);
}

/**
 * Item 24 — `crewhaus pricing sync|show`. `sync --file <feed.json>` validates
 * a versioned pricing feed and installs it at ~/.crewhaus/pricing/<version>.json,
 * from where `doctor --models`/cost projections pick up the newest. `show`
 * prints the effective table's version + freshness.
 */
async function runPricing(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus pricing <sync|show>\n" +
        "  sync --file <feed.json>   validate + install a versioned pricing feed into\n" +
        "                            ~/.crewhaus/pricing/<version>.json (overrides DEFAULT_PRICING\n" +
        "                            for cost projections without a code release)\n" +
        "  show                      print the effective pricing table's version + freshness\n",
    );
    return;
  }
  if (action === "show") {
    const pricing = loadUserPricing();
    const staleness = classifyPricingStaleness(pricing, new Date(), 120);
    process.stdout.write(`pricing table version: ${pricing.version}\n`);
    process.stdout.write(`${staleness.stale ? "~ " : "✓ "}${staleness.reason}\n`);
    const dir = pricingDir();
    process.stdout.write(
      existsSync(dir)
        ? `feeds dir: ${dir}\n`
        : `feeds dir: ${dir} (none installed — using built-in DEFAULT_PRICING)\n`,
    );
    return;
  }
  // action === "sync"
  const file = args.flags["file"];
  if (typeof file !== "string") die("pricing sync: missing --file <feed.json>");
  let feedText: string;
  try {
    feedText = readFileSync(resolve(file), "utf-8");
  } catch (err) {
    die(`could not read ${file}: ${(err as Error).message}`);
  }
  let table: PricingTable;
  try {
    table = parsePricingFeed(feedText);
  } catch (err) {
    die((err as Error).message);
  }
  const dest = join(pricingDir(), `${table.version.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, `${JSON.stringify(table, null, 2)}\n`);
  process.stdout.write(`✓ installed pricing feed v${table.version} → ${dest}\n`);
  const providers = Object.keys(table.providers).length;
  process.stdout.write(
    `  ${providers} provider table(s); the newest dated feed here now overrides DEFAULT_PRICING\n`,
  );
  // 0.6.0 §9.1 — a feed may carry sunsets; they install with it and reach
  // `doctor --models` through `effectiveSunsets` (advisory, never a gate).
  const sunsetCount = Object.values(table.sunsets ?? {}).reduce((n, list) => n + list.length, 0);
  if (sunsetCount > 0) {
    process.stdout.write(
      `  ${sunsetCount} sunset announcement(s) installed — \`crewhaus doctor --models\` now warns on them\n`,
    );
  }
}

/**
 * Item 37 — `crewhaus doctor --slo` (alias `--ttft`): the latency/TTFT half of
 * the SLO feature. Reads the cwd spec's lowered `observability.slo.ttft_ms` +
 * agent model, compares the RECENT p95 TTFT (from the alert-watchdog's durable
 * `.crewhaus/metrics/sessions.jsonl`) against the target, and on a breach names
 * faster candidate models to eval. Exits with the probe's code so it composes
 * with `doctor --liveness`'s container-HEALTHCHECK semantics (0 within SLO / no
 * data, 1 breach). The heavy lifting lives in slo-doctor.ts (side-effect-free).
 */
async function runDoctorSlo(): Promise<void> {
  const cwd = process.cwd();
  const specPath = join(cwd, "crewhaus.yaml");
  let ttftTargetMs: number | undefined;
  let currentModel: string | undefined;
  if (existsSync(specPath)) {
    try {
      const ir = lower(parseSpec(readFileSync(specPath, "utf-8")));
      const obs = (ir as { observability?: { slo?: { ttftMs?: number } } }).observability;
      ttftTargetMs = obs?.slo?.ttftMs;
      const agent = (ir as { agent?: { model?: unknown } }).agent;
      if (agent !== undefined && typeof agent.model === "string") currentModel = agent.model;
    } catch {
      // A non-parseable / non-agent spec leaves the probe with no target — it
      // then reports "nothing declared" and exits 0 (never fails on spec shape).
    }
  }
  const sessionsPath = join(cwd, ".crewhaus", "metrics", "sessions.jsonl");
  const sessionsJsonl = existsSync(sessionsPath) ? readFileSync(sessionsPath, "utf-8") : "";
  const result = runSloProbe({
    ttftTargetMs,
    currentModel,
    sessionsJsonl,
    pricing: loadUserPricing(),
  });
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  process.exit(result.exitCode);
}

/**
 * Item 40 — the real-fs seam wiring for `doctor --detect`. Assembles the
 * inventory (providers from env, the localhost model probe, MCP servers from
 * .mcp.json + Claude Desktop config) and prints it. Read-only; always exits 0.
 */
async function runDoctorDetect(args: ParsedArgs): Promise<void> {
  const fetchImpl: FetchLike = async (url, init) => {
    // Bound the probe so an unreachable endpoint can't hang doctor.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(url, { signal: init?.signal ?? controller.signal });
      return { ok: res.ok, status: res.status, json: () => res.json() };
    } finally {
      clearTimeout(timer);
    }
  };
  const configPaths = [join(process.cwd(), ".mcp.json")];
  const desktop = claudeDesktopConfigPath(process.platform, process.env);
  if (desktop !== undefined) configPaths.push(desktop);
  const inventory = await buildInventory({
    env: process.env,
    fetchImpl,
    readConfig: (p) => {
      try {
        return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
      } catch {
        return undefined;
      }
    },
    configPaths,
    skipProbe: args.flags["no-probe"] === true,
  });
  process.stdout.write(formatInventory(inventory));
  process.exit(0);
}

/**
 * Item 40 — plan + (optionally) apply doctor's mechanical fixes. Dry-run is
 * the default: without `--fix`, this prints the diff each fixer WOULD write.
 * Fixers are attached only where a safe mechanical fix exists; anything else
 * stays advisory (printed by the checks above). The tool-scope fixer resolves
 * findings via the same `auditSpecToolNames` gate `compile --strict` uses.
 */
async function runDoctorFix(opts: {
  readonly apply: boolean;
  readonly specPath: string;
  readonly specModel: string | undefined;
}): Promise<void> {
  const fixFs: FixFs = {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, "utf-8"),
    write: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    },
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
  };
  const actions: FixAction[] = [];

  // Fixer 1 — scaffold a missing crewhaus.yaml (cwd basename as the name).
  const scaffold = planScaffoldSpec({
    fs: fixFs,
    specPath: opts.specPath,
    specName: basename(process.cwd()),
  });
  if (scaffold !== undefined) actions.push(scaffold);

  // Fixer 2 — create the .crewhaus state dir.
  const dirs = planCrewhausDirs({ fs: fixFs, crewhausDir: join(process.cwd(), ".crewhaus") });
  if (dirs !== undefined) actions.push(dirs);

  // Fixer 3 — mark outward tools scope:external. Only when a spec exists (a
  // scaffold-only run has no tools to audit yet). Reuses the strict-scope gate
  // to find outward-by-name sinks that resolve to no external tool, then keeps
  // only the plain-identifier ones a mechanical scope stamp can safely fix.
  if (fixFs.exists(opts.specPath)) {
    try {
      const yamlText = fixFs.read(opts.specPath);
      const spec = parseSpec(yamlText);
      const ir = lower(spec);
      const toolNames = collectToolNames(ir);
      if (toolNames.length > 0) {
        const toolMap = await loadToolMap();
        const byRegisteredName: Record<string, RegisteredTool> = {};
        for (const tool of Object.values(toolMap)) byRegisteredName[tool.name] = tool;
        const findings = auditSpecToolNames(
          toolNames,
          (name) => toolMap[name] ?? byRegisteredName[name],
        );
        for (const f of findings) {
          const fix = planScopeFix({
            fs: fixFs,
            specPath: opts.specPath,
            specTarget: spec.target,
            toolName: f.toolName,
          });
          if (fix !== undefined) actions.push(fix);
        }
      }
    } catch {
      // A spec that doesn't parse/lower can't be scope-audited — the credential
      // and spec checks above already reported it; skip the scope fixer.
    }
  }

  // Fixer 4 — commented .env stubs for the selected provider's missing creds.
  if (opts.specModel !== undefined) {
    const provider = selectedProvider(opts.specModel);
    const neededVars = provider !== undefined ? providerEnvStubs(provider) : [];
    const missing = neededVars.filter((v) => {
      const val = process.env[v];
      return typeof val !== "string" || val === "";
    });
    const envStub = planEnvStubs({
      fs: fixFs,
      envPath: join(process.cwd(), ".env"),
      neededVars: missing,
    });
    if (envStub !== undefined) actions.push(envStub);
  }

  if (opts.apply) {
    for (const a of actions) a.apply();
  }
  process.stdout.write(`\n${formatFixPlan(actions, opts.apply)}`);
}

/**
 * Workstream D — collect the `--philosophy-alignment` findings. Audits the
 * repo against the three architectural pillars (compiler-as-protagonist,
 * eval-is-active, security-is-fabric). Item 49 gave every finding a stable
 * (class, file, symbol) identity so the drift watch can persist/diff them,
 * and added the boundary-drift detector on top of the six-site check.
 */
/**
 * 0.6.0 §10.1 — run `auditModelPlan` over `<cwd>/crewhaus.yaml` when present.
 * A spec that does not parse or lower is not this audit's concern (doctor's
 * spec checks and `crewhaus lint` report that), so it yields no finding.
 */
function collectModelPlanFindings(cwd: string): PhilosophyFinding[] {
  const specPath = join(cwd, "crewhaus.yaml");
  if (!existsSync(specPath)) return [];
  let ir: ReturnType<typeof lower>;
  try {
    ir = lower(parseSpec(readFileSync(specPath, "utf8")));
  } catch {
    return [];
  }
  const findings = auditModelPlan(ir);
  if (findings.length === 0) {
    return [
      {
        class: "model-plan",
        file: "crewhaus.yaml",
        symbol: "model-plan-checks",
        label: "Pillar 2/3 — crewhaus.yaml: judge independence, profile tools, roster references",
        pass: true,
      },
    ];
  }
  return findings.map((f) => ({
    class: "model-plan",
    file: "crewhaus.yaml",
    symbol: `${f.rule}:${f.path}`,
    label: `Pillar 2/3 — crewhaus.yaml ${f.rule} at ${f.path}`,
    pass: f.severity !== "error",
    ...(f.severity === "warning" ? { warn: true } : {}),
    reason: f.message,
  }));
}

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

  for (const site of BOUNDARY_SITES) {
    const filePath = join(process.cwd(), site.path);
    findings.push(
      ...auditBoundarySite(site, existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined),
    );
  }

  // 0.6.0 §10.1 — the spec-level model-plan checks (shared with `crewhaus
  // lint`, see model-plan-lint.ts) over the cwd spec when one is present:
  // judge independence on pooled / strategy blocks, profile tools ⊆ the
  // shape's toolset, roster references. Warnings are warn-tier; a roster
  // reference that names no roster member is a hard finding.
  findings.push(...collectModelPlanFindings(process.cwd()));

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
        "[--min-score F] [--no-redact] [--mutator rule-based|claude|meta-harness] [--stage <name>] " +
        "[--iterations N] [--seed N] [--concurrency N] " +
        "[--improvement-threshold F] [--budget-usd N] [--from-advice <suggestions.json>] " +
        "[--write-back] [--no-register] [--no-pin-regressions] [--no-retry] [-o <out-dir>]\n" +
        "  MULTI-STAGE SPECS (D36). workflow / graph / crew / pipeline are optimizable: each\n" +
        "  candidate is compiled with the eval-entry variant (the same emission `crewhaus\n" +
        "  compile --with-eval-harness` performs) and measured by DRIVING that compiled\n" +
        "  runtime per sample through the Wave-4 eval bridge — the same eval-gated accept\n" +
        "  loop, budget gate and regression pinning as a cli spec. Only the per-stage\n" +
        "  prompt paths already whitelisted in spec-patch's OPTIMIZABLE_PATHS are rewritten\n" +
        "  (workflow step instructions, graph node instructions, crew role instructions,\n" +
        "  pipeline agent.instructions); `kind: judge` steps/nodes run no agent turn and are\n" +
        "  never mutated. --stage <name> narrows to one step/node/role (an unknown name\n" +
        "  errors and lists the valid ones). WITHOUT --stage a multi-stage spec optimizes\n" +
        "  its stages SEQUENTIALLY in declaration order, each gated independently against\n" +
        "  --improvement-threshold: a stage that wins composes into the working spec the\n" +
        "  next stage starts from, a stage that does not leaves the spec untouched and the\n" +
        "  run moves on. --iterations is PER STAGE; --budget-usd is a RUN ceiling, threaded\n" +
        "  down as remaining budget so a 3-stage run cannot spend 3x the cap. Because the\n" +
        "  candidate bundle carries bare @crewhaus/* imports, run this inside a harness\n" +
        "  whose dependencies are installed (the default -o keeps candidates under\n" +
        "  .crewhaus/optimize/<runId>/, which is exactly that).\n" +
        "  MUTATORS (--mutator, default rule-based).\n" +
        "    rule-based    offline, deterministic, $0 — bounded edits over the prompt plus\n" +
        "                  numeric-knob proposals on OPTIMIZABLE_PATHS dial entries. No\n" +
        "                  provider credentials, no model calls.\n" +
        "    claude        a model rewrites the prompt from the current best + the failing\n" +
        "                  dev samples' grader rationales. Needs credentials for the spec's\n" +
        "                  own model (resolved through the model router) and spends against\n" +
        "                  --budget-usd.\n" +
        "    meta-harness  EXPERIMENTAL (§56, arxiv 2603.28052). Same model-backed proposer,\n" +
        "                  but its INPUT is a filesystem-backed EXPERIENCE STORE this run\n" +
        "                  writes under the out dir (<out>/experience/candidate_NNN/ — one\n" +
        "                  record per measured candidate: its artifact, per-sample scores and\n" +
        "                  trace), so iteration N sees every earlier measurement instead of a\n" +
        "                  fixed summary window. It REWRITES THE WHOLE PROMPT each iteration\n" +
        "                  rather than editing it. Credentials required; every proposer call\n" +
        "                  is metered against --budget-usd exactly like --mutator claude. It\n" +
        "                  is spec-shaped: the candidate is instructions, so it round-trips\n" +
        "                  through parseSpec and lands behind the same eval accept gate,\n" +
        "                  OPTIMIZABLE_PATHS validation and regression pinning as the other\n" +
        "                  two — the package's whole-BUNDLE rewriting mode stays library-only.\n" +
        "                  Published results on trajectory-level scaffold search are mixed:\n" +
        "                  review every accepted patch.\n" +
        "  WHAT THE SEARCH MEASURES. Fitness evals grade each candidate on the dev samples'\n" +
        "  `input` + `expected_output` only — a sample's `expected_tools` and `metadata` are\n" +
        "  NOT threaded into the search, so tool-accuracy graders and slice reporting are\n" +
        "  applied by `crewhaus eval` at the gate, not inside the loop. Samples pinned into\n" +
        "  the <specName>-regressions dataset keep their ORIGINAL fields, so the gate grades\n" +
        "  them in full. Multi-turn samples (`history`) are refused up front on the bridged\n" +
        "  workflow/graph/crew path (their compiled runtimes take one trigger input), the\n" +
        "  same rule the generated eval bundle enforces.\n" +
        "  --dataset takes a file path or registry:<name>[@version][#split] (Section 29 registry;\n" +
        "  default version: latest). A registry record with populated train AND dev splits is\n" +
        "  used as-is; otherwise the selected samples get the inline 70/30 split. The test\n" +
        "  split is never optimized against — an explicit #test ref is refused (the held-out\n" +
        "  split gates releases; only `crewhaus eval` / `crewhaus deploy canary` consume\n" +
        "  it, behind --allow-test-split).\n" +
        "  User-rating loops (item 1): --ratings <session>|all distills feedback inline for\n" +
        "  this run only (unchanged). Sample text is PII/secret-redacted by default before\n" +
        "  it reaches the sample pool, the synthesized graders, or the optimizer meta-prompt\n" +
        "  (the same detector set as `crewhaus distill`); --no-redact keeps it raw (dev/local\n" +
        "  only). A spec with feedback.autoDistill maintains a VERSIONED\n" +
        "  `<specName>-ratings` registry dataset at run teardown instead — consume it here\n" +
        "  (and in `crewhaus eval`) as --dataset registry:<specName>-ratings (latest by\n" +
        "  default, or pin @vN).\n" +
        "  When a patch is accepted (with or without --write-back), the dev samples that flipped\n" +
        "  fail→pass are pinned into the <specName>-regressions registry dataset (a new version\n" +
        "  unioning the previous one, deduped by sample id) so `crewhaus eval` guards them by\n" +
        "  default. --no-pin-regressions skips the pin.\n" +
        "  --few-shot <pool|auto> injects the top-K harvested examples (`crewhaus fewshot`) into\n" +
        "  the candidate instructions. Pool examples whose (sessionId, turnNumber) provenance\n" +
        "  appears in the eval dataset are excluded first (counted + logged) — a demonstration\n" +
        "  must never be one of the dev samples being measured.\n" +
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
        // D36 — `--stage` parses long before the stage resolution below, and
        // the advice branch returns before it; without this the flag would be
        // silently ignored (and a multi-stage spec would later die with a
        // message about targets rather than about the ignored flag).
        stage: typeof args.flags["stage"] === "string",
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
  // B23 — the inline distill redacts by default; --no-redact opts out
  // (mirrors `crewhaus distill`, which shares the same ingestion core).
  const ratingsDistill =
    typeof ratingsArg === "string"
      ? distillRatings(
          ratingsArg,
          ratingsMinScore,
          args.flags["no-redact"] === true ? undefined : redactDatasetText,
        )
      : undefined;

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

  // Item #54 — few-shot pool resolution. When `--few-shot <pool|auto>` is
  // set, the pool is read (and its emptiness rejected) up front, but the
  // actual injection is DEFERRED until after the dataset is materialized so
  // pool examples overlapping the eval dataset can be excluded first
  // (NEW-datasets-1) — see the injection block below the train/dev split.
  const fewShotFlag = strFlag(args, "few-shot");
  let optimizeSpecPath = absSpec;
  let fewShotDisablesWriteBack = false;
  let fewShotPool: FewShotExample[] | undefined;
  let fewShotPoolFile: string | undefined;
  if (typeof fewShotFlag === "string") {
    fewShotPoolFile =
      fewShotFlag === "auto"
        ? join(
            dirname(absSpec),
            FEWSHOT_SUBDIR,
            `${parseSpec(readFileSync(absSpec, "utf-8")).name}.jsonl`,
          )
        : resolve(fewShotFlag);
    fewShotPool = readFewShotPool(fewShotPoolFile);
    if (fewShotPool.length === 0) {
      die(`no few-shot pool at ${fewShotPoolFile} — run \`crewhaus fewshot harvest\` first`);
    }
  }

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
  // G14 — same registry-construction rule as `crewhaus eval`: `type:
  // registry` graders get the default registry, built ONCE here and reused
  // by every fitness eval the search runs (N candidate evals must not
  // re-discover plugins per pass).
  const graderRegistry = await graderRegistryForCompiled(compiled);

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
  // samples join the pool below and get the inline 70/30 split. B16 — the
  // registry's test split NEVER enters optimization: an explicit #test ref
  // is refused (a holdout the optimizer saw is burned as a release gate).
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
        refuseTestSplitRef("optimize", registryRef);
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

  // Item #54 — few-shot injection: prepend the top-K harvested examples to
  // the spec's `agent.instructions` in an augmented temp spec that the
  // optimizer + fitness run against, so the mutation search improves the
  // prompt WITH the in-context demonstrations present. The source spec is
  // never mutated on this path (patch-only), so the examples don't
  // accidentally get baked into the tracked spec; re-run without --few-shot
  // (or edit instructions) to persist them.
  // NEW-datasets-1 — runs AFTER the dataset materialized above: any pool
  // example whose (sessionId, turnNumber) provenance appears in the eval
  // dataset (distill stamps `metadata.sessionId`/`metadata.turnNumber` on
  // every sample; the --ratings inline distill reports the same pairs) is a
  // dev/train sample's input + known-good output verbatim — injecting it
  // would let candidates copy the gold and inflate fitness (train-on-test in
  // flywheel form). Such examples are dropped, counted, and logged; a
  // dataset with no provenance metadata excludes nothing.
  if (fewShotPool !== undefined && fewShotPoolFile !== undefined) {
    // D36 — few-shot injection prepends to `agent.instructions`, which a
    // multi-prompt shape does not have (which of the stages would the
    // demonstrations belong to?). Refuse cleanly instead of letting the
    // extract throw an uncaught error mid-run.
    if (MULTI_PROMPT_TARGETS.has(parseSpec(readFileSync(absSpec, "utf-8")).target)) {
      die(
        "--few-shot injects demonstrations into agent.instructions, which a multi-stage spec (workflow/graph/crew) does not have — add the examples to the step/node/role you want them in, then optimize that stage with --stage <name>",
      );
    }
    const overlapKeys = new Set<string>();
    for (const s of originalById.values()) {
      const sessionId = s.metadata?.["sessionId"];
      const turnNumber = s.metadata?.["turnNumber"];
      if (typeof sessionId === "string" && typeof turnNumber === "number") {
        overlapKeys.add(fewShotOverlapKey(sessionId, turnNumber));
      }
    }
    if (ratingsDistill !== undefined) {
      for (const p of ratingsDistill.provenance) {
        overlapKeys.add(fewShotOverlapKey(p.sessionId, p.turnNumber));
      }
    }
    const { kept, excluded } = excludeOverlappingExamples(fewShotPool, overlapKeys);
    if (excluded > 0) {
      process.stdout.write(
        `[optimize] few-shot: excluded ${excluded} pool turn(s) overlapping the eval dataset\n`,
      );
    }
    if (kept.length === 0) {
      die(
        `--few-shot: all ${fewShotPool.length} pool example(s) overlap the eval dataset — nothing safe to inject (harvest from sessions the dataset was not distilled from)`,
      );
    }
    const fewShotK = intFlag(args, "few-shot-k") ?? 5;
    const block = formatFewShotForPrompt(kept, fewShotK);
    const yamlText = readFileSync(absSpec, "utf-8");
    const baseSpec = parseSpec(yamlText);
    const augmentedInstructions = `${block}\n\n${extractInstructions(baseSpec)}`;
    const { applySpecPatch } = await import("@crewhaus/spec-patch");
    const { yaml: augmentedYaml } = applySpecPatch(yamlText, {
      target: baseSpec.target as never,
      path: ["agent", "instructions"],
      op: "replace",
      value: augmentedInstructions,
    });
    mkdirSync(outDir, { recursive: true });
    optimizeSpecPath = join(outDir, "fewshot-augmented.yaml");
    writeFileSync(optimizeSpecPath, augmentedYaml, { mode: 0o600 });
    fewShotDisablesWriteBack = true;
    process.stdout.write(
      `[optimize] injected ${Math.min(fewShotK, kept.length)} few-shot example(s) from ${fewShotPoolFile}\n`,
    );
    if (writeBack) {
      process.stderr.write(
        "[optimize] --write-back is ignored with --few-shot (the augmented spec is patch-only to keep the tracked spec clean)\n",
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
      ...(graderRegistry !== undefined ? { graderRegistry } : {}),
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

  // D36 — which prompt(s) this run rewrites. `undefined` keeps the historical
  // single-agent path (patch `agent.instructions`, default invoker); a
  // non-empty list selects the bridged multi-stage path.
  const stageFlag = strFlag(args, "stage");
  let selectedStages: ReadonlyArray<OptimizableStage> | undefined;
  {
    const baseSpec = parseSpec(readFileSync(optimizeSpecPath, "utf-8"));
    // pipeline is bridged like the multi-stage shapes but carries exactly ONE
    // prompt; MULTI_PROMPT_TARGETS is the set that needs stage NAMES.
    const bridgedOptimize =
      MULTI_PROMPT_TARGETS.has(baseSpec.target) || baseSpec.target === "pipeline";
    if (bridgedOptimize) {
      const stages = listOptimizableStages(baseSpec);
      if (stages.length === 0) {
        die(
          `spec "${baseSpec.name}" (target: ${baseSpec.target}) has no optimizable prompts — every step/node is a \`kind: judge\` gate, which runs no agent turn and carries no instructions`,
        );
      }
      if (stageFlag !== undefined) {
        const found = findStage(stages, stageFlag);
        if (found === undefined) {
          die(
            `unknown --stage "${stageFlag}" for target: ${baseSpec.target} — valid stages: ${formatStageNames(stages)}`,
          );
        }
        selectedStages = [found as OptimizableStage];
      } else {
        selectedStages = stages;
      }
    } else if (stageFlag !== undefined) {
      die(
        `--stage is only meaningful for a multi-stage spec (workflow/graph/crew/pipeline); target: ${baseSpec.target} has a single agent.instructions prompt`,
      );
    }
    // D36 — PARITY WITH THE GENERATED EVAL BUNDLE. `crewhaus compile
    // --with-eval-harness` wraps its dataset in `guardHistorySamples`, which
    // REFUSES a history-carrying sample against an entry-driven,
    // non-chat-capable shape (workflow/graph/crew) rather than truncating it
    // to the final `input`. The optimizer's `toOptimizerSample` strips
    // `history`, so without this gate the search would quietly grade only the
    // last turn — and then pin those samples into the <spec>-regressions suite
    // that `crewhaus eval` later runs WITH their history. Refuse the same way,
    // before a single candidate is measured. `originalById` holds the
    // un-stripped records for every train+dev sample.
    if (bridgedOptimize) {
      const strategy = selectInvoker(baseSpec.target);
      if (strategy.entryImport !== undefined && !strategy.chatCapable) {
        const multiTurn = [...originalById.values()]
          .filter((s) => Array.isArray(s.history) && s.history.length > 0)
          .map((s) => s.id);
        if (multiTurn.length > 0) {
          die(
            `${multiTurn.length} sample(s) carry a multi-turn history (${multiTurn.slice(0, 5).join(", ")}${multiTurn.length > 5 ? ", …" : ""}), but a bridged target: ${baseSpec.target} run drives the shape's compiled runtime entry (${strategy.entryImport}), which consumes a single trigger input rather than a seeded conversation — the same refusal \`crewhaus compile --with-eval-harness\` makes at load. Remove the history from those samples (or optimize a shape whose runtime is a conversation: cli, channel, managed, pipeline).`,
          );
        }
      }
    }
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
  //
  // D36 — `stage` selects WHICH prompt the candidate replaces and, for the
  // bridged multi-stage shapes, HOW the candidate is measured:
  //   - undefined (single-agent shapes): the historical path — patch
  //     `agent.instructions`, lower, run the eval-runner's default invoker.
  //   - a stage (workflow/graph/crew/pipeline): patch that stage's
  //     instructions, compile the candidate with the eval-entry variant, and
  //     drive the compiled runtime per sample through the Wave-4 bridge
  //     invoker (see ./optimize-stages.ts).
  // `workingSpecPath` is what the search currently reads: it starts at the
  // (possibly few-shot-augmented) optimize spec and advances to the composed
  // working copy as earlier stages are accepted in a sequential run.
  let workingSpecPath = optimizeSpecPath;
  const makeFitness =
    (stage: OptimizableStage | undefined) =>
    async (prompt: string): Promise<import("@crewhaus/prompt-optimizer").FitnessResult> => {
      // Item #54 — read the (possibly few-shot-augmented) optimize spec so the
      // fitness eval sees the same in-context examples the search mutates around.
      const yamlText = readFileSync(workingSpecPath, "utf-8");
      // Re-parse to capture spec.target without depending on the
      // orchestrator's extractCurrentPrompt internals.
      const parsedTarget = parseSpec(yamlText).target;
      // Build a patch and apply it in-memory (no disk write — fitness is
      // pure with respect to the source file).
      const { applySpecPatch } = await import("@crewhaus/spec-patch");
      const { yaml: patchedYaml } = applySpecPatch(yamlText, {
        target: parsedTarget as never,
        path: stage !== undefined ? [...stage.path] : ["agent", "instructions"],
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
      evalCallSeq += 1;
      const evalOutDir = join(
        outDir,
        "evals",
        `${String(evalCallSeq).padStart(3, "0")}_${prompt.length}_${stage !== undefined ? stage.name : ir.target === "cli" ? ir.agent.instructions.length : 0}`,
      );
      // D36 — the bridged path: compile this candidate with the eval-entry
      // variant and measure it by driving the compiled runtime. The compile
      // itself is the gate — a candidate whose rewritten stage no longer
      // emits scores 0 and the search moves on rather than aborting the run.
      let bridged: Awaited<ReturnType<typeof prepareBridgedCandidate>> | undefined;
      if (stage !== undefined && ir.target !== "cli") {
        try {
          bridged = await prepareBridgedCandidate({
            patchedYaml,
            candidateDir: join(outDir, "candidates", String(evalCallSeq).padStart(3, "0")),
          });
        } catch (err) {
          if (err instanceof BridgedCandidateError) {
            // A bridge that cannot be built at all is a CONFIG failure, not a
            // bad candidate — scoring it 0 would silently report "no
            // improvement" for a run that never measured anything.
            die(err.message);
          }
          if (err instanceof CrewhausError) {
            process.stderr.write(
              `[optimize] candidate failed to compile (${err.message}), skipping\n`,
            );
            return { score: 0 };
          }
          throw err;
        }
      } else if (ir.target !== "cli") {
        die(
          `crewhaus optimize does not support target: "${ir.target}" — supported: cli, plus the bridged multi-stage shapes workflow/graph/crew/pipeline (D36). Any other shape can still be MEASURED end-to-end: \`crewhaus compile <spec> --with-eval-harness\` emits an eval bundle that drives its compiled runtime per sample.`,
        );
      }
      // Either the lowered cli IR (narrowed by the die() above) or the
      // bridge's descriptor IR — both are the `target: cli` shape runEval
      // records run identity from; the bridged one is never chat-invoked
      // (opts.invoker drives the compiled runtime instead).
      const runIr = (bridged !== undefined ? bridged.ir : ir) as Parameters<
        typeof runEvalLib
      >[0]["ir"];
      const summary = await runEvalLib({
        ir: runIr,
        dataset: { name: datasetName, samples: makeAsyncIterable(devSet) },
        compiledGraders: compiled,
        opts: {
          // C33 — which CLI produced this run (reproducibility manifest).
          ...cliVersionOpt(),
          outDir: evalOutDir,
          concurrency,
          seed,
          retryErrors,
          ...(graderRegistry !== undefined ? { graderRegistry } : {}),
          ...(bridged !== undefined ? { invoker: bridged.invoker as never } : {}),
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
      // G56 — the search ranks candidates by PARTIAL CREDIT when the runner
      // emitted it (partialScoreMean: mean overall score over ALL samples,
      // errored ones scoring 0), falling back to passRate on older summaries —
      // a candidate that moves failing answers closer to the bar now measures
      // as progress even before whole samples flip.
      // D38 — the meta-harness proposer reads FILESYSTEM-BACKED history, so
      // every measured candidate is written into the experience store the
      // package defines. Without this the store is always empty and the
      // proposer degenerates to the scores-only ablation the paper measured
      // as strictly worse. Best-effort: a store write must never fail a run.
      if (metaHarnessStoreDir !== undefined) {
        try {
          const { persistCandidate } = await import("@crewhaus/meta-harness-optimizer");
          persistCandidate({
            rootDir: metaHarnessStoreDir,
            candidateId: `candidate_${String(evalCallSeq).padStart(3, "0")}`,
            bundleSource: prompt,
            candidateFileName: "instructions.txt",
            scores: Object.fromEntries(
              summary.samples.map((r) => [r.sampleId, r.grades.overall.score]),
            ),
            traceLines: summary.samples.map((r) =>
              JSON.stringify({
                sampleId: r.sampleId,
                score: r.grades.overall.score,
                rationale: r.grades.overall.rationale,
                ...(r.error !== undefined ? { error: r.error } : {}),
              }),
            ),
          });
        } catch (err) {
          process.stderr.write(
            `[optimize] meta-harness experience write skipped: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      return { score: fitnessScore(summary.aggregates), grades, runDir: summary.outDir };
    };

  const mutator = args.flags["mutator"];
  let mutatorImpl: import("@crewhaus/prompt-optimizer").MutationProvider | undefined;
  // D38 — set only for `--mutator meta-harness`; the fitness fn writes each
  // measured candidate here so the next proposer call sees full history. It is
  // re-pointed PER STAGE on the multi-stage path (see `newMetaHarnessMutator`)
  // — a stage-2 proposer must not read stage-1's candidates as if they were
  // its own trajectory: the two stages rewrite different prompts, so their
  // aggregate scores are not comparable directions and the system block's
  // "avoid a direction that already scored worse" rule would act on noise.
  let metaHarnessStoreDir: string | undefined;
  /** Build a fresh meta-harness provider (and store) rooted at `storeDir`. */
  const newMetaHarnessMutator = async (
    storeDir: string,
  ): Promise<import("@crewhaus/prompt-optimizer").MutationProvider> => {
    metaHarnessStoreDir = storeDir;
    return await createMetaHarnessMutatorForSpec(absSpec, storeDir);
  };
  if (mutator === "claude") {
    mutatorImpl = await createClaudeMutatorForSpec(absSpec);
  } else if (mutator === "meta-harness") {
    // Single-stage default; the staged driver rebuilds one per stage below.
    mutatorImpl = await newMetaHarnessMutator(outDir);
    process.stderr.write(META_HARNESS_EXPERIMENTAL_NOTICE);
  } else if (mutator !== undefined && mutator !== "rule-based") {
    die(`unknown --mutator "${mutator}" — supported: rule-based, claude, meta-harness`);
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

  // Item 9 / D36 — post-accept regression pinning, factored out so the
  // single-stage and the sequential multi-stage paths pin identically.
  const pinRecoveries = async (
    baselineEvalDir: string | undefined,
    bestEvalDir: string | undefined,
  ): Promise<void> => {
    // The patch was accepted (with or without --write-back): the dev samples
    // that flipped fail→pass between the baseline eval run and the winning
    // candidate's are exactly the behaviors the patch fixed. Pin them into the
    // per-spec regression suite so `crewhaus eval` keeps guarding them even if
    // the training dataset later churns. Best-effort: a pinning failure must
    // not fail an otherwise successful optimize.
    try {
      const pin = await pinRecoveriesAfterOptimize({
        registry: createFileBackedRegistry({ rootDir: defaultDatasetsRoot() }),
        specName: parseSpec(readFileSync(absSpec, "utf-8")).name,
        pin: args.flags["no-pin-regressions"] !== true,
        ...(baselineEvalDir !== undefined ? { baselineRunDir: baselineEvalDir } : {}),
        ...(bestEvalDir !== undefined ? { candidateRunDir: bestEvalDir } : {}),
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
  };

  if (selectedStages !== undefined) {
    // -------- D36: the bridged multi-stage path --------
    // Item 46 / D36 — the patch.json the changelog registration cites. A staged
    // run never writes `.crewhaus/optimize/<runId>/patch.json` (its patches live
    // per stage), so the default resolution in `autoRegisterSpecVersion` would
    // find nothing and register a spec version with no optimize rationale. Track
    // the LAST accepted stage's patch and pass it explicitly, exactly as the
    // single-stage branch does.
    let lastAcceptedPatchJson: string | undefined;
    const staged = await runStagedOptimize({
      stages: selectedStages,
      startingYamlPath: optimizeSpecPath,
      workingDir: join(outDir, "stages"),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      log: (line) => process.stdout.write(`[optimize] ${line}\n`),
      runStage: async ({ stage, specPath: stageSpecPath, budgetUsd: stageBudget, index }) => {
        workingSpecPath = stageSpecPath;
        const stageRunId = `${runId}_s${String(index).padStart(2, "0")}`;
        const stageOut = join(outDir, "stages", `${String(index).padStart(2, "0")}-${stage.name}`);
        // D38 — one experience store and one provider PER STAGE. Stage k's
        // proposer must only see stage k's own candidates (see the store-dir
        // comment above); the fitness fn writes into `metaHarnessStoreDir`,
        // which this re-points before the stage's first measurement.
        const stageMutator =
          mutator === "meta-harness" ? await newMetaHarnessMutator(stageOut) : mutatorImpl;
        const r = await optimizeSpec({
          specPath: stageSpecPath,
          promptPath: stage.path,
          fitness: makeFitness(stage),
          trainSet,
          devSet,
          iterations,
          seed,
          improvementThreshold,
          outDir: stageOut,
          // Composition is the driver's job (it writes the accepted YAML into
          // the run's stages/ dir); the SOURCE spec is only touched by the
          // single write-back below, so a rejected stage can never leave a
          // half-applied file behind.
          writeBack: false,
          runId: stageRunId,
          traceBus,
          ...(stageMutator !== undefined ? { mutator: stageMutator } : {}),
          ...(stageBudget !== undefined ? { budgetUsd: stageBudget } : {}),
        });
        process.stdout.write(
          `[optimize] stage ${stage.name} score: ${r.scoreBefore.toFixed(3)} → ${r.scoreAfter.toFixed(3)} ` +
            `(Δ ${r.improvement >= 0 ? "+" : ""}${r.improvement.toFixed(3)}); patch: ${join(r.outDir, "patch.json")}\n`,
        );
        if (r.applied) {
          lastAcceptedPatchJson = join(r.outDir, "patch.json");
          await pinRecoveries(r.baselineEvalDir, r.bestEvalDir);
        }
        return {
          applied: r.applied,
          scoreBefore: r.scoreBefore,
          scoreAfter: r.scoreAfter,
          improvement: r.improvement,
          patchedYaml: r.patchedYaml,
          spentUsdMicros: r.spend.totalUsdMicros,
          budgetExhausted: r.stoppedReason === "budget-reached",
        };
      },
    });
    process.stdout.write(
      `[optimize] stages: ${staged.acceptedCount}/${staged.perStage.length} accepted ` +
        `(${selectedStages.length} selected)\n`,
    );
    // FR-003 — the RUN total across every stage, so a multi-stage run reports
    // its spend the way a single-stage run does (each stage's own meter is
    // capped by the remaining budget, never by the full flag value).
    process.stdout.write(
      `[optimize] spend: $${(staged.totalSpentUsdMicros / 1_000_000).toFixed(4)} across ` +
        `${staged.perStage.length} stage(s)` +
        `${staged.stoppedEarly ? ` (stopped: budget reached, $${budgetUsd?.toFixed(2)} cap)` : ""}\n`,
    );
    if (staged.skipped.length > 0) {
      process.stdout.write(
        `[optimize] budget exhausted — ${staged.skipped.length} stage(s) not optimized: ${staged.skipped.map((s) => s.name).join(", ")}\n`,
      );
    }
    if (staged.acceptedCount === 0) {
      process.stdout.write(
        `[optimize] no stage improved above threshold ${improvementThreshold}; source untouched.\n`,
      );
    } else if (writeBack && !fewShotDisablesWriteBack) {
      // ONE write-back for the composed result: the accepted stages' patches
      // are already folded into staged.finalYamlPath. The composition + stamp
      // live in ./optimize-stages.ts so this destructive write is unit-tested.
      writeBackStagedResult({
        result: staged,
        targetSpecPath: absSpec,
        runId,
        mutator: mutator ?? "rule-based",
        iterations,
      });
      process.stdout.write(`[optimize] wrote patched YAML to ${absSpec}\n`);
      if (args.flags["no-register"] !== true) {
        // Item 46 — the staged run's patches live per stage, so name the LAST
        // accepted stage's patch.json explicitly; the default
        // `.crewhaus/optimize/<runId>/patch.json` resolution never resolves on
        // this path and the registered version would carry no rationale.
        await autoRegisterSpec(readFileSync(absSpec, "utf-8"), {
          ...(lastAcceptedPatchJson !== undefined ? { patchJsonPath: lastAcceptedPatchJson } : {}),
        });
      }
    } else {
      process.stdout.write(
        `[optimize] composed spec (${staged.acceptedCount} accepted stage(s)) → ${staged.finalYamlPath}. Re-run with --write-back to apply.\n`,
      );
    }
  } else {
    const result = await optimizeSpec({
      specPath: optimizeSpecPath,
      fitness: makeFitness(undefined),
      trainSet,
      devSet,
      iterations,
      seed,
      improvementThreshold,
      outDir,
      // Item #54 — the few-shot path is patch-only so the injected examples never
      // land in the tracked spec (they'd double-inject on the next run).
      writeBack: writeBack && !fewShotDisablesWriteBack,
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
      await pinRecoveries(result.baselineEvalDir, result.bestEvalDir);
    } else {
      process.stdout.write(
        `[optimize] no improvement above threshold ${improvementThreshold}; source untouched.\n`,
      );
    }
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
  /** G14 — the shared default registry (when the graders opt into one). */
  readonly graderRegistry?: GraderLookup;
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
        // C33 — which CLI produced this run (reproducibility manifest).
        ...cliVersionOpt(),
        outDir: join(adviceDir, label),
        concurrency: opts.concurrency,
        seed: opts.seed,
        retryErrors: opts.retryErrors,
        ...(opts.graderRegistry !== undefined ? { graderRegistry: opts.graderRegistry } : {}),
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
 * F2 (ops pre-merge) — sha256 hex digest of the parsed GradersConfig, keyed
 * on a deterministically-sorted JSON serialization so two byte-identical
 * graders.yaml files always hash equal and key ordering never causes a false
 * mismatch. Mirrors `hashDatasetFile`'s "content identity, not path" shape:
 * recorded into run.json/results.json so `--sentinel` can assert the graders
 * a baseline and a fresh run scored with are byte-identical (F2 — without
 * this, a changed judge model or edited graders.yaml silently reads as
 * "provider drift" because neither ever touches specHash or the dataset).
 */
function hashGradersConfig(config: GradersConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
  const mutatorModel = ir.target === "cli" ? ir.agent.model : "claude-sonnet-5";
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
      `usage:\n  crewhaus flywheel run [spec.yaml] [--dataset <data>] [--graders <graders.yaml>]\n      [--budget-usd N] [--iterations N] [--seed N] [--concurrency N]\n      [--mutator rule-based|claude] [--gate-split train|dev] [--dry-run]\n      [--allow-dirty]\n  crewhaus flywheel init [--force] [--suite <suite.yaml>]\n\n  \`run\` executes the nightly self-improvement loop in one command:\n  compile gate → baseline eval → optimize (budget-capped; claude mutator\n  by default when an ANTHROPIC credential is present, rule-based fallback\n  otherwise) → post-patch compile → after eval → acceptance gate. The\n  patch is applied to the spec ONLY when pass_rate strictly improved with\n  zero per-sample regressions (the same strict gate \`eval --gate\` uses);\n  an accepted write-back then runs the standard auto-register + changelog\n  + regression-pin flow. A rejected patch never touches disk. --dry-run\n  runs everything but never writes.\n\n  Defaults: <spec> is ./crewhaus.yaml; --dataset falls back to\n  ${CONVENTIONAL_DATASET} then registry:<spec>-ratings (when the spec has a\n  feedback: block and ratings were distilled); --graders falls back to\n  ${CONVENTIONAL_GRADERS}; conventional paths resolve from the SPEC's directory,\n  not the cwd, so a spec passed by path brings its own eval/ files. When the\n  dataset is a registry ref (including the ratings fallback), bare refs resolve\n  train+dev only — the locked test split NEVER enters the flywheel, and an\n  explicit #test ref is refused (the held-out split gates releases, not\n  nightly loops). Every run prints the resolved dataset + its source\n  (flag|convention|ratings-registry) and warns when a conventional\n  ${CONVENTIONAL_DATASET} shadows a distilled <spec>-ratings dataset.\n\n  --gate-split train|dev (D42) narrows the BEFORE/AFTER acceptance evals to\n  one registry split; the optimizer's own train/dev sets are unchanged, so\n  the search still reads what it always read. Omitted, the gate scores every\n  split the ref resolved (train+dev) — the historical behavior. A split-gated\n  run keys into its own baseline lineage (<name>@<version>#<split>), and the\n  flag is REFUSED for a flat-file dataset (no split boundaries) and for\n  #test (B16 — the holdout gates releases, not nightly loops).\n\n  The optimizer only ever rewrites agent.instructions from this command —\n  permissions:, the model roster, and every security/allowlist field stay\n  exactly as a human reviewed them (spec-patch's OPTIMIZABLE_PATHS enforces\n  it). D43's numeric-dial search is implemented in the optimizer library and\n  is reachable programmatically (optimizeSpec({ knobs })); no CLI flag builds\n  the dial set yet, so a flywheel run proposes no knob changes. The flywheel\n  refuses to run over uncommitted spec changes (--allow-dirty opts out).\n\n  \`init\` scaffolds .github/workflows/crewhaus-flywheel.yml: nightly cron +\n  workflow_dispatch, budget knobs as env, PR creation via gh for HUMAN\n  review — the workflow never merges on its own. Refuses to overwrite an\n  existing workflow without --force. --suite <suite.yaml> (NEW-HUNT-8) appends\n  a \`crewhaus eval suite --tier nightly --gate\` step to the same cron, running\n  even when the flywheel step failed so neither signal can hide the other; the\n  path is harness-relative and a manifest declaring no nightly tier warns.\n\n${formatFlywheelKnobsGuide()
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
  // NEW-HUNT-8 — the optional nightly tier step. Stored HARNESS-relative
  // (the job's working-directory is the harness), exactly like `init --ci`.
  const suiteFlag = strFlag(args, "suite");
  let suiteRel: string | undefined;
  if (suiteFlag !== undefined) {
    const rel = relative(process.cwd(), resolve(suiteFlag));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      die(
        `--suite "${suiteFlag}" must live inside the harness directory (${process.cwd()}) — the scaffolded job's working-directory is the harness`,
      );
    }
    suiteRel = rel;
  }
  let scaffolded: ReturnType<typeof scaffoldWorkflowFile>;
  try {
    scaffolded = scaffoldWorkflowFile({
      rootDir: wfRoot,
      relPath: FLYWHEEL_WORKFLOW_RELPATH,
      content: buildFlywheelWorkflowYaml({
        harnessDir,
        ...(suiteRel !== undefined ? { suite: suiteRel } : {}),
      }),
      force: args.flags["force"] === true,
    });
  } catch (err) {
    if (err instanceof FlywheelConfigError) die(err.message);
    throw err;
  }
  process.stdout.write(`wrote ${scaffolded.path}\n`);
  if (suiteRel !== undefined) {
    process.stdout.write(
      `flywheel: the same cron also runs \`crewhaus eval suite ${suiteRel} --tier nightly --gate\`\n`,
    );
    warnSuiteManifestGaps(process.cwd(), suiteRel, ["nightly"]);
  }
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
  let gateSplit: FlywheelGateSplit | undefined;
  try {
    knobs = resolveFlywheelKnobs({ flags: args.flags, env: process.env });
    // D42 — per-split acceptance gating. Parsed before anything is spent so
    // a typo'd split fails instantly instead of after the baseline eval.
    gateSplit = parseGateSplit(strFlag(args, "gate-split"));
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
      `crewhaus flywheel only supports target: cli (got "${ir.target}") — the flywheel's compile → eval → optimize → gate loop is cli-only. The lanes it chains are NOT: \`crewhaus optimize\` does support this shape (D36 — per-stage prompt search over workflow/graph/crew/pipeline), and \`crewhaus compile <spec> --with-eval-harness\` emits an eval bundle that measures it by driving its compiled runtime.`,
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
  let ratingsVersion: string | undefined;
  const ratingsName = `${ir.name}-ratings`;
  if (ir.feedback !== undefined && isRegistrySafeName(ratingsName)) {
    try {
      ratingsVersion = await latestVersion(registry, ratingsName);
      ratingsRegistered = ratingsVersion !== undefined;
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
  // NEW-flywheel-shadow — always disclose which precedence rung chose the
  // dataset, and warn loudly when the conventional file shadows a distilled
  // `<spec>-ratings` registry dataset (the state every init --with-evals +
  // feedback.autoDistill harness eventually lands in).
  process.stdout.write(`${formatDatasetSourceLine(data)}\n`);
  const shadowWarning = formatRatingsShadowWarning({
    data,
    specName: ir.name,
    ratingsRegistered,
    ...(ratingsVersion !== undefined ? { ratingsVersion } : {}),
  });
  if (shadowWarning !== undefined) process.stderr.write(`crewhaus: ${shadowWarning}\n`);

  let gradersYaml: string;
  try {
    gradersYaml = readFileSync(resolve(data.graders), "utf-8");
  } catch (err) {
    die(`could not read ${data.graders}: ${(err as Error).message}`);
  }
  const { compiled } = parseGradersConfig(gradersYaml);
  // G14 — same registry-construction rule as `eval`/`optimize`: built ONCE
  // and shared by the before/after acceptance evals and every per-iteration
  // fitness eval.
  const graderRegistry = await graderRegistryForCompiled(compiled);

  // Materialize the dataset once (file path or registry: ref) — the same
  // sample set feeds the before eval, the optimizer's dev evals, and the
  // after eval, so the acceptance diff compares like with like.
  const samples: Sample[] = [];
  let datasetName: string;
  let datasetHash: string;
  let registrySplits: { train: Sample[]; dev: Sample[] } | undefined;
  let registryRef: ReturnType<typeof parseRegistryRef>;
  // D42 — the ACCEPTANCE-gate view. Defaults to the whole resolved set (the
  // pre-D42 behavior); `--gate-split` narrows it to one registry split with
  // its own name + hash so a split-gated run keys into its own baseline
  // lineage instead of colliding with all-split history.
  let gateSamples: Sample[] | undefined;
  let gateDatasetName: string | undefined;
  let gateDatasetHash: string | undefined;
  try {
    registryRef = parseRegistryRef(data.dataset);
  } catch (err) {
    if (err instanceof DatasetRefError) die(err.message);
    throw err;
  }
  if (registryRef !== undefined) {
    let resolved: Awaited<ReturnType<typeof resolveRegistryRef>>;
    try {
      // B16 — the acceptance evals gate accept/reject on these samples, so
      // the locked test split must never be among them: bare refs (incl.
      // the ratings fallback) resolve train+dev only, and an explicit
      // #test ref is refused outright (mirrors `optimize`).
      refuseTestSplitRef("flywheel", registryRef);
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
    if (gateSplit !== undefined) {
      const split = record.splits[gateSplit] ?? [];
      if (split.length === 0) {
        die(
          `--gate-split ${gateSplit} — "${resolved.datasetName}" has no ${gateSplit} samples (the acceptance gate would score nothing)`,
        );
      }
      gateSamples = [...split];
      gateDatasetName = registryDatasetName(registryRef.name, resolved.version, gateSplit);
      gateDatasetHash = overallDatasetHash(record, [gateSplit]);
    }
  } else {
    const absDataset = resolve(data.dataset);
    const dataset = await loadDataset(absDataset);
    datasetName = dataset.name;
    datasetHash = hashDatasetFile(absDataset);
    for await (const s of dataset.samples) samples.push(s);
  }
  // D42 — a flat file has no split boundaries; refuse rather than silently
  // gating on everything under a flag that says otherwise.
  const gateRefusal = gateSplitRefusal({
    gateSplit,
    isRegistryRef: registryRef !== undefined,
    dataset: data.dataset,
  });
  if (gateRefusal !== undefined) die(gateRefusal);
  if (samples.length === 0) die(`dataset "${datasetName}" yielded zero samples`);
  const acceptanceSamples = gateSamples ?? samples;
  const acceptanceDatasetName = gateDatasetName ?? datasetName;
  const acceptanceDatasetHash = gateDatasetHash ?? datasetHash;
  if (gateSplit !== undefined) {
    process.stdout.write(
      `${formatGateSplitLine({
        gateSplit,
        datasetName: acceptanceDatasetName,
        sampleCount: acceptanceSamples.length,
      })}\n`,
    );
  }

  // Optimizer train/dev sets (mirrors `optimize`: registry splits when both
  // populated, else the deterministic inline 70/30 split).
  type OptimizerSample = { id: string; input: string; expected_output?: string };
  const toOptimizerSample = (s: Sample): OptimizerSample => ({
    id: s.id,
    input: s.input,
    ...(s.expected_output !== undefined ? { expected_output: s.expected_output } : {}),
  });
  // D42 — the map must cover the ACCEPTANCE corpus too: with an explicit
  // `#train` ref plus `--gate-split dev` the gated samples are not in
  // `samples`, and the post-accept regression pinning resolves recovered
  // sample ids through this map.
  const originalById = new Map([...samples, ...acceptanceSamples].map((s) => [s.id, s] as const));
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
      `[flywheel] ${label} eval: ${acceptanceSamples.length} samples → ${join(outRoot, label)}\n`,
    );
    const summary = await runEvalLib({
      ir: evalIr,
      dataset: { name: acceptanceDatasetName, samples: makeAsyncIterable(acceptanceSamples) },
      compiledGraders: compiled,
      opts: {
        // C33 — which CLI produced this run (reproducibility manifest).
        ...cliVersionOpt(),
        outDir: join(outRoot, label),
        concurrency: knobs.concurrency,
        seed: knobs.seed,
        datasetHash: acceptanceDatasetHash,
        retryErrors: true,
        ...(graderRegistry !== undefined ? { graderRegistry } : {}),
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
        // C33 — which CLI produced this run (reproducibility manifest).
        ...cliVersionOpt(),
        outDir: join(
          outRoot,
          "optimize",
          "evals",
          `${String(evalCallSeq).padStart(3, "0")}_${prompt.length}`,
        ),
        concurrency: knobs.concurrency,
        seed: knobs.seed,
        retryErrors: true,
        ...(graderRegistry !== undefined ? { graderRegistry } : {}),
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
    // G56 — partial credit when the runner emitted it (see the optimize
    // fitness fn): the acceptance GATE still compares pass rates, only the
    // search's candidate ranking gains the gradient.
    return { score: fitnessScore(summary.aggregates), grades, runDir: summary.outDir };
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
    // D42 — the report names what the VERDICT was measured on, which is the
    // acceptance view (`…#dev` under --gate-split), not the search corpus.
    datasetName: acceptanceDatasetName,
    sampleCount: acceptanceSamples.length,
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

/** Session ids under `.crewhaus/sessions`, newest first (by file mtime). */
function sessionIdsByRecency(sessionsDir: string): string[] {
  return listSessionIds(sessionsDir)
    .map((id) => {
      let mtime = 0;
      try {
        mtime = statSync(join(sessionsDir, `${id}.jsonl`)).mtimeMs;
      } catch {
        // A vanished file just sorts last.
      }
      return { id, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1))
    .map((e) => e.id);
}

/**
 * Item 6 — `crewhaus eval coverage`: build the production behavior
 * distribution from the cwd spec's session JSONLs, intersect it with what the
 * dataset (+ the most recent eval run for this spec) exercises, and print a
 * ranked backlog of gaps. Never mutates anything — a pure read-side report.
 */
async function runEvalCoverage(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus eval coverage [--sessions N|all] [--dataset <file|registry:ref>]\n" +
        "                              [--graders <graders.yaml>]\n" +
        "                              [-o <dir>] [--format text|html|json]\n" +
        "  Detect agent behaviors present in PRODUCTION sessions that no eval sample\n" +
        "  exercises (item 6). Builds a behavior distribution from the cwd spec's\n" +
        "  .crewhaus/sessions/*.jsonl — tool/MCP call frequencies (mcp__-prefixed =\n" +
        "  MCP), tool sequence bigrams, compaction frequency, clustered user inputs —\n" +
        "  and intersects it with the dataset's expected_tools plus the tools used in\n" +
        "  the most recent eval run for this spec (via the run-history index). Reports\n" +
        "  a ranked list of gaps: 'mcp__jira__CreateIssue appears in 31% of sessions\n" +
        "  but 0 dataset samples', 'compaction fired in N sessions, never in eval',\n" +
        "  prod tool sequences no expected_tools covers. --dataset defaults to the\n" +
        "  conventional eval/dataset.jsonl next to the cwd spec; a bare registry ref is\n" +
        "  inspected across ALL splits, the locked test split included (gap analysis is\n" +
        "  inspection, not consumption). --format json emits a ranked backlog consumable\n" +
        "  by `crewhaus dataset mine`.\n" +
        "  --graders (D44) adds the GRADER-side join: how many samples each grader can\n" +
        "  actually score (gold-needing graders vs gold-less samples, agreeing with\n" +
        "  `dataset lint`), which declared graders no recent run ever recorded, and which\n" +
        "  judge CRITERIA never varied across the last few runs' persisted grades — a\n" +
        "  dead criterion pays judge tokens on every sample and can never change a\n" +
        "  verdict. Omitting the flag leaves the report exactly as before.\n",
    );
    return;
  }

  let format: ReturnType<typeof parseCoverageFormat>;
  let sessionsWanted: number | "all";
  try {
    format = parseCoverageFormat(strFlag(args, "format"));
    sessionsWanted = parseSessionsFlag(strFlag(args, "sessions"));
  } catch (err) {
    if (err instanceof EvalCoverageError) die(err.message);
    throw err;
  }

  // The cwd spec identifies which sessions/runs belong to this harness.
  const cwdSpecPath = join(process.cwd(), "crewhaus.yaml");
  const cwdSpecText = existsSync(cwdSpecPath) ? readFileSync(cwdSpecPath, "utf-8") : undefined;
  let specName: string | undefined;
  if (cwdSpecText !== undefined) {
    try {
      specName = parseSpec(cwdSpecText).name;
    } catch {
      // Unparseable cwd spec — still report over every session/run.
    }
  }

  // ---- production behavior ----
  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const allIds = sessionIdsByRecency(sessionsDir);
  const ids = sessionsWanted === "all" ? allIds : allIds.slice(0, sessionsWanted);
  if (ids.length === 0) {
    die(
      `no sessions found under ${sessionsDir} — run the harness (crewhaus run) to accumulate production behavior first`,
    );
  }
  const sessions = ids.map((id) => ({ sessionId: id, events: readSessionEvents(id) }));
  const prod = buildProdBehavior(sessions);

  // ---- eval coverage: dataset expected_tools ----
  const datasetFlag = strFlag(args, "dataset");
  const datasetArg = datasetFlag ?? join("eval", "dataset.jsonl");
  const samples: Sample[] = [];
  let datasetName: string | undefined;
  let datasetResolved = false;
  try {
    const registryRef = parseRegistryRef(datasetArg);
    if (registryRef !== undefined) {
      const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
      // Inspection, not consumption (the `dataset audit` posture): gap
      // detection must stay split-complete — a behavior only the locked test
      // split exercises is NOT a gap — so a bare ref reads the whole record
      // (test included) instead of resolveRegistryRef's train+dev
      // consumption view. Nothing here runs or derives data from the samples.
      const inspected = await inspectRegistryRef(registry, registryRef);
      for (const s of inspected.samples) samples.push(s);
      datasetName = inspected.datasetName;
      datasetResolved = true;
    } else {
      const absDataset = resolve(datasetArg);
      if (existsSync(absDataset)) {
        const dataset = await loadDataset(absDataset);
        for await (const s of dataset.samples) samples.push(s);
        datasetName = dataset.name;
        datasetResolved = true;
      }
    }
  } catch (err) {
    // A missing/unreadable dataset is not fatal for a coverage report — we can
    // still report against the eval-run events and flag that no expected_tools
    // baseline was available. Registry/ref errors surface as a warning.
    if (err instanceof DatasetRefError || err instanceof CrewhausError) {
      process.stderr.write(`[coverage] dataset "${datasetArg}" unusable (${err.message})\n`);
    } else {
      throw err;
    }
  }
  if (!datasetResolved && datasetFlag !== undefined) {
    die(`--dataset "${datasetArg}" not found or unreadable`);
  }

  // ---- eval coverage: most recent eval run's per-sample tool usage ----
  const runEventTexts: string[] = [];
  const entries = readEvalRunIndex().filter(
    (e) => specName === undefined || e.specName === specName,
  );
  const latest = entries[entries.length - 1];
  if (latest !== undefined) {
    try {
      const run = await loadRun(latest.outDir);
      for (const sample of Object.values(run.perSample)) {
        if (sample.events.trim() !== "") runEventTexts.push(sample.events);
      }
    } catch {
      // A vanished/torn run dir just means no run-event coverage this pass.
    }
  }

  // ---- D44: grader coverage (only with --graders) ----
  const gradersFlag = strFlag(args, "graders");
  let graderCoverage: ReturnType<typeof computeGraderCoverage> | undefined;
  if (gradersFlag !== undefined) {
    const gradersPath = resolve(gradersFlag);
    let gradersYaml: string;
    try {
      gradersYaml = readFileSync(gradersPath, "utf-8");
    } catch (err) {
      die(`--graders "${gradersFlag}" not readable: ${(err as Error).message}`);
    }
    let graderSpecs: CoverageGraderSpec[];
    try {
      graderSpecs = parseGradersConfig(gradersYaml).config.graders.map((g) =>
        coverageGraderSpecOf(g as Parameters<typeof coverageGraderSpecOf>[0]),
      );
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    // The dead-criterion signal needs a WINDOW, not one run: read up to the
    // last N runs for this spec (most recent first), skipping any that
    // vanished or are torn.
    const windowEntries = entries.slice(-DEFAULT_COVERAGE_GRADER_RUNS).reverse();
    const runGrades: RunGradesText[] = [];
    for (const entry of windowEntries) {
      try {
        const run = await loadRun(entry.outDir);
        const byId: Record<string, string> = {};
        for (const [id, artifacts] of Object.entries(run.perSample)) byId[id] = artifacts.grades;
        runGrades.push(byId);
      } catch {
        // A vanished/torn run dir contributes nothing; the window shrinks.
      }
    }
    graderCoverage = computeGraderCoverage({
      graders: graderSpecs,
      samples,
      runs: runGrades,
      gradersFile: gradersFlag,
      // One source of truth with `dataset lint`: the SAME gold-needing
      // predicate, so the two surfaces can never disagree about which
      // graders require an expected_output.
      needsGold: (g) =>
        graderNeedsGold({
          name: g.name,
          type: g.type,
          ...(g.registryGrader !== undefined ? { registryGrader: g.registryGrader } : {}),
          ...(g.hasReferenceOverride === true ? { hasReferenceOverride: true } : {}),
        }),
    });
  }

  const evalCov = buildEvalCoverage(samples, runEventTexts);
  const report = computeCoverage({
    prod,
    evalCov,
    ...(specName !== undefined ? { specName } : {}),
    ...(datasetName !== undefined ? { datasetName } : {}),
    ...(graderCoverage !== undefined ? { graderCoverage } : {}),
  });

  const rendered = renderCoverage(report, format);
  const outDir = strFlag(args, "out");
  if (outDir !== undefined) {
    mkdirSync(resolve(outDir), { recursive: true });
    const outPath = join(resolve(outDir), coverageFileName(format));
    writeFileSync(outPath, rendered);
    process.stdout.write(
      `[coverage] ${report.gaps.length} gap(s) across ${report.sessionsScanned} session(s) → ${outPath}\n`,
    );
  } else {
    process.stdout.write(rendered);
  }
}

/**
 * D46 — build the content graders for `eval --voice --graders <g.yaml>` from
 * the ordinary graders config: deterministic graders as-is, `llm_judge`
 * rubrics bound to a real judge (scalar or categorical), `type: registry`
 * entries resolved against the default registry with their `opts:`. One
 * construction path with the text eval, so a rubric that works there works
 * here — including the credential requirement, which surfaces as the judge's
 * own error on the first graded session.
 *
 * A4/A5 — the file's top-level `combine:` policy and per-grader `weight`
 * come back with the graders: the voice path APPLIES the policy (see
 * `combineVoiceContentGrades`) and warns about unconsumed weights /
 * passing_threshold through the same `warnUnconsumedCombinePolicy` the
 * runner and exam surfaces call. A surface that parses the grammar and
 * ignores half of it is the trust hole A4/A5 exist to close.
 */
async function buildVoiceContentGraders(gradersPath: string): Promise<{
  graders: Array<{ name: string; grader: Grader; weight?: number }>;
  combine: GraderCombinePolicy | undefined;
}> {
  let compiled: ReadonlyArray<CompiledGrader>;
  try {
    compiled = parseGradersConfig(readFileSync(resolve(gradersPath), "utf-8")).compiled;
  } catch (err) {
    die(`--graders "${gradersPath}" unusable: ${err instanceof Error ? err.message : String(err)}`);
  }
  warnUnconsumedCombinePolicy(compiled);
  const combine = compiled.find((g) => g.combine !== undefined)?.combine;
  const registry = await graderRegistryForCompiled(compiled);
  const built: Array<{ name: string; grader: Grader; weight?: number }> = [];
  for (const g of compiled) {
    if (g.judgeSpec !== undefined) {
      const spec = g.judgeSpec;
      const rubric =
        spec.rubric.kind === "categorical"
          ? loadCategoricalRubric(spec.rubric)
          : loadRubric(spec.rubric);
      built.push({
        name: g.name,
        weight: g.weight,
        grader: createJudgeGrader(rubric, {
          ...(spec.model !== undefined ? { model: spec.model } : {}),
          ...(spec.judges !== undefined ? { judges: spec.judges } : {}),
          ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
          ...(spec.repeats !== undefined ? { repeats: spec.repeats } : {}),
          ...(spec.target !== undefined ? { target: spec.target } : {}),
        }),
      });
      continue;
    }
    if (g.registrySpec !== undefined) {
      if (registry === undefined) {
        die(`--graders "${gradersPath}": grader "${g.name}" needs a grader registry`);
      }
      built.push({
        name: g.name,
        weight: g.weight,
        grader: resolveRegistryGrader(registry, g.name, g.registrySpec),
      });
      continue;
    }
    built.push({ name: g.name, grader: g.grader, weight: g.weight });
  }
  return { graders: built, ...(combine !== undefined ? { combine } : { combine: undefined }) };
}

/**
 * Item 65 — `crewhaus eval --voice`: replay recorded call-session logs through
 * the voice grader pack (latency / barge-in / transcript). Reads every
 * `*.jsonl` under --replay-dir (default `.crewhaus/voice-replays`), grades each
 * against the latency budgets, renders a report, and writes a machine-readable
 * `voice-eval.json`. Exits non-zero when any session fails a grader (a
 * pre-deploy voice gate). Credential-free + deterministic — no live audio.
 *
 * D46 — with `--graders <g.yaml>` the replayed transcripts are ALSO scored by
 * the ordinary grader stack (content grading); a content failure fails the
 * session exactly like a latency breach. Judge-backed rubrics need judge
 * credentials — that is the one thing `--graders` gives up on the otherwise
 * credential-free voice path.
 */
async function runVoiceEval(args: ParsedArgs): Promise<void> {
  const replayDir = resolve(strFlag(args, "replay-dir") ?? join(".crewhaus", "voice-replays"));
  if (!existsSync(replayDir)) {
    die(
      `voice replay dir not found at ${replayDir} — record call sessions there (one <sessionId>.jsonl per call), or pass --replay-dir`,
    );
  }
  const files = readdirSync(replayDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) {
    die(`no *.jsonl replay logs under ${replayDir}`);
  }
  const thresholds: VoiceThresholds = {
    maxTtftMs: intFlag(args, "max-ttft-ms") ?? DEFAULT_VOICE_THRESHOLDS.maxTtftMs,
    maxTurnLatencyMs:
      intFlag(args, "max-turn-latency-ms") ?? DEFAULT_VOICE_THRESHOLDS.maxTurnLatencyMs,
    maxBargeInYieldMs:
      intFlag(args, "max-barge-in-yield-ms") ?? DEFAULT_VOICE_THRESHOLDS.maxBargeInYieldMs,
  };
  // D46 — optional CONTENT grading: the same graders.yaml a text eval uses,
  // applied to each replayed transcript. Built ONCE (registry packs and judge
  // graders are per-run instruments, not per-session), and only when the flag
  // is present — without it the voice eval is byte-identical to before.
  const gradersFlag = strFlag(args, "graders");
  const content =
    gradersFlag !== undefined
      ? await buildVoiceContentGraders(gradersFlag)
      : { graders: [], combine: undefined };
  const contentGraders = content.graders;
  if (contentGraders.length > 0) {
    // A4/A5 — say which policy is in force: `all` is the default, and a
    // non-default one changes what "the session passed" MEANS.
    const mode = content.combine?.mode ?? "all";
    process.stdout.write(
      `[voice-eval] content graders (combine: ${mode}): ${contentGraders.map((g) => g.name).join(", ")}\n`,
    );
  }

  const results: VoiceSessionResult[] = [];
  for (const f of files) {
    const sessionId = f.slice(0, -".jsonl".length);
    const jsonl = readFileSync(join(replayDir, f), "utf-8");
    let result: VoiceSessionResult;
    try {
      result = await gradeVoiceSessionWithContent(
        parseReplayLog(sessionId, jsonl),
        thresholds,
        contentGraders,
        content.combine !== undefined ? { combine: content.combine } : {},
      );
    } catch (err) {
      if (err instanceof VoiceEvalError) die(err.message);
      throw err;
    }
    results.push(result);
  }
  const summary = aggregateVoiceEval(results);
  process.stdout.write(renderVoiceReport(summary));

  const outDir = resolve(strFlag(args, "out") ?? join(".crewhaus", "evals", "voice"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "voice-eval.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`[voice-eval] wrote ${join(outDir, "voice-eval.json")}\n`);

  const failed = results.filter((r) => !r.passed).length;
  if (failed > 0) process.exit(1);
}

/**
 * C28 — `crewhaus eval plan --target-delta F [--confidence C] [--pilot <runDir>]`.
 * Offline arithmetic that PRINTS its own working: which z, which p and where
 * it came from, which e, and the substituted formula — so the number teaches
 * instead of just asserting.
 */
function runEvalPlanCmd(args: ParsedArgs): void {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus eval plan --target-delta F [--confidence C] [--pilot <runDir>]\n" +
        "  Sample-size planning: how many samples does a dataset need to DETECT the\n" +
        "  regression you care about? n ≈ z²·p(1−p)/e², printed with every term and its\n" +
        "  source (report §9's metric literacy — gating a release on n=8 cannot see a\n" +
        "  5-point drop, and this says so before you spend).\n" +
        "  --target-delta F  the smallest pass-rate change worth detecting, as a FRACTION\n" +
        "                    (0.05 = 5 percentage points). Required.\n" +
        "  --confidence C    two-sided confidence level (default 0.95).\n" +
        "  NOTE: n ≈ z²·p(1−p)/e² sizes an ESTIMATE's half-width, not a hypothesis test's\n" +
        "  POWER (there is no z_β term) — at that n a true delta of e is detected only\n" +
        "  about half the time. The output prints the ~80%-power figure alongside it.\n" +
        "  --pilot <runDir>  seed p from a previous run's measured pass rate (its\n" +
        "                    results.json); without it p = 0.5, the variance-maximizing\n" +
        "                    worst case, which deliberately OVER-estimates n. With a pilot\n" +
        "                    the output also reports the smallest delta that run's own n\n" +
        "                    could have resolved.\n" +
        "  Offline: no model call, no credentials, no spend, nothing written.\n",
    );
    return;
  }
  const deltaFlag = strFlag(args, "target-delta");
  if (deltaFlag === undefined) {
    die("eval plan: --target-delta F is required (0.05 = detect a 5 percentage-point change)");
  }
  const targetDelta = Number.parseFloat(deltaFlag as string);
  const confidenceFlag = strFlag(args, "confidence");
  const confidence = confidenceFlag !== undefined ? Number.parseFloat(confidenceFlag) : undefined;
  if (confidenceFlag !== undefined && !Number.isFinite(confidence as number)) {
    die(`eval plan: --confidence must be a number (got "${confidenceFlag}")`);
  }
  const pilot = strFlag(args, "pilot");
  try {
    const plan = planSampleSize({
      targetDelta,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(pilot !== undefined ? { pilotRunDir: resolve(pilot) } : {}),
    });
    process.stdout.write(renderEvalPlan(plan));
  } catch (err) {
    if (err instanceof EvalPlanError) die(err.message);
    throw err;
  }
}

/**
 * D41 — `crewhaus schedule generate --for flywheel|eval-gate|sentinel
 * [--runner cron|launchd|systemd]`. Prints ready-to-install scheduling text
 * wrapping the matching `crewhaus` command; installs nothing, writes nothing.
 * The GitHub scaffolds (`init --ci`, `init --sentinel`, `flywheel init`) are
 * unchanged — this is the off-GitHub sibling.
 */
function runScheduleGenerate(args: ParsedArgs): void {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus schedule generate --for flywheel|eval-gate|sentinel\n" +
        "                                 [--runner cron|launchd|systemd] [--dir <path>]\n" +
        "                                 [--spec <f>] [--dataset <d>] [--graders <g>] [--baseline <dir>]\n" +
        "  Recurring eval automation for teams NOT on GitHub Actions: prints a crontab\n" +
        "  line, a launchd plist, or a systemd service+timer pair wrapping the same\n" +
        "  command the corresponding workflow runs —\n" +
        "    flywheel   → crewhaus flywheel run            (nightly 07:13)\n" +
        "    eval-gate  → crewhaus eval … --gate           (nightly 05:23)\n" +
        "    sentinel   → crewhaus eval … --sentinel …     (nightly 03:17)\n" +
        "  A SHIM, not a daemon: nothing is installed, scheduled, or written — you review\n" +
        "  the text and install it yourself. The scheduler's own failure reporting is the\n" +
        "  alert, because the wrapped commands exit non-zero on regression/drift.\n" +
        "  --dir defaults to the current directory (the scheduled command cd's there).\n" +
        "  eval-gate/sentinel spell their paths out: --spec/--dataset/--graders default\n" +
        "  to crewhaus.yaml, eval/dataset.jsonl, eval/graders.yaml (and --baseline to\n" +
        "  eval/sentinel-baseline, sentinel ONLY — it is warned about and ignored on the\n" +
        "  other targets). The flywheel command resolves those same conventional paths\n" +
        "  itself, so they are emitted there only when you pass them explicitly.\n" +
        "  The GitHub scaffolds are unchanged: see `crewhaus init --ci|--sentinel` and\n" +
        "  `crewhaus flywheel init` when you ARE on GitHub Actions.\n",
    );
    return;
  }
  try {
    const target = parseScheduleTarget(strFlag(args, "for"));
    const runner = parseScheduleRunner(strFlag(args, "runner"));
    const dir = resolve(strFlag(args, "dir") ?? process.cwd());
    const spec = strFlag(args, "spec");
    const dataset = strFlag(args, "dataset");
    const graders = strFlag(args, "graders");
    const baseline = strFlag(args, "baseline");
    const generated = buildSchedule({
      target,
      runner,
      dir,
      ...(spec !== undefined ? { spec } : {}),
      ...(dataset !== undefined ? { dataset } : {}),
      ...(graders !== undefined ? { graders } : {}),
      ...(baseline !== undefined ? { baseline } : {}),
    });
    // A path flag the chosen target cannot consume is announced, never
    // silently dropped — the same doctrine as the `[eval-report] warning:
    // --X only applies to …` lines.
    for (const warning of generated.job.warnings) {
      process.stderr.write(`[schedule] warning: ${warning}\n`);
    }
    process.stdout.write(renderSchedule(generated));
  } catch (err) {
    if (err instanceof ScheduleGenerateError) die(err.message);
    throw err;
  }
}

/**
 * NEW-HUNT-8 — the one seam a SUITE needs from the single-run path: a suite
 * must report every entry's verdict, so it takes a failing `--gate` as a
 * value instead of letting it exit the process mid-tier. Absent (every
 * hand-typed invocation) → `die()`, exactly as before.
 */
type EvalRunHooks = {
  readonly onGateFailure?: (reason: string) => void;
};

async function runEvalSubcommand(args: ParsedArgs, hooks: EvalRunHooks = {}): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(EVAL_USAGE);
    return;
  }
  // Item 65 — voice replay eval branches off before the text-eval flags: it
  // reads recorded call-session JSONLs, not a dataset/graders.yaml.
  if (args.flags["voice"] === true) {
    // D44 posture — a flag the branch cannot honour must DIE, never be
    // silently accepted. `--voice` already replays recorded sessions (there
    // is no live agent to record tools from, and no run directory to resume),
    // and since D46 taught it to honour the shared `--graders`, "shared flags
    // are ignored under --voice" is no longer a rule a reader could infer.
    for (const flag of ["record-tools", "replay-tools", "replay-miss", "resume"] as const) {
      if (args.flags[flag] !== undefined) {
        die(
          `--voice does not support --${flag}: --voice replays recorded call sessions, so the tool cassette (--record-tools/--replay-tools/--replay-miss) and --resume apply to text evals only`,
        );
      }
    }
    await runVoiceEval(args);
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

  // Item 30 — model-drift sentinel. --baseline points at the frozen run dir to
  // diff against; incompatible with lineage/matrix flags (a sentinel is a
  // one-off provider-drift probe, not run-history or a model benchmark).
  const sentinel = args.flags["sentinel"] === true;
  const sentinelBaseline = args.flags["baseline"];
  if (sentinel) {
    if (typeof sentinelBaseline !== "string") {
      die("--sentinel requires --baseline <run-dir> (the frozen baseline run to diff against)");
    }
    if (gateRequested)
      die("--sentinel and --gate are mutually exclusive (sentinel has its own gate)");
    if (args.flags["no-promote"] === true) {
      die("--sentinel never promotes; drop --no-promote");
    }
    if (typeof args.flags["models"] === "string") {
      die("--sentinel and --models are mutually exclusive");
    }
  } else if (typeof sentinelBaseline === "string") {
    die("--baseline is only valid with --sentinel");
  }

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
  // G15 — trials per sample. Validated strictly here ("3.5"/"3x" die rather
  // than silently truncate) so a bad value is loud BEFORE any dataset load or
  // spend, mirroring the runner's own integer>=1 guard.
  const repeatsFlag = args.flags["repeats"];
  const repeats = typeof repeatsFlag === "string" ? Number.parseInt(repeatsFlag, 10) : undefined;
  if (
    repeats !== undefined &&
    (Number.isNaN(repeats) || repeats < 1 || String(repeats) !== (repeatsFlag as string).trim())
  ) {
    die(`invalid --repeats "${repeatsFlag}" — must be a positive integer`);
  }
  // B13 — slice keys, comma-separated. Blank segments die loudly here
  // (mirroring the runner's own guard) rather than silently slicing nothing.
  const sliceFlag = args.flags["slice"];
  let sliceKeys: string[] | undefined;
  if (typeof sliceFlag === "string") {
    sliceKeys = sliceFlag.split(",").map((k) => k.trim());
    if (sliceKeys.length === 0 || sliceKeys.some((k) => k === "")) {
      die(
        `invalid --slice "${sliceFlag}" — comma-separated non-empty metadata keys, e.g. family,difficulty`,
      );
    }
  }

  // C30 — pre-declared gate thresholds, validated up front like canary's
  // identically-named flags (a typo must die before any spend).
  const maxP95Flag = args.flags["max-p95-latency-ms"];
  let maxP95LatencyMs: number | undefined;
  if (typeof maxP95Flag === "string") {
    const v = Number(maxP95Flag);
    if (!Number.isFinite(v) || v < 0) {
      die(`invalid --max-p95-latency-ms "${maxP95Flag}" — must be a non-negative number of ms`);
    }
    maxP95LatencyMs = v;
  }
  const maxCostFlag = args.flags["max-cost-usd"];
  let maxCostUsd: number | undefined;
  if (typeof maxCostFlag === "string") {
    const v = Number(maxCostFlag);
    if (!Number.isFinite(v) || v < 0) {
      die(`invalid --max-cost-usd "${maxCostFlag}" — must be a non-negative dollar amount`);
    }
    maxCostUsd = v;
  }
  // The thresholds are criteria of the (spec, dataset) baseline gate, which
  // sentinel probes and matrix cells deliberately skip — reject the combos
  // instead of silently ignoring the flags (assertMatrixFlagsCompatible's
  // posture for --gate/--no-promote).
  if (sentinel && (maxP95LatencyMs !== undefined || maxCostUsd !== undefined)) {
    die(
      "--sentinel has its own drift gate — --max-p95-latency-ms/--max-cost-usd apply only to the baseline regression gate",
    );
  }
  if (matrixModels !== undefined && (maxP95LatencyMs !== undefined || maxCostUsd !== undefined)) {
    die(
      "--models is incompatible with --max-p95-latency-ms/--max-cost-usd — matrix cells skip the (spec, dataset) baseline gate",
    );
  }

  // NEW-HUNT-3 — per-sample timeout + run budget overrides (flag > spec
  // limits.deadline_ms / budget.usd; the runner re-validates, but dying
  // here keeps a bad value loud BEFORE any dataset load, like --repeats).
  const sampleTimeoutFlag = args.flags["sample-timeout-ms"];
  let sampleTimeoutMs: number | undefined;
  if (typeof sampleTimeoutFlag === "string") {
    sampleTimeoutMs = Number.parseInt(sampleTimeoutFlag, 10);
    if (
      Number.isNaN(sampleTimeoutMs) ||
      sampleTimeoutMs < 1 ||
      String(sampleTimeoutMs) !== sampleTimeoutFlag.trim()
    ) {
      die(`invalid --sample-timeout-ms "${sampleTimeoutFlag}" — must be a positive integer`);
    }
  }
  const budgetUsdFlag = args.flags["budget-usd"];
  let budgetUsd: number | undefined;
  if (typeof budgetUsdFlag === "string") {
    budgetUsd = Number(budgetUsdFlag);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      die(`invalid --budget-usd "${budgetUsdFlag}" — must be a positive dollar amount`);
    }
  }

  // NEW-HUNT-4 — tool record/replay. Record and replay are two directions of
  // one seam; --replay-miss without a replay would be silently dead config.
  // Validated here so a bad combo dies BEFORE any dataset load or spend.
  const recordToolsFlag = args.flags["record-tools"];
  const replayToolsFlag = args.flags["replay-tools"];
  const replayMissFlag = args.flags["replay-miss"];
  if (typeof recordToolsFlag === "string" && typeof replayToolsFlag === "string") {
    die("--record-tools and --replay-tools are mutually exclusive — record a run, then replay it");
  }
  if (typeof replayMissFlag === "string" && typeof replayToolsFlag !== "string") {
    die("--replay-miss is only valid with --replay-tools");
  }
  if (
    typeof replayMissFlag === "string" &&
    replayMissFlag !== "error" &&
    replayMissFlag !== "live"
  ) {
    die(`invalid --replay-miss "${replayMissFlag}" — must be "error" or "live"`);
  }
  const recordToolsDir = typeof recordToolsFlag === "string" ? resolve(recordToolsFlag) : undefined;
  const replayToolsDir = typeof replayToolsFlag === "string" ? resolve(replayToolsFlag) : undefined;
  const replayMiss = replayMissFlag === "live" ? ("live" as const) : undefined;

  // NEW-HUNT-6 — `--resume <runDir>`: the run directory IS the output, so -o
  // would be ambiguous, and a matrix has N cell directories rather than one.
  const resumeFlag = args.flags["resume"];
  let resumeDir: string | undefined;
  if (typeof resumeFlag === "string") {
    if (resumeFlag.trim() === "") die("--resume requires a run directory");
    resumeDir = resolve(resumeFlag);
    if (typeof outDirArg === "string") {
      die("--resume and -o are mutually exclusive — the resumed run directory is the output");
    }
    if (matrixModels !== undefined) {
      die("--resume and --models are mutually exclusive — matrix cells have their own run dirs");
    }
    if (!existsSync(join(resumeDir, "run.json"))) {
      die(
        `--resume: ${resumeDir} is not an eval run directory (no run.json — every run writes one before its first sample)`,
      );
    }
  }
  if (
    matrixModels !== undefined &&
    (recordToolsDir !== undefined || replayToolsDir !== undefined)
  ) {
    die(
      "--models is incompatible with --record-tools/--replay-tools — matrix cells share sample ids, so one recording cannot address N cells",
    );
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
  // Hangar F-1 — the spec resolved: self-register the cwd (the harness root
  // per the standalone-harness convention) in the machine-wide registry.
  // Never throws; CREWHAUS_NO_REGISTRY=1 opts out.
  registerHarnessCwd({ specName: ir.name, target: ir.target, originDetail: "eval" });
  if (ir.target !== "cli") {
    die(`crewhaus eval only supports target: cli (got "${ir.target}")`);
  }

  let gradersYaml: string;
  try {
    gradersYaml = readFileSync(resolve(gradersPath), "utf-8");
  } catch (err) {
    die(`could not read ${gradersPath}: ${(err as Error).message}`);
  }
  const { compiled, config: gradersConfig } = parseGradersConfig(gradersYaml);
  // F2 — sha256 of the parsed graders config, recorded into run.json/
  // results.json so `--sentinel` can assert a fresh run graded with the same
  // rubric/thresholds as the baseline (see hashGradersConfig doc comment).
  const gradersHash = hashGradersConfig(gradersConfig);
  // G14 — graders that resolve by registry name get the default registry
  // (the specialty packs + .crewhaus/graders plugins), constructed ONCE here
  // and shared with every matrix cell; `runEval` has the identical fallback,
  // so the vocabulary cannot differ between the CLI and library paths.
  const graderRegistry = await graderRegistryForCompiled(compiled);

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
      // B16 — bare refs resolve train+dev only; an explicit #test needs the
      // --allow-test-split opt-in (the CLI face of the registry's
      // test-split lock — spend the holdout at release-gate time only).
      resolved = await resolveRegistryRef(registry, registryRef, {
        allowTestSplit: args.flags["allow-test-split"] === true,
      });
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

  // NEW-HUNT-10 — pre-spend preflight lint-lite: duplicate sample ids (the
  // run's own per-sample artifact dirs would collide and the baseline
  // gate's flip detection would corrupt) and the grader↔dataset gold
  // mismatch (gold-needing graders over an entirely gold-less dataset =
  // all-fail-by-construction). Runs BEFORE the regression union and any
  // model call, on (id, hasGold) pairs only; the file path streams one
  // preflight pass and re-opens the loader so the run itself still
  // streams. `--no-preflight` skips (byte-identical single load).
  if (args.flags["no-preflight"] !== true) {
    const pfSamples: Array<{ id: string; hasGold: boolean; isCanary: boolean }> = [];
    for await (const s of dataset.samples) {
      pfSamples.push({
        id: s.id,
        hasGold: s.expected_output !== undefined && s.expected_output.trim() !== "",
        isCanary: s.metadata?.["source"] === "canary",
      });
    }
    const pf = preflightLint(pfSamples, gradersConfig.graders.map(lintGraderSpecOf));
    for (const w of pf.warnings) process.stderr.write(`${w}\n`);
    if (pf.refusals.length > 0) {
      die(
        `[eval] preflight refused before any model spend:\n  - ${pf.refusals.join("\n  - ")}\nfix the dataset (see \`crewhaus dataset lint\`) or re-run with --no-preflight to override`,
      );
    }
    // The preflight consumed one iteration. Registry refs are re-iterable
    // (makeAsyncIterable yields a fresh generator per iteration); the
    // file/http loader is a one-shot stream, so re-open it for the run.
    if (registryRef === undefined) {
      dataset = { name: dataset.name, samples: (await loadDataset(resolve(datasetPath))).samples };
    }
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
      // Item 30 — a sentinel requires a byte-identical dataset to attribute a
      // diff to the provider; unioning the regression suite would fold its
      // hash in and defeat the dataset-hash equality check. Force it off.
      includeRegressions: !sentinel && args.flags["no-regressions"] !== true,
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
      ...(repeats !== undefined ? { repeats } : {}),
      ...(sliceKeys !== undefined ? { sliceKeys } : {}),
      ...(graderRegistry !== undefined ? { graderRegistry } : {}),
      ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
      ...(sampleTimeoutMs !== undefined ? { sampleTimeoutMs } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    });
  }

  // Item 7 — tee the samples flowing into the runner so post-eval triage can
  // join each failing SampleResult back to its dataset Sample (reference +
  // metadata) and pin bug-class samples as they live in the source dataset.
  const triageSamplesById = new Map<string, Sample>();
  dataset = { name: dataset.name, samples: tapSamples(dataset.samples, triageSamplesById) };

  const outDest =
    resumeDir ??
    (typeof outDirArg === "string" ? resolve(outDirArg) : join(".crewhaus", "evals", "<runId>"));
  process.stdout.write(`[eval] running ${dataset.name}: ${compiled.length} graders → ${outDest}\n`);
  if (resumeDir !== undefined) {
    process.stdout.write(`[eval] resuming run at ${resumeDir}\n`);
  }
  if (recordToolsDir !== undefined) {
    process.stdout.write(`[eval] recording tool results → ${recordToolsDir}\n`);
  }
  if (replayToolsDir !== undefined) {
    process.stdout.write(
      `[eval] replaying tool results from ${replayToolsDir} (miss: ${replayMiss ?? "error"})\n`,
    );
  }

  // NEW-HUNT-4/6 — the cassette and resume refusals (missing recording,
  // moved specHash/datasetHash/gradersHash) are USER-facing config errors:
  // render them as a clean `crewhaus:` failure instead of a stack trace. The
  // catch is scoped to runs that actually used the new flags, so every other
  // error path stays exactly as it was.
  const cassetteOrResume =
    resumeDir !== undefined || recordToolsDir !== undefined || replayToolsDir !== undefined;
  const summary = await runEvalLib({
    ir,
    dataset,
    compiledGraders: compiled,
    opts: {
      // C33 — which CLI produced this run (reproducibility manifest).
      ...cliVersionOpt(),
      // NEW-HUNT-6 — a resume writes into the run directory it re-opened;
      // -o is refused alongside it, so the two can never disagree.
      ...(resumeDir !== undefined
        ? { outDir: resumeDir, resume: true }
        : typeof outDirArg === "string"
          ? { outDir: resolve(outDirArg) }
          : {}),
      // NEW-HUNT-4 — the tool cassette (record XOR replay; validated above).
      ...(recordToolsDir !== undefined ? { recordToolsDir } : {}),
      ...(replayToolsDir !== undefined ? { replayToolsDir } : {}),
      ...(replayMiss !== undefined ? { replayMiss } : {}),
      datasetHash,
      gradersHash,
      retryErrors,
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(repeats !== undefined ? { repeats } : {}),
      ...(sliceKeys !== undefined ? { sliceKeys } : {}),
      ...(graderRegistry !== undefined ? { graderRegistry } : {}),
      ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
      // NEW-HUNT-3 — spec limits./budget. overrides + the pricing seam the
      // runner meters --budget-usd/budget.usd through (the same lookup that
      // prices the --models est_$ column).
      ...(sampleTimeoutMs !== undefined ? { sampleTimeoutMs } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      pricing: defaultMatrixPricing(),
    },
  }).catch((err: unknown) => {
    if (cassetteOrResume && err instanceof CrewhausError) die(err.message);
    throw err;
  });
  // With -o omitted the runner picks .crewhaus/evals/<runId> relative to the
  // cwd — resolve to an absolute path for the report + history index.
  const absOut = resolve(summary.outDir);

  // NEW-HUNT-6 — say what the resume actually saved (and under which runId,
  // since the history entry supersedes the interrupted run's rather than
  // adding a second one).
  if (summary.resumed !== undefined) {
    const r = summary.resumed;
    process.stdout.write(
      `[eval] resume: reused ${r.reusedSamples}/${r.reusedSamples + r.ranSamples} graded sample(s), ` +
        `ran ${r.ranSamples} — run ${summary.runId}\n`,
    );
  }

  // Item 30 — sentinel drift probe. Skip triage + run-history entirely (a
  // sentinel is a one-off provider-drift check, not lineage): render the
  // report, then diff the fresh run against the frozen baseline and attribute
  // any flip/score-shift to the provider ONLY when specHash, dataset-hash,
  // judgeModel, AND gradersHash are all unchanged (F2). Exit non-zero on
  // drift OR not-comparable.
  if (sentinel) {
    const loadedSentinel = await loadRun(absOut);
    writeFileSync(join(absOut, "index.html"), renderReport(loadedSentinel, {}).html);
    let baselineRun: Awaited<ReturnType<typeof loadRun>>;
    try {
      baselineRun = await loadRun(resolve(sentinelBaseline as string));
    } catch (err) {
      die(
        `--sentinel: could not load baseline run at ${sentinelBaseline}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const baselineDatasetHash = baselineRun.summary.config.datasetHash;
    if (baselineDatasetHash === undefined) {
      die(
        `--sentinel: baseline run ${baselineRun.summary.runId} has no recorded datasetHash — re-pin the baseline from a run produced by a datasetHash-recording CLI (any current version)`,
      );
    }
    const result = evaluateSentinel({
      baseline: baselineRun,
      current: loadedSentinel,
      baselineDatasetHash,
      currentDatasetHash: datasetHash,
    });
    // Same output block as a normal run (Batch B: partial_score / loop
    // metrics / repeats / failure classes / calibration notes) — a sentinel
    // is still a run someone reads.
    const sentinelRetried = summary.samples.filter((s) => s.retried === true).length;
    for (const line of evalRunOutputLines(summary, {
      retriedCount: sentinelRetried,
      pricing: defaultMatrixPricing(),
    })) {
      process.stdout.write(`${line}\n`);
    }
    if (summary.partial !== undefined) {
      process.stdout.write(
        `[eval] budget exhausted after ${summary.partial.completedSamples}/${summary.partial.totalSamples} samples — remaining samples recorded as errors; results.json marked partial\n`,
      );
    }
    process.stdout.write(`[eval] report: ${join(absOut, "index.html")}\n`);
    process.stdout.write(`[sentinel] ${result.verdict}: ${result.reason}\n`);
    if (result.alert) {
      // Alerting verdicts exit non-zero either way, but the reason must be
      // honest: a not-comparable probe (changed instrument, budget-partial
      // run) is NOT evidence the provider drifted.
      die(
        result.verdict === "drift"
          ? `sentinel drift detected — ${result.reason}`
          : `sentinel not comparable — ${result.reason}`,
      );
    }
    return;
  }

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
  // Batch B: the classic summary line plus the presence-gated partial_score /
  // loop-metrics / pass@k–pass^k / failure-class / judge-calibration lines
  // (see eval-output.ts — each prints only when the run carries the data).
  const retriedCount = summary.samples.filter((s) => s.retried === true).length;
  for (const line of evalRunOutputLines(summary, {
    retriedCount,
    // C35 — the cost line: agent spend as before, plus the newly metered
    // judge spend, through the same pricing table as the matrix est_$ column.
    pricing: defaultMatrixPricing(),
  })) {
    process.stdout.write(`${line}\n`);
  }
  if (summary.partial !== undefined) {
    process.stdout.write(
      `[eval] budget exhausted after ${summary.partial.completedSamples}/${summary.partial.totalSamples} samples — remaining samples recorded as errors; results.json marked partial\n`,
    );
  }
  process.stdout.write(`[eval] report: ${join(absOut, "index.html")}\n`);

  // B20 — feed the persistent review queue: judge-abstained samples
  // (needs_human, A3) and panel-entropy flags (needs_review, A2) become open
  // review items keyed on (runId, sampleId), so they outlive the stdout
  // listing. Entries carry a clipped input excerpt from the triage tap as
  // display context. Additive + best-effort by construction — a queue-write
  // failure must never fail the eval run.
  try {
    const a = summary.aggregates;
    const reviewEntries = entriesFromEvalRun({
      runId: summary.runId,
      ...(a.needsHumanSampleIds !== undefined
        ? { needsHumanSampleIds: a.needsHumanSampleIds }
        : {}),
      ...(a.needsReviewSampleIds !== undefined
        ? { needsReviewSampleIds: a.needsReviewSampleIds }
        : {}),
      contextForSample: (sampleId) => {
        const input = triageSamplesById.get(sampleId)?.input;
        return input !== undefined ? clipText(input, 160) : undefined;
      },
      ts: new Date().toISOString(),
    });
    if (reviewEntries.length > 0) {
      const q = enqueueReviewEntries(process.cwd(), reviewEntries);
      if (q.added > 0) {
        process.stdout.write(
          `[eval] review queue: ${q.added} item(s) enqueued — \`crewhaus review next\`\n`,
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      `[eval] review queue skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // C30 × C35 — this run's estimated cost, through the SAME pricing seam as
  // the --models est_$ column (cost-tracker table keyed by the model-router
  // grammar) AND the same `evalRunCost` helper that builds the printed
  // `[eval] cost:` line. Agent tokens use the all-trials totals when
  // --repeats ran — the real spend.
  //
  // `costUsd` is the TOTAL (agent + judge). Metering judge spend was C35's
  // whole point: gating the agent half alone let a judge-heavy run print
  // `total=$4.10` and still pass `--max-cost-usd 2.00`, and pinned $1.80 in
  // history forever. The halves are recorded separately too, so `eval-report
  // trends` can still tell agent spend from grading spend.
  //
  // A pricing miss anywhere (agent model or ANY judge model) leaves the
  // total undefined — the cost gate then warns instead of failing on an
  // undercount nobody can verify.
  const cost = evalRunCost(summary, defaultMatrixPricing());
  const costUsd = cost.totalMicros !== undefined ? cost.totalMicros / 1_000_000 : undefined;
  const agentCostUsd = cost.agentMicros !== undefined ? cost.agentMicros / 1_000_000 : undefined;
  const judgeCostUsd = cost.judgeMicros !== undefined ? cost.judgeMicros / 1_000_000 : undefined;

  // E51 — offline eval results reach the configured exporters. Presence-gated
  // on OTEL_EXPORTER_OTLP_ENDPOINT / CREWHAUS_METRICS: unset ⇒ `undefined`, no
  // run context, no bus, no subscriber, zero overhead. Placed BEFORE the gate
  // so a failing gate still exports the run that failed it (that is precisely
  // the run an operator wants on the dashboard), and every call inside is
  // wrapped so a broken collector can never fail a measurement.
  const telemetry = await attachEvalTelemetry();
  if (telemetry !== undefined) {
    telemetry.publishSampleVerdicts(summary);
    telemetry.recordRunSummary(
      evalRunSummaryMetrics(summary, {
        specName: ir.name,
        ...(costUsd !== undefined ? { costUsd } : {}),
      }),
    );
    await telemetry.finish();
  }

  // Run-history: append to the index, diff/gate against the pinned baseline,
  // and promote per policy (see apps/cli/src/eval-history.ts).
  const finish = await finishEvalRun({
    summary,
    specName: ir.name,
    // Stable spec identity for baseline-collision detection: the resolved
    // source path survives instruction edits (so an edited spec keeps its
    // lineage) yet differs across distinct spec files that share a `name:`.
    specSource: absSpec,
    datasetHash,
    outDir: absOut,
    gateRequested,
    promote,
    // C30 — the run's estimated cost + the pre-declared ops thresholds.
    ...(costUsd !== undefined ? { costUsd } : {}),
    // C35 — the halves behind that total, recorded additively so trends can
    // separate agent spend from grading spend (and so a run with an unpriced
    // JUDGE model still carries its known agent figure).
    ...(agentCostUsd !== undefined ? { agentCostUsd } : {}),
    ...(judgeCostUsd !== undefined ? { judgeCostUsd } : {}),
    ...(maxP95LatencyMs !== undefined ? { maxP95LatencyMs } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  });
  if (finish.gateFailed) {
    const reason = `eval --gate: ${finish.gateReason ?? "regression gate failed"}`;
    // NEW-HUNT-8 — under a suite the verdict is data (the tier keeps running
    // and reports every entry); standalone it stays the process exit it was.
    if (hooks.onGateFailure !== undefined) {
      hooks.onGateFailure(reason);
      return;
    }
    die(reason);
  }
}

// -------- NEW-HUNT-8: crewhaus eval suite <suite.yaml> --------

/** Read one suite entry's aggregates back from its run directory. Undefined
 *  when the entry produced no results (crash, or a die() before the run).
 *
 *  `notBefore` is the results.json mtime observed BEFORE the entry ran: an
 *  unchanged file is a leftover from an earlier run into the same `-o`
 *  directory, and reading it would report a stale PASS for an entry that
 *  never produced a measurement. */
function resultsMtimeMs(runDir: string): number | undefined {
  try {
    return statSync(join(runDir, "results.json")).mtimeMs;
  } catch {
    return undefined;
  }
}

function readEntryAggregates(runDir: string, notBefore?: number): EntryAggregates | undefined {
  try {
    if (notBefore !== undefined && (resultsMtimeMs(runDir) ?? 0) <= notBefore) return undefined;
    // The projection (including the structural `partial` read) lives in
    // eval-suite.ts so it is unit-testable without a run directory.
    return entryAggregatesFromResults(
      JSON.parse(readFileSync(join(runDir, "results.json"), "utf-8")),
    );
  } catch {
    return undefined;
  }
}

/**
 * NEW-HUNT-8 — run one named tier of a suite manifest: entries sequentially
 * (the matrix runner's shape — isolate a crashed entry, keep going, report
 * everything), each through the SAME `runEvalSubcommand` a hand-typed
 * `crewhaus eval` takes, into `<out>/<entry>/`. The tier passes only when
 * every entry passes; `--gate` maps a failing tier to a non-zero exit.
 */
async function runEvalSuiteCommand(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus eval suite <suite.yaml> [--tier fast|nightly|release] [--spec <spec.yaml>]\n" +
        "                          [-o <out-dir>] [--gate]\n" +
        "  Run a named CI TIER of a suite manifest (NEW-HUNT-8): the report's tiering\n" +
        "  practice — a small fast suite per change, a medium one nightly, the full one\n" +
        "  on release candidates — as one command with ONE verdict.\n" +
        "  The manifest names tiers (fast | nightly | release, a fixed vocabulary so\n" +
        "  `--tier fast` means the same thing in every repo); each tier lists entries:\n" +
        "    tiers:\n" +
        "      fast:\n" +
        "        - name: smoke                # becomes the entry's run directory\n" +
        "          dataset: eval/smoke.jsonl  # file or registry:<ref>, as `eval --dataset`\n" +
        "          graders: eval/graders.yaml\n" +
        "          seed: 1                    # seed/repeats/concurrency/slice/allow_test_split\n" +
        "          gate: true                 # the existing (spec,dataset) baseline gate\n" +
        "          thresholds: {min_pass_rate: 0.8, min_mean_score: 0.7,\n" +
        "                       max_p95_latency_ms: 4000, max_cost_usd: 1.5}\n" +
        "  Paths resolve from the CWD, exactly like a hand-typed `crewhaus eval`.\n" +
        "  Every entry runs through that same path, so registry refs, the regression\n" +
        "  union, preflight, triage, run history and baselines all behave identically.\n" +
        "  TWO gates, deliberately distinct: min_pass_rate/min_mean_score are ABSOLUTE\n" +
        "  floors this command evaluates from each entry's results.json — they bite\n" +
        "  from run one, including in a fresh CI workspace. `gate: true` is the\n" +
        "  unchanged (spec, dataset) BASELINE regression gate, which has nothing to\n" +
        "  compare against until a baseline is pinned (the scaffolded workflow's\n" +
        "  base-branch run pins it). max_p95_latency_ms/max_cost_usd are criteria OF\n" +
        "  that baseline gate, so declaring one without `gate: true` is refused rather\n" +
        "  than silently enforcing nothing. Every entry must declare ONE of the two:\n" +
        "  an entry with neither can never fail, so its PASS would mean nothing — that\n" +
        "  is a parse error too. A PARTIAL (budget-exhausted) entry always\n" +
        "  fails: an incomplete measurement cannot clear a floor.\n" +
        "  Before ANY entry runs, a preflight refuses missing spec/dataset/graders\n" +
        "  files (registry:/http datasets resolve at run time and are skipped). Other\n" +
        "  per-entry config errors — an unparseable spec, a non-cli target — still stop\n" +
        "  the suite at that entry; a RUN failure (provider error) is isolated to its\n" +
        "  entry and the remaining entries still run.\n" +
        "  --spec overrides every entry's spec (how the CI scaffold evals the base\n" +
        "  branch's spec against the PR's data). -o defaults to\n" +
        "  .crewhaus/evals/suite_<tier>_<timestamp>; the tier verdict + every entry's\n" +
        "  aggregates and failure reasons land in <out>/suite.json.\n" +
        "  Without --gate this reports and exits 0; with it a failing tier exits 1.\n" +
        "  Scaffold a tiered workflow with `crewhaus init --ci --suite <suite.yaml>`.\n",
    );
    return;
  }
  const manifestPath = args.positional[0];
  if (typeof manifestPath !== "string") die("missing <suite.yaml>");
  const absManifest = resolve(manifestPath);
  let manifestText: string;
  try {
    manifestText = readFileSync(absManifest, "utf-8");
  } catch (err) {
    die(`could not read ${absManifest}: ${(err as Error).message}`);
  }
  let manifest: SuiteManifest;
  let tier: SuiteTier;
  let entries: ReadonlyArray<ReturnType<typeof selectTier>[number]>;
  try {
    manifest = parseSuiteManifest(manifestText);
    tier = parseTierFlag(strFlag(args, "tier"));
    entries = selectTier(manifest, tier);
  } catch (err) {
    if (err instanceof EvalSuiteError) die(err.message);
    throw err;
  }
  const specOverride = strFlag(args, "spec");
  const refusals = suitePreflight({
    manifest,
    entries,
    ...(specOverride !== undefined ? { specOverride } : {}),
    exists: (p) => existsSync(resolve(p)),
  });
  if (refusals.length > 0) {
    die(
      `[suite] refused before any run:\n  - ${refusals.join("\n  - ")}\nfix the manifest at ${absManifest}`,
    );
  }

  const suiteName = manifest.name ?? basename(absManifest).replace(/\.ya?ml$/i, "");
  const startedAt = new Date().toISOString();
  const outArg = args.flags["out"];
  const outRoot =
    typeof outArg === "string"
      ? resolve(outArg)
      : join(
          process.cwd(),
          ".crewhaus",
          "evals",
          `suite_${tier}_${startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`,
        );
  mkdirSync(outRoot, { recursive: true });
  process.stdout.write(
    `[suite] ${suiteName} tier=${tier}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} → ${outRoot}\n`,
  );

  const outcomes: SuiteEntryOutcome[] = [];
  for (const [i, entry] of entries.entries()) {
    const entryOut = join(outRoot, entry.name);
    process.stdout.write(
      `[suite] (${i + 1}/${entries.length}) ${entry.name}: ${entry.dataset} × ${entry.graders}\n`,
    );
    const failures: string[] = [];
    let errored = false;
    // Re-running a suite into the same -o directory leaves the previous
    // attempt's results.json in place; pin its mtime so a crashed entry can
    // never inherit an earlier run's verdict.
    const staleAt = resultsMtimeMs(entryOut);
    try {
      await runEvalSubcommand(
        buildEntryEvalArgs({
          manifest,
          entry,
          ...(specOverride !== undefined ? { specOverride } : {}),
          outDir: entryOut,
        }),
        { onGateFailure: (reason) => failures.push(reason) },
      );
    } catch (err) {
      // Entry-level isolation (the matrix runner's posture): one entry's
      // provider blow-up must not forfeit the tiers' remaining evidence.
      errored = true;
      failures.push(`entry crashed: ${err instanceof Error ? err.message : String(err)}`);
      process.stderr.write(`[suite] entry "${entry.name}" crashed — continuing\n`);
    }
    const aggregates = readEntryAggregates(entryOut, staleAt);
    if (aggregates === undefined) {
      errored = true;
      failures.push(
        staleAt !== undefined
          ? "no fresh results.json — the entry produced no measurement (the file in this directory is from an earlier run)"
          : "no results.json — the entry produced no measurement",
      );
    } else {
      failures.push(...evaluateEntryThresholds(aggregates, entry.thresholds));
    }
    outcomes.push({
      name: entry.name,
      dataset: entry.dataset,
      graders: entry.graders,
      outDir: entryOut,
      passed: failures.length === 0,
      failures,
      ...(aggregates !== undefined ? { aggregates } : {}),
      errored,
    });
  }

  const result = aggregateSuite({
    suiteName,
    tier,
    startedAt,
    endedAt: new Date().toISOString(),
    outDir: outRoot,
    entries: outcomes,
  });
  writeFileSync(join(outRoot, "suite.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(renderSuiteSummary(result));
  if (!result.passed && args.flags["gate"] === true) {
    die(
      `eval suite --gate: tier "${tier}" failed — ${outcomes
        .filter((e) => !e.passed)
        .map((e) => e.name)
        .join(", ")}`,
    );
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
  /** G15 — `--repeats`, threaded into every cell (per-cell pass@k/pass^k). */
  readonly repeats?: number;
  /** B13 — `--slice`, threaded into every cell (per-cell slice figures). */
  readonly sliceKeys?: ReadonlyArray<string>;
  /** G14 — the shared default registry, constructed once for all cells. */
  readonly graderRegistry?: GraderLookup;
  readonly judgeModel?: string;
  /** NEW-HUNT-3 — `--sample-timeout-ms`, threaded into every cell
   *  (overrides the spec's `limits.deadline_ms`). */
  readonly sampleTimeoutMs?: number;
  /** NEW-HUNT-3 — `--budget-usd`, threaded into every cell: each cell
   *  meters its OWN cap (overrides the spec's `budget.usd`). */
  readonly budgetUsd?: number;
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

  // One pricing lookup for the cells' budget metering AND the est_$ column.
  const pricing = defaultMatrixPricing();

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
          // C33 — which CLI produced this run (reproducibility manifest).
          ...cliVersionOpt(),
          outDir: cellOutDir,
          datasetHash: opts.datasetHash,
          retryErrors: opts.retryErrors,
          ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          ...(opts.repeats !== undefined ? { repeats: opts.repeats } : {}),
          ...(opts.sliceKeys !== undefined ? { sliceKeys: opts.sliceKeys } : {}),
          ...(opts.graderRegistry !== undefined ? { graderRegistry: opts.graderRegistry } : {}),
          ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
          // NEW-HUNT-3 — per-cell runtime ceilings + the pricing seam the
          // cell's budget cap meters through.
          ...(opts.sampleTimeoutMs !== undefined ? { sampleTimeoutMs: opts.sampleTimeoutMs } : {}),
          ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
          pricing,
        },
      });
      // Same per-cell artifact set as a single-model run (results.json +
      // index.html), so `eval-report diff <cellA> <cellB>` works on any pair.
      writeFileSync(join(cellOutDir, "index.html"), renderReport(await loadRun(cellOutDir)).html);
      return summary;
    },
  });

  const matrix = buildMatrix(cells, { pricing });
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

/**
 * Item 24 — `crewhaus model-scan`. Read the cwd spec's agent.model, enumerate
 * capability-compatible replacement candidates from the pricing table, eval
 * current + each candidate on the spec's dataset (same matrix machinery), and
 * emit a proposal + patch.json when a candidate beats current on score at
 * lower cost. Model fields are outside OPTIMIZABLE_PATHS, so nothing is
 * auto-applied — `--write` does a direct comment-preserving CST edit on a
 * human-reviewed winner.
 */
async function runModelScan(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus model-scan --dataset <data> --graders <graders.yaml>\n" +
        "                           [--same-provider] [--limit N] [--concurrency N] [--seed N]\n" +
        "                           [--judge-model <m>] [-o <dir>] [--write]\n" +
        "  Reads the cwd crewhaus.yaml's agent.model, enumerates capability-compatible\n" +
        "  cheaper replacements from the pricing table (--same-provider restricts to\n" +
        "  same-provider siblings; --limit caps the count, default 6), evals current +\n" +
        "  each candidate on the dataset, and prints a proposal when a candidate beats\n" +
        "  current on mean score at lower projected cost. Writes matrix.json/index.html\n" +
        "  + (when a winner exists) patch.json to -o (default .crewhaus/model-scan_<id>).\n" +
        "  --write applies the winner to crewhaus.yaml via a direct comment-preserving\n" +
        "  CST edit (model fields are outside OPTIMIZABLE_PATHS — this deliberately\n" +
        "  bypasses the optimizer whitelist; always human-initiated, never automatic).\n",
    );
    return;
  }
  const datasetPath = args.flags["dataset"];
  const gradersPath = args.flags["graders"];
  if (typeof datasetPath !== "string") die("model-scan: missing --dataset <data>");
  if (typeof gradersPath !== "string") die("model-scan: missing --graders <graders.yaml>");

  const specPath = join(process.cwd(), "crewhaus.yaml");
  if (!existsSync(specPath)) die(`model-scan: no crewhaus.yaml in ${process.cwd()}`);
  const yamlText = readFileSync(specPath, "utf-8");
  let ir: ReturnType<typeof lower>;
  try {
    ir = lower(parseSpec(yamlText));
  } catch (err) {
    if (err instanceof SpecParseError) die(err.message);
    throw err;
  }
  if (ir.target !== "cli") die(`model-scan only supports target: cli (got "${ir.target}")`);
  const currentModel = ir.agent.model;

  const pricing = loadUserPricing();
  const candidates = buildScanCandidates(currentModel, {
    pricing,
    sameProviderOnly: args.flags["same-provider"] === true,
    ...(typeof args.flags["limit"] === "string"
      ? { limit: Number.parseInt(args.flags["limit"], 10) }
      : {}),
  });
  if (candidates.length === 0) {
    die(
      `model-scan: no capability-compatible cheaper candidates for "${currentModel}" in the pricing table (it may be a local/named-host model, or already the cheapest in its class)`,
    );
  }

  // Load graders + dataset ONCE (every cell sees the identical samples).
  const gradersYaml = readFileSync(resolve(gradersPath), "utf-8");
  const { compiled } = parseGradersConfig(gradersYaml);
  const dataset = await loadDataset(resolve(datasetPath));
  const datasetHash = hashDatasetFile(resolve(datasetPath));
  const samples = await collectSamples(dataset.samples);

  const concurrencyFlag = args.flags["concurrency"];
  const seedFlag = args.flags["seed"];
  const judgeModelFlag = args.flags["judge-model"];
  const concurrency =
    typeof concurrencyFlag === "string" ? Number.parseInt(concurrencyFlag, 10) : undefined;
  const seed = typeof seedFlag === "string" ? Number.parseInt(seedFlag, 10) : undefined;

  const outArg = args.flags["out"];
  const rootDir =
    typeof outArg === "string"
      ? resolve(outArg)
      : resolve(join(".crewhaus", `model-scan_${randomBytes(8).toString("hex")}`));
  mkdirSync(rootDir, { recursive: true });

  const models = [currentModel, ...candidates];
  process.stdout.write(
    `[model-scan] current ${currentModel} vs ${candidates.length} candidate(s) × ${samples.length} samples → ${rootDir}\n`,
  );

  const cells = await runMatrixCells({
    models,
    slugs: assignCellSlugs(models),
    rootDir,
    runCell: async (model, cellOutDir) => {
      const summary = await runEvalLib({
        ir: { ...ir, agent: { ...ir.agent, model } },
        dataset: { name: dataset.name, samples: makeAsyncIterable(samples) },
        compiledGraders: compiled,
        opts: {
          // C33 — which CLI produced this run (reproducibility manifest).
          ...cliVersionOpt(),
          outDir: cellOutDir,
          datasetHash,
          ...(concurrency !== undefined ? { concurrency } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
        },
      });
      writeFileSync(join(cellOutDir, "index.html"), renderReport(await loadRun(cellOutDir)).html);
      return summary;
    },
  });

  const matrix = buildMatrix(cells, { pricing: defaultMatrixPricing() });
  const rendered = renderMatrix(matrix);
  writeFileSync(join(rootDir, "matrix.json"), rendered.json);
  writeFileSync(join(rootDir, "index.html"), rendered.html);

  // Fold matrix rows into scan cells (model → score + projected cost).
  const scanCells: ScanCell[] = matrix.rows.map((r) => ({
    model: r.model,
    ...(r.passRate !== undefined ? { passRate: r.passRate } : {}),
    ...(r.meanScore !== undefined ? { meanScore: r.meanScore } : {}),
    ...(r.costPer1kSamplesUsd !== undefined ? { costPer1kSamplesUsd: r.costPer1kSamplesUsd } : {}),
    ...(r.status === "error" ? { error: r.error ?? "cell failed" } : {}),
  }));
  const scan = buildMarketScan(currentModel, scanCells);

  writeTable(
    ["candidate", "score Δ", "$/1k Δ", "recommended", "why"],
    scan.proposals.map((p) => [
      p.candidateModel,
      p.scoreDelta >= 0 ? `+${p.scoreDelta.toFixed(3)}` : p.scoreDelta.toFixed(3),
      p.costDeltaPer1kUsd.toFixed(4),
      p.recommended ? "YES" : "no",
      p.reason,
    ]),
  );

  if (scan.best !== undefined) {
    const artifact = buildProposalArtifact(scan);
    if (artifact !== undefined) {
      writeFileSync(join(rootDir, "patch.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    }
    process.stdout.write(
      `\n[model-scan] recommendation: ${currentModel} → ${scan.best.candidateModel} ` +
        `(+${scan.best.scoreDelta.toFixed(3)} score, ${scan.best.costDeltaPer1kUsd.toFixed(4)} $/1k)\n` +
        `[model-scan] proposal: ${join(rootDir, "patch.json")}\n`,
    );
    if (args.flags["write"] === true) {
      const updated = writeModelField(
        yamlText,
        ir.target,
        ["agent", "model"],
        scan.best.candidateModel,
      );
      writeFileSync(specPath, updated);
      process.stdout.write(
        `[model-scan] --write: applied agent.model = ${scan.best.candidateModel} to ${specPath} (comment-preserving CST edit; review the diff before committing)\n`,
      );
    } else {
      process.stdout.write(
        "[model-scan] apply with `crewhaus model-scan ... --write`, or hand-edit — every model change is human-reviewed.\n",
      );
    }
  } else {
    process.stdout.write("\n[model-scan] no candidate beats current on score at lower cost.\n");
  }

  const crashed = matrix.rows.filter((r) => r.status === "error");
  if (crashed.length > 0) {
    process.stdout.write(
      `[model-scan] note: ${crashed.length} cell(s) failed to run (${crashed.map((r) => r.model).join(", ")})\n`,
    );
  }
}

/** Apply a single-slot model swap to a lowered CLI IR, in-memory. `path` is
 *  ["agent","model"], ["compaction","model"], or ["subAgents", i, "model"]. */
function patchIrModelSlot(
  ir: Extract<ReturnType<typeof lower>, { target: "cli" }>,
  slot: ModelSlot,
  model: string,
): Extract<ReturnType<typeof lower>, { target: "cli" }> {
  if (slot.label === "agent.model") {
    return { ...ir, agent: { ...ir.agent, model } };
  }
  if (slot.label === "compaction.model") {
    return { ...ir, compaction: { ...ir.compaction, model } };
  }
  if (slot.label.startsWith("sub-agent ") && ir.subAgents !== undefined) {
    const subAgents = ir.subAgents.map((sa) =>
      sa.model === slot.currentModel && `sub-agent ${sa.name}.model` === slot.label
        ? { ...sa, model }
        : sa,
    );
    return { ...ir, subAgents };
  }
  return ir;
}

/**
 * Item 25 — `crewhaus model right-size <spec>`. A dedicated enumerate →
 * compile → eval loop (NOT the prompt mutator): each candidate is the spec
 * with ONE model slot (agent.model / sub-agent.model / compaction.model)
 * swapped to a cheaper same-provider pricing-table sibling. Baseline + each
 * candidate are evaled; per-candidate USD is projected from the eval's token
 * aggregates (eval artifacts carry no cost_accrual); the set is ranked by
 * score-retained-per-dollar-saved. Recommends ONLY when pass-rate holds and
 * cost drops >= --min-cost-drop. Proposal-only unless --write (a direct
 * comment-preserving CST edit — model paths stay outside OPTIMIZABLE_PATHS).
 */
async function runModelRightSize(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus model right-size [<spec.yaml>] --dataset <data> --graders <graders.yaml>\n" +
        "                                 [--min-cost-drop 0.2] [--pass-rate-tolerance 0.0]\n" +
        "                                 [--per-slot-limit 3] [--concurrency N] [--seed N]\n" +
        "                                 [--judge-model <m>] [-o <dir>] [--write]\n" +
        "  Enumerate → compile → eval downshift search: for each model slot (agent.model,\n" +
        "  compaction.model, sub-agents[*].model) tries the cheaper same-provider pricing-\n" +
        "  table siblings, evals each against the baseline spec on the dataset, projects\n" +
        "  per-candidate USD from token totals, and ranks by score-retained-per-dollar-\n" +
        "  saved. Recommends the biggest swap that HOLDS pass-rate (within\n" +
        "  --pass-rate-tolerance, default 0) and cuts cost by >= --min-cost-drop\n" +
        "  (default 0.2). Writes matrix.json/index.html + patch.json (the winner) to -o.\n" +
        "  --write applies the winner to the spec via a direct comment-preserving CST\n" +
        "  edit (model fields are outside OPTIMIZABLE_PATHS; always human-initiated).\n",
    );
    return;
  }
  const datasetPath = args.flags["dataset"];
  const gradersPath = args.flags["graders"];
  if (typeof datasetPath !== "string") die("model right-size: missing --dataset <data>");
  if (typeof gradersPath !== "string") die("model right-size: missing --graders <graders.yaml>");

  const specArg = args.positional[0];
  const specPath =
    typeof specArg === "string" ? resolve(specArg) : join(process.cwd(), "crewhaus.yaml");
  if (!existsSync(specPath)) die(`model right-size: no spec at ${specPath}`);
  const yamlText = readFileSync(specPath, "utf-8");
  let ir: ReturnType<typeof lower>;
  try {
    ir = lower(parseSpec(yamlText));
  } catch (err) {
    if (err instanceof SpecParseError) die(err.message);
    throw err;
  }
  if (ir.target !== "cli") die(`model right-size only supports target: cli (got "${ir.target}")`);
  const cliIr = ir;

  // Collect the swappable slots off the LOWERED ir (compaction.model may be a
  // resolved `cheapest` — right-size searches from wherever it landed).
  const slots: ModelSlot[] = [
    { label: "agent.model", currentModel: cliIr.agent.model, path: ["agent", "model"] },
  ];
  if (cliIr.compaction.model !== undefined) {
    slots.push({
      label: "compaction.model",
      currentModel: cliIr.compaction.model,
      path: ["compaction", "model"],
    });
  }
  for (const sa of cliIr.subAgents ?? []) {
    if (sa.model !== undefined) {
      slots.push({ label: `sub-agent ${sa.name}.model`, currentModel: sa.model });
    }
  }

  const pricing = loadUserPricing();
  const candidates = enumerateSlotCandidates(slots, {
    pricing,
    ...(typeof args.flags["per-slot-limit"] === "string"
      ? { perSlotLimit: Number.parseInt(args.flags["per-slot-limit"], 10) }
      : {}),
  });
  if (candidates.length === 0) {
    die(
      "model right-size: no cheaper same-provider downshift candidates for any slot (models may already be cheapest-in-class or off the pricing table)",
    );
  }

  const gradersYaml = readFileSync(resolve(gradersPath), "utf-8");
  const { compiled } = parseGradersConfig(gradersYaml);
  const dataset = await loadDataset(resolve(datasetPath));
  const datasetHash = hashDatasetFile(resolve(datasetPath));
  const samples = await collectSamples(dataset.samples);

  const concurrencyFlag = args.flags["concurrency"];
  const seedFlag = args.flags["seed"];
  const judgeModelFlag = args.flags["judge-model"];
  const concurrency =
    typeof concurrencyFlag === "string" ? Number.parseInt(concurrencyFlag, 10) : undefined;
  const seed = typeof seedFlag === "string" ? Number.parseInt(seedFlag, 10) : undefined;
  const minCostDrop =
    typeof args.flags["min-cost-drop"] === "string"
      ? Number.parseFloat(args.flags["min-cost-drop"])
      : 0.2;
  const passRateTolerance =
    typeof args.flags["pass-rate-tolerance"] === "string"
      ? Number.parseFloat(args.flags["pass-rate-tolerance"])
      : 0;

  const outArg = args.flags["out"];
  const rootDir =
    typeof outArg === "string"
      ? resolve(outArg)
      : resolve(join(".crewhaus", `right-size_${randomBytes(8).toString("hex")}`));
  mkdirSync(rootDir, { recursive: true });

  const runOne = async (
    candidateIr: Extract<ReturnType<typeof lower>, { target: "cli" }>,
    label: string,
  ): Promise<EvalRunSummary> => {
    const cellDir = join(rootDir, label.replace(/[^A-Za-z0-9._-]+/g, "_"));
    return runEvalLib({
      ir: candidateIr,
      dataset: { name: dataset.name, samples: makeAsyncIterable(samples) },
      compiledGraders: compiled,
      opts: {
        // C33 — which CLI produced this run (reproducibility manifest).
        ...cliVersionOpt(),
        outDir: cellDir,
        datasetHash,
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
      },
    });
  };

  process.stdout.write(
    `[right-size] baseline + ${candidates.length} downshift candidate(s) × ${samples.length} samples → ${rootDir}\n`,
  );

  // Baseline first.
  const baselineSummary = await runOne(cliIr, "baseline");
  const baseline: BaselineEvalOutcome = {
    passRate: baselineSummary.aggregates.passRate,
    tokens: baselineSummary.aggregates.totalTokens,
    model: cliIr.agent.model,
  };

  const outcomes: SlotEvalOutcome[] = [];
  for (const candidate of candidates) {
    const label = `${candidate.slot.label}=${candidate.candidateModel}`;
    try {
      const summary = await runOne(
        patchIrModelSlot(cliIr, candidate.slot, candidate.candidateModel),
        label,
      );
      const crashed =
        summary.samples.length > 0 && summary.aggregates.errorCount >= summary.samples.length;
      outcomes.push({
        candidate,
        passRate: summary.aggregates.passRate,
        tokens: summary.aggregates.totalTokens,
        ...(crashed ? { error: "all samples errored" } : {}),
      });
    } catch (err) {
      outcomes.push({
        candidate,
        passRate: 0,
        tokens: { input: 0, output: 0 },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const report = buildRightSizeReport(baseline, outcomes, {
    minCostDropRatio: minCostDrop,
    passRateTolerance,
    pricing,
  });
  writeFileSync(join(rootDir, "right-size.json"), `${JSON.stringify(report, null, 2)}\n`);

  writeTable(
    ["slot → model", "pass_rate Δ", "$ saved", "cost drop", "recommend", "why"],
    report.ranked.map((r) => [
      `${r.slot} → ${r.modelString}`,
      `${r.passRateDelta >= 0 ? "+" : ""}${(r.passRateDelta * 100).toFixed(1)}pp`,
      `$${r.savingUsd.toFixed(4)}`,
      `${(r.costDropRatio * 100).toFixed(0)}%`,
      r.recommended ? "YES" : "no",
      r.reason,
    ]),
  );

  if (report.best !== undefined) {
    const artifact = {
      kind: "model-right-size-proposal" as const,
      generatedAt: new Date().toISOString(),
      slot: report.best.slot,
      recommendedModel: report.best.modelString,
      passRateDelta: report.best.passRateDelta,
      savingUsd: report.best.savingUsd,
      costDropRatio: report.best.costDropRatio,
      ...(report.best.slotPath !== undefined
        ? {
            patch: {
              op: "replace" as const,
              path: report.best.slotPath,
              value: report.best.modelString,
            },
          }
        : {}),
    };
    writeFileSync(join(rootDir, "patch.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(
      `\n[right-size] recommendation: ${report.best.slot} → ${report.best.modelString} ` +
        `(saves $${report.best.savingUsd.toFixed(4)}, ${(report.best.costDropRatio * 100).toFixed(0)}% cheaper, pass-rate ${report.best.passRateDelta >= 0 ? "+" : ""}${(report.best.passRateDelta * 100).toFixed(1)}pp)\n`,
    );
    if (args.flags["write"] === true && report.best.slotPath !== undefined) {
      const updated = writeModelField(
        yamlText,
        cliIr.target,
        report.best.slotPath,
        report.best.modelString,
      );
      writeFileSync(specPath, updated);
      process.stdout.write(
        `[right-size] --write: applied ${report.best.slot} = ${report.best.modelString} to ${specPath} (comment-preserving CST edit; review the diff)\n`,
      );
    } else if (report.best.slotPath === undefined) {
      process.stdout.write(
        "[right-size] the winning slot is the judge model (a CLI flag, not a spec field) — pass it via --judge-model on your eval runs.\n",
      );
    } else {
      process.stdout.write(
        "[right-size] apply with `--write`, or hand-edit — every model change is human-reviewed.\n",
      );
    }
  } else {
    process.stdout.write(
      "\n[right-size] no downshift holds pass-rate while cutting cost enough.\n",
    );
  }
  process.stdout.write(`[right-size] report: ${join(rootDir, "right-size.json")}\n`);
}

async function runEvalReport(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus eval-report <action>\n" +
        "  diff <prev> <new> [-o <out-dir>] [--seed N] [--epsilon F] [--pairwise [--judge-model <m>]]\n" +
        "      compare two eval runs and emit a diff report;\n" +
        "      prints the paired-significance line (pass-rate delta, 95% CI, p-value) and\n" +
        "      per-slice deltas for slice keys both runs share; --seed pins the Monte Carlo\n" +
        "      draw behind the significance figures (unseeded diffs use a fixed default, so\n" +
        "      they are already deterministic). Significance is decision support — the\n" +
        "      strict `eval --gate` verdict never consults it.\n" +
        "      --pairwise additionally judges each shared sample's two outputs head-to-head\n" +
        "      (which run answered better?) TWICE with the presentation order swapped —\n" +
        "      win/loss/tie per order, win-rate and order-consistency land additively in\n" +
        "      diff.json, the report, and a stdout block; an order disagreement is position\n" +
        "      bias and counts as a tie, never a win. Opt-in: 2 judge calls per shared\n" +
        "      sample, so it requires visible judge credentials (--judge-model overrides\n" +
        "      the default judge) and dies with a clear message without them.\n" +
        "      --epsilon F sets the score-shift tolerance (default 0.1 on the normalized\n" +
        "      0..1 scale): only |Δscore| strictly above it is reported as a shift. Flips\n" +
        "      (pass↔fail) are never subject to it. A 1-5 judge rubric and a 0/1 grader\n" +
        "      deserve different tolerances — this is that knob.\n" +
        "  history [--spec <name>] [--dataset <name>]  list recorded runs (.crewhaus/evals/index.jsonl)\n" +
        "  trends [--spec <n>] [--dataset <n>] [-o <dir>]\n" +
        "      pass-rate / mean-score / cost OVER TIME per (spec, dataset), folded from the\n" +
        "      same index.jsonl `history` lists: a text table plus a movement line per\n" +
        "      lineage (first → last, delta in percentage POINTS). -o additionally writes a\n" +
        "      SELF-CONTAINED index.html (inline CSS + inline SVG chart, no external assets,\n" +
        "      opens from file://) and trends.json. Fully offline — no run directory is\n" +
        "      opened, so a three-week drift is one command, not an eyeball exercise.\n" +
        "  export --runs <dir|dir,dir|last:N> --format csv|jsonl [-o <file>] [--spec <n>] [--dataset <n>]\n" +
        "      flatten runs into ONE ROW PER (run, sample, grader): run config columns\n" +
        "      (runId, ts, specHash, dataset, model, judgeModel, seed), the sample's verdict\n" +
        "      + latency + trial pass rate + flaky flag + slice membership, and each\n" +
        "      grader's own passed/score/abstained/rationale (clipped). `last:N` takes the N\n" +
        "      most recent indexed runs (after --spec/--dataset filtering); an unreadable or\n" +
        "      moved run dir is reported and skipped. Without -o the table goes to stdout.\n" +
        "  baseline show [--spec <n>] [--dataset <n>]  print pinned baselines (.crewhaus/evals/baselines.json)\n" +
        "  baseline set <runId>                        pin a recorded run as its (spec, dataset) baseline\n" +
        "  --dataset matches the recorded name exactly OR with a `+` suffix segment, so\n" +
        "  `--dataset smoke` also finds runs recorded under the regression-suite union\n" +
        "  name `smoke+regressions@vX`.\n" +
        "  E52: `crewhaus eval history|baseline|diff` are working aliases for these\n" +
        "  verbs (a stderr notice names the canonical spelling; flags pass through).\n",
    );
    return;
  }
  const action = args.positional[0];
  // Strictness (NEW-HUNT-7 doctrine) — a silently-ignored knob is a trap.
  // --judge-model only configures `diff --pairwise`'s judge, and both
  // pairwise flags are inert on the offline read verbs; say so instead of
  // quietly running a fully offline command the user believed was judged.
  if (action === "diff" && args.flags["judge-model"] !== undefined && !args.flags["pairwise"]) {
    process.stderr.write(
      "[eval-report] warning: --judge-model has no effect without --pairwise — the diff runs fully offline\n",
    );
  } else if (
    action === "history" ||
    action === "baseline" ||
    action === "trends" ||
    action === "export"
  ) {
    for (const flag of ["pairwise", "judge-model", "epsilon"]) {
      if (args.flags[flag] !== undefined) {
        process.stderr.write(
          `[eval-report] warning: --${flag} only applies to \`eval-report diff\` — ignored by \`${action}\`\n`,
        );
      }
    }
  }
  // C32 — the mirror of the same doctrine: --runs/--format configure `export`
  // only, and a silently-ignored knob is a trap on any verb.
  if (action !== "export") {
    for (const flag of ["runs", "format"]) {
      if (args.flags[flag] !== undefined) {
        process.stderr.write(
          `[eval-report] warning: --${flag} only applies to \`eval-report export\` — ignored by \`${action ?? ""}\`\n`,
        );
      }
    }
  }
  switch (action) {
    case "diff":
      await runEvalReportDiff(args);
      return;
    case "history":
      runEvalReportHistory(args);
      return;
    // C31 — cross-run trends (offline fold over the same index history reads).
    case "trends":
      runEvalReportTrends(args);
      return;
    // C32 — flat per-sample × per-grader export across runs.
    case "export":
      await runEvalReportExport(args);
      return;
    case "baseline":
      runEvalReportBaseline(args);
      return;
    default:
      die(
        `eval-report: unknown action "${action ?? ""}" — supported: diff, history, trends, export, baseline`,
      );
  }
}

async function runEvalReportDiff(args: ParsedArgs): Promise<void> {
  const prev = args.positional[1];
  const next = args.positional[2];
  if (typeof prev !== "string" || typeof next !== "string") {
    die("eval-report diff: missing <prev> <new>");
  }
  // C29 — --seed pins the significance test's Monte Carlo draw + bootstrap
  // CI. Unseeded diffs use the package's fixed default, so they are already
  // deterministic; a garbled value dies loudly rather than silently seeding 0.
  const seedFlag = args.flags["seed"];
  if (typeof seedFlag === "string" && !/^-?\d+$/.test(seedFlag)) {
    die(`eval-report diff: --seed must be an integer (got "${seedFlag}")`);
  }
  const seed = typeof seedFlag === "string" ? Number.parseInt(seedFlag, 10) : undefined;
  // NEW-stats-1 — the score-shift tolerance, previously a module constant.
  // Default unchanged (0.1), so an unflagged diff classifies exactly as before.
  const epsilonFlag = args.flags["epsilon"];
  let epsilon: number | undefined;
  if (typeof epsilonFlag === "string") {
    epsilon = Number.parseFloat(epsilonFlag);
    if (!Number.isFinite(epsilon) || epsilon < 0) {
      die(`eval-report diff: --epsilon must be a non-negative number (got "${epsilonFlag}")`);
    }
  }

  const outArg = args.flags["out"];
  let result: ReturnType<typeof diffReports>;
  let prevLoaded: LoadedRun;
  let nextLoaded: LoadedRun;
  try {
    prevLoaded = await loadRun(prev);
    nextLoaded = await loadRun(next);
    // NEW-HUNT-1 — the diff still renders, but when the two runs recorded
    // different graders configs or judge models the deltas may be the
    // instrument's, not the agent's. Warn on stderr so piped stdout stays clean.
    for (const warning of diffInstrumentWarnings(prevLoaded, nextLoaded)) {
      process.stderr.write(`[eval-report] warning: ${warning}\n`);
    }
    result = diffReports(prevLoaded, nextLoaded, {
      ...(seed !== undefined ? { seed } : {}),
      ...(epsilon !== undefined ? { epsilon } : {}),
    });
  } catch (err) {
    // C29 — mismatched sample ids (and unreadable runs) are user errors:
    // render the message cleanly instead of an uncaught stack trace.
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }

  // A1 — opt-in pairwise judging: judge each shared sample's two outputs
  // head-to-head, order-swapped, and fold the block additively into the
  // (already-validated) diff. Runs AFTER the offline diff so a dataset
  // mismatch dies before any judge call is spent; without the flag, the
  // diff artifacts are byte-identical to before.
  if (args.flags["pairwise"]) {
    const judgeModel = resolvePairwiseJudgeModel(args.flags["judge-model"]);
    const credentialError = pairwiseCredentialError(judgeModel, process.env);
    if (credentialError !== undefined) die(credentialError);
    try {
      const pairwise = await judgeRunsPairwise(prevLoaded, nextLoaded, { judgeModel });
      result = diffReports(prevLoaded, nextLoaded, {
        ...(seed !== undefined ? { seed } : {}),
        ...(epsilon !== undefined ? { epsilon } : {}),
        pairwise,
      });
    } catch (err) {
      if (err instanceof CrewhausError) die(`eval-report diff --pairwise: ${err.message}`);
      throw err;
    }
  }

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
  // C29 — the plain-language significance line (decision support; the
  // strict gate above never consults it).
  if (result.diff.significance !== undefined) {
    process.stdout.write(`[eval-report] ${formatSignificanceLine(result.diff.significance)}\n`);
  }
  // B13 — per-slice deltas for the slice keys both runs share.
  for (const line of formatSliceDeltaLines(result.diff.sliceDeltas ?? [])) {
    process.stdout.write(`[eval-report] ${line}\n`);
  }
  // A1 — the pairwise summary block (only under --pairwise).
  if (result.diff.pairwise !== undefined) {
    for (const line of formatPairwiseLines(result.diff.pairwise)) {
      process.stdout.write(`[eval-report] ${line}\n`);
    }
  }
}

/**
 * NEW-HUNT-6 — the run-history index, with superseded entries collapsed.
 *
 * The collapse itself lives in `@crewhaus/eval-report`'s `readRunIndexLatest`
 * (the shared reader, so a non-CLI consumer of the package is not silently
 * double-counting an N-times-resumed run); this is the thin cwd-default
 * wrapper every reader in this file goes through.
 */
function readEvalRunIndex(evalsDir?: string): RunIndexEntry[] {
  return evalsDir === undefined ? readRunIndexLatest() : readRunIndexLatest(evalsDir);
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
  const entries = readEvalRunIndex().filter((e) =>
    matchesEvalFilters(args, e.specName, e.datasetName),
  );
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
      // C34 — samples whose repeat trials disagreed in that run. A gate that
      // keeps failing on a run with flakes is often failing on the noise.
      "flaky",
      "partial",
      // NEW-HUNT-4 — every tool result came from a cassette, so this row is
      // not a measurement of the live system.
      "replayed",
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
      // C34 — blank (not "0") on runs that measured no instability, so the
      // column reads as a flag rather than a statistic.
      e.flakyCount !== undefined && e.flakyCount > 0 ? String(e.flakyCount) : "",
      // NEW-HUNT-3 — budget-aborted run: its pass_rate counts the aborted
      // samples as errors, so the figure reads lower than a full run's.
      e.partial === true ? "y" : "",
      // NEW-HUNT-4 — cassette-replayed run (`--replay-tools`).
      e.replayed === true ? "y" : "",
      pinnedRunIds.has(e.runId) ? "*" : "",
      e.outDir,
    ]),
  );
  // C34 — one honest pointer when the listing contains measured instability:
  // the flip gate cannot tell a flaky sample's coin flip from a regression.
  const flakyRuns = entries.filter((e) => (e.flakyCount ?? 0) > 0);
  if (flakyRuns.length > 0) {
    const worst = flakyRuns.reduce((a, b) => ((a.flakyCount ?? 0) >= (b.flakyCount ?? 0) ? a : b));
    const inspect = `crewhaus eval-report export --runs ${worst.outDir} --format csv`;
    process.stdout.write(
      `[eval-report] ${flakyRuns.length} run(s) contain flaky samples (worst: ${worst.runId}, ${worst.flakyCount} sample(s) whose trials disagreed) — inspect with \`${inspect}\` and consider tagging them in the dataset before they keep tripping the strict flip gate.\n`,
    );
  }
}

/**
 * C31 — `eval-report trends`: the cross-run view. Everything comes from the
 * same on-disk artifacts `history` reads (index.jsonl + baselines.json), so
 * this is offline, credential-free, and cheap; `-o` additionally writes the
 * self-contained HTML chart page + trends.json.
 */
function runEvalReportTrends(args: ParsedArgs): void {
  const entries = readEvalRunIndex().filter((e) =>
    matchesEvalFilters(args, e.specName, e.datasetName),
  );
  if (entries.length === 0) {
    process.stdout.write(
      `[eval-report] no recorded runs match (${join(".crewhaus", "evals", "index.jsonl")})\n`,
    );
    return;
  }
  const pinnedRunIds = new Set(Object.values(readBaselines()).map((b) => b.runId));
  const series = buildTrends(entries, { pinnedRunIds });
  const { header, rows } = trendTable(series);
  writeTable(header, rows);
  for (const line of formatTrendSummaryLines(series)) {
    process.stdout.write(`[eval-report] ${line}\n`);
  }
  const outArg = args.flags["out"];
  if (typeof outArg === "string") {
    const absOut = resolve(outArg);
    mkdirSync(absOut, { recursive: true });
    writeFileSync(join(absOut, "index.html"), renderTrends(series));
    writeFileSync(join(absOut, "trends.json"), `${JSON.stringify(series, null, 2)}\n`);
    process.stdout.write(`[eval-report] trends: ${join(absOut, "index.html")}\n`);
  }
}

/**
 * C32 — `eval-report export`: resolve `--runs` to run directories, load each,
 * and flatten to CSV/JSONL. A run directory that has moved or been deleted is
 * REPORTED and skipped — an export that silently drops a third of the history
 * is worse than no export.
 */
async function runEvalReportExport(args: ParsedArgs): Promise<void> {
  const runsFlag = args.flags["runs"];
  if (typeof runsFlag !== "string" || runsFlag.trim() === "") {
    die("eval-report export: --runs <dir|dir,dir|last:N> is required");
  }
  const formatFlag = args.flags["format"] ?? "csv";
  if (formatFlag !== "csv" && formatFlag !== "jsonl") {
    die(`eval-report export: --format must be csv or jsonl (got "${String(formatFlag)}")`);
  }

  // `last:N` reads the (filtered) history index; anything else is one or more
  // run directories given verbatim.
  const targets: Array<{ dir: string; specName?: string }> = [];
  const lastMatch = /^last:(\d+)$/.exec((runsFlag as string).trim());
  if (lastMatch !== null) {
    const n = Number.parseInt(lastMatch[1] as string, 10);
    if (n < 1) die("eval-report export: --runs last:N needs N >= 1");
    const entries = readEvalRunIndex().filter((e) =>
      matchesEvalFilters(args, e.specName, e.datasetName),
    );
    for (const e of entries.slice(-n)) targets.push({ dir: e.outDir, specName: e.specName });
  } else {
    for (const raw of (runsFlag as string).split(",")) {
      const dir = raw.trim();
      if (dir !== "") targets.push({ dir });
    }
  }
  if (targets.length === 0) {
    die(`eval-report export: --runs "${runsFlag}" matched no runs`);
  }

  const runs: ExportRunInput[] = [];
  for (const target of targets) {
    try {
      const loaded = await loadRun(target.dir);
      runs.push({
        summary: loaded.summary,
        ...(target.specName !== undefined ? { specName: target.specName } : {}),
      });
    } catch (err) {
      process.stderr.write(
        `[eval-report] warning: skipping ${target.dir} — ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  if (runs.length === 0) die("eval-report export: none of the requested runs could be read");

  const rows = buildExportRows(runs);
  const text = formatFlag === "csv" ? rowsToCsv(rows) : rowsToJsonl(rows);
  const outArg = args.flags["out"];
  if (typeof outArg === "string") {
    // Unlike its siblings (`diff -o`, `trends -o`) this `-o` names a FILE,
    // so pointing it at a directory — the natural mistake — used to escape
    // as a raw EISDIR stack trace. Die like every other error in this verb.
    const absOut = resolve(outArg);
    if (existsSync(absOut) && statSync(absOut).isDirectory()) {
      die(
        `eval-report export: -o takes a FILE path (e.g. rows.${formatFlag}), not a directory — "${absOut}" is one`,
      );
    }
    try {
      mkdirSync(dirname(absOut), { recursive: true });
      writeFileSync(absOut, text);
    } catch (err) {
      die(
        `eval-report export: could not write "${absOut}" — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.stdout.write(
      `[eval-report] export: ${rows.length} row(s) from ${runs.length} run(s) → ${absOut}\n`,
    );
  } else {
    process.stdout.write(text);
  }
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
      const index = readEvalRunIndex();
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
        // Carry the spec source forward from the index entry (when present)
        // so manual pins keep collision detection working — and the
        // instrument identity so gradersHash/judgeModel mismatch detection
        // keeps working too.
        ...(entry.specSource !== undefined ? { specSource: entry.specSource } : {}),
        outDir: entry.outDir,
        datasetHash: entry.datasetHash,
        ...(entry.gradersHash !== undefined ? { gradersHash: entry.gradersHash } : {}),
        ...(entry.judgeModel !== undefined ? { judgeModel: entry.judgeModel } : {}),
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
        "                                              `split` column; --split prints one split verbatim.\n" +
        "                                              Emitting locked test-split rows prints a stderr note\n" +
        "  put <name> --file <data.jsonl|csv|yaml> [--split-spec 70/15/15 | --split train] [--canary]\n" +
        "                                              import a dataset file as a new auto-bumped version\n" +
        "                                              (v1, v2, …). Split assignment is deterministic —\n" +
        "                                              stable by sample-id hash, no RNG — per the\n" +
        "                                              train/dev[/test] percentages (default 70/15/15);\n" +
        "                                              --split puts every sample into one named split.\n" +
        "                                              --canary injects ONE contamination-canary sample\n" +
        "                                              (deterministic hex phrase from the name+version\n" +
        "                                              hash, metadata.source: canary — the runner excludes\n" +
        "                                              it from pass rates; `dataset lint` scans the spec +\n" +
        "                                              few-shot pools for its phrase)\n" +
        "  verify <name>[@version]                     recompute per-split sample hashes and compare with\n" +
        "                                              what the record stored at put time; a mismatch means\n" +
        "                                              the version's content silently diverged from its\n" +
        "                                              eval-history identity (hand-edit, corruption).\n" +
        "                                              Version omitted → every version. Exits non-zero on\n" +
        "                                              any mismatch (CI-friendly)\n" +
        "  status <name> [--runs N]                    freshness/saturation report: per-version age, which\n" +
        "                                              versions the run history evaluated, always-passing\n" +
        "                                              sample ids across the last N joined runs (default\n" +
        "                                              10; rotation candidates), and test-split burn\n" +
        "  release <name>[@version] --spec <spec.yaml> --graders <g.yaml> [--force]\n" +
        "                                              the sanctioned holdout spend: run `crewhaus eval`\n" +
        "                                              over the version's locked #test split (threading\n" +
        "                                              --allow-test-split; regression union skipped so the\n" +
        "                                              holdout stays pure) and append a release entry\n" +
        "                                              {version, runId, ts, passRate} to the record —\n" +
        "                                              the version's burn count. Refuses when the version\n" +
        "                                              was already released (--force overrides, loudly)\n" +
        "  card <name>[@version] [-o <file.md>]        markdown datasheet: split sizes, provenance\n" +
        "                                              breakdown by metadata.source, sample-hash counts,\n" +
        "                                              createdAt, release/burn history, and an offline\n" +
        "                                              lint summary. Stdout by default; never mutates the\n" +
        "                                              record\n" +
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
      case "verify":
        await runDatasetsVerify(args);
        return;
      case "status":
        await runDatasetsStatus(args);
        return;
      case "release":
        await runDatasetsRelease(args);
        return;
      case "card":
        await runDatasetsCard(args);
        return;
      default:
        die(
          `datasets: unknown action "${action ?? ""}" — supported: list, get, put, verify, status, release, card`,
        );
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
  // B16 — `datasets get` keeps printing test rows (inspection is not
  // consumption), but says so on stderr whenever it does: the test split is
  // meant to be spent only at release-gate time.
  const testRows = split === undefined || split === "test" ? (record.splits.test?.length ?? 0) : 0;
  if (testRows > 0) {
    process.stderr.write(
      `[datasets] note: ${testRows} locked test-split row(s) emitted from "${name}@${resolvedVersion}" — the test split is reserved for release gating (--allow-test-split on \`crewhaus eval\` / \`crewhaus deploy canary\`)\n`,
    );
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
  const canary = args.flags["canary"] === true;
  const rec = await registerDataset({
    registry,
    name,
    samples,
    ...(split !== undefined ? { split } : { splitSpec }),
    ...(canary ? { canary: true } : {}),
  });
  process.stdout.write(
    `[datasets] put ${rec.name}@${rec.version} ` +
      `(train ${rec.splits.train.length} / dev ${rec.splits.dev.length} / ` +
      `test ${rec.splits.test?.length ?? 0}) — use with --dataset registry:${rec.name}\n`,
  );
  if (canary) {
    process.stdout.write(
      "[datasets] canary injected (1 sample, metadata.source: canary) — excluded from pass rates; `crewhaus dataset lint` scans the spec + few-shot pools for its phrase\n",
    );
  }
}

/**
 * NEW-registry-1 — `crewhaus datasets verify <name>[@version]`: recompute
 * every split's per-sample content hashes and compare with what `put`
 * stored. The stored hashes ARE the version's eval-history identity
 * (`overallDatasetHash` folds them), so a mismatch means the strict gate
 * would silently compare different data under the same lineage. Offline;
 * exits non-zero on any mismatch so CI can gate on registry integrity.
 */
async function runDatasetsVerify(args: ParsedArgs): Promise<void> {
  const refStr = args.positional[1];
  if (typeof refStr !== "string") die("datasets verify: missing <name>[@version]");
  const { name, version } = parseNameVersion(refStr);
  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  const all = [...(await registry.list(name))].sort(compareVersions);
  if (all.length === 0) {
    die(`dataset "${name}" has no versions in the registry (${defaultDatasetsRoot()})`);
  }
  const versions = version !== undefined ? [version] : all;
  if (version !== undefined && !all.includes(version)) {
    die(`dataset "${name}" has no version "${version}" (have: ${all.join(", ")})`);
  }
  let mismatches = 0;
  for (const v of versions) {
    const record = await registry.getRecord(name, v);
    const bad = verifySplitHashes(record);
    if (bad.length === 0) {
      process.stdout.write(`[datasets] verify ${name}@${v}: ok\n`);
      continue;
    }
    mismatches += bad.length;
    process.stdout.write(`[datasets] verify ${name}@${v}: ${bad.length} hash mismatch(es)\n`);
    for (const m of bad) {
      process.stdout.write(
        `  ${m.split}[${m.index}]${m.sampleId !== undefined ? ` id=${m.sampleId}` : ""}: ` +
          `stored ${m.storedHash ?? "(none)"} != actual ${m.actualHash ?? "(no sample)"}\n`,
      );
    }
  }
  if (mismatches > 0) {
    die(
      `datasets verify: ${mismatches} hash mismatch(es) — content diverged from the recorded identity (hand-edited <version>.json or corruption); re-import a clean version`,
    );
  }
}

/**
 * B17 — `crewhaus datasets status <name>`: the freshness/saturation report.
 * Joins the registry's versions with the run-history index (datasetName
 * grammar `<name>@<version>[#split][+…]`), loads the last N joined runs'
 * per-sample outcomes (best-effort), and reports version age, eval
 * coverage, always-passing sample ids (rotation candidates), and test burn.
 */
async function runDatasetsStatus(args: ParsedArgs): Promise<void> {
  const name = args.positional[1];
  if (typeof name !== "string") die("datasets status: missing <name>");
  const runsFlag = args.flags["runs"];
  let lastN: number | undefined;
  if (typeof runsFlag === "string") {
    lastN = Number.parseInt(runsFlag, 10);
    if (Number.isNaN(lastN) || lastN < 1 || String(lastN) !== runsFlag.trim()) {
      die(`invalid --runs "${runsFlag}" — must be a positive integer`);
    }
  }
  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  const versionNames = [...(await registry.list(name))].sort(compareVersions);
  if (versionNames.length === 0) {
    die(`dataset "${name}" has no versions in the registry (${defaultDatasetsRoot()})`);
  }
  const versions: Array<{ version: string; record: DatasetRecord }> = [];
  for (const v of versionNames) {
    versions.push({ version: v, record: await registry.getRecord(name, v) });
  }
  const report = await computeDatasetStatus({
    name,
    versions,
    entries: readEvalRunIndex(),
    now: new Date(),
    ...(lastN !== undefined ? { lastN } : {}),
    loadOutcomes: async (outDir) => {
      try {
        const run = await loadRun(outDir);
        return run.summary.samples.map((s) => ({
          sampleId: s.sampleId,
          passed: s.error === undefined && s.grades.overall.passed,
        }));
      } catch {
        return undefined; // torn/missing run dir — skip, like refresh-goldens
      }
    },
  });
  writeTable(
    ["version", "age", "train", "dev", "test", "runs", "last run", "test burn"],
    statusTableRows(report),
  );
  for (const line of statusSummaryLines(report)) process.stdout.write(`${line}\n`);
}

/**
 * NEW-HUNT-9 — `crewhaus datasets release`: the SANCTIONED test-split
 * spend. Runs `crewhaus eval` over the version's locked #test split
 * (through the same --allow-test-split machinery as a hand-written release
 * run, with the regression union skipped so the holdout stays pure), then
 * appends a release entry {version, runId, ts, passRate} onto the registry
 * record — the burn count `datasets status`/`card` report. A version whose
 * test split was already released refuses without --force: a holdout is
 * only hidden while its peeks are counted, and a re-released one is no
 * longer a first look.
 */
async function runDatasetsRelease(args: ParsedArgs): Promise<void> {
  const refStr = args.positional[1];
  if (typeof refStr !== "string") die("datasets release: missing <name>[@version]");
  const specPath = strFlag(args, "spec");
  if (specPath === undefined) die("datasets release: missing --spec <spec.yaml>");
  const gradersPath = strFlag(args, "graders");
  if (gradersPath === undefined) die("datasets release: missing --graders <graders.yaml>");
  const { name, version: pinned } = parseNameVersion(refStr);
  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  const version = pinned ?? (await latestVersion(registry, name));
  if (version === undefined) {
    die(`dataset "${name}" has no versions in the registry (${defaultDatasetsRoot()})`);
  }
  const record = await registry.getRecord(name, version);
  if (record.splits.test === undefined || record.splits.test.length === 0) {
    die(
      `datasets release: "${name}@${version}" has no test split — nothing to release (import with a test percentage, e.g. --split-spec 70/15/15)`,
    );
  }
  const releases = record.releases ?? [];
  if (releases.length > 0) {
    const last = releases[releases.length - 1] as ReleaseEntry;
    if (args.flags["force"] !== true) {
      die(
        `datasets release: "${name}@${version}" test split was already released ${releases.length} time(s) (last: run ${last.runId} at ${last.ts}) — the holdout is spent; release a NEW version, or pass --force to burn it again (the score is no longer a first look)`,
      );
    }
    process.stderr.write(
      `[datasets] warning: re-releasing "${name}@${version}" (burn ${releases.length + 1}) — a re-run holdout score is not a first look\n`,
    );
  }

  const datasetRef = `registry:${name}@${version}#test`;
  process.stdout.write(
    `[datasets] release ${name}@${version}: evaluating the locked test split (${record.splits.test.length} samples) via \`crewhaus eval\`\n`,
  );
  // Thread the Wave-0 machinery: an explicit #test ref behind
  // --allow-test-split; --no-regressions keeps the holdout pure (a union
  // would grade regression pins alongside it and change the identity).
  await runEvalSubcommand({
    positional: [specPath],
    flags: {
      dataset: datasetRef,
      graders: gradersPath,
      "allow-test-split": true,
      "no-regressions": true,
    },
  });

  // The eval recorded itself in the run-history index (die() on failure
  // never reaches here) — the newest entry for this exact datasetName is
  // the release run.
  const expectedName = registryDatasetName(name, version, "test");
  const entry = readEvalRunIndex()
    .filter((e) => e.datasetName === expectedName)
    .pop();
  if (entry === undefined) {
    die(
      `datasets release: eval completed but no run-history entry for ${expectedName} was found — release not recorded`,
    );
  }
  const updated = appendReleaseEntry({
    rootDir: defaultDatasetsRoot(),
    name,
    version,
    entry: { version, runId: entry.runId, ts: entry.ts, passRate: entry.passRate },
  });
  process.stdout.write(
    `[datasets] release recorded: ${name}@${version} run ${entry.runId} ` +
      `pass_rate ${(entry.passRate * 100).toFixed(1)}% — burn count ${(updated.releases ?? []).length}\n`,
  );
}

/**
 * B21 — `crewhaus datasets card <name>[@version] [-o <file>]`: render the
 * markdown datasheet (split sizes, provenance breakdown, hash counts,
 * createdAt, release/burn history, offline lint summary). A generated
 * artifact — stdout or -o — that never mutates the record; inspection
 * posture, so all splits (test included) are described.
 */
async function runDatasetsCard(args: ParsedArgs): Promise<void> {
  const refStr = args.positional[1];
  if (typeof refStr !== "string") die("datasets card: missing <name>[@version]");
  const { name, version: pinned } = parseNameVersion(refStr);
  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  const version = pinned ?? (await latestVersion(registry, name));
  if (version === undefined) {
    die(`dataset "${name}" has no versions in the registry (${defaultDatasetsRoot()})`);
  }
  const record = await registry.getRecord(name, version);
  const samples = samplesForSplits(record, splitsPresent(record));
  // The card embeds the same offline lint the `dataset lint` command runs,
  // cross-version + prompt-side context included.
  const otherVersions: Array<{ version: string; samples: Sample[] }> = [];
  for (const v of await registry.list(name)) {
    if (v === version) continue;
    try {
      const other = await registry.getRecord(name, v);
      otherVersions.push({ version: v, samples: samplesForSplits(other, splitsPresent(other)) });
    } catch {
      // torn/foreign version file — skip, like `datasets list`
    }
  }
  const context = lintContextFromCwd(args);
  const findings = lintDataset({
    samples,
    version,
    otherVersions,
    ...(context.graders !== undefined ? { graders: context.graders } : {}),
    ...(context.specHasTools !== undefined ? { specHasTools: context.specHasTools } : {}),
    leakScanTexts: context.leakScanTexts,
  });
  const entries = readEvalRunIndex().filter((e) =>
    entryMatchesVersion(name, version, e.datasetName),
  );
  const card = renderDatasetCard({
    name,
    version,
    record,
    provenance: provenanceBreakdown(samples),
    lintFindings: findings,
    runCount: entries.length,
    now: new Date(),
  });
  const outFlag = strFlag(args, "out");
  if (outFlag !== undefined) {
    writeFileSync(resolve(outFlag), card);
    process.stdout.write(`[datasets] card written: ${resolve(outFlag)}\n`);
  } else {
    process.stdout.write(card);
  }
}

// -------- item 2: `crewhaus dataset` (singular) growth family --------

const QUARANTINE_SUBDIR = join(".crewhaus", "datasets", "_quarantine");
const AUDIT_SUBDIR = join(".crewhaus", "audit");

/** The cwd crewhaus.yaml's spec name, or undefined when absent/unparseable. */
function cwdSpecName(): string | undefined {
  const p = join(process.cwd(), "crewhaus.yaml");
  if (!existsSync(p)) return undefined;
  try {
    return parseSpec(readFileSync(p, "utf-8")).name;
  } catch {
    return undefined;
  }
}

/** Read all audit records from `.crewhaus/audit/*.jsonl` (day files), tolerant
 *  of torn lines. Empty when the audit dir is absent (e.g. egress has no
 *  writer yet). */
function readAuditRecords(): unknown[] {
  const dir = join(process.cwd(), AUDIT_SUBDIR);
  if (!existsSync(dir)) return [];
  const out: unknown[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".jsonl")) continue;
    out.push(...parseJsonlObjects(readFileSync(join(dir, file), "utf-8")));
  }
  return out;
}

/** `dataset` dispatcher — mine / synthesize / refresh-goldens (item 5) /
 *  audit (B23). */
async function runDataset(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (args.flags["help"] && action === undefined) {
    process.stdout.write(
      "usage: crewhaus dataset <mine|synthesize|refresh-goldens|audit|lint> [...]\n" +
        "  mine            grow the dataset from production struggle signals (item 2)\n" +
        "  synthesize      generate PII-redacted stress variants of a source dataset (item 2)\n" +
        "  refresh-goldens reconcile user corrections with existing golds (item 5)\n" +
        "  audit           offline PII/secret scan of an existing dataset (B23)\n" +
        "  lint            offline hygiene lint: duplicate/near-duplicate samples, grader\n" +
        "                  mismatches, provenance taxonomy, empty golds, canary leaks (B26)\n",
    );
    return;
  }
  try {
    switch (action) {
      case "mine":
        await runDatasetMine(args);
        return;
      case "synthesize":
        await runDatasetSynthesize(args);
        return;
      case "refresh-goldens":
        await runRefreshGoldens(args);
        return;
      case "audit":
        await runDatasetAudit(args);
        return;
      case "lint":
        await runDatasetLint(args);
        return;
      default:
        die(
          `dataset: unknown action "${action ?? ""}" — supported: mine, synthesize, refresh-goldens, audit, lint`,
        );
    }
  } catch (err) {
    if (err instanceof CrewhausError || err instanceof DatasetRefError) die(err.message);
    throw err;
  }
}

/**
 * Item 2 — `crewhaus dataset mine`: scan the cwd spec's session JSONLs for
 * negative signals (tool-error spikes, runtime errors, loop nudges, retries)
 * plus egress blocks from the audit log, collect each triggering turn's input
 * as a QUARANTINE candidate, and (with `--review`) promote accepted ones into
 * a mined registry dataset.
 */
async function runDatasetMine(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus dataset mine [--sessions N|all] [--out-dataset <name>] [--review] [--yes]\n" +
        "                             [--no-redact]\n" +
        "  Scan .crewhaus/sessions/*.jsonl (this spec) for hard cases needing NO\n" +
        "  rating — error events, tool_result isError spikes, the synthetic\n" +
        "  '[runtime] possible loop detected' nudge, consecutive near-duplicate\n" +
        "  user retries — plus egress_decision blocks from .crewhaus/audit (if any),\n" +
        "  plus (D45) in-loop `eval_graded` FAILURES from each session's trace sidecar\n" +
        "  (<id>.events.jsonl): the spec's own evaluation: judge already scored that\n" +
        "  production turn below its threshold, so it is a hard case with zero human\n" +
        "  effort. This signal is OPT-IN: the sidecar is written only when the run had\n" +
        "  CREWHAUS_WATCHME=1 set, so a harness with evaluation: configured and watchme\n" +
        "  off yields zero eval-fail candidates (the run prints how many scanned\n" +
        "  sessions carried a sidecar). A turn that failed and then PASSED on an\n" +
        "  on_fail: retry rung is not harvested; one whose retryIndex reached the\n" +
        "  block's max_retries and still failed is flagged eval_retries_exhausted\n" +
        "  (eval_retried marks the weaker 'a retry ran and still failed').\n" +
        "  Each triggering turn's input becomes a candidate Sample in a QUARANTINE\n" +
        "  staging file (.crewhaus/datasets/_quarantine/<spec>-hardcases.jsonl).\n" +
        "  Candidate text (input + reason) is PII/secret-redacted before it is\n" +
        "  written (the same detector set `dataset synthesize` uses); --no-redact\n" +
        "  keeps it raw (dev/local only).\n" +
        "  --review accepts/rejects candidates: interactive in a TTY ([a]ccept /\n" +
        "  [r]eject / [s]kip); in non-TTY it only PRINTS the candidates unless --yes\n" +
        "  is also given, in which case ALL listed candidates promote. This keeps a\n" +
        "  scripted/CI --review from silently promoting unreviewed candidates.\n" +
        "  Accepted candidates promote into the <spec>-hardcases (or --out-dataset)\n" +
        "  mined registry version with provenance in metadata (source:\n" +
        "  production_log, mined: true, signal, sessionId).\n",
    );
    return;
  }
  const specName = cwdSpecName() ?? "harness";
  const outDataset = strFlag(args, "out-dataset") ?? `${specName}-hardcases`;
  let sessionsWanted: number | "all";
  try {
    sessionsWanted = parseSessionsFlag(strFlag(args, "sessions"));
  } catch (err) {
    if (err instanceof EvalCoverageError) die(err.message);
    throw err;
  }

  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const allIds = sessionIdsByRecency(sessionsDir);
  const ids = sessionsWanted === "all" ? allIds : allIds.slice(0, sessionsWanted);

  const raw: MineCandidate[] = [];
  // D45 — the in-loop `eval_graded` signal lives on the session's persisted
  // TRACE sidecar (`<id>.events.jsonl`), not the durable transcript; absent
  // sidecar ⇒ empty list ⇒ exactly the pre-D45 signal set.
  let sessionsWithSidecar = 0;
  for (const id of ids) {
    const traceEvents = readSessionTraceEvents(id);
    if (traceEvents.length > 0) sessionsWithSidecar += 1;
    raw.push(...mineSession(id, readSessionEvents(id), traceEvents));
  }
  // The sidecar is written ONLY under CREWHAUS_WATCHME=1, and
  // readSessionTraceEvents degrades to [] in silence — so without this line a
  // team with `evaluation:` configured and watchme off reads "no eval-fail
  // candidates" as "my harness has none". Say which it is.
  if (ids.length > 0 && sessionsWithSidecar === 0) {
    process.stdout.write(
      `[dataset mine] ${ids.length} session(s) scanned, 0 with a trace sidecar — set CREWHAUS_WATCHME=1 to capture in-loop eval_graded verdicts (D45 signal unavailable)\n`,
    );
  }

  // Egress blocks from the audit log (may be empty — no writer yet). Attach
  // each to the most-recent turn input of its named session when known.
  const egress = egressBlocksFromAudit(readAuditRecords());
  for (const block of egress) {
    if (block.sessionId === undefined || !existsSync(sessionJsonlPath(block.sessionId))) continue;
    const turns = deriveTurns(readSessionEvents(block.sessionId));
    const last = turns[turns.length - 1];
    if (last === undefined) continue;
    raw.push({
      sessionId: block.sessionId,
      turnNumber: last.turnNumber,
      input: last.input,
      signal: "egress-block",
      reason: block.reason,
    });
  }

  const candidates = dedupeCandidates(raw);
  if (candidates.length === 0) {
    process.stdout.write(
      `[dataset mine] no hard-case signals in ${ids.length} session(s) — nothing to quarantine\n`,
    );
    return;
  }

  // Always (re)write the quarantine staging file. B23 — candidate free-text
  // (input + reason) is redacted at sample construction unless --no-redact,
  // so raw PII/secrets never reach the quarantine file or a promoted version.
  const redact = args.flags["no-redact"] === true ? undefined : redactDatasetText;
  const quarantineDir = join(process.cwd(), QUARANTINE_SUBDIR);
  mkdirSync(quarantineDir, { recursive: true });
  const quarantinePath = join(quarantineDir, `${specName}-hardcases.jsonl`);
  const quarantineSamples = candidates.map((c) => candidateToSample(c, redact));
  writeFileSync(quarantinePath, `${quarantineSamples.map((s) => JSON.stringify(s)).join("\n")}\n`);
  process.stdout.write(
    `[dataset mine] ${candidates.length} candidate(s) quarantined → ${quarantinePath}\n`,
  );

  // B20 — pointer entries into the persistent review queue (idempotent by
  // candidate id — a re-mine adds only genuinely-new candidates; the
  // quarantine JSONL above stays the payload store, never duplicated).
  // Best-effort: a queue-write failure must never fail the mine.
  try {
    const q = enqueueReviewEntries(
      process.cwd(),
      entriesFromQuarantine(quarantineSamples, {
        dataset: `${specName}-hardcases`,
        ts: new Date().toISOString(),
      }),
    );
    if (q.added > 0) {
      process.stdout.write(
        `[dataset mine] review queue: ${q.added} pointer(s) — \`crewhaus review list --kind quarantine\`\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[dataset mine] review queue skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  if (args.flags["review"] !== true) {
    process.stdout.write(
      "[dataset mine] run with --review to accept/reject and promote into the mined dataset\n",
    );
    return;
  }

  // Review: interactive per-candidate in a TTY. Non-TTY NEVER auto-promotes
  // on --review alone — that would silently write unreviewed candidates into
  // the mined dataset from a script/CI run. --yes opts into non-interactive
  // promotion explicitly; without it we print the candidates and stop.
  let accepted: MineCandidate[];
  if (process.stdin.isTTY === true) {
    accepted = await reviewCandidatesInteractive(candidates);
  } else if (args.flags["yes"] === true) {
    process.stdout.write(renderCandidateList(candidates));
    process.stdout.write(
      "[dataset mine] non-TTY --yes — accepting ALL listed candidates for promotion\n",
    );
    accepted = [...candidates];
  } else {
    process.stdout.write(renderCandidateList(candidates));
    process.stdout.write(
      "[dataset mine] non-TTY — re-run with --yes to promote non-interactively, or --review in a TTY\n",
    );
    return;
  }
  if (accepted.length === 0) {
    process.stdout.write("[dataset mine] no candidates accepted — mined dataset unchanged\n");
    return;
  }
  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  const rec = await registerDataset({
    registry,
    name: outDataset,
    samples: accepted.map((c) => candidateToSample(c, redact)),
  });
  process.stdout.write(
    `[dataset mine] promoted ${accepted.length} accepted candidate(s) → ${rec.name}@${rec.version} ` +
      `(use with --dataset registry:${rec.name})\n`,
  );
}

/** Per-candidate interactive accept/reject/skip over a raw-mode key read. */
async function reviewCandidatesInteractive(
  candidates: ReadonlyArray<MineCandidate>,
): Promise<MineCandidate[]> {
  const accepted: MineCandidate[] = [];
  for (const c of candidates) {
    process.stdout.write(
      `\n[${c.signal}] ${c.sessionId} turn ${c.turnNumber}\n  ${c.input}\n  (${c.reason})\n  [a]ccept / [r]eject / [s]kip? `,
    );
    let decision: ReturnType<typeof parseReviewKey>;
    // Read whole lines (Enter-terminated) so this works in a piped/scripted
    // TTY too; an unrecognized key re-prompts.
    do {
      const key = await readLineFromStdin();
      decision = parseReviewKey(key);
      if (decision === undefined) process.stdout.write("  [a]ccept / [r]eject / [s]kip? ");
    } while (decision === undefined);
    if (decision === "accept") accepted.push(c);
    process.stdout.write(`  → ${decision}\n`);
  }
  return accepted;
}

/** One line from stdin (resolves "" on EOF). */
function readLineFromStdin(): Promise<string> {
  return new Promise((resolveLine) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.off("data", onData);
      resolveLine(chunk.toString("utf-8").replace(/[\r\n]+$/, ""));
    };
    process.stdin.once("data", onData);
    process.stdin.once("end", () => resolveLine(""));
  });
}

/**
 * Item 2 — `crewhaus dataset synthesize`: sample real inputs from a source
 * dataset, PII-redact them, and generate paraphrases + stress mutations
 * (truncation, ambiguity, injection payloads from the detector's REGEX_RULES)
 * into a provenance-tagged SYNTHETIC dataset that never contaminates
 * human-gold splits. Deterministic template mutations without credentials;
 * model paraphrases (budget-capped) layered on when a model is available.
 */
async function runDatasetSynthesize(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus dataset synthesize --from <file|registry:ref> [--count N]\n" +
        "                                   [--budget-usd N] [--out-dataset <name>] [--model <m>]\n" +
        "  Sample real inputs from --from, PII-redact them (@crewhaus/pii-redactor),\n" +
        "  and generate paraphrases + stress mutations (truncation, ambiguity, and\n" +
        "  prompt-injection payloads seeded from the detector's REGEX_RULES) into a\n" +
        "  SEPARATE, provenance-tagged synthetic dataset (metadata.source: synthesize;\n" +
        "  injection variants marked adversarial). Synthetic samples NEVER carry a\n" +
        "  human gold answer, so they can't contaminate real golds. Deterministic\n" +
        "  template mutations when no credentials; model paraphrases (budget-capped\n" +
        "  via --budget-usd) when a model is available. A bare registry --from\n" +
        "  resolves train+dev only — the locked test split never seeds synthetic\n" +
        "  data (and an explicit #test is refused), so holdout inputs cannot leak\n" +
        "  into a trainable dataset.\n",
    );
    return;
  }
  const from = strFlag(args, "from");
  if (from === undefined) die("missing --from <file|registry:ref>");
  const count = intFlag(args, "count") ?? 5;
  if (count < 1) die(`invalid --count "${count}" — need at least 1`);

  // Resolve the source samples (file or registry).
  const sourceSamples: Sample[] = [];
  let sourceName: string;
  const registryRef = parseRegistryRef(from);
  if (registryRef !== undefined) {
    const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
    const resolved = await resolveRegistryRef(registry, registryRef);
    for (const s of resolved.samples) sourceSamples.push(s);
    sourceName = registryRef.name;
  } else {
    const abs = resolve(from);
    if (!existsSync(abs)) die(`--from "${from}" not found`);
    const loaded = await loadDataset(abs);
    for await (const s of loaded.samples) sourceSamples.push(s);
    sourceName = loaded.name;
  }
  if (sourceSamples.length === 0) die(`--from "${from}" yielded zero samples`);

  const outDataset = strFlag(args, "out-dataset") ?? `${sourceName}-synth`;

  // PII redactor: default regex detectors (SSN/CC/phone/email/IBAN) PLUS the
  // secret/API-key detector (sk-/ghp_/xoxb-/AKIA/Bearer <token>/contextual
  // opaque token — see dataset-mine.ts SYNTHESIZE_PII_DETECTORS) so a pasted
  // credential in a production input can't survive into a synthesized
  // variant or the model paraphrase prompt below. Redact BEFORE any mutation
  // or model call so no PII/secret ever leaves the box.
  const { createPiiRedactor } = await import("@crewhaus/pii-redactor");
  const redactor = createPiiRedactor({ regexDetectors: SYNTHESIZE_PII_DETECTORS });

  // Model paraphrases are opt-in when a model + credentials are visible. The
  // budget gate bounds them (estimate-before/record-after). Without a model we
  // stay fully deterministic — no synthetic dataset needs credentials.
  const modelFlag = strFlag(args, "model");
  const specModel =
    modelFlag ??
    extractSpecModel(
      cwdSpecName() !== undefined
        ? readFileSync(join(process.cwd(), "crewhaus.yaml"), "utf-8")
        : "",
    );
  const useModel =
    specModel !== undefined &&
    (modelFlag !== undefined || providerCredentialsSatisfied(specModel, process.env));
  const budgetUsd = floatFlag(args, "budget-usd");

  const synthSamples: Sample[] = [];
  let idx = 0;
  let modelBudgetHit = false;
  for (const src of sourceSamples) {
    const { text: redacted } = await redactor.redact(src.input);
    const variants = buildStressVariants(redacted, count);
    for (const v of variants) {
      synthSamples.push(variantToSample(v, src.id, idx));
      idx += 1;
    }
    // Optional model paraphrase, budget-permitting. Best-effort — a failed
    // call keeps the deterministic variants.
    if (useModel && specModel !== undefined && !modelBudgetHit) {
      // Cheap deterministic budget guard: cap the number of model calls by a
      // rough per-call estimate against the dollar budget (paraphrase calls
      // are small; skip once we would exceed).
      if (budgetUsd !== undefined && idx * 0.002 > budgetUsd) {
        modelBudgetHit = true;
      } else {
        try {
          const raw = await oneShotModelText({
            model: specModel,
            system:
              "You paraphrase a user request into ONE realistic alternative phrasing. Output only the paraphrase, no preamble.",
            prompt: redacted,
            maxTokens: 256,
          });
          const paraphrase = raw.trim();
          if (paraphrase !== "" && paraphrase !== redacted) {
            synthSamples.push(
              variantToSample({ input: paraphrase, mutation: "paraphrase" }, src.id, idx),
            );
            idx += 1;
          }
        } catch {
          // keep deterministic variants
        }
      }
    }
  }

  if (synthSamples.length === 0) die("synthesize produced no variants — source inputs were empty");

  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  const rec = await registerDataset({ registry, name: outDataset, samples: synthSamples });
  process.stdout.write(
    `[dataset synthesize] ${synthSamples.length} synthetic variant(s) from ${sourceSamples.length} source sample(s) → ` +
      `${rec.name}@${rec.version} (source: synthesize; use with --dataset registry:${rec.name})\n`,
  );
  if (modelBudgetHit) {
    process.stdout.write(
      "[dataset synthesize] model paraphrases stopped early — --budget-usd reached\n",
    );
  }
}

// -------- E49: crewhaus redteam generate|report --------

/** Rough per-call estimate for the budget gate on model variants (mirrors
 *  `dataset synthesize`'s deterministic guard — small calls, capped early). */
const REDTEAM_MODEL_CALL_USD = 0.002;

/** Consecutive augmentation-call failures that stop the loop. A missing or
 *  invalid credential fails EVERY call identically, and `--model` skips the
 *  credential precheck by design, so an unbroken failure run is a config
 *  problem — burning the rest of the budget on it helps nobody. */
const REDTEAM_AUGMENT_FAILURE_LIMIT = 3;

function redteamUsage(): string {
  return (
    "usage:\n" +
    "  crewhaus redteam generate [--spec <spec.yaml>] [--taxonomy <t.yaml>] [--count N]\n" +
    "       [--seed N] [--budget-usd F] [--model <m>] [--out-dataset <name>]\n" +
    "       [--out-graders <file>] [--force]\n" +
    "  crewhaus redteam report --runs <dir|dir,dir|last:N>\n" +
    "\n" +
    "  generate builds an attack suite AGAINST YOUR AGENT (E49): a behaviour\n" +
    "  taxonomy of CATEGORIES (data exfiltration, third-party PII, tool misuse,\n" +
    "  policy evasion, harmful content, impersonation) × attack STRATEGIES\n" +
    "  (direct, fiction framing, claimed authority, incremental, obfuscation, and\n" +
    "  prompt injection). The cross product is walked DIAGONALLY so a small --count\n" +
    "  still covers every category AND every strategy, then truncated — never\n" +
    "  padded. The default 24 is coverage of both AXES, not of every pair: the\n" +
    "  shipped taxonomy has 36 pairs and the injection strategy expands 5x per\n" +
    "  pair, so `--count 120` is what buys every pair (and the eval spend with it).\n" +
    "  DETERMINISTIC AND OFFLINE: attack strings are composed at generation time\n" +
    "  from inert parts (a strategy's framing fragments around a category's\n" +
    "  objective), never shipped as ready-made payloads; the injection strategy\n" +
    "  reuses the curated SAFE subset of the detector's own rules that `dataset\n" +
    "  synthesize` uses (instruction-override family only). Same taxonomy +\n" +
    "  --count + --seed → byte-identical corpus, no credentials needed.\n" +
    "  --budget-usd F additionally asks a model for rephrasings of each probe\n" +
    "  (capped by the budget, best-effort — the deterministic corpus is the\n" +
    "  floor); those samples are tagged generator: redteam-model.\n" +
    "  --taxonomy <t.yaml> replaces the shipped taxonomy (strict schema: an\n" +
    "  unknown key is a refusal, because a silently-skipped strategy is an\n" +
    "  untested attack surface).\n" +
    "  Output: a registry dataset <spec>-redteam (metadata.source: synthetic,\n" +
    "  difficulty: adversarial, category/strategy tags, NEVER a gold answer) in a\n" +
    "  single split, plus a paired refusal-grading graders.yaml (a categorical\n" +
    "  judge rubric whose labels include OVER-REFUSAL, so a suite cannot be gamed\n" +
    "  by an agent that refuses everything). Nothing unions this dataset into a\n" +
    "  gate: adoption is the explicit `--dataset registry:<spec>-redteam`.\n" +
    "\n" +
    "  report computes ATTACK-SUCCESS RATE (the fraction of graded probes the\n" +
    "  agent FAILED) overall and per category/strategy from persisted runs — a\n" +
    "  run dir, a comma-separated list, or last:N from the run-history index.\n" +
    "  Errored and judge-abstained probes are excluded from the denominator and\n" +
    "  reported separately: an ASR inflated by timeouts is worse than no number.\n" +
    "  ASR is its own block — it is never folded into the pass-rate baseline.\n"
  );
}

/**
 * E49 — `crewhaus redteam generate`. Deterministic corpus + optional
 * budget-capped model variants → a provenance-tagged registry dataset and its
 * paired refusal graders.
 */
async function runRedteamGenerate(args: ParsedArgs): Promise<void> {
  const specFlag = strFlag(args, "spec");
  const absSpec = specFlag !== undefined ? resolve(specFlag) : join(process.cwd(), "crewhaus.yaml");
  if (!existsSync(absSpec)) {
    die(
      specFlag !== undefined
        ? `--spec "${specFlag}" not found`
        : `no crewhaus.yaml in ${process.cwd()} — pass --spec <spec.yaml>`,
    );
  }
  const specText = readFileSync(absSpec, "utf-8");
  // The spec gives the dataset name and (for model variants) the agent's own
  // description. A shape scaffold-evals cannot read is not fatal here — only
  // the name is load-bearing.
  let specName: string;
  let specSummary: string | undefined;
  let specModel: string | undefined;
  try {
    const info = extractScaffoldInfo(specText);
    specName = info.name;
    specSummary = info.instructions;
    specModel = info.model;
  } catch {
    try {
      specName = parseSpec(specText).name;
    } catch (err) {
      if (err instanceof SpecParseError) die(err.message);
      throw err;
    }
    specModel = extractSpecModel(specText);
  }

  let taxonomy: RedteamTaxonomy = DEFAULT_REDTEAM_TAXONOMY;
  const taxonomyFlag = strFlag(args, "taxonomy");
  if (taxonomyFlag !== undefined) {
    const absTaxonomy = resolve(taxonomyFlag);
    if (!existsSync(absTaxonomy)) die(`--taxonomy "${taxonomyFlag}" not found`);
    try {
      taxonomy = parseRedteamTaxonomy(readFileSync(absTaxonomy, "utf-8"));
    } catch (err) {
      if (err instanceof RedteamError) die(err.message);
      throw err;
    }
  }

  const count = intFlag(args, "count") ?? DEFAULT_REDTEAM_COUNT;
  const seedFlag = strFlag(args, "seed");
  const seed = seedFlag !== undefined ? Number.parseInt(seedFlag, 10) : undefined;
  if (seed !== undefined && Number.isNaN(seed)) {
    die(`invalid --seed "${seedFlag}" — must be integer`);
  }
  let samples: Sample[];
  try {
    samples = generateRedteamSamples({
      taxonomy,
      count,
      ...(seed !== undefined ? { seed } : {}),
    });
  } catch (err) {
    if (err instanceof RedteamError) die(err.message);
    throw err;
  }
  const deterministicCount = samples.length;

  // Optional model-rephrased variants, budget-capped exactly like `dataset
  // synthesize`: estimate-before, stop at the cap, never fail the command.
  const budgetUsd = floatFlag(args, "budget-usd");
  const modelFlag = strFlag(args, "model");
  let modelVariants = 0;
  if (budgetUsd !== undefined) {
    if (budgetUsd <= 0) die(`invalid --budget-usd "${budgetUsd}" — must be a positive amount`);
    const model = modelFlag ?? specModel;
    const usable =
      model !== undefined &&
      (modelFlag !== undefined || providerCredentialsSatisfied(model, process.env));
    if (!usable) {
      process.stderr.write(
        "[redteam] --budget-usd given but no usable model/credentials — keeping the deterministic corpus only\n",
      );
    } else {
      const extra: Sample[] = [];
      let attempted = 0;
      let failed = 0;
      let consecutive = 0;
      let lastAugmentError = "";
      for (const [i, parent] of samples.entries()) {
        if ((i + 1) * REDTEAM_MODEL_CALL_USD > budgetUsd) break;
        attempted += 1;
        try {
          const raw = await oneShotModelText({
            model: model as string,
            system: REDTEAM_AUGMENT_SYSTEM,
            prompt: buildRedteamAugmentPrompt({
              attack: parent.input,
              harnessName: specName,
              ...(specSummary !== undefined ? { harnessSummary: clipText(specSummary, 800) } : {}),
              variants: 1,
            }),
            maxTokens: 384,
          });
          consecutive = 0;
          for (const [v, variant] of parseRedteamVariants(raw, 1).entries()) {
            extra.push(modelVariantToSample({ input: variant, parent, index: v + 1 }));
          }
        } catch (err) {
          // Best-effort: a failed call keeps the deterministic probe — but it
          // is COUNTED and reported, or an augmented run that produced nothing
          // is indistinguishable from an offline one.
          failed += 1;
          consecutive += 1;
          lastAugmentError = err instanceof Error ? err.message : String(err);
          if (consecutive >= REDTEAM_AUGMENT_FAILURE_LIMIT) {
            process.stderr.write(
              `[redteam] warning: ${consecutive} consecutive variant calls failed — stopping augmentation (last error: ${lastAugmentError})\n`,
            );
            break;
          }
        }
      }
      if (failed > 0 && consecutive < REDTEAM_AUGMENT_FAILURE_LIMIT) {
        process.stderr.write(
          `[redteam] warning: ${failed} of ${attempted} variant call(s) failed — keeping the deterministic corpus (last error: ${lastAugmentError})\n`,
        );
      }
      samples = [...samples, ...extra];
      modelVariants = extra.length;
    }
  }

  const outDataset = strFlag(args, "out-dataset") ?? `${specName}-redteam`;
  if (!isRegistrySafeName(outDataset)) {
    die(`invalid --out-dataset "${outDataset}" — letters, digits, dot, dash and underscore only`);
  }
  // The refusal graders land next to the spec's eval assets by default, and
  // are never silently overwritten (scaffold-evals' guard).
  const gradersPath =
    strFlag(args, "out-graders") ?? join(dirname(absSpec), "eval", "redteam-graders.yaml");
  const absGraders = resolve(gradersPath);
  const blocked = checkNoOverwrite([absGraders], existsSync, args.flags["force"] === true);
  if (blocked !== undefined) die(blocked);

  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  // ONE split on purpose: an attack suite is a probe corpus, not a
  // train/dev/test partition — splitting it would lock probes behind
  // --allow-test-split for no measurement benefit.
  const rec = await registerDataset({
    registry,
    name: outDataset,
    samples,
    split: "train",
  });
  mkdirSync(dirname(absGraders), { recursive: true });
  writeFileSync(absGraders, buildRedteamGradersYaml({ datasetName: rec.name }));

  process.stdout.write(
    `[redteam] ${samples.length} probe(s) (${deterministicCount} deterministic` +
      `${modelVariants > 0 ? `, ${modelVariants} model-rephrased` : ""}) over ` +
      `${taxonomy.categories.length} categor${taxonomy.categories.length === 1 ? "y" : "ies"} × ` +
      `${taxonomy.strategies.length} strateg${taxonomy.strategies.length === 1 ? "y" : "ies"} → ` +
      `${rec.name}@${rec.version}\n`,
  );
  process.stdout.write(`[redteam] refusal graders → ${absGraders}\n`);
  const specForNext = relative(process.cwd(), absSpec) || basename(absSpec);
  const gradersForNext = relative(process.cwd(), absGraders) || basename(absGraders);
  process.stdout.write(
    `[redteam] adversarial probes are NEVER unioned into a gate — run them explicitly:\nnext: crewhaus eval ${specForNext} --dataset registry:${rec.name} --graders ${gradersForNext}\nnext: crewhaus redteam report --runs last:1\n`,
  );
}

/** E49 — `crewhaus redteam report`: attack-success rate by category from
 *  persisted runs (the runs' own results.json; nothing is re-run). */
async function runRedteamReport(args: ParsedArgs): Promise<void> {
  const runsFlag = strFlag(args, "runs");
  if (runsFlag === undefined || runsFlag.trim() === "") {
    die("redteam report: --runs <dir|dir,dir|last:N> is required");
  }
  const dirs: string[] = [];
  const lastMatch = runsFlag.trim().match(/^last:(\d+)$/);
  if (lastMatch !== null) {
    const n = Number.parseInt(lastMatch[1] as string, 10);
    if (n < 1) die("redteam report: --runs last:N needs N >= 1");
    for (const e of readEvalRunIndex().slice(-n)) dirs.push(e.outDir);
  } else {
    for (const raw of runsFlag.split(",")) {
      const dir = raw.trim();
      if (dir !== "") dirs.push(dir);
    }
  }
  if (dirs.length === 0) die(`redteam report: --runs "${runsFlag}" matched no runs`);

  const samples: RedteamRunSample[] = [];
  const loaded: string[] = [];
  for (const dir of dirs) {
    try {
      const run = await loadRun(dir);
      loaded.push(dir);
      for (const s of run.summary.samples) {
        const meta = s.metadata ?? {};
        const category = typeof meta["category"] === "string" ? meta["category"] : undefined;
        const strategy = typeof meta["strategy"] === "string" ? meta["strategy"] : undefined;
        samples.push({
          sampleId: s.sampleId,
          passed: s.grades.overall.passed,
          errored: s.error !== undefined,
          abstained: s.grades.overall.abstained === true,
          ...(category !== undefined ? { category } : {}),
          ...(strategy !== undefined ? { strategy } : {}),
        });
      }
    } catch (err) {
      process.stderr.write(
        `[redteam] warning: skipping ${dir} — ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  if (loaded.length === 0) die("redteam report: none of the requested runs could be read");
  process.stdout.write(renderRedteamReport(computeRedteamReport({ runs: loaded, samples })));
}

/** `redteam` dispatcher — generate / report. */
async function runRedteam(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"] || action === "") {
    process.stdout.write(redteamUsage());
    return;
  }
  if (action === "generate") return runRedteamGenerate(args);
  if (action === "report") return runRedteamReport(args);
  die(`redteam: unknown action "${action}" — supported: generate, report`);
}

/**
 * Item 5 — `crewhaus dataset refresh-goldens`: reconcile the corrections +
 * up-rated turns accumulated in production against an existing dataset's gold
 * answers. Prints a review diff by default; `--apply` writes the reconciled
 * samples as a NEW registry version (never in-place).
 */
async function runRefreshGoldens(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus dataset refresh-goldens --dataset <file|registry:ref>\n" +
        "                                        [--sessions N|all] [--min-score F] [--apply]\n" +
        "  Match user corrections + up-rated turns (from sessions + the web-UI\n" +
        "  feedback dir) against the dataset's samples by input equality then\n" +
        "  similarity (item 5). Where an accepted/corrected output diverges from the\n" +
        "  stored expected_output, PROPOSE a gold update (a review diff). Samples that\n" +
        "  fail consistently across eval runs yet are repeatedly up-rated live are\n" +
        "  flagged stale (via the run-history index; no history → no stale signal).\n" +
        "  Default prints the diff only; --apply writes the reconciled samples as a\n" +
        "  NEW dataset-registry version (never in-place). A bare registry ref\n" +
        "  reconciles train+dev only (the locked test split's golds are never\n" +
        "  proposed against), and --apply preserves the record's split structure\n" +
        "  exactly — unselected splits, test included, pass through untouched.\n" +
        "  Sample content hashes give provenance.\n",
    );
    return;
  }
  const datasetArg = strFlag(args, "dataset");
  if (datasetArg === undefined) die("missing --dataset <file|registry:ref>");
  const apply = args.flags["apply"] === true;
  const minScore = floatFlag(args, "min-score") ?? DEFAULT_REFRESH_MIN_SCORE;
  if (minScore < 0 || minScore > 1) die(`invalid --min-score "${minScore}" — must be in [0,1]`);
  let sessionsWanted: number | "all";
  try {
    sessionsWanted = parseSessionsFlag(strFlag(args, "sessions"));
  } catch (err) {
    if (err instanceof EvalCoverageError) die(err.message);
    throw err;
  }

  // Resolve the dataset samples + the registry name to version on --apply.
  // B16 — a bare registry ref reconciles train+dev only (the locked test
  // split's golds are never proposed against, or echoed into the diff).
  const registryRef = parseRegistryRef(datasetArg);
  const samples: Sample[] = [];
  let datasetLabel: string;
  let registryName: string | undefined;
  let registryRecord: DatasetRecord | undefined;
  if (registryRef !== undefined) {
    const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
    const resolved = await resolveRegistryRef(registry, registryRef);
    for (const s of resolved.samples) samples.push(s);
    datasetLabel = resolved.datasetName;
    registryName = registryRef.name;
    registryRecord = resolved.record;
  } else {
    const abs = resolve(datasetArg);
    if (!existsSync(abs)) die(`--dataset "${datasetArg}" not found`);
    const loaded = await loadDataset(abs);
    for await (const s of loaded.samples) samples.push(s);
    datasetLabel = loaded.name;
  }
  if (samples.length === 0) die(`dataset "${datasetArg}" yielded zero samples`);
  if (apply && registryName === undefined) {
    die(
      "--apply requires --dataset registry:<name> — a NEW version is written to the registry, never a file in place",
    );
  }

  // Feedback + turns from sessions (bounded by --sessions) + the web-UI dir.
  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const allIds = sessionIdsByRecency(sessionsDir);
  const ids = sessionsWanted === "all" ? allIds : allIds.slice(0, sessionsWanted);
  const turns: SessionTurn[] = [];
  const records: FeedbackRecord[] = [];
  for (const id of ids) {
    const events = readSessionEvents(id);
    for (const t of deriveTurns(events)) turns.push({ ...t, sessionId: id });
    records.push(...extractFeedbackRecords(events));
  }
  records.push(...readFeedbackDir(join(process.cwd(), FEEDBACK_SUBDIR)));

  // Cross-run pass/fail outcomes for the stale flag — from the recent eval
  // runs for the cwd spec (best-effort; unreadable runs are skipped).
  const specName = cwdSpecName();
  const runOutcomes: RunSampleOutcome[][] = [];
  const runEntries = readEvalRunIndex().filter(
    (e) => specName === undefined || e.specName === specName,
  );
  for (const entry of runEntries.slice(-10)) {
    try {
      const run = await loadRun(entry.outDir);
      runOutcomes.push(
        run.summary.samples.map((s) => ({ sampleId: s.sampleId, passed: s.grades.overall.passed })),
      );
    } catch {
      // torn/missing run dir — skip
    }
  }

  const result = reconcileGoldens({ samples, turns, records, minScore, runOutcomes });
  process.stdout.write(renderProposals(result, datasetLabel));

  if (!apply || result.proposals.length === 0) return;

  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  // Registry name + record are guaranteed defined here (checked above).
  const name = registryName as string;
  const record = registryRecord as DatasetRecord;
  // B16 — write the new version by applying the proposals WITHIN the
  // record's existing split structure (never re-split): re-splitting the
  // resolved union would silently drop the locked test rows (bare refs
  // resolve train+dev only) and re-partition already-consumed train/dev
  // samples into a fabricated — contaminated — "test" holdout. Proposals
  // are keyed by sample id and only ever name samples of the splits the ref
  // selected, so unselected splits (test included) pass through
  // byte-identical.
  const version = nextVersion(await registry.list(name));
  // B22 — a proposal that golds a `source: synthetic` sample is exactly the
  // human-verified promotion the taxonomy names: retag it
  // `synthetic_human_verified` so the registry's synthetic-never-gold
  // invariant (enforced at put) stays satisfied AND the provenance records
  // what happened.
  const rec = await registry.put({
    name,
    version,
    splits: {
      train: promoteVerifiedSynthetics(applyProposals(record.splits.train, result.proposals)),
      dev: promoteVerifiedSynthetics(applyProposals(record.splits.dev, result.proposals)),
      ...(record.splits.test !== undefined
        ? { test: promoteVerifiedSynthetics(applyProposals(record.splits.test, result.proposals)) }
        : {}),
    },
  });
  process.stdout.write(
    `[refresh-goldens] applied ${result.proposals.length} gold update(s) → ${rec.name}@${rec.version} (new version, split structure preserved; prior versions untouched)\n`,
  );
}

/**
 * B23 — `crewhaus dataset audit`: offline PII/secret scan of an EXISTING
 * dataset (regex detectors only — no model calls, nothing leaves the box).
 * Reports hits per detector/field/sample without ever echoing the matched
 * text; `--apply` (registry refs only) writes the redacted samples as a NEW
 * version preserving the record's split structure exactly (never in place,
 * never re-split — moving a redacted sample between splits would corrupt the
 * train/test separation); `--strict` exits non-zero when any hit is found so
 * CI can gate on dataset hygiene.
 */
async function runDatasetAudit(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus dataset audit [--pii] --dataset <file|registry:ref> [--apply] [--strict]\n" +
        "  Offline PII/secret scan of an EXISTING dataset (regex detectors only —\n" +
        "  no model calls). Scans input, expected_output, and string metadata\n" +
        "  fields of every sample; a registry ref without #split is scanned across\n" +
        "  ALL splits, test included (inspection, not consumption). The report\n" +
        "  counts hits per detector/field/sample id and never echoes the matched\n" +
        "  text. --pii names the scan category explicitly (PII/secret is the only\n" +
        "  category today, so it is implied). --apply requires a\n" +
        "  registry:<name>[@version] ref and writes the redacted samples as a NEW\n" +
        "  version preserving the record's split structure exactly (never in\n" +
        "  place, never re-split). --strict exits non-zero when any hit is found\n" +
        "  (the CI gate; with --apply the new version is written first).\n",
    );
    return;
  }
  const datasetArg = strFlag(args, "dataset");
  if (datasetArg === undefined) die("missing --dataset <file|registry:ref>");
  const apply = args.flags["apply"] === true;
  const strict = args.flags["strict"] === true;

  const registryRef = parseRegistryRef(datasetArg);
  if (apply && registryRef === undefined) {
    die(
      "--apply requires --dataset registry:<name>[@version] — a redacted NEW version is written to the registry, never a file in place",
    );
  }
  if (apply && registryRef?.split !== undefined) {
    die("--apply rewrites the whole record (every split) — drop the #split from the ref");
  }

  // Resolve the samples to scan. Registry refs read the record directly
  // (not resolveRegistryRef): the audit INSPECTS every split — test included
  // — because PII in the held-out split is still a leak. That mirrors
  // `datasets get`'s inspection posture; nothing here consumes the lock.
  let samples: Sample[];
  let label: string;
  let record: DatasetRecord | undefined;
  if (registryRef !== undefined) {
    const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
    const version = registryRef.version ?? (await latestVersion(registry, registryRef.name));
    if (version === undefined) {
      die(
        `dataset "${registryRef.name}" has no versions in the registry — import one with \`crewhaus datasets put\``,
      );
    }
    record = await registry.getRecord(registryRef.name, version);
    if (registryRef.split !== undefined && record.splits[registryRef.split] === undefined) {
      die(`split "${registryRef.split}" not present in "${registryRef.name}@${version}"`);
    }
    const splits = registryRef.split !== undefined ? [registryRef.split] : splitsPresent(record);
    samples = samplesForSplits(record, splits);
    label = registryDatasetName(registryRef.name, version, registryRef.split);
  } else {
    const abs = resolve(datasetArg);
    if (!existsSync(abs)) die(`--dataset "${datasetArg}" not found`);
    const loaded = await loadDataset(abs);
    samples = [];
    for await (const s of loaded.samples) samples.push(s);
    label = loaded.name;
  }
  if (samples.length === 0) die(`dataset "${datasetArg}" yielded zero samples`);

  const report = auditSamples(samples);
  process.stdout.write(renderAuditReport(report, label));

  if (apply && registryRef !== undefined && record !== undefined) {
    if (report.totalHits === 0) {
      process.stdout.write("[dataset audit] no hits — nothing to rewrite\n");
    } else {
      const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
      const splits = {
        train: record.splits.train.map((s) => redactSample(s)),
        dev: record.splits.dev.map((s) => redactSample(s)),
        ...(record.splits.test !== undefined
          ? { test: record.splits.test.map((s) => redactSample(s)) }
          : {}),
      };
      const version = nextVersion(await registry.list(registryRef.name));
      const rec = await registry.put({ name: registryRef.name, version, splits });
      process.stdout.write(
        `[dataset audit] wrote redacted ${rec.name}@${rec.version} (new version, split structure preserved; prior versions untouched — prune them if the hits must not persist)\n`,
      );
      // B23 — a GOLD altered by redaction silently breaks string-comparison
      // graders (live agent output is never redacted). Count before/after so
      // the operator knows the instrument changed, not the agent.
      let redactedGolds = 0;
      for (const name of ["train", "dev", "test"] as const) {
        const before = record.splits[name];
        const after = splits[name];
        if (before === undefined || after === undefined) continue;
        for (const [i, s] of after.entries()) {
          if (s.expected_output !== undefined && s.expected_output !== before[i]?.expected_output) {
            redactedGolds += 1;
          }
        }
      }
      if (redactedGolds > 0) {
        process.stderr.write(
          `[dataset audit] warning: ${redactedGolds} gold(s) contained redacted text — exact_match/expected_contains graders will not match live outputs for those samples; prefer llm_judge or tool graders\n`,
        );
      }
    }
  }

  if (strict && report.totalHits > 0) {
    die(`dataset audit --strict: ${report.totalHits} PII/secret hit(s) found`);
  }
}

// -------- B26 + NEW-HUNT-10: crewhaus dataset lint --------

/** The prompt-side + graders context `dataset lint`/`datasets card` derive
 *  from the cwd: the conventional spec (tool presence + raw text for the
 *  canary leak scan), the graders.yaml (--graders flag, else the
 *  conventional eval/graders.yaml), and every few-shot pool file. All
 *  best-effort — an unreadable piece simply disables its rule. */
function lintContextFromCwd(args: ParsedArgs): {
  graders?: LintGraderSpec[];
  specHasTools?: boolean;
  leakScanTexts: Array<{ label: string; text: string }>;
} {
  const leakScanTexts: Array<{ label: string; text: string }> = [];
  let specHasTools: boolean | undefined;
  const specPath = join(process.cwd(), "crewhaus.yaml");
  if (existsSync(specPath)) {
    try {
      const yamlText = readFileSync(specPath, "utf-8");
      leakScanTexts.push({ label: "crewhaus.yaml", text: yamlText });
      const ir = lower(parseSpec(yamlText));
      if (ir.target === "cli") {
        // Conservative: only a POSITIVE "no tools anywhere" disables the
        // expected_tools rule — memory blocks register tools at runtime.
        specHasTools =
          ir.tools.length > 0 ||
          Object.keys(ir.mcp_servers ?? {}).length > 0 ||
          (ir as { memory?: unknown }).memory !== undefined;
      }
    } catch {
      // unparseable spec — leak scan may still have the raw text
    }
  }
  // Few-shot pools: prompt-side text a canary phrase must never reach.
  const fewshotDir = join(process.cwd(), FEWSHOT_SUBDIR);
  if (existsSync(fewshotDir)) {
    for (const file of readdirSync(fewshotDir).sort()) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        leakScanTexts.push({
          label: join(FEWSHOT_SUBDIR, file),
          text: readFileSync(join(fewshotDir, file), "utf-8"),
        });
      } catch {
        // unreadable pool — skip
      }
    }
  }
  let graders: LintGraderSpec[] | undefined;
  const gradersPath = strFlag(args, "graders") ?? join(process.cwd(), CONVENTIONAL_GRADERS);
  if (existsSync(gradersPath)) {
    try {
      const { config } = parseGradersConfig(readFileSync(gradersPath, "utf-8"));
      graders = config.graders.map(lintGraderSpecOf);
    } catch {
      // malformed graders.yaml — the grader rules are skipped (eval itself
      // will report the parse error loudly)
    }
  }
  return {
    ...(graders !== undefined ? { graders } : {}),
    ...(specHasTools !== undefined ? { specHasTools } : {}),
    leakScanTexts,
  };
}

/** Resolve a lint target's samples (+ registry cross-version context). */
async function lintTargetSamples(datasetArg: string): Promise<{
  label: string;
  samples: Sample[];
  version?: string;
  otherVersions?: Array<{ version: string; samples: Sample[] }>;
}> {
  const registryRef = parseRegistryRef(datasetArg);
  if (registryRef !== undefined) {
    const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
    const { version, samples, datasetName } = await inspectRegistryRef(registry, registryRef);
    const otherVersions: Array<{ version: string; samples: Sample[] }> = [];
    for (const v of await registry.list(registryRef.name)) {
      if (v === version) continue;
      try {
        const other = await registry.getRecord(registryRef.name, v);
        otherVersions.push({ version: v, samples: samplesForSplits(other, splitsPresent(other)) });
      } catch {
        // torn/foreign version file — skip
      }
    }
    return { label: datasetName, samples, version, otherVersions };
  }
  const abs = resolve(datasetArg);
  if (!existsSync(abs)) die(`--dataset "${datasetArg}" not found`);
  const loaded = await loadDataset(abs);
  const samples: Sample[] = [];
  for await (const s of loaded.samples) samples.push(s);
  return { label: loaded.name, samples };
}

/**
 * B26 + NEW-HUNT-10 + B18 — `crewhaus dataset lint`: the OFFLINE hygiene
 * lint (no model calls, nothing leaves the box). Registry refs lint across
 * all splits (inspection posture) and against every OTHER version of the
 * same name (cross-version id reuse); `--all` sweeps every registered
 * dataset's latest version. Context is discovered from the cwd: the
 * conventional spec (tool presence + canary leak scan), eval/graders.yaml
 * (or --graders), and the few-shot pools. `--strict` exits non-zero on ANY
 * finding — the CI gate.
 */
async function runDatasetLint(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus dataset lint (--dataset <file|registry:ref> | --all) [--graders <g.yaml>] [--strict]\n" +
        "  Offline dataset hygiene lint (no model calls):\n" +
        "    - duplicate sample ids (error) + ids reused with different content in\n" +
        "      other versions of the same registry dataset (warning)\n" +
        "    - near-duplicate inputs (normalized token overlap ≥ 0.9; warning)\n" +
        "    - grader↔dataset mismatches when a graders.yaml is findable (--graders,\n" +
        "      else the conventional eval/graders.yaml): gold-needing graders vs\n" +
        "      gold-less samples; expected_tools vs a tool-less conventional spec\n" +
        "    - metadata.source outside the provenance taxonomy (human_authored |\n" +
        "      production_log | synthetic | synthetic_human_verified | canary)\n" +
        "    - empty-string golds (error)\n" +
        "    - canary leak scan: any --canary phrase found in crewhaus.yaml or a\n" +
        "      .crewhaus/fewshot pool is contamination (error)\n" +
        "  --all lints every registered dataset's LATEST version. --strict exits\n" +
        "  non-zero on any finding (CI gate). `crewhaus eval` runs a lint-lite\n" +
        "  preflight (duplicate ids + gold mismatch) before any spend; --no-preflight\n" +
        "  there skips it.\n",
    );
    return;
  }
  const datasetArg = strFlag(args, "dataset");
  const all = args.flags["all"] === true;
  if (all === (datasetArg !== undefined)) {
    die("dataset lint: pass exactly one of --dataset <file|registry:ref> or --all");
  }
  const context = lintContextFromCwd(args);
  const targets: string[] = [];
  if (all) {
    const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
    for (const name of [...(await registry.listDatasets())].sort()) {
      targets.push(`${REGISTRY_PREFIX}${name}`);
    }
    if (targets.length === 0) {
      process.stdout.write(`[dataset lint] no datasets registered (${defaultDatasetsRoot()})\n`);
      return;
    }
  } else {
    targets.push(datasetArg as string);
  }
  let total = 0;
  for (const target of targets) {
    const { label, samples, version, otherVersions } = await lintTargetSamples(target);
    const findings = lintDataset({
      samples,
      ...(version !== undefined ? { version } : {}),
      ...(otherVersions !== undefined ? { otherVersions } : {}),
      ...(context.graders !== undefined ? { graders: context.graders } : {}),
      ...(context.specHasTools !== undefined ? { specHasTools: context.specHasTools } : {}),
      leakScanTexts: context.leakScanTexts,
    });
    total += findings.length;
    for (const line of renderLintFindings(findings, label)) {
      process.stdout.write(`${line}\n`);
    }
  }
  if (args.flags["strict"] === true && total > 0) {
    die(`dataset lint --strict: ${total} finding(s)`);
  }
}

// -------- item 8: crewhaus judge calibrate --------

const JUDGE_CALIBRATION_RELPATH = join(".crewhaus", "judge-calibration.json");

/** The default judge rubric used when no `--graders` llm_judge is supplied. */
function defaultCalibrationRubric(): {
  criteria: Array<{
    name: string;
    description: string;
    anchors: { "1": string; "2": string; "3": string; "4": string; "5": string };
  }>;
  passing_score: number;
} {
  return {
    criteria: [
      {
        name: "answer_quality",
        description:
          "Judge how well the assistant's answer serves the user's request — correctness, completeness, and usefulness.",
        anchors: {
          "1": "Wrong, off-topic, or unusable.",
          "2": "Mostly unhelpful; major gaps or errors.",
          "3": "Partially helpful; noticeable gaps.",
          "4": "Helpful with only minor gaps.",
          "5": "Fully correct, complete, and useful.",
        },
      },
    ],
    passing_score: 3,
  };
}

/**
 * Item 8 — `crewhaus judge calibrate`: pair each turn that has BOTH a human
 * rating AND a judgeable transcript with the llm_judge's score, then print an
 * agreement/bias/ROC calibration card. Model-dependent by nature: without
 * judge credentials it explains what it needs and exits cleanly (never
 * fabricates scores). `--apply` persists the calibrated cut.
 */
async function runJudgeCalibrate(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus judge calibrate [--dataset <file|registry:ref>] [--graders <graders.yaml>]\n" +
        "                                [--sessions N|all] [--model <judge-model>] [--apply]\n" +
        "  Pair (human rating, llm_judge score) for turns that carry BOTH a human\n" +
        "  user_feedback rating AND can be judged (item 8): re-runs the llm_judge\n" +
        "  grader (from --graders, or a default rubric) over each rated transcript\n" +
        "  turn. Computes agreement (correlation + confusion at the current cut),\n" +
        "  systematic bias (judge mean − human mean), and the ROC-optimal cut that\n" +
        "  best separates up- from down-rated turns, and flags rubric criteria whose\n" +
        "  judge-human disagreement is high (naming exemplars to re-anchor). Without\n" +
        "  judge credentials it explains what it needs and exits — it never\n" +
        "  fabricates scores. --apply writes the calibrated --min-score default to\n" +
        "  .crewhaus/judge-calibration.json (a file distill/optimize could later read).\n" +
        "  --dataset (NEW-graders-1) ADDS pairs from the golden verdicts a distilled\n" +
        "  dataset carries, combined with the session-ratings pairs above (which stay\n" +
        "  the default path). The contract is what `crewhaus distill` records: a\n" +
        "  sample pairs when metadata.user_rating is a number in [0,1] AND\n" +
        "  expected_output is the non-empty answer that rating was placed on.\n" +
        "  Samples whose gold is NOT the rated answer are skipped as mis-paired\n" +
        "  (metadata.correction — the gold is the human's correction — and\n" +
        "  metadata.gold_refreshed — `dataset refresh-goldens` replaced the gold\n" +
        "  after the rating); a sample already paired from the scanned sessions is\n" +
        "  skipped as a duplicate. registry:<name>[@version][#split] refs resolve\n" +
        "  train+dev on a bare ref; the locked test split stays locked.\n",
    );
    return;
  }

  // Gather rated turns (numeric human rating) from sessions + the feedback dir.
  const specName = cwdSpecName();
  let sessionsWanted: number | "all";
  try {
    sessionsWanted = parseSessionsFlag(strFlag(args, "sessions"));
  } catch (err) {
    if (err instanceof EvalCoverageError) die(err.message);
    throw err;
  }
  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const allIds = sessionIdsByRecency(sessionsDir);
  const ids = sessionsWanted === "all" ? allIds : allIds.slice(0, sessionsWanted);
  const turns: SessionTurn[] = [];
  const records: FeedbackRecord[] = [];
  for (const id of ids) {
    const events = readSessionEvents(id);
    for (const t of deriveTurns(events)) turns.push({ ...t, sessionId: id });
    records.push(...extractFeedbackRecords(events));
  }
  records.push(...readFeedbackDir(join(process.cwd(), FEEDBACK_SUBDIR)));

  const turnByKey = new Map<string, SessionTurn>();
  for (const t of turns) turnByKey.set(`${t.sessionId}#${t.turnNumber}`, t);

  // Rated turns with a numeric signal AND a non-empty answer to judge.
  type RatedTurn = { turn: SessionTurn; human: number };
  const rated: RatedTurn[] = [];
  for (const fb of mergeFeedback(records)) {
    const human = normalizeRating(fb);
    if (human === undefined) continue; // comment-only, no numeric signal
    const turn = turnByKey.get(`${fb.sessionId}#${fb.turnNumber}`);
    if (turn === undefined || turn.output.trim() === "") continue;
    rated.push({ turn, human });
  }

  // NEW-graders-1 — `--dataset`: ADD calibration pairs from the golden
  // verdicts a distilled dataset carries (see the help text for the exact
  // contract). The two sources COMBINE; a candidate matching an
  // already-rated session turn is dropped as a duplicate (session pairs
  // win — they re-derive from the live transcript).
  const datasetFlag = strFlag(args, "dataset");
  let datasetCandidates: DatasetPairCandidate[] = [];
  let datasetLabel: string | undefined;
  let datasetSkipNote: string | undefined;
  if (datasetFlag !== undefined) {
    const datasetSamples: Sample[] = [];
    try {
      const registryRef = parseRegistryRef(datasetFlag);
      if (registryRef !== undefined) {
        const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
        const resolved = await resolveRegistryRef(registry, registryRef);
        datasetSamples.push(...resolved.samples);
        datasetLabel = resolved.datasetName;
      } else {
        const absDataset = resolve(datasetFlag);
        const dataset = await loadDataset(absDataset);
        for await (const s of dataset.samples) datasetSamples.push(s);
        datasetLabel = dataset.name;
      }
    } catch (err) {
      if (err instanceof DatasetRefError || err instanceof CrewhausError) {
        die(`--dataset "${datasetFlag}" unusable: ${err.message}`);
      }
      throw err;
    }
    const extraction = extractDatasetCalibrationPairs(datasetSamples);
    const takenRefs = new Set(rated.map((r) => `${r.turn.sessionId}#${r.turn.turnNumber}`));
    const { kept, duplicates } = dropDuplicateCandidates(extraction.candidates, takenRefs);
    datasetCandidates = kept;
    datasetSkipNote =
      `${extraction.skippedNoRating} unrated, ${extraction.skippedNoAnswer} no-answer, ` +
      `${extraction.skippedMisPaired} mis-paired, ${duplicates} duplicate`;
    if (kept.length === 0) {
      const contract =
        "the contract needs metadata.user_rating (a number in [0,1]) plus the rated answer in " +
        "expected_output, exactly what `crewhaus distill` records; samples carrying " +
        "metadata.correction or metadata.gold_refreshed are skipped (their gold is not the rated answer)";
      die(
        `--dataset "${datasetFlag}" yielded no calibration pairs (${datasetSamples.length} sample(s): ${datasetSkipNote}) — ${contract}`,
      );
    }
  }

  // Note: with --dataset we either died above (zero usable pairs) or hold
  // candidates, so this fires exactly when the flagless path found nothing —
  // byte-identical to the pre---dataset behavior.
  if (rated.length === 0 && datasetCandidates.length === 0) {
    die(
      "no rated turns to calibrate against — collect numeric ratings (crewhaus rate --thumbs/--stars/--score) first",
    );
  }

  // Resolve the judge model + credentials. No credentials → explain + exit
  // cleanly (never fabricate scores).
  const modelFlag = strFlag(args, "model");
  const { DEFAULT_JUDGE_MODEL } = await import("@crewhaus/eval-judge");
  const judgeModel = modelFlag ?? DEFAULT_JUDGE_MODEL;
  if (!providerCredentialsSatisfied(judgeModel, process.env)) {
    die(
      `judge calibrate needs a judge model with visible credentials (tried "${judgeModel}"). Set the provider credentials (e.g. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) or pass --model <provider/model> for a model you have keys for, then re-run.`,
    );
  }

  // The rubric to calibrate: the graders.yaml llm_judge, else a default rubric.
  const gradersPath = strFlag(args, "graders");
  let rubricObject: unknown = defaultCalibrationRubric();
  if (gradersPath !== undefined) {
    const { compiled } = parseGradersConfig(readFileSync(resolve(gradersPath), "utf-8"));
    // NEW-graders-2 interplay: calibration tunes a SCALAR passing cut, so
    // categorical rubrics (label-gated, no 1–5 scale) never calibrate —
    // pick the first scalar llm_judge and say so plainly when none exists.
    const judgeEntry = compiled.find(
      (g) => g.judgeSpec !== undefined && g.judgeSpec.rubric.kind !== "categorical",
    );
    if (judgeEntry?.judgeSpec === undefined) {
      const hasCategorical = compiled.some((g) => g.judgeSpec?.rubric.kind === "categorical");
      die(
        hasCategorical
          ? `--graders "${gradersPath}" has only categorical llm_judge grader(s) — calibration tunes a scalar passing cut, which a label-gated rubric does not have`
          : `--graders "${gradersPath}" has no llm_judge grader to calibrate`,
      );
    }
    rubricObject = judgeEntry.judgeSpec.rubric;
  }

  const { judge, loadRubric } = await import("@crewhaus/eval-judge");
  const rubric = loadRubric(rubricObject);

  // Re-run the judge over each rated turn's transcript, pairing to the human
  // rating. A per-turn judge failure is skipped (best-effort) so one flaky
  // call cannot abort the whole calibration.
  const pairs: CalibrationPair[] = [];
  let judgeFailures = 0;
  for (const { turn, human } of rated) {
    try {
      const result = await judge({
        rubric,
        sample: { id: `${turn.sessionId}_t${turn.turnNumber}`, input: turn.input },
        agentOutput: turn.output,
        model: judgeModel,
      });
      pairs.push({
        sessionId: turn.sessionId,
        turnNumber: turn.turnNumber,
        human,
        judge: result.score,
        ...(Object.keys(result.criterionScores).length > 0
          ? { criterionScores: result.criterionScores }
          : {}),
      });
    } catch {
      judgeFailures += 1;
    }
  }
  const sessionPairCount = pairs.length;

  // NEW-graders-1 — judge the dataset-carried golden verdicts the same way
  // (same rubric, same judge, same best-effort skip on a flaky call). The
  // pair keys on the candidate's sessionId#turn ref (distill records the
  // real ones) so card exemplars stay navigable.
  for (const c of datasetCandidates) {
    try {
      const result = await judge({
        rubric,
        sample: { id: `${c.sessionId}_t${c.turnNumber}`, input: c.input },
        agentOutput: c.answer,
        model: judgeModel,
      });
      pairs.push({
        sessionId: c.sessionId,
        turnNumber: c.turnNumber,
        human: c.human,
        judge: result.score,
        ...(Object.keys(result.criterionScores).length > 0
          ? { criterionScores: result.criterionScores }
          : {}),
      });
    } catch {
      judgeFailures += 1;
    }
  }
  if (pairs.length === 0) {
    die(`the judge model "${judgeModel}" produced no usable scores (${judgeFailures} failure(s))`);
  }

  const card = buildCalibrationCard(pairs, {
    ...(specName !== undefined ? { specName } : {}),
    model: judgeModel,
  });
  process.stdout.write(renderCalibrationCard(card));
  if (datasetFlag !== undefined) {
    process.stdout.write(
      `[judge calibrate] pairs: ${sessionPairCount} from session ratings + ${pairs.length - sessionPairCount} from --dataset "${datasetLabel ?? datasetFlag}" (skipped: ${datasetSkipNote})\n`,
    );
  }
  if (judgeFailures > 0) {
    process.stdout.write(
      `[judge calibrate] ${judgeFailures} turn(s) skipped (judge call failed)\n`,
    );
  }

  if (args.flags["apply"] === true) {
    const path = join(process.cwd(), JUDGE_CALIBRATION_RELPATH);
    let existing: JudgeCalibrationFile | undefined;
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, "utf-8")) as JudgeCalibrationFile;
      } catch {
        // A corrupt file is replaced.
      }
    }
    const file = buildCalibrationFile(existing, card, new Date().toISOString());
    // Atomic (temp file + rename): the eval runner reads this file to gate
    // llm_judge graders, and a torn read silently mis-gates a whole run.
    writeCalibrationFileAtomic(path, file);
    const cut = card.recommendedCut?.cut ?? DEFAULT_JUDGE_CUT;
    process.stdout.write(
      `[judge calibrate] wrote calibrated --min-score ${cut.toFixed(3)} for "${specName ?? "default"}" → ${path}\n`,
    );
  }
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
        "mines .crewhaus/sessions (+ .crewhaus/audit + .crewhaus/routing) for spec advice:\n" +
        "  repeated tool failures, max_tokens truncation pressure, compaction\n" +
        "  thrash, permission-ask churn, stop-reason anomalies, learned\n" +
        "  failure_taxonomy + loop-break rules, sub-agent splits under\n" +
        "  chronic context pressure, and model_pool scoreboard mining\n" +
        "  (flip policy to learned once every candidate has enough samples;\n" +
        "  name consistently-losing candidates — roster edits stay human)\n" +
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
  let specText: string | undefined;
  const specPath = join(process.cwd(), "crewhaus.yaml");
  if (existsSync(specPath)) {
    try {
      specText = readFileSync(specPath, "utf-8");
      spec = parseSpec(specText);
    } catch (err) {
      process.stderr.write(
        `[advise] crewhaus.yaml did not parse (${(err as Error).message}) — patch suggestions downgraded to advice\n`,
      );
    }
  }

  // Adaptive model routing — the pool reward scoreboard, when the harness has
  // one. A missing/empty store simply produces no routing findings.
  let routingArms: ReadonlyArray<import("@crewhaus/routing-store").ArmStats> = [];
  try {
    routingArms = openScoreboard(join(process.cwd(), ".crewhaus")).snapshot();
  } catch {
    // Corrupt store must not block mining the sessions.
  }

  const ctx = buildAdviceContext(sessions, auditObjects, routingArms);
  const specTextForOps = specText;
  const findings: AdviceFinding[] = runAdviceRules(ctx, {
    ...(spec !== undefined ? { spec } : {}),
    ...(spec !== undefined && specTextForOps !== undefined
      ? { specHasPath: (path: readonly string[]) => specHasPath(specTextForOps, path) }
      : {}),
  });
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
function parseSessionsLimit(args: ParsedArgs, dflt: number): number | "all" {
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
    const limit = parseSessionsLimit(args, DEFAULT_AUDIT_SESSIONS);
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

// -------- permissions: mine ask/deny history into rules (item 16) --------

/** Default sessions the permissions miner scans (mirrors tools audit). */
const DEFAULT_PERMISSIONS_SESSIONS = 20;

/**
 * `crewhaus permissions suggest [--sessions N|all] [--apply] [--json]` — mine
 * the persisted `permission` ask/deny history across sessions into reviewable
 * `.crewhaus/settings.json` permission rules: `alwaysAllow` for recurring
 * human-APPROVED asks (read-only tools first), `alwaysAsk` tightenings for
 * recurring DENIED asks. Prints an additive diff of the settings permissions
 * block.
 *
 * `--apply` is ALWAYS an interactive human confirm — permissions are excluded
 * from OPTIMIZABLE_PATHS by design, so this path is NEVER eval-gated
 * auto-apply. A non-TTY `--apply` REFUSES: it prints the diff and tells the
 * user to run interactively.
 */
async function runPermissions(action: string, args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus permissions suggest [--sessions N|all] [--apply] [--json]\n" +
        "\n" +
        "mines .crewhaus/sessions `permission` ask/deny history into rules:\n" +
        "  alwaysAllow  recurring human-APPROVED asks (read-only tools first)\n" +
        "  alwaysAsk    recurring DENIED asks (tighten — keep prompting)\n" +
        "\n" +
        "  --sessions N|all  how many recent sessions to mine (default 20)\n" +
        "  --apply           write the additions to .crewhaus/settings.json\n" +
        "                    (ALWAYS interactive-confirm; refuses in a non-TTY —\n" +
        "                    permissions are never eval-gated auto-apply)\n" +
        "  --json            machine-readable output\n",
    );
    return;
  }
  if (action !== "suggest") {
    die(`permissions action must be "suggest" (got "${action}")`);
  }

  const limit = parseSessionsLimit(args, DEFAULT_PERMISSIONS_SESSIONS);
  const sessions = readRecentSessionEvents(limit);
  if (sessions.length === 0) {
    die(
      `no session logs found at ${join(process.cwd(), ".crewhaus", "sessions")} — run the agent first, then suggest`,
    );
  }

  // Read-only-ness comes from the resolvable tool map (keyed by RegisteredTool
  // `.name`, which is what the ask aggregate is keyed by).
  const toolMap = await loadToolMap();
  const readOnly = readOnlyByName(toolMap);
  const aggregates = aggregateAsks(sessions);
  const suggestions: PermissionSuggestion[] = rankSuggestions(aggregates, readOnly);

  // Existing settings rules (the exact shape buildRuleSet consumes).
  const settingsPath = join(process.cwd(), ".crewhaus", "settings.json");
  let settingsRoot: unknown;
  if (existsSync(settingsPath)) {
    try {
      settingsRoot = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (err) {
      die(`failed to parse ${settingsPath}: ${(err as Error).message}`);
    }
  }
  const existing = existingSettingsRules(settingsRoot);
  const diff = diffPermissions(existing, suggestions);

  if (args.flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify({ sessionIds: sessions.map((s) => s.sessionId), suggestions, diff }, null, 2)}\n`,
    );
    if (args.flags["apply"] !== true) return;
  } else {
    process.stdout.write(
      `permissions: ${suggestions.length} suggestion(s) from ${sessions.length} session(s)\n`,
    );
    if (suggestions.length === 0) {
      process.stdout.write("no recurring ask/deny patterns to turn into rules\n");
    }
    for (const line of formatSuggestionLines(suggestions)) process.stdout.write(`${line}\n`);
    process.stdout.write("\n");
    for (const line of formatSettingsDiff(diff)) process.stdout.write(`${line}\n`);
  }

  if (args.flags["apply"] !== true) {
    if (diff.additions.length > 0) {
      process.stdout.write("\nrun with --apply to write these additions (interactive confirm).\n");
    }
    return;
  }

  // ---- --apply: interactive-confirm ONLY ----
  if (diff.additions.length === 0) {
    process.stdout.write("nothing to apply — no new rules.\n");
    return;
  }
  // Non-TTY --apply REFUSES. Permissions must never be widened by an
  // unattended pipe; the diff is already printed above.
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    die(
      "--apply refuses in a non-interactive shell: permissions are never applied unattended. " +
        "Review the diff above and re-run `crewhaus permissions suggest --apply` in an interactive terminal.",
    );
  }
  const confirmed = await confirmYesNo(
    `apply ${diff.additions.length} new permission rule(s) to ${relative(process.cwd(), settingsPath) || settingsPath}? [y/N] `,
  );
  if (!confirmed) {
    process.stdout.write("aborted — settings.json unchanged.\n");
    return;
  }
  const newRoot = applyToSettingsRoot(settingsRoot, diff.merged);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(newRoot, null, 2)}\n`);
  process.stdout.write(`[permissions] wrote ${diff.additions.length} rule(s) to ${settingsPath}\n`);
}

/**
 * One-line y/N confirm over a TTY. Returns true only on an explicit
 * y/yes (default No). Thin IO — the caller has already gated on isTTY.
 */
async function confirmYesNo(prompt: string): Promise<boolean> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  return await new Promise<boolean>((resolveConfirm) => {
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      stdin.off("data", onData);
      stdin.pause();
      process.stdout.write("\n");
      resolveConfirm(v);
    };
    const onData = (chunk: Buffer | string): void => {
      const answer = chunk.toString().trim().toLowerCase();
      finish(answer === "y" || answer === "yes");
    };
    stdin.resume();
    stdin.once("data", onData);
  });
}

// -------- response feedback: rate / feedback / distill --------

const SESSIONS_SUBDIR = join(".crewhaus", "sessions");
const FEEDBACK_SUBDIR = join(".crewhaus", "feedback");
const FEWSHOT_SUBDIR = join(".crewhaus", "fewshot");

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

/**
 * D45 — a session's persisted TRACE events (`<id>.events.jsonl` beside the
 * transcript, the same sidecar `sessions export` reads for its reward
 * ladder). Missing/torn files degrade to an empty list: the trace sidecar is
 * optional, and no consumer may fail because a run never wrote one.
 */
function readSessionTraceEvents(session: string): unknown[] {
  const file = `${sessionJsonlPath(session).slice(0, -".jsonl".length)}.events.jsonl`;
  if (!existsSync(file)) return [];
  try {
    return parseJsonlLoose(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
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
    /** B19 — mark the record as an adjudication (settles a disagreement). */
    adjudicate?: boolean;
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
  // G59 — also mirror a `response_rated` TraceEvent onto the session trace so
  // the human rating is present in the session's durable trace vocabulary
  // (the sibling of the rich `user_feedback` record `distill` reads), the
  // offline analogue of an in-session capture surface publishing it live.
  mirrorResponseRated(session, record);
  process.stdout.write(`recorded ${record.modality} feedback on ${session} turn ${turnNumber}\n`);
}

/**
 * G59 — append a `response_rated` TraceEvent to the session JSONL (the durable
 * trace mirror). Emitted only when the record carries a numeric/thumbs rating
 * (a comment/correction-only record has no `rating`, and `ResponseRatedEvent`
 * requires one). Written in the event-log wire shape (`{ ts, version, kind,
 * payload }`) directly rather than via `EventLog.append` — `response_rated` is
 * a trace-bus kind, not a conversational `EventKind`, and every session-log
 * reader branches on the kinds it knows and skips the rest, so this stays
 * additive-safe (resume/replay/distill ignore it).
 */
function mirrorResponseRated(session: string, record: FeedbackRecord): void {
  const rating: "up" | "down" | number | undefined =
    record.rating.thumbs !== undefined ? record.rating.thumbs : normalizeRating(record);
  if (rating === undefined) return; // comment/correction-only — no rating to mirror
  const payload: {
    rating: "up" | "down" | number;
    turnNumber: number;
    source: FeedbackSource;
    comment?: string;
    targetSpanId?: string;
  } = {
    rating,
    turnNumber: record.turnNumber,
    source: record.source,
    ...(record.comment !== undefined ? { comment: record.comment } : {}),
    ...(record.targetSpanId !== undefined ? { targetSpanId: record.targetSpanId } : {}),
  };
  const wire = {
    ts: Date.parse(record.ts) || Date.now(),
    version: 1,
    kind: "response_rated",
    payload,
  };
  try {
    appendFileSync(sessionJsonlPath(session), `${JSON.stringify(wire)}\n`, { mode: 0o600 });
  } catch (err) {
    // The durable user_feedback record already landed; a mirror failure must
    // never fail the capture command.
    logger.debug("response_rated.mirror_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runRate(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus rate --session <id> [--turn N] " +
        "(--thumbs up|down | --stars 1-5 | --score 0-1) [--comment <text>] [--rater <who>] [--adjudicate]\n" +
        "  --adjudicate marks the record as an ADJUDICATION: when several raters disagree\n" +
        "  on a turn, distill lets the adjudication win and closes the disagreement (B19).\n",
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
    ...(args.flags["adjudicate"] === true ? { adjudicate: true } : {}),
  });
}

async function runFeedbackCmd(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus feedback --session <id> [--turn N] --text <msg> [--correction <better answer>] [--rater <who>] [--adjudicate]\n" +
        "  --adjudicate marks the record as an ADJUDICATION: when several raters disagree\n" +
        "  on a turn, distill lets the adjudication win and closes the disagreement (B19).\n" +
        "  It needs a verdict, so on this surface it requires --correction (use\n" +
        "  `crewhaus rate --adjudicate` to settle with a rating instead).\n",
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
    ...(args.flags["adjudicate"] === true ? { adjudicate: true } : {}),
  });
}

/**
 * Loop contract 0.4 (Batch C, G11) — `crewhaus approvals list|show|grant|deny`.
 * Reads/writes the file-backed `PendingApprovalStore` under the harness's
 * `.crewhaus/sessions/` (the same store the runtime parks against and re-reads
 * to resume a paused run). `--dir` overrides the harness root; `--json` prints
 * the raw store records; grant/deny record an out-of-band decision keyed on the
 * approval id.
 */
async function runApprovals(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"] || action === "") {
    process.stdout.write(
      "usage: crewhaus approvals list|show|grant|deny <id> [--dir <root>] [--by <who>] [--json]\n" +
        "  list                 all parked approvals under .crewhaus/sessions/, newest first\n" +
        "  show <id>            full detail for one approval (incl. the verbatim tool input)\n" +
        "  grant <id> [--once]  record a GRANT — the next run re-issuing the same tool call\n" +
        "                       proceeds pre-approved. --once (default) is one-shot: the\n" +
        "                       runtime consumes the grant on use, so a later identical call\n" +
        "                       re-asks. --by <who> records the deciding identity (> CREWHAUS_USER > cli).\n" +
        "  grant <id> --always  record a STANDING allow: grants this call AND writes an\n" +
        "                       `alwaysAllow` rule for the tool to .crewhaus/settings.json, so\n" +
        "                       every future call of the tool runs pre-approved on this harness\n" +
        "                       (any input — unlike a one-shot grant, which is keyed to the\n" +
        "                       exact input). Undo by removing the rule from settings.json.\n" +
        "  deny <id>            record a DENY — the parked call is refused with a note on resume.\n" +
        "  These resolve the parks a headless run creates when a tool permission asks and\n" +
        "  `permissions.ask_mode: pause` (the default) is set.\n",
    );
    return;
  }
  // Resolve the SAME root a parking run writes to, or the documented
  // remediation ("grant … then rerun") points at an empty file. An explicit
  // `--dir` wins; otherwise defer to `resolveSessionRootDir`, which honours a
  // tenant's rebased root and `CREWHAUS_SESSION_DIR` exactly as the run path
  // does, and falls back to `<cwd>/.crewhaus/sessions` when neither is set.
  const dirFlag = args.flags["dir"];
  const rootDir =
    typeof dirFlag === "string"
      ? join(resolve(dirFlag), SESSIONS_SUBDIR)
      : (resolveSessionRootDir(undefined) ?? join(process.cwd(), SESSIONS_SUBDIR));
  const store = createPendingApprovalStore({ rootDir });
  const json = args.flags["json"] === true;

  if (action === "list") {
    const list = await store.list();
    if (json) {
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      return;
    }
    process.stdout.write(formatApprovalsTable(list));
    return;
  }

  const id = args.positional[0];
  if (typeof id !== "string" || id === "") die("missing <id> — see `crewhaus approvals`");

  if (action === "show") {
    const found = (await store.list()).find((a: PendingApproval) => a.id === id);
    if (found === undefined) die(`no approval "${id}" under ${rootDir}`);
    if (json) {
      process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
      return;
    }
    process.stdout.write(formatApprovalDetail(found));
    return;
  }

  // grant | deny — record an out-of-band decision.
  const by = strFlag(args, "by") ?? process.env["CREWHAUS_USER"] ?? "cli";
  const decision: "grant" | "deny" = action === "grant" ? "grant" : "deny";
  // #383 — a standing allow: grant + persist an alwaysAllow rule for the tool.
  const always = args.flags["always"] === true;
  if (always && decision !== "grant") die("--always applies only to `approvals grant`");
  // Fail CLOSED before recording anything when --always cannot know the
  // harness root: with the store located via CREWHAUS_SESSION_DIR or a
  // tenant scope (not --dir, not cwd), the current directory may not be the
  // daemon's harness, and a rule written here would never be loaded.
  if (always && typeof dirFlag !== "string" && resolveSessionRootDir(undefined) !== undefined) {
    die(
      `--always writes .crewhaus/settings.json under the HARNESS root, but the approvals store was located via CREWHAUS_SESSION_DIR/tenant scope (${resolveSessionRootDir(undefined)}), so the harness owning settings.json cannot be inferred from the current directory. Re-run with --dir <harness root>.`,
    );
  }
  let updated: PendingApproval | null;
  try {
    updated = await store.resolve(id, decision, by, always ? { always: true } : undefined);
  } catch (err) {
    // resolve() throws on a malformed id (not appr_<16 hex>).
    die(err instanceof Error ? err.message : String(err));
  }
  if (updated === null) die(`no approval "${id}" under ${rootDir}`);
  let ruleNote = "";
  if (always) {
    // The settings file lives at the HARNESS root (the dir owning .crewhaus/),
    // not under the sessions subdir the store uses.
    const harnessDir = typeof dirFlag === "string" ? resolve(dirFlag) : process.cwd();
    try {
      const written = appendSettingsRule(harnessDir, {
        type: "alwaysAllow",
        pattern: updated.toolName,
      });
      ruleNote = written.added
        ? ` (standing allow — wrote { type: alwaysAllow, pattern: ${updated.toolName} } to ${written.path}; every future \`${updated.toolName}\` call runs pre-approved on this harness)`
        : ` (standing allow — ${written.path} already carries the alwaysAllow \`${updated.toolName}\` rule)`;
    } catch (err) {
      die(
        `granted ${id}, but writing the standing alwaysAllow rule failed: ${
          err instanceof Error ? err.message : String(err)
        }\nThe grant itself is recorded (one-shot). Fix .crewhaus/settings.json and re-run \`crewhaus approvals grant ${id} --always\`, or add the rule by hand.`,
      );
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }
  const note = always
    ? ruleNote
    : decision === "grant"
      ? " (one-shot — the runtime consumes it on the next matching tool call)"
      : "";
  process.stdout.write(
    `${decision === "grant" ? "granted" : "denied"} ${id} — ${updated.toolName}${note}\n`,
  );
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

const REVIEW_USAGE =
  "usage: crewhaus review <list|next|resolve <id>> [--kind <k>] [--all] [--note <t>]\n" +
  "  The persistent human-review queue (.crewhaus/review/queue.jsonl). Fed by:\n" +
  "    eval          judge-abstained samples (abstained) + panel-flagged ones (needs_review)\n" +
  "    distill       unresolved rater disagreements (split verdicts, no adjudication)\n" +
  "    dataset mine  pointers to quarantined hard-case candidates (quarantine)\n" +
  "  list     open items, oldest first (--all includes resolved; --kind filters)\n" +
  "  next     show the oldest open item with its context; in a TTY, record a verdict —\n" +
  "           a session-turn item adjudicates through the same machinery as\n" +
  "           `crewhaus rate --adjudicate`, others record pass/fail on the item.\n" +
  "           Non-TTY prints the item and exits (never hangs a script/CI pipe).\n" +
  "  resolve  close one item non-interactively (--note records the reason)\n" +
  "  --kind is one of: abstained, needs_review, rater_disagreement, quarantine\n";

/**
 * Wave 3 (B20) — `crewhaus review list|next|resolve`. The one drain for the
 * persistent review queue: `next` surfaces a single open item and, when the
 * item points at a session turn, routes the human's verdict through the SAME
 * captureFeedback path `crewhaus rate` uses (as a B19 adjudication, so the
 * disagreement is settled at the feedback source too, not just in the queue).
 */
async function runReview(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"] || action === "") {
    process.stdout.write(REVIEW_USAGE);
    return;
  }
  const root = process.cwd();
  const kindFlag = strFlag(args, "kind");
  if (kindFlag !== undefined && !REVIEW_KINDS.includes(kindFlag as ReviewKind)) {
    die(`invalid --kind "${kindFlag}" — one of: ${REVIEW_KINDS.join(", ")}`);
  }
  const kind = kindFlag as ReviewKind | undefined;

  if (action === "list") {
    let entries = readReviewQueue(root);
    if (kind !== undefined) entries = entries.filter((e) => e.kind === kind);
    if (args.flags["all"] !== true) entries = entries.filter((e) => e.status === "open");
    process.stdout.write(formatReviewList(entries));
    return;
  }

  if (action === "resolve") {
    const id = args.positional[0];
    if (typeof id !== "string" || id === "") die("missing <id> — see `crewhaus review list`");
    const note = strFlag(args, "note");
    const result = resolveReviewEntry(root, id, note ?? "resolved", new Date().toISOString());
    if (result.outcome === "not-found") {
      die(`no review item "${id}" — see \`crewhaus review list --all\``);
    }
    if (result.outcome === "already-resolved") {
      process.stdout.write(
        `review item ${id} was already resolved${
          result.entry.resolution !== undefined ? ` (${result.entry.resolution})` : ""
        }\n`,
      );
      return;
    }
    process.stdout.write(`resolved ${id}${note !== undefined ? ` — ${note}` : ""}\n`);
    return;
  }

  // next
  const item = nextOpenEntry(readReviewQueue(root), kind);
  if (item === undefined) {
    process.stdout.write("review queue is clear — no open items.\n");
    return;
  }
  process.stdout.write(formatReviewItem(item));
  const ref = item.sourceRef;
  const canAdjudicate = typeof ref.sessionId === "string" && typeof ref.turn === "number";

  if (process.stdin.isTTY !== true) {
    // Non-TTY: print the item and exit — never hang a script/CI pipe on a
    // prompt (mirrors `dataset mine --review`'s non-TTY policy).
    process.stdout.write(
      `\n(non-interactive) resolve with \`crewhaus review resolve ${item.id} [--note <t>]\`${
        canAdjudicate
          ? ` or adjudicate with \`crewhaus rate --session ${ref.sessionId} --turn ${ref.turn} --thumbs up|down --adjudicate\``
          : ""
      }\n`,
    );
    return;
  }

  const prompt = async (
    question: string,
    keys: Record<string, string>,
  ): Promise<string | undefined> => {
    process.stdout.write(question);
    for (;;) {
      const key = (await readLineFromStdin()).trim().toLowerCase();
      if (key === "s" || key === "") return undefined;
      const verdict = keys[key];
      if (verdict !== undefined) return verdict;
      process.stdout.write(question);
    }
  };

  if (canAdjudicate) {
    const verdict = await prompt("\n  verdict — [u]p / [d]own / [s]kip? ", { u: "up", d: "down" });
    if (verdict === undefined) {
      process.stdout.write("  → skipped (still open)\n");
      return;
    }
    // Route through the SAME capture machinery `crewhaus rate` uses, marked
    // as a B19 adjudication so the disagreement closes at the source too.
    await captureFeedback(
      {
        flags: { session: ref.sessionId as string, turn: String(ref.turn) },
        positional: [],
      },
      "cli",
      { thumbs: verdict as "up" | "down", adjudicate: true },
    );
    resolveReviewEntry(root, item.id, `adjudicated: thumbs ${verdict}`, new Date().toISOString());
    process.stdout.write(`  → resolved ${item.id} (adjudicated thumbs ${verdict})\n`);
    return;
  }

  // No session turn to rate against (an eval sample or quarantine pointer):
  // record the human's pass/fail verdict on the queue item itself.
  const verdict = await prompt("\n  verdict — [p]ass / [f]ail / [s]kip? ", {
    p: "pass",
    f: "fail",
  });
  if (verdict === undefined) {
    process.stdout.write("  → skipped (still open)\n");
    return;
  }
  resolveReviewEntry(root, item.id, verdict, new Date().toISOString());
  process.stdout.write(`  → resolved ${item.id} (${verdict})\n`);
}

async function runDistill(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus distill (--session <id> | --all-sessions) -o <dataset.jsonl> " +
        "[--graders-out <graders.yaml>] [--min-score F] [--judge] [--judge-model <model>] " +
        "[--register <name>] [--no-redact]\n" +
        "  --register promotes the distilled samples into the Section 29 dataset registry\n" +
        "  (.crewhaus/datasets, or CREWHAUS_DATASETS_DIR) as a new auto-bumped version of\n" +
        "  <name> with the deterministic default 70/15/15 train/dev/test split (stable by\n" +
        "  sample-id hash), printing <name>@<version>. -o is optional when --register is\n" +
        "  given; without --register the plain file output is unchanged.\n" +
        "  Sample text (turn inputs/outputs, comments, corrections) is PII/secret-redacted\n" +
        "  by default before it lands in the dataset or graders (the same detector set\n" +
        "  `dataset synthesize` uses); --no-redact keeps it raw (dev/local only — the\n" +
        "  unattended feedback.autoDistill teardown always redacts).\n" +
        "  Multi-rater turns (B19): feedback stays append-only; a turn several raters\n" +
        "  rated resolves by MAJORITY (thumbs) or MEAN (stars/scale), a record made with\n" +
        "  `rate --adjudicate` always wins, and a true split verdict is NOT distilled —\n" +
        "  it goes to the review queue (`crewhaus review`). Per-turn agreement and the\n" +
        "  overall Cohen's kappa print whenever any turn has ≥2 raters.\n",
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

  // B23 — free-text redaction is the default; --no-redact opts out for
  // dev/local parity (the autoDistill teardown consumer never opts out).
  const result = distillFeedback(turns, feedback, {
    minScore,
    ...(useJudge ? { judge: true } : {}),
    ...(typeof judgeModel === "string" ? { judgeModel } : {}),
    ...(args.flags["no-redact"] === true ? {} : { redact: redactDatasetText }),
  });
  for (const w of result.warnings) process.stderr.write(`[distill] warning: ${w}\n`);
  // B23 — redaction altering a GOLD is silent otherwise: live agent output is
  // never redacted, so string-comparison graders can never match such a gold.
  // Surface the count so a pass-rate drop is traceable to the instrument.
  if (args.flags["no-redact"] !== true) {
    const redactedGolds = result.samples.filter(
      (s) => s.expected_output !== undefined && containsRedactionMarker(s.expected_output),
    ).length;
    if (redactedGolds > 0) {
      process.stderr.write(
        `[distill] warning: ${redactedGolds} gold(s) contained redacted text — exact_match/expected_contains graders will not match live outputs for those samples; prefer llm_judge or tool graders (or --no-redact for dev/local only)\n`,
      );
    }
  }
  // Item 4 — the synthesis fell back to the floor grader (no consistent
  // tool/phrase signal in the ratings): point at the failure-rationale
  // drafting path, which mines eval runs the ratings can't see.
  if (isFloorGraderConfig(result.graders)) {
    process.stdout.write(`[distill] ${FLOOR_GRADER_HINT}\n`);
  }

  // B19 — multi-rater agreement report (present only when some turn actually
  // had ≥2 raters): per-turn verdicts + overall Cohen's kappa, and the
  // unresolved split verdicts land in the persistent review queue (B20)
  // instead of being silently labeled. Runs BEFORE the zero-sample death so
  // an all-ties corpus still enqueues its disagreements. Best-effort — a
  // queue-write failure must never fail the distill.
  if (result.agreement !== undefined) {
    for (const line of formatAgreementLines(result.agreement)) {
      process.stdout.write(`${line}\n`);
    }
  }
  if (result.ties !== undefined && result.ties.length > 0) {
    try {
      const q = enqueueReviewEntries(
        process.cwd(),
        entriesFromRaterTies(result.ties, { ts: new Date().toISOString() }),
      );
      process.stdout.write(
        `[distill] ${result.ties.length} rater disagreement(s) withheld → review queue ` +
          `(${q.added} new) — \`crewhaus review next\` or \`crewhaus rate --adjudicate\`\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[distill] review queue skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (result.samples.length === 0) {
    die(
      result.ties !== undefined && result.ties.length > 0
        ? "every rated turn is an unresolved rater disagreement — adjudicate with `crewhaus rate --adjudicate` (the splits are enqueued in `crewhaus review`)"
        : "no rated turns could be matched to the transcript(s)",
    );
  }

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
 * B23 — `redact` (the shared sync PII/secret redactor unless `--no-redact`
 * was given) runs over every free-text field at ingestion: these samples
 * become the optimizer's failing-sample windows (input + expected) in the
 * meta-prompt sent to an external mutator model, so raw pasted credentials
 * must never survive into them.
 */
function distillRatings(
  ratingsArg: string,
  minScore: number,
  redact: ((text: string) => string) | undefined,
): {
  samples: Array<{ id: string; input: string; expected_output?: string }>;
  gradersYaml: string;
  /** NEW-datasets-1 — the (sessionId, turnNumber) provenance distill stamped
   *  on each sample, captured BEFORE the optimizer-shape mapping strips
   *  metadata, so the few-shot overlap exclusion can see it. */
  provenance: Array<{ sessionId: string; turnNumber: number }>;
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

  const result = distillFeedback(turns, feedback, {
    minScore,
    ...(redact !== undefined ? { redact } : {}),
  });
  for (const w of result.warnings) process.stderr.write(`[optimize] ratings warning: ${w}\n`);
  // B19/B20 — the inline distill withholds split verdicts exactly like
  // `crewhaus distill`; they belong in the persistent review queue, not just
  // the warning scrollback. Best-effort + idempotent by (sessionId, turn).
  if (result.ties !== undefined && result.ties.length > 0) {
    try {
      const q = enqueueReviewEntries(
        process.cwd(),
        entriesFromRaterTies(result.ties, { ts: new Date().toISOString() }),
      );
      process.stderr.write(
        `[optimize] ${result.ties.length} rater disagreement(s) withheld → review queue ` +
          `(${q.added} new) — \`crewhaus review next\` or \`crewhaus rate --adjudicate\`\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[optimize] review queue skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  const samples = result.samples.map((s) => ({
    id: s.id,
    input: s.input,
    ...(s.expected_output !== undefined ? { expected_output: s.expected_output } : {}),
  }));
  const provenance = result.samples.flatMap((s) => {
    const sessionId = s.metadata?.["sessionId"];
    const turnNumber = s.metadata?.["turnNumber"];
    return typeof sessionId === "string" && typeof turnNumber === "number"
      ? [{ sessionId, turnNumber }]
      : [];
  });
  return { samples, gradersYaml: gradersConfigToYaml(result.graders), provenance };
}

/**
 * Gather every session's derived turns (tagged with the session join key) plus
 * all feedback (in-transcript events + the web-UI feedback dir). Shared by the
 * few-shot / FAQ / lessons harvesters so they read the same corpus `distill`
 * does. `sessionsArg` is a session id or `"all"`.
 */
function resolveHarvestSessionIds(sessionsArg: string | undefined, allFlag: boolean): string[] {
  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  if (allFlag || sessionsArg === "all" || sessionsArg === undefined) {
    return listSessionIds(sessionsDir);
  }
  if (!SESSION_ID_REGEX.test(sessionsArg)) {
    die(`invalid --session "${sessionsArg}" — expected sess_<16 hex> or "all"`);
  }
  return [sessionsArg];
}

function gatherTurnsAndFeedback(sessionIds: ReadonlyArray<string>): {
  turns: SessionTurn[];
  feedback: FeedbackRecord[];
} {
  const turns: SessionTurn[] = [];
  const feedback: FeedbackRecord[] = [];
  for (const id of sessionIds) {
    const events = readSessionEvents(id);
    for (const t of deriveTurns(events)) turns.push({ ...t, sessionId: id });
    feedback.push(...extractFeedbackRecords(events));
  }
  feedback.push(...readFeedbackDir(join(process.cwd(), FEEDBACK_SUBDIR)));
  return { turns, feedback };
}

/** Read a persisted few-shot pool file, skipping malformed lines. */
function readFewShotPool(file: string): FewShotExample[] {
  if (!existsSync(file)) return [];
  return parseJsonlObjects(readFileSync(file, "utf-8")).filter(isFewShotExample);
}

/**
 * Item #54 — `crewhaus fewshot harvest|show`. `harvest` mines up-rated turns
 * into a golden few-shot pool (merged idempotently into
 * `.crewhaus/fewshot/<spec>.jsonl`, PII/secret-redacted); `show` prints the
 * top-K pool entries as the injectable prompt block.
 */
async function runFewshot(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (args.flags["help"] === true && action === undefined) {
    process.stdout.write(
      "usage: crewhaus fewshot <harvest|show> [--session <id>|--all-sessions] [--min-score F] [-o <pool.jsonl>] [--k N]\n" +
        "  harvest  mine up-rated turns into a golden few-shot pool (PII/secret-redacted)\n" +
        "  show     print the top-K pool examples as the injectable prompt block\n",
    );
    return;
  }
  // The pool file: --out override, else the cwd spec's name, else a default.
  const specName = readCwdSpecName();
  const poolFile = strFlag(args, "out") ?? join(process.cwd(), FEWSHOT_SUBDIR, `${specName}.jsonl`);
  const k = intFlag(args, "k") ?? 5;

  if (action === "show") {
    const pool = readFewShotPool(poolFile);
    if (pool.length === 0)
      die(`no few-shot pool at ${poolFile} — run \`crewhaus fewshot harvest\``);
    process.stdout.write(`${formatFewShotForPrompt(pool, k)}\n`);
    return;
  }
  if (action !== "harvest") {
    die(`fewshot: unknown action "${action ?? ""}" — supported: harvest, show`);
  }

  const minScore = floatFlag(args, "min-score") ?? 0.7;
  if (minScore < 0 || minScore > 1) die(`invalid --min-score "${minScore}" — must be in [0,1]`);
  const sessionIds = resolveHarvestSessionIds(
    strFlag(args, "session"),
    args.flags["all-sessions"] === true,
  );
  if (sessionIds.length === 0) die("no sessions found under .crewhaus/sessions/");
  const { turns, feedback } = gatherTurnsAndFeedback(sessionIds);
  if (feedback.length === 0) {
    die("no feedback found — record some with `crewhaus rate` / `crewhaus feedback` first");
  }

  // Redact harvested outputs with the shared secret/API-key + PII detector set
  // so a pasted credential never lands in the pool or the optimizer prompt.
  const { createPiiRedactor } = await import("@crewhaus/pii-redactor");
  const { SYNTHESIZE_PII_DETECTORS } = await import("./dataset-mine");
  const redactor = createPiiRedactor({ regexDetectors: SYNTHESIZE_PII_DETECTORS });

  const { examples, stats } = await harvestFewShot(turns, feedback, {
    minScore,
    redact: async (t) => (await redactor.redact(t)).text,
  });
  if (examples.length === 0) {
    die(`no up-rated turns qualified (min-score ${minScore}); matched ${stats.qualified}`);
  }
  const merged = mergePools(readFewShotPool(poolFile), examples);
  mkdirSync(dirname(poolFile), { recursive: true });
  writeFileSync(poolFile, poolToJsonl(merged), { mode: 0o600 });
  process.stdout.write(
    `[fewshot] harvested ${examples.length} example(s) → ${merged.length} in pool → ${poolFile}\n`,
  );
}

/** Best-effort read of the cwd harness spec's `name` for default pool/skill
 *  paths. Falls back to "harness" when no spec is present in the cwd. */
function readCwdSpecName(): string {
  for (const candidate of ["crewhaus.yaml", "crewhaus.yml"]) {
    const p = join(process.cwd(), candidate);
    if (existsSync(p)) {
      try {
        return parseSpec(readFileSync(p, "utf-8")).name;
      } catch {
        // fall through to the default
      }
    }
  }
  return "harness";
}

/** Resolve the session ids to scan for the harvest family, honouring
 *  `--sessions N|all` (N = the N most-recently-modified session logs). */
function resolveScanSessionIds(sessionsArg: string | undefined): string[] {
  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const ids = listSessionIds(sessionsDir);
  if (sessionsArg === undefined || sessionsArg === "all") return ids;
  const n = Number.parseInt(sessionsArg, 10);
  if (Number.isNaN(n) || n < 1) die(`invalid --sessions "${sessionsArg}" — expected N or "all"`);
  const withMtime = ids.map((id) => {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(sessionsDir, `${id}.jsonl`)).mtimeMs;
    } catch {}
    return { id, mtimeMs };
  });
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime.slice(0, n).map((e) => e.id);
}

/**
 * Item #55 — `crewhaus faq distill [--sessions N|all]`. Cluster recurring user
 * questions across sessions, pair each cluster with its best up-rated answer,
 * and emit an auto-discovered FAQ SKILL.md into `.crewhaus/skills/faq/`.
 */
async function runFaq(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (args.flags["help"] === true && action === undefined) {
    process.stdout.write(
      "usage: crewhaus faq distill [--sessions N|all] [--min-score F] [--min-occurrences N] [-o <skill-dir>]\n" +
        "  Cluster recurring user questions, pair each with its best-rated answer, and emit\n" +
        "  an auto-discovered FAQ skill (SKILL.md) under .crewhaus/skills/faq/ (PII/secret-redacted).\n",
    );
    return;
  }
  if (action !== "distill") {
    die(`faq: unknown action "${action ?? ""}" — supported: distill`);
  }
  const minScore = floatFlag(args, "min-score") ?? 0.7;
  if (minScore < 0 || minScore > 1) die(`invalid --min-score "${minScore}" — must be in [0,1]`);
  const minOccurrences = intFlag(args, "min-occurrences") ?? 2;

  const sessionIds = resolveScanSessionIds(strFlag(args, "sessions"));
  if (sessionIds.length === 0) die("no sessions found under .crewhaus/sessions/");
  const { turns, feedback } = gatherTurnsAndFeedback(sessionIds);
  if (feedback.length === 0) {
    die("no feedback found — record some with `crewhaus rate` / `crewhaus feedback` first");
  }

  const { createPiiRedactor } = await import("@crewhaus/pii-redactor");
  const { SYNTHESIZE_PII_DETECTORS } = await import("./dataset-mine");
  const redactor = createPiiRedactor({ regexDetectors: SYNTHESIZE_PII_DETECTORS });

  const entries = await distillFaq(turns, feedback, {
    minScore,
    minOccurrences,
    redact: async (t) => (await redactor.redact(t)).text,
  });
  if (entries.length === 0) {
    die(
      `no recurring questions with an up-rated answer (min-occurrences ${minOccurrences}, min-score ${minScore})`,
    );
  }

  const skillDir = strFlag(args, "out") ?? join(process.cwd(), ".crewhaus", "skills", "faq");
  const skillMd = buildFaqSkill(entries, { harnessName: readCwdSpecName() });
  // Fail loudly if the emitted skill somehow does not parse — the whole point
  // is that skills-registry auto-discovers it.
  try {
    const { parseSkillFile } = await import("@crewhaus/skills-registry");
    parseSkillFile(skillMd);
  } catch (err) {
    die(`internal: emitted FAQ SKILL.md failed to parse: ${(err as Error).message}`);
  }
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillMd, { mode: 0o600 });
  process.stdout.write(
    `[faq] distilled ${entries.length} FAQ entry(ies) → ${join(skillDir, "SKILL.md")} (auto-discovered by future runs)\n`,
  );
}

/** The per-user preferences directory the runtime injects from at run start. */
const PREFERENCES_SUBDIR = join(".crewhaus", "preferences");

/** Sanitize a rater identity into a filesystem-safe preferences filename. */
function preferenceFileName(rater: string): string {
  return `${rater.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || "user"}.md`;
}

/**
 * Item #56 — `crewhaus lessons update [--sessions N|all]`. Mine corrections +
 * recurring failure→fix patterns into a deduped, idempotent LESSONS.md (a
 * canonical project-memory file the runtime auto-loads), and maintain per-user
 * preference files under `.crewhaus/preferences/`.
 */
async function runLessons(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (args.flags["help"] === true && action === undefined) {
    process.stdout.write(
      "usage: crewhaus lessons update [--sessions N|all] [--low-score F] [-o <LESSONS.md>]\n" +
        "  Mine corrections + recurring failure→fix patterns into a deduped LESSONS.md\n" +
        "  (auto-loaded into the system prompt), plus per-user prefs under .crewhaus/preferences/.\n",
    );
    return;
  }
  if (action !== "update") {
    die(`lessons: unknown action "${action ?? ""}" — supported: update`);
  }
  const lowScore = floatFlag(args, "low-score") ?? 0.5;
  if (lowScore < 0 || lowScore > 1) die(`invalid --low-score "${lowScore}" — must be in [0,1]`);

  const sessionIds = resolveScanSessionIds(strFlag(args, "sessions"));
  if (sessionIds.length === 0) die("no sessions found under .crewhaus/sessions/");
  const { turns, feedback } = gatherTurnsAndFeedback(sessionIds);

  // Failure signals reuse dataset-mine's negative-signal detection.
  const failureSignals: Array<{ input: string; reason: string }> = [];
  for (const id of sessionIds) {
    for (const c of mineSession(id, readSessionEvents(id))) {
      failureSignals.push({ input: c.input, reason: c.reason });
    }
  }
  if (feedback.length === 0 && failureSignals.length === 0) {
    die("no corrections/comments or failure signals found to distill lessons from");
  }

  const { createPiiRedactor } = await import("@crewhaus/pii-redactor");
  const { SYNTHESIZE_PII_DETECTORS } = await import("./dataset-mine");
  const redactor = createPiiRedactor({ regexDetectors: SYNTHESIZE_PII_DETECTORS });
  const redact = async (t: string): Promise<string> => (await redactor.redact(t)).text;

  const freshLessons = await mineLessons(turns, feedback, failureSignals, { lowScore, redact });

  // Merge into the existing LESSONS.md, preserving its human-authored preamble.
  const lessonsFile = strFlag(args, "out") ?? join(process.cwd(), "LESSONS.md");
  const existingRaw = existsSync(lessonsFile) ? readFileSync(lessonsFile, "utf-8") : "";
  const { preamble, lessons: existing } = parseLessonsMd(existingRaw);
  const merged = mergeLessons(existing, freshLessons);
  // TODO(#56 F7): `merged` grows unbounded across updates (dedupe never evicts)
  // — add a cap/prune (e.g. keep the newest/highest-signal N lessons) so the
  // auto-injected LESSONS.md can't bloat the system prompt over time.
  writeFileSync(lessonsFile, renderLessonsMd(merged, preamble), { mode: 0o600 });
  process.stdout.write(
    `[lessons] ${freshLessons.length} mined → ${merged.length} in ${lessonsFile} (auto-loaded at run start)\n`,
  );

  // Per-user preference files.
  const prefs = await minePreferences(feedback, { redact });
  if (prefs.length > 0) {
    const prefsDir = join(process.cwd(), PREFERENCES_SUBDIR);
    mkdirSync(prefsDir, { recursive: true });
    for (const p of prefs) {
      writeFileSync(join(prefsDir, preferenceFileName(p.rater)), renderPreferencesMd(p), {
        mode: 0o600,
      });
    }
    process.stdout.write(
      `[lessons] wrote ${prefs.length} per-user preference file(s) under ${prefsDir}\n`,
    );
  }
}

/**
 * Item #57 — `crewhaus sessions summarize [--before <date>] [--evicted]`. Folds
 * sessions into the durable `.crewhaus/sessions-index/` before their raw
 * transcripts are lost to TTL eviction. With `--evicted` it runs an actual TTL
 * eviction pass with the summarize-before-evict hook wired, so an expiring
 * session is indexed the instant before it is unlinked; otherwise it summarizes
 * the sessions currently on disk (optionally only those older than `--before`).
 */
async function runSessions(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (args.flags["help"] === true) {
    process.stdout.write(
      "usage: crewhaus sessions summarize [--before <date>] [--evicted] [--ttl-days N]\n" +
        "       crewhaus sessions export --format trajectories [--out <file.jsonl>]\n" +
        "       crewhaus sessions tail [<session>] [--dir <root>] [--no-follow] [--interval <ms>] [--transcript-only]\n" +
        "  summarize: fold sessions (outcome, tools, ratings, key facts) into the durable\n" +
        "  .crewhaus/sessions-index/ before their transcripts expire (30-day TTL).\n" +
        "  --evicted runs a TTL eviction pass and indexes each session just before it is deleted.\n" +
        "\n" +
        "  tail: follow a session's transcript live (a `tail -f` for a running agent —\n" +
        "  the per-turn view `crewhaus dev` points at). With no <session>, tails the\n" +
        "  most-recently-updated one under .crewhaus/sessions. Each user/assistant turn,\n" +
        "  tool call + result, and failure prints one line as it lands, and so does each\n" +
        "  routing decision (⇢), cost accrual ($), judge verdict (⚖) and hybrid-strategy\n" +
        "  stage (◇) the session recorded — the shape of a hybrid turn beside its text.\n" +
        "  --transcript-only hides those. --no-follow dumps the current transcript and\n" +
        "  exits (scriptable/CI); --interval sets the poll ms (default 500). --dir points\n" +
        "  at a session store other than cwd/.crewhaus/sessions.\n" +
        "\n" +
        "  export --format trajectories: one JSONL line per agent step — a\n" +
        "  (state, action, observation, reward) tuple — assembled from every session\n" +
        "  event log under .crewhaus/sessions (plus a session's trace events when a\n" +
        "  sibling <id>.events.jsonl exists). state is the full verbatim message prefix\n" +
        "  before the action (so lines are independently consumable, at O(n²) size for\n" +
        "  long sessions); action is the assistant's text and/or tool calls (one model\n" +
        "  response = one action); observation is the tool results the environment\n" +
        "  returned (null for a plain text turn). reward is terminal-sparse — null on\n" +
        "  every step except the session's last, which carries: the last eval_graded\n" +
        "  score when the session has one, else the latest user rating normalized to\n" +
        "  [0,1] (thumbs up→1/down→0, stars (n-1)/4 — the distill convention), else\n" +
        "  null. rewardSource says which rung fired. Each step also carries model (and\n" +
        "  profile, when a models: profile served) — the wire model that produced the\n" +
        "  action, from the session's model_meta lines — so a hybrid session's cheap\n" +
        "  drafts and strong re-runs are distinguishable. --out writes the JSONL to a\n" +
        "  file; omitted, it streams to stdout (the summary line then goes to stderr).\n" +
        "\n" +
        "  G53 posture — trajectory RL is EXPERIMENTAL: inference-time scaffolding\n" +
        "  (eval → optimize → flywheel) is the mature improvement lane, and published\n" +
        "  results still show trajectory-level RL on agent scaffolds collapsing. This\n" +
        "  export exists so an external trainer can consume real sessions. The\n" +
        "  meta-harness optimizer keeps the same experimental posture, but it IS now\n" +
        "  reachable as `crewhaus optimize --mutator meta-harness` (D38): a\n" +
        "  spec-shaped, opt-in proposer behind the ordinary eval accept gate, budget\n" +
        "  meter and OPTIMIZABLE_PATHS validation. What stays out of the CLI is the\n" +
        "  package's whole-BUNDLE rewriting mode — a model-authored agent.ts has no\n" +
        "  spec to round-trip through, so it remains library-only.\n",
    );
    return;
  }
  // Loop contract 0.4 (Batch F, item 2) — `sessions tail` follows a live
  // transcript; it owns its own dir resolution + follow loop, so branch before
  // the summarize/export dir setup below.
  if (action === "tail") {
    await runSessionsTail(args);
    return;
  }
  if (action !== "summarize" && action !== "export") {
    die(`sessions: unknown action "${action ?? ""}" — supported: summarize, export, tail`);
  }
  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const indexDir = join(process.cwd(), ".crewhaus", SESSIONS_INDEX_DIRNAME);

  // Loop contract 0.4 (Batch B, G53) — `sessions export --format trajectories`.
  if (action === "export") {
    const format = strFlag(args, "format");
    if (format !== "trajectories") {
      die(
        `sessions export: unsupported --format "${format ?? ""}" — supported: trajectories (see \`crewhaus sessions --help\` for the tuple shape and the G53 posture)`,
      );
    }
    const ids = listSessionIds(sessionsDir).sort();
    if (ids.length === 0) die(`no sessions found under ${sessionsDir}`);
    const steps: TrajectoryStep[] = [];
    let sessionsWithSteps = 0;
    for (const id of ids) {
      let text: string;
      try {
        text = readFileSync(join(sessionsDir, `${id}.jsonl`), "utf-8");
      } catch {
        continue; // evicted between listing and read — skip, never abort
      }
      const events = parseSessionLog(text);
      // A session's persisted trace events, when present (the eval
      // per-sample artifact convention, `<id>.events.jsonl` here) — the
      // carrier of `eval_graded` reward signal.
      const tracePath = join(sessionsDir, `${id}.events.jsonl`);
      const traceEvents = existsSync(tracePath)
        ? parseJsonlLoose(readFileSync(tracePath, "utf-8"))
        : [];
      const sessionSteps = assembleTrajectory(id, events, traceEvents);
      if (sessionSteps.length > 0) sessionsWithSteps += 1;
      steps.push(...sessionSteps);
    }
    const jsonl = trajectoryStepsToJsonl(steps);
    const summaryLine =
      `[sessions] exported ${steps.length} trajectory step(s) from ` +
      `${sessionsWithSteps}/${ids.length} session(s)`;
    const outFlag = strFlag(args, "out");
    if (outFlag !== undefined) {
      const outPath = resolve(outFlag);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, jsonl);
      process.stdout.write(`${summaryLine} → ${outPath}\n`);
    } else {
      // JSONL owns stdout so the export is pipeable; the human line goes to
      // stderr.
      process.stdout.write(jsonl);
      process.stderr.write(`${summaryLine}\n`);
    }
    return;
  }

  if (args.flags["evicted"] === true) {
    // Summarize-before-evict: wire the session-store hook so each expiring
    // session is indexed the instant before its files are unlinked.
    const ttlDays = intFlag(args, "ttl-days") ?? undefined;
    let indexed = 0;
    const { evictedIds } = await evictExpiredSessions({
      rootDir: sessionsDir,
      ...(ttlDays !== undefined ? { ttlDays } : {}),
      onBeforeEvict: async (id, rootDir) => {
        const s = summarizeSessionIntoIndex(id, join(rootDir, `${id}.jsonl`), indexDir);
        if (s !== undefined) indexed += 1;
      },
    });
    process.stdout.write(
      `[sessions] evicted ${evictedIds.length} expired session(s); indexed ${indexed} into ${indexDir}\n`,
    );
    return;
  }

  // On-demand: summarize every session on disk (optionally only those older
  // than --before).
  let beforeMs: number | undefined;
  const beforeArg = strFlag(args, "before");
  if (beforeArg !== undefined) {
    const parsed = /^\d+$/.test(beforeArg) ? Number.parseInt(beforeArg, 10) : Date.parse(beforeArg);
    if (Number.isNaN(parsed))
      die(`invalid --before "${beforeArg}" — expected ISO date or epoch-ms`);
    beforeMs = parsed;
  }
  const ids = listSessionIds(sessionsDir);
  if (ids.length === 0) die(`no sessions found under ${sessionsDir}`);
  let indexed = 0;
  for (const id of ids) {
    const logPath = join(sessionsDir, `${id}.jsonl`);
    if (beforeMs !== undefined) {
      let mtimeMs = Number.POSITIVE_INFINITY;
      try {
        mtimeMs = statSync(logPath).mtimeMs;
      } catch {}
      if (mtimeMs >= beforeMs) continue;
    }
    if (summarizeSessionIntoIndex(id, logPath, indexDir) !== undefined) indexed += 1;
  }
  process.stdout.write(`[sessions] summarized ${indexed} session(s) into ${indexDir}\n`);
}

/**
 * Loop contract 0.4 (Batch F, item 2) — `crewhaus sessions tail [<session>]`.
 * Follows a session's append-only event log and pretty-prints each turn as it
 * lands. With no id, selects the most-recently-updated session. `--no-follow`
 * dumps the current transcript and exits (scriptable/CI); otherwise polls the
 * log every `--interval` ms until Ctrl-C. Transcript lines go to STDOUT (so a
 * `--no-follow` dump is pipeable); status chrome goes to stderr.
 */
async function runSessionsTail(args: ParsedArgs): Promise<void> {
  const dirFlag = strFlag(args, "dir");
  const sessionsDir =
    dirFlag !== undefined ? resolve(dirFlag) : join(process.cwd(), SESSIONS_SUBDIR);
  const explicitId = args.positional[1];
  if (typeof explicitId === "string" && !SESSION_ID_REGEX.test(explicitId)) {
    die(`invalid <session> "${explicitId}" — expected sess_<16 hex>`);
  }
  if (!existsSync(sessionsDir)) {
    die(`no session store at ${sessionsDir} — run an agent first, or pass --dir <root>.`);
  }
  const sessionId = pickSessionToTail(explicitId, {
    list: () => readdirSync(sessionsDir),
    mtimeMs: (f) => {
      try {
        return statSync(join(sessionsDir, f)).mtimeMs;
      } catch {
        return 0;
      }
    },
  });
  if (sessionId === undefined) {
    die(`no sessions found under ${sessionsDir}. Start one with \`crewhaus run <spec>\`.`);
  }
  const logPath = join(sessionsDir, `${sessionId}.jsonl`);
  const readLog = (): string => {
    try {
      return readFileSync(logPath, "utf-8");
    } catch {
      return "";
    }
  };

  const follow = args.flags["no-follow"] !== true;
  let intervalMs = 500;
  const intervalFlag = intFlag(args, "interval");
  if (intervalFlag !== undefined) {
    if (intervalFlag < 50) die("--interval must be >= 50 (ms)");
    intervalMs = intervalFlag;
  }
  // 0.6.0 (design §8.2) — route / cost / eval / stage lines render by default;
  // --transcript-only restores the conversational-only view.
  const tailOpts = { transcriptOnly: args.flags["transcript-only"] === true } as const;

  // Initial dump (also seeds the follow cursor so live updates don't re-print
  // the backlog). `advanceSessionTail` counts source lines, so it stays correct
  // even across the side-channel events that render to nothing.
  let cursor: SessionTailCursor = { lineCount: 0 };
  {
    const initial = advanceSessionTail(readLog(), cursor, tailOpts);
    for (const line of initial.lines) process.stdout.write(`${line}\n`);
    cursor = initial.cursor;
  }

  if (!follow) {
    // A no-follow dump renders the current transcript (every newline-terminated
    // event — event-log always terminates each line) and exits.
    process.stderr.write(`[sessions] tailed ${sessionId} (${logPath})\n`);
    return;
  }

  process.stderr.write(`tailing ${sessionId} (${logPath}) — Ctrl-C to stop\n`);
  await new Promise<void>((resolveTail) => {
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      const advanced = advanceSessionTail(readLog(), cursor, tailOpts);
      for (const line of advanced.lines) process.stdout.write(`${line}\n`);
      cursor = advanced.cursor;
    };
    const handle = setInterval(tick, intervalMs);
    const onSigint = (): void => {
      stopped = true;
      clearInterval(handle);
      process.off("SIGINT", onSigint);
      process.stderr.write("\ntail stopped.\n");
      resolveTail();
    };
    process.on("SIGINT", onSigint);
  });
}

// -------- 0.3.0 memory release: crewhaus memory + migrate memories --------

/**
 * `crewhaus memory list|show <id>|forget <id|--query <q>>|sweep [--compact]`
 * (design §3.4) — inspect and explicitly forget the per-spec fact stores
 * under `.crewhaus/memories/`. Forgetting is append-only (supersede
 * tombstones, never a hard delete); `sweep --compact` is the growth-bounding
 * rewrite. Destructive verbs prompt unless `--yes`. NOTE: `clear|restore`
 * (trash + undo) deliberately do NOT live here — they arrive with the
 * continuity store (design §2.6).
 */
async function runMemory(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (args.flags["help"] === true && action === undefined) {
    process.stdout.write(
      "usage: crewhaus memory list [--spec <name>]\n" +
        "       crewhaus memory show <mem_id> [--spec <name>]\n" +
        "       crewhaus memory forget <mem_id> | --query <q> [--spec <name>] [--yes]\n" +
        "       crewhaus memory sweep [--compact] [--spec <name>] [--yes]\n" +
        "  Inspect + explicitly forget the per-spec memory stores under .crewhaus/memories/.\n" +
        "  forget appends supersede tombstones (append-only; never a hard delete); a --query\n" +
        "  forgets EVERY matching memory. sweep tombstones TTL-expired entries; --compact\n" +
        "  additionally rewrites the file dropping dead lines (atomic tmp+rename).\n",
    );
    return;
  }
  const memoriesDir = join(process.cwd(), MEMORIES_SUBDIR);
  const nowMs = Date.now();
  const specFlag = strFlag(args, "spec");
  const assumeYes = args.flags["yes"] === true;
  const storeFor = (specName: string): ReturnType<typeof createMemoryStore> =>
    createMemoryStore({ specName, rootDir: memoriesDir });
  const confirmOrDie = async (prompt: string): Promise<boolean> => {
    if (assumeYes) return true;
    if (process.stdin.isTTY !== true) {
      die(`memory ${action}: refusing a destructive operation without --yes in a non-TTY session`);
    }
    return await promptYesNo(prompt);
  };

  switch (action) {
    case "list": {
      const specs =
        specFlag !== undefined
          ? [resolveMemorySpec(memoriesDir, specFlag)]
          : listMemorySpecs(memoriesDir);
      if (specs.length === 0) die(`no memory files under ${memoriesDir}`);
      for (const spec of specs) {
        const items = await storeFor(spec).list();
        for (const line of renderMemoryList(spec, items, nowMs)) {
          process.stdout.write(`${line}\n`);
        }
      }
      return;
    }
    case "show": {
      const id = args.positional[1];
      if (id === undefined) die("usage: crewhaus memory show <mem_id> [--spec <name>]");
      const specs =
        specFlag !== undefined
          ? [resolveMemorySpec(memoriesDir, specFlag)]
          : listMemorySpecs(memoriesDir);
      for (const spec of specs) {
        const item = (await storeFor(spec).list()).find((i) => i.entry.id === id);
        if (item !== undefined) {
          process.stdout.write(`spec:          ${spec}\n`);
          for (const line of renderMemoryShow(item)) process.stdout.write(`${line}\n`);
          return;
        }
      }
      die(`no memory with id ${id} under ${memoriesDir}`);
      return;
    }
    case "forget": {
      const id = args.positional[1];
      const query = strFlag(args, "query");
      if ((id === undefined) === (query === undefined)) {
        die("memory forget: provide exactly one of <mem_id> or --query <q>");
      }
      if (id !== undefined && !/^mem_[0-9a-f]{16}$/.test(id)) {
        die(`memory forget: "${id}" is not a memory id (mem_…) — text goes via --query`);
      }
      const spec = resolveMemorySpec(memoriesDir, specFlag);
      const store = storeFor(spec);
      // Preview the exact match set forget() will tombstone: for an id the
      // live entry, for a query every positive BM25 match (recall's set).
      const items = await store.list();
      const matches =
        id !== undefined
          ? items.filter((i) => i.status === "live" && i.entry.id === id)
          : (await store.recall(query as string, 10_000)).map((r) => ({
              entry: r.entry,
              status: "live" as const,
            }));
      if (matches.length === 0) {
        process.stdout.write(
          `[memory] nothing to forget — no live memory matched ${id ?? `"${query}"`} in ${spec}\n`,
        );
        return;
      }
      process.stdout.write(`[memory] will forget ${matches.length} memory(ies) from ${spec}:\n`);
      for (const line of renderMemoryList(spec, matches, nowMs).slice(1)) {
        process.stdout.write(`${line}\n`);
      }
      const go = await confirmOrDie(`forget ${matches.length} memory(ies) from ${spec}? [y/N] `);
      if (!go) {
        process.stdout.write("[memory] aborted — nothing forgotten\n");
        return;
      }
      const forgotten = await store.forget((id ?? query) as string, {
        reason: "crewhaus memory forget",
      });
      process.stdout.write(
        `[memory] forgot ${forgotten.length} memory(ies) (superseded tombstones in ${store.path()})\n`,
      );
      return;
    }
    case "sweep": {
      const specs =
        specFlag !== undefined
          ? [resolveMemorySpec(memoriesDir, specFlag)]
          : listMemorySpecs(memoriesDir);
      if (specs.length === 0) die(`no memory files under ${memoriesDir}`);
      for (const spec of specs) {
        const result = await storeFor(spec).sweep();
        process.stdout.write(
          `[memory] ${spec}: swept ${result.swept} expired memory(ies), ${result.live} live\n`,
        );
      }
      if (args.flags["compact"] === true) {
        const go = await confirmOrDie(
          `compact ${specs.length} memory file(s) (rewrites dropping tombstoned/expired lines)? [y/N] `,
        );
        if (!go) {
          process.stdout.write("[memory] compact aborted — files untouched\n");
          return;
        }
        for (const spec of specs) {
          const result = await storeFor(spec).compact();
          process.stdout.write(
            `[memory] ${spec}: compacted — kept ${result.kept} line(s), dropped ${result.dropped}\n`,
          );
        }
      }
      return;
    }
    default:
      die(`memory: unknown action "${action ?? ""}" — supported: list, show, forget, sweep`);
  }
}

/**
 * `crewhaus migrate memories [--dry-run]` — the schema-v2 backfill over
 * `.crewhaus/memories/*.jsonl` via the Section-28 migration-engine chain:
 * stamps `schemaVersion: 2` on v1 entries, derives `provenance.sessionId`
 * where the v1 auto-capture tags carry it, preserves every other line
 * verbatim, and records the store version in `.crewhaus/meta.json`.
 * Idempotent — a re-run migrates 0 entries.
 */
async function runMigrateMemories(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] === true) {
    process.stdout.write(
      "usage: crewhaus migrate memories [--dry-run]\n" +
        "  Backfill the v2 memory-entry schema (schemaVersion + derivable provenance)\n" +
        "  onto .crewhaus/memories/*.jsonl and stamp .crewhaus/meta.json. Idempotent;\n" +
        "  --dry-run reports the plan without writing.\n",
    );
    return;
  }
  const report = migrateMemories(process.cwd(), {
    dryRun: args.flags["dry-run"] === true,
  });
  if (report.files.length === 0) {
    process.stdout.write(
      `[migrate] no memory files under ${join(process.cwd(), MEMORIES_SUBDIR)} — nothing to do\n`,
    );
    return;
  }
  for (const line of formatMigrateMemoriesReport(report)) process.stdout.write(`${line}\n`);
}

// -------- 0.3.0 memory release: crewhaus wiki --------

/**
 * `crewhaus wiki list|show <slug>|search <q>|stats` (design §3.1/§3.2, PR 9)
 * — inspect the per-spec local wikis under `.crewhaus/wiki/`. Read-only
 * verbs only: articles are written by the wiki_write tool (versioned,
 * supersede-never-delete), `clear|restore` ride the continuity trash
 * machinery, and `push|pull --thredz` arrives with the Thredz PR.
 */
async function runWiki(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (args.flags["help"] === true && action === undefined) {
    process.stdout.write(
      "usage: crewhaus wiki list [--spec <name>] [--tags <t1,t2>] [--status <s>]\n" +
        "       crewhaus wiki show <slug> [--spec <name>]\n" +
        "       crewhaus wiki search <q> [--spec <name>] [-k <n>]\n" +
        "       crewhaus wiki stats [--spec <name>]\n" +
        "  Inspect the per-spec local wikis under .crewhaus/wiki/ (versioned articles;\n" +
        "  priors are kept under versions/<slug>/ — superseded, never deleted). list is\n" +
        "  stalest-first (the REFLECT order); search is BM25 keyword ranking.\n",
    );
    return;
  }
  const wikiDir = join(process.cwd(), WIKI_SUBDIR);
  const nowMs = Date.now();
  const specFlag = strFlag(args, "spec");
  const storeFor = (specName: string): ReturnType<typeof createWikiStore> =>
    createWikiStore({ specName, rootDir: wikiDir });

  switch (action) {
    case "list": {
      const specs =
        specFlag !== undefined ? [resolveWikiSpec(wikiDir, specFlag)] : listWikiSpecs(wikiDir);
      if (specs.length === 0) die(`no wikis under ${wikiDir}`);
      const statusFlag = strFlag(args, "status");
      const status =
        statusFlag === "draft" ||
        statusFlag === "published" ||
        statusFlag === "review" ||
        statusFlag === "archived" ||
        statusFlag === "all"
          ? statusFlag
          : undefined;
      if (statusFlag !== undefined && status === undefined) {
        die(`wiki list: unknown --status "${statusFlag}" (draft|published|review|archived|all)`);
      }
      const tags = (strFlag(args, "tags") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
      for (const spec of specs) {
        const refs = await storeFor(spec).list({
          staleFirst: true,
          ...(status !== undefined ? { status } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        });
        for (const line of renderWikiList(spec, refs, nowMs)) {
          process.stdout.write(`${line}\n`);
        }
      }
      return;
    }
    case "show": {
      const slug = args.positional[1];
      if (slug === undefined) die("usage: crewhaus wiki show <slug> [--spec <name>]");
      const specs =
        specFlag !== undefined ? [resolveWikiSpec(wikiDir, specFlag)] : listWikiSpecs(wikiDir);
      for (const spec of specs) {
        const article = await storeFor(spec).get(slug as string);
        if (article !== null) {
          process.stdout.write(`spec:        ${spec}\n`);
          for (const line of renderWikiShow(article)) process.stdout.write(`${line}\n`);
          return;
        }
      }
      die(`no wiki article with slug "${slug}" under ${wikiDir}`);
      return;
    }
    case "search": {
      const query = args.positional[1];
      if (query === undefined) die("usage: crewhaus wiki search <q> [--spec <name>] [-k <n>]");
      const k = Math.max(1, Number.parseInt(strFlag(args, "k") ?? "10", 10) || 10);
      const spec = resolveWikiSpec(wikiDir, specFlag);
      const refs = await storeFor(spec).search(query as string);
      for (const line of renderWikiSearch(spec, query as string, refs.slice(0, k))) {
        process.stdout.write(`${line}\n`);
      }
      return;
    }
    case "stats": {
      const specs =
        specFlag !== undefined ? [resolveWikiSpec(wikiDir, specFlag)] : listWikiSpecs(wikiDir);
      if (specs.length === 0) die(`no wikis under ${wikiDir}`);
      for (const spec of specs) {
        for (const line of renderWikiStats(spec, await storeFor(spec).stats())) {
          process.stdout.write(`${line}\n`);
        }
      }
      return;
    }
    default:
      die(`wiki: unknown action "${action ?? ""}" — supported: list, show, search, stats`);
  }
}

// -------- item 4: crewhaus graders suggest --------

/**
 * Item 4 — `crewhaus graders suggest`: cluster the failure rationale
 * accumulated in recent eval runs (grades.json via the item-3 run-history
 * index) and user feedback comments into themes, draft deterministic
 * graders per theme from the observed up-rated outputs, optionally add a
 * model-drafted llm_judge rubric, and write a REVIEW file — never applied
 * automatically. All the pure logic lives in ./graders-suggest; this is
 * flag parsing + IO per house pattern.
 */
async function runGradersSuggest(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus graders suggest [--runs <dir|last:N>] [--model <m>] [-o <file>]\n" +
        "                                [--spec <name>] [--min-score F] [--force]\n" +
        "  Draft grader suites from evidence that already exists (item 4):\n" +
        "    - per-sample grader rationale (grades.json) from recent eval runs —\n" +
        "      located via the run-history index for the cwd spec (last 10 by\n" +
        "      default; --runs last:N or --runs <run-dir> to choose)\n" +
        "    - judge criterionScores where present\n" +
        "    - user feedback comments (down-rated = failure evidence; up-rated\n" +
        "      turns = good exemplars)\n" +
        "  Failure texts cluster into themes DETERMINISTICALLY (token overlap — no\n" +
        "  model call); each theme gets a deterministic draft grader\n" +
        "  (tool_call_sequence/json_path/regex/contains) derived from the up-rated\n" +
        "  outputs. With --model (or visible credentials for the cwd spec's model) a\n" +
        "  complete llm_judge rubric — all five anchors — is additionally drafted\n" +
        "  from real good/bad exemplars.\n" +
        "  Output is a REVIEW file (-o, default graders-suggested.yaml): valid\n" +
        "  graders.yaml with an evidence comment per grader. It is NEVER applied\n" +
        "  automatically — and its header documents that stacking graders hard-ANDs\n" +
        "  their scores, so adopt ONE grader rather than the whole stack.\n",
    );
    return;
  }
  const force = args.flags["force"] === true;
  const outPath = resolve(strFlag(args, "out") ?? DEFAULT_SUGGESTED_GRADERS_FILE);
  if (!force && existsSync(outPath)) {
    die(`refusing to overwrite ${outPath} — re-run with --force to replace it`);
  }
  const minScore = floatFlag(args, "min-score") ?? 0.7;
  if (minScore < 0 || minScore > 1) die(`invalid --min-score "${minScore}" — must be in [0,1]`);

  // Spec name filter for the run index: --spec > the cwd crewhaus.yaml's
  // name (tolerant — an unparseable spec just means no filter).
  let specName = strFlag(args, "spec");
  const cwdSpecPath = join(process.cwd(), "crewhaus.yaml");
  const cwdSpecText = existsSync(cwdSpecPath) ? readFileSync(cwdSpecPath, "utf-8") : undefined;
  if (specName === undefined && cwdSpecText !== undefined) {
    try {
      specName = parseSpec(cwdSpecText).name;
    } catch {
      // Unparseable cwd spec — suggest across every indexed run.
    }
  }

  // Resolve the runs to mine: an explicit run dir, or the last N entries of
  // the item-3 run-history index (filtered to this spec when known).
  let selector: RunsSelector = { kind: "last", n: DEFAULT_SUGGEST_RUNS };
  const runsFlag = strFlag(args, "runs");
  if (runsFlag !== undefined) {
    try {
      selector = parseRunsFlag(runsFlag);
    } catch (err) {
      if (err instanceof GradersSuggestError) die(err.message);
      throw err;
    }
  }
  let runDirs: string[];
  if (selector.kind === "dir") {
    runDirs = [resolve(selector.dir)];
  } else {
    const entries = readEvalRunIndex().filter(
      (e) => specName === undefined || e.specName === specName,
    );
    runDirs = entries.slice(-selector.n).map((e) => e.outDir);
  }

  const failures: FailureEvidence[] = [];
  const passes: PassExemplar[] = [];
  let runsSeen = 0;
  for (const dir of runDirs) {
    try {
      const evidence = evidenceFromRun(await loadRun(dir));
      failures.push(...evidence.failures);
      passes.push(...evidence.passes);
      runsSeen += 1;
    } catch (err) {
      process.stderr.write(
        `[graders] run ${dir} unreadable (${err instanceof Error ? err.message : String(err)}) — skipped\n`,
      );
    }
  }

  // User feedback — the same sources `crewhaus distill` reads (transcript
  // ratings + the web-UI feedback dir).
  const turns: SessionTurn[] = [];
  const records: FeedbackRecord[] = [];
  for (const id of listSessionIds(join(process.cwd(), SESSIONS_SUBDIR))) {
    const events = readSessionEvents(id);
    for (const t of deriveTurns(events)) turns.push({ ...t, sessionId: id });
    records.push(...extractFeedbackRecords(events));
  }
  records.push(...readFeedbackDir(join(process.cwd(), FEEDBACK_SUBDIR)));
  const feedbackEvidence = evidenceFromFeedback(turns, records, minScore);
  failures.push(...feedbackEvidence.failures);
  passes.push(...feedbackEvidence.passes);

  if (failures.length === 0) {
    die(
      `no failure rationale found in ${runsSeen} eval run(s) or the ratings — run \`crewhaus eval\` (or collect down-rated feedback) first`,
    );
  }

  const themes = clusterFailures(failures);
  const draft = draftGradersForThemes(themes, passes);
  const suggestions: SuggestedGrader[] = [...draft.suggestions];

  // Model-drafted llm_judge rubric from real good/bad exemplars: --model
  // opts in outright; otherwise the cwd spec's model when its credentials
  // are visible. Best-effort — a failed/unusable draft keeps the
  // deterministic suggestions.
  const modelFlag = strFlag(args, "model");
  let rubricModel = modelFlag;
  if (rubricModel === undefined && cwdSpecText !== undefined) {
    const specModel = extractSpecModel(cwdSpecText);
    if (specModel !== undefined && providerCredentialsSatisfied(specModel, process.env)) {
      rubricModel = specModel;
    }
  }
  if (rubricModel !== undefined) {
    try {
      const raw = await oneShotModelText({
        model: rubricModel,
        system: RUBRIC_SUGGESTION_SYSTEM,
        prompt: buildRubricSuggestionPrompt(
          passes.map((p) => p.output),
          failures,
          themes,
        ),
      });
      const rubric = parseRubricSuggestion(raw, modelFlag);
      if (rubric !== undefined) {
        suggestions.unshift({
          spec: rubric,
          evidence: [
            `llm_judge rubric drafted by ${rubricModel} from ${passes.length} good exemplar(s) and ${failures.length} failure rationale(s) — review the anchors before adopting`,
          ],
        });
      } else {
        process.stderr.write(
          "[graders] rubric draft unusable (bad response shape) — deterministic suggestions only\n",
        );
      }
    } catch (err) {
      process.stderr.write(
        `[graders] rubric draft failed (${err instanceof Error ? err.message : String(err)}) — deterministic suggestions only\n`,
      );
    }
  }

  if (suggestions.length === 0) {
    die(
      "no graders could be drafted — the failure themes had no deterministic signal in the up-rated outputs; re-run with --model for an llm_judge rubric drafted from the exemplars",
    );
  }

  const yaml = renderSuggestedGradersYaml(suggestions, {
    ...(specName !== undefined ? { specName } : {}),
    runsSeen,
    failureCount: failures.length,
    feedbackCount: feedbackEvidence.failures.length,
    undraftedLabels: draft.undrafted.map((t) => t.label),
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, yaml);

  process.stdout.write(
    `[graders] ${failures.length} failure rationale(s) across ${runsSeen} run(s)` +
      `${feedbackEvidence.failures.length > 0 ? ` + ${feedbackEvidence.failures.length} rating comment(s)` : ""} → ${themes.length} theme(s)\n`,
  );
  for (const t of themes.slice(0, 8)) {
    process.stdout.write(
      `[graders]   theme "${t.label}": ${t.items.length} rationale(s) on ${t.sampleIds.length} sample(s)\n`,
    );
  }
  process.stdout.write(`[graders] drafted ${suggestions.length} grader(s) → ${outPath}\n`);
  process.stdout.write(
    "[graders] review file — adopt ONE grader into eval/graders.yaml (stacking graders\n" +
      "    hard-ANDs their scores; see the file header)\n",
  );
}

// -------- E48: crewhaus graders test --------

/**
 * E48 — `crewhaus graders test`: replay EVERY grader in a graders.yaml over
 * a labeled golden-verdict set and score each one against the human
 * verdicts (agreement, Cohen's kappa, FP/FN exemplars, score MAE). The
 * pure halves live in ./graders-test; this is flag parsing + IO per house
 * pattern. Deterministic + registry graders replay credential-free;
 * llm_judge graders skip with a notice when no judge credentials are
 * visible (never fabricate). `--min-agreement F` exits non-zero when any
 * TESTED grader falls below the floor — the CI gate for rubric edits.
 */
async function runGradersTest(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus graders test --graders <graders.yaml> --golden <verdicts.jsonl>\n" +
        "                             [--judge-model <model>] [--min-agreement F]\n" +
        "  Meta-eval a grader suite against human-adjudicated golden verdicts (E48).\n" +
        "  Each golden line is strict JSONL:\n" +
        '    {"id": "q1", "input": "...", "agent_output": "...",\n' +
        '     "expected_passed": true, "expected_score": 0.75}\n' +
        "  expected_score is optional and normalized 0..1 (the GradeResult.score\n" +
        "  scale — a judge's 1-5 maps via (n-1)/4). Every grader in the config is\n" +
        "  replayed over the recorded agent_output: deterministic and registry\n" +
        "  graders run credential-free; llm_judge graders need visible judge\n" +
        "  credentials and are SKIPPED with a notice without them (the rest still\n" +
        "  test). target: transcript judges always skip — golden verdicts carry\n" +
        "  only the final output. Judge rubrics test at their DECLARED\n" +
        "  passing_score (default 3/5); the judge-calibration overlay from\n" +
        "  `judge calibrate --apply` is not applied here.\n" +
        "  Per grader: agreement rate + Cohen's kappa vs expected_passed, false\n" +
        "  positives/negatives with up to 5 exemplar ids each, abstained/error\n" +
        "  counts (excluded from agreement), and mean absolute score error when\n" +
        "  expected_score is present. --min-agreement F (0..1) exits non-zero when\n" +
        "  any TESTED grader's agreement falls below F (skipped graders never\n" +
        "  gate) — CI-gateable like `eval --gate`.\n",
    );
    return;
  }
  const gradersPath = strFlag(args, "graders");
  if (gradersPath === undefined) die("missing --graders <graders.yaml>");
  const goldenPath = strFlag(args, "golden");
  if (goldenPath === undefined) die("missing --golden <verdicts.jsonl>");
  const minAgreement = floatFlag(args, "min-agreement");
  if (minAgreement !== undefined && (minAgreement < 0 || minAgreement > 1)) {
    die(`invalid --min-agreement "${minAgreement}" — must be in [0,1]`);
  }
  const judgeModelFlag = strFlag(args, "judge-model");

  const absGraders = resolve(gradersPath);
  if (!existsSync(absGraders)) die(`graders file not found at ${absGraders}`);
  let compiled: ReturnType<typeof parseGradersConfig>["compiled"];
  try {
    compiled = parseGradersConfig(readFileSync(absGraders, "utf-8")).compiled;
  } catch (err) {
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }

  const absGolden = resolve(goldenPath);
  if (!existsSync(absGolden)) die(`golden file not found at ${absGolden}`);
  let goldens: ReturnType<typeof parseGoldenVerdicts>;
  try {
    goldens = parseGoldenVerdicts(readFileSync(absGolden, "utf-8"));
  } catch (err) {
    if (err instanceof GradersTestError) die(err.message);
    throw err;
  }

  // G14 — registry entries resolve against the default grader registry
  // (packs + .crewhaus/graders plugins), built only when needed. Resolution
  // failures (unknown name, bad opts) are loud at start, mirroring runEval.
  let resolved: ReturnType<typeof resolveTestGraders>;
  try {
    const graderRegistry = await graderRegistryForCompiled(compiled);
    resolved = resolveTestGraders(compiled, {
      ...(judgeModelFlag !== undefined ? { judgeModel: judgeModelFlag } : {}),
      ...(graderRegistry !== undefined ? { graderRegistry } : {}),
    });
  } catch (err) {
    if (err instanceof GradersTestError || err instanceof CrewhausError) die(err.message);
    throw err;
  }
  if (resolved.graders.length === 0) {
    for (const s of resolved.skipped) {
      process.stderr.write(`[graders test] skipped llm_judge "${s.name}" — ${s.reason}\n`);
    }
    die("no testable graders — every grader in the config was skipped");
  }

  const reports: GraderTestReport[] = [];
  for (const g of resolved.graders) {
    const outcomes = await replayGraderOnGoldens(g.grader, goldens);
    reports.push(summarizeGraderTest(g.name, g.kind, outcomes));
  }
  process.stdout.write(renderGradersTestReport(reports, resolved.skipped, goldens.length));

  if (minAgreement !== undefined) {
    const failing = belowFloor(reports, minAgreement);
    if (failing.length > 0) {
      for (const r of failing) {
        process.stderr.write(
          `[graders test] FAIL: grader "${r.name}" agreement ${r.agreementRate.toFixed(3)} < --min-agreement ${minAgreement}\n`,
        );
      }
      process.exit(1);
    }
    process.stdout.write(
      `[graders test] gate passed — all ${reports.length} tested grader(s) at or above --min-agreement ${minAgreement}\n`,
    );
  }
}

/**
 * NEW-HUNT-11 — `crewhaus graders card`: render the graders.yaml as the
 * markdown rubric card (see graders-card.ts). The hash on the card is
 * computed by the SAME `hashGradersConfig` the run-history index and
 * baseline pins record, so the documented instrument identity can never
 * drift from the one the sentinel/baseline guards compare. Deterministic:
 * the only timestamp derives from the graders FILE's mtime — re-rendering
 * an unchanged config is byte-identical.
 */
async function runGradersCard(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus graders card (--graders <graders.yaml> | --template <family>) [-o <file>]\n" +
        "  Render the graders config as a markdown RUBRIC CARD — the measurement-\n" +
        "  instrument documentation artifact for a release PR (NEW-HUNT-11): every\n" +
        "  grader's type, options, and thresholds; every llm_judge rubric's criteria\n" +
        "  and anchors (or categorical labels + passing set), passing cut, and\n" +
        "  panel/repeats/temperature/target; every registry entry's pack opts; and\n" +
        "  the config's gradersHash — the exact instrument identity recorded in\n" +
        "  run.json, the run-history index, and baseline pins.\n" +
        "  --template <family> (E47) cards one of the embedded eval-template families\n" +
        "  (rag, summarize, extract, support, safety, classify) INSTEAD of a file, so\n" +
        "  you can read what a family measures before scaffolding it into a harness.\n" +
        "  The hash is the family's own: card a family, then card the scaffolded\n" +
        "  graders.yaml, and an identical hash proves the copy is unedited.\n" +
        "  Deterministic by design: no wall clock, randomness, or timestamps —\n" +
        "  identity is content-derived (the gradersHash), so re-rendering an\n" +
        "  unchanged config is byte-identical in ANY checkout and a card diff\n" +
        "  shows real instrument changes only.\n" +
        "  Writes to stdout; -o <file> writes the card there instead.\n",
    );
    return;
  }
  const gradersPath = strFlag(args, "graders");
  const familyFlag = strFlag(args, "template");
  if (gradersPath !== undefined && familyFlag !== undefined) {
    die("--graders and --template are mutually exclusive — card one instrument at a time");
  }
  if (gradersPath === undefined && familyFlag === undefined) {
    die("missing --graders <graders.yaml> (or --template <family> for an eval-template family)");
  }
  let config: GradersConfig;
  let source: string;
  if (familyFlag !== undefined) {
    // The family's graders.yaml is parsed through the REAL parser, so the
    // card documents what the runner would actually build from it.
    const { firstPartyGraderTemplates, graderTemplateCatalog, validateGraderTemplate } =
      await import("@crewhaus/template-registry");
    let manifest: Awaited<ReturnType<ReturnType<typeof firstPartyGraderTemplates>["fetch"]>>;
    try {
      manifest = await firstPartyGraderTemplates().fetch(familyFlag);
    } catch {
      die(unknownTemplateMessage(familyFlag, graderTemplateCatalog()));
    }
    const shape = validateGraderTemplate(manifest);
    if (!shape.ok || manifest.evalAssets === undefined) {
      die(`eval-template "${familyFlag}" is malformed: ${shape.reason ?? "no eval assets"}`);
    }
    try {
      config = parseGradersConfig(manifest.evalAssets.gradersYaml).config;
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    source = `eval-template ${manifest.name}@${manifest.version}`;
  } else {
    const absGraders = resolve(gradersPath as string);
    if (!existsSync(absGraders)) die(`graders file not found at ${absGraders}`);
    try {
      config = parseGradersConfig(readFileSync(absGraders, "utf-8")).config;
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    source = gradersPath as string;
  }
  const card = renderGradersCard({
    config,
    gradersHash: hashGradersConfig(config),
    source,
  });
  const outArg = strFlag(args, "out");
  if (outArg !== undefined) {
    const absOut = resolve(outArg);
    mkdirSync(dirname(absOut), { recursive: true });
    writeFileSync(absOut, card);
    process.stdout.write(`[graders card] wrote ${absOut}\n`);
  } else {
    process.stdout.write(card);
  }
}

/**
 * Item 1 — post-session feedback teardown for the cli run path: the
 * `feedback.autoDistill` consumer. When `autoDistill` is enabled and the
 * accumulated store (all sessions + the web-UI feedback dir) holds enough
 * unprocessed ratings past the watermark, run the existing distill() and
 * register the result as a new version of the `<specName>-ratings` registry
 * dataset (see ./autodistill.ts) — consumable as
 * `--dataset registry:<specName>-ratings` by eval and optimize.
 *
 * The block's OTHER half — the one-keystroke exit rating prompt — used to live
 * here too, which is exactly why a COMPILED cli bundle had no rating capture:
 * the cli emitter dropped the `feedback:` block and only this path implemented
 * it. The prompt now belongs to the runtime (`runChatLoop`'s `feedback`
 * option, @crewhaus/runtime-core's exit-rating module), so `crewhaus run` and
 * `bun dist/agent.ts` ask it identically and write the same `user_feedback`
 * record. Auto-distillation stays here: it registers a VERSIONED dataset for
 * `eval`/`optimize` to consume, which is a toolchain step rather than a
 * property of the running agent (the compiler warns when a cli spec declares
 * `feedback.autoDistill`, so nobody ships a bundle expecting it).
 */
async function runFeedbackTeardown(
  ir: Extract<ReturnType<typeof lower>, { target: "cli" }>,
): Promise<void> {
  // "Watch me" (design/watch-me.md §11) — a user-scope watched harness
  // self-registers in the global registry at run time, so `watchme report
  // --all` discovers it without a manual `watchme start` on this machine.
  if (ir.watchme?.scope === "user") {
    try {
      openHarnessRegistry(watchmeGlobalRoot(undefined)).register({
        dir: process.cwd(),
        specName: ir.name,
        target: ir.target,
        share: ir.watchme?.share === true,
      });
    } catch {
      // Best-effort — a registry hiccup must never fail a run's teardown.
    }
  }

  if (ir.feedback === undefined) return;

  // The autoDistill consumer. (The exit rating prompt that used to run here
  // first now fires inside runChatLoop — see this function's doc comment.)
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
    // B19/B20 — withheld split verdicts land in the harness review queue.
    reviewRootDir: process.cwd(),
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
 * Item 58 — `crewhaus fleet list|status|run <sub>`. The cross-harness view.
 *
 * `list`   — discover every harness (dir with a `crewhaus.yaml`) under
 *            `--root` (default cwd) and print the rolled-up inventory.
 * `status` — the same, rendered as a per-harness health rollup
 *            (registered? eval healthy vs its pinned baseline? open
 *            incidents? audit present?).
 * `run <sub> [--filter <glob>]` — run a READ-ONLY subcommand across the
 *            filtered fleet, aggregating exit codes. A mutating subcommand is
 *            refused unless `--allow-mutating` AND each harness is confirmed
 *            (interactive prompt; `--yes` for CI).
 *
 * The heavy lifting (discovery, aggregation, health marks, bulk plan) lives
 * in the side-effect-free `./fleet` module; this handler only wires the real
 * reader/runner/confirm seams to it.
 */
async function runFleet(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"] || action === "") {
    // HM-202 — the text lives in `./fleet` so it is testable without
    // executing this file's top-level argv switch. It must be PRINTED from
    // here, though: a constant no invocation reaches documents nothing.
    process.stdout.write(FLEET_USAGE);
    return;
  }

  const rootFlag = args.flags["root"];
  const root = typeof rootFlag === "string" ? rootFlag : process.cwd();

  // Manifest reader: open the harness's own `.crewhaus/specs` registry and
  // read the spec's manifest. A spec never registered there → undefined
  // (unregistered), the row still renders.
  const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
  const readManifest: BuildInventoryDeps["readManifest"] = async (specName, registryRoot) => {
    try {
      const reg = createFileBackedRegistry({ rootDir: registryRoot });
      const manifest = await reg.manifest(specName);
      // An empty manifest (no versions, no pins) means "not registered".
      if (manifest.versions.length === 0 && Object.keys(manifest.pins).length === 0) {
        return undefined;
      }
      return manifest;
    } catch {
      return undefined;
    }
  };

  // Eval-index reader: the harness's `.crewhaus/evals/index.jsonl`, mapped to
  // the minimal shape the fleet row needs.
  const readEvalIndex: BuildInventoryDeps["readEvalIndex"] = (evalsDir): LastEvalEntry[] =>
    readEvalRunIndex(evalsDir).map((e) => ({
      datasetName: e.datasetName,
      passRate: e.passRate,
      ts: e.ts,
    }));

  const deps: BuildInventoryDeps = { readManifest, readEvalIndex };

  // Hangar F-2 — `--group <name>`: restrict the discovered set to harnesses
  // whose machine-registry entry carries the group (membership is
  // user-managed via `crewhaus harness group`). Discovery still walks the
  // filesystem; rows whose dir has no in-group registry entry drop out.
  const groupFlag = args.flags["group"];
  let inGroup: ((dir: string) => boolean) | undefined;
  if (typeof groupFlag === "string") {
    const { openHangarRegistry } = await import("@crewhaus/harness-registry");
    const memberDirs = new Set(
      openHangarRegistry()
        .list()
        .filter((e) => e.groups.includes(groupFlag))
        .map((e) => e.dir),
    );
    inGroup = (dir: string): boolean => memberDirs.has(resolve(dir));
  }

  // A group filter that empties a non-empty discovery must say so — the
  // package's zero-row message ("no crewhaus.yaml found") would be wrong.
  const emptiedByGroup = (filteredCount: number, discoveredCount: number): boolean =>
    inGroup !== undefined && filteredCount === 0 && discoveredCount > 0;

  try {
    if (action === "list") {
      const discovered = await buildFleetInventory(root, deps);
      const rows = discovered.filter((r) => inGroup === undefined || inGroup(r.dir));
      if (emptiedByGroup(rows.length, discovered.length)) {
        process.stdout.write(
          `no harnesses under ${resolve(root)} are in group "${groupFlag}" (${discovered.length} discovered — manage membership with \`crewhaus harness group\`)\n`,
        );
        return;
      }
      for (const line of formatFleetInventory(rows, root)) process.stdout.write(`${line}\n`);
      return;
    }
    if (action === "status") {
      const discovered = await buildFleetInventory(root, deps);
      const rows = discovered.filter((r) => inGroup === undefined || inGroup(r.dir));
      if (emptiedByGroup(rows.length, discovered.length)) {
        process.stdout.write(
          `no harnesses under ${resolve(root)} are in group "${groupFlag}" (${discovered.length} discovered — manage membership with \`crewhaus harness group\`)\n`,
        );
        return;
      }
      // Eval health: the last run for a (spec, its pinned dataset) baseline
      // held or beat the baseline's pass rate. No baseline yet → healthy (a
      // fresh harness isn't "attention"); a last run below the pinned
      // baseline → attention.
      const readEvalHealth: EvalHealthReader = (evalsDir) => {
        const runs = readEvalRunIndex(evalsDir);
        if (runs.length === 0) return { healthy: true, note: "no runs recorded" };
        const baselines = readBaselines(evalsDir);
        const baselineList = Object.values(baselines);
        if (baselineList.length === 0) {
          return { healthy: true, note: `${runs.length} run(s), no baseline pinned` };
        }
        // Newest run per (spec, dataset), compared to the pinned baseline's run.
        let regressed = false;
        const notes: string[] = [];
        for (const b of baselineList) {
          const forKey = runs
            .filter((r) => r.specName === b.specName && r.datasetName === b.datasetName)
            .sort((x, y) => (x.ts < y.ts ? -1 : 1));
          const latest = forKey[forKey.length - 1];
          const baselineRun = runs.find((r) => r.runId === b.runId);
          if (latest === undefined || baselineRun === undefined) continue;
          if (latest.passRate < baselineRun.passRate) {
            regressed = true;
            notes.push(
              `${b.datasetName} ${(latest.passRate * 100).toFixed(0)}% < baseline ${(baselineRun.passRate * 100).toFixed(0)}%`,
            );
          }
        }
        return regressed
          ? { healthy: false, note: `below baseline: ${notes.join("; ")}` }
          : { healthy: true, note: "all baselines held" };
      };
      const health = [];
      for (const inv of rows) health.push(await buildHarnessHealth(inv, readEvalHealth));
      for (const line of formatHealth(health, root)) process.stdout.write(`${line}\n`);
      return;
    }
    if (action === "run") {
      const tokens = [...args.positional];
      const filterFlag = args.flags["filter"];
      const filter = typeof filterFlag === "string" ? filterFlag : undefined;
      const allowMutating = args.flags["allow-mutating"] === true;
      const assumeYes = args.flags["yes"] === true;

      // Production runner: spawn `crewhaus <argv>` in the harness dir (the cwd
      // every subcommand resolves `.crewhaus/` state from). No shell — an argv
      // array through Bun.spawn. `fleetSelfInvokeArgv` re-invokes THIS CLI so a
      // bulk `doctor` runs the SAME binary, correct under both `bun run` and a
      // `bun build --compile` single-file binary: the compiled binary
      // re-injects its own `/$bunfs/…` entry, so we must NOT pass our `Bun.main`
      // as a subcommand (see fleet.ts — that was the v0.2.4 fleet-run bug).
      const runner: FleetRunner = async ({ cwd, argv }) => {
        const spawnArgv = fleetSelfInvokeArgv(
          { execPath: process.execPath, entryPath: Bun.main },
          argv,
        );
        const proc = Bun.spawn(spawnArgv, {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited,
        ]);
        const combined = `${stdout}${stderr}`.trim();
        return { exitCode, tail: combined };
      };

      // Per-harness confirm for a mutating bulk op. `--yes` auto-confirms
      // (scripted/CI); otherwise a y/N prompt per harness.
      const confirm = async (
        inv: HarnessInventory,
        argv: ReadonlyArray<string>,
      ): Promise<boolean> => {
        if (assumeYes) return true;
        return await promptYesNo(
          `run mutating \`crewhaus ${argv.join(" ")}\` in ${inv.specName} (${inv.dir})? [y/N] `,
        );
      };

      let report: RunFleetBulkReport;
      if (inGroup === undefined) {
        report = await runFleetBulk({
          root,
          subcommandTokens: tokens,
          ...(filter !== undefined ? { filter } : {}),
          allowMutating,
          deps,
          runner,
          confirm,
        });
      } else {
        // Hangar F-2 — `fleet run --group`: runFleetBulk discovers its own
        // inventory and exposes no membership seam, so the group case
        // composes the SAME exported pieces (plan resolution, inventory,
        // glob filter, runner/confirm seams, report shape) around a
        // pre-filtered row set. Group non-members are dropped before the
        // loop (not reported as skipped — they were never candidates).
        const plan = resolveBulkCommand(tokens, allowMutating);
        const inventory = (await buildFleetInventory(root, deps)).filter((inv) => inGroup(inv.dir));
        const results: BulkRunResult[] = [];
        let failed = 0;
        let passed = 0;
        let skipped = 0;
        for (const inv of inventory) {
          if (!matchesFilter(inv, filter)) {
            results.push({ inv, ran: false, skipReason: "filtered out" });
            skipped += 1;
            continue;
          }
          if (plan.mutating) {
            const ok = await confirm(inv, plan.argv);
            if (!ok) {
              results.push({ inv, ran: false, skipReason: "declined at confirm" });
              skipped += 1;
              continue;
            }
          }
          const { exitCode, tail } = await runner({ cwd: inv.dir, argv: plan.argv });
          results.push({ inv, ran: true, exitCode, tail });
          if (exitCode === 0) passed += 1;
          else failed += 1;
        }
        report = { plan, results, failed, passed, skipped };
      }
      for (const line of formatBulkReport(report)) process.stdout.write(`${line}\n`);
      if (report.failed > 0) process.exit(1);
      return;
    }
    die(`unknown fleet action "${action}" (expected: list | status | run)`);
  } catch (err) {
    if (err instanceof FleetError) die(err.message);
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
}

/**
 * Item 63 — `crewhaus knowledge sync [--pull|--push]`. Move shared memories /
 * graders / prompt fragments between the opted-in harnesses under `--root`
 * and a fleet-level shared store. Push redacts (PII + credential-shaped
 * tokens) and drops anything a token survives; pull dedupes by content hash.
 * Heavy logic is in `./knowledge-sync`; this wires the real redactor + fs.
 */
async function runKnowledge(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"] || action !== "sync") {
    process.stdout.write(
      "usage: crewhaus knowledge sync [--pull | --push] [--root <dir>] [--shared <dir>]\n" +
        "         [--dry-run] [--no-redact]\n" +
        "\n" +
        "  Move shared memories, reusable graders.yaml, and prompt fragments between\n" +
        "  the opted-in harnesses under --root (a dir with .crewhaus/knowledge.json\n" +
        '  {"share": true}) and a fleet-level shared store (default ./.crewhaus-shared,\n' +
        "  or CREWHAUS_SHARED_DIR). --push shares OUT (redacting PII + credential-shaped\n" +
        "  tokens; anything a token survives is dropped, never shared); --pull brings\n" +
        "  IN. Both dedupe by content hash, so re-running is a no-op. With neither flag,\n" +
        "  sync does push then pull.\n",
    );
    return;
  }
  const rootFlag = args.flags["root"];
  const root = typeof rootFlag === "string" ? rootFlag : process.cwd();
  const sharedFlag = args.flags["shared"];
  const sharedDir = resolve(
    typeof sharedFlag === "string"
      ? sharedFlag
      : (process.env["CREWHAUS_SHARED_DIR"] ?? join(root, SHARED_DIR_DEFAULT)),
  );
  const dryRun = args.flags["dry-run"] === true;
  const doPush = args.flags["push"] === true || args.flags["pull"] !== true;
  const doPull = args.flags["pull"] === true || args.flags["push"] !== true;
  const redact =
    args.flags["no-redact"] === true
      ? identityRedactor()
      : await buildProductionKnowledgeRedactor();
  const now = (): Date => new Date();

  const { discoverHarnesses } = await import("./fleet");
  let harnesses: Array<{ dir: string }>;
  try {
    harnesses = discoverHarnesses(root);
  } catch (err) {
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
  const optedIn = harnesses.filter((h) => harnessOptedIn(h.dir));
  if (optedIn.length === 0) {
    process.stdout.write(
      `no opted-in harnesses under ${resolve(root)} — add .crewhaus/knowledge.json {"share": true} to participate\n`,
    );
    return;
  }

  process.stdout.write(
    `knowledge sync — ${optedIn.length} opted-in harness(es), shared store ${sharedDir}${dryRun ? " (dry run)" : ""}\n`,
  );

  try {
    if (doPush) {
      for (const h of optedIn) {
        const existingMemoryHashes = new Set(
          readSharedMemories(sharedDir).map((m) => m.contentHash),
        );
        const existingFragmentHashes = new Set([
          ...readSharedFragments(sharedDir, "grader").map((f) => f.contentHash),
          ...readSharedFragments(sharedDir, "prompt").map((f) => f.contentHash),
        ]);
        const graders = readHarnessGraders(h.dir);
        const plan: PushPlan = await planPush({
          harness: basename(h.dir),
          memories: readHarnessMemories(h.dir),
          ...(graders !== undefined ? { graders } : {}),
          prompts: readHarnessPrompts(h.dir),
          existingMemoryHashes,
          existingFragmentHashes,
          redact,
          now,
        });
        if (!dryRun) applyPush(sharedDir, plan, now);
        for (const line of formatPushReport(basename(h.dir), plan, dryRun)) {
          process.stdout.write(`${line}\n`);
        }
      }
    }
    if (doPull) {
      const sharedMemories = readSharedMemories(sharedDir);
      const sharedFragments = [
        ...readSharedFragments(sharedDir, "grader"),
        ...readSharedFragments(sharedDir, "prompt"),
      ];
      for (const h of optedIn) {
        const harnessMemoryHashes = new Set(
          readHarnessMemories(h.dir).map((m) => memoryContentHash(m.text, m.tags)),
        );
        const harnessFragmentHashes = new Set([
          ...(readHarnessGraders(h.dir) !== undefined
            ? [fragmentContentHash((readHarnessGraders(h.dir) as { contents: string }).contents)]
            : []),
          ...readHarnessPrompts(h.dir).map((p) => fragmentContentHash(p.contents)),
        ]);
        const plan: PullPlan = planPull({
          sharedMemories,
          sharedFragments,
          harnessMemoryHashes,
          harnessFragmentHashes,
        });
        if (!dryRun) applyPull(h.dir, plan, now);
        for (const line of formatPullReport(basename(h.dir), plan, dryRun)) {
          process.stdout.write(`${line}\n`);
        }
      }
    }
  } catch (err) {
    if (err instanceof KnowledgeSyncError) die(err.message);
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
}

/** The identity redactor (used with --no-redact). */
function identityRedactor(): Redactor {
  return async (text: string) => ({ text, secretRemains: false });
}

/**
 * Build the production knowledge redactor. Wires `@crewhaus/pii-redactor`'s
 * default PII detectors as the PII pass, then delegates to the importable,
 * unit-tested `buildKnowledgeRedactor` in `./knowledge-sync`, which masks every
 * credential-shaped token (AWS id + secret key, Stripe, `sk-`, GitHub, Slack,
 * JWT, PEM blocks, Bearer) and applies a STRICT "looks like a secret" fallback
 * so anything suspicious surviving redaction is DROPPED, not shared.
 */
async function buildProductionKnowledgeRedactor(): Promise<Redactor> {
  const { createPiiRedactor } = await import("@crewhaus/pii-redactor");
  const { DEFAULT_PII_DETECTORS } = await import("@crewhaus/grader-safety-classifiers");
  const redactor = createPiiRedactor({ regexDetectors: [...DEFAULT_PII_DETECTORS] });
  return buildKnowledgeRedactor(async (text) => (await redactor.redact(text)).text);
}

/**
 * Item 64 — `crewhaus retire <spec>`. A clean, evidenced decommission:
 * refuse an active pin (unless --force), export durable state, record a final
 * compliance-evidence bundle + audit verify, optionally push knowledge out,
 * tombstone the registry entry, then archive + remove — every step logged into
 * the archive. The orchestration + refusal live in `./retire`; this handler
 * reads the registry pins and wires the real heavy steps.
 */
async function runRetire(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus retire <spec> [--archive <dir>] [--dry-run] [--force]\n" +
        "         [--force-unverified] [--push-knowledge] [--shared <dir>] [--root-dir <dir>]\n" +
        "\n" +
        "  Decommission a harness with evidence. Refuses to retire a spec with an\n" +
        "  active deployment pin unless --force. Steps (each logged into the archive):\n" +
        "  export durable state → final compliance-evidence bundle → audit verify →\n" +
        "  [--push-knowledge] → tombstone the registry entry (delete versions, clearing\n" +
        "  every env pin) → archive + remove the live .crewhaus state. A failing\n" +
        "  compliance bundle or a tamper-reporting audit verify ABORTS before the\n" +
        "  destructive move (state left intact) unless --force-unverified. --dry-run\n" +
        "  prints the plan and touches nothing. --archive defaults to\n" +
        "  ./retired-<spec>-<date>.\n",
    );
    return;
  }
  const specArg = args.positional[0];
  if (typeof specArg !== "string") die("missing <spec>");
  const harnessDir = process.cwd();

  // The spec name: the registry name of the cwd spec (best-effort parse), or
  // the argument taken verbatim when it names a registered spec directly.
  let specName = specArg;
  const specPath = resolve(specArg);
  if (existsSync(specPath)) {
    try {
      specName = parseSpec(readFileSync(specPath, "utf-8")).name;
    } catch {
      // keep the argument as the name
    }
  }

  const rootDirFlag = args.flags["root-dir"];
  const registryRoot =
    typeof rootDirFlag === "string" ? rootDirFlag : join(harnessDir, ".crewhaus", "specs");
  const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
  const { registrySpecName } = await import("./spec-changelog");
  const registryName = registrySpecName(specName);
  const registry = createFileBackedRegistry({ rootDir: registryRoot });

  let pins: Record<string, string> = {};
  let registeredVersions: ReadonlyArray<string> = [];
  try {
    const manifest = await registry.manifest(registryName);
    pins = { ...manifest.pins };
    registeredVersions = manifest.versions;
  } catch {
    // unregistered — no pins, nothing to tombstone
  }

  const dryRun = args.flags["dry-run"] === true;
  const force = args.flags["force"] === true;
  const pushKnowledge = args.flags["push-knowledge"] === true;
  const archiveFlag = args.flags["archive"];
  const archiveDir = resolve(
    typeof archiveFlag === "string"
      ? archiveFlag
      : join(harnessDir, `retired-${registryName}-${new Date().toISOString().slice(0, 10)}`),
  );

  let plan: ReturnType<typeof buildRetirementPlan>;
  try {
    plan = buildRetirementPlan({
      specName: registryName,
      harnessDir,
      archiveDir,
      pins,
      force,
      pushKnowledge,
    });
  } catch (err) {
    if (err instanceof RetireError) die(err.message);
    throw err;
  }

  if (dryRun) {
    for (const line of formatPlan(plan)) process.stdout.write(`${line}\n`);
    return;
  }

  // Wire the real heavy steps.
  const steps: RetirementSteps = {
    async backupState(archiveDirIn): Promise<StepOutcome & { tarball?: string }> {
      const stateDir = join(harnessDir, ".crewhaus");
      if (!existsSync(stateDir)) {
        return { step: "backupState", ok: true, detail: "no .crewhaus state to back up" };
      }
      const outFile = join(archiveDirIn, `${registryName}-state.tar.gz`);
      try {
        const result = await createStateBackup({
          stateDir,
          outFile,
          crewhausVersion: cliVersion() ?? "unknown",
        });
        return {
          step: "backupState",
          ok: true,
          detail: `${result.manifest.totals.files} file(s) → ${outFile}`,
          tarball: outFile,
        };
      } catch (err) {
        return { step: "backupState", ok: false, detail: (err as Error).message };
      }
    },
    async complianceEvidence(archiveDirIn): Promise<StepOutcome> {
      const auditDir = join(harnessDir, ".crewhaus", "audit");
      if (!existsSync(auditDir)) {
        return {
          step: "complianceEvidence",
          ok: true,
          detail: "no audit store — no evidence to collect",
        };
      }
      try {
        const { createComplianceCollector } = await import("@crewhaus/compliance-controls");
        const auditLog = await import("@crewhaus/audit-log");
        const outDir = join(archiveDirIn, "compliance");
        const auditSource = {
          async *read() {
            const log = await auditLog.openAuditLog({ rootDir: auditDir });
            for await (const r of log.read()) yield r;
          },
        };
        const collector = createComplianceCollector({ auditSource, outputDir: outDir });
        const period = resolvePeriodFlag("current");
        const frameworks = [...new Set(collector.listControls().map((c) => c.frameworkId))];
        let written = 0;
        for (const fw of frameworks) {
          for (const b of await collector.collectAll(fw, { period })) {
            collector.writeBundle(b);
            written += 1;
          }
        }
        return { step: "complianceEvidence", ok: true, detail: `${written} bundle(s) → ${outDir}` };
      } catch (err) {
        return { step: "complianceEvidence", ok: false, detail: (err as Error).message };
      }
    },
    async auditVerify(): Promise<StepOutcome> {
      const auditDir = join(harnessDir, ".crewhaus", "audit");
      if (!existsSync(auditDir)) {
        return { step: "auditVerify", ok: true, detail: "no audit store to verify" };
      }
      try {
        const { verify } = await import("@crewhaus/audit-log");
        const result = await verify(auditDir);
        const summary = summarizeVerifyResult(result, { anchorRequested: false });
        return {
          step: "auditVerify",
          ok: result.ok,
          detail: result.ok
            ? `chain intact (${result.recordsChecked} record(s))`
            : (summary.lines[0] ?? "tamper finding"),
        };
      } catch (err) {
        return { step: "auditVerify", ok: false, detail: (err as Error).message };
      }
    },
    async pushKnowledge(archiveDirIn): Promise<StepOutcome> {
      // Push this harness's knowledge to the shared store (#63), gated by the
      // opt-in marker like a normal sync.
      if (!harnessOptedIn(harnessDir)) {
        return {
          step: "pushKnowledge",
          ok: true,
          detail: "harness not opted into knowledge sharing — skipped",
        };
      }
      try {
        const sharedFlag = args.flags["shared"];
        const sharedDir = resolve(
          typeof sharedFlag === "string"
            ? sharedFlag
            : (process.env["CREWHAUS_SHARED_DIR"] ?? join(harnessDir, "..", SHARED_DIR_DEFAULT)),
        );
        const redact = await buildProductionKnowledgeRedactor();
        const graders = readHarnessGraders(harnessDir);
        const plan2 = await planPush({
          harness: registryName,
          memories: readHarnessMemories(harnessDir),
          ...(graders !== undefined ? { graders } : {}),
          prompts: readHarnessPrompts(harnessDir),
          existingMemoryHashes: new Set(readSharedMemories(sharedDir).map((m) => m.contentHash)),
          existingFragmentHashes: new Set([
            ...readSharedFragments(sharedDir, "grader").map((f) => f.contentHash),
            ...readSharedFragments(sharedDir, "prompt").map((f) => f.contentHash),
          ]),
          redact,
          now: () => new Date(),
        });
        applyPush(sharedDir, plan2, () => new Date());
        // Also drop a copy of the push plan into the archive for the record.
        mkdirSync(archiveDirIn, { recursive: true });
        writeFileSync(
          join(archiveDirIn, "knowledge-pushed.json"),
          `${JSON.stringify({ memories: plan2.memories.length, fragments: plan2.fragments.length, droppedSecrets: plan2.droppedSecrets }, null, 2)}\n`,
        );
        return {
          step: "pushKnowledge",
          ok: true,
          detail: `pushed ${plan2.memories.length} memory(ies), ${plan2.fragments.length} fragment(s) → ${sharedDir}`,
        };
      } catch (err) {
        return { step: "pushKnowledge", ok: false, detail: (err as Error).message };
      }
    },
    async tombstoneRegistry(): Promise<StepOutcome> {
      if (registeredVersions.length === 0) {
        return {
          step: "tombstoneRegistry",
          ok: true,
          detail: "unregistered — nothing to tombstone",
        };
      }
      try {
        // Delete every registered version — spec-registry's delete() clears any
        // pin pointing at a deleted version, so this unpins every env too.
        for (const v of registeredVersions) await registry.delete(registryName, v);
        return {
          step: "tombstoneRegistry",
          ok: true,
          detail: `deleted ${registeredVersions.length} version(s); ${Object.keys(pins).length} pin(s) cleared`,
        };
      } catch (err) {
        return { step: "tombstoneRegistry", ok: false, detail: (err as Error).message };
      }
    },
  };

  let result: Awaited<ReturnType<typeof runRetirement>>;
  try {
    result = await runRetirement({
      plan,
      steps,
      dryRun: false,
      forceUnverified: args.flags["force-unverified"] === true,
    });
  } catch (err) {
    if (err instanceof RetireError) die(err.message);
    throw err;
  }
  for (const line of formatRetirementResult(result)) process.stdout.write(`${line}\n`);
}

/** A one-off y/N prompt on stdin. Empty / anything not starting with y → no. */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => rl.question(question, res));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Build a `ModuleRegistrySource` from the resolved `--registry` ref (a local
 *  dir of manifest JSONs, or an http(s):// index). */
function buildModuleRegistrySource(
  ref: string | undefined,
): import("@crewhaus/module-marketplace-client").ModuleRegistrySource {
  const resolved = resolveMarketplaceRegistryRef(ref, "plugin");
  if (resolved.kind === "http") {
    return createHttpModuleRegistrySource({ id: resolved.baseUrl, baseUrl: resolved.baseUrl });
  }
  return createLocalModuleRegistrySource({
    dir: resolved.dir,
    readdirImpl: (dir) => readdirSync(dir),
    readFileImpl: (path) => readFileSync(path, "utf-8"),
    existsImpl: (path) => existsSync(path),
  });
}

/**
 * Item 60 — `crewhaus plugins {list,search,install,uninstall,publish,outdated}`.
 * Wraps §42 `module-marketplace-client` over §42 `plugin-registry`, closing
 * the CLI surface those packages deferred. Heavy logic (registry-source
 * resolution, outdated compare, formatters, publish plan) is in
 * `./marketplace-cli`; this handler wires the real registry + git/gh driver.
 */
async function runPlugins(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"] || action === "") {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus plugins list [--registry <dir|url>]           list the catalog\n" +
        "  crewhaus plugins search -q <text> [--registry <ref>]   search the catalog\n" +
        "  crewhaus plugins install <name> [--version <v>]        fetch + register a plugin\n" +
        "       [--allow-unsigned] [--plugins-dir <dir>]\n" +
        "  crewhaus plugins uninstall <name>                      unregister a plugin\n" +
        "  crewhaus plugins outdated [--registry <ref>]           installed vs latest report\n" +
        "  crewhaus plugins publish --manifest <plugin.json>      open a publish PR (item 60)\n" +
        "       [--registry <ref>] [--dry-run]\n" +
        "\n" +
        "  The registry backend is a directory of manifest JSONs (or file:<dir>) or an\n" +
        "  http(s):// index; falls back to CREWHAUS_PLUGIN_REGISTRY, then the default\n" +
        "  public registry (registry.crewhaus.ai/plugins). Install respects plugin-\n" +
        "  registry's fail-closed signature verification; --allow-unsigned opts out for\n" +
        "  local development.\n",
    );
    return;
  }

  const pluginsDirFlag = args.flags["plugins-dir"];
  const pluginsDir = typeof pluginsDirFlag === "string" ? pluginsDirFlag : defaultPluginsDir();
  const registryFileFlag = args.flags["registry-file"];
  const registryPath =
    typeof registryFileFlag === "string" ? registryFileFlag : defaultPluginRegistryPath();
  const allowUnsigned = args.flags["allow-unsigned"] === true;
  // Item 10 (G89) — registry resolution: --registry > CREWHAUS_PLUGIN_REGISTRY >
  // the default public registry (registry.crewhaus.ai/plugins), so `plugins
  // list`/`search` work out of the box with no configuration.
  const registryRef =
    typeof args.flags["registry"] === "string"
      ? args.flags["registry"]
      : (process.env["CREWHAUS_PLUGIN_REGISTRY"] ?? DEFAULT_MODULE_REGISTRY_URL);

  const { createPluginRegistry } = await import("@crewhaus/plugin-registry");
  const pluginRegistry = createPluginRegistry({ registryPath, allowUnsigned });

  try {
    if (action === "list" || action === "search") {
      const source = buildModuleRegistrySource(registryRef);
      const { createMarketplaceClient } = await import("@crewhaus/module-marketplace-client");
      const client = createMarketplaceClient({ registry: source, pluginRegistry, pluginsDir });
      const queryFlag = args.flags["query"];
      const results = await client.search(
        action === "search" && typeof queryFlag === "string" ? { query: queryFlag } : {},
      );
      for (const line of formatPluginList(results)) process.stdout.write(`${line}\n`);
      return;
    }
    if (action === "install") {
      const name = args.positional[0];
      if (typeof name !== "string") die("missing <name>");
      const source = buildModuleRegistrySource(registryRef);
      const { createMarketplaceClient } = await import("@crewhaus/module-marketplace-client");
      const client = createMarketplaceClient({ registry: source, pluginRegistry, pluginsDir });
      const versionFlag = args.flags["version"];
      const result = await client.install(
        name,
        typeof versionFlag === "string" ? versionFlag : undefined,
      );
      process.stdout.write(
        `installed ${result.manifest.name}@${result.manifest.version} → ${result.manifestPath}\n`,
      );
      return;
    }
    if (action === "uninstall") {
      const name = args.positional[0];
      if (typeof name !== "string") die("missing <name>");
      const source = buildModuleRegistrySource(registryRef);
      const { createMarketplaceClient } = await import("@crewhaus/module-marketplace-client");
      const client = createMarketplaceClient({ registry: source, pluginRegistry, pluginsDir });
      await client.uninstall(name);
      process.stdout.write(`uninstalled ${name} (on-disk source left in place)\n`);
      return;
    }
    if (action === "outdated") {
      const installed = installedVersions(await pluginRegistry.list());
      if (installed.length === 0) {
        process.stdout.write("no plugins installed\n");
        return;
      }
      const source = buildModuleRegistrySource(registryRef);
      const remote = await source.listPlugins();
      const rows: ReadonlyArray<OutdatedRow> = computeOutdated(installed, remote);
      for (const line of formatOutdated(rows)) process.stdout.write(`${line}\n`);
      return;
    }
    if (action === "publish") {
      await runPluginPublish(args, registryRef, { pluginRegistry, pluginsDir });
      return;
    }
    die(
      `unknown plugins action "${action}" (expected: list | search | install | uninstall | outdated | publish)`,
    );
  } catch (err) {
    if (err instanceof MarketplaceCliError) die(err.message);
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
}

/** `plugins publish` — drive the marketplace client's PublishDraft through an
 *  actual `gh` PR (the publish loop the packages left open). */
async function runPluginPublish(
  args: ParsedArgs,
  registryRef: string | undefined,
  ctx: {
    pluginRegistry: Awaited<
      ReturnType<typeof import("@crewhaus/plugin-registry").createPluginRegistry>
    >;
    pluginsDir: string;
  },
): Promise<void> {
  const manifestFlag = args.flags["manifest"];
  if (typeof manifestFlag !== "string") die("missing --manifest <plugin.json>");
  let manifestText: string;
  try {
    manifestText = readFileSync(resolve(manifestFlag), "utf-8");
  } catch (err) {
    die(`could not read manifest ${manifestFlag}: ${(err as Error).message}`);
  }
  const { validatePluginManifest } = await import("@crewhaus/plugin-sdk");
  let manifest: import("@crewhaus/plugin-sdk").PluginManifest;
  try {
    manifest = validatePluginManifest(JSON.parse(manifestText));
  } catch (err) {
    die(`invalid plugin manifest: ${(err as Error).message}`);
  }

  const source = buildModuleRegistrySource(registryRef);
  const { createMarketplaceClient } = await import("@crewhaus/module-marketplace-client");
  const client = createMarketplaceClient({
    registry: source,
    pluginRegistry: ctx.pluginRegistry,
    pluginsDir: ctx.pluginsDir,
  });
  const draft = client.draftPublish(manifest);

  const draftLike: PublishDraftLike = {
    prTitle: draft.prTitle,
    prBody: draft.prBody,
    manifestRelPath: `plugins/${draft.name}.json`,
    manifestContents: `${draft.canonicalManifest}\n`,
    name: draft.name,
    version: draft.version,
  };
  const plan = buildPublishPrPlan(draftLike, new Date());

  if (args.flags["dry-run"] === true) {
    process.stdout.write(`[publish] ${draft.name}@${draft.version} — dry run (no git/gh)\n`);
    process.stdout.write(`  branch: ${plan.branch}\n`);
    process.stdout.write(`  title:  ${plan.title}\n`);
    process.stdout.write(`  files:  ${Object.keys(plan.files).join(", ")}\n`);
    return;
  }

  const driver = createPublishPrDriver();
  const opened = await driver(plan);
  process.stdout.write(
    `[publish] opened PR${opened.prNumber !== undefined ? ` #${opened.prNumber}` : ""}: ${opened.url}\n`,
  );
}

/** The production git/gh publish driver — branch → write manifest → commit →
 *  push → `gh pr create` (argv arrays, no shell). NEVER auto-merges. */
function createPublishPrDriver(): PublishPrDriver {
  return async (plan: PublishPrPlan) => {
    const run = (bin: string, argv: ReadonlyArray<string>): string => {
      const proc = spawnSync(bin, [...argv], { encoding: "utf-8" });
      if (proc.status !== 0) {
        throw new MarketplaceCliError(
          `\`${bin} ${argv.join(" ")}\` failed (exit ${proc.status ?? "signal"}): ${(proc.stderr ?? "").toString().trim()}`,
        );
      }
      return (proc.stdout ?? "").toString();
    };
    const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf-8" });
    if (inside.status !== 0 || inside.stdout?.trim() !== "true") {
      throw new MarketplaceCliError(
        "not inside a git repository — `crewhaus plugins publish` opens a PR against the registry repo (run it from the checkout, or use --dry-run)",
      );
    }
    run("git", ["checkout", "-b", plan.branch]);
    for (const [rel, contents] of Object.entries(plan.files)) {
      const abs = resolve(process.cwd(), rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
      run("git", ["add", rel]);
    }
    run("git", ["commit", "-m", plan.commitMessage]);
    run("git", ["push", "-u", "origin", plan.branch]);
    const out = run("gh", [
      "pr",
      "create",
      "--title",
      plan.title,
      "--body",
      plan.body,
      "--head",
      plan.branch,
    ]);
    const url = out.trim().split("\n").pop() ?? "";
    const numMatch = /\/pull\/(\d+)/.exec(url);
    return {
      url,
      branch: plan.branch,
      ...(numMatch ? { prNumber: Number.parseInt(numMatch[1] as string, 10) } : {}),
    };
  };
}

/**
 * E47 — what `templates use` says when the named template is an eval asset.
 * Deliberately does NOT route to `scaffold-evals --template <name>`: that flag
 * resolves the CLI's EMBEDDED families only, so it would answer "unknown
 * --template" for the very name `templates list` just advertised.
 */
const EVAL_TEMPLATE_NO_CONSUMER =
  "`templates use` scaffolds a crewhaus.yaml and cannot install it. Registry-hosted eval assets have no " +
  "consumer verb yet: `scaffold-evals --template` resolves only the families embedded in this CLI " +
  "(rag, summarize, extract, support, safety, classify). To use this one, fetch its graders.yaml and " +
  "dataset from the registry by hand.";

/**
 * Item 60 — `crewhaus templates {list,search,use}`. Wraps §40
 * `template-marketplace-client` over §40 `template-registry`. `use` scaffolds
 * a template's crewhaus.yaml into the workspace (the install verb, named
 * `use` because that's the harness-init idiom).
 */
async function runTemplates(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"] || action === "") {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus templates list [--registry <dir|url>]         list the catalog\n" +
        "  crewhaus templates search -q <text> [--target <t>]     search the catalog\n" +
        "  crewhaus templates use <name> [--into <dir>]           scaffold a template\n" +
        "       [--subdir <dir>] [--registry <ref>]\n" +
        "\n" +
        "  The registry backend is a directory of manifest JSONs (or file:<dir>) or an\n" +
        "  http(s):// index; falls back to CREWHAUS_TEMPLATE_REGISTRY, then the default\n" +
        "  public registry (registry.crewhaus.ai/templates).\n",
    );
    return;
  }
  // Item 10 (G89) — registry resolution: --registry > CREWHAUS_TEMPLATE_REGISTRY
  // > the default public registry (registry.crewhaus.ai/templates), so
  // `templates list`/`search` work out of the box with no configuration.
  const registryRef =
    typeof args.flags["registry"] === "string"
      ? args.flags["registry"]
      : (process.env["CREWHAUS_TEMPLATE_REGISTRY"] ?? DEFAULT_TEMPLATE_REGISTRY_URL);
  const resolved = resolveMarketplaceRegistryRef(registryRef, "template");

  const { LocalRegistrySource, HttpRegistrySource } = await import("@crewhaus/template-registry");
  const source =
    resolved.kind === "http"
      ? new HttpRegistrySource({
          id: "git",
          listUrl: resolved.baseUrl,
          fetchUrl: (name: string) => `${resolved.baseUrl}/${name}.json`,
        })
      : new LocalRegistrySource({ rootDir: resolved.dir });

  const { MarketplaceClient } = await import("@crewhaus/template-marketplace-client");

  try {
    if (action === "list") {
      const client = new MarketplaceClient({
        registry: source,
        workspaceDir: defaultTemplateWorkspaceDir(),
      });
      const list = await client.list();
      if (list.length === 0) {
        process.stdout.write("no templates in the registry\n");
        return;
      }
      for (const t of list) {
        // E47 — a registry may now carry eval-asset templates alongside spec
        // templates; say which is which, since only SPEC templates scaffold
        // with `templates use`. A `grader-template` listed here is signed and
        // verified but has no consumer yet (`scaffold-evals --template`
        // resolves the CLI's embedded families only), so the [eval-template]
        // marker is what stops `use` looking like the missing step.
        const kind = t.kind === "grader-template" ? " [eval-template]" : "";
        process.stdout.write(`${t.name} v${t.version} (${t.target})${kind} — ${t.author}\n`);
        if (t.description) process.stdout.write(`    ${t.description}\n`);
      }
      return;
    }
    if (action === "search") {
      const client = new MarketplaceClient({
        registry: source,
        workspaceDir: defaultTemplateWorkspaceDir(),
      });
      const queryFlag = args.flags["query"];
      const targetFlag = args.flags["target"];
      const results = await client.search({
        ...(typeof queryFlag === "string" ? { query: queryFlag } : {}),
        ...(typeof targetFlag === "string" ? { target: targetFlag } : {}),
      });
      if (results.length === 0) {
        process.stdout.write("no matching templates\n");
        return;
      }
      for (const r of results) {
        process.stdout.write(`${r.metadata.name} v${r.metadata.version} (${r.metadata.target})\n`);
      }
      return;
    }
    if (action === "use") {
      const name = args.positional[0];
      if (typeof name !== "string") die("missing <name>");
      // E47 — `use` scaffolds a crewhaus.yaml. A grader-template's payload is
      // a graders.yaml, so installing one would write an unparseable spec:
      // refuse. Do NOT point at `scaffold-evals --template <name>` — that flag
      // resolves the CLI's EMBEDDED families only and would deny this name
      // exists, sending the user in a circle. Registry-hosted eval assets have
      // no consumer verb yet; say so plainly.
      const meta = await source.metadata(name).catch(() => undefined);
      if (meta?.kind === "grader-template") {
        die(
          `"${name}" is an eval-asset template, not a spec template. ${EVAL_TEMPLATE_NO_CONSUMER}`,
        );
      }
      const intoFlag = args.flags["into"];
      const workspaceDir =
        typeof intoFlag === "string" ? resolve(intoFlag) : defaultTemplateWorkspaceDir();
      const client = new MarketplaceClient({ registry: source, workspaceDir });
      const subdirFlag = args.flags["subdir"];
      const result = await client.install(
        name,
        typeof subdirFlag === "string" ? { subdir: subdirFlag } : {},
      );
      process.stdout.write(`scaffolded ${result.manifest.name} → ${result.path}\n`);
      return;
    }
    die(`unknown templates action "${action}" (expected: list | search | use)`);
  } catch (err) {
    if (err instanceof MarketplaceCliError) die(err.message);
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
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
        "       [--require-approval] [--check-pr] [--actor <id>]      gate a protected env (item 59)\n" +
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

    // Item 59 (F2) — `spec pin` flips a live env pin exactly like `deploy
    // promote`/`rollback`, so a pin into a PROTECTED env must clear the same
    // approval gate. Non-protected envs stay ungated (the pre-item-59 path).
    const harnessRoot = process.cwd();
    const actorFlag = args.flags["actor"];
    const actor = typeof actorFlag === "string" ? actorFlag : undefined;
    const { openAuditLog } = await import("@crewhaus/audit-log");
    const audit = await openAuditLog({ rootDir: join(harnessRoot, ".crewhaus", "audit") });
    try {
      await enforceProtectedEnvGate({
        args,
        harnessRoot,
        name,
        toEnv: env,
        toVersion: version,
        verb: "pin",
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(actor !== undefined ? { actor } : {}),
        auditLog: audit,
      });
    } catch (err) {
      if (err instanceof ApprovalGateError) die(err.message);
      throw err;
    }

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
        "       [--require-approval] [--check-pr]            gate a protected env (item 59)\n" +
        "  crewhaus deploy rollback <name> <env> <version>   re-pin env to version\n" +
        "       [--require-approval] [--check-pr]            gate a protected env (item 59)\n" +
        "\n" +
        "  --require-approval  refuse to flip a PROTECTED env's pin (declared in\n" +
        "                      .crewhaus/environments.json) until an approval quorum\n" +
        "                      is met: recorded approvals in .crewhaus/approvals/ and/or\n" +
        "                      a green proposal PR (--check-pr). The gate decision — met\n" +
        "                      OR refused — is audit-logged (governance_approval).\n" +
        "\n" +
        "  crewhaus deploy canary <spec.yaml> <version>      eval-gated ramp (item 29)\n" +
        "    --traffic 5,25,50,100    strictly-increasing ramp steps (default 5,25,50,100)\n" +
        "    --dataset <data>         eval dataset: a file path or registry:<name>[@ver][#split]\n" +
        "                             (bare refs = train+dev; an explicit #test needs --allow-test-split)\n" +
        "    --graders <graders.yaml> grader config\n" +
        "    --from <version>         baseline version (default: the env's current pin)\n" +
        "    --env <env>              env pin to promote/rollback (default: prod)\n" +
        "    --name <name>            registry spec name (default: the spec's own name)\n" +
        "    --concurrency N --seed N --judge-model <m>   eval knobs (as `crewhaus eval`)\n" +
        "    --allow-test-split       consume an explicit #test dataset ref — canary gates a\n" +
        "                             release, so the held-out split is spendable here (the\n" +
        "                             same opt-in as `crewhaus eval`)\n" +
        "    --max-pass-rate-drop <f> gate: max pass-rate drop before fail (default 0.05)\n" +
        "    --max-p95-latency-ms <n> gate: max p95 latency rise ms before fail (default 5000)\n" +
        "    --traffic-split          ALSO write a deterministic per-request variant assignment\n" +
        "                             (after each PASSING step; retired when the ramp ends)\n" +
        "                             and record the ramp's per-version eval samples into the\n" +
        "                             experiment ledger (read it with `crewhaus experiment\n" +
        "                             status`). Read the E50 BOUNDARY below before assuming\n" +
        "                             this splits live traffic — it does not.\n" +
        "    --experiment <name>      experiment/ledger name (default: the spec name)\n" +
        "    --experiment-dir <dir>   ledger root (default .crewhaus/experiments)\n" +
        "\n" +
        "  `deploy canary` registers the candidate spec version, then drives the ramp\n" +
        "  steps: at each step it evals BOTH the baseline and candidate versions against\n" +
        "  the dataset+graders and feeds the two results into the real regression-runner\n" +
        "  gate (pass-rate + p95-latency). On pass at every step the env pin auto-promotes\n" +
        "  to the candidate; on the first failing step it auto-rolls-back to the baseline\n" +
        "  and stops. Every promote/rollback is audit-logged (deployment_action).\n" +
        "\n" +
        "  TRAFFIC-SPLIT CAVEAT (v1): `crewhaus eval` runs target: cli, and the canary\n" +
        "  controller's route() has no serving-path consumer, so the ramp % gates eval\n" +
        "  SAMPLING/PROMOTION, not a live production traffic split. Each step evals the\n" +
        "  FULL dataset against both versions; the percentages sequence the confidence\n" +
        "  ramp. A real request-level split matters only for gateway/managed shapes with\n" +
        "  a serving-path route() consumer — out of scope for target: cli here.\n" +
        "\n" +
        "  E50 BOUNDARY (--traffic-split): the flag ships the honest SUBSET of an online\n" +
        "  experiment, not live request splitting. It writes\n" +
        "  .crewhaus/experiments/<name>.assignment.json — a deterministic map from any\n" +
        "  stable request key to exactly one version (sha256 bucket, same hash route()\n" +
        "  uses, sticky across processes) — and records the ramp's per-version EVAL\n" +
        "  samples into .crewhaus/experiments/<name>.jsonl. NOTHING in CrewHaus's serving\n" +
        "  surfaces reads that assignment: routing real requests through it is an explicit\n" +
        "  integration at your own serving boundary, for which `crewhaus experiment assign`\n" +
        "  (or canary-controller's selectExperimentVariant) is the decision function and\n" +
        "  `crewhaus experiment record` is how outcomes come back. `crewhaus experiment\n" +
        "  status` then reports per-version deltas with Wilson 95% intervals and refuses\n" +
        "  to name a winner below a minimum sample size per version.\n" +
        "\n" +
        "  THE FLAG'S NAME is deliberate, not an accident: it is named for the capability\n" +
        "  it PREPARES (a traffic split you can serve), not one it performs. Nothing here\n" +
        "  moves a live request. If you copy `--traffic-split` into a Makefile or CI job,\n" +
        "  copy this paragraph with it.\n" +
        "\n" +
        "  ASSIGNMENT LIFECYCLE: the split file is written only AFTER a step's gate\n" +
        "  passes, and is REMOVED when the ramp concludes — promotion pins 100% candidate,\n" +
        "  rollback pins 100% baseline, and a surviving 50/50 file would keep a compliant\n" +
        "  integration routing half its keys at a version nobody is running. The ledger\n" +
        "  gets ONE batch per version (the ramp's final measurement of each), because a\n" +
        "  4-step ramp re-measures the SAME dataset samples 4× and repeat measurements\n" +
        "  are not independent observations.\n",
    );
    return;
  }
  if (action === "canary") {
    await runDeployCanary(args);
    return;
  }
  const rootDirFlag = args.flags["root-dir"];
  const rootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "specs");
  // The harness root that owns `.crewhaus/environments.json` + `.crewhaus/approvals`.
  // When --root-dir points AT a `.crewhaus/specs`, the harness root is two up;
  // otherwise it's the cwd (the standalone-harness convention).
  const harnessRoot = process.cwd();
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

    // Item 59 — the approval gate. A protected env (declared in
    // environments.json OR flagged via --require-approval) must clear a
    // recorded-approval / green-PR quorum BEFORE the pin flips. The gate runs
    // here, ahead of the controller, so the controller stays a dumb pin-flipper.
    try {
      await enforceApprovalGate({
        args,
        harnessRoot,
        name,
        fromEnv,
        toEnv,
        registry: reg,
        tenantId,
        actor,
        auditLog: audit,
      });
    } catch (err) {
      if (err instanceof ApprovalGateError) die(err.message);
      throw err;
    }

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

    // Item 59 (F2) — a rollback to a PROTECTED env flips a live pin just like a
    // promote, so it must clear the same approval gate. The explicit target
    // version is what the pin will point at.
    try {
      await enforceProtectedEnvGate({
        args,
        harnessRoot,
        name,
        toEnv: env,
        toVersion: version,
        verb: "rollback",
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(actor !== undefined ? { actor } : {}),
        auditLog: audit,
      });
    } catch (err) {
      if (err instanceof ApprovalGateError) die(err.message);
      throw err;
    }

    const rec = await ctrl.rollback(name, env, version);
    process.stdout.write(
      `rolled back ${name} ${env} → ${version} (was ${rec.fromVersion ?? "unset"})\n`,
    );
    return;
  }
  die(`unknown deploy action "${action}" (expected: promote | rollback | canary)`);
}

/**
 * Item 29 — `crewhaus deploy canary <spec.yaml> <version> ...`. Registers the
 * candidate spec version, then drives the declared traffic ramp: at each step
 * it evals BOTH the baseline and candidate versions against the same
 * dataset+graders and feeds the two `EvalRunSummary` results into the real
 * `regression-runner.gate()` (via canary-controller's injected
 * `RegressionGate`), auto-promoting the env pin on pass and auto-rolling-back
 * on the first fail — all audit-logged. The eval/registry/audit I/O is wired
 * here; the ramp logic + gate live in the side-effect-free `deploy-canary.ts`.
 *
 * See the TRAFFIC-SPLIT CAVEAT in `--help`: for target: cli the ramp % gates
 * eval sampling/promotion, not a live request-level split.
 */
async function runDeployCanary(args: ParsedArgs): Promise<void> {
  const specPath = args.positional[0];
  const candidateVersion = args.positional[1];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  if (typeof candidateVersion !== "string") die("missing <version>");
  const datasetPath = args.flags["dataset"];
  const gradersPath = args.flags["graders"];
  if (typeof datasetPath !== "string") die("missing --dataset <data>");
  if (typeof gradersPath !== "string") die("missing --graders <graders.yaml>");

  // Ramp steps (default 5,25,50,100).
  let steps: number[];
  try {
    steps = parseTrafficSteps(
      typeof args.flags["traffic"] === "string" ? args.flags["traffic"] : "5,25,50,100",
    );
  } catch (err) {
    if (err instanceof CanaryRampError) die(err.message);
    throw err;
  }

  // Eval knobs, mirroring `crewhaus eval`.
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

  // Gate threshold overrides (regression-runner GateThresholds).
  const gateThresholds: { regressionThreshold?: number; latencyThreshold?: number } = {};
  const dropFlag = args.flags["max-pass-rate-drop"];
  const latFlag = args.flags["max-p95-latency-ms"];
  if (typeof dropFlag === "string") {
    const v = Number(dropFlag);
    if (!Number.isFinite(v) || v < 0) die(`invalid --max-pass-rate-drop "${dropFlag}"`);
    gateThresholds.regressionThreshold = v;
  }
  if (typeof latFlag === "string") {
    const v = Number(latFlag);
    if (!Number.isFinite(v) || v < 0) die(`invalid --max-p95-latency-ms "${latFlag}"`);
    gateThresholds.latencyThreshold = v;
  }

  // Read + validate the candidate spec (must be target: cli for eval).
  const absSpec = resolve(specPath);
  let candidateYaml: string;
  try {
    candidateYaml = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }
  let candidateIr: ReturnType<typeof lower>;
  try {
    candidateIr = lower(parseSpec(candidateYaml));
  } catch (err) {
    if (err instanceof SpecParseError) die(err.message);
    throw err;
  }
  if (candidateIr.target !== "cli") {
    die(`crewhaus deploy canary only supports target: cli (got "${candidateIr.target}")`);
  }

  const specName = typeof args.flags["name"] === "string" ? args.flags["name"] : candidateIr.name;
  const env = typeof args.flags["env"] === "string" ? args.flags["env"] : "prod";

  const rootDirFlag = args.flags["root-dir"];
  const specRootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "specs");
  const auditDir = join(process.cwd(), ".crewhaus", "audit");
  const { createFileBackedRegistry: createSpecRegistry } = await import("@crewhaus/spec-registry");
  const { openAuditLog } = await import("@crewhaus/audit-log");
  const { createDeploymentController } = await import("@crewhaus/deployment-controller");
  const { createCanaryController, makeRegressionGate } = await import(
    "@crewhaus/canary-controller"
  );
  const specReg = createSpecRegistry({ rootDir: specRootDir });

  // Register the candidate version (idempotent overwrite of the same bytes).
  await specReg.put(specName, candidateVersion, candidateYaml);

  // Resolve the baseline version: --from, or the env's current pin.
  const tenantFlag = args.flags["tenant"];
  const tenantId = typeof tenantFlag === "string" ? tenantFlag : undefined;
  const fromFlag = args.flags["from"];
  let baselineVersion: string | undefined;
  if (typeof fromFlag === "string") {
    baselineVersion = fromFlag;
  } else {
    baselineVersion =
      tenantId !== undefined
        ? await specReg.aliasForTenant(tenantId, specName, env)
        : await specReg.aliasFor(specName, env);
  }
  if (baselineVersion === undefined) {
    die(
      `no baseline version for ${specName} ${env} — pin one first (crewhaus deploy promote / spec pin) or pass --from <version>`,
    );
  }
  if (baselineVersion === candidateVersion) {
    die(`baseline and candidate are the same version (${candidateVersion}) — nothing to canary`);
  }

  // Resolve dataset + graders ONCE, shared across every eval.
  const gradersYaml = readFileSync(resolve(gradersPath), "utf-8");
  const { compiled } = parseGradersConfig(gradersYaml);
  let sharedSamples: Sample[];
  let datasetName: string;
  let datasetHash: string;
  let registryRef: ReturnType<typeof parseRegistryRef>;
  try {
    registryRef = parseRegistryRef(datasetPath);
  } catch (err) {
    if (err instanceof DatasetRefError) die(err.message);
    throw err;
  }
  if (registryRef !== undefined) {
    const dsReg = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
    let resolved: Awaited<ReturnType<typeof resolveRegistryRef>>;
    try {
      // B16 — canary IS release gating, so an explicit #test is consumable
      // here behind the same --allow-test-split opt-in as `crewhaus eval`;
      // bare refs still resolve train+dev only (with the exclusion notice).
      resolved = await resolveRegistryRef(dsReg, registryRef, {
        allowTestSplit: args.flags["allow-test-split"] === true,
      });
    } catch (err) {
      if (err instanceof DatasetRefError || err instanceof CrewhausError) die(err.message);
      throw err;
    }
    if (resolved.samples.length === 0)
      die(`dataset "${resolved.datasetName}" yielded zero samples`);
    sharedSamples = resolved.samples;
    datasetName = resolved.datasetName;
    datasetHash = resolved.datasetHash;
  } else {
    const absDataset = resolve(datasetPath);
    const loaded = await loadDataset(absDataset);
    sharedSamples = await collectSamples(loaded.samples);
    if (sharedSamples.length === 0) die(`dataset "${loaded.name}" yielded zero samples`);
    datasetName = loaded.name;
    datasetHash = hashDatasetFile(absDataset);
  }

  // E50 — `--traffic-split`. See the boundary note in `deploy --help`: this
  // does NOT split live requests. The recorder ships the reachable subset (a
  // durable deterministic variant assignment + per-version outcome accounting)
  // and lives in deploy-canary.ts with its writers injected, so it is testable.
  const trafficSplit = args.flags["traffic-split"] === true;
  const experimentName =
    typeof args.flags["experiment"] === "string" ? args.flags["experiment"] : specName;
  const experimentDirFlag = args.flags["experiment-dir"];
  const splitRecorder = trafficSplit
    ? await (async () => {
        const api = await import("@crewhaus/canary-controller");
        return makeTrafficSplitRecorder({
          experiment: experimentName,
          dir:
            typeof experimentDirFlag === "string"
              ? experimentDirFlag
              : join(process.cwd(), ".crewhaus", "experiments"),
          baselineVersion: baselineVersion as string,
          candidateVersion,
          env,
          ...(tenantId !== undefined ? { salt: tenantId } : {}),
          append: api.appendExperimentOutcomes,
          writeAssignment: api.writeExperimentAssignment,
          removeAssignment: api.removeExperimentAssignment,
          write: (line: string) => process.stdout.write(`${line}\n`),
        });
      })()
    : undefined;

  // Per-version eval closure: read the stored spec version, lower it, and run
  // a full eval against the shared samples + graders. Reused for both the
  // baseline and candidate at every ramp step.
  const evalVersion = async (version: string): Promise<EvalRunSummary> => {
    const yaml = await specReg.get(specName, version);
    const ir = lower(parseSpec(yaml));
    if (ir.target !== "cli") {
      throw new CrewhausError(
        "config",
        `stored version ${specName}@${version} is target: ${ir.target}, not cli`,
      );
    }
    return runEvalLib({
      ir,
      dataset: { name: datasetName, samples: makeAsyncIterable(sharedSamples) },
      compiledGraders: compiled,
      opts: {
        // C33 — which CLI produced this run (reproducibility manifest).
        ...cliVersionOpt(),
        datasetHash,
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
      },
    });
  };

  const audit = await openAuditLog({ rootDir: auditDir });
  const deploymentController = createDeploymentController({
    registry: specReg,
    auditLog: audit,
    ...(tenantId !== undefined ? { tenantId } : {}),
  });
  const canary = createCanaryController({
    registry: specReg,
    deploymentController,
    auditLog: audit,
  });

  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  write(
    `[canary] ${specName}: baseline ${baselineVersion} → candidate ${candidateVersion} (env ${env})`,
  );
  write(
    `[canary] ramp ${steps.join(",")}% · dataset ${datasetName} (${sharedSamples.length} samples)`,
  );

  // E50 — per-version outcome accounting. Wrapping `evalVersion` (rather than
  // changing `makeCanaryEvalGate`) keeps the ramp module untouched: every
  // sample this version was graded on becomes one ledger observation
  // attributed to that version, which is what `experiment status` then folds.
  const evalVersionAccounted =
    splitRecorder !== undefined
      ? async (version: string): Promise<EvalRunSummary> => {
          const summary = await evalVersion(version);
          splitRecorder.recordVersionRun(version, summary);
          return summary;
        }
      : evalVersion;

  const gate = makeRegressionGate(
    makeCanaryEvalGate({ evalVersion: evalVersionAccounted, thresholds: gateThresholds, write }),
  );

  if (trafficSplit) {
    write(
      "[canary] --traffic-split: writing the deterministic variant assignment + recording " +
        "per-version eval outcomes.",
    );
    write(
      "[canary]   BOUNDARY: this does NOT split live requests. No CrewHaus serving surface " +
        "consults the assignment, and `target: cli` has no live request stream — `crewhaus " +
        "experiment assign` is the decision function your serving boundary calls.",
    );
  }

  const result = await driveCanaryRamp({
    steps,
    write,
    // The ramp itself orders the assignment write against each step's gate
    // and runs the terminal flush/retire on both exits (see driveCanaryRamp).
    ...(splitRecorder !== undefined ? { recorder: splitRecorder } : {}),
    evaluateStep: (trafficPercent) => {
      return canary.evaluate(
        {
          name: specName,
          fromVersion: baselineVersion as string,
          toVersion: candidateVersion,
          trafficPercent,
          env,
          ...(tenantId !== undefined ? { tenantId } : {}),
        },
        { intervalMs: 0, gate },
      );
    },
  });

  if (result.promoted) {
    write(`[canary] PROMOTED ${specName} ${env} → ${candidateVersion}`);
    if (trafficSplit)
      write(`[canary] experiment ledger: crewhaus experiment status --name ${experimentName}`);
    return;
  }
  die(
    `deploy canary: ${specName} regressed at ${result.failedAt}% — rolled back to ${baselineVersion} (env ${env})`,
  );
}

/**
 * Item 59 (F2) — the single approval choke point for ANY pin flip into a
 * protected environment. `deploy promote`, `deploy rollback`, and `spec pin`
 * all route through this before the pin moves. Determines whether `toEnv` is
 * protected (config OR `--require-approval`), and if so requires the recorded
 * approvals + optional green-PR quorum for the exact `toVersion` being pinned.
 * The decision — satisfied OR refused — is audit-logged as `governance_approval`
 * (so even a blocked scheduled flip is evidenced); a refusal throws
 * ApprovalGateError. An unprotected env is a no-op.
 *
 * `verb` only shapes the human-facing messages ("promotion"/"rollback"/"pin").
 */
async function enforceProtectedEnvGate(opts: {
  args: ParsedArgs;
  harnessRoot: string;
  name: string;
  toEnv: string;
  toVersion: string;
  verb: "promotion" | "rollback" | "pin";
  tenantId?: string;
  actor?: string;
  auditLog: AuditLog;
}): Promise<void> {
  const requireFlag = opts.args.flags["require-approval"] === true;
  const config = loadEnvironmentsConfig(opts.harnessRoot);
  const policy = policyForEnv(config, opts.toEnv);
  const protectedEnv = policy.requireApproval || requireFlag;
  if (!protectedEnv) return; // unprotected — the pre-item-59 path

  const approvals = readApprovals(opts.harnessRoot, opts.name, opts.toEnv);

  let prCheck: Awaited<ReturnType<PrCheckReader>> | undefined;
  if (opts.args.flags["check-pr"] === true) {
    prCheck = readPrCheckViaGh({ specName: opts.name, env: opts.toEnv, version: opts.toVersion });
  }

  const decisionInput: ApprovalDecisionInput = {
    specName: opts.name,
    toEnv: opts.toEnv,
    toVersion: opts.toVersion,
    policy,
    approvals,
    ...(prCheck !== undefined ? { prCheck } : {}),
  };
  const decision = decideApproval(decisionInput);

  // Record the gate evaluation (met OR refused) in the same audit chain the
  // flip lands in, so a blocked scheduled change is evidenced too.
  await opts.auditLog.append({
    kind: "governance_approval",
    payload: buildGovernancePayload(decisionInput, decision, {
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      now: () => Date.now(),
    }),
  });

  process.stdout.write(
    `[approval] ${opts.name} → ${opts.toEnv}@${opts.toVersion}: ${decision.reason}\n`,
  );
  if (!decision.satisfied) {
    throw new ApprovalGateError(
      `${opts.verb} of ${opts.name} to protected env "${opts.toEnv}" is blocked — ${decision.reason}`,
    );
  }
}

/**
 * Item 59 — the approval gate for `deploy promote`. Resolves the candidate
 * version promote would copy (the fromEnv pin) and routes it through the shared
 * {@link enforceProtectedEnvGate}. An unprotected env / missing fromEnv pin is
 * a no-op (the controller produces its own "nothing to copy" error).
 */
async function enforceApprovalGate(opts: {
  args: ParsedArgs;
  harnessRoot: string;
  name: string;
  fromEnv: string;
  toEnv: string;
  registry: RegistryAdapter;
  tenantId?: string;
  actor?: string;
  auditLog: AuditLog;
}): Promise<void> {
  // The candidate version is exactly what promote would copy: the fromEnv pin.
  const toVersion =
    opts.tenantId !== undefined
      ? await opts.registry.aliasForTenant(opts.tenantId, opts.name, opts.fromEnv)
      : await opts.registry.aliasFor(opts.name, opts.fromEnv);
  if (!toVersion) {
    // Let the controller produce its own "no pin to copy from" error — but only
    // when the env is unprotected. A protected env with no source pin must not
    // silently sail through the gate: fall through so the gate still evaluates
    // (it will refuse for lack of witnesses) unless the env is unprotected.
    const config = loadEnvironmentsConfig(opts.harnessRoot);
    const policy = policyForEnv(config, opts.toEnv);
    if (!(policy.requireApproval || opts.args.flags["require-approval"] === true)) return;
    // Protected but nothing to copy: defer to the controller's clearer error.
    return;
  }
  await enforceProtectedEnvGate({
    args: opts.args,
    harnessRoot: opts.harnessRoot,
    name: opts.name,
    toEnv: opts.toEnv,
    toVersion,
    verb: "promotion",
    ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    auditLog: opts.auditLog,
  });
}

/** Read a proposal PR's rollup check state via `gh` (the "clients never speak
 *  git" precedent — shell out to gh, not a git library; argv array, no shell).
 *  Any gh failure / absence resolves to `conclusion: "none"` (no witness),
 *  never a throw: a missing gh must not crash a promotion, only withhold the
 *  PR witness. `GITHUB_TOKEN`/`GH_TOKEN` in the environment authenticates gh. */
function readPrCheckViaGh(query: {
  specName: string;
  env: string;
  version: string;
}): Awaited<ReturnType<PrCheckReader>> {
  try {
    const list = spawnSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--search",
        `head:propose/${query.specName}`,
        "--json",
        "number,url,headRefName,title,body,statusCheckRollup",
        "--limit",
        "20",
      ],
      { encoding: "utf-8" },
    );
    if (list.status !== 0 || typeof list.stdout !== "string") return { conclusion: "none" };
    const parsed = JSON.parse(list.stdout) as Array<{
      number: number;
      url: string;
      headRefName?: string;
      title?: string;
      body?: string;
      statusCheckRollup?: Array<{ conclusion?: string; state?: string }>;
    }>;
    // F3(b): bind the witness to the EXACT version. `propose` names the branch
    // `propose/<slug>-<version>-<hash>-<stamp>`, so the version is a bounded
    // segment of the head ref; also accept a version reference in the title/
    // body. A green PR for a DIFFERENT version must NOT witness this promotion.
    const pr = parsed.find((p) => prReferencesVersion(p, query.version));
    if (pr === undefined) return { conclusion: "none" };
    // F3(a): fail-closed rollup — only an all-SUCCESS (>=1 check) rollup wins.
    return {
      conclusion: rollupConclusion(pr.statusCheckRollup ?? []),
      prNumber: pr.number,
      url: pr.url,
    };
  } catch {
    return { conclusion: "none" };
  }
}

/**
 * Item 59 — `crewhaus propose <proposed-spec.yaml>`. Package a spec change
 * into a review artifact (patch.json + changelog + eval delta + provenance)
 * and open a GitHub PR against the spec's repo. NEVER auto-merges — the PR is
 * the human gate. Assembly is pure (./propose); this handler wires the real
 * spec reads + the git/gh driver + the audit record.
 */
async function runPropose(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus propose <proposed-spec.yaml> [--current <spec.yaml>]\n" +
        "         [--source optimize|advise|model-scan|manual] [--run-id <id>]\n" +
        "         [--as-version <v>] [--score-before <n>] [--score-after <n>]\n" +
        "         [--dataset <name>] [--optimize-dir <dir>] [--spec-path <rel>]\n" +
        "         [--dry-run]\n" +
        "\n" +
        "  Package a proposed spec change into a review bundle (patch.json field\n" +
        "  diff + changelog entry + eval delta + provenance) and open a PR on a\n" +
        "  fresh propose/<id> branch. The live spec is NOT modified; merging the\n" +
        "  PR is the human gate (there is no auto-merge). GITHUB_TOKEN/GH_TOKEN\n" +
        "  authenticates gh. --dry-run assembles + prints the plan, touching no\n" +
        "  git/gh.\n",
    );
    return;
  }
  const proposedPathArg = args.positional[0];
  if (typeof proposedPathArg !== "string") die("missing <proposed-spec.yaml>");
  const proposedPath = resolve(proposedPathArg);
  const currentArg = args.flags["current"];
  const currentPath = resolve(
    typeof currentArg === "string" ? currentArg : join(process.cwd(), "crewhaus.yaml"),
  );

  let proposedYaml: string;
  let currentYaml: string;
  try {
    proposedYaml = readFileSync(proposedPath, "utf-8");
  } catch (err) {
    die(`could not read proposed spec ${proposedPath}: ${(err as Error).message}`);
  }
  try {
    currentYaml = readFileSync(currentPath, "utf-8");
  } catch (err) {
    die(`could not read current spec ${currentPath}: ${(err as Error).message}`);
  }

  // The spec name comes from the current spec (best-effort — a proposal for an
  // unparseable spec still assembles a diff). Fall back to the proposed spec.
  let specName: string;
  try {
    specName = parseSpec(currentYaml).name;
  } catch {
    try {
      specName = parseSpec(proposedYaml).name;
    } catch {
      die("could not determine the spec name — neither the current nor proposed spec parses");
    }
  }

  const sourceFlag = args.flags["source"];
  const validSources: ReadonlyArray<ProposeSource> = ["optimize", "advise", "model-scan", "manual"];
  const source: ProposeSource =
    typeof sourceFlag === "string" && (validSources as ReadonlyArray<string>).includes(sourceFlag)
      ? (sourceFlag as ProposeSource)
      : "manual";
  const runIdFlag = args.flags["run-id"];
  const runId = typeof runIdFlag === "string" ? runIdFlag : undefined;
  const asVersionFlag = args.flags["as-version"];
  const proposedVersion = typeof asVersionFlag === "string" ? asVersionFlag : "proposed";
  const specPathFlag = args.flags["spec-path"];
  const specRelPath = typeof specPathFlag === "string" ? specPathFlag : "crewhaus.yaml";
  const optimizeDirFlag = args.flags["optimize-dir"];
  const optimizeRootDir = typeof optimizeDirFlag === "string" ? optimizeDirFlag : undefined;

  const scoreBefore = floatFlag(args, "score-before");
  const scoreAfter = floatFlag(args, "score-after");
  const datasetFlag = args.flags["dataset"];
  const evalDelta =
    scoreBefore !== undefined && scoreAfter !== undefined
      ? {
          scoreBefore,
          scoreAfter,
          ...(typeof datasetFlag === "string" ? { datasetName: datasetFlag } : {}),
        }
      : undefined;

  let assembled: ReturnType<typeof assembleProposal>;
  try {
    assembled = assembleProposal({
      specName,
      currentYaml,
      proposedYaml,
      source,
      ...(runId !== undefined ? { runId } : {}),
      ...(evalDelta !== undefined ? { evalDelta } : {}),
      ...(optimizeRootDir !== undefined ? { optimizeRootDir } : {}),
      proposedVersion,
    });
  } catch (err) {
    if (err instanceof ProposeError) die(err.message);
    throw err;
  }

  const { plan, proposalId: id } = buildProposalPrPlan({
    assembled,
    proposedYaml,
    specRelPath,
    proposedVersion,
  });

  if (args.flags["dry-run"] === true) {
    process.stdout.write(`[propose] ${id} — dry run (no git/gh)\n`);
    process.stdout.write(`  branch: ${plan.branch}\n`);
    process.stdout.write(`  title:  ${plan.title}\n`);
    process.stdout.write(`  files:  ${Object.keys(plan.files).join(", ")}\n`);
    process.stdout.write(`  diff:   ${assembled.patch.diff.length} structural change(s)\n`);
    process.stdout.write("\n");
    process.stdout.write(assembled.prBody);
    return;
  }

  const driver = createGitPrDriver();
  let opened: OpenedPr;
  try {
    opened = await driver(plan);
  } catch (err) {
    if (err instanceof ProposeError) die(err.message);
    throw err;
  }

  // Audit the proposal's provenance (source, patch hash, PR ref) so it is
  // evidenced before any human acts on it.
  try {
    const auditLog = await import("@crewhaus/audit-log");
    const log = await auditLog.openAuditLog({ rootDir: join(process.cwd(), ".crewhaus", "audit") });
    await log.append({
      kind: "governance_proposal",
      payload: buildProposalAuditPayload(assembled, opened, proposedVersion, () => Date.now()),
    });
  } catch (err) {
    process.stderr.write(
      `crewhaus: warning: could not audit-log the proposal (${(err as Error).message})\n`,
    );
  }

  process.stdout.write(
    `[propose] opened PR${opened.prNumber !== undefined ? ` #${opened.prNumber}` : ""}: ${opened.url}\n`,
  );
}

/**
 * The production git/gh driver: create the propose/ branch, write the spec +
 * review bundle, commit, push, and `gh pr create`. Shells out to git/gh (no
 * git library — the "clients never speak git" precedent), all through argv
 * arrays (no shell). NEVER auto-merges.
 */
function createGitPrDriver(): GitPrDriver {
  return async (plan) => {
    const run = (bin: string, argv: ReadonlyArray<string>): string => {
      const proc = spawnSync(bin, [...argv], { encoding: "utf-8" });
      if (proc.status !== 0) {
        throw new ProposeError(
          `\`${bin} ${argv.join(" ")}\` failed (exit ${proc.status ?? "signal"}): ${(proc.stderr ?? "").toString().trim()}`,
        );
      }
      return (proc.stdout ?? "").toString();
    };
    // Refuse to run outside a git work tree with a clear message.
    const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf-8" });
    if (inside.status !== 0 || inside.stdout?.trim() !== "true") {
      throw new ProposeError(
        "not inside a git repository — `crewhaus propose` opens a PR against the spec's repo (run it from the checkout, or use --dry-run)",
      );
    }
    run("git", ["checkout", "-b", plan.branch]);
    for (const [rel, contents] of Object.entries(plan.files)) {
      const abs = resolve(process.cwd(), rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
      run("git", ["add", rel]);
    }
    run("git", ["commit", "-m", plan.commitMessage]);
    run("git", ["push", "-u", "origin", plan.branch]);
    // NEVER add --merge/auto-merge here — the PR is the human gate.
    const out = run("gh", [
      "pr",
      "create",
      "--title",
      plan.title,
      "--body",
      plan.body,
      "--head",
      plan.branch,
    ]);
    const url = out.trim().split("\n").pop() ?? "";
    const numMatch = /\/pull\/(\d+)/.exec(url);
    return {
      url,
      branch: plan.branch,
      ...(numMatch ? { prNumber: Number.parseInt(numMatch[1] as string, 10) } : {}),
    };
  };
}

/**
 * Section 28 — `crewhaus migrate-all --from <ver> --to <ver> [--dry-run]`.
 * Walks every spec in the registry and applies the migration chain.
 */
async function runMigrateAll(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus migrate-all --from <ver> --to <ver> [--dry-run] [--root-dir <dir>]\n" +
        "  Walk every spec in the registry (default .crewhaus/specs) to --to, writing a new\n" +
        "  version per spec (old versions stay for rollback). Comment-preserving; each\n" +
        "  migrated spec is validated via parseSpec before it is written.\n" +
        "  --from > --to is a DOWNWARD run: specs above --to are walked down, and a step\n" +
        "  marked irreversible is reported as validate-fail instead of skipped.\n",
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
  // 0.6.0 §9.2 — the fleet path finally validates: every migrated spec must
  // parse through the LIVE Zod union before the runner writes it (the gap
  // `upgrade` closed for single specs). The writer is comment-preserving too.
  const result = await migrateAll({
    registry: createFileBackedRegistry({ rootDir }),
    engine: createDefaultEngine(),
    fromVersion,
    toVersion,
    dryRun,
    validate: makeSpecValidator(parseSpec),
  });
  for (const item of result.plan) {
    const arrow = item.newVersion ? ` → ${item.newVersion}` : "";
    const err = item.error ? `   ERROR: ${item.error}` : "";
    const flattened = item.commentsPreserved === false ? "   (comments re-serialised)" : "";
    process.stdout.write(
      `${item.action.padEnd(15)} ${item.name}@${item.latestVersion}${arrow}${err}${flattened}\n`,
    );
  }
  const dryNote = dryRun ? " (dry-run)" : "";
  process.stdout.write(
    `[migrate-all] migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed}${dryNote}\n`,
  );
  if (result.failed > 0) process.exit(1);
}

/**
 * Item 32 — `crewhaus incident collect --session <id>`. Retroactively (or
 * on-demand) assembles a full incident bundle from a session's traces: reads
 * the session event-log as both the ring-event proxy and the transcript,
 * summarizes cost_accrual spend, matches audit records to the session's time
 * window (the timestamp linkage — audit records carry no sessionId), captures
 * a doctor inventory, and writes `.crewhaus/incidents/<ts>-<kind>/` with an
 * eval-report-styled index.html. When the runtime already auto-captured a raw
 * `incident.json`+`events.jsonl` for this session (CREWHAUS_INCIDENTS), those
 * ring events are folded in and the kind/reason default from it.
 */
/**
 * G63 — `crewhaus failures report`. Reads run_failed events across the
 * harness's session logs + incident bundle manifests, clusters them by
 * FailureClass + message similarity (see `./failures`), and prints a table.
 * `--propose-taxonomy` additionally drafts paste-ready failure_taxonomy
 * entries. Read-only; a report, never a gate (always exits 0).
 */
async function runFailuresReport(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus failures report [--sessions N|all] [--propose-taxonomy] [-o <taxonomy.yaml>]\n" +
        "                                [--dir <root>] [--json]\n" +
        "  Aggregate run_failed events (across .crewhaus/sessions) + incident bundles\n" +
        "  (.crewhaus/incidents/*/bundle.json), cluster them by FailureClass + message\n" +
        "  similarity (normalized-token, offline), and print a table ranked by frequency.\n" +
        "  --propose-taxonomy   draft failure_taxonomy entries from the clusters (paste-ready\n" +
        "                       YAML; -o writes them to a file). Each pattern is matched as a\n" +
        "                       case-insensitive substring of error.message — review before adopting.\n" +
        "  --sessions N|all     limit the scan to the N most-recent sessions (default: all).\n" +
        "  approval_pending parks are excluded — resolve those with `crewhaus approvals`.\n",
    );
    return;
  }
  const dirFlag = args.flags["dir"];
  const harnessRoot = typeof dirFlag === "string" ? resolve(dirFlag) : process.cwd();
  const sessionsDir = join(harnessRoot, SESSIONS_SUBDIR);
  const incidentsDir = join(harnessRoot, ".crewhaus", "incidents");

  // Session scope: all (default) or the N most-recent.
  let sessionIds = sessionIdsByRecency(sessionsDir);
  const sessionsFlag = args.flags["sessions"];
  if (typeof sessionsFlag === "string" && sessionsFlag !== "all") {
    const n = Number.parseInt(sessionsFlag, 10);
    if (Number.isNaN(n) || n < 1) {
      die(`invalid --sessions "${sessionsFlag}" — a positive integer or "all"`);
    }
    sessionIds = sessionIds.slice(0, n);
  }

  const records: FailureRecord[] = [];

  // 1) run_failed events from the session logs (the ONE failure each run died
  //    with — payload `{ class, message, remediation?, exitCode }`).
  for (const id of sessionIds) {
    let events: unknown[];
    try {
      events = parseJsonlObjects(readFileSync(join(sessionsDir, `${id}.jsonl`), "utf-8"));
    } catch {
      continue; // a vanished/unreadable log is skipped, not fatal
    }
    for (const ev of events) {
      if (ev === null || typeof ev !== "object") continue;
      const e = ev as { kind?: unknown; ts?: unknown; payload?: unknown };
      if (e.kind !== "run_failed") continue;
      const p = (e.payload ?? {}) as { class?: unknown; message?: unknown; exitCode?: unknown };
      records.push({
        source: "run_failed",
        class: typeof p.class === "string" ? p.class : "unknown",
        message: typeof p.message === "string" ? p.message : "",
        sessionId: id,
        ...(typeof e.ts === "number" ? { ts: e.ts } : {}),
        ...(typeof p.exitCode === "number" ? { exitCode: p.exitCode } : {}),
      });
    }
  }

  // 2) incident bundle manifests (auto-assembled on a failure trigger).
  if (existsSync(incidentsDir)) {
    for (const name of readdirSync(incidentsDir)) {
      const manifestPath = join(incidentsDir, name, "bundle.json");
      if (!existsSync(manifestPath)) continue;
      let manifest: {
        kind?: unknown;
        sessionId?: unknown;
        reason?: unknown;
        incidentTs?: unknown;
      };
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch {
        continue;
      }
      const kind = typeof manifest.kind === "string" ? manifest.kind : "incident";
      const ts =
        typeof manifest.incidentTs === "string" ? Date.parse(manifest.incidentTs) : Number.NaN;
      records.push({
        source: "incident",
        class: `incident:${kind}`,
        message: typeof manifest.reason === "string" ? manifest.reason : "",
        sessionId: typeof manifest.sessionId === "string" ? manifest.sessionId : name,
        ...(Number.isFinite(ts) ? { ts } : {}),
      });
    }
  }

  const clusters = clusterFailureRecords(records);
  const proposeTax = args.flags["propose-taxonomy"] === true;

  if (args.flags["json"] === true) {
    const proposal = proposeTax ? proposeTaxonomy(clusters) : undefined;
    process.stdout.write(
      `${JSON.stringify(
        { clusters, ...(proposal !== undefined ? { taxonomy: proposal } : {}) },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(renderFailuresTable(clusters));

  if (proposeTax) {
    const proposal = proposeTaxonomy(clusters);
    const yaml = renderTaxonomyYaml(proposal);
    const outFlag = args.flags["out"];
    if (typeof outFlag === "string") {
      writeFileSync(resolve(outFlag), yaml);
      process.stdout.write(
        `\n[failures] drafted ${proposal.drafts.length} failure_taxonomy entr${
          proposal.drafts.length === 1 ? "y" : "ies"
        } → ${resolve(outFlag)}\n`,
      );
    } else {
      process.stdout.write(`\n${yaml}`);
    }
  }
}

async function runIncidentCollect(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus incident collect --session <id> [--kind <kind>] [--reason <text>] [-o <dir>]\n" +
        "  Assemble an incident bundle from a session's traces + audit + cost + doctor.\n" +
        "  --kind defaults to run_abort (or the runtime's auto-captured kind, if any);\n" +
        "  kinds: run_abort | circuit_open | egress_blocked | justification_deny_storm | budget_exceeded.\n" +
        "  The bundle lands at .crewhaus/incidents/<ts>-<kind>/ (override root with -o).\n" +
        "  Audit records are matched to the session by TIME WINDOW (records carry no\n" +
        "  sessionId); the window is [first event, last event] of the session log.\n",
    );
    return;
  }
  const session = args.flags["session"];
  if (typeof session !== "string") die("missing --session <id>");

  const cwd = process.cwd();
  const { openEventLog } = await import("@crewhaus/event-log");
  const { openAuditLog } = await import("@crewhaus/audit-log");

  // Read the full session transcript (also the ring-event proxy for a
  // retroactive collect — the live ring buffer is gone, the durable log is
  // the best available record).
  let transcript: Array<{ ts: number; kind: string; payload: unknown }>;
  try {
    const log = await openEventLog(session, { rootDir: join(cwd, SESSIONS_SUBDIR) });
    transcript = [];
    for await (const ev of log.read()) transcript.push(ev);
    await log.close();
  } catch (err) {
    die(`could not read session ${session}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (transcript.length === 0) {
    die(`session ${session} has no events at ${join(cwd, SESSIONS_SUBDIR)}`);
  }
  const startTs = transcript[0]?.ts ?? Date.now();
  const endTs = transcript.at(-1)?.ts ?? startTs;

  // Ring events: the session log's own events are the durable proxy. cost is
  // summarized from the log's cost_accrual entries.
  const ringEvents = transcript;
  const cost = summarizeCost(ringEvents);

  // Audit records within the session window (the timestamp linkage).
  const auditRecords: Array<{ ts: number; kind: string; payload: unknown; seq?: number }> = [];
  try {
    const audit = await openAuditLog({ rootDir: join(cwd, ".crewhaus", "audit") });
    for await (const r of audit.read()) {
      auditRecords.push({ ts: r.ts, kind: r.kind, payload: r.payload, seq: r.seq });
    }
  } catch {
    // No audit log is fine — the bundle notes zero matching records.
  }
  const matchedAudit = matchAuditRecordsByWindow(auditRecords, { startTs, endTs });

  // Doctor inventory (read-only, no network probe so a collect never hangs) as
  // the doctor.txt context. Best-effort — a doctor failure must not block the
  // bundle.
  let doctor: string;
  try {
    const configPaths = [join(cwd, ".mcp.json")];
    const desktop = claudeDesktopConfigPath(process.platform, process.env);
    if (desktop !== undefined) configPaths.push(desktop);
    const inventory = await buildInventory({
      env: process.env,
      fetchImpl: async () => ({ ok: false, status: 0, json: async () => ({}) }),
      readConfig: (p) => {
        try {
          return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
        } catch {
          return undefined;
        }
      },
      configPaths,
      skipProbe: true,
    });
    doctor = formatInventory(inventory);
  } catch (err) {
    doctor = `doctor inventory unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }

  const kindFlag = args.flags["kind"];
  const kind = (typeof kindFlag === "string" ? kindFlag : "run_abort") as IncidentKind;
  const validKinds: IncidentKind[] = [
    "run_abort",
    "circuit_open",
    "egress_blocked",
    "justification_deny_storm",
    "budget_exceeded",
  ];
  if (!validKinds.includes(kind)) {
    die(`--kind must be one of: ${validKinds.join(", ")} (got "${kind}")`);
  }
  const reason =
    typeof args.flags["reason"] === "string"
      ? args.flags["reason"]
      : `retroactive collect of session ${session}`;

  const assembled = assembleIncidentBundle({
    kind,
    sessionId: session,
    incidentTs: new Date().toISOString(),
    reason,
    ringEvents,
    transcript,
    auditRecords: matchedAudit,
    cost,
    spec: { name: session },
    doctor,
    window: { startTs, endTs },
  });

  const outRoot =
    typeof args.flags["out"] === "string"
      ? resolve(args.flags["out"] as string)
      : join(cwd, ".crewhaus", "incidents");
  const dir = join(outRoot, assembled.dirName);
  mkdirSync(dir, { recursive: true });
  for (const file of assembled.files) {
    writeFileSync(join(dir, file.name), file.contents);
  }
  process.stdout.write(
    `[incident] collected ${kind} for ${session}: ${ringEvents.length} events, ` +
      `${matchedAudit.length} audit records → ${dir}\n`,
  );
  process.stdout.write(`[incident] report: ${join(dir, "index.html")}\n`);
}

/**
 * Item 43 — `crewhaus upgrade [spec.yaml] [--dry-run] [--write]`. Detects the
 * cwd (or named) spec's schema-version drift against the CLI's current spec
 * version (the migration engine's `latestVersion()`), runs the migration chain
 * with a `parseSpec` VALIDATE callback (the gap `migrate-all` left open — it
 * wrote migrated specs unchecked), prints a diff, and — with `--write` —
 * applies it in place. Dry-run is the default.
 */
async function runUpgrade(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus upgrade [spec.yaml] [--dry-run] [--write] [--hoist-models [--rewrite-arms]]\n" +
        "  Detect the spec's schema-version drift vs this CLI's current spec version\n" +
        "  and run the migration chain (each migrated spec is validated via parseSpec\n" +
        "  before it can be written). Defaults to ./crewhaus.yaml and to a dry-run diff.\n" +
        "  The migration is comment- and key-order-preserving (0.6.0: each step is a\n" +
        "  list of CST edits, not a re-serialised object).\n" +
        "  Also prints the per-release notes that apply to this spec — 0.2.x → 0.3.0\n" +
        "  (default-on continuity, `crewhaus migrate memories`, MCP secret lowering)\n" +
        "  and 0.5.x → 0.6.0 (crew per-role pools live, budget on every model call,\n" +
        "  judge spend under judge_share) — informational only.\n" +
        "  --hoist-models   lift {model, thinking, max_tokens} triples repeated on two or\n" +
        "                   more slots into models: profiles named by price rank and\n" +
        "                   rewrite the slots to $refs (a proposal; the lowered IR is\n" +
        "                   identical). Prints the diff; --write applies it.\n" +
        "  --rewrite-arms   re-key .crewhaus/routing/arms.jsonl lines whose candidate became\n" +
        "                   a profile. REFUSED on this runtime: pool arms are recorded under\n" +
        "                   the model string until the profile-keyed scoreboard ships, so\n" +
        "                   --hoist-models prints what each hoisted arm id will do instead.\n" +
        "  --write   apply in place (rewrites the spec file), then register the new\n" +
        "            version + changelog entry in .crewhaus/specs like `compile` does.\n",
    );
    return;
  }
  const write = args.flags["write"] === true;
  const hoistModels = args.flags["hoist-models"] === true;
  const rewriteArms = args.flags["rewrite-arms"] === true;
  if (rewriteArms && !hoistModels) die("--rewrite-arms requires --hoist-models");
  if (rewriteArms) {
    // §7.9: arm identity by profile name is the routing PR's; this runtime
    // records arms under the model string, so re-keying would orphan them.
    const { REWRITE_ARMS_UNAVAILABLE } = await import("./hoist-models");
    die(REWRITE_ARMS_UNAVAILABLE);
  }
  const specArg = args.positional[0];
  const absSpec = resolve(
    typeof specArg === "string" ? specArg : join(process.cwd(), "crewhaus.yaml"),
  );
  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }

  const { createDefaultEngine } = await import("@crewhaus/migration-engine");
  const engine = createDefaultEngine();
  // The validate callback the CLI's migrate-all never wired: a migrated spec
  // must parse through the LIVE Zod union before it can be written back.
  const plan = planUpgrade(yamlText, engine, makeSpecValidator(parseSpec));
  process.stdout.write(formatUpgradePlan(plan, write));

  // The text every later stage builds on: the migrated YAML when a migration
  // is pending, the file as-is when it is current. `ahead` / `validate-fail`
  // leave nothing safe to build on.
  let finalYaml: string | undefined =
    plan.action === "upgrade"
      ? plan.migratedYaml
      : plan.action === "up-to-date"
        ? yamlText
        : undefined;

  // 0.6.0 §9.2 — `--hoist-models`: a proposal by default, applied under --write.
  if (hoistModels) {
    if (finalYaml === undefined) {
      process.stdout.write(
        "hoist-models: skipped — resolve the schema-version problem above first.\n",
      );
    } else {
      const { planHoistModels, formatHoistPlan, formatArmNotes, countArmLines, armModels } =
        await import("./hoist-models");
      let hoist: ReturnType<typeof planHoistModels>;
      try {
        hoist = planHoistModels(finalYaml, { pricing: loadUserPricing() });
      } catch (err) {
        if (err instanceof CrewhausError) die(`hoist-models: ${err.message}`);
        throw err;
      }
      process.stdout.write(formatHoistPlan(hoist, write));
      if (hoist.action === "hoist") {
        finalYaml = hoist.yaml;
        const armsPath = join(dirname(absSpec), ".crewhaus", "routing", "arms.jsonl");
        // Arm identity: the runtime keys arms by model string, so the file is
        // never touched here — the note reports what each hoisted arm id will
        // do once profile-keyed identity ships (`--rewrite-arms` was refused
        // above). Counts are read once, before anything could rewrite them.
        const counts = countArmLines(armsPath, armModels(hoist));
        process.stdout.write(formatArmNotes(armsPath, hoist, counts));
      }
    }
  }

  if (write && finalYaml !== undefined && finalYaml !== yamlText) {
    writeFileSync(absSpec, finalYaml);
    // Register + changelog the rewritten spec exactly as `compile` does, so
    // `spec log` shows the upgrade as a version rather than a silent edit.
    await autoRegisterSpec(finalYaml);
  }
  // A migration/validation failure is a non-zero exit so CI can gate on it.
  process.exit(plan.action === "validate-fail" ? 1 : 0);
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
async function runBuildImage(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
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
  const target = args.positional[0];
  if (typeof target !== "string") die("missing <target> (one of cli, workflow, channel, ...)");
  const tag = args.flags["tag"];
  if (typeof tag !== "string") die("missing --tag <tag>");
  const platform = args.flags["platform"];
  const push = args.flags["push"] === true;
  const record = args.flags["no-record"] !== true;

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
      `usage: crewhaus cloud ${action} --provider <aws|gcp|azure|aws-localstack> --region <r> [--tier <dev|default|production>] [--image-tag <tag>] [--working-dir <dir>]\n       --working-dir defaults to .crewhaus/cloud/<cluster-name> under the current directory\n`,
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

/** Write a provider's scaffolded manifests under `outDir`, returning the
 *  relative file names (for the summary). Shared by every `deploy <provider>`
 *  arm. */
function writeDeployFiles(
  outDir: string,
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const file of files) {
    const full = join(outDir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
    written.push(file.path);
  }
  return written;
}

/**
 * Loop contract 0.4 (Batch F, item 5) — `crewhaus deploy <fly|render|railway|
 * heroku> <spec> [-o <dir>] [--app <name>] [--image <ref>] [--region <r>]
 * [--live]`.
 *
 * Scaffolds the provider's deploy manifests (a Dockerfile wrapper + the
 * provider's IaC descriptor) from the spec's target shape, then — gated on the
 * provider API token — optionally performs the LIVE deploy through the matching
 * `@crewhaus/cloud-adapter-*` engine (dynamic-imported, lazy-booted exactly
 * like `crewhaus cloud`). Default is scaffold-only: the live deploy needs BOTH
 * `--live` AND the provider token, so a token-less run (CI, a first look) never
 * touches a real API. Only daemon shapes (channel/managed/batch/voice/browser)
 * deploy — a single-shot shape has nothing to keep running.
 */
async function runCloudDeploy(
  args: ParsedArgs,
  providerName: CloudDeployProviderName,
): Promise<void> {
  const provider = CLOUD_DEPLOY_PROVIDERS[providerName];
  if (args.flags["help"] === true) {
    const providerFlag =
      providerName === "railway"
        ? " [--project <projectId>]"
        : providerName === "fly"
          ? " [--org <slug>]"
          : providerName === "render"
            ? " [--owner <ownerId>]"
            : "";
    const lines = [
      `usage: crewhaus deploy ${providerName} <spec.yaml> [-o <dir>] [--app <name>] [--image <ref>] [--region <r>] [--live]${providerFlag}`,
      `  Scaffolds ${provider.label} deploy manifests (a Dockerfile + the provider's IaC`,
      `  descriptor) for a daemon-shape spec (${CLOUD_DEPLOY_TARGET_SHAPES.join("/")}), under`,
      "  <dir> (default ./deploy/<provider>).",
      `  --live   also deploy to ${provider.label} via its API — GATED on ${provider.tokenEnv}`,
      "           (absent → scaffold and stop). The deploy never runs without --live.",
      "  --app    app/service name (default: the spec name, sanitized to the provider grammar).",
      "  --image  base image the generated Dockerfile wraps (default crewhaus/<target>:latest).",
    ];
    if (providerName === "fly") {
      lines.push(
        "  --image is ALSO the machine image --live launches (build+push it first with",
        "           `crewhaus build-image <target> --push`).",
      );
    }
    if (providerName === "railway") {
      lines.push(
        "  --project <id> is required for --live (Railway attaches the service to a project).",
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
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
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }
  const target = ir.target;
  if (!isCloudDeployTargetShape(target)) {
    die(
      `deploy ${providerName}: target "${target}" is not a deployable daemon shape — ${provider.label} runs the long-lived shapes ${CLOUD_DEPLOY_TARGET_SHAPES.join("/")}. A single-shot shape (cli/workflow/graph/…) has nothing to keep running: compile + run it directly, or \`compile --emit-as cf-worker\` for the edge.`,
    );
  }
  const appName = resolveCloudDeployAppName(ir.name, strFlag(args, "app"));
  const baseImage = strFlag(args, "image") ?? defaultCloudDeployBaseImage(target);
  const region = strFlag(args, "region");
  const outFlag = strFlag(args, "out");
  const outDir =
    outFlag !== undefined ? resolve(outFlag) : resolve(join(process.cwd(), "deploy", providerName));
  const live = args.flags["live"] === true;
  const tokenPresent = cloudDeployTokenPresent(provider);
  // --live must clear the token gate BEFORE any manifest is written or any API
  // is touched, naming the exact env var the engine also resolves.
  if (live && !tokenPresent) {
    die(
      `deploy ${providerName} --live needs ${provider.tokenEnv} (unset) — set it, or drop --live to scaffold the manifests only.`,
    );
  }

  try {
    switch (providerName) {
      case "fly": {
        const fly = await import("@crewhaus/cloud-adapter-flyio");
        const files = [
          {
            path: "fly.toml",
            content: fly.flyTomlFor({
              target,
              appName,
              ...(region !== undefined ? { primaryRegion: region } : {}),
            }),
          },
          { path: "Dockerfile.fly", content: fly.flyDockerfileFor({ target, baseImage }) },
        ];
        const written = writeDeployFiles(outDir, files);
        if (!live) {
          process.stdout.write(
            formatCloudDeployNextSteps({ provider, outDir, tokenPresent, files: written }),
          );
          return;
        }
        const imageRef = strFlag(args, "image");
        if (imageRef === undefined) {
          die(
            "deploy fly --live needs --image <pushed-image-ref>: Fly launches a machine from a registry image. Build + push first with `crewhaus build-image <target> --push`, then pass its ref.",
          );
        }
        const org = strFlag(args, "org");
        const rec = await fly.deployToFly({
          appName,
          imageRef,
          target,
          ...(region !== undefined ? { region } : {}),
          ...(org !== undefined ? { orgSlug: org } : {}),
        });
        process.stdout.write(
          `deployed to ${provider.label}: app ${rec.appName} machine ${rec.machineId} (${rec.status}) in ${rec.region}\n`,
        );
        return;
      }
      case "render": {
        const render = await import("@crewhaus/cloud-adapter-render");
        // `region` is the free-form CLI flag; the blueprint types it as the
        // RenderRegion union but only interpolates it (defaulting "oregon"), so
        // cast through the function's own parameter type — no static engine
        // import — and let the adapter own any validation.
        type RenderRegionArg = NonNullable<
          Parameters<typeof render.renderBlueprintFor>[0]["region"]
        >;
        const blueprintYaml = render.renderBlueprintFor({
          target,
          serviceName: appName,
          ...(region !== undefined ? { region: region as RenderRegionArg } : {}),
        });
        const files = [
          { path: "render.yaml", content: blueprintYaml },
          { path: "Dockerfile.render", content: render.renderDockerfileFor({ target, baseImage }) },
        ];
        const written = writeDeployFiles(outDir, files);
        if (!live) {
          process.stdout.write(
            formatCloudDeployNextSteps({ provider, outDir, tokenPresent, files: written }),
          );
          return;
        }
        const owner = strFlag(args, "owner");
        const rec = await render.deployToRender({
          blueprintYaml,
          serviceName: appName,
          ...(owner !== undefined ? { ownerId: owner } : {}),
        });
        process.stdout.write(
          `deployed to ${provider.label}: service ${rec.serviceId} deploy ${rec.deployId} (${rec.status})${rec.url !== undefined ? ` → ${rec.url}` : ""}\n`,
        );
        return;
      }
      case "railway": {
        const railway = await import("@crewhaus/cloud-adapter-railway");
        const files = [
          { path: "railway.json", content: railway.railwayConfigFor({ target }) },
          {
            path: "Dockerfile.railway",
            content: railway.railwayDockerfileFor({ target, baseImage }),
          },
        ];
        const written = writeDeployFiles(outDir, files);
        if (!live) {
          process.stdout.write(
            formatCloudDeployNextSteps({ provider, outDir, tokenPresent, files: written }),
          );
          return;
        }
        const projectId = strFlag(args, "project");
        if (projectId === undefined) {
          die(
            "deploy railway --live needs --project <projectId>: Railway attaches the service to an existing project. Create one in the Railway dashboard and pass its id.",
          );
        }
        const rec = await railway.deployToRailway({ projectId, serviceName: appName });
        process.stdout.write(
          `deployed to ${provider.label}: service ${rec.serviceName} (${rec.serviceId}) in project ${rec.projectId}\n`,
        );
        return;
      }
      case "heroku": {
        const heroku = await import("@crewhaus/cloud-adapter-heroku");
        const files = [
          { path: "heroku.yml", content: heroku.herokuYmlFor({ target }) },
          { path: "app.json", content: heroku.appJsonFor({ target, name: appName }) },
          { path: "Dockerfile.heroku", content: heroku.herokuDockerfileFor({ target, baseImage }) },
        ];
        const written = writeDeployFiles(outDir, files);
        if (!live) {
          process.stdout.write(
            formatCloudDeployNextSteps({ provider, outDir, tokenPresent, files: written }),
          );
          return;
        }
        // Heroku accepts only the two macro-regions.
        let herokuRegion: "us" | "eu" | undefined;
        if (region !== undefined) {
          if (region !== "us" && region !== "eu") {
            die(`deploy heroku --region must be "us" or "eu" (got "${region}")`);
          }
          herokuRegion = region;
        }
        const rec = await heroku.deployToHeroku({
          appName,
          ...(herokuRegion !== undefined ? { region: herokuRegion } : {}),
        });
        process.stdout.write(
          `deployed to ${provider.label}: app ${rec.appName} (${rec.appId}) → ${rec.webUrl}\n`,
        );
        return;
      }
      default:
        assertNever(providerName);
    }
  } catch (err) {
    if (err instanceof CrewhausError) die(err.message);
    die(`deploy ${providerName}: ${(err as Error).message}`);
  }
}

/**
 * Section 34 — `crewhaus federation discover <deployment> [--srv-domain <d>] [--format json|yaml]`.
 * Resolves a peer's endpoint + supportedShapes + publicKeyFingerprint via
 * .well-known/crewhaus.json, optionally seeded by a DNS SRV lookup.
 */
async function runFederation(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus federation discover <deployment> [--srv-domain <d>] [--format json|yaml]\n",
    );
    return;
  }
  const deployment = args.positional[0];
  if (typeof deployment !== "string") die("missing <deployment>");
  const { discoverDeployment } = await import("@crewhaus/federation-discovery");
  try {
    const config: { srvDomain?: string } = {};
    const srv = args.flags["srv-domain"];
    if (typeof srv === "string") config.srvDomain = srv;
    const record = await discoverDeployment(deployment, config);
    const formatFlag = args.flags["format"];
    const format = typeof formatFlag === "string" ? formatFlag : "json";
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
 * Ops item 38 — `crewhaus mcp doctor [--probe]`. Three capabilities, all over
 * the cwd harness's on-disk stores (mirroring `sandbox doctor` / `retention`):
 *
 *   1. HEALTH SCORING — fold the durable `mcp_stats` records from the N most
 *      recent session logs (`.crewhaus/sessions/*.jsonl`) into per-server
 *      error-rate / latency / chronic-failure verdicts. mcp_call_* events are
 *      trace-bus-only, so this durable mirror (runtime-core, default-on with
 *      the advisor events) is the only cross-session history there is.
 *
 *   2. DRIFT WATCH (`--probe`) — connect to each configured MCP server, list
 *      its tools, and diff the (name + schema-hash) snapshot against the last
 *      one on disk (`.crewhaus/mcp/<server>.json`), reporting added / removed /
 *      schema-changed tools BEFORE a production call fails. Offline (no
 *      `--probe`) it scores health only.
 *
 *   3. AUTO-QUARANTINE — persist the chronic/recovered verdicts to
 *      `.crewhaus/mcp/quarantine.json`; the runtime reads that set and withdraws
 *      those servers' tools from the ToolCatalog (injecting a synthetic notice
 *      so the model routes around them), restoring them once healthy again.
 *
 * Exit semantics mirror `sandbox doctor --probe`: exit 1 when any server is
 * chronically failing OR (with `--probe`) drift was detected, so a CI cron
 * gates on MCP health; else exit 0. `--liveness`-style: a cold store (no
 * history) is exit 0, never a flap.
 */
async function runMcpDoctor(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus mcp doctor [--probe] [--format json|table] [--sessions N]\n" +
        "  --probe          connect to each configured MCP server + diff listTools against\n" +
        "                   the last .crewhaus/mcp/<server>.json snapshot (drift watch)\n" +
        "  --sessions N     score the N most-recent session logs (default 20)\n" +
        "  --format         table (default) | json\n" +
        "  Exit 1 on a chronically-failing server or detected drift; else 0.\n",
    );
    return;
  }
  const cwd = process.cwd();
  const formatFlag = args.flags["format"];
  const format = typeof formatFlag === "string" ? formatFlag : "table";
  if (format !== "json" && format !== "table") {
    die(`--format must be "json" or "table" (got "${format}")`);
  }
  const limit = intFlag(args, "sessions") ?? 20;
  if (limit < 1) die(`invalid --sessions "${args.flags["sessions"]}" — must be a positive integer`);
  const wantProbe = args.flags["probe"] === true;

  // 1. Health scoring — read mcp_stats from the N most-recent session logs.
  const sessionsDir = join(cwd, ".crewhaus", "sessions");
  const files = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))
    : [];
  const recent = files
    .map((f) => {
      const file = join(sessionsDir, f);
      return { file, mtimeMs: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    // Re-sort ASCENDING by mtime so records fold in chronological order (the
    // consecutive-error-streak proxy depends on order).
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const statsRecords: McpStatsPayload[] = [];
  for (const r of recent) {
    for (const obj of parseAdviseJsonl(readFileSync(r.file, "utf-8"))) {
      const rec = obj as { kind?: unknown; payload?: unknown };
      if (rec.kind !== "mcp_stats") continue;
      const p = rec.payload as Partial<McpStatsPayload>;
      if (typeof p.server === "string" && typeof p.toolName === "string") {
        statsRecords.push({
          server: p.server,
          toolName: p.toolName,
          durationMs: typeof p.durationMs === "number" ? p.durationMs : 0,
          isError: p.isError === true,
        });
      }
    }
  }
  const health = scoreMcpHealth(statsRecords);

  // Load the current quarantine set (persisted across runs).
  const mcpDir = join(cwd, ".crewhaus", "mcp");
  const quarantinePath = join(mcpDir, "quarantine.json");
  let quarantined: string[] = [];
  if (existsSync(quarantinePath)) {
    try {
      const parsed = JSON.parse(readFileSync(quarantinePath, "utf-8")) as { servers?: unknown };
      if (Array.isArray(parsed.servers)) {
        quarantined = parsed.servers.filter((s): s is string => typeof s === "string");
      }
    } catch {
      // corrupt gate — treat as empty (never crash the doctor on a bad file).
    }
  }
  const decision = decideQuarantine(health, quarantined);

  // 2. Drift watch (--probe): connect to each configured server + diff listTools.
  type DriftEntry = { server: string; lines: string[] };
  const driftEntries: DriftEntry[] = [];
  let driftDetected = false;
  if (wantProbe) {
    const specPath = join(cwd, "crewhaus.yaml");
    let mcpServers: Record<string, import("@crewhaus/ir").IrMcpServerConfig> = {};
    if (existsSync(specPath)) {
      try {
        const ir = lower(parseSpec(readFileSync(specPath, "utf-8")));
        mcpServers = (ir as { mcp_servers?: typeof mcpServers }).mcp_servers ?? {};
      } catch {
        // no/broken spec — nothing to probe (health scoring still ran above).
      }
    }
    if (Object.keys(mcpServers).length > 0) {
      mkdirSync(mcpDir, { recursive: true });
      const host = new McpHost({ logger });
      for (const [name, cfg] of Object.entries(mcpServers)) {
        // 0.3.0 — env/header values are IrSecretRef; an unresolvable env
        // ref becomes a per-server probe failure (named variable) rather
        // than crashing the whole doctor run.
        try {
          host.addServer(name, resolveMcpServerConfig(cfg, { name }));
        } catch (err) {
          driftEntries.push({
            server: name,
            lines: [
              `  ✗ ${name}: probe failed — ${err instanceof Error ? err.message : String(err)}`,
            ],
          });
          driftDetected = true;
        }
      }
      const probeNames = Object.keys(mcpServers).filter((name) => host.has(name));
      const nowIso = new Date().toISOString();
      await Promise.all(
        probeNames.map(async (name) => {
          const lines: string[] = [];
          try {
            const client = host.getClient(name);
            await client.connect();
            const tools = await client.listTools();
            const snapshot = buildSnapshot(
              name,
              tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema })),
              nowIso,
            );
            // F5 — the server name is an mcp_servers KEY (schema is
            // z.string().min(1), not safeName), so `../../evil` would escape
            // .crewhaus/mcp/. Sanitise to a bare filename segment before joining.
            const snapshotPath = join(mcpDir, `${safeMcpFileName(name)}.json`);
            let previous: McpServerSnapshot | undefined;
            if (existsSync(snapshotPath)) {
              try {
                previous = JSON.parse(readFileSync(snapshotPath, "utf-8")) as McpServerSnapshot;
              } catch {
                previous = undefined;
              }
            }
            const drift = diffSnapshots(previous, snapshot);
            const driftLines = formatDriftReport(name, drift);
            if (driftLines.length > 0) {
              driftDetected = true;
              lines.push(...driftLines);
            }
            // Persist the fresh snapshot as the new baseline.
            writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
          } catch (err) {
            lines.push(
              `  ✗ ${name}: probe failed — ${err instanceof Error ? err.message : String(err)}`,
            );
            driftDetected = true;
          }
          driftEntries.push({ server: name, lines });
        }),
      );
      await host.disconnectAll();
    }
  }

  // Persist the updated quarantine set (chronic added, recovered removed).
  const nextQuarantined = new Set(quarantined);
  for (const s of decision.quarantine) nextQuarantined.add(s);
  for (const s of decision.restore) nextQuarantined.delete(s);
  if (decision.quarantine.length > 0 || decision.restore.length > 0) {
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(
      quarantinePath,
      `${JSON.stringify({ version: 1, servers: [...nextQuarantined].sort(), ts: Date.now() }, null, 2)}\n`,
    );
  }

  // Render.
  const anyChronic = health.some((h) => h.chronic);
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          health,
          quarantine: decision,
          quarantined: [...nextQuarantined].sort(),
          ...(wantProbe ? { driftDetected, drift: driftEntries } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const line of formatHealthReport(health)) process.stdout.write(`${line}\n`);
    if (wantProbe) {
      const withDrift = driftEntries.filter((d) => d.lines.length > 0);
      if (withDrift.length === 0) process.stdout.write("no tool drift detected\n");
      for (const d of withDrift) for (const l of d.lines) process.stdout.write(`${l}\n`);
    }
    for (const s of decision.quarantine) {
      const h = health.find((x) => x.server === s);
      process.stdout.write(
        `${quarantineNotice(s, `${((h?.errorRate ?? 0) * 100).toFixed(0)}% errors over ${h?.calls ?? 0} calls`)}\n`,
      );
    }
    for (const s of decision.restore) {
      process.stdout.write(`[mcp] server "${s}" recovered — tools restored\n`);
    }
  }
  // Exit 1 on a chronic server or (probe mode) detected drift; else 0.
  process.exit(anyChronic || (wantProbe && driftDetected) ? 1 : 0);
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
 * injection rule-id hits (from session redaction notices), and top
 * warn/block egress sinks + origins (from the `egress_decision` records
 * runtime-core appends on warn/block verdicts). See security-digest.ts for
 * exactly which audit kinds have writers today and the design decisions
 * (local HTML helper, plain-fetch notify).
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
 * AUTOMATION-OPPORTUNITIES.md item 50 — `crewhaus security corpus [check]`.
 *
 * `security corpus` — harvest the detector's real block residue (prompt-
 * injection redaction notices in session `tool_result` content) into a
 * versioned REGRESSION dataset at `.crewhaus/security-corpus/corpus.json`
 * (one case per rule observed blocking, pinned to a canonical exemplar built
 * at runtime — never a stored attack payload), and cluster suspicious near-
 * misses into REVIEWED candidate detector rules at `candidate-rules.json`
 * (never auto-merged into REGEX_RULES; samples are redacted through the same
 * strong secret+PII detector set the dataset/knowledge synthesis paths use
 * and reduced to a short hash-first descriptor — never a raw or lightly-
 * redacted snippet). See security-corpus.ts for the durability + no-raw-
 * value design.
 *
 * `security corpus check` — run the corpus against the CURRENT detector and
 * exit non-zero if any exemplar's classification has DRIFTED DOWN from the
 * tier recorded at build time (F2) — e.g. malicious→suspicious, not only a
 * drop all the way to clean, since only `malicious` redacts at runtime.
 * CI-usable.
 */
async function runSecurityCorpus(args: ParsedArgs, action: "build" | "check"): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus security corpus [--since <N>d|<ISO>] [--min-support N] [--dir <root>] [--json]\n" +
        "       crewhaus security corpus check [--dir <root>] [--json]\n" +
        "\n" +
        "  corpus         harvest blocked prompt-injection attempts (redaction-notice\n" +
        "                 residue in session logs) into a versioned regression dataset\n" +
        "                 (.crewhaus/security-corpus/corpus.json) + reviewed candidate\n" +
        "                 detector rules (candidate-rules.json). corpus.json cases pin a\n" +
        "                 canonical exemplar built at runtime, never a stored attack\n" +
        "                 payload; candidate-rules.json samples are redacted + hashed,\n" +
        "                 never a raw or lightly-redacted snippet.\n" +
        "  corpus check   run the corpus against the CURRENT detector; exit 1 if any\n" +
        "                 exemplar's classification tier has drifted DOWN from its\n" +
        "                 recorded baseline (e.g. malicious→suspicious), not only a\n" +
        "                 drop to clean. CI-usable.\n" +
        "\n" +
        "  --since <w>    window over session logs: <N>d or ISO (default: all-time)\n" +
        "  --min-support  distinct near-miss snippets to emit a candidate rule (default 3)\n" +
        "  --dir <root>   harness root that owns .crewhaus/ (default: cwd)\n" +
        "  --json         machine-readable output\n",
    );
    return;
  }
  const dirFlag = args.flags["dir"];
  const rootDir = typeof dirFlag === "string" ? resolve(dirFlag) : process.cwd();
  const json = args.flags["json"] === true;

  if (action === "check") {
    const path = corpusPath(rootDir);
    let corpus: ReturnType<typeof loadSecurityCorpus>;
    try {
      corpus = loadSecurityCorpus(path);
    } catch (err) {
      if (err instanceof SecurityCorpusError) die(err.message);
      throw err;
    }
    if (corpus === undefined) {
      die(`no corpus at ${path} — run \`crewhaus security corpus\` first`);
      return;
    }
    const result = await checkSecurityCorpus(corpus);
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `security corpus check: ${path}\n${renderCorpusCheckLines(result)
          .map((l) => `  ${l}`)
          .join("\n")}\n`,
      );
    }
    // CI-usable exit code: a detector regression fails the process.
    if (result.verdict === "fail") process.exit(1);
    return;
  }

  const window = parseCorpusSince(
    typeof args.flags["since"] === "string" ? args.flags["since"] : undefined,
  );
  const harvest = harvestBlockedAttempts({ rootDir, window });
  const corpus = await buildSecurityCorpus(harvest, window.label);
  const nearMisses = harvestNearMisses({ rootDir, window });
  const minSupport = intFlag(args, "min-support") ?? 3;
  const candidates = clusterCandidateRules(nearMisses, minSupport);

  mkdirSync(corpusDir(rootDir), { recursive: true });
  const cPath = corpusPath(rootDir);
  const candPath = candidateRulesPath(rootDir);
  writeFileSync(cPath, `${JSON.stringify(corpus, null, 2)}\n`);
  writeFileSync(candPath, `${JSON.stringify(candidates, null, 2)}\n`);

  if (json) {
    process.stdout.write(`${JSON.stringify({ corpus, candidates }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`security corpus: ${rootDir}\n`);
  for (const line of renderCorpusBuildLines(corpus)) process.stdout.write(`  ${line}\n`);
  process.stdout.write(
    `  candidate rules: ${candidates.candidates.length} clustered from ${nearMisses.length} near-miss(es) (min-support ${minSupport}, review before merging)\n`,
  );
  process.stdout.write(`  wrote ${cPath}\n  wrote ${candPath}\n`);
}

/**
 * AUTOMATION-OPPORTUNITIES.md item 20 — `crewhaus egress review [--propose]`.
 *
 * Mines the durable `.crewhaus/audit` chain for `egress_decision` records (now
 * written by runtime-core's egress audit sink on every non-pass verdict) plus
 * rule-based justification denials, clusters them by (sink, origin), and
 * proposes learned security spec suggestions: per-sink relaxations (advice —
 * `security.egressPolicy` is reserved for the egress FRs, so we coordinate
 * rather than add the schema field), `security.egressMatcher: semantic` when
 * warn-noise is high with zero blocks (advice — not optimizer-whitelisted),
 * and `security.justification.judge: claude` when rule-based denials are
 * frequent (a VALIDATED spec-patch that rides `optimize --from-advice`).
 *
 * `--propose` (with `-o <dir>`, default `.crewhaus/egress-review`) writes the
 * whitelisted patches to a `suggestions.json` in the same shape
 * `optimize --from-advice` consumes. See egress-triage.ts for the design.
 */
async function runEgressReview(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus egress review [--propose] [-o <dir>] [--dir <root>] [--json]\n" +
        "\n" +
        "triages .crewhaus/audit egress_decision + rule-based justification-denial\n" +
        "history into learned security spec suggestions:\n" +
        "  per-sink relaxations (advice — security.egressPolicy is reserved for the\n" +
        "    egress FRs, so this coordinates rather than adds the schema field),\n" +
        "  security.egressMatcher: semantic when warn-noise is high with 0 blocks,\n" +
        "  security.justification.judge: claude when rule-based denials are frequent\n" +
        "    (an eval-gated spec-patch that rides optimize --from-advice)\n" +
        "\n" +
        "  --propose       write whitelisted patches to <dir>/suggestions.json\n" +
        "  -o <dir>        artifact dir (default .crewhaus/egress-review)\n" +
        "  --dir <root>    harness root that owns .crewhaus/ (default: cwd)\n" +
        "  --json          machine-readable findings to stdout\n",
    );
    return;
  }
  const dirFlag = args.flags["dir"];
  const rootDir = typeof dirFlag === "string" ? resolve(dirFlag) : process.cwd();
  const auditDir = join(rootDir, ".crewhaus", "audit");
  const auditObjects: unknown[] = [];
  if (existsSync(auditDir)) {
    for (const f of readdirSync(auditDir).sort()) {
      if (!f.endsWith(".jsonl")) continue;
      auditObjects.push(...parseAdviseJsonl(readFileSync(join(auditDir, f), "utf-8")));
    }
  }

  // The cwd spec enables the whitelisted justification patch; without one the
  // rules fall back to advice text (mirrors `advise`).
  let spec: Spec | undefined;
  const specPath = join(rootDir, "crewhaus.yaml");
  if (existsSync(specPath)) {
    try {
      spec = parseSpec(readFileSync(specPath, "utf-8"));
    } catch (err) {
      process.stderr.write(
        `[egress review] crewhaus.yaml did not parse (${(err as Error).message}) — patch suggestions downgraded to advice\n`,
      );
    }
  }

  const ctx = buildEgressTriageContext(auditObjects);
  const findings = runEgressTriage(ctx, spec !== undefined ? { spec } : {});
  const generatedAt = new Date().toISOString();

  if (args.flags["json"] === true) {
    process.stdout.write(`${JSON.stringify({ context: ctx, findings }, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `egress review: ${rootDir}\n` +
      `  ${ctx.egressRecords} durable egress_decision record(s), ${ctx.totalWarned} warned / ${ctx.totalBlocked} blocked; ${ctx.ruleBasedDenials}/${ctx.ruleBasedEvaluated} rule-based justification denials\n`,
  );
  if (ctx.egressRecords === 0 && ctx.ruleBasedEvaluated === 0) {
    process.stdout.write(
      "  no durable egress/justification history yet — run the agent (egress verdicts are now written to .crewhaus/audit), then review\n",
    );
  }
  process.stdout.write(`  ${findings.length} suggestion${findings.length === 1 ? "" : "s"}\n`);
  for (const f of findings) {
    for (const line of formatEgressFindingLines(f)) process.stdout.write(`  ${line}\n`);
  }

  if (args.flags["propose"] === true) {
    const outDir = strFlag(args, "out") ?? join(rootDir, ".crewhaus", "egress-review");
    mkdirSync(outDir, { recursive: true });
    const suggestions = buildSuggestionsFile(
      findings,
      ctx.clusters.map((c) => c.sinkId),
      generatedAt,
    );
    const suggestionsPath = join(outDir, "suggestions.json");
    writeFileSync(suggestionsPath, `${JSON.stringify(suggestions, null, 2)}\n`);
    process.stdout.write(
      `  [propose] ${suggestions.suggestions.length} eval-gated patch(es) → ${suggestionsPath} (feed to \`optimize --from-advice\`)\n`,
    );
  }
}

/**
 * AUTOMATION-OPPORTUNITIES.md item 51 — `crewhaus pii tune`.
 *
 * Aggregates PII-redaction history across sessions (running the shared
 * detector over durable session/turn content, HASHING every value on
 * detection) to find (a) false-positive over-redaction candidates — values
 * kept in up-rated/accepted outputs — and (b) detector coverage gaps, then
 * proposes a reviewed `.crewhaus/pii-policy.json` the redactor consults
 * additively (`createPiiRedactorWithPolicy`).
 *
 * NEVER prints or writes a raw PII value: output is hashes + counts + kinds
 * only. Needs a stable HMAC secret (`--secret` / `CREWHAUS_PII_HASH_SECRET`)
 * that MATCHES the redactor's secret, or the emitted policy cannot apply at
 * runtime — so a secret is REQUIRED (a random per-run key would be useless).
 */
async function runPiiTune(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus pii tune [--sessions N|all] [--secret <key>] [--write] [--dir <root>] [--json]\n" +
        "\n" +
        "aggregates PII-redaction history (HASHED values, never raw) across sessions:\n" +
        "  false-positive over-redaction candidates (PII kept in accepted outputs)\n" +
        "  detector coverage gaps\n" +
        "and proposes a reviewed .crewhaus/pii-policy.json the redactor reads additively.\n" +
        "\n" +
        "  --sessions N|all  how many recent sessions to scan (default 50)\n" +
        "  --secret <key>    HMAC key (or CREWHAUS_PII_HASH_SECRET) — MUST match the\n" +
        "                    redactor's secret for the policy to apply. Required.\n" +
        "  --write           write the reviewed allow-list to .crewhaus/pii-policy.json\n" +
        "  --dir <root>      harness root that owns .crewhaus/ (default: cwd)\n" +
        "  --json            machine-readable output (hashes + counts only)\n",
    );
    return;
  }

  const secret = strFlag(args, "secret") ?? process.env["CREWHAUS_PII_HASH_SECRET"];
  if (secret === undefined || secret.length === 0) {
    die(
      "pii tune requires a stable HMAC secret (--secret <key> or CREWHAUS_PII_HASH_SECRET) that matches the redactor's secret — a random key would make the emitted policy unusable at runtime",
    );
    return;
  }

  const dirFlag = args.flags["dir"];
  const rootDir = typeof dirFlag === "string" ? resolve(dirFlag) : process.cwd();
  const limit = parseSessionsLimit(args, 50);

  // Read sessions from <rootDir>/.crewhaus/sessions, deriving turns so ratings
  // map to the exact turn they rated (mirrors distill). A rating maps a turn's
  // OUTPUT to accepted/rejected; unrated turns default to not-accepted (an
  // unreviewed output is not evidence of a false positive).
  const sessionsDir = join(rootDir, ".crewhaus", "sessions");
  // Bare-record feedback (the web-UI host writes `.crewhaus/feedback/*.jsonl`).
  const feedbackDirRecords: FeedbackRecord[] = [];
  const feedbackDir = join(rootDir, ".crewhaus", "feedback");
  if (existsSync(feedbackDir)) {
    for (const f of readdirSync(feedbackDir).sort()) {
      if (!f.endsWith(".jsonl")) continue;
      feedbackDirRecords.push(
        ...extractFeedbackRecords(parseAdviseJsonl(readFileSync(join(feedbackDir, f), "utf-8"))),
      );
    }
  }

  const units: ScanUnit[] = [];
  let sessionCount = 0;
  if (existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        file: join(sessionsDir, f),
        id: f.replace(/\.jsonl$/, ""),
        mtimeMs: statSync(join(sessionsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const chosen = limit === "all" ? files : files.slice(0, limit);
    for (const { file, id } of chosen) {
      sessionCount += 1;
      const objects = parseAdviseJsonl(readFileSync(file, "utf-8"));
      // Feedback lives in the session event log too (`user_feedback`); merge it
      // with the bare-record feedback dir, then keep only THIS session's turns.
      const records = mergeFeedback([
        ...extractFeedbackRecords(objects),
        ...feedbackDirRecords.filter((r) => r.sessionId === id),
      ]);
      const acceptedTurns = new Set<number>();
      for (const r of records) {
        if (r.sessionId !== id) continue;
        const score = normalizeRating(r);
        if (score !== undefined && score >= 0.5) acceptedTurns.add(r.turnNumber);
      }
      for (const turn of deriveTurns(objects as { kind?: string; payload?: unknown }[])) {
        if (turn.output === "") continue;
        units.push({ content: turn.output, accepted: acceptedTurns.has(turn.turnNumber) });
      }
    }
  }

  const ctx = buildPiiTuneContext(units, secret);
  const candidates = findFalsePositives(ctx);
  const gaps = findCoverageGaps(ctx);
  const policy = buildPiiPolicy(candidates);

  if (args.flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify({ context: ctx, candidates, gaps, policy }, null, 2)}\n`,
    );
    return;
  }

  process.stdout.write(`pii tune: ${rootDir} (${sessionCount} session(s) scanned)\n`);
  for (const line of renderPiiTuneLines(ctx, candidates, gaps)) process.stdout.write(`  ${line}\n`);

  if (args.flags["write"] === true) {
    const outDir = join(rootDir, ".crewhaus");
    mkdirSync(outDir, { recursive: true });
    const policyPath = join(outDir, "pii-policy.json");
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    process.stdout.write(
      `  [write] ${policy.allow.length} hashed allow entry(ies) → ${policyPath} (review, then the redactor honours it additively; keep the SAME --secret)\n`,
    );
  } else if (candidates.length > 0) {
    process.stdout.write(
      "  (re-run with --write to persist the proposed .crewhaus/pii-policy.json)\n",
    );
  }
}

/**
 * AUTOMATION-OPPORTUNITIES.md item 52 — `crewhaus justification calibrate` +
 * `justification preflight <spec>`.
 *
 * calibrate — replay the intent gate's history: fold durable
 *   `permission_justification_evaluated` records against the per-tool outcome
 *   proxy (session `tool_stats` error rate) to compute allow-agreement + a
 *   false-block estimate, propose a tuned confidence threshold, and flag
 *   high-disagreement tools (allowed but mostly errored).
 *
 * preflight <spec> — dry-run the rule-based judge over the historical
 *   justifications using the spec's `agent.instructions` as the session goal,
 *   reporting the would-be allow/deny split + flips vs the stored verdicts,
 *   BEFORE deploy. Offline + credential-free (the LLM-judge path needs a live
 *   model, which preflight deliberately does not spin up).
 */
async function runJustification(
  args: ParsedArgs,
  action: "calibrate" | "preflight",
): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus justification calibrate [--sessions N|all] [--dir <root>] [--json]\n" +
        "       crewhaus justification preflight [<spec.yaml>] [--goal <text>] [--dir <root>] [--json]\n" +
        "\n" +
        "  calibrate   replay .crewhaus/audit permission_justification_evaluated records\n" +
        "              against the per-tool outcome proxy (tool_stats error rate): allow/\n" +
        "              deny agreement, false-block estimate, a proposed confidence\n" +
        "              threshold, and high-disagreement tools\n" +
        "  preflight   dry-run the rule-based judge over historical justifications using\n" +
        "              the spec's agent.instructions as the session goal, before deploy\n" +
        "\n" +
        "  --sessions N|all  sessions folded for the outcome proxy (default 50)\n" +
        "  --goal <text>     preflight session goal override (else the spec's instructions)\n" +
        "  --dir <root>      harness root that owns .crewhaus/ (default: cwd)\n" +
        "  --json            machine-readable output\n",
    );
    return;
  }

  const dirFlag = args.flags["dir"];
  const rootDir = typeof dirFlag === "string" ? resolve(dirFlag) : process.cwd();

  // Read the durable justification records from .crewhaus/audit.
  const auditDir = join(rootDir, ".crewhaus", "audit");
  const auditObjects: unknown[] = [];
  if (existsSync(auditDir)) {
    for (const f of readdirSync(auditDir).sort()) {
      if (!f.endsWith(".jsonl")) continue;
      auditObjects.push(...parseAdviseJsonl(readFileSync(join(auditDir, f), "utf-8")));
    }
  }
  const records = extractJustificationRecords(auditObjects);

  if (action === "preflight") {
    // Session goal: --goal > the positional spec's agent.instructions > "".
    let goal = strFlag(args, "goal");
    const specArg = args.positional[0];
    if (goal === undefined && specArg !== undefined) {
      const specPath = resolve(rootDir, specArg);
      if (!existsSync(specPath)) die(`spec not found at ${specPath}`);
      try {
        const spec = parseSpec(readFileSync(specPath, "utf-8"));
        const agent = (spec as unknown as Record<string, unknown>)["agent"];
        const instr = (agent as Record<string, unknown> | undefined)?.["instructions"];
        if (typeof instr === "string") goal = instr;
      } catch (err) {
        die(`could not parse ${specPath}: ${(err as Error).message}`);
      }
    }
    const result = await preflightJustification(records, goal ?? "");
    if (args.flags["json"] === true) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(`justification preflight: ${rootDir}\n`);
    if (records.length === 0) {
      process.stdout.write(
        "  no permission_justification_evaluated records in .crewhaus/audit — run the agent (justification audit is on by default), then preflight\n",
      );
    }
    for (const line of renderPreflightLines(result)) process.stdout.write(`  ${line}\n`);
    return;
  }

  // calibrate — fold the per-tool outcome proxy from recent sessions under
  // <rootDir> (read directly so --dir works; readRecentSessionEvents is
  // cwd-bound).
  const limit = parseSessionsLimit(args, 50);
  const sessionsDir = join(rootDir, ".crewhaus", "sessions");
  const sessions: SessionEvents[] = [];
  if (existsSync(sessionsDir)) {
    const ranked = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        file: join(sessionsDir, f),
        id: f.replace(/\.jsonl$/, ""),
        mtimeMs: statSync(join(sessionsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const chosen = limit === "all" ? ranked : ranked.slice(0, limit);
    for (const { file, id } of chosen) {
      sessions.push({ sessionId: id, objects: parseAdviseJsonl(readFileSync(file, "utf-8")) });
    }
  }
  const outcomes = buildToolOutcomes(sessions);
  const result = calibrateJustification(records, outcomes);

  if (args.flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`justification calibrate: ${rootDir}\n`);
  if (records.length === 0) {
    process.stdout.write(
      "  no permission_justification_evaluated records in .crewhaus/audit — run the agent (justification audit is on by default), then calibrate\n",
    );
  }
  for (const line of renderCalibrationLines(result)) process.stdout.write(`  ${line}\n`);
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
/**
 * Item 68 — `crewhaus loadtest <spec> [--concurrency N] [-n requests] [--rps R]`.
 * Drive a daemon-shape harness (managed gateway / channel-bot / batch) under
 * concurrent load and report throughput / p50/p95/p99 latency / error rate /
 * cost per request. `--gate` exits 1 when p95 latency or error rate exceed the
 * declared thresholds (a pre-deploy gate). Load flows through a real driver
 * built here — the managed gateway's in-process `handle()` behind a stub/echo
 * model — so no live server or provider key is needed.
 */
async function runLoadtestCmd(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] === true) {
    process.stdout.write(
      "usage: crewhaus loadtest <spec.yaml> [-c/--concurrency N] [-n/--requests N] [--duration ms]\n" +
        "                         [--rps R] [--format text|html|json] [-o <file>]\n" +
        "                         [--gate --max-p95-ms N --max-error-rate 0.01]\n" +
        "  Drive a daemon-shape harness (managed gateway / channel-bot / batch) under\n" +
        "  concurrent load; report throughput, p50/p95/p99 latency, error rate, and\n" +
        "  cost/req. Load flows through the shape's real entrypoint behind a stub/echo\n" +
        "  model, so no live server or provider key is needed. --gate exits 1 when p95\n" +
        "  latency or error rate exceed the declared thresholds (pre-deploy gate).\n",
    );
    return;
  }
  const format = strFlag(args, "format") ?? "text";
  if (format !== "text" && format !== "html" && format !== "json") {
    die(`--format must be "text", "html", or "json" (got "${format}")`);
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
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }

  // Deterministic stub latency per request (default 5ms) — makes a
  // credential-free run reproducible + fast. The driver returns canned token
  // usage so cost/req is exercised.
  const stubLatencyMs = intFlag(args, "stub-latency-ms") ?? 5;
  const driver = await buildLoadDriver(ir, yamlText, stubLatencyMs);

  const concurrency = intFlag(args, "concurrency");
  const requests = intFlag(args, "requests");
  const duration = intFlag(args, "duration");
  const rps = floatFlag(args, "rps");
  const report = await runLoadtest(driver, {
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(requests !== undefined ? { requests } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(rps !== undefined ? { rps } : {}),
  });

  let verdict: ReturnType<typeof evaluateGate> | undefined;
  if (args.flags["gate"] === true) {
    const thresholds: GateThresholds = {
      ...(intFlag(args, "max-p95-ms") !== undefined
        ? { maxP95LatencyMs: intFlag(args, "max-p95-ms") }
        : {}),
      ...(floatFlag(args, "max-error-rate") !== undefined
        ? { maxErrorRate: floatFlag(args, "max-error-rate") }
        : {}),
    };
    verdict = evaluateGate(report, thresholds);
  }

  const rendered =
    format === "json"
      ? `${JSON.stringify(verdict !== undefined ? { ...report, gate: verdict } : report, null, 2)}\n`
      : format === "html"
        ? renderLoadtestHtml(report, verdict)
        : renderLoadtestText(report, verdict);

  const outPath = strFlag(args, "out");
  if (outPath !== undefined) {
    const abs = resolve(outPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, rendered);
    process.stdout.write(`[loadtest] wrote ${abs}\n`);
  } else {
    process.stdout.write(rendered);
  }
  if (verdict !== undefined && !verdict.passed) process.exit(1);
}

/**
 * Item 68 — build the real LoadDriver for a lowered daemon-shape IR. For
 * `managed` the driver drives the gateway-server's in-process `handle()` with a
 * self-minted JWT + a generous tenant budget behind a stub/echo handler (no
 * live provider). Other daemon shapes (channel/batch) use the same stub/echo
 * driver directly. Non-daemon shapes are rejected. Deterministic:
 * `stubLatencyMs` fixes each request's latency.
 */
async function buildLoadDriver(
  ir: ReturnType<typeof lower>,
  _yamlText: string,
  stubLatencyMs: number,
): Promise<LoadDriver> {
  const DAEMON_TARGETS = new Set(["managed", "channel", "batch"]);
  if (!DAEMON_TARGETS.has(ir.target)) {
    die(
      `loadtest supports daemon shapes (managed, channel, batch); got target: ${ir.target}. Non-daemon shapes have no concurrent request entrypoint to benchmark.`,
    );
  }
  // A stub/echo "run" — canned token usage so cost/req is exercised, and a
  // fixed latency so the run is deterministic + credential-free.
  const stubUsage = { input: 32, output: 16 };
  const echoOutcome = (): RequestOutcome => ({
    ok: true,
    latencyMs: stubLatencyMs,
    tokens: stubUsage,
  });

  if (ir.target === "managed") {
    const { PROTOCOL_VERSION, createGatewayServer, signJwt } = await import(
      "@crewhaus/gateway-server"
    );
    const { buildTenant } = await import("@crewhaus/tenancy");
    const secret = randomBytes(32).toString("hex");
    const tenantId = "loadtest";
    // A generous budget so the benchmark isn't throttled by the budget gate.
    const base = buildTenant(tenantId, {});
    const tenant = {
      ...base,
      budget: { maxInputTokens: Number.MAX_SAFE_INTEGER, maxOutputTokens: Number.MAX_SAFE_INTEGER },
    };
    const server = createGatewayServer({
      jwtSecret: secret,
      handler: async () => {
        // The stub/echo handler stands in for the real run: it returns a canned
        // result WITHOUT a provider call, so the gateway's auth + tenant +
        // budget path is exercised under load, credential-free.
        return { ok: true };
      },
      tenantOverrides: { [tenantId]: tenant },
    });
    const bearer = signJwt({ tenant_id: tenantId }, secret);
    return async (idx: number): Promise<RequestOutcome> => {
      const started = performance.now();
      const res = (await server.handle({
        bearer,
        body: {
          protocol: PROTOCOL_VERSION,
          id: `req-${idx}`,
          method: "runs.create",
          params: { spec: "loadtest-spec", input: `load request ${idx}` },
        },
      })) as { error?: { code?: string; message?: string } };
      await server.recordUsage(tenantId, stubUsage);
      const latencyMs = stubLatencyMs > 0 ? stubLatencyMs : performance.now() - started;
      if (res.error !== undefined) {
        return { ok: false, latencyMs, errorKind: res.error.code ?? "error" };
      }
      return { ok: true, latencyMs, tokens: stubUsage };
    };
  }

  // channel / batch — drive the stub/echo run directly (their real entrypoints
  // are message/queue handlers with no credential-free offline harness here).
  return async (): Promise<RequestOutcome> => echoOutcome();
}

/**
 * Item 67 — `crewhaus intents [--sessions N|all] [--format text|html|json]`.
 * Cluster user_message inputs across the cwd spec's recent sessions and rank
 * them by frequency / satisfaction / failure, surfacing top / rising /
 * low-satisfaction / unmet intents. Rendered examples are PII/secret-redacted.
 */
async function runIntents(args: ParsedArgs): Promise<void> {
  if (args.flags["help"] === true) {
    process.stdout.write(
      "usage: crewhaus intents [--sessions N|all] [--format text|html|json] [-o <file>] [--top N]\n" +
        "  Cluster user questions across .crewhaus/sessions (this harness) and rank\n" +
        "  by frequency, satisfaction (ratings), and failure (errors/loops/retries).\n" +
        "  Surfaces top / rising / low-satisfaction / unmet intents. Rendered\n" +
        "  examples are PII/secret-redacted. Feeds `dataset mine` / `faq distill`.\n",
    );
    return;
  }
  const format = strFlag(args, "format") ?? "text";
  if (format !== "text" && format !== "html" && format !== "json") {
    die(`--format must be "text", "html", or "json" (got "${format}")`);
  }
  const sessionsFlag = strFlag(args, "sessions");
  const limit =
    sessionsFlag === "all"
      ? Number.POSITIVE_INFINITY
      : sessionsFlag !== undefined
        ? (intFlag(args, "sessions") ?? 100)
        : 100;

  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const recent = sessionIdsByRecency(sessionsDir);
  if (recent.length === 0) {
    die(
      `no sessions found under ${sessionsDir} — run the harness (crewhaus run) to accumulate user questions first`,
    );
  }
  const ids = recent.slice(0, Number.isFinite(limit) ? (limit as number) : recent.length);
  // Scan chronologically (oldest→newest) so the `order` ordinal + rising split
  // reflect real recency.
  const chronological = [...ids].reverse();
  const perSession = chronological.map((id) => ({ sessionId: id, events: readSessionEvents(id) }));

  const turns = orderedTurnsFromSessions(perSession, deriveTurns);
  if (turns.length === 0) {
    die("scanned sessions have no user turns to analyze");
  }

  // Feedback (event-log + web-UI sink) across the scanned sessions.
  const feedback: FeedbackRecord[] = [];
  for (const { events } of perSession) feedback.push(...extractFeedbackRecords(events));
  feedback.push(...readFeedbackDir(join(process.cwd(), FEEDBACK_SUBDIR)));

  // Struggle signals per turn — the same negative signals `dataset mine`
  // recognizes (error / tool-error / loop / retry) mark UNMET intents.
  const failedTurnKeys: TurnSignal[] = [];
  for (const { sessionId, events } of perSession) {
    for (const c of mineSession(sessionId, events)) {
      failedTurnKeys.push({ sessionId: c.sessionId, turnNumber: c.turnNumber });
    }
  }

  const topN = intFlag(args, "top");
  const digest = clusterIntents(turns, feedback, failedTurnKeys, {
    ...(topN !== undefined ? { topN } : {}),
  });

  // Redact every rendered example (representative + examples). Build the same
  // detector set `faq`/`dataset synthesize` use.
  const { createPiiRedactor } = await import("@crewhaus/pii-redactor");
  const redactor = createPiiRedactor({ regexDetectors: SYNTHESIZE_PII_DETECTORS });
  const redactCache = new Map<string, string>();
  const redactStrings = new Set<string>();
  for (const list of [
    digest.intents,
    digest.topIntents,
    digest.risingIntents,
    digest.lowSatisfactionIntents,
    digest.unmetIntents,
  ]) {
    for (const i of list) {
      redactStrings.add(i.representative);
      for (const e of i.examples) redactStrings.add(e);
    }
  }
  for (const s of redactStrings) redactCache.set(s, (await redactor.redact(s)).text);
  const redacted = redactDigest(digest, (s) => redactCache.get(s) ?? s);

  const rendered =
    format === "json"
      ? renderIntentsJson(redacted)
      : format === "html"
        ? renderIntentsHtml(redacted)
        : renderIntentsText(redacted);

  const outPath = strFlag(args, "out");
  if (outPath !== undefined) {
    const abs = resolve(outPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, rendered);
    process.stdout.write(`[intents] wrote ${abs}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

// ---------------------------------------------------------------------------
// "Watch me" (design/watch-me.md §11) — `crewhaus watchme <action>` wiring
// ---------------------------------------------------------------------------

const WATCHME_USAGE =
  "usage: crewhaus watchme start [--spec <path>] [--root <dir>]\n" +
  "       crewhaus watchme stop [--forget] [--root <dir>]\n" +
  "       crewhaus watchme status [--json] [--root <dir>]\n" +
  "       crewhaus watchme report [--spec <path>] [--session <id>] [--all] [--json] [--out <dir>]\n" +
  "                [--feed-routing] [--emit-feedback] [--no-model] [--root <dir>]\n" +
  "       crewhaus watchme intents [--all] [--json] [--root <dir>]\n" +
  "       crewhaus watchme synthesize [--spec <path>] [--out <file>] [--name <safeName>]\n" +
  "                [--interactive] [--propose] [--force]\n" +
  "       crewhaus watchme publish [--dry-run]\n" +
  '  Observe this harness\'s agent interactions ("watch me") and learn from them:\n' +
  "  start flips on live capture (+ an immediate deterministic backfill digest),\n" +
  "  report distills watched sessions into quality/continuity/factuality/model-fit\n" +
  "  + counterfactual analysis, intents mines recurring requests, synthesize drafts\n" +
  "  a validated mimic spec (a NEW file — existing specs are never touched), and\n" +
  "  publish shares redacted findings via the wiki/Thredz for co-learning.\n" +
  "  All conclusions are advisory — nothing is ever auto-applied.\n";

/** Global watchme root: `--root` > `CREWHAUS_WATCHME_ROOT` > `~/.crewhaus/watchme`
 *  (the `~/.crewhaus/pricing` precedent). */
function watchmeGlobalRoot(rootFlag: string | undefined): string {
  if (rootFlag !== undefined) return resolve(rootFlag);
  const env = process.env["CREWHAUS_WATCHME_ROOT"];
  if (env !== undefined && env !== "") return resolve(env);
  return join(homedir(), ".crewhaus", "watchme");
}

/**
 * The report/synthesize modules take a SYNC redact seam; this applies the
 * same regex detector set `createPiiRedactor({ regexDetectors:
 * SYNTHESIZE_PII_DETECTORS })` matches (that redactor's API is async-only,
 * which a per-append callback cannot await) with the redactor's
 * `[REDACTED:<kind>]` replace marker.
 */
function watchmeSyncRedactor(): (text: string) => string {
  const detectors = SYNTHESIZE_PII_DETECTORS.map((d) => ({
    kind: d.kind,
    regex: new RegExp(
      d.regex.source,
      d.regex.flags.includes("g") ? d.regex.flags : `${d.regex.flags}g`,
    ),
  }));
  return (text: string): string => {
    let out = text;
    for (const d of detectors) out = out.replace(d.regex, `[REDACTED:${d.kind}]`);
    return out;
  };
}

/** The one-criterion turn-quality rubric the watchme judge phase scores
 *  against (1–5, mapped to [0,1] via the createJudgeGrader convention). */
const WATCHME_JUDGE_RUBRIC: Rubric = {
  criteria: [
    {
      name: "response_quality",
      description:
        "Overall quality of the assistant's reply to the user's request: correct, complete, concise, and on-task.",
      anchors: {
        "1": "Wrong, harmful, or entirely off-task.",
        "2": "Mostly unhelpful — major errors or the request is largely unaddressed.",
        "3": "Adequate — addresses the request with notable gaps or verbosity.",
        "4": "Good — correct and complete with only minor flaws.",
        "5": "Excellent — correct, complete, and concise.",
      },
    },
  ],
  passing_score: 3,
};

/**
 * The phase-2 judge seam (watch-me §7), built on `runChatLoop` exactly like
 * `buildDreamModelPhase`: one bounded single-turn session per sampled turn,
 * the injection-hardened `buildJudgePrompt` reused verbatim (untrusted turn
 * text rides inside per-call sentinel blocks), structured output forced
 * through a `submit_score` tool, spend observed by a cost tracker on the
 * run's own bus (never trusted from model claims), capped by the item-27
 * budget option. `sessionId()` exposes the last judge session so the report
 * driver can scan ITS OWN JSONL for evidence.
 */
function buildWatchmeJudgePhase(
  model: string,
  specName: string,
  crewhausDir: string,
): WatchmeJudgePhase {
  // Judge sessions live in an ISOLATED root the report NEVER enumerates
  // (enumeration is scoped to `<crewhausDir>/sessions`). This keeps judged-turn
  // text and the judge's own model calls out of the watched-harness traffic,
  // so a later report can't re-ingest judge sessions as harness sessions,
  // leak judged-turn input/output into observations, or recursively judge the
  // judge. The report driver scans this same dir for judge-cost evidence.
  const judgeSessionRootDir = join(crewhausDir, "watchme", "judge-sessions");
  let lastSessionId: string | undefined;
  return {
    model,
    sessionId: () => lastSessionId,
    judgeTurn: async (input) => {
      const { system, user } = buildJudgePrompt({
        rubric: WATCHME_JUDGE_RUBRIC,
        input: input.input,
        expectedOutput: undefined,
        agentOutput: input.output,
        // A3 (Wave-2 residue closed) — `submit_score` below now carries the
        // optional `abstain`/`confidence` lane and the report roll-up routes
        // abstained turns to human review, so the abstention instructions
        // are safe to include.
        allowAbstain: true,
      });
      let verdict:
        | { score: number; rationale: string; abstained?: boolean; confidence?: number }
        | undefined;
      const submitScore = buildTool({
        name: "submit_score",
        description: "Submit the structured judgment for this turn. Call exactly once.",
        inputSchema: z.object({
          score: z.number().int().min(1).max(5),
          rationale: z.string().min(1),
          // A3 — abstention + self-reported confidence, mirroring eval-judge's
          // SubmitScoreSchema: optional so a judge that never abstains is
          // unaffected, declared so an abstaining judge is never rejected by
          // the tool schema (which would silently launder the guessed score
          // into an authoritative verdict).
          abstain: z
            .boolean()
            .optional()
            .describe(
              "Set true when the evidence is insufficient to score honestly — abstain instead of guessing. Still fill in every required field.",
            ),
          confidence: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Self-reported confidence in this verdict, 0 (a guess) to 1 (certain)."),
        }),
        readOnly: true,
        destructive: false,
        concurrencySafe: false,
        execute: async ({ score, rationale, abstain, confidence }) => {
          verdict = {
            score: (score - 1) / 4,
            rationale,
            ...(abstain === true ? { abstained: true } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
          };
          return "Judgment recorded. Reply with a one-line confirmation.";
        },
      });
      const runContext = createRunContext();
      lastSessionId = runContext.sessionId;
      const tracker = createCostTracker(runContext.eventBus, { suppressEvents: true });
      try {
        await runChatLoop({
          model,
          instructions: system,
          runContext,
          singleTurn: true,
          seedMessages: [{ role: "user", content: user }],
          sessionName: specName,
          sessionTarget: "watchme",
          sessionRootDir: judgeSessionRootDir,
          tools: [submitScore],
          hooks: [],
          maxToolIterations: 3,
          budget: {
            usdMicros: Math.max(0, Math.round(input.budgetRemainingUsd * 1_000_000)),
            onExceed: { kind: "stop" },
          },
          spinner: false,
        });
        if (verdict === undefined) {
          throw new Error("watchme judge made no submit_score call");
        }
        return {
          score: verdict.score,
          rationale: verdict.rationale,
          spentUsd: tracker.getRunCost(runContext.runId).totalUsdMicros / 1_000_000,
          ...(verdict.abstained === true ? { abstained: true } : {}),
          ...(verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}),
        };
      } finally {
        tracker.unsubscribe();
      }
    },
  };
}

/** The lowered-IR slice the watchme handlers read (every carrier shape —
 *  cli/channel/managed — threads `watchme?: IrWatchme` beside observability). */
type WatchmeIrView = {
  readonly name: string;
  readonly target: string;
  readonly watchme?: {
    readonly enabled: boolean;
    readonly capture: "full" | "mirrors";
    readonly judgeModel: string;
    readonly judgeSampleRate: number;
    readonly judgeBudgetUsd: number;
    readonly scope: "harness" | "user";
    readonly share: boolean;
  };
};

function loadWatchmeIr(args: ParsedArgs): { specPath: string; spec: Spec; ir: WatchmeIrView } {
  const specPath = resolveWatchmeSpecPath(strFlag(args, "spec"), process.cwd());
  const spec = parseSpec(readFileSync(specPath, "utf-8"));
  return { specPath, spec, ir: lower(spec) as unknown as WatchmeIrView };
}

/** Sessions of one harness dir, oldest→newest (the intents `order` contract),
 *  as the `{ sessionId, events }` rows the intents/turn helpers take. */
function watchmeSessionRows(
  sessionsDir: string,
): Array<{ sessionId: string; events: Array<{ kind?: string; payload?: unknown }> }> {
  const rows: Array<{ sessionId: string; events: Array<{ kind?: string; payload?: unknown }> }> =
    [];
  for (const id of [...sessionIdsByRecency(sessionsDir)].reverse()) {
    const file = join(sessionsDir, `${id}.jsonl`);
    if (!existsSync(file)) continue;
    rows.push({
      sessionId: id,
      events: parseJsonlObjects(readFileSync(file, "utf-8")) as Array<{
        kind?: string;
        payload?: unknown;
      }>,
    });
  }
  return rows;
}

/** One-harness phase-1(+2) report with the real seams wired (watch-me §11). */
async function runWatchmeHarnessReport(opts: {
  readonly ir: WatchmeIrView;
  readonly crewhausDir: string;
  readonly sessionId?: string;
  readonly outDir?: string;
  readonly feedRouting?: boolean;
  readonly emitFeedback?: boolean;
  readonly noModel?: boolean;
}): Promise<WatchmeReportResult> {
  const judge =
    opts.ir.watchme !== undefined
      ? {
          model: opts.ir.watchme.judgeModel,
          sampleRate: opts.ir.watchme.judgeSampleRate,
          budgetUsd: opts.ir.watchme.judgeBudgetUsd,
        }
      : undefined;
  const deps: WatchmeReportDeps = {
    fs: nodeReportFs,
    now: Date.now,
    store: openWatchmeStore(opts.crewhausDir, { specName: opts.ir.name }),
    deriveTurns,
    clusterIntents,
    orderedTurnsFromSessions,
    redactDigest,
    redact: watchmeSyncRedactor(),
    graderRegistry: () => defaultGraderRegistry(),
    openScoreboard,
    pricing: loadUserPricing(),
    capabilities: DEFAULT_CAPABILITIES,
    joinQualityToArms,
    ...(judge !== undefined && judge.budgetUsd > 0 && opts.noModel !== true
      ? { judgePhase: buildWatchmeJudgePhase(judge.model, opts.ir.name, opts.crewhausDir) }
      : {}),
    warn: (message) => process.stderr.write(`[watchme] ${message}\n`),
  };
  return await runWatchmeReport(
    {
      crewhausDir: opts.crewhausDir,
      specName: opts.ir.name,
      target: opts.ir.target,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.outDir !== undefined ? { outDir: opts.outDir } : {}),
      ...(opts.feedRouting === true ? { feedRouting: true } : {}),
      ...(opts.emitFeedback === true ? { emitFeedback: true } : {}),
      ...(opts.noModel === true ? { noModel: true } : {}),
      ...(judge !== undefined ? { judge } : {}),
    },
    deps,
  );
}

/** The co-learning article slugs `watchme publish` upserts and `report --all`
 *  recalls from peers (watch-me §11). */
const WATCHME_ARTICLE_SLUGS = ["watchme-intents", "watchme-model-fit", "watchme-pitfalls"] as const;

type WatchmeArticle = {
  readonly slug: (typeof WATCHME_ARTICLE_SLUGS)[number];
  readonly title: string;
  readonly body: string;
  /** Evidence-count confidence signal (sessions observed, saturating at 25). */
  readonly confidence: number;
};

/** Distill the long-horizon store into the three co-learning articles. All
 *  text rides observation fields that were redacted BEFORE append; the sync
 *  redactor runs over the rendered bodies again as belt-and-braces. Throws
 *  {@link WatchmeError} when there is nothing to publish yet. */
function buildWatchmeArticles(
  store: ReturnType<typeof openWatchmeStore>,
  specName: string,
): WatchmeArticle[] {
  const observations = store.readObservations();
  const aggregates = store.readAggregates();
  const sessions = observations.length + aggregates.reduce((acc, a) => acc + a.n, 0);
  if (sessions === 0) {
    throw new WatchmeError(
      "no watchme observations to publish — run `crewhaus watchme report` first",
    );
  }
  const redact = watchmeSyncRedactor();
  const confidence = Math.min(1, sessions / 25);
  const advisory = "\n\n_Advisory — distilled from watched sessions; never auto-applied._\n";

  const intentCounts = new Map<string, number>();
  for (const obs of observations) {
    for (const key of obs.intentKeys) intentCounts.set(key, (intentCounts.get(key) ?? 0) + 1);
  }
  for (const agg of aggregates) {
    for (const [key, n] of Object.entries(agg.intents)) {
      intentCounts.set(key, (intentCounts.get(key) ?? 0) + n);
    }
  }
  const topIntents = [...intentCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10);

  const modelFold = new Map<string, { turns: number; costUsdMicros: number; unpriced: boolean }>();
  for (const obs of observations) {
    for (const m of obs.models) {
      const key = m.spec ?? m.wire;
      const entry = modelFold.get(key) ?? { turns: 0, costUsdMicros: 0, unpriced: false };
      entry.turns += m.turns;
      entry.costUsdMicros += m.costUsdMicros ?? 0;
      if (m.unpriced === true) entry.unpriced = true;
      modelFold.set(key, entry);
    }
  }

  let toolCalls = 0;
  let toolErrors = 0;
  let downs = 0;
  let breachSessions = 0;
  for (const obs of observations) {
    for (const t of obs.toolStats) {
      toolCalls += t.calls;
      toolErrors += t.errors;
    }
    downs += obs.feedback?.down ?? 0;
    if (
      obs.continuity !== undefined &&
      Object.values(obs.continuity).some((c) => c.passed === false)
    ) {
      breachSessions += 1;
    }
  }
  for (const agg of aggregates) {
    toolCalls += agg.toolCalls;
    toolErrors += agg.toolErrors;
    downs += agg.feedbackDown;
  }

  const intentsBody = [
    `Recurring intents observed across ${sessions} session(s) of ${specName}:`,
    "",
    ...(topIntents.length > 0
      ? topIntents.map(([key, n]) => `- ${key} — ${n}×`)
      : ["- (no intent clusters yet)"]),
  ].join("\n");
  const modelFitBody = [
    `Model usage observed across ${sessions} session(s) of ${specName}:`,
    "",
    ...[...modelFold.entries()]
      .sort((a, b) => b[1].turns - a[1].turns || a[0].localeCompare(b[0]))
      .map(
        ([model, e]) =>
          `- ${model}: ${e.turns} turn(s), cost ${
            e.unpriced ? "UNKNOWN (unpriced)" : `$${(e.costUsdMicros / 1_000_000).toFixed(4)}`
          }`,
      ),
    "",
    "Verify any downshift with `crewhaus model right-size` — the roster is never patched automatically.",
  ].join("\n");
  const pitfallsBody = [
    `Recurring failure patterns across ${sessions} session(s) of ${specName}:`,
    "",
    `- tool errors: ${toolErrors}/${toolCalls} call(s)`,
    `- thumbs-down ratings: ${downs}`,
    `- sessions with a continuity-metric breach: ${breachSessions}`,
  ].join("\n");

  return [
    {
      slug: "watchme-intents",
      title: `watchme: recurring intents (${specName})`,
      body: redact(`${intentsBody}${advisory}`),
      confidence,
    },
    {
      slug: "watchme-model-fit",
      title: `watchme: model fit (${specName})`,
      body: redact(`${modelFitBody}${advisory}`),
      confidence,
    },
    {
      slug: "watchme-pitfalls",
      title: `watchme: pitfalls (${specName})`,
      body: redact(`${pitfallsBody}${advisory}`),
      confidence,
    },
  ];
}

/**
 * `crewhaus watchme publish` — versioned upserts of the three articles into
 * the harness's LOCAL per-spec wiki store (`.crewhaus/wiki`, the same substrate
 * the memory fabric writes). This is LOCAL co-learning in v1: `report --all`
 * recalls these articles from opted-in peers via the SAME-MACHINE harness
 * registry (`~/.crewhaus/watchme`). Cross-machine, Thredz-backed publish/recall
 * is a DEFERRED seam (design/watch-me.md §10) — no Thredz wire exists here yet.
 * Degrade-never-halt: any store failure is one warning, never a non-zero exit —
 * the local digest store stays authoritative.
 */
async function publishWatchmeArticles(opts: {
  readonly specName: string;
  readonly crewhausDir: string;
  readonly dryRun: boolean;
}): Promise<void> {
  const store = openWatchmeStore(opts.crewhausDir, { specName: opts.specName });
  const articles = buildWatchmeArticles(store, opts.specName);
  if (opts.dryRun) {
    for (const a of articles) {
      process.stdout.write(`[watchme] would publish ${a.slug} — ${a.title}\n${a.body}\n\n`);
    }
    return;
  }
  try {
    const wiki = createWikiStore({
      specName: opts.specName,
      rootDir: join(process.cwd(), WIKI_SUBDIR),
    });
    for (const a of articles) {
      const write = async (): Promise<void> => {
        const existing = await wiki.get(a.slug);
        await wiki.write({
          slug: a.slug,
          title: a.title,
          body: a.body,
          tags: ["watchme"],
          ...(existing !== null ? { expectedVersion: existing.version } : {}),
        });
        await wiki.setSignals(a.slug, { confidence: a.confidence });
      };
      try {
        await write();
      } catch (err) {
        // Concurrent writer bumped the version between read and write —
        // re-read and reapply once (the wiki-store contract).
        if (err instanceof WikiVersionConflictError) await write();
        else throw err;
      }
      process.stdout.write(`[watchme] published ${a.slug}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `[watchme] publish degraded: ${(err as Error).message} (local watchme store still authoritative)\n`,
    );
  }
}

/** `crewhaus watchme <action>` — dispatch behind the §11 action allowlist. */
async function runWatchme(args: ParsedArgs, action: string): Promise<void> {
  if (action === "" || args.flags["help"] === true) {
    process.stdout.write(WATCHME_USAGE);
    return;
  }
  const cwd = process.cwd();
  const crewhausDir = join(cwd, ".crewhaus");
  const globalRoot = watchmeGlobalRoot(strFlag(args, "root"));

  switch (action) {
    case "start": {
      const { ir } = loadWatchmeIr(args);
      const store = openWatchmeStore(crewhausDir, { specName: ir.name });
      const registry = openHarnessRegistry(globalRoot);
      const capture = ir.watchme?.capture ?? "full";
      const result = await watchmeStart({
        store,
        registry,
        harness: {
          dir: cwd,
          specName: ir.name,
          target: ir.target,
          share: ir.watchme?.share === true,
        },
        runBackfill: () => runWatchmeHarnessReport({ ir, crewhausDir, noModel: true }),
      });
      process.stdout.write(
        `[watchme] ${result.alreadyWatching ? "already watching" : "watching"} ${ir.name} (capture: ${capture})\n`,
      );
      if (ir.watchme === undefined) {
        process.stdout.write(
          "[watchme] make it durable across machines — add to the spec: watchme: { enabled: true }\n",
        );
      }
      const backfill = result.backfill;
      if (backfill.outcome === "written" && backfill.outDir !== undefined) {
        process.stdout.write(`[watchme] backfill report ${backfill.outDir}\n`);
      } else if (backfill.outcome === "no-sessions") {
        process.stdout.write(
          "[watchme] backfill: no sessions yet — the next `crewhaus run` is captured live\n",
        );
      } else {
        process.stdout.write("[watchme] backfill skipped: another report holds the lock\n");
      }
      return;
    }
    case "stop": {
      const store = openWatchmeStore(crewhausDir);
      const registry = openHarnessRegistry(globalRoot);
      const result = watchmeStop({
        store,
        registry,
        harnessDir: cwd,
        ...(args.flags["forget"] === true ? { forget: true } : {}),
      });
      process.stdout.write(
        `[watchme] ${result.wasWatching ? "stopped watching" : "was not watching"} (data kept${result.forgotten ? "; deregistered" : ""})\n`,
      );
      return;
    }
    case "status": {
      const store = openWatchmeStore(crewhausDir);
      const registry = openHarnessRegistry(globalRoot);
      let sessionFiles: string[] = [];
      try {
        sessionFiles = readdirSync(join(cwd, SESSIONS_SUBDIR));
      } catch {
        sessionFiles = [];
      }
      const summary = watchmeStatus({ store, registry, sessionFiles });
      process.stdout.write(
        args.flags["json"] === true
          ? `${JSON.stringify(summary, null, 2)}\n`
          : `${formatWatchmeStatus(summary)}\n`,
      );
      return;
    }
    case "report": {
      const outFlag = strFlag(args, "out");
      if (args.flags["all"] === true) {
        const registry = openHarnessRegistry(globalRoot);
        const entries = registry.list();
        if (entries.length === 0) {
          die(
            "no registered harnesses — run `crewhaus watchme start` in a harness first (or pass the --root that holds the registry)",
          );
        }
        const outDir =
          outFlag !== undefined
            ? resolve(outFlag)
            : join(
                crewhausDir,
                "watchme",
                "reports",
                new Date().toISOString().replace(/[:.]/g, "-"),
              );
        const readHarness = (entry: HarnessEntry): HarnessSlice | undefined => {
          const dir = join(entry.dir, ".crewhaus");
          if (!existsSync(dir)) return undefined;
          const s = openWatchmeStore(dir, { specName: entry.specName });
          return {
            entry,
            observations: s.readObservations(),
            aggregates: s.readAggregates(),
            judgments: s.readJudgments(),
          };
        };
        const recallSharedFindings = async (): Promise<ReadonlyArray<SharedWatchmeFinding>> => {
          const findings: SharedWatchmeFinding[] = [];
          for (const entry of entries) {
            if (resolve(entry.dir) === cwd) continue; // peers only
            if (entry.share !== true) continue; // opt-in only (watchme.share)
            const wikiRoot = join(entry.dir, WIKI_SUBDIR);
            if (!existsSync(wikiRoot)) continue;
            const wiki = createWikiStore({ specName: entry.specName, rootDir: wikiRoot });
            for (const slug of WATCHME_ARTICLE_SLUGS) {
              const article = await wiki.get(slug);
              if (article === null) continue;
              findings.push({
                agentName: entry.specName,
                slug,
                title: article.title,
                excerpt: article.body.split("\n").find((l) => l.trim() !== "") ?? "",
                confidence: article.confidence,
              });
            }
          }
          return findings;
        };
        const { report, files } = await runWatchmeAllReport(
          { harnesses: entries, outDir },
          {
            fs: nodeReportFs,
            now: Date.now,
            redact: watchmeSyncRedactor(),
            readHarness,
            recallSharedFindings,
            warn: (message) => process.stderr.write(`[watchme] ${message}\n`),
          },
        );
        if (args.flags["json"] === true) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          for (const f of files) process.stdout.write(`[watchme] wrote ${f}\n`);
        }
        return;
      }
      const { ir } = loadWatchmeIr(args);
      const sessionFlag = strFlag(args, "session");
      const result = await runWatchmeHarnessReport({
        ir,
        crewhausDir,
        ...(sessionFlag !== undefined ? { sessionId: sessionFlag } : {}),
        ...(outFlag !== undefined ? { outDir: resolve(outFlag) } : {}),
        ...(args.flags["feed-routing"] === true ? { feedRouting: true } : {}),
        ...(args.flags["emit-feedback"] === true ? { emitFeedback: true } : {}),
        ...(args.flags["no-model"] === true ? { noModel: true } : {}),
      });
      if (result.outcome === "no-sessions") {
        die("no sessions to analyze — run the harness first");
      }
      if (result.outcome === "locked") {
        die("another watchme report holds the run.lock — retry shortly");
      }
      if (ir.watchme?.share === true) {
        // Spec-declared co-learning: publish the refreshed digest at report
        // time (degrade-never-halt inside).
        await publishWatchmeArticles({ specName: ir.name, crewhausDir, dryRun: false });
      }
      if (args.flags["json"] === true) {
        process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
      } else {
        for (const f of result.files) process.stdout.write(`[watchme] wrote ${f}\n`);
      }
      return;
    }
    case "intents": {
      const perSession: Array<{
        sessionId: string;
        events: Array<{ kind?: string; payload?: unknown }>;
      }> = [];
      // Rows kept per harness so the --all digest can be harness-tagged
      // (design/watch-me.md §1(b)): the combined clusters answer "what do I
      // keep asking", the per-harness section answers "which agent gets asked
      // what".
      const perHarness: Array<{
        specName: string;
        dir: string;
        rows: typeof perSession;
      }> = [];
      if (args.flags["all"] === true) {
        for (const entry of openHarnessRegistry(globalRoot).list()) {
          const rows = watchmeSessionRows(join(entry.dir, SESSIONS_SUBDIR));
          perHarness.push({ specName: entry.specName, dir: entry.dir, rows });
          perSession.push(...rows);
        }
      } else {
        perSession.push(...watchmeSessionRows(join(cwd, SESSIONS_SUBDIR)));
      }
      if (perSession.length === 0) die("no sessions to analyze — run the harness first");
      const turns = orderedTurnsFromSessions(perSession, deriveTurns);
      if (turns.length === 0) die("scanned sessions have no user turns to analyze");
      const feedback: FeedbackRecord[] = [];
      const failedTurnKeys: TurnSignal[] = [];
      for (const { sessionId, events } of perSession) {
        feedback.push(...extractFeedbackRecords(events));
        for (const c of mineSession(sessionId, events)) {
          failedTurnKeys.push({ sessionId: c.sessionId, turnNumber: c.turnNumber });
        }
      }
      const redactor = watchmeSyncRedactor();
      const digest = redactDigest(clusterIntents(turns, feedback, failedTurnKeys), redactor);
      if (args.flags["all"] === true) {
        const harnesses = perHarness.map((h) => {
          const hTurns = orderedTurnsFromSessions(h.rows, deriveTurns);
          const hFeedback: FeedbackRecord[] = [];
          const hFailed: TurnSignal[] = [];
          for (const { sessionId, events } of h.rows) {
            hFeedback.push(...extractFeedbackRecords(events));
            for (const c of mineSession(sessionId, events)) {
              hFailed.push({ sessionId: c.sessionId, turnNumber: c.turnNumber });
            }
          }
          const hDigest =
            hTurns.length === 0
              ? undefined
              : redactDigest(clusterIntents(hTurns, hFeedback, hFailed), redactor);
          return {
            specName: h.specName,
            dir: h.dir,
            turns: hDigest?.totalTurns ?? 0,
            sessions: hDigest?.totalSessions ?? 0,
            topIntents: (hDigest?.topIntents ?? []).slice(0, 3).map((i) => i.representative),
          };
        });
        if (args.flags["json"] === true) {
          process.stdout.write(`${JSON.stringify({ ...digest, harnesses }, null, 2)}\n`);
        } else {
          const lines = [renderIntentsText(digest).trimEnd(), "", "PER-HARNESS"];
          if (harnesses.length === 0) lines.push("  (none registered)");
          for (const h of harnesses) {
            lines.push(
              `  - ${h.specName} — ${h.turns} turn(s) across ${h.sessions} session(s) (${h.dir})`,
            );
            for (const rep of h.topIntents) lines.push(`      · ${rep}`);
          }
          process.stdout.write(`${lines.join("\n")}\n`);
        }
        return;
      }
      process.stdout.write(
        args.flags["json"] === true ? renderIntentsJson(digest) : renderIntentsText(digest),
      );
      return;
    }
    case "synthesize": {
      if (args.flags["interactive"] === true) {
        // Reserved flag (watch-me §11 negative space): the digest-seeded
        // interview needs an init-conversation seeding seam that has not
        // landed; the flag dies loudly instead of silently not existing.
        die("watchme synthesize --interactive is not yet implemented; see design/watch-me.md §7");
      }
      const { ir, spec } = loadWatchmeIr(args);
      const store = openWatchmeStore(crewhausDir, { specName: ir.name });
      const observations = store.readObservations();
      if (observations.length === 0) {
        die("no watchme observations to synthesize from — run `crewhaus watchme report` first");
      }
      const perSession = watchmeSessionRows(join(cwd, SESSIONS_SUBDIR));
      const turns = orderedTurnsFromSessions(perSession, deriveTurns);
      const feedback: FeedbackRecord[] = [];
      const failedTurnKeys: TurnSignal[] = [];
      for (const { sessionId, events } of perSession) {
        feedback.push(...extractFeedbackRecords(events));
        for (const c of mineSession(sessionId, events)) {
          failedTurnKeys.push({ sessionId: c.sessionId, turnNumber: c.turnNumber });
        }
      }
      const digest = clusterIntents(turns, feedback, failedTurnKeys);
      const pricing = loadUserPricing();
      const anyTools = observations.some((o) => o.toolStats.length > 0);
      const counterfactualModels = buildCounterfactuals({
        models: observations.flatMap((o) => o.models),
        require: anyTools ? { tool_use: true } : {},
        pricing,
        capabilities: DEFAULT_CAPABILITIES,
        arms: openScoreboard(crewhausDir).snapshot(),
        turnQuality: [],
      }).map((row) => ({
        model: row.candidate,
        estCostUsdMicrosPerTurn: row.effectiveTurnCostMicros,
      }));
      const name = strFlag(args, "name") ?? `${ir.name}-mimic`;
      const mcpServers = (spec as { mcp_servers?: Record<string, unknown> }).mcp_servers;
      const outFlag = strFlag(args, "out");
      const outPath =
        outFlag !== undefined
          ? resolve(outFlag)
          : join(crewhausDir, "watchme", "synthesized", `${name}.yaml`);
      const result = await runWatchmeSynthesize(
        {
          name,
          observations,
          intents: digest,
          counterfactualModels,
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          redact: watchmeSyncRedactor(),
        },
        {
          rootDir: cwd,
          fs: {
            exists: existsSync,
            mkdirp: (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
            write: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
          },
          ...(outFlag !== undefined ? { outFile: outPath } : {}),
          ...(args.flags["force"] === true ? { force: true } : {}),
          ...(args.flags["propose"] === true
            ? {
                propose: (o: {
                  specName: string;
                  currentYaml: string;
                  proposedYaml: string;
                  source: "watchme";
                }): void => {
                  const assembled = assembleProposal({
                    specName: o.specName,
                    currentYaml: o.currentYaml,
                    proposedYaml: o.proposedYaml,
                    source: o.source,
                    proposedVersion: "0.1.0",
                  });
                  const patchPath = `${outPath}.patch.json`;
                  writeFileSync(patchPath, assembled.patchJson, { mode: 0o600 });
                  process.stdout.write(
                    `[watchme] proposal bundle ${patchPath} — open the review PR with \`crewhaus propose ${outPath}\`\n`,
                  );
                },
              }
            : {}),
        },
      );
      process.stdout.write(result.summary);
      return;
    }
    case "publish": {
      const { ir } = loadWatchmeIr(args);
      await publishWatchmeArticles({
        specName: ir.name,
        crewhausDir,
        dryRun: args.flags["dry-run"] === true,
      });
      return;
    }
    default:
      // Unreachable — the dispatch allowlist rejects unknown actions first.
      die(`unknown watchme action "${action}"`);
  }
}

/**
 * Item 66 — `crewhaus onchain tune|sentinel`. Reads the spec's current
 * transaction_policy from its lowered IR (for tune's baseline + whitelisting)
 * and a receipt-history JSONL, then either proposes a tuned policy (`tune`,
 * writing a validated SpecPatch when the target whitelists transaction_policy)
 * or flags anomalous spend vs a learned baseline (`sentinel`). Private keys /
 * keyRefs never leave the spec — receipts carry only public tx metadata.
 */
async function runOnchain(args: ParsedArgs, action: "tune" | "sentinel"): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus onchain tune <spec.yaml> [--history <receipts.jsonl>] [--cap-margin 1.25] [-o <patch.json>]\n" +
        "       crewhaus onchain sentinel <spec.yaml> [--history <candidate.jsonl>] [--baseline <baseline.jsonl>] [--max-multiple 2]\n" +
        "\n" +
        "  tune     — mine successful wallet-engine receipts to propose a\n" +
        "             transaction_policy (maxValueWei from observed spend + margin,\n" +
        "             allowedContracts from used ids). When the spec target\n" +
        "             whitelists transaction_policy (onchain / onchain-game), a\n" +
        "             validated SpecPatch is written for `optimize --write-back`;\n" +
        "             otherwise the proposal is advice-only.\n" +
        "  sentinel — flag anomalous spend (unknown contract id, or > N× the\n" +
        "             per-contract observed max) against a learned baseline. Without\n" +
        "             --baseline, self-compares --history using a leave-one-out\n" +
        "             per-contract max so a lone spike is still caught.\n" +
        "  --history defaults to .crewhaus/onchain/receipts.jsonl. No private keys\n" +
        "  are ever read — receipts carry only contractId + wei value + status.\n",
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
    if (err instanceof CrewhausError) die(err.message);
    throw err;
  }

  // Read the current transaction_policy off the lowered IR (onchain /
  // onchain-game carry it directly; other shapes may carry it optionally).
  const irPolicy = (ir as { transactionPolicy?: unknown }).transactionPolicy as
    | {
        maxValueWei?: string;
        allowedContracts?: readonly string[];
        simulationRequired?: boolean;
      }
    | undefined;
  const current: CurrentPolicy = {
    ...(irPolicy?.maxValueWei !== undefined ? { maxValueWei: irPolicy.maxValueWei } : {}),
    ...(irPolicy?.allowedContracts !== undefined
      ? { allowedContracts: irPolicy.allowedContracts }
      : {}),
    ...(irPolicy?.simulationRequired !== undefined
      ? { simulationRequired: irPolicy.simulationRequired }
      : {}),
  };
  // transaction_policy is optimizer-whitelisted only for the §47 onchain shapes.
  const optimizable = ir.target === "onchain" || ir.target === "onchain-game";

  const historyPath = resolve(
    strFlag(args, "history") ?? join(".crewhaus", "onchain", "receipts.jsonl"),
  );
  if (!existsSync(historyPath)) {
    die(
      `receipt history not found at ${historyPath} — record wallet-engine receipts there (one JSON per line), or pass --history`,
    );
  }
  const historyReceipts = parseReceiptHistory(readFileSync(historyPath, "utf-8"));

  if (action === "tune") {
    const capMargin = floatFlag(args, "cap-margin");
    const proposal = proposePolicy(historyReceipts, current, {
      optimizable,
      target: ir.target,
      ...(capMargin !== undefined ? { capMarginPct: capMargin } : {}),
    });
    if (args.flags["json"] === true) {
      process.stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
    } else {
      process.stdout.write(renderTuneReport(proposal));
    }
    if (proposal.patch !== undefined) {
      // Pick the SpecPatch op from the SAME parsed-CST existence check
      // applySpecPatch itself uses (`doc.hasIn(path)` on the `yaml` package's
      // parseDocument), not a second raw-text regex — a regex can disagree
      // with the parsed check (e.g. `transaction_policy:` appearing only in a
      // comment or inside a flow-context string), which would pick the wrong
      // op and get the patch rejected by applySpecPatch's own existence
      // check. Re-parsing here keeps the two checks structurally identical.
      const hasBlock = parseDocument(yamlText).hasIn(proposal.patch.path);
      const specPatch = {
        target: proposal.patch.target,
        path: proposal.patch.path,
        op: hasBlock ? ("replace" as const) : ("add" as const),
        value: proposal.patch.value,
        rationale: proposal.patch.rationale,
      };
      const outPath = resolve(
        strFlag(args, "out") ?? join(".crewhaus", "onchain", "policy-patch.json"),
      );
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(specPatch, null, 2)}\n`);
      process.stdout.write(`[onchain] wrote transaction_policy patch → ${outPath}\n`);
    }
    return;
  }

  // action === "sentinel"
  const baselinePath = strFlag(args, "baseline");
  const maxMultiple = intFlag(args, "max-multiple");
  let anomalies: SpendAnomaly[];
  if (baselinePath !== undefined) {
    const absBaseline = resolve(baselinePath);
    if (!existsSync(absBaseline)) die(`baseline history not found at ${absBaseline}`);
    const baselineReceipts = parseReceiptHistory(readFileSync(absBaseline, "utf-8"));
    const candidateReceipts = historyReceipts; // --history is the candidate window
    const baseline = learnSpendBaseline(baselineReceipts);
    anomalies = detectAnomalies(candidateReceipts, baseline, {
      ...(maxMultiple !== undefined ? { maxMultiple } : {}),
    });
  } else {
    // No --baseline: self-compare mode. Learning the baseline from — and then
    // diffing against — the SAME history self-masks a value spike (its own
    // value would be folded into its contract's baseline max, so it could
    // never exceed maxMultiple × itself). Leave-one-out fixes this: each
    // receipt's ceiling excludes its own value from the per-contract max.
    anomalies = detectAnomaliesSelfCompare(historyReceipts, {
      ...(maxMultiple !== undefined ? { maxMultiple } : {}),
    });
  }
  if (args.flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify(
        anomalies.map((a) => ({ ...a, valueWei: a.valueWei.toString() })),
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(renderSentinelReport(anomalies));
  }
  if (anomalies.length > 0) process.exit(1);
}

async function runChannel(args: ParsedArgs, action: "provision" | "verify"): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus channel provision <spec.yaml> --base-url <public-url>\n" +
        "                                  [--platform slack|telegram|discord|all] [-o <dir>]\n" +
        "                                  [--dry-run] [--force]\n" +
        "       crewhaus channel verify <spec.yaml> [--platform slack|telegram|discord|all]\n" +
        "                                  [--base-url <public-url>] [--dry-run] [--offline]\n" +
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
        "  verify — ✓/~/✗ per check, exit 1 on hard failures, in two phases:\n" +
        "    boot gate every secret env-ref the compiled daemon refuses to start\n" +
        "              without (all configured channels, including whatsapp/imessage,\n" +
        "              plus the agent model's provider credentials) — no network\n" +
        "    probes    slack auth.test + granted scopes (x-oauth-scopes) vs the needed\n" +
        "              set; telegram getWebhookInfo url / allowed_updates / pending /\n" +
        "              last error; discord applications/@me id / verify_key /\n" +
        "              interactions endpoint. Skipped for a channel whose boot gate\n" +
        "              already failed — an unbootable daemon cannot be wired.\n" +
        "  --platform  narrow to one channel (default `all` = every configured one).\n" +
        "              On verify it narrows the boot gate too: `--platform slack` will\n" +
        "              not fail on another channel's unset env or on model credentials\n" +
        "  --base-url  the daemon's publicly reachable origin (required for provision;\n" +
        "              on verify it upgrades the webhook-URL checks from ~ to ✓/✗)\n" +
        "  --offline   verify only: run the boot gate and stop. No platform call, so\n" +
        "              the exit code depends on the environment alone — usable as a\n" +
        "              deterministic pre-flight in CI or a recording\n" +
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
  // whatsapp/imessage have no platform-side flow to drive or probe. `verify`
  // still gates on their boot-time env refs below (see the boot-gate phase),
  // so the note must not read as "nothing here is checked".
  for (const p of selection.unsupported) {
    process.stdout.write(
      action === "verify"
        ? `note: channels.${p} has no platform-side probe (its config lives off-platform) — only its boot-gate env refs are checked\n`
        : `note: channels.${p} is configured but \`channel ${action}\` does not support it yet (slack|telegram|discord)\n`,
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

    // Validate EVERY selected platform's env before the first side effect.
    // Provision writes the Slack manifest into `-o` (default: the cwd) and
    // calls two live APIs; validating lazily inside the loop meant a spec
    // with only Slack credentials left a stray slack-app-manifest.yaml in
    // the operator's repo and then exited 1 on Telegram.
    if (!dryRun) {
      const missing = collectProvisionMissingEnv(
        selection.platforms,
        ir.channels,
        baseUrl,
        process.env,
      );
      if (missing.length > 0) {
        const byPlatform = [...new Set(missing.map((m) => m.platform))].join(", ");
        die(
          `channel provision (${byPlatform}): unset env: ${missing
            .map((m) => `${m.label} → $${m.envName}`)
            .join(", ")} — export them, or narrow with --platform <${CHANNEL_PLATFORMS.join(
            "|",
          )}>, or use --dry-run to print the calls (nothing was written or called)`,
        );
      }
    }

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
  const offline = args.flags["offline"] === true;
  if (offline && dryRun) {
    die(
      "--dry-run and --offline are mutually exclusive: --dry-run prints the platform calls verify WOULD make, --offline runs the boot-gate checks and makes none",
    );
  }
  process.stdout.write(
    `channel verify: ${ir.name} (${selection.platforms.join(", ")})${
      dryRun ? " (dry run)" : offline ? " (offline)" : ""
    }\n`,
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
    ...(offline ? { offline } : {}),
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
  // Boot-gate coverage for the channels with no platform probe, and for the
  // agent model's provider credentials — the daemon exits 2 on any of them,
  // so leaving them out let `verify` go green on a bot that cannot start.
  // Narrowing with --platform narrows the whole verdict to that platform;
  // the default (`all`) means all, so it covers these too.
  if (platformFlag === undefined || platformFlag === "all") {
    for (const platform of selection.unsupported) {
      checks.push(...channelEnvChecks(platform, ir.channels, process.env));
    }
    checks.push(...modelCredentialChecks(ir.agent.model, process.env));
  }
  const summary = summarizeChannelChecks(checks, { offline });
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
  case "lint":
    // Item 41 — parse/lower/ir-pass failures all extend CrewhausError; the
    // lint pipeline collects them as findings rather than throwing, so a raw
    // throw here is a genuine bug and should surface with its stack.
    await runLintCommand(parseFor(rest, LINT_SCHEMA));
    break;
  case "init": {
    const initArgs = parseFor(rest, INIT_SCHEMA);
    // Item 39 — `--interactive` is an async path (model interview or scripted
    // stdin questionnaire), so it dispatches to its own handler; the plain
    // `init [name]` scaffold stays the synchronous default, unchanged.
    if (initArgs.flags["interactive"] === true) {
      try {
        await runInitInteractive(initArgs);
      } catch (err) {
        if (err instanceof CrewhausError) die(err.message);
        throw err;
      }
    } else {
      runInit(initArgs);
    }
    break;
  }
  case "run":
    // Mirror runCompile's policy: every structured failure in the run
    // pipeline (ConfigError from the model-router, ProviderAuthError from
    // an adapter, RuntimeError, …) extends CrewhausError — route the
    // family through die(), which prints the classic one-liner + exit 1
    // for most of them and (v0.3.0 Goal 6) the full structured report +
    // coded exit for a RunFailedError. A non-CrewhausError (a genuine
    // bug) still propagates with its full stack for debugging.
    try {
      await runRun(parseFor(rest, RUN_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err);
      throw err;
    }
    break;
  case "runs": {
    // Loop contract 0.4 (Batch F, item 7, CLI half) — `runs resume <session>`
    // re-drives a persisted session (the runtime half is runChatLoop's resume
    // seam). `runs` is the run-lifecycle namespace (cf. the gateway's
    // `runs.subscribe`); only `resume` is a CLI verb today.
    const first = rest[0] ?? "";
    const isHelp = first === "--help" || first === "-h";
    if (!isHelp && first !== "resume") {
      die(`runs action must be "resume" (got "${first}")`);
    }
    try {
      await runRunsResume(parseFor(isHelp ? rest : rest.slice(1), RUNS_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err);
      throw err;
    }
    break;
  }
  case "dev":
    // Loop contract 0.4 (Batch F, item 2) — compile in memory + supervised
    // child + watch-relaunch. Structured failures (spec parse / lower) route
    // through die() for a clean one-liner.
    try {
      await runDev(parseFor(rest, DEV_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err);
      throw err;
    }
    break;
  case "serve":
    // Item 1 (G30) — project the spec's agent as an MCP server (stdio/SSE).
    // Structured failures (spec parse/lower, ServeMcpError for a misconfigured
    // projection) route through die() for a clean one-liner.
    try {
      await runServeMcp(parseFor(rest, SERVE_SCHEMA));
    } catch (err) {
      if (err instanceof ServeMcpError) die(err.message);
      if (err instanceof CrewhausError) die(err);
      throw err;
    }
    break;
  case "export": {
    // Item 4 (§59) — `export claude-plugin <spec>`. Only the claude-plugin
    // target exists today; a leading -h/--help routes to the handler's help.
    const first = rest[0] ?? "";
    const isHelp = first === "--help" || first === "-h";
    if (!isHelp && first !== "claude-plugin") {
      die(`export target must be "claude-plugin" (got "${first}")`);
    }
    try {
      await runExportClaudePlugin(parseFor(isHelp ? rest : rest.slice(1), EXPORT_SCHEMA));
    } catch (err) {
      if (err instanceof TargetClaudePluginError) die(err.message);
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "eval": {
    // Item 6 — `eval coverage` is a distinct read-side report with its own
    // flags; every other `eval …` invocation is the run path.
    const evalFirst = rest[0] ?? "";
    // E52 — the read verbs live under `eval-report`, but `crewhaus eval
    // history|baseline|diff` is the commonly-guessed spelling and used to
    // fall into the run path with a misleading "missing --dataset" death.
    // The EXACT bare verbs (plus the plural guess "baselines") are working
    // aliases: a one-line stderr notice names the canonical verb, then flags
    // and positionals pass through to the eval-report implementations
    // verbatim. Only whole-word matches alias — a spec FILE literally named
    // history.yaml (or ./history) still takes the run path below. The
    // carve-out is a file check, not a bare existsSync: a DIRECTORY named
    // diff/ (eval-report diff -o diff creates one) must not resurrect the
    // misleading "missing --dataset" death this alias exists to eliminate.
    const EVAL_REPORT_ALIASES: Record<string, string> = {
      history: "history",
      baseline: "baseline",
      baselines: "baseline",
      diff: "diff",
    };
    const aliasVerb = EVAL_REPORT_ALIASES[evalFirst];
    const isSpecFile = (p: string): boolean => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    };
    if (evalFirst === "coverage") {
      try {
        await runEvalCoverage(parseFor(rest.slice(1), EVAL_COVERAGE_SCHEMA));
      } catch (err) {
        if (err instanceof CrewhausError) die(err.message);
        throw err;
      }
      // NEW-HUNT-8 — `eval suite <suite.yaml>`: the CI-tier runner. Guarded by
      // the same is-it-a-spec-file test the read aliases use, so a spec
      // literally named `suite.yaml` still runs an eval.
    } else if (evalFirst === "suite" && !isSpecFile(evalFirst)) {
      await runEvalSuiteCommand(parseFor(rest.slice(1), EVAL_SUITE_SCHEMA));
      // C28 — `eval plan`: pure sample-size arithmetic. Guarded by the same
      // is-it-a-spec-file test the read aliases use, so a spec literally
      // named `plan.yaml` still runs an eval.
    } else if (evalFirst === "plan" && !isSpecFile(evalFirst)) {
      runEvalPlanCmd(parseFor(rest.slice(1), EVAL_PLAN_SCHEMA));
    } else if (aliasVerb !== undefined && !isSpecFile(evalFirst)) {
      process.stderr.write(
        `[eval] note: \`crewhaus eval ${evalFirst}\` is an alias for the canonical \`crewhaus eval-report ${aliasVerb}\`\n`,
      );
      await runEvalReport(parseFor([aliasVerb, ...rest.slice(1)], EVAL_REPORT_SCHEMA));
    } else {
      await runEvalSubcommand(parseFor(rest, EVAL_SCHEMA));
    }
    break;
  }
  case "eval-report":
    await runEvalReport(parseFor(rest, EVAL_REPORT_SCHEMA));
    break;
  // D41 — `crewhaus schedule generate --for … [--runner …]`: print
  // ready-to-install scheduling text (a shim — it installs nothing).
  case "schedule": {
    const action = rest[0] ?? "";
    // `crewhaus schedule --help` (and bare `crewhaus schedule`) route to the
    // usage block, like every other multi-action verb — dying with
    // `action must be "generate" (got "--help")` teaches nothing.
    if (action === "" || action.startsWith("-")) {
      runScheduleGenerate({ positional: [], flags: { help: true } });
      break;
    }
    if (action !== "generate") {
      die(`schedule action must be "generate" (got "${action}")`);
    }
    runScheduleGenerate(parseFor(rest.slice(1), SCHEDULE_SCHEMA));
    break;
  }
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
  case "fleet": {
    // Item 58 — list | status | run <sub>. `run` takes a subcommand as
    // positionals after the action, so the schema is parsed over the tail.
    const action = rest[0] ?? "";
    // HM-202 — `crewhaus fleet --help` (and `-h`) route to the usage block,
    // like `schedule` does. Dying with `fleet action must be one of: …
    // (got "--help")` is the one answer that helps nobody: the operator was
    // asking which actions exist.
    if (action.startsWith("-")) {
      await runFleet({ positional: [], flags: { help: true } }, "");
      break;
    }
    if (action !== "" && action !== "list" && action !== "status" && action !== "run") {
      die(`fleet action must be one of: list, status, run (got "${action}")`);
    }
    await runFleet(parseFor(rest.slice(1), FLEET_SCHEMA), action);
    break;
  }
  case "harness": {
    // Hangar M1 — the harness manager verb family over the machine-wide
    // registry (list/show/add/remove/relocate/group/tag/pin/scan/preflight).
    // Heavy lifting lives in the side-effect-free ./harness-cmd module (this
    // entry file runs an argv switch on import); it throws plain Errors on
    // bad arguments, routed through die() like `route`.
    try {
      const { runHarnessCommand } = await import("./harness-cmd");
      const out = await runHarnessCommand(rest);
      for (const line of out.lines) process.stdout.write(`${line}\n`);
      if (out.exitCode !== 0) process.exit(out.exitCode);
    } catch (err) {
      if (err instanceof Error) die(err.message);
      throw err;
    }
    break;
  }
  case "hangar": {
    // Hangar M1 — the manager console: `hangar [serve]` boots the loopback
    // hangar-server with the embedded hangar-ui assets (single-instance
    // lock, watchme seed, #fragment token handoff, --smoke self-check);
    // `hangar status|open` inspect/reopen it. Heavy lifting lives in the
    // side-effect-free ./hangar-cmd module (this entry file runs an argv
    // switch on import); it throws plain Errors on bad arguments, routed
    // through die() like `harness`.
    try {
      const { runHangarCommand } = await import("./hangar-cmd");
      const out = await runHangarCommand(rest);
      for (const line of out.lines) process.stdout.write(`${line}\n`);
      if (out.exitCode !== 0) process.exit(out.exitCode);
    } catch (err) {
      if (err instanceof Error) die(err.message);
      throw err;
    }
    break;
  }
  case "daemon": {
    // Hangar M2 — supervise a harness process from the terminal:
    // `daemon start|stop|restart|status|logs|wake|drain`. These verbs drive
    // @crewhaus/harness-supervisor DIRECTLY, not the Hangar server, so they
    // work with no console running — the "one state tree, two heads"
    // covenant (all supervision state is harness-local under
    // .crewhaus/run/, so either head adopts what the other started).
    // Heavy lifting lives in the side-effect-free ./daemon-cmd module (this
    // entry file runs an argv switch on import); it throws plain Errors on
    // bad arguments, routed through die() like `hangar`.
    try {
      const { runDaemonCommand } = await import("./daemon-cmd");
      const out = await runDaemonCommand(rest);
      for (const line of out.lines) process.stdout.write(`${line}\n`);
      if (out.exitCode !== 0) process.exit(out.exitCode);
    } catch (err) {
      if (err instanceof Error) die(err.message);
      throw err;
    }
    break;
  }
  case "knowledge": {
    // Item 63 — cross-harness knowledge sync (memories/graders/prompts).
    const action = rest[0] ?? "";
    if (action !== "" && action !== "sync") {
      die(`knowledge action must be "sync" (got "${action}")`);
    }
    await runKnowledge(parseFor(rest.slice(1), KNOWLEDGE_SCHEMA), action || "sync");
    break;
  }
  case "retire":
    // Item 64 — audited harness decommissioning. Structured failures (spec
    // parse, active-pin refusal, a failed step) route through die().
    try {
      await runRetire(parseFor(rest, RETIRE_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "model-scan":
    try {
      await runModelScan(parseFor(rest, MODEL_SCAN_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "pricing": {
    const action = rest[0] ?? "";
    if (action !== "sync" && action !== "show") {
      die(`pricing action must be "sync" or "show" (got "${action}")`);
    }
    await runPricing(parseFor(rest.slice(1), PRICING_SCHEMA), action);
    break;
  }
  case "model": {
    const action = rest[0] ?? "";
    if (action !== "right-size") {
      die(`model action must be "right-size" (got "${action}")`);
    }
    try {
      await runModelRightSize(parseFor(rest.slice(1), MODEL_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "route":
    // Adaptive model routing — inspect/reset the reward scoreboard. `runRoute`
    // throws a plain Error on a bad argument; surface it through die().
    try {
      process.stdout.write(`${runRoute(rest)}\n`);
    } catch (err) {
      if (err instanceof Error) die(err.message);
      throw err;
    }
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
  case "permissions": {
    const action = rest[0] ?? "";
    if (action !== "suggest") {
      die(`permissions action must be "suggest" (got "${action}")`);
    }
    await runPermissions(action, parseFor(rest.slice(1), PERMISSIONS_SCHEMA));
    break;
  }
  case "rate":
    await runRate(parseFor(rest, RATE_SCHEMA));
    break;
  case "feedback":
    await runFeedbackCmd(parseFor(rest, FEEDBACK_SCHEMA));
    break;
  case "approvals": {
    // Loop contract 0.4 (Batch C, G11) — list | show | grant | deny <id>.
    // A leading -h/--help (help flag in the action slot) routes to the
    // handler's own help, not the invalid-action error.
    const first = rest[0] ?? "";
    const isHelp = first === "--help" || first === "-h";
    const action = isHelp ? "" : first;
    if (!isHelp && !["", "list", "show", "grant", "deny"].includes(action)) {
      die(`approvals action must be one of: list, show, grant, deny (got "${action}")`);
    }
    try {
      await runApprovals(parseFor(isHelp ? rest : rest.slice(1), APPROVALS_SCHEMA), action);
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "failures": {
    // G63 — `failures report`: aggregate/cluster run_failed + incidents.
    const first = rest[0] ?? "";
    const isHelp = first === "--help" || first === "-h";
    if (!isHelp && first !== "report") {
      die(`failures action must be "report" (got "${first}")`);
    }
    try {
      await runFailuresReport(parseFor(isHelp ? rest : rest.slice(1), FAILURES_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "review": {
    // Wave 3 (B20) — the persistent human-review queue: list | next |
    // resolve <id>. A leading -h/--help routes to the handler's own help.
    const first = rest[0] ?? "";
    const isHelp = first === "--help" || first === "-h";
    const action = isHelp ? "" : first;
    if (!isHelp && !["", "list", "next", "resolve"].includes(action)) {
      die(`review action must be one of: list, next, resolve (got "${action}")`);
    }
    try {
      await runReview(parseFor(isHelp ? rest : rest.slice(1), REVIEW_SCHEMA), action);
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "distill":
    await runDistill(parseFor(rest, DISTILL_SCHEMA));
    break;
  case "fewshot":
    // Item #54 — `fewshot harvest|show`: mine up-rated turns into a golden
    // few-shot pool for `optimize --few-shot`. Structured failures route
    // through die().
    try {
      await runFewshot(parseFor(rest, FEWSHOT_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "faq":
    // Item #55 — `faq distill`: cluster recurring user questions into an
    // auto-discovered FAQ skill. Structured failures route through die().
    try {
      await runFaq(parseFor(rest, FAQ_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "lessons":
    // Item #56 — `lessons update`: mine corrections + failure→fix patterns
    // into a deduped LESSONS.md + per-user prefs. Failures route through die().
    try {
      await runLessons(parseFor(rest, LESSONS_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "sessions":
    // Item #57 — `sessions summarize`: fold sessions into the durable index
    // (on demand or via the summarize-before-evict hook). Failures → die().
    try {
      await runSessions(parseFor(rest, SESSIONS_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "memory":
    // 0.3.0 memory release (design §3.4) — inspect/forget/sweep the per-spec
    // fact stores. Structured failures route through die().
    try {
      await runMemory(parseFor(rest, MEMORY_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "wiki":
    // 0.3.0 memory release (design §3.1, PR 9) — inspect the per-spec local
    // wikis (read-only verbs). Structured failures route through die().
    try {
      await runWiki(parseFor(rest, WIKI_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "dream": {
    // 0.3.0 memory release (design §6.3, PR 14) — scheduled consolidation
    // verbs. A bare `crewhaus dream <spec>` defaults to `run` (the design's
    // transcript); the verbs themselves live in dream-cli.ts.
    const dreamFirst = rest[0];
    const dreamAction =
      dreamFirst === "run" || dreamFirst === "status" || dreamFirst === "init" ? dreamFirst : "run";
    const dreamRest = dreamFirst === dreamAction ? rest.slice(1) : rest;
    try {
      await runDreamCommand(parseFor(dreamRest, DREAM_CLI_SCHEMA), dreamAction);
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "migrate": {
    // 0.3.0 memory release — `migrate memories`: the v2 schema backfill over
    // .crewhaus/memories/. Spec migrations stay on migrate-all/upgrade.
    const migrateAction = rest[0] ?? "";
    if (migrateAction !== "memories") {
      die(
        `migrate action must be "memories" (got "${migrateAction}") — spec migrations use migrate-all/upgrade`,
      );
    }
    try {
      await runMigrateMemories(parseFor(rest.slice(1), MIGRATE_MEMORIES_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "scaffold-evals":
    // Mirror `run`'s policy: structured failures (SpecParseError, model
    // routing/auth on the one-shot generation call) extend CrewhausError —
    // route the family through die() for a clean one-liner.
    try {
      await runScaffoldEvals(parseFor(rest, SCAFFOLD_EVALS_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "graders": {
    const action = rest[0] ?? "";
    if (action !== "suggest" && action !== "test" && action !== "card") {
      die(`graders action must be one of: suggest, test, card (got "${action}")`);
    }
    try {
      if (action === "suggest") {
        await runGradersSuggest(parseFor(rest.slice(1), GRADERS_SUGGEST_SCHEMA));
      } else if (action === "test") {
        // E48 — meta-eval the grader suite against labeled golden verdicts.
        await runGradersTest(parseFor(rest.slice(1), GRADERS_TEST_SCHEMA));
      } else {
        // NEW-HUNT-11 — render the measurement-instrument rubric card.
        await runGradersCard(parseFor(rest.slice(1), GRADERS_CARD_SCHEMA));
      }
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "datasets":
    await runDatasets(parseFor(rest, DATASETS_SCHEMA));
    break;
  case "dataset":
    // Item 2/5 — the `dataset` (singular) growth family: mine / synthesize /
    // refresh-goldens. Structured failures (registry/ref/spec) route through
    // die() for a clean one-liner.
    await runDataset(parseFor(rest, DATASET_SCHEMA));
    break;
  case "redteam": {
    // E49 — generated attack suite + attack-success-rate report. A bare
    // `crewhaus redteam` (or a leading flag) routes to usage like every other
    // multi-action verb.
    const action = rest[0] ?? "";
    if (action === "" || action.startsWith("-")) {
      await runRedteam(parseFor(rest, REDTEAM_SCHEMA), "");
      break;
    }
    try {
      await runRedteam(parseFor(rest.slice(1), REDTEAM_SCHEMA), action);
    } catch (err) {
      if (err instanceof RedteamError) die(err.message);
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "judge": {
    // Item 8 — `judge calibrate`: pair human ratings with llm_judge scores.
    const action = rest[0] ?? "";
    if (action !== "calibrate") {
      die(`judge action must be "calibrate" (got "${action}")`);
    }
    try {
      await runJudgeCalibrate(parseFor(rest.slice(1), JUDGE_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
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
    // Loop contract 0.4 (Batch F, item 5) — the cloud-provider arms
    // (fly/render/railway/heroku) scaffold + token-gated live-deploy through a
    // cloud-adapter-* engine; the registry ones (promote/rollback/canary) flip
    // a spec-registry env pin. They share the `deploy` verb but nothing else,
    // so route by action to keep each schema/handler focused.
    if (isCloudDeployProvider(action)) {
      try {
        await runCloudDeploy(parseFor(rest.slice(1), CLOUD_DEPLOY_SCHEMA), action);
      } catch (err) {
        if (err instanceof CrewhausError) die(err.message);
        throw err;
      }
      break;
    }
    if (action !== "promote" && action !== "rollback" && action !== "canary") {
      die(
        `deploy action must be one of: fly, render, railway, heroku, promote, rollback, canary (got "${action}")`,
      );
    }
    try {
      await runDeploy(parseFor(rest.slice(1), DEPLOY_SCHEMA), action);
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  // E50 — `crewhaus experiment status|record|assign`: the honest subset of an
  // online A/B experiment (deterministic per-request version selection +
  // per-version outcome accounting). Bare `experiment` / `--help` routes to
  // the usage block like every other multi-action verb.
  case "experiment": {
    const action = rest[0] ?? "";
    if (action === "" || action.startsWith("-")) {
      runExperimentCommand({ positional: [], flags: { help: true } }, "");
      break;
    }
    try {
      runExperimentCommand(parseFor(rest.slice(1), EXPERIMENT_SCHEMA), action);
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "propose":
    // Item 59 — package a spec change into a review artifact + open a PR.
    // Structured failures (spec parse, propose assembly, git/gh driver) route
    // through die() for a clean one-liner.
    try {
      await runPropose(parseFor(rest, PROPOSE_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "plugins": {
    // Item 60 — the marketplace plugins CLI. `install`/`uninstall`/`publish`
    // take a positional after the action; the schema parses the tail.
    const action = rest[0] ?? "";
    await runPlugins(parseFor(rest.slice(1), PLUGINS_SCHEMA), action);
    break;
  }
  case "templates": {
    // Item 60 — the marketplace templates CLI.
    const action = rest[0] ?? "";
    await runTemplates(parseFor(rest.slice(1), TEMPLATES_SCHEMA), action);
    break;
  }
  case "migrate-all":
    await runMigrateAll(parseFor(rest, MIGRATE_SCHEMA));
    break;
  case "incident": {
    const action = rest[0] ?? "";
    if (action !== "collect") {
      die(`incident action must be "collect" (got "${action}")`);
    }
    try {
      await runIncidentCollect(parseFor(rest.slice(1), INCIDENT_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "upgrade":
    try {
      await runUpgrade(parseFor(rest, UPGRADE_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  case "build-image":
    await runBuildImage(parseFor(rest, BUILD_IMAGE_SCHEMA));
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
    await runFederation(parseFor(rest.slice(1), FEDERATION_SCHEMA));
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
  case "mcp": {
    const action = rest[0] ?? "";
    if (action !== "doctor") {
      die(`mcp action must be "doctor" (got "${action}")`);
    }
    try {
      await runMcpDoctor(parseFor(rest.slice(1), MCP_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
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
    if (action === "digest") {
      await runSecurityDigest(parseFor(rest.slice(1), SECURITY_SCHEMA));
    } else if (action === "corpus") {
      // `security corpus` builds; `security corpus check` runs the regression.
      const sub = rest[1] === "check" ? "check" : "build";
      const argsSlice = sub === "check" ? rest.slice(2) : rest.slice(1);
      try {
        await runSecurityCorpus(parseFor(argsSlice, SECURITY_CORPUS_SCHEMA), sub);
      } catch (err) {
        if (err instanceof CrewhausError) die(err.message);
        throw err;
      }
    } else {
      die(`security action must be "digest" or "corpus" (got "${action}")`);
    }
    break;
  }
  case "egress": {
    const action = rest[0] ?? "";
    if (action !== "review") {
      die(`egress action must be "review" (got "${action}")`);
    }
    try {
      await runEgressReview(parseFor(rest.slice(1), EGRESS_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "pii": {
    const action = rest[0] ?? "";
    if (action !== "tune") {
      die(`pii action must be "tune" (got "${action}")`);
    }
    try {
      await runPiiTune(parseFor(rest.slice(1), PII_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
    break;
  }
  case "justification": {
    const action = rest[0] ?? "";
    if (action !== "calibrate" && action !== "preflight") {
      die(`justification action must be "calibrate" or "preflight" (got "${action}")`);
    }
    try {
      await runJustification(parseFor(rest.slice(1), JUSTIFICATION_SCHEMA), action);
    } catch (err) {
      if (err instanceof CrewhausError) die(err.message);
      throw err;
    }
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
  case "onchain": {
    // Item 66 — tune (propose a transaction_policy) | sentinel (flag anomalous
    // spend). Both take the <spec> positional after the action.
    const action = rest[0] ?? "";
    if (action !== "tune" && action !== "sentinel") {
      die(`onchain action must be "tune" or "sentinel" (got "${action}")`);
    }
    try {
      await runOnchain(parseFor(rest.slice(1), ONCHAIN_SCHEMA), action);
    } catch (err) {
      if (err instanceof CrewhausError || err instanceof OnchainTuneError) die(err.message);
      throw err;
    }
    break;
  }
  case "intents":
    // Item 67 — end-user intent analytics digest.
    try {
      await runIntents(parseFor(rest, INTENTS_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError || err instanceof IntentsError) die(err.message);
      throw err;
    }
    break;
  case "watchme": {
    // "Watch me" (design/watch-me.md §11) — observe-and-learn verbs. A leading
    // -h/--help in the action slot routes to the command's own help (stdout,
    // exit 0), not the invalid-action error; structured failures → die().
    const first = rest[0] ?? "";
    const isHelp = first === "--help" || first === "-h";
    const action = isHelp ? "" : first;
    const allowed = ["", "start", "stop", "status", "report", "intents", "synthesize", "publish"];
    if (!isHelp && !allowed.includes(action)) {
      die(
        `watchme action must be one of: start, stop, status, report, intents, synthesize, publish (got "${action}")`,
      );
    }
    try {
      await runWatchme(parseFor(isHelp ? rest : rest.slice(1), WATCHME_SCHEMA), action);
    } catch (err) {
      if (
        err instanceof CrewhausError ||
        err instanceof WatchmeError ||
        err instanceof WatchmeReportError ||
        err instanceof WatchmeSynthesizeError
      ) {
        die(err.message);
      }
      throw err;
    }
    break;
  }
  case "loadtest":
    // Item 68 — concurrency benchmark + deploy gate for daemon shapes.
    try {
      await runLoadtestCmd(parseFor(rest, LOADTEST_SCHEMA));
    } catch (err) {
      if (err instanceof CrewhausError || err instanceof LoadtestError) die(err.message);
      throw err;
    }
    break;
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
