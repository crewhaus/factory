import type {
  RegisteredTool,
  ToolDefinition,
  ToolExecuteContext,
  ToolExecuteResult,
} from "@crewhaus/tool-catalog";
import type { ZodType } from "zod";

/**
 * FR-002 — Pillar 3 sink-side: the built-in tool *names* that are
 * outward-reaching by definition (they cross a network or process boundary).
 * Source of truth for the scope-inference default below AND for the
 * `crewhaus compile --strict` / `crewhaus doctor --philosophy-alignment`
 * audit (which imports this set so the two never drift). These mirror the
 * external-sink table in AGENTS.md (Pillar 3) and each tool's explicit
 * `scope: "external"` annotation — keep them in sync.
 *
 * MCP tools are registered with a dynamic namespaced name
 * (`mcp__<server>__<tool>`, see tool-mcp `namespacedToolName`) so they can't
 * be enumerated in a literal set; `isOutwardName` covers them by prefix.
 */
export const OUTWARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Fetch",
  "WebFetch",
  "WebSearch",
  "SendMessage",
  "EvmSendTransaction",
  "ImageGenerate",
]);

/**
 * FR-002 — true for a tool whose effect is definitionally outward-reaching,
 * keyed on its name. Used to (a) invert the safe default in `buildTool` for
 * these names and (b) drive the compile-time scope audit. The `mcp__` prefix
 * rule catches every dynamically-named MCP tool.
 */
export function isOutwardName(name: string): boolean {
  return OUTWARD_TOOL_NAMES.has(name) || name.startsWith("mcp__");
}

/**
 * FR-002 — a single per-tool scope finding produced by `auditToolScopes`.
 * `toolName` is the offending tool's `name`; `reason` is a human-readable
 * explanation suitable for a `[strict]` diagnostic or a `doctor` line.
 */
export type ScopeFinding = { toolName: string; reason: string };

/**
 * FR-002 — Pillar 3 sink-side build-time gate, as a PURE, side-effect-free
 * function over already-resolved `RegisteredTool`s. This is the single shared
 * audit the contributor docs reference (`crewhaus compile --strict` and
 * `crewhaus doctor --philosophy-alignment`); keeping it here in tool-builder —
 * next to `isOutwardName` and `buildTool`, the two facts it keys on — means
 * every consumer audits identically rather than re-deriving the rule.
 *
 * A finding fires when a tool is I/O-capable yet its resolved `scope` is not
 * `"external"`. A tool counts as I/O-capable when EITHER:
 *
 *   (a) it declares `ioCapability` ("network" | "process") on its definition —
 *       the capability-driven path that catches an *arbitrary-named* custom
 *       `buildTool` tool that opens a socket or spawns a process; or
 *   (b) its name is definitionally outward-reaching (per `isOutwardName`:
 *       Fetch/WebFetch/WebSearch/SendMessage/EvmSendTransaction/ImageGenerate
 *       or any `mcp__*`) — the name backstop for a future built-in that forgets
 *       BOTH annotations.
 *
 * The irreducible residual a static check cannot reach is a tool that declares
 * NEITHER its capability NOR an outward name; that is the documented limit of
 * an annotation-based gate short of full dataflow analysis.
 */
export function auditToolScopes(tools: ReadonlyArray<RegisteredTool>): ScopeFinding[] {
  const findings: ScopeFinding[] = [];
  for (const tool of tools) {
    if (tool.scope === "external") continue;
    if (tool.ioCapability !== undefined) {
      findings.push({
        toolName: tool.name,
        reason: `declares ioCapability "${tool.ioCapability}" (crosses a ${tool.ioCapability} boundary) but scope is "${tool.scope}" (expected "external")`,
      });
    } else if (isOutwardName(tool.name)) {
      findings.push({
        toolName: tool.name,
        reason: `is outward-reaching by definition but scope is "${tool.scope}" (expected "external")`,
      });
    }
  }
  return findings;
}

/**
 * Converts a ToolDefinition into a RegisteredTool by applying fail-closed
 * safety defaults. Any flag not explicitly set in the definition defaults to
 * false (the least-privileged stance).
 */
export function buildTool<TInput>(def: ToolDefinition<TInput>): RegisteredTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema as ZodType<unknown>,
    execute: def.execute as (
      input: unknown,
      ctx?: ToolExecuteContext,
    ) => Promise<ToolExecuteResult>,
    concurrencySafe: def.concurrencySafe ?? false,
    readOnly: def.readOnly ?? false,
    destructive: def.destructive ?? false,
    // Section 18: fail-closed for the sandbox flag and default-on for
    // classification. Tools that legitimately bypass classification must
    // opt out explicitly.
    requiresSandbox: def.requiresSandbox ?? false,
    classifyOutput: def.classifyOutput ?? true,
    // Pillar 3 sink-side fabric: fail-closed at "internal" so tools that
    // actually cross a network/process boundary must opt in to "external"
    // explicitly. egress-classifier reads this flag to decide whether to
    // route the call's payload through its substring scan.
    //
    // FR-002 defense-in-depth: for tools whose NAME is definitionally
    // outward-reaching (Fetch/WebFetch/WebSearch/SendMessage/
    // EvmSendTransaction/ImageGenerate + any `mcp__*`), the *default* is
    // inverted to "external" so a future built-in that forgets the explicit
    // annotation still lowers external. An explicit `def.scope` always wins
    // (override still works), so the six built-ins that already set
    // `scope: "external"` are unchanged — no runtime behavior shifts. Every
    // other (pure-compute) tool still fails closed to "internal".
    scope: def.scope ?? (isOutwardName(def.name) ? "external" : "internal"),
    // Pillar 3 intent gate: fail-closed at false. Destructive or external
    // tools should opt in explicitly (see tool-fetch, tool-evm-tx,
    // tool-message-channel, federation-router).
    requireJustification: def.requireJustification ?? false,
    ...(def.jsonSchema !== undefined ? { jsonSchema: def.jsonSchema } : {}),
    // FR-002 — pass through the io-capability fact verbatim (optional, like
    // jsonSchema). The audit reads it to require scope:"external" on any tool
    // that declares it crosses a boundary, not just the hardcoded outward
    // names. Omitted on the definition ⇒ omitted here.
    ...(def.ioCapability !== undefined ? { ioCapability: def.ioCapability } : {}),
    // Per-call concurrency classifier (Task): passed through verbatim, like
    // jsonSchema/ioCapability. Omitted on the definition ⇒ omitted here, so
    // the orchestrator falls back to the static concurrency flags.
    ...(def.concurrencyClassifier !== undefined
      ? { concurrencyClassifier: def.concurrencyClassifier }
      : {}),
  };
}
