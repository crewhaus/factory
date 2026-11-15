/**
 * A daemon's run bearer secrets, and their removal from an archived state
 * directory. Both retire paths use it: `crewhaus retire` and the
 * `HarnessRetire` tool leave these files out of the state they keep in the
 * archive, and `crewhaus state backup` leaves them out of a backup.
 */
import { lstatSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A daemon's run bearer secrets, relative to the state directory. A daemon
 * makes each again at every start, so a restore loses nothing without them.
 */
export const RUN_TOKEN_FILES: readonly string[] = [
  "run/control-token",
  "run/gateway-jwt-secret",
  "run/mcp-token",
];

/**
 * Remove {@link RUN_TOKEN_FILES} from a state directory that is no longer
 * live (the copy `crewhaus retire` and the `HarnessRetire` tool keep in the
 * archive), so it holds no run token. A daemon makes each again at start.
 * Only a file under a real `run/` directory is removed (a link is removed,
 * never followed). Returns the removed paths, sorted.
 */
export function removeRunTokens(stateDir: string): string[] {
  const removed: string[] = [];
  for (const rel of RUN_TOKEN_FILES) {
    const parent = join(stateDir, dirname(rel));
    const path = join(stateDir, rel);
    try {
      if (!lstatSync(parent).isDirectory()) continue;
      const st = lstatSync(path);
      if (!st.isFile() && !st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    rmSync(path, { force: true });
    removed.push(rel);
  }
  return removed.sort();
}
