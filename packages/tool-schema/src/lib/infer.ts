/**
 * Inferring a JSON Schema from example values.
 *
 * What this produces is a *description of the samples*, which is the honest
 * thing to produce: it states types, structure and (optionally) formats and
 * small enumerations, and deliberately infers no numeric bounds, no string
 * lengths and no patterns, because three samples never justify a range. The
 * output is a starting point an operator tightens by hand, not a contract
 * discovered from data.
 *
 * Property order follows first appearance across the samples, so the same
 * samples always produce byte-identical output.
 */
import { type FormatName, matchingFormats } from "./formats";
import { type JsonType, canonicalize, isPlainObject, typeOf } from "./value";

export type InferOptions = {
  /** Mark a property required when every object sample at that node had it. */
  requireAll: boolean;
  /** Label a string field with a format when every sample matches one. */
  detectFormats: boolean;
  /** Turn a small, closed set of string values into an `enum`. */
  detectEnums: boolean;
  /** At most this many distinct values may become an enum. */
  enumThreshold: number;
  /** Emit `additionalProperties: false` on every inferred object. */
  closed: boolean;
  /** Stop descending past this depth and emit an unconstrained schema. */
  maxDepth: number;
};

export const DEFAULT_INFER_OPTIONS: InferOptions = {
  requireAll: true,
  detectFormats: true,
  detectEnums: false,
  enumThreshold: 12,
  closed: false,
  maxDepth: 12,
};

/** How many distinct string values a node remembers before giving up on enums. */
const MAX_TRACKED_STRINGS = 200;

type Node = {
  count: number;
  types: Set<JsonType>;
  /** Child nodes for object properties, in first-seen order. */
  props: Map<string, Node>;
  /** How many object samples carried each property. */
  propCounts: Map<string, number>;
  objectCount: number;
  /** One merged node for every array element seen at this position. */
  items: Node | null;
  stringCount: number;
  distinctStrings: Set<string>;
  stringsOverflowed: boolean;
};

function emptyNode(): Node {
  return {
    count: 0,
    types: new Set<JsonType>(),
    props: new Map<string, Node>(),
    propCounts: new Map<string, number>(),
    objectCount: 0,
    items: null,
    stringCount: 0,
    distinctStrings: new Set<string>(),
    stringsOverflowed: false,
  };
}

function observe(node: Node, value: unknown, depth: number, maxDepth: number): void {
  node.count += 1;
  const type = typeOf(value);
  node.types.add(type);

  if (type === "string") {
    node.stringCount += 1;
    if (node.distinctStrings.size < MAX_TRACKED_STRINGS) node.distinctStrings.add(value as string);
    else if (!node.distinctStrings.has(value as string)) node.stringsOverflowed = true;
    return;
  }
  if (depth >= maxDepth) return;
  if (Array.isArray(value)) {
    if (value.length > 0 && node.items === null) node.items = emptyNode();
    for (const item of value) observe(node.items as Node, item, depth + 1, maxDepth);
    return;
  }
  if (isPlainObject(value)) {
    node.objectCount += 1;
    for (const key of Object.keys(value)) {
      let child = node.props.get(key);
      if (child === undefined) {
        child = emptyNode();
        node.props.set(key, child);
      }
      node.propCounts.set(key, (node.propCounts.get(key) ?? 0) + 1);
      observe(child, value[key], depth + 1, maxDepth);
    }
  }
}

/** The order types are written in, so output is stable. */
const TYPE_ORDER: JsonType[] = [
  "null",
  "boolean",
  "integer",
  "number",
  "string",
  "array",
  "object",
];

function renderTypes(types: Set<JsonType>): string[] {
  const widened = new Set(types);
  // A node that saw both 3 and 3.5 is a number, not "integer or number".
  if (widened.has("number")) widened.delete("integer");
  return TYPE_ORDER.filter((t) => widened.has(t));
}

function render(node: Node, opts: InferOptions, depth: number): Record<string, unknown> {
  if (depth > opts.maxDepth || node.types.size === 0) return {};
  const schema: Record<string, unknown> = {};
  const types = renderTypes(node.types);
  schema["type"] = types.length === 1 ? types[0] : types;

  if (node.types.has("object")) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of node.props) {
      properties[key] = render(child, opts, depth + 1);
      if (opts.requireAll && node.propCounts.get(key) === node.objectCount) required.push(key);
    }
    schema["properties"] = properties;
    if (required.length > 0) schema["required"] = required;
    if (opts.closed) schema["additionalProperties"] = false;
  }

  if (node.types.has("array")) {
    // An array position that only ever held empty arrays says nothing about
    // its items, so no `items` is emitted rather than a false `{}` claim.
    if (node.items !== null) schema["items"] = render(node.items, opts, depth + 1);
  }

  if (node.types.has("string") && node.stringCount > 0) {
    if (
      opts.detectEnums &&
      !node.stringsOverflowed &&
      node.distinctStrings.size <= opts.enumThreshold
    ) {
      schema["enum"] = [...node.distinctStrings].sort();
    } else if (opts.detectFormats && !node.stringsOverflowed) {
      // Past MAX_TRACKED_STRINGS the node stopped remembering values, so a
      // format agreed on by the ones it kept says nothing about the ones it
      // dropped. No label is the honest answer.
      const format = commonFormat([...node.distinctStrings]);
      if (format !== null) schema["format"] = format;
    }
  }

  return schema;
}

/**
 * Formats too weak to infer from samples alone, and what it takes to earn
 * them. Inference writes a *claim* about every future value of a field, so a
 * grammar that almost everything satisfies is worse than no label at all:
 *
 * - **hostname** accepts any bare word, so `"active"` and `"pending"` are
 *   both valid hostnames. It is only inferred when every sample has a dot,
 *   which is the shape a real host name has.
 * - **json-pointer** accepts the empty string and anything starting with
 *   `/`, so every Unix path qualifies. It is never inferred.
 *
 * Validation is unaffected — `ValidateFormat` and `assertFormat` still check
 * these in full. This narrows only what inference is willing to assert.
 */
function inferableFormats(sample: string): FormatName[] {
  return matchingFormats(sample).filter((format) => {
    if (format === "json-pointer") return false;
    if (format === "hostname") return sample.includes(".");
    return true;
  });
}

/**
 * The most specific format every sample matches, or `null`. "Most specific"
 * is the order {@link matchingFormats} returns, narrowest first, so a UUID or
 * a date is labelled as such rather than as the `hostname` it also satisfies.
 * {@link inferableFormats} first drops the grammars too loose to assert from
 * samples.
 */
export function commonFormat(samples: string[]): FormatName | null {
  if (samples.length === 0) return null;
  let shared: FormatName[] | null = null;
  for (const sample of samples) {
    const formats = inferableFormats(sample);
    if (formats.length === 0) return null;
    shared = shared === null ? formats : shared.filter((f) => formats.includes(f));
    if (shared.length === 0) return null;
  }
  return shared?.[0] ?? null;
}

/**
 * Infer one schema covering every sample. At least one sample is required;
 * more samples make the result narrower in the parts that are genuinely
 * shared and wider in the parts that are not (a property missing from one
 * sample stops being required, a field that is sometimes null gains `null`
 * in its type).
 */
export function inferSchema(
  samples: unknown[],
  options: Partial<InferOptions> = {},
): Record<string, unknown> {
  const opts: InferOptions = { ...DEFAULT_INFER_OPTIONS, ...options };
  if (samples.length === 0) throw new Error("inferSchema needs at least one sample");
  const root = emptyNode();
  for (const sample of samples) observe(root, sample, 0, opts.maxDepth);
  const schema = render(root, opts, 0);
  return { $schema: "http://json-schema.org/draft-07/schema#", ...schema };
}

/**
 * How well an existing schema already covers a set of samples, counted by
 * distinct canonical value — the number a caller wants before deciding to
 * replace a schema with an inferred one.
 */
export function distinctCount(samples: unknown[]): number {
  return new Set(samples.map(canonicalize)).size;
}
