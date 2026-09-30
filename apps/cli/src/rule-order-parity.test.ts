/**
 * 0.7.1 — a bundle compiled with the rewriting IR passes (`applyIrPasses`,
 * which the compiler worker's `POST /compile` sets) decides every call the
 * way `crewhaus compile` and `crewhaus run` do.
 *
 * The engine decides by the FIRST matching rule in a list. The
 * `permissionRuleCanonicalize` pass used to re-sort the rules deny, ask,
 * allow, so an `alwaysAllow Bash` written above `alwaysDeny Bash(rm *)` —
 * which lets `rm` run — was a deny in the pass-applied bundle only.
 */
import { describe, expect, test } from "bun:test";
import { compile, lower } from "@crewhaus/compiler";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionRule,
  type RuleType,
  emptyRuleSet,
  evaluate,
} from "@crewhaus/permission-engine";
import { parseSpec } from "@crewhaus/spec";

const SPEC = `
name: parity
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: i
tools: [bash, write, read]
permissions:
  rules:
    - { type: alwaysAllow, pattern: "Bash(git *)" }
    - { type: alwaysDeny, pattern: "Bash(git push**)" }
    - { type: alwaysAllow, pattern: "Write(src/**)" }
    - { type: alwaysAsk, pattern: "Write(**)" }
    - { type: alwaysDeny, pattern: "Write(src/secret/**)" }
    - { type: alwaysAllow, pattern: Bash }
    - { type: alwaysDeny, pattern: "Bash(rm **)" }
    - { type: alwaysAllow, pattern: "Bash(git *)" }
`;

/** The `yaml` rules a compiled cli bundle carries, in the order it carries them. */
function bundleRules(agentTs: string): PermissionRule[] {
  const out: PermissionRule[] = [];
  const rule = /\{ type: ("[^"]+"), pattern: ("(?:[^"\\]|\\.)*"), source: "yaml" \}/g;
  for (const m of agentTs.matchAll(rule)) {
    out.push({
      type: JSON.parse(m[1] as string) as RuleType,
      pattern: JSON.parse(m[2] as string) as string,
      source: "yaml",
    });
  }
  return out;
}

const CALLS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["Bash", { command: "git push origin main" }],
  ["Bash", { command: "git status" }],
  ["Bash", { command: "rm -rf build" }],
  ["Bash", { command: "ls" }],
  ["Write", { path: "src/a.ts", content: "x" }],
  ["Write", { path: "src/secret/key", content: "x" }],
  ["Write", { path: "docs/x.md", content: "x" }],
  ["Read", { path: "src/a.ts" }],
];

function decisions(yaml: ReadonlyArray<PermissionRule>): string[] {
  const rules = { ...emptyRuleSet, yaml, builtin: BUILTIN_DEFAULT_RULES };
  return CALLS.map(
    ([toolName, input]) =>
      `${toolName} ${JSON.stringify(input)} → ${evaluate(
        { toolName, input, readOnly: toolName === "Read", destructive: toolName !== "Read" },
        "default",
        rules,
      )}`,
  );
}

describe("a pass-applied bundle decides as the CLI does", () => {
  test("the same rules in the same order, and the same decision on every call", () => {
    const agentTs = (opts: { applyIrPasses?: boolean }) =>
      compile(SPEC, opts).files.find((f) => f.path === "agent.ts")?.content ?? "";
    const plain = bundleRules(agentTs({}));
    const passed = bundleRules(agentTs({ applyIrPasses: true }));
    // What `crewhaus run` evaluates: the spec's rules as written.
    const run = (
      lower(parseSpec(SPEC)) as { permissions: { rules: PermissionRule[] } }
    ).permissions.rules.map((r) => ({ type: r.type, pattern: r.pattern, source: "yaml" as const }));

    expect(plain).toHaveLength(8);
    expect(plain).toEqual(run);
    // The pass drops only the repeat at the end.
    expect(passed).toEqual(run.slice(0, 7));
    expect(decisions(passed)).toEqual(decisions(plain));
    expect(decisions(plain)).toEqual(decisions(run));
    // And the order is what decides: the allows written first win.
    expect(decisions(passed)).toEqual([
      'Bash {"command":"git push origin main"} → allow',
      'Bash {"command":"git status"} → allow',
      'Bash {"command":"rm -rf build"} → allow',
      'Bash {"command":"ls"} → allow',
      'Write {"path":"src/a.ts","content":"x"} → allow',
      'Write {"path":"src/secret/key","content":"x"} → allow',
      'Write {"path":"docs/x.md","content":"x"} → ask',
      'Read {"path":"src/a.ts"} → allow',
    ]);
  });
});
