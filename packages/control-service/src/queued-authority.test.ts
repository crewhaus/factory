/**
 * `homeAuthorizeActor` over real access records: a command recovered from its receipt runs
 * only while its actor still holds the permission, as the records are at that moment.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { ensureAccessSetUp, localActorOf, openAccess } from "@crewhaus/access-control";
import { commandsLedgerOf } from "./ledgers";
import { homeAuthorizeActor } from "./queued-authority";
import { IDENTITY, NOW, plantReceipt, removeTempDirs, rig, rowsOf, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const HARNESS = "hrn_0123456789abcdef";
const TARGET = `home/harness/${HARNESS}`;

/** A Home with an owner, a member Riley on the group `team`, and Riley's grant id. */
async function home() {
  const hangarRoot = tempDir("control-service-authority-");
  const setUp = await ensureAccessSetUp(hangarRoot, {
    localActor: localActorOf(IDENTITY),
    now: () => NOW,
  });
  if (!setUp.ok) throw new Error(setUp.reason);
  const owner = setUp.result.owner;
  const granted = await openAccess(hangarRoot).grant(
    { principal: owner },
    { member: "Riley", create: true, role: "operator", scope: "group:team" },
  );
  if (!granted.ok) throw new Error(granted.reason);
  const groups = { of: ["team"] as readonly string[] };
  const authorizeActor = homeAuthorizeActor({
    hangarRoot,
    groupsOf: (hrn) => (hrn === HARNESS ? groups.of : []),
    now: Date.now,
  });
  return {
    hangarRoot,
    owner,
    member: granted.result.principal,
    grant: granted.result.grant.id,
    groups,
    authorizeActor,
  };
}

/** Recover one planted accepted `controls.stop` by `actor`, on a harness of its own. */
async function recoverStop(h: Awaited<ReturnType<typeof home>>, actor: string) {
  const r = rig({ hangarRoot: h.hangarRoot, authorizeActor: h.authorizeActor });
  const ledger = commandsLedgerOf(r.harness);
  plantReceipt(ledger, { id: "cmd_01jc00000000000000000000c1", actor, target: TARGET });
  await r.service.commands.recover({ harness: r.harness });
  const rows = rowsOf(ledger);
  return {
    states: rows.map((row) => row["state"]),
    outcome: (rows.at(-1)?.["outcome"] as { code?: string } | undefined)?.code,
    stops: r.supervisor.calls.filter((call) => call === "stop").length,
  };
}

describe("homeAuthorizeActor answers from the access records as they are", () => {
  test("a member's recovered command runs while the grant holds", async () => {
    const h = await home();
    expect(await recoverStop(h, h.member)).toEqual({
      states: ["accepted", "running", "succeeded"],
      outcome: undefined,
      stops: 1,
    });
  });

  test("a member's recovered command is rejected, unrun, once the grant is revoked", async () => {
    const h = await home();
    const revoked = await openAccess(h.hangarRoot).revoke({ principal: h.owner }, h.grant);
    if (!revoked.ok) throw new Error(revoked.reason);
    expect(await recoverStop(h, h.member)).toEqual({
      states: ["accepted", "rejected"],
      outcome: "forbidden",
      stops: 0,
    });
  });

  test("a grant on a group holds only for a harness the registry puts in that group", async () => {
    const h = await home();
    h.groups.of = [];
    expect(await recoverStop(h, h.member)).toMatchObject({ outcome: "forbidden", stops: 0 });
  });

  test("the owner's recovered command runs", async () => {
    const h = await home();
    expect(await recoverStop(h, h.owner)).toMatchObject({
      states: ["accepted", "running", "succeeded"],
      stops: 1,
    });
  });

  test("a Home whose access records are not there answers undetermined, not no", async () => {
    const authorizeActor = homeAuthorizeActor({
      hangarRoot: tempDir("control-service-authority-"),
      groupsOf: () => [],
      now: Date.now,
    });
    expect(authorizeActor("prn_01jc0000000000000000000001", "h.control", TARGET)).toBeUndefined();
  });
});
