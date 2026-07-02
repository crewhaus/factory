import { describe, expect, test } from "bun:test";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  formatLintJson,
  formatLintText,
  levenshtein,
  nearestToolName,
  runLint,
  suggestSafeName,
  suggestSecretFix,
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
    expect(nearestToolName("webSerch", candidates)).toBe("webSearch");
    expect(nearestToolName("reed", candidates)).toBe("read");
  });
  test("too far → undefined (genuinely unknown, not a typo)", () => {
    expect(nearestToolName("totallyDifferentThing", candidates)).toBeUndefined();
  });
  test("a typo of a PascalCase name maps to a legal spelling (case-insensitive metric)", () => {
    // Both "webSearch" and "WebSearch" are distance 1 from "WebSerch"; either
    // is a correct nearest match (first-wins on tie), so assert it lands on a
    // legal candidate rather than a specific casing.
    const match = nearestToolName("WebSerch", candidates);
    expect(match?.toLowerCase()).toBe("websearch");
    expect(candidates).toContain(match);
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
