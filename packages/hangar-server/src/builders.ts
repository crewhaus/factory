/**
 * M3 · SPEC — the builders: the new-spec wizard, the grader builder, the
 * dataset builder, and the MCP connectors tab.
 *
 * STUBS. Owned by the Spec implementer alongside `spec-edit.ts`.
 *
 * These are the four surfaces that CREATE configuration rather than edit it,
 * and all four are wrappers over published packages — the manager must not
 * grow a second implementation of any of them:
 *
 *   wizard   → the published new-spec wizard package (the same one the
 *              Studio mounts). It emits a spec; the manager writes it with
 *              the spec write path and registers the new dir.
 *   graders  → the published grader-builder package → `eval/graders.yaml`.
 *   dataset  → `@crewhaus/dataset-builder`'s state machine, mounted per
 *              harness. Its OUTPUT lands in the dataset registry (see
 *              `data-ops.ts`), which is why this route only drives the
 *              machine and never writes a dataset file itself.
 *   mcp      → the lifted studio-server `mcp-writer`, which is the only
 *              sanctioned writer of the spec's `mcp:` block.
 *
 * Two traps the connector surface must not re-learn:
 *   - `$FOO` / `${FOO}` inside an MCP `env:` map NEVER expands. A literal
 *     that looks like an env reference is a boot-time `ConfigError` waiting
 *     to happen, and the linter (`creds-ops.ts` `mcpLint`) exists to say so
 *     BEFORE the write.
 *   - a credential pasted as a literal into an MCP config is the single most
 *     common way a secret enters a spec. Refuse the write, do not mask it
 *     and continue.
 *
 * `POST /api/builders/spec` is the one M3 route that creates a harness
 * DIRECTORY. It takes an absolute `dir` exactly like `POST /api/harnesses`
 * does — the only door arbitrary absolute paths come through — and must
 * apply the same validation before registering the result.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/builders/templates` — the wizard's template gallery.
 *
 * Fleet-wide (no harness yet): the starter/template catalog the wizard picks
 * from, with each entry's target shape and what it scaffolds.
 */
export const wizardTemplates: M3Handler = () => notImplemented("wizard templates");

/**
 * `POST /api/builders/spec` — materialize a new harness from wizard answers.
 *
 * Body: `{ dir, template, answers }`. `dir` is absolute and must be
 * validated + created like `POST /api/harnesses` does; the spec is rendered
 * by the wizard package, written once, then the dir is registered so it
 * appears in the Library immediately. `scaffold-evals` is offered next, not
 * done implicitly.
 */
export const wizardCreate: M3Handler = () => notImplemented("wizard create");

/**
 * `GET /api/h/:id/builders/graders` — the grader catalog + this harness's
 * current `eval/graders.yaml`, with the `graders card` rendering per
 * `gradersHash` so an operator can see WHICH graders a run was scored by.
 */
export const graderCatalog: M3Handler = () => notImplemented("grader catalog");

/**
 * `POST /api/h/:id/builders/graders` — write `eval/graders.yaml`.
 *
 * Through the published grader-builder, containment-checked, and re-read
 * afterwards so the response is what is actually on disk.
 */
export const graderWrite: M3Handler = () => notImplemented("grader write");

/**
 * `GET /api/h/:id/builders/dataset` — the dataset builder's current state.
 *
 * `@crewhaus/dataset-builder`'s state machine snapshot for this harness.
 */
export const datasetBuilder: M3Handler = () => notImplemented("dataset builder state");

/**
 * `POST /api/h/:id/builders/dataset` — advance the dataset builder.
 *
 * Body is one state-machine event. The machine owns the transitions; this
 * route must not encode any of them.
 */
export const datasetBuilderStep: M3Handler = () => notImplemented("dataset builder step");

/**
 * `GET /api/builders/mcp-catalog` — the curated MCP connector catalog.
 *
 * Fleet-wide, harness-independent. Custom entries are typed by hand into the
 * same form; the catalog is a convenience, never a whitelist.
 */
export const mcpCatalog: M3Handler = () => notImplemented("mcp catalog");

/**
 * `GET /api/h/:id/builders/mcp` — this harness's `mcp:` block plus the lint.
 *
 * Every server's env-refs resolved to PRESENCE booleans (never values), with
 * the never-expanding `$FOO` literals and credential-shaped literals flagged
 * — the same findings `mcpLint` reports, rendered next to the editor.
 */
export const mcpConnectors: M3Handler = () => notImplemented("mcp connectors");

/**
 * `POST /api/h/:id/builders/mcp` — add/replace one MCP server entry.
 *
 * Written through the lifted `mcp-writer` (never by editing YAML text).
 * Refuse a credential-shaped literal outright; refuse a `$VAR` inside `env:`
 * with the expansion explanation.
 */
export const mcpConnectorWrite: M3Handler = () => notImplemented("mcp connector write");

/**
 * `DELETE /api/h/:id/builders/mcp/:name` — remove one MCP server entry.
 *
 * A spec edit like any other: `mcp:` is human-owned, so this is
 * confirm-gated and goes through the spec write path, not a YAML splice.
 */
export const mcpConnectorRemove: M3Handler = () => notImplemented("mcp connector remove");
