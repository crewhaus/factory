import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModules } from "../__test__/checkers.js";
import { CORE_MODULE } from "./core.js";
import { AREA_MODULES, MODULES } from "./index.js";
import type { AreaModule } from "./types.js";

const AREAS = [
  "attention",
  "compiler",
  "creation",
  "delegation",
  "home",
  "inspection",
  "integrations",
  "knowledge",
  "people",
  "quality",
  "runtime",
  "verification",
] as const;

const EMPTY: AreaModule = {
  area: "planted",
  operations: [],
  refKinds: [],
  eventFamilies: [],
  machines: {},
  commandKinds: [],
  permissions: [],
};

function withPlanted(planted: Partial<AreaModule>): string[] {
  return checkModules([...MODULES, { ...EMPTY, ...planted }]);
}

const op = CORE_MODULE.operations[0];

describe("the composition", () => {
  test("the core module comes first, and every table is frozen", () => {
    expect(AREA_MODULES[0]).toBe(CORE_MODULE);
    expect(checkModules(MODULES)).toEqual([]);
    expect(Object.isFrozen(AREA_MODULES)).toBe(true);
    expect(Object.isFrozen(CORE_MODULE.operations[0])).toBe(true);
    expect(Object.isFrozen(CORE_MODULE.machines.run.transitions.queued)).toBe(true);
  });

  test("a module that is not the core's first is reported", () => {
    expect(checkModules([EMPTY, ...MODULES])).toContain("the core module is not first");
  });

  const plants: readonly (readonly [string, Partial<AreaModule>, string])[] = [
    ["operation", { operations: [op] }, "duplicate operation: meta.discover"],
    [
      "ref kind",
      { refKinds: [{ kind: "run", scope: "home", ids: [] }] },
      "duplicate ref kind: run",
    ],
    [
      "event family",
      { eventFamilies: [{ family: "run", types: [] }] },
      "duplicate event family: run",
    ],
    [
      "event type",
      {
        eventFamilies: [{ family: "x", types: [{ type: "run.queued", sensitivity: "internal" }] }],
      },
      "duplicate event type: run.queued",
    ],
    ["machine", { machines: { run: CORE_MODULE.machines.run } }, "duplicate machine: run"],
    [
      "command kind",
      {
        commandKinds: [
          {
            id: "controls.pause",
            permission: "h.control",
            idempotent: true,
            effect: "local",
            cliTwin: null,
          },
        ],
      },
      "duplicate command kind: controls.pause",
    ],
    [
      "permission",
      { permissions: [{ id: "h.read", scope: "harness", floor: "viewer", service: "grantable" }] },
      "duplicate permission: h.read",
    ],
    ["scoped act", { scopedActs: ["run.events.read"] }, "duplicate scoped act: run.events.read"],
    ["capability", { capabilityKeys: ["runs.create"] }, "duplicate capability: runs.create"],
    ["grammar", { grammars: [{ prefix: "dep", grammar: "ulid" }] }, "duplicate grammar: dep:ulid"],
    [
      "reason code",
      { reasonCodes: { supersede: ["other"] } },
      "duplicate reason code: supersede:other",
    ],
  ];

  for (const [vocabulary, planted, reason] of plants) {
    test(`a duplicate ${vocabulary} is reported`, () => {
      expect(withPlanted(planted)).toEqual([reason]);
    });
  }

  test("a people permission with a role is reported, and without one is not", () => {
    const decl = { id: "people.read", scope: "home", service: "never" } as const;
    expect(withPlanted({ permissions: [{ ...decl, floor: "viewer" }] })).toEqual([
      "a people permission has a role: people.read",
    ]);
    expect(withPlanted({ permissions: [{ ...decl, floor: "none" }] })).toEqual([]);
  });
});

const tmpRoot = mkdtempSync(join(tmpdir(), "control-contract-seed-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** Run a three-way merge of two edits to `base`; true when git merged it clean. */
function mergesClean(base: string, ours: string, theirs: string, name: string): boolean {
  const paths = ["ours", "base", "theirs"].map((side) => join(tmpRoot, `${name}.${side}`));
  writeFileSync(paths[0] as string, ours);
  writeFileSync(paths[1] as string, base);
  writeFileSync(paths[2] as string, theirs);
  const merge = Bun.spawnSync(["git", "merge-file", "-p", ...paths]);
  return merge.exitCode === 0;
}

describe.each([
  ["areas/index.ts", join(import.meta.dir, "index.ts"), "MODULE"],
  ["schemas/areas.ts", join(import.meta.dir, "..", "schemas", "areas.ts"), "SCHEMAS"],
] as const)("the seed in %s", (name, file, suffix) => {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const importLine = (area: string) =>
    `// import { ${area.toUpperCase()}_${suffix} } from "./${area}.js";`;
  const entryLine = (area: string) => `  // ${area.toUpperCase()}_${suffix},`;

  test("holds one placeholder per area in each block, each between blank lines", () => {
    expect(AREAS).toHaveLength(12);
    for (const area of AREAS) {
      for (const line of [importLine(area), entryLine(area)]) {
        const at = lines.indexOf(line);
        expect(`${line} at ${at > -1}`).toBe(`${line} at true`);
        expect(lines.lastIndexOf(line)).toBe(at);
        expect(lines[at - 1]).toBe("");
        // The last entry closes the array instead of opening a blank line.
        if (area !== "verification" || line === importLine(area)) expect(lines[at + 1]).toBe("");
      }
    }
  });

  test("two areas uncommenting neighbouring lines merge clean", () => {
    const edit = (area: string, base: string) =>
      base
        .replace(importLine(area), importLine(area).replace("// ", ""))
        .replace(entryLine(area), entryLine(area).replace("// ", ""));
    const merged = mergesClean(
      source,
      edit("attention", source),
      edit("compiler", source),
      `clean-${suffix}`,
    );
    expect(merged).toBe(true);
  });

  test("and conflict without the blank lines, which is why they are there", () => {
    const tight = source.replace(/(\/\/ [^\n]+\n)\n(?=\s*\/\/ )/g, "$1");
    expect(tight).not.toBe(source);
    const edit = (area: string, base: string) =>
      base
        .replace(importLine(area), importLine(area).replace("// ", ""))
        .replace(entryLine(area), entryLine(area).replace("// ", ""));
    const merged = mergesClean(
      tight,
      edit("attention", tight),
      edit("compiler", tight),
      `tight-${suffix}`,
    );
    expect(merged).toBe(false);
  });
});
