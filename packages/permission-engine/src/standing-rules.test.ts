import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import {
  casAppend,
  controlPaths,
  readStandingRules,
  standingRulesLedger,
} from "@crewhaus/control-records";
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
  holdsDisplayControl,
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

  test("a loaded rule keeps its last answer while its record cannot be read, and a load then takes no allow", async () => {
    const dir = harness();
    const pattern = "Write(notes/a.md)";
    settings(dir, {
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern },
          { type: "alwaysDeny", pattern: "Bash" },
        ],
      },
    });
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
    // A load while the record cannot be read takes no allow, and keeps every deny.
    rmSync(file);
    mkdirSync(file);
    expect(readStandingRules(dir).state).toBe("unreadable");
    expect(loadSettingsRules(dir, { now: () => now })).toEqual([
      { type: "alwaysDeny", pattern: "Bash", source: "settings" },
    ]);
  });

  /** Write the record's file whole, as a crash or a stray editor could leave it. */
  function plantRecordText(dir: string, text: string): void {
    const file = join(dir, controlPaths(dir).standingRulesFile);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  test("a record with a line that cannot be read loads no allow it does not name, and every deny", () => {
    const dir = harness();
    settings(dir, {
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Write(a.txt)" },
          { type: "alwaysDeny", pattern: "Bash" },
        ],
      },
    });
    // A sealed line that does not parse: a newline ends it, so the reader reads it.
    plantRecordText(dir, "{ torn\n");
    const read = readStandingRules(dir);
    expect(read.state).toBe("present");
    expect(read.state === "present" ? read.anomalies : []).toEqual(["1 line(s) cannot be read"]);
    expect(loadSettingsRules(dir, { now: () => T0 + DAY })).toEqual([
      { type: "alwaysDeny", pattern: "Bash", source: "settings" },
    ]);
  });

  test("beside a line that cannot be read, a rule a row names still follows its row", async () => {
    const dir = harness();
    const pattern = "Write(notes/a.md)";
    settings(dir, {
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern },
          { type: "alwaysAllow", pattern: "Write(notes/b.md)" },
        ],
      },
    });
    await plantRule(dir, pattern);
    const file = join(dir, controlPaths(dir).standingRulesFile);
    appendFileSync(file, "{ torn\n");
    const read = readStandingRules(dir);
    expect(read.state === "present" ? read.anomalies.length : -1).toBe(1);
    const loaded = loadSettingsRules(dir, { now: () => T0 + DAY });
    expect(loaded.map((rule) => rule.pattern)).toEqual([pattern]);
    expect(typeof loaded[0]?.live).toBe("function");
    const rules = ruleSet(loaded);
    expect(evaluate(writeNotes("notes/a.md"), "default", rules)).toBe("allow");
    expect(evaluate(writeNotes("notes/b.md"), "default", rules)).toBe("ask");
  });

  test("with no record, every allow and deny loads as written", () => {
    const dir = harness();
    settings(dir, {
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Write(a.txt)" },
          { type: "alwaysDeny", pattern: "Bash" },
        ],
      },
    });
    expect(readStandingRules(dir).state).toBe("absent");
    expect(loadSettingsRules(dir)).toEqual([
      { type: "alwaysAllow", pattern: "Write(a.txt)", source: "settings" },
      { type: "alwaysDeny", pattern: "Bash", source: "settings" },
    ]);
  });

  test("a record that cannot be read under a .crewhaus linked inside the harness takes no allow", () => {
    const dir = harness();
    mkdirSync(join(dir, "data", "crew"), { recursive: true });
    symlinkSync(join("data", "crew"), join(dir, ".crewhaus"));
    settings(dir, {
      permissions: {
        rules: [
          { type: "alwaysAllow", pattern: "Write(a.txt)" },
          { type: "alwaysDeny", pattern: "Bash" },
        ],
      },
    });
    mkdirSync(join(dir, controlPaths(dir).standingRulesFile), { recursive: true });
    expect(readStandingRules(dir).state).toBe("unreadable");
    expect(loadSettingsRules(dir)).toEqual([
      { type: "alwaysDeny", pattern: "Bash", source: "settings" },
    ]);
  });

  /**
   * Pin: a loaded rule keeps the last answer its record gave while a later read is not
   * present, so one that has stopped stays stopped when the record then cannot be read.
   */
  test("a rule that stopped matching stays stopped once its record cannot be read", async () => {
    const dir = harness();
    const pattern = "Write(notes/a.md)";
    settings(dir, { permissions: { rules: [{ type: "alwaysAllow", pattern }] } });
    const id = await plantRule(dir, pattern);
    let now = T0 + DAY;
    const loaded = loadSettingsRules(dir, { now: () => now });
    const live = loaded[0]?.live;
    if (live === undefined) throw new Error("the rule loaded with no live check");
    expect(live()).toBe(true);
    await revoke(dir, id, pattern);
    now += 1001;
    expect(live()).toBe(false);
    const file = join(dir, controlPaths(dir).standingRulesFile);
    rmSync(file);
    mkdirSync(file);
    now += 1001;
    expect(live()).toBe(false);
    expect(evaluate(writeNotes("notes/a.md"), "default", ruleSet(loaded))).toBe("ask");
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
    // A control or bidirectional-text character: a pattern reads as it matches.
    for (const value of ["a\u001b[2Jb", "a\u0085b", "a\u202eb", "a\u2066b", "a\u007fb"]) {
      expect({ value, narrow: narrowPatternFor("Write", { path: value }, undefined) }).toEqual({
        value,
        narrow: { refused: "not-representable" },
      });
      expect(narrowPatternFor("Write", {}, [path(value)])).toEqual({
        refused: "not-representable",
      });
    }
    expect(holdsDisplayControl("Write(notes/a.md)")).toBe(false);
    for (const char of ["\u0000", "\u001f", "\u007f", "\u009f", "\u061c", "\u200e"]) {
      expect(holdsDisplayControl(`a${char}b`)).toBe(true);
    }
    for (const char of ["\u200f", "\u202a", "\u202e", "\u2066", "\u2069"]) {
      expect(holdsDisplayControl(`a${char}b`)).toBe(true);
    }
    expect(holdsDisplayControl("a\u00a0b")).toBe(false);
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
