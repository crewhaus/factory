/**
 * A worker's build does not check the order of `permissions.rules`: the
 * rule-order check never receives that list there, and the findings are the
 * edge findings `permission-rules.test.ts` pins. In a file of its own, since
 * `mock.module` reaches every file that imports the matcher after it.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import type { PermissionRuleList } from "@crewhaus/tool-permission-matcher";
import { lower, parseSpec } from "./index";

const real = { ...(await import("@crewhaus/tool-permission-matcher")) };
/** The list paths of each call the rule-order check received. */
const received: string[][] = [];
mock.module("@crewhaus/tool-permission-matcher", () => ({
  ...real,
  shadowedPermissionRules: (
    lists: ReadonlyArray<PermissionRuleList>,
    opts?: Parameters<typeof real.shadowedPermissionRules>[1],
  ) => {
    received.push(lists.map((l) => l.path));
    return real.shadowedPermissionRules(lists, opts);
  },
}));
const { permissionRuleFindings } = await import("./permission-rules");

afterAll(() => {
  mock.module("@crewhaus/tool-permission-matcher", () => real);
});

const yaml = `name: t
target: cli
agent:
  model: claude-opus-4-7
  instructions: hi
  sub_agents:
    fixer:
      description: d
      instructions: fix
      tools: [WebFetch]
      permissions:
        allow: ['WebFetch']
        deny: ['WebFetch(https://evil.example.net/**)']
tools: [webFetch]
permissions:
  rules:
    - { type: alwaysAllow, pattern: WebFetch }
    - { type: alwaysDeny, pattern: "WebFetch(https://evil.example.net/**)" }
    - { type: alwaysAsk, pattern: "WebFetch(http://**)" }
    - { type: alwaysDeny, pattern: webFetch }
`;

const said = (list: ReadonlyArray<{ code: string; path: string; message: string }>) =>
  list.map((w) => [w.code, w.path, /^rule "([^"]+)"/.exec(w.message)?.[1]]);

describe("a worker's build and the rule-order check", () => {
  test("a worker's build does not check the order of permissions.rules", () => {
    const spec = parseSpec(yaml);
    received.length = 0;
    const found = permissionRuleFindings(spec, lower(spec), undefined, { edge: true });
    // The sub-agent's lists are still checked.
    expect(received.length).toBeGreaterThan(0);
    expect(received.flat()).toContain("agent.sub_agents.fixer.permissions.deny");
    expect(received.some((paths) => paths.includes("permissions.rules"))).toBe(false);
    expect(said(found)).toEqual([
      ["permission-rule", "permissions.rules", "webFetch"],
      [
        "permission-rule",
        "agent.sub_agents.fixer.permissions.deny",
        "alwaysDeny WebFetch(https://evil.example.net/**)",
      ],
    ]);
  });

  test("a local build checks the order of permissions.rules", () => {
    const spec = parseSpec(yaml);
    received.length = 0;
    permissionRuleFindings(spec, lower(spec));
    expect(received.some((paths) => paths.includes("permissions.rules"))).toBe(true);
  });
});
