/**
 * A decision made in Home names the decision in its receipt (`<hrn>/decision/<appr_>`),
 * the ref the CLI's decision verbs write, so a decision interrupted after it was accepted
 * settles by what the approval records when Home next boots.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { join } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import { mintId } from "@crewhaus/control-contract";
import { type LedgerRecord, append, foldStates } from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import { bearer, signInFromBootLink } from "./__test__/browser";
import { makeFixtureHarness } from "./fixture";
import { startHangarServer } from "./server";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();
const APPROVALS = [
  "appr_00000000000000c1",
  "appr_00000000000000c2",
  "appr_00000000000000c3",
  "appr_00000000000000c4",
];

function receipts(dir: string): LedgerRecord[] {
  const fold = foldStates(commandsLedgerOf(dir));
  return fold.ok ? [...fold.objects.values()].map((object) => object.record) : [];
}

async function governedHome() {
  const t = bootTestServer();
  servers.push(t);
  const browser = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
  const dir = makeFixtureHarness(join(t.harnessesRoot, "decided"), {
    specName: "decided",
    approvals: APPROVALS.map((id, n) => ({
      id,
      toolName: "SendMessage",
      inputHash: `hash-${n}`,
      input: { channel: "ops", text: `message ${n}` },
      runId: "run_00000000000000c0",
      sessionId: "sess_00000000000000cc",
      surface: "daemon",
      createdAt: iso(NOW - 60_000),
    })),
  });
  const added = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  const id = (added.body["entry"] as { id: string }).id;
  const read = loadAccessSnapshot(t.hangarRoot);
  if (read.state !== "present") throw new Error("no access records");
  const owner = read.snapshot.owner as string;
  const post = (path: string) =>
    t.fetchRaw(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(browser.session) },
      body: "{}",
    });
  return { t, dir, id, owner, post };
}

describe("a Home decision's receipt", () => {
  test("a grant and a deny each name the decision, in the harness's own ledger, with no id in params", async () => {
    const h = await governedHome();
    expect((await h.post(`/api/h/${h.id}/approvals/${APPROVALS[0]}/grant`)).status).toBe(200);
    expect((await h.post(`/api/h/${h.id}/approvals/${APPROVALS[1]}/deny`)).status).toBe(200);
    const decided = receipts(h.dir).filter((row) => row["kind"] === "decisions.resolve");
    expect(decided.map((row) => row["target"])).toEqual([
      `${h.id}/decision/${APPROVALS[0]}`,
      `${h.id}/decision/${APPROVALS[1]}`,
    ]);
    expect(decided.map((row) => row["actor"])).toEqual([h.owner, h.owner]);
    expect(decided.map((row) => row["state"])).toEqual(["succeeded", "succeeded"]);
  });

  test("a malformed approval id writes no receipt and is answered 400", async () => {
    const h = await governedHome();
    const before = receipts(h.dir).length;
    const res = await h.post(`/api/h/${h.id}/approvals/appr_nothex/grant`);
    expect(res.status).toBe(400);
    expect(receipts(h.dir).length).toBe(before);
  });
});

describe("a Home decision interrupted after it was accepted", () => {
  /**
   * The receipt a grant from Home writes, planted `accepted` under a new id with an
   * executor that died, then the approval's claim written by `decider` (or none), then a
   * Home booted over the same root.
   */
  async function recoveredAs(decider: "same" | "other" | "none") {
    const h = await governedHome();
    expect((await h.post(`/api/h/${h.id}/approvals/${APPROVALS[0]}/grant`)).status).toBe(200);
    const written = receipts(h.dir).find((row) => row["kind"] === "decisions.resolve");
    if (written === undefined) throw new Error("no receipt");
    // The middleware's own target, moved to the approval this copy is about.
    const target = String(written["target"]).replace(
      APPROVALS[0] as string,
      APPROVALS[2] as string,
    );
    const cmd = mintId("cmd");
    const planted = append(commandsLedgerOf(h.dir), {
      ...written,
      id: cmd,
      target,
      state: "accepted",
      acceptedAt: iso(Date.now() - 1000),
      executor: {
        pid: 2_147_483_000,
        startedAt: iso(Date.now() - 2000),
        host: hostname(),
        head: "server",
      },
      effects: [],
      claim: undefined,
      endedAt: undefined,
      startedAt: undefined,
    });
    if (!planted.ok) throw new Error(planted.reason);
    if (decider !== "none") {
      let principal = h.owner;
      if (decider === "other") {
        const access = openAccess(h.t.hangarRoot, {
          harnesses: () => [{ id: h.id, dir: h.dir, groups: [] }],
        });
        const granted = await access.grant(
          { principal: h.owner },
          { member: "Ana", create: true, role: "operator", scope: `harness:${h.id}` },
        );
        if (!granted.ok) throw new Error(granted.reason);
        principal = granted.result.principal;
      }
      const resolved = await h.t.server.controlService.decisions.resolve({
        harnessDir: h.dir,
        ref: APPROVALS[2] as string,
        choice: "grant",
        actor: { kind: "principal", principal },
        via: "home",
      });
      expect([resolved.outcome, resolved.reason]).toEqual(["decided", undefined]);
    }
    await h.t.server.stop();
    const again = startHangarServer({
      port: 0,
      root: h.t.hangarRoot,
      registryRoot: h.t.registryRoot,
      env: { CREWHAUS_WATCHME_ROOT: join(h.t.workspace, "watchme") },
      onWarn: () => undefined,
    });
    try {
      await again.ready;
    } finally {
      await again.stop();
    }
    return receipts(h.dir).find((row) => row["id"] === cmd);
  }

  test("the receipt's own actor's claim: succeeded", async () => {
    const row = await recoveredAs("same");
    expect(row?.["state"]).toBe("succeeded");
  }, 20_000);

  test("another member's claim: failed, already decided", async () => {
    const row = await recoveredAs("other");
    expect([row?.["state"], (row?.["outcome"] as { code: string } | undefined)?.code]).toEqual([
      "failed",
      "already_decided",
    ]);
  }, 20_000);

  test("no claim: unknown, for a person to decide", async () => {
    const row = await recoveredAs("none");
    expect([row?.["state"], row?.["outcome"]]).toEqual([
      "unknown",
      { code: "interrupted", message: "interrupted, needs a decision" },
    ]);
  }, 20_000);
});
