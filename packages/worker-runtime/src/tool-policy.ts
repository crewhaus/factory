/**
 * @crewhaus/worker-runtime — the cf-worker edge-safety tool policy.
 *
 * A compiled Cloudflare Worker is a stateless request handler with `fetch`
 * and (optionally) a KV binding, and NOTHING else — no process to spawn, no
 * local filesystem, no sandbox, no attached device driver. A tool whose
 * execution needs any of those cannot run there.
 *
 * This module is the single source of truth for WHICH builtin tools are
 * edge-safe. It keys on the spec-level tool identifiers (the lowercase
 * `BUILTIN_TOOL_MAP` keys a user writes under `tools:`), plus the `mcp__*`
 * namespace for remote MCP tools. The compiler imports it (via the
 * `@crewhaus/worker-runtime/tool-policy` subpath, so the offline gate never
 * drags the loop into the compiler-worker's CF bundle) to turn the old
 * blanket "cf-worker does not support tools" rejection into a precise gate:
 * host tools fail the compile with a clear message; edge-safe tools compile
 * and run.
 *
 * Pure data + pure functions — no imports, no side effects, node-free.
 */

/**
 * Builtin tool identifiers whose execution needs a host the edge does not
 * provide: a shell/subprocess, a code-execution sandbox, the local
 * filesystem, or an on-disk code index. Rejected at compile for cf-worker
 * targets with a category-specific reason.
 */
export const HOST_ONLY_TOOLS: ReadonlyMap<string, string> = new Map([
  // Shell / process — no process table on a Worker.
  ["bash", "runs a host shell process"],
  ["shell", "runs a persistent host shell process"],
  ["killShell", "manages a host shell process"],
  ["bashOutput", "reads a host shell process's output"],
  // Code execution — needs a language sandbox / subprocess.
  ["python", "executes code in a host sandbox"],
  ["javascript", "executes code in a host sandbox"],
  // Filesystem — no local filesystem on a Worker.
  ["read", "reads the local filesystem"],
  ["write", "writes the local filesystem"],
  ["edit", "edits local files"],
  ["glob", "walks the local filesystem"],
  ["grep", "searches the local filesystem"],
  ["readImage", "reads an image from the local filesystem"],
  ["ingestDocument", "reads documents from the local filesystem"],
  // Local code graph — indexes the working tree on disk.
  ["codegraphSearch", "queries an on-disk code index"],
  ["codegraphCallers", "queries an on-disk code index"],
  ["codegraphCallees", "queries an on-disk code index"],
  ["codegraphImpact", "queries an on-disk code index"],
  // Computer-use / browser perception — need an attached host driver.
  ["navigate", "drives a host browser"],
  ["screenshot", "captures a host display"],
  ["screenCapture", "captures a host display"],
  ["visionGround", "grounds against a host display"],
  ["mouseKeyboard", "drives host input devices"],
]);

/**
 * Builtin tool identifiers whose execution needs only `fetch` and,
 * optionally, a KV binding — both available on a stateless Worker. Everything
 * here is deliberately conservative: an entry means "this tool's side effect
 * is an outbound HTTP call or a key/value read/write", which is edge-native.
 *
 * NOTE the durable-memory tools (`Remember`/`Recall`) are edge-safe via a KV
 * binding but are wired from the `memory:` block, not the `tools:` list, so
 * they never reach this gate; they are documented here for completeness.
 */
export const EDGE_SAFE_TOOLS: ReadonlySet<string> = new Set([
  // Network — pure `fetch`.
  "fetch",
  "webFetch",
  "webSearch",
  // Outbound API via `fetch`.
  "sendMessage",
  "imageGenerate",
  // Working memory via a KV binding.
  "todoWrite",
]);

/** The `mcp__<server>__<tool>` namespace: remote MCP over SSE/HTTP is
 *  edge-native (an outbound request to the MCP server). Stdio MCP servers are
 *  a `mcp_servers` transport concern gated elsewhere, not a per-tool matter. */
export const MCP_TOOL_PREFIX = "mcp__";

/** One tool's edge-safety verdict. */
export type EdgeToolVerdict =
  /** Known edge-safe (builtin or MCP) — compile and run. */
  | { readonly safe: true; readonly kind: "known" }
  /** Not a recognised builtin and not MCP — permitted, but the compiler
   *  cannot verify it only uses `fetch`/KV, so it warns. */
  | { readonly safe: true; readonly kind: "unverified"; readonly warning: string }
  /** A known host tool — rejected with a category-specific reason. */
  | { readonly safe: false; readonly reason: string };

/**
 * Classify a single tool identifier for cf-worker emission.
 *
 * - a known host tool → `{ safe: false, reason }` (hard reject);
 * - a known edge-safe builtin or an `mcp__*` tool → `{ safe: true, kind: "known" }`;
 * - anything else (a custom / user-registered tool) → `{ safe: true, kind:
 *   "unverified", warning }` — allowed, because the old blanket rejection is
 *   gone, but flagged so a host-reaching custom tool is not shipped silently.
 */
export function classifyEdgeTool(name: string): EdgeToolVerdict {
  const hostReason = HOST_ONLY_TOOLS.get(name);
  if (hostReason !== undefined) {
    return {
      safe: false,
      reason: `tool "${name}" ${hostReason} — not available on a Cloudflare Worker`,
    };
  }
  if (name.startsWith(MCP_TOOL_PREFIX) || EDGE_SAFE_TOOLS.has(name)) {
    return { safe: true, kind: "known" };
  }
  return {
    safe: true,
    kind: "unverified",
    warning: `tool "${name}" is not a recognised builtin — cf-worker emission cannot verify it only uses fetch/KV; ensure it performs no host (process/filesystem/device) I/O`,
  };
}

/** Convenience predicate: is this tool name safe to emit for a cf-worker target? */
export function isEdgeSafeTool(name: string): boolean {
  return classifyEdgeTool(name).safe;
}

/** The partition a compile gate needs over a whole tool list, computed once. */
export type EdgeToolPartition = {
  /** Names that compile cleanly (known edge-safe builtins + MCP). */
  readonly allowed: readonly string[];
  /** Custom names permitted with a caution (unverifiable edge-safety). */
  readonly warned: ReadonlyArray<{ readonly name: string; readonly warning: string }>;
  /** Host tool names that must fail the compile, each with its reason. */
  readonly rejected: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
};

/**
 * Partition a target's tool names into allowed / warned / rejected. Order is
 * preserved and duplicates collapse (first occurrence wins) so a caller can
 * render deterministic diagnostics.
 */
export function partitionEdgeTools(names: Iterable<string>): EdgeToolPartition {
  const allowed: string[] = [];
  const warned: Array<{ name: string; warning: string }> = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const verdict = classifyEdgeTool(name);
    if (!verdict.safe) {
      rejected.push({ name, reason: verdict.reason });
    } else if (verdict.kind === "unverified") {
      warned.push({ name, warning: verdict.warning });
    } else {
      allowed.push(name);
    }
  }
  return { allowed, warned, rejected };
}
