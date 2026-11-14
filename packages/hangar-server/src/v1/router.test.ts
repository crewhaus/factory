/**
 * The versioned API's router: discovery before and after sign-in, the protocol header,
 * strict bodies and queries, an undeclared path, list limits and cursors, honest empty
 * lists, and one masker at the exit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openAccess } from "@crewhaus/access-control";
import { decodeCursor, mintId } from "@crewhaus/control-contract";
import { deploymentsLedger } from "@crewhaus/control-records";
import { type V1Home, v1Home } from "../__test__/v1-home";

let home: V1Home;
let a: { id: string; dir: string };

beforeAll(async () => {
  home = await v1Home();
  a = await home.harness("alpha");
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

describe("discovery", () => {
  test("with no credential: the protocol and how to sign in, and nothing else", async () => {
    const res = await home.call("GET", "/api/v1", { secret: null });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["protocol", "signIn"]);
    expect(res.body["signIn"]).toEqual({ methods: ["browser", "device"] });
    expect(res.headers.get("crewhaus-protocol")).toBe("crewhaus.hangar.v1");
  });

  test("with a revoked token: 401", async () => {
    const svc = await home.service("gone", [a.id]);
    const revoked = await openAccess(home.t.hangarRoot).revoke(
      { principal: home.owner },
      svc.credential,
    );
    expect(revoked.ok).toBe(true);
    const res = await home.call("GET", "/api/v1", { secret: svc.secret });
    expect(res.status).toBe(401);
    expect((res.body["error"] as Record<string, unknown>)["code"]).toBe("unauthenticated");
  });

  test("signed in: the operation table, with no handler in it", async () => {
    const res = await home.call("GET", "/api/v1");
    expect(res.status).toBe(200);
    const ops = res.body["operations"] as Record<string, unknown>[];
    expect(ops.length).toBeGreaterThanOrEqual(64);
    expect(ops.find((op) => op["id"] === "decisions.defer")?.["path"]).toBe(
      "/api/v1/decisions/{ref}/defer",
    );
    expect(JSON.stringify(ops)).not.toContain("function");
    expect(res.body["limits"]).toEqual({
      pageLimitDefault: 50,
      pageLimitMax: 500,
      cursorMaxLength: 2048,
    });
  });

  test("/api/version lists the API", async () => {
    const res = await home.call("GET", "/api/version");
    expect(res.body["api"]).toEqual(["crewhaus.hangar.v1"]);
  });
});

describe("what a request must be", () => {
  test("another protocol is refused, and this one is echoed", async () => {
    const other = await home.call("GET", "/api/v1/harnesses", {
      headers: { "CrewHaus-Protocol": "crewhaus.hangar.v2" },
    });
    expect(other.status).toBe(400);
    expect((other.body["error"] as Record<string, unknown>)["code"]).toBe("unsupported_protocol");
    const same = await home.call("GET", "/api/v1/harnesses", {
      headers: { "CrewHaus-Protocol": "crewhaus.hangar.v1" },
    });
    expect(same.status).toBe(200);
  });

  test("an unknown body field, or query name, is 400 naming it", async () => {
    const body = await home.call("POST", `/api/v1/harnesses/${a.id}/controls/pause`, {
      body: { quiet: true, loud: true },
    });
    expect(body.status).toBe(400);
    const error = body.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("invalid");
    expect((error["details"] as Record<string, unknown>)["unknownFields"]).toEqual(["loud"]);
    const query = await home.call("GET", "/api/v1/harnesses?limit=2&sort=name");
    expect(query.status).toBe(400);
    expect(
      ((query.body["error"] as Record<string, unknown>)["details"] as Record<string, unknown>)[
        "unknownFields"
      ],
    ).toEqual(["sort"]);
  });

  test("an undeclared v1 path is 404, for the owner too", async () => {
    // No row declares it, so the choke point answers before any handler runs.
    const res = await home.call("GET", "/api/v1/nothing-here");
    expect(res.status).toBe(404);
    const bootstrap = await home.call("GET", "/api/v1/nothing-here", { secret: home.t.token });
    expect(bootstrap.status).toBe(404);
  });

  test("a limit past 500 is 400", async () => {
    const res = await home.call("GET", `/api/v1/harnesses/${a.id}/commands?limit=501`);
    expect(res.status).toBe(400);
    expect((res.body["error"] as Record<string, unknown>)["reason"]).toBe("limit");
  });

  test("an operation declared and not served yet answers 501 with its reason", async () => {
    const res = await home.call("GET", `/api/v1/harnesses/${a.id}/runs`);
    expect(res.status).toBe(501);
    const error = res.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("unsupported");
    expect(error["reason"]).toBe("not_served");
  });
});

describe("lists", () => {
  test("cursors are stable: list, append, and the next page repeats nothing", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await home.call("POST", `/api/v1/harnesses/${a.id}/controls/pause`, { body: {} });
      expect([200, 202]).toContain(res.status);
    }
    const first = await home.call("GET", `/api/v1/harnesses/${a.id}/commands?limit=2`);
    expect(first.status).toBe(200);
    const firstIds = (first.body["items"] as { id: string }[]).map((r) => r.id);
    expect(firstIds).toHaveLength(2);
    const snapshot = decodeCursor(String(first.body["snapshotAt"]));
    expect(snapshot.ok && snapshot.cursor.kind).toBe("vector");
    // One more lands after the first page was read.
    await home.call("POST", `/api/v1/harnesses/${a.id}/controls/resume`, { body: {} });
    const next = await home.call(
      "GET",
      `/api/v1/harnesses/${a.id}/commands?limit=2&cursor=${encodeURIComponent(String(first.body["next"]))}`,
    );
    const nextIds = (next.body["items"] as { id: string }[]).map((r) => r.id);
    expect(nextIds.length).toBeGreaterThan(0);
    expect(nextIds.filter((id) => firstIds.includes(id))).toEqual([]);
    // A cursor from another list is refused.
    const other = await home.call(
      "GET",
      `/api/v1/harnesses/${a.id}/deployments?cursor=${encodeURIComponent(String(first.body["next"]))}`,
    );
    expect(other.status).toBe(400);
  });

  test("an empty list says why", async () => {
    const b = await home.harness("bravo");
    const res = await home.call("GET", `/api/v1/harnesses/${b.id}/deployments`);
    expect(res.status).toBe(200);
    expect(res.body["items"]).toEqual([]);
    expect((res.body["empty"] as Record<string, unknown>)["reason"]).toBe("no-data");
  });
});

describe("the one exit", () => {
  test("every answer passes the masker: a planted credential-named field comes back redacted", async () => {
    const c = await home.harness("charlie");
    const ledger = deploymentsLedger(c.dir);
    mkdirSync(join(c.dir, ".crewhaus", "run", "control"), { recursive: true });
    const planted = ["sk", "-ant-", "a".repeat(24)].join("");
    appendFileSync(
      join(c.dir, "records" in ledger && "file" in ledger.records ? ledger.records.file : ""),
      `${JSON.stringify({
        id: mintId("dep"),
        state: "prepared",
        at: new Date().toISOString(),
        artifact: { digest: "d", shape: "cli", entry: "dist/agent.ts" },
        apiKey: planted,
      })}\n`,
    );
    const res = await home.call("GET", `/api/v1/harnesses/${c.id}/deployments`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(planted);
    expect((res.body["items"] as Record<string, unknown>[])[0]?.["apiKey"]).not.toBe(planted);
  });
});
