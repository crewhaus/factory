/**
 * Home's route table as data: one row per `(method, path)` the server answers under `/api`,
 * with the permission each needs, whether it writes a command receipt and where, the
 * receipt's kind, and the real CLI command that does the same, where one exists.
 *
 * The rows are the console's route map (`hangar-ui/assets/js/routes.js`), grouped as it
 * is, plus the routes the server answers that the map never names ({@link OFF_MAP_KEYS}).
 * `route-table.test.ts` holds the two to each other, so a route added to one and not the
 * other fails a test. The receipts middleware (`receipts.ts`) reads `receipt`, `kind`,
 * `dispatch`, `idempotent` and `secretFields`; nothing here enforces `permission` yet.
 *
 * Every write receipts. `harness` writes go to the harness's own command ledger,
 * `workspace` writes (registry edits, Home's settings) to Home's. A read writes nothing,
 * and a POST that only reads says why in `noReceiptReason`. A row whose route is the legacy
 * face of a core command uses that command's kind; every other write's kind is
 * `legacy.<key>`, a kind no executor ever runs again.
 *
 * Pure data: adding a route is one row, in its group.
 */
import {
  COMMAND_KINDS,
  type CliTwin,
  type HttpMethod,
  type Qualifier,
  type ReceiptMode,
} from "@crewhaus/control-contract";

export type RouteRow = {
  /** The console's key; an off-map route's own name. */
  readonly key: string;
  /** Other console keys for the same method and path. */
  readonly aliases?: readonly string[];
  readonly method: HttpMethod;
  readonly path: string;
  /** A permission id, `public` or `authenticated`. */
  readonly permission: string;
  readonly qualifiers: readonly Qualifier[];
  readonly receipt: ReceiptMode;
  /** The receipt's command kind: a core kind, or `legacy.<key>`. */
  readonly kind?: string;
  /** `job`: the handler queues a job, and the job moves the receipt. */
  readonly dispatch?: "inline" | "job";
  /** Whether repeating a legacy write is safe (a core kind declares its own). */
  readonly idempotent?: boolean;
  /** Body fields that hold a secret; a receipt's fingerprint never hashes them. */
  readonly secretFields?: readonly string[];
  readonly noReceiptReason?: string;
  /** The real CLI command, or `null` when there is none. */
  readonly cliTwin: CliTwin | null;
  readonly note?: string;
};

type WriteExtras = {
  readonly qualifiers?: readonly Qualifier[];
  readonly kind?: keyof typeof COMMAND_KINDS;
  readonly dispatch?: "job";
  readonly secretFields?: readonly string[];
  readonly aliases?: readonly string[];
  readonly note?: string;
};

function read(
  key: string,
  path: string,
  permission: string,
  qualifiers: readonly Qualifier[] = [],
): RouteRow {
  return { key, method: "GET", path, permission, qualifiers, receipt: "none", cliTwin: null };
}

/** A non-GET route that only reads, and so writes no receipt. */
function readOnly(
  key: string,
  method: HttpMethod,
  path: string,
  permission: string,
  reason: string,
): RouteRow {
  return {
    key,
    method,
    path,
    permission,
    qualifiers: [],
    receipt: "none",
    noReceiptReason: reason,
    cliTwin: null,
  };
}

/** A write. PUT and DELETE are safe to repeat; a POST is not, unless its core kind says so. */
function write(
  key: string,
  receipt: "harness" | "workspace",
  method: HttpMethod,
  path: string,
  permission: string,
  extras: WriteExtras = {},
): RouteRow {
  const core = extras.kind !== undefined ? COMMAND_KINDS[extras.kind] : undefined;
  return {
    key,
    ...(extras.aliases !== undefined ? { aliases: extras.aliases } : {}),
    method,
    path,
    permission,
    qualifiers: extras.qualifiers ?? [],
    receipt,
    kind: extras.kind ?? `legacy.${key}`,
    dispatch: extras.dispatch ?? "inline",
    ...(core === undefined ? { idempotent: method === "PUT" || method === "DELETE" } : {}),
    ...(extras.secretFields !== undefined ? { secretFields: extras.secretFields } : {}),
    cliTwin: core?.cliTwin ?? null,
    ...(extras.note !== undefined ? { note: extras.note } : {}),
  };
}

/** Routes under `/api` the server answers that the console's map does not name. */
export const OFF_MAP_KEYS: readonly string[] = [
  "bootTicket",
  "setGroupsAll",
  "removeGroup",
  "scanRoots",
  "removeScanRoot",
  "fleetCosts",
  "runProof",
];

/** Routes outside `/api`, answered before authentication. */
export const OFF_MAP_OUTSIDE_API: readonly {
  readonly method: HttpMethod;
  readonly path: string;
  readonly permission: "public";
  readonly note: string;
}[] = [
  { method: "GET", path: "/healthz", permission: "public", note: "liveness; no state" },
  {
    method: "GET",
    path: "/boot/:nonce",
    permission: "public",
    note: "a single-use nonce redirects to the console",
  },
];

export const ROUTE_TABLE: readonly RouteRow[] = [
  // ---- routes the server branches by hand (no group in routes.js) ----
  read("version", "/api/version", "home.read"),
  read("harnesses", "/api/harnesses", "home.read", ["filtered"]),
  write("addHarness", "workspace", "POST", "/api/harnesses", "home.registry.manage"),
  write("scan", "workspace", "POST", "/api/scan", "home.registry.manage"),
  read("groups", "/api/registry/groups", "home.read", ["filtered"]),
  write("addGroup", "workspace", "POST", "/api/registry/groups", "home.registry.manage"),
  read("groupProcPlan", "/api/registry/groups/:name/proc/:verb", "home.read", ["filtered"]),
  write("groupProc", "workspace", "POST", "/api/registry/groups/:name/proc/:verb", "h.control"),
  write("addScanRoot", "workspace", "POST", "/api/registry/scan-roots", "home.registry.manage"),
  read("discover", "/api/registry/discover", "home.registry.manage"),
  write("removeHarness", "workspace", "DELETE", "/api/h/:id", "h.registry.admin"),
  write("setHidden", "workspace", "PUT", "/api/h/:id/visibility", "h.registry.edit"),
  write("relocate", "workspace", "POST", "/api/h/:id/relocate", "h.registry.admin"),
  write("setGroups", "workspace", "PUT", "/api/h/:id/groups", "h.registry.edit", {
    aliases: ["setGroupOrder"],
  }),
  write("setTags", "workspace", "PUT", "/api/h/:id/tags", "h.registry.edit"),
  write("setPin", "workspace", "PUT", "/api/h/:id/pin", "h.registry.edit"),
  write("setNotes", "workspace", "PUT", "/api/h/:id/notes", "h.registry.edit"),
  read("harness", "/api/h/:id", "h.read"),
  read("spec", "/api/h/:id/spec", "h.read"),
  read("preflight", "/api/h/:id/preflight", "h.read"),
  read("sessions", "/api/h/:id/sessions", "h.read"),
  read("session", "/api/h/:id/sessions/:sess", "h.read.content"),
  read("evals", "/api/h/:id/evals", "h.read"),
  read("evalRun", "/api/h/:id/evals/:runId", "h.read"),
  read("evalSample", "/api/h/:id/evals/:runId/:sampleId", "h.read.content"),
  read("memory", "/api/h/:id/memory/:area", "h.read.content"),
  read("wikiArticle", "/api/h/:id/memory/wiki/:slug", "h.read.content"),
  read("costs", "/api/h/:id/costs", "h.read"),
  read("proc", "/api/h/:id/proc", "h.read"),
  write("procStart", "harness", "POST", "/api/h/:id/proc/start", "h.control", {
    kind: "controls.start",
  }),
  write("procStop", "harness", "POST", "/api/h/:id/proc/stop", "h.control", {
    kind: "controls.stop",
  }),
  write("procRestart", "harness", "POST", "/api/h/:id/proc/restart", "h.control", {
    kind: "controls.restart",
  }),
  write("procDrain", "harness", "POST", "/api/h/:id/proc/drain", "h.control", {
    kind: "controls.drain",
  }),
  read("runs", "/api/h/:id/runs", "h.read"),
  read("run", "/api/h/:id/runs/:runId", "h.read.content"),
  read("runEvents", "/api/h/:id/runs/:runId/events", "h.read.content"),
  read("controlStatus", "/api/h/:id/control/status", "h.read"),
  write("controlWake", "harness", "POST", "/api/h/:id/control/wake", "h.control"),
  write("controlDrain", "harness", "POST", "/api/h/:id/control/drain", "h.control", {
    kind: "controls.drain",
  }),
  read("schedulers", "/api/h/:id/schedulers", "h.read"),
  read("approvals", "/api/approvals", "home.read", ["filtered"]),
  write(
    "grantApproval",
    "harness",
    "POST",
    "/api/h/:id/approvals/:apprId/grant",
    "h.decision.resolve",
    { qualifiers: ["class"], kind: "decisions.resolve" },
  ),
  write(
    "denyApproval",
    "harness",
    "POST",
    "/api/h/:id/approvals/:apprId/deny",
    "h.decision.resolve",
    { qualifiers: ["class"], kind: "decisions.resolve" },
  ),
  read("review", "/api/review", "home.read", ["filtered"]),
  write("adjudicateReview", "harness", "POST", "/api/h/:id/review/:itemId", "h.decision.resolve", {
    qualifiers: ["class"],
  }),
  read("activity", "/api/activity", "home.read", ["filtered"]),
  read("jobs", "/api/jobs", "home.read", ["filtered"]),
  write("submitJob", "harness", "POST", "/api/h/:id/jobs", "h.job.run", { dispatch: "job" }),
  read("deployments", "/api/h/:id/deployments", "h.read"),
  write("pinSession", "harness", "POST", "/api/h/:id/sessions/:sess/pin", "h.memory.write"),
  write("pinBaseline", "harness", "POST", "/api/h/:id/evals/baseline", "h.quality.edit"),
  read("health", "/api/h/:id/health", "h.read"),
  read("fleetHealth", "/api/health", "home.read", ["filtered"]),
  read("onboarding", "/api/onboarding", "home.read", ["filtered"]),
  write("demoInstall", "workspace", "POST", "/api/onboarding/demo", "home.registry.manage"),
  read("search", "/api/search", "home.read", ["filtered"]),
  read("notifications", "/api/notifications", "home.read", ["filtered"]),
  write("setNotifications", "workspace", "PUT", "/api/notifications", "self.preferences", {
    qualifiers: ["self"],
  }),
  write("clearNotifications", "workspace", "POST", "/api/notifications/clear", "self.preferences", {
    qualifiers: ["self"],
  }),
  read("readOnly", "/api/read-only", "home.read", ["filtered"]),
  write("setReadOnly", "workspace", "PUT", "/api/read-only", "home.settings.manage"),
  read("plugins", "/api/plugins", "home.read", ["filtered"]),
  read("pluginPane", "/api/plugins/:plugin/panes/:pane", "home.read", ["filtered"]),
  read("panes", "/api/h/:id/panes", "h.read"),

  // ---- spec ----
  write("specEdit", "harness", "PUT", "/api/h/:id/spec", "h.spec.edit"),
  write("specPatch", "harness", "POST", "/api/h/:id/spec/patch", "h.spec.edit"),
  readOnly("specDiff", "POST", "/api/h/:id/spec/diff", "h.read", "computes a diff; writes nothing"),
  read("specSchema", "/api/h/:id/spec/schema", "h.read"),
  read("specTrust", "/api/h/:id/spec/trust", "h.read"),
  read("specVersions", "/api/h/:id/spec/versions", "h.read"),
  read("specVersion", "/api/h/:id/spec/versions/:version", "h.read"),
  read("specVersionDiff", "/api/h/:id/spec/versions/:version/diff", "h.read"),
  write("specPin", "harness", "POST", "/api/h/:id/spec/pin", "h.deploy", { dispatch: "job" }),
  write("specRollback", "harness", "POST", "/api/h/:id/spec/rollback", "h.deploy", {
    dispatch: "job",
  }),
  write("specPropose", "harness", "POST", "/api/h/:id/spec/propose", "h.spec.edit", {
    dispatch: "job",
  }),
  read("wizardTemplates", "/api/builders/templates", "h.read"),
  write("wizardCreate", "workspace", "POST", "/api/builders/spec", "home.registry.manage"),
  read("mcpCatalog", "/api/builders/mcp-catalog", "h.read"),
  read("graderCatalog", "/api/h/:id/builders/graders", "h.read"),
  write("graderWrite", "harness", "POST", "/api/h/:id/builders/graders", "h.quality.edit"),
  read("datasetBuilder", "/api/h/:id/builders/dataset", "h.read"),
  write("datasetBuilderStep", "harness", "POST", "/api/h/:id/builders/dataset", "h.data.write"),
  read("mcpConnectors", "/api/h/:id/builders/mcp", "h.read"),
  write("mcpConnectorWrite", "harness", "POST", "/api/h/:id/builders/mcp", "h.spec.edit.security", {
    secretFields: ["env", "headers"],
  }),
  write(
    "mcpConnectorRemove",
    "harness",
    "DELETE",
    "/api/h/:id/builders/mcp/:name",
    "h.spec.edit.security",
  ),

  // ---- memory ----
  read("memoryFacts", "/api/h/:id/memory/facts/:spec", "h.read.content"),
  write(
    "memoryForget",
    "harness",
    "POST",
    "/api/h/:id/memory/facts/:spec/forget",
    "h.memory.write",
  ),
  write("memorySweep", "harness", "POST", "/api/h/:id/memory/facts/:spec/sweep", "h.memory.write"),
  readOnly(
    "memoryRecall",
    "POST",
    "/api/h/:id/memory/recall",
    "h.read.content",
    "a search; writes nothing",
  ),
  write("memoryMigrate", "harness", "POST", "/api/h/:id/memory/migrate", "h.memory.write", {
    dispatch: "job",
  }),
  read("continuity", "/api/h/:id/memory/continuity", "h.read.content"),
  read("continuityTrash", "/api/h/:id/memory/continuity/trash", "h.read.content"),
  write(
    "continuityRestore",
    "harness",
    "POST",
    "/api/h/:id/memory/continuity/restore",
    "h.memory.write",
  ),
  read("learning", "/api/h/:id/memory/learning", "h.read"),
  read("knowledge", "/api/h/:id/memory/knowledge", "h.read"),
  write("knowledgeSync", "harness", "POST", "/api/h/:id/memory/knowledge/sync", "h.memory.write", {
    dispatch: "job",
  }),
  read("dreamScaffold", "/api/h/:id/memory/dream/scaffold", "h.read"),
  write("wikiWrite", "harness", "PUT", "/api/h/:id/memory/wiki/:slug", "h.memory.write"),
  read("wikiVersions", "/api/h/:id/memory/wiki/:slug/versions", "h.read.content"),
  read("wikiVersion", "/api/h/:id/memory/wiki/:slug/versions/:version", "h.read.content"),
  read("wikiLinks", "/api/h/:id/memory/wiki/:slug/links", "h.read.content"),
  write("wikiSignals", "harness", "POST", "/api/h/:id/memory/wiki/:slug/signals", "h.memory.write"),
  write("wikiArchive", "harness", "POST", "/api/h/:id/memory/wiki/:slug/archive", "h.memory.write"),
  read("wikiReflect", "/api/h/:id/memory/reflect", "h.read"),
  read("watchmeAnalytics", "/api/h/:id/memory/watchme/analytics", "h.read"),
  read("watchmeReports", "/api/h/:id/memory/watchme/reports", "h.read"),
  read("watchmeReport", "/api/h/:id/memory/watchme/reports/:stamp", "h.read.content"),
  read("watchmeIntents", "/api/h/:id/memory/watchme/intents", "h.read"),
  write(
    "watchmeToggle",
    "harness",
    "POST",
    "/api/h/:id/memory/watchme/toggle",
    "h.spec.edit.security",
  ),
  read("watchmeSynthesized", "/api/h/:id/memory/watchme/synthesized", "h.read"),
  write(
    "watchmeApply",
    "harness",
    "POST",
    "/api/h/:id/memory/watchme/synthesized/:stamp/apply",
    "h.spec.edit",
  ),
  write("watchmePublish", "harness", "POST", "/api/h/:id/memory/watchme/publish", "h.memory.write"),

  // ---- evals ----
  write("evalLaunch", "harness", "POST", "/api/h/:id/evals/run", "h.eval.run", { dispatch: "job" }),
  read("evalMatrix", "/api/h/:id/evals/matrix", "h.read"),
  read("evalMatrixCell", "/api/h/:id/evals/matrix/:cell", "h.read"),
  read("evalSuites", "/api/h/:id/evals/suites", "h.read"),
  write("evalSuiteRun", "harness", "POST", "/api/h/:id/evals/suites", "h.eval.run", {
    dispatch: "job",
  }),
  read("evalTrends", "/api/h/:id/evals/trends", "h.read"),
  readOnly(
    "evalPlan",
    "POST",
    "/api/h/:id/evals/plan",
    "h.read",
    "plans sample sizes; writes nothing",
  ),
  read("judgeCalibration", "/api/h/:id/evals/judge", "h.read"),
  write("judgeCalibrate", "harness", "POST", "/api/h/:id/evals/judge", "h.quality.edit", {
    dispatch: "job",
  }),
  read("graderCards", "/api/h/:id/evals/graders", "h.read"),
  write("gradersSuggest", "harness", "POST", "/api/h/:id/evals/graders/suggest", "h.eval.run", {
    dispatch: "job",
  }),
  write("gradersTest", "harness", "POST", "/api/h/:id/evals/graders/test", "h.eval.run", {
    dispatch: "job",
  }),
  read("redteam", "/api/h/:id/evals/redteam", "h.read"),
  write("redteamGenerate", "harness", "POST", "/api/h/:id/evals/redteam", "h.quality.edit", {
    dispatch: "job",
  }),
  read("evalCoverage", "/api/h/:id/evals/coverage", "h.read"),
  read("sentinel", "/api/h/:id/evals/sentinel", "h.read"),
  write("sentinelRun", "harness", "POST", "/api/h/:id/evals/sentinel", "h.eval.run", {
    dispatch: "job",
  }),
  read("voiceEvals", "/api/h/:id/evals/voice", "h.read"),
  read("optimizer", "/api/h/:id/evals/optimize", "h.read"),
  write("optimizerRun", "harness", "POST", "/api/h/:id/evals/optimize", "h.quality.edit", {
    dispatch: "job",
  }),
  read("optimizerArtifacts", "/api/h/:id/evals/optimize/:optRunId", "h.read"),
  read("flywheel", "/api/h/:id/evals/flywheel", "h.read"),
  write("flywheelRun", "harness", "POST", "/api/h/:id/evals/flywheel", "h.quality.edit", {
    dispatch: "job",
  }),
  read("experiments", "/api/h/:id/evals/experiments", "h.read"),
  write("experimentRecord", "harness", "POST", "/api/h/:id/evals/experiments", "h.quality.edit", {
    dispatch: "job",
  }),
  read("annotations", "/api/h/:id/evals/annotations", "h.read"),
  write(
    "annotateSample",
    "harness",
    "POST",
    "/api/h/:id/evals/:runId/:sampleId/annotate",
    "h.eval.run",
  ),

  // ---- data ----
  read("datasets", "/api/h/:id/data/datasets", "h.read"),
  read("dataset", "/api/h/:id/data/datasets/:name", "h.read"),
  read("datasetStatus", "/api/h/:id/data/status", "h.read"),
  read("datasetQuarantine", "/api/h/:id/data/quarantine", "h.read"),
  readOnly("datasetVerify", "POST", "/api/h/:id/data/verify", "h.read", "read-only checks"),
  readOnly("datasetAudit", "POST", "/api/h/:id/data/audit", "h.read", "read-only checks"),
  readOnly("datasetLint", "POST", "/api/h/:id/data/lint", "h.read", "read-only checks"),
  write("datasetMine", "harness", "POST", "/api/h/:id/data/mine", "h.data.write", {
    dispatch: "job",
  }),
  write("datasetSynthesize", "harness", "POST", "/api/h/:id/data/synthesize", "h.data.write", {
    dispatch: "job",
  }),
  write(
    "datasetRefreshGoldens",
    "harness",
    "POST",
    "/api/h/:id/data/refresh-goldens",
    "h.data.write",
    { dispatch: "job" },
  ),

  // ---- feedback ----
  read("feedback", "/api/h/:id/feedback", "h.read"),
  write("distillRun", "harness", "POST", "/api/h/:id/feedback/distill", "h.feedback.write", {
    dispatch: "job",
  }),
  read("fewshot", "/api/h/:id/feedback/fewshot", "h.read"),
  write("fewshotHarvest", "harness", "POST", "/api/h/:id/feedback/fewshot", "h.feedback.write", {
    dispatch: "job",
  }),
  read("faq", "/api/h/:id/feedback/faq", "h.read"),
  write("faqDistill", "harness", "POST", "/api/h/:id/feedback/faq", "h.feedback.write", {
    dispatch: "job",
  }),
  read("lessons", "/api/h/:id/feedback/lessons", "h.read"),
  write("lessonsUpdate", "harness", "POST", "/api/h/:id/feedback/lessons", "h.feedback.write", {
    dispatch: "job",
  }),
  read("advice", "/api/h/:id/feedback/advice", "h.read"),
  write("adviceRun", "harness", "POST", "/api/h/:id/feedback/advice", "h.eval.run", {
    dispatch: "job",
  }),
  write(
    "adviceApply",
    "harness",
    "POST",
    "/api/h/:id/feedback/advice/:adviceId/apply",
    "h.spec.edit",
  ),
  read("reactions", "/api/h/:id/feedback/reactions", "h.read"),
  read("feedbackFleet", "/api/feedback", "home.read", ["filtered"]),

  // ---- creds ----
  read("env", "/api/h/:id/env", "h.read"),
  write("envSet", "harness", "POST", "/api/h/:id/env", "h.secrets.write", {
    secretFields: ["value"],
  }),
  write("envUnset", "harness", "DELETE", "/api/h/:id/env/:key", "h.secrets.write"),
  read("credentialsMatrix", "/api/credentials", "home.read", ["filtered"]),
  write("credentialsSetAcross", "workspace", "POST", "/api/credentials/set", "h.secrets.write", {
    secretFields: ["value"],
  }),
  read("doctor", "/api/h/:id/doctor", "h.read"),
  write("doctorRun", "harness", "POST", "/api/h/:id/doctor", "h.eval.run", { dispatch: "job" }),
  read("secrets", "/api/h/:id/secrets", "h.read"),
  read("secretsDoctor", "/api/h/:id/secrets/doctor", "h.read"),
  write("secretsRotate", "harness", "POST", "/api/h/:id/secrets/:name/rotate", "h.secrets.write", {
    secretFields: ["value"],
  }),
  read("mcpLint", "/api/h/:id/mcp/lint", "h.read"),

  // ---- channels ----
  read("channels", "/api/h/:id/channels", "h.read"),
  write("channelVerify", "harness", "POST", "/api/h/:id/channels/verify", "h.eval.run", {
    dispatch: "job",
  }),
  read("channelProvision", "/api/h/:id/channels/:channel/provision", "h.read"),
  write(
    "channelProvisionRun",
    "harness",
    "POST",
    "/api/h/:id/channels/:channel/provision",
    "h.connection.manage",
    { dispatch: "job" },
  ),
  write("channelProbe", "harness", "POST", "/api/h/:id/channels/:channel/probe", "h.eval.run"),
  write(
    "channelSynthetic",
    "harness",
    "POST",
    "/api/h/:id/channels/:channel/synthetic",
    "h.control",
  ),
  read("gateway", "/api/h/:id/gateway", "h.read"),

  // ---- security ----
  read("audit", "/api/h/:id/audit", "h.read.content"),
  readOnly("auditVerify", "POST", "/api/h/:id/audit/verify", "h.read", "verification only"),
  read("egress", "/api/h/:id/security/egress", "h.read"),
  write(
    "egressReview",
    "harness",
    "POST",
    "/api/h/:id/security/egress/:decisionId",
    "h.decision.resolve",
    { qualifiers: ["class"] },
  ),
  read("pii", "/api/h/:id/security/pii", "h.read"),
  write("piiTune", "harness", "POST", "/api/h/:id/security/pii", "h.spec.edit.security"),
  read("justification", "/api/h/:id/security/justification", "h.read"),
  write(
    "justificationCalibrate",
    "harness",
    "POST",
    "/api/h/:id/security/justification/calibrate",
    "h.eval.run",
    { dispatch: "job" },
  ),
  readOnly(
    "justificationPreflight",
    "POST",
    "/api/h/:id/security/justification/preflight",
    "h.read",
    "verification only",
  ),
  read("securityCorpus", "/api/h/:id/security/corpus", "h.read"),
  readOnly(
    "securityCorpusCheck",
    "POST",
    "/api/h/:id/security/corpus",
    "h.read",
    "verification only",
  ),
  read("sandboxDoctor", "/api/h/:id/security/sandbox", "h.read"),
  read("onchain", "/api/h/:id/security/onchain", "h.read"),
  write(
    "onchainTune",
    "harness",
    "POST",
    "/api/h/:id/security/onchain/tune",
    "h.spec.edit.security",
  ),
  read("onchainSentinel", "/api/h/:id/security/onchain/sentinel", "h.read"),
  read("compliance", "/api/h/:id/security/compliance", "h.read"),
  write(
    "complianceEvidence",
    "harness",
    "POST",
    "/api/h/:id/security/compliance",
    "h.settings.write",
    { dispatch: "job" },
  ),
  read("retention", "/api/h/:id/security/retention", "h.read"),
  write(
    "retentionSweep",
    "harness",
    "POST",
    "/api/h/:id/security/retention/sweep",
    "h.retention.manage",
    { dispatch: "job" },
  ),
  write(
    "retentionPurge",
    "harness",
    "POST",
    "/api/h/:id/security/retention/purge",
    "h.retention.manage",
    { dispatch: "job" },
  ),
  read("slo", "/api/h/:id/slo", "h.read"),

  // ---- thredz ----
  read("thredzStatus", "/api/h/:id/thredz", "h.read"),
  read("thredzWiki", "/api/h/:id/thredz/wiki", "h.read"),
  read("thredzWikiArticle", "/api/h/:id/thredz/wiki/:slug", "h.read.content"),
  write("thredzWikiWrite", "harness", "PUT", "/api/h/:id/thredz/wiki/:slug", "h.memory.write"),
  read("thredzWikiVersions", "/api/h/:id/thredz/wiki/:slug/versions", "h.read.content"),
  write(
    "thredzWikiRollback",
    "harness",
    "POST",
    "/api/h/:id/thredz/wiki/:slug/rollback",
    "h.memory.write",
  ),
  read("thredzRecords", "/api/h/:id/thredz/records", "h.read.content"),
  write("thredzRecordCreate", "harness", "POST", "/api/h/:id/thredz/records", "h.memory.write"),
  read("thredzRecord", "/api/h/:id/thredz/records/:recordId", "h.read.content"),
  write(
    "thredzRecordDelete",
    "harness",
    "DELETE",
    "/api/h/:id/thredz/records/:recordId",
    "h.memory.write",
  ),
  write(
    "thredzRecordRestore",
    "harness",
    "POST",
    "/api/h/:id/thredz/records/:recordId/restore",
    "h.memory.write",
  ),
  read("thredzSchemas", "/api/h/:id/thredz/schemas", "h.read"),
  read("thredzGoals", "/api/h/:id/thredz/goals", "h.read"),
  read("thredzTasks", "/api/h/:id/thredz/tasks", "h.read"),
  write("thredzTaskUpdate", "harness", "POST", "/api/h/:id/thredz/tasks/:taskId", "h.memory.write"),
  read("thredzViews", "/api/h/:id/thredz/views", "h.read"),
  readOnly(
    "thredzViewExecute",
    "POST",
    "/api/h/:id/thredz/views/:viewId/execute",
    "h.read.content",
    "runs a saved read",
  ),
  read("thredzDashboards", "/api/h/:id/thredz/dashboards", "h.read"),
  read("thredzDashboard", "/api/h/:id/thredz/dashboards/:dashboardId", "h.read"),
  write(
    "thredzCardCreate",
    "harness",
    "POST",
    "/api/h/:id/thredz/dashboards/:dashboardId/cards",
    "h.memory.write",
  ),
  read("thredzListeners", "/api/h/:id/thredz/listeners", "h.read"),
  write("thredzListenerCreate", "harness", "POST", "/api/h/:id/thredz/listeners", "h.memory.write"),
  read("thredzWebhooks", "/api/h/:id/thredz/webhooks", "h.read"),
  read("thredzConnectors", "/api/h/:id/thredz/connectors", "h.read"),
  read("thredzActivity", "/api/h/:id/thredz/activity", "h.read.content"),
  readOnly("thredzTraverse", "POST", "/api/h/:id/thredz/traverse", "h.read.content", "a read"),
  read("thredzKeys", "/api/h/:id/thredz/keys", "h.read"),
  write("thredzKeyCreate", "harness", "POST", "/api/h/:id/thredz/keys", "h.secrets.write", {
    secretFields: ["value"],
  }),
  write(
    "thredzKeyRotate",
    "harness",
    "POST",
    "/api/h/:id/thredz/keys/:keyId/rotate",
    "h.secrets.write",
    { secretFields: ["value"] },
  ),
  read("thredzGlobal", "/api/thredz", "home.read", ["filtered"]),

  // ---- inspect ----
  read("inspectIndex", "/api/h/:id/inspect", "h.read"),
  read("inspectRaw", "/api/h/:id/inspect/raw", "h.files.raw"),
  read("inspectStore", "/api/h/:id/inspect/:store", "h.files.raw"),
  read("inspectEntry", "/api/h/:id/inspect/:store/:name", "h.files.raw"),
  write("settingsWrite", "harness", "PUT", "/api/h/:id/inspect/settings", "h.settings.write"),

  // ---- advisor ----
  read("advisor", "/api/h/:id/advisor", "h.read"),
  write("advisorAct", "harness", "POST", "/api/h/:id/advisor/:itemId/act", "h.decision.resolve", {
    qualifiers: ["class"],
    dispatch: "job",
  }),
  write(
    "advisorDismiss",
    "harness",
    "POST",
    "/api/h/:id/advisor/:itemId/dismiss",
    "h.decision.resolve",
    { qualifiers: ["class"] },
  ),
  write(
    "advisorReopen",
    "harness",
    "POST",
    "/api/h/:id/advisor/:itemId/reopen",
    "h.decision.resolve",
    { qualifiers: ["class"] },
  ),
  read("advisorTrend", "/api/h/:id/advisor/trend", "h.read"),
  read("advisorReports", "/api/h/:id/advisor/reports", "h.read"),
  write("advisorReportRun", "harness", "POST", "/api/h/:id/advisor/reports", "h.eval.run"),
  read("advisorReport", "/api/h/:id/advisor/reports/:reportId", "h.read"),
  read("advisorIssues", "/api/h/:id/advisor/issues", "h.read"),
  write("advisorIssueSubmit", "harness", "POST", "/api/h/:id/advisor/issues", "h.eval.run", {
    dispatch: "job",
  }),
  read("advisorFleet", "/api/advisor", "home.read", ["filtered"]),

  // ---- models ----
  read("models", "/api/h/:id/models", "h.read"),
  read("modelRoutes", "/api/h/:id/models/routes/:sess", "h.read"),
  read("modelArms", "/api/h/:id/models/arms", "h.read"),
  read("modelLeaderboard", "/api/h/:id/models/leaderboard", "h.read"),

  // ---- runtime ----
  read("mcpServers", "/api/h/:id/mcp-servers", "h.read"),
  write("mcpServerStart", "harness", "POST", "/api/h/:id/mcp-servers/start", "h.control", {
    dispatch: "job",
  }),
  write("mcpServerStop", "harness", "POST", "/api/h/:id/mcp-servers/stop", "h.control"),
  read("dev", "/api/h/:id/dev", "h.read"),
  write("devStart", "harness", "POST", "/api/h/:id/dev/start", "h.control", { dispatch: "job" }),
  write("devStop", "harness", "POST", "/api/h/:id/dev/stop", "h.control"),

  // ---- off the console's map ----
  readOnly(
    "bootTicket",
    "POST",
    "/api/boot-ticket",
    "home.settings.manage",
    "mints a single-use browser handoff; changes no harness and no setting",
  ),
  write("setGroupsAll", "workspace", "PUT", "/api/registry/groups", "home.registry.manage"),
  write("removeGroup", "workspace", "DELETE", "/api/registry/groups", "home.registry.manage"),
  read("scanRoots", "/api/registry/scan-roots", "home.read"),
  write(
    "removeScanRoot",
    "workspace",
    "DELETE",
    "/api/registry/scan-roots",
    "home.registry.manage",
  ),
  read("fleetCosts", "/api/costs", "home.read", ["filtered"]),
  read("runProof", "/api/runs/:sessionId/proof", "h.read.content", ["filtered"]),
];

/** Every row by every key it answers to, aliases included. */
export const ROUTE_BY_KEY: ReadonlyMap<string, RouteRow> = new Map(
  ROUTE_TABLE.flatMap((row) => [row.key, ...(row.aliases ?? [])].map((key) => [key, row] as const)),
);

const TEMPLATES = ROUTE_TABLE.map((row) => {
  const segments = row.path.split("/").filter((s) => s !== "");
  return { row, segments, literals: segments.filter((s) => !s.startsWith(":")).length };
});

/**
 * The row for a request, literal-first like the M3 matcher: among the templates that
 * match, the one with the most literal segments wins, so `evals/matrix` beats
 * `evals/:runId`. `segments` is the decoded path split without the empty first piece,
 * `["api", "h", "hrn_…", "spec"]`. A parameter matches any one non-empty segment. `only`
 * narrows the rows considered.
 */
export function matchRoute(
  method: string,
  segments: readonly string[],
  only: (row: RouteRow) => boolean = () => true,
): { readonly row: RouteRow; readonly params: Readonly<Record<string, string>> } | undefined {
  let best: { row: RouteRow; params: Record<string, string> } | undefined;
  let bestScore = -1;
  for (const { row, segments: template, literals } of TEMPLATES) {
    if (row.method !== method || template.length !== segments.length || !only(row)) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < template.length; i += 1) {
      const part = template[i] as string;
      const value = segments[i] as string;
      if (part.startsWith(":")) {
        if (value === "") {
          ok = false;
          break;
        }
        params[part.slice(1)] = value;
      } else if (part !== value) {
        ok = false;
        break;
      }
    }
    if (ok && literals > bestScore) {
      best = { row, params };
      bestScore = literals;
    }
  }
  return best;
}
