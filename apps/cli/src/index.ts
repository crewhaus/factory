#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";
// Type-only — the concrete factories are dynamically imported inside the
// deploy/propose handlers (lazy boot); the approval gate helper needs the
// registry/audit types for its signature.
import type { AuditLog } from "@crewhaus/audit-log";
import { SpecParseError, compile, lower } from "@crewhaus/compiler";
import { buildContextBundle, discoverRoots } from "@crewhaus/context-bundle";
import {
  DEFAULT_PRICING,
  type PricingTable,
  classifyPricingStaleness,
  computeCacheSavingsMicros,
  parsePricingFeed,
  pickNewestPricing,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import {
  type DatasetRecord,
  type DatasetSplit,
  compareVersions,
  createFileBackedRegistry,
  latestVersion,
} from "@crewhaus/dataset-registry";
import { CrewhausError } from "@crewhaus/errors";
import { type Sample, loadDataset } from "@crewhaus/eval-dataset";
import { type CompiledGrader, type GradersConfig, parseGradersConfig } from "@crewhaus/eval-grader";
import {
  extractCurrentPrompt as extractInstructions,
  optimizeSpec,
} from "@crewhaus/eval-optimizer-orchestrator";
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
import { type EvalRunSummary, runEval as runEvalLib } from "@crewhaus/eval-runner";
import { openEventLog } from "@crewhaus/event-log";
import { loadHooks, runHooks } from "@crewhaus/hooks-engine";
import {
  ArgParseError,
  type ParseArgsSchema,
  type ParsedArgs,
  parseArgs,
} from "@crewhaus/infra-utils";
import { GENERATED_README_MARKER, type IrBudget } from "@crewhaus/ir";
import { createLogger } from "@crewhaus/logging";
import { McpHost } from "@crewhaus/mcp-host";
import {
  captureFacts,
  createMemoryStore,
  deriveMemoryDecision,
  summarizeDurableFacts,
} from "@crewhaus/memory-store";
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
import { createSessionStore, evictExpiredSessions } from "@crewhaus/session-store";
import { createSkillTool, discoverSkills } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
import { type Spec, parseSpec } from "@crewhaus/spec";
import type { RegistryAdapter } from "@crewhaus/spec-registry";
import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { registerMcpServer } from "@crewhaus/tool-mcp";
import { createMemoryTools } from "@crewhaus/tool-memory";
import { createTaskTool } from "@crewhaus/tool-task";
import { type CostAccrualEvent, type ProviderId, TraceEventBus } from "@crewhaus/trace-event-bus";
import { parseDocument } from "yaml";
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
import {
  EVAL_CI_WORKFLOW_RELPATH,
  SENTINEL_WORKFLOW_RELPATH,
  buildEvalCiWorkflowYaml,
  buildSentinelDriftWorkflowYaml,
} from "./ci-scaffold";
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
// Item 2 — `crewhaus dataset mine` + `dataset synthesize`: grow the dataset
// from production struggle signals + PII-redacted stress variants, in a
// side-effect-free module so it is unit-testable (this entry file runs an argv
// switch on import).
import {
  type MineCandidate,
  SYNTHESIZE_PII_DETECTORS,
  buildStressVariants,
  candidateToSample,
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
  defaultDatasetsRoot,
  isDatasetSplit,
  parseNameVersion,
  parseRegistryRef,
  parseSplitSpec,
  recordToJsonl,
  registerDataset,
  resolveRegistryRef,
} from "./datasets";
// Item 29 — `crewhaus deploy canary` eval-gated ramp orchestration, in a
// side-effect-free module so it is unit-testable (this entry file runs an
// argv switch on import). The heavy I/O (per-version eval, registry pins,
// audit) is injected here in index.ts.
import {
  CanaryRampError,
  driveCanaryRamp,
  makeCanaryEvalGate,
  parseTrafficSteps,
} from "./deploy-canary";
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
  type CoverageSample,
  DEFAULT_COVERAGE_SESSIONS,
  EvalCoverageError,
  buildEvalCoverage,
  buildProdBehavior,
  computeCoverage,
  coverageFileName,
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
// Item 30 — model-drift sentinel comparison logic, in a side-effect-free
// module so it is unit-testable (this entry file runs an argv switch on
// import). The fresh run + baseline load happen in index.ts; this decides drift.
import { evaluateSentinel } from "./eval-sentinel";
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
  gradersConfigToYaml,
  mergeFeedback,
  normalizeRating,
  samplesToJsonl,
} from "./feedback";
// Item #54 — few-shot pool harvesting (side-effect-free; FS + redactor wiring
// lives here in index.ts). Powers `fewshot harvest` and `optimize --few-shot`.
import {
  type FewShotExample,
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
  type EvalHealthReader,
  FleetError,
  type FleetRunner,
  type HarnessInventory,
  type LastEvalEntry,
  buildFleetInventory,
  buildHarnessHealth,
  formatBulkReport,
  formatInventory as formatFleetInventory,
  formatHealth,
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
// Item 32 — incident bundle assembly (trigger classification, audit-window
// join, cost summary, eval-report-styled render), in a side-effect-free module
// so it is unit-testable (this entry file runs an argv switch on import).
import {
  type IncidentKind,
  assembleIncidentBundle,
  matchAuditRecordsByWindow,
  summarizeCost,
} from "./incident";
// Item 39 — `crewhaus init --interactive`: the harness-designer interview
// (validate-and-retry loop + scripted no-credentials fallback) in a
// side-effect-free module so this entry file stays testable.
import {
  EMIT_SPEC_TOOL,
  type ScriptedAnswers,
  type ScriptedShape,
  buildInterviewSystemPrompt,
  buildScriptedSpec,
  isScriptedShape,
  runInterview,
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
  type JudgeCalibrationFile,
  buildCalibrationCard,
  buildCalibrationFile,
  renderCalibrationCard,
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
// Item 25 — model right-sizing downshift search core (pure enumeration + cost
// projection + $/score ranking); side-effect-free so it is unit-testable.
import {
  type BaselineEvalOutcome,
  type ModelSlot,
  type SlotEvalOutcome,
  buildRightSizeReport,
  enumerateSlotCandidates,
} from "./right-size";
// Adaptive model routing — `crewhaus route status|reset` inspects/clears the
// per-(routeKey, model) reward scoreboard behind `agent.model_pool`.
import { runRoute } from "./route";
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
  buildSampleGenerationPrompt,
  buildScaffoldGraders,
  buildScaffoldSamples,
  checkNoOverwrite,
  extractScaffoldInfo,
  feedbackBlockSuggestion,
  mergeInputs,
  parseModelSampleInputs,
  templateSampleInputs,
} from "./scaffold-evals";
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
// Item #57 — summarize sessions into a durable index before TTL eviction.
import { SESSIONS_INDEX_DIRNAME, summarizeSessionIntoIndex } from "./sessions-index";
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
import { formatUpgradePlan, makeSpecValidator, planUpgrade } from "./upgrade";
// CLI version resolution (embedded --define constant → package.json), shared
// with compile-check.ts's dependency pinning.
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
  gradeVoiceSession,
  parseReplayLog,
  renderVoiceReport,
} from "./voice-eval";
import { type Watcher, createWatchController, formatCycleLine } from "./watch";

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
    // Item 10 — also emit an eval bridge (a target: eval bundle projected from
    // this non-cli spec's own agent) into <out-dir>/eval/, so the shape can
    // consume its distilled feedback through eval/optimize/flywheel.
    { name: "with-eval-harness", takesValue: false },
    // Item 10 — the dataset the projected eval bridge consumes (defaults to
    // <specName>-eval@v1#dev, the dataset mine/distill convention).
    { name: "eval-dataset", takesValue: true },
    // Item 41 — re-run parse→lint→compile on every change to the spec /
    // .crewhaus/commands / skills dirs (the watch mode the header listed as
    // "future"). Debounced, Ctrl-C-clean, one green/red status per cycle.
    { name: "watch", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 41 — `crewhaus lint [--fix] [--format text|json]`: a check-only command
// running parseSpec + compile({applyIrPasses:true}) + auditToolScopes WITHOUT
// emitting, so §47 chain / graph-crew well-formedness checks (skipped on the
// CLI compile path) surface for authors.
const LINT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "fix", takesValue: false },
    { name: "format", takesValue: true },
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
    // Item 41 — re-validate (parse→lint→compile-in-memory) on every change to
    // the spec / .crewhaus/commands / skills dirs, printing a green/red status
    // per cycle. A pre-run authoring aid; it does NOT re-launch the agent.
    { name: "watch", takesValue: false },
    // Item 27 — run-level spend cap in dollars. Sets/overrides the spec
    // `budget.usd` ceiling and keeps the spec's on_exceed ladder (default
    // `stop`). On reaching the cap the run stops (or degrades) before the
    // next turn.
    { name: "budget-usd", takesValue: true },
    // Item #56 — identify the current user so their
    // `.crewhaus/preferences/<user>.md` is injected at run start (alongside
    // the auto-loaded LESSONS.md). Flag > CREWHAUS_USER env.
    { name: "user", takesValue: true },
    // Item 38 — opt out of the MCP auto-quarantine: register even the tools of
    // servers `crewhaus mcp doctor` marked chronically failing in
    // `.crewhaus/mcp/quarantine.json` (default: withdraw them + inject a notice).
    { name: "no-mcp-quarantine", takesValue: false },
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
    // Item 13 — also scaffold eval/dataset.jsonl + eval/graders.yaml (the
    // flywheel's conventional paths) in OFFLINE template mode, so a fresh
    // harness can `crewhaus eval` on day one. Composable with an existing
    // harness like --ci: `init --with-evals` adds just the eval assets.
    { name: "with-evals", takesValue: false },
    // Item 30 — also scaffold .github/workflows/sentinel-drift.yml, the nightly
    // model-drift sentinel cron. Composable with an existing harness like --ci.
    { name: "sentinel", takesValue: false },
    // Overwrite an existing scaffolded workflow or eval assets (never the
    // spec).
    { name: "force", takesValue: false },
    // Item 39 — interactive spec authoring: interview the user (via the
    // resolved model, or a scripted stdin questionnaire when no credentials)
    // and emit a parseSpec-validated crewhaus.yaml. Composes with --detect to
    // prefill the model from what's reachable.
    { name: "interactive", short: "i", takesValue: false },
    { name: "detect", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 13 — `crewhaus scaffold-evals`: starter eval assets FROM the spec.
const SCAFFOLD_EVALS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    { name: "samples", takesValue: true },
    // Model for the one-shot sample-input generation call (model-router
    // grammar); also baked into the emitted llm_judge grader. Without it the
    // spec's own agent.model is used when its credentials are visible, else
    // the deterministic template fallback.
    { name: "model", takesValue: true },
    // Overwrite existing eval assets (default: refuse).
    { name: "force", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 4 — `crewhaus graders suggest`: draft grader suites from failure
// rationale accumulated in recent eval runs + user feedback.
const GRADERS_SUGGEST_SCHEMA: ParseArgsSchema = {
  flags: [
    // A run dir, or `last:N` (default: the last 10 indexed runs for the cwd
    // spec — the item-3 run-history index).
    { name: "runs", takesValue: true },
    // Model for the one-shot llm_judge rubric draft from real good/bad
    // exemplars (model-router grammar). Without it the cwd spec's model is
    // used when its credentials are visible; else deterministic-only output.
    { name: "model", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // Override the run-index spec filter (default: the cwd crewhaus.yaml's
    // name when parseable, else unfiltered).
    { name: "spec", takesValue: true },
    // Rating threshold splitting up-rated exemplars from failure evidence
    // (mirrors `distill --min-score`).
    { name: "min-score", takesValue: true },
    // Overwrite an existing review file (default: refuse).
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
    // Item 24 — model advisory: flag spec models missing from the pricing
    // table (silently billed $0), pricing-table staleness, and known sunsets.
    { name: "models", takesValue: false },
    // Item 37 — SLO/TTFT probe: compare recent p95 TTFT vs the cwd spec's
    // observability.slo.ttft_ms and name faster candidates on a breach.
    // Container-HEALTHCHECK exit semantics (0 within/no-data, 1 breach).
    { name: "slo", takesValue: false },
    { name: "ttft", takesValue: false },
    // Item 40 — `--detect`: read-only inventory of reachable providers, the
    // local Ollama/vLLM endpoint's models, and MCP servers from
    // .mcp.json / Claude Desktop config. `--no-probe` skips the localhost HTTP
    // probe (offline / CI).
    { name: "detect", takesValue: false },
    { name: "no-probe", takesValue: false },
    // Item 40 — `--fix`: apply the mechanical remediations doctor otherwise
    // only prints (scaffold crewhaus.yaml, create .crewhaus/, mark outward
    // tools scope:external, append commented .env stubs). Dry-run is the
    // DEFAULT: without --fix, doctor prints the diff it WOULD apply.
    { name: "fix", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 24 — `crewhaus model-scan`: scheduled market scan. Enumerate
// capability-compatible replacements for the cwd spec's agent.model, eval each
// on the spec's dataset, and emit a proposal (+ patch.json) when a candidate
// beats current on score at lower cost. Proposal-only unless --write.
const MODEL_SCAN_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "judge-model", takesValue: true },
    // Restrict candidates to same-provider siblings (keeps credentials + cache).
    { name: "same-provider", takesValue: false },
    // Max candidates evaled (cheapest-first). Default 6.
    { name: "limit", takesValue: true },
    // Apply the winning proposal to the spec via a direct comment-preserving
    // CST edit (model fields are outside OPTIMIZABLE_PATHS — this bypasses the
    // optimizer whitelist deliberately; always human-initiated).
    { name: "write", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 24 — `crewhaus pricing sync|show`: load a versioned pricing feed into
// ~/.crewhaus/pricing/ so createCostTracker({pricing}) can override without a
// code release.
const PRICING_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "file", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 25 — `crewhaus model right-size <spec>`: enumerate → compile → eval
// downshift search for a cheaper model that holds quality. Proposal-only
// unless --write.
const MODEL_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "judge-model", takesValue: true },
    // Minimum cost drop (fraction, e.g. 0.2 = 20%) to recommend a downshift.
    { name: "min-cost-drop", takesValue: true },
    // Pass-rate tolerance (fraction) a downshift may dip and still recommend.
    { name: "pass-rate-tolerance", takesValue: true },
    // Max candidates per slot (cheapest-first). Default 3.
    { name: "per-slot-limit", takesValue: true },
    // Apply the winning downshift via a direct comment-preserving CST edit.
    { name: "write", takesValue: false },
    // Item 40 — `--detect`: read-only inventory of reachable providers, the
    // local Ollama/vLLM endpoint's models, and MCP servers from
    // .mcp.json / Claude Desktop config. `--no-probe` skips the localhost HTTP
    // probe (offline / CI).
    { name: "detect", takesValue: false },
    { name: "no-probe", takesValue: false },
    // Item 40 — `--fix`: apply the mechanical remediations doctor otherwise
    // only prints (scaffold crewhaus.yaml, create .crewhaus/, mark outward
    // tools scope:external, append commented .env stubs). Dry-run is the
    // DEFAULT: without --fix, doctor prints the diff it WOULD apply.
    { name: "fix", takesValue: false },
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
    // Item #54 — inject the top-K harvested few-shot examples as in-context
    // demonstrations at the front of the seed instructions the optimizer
    // mutates. Value: a pool file path, or "auto" for the cwd default
    // `.crewhaus/fewshot/<spec>.jsonl`. Composes with --ratings.
    { name: "few-shot", takesValue: true },
    { name: "few-shot-k", takesValue: true },
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

// Item 60 — `crewhaus plugins {list,search,install,uninstall,publish,outdated}`.
const PLUGINS_SCHEMA: ParseArgsSchema = {
  flags: [
    // Registry backend: a dir (or file:<dir>) of manifest JSONs, or an
    // http(s):// index URL. Falls back to CREWHAUS_PLUGIN_REGISTRY.
    { name: "registry", takesValue: true },
    // search filter.
    { name: "query", short: "q", takesValue: true },
    // install: pin a version (default latest).
    { name: "version", takesValue: true },
    // Where installed plugins live (default ~/.crewhaus/plugins) + registry file.
    { name: "plugins-dir", takesValue: true },
    { name: "registry-file", takesValue: true },
    // Signing: opt out of fail-closed verification (dev only).
    { name: "allow-unsigned", takesValue: false },
    // publish: the manifest JSON to publish.
    { name: "manifest", takesValue: true },
    // publish/outdated: assemble + print without touching git/gh / network write.
    { name: "dry-run", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 60 — `crewhaus templates {list,search,use}`.
const TEMPLATES_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "registry", takesValue: true },
    { name: "query", short: "q", takesValue: true },
    { name: "target", takesValue: true },
    // `use`: workspace dir the template scaffolds into (default cwd) + subdir.
    { name: "into", takesValue: true },
    { name: "subdir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 64 — `crewhaus retire <spec>`. `--archive <dir>` where the evidence
// bundle lands; `--dry-run` prints the plan; `--force` retires despite an
// active pin; `--push-knowledge` shares lessons out first; `--shared` picks
// the shared store for that push.
const RETIRE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "archive", takesValue: true },
    { name: "dry-run", takesValue: false },
    { name: "force", takesValue: false },
    { name: "push-knowledge", takesValue: false },
    { name: "shared", takesValue: true },
    { name: "root-dir", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 63 — `crewhaus knowledge sync [--pull|--push]`. `--root` scopes the
// fleet discovery; `--shared` overrides the shared-store dir; `--dry-run`
// plans without writing; `--no-redact` skips redaction (dev/local only).
const KNOWLEDGE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root", takesValue: true },
    { name: "shared", takesValue: true },
    { name: "pull", takesValue: false },
    { name: "push", takesValue: false },
    { name: "dry-run", takesValue: false },
    { name: "no-redact", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 58 — `crewhaus fleet list|status|run`. `--root` scopes discovery;
// `--filter` narrows a bulk `run`; `--allow-mutating` + per-harness confirm
// gates a mutating bulk op; `--yes` skips the interactive confirm (CI).
const FLEET_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root", takesValue: true },
    { name: "filter", takesValue: true },
    { name: "allow-mutating", takesValue: false },
    { name: "yes", short: "y", takesValue: false },
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
    // Item 30 — nightly model-drift sentinel: re-run the (seed-pinned) dataset
    // against the UNCHANGED spec and diff against a frozen baseline run dir;
    // any flip/score-shift when specHash AND dataset-hash are both unchanged is
    // provider drift → exit non-zero. --baseline points at the frozen run dir.
    { name: "sentinel", takesValue: false },
    { name: "baseline", takesValue: true },
    // Item 65 — voice replay eval: replay recorded call-session logs through
    // the voice grader pack (latency / barge-in / transcript) instead of the
    // text model-driven eval. --replay-dir points at the recorded session
    // JSONLs (default .crewhaus/voice-replays). Latency budgets via --max-*.
    { name: "voice", takesValue: false },
    { name: "replay-dir", takesValue: true },
    { name: "max-ttft-ms", takesValue: true },
    { name: "max-turn-latency-ms", takesValue: true },
    { name: "max-barge-in-yield-ms", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 6 — `crewhaus eval coverage`: detect agent behaviors present in
// production sessions that no eval sample exercises.
const EVAL_COVERAGE_SCHEMA: ParseArgsSchema = {
  flags: [
    // How many of the cwd spec's most-recent sessions to scan (default 50; `all`).
    { name: "sessions", takesValue: true },
    // Intersect against a dataset's expected_tools (file or registry:<ref>);
    // defaults to the conventional eval/dataset.jsonl next to the cwd spec.
    { name: "dataset", takesValue: true },
    // Accepted for symmetry with the other eval-flywheel commands; unused —
    // coverage is grader-agnostic (it intersects tool behavior, not graders).
    { name: "graders", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "format", takesValue: true },
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

const PERMISSIONS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "sessions", takesValue: true },
    { name: "apply" },
    { name: "json" },
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
    // Item 12 — promote the distilled samples into the dataset registry as a
    // new auto-bumped version of <name> (deterministic 70/15/15
    // train/dev/test split), consumable as `--dataset registry:<name>`.
    // -o becomes optional when given; plain file output stays the default.
    { name: "register", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item #54 — `crewhaus fewshot harvest|show`: mine up-rated turns into a
// golden few-shot pool consumable by `optimize --few-shot`.
const FEWSHOT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "all-sessions", takesValue: false },
    { name: "min-score", takesValue: true },
    // Override the pool file (default `.crewhaus/fewshot/<spec>.jsonl`).
    { name: "out", short: "o", takesValue: true },
    // show/inject: how many top examples to print/format (default 5).
    { name: "k", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item #55 — `crewhaus faq distill`: cluster recurring user questions into an
// auto-discovered FAQ SKILL.md under `.crewhaus/skills/faq/`.
const FAQ_SCHEMA: ParseArgsSchema = {
  flags: [
    // How many recent sessions to scan (default all; `N` or `all`).
    { name: "sessions", takesValue: true },
    { name: "min-score", takesValue: true },
    // Minimum recurrences for a question cluster to become an FAQ (default 2).
    { name: "min-occurrences", takesValue: true },
    // Override the emitted skill directory (default `.crewhaus/skills/faq`).
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item #56 — `crewhaus lessons update`: mine corrections + failure→fix
// patterns into a deduped LESSONS.md and maintain per-user preference files.
const LESSONS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "sessions", takesValue: true },
    { name: "low-score", takesValue: true },
    // Override the LESSONS.md path (default `<cwd>/LESSONS.md`).
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item #57 — `crewhaus sessions summarize`: fold sessions into a durable index
// (on demand, or before TTL eviction with --evicted).
const SESSIONS_SCHEMA: ParseArgsSchema = {
  flags: [
    // Only summarize sessions last modified strictly BEFORE this date (ISO or
    // epoch-ms). Omitted → every session in the store.
    { name: "before", takesValue: true },
    // Run a TTL eviction pass and summarize each session into the index BEFORE
    // it is unlinked (the summarize-before-evict hook).
    { name: "evicted", takesValue: false },
    // TTL for the --evicted eviction pass (days). Default: session-store's 30.
    { name: "ttl-days", takesValue: true },
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

// Item 2 — the `dataset` (singular) growth subcommand family:
// `dataset mine` + `dataset synthesize` (+ item-5 `dataset refresh-goldens`).
const DATASET_SCHEMA: ParseArgsSchema = {
  flags: [
    // mine — how many recent sessions to scan (default 50; `all`).
    { name: "sessions", takesValue: true },
    // mine — register accepted candidates into this mined registry dataset
    // (default <spec>-hardcases).
    { name: "out-dataset", takesValue: true },
    // mine — accept/reject quarantined candidates (interactive in a TTY;
    // non-TTY prints the list unless --yes is also given).
    { name: "review", takesValue: false },
    // mine — required in non-TTY alongside --review to promote candidates
    // non-interactively (F3: --review alone must never silently auto-accept).
    { name: "yes", takesValue: false },
    // synthesize — the source dataset (file or registry:<ref>) to grow from.
    { name: "from", takesValue: true },
    // synthesize — how many variants to generate per source sample.
    { name: "count", takesValue: true },
    // synthesize — dollar cap for model paraphrases (budget-gate pattern).
    { name: "budget-usd", takesValue: true },
    // refresh-goldens (item 5) — the dataset whose golds to reconcile.
    { name: "dataset", takesValue: true },
    { name: "min-score", takesValue: true },
    { name: "apply", takesValue: false },
    // Model for synthesize paraphrases / refresh (model-router grammar).
    { name: "model", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 8 — `crewhaus judge calibrate`: pair human ratings with llm_judge
// scores over the rated transcript turns.
const JUDGE_SCHEMA: ParseArgsSchema = {
  flags: [
    // The dataset providing sample context for the judge (file or registry).
    { name: "dataset", takesValue: true },
    // A graders.yaml whose llm_judge rubric to calibrate (else a default rubric).
    { name: "graders", takesValue: true },
    // How many recent sessions' rated turns to calibrate against (default 50; `all`).
    { name: "sessions", takesValue: true },
    // The judge model (model-router grammar); default claude-sonnet-4-5.
    { name: "model", takesValue: true },
    // Persist the calibrated --min-score default to .crewhaus/judge-calibration.json.
    { name: "apply", takesValue: false },
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

// Item 38 — `crewhaus mcp doctor [--probe]`: per-server health scoring, drift
// watch, runtime auto-quarantine decision.
const MCP_SCHEMA: ParseArgsSchema = {
  flags: [
    // Live `listTools` probe for drift watch (offline without it, scoring only).
    { name: "probe", takesValue: false },
    { name: "format", takesValue: true },
    // How many most-recent sessions to score (default 20).
    { name: "sessions", takesValue: true },
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

// AUTOMATION-OPPORTUNITIES.md item 50 — `security corpus [check]`.
const SECURITY_CORPUS_SCHEMA: ParseArgsSchema = {
  flags: [
    // rollup window over session logs: <N>d or ISO (default all-time).
    { name: "since", takesValue: true },
    // harness root that owns .crewhaus/ (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // minimum distinct-snippet cluster support to emit a candidate rule.
    { name: "min-support", takesValue: true },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 20 — `egress review [--propose]`.
const EGRESS_SCHEMA: ParseArgsSchema = {
  flags: [
    // harness root that owns .crewhaus/audit (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // write the eval-gated SpecPatch suggestions to a suggestions.json that
    // `optimize --from-advice` can consume (mirrors `advise -o`).
    { name: "propose", takesValue: false },
    { name: "out", short: "o", takesValue: true },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 51 — `pii tune`.
const PII_SCHEMA: ParseArgsSchema = {
  flags: [
    // how many recent sessions to scan (default 50; `all`).
    { name: "sessions", takesValue: true },
    // harness root that owns .crewhaus/ (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // HMAC key for hashing PII values (also read from CREWHAUS_PII_HASH_SECRET).
    // MUST match the redactor's secret for the emitted policy to apply.
    { name: "secret", takesValue: true },
    // write the reviewed allow-list to <dir>/.crewhaus/pii-policy.json.
    { name: "write", takesValue: false },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 66 — `onchain tune|sentinel`.
const ONCHAIN_SCHEMA: ParseArgsSchema = {
  flags: [
    // receipt-history JSONL (default .crewhaus/onchain/receipts.jsonl).
    { name: "history", takesValue: true },
    // tune — headroom multiplier over observed max spend for the cap (default 1.25).
    { name: "cap-margin", takesValue: true },
    // tune — write the proposed transaction_policy SpecPatch here (default
    // .crewhaus/onchain/policy-patch.json); advice-only when not whitelisted.
    { name: "out", short: "o", takesValue: true },
    // sentinel — baseline history to learn from. When omitted, sentinel
    // self-compares --history against itself using a leave-one-out
    // per-contract max (each receipt's ceiling excludes its own value) so a
    // lone spike is still measured against its peers, not itself. When
    // --baseline is given, --history is the candidate window instead.
    { name: "baseline", takesValue: true },
    // sentinel — anomaly threshold: flag spend > N× the per-contract max (default 2).
    { name: "max-multiple", takesValue: true },
    { name: "json", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 68 — `crewhaus loadtest`.
const LOADTEST_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "concurrency", short: "c", takesValue: true },
    // total requests to send (`-n`).
    { name: "requests", short: "n", takesValue: true },
    { name: "duration", takesValue: true },
    { name: "rps", takesValue: true },
    { name: "format", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // gate mode: exit 1 when p95 latency / error rate exceed the thresholds.
    { name: "gate", takesValue: false },
    { name: "max-p95-ms", takesValue: true },
    { name: "max-error-rate", takesValue: true },
    // deterministic stub-model latency (ms/request) for a credential-free run.
    { name: "stub-latency-ms", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 67 — `crewhaus intents`.
const INTENTS_SCHEMA: ParseArgsSchema = {
  flags: [
    // how many of the cwd spec's most-recent sessions to scan (default 100; `all`).
    { name: "sessions", takesValue: true },
    { name: "format", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    // how many entries to surface per view (default 5).
    { name: "top", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// AUTOMATION-OPPORTUNITIES.md item 52 — `justification calibrate|preflight`.
const JUSTIFICATION_SCHEMA: ParseArgsSchema = {
  flags: [
    // calibrate — how many recent sessions to fold for the outcome proxy.
    { name: "sessions", takesValue: true },
    // harness root that owns .crewhaus/ (mirrors `security digest --dir`).
    { name: "dir", takesValue: true },
    // preflight — the session goal (spec agent.instructions) is read from the
    // <spec> positional; this overrides it for ad-hoc replay.
    { name: "goal", takesValue: true },
    { name: "json", takesValue: false },
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
    // Item 59 — approval gate: a protected env (per .crewhaus/environments.json)
    // needs a recorded approval quorum / green PR check before the pin flips.
    { name: "require-approval", takesValue: false },
    // Consult a PR check as an approval witness (drives `gh pr checks`).
    { name: "check-pr", takesValue: false },
    { name: "help", short: "h" },
  ],
};

// Item 59 — `crewhaus propose <proposed-spec.yaml>`: package a spec change
// into a review artifact + open a PR (the governance wrapper around
// optimize/advise write-back). Never auto-merges.
const PROPOSE_SCHEMA: ParseArgsSchema = {
  flags: [
    // The current spec to diff against (default ./crewhaus.yaml).
    { name: "current", takesValue: true },
    // Provenance: which verb produced the proposal (optimize|advise|model-scan|manual).
    { name: "source", takesValue: true },
    { name: "run-id", takesValue: true },
    // The version label the changelog/PR uses for the proposed spec.
    { name: "as-version", takesValue: true },
    // Eval delta for the PR body (else read from the optimize run if given).
    { name: "score-before", takesValue: true },
    { name: "score-after", takesValue: true },
    { name: "dataset", takesValue: true },
    // Optimize run dir whose provenance the changelog folds in.
    { name: "optimize-dir", takesValue: true },
    // Repo-relative path of the spec file on the branch (default crewhaus.yaml).
    { name: "spec-path", takesValue: true },
    // Assemble the bundle + print the plan without touching git/gh.
    { name: "dry-run", takesValue: false },
    // Item 29 — `deploy canary <spec> <version>` eval-gated ramp flags.
    { name: "traffic", takesValue: true },
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "env", takesValue: true },
    { name: "name", takesValue: true },
    { name: "from", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "judge-model", takesValue: true },
    // Gate threshold overrides (regression-runner GateThresholds).
    { name: "max-pass-rate-drop", takesValue: true },
    { name: "max-p95-latency-ms", takesValue: true },
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

// Item 32 — `crewhaus incident collect --session <id>`: assemble a full
// incident bundle from a session's traces/audit/cost + doctor.
const INCIDENT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "kind", takesValue: true },
    { name: "reason", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

// Item 43 — `crewhaus upgrade`: detect the cwd spec's version drift vs the
// current CLI's spec version, run the migration chain (validated), show a diff.
// --dry-run (default) previews; --write applies.
const UPGRADE_SCHEMA: ParseArgsSchema = {
  flags: [{ name: "dry-run" }, { name: "write" }, { name: "help", short: "h" }],
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
    "  compile <spec.yaml> --watch          re-run parse→lint→compile on every change (item 41)",
    "  lint [spec.yaml] [--fix]             check-only: parse + ir-passes (§47 chain / graph-crew",
    "       [--format text|json]            well-formedness the CLI compile path skips) + scope audit,",
    "                                       WITHOUT emitting; --fix does nearest-match/typo repairs (item 41)",
    "  run <spec.yaml> [--model <model>]    compile in-memory and execute the agent",
    "                  [--watch]            re-validate on change (authoring aid; does not re-launch)",
    "                  [--resume <id>]      resume a specific session (cli targets only)",
    "                  [--continue]         resume the most-recent session (cli targets only)",
    "                  [--prompt <text>]    run one turn and exit, printing the reply (cli: no REPL; browser: the single-turn input, else stdin)",
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
    "  eval coverage                        detect prod behaviors no eval sample exercises (item 6):",
    "       [--sessions N|all] [--dataset <d>]  tool/MCP/bigram/compaction gaps ranked by prod",
    "       [-o <dir>] [--format text|html|json] frequency; json is a backlog for `dataset mine`",
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
    "       [--interactive] [--detect]      interview-driven spec authoring (model, or scripted",
    "                                       fallback with no credentials); validated via parseSpec (item 39)",
    "       [--ci]                          also scaffold .github/workflows/crewhaus-eval.yml —",
    "                                       eval-gated spec PRs (base vs PR spec, two fresh runs,",
    "                                       score-delta PR comment, check fails on regression);",
    "                                       with an existing crewhaus.yaml, adds just the workflow",
    "       [--with-evals]                  also scaffold eval/dataset.jsonl + eval/graders.yaml",
    "                                       (item 13; offline template mode — no credentials needed)",
    "       [--force]                       overwrite an existing scaffolded workflow / eval assets",
    "  scaffold-evals <spec.yaml>           day-one eval assets FROM the spec (item 13): sample",
    "       [-o <dir>] [--samples N]        stubs derived from agent.instructions (one model call",
    "       [--model <m>] [--force]         with credentials, deterministic template without) +",
    "                                       ONE starter grader (spec-goal llm_judge rubric online,",
    "                                       non-empty-answer floor grader offline)",
    "  graders suggest [-o <file>]          draft grader suites from failure rationale (item 4):",
    "       [--runs <dir|last:N>]           clusters grades.json rationale (via the run-history",
    "       [--model <m>] [--spec <name>]   index), judge criterionScores, and rating comments",
    "       [--min-score F] [--force]       into themes; drafts deterministic graders per theme",
    "                                       (+ an llm_judge rubric with --model/credentials) into",
    "                                       a REVIEW file — never auto-applied",
    "  doctor                               check environment health",
    "       [--philosophy-alignment [--json] [--baseline | --accept-baseline]]  pillar audit + scope-audit drift gate (item 49)",
    "       [--detect [--no-probe]]         inventory reachable providers/local models/MCP servers (item 40)",
    "       [--fix]                         apply mechanical remediations (dry-run by default) (item 40)",
    "  context --bundle [-o <file>]         emit a single-markdown orientation manifest",
    "       [--factory-root <p>] [--docs-root <p>] [--demos-root <p>]",
    "  cost-summary --session <id>          summarize cost_accrual events for a session",
    "  route status [--dir <root>]          show the adaptive model_pool reward scoreboard",
    "  route explain <session> [--dir <r>]  replay a run's per-turn model_route decisions",
    "  route reset  [--dir <root>]          wipe the scoreboard (default root .crewhaus)",
    "  advise [--session <id> | --all]      mine session logs for spec advice (item 14)",
    "       [--json] [-o <dir>]             writes suggestions.json + report.html (default .crewhaus/advice)",
    "  tools list                           list every builtin tool + its metadata (item 18)",
    "  tools suggest [spec.yaml]            rank builtins against agent.instructions (keyword match)",
    "  tools audit [--sessions N|all]       mine tool_stats vs. grants — unused/failing/readOnly",
    "  permissions suggest [--apply]        mine ask/deny history into settings.json rules (item 16)",
    "       [--sessions N|all] [--json]     --apply is interactive-confirm only (never eval-gated)",
    "  rate --session <id> [--turn N]       rate an assistant turn 👍/👎, ⭐, or 0–1",
    "       (--thumbs up|down | --stars 1-5 | --score 0-1) [--comment <t>]",
    "  feedback --session <id> --text <msg> attach a comment/correction to a turn",
    "       [--turn N] [--correction <better answer>]",
    "  distill --session <id> -o <ds.jsonl> turn ratings into an eval dataset + graders",
    "       [--all-sessions] [--graders-out <g.yaml>] [--min-score F]",
    "       [--register <name>]            also promote a new dataset version into the registry",
    "  fewshot harvest [--all-sessions]     harvest up-rated turns into a golden few-shot pool (#54)",
    "       [--min-score F] [-o <pool>]     (PII/secret-redacted); optimize with --few-shot",
    "  fewshot show [--k N]                 print the pool as the injectable prompt block",
    "  faq distill [--sessions N|all]       cluster recurring questions into an auto-discovered FAQ skill (#55)",
    "       [--min-score F] [--min-occurrences N] [-o <skill-dir>]",
    "  lessons update [--sessions N|all]    mine corrections + failures into an auto-loaded LESSONS.md (#56)",
    "       [--low-score F] [-o <LESSONS.md>]  + per-user prefs under .crewhaus/preferences/",
    "  sessions summarize [--before <date>] summarize sessions into a durable index before TTL eviction (#57)",
    "       [--evicted] [--ttl-days N]        --evicted indexes each session just before it is deleted",
    "  datasets list                        all registered datasets + versions (Section 29)",
    "  datasets get <name>[@version]        print a dataset's samples as JSONL",
    "       [--split train|dev|test]",
    "  datasets put <name> --file <f.jsonl> import a file as a new auto-bumped version",
    "       [--split-spec 70/15/15 | --split train]",
    "  dataset mine [--sessions N|all]      mine hard cases from session struggle signals (item 2):",
    "       [--out-dataset <name>] [--review]   tool-errors/loops/retries/egress → quarantine;",
    "                                           --review promotes accepted into a mined dataset",
    "  dataset synthesize --from <f|reg>    PII-redacted stress variants (item 2): paraphrase,",
    "       [--count N] [--budget-usd N]        truncate, ambiguate, inject → separate synthetic",
    "       [--out-dataset <name>]              split (never contaminates human golds)",
    "  dataset refresh-goldens              reconcile corrections/up-rated turns with golds (item 5):",
    "       --dataset <file|registry:ref>       propose gold updates as a review diff; --apply writes",
    "       [--min-score F] [--apply]           a NEW registry version (never in-place)",
    "  judge calibrate                      calibrate an llm_judge against human ratings (item 8):",
    "       [--graders <g.yaml>] [--model <m>]  correlation/bias/ROC-optimal cut over paired",
    "       [--sessions N|all] [--apply]        (human rating, judge score); --apply writes the cut",
    "  state backup [-o <file.tar.gz>]      snapshot the cwd .crewhaus state dir to a tarball (item 69)",
    "       [--exclude <glob,glob>]",
    "  state restore <file.tar.gz>          restore a snapshot (refuses a non-empty .crewhaus)",
    "       [--into <dir>] [--force] [--merge feedback|all]",
    "  secrets doctor                       list known secrets via the configured backend",
    "  secrets rotate <name> [--value V]    rotate a named secret (file backend)",
    "  fleet list|status|run <sub> ...      cross-harness inventory/health + bulk read-ops (item 58)",
    "  knowledge sync [--pull|--push]       cross-harness shared memories/graders/prompts (item 63)",
    "  retire <spec> [--dry-run] [--force]  audited harness decommissioning (item 64)",
    "  plugins list|search|install|...      marketplace plugins CLI + publish/outdated (item 60)",
    "  templates list|search|use ...        marketplace templates CLI (item 60)",
    "  spec put|list|get|pin|alias|log ...  versioned spec storage + changelog (Section 28 spec-registry)",
    "  deploy promote|rollback ...          re-pin a spec for an environment (Section 28)",
    "       promote --require-approval      gate a protected env on an approval quorum (item 59)",
    "  propose <proposed.yaml> ...          package a spec change + open a review PR (item 59)",
    "  deploy canary <spec> <version> ...   eval-gated ramp with auto-rollback (item 29):",
    "       --traffic 5,25,50,100 --dataset <d> --graders <g>  eval both versions per step,",
    "                                       gate on regression-runner, auto-promote/rollback",
    "  incident collect --session <id>      assemble an incident bundle from a session's",
    "                                       traces + audit + cost + doctor (item 32)",
    "  migrate-all --from N --to N          batch-migrate every spec in the registry",
    "  upgrade [spec.yaml] [--write]        detect the cwd spec's version drift + run the migration",
    "                                       chain (validated); --dry-run diff by default (item 43)",
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
    "  mcp doctor [--probe]                 per-server MCP health scoring, drift watch, auto-quarantine (item 38)",
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
        "  --with-eval-harness  Also emit an eval bridge — a target: eval bundle\n" +
        "             projected from THIS (non-cli) shape's own agent — into\n" +
        "             <out-dir>/eval/, so the shape can consume its distilled\n" +
        "             feedback through eval/optimize/flywheel. Rejected for cli\n" +
        "             (use `crewhaus eval` directly) and multi-stage shapes.\n" +
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
    const evalBundle = emitEval(projected, { readme });
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
      "usage: crewhaus init [name] [--ci] [--with-evals] [--sentinel] [--force]\n" +
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
        content: buildSentinelDriftWorkflowYaml({ harnessDir }),
        force: args.flags["force"] === true,
      });
      process.stdout.write(`wrote ${scaffolded.path}\n`);
      const filterBase = harnessDir === "" ? "" : `${harnessDir}/`;
      process.stdout.write(
        `sentinel: set the ANTHROPIC_API_KEY repo secret, add a seed-pinned\n    ${filterBase}eval/sentinel.jsonl, then freeze the baseline once:\n    crewhaus eval ${filterBase}crewhaus.yaml --dataset ${filterBase}eval/sentinel.jsonl \\\n      --graders ${filterBase}eval/graders.yaml --seed 1 -o ${filterBase}eval/sentinel-baseline\n    and commit ${filterBase}eval/sentinel-baseline. The nightly cron then flags provider drift.\n`,
      );
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
      "usage: crewhaus scaffold-evals <spec.yaml> [-o <out-dir>] [--samples N] [--model <m>] [--force]\n" +
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
  // The runtime resolves eval assets relative to the invocation cwd, so
  // print the command as run from the spec's directory.
  const specDir = dirname(absSpec);
  const rel = relative(process.cwd(), specDir);
  const cd = rel === "" ? "" : `cd ${rel} && `;
  process.stdout.write(
    `next: ${cd}crewhaus eval ${basename(absSpec)} --dataset ${relative(specDir, written.datasetPath)} --graders ${relative(specDir, written.gradersPath)}\n`,
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
 * Item 39 — `crewhaus init --interactive`. Promotes the demos harness-designer
 * into core: interview the user and emit a `parseSpec`-validated crewhaus.yaml.
 *
 * Two paths, chosen by credential availability (like the merged scaffold path):
 *   - Credentials present → the MODEL interview. `runInterview` (side-effect-
 *     free) drives a validate-and-retry loop: the model calls `emit_spec` with
 *     a draft, `parseSpec` validates it in-process, and any structured error is
 *     fed back for a corrected re-emit. No demos dependency — the shape
 *     guidance is bundled in `init-interactive.ts`.
 *   - No credentials → a scripted stdin questionnaire (name/shape/model/tools)
 *     that still emits a `parseSpec`-validated spec via `buildScriptedSpec`.
 *
 * Reuses `runInit`'s exists-check/refuse-overwrite + standalone-dir guidance,
 * and composes with `--detect` (#40) to prefill the default model from a
 * reachable local endpoint / provider.
 */
async function runInitInteractive(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus init --interactive [name] [--detect]\n" +
        "  Interview-driven spec authoring. With credentials, an agent interviews you\n" +
        "  and emits a validated crewhaus.yaml (every draft is checked against the live\n" +
        "  spec schema and retried on error). Without credentials, a scripted\n" +
        "  questionnaire (name/shape/model/tools) still emits a validated spec.\n" +
        "  --detect  prefill the default model from a reachable local endpoint/provider.\n",
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
  let defaultModel = "claude-opus-4-7";
  if (args.flags["detect"] === true) {
    const prefill = await detectDefaultModel();
    if (prefill !== undefined) defaultModel = prefill;
  }

  // Credential-gated path selection: try to resolve the default model's adapter.
  // A resolution failure (no credentials / missing optional adapter) degrades
  // to the scripted questionnaire.
  const interviewer = await tryBuildInterviewer(defaultModel);
  const reader = createLineReader();
  let yaml: string;
  try {
    if (interviewer !== undefined) {
      process.stdout.write(
        `interactive spec authoring (model: ${interviewer.modelId}). Describe the agent you want to build.\n`,
      );
      const description = await reader.ask("> ");
      if (description === "") die("no description given — aborting");
      const result = await runInterview({
        proposeSpec: (feedback) => interviewer.propose(description, feedback),
      });
      yaml = result.yaml;
      process.stdout.write(`validated after ${result.attempts} draft(s).\n`);
    } else {
      process.stdout.write(
        "no model credentials detected — falling back to the scripted questionnaire.\n",
      );
      yaml = (await runScriptedQuestionnaire({ reader, specName, defaultModel })).yaml;
    }
  } finally {
    reader.close();
  }

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetFile, yaml);
  process.stdout.write(`wrote ${targetFile}\n`);
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
 * Item 39 — attempt to build the model interviewer for `model`. Resolves the
 * adapter via the same `resolveModel` path the scaffold-evals/mutator use;
 * returns undefined when no credentials/adapter are available so the caller
 * degrades to the scripted questionnaire. The returned `propose` closure runs
 * one interview turn: it sends the system prompt + description + the running
 * validation-feedback log and returns the `emit_spec` YAML (or undefined).
 */
async function tryBuildInterviewer(model: string): Promise<
  | {
      readonly modelId: string;
      propose: (desc: string, feedback: readonly string[]) => Promise<string | undefined>;
    }
  | undefined
> {
  try {
    const { resolveModel } = await import("@crewhaus/model-router");
    const { collectFinalMessage, extractToolUse } = await import("@crewhaus/adapter-anthropic");
    const resolution = await resolveModel(model);
    const system = buildInterviewSystemPrompt();
    const propose = async (
      desc: string,
      feedback: readonly string[],
    ): Promise<string | undefined> => {
      const feedbackText =
        feedback.length > 0
          ? `\n\nYour previous draft(s) failed validation with:\n${feedback
              .map((f) => `- ${f}`)
              .join("\n")}\nEmit a corrected spec.`
          : "";
      const final = await collectFinalMessage(
        resolution.adapter.stream({
          model: resolution.modelId,
          system: [{ type: "text", text: system }],
          messages: [{ role: "user", content: `Build this agent: ${desc}${feedbackText}` }],
          tools: [EMIT_SPEC_TOOL],
          toolChoice: { type: "tool", name: EMIT_SPEC_TOOL.name },
          maxTokens: 4096,
        }),
      );
      const toolUse = extractToolUse(final, EMIT_SPEC_TOOL.name);
      const yaml = (toolUse?.input as { yaml?: unknown } | undefined)?.yaml;
      return typeof yaml === "string" && yaml.length > 0 ? yaml : undefined;
    };
    return { modelId: resolution.modelId, propose };
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
        "  --prompt <text> runs a single turn non-interactively and prints the reply, then exits (no REPL) — for scripting/CI; composes with --resume/--continue\n" +
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

  const modelOverride = args.flags["model"];
  const model = typeof modelOverride === "string" ? modelOverride : ir.agent.model;

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

  // Feature #53 — first-class `memory:` block. Its presence wires Remember/
  // Recall into the tool list (no hand-editing) and — via the auto-* switches
  // — the runtime's auto-recall (system-prompt injection) and auto-capture
  // (summarize durable outcomes into the store at teardown). Mirrors the
  // codegen registration in @crewhaus/target-cli.
  let memoryRunOpt: Parameters<typeof runChatLoop>[0]["memory"];
  if (ir.memory !== undefined && ir.memory.enabled !== false) {
    const memoryStore = createMemoryStore({ specName: ir.name });
    const memoryBundle = createMemoryTools({ specName: ir.name, store: memoryStore });
    tools.push(memoryBundle.remember, memoryBundle.recall);
    const decision = deriveMemoryDecision(ir.memory, Number.MAX_SAFE_INTEGER);
    process.stdout.write(
      `[memory] Remember/Recall wired (autoRecall=${decision.recall}, autoCapture=${ir.memory.autoCapture === true})\n`,
    );
    memoryRunOpt = {
      ...(decision.recall
        ? {
            autoRecall: true,
            recallK: decision.recallK,
            recall: async (query, k) => {
              const results = await memoryStore.recall(query, k);
              return results.map((r) => r.entry.text);
            },
          }
        : {}),
      ...(ir.memory.autoCapture === true
        ? {
            autoCapture: true,
            onCapture: async (completedTurns, sessionId) => {
              const { capture } = deriveMemoryDecision(ir.memory, completedTurns);
              if (!capture) return;
              const events = parseJsonlObjects(
                readFileSync(sessionJsonlPath(sessionId), "utf-8"),
              ) as Array<{ kind?: string; payload?: unknown }>;
              const turns = deriveTurns(events);
              const facts = summarizeDurableFacts(turns);
              const written = await captureFacts(memoryStore, facts, ["auto-capture", sessionId]);
              if (written.length > 0) {
                process.stdout.write(
                  `[memory] auto-captured ${written.length} durable fact(s) into ${memoryStore.path()}\n`,
                );
              }
            },
          }
        : {}),
    };
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
      // Item 22 — provider failover chain: thread `agent.model_fallbacks` +
      // `agent.circuit_breaker` through to the runtime, mirroring the
      // target-cli codegen path. Skipped when `--model` overrides the
      // primary — a flag-forced model is an explicit routing decision and
      // the spec's fallback chain was authored against the spec's primary.
      ...(ir.target === "cli" &&
      typeof modelOverride !== "string" &&
      ir.agent.modelFallbacks !== undefined &&
      ir.agent.modelFallbacks.length > 0
        ? { modelFallbacks: ir.agent.modelFallbacks }
        : {}),
      ...(ir.target === "cli" && ir.agent.circuitBreaker !== undefined
        ? { circuitBreaker: ir.agent.circuitBreaker }
        : {}),
      // Item 26 — two-tier turn-difficulty router. A `--model` override
      // forces a single model, so tiers apply only without an override.
      ...(ir.target === "cli" &&
      typeof modelOverride !== "string" &&
      ir.agent.modelTiers !== undefined
        ? { modelTiers: ir.agent.modelTiers }
        : {}),
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
      // Item #56 — inject the current user's preference file at run start (via
      // the project-memory auto-load path). LESSONS.md is auto-loaded already
      // as a canonical memory file, so no extra wiring is needed for it.
      ...(preferenceFiles.length > 0 ? { preferenceFiles } : {}),
    });
  } finally {
    if (mcpHost) await mcpHost.disconnectAll();
  }

  // One-shot (`--prompt`): emit the final assistant message to stdout so it
  // can be piped/captured. The REPL path streams as it goes and returns the
  // same trailing text, so only print it in one-shot mode.
  if (oneShotPrompt !== undefined && oneShotResult !== undefined) {
    process.stdout.write(`${oneShotResult}\n`);
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

  // Item #54 — few-shot injection. When `--few-shot <pool|auto>` is set, prepend
  // the top-K harvested examples to the spec's `agent.instructions` in an
  // in-memory augmented temp spec that the optimizer + fitness run against, so
  // the mutation search improves the prompt WITH the in-context demonstrations
  // present. The source spec is never mutated on this path (patch-only), so the
  // examples don't accidentally get baked into the tracked spec; re-run without
  // --few-shot (or edit instructions) to persist them.
  const fewShotFlag = strFlag(args, "few-shot");
  let optimizeSpecPath = absSpec;
  let fewShotDisablesWriteBack = false;
  if (typeof fewShotFlag === "string") {
    const poolFile =
      fewShotFlag === "auto"
        ? join(
            dirname(absSpec),
            FEWSHOT_SUBDIR,
            `${parseSpec(readFileSync(absSpec, "utf-8")).name}.jsonl`,
          )
        : resolve(fewShotFlag);
    const pool = readFewShotPool(poolFile);
    if (pool.length === 0) {
      die(`no few-shot pool at ${poolFile} — run \`crewhaus fewshot harvest\` first`);
    }
    const fewShotK = intFlag(args, "few-shot-k") ?? 5;
    const block = formatFewShotForPrompt(pool, fewShotK);
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
      `[optimize] injected ${Math.min(fewShotK, pool.length)} few-shot example(s) from ${poolFile}\n`,
    );
    if (writeBack) {
      process.stderr.write(
        "[optimize] --write-back is ignored with --few-shot (the augmented spec is patch-only to keep the tracked spec clean)\n",
      );
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
    // Item #54 — read the (possibly few-shot-augmented) optimize spec so the
    // fitness eval sees the same in-context examples the search mutates around.
    const yamlText = readFileSync(optimizeSpecPath, "utf-8");
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
    specPath: optimizeSpecPath,
    fitness,
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
        "  conventional eval/dataset.jsonl next to the cwd spec. --format json emits a\n" +
        "  ranked backlog consumable by `crewhaus dataset mine`.\n",
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
  const samples: CoverageSample[] = [];
  let datasetName: string | undefined;
  let datasetResolved = false;
  try {
    const registryRef = parseRegistryRef(datasetArg);
    if (registryRef !== undefined) {
      const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
      const resolved = await resolveRegistryRef(registry, registryRef);
      for (const s of resolved.samples) samples.push(s);
      datasetName = resolved.datasetName;
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
  const entries = readRunIndex().filter((e) => specName === undefined || e.specName === specName);
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

  const evalCov = buildEvalCoverage(samples, runEventTexts);
  const report = computeCoverage({
    prod,
    evalCov,
    ...(specName !== undefined ? { specName } : {}),
    ...(datasetName !== undefined ? { datasetName } : {}),
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
 * Item 65 — `crewhaus eval --voice`: replay recorded call-session logs through
 * the voice grader pack (latency / barge-in / transcript). Reads every
 * `*.jsonl` under --replay-dir (default `.crewhaus/voice-replays`), grades each
 * against the latency budgets, renders a report, and writes a machine-readable
 * `voice-eval.json`. Exits non-zero when any session fails a grader (a
 * pre-deploy voice gate). Credential-free + deterministic — no live audio.
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
  const results: VoiceSessionResult[] = [];
  for (const f of files) {
    const sessionId = f.slice(0, -".jsonl".length);
    const jsonl = readFileSync(join(replayDir, f), "utf-8");
    let result: VoiceSessionResult;
    try {
      result = gradeVoiceSession(parseReplayLog(sessionId, jsonl), thresholds);
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
        "  remaining cells still run; the command then exits non-zero.\n" +
        "  --sentinel --baseline <run-dir> runs the model-drift sentinel (item 30):\n" +
        "  re-run this dataset against the UNCHANGED spec and diff against the frozen\n" +
        "  baseline run dir. Pin --seed for a deterministic sample order. When the spec's\n" +
        "  specHash AND the dataset's content hash are BOTH identical to the baseline's,\n" +
        "  any pass/fail flip or score shift can only be the provider silently changing\n" +
        "  model behaviour — the command flags it and exits non-zero so a CI cron alerts.\n" +
        "  A specHash or dataset-hash mismatch is reported as not-comparable (also exits\n" +
        "  non-zero — a mis-pointed sentinel is loud, never silently green). Sentinel mode\n" +
        "  skips the run-history index/baselines/triage and the regression union (a probe,\n" +
        "  not lineage); --gate/--no-promote/--models are rejected with it.\n",
    );
    return;
  }
  // Item 65 — voice replay eval branches off before the text-eval flags: it
  // reads recorded call-session JSONLs, not a dataset/graders.yaml.
  if (args.flags["voice"] === true) {
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
  const { compiled, config: gradersConfig } = parseGradersConfig(gradersYaml);
  // F2 — sha256 of the parsed graders config, recorded into run.json/
  // results.json so `--sentinel` can assert a fresh run graded with the same
  // rubric/thresholds as the baseline (see hashGradersConfig doc comment).
  const gradersHash = hashGradersConfig(gradersConfig);

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
      gradersHash,
      retryErrors,
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
    },
  });
  // With -o omitted the runner picks .crewhaus/evals/<runId> relative to the
  // cwd — resolve to an absolute path for the report + history index.
  const absOut = resolve(summary.outDir);

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
    process.stdout.write(
      `[eval] runId=${summary.runId} pass_rate=${(summary.aggregates.passRate * 100).toFixed(1)}% ` +
        `mean_score=${summary.aggregates.meanScore.toFixed(3)}\n`,
    );
    process.stdout.write(`[eval] report: ${join(absOut, "index.html")}\n`);
    process.stdout.write(`[sentinel] ${result.verdict}: ${result.reason}\n`);
    if (result.alert) {
      die(`sentinel drift detected — ${result.reason}`);
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

/** `dataset` dispatcher — mine / synthesize / refresh-goldens (item 5). */
async function runDataset(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (args.flags["help"] && action === undefined) {
    process.stdout.write(
      "usage: crewhaus dataset <mine|synthesize|refresh-goldens> [...]\n" +
        "  mine            grow the dataset from production struggle signals (item 2)\n" +
        "  synthesize      generate PII-redacted stress variants of a source dataset (item 2)\n" +
        "  refresh-goldens reconcile user corrections with existing golds (item 5)\n",
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
      default:
        die(
          `dataset: unknown action "${action ?? ""}" — supported: mine, synthesize, refresh-goldens`,
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
        "  Scan .crewhaus/sessions/*.jsonl (this spec) for hard cases needing NO\n" +
        "  rating — error events, tool_result isError spikes, the synthetic\n" +
        "  '[runtime] possible loop detected' nudge, consecutive near-duplicate\n" +
        "  user retries — plus egress_decision blocks from .crewhaus/audit (if any).\n" +
        "  Each triggering turn's input becomes a candidate Sample in a QUARANTINE\n" +
        "  staging file (.crewhaus/datasets/_quarantine/<spec>-hardcases.jsonl).\n" +
        "  --review accepts/rejects candidates: interactive in a TTY ([a]ccept /\n" +
        "  [r]eject / [s]kip); in non-TTY it only PRINTS the candidates unless --yes\n" +
        "  is also given, in which case ALL listed candidates promote. This keeps a\n" +
        "  scripted/CI --review from silently promoting unreviewed candidates.\n" +
        "  Accepted candidates promote into the <spec>-hardcases (or --out-dataset)\n" +
        "  mined registry version with provenance in metadata (source: mine, signal,\n" +
        "  sessionId).\n",
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
  for (const id of ids) raw.push(...mineSession(id, readSessionEvents(id)));

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

  // Always (re)write the quarantine staging file.
  const quarantineDir = join(process.cwd(), QUARANTINE_SUBDIR);
  mkdirSync(quarantineDir, { recursive: true });
  const quarantinePath = join(quarantineDir, `${specName}-hardcases.jsonl`);
  const quarantineSamples = candidates.map(candidateToSample);
  writeFileSync(quarantinePath, `${quarantineSamples.map((s) => JSON.stringify(s)).join("\n")}\n`);
  process.stdout.write(
    `[dataset mine] ${candidates.length} candidate(s) quarantined → ${quarantinePath}\n`,
  );

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
    samples: accepted.map(candidateToSample),
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
        "  via --budget-usd) when a model is available.\n",
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
        "  NEW dataset-registry version (never in-place). Sample content hashes give\n" +
        "  provenance.\n",
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
  const registryRef = parseRegistryRef(datasetArg);
  const samples: Sample[] = [];
  let datasetLabel: string;
  let registryName: string | undefined;
  if (registryRef !== undefined) {
    const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
    const resolved = await resolveRegistryRef(registry, registryRef);
    for (const s of resolved.samples) samples.push(s);
    datasetLabel = resolved.datasetName;
    registryName = registryRef.name;
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
  const runEntries = readRunIndex().filter(
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

  const updated = applyProposals(samples, result.proposals);
  const registry = createFileBackedRegistry({ rootDir: defaultDatasetsRoot() });
  // Registry name is guaranteed defined here (checked above).
  const rec = await registerDataset({ registry, name: registryName as string, samples: updated });
  process.stdout.write(
    `[refresh-goldens] applied ${result.proposals.length} gold update(s) → ${rec.name}@${rec.version} (new version; prior versions untouched)\n`,
  );
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
        "  .crewhaus/judge-calibration.json (a file distill/optimize could later read).\n",
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
  if (rated.length === 0) {
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
    const judgeEntry = compiled.find((g) => g.judgeSpec !== undefined);
    if (judgeEntry?.judgeSpec === undefined) {
      die(`--graders "${gradersPath}" has no llm_judge grader to calibrate`);
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
  if (pairs.length === 0) {
    die(`the judge model "${judgeModel}" produced no usable scores (${judgeFailures} failure(s))`);
  }

  const card = buildCalibrationCard(pairs, {
    ...(specName !== undefined ? { specName } : {}),
    model: judgeModel,
  });
  process.stdout.write(renderCalibrationCard(card));
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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
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
        "mines .crewhaus/sessions (+ .crewhaus/audit) for spec advice:\n" +
        "  repeated tool failures, max_tokens truncation pressure, compaction\n" +
        "  thrash, permission-ask churn, stop-reason anomalies, learned\n" +
        "  failure_taxonomy + loop-break rules, sub-agent splits under\n" +
        "  chronic context pressure\n" +
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
  // Item 4 — the synthesis fell back to the floor grader (no consistent
  // tool/phrase signal in the ratings): point at the failure-rationale
  // drafting path, which mines eval runs the ratings can't see.
  if (isFloorGraderConfig(result.graders)) {
    process.stdout.write(`[distill] ${FLOOR_GRADER_HINT}\n`);
  }
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
  if (args.flags["help"] === true && action === undefined) {
    process.stdout.write(
      "usage: crewhaus sessions summarize [--before <date>] [--evicted] [--ttl-days N]\n" +
        "  Summarize sessions (outcome, tools, ratings, key facts) into the durable\n" +
        "  .crewhaus/sessions-index/ before their transcripts expire (30-day TTL).\n" +
        "  --evicted runs a TTL eviction pass and indexes each session just before it is deleted.\n",
    );
    return;
  }
  if (action !== "summarize") {
    die(`sessions: unknown action "${action ?? ""}" — supported: summarize`);
  }
  const sessionsDir = join(process.cwd(), SESSIONS_SUBDIR);
  const indexDir = join(process.cwd(), ".crewhaus", SESSIONS_INDEX_DIRNAME);

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
    const entries = readRunIndex().filter((e) => specName === undefined || e.specName === specName);
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
    process.stdout.write(
      "usage:\n" +
        "  crewhaus fleet list [--root <dir>]                  cross-harness inventory\n" +
        "  crewhaus fleet status [--root <dir>]                per-harness health rollup\n" +
        "  crewhaus fleet run <sub> [--filter <glob>] [--root <dir>]\n" +
        "                                                     bulk-run a read-only subcommand\n" +
        "         [--allow-mutating] [--yes]                  across the filtered fleet\n" +
        "\n" +
        "  A harness is any directory carrying a crewhaus.yaml (the standalone-harness\n" +
        "  convention). Discovery skips .crewhaus/, node_modules/, .git/, dist/.\n" +
        "  Read-only bulk subcommands: eval, doctor, security digest, audit verify.\n" +
        "  A mutating subcommand requires --allow-mutating and per-harness confirmation.\n",
    );
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
    readRunIndex(evalsDir).map((e) => ({
      datasetName: e.datasetName,
      passRate: e.passRate,
      ts: e.ts,
    }));

  const deps: BuildInventoryDeps = { readManifest, readEvalIndex };

  try {
    if (action === "list") {
      const rows = await buildFleetInventory(root, deps);
      for (const line of formatFleetInventory(rows, root)) process.stdout.write(`${line}\n`);
      return;
    }
    if (action === "status") {
      const rows = await buildFleetInventory(root, deps);
      // Eval health: the last run for a (spec, its pinned dataset) baseline
      // held or beat the baseline's pass rate. No baseline yet → healthy (a
      // fresh harness isn't "attention"); a last run below the pinned
      // baseline → attention.
      const readEvalHealth: EvalHealthReader = (evalsDir) => {
        const runs = readRunIndex(evalsDir);
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
      // array through Bun.spawn. The child inherits this process's argv[0]
      // (the running CLI) so a bulk `doctor` runs the SAME binary.
      const runner: FleetRunner = async ({ cwd, argv }) => {
        const proc = Bun.spawn([process.execPath, process.argv[1] as string, ...argv], {
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

      const report = await runFleetBulk({
        root,
        subcommandTokens: tokens,
        ...(filter !== undefined ? { filter } : {}),
        allowMutating,
        deps,
        runner,
        confirm,
      });
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
        "  http(s):// index; falls back to CREWHAUS_PLUGIN_REGISTRY. Install respects\n" +
        "  plugin-registry's fail-closed signature verification; --allow-unsigned opts\n" +
        "  out for local development.\n",
    );
    return;
  }

  const pluginsDirFlag = args.flags["plugins-dir"];
  const pluginsDir = typeof pluginsDirFlag === "string" ? pluginsDirFlag : defaultPluginsDir();
  const registryFileFlag = args.flags["registry-file"];
  const registryPath =
    typeof registryFileFlag === "string" ? registryFileFlag : defaultPluginRegistryPath();
  const allowUnsigned = args.flags["allow-unsigned"] === true;
  const registryRef =
    typeof args.flags["registry"] === "string"
      ? args.flags["registry"]
      : process.env["CREWHAUS_PLUGIN_REGISTRY"];

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
        "  http(s):// index; falls back to CREWHAUS_TEMPLATE_REGISTRY.\n",
    );
    return;
  }
  const registryRef =
    typeof args.flags["registry"] === "string"
      ? args.flags["registry"]
      : process.env["CREWHAUS_TEMPLATE_REGISTRY"];
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
        process.stdout.write(`${t.name} v${t.version} (${t.target}) — ${t.author}\n`);
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
        "    --graders <graders.yaml> grader config\n" +
        "    --from <version>         baseline version (default: the env's current pin)\n" +
        "    --env <env>              env pin to promote/rollback (default: prod)\n" +
        "    --name <name>            registry spec name (default: the spec's own name)\n" +
        "    --concurrency N --seed N --judge-model <m>   eval knobs (as `crewhaus eval`)\n" +
        "    --max-pass-rate-drop <f> gate: max pass-rate drop before fail (default 0.05)\n" +
        "    --max-p95-latency-ms <n> gate: max p95 latency rise ms before fail (default 5000)\n" +
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
        "  a serving-path route() consumer — out of scope for target: cli here.\n",
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
    const resolved = await resolveRegistryRef(dsReg, registryRef);
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

  const gate = makeRegressionGate(
    makeCanaryEvalGate({ evalVersion, thresholds: gateThresholds, write }),
  );

  const result = await driveCanaryRamp({
    steps,
    write,
    evaluateStep: (trafficPercent) =>
      canary.evaluate(
        {
          name: specName,
          fromVersion: baselineVersion as string,
          toVersion: candidateVersion,
          trafficPercent,
          env,
          ...(tenantId !== undefined ? { tenantId } : {}),
        },
        { intervalMs: 0, gate },
      ),
  });

  if (result.promoted) {
    write(`[canary] PROMOTED ${specName} ${env} → ${candidateVersion}`);
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
      "usage: crewhaus upgrade [spec.yaml] [--dry-run] [--write]\n" +
        "  Detect the spec's schema-version drift vs this CLI's current spec version\n" +
        "  and run the migration chain (each migrated spec is validated via parseSpec\n" +
        "  before it can be written). Defaults to ./crewhaus.yaml and to a dry-run diff.\n" +
        "  --write   apply the migration in place (rewrites the spec file).\n",
    );
    return;
  }
  const write = args.flags["write"] === true;
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

  if (plan.action === "upgrade" && write && plan.migratedYaml !== undefined) {
    writeFileSync(absSpec, plan.migratedYaml);
  }
  process.stdout.write(formatUpgradePlan(plan, write));
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
    let mcpServers: Record<string, import("@crewhaus/mcp-host").McpServerConfig> = {};
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
      for (const [name, cfg] of Object.entries(mcpServers)) host.addServer(name, cfg);
      const nowIso = new Date().toISOString();
      await Promise.all(
        Object.keys(mcpServers).map(async (name) => {
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
    // Item 6 — `eval coverage` is a distinct read-side report with its own
    // flags; every other `eval …` invocation is the run path.
    if (rest[0] === "coverage") {
      try {
        await runEvalCoverage(parseFor(rest.slice(1), EVAL_COVERAGE_SCHEMA));
      } catch (err) {
        if (err instanceof CrewhausError) die(err.message);
        throw err;
      }
    } else {
      await runEvalSubcommand(parseFor(rest, EVAL_SCHEMA));
    }
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
  case "fleet": {
    // Item 58 — list | status | run <sub>. `run` takes a subcommand as
    // positionals after the action, so the schema is parsed over the tail.
    const action = rest[0] ?? "";
    if (action !== "" && action !== "list" && action !== "status" && action !== "run") {
      die(`fleet action must be one of: list, status, run (got "${action}")`);
    }
    await runFleet(parseFor(rest.slice(1), FLEET_SCHEMA), action);
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
    if (action !== "suggest") {
      die(`graders action must be "suggest" (got "${action}")`);
    }
    try {
      await runGradersSuggest(parseFor(rest.slice(1), GRADERS_SUGGEST_SCHEMA));
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
    if (action !== "promote" && action !== "rollback" && action !== "canary") {
      die(`deploy action must be "promote", "rollback", or "canary" (got "${action}")`);
    }
    try {
      await runDeploy(parseFor(rest.slice(1), DEPLOY_SCHEMA), action);
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
