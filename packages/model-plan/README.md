# @crewhaus/model-plan

Pure, fs-free primitives behind the 0.6.0 per-model plan: what a `models:`
profile means for one candidate's request, which tools it may see, which
candidates a turn may route to, and the deterministic guards that keep a
learned policy honest. Nothing here opens a file, constructs an adapter, or
reads a clock it was not handed — every function replays exactly from the
persisted transcript, which is what lets `route explain` reconstruct a
decision after the fact.

The compiler consumes it for validation, `@crewhaus/runtime-core` for the
per-candidate plan table, the CLI for the `models` and `route` verbs, and
Hangar read-only. `@crewhaus/model-service` (the composition root) is the
only package that wires these into live adapters and stores.

## Profiles

- `resolveProfileRef("$fast", registry, slotLabel)` — resolves a `$profile`
  reference against the `models:` registry; a grammar string or sentinel
  passes through. An unknown ref throws `ModelPlanError` with a
  did-you-mean naming the nearest declared profile. Names match
  `PROFILE_NAME_RE` (`/^[a-z][a-z0-9_-]{0,63}$/`), lowercase-first so a
  profile ref is never confused with a `$UPPER_SNAKE` env ref.
- `applyProfileDefaults(local, profile)` — profile supplies defaults,
  slot-local fields override field-by-field, `tags` replace.

## Request parameters

`buildRequestParams(profile, base, capabilities?)` derives one candidate's
`{ maxTokens, effectiveMaxTokens, thinking?, reasoningEffort?, temperature? }`
— the boot-constant logic runtime-core used to compute once per run, lifted
so it runs once per candidate. An effort preset sets both `thinking` (via
the shared budget table) and `reasoningEffort`; the ceiling is lifted to
`budget + maxTokens` when the budget crowds it out; and `maxTokens` is
clamped to the candidate's known `maxOutputTokens` (`clampedTo` records
it), so a profile never asks a model for more than it can emit.

## Tool advertisement

`buildAdvertisement(tools, profile, { capabilities, retain })` is
**subset-only**: a profile's `tools:` can remove shape tools (by name or a
`mcp__<server>__*` glob) but never add one — a pattern that matches nothing
is reported in `unmatched`. Tools whose `requiresModelFeatures` the
candidate cannot satisfy are dropped, and `tools: []` keeps the
auto-registered loop tools named in `retain` unless a `permissions.deny`
removes them. The returned `names` set is what the runtime's dispatch gate
enforces, so the subset holds in execution, not only in the advertisement.

## Routing

- `evaluateRules(rules, signals)` — first-match rule routing over
  `RouteSignals`, with three guards on `message_matches`: validation
  (`validateRuleRegex`) rejects nested quantifiers, more than one unbounded
  quantifier (`.*a.*X` and `a+a+X` backtrack polynomially) and more than 12
  quantifiers of any kind; the text is length-capped at 1024 characters, so
  the worst accepted pattern is quadratic over the cap; and a per-turn time
  budget skips later text rules with a `rule_skipped` reason.
  `deriveSignalRecord` is the persistable projection — derived values only,
  never the user's text.
- `parseModelDirective("/model fast", roster)` — the per-message steering
  token, allow-list validated against the roster; a miss is refused with the
  roster listed.
- `eligibleCandidates(candidates, turn)` — N1 capability-eligibility: the
  turn's requirement vector (images, context size, tools, a matched rule's
  `requires`) intersected with each candidate's features, declared
  `requires`, breaker state, `enabled` flag and remaining cost cap. The
  exclusion reasons are a closed vocabulary; `cheapestEligible` is the
  tie-break.

## Learning guards

- `planFingerprint(plan)` — canonical-JSON FNV-1a over the full plan, so
  `policyVersion` changes whenever a setting, rule or strategy does.
- `loadPriors(json, { expectFingerprint })` — N2 eval-seeded priors in
  reward units, pseudo-count capped at ten; a malformed or fingerprint-stale
  file is ignored with a reason, never applied. `seededScoreLookup`
  composes them under a live scoreboard so seeded arms skip warm-up.
- `checkFloor(arms, floor)` — the conservative-bandit constraint: an arm is
  exploitable only if its Wilson lower bound on judged quality is within
  `tolerance` of the floor arm's mean under the same judge; otherwise the
  policy serves the floor and records `floor-blocked`.

See the 0.6.0 design in `design/` and module brief 307 in
[crewhaus/docs](https://github.com/crewhaus/docs).
