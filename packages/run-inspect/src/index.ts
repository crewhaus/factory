/**
 * `@crewhaus/run-inspect`: explain a run from its records.
 *
 * Pure folds over a run's session log, its run-ledger rows and its session root's
 * decision log, into five views: {@link foldSummary}, {@link foldTimeline},
 * {@link foldSpanTree}, {@link foldWhy} and {@link foldContext}. Every field says how
 * it is known (recorded, pieced together by a named rule, or not recorded and why), and
 * what is missing is named, never dropped. {@link loadRun} is the only part that reads
 * files: bounded, contained to the harness's session root, and read-only.
 *
 * It never calls a model, never spawns, and never masks: a head masks at its exit, after
 * {@link beforeMask} gets a view ready for it, and prints through {@link terminalSafe}.
 * {@link foldInspectModel} is the content-free read model a server keeps of the run
 * ledger, so a read need not scan it.
 */
export {
  DEFAULT_MAX_BYTES,
  type DecisionEntry,
  LEDGER_SCAN_MAX_ROWS,
  type LoadedRun,
  type LoadRunInput,
  type RunMode,
  type RunRow,
  loadRun,
  loadedRunFromText,
} from "./load";
export {
  type ExecutionRead,
  TRACE_ENTRY_KINDS,
  executionEntries,
  executionGaps,
  readExecution,
} from "./exec";
export {
  INSPECT_MODEL_MAX,
  type InspectModel,
  type InspectRunSkeleton,
  childrenFromModel,
  emptyInspectModel,
  foldInspectModel,
  rowsFromModel,
  runsOfWork,
} from "./projection";
export {
  type ReadObserver,
  type SessionLine,
  WAKE_LOOK_BEHIND_BYTES,
} from "./lines";
export {
  type ApprovalLater,
  type BeforeMaskOptions,
  COST_NOT_RECORDED_WORDS,
  COST_NOT_TRACKED_WORDS,
  COST_UNKNOWN_WORDS,
  type CheckView,
  type ContextList,
  type ContextUsed,
  type CostView,
  type EntryGroup,
  type EntryImportance,
  GAP_WORDS,
  GAPS_PRODUCED_ELSEWHERE,
  HIDDEN_FOR_SAFETY,
  INSPECT_GAP_REASONS,
  type InspectGap,
  type InspectGapReason,
  type InspectRefusal,
  type InspectSubject,
  type InspectSummary,
  ONLY_INSTRUCTIONS,
  type Provenance,
  type ProvenanceState,
  RECONSTRUCTION_RULES,
  type ReconstructionRule,
  type RecalledItemView,
  type RelatedRun,
  type RevisionsView,
  type RouteView,
  STATUS_WORDS,
  type SessionRunView,
  type SpanNode,
  type SpanTree,
  type StatusView,
  type TimelineEntry,
  type TimelinePage,
  type TriggerView,
  UNKNOWN_STATUS_WORD,
  WAKE_NOT_RECORDED,
  type WakeView,
  WHY_NOTE,
  type WhyAction,
  type WhyRecord,
  beforeMask,
  flatText,
  ownValue,
  statusWord,
  terminalSafe,
} from "./model";
export {
  DETAIL_OUTCOMES,
  ENTRY_KINDS,
  type EntryKind,
  LINE_KINDS,
  importanceOf,
  lineKindOf,
} from "./taxonomy";
export { runLinesOf } from "./records";
export { foldSummary } from "./fold-summary";
export {
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT,
  type TimelineOptions,
  foldTimeline,
  timelineAll,
} from "./fold-timeline";
export { foldSpanTree } from "./fold-spans";
export { WHY_ACTION_RE, foldWhy } from "./fold-why";
export { foldContext } from "./fold-context";
