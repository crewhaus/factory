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
  expectedContains,
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

describe("expectedContains (NEW-E-3)", () => {
  test("passes when output contains the sample's expected_output", async () => {
    const r = await expectedContains()(sample, { ...baseRun, agentOutput: "well hello there" });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  test("compares against the trimmed gold", async () => {
    const padded: Sample = { id: "s2", input: "hi", expected_output: "  hello\n" };
    const r = await expectedContains()(padded, { ...baseRun, agentOutput: "oh hello there" });
    expect(r.passed).toBe(true);
  });

  test("caseInsensitive flag", async () => {
    const r = await expectedContains({ caseInsensitive: true })(sample, {
      ...baseRun,
      agentOutput: "HELLO WORLD",
    });
    expect(r.passed).toBe(true);
  });

  test("fails when output misses the gold", async () => {
    const r = await expectedContains()(sample, { ...baseRun, agentOutput: "goodbye" });
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("missing expected_output");
  });

  test("fails when expected_output missing", async () => {
    const r = await expectedContains()({ id: "x", input: "" }, baseRun);
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("no expected_output");
  });

  test("fails on an empty expected_output — '' is a substring of everything", async () => {
    const empty: Sample = { id: "x", input: "hi", expected_output: "" };
    const r = await expectedContains()(empty, { ...baseRun, agentOutput: "totally unrelated" });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.rationale).toContain("empty after trimming");
  });

  test("fails on a whitespace-only expected_output", async () => {
    const blank: Sample = { id: "x", input: "hi", expected_output: "  \n\t" };
    const r = await expectedContains()(blank, { ...baseRun, agentOutput: "anything" });
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("empty after trimming");
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

  test("compiles an `expected_contains` grader honoring case_insensitive", async () => {
    const { compiled } = parseGradersConfig(`
graders:
  - name: gold
    type: expected_contains
    case_insensitive: true
`);
    expect(compiled[0]?.name).toBe("gold");
    const r = await combineCompiledGraders(compiled)(sample, {
      ...baseRun,
      agentOutput: "well HELLO there",
    });
    expect(r.passed).toBe(true);
  });

  test("rejects malformed YAML", () => {
    expect(() => parseGradersConfig("nope: [unclosed")).toThrow();
  });

  test("rejects unknown grader type", () => {
    expect(() => parseGradersConfig("graders:\n  - name: x\n    type: unknown\n")).toThrow();
  });
});

describe("parseGradersConfig — llm_judge decoding fields (NEW-HUNT-2)", () => {
  const JUDGE_YAML = (extra: string) => `
graders:
  - name: judge
    type: llm_judge
${extra}
    rubric:
      criteria:
        - name: c1
          description: ok
          anchors: { 1: bad, 2: meh, 3: ok, 4: good, 5: great }
`;

  test("accepts rubric-level temperature and repeats; judgeSpec carries them", () => {
    const { compiled } = parseGradersConfig(JUDGE_YAML("    temperature: 0.5\n    repeats: 3"));
    expect(compiled[0]?.judgeSpec?.temperature).toBe(0.5);
    expect(compiled[0]?.judgeSpec?.repeats).toBe(3);
  });

  test("backward compat: absent fields leave judgeSpec without the keys", () => {
    const { compiled } = parseGradersConfig(JUDGE_YAML(""));
    const judgeSpec = compiled[0]?.judgeSpec;
    expect(judgeSpec).toBeDefined();
    expect(judgeSpec !== undefined && "temperature" in judgeSpec).toBe(false);
    expect(judgeSpec !== undefined && "repeats" in judgeSpec).toBe(false);
  });

  test("rejects out-of-range temperature", () => {
    expect(() => parseGradersConfig(JUDGE_YAML("    temperature: 1.5"))).toThrow(
      /invalid graders config/,
    );
    expect(() => parseGradersConfig(JUDGE_YAML("    temperature: -0.1"))).toThrow(
      /invalid graders config/,
    );
  });

  test("rejects even, zero, negative, and fractional repeats", () => {
    expect(() => parseGradersConfig(JUDGE_YAML("    repeats: 2"))).toThrow(
      /invalid graders config/,
    );
    expect(() => parseGradersConfig(JUDGE_YAML("    repeats: 0"))).toThrow(
      /invalid graders config/,
    );
    expect(() => parseGradersConfig(JUDGE_YAML("    repeats: -3"))).toThrow(
      /invalid graders config/,
    );
    expect(() => parseGradersConfig(JUDGE_YAML("    repeats: 1.5"))).toThrow(
      /invalid graders config/,
    );
  });

  test("accepts repeats: 1 (the explicit default) and pinned temperature: 0", () => {
    const { compiled } = parseGradersConfig(JUDGE_YAML("    temperature: 0\n    repeats: 1"));
    expect(compiled[0]?.judgeSpec?.temperature).toBe(0);
    expect(compiled[0]?.judgeSpec?.repeats).toBe(1);
  });

  test("strict llm_judge entries: a typoed decoding key fails loudly, never silently strips", () => {
    // A stripped `temperture:` would judge with the pinned defaults while
    // the user believes their override applied.
    expect(() => parseGradersConfig(JUDGE_YAML("    temperture: 0.5"))).toThrow(
      /invalid graders config/,
    );
    expect(() => parseGradersConfig(JUDGE_YAML("    repeat: 3"))).toThrow(/invalid graders config/);
  });
});

describe("parseGradersConfig — weight + combine (A4/A5)", () => {
  test("accepts a positive weight on every grader variant", () => {
    const { compiled } = parseGradersConfig(`
graders:
  - name: em
    type: exact_match
    weight: 2
  - name: c
    type: contains
    substring: ok
    weight: 0.5
  - name: ec
    type: expected_contains
    weight: 3
  - name: re
    type: regex
    pattern: x
    weight: 1.5
  - name: jp
    type: json_path
    path: $.a
    weight: 4
  - name: seq
    type: tool_call_sequence
    expected: [bash]
    weight: 2.5
  - name: judge
    type: llm_judge
    weight: 5
    rubric:
      criteria:
        - name: c1
          description: ok
          anchors: { 1: bad, 2: meh, 3: ok, 4: good, 5: great }
  - name: reg
    type: registry
    grader: continuity.reAskRate
    weight: 6
`);
    expect(compiled.map((g) => g.weight)).toEqual([2, 0.5, 3, 1.5, 4, 2.5, 5, 6]);
  });

  test("defaults weight to 1 when undeclared", () => {
    const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");
    expect(compiled[0]?.weight).toBe(1);
  });

  test("rejects zero and negative weights", () => {
    expect(() =>
      parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n    weight: 0\n"),
    ).toThrow(/invalid graders config/);
    expect(() =>
      parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n    weight: -1\n"),
    ).toThrow(/invalid graders config/);
  });

  test("rejects an unknown combine mode", () => {
    expect(() =>
      parseGradersConfig("combine: maybe\ngraders:\n  - name: m\n    type: exact_match\n"),
    ).toThrow(/invalid graders config/);
  });

  test("rejects unknown TOP-LEVEL keys (typos must fail loudly, not silently strip)", () => {
    // `combined:` / `passing_treshold:` typos would otherwise parse cleanly
    // and run in default `all` mode with the declared policy ignored.
    expect(() =>
      parseGradersConfig("combined: weighted\ngraders:\n  - name: m\n    type: exact_match\n"),
    ).toThrow(/invalid graders config/);
    expect(() =>
      parseGradersConfig("passing_treshold: 0.7\ngraders:\n  - name: m\n    type: exact_match\n"),
    ).toThrow(/invalid graders config/);
  });

  test("rejects an out-of-range passing_threshold", () => {
    expect(() =>
      parseGradersConfig("passing_threshold: 1.5\ngraders:\n  - name: m\n    type: exact_match\n"),
    ).toThrow(/invalid graders config/);
  });

  test("stamps the combine policy onto every compiled entry", () => {
    const { compiled } = parseGradersConfig(`
combine: weighted
passing_threshold: 0.7
graders:
  - name: a
    type: exact_match
  - name: b
    type: contains
    substring: ok
`);
    for (const g of compiled) {
      expect(g.combine).toEqual({ mode: "weighted", passingThreshold: 0.7 });
    }
  });

  test("passing_threshold without combine stamps mode `all` so the runner can warn", () => {
    const { compiled } = parseGradersConfig(
      "passing_threshold: 0.9\ngraders:\n  - name: m\n    type: exact_match\n",
    );
    expect(compiled[0]?.combine).toEqual({ mode: "all", passingThreshold: 0.9 });
  });

  test("no combine and no passing_threshold leaves compiled entries policy-free", () => {
    const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");
    expect(compiled[0]?.combine).toBeUndefined();
  });
});

describe("combineCompiledGraders — combine policy (A4/A5)", () => {
  test("combine: any passes when any grader passes; score = max", async () => {
    const { compiled } = parseGradersConfig(`
combine: any
graders:
  - name: nope
    type: contains
    substring: zzz
  - name: yep
    type: contains
    substring: ell
`);
    const r = await combineCompiledGraders(compiled)(sample, baseRun);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  test("combine: weighted gates the weighted score on passing_threshold", async () => {
    const { compiled } = parseGradersConfig(`
combine: weighted
passing_threshold: 0.8
graders:
  - name: hit
    type: contains
    substring: ell
    weight: 3
  - name: miss
    type: contains
    substring: zzz
    weight: 1
`);
    const r = await combineCompiledGraders(compiled)(sample, baseRun);
    expect(r.score).toBeCloseTo(0.75);
    expect(r.passed).toBe(false); // 0.75 < 0.8
  });

  test("combine: weighted defaults the threshold to 0.5", async () => {
    const { compiled } = parseGradersConfig(`
combine: weighted
graders:
  - name: hit
    type: contains
    substring: ell
  - name: miss
    type: contains
    substring: zzz
`);
    const r = await combineCompiledGraders(compiled)(sample, baseRun);
    expect(r.score).toBe(0.5);
    expect(r.passed).toBe(true); // exactly at the default cut
  });
});
