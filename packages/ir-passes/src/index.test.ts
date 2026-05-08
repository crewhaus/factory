/**
 * Section 28 — `ir-passes` tests:
 *  - T1 per built-in pass
 *  - T9 idempotence (apply(apply(x)) === apply(x))
 *  - T4 fixture replay
 */
import { describe, expect, test } from "bun:test";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import {
  DEFAULT_PIPELINE,
  applyPasses,
  deadToolElimination,
  permissionRuleCanonicalize,
  promptCachePrefixSort,
  redundantMcpServerCollapse,
} from "./index";

function makeCli(overrides: Partial<IrV0> = {}): IrV0 {
  return {
    version: 0,
    name: "test",
    target: "cli",
    agent: { model: "claude-opus-4-7", instructions: "be helpful" },
    tools: [],
    toolConfigs: {},
    mcp_servers: {},
    permissions: { rules: [] },
    subAgents: [],
    compaction: {},
    ...overrides,
  };
}

describe("ir-passes — deadToolElimination (T1)", () => {
  test("no rules + no sub-agents → returns input unchanged (no inference)", () => {
    const ir = makeCli({ tools: ["Read", "Write", "Bash"] });
    const out = deadToolElimination(ir) as IrV0;
    expect(out.tools).toEqual(ir.tools);
  });

  test("with rules referring only to Read+Bash → drops Write", () => {
    const ir = makeCli({
      tools: ["Read", "Write", "Bash"],
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysAllow", pattern: "Bash(*)" },
        ],
      },
    });
    const out = deadToolElimination(ir) as IrV0;
    expect([...out.tools].sort()).toEqual(["Bash", "Read"]);
  });

  test("sub-agent that uses Write keeps Write in the parent's tool list", () => {
    const ir = makeCli({
      tools: ["Read", "Write"],
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Read" }] },
      subAgents: [
        {
          name: "writer",
          description: "writes files",
          instructions: "x",
          tools: ["Write"],
          permissions: "inherit",
          inheritBypass: false,
        },
      ],
    });
    const out = deadToolElimination(ir) as IrV0;
    expect([...out.tools].sort()).toEqual(["Read", "Write"]);
  });

  test("non-cli targets pass through unchanged", () => {
    // Use a fixture-shaped non-cli IR
    const ir: IrNode = {
      version: 0,
      name: "wf",
      target: "workflow",
      steps: [],
    } as unknown as IrNode;
    expect(deadToolElimination(ir)).toBe(ir);
  });
});

describe("ir-passes — redundantMcpServerCollapse (T1)", () => {
  test("dedup stdio servers by (command, args)", () => {
    const ir = makeCli({
      mcp_servers: {
        a: { transport: "stdio", command: "npx", args: ["@x"] },
        b: { transport: "stdio", command: "npx", args: ["@x"] },
        c: { transport: "stdio", command: "npx", args: ["@y"] },
      },
    });
    const out = redundantMcpServerCollapse(ir) as IrV0;
    expect(Object.keys(out.mcp_servers).sort()).toEqual(["a", "c"]);
  });

  test("dedup sse servers by url", () => {
    const ir = makeCli({
      mcp_servers: {
        a: { transport: "sse", url: "http://x" },
        b: { transport: "sse", url: "http://x" },
        c: { transport: "sse", url: "http://y" },
      },
    });
    const out = redundantMcpServerCollapse(ir) as IrV0;
    expect(Object.keys(out.mcp_servers).sort()).toEqual(["a", "c"]);
  });

  test("returns input unchanged when no duplicates", () => {
    const ir = makeCli({
      mcp_servers: {
        a: { transport: "stdio", command: "x", args: [] },
      },
    });
    expect(redundantMcpServerCollapse(ir)).toBe(ir);
  });
});

describe("ir-passes — permissionRuleCanonicalize (T1)", () => {
  test("sorts by tier (deny > ask > allow) then alpha within tier", () => {
    const ir = makeCli({
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysDeny", pattern: "Bash(rm *)" },
          { type: "alwaysAsk", pattern: "Edit" },
          { type: "alwaysAllow", pattern: "Bash" },
          { type: "alwaysDeny", pattern: "Write" },
        ],
      },
    });
    const out = permissionRuleCanonicalize(ir) as IrV0;
    expect(out.permissions.rules.map((r) => `${r.type}:${r.pattern}`)).toEqual([
      "alwaysDeny:Bash(rm *)",
      "alwaysDeny:Write",
      "alwaysAsk:Edit",
      "alwaysAllow:Bash",
      "alwaysAllow:Read",
    ]);
  });

  test("dedups exact duplicates", () => {
    const ir = makeCli({
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysAllow", pattern: "Bash" },
        ],
      },
    });
    const out = permissionRuleCanonicalize(ir) as IrV0;
    expect(out.permissions.rules.length).toBe(2);
  });

  test("returns input unchanged when already canonical", () => {
    const ir = makeCli({
      permissions: {
        rules: [
          { type: "alwaysDeny", pattern: "Bash(rm *)" },
          { type: "alwaysAllow", pattern: "Read" },
        ],
      },
    });
    const out = permissionRuleCanonicalize(ir);
    expect(out).toBe(ir);
  });
});

describe("ir-passes — promptCachePrefixSort (T1 stub)", () => {
  test("v0 stub returns input unchanged", () => {
    const ir = makeCli();
    expect(promptCachePrefixSort(ir)).toBe(ir);
  });
});

describe("ir-passes — applyPasses + idempotence (T9)", () => {
  test("applyPasses runs the default pipeline", () => {
    const ir = makeCli({
      tools: ["Read", "Write", "Bash"],
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysAllow", pattern: "Read" },
        ],
      },
      mcp_servers: {
        a: { transport: "stdio", command: "x", args: [] },
        b: { transport: "stdio", command: "x", args: [] },
      },
    });
    const once = applyPasses(ir) as IrV0;
    expect([...once.tools].sort()).toEqual(["Read"]);
    expect(once.permissions.rules.length).toBe(1);
    expect(Object.keys(once.mcp_servers).length).toBe(1);
  });

  test("idempotence: applyPasses(applyPasses(x)) === applyPasses(x)", () => {
    const ir = makeCli({
      tools: ["Read", "Write", "Bash"],
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysDeny", pattern: "Bash" },
        ],
      },
      mcp_servers: {
        a: { transport: "stdio", command: "x", args: ["y"] },
        b: { transport: "stdio", command: "x", args: ["y"] },
      },
    });
    const a = applyPasses(ir);
    const b = applyPasses(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("custom pipeline applied in order", () => {
    const calls: string[] = [];
    const passes = [
      (n: IrNode) => {
        calls.push("a");
        return n;
      },
      (n: IrNode) => {
        calls.push("b");
        return n;
      },
    ];
    applyPasses(makeCli(), { passes });
    expect(calls).toEqual(["a", "b"]);
  });

  test("DEFAULT_PIPELINE has 4 passes", () => {
    expect(DEFAULT_PIPELINE.length).toBe(4);
  });
});
