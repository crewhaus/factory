/**
 * A change's `security` touch asks what Home asks of a direct spec edit: a path on a
 * security surface. `touchesOf` (quality-service) and `classifyPath` agree on every
 * `SECURITY_SURFACES` row.
 */
import { describe, expect, test } from "bun:test";
import { touchesOf } from "@crewhaus/quality-service";
import { SECURITY_SURFACES } from "@crewhaus/spec-patch";
import { classifyPath } from "./spec-edit";

/** JSON is YAML: a document both parsers read. */
const stringify = (doc: unknown): string => JSON.stringify(doc, null, 2);

const BASE = { name: "shop", target: "cli", agent: { model: "m", instructions: "Help." } };

/** A document that sets one value at `segments` (a `*` segment reads as one name). */
function withValueAt(segments: readonly string[]): Record<string, unknown> {
  const doc: Record<string, unknown> = structuredClone(BASE);
  let at: Record<string, unknown> = doc;
  const path = segments.map((s) => (s === "*" ? "x" : s));
  for (const [i, key] of path.entries()) {
    if (i === path.length - 1) {
      at[key] = "changed-by-test";
    } else {
      const next = at[key];
      at[key] = typeof next === "object" && next !== null ? { ...(next as object) } : {};
      at = at[key] as Record<string, unknown>;
    }
  }
  return doc;
}

describe("touchesOf and classifyPath", () => {
  test("agree that a change on every security surface touches security", () => {
    let checked = 0;
    for (const surface of SECURITY_SURFACES) {
      const segments = surface.prefix.map((s) => (s === "*" ? "x" : s));
      expect(classifyPath("cli", segments).securitySurface).toBe(true);
      const touches = touchesOf(stringify(BASE), stringify(withValueAt(surface.prefix)));
      expect({ prefix: surface.prefix.join("."), security: touches.security }).toEqual({
        prefix: surface.prefix.join("."),
        security: true,
      });
      checked++;
    }
    expect(checked).toBe(SECURITY_SURFACES.length);
    expect(checked).toBeGreaterThan(5);
  });

  test("and that a prompt edit does not", () => {
    expect(classifyPath("cli", ["agent", "instructions"]).securitySurface).toBe(false);
    const touches = touchesOf(
      stringify(BASE),
      stringify({ ...BASE, agent: { ...BASE.agent, instructions: "Help kindly." } }),
    );
    expect(touches.security).toBe(false);
  });
});
