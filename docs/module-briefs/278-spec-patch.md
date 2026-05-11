# Module brief 278 — `spec-patch`

**Catalog layer:** F2 (compiler periphery).
**Pillar:** Pillar 2 — eval is active. The structured-mutation primitive the optimiser uses.
**Source:** [`packages/spec-patch/src/index.ts`](../../packages/spec-patch/src/index.ts).

## Responsibility

`spec-patch` carries the `SpecPatch` type and `applySpecPatch(yamlText, patch)` helper that the active eval optimiser uses to translate "the prompt that scored higher" back into a YAML edit. Uses the `yaml` package's CST so comments and key order survive the round-trip.

## Public surface

```ts
export type SpecPatchOp = "replace" | "add" | "remove";

export type SpecPatch = {
  readonly target: Spec["target"];
  readonly path: ReadonlyArray<string>;
  readonly op: SpecPatchOp;
  readonly value?: unknown;
  readonly rationale?: string;
};

export type ApplySpecPatchResult = {
  readonly yaml: string;
  readonly spec: Spec;
};

export function applySpecPatch(yamlText: string, patch: SpecPatch): ApplySpecPatchResult;
export function validatePatch(spec: Spec, patch: SpecPatch): void;
export function formatWriteBackHeader(opts: { ... }): string;

export const OPTIMIZABLE_PATHS: Readonly<Record<Spec["target"], ReadonlyArray<ReadonlyArray<string>>>>;
```

## Architectural note — why SPEC, not IR

The compiler does destructive normalisation in `lower()`: sub-agent maps become arrays, role names get alphabetically sorted, secrets get rewritten to env-var refs, permission rules get de-duped and re-ordered. The IR is intentionally lossy.

A patch at the IR layer can't round-trip back to YAML; the source-author's comments and field ordering are gone. `spec-patch` therefore operates at the SPEC layer (the YAML AST) — the optimiser's `--write-back` rewrites the user's file with their comments preserved and only the touched values changed.

IR-passes (`@crewhaus/ir-passes`) stay separate — codegen-time optimisations that run after lowering. They don't get conflated with eval-driven mutation. The two systems share nothing; that's intentional.

## `OPTIMIZABLE_PATHS`

Per-target whitelist of mutation paths the active optimiser is allowed to touch. Adding a new field here is the explicit signal that it's safe to autotune. The list deliberately excludes security-critical fields (`permissions.mode`, `model_router` rules, MCP server configs); the optimiser cannot rewrite the production safety floor.

| Target | Whitelisted paths (v0) |
|---|---|
| `cli` | `agent.instructions`, `compaction.threshold` |
| `workflow` | `steps` (whole-step replacement) |
| `channel` | `agent.instructions` |
| `graph` | `nodes` (whole-node replacement) |
| `managed` | `agent.instructions` |
| `pipeline` | `agent.instructions`, `indexing.chunkSize`, `indexing.chunkOverlap`, `retrieve.defaultK` |
| `crew` | `roles` (whole-role replacement) |
| `research` | `agent.instructions`, `retrieve.maxDepth` |
| `batch` | `agent.instructions` |
| `voice` | `agent.instructions` |
| `browser` | `agent.instructions` |
| `eval` | `agent.instructions` |

## Depends on

- `@crewhaus/errors`
- `@crewhaus/spec`
- `yaml` (^2.6.0) — for the CST API
- `zod` — for patch schema validation

## Unblocks

- `@crewhaus/eval-optimizer-orchestrator` (279)
- `crewhaus optimize` CLI subcommand
- Future plugin-loaded mutation paths

## Tests

- `round-trip.test.ts` — replace + add + remove round-trip via the CST
- `yaml-comment-preservation.test.ts` — leading and structural comments survive
- `validate-patch.test.ts` — cross-target patches, non-existent paths, malformed shapes
- `optimizable-paths.test.ts` — every target shape has at least one entry

## Risk markers

🟢 (low risk) — pure function over a well-tested CST library; the destructive operation is gated by `applySpecPatch` re-parsing through `parseSpec` so an invalid mutation surfaces immediately.
