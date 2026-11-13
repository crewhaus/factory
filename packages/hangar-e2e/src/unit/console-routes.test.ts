import { describe, expect, test } from "bun:test";
import {
  HARNESSES_ROUTE,
  HOME_ROUTE,
  crawlRouteCount,
  crawlRoutes,
  fleetRoutes,
  harnessRoutes,
  loadConsoleGrammar,
  redirectFor,
  routeFor,
  templateOf,
} from "../console-routes";

const grammar = await loadConsoleGrammar();
const entry = import.meta.resolve("@crewhaus/hangar-ui");
const router = (await import(new URL("../assets/js/router.js", entry).href)) as {
  ROUTE_TEMPLATES: readonly string[];
  SHAPE_TARGETS: readonly string[];
  parseRoute(hash: string): { view: string; sub?: string | null; wikiSlug?: string };
};

const H = {
  id: "hrn_0123456789abcdef",
  runId: "run_0123456789abcdef",
  sessionIds: ["sess_0123456789abcdef"],
  wikiSlug: "getting-started",
};

describe("the grammar comes from the real router", () => {
  test("every list is at or above its floor", () => {
    expect(grammar.templates.length).toBeGreaterThanOrEqual(40);
    expect(grammar.shapeTargets.length).toBeGreaterThanOrEqual(14);
  });

  test("it is the router's own list, not a copy", () => {
    expect(grammar.templates).toBe(router.ROUTE_TEMPLATES);
    expect(grammar.shapeTargets).toBe(router.SHAPE_TARGETS);
    expect(grammar.templates).toContain(HOME_ROUTE);
    expect(grammar.templates).toContain(HARNESSES_ROUTE);
  });
});

describe("routeFor", () => {
  test("fills each token from what the seed wrote", () => {
    expect(routeFor("#/h/:id/work/runs/:run", H)).toBe(`#/h/${H.id}/work/runs/${H.runId}`);
    expect(routeFor("#/h/:id/work/sessions/:session", H)).toBe(
      `#/h/${H.id}/work/sessions/${H.sessionIds[0]}`,
    );
    expect(routeFor("#/h/:id/knowledge/wiki/:slug", H)).toBe(
      `#/h/${H.id}/knowledge/wiki/getting-started`,
    );
    expect(routeFor("#/home/needs-you?type=review")).toBe("#/home/needs-you?type=review");
  });

  test("refuses a template the console does not serve, and a token it cannot fill", () => {
    expect(() => routeFor("#/h/:id/spec", H)).toThrow("not one of the console's route templates");
    expect(() => routeFor("#/h/:id/work/runs/:run", { id: H.id })).toThrow("needs run");
  });
});

describe("the routes", () => {
  test("the crawl is every fleet template once, and every harness template per harness", () => {
    const routes = crawlRoutes(grammar, [H, { ...H, id: "b" }, { ...H, id: "c" }]);
    expect(routes.length).toBe(crawlRouteCount(grammar, 3));
    const harnessTemplates = grammar.templates.filter((t) => t.startsWith("#/h/")).length;
    expect(routes.length).toBe(grammar.templates.length - harnessTemplates + 3 * harnessTemplates);
    expect(new Set(routes.map((r) => r.route)).size).toBe(routes.length);
  });

  test("every route the crawl visits is one the real router resolves, and none redirects", () => {
    for (const { route, template } of crawlRoutes(grammar, [H])) {
      expect(`${route}:${router.parseRoute(route).view === "notfound"}`).toBe(`${route}:false`);
      expect(redirectFor(route)).toBeNull();
      expect(templateOf(route)).toBe(template);
    }
  });

  test("a template holds :id and never a harness id", () => {
    const templates = [...fleetRoutes(grammar), ...harnessRoutes(grammar, H)].map(
      (r) => r.template,
    );
    expect(templates).toContain("#/h/:id");
    expect(templates.join("\n")).not.toContain(H.id);
  });

  test("an old address is known for one, and lands where the router says", () => {
    expect(redirectFor("#/approvals")).toBe("#/home/needs-you?type=approvals");
    expect(templateOf("#/approvals")).toBe("#/home/needs-you?type=approvals");
    expect(templateOf(`#/h/${H.id}/memory/wiki/x`)).toBe("#/h/:id/knowledge/wiki/:slug");
    expect(templateOf("#/nope")).toBeNull();
  });
});
