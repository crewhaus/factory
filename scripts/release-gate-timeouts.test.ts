/**
 * A release waits on every job of every workflow its gate jobs reuse
 * (release.yml's `build` needs `ci` and `smoke-runtime`, each a `uses:` of a
 * whole workflow), non-gating jobs included: `continue-on-error` keeps a red
 * job from failing the gate, not from being waited for. A job with no
 * `timeout-minutes` that hangs therefore holds a tag for GitHub's 6 h default,
 * which is what bun 1.4.0's wedged test runner did to CI. So every job in a
 * reused workflow declares a bound.
 *
 * The reused workflows are read from release.yml, not listed here.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);
const WORKFLOWS = join(ROOT, ".github", "workflows");

type Workflow = { jobs: Record<string, { uses?: string; "timeout-minutes"?: number }> };
const load = (file: string): Workflow =>
  Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;

test("every job a release waits on has a timeout", () => {
  const reused = Object.values(load("release.yml").jobs)
    .map((job) => job.uses)
    .filter((u): u is string => u?.startsWith("./.github/workflows/") === true)
    .map((u) => u.slice("./.github/workflows/".length));
  expect(reused.sort()).toEqual(["ci.yml", "smoke-runtime.yml"]);
  const unbounded: string[] = [];
  let jobs = 0;
  for (const file of reused) {
    for (const [name, job] of Object.entries(load(file).jobs)) {
      jobs += 1;
      const minutes = job["timeout-minutes"];
      if (typeof minutes !== "number" || minutes <= 0 || minutes > 120) {
        unbounded.push(`${file}: ${name}`);
      }
    }
  }
  expect(unbounded).toEqual([]);
  // ci, windows-supervision, windows-tools and smoke-runtime.
  expect(jobs).toBe(4);
});
