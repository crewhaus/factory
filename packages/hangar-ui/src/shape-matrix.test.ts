/**
 * The shape × panel matrix (plan §4.5), which is an M3 exit criterion: the
 * tab strip a harness shows must depend on its target shape. The decision is
 * a pure table in `router.js`, so it is proven here rather than in a browser
 * — and the last test pins the thing that actually regressed once already:
 * `app.js` drawing the strip from the unfiltered tab list.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  HARNESS_TABS,
  SHAPE_GATED_TABS,
  SHAPE_TARGETS,
  tabAvailability,
} from "../assets/js/router.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { SHAPE_ACCENTS } from "../assets/js/shapes.js";

type Row = { tab: string; on: boolean; reason: string | null };

const rows = (target: string): Row[] => tabAvailability(target) as Row[];
const on = (target: string): string[] =>
  rows(target)
    .filter((row) => row.on)
    .map((row) => row.tab);
const off = (target: string): string[] =>
  rows(target)
    .filter((row) => !row.on)
    .map((row) => row.tab);

/** Tabs every shape gets: the plan's "all shapes get" list plus the panels
 *  that read something every harness has (a directory, a ledger, a spec). */
const UNIVERSAL = [
  "overview",
  "spec",
  "runs",
  "sessions",
  "evals",
  "data",
  "costs",
  "creds",
  "security",
  "deploy",
  "inspect",
  "dev",
];

describe("the matrix table itself", () => {
  test("it covers exactly the 14 compile targets the rest of the console knows", () => {
    expect([...SHAPE_TARGETS].sort()).toEqual(Object.keys(SHAPE_ACCENTS).sort());
    expect(SHAPE_TARGETS).toHaveLength(14);
  });

  test("every gated tab is a real tab, and names shapes that exist", () => {
    const gates = SHAPE_GATED_TABS as Record<string, { shapes: string[]; why: string }>;
    for (const [tab, entry] of Object.entries(gates)) {
      expect(`${tab}:${HARNESS_TABS.includes(tab)}`).toBe(`${tab}:true`);
      expect(entry.shapes.length).toBeGreaterThan(0);
      for (const shape of entry.shapes) {
        expect(`${tab}/${shape}:${SHAPE_TARGETS.includes(shape)}`).toBe(`${tab}/${shape}:true`);
      }
      // A gate with no explanation is a dead end wearing a grey coat.
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  test("one row per tab, in strip order, for every target", () => {
    for (const target of [...SHAPE_TARGETS, "", "some-future-shape"]) {
      expect(rows(target).map((row) => row.tab)).toEqual([...HARNESS_TABS]);
    }
  });
});

describe("what each shape shows", () => {
  test("the universal tabs are live for all 14 targets", () => {
    for (const target of SHAPE_TARGETS) {
      for (const tab of UNIVERSAL) {
        expect(`${target}/${tab}:${on(target).includes(tab)}`).toBe(`${target}/${tab}:true`);
      }
    }
  });

  test("a channel harness is the one shape that shows everything", () => {
    expect(off("channel")).toEqual([]);
    expect(on("channel")).toEqual([...HARNESS_TABS]);
  });

  test("a cli harness keeps memory/feedback/thredz/schedulers and loses channels", () => {
    expect(off("cli")).toEqual(["channels"]);
  });

  test("an eval harness loses every tab whose block its schema cannot declare", () => {
    // The finding's own scenario: Channels, Memory, Feedback, Thredz and
    // Schedulers were live links into "this does not apply to you".
    expect(off("eval").sort()).toEqual(
      ["channels", "feedback", "memory", "schedulers", "thredz"].sort(),
    );
    // …while the tab an eval spec is actually about stays live.
    expect(on("eval")).toContain("data");
    expect(on("eval")).toContain("evals");
  });

  test("graph and the onchain shapes lose the same five", () => {
    for (const target of ["graph", "onchain", "onchain-game", "pipeline"]) {
      expect(`${target}:${off(target).sort().join(",")}`).toBe(
        `${target}:channels,feedback,memory,schedulers,thredz`,
      );
    }
  });

  test("workflow keeps Memory for its continuity block but has no feedback loop", () => {
    expect(on("workflow")).toContain("memory");
    expect(off("workflow")).toContain("feedback");
    expect(off("workflow")).toContain("schedulers");
  });

  test("the shapes that can arm a lane keep Schedulers", () => {
    // heartbeat (channel) · schedule (channel/managed/batch) · dream (every
    // shape with a memory: block) · janitor (the daemon shapes).
    for (const target of ["cli", "channel", "managed", "crew", "research", "batch", "voice"]) {
      expect(`${target}:${on(target).includes("schedulers")}`).toBe(`${target}:true`);
    }
    for (const target of ["workflow", "graph", "pipeline", "browser", "eval", "onchain"]) {
      expect(`${target}:${on(target).includes("schedulers")}`).toBe(`${target}:false`);
    }
  });

  test("voice/browser keep the fabric they can declare and lose the rest", () => {
    expect(on("voice")).toContain("memory");
    expect(off("voice").sort()).toEqual(["channels", "feedback", "thredz"].sort());
    expect(off("browser").sort()).toEqual(["channels", "feedback", "schedulers", "thredz"].sort());
  });
});

describe("the gate fails open, and never silently", () => {
  test("an unknown or missing target is gated at nothing", () => {
    for (const target of ["", "some-future-shape", undefined as unknown as string, null]) {
      expect(off(target as string)).toEqual([]);
    }
  });

  test("every disabled tab carries a reason naming the target", () => {
    for (const target of SHAPE_TARGETS) {
      for (const row of rows(target).filter((r) => !r.on)) {
        expect(`${target}/${row.tab}:${typeof row.reason}`).toBe(`${target}/${row.tab}:string`);
        expect(String(row.reason)).toContain(target);
        expect(String(row.reason).length).toBeGreaterThan(30);
      }
    }
    // A live tab never carries one — the reason field IS the disabled state.
    for (const row of rows("channel")) expect(row.reason).toBe(null);
  });
});

describe("the app draws the strip through the matrix", () => {
  test("app.js filters the tab strip and renders the off-matrix rows disabled", async () => {
    const source = await Bun.file(new URL("../assets/js/app.js", import.meta.url)).text();
    // The regression this file exists for: the strip was `HARNESS_TABS.map`,
    // ungated, while router.js claimed gating happened here.
    expect(source.includes("HARNESS_TABS.map(")).toBe(false);
    expect(source.includes("tabAvailability(")).toBe(true);
    // An off-matrix tab must not be an anchor — that is the whole fix.
    expect(source.includes('"aria-disabled": "true"')).toBe(true);
  });

  test("router.js no longer promises gating it does not do", async () => {
    const source = await Bun.file(new URL("../assets/js/router.js", import.meta.url)).text();
    expect(source.includes("export function tabAvailability")).toBe(true);
  });
});
