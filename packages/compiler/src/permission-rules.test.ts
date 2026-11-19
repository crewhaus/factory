/**
 * The permission-rule findings every build reports: what each finding says,
 * where, how an edge build reads `permissions.rules`, how a caller's live
 * tools describe a listed tool, and that the module stays loadable inside a
 * Cloudflare Worker.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THREDZ_TOOL_NAMES } from "@crewhaus/tool-registry-manifest/flags";
import { type IrNode, lower, parseSpec } from "./index";
import {
  KNOWN_TOOLS,
  PERMISSION_RULE_NOTES,
  type RuleToolResolver,
  collectIrToolNames,
  nonCliBuiltinFlags,
  permissionRuleFindings,
  permissionRuleProblemsOf,
  thredzToolNamesOf,
} from "./permission-rules";

const CLI = "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";

/** The findings for a spec text, read as `opts` says. */
function findings(
  yaml: string,
  resolveTool?: RuleToolResolver,
  opts: { readonly edge?: boolean } = {},
) {
  const spec = parseSpec(yaml);
  return permissionRuleFindings(spec, lower(spec), resolveTool, opts);
}

/** Each finding as its code, its list and the rule it names. */
const said = (list: ReadonlyArray<{ code: string; path: string; message: string }>) =>
  list.map((w) => [w.code, w.path, /^rule "([^"]+)"/.exec(w.message)?.[1]]);

describe("permissionRuleFindings — what each finding says, and where", () => {
  test("with no resolver the builtin manifest describes each tool: a spec key where the name belongs is a finding", () => {
    const yaml = `${CLI}tools: [webFetch]\npermissions:\n  rules:\n    - { type: alwaysAllow, pattern: "*" }\n    - { type: alwaysDeny, pattern: webFetch }\n`;
    const spec = parseSpec(yaml);
    const problems = permissionRuleProblemsOf(spec, lower(spec), undefined, { edge: true });
    expect(problems.map((p) => [p.code, p.list, p.path])).toEqual([
      ["tool-key-not-name", "permissions.rules", "permissions.rules[alwaysDeny webFetch]"],
    ]);
    expect(problems[0]?.message).toContain('Write "WebFetch"');
    expect(findings(yaml, undefined, { edge: true })).toEqual([
      { code: "permission-rule", path: "permissions.rules", message: problems[0]?.message ?? "" },
    ]);
    // Read locally, the deny below the allow is also said to be shadowed.
    expect(permissionRuleProblemsOf(spec, lower(spec)).map((p) => p.code)).toEqual([
      "tool-key-not-name",
      "shadowed-by-allow",
    ]);
  });

  test("a note is never escalated: its code is permission-rule-note", () => {
    const yaml = `${CLI}tools: [read]\npermissions:\n  rules:\n    - { type: alwaysAllow, pattern: "NoSuchTool(**)" }\n`;
    expect(findings(yaml).map((w) => w.code)).toEqual(["permission-rule-note"]);
    const spec = parseSpec(yaml);
    expect(permissionRuleProblemsOf(spec, lower(spec)).map((p) => p.code)).toEqual([
      "tool-not-known",
    ]);
    expect([...PERMISSION_RULE_NOTES].sort()).toEqual([
      "builtin-not-reached",
      "order-not-checked",
      "shadowed-outside-plan",
      "tool-not-known",
    ]);
  });

  test("a spec with no rule list has no finding", () => {
    expect(findings(`${CLI}tools: [webFetch]\n`)).toEqual([]);
  });

  test("the resolver's tool is what is checked; undefined falls back to the manifest", () => {
    const yaml = `${CLI}tools: [clipboardWrite]\npermissions:\n  rules:\n    - { type: alwaysDeny, pattern: "ClipboardWrite(*secret*)" }\n`;
    // The manifest's ClipboardWrite declares no argument that says where it acts.
    expect(said(findings(yaml))).toEqual([
      ["permission-rule", "permissions.rules", "ClipboardWrite(*secret*)"],
    ]);
    expect(said(findings(yaml, () => undefined))).toEqual(said(findings(yaml)));
    // A live tool that declares a field the pattern can match leaves nothing to say.
    const asked: string[] = [];
    const live: RuleToolResolver = (name) => {
      asked.push(name);
      return name === "clipboardWrite"
        ? { name: "ClipboardWrite", operativeArgs: [{ kind: "path", field: "path" }] }
        : undefined;
    };
    expect(findings(yaml, live)).toEqual([]);
    expect(asked).toEqual(["clipboardWrite"]);
  });
});

describe("permissionRuleFindings — an edge build reads permissions.rules in the worker's order", () => {
  const yaml = `${CLI.replace(
    "  instructions: hi\n",
    `  instructions: hi
  sub_agents:
    fixer:
      description: d
      instructions: fix
      tools: [WebFetch]
      permissions:
        allow: ['WebFetch']
        deny: ['WebFetch(https://evil.example.net/**)']
`,
  )}tools: [webFetch]
permissions:
  rules:
    - { type: alwaysAllow, pattern: WebFetch }
    - { type: alwaysDeny, pattern: "WebFetch(https://evil.example.net/**)" }
    - { type: alwaysAsk, pattern: "WebFetch(http://**)" }
    - { type: alwaysDeny, pattern: webFetch }
`;

  test("a local build reads the first rule that matches, so the order findings are said", () => {
    expect(said(findings(yaml))).toEqual([
      ["permission-rule", "permissions.rules", "webFetch"],
      ["permission-rule", "permissions.rules", "alwaysDeny WebFetch(https://evil.example.net/**)"],
      ["permission-rule", "permissions.rules", "alwaysAsk WebFetch(http://**)"],
      [
        "permission-rule",
        "agent.sub_agents.fixer.permissions.deny",
        "alwaysDeny WebFetch(https://evil.example.net/**)",
      ],
    ]);
  });

  test("on the edge the shape's order findings are not said; a sub-agent's list and a spelling finding are", () => {
    expect(said(findings(yaml, undefined, { edge: true }))).toEqual([
      ["permission-rule", "permissions.rules", "webFetch"],
      [
        "permission-rule",
        "agent.sub_agents.fixer.permissions.deny",
        "alwaysDeny WebFetch(https://evil.example.net/**)",
      ],
    ]);
  });

  test("a model profile's tool-key-not-name finding is said on the edge too", () => {
    const profile = `name: t
target: cli
models:
  fast: { model: claude-haiku-4-5, permissions: { deny: ['fetch'] } }
agent:
  model: claude-opus-4-7
  instructions: hi
tools: [fetch]
`;
    const local = said(findings(profile));
    expect(local).toEqual([["permission-rule", "models.fast.permissions.deny", "fetch"]]);
    expect(said(findings(profile, undefined, { edge: true }))).toEqual(local);
    // A profile list holds no allow, so no order finding can arise there.
    const spec = parseSpec(profile);
    for (const opts of [{}, { edge: true }]) {
      expect(
        permissionRuleProblemsOf(spec, lower(spec), undefined, opts).map((p) => p.code),
      ).toEqual(["tool-key-not-name"]);
    }
  });

  test("in plan mode the order is a note locally and nothing on the edge", () => {
    const plan = yaml.replace("permissions:\n  rules:", "permissions:\n  mode: plan\n  rules:");
    const notes = (edge: boolean) =>
      findings(plan, undefined, { edge })
        .filter((w) => w.code === "permission-rule-note" && w.path === "permissions.rules")
        .map((w) => /^rule "([^"]+)"/.exec(w.message)?.[1]);
    expect(notes(false)).toEqual([
      "alwaysDeny WebFetch(https://evil.example.net/**)",
      "alwaysAsk WebFetch(http://**)",
    ]);
    expect(notes(true)).toEqual([]);
  });
});

describe("the rule-order check does a bounded amount of work", () => {
  /** A cli spec whose `permissions.rules` holds 500 allow/deny pairs that shadow nothing. */
  const longList = `${CLI}tools: [webFetch, read]\npermissions:\n  rules:\n${"    - { type: alwaysAllow, pattern: WebFetch }\n    - { type: alwaysDeny, pattern: Read }\n".repeat(500)}`;

  test("a spec over the bound gets one note at the rule and list where the check stopped", () => {
    const found = findings(longList);
    expect(found.map((w) => [w.code, w.path])).toEqual([
      ["permission-rule-note", "permissions.rules"],
    ]);
    expect(found[0]?.message.startsWith('rule "alwaysDeny Read" in permissions.rules')).toBe(true);
    const spec = parseSpec(longList);
    expect(permissionRuleProblemsOf(spec, lower(spec)).map((p) => [p.code, p.path])).toEqual([
      ["order-not-checked", "permissions.rules[alwaysDeny Read]"],
    ]);
  }, 20_000); // 1,000 rules: CI runners are slower on allocation-heavy work

  test("a worker's build does not check the order of permissions.rules", () => {
    expect(findings(longList, undefined, { edge: true })).toEqual([]);
  }, 20_000); // 1,000 rules: CI runners are slower on allocation-heavy work
});

describe("the names a rule can reach", () => {
  test("a crew role's own thredz: block registers the same tools", () => {
    const ir = (roles: unknown[], top?: unknown) =>
      ({
        target: "crew",
        roles,
        ...(top !== undefined ? { thredz: top } : {}),
      }) as unknown as IrNode;
    const memory = [...THREDZ_TOOL_NAMES.memory];
    const all = [...memory, ...THREDZ_TOOL_NAMES.messaging];
    expect(thredzToolNamesOf(ir([{ name: "a" }]))).toEqual([]);
    expect(thredzToolNamesOf(ir([{ name: "a", thredz: {} }]))).toEqual(memory);
    expect(
      thredzToolNamesOf(ir([{ name: "a" }, { name: "b", thredz: { messaging: true } }])),
    ).toEqual(all);
    expect(thredzToolNamesOf(ir([], { messaging: true }))).toEqual(all);
  });

  test("a thredz: block's tools are real tools; without the block they are near misses", () => {
    const base = `${CLI}tools: [read]\npermissions:\n  rules:\n    - { type: alwaysAllow, pattern: goal_list }\n`;
    expect(findings(`${base}thredz: { api_key: $THREDZ_API_KEY, goals: true }\n`)).toEqual([]);
    expect(said(findings(base))).toEqual([["permission-rule", "permissions.rules", "goal_list"]]);
  });

  test("collectIrToolNames gathers every tools: list, as the spec spells it, once", () => {
    expect(
      collectIrToolNames({
        tools: ["webFetch", "read"],
        steps: [{ tools: ["read", "WebSearch"] }, { tools: [3, "grep"] }],
        subAgents: [{ tools: ["WebFetch"] }],
      }),
    ).toEqual(["webFetch", "read", "WebSearch", "grep", "WebFetch"]);
  });

  test("KNOWN_TOOLS holds builtins and runtime-registered names; nonCliBuiltinFlags reads key or name", () => {
    const names = new Set(KNOWN_TOOLS.map((t) => t.name));
    expect(names.has("WebFetch")).toBe(true);
    expect(names.has("Skill")).toBe(true);
    expect(nonCliBuiltinFlags("sendMessage")?.name).toBe("SendMessage");
    expect(nonCliBuiltinFlags("SendMessage")?.key).toBe("sendMessage");
    expect(nonCliBuiltinFlags("webFetch")).toBeUndefined();
  });
});

describe("the module runs inside a Cloudflare Worker", () => {
  /** Every static specifier: `import … from`, `export … from` and a bare `import "x";`. */
  const specifiersOf = (source: string): Array<string | undefined> => [
    ...[...source.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"/gm)].map((m) => m[1]),
    ...[...source.matchAll(/^import\s+"([^"]+)"/gm)].map((m) => m[1]),
  ];

  test("the specifier scan reads every static import and re-export form", () => {
    const sample = [
      "import {",
      "  a1,",
      "  a2,",
      '} from "a";',
      'export { x } from "b";',
      'export * from "c";',
      'import "d";',
      "",
    ].join("\n");
    expect(specifiersOf(sample)).toEqual(["a", "b", "c", "d"]);
  });

  test("it imports only modules a worker bundle can carry", () => {
    const source = readFileSync(join(import.meta.dir, "permission-rules.ts"), "utf8");
    const specifiers = specifiersOf(source);
    expect(specifiers).toEqual([
      "@crewhaus/ir",
      "@crewhaus/tool-permission-matcher",
      "@crewhaus/tool-registry-manifest/flags",
    ]);
    expect(specifiers.some((s) => s?.startsWith(".") || s?.startsWith("node:"))).toBe(false);
    // No dynamic import or require reaches past the static list.
    expect(/\bimport\(|\brequire\(/.test(source)).toBe(false);
  });
});
