# @crewhaus/proof-checker

The pluggable proof checkers behind the provability ladder's `proven` rung. A checker **checks**;
the model searches. `ProofCheck` (in [`@crewhaus/tool-proof`](../tool-proof)) hands a checker the
model's statement and proof, and the checker's verdict is the only thing the `proven` rung
trusts. No model call anywhere in this package.

| Checker | Needs | Language |
|---|---|---|
| `builtin` | nothing; always available | a small certificate language for finite, arithmetic and propositional claims (below) |
| `smt` | a docker/podman sandbox + `ghcr.io/crewhaus/sandbox-z3` | SMT-LIB 2, checked by Z3 |
| `lean4` | a docker/podman sandbox + `ghcr.io/crewhaus/sandbox-lean4` | Lean 4 (Mathlib-free unless `formal.image` overrides the image) |

```ts
import { createCheckerRegistry, createDefaultCheckers } from "@crewhaus/proof-checker";

const checkers = createDefaultCheckers({
  ids: ir.provability.formal.checkers,          // order = preference told to the model
  sandbox,                                       // absent ⇒ smt/lean4 listed but unavailable
  images: { lean4: ir.provability.formal.image },
  forbid: ir.provability.formal.forbid,
  timeoutMs: ir.provability.formal.timeoutMs,
});
const registry = createCheckerRegistry(checkers); // a repeated id is refused
const result = await registry.get("builtin")!.check({ claim, statement, proof });
// { ok, checker, assumptions, axioms, output, counterexample?, reason?, durationMs }
```

## API

Every checker implements `ProofChecker` (`src/types.ts`): `id`, a one-paragraph `language`
written for the model (the `ProofCheckers` tool shows it verbatim), `available():
Promise<CheckerAvailability>` and `check(input: CheckInput): Promise<CheckResult>`. `check()`
never throws: every refusal is `{ ok: false, reason }` in one sentence, with a `counterexample`
when the checker found one (the retry nudge's best input). `assumptions` are the hypotheses the
proof rests on; `axioms` are what it trusts beyond the checker's base. A checker of your own
implements the same interface and reaches the tools through `createCheckerRegistry` or
tool-proof's `checkers` option. A spec cannot name one yet: `formal.checkers` takes `builtin`,
`smt` and `lean4`, and the plugin loader has no slot for a checker.

| Export | What it is |
|---|---|
| `createDefaultCheckers(opts?)` | The checkers for a `provability.formal` block, in `ids` order (default `DEFAULT_CHECKER_IDS`: `builtin`, `smt`; a repeated id is skipped). Options: `sandbox`, `images` (`smt`, `lean4`), `forbid`, `timeoutMs`, `allowNoop`, `lean4` (`imports`, `argv`). An unknown id throws `ProofCheckerConfigError`. |
| `createCheckerRegistry(checkers)` | `get`, `has`, `list`, `ids`, in registration (= preference) order; an empty or repeated id throws. |
| `checkerImages(checkers)` | The images the sandbox checkers run, for the sandbox's `allowedImages`. |
| `createBuiltinChecker({ timeoutMs? })`, `checkCertificate(input)` | The builtin on a worker thread, and the same check synchronous. `BUILTIN_RULES`, `BUILTIN_LIMITS`, `BUILTIN_LANGUAGE`, `builtinCheckerCounts()`, `stoppedWithoutVerdict(result)`. |
| `createSmtChecker(opts)` | The Z3 adapter. `buildSmtScript`, `parseSExprs`, `printSExpr`, `parseSmtOutput`, `formatModel`, `isReservedSmtName`, `SMT_RESERVED_NAMES`, `SMT_RESERVED_SORTS`, `SMT_PREAMBLE_COMMANDS`, `SMT_NAME_PATTERN`, `SMT_LIMITS`. |
| `createLean4Checker(opts)` | The Lean adapter. `prescanLean`, `lexLean`, `stripLean`, `parseLeanOutput`, `readAxioms`, `LEAN4_COMMAND_WORDS`, `LEAN4_DEFAULT_FORBID`, `LEAN4_STANDARD_AXIOMS`, `LEAN4_CORE_IMPORTS`, `LEAN4_OVERRIDE_IMPORTS`, `LEAN4_THEOREM_NAME`, `LEAN4_LIMITS`. |
| `DEFAULT_SMT_IMAGE`, `DEFAULT_LEAN4_IMAGE` | The curated refs, re-exported from the image packages. `DEFAULT_SANDBOX_TIMEOUT_MS` is 30 s. |

## `builtin`: the certificate checker

Exact rationals over bigint (never floats), bounded quantifiers over explicit finite domains,
and a short list of proof rules (`BUILTIN_RULES`), small enough to read in one sitting. Nothing
is executed: the checker parses text and evaluates exact arithmetic.

### Statements

```
formula := binder | iff
binder  := ("forall" | "exists") name {"," name} "in" domain ":" formula
         | "let" name "=" (term | array) {"," name "=" (term | array)} "in" formula
iff     := imp ["<->" imp]                 does not chain
imp     := or ["->" imp]                   right-associative
or      := and {"or" and}
and     := not {"and" not}
not     := "not" not | binder | cmp
cmp     := sum [("=" | "!=" | "<" | "<=" | ">" | ">=") sum]   does not chain
sum     := product {("+" | "-") product}
product := unary {("*" | "/") unary}
unary   := "-" unary | power
power   := postfix ["^" unary]             right-associative; -x^2 = -(x^2)
postfix := primary {"[" sum "]"}           array index, from 0
primary := number | name | "true" | "false" | "(" formula ")"
         | "abs" "(" sum ")" | ("min" | "max") "(" sum {"," sum} ")" | array
array   := "[" [sum {"," sum}] "]"
domain  := "{" [sum {"," sum}] "}" | sum ".." sum         inclusive integer range
```

- Numbers are integer or decimal literals (`10.5`), read as exact rationals. Names are
  `[A-Za-z_][A-Za-z0-9_]*`. The usual Unicode forms (`≤ ≥ ≠ → ↔ ¬ ∧ ∨ ∀ ∃ ∈ × ÷ −`) and
  `== && || ! <=>` read as their ASCII spelling.
- A binder's body runs as far right as possible.
- `let` is expanded where it is parsed, so two statements that differ only in how they name
  their data are equal. Indexed constants are arrays: `let s = [9, 10.5, 13] in … s[i] …`. A
  `let` value whose variable a quantifier inside its scope rebinds is refused (it would be
  captured), and so is reusing a bound name.
- `forall x, y in D: φ` is `forall x in D: forall y in D: φ`; a `D` that mentions `x` or `y` is
  refused.
- Unbounded quantifiers (`forall x: …`, `forall n in Nat: …`, `∀ n ∈ ℕ`) are refused with a
  reason that names `smt` and `lean4`.
- A syntax error is `ok: false` with `line L, column C`.

Evaluation: `/` by zero, an exponent that is not a non-negative integer, and an index that is
not an in-range integer are **errors** (the step is rejected), never values. `and`, `or` and `->`
evaluate left to right and stop early, so `x = 0 or 1/x < 2` is safe at `x = 0`. A range `a..b`
is every integer from `a` to `b` inclusive (empty when `b < a`); a set `{…}` is its listed values.

### Proofs

`proof` is a JSON array of steps (or `{"steps": [...]}`), or the single word `eval`, the one-step
certificate for a closed statement that is true by evaluation:

```json
[
  { "id": "g1", "stmt": "x = 3", "by": "given" },
  { "id": "g2", "stmt": "x = 3 -> y = 2*x + 1", "by": "given" },
  { "id": "m",  "stmt": "y = 2*x + 1", "by": "mp", "from": ["g1", "g2"] },
  { "id": "s",  "stmt": "y = 2*3 + 1", "by": "subst", "from": ["g1", "m"] },
  { "id": "a",  "stmt": "2*3 + 1 = 7", "by": "arith" },
  { "id": "done", "stmt": "y = 7", "by": "subst", "from": ["a", "s"] }
]
```

A step has exactly the keys `id` (1–64 of `A–Z a–z 0–9 _ . : -`, unique), `stmt`, `by`, and
optionally `from` (earlier step ids) and `with`. The **last** step's formula must equal the
statement, compared as formulas (alpha-equivalent, numbers by value), not as strings.

| Rule | Premises (`from`) | Accepts the step when |
|---|---|---|
| `given` | none | a hypothesis, recorded in `assumptions`. A closed one must evaluate true, and an open one that is never true whatever its variables are (`k * 0 = 1`) is refused. When the **statement** is closed, every given must be closed too. Two givens `x = <closed term>` may not give `x` two values. A step that assumes the statement itself is refused. |
| `eval` | none | the formula is closed and evaluates true; quantifiers are enumerated. False ⇒ rejected with the refuting assignment as `counterexample`. |
| `arith` | `x = <closed term>` equations (optional) | the step is one comparison; after substituting the premises' values it is ground and true by exact arithmetic, **or** `lhs − rhs` expands to a polynomial that is 0 (for `=`) or a constant satisfying the comparison, so it holds for every value of the remaining variables. `x * x = x` is refused although it holds at `x = 1`. Division by, `^`, `abs`/`min`/`max` or an index over a variable is refused. |
| `subst` | `a = b`, then φ | the step is φ with some occurrences of `a` replaced by `b` or of `b` by `a`; an occurrence under a binder that captures their variables is not replaceable. |
| `mp` | φ and `φ -> ψ` (or `φ <-> ψ`), either order | the step is ψ (or, for `<->`, the other side). |
| `and_intro` | φ, ψ | the step is `φ and ψ`, in premise order. |
| `and_elim` | `φ and ψ`; `with: {"side": "left"\|"right"}` optional | the step is that side (either, when `side` is absent). |
| `or_intro` | φ | the step is a disjunction with φ as one side. |
| `cases` | `φ1 or φ2`, `φ1 -> ψ`, `φ2 -> ψ`, or one premise per domain value | the step is ψ, or `forall x in D: φ` with every `φ[x := d]`, `d ∈ D` (closed `D`), among the premises. |
| `contra` | φ and `not φ` | **never**: the proof is rejected, "the hypotheses are inconsistent; anything follows from them". |
| `instantiate` | `forall x in D: φ`; `with: {"x": v}` | `v` is closed, in `D`, and the step is `φ[x := v]`. |
| `witness` | `φ[x := v]`; `with: {"x": v}` | the step is `exists x in D: φ`, `v` closed and in `D`. |

No induction and no unbounded quantification: `by: "induction"` is refused with a pointer to
`lean4` (or `smt` for arithmetic).

**Inconsistent hypotheses are rejected, not used.** The calculus has no sub-proofs: every step
follows from the givens. So a proof that reaches φ and `not φ`, or a step that is never true
whatever its variables are (a closed step that evaluates false, or an open one like
`x - x = 1`), has shown its givens inconsistent, and is rejected, the verdict `smt` gives an
unsatisfiable preamble. An open statement that is never true (`y = y and 1 = 2`) is refuted
before any step is read, with its failure at one assignment as the `counterexample`; "never
true" is read off the formula, never searched for (`src/builtin/everywhere.ts`). After the last
step, every given and the statement are read again at the values the givens `x = <closed term>`
fix, so `y = 1` with `y = 1 -> y = 7` is rejected. With the closed-statement rule above, a
closed statement is proven only when it is true.

When a proof is rejected and the statement is closed, the checker evaluates the statement
itself: if it is false its counterexample is attached; if it is true the output says `eval`
proves it. A false intermediate step's refutation is in the `reason`, never the
`counterexample`: it says nothing about the claim.

### Bounds

`BUILTIN_LIMITS`: statement and each `stmt` ≤ 20 000 characters; proof ≤ 1 000 000 characters
and ≤ 2 000 steps, each `from` ≤ 2 000 ids; parser nesting ≤ 200; a `let`-expanded formula
≤ 200 000 nodes and depth ≤ 1 000; a domain ≤ 10 000 values; ≤ 1 000 000 quantifier cases and
≤ 20 000 000 work units per check; numbers ≤ 8 192 bits; `arith` polynomials ≤ 2 000 terms and
degree ≤ 64. The wall-clock deadline is `timeoutMs` (default 10 s) and is **capped at 10 s**
(`maxTimeoutMs`) whatever the caller passes, because a check holds a core for its whole budget:
`formal.timeout_ms` (30 s by default, sized for a container's cold start) reaches the sandbox
checkers whole but never stretches a check here. Every rule and loop spends from one budget and
the clock is checked around each step, so a spent budget is a rejection, never a hang. The
never-true probe spends from a fork of it (at most 2 s), and a probe it cannot finish refutes
nothing.

`createBuiltinChecker` runs each check on a worker thread of its own, so the harness's event loop
(every session, every tenant of a managed daemon) keeps running while a check does. An abort
terminates the worker at once, as does a worker still running 2 s past its deadline. At most
`maxConcurrentChecks` (4) run at a time; a check past that waits for a free thread inside its own
deadline. The worker runs `src/builtin/worker-source.ts`, the checker bundled as text so a
`bun build --compile` binary carries it: after changing the checker, run
`bun run scripts/gen-worker-source.ts` from `packages/proof-checker` (a test fails until you
do). Where no worker can start, the check runs on the caller's thread after one yield, and
`builtinCheckerCounts()` reports how often. `stoppedWithoutVerdict(result)` tells a check that
was cancelled, ran out of time or failed from one that rejected the proof.

## `smt`: Z3 in a sandbox

`statement` is the goal as ONE SMT-LIB term; `proof` is the preamble, using only `set-logic`
(first), `declare-const`, `declare-fun`, `define-fun`, `declare-sort`, `define-sort`,
`declare-datatype(s)` (SMT-LIB 2.6 form only) and `assert`. Everything else (`check-sat`,
`push`/`pop`, `reset`, `echo`, `set-option`, `set-info`, `get-*`, `eval`, `include`, `exit`) is
refused before the container runs.

**Names.** Z3 accepts a redefinition of its own built-ins: a preamble `(define-fun <= ((a Int)
(b Int)) Bool true)` would "prove" `(<= 11 10)` with no assumptions. So every name the preamble
or the statement introduces (constants, functions, definitions and their parameters, sorts,
datatype constructors and selectors, binders, `:named` labels) must be letters, digits and `_`
starting with a letter (optionally `|quoted|`), must not be in `SMT_RESERVED_NAMES` /
`SMT_RESERVED_SORTS` or start with `bv`, and a global name may be declared once. The reserved set
is SMT-LIB 2.6's reserved words and theory symbols plus every alphanumeric symbol Z3 resolves
undeclared, in 4.16.0 (the curated image's) and in 4.11.2 (an older solver a programmatic
`images.smt` override may carry), found by applying each identifier string in the binary to
several argument shapes, a `(List Int)` among them. The live test re-runs that probe on the
image, so a Z3 bump that adds a built-in fails until the name is reserved.

The adapter parses both into S-expressions (refusing backslashes in strings and quoted symbols,
and control characters, so no reader can split them differently) and writes the script itself,
re-printed from the parse:

```
(set-option :print-success false)
(set-option :produce-models true)
(set-option :timeout <a third of the budget, ≥ 1 s>)
<preamble>
(check-sat)                    ; 1: must be sat — inconsistent hypotheses are rejected
(assert (not <statement>))
(check-sat)                    ; 2: unsat ⇒ ok; sat ⇒ rejected with the model
(get-model)
(exit)
```

One run of `z3 -in` with the script on stdin. `unknown` or a timeout on either check is a
rejection, and so is a Z3 `(error …)` before the second answer. Every `assert` (its term) and
every `define-fun` (whole) is reported in `assumptions`: a definition can fix the very value the
goal states, as `(define-fun revenue () Int 5)` does for `(= revenue 5)`. A model reads
`x = 4, y = -6`.

## `lean4`: Lean 4 in a sandbox

`statement` is a Lean proposition; `proof` is a term or a tactic block, optionally preceded by
`import` lines. The adapter writes

```lean
import <the proof's leading imports>
theorem crewhaus_claim : (
    <statement, each line indented 4>
    )
    :=
  <proof, each line indented 2>
#print axioms crewhaus_claim
```

and runs `lean --stdin --json` (configurable `argv`, e.g. `lake env lean --stdin --json` on a
project image). The adapter's own parentheses close the statement off, so an unfinished one is a
parse error rather than something the proof completes across the `:=` line.

A deterministic **pre-scan** runs first, over exactly the statement and proof text the file
holds, with comments and string, raw-string and char literals blanked; words split where Lean's
lexer splits them, not where Unicode does. It refuses:

- a `forbid` token (`formal.forbid`; default `sorry`, `axiom`, `native_decide`) as a whole word;
- a command keyword (`LEAN4_COMMAND_WORDS`: `theorem`, `def`, `example`, `macro`, `set_option`,
  `end`, …), a `#command` (`#eval`, `#print`, `#exit`; `#[…]` array literals are fine) or an
  attribute `@[…]`: the statement and proof must stay inside the one theorem;
- `import` lines that do not lead the proof, hold anything but module names, or name a module
  outside `Init` and `Std` (plus `Mathlib…` when `image` overrides the curated image);
- a statement containing `:=`, or whose brackets do not balance, either of which could end the
  theorem's type early;
- a character literal or raw string glued to the token before it (a guess the scan does not
  make: "put a space before it"), a string literal containing `{` or after a `!` (`s!"…"`, which
  reads `{…}` as code), and unterminated comments, strings and `«…»` names.

Verdict: ok when lean exits 0, reports no `error`, and the `#print axioms` message (the one on
the adapter's own line, so nothing the proof prints can impersonate it) parses. `sorryAx` is
always a rejection. An axiom through which the proof trusts the compiler (`Lean.ofReduceBool`,
`Lean.ofReduceNat`, `Lean.trustCompiler`, or the `<decl>._native.<tactic>.ax_i_j` auxiliary
Lean 4.34 leaves for `native_decide` and for `decide +native`) is a rejection while
`native_decide` is forbidden. Any other axiom beyond `propext`, `Classical.choice` and
`Quot.sound` is recorded in `axioms` and the proof stays ok: shown, not hidden.

## Sandbox posture

Proof text is model output that may have absorbed injected content, and `smt` and `lean4` hand
it to a program. They run only in a container sandbox (`@crewhaus/sandbox` defaults:
`--network none`, `--read-only`, a `/tmp` tmpfs, memory and CPU caps) and refuse on the `noop`
backend, which would run the checker on the host, in both `available()` and `check()`. That
refusal lives in the checker because `ProofCheck` is not `requiresSandbox` at the tool level (the
builtin needs no sandbox). Trusted code may pass `allowNoop: true`.

`available()` runs the image's healthcheck (`z3 --version`, `lean --version`) under a 20 s probe
budget; a pass is remembered, a failure for `probeRetryMs` (60 s). Each sandbox checker exposes
its `image`; `checkerImages(checkers)` lists them for the sandbox's `allowedImages`. With no
sandbox at all, `createDefaultCheckers` still lists `smt` and `lean4`: `available()` says why
they cannot run and `check()` refuses, so the model sees what it could prove with instead of a
checker silently missing.

## Limits

- The builtin trusts a set of open givens whose inconsistency nothing here can read off:
  `y > 0` with `y > 0 -> (abs(y) >= 0 -> 1 = 2)` proves `abs(y) >= 0 -> 1 = 2`, because nothing
  here knows `abs(y) >= 0` always holds. Such givens are listed as assumptions on every surface,
  where the design keeps them, and the second one states the false claim outright.
- A proof is a check of the formal statement, not of the prose: whether `statement` means what
  the claim says is the formalization gap, which the bundle shows beside the claim.
- Z3 may answer `unknown` on quantifiers, or run past its timeout; either is a rejection, never a
  pass.
- The `smt` reserved-name list is proven against the curated Z3 only. An image a programmatic
  `images.smt` override names has not met the live probe; the spec's `formal.image` overrides
  `lean4` alone.
- The curated Lean image is Mathlib-free. A `bv_decide` proof trusts the compiler, so it is
  accepted only when the harness drops `native_decide` from `formal.forbid`.

## Tests

```sh
bun test src                                                     # unit tests; no Docker, no Z3
CREWHAUS_PROOF_CHECKER_HOST_Z3=1 bun test src/smt.host.test.ts   # real Z3 on PATH, via the noop backend

# the real images through a real docker sandbox (build them first, from the repo root):
bun scripts/build-sandbox-images.ts
CREWHAUS_SECTION36_LIVE_DOCKER=1 bun test src/sandbox.live.test.ts
```

The unit tests also replay what Z3 4.16.0 and Lean 4.34.1 print in the curated images, captured
verbatim, so the output parsers are held to the real tools without Docker.
`runner.compiled-binary.test.ts` builds a real single binary and checks that the builtin still
runs on a worker inside it. `sandbox.live.test.ts` runs both checkers on the images as a harness
does (network none, read-only root, a `/tmp` tmpfs, uid 65532, 512 MB): proofs, counterexamples,
inconsistent hypotheses, `sorry` and the `sorryAx` backstop, compiler-trust axioms, a
`formal.image` override on and off the allowlist, and a re-probe of the image's Z3 for built-ins
the reserved list lacks. It never pulls: a missing image fails with the build command.

Design: [design/0.8.0-provability-release.md](../../design/0.8.0-provability-release.md) §6.4,
§10.
