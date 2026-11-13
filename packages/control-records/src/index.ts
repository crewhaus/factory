/**
 * `@crewhaus/control-records`: the file layer under the shared control core (#507, #513).
 * Every primitive takes a containment root and record paths relative to it. Reads take no
 * lock and create nothing. It spawns no process and opens no socket, so a compiled daemon
 * can import it. Each export's docblock names its first consumer.
 */
export {
  type ControlPaths,
  type Ledger,
  type RecordSource,
  type RecordsAt,
  controlPaths,
  harnessLedger,
  runsLedger,
} from "./paths";
export {
  type AppendAnswer,
  type AppendClaimAnswer,
  type CasAnswer,
  type CasPrecondition,
  type ClaimContent,
  type ExpireAnswer,
  type FoldAnomaly,
  type FoldAnswer,
  type FoldGap,
  type FoldedObject,
  type LedgerRecord,
  type LockedAppend,
  type PublishAnswer,
  append,
  appendClaim,
  casAppend,
  casAppendLocked,
  foldStates,
  publishClaim,
  readClaim,
  withLedgerLock,
  expireClaim,
} from "./ledger";
export { type DropAnswer, dropSegmentsBefore } from "./retention";
export {
  type LedgerPage,
  type PageGap,
  type PageItem,
  type TailGap,
  type TailOptions,
  type TailRead,
  readPage,
  readTail,
} from "./tail";
export {
  type GapEdge,
  type ResumeAnswer,
  type ResumeCaps,
  type ResumeItem,
  type ResumeSources,
  resume,
  snapshotAt,
} from "./cursor";
export {
  type DigestKeyRead,
  ensureDigestKey,
  keyedDigest,
  readDigestKey,
  LOCAL_ACTOR_LABEL,
  RUN_SUBJECT_LABEL,
  storedLocalActor,
  subjectRefOf,
} from "./digest";
export {
  type OperatorDeployment,
  type OperatorIntake,
  type OperatorRead,
  type OperatorReader,
  type OperatorRecord,
  type OperatorVerdict,
  createOperatorReader,
  operatorVerdict,
  readOperatorRecord,
  refreshOperatorRecord,
} from "./operator";
export { type ApproverRead, createApproverReader, readApproverProjection } from "./approvers";
export { type IntakeReason, type IntakeVerdict, intakeVerdict } from "./intake";
export { intakeRoot, registerIntakeRoot, unregisterIntakeRoot } from "./intake-root";
export { type Heartbeat, type HeartbeatWrite, writeHeartbeat } from "./heartbeat";
export {
  type HeldLease,
  type LeaseHead,
  type LeaseHolder,
  type LeaseOptions,
  type LeaseProbe,
  type LeaseRead,
  type LeaseRecord,
  type LeaseRefused,
  type WithLeaseAnswer,
  acquireMutatingLease,
  readMutatingLease,
  withMutatingLease,
  defaultLeaseProbe,
  holderProvablyDead,
} from "./lease";
export { type RunnableMode, type RunnableVerdict, assertRunnable } from "./runnable";
export {
  type DeploymentsRead,
  type HarnessIdentity,
  type HarnessIdentityRead,
  type IdentityWrite,
  deploymentsLedger,
  readDeployments,
  readHarnessIdentity,
  writeHarnessIdentity,
} from "./deployments";
export {
  type ChangeAdoptionRow,
  type ChangeAdoptionSubjectRow,
  type LedgerRead,
  PROPOSAL_TTL_MS,
  type ProposalRow,
  type StandingRuleReason,
  type StandingRuleRow,
  changeAdoptionOf,
  changeAdoptionState,
  createStandingRuleReader,
  decisionsLedger,
  proposalOf,
  proposalState,
  readChangeAdoptions,
  readProposals,
  readStandingRules,
  ruleIsLive,
  standingRuleOf,
  standingRulesLedger,
} from "./standing-rules";
