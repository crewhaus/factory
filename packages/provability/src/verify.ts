/**
 * `verifyDocument` — the four verifiers over one answer (design §2, §6).
 *
 * The gate, the `ProvabilityPreflight` tool, `crewhaus provability check`
 * and the research report gate all call this one function, so a draft the
 * model preflights is graded exactly as the gate will grade it. Every rung
 * is deterministic: the citation grammar, bodies the run itself read, tool
 * results the log recorded verbatim, re-execution of pure tools, and a proof
 * checker's recorded verdict. The three things that reach outside — the HEAD
 * request, the replay and the paraphrase-waiver judge — are INJECTED, and
 * each is called only when the floor needs it (see {@link verifyDocument}).
 * The package imports no model adapter: the judge is a callback.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  type ClaimQuery,
  type EvidenceRef,
  type ExtractedClaim,
  type Location,
  MIN_CLAIM_TOKENS,
  NEGATIONS,
  STOPWORDS,
  type SourceIndex,
  type SourceToken,
  citationDefinitions,
  claimFigureKeys,
  claimQuery,
  claimWords,
  classifyDefinition,
  compoundValues,
  containsQuote,
  containsValue,
  contentTokens,
  coverage,
  definitionGloss,
  extractClaims,
  extractNumbers,
  figureKey,
  findSequence,
  foldTypography,
  governingNegation,
  indexSource,
  isWaivableMiss,
  locateClaim,
  normalizeNumber,
  quotedSpans,
  tightestWindows,
  tokenize,
  writtenSpan,
} from "@crewhaus/claim-ledger";
import { resolveContained } from "@crewhaus/tool-safety/fs";
import { isProofArtifact, isProofId } from "./artifact";
import {
  FACT_CROSS_CHECK,
  PROOF_CHECK,
  PROVABILITY_PREFLIGHT,
  RETRIEVE,
  builtinKey,
  isMcpTool,
} from "./builtins";
import {
  ProvabilityError,
  type WrittenPlace,
  groundingBody,
  inputPlaces,
  inputStrings,
  isReader,
  originFieldValues,
  restrictToTurns,
  servedFrom,
  servesPage,
  sha256Of,
  writtenPlaces,
  writtenText,
} from "./evidence";
import { isProvabilityLevel, levelRank, maxRung, meetsFloor } from "./levels";
import {
  doiUrl,
  hasUserinfo,
  hostMatches,
  hostOf,
  isPrivateHost,
  normalizePath,
  normalizeUrl,
  registrableDomain,
} from "./origin";
import {
  type BindingKind,
  type ClaimStatus,
  type EvidenceRecord,
  PROVABILITY_LEVELS,
  type ProofArtifact,
  type ProofBinding,
  type ProofBundle,
  type ProofClaim,
  type ProvabilityConfig,
  type ProvabilityLevel,
  type RecheckedProof,
  type Rung,
  type UnmetReason,
  type VerifyOptions,
} from "./types";
import { backstopClaims } from "./vacuous";

/** A claim's text as the bundle carries it (design §5.3). */
const MAX_CLAIM_CHARS = 400;
/** A frozen excerpt (design §5.3, the FrozenProof discipline). */
const MAX_EXCERPT_CHARS = 240;
/** A formal statement as the bundle shows it beside the prose. */
const MAX_STATEMENT_CHARS = 1_000;
/**
 * Distinct URLs one verification sends a HEAD to under `sources.resolve:
 * head` (design §6.1). The answer is model-written, so without a ceiling it
 * decides how many outbound requests the gate makes and how long it waits
 * on them; a URL past the ceiling is `unresolved` — not checked is not
 * reachable — and the detail names the cap.
 */
export const MAX_HEAD_REQUESTS = 50;
/**
 * How many of those HEADs are in flight at once, and how long one
 * verification waits on them in all (design §6.1, §18: the gate's cost is
 * bounded). Sent one at a time under a per-request timeout alone, fifty
 * URLs on hosts that never answer held one pass for minutes, and again on
 * every retry; past the deadline a URL is `unresolved` — not checked is not
 * reachable — whatever is still pending.
 */
export const HEAD_CONCURRENCY = 6;
export const HEAD_DEADLINE_MS = 15_000;
/**
 * Fetched text one verification reads while grounding, in tokens: each
 * claim reads every body it cites end to end, so a long answer citing a
 * large page costs claims × body — 200 claims over a 4 MB page held the
 * harness thread for twelve seconds per pass. Past this a source binding
 * is not read for grounding: it reaches `cited` and, at a higher floor,
 * reads `below_floor` with a detail naming the cap (§18: bounded gate
 * cost). The verifier also yields to the event loop between claims, so
 * the work it does do never holds the process for long at a stretch.
 */
export const MAX_GROUNDING_TOKENS = 40_000_000;
let groundingBudget = MAX_GROUNDING_TOKENS;
/** Test seam: a smaller grounding budget, or (no argument) {@link MAX_GROUNDING_TOKENS} again. */
export function _setGroundingBudgetForTest(tokens?: number): void {
  groundingBudget = tokens ?? MAX_GROUNDING_TOKENS;
}
/** How long the verifier works between yields to the event loop. */
const YIELD_EVERY_MS = 10;
/** How much of a span `echoCheck` re-reads when the excerpt was cut at 240. */
const MAX_ECHO_SPAN_CHARS = 64 * 1024;

/**
 * Whitespace collapsed, cut to `max` with an ellipsis. Only a prefix of a
 * long text is collapsed — a 2 MB tool result clipped to 240 characters
 * must not be rewritten whole — unless that prefix is so full of
 * whitespace that it collapses to fewer than `max` characters.
 */
export function clip(text: string, max: number): string {
  const bound = max * 8 + 1_024;
  if (text.length > bound) {
    const head = text.slice(0, bound).replace(/\s+/g, " ").trimStart();
    if (head.length > max) return `${head.slice(0, max - 1).trimEnd()}…`;
  }
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * At most `max` characters of `text` around `[from, to)`, whitespace
 * collapsed, an ellipsis marking each cut: the frozen excerpt of a long
 * body or result, centred on what met the floor (design §5.3: a bundle
 * stays human-checkable after the body is gone, so its excerpt must show
 * the figure or the words that grounded the claim, not the text's first
 * 240 characters). When `[from, to)` itself is longer, its start is kept.
 */
export function clipAround(text: string, from: number, to: number, max: number): string {
  const reach = max * 4;
  const lo = Math.max(0, from - reach);
  const hi = Math.min(text.length, to + reach);
  const squash = (s: string): string => s.replace(/\s+/g, " ");
  let before = squash(text.slice(lo, from));
  const focus = squash(text.slice(from, to)).trim();
  let after = squash(text.slice(to, hi));
  if (lo === 0) before = before.trimStart();
  if (hi === text.length) after = after.trimEnd();
  if (focus.length >= max - 1) {
    const lead = before !== "" ? "…" : "";
    return `${lead}${focus.slice(0, max - 1 - lead.length).trimEnd()}…`;
  }
  const room = max - focus.length;
  let b = Math.min(before.length, Math.floor(room / 2));
  let a = Math.min(after.length, room - b);
  b = Math.min(before.length, room - a);
  const fits = (): boolean =>
    b + a + (b < before.length ? 1 : 0) + (a < after.length ? 1 : 0) <= room;
  while (!fits()) {
    if (a >= b && a > 0) a -= 1;
    else b -= 1;
  }
  const left = `${b < before.length ? "…" : ""}${before.slice(before.length - b).trimStart()}`;
  const right = `${after.slice(0, a).trimEnd()}${a < after.length ? "…" : ""}`;
  return `${left}${focus}${right}`;
}

/**
 * The figures a text states, by the keys the figure rule compares them under
 * (`claimFigureKeys`): `thirty` and `30` are one, "-500" is `-500` and not
 * `500`, the `M` of "$5M" is `1000000`. A date or a time of day is also
 * its whole value (`compoundValues`), so `2024-03-05` and `2024-05-03` — the
 * same three numbers — differ (design §6.2, acceptance A: a wrong figure
 * never binds).
 */
function figureKeys(text: string): Set<string> {
  const keys = new Set([...claimFigureKeys(text).values()].flat());
  for (const value of compoundValues(text)) keys.add(value.key);
  return keys;
}

/** sha256 of a result with its whitespace collapsed: what a replay is compared under. */
function outputDigest(content: string): string {
  return sha256Of(content.replace(/\s+/g, " ").trim());
}

/**
 * The fewest of `of` claims that clears `threshold` — `met / of ≥ threshold`
 * asked in integers, so `0.7 × 10` (7.000000000000001 in floating point)
 * needs 7, not 8.
 */
function needed(threshold: number, of: number): number {
  return Math.max(0, Math.ceil(threshold * of - 1e-9));
}

/**
 * The reasons a claim is unmet: `no_citation` for a claim with no marker at
 * all (it has zero bindings — the representation design §5.1's nudge reads),
 * else the reason of every binding that is not `ok`, in order, each once. An
 * empty list for a met or assumption claim.
 */
export function claimReasons(claim: ProofClaim): UnmetReason[] {
  if (claim.status !== "unmet") return [];
  if (claim.bindings.length === 0) return ["no_citation"];
  const out: UnmetReason[] = [];
  for (const binding of claim.bindings) {
    if (binding.reason !== undefined && !out.includes(binding.reason)) out.push(binding.reason);
  }
  return out;
}

/** What a binding has reached on its way up, before the floor is applied. */
type Reached = {
  rung: Rung;
  failure?: { readonly reason: UnmetReason; readonly detail: string };
  origin?: string;
  sha256?: string;
  excerpt?: string;
  replayed?: boolean;
  judgeWaived?: boolean;
  writtenBy?: { readonly toolUseId: string; readonly toolName: string };
  checker?: string;
  statement?: string;
  assumptions?: readonly string[];
};

type Judged = { model?: string; costUsdMicros: number; calls: number };

/**
 * A source binding's paraphrase miss the waiver judge may be asked about
 * (design §6.2) — asked only once the claim's other bindings are settled
 * and only while the claim still needs it ({@link waive}).
 */
type Waivable = {
  readonly claim: ExtractedClaim;
  readonly origin: string;
  /** The span the judge reads, as the locate kernel reported it. */
  readonly span: string;
  /** The excerpt the bundle freezes when the judge says yes. */
  readonly excerpt: string | undefined;
  readonly sha256: string;
  /** The origin `grounded.independent` counts the body as ({@link bodyKey}). */
  readonly key: string;
};

/** A binding as the claim loop first settles it, and the waiver it may still get. */
type Bound = { readonly binding: ProofBinding; readonly waivable?: Waivable };

/**
 * What the `checked` verifier reads off one recorded call, worked out once
 * per call however many claims cite it: a large result cited by hundreds of
 * claims is scanned for its numbers, tokens and negations once, not once a
 * claim.
 */
type CallFacts = {
  /** The result text, read off the record once. */
  readonly content: string;
  sha256?: string;
  excerpt?: string;
  numbers?: ReadonlySet<string>;
  /** The call as the coverage fallback reads it: result, then input. */
  said?: { readonly tokens: ReadonlySet<string>; readonly index: SourceIndex };
  /** The result alone, as the coverage fallback's echo tests read it. */
  result?: { readonly tokens: ReadonlySet<string>; readonly index: SourceIndex };
  /** The input alone: its words, and each of its strings indexed. */
  input?: { readonly tokens: ReadonlySet<string>; readonly strings: readonly SourceIndex[] };
  /** The result as the figure polarity rule reads it (`figurePolarity`). */
  polarity?: ResultPolarity;
  /** Excerpts centred on a figure or a quotation, by where it sits in the result. */
  excerpts?: Map<number, string>;
  /** The result with the claim the input handed over blanked out, by the runs blanked ({@link ownResult}). */
  owns?: Map<string, CallFacts>;
  /** A `FactCrossCheck` report, read once ({@link factCheckReport}); `null` when it is not one. */
  factCheck?: FactCheckReport | null;
  /** Each supported entry's source text as the checks read it, by entry ({@link factCheckFacts}). */
  factChecks?: Map<number, CallFacts>;
  /**
   * A `FactCrossCheck` entry's source text only: the call that wrote it
   * there, when every file the check found the claim in is one this run
   * wrote itself before the check ({@link factCheckSupport}).
   */
  writtenBy?: EvidenceRecord;
};

/** How often a word occurs over some stretch of a result, and how often it is denied there. */
type WordFacts = { occurrences: number; denials: number };

/** What one result says of one figure: the figure itself, and the words beside it. */
type FigureFacts = {
  /** The figure's own occurrences anywhere in the result, and how many are denied. */
  readonly self: WordFacts;
  /** Every other word of the statements that hold the figure ({@link statementWords}). */
  readonly words: ReadonlyMap<string, WordFacts>;
};

/**
 * One result as {@link figurePolarity} reads it. The token pass is made once
 * per call; each statement's table of words, and each figure's, is built the
 * first time a claim asks about a figure there and kept, so a result cited
 * by hundreds of claims is read once per distinct figure, never once a claim
 * (a figure common to every line — a quantity of 1 — is otherwise the whole
 * result again for each claim that states it).
 */
type ResultPolarity = {
  readonly index: SourceIndex;
  /** The statement each token sits in ({@link statementNumbers}). */
  readonly statement: Uint32Array;
  /** The first token of each statement, by statement number. */
  readonly statementStarts: readonly number[];
  /** Where each figure occurs, by {@link polarityKey} (`#<value>`). */
  readonly figureAt: ReadonlyMap<string, readonly number[]>;
  /** Each statement's words, by statement number, once read. */
  readonly statements: Map<number, ReadonlyMap<string, WordFacts>>;
  /** Each figure's facts, by its key, once read. */
  readonly figures: Map<string, FigureFacts>;
};

type ReplayOutcome = "match" | "mismatch" | "not_run" | "budget";

/** Everything one `verifyDocument` call shares across claims. */
type Run = {
  readonly config: ProvabilityConfig;
  readonly floor: ProvabilityLevel;
  readonly opts: VerifyOptions;
  readonly evidence: VerifyOptions["evidence"];
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly heads: Map<string, Promise<HeadOutcome>>;
  readonly bodies: Map<object, { readonly index: SourceIndex; readonly sha256: string }>;
  readonly calls: Map<object, CallFacts>;
  /** Each call's input strings, indexed, by its record (`echoCheck`). */
  readonly inputs: Map<EvidenceRecord, CallInputs>;
  /** Bodies with an address they print blanked out, by body and by what was blanked (`echoCheck`). */
  readonly masked: Map<SourceIndex, Map<string, SourceIndex>>;
  /** The URL each record's body was served from (`servedFrom`), read once. */
  readonly served: Map<EvidenceRecord, string | undefined>;
  /**
   * What `grounded.independent` counts a grounded binding as, by the body's
   * digest and the origin it was cited under: the origin that SERVED the
   * body ({@link bodyKey}), so a page cited twice — once through a redirect
   * to it — is one origin, not two.
   */
  readonly bodyKeys: Map<string, string>;
  /** The state directories a path source must not lie under, real paths ({@link stateRootOf}). */
  readonly stateRoots: ReadonlyArray<{ readonly dir: string; readonly shown: string }>;
  /** Text each call sent, in call order, for the stored-text test ({@link storedText}). */
  sent?: SentText;
  /** The places each call of {@link SentText} may have written, by its place there ({@link writesOf}). */
  writes?: Map<number, readonly WrittenPlace[]>;
  /** What each of those calls put where it wrote, by its place there ({@link wroteOf}). */
  wrote?: Map<number, Wrote>;
  /** The places in {@link SentText} of every call that may have written somewhere, in order ({@link provenanceOf}). */
  writers?: readonly number[];
  /** What the run did to the places a body was read from, by the read and the places ({@link provenanceOf}). */
  provenances?: Map<string, Provenance>;
  readonly replays: Map<string, Promise<ReplayOutcome>>;
  readonly artifacts: Map<string, Promise<ProofArtifact | undefined>>;
  readonly checkers: Map<string, NonNullable<ProofBundle["checkers"]>[number]>;
  /** What each `ProofCheck` call in the evidence reported, by artifact id (`proofReports`). */
  reports?: ReadonlyMap<string, readonly ProofReport[]>;
  /** Each artifact re-checked once (`VerifyOptions.recheckProof`), by id. */
  readonly rechecks: Map<string, Promise<RecheckedProof | undefined>>;
  readonly judge: Judged;
  replaysUsed: number;
  headsUsed: number;
  /** Fetched-text tokens read while grounding so far ({@link MAX_GROUNDING_TOKENS}). */
  groundingTokens: number;
  /** When the verifier last yielded to the event loop (`performance.now()`). */
  lastYield: number;
};

function belowFloorDetail(kind: BindingKind, rung: Rung, floor: ProvabilityLevel): string {
  const most =
    kind === "source"
      ? "a source reaches grounded at most"
      : kind === "execution"
        ? "a tool result reaches checked at most"
        : `this binding reaches ${rung}`;
  return `${most}; the floor is ${floor} — cite ${
    floor === "proven" ? "a proof:prf_… artifact" : "a tool:<toolUseId> or proof:prf_… binding"
  }`;
}

/** A reached state measured against the floor. */
function finish(
  ref: string,
  kind: BindingKind,
  reached: Reached,
  floor: ProvabilityLevel,
): ProofBinding {
  const ok = meetsFloor(reached.rung, floor);
  const reason = ok ? undefined : (reached.failure?.reason ?? "below_floor");
  const detail = ok
    ? undefined
    : (reached.failure?.detail ?? belowFloorDetail(kind, reached.rung, floor));
  return {
    ref,
    kind,
    rung: reached.rung,
    ok,
    ...(reason !== undefined ? { reason } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(reached.origin !== undefined ? { origin: reached.origin } : {}),
    ...(reached.sha256 !== undefined ? { sha256: reached.sha256 } : {}),
    ...(reached.excerpt !== undefined ? { excerpt: reached.excerpt } : {}),
    ...(reached.replayed !== undefined ? { replayed: reached.replayed } : {}),
    ...(reached.judgeWaived === true ? { judgeWaived: true } : {}),
    ...(reached.writtenBy !== undefined ? { writtenBy: reached.writtenBy } : {}),
    ...(reached.checker !== undefined ? { checker: reached.checker } : {}),
    ...(reached.statement !== undefined ? { statement: reached.statement } : {}),
    ...(reached.assumptions !== undefined && reached.assumptions.length > 0
      ? { assumptions: reached.assumptions }
      : {}),
  };
}

function fail(
  rung: Rung,
  reason: UnmetReason,
  detail: string,
  extra: Partial<Reached> = {},
): Reached {
  return { ...extra, rung, failure: { reason, detail } };
}

// ---------------------------------------------------------------------------
// source bindings: cited → grounded
// ---------------------------------------------------------------------------

type SourceRef = Extract<EvidenceRef, { kind: "url" | "doi" | "path" | "text" }>;

/** What one URL's HEAD came to: a status, no answer, or not asked before the deadline. */
type HeadOutcome = number | undefined | "deadline" | "egress";

/**
 * One guarded HEAD through the caller's resolver: a status, `"egress"` when
 * the run's egress fabric refused to send it, or `undefined` for no answer.
 */
async function sendHead(
  run: Run,
  url: string,
  signal: AbortSignal,
): Promise<number | "egress" | undefined> {
  const resolve = run.opts.resolveHead;
  if (resolve === undefined) return undefined;
  try {
    const status = await resolve(url, signal);
    if (typeof status === "object" && status !== null && status.refused === "egress") {
      return "egress";
    }
    return typeof status === "number" && Number.isFinite(status) ? status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send the HEADs of `urls` — the distinct URLs this verification will ask
 * about, in the order it asks, at most {@link MAX_HEAD_REQUESTS} — before
 * any is awaited: {@link HEAD_CONCURRENCY} in flight at once, every one
 * under one deadline for the whole verification (`headDeadlineMs`). A URL
 * still unanswered, or not yet sent, when the deadline passes comes to
 * `"deadline"`; the resolver's signal is aborted then, so one that honours
 * it stops. The deadline timer never holds the process open.
 */
function sendHeads(run: Run, urls: readonly string[]): void {
  if (urls.length === 0) return;
  const deadline = run.opts.headDeadlineMs ?? HEAD_DEADLINE_MS;
  const controller = new AbortController();
  const settle = new Map<string, (outcome: HeadOutcome) => void>();
  for (const url of urls) {
    run.headsUsed += 1;
    run.heads.set(url, new Promise<HeadOutcome>((resolve) => settle.set(url, resolve)));
  }
  const queue = [...urls];
  let open = urls.length;
  let active = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    for (const resolve of settle.values()) resolve("deadline");
  }, deadline);
  (timer as { unref?: () => void }).unref?.();
  const pump = (): void => {
    while (!expired && active < HEAD_CONCURRENCY && queue.length > 0) {
      const url = queue.shift() as string;
      active += 1;
      void sendHead(run, url, controller.signal).then((status) => {
        active -= 1;
        open -= 1;
        // A settled promise ignores a second settlement: one the deadline
        // already decided stays "deadline".
        settle.get(url)?.(status);
        if (open === 0) clearTimeout(timer);
        pump();
      });
    }
  };
  pump();
}

async function headStatus(run: Run, url: string): Promise<HeadOutcome | "budget"> {
  let pending = run.heads.get(url);
  if (pending === undefined) {
    // Every URL the verification asks about was sent up front (`sendHeads`);
    // one that was not is past the cap.
    if (run.headsUsed >= MAX_HEAD_REQUESTS) return "budget";
    sendHeads(run, [url]);
    pending = run.heads.get(url) as Promise<HeadOutcome>;
  }
  return pending;
}

/** Why a URL fails the `cited` host checks (deny, allow, private address), or `undefined`. */
function hostRefusal(run: Run, url: string): Reached | undefined {
  const { sources } = run.config;
  const host = hostOf(url) ?? "";
  if (sources.deny.length > 0 && hostMatches(host, sources.deny)) {
    return fail("none", "host_denied", `${host} matches provability.sources.deny`, { origin: url });
  }
  if (sources.allow.length > 0 && !hostMatches(host, sources.allow)) {
    return fail("none", "host_denied", `${host} is not on provability.sources.allow`, {
      origin: url,
    });
  }
  if (isPrivateHost(host)) {
    return fail(
      "none",
      "private_address",
      `${host} is a loopback, private or link-local address, not a public source`,
      { origin: url },
    );
  }
  return undefined;
}

/**
 * Does this verification send HEADs? Reachability matters only where a
 * source can meet the floor: at `checked` and `proven` no source binding
 * does, so no request is made.
 */
function sendsHeads(run: Run): boolean {
  return (
    run.config.sources.resolve === "head" &&
    levelRank(run.floor) <= levelRank("grounded") &&
    run.opts.resolveHead !== undefined
  );
}

/**
 * The URL a source definition names, normalized (a DOI as its resolver
 * URL), or `undefined` for any other definition.
 */
function definitionUrl(source: string): string | undefined {
  const ref = classifyDefinition(source);
  // A URL with userinfo is refused before it is checked (`sourceBinding`).
  if (ref.kind === "url") return hasUserinfo(ref.url) ? undefined : normalizeUrl(ref.url);
  if (ref.kind === "doi") return doiUrl(ref.doi);
  return undefined;
}

/** The `cited` checks for a URL (or a DOI's resolver URL). */
async function citedUrl(run: Run, url: string): Promise<Reached | undefined> {
  const { sources } = run.config;
  const refused = hostRefusal(run, url);
  if (refused !== undefined) return refused;
  if (sources.resolve === "head" && levelRank(run.floor) <= levelRank("grounded")) {
    if (run.opts.resolveHead === undefined) {
      return fail(
        "none",
        "unresolved",
        "provability.sources.resolve is head, but no reachability check is wired here",
        { origin: url },
      );
    }
    const status = await headStatus(run, url);
    if (status === "budget") {
      return fail(
        "none",
        "unresolved",
        `not checked: this answer cites more than ${MAX_HEAD_REQUESTS} distinct URLs, the most one verification sends a HEAD to`,
        { origin: url },
      );
    }
    if (status === "deadline") {
      const ms = run.opts.headDeadlineMs ?? HEAD_DEADLINE_MS;
      return fail(
        "none",
        "unresolved",
        `not checked: this verification's HEAD requests ran past ${
          ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
        }, the longest it waits on them`,
        { origin: url },
      );
    }
    if (status === "egress") {
      return fail(
        "none",
        "unresolved",
        "not checked: the run's egress fabric refused to send a HEAD to this URL — it carries content a tool or another boundary handed the run (a secret it read, say), which the request would have taken out",
        { origin: url },
      );
    }
    if (status === undefined || status < 200 || status >= 400) {
      return fail(
        "none",
        "unresolved",
        status === undefined
          ? `HEAD ${url} got no answer`
          : `HEAD ${url} answered ${status}, not 2xx/3xx`,
        { origin: url },
      );
    }
  }
  return undefined;
}

/**
 * Directories under the workspace that are always the harness's own state
 * ({@link stateRootOf}); the caller names any others (`VerifyOptions.stateRoots`).
 */
const STATE_DIRS: readonly string[] = [".crewhaus", ".crewhaus-shared"];

/** A directory's real path, or its resolved path when it does not resolve. */
function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * The state directories one verification refuses path sources under: the
 * workspace's {@link STATE_DIRS} and the caller's `stateRoots`, each as
 * resolved and as its real path, so a link into one is caught too.
 */
function stateRootsOf(
  workspaceRoot: string,
  extra: ReadonlyArray<string> = [],
): Array<{ readonly dir: string; readonly shown: string }> {
  const named: Array<readonly [string, string]> = [
    ...STATE_DIRS.map((dir) => [`${dir}/`, path.join(workspaceRoot, dir)] as const),
    ...extra
      .filter((dir) => dir.trim() !== "")
      .map((dir) => [dir, path.resolve(workspaceRoot, dir)] as const),
  ];
  const out: Array<{ readonly dir: string; readonly shown: string }> = [];
  const seen = new Set<string>();
  for (const [shown, dir] of named) {
    for (const candidate of [dir, realDir(dir)]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push({ dir: candidate, shown });
    }
  }
  return out;
}

/**
 * The state directory a path source lies under, as the refusal names it, or
 * `undefined` (design §1: evidence is a source the run read, never what the
 * model said). A session log holds every answer verbatim (an
 * `assistant_message` line), a proof bundle every claim, memory what a
 * model stored: a `Read` of one returns the model's own earlier text, so a
 * claim it wrote once would ground in its own log — under default
 * permissions, with no write. The offline gate never reads a cited path
 * under these (`crewhaus provability check`); the run's gate must not
 * either. Read by the workspace-relative name and by the real path, so a
 * link into one is refused too.
 */
function stateRootOf(run: Run, rel: string, real: string): string | undefined {
  const first = rel.split("/")[0] ?? "";
  if (STATE_DIRS.includes(first)) return `${first}/`;
  // The path as the filesystem spells it: on a case-insensitive volume
  // (macOS by default) `.CREWHAUS/sessions/…` is the session log, and the
  // resolved path keeps the case the model typed. `realpathSync` returns
  // the on-disk spelling, so it is compared as well as the path given.
  const canonical = realDir(real);
  for (const root of run.stateRoots) {
    const under = root.dir.endsWith(path.sep) ? root.dir : `${root.dir}${path.sep}`;
    for (const candidate of canonical === real ? [real] : [real, canonical]) {
      if (candidate === root.dir || candidate.startsWith(under)) return root.shown;
    }
  }
  return undefined;
}

/** The `cited` checks for a workspace path: inside the workspace, links included, and there. */
function citedPath(
  run: Run,
  given: string,
): Reached | { readonly origin: string; readonly real: string } {
  const rel = normalizePath(given, { workspaceRoot: run.workspaceRoot, baseDir: run.baseDir });
  if (rel === undefined) {
    return fail("none", "path_outside_workspace", `${given} resolves outside the workspace`);
  }
  // The lexical check above cannot see a symlink inside the workspace that
  // leads out of it; the contained resolution follows every link the way the
  // kernel would and refuses one that leaves.
  const located = resolveContained(run.workspaceRoot, rel);
  if (!located.ok) {
    return located.code === "escapes-root"
      ? fail("none", "path_outside_workspace", `${given} leads outside the workspace`, {
          origin: rel,
        })
      : fail("none", "path_missing", `${given} cannot be resolved in the workspace`, {
          origin: rel,
        });
  }
  if (!existsSync(located.real)) {
    return fail("none", "path_missing", `${rel} does not exist in the workspace`, { origin: rel });
  }
  return { origin: rel, real: located.real };
}

function bodyOf(
  run: Run,
  record: EvidenceRecord,
): { readonly index: SourceIndex; readonly sha256: string } {
  let body = run.bodies.get(record);
  if (body === undefined) {
    const text = groundingBody(record);
    body = { index: indexSource(text), sha256: sha256Of(text) };
    run.bodies.set(record, body);
  }
  return body;
}

/**
 * A call's input as the echo test reads it, indexed once per run however
 * many claims ask: the URLs and paths it names its origins by
 * (`originFieldValues`), apart from every other string it carries.
 */
type CallInputs = {
  /** Every input string but the named addresses: text the call was handed. */
  readonly plain: readonly SourceIndex[];
  /** The URLs and paths the call was pointed at, as written. */
  readonly named: readonly SourceIndex[];
};

function callInputs(run: Run, record: EvidenceRecord): CallInputs {
  let inputs = run.inputs.get(record);
  if (inputs === undefined) {
    const values = originFieldValues(record, {
      workspaceRoot: run.workspaceRoot,
    }).filter((value) => value.trim() !== "");
    const pending = [...values];
    const plain: SourceIndex[] = [];
    // A builtin reader is asked only where its address is printed back:
    // the rest of its input (WebFetch's `prompt`, which `groundingBody`
    // already takes off) is not text the page could be reflecting, and a
    // page that states the claim in the words the model asked about must
    // still ground.
    if (!isReader(record.toolName)) {
      for (const value of inputStrings(record.input)) {
        const at = pending.indexOf(value);
        if (at !== -1) pending.splice(at, 1);
        else if (value.trim() !== "") plain.push(indexSource(value));
      }
    }
    inputs = { plain, named: values.map((value) => indexSource(value)) };
    run.inputs.set(record, inputs);
  }
  return inputs;
}

/** The locate options `grounded` reads a body with (see there). */
function locateOptions(run: Run): {
  readonly coverage: number;
  readonly windowTokens: number;
  readonly strictFigures: true;
} {
  const { coverage: bar, windowTokens } = run.config.grounded;
  return { coverage: bar, windowTokens, strictFigures: true };
}

/** The claim at its tightest ({@link tightestRuns}) in the span `location` reports of `index`. */
function spanRuns(run: Run, query: ClaimQuery, index: SourceIndex, location: Location): string[][] {
  let span = location.excerpt ?? "";
  if (span.endsWith("…")) {
    // The excerpt is cut at 240 characters; the test needs the span itself.
    const whole = locateClaim(query, index, {
      ...locateOptions(run),
      maxExcerptChars: MAX_ECHO_SPAN_CHARS,
    }).excerpt;
    if (whole !== undefined) span = whole;
  }
  const words = tokenize(foldTypography(span)).map((token) => token.norm);
  // A span still cut ends on a word that may be partial.
  if (span.endsWith("…")) words.pop();
  return tightestRuns(words, new Set(query.need.map(wordKey)));
}

/** `text` as a case-insensitive pattern of itself. */
function caseless(text: string, flags = ""): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), `i${flags}`);
}

/**
 * What a result prints of an address the call was pointed at, where that
 * printing can carry the claim's words (`need`): the whole address, found
 * as written, and the piece of it that spells two or more of the claim's
 * words at their tightest — a slug ("rust-is-faster-than-go", the path a
 * 404 page repeats). A slug spells words as no prose does; a piece spelled
 * with spaces (a path may have them) reads as prose too, so for one of
 * those only the whole address counts. Compared without case: a tool may
 * print the host as it normalized it.
 */
function printsOf(index: SourceIndex, need: ReadonlySet<string>, body: string): string[] {
  const shown = [index.text];
  for (const [from, to] of tightestWindows(
    index.tokens.map((token) => wordKey(token.norm)),
    need,
  )) {
    if (to === from) continue;
    const first = index.tokens[from] as SourceToken;
    const last = index.tokens[to] as SourceToken;
    const piece = index.text.slice(first.at, last.at + last.raw.length);
    if (!/\s/.test(piece) && !shown.includes(piece)) shown.push(piece);
  }
  return shown.filter((text) => text.trim() !== "" && caseless(text).test(body));
}

/** A body with every printing of `prints` blanked out, offsets kept: indexed once per run. */
function maskedIndex(run: Run, index: SourceIndex, prints: readonly string[]): SourceIndex {
  let byPrints = run.masked.get(index);
  if (byPrints === undefined) {
    byPrints = new Map();
    run.masked.set(index, byPrints);
  }
  const key = prints.join("\u0000");
  let masked = byPrints.get(key);
  if (masked === undefined) {
    let text = index.text;
    for (const shown of prints) {
      text = text.replace(caseless(shown, "g"), (match) => " ".repeat(match.length));
    }
    masked = indexSource(text);
    byPrints.set(key, masked);
  }
  return masked;
}

/**
 * Is the span of `record` that carries the claim the call's own input
 * handed back (design §10)? `"echo"` when it is; otherwise the location to
 * read the record by — `location` itself, or the claim located again with
 * an address the result prints blanked out (see below).
 *
 * The evidence index drops a result, or a JSON hit, that is WHOLLY an echo
 * of its input (`echoesInput`). A tool the gate cannot see into (an MCP
 * server's, a plugin's) can still reflect the model's text padded with
 * anything else — a SELECT that appends computed hex or a real row to a
 * literal sentence, a linter that repeats a `<title>` inside a report —
 * and the claim then "grounds" in words the model wrote, under an origin it
 * named and never read. So the claim at its tightest inside the span the
 * locate kernel found ({@link tightestRuns}) is looked for, word for word,
 * in each of the call's input strings; found, it is the model's text, not
 * the source's.
 *
 * The URL or path the call was pointed at (`originFieldValues`) is read
 * apart. Its slug can spell the claim the page states ("…/rust-is-faster-
 * than-go"), and a fetcher returns the page, not its address, so the
 * address counts only where the result prints it ({@link printsOf}): a
 * 404 page that echoes the requested path, a report headed with the URL.
 * Then the claim is looked for again with that printing blanked out: a
 * page that carries the claim in its own text beside its printed address
 * still grounds there, and one that carries it only in the address is the
 * address handed back.
 *
 * The builtin readers (`WebFetch`, `Fetch`, `Read`) return the content of
 * what they were pointed at, so only their address is asked about: a page
 * whose slug spells the claim grounds in its own text, and one that holds
 * the claim only where it prints its address — a 404 page that repeats the
 * path, a page headed with its URL — does not. Other builtins are not asked
 * at all (their input names no origin), nor is Retrieve (tool-categories
 * does not list it), which returns corpus text, never its query. A search
 * hit whose claim-bearing run is a phrase the model searched for word for
 * word is refused as well — the gate cannot tell that from a reflection,
 * and fetching the page grounds it. What stays open is reflected text the
 * tool rewrites on the way out (an SQL function applied to the literal, an
 * address printed re-spelled): closing that needs the spec to say which
 * tools' hits are trusted — a design decision, not made here.
 *
 * An MCP server's result is asked once more ({@link storedText}): a server
 * with storage hands back what an EARLIER call wrote to it.
 */
function echoCheck(
  run: Run,
  record: EvidenceRecord,
  query: ClaimQuery,
  index: SourceIndex,
  location: Location,
): EchoRead {
  const kept = { location, index };
  if (record.toolName === RETRIEVE) return kept;
  if (builtinKey(record.toolName) !== undefined && !isReader(record.toolName)) return kept;
  const read = sameCallEcho(run, record, query, index, location);
  return read === "echo" || !isMcpTool(record.toolName)
    ? read
    : storedText(run, record, query, read);
}

/** What {@link echoCheck} makes of a record that carries the claim. */
type EchoRead =
  /** Read it by this location (the claim may have moved off a printed address). */
  | { readonly location: Location; readonly index: SourceIndex }
  /** The call's own input, handed back. */
  | "echo"
  /** Text an earlier call of the run sent, handed back by a store ({@link storedText}). */
  | { readonly storedBy: EvidenceRecord }
  /** Not checked: the grounding budget ran out on the way. */
  | "unread";

/** {@link echoCheck}'s test of the call's own input (see there). */
function sameCallEcho(
  run: Run,
  record: EvidenceRecord,
  query: ClaimQuery,
  index: SourceIndex,
  location: Location,
): { readonly location: Location; readonly index: SourceIndex } | "echo" {
  const kept = { location, index };
  const { plain, named } = callInputs(run, record);
  const need = new Set(query.need.map(wordKey));
  // Nothing to ask when no input string was handed over and no address
  // the call was pointed at holds a word of the claim (a reader's usual
  // case: the page is read once, not again for its address).
  if (
    plain.length === 0 &&
    !named.some((one) => one.tokens.some((token) => need.has(wordKey(token.norm))))
  ) {
    return kept;
  }
  const handedBack = (words: readonly string[]): boolean =>
    plain.some((input) => findSequence(input, words) !== -1);
  const runs = spanRuns(run, query, index, location);
  if (runs.length === 0) return kept;
  if (runs.every(handedBack)) return "echo";
  // An address counts only where the result prints it, and only when the
  // claim at its tightest is in the address at all.
  const prints = named
    .filter((one) => runs.some((words) => findSequence(one, words) !== -1))
    .flatMap((one) => printsOf(one, need, index.text));
  if (prints.length === 0) return kept;
  // Blank the printing out and read the result again: what carries the
  // claim now is the page's own text, or the claim was only ever in the
  // address handed back.
  const masked = maskedIndex(run, index, prints);
  const again = locateClaim(query, masked, locateOptions(run));
  if (again.status === "polarityConflict") return { location: again, index: masked };
  if (again.status !== "supported" && !isWaivableMiss(again)) return "echo";
  const rest = spanRuns(run, query, masked, again);
  return rest.length > 0 && rest.every(handedBack) ? "echo" : { location: again, index: masked };
}

/**
 * The text each call of the run sent, in the order the calls were made
 * (`EvidenceIndex.all`, a child's calls where it ran): every string its
 * input carries but the URL or path it was pointed at (`originFieldValues`
 * — a fetcher's slug is not text it was handed). Built once per
 * verification; a call's strings are indexed when first asked for.
 */
type SentText = {
  /** Each call's place in that order, by its session and id. */
  readonly position: ReadonlyMap<string, number>;
  readonly calls: ReadonlyArray<EvidenceRecord>;
  /** Each call's strings, indexed, with the words each holds (a run missing one is not in it). */
  readonly strings: Map<
    number,
    ReadonlyArray<{ readonly index: SourceIndex; readonly words: ReadonlySet<string> }>
  >;
};

/** A call's session and id: one call, whichever view of it (a hit's included) is asked. */
const callOf = (record: EvidenceRecord): string =>
  `${record.sessionId ?? ""}\u0000${record.toolUseId}`;

function sentText(run: Run): SentText {
  if (run.sent === undefined) {
    // Every call the index holds, whatever `turnNumbers` keeps: text sent in
    // an earlier turn and read back in this one is still the run's own.
    const calls = run.opts.evidence.all();
    const position = new Map<string, number>();
    calls.forEach((call, i) => {
      if (!position.has(callOf(call))) position.set(callOf(call), i);
    });
    run.sent = { position, calls, strings: new Map() };
  }
  return run.sent;
}

/**
 * One call's sent strings, indexed the first time any claim asks — and
 * counted against the grounding budget then, once, as a body read is.
 */
function sentStrings(
  run: Run,
  sent: SentText,
  at: number,
): ReadonlyArray<{ readonly index: SourceIndex; readonly words: ReadonlySet<string> }> {
  let strings = sent.strings.get(at);
  if (strings === undefined) {
    const call = sent.calls[at] as EvidenceRecord;
    const pending = originFieldValues(call, {
      workspaceRoot: run.workspaceRoot,
    });
    const out: Array<{ index: SourceIndex; words: ReadonlySet<string> }> = [];
    for (const value of inputStrings(call.input)) {
      const named = pending.indexOf(value);
      if (named !== -1) pending.splice(named, 1);
      else if (value.trim() !== "") {
        const index = indexSource(value);
        run.groundingTokens += index.tokens.length;
        out.push({ index, words: new Set(index.tokens.map((token) => token.norm)) });
      }
    }
    strings = out;
    sent.strings.set(at, strings);
  }
  return strings;
}

/**
 * Is the claim, in an MCP server's result, text an EARLIER call of the run
 * sent (design §5.2: MCP bodies are evidence because they were fetched; §0
 * A)? A server with storage — SQL, a key-value or notes store, a vector
 * index — hands back what was written to it, and the same-call test cannot
 * see that: `write_query` stores `('https://acme.example/policy', 'The
 * refund window is 30 days …')`, `read_query` returns it as a `{url, text}`
 * hit, and the model's own sentence grounds under a page nobody fetched. So
 * the claim at its tightest in the span that carries it
 * ({@link tightestRuns}) is looked for, word for word, in what every
 * earlier call sent; found, every run of it, it is the model's text stored
 * and read back — `{ storedBy }`, the call that sent it. Only earlier
 * calls: a page the run read and then summarised in its notes is still the
 * page. Which earlier calls depends on how the claim reached its URL:
 *
 * - under a URL or path the call's input named (`mcp__fetch__fetch {url}`),
 *   only text sent to the same server (`mcp__<server>__`): a store hands
 *   back what was written to IT, and text the run merely sent elsewhere —
 *   the draft given to `ProvabilityPreflight`, an exact phrase searched for,
 *   a comment posted to another server — is not what the page says.
 *   Counting those refused an honest page fetched over MCP as "never read",
 *   in the designed preflight-then-fetch flow. Text another tool WROTE to
 *   that very URL or path — a PUT to it, a `Write` of the file a file
 *   server then reads — is the page now, and the run's own: {@link writtenBy}
 *   marks the binding, as for a builtin reader;
 * - under a hit the result carried (a JSON row's `url`), text sent by any
 *   call but the preflight, which writes nowhere: the row is whatever the
 *   server keeps, and a file `Write` saved is what a filesystem server reads.
 *
 * What stays open is a row stored before the evidence this verification is
 * handed begins — by an earlier session, or by an earlier turn when the
 * caller hands a turn-only index rather than the session's with
 * `turnNumbers` (the gate and its preflight hand the latter): no call in it
 * sent the text. Closing that needs the spec to say
 * which MCP tools return sources (a design decision; the README names the
 * residual). The words read here count against the grounding budget
 * ({@link MAX_GROUNDING_TOKENS}); past it the record is `"unread"`, not
 * grounded.
 */
function storedText(
  run: Run,
  record: EvidenceRecord,
  query: ClaimQuery,
  read: { readonly location: Location; readonly index: SourceIndex },
): EchoRead {
  const sent = sentText(run);
  const at = sent.position.get(callOf(record)) ?? 0;
  if (at === 0) return read;
  const server = mcpServerOf(record.toolName);
  // A hit is a view of the call (`hitView`): its own text, under an origin
  // the result carried rather than one the input named.
  const hit = isHitView(run, record);
  const sentHere = (call: EvidenceRecord): boolean =>
    hit ? call.toolName !== PROVABILITY_PREFLIGHT : mcpServerOf(call.toolName) === server;
  const runs = spanRuns(run, query, read.index, read.location);
  if (runs.length === 0) return read;
  let by: EvidenceRecord | undefined;
  for (const words of runs) {
    let found = false;
    for (let i = 0; i < at && !found; i++) {
      if (!sentHere(sent.calls[i] as EvidenceRecord)) continue;
      for (const held of sentStrings(run, sent, i)) {
        if (run.groundingTokens >= groundingBudget) return "unread";
        // A string missing one of the run's words cannot hold it: only a
        // string that has them all is read through.
        if (!words.every((word) => held.words.has(word))) continue;
        run.groundingTokens += held.index.tokens.length;
        if (findSequence(held.index, words) !== -1) {
          found = true;
          by ??= sent.calls[i];
          break;
        }
      }
    }
    if (!found) return read;
  }
  return by !== undefined ? { storedBy: by } : read;
}

/** How many copy or move steps {@link provenanceOf} follows back from the places a body was read from. */
const MAX_WRITE_HOPS = 4;
/** How many places one read's text may be followed back through. */
const MAX_WRITE_ORIGINS = 32;

/** The places call `at` of {@link SentText} may have written, or copied from (`writtenPlaces`), read once. */
function writesOf(run: Run, sent: SentText, at: number): readonly WrittenPlace[] {
  run.writes ??= new Map();
  let named = run.writes.get(at);
  if (named === undefined) {
    const call = sent.calls[at] as EvidenceRecord;
    // Measured as the evidence index measures a reader's path: from the
    // workspace root, where the tools resolve one.
    named = writtenPlaces(call.toolName, call.input, { workspaceRoot: run.workspaceRoot });
    run.writes.set(at, named);
  }
  return named;
}

/**
 * What one call put where it wrote ({@link wroteOf}): every string it sent
 * but the places it named, indexed (the "one string holds the claim" test),
 * the strings its content fields carry, as token lists (`writtenText`), and
 * the words it INTRODUCED — those it added and did not replace, by
 * {@link wordKey} — that carry content: a figure, or a word of three letters
 * or more that is no stopword.
 */
type Wrote = {
  readonly strings: ReadonlyArray<SourceIndex>;
  readonly added: ReadonlyArray<readonly string[]>;
  /** The texts it replaced (an `Edit`'s `oldString`, a diff's `-` lines), as words. */
  readonly removed: ReadonlyArray<readonly string[]>;
  /** Each line it added that carries content, as {@link wordKey}s: where in a body it put words. */
  readonly lines: ReadonlyArray<readonly string[]>;
  readonly introduced: ReadonlySet<string>;
};

/** A word that carries content, for the introduced-words test: a figure, or a non-stopword of three letters or more. */
const carriesContent = (word: string): boolean =>
  figureKey(word) !== null || (word.length >= 3 && !STOPWORDS.has(word) && /\p{L}/u.test(word));

/** The words of a text as the locate kernel normalizes them. */
const wordsOf = (text: string): string[] =>
  tokenize(foldTypography(text)).map((token) => token.norm);

/** What call `at` of {@link SentText} put where it wrote, read once and counted against the grounding budget. */
function wroteOf(run: Run, sent: SentText, at: number): Wrote {
  run.wrote ??= new Map();
  let wrote = run.wrote.get(at);
  if (wrote === undefined) {
    const call = sent.calls[at] as EvidenceRecord;
    const places = new Set(writesOf(run, sent, at).map((one) => one.place));
    const strings: SourceIndex[] = [];
    for (const value of inputStrings(call.input)) {
      if (value.trim() === "") continue;
      const trimmed = value.trim();
      const place = /^https?:\/\//i.test(trimmed)
        ? normalizeUrl(trimmed)
        : normalizePath(trimmed, { workspaceRoot: run.workspaceRoot });
      if (place !== undefined && places.has(place)) continue;
      const index = indexSource(value);
      run.groundingTokens += index.tokens.length;
      strings.push(index);
    }
    const text = writtenText(call.input);
    const added = text.added.map(wordsOf);
    const removedWords = text.removed.map(wordsOf);
    const removed = new Set(removedWords.flat().map(wordKey));
    const introduced = new Set<string>();
    for (const words of added) {
      run.groundingTokens += words.length;
      for (const word of words) {
        const key = wordKey(word);
        if (carriesContent(word) && !removed.has(key)) introduced.add(key);
      }
    }
    const lines: string[][] = [];
    for (const one of text.added) {
      for (const line of one.split(/\r\n|[\n\r\u2028\u2029\u0085]/)) {
        const words = wordsOf(line);
        if (words.some(carriesContent)) lines.push(words.map(wordKey));
      }
    }
    wrote = { strings, added, removed: removedWords, lines, introduced };
    run.wrote.set(at, wrote);
  }
  return wrote;
}

/** `origin` relative to `place` (`""` when they are one, `/rest` when it lies beneath it), else `undefined`. */
function beneathOf(origin: string, place: string): string | undefined {
  if (origin === place) return "";
  return origin.startsWith(`${place}/`) ? origin.slice(place.length) : undefined;
}

/**
 * What the run did, before a body was read, to the places it was read from
 * (design §10, §1): the writers into them, and the state root a copy
 * brought the text here from, if one did.
 */
type Provenance = {
  /** The places in {@link SentText} of the calls that wrote into those places, or into one a copy then brought here. */
  readonly into: readonly number[];
  /** A place under the harness's own state that a copy, a move, a concatenation or an archive brought the text here from. */
  readonly state?: {
    readonly place: string;
    readonly shown: string;
    /** The call that brought it here — or, for a place the read itself was pointed at, the read. */
    readonly via: EvidenceRecord;
    readonly copied: boolean;
  };
};

/** {@link Provenance}'s `state`: a place under a state root the text was brought here from. */
type StateCopy = NonNullable<Provenance["state"]>;

/** Why a body under `origin` that a copy brought out of the harness's own state is no source (§1). */
function stateCopyDetail(origin: string, state: StateCopy): string {
  const brought = state.copied
    ? `${state.via.toolUseId} (${state.via.toolName}) copied ${state.place} there`
    : `${state.via.toolUseId} (${state.via.toolName}) was pointed at ${state.place}`;
  return `${origin} is no source: what this run read under it came from ${state.place}, under ${state.shown}, the harness's own state — ${brought}; session logs, proof bundles, spilled results and memory hold the model's own text, so nothing there, or copied from there, is a source; cite the source itself`;
}

/** Is `record` a view of one hit of a call (`hitView`): its own text, under an origin the result carried? */
function isHitView(run: Run, record: EvidenceRecord): boolean {
  const sent = sentText(run);
  const at = sent.position.get(callOf(record));
  if (at === undefined) return false;
  const whole = sent.calls[at] as EvidenceRecord;
  return (
    record !== whole &&
    (record.content !== whole.content ||
      record.origins.some((origin) => !whole.origins.includes(origin)))
  );
}

/**
 * The places a body under `origin` was read from: the origin itself and,
 * for a call an MCP server answered, every place its input pointed at,
 * declared or not (`inputPlaces`) — a file server handed the session log's
 * path read the session log, whatever address the body was then indexed
 * under.
 */
function readPlaces(run: Run, record: EvidenceRecord, origin: string): string[] {
  const places = [origin];
  if (isMcpTool(record.toolName) && !isHitView(run, record)) {
    for (const place of inputPlaces(record.toolName, record.input, {
      workspaceRoot: run.workspaceRoot,
    })) {
      if (!places.includes(place)) places.push(place);
    }
  }
  return places;
}

/**
 * What the run did to `places` before `record` read them ({@link Provenance}),
 * read once per read and places. The calls that may have written
 * (`writtenPlaces`: not a reader, not the preflight, not a pure tool —
 * `VerifyOptions.isPureTool` — and not one that errored) are read back from
 * the read, through every copy, move, concatenation and archive that
 * brought text to one of the places from somewhere else (a directory copied
 * whole maps each file beneath it; at most {@link MAX_WRITE_HOPS} steps):
 *
 * - a place the trail reaches under a state root (`stateRootOf`) is a copy
 *   of the harness's own state — a session log copied into the workspace
 *   holds every answer verbatim, the one the gate just refused among them —
 *   and is `state`, with the call that brought it here;
 * - a call that wrote into a place on the trail (or into a directory one
 *   lies beneath) is `into`, for the self-written test ({@link selfWriter}).
 */
function provenanceOf(run: Run, record: EvidenceRecord, places: readonly string[]): Provenance {
  const key = `${callOf(record)}\u0000${places.join("\u0000")}`;
  run.provenances ??= new Map();
  const known = run.provenances.get(key);
  if (known !== undefined) return known;
  const sent = sentText(run);
  const at = sent.position.get(callOf(record)) ?? 0;
  if (run.writers === undefined) {
    const all: number[] = [];
    sent.calls.forEach((call, i) => {
      if (call.isError || isPure(run, call.toolName)) return;
      if (writesOf(run, sent, i).some((one) => !one.source)) all.push(i);
    });
    run.writers = all;
  }
  const writers = run.writers.filter((i) => i < at);
  // Every place the text could have come here from, and the copy that brought it.
  const trail = new Map<string, number | undefined>(places.map((place) => [place, undefined]));
  for (let hop = 0; hop < MAX_WRITE_HOPS && trail.size < MAX_WRITE_ORIGINS; hop++) {
    const before = trail.size;
    for (const i of writers) {
      const named = writesOf(run, sent, i);
      const sources = named.filter((one) => one.source);
      if (sources.length === 0) continue;
      for (const place of [...trail.keys()]) {
        for (const target of named) {
          if (target.source) continue;
          const rest = beneathOf(place, target.place);
          if (rest === undefined) continue;
          for (const from of sources) {
            const copied = `${from.place}${rest}`;
            if (!trail.has(copied) && trail.size < MAX_WRITE_ORIGINS) trail.set(copied, i);
          }
        }
      }
    }
    if (trail.size === before) break;
  }
  let state: Provenance["state"];
  for (const [place, via] of trail) {
    if (/^https?:\/\//i.test(place)) continue;
    const shown = stateRootOf(run, place, path.resolve(run.workspaceRoot, place));
    if (shown === undefined) continue;
    // The record's own place is the citation's question (`sourceBinding`
    // refuses it there); here, a copy of one, or a place an MCP call was
    // pointed at beside the origin it is indexed under.
    state =
      via !== undefined
        ? { place, shown, via: sent.calls[via] as EvidenceRecord, copied: true }
        : { place, shown, via: record, copied: false };
    break;
  }
  const into = writers.filter((i) =>
    writesOf(run, sent, i).some(
      (one) =>
        !one.source && [...trail.keys()].some((place) => beneathOf(place, one.place) !== undefined),
    ),
  );
  const provenance: Provenance = { into, ...(state !== undefined ? { state } : {}) };
  run.provenances.set(key, provenance);
  return provenance;
}

/** Does `words` hold `run` as one contiguous stretch? */
function holdsRun(words: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0 || run.length > words.length) return false;
  outer: for (let i = 0; i + run.length <= words.length; i++) {
    for (let j = 0; j < run.length; j++) if (words[i + j] !== run[j]) continue outer;
    return true;
  }
  return false;
}

/** Where each word of a body stands, by {@link wordKey}: read once per body. */
const KEY_POSITIONS = new WeakMap<SourceIndex, Map<string, number[]>>();

function keyPositions(index: SourceIndex): Map<string, number[]> {
  let positions = KEY_POSITIONS.get(index);
  if (positions === undefined) {
    positions = new Map();
    index.tokens.forEach((token, at) => {
      const key = wordKey(token.norm);
      const list = (positions as Map<string, number[]>).get(key);
      if (list === undefined) (positions as Map<string, number[]>).set(key, [at]);
      else list.push(at);
    });
    KEY_POSITIONS.set(index, positions);
  }
  return positions;
}

/** How many places {@link startsOf} reports, and how many first-word hits it tries. */
const MAX_STARTS = 64;
const MAX_START_TRIES = 4_096;

/** The token offsets in `index` where `keys` stands whole, at most {@link MAX_STARTS}. */
function startsOf(index: SourceIndex, keys: readonly string[]): number[] {
  const first = keys[0];
  if (first === undefined) return [];
  const out: number[] = [];
  const at = keyPositions(index).get(first) ?? [];
  for (const start of at.slice(0, MAX_START_TRIES)) {
    if (start + keys.length > index.tokens.length) break;
    let whole = true;
    for (let j = 1; j < keys.length && whole; j++) {
      whole = wordKey((index.tokens[start + j] as SourceToken).norm) === keys[j];
    }
    if (whole) out.push(start);
    if (out.length >= MAX_STARTS) break;
  }
  return out;
}

/**
 * Do `run` and `line` share a stretch of at least `min(|line|, 3)` words
 * that holds a word `introduced` has? For a line no longer in the body as
 * written (a later edit changed it, a read of part of the file): a word it
 * shares with the claim in passing ("refund" in an appended "For any refund
 * question, email support.") is not where it put the claim.
 */
function sharesStretch(
  run: readonly string[],
  line: readonly string[],
  introduced: ReadonlySet<string>,
): boolean {
  const need = Math.min(line.length, 3);
  for (let i = 0; i < run.length; i++) {
    for (let j = 0; j < line.length; j++) {
      let k = 0;
      let added = false;
      while (i + k < run.length && j + k < line.length && run[i + k] === line[j + k]) {
        if (introduced.has(run[i + k] as string)) added = true;
        k++;
      }
      if (k >= need && added) return true;
    }
  }
  return false;
}

/**
 * Which calls of `into` INTRODUCED a word of the claim's run `keys` where
 * the run stands in `index` (the body it grounded in). Located, not
 * counted: a place the run stands in the body is a call's when it overlaps
 * a line the call added there with one of its introduced words inside the
 * overlap — so an `Edit` of `14` to `30` in the sentence is the run's, and
 * an unrelated line it appended that shares a topic word with the claim
 * ("For any refund question, email support." under "The refund window is
 * 14 days…") is not. A line not in the body as written counts by
 * {@link sharesStretch}; so does every line where the run itself is not
 * found in `index`. `every`: the calls that put it at every place it
 * stands; `union`: the first call of those that, together, did — or
 * `undefined` when a place it stands is text no call wrote.
 */
function introducedBy(
  run: Run,
  sent: SentText,
  into: readonly number[],
  index: SourceIndex,
  keys: readonly string[],
): { readonly every: ReadonlySet<number>; readonly union: number | undefined } {
  const places = startsOf(index, keys);
  const covers = (i: number, place: number | undefined): boolean => {
    const wrote = wroteOf(run, sent, i);
    // Only a line holding a word of the run the call introduced can overlap it with one.
    const wanted = new Set(keys.filter((key) => wrote.introduced.has(key)));
    if (wanted.size === 0) return false;
    for (const line of wrote.lines) {
      if (!line.some((key) => wanted.has(key))) continue;
      const at = place === undefined ? [] : startsOf(index, line);
      if (at.length === 0) {
        if (sharesStretch(keys, line, wrote.introduced)) return true;
        continue;
      }
      for (const start of at) {
        const from = Math.max(place as number, start);
        const to = Math.min((place as number) + keys.length, start + line.length);
        for (let k = from; k < to; k++) {
          if (wanted.has(wordKey((index.tokens[k] as SourceToken).norm))) return true;
        }
      }
    }
    return false;
  };
  const every = new Set(into);
  let union: number | undefined;
  for (const place of places.length > 0 ? places : [undefined]) {
    const by = into.filter((i) => covers(i, place));
    for (const i of [...every]) if (!by.includes(i)) every.delete(i);
    if (by.length === 0) return { every, union: undefined };
    union = Math.min(union ?? Number.POSITIVE_INFINITY, ...by);
  }
  return { every, union };
}

/**
 * The first call of `into` that wrote the claim's words where they were
 * read, or `undefined` (design §10): each tightest run of the claim
 * (`runs`, found in `index`, the body that grounded it) must be text one of
 * them put there — by one of three tests, so that the commonest way a run
 * changes a fact in a file, an `Edit` of part of a sentence, is the run's
 * own:
 *
 * - one string the call sent holds the run whole (a `Write` of the
 *   sentence, a PUT of the page), and no text it replaced did (an `Edit`
 *   whose `oldString` already said it kept the sentence, not wrote it);
 * - where the run stands in the body, it overlaps a line the call added
 *   with a word the call INTRODUCED ({@link Wrote}, {@link introducedBy}):
 *   an `Edit` of `14` to `30`, a placeholder later filled in, a sentence
 *   finished by an `AppendFile`, a diff's `+` line;
 * - the run holds, whole, a text the call put there that carries content:
 *   an `Edit` that only took a word out ("is not refundable" → "is
 *   refundable").
 *
 * A claim that also stands, as tightly, in text no call put there (a tie
 * the run did not write) is not the run's. Past the grounding budget,
 * nothing is.
 */
function selfWriter(
  run: Run,
  into: readonly number[],
  runs: readonly (readonly string[])[],
  index: SourceIndex,
): EvidenceRecord | undefined {
  if (into.length === 0 || runs.length === 0) return undefined;
  const sent = sentText(run);
  let by: number | undefined;
  for (const words of runs) {
    const keys = words.map(wordKey);
    const introduced = introducedBy(run, sent, into, index, keys);
    let found: number | undefined;
    for (const i of into) {
      if (run.groundingTokens >= groundingBudget) return undefined;
      const wrote = wroteOf(run, sent, i);
      const put =
        (wrote.strings.some((held) => findSequence(held, words) !== -1) &&
          !wrote.removed.some((gone) => holdsRun(gone, words))) ||
        introduced.every.has(i) ||
        wrote.added.some((added) => added.some(carriesContent) && holdsRun(words, added));
      if (put) {
        found = i;
        break;
      }
    }
    found ??= introduced.union;
    if (run.groundingTokens >= groundingBudget) return undefined;
    if (found === undefined) return undefined;
    by = by === undefined ? found : Math.min(by, found);
  }
  return by !== undefined ? (sent.calls[by] as EvidenceRecord) : undefined;
}

/**
 * Did the run write, itself, the text that grounds a claim in a body read
 * from `origin` (design §10's residual: "a model that fetches a page it
 * wrote itself")? The call that did, or `undefined`.
 *
 * A `Read` returns the file as it is when read, so a claim the model put
 * there with `Write` or `Edit` grounds like any other — and should: an
 * agent that sets `timeout: 30` in a config and then reports it reports the
 * truth. But the run is then its own source, and the bundle says so rather
 * than letting the ✓ read as an outside source's (`ProofBinding.writtenBy`;
 * the footer counts it, `provability audit` lists it). Decided per origin,
 * not per call: the calls that wrote into the places the body was read from
 * before it was read ({@link provenanceOf}) are asked whether the claim at
 * its tightest in the span that grounded it ({@link spanRuns}) is text they
 * put there ({@link selfWriter}). A read made before any of them that
 * grounds the claim does so unmarked (`grounded` reads the origin's records
 * in call order and stops at the first unmarked one).
 *
 * Asked of the builtin readers and of an MCP call whose own input named the
 * origin (`mcp__fetch__fetch {url}` after a PUT to that URL, a file server's
 * `read_file` of a file `Write` saved); a hit an MCP result carried is
 * {@link storedText}'s (refused there, not marked), and Retrieve returns the
 * operator's corpus. What stays open: text written by `Bash` or
 * `RunCommand` (a command line names no field this reads), by a call that
 * names the place in a form this cannot map to the cited one (a repository
 * path behind a raw-file URL), or by an earlier session; and past the
 * grounding budget nothing is marked.
 */
function writtenBy(
  run: Run,
  record: EvidenceRecord,
  provenance: Provenance,
  query: ClaimQuery,
  index: SourceIndex,
  location: Location,
): EvidenceRecord | undefined {
  if (provenance.into.length === 0) return undefined;
  if (!isReader(record.toolName) && !(isMcpTool(record.toolName) && !isHitView(run, record))) {
    return undefined;
  }
  return selfWriter(run, provenance.into, spanRuns(run, query, index, location), index);
}

/** The server an MCP tool is served by (`mcp__<server>__<tool>`), lowercased; `undefined` for any other tool. */
function mcpServerOf(name: string): string | undefined {
  return /^mcp__(.+?)__/i.exec(name)?.[1]?.toLowerCase();
}

/** A word as the figure rule compares it: a figure by its value (`thirty` is `30`). */
const wordKey = (word: string): string => figureKey(word) ?? word;

/**
 * The claim at its tightest inside the span the locate kernel reported:
 * every shortest run of `words` holding each of the claim's words (`need`,
 * by {@link wordKey}) that `words` holds at all (claim-ledger's
 * `tightestWindows`). The reported span runs from the first claim word in
 * the winning window to the last, so it can open on a stray copy of one
 * word (the "flu" of a URL a report prints before echoing a `<title>`) and
 * no longer be the reflection it mostly is; the tightest run is the
 * reflection itself. Every tie is returned, so a claim that also stands, as
 * tightly, in text the tool did not reflect is not refused for the copy it
 * did.
 */
function tightestRuns(words: readonly string[], need: ReadonlySet<string>): string[][] {
  return tightestWindows(words.map(wordKey), need).map(([from, to]) => words.slice(from, to + 1));
}

/**
 * The excerpt a grounded binding freezes (design §5.3): the claim at its
 * tightest ({@link tightestWindows}) in the span the locate kernel reported,
 * with what is around it — the span itself when it fits in
 * {@link MAX_EXCERPT_CHARS}. The kernel's span runs from the first claim
 * word in the winning window to the last and is cut from its start, so a
 * span that opens on a stray early copy of one word ("Refund policy" in a
 * heading, the figure 200 tokens on) froze the heading and lost the
 * figure. Where even the tightest run is too long, the excerpt is centred
 * on the claim's first figure in it, which is what a reader checks first.
 */
function groundedExcerpt(
  run: Run,
  query: ClaimQuery,
  index: SourceIndex,
  location: Location,
): string | undefined {
  let span = location.excerpt;
  if (span === undefined) return undefined;
  if (!span.endsWith("…") && span.length <= MAX_EXCERPT_CHARS) return span;
  if (span.endsWith("…")) {
    span =
      locateClaim(query, index, { ...locateOptions(run), maxExcerptChars: MAX_ECHO_SPAN_CHARS })
        .excerpt ?? span;
  }
  const words = indexSource(span);
  const tokens = words.tokens;
  const window = tightestWindows(
    tokens.map((token) => wordKey(token.norm)),
    new Set(query.need.map(wordKey)),
  )[0];
  if (window === undefined) return clip(span, MAX_EXCERPT_CHARS);
  const [first, last] = window;
  let from = (tokens[first] as SourceToken).at;
  let to = (tokens[last] as SourceToken).at + (tokens[last] as SourceToken).raw.length;
  if (to - from > MAX_EXCERPT_CHARS) {
    const figures = new Set(query.figures.map(wordKey));
    for (let i = first; i <= last; i++) {
      const token = tokens[i] as SourceToken;
      if (!figures.has(wordKey(token.norm))) continue;
      from = token.at;
      to = token.at + token.raw.length;
      break;
    }
  }
  // Cut from the span as written, not its folded twin the tokens index: an
  // excerpt of "… هي ٣٠ يوما" says ٣٠ (design §5.3).
  const cut = writtenSpan(words, from, to);
  return clipAround(cut.text, cut.from, cut.to, MAX_EXCERPT_CHARS);
}

/** A source binding as `grounded` leaves it, and the paraphrase miss the judge may still waive. */
type SourceOutcome = { readonly reached: Reached; readonly waivable?: Waivable };

/** The URL `record`'s body was served from (`servedFrom`), read once per verification. */
function servedOf(run: Run, record: EvidenceRecord): string | undefined {
  if (!run.served.has(record)) run.served.set(record, servedFrom(record));
  return run.served.get(record);
}

/**
 * Why a body found under `origin` may not stand for it: the fetch was
 * redirected (`servedFrom`), and the host that SERVED the body fails the
 * checks a redirect hop is held to — `sources.deny` and the private-address
 * rule, as `resolve: head` holds every hop (evaluation-service `hopPolicy`).
 * Not `sources.allow`: that names what may be cited, so a `doi.org`
 * citation still grounds in the publisher it redirects to (design §3, §10:
 * the host lists are a security allowlist). `undefined` when it may.
 */
function servedRefusal(
  run: Run,
  origin: string,
  record: EvidenceRecord,
): { readonly reason: UnmetReason; readonly detail: string } | undefined {
  const served = servedOf(run, record);
  if (served === undefined || served === origin) return undefined;
  const host = hostOf(served) ?? "";
  const { deny } = run.config.sources;
  if (deny.length > 0 && hostMatches(host, deny)) {
    return {
      reason: "host_denied",
      detail: `${origin} redirected to ${host} when ${record.toolUseId} fetched it, and ${host} matches provability.sources.deny — the body is that host's`,
    };
  }
  if (isPrivateHost(host)) {
    return {
      reason: "private_address",
      detail: `${origin} redirected to ${host} when ${record.toolUseId} fetched it — a loopback, private or link-local address, not a public source`,
    };
  }
  return undefined;
}

/** A grounded binding's place in {@link Run.bodyKeys}: the body it read, under the origin it cited. */
const groundedAs = (sha256: string, origin: string): string => `${sha256}\u0000${origin}`;

/**
 * What `grounded.independent` counts a body found under `origin` as (design
 * §6.2: n distinct origins): the {@link independenceKey} of the URL that
 * served it, or of `origin` itself when nothing redirected — kept by the
 * body's digest and `origin`, which every binding that grounds there
 * carries. A page cited once directly and once through a shortener that
 * redirects to it, or a DOI and its publisher's URL, is one origin, not
 * two: both bodies were served by one host.
 */
function bodyKey(run: Run, record: EvidenceRecord, origin: string, sha256: string): string {
  const at = groundedAs(sha256, origin);
  let key = run.bodyKeys.get(at);
  if (key === undefined) {
    key = independenceKey(servedOf(run, record) ?? origin);
    run.bodyKeys.set(at, key);
  }
  return key;
}

/**
 * The `grounded` check: the origin was read in this run, and the claim's
 * words are in it. A body is a record that is not an error and whose
 * fetch answered 2xx (`servesPage`): an error page carries the words of
 * whatever path it repeats. A body served from a host the hop rule
 * refuses is not one either ({@link servedRefusal}).
 */
async function grounded(run: Run, claim: ExtractedClaim, origin: string): Promise<SourceOutcome> {
  const records = run.evidence.bySource(origin);
  const served = records.filter((record) => !record.isError && servesPage(record.status));
  let redirected: { readonly reason: UnmetReason; readonly detail: string } | undefined;
  const usable = served.filter((record) => {
    const refused = servedRefusal(run, origin, record);
    redirected ??= refused;
    return refused === undefined;
  });
  if (usable.length === 0 && redirected !== undefined) {
    return { reached: fail("none", redirected.reason, redirected.detail, { origin }) };
  }
  if (usable.length === 0) {
    const statuses = [
      ...new Set(
        records
          .filter((record) => !record.isError && !servesPage(record.status))
          .map((record) => record.status),
      ),
    ];
    return {
      reached: fail(
        "cited",
        "not_fetched",
        statuses.length > 0
          ? `${origin} answered ${statuses.join(", ")} when fetched in this run: that body is the server's error page, not the page`
          : records.length > 0
            ? `every read of ${origin} in this run returned an error`
            : `${origin} was never fetched or read in this run`,
        { origin },
      ),
    };
  }
  const { windowTokens } = run.config.grounded;
  // The figure rule on at every bar (claim-ledger `strictFigures`): it is
  // on by default only below full coverage, so a spec that tightened
  // `coverage` to 1 would otherwise switch it off — and with it the check
  // that a quotation's framing figures agree with the source ("the window
  // is 30 days, since \"customers may request a refund\"" against a source
  // saying 14), and figures compared as values (`thirty` and `30`).
  const options = locateOptions(run);
  const query = claimQuery(claim.text);
  let polarity: { location: Location; sha256: string } | undefined;
  let waivable: { location: Location; index: SourceIndex; sha256: string; key: string } | undefined;
  let miss: { location: Location; sha256: string } | undefined;
  let echoed: EvidenceRecord | undefined;
  let stored: { readonly record: EvidenceRecord; readonly by: EvidenceRecord } | undefined;
  let addressOnly: EvidenceRecord | undefined;
  // A body that grounds the claim in text the run wrote there itself: kept
  // while a read that grounds it otherwise is looked for ({@link writtenBy}).
  let selfGrounded: SourceOutcome | undefined;
  // A body read from a copy of the harness's own state ({@link provenanceOf}).
  let laundered: { readonly record: EvidenceRecord; readonly state: StateCopy } | undefined;
  let unread = false;
  for (const record of usable) {
    if (run.groundingTokens >= groundingBudget) {
      unread = true;
      break;
    }
    // A copy of a session log is the session log: what the run copied out
    // of a state root is the model's own text wherever it now lies (§1).
    const provenance = provenanceOf(run, record, readPlaces(run, record, origin));
    if (provenance.state !== undefined) {
      laundered ??= { record, state: provenance.state };
      continue;
    }
    const body = bodyOf(run, record);
    run.groundingTokens += body.index.tokens.length;
    let location = locateClaim(query, body.index, options);
    let index = body.index;
    if (location.status === "supported" || isWaivableMiss(location)) {
      // Before it grounds — or reaches the judge, who would be asked whether
      // the model's own words support it — is it the call's input handed back?
      const read = echoCheck(run, record, query, body.index, location);
      if (read === "unread") {
        unread = true;
        break;
      }
      if (read === "echo") {
        // A reader's echo is its own address printed back: the page was
        // read, and its own text does not carry the claim.
        if (isReader(record.toolName)) addressOnly ??= record;
        else echoed ??= record;
        continue;
      }
      if ("storedBy" in read) {
        stored ??= { record, by: read.storedBy };
        continue;
      }
      location = read.location;
      index = read.index;
    }
    if (location.status === "supported") {
      const writer = writtenBy(run, record, provenance, query, index, location);
      if (writer !== undefined && selfGrounded !== undefined) continue;
      const excerpt = groundedExcerpt(run, query, index, location);
      bodyKey(run, record, origin, body.sha256);
      const reached: Reached = {
        rung: "grounded",
        origin,
        sha256: body.sha256,
        ...(excerpt !== undefined ? { excerpt } : {}),
        ...(writer !== undefined
          ? { writtenBy: { toolUseId: writer.toolUseId, toolName: writer.toolName } }
          : {}),
      };
      if (writer === undefined) return { reached };
      selfGrounded = { reached };
      continue;
    }
    if (location.status === "polarityConflict") polarity ??= { location, sha256: body.sha256 };
    else if (isWaivableMiss(location)) {
      if (
        waivable === undefined ||
        location.matched / location.total > waivable.location.matched / waivable.location.total
      ) {
        waivable = {
          location,
          index,
          sha256: body.sha256,
          key: bodyKey(run, record, origin, body.sha256),
        };
      }
    } else miss ??= { location, sha256: body.sha256 };
  }
  // Grounded, only in text the run wrote there itself: it still grounds,
  // and the binding says whose text it is.
  if (selfGrounded !== undefined) return selfGrounded;
  if (polarity !== undefined) {
    return {
      reached: fail(
        "cited",
        "polarity_conflict",
        `${origin} carries the claim's words with a negation the claim lacks`,
        { origin, sha256: polarity.sha256 },
      ),
    };
  }
  if (unread) {
    return {
      reached: fail(
        "cited",
        "below_floor",
        `not checked: grounding this answer would read more than ${groundingBudget.toLocaleString("en-US")} tokens of fetched text, the most one verification reads — cite fewer or shorter sources, or split the answer`,
        { origin },
      ),
    };
  }
  if (
    laundered !== undefined &&
    waivable === undefined &&
    miss === undefined &&
    echoed === undefined &&
    stored === undefined &&
    addressOnly === undefined
  ) {
    // Everything under this origin is a copy of the harness's own state.
    return {
      reached: fail("cited", "not_fetched", stateCopyDetail(origin, laundered.state), { origin }),
    };
  }
  if (
    (echoed !== undefined || stored !== undefined || addressOnly !== undefined) &&
    waivable === undefined &&
    miss === undefined
  ) {
    if (echoed === undefined && stored !== undefined) {
      // Everything under this origin that carries the claim is text the run
      // itself sent earlier, handed back by a store.
      return {
        reached: fail(
          "cited",
          "not_fetched",
          `${origin} was never read in this run: the only text under it that carries this claim is what ${stored.by.toolUseId} (${stored.by.toolName}) sent earlier, handed back by ${stored.record.toolUseId} (${stored.record.toolName}) — a store returns what was written to it; fetch the page itself`,
          { origin },
        ),
      };
    }
    if (echoed === undefined && addressOnly !== undefined) {
      // The page was read; the claim is only in the address it prints.
      return {
        reached: fail(
          "cited",
          "not_found_in_source",
          `the claim's words are in ${origin} only where it prints the address ${addressOnly.toolUseId} (${addressOnly.toolName}) fetched, not in the page's own text`,
          { origin },
        ),
      };
    }
    const handed = echoed as EvidenceRecord;
    // Everything under this origin that carries the claim is text the run
    // sent itself: the origin was named, never read.
    return {
      reached: fail(
        "cited",
        "not_fetched",
        `${origin} was never read in this run: the only text under it that carries this claim is the input ${handed.toolUseId} (${handed.toolName}) was given, handed back — fetch the page itself`,
        { origin },
      ),
    };
  }
  const reported = waivable ?? miss;
  const location = reported?.location;
  const missing = location?.missing ?? [];
  const reached = fail(
    "cited",
    "not_found_in_source",
    location?.status === "misquoted"
      ? `${origin} does not carry the quotation word for word`
      : `the claim's words are not together in one ${windowTokens}-token window of ${origin}${
          missing.length > 0 ? ` (missing: ${missing.slice(0, 8).join(", ")})` : ""
        }`,
    { origin, ...(reported !== undefined ? { sha256: reported.sha256 } : {}) },
  );
  // The waiver judge: ONLY for a paraphrase miss on coverage alone (design
  // §6.2), only where `grounded` is the floor — at `cited` the binding meets
  // the floor without it, and at `checked`/`proven` no source binding can —
  // and never for a missing figure or negation (`isWaivableMiss`). It is
  // asked later, and only while the claim still needs it (`waive`).
  if (waivable !== undefined && run.floor === "grounded" && run.opts.judgeWaiver !== undefined) {
    return {
      reached,
      waivable: {
        claim,
        origin,
        span: waivable.location.excerpt ?? "",
        excerpt: groundedExcerpt(run, query, waivable.index, waivable.location),
        sha256: waivable.sha256,
        key: waivable.key,
      },
    };
  }
  return { reached };
}

/** Ask the waiver judge about one paraphrase miss; the waived state, or `undefined` for a no. */
async function askJudge(run: Run, waivable: Waivable): Promise<Reached | undefined> {
  const judge = run.opts.judgeWaiver;
  if (judge === undefined) return undefined;
  try {
    run.judge.calls += 1;
    const verdict = await judge({
      claim: waivable.claim.text,
      excerpt: waivable.span,
      source: waivable.origin,
    });
    if (typeof verdict.model === "string") run.judge.model ??= verdict.model;
    // The spend is the judge's report: a NaN or a negative would poison
    // the bundle's total (and serialize as null), so only a real cost counts.
    const cost = verdict.costUsdMicros;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      run.judge.costUsdMicros += cost;
    }
    if (verdict.supported !== true) return undefined;
    return {
      rung: "grounded",
      origin: waivable.origin,
      sha256: waivable.sha256,
      ...(waivable.excerpt !== undefined && waivable.excerpt !== ""
        ? { excerpt: waivable.excerpt }
        : {}),
      judgeWaived: true,
    };
  } catch {
    // A judge that fails waives nothing; the binding keeps its miss.
    return undefined;
  }
}

async function sourceBinding(
  run: Run,
  claim: ExtractedClaim,
  ref: SourceRef,
): Promise<SourceOutcome> {
  if (ref.kind === "text") {
    if (!run.config.sources.bibliographic) {
      return {
        reached: fail(
          "none",
          "not_locatable",
          `"${clip(ref.text, 80)}" is not a URL, a doi: or a workspace path`,
        ),
      };
    }
    return {
      reached: fail(
        "cited",
        "not_locatable",
        "a bibliographic reference names no body this run read — cite its URL, DOI or workspace path to ground the claim",
      ),
    };
  }
  let origin: string;
  if (ref.kind === "path") {
    const located = citedPath(run, ref.path);
    if ("rung" in located) return { reached: located };
    origin = located.origin;
    const state = stateRootOf(run, located.origin, located.real);
    if (state !== undefined) {
      // Cited — the file is there, as the offline gate also finds — and
      // never read: what is under a state root is the model's own text.
      return {
        reached: fail(
          "cited",
          "not_fetched",
          `${origin} is under ${state}, the harness's own state — session logs, proof bundles, spilled results and memory hold the model's own text, so nothing there is a source; cite the source itself`,
          { origin },
        ),
      };
    }
  } else {
    const written = ref.kind === "url" ? ref.url : ref.doi;
    const url = ref.kind === "url" ? normalizeUrl(ref.url) : doiUrl(ref.doi);
    if (url === undefined) {
      return {
        reached: fail("none", "not_locatable", `${clip(written, 120)} is not a well-formed URL`),
      };
    }
    if (ref.kind === "url" && hasUserinfo(ref.url)) {
      // The reader takes the text before `@` for the host; the page is on
      // the host after it. Named without the credentials themselves.
      const host = hostOf(url) ?? url;
      return {
        reached: fail(
          "none",
          "host_denied",
          `this URL puts a user name or password before its host, so it reads as another site — the page is on ${host}; cite its URL without them`,
          { origin: url },
        ),
      };
    }
    const refused = await citedUrl(run, url);
    if (refused !== undefined) return { reached: refused };
    origin = url;
  }
  return grounded(run, claim, origin);
}

// ---------------------------------------------------------------------------
// execution bindings: checked
// ---------------------------------------------------------------------------

/**
 * Is a recorded tool name on `execution.allow`? The IR carries CANONICAL
 * entries (ir `IrProvability.execution.allow`): a builtin is its spec key
 * (`moneyAdd`), anything else its exact name. A recorded builtin name
 * (`MoneyAdd`) is mapped to its key case-insensitively, the way the compiler
 * maps `tools:`; a non-builtin name (`mcp__calc__add`) must match exactly,
 * because MCP tool names are case-sensitive.
 */
export function isToolAllowed(toolName: string, allow: ReadonlyArray<string>): boolean {
  if (allow.includes(toolName)) return true;
  const key = builtinKey(toolName);
  return key !== undefined && allow.includes(key);
}

async function replayOnce(
  run: Run,
  record: {
    readonly toolUseId: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly content: string;
  },
): Promise<ReplayOutcome> {
  let pending = run.replays.get(record.toolUseId);
  if (pending === undefined) {
    if (run.replaysUsed >= run.config.execution.maxReplays) return "budget";
    run.replaysUsed += 1;
    const replay = run.opts.replay as NonNullable<VerifyOptions["replay"]>;
    // A replay that throws, or answers with something that is not a result,
    // could not run: the binding stays `checked` with `replayed: false`.
    pending = (async (): Promise<ReplayOutcome> => {
      try {
        const result = await replay(record.toolName, record.input);
        if (result === undefined || typeof result.content !== "string") return "not_run";
        if (result.isError === true) return "mismatch";
        return outputDigest(result.content) === outputDigest(record.content) ? "match" : "mismatch";
      } catch {
        return "not_run";
      }
    })();
    run.replays.set(record.toolUseId, pending);
  }
  return pending;
}

/** The caller's purity predicate; one that throws is read as "not pure". */
function isPure(run: Run, toolName: string): boolean {
  try {
    return run.opts.isPureTool?.(toolName) === true;
  } catch {
    return false;
  }
}

function callFacts(run: Run, record: EvidenceRecord): CallFacts {
  let facts = run.calls.get(record);
  if (facts === undefined) {
    facts = { content: record.content };
    run.calls.set(record, facts);
  }
  return facts;
}

/**
 * A token as the figure polarity rule compares it: a numeral by the value
 * the number layer reads (`#1284.5` for `1,284.50` and `1284.5`), so a
 * claim's figure meets the result's however each is written; any other word
 * by its normalized form.
 */
function polarityKey(token: SourceToken): string {
  if (/^\d/.test(token.raw)) {
    const value = normalizeNumber(token.raw);
    if (value !== null) return `#${value}`;
  }
  return token.norm;
}

/**
 * Is token `at` denied — governed by a negation (claim-ledger's
 * `governingNegation`) other than a partitive? "None of the 3 invoices is
 * overdue" denies the invoices' being overdue, not that there are 3.
 */
function deniedAt(index: SourceIndex, at: number): boolean {
  const negation = governingNegation(index, at);
  return negation !== -1 && index.tokens[negation + 1]?.norm !== "of";
}

/**
 * The negations that deny a predicate: "not", "never", "cannot" and the
 * `n't` forms. A determiner or a preposition ("no", "none", "without",
 * "neither … nor") qualifies the noun after it instead: "no tests failed
 * out of 120" says none of the tests failed, not that there were no tests,
 * and "the subtotal without VAT" names a subtotal, it does not deny VAT.
 * Read as denying the noun, those fail a correct claim that uses it ("all
 * 120 tests passed", "the subtotal excluding VAT"), so the figure polarity
 * rule counts only these for a word that is not a figure — on the claim's
 * side and the result's alike, so "without VAT" in both still agrees. A
 * figure keeps every negation: "no 2 meetings overlap" denies 2.
 */
const PREDICATE_NEGATIONS: ReadonlySet<string> = new Set(
  [...NEGATIONS].filter((word) => !["no", "none", "without", "neither", "nor"].includes(word)),
);

/** Is token `at`, a word that is not a figure, denied by a predicate negation? */
function wordDeniedAt(index: SourceIndex, at: number): boolean {
  const negation = governingNegation(index, at);
  return negation !== -1 && PREDICATE_NEGATIONS.has((index.tokens[negation] as SourceToken).norm);
}

/**
 * What ends a statement: sentence punctuation, a comma or a semicolon, a
 * table bar, a line break. Every other clause break (claim-ledger
 * `breaksClause`) — a colon, a bracket, a quote, a dash — joins a figure to
 * what is said of it: "91: not prime", "91 (not prime)", "91 - not prime",
 * "not prime: 91 = 7 * 13", a JSON key and its value. A question mark ends
 * one too, so "Is 91 prime? No." is two statements — and a bare "No." denies
 * nothing `governingNegation` can see (a known limit, not closed here).
 */
const STATEMENT_END = /[.,;!?…|\n\r]/;

/**
 * For each token of `index`, the number of the statement it sits in, and
 * where each statement starts: one pass over the text between tokens.
 */
function statementNumbers(index: SourceIndex): {
  readonly statement: Uint32Array;
  readonly starts: number[];
} {
  const tokens = index.tokens;
  const statement = new Uint32Array(tokens.length);
  const starts = tokens.length > 0 ? [0] : [];
  let n = 0;
  for (let i = 1; i < tokens.length; i++) {
    const left = tokens[i - 1] as SourceToken;
    const gap = index.text.slice(left.at + left.raw.length, (tokens[i] as SourceToken).at);
    if (STATEMENT_END.test(gap)) {
      n += 1;
      starts.push(i);
    }
    statement[i] = n;
  }
  return { statement, starts };
}

/**
 * Result tokens the figure polarity rule has read into a statement's table
 * of words: for a test to count with, as claim-ledger's `scanMeter` is.
 * Only ever added to.
 */
export const polarityMeter = { tokens: 0 };

function resultPolarity(content: string): ResultPolarity {
  const index = indexSource(content);
  const { statement, starts } = statementNumbers(index);
  const figureAt = new Map<string, number[]>();
  index.tokens.forEach((token, i) => {
    const key = polarityKey(token);
    if (!key.startsWith("#")) return;
    const at = figureAt.get(key);
    if (at === undefined) figureAt.set(key, [i]);
    else at.push(i);
  });
  return {
    index,
    statement,
    statementStarts: starts,
    figureAt,
    statements: new Map(),
    figures: new Map(),
  };
}

/** Every word of statement `n` that is not a figure or a negation, read once. */
function statementWords(result: ResultPolarity, n: number): ReadonlyMap<string, WordFacts> {
  let words = result.statements.get(n);
  if (words === undefined) {
    const table = new Map<string, WordFacts>();
    const { index } = result;
    const end = result.statementStarts[n + 1] ?? index.tokens.length;
    for (let at = result.statementStarts[n] as number; at < end; at++) {
      polarityMeter.tokens += 1;
      const key = polarityKey(index.tokens[at] as SourceToken);
      if (key.startsWith("#") || NEGATIONS.has(key)) continue;
      let facts = table.get(key);
      if (facts === undefined) {
        facts = { occurrences: 0, denials: 0 };
        table.set(key, facts);
      }
      facts.occurrences += 1;
      if (wordDeniedAt(index, at)) facts.denials += 1;
    }
    result.statements.set(n, table);
    words = table;
  }
  return words;
}

/**
 * What the result says of one figure, read once per figure: its own
 * occurrences, and the words of every statement holding it, merged. A word
 * is compared only by whether it occurs there, whether any occurrence is
 * denied and whether every one is, and each of those reads the same over
 * the statements of several figures as over each figure's in turn — so a
 * claim with several figures needs no table of its own.
 */
function figureFacts(result: ResultPolarity, key: string): FigureFacts {
  let facts = result.figures.get(key);
  if (facts === undefined) {
    const at = result.figureAt.get(key) ?? [];
    const self = {
      occurrences: at.length,
      denials: at.filter((i) => deniedAt(result.index, i)).length,
    };
    const statements = [...new Set(at.map((i) => result.statement[i] as number))];
    let words: ReadonlyMap<string, WordFacts>;
    if (statements.length === 1) words = statementWords(result, statements[0] as number);
    else {
      const merged = new Map<string, WordFacts>();
      for (const n of statements) {
        for (const [word, one] of statementWords(result, n)) {
          const into = merged.get(word);
          if (into === undefined) merged.set(word, { ...one });
          else {
            into.occurrences += one.occurrences;
            into.denials += one.denials;
          }
        }
      }
      words = merged;
    }
    facts = { self, words };
    result.figures.set(key, facts);
  }
  return facts;
}

/**
 * Where a claim that states a figure and the result it cites disagree on a
 * negation (design §6.3), or `undefined` when they do not.
 *
 * Value containment finds the claim's figures in the result; it cannot see
 * which way the sentence around them points. Reading the whole sentence for
 * a negation is too coarse in both directions: "no discount was applied, so
 * the total is 1,284.50" states the total, and a result saying "1284.50
 * (no rounding)" does not deny it. So polarity is read per word, as
 * claim-ledger's `governingNegation` scopes it, and only where the result
 * speaks to the claimed figures — the statement each sits in, which a
 * colon, a bracket or a dash does not end ({@link STATEMENT_END}):
 *
 * - A figure the claim denies ("the total is NOT 1,284.50") must be denied
 *   in the result too. A result that states it, unnegated, everywhere it
 *   appears says the reverse.
 * - Any other word of the claim that the result denies everywhere it
 *   appears in a statement holding one of the claim's figures, while the
 *   claim states it: "91 is NOT prime", "91: not prime", "91 (not prime)"
 *   do not check "91 is prime". The same word stated by the result where
 *   the claim denies it is the reverse case ("91 is not prime" citing "91:
 *   prime"). For such a word only a predicate negation counts, on either
 *   side ({@link PREDICATE_NEGATIONS}): "no tests failed out of 120" does
 *   not deny the tests of "all 120 tests passed".
 *
 * A word the result never uses, or uses only in statements about other
 * figures (a JSON field of its own, a sentence about something else), tells
 * nothing either way. The detail names the claim's own word, never the
 * result's text: it reaches the retry nudge.
 */
function figurePolarity(claimText: string, result: ResultPolarity): string | undefined {
  const claim = indexSource(claimText);
  const words = new Set(claimWords(claimText));
  const figures: string[] = [];
  const stated = new Map<string, { raw: string; denied: number; asserted: number }>();
  claim.tokens.forEach((token, i) => {
    if (!words.has(token.norm) || NEGATIONS.has(token.norm)) return;
    const key = polarityKey(token);
    const figure = key.startsWith("#");
    if (figure && !figures.includes(key)) figures.push(key);
    const entry = stated.get(key) ?? { raw: token.raw, denied: 0, asserted: 0 };
    if (figure ? deniedAt(claim, i) : wordDeniedAt(claim, i)) entry.denied += 1;
    else entry.asserted += 1;
    stated.set(key, entry);
  });
  const facts = figures.map((key) => figureFacts(result, key));
  for (const [key, word] of stated) {
    // A claim that both states and denies one word says too much to read.
    if (word.denied > 0 && word.asserted > 0) continue;
    const figure = key.startsWith("#");
    const there = figure
      ? [figureFacts(result, key).self]
      : facts.map((one) => one.words.get(key)).filter((one) => one !== undefined);
    const seen = there.some((one) => one.occurrences > 0);
    const anyDenied = there.some((one) => one.denials > 0);
    const allDenied = there.every((one) => one.denials === one.occurrences);
    if (word.denied > 0) {
      if ((figure || seen) && !anyDenied) {
        return figure
          ? `states no negation of ${word.raw}, and the claim denies it — state only what the result says`
          : `says the opposite: it states "${word.raw}" beside the figure, where the claim denies it`;
      }
    } else if (seen && allDenied) {
      return `says the opposite: it denies ${figure ? word.raw : `"${word.raw}"`}, which the claim states`;
    }
  }
  return undefined;
}

/**
 * Where a claim with no figure and the call it cites disagree, by the locate
 * kernel reading the call for the claim the way `grounded` reads a body —
 * figure rule on, so a number word and a negation are never excused — or
 * `undefined`. Coverage cannot see which way the words point ("not" is a
 * stopword to it), and a result that says "no two meetings overlap" must
 * not check "two meetings overlap".
 */
function wordPolarity(run: Run, claimText: string, said: SourceIndex): string | undefined {
  const location = locateClaim(claimQuery(claimText), said, {
    coverage: run.config.grounded.coverage,
    windowTokens: run.config.grounded.windowTokens,
    strictFigures: true,
  });
  // Only the claim's own words and the negations themselves reach the
  // detail (and so the nudge): never the result's other text.
  const negations = (location.differing ?? []).filter((word) => NEGATIONS.has(word));
  const listed = negations.length > 0 ? ` (${negations.join(", ")})` : "";
  switch (location.cause) {
    case "polarity":
      return `says the opposite: it carries the claim's words with a negation${listed} the claim lacks`;
    case "negation":
      return `does not carry the claim's negation${listed} beside its words — state only what the result says`;
    case "value": {
      const missing = (location.missing ?? []).filter((word) => figureKey(word) !== null);
      return `does not state ${missing.length > 0 ? missing.slice(0, 6).join(", ") : "the claim's figure"} beside the claim's words`;
    }
    default:
      return undefined;
  }
}

/** The call's input as text: what the coverage fallback reads beside the result. */
function inputText(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

/** The result alone, indexed once per call. */
function resultOf(facts: CallFacts): NonNullable<CallFacts["result"]> {
  facts.result ??= { tokens: contentTokens(facts.content), index: indexSource(facts.content) };
  return facts.result;
}

/** The input alone: its words, and each string it carries, indexed once per call. */
function inputOf(facts: CallFacts, record: EvidenceRecord): NonNullable<CallFacts["input"]> {
  facts.input ??= {
    tokens: contentTokens(inputText(record.input)),
    strings: inputStrings(record.input)
      .filter((value) => value.trim() !== "")
      .map((value) => indexSource(value)),
  };
  return facts.input;
}

/** At most this many distinct runs of one claim are looked for in a result ({@link handedRuns}). */
const MAX_HANDED_RUNS = 8;

/**
 * The claim as the call's input HANDED IT OVER: in each input string, every
 * run of it that holds the claim's words at their tightest (claim-ledger's
 * `tightestWindows`) and reads as the claim sentence — the claim's own
 * words, stopwords included, at the grounded bar, at least
 * `MIN_CLAIM_TOKENS` long and at most twice the claim. A draft handed to a
 * lint, a sentence handed to NormalizeText or WrapText, a claim handed to a
 * fact-check are that; a document a value is selected from is not — `{
 * "account": { "id": 7, "status": "suspended" } }` holds "account" and
 * "suspended", not "the account is suspended", and JsonQuery's
 * `["suspended"]` is the tool's answer, not the model's sentence (design
 * §6.3: the result contains the claim's values). Distinct runs, at most
 * {@link MAX_HANDED_RUNS}, in input order.
 */
function handedRuns(
  facts: CallFacts,
  record: EvidenceRecord,
  claimText: string,
  bar: number,
): string[][] {
  const claim = indexSource(claimText);
  const own = new Set(claim.tokens.map((token) => wordKey(token.norm)));
  const need = new Set(claimWords(claimText).map(wordKey));
  if (own.size === 0 || need.size === 0) return [];
  const longest = 2 * claim.tokens.length;
  const out = new Map<string, string[]>();
  for (const input of inputOf(facts, record).strings) {
    const keys = input.tokens.map((token) => wordKey(token.norm));
    for (const [from, to] of tightestWindows(keys, need)) {
      const length = to - from + 1;
      if (length < MIN_CLAIM_TOKENS || length > longest) continue;
      const window = new Set(keys.slice(from, to + 1));
      const share = (of: ReadonlySet<string>): number =>
        [...of].filter((key) => window.has(key)).length / of.size;
      if (share(need) < bar || share(own) < bar) continue;
      const words = input.tokens.slice(from, to + 1).map((token) => token.norm);
      out.set(words.join(" "), words);
      if (out.size >= MAX_HANDED_RUNS) return [...out.values()];
    }
  }
  return [...out.values()];
}

/** Where `words` occurs in `index`, every start, word for word (KMP: linear in the index). */
function occurrences(index: SourceIndex, words: readonly string[]): number[] {
  const m = words.length;
  const out: number[] = [];
  if (m === 0) return out;
  const border = new Int32Array(m);
  for (let j = 1, k = 0; j < m; j++) {
    while (k > 0 && words[j] !== words[k]) k = border[k - 1] as number;
    if (words[j] === words[k]) k += 1;
    border[j] = k;
  }
  let k = 0;
  index.tokens.forEach((token, at) => {
    while (k > 0 && token.norm !== words[k]) k = border[k - 1] as number;
    if (token.norm === words[k]) k += 1;
    if (k === m) {
      out.push(at - m + 1);
      k = border[k - 1] as number;
    }
  });
  return out;
}

/**
 * The result with the claim the input handed over ({@link handedRuns})
 * blanked out where the tool repeats it — what the tool said of its own
 * (design §10: a real-but-irrelevant tool result fails `checked`). A tool
 * the gate allows because it is pure can still be one that returns what it
 * is given (NormalizeText, WrapText, a check that repeats the claim it was
 * asked about), and a figure or a word in the repeated sentence is the
 * model's, not a computation's. Each run is blanked as many times as the
 * input holds it, first occurrence first: a tool that repeats the claim and
 * then quotes a source saying the same keeps the source's copy. The facts
 * themselves when nothing is blanked; otherwise the blanked result's own,
 * kept per call and runs.
 *
 * What stays open is text the tool reassembles from several input strings
 * (a template filled from parts), and a draft padded past twice the
 * claim's length: no one input string hands that claim over.
 */
function ownResult(facts: CallFacts, record: EvidenceRecord, runs: string[][]): CallFacts {
  if (runs.length === 0) return facts;
  const key = runs.map((words) => words.join(" ")).join("\u0000");
  facts.owns ??= new Map();
  let own = facts.owns.get(key);
  if (own === undefined) {
    const result = resultOf(facts).index;
    const { strings } = inputOf(facts, record);
    const blank = new Uint8Array(result.tokens.length);
    let blanked = false;
    for (const words of runs) {
      const handed = strings.reduce((n, input) => n + occurrences(input, words).length, 0);
      for (const at of occurrences(result, words).slice(0, handed)) {
        blank.fill(1, at, at + words.length);
        blanked = true;
      }
    }
    if (!blanked) own = facts;
    else {
      let text = "";
      let from = 0;
      result.tokens.forEach((token, i) => {
        if (blank[i] !== 1) return;
        text += result.text.slice(from, token.at) + " ".repeat(token.raw.length);
        from = token.at + token.raw.length;
      });
      own = { content: text + result.text.slice(from) };
    }
    facts.owns.set(key, own);
  }
  return own;
}

/**
 * A `FactCrossCheck` report (tool-verify): each claim it checked, the
 * verdict, and — where the verdict is `supported` — the source text it
 * found the claim in (`foundIn.excerpt`, each supporting source's
 * `excerpt`).
 */
type FactCheckReport = ReadonlyArray<{
  readonly claim: string;
  readonly verdict: string;
  /** Each source the check found the claim in (its label as the tool wrote
   *  it, a workspace-relative path), and the text it found there. */
  readonly supports: ReadonlyArray<{ readonly source?: string; readonly excerpt: string }>;
}>;

/** The report a `FactCrossCheck` result is, read once per call; `null` when it is not one. */
function factCheckReport(facts: CallFacts, record: EvidenceRecord): FactCheckReport | null {
  if (facts.factCheck !== undefined) return facts.factCheck;
  let report: FactCheckReport | null = null;
  try {
    const parsed: unknown = JSON.parse(record.body ?? facts.content);
    const claims =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["claims"]
        : undefined;
    if (Array.isArray(claims)) {
      const text = (value: unknown): string | undefined =>
        typeof value === "string" && value.trim() !== "" ? value : undefined;
      const field = (value: unknown, name: string): unknown =>
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)[name]
          : undefined;
      report = claims.flatMap((entry) => {
        const claim = text(field(entry, "claim"));
        const verdict = text(field(entry, "verdict"));
        if (claim === undefined || verdict === undefined) return [];
        const sources = field(entry, "sources");
        const supports: Array<{ readonly source?: string; readonly excerpt: string }> = [];
        const seen = new Set<string>();
        const add = (found: unknown): void => {
          const excerpt = text(field(found, "excerpt"));
          if (excerpt === undefined) return;
          const source = text(field(found, "source"));
          const key = `${source ?? ""}\u0000${excerpt}`;
          if (seen.has(key)) return;
          seen.add(key);
          supports.push(source === undefined ? { excerpt } : { source, excerpt });
        };
        add(field(entry, "foundIn"));
        if (Array.isArray(sources)) {
          for (const source of sources) {
            if (field(source, "status") === "supported") add(source);
          }
        }
        return [{ claim, verdict, supports }];
      });
    }
  } catch {
    report = null;
  }
  facts.factCheck = report;
  return report;
}

/**
 * What a `FactCrossCheck` result says of this claim (design §6.3, §10): the
 * source text of an entry that checked THIS claim — the sentence states
 * the entry's claim and the entry's claim states the sentence — with the
 * verdict `supported`, as the facts the checks read; or why it is none. The
 * report repeats every claim it was asked about, whatever it found, so read
 * whole it "contains" a refuted claim's figure: `notFound`, `polarityConflict`
 * and `misquoted` are the tool saying the source does NOT carry it. Read
 * only off the tool that prints it, as WebFetch's header is.
 */
function factCheckFacts(
  run: Run,
  facts: CallFacts,
  record: EvidenceRecord,
  claimText: string,
): CallFacts | string {
  const report = factCheckReport(facts, record);
  if (report === null) {
    return "is not a FactCrossCheck report this gate can read — cite the call whose result it is";
  }
  const bar = run.config.grounded.coverage;
  const words = contentTokens(claimText);
  const stating = report
    .map((entry, i) => ({ entry, i }))
    .filter(
      ({ entry }) =>
        statementMismatch(entry.claim, claimText, bar) === undefined &&
        coverage(words, contentTokens(entry.claim)) >= bar,
    );
  if (stating.length === 0) {
    return "reports no check of this claim — FactCrossCheck the sentence as the answer states it, then cite that call";
  }
  const supported = stating.find(
    ({ entry }) => entry.verdict === "supported" && entry.supports.length > 0,
  );
  if (supported === undefined) {
    return `reports this claim ${(stating[0] as { entry: FactCheckReport[number] }).entry.verdict}, not supported: the check found the cited source does not carry it — state only what the source says`;
  }
  facts.factChecks ??= new Map();
  let entry = facts.factChecks.get(supported.i);
  if (entry === undefined) {
    const read = factCheckSupport(run, record, supported.entry.supports, claimText);
    if (typeof read === "string") return read;
    entry = read;
    facts.factChecks.set(supported.i, entry);
  }
  return entry;
}

/** The most of a supporting source re-read when FactCrossCheck clipped its excerpt. */
const FACT_SOURCE_BYTES = 1024 * 1024;

/**
 * The source text a supported `FactCrossCheck` entry stands on, as the
 * checks read it (design §1 principle 1, §6.3).
 *
 * - A source under a state root is no source (`stateRootOf`): FactCrossCheck
 *   reads any workspace path, the run's own session log among them, and a
 *   claim the model wrote once was found there, verbatim, and served
 *   `checked ✓`. Such a source is dropped; with none left the claim fails,
 *   naming the root.
 *   So is a COPY of one: a file the run copied, moved, concatenated or
 *   unpacked out of a state root before the check ({@link provenanceOf}) —
 *   the session log copied into the workspace held the answer the gate had
 *   just refused, and FactCrossCheck over the copy served it `checked ✓`.
 * - An excerpt the tool clipped (it ends in `…`, at 240 characters) may stop
 *   short of the claim's figure: the claim is located again in the file the
 *   tool read, with the gate's bar, and checked against that span. Where it
 *   is not located there, the clipped excerpt is what there is.
 * - A file this run wrote the claim into before the check (design §10,
 *   {@link selfWriter}) is the run's own text: checking it against itself
 *   is no check. Where every file the check found the claim in is one, the
 *   result carries the call that wrote it (`writtenBy`), and the binding
 *   reaches a marked `grounded` at most — as the file itself, cited, does.
 *
 * A label that names no workspace file (a written reference, a URL the tool
 * did not read) keeps its excerpt as the tool reported it.
 */
function factCheckSupport(
  run: Run,
  record: EvidenceRecord,
  supports: FactCheckReport[number]["supports"],
  claimText: string,
): CallFacts | string {
  const texts: string[] = [];
  const refused: string[] = [];
  let writer: EvidenceRecord | undefined;
  let outside = false;
  // The tool names a file it read by its workspace-relative path, whatever
  // directory the document cited it from.
  const fromRoot: Run = { ...run, baseDir: run.workspaceRoot };
  for (const { source, excerpt } of supports) {
    let file: { readonly origin: string; readonly real: string } | undefined;
    let state: string | undefined;
    if (source !== undefined) {
      const located = citedPath(fromRoot, source);
      if (!("rung" in located)) {
        file = located;
        state = stateRootOf(run, located.origin, located.real);
      } else {
        // Gone since, or never a file: a state root is still named by its path.
        const rel = normalizePath(source, {
          workspaceRoot: run.workspaceRoot,
          baseDir: run.workspaceRoot,
        });
        if (rel !== undefined) state = stateRootOf(run, rel, path.resolve(run.workspaceRoot, rel));
      }
    }
    if (state !== undefined) {
      refused.push(`${file?.origin ?? source} (under ${state})`);
      continue;
    }
    const provenance = file !== undefined ? provenanceOf(run, record, [file.origin]) : { into: [] };
    if (provenance.state !== undefined) {
      refused.push(
        `${file?.origin ?? source} (a copy of ${provenance.state.place}, under ${provenance.state.shown})`,
      );
      continue;
    }
    const whole =
      excerpt.endsWith("\u2026") && file !== undefined
        ? relocated(run, file.real, claimText)
        : undefined;
    const text = whole ?? excerpt;
    texts.push(text);
    let own: EvidenceRecord | undefined;
    if (
      provenance.into.length > 0 &&
      file !== undefined &&
      !readBeforeWriting(run, file.origin, provenance.into, claimText)
    ) {
      const claim = claimRunsIn(run, claimText, text);
      own = selfWriter(run, provenance.into, claim.runs, claim.index);
    }
    if (own === undefined) outside = true;
    else writer ??= own;
  }
  if (texts.length === 0) {
    return `found this claim only in ${refused.join(", ")}, the harness's own state — session logs, proof bundles, spilled results and memory hold the model's own text, so nothing there, or copied from there, is a source; check the claim against the source itself`;
  }
  return {
    content: [...new Set(texts)].join("\n"),
    ...(!outside && writer !== undefined ? { writtenBy: writer } : {}),
  };
}

/**
 * The claim at its tightest in `text` ({@link spanRuns}), for the
 * self-written test of a source FactCrossCheck read, with the index of
 * `text` the runs stand in; the claim's own words, as one run, where the
 * gate's bar does not locate it there.
 */
function claimRunsIn(
  run: Run,
  claimText: string,
  text: string,
): { readonly runs: string[][]; readonly index: SourceIndex } {
  const query = claimQuery(claimText);
  const index = indexSource(text);
  const location = locateClaim(query, index, locateOptions(run));
  if (location.status === "supported" || isWaivableMiss(location)) {
    const runs = spanRuns(run, query, index, location);
    if (runs.length > 0) return { runs, index };
  }
  return { runs: [wordsOf(claimText)], index };
}

/**
 * Did the run read `origin` before the first of `writers` wrote into it,
 * and find the claim there (design §10)? Then the file said it before the
 * run wrote anything, and a FactCrossCheck of it is no check of the run's
 * own text — as on the path route, where a read made before any writer
 * grounds unmarked.
 */
function readBeforeWriting(
  run: Run,
  origin: string,
  writers: readonly number[],
  claimText: string,
): boolean {
  const sent = sentText(run);
  const first = Math.min(...writers);
  const options = locateOptions(run);
  for (const record of run.evidence.bySource(origin)) {
    if (record.isError || !servesPage(record.status)) continue;
    const at = sent.position.get(callOf(record));
    if (at === undefined || at >= first) continue;
    if (run.groundingTokens >= groundingBudget) return false;
    const body = bodyOf(run, record);
    run.groundingTokens += body.index.tokens.length;
    if (locateClaim(claimQuery(claimText), body.index, options).status === "supported") return true;
  }
  return false;
}

/** The claim located in a workspace file at the gate's bar, its span unclipped; `undefined` when it is not there. */
function relocated(run: Run, real: string, claimText: string): string | undefined {
  let body: string;
  try {
    const stat = statSync(real);
    if (!stat.isFile() || stat.size > FACT_SOURCE_BYTES) return undefined;
    body = readFileSync(real, "utf-8");
  } catch {
    return undefined;
  }
  const found = locateClaim(claimText, body, {
    ...locateOptions(run),
    maxExcerptChars: MAX_ECHO_SPAN_CHARS,
  });
  return found.status === "supported" ? found.excerpt : undefined;
}

/**
 * The excerpt an execution binding freezes (design §5.3): the whole result
 * when it fits in {@link MAX_EXCERPT_CHARS}; otherwise the part around the
 * first of the claim's figures the result states (or its quotation), so a
 * bundle read after the session log is gone shows the value that met the
 * floor — the first 240 characters of a forty-line result did not. Kept
 * per call and position, so many claims citing one result read it once.
 */
function executionExcerpt(
  facts: CallFacts,
  claimText: string,
  figured: boolean,
  quoted: boolean,
): string {
  facts.excerpt ??= clip(facts.content, MAX_EXCERPT_CHARS);
  if (!facts.excerpt.endsWith("…")) return facts.excerpt;
  let index: SourceIndex | undefined;
  let at = -1;
  let length = 1;
  if (figured) {
    facts.polarity ??= resultPolarity(facts.content);
    index = facts.polarity.index;
    for (const token of indexSource(claimText).tokens) {
      if (!/^\d/.test(token.raw)) continue;
      const first = facts.polarity.figureAt.get(polarityKey(token))?.[0];
      if (first !== undefined) {
        at = first;
        break;
      }
    }
  } else if (quoted) {
    const quote = claimQuery(claimText).quotes[0];
    if (quote !== undefined) {
      index = resultOf(facts).index;
      at = findSequence(index, quote);
      length = quote.length;
    }
  }
  if (index === undefined || at < 0) return facts.excerpt;
  const key = at * 1_000 + Math.min(length, 999);
  facts.excerpts ??= new Map();
  let excerpt = facts.excerpts.get(key);
  if (excerpt === undefined) {
    const first = index.tokens[at] as SourceToken;
    const last = index.tokens[at + length - 1] as SourceToken;
    // The result as written, not the folded text its tokens index (design §5.3).
    const cut = writtenSpan(index, first.at, last.at + last.raw.length);
    excerpt = clipAround(cut.text, cut.from, cut.to, MAX_EXCERPT_CHARS);
    facts.excerpts.set(key, excerpt);
  }
  return excerpt;
}

async function executionBinding(
  run: Run,
  claim: ExtractedClaim,
  toolUseId: string,
): Promise<Reached> {
  const record = run.evidence.byToolUseId(toolUseId);
  const calls = record === undefined ? (run.evidence.callsById?.(toolUseId) ?? []) : [];
  if (calls.length > 1) {
    // Several sub-agents made a call by this id (a provider that numbers
    // ids per conversation) and the session itself did not: grading one of
    // them for the claim would be a guess (`buildEvidenceIndex`).
    return fail(
      "none",
      "tool_missing",
      `${toolUseId} names ${calls.length} calls in this run's sub-agent sessions and none in the session itself — the gate cannot tell which one is cited; cite a result of this session's own calls`,
      { origin: toolUseId },
    );
  }
  if (record === undefined) {
    return fail(
      "none",
      "tool_missing",
      `no recorded call ${toolUseId} in this run's logs${
        run.opts.turnNumbers !== undefined ? " (this turn)" : ""
      }`,
      { origin: toolUseId },
    );
  }
  const facts = callFacts(run, record);
  const content = facts.content;
  facts.sha256 ??= sha256Of(content);
  const base = { origin: toolUseId, sha256: facts.sha256 };
  if (record.isError) {
    return fail(
      "none",
      "tool_errored",
      `${toolUseId} (${record.toolName}) returned an error`,
      base,
    );
  }
  if (!isToolAllowed(record.toolName, run.config.execution.allow)) {
    return fail(
      "none",
      "tool_not_allowed",
      `${record.toolName} is not on provability.execution.allow`,
      base,
    );
  }
  const valueAbsent = (detail: string): Reached =>
    fail("none", "value_absent", `the result of ${toolUseId} (${record.toolName}) ${detail}`, base);
  const percent = (share: number): string => `${Math.round(share * 100)}%`;
  const bar = run.config.grounded.coverage;
  // The result as the checks read it. A FactCrossCheck result is read by
  // its verdict: the claim is checked by the source text of an entry that
  // found it supported, never by the report's repetition of the claim it
  // was asked about.
  let result = facts;
  if (builtinKey(record.toolName) === builtinKey(FACT_CROSS_CHECK)) {
    const entry = factCheckFacts(run, facts, record, claim.text);
    if (typeof entry === "string") return valueAbsent(entry);
    result = entry;
  }
  // Anything else is read with the claim the input handed over blanked out
  // where the tool repeats it (`ownResult`): what is left is the tool's.
  const handed = handedRuns(facts, record, claim.text, bar);
  const own = result === facts ? ownResult(facts, record, handed) : result;
  const handsBack = (): Reached =>
    valueAbsent(
      "hands the call's own input back: the claim's words in it are text the call was given — cite a result that computes or reads what the claim states",
    );
  // Value containment (design §6.3): a figure or a quotation the claim
  // states must be in what the tool returned. A claim with neither still has
  // to be ABOUT the result — an allowed tool's unrelated output must not
  // check any sentence that cites it — so its words are measured against the
  // call (input and result) at the grounded bar.
  const numbers = extractNumbers(claim.text);
  const quotes = quotedSpans(claim.text);
  if (numbers.length > 0 || quotes.length > 0) {
    const absentFrom = (from: CallFacts): string[] => {
      from.numbers ??= new Set(extractNumbers(from.content));
      const stated = from.numbers;
      return [
        ...numbers.filter((value) => !containsValue(stated, value)),
        ...quotes.filter((quote) => !containsQuote(from.content, quote)).map((q) => `"${q.text}"`),
      ];
    };
    const absent = absentFrom(own);
    if (absent.length > 0) {
      // In the result only where it repeats what the call was handed.
      if (own !== result && absentFrom(result).length === 0) return handsBack();
      return valueAbsent(`does not contain ${absent.slice(0, 6).join(", ")}`);
    }
  }
  if (numbers.length > 0) {
    // The figures are there; which way the sentence around them points is
    // read word by word, where the result speaks to those figures.
    own.polarity ??= resultPolarity(own.content);
    const opposite = figurePolarity(claim.text, own.polarity);
    if (opposite !== undefined) return valueAbsent(opposite);
  } else {
    if (own.said === undefined) {
      const text = `${own.content}\n${inputText(record.input)}`;
      own.said = { tokens: contentTokens(text), index: indexSource(text) };
    }
    if (quotes.length === 0) {
      const words = contentTokens(claim.text);
      const share = coverage(words, own.said.tokens);
      if (share < bar) {
        return valueAbsent(
          `does not carry this claim: the claim states no figure or quotation, and ${percent(share)} of its words are in the call's input and result (needs ${percent(bar)})`,
        );
      }
      const left = coverage(words, resultOf(own).tokens);
      // The words were in the result only where it repeats the claim the
      // call was handed (NormalizeText, WrapText).
      if (own !== result && left < bar && coverage(words, resultOf(result).tokens) >= bar) {
        return handsBack();
      }
      // The input is read beside the result so a claim may name what the
      // call was asked ("the currency rounding check") and state what came
      // back ("found no drift"). But when the input HANDS THE CLAIM OVER —
      // a lint run over the draft answer, given the very sentence that
      // cites it — the input is all the call says of it, and would otherwise
      // check any sentence at all, so the result has to carry it too. A
      // document a value was selected from does not hand the claim over
      // (`handedRuns`): JsonQuery's `["suspended"]` checks "the account is
      // suspended" without repeating the account.
      if (left < bar && handed.length > 0) {
        return valueAbsent(
          `does not carry this claim: its words are the call's own input, and ${percent(left)} of them are in what the tool returned (needs ${percent(bar)})`,
        );
      }
    }
    // The words are there; the coverage measure cannot see which way they
    // point. The locate kernel, which keeps negations and number words,
    // reads the call for the claim (or for the framing of its quotation).
    const opposite = wordPolarity(run, claim.text, own.said.index);
    if (opposite !== undefined) return valueAbsent(opposite);
  }
  if (result.writtenBy !== undefined) {
    // FactCrossCheck found the claim only in files this run wrote it into
    // (`factCheckSupport`): checking the run's own text against itself is
    // no check (design §0 B, §10). It grounds as the file itself, cited,
    // does — and says whose text it is.
    const by = result.writtenBy;
    return {
      rung: "grounded",
      ...base,
      excerpt: executionExcerpt(result, claim.text, numbers.length > 0, quotes.length > 0),
      replayed: false,
      writtenBy: { toolUseId: by.toolUseId, toolName: by.toolName },
      failure: {
        reason: "below_floor",
        detail: `${toolUseId} (${record.toolName}) found this claim only in text this run wrote there itself — ${by.toolUseId} (${by.toolName}) wrote it before the check — so it reaches grounded at most, marked as written by this run; check the claim against a source the run did not write`,
      },
    };
  }
  let replayed = false;
  // Replay only where it decides the floor: at `checked`. Below it the
  // binding already meets the floor; at `proven` it cannot.
  if (
    run.floor === "checked" &&
    run.config.execution.replay &&
    run.opts.replay !== undefined &&
    isPure(run, record.toolName)
  ) {
    const outcome = await replayOnce(run, record);
    if (outcome === "mismatch") {
      return fail(
        "none",
        "replay_mismatch",
        `re-running ${record.toolName} with the logged input produced a different output`,
        { ...base, replayed: true },
      );
    }
    replayed = outcome === "match";
  }
  return {
    rung: "checked",
    ...base,
    excerpt: executionExcerpt(result, claim.text, numbers.length > 0, quotes.length > 0),
    replayed,
  };
}

// ---------------------------------------------------------------------------
// formal bindings: proven
// ---------------------------------------------------------------------------

async function artifactFor(run: Run, id: string): Promise<ProofArtifact | undefined> {
  let pending = run.artifacts.get(id);
  if (pending === undefined) {
    const store = run.opts.artifacts as NonNullable<VerifyOptions["artifacts"]>;
    // Wrapped so a store that throws synchronously rejects like one that fails.
    pending = (async () => store.get(id))();
    run.artifacts.set(id, pending);
  }
  return pending;
}

/** A word's polarity across one text, by how often it is stated and denied (`deniedAt`). */
type Polarity = { stated: number; denied: number };

/** Every word of a text that is not a negation, by {@link wordKey}, with its polarity. */
function polarities(index: SourceIndex): Map<string, Polarity> {
  const out = new Map<string, Polarity>();
  index.tokens.forEach((token, i) => {
    if (NEGATIONS.has(token.norm)) return;
    const key = wordKey(token.norm);
    let polarity = out.get(key);
    if (polarity === undefined) {
      polarity = { stated: 0, denied: 0 };
      out.set(key, polarity);
    }
    if (deniedAt(index, i)) polarity.denied += 1;
    else polarity.stated += 1;
  });
  return out;
}

/** "denied" or "stated" when every occurrence agrees; `undefined` when they do not, or there are none. */
function polarityOf(polarity: Polarity | undefined): "denied" | "stated" | undefined {
  if (polarity === undefined) return undefined;
  if (polarity.denied > 0 && polarity.stated === 0) return "denied";
  if (polarity.stated > 0 && polarity.denied === 0) return "stated";
  return undefined;
}

/**
 * Does the text deny, through a partitive, a statement whose words are
 * `words`? "None of the 3 invoices is overdue" denies that the 3 invoices
 * are overdue, yet no single word of it is denied ({@link deniedAt} leaves
 * a partitive out — it denies the predicate, not the word after it — and
 * the predicate sits beyond the negation's reach), so the word-by-word
 * comparison cannot see it. A
 * partitive counts only when every content word it governs is one of
 * `words`: "none of the discounts applied, so the total is 1,284.50" says
 * nothing of the total.
 */
function partitiveDenial(index: SourceIndex, words: ReadonlySet<string>): boolean {
  const governed = new Map<number, number[]>();
  for (let i = 0; i < index.tokens.length; i++) {
    const negation = governingNegation(index, i);
    if (negation === -1 || index.tokens[negation + 1]?.norm !== "of") continue;
    const list = governed.get(negation);
    if (list === undefined) governed.set(negation, [i]);
    else list.push(i);
  }
  for (const targets of governed.values()) {
    const about = targets.every((i) => {
      const token = index.tokens[i] as SourceToken;
      const content = claimWords(token.raw).length > 0 && !NEGATIONS.has(token.norm);
      return !content || words.has(wordKey(token.norm));
    });
    if (about) return true;
  }
  return false;
}

/** What may open a statement-level negation frame ({@link negationFrames}). */
const FRAME_SUBJECTS: ReadonlySet<string> = new Set(["it", "this", "that"]);
/** What a frame says of a clause, plainly, to deny it: "it is false that …". */
const FALSITY: ReadonlySet<string> = new Set([
  "false",
  "untrue",
  "incorrect",
  "wrong",
  "inaccurate",
]);
/** What a frame says of a clause, negated, to deny it: "it is not true that …". */
const TRUTH: ReadonlySet<string> = new Set(["true", "correct", "accurate", "right"]);

/**
 * Where the predicate of a negation frame that starts at `at` ends — "is
 * not true", "isn't the case", "is false", "is incorrect" — or -1.
 */
function framePredicate(words: readonly string[], at: number, subject: boolean): number {
  let i = at;
  let negated = false;
  if (words[i] === "is" || words[i] === "was") i += 1;
  else if (words[i] === "isn't" || words[i] === "wasn't") {
    i += 1;
    negated = true;
  } else if (!subject) return -1;
  // After a subject the copula may be gone from the words: the tokenizer
  // reads "it's" as "it".
  if (!negated && (words[i] === "not" || words[i] === "never")) {
    i += 1;
    negated = true;
  }
  if (negated && TRUTH.has(words[i] as string)) return i + 1;
  if (negated && words[i] === "the" && words[i + 1] === "case") return i + 2;
  if (!negated && FALSITY.has(words[i] as string)) return i + 1;
  return -1;
}

/**
 * How many statement-level negation frames a text opens: "it is not true
 * that …", "it isn't the case that …", "it's not true that …", "it is false
 * that …", "it is incorrect that …", "it is wrong that …", "it is not
 * correct that …"; a "that"-clause put first and denied after it, "that no
 * two of the three meetings overlap is false"; and a denial heading the
 * text, "not true: …". Such a frame negates the whole clause it frames, yet
 * its negation governs "true", "case" or "false" — words no proved claim
 * states — so the word-by-word comparison sees no flip: "it is not true that
 * no two of the three meetings overlap" covers "no two of the three meetings
 * overlap" word for word, figures and every negation included, and states
 * its opposite. Counted, so that two cancel. Read off the tokens, one
 * bounded look ahead per word.
 */
function negationFrames(index: SourceIndex): number {
  const words = index.tokens.map((token) => token.norm);
  let frames = 0;
  // "Not true: …", "Not the case: …", "Not correct — …".
  if (
    words[0] === "not" &&
    (TRUTH.has(words[1] as string) || (words[1] === "the" && words[2] === "case"))
  ) {
    frames += 1;
  }
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    if (FRAME_SUBJECTS.has(word)) {
      const end = framePredicate(words, i + 1, true);
      if (end !== -1 && words[end] === "that") {
        frames += 1;
        continue;
      }
    }
    // The clause first, its denial last: "that … is false", "that … is not
    // the case". Only where the text opens with the complementizer, and the
    // predicate ends it.
    if (i > 1 && words[0] === "that") {
      const end = framePredicate(words, i, false);
      if (end === words.length) frames += 1;
    }
  }
  return frames;
}

/**
 * Why the answer's sentence does not state what a proof's recorded claim
 * says, or `undefined` when it does (design §6.4): "the grounded coverage
 * test", read the way `grounded` reads it — the words, AND the figures and
 * the negations that coverage alone cannot see.
 *
 * - Words: the artifact claim's content tokens covered by the sentence's
 *   at the grounded bar, so an accepted proof of something else cannot be
 *   pinned to this sentence.
 * - Figures: the same figures on both sides (`two` and `2` are one). A
 *   proof about meetings 1 and 2 does not prove a sentence about all six,
 *   and `contentTokens` drops one- and two-digit numbers.
 * - Polarity, word by word: each word of the proof's claim (a figure by its
 *   value) is denied on both sides or on neither, as claim-ledger's
 *   `governingNegation` scopes a negation, wherever the sentence uses it.
 *   `contentTokens` drops "no" (two letters) and "not" (a stopword), so
 *   without this an accepted proof that two of the six meetings overlap
 *   would prove "no two of the six meetings overlap" — acceptance scenario
 *   C served false. Read per word, not per sentence, because the sentence
 *   may say more than the proof (design §6.4): "no discount was applied, so
 *   the invoice total is 1,284.50 EUR" states the proved total, and its
 *   "no" denies a discount the proof never mentions. A word one side both
 *   states and denies is not compared, and a negation that moves from one
 *   word to another ("no two of the meetings overlap", "two of the
 *   meetings didn't overlap") is a different statement. A partitive denial
 *   of the whole statement ("none of the 3 invoices is overdue") is read
 *   too ({@link partitiveDenial}), and so is a frame that negates it ("it
 *   is not true that …", {@link negationFrames}): one side framed and the
 *   other not states the opposite (acceptance C).
 *
 * What it cannot see is a sentence that adds a clause of its own to the
 * proved statement ("…, and the CEO approved it"): the coverage runs from
 * the proof's claim into the sentence, as the design specifies, so the
 * sentence may carry more words. That residual, like the formalization gap
 * itself, is shown beside the claim (the statement), not closed here.
 */
export function statementMismatch(
  proved: string,
  sentence: string,
  bar: number,
): string | undefined {
  const share = coverage(contentTokens(proved), contentTokens(sentence));
  if (share < bar) {
    return `this sentence does not state it (${Math.round(share * 100)}% of its words, needs ${Math.round(bar * 100)}%)`;
  }
  const want = figureKeys(proved);
  const have = figureKeys(sentence);
  const missing = [...want].filter((key) => !have.has(key));
  const extra = [...have].filter((key) => !want.has(key));
  if (missing.length > 0 || extra.length > 0) {
    return `the figures differ (${[
      ...(missing.length > 0 ? [`the proof's claim states ${missing.slice(0, 6).join(", ")}`] : []),
      ...(extra.length > 0 ? [`this sentence states ${extra.slice(0, 6).join(", ")}`] : []),
    ].join("; ")})`;
  }
  const provedIndex = indexSource(proved);
  const sentenceIndex = indexSource(sentence);
  const provedFramed = negationFrames(provedIndex) % 2 === 1;
  if (provedFramed !== (negationFrames(sentenceIndex) % 2 === 1)) {
    return provedFramed
      ? "the proof's claim is negated and this sentence is not — it states the opposite"
      : "this sentence is negated and the proof's claim is not — it states the opposite";
  }
  const ours = polarities(provedIndex);
  const theirs = polarities(sentenceIndex);
  const words = new Set<string>();
  for (const word of claimWords(proved)) {
    if (NEGATIONS.has(word)) continue;
    const key = wordKey(word);
    words.add(key);
    const there = polarityOf(theirs.get(key));
    const here = polarityOf(ours.get(key));
    if (there === undefined || here === undefined || there === here) continue;
    return here === "denied"
      ? `the proof's claim denies "${word}" and this sentence states it — it states the opposite`
      : `this sentence denies "${word}" and the proof's claim states it — it states the opposite`;
  }
  const provedDenied = partitiveDenial(provedIndex, words);
  if (provedDenied !== partitiveDenial(sentenceIndex, words)) {
    return provedDenied
      ? "the proof's claim is negated and this sentence is not — it states the opposite"
      : "this sentence is negated and the proof's claim is not — it states the opposite";
  }
  return undefined;
}

/**
 * What one `ProofCheck` call in the evidence reported about the artifact it
 * wrote, and what it was asked to check: the call's logged input, which
 * tool-proof's `toArtifact` copies into the artifact verbatim.
 */
type ProofReport = {
  readonly ok: boolean;
  readonly checker?: string;
  readonly assumptions?: readonly string[];
  readonly axioms?: readonly string[];
  readonly input: ProofCheckInput | undefined;
};

/** A `ProofCheck` call's input as the run's log holds it (tool-proof `checkSchema`). */
type ProofCheckInput = {
  readonly checker: string;
  readonly claim: string;
  readonly statement: string;
  readonly proof: string;
};

function proofCheckInput(input: unknown): ProofCheckInput | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const i = input as Record<string, unknown>;
  const { checker, claim, statement, proof } = i;
  return typeof checker === "string" &&
    typeof claim === "string" &&
    typeof statement === "string" &&
    typeof proof === "string"
    ? { checker, claim, statement, proof }
    : undefined;
}

/** Was the artifact written from exactly this call's input? */
const sameInput = (input: ProofCheckInput | undefined, artifact: ProofArtifact): boolean =>
  input !== undefined &&
  input.checker === artifact.checker &&
  input.claim === artifact.claim &&
  input.statement === artifact.statement &&
  input.proof === artifact.proof;

const stringList = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;

/**
 * Every `ProofCheck` report in the run's evidence (in scope: under `scope:
 * turn`, this turn's), by the artifact id it names — read once per
 * verification. A report is the tool's result (tool-proof `checkReport`:
 * `{ ok, id, checker, …, assumptions, axioms, output }`), not an error, as
 * the run's log recorded it.
 */
function proofReports(run: Run): ReadonlyMap<string, readonly ProofReport[]> {
  if (run.reports !== undefined) return run.reports;
  const out = new Map<string, ProofReport[]>();
  const key = builtinKey(PROOF_CHECK);
  for (const record of run.evidence.all()) {
    if (record.isError || builtinKey(record.toolName) !== key) continue;
    let report: unknown;
    try {
      report = JSON.parse(record.body ?? record.content);
    } catch {
      continue;
    }
    if (typeof report !== "object" || report === null || Array.isArray(report)) continue;
    const r = report as Record<string, unknown>;
    if (!isProofId(r["id"]) || typeof r["ok"] !== "boolean") continue;
    const assumptions = stringList(r["assumptions"]);
    const axioms = stringList(r["axioms"]);
    const entry: ProofReport = {
      ok: r["ok"],
      ...(typeof r["checker"] === "string" ? { checker: r["checker"] } : {}),
      ...(assumptions !== undefined ? { assumptions } : {}),
      ...(axioms !== undefined ? { axioms } : {}),
      input: proofCheckInput(record.input),
    };
    const list = out.get(r["id"]);
    if (list === undefined) out.set(r["id"], [entry]);
    else list.push(entry);
  }
  run.reports = out;
  return out;
}

/**
 * Does a list a `ProofCheck` report shows agree with the artifact's? The
 * report lists each item clipped (a trailing `…`) and, when they do not all
 * fit, ends with a `… and N more` line (tool-proof `listed`); the artifact
 * keeps every item whole. So each shown item is the stored item at its
 * place, or a clipped start of it, and the stored list is exactly as long —
 * or longer, where the report says more were left out.
 */
function listAgrees(shown: readonly string[] | undefined, stored: readonly string[]): boolean {
  if (shown === undefined) return true;
  const more = shown.length > 0 && (shown[shown.length - 1] as string).startsWith("… and ");
  const items = more ? shown.slice(0, -1) : shown;
  if (more ? stored.length <= items.length : stored.length !== items.length) return false;
  return items.every((item, i) => {
    const whole = stored[i] as string;
    return item === whole || (item.endsWith("…") && whole.startsWith(item.slice(0, -1)));
  });
}

/** The artifact re-checked once per verification (`VerifyOptions.recheckProof`); a throw reads as not re-checked. */
function recheckFor(run: Run, artifact: ProofArtifact): Promise<RecheckedProof | undefined> {
  let pending = run.rechecks.get(artifact.id);
  if (pending === undefined) {
    const recheck = run.opts.recheckProof as NonNullable<VerifyOptions["recheckProof"]>;
    pending = (async () => {
      try {
        const again = await recheck(artifact);
        return again !== undefined && typeof again.ok === "boolean" ? again : undefined;
      } catch {
        return undefined;
      }
    })();
    run.rechecks.set(artifact.id, pending);
  }
  return pending;
}

const hypothesisWords = (n: number): string => `${n} ${n === 1 ? "hypothesis" : "hypotheses"}`;

/**
 * A `proof:prf_…` binding (design §6.4): the artifact a registered checker
 * accepted, whose recorded claim this sentence states.
 *
 * "A registered checker accepted it" is read off the RUN, not off the
 * artifact file alone. The file sits in the workspace, where the model's
 * own file tools can write one by hand or flip a rejected one to `ok:
 * true` — so the artifact is accepted only when
 *
 * - its checker is on the resolved `formal.checkers`;
 * - the run's evidence holds the `ProofCheck` call that wrote it (in
 *   scope: a proof checked in an earlier turn does not back a claim under
 *   `scope: turn`), not an error, reporting this id as accepted by that
 *   checker, with the assumptions and axioms the artifact lists
 *   (`listAgrees`), and given exactly the checker, claim, statement and
 *   proof the artifact holds (`sameInput`: a file rewritten after the check
 *   keeps its id and verdict, never its input) — `trustStoredProofs` alone
 *   skips this, for an offline check with no log;
 * - where a re-check is wired (`recheckProof`: the builtin checker, pure
 *   and bounded), the checker accepts the stored statement and proof
 *   again.
 *
 * The hypotheses the proof rests on (`assumptions`: builtin `given`
 * steps, SMT asserts and definitions) are listed on the binding beside the
 * statement and, design §6.4, are assumptions: under `assumptions: forbid`
 * a proof that rests on any is refused (`assumption_forbidden`), and
 * `max_assumptions` counts them (`verifyDocument`). A proof that assumes
 * its own conclusion is otherwise `proven` with "0 assumptions".
 */
async function formalBinding(run: Run, claim: ExtractedClaim, proofId: string): Promise<Reached> {
  const base = { origin: proofId };
  if (!isProofId(proofId)) {
    return fail(
      "none",
      "proof_missing",
      `${clip(proofId, 40)} is not a proof id (prf_<16 hex>)`,
      base,
    );
  }
  if (run.opts.artifacts === undefined) {
    return fail("none", "proof_missing", "no proof-artifact store is wired here", base);
  }
  let artifact: ProofArtifact | undefined;
  try {
    artifact = await artifactFor(run, proofId);
  } catch (err) {
    return fail(
      "none",
      "proof_missing",
      `${proofId} could not be read: ${clip(err instanceof Error ? err.message : String(err), 160)}`,
      base,
    );
  }
  if (artifact === undefined) {
    return fail(
      "none",
      "proof_missing",
      `no proof artifact ${proofId} — run ProofCheck first`,
      base,
    );
  }
  if (!isProofArtifact(artifact)) {
    return fail("none", "proof_missing", `the artifact stored as ${proofId} is malformed`, base);
  }
  if (artifact.id !== proofId) {
    return fail(
      "none",
      "proof_missing",
      `the artifact stored as ${proofId} names another id`,
      base,
    );
  }
  const listed = (texts: readonly string[]): string[] =>
    [...new Set(texts)].map((text) => clip(text, MAX_STATEMENT_CHARS));
  const shownWith = (held: readonly string[]) => ({
    ...base,
    sha256: artifact.outputDigest,
    checker: artifact.checker,
    statement: clip(artifact.statement, MAX_STATEMENT_CHARS),
    ...(held.length > 0 ? { assumptions: held } : {}),
  });
  const hypotheses = listed(artifact.assumptions);
  const shown = shownWith(hypotheses);
  const checkers: readonly string[] = run.config.formal.checkers;
  if (!checkers.includes(artifact.checker)) {
    return fail(
      "none",
      "proof_missing",
      `${proofId} was checked by ${clip(artifact.checker, 40)}, which is not on provability.formal.checkers (${checkers.join(", ") || "none"})`,
      shown,
    );
  }
  if (!artifact.ok) {
    const why = [
      artifact.reason !== undefined ? clip(artifact.reason, 200) : undefined,
      artifact.counterexample !== undefined
        ? `counterexample: ${clip(artifact.counterexample, 300)}`
        : undefined,
    ].filter((part): part is string => part !== undefined);
    return fail(
      "none",
      "proof_rejected",
      `the ${artifact.checker} checker rejected ${proofId}${why.length > 0 ? ` — ${why.join("; ")}` : ""}`,
      shown,
    );
  }
  if (run.opts.trustStoredProofs !== true) {
    const reports = proofReports(run).get(proofId) ?? [];
    if (reports.length === 0) {
      return fail(
        "none",
        "proof_missing",
        `no ProofCheck call in this run's evidence${
          run.opts.turnNumbers !== undefined ? " (this turn)" : ""
        } wrote ${proofId} — run ProofCheck and cite the id it returns`,
        shown,
      );
    }
    if (!reports.some((report) => report.ok)) {
      return fail(
        "none",
        "proof_rejected",
        `the ProofCheck call that wrote ${proofId} reported it rejected; the artifact stored under that id says otherwise`,
        shown,
      );
    }
    const accepted = reports.filter(
      (report) =>
        report.ok &&
        (report.checker === undefined || report.checker === artifact.checker) &&
        listAgrees(report.assumptions, artifact.assumptions) &&
        listAgrees(report.axioms, artifact.axioms),
    );
    if (accepted.length === 0) {
      return fail(
        "none",
        "proof_missing",
        `the artifact stored as ${proofId} is not the one ProofCheck reported in this run (its checker, assumptions or axioms differ)`,
        shown,
      );
    }
    // The report names the id; the call's input is what was checked. An
    // artifact whose claim, statement or proof was rewritten after the check
    // keeps the id and the verdict, so it is matched against the input too.
    if (!accepted.some((report) => sameInput(report.input, artifact))) {
      return fail(
        "none",
        "proof_missing",
        `the artifact stored as ${proofId} is not the one ProofCheck checked in this run (its checker, claim, statement or proof differ from that call's input)`,
        shown,
      );
    }
  }
  let held = hypotheses;
  let axioms: readonly string[] = artifact.axioms;
  if (run.opts.recheckProof !== undefined) {
    const again = await recheckFor(run, artifact);
    if (again !== undefined && !again.ok) {
      return fail(
        "none",
        "proof_rejected",
        `the ${artifact.checker} checker, run again on the statement and proof stored as ${proofId}, does not accept them`,
        shown,
      );
    }
    if (again?.assumptions !== undefined) held = listed(again.assumptions);
    if (again?.axioms !== undefined) axioms = again.axioms;
  }
  const proved = shownWith(held);
  const mismatch = statementMismatch(artifact.claim, claim.text, run.config.grounded.coverage);
  if (mismatch !== undefined) {
    return fail(
      "none",
      "claim_mismatch",
      `${proofId} proves "${clip(artifact.claim, 160)}"; ${mismatch}`,
      proved,
    );
  }
  if (held.length > 0 && run.config.assumptions === "forbid") {
    return fail(
      "none",
      "assumption_forbidden",
      `${proofId} rests on ${hypothesisWords(held.length)} (${clip(held.join("; "), 200)}) and provability.assumptions is forbid — prove it from none, or drop the claim`,
      proved,
    );
  }
  const key = `${artifact.checker}\u0000${proofId}`;
  if (!run.checkers.has(key)) {
    run.checkers.set(key, {
      id: artifact.checker,
      artifact: proofId,
      axioms: [...axioms],
      ...(held.length > 0 ? { assumptions: [...held] } : {}),
    });
  }
  return { rung: "proven", ...proved };
}

// ---------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------

/** What may open an evidence id the model dressed, and what may close one. */
const ID_OPENERS = new Set(["`", "'", '"', "<", "("]);
const ID_CLOSERS = new Set(["`", "'", '"', ">", ")", ".", ",", ";", ":", "!", "?"]);

/**
 * An evidence id as the model may have dressed it — `` tool:`toolu_01` ``,
 * `proof:prf_….` at the end of a sentence — down to the id. Ids are
 * `[A-Za-z0-9_-]` runs, so wrapping quotes, backticks and angle brackets and
 * trailing sentence punctuation are never part of one. Trimmed by walking
 * in from each end: an end-anchored pattern (`/[…]+$/`) restarts at every
 * character of a long run of them that does not end the id — quadratic in
 * text the model writes, six seconds for 80 000 dots.
 */
export function bareId(id: string): string {
  let from = 0;
  let to = id.length;
  while (from < to && ID_OPENERS.has(id[from] as string)) from += 1;
  while (to > from && ID_CLOSERS.has(id[to - 1] as string)) to -= 1;
  return id.slice(from, to);
}

/** The marker as written: `[^a]` when the claim spelled it as a footnote. */
function refOf(id: string, raw: string): string {
  return raw.includes(`[^${id}]`) ? `[^${id}]` : `[${id}]`;
}

async function bindingFor(
  run: Run,
  claim: ExtractedClaim,
  id: string,
  definitions: ReadonlyMap<string, string>,
): Promise<Bound> {
  const ref = refOf(id, claim.raw);
  const source = definitions.get(id);
  if (source === undefined) {
    return {
      binding: finish(
        ref,
        "source",
        fail("none", "no_definition", `${ref} has no "${ref}: …" definition line`),
        run.floor,
      ),
    };
  }
  const evidence = classifyDefinition(source);
  switch (evidence.kind) {
    case "assume":
      if (run.config.assumptions === "forbid") {
        return {
          binding: finish(
            ref,
            "assumption",
            fail("none", "assumption_forbidden", "provability.assumptions is forbid", {
              origin: clip(evidence.text, MAX_CLAIM_CHARS),
            }),
            run.floor,
          ),
        };
      }
      // Not evidence and not a failure: the claim's status says what it is.
      return {
        binding: {
          ref,
          kind: "assumption",
          rung: "none",
          ok: false,
          origin: clip(evidence.text, MAX_CLAIM_CHARS),
        },
      };
    case "tool":
      return {
        binding: finish(
          ref,
          "execution",
          await executionBinding(run, claim, bareId(evidence.toolUseId)),
          run.floor,
        ),
      };
    case "proof":
      return {
        binding: finish(
          ref,
          "formal",
          await formalBinding(run, claim, bareId(evidence.proofId)),
          run.floor,
        ),
      };
    default: {
      const outcome = await sourceBinding(run, claim, evidence);
      return {
        binding: finish(ref, "source", outcome.reached, run.floor),
        ...(outcome.waivable !== undefined ? { waivable: outcome.waivable } : {}),
      };
    }
  }
}

/**
 * What `grounded.independent` counts as one origin: the registrable domain
 * of a URL (`docs.acme.example` and `www.acme.example` are one publisher), a
 * DOI's registrant prefix (`10.1000` — one publisher's papers are one
 * origin, like one site's pages), and a workspace file's own path.
 */
export function independenceKey(origin: string): string {
  const host = /^https?:\/\//i.test(origin) ? hostOf(origin) : undefined;
  if (host === undefined) return `path:${origin}`;
  if (host === "doi.org") {
    const prefix = /^https:\/\/doi\.org\/([^/]+)/.exec(origin)?.[1];
    return `doi:${prefix ?? origin}`;
  }
  return `host:${registrableDomain(host)}`;
}

/**
 * Distinct independence keys among a claim's source bindings that reached
 * `grounded`: each by the origin that served the body it grounded in
 * ({@link bodyKey}), and by its cited origin only where no body is known.
 */
function groundedOrigins(run: Run, bindings: ReadonlyArray<ProofBinding>): Set<string> {
  const keys = new Set<string>();
  for (const b of bindings) {
    if (
      b.kind === "source" &&
      levelRank(b.rung) >= levelRank("grounded") &&
      b.origin !== undefined
    ) {
      keys.add(
        (b.sha256 !== undefined ? run.bodyKeys.get(groundedAs(b.sha256, b.origin)) : undefined) ??
          independenceKey(b.origin),
      );
    }
  }
  return keys;
}

/**
 * `grounded.independent: n` at a `grounded` floor: a claim met only by
 * source bindings needs n distinct origins among them. One met by an
 * execution or formal binding (a stronger rung) is met regardless. When it
 * falls short its bindings keep their rungs, and every source binding that
 * was `ok` becomes not ok with `not_independent` — the best one first in
 * document order — so `statusOf`'s "met when some binding is ok" still
 * decides it.
 */
function applyIndependence(run: Run, bindings: ProofBinding[]): ProofBinding[] {
  const n = run.config.grounded.independent;
  if (run.floor !== "grounded" || n <= 1) return bindings;
  if (bindings.some((b) => b.ok && b.kind !== "source")) return bindings;
  const okSources = bindings.filter((b) => b.ok && b.kind === "source");
  if (okSources.length === 0) return bindings;
  const keys = groundedOrigins(run, bindings);
  if (keys.size >= n) return bindings;
  const shown = [...keys].map((key) => key.replace(/^[a-z]+:/, "")).join(", ");
  const detail = `needs ${n} independent origins; this claim grounds in ${keys.size} (${shown})`;
  return bindings.map((b) =>
    b.ok && b.kind === "source"
      ? { ...b, ok: false, reason: "not_independent" as const, detail }
      : b,
  );
}

/**
 * The waiver judge (design §6.2), asked once a claim's deterministic
 * bindings are settled and only while the claim still needs it: at
 * `independent: 1`, only when no binding meets the floor — a claim another
 * binding already meets cannot be changed by a waiver, so asking would
 * spend `judge_share` (§18) and print "1 judge-waived" beside an answer
 * that passed deterministically, and draw down the share a claim that does
 * need the judge would use. At `independent: n > 1`, only for an origin the
 * claim does not already count, and only while it is short of n with
 * enough waivable origins to make up the count. In marker order, until the
 * claim is met.
 */
async function waive(run: Run, bound: readonly Bound[]): Promise<ProofBinding[]> {
  const bindings = bound.map((b) => b.binding);
  if (!bound.some((b) => b.waivable !== undefined)) return bindings;
  // A dangling marker unmeets the claim whatever is waived (`statusOf`).
  if (bindings.some((b) => b.reason === "no_definition")) return bindings;
  const n = run.config.grounded.independent;
  const needed = (): boolean => {
    if (n <= 1) return !bindings.some((b) => b.ok);
    if (bindings.some((b) => b.ok && b.kind !== "source")) return false;
    return groundedOrigins(run, bindings).size < n;
  };
  if (n > 1) {
    const could = groundedOrigins(run, bindings);
    for (const b of bound) {
      if (b.waivable !== undefined) could.add(b.waivable.key);
    }
    if (could.size < n) return bindings;
  }
  for (const [i, b] of bound.entries()) {
    if (b.waivable === undefined) continue;
    if (!needed()) break;
    if (n > 1 && groundedOrigins(run, bindings).has(b.waivable.key)) continue;
    const waived = await askJudge(run, b.waivable);
    if (waived !== undefined) bindings[i] = finish(b.binding.ref, "source", waived, run.floor);
  }
  return bindings;
}

/**
 * A claim's status. `met` iff some binding is `ok` — and no marker in it is
 * dangling: design §2/§6.1's `cited` rung is that EVERY marker in a claim
 * sentence has a definition, so "14 days [1] [2]" with no `[2]:` line puts
 * a citation of nothing in front of the reader, however good `[1]` is. (A
 * defined marker that fails — a second source never fetched — does not
 * unmeet a claim another binding meets; the bundle and the report's table
 * still show it.) `assumption` when every binding is an allowed assumption.
 */
function statusOf(bindings: ReadonlyArray<ProofBinding>): ClaimStatus {
  if (bindings.some((b) => b.reason === "no_definition")) return "unmet";
  if (bindings.some((b) => b.ok)) return "met";
  if (
    bindings.length > 0 &&
    bindings.every((b) => b.kind === "assumption" && b.reason === undefined)
  ) {
    return "assumption";
  }
  return "unmet";
}

/**
 * Is the claim unmet for its assumptions alone — every marker an `assume:`
 * definition (allowed or refused), or a proof refused for the hypotheses
 * it rests on (design §6.4: those are assumptions too)?
 */
function refusedForAssumptions(claim: ProofClaim): boolean {
  return (
    claim.status === "unmet" &&
    claim.bindings.length > 0 &&
    claim.bindings.every(
      (b) =>
        b.kind === "assumption" || (b.kind === "formal" && b.reason === "assumption_forbidden"),
    )
  );
}

/**
 * The highest floor one claim would meet: its best evidence rung, with
 * `grounded.independent` applied at `grounded` (a claim grounded in too few
 * origins would meet `cited`, not `grounded`), and none at all with a
 * dangling marker in it (see {@link statusOf}).
 */
function claimCeiling(run: Run, claim: ProofClaim): Rung {
  if (claim.bindings.some((b) => b.reason === "no_definition")) return "none";
  const evidence = claim.bindings.filter((b) => b.kind !== "assumption");
  const best = maxRung(...evidence.map((b) => b.rung));
  const n = run.config.grounded.independent;
  if (n > 1 && best === "grounded" && groundedOrigins(run, evidence).size < n) return "cited";
  return best;
}

/** A claim to verify, and the definition whose text it is when it is one. */
type Pending = { readonly claim: ExtractedClaim; readonly definition?: string };

/** One claim bound and settled: every marker's binding, the waiver, `grounded.independent`. */
async function verifyClaim(
  run: Run,
  { claim, definition }: Pending,
  definitions: ReadonlyMap<string, string>,
): Promise<ProofClaim> {
  // Long answers over large bodies are real work: let timers, aborts and
  // the process's other sessions run between claims.
  if (performance.now() - run.lastYield >= YIELD_EVERY_MS) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    run.lastYield = performance.now();
  }
  const bound: Bound[] = [];
  for (const id of claim.markers) bound.push(await bindingFor(run, claim, id, definitions));
  const settled = applyIndependence(run, await waive(run, bound));
  return {
    index: claim.index,
    text: clip(claim.text, MAX_CLAIM_CHARS),
    ...(claim.line > 0 ? { line: claim.line } : {}),
    status: statusOf(settled),
    best: maxRung(...settled.map((b) => b.rung)),
    bindings: settled,
    ...(definition !== undefined ? { definition } : {}),
  };
}

/**
 * Claims stated INSIDE definition lines. claim-ledger's extractor leaves
 * out the definition `citationDefinitions` keeps for each id — but `[8]:
 * https://acme.example/x Payments clear within 5 days` is not a valid link
 * reference definition, so it renders as that sentence, and the gate would
 * otherwise put an assertion in front of the reader that it never read. So
 * the text such a definition shows beyond what it names (claim-ledger's
 * `definitionGloss`) is read the way the answer is — by `extractClaims`,
 * which decides what a claim is — and each claim in it cites that
 * definition: checked against what it names, like any other. Every other
 * definition-shaped line that shows text (a second `[8]:` line, a bullet
 * `- [8]: …`) the extractor reads as prose itself, uncited.
 *
 * One rule for every definition, cited or not, whatever its kind and
 * whether or not the text ends like a sentence; a cited definition's
 * trailing sentence is as visible as an uncited one's. A short gloss
 * (`— Acme refunds`: under three content words, no figure) is not a claim,
 * and a title in quotes (`[1]: https://… "Acme refund policy"`) is not
 * shown at all. A reference entry with bibliographic text after its URL or
 * DOI (`… Smith, J. (2020). Refunds in retail. 12(3), 45-67.`) IS read: it
 * describes its source, and at `grounded` the run must have read that
 * source for the description to stand — the retry nudge says how to keep a
 * title out. `sources.bibliographic` spares only a free-text source
 * itself, which is then the reference (see `definitionGloss`).
 */
function definitionClaims(
  text: string,
  definitions: ReadonlyMap<string, string>,
  bibliographic: boolean,
  firstIndex: number,
): Pending[] {
  const out: Pending[] = [];
  for (const [id, source] of definitions) {
    const gloss = definitionGloss(source, classifyDefinition(source), bibliographic);
    if (gloss === "") continue;
    // The marker as the definition spelled it, so a footnote keeps its caret.
    const definition = text.includes(`[^${id}]:`) ? `[^${id}]` : `[${id}]`;
    for (const claim of extractClaims(gloss)) {
      out.push({
        claim: {
          index: firstIndex + out.length,
          text: claim.text,
          // Read as if the sentence carried the marker it sits under.
          raw: `${claim.raw} ${definition}`,
          line: 0,
          markers: [id],
        },
        definition,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the bundle
// ---------------------------------------------------------------------------

/** Keys sorted at every depth; `undefined` dropped, as JSON drops it. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * `sha256:<hex>` over the canonical JSON (keys sorted recursively) of every
 * field of the bundle except `bundleHash` itself — what the audit record
 * and the trace line carry, so a stored bundle can be shown to be the one
 * that was graded.
 */
export function bundleHash(bundle: Omit<ProofBundle, "bundleHash"> | ProofBundle): string {
  const { bundleHash: _ignored, ...rest } = bundle as ProofBundle;
  return sha256Of(JSON.stringify(canonical(rest)));
}

function nowOf(now: Date | (() => Date) | undefined): Date {
  if (now === undefined) return new Date();
  return typeof now === "function" ? now() : now;
}

/**
 * The bundle for a verifier that THREW (design §5.1): grading
 * infrastructure failed, the gate fails open, and the bundle says so rather
 * than printing a ✓ — `verdict: "unverified"`, no claims, the error clipped.
 * Only the floor and the threshold are read, so the runtime gate — which
 * holds `RunProvability`, not the lowered IR block — can build one too.
 */
export function unverifiedBundle(
  config: Pick<ProvabilityConfig, "level" | "threshold">,
  error: unknown,
  retryIndex = 0,
  now?: Date | (() => Date),
): ProofBundle {
  const message = error instanceof Error ? error.message : String(error);
  const core: Omit<ProofBundle, "bundleHash"> = {
    version: 1,
    level: config.level,
    verdict: "unverified",
    score: 0,
    threshold: config.threshold,
    achieved: "none",
    claims: [],
    claimCount: 0,
    met: 0,
    unmet: 0,
    assumptions: 0,
    sources: 0,
    judgeWaived: 0,
    retryIndex,
    error: clip(message === "" ? "the verifier failed" : message, 500),
    createdAt: nowOf(now).toISOString(),
  };
  return { ...core, bundleHash: bundleHash(core) };
}

/**
 * Verify every claim of `text` against `opts.evidence` at `opts.config`'s
 * floor, and return the proof bundle (design §5.3).
 *
 * - Claims are claim-ledger's `extractClaims` — plus the text any
 *   definition line shows beyond what it names, read as claims citing that
 *   definition (see `definitionClaims`); a claim with no marker is unmet
 *   with zero bindings (`no_citation`), one with a dangling marker is unmet
 *   (`no_definition`).
 * - Each marker binds to its definition, classified by claim-ledger's
 *   evidence-ref grammar: a source (cited → grounded), `tool:` (checked),
 *   `proof:` (proven) or `assume:` (an assumption).
 * - A binding records the highest rung it reached and, when that is below
 *   the floor, the FIRST check it failed. Rungs above the floor are still
 *   computed — `achieved` is "the highest floor this answer would have
 *   passed" — but the three outside calls are made only where the floor
 *   needs them: `resolveHead` at `cited`/`grounded` (no source can meet a
 *   higher floor), `judgeWaiver` at `grounded` (for a coverage-only
 *   paraphrase miss), `replay` at `checked`. So `achieved` above the floor
 *   is computed without them.
 * - `scope: turn` (`turnNumbers`) restricts the evidence to those turns.
 *
 * Never throws for anything a document or its evidence can contain — an
 * unreadable artifact, a failing judge or replay, a refused HEAD are each a
 * binding's reason. Throws only for a malformed config (a programmer error).
 */
export async function verifyDocument(text: string, opts: VerifyOptions): Promise<ProofBundle> {
  const { config } = opts;
  if (!isProvabilityLevel(config?.level)) {
    throw new ProvabilityError(
      "config",
      `provability: config.level must be one of ${PROVABILITY_LEVELS.join(", ")}`,
    );
  }
  const workspaceRoot = path.resolve(opts.workspaceRoot ?? process.cwd());
  const run: Run = {
    config,
    floor: config.level,
    opts,
    evidence:
      opts.turnNumbers !== undefined
        ? restrictToTurns(opts.evidence, opts.turnNumbers)
        : opts.evidence,
    workspaceRoot,
    baseDir: path.resolve(workspaceRoot, opts.baseDir ?? "."),
    heads: new Map(),
    bodies: new Map(),
    calls: new Map(),
    inputs: new Map(),
    masked: new Map(),
    served: new Map(),
    bodyKeys: new Map(),
    stateRoots: stateRootsOf(workspaceRoot, opts.stateRoots),
    replays: new Map(),
    artifacts: new Map(),
    checkers: new Map(),
    rechecks: new Map(),
    judge: { costUsdMicros: 0, calls: 0 },
    replaysUsed: 0,
    headsUsed: 0,
    groundingTokens: 0,
    lastYield: performance.now(),
  };

  const definitions = citationDefinitions(text);
  const extracted = extractClaims(text, { bibliographic: config.sources.bibliographic });
  const all: Pending[] = [
    ...extracted.map((claim) => ({ claim })),
    ...definitionClaims(text, definitions, config.sources.bibliographic, extracted.length),
  ];

  // Every HEAD this verification will send, sent up front: a few at once,
  // under one deadline (`sendHeads`), not one at a time as each claim is
  // reached — in the order the claims ask, so the cap keeps the same URLs.
  // Collected into a set, and no further than the cap: the answer is
  // model-written, and a list searched once per URL it cites made this
  // quadratic in them (Pillar 3); a URL past the cap is `budget` anyway
  // (`headStatus`).
  if (sendsHeads(run)) {
    const urls = new Set<string>();
    collect: for (const { claim } of all) {
      for (const id of claim.markers) {
        if (urls.size >= MAX_HEAD_REQUESTS) break collect;
        const source = definitions.get(id);
        const url = source !== undefined ? definitionUrl(source) : undefined;
        if (url === undefined || urls.has(url) || hostRefusal(run, url) !== undefined) continue;
        urls.add(url);
      }
    }
    sendHeads(run, [...urls]);
  }

  const claims: ProofClaim[] = [];
  for (const pending of all) claims.push(await verifyClaim(run, pending, definitions));
  // The vacuous-pass backstop (design §2): nothing counted is a pass only
  // when nothing a reader sees cites or states a figure outside a question
  // (`backstopClaims`). The extractor's misses are read here, bluntly,
  // rather than one shape at a time.
  if (claims.every((claim) => claim.status === "assumption")) {
    const seen = all.map((pending) => pending.claim);
    for (const claim of backstopClaims(text, definitions, seen, all.length)) {
      claims.push(await verifyClaim(run, { claim }, definitions));
    }
  }

  // `max_assumptions` (design §2): assumptions are counted as DECLARED, and
  // the turn passes only when that count is within the cap. The hypotheses
  // an accepted proof rests on are assumptions too (design §6.4), counted
  // where the proof is first cited, each distinct one once. Past the cap,
  // in document order, an assumption claim is unmet with
  // `assumption_forbidden`, and so is a proof binding resting on a
  // hypothesis past it, so the nudge names them; under `assumptions:
  // forbid` every one already is. Either way each one is a refusal, and a
  // refusal fails the verdict whatever the score — otherwise a threshold
  // below 1 would pass an answer over the cap, the dodge the cap exists
  // to close.
  if (config.maxAssumptions !== undefined) {
    const cap = config.maxAssumptions;
    const detail = `past provability.max_assumptions (${cap})`;
    const numbered = new Map<string, number>();
    let declared = 0;
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i] as ProofClaim;
      if (claim.status === "assumption") {
        declared += 1;
        if (declared <= cap) continue;
        claims[i] = {
          ...claim,
          status: "unmet",
          bindings: claim.bindings.map((b) => ({
            ...b,
            reason: "assumption_forbidden" as const,
            detail,
          })),
        };
        continue;
      }
      let refused = false;
      const bindings = claim.bindings.map((b): ProofBinding => {
        if (b.kind !== "formal" || !b.ok || b.assumptions === undefined) return b;
        let past = false;
        for (const hypothesis of b.assumptions) {
          let n = numbered.get(hypothesis);
          if (n === undefined) {
            declared += 1;
            n = declared;
            numbered.set(hypothesis, n);
          }
          if (n > cap) past = true;
        }
        if (!past) return b;
        refused = true;
        return {
          ...b,
          rung: "none",
          ok: false,
          reason: "assumption_forbidden",
          detail: `the proof rests on hypotheses ${detail}`,
        };
      });
      if (refused) {
        claims[i] = {
          ...claim,
          status: statusOf(bindings),
          best: maxRung(...bindings.map((b) => b.rung)),
          bindings,
        };
      }
    }
  }

  const assumptions = claims.filter((c) => c.status === "assumption").length;
  const assumptionsRefused = claims.filter(refusedForAssumptions).length;
  const met = claims.filter((c) => c.status === "met").length;
  const unmet = claims.filter((c) => c.status === "unmet").length;
  const counted = claims.length - assumptions;
  const vacuous =
    claims.length === 0
      ? "no claims to prove"
      : counted === 0
        ? "every claim is an assumption"
        : undefined;
  const score = counted === 0 ? 1 : met / counted;
  const assumptionsOk = assumptionsRefused === 0;
  const verdict =
    (counted === 0 || met >= needed(config.threshold, counted)) && assumptionsOk ? "pass" : "fail";

  // A refused assumption fails the turn at every floor, so the answer would
  // have passed none.
  let achieved: Rung = "none";
  if (assumptionsOk && counted === 0) achieved = config.level;
  else if (assumptionsOk) {
    const ceilings = claims
      .filter((c) => c.status !== "assumption")
      .map((c) => levelRank(claimCeiling(run, c)));
    for (const level of [...PROVABILITY_LEVELS].reverse()) {
      const reaching = ceilings.filter((rank) => rank >= levelRank(level)).length;
      if (reaching >= needed(config.threshold, counted) && reaching > 0) {
        achieved = level;
        break;
      }
    }
  }

  // "N sources" beside the floor: at `cited` the origins cited, which is
  // all that rung asks of a source; at `grounded` and above the origins
  // that grounded a claim. Counting only grounded origins at `cited` put
  // "0 sources" beside a passing answer that cites a URL in every claim.
  const sourceRung = levelRank(config.level === "cited" ? "cited" : "grounded");
  const sourceOrigins = new Set<string>();
  // Of those, the ones the run wrote itself (`ProofBinding.writtenBy`). A
  // FactCrossCheck of a file the run wrote stands where that file would
  // (`factCheckSupport`): it counts as a source, the run's own.
  const selfWritten = new Set<string>();
  const hypotheses = new Set<string>();
  const backing = new Set<string>();
  let judgeWaived = 0;
  for (const claim of claims) {
    for (const b of claim.bindings) {
      const asSource = b.kind === "source" || (b.kind === "execution" && b.writtenBy !== undefined);
      if (asSource && levelRank(b.rung) >= sourceRung && b.origin) {
        sourceOrigins.add(b.origin);
        if (b.writtenBy !== undefined) selfWritten.add(b.origin);
      }
      if (b.kind === "formal" && b.ok && b.origin !== undefined) {
        backing.add(b.origin);
        for (const hypothesis of b.assumptions ?? []) hypotheses.add(hypothesis);
      }
      if (b.judgeWaived === true) judgeWaived += 1;
    }
  }

  // The checkers whose artifacts back a proven binding that still stands.
  const checkers = [...run.checkers.values()].filter((entry) => backing.has(entry.artifact));
  const core: Omit<ProofBundle, "bundleHash"> = {
    version: 1,
    level: config.level,
    verdict,
    score,
    threshold: config.threshold,
    achieved,
    claims,
    claimCount: claims.length,
    met,
    unmet,
    assumptions,
    ...(assumptionsRefused > 0 ? { assumptionsRefused } : {}),
    ...(hypotheses.size > 0 ? { hypotheses: hypotheses.size } : {}),
    sources: sourceOrigins.size,
    ...(selfWritten.size > 0 ? { selfWritten: selfWritten.size } : {}),
    judgeWaived,
    retryIndex: opts.retryIndex ?? 0,
    ...(checkers.length > 0 ? { checkers } : {}),
    ...(vacuous !== undefined ? { vacuous } : {}),
    ...(run.judge.model !== undefined ? { judgeModel: run.judge.model } : {}),
    ...(run.judge.calls > 0 ? { spentUsdMicros: run.judge.costUsdMicros } : {}),
    createdAt: nowOf(opts.now).toISOString(),
  };
  return { ...core, bundleHash: bundleHash(core) };
}
