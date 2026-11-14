/**
 * Route parsing (every screen deep-linkable). `parseRoute` is pure;
 * importing router.js touches no browser global.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as router from "../assets/js/router.js";

const { ROUTE_TEMPLATES, hrefFleet, hrefHome, hrefLibrary, pageTitle, parseRoute, routeFor } =
  router as {
    ROUTE_TEMPLATES: readonly string[];
    hrefFleet(area: string, page?: string | null, query?: Record<string, string> | null): string;
    hrefHome(): string;
    hrefLibrary(): string;
    pageTitle(route: unknown, names?: { harness?: string }): string;
    parseRoute(hash: unknown): Record<string, unknown>;
    routeFor(template: string, params?: Record<string, string>): string;
  };

const ID = "hrn_9f2c41d07ab3e851";
const fleet = (view: string, sub: string | null = null, query: Record<string, string> = {}) => ({
  view,
  section: null,
  sub,
  rest: [],
  query,
});
const harness = (
  section: string,
  sub: string | null = null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  view: "harness",
  id: ID,
  section,
  sub,
  rest: [],
  query: {},
  ...extra,
});

describe("the fleet grammar", () => {
  test("Home at the empty hash and at #/", () => {
    expect(parseRoute("")).toEqual(fleet("home"));
    expect(parseRoute("#/")).toEqual(fleet("home"));
    expect(parseRoute("#")).toEqual(fleet("home"));
  });

  test("Home's pages", () => {
    expect(parseRoute("#/home/needs-you")).toEqual(fleet("home", "needs-you"));
    expect(parseRoute("#/home/working")).toEqual(fleet("home", "working"));
    expect(parseRoute("#/home/changes")).toEqual(fleet("home", "changes"));
  });

  test("a query is decoded into route.query, and an unknown key is kept, not thrown on", () => {
    for (const type of ["approvals", "review", "advice"]) {
      expect(parseRoute(`#/home/needs-you?type=${type}`)).toEqual(
        fleet("home", "needs-you", { type }),
      );
    }
    expect(parseRoute("#/home/needs-you?type=review&zz=1&flag")).toEqual(
      fleet("home", "needs-you", { type: "review", zz: "1", flag: "" }),
    );
    expect(parseRoute("#/harnesses?by=group%20name")).toEqual(
      fleet("harnesses", null, { by: "group name" }),
    );
    // A key that would reach the prototype is dropped, never assigned.
    const route = parseRoute("#/harnesses?__proto__=x&constructor=y");
    expect(route["query"]).toEqual({});
  });

  test("Harnesses, People, Connections and Settings", () => {
    expect(parseRoute("#/harnesses")).toEqual(fleet("harnesses"));
    expect(parseRoute("#/harnesses/health")).toEqual(fleet("harnesses", "health"));
    expect(parseRoute("#/harnesses/feedback")).toEqual(fleet("harnesses", "feedback"));
    expect(parseRoute("#/people")).toEqual(fleet("people"));
    expect(parseRoute("#/connections")).toEqual(fleet("connections"));
    expect(parseRoute("#/connections/credentials")).toEqual(fleet("connections", "credentials"));
    expect(parseRoute("#/connections/thredz")).toEqual(fleet("connections", "thredz"));
    expect(parseRoute("#/settings")).toEqual(fleet("settings"));
    for (const page of ["readability", "notifications", "home", "account"]) {
      expect(parseRoute(`#/settings/${page}`)).toEqual(fleet("settings", page));
    }
  });
});

describe("the harness grammar", () => {
  test("#/h/<id> is the Overview", () => {
    expect(parseRoute(`#/h/${ID}`)).toEqual(harness("overview"));
  });

  test("each section's own page", () => {
    for (const section of ["work", "quality", "knowledge", "setup"]) {
      expect(parseRoute(`#/h/${ID}/${section}`)).toEqual(harness(section));
    }
  });

  test("sub-views, with today's typed captures where they exist", () => {
    expect(parseRoute(`#/h/${ID}/overview/needs-you`)).toEqual(harness("overview", "needs-you"));
    expect(parseRoute(`#/h/${ID}/work/runs`)).toEqual(harness("work", "runs"));
    expect(parseRoute(`#/h/${ID}/work/runs/run_0123456789abcdef`)).toEqual(
      harness("work", "runs", { runId: "run_0123456789abcdef", rest: ["run_0123456789abcdef"] }),
    );
    expect(parseRoute(`#/h/${ID}/work/sessions/sess_1`)).toEqual(
      harness("work", "sessions", { sessionId: "sess_1", rest: ["sess_1"] }),
    );
    expect(parseRoute(`#/h/${ID}/quality/results/run1/s42`)).toEqual(
      harness("quality", "results", { runId: "run1", sampleId: "s42", rest: ["run1", "s42"] }),
    );
    expect(parseRoute(`#/h/${ID}/knowledge/wiki/pricing-notes`)).toEqual(
      harness("knowledge", "wiki", { wikiSlug: "pricing-notes", rest: ["pricing-notes"] }),
    );
  });

  test("a sub-view that names its own panels keeps the trailing segments as rest", () => {
    expect(parseRoute(`#/h/${ID}/knowledge/memory/wiki`)).toEqual(
      harness("knowledge", "memory", { rest: ["wiki"] }),
    );
    expect(parseRoute(`#/h/${ID}/setup/models/routes/sess_1`)).toEqual(
      harness("setup", "models", { rest: ["routes", "sess_1"] }),
    );
    expect(parseRoute(`#/h/${ID}/setup/files/settings/a.json`)).toEqual(
      harness("setup", "files", { rest: ["settings", "a.json"] }),
    );
  });

  test("percent-encoded segments decode, and bad encodes stay literal", () => {
    expect(parseRoute(`#/h/${ID}/knowledge/wiki/a%20b`)["wikiSlug"]).toBe("a b");
    expect(parseRoute(`#/h/${ID}/knowledge/wiki/100%`)["wikiSlug"]).toBe("100%");
    expect(parseRoute("#/h/a%2Fb")["id"]).toBe("a/b");
  });
});

describe("unknown addresses are notfound, never a throw", () => {
  test("the forms that never answered", () => {
    expect(parseRoute("#/nope").view).toBe("notfound");
    expect(parseRoute(`#/h/${ID}/bogus`).view).toBe("notfound");
    expect(parseRoute("#/h").view).toBe("notfound");
    expect(parseRoute("#/nope")).toEqual({ view: "notfound", hash: "#/nope" });
  });

  test("an unknown page, sub-view or extra segment", () => {
    for (const hash of [
      "#/home/elsewhere",
      "#/harnesses/health/extra",
      "#/people/someone",
      "#/connections/models",
      "#/settings/access",
      `#/h/${ID}/work/bogus`,
      `#/h/${ID}/setup/spec/extra`,
      `#/h/${ID}/work/runs/run_1/extra`,
      `#/h/${ID}/knowledge/wiki`,
    ]) {
      expect(`${hash}:${parseRoute(hash).view}`).toBe(`${hash}:notfound`);
    }
  });

  test("a missing hash is Home, on purpose", () => {
    expect(parseRoute(undefined)).toEqual(fleet("home"));
    expect(parseRoute(null)).toEqual(fleet("home"));
  });
});

describe("the href builders", () => {
  test("Home and the harness list", () => {
    expect(hrefHome()).toBe("#/");
    expect(hrefLibrary()).toBe("#/harnesses");
    expect(parseRoute(hrefLibrary())).toEqual(fleet("harnesses"));
  });

  test("a fleet page, with its query", () => {
    expect(hrefFleet("home")).toBe("#/");
    expect(hrefFleet("home", "needs-you", { type: "review" })).toBe("#/home/needs-you?type=review");
    expect(hrefFleet("settings", "readability")).toBe("#/settings/readability");
    expect(hrefFleet("connections")).toBe("#/connections");
  });
});

describe("ROUTE_TEMPLATES", () => {
  test("every fleet and harness template, derived from the tables", () => {
    const fleetTemplates = ROUTE_TEMPLATES.filter((t) => !t.startsWith("#/h/"));
    const harnessTemplates = ROUTE_TEMPLATES.filter((t) => t.startsWith("#/h/"));
    // The device sign-in page is a fleet address of its own.
    expect(fleetTemplates.length).toBe(21);
    expect(harnessTemplates.length).toBe(27);
    expect(new Set(ROUTE_TEMPLATES).size).toBe(ROUTE_TEMPLATES.length);
    expect(Object.isFrozen(ROUTE_TEMPLATES)).toBe(true);
    for (const t of [
      "#/",
      "#/home/needs-you?type=advice",
      "#/connections/thredz",
      "#/settings/account",
      "#/settings/plugins",
      "#/device",
      "#/h/:id",
      "#/h/:id/overview/needs-you",
      "#/h/:id/work/runs/:run",
      "#/h/:id/work/sessions/:session",
      "#/h/:id/knowledge/wiki/:slug",
      "#/h/:id/setup/files",
    ]) {
      expect(ROUTE_TEMPLATES).toContain(t);
    }
    // The wiki article has no address without its slug, and the Overview has one address.
    expect(ROUTE_TEMPLATES).not.toContain("#/h/:id/knowledge/wiki");
    expect(ROUTE_TEMPLATES).not.toContain("#/h/:id/overview");
  });

  test("each one, filled in, parses to a screen whose template it is", () => {
    const params = { id: ID, run: "run_1", session: "sess_1", slug: "notes" };
    for (const template of ROUTE_TEMPLATES) {
      const route = parseRoute(routeFor(template, params));
      expect(`${template}:${route.view}`).not.toBe(`${template}:notfound`);
      expect(router.routeTemplate(route)).toBe(template);
    }
  });

  test("routeFor fills and encodes each token, and says which one is missing", () => {
    expect(routeFor("#/h/:id/work/runs/:run", { id: "a b", run: "r/1" })).toBe(
      "#/h/a%20b/work/runs/r%2F1",
    );
    expect(routeFor("#/home/needs-you?type=review")).toBe("#/home/needs-you?type=review");
    expect(() => routeFor("#/h/:id/knowledge/wiki/:slug", { id: ID })).toThrow("needs slug");
  });
});

describe("pageTitle", () => {
  test("a fleet page is named by its own title", () => {
    expect(pageTitle(parseRoute("#/"))).toBe("Home — Hangar");
    expect(pageTitle(parseRoute("#/home/needs-you?type=review"))).toBe("Needs you — Hangar");
    expect(pageTitle(parseRoute("#/harnesses/health"))).toBe("Health — Hangar");
    expect(pageTitle(parseRoute("#/settings/home"))).toBe("Home settings — Hangar");
    expect(pageTitle(parseRoute("#/connections"))).toBe("Connections — Hangar");
  });

  test("a harness page names the sub-view, then the harness", () => {
    expect(pageTitle(parseRoute(`#/h/${ID}/setup/spec`), { harness: "poly" })).toBe(
      "Spec — poly — Hangar",
    );
    expect(pageTitle(parseRoute(`#/h/${ID}`), { harness: "poly" })).toBe(
      "Overview — poly — Hangar",
    );
    expect(pageTitle(parseRoute(`#/h/${ID}/work`), { harness: "poly" })).toBe(
      "Work — poly — Hangar",
    );
    // Before the name is known, the id stands in.
    expect(pageTitle(parseRoute(`#/h/${ID}/work/runs`))).toBe(`Runs — ${ID} — Hangar`);
  });

  test("not found", () => {
    expect(pageTitle(parseRoute("#/nope"))).toBe("Nothing at this address — Hangar");
  });
});
