/**
 * The runtime-state floor over the files that control a run: the harness's
 * run directory (`.crewhaus/run`, all of it), its settings file
 * (`.crewhaus/settings.json`, that file exactly) and Hangar's directory (every
 * Hangar root the run's environment names, and `~/.crewhaus/hangar` always).
 * These files decide what an agent may do next, so its own tools are not the
 * ones that write them. Held here with runtime-core's own roots
 * (`runtimeStateRoots`), from five sides:
 *
 * - the write matrix: every builtin that is not read-only, through each path
 *   field it writes, in the spellings a call gives, is denied by
 *   permission-engine before any rule is read, in every mode but `bypass`;
 * - nothing else moves: a neighbour of a protected file, a read-only call,
 *   and CrewHaus's own settings writer are what they were;
 * - the tools that check their own writes refuse these roots in `bypass` too;
 * - end to end, the real Write, Edit and HooksManage through runChatLoop;
 * - the settings file a run loads is its working directory's, the one the
 *   floor protects.
 *
 * No test here writes under the real home directory: the default Hangar
 * root is only ever named in decisions, and a Write there lies outside the
 * workspace, which the tool refuses on its own.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ProviderAdapter } from "../packages/adapter-anthropic/src/index";
import {
  MANAGER_SETTINGS_SEGMENTS,
  readManagerSettings,
} from "../packages/harness-supervisor/src/manager-settings";
import { RUN_DIR_SEGMENTS } from "../packages/harness-supervisor/src/types";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionMode,
  type PermissionRule,
  type RuleSet,
  SETTINGS_RELATIVE_PATH,
  type ToolCallContext,
  appendSettingsRule,
  emptyRuleSet,
  evaluateWithReason,
  loadSettingsRules,
} from "../packages/permission-engine/src/index";
import { createRunContext } from "../packages/run-context/src/index";
import { runChatLoop } from "../packages/runtime-core/src/index";
import { placeRecordingCanonicalizer } from "../packages/runtime-core/src/path-canonical";
import {
  relocatingFieldLeftOut,
  runtimeRecordRoots,
  runtimeStateRoots,
} from "../packages/runtime-core/src/state-roots";
import { buildTenant } from "../packages/tenancy/src/index";
import type { RegisteredTool } from "../packages/tool-catalog/src/index";
import { datasetPut } from "../packages/tool-dataset/src/index";
import { operativeValuesOf } from "../packages/tool-executor/src/index";
import { hooksManage } from "../packages/tool-fleet/src/index";
import { edit, write } from "../packages/tool-fs/src/index";
import { buildTar } from "../packages/tool-fsx/src/archive-fixtures";
import {
  archiveExtract,
  copyPath,
  movePath,
  removePath,
  tempDir as tempDirTool,
} from "../packages/tool-fsx/src/index";
import { gitApplyPatch } from "../packages/tool-git/src/index";
import { storeMigrate } from "../packages/tool-lifecycle/src/index";
import { emitTraceEvent, incidentBundle } from "../packages/tool-obs/src/index";
import { TOOL_REGISTRY } from "../packages/tool-registry-manifest/src/generated";
import {
  blackboardPost,
  checkpointSave,
  counterIncrement,
  dedupeMark,
  indexBuild,
  journalAppend,
  kvSet,
  noteWrite,
  stateImport,
} from "../packages/tool-state/src/index";
import type { TraceEvent } from "../packages/trace-event-bus/src/index";

const ROOT = dirname(import.meta.dir);
/** What the floor's reason adds, in both of its forms. */
const FLOOR =
  "or the files that control it (the harness's run files and settings, Hangar's directory) — no rule can allow that";
/** What a tool that checks its own writes says when it refuses one. */
const REFUSED =
  "where the runtime keeps its own record of the run (session logs, spilled tool results, proof bundles) or the files that control it (the harness's run files and settings, Hangar's directory), which no tool may change. Nothing was written.";
const DEFAULT_HOME = join(homedir(), ".crewhaus", "hangar");

const TEMP: string[] = [];
afterAll(() => {
  for (const dir of TEMP) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TEMP.push(dir);
  return dir;
}

/** Whether the temp volume folds case, asked of it rather than assumed. */
function tempFsIgnoresCase(): boolean {
  const dir = tempDir("crewhaus-floor-case-");
  writeFileSync(join(dir, "probe"), "x");
  return existsSync(join(dir, "PROBE"));
}
const IGNORES_CASE = tempFsIgnoresCase();

/** Every file under `dir`, by path relative to it, with its bytes. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const child = join(at, name);
      if (statSync(child).isDirectory()) walk(child);
      else out[relative(dir, child)] = readFileSync(child, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** `rule` for `tool` in the flag source, the highest. */
const allowIn = (...tools: string[]): RuleSet => ({
  ...emptyRuleSet,
  flag: tools.map(
    (tool): PermissionRule => ({ type: "alwaysAllow", pattern: tool, source: "flag" }),
  ),
});

describe("the floor's files are the ones CrewHaus reads and writes", () => {
  test("the settings file the loader reads, the supervisor's settings file and its run directory", () => {
    const ws = tempDir("crewhaus-floor-names-");
    const relativeRoots = runtimeStateRoots(undefined, undefined, ws, {}).filter(
      (root) => !isAbsolute(root),
    );
    for (const [owner, rel] of [
      ["permission-engine's settings loader", SETTINGS_RELATIVE_PATH],
      ["the supervisor's manager settings", MANAGER_SETTINGS_SEGMENTS.join(sep)],
      ["the supervisor's run directory", RUN_DIR_SEGMENTS.join(sep)],
    ] as const) {
      expect({ owner, rel, protected: relativeRoots.includes(rel) }).toEqual({
        owner,
        rel,
        protected: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The write matrix
// ---------------------------------------------------------------------------

type Arg = NonNullable<(typeof TOOL_REGISTRY)[string]["operativeArgs"]>[number];
type Values = NonNullable<ToolCallContext["operativeValues"]>;

/**
 * Every builtin that is not read-only, with each path field it writes: the
 * fields the runtime's floor reads (`floorValuesOf` leaves out one declared
 * `source` or `reads`, and a `relocates` store the tool reads whole; a
 * `readsWhen` field counts, since no call here sets its switch).
 */
const PAIRS = Object.values(TOOL_REGISTRY)
  .filter((entry) => !entry.readOnly)
  .flatMap((entry) =>
    (entry.operativeArgs ?? [])
      .filter(
        (arg) =>
          arg.kind === "path" &&
          !(arg.relocates === true && arg.beneath !== undefined) &&
          arg.source !== true &&
          arg.reads !== true,
      )
      .map((arg) => ({ entry, arg })),
  );

/**
 * Pairs that cannot carry a path the floor reads, each with its reason. A
 * pair that yields no floor-readable value for a target fails unless it is
 * here. Empty: every path field a writer declares reaches the floor.
 */
const NO_FLOOR_VALUE: Readonly<Record<string, string>> = {};

describe("the write matrix: every writer's path fields, in the spellings a call gives", () => {
  // The workspace, its control files, a Hangar directory inside it (named by
  // CREWHAUS_HANGAR_ROOT) and one beside it (CREWHAUS_REGISTRY_ROOT's), and
  // the links a spelling can go through.
  const base = tempDir("crewhaus-floor-matrix-");
  const ws = join(base, "ws");
  for (const dir of [
    join(ws, ".crewhaus", "run"),
    join(ws, "home", "access"),
    join(ws, "sub"),
    join(base, "registry", "hangar", "access"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(ws, ".crewhaus", "settings.json"), "{}\n");
  symlinkSync(join(".crewhaus", "run"), join(ws, "to-run"));
  symlinkSync(join(".crewhaus", "settings.json"), join(ws, "to-settings"));
  symlinkSync("home", join(ws, "to-home"));
  symlinkSync(".", join(ws, "alias"));
  const env = {
    CREWHAUS_HANGAR_ROOT: join(ws, "home"),
    CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
  };
  const ROOTS = runtimeStateRoots(undefined, undefined, ws, env);
  const RECORD_ROOTS = runtimeRecordRoots(undefined, undefined, ws);
  const beside = join(base, "registry", "hangar");
  const { canonicalizePath } = placeRecordingCanonicalizer(ws);

  /** Each root inside the workspace, and the link to it. */
  const LINKS: ReadonlyArray<readonly [string, string]> = [
    [".crewhaus/run", "to-run"],
    [".crewhaus/settings.json", "to-settings"],
    ["home", "to-home"],
  ];
  const INSIDE = [
    ".crewhaus/run/x",
    ".crewhaus/run",
    ".crewhaus/settings.json",
    "home/token",
    "home/access/members.json",
  ];
  const OUTSIDE = [
    join(beside, "token"),
    join(beside, "access", "members.json"),
    join(DEFAULT_HOME, "token"),
  ];
  /** The spellings of a target, labelled. */
  const spellings = (target: string): Array<readonly [string, string]> => {
    if (isAbsolute(target)) {
      // Outside the workspace a path is read as written, so it is spelled
      // absolute, and absolute through a `..` the floor folds away.
      const dir = dirname(target);
      const through = [dir, "..", basename(dir), basename(target)].join(sep);
      return [
        ["absolute", target],
        ["absolute through ..", through],
      ];
    }
    const link = LINKS.find(([root]) => target === root || target.startsWith(`${root}/`));
    if (link === undefined) throw new Error(`no link to the root of ${target}`);
    return [
      ["as named", target],
      ["absolute", join(ws, target)],
      ["./", `./${target}`],
      ["from a subdirectory", `sub/../${target}`],
      ["through a link to its root", `${link[1]}${target.slice(link[0].length)}`],
      ["through a link to the workspace", `alias/${target}`],
      ["with backslashes", target.split("/").join("\\")],
      // Skipped where the volume keeps case: there another case is another file.
      ...(IGNORES_CASE ? [["in another case", target.toUpperCase()] as const] : []),
    ];
  };

  const isFloorReadable = (values: Values | undefined): boolean =>
    (values ?? []).some((v) => v.kind === "path" && v.globPattern !== true);
  const valuesOf = (args: ReadonlyArray<Arg>, input: Record<string, unknown>) =>
    operativeValuesOf(args as never, input, { canonicalizePath });
  /** The call a pair makes naming `spelling`, read the way the runtime reads it. */
  const callFor = (
    entry: (typeof PAIRS)[number]["entry"],
    arg: Arg,
    spelling: string,
  ): ToolCallContext | undefined => {
    const inputWith = (value: unknown): Record<string, unknown> => ({
      // A field read within another one is named from the workspace root.
      ...(arg.within !== undefined ? { [arg.within]: "." } : {}),
      [arg.field]: value,
    });
    // As a string first, then as a list, for a field that takes several.
    let input = inputWith(spelling);
    if (!isFloorReadable(valuesOf([arg], input))) input = inputWith([spelling]);
    if (!isFloorReadable(valuesOf([arg], input))) return undefined;
    const declared = entry.operativeArgs ?? [];
    const named = (field: string): boolean => input[field] !== undefined && input[field] !== "";
    const skipped = (a: Arg): boolean =>
      (a.relocates === true && relocatingFieldLeftOut(a, input, RECORD_ROOTS, ROOTS, ws)) ||
      a.source === true ||
      a.reads === true ||
      (a.readsWhen !== undefined && named(a.readsWhen));
    const written = declared.filter((a) => !skipped(a));
    const floorValues = declared.some(skipped) ? (valuesOf(written, input) ?? []) : undefined;
    const operativeValues = valuesOf(declared, input);
    return {
      toolName: entry.name,
      input,
      ...(operativeValues !== undefined ? { operativeValues } : {}),
      ...(floorValues !== undefined ? { floorValues } : {}),
      readOnly: false,
      destructive: entry.destructive,
      requiresSandbox: entry.requiresSandbox,
    };
  };

  test("the pairs walked are every path field of every writer", () => {
    // 111 pairs over 95 tools when this was written, of the builtins that are
    // not read-only. A floor on the count, so a new writer needs no edit here.
    expect(PAIRS.length).toBeGreaterThanOrEqual(111);
    expect(new Set(PAIRS.map((p) => p.entry.name)).size).toBeGreaterThanOrEqual(95);
    // The fields that keep a tool's store are among them.
    const keys = new Set(PAIRS.map((p) => `${p.entry.name}.${p.arg.field}`));
    for (const key of [
      "KvSet.stateDir",
      "DatasetPut.registryDir",
      "EmitTraceEvent.dir",
      "EvalBaselinePin.evalsDir",
      "ExperimentLedger.experimentsDir",
      "SpecPin.registryDir",
      "GitSwitch.cwd",
    ]) {
      expect({ key, walked: keys.has(key) }).toEqual({ key, walked: true });
    }
    // A store the tool reads whole is not where it writes.
    expect(keys.has("IncidentBundle.dir")).toBe(false);
    // The exception list names real pairs only.
    expect(Object.keys(NO_FLOOR_VALUE).filter((key) => !keys.has(key))).toEqual([]);
  });

  for (const target of [...INSIDE, ...OUTSIDE]) {
    const label = isAbsolute(target) ? relative(base, target).split(sep).join("/") : target;
    test(`${label}: denied before any rule, in every mode but bypass`, () => {
      const unread: string[] = [];
      const wrong: string[] = [];
      let checked = 0;
      for (const { entry, arg } of PAIRS) {
        const pair = `${entry.name}.${arg.field}`;
        for (const [how, spelling] of spellings(target)) {
          const call = callFor(entry, arg, spelling);
          if (call === undefined) {
            if (NO_FLOOR_VALUE[pair] === undefined) unread.push(`${pair} (${how}: ${spelling})`);
            continue;
          }
          checked++;
          for (const mode of ["default", "auto", "plan"] as const) {
            for (const [rules, ruled] of [
              [emptyRuleSet, "no rules"],
              [allowIn(entry.name), "alwaysAllow"],
            ] as const) {
              const r = evaluateWithReason(call, mode, rules, { protectedRoots: ROOTS });
              if (r.decision !== "deny" || r.reason?.includes(FLOOR) !== true) {
                wrong.push(`${pair} ${how} ${mode} ${ruled}: ${r.decision} ${r.reason ?? ""}`);
              }
            }
          }
          if (
            evaluateWithReason(call, "bypass", emptyRuleSet, { protectedRoots: ROOTS }).decision !==
            "allow"
          ) {
            wrong.push(`${pair} ${how} bypass: not allowed`);
          }
        }
      }
      expect(unread).toEqual([]);
      expect(wrong).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(PAIRS.length * 2);
    }, 20_000); // slow by construction: each writer's field in each spelling, canonicalised on disk
  }

  test("nothing else: a neighbour of a protected file and a read-only call are the rules' to decide", () => {
    const writeEntry = TOOL_REGISTRY["write"];
    if (writeEntry === undefined) throw new Error("no Write in the builtin table");
    const writeArg = (writeEntry.operativeArgs ?? [])[0];
    if (writeArg === undefined) throw new Error("Write declares no path");
    for (const name of [
      ".crewhaus/notes.md",
      ".crewhaus/settings.json.bak",
      ".crewhaus/runbook/x",
      "home-notes/token",
    ]) {
      const call = callFor(writeEntry, writeArg, name);
      if (call === undefined) throw new Error(`no value for ${name}`);
      const unruled = evaluateWithReason(call, "default", emptyRuleSet, { protectedRoots: ROOTS });
      expect({
        name,
        decision: unruled.decision,
        floor: unruled.reason?.includes(FLOOR) === true,
      }).toEqual({
        name,
        decision: "ask",
        floor: false,
      });
      expect({
        name,
        decision: evaluateWithReason(call, "default", allowIn("Write"), { protectedRoots: ROOTS })
          .decision,
      }).toEqual({ name, decision: "allow" });
    }
    // The floor reads calls that write. These are read-only, so the builtin
    // rules decide them, as they do anywhere else.
    const reads: Array<readonly [string, Record<string, unknown>]> = [
      ["Read", { path: ".crewhaus/settings.json" }],
      ["Read", { path: ".crewhaus/run/daemon.json" }],
      ["Read", { path: "home/settings.json" }],
      ["Grep", { pattern: "x", path: ".crewhaus" }],
      ["Glob", { pattern: ".crewhaus/run/**" }],
      ["PermissionsSuggest", {}],
    ];
    for (const [toolName, input] of reads) {
      const entry = Object.values(TOOL_REGISTRY).find((e) => e.name === toolName);
      if (entry === undefined) throw new Error(`no ${toolName} in the builtin table`);
      expect({ toolName, readOnly: entry.readOnly }).toEqual({ toolName, readOnly: true });
      const operativeValues = valuesOf(entry.operativeArgs ?? [], input);
      const call: ToolCallContext = {
        toolName,
        input,
        ...(operativeValues !== undefined ? { operativeValues } : {}),
        readOnly: true,
        destructive: entry.destructive,
      };
      const builtin = { ...emptyRuleSet, builtin: BUILTIN_DEFAULT_RULES };
      const mode: PermissionMode = toolName === "PermissionsSuggest" ? "auto" : "default";
      expect({
        toolName,
        input,
        decision: evaluateWithReason(call, mode, builtin, { protectedRoots: ROOTS }).decision,
      }).toEqual({ toolName, input, decision: "allow" });
    }
  });

  test("CrewHaus's own settings writer still writes the file the floor keeps tools out of", () => {
    const harness = tempDir("crewhaus-floor-append-");
    const { path } = appendSettingsRule(harness, { type: "alwaysAllow", pattern: "Read(docs/**)" });
    expect(relative(harness, path)).toBe(SETTINGS_RELATIVE_PATH);
    expect(loadSettingsRules(harness).map((r) => r.pattern)).toEqual(["Read(docs/**)"]);
    expect(runtimeStateRoots(undefined, undefined, harness, {})).toContain(path);
  });
});

// ---------------------------------------------------------------------------
// The tools that check their own writes, in bypass
// ---------------------------------------------------------------------------

/** A control token's shape, built from parts so no real-looking value is ever written whole. */
const TOKEN = ["ctl", "fixture", "0".repeat(16)].join("_");
const SETTINGS = `${JSON.stringify(
  { permissions: { rules: [{ type: "alwaysAllow", pattern: "Read" }] } },
  null,
  2,
)}\n`;

let originalCwd: string;
let base: string;
let ws: string;
let env: Record<string, string>;

/** Seed a harness: its run files, its settings and a Hangar directory inside it. */
function seedHarness(dir: string): void {
  mkdirSync(join(dir, ".crewhaus", "run", "logs"), { recursive: true });
  writeFileSync(join(dir, ".crewhaus", "run", "daemon.json"), '{"pid":1}\n');
  writeFileSync(join(dir, ".crewhaus", "run", "control-token"), TOKEN);
  writeFileSync(join(dir, ".crewhaus", "settings.json"), SETTINGS);
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "home", "token"), "home-token\n");
}

/** The bytes of everything the floor protects in `ws`, to compare after a refusal. */
const protectedBytes = (): Record<string, string> => {
  const settings = join(ws, ".crewhaus", "settings.json");
  return {
    ...filesUnder(join(ws, ".crewhaus", "run")),
    settings: existsSync(settings) ? readFileSync(settings, "utf8") : "(gone)",
    ...Object.fromEntries(
      Object.entries(filesUnder(join(ws, "home"))).map(([rel, body]) => [`home:${rel}`, body]),
    ),
  };
};

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), body);
}

async function text(
  tool: RegisteredTool,
  input: unknown,
  roots: readonly string[],
): Promise<string> {
  const out = await tool.execute(input as never, { bridge: { protectedRoots: roots } } as never);
  return typeof out === "string" ? out : JSON.stringify(out);
}

describe("the tools that check their own writes refuse these roots in every mode, bypass included", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    base = tempDir("crewhaus-floor-tools-");
    ws = join(base, "ws");
    seedHarness(ws);
    put("staged/new.txt", "staged\n");
    put("other.json", '{"permissions":{"rules":[{"type":"alwaysAllow","pattern":"Bash"}]}}\n');
    env = {
      CREWHAUS_HANGAR_ROOT: join(ws, "home"),
      CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
    };
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
  });
  const roots = (): string[] => runtimeStateRoots(undefined, undefined, ws, env);

  test("CopyPath and MovePath into the run directory", async () => {
    const before = protectedBytes();
    expect(
      await text(copyPath, { source: "staged", destination: ".crewhaus/run/staged" }, roots()),
    ).toContain(REFUSED);
    expect(
      await text(
        copyPath,
        { source: "staged/new.txt", destination: ".crewhaus/run/new.txt" },
        roots(),
      ),
    ).toContain(REFUSED);
    expect(
      await text(movePath, { source: "staged", destination: ".crewhaus/run/moved" }, roots()),
    ).toContain(REFUSED);
    expect(protectedBytes()).toEqual(before);
    for (const gone of ["staged", "new.txt", "moved"]) {
      expect(existsSync(join(ws, ".crewhaus", "run", gone))).toBe(false);
    }
    expect(existsSync(join(ws, "staged", "new.txt"))).toBe(true);
  });

  test("MovePath onto the settings file, and of it", async () => {
    const before = protectedBytes();
    expect(
      await text(
        movePath,
        { source: "other.json", destination: ".crewhaus/settings.json", overwrite: true },
        roots(),
      ),
    ).toContain(REFUSED);
    expect(
      await text(
        movePath,
        { source: ".crewhaus/settings.json", destination: "settings-moved.json" },
        roots(),
      ),
    ).toContain(REFUSED);
    expect(protectedBytes()).toEqual(before);
    expect(existsSync(join(ws, "other.json"))).toBe(true);
    expect(existsSync(join(ws, "settings-moved.json"))).toBe(false);
  });

  test("RemovePath of the run directory", async () => {
    const before = protectedBytes();
    expect(await text(removePath, { path: ".crewhaus/run", recursive: true }, roots())).toContain(
      REFUSED,
    );
    expect(protectedBytes()).toEqual(before);
  });

  test("ArchiveExtract into `.crewhaus` of an archive whose top level holds run/", async () => {
    writeFileSync(join(ws, "other.tar"), buildTar([{ name: "run/x", data: "changed\n" }]));
    const before = protectedBytes();
    const out = await text(
      archiveExtract,
      { archive: "other.tar", destination: ".crewhaus", overwrite: true },
      roots(),
    );
    expect(out).toContain(REFUSED);
    expect(protectedBytes()).toEqual(before);
    expect(existsSync(join(ws, ".crewhaus", "run", "x"))).toBe(false);
  });

  test("GitApplyPatch on the harness's own repository, touching the settings file", async () => {
    const saved = {
      global: process.env["GIT_CONFIG_GLOBAL"],
      system: process.env["GIT_CONFIG_SYSTEM"],
    };
    process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
    process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
    try {
      const identity = {
        ...process.env,
        GIT_AUTHOR_NAME: "A U Thor",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "A U Thor",
        GIT_COMMITTER_EMAIL: "author@example.com",
      };
      const git = (...args: string[]): string => {
        const ran = Bun.spawnSync(["git", ...args], {
          cwd: ws,
          env: identity,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
        return ran.stdout.toString();
      };
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-q", "-m", "harness");
      // The diff an agent would hand it: an allow rule for Bash added.
      writeFileSync(join(ws, ".crewhaus", "settings.json"), SETTINGS.replace('"Read"', '"Bash"'));
      const diff = git("diff");
      git("checkout", "--", ".crewhaus/settings.json");
      expect(diff).toContain(".crewhaus/settings.json");
      const before = protectedBytes();
      const out = JSON.parse(await text(gitApplyPatch, { cwd: ".", patch: diff }, roots())) as {
        applied: boolean;
        reason: string;
      };
      expect(out.applied).toBe(false);
      expect(out.reason).toContain(REFUSED);
      expect(protectedBytes()).toEqual(before);
    } finally {
      for (const [name, value] of [
        ["GIT_CONFIG_GLOBAL", saved.global],
        ["GIT_CONFIG_SYSTEM", saved.system],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });

  test("StateImport into `.crewhaus`, entry by entry: the control token and the settings file", async () => {
    const before = protectedBytes();
    for (const [path, content] of [
      ["run/control-token", "changed"],
      ["settings.json", '{"permissions":{"rules":[{"type":"alwaysAllow","pattern":"Bash"}]}}'],
    ] as const) {
      const document = { version: 1, files: [{ path, encoding: "utf8", content }] };
      expect({
        path,
        out: (await text(stateImport, { document, stateDir: ".crewhaus" }, roots())).includes(
          REFUSED,
        ),
      }).toEqual({
        path,
        out: true,
      });
    }
    expect(protectedBytes()).toEqual(before);
  });

  test("StoreMigrate whose writes land in the run directory", async () => {
    put(".crewhaus/sessions/sess_0000000000000001.json", '{"id":"one"}');
    put(".crewhaus/sessions/sess_0000000000000001.jsonl", '{"event":"start"}\n');
    put(".crewhaus/audit/2026-01-01.jsonl", '{"seq":0,"hash":"a"}\n');
    put(".crewhaus/audit/_chain-tail.json", '{"seq":0,"hash":"a"}\n');
    const before = protectedBytes();
    for (const dryRun of [true, false]) {
      const out = await text(storeMigrate, { to: ".crewhaus/run/migrated", dryRun }, roots());
      expect({ dryRun, refused: out.includes(REFUSED) }).toEqual({ dryRun, refused: true });
    }
    expect(protectedBytes()).toEqual(before);
    expect(existsSync(join(ws, ".crewhaus", "run", "migrated"))).toBe(false);
  });

  test("with a tenant's record outside the workspace, `.crewhaus` still holds the control files", async () => {
    const tenant = buildTenant("acme", { tenantsRoot: join(base, "tenants") });
    const scoped = runtimeStateRoots(tenant.sessionRoot, tenant, ws, env);
    // Only the control files and the Hangar directory lie in the workspace.
    expect(scoped.filter((r) => !isAbsolute(r)).sort()).toEqual(
      [join(".crewhaus", "run"), join(".crewhaus", "settings.json"), "home"].sort(),
    );
    const before = protectedBytes();
    const document = {
      version: 1,
      files: [{ path: "kv/n/k.json", encoding: "utf8", content: "{}" }],
    };
    expect(
      await text(stateImport, { document, mode: "replace", stateDir: ".crewhaus" }, scoped),
    ).toContain(REFUSED);
    writeFileSync(join(ws, "top.tar"), buildTar([{ name: ".crewhaus/run/x", data: "changed\n" }]));
    expect(
      await text(archiveExtract, { archive: "top.tar", destination: ".", overwrite: true }, scoped),
    ).toContain(REFUSED);
    expect(protectedBytes()).toEqual(before);
    expect(existsSync(join(ws, ".crewhaus", "run", "x"))).toBe(false);
  });

  test("a copy into Hangar's directory inside the workspace", async () => {
    const before = protectedBytes();
    expect(
      await text(
        copyPath,
        { source: "staged/new.txt", destination: "home/token", overwrite: true },
        roots(),
      ),
    ).toContain(REFUSED);
    expect(
      await text(
        copyPath,
        { source: "staged/new.txt", destination: "home/access/members.json" },
        roots(),
      ),
    ).toContain(REFUSED);
    expect(protectedBytes()).toEqual(before);
    expect(existsSync(join(ws, "home", "access"))).toBe(false);
  });

  test("through the run loop in bypass mode: the move onto the settings file is the tool's to refuse", async () => {
    const before = protectedBytes();
    const r = await turn(
      {
        name: "MovePath",
        input: { source: "other.json", destination: ".crewhaus/settings.json", overwrite: true },
      },
      [movePath],
      emptyRuleSet,
      "bypass",
    );
    expect(r.decision).toBe("allow");
    expect(r.result).toContain(REFUSED);
    expect(protectedBytes()).toEqual(before);
    expect(readFileSync(join(ws, ".crewhaus", "settings.json"), "utf8")).toBe(SETTINGS);
  });
});

// ---------------------------------------------------------------------------
// End to end: the real tools through runChatLoop
// ---------------------------------------------------------------------------

type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

/** A model that plays `scripts` in order, and the requests it was sent (`seen`). */
function scriptedAdapter(
  scripts: ReadonlyArray<ReadonlyArray<Block>>,
  seen: Array<ReadonlyArray<{ readonly content: unknown }>>,
): ProviderAdapter {
  let i = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req) => {
      seen.push(req.messages as ReadonlyArray<{ readonly content: unknown }>);
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      const hasToolUse = content.some((b) => b.type === "tool_use");
      i++;
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (const [index, block] of content.entries()) {
          if (block.type === "text") {
            yield {
              kind: "content_block_start",
              index,
              block: { type: "text", text: "" },
            } as const;
            yield {
              kind: "content_block_delta",
              index,
              delta: { type: "text_delta", text: block.text },
            } as const;
          } else {
            yield {
              kind: "content_block_start",
              index,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            } as const;
            yield {
              kind: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            } as const;
          }
          yield { kind: "content_block_stop", index } as const;
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  } as ProviderAdapter;
}

/** The last tool_result the model was handed. */
function lastToolResult(
  seen: Array<ReadonlyArray<{ readonly content: unknown }>>,
): string | undefined {
  let found: string | undefined;
  for (const messages of seen) {
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as Array<{ type?: string; content?: unknown }>) {
        if (block.type !== "tool_result") continue;
        found = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      }
    }
  }
  return found;
}

/**
 * One model turn that makes `call`, run in the working directory with its
 * settings file loaded as every run loads it (`settingsDir` left unset): the
 * gate's decision on it, and what the tool handed back.
 */
async function turn(
  call: { readonly name: string; readonly input: Record<string, unknown> },
  tools: RegisteredTool[],
  rules: RuleSet,
  mode: PermissionMode,
  sessionRootDir: string = tempDir("crewhaus-floor-sessions-"),
): Promise<{ decision?: string; reason?: string; result?: string }> {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  const seen: Array<ReadonlyArray<{ readonly content: unknown }>> = [];
  await runChatLoop({
    model: "test-model",
    instructions: "control files floor",
    runContext,
    sessionRootDir,
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: mode,
    permissionRules: rules,
    tools,
    _adapter: scriptedAdapter(
      [
        [{ type: "tool_use", id: "tu_1", name: call.name, input: call.input }],
        [{ type: "text", text: "done" }],
      ],
      seen,
    ),
  });
  const first = events.find((e) => e.kind === "permission_decision" && e.toolName === call.name);
  const result = lastToolResult(seen);
  return {
    ...(first?.kind === "permission_decision" ? { decision: first.decision } : {}),
    ...(first?.kind === "permission_decision" && first.reason !== undefined
      ? { reason: first.reason }
      : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

describe("end to end: Write, Edit and HooksManage on the harness they run in", () => {
  let savedHangarRoot: string | undefined;
  const RULES = allowIn("Write", "Edit", "HooksManage");
  const TOOLS = [write, edit, hooksManage];
  beforeEach(() => {
    originalCwd = process.cwd();
    base = tempDir("crewhaus-floor-e2e-");
    ws = join(base, "harness");
    seedHarness(ws);
    put("prep.sh", "#!/bin/sh\nexit 0\n");
    chmodSync(join(ws, "prep.sh"), 0o755);
    put("fleet/other/prep.sh", "#!/bin/sh\nexit 0\n");
    chmodSync(join(ws, "fleet", "other", "prep.sh"), 0o755);
    savedHangarRoot = process.env["CREWHAUS_HANGAR_ROOT"];
    // Hangar's directory, named for this run inside the harness.
    process.env["CREWHAUS_HANGAR_ROOT"] = join(ws, "home");
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    if (savedHangarRoot === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_HANGAR_ROOT");
    else process.env["CREWHAUS_HANGAR_ROOT"] = savedHangarRoot;
  });
  const floorDenied = (r: { decision?: string; reason?: string }) => ({
    decision: r.decision,
    floor: r.reason?.includes(FLOOR) === true,
  });

  test("a Write of the settings file, adding a rule and a spawn hook, is refused and changes nothing", async () => {
    const changed = JSON.stringify({
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Bash" }] },
      manager: { hooks: { preSpawn: ["./prep.sh"] } },
    });
    const before = protectedBytes();
    const r = await turn(
      { name: "Write", input: { path: ".crewhaus/settings.json", content: changed } },
      TOOLS,
      RULES,
      "auto",
    );
    expect(floorDenied(r)).toEqual({ decision: "deny", floor: true });
    expect(protectedBytes()).toEqual(before);
    expect(loadSettingsRules(ws).map((rule) => `${rule.type} ${rule.pattern}`)).toEqual([
      "alwaysAllow Read",
    ]);
    expect(readManagerSettings(ws).hooks.preSpawn).toBeUndefined();
  });

  test("an Edit of the control token is refused", async () => {
    const before = protectedBytes();
    const r = await turn(
      {
        name: "Edit",
        input: { path: ".crewhaus/run/control-token", oldString: TOKEN, newString: "changed" },
      },
      TOOLS,
      RULES,
      "auto",
    );
    expect(floorDenied(r)).toEqual({ decision: "deny", floor: true });
    expect(protectedBytes()).toEqual(before);
  });

  test("a Write into Hangar's directory, the one the environment names and the default", async () => {
    const before = protectedBytes();
    const inHarness = await turn(
      { name: "Write", input: { path: "home/token", content: "changed" } },
      TOOLS,
      RULES,
      "auto",
    );
    expect(floorDenied(inHarness)).toEqual({ decision: "deny", floor: true });
    expect(protectedBytes()).toEqual(before);
    // The variable points elsewhere, and the default is still protected: the
    // floor answers, not the tool (which would refuse a path outside the
    // workspace on its own).
    const atDefault = await turn(
      { name: "Write", input: { path: join(DEFAULT_HOME, "token"), content: "changed" } },
      TOOLS,
      RULES,
      "auto",
    );
    expect(floorDenied(atDefault)).toEqual({ decision: "deny", floor: true });
  });

  test("HooksManage on the harness it runs in: set, with dir left out or `.`, and list", async () => {
    const before = protectedBytes();
    for (const input of [
      { action: "set", hook: "preSpawn", command: "./prep.sh", dryRun: false },
      { action: "set", hook: "preSpawn", command: "./prep.sh", dryRun: false, dir: "." },
      { action: "list" },
    ]) {
      const r = await turn({ name: "HooksManage", input }, TOOLS, RULES, "auto");
      expect({ input, ...floorDenied(r) }).toEqual({ input, decision: "deny", floor: true });
    }
    expect(protectedBytes()).toEqual(before);
    expect(readManagerSettings(ws).hooks.preSpawn).toBeUndefined();
  });

  test("controls: HooksManage on another harness in the workspace, and a Write elsewhere, run", async () => {
    const other = await turn(
      {
        name: "HooksManage",
        input: {
          action: "set",
          hook: "preSpawn",
          command: "./prep.sh",
          dryRun: false,
          dir: "fleet/other",
        },
      },
      TOOLS,
      RULES,
      "auto",
    );
    expect(other.decision).toBe("allow");
    expect(readManagerSettings(join(ws, "fleet", "other")).hooks.preSpawn?.argv).toEqual([
      "./prep.sh",
    ]);
    const notes = await turn(
      { name: "Write", input: { path: "notes.md", content: "kept" } },
      TOOLS,
      RULES,
      "auto",
    );
    expect(notes.decision).toBe("allow");
    expect(readFileSync(join(ws, "notes.md"), "utf8")).toBe("kept");
  });
});

// ---------------------------------------------------------------------------
// A directory cleared above a root the working directory reaches through a link
// ---------------------------------------------------------------------------

describe("a directory cleared above a root that lies behind a link", () => {
  const TOOLS = [tempDirTool];
  const RULES = allowIn("TempDir");
  const clear = (fixture: string, name: string, tempBase: string) =>
    turn(
      { name: "TempDir", input: { name, base: tempBase, clear: true } },
      TOOLS,
      RULES,
      "auto",
    ).then((r) => ({ fixture, decision: r.decision, floor: r.reason?.includes(FLOOR) === true }));
  let saved: string | undefined;
  beforeEach(() => {
    originalCwd = process.cwd();
    saved = process.env["CREWHAUS_HANGAR_ROOT"];
    Reflect.deleteProperty(process.env, "CREWHAUS_HANGAR_ROOT");
  });
  afterEach(() => {
    process.chdir(originalCwd);
    if (saved === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_HANGAR_ROOT");
    else process.env["CREWHAUS_HANGAR_ROOT"] = saved;
  });

  test("`.crewhaus` an operator links elsewhere in the workspace: its target's parent", async () => {
    base = tempDir("crewhaus-floor-oplink-");
    ws = join(base, "harness");
    mkdirSync(join(ws, "data", "crew", "run"), { recursive: true });
    writeFileSync(join(ws, "data", "crew", "settings.json"), SETTINGS);
    writeFileSync(join(ws, "data", "crew", "run", "control-token"), TOKEN);
    symlinkSync(join("data", "crew"), join(ws, ".crewhaus"));
    process.chdir(ws);
    const before = filesUnder(join(ws, "data"));
    expect(await clear("operator link", "crew", "data")).toEqual({
      fixture: "operator link",
      decision: "deny",
      floor: true,
    });
    expect(filesUnder(join(ws, "data"))).toEqual(before);
    expect(loadSettingsRules(ws).map((r) => r.pattern)).toEqual(["Read"]);
  });

  test("Hangar's directory named through a link to the workspace: its parent", async () => {
    base = tempDir("crewhaus-floor-homelink-");
    ws = join(base, "harness");
    mkdirSync(join(ws, "a", "h"), { recursive: true });
    writeFileSync(join(ws, "a", "h", "token"), TOKEN);
    symlinkSync(ws, join(base, "via"));
    process.env["CREWHAUS_HANGAR_ROOT"] = join(base, "via", "a", "h");
    process.chdir(ws);
    expect(await clear("named through a link", "a", ".")).toEqual({
      fixture: "named through a link",
      decision: "deny",
      floor: true,
    });
    expect(readFileSync(join(ws, "a", "h", "token"), "utf8")).toBe(TOKEN);
  });

  test("control: a directory beside the root is still cleared", async () => {
    base = tempDir("crewhaus-floor-oplink-");
    ws = join(base, "harness");
    mkdirSync(join(ws, "data", "crew"), { recursive: true });
    mkdirSync(join(ws, "data", "scratch"), { recursive: true });
    writeFileSync(join(ws, "data", "scratch", "x"), "old");
    symlinkSync(join("data", "crew"), join(ws, ".crewhaus"));
    process.chdir(ws);
    const r = await clear("beside the root", "scratch", "data");
    expect(r.decision).toBe("allow");
    expect(existsSync(join(ws, "data", "scratch", "x"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The directory a call keeps a tool's store in
// ---------------------------------------------------------------------------

describe("the directory a call keeps a tool's store in", () => {
  const STORE_TOOLS = [
    kvSet,
    noteWrite,
    counterIncrement,
    journalAppend,
    blackboardPost,
    dedupeMark,
    indexBuild,
    checkpointSave,
    datasetPut,
    emitTraceEvent,
    incidentBundle,
  ];
  const RULES = allowIn(...STORE_TOOLS.map((tool) => tool.name));
  const SAMPLE = { samples: [{ id: "s1", input: "hi" }], split: "train" };
  const floorAnswer = (r: { decision?: string; reason?: string }) => ({
    decision: r.decision,
    floor: r.reason?.includes(FLOOR) === true,
  });
  let saved: string | undefined;
  beforeEach(() => {
    originalCwd = process.cwd();
    saved = process.env["CREWHAUS_HANGAR_ROOT"];
    base = tempDir("crewhaus-floor-store-");
    ws = join(base, "harness");
    seedHarness(ws);
    process.env["CREWHAUS_HANGAR_ROOT"] = join(ws, "home");
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    if (saved === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_HANGAR_ROOT");
    else process.env["CREWHAUS_HANGAR_ROOT"] = saved;
  });

  const STORE_CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["KvSet", { namespace: "n", key: "k", value: "v" }],
    ["NoteWrite", { id: "n1", text: "x" }],
    ["CounterIncrement", { name: "c" }],
    ["JournalAppend", { stream: "s", entry: { a: 1 } }],
    ["BlackboardPost", { topic: "t", author: "a", text: "x" }],
    ["DedupeMark", { scope: "s", id: "x" }],
    ["IndexBuild", { name: "i", paths: ["notes.md"] }],
    ["CheckpointSave", { name: "c", data: { a: 1 } }],
  ];

  test("a store in a protected root is denied by the floor, under a tool-wide allow", async () => {
    const before = protectedBytes();
    for (const stateDir of [".crewhaus/run", ".crewhaus/settings.json", "home"]) {
      for (const [name, input] of STORE_CALLS) {
        const r = await turn({ name, input: { ...input, stateDir } }, STORE_TOOLS, RULES, "auto");
        expect({ name, stateDir, ...floorAnswer(r) }).toEqual({
          name,
          stateDir,
          decision: "deny",
          floor: true,
        });
      }
    }
    for (const call of [
      { name: "DatasetPut", input: { ...SAMPLE, name: "control", registryDir: ".crewhaus/run" } },
      { name: "EmitTraceEvent", input: { name: "x", dir: ".crewhaus/run", sessionId: "runs" } },
      {
        name: "EmitTraceEvent",
        input: { name: "x", dir: ".crewhaus/run/logs", sessionId: "run_a.events", create: true },
      },
      {
        name: "EmitTraceEvent",
        input: { name: "x", dir: ".crewhaus/run/control-token", sessionId: "s", create: true },
      },
      { name: "EmitTraceEvent", input: { name: "x", dir: "home", sessionId: "jobs" } },
    ]) {
      const r = await turn(call, STORE_TOOLS, RULES, "auto");
      expect({ input: call.input, ...floorAnswer(r) }).toEqual({
        input: call.input,
        decision: "deny",
        floor: true,
      });
    }
    expect(protectedBytes()).toEqual(before);
  }, 20_000); // slow by construction: one model turn for each tool and root

  test("a settings file that does not exist yet stays absent, and the next run still loads", async () => {
    rmSync(join(ws, ".crewhaus", "settings.json"));
    const r = await turn(
      {
        name: "KvSet",
        input: { namespace: "n", key: "k", value: "v", stateDir: ".crewhaus/settings.json" },
      },
      STORE_TOOLS,
      RULES,
      "auto",
    );
    expect(floorAnswer(r)).toEqual({ decision: "deny", floor: true });
    expect(existsSync(join(ws, ".crewhaus", "settings.json"))).toBe(false);
    expect(loadSettingsRules(ws)).toEqual([]);
  });

  test("a store elsewhere, its default and the run's record work under the same allow", async () => {
    const atDefault = await turn(
      { name: "KvSet", input: { namespace: "n", key: "k", value: "v" } },
      STORE_TOOLS,
      RULES,
      "auto",
    );
    expect(atDefault.decision).toBe("allow");
    expect(existsSync(join(ws, ".crewhaus", "state", "kv"))).toBe(true);
    const named = await turn(
      { name: "KvSet", input: { namespace: "n", key: "k", value: "v", stateDir: "my/state" } },
      STORE_TOOLS,
      RULES,
      "auto",
    );
    expect(named.decision).toBe("allow");
    expect(existsSync(join(ws, "my", "state", "kv"))).toBe(true);
    const dataset = await turn(
      { name: "DatasetPut", input: { ...SAMPLE, name: "evals" } },
      STORE_TOOLS,
      RULES,
      "auto",
    );
    expect(dataset.decision).toBe("allow");
    expect(existsSync(join(ws, ".crewhaus", "datasets", "evals", "v1.json"))).toBe(true);
    const roots = runtimeStateRoots(undefined, undefined, ws);
    const record = runtimeRecordRoots(undefined, undefined, ws);
    const dir = { field: "dir", kind: "path", default: ".crewhaus/sessions" };
    // The session log's own directory, at the default and named, is the tool's.
    for (const input of [{}, { dir: ".crewhaus/sessions" }, { dir: ".crewhaus/sessions/sub" }]) {
      expect({ input, out: relocatingFieldLeftOut(dir, input, record, roots, ws) }).toEqual({
        input,
        out: true,
      });
    }
    // Anywhere else it is read as any path is.
    for (const input of [{ dir: ".crewhaus/run" }, { dir: "my/logs" }, { dir: "" }, { dir: 1 }]) {
      expect({ input, out: relocatingFieldLeftOut(dir, input, record, roots, ws) }).toEqual({
        input,
        out: false,
      });
    }
    // A store the tool reads whole, and a service it is moved off, are not where it writes.
    const whole = { field: "dir", kind: "path", default: ".crewhaus/sessions", beneath: "all" };
    expect(relocatingFieldLeftOut(whole, { dir: ".crewhaus/run" }, record, roots, ws)).toBe(true);
    const service = { field: "endpoint", kind: "url", default: "https://example.test" };
    expect(relocatingFieldLeftOut(service, {}, record, roots, ws)).toBe(true);
    // A nested field cannot be placed, so it is read.
    const nested = { field: "a.b", kind: "path", default: ".crewhaus/sessions" };
    expect(relocatingFieldLeftOut(nested, {}, record, roots, ws)).toBe(false);
  }, 20_000); // slow by construction: three model turns

  test("EmitTraceEvent appends to a log in the run's own record, at the default and named", async () => {
    const record = join(ws, ".crewhaus", "sessions");
    for (const [sessionId, input] of [
      ["at-default", {}],
      ["named", { dir: ".crewhaus/sessions" }],
    ] as const) {
      const r = await turn(
        { name: "EmitTraceEvent", input: { name: "marked", sessionId, create: true, ...input } },
        STORE_TOOLS,
        RULES,
        "auto",
        record,
      );
      expect({ sessionId, ...floorAnswer(r) }).toEqual({
        sessionId,
        decision: "allow",
        floor: false,
      });
      expect(readFileSync(join(record, `${sessionId}.jsonl`), "utf8")).toContain("custom.marked");
    }
  });

  test("a store that holds a root through a link is the floor's, and the link is followed", async () => {
    symlinkSync(join(".crewhaus", "run"), join(ws, "to-run"));
    const before = protectedBytes();
    const r = await turn(
      { name: "KvSet", input: { namespace: "n", key: "k", value: "v", stateDir: "to-run" } },
      STORE_TOOLS,
      RULES,
      "auto",
    );
    expect(floorAnswer(r)).toEqual({ decision: "deny", floor: true });
    expect(protectedBytes()).toEqual(before);
    // Named inside the record, and leading out of it to a control file.
    const sessions = join(ws, ".crewhaus", "sessions");
    mkdirSync(sessions, { recursive: true });
    symlinkSync(join("..", "run"), join(sessions, "away"));
    const away = await turn(
      {
        name: "KvSet",
        input: { namespace: "n", key: "k", value: "v", stateDir: ".crewhaus/sessions/away" },
      },
      STORE_TOOLS,
      RULES,
      "auto",
    );
    expect(floorAnswer(away)).toEqual({ decision: "deny", floor: true });
    expect(protectedBytes()).toEqual(before);
  });

  test("with Hangar's directory holding the working directory, a store at its default is denied", async () => {
    process.chdir(join(ws, "home"));
    const home = realpathSync(join(ws, "home"));
    const before = filesUnder(home);
    for (const [name, input] of [
      ["KvSet", { namespace: "n", key: "k", value: "v" }],
      ["NoteWrite", { id: "n1", text: "x" }],
      ["CheckpointSave", { name: "c", data: { a: 1 } }],
      ["DatasetPut", { ...SAMPLE, name: "control" }],
      ["EmitTraceEvent", { name: "x", sessionId: "s", create: true }],
    ] as const) {
      const r = await turn({ name, input }, STORE_TOOLS, RULES, "auto");
      expect({ name, ...floorAnswer(r) }).toEqual({ name, decision: "deny", floor: true });
    }
    expect(filesUnder(home)).toEqual(before);
  }, 20_000); // slow by construction: one model turn for each tool

  test("IncidentBundle's sessions, which it reads whole, are not where it writes", async () => {
    mkdirSync(join(ws, ".crewhaus", "sessions"), { recursive: true });
    const r = await turn(
      { name: "IncidentBundle", input: { dir: ".crewhaus/sessions", out: "bundle.json" } },
      STORE_TOOLS,
      RULES,
      "auto",
    );
    expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
  });

  describe("EmitTraceEvent, where a log resolves", () => {
    const roots = (): string[] => runtimeStateRoots(undefined, undefined, ws);
    const emit = (dir: string, sessionId: string): Promise<string> =>
      text(emitTraceEvent, { name: "x", dir, sessionId, create: true }, roots());

    test("a log linked to the settings file or the control token is refused, and they keep their bytes", async () => {
      mkdirSync(join(ws, "x"));
      symlinkSync(join("..", ".crewhaus", "settings.json"), join(ws, "x", "s.jsonl"));
      symlinkSync(join("..", ".crewhaus", "run", "control-token"), join(ws, "x", "t.jsonl"));
      const before = protectedBytes();
      expect(await emit("x", "s")).toContain(REFUSED);
      expect(await emit("x", "t")).toContain(REFUSED);
      expect(protectedBytes()).toEqual(before);
    });

    test("a link to a settings file that does not exist yet is refused and creates nothing", async () => {
      rmSync(join(ws, ".crewhaus", "settings.json"));
      mkdirSync(join(ws, "x"));
      symlinkSync(join("..", ".crewhaus", "settings.json"), join(ws, "x", "s.jsonl"));
      expect(await emit("x", "s")).toContain(REFUSED);
      expect(existsSync(join(ws, ".crewhaus", "settings.json"))).toBe(false);
    });

    test("a log named in the record that a link takes out of it is refused", async () => {
      const sessions = join(ws, ".crewhaus", "sessions");
      mkdirSync(sessions, { recursive: true });
      symlinkSync(join("..", "settings.json"), join(sessions, "out.jsonl"));
      const before = protectedBytes();
      expect(await emit(".crewhaus/sessions", "out")).toContain(REFUSED);
      expect(protectedBytes()).toEqual(before);
    });

    test("a link inside the workspace to a plain file is followed, and so is an operator's link above the logs", async () => {
      put("elsewhere/kept.jsonl", "");
      mkdirSync(join(ws, "x"));
      symlinkSync(join("..", "elsewhere", "kept.jsonl"), join(ws, "x", "kept.jsonl"));
      expect(await emit("x", "kept")).toContain('"appended":true');
      expect(readFileSync(join(ws, "elsewhere", "kept.jsonl"), "utf8")).toContain("custom.x");

      const linked = join(base, "linked");
      mkdirSync(join(linked, "data", "crew", "sessions"), { recursive: true });
      symlinkSync(join("data", "crew"), join(linked, ".crewhaus"));
      process.chdir(linked);
      const out = await text(
        emitTraceEvent,
        { name: "x", dir: ".crewhaus/sessions", sessionId: "s", create: true },
        runtimeStateRoots(undefined, undefined, linked),
      );
      expect(out).toContain('"appended":true');
      expect(readFileSync(join(linked, "data", "crew", "sessions", "s.jsonl"), "utf8")).toContain(
        "custom.x",
      );
    });
  });

  describe("DatasetPut, where a dataset lands", () => {
    const roots = (): string[] => runtimeStateRoots(undefined, undefined, ws);
    const put_ = (input: Record<string, unknown>): Promise<string> =>
      text(datasetPut, { ...SAMPLE, ...input }, roots());

    test("a dataset linked into the run directory is refused, and writes nothing there", async () => {
      mkdirSync(join(ws, "x"));
      symlinkSync(join("..", ".crewhaus", "run"), join(ws, "x", "ds"));
      const before = protectedBytes();
      expect(await put_({ registryDir: "x", name: "ds" })).toContain(REFUSED);
      expect(protectedBytes()).toEqual(before);
      expect(existsSync(join(ws, ".crewhaus", "run", "v1.json"))).toBe(false);
    });

    test("a dataset named after a root under `.crewhaus` is refused", async () => {
      const before = protectedBytes();
      expect(await put_({ registryDir: ".crewhaus", name: "run" })).toContain(REFUSED);
      expect(await put_({ registryDir: ".crewhaus", name: "settings.json" })).toContain(REFUSED);
      expect(protectedBytes()).toEqual(before);
    });

    test("a dry run is refused with it, and a dataset elsewhere is written", async () => {
      expect(await put_({ registryDir: ".crewhaus/run", name: "d", dryRun: true })).toContain(
        REFUSED,
      );
      expect(await put_({ name: "ok" })).toContain('"wrote":true');
      expect(await put_({ registryDir: "my/reg", name: "ok" })).toContain('"wrote":true');
      expect(existsSync(join(ws, "my", "reg", "ok", "v1.json"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The settings file a run loads
// ---------------------------------------------------------------------------

/**
 * How a source spells one `settingsDir` token: runtime-core's own declaration
 * or read of the option, a caller passing `null` (which skips the load), or
 * anything else — a directory, a variable, a shorthand, a spread. The token
 * after the colon is read alone, so a comment that quotes the `null` form
 * reads as `null`.
 */
function settingsDirUse(before: string, after: string): "declaration" | "read" | "null" | "other" {
  if (after.startsWith("?:")) return "declaration";
  if (before.endsWith("opts.")) return "read";
  const value = /^\s*:\s*([A-Za-z_$][\w$]*|"[^"]*"|'[^']*'|`[^`]*`|\S)/.exec(after);
  return value?.[1] === "null" ? "null" : "other";
}

describe("the settings file a run loads is its working directory's", () => {
  test("the reading of a settingsDir token tells null from everything else", () => {
    const use = (line: string): string => {
      const at = line.indexOf("settingsDir");
      return settingsDirUse(line.slice(0, at), line.slice(at + "settingsDir".length));
    };
    expect(
      [
        "      settingsDir: null,",
        "  // `settingsDir: null` (sub-agent child loops) skips the load entirely.",
        "  settingsDir?: string | null;",
        "    if (opts.settingsDir === null) return base;",
        '      settingsDir: "./harness",',
        "      settingsDir: dir,",
        "      settingsDir: process.cwd(),",
        "    runChatLoop({ ...opts, settingsDir });",
        "    const o = { settingsDir, model };",
        "      settingsDir: undefined,",
      ].map(use),
    ).toEqual([
      "null",
      "null",
      "declaration",
      "read",
      "other",
      "other",
      "other",
      "other",
      "other",
      "other",
    ]);
  });

  test("no caller hands runChatLoop a directory: every one outside runtime-core passes null", () => {
    // runtime-core loads `<settingsDir ?? process.cwd()>/.crewhaus/settings.json`,
    // and the floor protects the working directory's. A caller that ever
    // passes a directory must extend the floor with it.
    const out = Bun.spawnSync(
      ["git", "grep", "-n", "--untracked", "-F", "-e", "settingsDir", "--", "packages", "apps"],
      { cwd: ROOT },
    );
    const RUNTIME = "packages/runtime-core/src/index.ts";
    const uses: Array<{ readonly file: string; readonly line: string; readonly use: string }> = [];
    for (const row of out.stdout.toString().split("\n")) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(row);
      if (m === null) continue;
      const [, file = "", line = "", source = ""] = m;
      if (!file.includes("/src/") || file.includes("/dist/") || /\.test\.ts$/.test(file)) continue;
      for (const hit of source.matchAll(/settingsDir/g)) {
        const at = hit.index ?? 0;
        const use = settingsDirUse(source.slice(0, at), source.slice(at + "settingsDir".length));
        uses.push({ file, line, use });
      }
    }
    const wrong = uses.filter(
      ({ file, use }) =>
        use !== "null" && !(file === RUNTIME && (use === "declaration" || use === "read")),
    );
    expect(wrong).toEqual([]);
    // The scan found what it is for: the child loops' null and runtime-core's own.
    const callers = new Set(
      uses.filter((u) => u.use === "null" && u.file !== RUNTIME).map((u) => u.file),
    );
    expect([...callers].sort()).toEqual(
      expect.arrayContaining([
        "packages/model-service/src/side-calls.ts",
        "packages/sub-agent-spawner/src/index.ts",
      ]),
    );
    expect(uses.filter((u) => u.file === RUNTIME && u.use === "declaration").length).toBe(1);
    expect(
      uses.filter((u) => u.file === RUNTIME && u.use === "read").length,
    ).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// A name the filesystem opens as a protected one, before it exists
// ---------------------------------------------------------------------------

describe("a spelling that opens a protected name when nothing is stored under it yet", () => {
  const BODY = '{"permissions":{"rules":[{"type":"alwaysAllow","pattern":"Write"}]}}\n';
  const startFresh = (dotDir: boolean): void => {
    originalCwd = process.cwd();
    base = tempDir("crewhaus-floor-fold-");
    ws = join(base, "harness");
    mkdirSync(dotDir ? join(ws, ".crewhaus") : ws, { recursive: true });
    env = { CREWHAUS_REGISTRY_ROOT: join(base, "registry") };
    process.chdir(ws);
  };
  afterEach(() => process.chdir(originalCwd));
  const roots = (): string[] => runtimeStateRoots(undefined, undefined, ws, env);
  const settingsGone = (): void => {
    expect(existsSync(join(ws, ".crewhaus", "settings.json"))).toBe(false);
    expect(loadSettingsRules(ws)).toEqual([]);
  };
  const VARIANTS = [
    [true, ".crewhaus/SETTINGS.JSON"],
    [true, ".crewhaus/ſettingſ.json"],
    [false, ".CREWHAUS/settings.json"],
    [false, ".crewhauſ/settings.json"],
  ] as const;

  const git = (...args: string[]): void => {
    const ran = Bun.spawnSync(["git", ...args], {
      cwd: ws,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "A U Thor",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "A U Thor",
        GIT_COMMITTER_EMAIL: "author@example.com",
      },
      stderr: "pipe",
    });
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  };
  const withGit = async (body: () => Promise<void>): Promise<void> => {
    const saved = [process.env["GIT_CONFIG_GLOBAL"], process.env["GIT_CONFIG_SYSTEM"]];
    process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
    process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
    try {
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "harness");
      await body();
    } finally {
      for (const [name, value] of [
        ["GIT_CONFIG_GLOBAL", saved[0]],
        ["GIT_CONFIG_SYSTEM", saved[1]],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  };

  test("GitApplyPatch refuses each, on any volume", async () => {
    for (const [dotDir, name] of VARIANTS) {
      startFresh(dotDir);
      await withGit(async () => {
        const diff = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${BODY}`;
        const out = JSON.parse(await text(gitApplyPatch, { cwd: ".", patch: diff }, roots())) as {
          applied: boolean;
          reason: string;
        };
        expect({ name, applied: out.applied }).toEqual({ name, applied: false });
        expect(out.reason).toContain(REFUSED);
      });
      expect(existsSync(join(ws, name))).toBe(false);
      settingsGone();
      process.chdir(originalCwd);
    }
    startFresh(true);
  });

  test("GitApplyPatch refuses a link at a name that holds a root", async () => {
    for (const name of [".crewhaus", ".crewhauſ", ".CREWHAUS"]) {
      startFresh(false);
      mkdirSync(join(ws, "stash"));
      await withGit(async () => {
        const diff = `diff --git a/${name} b/${name}\nnew file mode 120000\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+stash\n\\ No newline at end of file\n`;
        const out = JSON.parse(await text(gitApplyPatch, { cwd: ".", patch: diff }, roots())) as {
          applied: boolean;
          reason: string;
        };
        expect({ name, applied: out.applied }).toEqual({ name, applied: false });
        expect(out.reason).toContain(REFUSED);
      });
      expect(readdirSync(ws).sort()).toEqual([".git", "stash"]);
      process.chdir(originalCwd);
    }
    startFresh(true);
  });

  test("StateImport with its state directory at the workspace root refuses each, on any volume", async () => {
    for (const [dotDir, name] of VARIANTS) {
      startFresh(dotDir);
      const document = { version: 1, files: [{ path: name, encoding: "utf8", content: BODY }] };
      expect(
        await text(stateImport, { stateDir: ".", document, confirm: true }, roots()),
      ).toContain(REFUSED);
      expect(existsSync(join(ws, name))).toBe(false);
      settingsGone();
      process.chdir(originalCwd);
    }
    startFresh(true);
  });

  test("ArchiveExtract into the workspace root refuses a top level that opens `.crewhaus`, on any volume", async () => {
    startFresh(false);
    writeFileSync(
      join(ws, "other.tar"),
      buildTar([{ name: ".CREWHAUS/settings.json", data: BODY }]),
    );
    expect(
      await text(
        archiveExtract,
        { archive: "other.tar", destination: ".", overwrite: true },
        roots(),
      ),
    ).toContain(REFUSED);
    expect(readdirSync(ws)).toEqual(["other.tar"]);
  });

  // The canonicaliser marks a value only where the volume folds; where it does
  // not, these are other files.
  (IGNORES_CASE ? test : test.skip)("the write matrix's pairs: denied before any rule", () => {
    for (const [dotDir, name] of VARIANTS) {
      startFresh(dotDir);
      const { canonicalizePath } = placeRecordingCanonicalizer(ws);
      const wrong: string[] = [];
      for (const { entry, arg } of PAIRS) {
        const input = {
          ...(arg.within !== undefined ? { [arg.within]: "." } : {}),
          [arg.field]: arg.field.endsWith("s") ? [name] : name,
        };
        const operativeValues = operativeValuesOf([arg], input, { canonicalizePath });
        const r = evaluateWithReason(
          {
            toolName: entry.name,
            input,
            ...(operativeValues !== undefined ? { operativeValues } : {}),
            readOnly: false,
            destructive: entry.destructive,
            requiresSandbox: entry.requiresSandbox,
          },
          "auto",
          allowIn(entry.name),
          { protectedRoots: roots() },
        );
        if (r.decision !== "deny") wrong.push(`${entry.name}.${arg.field} ${name}: ${r.decision}`);
      }
      expect(wrong).toEqual([]);
      process.chdir(originalCwd);
    }
    startFresh(true);
  });

  (IGNORES_CASE ? test : test.skip)(
    "a Write of the settings file by its full case fold is refused through the run, and loads nothing",
    async () => {
      startFresh(true);
      const r = await turn(
        { name: "Write", input: { path: ".crewhaus/ſettingſ.json", content: BODY } },
        [write],
        allowIn("Write"),
        "auto",
      );
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain(FLOOR);
      expect(readdirSync(join(ws, ".crewhaus"))).not.toContain("ſettingſ.json");
      settingsGone();
    },
    20_000,
  );
});
