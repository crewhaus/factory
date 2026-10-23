# @crewhaus/proof-checker

v0.8.0 (design/0.8.0-provability-release.md §6.4): the pluggable proof checkers
behind the provability ladder's `proven` rung. A checker **checks**; the model
searches. `ProofCheck` (in `@crewhaus/tool-proof`) hands a checker the model's
statement and proof, and the checker's verdict is the only thing the `proven`
rung trusts. No model call anywhere in this package.

| Checker | Needs | Language |
|---|---|---|
| `builtin` | nothing — always available | a small certificate language for finite, arithmetic and propositional claims (below) |
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

Every checker implements `ProofChecker` (`src/types.ts`): `id`, a one-paragraph
`language` written for the model (the `ProofCheckers` tool shows it verbatim),
`available()` and `check()`. `check()` never throws — every refusal is
`{ ok: false, reason }` in one sentence, with a `counterexample` when the checker
found one (the retry nudge's best input, design §0 scenario C).

## `builtin` — the certificate checker

Exact rationals over bigint (never floats), bounded quantifiers over explicit
finite domains, and eleven proof rules (plus `contra`, which only ever exposes
inconsistent hypotheses) — small enough to read in one sitting.
Nothing is executed: the checker parses text and evaluates exact arithmetic.

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

- Numbers are integer or decimal literals (`10.5`), read as exact rationals.
  Names are `[A-Za-z_][A-Za-z0-9_]*`. The usual Unicode forms (`≤ ≥ ≠ → ↔ ¬ ∧ ∨ ∀
  ∃ ∈ × ÷ −`) and `== && || ! <=>` read as their ASCII spelling.
- A binder's body runs as far right as possible.
- `let` is expanded where it is parsed (each use is replaced by its value), so
  two statements that differ only in how they name their data are equal. Indexed
  constants are arrays: `let s = [9, 10.5, 13] in … s[i] …`. A `let` value whose
  variable a quantifier inside its scope rebinds is refused (it would be
  captured); so is reusing a bound name. A chain of `let`s that expands past the
  node cap is refused at once: a value's free variables are collected while it is
  parsed, never by walking its expansion.
- `forall x, y in D: φ` is `forall x in D: forall y in D: φ`; a `D` that mentions
  `x` or `y` is refused (in the inner copy it would mean the outer binder).
- Unbounded quantifiers (`forall x: …`, `forall n in Nat: …`, `∀ n ∈ ℕ`) are
  refused with a reason that names `smt` and `lean4`.
- A syntax error is `ok: false` with `line L, column C`.

Evaluation: `/` by zero, an exponent that is not a non-negative integer, and an
index that is not an in-range integer are **errors** (the step is rejected),
never values. `and`, `or` and `->` evaluate left to right and stop early, so
`x = 0 or 1/x < 2` is safe at `x = 0`. A range `a..b` is every integer from `a`
to `b` inclusive (empty when `b < a`); a set `{…}` is its listed values, kept as
written.

### Proofs

`proof` is a JSON array of steps (or `{"steps": [...]}`), or the single word
`eval` — the one-step certificate for a closed statement that is true by
evaluation:

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

A step has exactly the keys `id` (1–64 of `A–Z a–z 0–9 _ . : -`, unique), `stmt`,
`by`, and optionally `from` (earlier step ids) and `with`. The **last** step's
formula must equal the statement — compared as formulas (alpha-equivalent,
numbers by value), not as strings.

| Rule | Premises (`from`) | Accepts the step when |
|---|---|---|
| `given` | none | a hypothesis, recorded in `assumptions`. A CLOSED one must evaluate true, and an open one that is never true whatever its variables are (`k * 0 = 1`) is refused: a false hypothesis would let anything follow. When the **statement** is closed, every given must be closed too: a hypothesis about another quantity cannot bear on it, and two contradictory ones (`k = 0`, `k = 1`) would prove anything. Two givens `x = <closed term>` may not give `x` two values. A step that assumes the statement itself is refused. |
| `eval` | none | the formula is closed and evaluates true; quantifiers are enumerated. False ⇒ rejected with the refuting assignment as `counterexample`. |
| `arith` | `x = <closed term>` equations (optional) | the step is one comparison; after substituting the premises' values it is ground and true by exact arithmetic, **or** `lhs − rhs` expands to a polynomial that is 0 (for `=`) or a constant satisfying the comparison (otherwise) — i.e. it holds for every value of the remaining variables. `x * x = x` is refused although it holds at `x = 1`. Division by, `^`, `abs`/`min`/`max` or an index over a variable is refused. |
| `subst` | `a = b`, then φ | the step is φ with some occurrences of `a` replaced by `b` or of `b` by `a`; an occurrence under a binder that captures their variables is not replaceable. |
| `mp` | φ and `φ -> ψ` (or `φ <-> ψ`), either order | the step is ψ (or, for `<->`, the other side). |
| `and_intro` | φ, ψ | the step is `φ and ψ`, in premise order. |
| `and_elim` | `φ and ψ`; `with: {"side": "left"\|"right"}` optional | the step is that side (either, when `side` is absent). |
| `or_intro` | φ | the step is a disjunction with φ as one side. |
| `cases` | `φ1 or φ2`, `φ1 -> ψ`, `φ2 -> ψ` — or one premise per domain value (no more premises than values) | the step is ψ — or `forall x in D: φ` with every `φ[x := d]`, `d ∈ D` (closed `D`), among the premises. |
| `contra` | φ and `not φ` | **never** — the proof is rejected: "the hypotheses are inconsistent; anything follows from them". |
| `instantiate` | `forall x in D: φ`; `with: {"x": v}` | `v` is closed, in `D`, and the step is `φ[x := v]` (`v` as written). |
| `witness` | `φ[x := v]`; `with: {"x": v}` | the step is `exists x in D: φ`, `v` closed and in `D`. |

No induction and no unbounded quantification — `by: "induction"` is refused with
a pointer to `lean4` (or `smt` for arithmetic).

**Inconsistent hypotheses.** The calculus has no sub-proofs: every step follows
from the givens. So a proof that reaches φ and `not φ` (`contra`), or a step that
is never true whatever its variables are — a CLOSED step that evaluates false
(`0 = 1` by `subst` from `k = 0` and `k * 2 = 1`), or an open one like
`x - x = 1` — has shown its givens inconsistent, and is rejected: the same
verdict `smt` gives an unsatisfiable preamble. With the closed-statement rule
above, a closed statement is proven only when it is true (design §0 scenario C).

A decorative variable does not get round that. An open statement that is never
true whatever its variables are (`y = y and 1 = 2`, `abs(y) >= 0 and 1 = 2`,
`y * 0 = 1`) is refuted before any step is read, with its failure at one
assignment as the `counterexample`. "Never true" is read off the formula, never
searched for (`src/builtin/everywhere.ts`): closed parts are evaluated, a
comparison whose sides differ by a constant polynomial is decided, and the
connectives combine their parts in the evaluator's stop-early order. And after
the last step, every given and the statement are read again at the values the
givens `x = <closed term>` fix — evaluated when that fixes all their variables,
put to the never-true test when it fixes some — so `y = 1` with
`y = 1 -> y = 7`, or `k = 1` with `k = 1 -> (y = y and 1 = 2)`, is rejected as
inconsistent.

What remains trusted is a set of open givens whose inconsistency nothing here
can read off: `y > 0` with `y > 0 -> (abs(y) >= 0 -> 1 = 2)` proves
`abs(y) >= 0 -> 1 = 2`, because nothing here knows `abs(y) >= 0` always holds.
Such givens are listed as assumptions on every surface, which is where the design
keeps them (§2, "assumptions are first-class"); the second one states the false
claim outright.

When a proof is rejected and the statement is closed, the checker evaluates the
statement itself (unless the caller cancelled): if it is false its
counterexample is attached; if it is true the output says the proof `eval`
proves it. A false intermediate step's refutation is in the `reason`, never the
`counterexample` — it says nothing about the claim.

### Bounds

`BUILTIN_LIMITS`: statement and each `stmt` ≤ 20 000 characters; proof ≤ 1 000 000
characters and ≤ 2 000 steps, each `from` ≤ 2 000 ids; parser nesting ≤ 200; a
`let`-expanded formula ≤ 200 000 nodes and depth ≤ 1 000; a domain ≤ 10 000
values; ≤ 1 000 000 quantifier cases per check; ≤ 20 000 000 work units; numbers
≤ 8 192 bits; `arith` polynomials ≤ 2 000 terms and degree ≤ 64; a wall-clock
deadline from `timeoutMs` (default 10 s, **capped at 10 s** —
`maxTimeoutMs` — whatever the caller passes) and the caller's `AbortSignal`.
A check holds a core for its whole budget, which is why the deadline is
capped: `formal.timeout_ms` (30 s by default, sized for a container's cold
start) reaches the sandbox checkers whole but never stretches a check here.
Parsing, measuring, printing, every rule and every loop spend from one
budget, and the clock is checked before and after each step, so a spent budget
is a rejection, never a hang. The never-true probe alone spends from a fork of
that budget (at most 2 s, its own work and case counts, the same deadline and
signal), so it never eats a proof's allowance; a probe it cannot finish refutes
nothing.

`createBuiltinChecker` runs each check on a worker thread of its own, so the
harness's event loop — every session, every tenant of a managed daemon —
keeps running while a check does (design §18). An abort terminates the
worker at once, as does a worker still running 2 s past its deadline (its own
budget stops it at the deadline). At most `maxConcurrentChecks` (4) run at a
time; a check past that waits for a free thread inside its own deadline. The worker runs `src/builtin/worker-source.ts`, the checker bundled
as text so a `bun build --compile` binary carries it; after changing the
checker run `bun run scripts/gen-worker-source.ts` (a test fails until you
do). Where no worker can start, the check runs on the caller's thread after
one yield; `builtinCheckerCounts()` reports how often. `checkCertificate` is
the same check, synchronous, on whatever thread calls it.

## `smt` — Z3 in a sandbox

`statement` is the goal as ONE SMT-LIB term; `proof` is the preamble, using only
`set-logic` (first), `declare-const`, `declare-fun`, `define-fun`,
`declare-sort`, `define-sort`, `declare-datatype(s)` and `assert`. Everything
else — `check-sat`, `push`/`pop`, `reset`, `echo`, `set-option`, `set-info`,
`get-*`, `eval`, `include`, `exit` — is refused before the container runs.
`declare-datatypes` takes the SMT-LIB 2.6 form only.

**Names.** Z3 accepts a redefinition of its own built-ins: a preamble
`(define-fun <= ((a Int) (b Int)) Bool true)` would "prove" `(<= 11 10)` with no
assumptions. So every name the preamble or the statement introduces — declared
constants and functions, definitions and their parameters, sorts and sort
parameters, datatype constructors and selectors, `let` / `forall` / `exists` /
`lambda` / `match` binders, and `:named` labels — must be letters, digits and
`_` starting with a letter (optionally `|quoted|`, the same symbol), must not be
in `SMT_RESERVED_NAMES` / `SMT_RESERVED_SORTS` or start with `bv`, and a global
name may be declared once. The reserved set is SMT-LIB 2.6's reserved words and
theory symbols plus every alphanumeric symbol Z3 resolves undeclared — in 4.16.0
(the curated image's) and 4.11.2 (an older solver a programmatic `images.smt`
override may carry; the spec's `formal.image` overrides lean4 alone) — found by
applying each identifier string in the binary to several argument shapes
(`(simplify name)` alone misses `equals`, `equiv`, `if_then_else`, and only a
`(List Int)` argument reaches `insert`, `nil`, `head` and `tail`, the parts of
Z3's built-in `List` sort, which is reserved too); operator spellings, dotted
and hyphenated names cannot match the pattern at all. The live test re-runs
that probe on the image, with known built-ins as controls, so a Z3 bump that
adds a built-in fails until the name is reserved. A list datatype of the
preamble's own names its parts otherwise (`Nil`, `cons`, `hd`, `tl`).

The adapter parses both into S-expressions (refusing backslashes in strings and
quoted symbols, and control characters, so no reader can split them
differently) and writes the script itself, re-printed from the parse:

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

One run of `z3 -in` with the script on stdin. `unknown` or a timeout on either
check is a rejection; a Z3 `(error …)` before the second answer is a rejection;
every `assert` (its term) and every `define-fun` (whole) is reported in
`assumptions` — a definition can fix the very value the goal states, as
`(define-fun revenue () Int 5)` does for `(= revenue 5)`. A model reads
`x = 4, y = -6`; an empty one (a goal with no free constants) reads "z3 found
the negated goal satisfiable but showed no values".

## `lean4` — Lean 4 in a sandbox

`statement` is a Lean proposition; `proof` is a term or a tactic block,
optionally preceded by `import` lines. The adapter writes

```lean
import <the proof's leading imports>
theorem crewhaus_claim : (
    <statement, each line indented 4>
    )
    :=
  <proof, each line indented 2>
#print axioms crewhaus_claim
```

The adapter's own parentheses close the statement off, so an unfinished one
(`… ∨ let x`) is a parse error rather than something the proof completes across
the `:=` line.

and runs `lean --stdin --json` (configurable `argv`, e.g. `lake env lean --stdin
--json` on a project image). A deterministic **pre-scan** runs first, over
exactly the statement and proof text the file holds, with comments (`--`, nested
`/- -/`) and string, raw-string and char literals blanked (a `«…»` name is kept
as a name: a quote, `/-` or bracket inside it opens or closes nothing). Words
split where Lean's lexer splits them — its own identifier characters, not
Unicode's — so `2omega` is the numeral `2` and the word `omega`, while
`xomega` and `h₁omega` are single names:

- a `forbid` token (`formal.forbid`; default `sorry`, `axiom`, `native_decide`)
  as a whole word is refused — inside a comment or a string it is not code;
- a character literal or raw string must follow a space, a line break, an
  opening bracket, `,` or `;`. Elsewhere (`!'"'`, `0')'`, `1e5r"…"`, `«x»'a'`)
  whether Lean opens one depends on lexer details the scan does not guess, and
  a wrong guess would hide code from it or invent a bracket, so it is refused
  with "put a space before it";
- a command keyword (`theorem`, `def`, `example`, `instance`, `macro`, `elab`,
  `syntax`, `notation`, `set_option`, `attribute`, `end`, `run_tac`, … —
  `LEAN4_COMMAND_WORDS`), a `#command` (`#eval`, `#print`, `#exit`; `#[…]` array
  literals are fine) or an attribute `@[…]` is refused: the statement and proof
  must stay inside the ONE theorem, or they could end it and declare another,
  change how `#print axioms` reports, or switch off the kernel check;
- `import` lines must lead the proof, hold nothing but module names (a comment
  there would vanish from the rewritten header while hiding the next line from
  the scan), and name `Init`, `Std` or their submodules — plus `Mathlib…` when
  `image` overrides the curated image (only a Mathlib image can load it);
  `imports` replaces the allowlist for trusted config;
- a statement containing `:=`, or whose brackets (`() [] {} ⟨⟩ ⦃⦄ ⟦⟧ ‹›`) do not
  balance, is refused: either could end the theorem's type early and splice the
  proof into a block the statement opened, so the type proven would not be the
  statement shown;
- a string literal containing `{`, or one after a `!` (`s!"…"`, `m! "…"`), is
  refused — `s!`, `m!`, `dbg_trace`, `throwError` and `trace[…]` all read `{…}`
  inside a string as code — and so are unterminated comments, strings and `«…»`
  names.

Verdict: ok ⇔ lean exits 0, reports no `error`, and the `#print axioms` message
— the JSON message positioned on the adapter's own line, so nothing the proof
prints can impersonate it — parses. `sorryAx` is always a rejection; an axiom
through which the proof trusts the compiler — `Lean.ofReduceBool` /
`Lean.ofReduceNat` / `Lean.trustCompiler`, or the `<decl>._native.<tactic>.ax_i_j`
auxiliary Lean 4.34 leaves for `native_decide` and for `decide +native` (which
never spells `native_decide`, so only this check sees it) — is a rejection
while `native_decide` is forbidden. Any other axiom beyond `propext`,
`Classical.choice` and `Quot.sound` is recorded in `axioms` and the proof stays
ok — shown, not hidden (design §6.4).

## Sandbox posture (design §10)

Proof text is model output that may have absorbed injected content, and `smt` and
`lean4` hand it to a program. They run only in a container sandbox
(`@crewhaus/sandbox` defaults: `--network none`, `--read-only`, a `/tmp` tmpfs,
memory and CPU caps) and refuse on the `noop` backend — which would run the
checker on the host — in both `available()` and `check()`. That refusal lives in
the checker because `ProofCheck` is not `requiresSandbox` at the tool level (the
builtin needs no sandbox). Trusted code may pass `allowNoop: true`.

`available()` runs the image's healthcheck (`z3 --version`, `lean --version`)
once; a pass is remembered, a failure for `probeRetryMs` (60 s). Each sandbox
checker exposes its `image`; `checkerImages(checkers)` lists them for the
sandbox's `allowedImages`. The curated refs join the registry allowlist
(`listAllowedImageRefs()`) through `ensureZ3SandboxImage()` /
`ensureLean4SandboxImage()`.

With no sandbox at all, `createDefaultCheckers` still lists `smt` / `lean4` —
`available()` says why they cannot run and `check()` refuses — so the model sees
what it could prove with instead of a checker silently missing.

## Tests

```sh
bun test                                          # unit tests; no Docker, no Z3
CREWHAUS_PROOF_CHECKER_HOST_Z3=1 bun test src/smt.host.test.ts   # real Z3 on PATH, via the noop backend

# the real images through a real docker sandbox (build them first, from the repo root):
bun scripts/build-sandbox-images.ts
CREWHAUS_SECTION36_LIVE_DOCKER=1 bun test src/sandbox.live.test.ts
```

The unit tests also replay what Z3 4.16.0 and Lean 4.34.1 print in the curated
images, captured verbatim, so the output parsers are held to the real tools
without Docker. `sandbox.live.test.ts` runs both checkers on the images as a
harness does — network none, read-only root, a `/tmp` tmpfs, uid 65532, 512 MB:
proofs, counterexamples, inconsistent hypotheses, `sorry` and the `sorryAx`
backstop, `Classical.choice` capture, compiler-trust axioms (`bv_decide`
running the image's cadical among them), a `formal.image` override on and off
the allowlist — and re-probes the image's Z3 for built-ins the reserved list
lacks (list-sorted arguments included, with known built-ins as controls so a
blind probe fails too). It never pulls: a missing image fails with the build
command.
