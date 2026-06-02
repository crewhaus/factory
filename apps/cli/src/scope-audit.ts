import { type ScopeFinding, auditToolScopes, isOutwardName } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";

/**
 * FR-002 — Pillar 3 sink-side build-time gate. The canonical per-tool
 * `auditToolScopes` (and its `ScopeFinding` type) now live in
 * `@crewhaus/tool-builder`, next to `isOutwardName` and `buildTool` — the two
 * facts the gate keys on — so every consumer (this CLI's `compile --strict`
 * and `doctor --philosophy-alignment`, plus the `compile()` library and the
 * compiler-worker) audits identically rather than re-deriving the rule. They
 * are re-exported here so the CLI's existing import sites and tests are
 * unchanged.
 */
export { type ScopeFinding, auditToolScopes };

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
