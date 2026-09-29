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

  test("a near miss of a tool name, and only a note for a name it has never heard of", () => {
    expect(problems(["Tre"])[0]).toMatchObject({ code: "unknown-tool", suggestion: "Tree" });
    // C146 — `alwaysAllow NoSuchTool(**)` passed as clean. A name known to
    // nothing and close to nothing is noted, with no fix: a plugin or a
    // custom tool may still register it, so it is not called dead.
    const notes = problems(["NoSuchTool(**)", "SomeCustomTool(x)", "undeclared__tool"]);
    expect(notes.map((p) => [p.pattern, p.code, p.suggestion])).toEqual([
      ["NoSuchTool(**)", "tool-not-known", undefined],
      ["SomeCustomTool(x)", "tool-not-known", undefined],
      ["undeclared__tool", "tool-not-known", undefined],
    ]);
    expect(notes[0]?.message).toBe(
      'rule "NoSuchTool(**)" names NoSuchTool, which is no builtin and no tool the runtime adds, so it never fires unless a plugin, a custom tool or an MCP server\'s "<server>__<tool>" spelling registers a tool by that name. Check the name, or remove the rule.',
    );
    // A tie between two near names is noted, not guessed.
    const tie = permissionRuleProblems({
      rules: [{ type: "alwaysDeny", pattern: "Wrote" }],
      granted: [],
      known: [tool("Write"), tool("Wrate")],
      mcpServers: [],
    });
    expect(tie.map((p) => p.code)).toEqual(["tool-not-known"]);
    expect(tie[0]?.message).toContain("equally close to Wrate and Write");
    // A name the caller knows (`Task`, `Consult`, a thredz alias, when it
    // passes them) gets nothing; a glob gets nothing; an MCP rule for a
    // declared server gets nothing.
    const withRuntime = [...known, { name: "Task" }, { name: "Consult" }, { name: "goal_list" }];
    expect(
      permissionRuleProblems({
        rules: ["Task", "Consult", "goal_list", "Nothing*", "web__fetch"].map((pattern) => ({
          type: "alwaysAllow",
          pattern,
        })),
        granted,
        known: withRuntime,
        mcpServers: ["web"],
      }),
    ).toEqual([]);
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

describe("a rule spelled another way than the tool's name (C146)", () => {
  // The engine matches a name exactly. Before this, only a near miss of one
  // or two letters and a key-form glob were caught, so these denies passed
  // lint and `compile --strict` silently and never fired.
  const tools = [
    { name: "RemovePath", key: "removePath", destructive: true },
    { name: "WebFetch", key: "webFetch", ...safe },
    { name: "Fetch", key: "fetch", ...safe },
    { name: "JavaScript", key: "javascript", destructive: true },
    { name: "CodeGraphSearch", key: "codegraphSearch", ...safe },
    { name: "CodeGraphCallers", key: "codegraphCallers", ...safe },
  ];
  const check = (type: string, pattern: string, mcpServers: string[] = []) =>
    permissionRuleProblems({
      rules: [{ type, pattern }],
      granted: tools,
      known: tools,
      mcpServers,
    });
  const reachedBy = (pattern: string) => {
    const compiled = compilePattern(pattern);
    return tools
      .filter((t) => matchesToolName(compiled, t.name))
      .map((t) => t.name)
      .sort();
  };

  test("each variant is reported as never firing, and the fix reaches exactly the tools it names", () => {
    const cases: Array<[string, string | undefined, string[]]> = [
      ["REMOVEPATH", "RemovePath", ["RemovePath"]],
      ["remove_path", "RemovePath", ["RemovePath"]],
      ["Remove-Path", "RemovePath", ["RemovePath"]],
      ["web fetch", "WebFetch", ["WebFetch"]],
      ["JAVASCRIPT", "JavaScript", ["JavaScript"]],
      ["Codegraph*", "CodeGraph*", ["CodeGraphCallers", "CodeGraphSearch"]],
      ["CODEGRAPH*", "CodeGraph*", ["CodeGraphCallers", "CodeGraphSearch"]],
      ["*FETCH", "*Fetch", ["Fetch", "WebFetch"]],
      ["CodeGraph*search", undefined, ["CodeGraphSearch"]],
      ["code_graph_*", "CodeGraph*", ["CodeGraphCallers", "CodeGraphSearch"]],
    ];
    let reported = 0;
    for (const [pattern, suggestion, names] of cases) {
      // The property: the rule as written reaches nothing by name.
      expect({ pattern, reaches: reachedBy(pattern) }).toEqual({ pattern, reaches: [] });
      const found = check("alwaysDeny", pattern);
      reported += found.length;
      expect({
        pattern,
        codes: found.map((p) => p.code),
        suggestion: found[0]?.suggestion,
        named: names.every((n) => found[0]?.message.includes(n)),
        says: found[0]?.message.includes("never fires"),
      }).toEqual({ pattern, codes: ["unknown-tool"], suggestion, named: true, says: true });
      if (suggestion !== undefined) expect(reachedBy(suggestion)).toEqual(names);
    }
    expect(reported).toBe(cases.length);
  });

  test("a name the runtime spells with underscores is found the same way", () => {
    const found = permissionRuleProblems({
      rules: [{ type: "alwaysDeny", pattern: "WikiWrite" }],
      granted: tools,
      known: [...tools, { name: "wiki_write" }],
      mcpServers: [],
    });
    expect(found.map((p) => [p.code, p.suggestion])).toEqual([["unknown-tool", "wiki_write"]]);
  });

  test("no rewrite when the re-cased glob would reach fewer tools than the rule was read as naming", () => {
    // `CODEGRAPH*` reads as all three; `CodeGraph*` would miss Codegraphviz.
    const withViz = [...tools, { name: "Codegraphviz", key: "codegraphviz", ...safe }];
    const found = permissionRuleProblems({
      rules: [{ type: "alwaysDeny", pattern: "CODEGRAPH*" }],
      granted: withViz,
      known: withViz,
      mcpServers: [],
    });
    expect(found.map((p) => [p.code, p.suggestion])).toEqual([["unknown-tool", undefined]]);
    expect(found[0]?.message).toContain(
      "Name them by name: CodeGraphCallers, CodeGraphSearch and Codegraphviz.",
    );
  });

  test("an allow is not rewritten into a grant of a tool that can change or delete things", () => {
    const [p] = check("alwaysAllow", "REMOVEPATH");
    expect(p?.code).toBe("unknown-tool");
    expect(p?.suggestion).toBeUndefined();
    expect(p?.message).toContain("may change or delete things, so no fix is offered");
    // A read-only tool's spelling is corrected on an allow too.
    expect(check("alwaysAllow", "Codegraph*")[0]?.suggestion).toBe("CodeGraph*");
  });

  test("a glob that reaches a tool by name is a live spelling, not a misspelling", () => {
    // `Code*` reaches the CodeGraph tools; `Web*` reaches WebFetch although it
    // is not granted here, and so does the runtime's own `Task`.
    const known = [...tools, { name: "Task" }];
    for (const pattern of ["Web*", "Task"]) {
      expect(
        permissionRuleProblems({
          rules: [{ type: "alwaysDeny", pattern }],
          granted: tools.filter((t) => t.name !== "WebFetch"),
          known,
          mcpServers: [],
        }),
      ).toEqual([]);
    }
  });
});

describe("a glob that can still match a declared MCP server's tools", () => {
  // 89df527f reported `alwaysDeny *write*` as a key-form rule that "never
  // fires" and failed `compile --strict` on it, though it fires on
  // mcp__fs__write_file; following its fix (`Write`) dropped that deny.
  const read = { name: "Read", key: "read", ...safe };
  const grep = { name: "Grep", key: "grep", ...safe };
  const write = { name: "Write", key: "write", destructive: true };
  const run = (granted: RuleToolDescriptor[], mcpServers: string[], pattern = "*write*") =>
    permissionRuleProblems({
      rules: [{ type: "alwaysDeny", pattern }],
      granted,
      known: [read, grep, write, removePath],
      mcpServers,
    });

  test("is not reported as dead when no granted builtin is missed", () => {
    expect(matchesToolName(compilePattern("*write*"), "mcp__fs__write_file")).toBe(true);
    expect(run([read, grep], ["fs"])).toEqual([]);
    expect(run([read, grep], ["github"], "*remove*")).toEqual([]);
    // Without a declared server nothing can match it, and it is still dead.
    expect(run([read, grep], []).map((p) => p.code)).toEqual(["tool-key-not-name"]);
  });

  test("names a granted builtin it misses, as a note with no rewrite", () => {
    const found = run([read, write], ["fs"]);
    expect(found.map((p) => [p.code, p.suggestion])).toEqual([["builtin-not-reached", undefined]]);
    expect(found[0]?.message).toContain("can match tools of the MCP server fs");
    expect(found[0]?.message).toContain("add a rule that names it: Write");
    expect(found[0]?.message).not.toContain("never fires");
  });

  test("a glob whose fixed start rules out every declared server is judged as before", () => {
    // `Remove_*` cannot start `mcp__fs__` or the old `fs__` spelling.
    expect(run([removePath], ["fs"], "Remove_*").map((p) => [p.code, p.suggestion])).toEqual([
      ["unknown-tool", "Remove*"],
    ]);
    // The old `<server>__` spelling still reaches the server's tools:
    // `file*` fires on mcp__files__list through it, so it is only a note.
    expect(matchesToolName(compilePattern("file*"), "mcp__files__list")).toBe(true);
    const fileInfo = { name: "FileInfo", key: "fileInfo", ...safe };
    expect(run([fileInfo], ["files"], "file*").map((p) => p.code)).toEqual(["builtin-not-reached"]);
    expect(run([fileInfo], [], "file*").map((p) => p.code)).toEqual(["tool-key-not-name"]);
  });

  test("an exact name in the old `<server>__<tool>` spelling is an MCP rule, not a misspelled builtin", () => {
    // `web__fetch` folds to `webfetch`, as WebFetch does, but it fires on
    // mcp__web__fetch; calling it dead and offering `WebFetch` would move the
    // deny off the MCP tool onto a builtin.
    const webFetch = { name: "WebFetch", key: "webFetch", ...safe };
    expect(matchesToolName(compilePattern("web__fetch"), "mcp__web__fetch")).toBe(true);
    expect(run([webFetch], ["web"], "web__fetch")).toEqual([]);
    // With no `web` server declared, nothing can match it, and it is dead.
    expect(run([webFetch], [], "web__fetch").map((p) => [p.code, p.suggestion])).toEqual([
      ["unknown-tool", "WebFetch"],
    ]);
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
