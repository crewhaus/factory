import { describe, expect, test } from "bun:test";
import { compile, SpecParseError } from "./index";

const MINIMAL_SPEC = `
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
`;

describe("compile", () => {
  test("emits a single-file bundle for a minimal CLI spec", () => {
    const bundle = compile(MINIMAL_SPEC);
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("generated bundle imports the runtime and configures the model", () => {
    const bundle = compile(MINIMAL_SPEC);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain('from "@crewhaus/runtime-core"');
    expect(content).toContain("runChatLoop");
    expect(content).toContain('"claude-sonnet-4-6"');
    expect(content).toContain("be helpful");
  });

  test("generated bundle escapes instructions safely (no raw injection)", () => {
    const bundle = compile(`
name: tricky
target: cli
agent:
  model: m
  instructions: |
    line "with quotes" and \\backslashes\\ and
    a newline.
`);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain('"line \\"with quotes\\" and \\\\backslashes\\\\ and\\na newline.\\n"');
  });

  test("propagates parse errors as SpecParseError", () => {
    expect(() => compile("not: a: valid: spec")).toThrow(SpecParseError);
  });
});
