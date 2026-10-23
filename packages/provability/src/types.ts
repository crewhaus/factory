/**
 * The provability contract — every type the gate, the tools, the graders, the
 * CLI and every surface read. design/0.8.0-provability-release.md §2, §5.3.
 *
 * One bundle shape, every surface: the cli footer, the channel footer, the
 * gateway envelope, the research report section, the `provability_graded`
 * trace/event-log line (as a summary), the audit record and the JSON file
 * under `.crewhaus/proofs/` all render THIS type. Add fields additively.
 */
import type { IrProvability, IrProvabilityLevel } from "@crewhaus/ir";

/** The four rungs, lowest first. Order is load-bearing: see {@link levelRank}. */
export const PROVABILITY_LEVELS = ["cited", "grounded", "checked", "proven"] as const;
export type ProvabilityLevel = IrProvabilityLevel;
/** A rung, or `"none"` for evidence that meets no rung at all. */
export type Rung = ProvabilityLevel | "none";

/** The resolved gate configuration — exactly the lowered IR block. */
export type ProvabilityConfig = IrProvability;

/**
 * What a definition line binds a claim to (design §4.1):
 *   - `source`     — `[1]: https://…` / `./path` / `doi:…` / free text
 *   - `execution`  — `[4]: tool:<toolUseId>`
 *   - `formal`     — `[5]: proof:prf_<16 hex>`
 *   - `assumption` — `[A1]: assume: <text>`
 */
export type BindingKind = "source" | "execution" | "formal" | "assumption";

/**
 * Why a binding does not meet the floor. Stable strings: they appear in the
 * retry nudge, the bundle, `provability audit` roll-ups and the graders.
 */
export type UnmetReason =
  /** The claim sentence carries no marker at all. */
  | "no_citation"
  /** A marker in the claim has no `[n]: …` definition. */
  | "no_definition"
  /** The source is neither a URL, a `doi:`, nor a workspace path (and
   *  `sources.bibliographic` is off). */
  | "not_locatable"
  /** The URL's host fails `sources.allow` or matches `sources.deny`. */
  | "host_denied"
  /** The URL names loopback / RFC 1918 / link-local / metadata space. */
  | "private_address"
  /** A path source resolves outside the workspace. */
  | "path_outside_workspace"
  /** A path source does not exist. */
  | "path_missing"
  /** `sources.resolve: head` got no 2xx/3xx answer. */
  | "unresolved"
  /** The source's body was never fetched/read in this run's evidence. */
  | "not_fetched"
  /** The body was fetched but the claim's words are not in one window of it. */
  | "not_found_in_source"
  /** The words are there, with a negation the claim lacks. */
  | "polarity_conflict"
  /** `grounded.independent` asks for more distinct origins than the claim has. */
  | "not_independent"
  /** `tool:<id>` resolves to no recorded call. */
  | "tool_missing"
  /** The recorded call returned an error result. */
  | "tool_errored"
  /** The tool is not on `execution.allow`. */
  | "tool_not_allowed"
  /** The result text does not contain the claim's numerals / quoted values. */
  | "value_absent"
  /** Re-running the pure tool produced a different output digest. */
  | "replay_mismatch"
  /** `proof:<id>` names no stored artifact. */
  | "proof_missing"
  /** The stored artifact records `ok: false`. */
  | "proof_rejected"
  /** The artifact's recorded claim does not cover the answer's sentence. */
  | "claim_mismatch"
  /** `assumptions: forbid`, or past `max_assumptions`. */
  | "assumption_forbidden"
  /** The binding is valid but below the floor (e.g. a source at `checked`). */
  | "below_floor";

/** One definition a claim's marker resolved to, and what it proved. */
export type ProofBinding = {
  /** The marker as written: `"[1]"`, `"[^a]"`, `"[A1]"`. */
  readonly ref: string;
  readonly kind: BindingKind;
  /** The highest rung this binding satisfies (`"none"` when it satisfies none). */
  readonly rung: Rung;
  /** True iff `rung` is at or above the configured floor — and, under
   *  `grounded.independent > 1`, its claim has enough distinct origins (a
   *  source binding that grounded alone carries `not_independent`). An
   *  assumption binding is never `ok`: it is not evidence. */
  readonly ok: boolean;
  /** Present when `ok` is false: the first reason it fell short. Absent on
   *  an ALLOWED assumption binding — it is not evidence and not a failure;
   *  its claim's `status` (`assumption`) says what it is. */
  readonly reason?: UnmetReason;
  /** Human-readable detail for the reason (no fetched content beyond `excerpt`). */
  readonly detail?: string;
  /** Normalized URL / workspace path / toolUseId / `prf_` id / assumption text. */
  readonly origin?: string;
  /** Digest of the body / result / artifact the verdict was made against (`sha256:<hex>`). */
  readonly sha256?: string;
  /** ≤240 chars, whitespace-collapsed: the span that grounded the claim. */
  readonly excerpt?: string;
  /** Execution bindings: whether a replay ran (and matched, when `ok`). */
  readonly replayed?: boolean;
  /** Grounded bindings: the opt-in waiver judge accepted a paraphrase miss. */
  readonly judgeWaived?: boolean;
  /** Formal bindings: the checker id and the formal statement shown beside the prose. */
  readonly checker?: string;
  readonly statement?: string;
  /**
   * Formal bindings: the hypotheses the proof rests on (the artifact's
   * `assumptions` — builtin `given` steps, SMT asserts and definitions),
   * shown beside the statement. Design §6.4: hypotheses are assumptions in
   * the bundle — counted with the declared ones (`ProofBundle.hypotheses`),
   * refused under `assumptions: forbid` and capped by `max_assumptions`.
   * Absent when the proof rests on none. (0.8.0 additive, fix pass.)
   */
  readonly assumptions?: readonly string[];
};

export type ClaimStatus = "met" | "unmet" | "assumption";

/** One extracted claim and every binding its markers resolved to. */
export type ProofClaim = {
  readonly index: number;
  /** The claim sentence as it appears in the answer (clipped to 400 chars). */
  readonly text: string;
  readonly line?: number;
  readonly status: ClaimStatus;
  /** The highest rung any binding of this claim reached. */
  readonly best: Rung;
  readonly bindings: ReadonlyArray<ProofBinding>;
  /**
   * Present when the claim is text a definition line shows after what it
   * names (`[1]: https://… Payments clear within 5 days`): that definition's
   * marker, `"[1]"`. Such text renders as prose, so it is read as claims
   * citing that definition rather than shown to the reader unread. (0.8.0
   * additive, W1-C fix pass.)
   */
  readonly definition?: string;
};

export type ProofVerdict = "pass" | "fail" | "unverified";

/** The per-answer artifact (design §5.3). */
export type ProofBundle = {
  readonly version: 1;
  /** The floor. */
  readonly level: ProvabilityLevel;
  /** `unverified` — the verifier threw; the gate failed open (§5.1). */
  readonly verdict: ProofVerdict;
  /** met / (claims − assumptions); 1 for the vacuous zero-claim case. */
  readonly score: number;
  readonly threshold: number;
  /** The highest floor this answer would have passed. */
  readonly achieved: Rung;
  readonly claims: ReadonlyArray<ProofClaim>;
  /** Count of extracted claims (assumption claims included). */
  readonly claimCount: number;
  readonly met: number;
  readonly unmet: number;
  /** Claims whose status is `assumption`: accepted, and out of the score. */
  readonly assumptions: number;
  /**
   * Declared assumptions the config refused — every one under `assumptions:
   * forbid`, the ones past `max_assumptions` otherwise. Their claims are
   * `unmet` (binding reason `assumption_forbidden`), and any refusal fails
   * the verdict whatever the score (design §2: the turn passes only when
   * assumptions ≤ max_assumptions). The answer declared `assumptions +
   * assumptionsRefused` assumptions in all. Absent when none was refused.
   * (0.8.0 additive, W1-C fix pass.)
   */
  readonly assumptionsRefused?: number;
  /**
   * Distinct hypotheses the accepted proofs behind `proven` bindings rest on
   * (`ProofBinding.assumptions`): assumptions too (design §6.4, §10), so
   * every surface counts them with `assumptions` — outside the score, which
   * counts claims. A claim refused for its proof's hypotheses (`forbid`, or
   * past `max_assumptions`) is in `assumptionsRefused` instead. Absent when
   * none. (0.8.0 additive, fix pass.)
   */
  readonly hypotheses?: number;
  /**
   * Distinct source origins behind the claims: at a `cited` floor every
   * origin that passed the cited checks, at `grounded` and above every
   * origin that grounded a claim — what "N sources" beside the floor means.
   */
  readonly sources: number;
  /** Bindings the waiver judge flipped. */
  readonly judgeWaived: number;
  /** 0 = the original answer, n = the n-th gate-triggered retry. */
  readonly retryIndex: number;
  /** Proof checkers whose artifacts back `proven` bindings, with the axioms
   *  and (when any) the hypotheses each proof depends on (design §2, §6.4). */
  readonly checkers?: ReadonlyArray<{
    readonly id: string;
    readonly artifact: string;
    readonly axioms: readonly string[];
    /** The hypotheses the proof rests on; absent when none. (0.8.0 additive, fix pass.) */
    readonly assumptions?: readonly string[];
  }>;
  /** Present on a zero-claim answer: why the pass is vacuous. */
  readonly vacuous?: string;
  /** Present when `verdict === "unverified"`: what the verifier threw. */
  readonly error?: string;
  /** The waiver judge's model and spend, when it ran. */
  readonly judgeModel?: string;
  readonly spentUsdMicros?: number;
  readonly createdAt: string;
  /** `sha256:<hex>` over the canonical JSON of every other field (see `bundleHash`). */
  readonly bundleHash: string;
};

/** The summary carried by the `provability_graded` trace/event-log line and audit record. */
export type ProvabilityGradedSummary = {
  readonly level: ProvabilityLevel;
  readonly verdict: ProofVerdict;
  readonly score: number;
  readonly threshold: number;
  readonly achieved: Rung;
  readonly claims: number;
  readonly met: number;
  readonly unmet: number;
  readonly assumptions: number;
  /** `ProofBundle.assumptionsRefused`, when any. (0.8.0 additive, W1-C fix pass.) */
  readonly assumptionsRefused?: number;
  /**
   * `ProofBundle.hypotheses` — the hypotheses accepted proofs rest on,
   * assumptions too (design §6.4, §10) — when any. (0.8.0 additive, fix pass.)
   */
  readonly hypotheses?: number;
  readonly retryIndex: number;
  readonly bundleHash: string;
  readonly judgeModel?: string;
  readonly judgeCostUsdMicros?: number;
};

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * One recorded tool call: the input the model sent and the result it got,
 * verbatim, as the session event log (or the in-memory transcript) holds it.
 */
export type EvidenceRecord = {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** The result text, verbatim, as the log holds it. */
  readonly content: string;
  /**
   * The whole output when `content` is the runtime's spill preview of it
   * (`@crewhaus/tool-result-store`: the head, then the path the output was
   * saved at), read back from that file (evidence.ts `spilledOutput`). The
   * verifiers read a record's text as `body ?? content`; a replay is
   * compared with `content`, the form the log holds. (0.8.0 additive, fix
   * pass.)
   */
  readonly body?: string;
  readonly isError: boolean;
  /** The session whose log carried the call (child sessions included). */
  readonly sessionId?: string;
  /** Normalized origins (URLs / workspace paths) this call fetched or read
   *  as a WHOLE body: its input's `url`/`path` fields and the URL a fetch's
   *  header names. `bySource` answers these with the whole record. */
  readonly origins: readonly string[];
  /**
   * The HTTP status a fetcher's own header reports (WebFetch's `Status:`,
   * Fetch's status line). A body under a status outside 2xx is the server's
   * error page, not the page: `grounded` does not read it. (0.8.0 additive,
   * fix pass.)
   */
  readonly status?: number;
  /** Turn number, when the log recorded one (used by `scope: turn`). */
  readonly turnNumber?: number;
  /**
   * A result that carries several hits, each from its own origin (Retrieve
   * hits, a JSON search result with `url`/`source` fields): each hit's own
   * text under its own normalized origin. `bySource` answers a hit's origin
   * with that hit's text alone, never the whole result — otherwise one hit
   * could ground a claim cited to another. Absent when the result has none.
   * (0.8.0 additive, W1-C.)
   */
  readonly hits?: ReadonlyArray<{ readonly origin: string; readonly content: string }>;
};

/** The session-scoped view of every body the run read and every result it got. */
export interface EvidenceIndex {
  /** Records whose fetched/read origin normalizes to `origin`. For a hit's
   *  origin (`EvidenceRecord.hits`) the record returned is a view of the call
   *  whose `content` is that hit's text and whose `origins` is `[origin]`. */
  bySource(origin: string): ReadonlyArray<EvidenceRecord>;
  /** The record for one toolUseId, when the run made that call. */
  byToolUseId(toolUseId: string): EvidenceRecord | undefined;
  /** Every record, in the order the calls were made. */
  all(): ReadonlyArray<EvidenceRecord>;
}

// ---------------------------------------------------------------------------
// Proof artifacts (the `proven` rung)
// ---------------------------------------------------------------------------

/** What `ProofCheck` persists and the `proven` verifier reads (design §6.4). */
export type ProofArtifact = {
  readonly version: 1;
  /** `prf_<16 hex>`. */
  readonly id: string;
  /** Checker id: `builtin` | `smt` | `lean4` | a plugin id. */
  readonly checker: string;
  /** The prose claim the proof is for (the sentence the answer will carry). */
  readonly claim: string;
  /** The formal statement, in the checker's language. */
  readonly statement: string;
  /** The proof / certificate / SMT problem, verbatim. */
  readonly proof: string;
  readonly ok: boolean;
  /** Hypotheses the proof rests on (`given` steps, SMT asserts). */
  readonly assumptions: readonly string[];
  /** Axioms beyond the checker's base (lean `#print axioms`). */
  readonly axioms: readonly string[];
  /** Checker output, clipped. */
  readonly output: string;
  readonly counterexample?: string;
  readonly reason?: string;
  /** `sha256:<hex>` of `output`. */
  readonly outputDigest: string;
  readonly checkedAt: string;
  readonly durationMs?: number;
};

export interface ProofArtifactStore {
  get(id: string): Promise<ProofArtifact | undefined>;
  put(artifact: ProofArtifact): Promise<void>;
  list(): Promise<ReadonlyArray<ProofArtifact>>;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Result of re-executing a pure tool for `checked` replay. */
export type ReplayResult = { readonly content: string; readonly isError: boolean };

/**
 * A HEAD the caller's resolver refused to send (`VerifyOptions.resolveHead`):
 * `egress` — the run's egress fabric found content a boundary tagged (a
 * secret a tool read) in the URL, so the request would have carried it out.
 * The URL is not checked, and the binding says why. (0.8.0 additive, fix
 * pass.)
 */
export type HeadRefusal = { readonly refused: "egress" };

/** A stored proof checked again (`VerifyOptions.recheckProof`). */
export type RecheckedProof = {
  readonly ok: boolean;
  readonly assumptions?: readonly string[];
  readonly axioms?: readonly string[];
};

/** Verdict of the opt-in paraphrase-waiver judge (design §6.2). */
export type JudgeWaiverVerdict = {
  readonly supported: boolean;
  readonly model?: string;
  readonly costUsdMicros?: number;
};

export type VerifyOptions = {
  readonly config: ProvabilityConfig;
  readonly evidence: EvidenceIndex;
  /** Workspace root for path sources (default: process.cwd()). */
  readonly workspaceRoot?: string;
  /** Where relative path sources are measured from (default: workspaceRoot). */
  readonly baseDir?: string;
  /** Proof artifacts for `proof:` bindings. Absent ⇒ every formal binding is `proof_missing`. */
  readonly artifacts?: ProofArtifactStore;
  /**
   * Re-run a stored artifact's checker on its statement and proof (design
   * §6.4: a registered checker ACCEPTED it) — wired for a checker that is
   * pure and cheap enough to run at gate time, the builtin certificate
   * checker. `undefined` when it cannot re-check this one (another checker,
   * none wired); a throw reads the same. A re-check that rejects is
   * `proof_rejected`; one that accepts supplies the hypotheses and axioms
   * the bundle lists, in place of the stored ones. (0.8.0 additive, fix
   * pass.)
   */
  readonly recheckProof?: (
    artifact: ProofArtifact,
  ) => Promise<RecheckedProof | undefined> | RecheckedProof | undefined;
  /**
   * Accept a stored artifact WITHOUT the `ProofCheck` call that wrote it in
   * `evidence`. Off by default and never on the gate: an artifact is a file
   * in the workspace, so the model can write one (or flip a rejected one to
   * `ok: true`) with its own file tools, and only the run's own record of
   * the check shows a checker accepted it. For an offline check of a
   * document whose run's log is not at hand. (0.8.0 additive, fix pass.)
   */
  readonly trustStoredProofs?: boolean;
  /** Re-execute a tool with its logged input. Absent ⇒ no replay (bindings record `replayed: false`). */
  readonly replay?: (toolName: string, input: unknown) => Promise<ReplayResult | undefined>;
  /** Whether a tool is pure (readOnly && concurrencySafe) and so may be replayed. */
  readonly isPureTool?: (toolName: string) => boolean;
  /**
   * `sources.resolve: head` — the HTTP status of one guarded HEAD, or
   * undefined on failure. Up to a few run at once, under one deadline for
   * the whole verification (`headDeadlineMs`); `signal` aborts when that
   * deadline passes.
   */
  readonly resolveHead?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<number | HeadRefusal | undefined>;
  /**
   * How long one verification waits on its HEAD requests in all (default
   * 15 s): a URL not answered by then is `unresolved`, not checked. (0.8.0
   * additive, fix pass.)
   */
  readonly headDeadlineMs?: number;
  /** The opt-in waiver judge; called only for paraphrase-coverage misses at `grounded`. */
  readonly judgeWaiver?: (input: {
    readonly claim: string;
    readonly excerpt: string;
    readonly source: string;
  }) => Promise<JudgeWaiverVerdict>;
  /** Restrict evidence to these turn numbers (`scope: turn`). */
  readonly turnNumbers?: ReadonlySet<number>;
  readonly retryIndex?: number;
  readonly now?: () => Date;
};
