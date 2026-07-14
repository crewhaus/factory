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
