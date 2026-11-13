/**
 * The first decision on an approval wins (#507, #513): on every surface, after a
 * lock steal, across processes, against an 0.8.x writer's flipped line or
 * compaction, and through a crash between the claim and its lines. Supersede and
 * defer are the two ways a request changes afterwards, and reads never write.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DECISION_LOG_KEYS, OPERATOR_SUPERSEDE_REASONS, mintId } from "@crewhaus/control-contract";
import { createApproverReader, publishClaim } from "@crewhaus/control-records";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { buildTenant, withTenant } from "@crewhaus/tenancy";
import { _setApprovalSeamsForTest } from "./approvals/decide";
import { approvalsLedger } from "./approvals/log";
import {
  APPROVALS_DIGEST_KEY_FILE,
  APPROVALS_DIRNAME,
  type AuthorizeRequest,
  DEFAULT_APPROVALS_FILENAME,
  NO_PRINCIPAL_REASON,
  type PendingApproval,
  createPendingApprovalStore,
  evictExpiredApprovals,
  foldReadOnly,
  principalAuthorizer,
} from "./index";
import {
  ALLOW,
  hold,
  logLines,
  logText,
  pending,
  removeTempRoots,
  rendezvousLines,
  tempRoot,
} from "./test-helpers";

afterEach(() => _setApprovalSeamsForTest(undefined));
afterAll(removeTempRoots);

const decidedLines = (root: string, id: string) =>
  rendezvousLines(root).filter((l) => l["id"] === id && l["decision"] !== undefined);
const decideLines = (root: string, id: string) =>
  logLines(root).filter((l) => l["event"] === "decide" && l["decision"] === id);

/** Publish a decision claim the way another writer would, with no lines after it. */
function plantDecision(root: string, id: string, choice: "grant" | "deny"): void {
  const published = publishClaim(approvalsLedger(root), `decision/${id}`, {
    choice,
    decidedAt: "2026-11-11T10:00:00.000Z",
  });
  expect(published.ok).toBe(true);
}

/** Every file under `approvals.d/claims/`, as text. */
function claimTexts(root: string): string[] {
  const dir = join(root, APPROVALS_DIRNAME, "claims");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, "utf8"));
}

describe("the first decision wins", () => {
  test("a deny then a grant: the grant is refused, naming the deny; one decision on disk", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    const first = await store.decide(p.id, { choice: "deny", actor: { display: "max" } }, ALLOW);
    expect(first.outcome).toBe("decided");
    const second = await store.decide(p.id, { choice: "grant", actor: { display: "eve" } }, ALLOW);
    expect(second.outcome).toBe("already-decided");
    expect(second.winner?.decision).toBe("deny");
    expect(second.winner?.decidedBy).toBe("max");
    // resolve() is the first-wins wrapper: a later decision returns null.
    expect(await store.resolve(p.id, "grant", "eve")).toBeNull();
    expect(decidedLines(root, p.id)).toHaveLength(1);
    expect(decideLines(root, p.id)).toHaveLength(1);
    expect((await store.get(p.toolName, p.inputHash))?.decision).toBe("deny");
  });

  test("a lock-steal winner: the claim decides, and the loser completes the winner's lines once", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    const seam = hold();
    _setApprovalSeamsForTest({ afterFold: seam.hook });
    const a = store.decide(p.id, { choice: "grant", actor: { display: "A" } }, ALLOW);
    await seam.reached;
    _setApprovalSeamsForTest(undefined);
    // B decides while A sits past its fold, as a writer that stole the lock would.
    plantDecision(root, p.id, "deny");
    seam.release();
    const answer = await a;
    expect(answer.outcome).toBe("already-decided");
    expect(answer.winner?.decision).toBe("deny");
    // A claim holds no display name, so the completed line carries none.
    expect(answer.winner?.decidedBy).toBeUndefined();
    const lines = decidedLines(root, p.id);
    expect(lines.map((l) => l["decision"])).toEqual(["deny"]);
    const logged = decideLines(root, p.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.["outcome"]).toBe("repaired");
    expect(logged[0]?.["choice"]).toBe("deny");

    // A third touch appends nothing anywhere.
    const before = readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8");
    const logBefore = logText(root);
    const third = await store.decide(p.id, { choice: "grant", actor: { display: "C" } }, ALLOW);
    expect(third.outcome).toBe("already-decided");
    expect(readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8")).toBe(before);
    expect(logText(root)).toBe(logBefore);
  });

  test("two processes: a second process deciding the same request is refused", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    expect((await store.decide(p.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "decided",
    );
    const script = join(tempRoot("crewhaus-approvals-child-"), "child.ts");
    writeFileSync(
      script,
      [
        `import { allowSingleOwner, createPendingApprovalStore } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};`,
        "const [root, id] = process.argv.slice(2);",
        "const store = createPendingApprovalStore({ rootDir: root });",
        'const answer = await store.decide(id, { choice: "deny", actor: { display: "child" } }, { authorize: allowSingleOwner });',
        "console.log(JSON.stringify({ outcome: answer.outcome, winner: answer.winner?.decision }));",
      ].join("\n"),
    );
    const child = Bun.spawn([process.execPath, script, root, p.id], {
      env: { PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out.trim())).toEqual({ outcome: "already-decided", winner: "grant" });
    expect(decidedLines(root, p.id)).toHaveLength(1);
  }, 20_000); // spawns a bun process, slow by construction on CI

  test("an 0.8.x flip is ignored: the first decided line stands, and the flip is counted", async () => {
    const root = tempRoot();
    const p = pending();
    const grant = { ...p, decision: "grant", decidedBy: "max", decidedAt: "2026-11-11T10:00:00Z" };
    const flip = { ...p, decision: "deny", decidedBy: "eve", decidedAt: "2026-11-11T10:05:00Z" };
    writeFileSync(
      join(root, DEFAULT_APPROVALS_FILENAME),
      `${[p, grant, flip].map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    const folded = foldReadOnly(root);
    expect(folded.records.map((r) => r.decision)).toEqual(["grant"]);
    expect(folded.records[0]?.decidedBy).toBe("max");
    expect(folded.ignored).toBe(1);
    expect(folded.ignoredById.get(p.id)).toBe(1);
    const store = createPendingApprovalStore({ rootDir: root });
    expect((await store.get(p.toolName, p.inputHash))?.decision).toBe("grant");
  });

  test("an 0.8.x compaction that kept only a flipped line: the claim still decides", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    await store.decide(p.id, { choice: "grant", actor: { display: "max" } }, ALLOW);
    // What an 0.8.x boot sweep leaves after an 0.8.x deny: each id's LAST line.
    writeFileSync(
      join(root, DEFAULT_APPROVALS_FILENAME),
      `${JSON.stringify({ ...p, decision: "deny", decidedBy: "eve", decidedAt: new Date().toISOString() })}\n`,
    );
    expect(foldReadOnly(root).records[0]?.decision).toBe("grant");
    const again = await store.decide(p.id, { choice: "deny", actor: { display: "eve" } }, ALLOW);
    expect(again.outcome).toBe("already-decided");
    expect(again.winner?.decision).toBe("grant");
    // The repair is bounded: a later touch appends nothing more.
    const before = readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8");
    await store.decide(p.id, { choice: "deny", actor: {} }, ALLOW);
    expect(readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8")).toBe(before);
    expect(decideLines(root, p.id)).toHaveLength(1);
  });

  test("a grant spent after an 0.8.x flip and compaction stays spent, through the sweep", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    await store.decide(p.id, { choice: "grant", actor: { display: "max" } }, ALLOW);
    // An 0.8.x deny, then an 0.8.x compaction that kept only that line.
    writeFileSync(
      join(root, DEFAULT_APPROVALS_FILENAME),
      `${JSON.stringify({ ...p, decision: "deny", decidedBy: "eve", decidedAt: new Date().toISOString() })}\n`,
    );
    const grant = await store.get(p.toolName, p.inputHash);
    expect(grant?.decision).toBe("grant");
    expect(grant?.consumedAt).toBeUndefined();
    if (grant === null) throw new Error("unreachable");
    // The runtime spends it.
    await store.persist({ ...grant, consumedAt: new Date().toISOString() });
    expect(await store.get(p.toolName, p.inputHash)).toBeNull();
    const read = foldReadOnly(root).records[0];
    expect(read?.decision).toBe("grant");
    expect(read?.consumedAt).toBeDefined();
    expect(logLines(root).filter((l) => l["event"] === "consume")).toHaveLength(1);
    // The boot sweep rewrites the file from the fold: the spend survives it.
    await evictExpiredApprovals({ rootDir: root });
    const kept = rendezvousLines(root).filter((l) => l["id"] === p.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.["decision"]).toBe("grant");
    expect(kept[0]?.["consumedAt"]).toBeDefined();
    expect(await store.get(p.toolName, p.inputHash)).toBeNull();
  });

  test("a crash between claim and append: reads show it decided, the next write repairs it once", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    plantDecision(root, p.id, "grant");
    // A read shows the decision, and writes nothing.
    expect(foldReadOnly(root).records[0]?.decision).toBe("grant");
    expect((await store.get(p.toolName, p.inputHash))?.decision).toBe("grant");
    expect(decidedLines(root, p.id)).toHaveLength(0);
    // The next locked touch (a park for another call) repairs.
    await store.persist(pending({ toolName: "other", inputHash: "other-hash" }));
    expect(decidedLines(root, p.id).map((l) => l["decision"])).toEqual(["grant"]);
    const logged = decideLines(root, p.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.["outcome"]).toBe("repaired");
    await store.persist(pending({ toolName: "third", inputHash: "third-hash" }));
    expect(decidedLines(root, p.id)).toHaveLength(1);
    expect(decideLines(root, p.id)).toHaveLength(1);
  });

  test("a sweep holding the lock: a park waits for it, and is not lost to the rewrite", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    await store.persist(pending());
    const seam = hold();
    _setApprovalSeamsForTest({ afterFold: seam.hook });
    const sweep = evictExpiredApprovals({ rootDir: root });
    await seam.reached;
    _setApprovalSeamsForTest(undefined);
    const late = pending({ toolName: "late", inputHash: "late-hash" });
    let settled = false;
    const parked = store.persist(late).then(() => {
      settled = true;
    });
    // Long enough for the park to try the lock a few times; it must still be waiting.
    await Bun.sleep(150);
    expect(settled).toBe(false);
    seam.release();
    await sweep;
    await parked;
    expect(rendezvousLines(root).some((l) => l["id"] === late.id)).toBe(true);
  });
});

describe("supersede", () => {
  async function decided(choice: "grant" | "deny") {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    await store.decide(p.id, { choice, actor: { display: "max" } }, ALLOW);
    return { root, store, p };
  }

  test("a reason outside the operator list throws before anything is written", async () => {
    const { root, store, p } = await decided("deny");
    const before = readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8");
    await expect(
      store.supersede(p.id, { actor: {}, reason: "revision-changed" }, ALLOW),
    ).rejects.toThrow(/decided-in-error/);
    await expect(store.supersede(p.id, { actor: {}, reason: "because" }, ALLOW)).rejects.toThrow(
      /not a reason to supersede/,
    );
    expect(readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8")).toBe(before);
  });

  test("a consumed grant is stale", async () => {
    const { store, p } = await decided("grant");
    const grant = await store.get(p.toolName, p.inputHash);
    if (grant === null) throw new Error("expected the grant");
    await store.persist({ ...grant, consumedAt: new Date().toISOString() });
    const answer = await store.supersede(p.id, { actor: {}, reason: "policy-changed" }, ALLOW);
    expect(answer.outcome).toBe("stale");
  });

  test("a decided deny is replaced by a fresh pending request that names it", async () => {
    const { root, store, p } = await decided("deny");
    const asked: AuthorizeRequest[] = [];
    const answer = await store.supersede(
      p.id,
      { actor: { display: "max" }, via: "cli", reason: "decided-in-error" },
      {
        authorize: (request) => {
          asked.push(request);
          return { ok: true };
        },
      },
    );
    expect(answer.outcome).toBe("superseded");
    expect(asked.map((a) => [a.op, a.requiredClass])).toEqual([["supersede", "maintainer"]]);
    const fresh = answer.fresh;
    if (fresh === undefined) throw new Error("expected a fresh request");
    expect(answer.record?.supersededBy).toBe(fresh.id);
    expect(answer.record?.supersededReason).toBe("decided-in-error");
    expect(fresh.supersedes).toEqual({ id: p.id, decision: "deny" });
    expect(fresh.decision).toBeUndefined();
    // The runtime's lookup finds the fresh request, not the superseded deny.
    expect((await store.get(p.toolName, p.inputHash))?.id).toBe(fresh.id);
    const folded = foldReadOnly(root).records;
    expect(folded.find((r) => r.id === p.id)?.supersededBy).toBe(fresh.id);
    // The fresh request is decided the ordinary way.
    expect((await store.decide(fresh.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "decided",
    );
    // A second supersede of the old one is stale.
    const again = await store.supersede(p.id, { actor: {}, reason: "other" }, ALLOW);
    expect(again.outcome).toBe("stale");
  });

  test("a refusing authorizer answers forbidden and writes nothing", async () => {
    const { root, store, p } = await decided("deny");
    const before = readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8");
    const answer = await store.supersede(
      p.id,
      { actor: {}, reason: "other" },
      { authorize: () => ({ ok: false, reason: "a maintainer may do this" }) },
    );
    expect(answer).toMatchObject({ outcome: "forbidden", reason: "a maintainer may do this" });
    expect(readFileSync(join(root, DEFAULT_APPROVALS_FILENAME), "utf8")).toBe(before);
  });

  test("a supersede another writer claimed first answers already-decided, and its fresh park is completed", async () => {
    const { root, store, p } = await decided("grant");
    const seam = hold();
    _setApprovalSeamsForTest({ afterFold: seam.hook });
    const mine = store.supersede(p.id, { actor: {}, reason: "other" }, ALLOW);
    await seam.reached;
    _setApprovalSeamsForTest(undefined);
    const theirs = "appr_00000000000000f1";
    const published = publishClaim(approvalsLedger(root), `supersede/${p.id}`, {
      supersededBy: theirs,
      reason: "policy-changed",
      parkedAt: new Date().toISOString(),
    });
    expect(published.ok).toBe(true);
    seam.release();
    const answer = await mine;
    expect(answer.outcome).toBe("already-decided");
    expect(answer.winner?.supersededBy).toBe(theirs);
    const parked = rendezvousLines(root).filter((l) => l["id"] === theirs);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.["supersedes"]).toEqual({ id: p.id, decision: "grant" });
    expect((await store.get(p.toolName, p.inputHash))?.id).toBe(theirs);
  });
});

describe("defer", () => {
  const NOW = Date.parse("2026-11-11T12:00:00.000Z");

  async function parked() {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root, now: () => new Date(NOW) });
    const p = pending({ createdAt: new Date(NOW).toISOString() });
    await store.persist(p);
    return { root, store, p };
  }

  test("accepted: the record carries deferredUntil, and the log says until and why", async () => {
    const { root, store, p } = await parked();
    const answer = await store.defer(
      p.id,
      { until: "2026-11-12T09:00:00+01:00", reason: "awaiting-someone", actor: {}, via: "cli" },
      ALLOW,
    );
    expect(answer.outcome).toBe("deferred");
    expect(answer.record?.deferredUntil).toBe("2026-11-12T08:00:00.000Z");
    expect(foldReadOnly(root).records[0]?.deferredUntil).toBe("2026-11-12T08:00:00.000Z");
    const line = logLines(root).find((l) => l["event"] === "defer");
    expect(line).toMatchObject({
      until: "2026-11-12T08:00:00.000Z",
      reason: "awaiting-someone",
      surface: "cli",
    });
    expect(line && "choice" in line).toBe(false);
    // Still pending: it can be decided after a deferral.
    expect((await store.decide(p.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "decided",
    );
  });

  test("refused once a decision claim exists, even with no decided line yet", async () => {
    const { root, store, p } = await parked();
    plantDecision(root, p.id, "deny");
    const answer = await store.defer(
      p.id,
      { until: "2026-11-12T09:00:00Z", reason: "scheduled", actor: {} },
      ALLOW,
    );
    expect(answer.outcome).toBe("already-decided");
    expect(answer.winner?.decision).toBe("deny");
    expect(logLines(root).some((l) => l["event"] === "defer")).toBe(false);
  });

  test("an offsetless or past time, or an unknown reason, is refused before anything is written", async () => {
    const { store, p } = await parked();
    const at = (until: string, reason = "scheduled") =>
      store.defer(p.id, { until, reason, actor: {} }, ALLOW);
    await expect(at("2026-11-12T09:00:00")).rejects.toThrow(/no UTC offset/);
    await expect(at("2026-11-12")).rejects.toThrow(/not an ISO date and time/);
    await expect(at("2026-11-10T09:00:00Z")).rejects.toThrow(/not later than now/);
    await expect(at("2026-11-12T09:00:00Z", "busy")).rejects.toThrow(/awaiting-information/);
  });
});

describe("what a claim keeps", () => {
  test("no free text outlives the TTL: an evicted request's claim holds no display name", async () => {
    const root = tempRoot();
    const NAME = "Alice Smith";
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    const decided = await store.decide(p.id, { choice: "grant", actor: { display: NAME } }, ALLOW);
    expect(decided.outcome).toBe("decided");
    // Before the TTL the name is shown, from the decided line.
    expect(decided.record?.decidedBy).toBe(NAME);
    expect(foldReadOnly(root).records[0]?.decidedBy).toBe(NAME);
    const later = new Date(Date.now() + 40 * 86_400_000);
    const swept = await evictExpiredApprovals({ rootDir: root, now: () => later });
    expect(swept.evictedIds).toEqual([p.id]);
    expect(rendezvousLines(root)).toHaveLength(0);
    // The claim is kept, so the first decision still wins; it names no one in text.
    const claims = claimTexts(root);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((text) => text.includes('"choice":"grant"'))).toBe(true);
    for (const text of claims) {
      expect(text).not.toContain(NAME);
      expect(text).not.toContain('decidedBy"');
    }
    expect(logText(root)).not.toContain(NAME);
  });
});

describe("reads never write", () => {
  test("list(), get() and foldReadOnly() leave approvals.jsonl byte- and inode-identical", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    await store.decide(p.id, { choice: "grant", actor: {} }, ALLOW);
    await store.persist(pending({ toolName: "b", inputHash: "b-hash" }));
    const path = join(root, DEFAULT_APPROVALS_FILENAME);
    const bytes = readFileSync(path);
    const ino = statSync(path).ino;
    await store.list();
    await store.get(p.toolName, p.inputHash);
    foldReadOnly(root);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(statSync(path).ino).toBe(ino);
  });

  test("reads on a fresh root create nothing, and neither does the boot sweep", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    expect(await store.list()).toEqual([]);
    expect(await store.get("t", "h")).toBeNull();
    expect(foldReadOnly(root)).toMatchObject({ state: "absent", records: [] });
    expect(await evictExpiredApprovals({ rootDir: root })).toEqual({ evictedIds: [] });
    expect(readdirSync(root)).toEqual([]);
    const missing = join(root, "never-made");
    expect(await evictExpiredApprovals({ rootDir: missing })).toEqual({ evictedIds: [] });
    expect(existsSync(missing)).toBe(false);
  });
});

describe("the tenant fence", () => {
  test("inside a tenant scope, decide writes only under the tenant's session root, key included", async () => {
    const tenantsRoot = tempRoot("crewhaus-approvals-tenants-");
    const tenant = buildTenant("acme", { tenantsRoot });
    const store = createPendingApprovalStore({ rootDir: tenant.sessionRoot });
    const p = pending();
    await withTenant(tenant, async () => {
      await store.persist(p);
      expect((await store.decide(p.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
        "decided",
      );
    });
    expect(existsSync(join(tenant.sessionRoot, APPROVALS_DIGEST_KEY_FILE))).toBe(true);
    expect(existsSync(join(tenant.sessionRoot, APPROVALS_DIRNAME, "claims", "decision"))).toBe(
      true,
    );
    expect(readdirSync(join(tenantsRoot, "acme"))).toEqual(["sessions"]);
    expect(readdirSync(tenantsRoot)).toEqual(["acme"]);

    // A store rooted outside the tenant is refused before anything is created.
    const outside = join(tempRoot("crewhaus-approvals-outside-"), "sessions");
    const stray = createPendingApprovalStore({ rootDir: outside });
    await withTenant(tenant, async () => {
      await expect(stray.decide(p.id, { choice: "deny", actor: {} }, ALLOW)).rejects.toThrow(
        /cross-tenant/,
      );
    });
    expect(existsSync(outside)).toBe(false);
  });
});

describe("principalAuthorizer", () => {
  const OWNER = mintId("prn");
  const OPERATOR = mintId("prn");
  const MAINTAINER = mintId("prn");
  const SERVICE = mintId("prn");
  const projection = {
    v: 1,
    epoch: 1,
    generatedAt: "2026-11-07T00:00:00.000Z",
    harness: "hrn_0123456789abcdef",
    owner: OWNER,
    governedSince: "2026-11-01T00:00:00.000Z",
    members: [
      { principal: OPERATOR, decide: "operator" },
      { principal: MAINTAINER, decide: "maintainer" },
      { principal: SERVICE, decide: "maintainer" },
    ],
    links: [],
  };
  const reader = () => createApproverReader({ now: () => 0 });
  const harness = (body?: string): string => {
    const dir = tempRoot("crewhaus-approvals-harness-");
    if (body !== undefined) {
      const control = join(dir, ".crewhaus", "run", "control");
      mkdirSync(control, { recursive: true });
      writeFileSync(join(control, "approvers.json"), body);
    }
    return dir;
  };
  const governed = () => harness(`${JSON.stringify(projection)}\n`);
  const claimsOf = (root: string): string[] => claimTexts(root);

  async function parked(requiredClass?: "maintainer") {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending(requiredClass !== undefined ? { requiredClass } : {});
    await store.persist(p);
    return { root, store, p };
  }

  test("no projection: decided, and no principal is recorded", async () => {
    const { root, store, p } = await parked();
    const answer = await store.decide(
      p.id,
      { choice: "grant", actor: { display: "alice" } },
      { authorize: principalAuthorizer(harness(), {}, { reader: reader() }) },
    );
    expect(answer.outcome).toBe("decided");
    expect(answer.record?.decidedByPrincipal).toBeUndefined();
    expect(decideLines(root, p.id)[0]?.["by"]).toBeUndefined();
  });

  test("no projection: a signed-in principal is recorded", async () => {
    const { store, p } = await parked();
    const answer = await store.decide(
      p.id,
      { choice: "grant", actor: {} },
      { authorize: principalAuthorizer(harness(), { principal: OWNER }, { reader: reader() }) },
    );
    expect(answer.record?.decidedByPrincipal).toBe(OWNER);
  });

  test("an operator on a request that needs a maintainer: refused by class, nothing claimed", async () => {
    const { root, store, p } = await parked("maintainer");
    const answer = await store.decide(
      p.id,
      { choice: "grant", actor: { display: "op" } },
      { authorize: principalAuthorizer(governed(), { principal: OPERATOR }, { reader: reader() }) },
    );
    expect(answer.outcome).toBe("forbidden");
    expect(answer.reason).toBe("Needs a maintainer.");
    expect(answer.reason).not.toContain(MAINTAINER);
    expect(claimsOf(root)).toEqual([]);
    expect(decideLines(root, p.id)).toHaveLength(0);
  });

  test("a maintainer decides it, and the decision is recorded as that member", async () => {
    const { root, store, p } = await parked("maintainer");
    const answer = await store.decide(
      p.id,
      { choice: "grant", actor: { local: "local:alice@host", display: "alice" } },
      {
        authorize: principalAuthorizer(governed(), { principal: MAINTAINER }, { reader: reader() }),
      },
    );
    expect(answer.outcome).toBe("decided");
    expect(answer.record?.decidedByPrincipal).toBe(MAINTAINER);
    expect(answer.record?.decidedBy).toBe("alice");
    expect(decideLines(root, p.id)[0]?.["by"]).toBe(MAINTAINER);
  });

  test("an operator cannot supersede; the owner can", async () => {
    const { store, p } = await parked();
    await store.decide(
      p.id,
      { choice: "grant", actor: {} },
      { authorize: principalAuthorizer(governed(), { principal: OWNER }, { reader: reader() }) },
    );
    const refused = await store.supersede(
      p.id,
      { actor: {}, reason: "decided-in-error" },
      { authorize: principalAuthorizer(governed(), { principal: OPERATOR }, { reader: reader() }) },
    );
    expect(refused.outcome).toBe("forbidden");
    expect(refused.reason).toBe("Needs a maintainer.");
    const done = await store.supersede(
      p.id,
      { actor: {}, reason: "decided-in-error" },
      { authorize: principalAuthorizer(governed(), { principal: OWNER }, { reader: reader() }) },
    );
    expect(done.outcome).toBe("superseded");
  });

  test("a service principal decides nothing above operator", async () => {
    const { root, store, p } = await parked("maintainer");
    const answer = await store.decide(
      p.id,
      { choice: "grant", actor: {} },
      {
        authorize: principalAuthorizer(
          governed(),
          { principal: SERVICE, service: true },
          { reader: reader() },
        ),
      },
    );
    expect(answer.outcome).toBe("forbidden");
    expect(answer.reason).toBe("Needs a maintainer.");
    expect(claimsOf(root)).toEqual([]);
    // The same member signed in as a person reaches maintainer.
    const asPerson = await store.decide(
      p.id,
      { choice: "grant", actor: {} },
      { authorize: principalAuthorizer(governed(), { principal: SERVICE }, { reader: reader() }) },
    );
    expect(asPerson.outcome).toBe("decided");
  });

  test("a governed harness refuses a decision with no principal", async () => {
    const { root, store, p } = await parked();
    const answer = await store.decide(
      p.id,
      { choice: "deny", actor: { display: "anyone" } },
      { authorize: principalAuthorizer(governed(), {}, { reader: reader() }) },
    );
    expect(answer.outcome).toBe("forbidden");
    expect(answer.reason).toBe(NO_PRINCIPAL_REASON);
    expect(claimsOf(root)).toEqual([]);
  });

  test("a stranger to the projection is refused; the owner always decides", async () => {
    const { store, p } = await parked("maintainer");
    const stranger = await store.decide(
      p.id,
      { choice: "grant", actor: {} },
      {
        authorize: principalAuthorizer(
          governed(),
          { principal: mintId("prn") },
          { reader: reader() },
        ),
      },
    );
    expect(stranger.outcome).toBe("forbidden");
    const owner = await store.decide(
      p.id,
      { choice: "grant", actor: {} },
      { authorize: principalAuthorizer(governed(), { principal: OWNER }, { reader: reader() }) },
    );
    expect(owner.record?.decidedByPrincipal).toBe(OWNER);
  });

  test("an unreadable projection: forbidden, naming crewhaus access sync", async () => {
    const dir = harness("{ not json");
    const { root, store, p } = await parked();
    const decided = await store.decide(
      p.id,
      { choice: "grant", actor: {} },
      { authorize: principalAuthorizer(dir, { principal: OWNER }, { reader: reader() }) },
    );
    expect(decided.outcome).toBe("forbidden");
    expect(decided.reason).toContain("crewhaus access sync");
    expect(decidedLines(root, p.id)).toHaveLength(0);
  });
});

describe("field names", () => {
  test("no new record field or log key reads as a credential to the masker", () => {
    const fields: (keyof PendingApproval)[] = [
      "decidedByPrincipal",
      "decidedVia",
      "supersededBy",
      "supersededReason",
      "deferredUntil",
    ];
    const names = [...fields, ...DECISION_LOG_KEYS, "choice", "decidedAt", "parkedAt"];
    expect(names.filter((name) => isCredentialKey(name))).toEqual([]);
    // The operator reasons are the ones the CLI offers.
    expect([...OPERATOR_SUPERSEDE_REASONS]).toContain("decided-in-error");
  });
});
