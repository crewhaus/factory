/**
 * `@crewhaus/harness-supervisor` — the process layer.
 *
 * Everything about running a harness as a supervised process lives here and
 * nowhere else: the per-shape spawn contracts, the harness-local runfiles
 * and run ledger, pid-reuse-safe liveness and adoption, durable log capture
 * with the TraceEvent pump and the credential scrubber, exit classification
 * and the restart policy, the port ledger, the preflight gate, and the
 * mutating-job queue.
 *
 * It is a LIBRARY: no CLI, no HTTP, no process-global state. The manager
 * server and the `crewhaus daemon` verbs drive it, and every side-effecting
 * dependency (process ops, clock, plan builder, gate, scrubber, id minter)
 * is injected so the whole machine can be tested without spawning a
 * harness.
 */

export type {
  Clock,
  DaemonRunfile,
  EnvOverride,
  RetentionPolicy,
  RunClass,
  RunKind,
  RunLedgerEntry,
  RunLedgerPatch,
  StartLock,
  SupervisionState,
} from "./types";
export {
  CONTROL_TOKEN_NAME,
  DEFAULT_RETENTION,
  LOGS_DIR_NAME,
  RUN_DIR_SEGMENTS,
  RUN_LEDGER_NAME,
  RUNFILE_NAME,
  RUNFILE_VERSION,
  START_LOCK_NAME,
  START_TIME_TOLERANCE_MS,
  systemClock,
} from "./types";

export type {
  CommandRunner,
  PosixProcessOpsOptions,
  ProcessOps,
  SpawnRequest,
  SpawnStdio,
  SpawnedProcess,
  WindowsProcessOpsOptions,
} from "./process-ops";
export {
  argvFingerprint,
  argvMatchesCommandLine,
  createPosixProcessOps,
  createProcessOps,
  createWindowsProcessOps,
  parseProcBtime,
  parseProcCmdline,
  parseProcStartTime,
  parsePsLstart,
  parseWindowsStartTime,
  startTimesMatch,
} from "./process-ops";

export type { PruneResult } from "./runfiles";
export {
  acquireStartLock,
  appendRunLedger,
  clearRunfile,
  controlTokenPath,
  ensureRunDir,
  logsDir,
  newRunId,
  patchRunLedger,
  pruneRuns,
  readRetentionPolicy,
  readRunLedger,
  readRunfile,
  readStartLock,
  recentRuns,
  releaseStartLock,
  RUN_ID_RE,
  runCursorPath,
  runDir,
  runEventsPath,
  runfileExists,
  runfilePath,
  runLogPath,
  START_LOCK_MAX_AGE_MS,
  startLockIsStale,
  startLockPath,
  writeRunfile,
} from "./runfiles";

export type { AdoptOptions, AdoptionResult, LivenessFailure, LivenessVerdict } from "./adoption";
export { adoptRunning, verifyRunfile } from "./adoption";

export type { EnvScrubberOptions, Scrubber } from "./scrub";
export {
  composeScrubbers,
  createEnvScrubber,
  MIN_SCRUBBED_VALUE_LENGTH,
  NON_SECRET_ENV_KEYS,
  noopScrubber,
  scrubDeep,
} from "./scrub";

export type {
  Drained,
  LogPump,
  LogPumpOptions,
  LogTailOptions,
  PumpCursor,
  PumpResult,
} from "./trace-pump";
export {
  completeUtf8Length,
  CONTROL_ANNOUNCE_RE,
  createLogPump,
  DEFAULT_MAX_CHUNK_BYTES,
  drain,
  LOG_TAIL_LINES,
  LOG_TAIL_MAX_CHARS,
  looksLikeEvent,
  parseAnnouncedControlPort,
  readCursor,
  readLogTail,
  readLogTailLines,
  replayRunEvents,
  RUNIDLESS_EVENT_KINDS,
  scanBalanced,
  tailLines,
  writeCursor,
} from "./trace-pump";

export type {
  BinResolverDeps,
  BundleLocation,
  EnvChain,
  EnvFileRef,
  EnvMode,
  LoadEnvChainOptions,
  RunOptions,
  SpawnEnv,
  SpawnEnvInput,
  SpawnPlan,
  SpawnPlanInput,
} from "./spawn-contracts";
export type {
  ManagerHook,
  ManagerHookName,
  ManagerHooks,
  ManagerSettings,
} from "./manager-settings";
export {
  DEFAULT_HOOK_TIMEOUT_MS,
  MANAGER_HOOK_NAMES,
  MANAGER_SETTINGS_SEGMENTS,
  parseManagerHook,
  readManagerBlock,
  readManagerSettings,
} from "./manager-settings";

export type { BundleFreshness } from "./bundle-freshness";
export {
  BUNDLE_MANIFEST_NAME,
  BUNDLE_STAMP_KEY,
  bundleFreshness,
  hashSpecSource,
  readBundleStamp,
} from "./bundle-freshness";

export type {
  CommandOutcome,
  CompileForecast,
  HookRunLog,
  HookRunRecord,
  PrepareDeps,
  PrepareOutcome,
  PrepareRefusal,
  PrepareRunner,
  PrepareRunnerOptions,
  PrepareStage,
  RunCommandInput,
  CompileMode,
} from "./prepare";
export {
  bundleStaleness,
  compileActiveRevision,
  compileIfStale,
  SAVED_NOT_ACTIVE_NOTE,
  compileOutDir,
  createPrepareRunner,
  forecastCompile,
  formatPrepareRefusal,
  HOOK_OUTPUT_LINES,
  hookLogPath,
  readHookRunLog,
  recordHookRun,
  resolveHookCommand,
  runManagerHook,
  runPrepareCommand,
} from "./prepare";
export {
  BRIEF_TARGETS,
  BUN_DOTENV_FILES,
  BUNDLE_DIR_CANDIDATES,
  dotenvAssignedNames,
  isLoaderEnvKey,
  loaderKeysInEnvFiles,
  LOADER_ENV_KEYS,
  LOADER_ENV_PREFIXES,
  rootBundleCompiled,
  buildSpawnEnv,
  buildSpawnPlan,
  cliTwin,
  DAEMON_ENTRY_TARGETS,
  ENV_FILENAMES,
  envFilenamesFor,
  envModeOf,
  entryFileFor,
  findHarnessRoot,
  findSpecPath,
  homeCrewhausArgv,
  isInside,
  isSupervisedClass,
  loadEnvChain,
  OVERRIDE_ENV_KEYS,
  parseEnvText,
  unquoteEnvValue,
  readsBriefOnStdin,
  resolveBundle,
  resolveCrewhausBin,
  runClassFor,
  runKindFor,
  runOptionFlags,
  SESSION_ID_RE,
  shellQuote,
  SPEC_FILENAMES,
  SpawnPlanError,
} from "./spawn-contracts";

export type { AllocateRequest, PortClaim, PortLedger, PortProbe, PortRole } from "./ports";
export {
  createPortLedger,
  DEFAULT_PORT_SPAN,
  defaultPortProbe,
  PortCollisionError,
  runfilePortClaims,
} from "./ports";

export type {
  ClassifyExitInput,
  ExitClassification,
  ExitDisposition,
  RestartWindow,
  RestartWindowStore,
} from "./policy";
export {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffDelayMs,
  classifyExit,
  createRestartWindow,
  MAX_RESTARTS_PER_WINDOW,
  PARKED_EXIT_CODE,
  RESTART_WINDOW_MS,
  STOP_GRACE_MS,
  TERMINAL_EXIT_CODES,
} from "./policy";

export type { GateDecision, GateOptions, RunGateOptions } from "./gate";
export {
  evaluateGate,
  formatGateRefusal,
  harnessHookDisclosures,
  isUnforceable,
  runPreflightGate,
  UNFORCEABLE_AREAS,
} from "./gate";

export type {
  CancellableChild,
  HarnessMutex,
  JobQueue,
  JobQueueOptions,
  JobRecord,
  JobRunContext,
  JobRunner,
  JobState,
  JobStore,
  SubmitInput,
} from "./queue";
export {
  createFileJobStore,
  createHarnessMutex,
  createJobQueue,
  createMemoryJobStore,
  DEFAULT_JOB_CONCURRENCY,
  DEFAULT_JOB_SHUTDOWN_DEADLINE_MS,
  DEFAULT_JOB_STOP_GRACE_MS,
  isReadOnlyJob,
  processOpsChild,
  READ_ONLY_JOB_KINDS,
} from "./queue";

export type {
  ChildFate,
  ShutdownJobs,
  ShutdownOptions,
  ShutdownReport,
  ShutdownSupervisor,
  StoppedChild,
  SupervisedChild,
} from "./shutdown";
export {
  runManagerShutdown,
  SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_GRACE_MS,
  shutdownFate,
  shutdownReportLines,
} from "./shutdown";

export type {
  HarnessSupervisor,
  RunForensics,
  StartResult,
  StopResult,
  SupervisorEvent,
  SupervisorOptions,
  SupervisorSnapshot,
} from "./supervisor";
export type { AdmitAnswer } from "./supervisor";
export {
  createHarnessSupervisor,
  DEFAULT_PUMP_INTERVAL_MS,
  DEPLOYMENT_ID_ENV,
  SPEC_HASH_ENV,
} from "./supervisor";

export type { ActiveBuildCheck, ActiveDeployment } from "./active-build";
export {
  activeDeployment,
  artifactOf,
  BUILD_NOT_ACTIVE_MESSAGE,
  buildLinkMessage,
  buildLinkRefusal,
  launchedEntryOf,
  NO_ACTIVE_BUILD_ACTIVATE_MESSAGE,
  NO_ACTIVE_BUILD_MESSAGE,
  resolvedEntryOf,
  SPEC_NOT_ACTIVE_MESSAGE,
  verifyActiveBuild,
} from "./active-build";
export type { StartDecisionInput, StartRefusal } from "./start-decision";
export { automaticSpecRefusal, decideStart } from "./start-decision";
export type { BuildArtifact } from "./build-inputs";
export {
  bootInputsOf,
  buildDigest,
  bundleDirOf,
  collectBuildFiles,
  linkEntriesOf,
  parseJsonc,
  RESOLVER_FILES,
} from "./build-inputs";

// The manager-side helpers `@crewhaus/hangar-server` used to own, moved down
// so that `crewhaus daemon` and the other heads reach them without depending
// on the HTTP server (hangar-server re-exports them for one release). Run
// detail and the job vocabulary are the `./run-detail` and `./job-kinds`
// subpaths.
export type { HarnessEnvFiles } from "./env-file";
export { mergedSpawnEnv, readHarnessEnvFiles } from "./env-file";
export type { EnvWriteResult } from "./env-writer";
export {
  ENV_ASSIGN_RE,
  ENV_KEY_RE,
  ENV_STUB_RE,
  EnvWriteError,
  unsetEnvVar,
  upsertEnvVar,
} from "./env-writer";
export { harnessScrubber, spawnEnvScrubber } from "./harness-scrub";
export { isSafePathSegment, resolveContained, resolveInside } from "./containment";
