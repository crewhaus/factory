/**
 * A retired harness's open approvals are expired: a pending request and an unspent grant
 * get an `expire` line with `retired` and an `expiredAt`, so a later decision or spend is
 * refused as expired, and every record stays in the file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mintRunId } from "@crewhaus/control-contract";
import {
  type ConsumeRequest,
  type PendingApproval,
  createPendingApprovalStore,
  expireOpenApprovals,
} from "./index";
import {
  ALLOW,
  logLines,
  pending,
  removeTempRoots,
  rendezvousLines,
  tempRoot,
} from "./test-helpers";

afterAll(removeTempRoots);

const SESSION = "sess_00000000000000aa";
const SCOPE = `session:${SESSION}`;
const PARKING_RUN = mintRunId();
const PLACES = [{ path: "/work/out.txt", at: ["/work/out.txt"] }];
const AT = new Date("2026-11-13T12:00:00.000Z");

function park(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return pending({
    sessionId: SESSION,
    runId: PARKING_RUN,
    places: PLACES,
    createdAt: new Date().toISOString(),
    binding: {
      runId: PARKING_RUN,
      resumeScope: SCOPE,
      sessionId: SESSION,
      resourceRevisionBound: false,
    } as never,
    ...overrides,
  });
}

function spend(): ConsumeRequest {
  return { runId: mintRunId(), resumeScope: SCOPE, places: PLACES, approvers: { state: "absent" } };
}

describe("expireOpenApprovals", () => {
  test("a pending request and an unspent grant are expired; a spent grant and a deny are left", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const waiting = park({ toolName: "Write" });
    const granted = park({ toolName: "Edit" });
    const spent = park({ toolName: "Bash" });
    const denied = park({ toolName: "Fetch" });
    for (const record of [waiting, granted, spent, denied]) await store.persist(record);
    expect((await store.decide(granted.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "decided",
    );
    expect((await store.decide(spent.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "decided",
    );
    expect((await store.consume(spent.id, spend())).outcome).toBe("consumed");
    expect((await store.decide(denied.id, { choice: "deny", actor: {} }, ALLOW)).outcome).toBe(
      "decided",
    );

    const answer = await expireOpenApprovals(root, { reason: "retired", now: () => AT });
    expect([...answer.expired].sort()).toEqual([waiting.id, granted.id].sort());

    const expires = logLines(root).filter((line) => line["event"] === "expire");
    expect(expires.map((line) => [line["decision"], line["reason"]]).sort()).toEqual(
      [
        [waiting.id, "retired"],
        [granted.id, "retired"],
      ].sort(),
    );
    const lines = rendezvousLines(root);
    const byId = new Map(lines.map((line) => [line["id"], line]));
    expect(lines).toHaveLength(4);
    expect(byId.get(waiting.id)?.["expiredAt"]).toBe(AT.toISOString());
    expect(byId.get(granted.id)?.["expiredAt"]).toBe(AT.toISOString());
    expect(byId.get(spent.id)?.["expiredAt"]).toBeUndefined();
    expect(byId.get(denied.id)?.["expiredAt"]).toBeUndefined();
    expect(byId.get(denied.id)?.["decision"]).toBe("deny");

    const later = createPendingApprovalStore({ rootDir: root });
    expect((await later.decide(waiting.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "expired",
    );
    expect(await later.consume(granted.id, spend())).toMatchObject({
      outcome: "refused",
      reason: "expired",
    });

    // A second pass finds nothing open, and writes no second line.
    expect((await expireOpenApprovals(root, { reason: "retired", now: () => AT })).expired).toEqual(
      [],
    );
    expect(logLines(root).filter((line) => line["event"] === "expire")).toHaveLength(2);
  });

  test("a root with no approvals is left alone and nothing is created", async () => {
    const root = tempRoot();
    const before = readdirSync(root);
    expect(await expireOpenApprovals(root, { reason: "retired", now: () => AT })).toEqual({
      expired: [],
    });
    expect(readdirSync(root)).toEqual(before);
    expect(existsSync(root)).toBe(true);
  });
});
