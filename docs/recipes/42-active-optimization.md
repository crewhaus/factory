# Recipe 42 — Active eval optimization (Pillar 2)

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `prompt-optimizer` (114), `prompt-optimizer-claude` (280), `spec-patch` (278), `eval-optimizer-orchestrator` (279), `eval-runner` (109), `dataset-registry` (110), `grader-registry` (111).
**Build-roadmap sections:** §16 (measurement), §29 (eval depth), §46 (active IR-patch optimizer — the section this recipe is the user-facing companion of).

## What this recipe shows

The original §29 shipped `prompt-optimizer` as a search function and `eval-runner` as a measurement function, but **nothing connected them** to the user-facing workflow. There was no `crewhaus optimize` command. The optimizer's output never became a spec patch. The eval reports never closed the loop. This recipe walks the user-facing workflow that does close the loop.

The contract is:

1. **You provide:** a spec, a dataset, a graders config.
2. **`crewhaus optimize` produces:** a `SpecPatch` (and optionally a rewritten YAML) that improved grader pass-rate, plus a report showing the score delta.

The patch is the artifact. It can be reviewed, committed, version-controlled, and re-applied — unlike a pure prompt string, it carries enough metadata to be auditable.

## TL;DR

```bash
crewhaus optimize examples/hello-optimize/crewhaus.yaml \
  --dataset examples/hello-optimize/dataset.jsonl \
  --graders examples/hello-optimize/graders.yaml \
  --iterations 5 \
  --seed 42 \
  --write-back
```

That writes the winning candidate's prompt back into `crewhaus.yaml`, prepending a header comment with the run id and score delta.

## How the loop closes

```
spec.yaml  ──parseSpec──►  Spec  ──extractCurrentPrompt──►  basePrompt
                                                                │
                                                                ▼
                                           MutationProvider (rule-based or claude)
                                                                │
                                                                ▼
                                                    candidate prompts
                                                                │
                                                                ▼
        spec.yaml  ──applySpecPatch──►  patched YAML  ──compile──►  IR
                                                                          │
                                                                          ▼
                                                                   eval-runner
                                                                          │
                                                                          ▼
                                                                    passRate
                                                                          │
                                                                          ▼
                                                              fitness for prompt-optimizer
                                                                          │
                                                                          ▼
                                                                  next iteration
```

Each iteration patches the spec, re-compiles, re-runs eval. The orchestrator records the trajectory and emits the winning patch.

## Mutators

### Rule-based (default)

Picks one of four deterministic mutations per iteration:

- `rephrase-instruction` — appends "Be concise and direct."
- `add-few-shot` — inserts a training sample as an `Example:` block
- `swap-example` — replaces an existing few-shot with a different one
- `add-COT-prefix` — prepends "Think step by step before answering."

The seeded RNG makes the search reproducible. Use this for tests and CI gates.

### Claude (model-driven)

Calls a Claude model with the current prompt and a sample of dev-set failures, asks for a single JSON `{ rewrite, rationale }`. The mutator falls back to the current best on any failure (model outage, malformed response) so the search loop never aborts mid-run.

```bash
crewhaus optimize <spec> --mutator claude --iterations 10
```

Requires `ANTHROPIC_AUTH_TOKEN` (Claude Max OAuth) or `ANTHROPIC_API_KEY`. Cost-gated via `cost-tracker` integration — set `--budget-usd N` (follow-up; v0 ships without the budget cap).

### When to use which

- **Rule-based** when you want a deterministic CI gate, a fast probe of "does the prompt have obvious room to improve", or you don't have Claude credentials.
- **Claude** when the prompt is the bottleneck (failures look like instruction-following issues, not skill issues) and you can spend real model dollars.

## Output

Every run produces:

- `.crewhaus/optimize/<runId>/patch.json` — the structured patch (always)
- `.crewhaus/optimize/<runId>/report.json` — score delta + mutator metadata
- `.crewhaus/optimize/<runId>/trajectory.json` — every candidate prompt + score
- `.crewhaus/optimize/<runId>/best.json` — the winning candidate

With `--write-back`, the source YAML is rewritten with a leading header comment:

```yaml
# crewhaus optimize: runId opt_xxxx
# - mutator: rule-based
# - iterations: 5
# - score: 0.450 → 0.780 (Δ 0.330)
# - generated: 2026-05-10T12:00:00Z

# (the rest of your YAML, with only the touched values changed —
# comments and key order preserved by the CST round-trip)
```

## Optimizable paths

The orchestrator's v0 only mutates `agent.instructions`. Workflow / graph / crew specs (with nested prompts) raise an error pointing at a follow-up that adds `--path <step.instructions>` support.

The full `OPTIMIZABLE_PATHS` whitelist (in [`packages/spec-patch/src/index.ts`](../../packages/spec-patch/src/index.ts)) covers every shipped target shape. Adding a new field to the whitelist is the explicit signal that "this field is safe to autotune." Security-critical fields (`permissions.mode`, `model_router` rules, MCP server configs) are deliberately excluded — the optimizer can't accidentally rewrite the production safety floor.

## What `--write-back` actually does

The biggest reason developers refuse to run `--write-back` against a committed spec is fear: "is the optimizer going to strip my comments? reorder my keys? clobber the `# DO NOT CHANGE THIS PROMPT` warning my teammate left?" The answer is no, but the mechanism is worth showing concretely so you trust the answer. (For a side-by-side walkthrough that includes the failing-eval trace events alongside the YAML before/after, see [GETTING-STARTED.md § Scenario 2 — an eval failed and the optimizer wants to patch your prompt](../GETTING-STARTED.md#scenario-2--an-eval-failed-and-the-optimizer-wants-to-patch-your-prompt).)

`applySpecPatch` ([packages/spec-patch/src/index.ts:90](../../packages/spec-patch/src/index.ts)) parses the YAML to a **concrete syntax tree** via the [`yaml`](https://eemeli.org/yaml/) package's `parseDocument`, mutates the targeted node by spec-path, and renders the tree back with `Document.toString()`. The CST tracks every byte of whitespace, every comment (leading, trailing, mid-line), and every key order. Bytes the patch doesn't touch render verbatim.

### Worked before/after

Starting spec:

```yaml
# crewhaus.yaml — coding agent for our team
# Owner: @max. Reviewed 2026-04-30.
name: my-coding-agent
target: cli

agent:
  model: claude-sonnet-4-6
  # DO NOT CHANGE THIS PROMPT WITHOUT TEAM REVIEW (incident 2026-03-04)
  instructions: |
    You help with TypeScript. Read files before editing.
tools:
  - read
  - edit
  - bash
permissions:
  mode: default
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAsk,   pattern: Bash(**) }
```

After `crewhaus optimize ... --write-back` with a rule-based mutator picking `add-COT-prefix`:

```yaml
# crewhaus optimize: runId opt_a8f3b21c
# - mutator: rule-based
# - iterations: 5
# - score: 0.450 → 0.780 (Δ 0.330)
# - generated: 2026-05-12T17:42:00Z

# crewhaus.yaml — coding agent for our team
# Owner: @max. Reviewed 2026-04-30.
name: my-coding-agent
target: cli

agent:
  model: claude-sonnet-4-6
  # DO NOT CHANGE THIS PROMPT WITHOUT TEAM REVIEW (incident 2026-03-04)
  instructions: |
    Think step by step before answering.

    You help with TypeScript. Read files before editing.
tools:
  - read
  - edit
  - bash
permissions:
  mode: default
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAsk,   pattern: Bash(**) }
```

Things to notice line by line:

- The header comment on `agent.instructions` — the `# DO NOT CHANGE THIS PROMPT…` line — is **untouched**. The patch path was `["agent", "instructions"]`; the comment is attached to the parent `agent` mapping's `instructions` key, and `Document.setIn` replaces the *value* without disturbing the surrounding comment metadata.
- The two top-of-file comments (`# crewhaus.yaml — coding agent…` and `# Owner: @max…`) are preserved verbatim and still precede the spec body.
- The blank line between `target: cli` and `agent:` is preserved — the CST tracks it as the trailing trivia of the `target` key.
- The `permissions` block is byte-identical. It was not in the patch path and therefore was not even visited.
- The new run-header comment (`# crewhaus optimize: …`) is prepended above everything via `formatWriteBackHeader`, so the audit trail of "this file was rewritten by an optimization run" is the first thing a reviewer sees in `git diff`.
- `tools:` is rendered as a block sequence in both files — the CST preserves the user's choice of block-vs-flow style. A spec written with `tools: [read, edit, bash]` would render back the same way.

### What happens if the optimizer targets a structurally volatile field

The critique scenario is: "two `alwaysAllow` rules in my YAML were deduped by the compiler. The optimizer wants to tighten one. Does it append a third rule? Overwrite the survivor? Silently fail?"

The answer is **none of those — the orchestrator refuses the patch at validation time, before it ever reaches the CST**. The `OPTIMIZABLE_PATHS` whitelist (above) excludes `permissions.rules`, `permissions.mode`, `mcp_servers.*`, and every other path whose lowering is not field-preserving (re-ordering, deduping, env-rewriting). `validatePatch` ([packages/spec-patch/src/index.ts:157](../../packages/spec-patch/src/index.ts)) throws a `SpecPatchError` with the path that the optimizer attempted and a pointer back to the whitelist:

```
SpecPatchError: path permissions.rules.2 is not listed in
OPTIMIZABLE_PATHS for target "cli"; add it to
packages/spec-patch/src/index.ts if it's intended to be tunable
```

For the v0 surface (`agent.instructions`, `compaction.threshold`, `indexing.chunkSize`, `indexing.chunkOverlap`, `retrieve.defaultK`, `retrieve.maxDepth`), the lowering is a 1:1 field copy from spec to IR. No dedup, no reorder, no rewrite. The patch path, the spec path, and the CST path are the same path. The "lossy lower" question doesn't apply at this layer; it's gated upstream.

If you want to extend the autotuning surface to a field that currently *is* lossy-lowered (e.g. `permissions.rules` after a "merge equivalent rules" pass), the contract is:

1. Make the lowering for that field field-preserving (or carry a position-stable id from spec to IR).
2. Add the path to `OPTIMIZABLE_PATHS`.
3. Add a test that round-trips a comment-bearing YAML through `applySpecPatch` for the new path and asserts the comments survive.

Step 1 is the work. Steps 2 and 3 are checkboxes. The single-chokepoint design only holds if every new optimisation surface goes through the same gate.

### Why this is enough (no source maps needed)

The critique reasonably asked whether the system uses a source map from the parse phase to track line numbers and node ids back to the CST. It doesn't — and doesn't need to. **Patches are addressed by spec field paths**, not by AST node ids. Those paths exist identically in the source YAML and in the parsed `Document`. The CST library handles the parse-and-render-back; the orchestrator never needs to refer to a line number to know where in the source to write.

The thing that would require a source map is patching IR-derived structure (a specific rule in a deduped, reordered `permissions.rules` array) back to the source. That is precisely the case `OPTIMIZABLE_PATHS` refuses. The whitelist *is* the design decision that says "we will not patch fields whose source-to-IR map is non-trivial." The choice is structural, not bolted-on.

See [docs/COMPILER-ARCHITECTURE.md §The lossy lower, and how `crewhaus optimize` writes back](../COMPILER-ARCHITECTURE.md#the-lossy-lower-and-how-crewhaus-optimize-writes-back) for the same contract from the compiler's side.

## Comparison to DSPy

This recipe is crewhaus's answer to DSPy's MIPRO result (+13% on five of seven multi-stage LM programs, cited in [`docs/AI-Harness-Systems.md`](../AI-Harness-Systems.md)). The differences:

- **Crewhaus mutates SPECS, not in-memory Python programs.** Patches are version-controllable; DSPy's program state typically isn't.
- **The mutation provider seam is explicit.** Rule-based and Claude-driven mutators are first-class; future providers (a DSPy bridge, an OPRO implementation) can plug in via the same `MutationProvider` interface without changing the orchestrator.
- **Comments and key order survive** via the YAML CST round-trip. A developer reviewing a `--write-back` diff sees exactly what changed.

## When to NOT use the optimizer

- **Before you have a real dataset.** The optimizer is only as good as the fitness function; a dataset with 5 samples will produce noise, not signal.
- **For security policy decisions.** The optimizer is a safety regression if it can write permission rules. `OPTIMIZABLE_PATHS` exists to prevent this.
- **As a substitute for thinking.** The Claude mutator can fix surface-level instruction-following issues, not architectural problems. If your eval is failing because your agent is missing a tool, no amount of prompt tuning will help.

See [/CLAUDE.md §Pillar-2](../../CLAUDE.md) for the contributor invariants this recipe is the user-facing companion of.
