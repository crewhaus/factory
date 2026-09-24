/**
 * Tool category expansion — the `all-<category>` / `-<tool>` selector
 * grammar a spec's `tools:` list accepts.
 *
 * A spec can write:
 *
 *   tools:
 *     - all-code        # every tool in the code roll-up
 *     - -bash           # ...except this one
 *     - webFetch        # plus one tool by name
 *
 * Semantics, deliberately order-independent so a reader never has to
 * simulate the list top to bottom:
 *
 *   1. Every include (`all-<category>` or a bare tool key) is unioned.
 *   2. Every exclude (`-<tool>` or `-all-<category>`) is then subtracted.
 *
 * Excludes therefore always win, whatever order they appear in. Writing a
 * tool as both an include and an exclude removes it.
 *
 * Expansion happens once, at lower() time, so the IR carries concrete tool
 * names and every target emitter keeps working unchanged. That is a Pillar 1
 * requirement: an emitter must never have to know what a category is.
 */
import { CrewhausError } from "@crewhaus/errors";
import { CATEGORIES, type CategoryDef, leafCategories, rollUpCategories } from "./registry";

export { CATEGORIES, type CategoryDef, leafCategories, rollUpCategories };
export {
  BUILTIN_TOOLS,
  type BootRegistrar,
  type BuiltinToolEntry,
  type ChainBootConfig,
  HOST_BOOT_SEAMS,
  OPTIONAL_BOOT_SEAMS,
  TOOL_BOOT_REGISTRARS,
} from "./builtins";
export {
  type SpecChainBlocks,
  type ToolConfigCheck,
  type ToolConfigEnv,
  type ToolConfigInit,
  type ToolConfigNotice,
  type ToolSite,
  applyToolConfig,
  chainBootConfig,
  checkCandidateToolConfigs,
  checkToolConfigs,
  malformedToolConfigRefs,
  planChainInits,
  planToolConfigInits,
  type ReadmeToolFact,
  readmeToolFacts,
  renderToolConfigInit,
  resolveToolConfigEnv,
  toolConfigBlockFor,
  toolConfigEnvRefs,
  toolConfigHint,
  toolConfigKeysReaching,
} from "./config";
export {
  BuiltinToolError,
  type ResolvedTools,
  SANDBOX_AVAILABLE_EXPR,
  SHAPE_TOOL_PROFILES,
  type ShapeToolProfile,
  type ToolPackageImporter,
  type ToolShape,
  type ToolVerdict,
  builtinKeyForName,
  builtinToolsFor,
  checkBuiltinTool,
  registerToolConfigs,
  registeredToolName,
  resolveBuiltinTools,
  sandboxAvailableFromEnv,
  unknownToolMessage,
} from "./shapes";

export class ToolCategoryError extends CrewhausError {
  override readonly name = "ToolCategoryError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

/** Prefix that turns a category name into an include selector. */
const ALL_PREFIX = "all-";
/** Prefix that turns any selector into an exclusion. */
const NOT_PREFIX = "-";

/** A parsed selector, before any category is resolved. */
export type Selector =
  | { readonly kind: "tool"; readonly key: string; readonly exclude: boolean }
  | { readonly kind: "category"; readonly name: string; readonly exclude: boolean };

/**
 * Parse one raw selector string. Pure and total — an unknown category name
 * parses fine here and is only rejected during resolution, so the caller can
 * report every bad name at once rather than dying on the first.
 */
export function parseSelector(raw: string): Selector {
  const exclude = raw.startsWith(NOT_PREFIX);
  const body = exclude ? raw.slice(NOT_PREFIX.length) : raw;
  if (body.startsWith(ALL_PREFIX)) {
    return { kind: "category", name: body.slice(ALL_PREFIX.length), exclude };
  }
  return { kind: "tool", key: body, exclude };
}

/** True when this list uses any category selector or exclusion at all. */
export function usesCategorySyntax(selectors: ReadonlyArray<string>): boolean {
  return selectors.some((s) => s.startsWith(NOT_PREFIX) || s.startsWith(ALL_PREFIX));
}

/**
 * Resolve a category to its tool keys, following `includes` transitively.
 * Throws on an unknown name, and on a cycle (which would otherwise hang).
 */
export function toolsInCategory(name: string): ReadonlyArray<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (cat: string, trail: ReadonlyArray<string>): void => {
    if (seen.has(cat)) return;
    seen.add(cat);
    const def: CategoryDef | undefined = CATEGORIES[cat];
    if (def === undefined) {
      throw new ToolCategoryError(unknownCategoryMessage(cat, trail));
    }
    for (const key of def.tools ?? []) out.add(key);
    for (const child of def.includes ?? []) {
      if (trail.includes(child)) {
        throw new ToolCategoryError(`tool category cycle: ${[...trail, cat, child].join(" -> ")}`);
      }
      walk(child, [...trail, cat]);
    }
  };
  walk(name, []);
  return [...out].sort();
}

function unknownCategoryMessage(name: string, trail: ReadonlyArray<string>): string {
  const known = Object.keys(CATEGORIES).sort();
  const near = known.filter((k) => k.includes(name) || name.includes(k)).slice(0, 3);
  const hint = near.length > 0 ? ` Did you mean ${near.map((k) => `all-${k}`).join(", ")}?` : "";
  const via = trail.length > 0 ? ` (reached via ${trail.join(" -> ")})` : "";
  return `unknown tool category "all-${name}"${via}.${hint} Known categories: ${known
    .map((k) => `all-${k}`)
    .join(", ")}`;
}

export type ExpandOptions = {
  /**
   * Path reported in errors, e.g. `tools` or `steps[2].tools`, so a spec
   * author knows which list is wrong.
   */
  readonly path?: string;
};

export type ExpandResult = {
  /** Concrete tool keys, de-duplicated and sorted for a stable IR. */
  readonly tools: ReadonlyArray<string>;
  /** True when the input used category or exclusion syntax. */
  readonly expanded: boolean;
};

/**
 * Expand a `tools:` list into concrete tool keys.
 *
 * Throws `ToolCategoryError` on an unknown category, and on an exclusion
 * that removes nothing — a `-gitPush` that matches no included tool is
 * almost always a typo or a stale copy-paste, and silently ignoring it would
 * leave the author believing a tool is gated when it is not.
 */
export function expandToolSelectors(
  selectors: ReadonlyArray<string>,
  opts: ExpandOptions = {},
): ExpandResult {
  const path = opts.path ?? "tools";
  const expanded = usesCategorySyntax(selectors);
  if (!expanded) {
    // Identity, deliberately: a spec that does not opt into the category
    // grammar must lower to byte-identical bundles, so this path does not
    // sort, de-duplicate, or otherwise touch the author's list.
    return { tools: selectors, expanded: false };
  }

  const parsed = selectors.map(parseSelector);
  const included = new Set<string>();
  const excluded = new Set<string>();
  const categoryErrors: string[] = [];

  for (const sel of parsed) {
    const sink = sel.exclude ? excluded : included;
    if (sel.kind === "category") {
      try {
        for (const key of toolsInCategory(sel.name)) sink.add(key);
      } catch (err) {
        categoryErrors.push(err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    sink.add(sel.key);
  }

  if (categoryErrors.length > 0) {
    throw new ToolCategoryError(`${path}: ${categoryErrors.join("; ")}`);
  }

  const inert = [...excluded].filter((key) => !included.has(key)).sort();
  if (inert.length > 0) {
    const names = inert.map((k) => `"-${k}"`).join(", ");
    const verb = inert.length === 1 ? "excludes a tool that" : "exclude tools that";
    const have = [...included].sort().join(", ") || "(nothing)";
    throw new ToolCategoryError(
      `${path}: ${names} ${verb} nothing includes. Remove the exclusion, or add the category that provides it. Currently included: ${have}`,
    );
  }

  const tools = [...included].filter((key) => !excluded.has(key)).sort();
  return { tools, expanded: true };
}

/** Every tool key the registry knows about, across all leaf categories. */
export function allRegisteredTools(): ReadonlyArray<string> {
  const out = new Set<string>();
  for (const name of leafCategories()) {
    for (const key of CATEGORIES[name]?.tools ?? []) out.add(key);
  }
  return [...out].sort();
}

/** Which categories own a given tool key. Leaves first, then roll-ups. */
export function categoriesForTool(key: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const name of Object.keys(CATEGORIES).sort()) {
    let owns = false;
    try {
      owns = toolsInCategory(name).includes(key);
    } catch {
      owns = false;
    }
    if (owns) out.push(name);
  }
  return out;
}
