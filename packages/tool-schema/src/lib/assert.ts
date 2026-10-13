/**
 * Declarative assertions: a list of checks, a value, and a verdict.
 *
 * This is the gate a model-free step stands on. The point is that the
 * *decision* — escalate or not, fail the run or not — comes out of data the
 * operator wrote, evaluated the same way every time, with a report that says
 * which check failed and what it saw instead. Nothing here interprets; it
 * only compares.
 */
import { checkFormat, isFormatName } from "./formats";
import { type RegexAnswer, type RegexAnswers, testPatternSync } from "./regex-answers";
import {
  type JsonType,
  deepEqual,
  getPath,
  isPlainObject,
  matchesType,
  preview,
  typeOf,
} from "./value";

/** Every comparison {@link runChecks} understands. */
export const ASSERT_OPS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "matches",
  "notMatches",
  "startsWith",
  "endsWith",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "exists",
  "notExists",
  "isEmpty",
  "isNotEmpty",
  "isType",
  "hasLength",
  "minLength",
  "maxLength",
  "oneOf",
  "notOneOf",
  "hasFormat",
] as const;

export type AssertOp = (typeof ASSERT_OPS)[number];

/** One declarative check. `path` omitted means the value itself. */
export type Check = {
  path?: string;
  op: AssertOp;
  expected?: unknown;
  /** Regex flags, for `matches` and `notMatches`. */
  flags?: string;
  /** Replaces the generated reason when the check fails. */
  message?: string;
};

export type CheckResult = {
  index: number;
  path: string;
  op: AssertOp;
  ok: boolean;
  /** What was found there, length-capped. `null` when the path did not resolve. */
  actual: string | null;
  /** What the check asked for, length-capped. `null` for ops that take no operand. */
  expected: string | null;
  /** Empty when the check passed. */
  reason: string;
  /**
   * Set when the check could not be evaluated: its pattern could not be run
   * to an answer. It is not ok (a gate fails closed), but it did not fail
   * either, and `reason` says why. Absent on every other check.
   */
  undetermined?: true;
};

export type AssertReport = {
  ok: boolean;
  passed: number;
  /** Checks that did not pass, the undetermined ones included. */
  failed: number;
  /** Of `failed`, the checks that could not be evaluated. */
  undetermined: number;
  results: CheckResult[];
  /** Just the failures, for a caller that only wants to print those. */
  failures: CheckResult[];
};

/** The ops that are about presence, so an absent path is not itself a failure. */
const PRESENCE_OPS = new Set<AssertOp>(["exists", "notExists"]);

/** Length in code points for a string, items for an array, keys for an object. */
function lengthOf(value: unknown): number | null {
  if (typeof value === "string") return [...value].length;
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  return null;
}

/** Empty means: absent, null, the empty string, an empty array or an empty object. */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const length = lengthOf(value);
  return length !== null && length === 0;
}

function compareNumbers(
  actual: unknown,
  expected: unknown,
  ok: (a: number, b: number) => boolean,
  symbol: string,
): { ok: boolean; reason: string } {
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    return { ok: false, reason: `expected a number to compare, found ${typeOf(actual)}` };
  }
  if (typeof expected !== "number" || !Number.isFinite(expected)) {
    return { ok: false, reason: `the check's expected value must be a finite number` };
  }
  return ok(actual, expected)
    ? { ok: true, reason: "" }
    : { ok: false, reason: `${actual} is not ${symbol} ${expected}` };
}

function compareLength(
  actual: unknown,
  expected: unknown,
  ok: (a: number, b: number) => boolean,
  describe: (a: number, b: number) => string,
): { ok: boolean; reason: string } {
  const length = lengthOf(actual);
  if (length === null) {
    return { ok: false, reason: `${typeOf(actual)} has no length — use a string, array or object` };
  }
  if (typeof expected !== "number") {
    return { ok: false, reason: "the check's expected value must be a number" };
  }
  return ok(length, expected)
    ? { ok: true, reason: "" }
    : { ok: false, reason: describe(length, expected) };
}

type Verdict = { ok: boolean; reason: string; undetermined?: true };

/**
 * `matches` / `notMatches`. The pattern is the caller's, so it is never run
 * here: the answer comes from `regex` (resolved in the worker by the tool
 * that called), or, for a caller with none, from the bounded fallback on
 * this thread. A pattern the screen refuses fails the check, as an invalid
 * one always has; one that could not be run to an answer is undetermined,
 * never "does not match" (and so never a pass for `notMatches`).
 */
function matchRegex(
  actual: unknown,
  expected: unknown,
  flags: string,
  want: boolean,
  regex: RegexAnswers | undefined,
): Verdict {
  if (typeof actual !== "string") {
    return { ok: false, reason: `matches needs a string, found ${typeOf(actual)}` };
  }
  if (typeof expected !== "string") {
    return { ok: false, reason: "the check's expected value must be a regex source string" };
  }
  const answer: RegexAnswer | undefined =
    regex === undefined
      ? testPatternSync(expected, flags, actual)
      : regex.lookup(expected, flags, actual);
  if (answer === undefined) {
    return {
      ok: false,
      undetermined: true,
      reason: `could not evaluate /${expected}/${flags}: its answer has not been worked out yet`,
    };
  }
  if (typeof answer !== "boolean") {
    if ("refused" in answer) {
      return { ok: false, reason: `invalid regex /${expected}/${flags}: ${answer.refused}` };
    }
    return {
      ok: false,
      undetermined: true,
      reason: `could not evaluate /${expected}/${flags}: ${answer.undetermined}`,
    };
  }
  if (answer === want) return { ok: true, reason: "" };
  return {
    ok: false,
    reason: want
      ? `${preview(actual, 60)} does not match /${expected}/${flags}`
      : `${preview(actual, 60)} matches /${expected}/${flags} but must not`,
  };
}

/**
 * Ask `answers` about every pattern `checks` will test against `value`, so
 * one {@link RegexAnswers.resolve} settles them all before
 * {@link runChecks} reads them. A caller evaluating several check lists
 * against one value (a table's rows, a router's arms) asks for every list
 * first, then resolves once.
 */
export function askCheckPatterns(
  value: unknown,
  checks: ReadonlyArray<Check>,
  answers: RegexAnswers,
): void {
  for (const check of checks) {
    if (check.op !== "matches" && check.op !== "notMatches") continue;
    if (typeof check.expected !== "string") continue;
    let actual: unknown = value;
    const path = check.path ?? "";
    if (path !== "") {
      try {
        const resolution = getPath(value, path);
        if (!resolution.found) continue;
        actual = resolution.value;
      } catch {
        continue;
      }
    }
    if (typeof actual === "string") answers.lookup(check.expected, check.flags ?? "", actual);
  }
}

function evaluate(
  check: Check,
  actual: unknown,
  found: boolean,
  regex: RegexAnswers | undefined,
): Verdict {
  const expected = check.expected;
  switch (check.op) {
    case "exists":
      return found ? { ok: true, reason: "" } : { ok: false, reason: "the path does not resolve" };
    case "notExists":
      return found
        ? { ok: false, reason: `the path resolves to ${preview(actual, 60)} but must not exist` }
        : { ok: true, reason: "" };
    case "equals":
      return deepEqual(actual, expected)
        ? { ok: true, reason: "" }
        : { ok: false, reason: `expected ${preview(expected, 60)}, found ${preview(actual, 60)}` };
    case "notEquals":
      return deepEqual(actual, expected)
        ? { ok: false, reason: `found ${preview(actual, 60)}, which the check forbids` }
        : { ok: true, reason: "" };
    case "contains":
    case "notContains": {
      const want = check.op === "contains";
      let has: boolean;
      if (typeof actual === "string") {
        if (typeof expected !== "string") {
          return { ok: false, reason: "a string only contains a string" };
        }
        has = actual.includes(expected);
      } else if (Array.isArray(actual)) {
        has = actual.some((item) => deepEqual(item, expected));
      } else if (isPlainObject(actual)) {
        if (typeof expected !== "string") {
          return {
            ok: false,
            reason: "an object contains a property name, so expected must be a string",
          };
        }
        has = Object.hasOwn(actual, expected);
      } else {
        return {
          ok: false,
          reason: `contains needs a string, array or object, found ${typeOf(actual)}`,
        };
      }
      if (has === want) return { ok: true, reason: "" };
      return {
        ok: false,
        reason: want
          ? `${preview(actual, 60)} does not contain ${preview(expected, 40)}`
          : `${preview(actual, 60)} contains ${preview(expected, 40)} but must not`,
      };
    }
    case "matches":
      return matchRegex(actual, expected, check.flags ?? "", true, regex);
    case "notMatches":
      return matchRegex(actual, expected, check.flags ?? "", false, regex);
    case "startsWith":
    case "endsWith": {
      if (typeof actual !== "string" || typeof expected !== "string") {
        return { ok: false, reason: `${check.op} needs two strings, found ${typeOf(actual)}` };
      }
      const ok =
        check.op === "startsWith" ? actual.startsWith(expected) : actual.endsWith(expected);
      return ok
        ? { ok: true, reason: "" }
        : {
            ok: false,
            reason: `${preview(actual, 60)} does not ${check.op} ${preview(expected, 40)}`,
          };
    }
    case "greaterThan":
      return compareNumbers(actual, expected, (a, b) => a > b, ">");
    case "greaterThanOrEqual":
      return compareNumbers(actual, expected, (a, b) => a >= b, ">=");
    case "lessThan":
      return compareNumbers(actual, expected, (a, b) => a < b, "<");
    case "lessThanOrEqual":
      return compareNumbers(actual, expected, (a, b) => a <= b, "<=");
    case "isEmpty":
      return isEmptyValue(actual)
        ? { ok: true, reason: "" }
        : { ok: false, reason: `${preview(actual, 60)} is not empty` };
    case "isNotEmpty":
      return isEmptyValue(actual)
        ? { ok: false, reason: "the value is empty" }
        : { ok: true, reason: "" };
    case "isType": {
      const names = (Array.isArray(expected) ? expected : [expected]).filter(
        (t): t is string => typeof t === "string",
      );
      if (names.length === 0) {
        return {
          ok: false,
          reason: "the check's expected value must be a type name or an array of them",
        };
      }
      const actualType: JsonType = typeOf(actual);
      return names.some((name) => matchesType(actualType, name))
        ? { ok: true, reason: "" }
        : { ok: false, reason: `expected ${names.join(" or ")}, found ${actualType}` };
    }
    case "hasLength":
      return compareLength(
        actual,
        expected,
        (a, b) => a === b,
        (a, b) => `length is ${a}, expected ${b}`,
      );
    case "minLength":
      return compareLength(
        actual,
        expected,
        (a, b) => a >= b,
        (a, b) => `length is ${a}, under the minimum of ${b}`,
      );
    case "maxLength":
      return compareLength(
        actual,
        expected,
        (a, b) => a <= b,
        (a, b) => `length is ${a}, over the maximum of ${b}`,
      );
    case "oneOf":
    case "notOneOf": {
      if (!Array.isArray(expected)) {
        return {
          ok: false,
          reason: "the check's expected value must be an array of allowed values",
        };
      }
      const member = expected.some((candidate) => deepEqual(candidate, actual));
      const want = check.op === "oneOf";
      if (member === want) return { ok: true, reason: "" };
      return {
        ok: false,
        reason: want
          ? `${preview(actual, 60)} is not one of ${preview(expected, 80)}`
          : `${preview(actual, 60)} is in the forbidden set`,
      };
    }
    case "hasFormat": {
      if (typeof actual !== "string") {
        return { ok: false, reason: `hasFormat needs a string, found ${typeOf(actual)}` };
      }
      if (typeof expected !== "string" || !isFormatName(expected)) {
        return {
          ok: false,
          reason: `"${String(expected)}" is not a format this package implements`,
        };
      }
      const result = checkFormat(actual, expected);
      return result.valid
        ? { ok: true, reason: "" }
        : { ok: false, reason: `not a valid ${expected}: ${result.reason}` };
    }
    default:
      return { ok: false, reason: `unknown op "${String(check.op)}"` };
  }
}

/**
 * Run every check against `value` and report which held.
 *
 * Path resolution uses the dotted form (`order.items[0].sku`); an omitted or
 * empty path means the value itself. Every op except `exists` and
 * `notExists` fails when the path does not resolve, with that stated as the
 * reason — a check against a field that is not there has not passed.
 *
 * A malformed check (a bad regex, a non-numeric bound) fails that check with
 * an explanatory reason rather than throwing, so one typo cannot take down a
 * whole gate.
 *
 * `matches` and `notMatches` read their answers from `options.regex`, which
 * the calling tool resolved in the worker (see {@link askCheckPatterns});
 * without it they fall back to a bounded run on this thread. A check whose
 * pattern could not be run to an answer is not ok and carries
 * `undetermined: true`; its reason says so whatever `message` the check set.
 */
export function runChecks(
  value: unknown,
  checks: ReadonlyArray<Check>,
  options: { readonly regex?: RegexAnswers } = {},
): AssertReport {
  const results: CheckResult[] = checks.map((check, index) => {
    const path = check.path ?? "";
    let found = true;
    let actual: unknown = value;
    if (path !== "") {
      try {
        const resolution = getPath(value, path);
        found = resolution.found;
        actual = resolution.value;
      } catch (err) {
        return {
          index,
          path,
          op: check.op,
          ok: false,
          actual: null,
          expected: check.expected === undefined ? null : preview(check.expected, 80),
          reason: check.message ?? `bad path: ${(err as Error).message}`,
        };
      }
    }

    if (!found && !PRESENCE_OPS.has(check.op)) {
      return {
        index,
        path,
        op: check.op,
        ok: false,
        actual: null,
        expected: check.expected === undefined ? null : preview(check.expected, 80),
        reason: check.message ?? `the path "${path}" does not resolve`,
      };
    }

    const verdict = evaluate(check, actual, found, options.regex);
    return {
      index,
      path,
      op: check.op,
      ok: verdict.ok,
      actual: found ? preview(actual, 80) : null,
      expected: check.expected === undefined ? null : preview(check.expected, 80),
      reason: verdict.ok
        ? ""
        : verdict.undetermined === true
          ? verdict.reason
          : (check.message ?? verdict.reason),
      ...(verdict.undetermined === true ? { undetermined: true as const } : {}),
    };
  });

  const failures = results.filter((r) => !r.ok);
  return {
    ok: failures.length === 0,
    passed: results.length - failures.length,
    failed: failures.length,
    undetermined: failures.filter((r) => r.undetermined === true).length,
    results,
    failures,
  };
}

/**
 * What a check list says as a whole, three ways. Under `all`, a check that
 * definitely failed decides it (`fail`); otherwise an undetermined one leaves
 * it `undetermined`. Under `any`, a check that passed decides it (`pass`);
 * otherwise an undetermined one leaves it `undetermined`. A router or a
 * scorer that reads `report.ok` alone would take an undetermined check for a
 * miss and fall through to the next arm or the default.
 */
export function checksVerdict(
  report: AssertReport,
  mode: "all" | "any" = "all",
): "pass" | "fail" | "undetermined" {
  if (mode === "all") {
    if (report.ok) return "pass";
    return report.failed > report.undetermined ? "fail" : "undetermined";
  }
  if (report.passed > 0) return "pass";
  return report.undetermined > 0 ? "undetermined" : "fail";
}

/**
 * Which of `paths` are present and non-empty in `value`, and which are not.
 * "Present" means the path resolves; "non-empty" applies
 * {@link isEmptyValue}, so `null`, `""`, `[]` and `{}` count as missing
 * unless `allowEmpty` is set.
 */
export function checkRequired(
  value: unknown,
  paths: string[],
  allowEmpty: boolean,
): { ok: boolean; present: string[]; missing: Array<{ path: string; reason: string }> } {
  const present: string[] = [];
  const missing: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    let resolution: ReturnType<typeof getPath>;
    try {
      resolution = getPath(value, path);
    } catch (err) {
      missing.push({ path, reason: `bad path: ${(err as Error).message}` });
      continue;
    }
    if (!resolution.found) {
      missing.push({ path, reason: `absent (stops resolving at "${resolution.missingAt}")` });
      continue;
    }
    if (!allowEmpty && isEmptyValue(resolution.value)) {
      missing.push({ path, reason: `present but empty (${preview(resolution.value, 40)})` });
      continue;
    }
    present.push(path);
  }
  return { ok: missing.length === 0, present, missing };
}
