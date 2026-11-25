/**
 * `@crewhaus/session-store/erasure`: removing session summaries for good, driven only by the
 * erasure door. A summary outlives its session log on purpose; {@link purgeSummaries} acts
 * only on a grant the door minted, whose scope is this `.crewhaus` directory and that names
 * every session. Each path is resolved inside the directory before it is unlinked, and a
 * re-run finds nothing. The session log itself is not touched here.
 */
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ErasureGrant, erasureTargets } from "@crewhaus/control-contract/knowledge";
import { CrewhausError } from "@crewhaus/errors";
import { resolveContained } from "@crewhaus/tool-safety/fs";
import { SESSIONS_INDEX_DIRNAME, SESSION_ID_RE } from "./index";

export class SessionErasureError extends CrewhausError {
  override readonly name = "SessionErasureError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Where one summary is, inside `crewhausDir`; `undefined` when there is none. */
function summaryAt(crewhausDir: string, id: string): string | undefined {
  const rel = join(SESSIONS_INDEX_DIRNAME, `${id}.json`);
  const at = resolveContained(crewhausDir, rel, { followLeaf: false });
  if (!at.ok) {
    if (at.code === "not-found") return undefined;
    throw new SessionErasureError(`refusing to erase the summary ${rel}: ${at.reason}`);
  }
  try {
    if (lstatSync(at.real).isDirectory()) {
      throw new SessionErasureError(`refusing to erase the summary ${rel}: it is a directory`);
    }
    return at.real;
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Which of these sessions have a summary. Reads only. */
export function summariesOf(crewhausDir: string, ids: readonly string[]): readonly string[] {
  const root = resolve(crewhausDir);
  return ids.filter((id) => SESSION_ID_RE.test(id) && summaryAt(root, id) !== undefined);
}

/** Remove these sessions' summaries. Answers how many there were. */
export async function purgeSummaries(
  crewhausDir: string,
  ids: readonly string[],
  grant: ErasureGrant,
): Promise<number> {
  const root = resolve(crewhausDir);
  const targets = erasureTargets(grant, {
    store: "summaries",
    sameRoot: (given) => sameDir(given, root),
  });
  if (targets === undefined) {
    throw new SessionErasureError("this erasure does not cover these session summaries");
  }
  for (const id of ids) {
    if (!SESSION_ID_RE.test(id) || !targets.has(id)) {
      throw new SessionErasureError("this erasure does not name every session it was given");
    }
  }
  let removed = 0;
  for (const id of new Set(ids)) {
    const real = summaryAt(root, id);
    if (real === undefined) continue;
    unlinkSync(real);
    removed += 1;
  }
  return removed;
}
