/**
 * The control-plane packages that take file locks or exclusive-create claims are
 * tested on Windows, where those primitives behave differently (a held file
 * cannot be renamed or removed, and `startsWith(root + "/")` containment never
 * matches a `D:\` path). ci.yml's `windows-supervision` job runs their suites,
 * gating, by a `--filter` per package.
 *
 * The list below is the written-down set, and this test holds the job's filter
 * equal to it and every listed package present. A control-plane package with
 * locks or O_EXCL claims adds itself here and to the job's filter in the same PR.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);

const WINDOWS_CONTROL_PLANE = [
  "harness-supervisor",
  "hangar-server",
  "control-records",
  "control-service",
  "people",
  "people-service",
] as const;

type Workflow = { jobs: Record<string, { steps?: { run?: string }[] }> };

/** The package names in a command's `--filter '@crewhaus/<x>'` tokens. */
const filterNames = (run: string): string[] =>
  [...run.matchAll(/--filter '@crewhaus\/([^']+)'/g)].map((m) => m[1] as string);

/** What keeps the job's filter from being exactly the list, each problem naming the package. */
function windowsGateProblems(
  filterRun: string,
  list: readonly string[],
  packageExists: (name: string) => boolean,
): string[] {
  const filtered = filterNames(filterRun);
  const problems: string[] = [];
  for (const name of list) {
    if (!filtered.includes(name)) {
      problems.push(
        `@crewhaus/${name} is on the Windows control-plane list, but windows-supervision does not test it`,
      );
    }
    if (!packageExists(name)) problems.push(`packages/${name} does not exist`);
  }
  for (const name of filtered) {
    if (!list.includes(name)) {
      problems.push(
        `windows-supervision tests @crewhaus/${name}, which the control-plane list does not name`,
      );
    }
  }
  return problems;
}

const exists = (name: string) => existsSync(join(ROOT, "packages", name, "package.json"));

describe("the windows-supervision job tests the control-plane list", () => {
  const ci = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
  ) as Workflow;
  const runs = (ci.jobs["windows-supervision"]?.steps ?? []).flatMap((s) =>
    s.run?.includes("--filter") ? [s.run] : [],
  );

  test("one test step, whose filter is exactly the list, every package present", () => {
    expect(runs).toHaveLength(1);
    const run = runs[0] as string;
    expect(filterNames(run)).toHaveLength(WINDOWS_CONTROL_PLANE.length);
    expect(windowsGateProblems(run, WINDOWS_CONTROL_PLANE, exists)).toEqual([]);
  });

  test("planted: a filter with one name removed names it", () => {
    const run = runs[0] as string;
    const without = run.replace(" --filter '@crewhaus/control-records'", "");
    expect(without).not.toBe(run);
    expect(windowsGateProblems(without, WINDOWS_CONTROL_PLANE, exists)).toEqual([
      "@crewhaus/control-records is on the Windows control-plane list, but windows-supervision does not test it",
    ]);
  });

  test("planted: a listed package that does not exist, and a filtered one the list does not name", () => {
    const run = "bun --filter '@crewhaus/a' --filter '@crewhaus/b' test";
    expect(windowsGateProblems(run, ["a", "gone"], (n) => n === "a")).toEqual([
      "@crewhaus/gone is on the Windows control-plane list, but windows-supervision does not test it",
      "packages/gone does not exist",
      "windows-supervision tests @crewhaus/b, which the control-plane list does not name",
    ]);
  });
});
