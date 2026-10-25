/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 1, §5.2, §5.3) —
 * where the runtime keeps its own record of a run: the session event logs
 * (every `tool_use` input and `tool_result` output, verbatim — the evidence
 * the provability gate grounds a claim on and `continuity.proof` resolves),
 * the tool results the runtime spilled to a file (the whole output a long
 * fetch grounds on, whose head alone the log holds) and the proof bundles
 * (the audit artifact). Evidence is checked, never
 * believed, only while the agent cannot write it: a `Write` that appends a
 * hand-made fetch to the log would ground any text under any URL. The run
 * hands these roots to permission-engine's runtime-state floor
 * (`EvaluateOptions.protectedRoots`), which no rule can lift.
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
import type { Tenant } from "@crewhaus/tenancy";
import { DEFAULT_ROOT_DIR as TOOL_RESULTS_ROOT_DIR } from "@crewhaus/tool-result-store";

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

/**
 * The runtime-state roots of a run: its session-log root (`sessionRootDir`
 * as `runChatLoop` resolved it — the tenant's, `CREWHAUS_SESSION_DIR`, or
 * event-log's default), its tool-result spill root (the tenant's
 * `toolResultRoot`, else `<cwd>/.crewhaus/tool-results`, where the runtime
 * saves an output too long for the log — `@crewhaus/tool-result-store`) and
 * its proofs root (the tenant's `proofs/`, else `<cwd>/.crewhaus/proofs`,
 * where every spec's bundles and artifacts live). The floor is on writes
 * only: the model still reads a spilled output's parts.
 */
export function runtimeStateRoots(
  sessionRootDir: string | undefined,
  tenant: Tenant | undefined,
  cwd: string = process.cwd(),
): string[] {
  const sessions = resolve(cwd, sessionRootDir ?? DEFAULT_ROOT_DIR);
  const toolResults = resolve(cwd, tenant?.toolResultRoot ?? TOOL_RESULTS_ROOT_DIR);
  const proofs =
    tenant !== undefined
      ? resolve(cwd, tenant.sessionRoot, "..", "proofs")
      : resolve(cwd, ".crewhaus", "proofs");
  const roots = new Set<string>();
  for (const root of [sessions, toolResults, proofs]) {
    // A root that holds the working directory itself (a session dir pointed
    // at the workspace) would refuse every write the agent makes: it is
    // left to the permission rules rather than walled off whole.
    const back = relative(root, cwd);
    if (back === "" || (back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back))) {
      continue;
    }
    roots.add(root);
    const real = followed(root);
    if (real !== undefined) roots.add(real);
    const rel = relative(cwd, root);
    if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      roots.add(rel);
    }
  }
  return [...roots];
}
