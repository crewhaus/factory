/**
 * Which timeline entries are key events and which are detail: one table, the only
 * copy. Key: the run's start and end, messages and answers, each tool call with its
 * result, every check that did not simply allow or pass, approvals decided, consumed,
 * expired or superseded, errors and failures, model failovers, helper runs, compaction
 * and evictions, and gaps. Detail: allowed and passed checks, routing, model calls,
 * context, cost lines, stats, plan, goal and wiki writes, judge and proof records, and
 * the toolset.
 */
import type { EntryGroup, EntryImportance } from "./model";

export type EntryKindRow = {
  readonly group: EntryGroup;
  /** `by-outcome`: key unless the check allowed or passed. */
  readonly importance: EntryImportance | "by-outcome";
};

export const ENTRY_KINDS = Object.freeze({
  "run-start": { group: "run", importance: "key" },
  "run-end": { group: "run", importance: "key" },
  message: { group: "messages", importance: "key" },
  "operator-wake": { group: "messages", importance: "key" },
  answer: { group: "messages", importance: "key" },
  tool: { group: "tools", importance: "key" },
  check: { group: "checks", importance: "by-outcome" },
  "approval-outcome": { group: "checks", importance: "key" },
  error: { group: "run", importance: "key" },
  "run-failed": { group: "run", importance: "key" },
  failover: { group: "models", importance: "key" },
  helper: { group: "tools", importance: "key" },
  compaction: { group: "context", importance: "key" },
  eviction: { group: "context", importance: "key" },
  feedback: { group: "messages", importance: "key" },
  gap: { group: "gaps", importance: "key" },
  note: { group: "messages", importance: "detail" },
  turn: { group: "run", importance: "detail" },
  "model-call": { group: "models", importance: "detail" },
  route: { group: "models", importance: "detail" },
  context: { group: "context", importance: "detail" },
  cost: { group: "cost", importance: "detail" },
  stats: { group: "other", importance: "detail" },
  "plan-write": { group: "other", importance: "detail" },
  judge: { group: "checks", importance: "detail" },
  proof: { group: "checks", importance: "detail" },
  toolset: { group: "tools", importance: "detail" },
  crew: { group: "other", importance: "detail" },
  other: { group: "other", importance: "detail" },
} as const satisfies Readonly<Record<string, EntryKindRow>>);

export type EntryKind = keyof typeof ENTRY_KINDS;

/** The check outcomes that are detail: everything else a check says is a key event. */
export const DETAIL_OUTCOMES: ReadonlySet<string> = new Set(["allow", "pass"]);

/** The kind's row, read as the table's own: a name the table does not hold is `other`. */
function rowOf(kind: string): EntryKindRow {
  return Object.hasOwn(ENTRY_KINDS, kind)
    ? ((ENTRY_KINDS as Readonly<Record<string, EntryKindRow>>)[kind] as EntryKindRow)
    : ENTRY_KINDS.other;
}

export function importanceOf(kind: EntryKind, outcome?: string): EntryImportance {
  const row = rowOf(kind);
  if (row.importance !== "by-outcome") return row.importance;
  return outcome !== undefined && DETAIL_OUTCOMES.has(outcome) ? "detail" : "key";
}

export function groupOf(kind: EntryKind): EntryGroup {
  return rowOf(kind).group;
}

/** The entry kind of a session-log line kind; `undefined` for a line merged into another. */
export const LINE_KINDS: Readonly<Record<string, EntryKind | undefined>> = Object.freeze({
  run_stamp: "run-start",
  user_message: "message",
  assistant_message: "answer",
  tool_use: "tool",
  tool_result: undefined,
  verdict: "check",
  error: "error",
  run_failed: "run-failed",
  model_failover: "failover",
  sub_agent_start: "helper",
  sub_agent_end: undefined,
  compaction: "compaction",
  context_evicted: "eviction",
  user_feedback: "feedback",
  span_closed: undefined,
  model_route: "route",
  model_tier_route: "route",
  model_stage: "route",
  model_directive: "route",
  context_manifest: "context",
  cost_accrual: "cost",
  tool_stats: "stats",
  mcp_stats: "stats",
  model_meta: "stats",
  recovery: "stats",
  permission: "stats",
  plan_update: "plan-write",
  goal_update: "plan-write",
  wiki_write: "plan-write",
  action_proof: "plan-write",
  judge_verdict: "judge",
  provability_graded: "proof",
  proof_checked: "proof",
  toolset: "toolset",
  role_start: "crew",
  role_end: "crew",
  handoff: "crew",
  a2a_message: "crew",
  a2a_turn_start: "crew",
  a2a_turn_end: "crew",
  crew_done: "crew",
  dream_run: "other",
});

/**
 * What a session-log line kind becomes: its entry kind; `merged` for a line another entry
 * carries; `unknown` for a kind the table does not hold. Read as the table's own, so a
 * recorded kind never resolves to a property of a built-in object.
 */
export function lineKindOf(kind: string): EntryKind | "merged" | "unknown" {
  if (!Object.hasOwn(LINE_KINDS, kind)) return "unknown";
  return LINE_KINDS[kind] ?? "merged";
}
