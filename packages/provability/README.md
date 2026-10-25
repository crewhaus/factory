# @crewhaus/provability

The provability ladder: `cited`, `grounded`, `checked`, `proven`. A spec sets a floor, and every
claim in an answer must bind to evidence at or above it. This package is the deterministic part
of that: the evidence index built from the run's own event log, the four verifiers behind one
function (`verifyDocument`), the proof bundle they produce, the ways to render it, and where
bundles and proof artifacts are stored.

It makes no model call and imports no model adapter (`crewhaus doctor --philosophy-alignment`
checks that). The one model-backed step in the feature, the opt-in paraphrase waiver, is a
callback the caller injects, and so are the other two things that reach outside the process: the
HEAD request behind `sources.resolve: head` and the replay of a pure tool. The in-loop gate, the
`ProvabilityPreflight` tool, `crewhaus provability check` and the research report gate all call
the same `verifyDocument`, so a draft the model preflights is graded exactly as the gate will
grade it. Every text operation (claims, markers, definitions, the evidence-reference grammar,
locating a claim in a body, numbers, quotations, coverage) is
[`@crewhaus/claim-ledger`](../claim-ledger)'s; nothing here re-implements one.

```ts
import {
  buildEvidenceIndex,
  createBundleStore,
  createFileArtifactStore,
  evidenceFromMessages,
  evidenceFromSessionLog,
  proofsRoot,
  renderFooter,
  verifyDocument,
} from "@crewhaus/provability";

const root = proofsRoot(process.cwd(), "support-bot"); // <cwd>/.crewhaus/proofs/support-bot
const evidence = buildEvidenceIndex(
  [
    ...(await evidenceFromSessionLog({ sessionId })), // the log, sub-agent children included
    ...evidenceFromMessages(turnMessages), // the turn still in flight
  ],
  { sessionId },
);
const bundle = await verifyDocument(answerText, {
  config: ir.provability, // the lowered, fully resolved IrProvability
  evidence,
  artifacts: createFileArtifactStore({ rootDir: root }),
  replay, // optional: re-run a tool by name with its logged input
  isPureTool, // optional: (toolName) => whether replay may run it
  resolveHead, // optional: a guarded HEAD, for `sources.resolve: head`
  judgeWaiver, // optional: the paraphrase waiver
  retryIndex,
});
const path = await createBundleStore({ rootDir: root }).put(bundle, { sessionId, turnNumber });
console.log(renderFooter(bundle, { path }));
// ── provability · grounded ✓ · 6/6 claims · 3 sources · 0 assumptions · .crewhaus/proofs/…
```

## API

**Verifying.** `verifyDocument(text, opts: VerifyOptions): Promise<ProofBundle>`. Besides
`config` and `evidence`, the options are `workspaceRoot` and `baseDir` (where path sources
resolve), `stateRoots` (the run's own state directories, never a source), `artifacts` (a
`ProofArtifactStore`; absent, every `proof:` binding is `proof_missing`), `recheckProof`,
`trustStoredProofs`, `replay` and `isPureTool`, `resolveHead` and `headDeadlineMs`,
`judgeWaiver`, `turnNumbers` (`scope: turn`), `retryIndex` and `now`. Beside it:
`unverifiedBundle(config, error, retryIndex?, now?)` for a caller that caught a throw,
`bundleHash(bundle)`, `claimReasons(claim)`, `isToolAllowed(toolName, allow)`,
`statementMismatch(proved, sentence, bar)`, `independenceKey(origin)`, and the bounds
`MAX_HEAD_REQUESTS` (50), `HEAD_CONCURRENCY` (6), `HEAD_DEADLINE_MS` (15 000) and
`MAX_GROUNDING_TOKENS`. The errors this package raises are `ProvabilityError`s (a
`CrewhausError`): `code: "config"` for a malformed argument (a config without a valid `level`, an
invalid session id, spec name, turn number or artifact), `"runtime"` for a file the store
refused or could not read.

**Evidence.** `evidenceFromSessionLog({ sessionId, rootDir?, includeChildren?, maxDepth?,
workspaceRoot?, toolResultsRoot?, inputSchemaOf?, onUnreadable? })` and
`evidenceFromMessages(messages, opts?)` produce `EvidenceRecord`s; `recordFromCall(call, opts?)`
builds one; `buildEvidenceIndex(records, { sessionId? }): EvidenceIndex` merges them;
`restrictToTurns(index, turnNumbers)` scopes one. `evidenceFromSessionLog` throws a
`ProvabilityError` for a session id that is not `sess_<16 hex>`; a log it cannot read is
reported, not thrown (below). The readers behind them are exported too: `groundingBody`,
`servedFrom`, `servesPage`, `spilledOutput`, `sha256Of`.

**Rendering.** `renderFooter(bundle, { path? })` (the one-line footer), `renderBundleJson`,
`renderMarkdownSection` (the research report's `## Provability`), `renderNudge` (the retry
message) and `summarizeBundle(bundle): ProvabilityGradedSummary` (the `provability_graded` and
`provability_evaluated` payload).

**Storage.** `proofsRoot(cwd, specName)`, `createBundleStore({ rootDir }): BundleStore`
(`put`, `get`, `list`, `prune`), `createFileArtifactStore({ rootDir })`, and one definition of a
proof id and an artifact's shape: `PROOF_ID_REGEX`, `newProofId`, `isProofId`,
`isProofArtifact`.

**Levels, origins, purity.** `levelRank` (none 0, cited 1, grounded 2, checked 3, proven 4),
`rungOfRank`, `meetsFloor`, `maxRung`, `isProvabilityLevel`, `PROVABILITY_LEVELS`;
`normalizeUrl`, `normalizePath`, `originKey`, `hostOf`, `hostMatches`, `registrableDomain`,
`isPrivateHost`, `hasUserinfo`, `doiUrl`; and `isPureTool(tool)`, which tools replay may re-run
(read-only, concurrency-safe, not destructive, no sandbox, internal scope, no io capability).

**Types** (`types.ts`): `ProofBundle`, `ProofClaim`, `ProofBinding`, `UnmetReason`,
`EvidenceRecord`, `EvidenceIndex`, `ProofArtifact`, `ProofArtifactStore`, `VerifyOptions`,
`ProvabilityGradedSummary`, and `ProvabilityConfig` (the lowered `IrProvability`). The bundle's
wire schema is the zod `ProofBundle` in `@crewhaus/gateway-protocol`, held to this type by its
tests. `private-address.ts` is the repo's synchronised private-address classifier, a copy that
`apps/cli/src/tool-registry.test.ts` sweeps and executes: never edit it here alone.

## Who calls it

- `@crewhaus/evaluation-service`'s gate, which builds the index from the session log and the
  transcript, wires the stores, replay through the catalog, the guarded HEAD and the waiver judge,
  and hands runtime-core the closures.
- `@crewhaus/tool-proof`'s `ProvabilityPreflight`, which skips the HEAD, the replay and the judge.
- `crewhaus provability check`, offline over any document (with `trustStoredProofs` when it has
  no session log to read).
- `@crewhaus/report-writer`'s research report gate, over the citation tracker's cache.

## The rungs, as checked

- **cited.** Every marker in the claim has a definition, and the definition names something
  locatable: an `http(s)` URL or a `doi:` whose host passes `sources.allow` / `sources.deny`
  (deny wins; a DOI is checked as `doi.org`) and is not a private address, or a workspace path
  that stays inside the workspace with every symlink followed, and exists. A URL that puts a user
  name before its host (`https://acme.example@evil.example/`) is `host_denied`. Free text counts
  only under `sources.bibliographic: true`, and can never be grounded. With `sources.resolve:
  head` the URL must answer one HEAD with 2xx or 3xx: at most `MAX_HEAD_REQUESTS` per
  verification, `HEAD_CONCURRENCY` at once, all within `headDeadlineMs`; a URL past the cap or the
  deadline is `unresolved`. A dangling `[2]` beside a good `[1]` leaves the claim unmet
  (`no_definition`). A defined second marker that fails does not unmeet a claim another binding
  meets; the bundle still shows it.
- **grounded.** The cited origin was fetched or read in this run (not an error result, and not a
  fetch that answered outside 2xx), and claim-ledger's `locateClaim` finds the claim in that body
  at `grounded.coverage` within `grounded.window_tokens`. A quotation must appear verbatim; a
  figure or a negation is never excused by a partial bar, at `coverage: 1` too. The binding
  freezes an excerpt (240 characters at most, the claim at its tightest) and the body's digest,
  so the bundle stays checkable after the transcript is evicted. A path under the harness's own
  state (`.crewhaus/`, `.crewhaus-shared/`, and the `stateRoots` the caller names) is never a
  source, and neither is a copy of one (`CopyPath`, `MovePath`, `ConcatFiles`, the archive tools,
  followed back up to four steps): a session log holds every answer verbatim (`not_fetched`). A
  body a redirect brought from a host `sources.deny` or the private-address rule refuses does not
  ground the URL that led there. One verification reads at most `MAX_GROUNDING_TOKENS` of fetched
  text; a source past the budget reads `below_floor`, with a detail naming the cap.
- **checked.** `tool:<toolUseId>` resolves to a recorded, non-error call of a tool on
  `execution.allow`: the graded session's own call first, then a sub-agent's; an id only several
  sub-agents share is `tool_missing`. Every number the claim states is in the result as an exact
  decimal, and every quotation word for word; a claim with neither must share
  `grounded.coverage` of its words with the call. The result is read with the claim's words the
  input handed over blanked out where the tool repeats them, so a tool that only echoes the draft
  (NormalizeText of the sentence, a lint run over the answer) checks nothing, while a value
  selected from a document (JsonQuery over a record) does. A `FactCrossCheck` result counts only
  where it found this sentence `supported`. A figure's polarity is read word by word
  (claim-ledger's `governingNegation`) in the statement it sits in: a figure the claim denies
  must be denied in the result too, and "91 is not prime" or "91 (not prime)" does not check
  "91 is prime". At a `checked` floor, with `execution.replay` on and a pure tool, the gate
  re-runs it once per call (at most `max_replays` per verification) and compares digests: a
  mismatch is `replay_mismatch`; a replay that could not run leaves the binding `checked` with
  `replayed: false`.
- **proven.** `proof:prf_<16 hex>` names a stored artifact a checker on `formal.checkers`
  accepted, and the run's evidence holds the `ProofCheck` call that wrote it: accepted, with the
  assumptions and axioms the file lists, given exactly the checker, claim, statement and proof
  the file holds. The file sits in the workspace, where the model's file tools could forge one;
  the run's record of the check is what counts. Where `recheckProof` is wired (the gate and the
  preflight wire tool-proof's, the builtin checker), the checker accepts the stored proof again.
  The sentence must state the artifact's recorded `claim` (`statementMismatch`): its words cover
  the claim's at `grounded.coverage`, both state the same figures, and each word of the proof's
  claim is denied in both or in neither, so a proof that no two meetings overlap does not prove
  "two meetings overlap". The checker, the formal statement, the hypotheses the proof rests on
  (builtin `given` steps, SMT asserts and definitions) and the axioms go into the bundle beside
  the prose. Hypotheses are assumptions: counted in the footer, refused under `assumptions:
  forbid` and capped by `max_assumptions`.

## How each outcome is represented

- A claim with no marker is `unmet` with zero bindings; `claimReasons(claim)` reports it as
  `no_citation`.
- An allowed assumption binding is `ok: false` with no `reason`: not evidence, not a failure. A
  claim whose only bindings are allowed assumptions has status `assumption`, is left out of the
  score on both sides, and is always counted in the bundle and the footer. A refused assumption
  (`assumptions: forbid`, or past `max_assumptions` in document order) is `assumption_forbidden`
  and fails the verdict whatever the score, with `achieved: "none"`; the footer shows every
  declared one (`3 assumptions (2 refused)`).
- Under `grounded.independent: n` at a `grounded` floor, a claim met only through sources needs n
  distinct origins (`independenceKey`: registrable domain, DOI registrant prefix, or file), each
  read off the host that served the body. Short of that, each of its source bindings becomes
  `not_independent`. A claim met by an execution or formal binding is met regardless.
- A source the run wrote itself (a `Write` or `Edit` of the file, a PUT to the URL, or a copy of
  one) still grounds, because the file does say it now, but the binding carries
  `writtenBy: { toolUseId, toolName }`, the bundle counts it in `selfWritten`, and the footer
  reads `1 source (1 written by this run)`. A `FactCrossCheck` that found the claim only in such
  files reaches `grounded` at most. An MCP result that only hands back text an earlier call of
  the run sent (a stored row read back) is `not_fetched`.

## Things worth knowing

**The outside calls happen only where the floor needs them.** Rungs above the floor are still
computed, because `achieved` is the highest floor the answer would have passed, but without the
outside calls: the HEAD runs only at `cited` and `grounded`, the waiver judge only at `grounded`
and only for a miss claim-ledger calls waivable (`isWaivableMiss`: words partly found, none of
the missing ones a figure or a negation), and only while the claim still needs it. Replay runs
only at `checked`.

**Evidence comes from the log, merged with the transcript.** `evidenceFromSessionLog` walks child
sessions through their `sub_agent_start` brackets and places a child's calls where the bracket
sits. An id logged twice pairs its last `tool_use` with its last `tool_result`, the rule
continuity-store applies. A result the runtime spilled to a file is read whole from this call's
own file under the spill root, never through a link. A log that cannot be read to its end keeps
the records before that point and reports it through `onUnreadable`: fewer records fails closed.
A call is its session and its id together, because an OpenAI-compatible server numbers ids per
conversation and a parent and its child can share one.

**Origins are read off the call, and only where the result is that origin's content.** Among
builtins: `WebFetch`'s and `Fetch`'s `url` (a `Fetch` only when its method is GET, HEAD or
unset) and `Read`'s `path`, plus the final URL a WebFetch header names after a redirect. An MCP
tool's `url`/`uri`/`href`/`path`/`file`/`file_path`/`filePath` names an origin only when the
tool's declared schema lists that field (`inputSchemaOf`, default `defaultCatalog`'s), and, where no
schema is known, only when the input carries nothing else a call could have been pointed at.
The runtime's own tools whose results are model output (`Task`, `Consult`, `Escalate`, `Skill`,
the memory, plan and goal tools) name no origin. Hits are indexed under their own origins:
`Retrieve`'s `[n] id=… doc=…` blocks in exactly the structure Retrieve prints, and JSON
`url`/`uri`/`href`/`link`/`source` hits from an MCP tool whose input names no URL or path. When a
body is grounded against, WebFetch's header and the `[user prompt: …]` line it prepends, and
Fetch's status line and headers, are removed.

**The text a definition line shows is read.** `[8]: https://acme.example/x Payments clear
within 5 days` renders as that sentence, so what it shows past its destination
(`definitionGloss`) is verified as claims citing that definition (`definition: "[8]"`). A link
title (`"…"`, `'…'`, `(…)`) renders as nothing and is not read, which is how to keep a page
title out.

**A vacuous pass is backstopped.** An answer with no claims passes every floor, which is right
for a greeting or a clarifying question and wrong for an answer whose claim the extractor did
not see. So when nothing counted is extracted (`vacuous.ts`), what a reader sees, code,
definition lines, URLs and list-item numbers aside, is cut far more bluntly: at every line break
(U+2028, `<br>` and the rest), every sentence terminator, every semicolon, em dash, en dash (not
one between figures) and table pipe, never at a comma. The answer is vacuous only when no segment
carries a marker and no segment outside a question states a figure; otherwise each such segment
is a claim, verified like any other.

**The nudge crosses no trust boundary.** `renderNudge` is built from the model's own sentences,
the identifiers it cited and fixed reasons, ASCII apart from the model's own words. It never
includes a fetched body, an excerpt or judge text; the one checker output it repeats is a
rejected proof's reason and counterexample.

**`verifyDocument` does not throw for anything a document can contain.** An unreadable artifact,
a failing judge or replay and a refused HEAD each become a binding's reason; it throws a
`ProvabilityError` only for a malformed config. A caller that catches anything else serves
`unverifiedBundle`, so the footer reads `? unverified`, never `✓`. `bundleHash` is a sha256 over
the canonical JSON of every other field, keys sorted at every depth.

**Storage.** Bundles go to `.crewhaus/proofs/<spec>/<sessionId>/turn-<n>.json`, and a bundle put
without a session id under `no-session/` (`NO_SESSION`). A later pass of the same turn (a retry)
goes beside it as `turn-<n>.<k>.json`, never over it, so every `bundleHash` an audit record
carries names a bundle still on disk. `get` reads a turn's last pass and `list` each turn's last
pass unless asked for all. Artifacts go to
`.crewhaus/proofs/<spec>/artifacts/<prf_id>.json` and are never replaced. Files are mode 0600,
written atomically through `@crewhaus/tool-safety/fs`, never through a link; spec names, session
ids, turn numbers and proof ids are validated before any path is built from them. Bundles have
no TTL; `prune` removes old ones.

## Limits

Deliberate, or known and not closed in this release:

- A fabricated but well-formed URL passes `cited`: that rung checks the reference, not the page.
  `isPrivateHost` is offline, so a public-looking name that resolves privately is caught by the
  fetch that reads it, not here.
- `grounded` is faithfulness, not truth: a source that is wrong grounds a wrong claim.
- `registrableDomain` is a pragmatic eTLD+1 table, not the Public Suffix List: every
  `*.github.io` site counts as one origin under `grounded.independent`.
- At `grounded`, a negation before the span the claim is found in counts only when it governs
  the claim's first word, so "It is not the case that the meetings overlap on Tuesday afternoon"
  grounds "The meetings overlap on Tuesday afternoon".
- At `checked`, a result's negation counts only where it governs the figure or one of the
  claim's own words (`governingNegation`: before it, at most two words between): "1,284.50 is
  not correct" and "it is not the case that the total is 1,284.50" both check "The total is
  1,284.50". A question answered by a bare "No." is not read either. An identifier the claim
  restates unquoted (a UUID, a hash) is compared by value only where the number layer reads a
  figure in it, and otherwise falls back to word coverage: quote identifiers. A claim a tool
  reassembles from several input strings, or a draft padded past twice the claim's length, is
  not caught as an echo.
- At `proven`, the coverage runs from the proof's claim into the sentence, so a sentence that
  adds a clause of its own to the proved statement passes. That residual sits with the
  formalization gap, shown beside the claim (the formal statement), not closed.
- Self-written text goes unmarked when `Bash` or `RunCommand` wrote it (a command line names no
  place), when a write names the place in a form that cannot be mapped to the cited one (a
  repository path behind a raw-file URL), or when an earlier session wrote it. An MCP store row
  written before the evidence begins is read as the server's own text.
- A reflection a tool rewrites on the way out (an SQL function applied to the literal, an address
  printed re-spelled) still grounds; closing that needs the spec to say whose hits are trusted.
  A search hit that repeats a phrase the model searched for, word for word, is refused instead,
  and fetching the page grounds it.
- A forged hit header after a blank line inside the last Retrieve hit's preview still reads as
  one more hit; closing that needs Retrieve to print a delimiter a preview cannot contain.

## Tests

```sh
bun test src
```

No test needs a network, a model or Docker. The suites pin each rung's reasons, the evidence
readers against the formats the real tools print, the self-written trace (`verify-provenance`,
`verify-self-written`), the backstop (`vacuous`), the renderers and the store's file rules.

Design: [design/0.8.0-provability-release.md](../../design/0.8.0-provability-release.md) §2, §5,
§6, §10.
