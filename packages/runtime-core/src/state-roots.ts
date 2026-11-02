/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 1, §5.2, §5.3) —
 * where the runtime keeps its own record of a run, and the files that
 * control it. The run hands these roots to permission-engine's
 * runtime-state floor (`EvaluateOptions.protectedRoots`), which no rule can
 * lift, so no tool call the agent makes writes inside one.
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
 *   manager's spawn hooks) and Home's directory (the Hangar root, where
 *   `crewhaus hangar` keeps its token and settings). CrewHaus's own code
 *   still writes them; the floor applies to tool calls only.
 *
 * Each root is given every way a path the canonicaliser produces can spell
 * it: absolute as resolved, absolute with symlinks followed (macOS's
 * `/var` → `/private/var`; a root that does not exist yet is followed as far
 * as it does), and workspace-relative when it lies inside the working
 * directory (what a tool that declares no operative arguments carries).
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_ROOT_DIR } from "@crewhaus/event-log";
import { hangarStateRoots } from "@crewhaus/harness-registry";
import type { Tenant } from "@crewhaus/tenancy";
import { DEFAULT_ROOT_DIR as TOOL_RESULTS_ROOT_DIR } from "@crewhaus/tool-result-store";

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
 * - Home's directory: every Hangar root `env` names (`CREWHAUS_HANGAR_ROOT`,
 *   `<registryRoot>/hangar`) and `~/.crewhaus/hangar` always
 *   (`hangarStateRoots` in `@crewhaus/harness-registry`, beside the
 *   `resolveHangarRoot` the CLI and the fleet tools use), so a variable can
 *   add a protected root and never move one. `env` is read for those two
 *   variables alone; the default follows the home directory (`homedir()`),
 *   as the Hangar server's own fallback does.
 *
 * The floor is on writes only: the model still reads every one of them,
 * a spilled output's parts included.
 */
export function runtimeStateRoots(
  sessionRootDir: string | undefined,
  tenant: Tenant | undefined,
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const sessions = resolve(cwd, sessionRootDir ?? DEFAULT_ROOT_DIR);
  const toolResults = resolve(cwd, tenant?.toolResultRoot ?? TOOL_RESULTS_ROOT_DIR);
  const proofs =
    tenant !== undefined
      ? resolve(cwd, tenant.sessionRoot, "..", "proofs")
      : resolve(cwd, ".crewhaus", "proofs");
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
    { roots: [sessions, toolResults, proofs], holdingCwd: "skip" },
    // The files that control the run: the working directory's, whatever the
    // tenant. They lie inside it, so they never hold it.
    { roots: CONTROL_FILES.map((file) => resolve(cwd, file)), holdingCwd: "protect" },
    // Home's directory, every root the environment names and the default.
    // One that holds the working directory stays protected: a run that works
    // inside Home's directory writes nothing there.
    { roots: hangarStateRoots(env), holdingCwd: "protect" },
  ];
  const roots = new Set<string>();
  for (const group of groups) {
    for (const root of group.roots) {
      if (group.holdingCwd === "skip" && within(cwd, root)) continue;
      roots.add(root);
      const real = followed(root);
      if (real !== undefined) roots.add(real);
      const rel = relative(cwd, root);
      if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        roots.add(rel);
      }
    }
  }
  return [...roots];
}
