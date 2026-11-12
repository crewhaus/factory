import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { changedSurfaces, surfaceDigests } from "./commit";
import { WILDCARD_SEGMENT } from "./index";
import {
  BUDGET_RAISE_WARNING,
  RENAME_WARNING,
  SECURITY_SURFACES,
  SURFACE_WILDCARD,
  escalationFor,
  surfaceFor,
} from "./surfaces";

describe("security surfaces", () => {
  test("the table's wildcard is the optimizer's wildcard", () => {
    expect(SURFACE_WILDCARD).toBe(WILDCARD_SEGMENT);
  });

  test("surfaceFor finds the row that covers a path, and none for a quality dial", () => {
    expect(surfaceFor(["permissions", "allow", "0"])?.prefix).toEqual(["permissions"]);
    expect(surfaceFor(["steps", "0", "tools"])?.prefix).toEqual(["tools"]);
    expect(surfaceFor(["agent", "instructions"])).toBeUndefined();
    expect(SECURITY_SURFACES.length).toBeGreaterThan(20);
  });
});

const SPEC = `name: demo
target: cli
agent:
  model: claude-opus-5
  instructions: You help.
permissions:
  allow: [Read]
mcp_servers:
  files:
    command: bunx
`;

describe("surfaceDigests", () => {
  test("one digest per row present; rows the spec does not use are left out", () => {
    const digests = surfaceDigests(parse(SPEC));
    expect(Object.keys(digests)).toEqual(["agent.model", "mcp_servers", "model", "permissions"]);
    for (const value of Object.values(digests)) expect(value).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("changing a permission rule changes exactly that row", () => {
    const before = surfaceDigests(parse(SPEC));
    const after = surfaceDigests(parse(SPEC.replace("allow: [Read]", "allow: [Read, Bash]")));
    expect(changedSurfaces(before, after)).toEqual(["permissions"]);
  });

  test("changing the instructions changes none", () => {
    const before = surfaceDigests(parse(SPEC));
    const after = surfaceDigests(parse(SPEC.replace("You help.", "You help kindly.")));
    expect(changedSurfaces(before, after)).toEqual([]);
  });

  test("adding a surface the spec did not have is a change to that row", () => {
    const before = surfaceDigests(parse(SPEC));
    const after = surfaceDigests(parse(`${SPEC}hooks:\n  pre_tool: [./check.sh]\n`));
    expect(changedSurfaces(before, after)).toEqual(["hooks"]);
  });

  test("a digest holds no value", () => {
    const digests = surfaceDigests(parse(SPEC.replace("command: bunx", "command: SENTINEL-77")));
    expect(JSON.stringify(digests)).not.toContain("SENTINEL");
  });
});

describe("escalationFor", () => {
  const spec = (budget?: Record<string, unknown>, name = "demo") => ({
    name,
    target: "cli",
    ...(budget !== undefined ? { budget } : {}),
  });

  test("a rename needs the name typed, with the warning", () => {
    expect(escalationFor(spec(), spec(undefined, "other"))).toEqual([
      { needs: "typed-name", reason: RENAME_WARNING, paths: ["name"] },
    ]);
  });

  const raises: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined]> = [
    ["a higher usd", { usd: 5 }, { usd: 6 }],
    ["the budget removed", { usd: 5 }, undefined],
    ["usd removed", { usd: 5 }, { on_exceed: { action: "stop" } }],
    ["a session scope widened to run", { usd: 5, scope: "session" }, { usd: 5, scope: "run" }],
    ["a session scope removed", { usd: 5, scope: "session" }, { usd: 5 }],
    [
      "stop moved to degrade",
      { usd: 5, on_exceed: { action: "stop" } },
      { usd: 5, on_exceed: { action: "degrade", model: "m" } },
    ],
    [
      "the default stop moved to degrade",
      { usd: 5 },
      { usd: 5, on_exceed: { action: "degrade", model: "m" } },
    ],
  ];
  for (const [label, before, after] of raises) {
    test(`${label} needs the security confirmation`, () => {
      const out = escalationFor(spec(before), spec(after));
      expect(out).toHaveLength(1);
      expect(out[0]?.needs).toBe("h.spec.edit.security");
      expect(out[0]?.reason).toBe(BUDGET_RAISE_WARNING);
    });
  }

  const none: Array<[string, Record<string, unknown> | undefined, Record<string, unknown>]> = [
    ["a first budget", undefined, { usd: 5 }],
    ["a lower usd", { usd: 5 }, { usd: 4 }],
    ["a judge share change", { usd: 5, judge_share: 0.1 }, { usd: 5, judge_share: 0.9 }],
    ["a run scope narrowed to session", { usd: 5 }, { usd: 5, scope: "session" }],
  ];
  for (const [label, before, after] of none) {
    test(`${label} needs nothing`, () => {
      expect(escalationFor(spec(before), spec(after))).toEqual([]);
    });
  }
});
