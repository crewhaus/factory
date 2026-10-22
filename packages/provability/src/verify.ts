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
  claimFigures,
  claimQuery,
  claimWords,
  classifyDefinition,
  clauseNumbers,
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
import { RETRIEVE, builtinKey } from "./builtins";
import {
  ProvabilityError,
  groundingBody,
  inputStrings,
  restrictToTurns,
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
/** How much of a span `echoedSpan` re-reads when the excerpt was cut at 240. */
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

/** Does the text state a grammatical negation (claim-ledger's `NEGATIONS`)? */
function negated(text: string): boolean {
  for (const token of tokenize(foldTypography(text))) if (NEGATIONS.has(token.norm)) return true;
  return false;
}

/** The figures a text states, by the key they are compared under (`thirty` and `30` are one). */
function figureKeys(text: string): Set<string> {
  return new Set(claimFigures(text).map((word) => figureKey(word) ?? word));
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
};

type Judged = { model?: string; costUsdMicros: number; calls: number };

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
  /** The result as the figure polarity rule reads it (`figurePolarity`). */
  polarity?: ResultPolarity;
};

/**
 * One result as {@link figurePolarity} reads it, worked out once per call:
 * its tokens, the clause each sits in, where each clause starts, and where
 * each figure occurs.
 */
type ResultPolarity = {
  readonly index: SourceIndex;
  /** The clause each token sits in (claim-ledger `clauseNumbers`). */
  readonly clause: Uint32Array;
  /** The first token of each clause, by clause number. */
  readonly clauseStarts: readonly number[];
  /** Where each figure occurs, by {@link polarityKey} (`#<value>`). */
  readonly figureAt: ReadonlyMap<string, readonly number[]>;
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
  readonly heads: Map<string, Promise<number | undefined>>;
  readonly bodies: Map<object, { readonly index: SourceIndex; readonly sha256: string }>;
  readonly calls: Map<object, CallFacts>;
  /** Each call's input strings, indexed, by the input itself (`echoedSpan`). */
  readonly inputs: Map<unknown, readonly SourceIndex[]>;
  readonly replays: Map<string, Promise<ReplayOutcome>>;
  readonly artifacts: Map<string, Promise<ProofArtifact | undefined>>;
  readonly checkers: Map<
    string,
    { readonly id: string; readonly artifact: string; readonly axioms: readonly string[] }
  >;
  readonly judge: Judged;
  replaysUsed: number;
  headsUsed: number;
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

async function headStatus(run: Run, url: string): Promise<number | undefined | "budget"> {
  let pending = run.heads.get(url);
  if (pending === undefined) {
    if (run.headsUsed >= MAX_HEAD_REQUESTS) return "budget";
    run.headsUsed += 1;
    const resolve = run.opts.resolveHead;
    pending = (async (): Promise<number | undefined> => {
      if (resolve === undefined) return undefined;
      try {
        const status = await resolve(url);
        return typeof status === "number" && Number.isFinite(status) ? status : undefined;
      } catch {
        return undefined;
      }
    })();
    run.heads.set(url, pending);
  }
  return pending;
}

/** The `cited` checks for a URL (or a DOI's resolver URL). */
async function citedUrl(run: Run, url: string): Promise<Reached | undefined> {
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
  // Reachability matters only where a source can meet the floor: at
  // `checked` and `proven` no source binding does, so no request is made.
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

/** The input strings of a call, each indexed once per run however many claims ask. */
function inputIndexes(run: Run, record: EvidenceRecord): readonly SourceIndex[] {
  let indexes = run.inputs.get(record.input);
  if (indexes === undefined) {
    indexes = inputStrings(record.input)
      .filter((value) => value.trim() !== "")
      .map((value) => indexSource(value));
    run.inputs.set(record.input, indexes);
  }
  return indexes;
}

/**
 * Is the span of `record` that carries the claim the call's own input
 * handed back (design §10)?
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
 * Only for tools that are not builtins (nor Retrieve, which tool-categories
 * does not list): the readers (`WebFetch`, `Fetch`, `Read`) return the
 * content of what they were pointed at, and Retrieve returns corpus text,
 * never its query. A search hit whose claim-bearing run is a phrase the
 * model searched for word for word is refused as well — the gate cannot
 * tell that from a reflection, and fetching the page grounds it. What stays
 * open is reflected text the tool rewrites on the way out (an SQL function
 * applied to the literal): closing that needs the spec to say which tools'
 * hits are trusted — a design decision, not made here.
 */
function echoedSpan(
  run: Run,
  record: EvidenceRecord,
  query: ClaimQuery,
  index: SourceIndex,
  location: Location,
): boolean {
  if (record.toolName === RETRIEVE || builtinKey(record.toolName) !== undefined) return false;
  const inputs = inputIndexes(run, record);
  if (inputs.length === 0) return false;
  let span = location.excerpt ?? "";
  if (span.endsWith("…")) {
    // The excerpt is cut at 240 characters; the test needs the span itself.
    const whole = locateClaim(query, index, {
      coverage: run.config.grounded.coverage,
      windowTokens: run.config.grounded.windowTokens,
      strictFigures: true,
      maxExcerptChars: MAX_ECHO_SPAN_CHARS,
    }).excerpt;
    if (whole !== undefined) span = whole;
  }
  const words = tokenize(foldTypography(span)).map((token) => token.norm);
  // A span still cut ends on a word that may be partial.
  if (span.endsWith("…")) words.pop();
  const runs = tightestRuns(words, new Set(query.need.map(wordKey)));
  if (runs.length === 0) return false;
  return runs.every((run) => inputs.some((input) => findSequence(input, run) !== -1));
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

/** The `grounded` check: the origin was read in this run, and the claim's words are in it. */
async function grounded(run: Run, claim: ExtractedClaim, origin: string): Promise<Reached> {
  const records = run.evidence.bySource(origin);
  const usable = records.filter((record) => !record.isError);
  if (usable.length === 0) {
    return fail(
      "cited",
      "not_fetched",
      records.length > 0
        ? `every read of ${origin} in this run returned an error`
        : `${origin} was never fetched or read in this run`,
      { origin },
    );
  }
  const { coverage: bar, windowTokens } = run.config.grounded;
  // The figure rule on at every bar (claim-ledger `strictFigures`): it is
  // on by default only below full coverage, so a spec that tightened
  // `coverage` to 1 would otherwise switch it off — and with it the check
  // that a quotation's framing figures agree with the source ("the window
  // is 30 days, since \"customers may request a refund\"" against a source
  // saying 14), and figures compared as values (`thirty` and `30`).
  const options = { coverage: bar, windowTokens, strictFigures: true };
  const query = claimQuery(claim.text);
  let polarity: { location: Location; sha256: string } | undefined;
  let waivable: { location: Location; sha256: string } | undefined;
  let miss: { location: Location; sha256: string } | undefined;
  let echoed: EvidenceRecord | undefined;
  for (const record of usable) {
    const body = bodyOf(run, record);
    const location = locateClaim(query, body.index, options);
    if (location.status === "supported") {
      if (echoedSpan(run, record, query, body.index, location)) {
        echoed ??= record;
        continue;
      }
      return {
        rung: "grounded",
        origin,
        sha256: body.sha256,
        ...(location.excerpt !== undefined
          ? { excerpt: clip(location.excerpt, MAX_EXCERPT_CHARS) }
          : {}),
      };
    }
    if (location.status === "polarityConflict") polarity ??= { location, sha256: body.sha256 };
    else if (isWaivableMiss(location)) {
      // The judge would be asked whether the model's own words support it.
      if (echoedSpan(run, record, query, body.index, location)) {
        echoed ??= record;
        continue;
      }
      if (
        waivable === undefined ||
        location.matched / location.total > waivable.location.matched / waivable.location.total
      ) {
        waivable = { location, sha256: body.sha256 };
      }
    } else miss ??= { location, sha256: body.sha256 };
  }
  if (polarity !== undefined) {
    return fail(
      "cited",
      "polarity_conflict",
      `${origin} carries the claim's words with a negation the claim lacks`,
      { origin, sha256: polarity.sha256 },
    );
  }
  if (echoed !== undefined && waivable === undefined && miss === undefined) {
    // Everything under this origin that carries the claim is text the run
    // sent itself: the origin was named, never read.
    return fail(
      "cited",
      "not_fetched",
      `${origin} was never read in this run: the only text under it that carries this claim is the input ${echoed.toolUseId} (${echoed.toolName}) was given, handed back — fetch the page itself`,
      { origin },
    );
  }
  // The waiver judge: ONLY for a paraphrase miss on coverage alone (design
  // §6.2), only where `grounded` is the floor — at `cited` the binding meets
  // the floor without it, and at `checked`/`proven` no source binding can —
  // and never for a missing figure or negation (`isWaivableMiss`).
  if (waivable !== undefined && run.floor === "grounded" && run.opts.judgeWaiver !== undefined) {
    const excerpt = waivable.location.excerpt ?? "";
    try {
      run.judge.calls += 1;
      const verdict = await run.opts.judgeWaiver({ claim: claim.text, excerpt, source: origin });
      if (typeof verdict.model === "string") run.judge.model ??= verdict.model;
      // The spend is the judge's report: a NaN or a negative would poison
      // the bundle's total (and serialize as null), so only a real cost counts.
      const cost = verdict.costUsdMicros;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        run.judge.costUsdMicros += cost;
      }
      if (verdict.supported === true) {
        return {
          rung: "grounded",
          origin,
          sha256: waivable.sha256,
          ...(excerpt !== "" ? { excerpt: clip(excerpt, MAX_EXCERPT_CHARS) } : {}),
          judgeWaived: true,
        };
      }
    } catch {
      // A judge that fails waives nothing; the binding keeps its miss.
    }
  }
  const reported = waivable ?? miss;
  const location = reported?.location;
  const missing = location?.missing ?? [];
  return fail(
    "cited",
    "not_found_in_source",
    location?.status === "misquoted"
      ? `${origin} does not carry the quotation word for word`
      : `the claim's words are not together in one ${windowTokens}-token window of ${origin}${
          missing.length > 0 ? ` (missing: ${missing.slice(0, 8).join(", ")})` : ""
        }`,
    { origin, ...(reported !== undefined ? { sha256: reported.sha256 } : {}) },
  );
}

async function sourceBinding(run: Run, claim: ExtractedClaim, ref: SourceRef): Promise<Reached> {
  if (ref.kind === "text") {
    if (!run.config.sources.bibliographic) {
      return fail(
        "none",
        "not_locatable",
        `"${clip(ref.text, 80)}" is not a URL, a doi: or a workspace path`,
      );
    }
    return fail(
      "cited",
      "not_locatable",
      "a bibliographic reference names no body this run read — cite its URL, DOI or workspace path to ground the claim",
    );
  }
  let origin: string;
  if (ref.kind === "path") {
    const located = citedPath(run, ref.path);
    if ("rung" in located) return located;
    origin = located.origin;
  } else {
    const written = ref.kind === "url" ? ref.url : ref.doi;
    const url = ref.kind === "url" ? normalizeUrl(ref.url) : doiUrl(ref.doi);
    if (url === undefined) {
      return fail("none", "not_locatable", `${clip(written, 120)} is not a well-formed URL`);
    }
    const refused = await citedUrl(run, url);
    if (refused !== undefined) return refused;
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

function resultPolarity(content: string): ResultPolarity {
  const index = indexSource(content);
  const clause = clauseNumbers(index);
  const clauseStarts: number[] = [];
  const figureAt = new Map<string, number[]>();
  index.tokens.forEach((token, i) => {
    if (clauseStarts.length <= (clause[i] as number)) clauseStarts.push(i);
    const key = polarityKey(token);
    if (!key.startsWith("#")) return;
    const at = figureAt.get(key);
    if (at === undefined) figureAt.set(key, [i]);
    else at.push(i);
  });
  return { index, clause, clauseStarts, figureAt };
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
 * speaks to the claimed figures:
 *
 * - A figure the claim denies ("the total is NOT 1,284.50") must be denied
 *   in the result too. A result that states it, unnegated, everywhere it
 *   appears says the reverse.
 * - Any other word of the claim, figure or not, that the result denies
 *   everywhere it appears in a clause holding one of the claim's figures,
 *   while the claim states it: "91 is NOT prime" does not check "91 is
 *   prime". The same word stated by the result where the claim denies it is
 *   the reverse case ("91 is not prime" citing "91 is prime").
 *
 * A word the result never uses, or uses only in clauses about other figures
 * (a JSON field of its own, a sentence about something else), tells nothing
 * either way. The detail names the claim's own word, never the result's
 * text: it reaches the retry nudge.
 */
function figurePolarity(claimText: string, result: ResultPolarity): string | undefined {
  const claim = indexSource(claimText);
  const words = new Set(claimWords(claimText));
  const figures = new Set<string>();
  const stated = new Map<string, { raw: string; denied: number; asserted: number }>();
  claim.tokens.forEach((token, i) => {
    if (!words.has(token.norm) || NEGATIONS.has(token.norm)) return;
    const key = polarityKey(token);
    if (key.startsWith("#")) figures.add(key);
    const entry = stated.get(key) ?? { raw: token.raw, denied: 0, asserted: 0 };
    if (deniedAt(claim, i)) entry.denied += 1;
    else entry.asserted += 1;
    stated.set(key, entry);
  });
  // Where the result speaks to the claimed figures: every clause holding
  // one. Only those are read for the claim's other words, so a result cited
  // by many claims is read clause by clause, never word by word per claim.
  const clauses = new Set<number>();
  for (const key of figures) {
    for (const at of result.figureAt.get(key) ?? []) clauses.add(result.clause[at] as number);
  }
  const occurrences = new Map<string, number[]>();
  for (const n of clauses) {
    const end = result.clauseStarts[n + 1] ?? result.index.tokens.length;
    for (let at = result.clauseStarts[n] as number; at < end; at++) {
      const key = polarityKey(result.index.tokens[at] as SourceToken);
      if (key.startsWith("#") || !stated.has(key)) continue;
      const list = occurrences.get(key);
      if (list === undefined) occurrences.set(key, [at]);
      else list.push(at);
    }
  }
  for (const [key, word] of stated) {
    // A claim that both states and denies one word says too much to read.
    if (word.denied > 0 && word.asserted > 0) continue;
    const figure = key.startsWith("#");
    const there = (figure ? result.figureAt.get(key) : occurrences.get(key)) ?? [];
    const denials = there.filter((at) => deniedAt(result.index, at)).length;
    if (word.denied > 0) {
      if ((figure || there.length > 0) && denials === 0) {
        return figure
          ? `states no negation of ${word.raw}, and the claim denies it — state only what the result says`
          : `says the opposite: it states "${word.raw}" beside the figure, where the claim denies it`;
      }
    } else if (there.length > 0 && denials === there.length) {
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
    if (facts.said === undefined) {
      const said = `${content}\n${inputText(record.input)}`;
      facts.said = { tokens: contentTokens(said), index: indexSource(said) };
    }
    if (quotes.length === 0) {
      const share = coverage(contentTokens(claim.text), facts.said.tokens);
      if (share < run.config.grounded.coverage) {
        return valueAbsent(
          `does not carry this claim: the claim states no figure or quotation, and ${Math.round(share * 100)}% of its words are in the call's input and result (needs ${Math.round(run.config.grounded.coverage * 100)}%)`,
        );
      }
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
  facts.excerpt ??= clip(content, MAX_EXCERPT_CHARS);
  return {
    rung: "checked",
    ...base,
    excerpt: facts.excerpt,
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

/**
 * Why the answer's sentence does not state what a proof's recorded claim
 * says, or `undefined` when it does (design §6.4): "the grounded coverage
 * test", read the way `grounded` reads it — the words, AND the figures and
 * the negations that coverage alone cannot see.
 *
 * - Words: the artifact claim's content tokens covered by the sentence's
 *   at the grounded bar, so an accepted proof of something else cannot be
 *   pinned to this sentence.
 * - Polarity: a negation on one side and not the other is the opposite
 *   statement. `contentTokens` drops "no" (two letters) and "not" (a
 *   stopword), so without this an accepted proof that two of the six
 *   meetings overlap would prove "no two of the six meetings overlap" —
 *   acceptance scenario C served false.
 * - Figures: the same figures on both sides (`two` and `2` are one). A
 *   proof about meetings 1 and 2 does not prove a sentence about all six,
 *   and `contentTokens` drops one- and two-digit numbers.
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
  const provedNegated = negated(proved);
  if (provedNegated !== negated(sentence)) {
    return provedNegated
      ? "the proof's claim is negated and this sentence is not — it states the opposite"
      : "this sentence is negated and the proof's claim is not — it states the opposite";
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
  return undefined;
}

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
  const shown = {
    ...base,
    sha256: artifact.outputDigest,
    checker: artifact.checker,
    statement: clip(artifact.statement, MAX_STATEMENT_CHARS),
  };
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
  const mismatch = statementMismatch(artifact.claim, claim.text, run.config.grounded.coverage);
  if (mismatch !== undefined) {
    return fail(
      "none",
      "claim_mismatch",
      `${proofId} proves "${clip(artifact.claim, 160)}"; ${mismatch}`,
      shown,
    );
  }
  const key = `${artifact.checker}\u0000${proofId}`;
  if (!run.checkers.has(key)) {
    run.checkers.set(key, {
      id: artifact.checker,
      artifact: proofId,
      axioms: [...artifact.axioms],
    });
  }
  return { rung: "proven", ...shown };
}

// ---------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------

/**
 * An evidence id as the model may have dressed it — `` tool:`toolu_01` ``,
 * `proof:prf_….` at the end of a sentence — down to the id. Ids are
 * `[A-Za-z0-9_-]` runs, so wrapping quotes, backticks and angle brackets and
 * trailing sentence punctuation are never part of one.
 */
function bareId(id: string): string {
  return id.replace(/^[`'"<(]+/, "").replace(/[`'">).,;:!?]+$/, "");
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
): Promise<ProofBinding> {
  const ref = refOf(id, claim.raw);
  const source = definitions.get(id);
  if (source === undefined) {
    return finish(
      ref,
      "source",
      fail("none", "no_definition", `${ref} has no "${ref}: …" definition line`),
      run.floor,
    );
  }
  const evidence = classifyDefinition(source);
  switch (evidence.kind) {
    case "assume":
      if (run.config.assumptions === "forbid") {
        return finish(
          ref,
          "assumption",
          fail("none", "assumption_forbidden", "provability.assumptions is forbid", {
            origin: clip(evidence.text, MAX_CLAIM_CHARS),
          }),
          run.floor,
        );
      }
      // Not evidence and not a failure: the claim's status says what it is.
      return {
        ref,
        kind: "assumption",
        rung: "none",
        ok: false,
        origin: clip(evidence.text, MAX_CLAIM_CHARS),
      };
    case "tool":
      return finish(
        ref,
        "execution",
        await executionBinding(run, claim, bareId(evidence.toolUseId)),
        run.floor,
      );
    case "proof":
      return finish(
        ref,
        "formal",
        await formalBinding(run, claim, bareId(evidence.proofId)),
        run.floor,
      );
    default:
      return finish(ref, "source", await sourceBinding(run, claim, evidence), run.floor);
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

/** Is every marker of the claim an `assume:` definition — allowed or refused? */
function assumptionOnly(claim: ProofClaim): boolean {
  return claim.bindings.length > 0 && claim.bindings.every((b) => b.kind === "assumption");
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
 */
export function unverifiedBundle(
  config: ProvabilityConfig,
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
    replays: new Map(),
    artifacts: new Map(),
    checkers: new Map(),
    judge: { costUsdMicros: 0, calls: 0 },
    replaysUsed: 0,
    headsUsed: 0,
  };

  const definitions = citationDefinitions(text);
  const extracted = extractClaims(text, { bibliographic: config.sources.bibliographic });
  const all: Pending[] = [
    ...extracted.map((claim) => ({ claim })),
    ...definitionClaims(text, definitions, config.sources.bibliographic, extracted.length),
  ];

  const claims: ProofClaim[] = [];
  for (const { claim, definition } of all) {
    const bindings: ProofBinding[] = [];
    for (const id of claim.markers) bindings.push(await bindingFor(run, claim, id, definitions));
    const settled = applyIndependence(run, bindings);
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
  // the turn passes only when that count is within the cap. Past it, the
  // extra assumption claims (in document order) are also unmet with
  // `assumption_forbidden`, so the nudge names them; under `assumptions:
  // forbid` every one already is. Either way each one is a refusal, and a
  // refusal fails the verdict whatever the score — otherwise a threshold
  // below 1 would pass an answer over the cap, the dodge the cap exists
  // to close.
  let declared = 0;
  if (config.maxAssumptions !== undefined) {
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i] as ProofClaim;
      if (claim.status !== "assumption") continue;
      declared += 1;
      if (declared <= config.maxAssumptions) continue;
      const detail = `past provability.max_assumptions (${config.maxAssumptions})`;
      claims[i] = {
        ...claim,
        status: "unmet",
        bindings: claim.bindings.map((b) => ({
          ...b,
          reason: "assumption_forbidden" as const,
          detail,
        })),
      };
    }
  }

  const assumptions = claims.filter((c) => c.status === "assumption").length;
  const assumptionsRefused = claims.filter((c) => c.status === "unmet" && assumptionOnly(c)).length;
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

  const groundedSources = new Set<string>();
  let judgeWaived = 0;
  for (const claim of claims) {
    for (const b of claim.bindings) {
      if (b.kind === "source" && levelRank(b.rung) >= levelRank("grounded") && b.origin) {
        groundedSources.add(b.origin);
      }
      if (b.judgeWaived === true) judgeWaived += 1;
    }
  }

  const checkers = [...run.checkers.values()];
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
    sources: groundedSources.size,
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
