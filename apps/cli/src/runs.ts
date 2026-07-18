/**
 * Loop contract 0.4 (Batch F, item 7, CLI half) — `crewhaus runs resume
 * <session>`. The engine-free helpers: resolving which spec backs a resumed
 * session (the session store persists only name/target/model, not the spec
 * path, so the CLI reconstructs the agent from a spec on disk) and validating
 * the resume target. The runtime half — replaying the transcript and
 * continuing the loop — is `runChatLoop({ resume })` in runtime-core, which the
 * `run --resume` path already drives; `runs resume` is the dedicated verb for
 * re-driving a session (e.g. one a headless run PARKED on a pending approval)
 * after the approval was resolved out of band.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export class RunsError extends Error {
  override readonly name = "RunsError";
}

export const RUNS_SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

/** True for a well-formed `sess_<16 hex>` session id. */
export function isRunsSessionId(value: string): boolean {
  return RUNS_SESSION_ID_REGEX.test(value);
}

/**
 * Resolve the spec backing a `runs resume`: the explicit `--spec` when given,
 * else `crewhaus.yaml` in the cwd (the standalone-harness convention — sessions
 * live under the directory you run from, so its spec is the natural default).
 * Returns an ABSOLUTE path. Throws `RunsError` — naming the candidate(s) it
 * looked for — when the chosen spec does not exist. `exists` is injected so the
 * resolution is unit-testable without touching the filesystem.
 */
export function resolveRunsResumeSpecPath(
  specFlag: string | undefined,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (specFlag !== undefined) {
    const abs = isAbsolute(specFlag) ? specFlag : resolve(cwd, specFlag);
    if (!exists(abs)) {
      throw new RunsError(`--spec not found: ${abs}`);
    }
    return abs;
  }
  const fallback = join(cwd, "crewhaus.yaml");
  if (!exists(fallback)) {
    throw new RunsError(
      `no --spec given and no crewhaus.yaml in ${cwd}. Pass --spec <path>, or run from the harness directory that owns the session's .crewhaus/sessions/.`,
    );
  }
  return fallback;
}
