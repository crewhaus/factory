/**
 * Every operation is served one way: by a handler, by its sign-in route, or by an honest
 * "not served yet" answer; never a silent 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATIONS } from "@crewhaus/control-contract";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { SIGN_IN_ROUTES } from "../sign-in-routes";
import {
  HOME_AREAS,
  HOME_CORE,
  SIGN_IN_OPERATIONS,
  V1_NOT_SERVED,
  handlersOf,
  homeCompositionProblems,
} from "./areas";
import { twinVerb } from "./router";

const handlers = handlersOf(HOME_AREAS);

describe("every operation is served exactly one way", () => {
  test("a handler, a sign-in route, or a not-served entry: one each", () => {
    for (const op of OPERATIONS) {
      const ways = [
        handlers.has(op.id),
        Object.hasOwn(V1_NOT_SERVED, op.id),
        SIGN_IN_OPERATIONS.includes(op.id),
      ];
      expect(`${op.id}: ${ways.filter(Boolean).length}`).toBe(`${op.id}: 1`);
    }
  });

  test("every handler is an operation, and every sign-in operation has its route", () => {
    const ids = new Set(OPERATIONS.map((op) => op.id));
    expect([...handlers.keys()].filter((id) => !ids.has(id))).toEqual([]);
    for (const id of SIGN_IN_OPERATIONS) {
      const op = OPERATIONS.find((o) => o.id === id);
      expect(SIGN_IN_ROUTES.some((r) => r.method === op?.method && r.path === op?.path)).toBe(true);
    }
  });

  test("every operation has a permission, and a twin or the reason it has none", () => {
    for (const op of OPERATIONS) {
      expect(op.permission.length).toBeGreaterThan(0);
      expect(op.cliTwin !== null || (op.noTwinReason?.length ?? 0) > 0).toBe(true);
    }
  });

  test("the not-served map is exactly the people operations", () => {
    const expected = OPERATIONS.filter((op) => op.id.startsWith("people.")).map((op) => op.id);
    expect(Object.keys(V1_NOT_SERVED).sort()).toEqual(expected.sort());
    for (const reason of Object.values(V1_NOT_SERVED)) expect(reason).toMatch(/not served/);
  });

  test("a composition that serves a not-served operation, or one twice, is refused", () => {
    expect(homeCompositionProblems(HOME_AREAS)).toEqual([]);
    const planted = [
      HOME_CORE,
      {
        area: "people",
        handlers: { "people.persons.list": HOME_CORE.handlers?.["me.get"] as never },
      },
    ];
    expect(homeCompositionProblems(planted)).toEqual([
      '"people.persons.list" is served and listed as not served',
    ]);
    expect(
      homeCompositionProblems([
        HOME_CORE,
        { area: "core", handlers: { "me.get": HOME_CORE.handlers?.["me.get"] as never } },
      ]),
    ).toContain('handler for "me.get" registered twice (areas "core" and "core")');
    expect(homeCompositionProblems([{ area: "nowhere" }])).toEqual([
      'area "nowhere" has no module',
    ]);
  });

  test("a projection named twice, or with a name the index takes, is refused", () => {
    const overview = HOME_CORE.projections?.find((p) => p.name === "overview");
    if (overview === undefined) throw new Error("no overview projection");
    expect(
      homeCompositionProblems([HOME_CORE, { area: "quality", projections: [overview] }]),
    ).toEqual(['projection "overview" registered twice (areas "core" and "quality")']);
    for (const name of ["fleet", "fleet-changes", "refs", "hrn_0123456789abcdef"]) {
      expect(
        homeCompositionProblems([{ area: "quality", projections: [{ ...overview, name }] }]),
      ).toEqual([`projection "${name}" is not a name a projection may take (area "quality")`]);
    }
  });

  test("a stream source named twice, not a cursor source, or outside its harness, is refused", () => {
    const runs = HOME_CORE.streamSources?.find((s) => s.name === "runs");
    if (runs === undefined) throw new Error("no runs source");
    expect(
      homeCompositionProblems([HOME_CORE, { area: "quality", streamSources: [runs] }]),
    ).toEqual(['stream source "runs" registered twice (areas "core" and "quality")']);
    expect(
      homeCompositionProblems([
        { area: "quality", streamSources: [{ ...runs, name: "evalruns" as never }] },
      ]),
    ).toEqual(['stream source "evalruns" is not a cursor source (area "quality")']);
    const escaping = {
      ...runs,
      source: (dir: string) => ({ root: dir, records: { dir: join("..", "elsewhere") } }),
    };
    expect(homeCompositionProblems([{ area: "quality", streamSources: [escaping] }])).toEqual([
      'stream source "runs" keeps its records outside the harness (area "quality")',
    ]);
    const absolute = {
      ...runs,
      source: (dir: string) => ({ root: dir, records: { file: join(tmpdir(), "x.jsonl") } }),
    };
    expect(homeCompositionProblems([{ area: "quality", streamSources: [absolute] }])).toEqual([
      'stream source "runs" names its records by an absolute path (area "quality")',
    ]);
    const rooted = { ...runs, source: () => ({ root: tmpdir(), records: { dir: "d" } }) };
    expect(homeCompositionProblems([{ area: "quality", streamSources: [rooted] }])).toEqual([
      'stream source "runs" keeps its records outside the harness (area "quality")',
    ]);
    // The core's five, the approvals log under the sessions root included, stay inside.
    expect(HOME_CORE.streamSources?.map((s) => s.name)).toEqual([
      "runs",
      "commands",
      "deployments",
      "decisions",
      "approvals",
    ]);
    expect(
      homeCompositionProblems([
        { area: "core", handlers: { "nope.op": HOME_CORE.handlers?.["me.get"] as never } },
      ]),
    ).toEqual(['handler for unknown operation "nope.op" (area "core")']);
  });
});

describe("a not-served operation answers 501", () => {
  let home: V1Home;
  beforeAll(async () => {
    home = await v1Home();
  }, 60_000);
  afterAll(async () => {
    await home?.t.stop();
  });

  test("with its reason, and its twin when it has one", async () => {
    const h = await home.harness("alpha");
    expect(h.id).toMatch(/^hrn_/);
    const res = await home.call("GET", "/api/v1/people");
    expect(res.status).toBe(501);
    const error = res.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("unsupported");
    expect(error["reason"]).toBe("not_served");
    expect(error["message"]).toBe(V1_NOT_SERVED["people.persons.list"]);
    // A not-served row with a twin names it, with the request's own params.
    const psn = "psn_01m76e6f05hp514w9j4v3qymka";
    const op = OPERATIONS.find((o) => o.id === "people.persons.get");
    if (op === undefined) throw new Error("no people.persons.get");
    expect(twinVerb(op, { psn })).toBe(`crewhaus people show ${psn}`);
  });

  // One operation from each not-served group, over HTTP as the owner: each says it is not
  // served yet, before any permission is asked, so nobody is told to ask for access.
  for (const [id, path] of [["people.persons.list", "/api/v1/people"]] as const) {
    test(`${id} answers 501 not_served to the owner`, async () => {
      const res = await home.call("GET", path);
      expect(res.status).toBe(501);
      const error = res.body["error"] as Record<string, unknown>;
      expect(error["code"]).toBe("unsupported");
      expect(error["reason"]).toBe("not_served");
      expect(error["message"]).toBe(V1_NOT_SERVED[id]);
    });
  }

  test("a not-served people row names its twin over HTTP", async () => {
    const psn = "psn_01m76e6f05hp514w9j4v3qymka";
    const res = await home.call("GET", `/api/v1/people/${psn}`);
    expect(res.status).toBe(501);
    const error = res.body["error"] as Record<string, unknown>;
    expect(error["reason"]).toBe("not_served");
    expect(error["message"]).toBe(V1_NOT_SERVED["people.persons.get"]);
    expect(error["verb"]).toBe(`crewhaus people show ${psn}`);
  });

  test("a member without the permission hears the same answer, not a refusal", async () => {
    const viewer = await home.member("Vic", "viewer");
    const res = await home.call("GET", "/api/v1/people", { secret: viewer.secret });
    expect(res.status).toBe(501);
    expect((res.body["error"] as Record<string, unknown>)["reason"]).toBe("not_served");
    const anonymous = await home.call("GET", "/api/v1/people", { secret: null });
    expect(anonymous.status).toBe(401);
  });
});
