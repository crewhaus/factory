/**
 * `@crewhaus/hangar-server` — the Hangar manager's local HTTP server
 * (M1: read-only over harness state; registry CRUD is the only write
 * surface). A library: `startHangarServer(opts)` boots one loopback
 * `Bun.serve`; the CLI verb wires ports, assets, and lifecycle around it.
 *
 * Safety model (enforced, tested):
 *   - bearer-token auth on every `/api` route (constant-time compare;
 *     `/healthz` and the static shell excepted; no cookies ⇒ no CSRF);
 *   - path safety: id-shape validation + realpath containment inside the
 *     registered harness dir on every filesystem read;
 *   - reads never mutate: session browsing is raw dir scans + tolerant
 *     capped JSONL parsing — never `SessionStore.list()` (TTL eviction);
 *   - credentials never render: env routes emit KEY presence booleans,
 *     spec/transcript/preflight bodies pass the spec-patch maskers;
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
  feedbackRecord,
  logLine,
  makeFixtureHarness,
  type FixtureHarnessOptions,
  type FixtureSession,
} from "./fixture";
