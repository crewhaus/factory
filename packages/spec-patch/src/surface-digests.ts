import { createHash } from "node:crypto";
/**
 * Digests of a spec's security surfaces: one `sha256:` per row of
 * `SECURITY_SURFACES`, over the values that row covers. Two specs whose
 * permissions are the same have the same `permissions` digest whatever else
 * changed between them, so a record of these digests says which security
 * settings changed without holding a single value.
 *
 * Exported from `@crewhaus/spec-patch/commit`, not the main entry: hashing
 * needs `node:crypto`.
 */
import { canonicalJson } from "@crewhaus/ir/policy";
import { SECURITY_SURFACES, type SecuritySurface, surfaceMatches } from "./surfaces";

/** The record key of a row: its prefix, dotted (`permissions`, `sub_agents.*.allowed_profiles`). */
export function surfaceKey(surface: SecuritySurface): string {
  return surface.prefix.join(".");
}

/**
 * The rows a digest is kept for. A row marked `exact` gates replacing a
 * whole step, node, role or game block in the editor; the settings inside one
 * are covered by their own rows (`tools`, `permissions`, `model`, …), and its
 * tunable fields are not security settings, so `exact` rows carry no digest.
 */
function digestRows(): ReadonlyArray<SecuritySurface> {
  return SECURITY_SURFACES.filter((surface) => surface.exact !== true);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value canonical JSON can hold: a non-finite number or an odd scalar becomes a tagged string. */
function jsonSafe(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = jsonSafe(child);
    return out;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : `#number:${String(value)}`;
    case "undefined":
      return null;
    default:
      return `#${typeof value}:${String(value)}`;
  }
}

/**
 * Every `[path, value]` pair a row covers in `raw`: the shallowest paths the
 * row matches, each with the whole value under it.
 */
function pairsFor(surface: SecuritySurface, raw: unknown): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  const walk = (node: unknown, path: string[]): void => {
    if (path.length > 0 && surfaceMatches(surface, path)) {
      out.push([path.join("."), node]);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, [...path, String(i)]));
    } else if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
    }
  };
  walk(raw, []);
  return out;
}

/**
 * One `sha256:` digest per security-surface row present in `raw` (a parsed
 * spec, before schema defaults), keyed by the row's dotted prefix. A row that
 * covers nothing in this spec is left out. Rows that share a prefix share a
 * key, and their pairs are counted once each.
 */
export function surfaceDigests(raw: unknown): Record<string, string> {
  const grouped = new Map<string, Map<string, unknown>>();
  for (const surface of digestRows()) {
    const pairs = pairsFor(surface, raw);
    if (pairs.length === 0) continue;
    const key = surfaceKey(surface);
    const into = grouped.get(key) ?? new Map<string, unknown>();
    for (const [path, value] of pairs) into.set(path, value);
    grouped.set(key, into);
  }
  const digests: Record<string, string> = {};
  for (const key of [...grouped.keys()].sort()) {
    const pairs = [...(grouped.get(key) as Map<string, unknown>).entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const material = canonicalJson(pairs.map(([path, value]) => [path, jsonSafe(value)]));
    digests[key] = `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`;
  }
  return digests;
}

/** The row keys whose digest differs between two records, a key present in only one included, sorted. */
export function changedSurfaces(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]).sort();
}
