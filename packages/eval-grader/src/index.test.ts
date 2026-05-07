import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  all,
  any,
  byName,
  combineCompiledGraders,
  contains,
  evalJsonPath,
  exactMatch,
  jsonPath,
  parseGradersConfig,
  regex,
  schema,
  toolCallSequence,
  weighted,
} from "./index";
import type { RunResult, Sample } from "./index";

const sample: Sample = { id: "s1", input: "hi", expected_output: "hello" };
const baseRun: RunResult = {
  agentOutput: "hello",
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 100,
};

describe("exactMatch (T1)", () => {
  test("matches identical output", async () => {
    const r = await exactMatch()(sample, baseRun);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  test("trims whitespace by default", async () => {
    const r = await exactMatch()(sample, { ...baseRun, agentOutput: " hello \n" });
    expect(r.passed).toBe(true);
  });

  test("respects caseInsensitive", async () => {
    const r = await exactMatch({ caseInsensitive: true })(sample, {
      ...baseRun,
      agentOutput: "HELLO",
    });
    expect(r.passed).toBe(true);
  });

  test("fails when expected_output missing", async () => {
    const r = await exactMatch()({ id: "x", input: "" }, baseRun);
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("no expected_output");
  });
});

describe("contains (T1)", () => {
  test("finds substring", async () => {
    const r = await contains({ substring: "ell" })(sample, baseRun);
    expect(r.passed).toBe(true);
  });

  test("misses absent substring", async () => {
    const r = await contains({ substring: "xyz" })(sample, baseRun);
    expect(r.passed).toBe(false);
  });

  test("caseInsensitive flag", async () => {
    const r = await contains({ substring: "ELLO", caseInsensitive: true })(sample, baseRun);
    expect(r.passed).toBe(true);
  });
});

describe("regex (T1)", () => {
  test("string + flags compiles", async () => {
    const r = await regex("HELLO", "i")(sample, baseRun);
    expect(r.passed).toBe(true);
  });

  test("RegExp instance", async () => {
    const r = await regex(/^hello$/)(sample, baseRun);
    expect(r.passed).toBe(true);
  });

  test("non-match fails", async () => {
    const r = await regex(/^bye/)(sample, baseRun);
    expect(r.passed).toBe(false);
  });
});

describe("jsonPath + evalJsonPath (T1)", () => {
  const obj = { user: { name: "alice", roles: ["admin", "viewer"] }, errors: [] };

  test("evalJsonPath supports child + descendant + wildcard", () => {
    expect(evalJsonPath(obj, "$.user.name")).toEqual(["alice"]);
    expect(evalJsonPath(obj, "$.user.roles[0]")).toEqual(["admin"]);
    expect(evalJsonPath(obj, "$.user.roles[*]")).toEqual(["admin", "viewer"]);
    expect(evalJsonPath(obj, "$..name")).toEqual(["alice"]);
    expect(evalJsonPath(obj, '$.user["name"]')).toEqual(["alice"]);
  });

  test("rejects unsupported expression", () => {
    expect(() => evalJsonPath(obj, "$.user[?(@.name=='alice')]")).toThrow(/unsupported/);
  });

  test("jsonPath grader passes when path matches", async () => {
    const run: RunResult = { ...baseRun, agentOutput: JSON.stringify(obj) };
    const r = await jsonPath({ path: "$.user.name", expected: "alice" })(sample, run);
    expect(r.passed).toBe(true);
  });

  test("jsonPath grader fails on JSON parse error", async () => {
    const r = await jsonPath({ path: "$.x" })(sample, { ...baseRun, agentOutput: "not json" });
    expect(r.passed).toBe(false);
  });

  test("jsonPath without `expected` passes if any node matches", async () => {
    const run: RunResult = { ...baseRun, agentOutput: JSON.stringify(obj) };
    const r = await jsonPath({ path: "$.user.roles[*]" })(sample, run);
    expect(r.passed).toBe(true);
  });
});

describe("schema (T1)", () => {
  const Shape = z.object({ ok: z.boolean(), n: z.number() });

  test("passes when JSON validates", async () => {
    const r = await schema(Shape)(sample, { ...baseRun, agentOutput: '{"ok":true,"n":3}' });
    expect(r.passed).toBe(true);
  });

  test("fails when missing field", async () => {
    const r = await schema(Shape)(sample, { ...baseRun, agentOutput: '{"ok":true}' });
    expect(r.passed).toBe(false);
  });

  test("fails when not JSON", async () => {
    const r = await schema(Shape)(sample, { ...baseRun, agentOutput: "totally not" });
    expect(r.passed).toBe(false);
  });
});

describe("toolCallSequence (T1)", () => {
  const calls = [
    { toolName: "bash", toolUseId: "t1", isError: false },
    { toolName: "read", toolUseId: "t2", isError: false },
    { toolName: "edit", toolUseId: "t3", isError: false },
  ];
  const run: RunResult = { ...baseRun, toolCalls: calls };

  test("subseq mode (default) — non-contiguous match", async () => {
    const r = await toolCallSequence({ expected: ["bash", "edit"] })(sample, run);
    expect(r.passed).toBe(true);
  });

  test("subseq mode rejects wrong order", async () => {
    const r = await toolCallSequence({ expected: ["edit", "bash"] })(sample, run);
    expect(r.passed).toBe(false);
  });

  test("exact mode requires identical sequence", async () => {
    const r = await toolCallSequence({
      expected: ["bash", "read", "edit"],
      mode: "exact",
    })(sample, run);
    expect(r.passed).toBe(true);
  });

  test("set mode ignores order", async () => {
    const r = await toolCallSequence({
      expected: ["edit", "bash"],
      mode: "set",
    })(sample, run);
    expect(r.passed).toBe(true);
  });

  test("set mode flags missing tool", async () => {
    const r = await toolCallSequence({
      expected: ["bash", "missing"],
      mode: "set",
    })(sample, run);
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("missing");
  });
});

describe("composers (T9 — table-driven property checks)", () => {
  const yes = async () => ({ passed: true, score: 1, rationale: "y" });
  const no = async () => ({ passed: false, score: 0, rationale: "n" });
  const half = async () => ({ passed: true, score: 0.5, rationale: "h" });

  test("all: AND-merged passed; min score", async () => {
    expect((await all([yes, yes])(sample, baseRun)).passed).toBe(true);
    expect((await all([yes, no])(sample, baseRun)).passed).toBe(false);
    expect((await all([yes, half])(sample, baseRun)).score).toBe(0.5);
  });

  test("any: OR-merged; max score", async () => {
    expect((await any([no, no])(sample, baseRun)).passed).toBe(false);
    expect((await any([no, yes])(sample, baseRun)).passed).toBe(true);
    expect((await any([half, no])(sample, baseRun)).score).toBe(0.5);
  });

  test("weighted: σ(score·w)/σw, threshold default 0.5", async () => {
    const r = await weighted([
      { name: "a", grader: yes, weight: 1 },
      { name: "b", grader: no, weight: 1 },
    ])(sample, baseRun);
    expect(r.score).toBe(0.5);
    expect(r.passed).toBe(true); // exactly at threshold

    const r2 = await weighted(
      [
        { name: "a", grader: yes, weight: 1 },
        { name: "b", grader: no, weight: 3 },
      ],
      0.5,
    )(sample, baseRun);
    expect(r2.score).toBeCloseTo(0.25);
    expect(r2.passed).toBe(false);
  });

  test("weighted: rejects empty list and non-positive total weight", () => {
    expect(() => weighted([])).toThrow();
    expect(() => weighted([{ grader: yes, weight: 0 }])).toThrow();
  });

  test("byName produces stable rationale labels", async () => {
    const r = await all([byName("g1", yes), byName("g2", no)])(sample, baseRun);
    expect(r.rationale).toContain("[g1");
    expect(r.rationale).toContain("[g2");
  });
});

describe("parseGradersConfig + combine (T1+T9)", () => {
  test("compiles deterministic graders", async () => {
    const yaml = `
graders:
  - name: math
    type: exact_match
  - name: re
    type: regex
    pattern: "\\\\d+"
`;
    const { compiled } = parseGradersConfig(yaml);
    expect(compiled).toHaveLength(2);
    expect(compiled[0]?.name).toBe("math");
    const combined = combineCompiledGraders(compiled);
    const r = await combined(sample, { ...baseRun, agentOutput: "hello 42" });
    expect(r.passed).toBe(false); // exact_match fails (hello !== "hello 42")
    expect(r.rationale).toContain("math");
    expect(r.rationale).toContain("re");
  });

  test("llm_judge entries carry judgeSpec instead of executable grader", () => {
    const yaml = `
graders:
  - name: judge
    type: llm_judge
    rubric:
      criteria:
        - name: c1
          description: ok
          anchors: { 1: bad, 2: meh, 3: ok, 4: good, 5: great }
`;
    const { compiled } = parseGradersConfig(yaml);
    expect(compiled[0]?.judgeSpec).toBeDefined();
    expect(compiled[0]?.judgeSpec?.rubric.criteria).toHaveLength(1);
  });

  test("rejects malformed YAML", () => {
    expect(() => parseGradersConfig("nope: [unclosed")).toThrow();
  });

  test("rejects unknown grader type", () => {
    expect(() => parseGradersConfig("graders:\n  - name: x\n    type: unknown\n")).toThrow();
  });
});
