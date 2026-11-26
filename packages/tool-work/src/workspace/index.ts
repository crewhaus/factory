/**
 * `@crewhaus/tool-work/workspace`: an accepted work item as one checked pull request from an
 * isolated checkout (module brief 333). The engine ({@link createWorkspaceEngine}), the
 * bindings the active build declares, the acceptance check, what may leave, the one pull
 * request tracker, and the views Home and the CLI read.
 */
export {
  ACCEPTANCE_DOES_NOT_MEET,
  ACCEPTANCE_MEETS,
  type AcceptanceAnswer,
  type AcceptanceInput,
  type AcceptanceJudge,
  type AcceptanceJudgeAnswer,
  JUDGE_DIFF_MAX,
  acceptanceCheck,
  changeText,
} from "./acceptance";
export {
  type AcceptanceJudgeConfig,
  type BindingsFile,
  type DeclaredIntent,
  type RepositoryBinding,
  WORKSPACES_DIR,
  WorkspaceConfigError,
  _resetWorkspaceBindings,
  acceptanceIntent,
  acceptanceJudgeConfig,
  activeBindings,
  assertHarnessCwd,
  bindWorkspaceRepositories,
  bindingDirOf,
  bindingsFileOf,
  parseWorkspaceConfig,
  readBindings,
  writeBindings,
} from "./bindings";
export {
  type CheckAnswer as CheckRunAnswer,
  type CheckInput,
  type CheckResult,
  type CheckRunner,
  type ChecksAnswer,
  NO_SANDBOX_REMEDY,
  checkImageFor,
  checkName,
  runDeclaredChecks,
  sandboxCheckRunner,
} from "./checks";
export {
  CODEHOST_EGRESS_POLICY,
  type EgressHit,
  credentialValues,
  scanLineage,
  scanSecrets,
  secretIn,
} from "./egress";
export {
  type CheckAnswer,
  type CheckAnswerView,
  type EngineActor,
  type EngineDeps,
  type LimitsPort,
  type OpenAnswer,
  type OverLimits,
  type PublishAnswer,
  type PublishInput,
  type WorkspaceEngine,
  WorkspaceError,
  type WorkspaceRefusal,
  createWorkspaceEngine,
} from "./engine";
export {
  type AddedLine,
  type DiffStat,
  type GitPort,
  SHA_RE,
  gitIsRecent,
  networkGitEnv,
  parseAddedLines,
  parseNumstat,
} from "./git";
export { ACCEPTANCE_RUBRIC, createAcceptanceJudge } from "./judge";
export {
  type ApplyAnswer,
  ENDED_WATCH_MS,
  type SyncAnswer,
  type SyncDeps,
  applyPullEvent,
  syncOutcomes,
} from "./outcomes";
export {
  OVER_LIMITS_TOOL,
  type OverLimitsApprovals,
  overLimitsInput,
  overLimitsPort,
  raiseOverLimits,
} from "./limits";
export { type PublishText, pullBody, pullTitle } from "./pr-body";
export { checksDirOf, worktreeNameOf } from "./records";
export { attemptView, workspaceSummaries, workspaceView } from "./view";
