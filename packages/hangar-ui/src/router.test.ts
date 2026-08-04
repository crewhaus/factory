/**
 * Route parsing (HM-194: every screen deep-linkable). `parseRoute` is pure;
 * importing router.js touches no browser global.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { HARNESS_TABS, hrefHarness, hrefLibrary, parseRoute } from "../assets/js/router.js";

const ID = "hrn_9f2c41d07ab3e851";

describe("parseRoute", () => {
  test("library at empty / #/", () => {
    expect(parseRoute("")).toEqual({ view: "library" });
    expect(parseRoute("#/")).toEqual({ view: "library" });
  });

  test("harness tabs", () => {
    expect(parseRoute(`#/h/${ID}`)).toEqual({ view: "harness", id: ID, tab: "overview" });
    expect(parseRoute(`#/h/${ID}/spec`)).toEqual({ view: "harness", id: ID, tab: "spec" });
    expect(parseRoute(`#/h/${ID}/costs`)).toEqual({ view: "harness", id: ID, tab: "costs" });
    expect(parseRoute(`#/h/${ID}/memory`)).toEqual({ view: "harness", id: ID, tab: "memory" });
  });

  test("sessions list and one transcript", () => {
    expect(parseRoute(`#/h/${ID}/sessions`)).toEqual({ view: "harness", id: ID, tab: "sessions" });
    expect(parseRoute(`#/h/${ID}/sessions/sess_0123456789abcdef`)).toEqual({
      view: "harness",
      id: ID,
      tab: "sessions",
      sessionId: "sess_0123456789abcdef",
    });
  });

  test("evals: history, run, sample", () => {
    expect(parseRoute(`#/h/${ID}/evals`)).toEqual({ view: "harness", id: ID, tab: "evals" });
    expect(parseRoute(`#/h/${ID}/evals/run1`)).toEqual({
      view: "harness",
      id: ID,
      tab: "evals",
      runId: "run1",
    });
    expect(parseRoute(`#/h/${ID}/evals/run1/s42`)).toEqual({
      view: "harness",
      id: ID,
      tab: "evals",
      runId: "run1",
      sampleId: "s42",
    });
  });

  test("wiki article deep link", () => {
    expect(parseRoute(`#/h/${ID}/memory/wiki/pricing-notes`)).toEqual({
      view: "harness",
      id: ID,
      tab: "memory",
      wikiSlug: "pricing-notes",
    });
  });

  test("unknown routes are notfound, never a throw", () => {
    expect(parseRoute("#/nope").view).toBe("notfound");
    expect(parseRoute(`#/h/${ID}/bogus`).view).toBe("notfound");
    expect(parseRoute("#/h").view).toBe("notfound");
    expect(parseRoute(undefined as unknown as string)).toEqual({ view: "library" });
  });

  test("percent-encoded segments decode (and bad encodes stay literal)", () => {
    expect(parseRoute(`#/h/${ID}/memory/wiki/a%20b`).wikiSlug).toBe("a b");
    expect(parseRoute(`#/h/${ID}/memory/wiki/100%`).wikiSlug).toBe("100%");
  });
});

describe("href builders round-trip through parseRoute", () => {
  test("library", () => {
    expect(parseRoute(hrefLibrary())).toEqual({ view: "library" });
  });

  test("every tab", () => {
    for (const tab of HARNESS_TABS) {
      const route = parseRoute(hrefHarness(ID, tab));
      expect(route.view).toBe("harness");
      expect(route.tab).toBe(tab);
      expect(route.id).toBe(ID);
    }
  });

  test("trailing segments encode and decode", () => {
    const href = hrefHarness(ID, "memory", "wiki", "a b/c");
    const route = parseRoute(href);
    expect(route.wikiSlug).toBe("a b/c");
  });
});
