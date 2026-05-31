import { isOutwardName } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";

/**
 * FR-002 — Pillar 3 sink-side build-time gate (pure, side-effect-free so it
 * is directly unit-testable; the entry file `index.ts` runs a top-level
 * argv switch and cannot be imported without executing the CLI).
 *
 * A single shared audit used by BOTH `crewhaus compile --strict` and
 * `crewhaus doctor --philosophy-alignment` so the two enforcement paths can
 * never drift (acceptance criterion: "the --strict gate and doctor
 * --philosophy-alignment share one implementation").
 *
 * A finding fires when a tool is I/O-capable yet its resolved `scope` is not
 * "external". A tool counts as I/O-capable when EITHER:
 *
 *   (a) it declares `ioCapability` ("network" | "process") on its
 *       `ToolDefinition` — the capability-driven path that catches an
 *       *arbitrary-named* custom `buildTool` tool that opens a socket or
 *       spawns a process (the FR mechanism-2 residual: "custom buildTool
 *       tools that open sockets, spawn processes, touch the network"); or
 *   (b) its name is definitionally outward-reaching
 *       (Fetch/WebFetch/WebSearch/SendMessage/EvmSendTransaction/ImageGenerate
 *       or any `mcp__*`, per `isOutwardName`) — the name backstop that still
 *       fires for a future built-in that forgets BOTH annotations.
 *
 * Because the gate keys on the declared capability and not only on a
 * hardcoded name set, a custom `SomeCustomSocketTool` with
 * `ioCapability: "network"` but no `scope: "external"` is now flagged — the
 * gate is no longer a no-op for user-authored tools that declare what they
 * do. (It cannot read the mind of a tool that declares NEITHER its
 * capability nor an outward name; that irreducible residual — a tool that
 * lies by omission about touching the network — is documented in the
 * walkthrough and is the limit of a static, annotation-based check short of
 * full dataflow analysis, which the FR puts out of scope.)
 */
export type ScopeFinding = { toolName: string; reason: string };

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
 * FR-002 — the `compile --strict` audit over the *spec-level* tool names a
 * lowered IR references (the IR only carries names, never RegisteredTools).
 *
 * For each name we ask `resolve` (the offline built-in tool map) for the
 * concrete RegisteredTool:
 *
 *   - Resolved → run the same per-tool `auditToolScopes` check (capability or
 *     outward-name vs scope). This is how the six built-ins are verified.
 *   - Unresolved AND outward-by-name (`mcp__*` or a known outward built-in
 *     name not in the offline map) → FINDING. The name is statically known to
 *     be an external sink (the FR lists MCP calls among the definitionally-
 *     outward kinds, and `buildTool` infers `external` for `mcp__*`), but the
 *     compiler cannot prove offline that its scope is `"external"`. `--strict`
 *     refuses to emit a bundle that reaches an outward sink whose external
 *     scope it cannot verify — this is the criterion's "I/O-capable tool left
 *     at an unspecified scope" from the compiler's offline vantage. Without
 *     this, a spec referencing `mcp__evil__exfiltrate` slipped through.
 *   - Unresolved and NOT outward-by-name → skipped. A name the offline map
 *     doesn't know and whose name carries no outward signal is either a
 *     pure-compute custom tool registered in code or a typo; the offline gate
 *     has no capability fact to assert (the live `doctor --philosophy-
 *     alignment` audit, which sees real RegisteredTools, covers the registry).
 *
 * `resolve` is injected so this is a pure function unit-testable without the
 * CLI importing the (heavy, side-effectful) built-in tool packages.
 */
export function auditSpecToolNames(
  names: readonly string[],
  resolve: (name: string) => RegisteredTool | undefined,
): ScopeFinding[] {
  const findings: ScopeFinding[] = [];
  for (const name of names) {
    const tool = resolve(name);
    if (tool) {
      findings.push(...auditToolScopes([tool]));
    } else if (isOutwardName(name)) {
      findings.push({
        toolName: name,
        reason:
          'is an outward-reaching sink by name but could not be resolved to a scope:"external" tool at compile time (dynamic/MCP sinks must be vetted, not assumed) — its egress scope is unverifiable offline',
      });
    }
  }
  return findings;
}

/**
 * FR-002 — collect every tool NAME referenced anywhere in a lowered IR,
 * variant-agnostically. The IR is a JSON-serializable discriminated union
 * (14 variants); some carry tools at the top level (`IrV0.tools`), others
 * nest them under steps / nodes / stages / sub-agents. Rather than couple to
 * each variant's shape, walk the serialized object and gather every string
 * under a `tools` key. Deterministic and dedup'd.
 */
export function collectToolNames(ir: unknown): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "tools" && Array.isArray(value)) {
          for (const v of value) if (typeof v === "string") names.add(v);
        }
        visit(value);
      }
    }
  };
  visit(ir);
  return [...names];
}
