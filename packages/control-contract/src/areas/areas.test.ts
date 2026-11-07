import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModules } from "../__test__/checkers.js";
import {
  SEED_AREAS,
  type SeedSuffix,
  allCommented,
  seedLines,
  uncomment,
} from "../__test__/seed.js";
import {
  CAPABILITY_NAMES,
  COMMAND_KINDS,
  DECISION_LOG_REASONS,
  EVENT_TYPES,
  ID_GRAMMARS,
  MACHINES,
  OPERATIONS,
  PERMISSIONS,
  REF_KINDS,
  SCOPED_ACTS,
} from "../index.js";
import { CORE_MODULE } from "./core.js";
import { AREA_MODULES, MODULES } from "./index.js";
import type { AreaModule } from "./types.js";

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

  test("every exported vocabulary is the union of the modules, the core's first", () => {
    const families = MODULES.flatMap((m) => m.eventFamilies);
    expect(OPERATIONS).toEqual(MODULES.flatMap((m) => m.operations));
    expect([...REF_KINDS]).toEqual(MODULES.flatMap((m) => m.refKinds.map((d) => d.kind)) as never);
    expect([...EVENT_TYPES]).toEqual(
      families.flatMap((family) => family.types.map((row) => row.type)) as never,
    );
    expect(Object.keys(MACHINES)).toEqual(MODULES.flatMap((m) => Object.keys(m.machines)));
    expect(Object.keys(COMMAND_KINDS)).toEqual(
      MODULES.flatMap((m) => m.commandKinds.map((kind) => kind.id)),
    );
    expect([...PERMISSIONS]).toEqual(
      MODULES.flatMap((m) => m.permissions.map((d) => d.id)) as never,
    );
    expect([...SCOPED_ACTS]).toEqual(MODULES.flatMap((m) => m.scopedActs ?? []) as never);
    expect([...CAPABILITY_NAMES]).toEqual(MODULES.flatMap((m) => m.capabilityKeys ?? []) as never);
    expect([...ID_GRAMMARS]).toEqual(MODULES.flatMap((m) => m.grammars ?? []));
    expect([...DECISION_LOG_REASONS.supersede]).toEqual(
      MODULES.flatMap((m) => m.reasonCodes?.["supersede"] ?? []),
    );
  });

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
] as const)("the seed in %s", (_name, file, suffix: SeedSuffix) => {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");

  test("holds one line per area in each block, commented or not, between blank lines", () => {
    expect(SEED_AREAS).toHaveLength(12);
    for (const area of SEED_AREAS) {
      const { importLine, entryLine } = seedLines(area, suffix);
      for (const { commented, live } of [importLine, entryLine]) {
        const hits = lines.flatMap((line, at) => (line === commented || line === live ? [at] : []));
        expect(`${commented}: ${hits.length}`).toBe(`${commented}: 1`);
        const at = hits[0] as number;
        expect(lines[at - 1]).toBe("");
        // The last entry closes the array instead of opening a blank line.
        if (area !== "verification" || commented === importLine.commented) {
          expect(lines[at + 1]).toBe("");
        }
      }
    }
  });

  /** The merge cases run on the seed with nothing landed, so they outlast every area's landing. */
  const seed = allCommented(source, suffix);

  test("two areas uncommenting neighbouring lines merge clean", () => {
    const merged = mergesClean(
      seed,
      uncomment(seed, "attention", suffix),
      uncomment(seed, "compiler", suffix),
      `clean-${suffix}`,
    );
    expect(merged).toBe(true);
  });

  test("and conflict without the blank lines, which is why they are there", () => {
    const tight = seed.replace(/(\/\/ [^\n]+\n)\n(?=\s*\/\/ )/g, "$1");
    expect(tight).not.toBe(seed);
    const merged = mergesClean(
      tight,
      uncomment(tight, "attention", suffix),
      uncomment(tight, "compiler", suffix),
      `tight-${suffix}`,
    );
    expect(merged).toBe(false);
  });
});
