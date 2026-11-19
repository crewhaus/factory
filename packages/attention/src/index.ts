/**
 * `@crewhaus/attention`: one inbox for every decision and problem across harnesses (#517,
 * #513, module brief 331). Read-only adapters over the records other parts of the system
 * keep (tool approvals and questions, `dec_` decisions, the review queue, the Advisor's
 * findings and run outcomes), derived `att_` ids, evidence revisions, cause keys and
 * cross-harness groups, the read model Home's projector keeps, a direct fold for when
 * there is none, search documents and metrics.
 *
 * Nothing here writes, creates or compacts a file, makes a model call or opens a socket.
 */
export {
  advisorKindOf,
  advisorTitleOf,
} from "./adapters/advisor";
export {
  ADVISOR_FINDINGS_MAX,
  ADVISOR_SNAPSHOT_MAX_BYTES,
  ADVISOR_SNAPSHOT_NAME,
  advisorSnapshotRecord,
  advisorSnapshotRel,
  findingOf,
  parseAdvisorSnapshot,
  readAdvisorSnapshot,
  withAdvisorSnapshots,
} from "./advisor-snapshot";
export {
  APPROVAL_TTL_MS,
  approvalItemRef,
  approvalKeyOf,
  approvalKindOf,
} from "./adapters/approvals";
export { decisionKindOf } from "./adapters/decisions";
export { REVIEW_QUEUE_REL } from "./adapters/review";
export { FAILURES_MAX, PROVIDER_LIMIT_WINDOW_MS, newestEpisode } from "./adapters/runs";
export {
  type Cause,
  type CauseFacts,
  type CredentialFacts,
  causeOf,
  credentialFactsOf,
} from "./causes";
export {
  type FoldHarnessOptions,
  type HarnessReadOptions,
  type Inbox,
  type InboxFilter,
  assembleInbox,
  emptyModel,
  foldHarness,
  foldModel,
  foldModelLine,
  harnessAttention,
  modelSources,
  overviewOf,
  refreshModel,
} from "./fold";
export { type HarnessGroups, groupAcross } from "./groups";
export {
  KEY_SHAPE_RE,
  type RevisionPart,
  attIdOf,
  attRefOf,
  digestPrefix,
  evidenceRevOf,
  sha256Hex,
} from "./ids";
export { showTwin } from "./items";
export {
  type AttentionStateInput,
  type EffectiveAttention,
  PROBLEM_WINDOW_MS,
  effectiveAttentionState,
} from "./lifecycle";
export {
  LIST_VERB,
  type ListBodyOptions,
  UNREACHABLE_REMEDY,
  attentionListBody,
  emptyReasonOf,
  namesIn,
} from "./list-body";
export {
  type AttentionMetricsBody,
  REASK_WINDOW_MS,
  metricsOf,
  percentile,
  windowMs,
} from "./metrics";
export {
  type AttentionProducer,
  _resetProducersForTest,
  producers,
  registerProducer,
} from "./producers";
export {
  ATTENTION_PROJECTION_NAME,
  type AttentionProjection,
  attentionProjection,
} from "./projection";
export {
  type AttentionReader,
  DEFAULT_READER,
  READ_CAPS,
  type ReadCaps,
  SESSION_CAPS,
} from "./read";
export { type AttentionSearchDocument, searchDocumentsOf } from "./search";
export { ATTENTION_SENTENCES, UNKNOWN_SENTENCE, classWordOf, sentenceOf } from "./sentences";
export type {
  AdvisorFinding,
  AdvisorSnapshot,
  ApprovalFact,
  AttentionModel,
  DecisionFact,
  Drafted,
  FailureSignature,
  GroupDraft,
  GroupRun,
  HarnessAttention,
  HarnessFacts,
  ItemContext,
  MetricDecision,
  ReviewFact,
  RunFact,
} from "./types";
