/**
 * Every address the console answered before the five sections still lands,
 * through one table. Each old form is written out here as a literal string,
 * so a mapping that changes has to change in two places on purpose.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as router from "../assets/js/router.js";

const r = router as {
  LEGACY_GLOBAL_VIEWS: readonly string[];
  LEGACY_HARNESS_TABS: readonly string[];
  LEGACY_REST_TABS: readonly string[];
  LEGACY_ROUTES: readonly { from: string; to: string }[];
  ROUTE_TEMPLATES: readonly string[];
  hrefGlobal(view: string): string;
  hrefHarness(id: string, tab?: string, ...rest: string[]): string;
  parseRoute(hash: string): Record<string, unknown>;
  redirectFor(hash: string): string | null;
  routeFor(template: string, params?: Record<string, string>): string;
};

const ID = "hrn_9f2c41d07ab3e851";
const H = `#/h/${ID}`;

describe("the fleet screens", () => {
  test("nine redirect, and Settings is its own index", () => {
    const cases: Array<[string, string | null]> = [
      ["#/runs", "#/home/working"],
      ["#/approvals", "#/home/needs-you?type=approvals"],
      ["#/review", "#/home/needs-you?type=review"],
      ["#/activity", "#/home/changes"],
      ["#/credentials", "#/connections/credentials"],
      ["#/feedback", "#/harnesses/feedback"],
      ["#/thredz", "#/connections/thredz"],
      ["#/health", "#/harnesses/health"],
      ["#/settings", null],
      ["#/advisor", "#/home/needs-you?type=advice"],
    ];
    expect(cases.map(([from]) => from.slice(2))).toEqual([...r.LEGACY_GLOBAL_VIEWS]);
    for (const [from, to] of cases)
      expect(`${from} → ${r.redirectFor(from)}`).toBe(`${from} → ${to}`);
  });

  test("#/ was the Library and is now Home: no redirect", () => {
    expect(r.redirectFor("#/")).toBeNull();
    expect(r.redirectFor("")).toBeNull();
  });
});

describe("the twenty harness tabs", () => {
  test("each one, bare", () => {
    const cases: Array<[string, string]> = [
      ["overview", H],
      ["advisor", `${H}/overview/needs-you`],
      ["spec", `${H}/setup/spec`],
      ["runs", `${H}/work/runs`],
      ["schedulers", `${H}/work/schedule`],
      ["sessions", `${H}/work/sessions`],
      ["evals", `${H}/quality/results`],
      ["memory", `${H}/knowledge/memory`],
      ["data", `${H}/quality/datasets`],
      ["feedback", `${H}/quality/feedback`],
      ["costs", `${H}/setup/budget`],
      ["models", `${H}/setup/models`],
      ["creds", `${H}/setup/credentials`],
      ["channels", `${H}/setup/channels`],
      ["security", `${H}/setup/security`],
      ["thredz", `${H}/knowledge/thredz`],
      ["deploy", `${H}/setup/deployment`],
      ["inspect", `${H}/setup/files`],
      ["dev", `${H}/setup/tools`],
      ["panes", `${H}/setup/plugins`],
    ];
    expect(cases.map(([tab]) => tab)).toEqual([...r.LEGACY_HARNESS_TABS]);
    for (const [tab, to] of cases) {
      expect(`${tab} → ${r.redirectFor(`${H}/${tab}`)}`).toBe(`${tab} → ${to}`);
    }
  });

  test("the ones that carried an id keep it", () => {
    expect(r.redirectFor(`${H}/runs/run_0123456789abcdef`)).toBe(
      `${H}/work/runs/run_0123456789abcdef`,
    );
    expect(r.redirectFor(`${H}/sessions/sess_0123456789abcdef`)).toBe(
      `${H}/work/sessions/sess_0123456789abcdef`,
    );
    expect(r.redirectFor(`${H}/evals/run1`)).toBe(`${H}/quality/results/run1`);
    expect(r.redirectFor(`${H}/evals/run1/s42`)).toBe(`${H}/quality/results/run1/s42`);
  });

  test("a wiki article lands on the article, never on the memory fabric's Wiki panel", () => {
    expect(r.redirectFor(`${H}/memory/wiki/pricing-notes`)).toBe(
      `${H}/knowledge/wiki/pricing-notes`,
    );
    expect(r.redirectFor(`${H}/memory/wiki/a%20b`)).toBe(`${H}/knowledge/wiki/a%20b`);
    // With no slug the old router showed the fabric, and so does this.
    expect(r.redirectFor(`${H}/memory/wiki`)).toBe(`${H}/knowledge/memory`);
  });

  test("every tab that took trailing segments keeps them", () => {
    const cases: Array<[string, string]> = [
      [`${H}/data/golden/v2`, `${H}/quality/datasets/golden/v2`],
      [`${H}/models/routes/sess_1`, `${H}/setup/models/routes/sess_1`],
      [`${H}/feedback/faq/x`, `${H}/quality/feedback/faq/x`],
      [`${H}/creds/a/b`, `${H}/setup/credentials/a/b`],
      [`${H}/channels/slack`, `${H}/setup/channels/slack`],
      [`${H}/security/egress`, `${H}/setup/security/egress`],
      [`${H}/thredz/records`, `${H}/knowledge/thredz/records`],
      [`${H}/inspect/settings/x.json`, `${H}/setup/files/settings/x.json`],
      [`${H}/dev/mcp`, `${H}/setup/tools/mcp`],
      [`${H}/advisor/report-1`, `${H}/overview/needs-you/report-1`],
    ];
    expect(cases.map(([from]) => from.split("/")[3]).sort()).toEqual(
      [...r.LEGACY_REST_TABS].sort(),
    );
    for (const [from, to] of cases)
      expect(`${from} → ${r.redirectFor(from)}`).toBe(`${from} → ${to}`);
  });

  test("segments the old router ignored are dropped, as it dropped them", () => {
    expect(r.redirectFor(`${H}/spec/extra`)).toBe(`${H}/setup/spec`);
    expect(r.redirectFor(`${H}/runs/run_1/extra`)).toBe(`${H}/work/runs/run_1`);
    expect(r.redirectFor(`${H}/memory/facts`)).toBe(`${H}/knowledge/memory`);
  });
});

describe("the query, and what never redirects", () => {
  test("an old address keeps its query; a fixed key the new address sets wins", () => {
    expect(r.redirectFor("#/runs?x=1")).toBe("#/home/working?x=1");
    expect(r.redirectFor("#/approvals?x=1&type=review")).toBe(
      "#/home/needs-you?type=approvals&x=1",
    );
    expect(r.redirectFor(`${H}/sessions/s1?turn=3`)).toBe(`${H}/work/sessions/s1?turn=3`);
  });

  test("a new address never redirects: the table is idempotent", () => {
    const params = { id: ID, run: "run_1", session: "sess_1", slug: "notes" };
    expect(r.ROUTE_TEMPLATES.length).toBeGreaterThanOrEqual(40);
    for (const template of r.ROUTE_TEMPLATES) {
      const href = r.routeFor(template, params);
      expect(`${href} → ${r.redirectFor(href)}`).toBe(`${href} → null`);
    }
    for (const row of r.LEGACY_ROUTES) {
      const old = row.from
        .replace("/*", "")
        .replaceAll(":id", ID)
        .replace(/\[?:\w+\]?/g, "x");
      const target = r.redirectFor(old);
      expect(`${old}:${target === null}`).toBe(`${old}:false`);
      if (target !== null) expect(r.redirectFor(target)).toBeNull();
    }
  });

  test("an address no screen ever answered is not an old address", () => {
    for (const hash of ["#/nope", `${H}/bogus`, "#/h", "#/people/x"]) {
      expect(r.redirectFor(hash)).toBeNull();
    }
  });
});

describe("the link builders speak the new grammar, through the same table", () => {
  test("every old tab id, and every old view name, lands on a screen", () => {
    for (const tab of r.LEGACY_HARNESS_TABS) {
      const href = r.hrefHarness(ID, tab);
      const old = tab === "overview" ? H : `${H}/${tab}`;
      expect(`${tab}:${r.redirectFor(href)}`).toBe(`${tab}:null`);
      expect(`${tab}:${r.parseRoute(href).view}`).toBe(`${tab}:harness`);
      expect(r.parseRoute(href)).toEqual(r.parseRoute(r.redirectFor(old) ?? old));
    }
    for (const view of r.LEGACY_GLOBAL_VIEWS) {
      const href = r.hrefGlobal(view);
      expect(`${view}:${r.redirectFor(href)}`).toBe(`${view}:null`);
      expect(`${view}:${r.parseRoute(href).view === "notfound"}`).toBe(`${view}:false`);
      expect(r.parseRoute(href)).toEqual(r.parseRoute(`#/${view}`));
    }
  });

  test("the multi-segment calls in the console", () => {
    expect(r.hrefHarness(ID, "memory", "wiki", "pricing notes")).toBe(
      `${H}/knowledge/wiki/pricing%20notes`,
    );
    expect(r.parseRoute(r.hrefHarness(ID, "memory", "wiki", "a b/c"))["wikiSlug"]).toBe("a b/c");
    expect(r.hrefHarness(ID, "runs", "run_1")).toBe(`${H}/work/runs/run_1`);
    expect(r.hrefHarness(ID, "sessions", "sess_1")).toBe(`${H}/work/sessions/sess_1`);
    expect(r.hrefHarness(ID, "evals", "run_1")).toBe(`${H}/quality/results/run_1`);
    expect(r.hrefHarness(ID, "overview")).toBe(H);
    expect(r.hrefHarness(ID)).toBe(H);
  });

  test("a section id passes through unchanged", () => {
    expect(r.hrefHarness(ID, "work")).toBe(`${H}/work`);
    expect(r.hrefHarness(ID, "work", "runs", "run_1")).toBe(`${H}/work/runs/run_1`);
    expect(r.hrefHarness(ID, "overview", "needs-you")).toBe(`${H}/overview/needs-you`);
    expect(r.hrefHarness(ID, "setup", "files", "settings")).toBe(`${H}/setup/files/settings`);
  });

  test("the fleet builder maps old names and passes new ones", () => {
    expect(r.hrefGlobal("approvals")).toBe("#/home/needs-you?type=approvals");
    expect(r.hrefGlobal("settings")).toBe("#/settings");
    expect(r.hrefGlobal("harnesses")).toBe("#/harnesses");
  });
});
