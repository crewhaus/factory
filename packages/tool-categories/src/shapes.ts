/**
 * Which builtin tools each shape can run, and the one resolver every target
 * emitter calls to turn a `tools:` list into imports and registrations.
 *
 * Every shape used to carry its own copy of the builtin map and its own copy
 * of the resolver. The copies were eight to twenty-three entries long while
 * the cli shape's was five hundred and fifty, so a tool or a category that
 * compiled on the cli shape failed everywhere else with "unknown tool". Now
 * there is one table (`./builtins.ts`), one per-shape profile (below), and
 * one resolver, and a shape that cannot run a tool says so by name.
 *
 * Pure functions over data. Nothing here imports a tool package.
 */
import { CrewhausError } from "@crewhaus/errors";
import { BUILTIN_TOOLS, type BuiltinToolEntry } from "./builtins";

/**
 * Every place a spec's builtin tools can end up: the fourteen spec targets,
 * plus the Cloudflare Worker flavour `crewhaus compile --emit-as cf-worker`
 * emits for the cli, workflow and graph targets. The compiler checks this
 * union against its own list of targets, so a new target cannot be added
 * without a profile.
 */
export type ToolShape =
  | "cli"
  | "workflow"
  | "channel"
  | "graph"
  | "managed"
  | "pipeline"
  | "crew"
  | "research"
  | "batch"
  | "voice"
  | "browser"
  | "eval"
  | "onchain"
  | "onchain-game"
  | "cf-worker";

export type ShapeToolProfile = {
  /** Used in messages: "the graph shape", "the cf-worker target". */
  readonly label: string;
  /**
   * Where the shape's tools run.
   *  - `host`: a Bun process with a filesystem, a process table and the
   *    network — every builtin can run there.
   *  - `edge`: a Cloudflare Worker — `fetch` and KV only.
   *  - `none`: the shape registers no tool catalog; its `tools:` list is
   *    accepted and ignored, and the compiler says so.
   */
  readonly runtime: "host" | "edge" | "none";
  /**
   * The shape's emitter wires `sandboxAvailable` into its chat loop, so a
   * tool that runs model-written code can pass the permission engine's
   * sandbox floor. A shape without it refuses those tools at compile time
   * rather than emitting a tool that is denied on every call.
   */
  readonly sandbox: boolean;
  /** Tools the shape supplies itself; naming one in `tools:` is refused with this reason. */
  readonly provides?: Readonly<Record<string, string>>;
};

const host = (label: string): ShapeToolProfile => ({ label, runtime: "host", sandbox: true });
const none = (label: string): ShapeToolProfile => ({ label, runtime: "none", sandbox: false });

export const SHAPE_TOOL_PROFILES: Readonly<Record<ToolShape, ShapeToolProfile>> = Object.freeze({
  cli: host("the cli shape"),
  workflow: host("the workflow shape"),
  channel: host("the channel shape"),
  graph: host("the graph shape"),
  managed: host("the managed shape"),
  crew: {
    ...host("the crew shape"),
    provides: {
      sendMessage:
        "every crew role already gets SendMessage and Handoff from the orchestrator, for talking to the other roles",
    },
  },
  research: host("the research shape"),
  batch: host("the batch shape"),
  browser: host("the browser shape"),
  eval: host("the eval shape"),
  pipeline: none("the pipeline shape"),
  voice: none("the voice shape"),
  onchain: none("the onchain shape"),
  "onchain-game": none("the onchain-game shape"),
  "cf-worker": { label: "the cf-worker target", runtime: "edge", sandbox: false },
});

/**
 * The permission engine's sandbox floor reads this at runtime: unset means a
 * docker backend is available, and `CREWHAUS_SANDBOX=noop` denies every
 * code-execution call. The same expression `crewhaus run` evaluates, so a
 * compiled bundle and the interpreter agree.
 */
export const SANDBOX_AVAILABLE_EXPR =
  '((process.env.CREWHAUS_SANDBOX ?? "docker").toLowerCase() !== "noop")';

/** A builtin-tool refusal: an unknown name, or a builtin this shape cannot run. */
export class BuiltinToolError extends CrewhausError {
  override readonly name = "BuiltinToolError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

/** Can `shape` compile `key`? The same rules `refusal` explains in words. */
function carriedBy(key: string, entry: BuiltinToolEntry, shape: ToolShape): boolean {
  return refusal(key, entry, shape) === undefined;
}

/**
 * The builtin keys a shape can compile, sorted. For a shape without a tool
 * catalog this is empty. `lint` uses it for nearest-match candidates and
 * `tools suggest` to avoid suggesting a tool the spec's shape rejects.
 */
export function builtinToolsFor(shape: ToolShape): ReadonlyArray<string> {
  if (SHAPE_TOOL_PROFILES[shape].runtime === "none") return [];
  return Object.entries(BUILTIN_TOOLS)
    .filter(([key, entry]) => carriedBy(key, entry, shape))
    .map(([key]) => key)
    .sort();
}

/** The outcome of checking one `tools:` name against one shape. */
export type ToolVerdict =
  /** Compiles and runs. */
  | { readonly kind: "ok"; readonly key: string; readonly entry: BuiltinToolEntry }
  /** Compiles, but every call fails at runtime — the compiler warns. */
  | {
      readonly kind: "inert";
      readonly key: string;
      readonly entry: BuiltinToolEntry;
      readonly message: string;
    }
  /** A builtin this shape cannot run. */
  | {
      readonly kind: "refused";
      readonly key: string;
      readonly entry: BuiltinToolEntry;
      readonly message: string;
    }
  /** Not a builtin at all. */
  | { readonly kind: "unknown"; readonly key: string; readonly message: string };

function list(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The keys the edge worker wires, for the cf-worker refusal text. */
function edgeKeys(): ReadonlyArray<string> {
  return Object.entries(BUILTIN_TOOLS)
    .filter(([, e]) => e.edge === true && e.withheld === undefined)
    .map(([k]) => k);
}

function refusal(key: string, entry: BuiltinToolEntry, shape: ToolShape): string | undefined {
  const profile = SHAPE_TOOL_PROFILES[shape];
  const head = `tool "${key}" is a builtin, but ${profile.label} cannot run it`;
  if (entry.withheld !== undefined) {
    return `tool "${key}" is a builtin, but no shape can run it: ${entry.withheld}. Remove it from tools.`;
  }
  if (profile.runtime === "edge") {
    if (entry.edge === true) return undefined;
    const why =
      entry.sandbox === true
        ? "it runs model-written code in a sandbox, and a Worker has none"
        : entry.io === "process"
          ? "it starts a host process, and a Worker has none"
          : `the edge worker does not wire it — it wires only ${list(edgeKeys())}`;
    return `${head}: ${why}. Remove it from tools, or compile without --emit-as cf-worker to get a bundle that runs it.`;
  }
  const provided = profile.provides?.[key];
  if (provided !== undefined) return `${head}: ${provided}. Remove it from tools.`;
  if (entry.shapes !== undefined && !entry.shapes.includes(shape)) {
    const one = entry.shapes.length === 1;
    const where = `the ${list(entry.shapes)} shape${one ? " carries" : "s carry"} it`;
    return `${head}: only ${where}. Use ${one ? "that shape" : "one of those shapes"}, or remove it from tools.`;
  }
  if (entry.sandbox === true && !profile.sandbox) {
    return `${head}: it runs model-written code, and this shape does not wire a sandbox. Use the cli, workflow or graph shape for code execution, or remove it from tools.`;
  }
  return undefined;
}

/** Case-insensitive edit distance, for the "did you mean" hint. */
function distance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const curr = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[t.length] ?? 0;
}

/**
 * The message for a name that is not a builtin. Kept short on purpose: it
 * names the problem and one next step, instead of listing every builtin.
 */
export function unknownToolMessage(key: string, shape?: ToolShape): string {
  const head = `unknown tool "${key}"`;
  if (key.startsWith("mcp__")) {
    return `${head} — MCP tools come from a server, not from tools:. Declare the server under mcp_servers and its tools register themselves.`;
  }
  const keys = Object.keys(BUILTIN_TOOLS);
  const sameLetters = keys.find((k) => k.toLowerCase() === key.toLowerCase());
  if (sameLetters !== undefined) {
    return `${head} — write "${sameLetters}". A tools: list takes the spec key; "${BUILTIN_TOOLS[sameLetters]?.name}" is the name session logs and permission rules use.`;
  }
  const pool = shape !== undefined ? builtinToolsFor(shape) : keys;
  const scored = (pool.length > 0 ? pool : keys).map((k) => ({ k, d: distance(key, k) }));
  const best = Math.min(...scored.map((x) => x.d));
  const near = best <= 3 ? scored.filter((x) => x.d === best).map((x) => `"${x.k}"`) : [];
  const hint =
    near.length > 0
      ? ` Did you mean ${near.slice(0, 3).join(" or ")}?`
      : " No builtin has a name close to it.";
  return `${head} —${hint} Run \`crewhaus tools search <word>\` to find a builtin by what it does.`;
}

/** Check one `tools:` name against one shape. Pure. */
export function checkBuiltinTool(key: string, shape: ToolShape): ToolVerdict {
  const entry = Object.hasOwn(BUILTIN_TOOLS, key) ? BUILTIN_TOOLS[key] : undefined;
  if (entry === undefined) return { kind: "unknown", key, message: unknownToolMessage(key, shape) };
  const refused = refusal(key, entry, shape);
  if (refused !== undefined) return { kind: "refused", key, entry, message: refused };
  if (entry.inert !== undefined) {
    return {
      kind: "inert",
      key,
      entry,
      message: `tool "${key}" compiles on ${SHAPE_TOOL_PROFILES[shape].label}, but ${entry.inert}. Remove it from tools until a release binds it.`,
    };
  }
  return { kind: "ok", key, entry };
}

/** One list of tools a bundle registers together, with the config that list carries. */
export type ToolSite = {
  readonly tools: ReadonlyArray<string>;
  readonly toolConfigs?: Readonly<Record<string, unknown>>;
};

/** One `tool_config` registration: call `initSymbol(config)` from `package` at boot. */
export type ToolConfigInit = {
  readonly key: string;
  readonly package: string;
  readonly initSymbol: string;
  readonly config: unknown;
};

/** The shared registrar the three code-execution tools use. */
const CODE_EXECUTION_INIT = "registerCodeExecutionConfig";

/**
 * Which `tool_config` blob reaches which registration function — the one
 * rule every emitter renders and every runtime (`crewhaus run`, the eval
 * runner) calls.
 *
 * A tool's own `tool_config.<key>` wins. The `codeExecution` /
 * `code_execution` aliases apply only to the code-execution registrar that
 * python, javascript and shell share. Several tools sharing a registrar
 * register once, with the first configured tool's blob.
 */
export function planToolConfigInits(sites: ReadonlyArray<ToolSite>): ReadonlyArray<ToolConfigInit> {
  const plan: ToolConfigInit[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const configs = site.toolConfigs ?? {};
    for (const key of site.tools) {
      const entry = Object.hasOwn(BUILTIN_TOOLS, key) ? BUILTIN_TOOLS[key] : undefined;
      if (entry?.initSymbol === undefined || seen.has(entry.initSymbol)) continue;
      const config =
        configs[key] ??
        (entry.initSymbol === CODE_EXECUTION_INIT
          ? (configs["codeExecution"] ?? configs["code_execution"])
          : undefined);
      if (config === undefined) continue;
      seen.add(entry.initSymbol);
      plan.push({ key, package: entry.package, initSymbol: entry.initSymbol, config });
    }
  }
  return plan;
}

export type ResolvedTools = {
  /** `import { a, b } from "@crewhaus/tool-x";`, one line per package, sorted. */
  readonly imports: ReadonlyArray<string>;
  /** `registerXConfig({...});` lines, to run before any tool is registered. */
  readonly inits: ReadonlyArray<string>;
  /** Per site, the identifiers to register, in the site's order. */
  readonly sites: ReadonlyArray<ReadonlyArray<string>>;
  /** Every package imported, sorted. */
  readonly packages: ReadonlyArray<string>;
  /** Some registered tool runs model-written code: wire `sandboxAvailable`. */
  readonly sandbox: boolean;
  /** Edge only: names left out of the worker (builtins it does not run, custom and MCP names). */
  readonly unwired: ReadonlyArray<string>;
};

/**
 * Resolve a shape's tool lists into the code a bundle needs.
 *
 * On a host shape every name must be a builtin that shape can run; anything
 * else throws `BuiltinToolError` with the same message the compiler prints.
 * On the edge nothing throws: a name the worker cannot wire is returned in
 * `unwired` (the compiler has already warned about it, or refused it under
 * `--strict`), and each wired tool is imported as `__t_<key>` so it cannot
 * collide with a Worker global such as `fetch`.
 */
export function resolveBuiltinTools(
  shape: ToolShape,
  sites: ReadonlyArray<ToolSite>,
): ResolvedTools {
  const edge = SHAPE_TOOL_PROFILES[shape].runtime === "edge";
  const groups = new Map<string, { exports: Set<string>; inits: Set<string> }>();
  const group = (pkg: string) => {
    const existing = groups.get(pkg);
    if (existing !== undefined) return existing;
    const created = { exports: new Set<string>(), inits: new Set<string>() };
    groups.set(pkg, created);
    return created;
  };
  const wiredSites: string[][] = [];
  const unwired: string[] = [];
  const wiredForInit: ToolSite[] = [];
  let sandbox = false;

  for (const site of sites) {
    const ids: string[] = [];
    const wiredKeys: string[] = [];
    const seen = new Set<string>();
    for (const key of site.tools) {
      let entry: BuiltinToolEntry;
      if (edge) {
        // The edge collapses duplicates and leaves out what it cannot wire.
        if (seen.has(key)) continue;
        seen.add(key);
        const verdict = checkBuiltinTool(key, shape);
        if (verdict.kind !== "ok" && verdict.kind !== "inert") {
          if (!unwired.includes(key)) unwired.push(key);
          continue;
        }
        entry = verdict.entry;
        group(entry.package).exports.add(`${entry.export} as __t_${key}`);
        ids.push(`__t_${key}`);
      } else {
        const verdict = checkBuiltinTool(key, shape);
        if (verdict.kind === "unknown" || verdict.kind === "refused") {
          throw new BuiltinToolError(verdict.message);
        }
        entry = verdict.entry;
        group(entry.package).exports.add(entry.export);
        ids.push(entry.export);
      }
      wiredKeys.push(key);
      if (entry.sandbox === true) sandbox = true;
    }
    wiredSites.push(ids);
    wiredForInit.push({
      tools: wiredKeys,
      ...(site.toolConfigs !== undefined ? { toolConfigs: site.toolConfigs } : {}),
    });
  }

  const inits: string[] = [];
  for (const init of planToolConfigInits(wiredForInit)) {
    group(init.package).inits.add(init.initSymbol);
    inits.push(`${init.initSymbol}(${JSON.stringify(init.config)});`);
  }

  const packages = [...groups.keys()].sort();
  const imports = packages.map((pkg) => {
    const g = groups.get(pkg) ?? { exports: new Set<string>(), inits: new Set<string>() };
    // The edge keeps its aliased tools ahead of the registrars; a host bundle
    // sorts every symbol together. Both are the byte layout 0.7.0 emitted.
    const symbols = edge
      ? [...[...g.exports].sort(), ...[...g.inits].sort()]
      : [...new Set([...g.exports, ...g.inits])].sort();
    return `import { ${symbols.join(", ")} } from "${pkg}";`;
  });
  return { imports, inits, sites: wiredSites, packages, sandbox, unwired };
}

/**
 * The registered name for a spec key (`read` → `Read`), or undefined when the
 * key is not a builtin. A sub-agent's child catalog is filtered by registered
 * name, so the compiler maps a sub-agent's `tools:` through this.
 */
export function registeredToolName(key: string): string | undefined {
  return Object.hasOwn(BUILTIN_TOOLS, key) ? BUILTIN_TOOLS[key]?.name : undefined;
}

/**
 * The spec key for a registered name (`Read` → `read`), matched without
 * regard to case. Every builtin's name differs from its key only in case,
 * and no two builtins collide that way — the package test holds both facts.
 */
export function builtinKeyForName(name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(BUILTIN_TOOLS).find((k) => k.toLowerCase() === lower);
}
