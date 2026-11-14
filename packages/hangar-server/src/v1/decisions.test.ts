/**
 * Decisions through the API: a stale `expect` is 412 with the present state, a second
 * decider hears who settled it and when, a deferral is one receipt accepted then
 * succeeded and a refused one is one rejected receipt, the tool input is withheld from a
 * caller who may not read content, and an item about people is withheld from the list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type V1Home, v1Home } from "../__test__/v1-home";

const STAMP = new Date(Date.now() - 60_000).toISOString();

function approval(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    toolName: "SendMessage",
    inputHash: `hash-${id}`,
    input: { channel: "ops", text: `content of ${id}` },
    runId: "run_00000000000000a0",
    sessionId: "sess_00000000000000aa",
    surface: "daemon",
    createdAt: STAMP,
    ...extra,
  };
}

function receiptLines(dir: string, kind: string): Record<string, unknown>[] {
  const at = join(dir, ".crewhaus", "run", "control", "commands");
  if (!existsSync(at)) return [];
  return readdirSync(at)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => readFileSync(join(at, name), "utf8").split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row["kind"] === kind);
}

let home: V1Home;
let a: { id: string; dir: string };

beforeAll(async () => {
  home = await v1Home();
  a = await home.harness("alpha", {
    approvals: [
      approval("appr_00000000000000a1"),
      approval("appr_00000000000000a2"),
      approval("appr_00000000000000a3"),
      approval("appr_00000000000000a4", { expiresAt: new Date(Date.now() - 1000).toISOString() }),
      approval("appr_00000000000000a5", { sensitivity: "people" }),
    ],
  });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

const ref = (id: string) => `${a.id}/decision/${id}`;

describe("deciding", () => {
  test("an expect that is not the request's state is 412, with the state as it is", async () => {
    const res = await home.call(
      "POST",
      `/api/v1/decisions/${ref("appr_00000000000000a1")}/resolve`,
      {
        body: { choice: "grant", expect: "granted" },
      },
    );
    expect(res.status).toBe(412);
    const error = res.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("precondition_failed");
    expect((error["current"] as Record<string, unknown>)["state"]).toBe("pending");
    const fine = await home.call(
      "POST",
      `/api/v1/decisions/${ref("appr_00000000000000a1")}/resolve`,
      {
        body: { choice: "grant", expect: "pending" },
      },
    );
    expect(fine.status).toBe(200);
    expect((fine.body["decision"] as Record<string, unknown>)["state"]).toBe("granted");
  });

  test("a second decider hears it was already decided, when, and by which door", async () => {
    const res = await home.call(
      "POST",
      `/api/v1/decisions/${ref("appr_00000000000000a1")}/resolve`,
      {
        body: { choice: "deny" },
      },
    );
    expect(res.status).toBe(409);
    const error = res.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("already_decided");
    const current = error["current"] as Record<string, unknown>;
    expect(current["decision"]).toBe("grant");
    expect(typeof current["decidedAt"]).toBe("string");
  });

  test("a deferral writes one receipt, accepted then succeeded", async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const res = await home.call("POST", `/api/v1/decisions/${ref("appr_00000000000000a2")}/defer`, {
      body: { until, reason: "awaiting-someone" },
    });
    expect(res.status).toBe(200);
    expect((res.body["decision"] as Record<string, unknown>)["deferredUntil"]).toBe(until);
    const rows = receiptLines(a.dir, "decisions.defer");
    expect(rows.map((r) => r["state"])).toEqual(["accepted", "succeeded"]);
    expect(new Set(rows.map((r) => r["id"])).size).toBe(1);
  });

  test("a refused deferral (an expired request) writes one rejected receipt", async () => {
    const before = receiptLines(a.dir, "decisions.defer").length;
    const res = await home.call("POST", `/api/v1/decisions/${ref("appr_00000000000000a4")}/defer`, {
      body: { until: new Date(Date.now() + 86_400_000).toISOString(), reason: "scheduled" },
    });
    expect(res.status).toBe(412);
    const rows = receiptLines(a.dir, "decisions.defer").slice(before);
    expect(rows.map((r) => r["state"])).toEqual(["accepted", "rejected"]);
  });

  test("a time already past is refused before anything is written", async () => {
    const before = receiptLines(a.dir, "decisions.defer").length;
    const res = await home.call("POST", `/api/v1/decisions/${ref("appr_00000000000000a3")}/defer`, {
      body: { until: new Date(Date.now() - 1000).toISOString(), reason: "scheduled" },
    });
    expect(res.status).toBe(400);
    expect(receiptLines(a.dir, "decisions.defer")).toHaveLength(before);
  });
});

describe("reading", () => {
  test("the input is withheld from a caller who may not read content", async () => {
    const svc = await home.service("reader", [a.id]);
    const res = await home.call("GET", `/api/v1/decisions/${ref("appr_00000000000000a3")}`, {
      secret: svc.secret,
    });
    expect(res.status).toBe(200);
    expect(res.body["input"]).toBeUndefined();
    expect(res.body["inputWithheld"]).toBe(true);
    const owner = await home.call("GET", `/api/v1/decisions/${ref("appr_00000000000000a3")}`);
    expect(JSON.stringify(owner.body["input"])).toContain("content of appr_00000000000000a3");
  });

  test("an item about people is withheld from the list, which says so", async () => {
    const res = await home.call("GET", "/api/v1/decisions");
    expect(res.status).toBe(200);
    const ids = (res.body["items"] as { id: string }[]).map((i) => i.id);
    expect(ids).toContain("appr_00000000000000a3");
    expect(ids).not.toContain("appr_00000000000000a5");
    expect(res.body["hidden"]).toEqual(["people"]);
  });

  test("a bare id needs its harness", async () => {
    const res = await home.call("GET", "/api/v1/decisions/appr_00000000000000a3");
    expect(res.status).toBe(200);
    const b = await home.harness("bravo", { approvals: [approval("appr_00000000000000a3")] });
    const both = await home.call("GET", "/api/v1/decisions/appr_00000000000000a3");
    expect(both.status).toBe(422);
    const candidates = (
      (both.body["error"] as Record<string, unknown>)["details"] as Record<string, unknown>
    )["candidates"] as { ref: string }[];
    expect(candidates.map((c) => c.ref).sort()).toEqual(
      [`${a.id}/decision/appr_00000000000000a3`, `${b.id}/decision/appr_00000000000000a3`].sort(),
    );
    const hinted = await home.call(
      "GET",
      `/api/v1/decisions/appr_00000000000000a3?harness=${b.id}`,
    );
    expect(hinted.status).toBe(200);
    expect(hinted.body["harness"]).toBe(b.id);
  });
});
