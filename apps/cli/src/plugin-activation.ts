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
import type { IrPluginEntry } from "@crewhaus/ir";
import { parseDocument } from "yaml";

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

/** One `plugins:` entry: a plugin name, or `{name, tools}` (#522). */
export type PluginEntry = IrPluginEntry;

/** The plugin an entry names. */
export function pluginEntryName(entry: PluginEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

/** The names of a list of entries, for a log line: never `[object Object]`. */
export function pluginEntryNames(entries: readonly PluginEntry[]): string {
  return entries.map(pluginEntryName).join(", ");
}

/**
 * The entries `--plugins <names>` activates against a spec's `plugins:`: a name
 * the spec lists as `{name, tools}` keeps that entry, so the flag can choose
 * which plugins load but never widen what one may drive; any other name is a
 * name entry. A repeat of a name kept as an object is dropped (the loader
 * keeps the first occurrence anyway; two objects would not compile).
 *
 * `specPlugins` may be the parsed spec's list or the raw YAML value `dev`
 * rewrites: any object entry with that `name` is kept as written, so a
 * malformed one is refused by the compile rather than replaced by a bare name.
 */
export function pluginEntriesFor(
  specPlugins: readonly unknown[] | undefined,
  names: readonly string[],
): PluginEntry[] {
  const objects = new Map<string, PluginEntry>();
  for (const entry of specPlugins ?? []) {
    if (entry === null || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && !objects.has(name)) objects.set(name, entry as PluginEntry);
  }
  const out: PluginEntry[] = [];
  const keptObjects = new Set<string>();
  for (const name of names) {
    const object = objects.get(name);
    if (object === undefined) {
      out.push(name);
      continue;
    }
    if (keptObjects.has(name)) continue;
    keptObjects.add(name);
    out.push(object);
  }
  return out;
}

/**
 * The effective plugin entries to activate for one `run`/`serve`/`dev`
 * invocation: `--plugins <names>` (parsed) OVERRIDES the spec's `plugins:`
 * list when present ({@link pluginEntriesFor} keeps the spec's `{name, tools}`
 * entry for a name it lists), else the spec list is used verbatim, else none.
 * A present-but-empty flag (`--plugins ""` / `--plugins " "`) is an explicit
 * "activate no plugins" override, distinct from the flag being absent.
 */
export function resolvePluginNames(
  specPlugins: readonly PluginEntry[] | undefined,
  flag: string | undefined,
): readonly PluginEntry[] {
  if (flag !== undefined) return pluginEntriesFor(specPlugins, parsePluginsFlag(flag));
  return specPlugins ?? [];
}

/**
 * `dev --plugins <names>`: the spec text with its `plugins:` key rewritten for
 * the launched child, through the same rule as `run` and `serve`
 * ({@link pluginEntriesFor} over the spec's own list), so a name the spec lists
 * as `{name, tools}` compiles as that entry, never as a bare name that would
 * let the plugin drive every host tool its manifest asks for. Throws what the
 * YAML parser throws.
 */
export function withPluginsOverride(yamlText: string, names: readonly string[]): string {
  const doc = parseDocument(yamlText);
  const specPlugins = (doc.toJS() as { plugins?: unknown } | null)?.plugins;
  doc.set("plugins", pluginEntriesFor(Array.isArray(specPlugins) ? specPlugins : undefined, names));
  return doc.toString();
}
