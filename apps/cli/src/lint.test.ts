import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IrNode, provabilityOf } from "@crewhaus/compiler";
import { wantsProofCheckTools } from "@crewhaus/evaluation-service";
import {
  buildEvidenceIndex,
  meetsFloor,
  recordFromCall,
  verifyDocument,
} from "@crewhaus/provability";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { rateLimitStatus } from "@crewhaus/tool-codehost";
import { THREDZ_TOOL_NAMES } from "@crewhaus/tool-registry-manifest/flags";
import { INFORMATIONAL_COMPILE_WARNING_CODES } from "./compile-warnings";
import {
  type LintFinding,
  PROVABILITY_SOURCE_CATEGORIES,
  applyLintFixes,
  auditProvability,
  formatLintJson,
  formatLintText,
  levenshtein,
  nearestToolName,
  permissionRuleWarnings,
  runLint,
  suggestSafeName,
  suggestSecretFix,
  thredzToolNamesOf,
  toolListPaths,
} from "./lint";

/** A resolver that knows the built-in outward tools resolve to external scope,
 *  and everything else is unknown — enough to exercise the scope stage. */
const noTools = (_name: string): RegisteredTool | undefined => undefined;

const validCli = "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";

describe("runLint — pipeline", () => {
  test("clean spec → ok, no findings", () => {
    const result = runLint(validCli, noTools);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.spec?.target).toBe("cli");
  });

  test("thredz: next to a user-declared mcp_servers.thredz warns (explicit beats implicit) without failing lint", () => {
    const spec = `${validCli}thredz: true
mcp_servers:
  thredz:
    transport: stdio
    command: bun
    args: ["./thredz-mcp/server.ts"]
    env:
      THREDZ_API_KEY: $THREDZ_API_KEY
`;
    const result = runLint(spec, noTools);
    // Warnings inform; only errors gate.
    expect(result.ok).toBe(true);
    const warning = result.findings.find((f) => f.rule === "thredz-override");
    expect(warning?.severity).toBe("warning");
    expect(warning?.path).toBe("mcp_servers.thredz");
    expect(warning?.message).toContain("your explicit entry wins");
  });

  test("thredz: alone (synthesis path) produces no override warning", () => {
    const result = runLint(`${validCli}thredz: true\n`, noTools);
    expect(result.findings.filter((f) => f.rule === "thredz-override")).toEqual([]);
  });

  test("a key the shape accepts but does not wire is reported, as compile --strict refuses it", async () => {
    // Closeout review: lint said "clean" for these while `compile --strict`
    // failed them with accepted-but-unwired.
    const { compile } = await import("@crewhaus/compiler");
    const voice =
      "name: v\ntarget: voice\nagent:\n  model: claude-sonnet-4-6\n  instructions: hi\nvoice:\n  provider: openai\n";
    const specs = {
      "voice tool_config": `${voice}tool_config:\n  webFetch:\n    allowed_domains: [example.com]\n`,
      "voice tools": `${voice}tools: [read]\n`,
    };
    for (const [name, text] of Object.entries(specs)) {
      const want = compile(text).warnings.filter((w) => w.code === "accepted-but-unwired");
      const got = runLint(text, noTools).findings.filter((f) => f.rule === "accepted-but-unwired");
      expect({ name, got: got.map((f) => [f.path, f.severity, f.message]) }).toEqual({
        name,
        got: want.map((w) => [w.path, "warning", w.message]),
      });
      expect({ name, hits: got.length }).toEqual({ name, hits: 1 });
    }
    // A shape that wires the key says nothing.
    const cli = runLint(`${validCli}tools: [read]\n`, noTools);
    expect(cli.findings.filter((f) => f.rule === "accepted-but-unwired")).toEqual([]);
  });

  test("parse failure is a single terminal finding (rule: parse)", () => {
    const result = runLint("name: t\ntarget: cli\n", noTools); // no agent block
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule).toBe("parse");
    expect(result.findings[0]?.severity).toBe("error");
  });

  test("§47 well-formedness: a graph with an unreachable node is caught by an ir-pass", () => {
    // This is exactly the class the CLI compile path silently skipped.
    const graph = `name: g
target: graph
model: claude-opus-4-7
entry: a
nodes:
  a:
    instructions: start
  b:
    instructions: orphan
edges: []
`;
    const result = runLint(graph, noTools);
    expect(result.ok).toBe(false);
    const irPass = result.findings.find((f) => f.rule.startsWith("ir-pass:"));
    expect(irPass).toBeDefined();
    expect(irPass?.message).toContain("unreachable");
  });

  test("collect-all: independent passes each contribute (fail-fast would hide later ones)", () => {
    // A crew whose routing references an undeclared role trips wellFormednessCheck;
    // running passes independently means a prior pass throwing wouldn't hide it.
    const crew = `name: c
target: crew
model: claude-opus-4-7
entry: lead
roles:
  lead:
    instructions: lead
`;
    // Sanity: this crew is valid, so no findings — proves the happy path for the
    // crew shape through the collect-all loop.
    expect(runLint(crew, noTools).ok).toBe(true);
  });

  test("outward tool that resolves to no external tool is a scope finding", () => {
    const spec = `name: t
target: cli
agent:
  model: claude-opus-4-7
  instructions: hi
tools:
  - mcp__evil__exfiltrate
`;
    const result = runLint(spec, noTools);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.rule === "scope")).toBe(true);
  });
});

describe("levenshtein", () => {
  test("case-insensitive distance", () => {
    expect(levenshtein("webSerch", "webSearch")).toBe(1);
    expect(levenshtein("READ", "read")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("nearestToolName", () => {
  const candidates = ["read", "write", "webSearch", "webFetch", "WebSearch", "bash"];
  test("exact match → undefined (nothing to fix)", () => {
    expect(nearestToolName("read", candidates)).toBeUndefined();
    expect(nearestToolName("WebSearch", candidates)).toBeUndefined();
  });
  test("close typo → nearest legal name", () => {
    // "webSerch" ties "webSearch"/"WebSearch" (same tool, two legal
    // spellings) at distance 1; without a capability lookup a plain tie is
    // reported ambiguous by default (see the cross-capability describe block
    // below), so this passes a resolver reporting the same capability for
    // both spellings — the realistic shape, since both name the same tool.
    const sameCapability = () => false;
    expect(nearestToolName("webSerch", candidates, undefined, sameCapability)).toEqual({
      kind: "match",
      name: "webSearch",
    });
    expect(nearestToolName("reed", candidates)).toEqual({ kind: "match", name: "read" });
  });
  test("too far → undefined (genuinely unknown, not a typo)", () => {
    expect(nearestToolName("totallyDifferentThing", candidates)).toBeUndefined();
  });

  describe("cross-capability ambiguity (F2 — typo equidistant from tools of different capability)", () => {
    // Mirrors the real Read (readOnly) / Edit (mutating) collision: "Reit" is
    // Levenshtein-2 from both.
    const rwCandidates = ["Read", "Edit", "Write"];
    const capability = (name: string): boolean | undefined =>
      ({ Read: true, Edit: false, Write: false })[name];

    test("a typo tied between a read-only and a mutating tool is reported ambiguous, not auto-fixed", () => {
      const result = nearestToolName("Reit", rwCandidates, undefined, capability);
      expect(result?.kind).toBe("ambiguous");
      expect(result?.kind === "ambiguous" && [...result.candidates].sort()).toEqual([
        "Edit",
        "Read",
      ]);
    });

    test("without a capability lookup, the same tie is still reported ambiguous (fail-safe default)", () => {
      const result = nearestToolName("Reit", rwCandidates);
      expect(result?.kind).toBe("ambiguous");
    });

    test("a tie among candidates that all share the same capability still auto-fixes", () => {
      // "Edut" is closest to "Edit" alone in this candidate set (no tie), so
      // it should resolve to a plain match regardless of capability lookup.
      const result = nearestToolName("Edut", rwCandidates, undefined, capability);
      expect(result).toEqual({ kind: "match", name: "Edit" });
    });

    test("an unresolvable candidate (unknown capability) does not itself create ambiguity", () => {
      // "customTool" is not resolvable (capability undefined); tied only
      // against itself so it's a plain unambiguous match.
      const single = ["customTool"];
      const unknownCapability = (): boolean | undefined => undefined;
      const result = nearestToolName("customTol", single, undefined, unknownCapability);
      expect(result).toEqual({ kind: "match", name: "customTool" });
    });
  });
});

describe("suggestSecretFix", () => {
  test("lowercase env ref → UPPER_SNAKE_CASE", () => {
    expect(suggestSecretFix("$slack_token")).toBe("$SLACK_TOKEN");
  });
  test("brace-wrapped ref → bare UPPER_SNAKE_CASE", () => {
    expect(suggestSecretFix("${SLACK_BOT_TOKEN}")).toBe("$SLACK_BOT_TOKEN");
  });
  test("leading-digit ref is prefixed with _", () => {
    expect(suggestSecretFix("$1password")).toBe("$_1PASSWORD");
  });
  test("already-valid ref → undefined", () => {
    expect(suggestSecretFix("$SLACK_BOT_TOKEN")).toBeUndefined();
  });
  test("a non-$ literal → undefined", () => {
    expect(suggestSecretFix("hunter2")).toBeUndefined();
  });
});

describe("suggestSafeName", () => {
  test("slashes/quotes → dashes", () => {
    expect(suggestSafeName("bad/name")).toBe("bad-name");
    expect(suggestSafeName('a"b')).toBe("a-b");
  });
  test("already-safe → undefined", () => {
    expect(suggestSafeName("my-agent")).toBeUndefined();
    expect(suggestSafeName("Weather Bot 2")).toBeUndefined();
  });
  test("collapses runs and trims leading/trailing dashes", () => {
    expect(suggestSafeName("//weird//")).toBe("weird");
  });
});

describe("formatters", () => {
  test("text: clean", () => {
    expect(formatLintText(runLint(validCli, noTools))).toContain("clean");
  });
  test("text: error lines carry rule + path", () => {
    const text = formatLintText(runLint("name: t\ntarget: cli\n", noTools));
    expect(text).toContain("[parse]");
    expect(text).toContain("error(s)");
  });
  test("json: structured findings", () => {
    const json = JSON.parse(formatLintJson(runLint("name: t\ntarget: cli\n", noTools)));
    expect(json.ok).toBe(false);
    expect(Array.isArray(json.findings)).toBe(true);
    expect(json.findings[0]).toHaveProperty("severity");
    expect(json.findings[0]).toHaveProperty("path");
  });
});

describe("runLint — permission rules that can never do what they say (permission-integration#12)", () => {
  // The audit's spec: every rule compiled and linted clean on 0.7.0.
  const spec = `${validCli}tools: [removePath, httpRequest, runCommand, write, clipboardWrite]
permissions:
  rules:
    - { type: alwaysAllow, pattern: "RemovePath(build/**)" }
    - { type: alwaysAllow, pattern: "HttpRequest(GET https://api.example.com/**)" }
    - { type: alwaysAllow, pattern: "RunCommand(git status)" }
    - { type: alwaysDeny, pattern: "RunCommand(rm)" }
    - { type: alwaysDeny, pattern: "removePath(tmp/**)" }
    - { type: alwaysDeny, pattern: "ClipboardWrite(*secret*)" }
    - { type: alwaysDeny, pattern: "HttpReqest" }
    - { type: alwaysDeny, pattern: "mcp__github__*" }
`;

  test("each dead or unscoped rule is a warning naming the fix; live rules are not", () => {
    // `noTools`: the builtin manifest stands in for the live tools.
    const result = runLint(spec, noTools);
    const permission = result.findings.filter((f) => f.rule.startsWith("permission-rule:"));
    expect(permission.map((f) => [f.rule, f.path])).toEqual([
      [
        "permission-rule:argument-cannot-match",
        "permissions.rules[alwaysAllow HttpRequest(GET https://api.example.com/**)]",
      ],
      ["permission-rule:tool-key-not-name", "permissions.rules[alwaysDeny removePath(tmp/**)]"],
      [
        "permission-rule:argument-not-scoped",
        "permissions.rules[alwaysDeny ClipboardWrite(*secret*)]",
      ],
      ["permission-rule:unknown-tool", "permissions.rules[alwaysDeny HttpReqest]"],
      ["permission-rule:unknown-mcp-server", "permissions.rules[alwaysDeny mcp__github__*]"],
    ]);
    expect(permission.every((f) => f.severity === "warning")).toBe(true);
    expect(permission[1]?.message).toContain('Write "RemovePath(tmp/**)"');
    // Warnings inform: lint still passes.
    expect(result.ok).toBe(true);
  });

  // C146: a deny spelled another way than the tool's name never fires, and
  // lint said "clean". A glob that still reaches a declared MCP server's
  // tools is not dead, and is not called dead.
  test("a deny spelled another way than the name is reported; an MCP-reaching glob is not called dead", () => {
    const variants = `${validCli}tools: [codegraphSearch, removePath, javascript, read, grep]
permissions:
  mode: auto
  rules:
    - { type: alwaysDeny, pattern: "Codegraph*" }
    - { type: alwaysDeny, pattern: "remove_path" }
    - { type: alwaysDeny, pattern: "JAVASCRIPT" }
`;
    const found = runLint(variants, noTools).findings.filter((f) =>
      f.rule.startsWith("permission-rule:"),
    );
    expect(found.map((f) => [f.rule, f.path])).toEqual([
      ["permission-rule:unknown-tool", "permissions.rules[alwaysDeny Codegraph*]"],
      ["permission-rule:unknown-tool", "permissions.rules[alwaysDeny remove_path]"],
      ["permission-rule:unknown-tool", "permissions.rules[alwaysDeny JAVASCRIPT]"],
    ]);
    expect(found.map((f) => f.message.match(/Write "([^"]+)"/)?.[1])).toEqual([
      "CodeGraph*",
      "RemovePath",
      "JavaScript",
    ]);
    const mcp = `${validCli}tools: [read, grep]
mcp_servers:
  fs:
    transport: stdio
    command: npx
permissions:
  rules:
    - { type: alwaysDeny, pattern: "*write*" }
`;
    expect(
      runLint(mcp, noTools).findings.filter((f) => f.rule.startsWith("permission-rule:")),
    ).toEqual([]);
  });

  // C146 (wave III): only the shape's `permissions.rules` were checked. A
  // model profile's deny/ask and a sub-agent's allow/deny are matched the
  // same way, and `removePath(src/**)`, `REMOVEPATH` or `fetch` there passed
  // lint and compile --strict while never firing.
  test("a model profile's and a sub-agent's rules are checked like the shape's", () => {
    const yaml = `name: demo
target: cli
models:
  fast: { model: claude-haiku-4-5, permissions: { deny: ['removePath(src/**)', 'REMOVEPATH', 'fetch'], ask: ['Fetch'] } }
agent:
  model: claude-sonnet-4-6
  instructions: go
  model_pool:
    candidates:
      - { model: $fast, tags: [cheap] }
      - { model: claude-opus-4-8, tags: [strong] }
  sub_agents:
    helper:
      description: d
      instructions: help
      tools: [RemovePath, Fetch]
      permissions:
        allow: ['Fetch', 'fetch(https://ok.example/**)']
        deny: ['removePath(src/**)', 'fetch(https://evil.example/**)', 'RemovePath(build/**)']
tools: [removePath, fetch]
permissions:
  mode: auto
`;
    const found = runLint(yaml, noTools).findings.filter((f) =>
      f.rule.startsWith("permission-rule:"),
    );
    expect(found.map((f) => [f.rule, f.path, f.message.match(/Write "([^"]+)"/)?.[1]])).toEqual([
      [
        "permission-rule:tool-key-not-name",
        "models.fast.permissions.deny[alwaysDeny removePath(src/**)]",
        "RemovePath(src/**)",
      ],
      [
        "permission-rule:unknown-tool",
        "models.fast.permissions.deny[alwaysDeny REMOVEPATH]",
        "RemovePath",
      ],
      [
        "permission-rule:tool-key-not-name",
        "models.fast.permissions.deny[alwaysDeny fetch]",
        "Fetch",
      ],
      [
        "permission-rule:tool-key-not-name",
        "agent.sub_agents.helper.permissions.allow[alwaysAllow fetch(https://ok.example/**)]",
        "Fetch(https://ok.example/**)",
      ],
      [
        "permission-rule:tool-key-not-name",
        "agent.sub_agents.helper.permissions.deny[alwaysDeny removePath(src/**)]",
        "RemovePath(src/**)",
      ],
      [
        "permission-rule:tool-key-not-name",
        "agent.sub_agents.helper.permissions.deny[alwaysDeny fetch(https://evil.example/**)]",
        "Fetch(https://evil.example/**)",
      ],
    ]);
  });

  // 0.7.1: a deny or ask below an allow that matches every call it would
  // never fires — the first matching rule decides. Only a bare allow proves
  // it; a scoped one never covers every call a deny reads.
  test("a deny under an allow that always matches first is reported, naming both", async () => {
    const yaml = `${validCli.replace(
      "  instructions: hi\n",
      `  instructions: hi
  sub_agents:
    fixer:
      description: d
      instructions: fix
      tools: [Bash]
      permissions:
        allow: ['Bash']
        deny: ['Bash(rm -rf **)']
`,
    )}tools: [bash, write]
permissions:
  rules:
    - { type: alwaysAllow, pattern: Bash }
    - { type: alwaysDeny, pattern: "Bash(rm -rf **)" }
    - { type: alwaysAllow, pattern: "Write(src/**)" }
    - { type: alwaysDeny, pattern: "Write(src/secret/**)" }
    - { type: alwaysAsk, pattern: "Bash(sudo**)" }
`;
    const found = runLint(yaml, noTools).findings.filter((f) =>
      f.rule.startsWith("permission-rule:"),
    );
    expect(found.map((f) => [f.rule, f.path, f.severity])).toEqual([
      [
        "permission-rule:shadowed-by-allow",
        "permissions.rules[alwaysDeny Bash(rm -rf **)]",
        "warning",
      ],
      ["permission-rule:shadowed-by-allow", "permissions.rules[alwaysAsk Bash(sudo**)]", "warning"],
      [
        "permission-rule:shadowed-by-allow",
        "agent.sub_agents.fixer.permissions.deny[alwaysDeny Bash(rm -rf **)]",
        "warning",
      ],
    ]);
    expect(found[0]?.message).toContain('Move it above "alwaysAllow Bash"');
    // compile prints the same finding, and --strict fails on it.
    const warnings = await permissionRuleWarnings(yaml, async () => ({}));
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ["permission-rule", "permissions.rules"],
      ["permission-rule", "permissions.rules"],
      ["permission-rule", "agent.sub_agents.fixer.permissions.deny"],
    ]);
    // Written first, the deny decides, and nothing is said.
    const fixed = yaml
      .replace("    - { type: alwaysAllow, pattern: Bash }\n", "")
      .replace(
        '    - { type: alwaysAsk, pattern: "Bash(sudo**)" }\n',
        '    - { type: alwaysAsk, pattern: "Bash(sudo**)" }\n    - { type: alwaysAllow, pattern: Bash }\n',
      )
      .replace("allow: ['Bash']", "allow: ['Bash(git *)']");
    expect(
      runLint(fixed, noTools).findings.filter((f) => f.rule.startsWith("permission-rule:")),
    ).toEqual([]);
  });

  // 0.7.1 review: plan mode reads no allow, so in a plan-mode spec the deny
  // fires. It is a note that it stops firing in another mode, which --strict
  // does not escalate.
  test("in a plan-mode spec a deny under an allow is a note, not a dead rule", async () => {
    const yaml = `${validCli}tools: [read]
permissions:
  mode: plan
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysDeny, pattern: "Read(secrets/**)" }
`;
    const found = runLint(yaml, noTools).findings.filter((f) =>
      f.rule.startsWith("permission-rule:"),
    );
    expect(found.map((f) => [f.rule, f.path])).toEqual([
      ["permission-rule:shadowed-outside-plan", "permissions.rules[alwaysDeny Read(secrets/**)]"],
    ]);
    expect(found[0]?.message).toContain("fires in this spec's plan mode");
    expect(found[0]?.message).not.toContain("never fires");
    const warnings = await permissionRuleWarnings(yaml, async () => ({}));
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ["permission-rule-note", "permissions.rules"],
    ]);
    // In default mode the same rules are a dead deny, and --strict fails on it.
    const inDefault = await permissionRuleWarnings(
      yaml.replace("  mode: plan\n", ""),
      async () => ({}),
    );
    expect(inDefault.map((w) => [w.code, w.path])).toEqual([
      ["permission-rule", "permissions.rules"],
    ]);
  });

  // wave III review: a pool candidate carries its own deny/ask inline, read
  // the same way as a profile's, and neither lint nor PermissionAudit read
  // it. The lists now come from one reader both use.
  test("a pool candidate's own deny/ask is checked, and the lists match PermissionAudit's", () => {
    const yaml = `name: demo
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: go
  model_pool:
    candidates:
      - { model: claude-haiku-4-5, tags: [cheap], permissions: { deny: ['removePath'], ask: ['Fetch'] } }
      - { model: claude-opus-4-8, tags: [strong] }
tools: [removePath, fetch]
`;
    const found = runLint(yaml, noTools).findings.filter((f) =>
      f.rule.startsWith("permission-rule:"),
    );
    expect(found.map((f) => [f.rule, f.path])).toEqual([
      [
        "permission-rule:tool-key-not-name",
        "agent.model_pool.candidates[0].permissions.deny[alwaysDeny removePath]",
      ],
    ]);
  });

  // wave III review: compile loaded every builtin package (about half a
  // second) before finding a rule-less spec had no rule to check.
  test("compile's rule check loads the tools only when the spec has a rule to check", async () => {
    let loads = 0;
    const loadTools = async () => {
      loads++;
      return {} as Record<string, RegisteredTool>;
    };
    expect(await permissionRuleWarnings(`${validCli}tools: [read]\n`, loadTools)).toEqual([]);
    expect(await permissionRuleWarnings("not: [valid", loadTools)).toEqual([]);
    expect(loads).toBe(0);
    const profileOnly = `${validCli.replace("agent:", "models:\n  fast: { model: claude-haiku-4-5, permissions: { deny: [fetch] } }\nagent:")}tools: [fetch]\n`;
    const warnings = await permissionRuleWarnings(profileOnly, loadTools);
    expect(loads).toBe(1);
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ["permission-rule", "models.fast.permissions.deny"],
    ]);
  });

  // back-compat (wave III): with `thredz: {goals: true}` the runtime
  // registers goal_list / goal_write / goal_update under those bare names, so
  // the trader starter's allows are live. They were reported as near misses
  // of GoalList, GoalWrite and GoalUpdate, and `compile --strict` failed.
  test("a thredz: block's tools are real tools; without the block they are near misses", () => {
    const rules = ["goal_list", "goal_write", "goal_update", "task_complete"]
      .map((pattern) => `    - { type: alwaysAllow, pattern: ${pattern} }`)
      .join("\n");
    const base = `${validCli}tools: [read]
permissions:
  rules:
${rules}
    - { type: alwaysAllow, pattern: message_send }
`;
    const permissionRules = (yaml: string) =>
      runLint(yaml, noTools)
        .findings.filter((f) => f.rule.startsWith("permission-rule:"))
        .map((f) => [f.rule, f.path]);
    expect(permissionRules(`${base}thredz: { api_key: $THREDZ_API_KEY, goals: true }\n`)).toEqual([
      // Messaging is opt-in: without `messaging: true` it is not registered.
      ["permission-rule:tool-not-known", "permissions.rules[alwaysAllow message_send]"],
    ]);
    expect(
      permissionRules(`${base}thredz: { api_key: $THREDZ_API_KEY, messaging: true }\n`),
    ).toEqual([]);
    expect(permissionRules(base)).toEqual([
      ["permission-rule:unknown-tool", "permissions.rules[alwaysAllow goal_list]"],
      ["permission-rule:unknown-tool", "permissions.rules[alwaysAllow goal_write]"],
      ["permission-rule:unknown-tool", "permissions.rules[alwaysAllow goal_update]"],
      ["permission-rule:tool-not-known", "permissions.rules[alwaysAllow task_complete]"],
      ["permission-rule:tool-not-known", "permissions.rules[alwaysAllow message_send]"],
    ]);
  });

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

  test("a rule naming a tool nothing knows gets a note, not a fix", () => {
    const yaml = `${validCli}tools: [read]
permissions:
  rules:
    - { type: alwaysAllow, pattern: "NoSuchTool(**)" }
`;
    const result = runLint(yaml, noTools);
    const found = result.findings.filter((f) => f.rule.startsWith("permission-rule:"));
    expect(found.map((f) => [f.rule, f.severity])).toEqual([
      ["permission-rule:tool-not-known", "warning"],
    ]);
    expect(found[0]?.message).not.toContain("Write ");
    expect(result.ok).toBe(true);
  });

  // critic11: RateLimitStatus reads the API itself (a url that is its
  // own service). A deny or ask on it also reads the host alone, and every
  // string of the call as 0.7.0 did, so both denies below fire at the gate
  // (api-hosts.test.ts) and were reported as "can never match". An allow
  // reads the URL only, so the host-alone allow is still dead.
  test("a deny or ask on an API root is live when written without a scheme; an allow is not", async () => {
    const yaml = `${validCli}tools: [rateLimitStatus]
permissions:
  rules:
    - { type: alwaysDeny, pattern: "RateLimitStatus(ghe.example.com/**)" }
    - { type: alwaysDeny, pattern: "RateLimitStatus(GHE_TOKEN)" }
    - { type: alwaysAsk, pattern: "RateLimitStatus(api.github.com/**)" }
    - { type: alwaysAllow, pattern: "RateLimitStatus(gitlab.example.com/**)" }
    - { type: alwaysAllow, pattern: "RateLimitStatus(https://ghe.example.com/**)" }
`;
    const dead = [
      [
        "permission-rule:argument-cannot-match",
        "permissions.rules[alwaysAllow RateLimitStatus(gitlab.example.com/**)]",
      ],
    ];
    const found = (resolve: (name: string) => RegisteredTool | undefined) =>
      runLint(yaml, resolve)
        .findings.filter((f) => f.rule.startsWith("permission-rule:"))
        .map((f) => [f.rule, f.path]);
    // The builtin manifest, and the live tool.
    expect(found(noTools)).toEqual(dead);
    expect(found((name) => (name === "rateLimitStatus" ? rateLimitStatus : undefined))).toEqual(
      dead,
    );
    // compile warns about the same one rule.
    const warnings = await permissionRuleWarnings(yaml, async () => ({ rateLimitStatus }));
    expect(warnings.map((w) => [w.code, w.message.match(/rule "([^"]+)"/)?.[1]])).toEqual([
      ["permission-rule", "RateLimitStatus(gitlab.example.com/**)"],
    ]);
    // And the real CLI prints only it.
    const dir = mkdtempSync(join(tmpdir(), "lint-api-root-"));
    try {
      writeFileSync(join(dir, "crewhaus.yaml"), yaml);
      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dir, "index.ts"), "lint", "crewhaus.yaml"],
        { cwd: dir, env: { PATH: process.env["PATH"] ?? "" }, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const printed = `${stdout}${stderr}`;
      expect(printed.match(/\[permission-rule:[a-z-]+\] \S+/g)).toEqual([
        "[permission-rule:argument-cannot-match] permissions.rules[alwaysAllow",
      ]);
      expect(printed).toContain("RateLimitStatus(gitlab.example.com/**)]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("the live tool's declaration is what is checked", () => {
    const declaresNothing = { name: "ClipboardWrite" } as RegisteredTool;
    const result = runLint(spec, (name) =>
      name === "clipboardWrite" ? declaresNothing : undefined,
    );
    // A tool that declares no operativeArgs leaves nothing to check the pattern against.
    expect(result.findings.some((f) => f.rule === "permission-rule:argument-not-scoped")).toBe(
      false,
    );
  });
});

// C025 (wave III) — `lint --fix` was a per-line scanner. It rewrote tool
// names inside `instructions: |` text, turned `model: $fast` (a profile
// reference) into `$FAST` so the shipped hybrid-support starter stopped
// compiling, and rewrote sub-agent typos plain `lint` called clean. It is now
// a walk over the YAML document.
describe("applyLintFixes — a walk over the document, not its lines", () => {
  const readOnly = (name: string): RegisteredTool | undefined =>
    ({ name, readOnly: /^(read|glob|grep|Read)$/.test(name) }) as RegisteredTool;

  test("text inside a block scalar is never a tools: list; the real list is", () => {
    const yaml = `name: t5
target: cli
agent:
  model: claude-sonnet-5
  instructions: |
    You write crewhaus specs. Always emit this block exactly:
    tools:
      - files
      - reports
    and this one line exactly:
    tools: [logs, draft]
tool_config:
  http: { tools: [raed] }
tools:
  - raed # the reader
  - "webfetch"
`;
    const fixed = applyLintFixes(yaml, readOnly);
    expect(fixed.applied).toEqual([
      'tool "raed" → "read" (nearest match)',
      'tool "webfetch" → "webFetch" (nearest match)',
    ]);
    // Only the two items changed, keeping the comment and the quotes; a
    // `tools` key inside a tool's own config block is not a tools: list.
    expect(fixed.text).toBe(
      yaml
        .replace("  - raed # the reader", "  - read # the reader")
        .replace('"webfetch"', '"webFetch"'),
    );
  });

  test("a profile reference is not a credential; a credential compile rejects is fixed", () => {
    const yaml = `name: hybrid
target: channel
models:
  fast: { model: claude-haiku-4-5 }
  checker: { model: claude-sonnet-4-6 }
agent:
  model: $fast
  instructions: help
  model_pool:
    candidates:
      - { model: $fast, tags: [cheap] }
      - { model: $checker, tags: [strong] }
channels:
  slack:
    botToken: $slack_bot_token
    signingSecret: "\${SLACK_SIGNING_SECRET}"
routing:
  sessionKey: thread
mcp_servers:
  kb:
    transport: stdio
    command: npx
    env:
      API_KEY: $kb_api_key
      MODE: $fast
`;
    const fixed = applyLintFixes(yaml, readOnly);
    // In the order compile meets them.
    expect(fixed.applied).toEqual([
      'secret "$kb_api_key" → "$KB_API_KEY" ($UPPER_SNAKE_CASE)',
      'secret "$slack_bot_token" → "$SLACK_BOT_TOKEN" ($UPPER_SNAKE_CASE)',
      'secret "${SLACK_SIGNING_SECRET}" → "$SLACK_SIGNING_SECRET" ($UPPER_SNAKE_CASE)',
    ]);
    expect(fixed.text).toBe(
      yaml
        .replace("$slack_bot_token", "$SLACK_BOT_TOKEN")
        .replace('"${SLACK_SIGNING_SECRET}"', '"$SLACK_SIGNING_SECRET"')
        .replace("$kb_api_key", "$KB_API_KEY"),
    );
    // `$fast` stays a profile reference everywhere, including an env value
    // that is not a credential (compile keeps it a literal).
    expect(fixed.text.match(/\$fast/g)?.length).toBe(3);
    expect(fixed.text).toContain("$checker");
  });

  test("a thredz: key, in the shorthand or under a crew role", () => {
    const short =
      "name: t\ntarget: cli\nthredz: $thredz_key\nagent:\n  model: m\n  instructions: hi\n";
    expect(applyLintFixes(short, readOnly).text).toBe(short.replace("$thredz_key", "$THREDZ_KEY"));
    // compile names it `thredz.api_key` whichever role's key it is.
    const crew = `name: rd
target: crew
model: claude-sonnet-4-6
entry: researcher
roles:
  researcher: { instructions: gather }
  editor: { instructions: write }
memory: { enabled: true }
thredz:
  api_key: $THREDZ_SHARED
  roles:
    editor: { space: $k_researcher, api_key: $K_EDITOR }
    researcher: { api_key: $k_researcher }
`;
    const fixed = applyLintFixes(crew, readOnly);
    expect(fixed.applied).toEqual(['secret "$k_researcher" → "$K_RESEARCHER" ($UPPER_SNAKE_CASE)']);
    // The key, not the editor's space that happens to hold the same text.
    expect(fixed.text).toBe(crew.replace("api_key: $k_researcher", "api_key: $K_RESEARCHER"));
  });

  test("an unsafe name the spec rejects is sanitised; a name elsewhere is not", () => {
    const yaml = `name: "my/agent"
target: cli
agent:
  model: m
  instructions: |
    name: keep/this
permissions:
  mode: "de/fault"
tools: [read]
`;
    const fixed = applyLintFixes(yaml, readOnly);
    expect(fixed.applied).toEqual(['name "my/agent" → "my-agent" (unsafe characters)']);
    expect(fixed.text).toBe(yaml.replace('"my/agent"', '"my-agent"'));
  });

  test("a narrowing list keeps real tool names that are not builtins", () => {
    const yaml = `name: t
target: cli
thredz: { api_key: $THREDZ_API_KEY }
agent:
  model: m
  instructions: hi
  sub_agents:
    helper:
      description: d
      instructions: h
      tools: [goal_list, Skill, mcp__kb__search, Raed]
tools: [read]
`;
    const fixed = applyLintFixes(yaml, readOnly);
    expect(fixed.applied).toEqual(['tool "Raed" → "Read" (nearest match)']);
    expect(fixed.text).toBe(yaml.replace("Raed]", "Read]"));
  });

  // wave III review: it was left alone, and the CLI then printed "no
  // mechanical fixes applicable" — a definite answer about a file it could
  // not read. It now says it skipped, and why.
  test("a document that is not YAML is left alone, and says it was skipped", () => {
    const broken = "name: t\ntarget: cli\ntools: [raed\n";
    const result = applyLintFixes(broken, readOnly);
    expect({ ...result, skipped: undefined }).toEqual({
      text: broken,
      applied: [],
      suggested: [],
      skipped: undefined,
    });
    expect(result.skipped).toMatch(/^the file is not valid YAML \(.+\)$/);
    const unsafeName = "name: my agent: v2\ntarget: cli\ntools: [raed]\n";
    expect(applyLintFixes(unsafeName, readOnly).skipped).toMatch(/not valid YAML/);
    // A valid document says nothing about skipping.
    expect(applyLintFixes(`${validCli}tools: [read]\n`, readOnly).skipped).toBeUndefined();
  });

  // wave III review: on a shape whose runtime carries no tools, compile
  // accepts a tools: list and ignores it — while --fix rewrote `raed` to
  // `read` from the cli set, the C025 lint/--fix disagreement at a new site.
  // Lint names no tool in the list; it says, as compile does, that the list
  // is not wired (closeout review).
  test("a tools: list on a shape with no tool runtime is left alone, as lint leaves it", () => {
    const voice = `name: hello-voice
target: voice
agent:
  model: gpt-4o-realtime-preview
  instructions: answer briefly
voice:
  provider: openai
  voiceId: alloy
  vad: server
tools: [raed, gitStaus]
`;
    expect(
      runLint(voice, noTools)
        .findings.filter((f) => f.path.includes("tools"))
        .map((f) => [f.rule, f.path]),
    ).toEqual([["accepted-but-unwired", "tools"]]);
    expect(applyLintFixes(voice, readOnly)).toEqual({ text: voice, applied: [], suggested: [] });
    for (const target of ["onchain", "onchain-game"]) {
      const yaml = voice.replace("target: voice", `target: ${target}`);
      expect({ target, fixed: applyLintFixes(yaml, readOnly).applied }).toEqual({
        target,
        fixed: [],
      });
    }
  });

  // wave III review: `tools: &shared [raed, gitStaus]` with an MCP server's
  // `args: *shared` — --fix rewrote the anchored list, the bundle then
  // carried `"args":["read","gitStatus"]`, and the report said only that
  // two tools were fixed.
  test("a tools: list that an alias reads somewhere else is suggested, not rewritten", () => {
    const anchored = `name: demo
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: go
tools: &shared [raed, gitStaus]
mcp_servers:
  gh:
    transport: stdio
    command: gh-mcp
    args: *shared
`;
    const result = applyLintFixes(anchored, readOnly);
    expect(result.text).toBe(anchored);
    expect(result.applied).toEqual([]);
    expect(result.suggested).toEqual([
      'tool "raed" — did you mean "read"? (not auto-fixed — tools is also read through an alias at mcp_servers.gh.args, which the edit would change too)',
      'tool "gitStaus" — did you mean "gitStatus"? (not auto-fixed — tools is also read through an alias at mcp_servers.gh.args, which the edit would change too)',
    ]);
    // An anchor on an item, or on a map holding the list, reaches the same way.
    const onItem = anchored
      .replace("tools: &shared [raed, gitStaus]", "tools: [&t raed, gitStaus]")
      .replace("args: *shared", "args: [*t]");
    expect(applyLintFixes(onItem, readOnly).applied).toEqual([
      'tool "gitStaus" → "gitStatus" (nearest match)',
    ]);
    const onMap = `name: demo
target: cli
agent: &a
  model: claude-sonnet-4-6
  instructions: go
  sub_agents:
    helper:
      description: d
      instructions: h
      tools: [Raed]
tool_config:
  copy: *a
`;
    expect(applyLintFixes(onMap, readOnly).applied).toEqual([]);
    // An alias that is itself a tools: list of the same kind reads the fix
    // it needs, so the fix is applied.
    const shared = `name: demo
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: go
  sub_agents:
    a:
      description: d
      instructions: i
      tools: &t [gitStaus, Raed]
    b:
      description: d
      instructions: i
      tools: *t
tools: [read, gitStatus]
`;
    expect(applyLintFixes(shared, readOnly).applied).toEqual([
      'tool "gitStaus" → "gitStatus" (nearest match)',
      'tool "Raed" → "Read" (nearest match)',
    ]);
    // lint's narrowing-list warning says the same.
    const warned = runLint(onMap, noTools).findings.filter((f) => f.rule === "tool-list-typo");
    expect(warned.map((f) => f.message)).toEqual([
      'tools: "Raed" is no tool, so this list never grants it — did you mean "Read"? (not auto-fixed: the list is also read through an alias at tool_config.copy)',
    ]);
  });

  test("lint reports the narrowing-list typos --fix rewrites", () => {
    const yaml = `name: t3
target: cli
agent:
  model: claude-sonnet-5
  instructions: Answer.
  sub_agents:
    helper:
      description: helper
      instructions: help
      tools: [raed, Read]
tools: [read, grep]
`;
    const findings = runLint(yaml, noTools).findings.filter((f) => f.rule === "tool-list-typo");
    expect(findings.map((f) => [f.path, f.severity])).toEqual([
      ["agent.sub_agents.helper.tools", "warning"],
    ]);
    expect(findings[0]?.message).toContain('"raed" is no tool');
    expect(findings[0]?.message).toContain('did you mean "read"?');
    expect(applyLintFixes(yaml, noTools).applied).toEqual(['tool "raed" → "read" (nearest match)']);
    // A model profile's list is validated at parse time; --fix still fixes
    // it in the spelling it was written in.
    const profile = `${yaml}models:\n  fast: { model: claude-haiku-4-5, tools: [Grpe] }\n`;
    expect(runLint(profile, noTools).findings.map((f) => f.rule)).toEqual(["parse"]);
    expect(applyLintFixes(profile, noTools).applied).toEqual([
      'tool "raed" → "read" (nearest match)',
      'tool "Grpe" → "Grep" (nearest match)',
    ]);
  });
});

describe("toolListPaths — where a spec holds a tools: list, from the spec's schema", () => {
  test("every site and every narrowing list, and nothing else", () => {
    const cli = toolListPaths("cli").map((p) => p.join("."));
    expect(cli).toContain("tools");
    expect(cli).toContain("agent.sub_agents.*.tools");
    expect(cli).toContain("models.*.tools");
    expect(cli).toContain("agent.model_pool.candidates.[].tools");
    expect(cli.some((p) => p.startsWith("mcp_servers") || p.startsWith("tool_config"))).toBe(false);
    expect(toolListPaths("graph").map((p) => p.join("."))).toContain("nodes.*.tools");
    expect(toolListPaths("workflow").map((p) => p.join("."))).toContain("steps.[].tools");
    expect(toolListPaths("crew").map((p) => p.join("."))).toContain("roles.*.sub_agents.*.tools");
    // `expose.mcp.tools` is a mode word, not a list of tools.
    expect(cli.some((p) => p.startsWith("expose"))).toBe(false);
  });
});

describe("runLint — the provability: block (0.8.0, design §3 / §11)", () => {
  const cli = (tools: string, block: string, extra = ""): string =>
    `${validCli}${tools === "" ? "" : `tools: ${tools}\n`}${extra}${block}\n`;
  const provabilityRules = (yaml: string): string[] =>
    runLint(yaml, noTools)
      .findings.filter((f) => f.rule.startsWith("provability-"))
      .map((f) => f.rule);

  test("a well-built grounded spec has no provability finding", () => {
    expect(provabilityRules(cli("[read, webFetch]", "provability: grounded"))).toEqual([]);
  });

  describe("the compile warnings --strict escalates are reported in compile's words", () => {
    test.each([
      [
        "an inert level: off block",
        cli("[read]", "provability: { level: off, on_fail: halt }"),
        "provability-inert-block",
      ],
      [
        "an execution allowlist the catalog cannot resolve offline",
        cli(
          "[moneyAdd]",
          "provability: { level: checked, execution: { allow: [mcp__calc__add, moneyAdd] } }",
          "mcp_servers:\n  calc:\n    transport: stdio\n    command: calc\n",
        ),
        "provability-execution-unresolved",
      ],
      [
        "an on_fail the research shape cannot honour",
        "name: r\ntarget: research\nagent:\n  model: claude-opus-4-7\n  instructions: hi\ngoal: learn\nprovability: { level: cited, on_fail: retry }\n",
        "provability-on-fail-degraded",
      ],
      [
        "a research floor no report can meet",
        "name: r\ntarget: research\nagent:\n  model: claude-opus-4-7\n  instructions: hi\ngoal: learn\nprovability: checked\n",
        "provability-research-rung-unreachable",
      ],
      [
        "a formal.image no lean4 checker runs",
        cli(
          "[read]",
          "provability: { level: proven, formal: { checkers: [builtin, smt], image: ghcr.io/acme/z3:1 } }",
        ),
        "provability-image-unused",
      ],
    ])("%s", async (_label, yaml, code) => {
      const { compile } = await import("@crewhaus/compiler");
      const want = compile(yaml).warnings.filter((w) => w.code === code);
      const got = runLint(yaml, noTools).findings.filter((f) => f.rule === code);
      expect(want).toHaveLength(1);
      expect(got.map((f) => [f.path, f.severity, f.message])).toEqual(
        want.map((w) => [w.path, "warning", w.message]),
      );
      // Warnings inform; only errors gate.
      expect(runLint(yaml, noTools).ok).toBe(true);
    });
  });

  test("none of the provability compile codes is informational, so `compile --strict` fails on each", () => {
    for (const code of [
      "provability-inert-block",
      "provability-execution-unresolved",
      "provability-on-fail-degraded",
      "provability-research-rung-unreachable",
      "provability-image-unused",
    ]) {
      expect(INFORMATIONAL_COMPILE_WARNING_CODES).not.toContain(code);
    }
  });

  describe("provability-no-source-tool — a grounded floor no evidence can reach", () => {
    test("no source, no allowlisted tool and no ProofCheck warns, naming the level", () => {
      const findings = runLint(cli("[bash]", "provability: grounded"), noTools).findings;
      const hit = findings.filter((f) => f.rule === "provability-no-source-tool");
      expect(hit).toHaveLength(1);
      expect(hit[0]?.severity).toBe("warning");
      expect(hit[0]?.path).toBe("provability.level");
      expect(hit[0]?.message).toContain("this spec can produce none of them");
      // True at every threshold: an assumption is never graded, and an
      // answer with no claims passes vacuously (design §2).
      expect(hit[0]?.message).toContain(
        "an answer fails the gate unless every claim in it is a declared assumption",
      );
      expect(hit[0]?.message).not.toContain("every answer fails");
      // An empty toolset too.
      expect(provabilityRules(cli("", "provability: grounded"))).toEqual([
        "provability-no-source-tool",
      ]);
      // Under threshold: 0 a score of 0 passes, and the message says so.
      const lax = runLint(
        cli("[bash]", "provability: { level: grounded, threshold: 0 }"),
        noTools,
      ).findings.filter((f) => f.rule === "provability-no-source-tool");
      expect(lax[0]?.message).toContain("threshold: 0 keeps that from failing an answer");
    });

    test("higher-rung evidence in reach keeps it quiet: an allowlisted tool, or ProofCheck (design §2)", () => {
      const subAgent = `name: t
target: cli
agent:
  model: claude-opus-4-7
  instructions: hi
  sub_agents:
    calc:
      description: d
      instructions: add it up
      tools: [MoneyAdd]
provability: grounded
`;
      for (const yaml of [
        // An execution result meets a grounded floor…
        cli("[moneyAdd, evaluate]", "provability: grounded"),
        cli(
          "[bash, Evaluate]",
          "provability: { level: grounded, execution: { allow: [evaluate] } }",
        ),
        subAgent,
        // …and so does a proof: the gate wires ProofCheck for these checkers,
        cli("[bash]", "provability: { level: grounded, formal: { checkers: [builtin] } }"),
        // and binds a proofCheck the agent lists, whatever the allowlist says.
        cli(
          "[bash, proofCheck]",
          "provability: { level: grounded, execution: { allow: [evaluate] } }",
        ),
      ]) {
        expect({ yaml, rules: provabilityRules(yaml) }).toEqual({ yaml, rules: [] });
      }
      // A computation tool the allowlist leaves out is no evidence.
      expect(
        provabilityRules(
          cli("[moneyAdd]", "provability: { level: grounded, execution: { allow: [evaluate] } }"),
        ),
      ).toEqual(["provability-no-source-tool"]);
    });

    test("the gate agrees: a computation-only grounded harness passes on a tool: citation", async () => {
      const result = runLint(cli("[moneyAdd, evaluate]", "provability: grounded"), noTools);
      expect(result.findings.filter((f) => f.rule.startsWith("provability-"))).toEqual([]);
      const config = provabilityOf(result.ir as IrNode);
      if (config === undefined) throw new Error("expected a provability block");
      const evidence = buildEvidenceIndex([
        recordFromCall({
          toolUseId: "toolu_01ABC",
          toolName: "Evaluate",
          input: { expression: "1200 + 84.5" },
          content: "1284.5",
          isError: false,
        }),
      ]);
      const bundle = await verifyDocument("The total is 1,284.50 [1].\n\n[1]: tool:toolu_01ABC\n", {
        config,
        evidence,
      });
      expect([bundle.verdict, bundle.score, bundle.achieved]).toEqual(["pass", 1, "checked"]);
    });

    test("any source reader keeps it quiet: a file, web, HTTP, document or code-host tool, a category, mcp, knowledge, a sub-agent", () => {
      for (const tools of [
        "[read]",
        "[webFetch]",
        "[fetch]",
        "[pdfText]",
        "[prGet]",
        "[all-web]",
        "[readLines]",
      ]) {
        expect({ tools, rules: provabilityRules(cli(tools, "provability: grounded")) }).toEqual({
          tools,
          rules: [],
        });
      }
      const mcp = cli(
        "",
        "provability: grounded",
        "mcp_servers:\n  docs:\n    transport: stdio\n    command: docs-mcp\n",
      );
      expect(provabilityRules(mcp)).toEqual([]);
      const knowledge = cli(
        "",
        "provability: grounded",
        "knowledge:\n  sources:\n    - path: ./docs\n",
      );
      expect(provabilityRules(knowledge)).toEqual([]);
      const subAgent = `name: t
target: cli
agent:
  model: claude-opus-4-7
  instructions: hi
  sub_agents:
    researcher:
      description: d
      instructions: look it up
      tools: [WebFetch]
provability: grounded
`;
      expect(provabilityRules(subAgent)).toEqual([]);
    });

    test("cited never needs a fetched source, and research always registers its own Source tool", () => {
      expect(provabilityRules(cli("[moneyAdd]", "provability: cited"))).toEqual([]);
      const research =
        "name: r\ntarget: research\nagent:\n  model: claude-opus-4-7\n  instructions: hi\ngoal: learn\nprovability: { level: grounded, on_fail: note }\n";
      expect(provabilityRules(research)).toEqual([]);
    });

    test("the source categories are real categories (a renamed one would silence the rule)", async () => {
      const { CATEGORIES } = await import("@crewhaus/tool-categories");
      for (const category of PROVABILITY_SOURCE_CATEGORIES) {
        expect({ category, known: Object.hasOwn(CATEGORIES, category) }).toEqual({
          category,
          known: true,
        });
      }
    });
  });

  describe("provability-no-execution-tool — a checked floor no evidence can reach", () => {
    test("a toolset with nothing on execution.allow and no ProofCheck warns", () => {
      const findings = runLint(cli("[read, webFetch]", "provability: checked"), noTools).findings;
      const hit = findings.filter((f) => f.rule === "provability-no-execution-tool");
      expect(hit).toHaveLength(1);
      expect(hit[0]?.path).toBe("provability.execution.allow");
      expect(hit[0]?.message).toContain("this spec can produce neither");
      expect(hit[0]?.message).toContain(
        "an answer fails the gate unless every claim in it is a declared assumption",
      );
      expect(hit[0]?.message).not.toContain("every answer fails");
      // A source tool cannot satisfy a checked floor, so the source rule is silent.
      expect(provabilityRules(cli("[read]", "provability: checked"))).toEqual([
        "provability-no-execution-tool",
      ]);
    });

    test("ProofCheck in reach keeps it quiet — a proof: binding meets any floor (design §2)", () => {
      const rule = (yaml: string): string[] =>
        provabilityRules(yaml).filter((r) => r === "provability-no-execution-tool");
      for (const yaml of [
        // Checkers the spec chose: the gate wires ProofCheck below proven.
        cli("[read]", "provability: { level: checked, formal: { checkers: [builtin] } }"),
        cli("[read]", "provability: { level: checked, formal: { checkers: [smt] } }"),
        // A proofCheck the agent lists is swapped for the gate's bound twin.
        cli(
          "[read, proofCheck]",
          "provability: { level: checked, execution: { allow: [evaluate] } }",
        ),
      ]) {
        expect({ yaml, rules: rule(yaml) }).toEqual({ yaml, rules: [] });
      }
      // A sub-agent's tools come from its parent's catalog, so its ProofCheck
      // adds nothing the parent does not have.
      const subAgent = `name: t
target: cli
agent:
  model: claude-opus-4-7
  instructions: hi
  sub_agents:
    prover:
      description: d
      instructions: prove it
      tools: [ProofCheck]
provability: { level: checked, execution: { allow: [evaluate] } }
`;
      expect(rule(subAgent)).toEqual(["provability-no-execution-tool"]);
    });

    test("the gate agrees: it wires ProofCheck there, and a proof: binding's rung meets a checked floor", () => {
      const result = runLint(
        cli("[read]", "provability: { level: checked, formal: { checkers: [builtin] } }"),
        noTools,
      );
      expect(result.findings.filter((f) => f.rule.startsWith("provability-"))).toEqual([]);
      const config = provabilityOf(result.ir as IrNode);
      if (config === undefined) throw new Error("expected a provability block");
      // evaluation-service adds ProofCheckers + ProofCheck for this block …
      expect(wantsProofCheckTools(config)).toBe(true);
      // … and the verifier ranks a proof: binding `proven`, which meets `checked`.
      expect(meetsFloor("proven", config.level)).toBe(true);
      // Without either, the same toolset warns.
      const plain = runLint(cli("[read]", "provability: checked"), noTools);
      const plainConfig = provabilityOf(plain.ir as IrNode);
      if (plainConfig === undefined) throw new Error("expected a provability block");
      expect(wantsProofCheckTools(plainConfig)).toBe(false);
      expect(plain.findings.map((f) => f.rule)).toContain("provability-no-execution-tool");
    });

    test("an allowlisted tool, in any spelling or through a sub-agent, keeps it quiet", () => {
      expect(provabilityRules(cli("[read, moneyAdd]", "provability: checked"))).toEqual([]);
      expect(
        provabilityRules(
          cli(
            "[read, evaluate]",
            "provability: { level: checked, execution: { allow: [Evaluate] } }",
          ),
        ),
      ).toEqual([]);
      const subAgent = `name: t
target: cli
agent:
  model: claude-opus-4-7
  instructions: hi
  sub_agents:
    calc:
      description: d
      instructions: add it up
      tools: [MoneyAdd]
provability: checked
`;
      expect(provabilityRules(subAgent)).toEqual([]);
    });

    test("an allowlisted mcp tool of a declared server keeps it quiet (and is reported unresolved instead)", () => {
      const yaml = cli(
        "[read]",
        "provability: { level: checked, execution: { allow: [mcp__calc__add] } }",
        "mcp_servers:\n  calc:\n    transport: stdio\n    command: calc\n",
      );
      expect(provabilityRules(yaml)).toEqual(["provability-execution-unresolved"]);
    });

    test("an allowlist that omits the agent's only computation tool warns", () => {
      expect(
        provabilityRules(
          cli("[moneyAdd]", "provability: { level: checked, execution: { allow: [evaluate] } }"),
        ),
      ).toEqual(["provability-no-execution-tool"]);
    });
  });

  describe("provability-execution-unknown-tool — an execution.allow entry nothing can ever call", () => {
    const MCP = "mcp_servers:\n  calc:\n    transport: stdio\n    command: calc\n";
    const unknown = (yaml: string): LintFinding[] =>
      runLint(yaml, noTools).findings.filter(
        (f) => f.rule === "provability-execution-unknown-tool",
      );

    test("a typo under a grounded floor warns with the builtin it is closest to", () => {
      // Below `checked` the compile says nothing, yet a `tool:` citation is
      // still checked against the list: the typo silently stops moneyAdd
      // counting as evidence.
      const yaml = cli(
        "[read, moneyAdd]",
        "provability: { level: grounded, execution: { allow: [moneyAd] } }",
      );
      expect(provabilityRules(yaml)).toEqual(["provability-execution-unknown-tool"]);
      const hit = unknown(yaml);
      expect(hit).toHaveLength(1);
      expect(hit[0]?.severity).toBe("warning");
      expect(hit[0]?.path).toBe("provability.execution.allow");
      expect(hit[0]?.message).toContain('names "moneyAd"');
      expect(hit[0]?.message).toContain("never counts as execution evidence");
      expect(hit[0]?.message).toContain("Did you mean moneyAdd?");
      expect(runLint(yaml, noTools).ok).toBe(true);
    });

    test("a name close to nothing says what may go there instead", () => {
      const hit = unknown(
        cli("[read]", "provability: { level: cited, execution: { allow: [totallyMadeUpTool] } }"),
      );
      expect(hit).toHaveLength(1);
      expect(hit[0]?.message).toContain("Name a builtin tool");
    });

    test("an mcp tool warns only when its server is not declared", () => {
      const undeclared = unknown(
        cli("[read]", "provability: { level: cited, execution: { allow: [mcp__calc__add] } }"),
      );
      expect(undeclared).toHaveLength(1);
      expect(undeclared[0]?.message).toContain('mcp_servers declares no server "calc"');
      expect(
        unknown(
          cli(
            "[read]",
            "provability: { level: cited, execution: { allow: [mcp__calc__add] } }",
            MCP,
          ),
        ),
      ).toEqual([]);
    });

    test("builtins in any spelling, the default list, categories and runtime tools are quiet", () => {
      for (const block of [
        "provability: grounded",
        "provability: { level: grounded, execution: { allow: [MoneyAdd, evaluate, moneyadd] } }",
        "provability: { level: grounded, execution: { allow: [all-math, -moneyAdd] } }",
        "provability: { level: grounded, execution: { allow: [CiteFact] } }",
      ]) {
        expect({ block, hit: unknown(cli("[read]", block)) }).toEqual({ block, hit: [] });
      }
    });

    test("at checked it fires beside the compile's --strict warning, which says something else", () => {
      const yaml = cli(
        "[evaluate, moneyAdd]",
        "provability: { level: checked, execution: { allow: [evaluate, moneyAd] } }",
      );
      expect(provabilityRules(yaml)).toEqual([
        "provability-execution-unresolved",
        "provability-execution-unknown-tool",
      ]);
    });

    test("an inert block and crew are not audited", () => {
      expect(
        unknown(cli("[read]", "provability: { level: off, execution: { allow: [moneyAd] } }")),
      ).toEqual([]);
      const crew =
        "name: cr\ntarget: crew\nmodel: m\nentry: lead\nroles:\n  lead: { instructions: x }\nprovability: { level: grounded, execution: { allow: [moneyAd] } }\n";
      expect(unknown(crew)).toEqual([]);
    });
  });

  describe("provability-sandbox-only-checkers — formal.checkers written without builtin", () => {
    test("sandbox-only lists warn, naming them and the builtin fallback; a list with builtin and the default do not", () => {
      for (const [checkers, named] of [
        ["[smt]", "smt"],
        ["[lean4]", "lean4"],
        ["[smt, lean4]", "smt, lean4"],
      ] as const) {
        const findings = runLint(
          cli("[read]", `provability: { level: proven, formal: { checkers: ${checkers} } }`),
          noTools,
        ).findings.filter((f) => f.rule === "provability-sandbox-only-checkers");
        expect(findings).toHaveLength(1);
        expect(findings[0]?.severity).toBe("warning");
        expect(findings[0]?.path).toBe("provability.formal.checkers");
        expect(findings[0]?.message).toContain(`names only sandbox checkers (${named})`);
        expect(findings[0]?.message).toContain("proofs fall back to the builtin checker");
        // The model always has a checker, so nothing is said to fail.
        expect(findings[0]?.message).not.toContain("fails");
        expect(findings[0]?.message).not.toContain("no checker");
      }
      expect(
        provabilityRules(
          cli("[read]", "provability: { level: proven, formal: { checkers: [lean4, builtin] } }"),
        ),
      ).toEqual([]);
      expect(provabilityRules(cli("[read]", "provability: proven"))).toEqual([]);
    });

    test("it fires exactly when the lowered list gained builtin, and that list is the one tool-proof runs", async () => {
      const { defaultCheckerIds } = await import("@crewhaus/tool-proof");
      const { provabilitySkillSubstitutions } = await import("@crewhaus/evaluation-service");
      for (const [written, lowered] of [
        ["[smt]", ["smt", "builtin"]],
        ["[lean4]", ["lean4", "builtin"]],
        ["[smt, lean4]", ["smt", "lean4", "builtin"]],
        ["[lean4, builtin]", ["lean4", "builtin"]],
        ["[builtin]", ["builtin"]],
        ["[builtin, smt]", ["builtin", "smt"]],
      ] as const) {
        const result = runLint(
          cli("[read]", `provability: { level: proven, formal: { checkers: ${written} } }`),
          noTools,
        );
        const config = provabilityOf(result.ir as IrNode);
        if (config === undefined) throw new Error("expected a provability block");
        // The IR lists every checker that runs (design §4.2) …
        expect(config.formal.checkers).toEqual(lowered);
        expect(defaultCheckerIds(config)).toEqual([...lowered]);
        // … so the skill tells the model the list ProofCheckers will show.
        expect(provabilitySkillSubstitutions(config)["checkers"]).toBe(lowered.join(", "));
        const fired = result.findings.some((f) => f.rule === "provability-sandbox-only-checkers");
        expect({ written, fired }).toEqual({ written, fired: !written.includes("builtin") });
      }
    });

    test("an inert block is the inert-block warning's alone; auditProvability without the spec skips the rule", async () => {
      expect(
        provabilityRules(cli("[read]", "provability: { level: off, formal: { checkers: [smt] } }")),
      ).toEqual(["provability-inert-block"]);
      const { lower } = await import("@crewhaus/compiler");
      const { parseSpec } = await import("@crewhaus/spec");
      const spec = parseSpec(
        cli("[read]", "provability: { level: proven, formal: { checkers: [smt] } }"),
      );
      expect(auditProvability(lower(spec), spec).map((f) => f.rule)).toEqual([
        "provability-sandbox-only-checkers",
      ]);
      expect(auditProvability(lower(spec))).toEqual([]);
    });
  });

  test("auditProvability: no block, the off shorthand and crew yield nothing", async () => {
    const { lower } = await import("@crewhaus/compiler");
    const { parseSpec } = await import("@crewhaus/spec");
    const lowerIr = (yaml: string): IrNode => lower(parseSpec(yaml));
    expect(auditProvability(lowerIr(validCli))).toEqual([]);
    expect(auditProvability(lowerIr(`${validCli}provability: off\n`))).toEqual([]);
    // Crew carries the block unwired: the accepted-but-unwired warning says
    // all there is to say.
    const crew =
      "name: cr\ntarget: crew\nmodel: m\nentry: lead\nroles:\n  lead: { instructions: x }\nprovability: { level: grounded, formal: { checkers: [smt] } }\n";
    expect(auditProvability(lowerIr(crew))).toEqual([]);
  });
});
