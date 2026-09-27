/**
 * permission-integration#12 — rules that can never do what they say.
 */
import { describe, expect, test } from "bun:test";
import {
  type RuleToolDescriptor,
  argGlobCanMatchUrl,
  compilePattern,
  matchesPattern,
  matchesToolName,
  permissionRuleProblems,
} from "./index";

const tool = (
  name: string,
  operativeArgs?: RuleToolDescriptor["operativeArgs"],
  flags: { destructive?: boolean; requiresSandbox?: boolean } = {},
) => ({
  name,
  key: name.charAt(0).toLowerCase() + name.slice(1),
  ...(operativeArgs !== undefined ? { operativeArgs } : {}),
  ...flags,
});
const safe = { destructive: false, requiresSandbox: false };
const removePath = tool("RemovePath", [{ kind: "path" }], { destructive: true });
const httpRequest = tool("HttpRequest", [{ kind: "url" }], { destructive: true });
const runCommand = tool("RunCommand", [{ kind: "command" }]);
const clipboardWrite = tool("ClipboardWrite", []);
const legacy = tool("Legacy");
const granted = [removePath, httpRequest, runCommand, clipboardWrite, legacy];
const known = [
  ...granted,
  tool("HttpBatch", [{ kind: "url" }]),
  tool("Write", [{ kind: "path" }]),
  tool("Tree", [{ kind: "path" }], safe),
  tool("Shell", [], { destructive: true, requiresSandbox: true }),
];

function problems(patterns: string[], mcpServers: string[] = []) {
  return permissionRuleProblems({
    rules: patterns.map((pattern) => ({ type: "alwaysAllow", pattern })),
    granted,
    known,
    mcpServers,
  });
}

describe("rules that name no tool", () => {
  test("a spec key in place of the tool's name, with the fix", () => {
    const [p] = problems(["removePath(tmp/**)"]);
    expect(p?.code).toBe("tool-key-not-name");
    expect(p?.suggestion).toBe("RemovePath(tmp/**)");
    expect(p?.message).toContain('Write "RemovePath(tmp/**)"');
    // The fix really is the rule the engine would match.
    expect(matchesToolName(compilePattern(p?.suggestion ?? ""), "RemovePath")).toBe(true);
    expect(matchesToolName(compilePattern(p?.pattern ?? ""), "RemovePath")).toBe(false);
    // A key of a builtin the spec does not grant is caught too.
    expect(problems(["write(src/**)"])[0]?.suggestion).toBe("Write(src/**)");
  });

  // The first 0.7.1 cut found a key-form tool half only by upper-casing its
  // first letter, which is not how every builtin's name differs from its key:
  // `codegraph*` and `*script` passed lint and --strict silently and never
  // fired, because the names are CodeGraphSearch… and JavaScript.
  test("a key-form GLOB is caught however the name differs from the key", () => {
    const irregular = [
      { name: "CodeGraphSearch", key: "codegraphSearch", ...safe },
      { name: "CodeGraphCallers", key: "codegraphCallers", ...safe },
      { name: "JavaScript", key: "javascript", destructive: true },
    ];
    const run = (type: string, pattern: string) =>
      permissionRuleProblems({
        rules: [{ type, pattern }],
        granted: irregular,
        known: [...irregular, tool("GraphqlQuery", [{ kind: "url" }])],
        mcpServers: [],
      });
    const cases: Array<[string, string | undefined, string[]]> = [
      ["codegraph*", "CodeGraph*", ["CodeGraphCallers", "CodeGraphSearch"]],
      ["*script", "*Script", ["JavaScript"]],
      ["codegraphSearch", "CodeGraphSearch", ["CodeGraphSearch"]],
      ["codegraphS?arch", undefined, ["CodeGraphSearch"]],
      ["*graph*", "*Graph*", ["CodeGraphCallers", "CodeGraphSearch", "GraphqlQuery"]],
    ];
    for (const [pattern, suggestion, names] of cases) {
      const found = run("alwaysDeny", pattern);
      expect({
        pattern,
        codes: found.map((p) => p.code),
        suggestion: found[0]?.suggestion,
        named: names.every((n) => found[0]?.message.includes(n)),
      }).toEqual({ pattern, codes: ["tool-key-not-name"], suggestion, named: true });
      // Every rewrite offered is one the engine matches, to exactly those tools.
      if (suggestion !== undefined) {
        const compiled = compilePattern(suggestion);
        expect(
          irregular
            .filter((t) => matchesToolName(compiled, t.name))
            .map((t) => t.name)
            .sort(),
        ).toEqual(names.filter((n) => irregular.some((t) => t.name === n)));
      }
    }
    // A glob that already reaches a tool by NAME is not a key-form rule,
    // even when it reaches that tool's key as well (`*Path` is RemovePath's
    // name and the end of its key removePath; the tool is just not granted).
    expect(run("alwaysDeny", "Code*")).toEqual([]);
    expect(
      permissionRuleProblems({
        rules: [{ type: "alwaysDeny", pattern: "*Path" }],
        granted: irregular,
        known: [...irregular, removePath],
        mcpServers: [],
      }),
    ).toEqual([]);
    // No rewrite that would reach a tool the key-form glob did not: here a
    // re-cased `*Graph*` would also allow Graphite, listed as `plotter`.
    const widened = permissionRuleProblems({
      rules: [{ type: "alwaysAllow", pattern: "*graph*" }],
      granted: irregular,
      known: [...irregular, { name: "Graphite", key: "plotter", destructive: true }],
      mcpServers: [],
    });
    expect(widened.map((p) => [p.code, p.suggestion])).toEqual([["tool-key-not-name", undefined]]);
    expect(widened[0]?.message).toContain(
      "Name them by name: CodeGraphCallers and CodeGraphSearch.",
    );
  });

  test("a near miss of a tool name, and nothing for a name it has never heard of", () => {
    expect(problems(["Tre"])[0]).toMatchObject({ code: "unknown-tool", suggestion: "Tree" });
    // `Task`, `Consult` and a sub-agent's own tools are added at run time.
    expect(problems(["Task", "Consult", "SomeCustomTool(x)"])).toEqual([]);
  });

  test("a correction never turns an allow into a grant of a tool that can do more", () => {
    // `alwaysAllow Skil` corrected to `Shell` would allow running code.
    for (const typo of ["Shel", "HttpReqest"]) {
      const [p] = problems([typo]);
      expect(p?.code).toBe("unknown-tool");
      expect(p?.suggestion).toBeUndefined();
      expect(p?.message).toContain("is not offered as the fix");
    }
    expect(problems(["Shel"])[0]?.message).toBe(
      'rule "Shel" matches no tool, so it never fires. The nearest name is Shell, which may change or delete things, so it is not offered as the fix: write "Shell" only if you mean to allow Shell, or remove the rule.',
    );
    // A tool whose flags are not known is treated as one that can do more.
    const unknownFlags = permissionRuleProblems({
      rules: [{ type: "alwaysAllow", pattern: "Clik" }],
      granted: [],
      known: [{ name: "Click" }],
      mcpServers: [],
    });
    expect(unknownFlags[0]?.suggestion).toBeUndefined();
    // A deny or an ask may be corrected towards any tool: it only narrows.
    for (const type of ["alwaysDeny", "alwaysAsk"]) {
      const [p] = permissionRuleProblems({
        rules: [{ type, pattern: "Shel" }],
        granted,
        known,
        mcpServers: [],
      });
      expect(p?.suggestion).toBe("Shell");
    }
  });

  test("a runtime tool the caller knows is never read as a typo of a builtin", () => {
    // What `crewhaus lint` passes: the builtins plus RUNTIME_TOOL_NAMES.
    const withRuntime = [...known, { name: "Skill" }, { name: "Type" }];
    const found = permissionRuleProblems({
      rules: ["Skill", "Type"].map((pattern) => ({ type: "alwaysAllow", pattern })),
      granted,
      known: withRuntime,
      mcpServers: [],
    });
    expect(found).toEqual([]);
    // …and without them, the near miss is reported (the 0.7.1 review finding),
    // with no fix that widens the allow.
    expect(problems(["Type"])[0]).toMatchObject({ code: "unknown-tool", suggestion: "Tree" });
  });

  test("an MCP rule for a server the spec does not declare", () => {
    expect(problems(["mcp__github__*"])[0]?.code).toBe("unknown-mcp-server");
    expect(problems(["mcp__github__*"], ["github"])).toEqual([]);
    expect(problems(["mcp__*"])).toEqual([]);
  });

  test("a declared server whose key contains `__` is found by its key, not by splitting", () => {
    // 0.7.0 ran such keys; the first `__` is not where the server ends.
    expect(problems(["mcp__gh__enterprise__*"], ["gh__enterprise"])).toEqual([]);
    expect(problems(["mcp__gh__enterprise__echo"], ["gh__enterprise"])).toEqual([]);
    expect(problems(["mcp___internal__echo"], ["_internal"])).toEqual([]);
    expect(problems(["mcp__gh__enterprise__*"], ["github"])[0]?.message).toContain(
      'the MCP server "gh"',
    );
  });
});

describe("argument patterns that cannot scope", () => {
  test("a URL rule written after an HTTP method can never match, and the fix does", () => {
    const [p] = problems(["HttpRequest(GET https://api.example.com/**)"]);
    expect(p?.code).toBe("argument-cannot-match");
    expect(p?.suggestion).toBe("HttpRequest(https://api.example.com/**)");
    const values = [{ kind: "url" as const, canonical: ["https://api.example.com/v1"] }];
    const matches = (pattern: string) =>
      matchesPattern(compilePattern(pattern), "HttpRequest", {}, { operativeValues: values });
    expect(matches(p?.pattern ?? "")).toBe(false);
    expect(matches(p?.suggestion ?? "")).toBe(true);
  });

  test("an argument on a tool that declares no scoping field is pointed out", () => {
    const [p] = problems(["ClipboardWrite(*secret*)"]);
    expect(p?.code).toBe("argument-not-scoped");
    expect(p?.suggestion).toBe("ClipboardWrite");
  });

  test("rules that can match are left alone", () => {
    expect(
      problems([
        "HttpRequest(https://api.example.com/**)",
        "HttpRequest(*)",
        "RemovePath(build/**)",
        "RunCommand(git status)",
        "Legacy(anything)",
        "*(x)",
      ]),
    ).toEqual([]);
  });

  test("argGlobCanMatchUrl reads only the fixed start of the glob", () => {
    for (const ok of ["https://x/**", "http*", "ht*", "*", "**evil**", "mailto:*", "HTTPS://X"]) {
      expect({ ok, can: argGlobCanMatchUrl(ok) }).toEqual({ ok, can: true });
    }
    for (const bad of ["GET https://x", "/v1/**", "api.example.com/**", "://x", "1http://x"]) {
      expect({ bad, can: argGlobCanMatchUrl(bad) }).toEqual({ bad, can: false });
    }
  });
});
