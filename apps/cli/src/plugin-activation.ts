/**
 * Item 3 (G32) — `plugins:` activation, the CLI resolution half. The spec's
 * `plugins:` list lowers to `IrV0.plugins` and a compiled bundle activates it
 * at boot via `@crewhaus/plugin-loader` (`renderPlugins` in `@crewhaus/target-cli`).
 * `crewhaus run` / `crewhaus dev` reach the same activation, and BOTH honour a
 * `--plugins <a,b,c>` override that replaces the spec list for that invocation.
 *
 * Only the pure name resolution lives here (unit-testable without a loader / a
 * disk registry); the entry file `index.ts` wires the real `activatePlugins`
 * (for `run`, in-process) and the compile-time spec override (for `dev`).
 */

/**
 * Parse a `--plugins` flag value: a comma-separated list of plugin names.
 * Whitespace is trimmed per entry and empty entries are dropped, so
 * `"a, ,b,"` → `["a", "b"]`. Order is preserved (activation de-dupes downstream).
 */
export function parsePluginsFlag(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The effective plugin names to activate for one `run`/`dev` invocation:
 * `--plugins <names>` (parsed) OVERRIDES the spec's `plugins:` list when
 * present, else the spec list is used verbatim, else none. A present-but-empty
 * flag (`--plugins ""` / `--plugins " "`) is an explicit "activate no plugins"
 * override, distinct from the flag being absent.
 */
export function resolvePluginNames(
  specPlugins: readonly string[] | undefined,
  flag: string | undefined,
): readonly string[] {
  if (flag !== undefined) return parsePluginsFlag(flag);
  return specPlugins ?? [];
}
