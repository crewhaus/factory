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
import {
  CATEGORIES,
  type CategoryDef,
  LOCAL_TOOLS_IN_NETWORK_ROLLUP,
  NETWORK_LEAVES_OUTSIDE_ROLLUP,
  NETWORK_TOOLS_OUTSIDE_ROLLUP,
  leafCategories,
  rollUpCategories,
} from "./registry";

export {
  CATEGORIES,
  type CategoryDef,
  LOCAL_TOOLS_IN_NETWORK_ROLLUP,
  NETWORK_LEAVES_OUTSIDE_ROLLUP,
  NETWORK_TOOLS_OUTSIDE_ROLLUP,
  leafCategories,
  rollUpCategories,
};
export {
  BUILTIN_TOOLS,
  type BootRegistrar,
  type RegistrarChecks,
  type BuiltinToolEntry,
  type ChainBootConfig,
  HOST_BOOT_SEAMS,
  LOOP_TOOL_NAMES,
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
  toolConfigProblems,
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
  SANDBOX_AVAILABLE_IMPORT,
  SANDBOX_AVAILABLE_SYMBOL,
  unknownToolMessage,
} from "./shapes";
/**
 * The case-insensitive edit distance compile's "did you mean" hints rank by,
 * so `crewhaus tools show` can offer the same near miss for a typo.
 */
export { distance as nameDistance } from "./distance";

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
    // An own key only: `CATEGORIES` is an object literal, so `constructor`,
    // `__proto__` or `toString` would otherwise resolve to an Object.prototype
    // member — no tools, no includes — and `all-constructor` would expand to
    // nothing instead of being refused (security-12#14).
    const def: CategoryDef | undefined = Object.hasOwn(CATEGORIES, cat)
      ? CATEGORIES[cat]
      : undefined;
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
 * Tools a later release moved out of a category, each with the leaf that
 * held it before. Keyed by tool; the value is the old leaf.
 *
 * `[all-state, -vectorDelete]` compiled on 0.7.0, when VectorDelete sat in
 * the `state` leaf that `memory` and `data-stores` include. 0.7.1 moved it
 * to its own `vector` leaf (under `network`), so the same list would now
 * exclude a tool that nothing includes, which is refused as a typo. The
 * author asked for VectorDelete to be left out and it is, so that exclusion
 * is accepted as a no-op instead: a spec that compiled on 0.7.0 still does.
 */
const MOVED_OUT_OF_LEAF: ReadonlyMap<string, string> = new Map([["vectorDelete", "state"]]);

/** Whether `category` (following `includes`) reaches the leaf `leaf`. */
function reachesLeaf(category: string, leaf: string, seen = new Set<string>()): boolean {
  if (category === leaf) return true;
  if (seen.has(category)) return false;
  seen.add(category);
  const def = Object.hasOwn(CATEGORIES, category) ? CATEGORIES[category] : undefined;
  return (def?.includes ?? []).some((child) => reachesLeaf(child, leaf, seen));
}

/**
 * `parsed` without the exclusions {@link MOVED_OUT_OF_LEAF} forgives: a
 * `-<tool>` of a moved tool that no selector includes any more, in a list
 * that includes a category which reached the tool's old leaf. Anything
 * else is left for the inert-exclusion check, unchanged.
 */
function withoutMovedExclusions(parsed: ReadonlyArray<Selector>): Selector[] {
  const includes = parsed.filter((sel) => !sel.exclude);
  const isIncluded = (key: string): boolean =>
    includes.some((sel) => {
      if (sel.kind === "tool") return sel.key === key;
      try {
        return toolsInCategory(sel.name).includes(key);
      } catch {
        return false; // an unknown category is reported by the caller
      }
    });
  return parsed.filter((sel) => {
    if (sel.kind !== "tool" || !sel.exclude) return true;
    const oldLeaf = MOVED_OUT_OF_LEAF.get(sel.key);
    if (oldLeaf === undefined || isIncluded(sel.key)) return true;
    return !includes.some((inc) => inc.kind === "category" && reachesLeaf(inc.name, oldLeaf));
  });
}

/**
 * Expand a `tools:` list into concrete tool keys.
 *
 * Throws `ToolCategoryError` on an unknown category, and on an exclusion
 * that removes nothing — a `-gitPush` that matches no included tool is
 * almost always a typo or a stale copy-paste, and silently ignoring it would
 * leave the author believing a tool is gated when it is not.
 *
 * Each exclusion is judged on its own. A `-<tool>` removes nothing unless
 * that tool is included. A `-all-<category>` removes nothing only when none
 * of its tools is included: it need not be a subset of the includes, so
 * `[all-code, -all-network]` keeps the code tools that do not touch the
 * network (flag-truth-6#10).
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

  const parsed = withoutMovedExclusions(selectors.map(parseSelector));
  const included = new Set<string>();
  const excluded = new Set<string>();
  // Every exclusion as written, with the keys it removes, so an inert one is
  // judged per selector rather than per key.
  const exclusions: Array<{
    readonly kind: Selector["kind"];
    readonly label: string;
    readonly keys: ReadonlyArray<string>;
  }> = [];
  const categoryErrors: string[] = [];

  for (const sel of parsed) {
    const sink = sel.exclude ? excluded : included;
    if (sel.kind === "category") {
      try {
        const keys = toolsInCategory(sel.name);
        for (const key of keys) sink.add(key);
        if (sel.exclude) exclusions.push({ kind: "category", label: `-all-${sel.name}`, keys });
      } catch (err) {
        categoryErrors.push(err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    sink.add(sel.key);
    if (sel.exclude) exclusions.push({ kind: "tool", label: `-${sel.key}`, keys: [sel.key] });
  }

  if (categoryErrors.length > 0) {
    throw new ToolCategoryError(`${path}: ${categoryErrors.join("; ")}`);
  }

  const inert = exclusions.filter((x) => !x.keys.some((key) => included.has(key)));
  if (inert.length > 0) {
    const listed = (xs: ReadonlyArray<{ readonly label: string }>): string =>
      [...new Set(xs.map((x) => `"${x.label}"`))].sort().join(", ");
    const tools = inert.filter((x) => x.kind === "tool");
    const categories = inert.filter((x) => x.kind === "category");
    const parts: string[] = [];
    if (tools.length > 0) {
      const verb =
        new Set(tools.map((x) => x.label)).size === 1
          ? "excludes a tool that"
          : "exclude tools that";
      parts.push(`${listed(tools)} ${verb} nothing includes`);
    }
    if (categories.length > 0) {
      const verb =
        new Set(categories.map((x) => x.label)).size === 1
          ? "excludes a category none of whose tools is included"
          : "exclude categories none of whose tools is included";
      parts.push(`${listed(categories)} ${verb}`);
    }
    const have = [...included].sort().join(", ") || "(nothing)";
    throw new ToolCategoryError(
      `${path}: ${parts.join("; ")}. Remove the exclusion, or add the category that provides it. Currently included: ${have}`,
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

/**
 * Which categories own a given tool key: the leaf that lists it first (a
 * builtin is in exactly one leaf), then every roll-up that reaches it,
 * alphabetically. So `categories[0]` is the narrowest grant — `tools show`
 * and the tool manifest both print this order (docs-claims#14).
 */
export function categoriesForTool(key: string): ReadonlyArray<string> {
  const owns = (name: string): boolean => {
    try {
      return toolsInCategory(name).includes(key);
    } catch {
      return false;
    }
  };
  return [...leafCategories().filter(owns), ...rollUpCategories().filter(owns)];
}
