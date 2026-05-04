import { describe, expect, test } from "bun:test";
import { parseSpec, Spec, SpecParseError } from "./index";

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
    expect(spec.agent.instructions).toBe("line one.\nline two.\n");
  });

  test("rejects spec with missing required fields", () => {
    expect(() => parseSpec(`name: hello`)).toThrow(SpecParseError);
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

describe("Spec schema", () => {
  test("schema is exported as a runtime value (Zod)", () => {
    expect(typeof Spec.safeParse).toBe("function");
  });
});
