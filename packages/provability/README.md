# @crewhaus/provability

The provability ladder: `cited`, `grounded`, `checked`, `proven`. A spec sets a floor, and every
claim in an answer must bind to evidence at or above it. This package is the deterministic part of
that: the evidence index built from the run's own event log, the four verifiers behind one
function (`verifyDocument`), the proof bundle they produce, the four ways to render it, and where
bundles and proof artifacts are stored.

It makes no model call and imports no model adapter. The one model-backed step in the feature, the
opt-in paraphrase waiver, is a callback the caller injects, and so are the other two things that
reach outside the process: the HEAD request behind `sources.resolve: head` and the replay of a
pure tool. The gate in runtime-core, the `ProvabilityPreflight` tool, `crewhaus provability check`
and the research report gate all call the same `verifyDocument`, so a draft the model preflights
is graded exactly as the gate will grade it.

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

const root = proofsRoot(process.cwd(), "support-bot"); // .crewhaus/proofs/support-bot
const evidence = buildEvidenceIndex([
  ...(await evidenceFromSessionLog({ sessionId })), // the log, sub-agent children included
  ...evidenceFromMessages(turnMessages), // the turn still in flight
]);
const bundle = await verifyDocument(answerText, {
  config: ir.provability, // the lowered, fully resolved IrProvability
  evidence,
  artifacts: createFileArtifactStore({ rootDir: root }),
  replay, // re-run a tool by name with its logged input (optional)
  isPureTool, // which tools replay may run (see `isPureTool`)
  resolveHead, // a guarded HEAD, for `sources.resolve: head` (optional)
  judgeWaiver, // the opt-in paraphrase waiver (optional)
  retryIndex,
});
const path = await createBundleStore({ rootDir: root }).put(bundle, { sessionId, turnNumber });
console.log(renderFooter(bundle, { path }));
// ── provability · grounded ✓ · 6/6 claims · 3 sources · 0 assumptions · .crewhaus/proofs/…
```

## What it owns

| Module | What it does |
|---|---|
| `types.ts` | The contract: `ProofBundle`, `ProofClaim`, `ProofBinding`, `UnmetReason`, `EvidenceRecord`, `EvidenceIndex`, `ProofArtifact`, `VerifyOptions`, `ProvabilityGradedSummary`. |
| `levels.ts` | `levelRank` (none 0, cited 1, grounded 2, checked 3, proven 4), `meetsFloor`, `maxRung`. |
| `origin.ts` | One spelling for "where a body came from": `normalizeUrl`, `normalizePath` (workspace-relative, lexical, never followed off the workspace), `originKey`, `registrableDomain`, `hostMatches`, `isPrivateHost`. |
| `private-address.ts` | The repo's private-address classifier, a byte-identical synchronised copy that `apps/cli/src/tool-registry.test.ts` sweeps and executes. Do not edit it here. |
| `evidence.ts` | `evidenceFromSessionLog`, `evidenceFromMessages`, `recordFromCall`, `buildEvidenceIndex`, `restrictToTurns`, `groundingBody`. |
| `verify.ts` | `verifyDocument`, `unverifiedBundle` (for the gate's fail-open path), `bundleHash`, `claimReasons`, `isToolAllowed`, `statementMismatch`, `MAX_HEAD_REQUESTS`, `HEAD_CONCURRENCY`, `HEAD_DEADLINE_MS`, `MAX_GROUNDING_TOKENS`. (`definitionGloss` is claim-ledger's, re-exported.) |
| `render.ts` | `renderFooter`, `renderBundleJson`, `renderMarkdownSection` (the research report's `## Provability`), `renderNudge` (the retry message). |
| `summary.ts` | `summarizeBundle`, the `provability_graded` / `provability_evaluated` payload. |
| `store.ts` | `proofsRoot`, `createBundleStore`, `createFileArtifactStore`. |
| `artifact.ts` | `newProofId`, `isProofId`, `isProofArtifact`: one definition of a proof id and an artifact's shape, for the store and the `proven` verifier. |
| `purity.ts` | `isPureTool`: which registered tools replay may re-run. |
| `builtins.ts` | The memoized builtin-name lookup, `isMcpTool`, and the tools whose results the index and the verifiers read in a format of their own (`WebFetch`, `Fetch`, `Read`, `Retrieve`, `ProofCheck`). |

Every text operation (claims, markers, definitions, the evidence-reference grammar, locating a
claim in a body, numbers, quotations, content-token coverage) is
[`@crewhaus/claim-ledger`](../claim-ledger)'s. Nothing here re-implements one.

## The rungs, as checked

- **cited.** The marker has a definition, and the definition names something locatable: an
  `http(s)` URL or a `doi:` whose host passes `sources.allow` / `sources.deny` (deny wins; a DOI
  is checked as `doi.org`) and is not a private address, or a workspace path that stays inside the
  workspace with every symlink followed, and exists. A URL that puts a user name or password
  before its host (`https://acme.example@evil.example/`) is `host_denied`: the reader would take
  it for another site than the one it names. Free text counts only under
  `sources.bibliographic: true`, and can never be grounded. With `sources.resolve: head`, the URL
  must answer one HEAD (per URL, per call) with 2xx or 3xx. One call sends at most
  `MAX_HEAD_REQUESTS` (50) HEADs, because the answer decides how many URLs it cites, at most
  `HEAD_CONCURRENCY` (6) at once and all within `HEAD_DEADLINE_MS` (15 s, `headDeadlineMs`); a URL
  past the cap or the deadline is `unresolved`, and the detail says why. Every marker in a claim must have a definition:
  a dangling `[2]` beside a good `[1]` leaves the claim `unmet` (`no_definition`), because the
  reader would be shown a citation of nothing. A defined second marker that fails (a source never
  fetched) does not unmeet a claim another binding meets; the bundle and the report's table still
  show it, the footer does not.
- **grounded.** The cited origin was fetched or read in this run (an error result does not count,
  and neither does a fetch that answered outside 2xx: a 404 page is the server's, not the page),
  and claim-ledger's `locateClaim` finds the claim in that body at `grounded.coverage` within
  `grounded.window_tokens`. A quotation must appear verbatim. A figure or a negation is never
  excused by a partial bar, and the figure rule holds at `coverage: 1` too, so a stricter bar
  never switches off the check that a quotation's framing figures agree with the source. A
  negation that opens the source's statement counts ("No two of the six meetings overlap" does
  not ground "two of the six meetings overlap"). The binding carries a frozen excerpt (240
  characters at most: the claim at its tightest in the span, centred on its figure when even that
  is longer) and the body's digest, so the bundle stays checkable after the transcript is evicted.
  One verification reads at most `MAX_GROUNDING_TOKENS` tokens of fetched text while grounding,
  and yields to the event loop between claims; a source past the budget reaches `cited` and,
  above it, reads `below_floor` with a detail naming the cap. A path under the harness's own
  state (`.crewhaus/`, `.crewhaus-shared/`, and the `stateRoots` the caller names: a relocated
  session directory, a tenant's root) is cited but never read, as the offline check never reads
  one: a session log holds every answer verbatim, so a `Read` of it would ground the model's own
  earlier text (`not_fetched`). The path is compared as the filesystem spells it, so
  `.CREWHAUS/sessions/…` on a case-insensitive volume is the same log. A COPY of one is the same
  log too: a file the run copied, moved, concatenated or unpacked out of a state root
  (`CopyPath`, `MovePath`, `ConcatFiles`, `ArchiveCreate`/`ArchiveExtract`, followed back up to
  four steps, a directory copied whole included) is never read, cited or checked
  (`not_fetched`, the detail naming the copy), and neither is a body an MCP call read while it
  was pointed at a state path, whatever address the body was indexed under. A `FactCrossCheck`
  that found a claim only in such a path, or in a copy of one, checks nothing at `checked`
  (`value_absent`). A body a redirect brought from a host `sources.deny` or the
  private-address rule refuses does not ground the URL that led there (`host_denied`,
  `private_address`), the rule `resolve: head` holds every hop to. `sources.allow` names what may
  be cited, so a DOI still grounds in the publisher it resolves to.
- **checked.** `tool:<toolUseId>` resolves to a recorded, non-error call of a tool on
  `execution.allow`: the graded session's own call first, then a sub-agent's, and an id only
  several sub-agents share is `tool_missing`, with a detail saying so. Every number the claim
  states is in the result, compared as an exact decimal, and every quotation is in it word for
  word. A claim with neither must still share `grounded.coverage` of its words with the call's
  input and result, so an allowed tool's unrelated output checks nothing. The result is read with
  the claim the input HANDED OVER blanked out where the tool repeats it: a run of the claim's own
  words, stopwords included, at `grounded.coverage`, no longer than twice the claim, blanked as
  often as the input holds it. So a figure or a word a tool only hands back (NormalizeText or
  WrapText of the sentence) checks nothing, and when the input hands the claim over (a lint run
  over the draft answer) the result must carry it too. A document a value is selected from does
  not hand the claim over: JsonQuery's `["suspended"]` over `{"account":{"status":"suspended"}}`
  checks "the account is suspended". A `FactCrossCheck` result is read by its verdict: only an
  entry that checked this sentence and found it `supported` checks it, against the source text it
  found; `notFound`, `polarityConflict` and `misquoted` are the check saying the source does not
  carry it, whatever the report repeats. A check that found the claim only in files the run wrote
  it into before the check (see "a source the run wrote itself" below) is no check: the binding
  reaches `grounded` at most, carries `writtenBy`, and counts as a source the run wrote, as the
  file itself, cited, would. What stays open is a claim a tool reassembles from
  several input strings, and a draft padded past twice the claim's length. The locate kernel then reads the call for the claim, so a
  result saying "the meetings do not overlap" (or "not one vendor is approved") does not check
  "the meetings overlap", and a number word the result does not state beside the claim's words
  is `value_absent`. A claim that states a figure has its polarity read word by word, the way
  claim-ledger's `governingNegation` scopes a negation, and only where the result speaks to the
  claimed figures: the statement each figure sits in, which a colon, a bracket, a quote or a dash
  does not end and a full stop, comma, semicolon, question mark, table bar or line break does. A
  figure the claim denies ("the total is not 1,284.50") must be denied in the result too, and a
  word the result denies beside the figure ("91 is not prime", "91: not prime", "91 (not prime)")
  does not check a claim that states it. For a word that is not a figure only a predicate
  negation counts (not, never, cannot, the n't forms), on both sides: "no tests failed out of 120"
  does not deny the tests of "all 120 tests passed", and "without VAT" does not deny VAT. A
  negation elsewhere in the sentence ("no discount was applied, so the total is 1,284.50", "the
  total without VAT is 1,284.50") denies nothing about the figure, and a negation in some other
  field of a JSON result answers nothing. A question answered by a bare "No." ("Is 91 prime? No.")
  denies nothing the rule can see. Each statement and each figure of a result is read once per
  call, however many claims cite it. When the floor is `checked`,
  `execution.replay` is on and the
  tool is pure, the gate re-runs it once (shared across claims, at most `max_replays` per call)
  and compares digests. A mismatch fails the binding; a replay that could not run leaves it
  `checked` with `replayed: false`. The excerpt is the result when it fits in 240 characters,
  and otherwise the part around the claim's first figure (or its quotation).
- **proven.** `proof:prf_<16 hex>` names a stored artifact a checker on `formal.checkers`
  accepted, and the run's evidence holds the `ProofCheck` call that wrote it, reporting it
  accepted with the assumptions and axioms the file lists, and given exactly the checker, claim,
  statement and proof the file holds. The file sits in the workspace, where the model's own file
  tools could write one, flip a rejected one to `ok: true`, or rewrite an accepted one's claim
  and statement under its id; the run's record of the check is what shows a checker accepted
  it (`trustStoredProofs` skips that for an offline check with no log). Where `recheckProof` is
  wired (the gate and the preflight wire tool-proof's: the builtin checker, bounded by
  `formal.timeoutMs`), the checker also accepts the stored statement and proof again. The
  sentence must state the artifact's recorded `claim`
  (`statementMismatch`): its words cover the
  claim's at `grounded.coverage`, both state the same figures (`two` and `2` are one, `-500` is
  not `500`, and a date is its whole value), and each
  word of the proof's claim is denied in both or in neither. Coverage alone drops "no" and "not",
  so without the polarity test an accepted proof that two meetings overlap would prove "no two
  meetings overlap". Polarity is read per word, not per sentence, because the sentence may say
  more than the proof: "no discount was applied, so the invoice total is 1,284.50 EUR" states a
  proved total, and its "no" is about a discount the proof never mentions. A negation moved to
  another word ("two of the six meetings didn't overlap" for a proof that no two overlap) is
  another statement, a partitive ("none of the 3 invoices is overdue") is read as denying
  the statement it governs, and so is a frame that negates the whole of it ("it is not true
  that …", "it is not the case that …": two cancel). The checker,
  the formal statement, the hypotheses the proof rests on (builtin `given` steps, SMT asserts and
  definitions) and the axioms go into the bundle beside the prose. Hypotheses are assumptions:
  they are counted in the footer, refused under `assumptions: forbid` and capped by
  `max_assumptions`, so a proof that assumes its own conclusion does not read "0 assumptions".
  What the test cannot
  see is a sentence that adds a clause of its own to the proved statement, because the coverage
  runs from the proof's claim into the sentence, as design §6.4 specifies. That residual sits
  with the formalization gap, shown beside the claim rather than closed.

## Things worth knowing

**The outside calls happen only where the floor needs them.** Rungs above the floor are still
computed, because `achieved` reports the highest floor the answer would have passed. The HEAD
request runs only at `cited` and `grounded`, since no source can meet a higher floor. The waiver
judge runs only at `grounded`, and only for a miss claim-ledger calls waivable: the body was read,
some of the claim's words were found, and none of the missing ones is a figure or a negation. It
is asked after the claim's other bindings are settled, and only while the claim still needs it:
never for a claim another binding already meets, and at `independent: n` only for an origin the
claim does not already count. The replay runs only at `checked`. Above the floor, `achieved` is
computed without them.

**"N sources" in the footer** counts the origins cited at a `cited` floor, and the origins that
grounded a claim at `grounded` and above.

**How each outcome is represented.**
- A claim with no marker is `unmet` with zero bindings. `claimReasons(claim)` reports that as
  `no_citation`.
- An allowed assumption binding is `ok: false` with no `reason`: it is not evidence, and it is not
  a failure. A claim whose only bindings are allowed assumptions has status `assumption`. It is
  left out of the score on both sides and always counted in the bundle and the footer.
  `assumptions: forbid` makes each one `assumption_forbidden`. Past `max_assumptions`, the extra
  assumption claims (in document order) become `unmet` with `assumption_forbidden`. Either way
  they are refused: `assumptionsRefused` counts them, the footer shows every declared one
  (`3 assumptions (2 refused)`), and a refusal fails the verdict whatever the score, with
  `achieved: "none"`. Otherwise a threshold below 1 would pass an answer over the cap.
- Under `grounded.independent: n` at a `grounded` floor, a claim met only through sources needs n
  distinct origins: registrable domains for URLs (a pragmatic eTLD+1, where every `*.github.io`
  counts as one origin), the registrant prefix for DOIs, and distinct files for paths, each read
  off the host that SERVED the body: a page cited directly and through a shortener that redirects
  to it, or a DOI and its publisher's URL, is one origin. When it
  falls short, each of its `ok` source bindings keeps its rung and becomes `ok: false` with
  `not_independent`. A claim met by an execution or formal binding is met regardless.

**Evidence comes from the log, merged with the transcript.** `evidenceFromSessionLog` walks child
sessions through their `sub_agent_start` brackets (the brackets continuity-store's
`resolveEvidence` follows; this reads the whole tree once, in call order, where that function
looks one id up) and places a child's calls where the bracket sits. An id logged more than once
pairs its last `tool_use` with its last `tool_result`, the rule continuity-store applies, so
`PlanComplete` and the `checked` rung read one log alike: an approval replay keeps the input that
ran, and a provider that reuses ids does not get one call's input beside another's result. A
result the runtime spilled to a file (tool-result-store's preview: the head, then `[truncated,
full output at …]`) is read whole from that file (`body`), but only from this call's own
`<toolUseId>.txt` under the spill root (`toolResultsRoot`, default `.crewhaus/tool-results`),
opened without following a link, and only when it starts with the logged head; otherwise the
preview stands. A missing log yields no
records. A log that cannot be read to its end (a torn last line after a crash mid-append, a
malformed line, a link at the log's name) keeps the records read before that point and reports it
through `onUnreadable`. Fewer records fails closed: a claim whose evidence was lost is unmet. A
throw would fail open, and every later turn of the session would be served `unverified` because
one child's log was torn. `buildEvidenceIndex` merges the same call from the log and from the transcript
into one record. The log's verbatim text wins, except where runtime-core logged only a summary of
block content (`[2 text blocks, 1834 chars]`). A call is its session and its id together: an
OpenAI-compatible server numbers ids per conversation (`functions.<name>:<n>`), so a parent's
first fetch and its child's share one, and merged they would put one page's body under the other's
URL. A record that names no session (the transcript's) is the graded session's: pass it as
`buildEvidenceIndex(records, { sessionId })`, or it is the first session the records name.

**Origins are read off the call, and only where the result is that origin's content.** Among
builtins, the readers do this: `WebFetch`'s and `Fetch`'s `url` (a `Fetch` only when it sends no
body, since a POST's response answers the model's own payload) and `Read`'s `path`. Every other
builtin's `url` or `path` argument names what the tool acted on, not a body it returned. SeoLint's
`url` is context for a canonical check while its result echoes the markup the model passed, and
UrlParse returns the model's own URL taken apart. Indexing those would let the model's text pose
as a page the run never read. An MCP server's tool, which the gate cannot see into, gives origins
through its `url`/`uri`/`href` and `file_path`/`path`/`file`/`filePath` fields, unless its result
is an echo of its own input: a substring of one of the input's strings, or covered by the input's
content words at 0.8. Only through a field the tool DECLARES: tool-mcp registers every MCP tool
with a permissive local validator, so a key the server does not declare reaches the log and the
server, which ignores it, and `mcp__filesystem__read_file {path: "notes.md", url: …}` read a file
the model wrote under a page nobody fetched. So where the tool's schema is known
(`EvidenceOptions.inputSchemaOf`, default the schema `defaultCatalog` holds — where a compiled
harness registers its MCP tools; the gate in evaluation-service hands the schemas of its own
catalog, where `crewhaus run` and `crewhaus eval` register theirs) a field names an origin only
when the schema's top-level `properties` lists it, and a schema that lists none names nothing;
where it is not known (a log read offline), an input names an origin only when it carries
nothing else a call could have been pointed at: every address field names that one origin, and
no other field — a `paths` list, a `command`, an id — carries a string (a fetcher's rendering
options such as `formats` or `method` aside), so `{paths: [...], url}` and `{command, url}`
name neither. The entries of a `paths` / `files` list are places the call read for the
state-root test whatever origin it is indexed under. A plugin's tool and the runtime's own non-builtins (`Task`, `Recall`,
`Consult`, `Escalate`, `Skill`, the plan and goal tools) give none: their results are model
output, and their schemas strip a `url` the model adds without refusing it, so the key reaches
the log and a remembered sentence would ground a page nobody fetched (design §8). The URL a WebFetch result's header names on its first line is an origin
too. tool-web prints the final URL there, and after a redirect a `Requested: <asked>` line
under it (`URL: <final>`, `Requested: <asked>`, `Status: …`), so a citation of either URL
grounds: the final one from the header, the asked one from the call's `url`. A search result carries hits,
and each hit's own text is indexed under its own origin, so one hit cannot ground a claim cited to
another. Two kinds of result are read this way. The first is Retrieve's `[n] id=… doc=…` blocks,
in exactly the structure Retrieve prints: a header at the start or after a blank line, numbered
1, 2, 3 with no repeat or gap, and no more of them than `k`. Anything else reads as no hits,
because a chunk preview is corpus text and could carry a header-shaped line. The second is JSON
with `url`/`uri`/`href`/`link`/`source` fields from an MCP tool (`mcp__…`) whose input names no URL
or path, less any hit that echoes the input. A SQL tool returns the literal its SELECT names. The
runtime's own tools whose result is model output (`Task`, `Consult`, `Escalate`, `Skill`, the
memory, plan and goal tools) are never read for hits: a sub-agent's JSON answer is its own
writing, and its evidence is the fetches its own log holds.

These format readers are tied to the tools that print each format, because a hit or a header names
its own origin. If a `Read` of a file the model wrote, `Bash` echoing JSON, or a fetch of an echo
endpoint were read as hits, any text could be placed under any URL. That would ground a citation of
a page the run never read, which is exactly what `grounded` exists to refuse. When a body is
grounded against, WebFetch's header and the `[user prompt: …]` line it prepends are removed. That
line is the model's own text, and leaving it in would let the model write the claim into `prompt`
and then find it "in the source". Fetch's status line and headers are removed the same way. The
residuals the design names stay. A model that writes a file and then reads it can ground a
citation of that file, and should: the file does say it now, and an agent that sets a value and
then reports it reports the truth. But the run is then its own source, and the bundle says so
(design §10: the residual is surfaced, not assumed away). It is decided per origin, not per
call. When a body grounds a claim — a builtin reader's, or an MCP call's whose own input named
the origin (`mcp__fetch__fetch {url}` after a PUT to it, a file server's `read_file` of a file
`Write` saved) — `grounded` asks every EARLIER call of the run that may write (not a reader, not
the preflight, not a pure tool, not one that errored) and that wrote there: its input names the
place (`path`, `url`, `destination`, `out`, a diff's `+++ b/…` files, …), or a place a copy, move,
concatenation or archive then brought here (followed back up to four steps; a directory copied
whole maps each file beneath it). The claim at its tightest is the run's own when each tightest
run of it is text one of them put there: one string it sent holds the run whole, the run holds a
word it introduced (a figure or a content word its content fields add and do not replace: an
`Edit` of `14` to `30` introduces `30`, a placeholder filled in, an `AppendFile` finishing the
sentence, a diff's `+` line), or the run holds a text it put there whole (an `Edit` that only took
"not" out). A read made before any of those writes that grounds the claim does so unmarked.
Found, the binding still grounds and carries `writtenBy: { toolUseId, toolName }`, the bundle
counts the origin in `selfWritten`, the footer reads `1 source (1 written by this run)`,
`provability show` names the call, `provability audit` lists it under "sources the run wrote
itself", and `provability.claimCoverage` names it in its rationale and does not count it toward a
sample's `expected_sources`. What stays open: text written by `Bash` or `RunCommand` (a command
line names no place this reads), by a call that names the place in a form that cannot be mapped
to the cited one (a repository path behind a raw-file URL), by an earlier session, or by an
earlier turn when the caller hands a turn-only index rather than the session's with
`turnNumbers` (the gate and its preflight hand the latter, so under `scope: turn` they still see
what an earlier turn wrote).

An MCP server with storage (SQL, a notes or key-value store, a vector index) hands back what was
written to it. When `grounded` finds the claim in an MCP result, it also looks for the claim's
words at their tightest, word for word, in what an EARLIER call of the run sent (the address a
call was pointed at aside): found, it is the model's own text stored and read back, and the
binding is `not_fetched`, the detail naming the call that sent it. Under a URL the call's own
input named (`mcp__fetch__fetch {url}`) only calls to the same server count, since only its store
hands back what was written to it: the draft given to `ProvabilityPreflight`, a searched phrase or
a comment posted to another server is not what the page says. Text another tool wrote to that
very URL or path (a PUT, a `Write` of the file) IS the page now, and the run's own: it is marked
`writtenBy`, as above, not refused. Under a
hit the result carried (a JSON row's `url`) every call but the preflight counts: the row is
whatever the server keeps, and a file `Write` saved is what a filesystem server reads. A page the
run read and then summarised in its notes is still the page. A row stored before the evidence the gate is
handed begins (by an earlier session, or by an earlier turn when the caller hands a turn-only
index rather than the session's with `turnNumbers`; the gate and its preflight hand the latter)
is the residual: no call in it sent the text, and closing that needs the spec to say which MCP tools return sources.

A reflection padded with other text is caught where the claim is located. A SELECT that appends
computed text or a real row to a literal, or a linter that repeats a `<title>` it was handed
inside a report, is not wholly an echo, so its text is indexed. But when `grounded` finds the
claim in a record from a tool that is not a builtin (MCP, plugin), it looks for the claim's words
at their tightest, word for word, in the call's input strings. If they are found, that is the
model's own text, and the binding is `not_fetched`. The detail says the origin was never read and
to fetch the page. The URL or path the call was pointed at is read apart, because its slug can
spell the claim the page states (`…/rust-is-faster-than-go`) and a fetcher returns the page, not
its address. It counts only where the result prints it: the whole address, or the piece of its
slug that spells the claim, as a 404 page repeats a path. That printing is blanked out and the
result read again. A page that says the claim in its own text beside its printed address
grounds there, and one that carries it only in the address is `not_fetched`. A search hit whose
query only shares words with it still grounds. A hit that repeats, word for word, a phrase the
model searched for does not, because the gate cannot tell it from a reflection, and fetching the
page grounds it. A builtin reader is asked only about its address: a page whose own text carries
the claim grounds, and one that carries it only where it prints the address it was fetched at is
`not_found_in_source`. Retrieve is not tested this way: it returns corpus text, never its query.
A reflection the tool rewrites on the way out (an SQL function
applied to the literal, an address printed re-spelled) still passes. Closing that needs the spec
to say whose hits are trusted, a design decision this package does not make.

A forged hit header after a blank line inside the last Retrieve hit's preview still reads as one
more hit; closing that needs Retrieve to print a delimiter a preview cannot contain.

**The text a definition line shows is read.** `extractClaims` leaves out the definition
`citationDefinitions` keeps for each id. But `[8]: https://acme.example/x Payments clear within 5
days` is not a valid link reference definition, so it renders as that sentence, and the reader
would see an assertion the gate never read. So whatever such a definition shows after what it
names (claim-ledger's `definitionGloss`) is read by `extractClaims` and verified as claims citing
that definition, marked with `definition: "[8]"`. Any other definition-shaped line that shows
text, such as a second `[8]:` line or a bulleted `- [8]: …`, is read by `extractClaims` itself as
the prose it renders as, uncited. The rule is the same for every definition: cited or not, URL, DOI, `tool:` or
`proof:`, and whether or not the text ends with a full stop. The extractor decides what is a
claim, so a short gloss (`— Acme refunds`: under three content words, no figure) is not one. A
Markdown link title (`"…"`, `'…'`, `(…)`) renders as nothing and is not read, which is how to keep
a page title out; the retry nudge says so. A bibliographic entry after a URL (`Smith, J. (2020).
Refund policies in retail. 12(3), 45-67.`) is read: it describes its source, and at `grounded` the
run must have read that source. `sources.bibliographic: true` spares only a free-text source
itself, which is then the reference, the way a URL is.

**A vacuous pass is backstopped** (design §2). An answer with no claims passes every floor with
nothing to prove, which is right for a greeting, a clarifying question or a code block and wrong
for an answer whose claim the extractor did not see. Review rounds one and two each found new
shapes that merged a claim into a question or a heading ("30 days [1] — anything else?",
"1,284.60; want the PDF?", a no-break space, `<br>`, U+2028, a table row), each served scenario A
or B with a ✓, and each fix left the next shape open. So when nothing counted is extracted
(`backstopClaims`, `vacuous.ts`), what a reader sees, code and definition lines and URLs aside,
is cut far more bluntly than the extractor cuts it: at every line break (U+0085, U+2028, U+2029,
`\f`, `\v` and `<br>` included), every sentence terminator whether a space follows it or it is
glued to the next word, every semicolon, em dash, en dash (not a range between figures) and table
pipe, never at a comma. The answer may be vacuous only when no segment carries a citation marker
and no segment that is not a question states a figure; otherwise each such segment is a claim,
verified like any other. A piece of text ending in `?` is a question from the segment that opens
as one (an interrogative, an inverted auxiliary, "want", "any") to the segment that ends as one,
so "Which of the 4 plans do you mean — Basic or Pro?" and "Do you want 2 or 3 copies?" stay
questions while "The refund window is 30 days — anything else?" says something first. A heading
is a title to the figure rule but for what it states after a label (`## Invoice total:
1,284.50`); claim-ledger's `headingClaim` reads the headings that state one, and a marker in a
heading still counts.

**The nudge crosses no trust boundary.** `renderNudge` is built from the model's own sentences,
the identifiers it cited and fixed, plain-words reasons. It never includes a fetched body, an
excerpt or judge text. The one checker output it repeats is a rejected proof's reason and
counterexample (design §0, scenario C). It is ASCII apart from the model's own words: the quotes,
dashes and ellipses in what it repeats are folded too.

**`bundleHash` is stable.** It is a sha256 over the canonical JSON of every field except itself,
with keys sorted at every depth, so the same answer, evidence and clock always give the same
hash, and any change to a field changes it. `verifyDocument` never throws for anything a document
or its evidence can contain. An unreadable artifact, a failing judge, a failing replay and a
refused HEAD each become a binding's reason. It throws only for a malformed config. A caller that
catches some other throw uses `unverifiedBundle`, so the footer reads `? unverified` instead of
`✓`.

**Storage.** Bundles are written to `.crewhaus/proofs/<spec>/<sessionId>/turn-<n>.json` and
artifacts to `.crewhaus/proofs/<spec>/artifacts/<prf_id>.json`. A later pass of the same turn (a
retry) is written beside the first as `turn-<n>.<k>.json`, never over it, so every pass's
`bundleHash` names a bundle still on disk; `get` reads a turn's last pass unless asked for one,
and `list` shows each turn's last pass unless asked for all. Files are mode 0600 and directories
0700, written to a random temp file and renamed into place through `@crewhaus/tool-safety/fs`, so
a link planted at the name is never followed. Spec names, session ids, turn numbers and proof ids
are validated before any path is built from them: a tampered `proof:../../x` reads nothing. The
store never replaces an artifact. Bundles have no TTL; `prune` removes old ones.
