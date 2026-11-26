/**
 * The per-rule checks of `permissionRuleProblems` do a bounded amount of
 * work: every match of a tool glob against a tool, every near-miss
 * comparison, every read of the tools or the declared servers and every
 * character of a rule's text read or compiled is charged; a literal tool
 * glob is looked up rather than matched against each tool, a wildcard one is
 * matched once per distinct glob and only against the tools that can match
 * it; and where the bound is reached one `rule-not-checked` note says so.
 */
import { describe, expect, test } from "bun:test";
import {
  type PermissionRuleProblem,
  type PermissionRuleProblemsInput,
  RULE_PROBLEM_LIMITS,
  type RuleToolDescriptor,
  permissionRuleProblems,
} from "./index";

type Rule = { readonly type: string; readonly pattern: string };
const deny = (pattern: string): Rule => ({ type: "alwaysDeny", pattern });
const allow = (pattern: string): Rule => ({ type: "alwaysAllow", pattern });

/** `i` written in the letters a to y (never z). */
const letters = (i: number): string => {
  let out = "";
  let n = i;
  do {
    out = String.fromCharCode(0x61 + (n % 25)) + out;
    n = Math.floor(n / 25);
  } while (n > 0);
  return out;
};

/** 640 distinct tool names of 20 to 40 characters, none holding a z or a Z. */
const KNOWN: ReadonlyArray<RuleToolDescriptor> = Array.from({ length: 640 }, (_, i) => ({
  name: `Tool${letters(i)}X`.padEnd(20 + (i % 21), "y"),
}));
const LONGEST_KNOWN = Math.max(...KNOWN.map((t) => t.name.length));

/** The total length of the tools' names and keys, plus one a tool: what a read of their strings is charged. */
const charsOf = (tools: ReadonlyArray<RuleToolDescriptor>): number =>
  tools.reduce((n, t) => n + 1 + t.name.length + (t.key?.length ?? 0), 1);

/** The findings and the steps charged, with the budget `steps`. */
function checked(
  rules: ReadonlyArray<Rule>,
  steps: number,
  input: Partial<PermissionRuleProblemsInput> = {},
): { readonly found: PermissionRuleProblem[]; readonly charged: number } {
  const budget = { steps };
  const found = permissionRuleProblems({
    rules,
    granted: [],
    known: KNOWN,
    mcpServers: [],
    ...input,
    budget,
  });
  return { found, charged: steps - budget.steps };
}

describe("the per-rule checks do a bounded amount of work", () => {
  test("each state a tool glob's match visits is charged", () => {
    // It reaches no tool and no declared server, and every known name holds
    // its letters, so it is matched against every one: about 2,000 live
    // states at each character read.
    const glob = `${"**".repeat(1000)}oolX`;
    const { found, charged } = checked([deny(glob)], 1e12);
    expect(found).toEqual([]);
    // Each name is read at least once against about 1,000 live states. The
    // array each match fills (at most 2,003 states, two matches a name)
    // stays far below this.
    expect(charged).toBeGreaterThanOrEqual(KNOWN.length * 20 * 1000);
  }, 20_000); // about 1,300 matches of a 2,000-state glob: slow on CI runners

  test("a rule past the bound gets one note, and nothing else", () => {
    const glob = `${"**".repeat(4000)}oolX`;
    const { found, charged } = checked([deny(glob)], RULE_PROBLEM_LIMITS.steps);
    expect(found.map((p) => [p.code, `${p.type} ${p.pattern}`])).toEqual([
      ["rule-not-checked", `alwaysDeny ${glob}`],
    ]);
    expect(found[0]?.message).toBe(
      `rule "alwaysDeny ${glob}": the permission rule checks do a bounded amount of work and stopped here, so this rule, the rules after it and any later list were not checked for a tool name or argument that can never match.`,
    );
    // The check stops at the first charge past the bound: at most one
    // match of the longest name (with its array) more.
    const oneMatch = LONGEST_KNOWN * (2 * glob.length + 1) + 2 * glob.length + 1;
    expect(charged).toBeGreaterThanOrEqual(RULE_PROBLEM_LIMITS.steps);
    expect(charged).toBeLessThanOrEqual(RULE_PROBLEM_LIMITS.steps + oneMatch);
  }, 20_000); // the whole bound's matching: slow on CI runners

  test("each match's working array is paid for by the steps it is charged", () => {
    // Each glob fails at the second character of each name, so its matches
    // visit few states, while each fills an array as long as the glob's
    // automaton. An MCP tool's name is matched in both its spellings, each
    // filling one; `*/` takes nearly as many states as the bound charged.
    const mcp = Array.from({ length: 200 }, (_, i) => ({ name: `mcp__a${letters(i)}__bX` }));
    const Real = globalThis.Int32Array;
    let allocated = 0;
    class Counted extends Real {
      constructor(...args: ConstructorParameters<typeof Real>) {
        super(...args);
        allocated += this.length;
      }
    }
    for (const [glob, known, calls] of [
      [`?X${"**".repeat(4000)}`, KNOWN, 2 * KNOWN.length],
      [`?X${"*/".repeat(4000)}`, mcp, 3 * mcp.length],
    ] as const) {
      allocated = 0;
      globalThis.Int32Array = Counted as typeof Real;
      let result: ReturnType<typeof checked>;
      try {
        result = checked([deny(glob)], 1e12, { known });
      } finally {
        globalThis.Int32Array = Real;
      }
      expect(result.found).toEqual([]);
      // The matches ran: every name was matched, and its fold.
      expect(allocated).toBeGreaterThanOrEqual(calls * 8000);
      expect(allocated).toBeLessThanOrEqual(result.charged);
    }
  }, 20_000); // about 1,900 arrays of 8,000 to 12,000 elements: slow on CI runners

  /** 5,800 distinct names no known tool has, each `length(i)` long. */
  const unknownNames = (length: (i: number) => number): Rule[] =>
    Array.from({ length: 5800 }, (_, i) => deny(`Nn${letters(i)}W`.padEnd(length(i), "v")));

  test("a near-miss search compares only the known names within reach, and each cell is charged", () => {
    // Lengths among the known names' (20 to 40), and lengths at least 3
    // past the longest, so no known name is within reach of any of them.
    const near = unknownNames((i) => 20 + (i % 21));
    const far = unknownNames((i) => LONGEST_KNOWN + 3 + (i % 5));
    let within = 0;
    for (const rule of near) {
      for (const tool of KNOWN) {
        if (Math.abs(tool.name.length - rule.pattern.length) <= 2) within++;
      }
    }
    const nearChecked = checked(near, 1e12);
    const farChecked = checked(far, 1e12);
    expect(nearChecked.found.length).toBe(5800);
    expect(farChecked.found.length).toBe(5800);
    expect(new Set(nearChecked.found.map((p) => p.code))).toEqual(new Set(["tool-not-known"]));
    // Each comparison works out at least 10 cells of its table.
    expect(nearChecked.charged - farChecked.charged).toBeGreaterThanOrEqual(10 * within);
    // A rule out of reach of every known name costs its text and a few
    // lookups, never a step per known name: against 640 known names it
    // costs what it costs against one, but for the indexes, built once.
    const againstOne = checked(far, 1e12, { known: KNOWN.slice(0, 1) });
    expect(againstOne.found.length).toBe(5800);
    expect(farChecked.charged - againstOne.charged).toBeLessThanOrEqual(
      5800 * 20 + 10 * charsOf(KNOWN),
    );

    // With the default bound, the same findings up to the rule where it
    // stopped, then one note there.
    const bounded = permissionRuleProblems({
      rules: near,
      granted: [],
      known: KNOWN,
      mcpServers: [],
    });
    const note = bounded.at(-1);
    expect(note?.code).toBe("rule-not-checked");
    const stoppedAt = near.findIndex((r) => r.pattern === note?.pattern);
    expect(stoppedAt).toBeGreaterThan(0);
    expect(bounded.slice(0, -1)).toEqual(nearChecked.found.slice(0, stoppedAt));
  }, 20_000); // 5,800 rules against 640 names: slow on CI runners

  test("calls that share a budget share the bound, and a spent one checks nothing", () => {
    const budget = { steps: RULE_PROBLEM_LIMITS.steps };
    const input = { granted: [], known: KNOWN, mcpServers: [], budget };
    const first = permissionRuleProblems({ ...input, rules: [deny(`${"**".repeat(4000)}oolX`)] });
    expect(first.map((p) => p.code)).toEqual(["rule-not-checked"]);
    expect(budget.steps).toBeLessThanOrEqual(0);
    // A later list with a finding of its own is not checked, and gets no
    // second note.
    expect(permissionRuleProblems({ ...input, rules: [deny("Nnope")] })).toEqual([]);
    // Without a budget of its own, a call gets the default.
    expect(
      permissionRuleProblems({
        granted: [],
        known: KNOWN,
        mcpServers: [],
        rules: [deny("Nnope")],
      }).map((p) => p.code),
    ).toEqual(["tool-not-known"]);
  }, 20_000); // the whole bound's matching: slow on CI runners

  test("a literal tool name is looked up, and gets the findings a match against each tool gives", () => {
    const known: RuleToolDescriptor[] = [
      { name: "WebFetch", key: "webFetch", destructive: false, requiresSandbox: false },
      { name: "RemovePath", key: "removePath" },
      { name: "Read", key: "read", destructive: false, requiresSandbox: false },
      { name: "CodeGraphSearch", key: "codegraphSearch" },
      { name: "mcp__fs__read_file" },
      ...KNOWN,
    ];
    const granted = [known[0] as RuleToolDescriptor, known[2] as RuleToolDescriptor];
    // Literal names in each branch, escaped forms among them, with the
    // findings (code and fix) an allow and a deny of each get.
    const table: ReadonlyArray<
      readonly [
        string,
        ReadonlyArray<readonly [string, string | null]>,
        ReadonlyArray<readonly [string, string | null]>,
      ]
    > = [
      ["WebFetch", [], []],
      ["Web\\Fetch", [], []],
      ["webFetch", [["tool-key-not-name", "WebFetch"]], [["tool-key-not-name", "WebFetch"]]],
      ["removePath", [["tool-key-not-name", "RemovePath"]], [["tool-key-not-name", "RemovePath"]]],
      ["REMOVEPATH", [["unknown-tool", null]], [["unknown-tool", "RemovePath"]]],
      ["remove_path", [["unknown-tool", null]], [["unknown-tool", "RemovePath"]]],
      ["Remov\\ePath", [], []],
      ["RemovPath", [["unknown-tool", null]], [["unknown-tool", "RemovePath"]]],
      ["Reed", [["unknown-tool", "Read"]], [["unknown-tool", "Read"]]],
      ["mcp__fs__x", [], []],
      ["mcp__nope__x", [["unknown-mcp-server", null]], [["unknown-mcp-server", null]]],
      ["fs__read_file", [], []],
      ["Codegraph", [["tool-not-known", null]], [["tool-not-known", null]]],
      ["Nothing", [["tool-not-known", null]], [["tool-not-known", null]]],
      ["mcp__fs__read_file", [], []],
      [
        "toolaxyyyyyyyyyyyyyy",
        [["unknown-tool", null]],
        [["unknown-tool", "ToolaXyyyyyyyyyyyyyy"]],
      ],
    ];
    let hits = 0;
    for (const [name, onAllow, onDeny] of table) {
      for (const [rule, want] of [
        [allow(name), onAllow],
        [deny(name), onDeny],
      ] as const) {
        const found = permissionRuleProblems({
          rules: [rule],
          granted,
          known,
          mcpServers: ["fs"],
        }).map((p) => [p.code, p.suggestion ?? null]);
        expect({ rule, found }).toEqual({ rule, found: want as Array<[string, string | null]> });
        hits += found.length;
      }
    }
    expect(hits).toBe(20);
    // Each literal costs a few lookups, not a read of every tool: the
    // tools' strings and their indexes are read once, and the rest is under
    // 100 steps a rule.
    const { charged } = checked(
      table.map(([name]) => deny(name)),
      1e12,
      { granted, known, mcpServers: ["fs"] },
    );
    expect(charged).toBeLessThan(5 * charsOf(known) + table.length * 100);
    // The tools' strings are read for the names, the keys and both folded,
    // each charged by its length.
    expect(charged).toBeGreaterThan(2 * charsOf(known));
  });

  test("a wildcard tool glob with a fixed start is matched only against the tools that start with it", () => {
    // 100 rules for servers the spec does not declare: each reads no known
    // tool, so each costs a few binary searches, not a match per tool.
    const rules = Array.from({ length: 100 }, (_, i) => allow(`mcp__server${i}__*`));
    const { found, charged } = checked(rules, 1e12);
    expect(found.map((p) => p.code)).toEqual(Array(100).fill("unknown-mcp-server"));
    // Past the strings read once, each more rule costs its text (compiled
    // twice, as written and capitalised) and under 100 steps more.
    const one = checked(rules.slice(0, 1), 1e12);
    const text = rules.slice(1).reduce((n, r) => n + 16 * r.pattern.length, 0);
    expect(charged - one.charged).toBeLessThan(text + 99 * 100);
    // A tool's old MCP spelling starts where the glob does too: `fs__read*`
    // reaches mcp__fs__read_file, whose argument it then checks.
    const granted: RuleToolDescriptor[] = [{ name: "mcp__fs__read_file", operativeArgs: [] }];
    expect(
      permissionRuleProblems({
        rules: [deny("fs__read*(secrets/**)")],
        granted,
        known: KNOWN,
        mcpServers: [],
      }).map((p) => [p.code, p.suggestion]),
    ).toEqual([["argument-not-scoped", "fs__read*"]]);
  });

  test("an ordinary rule list gets the findings of an unbounded check", () => {
    const rules = [
      allow("Toolb"),
      deny("Tool*X*"),
      allow("Toolax*"),
      deny("toolayyyyyyyyyyyyyyy"),
      deny("ToolaXyyyyyyyyyyyyyy"),
      deny("ToolaXyyyyyyyyyyyyy"),
      deny("mcp__gh__x"),
      deny("mcp__nope__x"),
    ];
    const found = permissionRuleProblems({ rules, granted: [], known: KNOWN, mcpServers: ["gh"] });
    expect(found.some((p) => p.code === "rule-not-checked")).toBe(false);
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found).toEqual(
      permissionRuleProblems({
        rules,
        granted: [],
        known: KNOWN,
        mcpServers: ["gh"],
        budget: { steps: Number.POSITIVE_INFINITY },
      }),
    );
  });

  test("a glob ending in /** reaches the tool its text before the / names", () => {
    // `X/**` matches `X` itself, so each of these reaches the tool it names
    // and gets that tool's findings.
    const known: RuleToolDescriptor[] = [
      { name: "WebFetch", key: "webFetch", operativeArgs: [{ kind: "url", field: "url" }] },
      { name: "Bash", key: "bash", operativeArgs: [] },
      { name: "RemovePath", key: "removePath" },
      { name: "Read", key: "read", destructive: false, requiresSandbox: false },
      { name: "mcp__fs__read_file" },
      ...KNOWN,
    ];
    const table: ReadonlyArray<
      readonly [Rule, ReadonlyArray<RuleToolDescriptor>, ReadonlyArray<string>]
    > = [
      [deny("webFetch/**"), [], ["tool-key-not-name"]],
      [deny("bash/**"), [], ["tool-key-not-name"]],
      [deny("removePath/**"), [], ["tool-key-not-name"]],
      [deny("BASH/**"), [], ["unknown-tool"]],
      [deny("READ/**"), [], ["unknown-tool"]],
      [deny("read/_**"), [], ["unknown-tool"]],
      [deny("read/**_"), [], ["unknown-tool"]],
      [deny("Read\\/**"), [], []],
      [deny("Bash/**(x)"), [known[1] as RuleToolDescriptor], ["argument-not-scoped"]],
      [
        deny("WebFetch/**(GET https://x)"),
        [known[0] as RuleToolDescriptor],
        ["argument-cannot-match"],
      ],
      [allow("mcp__fs__read_file/**"), [known[4] as RuleToolDescriptor], []],
    ];
    let hits = 0;
    for (const [rule, granted, want] of table) {
      const found = permissionRuleProblems({ rules: [rule], granted, known, mcpServers: [] }).map(
        (p) => p.code,
      );
      expect({ rule, found }).toEqual({ rule, found: [...want] });
      hits += found.length;
    }
    expect(hits).toBe(9);
  });

  test("a wildcard glob repeated across rules and lists is matched once", () => {
    // Every known name holds its letters and none matches it, so a read of
    // the tools matches each of them.
    const glob = "*oolX*yX";
    const once = checked([deny(glob)], 1e12);
    expect(once.found).toEqual([]);
    const budget = { steps: 1e12 };
    const input = { granted: [], known: KNOWN, mcpServers: [], budget };
    expect(permissionRuleProblems({ ...input, rules: [deny(glob)] })).toEqual([]);
    expect(
      permissionRuleProblems({ ...input, rules: Array.from({ length: 99 }, () => deny(glob)) }),
    ).toEqual([]);
    // The 99 repeats cost their text and a few lookups each: far less than
    // one more read of the tools.
    const repeats = 1e12 - budget.steps - once.charged;
    expect(repeats).toBeLessThan(99 * (30 * glob.length + 50));
    expect(once.charged).toBeGreaterThan(2 * KNOWN.length * 20);
  });

  test("a wildcard glob is matched only against the tools that hold its letters and are long enough for it", () => {
    // `z` is in no known name, and no known name is 41 characters long:
    // each tool read is charged a step and skipped, never matched.
    for (const family of [
      (i: number) => `*oolX*y${"z".repeat(i + 1)}`,
      (i: number) => `${"?".repeat(41 + i)}*`,
    ]) {
      const one = checked([deny(family(0))], 1e12);
      const many = checked(
        Array.from({ length: 11 }, (_, i) => deny(family(i))),
        1e12,
      );
      expect(many.found).toEqual([]);
      const extra = many.charged - one.charged;
      const text = Array.from({ length: 10 }, (_, i) => 30 * family(i + 1).length).reduce(
        (a, b) => a + b,
      );
      // Each distinct glob reads at least the known names and the folded
      // ones, a step each, and matches none of them.
      expect(extra).toBeGreaterThanOrEqual(10 * 2 * KNOWN.length);
      expect(extra).toBeLessThan(10 * 4 * KNOWN.length * 3 + text);
    }
  });

  test("a wildcard glob with a fixed start reads each tool that starts with it, a step for each", () => {
    // Every known name starts with `Tool` and none holds a `z`: each
    // distinct glob finds them all by their start (and `tool` for the folded
    // names), and is charged twice for each one, once found and once read.
    const one = checked([deny("Tool*yz")], 1e12);
    const many = checked(
      Array.from({ length: 11 }, (_, i) => deny(`Tool*y${"z".repeat(i + 1)}`)),
      1e12,
    );
    expect(many.found).toEqual([]);
    const extra = many.charged - one.charged;
    expect(extra).toBeGreaterThanOrEqual(10 * 2 * 2 * KNOWN.length);
    expect(extra).toBeLessThan(10 * 2 * 2 * KNOWN.length * 2);
  });

  test("each read of the declared servers is charged by their names", () => {
    const servers = Array.from({ length: 500 }, (_, i) => `server${letters(i)}`);
    const cost = servers.reduce((n, s) => n + 1 + s.length, 0);
    const rules = Array.from({ length: 100 }, (_, i) => deny(`Nnope${letters(i)}`));
    const without = checked(rules, 1e12);
    const withServers = checked(rules, 1e12, { mcpServers: servers });
    expect(withServers.found).toEqual(without.found);
    // Every rule reads them all, and they are read into a set once.
    expect(withServers.charged - without.charged).toBeGreaterThanOrEqual(100 * cost + cost);
    const oneRule = checked(rules.slice(0, 1), 1e12, { mcpServers: servers });
    const oneWithout = checked(rules.slice(0, 1), 1e12);
    expect(oneRule.charged - oneWithout.charged).toBeGreaterThanOrEqual(2 * cost);
    // A bound the rules without the servers stay well under stops the list
    // once the servers' reads spend it: one note, last.
    const bounded = checked(rules, without.charged + 20 * cost, { mcpServers: servers });
    expect(bounded.found.filter((p) => p.code === "rule-not-checked").length).toBe(1);
    expect(bounded.found.at(-1)?.code).toBe("rule-not-checked");
    expect(bounded.found.length).toBeLessThan(rules.length);
  });

  test("each tool a literal name is found on is charged", () => {
    // 500 known tools share one name: each lookup of it charges them all.
    const known = Array.from({ length: 500 }, () => ({ name: "Dup" }));
    const one = checked([deny("Dup")], 1e12, { known });
    const many = checked(
      Array.from({ length: 100 }, () => deny("Dup")),
      1e12,
      { known },
    );
    expect(many.found).toEqual([]);
    expect(many.charged - one.charged).toBeGreaterThanOrEqual(99 * 500);
  });

  test("each character of a rule's text is charged, so long rules reach the bound", () => {
    // 200 rules of one 100,000-character name, then of the same with a `*`:
    // each is looked up, or skipped by every tool, in a few steps, while
    // its text is read and compiled.
    for (const pattern of [`Nn${"a".repeat(100_000)}`, `Nn${"a".repeat(100_000)}*`]) {
      // One rule's text is read a few times, compiled, folded, and its fold
      // compiled, each charged by its length.
      expect(checked([deny(pattern)], 1e12).charged).toBeGreaterThanOrEqual(15 * pattern.length);
      const rules = Array.from({ length: 200 }, () => deny(pattern));
      const found = permissionRuleProblems({ rules, granted: [], known: KNOWN, mcpServers: [] });
      expect(found.filter((p) => p.code === "rule-not-checked").length).toBe(1);
      expect(found.at(-1)?.code).toBe("rule-not-checked");
      expect(found.length).toBeLessThan(rules.length);
    }
    // 250,000 characters of ordinary rules stay far under it.
    const granted: RuleToolDescriptor[] = [
      { name: "Bash", key: "bash", operativeArgs: [{ kind: "command", field: "command" }] },
      { name: "Read", key: "read", operativeArgs: [{ kind: "path", field: "file_path" }] },
    ];
    const ordinary: Rule[] = [];
    for (let i = 0, chars = 0; chars < 250_000; i++) {
      const rule =
        i % 2 === 0
          ? deny(`Bash(git push origin feature-${i}*)`)
          : allow(`Read(src/module-${i}/**)`);
      ordinary.push(rule);
      chars += rule.pattern.length;
    }
    const { found, charged } = checked(ordinary, 1e12, { granted, known: [...granted, ...KNOWN] });
    expect(found).toEqual([]);
    expect(charged).toBeLessThan(RULE_PROBLEM_LIMITS.steps / 4);
  }, 20_000); // about 1.6 MB of rule text read and compiled: slow on CI runners

  test("an argument is read once for a rule, however many tools the rule reaches", () => {
    // 25 tools whose only argument is a URL, and an argument no URL can
    // match: every tool is read, and the argument once.
    const urlTools = Array.from({ length: 25 }, (_, i) => ({
      name: `Url${letters(i)}`,
      operativeArgs: [{ kind: "url", field: "url" }],
    }));
    const arg = ` ${"a".repeat(100_000)}`;
    const rule = deny(`Url*(${arg})`);
    const all = checked([rule], 1e12, { granted: urlTools, known: urlTools });
    const oneTool = checked([rule], 1e12, { granted: urlTools.slice(0, 1), known: urlTools });
    expect(all.found.map((p) => p.code)).toEqual(["argument-cannot-match"]);
    expect(oneTool.found.map((p) => p.code)).toEqual(["argument-cannot-match"]);
    // Its text is charged once, and each more tool a few steps.
    expect(all.charged).toBeGreaterThanOrEqual(8 * arg.length);
    expect(all.charged - oneTool.charged).toBeLessThan(24 * 100);
    // The same rule many times reaches the bound, with one note.
    const repeated = permissionRuleProblems({
      rules: Array.from({ length: 200 }, () => rule),
      granted: urlTools,
      known: urlTools,
      mcpServers: [],
    });
    expect(repeated.filter((p) => p.code === "rule-not-checked").length).toBe(1);
    expect(repeated.at(-1)?.code).toBe("rule-not-checked");
  }, 20_000); // 200 rules of 100,000 characters: slow on CI runners
});
