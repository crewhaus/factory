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
import {
  DEFAULT_MAX_WORK,
  MAX_NESTING,
  MAX_VALUE_DEPTH,
  type Schema,
  validateValue,
} from "./lib/jsonschema";
import { validateRecords as validateRecordsFn } from "./lib/records";
import { preview } from "./lib/value";

// biome-ignore lint/suspicious/noExplicitAny: the tools read no context.
const ctx = {} as any;

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function call(tool: typeof jsonSchemaValidate, input: unknown): Promise<any> {
  const out = await tool.execute(tool.inputSchema.parse(input), ctx);
  return JSON.parse(out as string);
}

/** d0 .. d(n-1) each `kw` over two $refs to the next; d(n) is `leaf`, a string by default. */
function chain(
  levels: number,
  kw: "anyOf" | "oneOf" | "allOf",
  leaf: Schema = { type: "string" },
): Schema {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < levels; i++) {
    defs[`d${i}`] = { [kw]: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
  }
  defs[`d${levels}`] = leaf;
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
  }, 20_000);

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
  }, 20_000);
});

describe("work that follows the value's size is charged, and messages are built only when kept", () => {
  /** The longest string JSON.stringify is handed while `run` runs, and how many calls. */
  function stringifySpy<T>(run: () => T): { result: T; longest: number; calls: number } {
    const original = JSON.stringify;
    let longest = 0;
    let calls = 0;
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
      calls += 1;
      if (typeof value === "string" && value.length > longest) longest = value.length;
      return (original as (...args: unknown[]) => string)(value, ...rest);
    }) as typeof JSON.stringify;
    try {
      return { result: run(), longest, calls };
    } finally {
      JSON.stringify = original;
    }
  }

  test("a failing check on a large value never serializes the whole value", () => {
    // 0.7.1's first cut previewed the whole value once per failed leaf: this
    // 794-character schema on a 2 MB string took 81 s.
    const value = "x ".repeat(500_000);
    const spied = stringifySpy(() =>
      validateValue(value, chain(12, "allOf", { type: "number" }), { maxErrors: 5 }),
    );
    expect(spied.result.undetermined).toBeNull();
    expect(spied.result.valid).toBe(false);
    expect(spied.result.errors).toHaveLength(5);
    expect(spied.result.truncated).toBe(true);
    expect(spied.result.errors[0]?.message).toMatch(/^expected number, found string \("x x x/);
    // A preview reads a prefix, never the value.
    expect(spied.longest).toBeLessThan(2_000);
    // And past maxErrors no message is built at all: 5 kept, not 4,096.
    expect(spied.calls).toBeLessThanOrEqual(5);
  });

  test("preview reads only the prefix it shows, and matches the whole-value rendering", () => {
    const whole = (value: unknown, max: number): string => {
      const text = (JSON.stringify(value) ?? String(value)).replace(/\s+/g, " ");
      return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
    };
    const values: unknown[] = [
      "short",
      "a\tb\n  c\u2028d",
      ["\ud83d\ude00", 1.5, null, true, { k: [undefined, 2] }],
      { a: undefined, "b c": "x".repeat(300), d: { e: [Number.NaN, Number.POSITIVE_INFINITY] } },
      Array.from({ length: 100 }, (_, i) => ({ i, s: '"quoted\\' })),
    ];
    for (const value of values) {
      for (const max of [0, 3, 10, 60, 120, 1_000]) {
        expect({ value, max, got: preview(value, max) }).toEqual({
          value,
          max,
          got: whole(value, max),
        });
      }
    }
    const big = { list: Array.from({ length: 100_000 }, (_, i) => `item ${i}`) };
    const spied = stringifySpy(() => preview(big, 60));
    expect(spied.result).toBe(whole(big, 60));
    expect(spied.longest).toBeLessThan(1_000);
  });

  test("checks that read a whole string are charged for its length", () => {
    // 1,024 minLength leaves on a 200 KB string: 0.7.1's first cut counted
    // each as one evaluation and read the string 1,024 times.
    const value = "x".repeat(200_000);
    const result = validateValue(value, chain(10, "allOf", { minLength: 1 }));
    expect(result.undetermined).toMatch(/more than 500000 subschema evaluations/);
    // A value that size checked once is well inside its budget.
    expect(validateValue(value, { type: "string", minLength: 1, pattern: "x$" }).valid).toBe(true);
    // And the budget grows with the string, so a larger one checked once still passes.
    expect(validateValue("y".repeat(5_000_000), { maxLength: 5_000_000 }).valid).toBe(true);
  });

  test("uniqueItems, an object's keys and enum comparisons are charged per member", () => {
    const array = Array.from({ length: 50_000 }, (_, i) => i);
    expect(
      validateValue(array, chain(12, "anyOf", { uniqueItems: true, maxItems: 1 })).undetermined,
    ).toMatch(/subschema evaluations/);
    const object = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, i]));
    expect(validateValue(object, chain(12, "anyOf", { maxProperties: 1 })).undetermined).toMatch(
      /subschema evaluations/,
    );
    expect(validateValue(object, chain(12, "anyOf", { enum: [{ a: 1 }] })).undetermined).toMatch(
      /subschema evaluations/,
    );
    // Each checked once, all well inside the budget.
    expect(validateValue(array, { uniqueItems: true }).valid).toBe(true);
    expect(validateValue(object, { enum: [object] }).valid).toBe(true);
  });
});

describe("depth is the value's, not the schema's", () => {
  const linked: Schema = {
    $defs: {
      node: {
        type: "object",
        properties: {
          v: { type: "number" },
          next: { anyOf: [{ type: "null" }, { $ref: "#/$defs/node" }] },
        },
        required: ["v", "next"],
      },
    },
    $ref: "#/$defs/node",
  };
  const list = (levels: number): unknown => {
    let value: unknown = null;
    for (let i = 0; i < levels; i++) value = { v: i, next: value };
    return value;
  };

  test("a valid list recursing through anyOf is valid at every depth up to the cap", () => {
    // 0.7.1's first cut spent three depth units per level here and called a
    // valid 35-node list invalid ("matched none of the 2 alternatives").
    for (const levels of [35, 60, 200, MAX_VALUE_DEPTH]) {
      const result = validateValue(list(levels), linked);
      expect({ levels, valid: result.valid, errors: result.errors }).toEqual({
        levels,
        valid: true,
        errors: [],
      });
    }
    const direct: Schema = {
      $defs: { node: { type: ["object", "null"], properties: { next: { $ref: "#/$defs/node" } } } },
      $ref: "#/$defs/node",
    };
    let value: unknown = null;
    for (let i = 0; i < 55; i++) value = { next: value };
    expect(validateValue(value, direct).valid).toBe(true);
  });

  test("a value deeper than the cap is undetermined, never a verdict", () => {
    expect(MAX_VALUE_DEPTH).toBe(512);
    const result = validateValue(list(MAX_VALUE_DEPTH + 1), linked);
    expect(result.valid).toBe(false);
    expect(result.undetermined).toMatch(/the value nests deeper than 512 levels \(at \/next\/next/);
    // An invalid node below the cap is still a verdict.
    const bad = list(40) as { next: { v: unknown } };
    bad.next.v = "not a number";
    const verdict = validateValue(bad, linked);
    expect(verdict.undetermined).toBeNull();
    expect(verdict.valid).toBe(false);
  });

  test("a schema nested past the frame cap is undetermined, not a stack overflow", () => {
    expect(MAX_NESTING).toBe(2_048);
    for (const wrap of [
      (inner: unknown) => ({ allOf: [inner] }),
      (inner: unknown) => ({ anyOf: [{ type: "number" }, inner] }),
      (inner: unknown) => ({ not: { not: inner } }),
      // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema keyword here.
      (inner: unknown) => ({ if: inner, then: true }),
    ]) {
      let schema: unknown = { type: "string" };
      for (let i = 0; i < 5_000; i++) schema = wrap(schema);
      const result = validateValue("x", schema as Schema);
      expect(result.valid).toBe(false);
      expect(result.undetermined).toMatch(
        /nest past 2048 checks inside one another \(at the top\)/,
      );
    }
  });

  test("a $ref that reaches itself with nothing consumed is still a cycle", () => {
    const loop: Schema = {
      $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
      $ref: "#/$defs/a",
    };
    const result = validateValue(1, loop);
    expect(result.undetermined).toBeNull();
    expect(result.errors[0]?.message).toMatch(/cycles at this position/);
  });
});
