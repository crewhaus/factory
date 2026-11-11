/**
 * The runtime-state floor over the files that control a run: the harness's
 * run directory (`.crewhaus/run`, all of it), its settings file
 * (`.crewhaus/settings.json`, that file exactly), the records its gates and
 * janitors keep, its environment files, the `bunfig.toml` and `.npmrc` in the
 * working directory, a managed run's tenants root, and Hangar's directory and
 * registry file (every Hangar root the run's environment names, and
 * `~/.crewhaus/hangar` and `~/.crewhaus/harnesses.json` always), and in a
 * harness's own directory what its next start runs. These are the operator's
 * configuration and the harness's records, so its own tools are not the ones
 * that write them. Held here with runtime-core's own roots
 * (`runtimeStateRoots`), from these sides:
 *
 * - the write matrix: every builtin that is not read-only, through each path
 *   field it writes, in the spellings a call gives, is denied by
 *   permission-engine before any rule is read, in every mode but `bypass`;
 * - nothing else moves: a neighbour of a protected file, a read-only call,
 *   and CrewHaus's own settings writer are what they were;
 * - the tools that check their own writes refuse these roots in `bypass` too;
 * - end to end, the real Write, Edit and HooksManage through runChatLoop;
 * - the settings file a run loads is its working directory's, the one the
 *   floor protects;
 * - a tool that keeps its own store in a gate record, and CrewHaus's library
 *   writers, go on adding to it.
 * - in a harness's own directory, the real Write, Edit and the tools that check
 *   their own writes through the run, then the real spawn plan and a real start;
 * - a tool that moves the working tree, through runChatLoop, whose targets no
 *   path field names: what it would change is what it checks.
 *
 * No test here writes under the real home directory: the default Hangar
 * root is only ever named in decisions, and a Write there lies outside the
 * workspace, which the tool refuses on its own.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BUNDLE_MANIFEST_NAME as CLI_BUNDLE_MANIFEST_NAME } from "../apps/cli/src/bundle-manifest";
import { writeCalibrationFileAtomic } from "../apps/cli/src/judge-calibrate";
import type { ProviderAdapter } from "../packages/adapter-anthropic/src/index";
import { DEFAULT_ROOT_DIR as CHECKPOINT_ROOT_DIR } from "../packages/checkpoint-store/src/index";
import { appendRetentionPins, createContinuityStore } from "../packages/continuity-store/src/index";
import { RETENTION_CONFIG_RELPATH } from "../packages/data-retention-engine/src/retention-config";
import { DEFAULT_EVALS_DIR } from "../packages/eval-report/src/history";
import { JUDGE_CALIBRATION_RELPATH } from "../packages/eval-runner/src/index";
import { BUNDLE_MANIFEST_NAME } from "../packages/harness-supervisor/src/bundle-freshness";
import {
  MANAGER_SETTINGS_SEGMENTS,
  readManagerSettings,
} from "../packages/harness-supervisor/src/manager-settings";
import {
  BUNDLE_DIR_CANDIDATES,
  ENV_FILENAMES,
  SPEC_FILENAMES,
  buildSpawnPlan,
  findSpecPath,
} from "../packages/harness-supervisor/src/spawn-contracts";
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
import type { JustificationJudge } from "../packages/permission-engine/src/index";
import { createRunContext } from "../packages/run-context/src/index";
import { runChatLoop } from "../packages/runtime-core/src/index";
import { placeRecordingCanonicalizer } from "../packages/runtime-core/src/path-canonical";
import {
  COMPILED_BUNDLE_NAME,
  declaredEnvFiles,
  relocatingFieldLeftOut,
  runtimeRecordRoots,
  runtimeStateRoots,
} from "../packages/runtime-core/src/state-roots";
import { createPendingApprovalStore } from "../packages/session-store/src/index";
import { buildTenant, withTenant } from "../packages/tenancy/src/index";
import type { RegisteredTool } from "../packages/tool-catalog/src/index";
import { datasetPut } from "../packages/tool-dataset/src/index";
import { deployRollback, specPin } from "../packages/tool-deploy/src/index";
import { clipboardWrite, desktopNotify } from "../packages/tool-desktop/src/index";
import { evalBaselinePin } from "../packages/tool-evalops/src/index";
import { operativeValuesOf } from "../packages/tool-executor/src/index";
import { compileBundle, hooksManage } from "../packages/tool-fleet/src/index";
import { edit, write } from "../packages/tool-fs/src/index";
import { buildTar } from "../packages/tool-fsx/src/archive-fixtures";
import {
  archiveExtract,
  copyPath,
  movePath,
  removePath,
  tempDir as tempDirTool,
} from "../packages/tool-fsx/src/index";
import {
  GIT_TOOLS,
  gitApplyPatch,
  gitCherryPick,
  gitStashPop,
  gitSwitch,
} from "../packages/tool-git/src/index";
import { imageGenerate } from "../packages/tool-image-generation/src/index";
import { harnessRetire, knowledgeSync, storeMigrate } from "../packages/tool-lifecycle/src/index";
import { createMemoryTools } from "../packages/tool-memory/src/index";
import { createAllMouseKeyboardTools } from "../packages/tool-mouse-keyboard/src/index";
import { emitTraceEvent, incidentBundle } from "../packages/tool-obs/src/index";
import { createPlanTools } from "../packages/tool-plan/src/index";
import { TOOL_REGISTRY } from "../packages/tool-registry-manifest/src/generated";
import { experimentLedger, routeControl } from "../packages/tool-routing/src/index";
import { envFileUpsert, secretRotate } from "../packages/tool-secrets/src/index";
import { doctorFix } from "../packages/tool-specops/src/index";
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
import { createTaskTool } from "../packages/tool-task/src/index";
import { getCurrentTodos, todoWrite } from "../packages/tool-todo/src/index";
import { createWikiTools } from "../packages/tool-wiki/src/index";
import type { TraceEvent } from "../packages/trace-event-bus/src/index";
import { createWikiStore } from "../packages/wiki-store/src/index";

const ROOT = dirname(import.meta.dir);
/** What the floor's reason adds, in both of its forms. */
const FLOOR =
  "or the files that control it (the harness's run files, settings, gate records, environment files, compiled bundle and dependencies, Hangar's directory) — no rule can allow that";
/** What a tool that checks its own writes says when it refuses one. */
const REFUSED =
  "where the runtime keeps its own record of the run (session logs, spilled tool results, proof bundles) or the files that control it (the harness's run files, settings, gate records, environment files, compiled bundle and dependencies, Hangar's directory), which no tool may change. Nothing was written.";
const DEFAULT_HOME = join(homedir(), ".crewhaus", "hangar");
const DEFAULT_REGISTRY = join(homedir(), ".crewhaus", "harnesses.json");

/** The directories and exact files a harness's gates and janitors read. */
const GATE_DIRS = [
  ".crewhaus/approvals",
  ".crewhaus/graders",
  ".crewhaus/evals",
  ".crewhaus/datasets",
  ".crewhaus/audit",
  ".crewhaus/graphs",
  ".crewhaus/advice",
];
const GATE_FILES = [
  ".crewhaus/environments.json",
  ".crewhaus/judge-calibration.json",
  ".crewhaus/retention.json",
];
const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];
const START_CONFIG = ["bunfig.toml", ".npmrc"];
/** The file `manager.envFiles` names in the matrix's harness. */
const DECLARED_ENV = "config/shared.env";
/** Beside a root, each of them another file. */
const NEIGHBOURS = [
  ".crewhaus/notes.md",
  ".crewhaus/settings.json.bak",
  ".crewhaus/runbook/x",
  "home-notes/token",
  ".crewhaus/approvals.jsonl",
  ".crewhaus/environments.json.bak",
  ".crewhaus/retention.json.bak",
  ".crewhaus/graders.yaml",
  ".crewhaus/advice.md",
  ".env.example",
  ".env.sample",
  ".envrc",
  ".environment",
  "sub/.env",
  "sub/bunfig.toml",
  "config/other.env",
];
/** Each writer whose field keeps its store in a gate record, and that record. */
const OWN_STORES: Readonly<Record<string, readonly string[]>> = {
  "DatasetPut.registryDir": [".crewhaus/datasets"],
  "EvalBaselinePin.evalsDir": [".crewhaus/evals"],
  "EmitTraceEvent.dir": [".crewhaus/sessions", ".crewhaus/tool-results", ".crewhaus/proofs"],
};
/** The directories of the run's own record, at a run's defaults. */
const RECORD_DIRS = [".crewhaus/sessions", ".crewhaus/tool-results", ".crewhaus/proofs"];

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
      ["the graph checkpoints", CHECKPOINT_ROOT_DIR.split("/").join(sep)],
      ["the retention file", RETENTION_CONFIG_RELPATH.split("/").join(sep)],
      ["the eval history", DEFAULT_EVALS_DIR],
      ["the judge calibration", JUDGE_CALIBRATION_RELPATH],
      ...ENV_FILENAMES.map((name) => [`the supervisor's ${name}`, name] as const),
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
    join(ws, "config"),
    join(base, "registry", "hangar", "access"),
    ...GATE_DIRS.map((rel) => join(ws, rel)),
    ...RECORD_DIRS.map((rel) => join(ws, rel)),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(ws, ".crewhaus", "settings.json"),
    `${JSON.stringify({ manager: { envFiles: [DECLARED_ENV] } })}\n`,
  );
  const NEW_FILES = [...GATE_FILES, ...ENV_FILES, ...START_CONFIG, DECLARED_ENV];
  for (const rel of NEW_FILES) writeFileSync(join(ws, rel), "kept\n");
  symlinkSync(join(".crewhaus", "run"), join(ws, "to-run"));
  symlinkSync(join(".crewhaus", "settings.json"), join(ws, "to-settings"));
  symlinkSync("home", join(ws, "to-home"));
  symlinkSync(".", join(ws, "alias"));
  /** A link to each new root, by a name of its own. */
  const NEW_LINKS = [...GATE_DIRS, ...RECORD_DIRS, ...NEW_FILES].map(
    (rel): readonly [string, string] => {
      const link = `to-${rel.replace(/[^a-z0-9]+/gi, "-")}`;
      symlinkSync(rel, join(ws, link));
      return [rel, link];
    },
  );
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
    ...NEW_LINKS,
  ];
  const INSIDE = [
    ".crewhaus/run/x",
    ".crewhaus/run",
    ".crewhaus/settings.json",
    "home/token",
    "home/access/members.json",
    ...GATE_DIRS.map((rel) => `${rel}/x`),
    ...RECORD_DIRS.map((rel) => `${rel}/x`),
    ...NEW_FILES,
    // A directory where an exact file is expected: what lies under it is held.
    ".env/x",
  ];
  const OUTSIDE = [
    join(beside, "token"),
    join(beside, "access", "members.json"),
    join(DEFAULT_HOME, "token"),
    join(base, "registry", "harnesses.json"),
    DEFAULT_REGISTRY,
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
          // A field's own store is left out when the call names it, and read
          // as any path otherwise. The tests below name which spellings do.
          const own = OWN_STORES[pair];
          if (own?.some((store) => target.startsWith(`${store}/`)) === true) {
            const out = relocatingFieldLeftOut(arg, call.input, RECORD_ROOTS, ROOTS, ws);
            const r = evaluateWithReason(call, "auto", allowIn(entry.name), {
              protectedRoots: ROOTS,
            });
            if (r.decision !== (out ? "allow" : "deny")) {
              wrong.push(`${pair} ${how} own store, left out ${out}: ${r.decision}`);
            }
            continue;
          }
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
    for (const name of NEIGHBOURS) {
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
      ["Read", { path: ".crewhaus/graders/x" }],
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
      [
        join(".crewhaus", "run"),
        join(".crewhaus", "settings.json"),
        ...[...GATE_DIRS, ...GATE_FILES].map((rel) => rel.split("/").join(sep)),
        ...ENV_FILES,
        ...START_CONFIG,
        "home",
      ].sort(),
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
  // `null` leaves the root to the loop: the tenant's, or the session variable.
  sessionRootDir: string | null = tempDir("crewhaus-floor-sessions-"),
  extra: Partial<Parameters<typeof runChatLoop>[0]> = {},
): Promise<{ decision?: string; reason?: string; result?: string }> {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  const seen: Array<ReadonlyArray<{ readonly content: unknown }>> = [];
  await runChatLoop({
    model: "test-model",
    instructions: "control files floor",
    runContext,
    ...(sessionRootDir !== null ? { sessionRootDir } : {}),
    // These checks compare the workspace before and after a call: the run's
    // own records would land in it, so this loop writes none.
    runLedgerDir: null,
    ...extra,
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

describe("end to end: a repository's git directory, under a tool-wide allow", () => {
  const GIT_FLOOR = "names a path inside a repository's git directory";
  const GIT_REFUSED = "would write inside a repository's git directory";
  const TOOLS = [write, edit, movePath, archiveExtract, stateImport, ...GIT_TOOLS];
  const RULES = allowIn(
    "Write",
    "Edit",
    "MovePath",
    "ArchiveExtract",
    "StateImport",
    "GitAdd",
    "GitCommit",
  );
  const git = (...args: string[]): string => {
    const r = Bun.spawnSync(["git", ...args], { cwd: ws, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
  };
  const denied = async (name: string, input: Record<string, unknown>) => {
    const r = await turn({ name, input }, TOOLS, RULES, "auto");
    return { name, decision: r.decision, floor: r.reason?.includes(GIT_FLOOR) === true };
  };
  let hook = "";
  let ran = "";
  const hookBody = (label: string): string => `#!/bin/sh\necho ${label} >> "${ran}"\n`;

  beforeEach(() => {
    originalCwd = process.cwd();
    base = tempDir("crewhaus-floor-git-");
    ws = join(base, "harness");
    seedHarness(ws);
    put("a.txt", "one\n");
    put(".gitignore", ".crewhaus/\n");
    git("init", "-q", "-b", "main", ".");
    git("config", "user.name", "A U Thor");
    git("config", "user.email", "author@example.com");
    git("config", "commit.gpgsign", "false");
    git("add", "a.txt", ".gitignore");
    git("commit", "-qm", "base");
    ran = join(base, "ran.log");
    hook = join(ws, ".git", "hooks", "pre-commit");
    writeFileSync(hook, hookBody("seeded"));
    chmodSync(hook, 0o755);
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
  });

  test("a Write of its config is denied, and git reads the config that was there", async () => {
    const before = readFileSync(join(ws, ".git", "config"), "utf8");
    const answer = await denied("Write", {
      path: ".git/config",
      content: `${before}[user]\n\tname = changed\n`,
    });
    expect(answer).toEqual({ name: "Write", decision: "deny", floor: true });
    expect(readFileSync(join(ws, ".git", "config"), "utf8")).toBe(before);
  });

  test("a Write over a hook is denied, and the hook that runs is the one that was there", async () => {
    const answer = await denied("Write", {
      path: ".git/hooks/pre-commit",
      content: hookBody("written"),
    });
    expect(answer).toEqual({ name: "Write", decision: "deny", floor: true });
    expect(
      await denied("MovePath", {
        source: ".git/hooks/pre-commit.sample",
        destination: ".git/hooks/pre-push",
      }),
    ).toEqual({ name: "MovePath", decision: "deny", floor: true });
    put("a.txt", "two\n");
    await turn({ name: "GitAdd", input: { paths: ["a.txt"] } }, TOOLS, RULES, "auto");
    await turn({ name: "GitCommit", input: { message: "two" } }, TOOLS, RULES, "auto");
    expect(readFileSync(ran, "utf8").trim().split("\n")).toEqual(["seeded"]);
  });

  test("a nested repository, a directory or a file named `.git`, is not written", async () => {
    expect(
      await denied("Write", { path: "n/.git/HEAD", content: "ref: refs/heads/main\n" }),
    ).toEqual({ name: "Write", decision: "deny", floor: true });
    expect(await denied("Write", { path: "n/.git", content: "gitdir: ../store\n" })).toEqual({
      name: "Write",
      decision: "deny",
      floor: true,
    });
    expect(existsSync(join(ws, "n", ".git"))).toBe(false);
    // `n` is still a directory of the outer repository: GitAdd stages there.
    put("n/x.md", "hi\n");
    await turn({ name: "GitAdd", input: { cwd: "n", paths: ["x.md"] } }, TOOLS, RULES, "auto");
    expect(git("diff", "--cached", "--name-only").trim()).toBe("n/x.md");
  });

  test("its neighbours are the rules' to decide, and a store's own layout is left alone", async () => {
    for (const path of [".gitattributes", "n/.gitignore", ".github/x", "foo.git/x"]) {
      const r = await turn(
        { name: "Write", input: { path, content: "x\n" } },
        TOOLS,
        RULES,
        "auto",
      );
      expect({ path, decision: r.decision }).toEqual({ path, decision: "allow" });
      expect(existsSync(join(ws, path))).toBe(true);
    }
    const store = await turn(
      { name: "KvSet", input: { namespace: "n", key: "k", value: "v", stateDir: "n/.git" } },
      [kvSet],
      allowIn("KvSet"),
      "auto",
    );
    expect(store.decision).toBe("allow");
  });

  test("in bypass, ArchiveExtract and StateImport refuse on their own", async () => {
    writeFileSync(join(ws, "repo.tar"), buildTar([{ name: "n/.git/config", data: "[core]\n" }]));
    const extracted = await turn(
      { name: "ArchiveExtract", input: { archive: "repo.tar", destination: "." } },
      TOOLS,
      emptyRuleSet,
      "bypass",
    );
    expect(extracted.decision).toBe("allow");
    expect(extracted.result).toContain(GIT_REFUSED);
    const imported = await turn(
      {
        name: "StateImport",
        input: {
          stateDir: ".",
          document: {
            version: 1,
            files: [{ path: "n/.git/config", encoding: "utf8", content: "[core]\n" }],
          },
        },
      },
      TOOLS,
      emptyRuleSet,
      "bypass",
    );
    expect(imported.decision).toBe("allow");
    expect(imported.result).toContain(GIT_REFUSED);
    expect(existsSync(join(ws, "n"))).toBe(false);
  }, 20_000); // slow by construction: two model turns and an archive read
});

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
// What a harness's gates read, its environment files and its start config
// ---------------------------------------------------------------------------

describe("the records a harness's gates read, its environment files and its start config", () => {
  const floorAnswer = (r: { decision?: string; reason?: string }) => ({
    decision: r.decision,
    floor: r.reason?.includes(FLOOR) === true,
  });
  const DENIED = { decision: "deny", floor: true };
  const allowAny: Parameters<typeof runChatLoop>[0]["justificationJudge"] = () => ({
    allow: true,
    reason: "test",
    judgeModel: "test",
  });
  let savedSessionDir: string | undefined;
  beforeEach(() => {
    originalCwd = process.cwd();
    savedSessionDir = process.env["CREWHAUS_SESSION_DIR"];
    Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
    base = tempDir("crewhaus-floor-records-");
    ws = join(base, "harness");
    mkdirSync(ws, { recursive: true });
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    if (savedSessionDir === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
    else process.env["CREWHAUS_SESSION_DIR"] = savedSessionDir;
  });
  const roots = (registry: string = join(base, "registry")): string[] =>
    runtimeStateRoots(undefined, undefined, ws, { CREWHAUS_REGISTRY_ROOT: registry });

  describe("end to end, through the run under a rule that allows every Write", () => {
    const WRITE_ALL: RuleSet = {
      ...emptyRuleSet,
      flag: [{ type: "alwaysAllow", pattern: "Write(**)", source: "flag" }],
    };
    const writeTo = (path: string) =>
      turn({ name: "Write", input: { path, content: "chosen\n" } }, [write], WRITE_ALL, "auto");

    for (const path of [
      ".env",
      ".env.production.local",
      ".crewhaus/graders/x/index.ts",
      ".crewhaus/approvals/s__prod.json",
      ".crewhaus/environments.json",
      "bunfig.toml",
      ".npmrc",
    ]) {
      test(`Write ${path}: denied, and the file is absent`, async () => {
        const r = await writeTo(path);
        expect(floorAnswer(r)).toEqual(DENIED);
        expect(r.reason).toContain("gate records, environment files");
        expect(existsSync(join(ws, path))).toBe(false);
      });
    }

    (IGNORES_CASE ? test : test.skip)(
      "a name the volume opens as `.env.test`: denied, and nothing is stored",
      async () => {
        const r = await writeTo(".env.teſt");
        expect(floorAnswer(r)).toEqual(DENIED);
        expect(readdirSync(ws).filter((name) => name.startsWith(".env"))).toEqual([]);
      },
    );

    test("a neighbour, and the same name in a subdirectory, are written", async () => {
      for (const path of [".env.example", "sub/.env", "sub/bunfig.toml", ".crewhaus/notes.md"]) {
        const r = await writeTo(path);
        expect({ path, ...floorAnswer(r) }).toEqual({ path, decision: "allow", floor: false });
        expect(readFileSync(join(ws, path), "utf8")).toBe("chosen\n");
      }
    });

    test("the registry file, when the workspace holds the registry root", async () => {
      const saved = process.env["CREWHAUS_REGISTRY_ROOT"];
      process.env["CREWHAUS_REGISTRY_ROOT"] = ws;
      try {
        expect(floorAnswer(await writeTo("harnesses.json"))).toEqual(DENIED);
        expect(existsSync(join(ws, "harnesses.json"))).toBe(false);
      } finally {
        if (saved === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_REGISTRY_ROOT");
        else process.env["CREWHAUS_REGISTRY_ROOT"] = saved;
      }
    });

    test("a file `manager.envFiles` names, and its neighbour", async () => {
      put(
        ".crewhaus/settings.json",
        JSON.stringify({ manager: { envFiles: ["config/shared.env"] } }),
      );
      expect(floorAnswer(await writeTo("config/shared.env"))).toEqual(DENIED);
      expect(existsSync(join(ws, "config", "shared.env"))).toBe(false);
      expect((await writeTo("config/other.env")).decision).toBe("allow");
    });

    test("a session directory at the working directory: its approvals file, and a note beside it", async () => {
      process.env["CREWHAUS_SESSION_DIR"] = ".";
      const denied = await turn(
        { name: "Write", input: { path: "approvals.jsonl", content: "chosen\n" } },
        [write],
        WRITE_ALL,
        "auto",
        null,
      );
      expect(floorAnswer(denied)).toEqual(DENIED);
      expect(existsSync(join(ws, "approvals.jsonl"))).toBe(false);
      const allowed = await turn(
        { name: "Write", input: { path: "notes.md", content: "chosen\n" } },
        [write],
        WRITE_ALL,
        "auto",
        null,
      );
      expect(allowed.decision).toBe("allow");
      expect(readFileSync(join(ws, "notes.md"), "utf8")).toBe("chosen\n");
    }, 20_000); // slow by construction: two model turns
  });

  describe("the tools that name an environment file", () => {
    const TOOLS = [envFileUpsert, secretRotate, doctorFix];
    const RULES = allowIn("EnvFileUpsert", "SecretRotate", "DoctorFix");
    const ENTRIES = [{ key: "DEPLOY_REGION", value: "eu" }];
    const GENERATE = { generate: { bytes: 32, encoding: "hex" } };
    const call = (name: string, input: Record<string, unknown>) =>
      turn({ name, input }, TOOLS, RULES, "auto", tempDir("crewhaus-floor-sessions-"), {
        justificationJudge: allowAny,
      });
    const JUSTIFIED = { justification: "rotate the deploy region value for this harness" };

    test("EnvFileUpsert: its default and each named file are denied, another file written", async () => {
      for (const input of [{}, { path: ".env" }, { path: ".env.local" }]) {
        const r = await call("EnvFileUpsert", { ...input, entries: ENTRIES });
        expect({ input, ...floorAnswer(r) }).toEqual({ input, ...DENIED });
      }
      expect(readdirSync(ws)).toEqual([]);
      const r = await call("EnvFileUpsert", { path: "public.env", entries: ENTRIES });
      expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
      expect(readFileSync(join(ws, "public.env"), "utf8")).toContain("DEPLOY_REGION=eu");
    }, 20_000); // slow by construction: four model turns

    test("SecretRotate: a file, a key in one and a bare name are denied, another file goes through", async () => {
      for (const ref of ["file:.env", "envfile:.env#K", "envfile:.env.local#K", "K"]) {
        const r = await call("SecretRotate", { ref, ...GENERATE, ...JUSTIFIED });
        expect({ ref, ...floorAnswer(r) }).toEqual({ ref, ...DENIED });
      }
      expect(readdirSync(ws)).toEqual([]);
      put("shared/x", "old\n");
      const r = await call("SecretRotate", { ref: "file:shared/x", ...GENERATE, ...JUSTIFIED });
      expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
    }, 20_000); // slow by construction: five model turns

    test("DoctorFix: its default is denied, another envPath goes through", async () => {
      const stubs = { fixes: ["env-stubs"], envVars: ["DEPLOY_REGION"], dryRun: false };
      expect(floorAnswer(await call("DoctorFix", stubs))).toEqual(DENIED);
      expect(existsSync(join(ws, ".env"))).toBe(false);
      put("sub/keep", "");
      const r = await call("DoctorFix", { ...stubs, envPath: "sub/stub.env" });
      expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
      expect(readFileSync(join(ws, "sub", "stub.env"), "utf8")).toContain("# DEPLOY_REGION=");
    }, 20_000); // slow by construction: two model turns
  });

  describe("the tools that check their own writes, in bypass", () => {
    const seedPack = (): void => {
      put("pack/.env", "chosen\n");
      put("pack/bunfig.toml", "chosen\n");
      put("pack/readme.md", "fine\n");
    };
    const untouched = (): void => {
      for (const name of [".env", "bunfig.toml", "readme.md"]) {
        expect({ name, landed: existsSync(join(ws, name)) }).toEqual({ name, landed: false });
      }
    };
    const inBypass = (name: string, input: Record<string, unknown>) =>
      turn({ name, input }, [copyPath, movePath, archiveExtract], emptyRuleSet, "bypass");
    const refused = (r: { decision?: string; result?: string }) => {
      expect(r.decision).toBe("allow");
      expect(r.result).toContain(REFUSED);
    };

    test("CopyPath of a tree, and of a file, onto the working directory", async () => {
      seedPack();
      refused(await inBypass("CopyPath", { source: "pack", destination: "." }));
      untouched();
      refused(await inBypass("CopyPath", { source: "pack/.env", destination: "." }));
      untouched();
      refused(await inBypass("CopyPath", { source: "pack/.env", destination: ".env" }));
      untouched();
    });

    test("MovePath of a file onto the working directory, and the file stays", async () => {
      seedPack();
      refused(await inBypass("MovePath", { source: "pack/.env", destination: "." }));
      refused(await inBypass("MovePath", { source: "pack/.env", destination: ".env" }));
      untouched();
      expect(readFileSync(join(ws, "pack", ".env"), "utf8")).toBe("chosen\n");
    });

    test("ArchiveExtract of a top-level `.env` or `bunfig.toml` into the working directory", async () => {
      for (const name of [".env", "bunfig.toml", ".npmrc"]) {
        writeFileSync(join(ws, "a.tar"), buildTar([{ name, data: "chosen\n" }]));
        refused(
          await inBypass("ArchiveExtract", { archive: "a.tar", destination: ".", overwrite: true }),
        );
        expect({ name, landed: existsSync(join(ws, name)) }).toEqual({ name, landed: false });
      }
    });

    test("control: the same tree lands in a subdirectory, where those names are other files", async () => {
      seedPack();
      expect(await text(copyPath, { source: "pack", destination: "sub/copy" }, roots())).toContain(
        '"copied":true',
      );
      expect(readFileSync(join(ws, "sub", "copy", ".env"), "utf8")).toBe("chosen\n");
      untouched();
    });
  });

  describe("a tool that keeps its own store in a gate record", () => {
    const TOOLS = [datasetPut, evalBaselinePin, kvSet, checkpointSave, experimentLedger];
    const RULES = allowIn(...TOOLS.map((tool) => tool.name));
    const SAMPLE = { samples: [{ id: "s1", input: "hi" }], split: "train" };
    const PIN = { action: "show", spec: "s", dataset: "d" };
    const KV = { namespace: "n", key: "k", value: "v" };
    const call = (name: string, input: Record<string, unknown>) =>
      turn({ name, input }, TOOLS, RULES, "auto", tempDir("crewhaus-floor-sessions-"), {
        justificationJudge: allowAny,
      });

    test("each still runs at its default, under a tool-wide allow", async () => {
      const dataset = await call("DatasetPut", { ...SAMPLE, name: "qa" });
      expect(floorAnswer(dataset)).toEqual({ decision: "allow", floor: false });
      expect(existsSync(join(ws, ".crewhaus", "datasets", "qa", "v1.json"))).toBe(true);
      const named = await call("DatasetPut", {
        ...SAMPLE,
        name: "named",
        registryDir: ".crewhaus/datasets",
      });
      expect(floorAnswer(named)).toEqual({ decision: "allow", floor: false });
      expect(existsSync(join(ws, ".crewhaus", "datasets", "named", "v1.json"))).toBe(true);
      expect(floorAnswer(await call("EvalBaselinePin", PIN))).toEqual({
        decision: "allow",
        floor: false,
      });
      expect(floorAnswer(await call("KvSet", KV))).toEqual({ decision: "allow", floor: false });
      expect(existsSync(join(ws, ".crewhaus", "state", "kv"))).toBe(true);
      expect(floorAnswer(await call("CheckpointSave", { name: "c", data: { a: 1 } }))).toEqual({
        decision: "allow",
        floor: false,
      });
      expect(
        floorAnswer(
          await call("ExperimentLedger", {
            action: "list",
            justification: "list the experiments this harness keeps",
          }),
        ),
      ).toEqual({ decision: "allow", floor: false });
    }, 20_000); // slow by construction: six model turns

    test("in another gate record, or an exact file, each is denied and writes nothing", async () => {
      for (const [name, input] of [
        ["DatasetPut", { ...SAMPLE, name: "qa", registryDir: ".crewhaus/approvals" }],
        ["DatasetPut", { ...SAMPLE, name: "qa", registryDir: ".crewhaus/evals" }],
        ["DatasetPut", { ...SAMPLE, name: "qa", registryDir: ".env" }],
        ["DatasetPut", { ...SAMPLE, name: "qa", registryDir: ".crewhaus/datasets/../graders" }],
        ["EvalBaselinePin", { ...PIN, evalsDir: ".crewhaus/graders" }],
        ["EvalBaselinePin", { ...PIN, evalsDir: ".crewhaus/datasets" }],
        ["KvSet", { ...KV, stateDir: ".crewhaus/graders" }],
        ["KvSet", { ...KV, stateDir: ".crewhaus/datasets" }],
        ["KvSet", { ...KV, stateDir: "bunfig.toml" }],
        ["CheckpointSave", { name: "c", data: { a: 1 }, stateDir: ".crewhaus/approvals" }],
      ] as const) {
        const r = await call(name, input);
        expect({ name, input, ...floorAnswer(r) }).toEqual({ name, input, ...DENIED });
      }
      expect(readdirSync(ws)).toEqual([]);
    }, 20_000); // slow by construction: one model turn for each call

    describe("DatasetPut, checking where the version lands", () => {
      const put_ = (input: Record<string, unknown>): Promise<string> =>
        text(datasetPut, { ...SAMPLE, ...input }, roots());

      test("in its own registry it adds a version, and goes on when `.crewhaus` is an operator's link", async () => {
        expect(await put_({ name: "qa" })).toContain('"wrote":true');
        expect(existsSync(join(ws, ".crewhaus", "datasets", "qa", "v1.json"))).toBe(true);

        const linked = join(base, "linked");
        mkdirSync(join(linked, "data", "crew"), { recursive: true });
        symlinkSync(join("data", "crew"), join(linked, ".crewhaus"));
        process.chdir(linked);
        const out = await text(
          datasetPut,
          { ...SAMPLE, name: "qa" },
          runtimeStateRoots(undefined, undefined, linked, {}),
        );
        expect(out).toContain('"wrote":true');
        expect(existsSync(join(linked, "data", "crew", "datasets", "qa", "v1.json"))).toBe(true);
      });

      test("another root is refused, by the registry it names, its name or a link", async () => {
        put(".crewhaus/graders/keep", "kept\n");
        expect(await put_({ registryDir: ".crewhaus", name: "graders" })).toContain(REFUSED);
        // Named from above, the store is one more root.
        expect(await put_({ registryDir: ".crewhaus", name: "datasets" })).toContain(REFUSED);
        expect(await put_({ registryDir: ".", name: ".env" })).toContain(REFUSED);
        mkdirSync(join(ws, ".crewhaus", "datasets"), { recursive: true });
        symlinkSync(join("..", "graders"), join(ws, ".crewhaus", "datasets", "away"));
        expect(await put_({ name: "away" })).toContain(REFUSED);
        expect(readdirSync(join(ws, ".crewhaus", "graders"))).toEqual(["keep"]);
      });

      test("a link at the store itself into another root is refused, by the floor and the tool", async () => {
        mkdirSync(join(ws, ".crewhaus", "run"), { recursive: true });
        symlinkSync("run", join(ws, ".crewhaus", "datasets"));
        expect(await put_({ name: "qa" })).toContain(REFUSED);
        const r = await call("DatasetPut", { ...SAMPLE, name: "qa" });
        expect(floorAnswer(r)).toEqual(DENIED);
        expect(readdirSync(join(ws, ".crewhaus", "run"))).toEqual([]);
      });
    });
  });

  describe("CrewHaus's own writers still write what the run's roots hold", () => {
    test("appendRetentionPins, the retention file", async () => {
      const path = join(ws, ".crewhaus", "retention.json");
      expect(roots()).toContain(path);
      const id = "sess_0123456789abcdef";
      expect((await appendRetentionPins([id], path, ws)).added).toEqual([id]);
      expect(readFileSync(path, "utf8")).toContain(id);
    });

    test("judge calibrate --apply's writer, the calibration file", () => {
      const path = join(ws, ".crewhaus", "judge-calibration.json");
      expect(roots()).toContain(path);
      writeCalibrationFileAtomic(path, { version: 1, judges: {} } as never);
      expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The two readers of `manager.envFiles`
// ---------------------------------------------------------------------------

describe("the floor's reader of manager.envFiles and the supervisor's say the same", () => {
  const FIXTURES: ReadonlyArray<string | undefined> = [
    undefined,
    "{not json",
    "null",
    "[]",
    "3",
    "{}",
    '{"manager":null}',
    '{"manager":[]}',
    '{"manager":{}}',
    '{"manager":{"envFiles":"a.env"}}',
    '{"manager":{"envFiles":{"0":"a.env"}}}',
    '{"manager":{"envFiles":[]}}',
    '{"manager":{"envFiles":["a.env"]}}',
    '{"manager":{"envFiles":["../.env","sub/b.env"," c.env ","","   ",3,null,{}]}}',
    '{"manager":{"envFiles":[".",".."]},"permissions":{"rules":[]}}',
    '{"manager":{"envFiles":["/abs/shared.env"],"autoCompile":true}}',
  ];
  const seen = FIXTURES.map((body) => {
    const dir = tempDir("crewhaus-floor-parity-");
    if (body !== undefined) {
      mkdirSync(join(dir, ".crewhaus"));
      writeFileSync(join(dir, ".crewhaus", "settings.json"), body);
    }
    return {
      body,
      floor: declaredEnvFiles(dir),
      supervisor: readManagerSettings(dir).envFiles.map((entry) => resolve(dir, entry)),
    };
  });

  test("over every fixture", () => {
    for (const row of seen) expect(row.floor).toEqual(row.supervisor);
  });

  test("the table has fixtures with entries, so the comparison compares something", () => {
    expect(seen.filter((row) => row.floor.length > 0).length).toBe(4);
    expect(Math.max(...seen.map((row) => row.floor.length))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// A managed run's tenants root
// ---------------------------------------------------------------------------

describe("a tool whose text reads like one of these names", () => {
  let saved: string | undefined;
  beforeEach(() => {
    originalCwd = process.cwd();
    saved = process.env["CREWHAUS_HANGAR_ROOT"];
    base = tempDir("crewhaus-floor-text-");
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
  const asRun = (tool: RegisteredTool): RegisteredTool => ({
    ...tool,
    execute: async () => `${tool.name} ran`,
  });
  const toolsHere = (): RegisteredTool[] => {
    const driver = {} as never;
    const state = join(ws, ".crewhaus", "state");
    const memory = createMemoryTools({ specName: "floor", rootDir: join(ws, "memories") });
    const plan = createPlanTools({ specName: "floor", rootDir: state, appendEvent: () => {} });
    return [
      memory.remember,
      memory.forget,
      ...plan.all,
      todoWrite,
      clipboardWrite,
      desktopNotify,
      imageGenerate,
      createTaskTool(),
      ...createWikiTools({ specName: "floor", rootDir: join(ws, "wiki") }).all,
      ...Object.values(createAllMouseKeyboardTools({ driver })),
    ].map((tool) => (RUN_FOR_REAL.has(tool.name) ? tool : asRun(tool)));
  };
  /** These run for real, so a test sees that nothing lands in the file its text names. */
  const RUN_FOR_REAL = new Set(["Remember", "TodoWrite", "FocusWrite", "PlanUpdate", "GoalWrite"]);
  const TEXT_CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["Remember", { text: ".env: the project keeps the deploy region here" }],
    ["Remember", { text: "note", tags: [".env"] }],
    ["Remember", { text: ".env" }],
    ["MemoryForget", { query: "bunfig.toml: set the test timeout" }],
    ["MemoryClear", { scope: "focus" }],
    ["FocusWrite", { focus: ".npmrc: pin the registry, then run the build" }],
    ["PlanUpdate", { action: "create", title: "bunfig.toml: set the timeout" }],
    ["PlanUpdate", { action: "create", title: ".env", steps: [".npmrc", "bunfig.toml"] }],
    ["PlanComplete", { step: 1, evidence: [{ toolUseId: ".env" }] }],
    ["GoalWrite", { title: ".env: move the deploy region", unit: ".npmrc" }],
    ["GoalUpdate", { goalId: "goal-0001", title: "bunfig.toml" }],
    [
      "TodoWrite",
      {
        todos: [
          {
            id: ".env",
            content: "bunfig.toml: set the test timeout",
            status: "pending",
            priority: "low",
          },
        ],
      },
    ],
    ["ClipboardWrite", { text: ".env" }],
    ["DesktopNotify", { title: ".npmrc", body: "bunfig.toml: updated" }],
    ["ImageGenerate", { prompt: "bunfig.toml: a diagram" }],
    ["Task", { description: "bunfig.toml: set the timeout", prompt: ".env" }],
    ["wiki_write", { slug: "npmrc", title: ".npmrc", body: ".env" }],
    ["wiki_set_signals", { slug: ".env" }],
    ["log_knowledge_gap", { topic: ".npmrc", detail: ".env: where it lives", tags: [".env"] }],
    ["Type", { text: ".env" }],
  ];

  test("a tool that declares no place is allowed, under an allow rule and in auto, with such text", async () => {
    const tools = toolsHere();
    const rules = allowIn(...tools.map((tool) => tool.name));
    expect(TEXT_CALLS.length).toBeGreaterThanOrEqual(20);
    for (const [name, input] of TEXT_CALLS) {
      const r = await turn({ name, input }, tools, rules, "auto");
      expect({ name, input, decision: r.decision, reason: r.reason }).toEqual({
        name,
        input,
        decision: "allow",
        reason: undefined,
      });
    }
    for (const rel of [".env", "bunfig.toml", ".npmrc"]) {
      expect({ rel, there: existsSync(join(ws, rel)) }).toEqual({ rel, there: false });
    }
    // The run did what its text asked, in its own stores.
    expect(readdirSync(join(ws, "memories")).length).toBeGreaterThan(0);
    expect(getCurrentTodos().map((todo) => todo.id)).toEqual([".env"]);
  }, 30_000); // slow by construction: one model turn for each call

  test("every builtin writer that declares no place is on the reviewed list", () => {
    const listed = Object.values(TOOL_REGISTRY)
      .filter((entry) => !entry.readOnly && entry.operativeArgs?.length === 0)
      .map((entry) => entry.name)
      .sort();
    expect(listed).toEqual([
      "BashOutput",
      "ClipboardWrite",
      "DesktopNotify",
      "ImageGenerate",
      "KillShell",
      "PowerAssertion",
      "ProcessOutput",
      "ProcessStop",
      "TodoWrite",
    ]);
  });

  test("a tool that declares no fields, as an MCP tool does, has its strings read as paths", async () => {
    const { remember } = createMemoryTools({ specName: "floor", rootDir: join(ws, "memories") });
    const { operativeArgs: _declared, ...undeclared } = remember;
    const remote: RegisteredTool = {
      ...undeclared,
      name: "get_file_contents",
      execute: async () => "ran",
    };
    const rules = allowIn(remote.name);
    for (const input of [{ text: ".npmrc" }, { text: ".env: a note" }]) {
      const r = await turn({ name: remote.name, input }, [remote], rules, "auto");
      expect({ input, decision: r.decision, floor: r.reason?.includes(FLOOR) === true }).toEqual({
        input,
        decision: "deny",
        floor: true,
      });
    }
    // A sentence that names one mid-way is no path into it.
    const mid = await turn(
      { name: remote.name, input: { text: "the project keeps its region in .env" } },
      [remote],
      rules,
      "auto",
    );
    expect(mid.decision).toBe("allow");
  });
});

describe("SpecPin and DeployRollback, where a spec lands", () => {
  const roots = (): string[] => runtimeStateRoots(undefined, undefined, ws, {});
  const judge: JustificationJudge = () => ({
    allow: true,
    reason: "permitted for this test",
    judgeModel: "test",
  });
  const RULES = allowIn("SpecPin", "DeployRollback");
  const ROLLBACK = { env: "prod", toVersion: "v1", dryRun: false };
  beforeEach(() => {
    originalCwd = process.cwd();
    base = tempDir("crewhaus-floor-registry-");
    ws = join(base, "harness");
    mkdirSync(join(ws, ".crewhaus"), { recursive: true });
    writeFileSync(join(ws, "x.yaml"), "name: x\n");
    process.chdir(ws);
  });
  afterEach(() => process.chdir(originalCwd));

  // A registry and a spec name that together name a root.
  const LANDS: ReadonlyArray<readonly [string, string]> = [
    [".crewhaus", "graders"],
    [".crewhaus", "approvals"],
    [".crewhaus", "evals"],
    [".crewhaus", "audit"],
    [".crewhaus", "datasets"],
    [".crewhaus", "graphs"],
    [".crewhaus", "advice"],
    [".crewhaus", "run"],
    [".crewhaus", "sessions"],
    [".crewhaus", "retention.json"],
    [".crewhaus", "environments.json"],
    [".crewhaus", "judge-calibration.json"],
    [".crewhaus", "settings.json"],
    [".", "bunfig.toml"],
  ];

  test("a registry above a root is refused, and nothing lands there", async () => {
    for (const [registryDir, name] of LANDS) {
      const input = { name, registryDir };
      const pin = await text(specPin, { ...input, specFile: "x.yaml", env: "prod" }, roots());
      expect({ input, refused: pin.includes(REFUSED) }).toEqual({ input, refused: true });
      const back = await text(deployRollback, { ...input, ...ROLLBACK }, roots());
      expect({ input, refused: back.includes(REFUSED) }).toEqual({ input, refused: true });
      const landed = join(ws, registryDir, name);
      expect({ landed, there: existsSync(landed) }).toEqual({ landed, there: false });
    }
  });

  test("through the run, the tool refuses a registry and a name that together name a root", async () => {
    const r = await turn(
      {
        name: "SpecPin",
        input: {
          name: "graders",
          registryDir: ".crewhaus",
          specFile: "x.yaml",
          env: "prod",
          justification: "pin the spec for this test",
        },
      },
      [specPin, deployRollback],
      RULES,
      "auto",
      undefined,
      { justificationJudge: judge },
    );
    expect(r.decision).toBe("allow");
    expect(r.result).toContain(REFUSED);
    expect(existsSync(join(ws, ".crewhaus", "graders"))).toBe(false);
  });

  test("its default registry, and one elsewhere, go on working", async () => {
    for (const input of [{ name: "graders" }, { name: "spec", registryDir: "my/specs" }]) {
      const out = await text(specPin, { ...input, specFile: "x.yaml", env: "prod" }, roots());
      expect({ input, status: JSON.parse(out).status }).toEqual({ input, status: "pinned" });
    }
    expect(existsSync(join(ws, ".crewhaus", "specs", "graders", "manifest.json"))).toBe(true);
    expect(existsSync(join(ws, "my", "specs", "spec", "manifest.json"))).toBe(true);
    const back = await text(deployRollback, { name: "graders", ...ROLLBACK }, roots());
    expect(back).not.toContain(REFUSED);
  });
});

describe("a record whose path resolves through a link into a root", () => {
  let saved: string | undefined;
  const roots = (): string[] => runtimeStateRoots(undefined, undefined, ws, {});
  const AUDIT = ".crewhaus/audit/x.jsonl";
  beforeEach(() => {
    originalCwd = process.cwd();
    saved = process.env["CREWHAUS_HANGAR_ROOT"];
    base = tempDir("crewhaus-floor-linked-");
    ws = join(base, "harness");
    seedHarness(ws);
    process.env["CREWHAUS_HANGAR_ROOT"] = join(ws, "home");
    put(".env", "KEPT=1\n");
    put(AUDIT, "kept\n");
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    if (saved === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_HANGAR_ROOT");
    else process.env["CREWHAUS_HANGAR_ROOT"] = saved;
  });
  const bytes = (): Record<string, string> => ({
    env: readFileSync(join(ws, ".env"), "utf8"),
    audit: readFileSync(join(ws, AUDIT), "utf8"),
  });
  const KEPT = { env: "KEPT=1\n", audit: "kept\n" };
  /** A link in the workspace, unpacked from an archive. */
  const plant = async (name: string, linkTarget: string): Promise<void> => {
    writeFileSync(join(ws, "plant.tar"), buildTar([{ name, kind: "symlink", linkTarget }]));
    await text(
      archiveExtract,
      { archive: "plant.tar", destination: ".", overwrite: true },
      roots(),
    );
    expect(lstatSync(join(ws, name)).isSymbolicLink()).toBe(true);
  };

  test("JournalAppend through a link at its log leaves the file as it was", async () => {
    await plant("journal/s.jsonl", "../.env");
    const out = await text(journalAppend, { stream: "s", entry: { a: 1 }, stateDir: "." }, roots());
    expect(out).toContain(REFUSED);
    expect(bytes()).toEqual(KEPT);
  });

  test("BlackboardPost through a link at its log leaves the file as it was", async () => {
    await plant("blackboard/t.jsonl", `../${AUDIT}`);
    const out = await text(
      blackboardPost,
      { topic: "t", author: "a", text: "x", stateDir: "." },
      roots(),
    );
    expect(out).toContain(REFUSED);
    expect(bytes()).toEqual(KEPT);
  });

  test("through the run, the tool refuses where the log resolves", async () => {
    await plant("journal/s.jsonl", "../.env");
    const r = await turn(
      { name: "JournalAppend", input: { stream: "s", entry: { a: 1 }, stateDir: "." } },
      [journalAppend],
      allowIn("JournalAppend"),
      "auto",
    );
    expect(r.decision).toBe("allow");
    expect(r.result).toContain(REFUSED);
    expect(bytes()).toEqual(KEPT);
  });

  test("a store whose directory is a link into a root writes nothing there", async () => {
    await plant("kv", ".crewhaus/audit");
    await plant("checkpoints", ".crewhaus/audit");
    await plant("notes", ".crewhaus/audit");
    await plant("counters", ".crewhaus/audit");
    await plant("dedupe", ".crewhaus/audit");
    for (const [tool, input] of [
      [kvSet, { namespace: "n", key: "k", value: "v" }],
      [checkpointSave, { name: "c", data: { a: 1 } }],
      [noteWrite, { id: "n1", text: "x" }],
      [counterIncrement, { name: "c" }],
      [dedupeMark, { scope: "s", id: "x" }],
    ] as const) {
      const out = await text(tool, { ...input, stateDir: "." }, roots());
      expect({ tool: tool.name, refused: out.includes(REFUSED) }).toEqual({
        tool: tool.name,
        refused: true,
      });
    }
    expect(readdirSync(join(ws, ".crewhaus", "audit"))).toEqual(["x.jsonl"]);
  });

  test("ExperimentLedger through a linked directory or a linked ledger leaves the file as it was", async () => {
    const RECORD_IT = {
      action: "record",
      name: "x",
      version: "v1",
      outcome: "success",
      dryRun: false,
    };
    mkdirSync(join(ws, "other", ".crewhaus"), { recursive: true });
    await plant("other/.crewhaus/experiments", "../../.crewhaus/audit");
    const out = await text(experimentLedger, { ...RECORD_IT, dir: "other" }, roots());
    expect(out).toContain(REFUSED);
    await plant("mine/x.jsonl", "../.env");
    const leaf = await text(experimentLedger, { ...RECORD_IT, experimentsDir: "mine" }, roots());
    expect(leaf).toContain(REFUSED);
    const preview = await text(
      experimentLedger,
      { ...RECORD_IT, experimentsDir: "mine", dryRun: true },
      roots(),
    );
    expect(preview).toContain(REFUSED);
    expect(bytes()).toEqual(KEPT);
  });

  test("the same calls with no link write in their own stores", async () => {
    const journal = await text(journalAppend, { stream: "s", entry: { a: 1 } }, roots());
    expect(JSON.parse(journal).seq).toBe(1);
    const kv = await text(kvSet, { namespace: "n", key: "k", value: "v", stateDir: "." }, roots());
    expect(kv).not.toContain(REFUSED);
    expect(existsSync(join(ws, "kv"))).toBe(true);
    const ledger = await text(
      experimentLedger,
      { action: "record", name: "x", version: "v1", outcome: "success", dryRun: false },
      roots(),
    );
    expect(JSON.parse(ledger).status).toBe("ok");
    expect(bytes()).toEqual(KEPT);
  });
});

describe("a tool's store named in the run's record", () => {
  const STORES = [kvSet, checkpointSave, journalAppend, blackboardPost, datasetPut, emitTraceEvent];
  const RULES = allowIn(...STORES.map((tool) => tool.name));
  const floorAnswer = (r: { decision?: string; reason?: string }) => ({
    decision: r.decision,
    floor: r.reason?.includes(FLOOR) === true,
  });
  beforeEach(() => {
    originalCwd = process.cwd();
    base = tempDir("crewhaus-floor-record-");
    ws = join(base, "harness");
    mkdirSync(ws, { recursive: true });
    process.chdir(ws);
  });
  afterEach(() => process.chdir(originalCwd));

  for (const stateDir of [".crewhaus/sessions", ".crewhaus/tool-results", ".crewhaus/proofs"]) {
    test(`${stateDir}: a store that is not a log is the floor's, and nothing lands`, async () => {
      for (const [name, input] of [
        ["KvSet", { namespace: "n", key: "k", value: "v", stateDir }],
        ["CheckpointSave", { name: "c", data: { a: 1 }, stateDir }],
        ["JournalAppend", { stream: "s", entry: { a: 1 }, stateDir }],
        ["BlackboardPost", { topic: "t", author: "a", text: "x", stateDir }],
        [
          "DatasetPut",
          { samples: [{ id: "s", input: "i" }], split: "train", name: "d", registryDir: stateDir },
        ],
      ] as const) {
        const r = await turn({ name, input }, STORES, RULES, "auto", null);
        expect({ name, ...floorAnswer(r) }).toEqual({ name, decision: "deny", floor: true });
      }
      // The run's own session logs are the only thing there.
      const landed = Object.keys(filesUnder(join(ws, stateDir)));
      expect(landed.filter((name) => !name.startsWith("sess_"))).toEqual([]);
    });
  }

  test("a log still goes in the record, at the default and named", async () => {
    for (const input of [{}, { dir: ".crewhaus/sessions" }]) {
      const r = await turn(
        { name: "EmitTraceEvent", input: { name: "x", sessionId: "s", create: true, ...input } },
        STORES,
        RULES,
        "auto",
        null,
      );
      expect({ input, decision: r.decision }).toEqual({ input, decision: "allow" });
    }
  });
});

describe("a managed run's tenants root, under a tenant", () => {
  const WRITE_ALL = allowIn("Write", "KvSet", "EmitTraceEvent");
  const TOOLS = [write, kvSet, emitTraceEvent];
  const floorAnswer = (r: { decision?: string; reason?: string }) => ({
    decision: r.decision,
    floor: r.reason?.includes(FLOOR) === true,
  });
  beforeEach(() => {
    originalCwd = process.cwd();
    base = tempDir("crewhaus-floor-tenants-");
    ws = join(base, "harness");
    mkdirSync(ws, { recursive: true });
    process.chdir(ws);
  });
  afterEach(() => process.chdir(originalCwd));
  /** One line of a real store, from a directory of its own. */
  const RECORD = { toolName: "ExampleTool", inputHash: "a".repeat(64) };
  const recordLine = async (): Promise<string> => {
    const rootDir = tempDir("crewhaus-floor-grant-");
    const store = createPendingApprovalStore({ rootDir });
    const id = "appr_0123456789abcdef";
    await store.persist({
      id,
      ...RECORD,
      runId: "run_a",
      sessionId: "sess_0123456789abcdef",
      surface: "daemon",
      createdAt: new Date().toISOString(),
    });
    await store.resolve(id, "grant", "human");
    expect((await store.get(RECORD.toolName, RECORD.inputHash))?.decision).toBe("grant");
    return readFileSync(join(rootDir, "approvals.jsonl"), "utf8");
  };

  for (const rel of [".crewhaus/tenants", "live/tenants"]) {
    describe(rel, () => {
      const tenantsRoot = (): string => join(ws, rel);
      const inTenantA = <T>(body: () => Promise<T>): Promise<T> =>
        withTenant(buildTenant("tenant-a", { tenantsRoot: tenantsRoot() }), body) as Promise<T>;

      test("the other tenant's part of the root is denied, and its store finds nothing", async () => {
        const path = `${rel}/tenant-b/sessions/approvals.jsonl`;
        const content = await recordLine();
        const r = await inTenantA(() =>
          turn({ name: "Write", input: { path, content } }, TOOLS, WRITE_ALL, "auto", null),
        );
        expect(floorAnswer(r)).toEqual({ decision: "deny", floor: true });
        expect(existsSync(join(ws, path))).toBe(false);
        const b = buildTenant("tenant-b", { tenantsRoot: tenantsRoot() });
        const store = createPendingApprovalStore({ rootDir: b.sessionRoot });
        expect(await store.get(RECORD.toolName, RECORD.inputHash)).toBe(null);
      });

      test("this tenant's own part of the root is denied to a tool too", async () => {
        const path = `${rel}/tenant-a/sessions/approvals.jsonl`;
        const r = await inTenantA(() =>
          turn({ name: "Write", input: { path, content: "x" } }, TOOLS, WRITE_ALL, "auto", null),
        );
        expect(floorAnswer(r)).toEqual({ decision: "deny", floor: true });
        expect(existsSync(join(ws, path))).toBe(false);
        // The whole root holds, so a log named there is the floor's as well.
        const log = await inTenantA(() =>
          turn(
            {
              name: "EmitTraceEvent",
              input: { name: "x", dir: `${rel}/tenant-a/sessions`, sessionId: "s", create: true },
            },
            TOOLS,
            WRITE_ALL,
            "auto",
            null,
          ),
        );
        expect(floorAnswer(log)).toEqual({ decision: "deny", floor: true });
      });

      test("a tool's store and a log named in the other tenant's part are denied", async () => {
        for (const [name, input] of [
          ["KvSet", { namespace: "n", key: "k", value: "v", stateDir: `${rel}/tenant-b/state` }],
          [
            "EmitTraceEvent",
            { name: "x", dir: `${rel}/tenant-b/sessions`, sessionId: "s", create: true },
          ],
        ] as const) {
          const r = await inTenantA(() => turn({ name, input }, TOOLS, WRITE_ALL, "auto", null));
          expect({ name, ...floorAnswer(r) }).toEqual({ name, decision: "deny", floor: true });
        }
        expect(existsSync(join(ws, rel, "tenant-b"))).toBe(false);
      });

      test("KvSet at its default goes through the floor and writes in the working directory", async () => {
        const r = await inTenantA(() =>
          turn(
            { name: "KvSet", input: { namespace: "n", key: "k", value: "v" } },
            TOOLS,
            WRITE_ALL,
            "auto",
            null,
          ),
        );
        expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
        expect(existsSync(join(ws, ".crewhaus", "state", "kv"))).toBe(true);
      });

      test("this tenant's plan and memory stores, and its session log, still write", async () => {
        const tenant = buildTenant("tenant-a", { tenantsRoot: tenantsRoot() });
        await inTenantA(async () => {
          const continuity = createContinuityStore({ specName: "spec", tenant });
          const plan = await continuity.createPlan({ title: "ship", steps: ["one"] });
          expect((await continuity.getPlan(plan.id))?.title).toBe("ship");
          const wiki = createWikiStore({ specName: "spec", tenant });
          const page = await wiki.write({ slug: "notes", title: "Notes", body: "kept" });
          expect(page.version).toBe(1);
        });
        const roots = runtimeStateRoots(tenant.sessionRoot, tenant, ws, {});
        expect(roots).toContain(tenantsRoot());
        expect(existsSync(join(tenantsRoot(), "tenant-a", "state"))).toBe(true);
        expect(existsSync(join(tenantsRoot(), "tenant-a", "wiki"))).toBe(true);
        // The run itself keeps its log where the floor keeps tools out.
        const r = await inTenantA(() =>
          turn(
            { name: "Write", input: { path: "notes.md", content: "kept" } },
            TOOLS,
            WRITE_ALL,
            "auto",
            null,
          ),
        );
        expect(r.decision).toBe("allow");
        expect(
          readdirSync(join(tenantsRoot(), "tenant-a", "sessions")).some((name) =>
            name.endsWith(".jsonl"),
          ),
        ).toBe(true);
      });
    });
  }
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

// ---------------------------------------------------------------------------
// What a harness's next start runs, in its own directory
// ---------------------------------------------------------------------------

describe("what a harness's next start runs, in its own directory", () => {
  /** A provider key's shape, built from parts so no real-looking value is ever written whole. */
  const FIXTURE_KEY = ["sk", "fixture", "0".repeat(12)].join("-");
  const SPEC = "name: h\ntarget: channel\n";
  const ORIGINAL = 'console.log("ORIGINAL BUNDLE");\n';
  const EDITED = 'console.log("EDITED BUNDLE");\n';
  const MANIFEST = JSON.stringify({ name: BUNDLE_MANIFEST_NAME });
  /** Every Write the run asks for: the yaml layer's broad rule, read in default mode. */
  const WRITE_ALL: RuleSet = {
    ...emptyRuleSet,
    yaml: [{ type: "alwaysAllow", pattern: "Write(**)", source: "yaml" }],
  };
  const EDIT_ALL: RuleSet = {
    ...emptyRuleSet,
    yaml: [{ type: "alwaysAllow", pattern: "Edit(**)", source: "yaml" }],
  };
  const floorAnswer = (r: { decision?: string; reason?: string }) => ({
    decision: r.decision,
    floor: r.reason?.includes(FLOOR) === true,
  });
  const DENIED = { decision: "deny", floor: true };
  const writeTo = (path: string, content = "chosen\n") =>
    turn({ name: "Write", input: { path, content } }, [write], WRITE_ALL, "default");

  const bun = Bun as unknown as { main: string };
  const savedMain = bun.main;
  /** The process's entry, as it is in the flow a test is about. */
  const startedFrom = (rel: string): void => {
    bun.main = join(ws, rel);
  };

  /** A harness with a compiled bundle in `dist`, its `.env` and its project files. */
  function seedCompiled(spec: string | null = SPEC): void {
    base = tempDir("crewhaus-floor-compiled-");
    ws = join(base, "harness");
    mkdirSync(ws, { recursive: true });
    if (spec !== null) put("crewhaus.yaml", spec);
    put(".env", `PROVIDER_KEY=${FIXTURE_KEY}\n`);
    put("dist/daemon.ts", ORIGINAL);
    put("dist/package.json", MANIFEST);
    put("package.json", '{"name":"proj"}\n');
    put("tsconfig.json", '{"compilerOptions":{}}\n');
    process.chdir(ws);
  }
  beforeEach(() => {
    originalCwd = process.cwd();
  });
  afterEach(() => {
    bun.main = savedMain;
    process.chdir(originalCwd);
  });

  /** The next supervised start, through the real plan: what it prints. */
  function nextStart(): string {
    const plan = buildSpawnPlan({
      harnessDir: ws,
      target: "channel",
      processEnv: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
      crewhausBin: undefined,
    });
    const ran = Bun.spawnSync([...plan.argv], {
      cwd: plan.cwd,
      env: plan.env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    return `${ran.stdout.toString()}${ran.stderr.toString()}`.trim();
  }

  test("the name a run looks for is the one compile stamps and the supervisor reads", () => {
    expect(COMPILED_BUNDLE_NAME).toBe(BUNDLE_MANIFEST_NAME);
    expect(COMPILED_BUNDLE_NAME).toBe(CLI_BUNDLE_MANIFEST_NAME);
  });

  test("the spec names a run looks for are the ones the supervisor finds", () => {
    const cwd = tempDir("crewhaus-floor-spec-names-");
    const entry = join(cwd, "dist", "daemon.ts");
    mkdirSync(dirname(entry));
    writeFileSync(entry, "");
    writeFileSync(join(cwd, SPEC_FILENAMES[0]), SPEC);
    const roots = runtimeStateRoots(undefined, undefined, cwd, {}, entry);
    expect(SPEC_FILENAMES.length).toBeGreaterThan(0);
    for (const name of SPEC_FILENAMES) {
      expect({ name, held: roots.includes(name) }).toEqual({ name, held: true });
    }
    for (const name of SPEC_FILENAMES) {
      const one = tempDir("crewhaus-floor-spec-name-");
      writeFileSync(join(one, name), SPEC);
      expect(findSpecPath(one)).toBe(join(one, name));
      const trees = runtimeStateRoots(undefined, undefined, one, {}, "/opt/elsewhere/agent.ts");
      expect({ name, held: trees.includes("dist") }).toEqual({ name, held: true });
    }
  });

  test("the bundle directories a start looks in are held", () => {
    const cwd = tempDir("crewhaus-floor-bundle-dirs-");
    writeFileSync(join(cwd, "crewhaus.yaml"), SPEC);
    const roots = runtimeStateRoots(undefined, undefined, cwd, {}, "/opt/elsewhere/agent.ts");
    const dirs = BUNDLE_DIR_CANDIDATES.filter((dir) => dir !== ".");
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      expect({ dir, held: roots.includes(dir) }).toEqual({ dir, held: true });
    }
  });

  describe("under a spec, through the run, whatever the process's entry", () => {
    beforeEach(() => seedCompiled());

    for (const path of [
      "dist/daemon.ts",
      "dist/package.json",
      "dist/.npmrc",
      "dist/bunfig.toml",
      "dist/tsconfig.json",
      "dist/node_modules/x/i.ts",
      "build/daemon.ts",
      "node_modules/.bin/crewhaus",
      "node_modules/crewhaus/src/index.ts",
    ]) {
      test(`Write ${path}: denied, and nothing changes`, async () => {
        const before = filesUnder(ws);
        expect(floorAnswer(await writeTo(path))).toEqual(DENIED);
        expect(filesUnder(ws)).toEqual(before);
      });
    }

    for (const path of [
      "package.json",
      "tsconfig.json",
      "crewhaus.yaml",
      "src/x.ts",
      "run.sh",
      "other/dist/daemon.ts",
      "other/bunfig.toml",
      "daemon.ts",
    ]) {
      test(`Write ${path}: a rule decides, and it is written`, async () => {
        const r = await writeTo(path);
        expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
        expect(readFileSync(join(ws, path), "utf8")).toBe("chosen\n");
      });
    }

    test("RemovePath of a tree, and an MCP tool's call with a word for a label", async () => {
      const r = await turn(
        { name: "RemovePath", input: { path: "node_modules", recursive: true } },
        [removePath],
        allowIn("RemovePath"),
        "auto",
      );
      expect(floorAnswer(r)).toEqual(DENIED);
      const { remember } = createMemoryTools({ specName: "floor", rootDir: join(ws, "memories") });
      const { operativeArgs: _declared, ...undeclared } = remember;
      const remote: RegisteredTool = {
        ...undeclared,
        name: "add_labels",
        execute: async () => "ran",
      };
      const rules = allowIn(remote.name);
      for (const text of [
        "build",
        "dist",
        "build/fix-ci",
        "Node_Modules",
        "package.json",
        "tsconfig.json",
        "jsconfig.json",
      ]) {
        const labelled = await turn(
          { name: remote.name, input: { text } },
          [remote],
          rules,
          "auto",
        );
        expect({ text, ...floorAnswer(labelled) }).toEqual({
          text,
          decision: "allow",
          floor: false,
        });
      }
      const named = await turn(
        { name: remote.name, input: { text: join(ws, "dist", "daemon.ts") } },
        [remote],
        rules,
        "auto",
      );
      expect(floorAnswer(named)).toEqual(DENIED);
    });
  });

  describe("a project with no spec keeps its directories", () => {
    beforeEach(() => seedCompiled(null));

    for (const path of ["dist/x", "build/x", "node_modules/x/i.ts"]) {
      test(`Write ${path}: a rule decides, and it is written`, async () => {
        const r = await writeTo(path);
        expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
        expect(readFileSync(join(ws, path), "utf8")).toBe("chosen\n");
      });
    }

    test("the start config there still holds", async () => {
      expect(floorAnswer(await writeTo("bunfig.toml"))).toEqual(DENIED);
      expect(existsSync(join(ws, "bunfig.toml"))).toBe(false);
    });

    (IGNORES_CASE ? test : test.skip)(
      "and by another case of its name, on a volume that folds them",
      async () => {
        expect(floorAnswer(await writeTo("BUNFIG.TOML"))).toEqual(DENIED);
        expect(readdirSync(ws).filter((name) => name.toLowerCase() === "bunfig.toml")).toEqual([]);
      },
    );
  });

  describe("a compiled bundle running from its harness's directory", () => {
    for (const path of ["package.json", "tsconfig.json", "jsconfig.json", "crewhaus.yaml"]) {
      test(`non-interactive: Write ${path} is denied, and the file is as it was`, async () => {
        seedCompiled();
        startedFrom("dist/daemon.ts");
        const before = filesUnder(ws);
        expect(floorAnswer(await writeTo(path))).toEqual(DENIED);
        expect(filesUnder(ws)).toEqual(before);
      });

      test(`\`target: cli\`: Write ${path} is a rule's to decide`, async () => {
        seedCompiled("name: h\ntarget: cli\n");
        startedFrom("dist/agent.ts");
        put("dist/agent.ts", ORIGINAL);
        const r = await writeTo(path);
        expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
        expect(readFileSync(join(ws, path), "utf8")).toBe("chosen\n");
      });
    }

    test("non-interactive: the other spec name is held too, and a project file beside them is not", async () => {
      seedCompiled();
      startedFrom("dist/daemon.ts");
      expect(floorAnswer(await writeTo("crewhaus.yml"))).toEqual(DENIED);
      expect(existsSync(join(ws, "crewhaus.yml"))).toBe(false);
      const r = await writeTo("src/x.ts");
      expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
    });
  });

  describe("a bundle started from inside its own directory", () => {
    const seedInside = (manifest: string = MANIFEST): void => {
      base = tempDir("crewhaus-floor-inside-");
      ws = join(base, "dist");
      mkdirSync(ws, { recursive: true });
      put("daemon.ts", ORIGINAL);
      put("agent.ts", "export {};\n");
      put("package.json", manifest);
      put("node_modules/x/i.ts", "export {};\n");
      put("README.md", "# bundle\n");
      process.chdir(ws);
      startedFrom("daemon.ts");
    };

    for (const path of [
      "daemon.ts",
      "agent.ts",
      "package.json",
      "node_modules/x/i.ts",
      "tsconfig.json",
      "jsconfig.json",
    ]) {
      test(`Write ${path}: denied, and nothing changes`, async () => {
        seedInside();
        const before = filesUnder(ws);
        expect(floorAnswer(await writeTo(path))).toEqual(DENIED);
        expect(filesUnder(ws)).toEqual(before);
      });

      test(`another project's manifest: Write ${path} is a rule's to decide`, async () => {
        seedInside('{"name":"proj"}\n');
        const r = await writeTo(path);
        expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
        expect(readFileSync(join(ws, path), "utf8")).toBe("chosen\n");
      });
    }

    for (const path of ["README.md", "GOAL.md", "notes.md", "new.ts", "src/added.ts"]) {
      test(`Write ${path}: a rule decides, and it is written`, async () => {
        seedInside();
        const r = await writeTo(path);
        expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
        expect(readFileSync(join(ws, path), "utf8")).toBe("chosen\n");
      });
    }
  });

  describe("the tools that check their own writes, in bypass, with a spec at the working directory", () => {
    const inBypass = (name: string, input: Record<string, unknown>, tools: RegisteredTool[]) =>
      turn({ name, input }, tools, emptyRuleSet, "bypass");
    const refused = (r: { decision?: string; result?: string }) => {
      expect(r.decision).toBe("allow");
      expect(r.result).toContain(REFUSED);
    };
    beforeEach(() => seedCompiled());

    test("CopyPath into `dist/`", async () => {
      put("staged.ts", EDITED);
      const before = filesUnder(join(ws, "dist"));
      refused(
        await inBypass("CopyPath", { source: "staged.ts", destination: "dist/added.ts" }, [
          copyPath,
        ]),
      );
      refused(
        await inBypass(
          "CopyPath",
          { source: "staged.ts", destination: "dist/daemon.ts", overwrite: true },
          [copyPath],
        ),
      );
      expect(filesUnder(join(ws, "dist"))).toEqual(before);
    });

    test("ArchiveExtract of a top-level `dist/`", async () => {
      writeFileSync(join(ws, "a.tar"), buildTar([{ name: "dist/daemon.ts", data: EDITED }]));
      const before = filesUnder(join(ws, "dist"));
      refused(
        await inBypass("ArchiveExtract", { archive: "a.tar", destination: ".", overwrite: true }, [
          archiveExtract,
        ]),
      );
      expect(filesUnder(join(ws, "dist"))).toEqual(before);
    });

    test("RemovePath and MovePath of `dist`", async () => {
      const before = filesUnder(join(ws, "dist"));
      refused(await inBypass("RemovePath", { path: "dist", recursive: true }, [removePath]));
      refused(await inBypass("MovePath", { source: "dist", destination: "old" }, [movePath]));
      expect(filesUnder(join(ws, "dist"))).toEqual(before);
      expect(existsSync(join(ws, "old"))).toBe(false);
    });

    describe("GitApplyPatch", () => {
      let saved: { global: string | undefined; system: string | undefined };
      beforeEach(() => {
        saved = {
          global: process.env["GIT_CONFIG_GLOBAL"],
          system: process.env["GIT_CONFIG_SYSTEM"],
        };
        process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
        process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
        const ran = Bun.spawnSync(["git", "init", "-q", "-b", "main"], {
          cwd: ws,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(ran.exitCode).toBe(0);
      });
      afterEach(() => {
        for (const [name, value] of [
          ["GIT_CONFIG_GLOBAL", saved.global],
          ["GIT_CONFIG_SYSTEM", saved.system],
        ] as const) {
          if (value === undefined) Reflect.deleteProperty(process.env, name);
          else process.env[name] = value;
        }
      });

      const applyRefused = async (diff: string): Promise<void> => {
        const before = filesUnder(join(ws, "dist"));
        const r = await inBypass("GitApplyPatch", { patch: diff, cwd: "." }, [gitApplyPatch]);
        expect(r.decision).toBe("allow");
        const out = JSON.parse(r.result ?? "{}") as { applied?: boolean; reason?: string };
        expect(out.applied).toBe(false);
        expect(out.reason).toContain(REFUSED);
        expect(filesUnder(join(ws, "dist"))).toEqual(before);
      };

      test("touching a file in `dist/`", async () => {
        await applyRefused(
          [
            "diff --git a/dist/daemon.ts b/dist/daemon.ts",
            "--- a/dist/daemon.ts",
            "+++ b/dist/daemon.ts",
            "@@ -1 +1 @@",
            `-${ORIGINAL.trimEnd()}`,
            `+${EDITED.trimEnd()}`,
            "",
          ].join("\n"),
        );
      });

      test("creating a link in `dist/`", async () => {
        await applyRefused(
          [
            "diff --git a/dist/agent.ts b/dist/agent.ts",
            "new file mode 120000",
            "--- /dev/null",
            "+++ b/dist/agent.ts",
            "@@ -0,0 +1 @@",
            "+../src/x.ts",
            "\\ No newline at end of file",
            "",
          ].join("\n"),
        );
        expect(existsSync(join(ws, "dist", "agent.ts"))).toBe(false);
      });
    });
  });

  describe("the next start, through the real plan, after an agent's tools were refused", () => {
    test("control: the bundle's file decides what starts", () => {
      seedCompiled();
      expect(nextStart()).toBe("ORIGINAL BUNDLE");
      put("dist/daemon.ts", EDITED);
      expect(nextStart()).toBe("EDITED BUNDLE");
    }, 20_000); // slow by construction: two child processes

    test("a Write of the bundle's entry: the original starts", async () => {
      seedCompiled();
      const r = await writeTo(
        "dist/daemon.ts",
        'console.log("EDITED BUNDLE " + process.env.PROVIDER_KEY);\n',
      );
      expect(floorAnswer(r)).toEqual(DENIED);
      const started = nextStart();
      expect(started).toBe("ORIGINAL BUNDLE");
      expect(started).not.toContain(FIXTURE_KEY);
    }, 20_000); // slow by construction: a model turn and a child process

    const IMPORTS = [
      'import { x } from "@crewhaus/fixture-module";',
      'console.log("BUNDLE " + x);',
      "",
    ].join("\n");
    const MODULE_FILE = "dist/node_modules/@crewhaus/fixture-module/i.ts";
    const EDITED_MODULE = 'export const x = "EDITED";\n';
    const seedImports = (): void => {
      seedCompiled();
      put("dist/daemon.ts", IMPORTS);
      put(
        "dist/node_modules/@crewhaus/fixture-module/package.json",
        '{"name":"@crewhaus/fixture-module","main":"i.ts","type":"module"}',
      );
      put(MODULE_FILE, 'export const x = "INSTALLED";\n');
    };

    test("control: an installed module's file decides what starts", () => {
      seedImports();
      expect(nextStart()).toBe("BUNDLE INSTALLED");
      put(MODULE_FILE, EDITED_MODULE);
      expect(nextStart()).toBe("BUNDLE EDITED");
    }, 20_000); // slow by construction: two child processes

    test("a Write of an installed module: the installed one starts", async () => {
      seedImports();
      expect(nextStart()).toBe("BUNDLE INSTALLED");
      const r = await writeTo(MODULE_FILE, EDITED_MODULE);
      expect(floorAnswer(r)).toEqual(DENIED);
      expect(nextStart()).toBe("BUNDLE INSTALLED");
    }, 20_000); // slow by construction: a model turn and two child processes

    test("in a compiled daemon, an Edit of the root resolver config: refused, and its bytes unchanged", async () => {
      seedImports();
      startedFrom("dist/daemon.ts");
      const before = readFileSync(join(ws, "tsconfig.json"), "utf8");
      const r = await turn(
        {
          name: "Edit",
          input: {
            path: "tsconfig.json",
            oldString: '{"compilerOptions":{}}',
            newString: '{"compilerOptions":{"strict":true}}',
          },
        },
        [edit],
        EDIT_ALL,
        "default",
      );
      expect(floorAnswer(r)).toEqual(DENIED);
      expect(readFileSync(join(ws, "tsconfig.json"), "utf8")).toBe(before);
    }, 20_000); // slow by construction: a model turn
  });

  describe("a start from inside a bundle whose entry imports a module by its `.js` name", () => {
    /** What `bun daemon.ts` prints from the working directory. */
    const startHere = (): string => {
      const ran = Bun.spawnSync(["bun", "daemon.ts"], {
        cwd: ws,
        env: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
        stdout: "pipe",
        stderr: "pipe",
      });
      return `${ran.stdout.toString()}${ran.stderr.toString()}`.trim();
    };
    const seedLayout = (spec: string | null): void => {
      base = tempDir("crewhaus-floor-imports-");
      ws = join(base, "bundle");
      mkdirSync(ws, { recursive: true });
      if (spec !== null) put("crewhaus.yaml", spec);
      put("package.json", MANIFEST);
      put("daemon.ts", 'import { x } from "./agent.js";\nconsole.log(x);\n');
      put("agent.ts", 'export const x = "ORIGINAL BUNDLE";\n');
      process.chdir(ws);
      startedFrom("daemon.ts");
    };

    for (const [flow, spec] of [
      ["started from inside itself", null],
      ["written at its spec's directory", SPEC],
    ] as const) {
      for (const name of ["agent.js", "agent.js.ts", "agent.js.json", "agent.tsx", "agent.mjs"]) {
        test(`${flow}: Write ${name} is denied, and the original starts`, async () => {
          seedLayout(spec);
          expect(startHere()).toBe("ORIGINAL BUNDLE");
          const body = name.endsWith(".json")
            ? '{"x":"EDITED BUNDLE"}'
            : 'export const x = "EDITED BUNDLE";\n';
          expect(floorAnswer(await writeTo(name, body))).toEqual(DENIED);
          expect(existsSync(join(ws, name))).toBe(false);
          expect(startHere()).toBe("ORIGINAL BUNDLE");
        }, 20_000); // slow by construction: a model turn and two child processes
      }

      for (const name of ["new.ts", "GOAL.md", "notes.md", "state.json", "src/added.ts"]) {
        test(`${flow}: Write ${name} is a rule's to decide`, async () => {
          seedLayout(spec);
          const r = await writeTo(name);
          expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
          expect(readFileSync(join(ws, name), "utf8")).toBe("chosen\n");
        });
      }
    }

    for (const name of ["bun.lock", "bun.lockb", "crewhaus.yaml", "crewhaus.yml"]) {
      test(`started from inside itself: Write ${name} is denied, though none is there yet`, async () => {
        seedLayout(null);
        expect(floorAnswer(await writeTo(name))).toEqual(DENIED);
        expect(existsSync(join(ws, name))).toBe(false);
      });
    }
  });

  describe("a compiled bundle in a directory below, with no spec at the working directory", () => {
    const HEADER = (target: string): string =>
      `// GENERATED\n//\n// Source spec: "h" (target: ${target}, ir version: 1)\n`;

    for (const path of [
      "dist/daemon.ts",
      "dist/x",
      "tsconfig.json",
      "jsconfig.json",
      "package.json",
      "node_modules/x/i.ts",
      "crewhaus.yaml",
      "crewhaus.yml",
    ]) {
      test(`a daemon: Write ${path} is denied, and nothing changes`, async () => {
        seedCompiled(null);
        put("dist/daemon.ts", `${HEADER("channel")}${ORIGINAL}`);
        startedFrom("dist/daemon.ts");
        const before = filesUnder(ws);
        expect(floorAnswer(await writeTo(path))).toEqual(DENIED);
        expect(filesUnder(ws)).toEqual(before);
      });
    }

    test("a daemon: what lies between it and the working directory is held as well", async () => {
      seedCompiled(null);
      put("tools/dist/daemon.ts", ORIGINAL);
      put("tools/dist/package.json", MANIFEST);
      startedFrom("tools/dist/daemon.ts");
      for (const path of [
        "tools/tsconfig.json",
        "tools/package.json",
        "tools/node_modules/x/i.ts",
      ]) {
        expect({ path, ...floorAnswer(await writeTo(path)) }).toEqual({ path, ...DENIED });
      }
    });

    test("a daemon: another file there is a rule's to decide", async () => {
      seedCompiled(null);
      startedFrom("dist/daemon.ts");
      const r = await writeTo("stage/x.ts");
      expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
      expect(readFileSync(join(ws, "stage", "x.ts"), "utf8")).toBe("chosen\n");
    });

    for (const path of ["tsconfig.json", "package.json", "crewhaus.yaml", "node_modules/x/i.ts"]) {
      test(`an interactive target: Write ${path} is a rule's to decide`, async () => {
        seedCompiled(null);
        put("dist/agent.ts", `${HEADER("cli")}${ORIGINAL}`);
        startedFrom("dist/agent.ts");
        const r = await writeTo(path);
        expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
        expect(readFileSync(join(ws, path), "utf8")).toBe("chosen\n");
      });
    }

    test("an interactive target: its own bundle is still held", async () => {
      seedCompiled(null);
      put("dist/agent.ts", `${HEADER("cli")}${ORIGINAL}`);
      startedFrom("dist/agent.ts");
      expect(floorAnswer(await writeTo("dist/x"))).toEqual(DENIED);
    });
  });

  describe("a tool that declares no paths, with what a run really protects", () => {
    /** An MCP-shaped call with one string, under a rule that allows it, through the engine. */
    const decide = (
      path: string,
      roots: readonly string[],
    ): { decision: string; floor: boolean } => {
      const r = evaluateWithReason(
        {
          toolName: "mcp__github__get_file_contents",
          input: { path },
          readOnly: false,
          destructive: false,
        },
        "auto",
        allowIn("mcp__github__get_file_contents"),
        { protectedRoots: roots },
      );
      return { decision: r.decision, floor: r.reason?.includes(FLOOR) === true };
    };
    const ALLOWED = { decision: "allow", floor: false };

    test("a compiled daemon: its manifest and resolver config's names pass, and the rest are read", () => {
      seedCompiled();
      const roots = runtimeStateRoots(undefined, undefined, ws, {}, join(ws, "dist", "daemon.ts"));
      for (const path of ["package.json", "tsconfig.json", "jsconfig.json", "dist/daemon.ts"]) {
        expect({ path, ...decide(path, roots) }).toEqual({ path, ...ALLOWED });
      }
      for (const path of ["crewhaus.yaml", "crewhaus.yml", ".env", "bunfig.toml"]) {
        expect({ path, ...decide(path, roots) }).toEqual({ path, ...DENIED });
      }
      for (const path of [join(ws, "package.json"), join(ws, "dist", "daemon.ts")]) {
        expect({ path, ...decide(path, roots) }).toEqual({ path, ...DENIED });
      }
    });

    test("a bundle started from inside itself: its code's own names are read", () => {
      base = tempDir("crewhaus-floor-inside-text-");
      ws = join(base, "dist");
      mkdirSync(ws, { recursive: true });
      put("daemon.ts", ORIGINAL);
      put("agent.ts", "export {};\n");
      put("package.json", MANIFEST);
      const roots = runtimeStateRoots(undefined, undefined, ws, {}, join(ws, "daemon.ts"));
      for (const path of ["package.json", "tsconfig.json"]) {
        expect({ path, ...decide(path, roots) }).toEqual({ path, ...ALLOWED });
      }
      for (const path of ["agent.ts", "daemon.ts", "agent.js", "crewhaus.yaml"]) {
        expect({ path, ...decide(path, roots) }).toEqual({ path, ...DENIED });
      }
    });

    test("the run's record and Hangar's directory stay read by their relative names", () => {
      seedCompiled(null);
      const roots = runtimeStateRoots(
        "logs/sessions",
        undefined,
        ws,
        { CREWHAUS_HANGAR_ROOT: join(ws, "home") },
        "/opt/elsewhere/agent.ts",
      );
      for (const path of ["logs/sessions/s1.jsonl", "logs/sessions/x", "home/token", "home/x"]) {
        expect({ path, ...decide(path, roots) }).toEqual({ path, ...DENIED });
      }
    });
  });

  describe("CompileBundle on another directory, whose output leads into a root", () => {
    const LINK_AND_SPEC = (): Buffer | Uint8Array =>
      buildTar([
        { name: "other/dist", kind: "symlink", linkTarget: "../dist" },
        { name: "other/crewhaus.yaml", data: "name: other\ntarget: channel\n" },
      ]);

    for (const dryRun of [true, false]) {
      test(`extracted, then compiled with dryRun ${dryRun}: refused, and the bundle is as it was`, async () => {
        seedCompiled();
        startedFrom("dist/daemon.ts");
        writeFileSync(join(ws, "other.tar"), LINK_AND_SPEC());
        const extracted = await turn(
          {
            name: "ArchiveExtract",
            input: { archive: "other.tar", destination: ".", overwrite: true },
          },
          [archiveExtract],
          allowIn("ArchiveExtract"),
          "auto",
        );
        expect(extracted.decision).toBe("allow");
        expect(lstatSync(join(ws, "other", "dist")).isSymbolicLink()).toBe(true);
        const before = filesUnder(join(ws, "dist"));
        const r = await turn(
          {
            name: "CompileBundle",
            input: { dir: "other", target: "channel", dryRun, allowExternalCli: true },
          },
          [compileBundle],
          allowIn("CompileBundle"),
          "auto",
        );
        expect(r.decision).toBe("allow");
        const out = JSON.parse(r.result ?? "{}") as { status?: string; reason?: string };
        expect(out.status).toBe("refused");
        expect(out.reason).toContain(REFUSED);
        expect(filesUnder(join(ws, "dist"))).toEqual(before);
      });
    }

    // The install adds `node_modules` and the lockfile to the output directory,
    // so one that leads to a directory holding roots is refused too.
    for (const dryRun of [true, false]) {
      test(`an output directory that leads to the working directory, compiled with dryRun ${dryRun}: refused, and nothing is added`, async () => {
        seedCompiled();
        writeFileSync(
          join(ws, "up.tar"),
          buildTar([
            { name: "other/dist", kind: "symlink", linkTarget: ".." },
            { name: "other/crewhaus.yaml", data: "name: other\ntarget: channel\n" },
          ]),
        );
        const extracted = await turn(
          {
            name: "ArchiveExtract",
            input: { archive: "up.tar", destination: ".", overwrite: true },
          },
          [archiveExtract],
          allowIn("ArchiveExtract"),
          "auto",
        );
        expect(extracted.decision).toBe("allow");
        expect(lstatSync(join(ws, "other", "dist")).isSymbolicLink()).toBe(true);
        const before = readdirSync(ws).sort();
        const r = await turn(
          {
            name: "CompileBundle",
            input: { dir: "other", target: "channel", dryRun, allowExternalCli: true },
          },
          [compileBundle],
          allowIn("CompileBundle"),
          "auto",
        );
        expect(r.decision).toBe("allow");
        const out = JSON.parse(r.result ?? "{}") as { status?: string; reason?: string };
        expect(out.status).toBe("refused");
        expect(out.reason).toContain(REFUSED);
        expect(readdirSync(ws).sort()).toEqual(before);
      });
    }
  });

  describe("a real process, started as each flow starts it, answers for itself", () => {
    const STATE_ROOTS = join(ROOT, "packages", "runtime-core", "src", "state-roots.ts");
    const REPORT = [
      `import { runtimeStateRoots } from ${JSON.stringify(STATE_ROOTS)};`,
      "console.log(JSON.stringify(runtimeStateRoots(undefined, undefined)));",
      "",
    ].join("\n");
    /** The roots a process reports for itself, started as `bun <entry>` from `cwd`. */
    const reported = (cwd: string, entry: string): string[] => {
      const ran = Bun.spawnSync(["bun", entry], { cwd, stdout: "pipe", stderr: "pipe" });
      expect(ran.stderr.toString()).toBe("");
      expect(ran.exitCode).toBe(0);
      return JSON.parse(ran.stdout.toString()) as string[];
    };

    test("a supervised daemon holds its spec and its manifest", () => {
      seedCompiled();
      put("dist/daemon.ts", REPORT);
      const roots = reported(ws, join("dist", "daemon.ts"));
      for (const name of [
        "dist",
        "node_modules",
        "crewhaus.yaml",
        "package.json",
        "tsconfig.json",
      ]) {
        expect({ name, held: roots.includes(name) }).toEqual({ name, held: true });
      }
    }, 20_000); // slow by construction: a child process that loads the module

    test("a compiled `target: cli` holds the trees, and leaves its project's files to the rules", () => {
      seedCompiled("name: h\ntarget: cli\n");
      put("dist/agent.ts", REPORT);
      const roots = reported(ws, join("dist", "agent.ts"));
      expect(roots).toContain("dist");
      for (const name of ["crewhaus.yaml", "package.json", "tsconfig.json"]) {
        expect({ name, held: roots.includes(name) }).toEqual({ name, held: false });
      }
    }, 20_000); // slow by construction: a child process that loads the module

    test("a bundle started from inside itself holds its code and dependencies, and not its notes", () => {
      seedCompiled();
      put("dist/daemon.ts", REPORT);
      put("dist/agent.ts", "export {};\n");
      put("dist/GOAL.md", "# goal\n");
      const roots = reported(join(ws, "dist"), "daemon.ts");
      for (const name of [
        "daemon.ts",
        "agent.ts",
        "package.json",
        "node_modules",
        "tsconfig.json",
      ]) {
        expect({ name, held: roots.includes(name) }).toEqual({ name, held: true });
      }
      expect(roots).not.toContain("GOAL.md");
    }, 20_000); // slow by construction: a child process that loads the module

    test("a bundle started from inside itself, across two starts: the spec names stay refused, and its own data stays its own", async () => {
      base = tempDir("crewhaus-floor-two-starts-");
      ws = join(base, "dist");
      mkdirSync(ws, { recursive: true });
      put("daemon.ts", REPORT);
      put("agent.ts", "export {};\n");
      put("package.json", MANIFEST);
      process.chdir(ws);
      const first = reported(ws, "daemon.ts");
      for (const name of ["crewhaus.yaml", "crewhaus.yml", "agent.ts", "agent.js"]) {
        expect({ name, held: first.includes(name) }).toEqual({ name, held: true });
      }
      expect(first).not.toContain("state.json");

      // A turn of a process started the same way.
      startedFrom("daemon.ts");
      expect(floorAnswer(await writeTo("crewhaus.yaml", "name: h\ntarget: cli\n"))).toEqual(DENIED);
      expect(existsSync(join(ws, "crewhaus.yaml"))).toBe(false);
      for (const name of ["state.json", "report.json", "added.ts"]) {
        expect({ name, ...floorAnswer(await writeTo(name)) }).toEqual({
          name,
          decision: "allow",
          floor: false,
        });
      }

      const second = reported(ws, "daemon.ts");
      for (const name of ["agent.ts", "package.json", "crewhaus.yaml"]) {
        expect({ name, held: second.includes(name) }).toEqual({ name, held: true });
      }
      expect(second).not.toContain("state.json");
      expect(second).not.toContain("report.json");
      // A start holds the code files present when it starts, as the docblock says.
      expect(second).toContain("added.ts");
    }, 30_000); // slow by construction: a model turn and two child processes that load the module

    test("a compiled daemon below a working directory with no spec holds what lies above it", () => {
      seedCompiled(null);
      put("dist/daemon.ts", REPORT);
      const roots = reported(ws, join("dist", "daemon.ts"));
      for (const name of [
        "dist",
        "node_modules",
        "package.json",
        "tsconfig.json",
        "jsconfig.json",
        "crewhaus.yaml",
        "crewhaus.yml",
      ]) {
        expect({ name, held: roots.includes(name) }).toEqual({ name, held: true });
      }
      expect(roots).not.toContain("build");
    }, 20_000); // slow by construction: a child process that loads the module

    test("a project under another harness's bundle holds the trees, and nothing else of these", () => {
      seedCompiled();
      const elsewhere = tempDir("crewhaus-floor-elsewhere-");
      writeFileSync(join(elsewhere, "agent.ts"), REPORT);
      const roots = reported(ws, join(elsewhere, "agent.ts"));
      expect(roots).toContain("dist");
      expect(roots).not.toContain("package.json");
      expect(roots).not.toContain("crewhaus.yaml");
    }, 20_000); // slow by construction: a child process that loads the module
  });

  describe("what a harness keeps doing in its own directory", () => {
    const allowCompile = allowIn("CompileBundle");
    const compileAt = (dir: string) =>
      turn(
        { name: "CompileBundle", input: { dir, target: "channel", dryRun: true } },
        [compileBundle],
        allowCompile,
        "auto",
      );

    test("CompileBundle of the working directory reaches its execute", async () => {
      seedCompiled();
      const r = await compileAt(".");
      expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
      const out = JSON.parse(r.result ?? "{}") as { dryRun?: boolean };
      expect(out.dryRun).toBe(true);
    });

    test("and from a compiled daemon's own process", async () => {
      seedCompiled();
      startedFrom("dist/daemon.ts");
      const r = await compileAt(".");
      expect(floorAnswer(r)).toEqual({ decision: "allow", floor: false });
      const out = JSON.parse(r.result ?? "{}") as { dryRun?: boolean };
      expect(out.dryRun).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The tools that move the working tree
// ---------------------------------------------------------------------------

describe("a tool that writes the files it names refuses one that lands on the floor", () => {
  const TOOLS = [
    specPin,
    deployRollback,
    knowledgeSync,
    harnessRetire,
    experimentLedger,
    routeControl,
  ];
  const RULES = allowIn(...TOOLS.map((tool) => tool.name));
  const SETTINGS_FILE = join(".crewhaus", "settings.json");
  const DENIES = `${JSON.stringify({
    permissions: { rules: [{ type: "alwaysDeny", pattern: "Bash" }] },
  })}\n`;
  const ALLOWS = DENIES.replace("alwaysDeny", "alwaysAllow");
  const JUSTIFICATION = "control files floor";

  beforeEach(() => {
    originalCwd = process.cwd();
    base = tempDir("crewhaus-floor-named-");
    ws = join(base, "harness");
    mkdirSync(ws);
    env = { CREWHAUS_HANGAR_ROOT: join(base, "home"), CREWHAUS_REGISTRY_ROOT: join(base, "reg") };
    put(SETTINGS_FILE, DENIES);
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
  });

  const linkToSettings = (rel: string): void => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    symlinkSync(relative(dirname(join(ws, rel)), join(ws, SETTINGS_FILE)), join(ws, rel));
  };
  const rulesNow = (): string[] =>
    loadSettingsRules(ws).map((rule) => `${rule.type} ${rule.pattern}`);
  /** One call through the run loop, refused for what it would write, with the settings as they were. */
  const refusedInBothModes = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<void> => {
    for (const mode of ["auto", "bypass"] as const) {
      const r = await turn(
        { name, input: { justification: JUSTIFICATION, ...input } },
        TOOLS,
        RULES,
        mode,
      );
      expect(r.result ?? "").toContain(REFUSED);
      expect(readFileSync(join(ws, SETTINGS_FILE), "utf8")).toBe(DENIES);
      expect(rulesNow()).toEqual(["alwaysDeny Bash"]);
    }
  };

  test("SpecPin: the next version's file and the changelog", async () => {
    put("spec.yaml", ALLOWS);
    for (const leaf of ["v1.yaml", "CHANGELOG.md"]) {
      linkToSettings(`s/sp/${leaf}`);
      await refusedInBothModes("SpecPin", { name: "sp", specFile: "spec.yaml", registryDir: "s" });
      rmSync(join(ws, "s", "sp", leaf));
    }
  });

  test("DeployRollback: a tenant's overlay", async () => {
    put("spec.yaml", "name: sp\n");
    await specPin.execute(
      { name: "sp", specFile: "spec.yaml", registryDir: "s", env: "prod" } as never,
      undefined,
    );
    linkToSettings("s/_tenants/acme/sp.json");
    await refusedInBothModes("DeployRollback", {
      name: "sp",
      env: "prod",
      toVersion: "v1",
      registryDir: "s",
      tenant: "acme",
      dryRun: false,
    });
  });

  test("KnowledgeSync: the name a pull lands a fragment under, and a push's manifest", async () => {
    const hash = createHash("sha256").update(ALLOWS.trim()).digest("hex");
    put(`shared/prompts/${hash}.md`, ALLOWS);
    linkToSettings(`fleet/other/.crewhaus/prompts/shared-${hash.slice(0, 12)}.md`);
    await refusedInBothModes("KnowledgeSync", {
      direction: "pull",
      dir: "fleet/other",
      sharedDir: "shared",
      dryRun: false,
    });
    put("fleet/mine/.crewhaus/knowledge.json", '{"share":true}');
    put(
      "fleet/mine/.crewhaus/memories/m.jsonl",
      `${JSON.stringify({ id: "m1", text: "keep it brief", tags: [] })}\n`,
    );
    linkToSettings("pool/manifest.jsonl");
    await refusedInBothModes("KnowledgeSync", {
      direction: "push",
      dir: "fleet/mine",
      sharedDir: "pool",
      allowWithoutPiiRedaction: true,
      dryRun: false,
    });
  });

  test("HarnessRetire: the files it keeps in the archive", async () => {
    put("fleet/other/.crewhaus/sessions/sess_00000000000000bb.json", '{"id":"b"}');
    for (const name of ["retirement.json", "state-manifest.json"]) {
      linkToSettings(`arch/${name}`);
      await refusedInBothModes("HarnessRetire", {
        spec: "other",
        dir: "fleet/other",
        archiveDir: "arch",
        dryRun: false,
        acceptUnverified: true,
        overwriteArchive: true,
      });
      expect(existsSync(join(ws, "fleet", "other", ".crewhaus"))).toBe(true);
      rmSync(join(ws, "arch", name));
    }
  });

  test("ExperimentLedger: the ledger a record appends to, and RouteControl: its freeze marker", async () => {
    linkToSettings("s/e.jsonl");
    await refusedInBothModes("ExperimentLedger", {
      action: "record",
      name: "e",
      experimentsDir: "s",
      version: "v",
      outcome: "success",
      allowUnknownVersion: true,
      dryRun: false,
    });
    linkToSettings("fleet/other/.crewhaus/routing/freeze.json");
    await refusedInBothModes("RouteControl", {
      action: "freeze",
      dir: "fleet/other",
      policyVersion: "p",
      dryRun: false,
    });
  });
});

describe("a tool that moves the working tree refuses a change that lands on the floor", () => {
  const TOOLS = [write, edit, movePath, ...GIT_TOOLS, harnessRetire];
  const RULES = allowIn(
    "Write",
    "Edit",
    "MovePath",
    ...GIT_TOOLS.map((tool) => tool.name),
    "HarnessRetire",
  );
  // Slow by construction: a whole run per call, and each call spawns git many times.
  const CHAIN_MS = 60_000;
  const DENIES = `${JSON.stringify({
    permissions: { rules: [{ type: "alwaysDeny", pattern: "Bash" }] },
    pad: "a".repeat(80),
  })}\n`;
  const ALLOWS = DENIES.replace("alwaysDeny", "alwaysAllow");
  const SETTINGS_FILE = join(".crewhaus", "settings.json");
  const GUARD_RULE = ["alwaysDeny Bash"];
  const LINK_DIFF =
    "diff --git a/.crewhaus b/.crewhaus\nnew file mode 120000\n--- /dev/null\n+++ b/.crewhaus\n@@ -0,0 +1 @@\n+fake\n\\ No newline at end of file\n";

  const VARS = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "A U Thor",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "A U Thor",
    GIT_COMMITTER_EMAIL: "author@example.com",
  };
  const saved = new Map<string, string | undefined>();
  const setVar = (name: string, value: string): void => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  };
  beforeEach(() => {
    originalCwd = process.cwd();
    base = tempDir("crewhaus-floor-tree-");
    ws = join(base, "harness");
    mkdirSync(ws);
    env = { CREWHAUS_HANGAR_ROOT: join(base, "home"), CREWHAUS_REGISTRY_ROOT: join(base, "reg") };
    for (const [name, value] of Object.entries({ ...VARS, ...env })) setVar(name, value);
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    saved.clear();
  });

  const git = (args: readonly string[], opts: { cwd?: string; stdin?: string } = {}): string => {
    const ran = Bun.spawnSync(["git", ...args], {
      cwd: opts.cwd ?? ws,
      env: process.env,
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
    return ran.stdout.toString();
  };
  /** What HEAD is now, with an unborn one answered as such. */
  const head = (): string => {
    const at = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: ws,
      env: process.env,
      stdout: "pipe",
      stderr: "ignore",
    });
    return at.exitCode === 0 ? at.stdout.toString().trim() : "(unborn)";
  };
  const commitAll = (message: string): void => {
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
  };
  const seedRepo = (
    opts: { tracked?: boolean; ignored?: boolean; noSettings?: boolean } = {},
  ): void => {
    git(["init", "-q", "-b", "main", "."]);
    put("a.txt", "hi\n");
    if (opts.noSettings !== true) put(SETTINGS_FILE, DENIES);
    put(".gitignore", opts.ignored === true ? ".crewhaus/\nwt/\n" : "wt/\n");
    git(["add", "a.txt", ".gitignore"]);
    if (opts.tracked === true) git(["add", SETTINGS_FILE]);
    git(["commit", "-q", "-m", "base"]);
  };
  /** A commit on HEAD with `entries` (`mode oid<TAB>name` lines) added, made in an index of its own. */
  const commitOver = (entries: string, message: string): string => {
    setVar("GIT_INDEX_FILE", join(base, "scratch-index"));
    try {
      git(["read-tree", "HEAD"]);
      git(["update-index", "--index-info"], { stdin: entries });
      return git(["commit-tree", git(["write-tree"]).trim(), "-p", "HEAD", "-m", message]).trim();
    } finally {
      Reflect.deleteProperty(process.env, "GIT_INDEX_FILE");
    }
  };
  const settingsNow = (): string => {
    const at = join(ws, SETTINGS_FILE);
    return existsSync(at) ? readFileSync(at, "utf8") : "(gone)";
  };
  const rulesNow = (): string[] =>
    loadSettingsRules(ws).map((rule) => `${rule.type} ${rule.pattern}`);
  const roots = (): string[] => runtimeStateRoots(undefined, undefined, ws, env);

  /** One call that must run: a chain that stops early proves nothing about its last call. */
  const call = async (
    name: string,
    input: Record<string, unknown>,
    mode: PermissionMode = "auto",
  ): Promise<string> => {
    const r = await turn({ name, input }, TOOLS, RULES, mode);
    expect({ name, decision: r.decision }).toEqual({ name, decision: "allow" });
    expect(r.result ?? "").not.toContain(REFUSED);
    return r.result ?? "";
  };
  /** One call that must be refused for what it would write, with the settings file as it was. */
  const refused = async (
    name: string,
    input: Record<string, unknown>,
    phrase = "the change to",
    mode: PermissionMode = "auto",
  ): Promise<string> => {
    const before = { settings: settingsNow(), rules: rulesNow(), head: head() };
    const r = await turn({ name, input }, TOOLS, RULES, mode);
    expect(r.result ?? "").toContain(REFUSED);
    expect(r.result ?? "").toContain(phrase);
    expect({ settings: settingsNow(), rules: rulesNow(), head: head() }).toEqual(before);
    return r.result ?? "";
  };

  /** A second worktree on branch `b`, whose settings file a commit there changes. */
  const branchChangingSettings = async (mode: PermissionMode = "auto"): Promise<void> => {
    await call("GitWorktreeAdd", { path: "wt", createBranch: "b" }, mode);
    await call(
      "Edit",
      {
        path: join("wt", SETTINGS_FILE),
        oldString: "alwaysDeny",
        newString: "alwaysAllow",
      },
      mode,
    );
    await call("GitAdd", { cwd: "wt", paths: ["."] }, mode);
    await call("GitCommit", { cwd: "wt", message: "c" }, mode);
  };
  /** The settings file moved to `foo.json` in `wt` and committed, with an edit to `foo.json` left uncommitted. */
  const branchRenamingSettings = async (): Promise<void> => {
    await call("GitWorktreeAdd", { path: "wt", createBranch: "b" });
    await call("MovePath", { source: join("wt", SETTINGS_FILE), destination: "wt/foo.json" });
    await call("GitAdd", { cwd: "wt", paths: ["."] });
    await call("GitCommit", { cwd: "wt", message: "move" });
    await call("Edit", {
      path: "wt/foo.json",
      oldString: "alwaysDeny",
      newString: "alwaysAllow",
    });
  };
  const namesOnly = (args: readonly string[]): string[] =>
    git(args, { cwd: join(ws, "wt") })
      .trim()
      .split("\n");

  describe("a call refused, with the settings file and the rules it loads unchanged", () => {
    test(
      "a pick that changes the settings file",
      async () => {
        seedRepo({ tracked: true });
        await branchChangingSettings();
        const out = await refused("GitCherryPick", { refs: ["b"] });
        expect(out).toContain(".crewhaus/settings.json");
        expect(rulesNow()).toEqual(GUARD_RULE);
      },
      CHAIN_MS,
    );

    test(
      "a pick that follows a rename onto the settings file, though the commit lists only another file",
      async () => {
        seedRepo({ tracked: true });
        await branchRenamingSettings();
        await call("GitAdd", { cwd: "wt", paths: ["."] });
        await call("GitCommit", { cwd: "wt", message: "c" });
        expect(namesOnly(["diff-tree", "-r", "--name-only", "--no-commit-id", "b^", "b"])).toEqual([
          "foo.json",
        ]);
        await refused("GitCherryPick", { refs: ["b"] }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a pick with `noCommit` replays onto the index, so a rename staged there counts",
      async () => {
        git(["init", "-q", "-b", "main", "."]);
        put("foo.json", DENIES);
        commitAll("base");
        git(["switch", "-q", "-c", "b"]);
        put("foo.json", ALLOWS);
        commitAll("c");
        git(["switch", "-q", "main"]);
        mkdirSync(join(ws, ".crewhaus"));
        git(["mv", "foo.json", SETTINGS_FILE]);
        await refused("GitCherryPick", { refs: ["b"], noCommit: true }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a pick of a root commit that holds the settings file",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "--orphan", "r"]);
        put(SETTINGS_FILE, ALLOWS);
        git(["add", SETTINGS_FILE]);
        git(["commit", "-q", "-m", "root"]);
        const root = git(["rev-parse", "HEAD"]).trim();
        git(["switch", "-q", "--force", "main"]);
        await refused("GitCherryPick", { refs: [root] }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a pick of a range, whichever commit of it reaches the settings file",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "s"]);
        put("one.txt", "1\n");
        commitAll("one");
        put(SETTINGS_FILE, ALLOWS);
        commitAll("two");
        put("three.txt", "3\n");
        commitAll("three");
        git(["switch", "-q", "main"]);
        await refused("GitCherryPick", { refs: ["main..s"] }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a pick of a merge reads the parent `mainline` names",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "side"]);
        put(SETTINGS_FILE, ALLOWS);
        commitAll("side");
        git(["switch", "-q", "-c", "m", "main"]);
        put("m.txt", "m\n");
        commitAll("m");
        git(["merge", "-q", "--no-ff", "-m", "merge", "side"]);
        const merge = head();
        git(["switch", "-q", "main"]);
        // From its first parent the merge brings the settings file; from its second, `m.txt`.
        await refused("GitCherryPick", { refs: [merge], mainline: 1 }, ".crewhaus/settings.json");
        expect(
          JSON.parse(await call("GitCherryPick", { refs: [merge], mainline: 2 })),
        ).toMatchObject({ picked: true });
        expect(readFileSync(join(ws, "m.txt"), "utf8")).toBe("m\n");
        expect(settingsNow()).toBe(DENIES);
      },
      CHAIN_MS,
    );

    test(
      "a change to a file in a directory root, and one to a file beside the roots runs",
      async () => {
        seedRepo({ tracked: true });
        put(".crewhaus/run/daemon.json", "{}\n");
        put(".crewhaus/notes.md", "one\n");
        commitAll("tracked under .crewhaus");
        git(["switch", "-q", "-c", "b"]);
        put(".crewhaus/run/daemon.json", '{"pid":1}\n');
        commitAll("c");
        git(["switch", "-q", "-c", "n", "main"]);
        put(".crewhaus/notes.md", "two\n");
        commitAll("n");
        git(["switch", "-q", "main"]);
        await refused("GitSwitch", { branch: "b" }, ".crewhaus/run/daemon.json");
        expect(JSON.parse(await call("GitSwitch", { branch: "n" }))).toMatchObject({
          switched: true,
        });
        expect(readFileSync(join(ws, ".crewhaus/notes.md"), "utf8")).toBe("two\n");
      },
      CHAIN_MS,
    );

    test(
      "a pick of several commits replays each onto the result of the one before",
      async () => {
        seedRepo({ tracked: true });
        put("foo.json", DENIES);
        commitAll("a copy");
        git(["switch", "-q", "-c", "drops"]);
        git(["rm", "-q", "foo.json"]);
        git(["commit", "-q", "-m", "drops the copy"]);
        const first = head();
        git(["switch", "-q", "--orphan", "other"]);
        put("foo.json", DENIES);
        git(["add", "foo.json"]);
        git(["commit", "-q", "-m", "no settings here"]);
        put("foo.json", ALLOWS);
        git(["add", "foo.json"]);
        git(["commit", "-q", "-m", "an edit"]);
        const second = head();
        git(["switch", "-q", "--force", "main"]);
        // The fixture is live: run plainly, the second commit lands on the settings file.
        git(["worktree", "add", "-q", "--detach", "wt", "main"]);
        git(["cherry-pick", first, second], { cwd: join(ws, "wt") });
        expect(readFileSync(join(ws, "wt", SETTINGS_FILE), "utf8")).toBe(ALLOWS);
        await refused("GitCherryPick", { refs: [first, second] }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a switch that overwrites an ignored settings file",
      async () => {
        seedRepo({ ignored: true });
        await call("GitWorktreeAdd", { path: "wt", createBranch: "b" });
        await call("Write", { path: join("wt", SETTINGS_FILE), content: ALLOWS });
        git(["add", "-f", SETTINGS_FILE], { cwd: join(ws, "wt") });
        await call("GitCommit", { cwd: "wt", message: "c" });
        await refused("GitSwitch", { branch: "b", detach: true });
        expect(rulesNow()).toEqual(GUARD_RULE);
      },
      CHAIN_MS,
    );

    test(
      "a switch that lays a link where `.crewhaus` is, with the session log kept",
      async () => {
        seedRepo({ ignored: true });
        put(".crewhaus/sessions/s.jsonl", "log\n");
        await call("GitWorktreeAdd", { path: "wt", createBranch: "b" });
        await call("Write", { path: "wt/fake/settings.json", content: ALLOWS });
        await call("GitApplyPatch", { cwd: "wt", index: true, patch: LINK_DIFF });
        await call("GitAdd", { cwd: "wt", paths: ["fake"] });
        await call("GitCommit", { cwd: "wt", message: "c" });
        await refused("GitSwitch", { branch: "b", detach: true });
        expect(readFileSync(join(ws, ".crewhaus/sessions/s.jsonl"), "utf8")).toBe("log\n");
        expect(lstatSync(join(ws, ".crewhaus")).isSymbolicLink()).toBe(false);
      },
      CHAIN_MS,
    );

    test(
      "a worktree at a directory that would hold a root is denied before any rule",
      async () => {
        seedRepo({ noSettings: true });
        await call("GitWorktreeAdd", { path: "wt", createBranch: "b" });
        await call("Write", { path: "wt/settings.json", content: ALLOWS });
        await call("GitAdd", { cwd: "wt", paths: ["."] });
        await call("GitCommit", { cwd: "wt", message: "c" });
        for (const path of [".crewhaus", "./.crewhaus", ".crewhaus/"]) {
          const r = await turn(
            { name: "GitWorktreeAdd", input: { path, ref: "b", detach: true } },
            TOOLS,
            RULES,
            "auto",
          );
          expect({ path, decision: r.decision, floor: r.reason?.includes(FLOOR) }).toEqual({
            path,
            decision: "deny",
            floor: true,
          });
        }
        expect(existsSync(join(ws, ".crewhaus"))).toBe(false);
        expect(rulesNow()).toEqual([]);
      },
      CHAIN_MS,
    );

    test(
      "a pop from the stack worktrees share that changes the settings file",
      async () => {
        seedRepo({ tracked: true });
        await call("GitWorktreeAdd", { path: "wt", createBranch: "b" });
        await call("Edit", {
          path: join("wt", SETTINGS_FILE),
          oldString: "alwaysDeny",
          newString: "alwaysAllow",
        });
        await call("GitStashPush", { cwd: "wt", message: "m", paths: [SETTINGS_FILE] });
        await refused("GitStashPop", {}, ".crewhaus/settings.json");
        expect(git(["stash", "list"])).toContain("m");
      },
      CHAIN_MS,
    );

    test(
      "a pop that follows a rename onto the settings file, though the entry lists only another file",
      async () => {
        seedRepo({ tracked: true });
        await branchRenamingSettings();
        await call("GitStashPush", { cwd: "wt", message: "m" });
        expect(namesOnly(["stash", "show", "--name-only", "stash@{0}"])).toEqual(["foo.json"]);
        await refused("GitStashPop", {}, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a pop merges into the index, so a rename staged there counts",
      async () => {
        git(["init", "-q", "-b", "main", "."]);
        put("foo.json", DENIES);
        commitAll("base");
        put("foo.json", ALLOWS);
        git(["stash", "push", "-q", "-m", "m"]);
        mkdirSync(join(ws, ".crewhaus"));
        git(["mv", "foo.json", SETTINGS_FILE]);
        await refused("GitStashPop", {}, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a pop that restores an untracked settings file",
      async () => {
        seedRepo({ noSettings: true });
        await call("GitWorktreeAdd", { path: "wt", createBranch: "b" });
        await call("Write", { path: join("wt", SETTINGS_FILE), content: ALLOWS });
        await call("GitStashPush", { cwd: "wt", includeUntracked: true, message: "m" });
        await refused("GitStashPop", { apply: true }, ".crewhaus/settings.json");
        expect(existsSync(join(ws, ".crewhaus"))).toBe(false);
      },
      CHAIN_MS,
    );

    test(
      "a push that keeps an index holding other settings",
      async () => {
        seedRepo({ tracked: true });
        await branchChangingSettings();
        await call("GitResetPaths", { paths: ["."], ref: "b" });
        await refused("GitStashPush", { keepIndex: true, message: "k" }, ".crewhaus/settings.json");
        expect(rulesNow()).toEqual(GUARD_RULE);
      },
      CHAIN_MS,
    );

    test(
      "a push that takes an untracked settings file away",
      async () => {
        seedRepo();
        await refused("GitStashPush", { includeUntracked: true, message: "u" });
        expect(settingsNow()).toBe(DENIES);
      },
      CHAIN_MS,
    );

    test(
      "a push from a subdirectory covers the whole repository",
      async () => {
        seedRepo();
        put("sub/kept.txt", "kept\n");
        await refused("GitStashPush", { cwd: "sub", includeUntracked: true, message: "u" });
        expect(settingsNow()).toBe(DENIES);
      },
      CHAIN_MS,
    );

    test(
      "a push that takes back a changed settings file, and one that names its paths runs",
      async () => {
        seedRepo({ tracked: true });
        const changed = DENIES.replace('"Bash"', '"Write"');
        put(SETTINGS_FILE, changed);
        put("a.txt", "dirty\n");
        await refused("GitStashPush", { message: "u" }, ".crewhaus/settings.json");
        expect(settingsNow()).toBe(changed);
        await call("GitStashPush", { message: "named", paths: ["a.txt"] });
        expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("hi\n");
        expect(settingsNow()).toBe(changed);
      },
      CHAIN_MS,
    );

    test(
      "a retire of the harness it runs in, as a preview and for real, with `.crewhaus` left in place",
      async () => {
        seedRepo({ tracked: true });
        const input = {
          spec: "x",
          archiveDir: "arch",
          justification: "the control files floor says this harness is finished",
        };
        for (const extra of [{}, { dryRun: false, acceptUnverified: true }]) {
          await refused("HarnessRetire", { ...input, ...extra }, "retiring .");
          expect(existsSync(join(ws, "arch"))).toBe(false);
          expect(settingsNow()).toBe(DENIES);
        }
      },
      CHAIN_MS,
    );

    test(
      "a switch by a name that is both a branch and a tag reads the branch, as git switch does",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "b"]);
        put(SETTINGS_FILE, ALLOWS);
        commitAll("c");
        git(["switch", "-q", "main"]);
        git(["tag", "b", "main"]);
        expect(git(["rev-parse", "b"]).trim()).toBe(git(["rev-parse", "main"]).trim());
        await refused("GitSwitch", { branch: "b" }, ".crewhaus/settings.json");
        await refused("GitSwitch", { branch: "b", detach: true }, ".crewhaus/settings.json");
        await refused(
          "GitSwitch",
          { branch: "n", create: true, startPoint: "b" },
          ".crewhaus/settings.json",
        );
        // The branch before this one, by the name `git switch` reads it under.
        git(["switch", "-q", "b"]);
        git(["switch", "-q", "main"]);
        await refused("GitSwitch", { branch: "@{-1}" }, ".crewhaus/settings.json");
        await refused("GitSwitch", { branch: "@{-1}", detach: true }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a switch to a commit that moves the settings file away, though a diff shows only where it went",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "b"]);
        git(["mv", SETTINGS_FILE, "x.json"]);
        git(["commit", "-q", "-m", "moved"]);
        git(["switch", "-q", "main"]);
        expect(git(["diff", "--name-only", "-M", "main", "b"]).trim()).toBe("x.json");
        await refused("GitSwitch", { branch: "b" }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a switch to a tree that spells `.crewhaus` another way, on any volume",
      async () => {
        seedRepo({ ignored: true });
        const blob = git(["hash-object", "-w", "--stdin"], { stdin: ALLOWS }).trim();
        git([
          "update-ref",
          "refs/heads/b",
          commitOver(`100644 ${blob}\t.CREWHAUS/settings.json\n`, "e"),
        ]);
        await refused("GitSwitch", { branch: "b", detach: true }, ".CREWHAUS/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a switch across a submodule's pointer at `.crewhaus`, which the repository's config would hide",
      async () => {
        seedRepo({ noSettings: true });
        git(["update-ref", "refs/heads/b", commitOver(`160000 ${head()}\t.crewhaus\n`, "s")]);
        git(["config", "diff.ignoreSubmodules", "all"]);
        expect(git(["diff", "--name-only", "HEAD", "b"]).trim()).toBe("");
        await refused("GitSwitch", { branch: "b" }, "the change to .crewhaus");
      },
      CHAIN_MS,
    );

    test(
      "a switch to the merge base `A...B` names",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "side"]);
        put("side.txt", "s\n");
        commitAll("side");
        git(["switch", "-q", "main"]);
        put(SETTINGS_FILE, ALLOWS);
        commitAll("moved on");
        await refused("GitSwitch", { branch: "main...side", detach: true });
        await refused("GitSwitch", {
          branch: "n",
          create: true,
          startPoint: "main...side",
        });
      },
      CHAIN_MS,
    );

    test(
      "a guess among remotes: one remote's branch changes the settings file and another's does not",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "side"]);
        put(SETTINGS_FILE, ALLOWS);
        commitAll("c");
        const changed = head();
        git(["switch", "-q", "main"]);
        git(["remote", "add", "a", "https://example.invalid/a.git"]);
        git(["remote", "add", "c", "https://example.invalid/c.git"]);
        git(["update-ref", "refs/remotes/a/b", changed]);
        git(["update-ref", "refs/remotes/c/b", "main"]);
        git(["config", "checkout.defaultRemote", "a"]);
        await refused("GitSwitch", { branch: "b" }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "a name nothing was found for reaches no remote's branch by another mapping",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "side"]);
        put(SETTINGS_FILE, ALLOWS);
        commitAll("c");
        const changed = head();
        git(["switch", "-q", "main"]);
        git(["remote", "add", "o", "https://example.invalid/o.git"]);
        git(["config", "remote.o.fetch", "+refs/heads/*:refs/mirror/*"]);
        git(["update-ref", "refs/mirror/feat", changed]);
        const r = await turn(
          { name: "GitSwitch", input: { branch: "feat" } },
          TOOLS,
          RULES,
          "auto",
        );
        expect(r.result ?? "").toContain("invalid reference");
        expect(settingsNow()).toBe(DENIES);
      },
      CHAIN_MS,
    );

    test(
      "a switch to a commit named by a search of its messages, in `auto` and in `bypass`",
      async () => {
        seedRepo({ tracked: true });
        await branchChangingSettings();
        const forms = [
          { branch: ":/c", detach: true },
          { branch: "n", create: true, startPoint: ":/c" },
        ];
        for (const mode of ["auto", "bypass"] as const) {
          for (const input of forms) {
            await refused("GitSwitch", input, ".crewhaus/settings.json", mode);
          }
        }
        // A search that lands where the settings file is the same is an ordinary switch.
        expect(
          JSON.parse(await call("GitSwitch", { branch: ":/base", detach: true })),
        ).toMatchObject({ switched: true, detached: true });
        expect(settingsNow()).toBe(DENIES);
      },
      CHAIN_MS,
    );

    test(
      "a detached or new branch on a name that resolves to nothing is refused",
      async () => {
        seedRepo({ tracked: true });
        for (const mode of ["auto", "bypass"] as const) {
          for (const input of [
            { branch: "nosuch", detach: true },
            { branch: ":/nosuch", detach: true },
            { branch: "n", create: true, startPoint: "nosuch" },
            { branch: "n", create: true, startPoint: ":/nosuch" },
            // A tree resolves, and no commit is there to land on.
            { branch: "HEAD^{tree}", detach: true },
          ]) {
            await refused("GitSwitch", input, "could not be listed", mode);
          }
        }
      },
      CHAIN_MS,
    );

    test(
      "a revision over a name that is both a branch and a tag reads what git reads, not the branch",
      async () => {
        seedRepo({ tracked: true });
        // The tag, and its parent, carry the settings change; the branch of that name does not.
        git(["switch", "-q", "-c", "side"]);
        put(SETTINGS_FILE, ALLOWS);
        commitAll("settings");
        put("t.txt", "t\n");
        commitAll("top");
        git(["tag", "b"]);
        git(["switch", "-q", "-c", "b", "main"]);
        put("h.txt", "h\n");
        commitAll("other");
        git(["switch", "-q", "main"]);
        for (const name of [
          "b~0",
          "b^0",
          "b^{commit}",
          "b^{}",
          "b^",
          "b~",
          "b~1",
          "b^1",
          "b^{/top}",
        ]) {
          // What raw git lands on, so this table cannot drift from git itself.
          expect({
            name,
            settings: git(["show", `${git(["rev-parse", name]).trim()}:${SETTINGS_FILE}`]),
          }).toEqual({ name, settings: ALLOWS });
          await refused("GitSwitch", { branch: name, detach: true }, ".crewhaus/settings.json");
          await refused(
            "GitSwitch",
            { branch: "n", create: true, startPoint: name },
            ".crewhaus/settings.json",
          );
        }
        await refused("GitSwitch", { branch: "tags/b", detach: true }, ".crewhaus/settings.json");
        // The bare name is the branch's, in the form that takes it as one.
        expect(JSON.parse(await call("GitSwitch", { branch: "b", detach: true }))).toMatchObject({
          switched: true,
          detached: true,
        });
        expect(existsSync(join(ws, "h.txt"))).toBe(true);
        expect(settingsNow()).toBe(DENIES);
      },
      CHAIN_MS,
    );

    test(
      "a branch git reads under `HEAD` or `@` is read too",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "side"]);
        put(SETTINGS_FILE, ALLOWS);
        commitAll("settings");
        git(["switch", "-q", "main"]);
        git(["update-ref", "refs/heads/HEAD", "side"]);
        for (const branch of ["HEAD", "@"]) {
          await refused("GitSwitch", { branch }, ".crewhaus/settings.json");
          await refused("GitSwitch", { branch, detach: true }, ".crewhaus/settings.json");
        }
        expect(git(["rev-parse", "--abbrev-ref", "main"]).trim()).toBe("main");
      },
      CHAIN_MS,
    );

    test(
      "a repository's `diff.relative` hides no name from a `cwd` below the top",
      async () => {
        seedRepo({ tracked: true });
        put("sub/s.txt", "s\n");
        commitAll("sub");
        git(["switch", "-q", "-c", "b"]);
        put(SETTINGS_FILE, ALLOWS);
        commitAll("c");
        git(["switch", "-q", "main"]);
        git(["config", "diff.relative", "true"]);
        expect(git(["diff", "--name-only", "main", "b"], { cwd: join(ws, "sub") })).toBe("");
        await refused("GitSwitch", { cwd: "sub", branch: "b" }, ".crewhaus/settings.json");
        await refused("GitCherryPick", { cwd: "sub", refs: ["b"] }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "in `bypass` mode too",
      async () => {
        seedRepo({ tracked: true });
        await branchChangingSettings("bypass");
        await refused("GitCherryPick", { refs: ["b"] }, ".crewhaus/settings.json", "bypass");
        await refused("GitSwitch", { branch: "b" }, ".crewhaus/settings.json", "bypass");
      },
      CHAIN_MS,
    );
  });

  describe("a change that touches no floor file goes through", () => {
    test(
      "switch, `switch -c`, a pick and a range pick",
      async () => {
        seedRepo({ tracked: true });
        await call("GitSwitch", { branch: "f", create: true });
        await call("Write", { path: "a.txt", content: "f\n" });
        await call("GitAdd", { paths: ["a.txt"] });
        await call("GitCommit", { message: "f" });
        await call("GitSwitch", { branch: "main" });
        expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("hi\n");
        expect(JSON.parse(await call("GitCherryPick", { refs: ["f"] }))).toMatchObject({
          picked: true,
        });
        expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("f\n");
        git(["switch", "-q", "-c", "s"]);
        for (const n of ["1", "2", "3"]) {
          put(`f${n}.txt`, n);
          commitAll(n);
        }
        git(["switch", "-q", "main"]);
        expect(JSON.parse(await call("GitCherryPick", { refs: ["main..s"] }))).toMatchObject({
          picked: true,
        });
        expect(existsSync(join(ws, "f1.txt")) && existsSync(join(ws, "f3.txt"))).toBe(true);
      },
      CHAIN_MS,
    );

    test(
      "`switch -c` on an unborn HEAD",
      async () => {
        git(["init", "-q", "-b", "main", "."]);
        expect(JSON.parse(await call("GitSwitch", { branch: "x", create: true }))).toMatchObject({
          switched: true,
        });
        expect(git(["symbolic-ref", "--short", "HEAD"]).trim()).toBe("x");
      },
      CHAIN_MS,
    );

    test(
      "a switch from an unborn HEAD lists every file it lays down, and one with none of the floor's runs",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "other"]);
        git(["switch", "-q", "--orphan", "bare"]);
        put("b.txt", "b\n");
        git(["add", "b.txt"]);
        git(["commit", "-q", "-m", "no floor files"]);
        git(["switch", "-q", "--orphan", "empty"]);
        await refused("GitSwitch", { branch: "other" }, ".crewhaus/settings.json");
        expect(existsSync(join(ws, ".crewhaus"))).toBe(false);
        expect(JSON.parse(await call("GitSwitch", { branch: "bare" }))).toMatchObject({
          switched: true,
          branch: "bare",
        });
      },
      CHAIN_MS,
    );

    test(
      "a switch that guesses a remote's branch",
      async () => {
        seedRepo();
        git(["remote", "add", "origin", "https://example.invalid/o.git"]);
        git(["update-ref", "refs/remotes/origin/feat", "HEAD"]);
        expect(JSON.parse(await call("GitSwitch", { branch: "feat" }))).toMatchObject({
          switched: true,
          branch: "feat",
        });
      },
      CHAIN_MS,
    );

    test(
      "a conflicted pick is reported as git reports it",
      async () => {
        seedRepo({ ignored: true });
        git(["switch", "-q", "-c", "c"]);
        put("a.txt", "one\n");
        commitAll("one");
        git(["switch", "-q", "main"]);
        put("a.txt", "two\n");
        commitAll("two");
        expect(JSON.parse(await call("GitCherryPick", { refs: ["c"] }))).toMatchObject({
          picked: false,
          conflicted: ["a.txt"],
        });
      },
      CHAIN_MS,
    );

    test(
      "a root commit's pick",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "--orphan", "r"]);
        put("r.txt", "r\n");
        git(["add", "r.txt"]);
        git(["commit", "-q", "-m", "root"]);
        const root = head();
        git(["switch", "-q", "--force", "main"]);
        expect(JSON.parse(await call("GitCherryPick", { refs: [root] }))).toMatchObject({
          picked: true,
        });
        expect(readFileSync(join(ws, "r.txt"), "utf8")).toBe("r\n");
      },
      CHAIN_MS,
    );

    test(
      "a stash round trip with an untracked file",
      async () => {
        seedRepo({ ignored: true });
        put("n.txt", "n\n");
        put("a.txt", "dirty\n");
        await call("GitStashPush", { includeUntracked: true, message: "m" });
        expect(existsSync(join(ws, "n.txt"))).toBe(false);
        expect(JSON.parse(await call("GitStashPop", {}))).toMatchObject({ dropped: true });
        expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("dirty\n");
        expect(readFileSync(join(ws, "n.txt"), "utf8")).toBe("n\n");
      },
      CHAIN_MS,
    );

    test(
      "a retire of another harness in the workspace",
      async () => {
        seedRepo({ tracked: true });
        put("fleet/other/.crewhaus/settings.json", DENIES);
        const out = await call("HarnessRetire", {
          spec: "x",
          dir: "fleet/other",
          archiveDir: "arch",
          dryRun: false,
          acceptUnverified: true,
          justification: "the control files floor says this harness is finished",
        });
        expect(JSON.parse(out)).toMatchObject({ harnessDir: "fleet/other", dryRun: false });
        expect(existsSync(join(ws, "fleet/other/.crewhaus"))).toBe(false);
        expect(settingsNow()).toBe(DENIES);
      },
      CHAIN_MS,
    );

    test(
      "a change inside `wt` is `wt`'s own, not the harness's",
      async () => {
        seedRepo({ tracked: true });
        await branchChangingSettings();
        await call("GitSwitch", { cwd: "wt", branch: "w2", create: true, startPoint: "main" });
        expect(readFileSync(join(ws, "wt", SETTINGS_FILE), "utf8")).toBe(DENIES);
      },
      CHAIN_MS,
    );

    test(
      "a run with no roots on its bridge runs them as git does",
      async () => {
        seedRepo({ tracked: true });
        await branchChangingSettings();
        expect(JSON.parse(await text(gitSwitch, { branch: "b", detach: true }, []))).toMatchObject({
          switched: true,
        });
        expect(settingsNow()).toBe(ALLOWS);
      },
      CHAIN_MS,
    );
  });

  describe("names that cannot be listed are not an empty list", () => {
    test(
      "a range that outlasts the preview's one deadline is refused, and the tree is left alone",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "s"]);
        for (const n of ["1", "2", "3", "4"]) {
          put(`f${n}.txt`, n);
          commitAll(n);
        }
        git(["switch", "-q", "main"]);
        const before = head();
        // Each look at the clock costs five seconds: no single read is late, and
        // thirty seconds pass a few reads in.
        let clockNow = Date.now();
        let looks = 0;
        const clock = spyOn(Date, "now").mockImplementation(() => {
          looks += 1;
          clockNow += 5_000;
          return clockNow;
        });
        let out: string;
        try {
          out = await text(gitCherryPick, { refs: ["main..s"] }, roots());
        } finally {
          clock.mockRestore();
        }
        expect(looks).toBeGreaterThan(6);
        expect(out).toContain(REFUSED);
        expect(out).toContain("a pick whose changes could not be listed");
        expect(head()).toBe(before);
        expect(existsSync(join(ws, "f1.txt"))).toBe(false);
      },
      CHAIN_MS,
    );

    test(
      "a list cut off at the output cap is refused",
      async () => {
        seedRepo({ tracked: true });
        const blob = git(["hash-object", "-w", "--stdin"], { stdin: "x\n" }).trim();
        const entries = Array.from(
          { length: 5_000 },
          (_, i) => `100644 ${blob}\tdeep/${"n".repeat(90)}${i}\n`,
        ).join("");
        git(["update-ref", "refs/heads/big", commitOver(entries, "big")]);
        await refused("GitSwitch", { branch: "big" }, "a switch whose changes could not be listed");
        expect(existsSync(join(ws, "deep"))).toBe(false);
      },
      CHAIN_MS,
    );

    test(
      "a treeless clone's switch across trees a read will not fetch is refused",
      async () => {
        const src = join(base, "src");
        mkdirSync(src);
        git(["init", "-q", "-b", "main", "."], { cwd: src });
        git(["config", "uploadpack.allowFilter", "true"], { cwd: src });
        writeFileSync(join(src, "a.txt"), "a\n");
        git(["add", "-A"], { cwd: src });
        git(["commit", "-q", "-m", "base"], { cwd: src });
        git(["switch", "-q", "-c", "b"], { cwd: src });
        writeFileSync(join(src, "a.txt"), "b\n");
        git(["add", "-A"], { cwd: src });
        git(["commit", "-q", "-m", "b"], { cwd: src });
        git(["switch", "-q", "main"], { cwd: src });
        git(["clone", "-q", "--filter=tree:0", "--no-local", `file://${src}`, ws], { cwd: base });
        git(["fetch", "-q", "origin", "b:refs/heads/b"]);
        // What a read pins, here for the writes too: nothing reaches the promisor.
        setVar("GIT_NO_LAZY_FETCH", "1");
        setVar("GIT_ALLOW_PROTOCOL", "");
        const out = await text(gitSwitch, { branch: "b" }, roots());
        expect(out).toContain(REFUSED);
        expect(out).toContain("a switch whose changes could not be listed");
        expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
      },
      CHAIN_MS,
    );
  });

  describe("a git that cannot run the merge first runs the real one with rename detection off", () => {
    /** A `git` first on PATH that answers as `shell` says, and is the real one otherwise. */
    const gitThatAnswers = (shell: string): void => {
      const real = Bun.which("git");
      expect(real).not.toBeNull();
      const bin = join(base, "older-git");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n${shell}\n  esac\ndone\nexec "${real}" "$@"\n`,
      );
      chmodSync(join(bin, "git"), 0o755);
      setVar("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
    };
    const NO_MERGE_BASE = `    version) echo "git version 2.39.5"; exit 0 ;;
    merge-tree) echo "usage: git merge-tree" >&2; exit 129 ;;`;
    const NO_BLOB = `    merge-tree) echo "fatal: could not fetch" >&2; exit 128 ;;`;
    const NO_OPTION = `    merge-tree) echo "usage: git merge-tree" >&2; exit 129 ;;`;
    const NO_ANSWER = `    version) echo "not a version"; exit 0 ;;`;

    for (const [label, shell] of [
      ["older than 2.40", NO_MERGE_BASE],
      ["whose merge stops on a blob or a tree it will not take", NO_BLOB],
      ["whose merge does not take the option", NO_OPTION],
      ["whose version could not be read", NO_ANSWER],
    ] as const) {
      test(
        `${label}: a pick across a rename reports a conflict and the settings file stays`,
        async () => {
          seedRepo({ tracked: true });
          await branchRenamingSettings();
          await call("GitAdd", { cwd: "wt", paths: ["."] });
          await call("GitCommit", { cwd: "wt", message: "c" });
          gitThatAnswers(shell);
          const out = JSON.parse(await call("GitCherryPick", { refs: ["b"] })) as {
            picked: boolean;
            conflicted: string[];
          };
          expect(out.picked).toBe(false);
          expect(out.conflicted).toEqual(["foo.json"]);
          expect(settingsNow()).toBe(DENIES);
          expect(rulesNow()).toEqual(GUARD_RULE);
        },
        CHAIN_MS,
      );

      test(
        `${label}: a pop across a rename reports a conflict and the settings file stays`,
        async () => {
          seedRepo({ tracked: true });
          await branchRenamingSettings();
          await call("GitStashPush", { cwd: "wt", message: "m" });
          gitThatAnswers(shell);
          const out = await call("GitStashPop", {});
          expect(out).toContain("CONFLICT");
          expect(git(["status", "--porcelain"])).toContain("DU foo.json");
          expect(settingsNow()).toBe(DENIES);
          expect(rulesNow()).toEqual(GUARD_RULE);
        },
        CHAIN_MS,
      );
    }

    test(
      "older than 2.40: a commit's own names still refuse a pick, a pop and a switch",
      async () => {
        seedRepo({ tracked: true });
        await branchChangingSettings();
        await call("Edit", {
          path: join("wt", SETTINGS_FILE),
          oldString: "alwaysAllow",
          newString: "alwaysAsk",
        });
        await call("GitStashPush", { cwd: "wt", message: "m", paths: [SETTINGS_FILE] });
        gitThatAnswers(NO_MERGE_BASE);
        await refused("GitCherryPick", { refs: ["b"] }, ".crewhaus/settings.json");
        await refused("GitStashPop", {}, ".crewhaus/settings.json");
        await refused("GitSwitch", { branch: "b" }, ".crewhaus/settings.json");
      },
      CHAIN_MS,
    );

    test(
      "older than 2.28, which has no `--no-relative`: a switch is still read, and still runs",
      async () => {
        seedRepo({ tracked: true });
        await branchChangingSettings();
        git(["branch", "plain", "main"]);
        gitThatAnswers(`    --no-relative) echo "usage: git diff" >&2; exit 129 ;;
    version) echo "git version 2.25.1"; exit 0 ;;
    merge-tree) exit 129 ;;`);
        await refused("GitSwitch", { branch: "b" }, ".crewhaus/settings.json");
        expect(JSON.parse(await call("GitSwitch", { branch: "plain" }))).toMatchObject({
          switched: true,
        });
      },
      CHAIN_MS,
    );

    test(
      "a range is replayed oldest first, as cherry-pick walks it",
      async () => {
        seedRepo({ tracked: true });
        git(["switch", "-q", "-c", "s"]);
        const commits: string[] = [];
        for (const n of ["1", "2", "3"]) {
          put(`f${n}.txt`, n);
          commitAll(n);
          commits.push(head());
        }
        git(["switch", "-q", "main"]);
        const log = join(base, "merges.log");
        gitThatAnswers(`    merge-tree) echo "$*" >> "${log}" ;;`);
        expect(JSON.parse(await call("GitCherryPick", { refs: ["main..s"] }))).toMatchObject({
          picked: true,
        });
        const replayed = readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split(" ").at(-1));
        expect(replayed).toEqual(commits);
      },
      CHAIN_MS,
    );

    test(
      "a read past its deadline is not an answer: no entry, no such branch",
      async () => {
        seedRepo({ tracked: true });
        put("a.txt", "dirty\n");
        git(["stash", "push", "-q", "-m", "m"]);
        git(["branch", "b"]);
        gitThatAnswers(`    *'^{commit}') exec sleep 30 ;;`);
        const pop = await text(gitStashPop, { timeout: 3_000 }, roots());
        expect(pop).toContain("a stash whose changes could not be listed");
        const moved = await text(gitSwitch, { branch: "b", timeout: 3_000 }, roots());
        expect(moved).toContain("a switch whose changes could not be listed");
        expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("hi\n");
      },
      CHAIN_MS,
    );

    test(
      "a merge that fails any other way is refused, not retried without renames",
      async () => {
        seedRepo({ tracked: true });
        await branchChangingSettings();
        gitThatAnswers("    merge-tree) exit 137 ;;");
        await refused("GitCherryPick", { refs: ["b"] }, "a pick whose changes could not be listed");
      },
      CHAIN_MS,
    );

    test(
      "a merge past its deadline is refused, not retried without renames",
      async () => {
        seedRepo({ tracked: true });
        put("b.txt", "b\n");
        commitAll("b");
        git(["branch", "b"]);
        git(["reset", "-q", "--hard", "HEAD^"]);
        gitThatAnswers("    merge-tree) exec sleep 30 ;;");
        const out = await text(gitCherryPick, { refs: ["b"], timeout: 3_000 }, roots());
        expect(out).toContain(REFUSED);
        expect(out).toContain("a pick whose changes could not be listed");
        expect(existsSync(join(ws, "b.txt"))).toBe(false);
      },
      CHAIN_MS,
    );
  });

  test(
    "the roots are whatever the run carries: a tracked file named as one stops a switch and a pick across it",
    async () => {
      seedRepo({ tracked: true });
      // A spec in the working directory puts its build output among the roots.
      put("crewhaus.yaml", "name: x\n");
      put(".npmrc", "one\n");
      put(".env.development", "ONE=1\n");
      put("dist/out.js", "one\n");
      put("site.conf", "one\n");
      commitAll("tracked config");
      const changing = (branch: string, file: string, body: string): void => {
        git(["switch", "-q", "-c", branch, "main"]);
        put(file, body);
        commitAll(branch);
      };
      changing("b", ".npmrc", "two\n");
      changing("e", ".env.development", "ONE=2\n");
      changing("d", "dist/out.js", "two\n");
      changing("s", "site.conf", "two\n");
      git(["switch", "-q", "main"]);
      // The run's own roots name these files; none is added to them here.
      const own = roots();
      const named = own
        .filter((root) => !isAbsolute(root))
        .map((root) => root.split(sep).join("/"));
      for (const root of [".npmrc", ".env.development", "dist"]) {
        expect({ root, carried: named.includes(root) }).toEqual({ root, carried: true });
      }
      for (const [tool, input, name] of [
        [gitSwitch, { branch: "b" }, ".npmrc"],
        [gitCherryPick, { refs: ["e"] }, ".env.development"],
        [gitCherryPick, { refs: ["d"] }, "dist/out.js"],
      ] as const) {
        const out = await text(tool, input, own);
        expect(out).toContain(REFUSED);
        expect(out).toContain(`the change to ${name}`);
      }
      expect(readFileSync(join(ws, ".npmrc"), "utf8")).toBe("one\n");
      expect(readFileSync(join(ws, ".env.development"), "utf8")).toBe("ONE=1\n");
      expect(readFileSync(join(ws, "dist", "out.js"), "utf8")).toBe("one\n");
      // A root a run carries beyond these stops the same calls on its file.
      const carried = [...own, "site.conf"];
      for (const [tool, input] of [
        [gitSwitch, { branch: "s" }],
        [gitCherryPick, { refs: ["s"] }],
      ] as const) {
        const out = await text(tool, input, carried);
        expect(out).toContain(REFUSED);
        expect(out).toContain("the change to site.conf");
      }
      expect(readFileSync(join(ws, "site.conf"), "utf8")).toBe("one\n");
      // A run that carries no root for that file runs the same call.
      expect(JSON.parse(await text(gitSwitch, { branch: "s" }, own))).toMatchObject({
        switched: true,
      });
      expect(readFileSync(join(ws, "site.conf"), "utf8")).toBe("two\n");
    },
    CHAIN_MS,
  );

  test("the manifest declares GitWorktreeAdd's path as a directory the floor reads", () => {
    expect(TOOL_REGISTRY["gitWorktreeAdd"]?.operativeArgs?.[0]).toEqual({
      field: "path",
      kind: "path",
      beneath: "all",
    });
  });
});
