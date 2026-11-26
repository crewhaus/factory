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
    // Even one match is not a guess: the answer names it as a candidate.
    const res = await home.call("GET", "/api/v1/decisions/appr_00000000000000a3");
    expect(res.status).toBe(422);
    const error = res.body["error"] as Record<string, unknown>;
    expect(error["reason"]).toBe("harness_needed");
    expect(
      ((error["details"] as Record<string, unknown>)["candidates"] as { ref: string }[]).map(
        (c) => c.ref,
      ),
    ).toEqual([`${a.id}/decision/appr_00000000000000a3`]);
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

describe("a decision is settled only where the caller may settle it", () => {
  test("operator on one harness and viewer on another cannot settle the other's by bare id", async () => {
    const id = "appr_00000000000000d1";
    const viewed = await home.harness("delta", { approvals: [approval(id)] });
    const own = await home.harness("charlie", {
      approvals: [approval("appr_00000000000000c1")],
    });
    const sam = await home.member("Sam", "viewer", { scope: `harness:${viewed.id}` });
    const { openAccess } = await import("@crewhaus/access-control");
    const granted = await openAccess(home.t.hangarRoot).grant(
      { principal: home.owner },
      { member: sam.principal, role: "operator", scope: `harness:${own.id}` },
    );
    if (!granted.ok) throw new Error(granted.reason);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const asks = [
      ["resolve", { choice: "grant" }],
      ["supersede", { reason: "other" }],
      ["defer", { until, reason: "scheduled" }],
    ] as const;
    const paths = (verb: string) => [
      `/api/v1/decisions/${id}/${verb}`,
      `/api/v1/decisions/${id}/${verb}?harness=${viewed.id}`,
      `/api/v1/decisions/${viewed.id}/decision/${id}/${verb}`,
    ];
    for (const [verb, body] of asks) {
      for (const at of paths(verb)) {
        const res = await home.call("POST", at, { body, secret: sam.secret });
        expect(`${at}: ${res.status}`).toMatch(/: (403|422)$/);
      }
    }
    const after = await home.call("GET", `/api/v1/decisions/${viewed.id}/decision/${id}`);
    expect(after.status).toBe(200);
    expect(after.body["state"]).toBe("pending");
    expect(after.body["decision"]).toBeUndefined();
    // Their own harness's decision they may settle.
    const mine = await home.call(
      "POST",
      `/api/v1/decisions/${own.id}/decision/appr_00000000000000c1/resolve`,
      { body: { choice: "deny" }, secret: sam.secret },
    );
    expect(mine.status).toBe(200);
  }, 30_000); // a member's device sign-in and ten requests through a live server
});

// ---------------------------------------------------------------------------
// Both kinds of decision, who decided each, and a decision about a person
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const T1 = Date.parse("2026-11-02T09:00:00.000Z");
const HEX64 = "a".repeat(64);
const SHA = `sha256:${"b".repeat(64)}`;

/** A delegation rule row as the rules ledger keeps it. */
function ruleRow(id: string, owner: string, hrn: string, over: Record<string, unknown> = {}) {
  return {
    v: 1,
    at: new Date(T1).toISOString(),
    id,
    state: "enabled",
    kind: "delegate",
    action: "merge",
    revision: 1,
    scope: { harness: hrn },
    terms: { days: 30 },
    termsDigest: HEX64,
    ceilingDigest: SHA,
    policyRevision: SHA,
    consequencesDigest: HEX64,
    expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    owner,
    by: owner,
    cmd: "cmd_01jc0000000000000000000001",
    ...over,
  };
}

describe("merge and rollout decisions, and who decided", () => {
  let kinds: V1Home;
  let h: { id: string; dir: string };
  let other: { id: string; dir: string };
  let olive: { principal: string; secret: string };
  let sam: { principal: string; secret: string };
  let vic: { principal: string; secret: string };
  const RULE = "rule_01jc0000000000000000000002";
  const GRANTED = "dec_01jc0000000000000000000003";
  const PENDING = "dec_01jc0000000000000000000004";
  const PERSON = "appr_00000000000000e1";
  const PEOPLE = "appr_00000000000000e2";
  const HIDDEN = "dec_01jc0000000000000000000005";

  beforeAll(async () => {
    const { casAppend, decisionsLedger, delegationsLedger, openActionDecision } = await import(
      "@crewhaus/control-records"
    );
    // A people domain that lets only the owner of Home see a person's records.
    kinds = await v1Home({
      domains: {
        people: (request) =>
          request.principal.id === request.snapshot.owner && request.ref !== undefined
            ? { allow: true, grant: "owner-sees-people" }
            : { allow: false, needs: request.permission, role: null },
      },
    });
    h = await kinds.harness("merger", {
      approvals: [approval(PERSON), approval(PEOPLE, { sensitivity: "people" })],
    });
    other = await kinds.harness("elsewhere", { approvals: [] });
    olive = await kinds.member("Olive", "owner");
    sam = await kinds.member("Sam", "operator", { scope: `harness:${h.id}` });
    vic = await kinds.member("Vic", "viewer", { scope: `harness:${other.id}` });
    // The rule: turned on by Olive, then revised once.
    const rules = delegationsLedger(h.dir);
    const first = await casAppend(rules, RULE, null, ruleRow(RULE, olive.principal, h.id));
    if (!first.ok) throw new Error(first.reason);
    const second = await casAppend(
      rules,
      RULE,
      "enabled",
      ruleRow(RULE, olive.principal, h.id, {
        state: "revised",
        revision: 2,
        at: new Date(T1 + 3 * DAY).toISOString(),
      }),
    );
    if (!second.ok) throw new Error(second.reason);
    // A merge the rule decided, applied by a pass Sam ran: Sam decided nothing.
    const subject = { ref: `${h.id}/work/wi_01jc0000000000000000000a01`, revision: "rev-1" };
    for (const id of [GRANTED, PENDING]) {
      const opened = await openActionDecision(h.dir, {
        id,
        kind: "merge",
        subject,
        requiredClass: "maintainer",
        proposedBy: "sys:scheduler",
        now: Date.now() - 60_000,
      });
      if (!opened.ok) throw new Error(opened.reason);
    }
    const granted = await casAppend(decisionsLedger(h.dir), GRANTED, "pending", {
      id: GRANTED,
      kind: "merge",
      actionClass: "ship",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 6 * DAY).toISOString(),
      requiredClass: "maintainer",
      subject,
      proposedBy: "sys:scheduler",
      state: "granted",
      decision: "grant",
      decidedAt: new Date(Date.now() - 30_000).toISOString(),
      resolvedBy: "delegation",
      delegation: { rule: RULE, revision: 2 },
      appliedBy: sam.principal,
    });
    if (!granted.ok || !granted.applied) throw new Error("the delegated grant was not written");
    // A decision in a harness only the owner reads.
    const hidden = await openActionDecision(other.dir, {
      id: HIDDEN,
      kind: "rollout",
      subject: { ref: `${other.id}/work/wi_01jc0000000000000000000a02`, revision: "rev-2" },
      requiredClass: "maintainer",
      proposedBy: "sys:scheduler",
      now: Date.now(),
    });
    if (!hidden.ok) throw new Error(hidden.reason);
    // A person decides the tool approval, through Home.
    const decided = await kinds.call(
      "POST",
      `/api/v1/decisions/${h.id}/decision/${PERSON}/resolve`,
      { body: { choice: "grant" }, secret: sam.secret },
    );
    if (decided.status !== 200) throw new Error(`decide: ${decided.status}`);
  }, 60_000); // three members' device sign-ins and a live server

  afterAll(async () => {
    await kinds?.t.stop();
  });

  const items = (body: Record<string, unknown>) => body["items"] as Record<string, unknown>[];

  test("the list holds both kinds, each saying who decided it in the server's words", async () => {
    const res = await kinds.call("GET", "/api/v1/decisions");
    expect(res.status).toBe(200);
    const byId = new Map(items(res.body).map((row) => [row["id"], row]));
    const merge = byId.get(GRANTED);
    const tool = byId.get(PERSON);
    expect(merge?.["kind"]).toBe("merge");
    expect(merge?.["state"]).toBe("granted");
    expect(merge?.["ref"]).toBe(`${h.id}/decision/${GRANTED}`);
    const text = String(merge?.["decidedByText"]);
    expect(text.startsWith("Decided by delegation rule")).toBe(true);
    expect(text).toContain("(revision 2)");
    expect(text).toContain("turned on by Olive");
    expect(text).not.toContain("Sam");
    expect(text).not.toContain(sam.principal);
    expect(tool?.["decidedByText"]).toBe("Decided by Sam");
    // A pending one says nothing about who decided.
    expect(byId.get(PENDING)?.["state"]).toBe("pending");
    expect(byId.get(PENDING)?.["decidedByText"]).toBeUndefined();
  });

  test("one decision in one harness: the scoped ref and the bare id with its harness", async () => {
    const scoped = await kinds.call("GET", `/api/v1/decisions/${h.id}/decision/${GRANTED}`);
    expect(scoped.status).toBe(200);
    expect(String(scoped.body["decidedByText"])).toContain("(revision 2)");
    const bare = await kinds.call("GET", `/api/v1/decisions/${GRANTED}?harness=${h.id}`);
    expect(bare.status).toBe(200);
    expect(bare.body["id"]).toBe(GRANTED);
    const resolved = await kinds.call("GET", `/api/v1/refs/${h.id}/decision/${GRANTED}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body["kind"]).toBe("decision");
    expect(String(resolved.body["rev"]).startsWith("granted:")).toBe(true);
  });

  test("a caller who may not read the harness sees neither kind, and finds neither", async () => {
    const list = await kinds.call("GET", "/api/v1/decisions", { secret: vic.secret });
    expect(list.status).toBe(200);
    const ids = items(list.body).map((row) => row["id"]);
    expect(ids).not.toContain(GRANTED);
    expect(ids).not.toContain(PERSON);
    for (const id of [GRANTED, PERSON]) {
      const one = await kinds.call("GET", `/api/v1/decisions/${h.id}/decision/${id}`, {
        secret: vic.secret,
      });
      expect(one.status).toBe(403);
      expect((one.body["error"] as Record<string, unknown>)["reason"]).toBe("permission");
      expect(JSON.stringify(one.body)).not.toContain("Decided by");
      const bare = await kinds.call("GET", `/api/v1/decisions/${id}`, { secret: vic.secret });
      expect(bare.status).toBe(422);
      expect(
        (
          ((bare.body["error"] as Record<string, unknown>)["details"] as Record<string, unknown>)[
            "candidates"
          ] as unknown[]
        ).length,
      ).toBe(0);
    }
  });

  test("granting a pending merge decides it once; a second answer hears it was decided", async () => {
    const at = `/api/v1/decisions/${h.id}/decision/${PENDING}/resolve`;
    const first = await kinds.call("POST", at, { body: { choice: "grant" } });
    expect(first.status).toBe(200);
    const decision = first.body["decision"] as Record<string, unknown>;
    expect(decision["state"]).toBe("granted");
    expect(decision["kind"]).toBe("merge");
    const again = await kinds.call("POST", at, { body: { choice: "deny" } });
    expect(again.status).toBe(409);
    const error = again.body["error"] as Record<string, unknown>;
    expect(error["reason"]).toBe("already_decided");
    expect((error["current"] as Record<string, unknown>)["decision"]).toBe("grant");
    // A merge decision is granted or denied: it is not deferred, and nothing is written.
    const deferred = await kinds.call(
      "POST",
      `/api/v1/decisions/${h.id}/decision/${GRANTED}/defer`,
      { body: { until: new Date(Date.now() + DAY).toISOString(), reason: "scheduled" } },
    );
    expect(deferred.status).toBe(422);
    expect((deferred.body["error"] as Record<string, unknown>)["reason"]).toBe("grant_or_deny");
  });

  test("a decision about a person is not found by a caller who may not see people's records", async () => {
    const ghost = "appr_00000000000000ef";
    // Sam reads the harness, but holds no people.derived.read.
    const missingGet = await kinds.call("GET", `/api/v1/decisions/${h.id}/decision/${ghost}`, {
      secret: sam.secret,
    });
    const peopleGet = await kinds.call("GET", `/api/v1/decisions/${h.id}/decision/${PEOPLE}`, {
      secret: sam.secret,
    });
    expect(missingGet.status).toBe(404);
    expect(peopleGet.status).toBe(404);
    expect(peopleGet.body).toEqual(missingGet.body);
    const missingRef = await kinds.call("GET", `/api/v1/refs/${h.id}/decision/${ghost}`, {
      secret: sam.secret,
    });
    const peopleRef = await kinds.call("GET", `/api/v1/refs/${h.id}/decision/${PEOPLE}`, {
      secret: sam.secret,
    });
    expect(missingRef.status).toBe(404);
    expect((missingRef.body["error"] as Record<string, unknown>)["reason"]).toBe("ref_unknown");
    expect(peopleRef.status).toBe(404);
    expect(peopleRef.body).toEqual(missingRef.body);
    const samList = await kinds.call("GET", "/api/v1/decisions", { secret: sam.secret });
    expect(items(samList.body).map((row) => row["id"])).not.toContain(PEOPLE);
    // The owner of Home may see it, in every route.
    const ownerGet = await kinds.call("GET", `/api/v1/decisions/${h.id}/decision/${PEOPLE}`);
    expect(ownerGet.status).toBe(200);
    expect(ownerGet.body["sensitivity"]).toBe("people");
    const ownerRef = await kinds.call("GET", `/api/v1/refs/${h.id}/decision/${PEOPLE}`);
    expect(ownerRef.status).toBe(200);
    const ownerList = await kinds.call("GET", "/api/v1/decisions");
    expect(items(ownerList.body).map((row) => row["id"])).toContain(PEOPLE);
  });

  test("?harness= lists one harness; one the caller may not read lists as empty", async () => {
    const one = await kinds.call("GET", `/api/v1/decisions?harness=${h.id}`);
    expect(one.status).toBe(200);
    expect(new Set(items(one.body).map((row) => row["harness"]))).toEqual(new Set([h.id]));
    const notMine = await kinds.call("GET", `/api/v1/decisions?harness=${h.id}`, {
      secret: vic.secret,
    });
    const nothing = await kinds.call("GET", `/api/v1/decisions?harness=${other.id}`, {
      secret: sam.secret,
    });
    expect(notMine.status).toBe(200);
    expect(items(notMine.body)).toEqual([]);
    expect(nothing.status).toBe(200);
    const shape = (body: Record<string, unknown>) => ({
      items: body["items"],
      empty: body["empty"],
    });
    expect(shape(notMine.body)).toEqual(shape(nothing.body));
    const unknown = await kinds.call("GET", `/api/v1/decisions?owner=${h.id}`);
    expect(unknown.status).toBe(400);
  });

  test("a harness whose approvals were capped is named in the list", async () => {
    const many = Array.from({ length: 5002 }, (_, k) =>
      approval(`appr_${k.toString(16).padStart(16, "0")}`),
    );
    const capped = await kinds.harness("capped", { approvals: many });
    const res = await kinds.call("GET", `/api/v1/decisions?harness=${capped.id}&limit=5`);
    expect(res.status).toBe(200);
    expect(res.body["truncatedHarnesses"]).toEqual([capped.id]);
    const whole = await kinds.call("GET", `/api/v1/decisions?harness=${h.id}`);
    expect(whole.body["truncatedHarnesses"]).toBeUndefined();
  }, 20_000); // five thousand approvals written and folded

  test("a record naming a door Home does not know answers it as unknown, and a stored local id is never shown", async () => {
    const odd = await kinds.harness("odd-door", {
      approvals: [
        approval("appr_00000000000000ea", {
          decision: "grant",
          decidedAt: STAMP,
          decidedVia: "carrier-pigeon",
        }),
        approval("appr_00000000000000eb", {
          decision: "deny",
          decidedAt: STAMP,
          decidedBy: `local:#${"e".repeat(64)}`,
          decidedByPrincipal: `local:#${"e".repeat(64)}`,
          decidedVia: "cli",
        }),
      ],
    });
    const local = await kinds.call(
      "GET",
      `/api/v1/decisions/${odd.id}/decision/appr_00000000000000eb`,
    );
    expect(local.body["decidedByText"]).toBe("Decided by a person");
    expect(local.body["decidedVia"]).toBe("cli");
    const res = await kinds.call(
      "GET",
      `/api/v1/decisions/${odd.id}/decision/appr_00000000000000ea`,
    );
    expect(res.status).toBe(200);
    expect(res.body["decision"]).toBe("grant");
    expect(res.body["decidedVia"]).toBe("unknown");
    // Nobody Home can name decided it: the text says a person, never a stored id.
    expect(res.body["decidedByText"]).toBe("Decided by a person");
  });
});

describe("a list of decisions still waiting", () => {
  test("only what waits, kept before the page is cut: an older request is never lost behind settled ones", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const settled = [1, 2, 3, 4, 5].map((n) =>
      approval(`appr_00000000000000f${n}`, {
        createdAt: new Date(Date.now() - n * 1000).toISOString(),
        decision: "grant",
        decidedAt: STAMP,
      }),
    );
    const busy = await home.harness("busy", {
      approvals: [...settled, approval("appr_00000000000000f9", { createdAt: old })],
    });
    const all = await home.call("GET", `/api/v1/decisions?harness=${busy.id}&limit=5`);
    expect((all.body["items"] as Record<string, unknown>[]).map((r) => r["state"])).not.toContain(
      "pending",
    );
    const waiting = await home.call(
      "GET",
      `/api/v1/decisions?harness=${busy.id}&state=pending&limit=5`,
    );
    expect(waiting.status).toBe(200);
    const rows = waiting.body["items"] as Record<string, unknown>[];
    expect(rows.map((r) => r["id"])).toEqual(["appr_00000000000000f9"]);
    expect(waiting.body["truncated"]).toBeUndefined();
    const odd = await home.call("GET", `/api/v1/decisions?harness=${busy.id}&state=granted`);
    expect(odd.status).toBe(400);
    expect((odd.body["error"] as Record<string, unknown>)["reason"]).toBe("state");
  });
});

describe("deciding on a harness Home governs", () => {
  test("decided only while the harness's list of who may decide is in place", async () => {
    const { openActionDecision } = await import("@crewhaus/control-records");
    const { refreshApproverProjections } = await import("@crewhaus/access-control");
    const { rmSync } = await import("node:fs");
    const gov = await v1Home();
    try {
      const g = await gov.harness("governed", { approvals: [] });
      const sam = await gov.member("Sam", "operator", { scope: `harness:${g.id}` });
      const subject = { ref: `${g.id}/work/wi_01jc0000000000000000000b01`, revision: "rev-1" };
      const [first, second] = ["dec_01jc0000000000000000000b02", "dec_01jc0000000000000000000b03"];
      for (const id of [first, second]) {
        const opened = await openActionDecision(g.dir, {
          id,
          kind: "merge",
          subject,
          requiredClass: "maintainer",
          proposedBy: "sys:scheduler",
          now: Date.now() - 60_000,
        });
        if (!opened.ok) throw new Error(opened.reason);
      }
      const synced = await refreshApproverProjections(gov.t.hangarRoot, {
        harnesses: [{ id: g.id, dir: g.dir, groups: [] }],
        now: Date.now(),
      });
      expect(synced.projections.failed).toEqual([]);
      const listFile = join(g.dir, ".crewhaus", "run", "control", "approvers.json");
      expect(existsSync(listFile)).toBe(true);
      const decide = (id: string) =>
        gov.call("POST", `/api/v1/decisions/${g.id}/decision/${id}/resolve`, {
          body: { choice: "grant" },
          secret: sam.secret,
        });
      // With the list in place, an operator may not grant a merge that needs a maintainer.
      const refused = await decide(first);
      expect(refused.status).toBe(403);
      expect((refused.body["error"] as Record<string, unknown>)["reason"]).toBe("decider");
      // With it gone, nothing is decided until it is back.
      rmSync(listFile);
      const before = receiptLines(g.dir, "decisions.resolve").length;
      const held = await decide(second);
      expect(held.status).toBe(409);
      const error = held.body["error"] as Record<string, unknown>;
      expect(error["reason"]).toBe("approvers_unsynced");
      expect(String(error["remedy"])).toContain("crewhaus access sync");
      const states = receiptLines(g.dir, "decisions.resolve")
        .slice(before)
        .map((r) => r["state"]);
      expect(states[states.length - 1]).toBe("rejected");
      const after = await gov.call("GET", `/api/v1/decisions/${g.id}/decision/${second}`);
      expect(after.body["state"]).toBe("pending");
    } finally {
      await gov.t.stop();
    }
  }, 30_000); // a second booted Home and a member's device sign-in
});
