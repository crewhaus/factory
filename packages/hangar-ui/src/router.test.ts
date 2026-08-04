/**
 * Route parsing (HM-194: every screen deep-linkable). `parseRoute` is pure;
 * importing router.js touches no browser global.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  GLOBAL_VIEWS,
  HARNESS_TABS,
  hrefGlobal,
  hrefHarness,
  hrefLibrary,
  parseRoute,
} from "../assets/js/router.js";

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

  test("M2 fleet screens live at the root", () => {
    expect(parseRoute("#/runs")).toEqual({ view: "runs" });
    expect(parseRoute("#/approvals")).toEqual({ view: "approvals" });
    expect(parseRoute("#/review")).toEqual({ view: "review" });
    expect(parseRoute("#/activity")).toEqual({ view: "activity" });
    // …and do not collide with the per-harness tab of the same name.
    expect(parseRoute(`#/h/${ID}/runs`)).toEqual({ view: "harness", id: ID, tab: "runs" });
  });

  test("M2 harness tabs: runs (with a run console), schedulers, deploy", () => {
    expect(parseRoute(`#/h/${ID}/runs/run_0123456789abcdef`)).toEqual({
      view: "harness",
      id: ID,
      tab: "runs",
      runId: "run_0123456789abcdef",
    });
    expect(parseRoute(`#/h/${ID}/schedulers`)).toEqual({
      view: "harness",
      id: ID,
      tab: "schedulers",
    });
    expect(parseRoute(`#/h/${ID}/deploy`)).toEqual({ view: "harness", id: ID, tab: "deploy" });
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

  test("every fleet screen in the nav round-trips", () => {
    for (const view of GLOBAL_VIEWS) {
      expect(parseRoute(hrefGlobal(view))).toEqual({ view });
    }
  });
});
