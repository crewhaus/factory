/**
 * Home's own key manages delegation rules on a governed harness exactly as it manages
 * standing rules: it acts as the owner Home's access records name, so it may turn a rule
 * on, change it and end it where the harness's approver list names that owner, and is
 * refused where the list names someone else. The list's `you` flags say the same. A caller
 * with its own actor, a service caller among them, acts on delegation rules only as itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { casAppend, delegationsLedger } from "@crewhaus/control-records";
import { type V1Home, v1Home } from "../__test__/v1-home";

const POLICY = `sha256:${"1".repeat(64)}`;

let home: V1Home;
let mine: { id: string; dir: string; rule: string };
let theirs: { id: string; dir: string; rule: string };

/** Write a harness's approver list naming `owner`, as Home's access sync writes it. */
function plantProjection(dir: string, harness: string, owner: string): void {
  const control = join(dir, ".crewhaus", "run", "control");
  mkdirSync(control, { recursive: true });
  writeFileSync(
    join(control, "approvers.json"),
    `${JSON.stringify({
      v: 1,
      epoch: 1,
      generatedAt: new Date().toISOString(),
      harness,
      owner,
      governedSince: new Date(Date.now() - 86_400_000).toISOString(),
      members: [],
      links: [],
      accessRoot: realpathSync(home.t.hangarRoot),
    })}\n`,
  );
}

/** A rule turned on by `owner`, straight into the records. */
async function plantRule(dir: string, harness: string, owner: string): Promise<string> {
  const id = mintId("rule");
  await casAppend(delegationsLedger(dir), id, null, {
    v: 1,
    at: new Date().toISOString(),
    id,
    state: "enabled",
    kind: "delegate",
    action: "merge",
    revision: 1,
    scope: { harness },
    terms: { days: 14 },
    termsDigest: "a".repeat(64),
    ceilingDigest: POLICY,
    policyRevision: POLICY,
    consequencesDigest: "b".repeat(64),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    owner,
    by: owner,
    cmd: mintId("cmd"),
  });
  return id;
}

beforeAll(async () => {
  home = await v1Home();
  const m = await home.harness("governed-mine");
  plantProjection(m.dir, m.id, home.owner);
  mine = { ...m, rule: await plantRule(m.dir, m.id, home.owner) };
  const other = mintId("prn");
  const t = await home.harness("governed-theirs");
  plantProjection(t.dir, t.id, other);
  theirs = { ...t, rule: await plantRule(t.dir, t.id, other) };
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

/** Call as Home's own key. */
const asHome = (method: string, path: string, body?: unknown) =>
  home.call(method, path, { secret: home.t.token, ...(body !== undefined ? { body } : {}) });

/** The three owner's writes on a harness: change, turn on, end. */
async function ownerWrites(h: { id: string; rule: string }) {
  const base = `/api/v1/harnesses/${h.id}/delegations`;
  const digest = "0".repeat(64);
  const update = await asHome("POST", `${base}/${h.rule}/update`, {
    expect: 1,
    terms: { days: 7 },
    consequencesDigest: digest,
    confirm: "x",
  });
  const enable = await asHome("POST", base, {
    action: "merge",
    consequencesDigest: digest,
    confirm: "x",
  });
  const revoke = await asHome("POST", `${base}/${h.rule}/revoke`, {});
  return { update, enable, revoke };
}

const reasonOf = (body: Record<string, unknown>) =>
  (
    (body["error"] as Record<string, unknown> | undefined)?.["details"] as
      | Record<string, unknown>
      | undefined
  )?.["reason"];

describe("Home's own key and delegation rules", () => {
  test("where the approver list names Home's owner, it manages them as it manages standing rules", async () => {
    const listed = await asHome("GET", `/api/v1/harnesses/${mine.id}/delegations`);
    expect(listed.status).toBe(200);
    expect((listed.body["you"] as Record<string, unknown>)["manage"]).toBe(true);
    const { update, enable, revoke } = await ownerWrites(mine);
    // No action is served in the shipped composition: past the owner's check, the
    // change and the new rule answer that nothing can be delegated yet.
    expect([update.status, update.body["error"]]).toEqual([
      501,
      expect.objectContaining({ code: "unsupported" }),
    ]);
    expect([enable.status, enable.body["error"]]).toEqual([
      501,
      expect.objectContaining({ code: "unsupported" }),
    ]);
    expect(revoke.status).toBeLessThan(300);
    const ended = await asHome("GET", `/api/v1/harnesses/${mine.id}/delegations`);
    expect((ended.body["items"] as { id: string; state: string }[])[0]).toMatchObject({
      id: mine.rule,
      state: "revoked",
    });
    const standing = await asHome(
      "POST",
      `/api/v1/harnesses/${mine.id}/standing-rules/${mintId("rule")}/revoke`,
      {},
    );
    expect(standing.status).not.toBe(403);
  });

  test("where the approver list names another owner, every owner's write is refused, as for standing rules", async () => {
    const listed = await asHome("GET", `/api/v1/harnesses/${theirs.id}/delegations`);
    expect(listed.status).toBe(200);
    expect((listed.body["you"] as Record<string, unknown>)["manage"]).toBe(false);
    const writes = await ownerWrites(theirs);
    for (const [name, res] of Object.entries(writes)) {
      expect([name, res.status, reasonOf(res.body)]).toEqual([name, 403, "owner_only"]);
    }
    const standing = await asHome(
      "POST",
      `/api/v1/harnesses/${theirs.id}/standing-rules/${mintId("rule")}/revoke`,
      {},
    );
    expect(standing.status).toBe(403);
  });
});

describe("a service caller and delegation rules", () => {
  test("a caller with an actor and a system principal acts only as itself, and is refused an owner's write", async () => {
    const { openHangarRegistry } = await import("@crewhaus/harness-registry");
    const { systemAccess } = await import("../access");
    const { OPERATION_BY_ID } = await import("./match");
    const { DELEGATION_HANDLERS } = await import("./delegations");
    const { V1Error } = await import("./errors");
    const control = home.t.server.controlService;
    // A live rule on the harness whose approver list names Home's owner.
    const rule = await plantRule(mine.dir, mine.id, home.owner);
    // Every actor the owner's check is asked about.
    const asked: unknown[] = [];
    const decisions = {
      ...control.decisions,
      mayManageRules: (dir: string, actor: unknown) => {
        asked.push(actor);
        return control.decisions.mayManageRules(dir, actor as never);
      },
    };
    const sys = systemAccess("sweep");
    // Its authority allows the write's permission: only the owner's check can refuse it.
    const access = {
      ...sys,
      authorize: () => ({ allow: true as const, grant: sys.caller.principal }),
    };
    const op = OPERATION_BY_ID.get("delegations.revoke");
    if (op === undefined) throw new Error("no delegations.revoke operation");
    const ctx = {
      req: new Request("http://127.0.0.1/"),
      url: new URL("http://127.0.0.1/"),
      op,
      params: { h: mine.id, rule },
      query: {},
      body: {},
      access,
      deps: {
        hangarRoot: home.t.hangarRoot,
        registry: openHangarRegistry({ root: home.t.registryRoot, env: {} }),
        control: { ...control, decisions },
        now: Date.now,
      },
      via: "system",
      actor: sys.caller.principal,
      refResolvers: new Map(),
      capabilityProviders: [],
      projections: [],
      streamSources: [],
    } as unknown as Parameters<NonNullable<(typeof DELEGATION_HANDLERS)["delegations.revoke"]>>[0];
    let thrown: unknown;
    try {
      await DELEGATION_HANDLERS["delegations.revoke"]?.(ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(V1Error);
    const input = (thrown as InstanceType<typeof V1Error>).input;
    expect([input.status, input.reason]).toEqual([403, "owner_only"]);
    expect(input.message).toBe(
      "Only this harness's owner turns a delegation rule on, changes it or ends it.",
    );
    // It was asked about as itself, never as Home's bootstrap owner.
    expect(asked).toEqual([{ kind: "principal", principal: "sys:sweep" }]);
    // The rule stands.
    const listed = await asHome("GET", `/api/v1/harnesses/${mine.id}/delegations`);
    const row = (listed.body["items"] as { id: string; state: string }[]).find(
      (item) => item.id === rule,
    );
    expect(row?.state).toBe("active");
    // The library gives a system actor the same answer on its own.
    const direct = await control.delegations.revoke(
      { dir: mine.dir, id: mine.id, name: "governed-mine" },
      { rule, actor: { kind: "principal", principal: "sys:sweep" }, cmd: mintId("cmd") },
    );
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.code).toBe("forbidden");
      expect(direct.reason).toBe(
        "The system never turns a delegation rule on, changes or resumes one: a person does.",
      );
    }
  });
});
