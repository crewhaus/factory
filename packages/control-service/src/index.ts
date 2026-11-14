/**
 * `@crewhaus/control-service`: the control plane's composition root (#507, #513, module
 * brief 325). Every change a person makes to a harness, from Home or the CLI, is a command
 * whose receipt is written before anything answers. It never enters a compiled harness and
 * never imports `@crewhaus/hangar-server`.
 */
export { currentLocalIdentity, storedActorFor } from "./actor";
export {
  DECISION_EXECUTORS,
  DECISION_RECONCILERS,
  type Observed,
  observeDefer,
  observeResolve,
  observeRuleCreate,
  observeRuleRevoke,
  observeSupersede,
} from "./decision-runtime";
export {
  type DecisionActor,
  type DelegatedResolveAnswer,
  type DelegatedResolveRequest,
  type DecisionSupersedeAnswer,
  type Decisions,
  type DecisionsDeps,
  type DeferRequest,
  type DerivedRule,
  type HarnessFound,
  type ResolveAnswer,
  type ResolveHooks,
  type ResolveRequest,
  SECURITY_SETTINGS_PATHS,
  type SupersedeRequest,
  createDecisions,
  governedAncestorOf,
  harnessForSessionRoot,
  principalOfActor,
  settingsWriteClass,
} from "./decisions";
export {
  DEFAULT_RULE_DAYS,
  type LegacyAllow,
  type LegacyRevokeAnswer,
  type LegacyRevokeOutcome,
  type ListedProposal,
  type ListedRule,
  MAX_RULE_DAYS,
  type RevokeAnswer,
  type RuleListing,
  type RuleRevokeAnswer,
  type RuleWrite,
  type RuleWriteAnswer,
  type Rules,
  type StandingPattern,
  callValues,
  carriesCredential,
  createRules,
  createStandingRule,
  endExpiredRules,
  legacyBroadAllows,
  revokeLegacyAllow,
  revokeStandingRule,
  ruleDaysProblem,
  ruleEnd,
  ruleEndProblem,
  standingPatternFor,
  widenedPatternProblem,
} from "./rules";
export {
  NARROW_WORDS,
  type ToolApprovalDeps,
  type ToolApprovalRequest,
  resolveToolApproval,
} from "./approval-resolve";
export {
  AREA_RUNTIMES,
  activationGates,
  compositionProblems,
  delegatedActions,
  retireRevokers,
} from "./areas";
export { DELEGATION_RUNTIME } from "./areas/delegation";
export {
  type ActiveCeiling,
  APPLY_NOTE,
  type ApplySummary,
  type CeilingRead,
  DELEGATIONS_REVOKER,
  type DelegationDetailAnswer,
  type DelegationHarness,
  type DelegationListing,
  type DelegationRefusal,
  type DelegationWrite,
  type Delegations,
  type DelegationsDeps,
  NOTHING_DELEGABLE,
  NOT_ALLOWED,
  type PreviewAnswer,
  activeCeiling,
  ceilingDigestOf,
  ceilingOf,
  createDelegations,
  delegatedExecutor,
  delegatedRollbackExecutor,
  ownerHolds,
  ruleViewOf,
} from "./delegations";
export {
  type Commands,
  type InlineEffect,
  type SubmitAnswer,
  type SubmitRequest,
  receiptOf,
} from "./commands";
export type { ControlMode } from "./context";
export { CORE_RUNTIME, reconcileDaemonStart, settleStart, settleStop } from "./core-runtime";
export {
  type ActivationGate,
  type ActivationGateContext,
  type AreaRuntime,
  type DelegatedAction,
  type DelegatedActionContext,
  type DelegatedActionScope,
  type Executor,
  type ExecutorContext,
  type ExecutorStamp,
  type Gate,
  type GateContext,
  type ReconcileContext,
  type Reconciler,
  type Reconciliation,
  type RetireItem,
  type RetireRevoker,
  type RetireRevokerContext,
  type RunSweep,
  type RunSweepContext,
  type Settlement,
  executorDead,
  withOwnStartTime,
} from "./executor";
export {
  type ActivationAnswer,
  type ActivationRequest,
  type AdmitOptions,
  GATES_NOT_RUN,
  PROTECTED_ENVIRONMENT_GATE,
  type StartHead,
  activateDeployment,
  admitExplicitStart,
  deploymentIdOf,
  ensureHarnessIdentity,
  isServiceActor,
  protectedEnvironmentGate,
  reconcileActivation,
} from "./deployments";
export {
  FINGERPRINT_LABEL,
  IDEMPOTENCY_TTL_MS,
  expireIdempotencyClaims,
  idempotencyClaim,
} from "./idempotency";
export type { JobAdapter } from "./jobs";
export {
  type LedgerChoice,
  WORKSPACE_DIGEST_KEY_FILE,
  commandsLedgerOf,
  workspaceCommandsLedger,
} from "./ledgers";
export {
  OPERATOR_CONTROL_KINDS,
  OPERATOR_EXECUTORS,
  OPERATOR_RECONCILERS,
  type OperatorControlAnswer,
  type OperatorControlContext,
  type OperatorControlKind,
  type OperatorControlRequest,
  type OperatorDaemonAnswer,
  type OperatorReload,
  type OperatorReloadAnswer,
  type OperatorReloadTarget,
  applyOperatorControl,
  isOperatorControlKind,
  operatorControlLine,
  reconcileOperatorControl,
  recordDesired,
} from "./operator-controls";
export { type ObjectPage, type ObjectPageOptions, pageObjects } from "./pages";
export type { ReconcileCounts } from "./reconcile";
export { type RecoverCounts, type RecoverScope, isJobReceipt } from "./recover";
export {
  LIFECYCLE_FILE,
  type RetireRegistry,
  type RetireStepOutcome,
  type RetireSteps,
  type RetireStepsOptions,
  lifecycleLedger,
  reconcileRetire,
  retireSteps,
} from "./retire";
export {
  CANCELLED,
  type ControlRefusal,
  JOB_INTERRUPTED,
  NEEDS_DECISION,
  NOT_STARTED_REBOOT,
  OUTCOME_MESSAGES,
  RECONCILED_NOT_DONE,
  SUPERSEDED,
  type Outcome,
  type OutcomeCode,
  outcomeOf,
} from "./refusal";
export {
  type ControlDeps,
  type ControlService,
  type WireOptions,
  wireControl,
} from "./wire";
