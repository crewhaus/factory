import { describe, expect, test } from "bun:test";
import { Spec, SpecParseError, parseSpec } from "./index";

describe("parseSpec", () => {
  test("parses a minimal valid CLI spec", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
`);
    expect(spec.name).toBe("hello");
    expect(spec.target).toBe("cli");
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.model).toBe("claude-sonnet-4-6");
    expect(spec.agent.instructions).toBe("be helpful");
  });

  test("preserves multi-line block-scalar instructions", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: |
    line one.
    line two.
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.instructions).toBe("line one.\nline two.\n");
  });

  test("rejects spec with missing required fields", () => {
    expect(() => parseSpec("name: hello")).toThrow(SpecParseError);
  });

  test("rejects spec with unknown top-level fields (strict mode)", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
extra: nope
`),
    ).toThrow(SpecParseError);
  });

  test("rejects an unsupported target", () => {
    expect(() =>
      parseSpec(`
name: hello
target: channel
agent:
  model: m
  instructions: i
`),
    ).toThrow(SpecParseError);
  });

  test("rejects malformed YAML", () => {
    expect(() => parseSpec("{[\nname: oops")).toThrow(SpecParseError);
  });

  test("error message points at the failing path", () => {
    try {
      parseSpec(`
name: hello
target: cli
agent:
  model: ""
  instructions: ok
`);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SpecParseError);
      expect((err as Error).message).toContain("agent.model");
    }
  });
});

describe("parseSpec tools field", () => {
  test("parses a CLI spec with a tools array", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - read
  - write
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.tools).toEqual(["read", "write"]);
  });

  test("tools field is optional (omitted means undefined)", () => {
    const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
`);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.tools).toBeUndefined();
  });

  test("rejects non-string tool entries", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - 123
`),
    ).toThrow(SpecParseError);
  });

  test("rejects empty-string tool names", () => {
    expect(() =>
      parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - ""
`),
    ).toThrow(SpecParseError);
  });
});

describe("Spec schema", () => {
  test("schema is exported as a runtime value (Zod)", () => {
    expect(typeof Spec.safeParse).toBe("function");
  });
});

describe("parseSpec workflow target", () => {
  test("parses a minimal valid workflow spec", () => {
    const spec = parseSpec(`
name: hello-workflow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: only-step
    instructions: do the thing
`);
    expect(spec.target).toBe("workflow");
    if (spec.target !== "workflow") expect.unreachable();
    expect(spec.name).toBe("hello-workflow");
    expect(spec.model).toBe("claude-sonnet-4-6");
    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0]?.name).toBe("only-step");
    expect(spec.steps[0]?.instructions).toBe("do the thing");
    expect(spec.steps[0]?.model).toBeUndefined();
    expect(spec.steps[0]?.tools).toBeUndefined();
  });

  test("parses a workflow spec with multiple steps and per-step tools", () => {
    const spec = parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
    tools:
      - bash
  - name: b
    instructions: bi
`);
    if (spec.target !== "workflow") expect.unreachable();
    expect(spec.steps).toHaveLength(2);
    expect(spec.steps[0]?.tools).toEqual(["bash"]);
    expect(spec.steps[1]?.tools).toBeUndefined();
  });

  test("parses a workflow spec with per-step model override", () => {
    const spec = parseSpec(`
name: w
target: workflow
model: default-model
steps:
  - name: a
    instructions: ai
    model: override-model
  - name: b
    instructions: bi
`);
    if (spec.target !== "workflow") expect.unreachable();
    expect(spec.steps[0]?.model).toBe("override-model");
    expect(spec.steps[1]?.model).toBeUndefined();
  });

  test("rejects a workflow spec with no steps", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
steps: []
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow step with empty instructions", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ""
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow step with empty name", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: ""
    instructions: ai
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow spec missing top-level model", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
steps:
  - name: a
    instructions: ai
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow spec with extra top-level field (strict)", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
extra: nope
steps:
  - name: a
    instructions: ai
`),
    ).toThrow(SpecParseError);
  });

  test("rejects a workflow step with unknown field (strict)", () => {
    expect(() =>
      parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
    bogus: 1
`),
    ).toThrow(SpecParseError);
  });

  describe("permissions block", () => {
    test("accepts a cli spec with permissions: mode + rules", () => {
      const spec = parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
permissions:
  mode: auto
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysDeny
      pattern: Bash(rm**)
`);
      expect(spec.target).toBe("cli");
      if (spec.target !== "cli") return;
      expect(spec.permissions?.mode).toBe("auto");
      expect(spec.permissions?.rules).toHaveLength(2);
    });

    test("accepts a workflow spec with permissions block", () => {
      const spec = parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
permissions:
  mode: plan
`);
      expect(spec.target).toBe("workflow");
      if (spec.target !== "workflow") return;
      expect(spec.permissions?.mode).toBe("plan");
    });

    test("rejects mode: bypass in cli spec with a friendly security message", () => {
      expect(() =>
        parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
permissions:
  mode: bypass
`),
      ).toThrow(SpecParseError);
      expect(() =>
        parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
permissions:
  mode: bypass
`),
      ).toThrow(/bypass mode is only available via the --permission-mode CLI flag/);
    });

    test("rejects mode: bypass in workflow spec", () => {
      expect(() =>
        parseSpec(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
permissions:
  mode: bypass
`),
      ).toThrow(SpecParseError);
    });

    test("rejects unknown rule type", () => {
      expect(() =>
        parseSpec(`
name: hello
target: cli
agent:
  model: m
  instructions: i
permissions:
  rules:
    - type: neverAllow
      pattern: Read
`),
      ).toThrow(SpecParseError);
    });
  });
});
