/**
 * AST-aware code intelligence tool — wraps the `@colbymchenry/codegraph`
 * npm SDK so an agent can ask "what calls `parseSpec`?" or "what's the
 * impact radius of changing `IrV0`?" instead of falling back to grep.
 *
 * The codegraph project (ref/codegraph-main) builds a SQLite-backed
 * knowledge graph from any codebase via tree-sitter AST parsing across
 * 21+ languages. Empirically, agents using it make 94% fewer tool calls
 * and reason 77% faster than grep-based exploration (per the project's
 * benchmarks). That's the order-of-magnitude improvement that justifies
 * shipping a first-class tool for it.
 *
 * Three design constraints:
 *
 *   1. The codegraph SDK is an *optional* dependency. CrewHaus targets
 *      that don't operate on user codebases (`channel`, `voice`, `eval`)
 *      should not be forced to install it. We resolve the SDK via dynamic
 *      `import()` and fail with a clear "install @colbymchenry/codegraph"
 *      message if the call fires without it.
 *   2. The agent surface is intentionally small: four operations
 *      (`search`, `callers`, `callees`, `impact`) cover the 90% case.
 *      Adding more operations is straightforward but each one increases
 *      the model's tool-selection load, so we resist creep.
 *   3. `scope: "internal"` — codegraph reads a local SQLite index; no
 *      network egress. The egress-classifier short-circuits on internal
 *      tools so this is performance-preserving by design.
 *
 * Catalog layer: R3 (tools). Recipe: demos/recipes/54-codegraph-tool.md.
 */
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

export class CodeGraphToolError extends CrewhausError {
  override readonly name = "CodeGraphToolError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

/**
 * Minimal interface this tool needs from the codegraph SDK. Lets us mock
 * in tests and stay decoupled from the SDK's full surface (which evolves
 * faster than CrewHaus releases). The real SDK exports a `CodeGraph`
 * class whose instance method signatures match this shape.
 */
export type CodeGraphClient = {
  searchNodes(query: string, opts?: { limit?: number }): Promise<ReadonlyArray<CodeGraphNode>>;
  getCallers(symbol: string): Promise<ReadonlyArray<CodeGraphNode>>;
  getCallees(symbol: string): Promise<ReadonlyArray<CodeGraphNode>>;
  getImpactRadius(symbol: string): Promise<{ direct: number; transitive: number }>;
};

export type CodeGraphNode = {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly snippet?: string;
};

/**
 * Loads the codegraph SDK lazily so the package can be installed without
 * the peer dependency. Throws CodeGraphToolError with an install hint if
 * the peer isn't present.
 *
 * Injectable for tests via `CodeGraphFactory` below.
 */
let cachedClient: CodeGraphClient | undefined;
let injectedFactory: (() => Promise<CodeGraphClient>) | undefined;

/** Test seam — replace the SDK loader with a mock. */
export function _injectCodeGraphFactory(
  factory: (() => Promise<CodeGraphClient>) | undefined,
): void {
  injectedFactory = factory;
  cachedClient = undefined;
}

async function getClient(): Promise<CodeGraphClient> {
  if (cachedClient !== undefined) return cachedClient;
  if (injectedFactory !== undefined) {
    cachedClient = await injectedFactory();
    return cachedClient;
  }
  try {
    // Dynamic import so the peer is truly optional at install time.
    // @ts-expect-error — optional peer dependency, not type-resolvable at build
    const mod = await import("@colbymchenry/codegraph");
    // The SDK ships a `CodeGraph` class with a default DB path; production
    // callers should pre-instantiate and inject via `_injectCodeGraphFactory`.
    // This auto-construct path is a developer convenience that assumes the
    // process cwd has been indexed via `codegraph init && codegraph index`.
    const CodeGraph = mod.CodeGraph ?? mod.default?.CodeGraph;
    if (typeof CodeGraph !== "function") {
      throw new CodeGraphToolError(
        "loaded @colbymchenry/codegraph but did not find a `CodeGraph` constructor; check the SDK version",
      );
    }
    cachedClient = new CodeGraph() as CodeGraphClient;
    return cachedClient;
  } catch (err) {
    if (err instanceof CodeGraphToolError) throw err;
    throw new CodeGraphToolError(
      "the codegraph tool requires the optional peer dependency `@colbymchenry/codegraph`. " +
        "Install it (`bun add @colbymchenry/codegraph`) and run `codegraph init && codegraph index` in the project root, " +
        "or inject a mock via `_injectCodeGraphFactory` for tests.",
      err,
    );
  }
}

// ─── search ────────────────────────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(1).describe("Symbol name or partial name to search for"),
  limit: z.number().int().positive().max(50).optional().describe("Max hits (default: 10)"),
});
type SearchInput = z.infer<typeof searchSchema>;

export const codegraphSearch: RegisteredTool = buildTool<SearchInput>({
  name: "CodeGraphSearch",
  description:
    "Search the AST-indexed code graph for symbols matching a name. Returns up to 10 (configurable) {name, kind, file, line, snippet} entries. Faster than grep for symbol lookup because the index already resolved which file each definition lives in.",
  inputSchema: searchSchema,
  readOnly: true,
  concurrencySafe: true,
  scope: "internal",
  execute: async (input: SearchInput) => {
    const client = await getClient();
    const hits = await client.searchNodes(input.query, { limit: input.limit ?? 10 });
    if (hits.length === 0) return `No symbols matching "${input.query}".`;
    return hits
      .map(
        (h, i) =>
          `${i + 1}. ${h.kind} ${h.name}\n   ${h.file}:${h.line}${h.snippet ? `\n   ${h.snippet}` : ""}`,
      )
      .join("\n\n");
  },
});

// ─── callers / callees / impact ────────────────────────────────────────────

const symbolSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .describe("Fully-qualified or bare symbol name (the same name shape CodeGraphSearch returns)"),
});
type SymbolInput = z.infer<typeof symbolSchema>;

export const codegraphCallers: RegisteredTool = buildTool<SymbolInput>({
  name: "CodeGraphCallers",
  description:
    "List every function/method that calls the named symbol. Use when refactoring or assessing impact of a signature change. Returns {name, kind, file, line} entries.",
  inputSchema: symbolSchema,
  readOnly: true,
  concurrencySafe: true,
  scope: "internal",
  execute: async (input: SymbolInput) => {
    const client = await getClient();
    const hits = await client.getCallers(input.symbol);
    if (hits.length === 0) return `No callers of "${input.symbol}".`;
    return hits.map((h, i) => `${i + 1}. ${h.kind} ${h.name} — ${h.file}:${h.line}`).join("\n");
  },
});

export const codegraphCallees: RegisteredTool = buildTool<SymbolInput>({
  name: "CodeGraphCallees",
  description:
    "List every function/method called by the named symbol. Use to understand a function's downstream surface before editing.",
  inputSchema: symbolSchema,
  readOnly: true,
  concurrencySafe: true,
  scope: "internal",
  execute: async (input: SymbolInput) => {
    const client = await getClient();
    const hits = await client.getCallees(input.symbol);
    if (hits.length === 0) return `"${input.symbol}" calls no other symbols.`;
    return hits.map((h, i) => `${i + 1}. ${h.kind} ${h.name} — ${h.file}:${h.line}`).join("\n");
  },
});

export const codegraphImpact: RegisteredTool = buildTool<SymbolInput>({
  name: "CodeGraphImpact",
  description:
    "Estimate the blast radius of changing the named symbol: direct callers + transitive callers. Returns two numbers so the agent can decide whether the change is local or sprawling.",
  inputSchema: symbolSchema,
  readOnly: true,
  concurrencySafe: true,
  scope: "internal",
  execute: async (input: SymbolInput) => {
    const client = await getClient();
    const impact = await client.getImpactRadius(input.symbol);
    return `Impact radius for "${input.symbol}":\n  direct callers:     ${impact.direct}\n  transitive callers: ${impact.transitive}`;
  },
});

/** Convenience export — the full set as an array so target emitters can
 *  splat them into the catalog with one expression. */
export const codegraphTools: ReadonlyArray<RegisteredTool> = Object.freeze([
  codegraphSearch,
  codegraphCallers,
  codegraphCallees,
  codegraphImpact,
]);
