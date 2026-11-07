/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 1, §5.2, §5.3) —
 * where the runtime keeps its own record of a run, and the files that
 * control it. The run hands these roots to permission-engine's
 * runtime-state floor (`EvaluateOptions.protectedRoots`), which no rule can
 * lift: it denies a call that writes inside one. `Bash` and `RunCommand`
 * remain outside what it can see.
 *
 * - The record the gates read as evidence: the session event logs (every
 *   `tool_use` input and `tool_result` output, verbatim — the evidence the
 *   provability gate grounds a claim on and `continuity.proof` resolves),
 *   the tool results the runtime spilled to a file (the whole output a long
 *   fetch grounds on, whose head alone the log holds) and the proof bundles
 *   (the audit artifact). Evidence is checked, never believed, only while
 *   the agent cannot write it: a `Write` that appends a hand-made fetch to
 *   the log would ground any text under any URL.
 * - The files that control the run, which decide what the agent may do
 *   next: the harness's run directory (`.crewhaus/run`: the runfiles, logs
 *   and control files a daemon keeps there), its settings file
 *   (`.crewhaus/settings.json`: permission rules, runtime hooks and the
 *   manager's spawn hooks) and Hangar's directory (the Hangar root, where
 *   `crewhaus hangar` keeps its token and settings). CrewHaus's own code
 *   still writes them; the floor applies to tool calls only.
 *
 * Each root is given every way a path the canonicaliser produces can spell
 * it: absolute as resolved, absolute with symlinks followed (macOS's
 * `/var` → `/private/var`; a root that does not exist yet is followed as far
 * as it does), and workspace-relative when it lies inside the working
 * directory, as resolved and with links followed (what a tool that declares no
 * operative arguments carries, and what the floor compares a directory the
 * call acts beneath with).
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_ROOT_DIR } from "@crewhaus/event-log";
import { hangarStateRoots } from "@crewhaus/harness-registry";
import type { Tenant } from "@crewhaus/tenancy";
import { DEFAULT_ROOT_DIR as TOOL_RESULTS_ROOT_DIR } from "@crewhaus/tool-result-store";
import { protectedRootHolding } from "@crewhaus/tool-safety/fs";

/**
 * The files that control a run, relative to its working directory: the run
 * directory, all of it, and the settings file, exactly that file (its
 * neighbours, such as `settings.json.bak` or `.crewhaus/notes.md`, are not
 * protected).
 */
const CONTROL_FILES: readonly string[] = [
  join(".crewhaus", "run"),
  join(".crewhaus", "settings.json"),
];

/** `path` with every symlink on its existing part followed, or `undefined` when nothing of it exists. */
function followed(path: string): string | undefined {
  const rest: string[] = [];
  let head = path;
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      const real = realpathSync(head);
      // Rebuilt one name at a time: the list is never spread into join.
      return rest.reduceRight((built, name) => join(built, name), real);
    } catch {
      const parent = dirname(head);
      if (parent === head) return undefined;
      rest.push(basename(head));
      head = parent;
    }
  }
  return undefined;
}

/** Is `inner` `outer` itself, or inside it? */
function within(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `path` relative to `cwd` when it lies strictly inside it. */
function insideSpelling(cwd: string, path: string): string | undefined {
  const rel = relative(cwd, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? rel
    : undefined;
}

/** The run's record, unspelled: its session logs, spilled tool results and proof bundles. */
function recordRootPaths(
  sessionRootDir: string | undefined,
  tenant: Tenant | undefined,
  cwd: string,
): string[] {
  const sessions = resolve(cwd, sessionRootDir ?? DEFAULT_ROOT_DIR);
  const toolResults = resolve(cwd, tenant?.toolResultRoot ?? TOOL_RESULTS_ROOT_DIR);
  const proofs =
    tenant !== undefined
      ? resolve(cwd, tenant.sessionRoot, "..", "proofs")
      : resolve(cwd, ".crewhaus", "proofs");
  return [sessions, toolResults, proofs];
}

/** Every way the canonicaliser can spell `root`, added to `into`. */
function addSpellings(into: Set<string>, root: string, cwd: string): void {
  into.add(root);
  const real = followed(root);
  if (real !== undefined) into.add(real);
  const rel = insideSpelling(cwd, root);
  if (rel !== undefined) into.add(rel);
  // A root reached through a link has a workspace-relative name of its own.
  const realRel = real !== undefined ? insideSpelling(followed(cwd) ?? cwd, real) : undefined;
  if (realRel !== undefined) into.add(realRel);
}

/**
 * The runtime-state roots of a run, in three groups.
 *
 * - The run's record: its session-log root (`sessionRootDir` as
 *   `runChatLoop` resolved it — the tenant's, `CREWHAUS_SESSION_DIR`, or
 *   event-log's default), its tool-result spill root (the tenant's
 *   `toolResultRoot`, else `<cwd>/.crewhaus/tool-results`, where the runtime
 *   saves an output too long for the log — `@crewhaus/tool-result-store`) and
 *   its proofs root (the tenant's `proofs/`, else `<cwd>/.crewhaus/proofs`,
 *   where every spec's bundles and artifacts live).
 * - The files that control the run, against `cwd` whatever the tenant:
 *   `.crewhaus/run` and `.crewhaus/settings.json`. They are the files the
 *   run loads its settings layer and hooks from, and the supervisor keeps
 *   its run files in, both in the harness directory the run works in.
 * - Hangar's directory: every Hangar root `env` names (`CREWHAUS_HANGAR_ROOT`,
 *   `<registryRoot>/hangar`) and `~/.crewhaus/hangar` always
 *   (`hangarStateRoots` in `@crewhaus/harness-registry`, beside the
 *   `resolveHangarRoot` the CLI and the fleet tools use), so a variable can
 *   add a protected root and never move one. `env` is read for those two
 *   variables alone; the default follows the home directory (`homedir()`),
 *   as the Hangar server's own fallback does.
 *
 * The floor reads calls that write. A read of the run's record, a spilled
 * output's parts included, goes on as before.
 */
export function runtimeStateRoots(
  sessionRootDir: string | undefined,
  tenant: Tenant | undefined,
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  /**
   * Each group of roots, and what becomes of a root that holds the working
   * directory itself. A new kind of root is one more entry here.
   */
  const groups: ReadonlyArray<{
    readonly roots: readonly string[];
    readonly holdingCwd: "skip" | "protect";
  }> = [
    // The run's record. A root that holds the working directory itself (a
    // session dir pointed at the workspace) would refuse every write the
    // agent makes: it is left to the permission rules rather than walled
    // off whole.
    { roots: recordRootPaths(sessionRootDir, tenant, cwd), holdingCwd: "skip" },
    // The files that control the run: the working directory's, whatever the
    // tenant. They lie inside it, so they never hold it.
    { roots: CONTROL_FILES.map((file) => resolve(cwd, file)), holdingCwd: "protect" },
    // Hangar's directory, every root the environment names and the default.
    // One that holds the working directory stays protected: the floor refuses
    // a run inside Hangar's directory that writes there.
    { roots: hangarStateRoots(env), holdingCwd: "protect" },
  ];
  const roots = new Set<string>();
  for (const group of groups) {
    for (const root of group.roots) {
      if (group.holdingCwd === "skip" && within(cwd, root)) continue;
      addSpellings(roots, root, cwd);
    }
  }
  return [...roots];
}

/**
 * The roots of the run's record alone, spelled as {@link runtimeStateRoots}
 * spells them: where a tool's own store may lie with the floor reading its own
 * format rather than the path ({@link relocatingFieldLeftOut}).
 */
export function runtimeRecordRoots(
  sessionRootDir: string | undefined,
  tenant: Tenant | undefined,
  cwd: string = process.cwd(),
): string[] {
  const roots = new Set<string>();
  for (const root of recordRootPaths(sessionRootDir, tenant, cwd)) {
    if (!within(cwd, root)) addSpellings(roots, root, cwd);
  }
  return [...roots];
}

/**
 * Does the floor leave out this field declared `relocates`? A store the tool
 * reads whole (`beneath`) and a service it is moved off (`url`) are not where
 * it writes, so they stay out. A path is the store the call writes: it stays
 * out only while it lies in the run's record (EmitTraceEvent's namespaced
 * `custom.*` lines in a session log) and in no other root. The value is the
 * one the call names, else the field's default, and anything else the floor
 * reads as it reads any path. A link is followed, so a store is placed by where
 * it leads too.
 */
export function relocatingFieldLeftOut(
  arg: {
    readonly field: string;
    readonly kind: string;
    readonly default?: string;
    readonly beneath?: unknown;
  },
  parsedInput: unknown,
  recordRoots: readonly string[],
  roots: readonly string[],
  cwd: string = process.cwd(),
): boolean {
  if (arg.kind !== "path" || arg.beneath !== undefined) return true;
  // A field read out of a nested value is not one this can place.
  if (arg.field.includes(".")) return false;
  const given =
    typeof parsedInput === "object" && parsedInput !== null
      ? (parsedInput as Record<string, unknown>)[arg.field]
      : undefined;
  const store = given === undefined || given === null ? arg.default : given;
  if (typeof store !== "string" || store === "") return false;
  if (protectedRootHolding(store, recordRoots, cwd) === undefined) return false;
  const others = roots.filter((root) => !recordRoots.includes(root));
  return protectedRootHolding(store, others, cwd) === undefined;
}
