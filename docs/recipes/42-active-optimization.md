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
