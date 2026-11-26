/**
 * The read model's vocabulary: how a field says how it is known, why part of a run
 * cannot be shown, and the five views a head renders.
 *
 * Field names are chosen so the dispatch-site masker, which redacts by key name, never
 * hides one by accident: no name ends in `key`, `token`, `secret` or `password`, and
 * none is `auth`, `headers` or `env`. A test walks every view over the fixtures.
 *
 * Every table here, and every table a fold reads with a recorded value, is an own-key
 * lookup: a recorded name never resolves to a property of a built-in object.
 */
import type { InspectGapReason as InspectGapReasonOf } from "@crewhaus/control-contract";

/** Why part of a run cannot be shown. Closed: the control contract's list. */
export { INSPECT_GAP_REASONS } from "@crewhaus/control-contract";

export type InspectGapReason = InspectGapReasonOf;

/**
 * The reasons a later reader produces, never these folds: stream resets come with the
 * run stream, and viewer rights with the serving layer.
 */
export const GAPS_PRODUCED_ELSEWHERE: readonly InspectGapReason[] = Object.freeze([
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
  "execution-scan",
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
  /** `session` is absent while the run's rows name none (queued, or failed before one). */
  | { readonly kind: "run"; readonly run: string; readonly session?: string }
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
  return ownValue(STATUS_WORDS, state) ?? UNKNOWN_STATUS_WORD;
}

/** `table[key]` when `key` is the table's own, else `undefined`: never an inherited name. */
export function ownValue<T>(
  table: Readonly<Record<string, T>>,
  key: string | undefined,
): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
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
  /**
   * Why it is unknown: a model with no price, a call that reports tokens and costs
   * nothing, or a cost line that records no amount.
   */
  readonly unknown?: "unpriced" | "zero-cost-with-tokens" | "not-recorded";
  /** "$0.04", "Cost unknown — a model has no price", "Cost not tracked". */
  readonly words: string;
};

export const COST_UNKNOWN_WORDS = "Cost unknown — a model has no price";
export const COST_NOT_RECORDED_WORDS = "Cost unknown";
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
  /** Where the link is recorded: the child's stamp, the parent's helper start, or the child's run row. */
  readonly via: "stamp" | "helper" | "row";
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
  /** What the execution's trace events held for this run, when an execution is named. */
  readonly trace?: {
    readonly present: boolean;
    readonly events: number;
    readonly truncated: boolean;
  };
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

/**
 * One line of a timeline. `title` is a fixed template; `detail` holds content, whole:
 * mask it before cutting it short.
 */
export type TimelineEntry = {
  /**
   * `s:<byte offset>` for a session-log line, `d:<segment>:<offset>` for a decision-log
   * line, `x:<byte offset>` for an execution's trace event.
   */
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
  /** How the entry was attributed to the run, when that was pieced together. */
  readonly rule?: ReconstructionRule;
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
    /**
     * The input the call ran, whole and as recorded (an object stays an object, so a
     * key-name masker still sees its keys). Content: mask it before cutting it short.
     */
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
 * newline and tab, DEL, C1 controls, and the format characters (`\p{Cf}`: bidirectional
 * overrides, zero-width marks). Print every string through it.
 */
export function terminalSafe(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it removes
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|\p{Cf}/gu, "");
}

/**
 * Free text for a fixed line: every control, format and line or paragraph separator
 * (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`) becomes a space, and runs of white space collapse to one.
 * The control protocol's rule for operator text.
 */
export function flatText(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** How {@link beforeMask} recognises a secret's key, and what replaces its value. */
export type BeforeMaskOptions = {
  readonly isSecretName: (name: string) => boolean;
  readonly redacted: string;
};

/** A JSON text a string holds is walked only this deep. */
const JSON_TEXT_DEPTH = 64;

// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it removes
const UNSEEN_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|\p{Cf}/gu;

function looksLikeJsonText(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

/** Replace each value under a secret's name inside parsed JSON; `changed` says whether one was. */
function redactParsed(
  value: unknown,
  options: BeforeMaskOptions,
  depth: number,
): { readonly value: unknown; readonly changed: boolean } {
  if (depth > JSON_TEXT_DEPTH) return { value, changed: false };
  if (typeof value === "string") {
    // A JSON text's own strings are rejoined too: an escaped control splits a value the
    // same way a raw one does.
    const inner = jsonTextRedacted(value.replace(UNSEEN_RE, ""), options, depth + 1);
    return { value: inner, changed: inner !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = redactParsed(item, options, depth + 1);
      changed ||= r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [raw, item] of Object.entries(value)) {
      const key = raw.replace(UNSEEN_RE, "");
      changed ||= key !== raw;
      if (options.isSecretName(key) && item !== null && item !== undefined) {
        out[key] = options.redacted;
        changed = true;
      } else {
        const r = redactParsed(item, options, depth + 1);
        changed ||= r.changed;
        out[key] = r.value;
      }
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/** A string that holds a JSON object or array, its secrets' values replaced; else itself. */
function jsonTextRedacted(s: string, options: BeforeMaskOptions, depth: number): string {
  if (!looksLikeJsonText(s)) return s;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return s;
  }
  if (typeof parsed !== "object" || parsed === null) return s;
  const r = redactParsed(parsed, options, depth);
  return r.changed ? JSON.stringify(r.value) : s;
}

/**
 * Get a view ready for a masker that redacts by key name and by token shape. In every
 * string, keys included, the controls (other than newline and tab) and the format
 * characters are removed first, so a value split by one is whole again when the masker
 * sees it; then a string that holds a JSON object or array has each value under a
 * secret's name replaced with `redacted`, and is written back as JSON, so a credential
 * inside a recorded tool result is redacted by its name like any other field. It masks
 * nothing else: the head's own masker runs after it, and only then is anything cut short.
 */
export function beforeMask(view: unknown, options: BeforeMaskOptions): unknown {
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      return jsonTextRedacted(value.replace(UNSEEN_RE, ""), options, 0);
    }
    if (depth > JSON_TEXT_DEPTH * 4) return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key.replace(UNSEEN_RE, "")] = walk(item, depth + 1);
      }
      return out;
    }
    return value;
  };
  return walk(view, 0);
}
