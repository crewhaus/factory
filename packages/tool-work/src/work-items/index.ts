/**
 * `@crewhaus/tool-work/work-items`: the work store and everything that reads it. A work
 * item (`wi_…`) is what a harness was asked to do: a content-free log line per event and an
 * immutable content revision per change, each text field recording the origin it came
 * through. One proposal object (`parseAssessment`, `checkProposal`), one ranker
 * (`rankWork`), one display state (`effectiveWorkState`), and the Work feed (`workFeed`).
 *
 * Node-only and light: it spawns nothing and opens no socket. Reads take no lock and write
 * nothing.
 */
export {
  ACCEPT_RULE,
  HARNESS_CLOSE_OUTCOMES,
  HARNESS_SOURCE_KINDS,
  WORK_ACTOR_RULES,
  type WorkMove,
  mayMove,
} from "./actors";
export {
  type AssessmentRefusal,
  checkProposal,
  demandEvidence,
  evidenceWords,
  hasObservedEvidence,
  isHypothesis,
  parseAssessment,
} from "./assessment";
export { type WorkConfig, WorkConfigError, parseWorkConfig } from "./config";
export {
  FEED_SECTION_MAX,
  type ThredzTasksAnswer,
  type ThredzTasksPort,
  TRIGGER_WORDS,
  type WorkFeedOptions,
  type WorkJob,
  workFeed,
} from "./feed";
export {
  type FoldedWorkItem,
  type WorkCorrection,
  type WorkFold,
  foldWork,
  foldWorkLines,
  readWorkLines,
} from "./fold";
export {
  DEFAULT_PRIORITY,
  type RankAnswer,
  type RankInput,
  type RankedItem,
  dimensionLevels,
  rankWork,
} from "./ranker";
export {
  REVISION_MAX_BYTES,
  SOURCE_EXCERPT_MAX,
  WORK_SOURCE_CLAIM_KIND,
  type WorkActor,
  type WorkActorRole,
  type WorkDelivery,
  type WorkLogLine,
  type WorkNote,
  type WorkRevision,
  type WorkSource,
  type WorkTextField,
  type WorkVia,
  itemDirOf,
  originOfRole,
  revisionRelOf,
  workDirOf,
  workLedger,
} from "./records";
export { type WorkSeed, continuityGoalSource, workSeed } from "./seed";
export { WORK_TOOL_KEYS, type WorkSpecFacts, workSpecFacts } from "./spec";
export { WORK_STATUS_WORDS, type WorkStateFacts, effectiveWorkState, statusOf } from "./state";
export {
  type AdoptRead,
  type AdoptedText,
  WORK_READ_CAP,
  type WorkAcceptPolicy,
  type WorkInput,
  type WorkItemRead,
  type WorkPatch,
  type WorkRefusal,
  type WorkRefusalCode,
  type WorkStore,
  type WorkStoreOptions,
  type WorkTransition,
  type WorkWrite,
  openWorkStore,
  workFieldsProblem,
} from "./store";
export {
  type WorkViewContext,
  contentOf,
  factsOf,
  harnessFacts,
  historyOf,
  itemDetail,
  itemView,
  itemViews,
  rankFolded,
  readRunStates,
  viewContext,
} from "./view";
