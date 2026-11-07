/**
 * Whether the accessibility sweep has to run for a pull request's changes.
 *
 * Reads NUL-separated paths on stdin (`git diff --name-only --no-renames -z`) and
 * writes `axe=true|false` to `$GITHUB_OUTPUT`. A failed or empty diff arrives here
 * as nothing at all, and could not determine is not no: the sweep runs.
 */
import { closeSync, openSync, writeSync } from "node:fs";

const SCOPED_PREFIXES = ["packages/hangar-ui/", "packages/hangar-server/", "packages/hangar-e2e/"];
const SCOPED_FILES = [".github/workflows/ci.yml"];

/** True when these changes reach the console or the sweep's own code. */
export function axeSweepInScope(paths: readonly string[] | null): boolean {
  if (paths === null || paths.length === 0) return true;
  return paths.some(
    (path) =>
      SCOPED_FILES.includes(path) || SCOPED_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
}

if (import.meta.main) {
  const paths = (await Bun.stdin.text()).split("\0").filter((path) => path !== "");
  const line = `axe=${axeSweepInScope(paths)}\n`;
  process.stdout.write(line);
  const output = process.env["GITHUB_OUTPUT"];
  if (output !== undefined && output !== "") {
    const fd = openSync(output, "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  }
}
