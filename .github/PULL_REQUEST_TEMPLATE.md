<!--
Thanks for contributing to CrewHaus.

Before submitting:
- [ ] Read CONTRIBUTING.md
- [ ] For non-trivial changes, opened an issue or RFC first
- [ ] Tests added or updated
- [ ] tsc -b passes locally
- [ ] biome check passes locally
- [ ] bun test passes locally
- [ ] Commits are signed off (git commit -s)
- [ ] Commit messages follow Conventional Commits
-->

## What this PR does

<!-- One or two sentences describing the change. -->

## Why this change is needed

<!-- Link the issue, RFC, or describe the motivation. -->

Closes #

## Type of change

<!-- Check all that apply -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that breaks existing behavior)
- [ ] Documentation only
- [ ] Refactor (no behavior change)
- [ ] Performance improvement
- [ ] Test improvement
- [ ] Chore (tooling, dependencies)

## Pillar alignment check

<!-- For non-trivial changes, confirm the change respects the three pillars from CLAUDE.md. -->

- [ ] **Pillar 1 (Compiler-first):** If this adds a target shape or compiler-level feature, it goes through the IR (`Ir<Target>V0` variant), not just codegen.
- [ ] **Pillar 2 (Active eval):** If this adds an optimizable spec parameter, it's listed in `OPTIMIZABLE_PATHS`. Patches mutate the spec, never the IR.
- [ ] **Pillar 3 (Security fabric):** If this ingests external content, it registers a `TrustOrigin` and calls `classifyBoundary` before the content reaches a model.

## Testing done

<!-- How did you verify the change works? Include commands run and outputs if relevant. -->

## Documentation updates

<!-- Did the docs change? Which files? -->

## Breaking changes

<!-- If breaking, describe the migration path and add a note to CHANGELOG.md. -->

## Notes for reviewers

<!-- Anything else you want reviewers to know. -->
