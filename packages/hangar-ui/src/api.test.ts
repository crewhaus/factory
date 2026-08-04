/**
 * The api client under a stubbed `fetch`: every wrapper must issue the
 * method/path/body the SERVER implements (regression for the M1 findings
 * where pin/edit/group/relocate writes hit routes that 405'd/400'd). No
 * DOM needed — api.js touches sessionStorage/fetch only inside calls, and
 * its storage reads are try/caught.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { api } from "../assets/js/api.js";

type Recorded = { method: string; path: string; body: unknown };

const calls: Recorded[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response('{"ok":true}\n', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function record(promise: Promise<unknown>): Promise<Recorded> {
  await promise;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1] as Recorded;
}

describe("registry writes hit the server's real routes", () => {
  test("pin toggle → PUT /api/h/:id/pin {pinned} (never PATCH …/registry)", async () => {
    const c = await record(api.setPin("hrn_0123456789abcdef", true));
    expect(c).toEqual({
      method: "PUT",
      path: "/api/h/hrn_0123456789abcdef/pin",
      body: { pinned: true },
    });
  });

  test("row editor → per-field PUTs for tags/notes/groups", async () => {
    expect(await record(api.setTags("hrn_1", ["a", "b"]))).toEqual({
      method: "PUT",
      path: "/api/h/hrn_1/tags",
      body: { tags: ["a", "b"] },
    });
    expect(await record(api.setNotes("hrn_1", "n"))).toEqual({
      method: "PUT",
      path: "/api/h/hrn_1/notes",
      body: { notes: "n" },
    });
    expect(await record(api.setGroups("hrn_1", ["prod"]))).toEqual({
      method: "PUT",
      path: "/api/h/hrn_1/groups",
      body: { groups: ["prod"] },
    });
  });

  test("new group → POST /api/registry/groups {name} (not PUT {groups:[…]})", async () => {
    expect(await record(api.addGroup("prod"))).toEqual({
      method: "POST",
      path: "/api/registry/groups",
      body: { name: "prod" },
    });
  });

  test("relocate → {newDir}, the key the server requires (not {dir})", async () => {
    expect(await record(api.relocateHarness("hrn_1", "/new/home"))).toEqual({
      method: "POST",
      path: "/api/h/hrn_1/relocate",
      body: { newDir: "/new/home" },
    });
  });

  test("add harness / scan / scan-root / remove", async () => {
    expect(await record(api.addHarness("/h"))).toEqual({
      method: "POST",
      path: "/api/harnesses",
      body: { dir: "/h" },
    });
    expect(await record(api.scan())).toEqual({ method: "POST", path: "/api/scan", body: {} });
    expect(await record(api.addScanRoot("/roots"))).toEqual({
      method: "POST",
      path: "/api/registry/scan-roots",
      body: { dir: "/roots" },
    });
    expect(await record(api.removeHarness("hrn_1"))).toEqual({
      method: "DELETE",
      path: "/api/h/hrn_1",
      body: undefined,
    });
  });

  test("no call ever uses PATCH", async () => {
    await api.setPin("hrn_1", false);
    await api.setTags("hrn_1", []);
    await api.addGroup("g");
    expect(calls.every((c) => c.method !== "PATCH")).toBe(true);
  });
});

describe("reads", () => {
  test("plain fleet feed vs background hydrate", async () => {
    expect((await record(api.harnesses())).path).toBe("/api/harnesses");
    expect((await record(api.harnesses(true))).path).toBe("/api/harnesses?hydrate=1");
  });

  test("params are URI-encoded into the path", async () => {
    const c = await record(api.session("hrn_1", "sess_0000000000000001"));
    expect(c.path).toBe("/api/h/hrn_1/sessions/sess_0000000000000001");
    const wiki = await record(api.wikiArticle("hrn_1", "how to?"));
    expect(wiki.path).toBe("/api/h/hrn_1/memory/wiki/how%20to%3F");
  });

  test("404 → null (absence is not an error)", async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"no such harness"}\n', { status: 404 })) as typeof fetch;
    expect(await api.harness("hrn_missing")).toBeNull();
  });
});
