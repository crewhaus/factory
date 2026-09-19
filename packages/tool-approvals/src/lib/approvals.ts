/**
 * What is parked waiting for a human — the fold, the status rule, the filters
 * and the row projection.
 *
 * A harness running under `permissions.ask_mode: pause` cannot prompt: there is
 * nobody at a terminal. Instead it writes a `PendingApproval` record to
 * `<session root>/approvals.jsonl` and stops. Someone then has to notice. These
 * are the reads that let them notice without a model turn.
 *
 * ---------------------------------------------------------------------------
 * THE RECORD SHAPE IS SOMEONE ELSE'S
 * ---------------------------------------------------------------------------
 * `@crewhaus/session-store` owns `PendingApproval`, and `@crewhaus/hangar-server`
 * owns the fleet fold over it. Neither is a dependency of this package (see the
 * README — the fold is ~40 lines and the alternative was pulling a server and a
 * store into a tool package), so the shape is re-declared here STRUCTURALLY:
 * only the fields these tools actually project, all of them optional except the
 * seven the store's own `isPendingApprovalShape` requires. A record carrying
 * fields we do not know about passes through untouched, so a store that grows a
 * field does not make this reader reject its records.
 *
 * ---------------------------------------------------------------------------
 * STRICTLY READ-ONLY, INCLUDING ABOUT TIME
 * ---------------------------------------------------------------------------
 * A pending record past its TTL is still reported as PENDING here. Expiry is
 * the runtime's decision, made when it re-reads the store to resume a parked
 * run; a reader that "helpfully" reported an old park as expired would be
 * answering a question it has no authority over, and an operator who skipped it
 * on that advice would leave a run blocked that a grant would have resumed.
 */
import { OPERATIVE_ARG_FIELDS } from "@crewhaus/tool-permission-matcher";
import { type JsonlRead, readJsonlCapped } from "./jsonl";
import { compareStrings } from "./unknown";

/** The approvals log's filename, beside the session files. */
export const APPROVALS_FILENAME = "approvals.jsonl";
/** Where a harness keeps its session state, by convention. */
export const SESSIONS_SUBDIR = ".crewhaus/sessions";
/** The id grammar `PendingApprovalStore.resolve` enforces. */
export const APPROVAL_ID_RE = /^appr_[0-9a-f]{16}$/;

export function isApprovalId(id: string): boolean {
  return APPROVAL_ID_RE.test(id);
}

/** The structural subset of `@crewhaus/session-store`'s `PendingApproval` these
 *  tools read. Unknown fields are preserved on the object but never projected. */
export type ApprovalRecord = {
  readonly id: string;
  readonly toolName: string;
  readonly inputHash: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly surface: string;
  readonly createdAt: string;
  readonly input?: unknown;
  readonly decision?: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly consumedAt?: string;
  readonly always?: boolean;
};

export type ApprovalStatusName = "pending" | "granted" | "granted-always" | "denied" | "consumed";

/** Every status, in the order an operator cares about them. */
export const APPROVAL_STATUSES: readonly ApprovalStatusName[] = Object.freeze([
  "pending",
  "granted",
  "granted-always",
  "denied",
  "consumed",
]);

/** Mirrors `@crewhaus/session-store`'s own `isPendingApprovalShape`: seven
 *  required strings, nothing else. A line that is not this is not a record. */
export function isApprovalShape(value: unknown): value is ApprovalRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["toolName"] === "string" &&
    typeof v["inputHash"] === "string" &&
    typeof v["runId"] === "string" &&
    typeof v["sessionId"] === "string" &&
    typeof v["surface"] === "string" &&
    typeof v["createdAt"] === "string"
  );
}

/**
 * The status rule, as the CLI and the hangar both derive it.
 *
 * `granted-always` wins over `consumed` because a standing allow is terminal
 * whether or not the parked call was since spent — the `alwaysAllow` rule it
 * wrote into `settings.json` carries the behaviour from then on, and an
 * operator auditing "what did we hand out permanently" must see it.
 */
export function statusOf(a: ApprovalRecord): ApprovalStatusName {
  if (a.decision === "grant" && a.always === true) return "granted-always";
  if (a.consumedAt !== undefined) return "consumed";
  if (a.decision === "grant") return "granted";
  if (a.decision === "deny") return "denied";
  return "pending";
}

export type FoldResult = {
  readonly records: readonly ApprovalRecord[];
  /** Lines that parsed as JSON but were not approval records. */
  readonly foreignLines: number;
  readonly read: JsonlRead;
};

/**
 * Fold one approvals log: last record wins by `id`, which is the upsert rule
 * `PendingApprovalStore.persist` documents (a grant is recorded by appending
 * the record again with `decision` set). Never compacts, never evicts.
 *
 * Output order is FILE order of each id's LAST record — deterministic for a
 * given file, and re-sorted by every caller before it is shown.
 */
export function foldApprovals(path: string, maxLines?: number, maxBytes?: number): FoldResult {
  const read = readJsonlCapped(path, maxLines, maxBytes);
  const byId = new Map<string, ApprovalRecord>();
  let foreignLines = 0;
  for (const obj of read.objects) {
    if (isApprovalShape(obj)) byId.set(obj.id, obj);
    else foreignLines += 1;
  }
  return { records: [...byId.values()], foreignLines, read };
}

/**
 * The ISO-8601 shapes this package will place in time: a calendar date, with an
 * optional time and an optional `Z`/`±HH:MM` offset. Anything else is refused
 * rather than guessed at.
 */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * An ISO instant as a NUMBER, or `null` when the text is not one.
 *
 * Every time comparison in this package goes through here first and then
 * compares the parsed numbers — never the original strings. Two records written
 * by hosts in different zones carry `2026-09-19T00:30:00+02:00` and
 * `2026-09-18T23:00:00Z`; the first is EARLIER, and a lexical string compare
 * says it is later. Sorting an inbox by string would put the wrong park at the
 * top, and a `since` window would include the wrong side of its boundary.
 *
 * The shape is gated before `Date.parse` because `Date.parse`'s acceptance of
 * non-ISO input is implementation-defined — V8 reads `"September 19, 2026"` and
 * another engine need not. A tool whose filtering depended on that would answer
 * differently on a different runtime.
 */
export function parseInstant(text: string): number | null {
  if (!ISO_INSTANT_RE.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

export type ApprovalFilters = {
  readonly status?: ReadonlyArray<ApprovalStatusName>;
  /** EXACT tool name. Not a glob — a filter that quietly globbed would make
   *  "show me every `Read` park" also show `ReadSecrets`. */
  readonly tool?: string;
  /** Lower bound on `createdAt`, inclusive, as a parsed instant. */
  readonly sinceMs?: number;
  /** Upper bound on `createdAt`, inclusive, as a parsed instant. */
  readonly untilMs?: number;
};

export type FilterOutcome = {
  readonly kept: readonly ApprovalRecord[];
  /**
   * Ids whose `createdAt` did not parse while a time filter was active. They
   * are KEPT (a record that cannot be placed in time is not thereby outside the
   * window) and named, so the caller can say the window is approximate rather
   * than pretend it was applied.
   */
  readonly undatedIds: readonly string[];
};

/**
 * Apply the filters the store's own `ApprovalListFilter` does not support.
 *
 * This runs BEFORE any limit. Pushing a limit into the read and filtering
 * afterwards is the bug the survey flagged: ask for 20 `Bash` parks in a log
 * whose newest 20 records are `Read` parks and you get zero, with nothing to
 * say that more exist.
 */
export function filterApprovals(
  records: readonly ApprovalRecord[],
  filters: ApprovalFilters,
): FilterOutcome {
  const wanted = filters.status === undefined ? null : new Set(filters.status);
  const timeFiltered = filters.sinceMs !== undefined || filters.untilMs !== undefined;
  const kept: ApprovalRecord[] = [];
  const undatedIds: string[] = [];
  for (const record of records) {
    if (wanted !== null && !wanted.has(statusOf(record))) continue;
    if (filters.tool !== undefined && record.toolName !== filters.tool) continue;
    if (timeFiltered) {
      const at = parseInstant(record.createdAt);
      if (at === null) {
        undatedIds.push(record.id);
        kept.push(record);
        continue;
      }
      if (filters.sinceMs !== undefined && at < filters.sinceMs) continue;
      if (filters.untilMs !== undefined && at > filters.untilMs) continue;
    }
    kept.push(record);
  }
  return { kept, undatedIds: undatedIds.sort(compareStrings) };
}

export type ApprovalOrder = "operator" | "oldest" | "newest";

/**
 * Pin the order, because "the natural fold order" is file order and that is not
 * what anybody wants to read.
 *
 * `operator` (the default) is the inbox order: everything PENDING first, oldest
 * first inside it — the park that has been blocking a run longest is the one to
 * settle — then everything settled, most recently decided first. `oldest` and
 * `newest` are plain `createdAt` orders for a caller that wants a ledger.
 *
 * Ties break on `id`, so two records written in the same millisecond always
 * come out in the same order. A record whose timestamps do not parse sorts to
 * the END of its group rather than to an arbitrary place: an unplaceable record
 * must not displace one whose position is known.
 */
export function orderApprovals(
  records: readonly ApprovalRecord[],
  order: ApprovalOrder,
): ApprovalRecord[] {
  const createdMs = (r: ApprovalRecord): number | null => parseInstant(r.createdAt);
  const decidedMs = (r: ApprovalRecord): number | null =>
    r.decidedAt === undefined ? null : parseInstant(r.decidedAt);
  const byTime = (a: number | null, b: number | null, dir: 1 | -1): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1; // unplaceable sorts last, whichever direction
    if (b === null) return -1;
    return (a - b) * dir;
  };
  const out = [...records];
  out.sort((x, y) => {
    if (order === "operator") {
      const xp = statusOf(x) === "pending";
      const yp = statusOf(y) === "pending";
      if (xp !== yp) return xp ? -1 : 1;
      if (xp) return byTime(createdMs(x), createdMs(y), 1) || compareStrings(x.id, y.id);
      // Settled: most recently DECIDED first, falling back to creation for a
      // record whose decidedAt the writer omitted.
      return (
        byTime(decidedMs(x) ?? createdMs(x), decidedMs(y) ?? createdMs(y), -1) ||
        compareStrings(x.id, y.id)
      );
    }
    const dir = order === "oldest" ? 1 : -1;
    return byTime(createdMs(x), createdMs(y), dir) || compareStrings(x.id, y.id);
  });
  return out;
}

/** How much of one operative value a row carries. Past this an approver should
 *  read the record itself; a 200 KB `Bash` command is not an inbox row. */
export const MAX_VALUE_CHARS = 2000;

export type InputField = {
  readonly key: string;
  readonly type: string;
  /** Characters, for a string value. Absent for anything else. */
  readonly chars?: number;
};

export type ApprovalRow = {
  readonly id: string;
  readonly toolName: string;
  readonly status: ApprovalStatusName;
  readonly surface: string;
  readonly createdAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly always?: true;
  readonly runId: string;
  readonly sessionId: string;
  readonly inputHash: string;
  /**
   * The input field a permission rule would constrain for this tool, per
   * `@crewhaus/tool-permission-matcher`'s `OPERATIVE_ARG_FIELDS` — the one an
   * approver is actually judging. `null` for a tool with no entry in that table
   * (every MCP tool, and any custom tool), where there is no field the matcher
   * would check either.
   */
  readonly operativeField: string | null;
  readonly operativeValue: string | null;
  readonly operativeValueTruncated?: true;
  /** Every other input key by NAME and TYPE, never by value — see the README's
   *  note on why this package does not render inputs verbatim. */
  readonly inputFields: readonly InputField[];
  /** Seconds this record has been parked, when the caller supplied `now`. */
  readonly ageSeconds?: number;
};

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * The operative field and value for a tool, using the matcher's OWN table.
 *
 * Reading the same table the matcher reads is the point: a row that showed some
 * other field would be showing an approver a value that no rule they write
 * about it will ever be checked against.
 */
export function operativeOf(
  toolName: string,
  input: unknown,
): { readonly field: string | null; readonly value: string | null } {
  const fields = OPERATIVE_ARG_FIELDS[toolName];
  if (fields === undefined || input === null || typeof input !== "object") {
    return { field: null, value: null };
  }
  const record = input as Record<string, unknown>;
  for (const f of fields) {
    const v = record[f];
    if (typeof v === "string" && v.length > 0) return { field: f, value: v };
  }
  return { field: null, value: null };
}

/** Project one record into a row. `nowMs` omitted ⇒ no age field at all, rather
 *  than an age measured against a clock the caller never named. */
export function toRow(record: ApprovalRecord, nowMs?: number): ApprovalRow {
  const { field, value } = operativeOf(record.toolName, record.input);
  const truncated = value !== null && value.length > MAX_VALUE_CHARS;
  const inputFields: InputField[] =
    record.input !== null && typeof record.input === "object" && !Array.isArray(record.input)
      ? Object.entries(record.input as Record<string, unknown>)
          .map(([key, v]) => ({
            key,
            type: typeName(v),
            ...(typeof v === "string" ? { chars: v.length } : {}),
          }))
          .sort((a, b) => compareStrings(a.key, b.key))
      : [];
  const createdMs = parseInstant(record.createdAt);
  return {
    id: record.id,
    toolName: record.toolName,
    status: statusOf(record),
    surface: record.surface,
    createdAt: record.createdAt,
    decidedBy: record.decidedBy ?? null,
    decidedAt: record.decidedAt ?? null,
    ...(record.always === true ? { always: true as const } : {}),
    runId: record.runId,
    sessionId: record.sessionId,
    inputHash: record.inputHash,
    operativeField: field,
    operativeValue: truncated ? (value as string).slice(0, MAX_VALUE_CHARS) : value,
    ...(truncated ? { operativeValueTruncated: true as const } : {}),
    inputFields,
    // No age when the instant is unparseable: a negative or absurd number
    // dressed as a duration is worse than an absent field.
    ...(nowMs !== undefined && createdMs !== null
      ? { ageSeconds: Math.round((nowMs - createdMs) / 1000) }
      : {}),
  };
}

/** Count records by status. Every status appears, so a caller reading
 *  `counts.pending` never has to tell `0` from `undefined`. */
export function countByStatus(
  records: readonly ApprovalRecord[],
): Record<ApprovalStatusName, number> {
  const counts = {
    pending: 0,
    granted: 0,
    "granted-always": 0,
    denied: 0,
    consumed: 0,
  } satisfies Record<ApprovalStatusName, number>;
  for (const r of records) counts[statusOf(r)] += 1;
  return counts;
}
