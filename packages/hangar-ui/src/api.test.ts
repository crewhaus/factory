/**
 * The api client under a stubbed `fetch`: every wrapper must issue the
 * method/path/body the SERVER implements (regression for the M1 findings
 * where pin/edit/group/relocate writes hit routes that 405'd/400'd). No
 * DOM needed — api.js touches sessionStorage/fetch only inside calls, and
 * its storage reads are try/caught.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { api, streamRunEvents } from "../assets/js/api.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { ROUTES, buildPath } from "../assets/js/routes.js";

type Recorded = { method: string; path: string; body: unknown };
type RouteDef = { method: string; path: string; body?: string; stream?: string };

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

// ---------------------------------------------------------------------------
// M2 — every wrapper against the contract map
// ---------------------------------------------------------------------------

const ID = "hrn_0123456789abcdef";
const SESS = "sess_0123456789abcdef";
const RUN = "run_0123456789abcdef";

/** One driver per ROUTES key: the wrapper call, the params its path needs,
 *  and any query string it appends. `runEvents` is the SSE stream and is
 *  covered by its own test rather than this JSON-shaped table. */
const DRIVERS: Record<
  string,
  { call: () => Promise<unknown>; params?: Record<string, string>; query?: string }
> = {
  version: { call: () => api.version() },
  harnesses: { call: () => api.harnesses() },
  addHarness: { call: () => api.addHarness("/h") },
  scan: { call: () => api.scan() },
  groups: { call: () => api.groups() },
  addGroup: { call: () => api.addGroup("prod") },
  addScanRoot: { call: () => api.addScanRoot("/roots") },
  removeHarness: { call: () => api.removeHarness(ID), params: { id: ID } },
  relocate: { call: () => api.relocateHarness(ID, "/new"), params: { id: ID } },
  setGroups: { call: () => api.setGroups(ID, []), params: { id: ID } },
  setTags: { call: () => api.setTags(ID, []), params: { id: ID } },
  setPin: { call: () => api.setPin(ID, true), params: { id: ID } },
  setNotes: { call: () => api.setNotes(ID, "n"), params: { id: ID } },
  harness: { call: () => api.harness(ID), params: { id: ID } },
  spec: { call: () => api.spec(ID), params: { id: ID } },
  preflight: { call: () => api.preflight(ID), params: { id: ID } },
  sessions: { call: () => api.sessions(ID), params: { id: ID } },
  session: { call: () => api.session(ID, SESS), params: { id: ID, sess: SESS } },
  evals: { call: () => api.evals(ID), params: { id: ID } },
  evalRun: { call: () => api.evalRun(ID, RUN), params: { id: ID, runId: RUN } },
  evalSample: {
    call: () => api.evalSample(ID, RUN, "s1"),
    params: { id: ID, runId: RUN, sampleId: "s1" },
  },
  memory: { call: () => api.memory(ID, "facts"), params: { id: ID, area: "facts" } },
  wikiArticle: { call: () => api.wikiArticle(ID, "slug"), params: { id: ID, slug: "slug" } },
  costs: { call: () => api.costs(ID), params: { id: ID } },
  // ---- M2 ----------------------------------------------------------------
  proc: { call: () => api.proc(ID), params: { id: ID } },
  procStart: { call: () => api.procStart(ID), params: { id: ID } },
  procRestart: { call: () => api.procRestart(ID), params: { id: ID } },
  procStop: { call: () => api.procStop(ID), params: { id: ID } },
  procDrain: { call: () => api.procDrain(ID), params: { id: ID } },
  runs: { call: () => api.runs(ID), params: { id: ID } },
  run: { call: () => api.run(ID, RUN), params: { id: ID, runId: RUN } },
  controlStatus: { call: () => api.controlStatus(ID), params: { id: ID } },
  controlWake: { call: () => api.controlWake(ID, "heartbeat"), params: { id: ID } },
  controlDrain: { call: () => api.controlDrain(ID), params: { id: ID } },
  schedulers: { call: () => api.schedulers(ID), params: { id: ID } },
  approvals: { call: () => api.approvals() },
  grantApproval: {
    call: () => api.grantApproval(ID, "appr_0123456789abcdef"),
    params: { id: ID, apprId: "appr_0123456789abcdef" },
  },
  denyApproval: {
    call: () => api.denyApproval(ID, "appr_0123456789abcdef"),
    params: { id: ID, apprId: "appr_0123456789abcdef" },
  },
  review: { call: () => api.review() },
  adjudicateReview: {
    call: () => api.adjudicateReview(ID, "rev_1", "pass"),
    params: { id: ID, itemId: "rev_1" },
  },
  activity: { call: () => api.activity("7d"), query: "?since=7d" },
  jobs: { call: () => api.jobs() },
  submitJob: { call: () => api.submitJob(ID, "doctor"), params: { id: ID } },
  deployments: { call: () => api.deployments(ID), params: { id: ID } },
  pinSession: { call: () => api.pinSession(ID, SESS, true), params: { id: ID, sess: SESS } },
  pinBaseline: { call: () => api.pinBaseline(ID, RUN), params: { id: ID } },
};

describe("api.js cannot drift from routes.js", () => {
  test("every wrapper issues its route's method, path and body-or-not", async () => {
    for (const [key, driver] of Object.entries(DRIVERS)) {
      const route = (ROUTES as Record<string, RouteDef>)[key];
      expect(`${key}:${route !== undefined}`).toBe(`${key}:true`);
      const call = await record(driver.call() as Promise<unknown>);
      expect(`${key}:${call.method}`).toBe(`${key}:${route.method}`);
      expect(`${key}:${call.path}`).toBe(
        `${key}:${buildPath(route.path, driver.params ?? {})}${driver.query ?? ""}`,
      );
      // The map's `body` field is the contract: a write names its shape, a
      // read carries none — and the client must match either way.
      expect(`${key}:${call.body !== undefined}`).toBe(`${key}:${route.body !== undefined}`);
    }
  });

  test("the drivers cover every route in the map (the SSE stream aside)", () => {
    const covered = [...Object.keys(DRIVERS), "runEvents"].sort();
    expect(covered).toEqual(Object.keys(ROUTES).sort());
  });

  test("start/restart bodies stay empty unless the operator forced them", async () => {
    expect((await record(api.procStart(ID) as Promise<unknown>)).body).toEqual({});
    expect(
      (await record(api.procStart(ID, { force: true, acknowledge: ["a"] }) as Promise<unknown>))
        .body,
    ).toEqual({ force: true, acknowledge: ["a"] });
  });

  test("optional fields are omitted rather than sent empty", async () => {
    expect((await record(api.controlWake(ID, "schedule") as Promise<unknown>)).body).toEqual({
      lane: "schedule",
    });
    expect(
      (await record(api.controlWake(ID, "schedule", "because") as Promise<unknown>)).body,
    ).toEqual({ lane: "schedule", reason: "because" });
    expect(
      (await record(api.adjudicateReview(ID, "rev_1", "up", "note") as Promise<unknown>)).body,
    ).toEqual({ verdict: "up", note: "note" });
    expect((await record(api.approvals(true) as Promise<unknown>)).path).toBe(
      "/api/approvals?all=1",
    );
    expect((await record(api.review(true) as Promise<unknown>)).path).toBe("/api/review?all=1");
  });
});

describe("a typed refusal is surfaced, not thrown", () => {
  test("procStart's 409 preflight refusal comes back as a body", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, reason: "preflight-blocked", refused: [], unforceable: [] }),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const res = (await api.procStart(ID)) as {
      ok: boolean;
      status: number;
      body: { reason: string };
    };
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("preflight-blocked");
  });

  test("procStop's 409 not-adopted comes back as a body, not an ApiError", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          reason: "not-adopted",
          message: "a daemon is running that this manager never adopted",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    for (const call of [api.procStop(ID), api.procDrain(ID)]) {
      const res = (await call) as { ok: boolean; status: number; body: { reason: string } };
      expect(res.ok).toBe(false);
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("not-adopted");
    }
  });

  test("the run stream reads text/event-stream, never res.json()", async () => {
    let requested = "";
    let accept = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requested = String(input);
      accept = String((init?.headers as Record<string, string>)?.accept ?? "");
      const body = [
        'event: replay\ndata: {"runId":"run_0123456789abcdef","events":[],"proseTail":[]}\n\n',
        'event: done\ndata: {"reason":"closed"}\n\n',
      ].join("");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const frames: Array<{ event: string }> = [];
    await new Promise<void>((resolve) => {
      streamRunEvents(ID, RUN, (frame: { event: string }) => {
        frames.push(frame);
        if (frame.event === "closed") resolve();
      });
    });
    expect(requested).toBe(buildPath(ROUTES.runEvents.path, { id: ID, runId: RUN }));
    expect(accept).toBe("text/event-stream");
    // The grammar the server promises: replay first, done last, then our own
    // synthetic `closed` marking the socket's end.
    expect(frames.map((f) => f.event)).toEqual(["replay", "done", "closed"]);
    expect(ROUTES.runEvents.stream).toBe("sse");
  });

  test("a control envelope is a 200 even when it refuses — no throw", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, code: "no_control_port", expected: true, retryable: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const envelope = (await api.controlStatus(ID)) as { code: string };
    expect(envelope.code).toBe("no_control_port");
  });
});
