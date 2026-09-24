/**
 * Two 0.7.0 validator defects, each tested through the library and the tools.
 *
 * Recursive schemas: a branch (anyOf, oneOf, not, if, contains,
 * propertyNames) was validated with its instance path restarted at "", while
 * the `$ref` cycle marker was `${ref}@${path}`. So a recursive schema that
 * recursed through a branch rebuilt, one level down, the marker its own outer
 * level had pushed, and reported a cycle that did not exist. Valid data was
 * rejected, and inside `not` or `oneOf` invalid data was accepted.
 *
 * Unbounded work: anyOf/oneOf/allOf over `$ref`s that share a target double
 * the work at each level, and every failing branch's full message was copied
 * into its parent's. A 1.3 KB schema produced an 85 MB result, and an allOf
 * chain on a valid value took seconds to say `valid: true`.
 */
import { describe, expect, test } from "bun:test";
import { jsonSchemaValidate, validateRecords } from "./index";
import { DEFAULT_MAX_WORK, type Schema, validateValue } from "./lib/jsonschema";
import { validateRecords as validateRecordsFn } from "./lib/records";

// biome-ignore lint/suspicious/noExplicitAny: the tools read no context.
const ctx = {} as any;

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function call(tool: typeof jsonSchemaValidate, input: unknown): Promise<any> {
  const out = await tool.execute(tool.inputSchema.parse(input), ctx);
  return JSON.parse(out as string);
}

/** d0 .. d(n-1) each `kw` over two $refs to the next; d(n) is a string. */
function chain(levels: number, kw: "anyOf" | "oneOf" | "allOf"): Schema {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < levels; i++) {
    defs[`d${i}`] = { [kw]: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
  }
  defs[`d${levels}`] = { type: "string" };
  return { $defs: defs, $ref: "#/$defs/d0" };
}

describe("a recursive schema that recurses through a branch keyword", () => {
  const nested: Schema = { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#" } }] };

  test("nested lists through anyOf validate at every depth", () => {
    for (const value of ["a", ["a"], [["a"]], [[["a"]]], [[[["a", "b"]]], "c"]]) {
      const result = validateValue(value, nested);
      expect({ value, valid: result.valid, errors: result.errors }).toEqual({
        value,
        valid: true,
        errors: [],
      });
    }
    const bad = validateValue([[1]], nested);
    expect(bad.valid).toBe(false);
    expect(bad.errors.some((e) => /cycle/.test(e.message))).toBe(false);
  });

  test("a tree whose children are oneOf null or the tree", () => {
    const tree: Schema = {
      type: "object",
      properties: { kids: { type: "array", items: { oneOf: [{ type: "null" }, { $ref: "#" }] } } },
    };
    expect(validateValue({ kids: [{ kids: [{ kids: [null] }] }] }, tree).valid).toBe(true);
    expect(validateValue({ kids: [{ kids: [{ kids: [1] }] }] }, tree).valid).toBe(false);
  });

  test("contains that recurses", () => {
    const schema: Schema = {
      type: "array",
      contains: { anyOf: [{ const: 1 }, { type: "array", contains: { $ref: "#/contains" } }] },
    };
    expect(validateValue([[[1]]], schema).valid).toBe(true);
    expect(validateValue([[[2]]], schema).valid).toBe(false);
  });

  test("not: 'no string anywhere' rejects a nested string (0.7.0 accepted it)", () => {
    const noString: Schema = {
      not: { anyOf: [{ type: "string" }, { type: "array", contains: { $ref: "#/not" } }] },
    };
    expect(validateValue(["x"], noString).valid).toBe(false);
    expect(validateValue([["x"]], noString).valid).toBe(false);
    expect(validateValue([[["x"]]], noString).valid).toBe(false);
    expect(validateValue([1, [2]], noString).valid).toBe(true);
  });

  test("oneOf counts a recursive branch that passes (0.7.0 accepted [[1]] here)", () => {
    const schema: Schema = {
      $defs: {
        allInts: {
          anyOf: [{ type: "integer" }, { type: "array", items: { $ref: "#/$defs/allInts" } }],
        },
      },
      oneOf: [{ $ref: "#/$defs/allInts" }, { type: "array", maxItems: 1 }],
    };
    const result = validateValue([[1]], schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.keyword).toBe("oneOf");
    expect(result.errors[0]?.message).toMatch(/matched 2 alternatives/);
  });

  test("an if condition that recurses", () => {
    // Every item must be strings nested in lists: the condition decides it.
    const schema: Schema = {
      $defs: {
        allStr: {
          anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/allStr" } }],
        },
      },
      type: "array",
      items: { if: { $ref: "#/$defs/allStr" }, else: false },
    };
    expect(validateValue([[["a"]], "b"], schema).valid).toBe(true);
    expect(validateValue([[["a"]], [[1]]], schema).valid).toBe(false);
  });

  test("a real cycle is still reported as one", () => {
    const result = validateValue(1, { anyOf: [{ $ref: "#" }] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/cycles/);
    const direct = validateValue(1, { $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" });
    expect(direct.errors[0]?.message).toMatch(/cycles/);
  });

  test("the tools give the same verdicts", async () => {
    expect((await call(jsonSchemaValidate, { value: [[["a"]]], schema: nested })).valid).toBe(true);
    const rows = await call(validateRecords as typeof jsonSchemaValidate, {
      records: ["a", [["a"]], [[1]]],
      schema: nested,
    });
    expect(rows).toMatchObject({ ok: false, total: 3, passed: 2, failed: 1 });
  });
});

describe("the validator's work is bounded, and running out is not a verdict", () => {
  test("the budget is exact: the visits a walk needs are allowed, one fewer is not", () => {
    const schema: Schema = { type: "object", properties: { a: { type: "string" } } };
    // One evaluation for the object, one for its property.
    expect(validateValue({ a: "x" }, schema, { maxWork: 2 })).toMatchObject({
      valid: true,
      undetermined: null,
    });
    const short = validateValue({ a: "x" }, schema, { maxWork: 1 });
    expect(short.valid).toBe(false);
    expect(short.undetermined).toMatch(/more than 1 subschema evaluations/);
  });

  test("an allOf chain on a valid value is undetermined, never valid, when it runs out", () => {
    const result = validateValue("x", chain(14, "allOf"), { maxWork: 10_000 });
    expect(result.valid).toBe(false);
    expect(result.undetermined).not.toBeNull();
    // Within budget, the same value is valid.
    expect(validateValue("x", chain(8, "allOf")).valid).toBe(true);
  });

  test("anyOf and oneOf failures carry a bounded message", async () => {
    for (const kw of ["anyOf", "oneOf"] as const) {
      const out = await jsonSchemaValidate.execute(
        jsonSchemaValidate.inputSchema.parse({ value: 1, schema: chain(16, kw) }),
        ctx,
      );
      // 0.7.0: 5,308,503 characters for the anyOf case.
      expect(String(out).length).toBeLessThan(50_000);
      const parsed = JSON.parse(String(out));
      expect(parsed.valid).toBe(false);
      for (const error of parsed.errors) expect(error.message.length).toBeLessThanOrEqual(1_000);
    }
  });

  test("an ordinary anyOf failure still names each alternative", () => {
    const result = validateValue(true, { anyOf: [{ type: "string" }, { type: "number" }] });
    expect(result.errors[0]?.message).toMatch(/\[0\] expected string.*\[1\] expected number/);
  });

  test("JsonSchemaValidate reports the bomb as undetermined, with valid null", async () => {
    const out = await call(jsonSchemaValidate, { value: "x", schema: chain(22, "allOf") });
    expect(out.valid).toBeNull();
    expect(out.undetermined).toBe(true);
    expect(out.reason).toMatch(new RegExp(`more than ${DEFAULT_MAX_WORK} subschema`));
  }, 30_000);

  test("ValidateRecords counts rows it could not decide as neither passed nor failed", async () => {
    const out = await call(validateRecords as typeof jsonSchemaValidate, {
      records: ["x", "y"],
      schema: chain(22, "allOf"),
    });
    expect(out).toMatchObject({ ok: false, total: 2, passed: 0, failed: 0, undetermined: 2 });
    expect(out.undeterminedFrom.row).toBe(0);
  }, 30_000);

  test("the rows of one call share one budget", () => {
    const report = validateRecordsFn(Array(1_000).fill("x"), chain(12, "allOf"));
    // 2^12 evaluations a row: the first rows pass, then the budget is spent.
    expect(report.passed).toBeGreaterThan(0);
    expect(report.undetermined).toBeGreaterThan(0);
    expect(report.passed + report.undetermined).toBe(1_000);
    expect(report.ok).toBe(false);
  });

  test("a large value gets a budget in proportion to its size", () => {
    const branches = Array.from({ length: 30 }, (_, k) => ({ const: k }));
    const schema: Schema = { type: "array", items: { anyOf: branches } };
    // About 31 evaluations for each of 20,000 items: past the flat floor.
    const value = Array(20_000).fill(29);
    const result = validateValue(value, schema);
    expect(result.undetermined).toBeNull();
    expect(result.valid).toBe(true);
    expect(20_000 * 31).toBeGreaterThan(DEFAULT_MAX_WORK);
  });
});
