/**
 * The shapes the attention fold works in: the facts port a caller lends it, the saved
 * read model (ids, kinds, counts, times and templates only, never a body), and the
 * per-harness answer every surface assembles into one inbox.
 */
import type {
  AttentionFreshness,
  AttentionItem,
  CauseKind,
  DecisionClass,
} from "@crewhaus/control-contract";
import type { AdvisorItem } from "@crewhaus/harness-advice/advisor";

/**
 * What a caller knows about a harness that its records do not say. Home and the CLI build
 * it with one helper over the harness's env chain, so this package never reads an env file
 * and never sees a value except as the `vars` it hands to the session-root resolver.
 */
export type HarnessFacts = {
  /** The env chain's folded names and values (the session root may be relocated there). */
  envVars(dir: string): Readonly<Record<string, string | undefined>>;
  /**
   * Where a name is set: the real path of the last chain file that assigns it, `process`
   * when the process environment supplies it (it wins over the chain), or `undefined`.
   */
  envNameSource(dir: string, name: string): { readonly file: string } | "process" | undefined;
  /** The Advisor's findings as Home last gathered them; absent before its first check. */
  advisorSnapshot?(dir: string): AdvisorSnapshot | undefined;
};

/** The Advisor's open items for one harness, as one sweep gathered them. */
export type AdvisorSnapshot = {
  /** When they were gathered. */
  readonly at: string;
  readonly items: readonly AdvisorItem[];
};

// ---------------------------------------------------------------------------
// The saved read model
// ---------------------------------------------------------------------------

/** One parked request, as the inbox needs it: no tool input. */
export type ApprovalFact = {
  readonly id: string;
  /** `tool` or `input`. */
  readonly kind: string;
  readonly toolName: string;
  readonly createdAt: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly askDigest?: string;
  readonly requiredClass?: DecisionClass;
  readonly expiresAt?: string;
  readonly deferredUntil?: string;
  readonly ifUnanswered?: string;
  readonly bindingDigest?: string;
  readonly decision?: "grant" | "deny";
  readonly decidedAt?: string;
  readonly decidedVia?: string;
  readonly resolvedBy?: string;
  readonly consumedAt?: string;
  readonly supersededBy?: string;
  readonly expiredAt?: string;
};

/** One `dec_` decision, its newest row. */
export type DecisionFact = {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly requiredClass?: DecisionClass;
  readonly decision?: "grant" | "deny";
  readonly decidedAt?: string;
  readonly decidedVia?: string;
  readonly resolvedBy?: string;
  readonly consumedAt?: string;
  readonly supersededAt?: string;
  readonly expiredAt?: string;
  readonly deferredUntil?: string;
  readonly ifUnanswered?: string;
  /** A standing-rule request: `allow` or `delegate`. */
  readonly ruleKind?: string;
  /** A delegation request's action. */
  readonly delegationAction?: string;
  /** A change adoption's change. */
  readonly chg?: string;
};

/** One review-queue entry, its newest line. */
export type ReviewFact = {
  readonly id: string;
  readonly reviewKind: string;
  readonly ts: string;
  readonly status: "open" | "resolved";
  readonly resolvedTs?: string;
};

/** One run, its newest row, with the session its first row named. */
export type RunFact = {
  readonly id: string;
  readonly state: string;
  readonly at: string;
  readonly failureClass?: string;
  readonly session?: string;
  readonly deployment?: string;
  readonly specHash?: string;
};

/** Which failure-message cluster a session's failure of one class fell in. */
export type FailureSignature = {
  readonly session: string;
  readonly failureClass: string;
  readonly signature: string;
};

/** A section re-read only when its file changed: `stamp` is what was seen last. */
export type Section<T> = {
  readonly stamp: string;
  readonly facts: readonly T[];
  readonly truncated?: true;
};

export type AttentionModel = {
  readonly v: 1;
  /** `dec_` decisions by id: their newest row. */
  decisions: Record<string, DecisionFact>;
  /** Runs by id, oldest-seen first, at most {@link RUNS_KEPT}. */
  runs: Record<string, RunFact>;
  runsTruncated?: true;
  approvals: Section<ApprovalFact> & {
    readonly unreachable?: true;
    /** The session root is not the harness's default one: no `--dir` command reaches it. */
    readonly relocated?: true;
  };
  review: Section<ReviewFact>;
  failures: Section<FailureSignature> & { readonly unreadable?: true };
};

/** At most this many runs are kept by a model; past it the oldest-seen go first. */
export const RUNS_KEPT = 2_000;

// ---------------------------------------------------------------------------
// One harness's answer
// ---------------------------------------------------------------------------

/** Where an item's runs came from, with their times, before groups are merged. */
export type GroupRun = { readonly id: string; readonly at: string; readonly harness: string };

/** Runs failing for one cause, before the groups of several harnesses are merged. */
export type GroupDraft = {
  readonly kind: "credential" | "provider-limit" | "budget" | "spec" | "run-failures";
  readonly cause: { readonly id: string; readonly kind: CauseKind; readonly label: string };
  /** Title params: names, classes and counts only. */
  readonly params: Readonly<Record<string, string | number>>;
  readonly titleTemplate: string;
  readonly runs: readonly GroupRun[];
  /** The newest success after these failures, when one cleared them. */
  readonly clearedAt?: string;
  /** An item this one replaced (a newer spec failing the same way). */
  readonly previousKey?: string;
  readonly superseded?: true;
  readonly note?: string;
};

/** An item with the time its newest evidence was seen, for ordering. */
export type Drafted = { readonly item: AttentionItem; readonly latestAt: number };

/** A decision as metrics count it. */
export type MetricDecision = {
  readonly kind: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
  readonly decidedVia?: string;
  readonly resolvedBy?: string;
  readonly askDigest?: string;
};

/** What one harness's records say needs a person. */
export type HarnessAttention = {
  readonly harness: string;
  readonly items: readonly Drafted[];
  readonly groups: readonly GroupDraft[];
  /** Its session root lies outside it: its approvals were not read. */
  readonly unreachable?: true;
  /** Some source stopped at its caps. */
  readonly truncated?: true;
  /** No Advisor findings have been gathered for it yet. */
  readonly advisorUnchecked?: true;
  readonly decisions: readonly MetricDecision[];
  readonly freshness: AttentionFreshness;
};

/** How one harness is read for a list. */
export type ItemContext = {
  readonly harness: string;
  readonly dir: string;
  readonly now: number;
  /** Bodies (tool input, review excerpts) only for a caller who may read the content. */
  readonly content: boolean;
  readonly freshness: AttentionFreshness;
};
