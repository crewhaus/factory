/**
 * Loop contract 0.4 (Batch B, G04) — `parseSpecIssues(yamlText)`: the
 * structured, non-throwing diagnostics surface. Built on the same
 * internals as `parseSpec`, so anything parseSpec accepts yields `[]` and
 * anything it rejects yields at least one issue.
 */
import { describe, expect, test } from "bun:test";
import { parseSpec, parseSpecIssues } from "./index";

const MINIMAL_CLI = ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i"].join(
  "\n",
);

describe("parseSpecIssues — valid specs", () => {
  test("a valid spec returns an empty list", () => {
    expect(parseSpecIssues(MINIMAL_CLI)).toEqual([]);
  });
});

describe("parseSpecIssues — YAML syntax errors", () => {
  test("path [] + code yaml_syntax + line/column in the message", () => {
    const issues = parseSpecIssues("a: [1,");
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    if (issue === undefined) throw new Error("expected one issue");
    expect(issue.path).toEqual([]);
    expect(issue.code).toBe("yaml_syntax");
    expect(issue.message).toMatch(/^invalid YAML: /);
    expect(issue.message).toMatch(/line \d+, column \d+/);
  });

  test("parseSpec throws on the same input", () => {
    expect(() => parseSpec("a: [1,")).toThrow(/invalid YAML/);
  });
});

describe("parseSpecIssues — schema failures (zod mapping)", () => {
  test("a missing required field reports its exact path and zod code", () => {
    const issues = parseSpecIssues(
      ["name: c", "target: cli", "agent:", "  instructions: i"].join("\n"),
    );
    expect(issues).toEqual([
      { path: ["agent", "model"], message: "Required", code: "invalid_type" },
    ]);
  });

  test("multiple independent failures are ALL reported", () => {
    const issues = parseSpecIssues(["target: cli", "agent:", "  model: m"].join("\n"));
    const paths = issues.map((i) => i.path.join("."));
    expect(paths).toContain("name");
    expect(paths).toContain("agent.instructions");
    expect(issues.length).toBe(2);
  });

  test("unrecognized keys carry the unrecognized_keys code", () => {
    const issues = parseSpecIssues(`${MINIMAL_CLI}\nbanana: true`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("unrecognized_keys");
    expect(issues[0]?.message).toContain("banana");
  });

  test("array paths use numeric segments", () => {
    const issues = parseSpecIssues(
      [
        "name: w",
        "target: workflow",
        "model: m",
        "steps:",
        "  - name: a",
        "    instructions: x",
        "  - name: b",
        "    instructions: ''",
      ].join("\n"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["steps", 1, "instructions"]);
    expect(issues[0]?.code).toBe("too_small");
  });

  test("invalid_union flattens to the most plausible branch (typo'd judge step)", () => {
    const issues = parseSpecIssues(
      [
        "name: w",
        "target: workflow",
        "model: m",
        "steps:",
        "  - name: a",
        "    instructions: x",
        "  - name: gate",
        "    kind: judge",
        "    judge:",
        "      criteri: oops",
      ].join("\n"),
    );
    expect(issues).toEqual([
      { path: ["steps", 1, "judge", "criteria"], message: "Required", code: "invalid_type" },
      {
        path: ["steps", 1, "judge"],
        message: "Unrecognized key(s) in object: 'criteri'",
        code: "unrecognized_keys",
      },
    ]);
  });

  test("evaluation.threshold on a deterministic grader reports the superRefine path", () => {
    const issues = parseSpecIssues(
      [
        MINIMAL_CLI,
        "evaluation:",
        "  grader: {type: contains, value: ok}",
        "  threshold: 0.5",
      ].join("\n"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["evaluation", "threshold"]);
    expect(issues[0]?.code).toBe("custom");
  });
});

describe("parseSpecIssues — the bypass rejection", () => {
  test("permissions.mode: bypass reports its path with the policy message", () => {
    const issues = parseSpecIssues([MINIMAL_CLI, "permissions:", "  mode: bypass"].join("\n"));
    expect(issues).toEqual([
      {
        path: ["permissions", "mode"],
        code: "custom",
        message:
          "permissions.mode: bypass is rejected — bypass mode is only available via the --permission-mode CLI flag, never from a spec file",
      },
    ]);
  });
});

describe("parseSpecIssues — cross-field invariants", () => {
  test("crew entry not in roles → path [entry]", () => {
    const issues = parseSpecIssues(
      [
        "name: cr",
        "target: crew",
        "model: m",
        "entry: ghost",
        "roles:",
        "  writer:",
        "    instructions: w",
      ].join("\n"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["entry"]);
    expect(issues[0]?.code).toBe("custom");
  });

  test("graph when.key naming an unknown node → path [edges, i, when, key]", () => {
    const issues = parseSpecIssues(
      [
        "name: g",
        "target: graph",
        "model: m",
        "entry: a",
        "nodes:",
        "  a: {instructions: x}",
        "  b: {instructions: y}",
        "edges:",
        "  - {from: a, to: b, when: {key: ghost, exists: true}}",
      ].join("\n"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["edges", 0, "when", "key"]);
  });

  test("pipeline HTTP backend without url AND collection reports BOTH issues", () => {
    const issues = parseSpecIssues(
      [
        "name: p",
        "target: pipeline",
        "agent: {model: m, instructions: i}",
        "retrieve:",
        "  embedderModel: e",
        "  vectorBackend: qdrant",
        "indexing:",
        "  documents:",
        "    - {id: d1, text: hello}",
      ].join("\n"),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["retrieve.url", "retrieve.collection"]);
    // parseSpec throws the FIRST of the two (historical behaviour).
    expect(() =>
      parseSpec(
        [
          "name: p",
          "target: pipeline",
          "agent: {model: m, instructions: i}",
          "retrieve:",
          "  embedderModel: e",
          "  vectorBackend: qdrant",
          "indexing:",
          "  documents:",
          "    - {id: d1, text: hello}",
        ].join("\n"),
      ),
    ).toThrow(/requires retrieve\.url/);
  });

  test("first-step judge and judge-entry invariants surface as issues", () => {
    const wf = parseSpecIssues(
      [
        "name: w",
        "target: workflow",
        "model: m",
        "steps:",
        "  - name: gate",
        "    kind: judge",
        "    judge: {criteria: x}",
      ].join("\n"),
    );
    expect(wf).toHaveLength(1);
    expect(wf[0]?.path).toEqual(["steps", 0]);

    const graph = parseSpecIssues(
      [
        "name: g",
        "target: graph",
        "model: m",
        "entry: gate",
        "nodes:",
        "  gate:",
        "    kind: judge",
        "    judge: {criteria: x}",
        "  work: {instructions: w}",
      ].join("\n"),
    );
    expect(graph).toHaveLength(1);
    expect(graph[0]?.path).toEqual(["entry"]);
  });
});
