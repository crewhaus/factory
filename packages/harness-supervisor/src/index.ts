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
  recentRuns,
  RUN_ID_RE,
  runCursorPath,
  runDir,
  runEventsPath,
  runLogPath,
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

export type { Drained, LogPump, LogPumpOptions, PumpCursor, PumpResult } from "./trace-pump";
export {
  completeUtf8Length,
  createLogPump,
  DEFAULT_MAX_CHUNK_BYTES,
  drain,
  LOG_TAIL_LINES,
  LOG_TAIL_MAX_CHARS,
  looksLikeEvent,
  readCursor,
  readLogTail,
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
  RunOptions,
  SpawnEnv,
  SpawnEnvInput,
  SpawnPlan,
  SpawnPlanInput,
} from "./spawn-contracts";
export {
  BUNDLE_DIR_CANDIDATES,
  buildSpawnEnv,
  buildSpawnPlan,
  cliTwin,
  DAEMON_ENTRY_TARGETS,
  ENV_FILENAMES,
  entryFileFor,
  findHarnessRoot,
  findSpecPath,
  isInside,
  isSupervisedClass,
  loadEnvChain,
  OVERRIDE_ENV_KEYS,
  parseEnvText,
  resolveBundle,
  resolveCrewhausBin,
  runClassFor,
  runKindFor,
  runOptionFlags,
  SESSION_ID_RE,
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
  isUnforceable,
  runPreflightGate,
  UNFORCEABLE_AREAS,
} from "./gate";

export type {
  HarnessMutex,
  JobQueue,
  JobQueueOptions,
  JobRecord,
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
  isReadOnlyJob,
  READ_ONLY_JOB_KINDS,
} from "./queue";

export type {
  HarnessSupervisor,
  RunForensics,
  StartResult,
  StopResult,
  SupervisorEvent,
  SupervisorOptions,
  SupervisorSnapshot,
} from "./supervisor";
export { createHarnessSupervisor, DEFAULT_PUMP_INTERVAL_MS } from "./supervisor";
