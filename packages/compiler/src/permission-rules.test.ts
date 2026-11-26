/**
 * The permission-rule findings every build reports: what each finding says,
 * where, how an edge build reads `permissions.rules`, how a caller's live
 * tools describe a listed tool, and that the module stays loadable inside a
 * Cloudflare Worker.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as matcher from "@crewhaus/tool-permission-matcher";
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
      "rule-not-checked",
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
  /** A cli spec whose `permissions.rules` holds 600 allow/deny pairs that shadow nothing. */
  const longList = `${CLI}tools: [webFetch, read]\npermissions:\n  rules:\n${"    - { type: alwaysAllow, pattern: WebFetch* }\n    - { type: alwaysDeny, pattern: Read }\n".repeat(600)}`;

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
  }, 20_000); // 1,200 rules: CI runners are slower on allocation-heavy work

  test("a worker's build does not check the order of permissions.rules", () => {
    expect(findings(longList, undefined, { edge: true })).toEqual([]);
  }, 20_000); // 1,200 rules: CI runners are slower on allocation-heavy work
});

describe("the per-rule checks do a bounded amount of work", () => {
  /** A deny that reaches no tool and no server, whose matches against the known names holding an `a` and an `e` spend the bound. */
  const LONG = `${"**".repeat(4000)}ae`;
  /** A cli spec with these sub-agents (`name: deny pattern`). */
  const withSubAgents = (denies: ReadonlyArray<readonly [string, string]>): string =>
    `${CLI.replace(
      "  instructions: hi\n",
      `  instructions: hi\n  sub_agents:\n${denies
        .map(
          ([name, pattern]) =>
            `    ${name}:\n      description: d\n      instructions: x\n      permissions:\n        allow: []\n        deny: ['${pattern}']\n`,
        )
        .join("")}`,
    )}tools: [read]\n`;

  test("one bound for a spec's lists: once a list spends it, one note, and no finding from a later list", () => {
    const later = withSubAgents([["b", "webFetch"]]);
    expect(said(findings(later))).toEqual([
      ["permission-rule", "agent.sub_agents.b.permissions.deny", "webFetch"],
    ]);
    const found = findings(
      withSubAgents([
        ["a", LONG],
        ["b", "webFetch"],
      ]),
    );
    expect(said(found)).toEqual([
      ["permission-rule-note", "agent.sub_agents.a.permissions.deny", `alwaysDeny ${LONG}`],
    ]);
    expect(found[0]?.message).toBe(
      `rule "alwaysDeny ${LONG}": the permission rule checks do a bounded amount of work and stopped here, so this rule, the rules after it and any later list were not checked for a tool name or argument that can never match.`,
    );
  }, 20_000); // the whole bound's matching: slow on CI runners

  test("ordinary specs get the findings of checks with no bound", () => {
    const servers = [
      "github",
      "gitlab",
      "slack",
      "linear",
      "notion",
      "jira",
      "asana",
      "figma",
      "stripe",
      "sentry",
    ];
    const others = servers.filter((s) => s !== "linear");
    const mcpServers = `mcp_servers:\n${servers
      .map((s) => `  ${s}:\n    transport: sse\n    url: https://${s}.example.com/sse\n`)
      .join("")}`;
    const rules = (list: ReadonlyArray<readonly [string, string]>): string =>
      `permissions:\n  rules:\n${list
        .map(([type, pattern]) => `    - { type: ${type}, pattern: "${pattern}" }\n`)
        .join("")}`;
    // 92 rules: one server's wildcard allow, 45 tools of other servers
    // allowed by name, 45 asked for by name, then a deny the first beats.
    const mcpNamed = `${CLI}tools: [read]\n${mcpServers}${rules([
      ["alwaysAllow", "mcp__linear__*"],
      ...Array.from(
        { length: 45 },
        (_, i) => ["alwaysAllow", `mcp__${others[i % others.length]}__read_${i}`] as const,
      ),
      ...Array.from(
        { length: 45 },
        (_, i) => ["alwaysAsk", `mcp__${others[i % others.length]}__write_${i}`] as const,
      ),
      ["alwaysDeny", "mcp__linear__delete_project"],
    ])}`;
    // 300 rules of builtins and MCP tools, with typos among them.
    const ordinaryRules: Array<readonly [string, string]> = [];
    const typos = ["Reed", "webFetch", "REMOVEPATH", "Bassh", "mcp__nope__x", "read_file"];
    for (let i = 0; i < 300; i++) {
      const kind = i % 10;
      ordinaryRules.push(
        kind === 0
          ? ["alwaysDeny", typos[(i / 10) % typos.length] as string]
          : kind < 4
            ? ["alwaysAllow", `mcp__${servers[i % servers.length]}__tool_${i}`]
            : kind < 6
              ? ["alwaysAsk", `Bash(git push ${i}*)`]
              : kind < 8
                ? ["alwaysDeny", `Read(secrets/${i}/**)`]
                : ["alwaysAllow", `WebFetch(https://api${i}.example.com/**)`],
      );
    }
    const ordinary = `${CLI}tools: [read, write, bash, webFetch, removePath]\n${mcpServers}${rules(
      ordinaryRules,
    )}`;
    /** A cli spec with these sub-agents (`name`, their denies), and the tool `read`. */
    const subAgents = (agents: ReadonlyArray<readonly [string, ReadonlyArray<string>]>): string =>
      `${CLI.replace(
        "  instructions: hi\n",
        `  instructions: hi\n  sub_agents:\n${agents
          .map(
            ([name, denies]) =>
              `    ${name}:\n      description: d\n      instructions: x\n      permissions:\n        allow: []\n        deny: [${denies.map((d) => `'${d}'`).join(", ")}]\n`,
          )
          .join("")}`,
      )}tools: [read]\n`;
    const words = [
      "*production*",
      "*billing*",
      "*payroll*",
      "*customer*",
      "*secret*",
      "*credential*",
      "*invoice*",
      "*refund*",
      "*_admin",
      "*_delete",
      "*_drop",
      "*_wipe",
    ];
    // 25 sub-agents that each deny the same 12 words, then one more whose
    // deny is a spec key: 301 rules.
    const sharedWords = subAgents([
      ...Array.from({ length: 25 }, (_, i) => [`s${i}`, words] as const),
      ["last", ["webFetch"]],
    ]);
    const actions = [
      "*delete_database*",
      "*drop_production_table*",
      "*deploy_to_production*",
      "*send_customer_email*",
      "*rotate_credentials*",
      "*force_push_branch*",
    ];
    const verbs = [
      "delete",
      "drop",
      "deploy",
      "send",
      "rotate",
      "push",
      "wipe",
      "purge",
      "reset",
      "revoke",
      "transfer",
      "publish",
      "merge",
      "close",
      "archive",
    ];
    const nouns = [
      "database",
      "table",
      "bucket",
      "branch",
      "invoice",
      "account",
      "cluster",
      "secret",
      "release",
      "channel",
    ];
    // 20 sub-agents that each deny the same six actions, one with 150
    // distinct ones, then one whose deny is a spec key: 271 rules.
    const sharedActions = subAgents([
      ...Array.from({ length: 20 }, (_, i) => [`a${i}`, actions] as const),
      ["many", verbs.flatMap((v) => nouns.map((n) => `*${v}_${n}*`))],
      ["last", ["webFetch"]],
    ]);
    const specs = [
      `${CLI}tools: [webFetch]\npermissions:\n  rules:\n    - { type: alwaysAllow, pattern: WebFetch }\n    - { type: alwaysDeny, pattern: "WebFetch(https://evil.example.net/**)" }\n    - { type: alwaysDeny, pattern: webFetch }\n`,
      `${CLI}tools: [clipboardWrite]\npermissions:\n  rules:\n    - { type: alwaysDeny, pattern: "ClipboardWrite(*secret*)" }\n`,
      `${CLI}tools: [read]\npermissions:\n  rules:\n    - { type: alwaysAllow, pattern: "NoSuchTool(**)" }\n`,
      withSubAgents([["b", "webFetch"]]),
      mcpNamed,
      ordinary,
      sharedWords,
      sharedActions,
    ];
    const bounded = specs.map((yaml) => findings(yaml));
    const real = matcher.permissionRuleProblems;
    const unboundedCalls = spyOn(matcher, "permissionRuleProblems").mockImplementation((input) =>
      real({ ...input, budget: { steps: Number.POSITIVE_INFINITY } }),
    );
    let unbounded: ReturnType<typeof findings>[];
    try {
      unbounded = specs.map((yaml) => findings(yaml));
      expect(unboundedCalls.mock.calls.length).toBeGreaterThanOrEqual(specs.length);
    } finally {
      unboundedCalls.mockRestore();
    }
    expect(bounded).toEqual(unbounded);
    const all = bounded.flat();
    expect(all.some((w) => w.message.includes("bounded amount of work"))).toBe(false);
    expect(said(bounded[4] ?? [])).toEqual([
      ["permission-rule", "permissions.rules", "alwaysDeny mcp__linear__delete_project"],
    ]);
    // The typos and the shadowed deny are found, and so is the spec key
    // after the shared wildcard denies.
    expect(all.length).toBeGreaterThanOrEqual(32);
    for (const at of [6, 7]) {
      expect(said(bounded[at] ?? [])).toContainEqual([
        "permission-rule",
        "agent.sub_agents.last.permissions.deny",
        "webFetch",
      ]);
    }
  });
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
