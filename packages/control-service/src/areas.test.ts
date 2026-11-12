import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AREA_RUNTIMES, compositionProblems } from "./areas";
import { CORE_RUNTIME } from "./core-runtime";
import type { AreaRuntime, Executor } from "./executor";
import { IDENTITY, fakeProbe, removeTempDirs, tempDir } from "./test-helpers";
import { wireControl } from "./wire";

afterAll(removeTempDirs);

const noop: Executor = async () => ({ state: "succeeded" });

function wireWith(areas: readonly AreaRuntime[]) {
  return () =>
    wireControl(
      {
        hangarRoot: tempDir(),
        supervisorFor: () => undefined,
        drainRequest: () => async () => undefined,
        identity: IDENTITY,
        probe: fakeProbe(),
      },
      { mode: "direct", areas },
    );
}

describe("the composition", () => {
  test("the shipped composition passes, and the core registers daemon control only", () => {
    expect(compositionProblems(AREA_RUNTIMES)).toEqual([]);
    expect(AREA_RUNTIMES.map((runtime) => runtime.area)).toEqual(["core"]);
    expect(Object.keys(CORE_RUNTIME.executors ?? {}).sort()).toEqual([
      "controls.drain",
      "controls.restart",
      "controls.start",
      "controls.stop",
    ]);
    expect(Object.keys(CORE_RUNTIME.reconcilers ?? {}).sort()).toEqual([
      "controls.restart",
      "controls.start",
    ]);
    expect(wireWith(AREA_RUNTIMES)).not.toThrow();
  });

  test("a kind registered twice is refused, naming it", () => {
    const twice: AreaRuntime = { area: "core", executors: { "controls.stop": noop } };
    expect(wireWith([CORE_RUNTIME, twice])).toThrow(
      'executor for "controls.stop" registered twice (areas "core" and "core")',
    );
  });

  test("a kind no area module declares is refused, naming it", () => {
    expect(wireWith([{ area: "core", executors: { "controls.nope": noop } }])).toThrow(
      'executor for unknown command kind "controls.nope"',
    );
    expect(wireWith([{ area: "core", executors: { "legacy.setPin": noop } }])).toThrow(
      'unknown command kind "legacy.setPin"',
    );
  });

  test("an area with no module is refused, naming it", () => {
    expect(wireWith([CORE_RUNTIME, { area: "nowhere" }])).toThrow('area "nowhere" has no module');
  });

  test("a kind not safe to repeat with an executor and no reconciler is refused, naming it", () => {
    expect(wireWith([{ area: "core", executors: { "controls.start": noop } }])).toThrow(
      '"controls.start" is not safe to repeat and has an executor but no reconciler',
    );
    // A kind that is safe to repeat needs none.
    expect(wireWith([{ area: "core", executors: { "controls.stop": noop } }])).not.toThrow();
  });

  test("every problem is named in one error", () => {
    const problems = compositionProblems([
      { area: "nowhere", executors: { "controls.nope": noop, "controls.start": noop } },
    ]);
    expect(problems).toHaveLength(3);
  });
});

describe("areas.ts keeps one guarded placeholder per area", () => {
  const AREAS = [
    "ATTENTION",
    "COMPILER",
    "CREATION",
    "DELEGATION",
    "HOME",
    "INSPECTION",
    "INTEGRATIONS",
    "KNOWLEDGE",
    "PEOPLE",
    "QUALITY",
    "RUNTIME",
    "VERIFICATION",
  ];
  // A Windows checkout may carry CRLF line ends.
  const lines = readFileSync(join(import.meta.dir, "areas.ts"), "utf8").split(/\r?\n/);

  test("twelve commented imports and twelve commented list entries, each between blank lines", () => {
    const imports = lines
      .map((line, at) => ({ line, at }))
      .filter(({ line }) =>
        /^\/\/ import \{ [A-Z]+_RUNTIME \} from "\.\/areas\/[a-z]+";$/.test(line),
      );
    const entries = lines
      .map((line, at) => ({ line, at }))
      .filter(({ line }) => /^ {2}\/\/ [A-Z]+_RUNTIME,$/.test(line));
    expect(imports).toHaveLength(12);
    expect(entries).toHaveLength(12);
    expect(imports.map(({ line }) => line.split(" ")[3])).toEqual(AREAS.map((a) => `${a}_RUNTIME`));
    expect(entries.map(({ line }) => line.trim().slice(3, -1))).toEqual(
      AREAS.map((a) => `${a}_RUNTIME`),
    );
    for (const { at } of [...imports, ...entries]) {
      expect(lines[at - 1]?.trim()).toBe("");
      // The list's last placeholder closes it.
      expect(lines[at + 1]?.trim()).toMatch(/^(\]|$)/);
    }
  });
});
