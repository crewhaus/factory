# hello-optimize

The smallest possible demonstration of Pillar 2 — active eval optimization.

The spec ships with a deliberately terse `agent.instructions: "Answer the user's question."`. The included dataset (10 capital-of-X questions) and grader (`contains-expected`) make it easy to see the rule-based optimizer add a `"Be concise and direct."` clarification and improve grader pass-rate.

## Run it

```bash
# Default: rule-based mutator, emits patch.json + report.json
crewhaus optimize examples/hello-optimize/crewhaus.yaml \
  --dataset examples/hello-optimize/dataset.jsonl \
  --graders examples/hello-optimize/graders.yaml \
  --iterations 5 \
  --seed 42

# Apply the winning candidate directly to crewhaus.yaml
crewhaus optimize examples/hello-optimize/crewhaus.yaml \
  --dataset examples/hello-optimize/dataset.jsonl \
  --graders examples/hello-optimize/graders.yaml \
  --iterations 5 \
  --seed 42 \
  --write-back

# Use Claude-driven mutations (requires ANTHROPIC_AUTH_TOKEN or
# ANTHROPIC_API_KEY)
crewhaus optimize examples/hello-optimize/crewhaus.yaml \
  --dataset examples/hello-optimize/dataset.jsonl \
  --graders examples/hello-optimize/graders.yaml \
  --iterations 5 \
  --mutator claude
```

The patch is persisted under `.crewhaus/optimize/<runId>/patch.json` regardless of `--write-back`. The report at `.crewhaus/optimize/<runId>/report.json` records the score delta, the patched path, and the timestamp.

## What this proves

This example is the smallest concrete proof of Pillar 2 in [/CLAUDE.md](../../CLAUDE.md): the eval stack can produce a *spec patch* that improves grader pass-rate, not just an HTML report. The patch is the artifact that closes the active-optimization loop.

See [docs/recipes/42-active-optimization.md](../../docs/recipes/42-active-optimization.md) for the narrative walkthrough.
