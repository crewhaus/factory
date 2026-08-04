/**
 * `@crewhaus/hangar-server` — the Hangar manager's local HTTP server. A
 * library: `startHangarServer(opts)` boots one loopback `Bun.serve`; the CLI
 * verb wires ports, assets, and lifecycle around it.
 *
 * M1 was read-only over harness state (registry CRUD was the only write).
 * M2 makes it a DRIVER — process start/stop/restart/drain, a live SSE run
 * feed, `crewhaus.control.v1` wake/drain/status, the approvals and review
 * inboxes, an activity digest, and a job queue — always by composing an
 * existing layer (`@crewhaus/harness-supervisor`, `@crewhaus/session-store`,
 * `@crewhaus/feedback-distill`, `@crewhaus/eval-report`) rather than
 * re-implementing it.
 *
 * Safety model (enforced, tested):
 *   - bearer-token auth on every `/api` route (constant-time compare;
 *     `/healthz` and the static shell excepted; no cookies ⇒ no CSRF);
 *   - path safety: id-shape validation + realpath containment inside the
 *     registered harness dir on every filesystem read;
 *   - reads never mutate: session browsing is raw dir scans + tolerant
 *     capped JSONL parsing — never `SessionStore.list()` (TTL eviction) and
 *     never `PendingApprovalStore.list()` (compaction);
 *   - credentials never render: env routes emit KEY presence booleans,
 *     spec/transcript/preflight bodies pass the spec-patch maskers, the
 *     control.v1 bearer is read server-side and never returned, and captured
 *     daemon output is served only through the supervisor's scrubbed paths;
 *   - torn-line tolerance + caps on every JSONL reader;
 *   - digest-keyed rollup caching under `<hangarRoot>/cache/` —
 *     rebuildable, never authoritative, safe to delete wholesale.
 */
export {
  DEFAULT_HANGAR_PORT,
  HANGAR_SERVER_VERSION,
  MAX_JSONL_BYTES,
  MAX_JSONL_LINES,
  MAX_MEMORY_ITEMS,
  MAX_RAW_LINES,
  MAX_TAIL_LINES,
  MAX_TEXT_BYTES,
  PROTOCOL_V,
  RUN_ID_RE,
  SAFE_SEGMENT_RE,
  SESSION_DIR_ENV,
  SESSION_ID_RE,
  SSE_IDLE_TIMEOUT_SECONDS,
} from "./constants";
export { ensureToken, isAuthorized, TOKEN_FILENAME, tokenEquals, type TokenSetup } from "./auth";
export { mergedSpawnEnv, parseEnvText, readHarnessEnvFiles } from "./env-file";
export { readJsonlCapped, readTextCapped, type JsonlRead } from "./jsonl";
export { maskDeep, maskSpecYaml } from "./mask";
export { isSafePathSegment, resolveContained, resolveInside } from "./safety";
export {
  GUTTER_KINDS,
  isSessionId,
  listSessions,
  readTranscript,
  readTranscriptRaw,
  resolveSessionRoot,
  type EvictedSessionRow,
  type SessionListing,
  type SessionRootInfo,
  type SessionRow,
  type TranscriptGutterItem,
  type TranscriptToolCall,
  type TranscriptTurn,
  type TranscriptView,
} from "./sessions";
export { foldHarnessCosts, type HarnessCosts, type ModelCostRow } from "./costs";
export {
  computeRollup,
  computeRollupDigest,
  openRollupCache,
  type HarnessRollup,
  type RollupCache,
} from "./rollups";
export {
  evalHealth,
  evalRunView,
  evalSampleView,
  evalsView,
  isRunId,
  type EvalRunView,
  type EvalSampleView,
  type EvalsView,
} from "./evals";
export {
  dreamView,
  factsView,
  foldFactsFile,
  isMemoryArea,
  MEMORY_AREAS,
  stateView,
  watchmeView,
  wikiArticle,
  wikiView,
  type DreamView,
  type FactItem,
  type FactsFile,
  type MemoryArea,
  type StateView,
  type WatchmeView,
  type WikiArticleView,
  type WikiListView,
} from "./memory";
export {
  BADGE_KEYS,
  capabilityBadges,
  collectEnvRefs,
  specView,
  type BadgeKey,
  type SpecView,
} from "./spec-view";
export {
  startHangarServer,
  type HangarServer,
  type HangarServerOptions,
  type StaticAsset,
} from "./server";
export {
  createProcessLayer,
  isJobKind,
  jobArgv,
  JOB_KINDS,
  JobArgumentError,
  type HarnessProcess,
  type JobKind,
  type JobOptions,
  type ProcessLayer,
  type ProcessLayerOptions,
} from "./process";
export {
  CONTROL_LANES,
  CONTROL_LISTENING_RE,
  createControlClient,
  isControlLane,
  knownControlPort,
  parseControlPort,
  type ControlClient,
  type ControlClientOptions,
  type ControlLane,
  type ControlRefusal,
  type ControlRefusalCode,
  type ControlResult,
  type ControlStatusBody,
  type ControlTarget,
} from "./control-client";
export {
  harnessScrubber,
  isLiveFeedState,
  isSupervisorRunId,
  runDetail,
  runEventStream,
  runLogFile,
  runsView,
  spawnEnvScrubber,
  LIVE_FEED_STATES,
  SSE_EVENTS,
  SSE_HEARTBEAT_MS,
  type RunDetail,
  type RunsView,
} from "./runs";
export {
  buildSchedulersView,
  declaredCadences,
  dreamStates,
  readSpecYaml,
  SCHEDULER_LANES,
  type SchedulerLane,
  type SchedulerRow,
  type SchedulersView,
} from "./schedulers";
export {
  approvalsInbox,
  foldApprovals,
  isApprovalId,
  pendingApprovalCount,
  resolveApproval,
  type ApprovalRow,
  type ApprovalsView,
} from "./approvals";
export {
  adjudicateReview,
  isReviewVerdict,
  reviewInbox,
  REVIEW_VERDICTS,
  type ReviewRow,
  type ReviewVerdict,
  type ReviewView,
} from "./review";
export {
  activityDigest,
  harnessActivity,
  parseSince,
  ACTIVITY_KINDS,
  DEFAULT_ACTIVITY_WINDOW_MS,
  type ActivityDigest,
  type ActivityItem,
  type ActivityKind,
} from "./activity";
export { deploymentsView, type DeploymentsView } from "./deployments";
export {
  bundleFreshness,
  hashSpecSource,
  BUNDLE_MANIFEST_NAME,
  BUNDLE_STAMP_KEY,
  type BundleFreshness,
} from "./bundle-freshness";
export {
  currentBaselines,
  pinBaseline,
  pinSession,
  readPins,
  type PinBaselineResult,
  type PinSessionResult,
} from "./actions";
export {
  feedbackRecord,
  logLine,
  makeFixtureHarness,
  type FixtureHarnessOptions,
  type FixtureSession,
} from "./fixture";
