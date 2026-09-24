/**
 * Tool category expansion at lower() time.
 *
 * The contract these tests pin:
 *   - the IR only ever holds concrete tool names, never a selector;
 *   - a spec that uses no category syntax lowers byte-identically;
 *   - every tools-bearing site on every shape gets the grammar, not just
 *     the top-level one;
 *   - `expose.mcp.tools` (a string, not a list) is never touched;
 *   - a bad category or a dead exclusion fails the compile with a path.
 */
import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { expandSpecToolCategories, lower } from "./index";

function irOf(yaml: string): Record<string, unknown> {
  return lower(parseSpec(yaml)) as unknown as Record<string, unknown>;
}

const CLI_HEAD = `
name: t
target: cli
agent:
  model: claude-sonnet-5
  instructions: do the thing
`;

describe("category expansion on the cli shape", () => {
  test("all-fs becomes the five filesystem tools", () => {
    const ir = irOf(`${CLI_HEAD}tools: [all-fs]\n`);
    expect(ir.tools).toEqual(["edit", "glob", "grep", "read", "write"]);
  });

  test("the headline case — a category minus one tool", () => {
    const ir = irOf(`${CLI_HEAD}tools: [all-fs, -write]\n`);
    expect(ir.tools).toEqual(["edit", "glob", "grep", "read"]);
  });

  test("a roll-up expands transitively", () => {
    const ir = irOf(`${CLI_HEAD}tools: [all-code]\n`);
    const tools = ir.tools as string[];
    expect(tools).toContain("read");
    expect(tools).toContain("bash");
    expect(tools).toContain("python");
    expect(tools).toContain("codegraphImpact");
  });

  test("a category can be mixed with individual tools", () => {
    const ir = irOf(`${CLI_HEAD}tools: [all-fs, webFetch]\n`);
    expect(ir.tools).toContain("webFetch");
    expect(ir.tools).toContain("read");
  });

  test("no selector survives into the IR", () => {
    const ir = irOf(`${CLI_HEAD}tools: [all-code, -bash]\n`);
    for (const t of ir.tools as string[]) {
      expect(t.startsWith("all-")).toBe(false);
      expect(t.startsWith("-")).toBe(false);
    }
  });
});

describe("back-compat", () => {
  test("a plain list lowers to exactly itself, order intact", () => {
    const ir = irOf(`${CLI_HEAD}tools: [write, read]\n`);
    expect(ir.tools).toEqual(["write", "read"]);
  });

  test("a spec with no category syntax lowers to the identical object", () => {
    const spec = parseSpec(`${CLI_HEAD}tools: [read]\n`);
    // Same reference back means zero risk of an accidental re-shape.
    expect(expandSpecToolCategories(spec)).toBe(spec);
  });

  test("an absent tools key stays absent", () => {
    const ir = irOf(CLI_HEAD);
    expect(ir.tools).toEqual([]);
  });

  test("an empty list stays empty", () => {
    const ir = irOf(`${CLI_HEAD}tools: []\n`);
    expect(ir.tools).toEqual([]);
  });
});

describe("every tools-bearing site gets the grammar", () => {
  test("workflow steps", () => {
    const ir = irOf(`
name: t
target: workflow
model: claude-sonnet-5
steps:
  - name: one
    instructions: do it
    tools: [all-fs, -write]
`) as unknown as { steps: Array<{ tools: string[] }> };
    expect(ir.steps[0]?.tools).toEqual(["edit", "glob", "grep", "read"]);
  });

  test("graph nodes", () => {
    const ir = irOf(`
name: t
target: graph
model: claude-sonnet-5
entry: a
nodes:
  a:
    instructions: do it
    tools: [all-web]
edges: []
`) as unknown as { nodes: Array<{ name: string; tools?: string[] }> };
    expect(ir.nodes.find((n) => n.name === "a")?.tools).toEqual(["webFetch", "webSearch"]);
  });

  test("sub-agents", () => {
    const ir = irOf(`${CLI_HEAD}  sub_agents:
    helper:
      description: a helper
      instructions: help
      tools: [all-fs, -write, -edit]
tools: [read]
`) as unknown as { subAgents?: Array<{ tools: string[] }> };
    const sub = ir.subAgents?.[0];
    // shape-reach#3 — expanded, then mapped to the registered names the
    // child catalog is filtered by; spec keys here gave the child no tools.
    expect(sub?.tools).toEqual(["Glob", "Grep", "Read"]);
  });
});

describe("expose.mcp.tools is not a tool list and must not be rewritten", () => {
  test("the string value survives expansion untouched", () => {
    const spec = parseSpec(`${CLI_HEAD}tools: [all-fs]
expose:
  mcp:
    transport: stdio
    tools: chat
`);
    const out = expandSpecToolCategories(spec) as unknown as {
      expose: { mcp: { tools: string } };
      tools: string[];
    };
    expect(out.expose.mcp.tools).toBe("chat");
    expect(out.tools).toContain("read");
  });
});

describe("compile errors", () => {
  test("an unknown category fails the compile and lists the known ones", () => {
    expect(() => irOf(`${CLI_HEAD}tools: [all-gti]\n`)).toThrow(/unknown tool category "all-gti"/);
    expect(() => irOf(`${CLI_HEAD}tools: [all-gti]\n`)).toThrow(/all-fs/);
  });

  test("a dead exclusion fails the compile rather than passing silently", () => {
    expect(() => irOf(`${CLI_HEAD}tools: [all-fs, -gitPush]\n`)).toThrow(/nothing includes/);
  });

  test("the error names the offending path so a big spec is navigable", () => {
    expect(() =>
      irOf(`
name: t
target: workflow
model: claude-sonnet-5
steps:
  - name: one
    instructions: do it
    tools: [read]
  - name: two
    instructions: do it
    tools: [all-nope]
`),
    ).toThrow(/steps\[1\]\.tools/);
  });
});
