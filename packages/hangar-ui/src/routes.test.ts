/**
 * The route contract map is pure data — these tests pin its invariants:
 * valid methods, `/api`-rooted paths, well-formed `:param` segments, bodies
 * only on writes, and NO PATCH anywhere (the M1 server has no PATCH route;
 * the old client's PATCH /api/h/:id/registry 405'd silently). The
 * server-side half — every route answering with the fields the views read —
 * lives in hangar-server's contract.test.ts against a live fixture server,
 * and `api.test.ts` proves every wrapper here is the one the client issues.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  M3_GROUPS,
  ROUTES,
  buildPath,
  m3RouteKeys,
  routeKeysInGroup,
} from "../assets/js/routes.js";

type RouteDef = { method: string; path: string; body?: string; stream?: string; group?: string };
const entries = Object.entries(ROUTES as Record<string, RouteDef>);

describe("ROUTES map", () => {
  test("covers the M1 + M2 surface and nothing exotic", () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
    for (const [key, def] of entries) {
      expect(`${key}:${["GET", "POST", "PUT", "DELETE"].includes(def.method)}`).toBe(`${key}:true`);
      expect(`${key}:${def.path.startsWith("/api/")}`).toBe(`${key}:true`);
      // Param segments are exactly `:name` (no regex/star syntax).
      for (const seg of def.path.split("/")) {
        expect(/^(:[A-Za-z][A-Za-z0-9]*|[a-z0-9-]*)$/.test(seg)).toBe(true);
      }
    }
  });

  test("no PATCH route exists (the server never implemented one)", () => {
    expect(entries.filter(([, d]) => d.method === "PATCH")).toEqual([]);
    expect(entries.some(([, d]) => d.path.endsWith("/registry"))).toBe(false);
  });

  test("every POST/PUT names its body shape; reads carry none", () => {
    for (const [key, def] of entries) {
      const needsBody = def.method === "POST" || def.method === "PUT";
      if (needsBody) {
        expect(`${key}:${typeof def.body === "string"}`).toBe(`${key}:true`);
      } else {
        expect(`${key}:${def.body === undefined}`).toBe(`${key}:true`);
      }
    }
  });

  test("the registry writes the UI performs target the server's real routes", () => {
    const byKey = ROUTES as Record<string, RouteDef>;
    expect(byKey["setPin"]).toEqual({ method: "PUT", path: "/api/h/:id/pin", body: "SetPin" });
    expect(byKey["setTags"]).toEqual({ method: "PUT", path: "/api/h/:id/tags", body: "SetTags" });
    expect(byKey["setNotes"]).toEqual({
      method: "PUT",
      path: "/api/h/:id/notes",
      body: "SetNotes",
    });
    expect(byKey["setGroups"]).toEqual({
      method: "PUT",
      path: "/api/h/:id/groups",
      body: "SetGroups",
    });
    expect(byKey["addGroup"]).toEqual({
      method: "POST",
      path: "/api/registry/groups",
      body: "GroupCreate",
    });
    expect(byKey["relocate"]).toEqual({
      method: "POST",
      path: "/api/h/:id/relocate",
      body: "Relocate",
    });
    expect(byKey["addScanRoot"]).toEqual({
      method: "POST",
      path: "/api/registry/scan-roots",
      body: "ScanRootCreate",
    });
  });

  test("the M2 driving verbs are all present and correctly shaped", () => {
    const byKey = ROUTES as Record<string, RouteDef>;
    for (const key of ["proc", "runs", "run", "controlStatus", "schedulers", "deployments"]) {
      expect(`${key}:${byKey[key]?.method}`).toBe(`${key}:GET`);
    }
    for (const key of [
      "procStart",
      "procStop",
      "procRestart",
      "procDrain",
      "controlWake",
      "controlDrain",
      "grantApproval",
      "denyApproval",
      "adjudicateReview",
      "submitJob",
      "pinSession",
      "pinBaseline",
    ]) {
      expect(`${key}:${byKey[key]?.method}`).toBe(`${key}:POST`);
    }
    // The fleet inboxes are un-parameterized reads; the decisions that settle
    // them are per-harness writes (the harness owns its own state tree).
    expect(byKey["approvals"]?.path).toBe("/api/approvals");
    expect(byKey["review"]?.path).toBe("/api/review");
    expect(byKey["activity"]?.path).toBe("/api/activity");
    expect(byKey["jobs"]?.path).toBe("/api/jobs");
    expect(byKey["grantApproval"]?.path).toBe("/api/h/:id/approvals/:apprId/grant");
  });

  test("exactly one route is an SSE stream (api.js must not res.json() it)", () => {
    // M3 deliberately adds none: the dev loop and the MCP projection are run
    // CLASSES, so their live output rides the one existing run feed rather
    // than a second streaming mechanism.
    const streams = entries.filter(([, d]) => d.stream !== undefined);
    expect(streams.map(([k]) => k)).toEqual(["runEvents"]);
    expect(streams[0]?.[1].stream).toBe("sse");
  });
});

describe("the M3 surface is grouped, and the grouping is the contract", () => {
  const groups = M3_GROUPS as string[];
  const m3Keys = m3RouteKeys() as string[];

  test("every M3 route names one of the eleven groups", () => {
    for (const key of m3Keys) {
      const group = (ROUTES as Record<string, RouteDef>)[key]?.group;
      expect(`${key}:${groups.includes(group ?? "")}`).toBe(`${key}:true`);
    }
  });

  test("no group is empty — an area with no routes is a planning bug", () => {
    for (const group of groups) {
      expect(`${group}:${(routeKeysInGroup(group) as string[]).length > 0}`).toBe(`${group}:true`);
    }
    // …and the groups partition the M3 keys exactly.
    const fromGroups = groups.flatMap((g) => routeKeysInGroup(g) as string[]).sort();
    expect(fromGroups).toEqual([...m3Keys].sort());
  });

  test("M1/M2 routes carry no group (a group means an M3 handler owns it)", () => {
    const ungrouped = entries.filter(([, d]) => d.group === undefined).map(([k]) => k);
    expect(ungrouped).toContain("harnesses");
    expect(ungrouped).toContain("proc");
    expect(ungrouped).toContain("runEvents");
    expect(ungrouped.length + m3Keys.length).toBe(entries.length);
  });

  test("the six implementer areas are all present in the map", () => {
    // spec · memory · evals+data+feedback · creds+channels+security · thredz
    // · inspect+runtime — the split the M3 build is parallelized along.
    for (const group of groups) {
      expect(`${group}:${(routeKeysInGroup(group) as string[]).length}`).not.toBe(`${group}:0`);
    }
    expect(m3Keys.length).toBeGreaterThanOrEqual(150);
  });
});

describe("buildPath", () => {
  test("fills params URI-encoded", () => {
    expect(buildPath("/api/h/:id/sessions/:sess", { id: "hrn_1", sess: "sess_2" })).toBe(
      "/api/h/hrn_1/sessions/sess_2",
    );
    expect(buildPath("/api/h/:id", { id: "a/b?c" })).toBe("/api/h/a%2Fb%3Fc");
  });

  test("throws on a missing param (a build bug, never user input)", () => {
    expect(() => buildPath("/api/h/:id", {})).toThrow('missing route param "id"');
  });
});
