import { describe, expect, test } from "bun:test";
import {
  LIBRARY_ROUTE,
  crawlRouteCount,
  crawlRoutes,
  fleetRoutes,
  globalRoute,
  harnessRoute,
  harnessRoutes,
  loadConsoleGrammar,
  runRoute,
  sessionRoute,
  wikiRoute,
} from "../console-routes";

const grammar = await loadConsoleGrammar();
const entry = import.meta.resolve("@crewhaus/hangar-ui");
const { parseRoute } = (await import(new URL("../assets/js/router.js", entry).href)) as {
  parseRoute(hash: string): { view: string; tab?: string };
};

describe("the grammar comes from the real router", () => {
  test("every list is at or above its floor", () => {
    expect(grammar.globalViews.length).toBeGreaterThanOrEqual(10);
    expect(grammar.harnessTabs.length).toBeGreaterThanOrEqual(20);
    expect(grammar.shapeTargets.length).toBeGreaterThanOrEqual(14);
  });

  test("it is the router's own list, not a copy", () => {
    expect(grammar.harnessTabs).toContain("overview");
    expect(grammar.shapeTargets).toContain("cli");
    expect(grammar.globalViews).toContain("runs");
  });
});

describe("the routes", () => {
  const id = "hrn_0123456789abcdef";

  test("the crawl is the Library, every global view, and every tab of every harness", () => {
    const routes = crawlRoutes(grammar, ["a", "b", "c"]);
    expect(routes.length).toBe(crawlRouteCount(grammar, 3));
    expect(routes.length).toBe(1 + grammar.globalViews.length + 3 * grammar.harnessTabs.length);
    expect(new Set(routes.map((r) => r.route)).size).toBe(routes.length);
  });

  test("every route the crawl visits is one the real router resolves", () => {
    for (const { route } of crawlRoutes(grammar, [id])) {
      expect({ route, view: parseRoute(route).view === "notfound" }).toEqual({
        route,
        view: false,
      });
    }
  });

  test("a harness tab resolves to that tab", () => {
    for (const tab of grammar.harnessTabs) {
      expect(parseRoute(harnessRoute(id, tab)).tab).toBe(tab);
    }
  });

  test("the deep routes resolve", () => {
    for (const route of [
      sessionRoute(id, "sess_0123456789abcdef"),
      runRoute(id, "run_0123456789abcdef"),
      wikiRoute(id, "getting-started"),
    ]) {
      expect(parseRoute(route).view).toBe("harness");
    }
  });

  test("a template holds :id and never a harness id", () => {
    const templates = [...fleetRoutes(grammar), ...harnessRoutes(grammar, id)].map(
      (r) => r.template,
    );
    expect(templates).toContain(LIBRARY_ROUTE);
    expect(templates).toContain(globalRoute("runs"));
    expect(templates).toContain("#/h/:id/overview");
    expect(templates.join("\n")).not.toContain(id);
  });
});
