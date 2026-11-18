/**
 * The read model's vocabulary: how a field says how it is known, why part of a run
 * cannot be shown, and the five views a head renders.
 *
 * Field names are chosen so the dispatch-site masker, which redacts by key name, never
 * hides one by accident: no name ends in `key`, `token`, `secret` or `password`, and
 * none is `auth`, `headers` or `env`. A test walks every view over the fixtures.
 */

/** Why part of a run cannot be shown. Closed. */
export const INSPECT_GAP_REASONS = Object.freeze([
  "before-0.9",
  "records-off",
  "advisor-off",
  "cost-off",
  "not-supervised",
  "pruned",
  "evicted",
  "truncated",
  "torn",
  "unfinished",
  "diverged",
  "no-access",
  "unsupported",
  "not-recorded",
] as const);

export type InspectGapReason = (typeof INSPECT_GAP_REASONS)[number];

/**
 * The reasons a later reader produces, never these folds: prune markers and stream
 * resets come with the supervisor's records, and viewer rights with the serving layer.
 */
export const GAPS_PRODUCED_ELSEWHERE: readonly InspectGapReason[] = Object.freeze([
  "pruned",
  "diverged",
  "no-access",
]);

/**
 * A part of a run that cannot be shown, and why. `from` and `to` are entry ids;
 * `remedy` names the verb or the setting that records more.
 */
export type InspectGap = {
  readonly reason: InspectGapReason;
  readonly from?: string;
  readonly to?: string;
  readonly count?: number;
  readonly remedy?: string;
};

/** Each gap reason in words, for a head that prints one line per gap. */
export const GAP_WORDS: Readonly<Record<InspectGapReason, string>> = Object.freeze({
  "before-0.9": "Recorded before CrewHaus 0.9.0: no context or decision records.",
  "records-off": "Detailed records are turned off for this harness.",
  "advisor-off": "Advisor events were turned off for this run.",
  "cost-off": "Cost was not tracked for this run.",
  "not-supervised":
    "Detailed trace not captured: this run wasn't started by Home or `crewhaus daemon`. The transcript has the essentials.",
  pruned: "Removed by log cleanup.",
  evicted: "This run's transcript was removed. Only a summary is left.",
  truncated: "Only part of this record was read: a size limit was reached.",
  torn: "A line in the log is damaged and was skipped.",
  unfinished: "Missing: the process stopped before this step finished.",
  diverged: "The record changed while it was read.",
  "no-access": "You can see that this happened, but not what it contained.",
  unsupported: "This isn't available here.",
  "not-recorded": "Not recorded.",
});

/** How a reconstructed value was pieced together. Closed. */
export const RECONSTRUCTION_RULES = Object.freeze([
  "legacy-turn-by-user-message",
  "synthetic-marker-by-position",
  "status-from-session-log",
  "records-off-by-run-row",
  "span-by-position",
  "zero-cost-with-tokens",
] as const);

export type ReconstructionRule = (typeof RECONSTRUCTION_RULES)[number];

/**
 * How a field is known. `recorded`: a record says so. `reconstructed`: pieced together
 * by `rule`. `not-recorded`: nothing says, and `gap` says why. `generated` is reserved
 * for a model-written answer, which these folds never produce.
 */
export type ProvenanceState = "recorded" | "reconstructed" | "generated" | "not-recorded";

export type Provenance<T> = {
  readonly state: ProvenanceState;
  readonly value?: T;
  /** The entries the value comes from. */
  readonly refs: readonly string[];
  readonly rule?: ReconstructionRule;
  readonly gap?: InspectGap;
};

export function recorded<T>(value: T, refs: readonly string[]): Provenance<T> {
  return { state: "recorded", value, refs };
}

export function reconstructed<T>(
  value: T,
  rule: ReconstructionRule,
  refs: readonly string[],
): Provenance<T> {
  return { state: "reconstructed", value, refs, rule };
}

export function notRecorded<T>(gap?: InspectGap, refs: readonly string[] = []): Provenance<T> {
  return { state: "not-recorded", refs, ...(gap !== undefined ? { gap } : {}) };
}

/** Why a read was refused, as the control contract's error codes name it. */
export type InspectRefusal = {
  readonly ok: false;
  readonly code: "invalid" | "not_found" | "unsupported";
  readonly message: string;
  /** The verb that helps. */
  readonly verb?: string;
};

export function refusal(
  code: InspectRefusal["code"],
  message: string,
  verb?: string,
): InspectRefusal {
  return { ok: false, code, message, ...(verb !== undefined ? { verb } : {}) };
}

/** What is inspected: one run, or a session whose runs cannot be told apart. */
export type InspectSubject =
  | { readonly kind: "run"; readonly run: string; readonly session: string }
  | { readonly kind: "legacy"; readonly session: string };

/** A run's status in words: always a word, never a colour alone. */
export type StatusView = {
  readonly state: string;
  readonly word: string;
  readonly failureClass?: string;
  readonly continuedIn?: string;
};

/** One word per run state. */
export const STATUS_WORDS: Readonly<Record<string, string>> = Object.freeze({
  queued: "Queued",
  preparing: "Starting",
  running: "Working",
  "waiting-for-approval": "Waiting for approval",
  "waiting-for-input": "Waiting for you",
  paused: "Paused",
  interrupted: "Interrupted",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
});

export const UNKNOWN_STATUS_WORD = "Status unknown";

export function statusWord(state: string | undefined): string {
  return (state !== undefined ? STATUS_WORDS[state] : undefined) ?? UNKNOWN_STATUS_WORD;
}

/** What started a run. */
export type TriggerView = {
  readonly kind: string;
  /** A fixed phrase for the kind. */
  readonly words: string;
  readonly lane?: string;
  readonly via?: string;
  readonly platform?: string;
  /** An operator's wake started it: see the summary's `wake`. */
  readonly synthetic: boolean;
};

/** An operator's wake: the reason and author the session log's marker records. */
export type WakeView = {
  readonly reason: string;
  readonly by?: string;
  /** "operator wake: <reason> (by <by>)", or "operator wake (reason not recorded)". */
  readonly words: string;
};

export const WAKE_NOT_RECORDED = "operator wake (reason not recorded)";

/**
 * A run's cost. `usdMicros` is null when it is unknown: a model with no price, or a
 * call that reports tokens and costs nothing. Never 0 for either.
 */
export type CostView = {
  readonly usdMicros: number | null;
  /** The cost lines summed. */
  readonly lines: number;
  readonly unknown?: "unpriced" | "zero-cost-with-tokens";
  /** "$0.04", "Cost unknown — a model has no price", "Cost not tracked". */
  readonly words: string;
};

export const COST_UNKNOWN_WORDS = "Cost unknown — a model has no price";
export const COST_NOT_TRACKED_WORDS = "Cost not tracked";

/** What a run ran under. */
export type RevisionsView = {
  /** The spec revision, or "not recorded". */
  readonly spec: string;
  readonly specFrom?: string;
  readonly runtime?: string;
  readonly deployment?: string;
  readonly settings?: { readonly fingerprint: string; readonly rules: number };
  readonly poolPolicy?: string;
};

/** A run the inspected run started, or that this session also holds. */
export type RelatedRun = {
  readonly run: string;
  readonly session?: string;
  /** Where the link is recorded: the child's stamp, or the parent's helper start. */
  readonly via: "stamp" | "helper";
  readonly name?: string;
};

/** One run of an inspected session. */
export type SessionRunView = {
  readonly run: string;
  readonly trigger?: string;
  readonly parent?: string;
  readonly chosen: boolean;
};

export type InspectSummary = {
  readonly subject: InspectSubject;
  /** A fixed phrase from the trigger. */
  readonly title: string;
  readonly status: Provenance<StatusView>;
  readonly trigger: Provenance<TriggerView>;
  /** Only for a run an operator's wake started. */
  readonly wake?: Provenance<WakeView>;
  /** The run's first message that a person or a caller sent. Content. */
  readonly asked: Provenance<string>;
  /** A fixed template over counts and verdicts, never model-written. */
  readonly happened: Provenance<string>;
  /** The run's last answer text. Content. */
  readonly outcome: Provenance<string>;
  readonly cost: Provenance<CostView>;
  readonly durationMs: Provenance<number>;
  readonly startedAt?: string;
  readonly revisions: Provenance<RevisionsView>;
  readonly parent?: string;
  readonly continues?: string;
  readonly children: readonly RelatedRun[];
  /** The supervised execution whose trace events hold more. */
  readonly execution: Provenance<{ readonly id: string }>;
  /** The session's runs, when the subject was named by its session. */
  readonly runs?: readonly SessionRunView[];
  readonly gaps: readonly InspectGap[];
  readonly gapCounts: Readonly<Partial<Record<InspectGapReason, number>>>;
};

export type EntryImportance = "key" | "detail";

export type EntryGroup =
  | "run"
  | "messages"
  | "tools"
  | "checks"
  | "models"
  | "context"
  | "cost"
  | "gaps"
  | "other";

/** One line of a timeline. `title` is a fixed template; `detail` holds content. */
export type TimelineEntry = {
  /** `s:<byte offset>` for a session-log line, `d:<segment>:<offset>` for a decision-log line. */
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly group: EntryGroup;
  readonly importance: EntryImportance;
  readonly span?: string;
  /** The span this entry nests under. */
  readonly parent?: string;
  readonly title: string;
  readonly detail?: string;
  readonly refs: readonly string[];
  readonly sensitivity: "internal" | "restricted";
  /** The session turn, for messages, answers and tool calls. */
  readonly turn?: Provenance<number>;
};

export type TimelinePage = {
  /** Newest first. */
  readonly entries: readonly TimelineEntry[];
  readonly gaps: readonly InspectGap[];
  /** Pass as `before` for the page after this one. */
  readonly next?: string;
  /** Where the session log was read up to. */
  readonly snapshotAt: string;
  /** A size limit cut what was read. */
  readonly truncated: boolean;
  /** Why the page is empty: `filtered` when the key view hides everything recorded. */
  readonly empty?: "filtered" | "no-data";
  readonly view: "key" | "full";
};

export type SpanNode = {
  readonly id: string;
  readonly kind: string;
  readonly status?: string;
  readonly startedAt?: string;
  readonly durationMs: Provenance<number>;
  readonly cost?: CostView;
  readonly toolUseId?: string;
  readonly call?: number;
  readonly turn?: { readonly run: number; readonly session: number };
  readonly attempt?: { readonly index: number; readonly cause?: string };
  /** Lines name this span, and no line closes it. */
  readonly unfinished?: true;
  /** Its parent is not one of the run's spans: it sits under the run. */
  readonly orphan?: true;
  readonly children: readonly SpanNode[];
};

export type SpanTree = {
  readonly root?: SpanNode;
  /** Lines that name no span: they sit under the run by position. */
  readonly byPosition: Provenance<number>;
  readonly gaps: readonly InspectGap[];
};

/** A later outcome of an approval, from the decision log. */
export type ApprovalLater = {
  readonly id: string;
  readonly outcome: "granted" | "denied" | "expired" | "superseded";
  readonly at: string;
  /** The stored actor: a member id or a keyed digest of the local user. */
  readonly by?: string;
  readonly surface?: string;
  readonly reason?: string;
};

export type CheckView = {
  readonly id: string;
  readonly gate: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly rules?: readonly string[];
  readonly mode?: string;
  readonly score?: { readonly value: number; readonly threshold?: number };
  readonly judgeModel?: string;
  readonly approval?: string;
  /** What became of the approval later: shown after the session log's outcome. */
  readonly later: readonly ApprovalLater[];
  readonly bundleHash?: string;
  readonly auditKind?: string;
};

export type WhyAction = "tool" | "answer" | "model" | "turn";

export type RouteView = {
  readonly model?: string;
  readonly policy?: string;
  readonly reason?: string;
  readonly band?: string;
  readonly tier?: string;
};

export type WhyRecord = {
  readonly action: string;
  readonly kind: WhyAction;
  readonly span: string;
  readonly started: Provenance<{
    readonly trigger: TriggerView;
    readonly wake?: WakeView;
    readonly asked?: string;
  }>;
  readonly used: Provenance<{
    readonly call: number;
    readonly blocks: readonly string[];
    readonly recalled: number;
    readonly hidden: number;
    readonly files: number;
    readonly link: string;
  }>;
  readonly rules: Provenance<RevisionsView & { readonly mode?: string }>;
  readonly did: Provenance<{
    readonly what: string;
    readonly tool?: string;
    /** The input the call ran: the object, or its JSON cut short when it is long. Content. */
    readonly input?: unknown;
    /** The text the model wrote before the call or answer. Content. */
    readonly reasonGiven?: string;
    readonly note: string;
  }>;
  readonly options: Provenance<{
    readonly models: readonly RouteView[];
    readonly toolChoice: Provenance<never>;
  }>;
  readonly checks: Provenance<readonly CheckView[]>;
  readonly result: Provenance<{
    readonly text?: string;
    readonly isError?: boolean;
    readonly corrections: readonly {
      readonly id: string;
      readonly at: string;
      readonly rating?: string;
      readonly comment?: string;
      readonly correction?: string;
    }[];
  }>;
  readonly gaps: readonly InspectGap[];
};

export const WHY_NOTE = "This shows the record, not the model's private reasoning.";

export type RecalledItemView = {
  readonly ref: {
    readonly store: string;
    readonly backend: string;
    readonly localId: string;
    readonly version?: number;
  } | null;
  readonly status: string;
  readonly score?: number;
  readonly rules?: readonly string[];
  /** "Hidden for safety" for an item the model never saw. */
  readonly label?: string;
};

export const HIDDEN_FOR_SAFETY = "Hidden for safety";
export const ONLY_INSTRUCTIONS = "This model call had only its instructions.";

export type ContextUsed = {
  readonly call: number;
  readonly span: string;
  readonly id: string;
  readonly turn?: { readonly run: number; readonly session: number };
  readonly attempt?: { readonly index: number; readonly cause?: string };
  readonly model: {
    readonly wire: string;
    readonly spec?: string;
    readonly provider: string;
    readonly profile?: string;
    readonly params: Readonly<Record<string, number | string>>;
  };
  readonly blocks: readonly {
    readonly kind: string;
    readonly bytes: number;
    readonly cached: boolean;
  }[];
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
  readonly recalled: Provenance<{
    readonly at: string;
    readonly requested: number;
    readonly returned: number;
    readonly items: readonly RecalledItemView[];
  } | null>;
  readonly tools: Provenance<{
    readonly advertised: number;
    readonly inSpec: number;
    readonly names?: readonly string[];
  }>;
  readonly messages: { readonly count: number; readonly afterCompaction: boolean };
  /** True when the call was given only its instructions. */
  readonly onlyInstructions: boolean;
  /** Whether what it used has changed since: no lookup answers it here. */
  readonly changedSince: Provenance<never>;
};

/** The context views of a run's model calls. */
export type ContextList = {
  readonly calls: readonly ContextUsed[];
  readonly gaps: readonly InspectGap[];
};

/**
 * `s` with the characters that drive a terminal removed: C0 controls other than
 * newline and tab, DEL, and C1 controls. Print every string through it.
 */
export function terminalSafe(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it removes
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}
