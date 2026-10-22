# W1-D — `@crewhaus/proof-checker` + the two sandbox image registrations (design §6.4, §13; PR train 7 core + 8 adapters)

You own: `packages/proof-checker/**`, `packages/sandbox-image-z3/**`,
`packages/sandbox-image-lean4/**`. The contract `packages/proof-checker/src/types.ts` is
committed (`ProofChecker`, `CheckInput`, `CheckResult`, `SandboxLike`) — implement against it.
Read design §6.4, §10 (sandbox posture), §16 (why builtin + smt + lean4), §18 (risks).
No model calls anywhere. The checkers CHECK; the model searches.

## 1. `builtin` — a dependency-free certificate checker (always available, no Docker)

Design the smallest language that can carry the claims a harness actually makes (finite,
arithmetic, propositional), and keep the verifier small enough to read in one sitting. Document
the grammar in the package README and in `language` (one paragraph, shown to the model by the
`ProofCheckers` tool, so write it FOR a model: concise, exact, with one example).

- Terms: exact rationals (bigint numerator/denominator — never floats), integer and decimal
  literals, variables `[A-Za-z_][A-Za-z0-9_]*`, `+ - * /`, `^` with a non-negative integer
  exponent, unary minus, parentheses, `abs(x)`, `min(a,b,…)`, `max(a,b,…)`. Division by zero is
  an error, not a value.
- Formulas: `= != < <= > >=` between terms; `true`, `false`; `not φ`, `φ and ψ`, `φ or ψ`,
  `φ -> ψ`, `φ <-> ψ` (state precedence and associativity); bounded quantifiers over EXPLICIT
  finite domains: `forall x in {1, 2, 5}: φ`, `exists x in {…}: φ`, and integer ranges
  `forall i in 0..5: φ` (inclusive; cap the domain size, e.g. 10 000, and refuse beyond it).
  Nested quantifiers allowed (cap total enumerations, e.g. 1 000 000).
- `statement`: one formula. `proof`: a certificate — a JSON array of steps
  `{ "id": "s1", "stmt": "<formula>", "by": "<rule>", "from": ["s0", …], "with": {…} }`
  (accept a JSON object `{ "steps": [...] }` too). The LAST step's `stmt` must equal the
  statement (compare normalized ASTs, not strings).
- Rules (each checks its premises are earlier step ids):
  `given` (hypothesis → recorded in `assumptions`; a CLOSED given that evaluates false is
  rejected as inconsistent), `eval` (a closed formula — finite quantifiers allowed — that
  evaluates true under exact arithmetic; on a false `forall`, return the falsifying assignment as
  `counterexample`), `arith` (an equation/inequality whose two sides normalize to the same exact
  value, or whose truth follows by evaluation, with variables only if bound by `with`
  substitution — define it precisely), `subst` (from `a = b` and φ derive φ[a:=b]),
  `mp` (φ, φ -> ψ ⊢ ψ), `and_intro`, `and_elim` (`with: {side: "left"|"right"}`), `or_intro`,
  `cases` (φ1 or φ2, φ1 -> ψ, φ2 -> ψ ⊢ ψ), `contra` (φ, not φ ⊢ any stmt),
  `instantiate` (forall x in D: φ, value v ∈ D via `with: {x: v}` ⊢ φ[x:=v]),
  `witness` (φ[x:=v] with v ∈ D ⊢ exists x in D: φ).
- No induction, no unbounded quantifiers: refuse with a reason that names `smt` / `lean4`.
- Bounded everything (statement/proof size, steps ≤ 2 000, AST depth, enumeration caps, a
  deadline from `timeoutMs`); a parse error returns `ok:false` with the position, never throws.
- Result: `ok`, `assumptions` (the given statements, normalized text), `axioms: []`, `output`
  (a short per-step trace), `counterexample?`, `reason?`, `durationMs`.
- Acceptance example (design §0 scenario C): "no two of the six meetings overlap" with start/end
  constants, proved by `eval` over `forall i in 0..5: forall j in 0..5: i = j or e_i <= s_j or
  e_j <= s_i`-style encoding — decide how indexed constants are expressed (e.g. allow a `with`
  table, or `let` definitions, or array literals `s = [9, 10.5, …]` and `s[i]` indexing — pick
  one, keep it small, document it); a false version yields a counterexample naming the pair.

## 2. `smt` — SMT-LIB 2 to Z3 in a sandbox

`createSmtChecker({ sandbox: SandboxLike, image?, timeoutMs? })`. Input: `statement` = the goal
as one SMT-LIB term; `proof` = the problem preamble (declare-const/declare-fun/define-fun/
assert/set-logic only — reject any other command, especially `check-sat`, `exit`, `push/pop`,
`reset`, `echo`, `set-option`, `get-*`, with a reason). Run TWICE in one container call or two:
(1) preamble + `(check-sat)` must be `sat` — inconsistent hypotheses are rejected
("hypotheses are inconsistent; anything follows from them"); (2) preamble +
`(assert (not <statement>))` + `(check-sat)` + `(get-model)`: `unsat` ⇒ ok; `sat` ⇒ rejected
with the model as `counterexample`; `unknown`/timeout ⇒ rejected. Argv `["z3", "-in"]` with the
script on stdin (the sandbox's `stdin`), network none (the sandbox default). Every `assert` in
the preamble is reported in `assumptions`. Parse output robustly. `available()` → ok only when
`sandbox.backend !== "noop"`, with a reason otherwise. Tests use a fake `SandboxLike` that
returns scripted outputs and records argv/stdin (assert the exact script shape).

## 3. `lean4` — Lean 4 in a sandbox

`createLean4Checker({ sandbox, image?, forbid?, timeoutMs? })`. Deterministic PRE-SCAN before
any container runs: strip Lean comments (`-- …` and nested `/- … -/`) and string literals, then
refuse any `forbid` token as a whole word (default `sorry`, `axiom`, `native_decide`), and refuse
`import` lines other than an allowlist you define (Mathlib only when the image is overridden —
decide and document). File: `theorem crewhaus_claim : <statement> := <proof>` (if `proof` starts
with `by` or is a term; document the exact rule), then `#print axioms crewhaus_claim`. Run
`lean --stdin` (verify the flag name for Lean 4; if unsure, write the file via stdin to
`/tmp/claim.lean` with a shell `-c` and run `lean /tmp/claim.lean` — the image is ours to
define). ok ⇔ exit 0, no `error:` lines, and the axioms output parses; axioms beyond `propext`,
`Classical.choice`, `Quot.sound` are recorded in `axioms` (and ok stays true — they are shown,
not hidden, design §6.4). Tests with a fake sandbox.

## 4. Registry + defaults
`createCheckerRegistry(checkers)` (`get(id)`, `list()`, duplicate-id refusal) and
`createDefaultCheckers({ sandbox?, images?, forbid?, timeoutMs?, ids? })` returning the checkers
for `formal.checkers` order (sandbox checkers only when a sandbox is given; otherwise they are
present but `available()` says why not). Export the default image refs from the two image
packages and use them as defaults here.

## 5. `@crewhaus/sandbox-image-z3` and `@crewhaus/sandbox-image-lean4`
Mirror `packages/sandbox-image-go` exactly (read its src + test): `registerZ3SandboxImage()` /
`registerLean4SandboxImage()` into `@crewhaus/sandbox-image-registry` (ids `z3`, `lean4`),
healthcheck argv (`["z3", "--version"]`, `["lean", "--version"]`), default entrypoints, cold-start
budget constants, and the T2/T7/T8-style contract tests the go package has. Image refs:
`ghcr.io/crewhaus/sandbox-z3:<VERSION>` and `ghcr.io/crewhaus/sandbox-lean4:<VERSION>` where the
version is read from the package's own package.json at build time is NOT possible in a compiled
binary — instead export a constant tag (`"0.8.0"`) plus `Z3_IMAGE_REPO` and document that the
release builds these images (another builder adds the Dockerfiles in wave 3). The registry's
`listAllowedImageRefs()` is how they join the sandbox allowlist — confirm by reading it.

Tests everywhere: grammar/parse errors, every rule accepting and rejecting, counterexamples,
caps, the three checkers' argv/stdin shapes and output parsing, pre-scan refusals (incl. a
`sorry` inside a comment NOT refused, inside code refused), inconsistent hypotheses, the
registry. Replace the scaffold READMEs.

Verify: `bunx tsc -b` + `bun test` in all three packages; biome on your files.
