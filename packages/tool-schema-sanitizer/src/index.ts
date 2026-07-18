/**
 * Provider-neutral JSON-Schema sanitizer for tool `input_schema`.
 *
 * MCP servers (and the zod-to-json-schema / pydantic pipelines behind
 * them) routinely emit tool schemas that are valid JSON Schema Draft
 * 2020-12 but sit OUTSIDE the narrower subsets some model providers
 * accept for function/tool declarations. The two recurring offenders:
 *
 * - **`$ref` + `$defs`/`definitions`** — a schema that factors shared
 *   shapes into `$defs` and references them with `{ "$ref": "#/$defs/X" }`.
 *   Google Gemini and Bedrock Converse have no reference resolver; an
 *   unresolved `$ref` reaches the model as a meaningless node and the
 *   request 400s ("Invalid JSON payload... Unknown name \"$ref\"").
 *
 * - **Keywords outside the provider subset** — `additionalProperties`,
 *   `patternProperties`, `oneOf`/`allOf`/`not`, string `format`s Gemini
 *   doesn't recognise (`uri`, `email`, `uuid`, …), and `anyOf` unions
 *   used to express an optional/nullable field. Each provider rejects a
 *   different slice of these.
 *
 * This module inlines every `$ref`, then projects the schema onto the
 * target provider's documented subset:
 *
 * - {@link sanitizeGeminiSchema} — Gemini's OpenAPI-3.0-derived `Schema`
 *   (allow-list of keywords; `nullable` instead of null-typed unions;
 *   `oneOf`→`anyOf`; `allOf` merged; single-branch unions flattened;
 *   unsupported `format` values dropped; `const`→single-value `enum`).
 *
 * - {@link sanitizeBedrockSchema} — Converse `toolSpec.inputSchema.json`
 *   (deny-list strip of the structural metadata Converse models choke
 *   on — `$schema`/`$id`/`additionalProperties`/`patternProperties`/… —
 *   plus `oneOf`→`anyOf` and `allOf` merge; otherwise permissive).
 *
 * - {@link toOpenAIStrictSchema} — OpenAI Structured-Outputs strict mode.
 *   OpenAI is the inverse case: rather than downcast, we UPGRADE a
 *   qualifying schema (object root, keywords entirely inside the strict
 *   subset) into a strict-ready form — `additionalProperties: false` on
 *   every object, every property listed in `required`, previously
 *   optional properties made nullable — so the adapter can set
 *   `strict: true`. Schemas that can't be expressed in the strict subset
 *   return `null` and stay non-strict (best-effort, never a 400).
 *
 * The Anthropic adapter deliberately does NOT consume this — the
 * canonical schema IS Anthropic's tool-input shape, so it passes through
 * untouched.
 */

export type JsonSchema = Record<string, unknown>;

export type SanitizeTarget = "gemini" | "bedrock";

/** Dispatch to the per-provider downcast sanitizer. */
export function sanitizeToolSchema(schema: JsonSchema, target: SanitizeTarget): JsonSchema {
  return target === "gemini" ? sanitizeGeminiSchema(schema) : sanitizeBedrockSchema(schema);
}

// ---------------------------------------------------------------------------
// shared primitives
// ---------------------------------------------------------------------------

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keywords whose values are literal data (not sub-schemas). We never
 * recurse into them — an object sitting inside an `enum`/`default` that
 * happens to carry a `$ref`-shaped key is user data, not a reference.
 */
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  "enum",
  "const",
  "default",
  "examples",
  "example",
]);

/** `$defs`/`definitions` containers are dropped once refs are inlined. */
const DEF_CONTAINER_KEYS: ReadonlySet<string> = new Set(["$defs", "definitions"]);

function withoutKey(node: JsonSchema, key: string): JsonSchema {
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if (k !== key) out[k] = v;
  }
  return out;
}

function omit(node: JsonSchema, keys: readonly string[]): JsonSchema {
  const drop = new Set(keys);
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if (!drop.has(k)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// $ref inlining
// ---------------------------------------------------------------------------

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolve a local JSON Pointer (`#/$defs/Foo/properties/bar`) against the root. */
function resolvePointer(root: JsonSchema, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref.slice(2).split("/").map(decodePointerSegment);
  let current: unknown = root;
  for (const segment of segments) {
    if (isSchemaObject(current)) {
      current = current[segment];
    } else if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Deep-clone `schema`, resolving every local `$ref` against the document
 * root and dropping the `$defs`/`definitions` containers. `refStack`
 * tracks the pointers currently being expanded on this path so a
 * recursive definition breaks into a permissive `{}` instead of looping
 * forever. Sibling keywords alongside a `$ref` (Draft 2020-12 allows
 * them) override the referenced target.
 */
export function inlineRefs(schema: JsonSchema): JsonSchema {
  const expanded = expandNode(schema, schema, []);
  return isSchemaObject(expanded) ? expanded : {};
}

function expandValue(value: unknown, root: JsonSchema, refStack: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => expandValue(item, root, refStack));
  if (isSchemaObject(value)) return expandNode(value, root, refStack);
  return value;
}

function expandNode(node: JsonSchema, root: JsonSchema, refStack: readonly string[]): JsonSchema {
  const ref = node["$ref"];
  if (typeof ref === "string") {
    const siblings = expandSchemaEntries(withoutKey(node, "$ref"), root, refStack);
    if (refStack.includes(ref)) return siblings; // cycle → break with siblings only
    const target = resolvePointer(root, ref);
    if (!isSchemaObject(target)) return siblings; // unresolvable → drop the ref
    const expandedTarget = expandNode(target, root, [...refStack, ref]);
    return { ...expandedTarget, ...siblings }; // siblings win
  }
  return expandSchemaEntries(node, root, refStack);
}

function expandSchemaEntries(
  node: JsonSchema,
  root: JsonSchema,
  refStack: readonly string[],
): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (DEF_CONTAINER_KEYS.has(key)) continue; // drop containers post-inline
    if (DATA_KEYWORDS.has(key)) {
      out[key] = value; // literal data — never treated as a sub-schema
      continue;
    }
    out[key] = expandValue(value, root, refStack);
  }
  return out;
}

// ---------------------------------------------------------------------------
// union / composition normalisation (shared by gemini + bedrock)
// ---------------------------------------------------------------------------

/** Fold `allOf` members (and the node's own keys) into one object schema. */
function mergeAllOf(node: JsonSchema): JsonSchema {
  const allOf = node["allOf"];
  if (!Array.isArray(allOf)) return node;

  const parts: JsonSchema[] = [
    ...allOf.filter(isSchemaObject).map(mergeAllOf),
    mergeAllOf(withoutKey(node, "allOf")),
  ];

  const out: JsonSchema = {};
  const mergedProps: JsonSchema = {};
  const mergedRequired: string[] = [];
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key === "properties" && isSchemaObject(value)) {
        Object.assign(mergedProps, value);
      } else if (key === "required" && Array.isArray(value)) {
        for (const r of value) if (typeof r === "string") mergedRequired.push(r);
      } else {
        out[key] = value; // later parts (the node itself is last) win
      }
    }
  }
  if (Object.keys(mergedProps).length > 0) out["properties"] = mergedProps;
  if (mergedRequired.length > 0) out["required"] = [...new Set(mergedRequired)];
  return out;
}

/** Rename `oneOf` to `anyOf` (concatenating if both are present). */
function coalesceOneOf(node: JsonSchema): JsonSchema {
  const oneOf = node["oneOf"];
  if (!Array.isArray(oneOf)) return node;
  const out = withoutKey(node, "oneOf");
  const existing = Array.isArray(out["anyOf"]) ? out["anyOf"] : [];
  out["anyOf"] = [...existing, ...oneOf];
  return out;
}

/** A branch that only says `type: "null"` (the null arm of a union). */
function isNullBranch(node: JsonSchema): boolean {
  return node["type"] === "null";
}

// ---------------------------------------------------------------------------
// Gemini — OpenAPI-3.0 Schema subset
// ---------------------------------------------------------------------------

/** Keyword allow-list for Gemini's `Schema`; anything else is dropped. */
const GEMINI_ALLOWED: ReadonlySet<string> = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "default",
  "anyOf",
  "example",
  "propertyOrdering",
]);

/** `format` values Gemini recognises, keyed by the type they attach to. */
const GEMINI_STRING_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "enum",
]);
const GEMINI_NUMBER_FORMATS: ReadonlySet<string> = new Set(["float", "double", "int32", "int64"]);

/**
 * Project a tool schema onto Gemini's function-declaration `Schema`
 * subset: inline refs, then downcast keyword-by-keyword.
 */
export function sanitizeGeminiSchema(schema: JsonSchema): JsonSchema {
  const out = sanitizeGeminiNode(inlineRefs(schema));
  // Gemini's top-level function parameters must be an object schema.
  if (out["type"] === undefined && isSchemaObject(out["properties"])) out["type"] = "object";
  return out;
}

function sanitizeGeminiNode(node: JsonSchema): JsonSchema {
  const normalised = coalesceOneOf(mergeAllOf(node));
  let nullable = normalised["nullable"] === true;

  // Collect union branches from `anyOf` and from a `type: [...]` array.
  let branches: JsonSchema[] | undefined = Array.isArray(normalised["anyOf"])
    ? normalised["anyOf"].filter(isSchemaObject)
    : undefined;

  let singleType: string | undefined;
  const rawType = normalised["type"];
  if (Array.isArray(rawType)) {
    const nonNull = rawType.filter((t): t is string => typeof t === "string" && t !== "null");
    if (rawType.includes("null")) nullable = true;
    if (nonNull.length === 1) {
      singleType = nonNull[0];
    } else if (nonNull.length > 1) {
      const typeBranches: JsonSchema[] = nonNull.map((t) => ({ type: t }));
      branches = branches ? [...branches, ...typeBranches] : typeBranches;
    }
  } else if (typeof rawType === "string") {
    if (rawType === "null") nullable = true;
    else singleType = rawType;
  }

  if (branches !== undefined) {
    if (branches.some(isNullBranch)) nullable = true;
    const members = branches
      .filter((b) => !isNullBranch(b))
      .map(sanitizeGeminiNode)
      .filter((b) => Object.keys(b).length > 0);

    if (members.length === 1) {
      const only: JsonSchema = { ...members[0] };
      if (nullable) only["nullable"] = true;
      carryMeta(only, normalised);
      return filterGeminiKeys(only);
    }
    if (members.length > 1) {
      const out: JsonSchema = { anyOf: members };
      if (nullable) out["nullable"] = true;
      carryMeta(out, normalised);
      return filterGeminiKeys(out);
    }
    // Zero surviving members → fall through to the leaf path below.
  }

  // Leaf/object path — build the result immutably (drop composition
  // keywords, the raw `type`/`nullable`/`const`/`format`, and the
  // sub-schema keys handled below; re-add the resolved forms).
  const out: JsonSchema = omit(normalised, [
    "anyOf",
    "oneOf",
    "allOf",
    "type",
    "nullable",
    "const",
    "format",
    "properties",
    "items",
  ]);
  if (singleType !== undefined) out["type"] = singleType;
  if (nullable) out["nullable"] = true;
  // Gemini has no `const` — express it as a single-value enum.
  if ("const" in normalised) out["enum"] = [normalised["const"]];

  const rawProps = normalised["properties"];
  if (isSchemaObject(rawProps)) {
    const props: JsonSchema = {};
    for (const [key, value] of Object.entries(rawProps)) {
      if (isSchemaObject(value)) props[key] = sanitizeGeminiNode(value);
    }
    out["properties"] = props;
    if (out["type"] === undefined) out["type"] = "object";
  }

  const rawItems = normalised["items"];
  if (isSchemaObject(rawItems)) {
    out["items"] = sanitizeGeminiNode(rawItems);
    if (out["type"] === undefined) out["type"] = "array";
  } else if (Array.isArray(rawItems)) {
    // Gemini has no tuple typing — collapse to the first element schema.
    const first = rawItems.find(isSchemaObject);
    out["items"] = first !== undefined ? sanitizeGeminiNode(first) : {};
    if (out["type"] === undefined) out["type"] = "array";
  }

  // Re-attach `format` only when Gemini recognises it for the resolved type.
  const format = normalised["format"];
  if (typeof format === "string" && isSupportedGeminiFormat(out["type"], format)) {
    out["format"] = format;
  }

  return filterGeminiKeys(out);
}

function isSupportedGeminiFormat(type: unknown, format: string): boolean {
  if (type === "string") return GEMINI_STRING_FORMATS.has(format);
  if (type === "number" || type === "integer") return GEMINI_NUMBER_FORMATS.has(format);
  return false;
}

function carryMeta(target: JsonSchema, source: JsonSchema): void {
  for (const key of ["description", "title"] as const) {
    if (target[key] === undefined && typeof source[key] === "string") target[key] = source[key];
  }
}

function filterGeminiKeys(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (GEMINI_ALLOWED.has(key)) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bedrock Converse — permissive JSON Schema minus structural metadata
// ---------------------------------------------------------------------------

/**
 * Keywords Converse models reject in `toolSpec.inputSchema.json`. The
 * rest of JSON Schema passes through — Converse is far more permissive
 * than Gemini, so a deny-list is both sufficient and lower-risk than
 * projecting onto an allow-list.
 */
const BEDROCK_STRIP: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
]);

/** Project a tool schema onto the Converse `inputSchema.json` subset. */
export function sanitizeBedrockSchema(schema: JsonSchema): JsonSchema {
  return sanitizeBedrockNode(inlineRefs(schema));
}

function sanitizeBedrockNode(node: JsonSchema): JsonSchema {
  const normalised = coalesceOneOf(mergeAllOf(node));
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(normalised)) {
    if (BEDROCK_STRIP.has(key)) continue;
    out[key] = sanitizeBedrockValue(key, value);
  }
  return out;
}

function sanitizeBedrockValue(key: string, value: unknown): unknown {
  if (DATA_KEYWORDS.has(key)) return value; // literal data untouched
  if (Array.isArray(value)) {
    return value.map((item) => (isSchemaObject(item) ? sanitizeBedrockNode(item) : item));
  }
  if (isSchemaObject(value)) return sanitizeBedrockNode(value);
  return value;
}

// ---------------------------------------------------------------------------
// OpenAI — Structured-Outputs strict mode
// ---------------------------------------------------------------------------

/**
 * Keywords that disqualify a schema from strict mode. OpenAI's strict
 * subset has grown over time, but these have no strict representation
 * across model versions, so their presence sends the tool down the
 * non-strict path (rather than risk a 400).
 */
const OPENAI_STRICT_DISQUALIFIERS: ReadonlySet<string> = new Set([
  "allOf",
  "oneOf",
  "not",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
  "if",
  "then",
  "else",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "default",
]);

/**
 * Upgrade a tool schema into OpenAI strict-mode form, or return `null`
 * when it can't be expressed in the strict subset.
 *
 * A qualifying schema is an object-rooted schema whose every node uses
 * only strict-supported keywords. The returned schema has `$ref`s
 * inlined, `additionalProperties: false` on every object, and every
 * property listed in `required` — with properties that were previously
 * optional made nullable (`type: ["T", "null"]`), the documented way to
 * keep a field optional under strict mode.
 */
export function toOpenAIStrictSchema(schema: JsonSchema): JsonSchema | null {
  const inlined = inlineRefs(schema);
  if (!qualifiesForStrict(inlined)) return null;
  return makeStrict(inlined);
}

function qualifiesForStrict(node: JsonSchema): boolean {
  // The strict subset only makes sense for an object-rooted tool schema.
  if (node["type"] !== "object" && !isSchemaObject(node["properties"])) return false;
  return strictNodeOk(node);
}

function strictNodeOk(node: JsonSchema): boolean {
  for (const key of Object.keys(node)) {
    if (OPENAI_STRICT_DISQUALIFIERS.has(key)) return false;
  }
  // Strict mandates `additionalProperties: false`; a free-form object
  // (`true` or a schema) has no strict representation.
  const additional = node["additionalProperties"];
  if (additional === true || isSchemaObject(additional)) return false;

  if (isSchemaObject(node["properties"])) {
    for (const value of Object.values(node["properties"])) {
      if (isSchemaObject(value) && !strictNodeOk(value)) return false;
    }
  }
  if (Array.isArray(node["items"])) return false; // tuple typing is unsupported
  if (isSchemaObject(node["items"]) && !strictNodeOk(node["items"])) return false;
  if (Array.isArray(node["anyOf"])) {
    for (const value of node["anyOf"]) {
      if (isSchemaObject(value) && !strictNodeOk(value)) return false;
    }
  }
  return true;
}

function makeStrict(node: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...node };

  if (isSchemaObject(out["properties"])) {
    const originalRequired = new Set(
      Array.isArray(out["required"])
        ? out["required"].filter((r): r is string => typeof r === "string")
        : [],
    );
    const props: JsonSchema = {};
    const allKeys: string[] = [];
    for (const [key, value] of Object.entries(out["properties"])) {
      allKeys.push(key);
      let child: unknown = isSchemaObject(value) ? makeStrict(value) : value;
      // Strict requires every property in `required`; a property that
      // was optional becomes nullable so omission is still expressible.
      if (isSchemaObject(child) && !originalRequired.has(key)) child = makeNullable(child);
      props[key] = child;
    }
    out["properties"] = props;
    out["required"] = allKeys;
    out["additionalProperties"] = false;
  } else if (out["type"] === "object") {
    out["additionalProperties"] = false;
  }

  if (isSchemaObject(out["items"])) out["items"] = makeStrict(out["items"]);
  if (Array.isArray(out["anyOf"])) {
    out["anyOf"] = out["anyOf"].map((m) => (isSchemaObject(m) ? makeStrict(m) : m));
  }
  return out;
}

function makeNullable(node: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...node };
  const type = out["type"];
  if (typeof type === "string") {
    if (type !== "null") out["type"] = [type, "null"];
  } else if (Array.isArray(type)) {
    if (!type.includes("null")) out["type"] = [...type, "null"];
  } else if (Array.isArray(out["anyOf"])) {
    const hasNull = out["anyOf"].some((m) => isSchemaObject(m) && m["type"] === "null");
    if (!hasNull) out["anyOf"] = [...out["anyOf"], { type: "null" }];
  }
  return out;
}
