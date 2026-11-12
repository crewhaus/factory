/**
 * `@crewhaus/control-service`: the control plane's composition root (#507, #513, module
 * brief 325). Every change a person makes to a harness, from Home or the CLI, is a command
 * whose receipt is written before anything answers. It never enters a compiled harness and
 * never imports `@crewhaus/hangar-server`.
 */
export { currentLocalIdentity, storedActorFor } from "./actor";
export { AREA_RUNTIMES, activationGates, compositionProblems } from "./areas";
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
  type Executor,
  type ExecutorContext,
  type ExecutorStamp,
  type ReconcileContext,
  type Reconciler,
  type Reconciliation,
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
export { FINGERPRINT_LABEL, IDEMPOTENCY_TTL_MS, idempotencyClaim } from "./idempotency";
export type { JobAdapter } from "./jobs";
export {
  type LedgerChoice,
  WORKSPACE_DIGEST_KEY_FILE,
  commandsLedgerOf,
  workspaceCommandsLedger,
} from "./ledgers";
export { type RecoverCounts, type RecoverScope, isJobReceipt } from "./recover";
export {
  CANCELLED,
  type ControlRefusal,
  JOB_INTERRUPTED,
  NEEDS_DECISION,
  NOT_STARTED_REBOOT,
  OUTCOME_MESSAGES,
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
