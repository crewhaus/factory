/**
 * M3 · SPEC — the spec's write side: the structured editor, trust tiers,
 * version history + pins + diffs, and the `propose` review path.
 *
 * STUBS. Every handler here throws 501 until the Spec implementer fills it
 * in; the route, its guards, its masking and its client wrapper already
 * exist, so the only work left is the body.
 *
 * The one rule this module exists to enforce: **a spec is never written by
 * string-templating YAML.** Everything goes through `@crewhaus/spec-patch`
 * `applySpecEdits(yaml, edits, …)`, which is atomic, comment-preserving and
 * re-validating. Two tiers, enforced HERE and not merely in the UI:
 *
 *   auto-tunable — paths inside `OPTIMIZABLE_PATHS`. Apply with
 *     `{ restrictToOptimizable: true }`; the same restriction the optimizer
 *     runs under, so the console can never write what the machine may not.
 *   human-owned — everything else (permissions, the model roster/candidates,
 *     watchme.*, plugins, expose, learning.sources, thredz,
 *     sandbox/tool_config, transaction_policy). These require the
 *     credential-redacted `diffSpecYaml` interstitial plus a typed
 *     confirmation, or — when the harness is git-tracked — they route to
 *     `crewhaus propose` and become a review PR instead of a write.
 *
 * Everything served from here passes the maskers: `diffSpecYaml` output and
 * CHANGELOG bodies quote spec text verbatim, so a pasted credential reaches
 * a diff even when the live spec has been cleaned. `maskSpecYaml` for YAML,
 * `maskText` for prose, `maskDeep` for trees.
 *
 * Implementation needs `@crewhaus/spec-registry` (versions, pins, tenant
 * overlays, CHANGELOG) added to this package's dependencies + tsconfig
 * references; `@crewhaus/spec-patch` and `@crewhaus/spec` are already there.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `PUT /api/h/:id/spec` — apply a BATCH of spec edits.
 *
 * Body: `{ edits: SpecEdit[], expectedHash?, confirmName? }`.
 * Write: `applySpecEdits(yaml, edits, { restrictToOptimizable: true })` for
 * auto-tunable paths. Any human-owned path in the batch must be refused with
 * the diff + the reason (409), not silently dropped — the client then either
 * types the confirmation or calls {@link specPropose}.
 * Answer with the re-validated `parseSpecIssues` diagnostics and the new
 * version so the editor can rebase.
 */
export const specEdit: M3Handler = () => notImplemented("spec batch edit");

/**
 * `POST /api/h/:id/spec/patch` — apply ONE `SpecPatch`.
 *
 * The single-edit twin of {@link specEdit} (the form editor's per-field
 * save). Same restriction, same refusal, same re-validation.
 */
export const specPatch: M3Handler = () => notImplemented("spec single patch");

/**
 * `POST /api/h/:id/spec/diff` — PREVIEW a batch without writing it.
 *
 * The interstitial's data source: `diffSpecYaml(before, after)`, masked. A
 * preview must never touch the file — this is the one write-shaped route
 * that is a pure function of its inputs.
 */
export const specDiff: M3Handler = () => notImplemented("spec diff preview");

/**
 * `GET /api/h/:id/spec/schema` — the schema the structured editor renders.
 *
 * The harness-resolved spec schema (the zod union narrowed to this
 * harness's `target:`), plus the compile warnings that make accepted-but-
 * unwired keys visible as dead YAML. `@crewhaus/spec-forms` consumes this.
 */
export const specSchema: M3Handler = () => notImplemented("spec schema");

/**
 * `GET /api/h/:id/spec/trust` — the trust-tier map for this spec.
 *
 * Every path present in the spec, marked auto-tunable (in
 * `OPTIMIZABLE_PATHS`) or human-owned, with the reason. The editor badges
 * fields from this; the server enforces the same table on write, so the two
 * can never disagree.
 */
export const specTrust: M3Handler = () => notImplemented("spec trust tiers");

/**
 * `GET /api/h/:id/spec/versions` — the version history.
 *
 * Source: `.crewhaus/specs/<name>/manifest.json` (versions, env pins,
 * `_tenants/` overlays) plus the rendered CHANGELOG. Optimizer-authored
 * versions carry their `parseWriteBackHeader` provenance (score before →
 * after) as a badge. Diffs are credential-redacted.
 */
export const specVersions: M3Handler = () => notImplemented("spec version history");

/**
 * `GET /api/h/:id/spec/versions/:version` — one archived version's YAML.
 *
 * Masked with `maskSpecYaml`, never the raw file: an old version is exactly
 * where a credential that has since been cleaned out still lives.
 */
export const specVersion: M3Handler = () => notImplemented("spec version read");

/**
 * `GET /api/h/:id/spec/versions/:version/diff` — that version vs the live
 * spec (or vs `?against=<version>`), through `diffSpecYaml`, masked.
 */
export const specVersionDiff: M3Handler = () => notImplemented("spec version diff");

/**
 * `POST /api/h/:id/spec/pin` — pin/promote a version to an environment.
 *
 * Shells the `deploy` verbs rather than writing the manifest directly, so
 * the audit record and the quorum rule are preserved. Body:
 * `{ env, version, confirmName }` — a pin move is typed-confirm.
 */
export const specPin: M3Handler = () => notImplemented("spec pin/promote");

/**
 * `POST /api/h/:id/spec/rollback` — roll an environment back to a version.
 *
 * Same verb family as {@link specPin} and the same gate. The refusal an
 * active pin produces is a first-class state, not an error toast.
 */
export const specRollback: M3Handler = () => notImplemented("spec rollback");

/**
 * `POST /api/h/:id/spec/propose` — the review path for human-owned edits.
 *
 * Runs `crewhaus propose` through the job queue: a git-tracked harness gets
 * a review branch/PR instead of a direct write. This is where every refusal
 * from {@link specEdit} is meant to land, so the refusal must name it.
 */
export const specPropose: M3Handler = () => notImplemented("spec propose");
