/**
 * The route contract as pure data — the ONE place client code names a
 * server path. `api.js` builds every request from this map, and the hangar
 * server's contract test (`packages/hangar-server/src/contract.test.ts`)
 * imports the same map and drives every route here against a live fixture
 * server: writes must 2xx with a visible effect, reads must 2xx with every
 * field the views consume present. A route drifting from the server fails
 * that test — the alarm that keeps this file honest.
 *
 * Each entry: `{ method, path }` where `path` is a template whose `:name`
 * segments `buildPath` fills (values URI-encoded). Writes carry `body`, the
 * name of their request-body shape (documentation for humans + the contract
 * test; the shapes themselves are defined by the server handlers).
 * `stream: "sse"` marks a route whose response is `text/event-stream`, not
 * JSON — `api.js` must not `res.json()` it.
 *
 * M1 was read-only over harness state. M2 makes the console a DRIVER: the
 * process routes start/stop/restart/drain a supervised harness, the control
 * routes proxy `crewhaus.control.v1` (the token is read server-side and
 * never crosses this boundary), and the approvals/review routes settle
 * parked work through the same stores the CLI writes through.
 *
 * M3 is the DETAIL surface, and every M3 entry carries one extra field:
 * `group`, naming the area that owns it (spec / memory / evals / data /
 * feedback / creds / channels / security / thredz / inspect / runtime).
 * That single field does a lot of work — it is what lets `api.js` generate
 * the client wrappers instead of hand-writing 180 of them, what the views
 * read to render their own surface honestly while the handlers are still
 * stubs, and what the server's dispatch table is asserted equal to. A route
 * WITHOUT a group is M1/M2 and has a hand-written wrapper.
 *
 * The M3 handlers currently answer `501 not implemented (M3)`. That is a
 * deliberate state, not an oversight: the contract is frozen first so six
 * implementers can fill the bodies in parallel without colliding, and the
 * contract test accepts a 501 today and demands the view's fields the moment
 * a route goes real.
 */

export const ROUTES = {
  // cross-cutting
  version: { method: "GET", path: "/api/version" },

  // fleet feed + registry CRUD (the ONLY writes in M1 — manager state)
  harnesses: { method: "GET", path: "/api/harnesses" },
  addHarness: { method: "POST", path: "/api/harnesses", body: "AddHarness" }, // {dir}
  scan: { method: "POST", path: "/api/scan", body: "Empty" }, // {}
  groups: { method: "GET", path: "/api/registry/groups" },
  addGroup: { method: "POST", path: "/api/registry/groups", body: "GroupCreate" }, // {name, color?}
  // Group-ordered bulk lifecycle. PLAN first, then act: a fleet sweep is the
  // one lifecycle action an operator should read before authorizing, and the
  // plan is the same object the walk consumes.
  groupProcPlan: { method: "GET", path: "/api/registry/groups/:name/proc/:verb" },
  groupProc: {
    method: "POST",
    path: "/api/registry/groups/:name/proc/:verb",
    body: "GroupProc", // {force?, acknowledge?, parallel?}
  },
  addScanRoot: { method: "POST", path: "/api/registry/scan-roots", body: "ScanRootCreate" }, // {dir}
  removeHarness: { method: "DELETE", path: "/api/h/:id" },
  relocate: { method: "POST", path: "/api/h/:id/relocate", body: "Relocate" }, // {newDir}
  setGroups: { method: "PUT", path: "/api/h/:id/groups", body: "SetGroups" }, // {groups}
  // One member's BOOT position inside a group; `order: null` clears it.
  setGroupOrder: { method: "PUT", path: "/api/h/:id/groups", body: "SetGroupOrder" }, // {group, order}
  setTags: { method: "PUT", path: "/api/h/:id/tags", body: "SetTags" }, // {tags}
  setPin: { method: "PUT", path: "/api/h/:id/pin", body: "SetPin" }, // {pinned}
  setNotes: { method: "PUT", path: "/api/h/:id/notes", body: "SetNotes" }, // {notes}

  // per-harness reads
  harness: { method: "GET", path: "/api/h/:id" },
  spec: { method: "GET", path: "/api/h/:id/spec" },
  preflight: { method: "GET", path: "/api/h/:id/preflight" },
  sessions: { method: "GET", path: "/api/h/:id/sessions" },
  session: { method: "GET", path: "/api/h/:id/sessions/:sess" },
  evals: { method: "GET", path: "/api/h/:id/evals" },
  evalRun: { method: "GET", path: "/api/h/:id/evals/:runId" },
  evalSample: { method: "GET", path: "/api/h/:id/evals/:runId/:sampleId" },
  memory: { method: "GET", path: "/api/h/:id/memory/:area" },
  wikiArticle: { method: "GET", path: "/api/h/:id/memory/wiki/:slug" },
  costs: { method: "GET", path: "/api/h/:id/costs" },

  // ---- M2: the process layer -------------------------------------------
  // `start` runs the preflight gate FIRST and answers the typed refusal
  // instead of spawning; `{force}` waves through every forceable blocking
  // item and `{acknowledge:[id]}` waves through named ones — neither can
  // clear an UNFORCEABLE finding (missing channel secrets), because the
  // compiled daemon exits 2 on exactly that set.
  proc: { method: "GET", path: "/api/h/:id/proc" },
  procStart: { method: "POST", path: "/api/h/:id/proc/start", body: "ProcStart" }, // {force?, acknowledge?}
  procStop: { method: "POST", path: "/api/h/:id/proc/stop", body: "Empty" }, // {}
  procRestart: { method: "POST", path: "/api/h/:id/proc/restart", body: "ProcStart" }, // {force?, acknowledge?}
  procDrain: { method: "POST", path: "/api/h/:id/proc/drain", body: "Empty" }, // {}

  // run history + the live feed. `runEvents` is SSE: it opens with a
  // `replay` frame of durable history and ALWAYS ends with `done`.
  runs: { method: "GET", path: "/api/h/:id/runs" },
  run: { method: "GET", path: "/api/h/:id/runs/:runId" },
  runEvents: { method: "GET", path: "/api/h/:id/runs/:runId/events", stream: "sse" },

  // ---- M2: crewhaus.control.v1 proxy -----------------------------------
  // Always 200 with a typed envelope: `{ok:true,…}` or `{ok:false, code,
  // reason, retryable, expected}`. `no_control_port` (pre-0.5.0 bundle) and
  // `lane_not_armed` are FACTS, not errors — render disabled-with-reason.
  // The two 409s differ: `tick_in_flight` retries, `draining` does not.
  controlStatus: { method: "GET", path: "/api/h/:id/control/status" },
  controlWake: { method: "POST", path: "/api/h/:id/control/wake", body: "ControlWake" }, // {lane, reason?}
  controlDrain: { method: "POST", path: "/api/h/:id/control/drain", body: "Empty" }, // {}

  // the four-lane timeline: spec cadence (offline) merged with control.v1
  // phase (online only), plus dream state and janitor rows
  schedulers: { method: "GET", path: "/api/h/:id/schedulers" },

  // ---- M2: fleet inboxes ------------------------------------------------
  approvals: { method: "GET", path: "/api/approvals" },
  grantApproval: {
    method: "POST",
    path: "/api/h/:id/approvals/:apprId/grant",
    body: "ApprovalDecision", // {by?}
  },
  denyApproval: {
    method: "POST",
    path: "/api/h/:id/approvals/:apprId/deny",
    body: "ApprovalDecision", // {by?}
  },
  review: { method: "GET", path: "/api/review" },
  adjudicateReview: {
    method: "POST",
    path: "/api/h/:id/review/:itemId",
    body: "ReviewVerdict", // {verdict: up|down|pass|fail, note?}
  },
  activity: { method: "GET", path: "/api/activity" }, // ?since=<iso|epochMs|7d>

  // ---- M2: jobs + the remaining action faces ----------------------------
  jobs: { method: "GET", path: "/api/jobs" },
  submitJob: { method: "POST", path: "/api/h/:id/jobs", body: "JobSubmit" }, // {kind, dataset?, graders?}
  deployments: { method: "GET", path: "/api/h/:id/deployments" },
  pinSession: { method: "POST", path: "/api/h/:id/sessions/:sess/pin", body: "PinSession" }, // {pinned}
  pinBaseline: { method: "POST", path: "/api/h/:id/evals/baseline", body: "PinBaseline" }, // {runId}

  // ---- M4: polish, fleet ops, notifications -----------------------------
  // Real handlers, not stubs — so these carry NO `group` and are driven by
  // the contract test like any M1/M2 route.
  //
  // `health` is the explained score (HM-11): never a bare number, always the
  // deductions that produced it, each naming the tab that fixes it.
  // `fleetHealth` runs a preflight per harness, so it is the "needs
  // attention" board an operator opens — never the Library's first paint.
  health: { method: "GET", path: "/api/h/:id/health" },
  fleetHealth: { method: "GET", path: "/api/health" },

  // First boot (HM-12). `demoInstall` copies a starter out of a LOCAL demos
  // checkout; with none configured it answers 409 naming the repo, the env
  // var and the CLI verb — it never fetches code from the network.
  onboarding: { method: "GET", path: "/api/onboarding" },
  demoInstall: { method: "POST", path: "/api/onboarding/demo", body: "DemoInstall" }, // {starter, dir}

  // ⌘K (HM-189). `?q=` + optional `?limit=`. The response's `actions` are
  // PROPOSALS carrying a route key and a CLI twin; the console executes them
  // through the ordinary route after an explicit confirm, so an action is
  // never a side effect of typing.
  search: { method: "GET", path: "/api/search" },

  // Notification rules (HM-183). The GET is the badge poll AND the
  // evaluation pass (the manager runs no timer of its own).
  notifications: { method: "GET", path: "/api/notifications" },
  setNotifications: { method: "PUT", path: "/api/notifications", body: "NotificationRules" },
  clearNotifications: { method: "POST", path: "/api/notifications/clear", body: "Empty" }, // {}

  // Read-only mode (HM-187) — enforced SERVER-side ahead of every handler.
  readOnly: { method: "GET", path: "/api/read-only" },
  setReadOnly: { method: "PUT", path: "/api/read-only", body: "ReadOnly" }, // {enabled}

  // Plugin SDK minimal wiring (HM-179): the inventory (which extension
  // points are wired and which are declared-but-deferred), one pane document
  // with the sandbox + CSP that must accompany it, and the panes a given
  // harness shows after the fail-closed fs permission is evaluated.
  plugins: { method: "GET", path: "/api/plugins" },
  pluginPane: { method: "GET", path: "/api/plugins/:plugin/panes/:pane" },
  panes: { method: "GET", path: "/api/h/:id/panes" },

  // ======================================================================
  // M3 — the detail surface. Every entry carries `group`.
  // ======================================================================

  // ---- group "spec": structured editing, trust tiers, versions, builders
  // Writes go through @crewhaus/spec-patch `applySpecEdits`, never by
  // templating YAML. Auto-tunable paths (OPTIMIZABLE_PATHS) apply directly;
  // human-owned paths need the redacted diff + typed confirm, or `propose`.
  specEdit: { method: "PUT", path: "/api/h/:id/spec", body: "SpecEdits", group: "spec" },
  specPatch: { method: "POST", path: "/api/h/:id/spec/patch", body: "SpecPatch", group: "spec" },
  specDiff: { method: "POST", path: "/api/h/:id/spec/diff", body: "SpecEdits", group: "spec" },
  specSchema: { method: "GET", path: "/api/h/:id/spec/schema", group: "spec" },
  specTrust: { method: "GET", path: "/api/h/:id/spec/trust", group: "spec" },
  specVersions: { method: "GET", path: "/api/h/:id/spec/versions", group: "spec" },
  specVersion: { method: "GET", path: "/api/h/:id/spec/versions/:version", group: "spec" },
  specVersionDiff: { method: "GET", path: "/api/h/:id/spec/versions/:version/diff", group: "spec" },
  specPin: { method: "POST", path: "/api/h/:id/spec/pin", body: "SpecPin", group: "spec" },
  specRollback: {
    method: "POST",
    path: "/api/h/:id/spec/rollback",
    body: "SpecRollback",
    group: "spec",
  },
  specPropose: {
    method: "POST",
    path: "/api/h/:id/spec/propose",
    body: "SpecPropose",
    group: "spec",
  },
  wizardTemplates: { method: "GET", path: "/api/builders/templates", group: "spec" },
  wizardCreate: { method: "POST", path: "/api/builders/spec", body: "WizardSpec", group: "spec" },
  mcpCatalog: { method: "GET", path: "/api/builders/mcp-catalog", group: "spec" },
  graderCatalog: { method: "GET", path: "/api/h/:id/builders/graders", group: "spec" },
  graderWrite: {
    method: "POST",
    path: "/api/h/:id/builders/graders",
    body: "GraderBuild",
    group: "spec",
  },
  datasetBuilder: { method: "GET", path: "/api/h/:id/builders/dataset", group: "spec" },
  datasetBuilderStep: {
    method: "POST",
    path: "/api/h/:id/builders/dataset",
    body: "DatasetBuildStep",
    group: "spec",
  },
  mcpConnectors: { method: "GET", path: "/api/h/:id/builders/mcp", group: "spec" },
  mcpConnectorWrite: {
    method: "POST",
    path: "/api/h/:id/builders/mcp",
    body: "McpConnector",
    group: "spec",
  },
  mcpConnectorRemove: { method: "DELETE", path: "/api/h/:id/builders/mcp/:name", group: "spec" },

  // ---- group "memory": facts, continuity, wiki, watchme, learning -------
  // NO HARD DELETE ANYWHERE: forget = a supersede tombstone with a reason,
  // continuity clear = trash/<ts>/ with restore, wiki = archived status.
  memoryFacts: { method: "GET", path: "/api/h/:id/memory/facts/:spec", group: "memory" },
  memoryForget: {
    method: "POST",
    path: "/api/h/:id/memory/facts/:spec/forget",
    body: "MemoryForget",
    group: "memory",
  },
  memorySweep: {
    method: "POST",
    path: "/api/h/:id/memory/facts/:spec/sweep",
    body: "DryRun",
    group: "memory",
  },
  memoryRecall: {
    method: "POST",
    path: "/api/h/:id/memory/recall",
    body: "RecallQuery",
    group: "memory",
  },
  memoryMigrate: {
    method: "POST",
    path: "/api/h/:id/memory/migrate",
    body: "DryRun",
    group: "memory",
  },
  continuity: { method: "GET", path: "/api/h/:id/memory/continuity", group: "memory" },
  continuityTrash: { method: "GET", path: "/api/h/:id/memory/continuity/trash", group: "memory" },
  continuityRestore: {
    method: "POST",
    path: "/api/h/:id/memory/continuity/restore",
    body: "ContinuityRestore",
    group: "memory",
  },
  learning: { method: "GET", path: "/api/h/:id/memory/learning", group: "memory" },
  knowledge: { method: "GET", path: "/api/h/:id/memory/knowledge", group: "memory" },
  knowledgeSync: {
    method: "POST",
    path: "/api/h/:id/memory/knowledge/sync",
    body: "KnowledgeSync",
    group: "memory",
  },
  dreamScaffold: { method: "GET", path: "/api/h/:id/memory/dream/scaffold", group: "memory" },
  // Wiki writes carry `expectedVersion`; a stale version is a re-read-retry
  // state, not an error — identical UX for the local and Thredz backends.
  wikiWrite: {
    method: "PUT",
    path: "/api/h/:id/memory/wiki/:slug",
    body: "WikiWrite",
    group: "memory",
  },
  wikiVersions: { method: "GET", path: "/api/h/:id/memory/wiki/:slug/versions", group: "memory" },
  wikiVersion: {
    method: "GET",
    path: "/api/h/:id/memory/wiki/:slug/versions/:version",
    group: "memory",
  },
  wikiLinks: { method: "GET", path: "/api/h/:id/memory/wiki/:slug/links", group: "memory" },
  wikiSignals: {
    method: "POST",
    path: "/api/h/:id/memory/wiki/:slug/signals",
    body: "WikiSignals",
    group: "memory",
  },
  wikiArchive: {
    method: "POST",
    path: "/api/h/:id/memory/wiki/:slug/archive",
    body: "WikiArchive",
    group: "memory",
  },
  wikiReflect: { method: "GET", path: "/api/h/:id/memory/reflect", group: "memory" },
  watchmeAnalytics: { method: "GET", path: "/api/h/:id/memory/watchme/analytics", group: "memory" },
  watchmeReports: { method: "GET", path: "/api/h/:id/memory/watchme/reports", group: "memory" },
  watchmeReport: {
    method: "GET",
    path: "/api/h/:id/memory/watchme/reports/:stamp",
    group: "memory",
  },
  watchmeIntents: { method: "GET", path: "/api/h/:id/memory/watchme/intents", group: "memory" },
  watchmeToggle: {
    method: "POST",
    path: "/api/h/:id/memory/watchme/toggle",
    body: "WatchmeToggle",
    group: "memory",
  },
  watchmeSynthesized: {
    method: "GET",
    path: "/api/h/:id/memory/watchme/synthesized",
    group: "memory",
  },
  watchmeApply: {
    method: "POST",
    path: "/api/h/:id/memory/watchme/synthesized/:stamp/apply",
    body: "SynthesizeApply",
    group: "memory",
  },
  watchmePublish: {
    method: "POST",
    path: "/api/h/:id/memory/watchme/publish",
    body: "DryRun",
    group: "memory",
  },

  // ---- group "evals": the quality lab -----------------------------------
  evalLaunch: { method: "POST", path: "/api/h/:id/evals/run", body: "EvalLaunch", group: "evals" },
  evalMatrix: { method: "GET", path: "/api/h/:id/evals/matrix", group: "evals" },
  evalMatrixCell: { method: "GET", path: "/api/h/:id/evals/matrix/:cell", group: "evals" },
  evalSuites: { method: "GET", path: "/api/h/:id/evals/suites", group: "evals" },
  evalSuiteRun: {
    method: "POST",
    path: "/api/h/:id/evals/suites",
    body: "SuiteRun",
    group: "evals",
  },
  evalTrends: { method: "GET", path: "/api/h/:id/evals/trends", group: "evals" },
  evalPlan: { method: "POST", path: "/api/h/:id/evals/plan", body: "EvalPlan", group: "evals" },
  judgeCalibration: { method: "GET", path: "/api/h/:id/evals/judge", group: "evals" },
  judgeCalibrate: {
    method: "POST",
    path: "/api/h/:id/evals/judge",
    body: "JudgeCalibrate",
    group: "evals",
  },
  graderCards: { method: "GET", path: "/api/h/:id/evals/graders", group: "evals" },
  gradersSuggest: {
    method: "POST",
    path: "/api/h/:id/evals/graders/suggest",
    body: "Empty",
    group: "evals",
  },
  gradersTest: {
    method: "POST",
    path: "/api/h/:id/evals/graders/test",
    body: "GradersTest",
    group: "evals",
  },
  redteam: { method: "GET", path: "/api/h/:id/evals/redteam", group: "evals" },
  redteamGenerate: {
    method: "POST",
    path: "/api/h/:id/evals/redteam",
    body: "RedteamGenerate",
    group: "evals",
  },
  evalCoverage: { method: "GET", path: "/api/h/:id/evals/coverage", group: "evals" },
  sentinel: { method: "GET", path: "/api/h/:id/evals/sentinel", group: "evals" },
  sentinelRun: {
    method: "POST",
    path: "/api/h/:id/evals/sentinel",
    body: "SentinelRun",
    group: "evals",
  },
  voiceEvals: { method: "GET", path: "/api/h/:id/evals/voice", group: "evals" },
  optimizer: { method: "GET", path: "/api/h/:id/evals/optimize", group: "evals" },
  optimizerRun: {
    method: "POST",
    path: "/api/h/:id/evals/optimize",
    body: "OptimizeRun",
    group: "evals",
  },
  optimizerArtifacts: {
    method: "GET",
    path: "/api/h/:id/evals/optimize/:optRunId",
    group: "evals",
  },
  flywheel: { method: "GET", path: "/api/h/:id/evals/flywheel", group: "evals" },
  flywheelRun: {
    method: "POST",
    path: "/api/h/:id/evals/flywheel",
    body: "FlywheelRun",
    group: "evals",
  },
  experiments: { method: "GET", path: "/api/h/:id/evals/experiments", group: "evals" },
  experimentRecord: {
    method: "POST",
    path: "/api/h/:id/evals/experiments",
    body: "ExperimentRecord",
    group: "evals",
  },
  annotations: { method: "GET", path: "/api/h/:id/evals/annotations", group: "evals" },
  annotateSample: {
    method: "POST",
    path: "/api/h/:id/evals/:runId/:sampleId/annotate",
    body: "SampleAnnotation",
    group: "evals",
  },

  // ---- group "data": the dataset registry, hygiene, growth ---------------
  // The dataset NAME travels in the BODY for every write: an operator-chosen
  // string must not sit where a literal route keyword lives.
  datasets: { method: "GET", path: "/api/h/:id/data/datasets", group: "data" },
  dataset: { method: "GET", path: "/api/h/:id/data/datasets/:name", group: "data" },
  datasetStatus: { method: "GET", path: "/api/h/:id/data/status", group: "data" },
  datasetQuarantine: { method: "GET", path: "/api/h/:id/data/quarantine", group: "data" },
  datasetVerify: {
    method: "POST",
    path: "/api/h/:id/data/verify",
    body: "DatasetName",
    group: "data",
  },
  datasetAudit: { method: "POST", path: "/api/h/:id/data/audit", body: "Empty", group: "data" },
  datasetLint: { method: "POST", path: "/api/h/:id/data/lint", body: "Empty", group: "data" },
  datasetMine: { method: "POST", path: "/api/h/:id/data/mine", body: "DatasetMine", group: "data" },
  datasetSynthesize: {
    method: "POST",
    path: "/api/h/:id/data/synthesize",
    body: "DatasetSynthesize",
    group: "data",
  },
  datasetRefreshGoldens: {
    method: "POST",
    path: "/api/h/:id/data/refresh-goldens",
    body: "DatasetName",
    group: "data",
  },

  // ---- group "feedback": the growth loops --------------------------------
  feedback: { method: "GET", path: "/api/h/:id/feedback", group: "feedback" },
  distillRun: {
    method: "POST",
    path: "/api/h/:id/feedback/distill",
    body: "DistillRun",
    group: "feedback",
  },
  fewshot: { method: "GET", path: "/api/h/:id/feedback/fewshot", group: "feedback" },
  fewshotHarvest: {
    method: "POST",
    path: "/api/h/:id/feedback/fewshot",
    body: "Empty",
    group: "feedback",
  },
  faq: { method: "GET", path: "/api/h/:id/feedback/faq", group: "feedback" },
  faqDistill: { method: "POST", path: "/api/h/:id/feedback/faq", body: "Empty", group: "feedback" },
  lessons: { method: "GET", path: "/api/h/:id/feedback/lessons", group: "feedback" },
  lessonsUpdate: {
    method: "POST",
    path: "/api/h/:id/feedback/lessons",
    body: "Empty",
    group: "feedback",
  },
  advice: { method: "GET", path: "/api/h/:id/feedback/advice", group: "feedback" },
  adviceRun: {
    method: "POST",
    path: "/api/h/:id/feedback/advice",
    body: "AdviseRun",
    group: "feedback",
  },
  adviceApply: {
    method: "POST",
    path: "/api/h/:id/feedback/advice/:adviceId/apply",
    body: "Confirm",
    group: "feedback",
  },
  reactions: { method: "GET", path: "/api/h/:id/feedback/reactions", group: "feedback" },
  feedbackFleet: { method: "GET", path: "/api/feedback", group: "feedback" },

  // ---- group "creds": env, the fleet matrix, doctor, secrets, mcp lint ---
  // Values go IN and never come back: every read here is presence booleans.
  env: { method: "GET", path: "/api/h/:id/env", group: "creds" },
  envSet: { method: "POST", path: "/api/h/:id/env", body: "EnvSet", group: "creds" },
  envUnset: { method: "DELETE", path: "/api/h/:id/env/:key", group: "creds" },
  credentialsMatrix: { method: "GET", path: "/api/credentials", group: "creds" },
  credentialsSetAcross: {
    method: "POST",
    path: "/api/credentials/set",
    body: "SetAcross",
    group: "creds",
  },
  doctor: { method: "GET", path: "/api/h/:id/doctor", group: "creds" },
  doctorRun: { method: "POST", path: "/api/h/:id/doctor", body: "DoctorRun", group: "creds" },
  secrets: { method: "GET", path: "/api/h/:id/secrets", group: "creds" },
  secretsDoctor: { method: "GET", path: "/api/h/:id/secrets/doctor", group: "creds" },
  secretsRotate: {
    method: "POST",
    path: "/api/h/:id/secrets/:name/rotate",
    body: "SecretRotate",
    group: "creds",
  },
  mcpLint: { method: "GET", path: "/api/h/:id/mcp/lint", group: "creds" },

  // ---- group "channels": provisioning, verify, the two test tiers --------
  channels: { method: "GET", path: "/api/h/:id/channels", group: "channels" },
  channelVerify: {
    method: "POST",
    path: "/api/h/:id/channels/verify",
    body: "ChannelVerify",
    group: "channels",
  },
  channelProvision: {
    method: "GET",
    path: "/api/h/:id/channels/:channel/provision",
    group: "channels",
  },
  channelProvisionRun: {
    method: "POST",
    path: "/api/h/:id/channels/:channel/provision",
    body: "Confirm",
    group: "channels",
  },
  channelProbe: {
    method: "POST",
    path: "/api/h/:id/channels/:channel/probe",
    body: "Empty",
    group: "channels",
  },
  // Tier 2 — Slack/Telegram/WhatsApp only. Discord is asymmetric Ed25519
  // (the harness holds only the public key), iMessage has no inbound webhook.
  channelSynthetic: {
    method: "POST",
    path: "/api/h/:id/channels/:channel/synthetic",
    body: "SyntheticInbound",
    group: "channels",
  },
  gateway: { method: "GET", path: "/api/h/:id/gateway", group: "channels" },

  // ---- group "security": audit, egress, pii, onchain, retention, slo -----
  audit: { method: "GET", path: "/api/h/:id/audit", group: "security" },
  auditVerify: {
    method: "POST",
    path: "/api/h/:id/audit/verify",
    body: "Empty",
    group: "security",
  },
  egress: { method: "GET", path: "/api/h/:id/security/egress", group: "security" },
  egressReview: {
    method: "POST",
    path: "/api/h/:id/security/egress/:decisionId",
    body: "EgressVerdict",
    group: "security",
  },
  pii: { method: "GET", path: "/api/h/:id/security/pii", group: "security" },
  piiTune: {
    method: "POST",
    path: "/api/h/:id/security/pii",
    body: "PolicyTune",
    group: "security",
  },
  justification: { method: "GET", path: "/api/h/:id/security/justification", group: "security" },
  justificationCalibrate: {
    method: "POST",
    path: "/api/h/:id/security/justification/calibrate",
    body: "Calibrate",
    group: "security",
  },
  justificationPreflight: {
    method: "POST",
    path: "/api/h/:id/security/justification/preflight",
    body: "JustificationPreflight",
    group: "security",
  },
  securityCorpus: { method: "GET", path: "/api/h/:id/security/corpus", group: "security" },
  securityCorpusCheck: {
    method: "POST",
    path: "/api/h/:id/security/corpus",
    body: "Empty",
    group: "security",
  },
  sandboxDoctor: { method: "GET", path: "/api/h/:id/security/sandbox", group: "security" },
  onchain: { method: "GET", path: "/api/h/:id/security/onchain", group: "security" },
  onchainTune: {
    method: "POST",
    path: "/api/h/:id/security/onchain/tune",
    body: "PolicyTune",
    group: "security",
  },
  onchainSentinel: {
    method: "GET",
    path: "/api/h/:id/security/onchain/sentinel",
    group: "security",
  },
  compliance: { method: "GET", path: "/api/h/:id/security/compliance", group: "security" },
  complianceEvidence: {
    method: "POST",
    path: "/api/h/:id/security/compliance",
    body: "ComplianceEvidence",
    group: "security",
  },
  retention: { method: "GET", path: "/api/h/:id/security/retention", group: "security" },
  // Dry-run first, then typed-confirm — the top rung of the ladder.
  retentionSweep: {
    method: "POST",
    path: "/api/h/:id/security/retention/sweep",
    body: "RetentionRun",
    group: "security",
  },
  retentionPurge: {
    method: "POST",
    path: "/api/h/:id/security/retention/purge",
    body: "RetentionRun",
    group: "security",
  },
  slo: { method: "GET", path: "/api/h/:id/slo", group: "security" },

  // ---- group "thredz": the server-side proxied explorer ------------------
  // The API key lives in the harness and is read server-side per request.
  // It never reaches this file, this browser, or manager state.
  thredzStatus: { method: "GET", path: "/api/h/:id/thredz", group: "thredz" },
  thredzWiki: { method: "GET", path: "/api/h/:id/thredz/wiki", group: "thredz" },
  thredzWikiArticle: { method: "GET", path: "/api/h/:id/thredz/wiki/:slug", group: "thredz" },
  thredzWikiWrite: {
    method: "PUT",
    path: "/api/h/:id/thredz/wiki/:slug",
    body: "ThredzWikiWrite",
    group: "thredz",
  },
  thredzWikiVersions: {
    method: "GET",
    path: "/api/h/:id/thredz/wiki/:slug/versions",
    group: "thredz",
  },
  thredzWikiRollback: {
    method: "POST",
    path: "/api/h/:id/thredz/wiki/:slug/rollback",
    body: "ThredzRollback",
    group: "thredz",
  },
  thredzRecords: { method: "GET", path: "/api/h/:id/thredz/records", group: "thredz" },
  thredzRecordCreate: {
    method: "POST",
    path: "/api/h/:id/thredz/records",
    body: "ThredzRecord",
    group: "thredz",
  },
  thredzRecord: { method: "GET", path: "/api/h/:id/thredz/records/:recordId", group: "thredz" },
  // Soft delete only — every Thredz delete has a restore.
  thredzRecordDelete: {
    method: "DELETE",
    path: "/api/h/:id/thredz/records/:recordId",
    group: "thredz",
  },
  thredzRecordRestore: {
    method: "POST",
    path: "/api/h/:id/thredz/records/:recordId/restore",
    body: "Empty",
    group: "thredz",
  },
  thredzSchemas: { method: "GET", path: "/api/h/:id/thredz/schemas", group: "thredz" },
  thredzGoals: { method: "GET", path: "/api/h/:id/thredz/goals", group: "thredz" },
  thredzTasks: { method: "GET", path: "/api/h/:id/thredz/tasks", group: "thredz" },
  thredzTaskUpdate: {
    method: "POST",
    path: "/api/h/:id/thredz/tasks/:taskId",
    body: "ThredzTaskUpdate",
    group: "thredz",
  },
  thredzViews: { method: "GET", path: "/api/h/:id/thredz/views", group: "thredz" },
  thredzViewExecute: {
    method: "POST",
    path: "/api/h/:id/thredz/views/:viewId/execute",
    body: "ThredzViewExec",
    group: "thredz",
  },
  thredzDashboards: { method: "GET", path: "/api/h/:id/thredz/dashboards", group: "thredz" },
  thredzDashboard: {
    method: "GET",
    path: "/api/h/:id/thredz/dashboards/:dashboardId",
    group: "thredz",
  },
  thredzCardCreate: {
    method: "POST",
    path: "/api/h/:id/thredz/dashboards/:dashboardId/cards",
    body: "ThredzCard",
    group: "thredz",
  },
  thredzListeners: { method: "GET", path: "/api/h/:id/thredz/listeners", group: "thredz" },
  thredzListenerCreate: {
    method: "POST",
    path: "/api/h/:id/thredz/listeners",
    body: "ThredzListener",
    group: "thredz",
  },
  thredzWebhooks: { method: "GET", path: "/api/h/:id/thredz/webhooks", group: "thredz" },
  thredzConnectors: { method: "GET", path: "/api/h/:id/thredz/connectors", group: "thredz" },
  thredzActivity: { method: "GET", path: "/api/h/:id/thredz/activity", group: "thredz" },
  thredzTraverse: {
    method: "POST",
    path: "/api/h/:id/thredz/traverse",
    body: "ThredzTraverse",
    group: "thredz",
  },
  thredzKeys: { method: "GET", path: "/api/h/:id/thredz/keys", group: "thredz" },
  thredzKeyCreate: {
    method: "POST",
    path: "/api/h/:id/thredz/keys",
    body: "ThredzKeyCreate",
    group: "thredz",
  },
  thredzKeyRotate: {
    method: "POST",
    path: "/api/h/:id/thredz/keys/:keyId/rotate",
    body: "Confirm",
    group: "thredz",
  },
  thredzGlobal: { method: "GET", path: "/api/thredz", group: "thredz" },

  // ---- group "inspect": the raw browsers + settings.json -----------------
  // secrets/, the raw audit files and .env are excluded server-side.
  inspectIndex: { method: "GET", path: "/api/h/:id/inspect", group: "inspect" },
  inspectRaw: { method: "GET", path: "/api/h/:id/inspect/raw", group: "inspect" }, // ?path=
  inspectStore: { method: "GET", path: "/api/h/:id/inspect/:store", group: "inspect" },
  inspectEntry: { method: "GET", path: "/api/h/:id/inspect/:store/:name", group: "inspect" },
  settingsWrite: {
    method: "PUT",
    path: "/api/h/:id/inspect/settings",
    body: "SettingsWrite",
    group: "inspect",
  },

  // ---- group "runtime": the mcp-server + dev run classes -----------------
  // Both are PROCESSES: they get runfiles, ledger rows and ledger-claimed
  // ports, and their live output rides the ONE existing SSE feed
  // (`runEvents`) — M3 adds no second streaming mechanism.
  mcpServers: { method: "GET", path: "/api/h/:id/mcp-servers", group: "runtime" },
  mcpServerStart: {
    method: "POST",
    path: "/api/h/:id/mcp-servers/start",
    body: "McpServerStart",
    group: "runtime",
  },
  mcpServerStop: {
    method: "POST",
    path: "/api/h/:id/mcp-servers/stop",
    body: "Empty",
    group: "runtime",
  },
  dev: { method: "GET", path: "/api/h/:id/dev", group: "runtime" },
  devStart: { method: "POST", path: "/api/h/:id/dev/start", body: "DevStart", group: "runtime" },
  devStop: { method: "POST", path: "/api/h/:id/dev/stop", body: "Empty", group: "runtime" },
};

/** The M3 area groups, in tab order. A route's `group` names the module that
 *  owns it on the server and the view that renders it in the console. */
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
];

/** Every route key belonging to `group`, in map order. The views render
 *  their own surface from this while the handlers are still stubs, so a
 *  "not built yet" screen still tells the truth about what is coming. */
export function routeKeysInGroup(group) {
  return Object.keys(ROUTES).filter((key) => ROUTES[key].group === group);
}

/** Every M3 route key (any route carrying a `group`). */
export function m3RouteKeys() {
  return Object.keys(ROUTES).filter((key) => typeof ROUTES[key].group === "string");
}

/** Fill a path template's `:name` segments from `params`, URI-encoding each
 *  value. Throws on a missing param — a build bug, never a user input. */
export function buildPath(template, params = {}) {
  return template.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new Error(`missing route param "${name}" for ${template}`);
    }
    return encodeURIComponent(String(value));
  });
}
