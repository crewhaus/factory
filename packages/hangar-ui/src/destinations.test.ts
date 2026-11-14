/**
 * The fleet tables: the destinations, Home's panels, the Harnesses views,
 * the connection kinds and the Settings pages. Each row loads its screen by
 * a literal path to a file that exists, and the router's grammar is read
 * from these tables, not kept beside them.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as destinations from "../assets/js/destinations.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { ROUTE_TEMPLATES, parseRoute } from "../assets/js/router.js";

type Page = {
  id: string;
  title: string;
  describe?: string;
  load: unknown;
  panel?: { load: unknown };
};
type Area = { id: string; segment: string; title: string; pages: Page[]; index: { load: unknown } };
const d = destinations as {
  DESTINATIONS: Array<{ id: string; label: string; path: string; badge?: string }>;
  FLEET_AREAS: Area[];
  CONNECTION_KINDS: Page[];
  SETTINGS_PAGES: Page[];
  HOME_PANELS: Page[];
};

const VIEWS = join(import.meta.dir, "..", "assets", "js", "views");

/** The view files a loader names, or null when any import in it is not a literal. */
function loads(load: unknown): string[] | null {
  const source = String(load);
  const paths = [...source.matchAll(/import\(\s*"\.\/views\/([a-z-]+\.js)"\s*\)/g)].map(
    (m) => m[1] as string,
  );
  return paths.length > 0 && paths.length === (source.match(/import\(/g)?.length ?? 0)
    ? paths
    : null;
}

describe("the destinations", () => {
  test("four, in header order, each a page the router answers", () => {
    expect(d.DESTINATIONS.map((x) => x.label)).toEqual([
      "Home",
      "Harnesses",
      "People",
      "Connections",
    ]);
    for (const dest of d.DESTINATIONS) {
      expect(parseRoute(dest.path).view).toBe(dest.id);
    }
    expect(d.DESTINATIONS.filter((x) => x.badge !== undefined).map((x) => x.id)).toEqual(["home"]);
  });

  test("the connection kinds are the two with a fleet view", () => {
    expect(d.CONNECTION_KINDS.map((k) => k.id)).toEqual(["credentials", "thredz"]);
  });

  test("the Settings pages", () => {
    expect(d.SETTINGS_PAGES.map((p) => p.id)).toEqual([
      "readability",
      "notifications",
      "home",
      "account",
      "plugins",
    ]);
  });
});

describe("every fleet row", () => {
  test("loads an existing view file by a literal path", () => {
    let checked = 0;
    for (const area of d.FLEET_AREAS) {
      const loaders: Array<[string, unknown]> = [
        [`${area.id}/index`, area.index.load],
        ...area.pages.map((p): [string, unknown] => [`${area.id}/${p.id}`, p.load]),
        ...area.pages
          .filter((p) => p.panel !== undefined)
          .map((p): [string, unknown] => [`${area.id}/${p.id} panel`, p.panel?.load]),
      ];
      for (const [name, load] of loaders) {
        const files = loads(load);
        expect(`${name}:${files !== null}`).toBe(`${name}:true`);
        for (const file of files ?? []) {
          expect(`${name}:${file}:${existsSync(join(VIEWS, file))}`).toBe(`${name}:${file}:true`);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(18);
  });

  test("is an address the router answers, and one of the templates the gate sweeps", () => {
    for (const area of d.FLEET_AREAS) {
      const index = area.id === "home" ? "#/" : `#/${area.segment}`;
      expect(ROUTE_TEMPLATES).toContain(index);
      for (const page of area.pages) {
        const href = `#/${area.segment}/${page.id}`;
        expect(ROUTE_TEMPLATES).toContain(href);
        expect(parseRoute(href)).toMatchObject({ view: area.id, sub: page.id });
        expect(page.title.length).toBeGreaterThan(0);
      }
    }
  });

  test("Home never loads the screens a cold visit must not fetch", () => {
    const home = d.FLEET_AREAS.find((a) => a.id === "home") as Area;
    const cold = [
      ...(loads(home.index.load) ?? []),
      ...home.pages.flatMap((p) => loads(p.panel?.load) ?? []),
    ];
    expect(cold.length).toBeGreaterThan(0);
    for (const file of ["evals.js", "spec-edit.js", "memory-fabric.js", "thredz.js", "runs.js"]) {
      expect(cold).not.toContain(file);
    }
  });
});
