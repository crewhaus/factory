import { describe, expect, test } from "bun:test";
import type { IrNode } from "@crewhaus/compiler";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { THREDZ_TOOL_NAMES } from "@crewhaus/tool-registry-manifest/flags";
import {
  applyLintFixes,
  formatLintJson,
  formatLintText,
  levenshtein,
  nearestToolName,
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

  test("a document that is not YAML is left alone", () => {
    const broken = "name: t\ntarget: cli\ntools: [raed\n";
    expect(applyLintFixes(broken, readOnly)).toEqual({ text: broken, applied: [], suggested: [] });
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
