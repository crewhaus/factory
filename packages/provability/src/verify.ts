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
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  type ClaimQuery,
  type EvidenceRef,
  type ExtractedClaim,
  type Location,
  NEGATIONS,
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
} from "@crewhaus/claim-ledger";
import { resolveContained } from "@crewhaus/tool-safety/fs";
import { isProofArtifact, isProofId } from "./artifact";
import { PROOF_CHECK, RETRIEVE, builtinKey } from "./builtins";
import {
  ProvabilityError,
  groundingBody,
  inputStrings,
  isReader,
  originFieldValues,
  restrictToTurns,
  servesPage,
  sha256Of,
} from "./evidence";
import { isProvabilityLevel, levelRank, maxRung, meetsFloor } from "./levels";
import {
  doiUrl,
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
  if (ref.kind === "url") return normalizeUrl(ref.url);
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

/** The `cited` checks for a workspace path: inside the workspace, links included, and there. */
function citedPath(run: Run, given: string): Reached | { readonly origin: string } {
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
  return { origin: rel };
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
    const values = originFieldValues(record.toolName, record.input, {
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
 */
function echoCheck(
  run: Run,
  record: EvidenceRecord,
  query: ClaimQuery,
  index: SourceIndex,
  location: Location,
): { readonly location: Location; readonly index: SourceIndex } | "echo" {
  const kept = { location, index };
  if (record.toolName === RETRIEVE) return kept;
  if (builtinKey(record.toolName) !== undefined && !isReader(record.toolName)) return kept;
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
  return clipAround(words.text, from, to, MAX_EXCERPT_CHARS);
}

/** A source binding as `grounded` leaves it, and the paraphrase miss the judge may still waive. */
type SourceOutcome = { readonly reached: Reached; readonly waivable?: Waivable };

/**
 * The `grounded` check: the origin was read in this run, and the claim's
 * words are in it. A body is a record that is not an error and whose
 * fetch answered 2xx (`servesPage`): an error page carries the words of
 * whatever path it repeats.
 */
async function grounded(run: Run, claim: ExtractedClaim, origin: string): Promise<SourceOutcome> {
  const records = run.evidence.bySource(origin);
  const usable = records.filter((record) => !record.isError && servesPage(record.status));
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
  let waivable: { location: Location; index: SourceIndex; sha256: string } | undefined;
  let miss: { location: Location; sha256: string } | undefined;
  let echoed: EvidenceRecord | undefined;
  let addressOnly: EvidenceRecord | undefined;
  let unread = false;
  for (const record of usable) {
    if (run.groundingTokens >= groundingBudget) {
      unread = true;
      break;
    }
    const body = bodyOf(run, record);
    run.groundingTokens += body.index.tokens.length;
    let location = locateClaim(query, body.index, options);
    let index = body.index;
    if (location.status === "supported" || isWaivableMiss(location)) {
      // Before it grounds — or reaches the judge, who would be asked whether
      // the model's own words support it — is it the call's input handed back?
      const read = echoCheck(run, record, query, body.index, location);
      if (read === "echo") {
        // A reader's echo is its own address printed back: the page was
        // read, and its own text does not carry the claim.
        if (isReader(record.toolName)) addressOnly ??= record;
        else echoed ??= record;
        continue;
      }
      location = read.location;
      index = read.index;
    }
    if (location.status === "supported") {
      const excerpt = groundedExcerpt(run, query, index, location);
      return {
        reached: {
          rung: "grounded",
          origin,
          sha256: body.sha256,
          ...(excerpt !== undefined ? { excerpt } : {}),
        },
      };
    }
    if (location.status === "polarityConflict") polarity ??= { location, sha256: body.sha256 };
    else if (isWaivableMiss(location)) {
      if (
        waivable === undefined ||
        location.matched / location.total > waivable.location.matched / waivable.location.total
      ) {
        waivable = { location, index, sha256: body.sha256 };
      }
    } else miss ??= { location, sha256: body.sha256 };
  }
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
    (echoed !== undefined || addressOnly !== undefined) &&
    waivable === undefined &&
    miss === undefined
  ) {
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
  } else {
    const written = ref.kind === "url" ? ref.url : ref.doi;
    const url = ref.kind === "url" ? normalizeUrl(ref.url) : doiUrl(ref.doi);
    if (url === undefined) {
      return {
        reached: fail("none", "not_locatable", `${clip(written, 120)} is not a well-formed URL`),
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

/**
 * Does the result carry the claim only as the call's own input handed back
 * (design §10: a real-but-irrelevant tool result fails `checked`)? The
 * claim at its tightest in the result ({@link tightestRuns}) is looked for,
 * word for word, in each string the input carries — `grounded`'s echo test
 * (`echoCheck`) applied to an execution binding. A tool the gate allows
 * because it is pure can still be one that returns what it is given
 * (NormalizeText, WrapText, a fact-check that repeats the claim it was
 * asked about): its result is the model's sentence, not a computation.
 * What stays open is text the tool reassembles from several input strings
 * (a template filled from parts): no one input string holds it.
 */
function handsBack(facts: CallFacts, record: EvidenceRecord, claimText: string): boolean {
  const { strings } = inputOf(facts, record);
  if (strings.length === 0) return false;
  const runs = tightestRuns(
    resultOf(facts).index.tokens.map((token) => token.norm),
    new Set(claimWords(claimText).map(wordKey)),
  );
  return (
    runs.length > 0 &&
    runs.every((words) => strings.some((input) => findSequence(input, words) !== -1))
  );
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
    excerpt = clipAround(index.text, first.at, last.at + last.raw.length, MAX_EXCERPT_CHARS);
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
  // Value containment (design §6.3): a figure or a quotation the claim
  // states must be in what the tool returned. A claim with neither still has
  // to be ABOUT the result — an allowed tool's unrelated output must not
  // check any sentence that cites it — so its words are measured against the
  // call (input and result) at the grounded bar.
  const numbers = extractNumbers(claim.text);
  const quotes = quotedSpans(claim.text);
  if (numbers.length > 0 || quotes.length > 0) {
    facts.numbers ??= new Set(extractNumbers(content));
    const stated = facts.numbers;
    const absent = [
      ...numbers.filter((value) => !containsValue(stated, value)),
      ...quotes.filter((quote) => !containsQuote(content, quote)).map((q) => `"${q.text}"`),
    ];
    if (absent.length > 0) {
      return valueAbsent(`does not contain ${absent.slice(0, 6).join(", ")}`);
    }
  }
  if (numbers.length > 0) {
    // The figures are there; which way the sentence around them points is
    // read word by word, where the result speaks to those figures.
    facts.polarity ??= resultPolarity(content);
    const opposite = figurePolarity(claim.text, facts.polarity);
    if (opposite !== undefined) return valueAbsent(opposite);
  } else {
    const bar = run.config.grounded.coverage;
    if (facts.said === undefined) {
      const said = `${content}\n${inputText(record.input)}`;
      facts.said = { tokens: contentTokens(said), index: indexSource(said) };
    }
    if (quotes.length === 0) {
      const words = contentTokens(claim.text);
      const share = coverage(words, facts.said.tokens);
      if (share < bar) {
        return valueAbsent(
          `does not carry this claim: the claim states no figure or quotation, and ${percent(share)} of its words are in the call's input and result (needs ${percent(bar)})`,
        );
      }
      // The input is read beside the result so a claim may name what the
      // call was asked ("the currency rounding check") and state what came
      // back ("found no drift"). But when the input ALONE carries the claim,
      // the input is all the call says of it — a lint run over the draft
      // answer, handed the very sentence that cites it, would otherwise
      // check any sentence at all — so the result has to carry it too.
      if (coverage(words, inputOf(facts, record).tokens) >= bar) {
        const own = coverage(words, resultOf(facts).tokens);
        if (own < bar) {
          return valueAbsent(
            `does not carry this claim: its words are the call's own input, and ${percent(own)} of them are in what the tool returned (needs ${percent(bar)})`,
          );
        }
      }
    }
    if (handsBack(facts, record, claim.text)) {
      return valueAbsent(
        "hands the call's own input back: the claim's words in it are text the call was given — cite a result that computes or reads what the claim states",
      );
    }
    // The words are there; the coverage measure cannot see which way they
    // point. The locate kernel, which keeps negations and number words,
    // reads the call for the claim (or for the framing of its quotation).
    const opposite = wordPolarity(run, claim.text, facts.said.index);
    if (opposite !== undefined) return valueAbsent(opposite);
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
    excerpt: executionExcerpt(facts, claim.text, numbers.length > 0, quotes.length > 0),
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
 *   too ({@link partitiveDenial}).
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

/** Distinct independence keys among a claim's source bindings that reached `grounded`. */
function groundedOrigins(bindings: ReadonlyArray<ProofBinding>): Set<string> {
  const keys = new Set<string>();
  for (const b of bindings) {
    if (
      b.kind === "source" &&
      levelRank(b.rung) >= levelRank("grounded") &&
      b.origin !== undefined
    ) {
      keys.add(independenceKey(b.origin));
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
  const keys = groundedOrigins(bindings);
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
    return groundedOrigins(bindings).size < n;
  };
  if (n > 1) {
    const could = groundedOrigins(bindings);
    for (const b of bound) {
      if (b.waivable !== undefined) could.add(independenceKey(b.waivable.origin));
    }
    if (could.size < n) return bindings;
  }
  for (const [i, b] of bound.entries()) {
    if (b.waivable === undefined) continue;
    if (!needed()) break;
    if (n > 1 && groundedOrigins(bindings).has(independenceKey(b.waivable.origin))) continue;
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
  if (n > 1 && best === "grounded" && groundedOrigins(evidence).size < n) return "cited";
  return best;
}

/** A claim to verify, and the definition whose text it is when it is one. */
type Pending = { readonly claim: ExtractedClaim; readonly definition?: string };

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
  if (sendsHeads(run)) {
    const urls: string[] = [];
    for (const { claim } of all) {
      for (const id of claim.markers) {
        const source = definitions.get(id);
        const url = source !== undefined ? definitionUrl(source) : undefined;
        if (url === undefined || urls.includes(url) || hostRefusal(run, url) !== undefined) {
          continue;
        }
        urls.push(url);
      }
    }
    sendHeads(run, urls.slice(0, MAX_HEAD_REQUESTS));
  }

  const claims: ProofClaim[] = [];
  for (const { claim, definition } of all) {
    // Long answers over large bodies are real work: let timers, aborts and
    // the process's other sessions run between claims.
    if (performance.now() - run.lastYield >= YIELD_EVERY_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      run.lastYield = performance.now();
    }
    const bound: Bound[] = [];
    for (const id of claim.markers) bound.push(await bindingFor(run, claim, id, definitions));
    const settled = applyIndependence(run, await waive(run, bound));
    claims.push({
      index: claim.index,
      text: clip(claim.text, MAX_CLAIM_CHARS),
      ...(claim.line > 0 ? { line: claim.line } : {}),
      status: statusOf(settled),
      best: maxRung(...settled.map((b) => b.rung)),
      bindings: settled,
      ...(definition !== undefined ? { definition } : {}),
    });
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
  const hypotheses = new Set<string>();
  const backing = new Set<string>();
  let judgeWaived = 0;
  for (const claim of claims) {
    for (const b of claim.bindings) {
      if (b.kind === "source" && levelRank(b.rung) >= sourceRung && b.origin) {
        sourceOrigins.add(b.origin);
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
