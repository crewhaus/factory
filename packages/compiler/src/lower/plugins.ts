import type { IrPluginEntry } from "@crewhaus/ir";

/** A `plugins:` entry as the spec parses it. */
type SpecPluginEntry = string | { readonly name: string; readonly tools: readonly string[] };

/**
 * Item 3 (G32), #522 — lower the `plugins:` list. Carried only when non-empty
 * so an empty (or absent) declaration leaves bundles byte-identical; entry
 * order is preserved (load order). A name passes through unchanged, so a list
 * of names lowers exactly as it always did; a `{name, tools}` entry lowers
 * with its keys in that order and `tools` sorted and de-duplicated, so the
 * same grant always compiles to the same bytes. Carried on the codegen-serving
 * shapes (cli/channel).
 */
export function lowerPlugins(spec: { readonly plugins?: readonly SpecPluginEntry[] }): {
  plugins?: readonly IrPluginEntry[];
} {
  if (spec.plugins === undefined || spec.plugins.length === 0) return {};
  return {
    plugins: spec.plugins.map((entry) =>
      typeof entry === "string"
        ? entry
        : { name: entry.name, tools: [...new Set(entry.tools)].sort() },
    ),
  };
}
