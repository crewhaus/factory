/**
 * The five harness sections and the shape × screen matrix. A harness's
 * sub-view list depends on its target shape; the decision is a pure table
 * (the rows' `gate` fields in `sections/*.js`), so it is proven here rather
 * than in a browser. A deep link to an off-matrix sub-view still resolves:
 * the gate is where the list is drawn, never in the router.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as routerModule from "../assets/js/router.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as sectionsModule from "../assets/js/sections/index.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { SHAPE_ACCENTS } from "../assets/js/shapes.js";

type Gate = { shapes: string[]; why: string; plain?: string };
type Row = {
  id: string;
  label: string;
  describe: string;
  load: () => Promise<unknown>;
  render: unknown;
  gate?: Gate;
  hidden?: boolean;
  group?: string;
};
type Section = { id: string; label: string; views: Row[]; index: unknown };
type Availability = { id: string; on: boolean; reason: string | null; summary: string | null };

const { SECTIONS, SHAPE_GATED_TABS, subViewAvailability, subViewGroups } = sectionsModule as {
  SECTIONS: Section[];
  SHAPE_GATED_TABS: Record<string, Gate>;
  subViewAvailability(section: Section | string, target: unknown): Availability[];
  subViewGroups(section: Section): Array<{ group: string | null; rows: Row[] }>;
};
const router = routerModule as {
  SHAPE_TARGETS: string[];
  SHAPE_GATED_TABS: Record<string, Gate>;
  parseRoute(hash: string): Record<string, unknown>;
  hrefHarness(id: string, tab?: string, ...rest: string[]): string;
};
const SHAPE_TARGETS = router.SHAPE_TARGETS;

/** Every listed sub-view's availability for a target, across the sections. */
const rows = (target: unknown): Availability[] =>
  SECTIONS.flatMap((section) => subViewAvailability(section, target));
const on = (target: unknown): string[] =>
  rows(target)
    .filter((r) => r.on)
    .map((r) => r.id);
const off = (target: unknown): string[] =>
  rows(target)
    .filter((r) => !r.on)
    .map((r) => r.id);
const LISTED = SECTIONS.flatMap((s) => s.views.filter((r) => r.hidden !== true).map((r) => r.id));

/** Sub-views every shape gets: each reads something every harness has. */
const UNIVERSAL = [
  "needs-you",
  "spec",
  "runs",
  "sessions",
  "results",
  "datasets",
  "budget",
  // `models:` is on every strict schema, so the Models screen is universal;
  // it answers honestly where no pool is declared.
  "models",
  "credentials",
  "security",
  "deployment",
  "files",
  "tools",
  "plugins",
];

describe("the sections", () => {
  test("five, in order, and each row names what it is for", () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      "overview",
      "work",
      "quality",
      "knowledge",
      "setup",
    ]);
    for (const section of SECTIONS) {
      for (const row of section.views) {
        expect(`${section.id}/${row.id}:${row.label.length > 0}`).toBe(
          `${section.id}/${row.id}:true`,
        );
        expect(`${section.id}/${row.id}:${row.describe.length > 10}`).toBe(
          `${section.id}/${row.id}:true`,
        );
      }
    }
  });

  test("sub-view ids are unique across sections, so a gate key names one screen", () => {
    const ids = SECTIONS.flatMap((s) => s.views.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every row's load names an existing view file, by a literal path", () => {
    const viewsDir = join(import.meta.dir, "..", "assets", "js", "views");
    let checked = 0;
    for (const section of SECTIONS) {
      const loaders = [
        ...section.views.map((row) => [row.id, row.load] as const),
        ...(section.index !== null ? [["index", (section.index as Row).load] as const] : []),
      ];
      for (const [id, load] of loaders) {
        const source = String(load);
        const paths = [...source.matchAll(/import\(\s*"\.\.\/views\/([a-z-]+\.js)"\s*\)/g)].map(
          (m) => m[1] as string,
        );
        const calls = source.match(/import\(/g)?.length ?? 0;
        expect(`${section.id}/${id}:${paths.length > 0 && paths.length === calls}`).toBe(
          `${section.id}/${id}:true`,
        );
        for (const file of paths) {
          expect(`${section.id}/${id}:${file}:${existsSync(join(viewsDir, file))}`).toBe(
            `${section.id}/${id}:${file}:true`,
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(25);
  });

  test("Setup's sub-views are drawn in groups, in the order the groups first appear", () => {
    const setup = SECTIONS.find((s) => s.id === "setup") as Section;
    expect(subViewGroups(setup).map((g) => g.group)).toEqual([
      "What it does",
      "What it uses",
      "Limits",
      "Where it runs",
      "Advanced",
    ]);
    const work = SECTIONS.find((s) => s.id === "work") as Section;
    expect(subViewGroups(work).map((g) => g.group)).toEqual([null]);
  });

  test("a hidden row is reachable by its link but never listed", () => {
    expect(LISTED).not.toContain("wiki");
    expect(rows("cli").map((r) => r.id)).not.toContain("wiki");
    expect(router.parseRoute("#/h/x/knowledge/wiki/notes")["sub"]).toBe("wiki");
  });
});

describe("the matrix table itself", () => {
  test("it covers exactly the 14 compile targets the rest of the console knows", () => {
    expect([...SHAPE_TARGETS].sort()).toEqual(Object.keys(SHAPE_ACCENTS).sort());
    expect(SHAPE_TARGETS).toHaveLength(14);
  });

  test("the exported gate table IS the rows' gates: one table, no second copy to drift", () => {
    const fromRows = Object.fromEntries(
      SECTIONS.flatMap((s) =>
        s.views
          .filter((r) => r.gate !== undefined)
          .map((r) => [r.id, { shapes: r.gate?.shapes, why: r.gate?.why }]),
      ),
    );
    expect(SHAPE_GATED_TABS).toEqual(fromRows);
    expect(router.SHAPE_GATED_TABS).toBe(SHAPE_GATED_TABS);
    expect(Object.keys(SHAPE_GATED_TABS).sort()).toEqual(
      ["channels", "feedback", "memory", "schedule", "thredz"].sort(),
    );
    expect(Object.isFrozen(SHAPE_GATED_TABS)).toBe(true);
  });

  test("every gated sub-view is a real one, and names shapes that exist", () => {
    for (const [id, entry] of Object.entries(SHAPE_GATED_TABS)) {
      expect(`${id}:${LISTED.includes(id)}`).toBe(`${id}:true`);
      expect(entry.shapes.length).toBeGreaterThan(0);
      for (const shape of entry.shapes) {
        expect(`${id}/${shape}:${SHAPE_TARGETS.includes(shape)}`).toBe(`${id}/${shape}:true`);
      }
      // A gate with no explanation is a dead end wearing a grey coat.
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  test("one row per listed sub-view, in list order, for every target", () => {
    for (const target of [...SHAPE_TARGETS, "", "some-future-shape"]) {
      expect(rows(target).map((row) => row.id)).toEqual(LISTED);
    }
  });
});

describe("what each shape shows", () => {
  test("the universal sub-views are live for all 14 targets", () => {
    for (const target of SHAPE_TARGETS) {
      for (const id of UNIVERSAL) {
        expect(`${target}/${id}:${on(target).includes(id)}`).toBe(`${target}/${id}:true`);
      }
    }
  });

  test("a channel harness is the one shape that shows everything", () => {
    expect(off("channel")).toEqual([]);
    expect(on("channel")).toEqual(LISTED);
  });

  test("a cli harness keeps memory, feedback, Thredz and the schedule, and loses channels", () => {
    expect(off("cli")).toEqual(["channels"]);
  });

  test("an eval harness loses every screen whose block its schema cannot declare", () => {
    expect(off("eval").sort()).toEqual(
      ["channels", "feedback", "memory", "schedule", "thredz"].sort(),
    );
    // …while the screens an eval spec is actually about stay live.
    expect(on("eval")).toContain("datasets");
    expect(on("eval")).toContain("results");
  });

  test("graph and the onchain shapes lose the same five", () => {
    for (const target of ["graph", "onchain", "onchain-game", "pipeline"]) {
      expect(`${target}:${off(target).sort().join(",")}`).toBe(
        `${target}:channels,feedback,memory,schedule,thredz`,
      );
    }
  });

  test("workflow keeps Memory for its continuity block but has no feedback loop", () => {
    expect(on("workflow")).toContain("memory");
    expect(off("workflow")).toContain("feedback");
    expect(off("workflow")).toContain("schedule");
  });

  test("the shapes that can arm a lane keep the Schedule", () => {
    for (const target of ["cli", "channel", "managed", "crew", "research", "batch", "voice"]) {
      expect(`${target}:${on(target).includes("schedule")}`).toBe(`${target}:true`);
    }
    for (const target of ["workflow", "graph", "pipeline", "browser", "eval", "onchain"]) {
      expect(`${target}:${on(target).includes("schedule")}`).toBe(`${target}:false`);
    }
  });

  test("voice and browser keep the fabric they can declare and lose the rest", () => {
    expect(on("voice")).toContain("memory");
    expect(off("voice").sort()).toEqual(["channels", "feedback", "thredz"].sort());
    expect(off("browser").sort()).toEqual(["channels", "feedback", "schedule", "thredz"].sort());
  });
});

describe("the gate fails open, and never silently", () => {
  test("an unknown or missing target is gated at nothing", () => {
    for (const target of ["", "some-future-shape", undefined, null]) {
      expect(off(target)).toEqual([]);
    }
  });

  test("every disabled sub-view carries a reason naming the target", () => {
    for (const target of SHAPE_TARGETS) {
      for (const row of rows(target).filter((r) => !r.on)) {
        expect(`${target}/${row.id}:${typeof row.reason}`).toBe(`${target}/${row.id}:string`);
        expect(String(row.reason)).toContain(target);
        expect(String(row.reason).length).toBeGreaterThan(30);
      }
    }
    // A live row never carries one — the reason field IS the disabled state.
    for (const row of rows("channel")) expect(row.reason).toBe(null);
  });

  test("every gate has a plain sentence for the screen, free of schema keys and shapes", () => {
    let gates = 0;
    for (const section of SECTIONS) {
      for (const row of section.views.filter((r) => r.gate !== undefined)) {
        const plain = String(row.gate?.plain ?? "");
        expect(`${row.id}:${plain.length > 10 && plain.endsWith(".")}`).toBe(`${row.id}:true`);
        // No YAML key (`channels:`), and no "target" or "schema".
        expect(`${row.id}:${/[a-z]:(\s|$)/.test(plain)}`).toBe(`${row.id}:false`);
        expect(`${row.id}:${/\btarget\b|\bschema\b/i.test(plain)}`).toBe(`${row.id}:false`);
        gates += 1;
      }
    }
    expect(gates).toBe(5);
  });

  test("a disabled sub-view shows its row's plain sentence; a live one shows none", () => {
    for (const target of SHAPE_TARGETS) {
      for (const row of rows(target)) {
        const expected = row.on
          ? null
          : (SECTIONS.flatMap((s) => s.views).find((r) => r.id === row.id)?.gate?.plain ??
            "missing");
        expect(`${target}/${row.id}:${row.summary}`).toBe(`${target}/${row.id}:${expected}`);
      }
    }
  });

  test("a deep link to an off-matrix sub-view still resolves", () => {
    for (const id of Object.keys(SHAPE_GATED_TABS)) {
      const section = SECTIONS.find((s) => s.views.some((r) => r.id === id)) as Section;
      const route = router.parseRoute(router.hrefHarness("hrn_1", section.id, id));
      expect(`${id}:${route["view"]}:${route["sub"]}`).toBe(`${id}:harness:${id}`);
    }
  });
});
