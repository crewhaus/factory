import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { casAppend, controlPaths, standingRulesLedger } from "@crewhaus/control-records";
import type { OperativeValue } from "@crewhaus/tool-permission-matcher";
import { z } from "zod";
import {
  BUILTIN_DEFAULT_RULES,
  PermissionConfigError,
  type RuleSet,
  type ToolCallContext,
  appendSettingsRule,
  emptyRuleSet,
  evaluate,
  loadSettingsRules,
  narrowPatternFor,
  removeSettingsRule,
  writeSettingsFile,
} from "./index";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pe-standing-")));
  dirs.push(dir);
  return dir;
}

const T0 = Date.parse("2026-11-12T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const OWNER = mintId("prn");

function settings(dir: string, root: unknown): void {
  mkdirSync(join(dir, ".crewhaus"), { recursive: true });
  writeFileSync(join(dir, ".crewhaus", "settings.json"), `${JSON.stringify(root, null, 2)}\n`);
}

async function plantRule(
  dir: string,
  pattern: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const id = mintId("rule");
  const answer = await casAppend(standingRulesLedger(dir), id, null, {
    kind: "allow",
    tool: pattern.slice(0, pattern.indexOf("(")),
    pattern,
    createdBy: OWNER,
    reason: "approval",
    createdAt: iso(T0),
    expiresAt: iso(T0 + 30 * DAY),
    state: "active",
    ...over,
  });
  if (!answer.ok || !answer.applied) throw new Error("rule not planted");
  return id;
}

async function revoke(dir: string, id: string, pattern: string): Promise<void> {
  const answer = await casAppend(standingRulesLedger(dir), id, "active", {
    kind: "allow",
    tool: pattern.slice(0, pattern.indexOf("(")),
    pattern,
    createdBy: OWNER,
    reason: "approval",
    createdAt: iso(T0),
    expiresAt: iso(T0 + 30 * DAY),
    state: "revoked",
    revokedAt: iso(T0 + 1),
    revokedBy: OWNER,
  });
  if (!answer.ok || !answer.applied) throw new Error("not revoked");
}

const writeNotes = (path: string): ToolCallContext => ({
  toolName: "Write",
  input: { file_path: path, content: "x" },
  operativeValues: [{ kind: "path", canonical: [path] }],
  readOnly: false,
  destructive: true,
});

const ruleSet = (settingsRules: RuleSet["settings"]): RuleSet => ({
  ...emptyRuleSet,
  settings: settingsRules,
  builtin: BUILTIN_DEFAULT_RULES,
});

describe("loadSettingsRules and a standing rule's record", () => {
  test("a rule the record does not name loads exactly as written", () => {
    const dir = harness();
    settings(dir, { permissions: { rules: [{ type: "alwaysAllow", pattern: "Bash" }] } });
    expect(loadSettingsRules(dir)).toEqual([
      { type: "alwaysAllow", pattern: "Bash", source: "settings" },
    ]);
    expect(Object.keys(loadSettingsRules(dir)[0] ?? {})).toEqual(["type", "pattern", "source"]);
  });

  test("a revoked rule stops matching within a second, in the same rule set", async () => {
    const dir = harness();
    const pattern = "Write(notes/a.md)";
    settings(dir, { permissions: { rules: [{ type: "alwaysAllow", pattern }] } });
    const id = await plantRule(dir, pattern);
    let now = T0 + DAY;
    const rules = ruleSet(loadSettingsRules(dir, { now: () => now }));
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("allow");
    expect(evaluate(writeNotes("notes/b.md"), "default", rules)).toBe("ask");
    await revoke(dir, id, pattern);
    // Within the reader's second, the last answer stands.
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("allow");
    now += 1001;
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("ask");
  });

  test("a rule past its end is not loaded, and one that reaches its end mid-run stops matching", async () => {
    const dir = harness();
    const pattern = "Write(notes/a.md)";
    settings(dir, { permissions: { rules: [{ type: "alwaysAllow", pattern }] } });
    await plantRule(dir, pattern, { expiresAt: iso(T0 + 2 * DAY) });
    expect(loadSettingsRules(dir, { now: () => T0 + 3 * DAY })).toEqual([]);
    let now = T0 + 2 * DAY - 500;
    const rules = ruleSet(loadSettingsRules(dir, { now: () => now }));
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("allow");
    now += 1001;
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("ask");
  });

  test("a second live row for the same pattern keeps it standing when one is revoked", async () => {
    const dir = harness();
    const pattern = "Write(notes/a.md)";
    settings(dir, { permissions: { rules: [{ type: "alwaysAllow", pattern }] } });
    const first = await plantRule(dir, pattern);
    await plantRule(dir, pattern);
    await revoke(dir, first, pattern);
    const rules = ruleSet(loadSettingsRules(dir, { now: () => T0 + DAY }));
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("allow");
  });

  test("a record that cannot be read revives nothing and hides nothing", async () => {
    const dir = harness();
    const pattern = "Write(notes/a.md)";
    settings(dir, { permissions: { rules: [{ type: "alwaysAllow", pattern }] } });
    const id = await plantRule(dir, pattern);
    let now = T0 + DAY;
    const rules = ruleSet(loadSettingsRules(dir, { now: () => now }));
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("allow");
    // The record becomes unreadable: the rule keeps the last answer it had.
    const file = join(dir, controlPaths(dir).standingRulesFile);
    const kept = readFileSync(file, "utf8");
    rmSync(file);
    mkdirSync(file);
    now += 1001;
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("allow");
    // Readable again and revoked: the rule stops.
    rmSync(file, { recursive: true });
    writeFileSync(file, kept);
    await revoke(dir, id, pattern);
    now += 1001;
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("ask");
    // A load with no good read loads every entry as written.
    rmSync(file);
    mkdirSync(file);
    expect(loadSettingsRules(dir, { now: () => now })).toEqual([
      { type: "alwaysAllow", pattern, source: "settings" },
    ]);
  });

  test("a deny or ask is never filtered by the record", async () => {
    const dir = harness();
    settings(dir, {
      permissions: { rules: [{ type: "alwaysDeny", pattern: "Write(notes/a.md)" }] },
    });
    const id = await plantRule(dir, "Write(notes/a.md)");
    await revoke(dir, id, "Write(notes/a.md)");
    expect(loadSettingsRules(dir, { now: () => T0 + DAY })).toEqual([
      { type: "alwaysDeny", pattern: "Write(notes/a.md)", source: "settings" },
    ]);
  });
});

describe("removeSettingsRule", () => {
  test("removes exactly (type, pattern) and keeps every other key and rule", () => {
    const dir = harness();
    settings(dir, {
      hooks: [{ event: "stop", command: "true" }],
      permissions: {
        mode: "default",
        rules: [
          { type: "alwaysAllow", pattern: "Write(a)" },
          { type: "alwaysDeny", pattern: "Write(a)" },
          { type: "alwaysAllow", pattern: "Read" },
        ],
      },
    });
    expect(removeSettingsRule(dir, { type: "alwaysAllow", pattern: "Write(a)" }).removed).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(join(dir, ".crewhaus", "settings.json"), "utf8"))).toEqual({
      hooks: [{ event: "stop", command: "true" }],
      permissions: {
        mode: "default",
        rules: [
          { type: "alwaysDeny", pattern: "Write(a)" },
          { type: "alwaysAllow", pattern: "Read" },
        ],
      },
    });
  });

  test("a rule or a file that is not there writes nothing", () => {
    const dir = harness();
    expect(removeSettingsRule(dir, { type: "alwaysAllow", pattern: "Read" }).removed).toBe(false);
    settings(dir, { permissions: { rules: [{ type: "alwaysAllow", pattern: "Read" }] } });
    const before = readFileSync(join(dir, ".crewhaus", "settings.json"), "utf8");
    expect(removeSettingsRule(dir, { type: "alwaysDeny", pattern: "Read" }).removed).toBe(false);
    expect(readFileSync(join(dir, ".crewhaus", "settings.json"), "utf8")).toBe(before);
  });

  test("a malformed file is refused, never rewritten", () => {
    const dir = harness();
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(join(dir, ".crewhaus", "settings.json"), "{ torn");
    expect(() => removeSettingsRule(dir, { type: "alwaysAllow", pattern: "Read" })).toThrow(
      PermissionConfigError,
    );
    expect(readFileSync(join(dir, ".crewhaus", "settings.json"), "utf8")).toBe("{ torn");
  });
});

/**
 * The strict schemas of 0.8.0's permission-engine, copied as they were, so a file this
 * release writes is held to what an earlier release reads.
 */
const V080_RULE = z
  .object({
    type: z.enum(["alwaysAllow", "alwaysDeny", "alwaysAsk"]),
    pattern: z.string().min(1),
  })
  .strict();
const V080_CONFIG = z
  .object({
    mode: z.enum(["default", "plan", "auto"]).optional(),
    rules: z.array(V080_RULE).optional(),
  })
  .strict();

describe("a settings file written here parses under 0.8.0's strict schema", () => {
  test("after an append, a remove and a whole write", () => {
    const dir = harness();
    const parses = (): boolean => {
      const root = JSON.parse(readFileSync(join(dir, ".crewhaus", "settings.json"), "utf8"));
      return V080_CONFIG.safeParse(root.permissions).success;
    };
    appendSettingsRule(dir, { type: "alwaysAllow", pattern: "Write(notes/a.md)" });
    expect(parses()).toBe(true);
    appendSettingsRule(dir, { type: "alwaysAllow", pattern: "Read" });
    removeSettingsRule(dir, { type: "alwaysAllow", pattern: "Write(notes/a.md)" });
    expect(parses()).toBe(true);
    writeSettingsFile(dir, { hooks: [], permissions: { rules: [] } });
    expect(parses()).toBe(true);
  });
});

describe("narrowPatternFor", () => {
  const path = (canonical: string, over: Partial<OperativeValue> = {}): OperativeValue => ({
    kind: "path",
    canonical: [canonical],
    ...over,
  });

  test("one value: the escaped pattern that grants exactly its call", () => {
    expect(narrowPatternFor("Write", { file_path: "notes/a*.md" }, [path("notes/a*.md")])).toEqual({
      pattern: "Write(notes/a\\*.md)",
      value: "notes/a*.md",
      valueKind: "path",
    });
  });

  test("a value only a deny or ask reads is left out", () => {
    expect(
      narrowPatternFor("Write", {}, [path("a"), path(".crewhaus/x", { restrictOnly: true })]),
    ).toEqual({ pattern: "Write(a)", value: "a", valueKind: "path" });
  });

  test("each refusal, with its reason", () => {
    expect(narrowPatternFor("Write", {}, [])).toEqual({ refused: "no-value" });
    expect(narrowPatternFor("Write", {}, [path("a"), path("b")])).toEqual({
      refused: "several-places",
    });
    expect(narrowPatternFor("Write", {}, [path("/x", { outsideWorkspace: true })])).toEqual({
      refused: "not-representable",
    });
    expect(narrowPatternFor("Write", {}, [path("a(b)")])).toEqual({
      refused: "not-representable",
    });
    expect(narrowPatternFor("Glob", {}, [path("src/*", { globPattern: true })])).toEqual({
      refused: "every-value",
    });
    expect(narrowPatternFor("Mystery", { x: "a" }, undefined)).toEqual({ refused: "undeclared" });
    expect(narrowPatternFor("Bash", {}, undefined)).toEqual({ refused: "no-value" });
  });

  test("a tool with no declaration reads the matcher's name table", () => {
    expect(narrowPatternFor("Bash", { command: "ls -la" }, undefined)).toEqual({
      pattern: "Bash(ls -la)",
      value: "ls -la",
    });
  });
});
