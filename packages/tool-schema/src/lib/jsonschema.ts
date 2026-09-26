/**
 * A JSON Schema Draft-07 validator, written out in full here so the package
 * has no runtime dependency and so its behaviour is auditable in one file.
 *
 * ## What is enforced
 *
 * | Group | Keywords |
 * |---|---|
 * | any | `type`, `enum`, `const` |
 * | number | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
 * | string | `minLength`, `maxLength`, `pattern`, `format` (opt-in) |
 * | array | `items` (schema or tuple), `additionalItems`, `contains`, `minItems`, `maxItems`, `uniqueItems` |
 * | object | `properties`, `patternProperties`, `additionalProperties`, `propertyNames`, `required`, `minProperties`, `maxProperties` |
 * | logic | `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else` |
 * | reference | `$ref` to a local JSON Pointer, including `#/$defs/...` and `#/definitions/...` |
 *
 * Boolean schemas (`true` accepts everything, `false` rejects everything) are
 * supported wherever a schema is expected.
 *
 * ## What is NOT enforced
 *
 * - **Annotations**, which carry no constraint and are skipped silently:
 *   `$id`, `$schema`, `$comment`, `title`, `description`, `default`,
 *   `examples`, `readOnly`, `writeOnly`, `deprecated`, `contentMediaType`,
 *   `contentEncoding`, `$defs`, `definitions`.
 * - **`format`**, unless `assertFormat` is set. Draft-07 makes `format` an
 *   annotation by default and this validator follows that; the opt-in uses
 *   the checks in `./formats`, whose subsets are documented there.
 * - **`dependencies` / `dependentRequired` / `dependentSchemas`**,
 *   **`unevaluatedProperties` / `unevaluatedItems`**, the draft-04 boolean
 *   form of `exclusiveMinimum`/`exclusiveMaximum`, and any other keyword not
 *   in the table above. These are never silently dropped: every one
 *   encountered is listed in the result's `unsupportedKeywords`, so a caller
 *   can tell a clean pass from an unenforced one. Note *encountered*: the
 *   list is built while walking, so a keyword sitting in a subschema this
 *   value never reached (a property it does not carry, a `$defs` entry no
 *   `$ref` took) is not in it. Validate a value that exercises the branch to
 *   see its keywords.
 * - **Remote and non-pointer `$ref`** (`http://...`, `other.json#/x`, and
 *   `$id`-relative resolution). A `$ref` this validator cannot resolve
 *   locally is reported as an error rather than treated as `true`.
 *
 * ## Two deliberate deviations, both in the reporting
 *
 * - When `type` fails, the keywords specific to that type are not also run,
 *   so a number arriving where an object belongs produces one error rather
 *   than one per property. The verdict is identical; only the error list is
 *   shorter. `allOf`/`anyOf`/`oneOf`/`not` still run, since those can fail
 *   independently of the type.
 * - Errors stop accumulating at `maxErrors`, and the result says `truncated`.
 *
 * ## A bounded amount of work, and "undetermined" when it runs out
 *
 * `anyOf`/`oneOf`/`allOf` over `$ref`s that share a target multiply: a
 * 1.3 KB schema can ask for 2^30 subschema evaluations, and the walk is
 * synchronous. Every subschema evaluation is counted against a budget
 * (`maxWork`; by default the larger of {@link DEFAULT_MAX_WORK} and
 * {@link WORK_PER_VALUE_NODE} per unit of the value's weight: a node, or
 * 256 characters of a string or key). So is every check whose cost follows
 * the value's size rather than the schema's — a string's length or
 * pattern, uniqueItems, an object's keys, an enum or const comparison, and
 * each error message built — so a small schema cannot spend the value's
 * size once per leaf. When the budget runs out the walk stops and the
 * result is `undetermined`, with `valid: false` and the reason — never a
 * verdict either way. A failing branch is summarised in a bounded message,
 * and a message is built only when it will be kept.
 *
 * ## Depth is the value's
 *
 * A recursive schema walks as deep as the value does, so nesting is counted
 * where the value nests — into an item or a property — not per `$ref` or
 * branch. A value deeper than {@link MAX_VALUE_DEPTH}, or a schema and value
 * nesting past {@link MAX_NESTING} walk frames together, is `undetermined`:
 * the part not walked may be valid or not. A `$ref` that reaches itself at
 * one position with nothing consumed between is a cycle, and an error.
 *
 * `pattern` is an unanchored ECMA-262 match, per the spec — `"pattern": "a"`
 * matches `"banana"`.
 */
import { type FormatName, checkFormat, isFormatName } from "./formats";
import {
  type JsonType,
  type PreviewCache,
  canonicalize,
  isPlainObject,
  joinPointer,
  matchesType,
  parsePointer,
  preview as previewValue,
  resolveSegments,
  typeOf,
} from "./value";

/** A schema is an object of keywords, or a boolean that accepts/rejects all. */
export type Schema = boolean | Record<string, unknown>;

/** One failure, addressed by a JSON Pointer into the value. */
export type ValidationError = {
  /** JSON Pointer to the offending value; `""` is the whole document. */
  path: string;
  /** The keyword that rejected it. */
  keyword: string;
  /** A message written for a person reading a failed gate. */
  message: string;
  /** JSON Pointer to the keyword inside the schema. */
  schemaPath: string;
};

export type ValidateOptions = {
  /** Enforce `format` instead of treating it as an annotation. */
  assertFormat: boolean;
  /** Stop collecting after this many errors. */
  maxErrors: number;
  /**
   * Most subschema evaluations before the answer is `undetermined`. Default:
   * the larger of DEFAULT_MAX_WORK and WORK_PER_VALUE_NODE per value node.
   */
  maxWork: number;
  /**
   * A budget shared with other calls (ValidateRecords draws every row from
   * one). When given, `maxWork` is ignored.
   */
  budget: WorkBudget;
};

/** Subschema evaluations allowed and spent; shared by reference. */
export type WorkBudget = { used: number; readonly limit: number };

/** The budget floor: about a third of a second of the worst schemas measured (Apple silicon). */
export const DEFAULT_MAX_WORK = 500_000;
/** Work allowed per unit of the value's weight, so a large document is not refused for its size. */
export const WORK_PER_VALUE_NODE = 64;
/** Characters of a string (or key) that weigh, and cost, one unit. */
const CHARS_PER_UNIT = 256;
/** Keys or items that cost one unit to list or compare. */
const MEMBERS_PER_UNIT = 16;

/** Nodes in a JSON value (itself included), counted iteratively, stopping at `cap`. */
export function countValueNodes(value: unknown, cap = Number.MAX_SAFE_INTEGER): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0 && count < cap) {
    const node = stack.pop();
    count++;
    if (Array.isArray(node)) for (const item of node) stack.push(item);
    else if (isPlainObject(node)) for (const key of Object.keys(node)) stack.push(node[key]);
  }
  return count;
}

/**
 * A value's weight: one per node, and one more per CHARS_PER_UNIT
 * characters of each string and key — the size the size-bound checks are
 * charged in, so the budget grows with the value in the same units.
 */
export function valueWeight(value: unknown): number {
  let weight = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    weight += 1;
    if (typeof node === "string") weight += Math.floor(node.length / CHARS_PER_UNIT);
    else if (Array.isArray(node)) for (const item of node) stack.push(item);
    else if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        weight += Math.floor(key.length / CHARS_PER_UNIT);
        stack.push(node[key]);
      }
    }
  }
  return weight;
}

/** The default budget for validating `value`. */
export function defaultWorkLimit(value: unknown): number {
  const floor = Math.ceil(DEFAULT_MAX_WORK / WORK_PER_VALUE_NODE);
  const weight = valueWeight(value);
  return weight <= floor ? DEFAULT_MAX_WORK : weight * WORK_PER_VALUE_NODE;
}

export type ValidationResult = {
  /** Never true when `undetermined` is set. */
  valid: boolean;
  /**
   * Why no verdict could be reached, or null when `valid` is the verdict.
   * Set when the work budget ran out: the errors listed are the ones found
   * before it did, and the value may be valid or invalid.
   */
  undetermined: string | null;
  errors: ValidationError[];
  /** True when `maxErrors` cut the list short. */
  truncated: boolean;
  /**
   * Constraint keywords this validator does not enforce, from the subschemas
   * it actually walked for this value — not a static scan of the whole
   * document. Sorted, so the result is stable.
   */
  unsupportedKeywords: string[];
};

/** Keywords that constrain a value and are implemented here. */
const SUPPORTED = new Set([
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "items",
  "additionalItems",
  "contains",
  "minItems",
  "maxItems",
  "uniqueItems",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "required",
  "minProperties",
  "maxProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
]);

/** Keywords that carry no constraint; skipping them changes nothing. */
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

/** Deepest value the walk follows; past it the answer is undetermined. */
export const MAX_VALUE_DEPTH = 512;
/**
 * Most walk frames (a subschema evaluation inside another) at once, value
 * and schema nesting together; past it the answer is undetermined. It keeps
 * a deeply nested schema from overflowing the stack.
 */
export const MAX_NESTING = 2_048;
/** How deep `checkSchemaShape` descends; it only guards a hand-built cyclic object. */
const MAX_SHAPE_DEPTH = 100;

type Ctx = {
  root: Schema;
  opts: Pick<ValidateOptions, "assertFormat" | "maxErrors">;
  errors: ValidationError[];
  truncated: boolean;
  unsupported: Set<string>;
  /** `$ref`s entered and not yet left, each at its absolute position. */
  refs: Set<string>;
  /**
   * Where this context's `path` "" sits in the whole value. A branch is
   * validated in a scratch context whose paths restart at "" (so its
   * messages read relative to the branch), but the `$ref` cycle marker must
   * be absolute: two levels of one recursive schema reach the same `$ref`
   * at different places, and keyed on the relative path they collided, so a
   * valid recursive value was reported as a cycle.
   */
  refBase: string;
  /** Items and properties descended into. */
  valueDepth: number;
  /** Subschema evaluations open, one inside another. */
  nesting: number;
  work: WorkBudget;
  /** Previews of the value's objects, reused across the walk. */
  previews: PreviewCache;
};

/** Thrown when the work budget runs out; caught only in `validateValue`. */
class WorkExhausted extends Error {}

/** Thrown when the walk cannot reach a verdict for another reason; caught only in `validateValue`. */
class Undetermined extends Error {}

/** Where in the whole value `path` is, for a message. */
function where(ctx: Ctx, path: string): string {
  const absolute = `${ctx.refBase}${path}`;
  return absolute === "" ? "the top" : clip(absolute, 120);
}

/** Spend `units` of the budget, stopping the walk once it is gone. */
function charge(ctx: Ctx, units: number): void {
  ctx.work.used += units;
  if (ctx.work.used > ctx.work.limit) throw new WorkExhausted();
}

/** A bounded preview, reusing the walk's renderings of the value's objects. */
function preview(ctx: Ctx, value: unknown, maxChars: number): string {
  return previewValue(value, maxChars, ctx.previews);
}

/** Longest message one error carries; nested branch reasons are cut here. */
const MAX_MESSAGE_CHARS = 1_000;
/** Longest summary of one failing branch inside an anyOf/oneOf message. */
const MAX_BRANCH_SUMMARY_CHARS = 200;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Record a failure. The message is built only when it will be kept: past
 * `maxErrors` a failure costs nothing to report, and one that is kept is
 * charged for the text it builds.
 */
function fail(
  ctx: Ctx,
  path: string,
  keyword: string,
  schemaPath: string,
  message: string | (() => string),
): false {
  if (ctx.errors.length >= ctx.opts.maxErrors) {
    ctx.truncated = true;
    return false;
  }
  const text = clip(typeof message === "string" ? message : message(), MAX_MESSAGE_CHARS);
  charge(ctx, 1 + Math.floor(text.length / 512));
  ctx.errors.push({ path, keyword, message: text, schemaPath });
  return false;
}

/** Code points in `text`, counted without building an array of them. */
function codePointLength(text: string): number {
  let length = text.length;
  for (let i = 0; i < text.length - 1; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length -= 1;
        i += 1;
      }
    }
  }
  return length;
}

/**
 * `deepEqual`, charged for what it reads: listing an object's keys and
 * comparing long strings cost the value's size, not the schema's.
 */
function sameJson(a: unknown, b: unknown, ctx: Ctx): boolean {
  if (typeof a === "string" && typeof b === "string") {
    charge(ctx, Math.floor(Math.min(a.length, b.length) / CHARS_PER_UNIT));
    return a === b;
  }
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    charge(ctx, Math.floor(a.length / MEMBERS_PER_UNIT));
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i], ctx)) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    charge(ctx, Math.floor((aKeys.length + bKeys.length) / MEMBERS_PER_UNIT));
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k], ctx));
  }
  return false;
}

/** Does `schema` reject `value`? Runs in a scratch context so no errors leak. */
function branchErrors(
  value: unknown,
  schema: Schema,
  ctx: Ctx,
  path: string,
  schemaPath: string,
): ValidationError[] {
  const scratch: Ctx = {
    root: ctx.root,
    opts: { assertFormat: ctx.opts.assertFormat, maxErrors: 20 },
    errors: [],
    truncated: false,
    unsupported: ctx.unsupported,
    refs: ctx.refs,
    refBase: `${ctx.refBase}${path}`,
    valueDepth: ctx.valueDepth,
    nesting: ctx.nesting,
    work: ctx.work,
    previews: ctx.previews,
  };
  validateNode(value, schema, "", schemaPath, scratch);
  return scratch.errors;
}

function summarizeBranch(errors: ValidationError[]): string {
  if (errors.length === 0) return "no error";
  const first = errors[0] as ValidationError;
  const where = first.path === "" ? "" : ` at ${first.path}`;
  return clip(`${first.message}${where}`, MAX_BRANCH_SUMMARY_CHARS);
}

/** The reasons of every failing alternative, joined, within MAX_MESSAGE_CHARS. */
function joinReasons(reasons: ReadonlyArray<string>): string {
  let out = "";
  for (let i = 0; i < reasons.length; i++) {
    const next = out === "" ? (reasons[i] as string) : `${out}; ${reasons[i]}`;
    if (next.length > MAX_MESSAGE_CHARS - 40) {
      return `${out} … (+${reasons.length - i} more)`;
    }
    out = next;
  }
  return out;
}

function validateNumber(
  value: number,
  schema: Record<string, unknown>,
  path: string,
  sp: string,
  ctx: Ctx,
): void {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema;
  if (typeof minimum === "number" && value < minimum) {
    fail(
      ctx,
      path,
      "minimum",
      joinPointer(sp, "minimum"),
      `${value} is below the minimum of ${minimum}`,
    );
  }
  if (typeof maximum === "number" && value > maximum) {
    fail(
      ctx,
      path,
      "maximum",
      joinPointer(sp, "maximum"),
      `${value} is above the maximum of ${maximum}`,
    );
  }
  if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
    fail(
      ctx,
      path,
      "exclusiveMinimum",
      joinPointer(sp, "exclusiveMinimum"),
      `${value} must be greater than ${exclusiveMinimum}`,
    );
  }
  if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
    fail(
      ctx,
      path,
      "exclusiveMaximum",
      joinPointer(sp, "exclusiveMaximum"),
      `${value} must be less than ${exclusiveMaximum}`,
    );
  }
  if (typeof multipleOf === "number" && multipleOf > 0) {
    // Two integers divide exactly in floating point, so `%` is both correct
    // and free of the tolerance below. Taking this path matters beyond
    // tidiness: once the quotient passes 2^53 every double is an integer, so
    // the tolerance test would call 1e20 a multiple of 7.
    const exact = Number.isInteger(value) && Number.isInteger(multipleOf);
    const quotient = value / multipleOf;
    // Binary floating point makes an exact remainder test unreliable for
    // fractions (0.3 / 0.1 is 2.9999...), so there the quotient is compared
    // to its nearest integer within a tolerance.
    const off = exact ? value % multipleOf !== 0 : Math.abs(quotient - Math.round(quotient)) > 1e-9;
    if (off) {
      fail(
        ctx,
        path,
        "multipleOf",
        joinPointer(sp, "multipleOf"),
        `${value} is not a multiple of ${multipleOf}`,
      );
    }
  }
}

function validateString(
  value: string,
  schema: Record<string, unknown>,
  path: string,
  sp: string,
  ctx: Ctx,
): void {
  const { minLength, maxLength, pattern, format } = schema;
  const checksLength = typeof minLength === "number" || typeof maxLength === "number";
  const checksFormat = typeof format === "string" && ctx.opts.assertFormat;
  // Each of these reads the whole string, so each is charged for its length.
  const reads =
    (checksLength ? 1 : 0) + (typeof pattern === "string" ? 1 : 0) + (checksFormat ? 1 : 0);
  if (reads > 0) charge(ctx, reads * Math.floor(value.length / CHARS_PER_UNIT));
  // Length is counted in code points, as the spec requires, so an emoji
  // counts as one character rather than as its two UTF-16 units.
  const length = checksLength ? codePointLength(value) : 0;
  if (typeof minLength === "number" && length < minLength) {
    fail(
      ctx,
      path,
      "minLength",
      joinPointer(sp, "minLength"),
      `length ${length} is under the minimum of ${minLength}`,
    );
  }
  if (typeof maxLength === "number" && length > maxLength) {
    fail(
      ctx,
      path,
      "maxLength",
      joinPointer(sp, "maxLength"),
      `length ${length} is over the maximum of ${maxLength}`,
    );
  }
  if (typeof pattern === "string") {
    let re: RegExp | null = null;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      fail(
        ctx,
        path,
        "pattern",
        joinPointer(sp, "pattern"),
        `the schema's pattern is not a valid regular expression: ${(err as Error).message}`,
      );
    }
    if (re !== null && !re.test(value)) {
      fail(
        ctx,
        path,
        "pattern",
        joinPointer(sp, "pattern"),
        () => `${preview(ctx, value, 60)} does not match /${pattern}/`,
      );
    }
  }
  if (typeof format === "string" && ctx.opts.assertFormat) {
    if (!isFormatName(format)) {
      ctx.unsupported.add(`format:${format}`);
    } else {
      const result = checkFormat(value, format as FormatName);
      if (!result.valid) {
        fail(
          ctx,
          path,
          "format",
          joinPointer(sp, "format"),
          () => `${preview(ctx, value, 60)} is not a valid ${format}: ${result.reason}`,
        );
      }
    }
  }
}

function validateArray(
  value: unknown[],
  schema: Record<string, unknown>,
  path: string,
  sp: string,
  ctx: Ctx,
): void {
  const { items, additionalItems, contains, minItems, maxItems, uniqueItems } = schema;
  if (typeof minItems === "number" && value.length < minItems) {
    fail(
      ctx,
      path,
      "minItems",
      joinPointer(sp, "minItems"),
      `${value.length} items, fewer than ${minItems}`,
    );
  }
  if (typeof maxItems === "number" && value.length > maxItems) {
    fail(
      ctx,
      path,
      "maxItems",
      joinPointer(sp, "maxItems"),
      `${value.length} items, more than ${maxItems}`,
    );
  }
  if (uniqueItems === true) {
    const seen = new Map<string, number>();
    for (let i = 0; i < value.length; i++) {
      const key = canonicalize(value[i]);
      // An item's canonical form is as long as the item: charged per item.
      charge(ctx, 1 + Math.floor(key.length / CHARS_PER_UNIT));
      const previous = seen.get(key);
      if (previous !== undefined) {
        fail(
          ctx,
          path,
          "uniqueItems",
          joinPointer(sp, "uniqueItems"),
          () => `items ${previous} and ${i} are equal (${preview(ctx, value[i], 60)})`,
        );
        break;
      }
      seen.set(key, i);
    }
  }
  ctx.valueDepth += 1;
  if (Array.isArray(items)) {
    // Tuple form: schema i applies to item i; the rest fall to additionalItems.
    for (let i = 0; i < value.length; i++) {
      const itemSchema = items[i];
      if (itemSchema !== undefined) {
        validateNode(
          value[i],
          itemSchema as Schema,
          joinPointer(path, i),
          joinPointer(joinPointer(sp, "items"), i),
          ctx,
        );
      } else if (additionalItems === false) {
        // Named here rather than left to the generic `false` schema, so the
        // error's keyword matches the one the schema author wrote — the same
        // courtesy `additionalProperties: false` already gets.
        fail(
          ctx,
          joinPointer(path, i),
          "additionalItems",
          joinPointer(sp, "additionalItems"),
          `item ${i} is beyond the ${items.length} the tuple describes, and additionalItems is false`,
        );
      } else if (additionalItems !== undefined) {
        validateNode(
          value[i],
          additionalItems as Schema,
          joinPointer(path, i),
          joinPointer(sp, "additionalItems"),
          ctx,
        );
      }
    }
  } else if (items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      validateNode(value[i], items as Schema, joinPointer(path, i), joinPointer(sp, "items"), ctx);
    }
  }
  if (contains !== undefined) {
    const matched = value.some(
      (item, i) =>
        branchErrors(
          item,
          contains as Schema,
          ctx,
          joinPointer(path, i),
          joinPointer(sp, "contains"),
        ).length === 0,
    );
    if (!matched) {
      ctx.valueDepth -= 1;
      fail(
        ctx,
        path,
        "contains",
        joinPointer(sp, "contains"),
        "no item matches the contains schema",
      );
      return;
    }
  }
  ctx.valueDepth -= 1;
}

function validateObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
  sp: string,
  ctx: Ctx,
): void {
  const {
    properties,
    patternProperties,
    additionalProperties,
    propertyNames,
    required,
    minProperties,
    maxProperties,
  } = schema;
  const keys = Object.keys(value);
  // Listing the keys, and the loop over them below, cost the object's size.
  charge(ctx, Math.floor(keys.length / MEMBERS_PER_UNIT));

  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) {
        fail(
          ctx,
          path,
          "required",
          joinPointer(sp, "required"),
          `required property "${key}" is missing`,
        );
      }
    }
  }
  if (typeof minProperties === "number" && keys.length < minProperties) {
    fail(
      ctx,
      path,
      "minProperties",
      joinPointer(sp, "minProperties"),
      `${keys.length} properties, fewer than ${minProperties}`,
    );
  }
  if (typeof maxProperties === "number" && keys.length > maxProperties) {
    fail(
      ctx,
      path,
      "maxProperties",
      joinPointer(sp, "maxProperties"),
      `${keys.length} properties, more than ${maxProperties}`,
    );
  }
  ctx.valueDepth += 1;
  if (propertyNames !== undefined) {
    for (const key of keys) {
      const errors = branchErrors(
        key,
        propertyNames as Schema,
        ctx,
        joinPointer(path, key),
        joinPointer(sp, "propertyNames"),
      );
      if (errors.length > 0) {
        fail(
          ctx,
          joinPointer(path, key),
          "propertyNames",
          joinPointer(sp, "propertyNames"),
          `property name "${key}" is not allowed: ${summarizeBranch(errors)}`,
        );
      }
    }
  }

  const patterns: Array<[string, RegExp]> = [];
  if (isPlainObject(patternProperties)) {
    for (const source of Object.keys(patternProperties)) {
      try {
        patterns.push([source, new RegExp(source)]);
      } catch (err) {
        fail(
          ctx,
          path,
          "patternProperties",
          joinPointer(joinPointer(sp, "patternProperties"), source),
          `the schema's pattern is not a valid regular expression: ${(err as Error).message}`,
        );
      }
    }
  }

  for (const key of keys) {
    let covered = false;
    if (isPlainObject(properties) && Object.hasOwn(properties, key)) {
      covered = true;
      validateNode(
        value[key],
        properties[key] as Schema,
        joinPointer(path, key),
        joinPointer(joinPointer(sp, "properties"), key),
        ctx,
      );
    }
    for (const [source, re] of patterns) {
      if (!re.test(key)) continue;
      covered = true;
      validateNode(
        value[key],
        (patternProperties as Record<string, unknown>)[source] as Schema,
        joinPointer(path, key),
        joinPointer(joinPointer(sp, "patternProperties"), source),
        ctx,
      );
    }
    if (covered || additionalProperties === undefined) continue;
    if (additionalProperties === false) {
      fail(
        ctx,
        joinPointer(path, key),
        "additionalProperties",
        joinPointer(sp, "additionalProperties"),
        `property "${key}" is not allowed here`,
      );
      continue;
    }
    if (additionalProperties !== true) {
      validateNode(
        value[key],
        additionalProperties as Schema,
        joinPointer(path, key),
        joinPointer(sp, "additionalProperties"),
        ctx,
      );
    }
  }
  ctx.valueDepth -= 1;
}

function validateLogic(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  sp: string,
  ctx: Ctx,
): void {
  const { allOf, anyOf, oneOf, not } = schema;
  if (Array.isArray(allOf)) {
    for (let i = 0; i < allOf.length; i++) {
      validateNode(value, allOf[i] as Schema, path, joinPointer(joinPointer(sp, "allOf"), i), ctx);
    }
  }
  if (Array.isArray(anyOf)) {
    const reasons: string[] = [];
    let anyPassed = false;
    for (let i = 0; i < anyOf.length && !anyPassed; i++) {
      const errors = branchErrors(
        value,
        anyOf[i] as Schema,
        ctx,
        path,
        joinPointer(joinPointer(sp, "anyOf"), i),
      );
      if (errors.length === 0) anyPassed = true;
      else reasons.push(`[${i}] ${summarizeBranch(errors)}`);
    }
    if (!anyPassed) {
      fail(
        ctx,
        path,
        "anyOf",
        joinPointer(sp, "anyOf"),
        `matched none of the ${anyOf.length} alternatives — ${joinReasons(reasons)}`,
      );
    }
  }
  if (Array.isArray(oneOf)) {
    const passing: number[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < oneOf.length; i++) {
      const errors = branchErrors(
        value,
        oneOf[i] as Schema,
        ctx,
        path,
        joinPointer(joinPointer(sp, "oneOf"), i),
      );
      if (errors.length === 0) passing.push(i);
      else reasons.push(`[${i}] ${summarizeBranch(errors)}`);
    }
    if (passing.length === 0) {
      fail(
        ctx,
        path,
        "oneOf",
        joinPointer(sp, "oneOf"),
        `matched none of the ${oneOf.length} alternatives — ${joinReasons(reasons)}`,
      );
    } else if (passing.length > 1) {
      fail(
        ctx,
        path,
        "oneOf",
        joinPointer(sp, "oneOf"),
        `matched ${passing.length} alternatives (${passing.join(", ")}) but oneOf allows exactly one`,
      );
    }
  }
  if (not !== undefined) {
    if (branchErrors(value, not as Schema, ctx, path, joinPointer(sp, "not")).length === 0) {
      fail(ctx, path, "not", joinPointer(sp, "not"), "matched a schema it must not match");
    }
  }
  if (schema["if"] !== undefined) {
    const conditionHolds =
      branchErrors(value, schema["if"] as Schema, ctx, path, joinPointer(sp, "if")).length === 0;
    const branch = conditionHolds ? schema["then"] : schema["else"];
    if (branch !== undefined) {
      validateNode(
        value,
        branch as Schema,
        path,
        joinPointer(sp, conditionHolds ? "then" : "else"),
        ctx,
      );
    }
  }
}

/** Resolve a local `$ref`. Returns the schema, or a message saying why not. */
function resolveRef(ref: string, ctx: Ctx): { schema: Schema } | { error: string } {
  if (!ref.startsWith("#")) {
    return {
      error: `only local $ref is supported, and "${ref}" points elsewhere — inline the target or use #/$defs/...`,
    };
  }
  let segments: string[];
  try {
    segments = parsePointer(ref);
  } catch (err) {
    return { error: `$ref "${ref}" is not a JSON Pointer: ${(err as Error).message}` };
  }
  const found = resolveSegments(ctx.root, segments);
  if (!found.found) return { error: `$ref "${ref}" does not resolve inside this schema` };
  const target = found.value;
  if (typeof target !== "boolean" && !isPlainObject(target)) {
    return { error: `$ref "${ref}" resolves to a ${typeOf(target)}, which is not a schema` };
  }
  return { schema: target as Schema };
}

/** Validate one value against one schema, appending any failures to `ctx`. */
function validateNode(value: unknown, schema: Schema, path: string, sp: string, ctx: Ctx): void {
  charge(ctx, 1);
  if (ctx.valueDepth > MAX_VALUE_DEPTH) {
    throw new Undetermined(
      `the value nests deeper than ${MAX_VALUE_DEPTH} levels (at ${where(ctx, path)}), and nothing below that was checked`,
    );
  }
  if (ctx.nesting >= MAX_NESTING) {
    throw new Undetermined(
      `the schema and value nest past ${MAX_NESTING} checks inside one another (at ${where(ctx, path)}), and nothing below that was checked`,
    );
  }
  ctx.nesting += 1;
  try {
    checkNode(value, schema, path, sp, ctx);
  } finally {
    ctx.nesting -= 1;
  }
}

function checkNode(value: unknown, schema: Schema, path: string, sp: string, ctx: Ctx): void {
  if (schema === true) return;
  if (schema === false) {
    fail(ctx, path, "false", sp, "this position accepts no value at all");
    return;
  }
  if (!isPlainObject(schema)) {
    fail(ctx, path, "schema", sp, `expected a schema object or boolean, found ${typeOf(schema)}`);
    return;
  }

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword) && !ANNOTATIONS.has(keyword)) ctx.unsupported.add(keyword);
  }
  // Draft-04 wrote exclusive bounds as booleans beside minimum/maximum; that
  // form means something different and is not enforced here.
  if (typeof schema["exclusiveMinimum"] === "boolean")
    ctx.unsupported.add("exclusiveMinimum (boolean form)");
  if (typeof schema["exclusiveMaximum"] === "boolean")
    ctx.unsupported.add("exclusiveMaximum (boolean form)");

  // Draft-07: a `$ref` replaces its sibling keywords entirely.
  if (typeof schema["$ref"] === "string") {
    const ref = schema["$ref"];
    // Keyed on the ABSOLUTE instance position: the same $ref twice at one
    // place in the value, with nothing consumed between, is a real cycle.
    const marker = `${ref}@${ctx.refBase}${path}`;
    if (ctx.refs.has(marker)) {
      fail(ctx, path, "$ref", joinPointer(sp, "$ref"), `$ref "${ref}" cycles at this position`);
      return;
    }
    const resolved = resolveRef(ref, ctx);
    if ("error" in resolved) {
      fail(ctx, path, "$ref", joinPointer(sp, "$ref"), resolved.error);
      return;
    }
    ctx.refs.add(marker);
    try {
      validateNode(value, resolved.schema, path, ref, ctx);
    } finally {
      ctx.refs.delete(marker);
    }
    return;
  }

  const actual: JsonType = typeOf(value);

  const declared = schema["type"];
  if (typeof declared === "string" || Array.isArray(declared)) {
    const allowed = (Array.isArray(declared) ? declared : [declared]).filter(
      (t): t is string => typeof t === "string",
    );
    if (allowed.length > 0 && !allowed.some((t) => matchesType(actual, t))) {
      fail(
        ctx,
        path,
        "type",
        joinPointer(sp, "type"),
        () => `expected ${allowed.join(" or ")}, found ${actual} (${preview(ctx, value, 60)})`,
      );
      // A wrong type makes every type-specific keyword below noise.
      validateLogic(value, schema, path, sp, ctx);
      return;
    }
  }

  if (Array.isArray(schema["enum"])) {
    const candidates = schema["enum"];
    if (!candidates.some((candidate) => sameJson(candidate, value, ctx))) {
      fail(
        ctx,
        path,
        "enum",
        joinPointer(sp, "enum"),
        () => `${preview(ctx, value, 60)} is not one of ${preview(ctx, candidates, 120)}`,
      );
    }
  }
  if (Object.hasOwn(schema, "const") && !sameJson(schema["const"], value, ctx)) {
    fail(
      ctx,
      path,
      "const",
      joinPointer(sp, "const"),
      () => `expected ${preview(ctx, schema["const"], 60)}, found ${preview(ctx, value, 60)}`,
    );
  }

  if (typeof value === "number") validateNumber(value, schema, path, sp, ctx);
  else if (typeof value === "string") validateString(value, schema, path, sp, ctx);
  else if (Array.isArray(value)) validateArray(value, schema, path, sp, ctx);
  else if (isPlainObject(value)) validateObject(value, schema, path, sp, ctx);
  validateLogic(value, schema, path, sp, ctx);
}

/**
 * Validate `value` against `schema`, returning every failure with a JSON
 * Pointer path. See the module comment for the exact supported subset; the
 * result's `unsupportedKeywords` names anything in the schema that this
 * validator did not enforce, so a pass can be read honestly.
 */
export function validateValue(
  value: unknown,
  schema: Schema,
  options: Partial<ValidateOptions> = {},
): ValidationResult {
  const work: WorkBudget = options.budget ?? {
    used: 0,
    limit: options.maxWork ?? defaultWorkLimit(value),
  };
  const ctx: Ctx = {
    root: schema,
    opts: { assertFormat: options.assertFormat ?? false, maxErrors: options.maxErrors ?? 100 },
    errors: [],
    truncated: false,
    unsupported: new Set<string>(),
    refs: new Set<string>(),
    refBase: "",
    valueDepth: 0,
    nesting: 0,
    work,
    previews: new WeakMap(),
  };
  let undetermined: string | null = null;
  try {
    validateNode(value, schema, "", "", ctx);
  } catch (err) {
    if (err instanceof WorkExhausted) {
      undetermined = `the schema needed more than ${work.limit} subschema evaluations for this value, so no verdict was reached — anyOf, oneOf and allOf over shared $refs multiply`;
    } else if (err instanceof Undetermined) {
      undetermined = err.message;
    } else if (err instanceof RangeError && /call stack/i.test(err.message)) {
      // The caps above stop the walk first on the shapes measured; a value
      // item compared whole (uniqueItems) can still nest past the stack.
      undetermined =
        "the schema or value nests too deep for this validator to walk, so no verdict was reached";
    } else {
      throw err;
    }
  }
  return {
    valid: undetermined === null && ctx.errors.length === 0,
    undetermined,
    errors: ctx.errors,
    truncated: ctx.truncated,
    unsupportedKeywords: [...ctx.unsupported].sort(),
  };
}

/**
 * A structural sanity check on the schema itself, run before validation so a
 * typo like `{"type": "sting"}` is reported as a bad schema rather than as
 * every value being wrong. Returns the problems found; an empty array means
 * the schema is well formed as far as this validator is concerned.
 *
 * Every position where the spec expects a subschema is descended into,
 * including `$defs` and `definitions` — a typo in a definition is invisible
 * at the top level and rejects every value that reaches it through a `$ref`,
 * which is exactly the failure this check exists to catch.
 */
export function checkSchemaShape(schema: unknown, path = "", depth = 0): string[] {
  const problems: string[] = [];
  if (typeof schema === "boolean") return problems;
  if (!isPlainObject(schema)) {
    problems.push(`${path || "/"}: expected a schema object or boolean, found ${typeOf(schema)}`);
    return problems;
  }
  // A schema is finite JSON, so this only guards against a hand-built cyclic
  // object; it costs nothing and cannot be hit by a parsed document.
  if (depth > MAX_SHAPE_DEPTH) return problems;

  const validTypes = ["null", "boolean", "object", "array", "number", "string", "integer"];
  const declared = schema["type"];
  const declaredList = Array.isArray(declared)
    ? declared
    : declared === undefined
      ? []
      : [declared];
  for (const t of declaredList) {
    if (typeof t !== "string" || !validTypes.includes(t)) {
      problems.push(`${joinPointer(path, "type")}: "${String(t)}" is not a JSON Schema type`);
    }
  }
  if (Object.hasOwn(schema, "enum") && !Array.isArray(schema["enum"])) {
    problems.push(`${joinPointer(path, "enum")}: enum must be an array`);
  }
  if (Object.hasOwn(schema, "required")) {
    const required = schema["required"];
    if (!Array.isArray(required)) {
      problems.push(
        `${joinPointer(path, "required")}: required must be an array of property names`,
      );
    } else {
      // A non-string entry is silently ignored during validation, so a
      // `required: [{"name": "id"}]` would claim to require nothing.
      required.forEach((name, i) => {
        if (typeof name !== "string") {
          problems.push(
            `${joinPointer(joinPointer(path, "required"), i)}: "${String(name)}" is not a property name`,
          );
        }
      });
    }
  }
  if (typeof schema["pattern"] === "string") {
    try {
      new RegExp(schema["pattern"]);
    } catch (err) {
      problems.push(`${joinPointer(path, "pattern")}: ${(err as Error).message}`);
    }
  }

  const descend = (child: unknown, childPath: string): void => {
    problems.push(...checkSchemaShape(child, childPath, depth + 1));
  };

  // Keyword values that are a map of name to subschema.
  for (const keyword of ["properties", "patternProperties", "$defs", "definitions"]) {
    const map = schema[keyword];
    if (!isPlainObject(map)) continue;
    if (keyword === "patternProperties") {
      for (const source of Object.keys(map)) {
        try {
          new RegExp(source);
        } catch (err) {
          problems.push(
            `${joinPointer(joinPointer(path, keyword), source)}: ${(err as Error).message}`,
          );
        }
      }
    }
    for (const key of Object.keys(map)) {
      descend(map[key], joinPointer(joinPointer(path, keyword), key));
    }
  }

  // Keyword values that are a single subschema, or (for `items`) a tuple.
  for (const keyword of [
    "items",
    "additionalItems",
    "additionalProperties",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ]) {
    const child = schema[keyword];
    if (child === undefined) continue;
    if (keyword === "items" && Array.isArray(child)) {
      child.forEach((item, i) => descend(item, joinPointer(joinPointer(path, keyword), i)));
      continue;
    }
    descend(child, joinPointer(path, keyword));
  }

  // Keyword values that are an array of subschemas.
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, i) => descend(branch, joinPointer(joinPointer(path, keyword), i)));
  }
  return problems;
}
