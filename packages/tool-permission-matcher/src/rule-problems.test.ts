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

const tool = (name: string, operativeArgs?: RuleToolDescriptor["operativeArgs"]) => ({
  name,
  key: name.charAt(0).toLowerCase() + name.slice(1),
  ...(operativeArgs !== undefined ? { operativeArgs } : {}),
});
const removePath = tool("RemovePath", [{ kind: "path" }]);
const httpRequest = tool("HttpRequest", [{ kind: "url" }]);
const runCommand = tool("RunCommand", [{ kind: "command" }]);
const clipboardWrite = tool("ClipboardWrite", []);
const legacy = tool("Legacy");
const granted = [removePath, httpRequest, runCommand, clipboardWrite, legacy];
const known = [...granted, tool("HttpBatch", [{ kind: "url" }]), tool("Write", [{ kind: "path" }])];

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

  test("a near miss of a tool name, and nothing for a name it has never heard of", () => {
    expect(problems(["HttpReqest"])[0]).toMatchObject({
      code: "unknown-tool",
      suggestion: "HttpRequest",
    });
    // `Task`, `Consult` and a sub-agent's own tools are added at run time.
    expect(problems(["Task", "Consult", "SomeCustomTool(x)"])).toEqual([]);
  });

  test("an MCP rule for a server the spec does not declare", () => {
    expect(problems(["mcp__github__*"])[0]?.code).toBe("unknown-mcp-server");
    expect(problems(["mcp__github__*"], ["github"])).toEqual([]);
    expect(problems(["mcp__*"])).toEqual([]);
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
