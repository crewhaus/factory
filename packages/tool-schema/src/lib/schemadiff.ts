/**
 * What changed between two JSON Schemas, and whether a reader survives it.
 *
 * ## The compatibility question this answers
 *
 * A change is **compatible** when every value that was valid under the old
 * schema is still valid under the new one — the producer may have widened
 * things, but nothing a reader already accepts has become invalid. It is
 * **breaking** when some value valid under the old schema is now rejected.
 * It is **unknown** when deciding that would require reasoning this package
 * does not do: whether one regex accepts everything another does, or how two
 * different `anyOf` unions relate.
 *
 * `unknown` is reported, never rounded to compatible. A schema gate that
 * quietly passes an undecided change is worse than one that asks. That holds
 * for keywords this file does not model at all — `patternProperties`,
 * `contains`, `propertyNames`, `dependencies` and anything newer: a change to
 * one of them comes back `unknown`, not as silence.
 *
 * Note the direction: this is compatibility for a *reader* of the data. A
 * writer sees the mirror image — a widened type is a breaking change for
 * whoever must now produce it.
 */
import { deepEqual, isPlainObject, joinPointer, preview } from "./value";

export type Compat = "compatible" | "breaking" | "unknown";

export type SchemaChange = {
  /** JSON Pointer into the schema, e.g. `/properties/user/properties/id`. */
  path: string;
  keyword: string;
  detail: string;
  compat: Compat;
};

export type SchemaDiffResult = {
  /** The two schemas are structurally the same document, key order aside. */
  identical: boolean;
  /** `compatible` only when nothing is breaking and nothing is undecided. */
  verdict: Compat;
  backwardCompatible: boolean;
  changes: SchemaChange[];
  counts: { compatible: number; breaking: number; unknown: number };
};

type Ctx = { changes: SchemaChange[] };

function note(ctx: Ctx, path: string, keyword: string, compat: Compat, detail: string): void {
  ctx.changes.push({ path, keyword, detail, compat });
}

function asObject(schema: unknown): Record<string, unknown> | null {
  return isPlainObject(schema) ? schema : null;
}

function typeSet(schema: Record<string, unknown>): Set<string> | null {
  const declared = schema["type"];
  if (typeof declared === "string") return new Set([declared]);
  if (Array.isArray(declared)) {
    return new Set(declared.filter((t): t is string => typeof t === "string"));
  }
  return null;
}

function acceptsType(types: Set<string>, type: string): boolean {
  return types.has(type) || (type === "integer" && types.has("number"));
}

/** A bound that may only loosen: `minimum`, `minLength`, `minItems`, ... */
function diffLowerBound(
  ctx: Ctx,
  path: string,
  keyword: string,
  before: unknown,
  after: unknown,
): void {
  if (deepEqual(before, after)) return;
  if (typeof after !== "number") {
    note(ctx, path, keyword, "compatible", `${keyword} removed — the constraint is gone`);
    return;
  }
  if (typeof before !== "number") {
    note(
      ctx,
      path,
      keyword,
      "breaking",
      `${keyword} added (${after}) where there was no lower bound`,
    );
    return;
  }
  if (after > before)
    note(ctx, path, keyword, "breaking", `${keyword} raised from ${before} to ${after}`);
  else note(ctx, path, keyword, "compatible", `${keyword} lowered from ${before} to ${after}`);
}

/** A bound that may only loosen upwards: `maximum`, `maxLength`, `maxItems`, ... */
function diffUpperBound(
  ctx: Ctx,
  path: string,
  keyword: string,
  before: unknown,
  after: unknown,
): void {
  if (deepEqual(before, after)) return;
  if (typeof after !== "number") {
    note(ctx, path, keyword, "compatible", `${keyword} removed — the constraint is gone`);
    return;
  }
  if (typeof before !== "number") {
    note(
      ctx,
      path,
      keyword,
      "breaking",
      `${keyword} added (${after}) where there was no upper bound`,
    );
    return;
  }
  if (after < before)
    note(ctx, path, keyword, "breaking", `${keyword} lowered from ${before} to ${after}`);
  else note(ctx, path, keyword, "compatible", `${keyword} raised from ${before} to ${after}`);
}

const COMPOSITIONAL = ["allOf", "anyOf", "oneOf", "not", "if", "then", "else", "$ref"];

/**
 * Keywords {@link diffNode} reasons about itself, either by classifying the
 * change or by declaring it undecidable. Anything outside this set and
 * {@link ANNOTATIONS} is swept up at the end of the node as `unknown`, so a
 * keyword this package has never heard of cannot make a changed schema come
 * back "compatible".
 */
const MODELLED = new Set([
  ...COMPOSITIONAL,
  "type",
  "enum",
  "const",
  "required",
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
  "pattern",
  "format",
  "multipleOf",
  "uniqueItems",
  "properties",
  "additionalProperties",
  "items",
]);

/**
 * Keywords that carry no constraint, so changing one cannot change which
 * values validate. Mirrors the annotation list in `./jsonschema`.
 */
const ANNOTATIONS = new Set([
  "$id",
  "$schema",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
  "contentMediaType",
  "contentEncoding",
  "$defs",
  "definitions",
]);

function diffNode(before: unknown, after: unknown, path: string, ctx: Ctx): void {
  if (deepEqual(before, after)) return;

  // Boolean schemas: `true` accepts everything, `false` accepts nothing.
  if (typeof before === "boolean" || typeof after === "boolean") {
    if (after === false)
      note(ctx, path, "schema", "breaking", "now rejects every value (false schema)");
    else if (before === false)
      note(ctx, path, "schema", "compatible", "no longer rejects every value");
    else if (after === true)
      note(ctx, path, "schema", "compatible", "now accepts every value (true schema)");
    else
      note(
        ctx,
        path,
        "schema",
        "breaking",
        "replaced an unconstrained schema with a constrained one",
      );
    return;
  }

  const a = asObject(before);
  const b = asObject(after);
  if (a === null || b === null) {
    note(ctx, path, "schema", "unknown", "one side is not a schema object");
    return;
  }

  // --- type
  const aTypes = typeSet(a);
  const bTypes = typeSet(b);
  if (aTypes === null && bTypes !== null) {
    note(
      ctx,
      path,
      "type",
      "breaking",
      `type ${[...bTypes].join("|")} added where any type was allowed`,
    );
  } else if (aTypes !== null && bTypes === null) {
    note(
      ctx,
      path,
      "type",
      "compatible",
      `type ${[...aTypes].join("|")} removed — any type is now allowed`,
    );
  } else if (aTypes !== null && bTypes !== null) {
    const lost = [...aTypes].filter((t) => !acceptsType(bTypes, t));
    const gained = [...bTypes].filter((t) => !acceptsType(aTypes, t));
    if (lost.length > 0) {
      note(ctx, path, "type", "breaking", `no longer accepts ${lost.join(", ")}`);
    } else if (gained.length > 0) {
      note(ctx, path, "type", "compatible", `also accepts ${gained.join(", ")}`);
    }
  }

  // --- enum and const
  const aEnum = Array.isArray(a["enum"]) ? a["enum"] : null;
  const bEnum = Array.isArray(b["enum"]) ? b["enum"] : null;
  if (aEnum === null && bEnum !== null) {
    note(ctx, path, "enum", "breaking", `enum added, limiting values to ${preview(bEnum, 80)}`);
  } else if (aEnum !== null && bEnum === null) {
    note(ctx, path, "enum", "compatible", "enum removed — values are no longer limited");
  } else if (aEnum !== null && bEnum !== null) {
    const removed = aEnum.filter((v) => !bEnum.some((w) => deepEqual(v, w)));
    const added = bEnum.filter((v) => !aEnum.some((w) => deepEqual(v, w)));
    if (removed.length > 0) {
      note(ctx, path, "enum", "breaking", `enum values removed: ${preview(removed, 80)}`);
    }
    if (added.length > 0) {
      note(ctx, path, "enum", "compatible", `enum values added: ${preview(added, 80)}`);
    }
  }
  const aConst = Object.hasOwn(a, "const");
  const bConst = Object.hasOwn(b, "const");
  if (!deepEqual(a["const"], b["const"]) || aConst !== bConst) {
    if (bConst && !aConst) {
      note(ctx, path, "const", "breaking", `const added (${preview(b["const"], 60)})`);
    } else if (aConst && !bConst) {
      note(ctx, path, "const", "compatible", "const removed");
    } else {
      note(
        ctx,
        path,
        "const",
        "breaking",
        `const changed from ${preview(a["const"], 40)} to ${preview(b["const"], 40)}`,
      );
    }
  }

  // --- required
  const aRequired = Array.isArray(a["required"])
    ? a["required"].filter((k) => typeof k === "string")
    : [];
  const bRequired = Array.isArray(b["required"])
    ? b["required"].filter((k) => typeof k === "string")
    : [];
  const nowRequired = bRequired.filter((k) => !aRequired.includes(k));
  const noLongerRequired = aRequired.filter((k) => !bRequired.includes(k));
  if (nowRequired.length > 0) {
    note(ctx, path, "required", "breaking", `now required: ${nowRequired.join(", ")}`);
  }
  if (noLongerRequired.length > 0) {
    note(ctx, path, "required", "compatible", `no longer required: ${noLongerRequired.join(", ")}`);
  }

  // --- bounds
  diffLowerBound(ctx, path, "minimum", a["minimum"], b["minimum"]);
  diffLowerBound(ctx, path, "exclusiveMinimum", a["exclusiveMinimum"], b["exclusiveMinimum"]);
  diffLowerBound(ctx, path, "minLength", a["minLength"], b["minLength"]);
  diffLowerBound(ctx, path, "minItems", a["minItems"], b["minItems"]);
  diffLowerBound(ctx, path, "minProperties", a["minProperties"], b["minProperties"]);
  diffUpperBound(ctx, path, "maximum", a["maximum"], b["maximum"]);
  diffUpperBound(ctx, path, "exclusiveMaximum", a["exclusiveMaximum"], b["exclusiveMaximum"]);
  diffUpperBound(ctx, path, "maxLength", a["maxLength"], b["maxLength"]);
  diffUpperBound(ctx, path, "maxItems", a["maxItems"], b["maxItems"]);
  diffUpperBound(ctx, path, "maxProperties", a["maxProperties"], b["maxProperties"]);

  // --- constraints whose containment this package will not guess at
  for (const keyword of ["pattern", "format", "multipleOf"]) {
    const beforeValue = a[keyword];
    const afterValue = b[keyword];
    if (deepEqual(beforeValue, afterValue)) continue;
    if (afterValue === undefined) {
      note(ctx, path, keyword, "compatible", `${keyword} removed`);
    } else if (beforeValue === undefined) {
      note(ctx, path, keyword, "breaking", `${keyword} added (${preview(afterValue, 40)})`);
    } else {
      note(
        ctx,
        path,
        keyword,
        "unknown",
        `${keyword} changed from ${preview(beforeValue, 40)} to ${preview(afterValue, 40)} — containment is not analyzed`,
      );
    }
  }
  if (a["uniqueItems"] !== b["uniqueItems"]) {
    if (b["uniqueItems"] === true) {
      note(ctx, path, "uniqueItems", "breaking", "items must now be unique");
    } else {
      note(ctx, path, "uniqueItems", "compatible", "items need no longer be unique");
    }
  }

  // --- properties
  const aProps = asObject(a["properties"]) ?? {};
  const bProps = asObject(b["properties"]) ?? {};
  const propsPath = joinPointer(path, "properties");
  for (const key of Object.keys(aProps)) {
    if (Object.hasOwn(bProps, key)) {
      diffNode(aProps[key], bProps[key], joinPointer(propsPath, key), ctx);
      continue;
    }
    if (b["additionalProperties"] === false) {
      note(
        ctx,
        joinPointer(propsPath, key),
        "properties",
        "breaking",
        `property "${key}" removed while additionalProperties is false, so values carrying it are now rejected`,
      );
    } else {
      note(
        ctx,
        joinPointer(propsPath, key),
        "properties",
        "compatible",
        `property "${key}" is no longer described, but is still allowed`,
      );
    }
  }
  for (const key of Object.keys(bProps)) {
    if (Object.hasOwn(aProps, key)) continue;
    const required = bRequired.includes(key);
    note(
      ctx,
      joinPointer(propsPath, key),
      "properties",
      required ? "breaking" : "compatible",
      required ? `property "${key}" added and required` : `optional property "${key}" added`,
    );
  }

  // --- additionalProperties
  if (!deepEqual(a["additionalProperties"], b["additionalProperties"])) {
    const apPath = joinPointer(path, "additionalProperties");
    if (b["additionalProperties"] === false) {
      note(ctx, apPath, "additionalProperties", "breaking", "extra properties are now rejected");
    } else if (a["additionalProperties"] === false) {
      note(ctx, apPath, "additionalProperties", "compatible", "extra properties are now allowed");
    } else if (
      isPlainObject(a["additionalProperties"]) &&
      isPlainObject(b["additionalProperties"])
    ) {
      diffNode(a["additionalProperties"], b["additionalProperties"], apPath, ctx);
    } else {
      note(
        ctx,
        apPath,
        "additionalProperties",
        "unknown",
        "the additionalProperties schema changed shape",
      );
    }
  }

  // --- items
  const aItems = a["items"];
  const bItems = b["items"];
  if (!deepEqual(aItems, bItems)) {
    const itemsPath = joinPointer(path, "items");
    if (Array.isArray(aItems) || Array.isArray(bItems)) {
      note(
        ctx,
        itemsPath,
        "items",
        "unknown",
        "tuple-form items changed — positions are not analyzed",
      );
    } else if (aItems === undefined) {
      note(ctx, itemsPath, "items", "breaking", "items added where any element was allowed");
    } else if (bItems === undefined) {
      note(ctx, itemsPath, "items", "compatible", "items removed — any element is now allowed");
    } else {
      diffNode(aItems, bItems, itemsPath, ctx);
    }
  }

  // --- everything compositional
  for (const keyword of COMPOSITIONAL) {
    if (deepEqual(a[keyword], b[keyword])) continue;
    note(
      ctx,
      joinPointer(path, keyword),
      keyword,
      "unknown",
      `${keyword} changed — this diff does not reason about composed schemas`,
    );
  }

  // --- anything left. `patternProperties`, `contains`, `propertyNames`,
  // `dependencies` and friends are not modelled here, and a change to one of
  // them can absolutely reject a value that used to pass. Reporting them as
  // undecidable is the only honest answer; staying silent would let the
  // verdict read "compatible".
  for (const keyword of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (MODELLED.has(keyword) || ANNOTATIONS.has(keyword)) continue;
    if (deepEqual(a[keyword], b[keyword])) continue;
    note(
      ctx,
      joinPointer(path, keyword),
      keyword,
      "unknown",
      `${keyword} changed — this diff does not model that keyword, so whether a reader survives it is undecided here`,
    );
  }
}

/**
 * Diff two schemas and classify each change. See the module comment for what
 * "compatible" means here and for the cases deliberately left `unknown`.
 */
export function diffSchemas(before: unknown, after: unknown): SchemaDiffResult {
  const ctx: Ctx = { changes: [] };
  diffNode(before, after, "", ctx);
  const counts = {
    compatible: ctx.changes.filter((c) => c.compat === "compatible").length,
    breaking: ctx.changes.filter((c) => c.compat === "breaking").length,
    unknown: ctx.changes.filter((c) => c.compat === "unknown").length,
  };
  const verdict: Compat =
    counts.breaking > 0 ? "breaking" : counts.unknown > 0 ? "unknown" : "compatible";
  return {
    // Structural identity, not "nothing was found": two schemas differing
    // only in a `description` produce no changes, and saying they are
    // identical would be a different claim from the one made here.
    identical: deepEqual(before, after),
    verdict,
    backwardCompatible: verdict === "compatible",
    changes: ctx.changes,
    counts,
  };
}
