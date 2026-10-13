import { type FormatName, checkFormat, isFormatName } from "./formats";
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
 * synchronous. Every subschema evaluation is counted against a budget. So
 * is every check whose cost follows the value's size rather than the
 * schema's — a string's length or pattern, uniqueItems, an object's keys,
 * each enum candidate and each (key, patternProperties pattern) test, and
 * each error message built — so a small schema cannot spend the value's
 * size once per leaf. When the budget runs out the walk stops and the
 * result is `undetermined`, with `valid: false` and the reason — never a
 * verdict either way. A failing branch is summarised in a bounded message,
 * and a message is built only when it will be kept.
 *
 * The default budget ({@link defaultWorkLimit}) follows what an honest walk
 * can cost. A schema written out as a tree (no `$ref` reached twice at one
 * place) evaluates each of its subschemas at most once per value node, so a
 * value node is allowed as many units as the schema has subschemas (at
 * least {@link WORK_PER_VALUE_NODE}, at most {@link MAX_SCHEMA_FANOUT}); a
 * wide or nested union over thousands of valid rows is answered. Only
 * repeating a `$ref` at one place goes past that, which is the shape that
 * multiplies. The floor is {@link DEFAULT_MAX_WORK} and the ceiling
 * {@link MAX_DEFAULT_WORK}, a few seconds of the worst schemas measured.
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
import {
  type RegexAnswers,
  type ScreenedPattern,
  runPatternSync,
  screenCallerPattern,
} from "./regex-answers";
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
  /**
   * Answers for the schema's `pattern` and `patternProperties` regexes,
   * resolved in the worker by the calling tool (see `withRegexAnswers`). A
   * question not answered yet is recorded there and read as "no match" for
   * this pass, which the caller discards and runs again. Without it, each
   * pattern runs on this thread through the bounded fallback.
   */
  regex: RegexAnswers;
};

/** Subschema evaluations allowed and spent; shared by reference. */
export type WorkBudget = { used: number; readonly limit: number };

/** The budget floor: about a third of a second of the worst schemas measured (Apple silicon). */
export const DEFAULT_MAX_WORK = 500_000;
/**
 * The least work allowed per unit of the value's weight, so a large document
 * is not refused for its size. A schema with more subschemas than this is
 * allowed its subschema count instead.
 */
export const WORK_PER_VALUE_NODE = 64;
/** The most work per unit of weight a schema's size earns. */
export const MAX_SCHEMA_FANOUT = 1_024;
/**
 * The most work a default budget allows, however large the value: about
 * seven seconds of the worst schemas measured (Apple silicon, 0.3-0.5 us a
 * unit). The walk is synchronous, so this is how long one call can hold the
 * harness's thread.
 */
export const MAX_DEFAULT_WORK = 20_000_000;
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

/**
 * Subschemas in `schema` written out as a tree, `$ref`s not followed, up to
 * `cap`: what one value node can honestly be checked against. Counted
 * iteratively, since a schema may nest deeper than the stack.
 */
export function schemaFanout(schema: unknown, cap = MAX_SCHEMA_FANOUT): number {
  let count = 0;
  const stack: unknown[] = [schema];
  while (stack.length > 0 && count < cap) {
    const node = stack.pop();
    if (typeof node === "boolean") {
      count += 1;
      continue;
    }
    if (!isPlainObject(node)) continue;
    count += 1;
    for (const keyword of ["properties", "patternProperties", "$defs", "definitions"]) {
      const map = node[keyword];
      if (isPlainObject(map)) for (const key of Object.keys(map)) stack.push(map[key]);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      const list = node[keyword];
      if (Array.isArray(list)) for (const branch of list) stack.push(branch);
    }
    const items = node["items"];
    if (Array.isArray(items)) for (const item of items) stack.push(item);
    else if (items !== undefined) stack.push(items);
    for (const keyword of [
      "additionalItems",
      "additionalProperties",
      "contains",
      "propertyNames",
      "not",
      "if",
      "then",
      "else",
    ]) {
      if (node[keyword] !== undefined) stack.push(node[keyword]);
    }
  }
  return Math.min(count, cap);
}

/**
 * The default budget for validating `value` against `schema`: the value's
 * weight times what the schema allows per unit of it, between
 * DEFAULT_MAX_WORK and MAX_DEFAULT_WORK.
 */
export function defaultWorkLimit(value: unknown, schema?: unknown): number {
  const perUnit = Math.max(
    WORK_PER_VALUE_NODE,
    schema === undefined ? 0 : schemaFanout(schema, MAX_SCHEMA_FANOUT),
  );
  const weighted = valueWeight(value) * perUnit;
  return Math.max(DEFAULT_MAX_WORK, Math.min(weighted, MAX_DEFAULT_WORK));
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
  /**
   * True when `undetermined` is the work budget running out: no pattern
   * answer can change that, so a caller resolving patterns in rounds stops.
   */
  workExhausted: boolean;
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
  /** Where the schema's patterns are answered; see `ValidateOptions.regex`. */
  regex: RegexAnswers | undefined;
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
export const MAX_MESSAGE_CHARS = 1_000;
/** The shortest a branch's reason is cut to before later branches are dropped instead. */
const MIN_REASON_CHARS = 48;

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

/**
 * An enum's candidates, split into a set of its primitive values and a list
 * of the rest. Built once per enum array (a schema's arrays live as long as
 * the call that parsed it), so each value is one set lookup: comparing each
 * value against every candidate cost 20,000 values x 20,000 candidates for
 * nothing but the lengths of the schema and the value.
 */
type EnumIndex = { readonly primitives: Set<unknown>; readonly others: unknown[] };
const enumIndexes = new WeakMap<unknown[], EnumIndex>();

function enumIndex(candidates: unknown[], ctx: Ctx): EnumIndex {
  const known = enumIndexes.get(candidates);
  if (known !== undefined) return known;
  charge(ctx, 1 + Math.floor(candidates.length / MEMBERS_PER_UNIT));
  const primitives = new Set<unknown>();
  const others: unknown[] = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") {
      if (typeof candidate === "string") {
        charge(ctx, Math.floor(candidate.length / CHARS_PER_UNIT));
      }
      primitives.add(candidate);
    } else others.push(candidate);
  }
  const index = { primitives, others };
  enumIndexes.set(candidates, index);
  return index;
}

/** `sameJson(candidate, value)` for some candidate, charged for what it compares. */
function inEnum(candidates: unknown[], value: unknown, ctx: Ctx): boolean {
  const index = enumIndex(candidates, ctx);
  if (value === null || typeof value !== "object") {
    // Hashing a string reads it; everything else is one lookup. A primitive
    // equals only a primitive, and a Set's equality is sameJson's for JSON.
    if (typeof value === "string") charge(ctx, Math.floor(value.length / CHARS_PER_UNIT));
    return index.primitives.has(value);
  }
  charge(ctx, Math.floor(index.others.length / MEMBERS_PER_UNIT));
  return index.others.some((candidate) => sameJson(candidate, value, ctx));
}

/**
 * The patterns of one `patternProperties` map, compiled once per map, not
 * once per object the map is checked on: 4,000 empty objects under 4,000
 * patterns compiled 16 million regexes and charged nothing for it. The
 * compiled list is kept whole, so an object with no keys costs nothing per
 * pattern either; only the invalid ones are looked at again, to report them.
 */
type CompiledPattern = {
  readonly source: string;
  /** Screened for the fallback run on this thread, the first time it is needed. */
  screened?: ScreenedPattern;
};
type CompiledPatterns = {
  readonly valid: ReadonlyArray<CompiledPattern>;
  readonly invalid: ReadonlyArray<{ readonly source: string; readonly error: string }>;
};
const compiledPatterns = new WeakMap<Record<string, unknown>, CompiledPatterns>();

function patternsOf(map: Record<string, unknown>, ctx: Ctx): CompiledPatterns {
  const known = compiledPatterns.get(map);
  if (known !== undefined) return known;
  const valid: CompiledPattern[] = [];
  const invalid: Array<{ source: string; error: string }> = [];
  for (const source of Object.keys(map)) {
    charge(ctx, 1 + Math.floor(source.length / CHARS_PER_UNIT));
    try {
      // Compiling reads only the pattern; the match is what is not run here.
      new RegExp(source);
      valid.push({ source });
    } catch (err) {
      invalid.push({ source, error: (err as Error).message });
    }
  }
  const out = { valid, invalid };
  compiledPatterns.set(map, out);
  return out;
}

/**
 * Does the schema's `pattern` (or a `patternProperties` key) match `input`?
 * The pattern is the caller's, so it is never run here: the answer comes
 * from `ctx.regex`, resolved in the worker, or from the bounded fallback
 * when there is none. A pattern that could not be run to an answer, or that
 * the screen refuses as a shape that backtracks exponentially, leaves the
 * whole result undetermined: the validator reports no verdict rather than
 * "invalid" (or "valid"). A question not answered yet reads as "no match"
 * for this pass; the caller runs the walk again once it is answered.
 */
function patternMatches(
  ctx: Ctx,
  pattern: string,
  input: string,
  where: string,
  compiled?: CompiledPattern,
): boolean {
  // The read is charged by the caller: validateString per string, and
  // validateObject per (key, pattern) test.
  let answer: ReturnType<RegexAnswers["lookup"]>;
  if (ctx.regex !== undefined) {
    answer = ctx.regex.lookup(pattern, "", input);
  } else {
    let screened = compiled?.screened;
    if (screened === undefined) {
      screened = screenCallerPattern(pattern, "");
      if (compiled !== undefined) compiled.screened = screened;
    }
    answer = screened.ok ? runPatternSync(screened.regex, input) : screened.answer;
  }
  if (answer === undefined) return false;
  if (typeof answer === "boolean") return answer;
  const shown = pattern.length > 80 ? `${pattern.slice(0, 79)}…` : pattern;
  if ("refused" in answer) {
    throw new Undetermined(
      `the schema's pattern /${shown}/ at ${where} was not run: ${answer.refused}, so no verdict was reached`,
    );
  }
  throw new Undetermined(
    `the schema's pattern /${shown}/ at ${where} could not be run to an answer: ${answer.undetermined}, so no verdict was reached`,
  );
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
    regex: ctx.regex,
  };
  validateNode(value, schema, "", schemaPath, scratch);
  return scratch.errors;
}

function summarizeBranch(errors: ValidationError[]): string {
  if (errors.length === 0) return "no error";
  const first = errors[0] as ValidationError;
  const where = first.path === "" ? "" : ` at ${first.path}`;
  return `${first.message}${where}`;
}

/**
 * The reasons of every failing alternative, joined, within MAX_MESSAGE_CHARS.
 *
 * When they do not all fit, each is cut to an equal share rather than the
 * last ones dropped, and a reason shorter than its share keeps all of it. A
 * nested union's reason is itself a joined list whose decisive entry is
 * often last: cutting every branch to a fixed 200 characters took
 * `property "chanel_fallback" is not allowed` off the end of the only reason
 * that named the mistake. Past MIN_REASON_CHARS a share, later branches are
 * counted instead of shown.
 */
function joinReasons(reasons: ReadonlyArray<string>): string {
  const room = MAX_MESSAGE_CHARS - 80;
  const separators = 2 * Math.max(0, reasons.length - 1);
  let total = separators;
  for (const reason of reasons) total += reason.length;
  if (total <= room) return reasons.join("; ");
  // How many fit at the shortest share, and the share they each get.
  const shown = Math.max(
    1,
    Math.min(reasons.length, Math.floor((room + 2) / (MIN_REASON_CHARS + 2))),
  );
  const kept = reasons.slice(0, shown);
  // Water-fill: short reasons keep their length, the rest share what is left.
  let left = room - 2 * (kept.length - 1);
  const sorted = kept.map((r) => r.length).sort((a, b) => a - b);
  let share = Math.floor(left / kept.length);
  for (let i = 0; i < sorted.length; i++) {
    const length = sorted[i] as number;
    const fair = Math.floor(left / (sorted.length - i));
    if (length <= fair) {
      left -= length;
      continue;
    }
    share = fair;
    break;
  }
  const out = kept.map((r) => clip(r, Math.max(share, MIN_REASON_CHARS))).join("; ");
  return shown < reasons.length ? `${out} … (+${reasons.length - shown} more)` : out;
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
    let valid = true;
    try {
      // Compiling reads only the pattern; the match is what is not run here.
      new RegExp(pattern);
    } catch (err) {
      valid = false;
      fail(
        ctx,
        path,
        "pattern",
        joinPointer(sp, "pattern"),
        `the schema's pattern is not a valid regular expression: ${(err as Error).message}`,
      );
    }
    if (valid && !patternMatches(ctx, pattern, value, joinPointer(sp, "pattern"))) {
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

  let patterns: CompiledPatterns["valid"] = [];
  if (isPlainObject(patternProperties)) {
    const compiled = patternsOf(patternProperties, ctx);
    patterns = compiled.valid;
    for (const bad of compiled.invalid) {
      fail(
        ctx,
        path,
        "patternProperties",
        joinPointer(joinPointer(sp, "patternProperties"), bad.source),
        `the schema's pattern is not a valid regular expression: ${bad.error}`,
      );
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
    // Every (key, pattern) test is charged: 8,000 keys under 8,000 patterns
    // ran 64 million tests for 11 s and then answered valid.
    if (patterns.length > 0) {
      charge(ctx, patterns.length * (1 + Math.floor(key.length / CHARS_PER_UNIT)));
    }
    for (const compiled of patterns) {
      const source = compiled.source;
      const at = joinPointer(joinPointer(sp, "patternProperties"), source);
      if (!patternMatches(ctx, source, key, at, compiled)) continue;
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
    if (!inEnum(candidates, value, ctx)) {
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
    limit: options.maxWork ?? defaultWorkLimit(value, schema),
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
    regex: options.regex,
  };
  let undetermined: string | null = null;
  let workExhausted = false;
  try {
    validateNode(value, schema, "", "", ctx);
  } catch (err) {
    if (err instanceof WorkExhausted) {
      workExhausted = true;
      undetermined = `the schema needed more than ${work.limit} subschema evaluations for this value, so no verdict was reached — anyOf, oneOf and allOf over shared $refs multiply, and so do many patternProperties over many keys`;
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
    workExhausted,
    errors: ctx.errors,
    truncated: ctx.truncated,
    unsupportedKeywords: [...ctx.unsupported].sort(),
  };
}

/**
 * Why a schema's pattern will not be run, or null: it does not compile, or
 * the caller-pattern screen refuses it (a shape that backtracks
 * exponentially, such as `(a+)+`, or one too long to analyse). Either way
 * the schema is reported as malformed before anything is validated, rather
 * than run and answered "no match" by an engine that gave up.
 */
function refusedPattern(pattern: string): string | null {
  try {
    new RegExp(pattern);
  } catch (err) {
    return (err as Error).message;
  }
  const screened = screenCallerPattern(pattern, "");
  return screened.ok ? null : screened.answer.refused;
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
    const refused = refusedPattern(schema["pattern"]);
    if (refused !== null) problems.push(`${joinPointer(path, "pattern")}: ${refused}`);
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
        const refused = refusedPattern(source);
        if (refused !== null) {
          problems.push(`${joinPointer(joinPointer(path, keyword), source)}: ${refused}`);
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
