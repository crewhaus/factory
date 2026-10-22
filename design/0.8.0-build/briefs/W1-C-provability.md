# W1-C — `@crewhaus/provability`: evidence index, the four verifiers, bundles, stores, renderers (design §2, §5.2–§5.4, §6, PR train 4 + the `checked`/`proven` verifiers)

You own: `packages/provability/**` (the contract `src/types.ts` is committed — implement against
it; additive changes only, reported). You may ALSO edit `apps/cli/src/tool-registry.test.ts`
only to register a new copy of the synchronised private-address classifier (see below).
`@crewhaus/claim-ledger` was just built by another builder (W1-A) — read its `src/index.ts` and
USE it for every text operation (claims, markers, definitions, tokens, coverage, locate, numbers).
Never re-implement those here; if claim-ledger lacks something you need, add it there
minimally and report it.

Read design §2 (the ladder table + cross-cutting rules), §5.2 (evidence index), §5.3 (bundle),
§5.4 (rendering), §6.1–§6.4 (the verifiers), §10 (security posture). This package must make NO
model call and import no model adapter (the judge waiver is an injected callback).

Dependencies: claim-ledger, continuity-store, errors, ir, tool-catalog are pre-wired; add
`@crewhaus/event-log` (session-log reading) and anything else internal you need (package.json
sorted + tsconfig references + root `bun install`).

## Modules (suggested; export everything public from `src/index.ts`)

1. `levels.ts` — `levelRank(rung)` (none 0, cited 1, grounded 2, checked 3, proven 4),
   `meetsFloor(rung, floor)`, `maxRung(...)`.
2. `origin.ts` — `normalizeUrl(raw)` (lowercase scheme/host, drop default port, drop fragment,
   fold a trailing slash, keep query), `normalizePath(raw, {workspaceRoot, baseDir})` →
   workspace-relative POSIX path or `undefined` when outside the workspace (use realpath-free
   resolution + containment like tool-verify's `resolveSafe`; never follow the path off the
   workspace), `originKey(...)`, `registrableDomain(host)` (a pragmatic eTLD+1: last two labels,
   last three for known two-level suffixes like co.uk/com.au — document the approximation) for
   `grounded.independent`, and `hostMatches(host, globs)` (`*.gov`, `arxiv.org`, `*` ).
   Private-address check: the repo keeps ONE classifier as a byte-identical "SYNCHRONISED BLOCK"
   copied into each package that needs it (see `packages/tool-fetch/src/index.ts` "BEGIN
   SYNCHRONISED BLOCK — private-address classifier") and a guard in
   `apps/cli/src/tool-registry.test.ts` that EXECUTES every copy. Add a copy here verbatim and
   register the new file with that guard (follow how the other copies are listed). Do not write
   your own classifier.
3. `evidence.ts` — build the `EvidenceIndex`:
   - `evidenceFromMessages(messages)`: Anthropic-shaped `MessageParam`s (assistant `tool_use`
     blocks `{id,name,input}`; user `tool_result` blocks `{tool_use_id, content (string | text
     blocks), is_error}`) → records. Define a minimal structural message type; do not import the
     Anthropic SDK.
   - `evidenceFromSessionLog({ sessionId, rootDir?, includeChildren? = true, maxDepth? = 8 })`:
     read the session `.jsonl` with `@crewhaus/event-log` (`openEventLog(...).read()`; payload
     shapes: `tool_use {id,name,input}`, `tool_result {toolUseId, content, isError}`; children via
     `sub_agent_start` — read how `packages/continuity-store/src/evidence.ts` walks them and do the
     same). Carry `turnNumber` when the log records one. A missing log yields `[]`, never a throw.
   - origin extraction per record: input fields `url`, `uri`, `href` (URLs) and `file_path`,
     `path`, `file`, `filePath` (paths); WebFetch/Fetch results whose first line is
     `URL: <final url>` (tool-web prints `URL: …\nStatus: …` — index the FINAL url too, so a
     citation of the pre-redirect URL still grounds); JSON results (arrays/objects, e.g. Retrieve
     hits) carrying `url`/`source`/`uri` fields — index each hit's own text under its origin
     (a hit is its own evidence body). Error results are indexed (verifiers reject them).
   - `buildEvidenceIndex(records)` merges duplicates (same toolUseId from log + messages → one),
     preserves call order, and implements `bySource` (normalized-origin lookup),
     `byToolUseId`, `all`.
4. `verify.ts` — `verifyDocument(text, opts: VerifyOptions): Promise<ProofBundle>`:
   - claims = claim-ledger `extractClaims(text)`; definitions = `citationDefinitions(text)`
     classified with `classifyDefinition`.
   - Per claim, per marker → binding. No markers → claim `unmet`, one synthetic binding-less
     reason `no_citation` (represent as a claim with zero bindings and status unmet; make the
     nudge/footer able to say "no citation"). Marker without definition → binding reason
     `no_definition`.
   - SOURCE binding, rung by rung (stop at the first failure, record the highest rung reached):
     cited — locatable kind (`url`/`doi`/`path`; `text` only when `sources.bibliographic`, else
     `not_locatable`); URL host vs `sources.deny` (wins) / `sources.allow` (empty = any) →
     `host_denied`; private address → `private_address`; path inside workspace →
     `path_outside_workspace`, exists → `path_missing`; `sources.resolve: "head"` → `resolveHead`
     (status 2xx/3xx else `unresolved`; cache per URL within one call). grounded — the origin
     must be in `evidence.bySource` (else `not_fetched`; a DOI grounds when any record's origin is
     `https://doi.org/<doi>` or its final URL); then claim-ledger `locateClaim` against each body
     with `{windowTokens: grounded.windowTokens, coverage: grounded.coverage}`: supported →
     grounded (record `excerpt` ≤240 chars collapsed, `sha256` of the body); polarityConflict →
     `polarity_conflict`; otherwise `not_found_in_source`, except: when coverage was partial
     (>0) and `judgeWaiver` is provided, ask it; `supported:true` → grounded with
     `judgeWaived:true` (accumulate the judge's model/cost into the bundle). The waiver is ONLY
     for this case.
   - `grounded.independent: n` (n>1): a claim is met only when ≥ n distinct origins (registrable
     domain for URLs, distinct path for files) have `ok` grounded-or-higher source bindings; else
     the claim's bindings stay as computed and the claim is `unmet` with reason
     `not_independent` attached to its best binding (document the representation).
   - EXECUTION binding (`tool:<id>`): `evidence.byToolUseId` missing → `tool_missing`; error →
     `tool_errored`; tool name not on `execution.allow` (case-insensitive; see the IR doc) →
     `tool_not_allowed`; value containment: every number `extractNumbers(claim)` yields must be
     `containsValue` in the result content, and every quoted span must appear; a claim with
     neither numbers nor quotes falls back to content-token `coverage` of the claim against the
     result text + JSON-stringified input ≥ `grounded.coverage` (document why: an allowed tool
     result must still SAY something about the claim) → else `value_absent`. Replay: when
     `execution.replay` and `isPureTool(name)` and `replay` is given and the per-call replay
     budget (`execution.maxReplays`) is not spent → re-run; compare sha256 of whitespace-
     normalized content; mismatch → `replay_mismatch`; match → `replayed: true`. Not replayed →
     `replayed: false` (still `checked`). Rung `checked` (it also satisfies cited/grounded).
   - FORMAL binding (`proof:prf_…`): `artifacts?.get(id)` missing → `proof_missing`;
     `ok:false` → `proof_rejected`; claim coverage — the answer sentence's content tokens must
     cover the artifact's recorded `claim` (coverage(artifactClaimTokens, answerClaimTokens) ≥
     `grounded.coverage`) else `claim_mismatch`. Rung `proven`; binding carries `checker`,
     `statement`, `sha256` (outputDigest); add `{id: checker, artifact: id, axioms}` to
     `bundle.checkers` (dedupe).
   - ASSUMPTION binding (`assume:`): `assumptions: forbid` → `assumption_forbidden`. A claim
     whose only definitions are assumptions → status `assumption` (excluded from the score's
     numerator and denominator). Past `maxAssumptions`, the extra assumption claims (in document
     order) become `unmet` with `assumption_forbidden`.
   - Claim status: `met` iff some binding is `ok`; `assumption` per above; else `unmet`. `best` =
     the max binding rung.
   - `turnNumbers` (scope: turn) filters evidence records to those turns (records with no
     `turnNumber` are kept only when the filter is absent).
   - Score = met / (claimCount − assumptions); zero denominator → score 1, `vacuous` set
     ("no claims to prove" / "every claim is an assumption"). Verdict `pass` iff score ≥
     `threshold` and assumptions ≤ maxAssumptions (when set). `achieved` = the highest rung L such
     that the fraction of non-assumption claims with `best ≥ L` is ≥ threshold (vacuous ⇒ the
     floor itself; nothing ⇒ "none").
   - Always compute higher rungs for `achieved` even when the floor is lower (cheap), but never
     call `resolveHead`, `replay` or `judgeWaiver` unless the FLOOR needs it (cited needs resolve
     when configured; grounded needs the waiver; checked needs replay) — document it.
   - `createdAt` from `opts.now`; `bundleHash` = `sha256:` + hex over canonical JSON (keys sorted
     recursively) of the bundle without `bundleHash`. Export `bundleHash(b)`.
   - `verifyDocument` never throws for content problems; it throws only for programmer errors.
     Export `unverifiedBundle(config, error, retryIndex, now)` for the gate's fail-open path.
5. `render.ts` — `renderFooter(bundle, {path?})` (one line, design §5.4 exact shapes: pass
   `── provability · grounded ✓ · 6/6 claims · 3 sources · 0 assumptions · <path>`; fail
   `── provability · grounded ✗ · 4/6 claims · unmet: [2] [5] · …`; unverified
   `── provability · grounded ? unverified — <reason>`; judge-waived count shown as
   `(1 judge-waived)`); `renderBundleJson(bundle)`; `renderMarkdownSection(bundle)` (the research
   report's `## Provability` section: floor, verdict, score, a table of claims with status, best
   rung and refs, assumptions and checkers listed); `renderNudge(bundle)` — the retry nudge: the
   unmet claims (the model's OWN sentences, clipped), the refs each cited, the reason in plain
   words, and the standing instruction to run `ProvabilityPreflight` on the next draft. It must
   contain NO fetched content (no excerpts) and no judge text — that is what keeps it from
   crossing a trust boundary (§5.1). Plain ASCII-safe except the ✓ ✗ glyphs.
6. `summary.ts` — `summarizeBundle(bundle): ProvabilityGradedSummary`.
7. `store.ts` — `proofsRoot(cwd, specName)` → `<cwd>/.crewhaus/proofs/<specName>` (validate
   specName like continuity-store's SPEC_NAME_REGEX); `createBundleStore({ rootDir })` with
   `put(bundle, { sessionId?, turnNumber })` → writes `<rootDir>/<sessionId or "no-session">/
   turn-<n>.json` (mkdir -p, mode 0600, tmp+rename atomic; validate sessionId `sess_[0-9a-f]{16}`
   or the literal no-session), returns the path; `get(sessionId, turnNumber)`; `list()`
   (newest first, with session/turn/mtime); `prune(olderThanMs, now)` → removed count.
   `createFileArtifactStore({ rootDir })` (artifacts under `<proofsRoot>/artifacts/<id>.json`):
   validate ids against `^prf_[0-9a-f]{16}$` BEFORE any path interpolation (a tampered id must
   not traverse — the citation-tracker sha256 precedent), `newProofId()`.

## Tests (`packages/provability/src/*.test.ts`) — thorough
- Evidence: from messages; from a real session log written with `@crewhaus/event-log` in a temp
  dir (incl. a child session via `sub_agent_start`); final-URL indexing; Retrieve-style JSON
  hits; dedupe of log+messages.
- Every UnmetReason produced at least once by a realistic input.
- The three acceptance scenarios from design §0: (A) a fabricated citation → `not_fetched`, then
  fetched-but-wrong-body → `not_found_in_source`; (B) a hand-computed total with no tool →
  `no_citation`/`tool_missing`, a misquoted total → `value_absent`, a tampered replay →
  `replay_mismatch`, a correct `MoneyAdd`-style result → `checked`; (C) a `proof:` binding with
  an accepted artifact → `proven`, a rejected one → `proof_rejected`, an unrelated one →
  `claim_mismatch`.
- Threshold < 1, assumptions allow/forbid/max, vacuous, achieved computation, independent: 2,
  scope: turn, judge waiver called only for partial coverage and only at `grounded`, replay
  budget, bundleHash stability (same input → same hash; field change → different hash).
- Renderers (exact footer strings), nudge contains no excerpt text, stores (atomic write,
  traversal refusal, prune), artifact id validation.

Verify: `bunx tsc -b` + `bun test` in packages/provability; `bun test src/tool-registry.test.ts`
in apps/cli if you touched it; biome on your files. Replace the scaffold README with a real one.
