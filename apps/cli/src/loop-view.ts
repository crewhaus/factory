/**
 * Loop contract 0.4 (Batch B, G42) — the human-readable rendering of a
 * `LoopProjection` for `crewhaus compile --emit-loop`. The projection itself
 * (`projectLoop` in `@crewhaus/ir`) is the wire contract shared with the
 * studio /builder page and the compiler-worker's `POST /loop` endpoint; this
 * module only formats it for a terminal — `--json` (and `-o`, which writes
 * `loop.json`) emit the raw projection untouched.
 *
 * Layout:
 *   - ring targets (cli/channel/managed + the fallback shapes): one line per
 *     segment in canonical SEGMENT_ORDER, `●` active / `○` inactive, with
 *     the segment summary and the spec keys that lit it;
 *   - canvas targets (workflow/graph/crew/…): the node list (each node's
 *     ACTIVE mini segments only — an inactive node line would be noise) and
 *     the edge list with condition labels;
 *   - warnings verbatim, last — they carry the defaults-only Stop boundary
 *     (`NO_BUDGET_WARNING`), fallback-projection hints, and structural notes.
 *
 * Side-effect-free so the rendering is unit-testable (the CLI entry file
 * runs an argv switch on import).
 */
import type { LoopProjection, LoopSegment } from "@crewhaus/ir";

function segmentLine(s: LoopSegment, indent: string): string {
  const glyph = s.active ? "●" : "○";
  const keys = s.keys.length > 0 ? `  [${s.keys.join(", ")}]` : "";
  return `${indent}${glyph} ${s.id.padEnd(8)} ${s.summary}${keys}`;
}

/** Render a LoopProjection as terminal lines (no trailing newline). */
export function formatLoopProjection(p: LoopProjection): string[] {
  const lines: string[] = [`loop projection: ${p.target} (${p.kind})`];

  if (p.ring !== undefined) {
    for (const s of p.ring.segments) lines.push(segmentLine(s, "  "));
  }

  if (p.canvas !== undefined) {
    lines.push(`nodes (${p.canvas.nodes.length}):`);
    for (const n of p.canvas.nodes) {
      const hitl = n.hitl === true ? " [HITL]" : "";
      lines.push(`  ${n.label} <${n.kind}>${hitl}`);
      for (const s of n.mini.filter((seg) => seg.active)) {
        lines.push(segmentLine(s, "    "));
      }
    }
    lines.push(`edges (${p.canvas.edges.length}):`);
    for (const e of p.canvas.edges) {
      const label = e.label !== undefined ? ` [${e.label}]` : "";
      const cond = e.conditional === true ? " (conditional)" : "";
      lines.push(`  ${e.from} → ${e.to}${label}${cond}`);
    }
  }

  if (p.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of p.warnings) lines.push(`  - ${w}`);
  }
  return lines;
}
