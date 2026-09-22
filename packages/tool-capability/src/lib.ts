/**
 * The pure half of `ToolRegistry` — everything that can be decided from a
 * manifest, a set of live tool names and an input object, with no runtime
 * attached. Kept separate so the answer can be tested against a hand-built
 * catalog instead of a booted harness.
 */
import type { RegistryEntry } from "@crewhaus/tool-registry-manifest";

/** One tool as `ToolRegistry` reports it in a list. */
export type RegistryRow = {
  readonly key: string;
  readonly name: string;
  /** First sentence in a list; the whole description for a single-`key` ask. */
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
  readonly requireJustification: boolean;
  readonly categories: ReadonlyArray<string>;
  readonly package: string;
  readonly keywords?: ReadonlyArray<string>;
  /** Present only when the live catalog was readable. */
  readonly granted?: boolean;
  /** Present only on a row this harness is not running. */
  readonly howToRequest?: string;
};

export type RegistryQuery = {
  readonly query?: string;
  readonly category?: string;
  readonly key?: string;
  readonly only?: "granted" | "unlisted" | "all";
  readonly limit?: number;
};

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/**
 * The asymmetry, stated in every answer.
 *
 * `registerMcpServer` registers whatever a server offers when it connects,
 * and `watchMcpServer` re-diffs that list mid-run; a spec names the SERVER,
 * never its tools. So "which MCP tools exist that I am not running" has no
 * offline answer, and an answer that quietly covered builtins only would read
 * as complete. Saying it costs one line and is the difference between a short
 * list and a wrong one.
 */
export const MCP_NOTE =
  "Builtin tools only, on BOTH sides. A spec declares an MCP server, not the tools it offers, and a server's tools are only known once it connects. So MCP tools you DO have are missing from `granted` — call ListTools for the whole live toolset — and which MCP tools exist beyond this harness has no offline answer at all.";

/** What an agent can do about a tool it is not running. */
export function howToRequest(key: string): string {
  return `Not bound here. Ask the person running this harness to add "${key}" to tools: in crewhaus.yaml.`;
}

/** The category names the manifest actually uses — leaves and roll-ups alike. */
export function knownCategories(
  registry: Readonly<Record<string, RegistryEntry>>,
): ReadonlyArray<string> {
  const out = new Set<string>();
  for (const entry of Object.values(registry)) for (const c of entry.categories) out.add(c);
  return [...out].sort();
}

/** `all-fs` and `fs` mean the same category. */
export function normalizeCategory(raw: string): string {
  return raw.startsWith("all-") ? raw.slice("all-".length) : raw;
}

export function unknownCategoryMessage(
  raw: string,
  registry: Readonly<Record<string, RegistryEntry>>,
): string {
  const name = normalizeCategory(raw);
  const known = knownCategories(registry);
  const near = known.filter((k) => k.includes(name) || name.includes(k)).slice(0, 3);
  const hint = near.length > 0 ? ` Did you mean ${near.map((k) => `all-${k}`).join(", ")}?` : "";
  // The note rides on this too. A reader who asked for a category that does
  // not exist is one step from concluding the category has no tools, and the
  // categories here cover builtins only.
  return `unknown tool category "${raw}".${hint} There are ${known.length} categories; ask with no category to see them on the rows. ${MCP_NOTE}`;
}

/** The first sentence, which is what a list needs. `ListTools` does the same. */
export function firstSentence(description: string): string {
  return description.split(/(?<=[.!?])\s/)[0] ?? description;
}

/** Lexical match over the fields a person would search by. */
export function matchesQuery(entry: RegistryEntry, query: string): boolean {
  const needle = query.toLowerCase();
  if (needle.length === 0) return true;
  if (entry.key.toLowerCase().includes(needle)) return true;
  if (entry.name.toLowerCase().includes(needle)) return true;
  if (entry.description.toLowerCase().includes(needle)) return true;
  if (entry.categories.some((c) => c.toLowerCase().includes(needle))) return true;
  return entry.keywords.some((k) => k.toLowerCase().includes(needle));
}

/**
 * Read the live tool catalog structurally off the execution context.
 *
 * Deliberately structural rather than typed: `RuntimeBridge` lives in
 * `@crewhaus/agent-context-isolation`, and depending on it here would pull a
 * sub-agent fabric into every bundle that wants to list tools. The tree
 * already re-declares shapes this way twice (`tool-approvals` re-declares
 * `PendingApproval`, `tools-cli` re-declares `ToolLike`), and `tool-task`
 * reads the same bridge field.
 *
 * Returns `undefined` — not an empty set — when the catalog is not reachable.
 * The two are completely different answers: an empty set would say "you are
 * running nothing", and the caller must be able to say "I could not tell"
 * instead of reporting every builtin as missing.
 */
export function liveToolNames(bridge: unknown): ReadonlySet<string> | undefined {
  if (typeof bridge !== "object" || bridge === null) return undefined;
  const tools = (bridge as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return undefined;
  const names = new Set<string>();
  for (const t of tools) {
    if (typeof t === "object" && t !== null) {
      const name = (t as { name?: unknown }).name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

export type RegistryAnswer = {
  readonly version: string;
  readonly liveCatalog: "read" | "unavailable";
  readonly counts: {
    readonly total: number;
    readonly matched: number;
    readonly shown: number;
    readonly granted?: number;
    readonly unlisted?: number;
    /**
     * Bound tools this manifest cannot describe — MCP tools and any tool a
     * host registered programmatically. Reported as a number rather than
     * silently dropped, so `granted` is never mistaken for the whole toolset.
     */
    readonly otherBound?: number;
  };
  readonly granted?: ReadonlyArray<RegistryRow>;
  readonly unlisted?: ReadonlyArray<RegistryRow>;
  /** Used instead of the split when the live catalog could not be read. */
  readonly tools?: ReadonlyArray<RegistryRow>;
  readonly truncated: boolean;
  readonly note: string;
};

function toRow(
  entry: RegistryEntry,
  opts: { readonly full: boolean; readonly granted?: boolean },
): RegistryRow {
  return {
    key: entry.key,
    name: entry.name,
    description: opts.full ? entry.description : firstSentence(entry.description),
    readOnly: entry.readOnly,
    destructive: entry.destructive,
    scope: entry.scope,
    ...(entry.ioCapability !== undefined ? { ioCapability: entry.ioCapability } : {}),
    requiresSandbox: entry.requiresSandbox,
    requireJustification: entry.requireJustification,
    categories: entry.categories,
    package: entry.package,
    ...(opts.full ? { keywords: entry.keywords } : {}),
    ...(opts.granted !== undefined ? { granted: opts.granted } : {}),
    ...(opts.granted === false ? { howToRequest: howToRequest(entry.key) } : {}),
  };
}

/**
 * Build the answer.
 *
 * `live` is the set of tool names bound to this runtime right now, or
 * `undefined` when that could not be read. Which builtins a harness HAS is
 * read from that live catalog rather than from the spec, so a tool an MCP
 * peer registered an hour after boot counts as bound — the same reason
 * `ListTools` reads the catalog and not the spec.
 */
export function buildRegistryAnswer(args: {
  readonly registry: Readonly<Record<string, RegistryEntry>>;
  readonly version: string;
  readonly live: ReadonlySet<string> | undefined;
  readonly input: RegistryQuery;
}): RegistryAnswer | { readonly error: string } {
  const { registry, version, live, input } = args;
  const only = input.only ?? "all";
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  if (live === undefined && only !== "all") {
    return {
      error: `ToolRegistry could not read this runtime's live tool catalog, so it cannot answer only: "${only}". Ask again without \`only\` to get the tools that exist, or call ListTools for what is bound right now. ${MCP_NOTE}`,
    };
  }

  const all = Object.values(registry);
  // Bound names this manifest has no row for: MCP tools, and anything a host
  // registered programmatically. Counting them is what keeps `granted` from
  // reading as "everything I have".
  const manifestNames = new Set(all.map((e) => e.name));
  const otherBound =
    live === undefined ? undefined : [...live].filter((n) => !manifestNames.has(n)).length;

  // A single key is a detail lookup, not a search: it answers with the whole
  // description rather than the first sentence, and ignores the other filters.
  if (input.key !== undefined) {
    // `Object.hasOwn`, not a bare index: `TOOL_REGISTRY` is an object literal,
    // so a bare lookup reaches Object.prototype and `key: "constructor"` comes
    // back as a function rather than as `undefined`. The row built from it
    // would name a tool called "Object" and tell the reader to ask an operator
    // to add "constructor" to `tools:` — a confabulated tool from the one tool
    // whose whole job is saying truthfully what exists.
    const entry = Object.hasOwn(registry, input.key) ? registry[input.key] : undefined;
    if (entry === undefined) {
      const near = Object.keys(registry)
        .filter((k) => k.toLowerCase().includes(input.key?.toLowerCase() ?? ""))
        .slice(0, 5);
      const hint = near.length > 0 ? ` Close matches: ${near.join(", ")}.` : "";
      return {
        error: `no builtin tool has the key "${input.key}".${hint} ${MCP_NOTE}`,
      };
    }
    const isGranted = live === undefined ? undefined : live.has(entry.name);
    const row = toRow(entry, {
      full: true,
      ...(isGranted !== undefined ? { granted: isGranted } : {}),
    });
    const counts = { total: all.length, matched: 1, shown: 1 } as const;
    if (live === undefined) {
      return {
        version,
        liveCatalog: "unavailable",
        counts,
        tools: [row],
        truncated: false,
        note: `${unavailableNote()} ${MCP_NOTE}`,
      };
    }
    return {
      version,
      liveCatalog: "read",
      counts: {
        ...counts,
        granted: isGranted === true ? 1 : 0,
        unlisted: isGranted === true ? 0 : 1,
        ...(otherBound !== undefined ? { otherBound } : {}),
      },
      granted: isGranted === true ? [row] : [],
      unlisted: isGranted === true ? [] : [row],
      truncated: false,
      note: MCP_NOTE,
    };
  }

  let matched = all;
  if (input.category !== undefined) {
    const name = normalizeCategory(input.category);
    if (!knownCategories(registry).includes(name)) {
      return { error: unknownCategoryMessage(input.category, registry) };
    }
    matched = matched.filter((e) => e.categories.includes(name));
  }
  if (input.query !== undefined) {
    matched = matched.filter((e) => matchesQuery(e, input.query ?? ""));
  }
  matched = [...matched].sort((a, b) => a.key.localeCompare(b.key));

  if (live === undefined) {
    const shown = matched.slice(0, limit);
    return {
      version,
      liveCatalog: "unavailable",
      counts: { total: all.length, matched: matched.length, shown: shown.length },
      tools: shown.map((e) => toRow(e, { full: false })),
      truncated: shown.length < matched.length,
      note: `${unavailableNote()} ${MCP_NOTE}`,
    };
  }

  const grantedEntries = matched.filter((e) => live.has(e.name));
  const unlistedEntries = matched.filter((e) => !live.has(e.name));
  const wantGranted = only === "all" || only === "granted";
  const wantUnlisted = only === "all" || only === "unlisted";

  // How the page is spent.
  //
  // `only` gets the whole budget, because asking for one half and being given
  // half of it is a page nobody wanted. `all` splits it, and the reason is the
  // whole point of this tool: filling the page with what a harness already has
  // would push out what it does not, which is the half that cannot be got from
  // `ListTools`. Each side still takes whatever the other does not use, so a
  // small answer is never padded with blank space.
  let grantedCap = 0;
  let unlistedCap = 0;
  if (only === "granted") grantedCap = limit;
  else if (only === "unlisted") unlistedCap = limit;
  else {
    grantedCap = Math.min(grantedEntries.length, Math.ceil(limit / 2));
    unlistedCap = Math.min(unlistedEntries.length, limit - grantedCap);
    grantedCap = Math.min(grantedEntries.length, limit - unlistedCap);
  }
  const grantedShown = wantGranted ? grantedEntries.slice(0, grantedCap) : [];
  const unlistedShown = wantUnlisted ? unlistedEntries.slice(0, unlistedCap) : [];
  const shown = grantedShown.length + unlistedShown.length;
  const askedFor =
    (wantGranted ? grantedEntries.length : 0) + (wantUnlisted ? unlistedEntries.length : 0);

  return {
    version,
    liveCatalog: "read",
    counts: {
      total: all.length,
      matched: matched.length,
      shown,
      granted: grantedEntries.length,
      unlisted: unlistedEntries.length,
      ...(otherBound !== undefined ? { otherBound } : {}),
    },
    granted: grantedShown.map((e) => toRow(e, { full: false, granted: true })),
    unlisted: unlistedShown.map((e) => toRow(e, { full: false, granted: false })),
    truncated: shown < askedFor,
    note: MCP_NOTE,
  };
}

function unavailableNote(): string {
  return "This runtime's live tool catalog was not reachable from this call, so no row says whether you are running it — these are the tools that exist. Call ListTools for what is bound right now.";
}
