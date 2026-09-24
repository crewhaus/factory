/**
 * The tools the runtime registers without a spec listing them are known to
 * the permission-rule checker (0.7.1 review finding).
 *
 * `crewhaus lint`, `compile` and `PermissionAudit` report a rule whose name
 * matches no tool and is a near miss of one they know. They knew only the
 * builtins, so `alwaysAllow Skill` — the procode showcase — was reported with
 * the fix "Write Shell" (running code), and the browser starter's
 * `alwaysAllow Type` with "Write Tree", which made every Type call ask; both
 * failed `compile --strict`.
 *
 * The other tools are read from the source (`runtime-tool-names.ts`), baked
 * into `RUNTIME_TOOL_NAMES` by the manifest generator, and held here:
 *
 *   1. the scan reads every definition form the repository uses — it finds
 *      every builtin, which it is not told about;
 *   2. the checked-in list is exactly what the scan finds now;
 *   3. no tool name the source defines is reported as naming no tool;
 *   4. the runtime's own lists of tools it adds (the bookkeeping allow rules,
 *      the loop tools a profile keeps) are all known.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BUILTIN_BOOKKEEPING_RULES } from "@crewhaus/permission-engine";
import { RETAINED_LOOP_TOOL_NAMES } from "@crewhaus/runtime-core";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { permissionRuleProblems } from "@crewhaus/tool-permission-matcher";
import { RUNTIME_TOOL_NAMES, TOOL_FLAGS } from "@crewhaus/tool-registry-manifest/flags";
import { KNOWN_TOOLS, runLint } from "./lint";
import { runtimeToolNames, scanToolDefinitions } from "./runtime-tool-names";

const REPO = join(import.meta.dir, "..", "..", "..");
const builtinNames = new Set(Object.values(TOOL_FLAGS).map((t) => t.name));
const sites = scanToolDefinitions(REPO);
const scanned = new Set(sites.map((s) => s.name));

describe("the scan of tool definitions", () => {
  test("finds every builtin, so it reads every form a tool is defined in", () => {
    const missed = [...builtinNames].filter((name) => !scanned.has(name));
    expect(missed).toEqual([]);
    expect(builtinNames.size).toBeGreaterThanOrEqual(500);
  });

  test("finds the tools the runtime registers on its own", () => {
    // One per definition shape: buildTool with a literal (Type), with a
    // same-file constant (Consult), and a hand-built object (Skill, ListTools).
    for (const name of ["Skill", "ListTools", "Type", "Click", "Task", "Consult", "Remember"]) {
      expect(scanned.has(name)).toBe(true);
    }
    // And nothing that only looks like one: field names of a payment document.
    expect(scanned.has("Nm")).toBe(false);
  });
});

describe("RUNTIME_TOOL_NAMES", () => {
  test("is what the scan finds now (re-run scripts/gen-tool-registry.ts when it is not)", () => {
    expect([...RUNTIME_TOOL_NAMES]).toEqual([...runtimeToolNames(REPO, builtinNames)]);
    expect(RUNTIME_TOOL_NAMES.length).toBeGreaterThanOrEqual(30);
  });

  test("carries every tool the runtime's own lists say it adds", () => {
    const known = new Set([...builtinNames, ...RUNTIME_TOOL_NAMES]);
    const bookkeeping = BUILTIN_BOOKKEEPING_RULES.map((r) => r.pattern);
    expect(bookkeeping.length).toBeGreaterThan(0);
    expect(RETAINED_LOOP_TOOL_NAMES.length).toBeGreaterThan(0);
    const missing = [...bookkeeping, ...RETAINED_LOOP_TOOL_NAMES].filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });
});

describe("a rule naming a real tool is never reported as naming no tool", () => {
  test("for every tool name the source defines, with every builtin granted", () => {
    // Granting every builtin is the worst case: each is a near-miss candidate.
    const granted = Object.values(TOOL_FLAGS);
    const reported: string[] = [];
    for (const name of scanned) {
      const problems = permissionRuleProblems({
        rules: [{ type: "alwaysAllow", pattern: name }],
        granted,
        known: KNOWN_TOOLS,
        mcpServers: [],
      });
      if (problems.some((p) => p.code === "unknown-tool")) reported.push(name);
    }
    expect(scanned.size).toBeGreaterThanOrEqual(550);
    expect(reported).toEqual([]);
  });

  const noTools = (_name: string): RegisteredTool | undefined => undefined;
  const permissionFindings = (yaml: string) =>
    runLint(yaml, noTools).findings.filter((f) => f.rule.startsWith("permission-rule:"));

  test("the browser starter's rules lint clean", () => {
    // The seven tools every browser bundle registers, allowed the way
    // demos/starters/browser does.
    const rules = ["Navigate", "Screenshot", "FindElement", "Click", "Type", "Key", "Scroll"]
      .map((pattern) => `    - { type: alwaysAllow, pattern: ${pattern} }`)
      .join("\n");
    const yaml = `name: hello-browser
target: browser
agent:
  model: claude-sonnet-5
  instructions: drive the page
driver:
  backend: chromium
  startUrl: https://example.com/
groundingModel: claude-sonnet-5
permissions:
  mode: default
  rules:
${rules}
`;
    expect(runLint(yaml, noTools).findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(permissionFindings(yaml)).toEqual([]);
  });

  test("the procode showcase's Skill rule, and the other loop tools, lint clean", () => {
    const rules = ["Skill", "ListTools", "Task", "Remember", "Recall", "PlanUpdate", "GoalWrite"]
      .map((pattern) => `    - { type: alwaysAllow, pattern: ${pattern} }`)
      .join("\n");
    const yaml = `name: hello-procode
target: cli
agent:
  model: claude-sonnet-5
  instructions: code
tools: [read, glob, grep, bash]
permissions:
  mode: default
  rules:
${rules}
`;
    expect(permissionFindings(yaml)).toEqual([]);
  });
});
