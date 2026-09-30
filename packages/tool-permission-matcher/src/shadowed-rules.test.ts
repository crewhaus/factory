/**
 * 0.7.1 — a deny or ask written below an allow that matches every call it
 * would can never fire: the first matching rule decides. See
 * `shadowedPermissionRules` in rule-problems.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  type OperativeValue,
  compilePattern,
  globIncludedIn,
  matchesPattern,
  shadowedPermissionRules,
} from "./index";

type Rule = { readonly type: string; readonly pattern: string };
const allow = (pattern: string): Rule => ({ type: "alwaysAllow", pattern });
const deny = (pattern: string): Rule => ({ type: "alwaysDeny", pattern });
const ask = (pattern: string): Rule => ({ type: "alwaysAsk", pattern });
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
