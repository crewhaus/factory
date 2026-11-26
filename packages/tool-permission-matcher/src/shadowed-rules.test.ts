/**
 * 0.7.1 — a deny or ask written below an allow that matches every call it
 * would can never fire: the first matching rule decides. See
 * `shadowedPermissionRules` in rule-problems.ts.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as matcher from "./index";
import {
  type InclusionBudget,
  type OperativeValue,
  type PermissionRuleList,
  RULE_ORDER_LIMITS,
  compilePattern,
  globIncludedIn,
  matchesPattern,
  shadowedPermissionRules,
  specPermissionRuleLists,
} from "./index";

type Rule = { readonly type: string; readonly pattern: string };
const allow = (pattern: string): Rule => ({ type: "alwaysAllow", pattern });
const deny = (pattern: string): Rule => ({ type: "alwaysDeny", pattern });
const ask = (pattern: string): Rule => ({ type: "alwaysAsk", pattern });

const MCP_SERVERS = [
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
  "hubspot",
  "zendesk",
  "intercom",
  "airtable",
  "dropbox",
  "box",
  "gdrive",
  "okta",
  "datadog",
  "pagerduty",
];
/** 61 rules, about 4 KB: the last deny is beaten by the first allow. */
const MCP_LIST: Rule[] = [
  ...MCP_SERVERS.map((s) => allow(`mcp__${s}__*`)),
  ...MCP_SERVERS.map((s) => ask(`mcp__${s}_admin__write_settings`)),
  ...MCP_SERVERS.map((s) => deny(`mcp__${s}_admin__delete_everything`)),
  deny("mcp__github__delete_repo"),
];
/** The MCP servers other than `linear`. */
const OTHER_SERVERS = MCP_SERVERS.filter((s) => s !== "linear");
/**
 * 92 rules in the common allow-first layout: one server's wildcard allow,
 * 45 read tools of other servers allowed by name, 45 write tools of other
 * servers asked for by name, then a deny the first allow beats.
 */
const MCP_NAMED_LIST: Rule[] = [
  allow("mcp__linear__*"),
  ...Array.from({ length: 45 }, (_, i) =>
    allow(`mcp__${OTHER_SERVERS[i % OTHER_SERVERS.length]}__read_${i}`),
  ),
  ...Array.from({ length: 45 }, (_, i) =>
    ask(`mcp__${OTHER_SERVERS[i % OTHER_SERVERS.length]}__write_${i}`),
  ),
  deny("mcp__linear__delete_project"),
];
/**
 * 421 rules: MCP_LIST's 20 wildcard server allows, 200 admin read tools
 * allowed by name, 200 admin write tools asked for by name, then a deny the
 * first allow beats.
 */
const MCP_LONG_LIST: Rule[] = [
  ...MCP_SERVERS.map((s) => allow(`mcp__${s}__*`)),
  ...Array.from({ length: 200 }, (_, i) =>
    allow(`mcp__${MCP_SERVERS[i % MCP_SERVERS.length]}_admin__read_${i}`),
  ),
  ...Array.from({ length: 200 }, (_, i) =>
    ask(`mcp__${MCP_SERVERS[i % MCP_SERVERS.length]}_admin__write_${i}`),
  ),
  deny("mcp__github__delete_repo"),
];
/** Six verbs an MCP server's tools commonly start with. */
const MCP_VERBS = ["get", "list", "search", "read", "fetch", "describe"];
/**
 * 258 rules: each of the 20 servers' tools allowed by six verb wildcards,
 * 137 tools asked for by name, then a deny the first `get_*` allow beats.
 */
const MCP_VERB_LIST: Rule[] = [
  ...MCP_SERVERS.flatMap((s) => MCP_VERBS.map((v) => allow(`mcp__${s}__${v}_*`))),
  ...Array.from({ length: 137 }, (_, i) =>
    ask(`mcp__${MCP_SERVERS[i % MCP_SERVERS.length]}__update_${i}`),
  ),
  deny("mcp__github__get_secret"),
];
/**
 * 841 rules: the 20 server wildcards, 820 tools asked for by name, then a
 * deny the first allow beats.
 */
const MCP_WIDE_LIST: Rule[] = [
  ...MCP_SERVERS.map((s) => allow(`mcp__${s}__*`)),
  ...Array.from({ length: 820 }, (_, i) =>
    ask(`mcp__${MCP_SERVERS[i % MCP_SERVERS.length]}_admin__write_${i}`),
  ),
  deny("mcp__github__delete_repo"),
];
/** `n` distinct characters no glob reads specially (CJK ideographs). */
const distinctChars = (n: number, from = 0x4e00): string =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(from + i)).join("");
const shadowed = (rules: Rule[]) =>
  shadowedPermissionRules([{ path: "permissions.rules", rules }]).map((p) => [
    `${p.type} ${p.pattern}`,
    p.shadowedBy,
  ]);

describe("shadowedPermissionRules", () => {
  test("a deny or ask under a bare allow of every tool it names is reported, naming both", () => {
    const found = shadowedPermissionRules([
      {
        path: "permissions.rules",
        rules: [allow("Bash"), deny("Bash(rm -rf **)"), ask("Bash(sudo**)"), deny("Write")],
      },
    ]);
    expect(found.map((p) => [p.code, p.list, `${p.type} ${p.pattern}`, p.shadowedBy])).toEqual([
      ["shadowed-by-allow", "permissions.rules", "alwaysDeny Bash(rm -rf **)", "Bash"],
      ["shadowed-by-allow", "permissions.rules", "alwaysAsk Bash(sudo**)", "Bash"],
    ]);
    expect(found[0]?.message).toBe(
      'rule "alwaysDeny Bash(rm -rf **)" never fires outside plan mode: "alwaysAllow Bash", above it in the same list, matches every call it matches, and the first rule that matches a call decides it. Move it above "alwaysAllow Bash".',
    );
  });

  test("in a plan-mode spec the rule fires, so it is a note naming when it would not", () => {
    const rules = [allow("Read"), deny("Read(secrets/**)")];
    const lists = [{ path: "permissions.rules", rules }];
    const found = shadowedPermissionRules(lists, { mode: "plan" });
    expect(found.map((p) => [p.code, `${p.type} ${p.pattern}`, p.shadowedBy])).toEqual([
      ["shadowed-outside-plan", "alwaysDeny Read(secrets/**)", "Read"],
    ]);
    expect(found[0]?.message).toBe(
      'rule "alwaysDeny Read(secrets/**)" fires in this spec\'s plan mode, which reads no allow, and in no other mode (`--permission-mode` sets one): "alwaysAllow Read", above it in the same list, matches every call it matches, and the first rule that matches a call decides it. Move it above "alwaysAllow Read".',
    );
    // A sub-agent runs in its parent's mode: the same note.
    const sub = shadowedPermissionRules(
      [
        { path: "agent.sub_agents.a.permissions.allow", rules: [allow("Read")] },
        { path: "agent.sub_agents.a.permissions.deny", rules: [deny("Read(secrets/**)")] },
      ],
      { mode: "plan" },
    );
    expect(sub.map((p) => p.code)).toEqual(["shadowed-outside-plan"]);
    // Any other mode: the rule is dead.
    for (const mode of [undefined, "default", "auto"]) {
      const codes = shadowedPermissionRules(lists, mode === undefined ? {} : { mode }).map(
        (p) => p.code,
      );
      expect({ mode, codes }).toEqual({ mode, codes: ["shadowed-by-allow"] });
    }
  });

  test("the tool half is compared by automaton inclusion", () => {
    expect(shadowed([allow("mcp__github__*"), deny("mcp__github__delete_repo")])).toEqual([
      ["alwaysDeny mcp__github__delete_repo", "mcp__github__*"],
    ]);
    expect(shadowed([allow("*"), deny("Bash(rm**)")])).toEqual([["alwaysDeny Bash(rm**)", "*"]]);
    expect(shadowed([allow("B*sh"), deny("Bash")])).toEqual([["alwaysDeny Bash", "B*sh"]]);
    expect(shadowed([allow("Write"), allow("Bash"), deny("Bash")])).toEqual([
      ["alwaysDeny Bash", "Bash"],
    ]);
  });

  test("near misses are not reported", () => {
    for (const rules of [
      // Written first, the deny decides.
      [deny("Bash(rm **)"), allow("Bash")],
      // Another tool.
      [allow("Read"), deny("Bash(rm**)")],
      [allow("mcp__github__*"), deny("mcp__gitlab__x")],
      // The deny reaches names the allow does not.
      [allow("Bas?"), deny("Bash*")],
      [allow("Bash"), deny("*(rm **)")],
      // Tool names hold no `/`, but inclusion is not proven, so nothing is said.
      [allow("*"), deny("**")],
      // The pre-0.7.1 MCP spelling matches through the alias, not the glob.
      [allow("github__*"), deny("mcp__github__x")],
      // A malformed allow grants nothing.
      [allow("Bash("), deny("Bash(rm **)")],
      // An ask is not an allow.
      [ask("Bash"), deny("Bash(rm **)")],
    ]) {
      expect({ rules, found: shadowed(rules) }).toEqual({ rules, found: [] });
    }
  });

  test("an allow scoped to an argument is never reported, however wide", () => {
    // Each deny below fires on a call its allow does not grant.
    const cases: ReadonlyArray<readonly [string, string, OperativeValue]> = [
      // A second command on the line.
      [
        "Bash(git *)",
        "Bash(git push*)",
        { kind: "command", canonical: ["git push && ls"], shell: true },
      ],
      // A path outside the workspace.
      [
        "Write(**)",
        "Write(secret/**)",
        { kind: "path", canonical: [], spellings: ["../x"], outsideWorkspace: true },
      ],
      // Another letter case, where the filesystem ignores it.
      [
        "Write(src/**)",
        "Write(src/secret/**)",
        { kind: "path", canonical: ["SRC/Secret/k"], caseInsensitive: true },
      ],
      // A credential in the URL.
      [
        "WebFetch(**)",
        "WebFetch(**evil**)",
        { kind: "url", canonical: ["https://u:p@evil.example/"] },
      ],
    ];
    for (const [a, d, value] of cases) {
      expect(shadowed([allow(a), deny(d)])).toEqual([]);
      const tool = a.slice(0, a.indexOf("("));
      const opts = { operativeValues: [value] };
      expect({ a, d, allows: matchesPattern(compilePattern(a), tool, {}, opts) }).toEqual({
        a,
        d,
        allows: false,
      });
      expect({
        a,
        d,
        fires: matchesPattern(compilePattern(d), tool, {}, { ...opts, polarity: "restrict" }),
      }).toEqual({ a, d, fires: true });
    }
    expect(shadowed([allow("Bash(**)"), deny("Bash(rm **)")])).toEqual([]);
  });

  test("a sub-agent's allow list is read before its deny list", () => {
    const found = shadowedPermissionRules([
      { path: "agent.sub_agents.fixer.permissions.allow", rules: [allow("Bash")] },
      {
        path: "agent.sub_agents.fixer.permissions.deny",
        rules: [deny("Bash(rm **)"), deny("Write")],
      },
      // A model profile's deny list has no allow list to pair with.
      { path: "models.fast.permissions.deny", rules: [deny("Bash(rm **)")] },
      { path: "agent.sub_agents.other.permissions.deny", rules: [deny("Bash(rm **)")] },
    ]);
    expect(found.map((p) => [p.list, `${p.type} ${p.pattern}`])).toEqual([
      ["agent.sub_agents.fixer.permissions.deny", "alwaysDeny Bash(rm **)"],
    ]);
    expect(found[0]?.message).toContain("a sub-agent's allow list is read before its deny list");
    expect(found[0]?.message).toContain("agent.sub_agents.fixer.permissions.allow");
  });

  test("a reported deny never fires first: a randomised check against the matcher", () => {
    // Every pair reported shadowed is checked on many calls: whenever the
    // deny matches, the allow above it matches too. Pairs not reported are
    // fine either way; the count of reported pairs is the guard's hit count.
    const names = [
      "Bash",
      "Bashx",
      "Read",
      "mcp__gh__a",
      "mcp__gh__b",
      "mcp__gl__a",
      "gh__a",
      "B",
      "",
    ];
    const toolGlobs = [
      "Bash",
      "Bash*",
      "B*",
      "*",
      "mcp__gh__*",
      "mcp__*",
      "mcp__gh__a",
      "?ash",
      "**",
      "gh__*",
    ];
    const args = ["", "(rm **)", "(git *)", "(**)"];
    const values = ["rm -rf x", "git status && rm -rf x", "ls", "../x"];
    let reported = 0;
    for (const a of toolGlobs) {
      for (const d of toolGlobs) {
        for (const arg of args) {
          const rules = [allow(a), deny(`${d}${arg}`)];
          if (shadowed(rules).length === 0) continue;
          reported++;
          const pa = compilePattern(a);
          const pd = compilePattern(`${d}${arg}`);
          for (const name of names) {
            for (const v of values) {
              const operativeValues = [{ kind: "command" as const, canonical: [v], shell: true }];
              const fires = matchesPattern(pd, name, {}, { polarity: "restrict", operativeValues });
              if (!fires) continue;
              expect({
                a,
                d: `${d}${arg}`,
                name,
                v,
                allowed: matchesPattern(pa, name, {}, { operativeValues }),
              }).toEqual({
                a,
                d: `${d}${arg}`,
                name,
                v,
                allowed: true,
              });
            }
          }
        }
      }
    }
    expect(reported).toBeGreaterThanOrEqual(60);
  });

  test("globIncludedIn is inclusion, and false when unproven", () => {
    expect(globIncludedIn("mcp__gh__a", "mcp__gh__*")).toBe(true);
    expect(globIncludedIn("mcp__gh__*", "mcp__*")).toBe(true);
    expect(globIncludedIn("mcp__*", "mcp__gh__*")).toBe(false);
    expect(globIncludedIn("a/**", "**")).toBe(true);
    expect(globIncludedIn("**", "*")).toBe(false);
    expect(globIncludedIn("*", "**")).toBe(true);
  });
});

describe("the rule-order check does a bounded amount of work", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });
  /** Counts every comparison of a deny's tool pattern with an allow's. */
  const countComparisons = () => {
    const spy = spyOn(matcher, "globIncludedIn");
    spies.push(spy);
    return spy;
  };
  /** `n` bare wildcard allows and `n` denies, alternating, no tool pattern including another. */
  const alternating = (n: number): Rule[] =>
    Array.from({ length: n }, (_, i) => [allow(`A${i}x*`), deny(`B${i}y`)]).flat();
  /** The budget the comparisons charged, read from the spy's first call. */
  const chargedBy = (calls: ReturnType<typeof countComparisons>, steps: number): number => {
    const budget = calls.mock.calls[0]?.[2] as InclusionBudget | undefined;
    expect(budget).toBeDefined();
    return steps - (budget?.steps ?? steps);
  };
  const notes = (found: ReturnType<typeof shadowedPermissionRules>) =>
    found.filter((p) => p.code === "order-not-checked");

  test("the rule-order check compares a bounded number of rule pairs and names the list where it stopped", () => {
    const rules = alternating(600);
    expect(rules.length).toBe(1200);
    const lists: PermissionRuleList[] = [
      { path: "permissions.rules", rules },
      // A later list is not checked, and gets no second note.
      { path: "agent.sub_agents.a.permissions.allow", rules: [allow("Bash")] },
      { path: "agent.sub_agents.a.permissions.deny", rules: [deny("Bash")] },
    ];
    const calls = countComparisons();
    const found = shadowedPermissionRules(lists);
    expect(calls).toHaveBeenCalledTimes(RULE_ORDER_LIMITS.pairs);
    expect(notes(found).length).toBe(1);
    expect(found.length).toBe(1);
    const note = found[found.length - 1];
    expect(note?.code).toBe("order-not-checked");
    expect(note?.list).toBe("permissions.rules");
    expect(note?.shadowedBy).toBeUndefined();
    // The k-th deny is compared with the k wildcard allows above it. The
    // 512th is the first whose comparisons (1 + 2 + … + 512) pass 131,072:
    // the denies before it make 130,816.
    expect(`${note?.type} ${note?.pattern}`).toBe("alwaysDeny B511y");
    expect(note?.message).toBe(
      'rule "alwaysDeny B511y" in permissions.rules: the rule-order check does a bounded amount of work and stopped here, so this rule, the rules after it and any later list were not checked for an allow above them that always matches first.',
    );
    // The pair bound stopped it, not the automaton work: with no step bound
    // the same list makes the same comparisons and stops at the same rule.
    calls.mockClear();
    const unstepped = shadowedPermissionRules(lists, {
      limits: { steps: Number.POSITIVE_INFINITY },
    });
    expect(calls).toHaveBeenCalledTimes(RULE_ORDER_LIMITS.pairs);
    expect(unstepped).toEqual(found);
  });

  test("the findings shown before the bound are kept, and the note comes last", () => {
    const rules = [allow("Bash"), deny("Bash(rm **)"), ...alternating(20)];
    const calls = countComparisons();
    const found = shadowedPermissionRules([{ path: "permissions.rules", rules }], {
      limits: { pairs: 10 },
    });
    // `Bash` names one tool, so `Bash(rm **)` is found by that name, at no
    // pair. Each B{k}y is compared with the k + 1 wildcard allows above it:
    // B0y to B3y make the 10 comparisons, and B4y is where the check stops.
    expect(calls).toHaveBeenCalledTimes(10);
    expect(found.map((p) => [p.code, `${p.type} ${p.pattern}`])).toEqual([
      ["shadowed-by-allow", "alwaysDeny Bash(rm **)"],
      ["order-not-checked", "alwaysDeny B4y"],
    ]);
    // In a plan-mode spec the note is the same note.
    const plan = shadowedPermissionRules([{ path: "permissions.rules", rules }], {
      mode: "plan",
      limits: { pairs: 10 },
    });
    expect(plan.map((p) => p.code)).toEqual(["shadowed-outside-plan", "order-not-checked"]);
  });

  test("a few long tool patterns reach the step bound before the pair bound", () => {
    const long = (c: string) => `${c.repeat(400)}*`;
    const rules = [allow(long("a")), deny(long("b")), allow(long("c")), deny(long("d"))];
    const calls = countComparisons();
    const found = shadowedPermissionRules([{ path: "permissions.rules", rules }], {
      limits: { steps: 2000 },
    });
    const made = calls.mock.calls.length;
    expect(made).toBeGreaterThan(0);
    expect(made).toBeLessThan(RULE_ORDER_LIMITS.pairs);
    expect(made).toBeLessThan(3);
    expect(notes(found).map((p) => [p.list, p.type])).toEqual([
      ["permissions.rules", "alwaysDeny"],
    ]);
    // With the default bounds the same rules are all checked, and none is shadowed.
    expect(shadowedPermissionRules([{ path: "permissions.rules", rules }])).toEqual([]);
  });

  test("a sub-agent's allow and deny at the step bound put the note on its deny list", () => {
    const long = (c: string) => `${c.repeat(400)}*`;
    const found = shadowedPermissionRules(
      [
        { path: "agent.sub_agents.fixer.permissions.allow", rules: [allow(long("a"))] },
        { path: "agent.sub_agents.fixer.permissions.deny", rules: [deny(long("b"))] },
      ],
      { limits: { steps: 4000 } },
    );
    expect(found.map((p) => [p.code, p.list, p.pattern])).toEqual([
      ["order-not-checked", "agent.sub_agents.fixer.permissions.deny", long("b")],
    ]);
  });

  test("an ordinary list's findings are the same under the default bounds as with none", () => {
    const table: PermissionRuleList[][] = [
      [
        {
          path: "permissions.rules",
          rules: [allow("Bash"), deny("Bash(rm -rf **)"), ask("Bash(sudo**)"), deny("Write")],
        },
      ],
      [{ path: "permissions.rules", rules: [allow("Read"), deny("Read(secrets/**)")] }],
      [
        { path: "agent.sub_agents.a.permissions.allow", rules: [allow("Read")] },
        { path: "agent.sub_agents.a.permissions.deny", rules: [deny("Read(secrets/**)")] },
      ],
      [
        {
          path: "permissions.rules",
          rules: [allow("mcp__github__*"), deny("mcp__github__delete_repo")],
        },
      ],
      [{ path: "permissions.rules", rules: [allow("*"), deny("Bash(rm**)")] }],
      [{ path: "permissions.rules", rules: [allow("B*sh"), deny("Bash")] }],
      [{ path: "permissions.rules", rules: [allow("Write"), allow("Bash"), deny("Bash")] }],
      [{ path: "permissions.rules", rules: [deny("Bash(rm **)"), allow("Bash")] }],
      [{ path: "permissions.rules", rules: [allow("Read"), deny("Bash(rm**)")] }],
      [{ path: "permissions.rules", rules: [allow("mcp__github__*"), deny("mcp__gitlab__x")] }],
      [{ path: "permissions.rules", rules: [allow("Bas?"), deny("Bash*")] }],
      [{ path: "permissions.rules", rules: [allow("Bash"), deny("*(rm **)")] }],
      [{ path: "permissions.rules", rules: [allow("*"), deny("**")] }],
      [{ path: "permissions.rules", rules: [allow("github__*"), deny("mcp__github__x")] }],
      [{ path: "permissions.rules", rules: [allow("Bash("), deny("Bash(rm **)")] }],
      [{ path: "permissions.rules", rules: [ask("Bash"), deny("Bash(rm **)")] }],
      [{ path: "permissions.rules", rules: [allow("Bash(git *)"), deny("Bash(git push*)")] }],
      [{ path: "permissions.rules", rules: [allow("Write(**)"), deny("Write(secret/**)")] }],
      [{ path: "permissions.rules", rules: [allow("Bash(**)"), deny("Bash(rm **)")] }],
      [
        { path: "agent.sub_agents.fixer.permissions.allow", rules: [allow("Bash")] },
        {
          path: "agent.sub_agents.fixer.permissions.deny",
          rules: [deny("Bash(rm **)"), deny("Write")],
        },
        { path: "models.fast.permissions.deny", rules: [deny("Bash(rm **)")] },
        { path: "agent.sub_agents.other.permissions.deny", rules: [deny("Bash(rm **)")] },
      ],
      // MCP-style names: a bare allow for each of 20 servers, an ask and a
      // deny on each server's admin tools, then a deny the first allow beats.
      [{ path: "permissions.rules", rules: MCP_LIST }],
      // MCP tools allowed and asked for by name, in the allow-first layout.
      [{ path: "permissions.rules", rules: MCP_NAMED_LIST }],
      [{ path: "permissions.rules", rules: MCP_LONG_LIST }],
      // Verb wildcards for each server above named asks, and server
      // wildcards above many named asks.
      [{ path: "permissions.rules", rules: MCP_VERB_LIST }],
      [{ path: "permissions.rules", rules: MCP_WIDE_LIST }],
      // A sub-agent's named MCP allows read before its denies.
      [
        {
          path: "agent.sub_agents.a.permissions.allow",
          rules: MCP_NAMED_LIST.filter((r) => r.type === "alwaysAllow"),
        },
        {
          path: "agent.sub_agents.a.permissions.deny",
          rules: MCP_NAMED_LIST.filter((r) => r.type !== "alwaysAllow").map((r) => deny(r.pattern)),
        },
      ],
      // The compiler's edge-reading fixture, as a plain spec object.
      specPermissionRuleLists({
        agent: {
          sub_agents: {
            fixer: {
              permissions: {
                allow: ["WebFetch"],
                deny: ["WebFetch(https://evil.example.net/**)"],
              },
            },
          },
        },
        permissions: {
          rules: [
            { type: "alwaysAllow", pattern: "WebFetch" },
            { type: "alwaysDeny", pattern: "WebFetch(https://evil.example.net/**)" },
            { type: "alwaysAsk", pattern: "WebFetch(http://**)" },
            { type: "alwaysDeny", pattern: "webFetch" },
          ],
        },
      }),
    ];
    const unbounded = { pairs: Number.POSITIVE_INFINITY, steps: Number.POSITIVE_INFINITY };
    let hits = 0;
    for (const lists of table) {
      const bounded = shadowedPermissionRules(lists);
      expect({ lists, found: bounded }).toEqual({
        lists,
        found: shadowedPermissionRules(lists, { limits: unbounded }),
      });
      expect(notes(bounded)).toEqual([]);
      hits += bounded.length;
    }
    expect(table[table.length - 1]?.length).toBe(3);
    expect(hits).toBeGreaterThanOrEqual(15);
  });

  test("a list of MCP tools named one by one is checked in full, and a named allow costs no comparison", () => {
    expect(MCP_NAMED_LIST.length).toBe(92);
    const calls = countComparisons();
    const found = shadowedPermissionRules([{ path: "permissions.rules", rules: MCP_NAMED_LIST }]);
    expect(found.map((p) => [p.code, `${p.type} ${p.pattern}`, p.shadowedBy])).toEqual([
      ["shadowed-by-allow", "alwaysDeny mcp__linear__delete_project", "mcp__linear__*"],
    ]);
    // Each of the 46 asks and denies is compared with the one wildcard allow.
    expect(calls.mock.calls.length).toBeLessThanOrEqual(46);
    // 421 rules: 200 asks below 20 wildcard allows, and the deny the first
    // beats, within the pair bound.
    calls.mockClear();
    const long = shadowedPermissionRules([{ path: "permissions.rules", rules: MCP_LONG_LIST }]);
    expect(long.map((p) => [p.code, `${p.type} ${p.pattern}`, p.shadowedBy])).toEqual([
      ["shadowed-by-allow", "alwaysDeny mcp__github__delete_repo", "mcp__github__*"],
    ]);
    expect(calls.mock.calls.length).toBe(200 * 20 + 1);
    expect(calls.mock.calls.length).toBeLessThan(RULE_ORDER_LIMITS.pairs);
    // 258 rules of verb wildcards above named asks, and 841 of server
    // wildcards above named asks: the deny at the end is found in each.
    for (const [rules, denied, by] of [
      [MCP_VERB_LIST, "mcp__github__get_secret", "mcp__github__get_*"],
      [MCP_WIDE_LIST, "mcp__github__delete_repo", "mcp__github__*"],
    ] as const) {
      calls.mockClear();
      const found = shadowedPermissionRules([{ path: "permissions.rules", rules }]);
      expect(found.map((p) => [p.code, `${p.type} ${p.pattern}`, p.shadowedBy])).toEqual([
        ["shadowed-by-allow", `alwaysDeny ${denied}`, by],
      ]);
      expect(calls.mock.calls.length).toBeLessThan(RULE_ORDER_LIMITS.pairs);
    }
    expect(MCP_VERB_LIST.length).toBe(258);
    expect(MCP_WIDE_LIST.length).toBe(841);
  });

  test("a literal allow is compared by its name and costs no pair", () => {
    const rules = [
      ...Array.from({ length: 3000 }, (_, i) => allow(`mcp__gh__read_${i}`)),
      ...Array.from({ length: 3000 }, (_, i) => deny(`mcp__gh__write_${i}`)),
    ];
    const calls = countComparisons();
    expect(shadowedPermissionRules([{ path: "permissions.rules", rules }])).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(0);
  }, 20_000); // 6,000 rules: CI runners are slower on allocation-heavy work

  test("the first allow that covers a deny is the one named", () => {
    const calls = countComparisons();
    expect(shadowed([allow("mcp__gh__*"), allow("mcp__gh__a"), deny("mcp__gh__a")])).toEqual([
      ["alwaysDeny mcp__gh__a", "mcp__gh__*"],
    ]);
    calls.mockClear();
    expect(shadowed([allow("mcp__gh__a"), allow("mcp__gh__*"), deny("mcp__gh__a")])).toEqual([
      ["alwaysDeny mcp__gh__a", "mcp__gh__a"],
    ]);
    expect(calls).toHaveBeenCalledTimes(0);
    expect(shadowed([allow("mcp__gh__a"), deny("mcp__gh__*")])).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(0);
    // An allow written with escapes names the same tool.
    expect(shadowed([allow("R\\ead"), deny("Read(secrets/**)")])).toEqual([
      ["alwaysDeny Read(secrets/**)", "R\\ead"],
    ]);
    expect(calls).toHaveBeenCalledTimes(0);
  });

  test("a literal allow covers a deny exactly when automaton inclusion says it does", () => {
    const globs = [
      "Read",
      "R\\ead",
      "Rea",
      "Bash",
      "Bash*",
      "R*",
      "R\\*",
      "R\\*x",
      "Re?d",
      "*ead",
      "*",
      "**",
      "mcp__gh__a",
      "mcp\\_\\_gh\\_\\_a",
      "mcp__gh__*",
      "mcp__*",
      "gh__a",
      "gh__*",
    ];
    let literalHits = 0;
    let hits = 0;
    for (const a of globs) {
      for (const d of globs) {
        const found = shadowed([allow(a), deny(d)]).length > 0;
        expect({ a, d, found }).toEqual({ a, d, found: globIncludedIn(d, a) });
        if (found) {
          hits++;
          if (compilePattern(a)._toolRe.isLiteral) literalHits++;
        }
      }
    }
    expect(literalHits).toBeGreaterThanOrEqual(10);
    expect(hits).toBeGreaterThan(literalHits);
  });

  test("a list of MCP-style names is checked in full under the default bounds", () => {
    expect(MCP_LIST.length).toBe(61);
    const found = shadowedPermissionRules([{ path: "permissions.rules", rules: MCP_LIST }]);
    expect(notes(found)).toEqual([]);
    expect(found.map((p) => [p.code, `${p.type} ${p.pattern}`, p.shadowedBy])).toEqual([
      ["shadowed-by-allow", "alwaysDeny mcp__github__delete_repo", "mcp__github__*"],
    ]);
  });

  test("each pattern's automaton is built once and charged once, and the step bound stops a list of distinct long patterns", () => {
    // Ten distinct long wildcard allows above a short deny: their text is
    // charged as each is read (about 100,000 steps), and each is built, and
    // charged, for its own comparison, which spends the rest within a few
    // pairs.
    const rules = [
      ...Array.from({ length: 10 }, (_, i) =>
        allow(`z${String.fromCharCode(0x61 + i).repeat(5000)}*`),
      ),
      deny("z0"),
    ];
    const calls = countComparisons();
    const found = shadowedPermissionRules([{ path: "permissions.rules", rules }], {
      limits: { steps: 115_000 },
    });
    expect(calls.mock.calls.length).toBeGreaterThan(0);
    expect(calls.mock.calls.length).toBeLessThanOrEqual(4);
    expect(found.map((p) => p.code)).toEqual(["order-not-checked"]);
    // One comparison spends at least the states of the automaton it builds.
    const budget: InclusionBudget = { steps: 1_000_000 };
    expect(globIncludedIn("a", `a${"b".repeat(1000)}`, budget)).toBe(false);
    expect(1_000_000 - budget.steps).toBeGreaterThanOrEqual(1000);
    // A later comparison with the same budget reuses it.
    const before = budget.steps;
    expect(globIncludedIn("c", `a${"b".repeat(1000)}`, budget)).toBe(false);
    expect(before - budget.steps).toBeLessThan(100);
  });

  test("a deny with no wildcard is read through the allow's automaton, and each state it visits is charged", () => {
    // A 5,000-character name read through 100 `**` and an `x`: every
    // character re-closes the allow's 200 looping states.
    const allowGlob = `${"**".repeat(100)}x`;
    const name = "a".repeat(5000);
    const budget: InclusionBudget = { steps: 1e12 };
    expect(globIncludedIn(name, allowGlob, budget)).toBe(false);
    expect(globIncludedIn(`${name}x`, allowGlob, budget)).toBe(true);
    // Twice 5,000 characters, each closure visiting about 200 states (the
    // builds alone are about 5,200).
    expect(1e12 - budget.steps).toBeGreaterThanOrEqual(2 * 5000 * 150);
    // And it is the answer automaton inclusion gives.
    for (const [inner, outer] of [
      ["mcp__gh__a", "mcp__gh__*"],
      ["mcp__gl__a", "mcp__gh__*"],
      ["Bash", "B*sh"],
      ["a/b", "*"],
      ["a/b", "**"],
      ["Read", "R?ad"],
    ] as const) {
      expect({ inner, outer, budgeted: globIncludedIn(inner, outer, { steps: 1e12 }) }).toEqual({
        inner,
        outer,
        budgeted: globIncludedIn(inner, outer),
      });
    }
  });

  test("a long wildcard allow above many short denies is built once", () => {
    const steps = 1e12;
    const rules = [
      allow(`z${"b".repeat(5000)}*`),
      ...Array.from({ length: 50 }, (_, i) => deny(`z${i}`)),
    ];
    const calls = countComparisons();
    expect(
      shadowedPermissionRules([{ path: "permissions.rules", rules }], { limits: { steps } }),
    ).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(50);
    // The allow builds to 5,003 states, once. Each deny builds to at most 4,
    // joins two alphabets of at most 3 letters, and settles within its first
    // few characters: well under 200 steps each. Each rule's text is charged
    // a few steps a character as it is read.
    const text = rules.reduce((n, r) => n + 3 * r.pattern.length + 1, 0);
    expect(chargedBy(calls, steps)).toBeLessThan(2 * 5000 + text + 50 * 200);
  });

  test("every per-comparison cost is paid for by the steps charged", () => {
    // A wildcard allow with a 3,000-letter alphabet above 100 denies of one
    // character and a `*`, which it does not cover: each comparison settles
    // on the deny's own character, so joining the two alphabets is most of
    // its work.
    const steps = 1e12;
    const rules = [
      allow(`*${distinctChars(3000)}`),
      ...Array.from({ length: 100 }, (_, i) => deny(`${String.fromCharCode(0x3041 + i)}*`)),
    ];
    const RealUint8 = globalThis.Uint8Array;
    let allocated = 0;
    class Counted extends RealUint8 {
      constructor(...args: ConstructorParameters<typeof RealUint8>) {
        super(...args);
        allocated += this.length;
      }
    }
    const realAdd = Set.prototype.add;
    let added = 0;
    const calls = countComparisons();
    globalThis.Uint8Array = Counted as typeof RealUint8;
    Set.prototype.add = function <T>(this: Set<T>, value: T) {
      added++;
      return realAdd.call(this, value);
    };
    let found: ReturnType<typeof shadowedPermissionRules>;
    try {
      found = shadowedPermissionRules([{ path: "permissions.rules", rules }], {
        limits: { steps },
      });
    } finally {
      Set.prototype.add = realAdd;
      globalThis.Uint8Array = RealUint8;
    }
    expect(found).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(100);
    const charged = chargedBy(calls, steps);
    // The calls ran: every comparison joined the allow's 3,000 letters.
    expect(added).toBeGreaterThan(100 * 3000);
    expect(added).toBeLessThanOrEqual(charged);
    expect(allocated).toBeGreaterThan(3000);
    expect(allocated).toBeLessThanOrEqual(charged);
  });

  test("each symbol read is charged", () => {
    // 300 distinct characters and a `*` against `x`: each of its 300 state
    // sets reads every one of the 304 symbols.
    const budget: InclusionBudget = { steps: 1e12 };
    expect(globIncludedIn(`${distinctChars(300)}*`, "x", budget)).toBe(false);
    expect(1e12 - budget.steps).toBeGreaterThanOrEqual(100_000);
  });

  test("each state a closure visits is charged", () => {
    // 200 `**` after a `?`: every symbol read re-closes about 400 states.
    const budget: InclusionBudget = { steps: 1e12 };
    expect(globIncludedIn(`?${"**".repeat(200)}${distinctChars(200)}`, "x", budget)).toBe(false);
    expect(1e12 - budget.steps).toBeGreaterThanOrEqual(20_000_000);
  }, 20_000); // 24M steps of closures by construction: slow on CI runners

  test("a comparison's working arrays are all paid for by the steps it is charged", () => {
    // Counts the elements of every typed array the comparison allocates,
    // which the runtime zeroes: work that grows with a pattern's length.
    const Real = globalThis.Uint8Array;
    let allocated = 0;
    class Counted extends Real {
      constructor(...args: ConstructorParameters<typeof Real>) {
        super(...args);
        allocated += this.length;
      }
    }
    const charged = (inner: string, outer: string, steps: number) => {
      allocated = 0;
      const budget: InclusionBudget = { steps };
      globalThis.Uint8Array = Counted as typeof Real;
      try {
        globIncludedIn(inner, outer, budget);
      } finally {
        globalThis.Uint8Array = Real;
      }
      return { charged: steps - budget.steps, allocated };
    };
    const alphabet = "abcdefghijklmnop";
    for (const run of [1000, 10_000]) {
      const long = `*${alphabet}${"z".repeat(run)}`;
      for (const steps of [5_000_000, 50_000]) {
        const seen = charged(long, "*", steps);
        expect(seen.allocated).toBeGreaterThan(run);
        expect(seen.allocated).toBeLessThanOrEqual(seen.charged);
      }
    }
  });

  test("each rule's text is charged as it is read, so long rules reach the step bound", () => {
    // No allow, so no comparison: only the rules' text is read.
    const pattern = `Nn${"a".repeat(100_000)}`;
    const rules = Array.from({ length: 200 }, () => deny(pattern));
    const calls = countComparisons();
    const found = shadowedPermissionRules([{ path: "permissions.rules", rules }]);
    expect(calls).toHaveBeenCalledTimes(0);
    expect(found.map((p) => p.code)).toEqual(["order-not-checked"]);
    // A thousand ordinary rules stay under it.
    const ordinary = Array.from({ length: 1000 }, (_, i) =>
      i % 2 === 0
        ? deny(`Bash(git push origin feature-${i}-${"x".repeat(i % 20)}*)`)
        : allow(`Read(src/m${i}/**)`),
    );
    expect(
      notes(shadowedPermissionRules([{ path: "permissions.rules", rules: ordinary }])),
    ).toEqual([]);
  }, 20_000); // 200 rules of 100,000 characters compiled: slow on CI runners

  test("globIncludedIn with a budget: the same answer while it lasts, false once it is spent", () => {
    expect(globIncludedIn("mcp__gh__a", "mcp__gh__*")).toBe(true);
    const large: InclusionBudget = { steps: 1_000_000 };
    expect(globIncludedIn("mcp__gh__a", "mcp__gh__*", large)).toBe(true);
    expect(large.steps).toBeGreaterThan(0);
    expect(large.steps).toBeLessThan(1_000_000);
    const one: InclusionBudget = { steps: 1 };
    expect(globIncludedIn("mcp__gh__a", "mcp__gh__*", one)).toBe(false);
    expect(one.steps).toBeLessThanOrEqual(0);
    // A spent budget builds nothing more.
    const spent: InclusionBudget = { steps: 0 };
    expect(globIncludedIn("mcp__gh__a", "mcp__gh__*", spent)).toBe(false);
    expect(spent.steps).toBe(0);
  });
});
