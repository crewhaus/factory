/**
 * Branch-coverage + regression tests for eval-grader.
 *
 * Complements index.test.ts by driving the remaining uncovered branches in
 * graders.ts, graders-config.ts, and json-path.ts, and by locking in two
 * correctness fixes:
 *   - jsonPath child access uses own-property semantics (no prototype leak).
 *   - regex graders reset lastIndex so global/sticky flags stay deterministic.
 */
import { describe, expect, test } from "bun:test";
import { GraderError } from "./errors";
import {
  combineCompiledGraders,
  jsonPath,
  parseGradersConfig,
  regex,
  toolCallSequence,
} from "./index";
import type { RunResult, Sample } from "./index";
import { JsonPathError, compileJsonPath, evalJsonPath } from "./json-path";

const sample: Sample = { id: "s1", input: "hi", expected_output: "hello" };
const baseRun: RunResult = {
  agentOutput: "hello",
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 100,
};

const runWith = (over: Partial<RunResult>): RunResult => ({ ...baseRun, ...over });

describe("jsonPath grader — failure branches (graders.ts)", () => {
  test("fails when the path expression cannot compile", async () => {
    // Valid JSON, but the path is malformed → evalJsonPath throws → caught.
    const r = await jsonPath({ path: "$.user[bogus" })(
      sample,
      runWith({ agentOutput: '{"user":{}}' }),
    );
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("jsonPath compile failed");
  });

  test("fails when the path matches no nodes", async () => {
    const r = await jsonPath({ path: "$.missing" })(
      sample,
      runWith({ agentOutput: '{"present":1}' }),
    );
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("matched no nodes");
  });

  test("fails when matched value differs from expected", async () => {
    const r = await jsonPath({ path: "$.n", expected: 7 })(
      sample,
      runWith({ agentOutput: '{"n":3}' }),
    );
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("expected 7");
    expect(r.rationale).toContain("matched [3]");
  });
});

describe("jsonPath grader — deepEqual coverage (graders.ts helper)", () => {
  // Exercise every branch of the private deepEqual via the `expected` path.
  const cases: Array<{
    name: string;
    output: unknown;
    path: string;
    expected: unknown;
    passed: boolean;
  }> = [
    {
      name: "primitive equality (a === b)",
      output: { v: "x" },
      path: "$.v",
      expected: "x",
      passed: true,
    },
    {
      name: "type mismatch (number vs string)",
      output: { v: 1 },
      path: "$.v",
      expected: "1",
      passed: false,
    },
    {
      name: "null vs object",
      output: { v: null },
      path: "$.v",
      expected: {},
      passed: false,
    },
    {
      name: "object vs null (expected null)",
      output: { v: { a: 1 } },
      path: "$.v",
      expected: null,
      passed: false,
    },
    {
      name: "array vs non-array of same typeof object",
      output: { v: [1, 2] },
      path: "$.v",
      expected: { 0: 1, 1: 2 },
      passed: false,
    },
    {
      name: "array length mismatch",
      output: { v: [1, 2, 3] },
      path: "$.v",
      expected: [1, 2],
      passed: false,
    },
    {
      name: "array deep equal element mismatch",
      output: { v: [1, 2] },
      path: "$.v",
      expected: [1, 9],
      passed: false,
    },
    {
      name: "array deep equal match",
      output: { v: [1, [2, 3]] },
      path: "$.v",
      expected: [1, [2, 3]],
      passed: true,
    },
    {
      name: "object key-count mismatch",
      output: { v: { a: 1 } },
      path: "$.v",
      expected: { a: 1, b: 2 },
      passed: false,
    },
    {
      name: "object value mismatch on matching keys",
      output: { v: { a: 1 } },
      path: "$.v",
      expected: { a: 2 },
      passed: false,
    },
    {
      name: "nested object deep equal match",
      output: { v: { a: { b: 1 } } },
      path: "$.v",
      expected: { a: { b: 1 } },
      passed: true,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const r = await jsonPath({ path: c.path, expected: c.expected })(
        sample,
        runWith({ agentOutput: JSON.stringify(c.output) }),
      );
      expect(r.passed).toBe(c.passed);
    });
  }
});

describe("toolCallSequence — exact-mode mismatch (graders.ts)", () => {
  test("exact mode fails on length/content mismatch", async () => {
    const run = runWith({
      toolCalls: [
        { toolName: "bash", toolUseId: "t1", isError: false },
        { toolName: "read", toolUseId: "t2", isError: false },
      ],
    });
    const r = await toolCallSequence({ expected: ["bash"], mode: "exact" })(sample, run);
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("tool sequence mismatch");
  });
});

describe("regex grader — determinism regression (graders.ts)", () => {
  test("global-flag regex stays deterministic across repeated invocations", async () => {
    // Pre-fix, `re.test` advanced lastIndex on a `g` regex, so a reused grader
    // instance flip-flopped pass/fail. It must now pass on every call.
    const g = regex(/hello/g);
    for (let i = 0; i < 4; i += 1) {
      const r = await g(sample, baseRun);
      expect(r.passed).toBe(true);
    }
  });

  test("sticky-flag regex also stays deterministic", async () => {
    const g = regex("hello", "y");
    expect((await g(sample, baseRun)).passed).toBe(true);
    expect((await g(sample, baseRun)).passed).toBe(true);
  });

  test("non-match still reports failure deterministically", async () => {
    const g = regex(/bye/g);
    expect((await g(sample, baseRun)).passed).toBe(false);
    expect((await g(sample, baseRun)).passed).toBe(false);
  });
});

describe("json-path — compile edge cases (json-path.ts)", () => {
  test("empty and root paths compile to no steps and yield the root value", () => {
    expect(compileJsonPath("")).toEqual([]);
    expect(compileJsonPath("$")).toEqual([]);
    const root = { a: 1 };
    expect(evalJsonPath(root, "")).toEqual([root]);
    expect(evalJsonPath(root, "$")).toEqual([root]);
  });

  test("rejects an empty recursive-descent key ($..)", () => {
    expect(() => compileJsonPath("$..")).toThrow(/empty descendant key/);
  });

  test("rejects an empty child key after a dot ($.)", () => {
    expect(() => compileJsonPath("$.")).toThrow(/empty key after/);
  });

  test("rejects an unexpected leading character", () => {
    expect(() => compileJsonPath("$@foo")).toThrow(/unexpected character/);
  });

  test("rejects a non-empty path that does not start with $", () => {
    expect(() => compileJsonPath("foo.bar")).toThrow(/must start with "\$"/);
  });

  test("rejects an unclosed bracket", () => {
    expect(() => compileJsonPath("$[0")).toThrow(/unclosed bracket/);
  });

  test("rejects a negative bracket index", () => {
    expect(() => compileJsonPath("$[-1]")).toThrow(/negative index/);
  });

  test("rejects an unsupported bracket expression", () => {
    expect(() => compileJsonPath("$[1+1]")).toThrow(/unsupported bracket expression/);
  });

  test("compile errors are GraderError instances", () => {
    expect(() => compileJsonPath("$@")).toThrow(GraderError);
  });

  test("JsonPathError forwards message and cause to GraderError", () => {
    const cause = new Error("root");
    const err = new JsonPathError("boom", cause);
    expect(err).toBeInstanceOf(GraderError);
    expect(err.message).toBe("eval-grader: boom");
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });
});

describe("json-path — evaluation branches (json-path.ts)", () => {
  test("wildcard over an object yields its values", () => {
    expect(evalJsonPath({ a: 1, b: 2 }, "$[*]")).toEqual([1, 2]);
  });

  test("wildcard over a non-collection yields nothing", () => {
    expect(evalJsonPath({ scalar: 5 }, "$.scalar[*]")).toEqual([]);
  });

  test("single-quoted bracket key resolves", () => {
    expect(evalJsonPath({ "with-dash": 9 }, "$['with-dash']")).toEqual([9]);
  });

  test("out-of-range index yields no match", () => {
    expect(evalJsonPath({ arr: [1] }, "$.arr[5]")).toEqual([]);
  });
});

describe("json-path — prototype-leak regression (json-path.ts)", () => {
  // Pre-fix, child access used `in`, so inherited keys like "constructor"
  // resolved to prototype functions. They must now report no match.
  test("does not resolve inherited prototype keys", () => {
    const obj = JSON.parse('{"a":1}');
    expect(evalJsonPath(obj, "$.constructor")).toEqual([]);
    expect(evalJsonPath(obj, "$.toString")).toEqual([]);
    expect(evalJsonPath(obj, "$.hasOwnProperty")).toEqual([]);
    expect(evalJsonPath(obj, "$.__proto__")).toEqual([]);
  });

  test("still resolves an own key that shadows a prototype name", () => {
    expect(evalJsonPath({ toString: "shadowed" }, "$.toString")).toEqual(["shadowed"]);
  });

  test("jsonPath grader reports no-match for inherited keys", async () => {
    const r = await jsonPath({ path: "$.constructor" })(
      sample,
      runWith({ agentOutput: '{"a":1}' }),
    );
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("matched no nodes");
  });
});

describe("graders-config — remaining compile cases (graders-config.ts)", () => {
  test("compiles a `contains` grader and runs it", async () => {
    const yaml = `
graders:
  - name: has_sub
    type: contains
    substring: ell
    case_insensitive: true
`;
    const { compiled } = parseGradersConfig(yaml);
    expect(compiled[0]?.name).toBe("has_sub");
    const r = await combineCompiledGraders(compiled)(sample, baseRun);
    expect(r.passed).toBe(true);
  });

  test("compiles a `json_path` grader with and without `expected`", async () => {
    const withExpected = parseGradersConfig(`
graders:
  - name: jp
    type: json_path
    path: $.n
    expected: 3
`);
    const r1 = await combineCompiledGraders(withExpected.compiled)(
      sample,
      runWith({ agentOutput: '{"n":3}' }),
    );
    expect(r1.passed).toBe(true);

    const withoutExpected = parseGradersConfig(`
graders:
  - name: jp
    type: json_path
    path: $.n
`);
    const r2 = await combineCompiledGraders(withoutExpected.compiled)(
      sample,
      runWith({ agentOutput: '{"n":42}' }),
    );
    expect(r2.passed).toBe(true);
  });

  test("compiles a `tool_call_sequence` grader honoring `mode`", async () => {
    const { compiled } = parseGradersConfig(`
graders:
  - name: tcs
    type: tool_call_sequence
    expected: [bash, read]
    mode: set
`);
    const run = runWith({
      toolCalls: [
        { toolName: "read", toolUseId: "t1", isError: false },
        { toolName: "bash", toolUseId: "t2", isError: false },
      ],
    });
    const r = await combineCompiledGraders(compiled)(sample, run);
    expect(r.passed).toBe(true);
  });

  test("llm_judge placeholder grader throws until resolved", async () => {
    const { compiled } = parseGradersConfig(`
graders:
  - name: judge
    type: llm_judge
    weight: 2
    model: claude-x
    rubric:
      criteria:
        - name: c1
          description: ok
          anchors: { 1: bad, 2: meh, 3: ok, 4: good, 5: great }
`);
    const entry = compiled[0];
    expect(entry?.weight).toBe(2);
    expect(entry?.judgeSpec?.model).toBe("claude-x");
    await expect(entry?.grader(sample, baseRun)).rejects.toThrow(
      /must be resolved via @crewhaus\/eval-judge/,
    );
  });
});
