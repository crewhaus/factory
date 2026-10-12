/**
 * A top-level union of object schemas, merged into one object schema.
 *
 * Anthropic forbids a top-level `anyOf`, but a nested `anyOf` on an
 * individual property is fine — so each property becomes the union of its
 * per-branch shapes, and `required` is the intersection across branches (in
 * practice the shared discriminator). The tool's own zod schema still
 * validates the real input at execute time, so the looser model-facing
 * schema loses no safety.
 *
 * The schema can be an MCP server's, up to 32 KiB of it, read at every
 * `runChatLoop` setup. Each property's shapes were kept by comparing every
 * new one with every one kept so far, as JSON — about 900 branches of one
 * key each made 880 000 `JSON.stringify` calls — and each branch's
 * `required` list was searched once per name still in the intersection.
 * Both are looked up in sets now; the schema produced is the same.
 */

/** The parts of a JSON Schema the union handling reads. */
export type JsonSchemaLike = {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  allOf?: unknown;
};

/** One property's distinct shapes, and their JSON once a second one arrives. */
type Variants = { readonly shapes: unknown[]; json: Set<string | undefined> | null };

/**
 * Merge `branches` into one object schema over `baseProps`. A property's
 * shapes are told apart by their JSON, first one kept; a property with one
 * shape keeps it, one with more becomes their `anyOf`.
 */
export function flattenUnionToObject(
  branches: JsonSchemaLike[],
  baseProps: Record<string, unknown> | undefined,
): { type: "object"; properties: Record<string, unknown>; required?: string[] } {
  const perKey = new Map<string, Variants>();
  const requiredSets: string[][] = [];
  for (const b of branches) {
    for (const [k, v] of Object.entries(b.properties ?? {})) {
      let entry = perKey.get(k);
      if (entry === undefined) {
        entry = { shapes: [], json: null };
        perKey.set(k, entry);
      }
      if (entry.shapes.length === 0) {
        entry.shapes.push(v);
        continue;
      }
      // The first shape is turned into JSON when a second one arrives, and
      // before it, as the comparison of each pair did: a shape JSON cannot
      // represent throws at the same point it always did.
      if (entry.json === null) entry.json = new Set([JSON.stringify(entry.shapes[0])]);
      const json = JSON.stringify(v);
      if (!entry.json.has(json)) {
        entry.shapes.push(v);
        entry.json.add(json);
      }
    }
    requiredSets.push(Array.isArray(b.required) ? (b.required as string[]) : []);
  }
  const properties: Record<string, unknown> = { ...(baseProps ?? {}) };
  for (const [k, { shapes }] of perKey) {
    properties[k] = shapes.length === 1 ? shapes[0] : { anyOf: shapes };
  }
  const required =
    requiredSets.length > 0
      ? requiredSets.reduce((acc, r) => {
          const listed = new Set(r);
          return acc.filter((x) => listed.has(x));
        })
      : [];
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
