import { describe, expect, test } from "bun:test";
import { SpecParseError, compile } from "./index";

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
    expect(content).toContain(
      '"line \\"with quotes\\" and \\\\backslashes\\\\ and\\na newline.\\n"',
    );
  });

  test("propagates parse errors as SpecParseError", () => {
    expect(() => compile("not: a: valid: spec")).toThrow(SpecParseError);
  });

  test("emits no tool plumbing when spec omits tools", () => {
    const content = compile(MINIMAL_SPEC).files[0]?.content ?? "";
    expect(content).not.toContain("@crewhaus/tool-catalog");
    expect(content).not.toContain("defaultCatalog.register");
    expect(content).not.toContain("tools:");
  });
});

describe("compile with tools", () => {
  test("threads tools: [read] into the emitted bundle", () => {
    const content =
      compile(`
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
tools:
  - read
`).files[0]?.content ?? "";

    expect(content).toContain('import { defaultCatalog } from "@crewhaus/tool-catalog";');
    expect(content).toContain('import { read } from "@crewhaus/tool-fs";');
    expect(content).toContain("defaultCatalog.register(read);");
    expect(content).toContain("tools: defaultCatalog.list(),");
  });

  test("groups multiple exports from the same package into one import", () => {
    const content =
      compile(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - read
  - write
  - bash
`).files[0]?.content ?? "";

    // tool-fs exports get a single grouped import (sorted: read, write).
    expect(content).toContain('import { read, write } from "@crewhaus/tool-fs";');
    expect(content).toContain('import { bash } from "@crewhaus/tool-bash";');
    expect(content).toContain("defaultCatalog.register(read);");
    expect(content).toContain("defaultCatalog.register(write);");
    expect(content).toContain("defaultCatalog.register(bash);");
  });

  test("rejects unknown tool names at compile time", () => {
    expect(() =>
      compile(`
name: hello
target: cli
agent:
  model: m
  instructions: i
tools:
  - bogus
`),
    ).toThrow(/unknown tool "bogus"/);
  });
});

const MINIMAL_WORKFLOW_SPEC = `
name: hello-workflow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: list
    instructions: list files
    tools:
      - bash
  - name: summarize
    instructions: summarize what you found
`;

describe("compile workflow target", () => {
  test("emits a single-file bundle for a workflow spec", () => {
    const bundle = compile(MINIMAL_WORKFLOW_SPEC);
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("generated workflow bundle imports runChatLoop and contains both step instructions", () => {
    const content = compile(MINIMAL_WORKFLOW_SPEC).files[0]?.content ?? "";
    expect(content).toContain('import { runChatLoop } from "@crewhaus/runtime-core";');
    expect(content).toContain('"list files"');
    expect(content).toContain('"summarize what you found"');
    // Both steps share the workflow-level model.
    expect(content).toContain('"claude-sonnet-4-6"');
  });

  test("generated workflow bundle threads per-step tools", () => {
    const content = compile(MINIMAL_WORKFLOW_SPEC).files[0]?.content ?? "";
    expect(content).toContain('import { bash } from "@crewhaus/tool-bash";');
    expect(content).toContain("tools: [bash]");
  });

  test("per-step model override is resolved at lower-time and emitted", () => {
    const content =
      compile(`
name: w
target: workflow
model: default-model
steps:
  - name: a
    instructions: ai
    model: override-model
  - name: b
    instructions: bi
`).files[0]?.content ?? "";
    expect(content).toContain('"override-model"');
    expect(content).toContain('"default-model"');
  });

  test("rejects an unknown tool name in any workflow step", () => {
    expect(() =>
      compile(`
name: w
target: workflow
model: m
steps:
  - name: a
    instructions: ai
    tools:
      - bogus
`),
    ).toThrow(/unknown tool "bogus"/);
  });

  test("propagates parse errors as SpecParseError for invalid workflow YAML", () => {
    expect(() =>
      compile(`
name: w
target: workflow
model: m
steps: []
`),
    ).toThrow(SpecParseError);
  });
});
