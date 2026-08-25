/**
 * The M3 route table — pure data, one row per route, matched by `matchM3`
 * and executed by the single dispatcher in `server.ts`.
 *
 * WHY A TABLE AND NOT AN if-CHAIN. M3 is ~180 routes across eleven groups
 * built by six people in parallel. Hand-branching that would put every
 * author in the same 2000-line function, and each of them would re-derive
 * the id validation, the containment guard and the masking. Here the guards
 * live in ONE place, a route is one line, and the alarm that stopped UI ↔
 * server drift twice gets a third rail: the contract test asserts this
 * table's keys, methods and paths are EXACTLY the grouped entries of the
 * console's own `routes.js` map. Three files, one truth.
 *
 * MATCHING IS LITERAL-FIRST. Several templates overlap by arity — e.g.
 * `GET /api/h/:id/evals/matrix` (M3) and `GET /api/h/:id/evals/:runId` (M2),
 * or `GET …/inspect/raw` and `GET …/inspect/:store` (both M3). The matcher
 * scores every candidate by how many LITERAL segments it matched and keeps
 * the best, so a literal always beats a parameter and `evals/run_…` falls
 * through to the M2 handler untouched.
 *
 * Every `:param` is validated before a handler runs: `id` against
 * `HARNESS_ID_RE` (plus a registry lookup and a live-directory check),
 * everything else against `PARAM_GUARDS` — `SAFE_SEGMENT_RE` by default,
 * which is one path segment with no separators, no leading dot and no `..`.
 * Shape checks stop traversal; the per-file realpath containment in
 * `ctx.contain` stops a planted symlink. Both, always, never one.
 */

import {
  advisorAct,
  advisorDismiss,
  advisorFeed,
  advisorFleet,
  advisorIssueSubmit,
  advisorIssues,
  advisorReopen,
  advisorReport,
  advisorReportRun,
  advisorReports,
  advisorTrend,
} from "./advisor";
import {
  datasetBuilder,
  datasetBuilderStep,
  graderCatalog,
  graderWrite,
  mcpCatalog,
  mcpConnectorRemove,
  mcpConnectorWrite,
  mcpConnectors,
  wizardCreate,
  wizardTemplates,
} from "./builders";
import {
  channelProbe,
  channelProvision,
  channelProvisionRun,
  channelSynthetic,
  channelVerify,
  channels,
  gateway,
} from "./channels-ops";
import { SAFE_SEGMENT_RE } from "./constants";
import {
  credentialsMatrix,
  credentialsSetAcross,
  doctor,
  doctorRun,
  env,
  envSet,
  envUnset,
  mcpLint,
  secrets,
  secretsDoctor,
  secretsRotate,
} from "./creds-ops";
import {
  dataset,
  datasetAudit,
  datasetLint,
  datasetMine,
  datasetQuarantine,
  datasetRefreshGoldens,
  datasetStatus,
  datasetSynthesize,
  datasetVerify,
  datasets,
} from "./data-ops";
import { isRunId } from "./evals";
import {
  annotateSample,
  annotations,
  evalCoverage,
  evalLaunch,
  evalMatrix,
  evalMatrixCell,
  evalPlan,
  evalSuiteRun,
  evalSuites,
  evalTrends,
  experimentRecord,
  experiments,
  flywheel,
  flywheelRun,
  graderCards,
  gradersSuggest,
  gradersTest,
  judgeCalibrate,
  judgeCalibration,
  optimizer,
  optimizerArtifacts,
  optimizerRun,
  redteam,
  redteamGenerate,
  sentinel,
  sentinelRun,
  voiceEvals,
} from "./evals-ops";
import {
  advice,
  adviceApply,
  adviceRun,
  distillRun,
  faq,
  faqDistill,
  feedback,
  feedbackFleet,
  fewshot,
  fewshotHarvest,
  lessons,
  lessonsUpdate,
  reactions,
} from "./feedback-ops";
import { inspectEntry, inspectIndex, inspectRaw, inspectStore, settingsWrite } from "./inspect";
import type { M3Handler } from "./m3";
import {
  continuity,
  continuityRestore,
  continuityTrash,
  dreamScaffold,
  knowledge,
  knowledgeSync,
  learning,
  memoryFacts,
  memoryForget,
  memoryMigrate,
  memoryRecall,
  memorySweep,
} from "./memory-ops";
import { dev, devStart, devStop, mcpServerStart, mcpServerStop, mcpServers } from "./runtime-ops";
import {
  audit,
  auditVerify,
  compliance,
  complianceEvidence,
  egress,
  egressReview,
  justification,
  justificationCalibrate,
  justificationPreflight,
  onchain,
  onchainSentinel,
  onchainTune,
  pii,
  piiTune,
  retention,
  retentionPurge,
  retentionSweep,
  sandboxDoctor,
  securityCorpus,
  securityCorpusCheck,
  slo,
} from "./security-ops";
import {
  specDiff,
  specEdit,
  specPatch,
  specPin,
  specPropose,
  specRollback,
  specSchema,
  specTrust,
  specVersion,
  specVersionDiff,
  specVersions,
} from "./spec-edit";
import {
  thredzActivity,
  thredzCardCreate,
  thredzConnectors,
  thredzDashboard,
  thredzDashboards,
  thredzGlobal,
  thredzGoals,
  thredzKeyCreate,
  thredzKeyRotate,
  thredzKeys,
  thredzListenerCreate,
  thredzListeners,
  thredzRecord,
  thredzRecordCreate,
  thredzRecordDelete,
  thredzRecordRestore,
  thredzRecords,
  thredzSchemas,
  thredzStatus,
  thredzTaskUpdate,
  thredzTasks,
  thredzTraverse,
  thredzViewExecute,
  thredzViews,
  thredzWebhooks,
  thredzWiki,
  thredzWikiArticle,
  thredzWikiRollback,
  thredzWikiVersions,
  thredzWikiWrite,
} from "./thredz";
import {
  watchmeAnalytics,
  watchmeApply,
  watchmeIntents,
  watchmePublish,
  watchmeReport,
  watchmeReports,
  watchmeSynthesized,
  watchmeToggle,
} from "./watchme-ops";
import {
  wikiArchive,
  wikiLinks,
  wikiReflect,
  wikiSignals,
  wikiVersion,
  wikiVersions,
  wikiWrite,
} from "./wiki-ops";

/** The M3 groups (eleven M3 areas plus M5's advisor). A route's group is its
 *  owning module's area, and the console's left rail / tab wiring reads the
 *  same field. */
export const M3_GROUPS = [
  "spec",
  "memory",
  "evals",
  "data",
  "feedback",
  "creds",
  "channels",
  "security",
  "thredz",
  "inspect",
  "runtime",
  "advisor",
] as const;

export type M3Group = (typeof M3_GROUPS)[number];

export type M3Method = "GET" | "POST" | "PUT" | "DELETE";

export type M3Route = {
  /** Must equal the key in the console's `routes.js` map. */
  readonly key: string;
  readonly method: M3Method;
  /** Path template; `:name` segments become validated params. */
  readonly path: string;
  readonly group: M3Group;
  readonly handler: M3Handler;
  /** Pre-split template, filled once at module load. */
  readonly segments: readonly string[];
  /** Literal-segment count — the matcher's tie-break score. */
  readonly literals: number;
};

/**
 * Per-param shape guards. Anything not listed falls back to
 * {@link SAFE_SEGMENT_RE}. `id` is absent on purpose: the dispatcher
 * validates it with `HARNESS_ID_RE` and then resolves it against the
 * registry, which is a stronger check than a regex.
 */
export const PARAM_GUARDS: Readonly<Record<string, (value: string) => boolean>> = {
  runId: isRunId,
  optRunId: isRunId,
};

/** True when `value` satisfies the guard for `name`. */
export function paramOk(name: string, value: string): boolean {
  const guard = PARAM_GUARDS[name];
  return guard === undefined ? SAFE_SEGMENT_RE.test(value) : guard(value);
}

function route(
  key: string,
  method: M3Method,
  path: string,
  group: M3Group,
  handler: M3Handler,
): M3Route {
  const segments = path.split("/").filter((s) => s !== "");
  return {
    key,
    method,
    path,
    group,
    handler,
    segments,
    literals: segments.filter((s) => !s.startsWith(":")).length,
  };
}

/**
 * Every M3 route. Grouped by area in the order the console's tabs run, so a
 * reviewer reads this table the way an operator reads the app.
 */
export const M3_ROUTES: readonly M3Route[] = [
  // ---- spec: the structured editor, trust tiers, versions, builders ------
  route("specEdit", "PUT", "/api/h/:id/spec", "spec", specEdit),
  route("specPatch", "POST", "/api/h/:id/spec/patch", "spec", specPatch),
  route("specDiff", "POST", "/api/h/:id/spec/diff", "spec", specDiff),
  route("specSchema", "GET", "/api/h/:id/spec/schema", "spec", specSchema),
  route("specTrust", "GET", "/api/h/:id/spec/trust", "spec", specTrust),
  route("specVersions", "GET", "/api/h/:id/spec/versions", "spec", specVersions),
  route("specVersion", "GET", "/api/h/:id/spec/versions/:version", "spec", specVersion),
  route(
    "specVersionDiff",
    "GET",
    "/api/h/:id/spec/versions/:version/diff",
    "spec",
    specVersionDiff,
  ),
  route("specPin", "POST", "/api/h/:id/spec/pin", "spec", specPin),
  route("specRollback", "POST", "/api/h/:id/spec/rollback", "spec", specRollback),
  route("specPropose", "POST", "/api/h/:id/spec/propose", "spec", specPropose),
  route("wizardTemplates", "GET", "/api/builders/templates", "spec", wizardTemplates),
  route("wizardCreate", "POST", "/api/builders/spec", "spec", wizardCreate),
  route("mcpCatalog", "GET", "/api/builders/mcp-catalog", "spec", mcpCatalog),
  route("graderCatalog", "GET", "/api/h/:id/builders/graders", "spec", graderCatalog),
  route("graderWrite", "POST", "/api/h/:id/builders/graders", "spec", graderWrite),
  route("datasetBuilder", "GET", "/api/h/:id/builders/dataset", "spec", datasetBuilder),
  route("datasetBuilderStep", "POST", "/api/h/:id/builders/dataset", "spec", datasetBuilderStep),
  route("mcpConnectors", "GET", "/api/h/:id/builders/mcp", "spec", mcpConnectors),
  route("mcpConnectorWrite", "POST", "/api/h/:id/builders/mcp", "spec", mcpConnectorWrite),
  route(
    "mcpConnectorRemove",
    "DELETE",
    "/api/h/:id/builders/mcp/:name",
    "spec",
    mcpConnectorRemove,
  ),

  // ---- memory: facts, continuity, wiki, watchme, learning, knowledge -----
  route("memoryFacts", "GET", "/api/h/:id/memory/facts/:spec", "memory", memoryFacts),
  route("memoryForget", "POST", "/api/h/:id/memory/facts/:spec/forget", "memory", memoryForget),
  route("memorySweep", "POST", "/api/h/:id/memory/facts/:spec/sweep", "memory", memorySweep),
  route("memoryRecall", "POST", "/api/h/:id/memory/recall", "memory", memoryRecall),
  route("memoryMigrate", "POST", "/api/h/:id/memory/migrate", "memory", memoryMigrate),
  route("continuity", "GET", "/api/h/:id/memory/continuity", "memory", continuity),
  route("continuityTrash", "GET", "/api/h/:id/memory/continuity/trash", "memory", continuityTrash),
  route(
    "continuityRestore",
    "POST",
    "/api/h/:id/memory/continuity/restore",
    "memory",
    continuityRestore,
  ),
  route("learning", "GET", "/api/h/:id/memory/learning", "memory", learning),
  route("knowledge", "GET", "/api/h/:id/memory/knowledge", "memory", knowledge),
  route("knowledgeSync", "POST", "/api/h/:id/memory/knowledge/sync", "memory", knowledgeSync),
  route("dreamScaffold", "GET", "/api/h/:id/memory/dream/scaffold", "memory", dreamScaffold),
  route("wikiWrite", "PUT", "/api/h/:id/memory/wiki/:slug", "memory", wikiWrite),
  route("wikiVersions", "GET", "/api/h/:id/memory/wiki/:slug/versions", "memory", wikiVersions),
  route(
    "wikiVersion",
    "GET",
    "/api/h/:id/memory/wiki/:slug/versions/:version",
    "memory",
    wikiVersion,
  ),
  route("wikiLinks", "GET", "/api/h/:id/memory/wiki/:slug/links", "memory", wikiLinks),
  route("wikiSignals", "POST", "/api/h/:id/memory/wiki/:slug/signals", "memory", wikiSignals),
  route("wikiArchive", "POST", "/api/h/:id/memory/wiki/:slug/archive", "memory", wikiArchive),
  route("wikiReflect", "GET", "/api/h/:id/memory/reflect", "memory", wikiReflect),
  route(
    "watchmeAnalytics",
    "GET",
    "/api/h/:id/memory/watchme/analytics",
    "memory",
    watchmeAnalytics,
  ),
  route("watchmeReports", "GET", "/api/h/:id/memory/watchme/reports", "memory", watchmeReports),
  route(
    "watchmeReport",
    "GET",
    "/api/h/:id/memory/watchme/reports/:stamp",
    "memory",
    watchmeReport,
  ),
  route("watchmeIntents", "GET", "/api/h/:id/memory/watchme/intents", "memory", watchmeIntents),
  route("watchmeToggle", "POST", "/api/h/:id/memory/watchme/toggle", "memory", watchmeToggle),
  route(
    "watchmeSynthesized",
    "GET",
    "/api/h/:id/memory/watchme/synthesized",
    "memory",
    watchmeSynthesized,
  ),
  route(
    "watchmeApply",
    "POST",
    "/api/h/:id/memory/watchme/synthesized/:stamp/apply",
    "memory",
    watchmeApply,
  ),
  route("watchmePublish", "POST", "/api/h/:id/memory/watchme/publish", "memory", watchmePublish),

  // ---- evals: the quality lab -------------------------------------------
  route("evalLaunch", "POST", "/api/h/:id/evals/run", "evals", evalLaunch),
  route("evalMatrix", "GET", "/api/h/:id/evals/matrix", "evals", evalMatrix),
  route("evalMatrixCell", "GET", "/api/h/:id/evals/matrix/:cell", "evals", evalMatrixCell),
  route("evalSuites", "GET", "/api/h/:id/evals/suites", "evals", evalSuites),
  route("evalSuiteRun", "POST", "/api/h/:id/evals/suites", "evals", evalSuiteRun),
  route("evalTrends", "GET", "/api/h/:id/evals/trends", "evals", evalTrends),
  route("evalPlan", "POST", "/api/h/:id/evals/plan", "evals", evalPlan),
  route("judgeCalibration", "GET", "/api/h/:id/evals/judge", "evals", judgeCalibration),
  route("judgeCalibrate", "POST", "/api/h/:id/evals/judge", "evals", judgeCalibrate),
  route("graderCards", "GET", "/api/h/:id/evals/graders", "evals", graderCards),
  route("gradersSuggest", "POST", "/api/h/:id/evals/graders/suggest", "evals", gradersSuggest),
  route("gradersTest", "POST", "/api/h/:id/evals/graders/test", "evals", gradersTest),
  route("redteam", "GET", "/api/h/:id/evals/redteam", "evals", redteam),
  route("redteamGenerate", "POST", "/api/h/:id/evals/redteam", "evals", redteamGenerate),
  route("evalCoverage", "GET", "/api/h/:id/evals/coverage", "evals", evalCoverage),
  route("sentinel", "GET", "/api/h/:id/evals/sentinel", "evals", sentinel),
  route("sentinelRun", "POST", "/api/h/:id/evals/sentinel", "evals", sentinelRun),
  route("voiceEvals", "GET", "/api/h/:id/evals/voice", "evals", voiceEvals),
  route("optimizer", "GET", "/api/h/:id/evals/optimize", "evals", optimizer),
  route("optimizerRun", "POST", "/api/h/:id/evals/optimize", "evals", optimizerRun),
  route(
    "optimizerArtifacts",
    "GET",
    "/api/h/:id/evals/optimize/:optRunId",
    "evals",
    optimizerArtifacts,
  ),
  route("flywheel", "GET", "/api/h/:id/evals/flywheel", "evals", flywheel),
  route("flywheelRun", "POST", "/api/h/:id/evals/flywheel", "evals", flywheelRun),
  route("experiments", "GET", "/api/h/:id/evals/experiments", "evals", experiments),
  route("experimentRecord", "POST", "/api/h/:id/evals/experiments", "evals", experimentRecord),
  route("annotations", "GET", "/api/h/:id/evals/annotations", "evals", annotations),
  route(
    "annotateSample",
    "POST",
    "/api/h/:id/evals/:runId/:sampleId/annotate",
    "evals",
    annotateSample,
  ),

  // ---- data: the dataset registry + hygiene + growth ---------------------
  route("datasets", "GET", "/api/h/:id/data/datasets", "data", datasets),
  route("dataset", "GET", "/api/h/:id/data/datasets/:name", "data", dataset),
  route("datasetStatus", "GET", "/api/h/:id/data/status", "data", datasetStatus),
  route("datasetQuarantine", "GET", "/api/h/:id/data/quarantine", "data", datasetQuarantine),
  route("datasetVerify", "POST", "/api/h/:id/data/verify", "data", datasetVerify),
  route("datasetAudit", "POST", "/api/h/:id/data/audit", "data", datasetAudit),
  route("datasetLint", "POST", "/api/h/:id/data/lint", "data", datasetLint),
  route("datasetMine", "POST", "/api/h/:id/data/mine", "data", datasetMine),
  route("datasetSynthesize", "POST", "/api/h/:id/data/synthesize", "data", datasetSynthesize),
  route(
    "datasetRefreshGoldens",
    "POST",
    "/api/h/:id/data/refresh-goldens",
    "data",
    datasetRefreshGoldens,
  ),

  // ---- feedback: the growth loops ---------------------------------------
  route("feedback", "GET", "/api/h/:id/feedback", "feedback", feedback),
  route("distillRun", "POST", "/api/h/:id/feedback/distill", "feedback", distillRun),
  route("fewshot", "GET", "/api/h/:id/feedback/fewshot", "feedback", fewshot),
  route("fewshotHarvest", "POST", "/api/h/:id/feedback/fewshot", "feedback", fewshotHarvest),
  route("faq", "GET", "/api/h/:id/feedback/faq", "feedback", faq),
  route("faqDistill", "POST", "/api/h/:id/feedback/faq", "feedback", faqDistill),
  route("lessons", "GET", "/api/h/:id/feedback/lessons", "feedback", lessons),
  route("lessonsUpdate", "POST", "/api/h/:id/feedback/lessons", "feedback", lessonsUpdate),
  route("advice", "GET", "/api/h/:id/feedback/advice", "feedback", advice),
  route("adviceRun", "POST", "/api/h/:id/feedback/advice", "feedback", adviceRun),
  route(
    "adviceApply",
    "POST",
    "/api/h/:id/feedback/advice/:adviceId/apply",
    "feedback",
    adviceApply,
  ),
  route("reactions", "GET", "/api/h/:id/feedback/reactions", "feedback", reactions),
  route("feedbackFleet", "GET", "/api/feedback", "feedback", feedbackFleet),

  // ---- creds: env, the fleet matrix, doctor, secrets, the MCP lint -------
  route("env", "GET", "/api/h/:id/env", "creds", env),
  route("envSet", "POST", "/api/h/:id/env", "creds", envSet),
  route("envUnset", "DELETE", "/api/h/:id/env/:key", "creds", envUnset),
  route("credentialsMatrix", "GET", "/api/credentials", "creds", credentialsMatrix),
  route("credentialsSetAcross", "POST", "/api/credentials/set", "creds", credentialsSetAcross),
  route("doctor", "GET", "/api/h/:id/doctor", "creds", doctor),
  route("doctorRun", "POST", "/api/h/:id/doctor", "creds", doctorRun),
  route("secrets", "GET", "/api/h/:id/secrets", "creds", secrets),
  route("secretsDoctor", "GET", "/api/h/:id/secrets/doctor", "creds", secretsDoctor),
  route("secretsRotate", "POST", "/api/h/:id/secrets/:name/rotate", "creds", secretsRotate),
  route("mcpLint", "GET", "/api/h/:id/mcp/lint", "creds", mcpLint),

  // ---- channels: provisioning, verification, the two test tiers ----------
  route("channels", "GET", "/api/h/:id/channels", "channels", channels),
  route("channelVerify", "POST", "/api/h/:id/channels/verify", "channels", channelVerify),
  route(
    "channelProvision",
    "GET",
    "/api/h/:id/channels/:channel/provision",
    "channels",
    channelProvision,
  ),
  route(
    "channelProvisionRun",
    "POST",
    "/api/h/:id/channels/:channel/provision",
    "channels",
    channelProvisionRun,
  ),
  route("channelProbe", "POST", "/api/h/:id/channels/:channel/probe", "channels", channelProbe),
  route(
    "channelSynthetic",
    "POST",
    "/api/h/:id/channels/:channel/synthetic",
    "channels",
    channelSynthetic,
  ),
  route("gateway", "GET", "/api/h/:id/gateway", "channels", gateway),

  // ---- security: audit, egress, pii, justification, onchain, retention ---
  route("audit", "GET", "/api/h/:id/audit", "security", audit),
  route("auditVerify", "POST", "/api/h/:id/audit/verify", "security", auditVerify),
  route("egress", "GET", "/api/h/:id/security/egress", "security", egress),
  route("egressReview", "POST", "/api/h/:id/security/egress/:decisionId", "security", egressReview),
  route("pii", "GET", "/api/h/:id/security/pii", "security", pii),
  route("piiTune", "POST", "/api/h/:id/security/pii", "security", piiTune),
  route("justification", "GET", "/api/h/:id/security/justification", "security", justification),
  route(
    "justificationCalibrate",
    "POST",
    "/api/h/:id/security/justification/calibrate",
    "security",
    justificationCalibrate,
  ),
  route(
    "justificationPreflight",
    "POST",
    "/api/h/:id/security/justification/preflight",
    "security",
    justificationPreflight,
  ),
  route("securityCorpus", "GET", "/api/h/:id/security/corpus", "security", securityCorpus),
  route(
    "securityCorpusCheck",
    "POST",
    "/api/h/:id/security/corpus",
    "security",
    securityCorpusCheck,
  ),
  route("sandboxDoctor", "GET", "/api/h/:id/security/sandbox", "security", sandboxDoctor),
  route("onchain", "GET", "/api/h/:id/security/onchain", "security", onchain),
  route("onchainTune", "POST", "/api/h/:id/security/onchain/tune", "security", onchainTune),
  route(
    "onchainSentinel",
    "GET",
    "/api/h/:id/security/onchain/sentinel",
    "security",
    onchainSentinel,
  ),
  route("compliance", "GET", "/api/h/:id/security/compliance", "security", compliance),
  route(
    "complianceEvidence",
    "POST",
    "/api/h/:id/security/compliance",
    "security",
    complianceEvidence,
  ),
  route("retention", "GET", "/api/h/:id/security/retention", "security", retention),
  route(
    "retentionSweep",
    "POST",
    "/api/h/:id/security/retention/sweep",
    "security",
    retentionSweep,
  ),
  route(
    "retentionPurge",
    "POST",
    "/api/h/:id/security/retention/purge",
    "security",
    retentionPurge,
  ),
  route("slo", "GET", "/api/h/:id/slo", "security", slo),

  // ---- thredz: the server-side proxied explorer --------------------------
  route("thredzStatus", "GET", "/api/h/:id/thredz", "thredz", thredzStatus),
  route("thredzWiki", "GET", "/api/h/:id/thredz/wiki", "thredz", thredzWiki),
  route("thredzWikiArticle", "GET", "/api/h/:id/thredz/wiki/:slug", "thredz", thredzWikiArticle),
  route("thredzWikiWrite", "PUT", "/api/h/:id/thredz/wiki/:slug", "thredz", thredzWikiWrite),
  route(
    "thredzWikiVersions",
    "GET",
    "/api/h/:id/thredz/wiki/:slug/versions",
    "thredz",
    thredzWikiVersions,
  ),
  route(
    "thredzWikiRollback",
    "POST",
    "/api/h/:id/thredz/wiki/:slug/rollback",
    "thredz",
    thredzWikiRollback,
  ),
  route("thredzRecords", "GET", "/api/h/:id/thredz/records", "thredz", thredzRecords),
  route("thredzRecordCreate", "POST", "/api/h/:id/thredz/records", "thredz", thredzRecordCreate),
  route("thredzRecord", "GET", "/api/h/:id/thredz/records/:recordId", "thredz", thredzRecord),
  route(
    "thredzRecordDelete",
    "DELETE",
    "/api/h/:id/thredz/records/:recordId",
    "thredz",
    thredzRecordDelete,
  ),
  route(
    "thredzRecordRestore",
    "POST",
    "/api/h/:id/thredz/records/:recordId/restore",
    "thredz",
    thredzRecordRestore,
  ),
  route("thredzSchemas", "GET", "/api/h/:id/thredz/schemas", "thredz", thredzSchemas),
  route("thredzGoals", "GET", "/api/h/:id/thredz/goals", "thredz", thredzGoals),
  route("thredzTasks", "GET", "/api/h/:id/thredz/tasks", "thredz", thredzTasks),
  route("thredzTaskUpdate", "POST", "/api/h/:id/thredz/tasks/:taskId", "thredz", thredzTaskUpdate),
  route("thredzViews", "GET", "/api/h/:id/thredz/views", "thredz", thredzViews),
  route(
    "thredzViewExecute",
    "POST",
    "/api/h/:id/thredz/views/:viewId/execute",
    "thredz",
    thredzViewExecute,
  ),
  route("thredzDashboards", "GET", "/api/h/:id/thredz/dashboards", "thredz", thredzDashboards),
  route(
    "thredzDashboard",
    "GET",
    "/api/h/:id/thredz/dashboards/:dashboardId",
    "thredz",
    thredzDashboard,
  ),
  route(
    "thredzCardCreate",
    "POST",
    "/api/h/:id/thredz/dashboards/:dashboardId/cards",
    "thredz",
    thredzCardCreate,
  ),
  route("thredzListeners", "GET", "/api/h/:id/thredz/listeners", "thredz", thredzListeners),
  route(
    "thredzListenerCreate",
    "POST",
    "/api/h/:id/thredz/listeners",
    "thredz",
    thredzListenerCreate,
  ),
  route("thredzWebhooks", "GET", "/api/h/:id/thredz/webhooks", "thredz", thredzWebhooks),
  route("thredzConnectors", "GET", "/api/h/:id/thredz/connectors", "thredz", thredzConnectors),
  route("thredzActivity", "GET", "/api/h/:id/thredz/activity", "thredz", thredzActivity),
  route("thredzTraverse", "POST", "/api/h/:id/thredz/traverse", "thredz", thredzTraverse),
  route("thredzKeys", "GET", "/api/h/:id/thredz/keys", "thredz", thredzKeys),
  route("thredzKeyCreate", "POST", "/api/h/:id/thredz/keys", "thredz", thredzKeyCreate),
  route(
    "thredzKeyRotate",
    "POST",
    "/api/h/:id/thredz/keys/:keyId/rotate",
    "thredz",
    thredzKeyRotate,
  ),
  route("thredzGlobal", "GET", "/api/thredz", "thredz", thredzGlobal),

  // ---- inspect: the raw browsers + settings.json -------------------------
  route("inspectIndex", "GET", "/api/h/:id/inspect", "inspect", inspectIndex),
  route("inspectRaw", "GET", "/api/h/:id/inspect/raw", "inspect", inspectRaw),
  route("inspectStore", "GET", "/api/h/:id/inspect/:store", "inspect", inspectStore),
  route("inspectEntry", "GET", "/api/h/:id/inspect/:store/:name", "inspect", inspectEntry),
  route("settingsWrite", "PUT", "/api/h/:id/inspect/settings", "inspect", settingsWrite),

  // ---- advisor: the unified alert/suggestion feed + its loops (M5) -------
  route("advisor", "GET", "/api/h/:id/advisor", "advisor", advisorFeed),
  route("advisorAct", "POST", "/api/h/:id/advisor/:itemId/act", "advisor", advisorAct),
  route("advisorDismiss", "POST", "/api/h/:id/advisor/:itemId/dismiss", "advisor", advisorDismiss),
  route("advisorReopen", "POST", "/api/h/:id/advisor/:itemId/reopen", "advisor", advisorReopen),
  route("advisorTrend", "GET", "/api/h/:id/advisor/trend", "advisor", advisorTrend),
  route("advisorReports", "GET", "/api/h/:id/advisor/reports", "advisor", advisorReports),
  route("advisorReportRun", "POST", "/api/h/:id/advisor/reports", "advisor", advisorReportRun),
  route("advisorReport", "GET", "/api/h/:id/advisor/reports/:reportId", "advisor", advisorReport),
  route("advisorIssues", "GET", "/api/h/:id/advisor/issues", "advisor", advisorIssues),
  route("advisorIssueSubmit", "POST", "/api/h/:id/advisor/issues", "advisor", advisorIssueSubmit),
  route("advisorFleet", "GET", "/api/advisor", "advisor", advisorFleet),

  // ---- runtime: the mcp-server + dev run classes -------------------------
  route("mcpServers", "GET", "/api/h/:id/mcp-servers", "runtime", mcpServers),
  route("mcpServerStart", "POST", "/api/h/:id/mcp-servers/start", "runtime", mcpServerStart),
  route("mcpServerStop", "POST", "/api/h/:id/mcp-servers/stop", "runtime", mcpServerStop),
  route("dev", "GET", "/api/h/:id/dev", "runtime", dev),
  route("devStart", "POST", "/api/h/:id/dev/start", "runtime", devStart),
  route("devStop", "POST", "/api/h/:id/dev/stop", "runtime", devStop),
];

/** One matched route plus the params extracted from the request path. */
export type M3Match = {
  readonly route: M3Route;
  readonly params: Readonly<Record<string, string>>;
};

/**
 * Find the route for `method` + `segments` (the decoded path split, WITHOUT
 * the leading empty piece — i.e. `["api","h","hrn_…","spec"]`).
 *
 * Literal-first: among all templates that match, the one with the most
 * literal segments wins. A param whose value fails its guard does NOT match,
 * so `evals/matrix` can never be mistaken for `evals/:runId` and a malformed
 * id falls through to the M1/M2 chain's own 400 rather than reaching a
 * handler.
 */
export function matchM3(method: string, segments: readonly string[]): M3Match | undefined {
  let best: M3Match | undefined;
  let bestScore = -1;
  for (const candidate of M3_ROUTES) {
    if (candidate.method !== method) continue;
    if (candidate.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < candidate.segments.length; i += 1) {
      const template = candidate.segments[i] as string;
      const value = segments[i] as string;
      if (template.startsWith(":")) {
        const name = template.slice(1);
        // `id` is checked by the dispatcher (registry lookup); every other
        // param must satisfy its shape guard to match at all.
        if (name !== "id" && !paramOk(name, value)) {
          ok = false;
          break;
        }
        params[name] = value;
      } else if (template !== value) {
        ok = false;
        break;
      }
    }
    if (ok && candidate.literals > bestScore) {
      best = { route: candidate, params };
      bestScore = candidate.literals;
    }
  }
  return best;
}
