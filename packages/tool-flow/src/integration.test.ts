/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { FLOW_TOOLS } from "./index";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of FLOW_TOOLS) catalog.register(tool);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(FLOW_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of FLOW_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("ErrorClassify"),
      { status: 429, retryAfter: "5" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("rate_limited");
  });

  test("the executor rejects input the schema does not accept", async () => {
    const result = await executeTool(lookup("Branch"), { value: 1, arms: [] }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
  });

  test("a rejected input never reaches execute", async () => {
    const result = await executeTool(
      lookup("DecisionTable"),
      { value: 1, policy: "nonsense", rows: [{ id: "r", when: [{ op: "exists" }], outputs: {} }] },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
  });

  test("an input the schema allows but the library refuses is an error, not a crash", async () => {
    // Two arms sharing a name passes the schema — uniqueness is a property of
    // the list, not of an element — and is caught inside the library.
    const result = await executeTool(
      lookup("Branch"),
      {
        value: 1,
        arms: [
          { name: "same", when: [{ op: "exists" }] },
          { name: "same", when: [{ op: "exists" }] },
        ],
      },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("same");
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    const inputs: Record<string, unknown> = {
      Branch: { value: 1, arms: [{ name: "a", when: [{ op: "exists" }] }] },
      ConsensusVote: { votes: [{ value: "a" }] },
      DeadlineCheck: { budgetMs: 1000, now: 0, startedAt: 0 },
      DecisionTable: {
        value: 1,
        policy: "first",
        rows: [{ id: "r", when: [{ op: "exists" }], outputs: {} }],
      },
      ErrorClassify: { status: 500 },
      RuleScore: { value: 1, rules: [{ id: "r", when: [{ op: "exists" }], points: 1 }] },
      StallDetect: { history: [{ a: "1" }] },
    };
    for (const tool of FLOW_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });
});

describe("the chain these exist to enable", () => {
  test("classify an error, then branch on its action, with no model turn", async () => {
    const classified = await executeTool(
      lookup("ErrorClassify"),
      { status: 429, retryAfter: "30", attempt: 2, maxAttempts: 5 },
      { toolUseId: "c1" },
    );
    const verdict = JSON.parse(classified.content);

    const routed = await executeTool(
      lookup("Branch"),
      {
        value: verdict,
        arms: [
          {
            name: "wait-then-retry",
            when: [
              { path: "action", op: "equals", expected: "retry_after" },
              { path: "waitMs", op: "greaterThan", expected: 0 },
            ],
            result: { sleepMs: verdict.waitMs },
          },
          {
            name: "give-up",
            when: [{ path: "action", op: "equals", expected: "escalate" }],
            result: { notify: true },
          },
        ],
        otherwise: { name: "carry-on" },
      },
      { toolUseId: "c2" },
    );

    expect(JSON.parse(routed.content)).toMatchObject({
      name: "wait-then-retry",
      result: { sleepMs: 30_000 },
    });
  });
});
