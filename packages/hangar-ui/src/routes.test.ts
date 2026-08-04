/**
 * The route contract map is pure data — these tests pin its invariants:
 * valid methods, `/api`-rooted paths, well-formed `:param` segments, bodies
 * only on writes, and NO PATCH anywhere (the M1 server has no PATCH route;
 * the old client's PATCH /api/h/:id/registry 405'd silently). The
 * server-side half — every route answering with the fields the views read —
 * lives in hangar-server's contract.test.ts against a live fixture server.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { ROUTES, buildPath } from "../assets/js/routes.js";

type RouteDef = { method: string; path: string; body?: string };
const entries = Object.entries(ROUTES as Record<string, RouteDef>);

describe("ROUTES map", () => {
  test("covers the M1 surface and nothing exotic", () => {
    expect(entries.length).toBeGreaterThanOrEqual(20);
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
