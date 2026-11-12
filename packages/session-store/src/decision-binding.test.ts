/**
 * A grant binds to the action, its scope and its revisions, and is spent once
 * (#507, #513): a park seals its binding with the session root's key; a lookup
 * finds a record only in the scope it was asked in; `consume` makes the checks
 * under the lock and spends by an exclusive claim; a refusal that retires a grant
 * parks the request asked in its place; and a cancelled run's requests are
 * withdrawn with nothing asked in their place.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApproverProjection,
  DECISION_LOG_KEYS,
  mintId,
  mintRunId,
} from "@crewhaus/control-contract";
import { publishClaim } from "@crewhaus/control-records";
import { _setApprovalSeamsForTest } from "./approvals/decide";
import { approvalsLedger } from "./approvals/log";
import {
  APPROVALS_DIRNAME,
  type AuthorizeRequest,
  BINDING_DIGEST_LABEL,
  type ConsumeRequest,
  DEFAULT_APPROVALS_FILENAME,
  type PendingApproval,
  allowSingleOwner,
  approvalsDigestKey,
  bindingDigestOf,
  createPendingApprovalStore,
  foldReadOnly,
  placesDigestOf,
  recordInScope,
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

const SESSION = "sess_00000000000000aa";
const SCOPE = `session:${SESSION}`;
const PARKING_RUN = mintRunId();
const PLACES = [{ path: "/work/out.txt", at: ["/work/out.txt"] }];
const HEX64 = /^[0-9a-f]{64}$/;

/** A record parked with a binding the way the runtime parks one: no keyed parts yet. */
function boundPark(
  overrides: Partial<PendingApproval> = {},
  binding: Record<string, unknown> = {},
): PendingApproval {
  return pending({
    sessionId: SESSION,
    runId: PARKING_RUN,
    places: PLACES,
    binding: {
      runId: PARKING_RUN,
      resumeScope: SCOPE,
      sessionId: SESSION,
      resourceRevisionBound: false,
      ...binding,
    } as never,
    ...overrides,
  });
}

function spend(overrides: Partial<ConsumeRequest> = {}): ConsumeRequest {
  return {
    runId: mintRunId(),
    resumeScope: SCOPE,
    places: PLACES,
    approvers: { state: "absent" },
    ...overrides,
  };
}

async function parkedAndGranted(
  root: string,
  record: PendingApproval = boundPark(),
  actor: { readonly principal?: string } = {},
): Promise<PendingApproval> {
  const store = createPendingApprovalStore({ rootDir: root });
  await store.persist(record);
  const decided = await store.decide(record.id, { choice: "grant", actor }, ALLOW);
  expect(decided.outcome).toBe("decided");
  return decided.record as PendingApproval;
}

/** The claim files of one kind, as parsed claim bodies. */
function claimsOf(root: string, kind: string): Record<string, unknown>[] {
  const dir = join(root, APPROVALS_DIRNAME, "claims", kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(
    (name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>,
  );
}

/** Every file under `approvals.d/claims/`, as text, for a byte comparison. */
function claimTexts(root: string): string[] {
  const dir = join(root, APPROVALS_DIRNAME, "claims");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort()
    .map((path) => `${path}\n${readFileSync(path, "utf8")}`);
}

const linesOf = (root: string, id: string, event: string) =>
  logLines(root).filter((l) => l["event"] === event && l["decision"] === id);

function projection(members: ApproverProjection["members"]): ApproverProjection {
  return {
    v: 1,
    epoch: 1,
    generatedAt: "2026-11-01T00:00:00.000Z",
    harness: "hrn_0123456789abcdef",
    owner: mintId("prn"),
    governedSince: "2026-11-01T00:00:00.000Z",
    members,
    links: [],
  };
}

describe("a park seals its binding", () => {
  test("the line carries the keyed places and binding digests, and every log line names the binding digest", async () => {
    expect(BINDING_DIGEST_LABEL).toBe("decision.binding");
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    // A digest a caller hands in is replaced, never trusted.
    const p = boundPark({}, { placesDigest: "planted" });
    await store.persist(p);
    const line = rendezvousLines(root).find((l) => l["id"] === p.id) as PendingApproval;
    const key = await approvalsDigestKey(root);
    if (key.state !== "present") throw new Error(key.state);
    expect(line.binding?.placesDigest).toBe(await placesDigestOf(key.hmac, PLACES));
    expect(line.binding?.placesDigest).toMatch(HEX64);
    expect(line.bindingDigest).toBe(await bindingDigestOf(key.hmac, line.binding));
    expect(line.bindingDigest).toMatch(HEX64);

    await store.decide(p.id, { choice: "grant", actor: {} }, ALLOW);
    const lines = logLines(root).filter((l) => l["decision"] === p.id);
    expect(lines.map((l) => l["event"])).toEqual(["park", "decide"]);
    for (const l of lines) expect(l["bindingDigest"]).toBe(line.bindingDigest);
    const allowed: readonly string[] = DECISION_LOG_KEYS;
    expect(lines.flatMap((l) => Object.keys(l)).filter((k) => !allowed.includes(k))).toEqual([]);
    // The log holds the digest, never the binding itself.
    expect(logText(root)).not.toContain(SCOPE);
    expect(logText(root)).not.toContain("resourceRevisionBound");
  });

  test("a record with no binding is written as before", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = pending();
    await store.persist(p);
    const line = rendezvousLines(root)[0];
    expect(line).toEqual(JSON.parse(JSON.stringify(p)));
    expect(logLines(root)[0]?.["bindingDigest"]).toBeUndefined();
  });
});

describe("a lookup finds a record only in its own scope", () => {
  test("a grant parked in session:A is found there, not in session:B or job:x; an unbound record only in its session", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const bound = await parkedAndGranted(root);
    const { toolName, inputHash } = bound;
    expect((await store.get(toolName, inputHash, { resumeScope: SCOPE }))?.id).toBe(bound.id);
    expect(
      await store.get(toolName, inputHash, { resumeScope: "session:sess_00000000000000bb" }),
    ).toBeNull();
    expect(await store.get(toolName, inputHash, { resumeScope: "job:x" })).toBeNull();
    // Without a scope, as before.
    expect((await store.get(toolName, inputHash))?.id).toBe(bound.id);

    const legacyRoot = tempRoot();
    const legacy = pending({ sessionId: SESSION });
    const legacyStore = createPendingApprovalStore({ rootDir: legacyRoot });
    await legacyStore.persist(legacy);
    expect(
      (await legacyStore.get(legacy.toolName, legacy.inputHash, { resumeScope: SCOPE }))?.id,
    ).toBe(legacy.id);
    expect(
      await legacyStore.get(legacy.toolName, legacy.inputHash, { resumeScope: "job:x" }),
    ).toBeNull();
    expect(recordInScope(legacy, SCOPE)).toBe(true);
    expect(recordInScope({ ...legacy, binding: "torn" as never }, SCOPE)).toBe(false);
  });
});

describe("a grant is spent once", () => {
  test("a writer that stole the lock spent it: the held spend is refused and completes the winner's lines once", async () => {
    const root = tempRoot();
    const g = await parkedAndGranted(root);
    const store = createPendingApprovalStore({ rootDir: root });
    const seam = hold();
    _setApprovalSeamsForTest({ afterFold: seam.hook });
    const a = store.consume(g.id, spend());
    await seam.reached;
    _setApprovalSeamsForTest(undefined);
    const winner = mintRunId();
    const planted = publishClaim(approvalsLedger(root), `consume/${g.id}`, {
      consumedAt: "2026-11-11T10:00:00.000Z",
      consumedByRun: winner,
    });
    expect(planted.ok).toBe(true);
    seam.release();
    const answer = await a;
    expect(answer.outcome).toBe("refused");
    if (answer.outcome !== "refused") return;
    expect(answer.reason).toBe("consumed");
    expect(answer.record.consumedByRun).toBe(winner);
    const consumes = linesOf(root, g.id, "consume");
    expect(consumes).toHaveLength(1);
    expect(consumes[0]?.["outcome"]).toBe("repaired");
    expect(rendezvousLines(root).filter((l) => l["consumedAt"] !== undefined)).toHaveLength(1);
    expect(claimsOf(root, "consume")).toHaveLength(1);
    expect(linesOf(root, g.id, "refuse").map((l) => l["reason"])).toEqual(["consumed"]);
  });

  test("two stores on one root spending concurrently: exactly one is consumed", async () => {
    const root = tempRoot();
    const g = await parkedAndGranted(root);
    const one = createPendingApprovalStore({ rootDir: root });
    const two = createPendingApprovalStore({ rootDir: root });
    const answers = await Promise.all([one.consume(g.id, spend()), two.consume(g.id, spend())]);
    expect(answers.map((a) => a.outcome).sort()).toEqual(["consumed", "refused"]);
    const lost = answers.find((a) => a.outcome === "refused");
    expect(lost?.outcome === "refused" && lost.reason).toBe("consumed");
    expect(claimsOf(root, "consume")).toHaveLength(1);
    expect(linesOf(root, g.id, "consume")).toHaveLength(1);
    const folded = foldReadOnly(root).records.find((r) => r.id === g.id);
    const won = answers.find((a) => a.outcome === "consumed");
    expect(folded?.consumedByRun).toBe(won?.record?.consumedByRun as string);
    expect(await one.get(g.toolName, g.inputHash, { resumeScope: SCOPE })).toBeNull();
  });

  test("a spend from another scope is refused, logged, and leaves the grant in its own scope", async () => {
    const root = tempRoot();
    const g = await parkedAndGranted(root);
    const store = createPendingApprovalStore({ rootDir: root });
    const answer = await store.consume(g.id, spend({ resumeScope: "job:x" }));
    expect(answer).toMatchObject({ outcome: "refused", reason: "scope-mismatch" });
    if (answer.outcome !== "refused") return;
    expect(answer.fresh).toBeUndefined();
    expect(linesOf(root, g.id, "refuse").map((l) => l["reason"])).toEqual(["scope-mismatch"]);
    expect(claimsOf(root, "consume")).toEqual([]);
    expect(claimsOf(root, "supersede")).toEqual([]);
    const still = await store.get(g.toolName, g.inputHash, { resumeScope: SCOPE });
    expect(still?.id).toBe(g.id);
    expect(still?.consumedAt).toBeUndefined();
    expect((await store.consume(g.id, spend())).outcome).toBe("consumed");
  });

  test("a spend whose places moved is refused and kept; one past the TTL is refused expired", async () => {
    const root = tempRoot();
    const g = await parkedAndGranted(root);
    const store = createPendingApprovalStore({ rootDir: root });
    const moved = await store.consume(
      g.id,
      spend({ places: [{ path: "/work/out.txt", at: ["/elsewhere/out.txt"] }] }),
    );
    expect(moved).toMatchObject({ outcome: "refused", reason: "places-changed" });
    expect((await store.consume(g.id, spend())).outcome).toBe("consumed");

    const oldRoot = tempRoot();
    const old = await parkedAndGranted(oldRoot);
    // The same root read a month later.
    const late = createPendingApprovalStore({
      rootDir: oldRoot,
      now: () => new Date(Date.now() + 31 * 86_400_000),
    });
    expect(await late.consume(old.id, spend())).toMatchObject({
      outcome: "refused",
      reason: "expired",
    });
    expect(await late.consume("appr_0000000000000000", spend())).toEqual({
      outcome: "not-found",
      record: null,
    });
  });
});

describe("a refusal that retires a grant asks again", () => {
  test("a spec that moved: superseded revision-changed, and the request asked in its place is bound to the new spec", async () => {
    const root = tempRoot();
    const g = await parkedAndGranted(
      root,
      boundPark({ requiredClass: "maintainer" }, { specHash: "spec-1", deploymentId: "dep-x" }),
    );
    const store = createPendingApprovalStore({ rootDir: root });
    const next = mintRunId();
    const answer = await store.consume(g.id, spend({ runId: next, specHash: "spec-2" }));
    expect(answer).toMatchObject({ outcome: "refused", reason: "revision-changed" });
    if (answer.outcome !== "refused") return;
    expect(answer.record.supersededReason).toBe("revision-changed");
    const supersedes = claimsOf(root, "supersede");
    expect(supersedes).toHaveLength(1);
    expect((supersedes[0]?.["record"] as Record<string, unknown>)["reason"]).toBe(
      "revision-changed",
    );
    const fresh = answer.fresh;
    if (fresh === undefined) throw new Error("no fresh request");
    expect(fresh.supersedes?.id).toBe(g.id);
    expect(fresh.decision).toBeUndefined();
    expect(fresh.requiredClass).toBe("maintainer");
    expect(fresh.runId).toBe(next);
    expect(fresh.binding).toMatchObject({
      runId: next,
      resumeScope: SCOPE,
      sessionId: SESSION,
      specHash: "spec-2",
      resourceRevisionBound: false,
    });
    // What the spend did not report is not carried over from the old binding.
    expect(fresh.binding?.deploymentId).toBeUndefined();
    expect(fresh.binding?.placesDigest).toMatch(HEX64);
    expect(fresh.bindingDigest).toMatch(HEX64);
    expect(rendezvousLines(root).some((l) => l["id"] === fresh.id)).toBe(true);
    expect(linesOf(root, fresh.id, "park")).toHaveLength(1);
    // The old grant is never spendable again.
    expect(await store.consume(g.id, spend({ specHash: "spec-2" }))).toMatchObject({
      outcome: "refused",
      reason: "superseded",
    });
    // Granting the request asked in its place spends under the new spec.
    expect((await store.decide(fresh.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "decided",
    );
    expect((await store.consume(fresh.id, spend({ specHash: "spec-2" }))).outcome).toBe("consumed");
  });

  test("with reask false, a moved spec is refused and logged, and nothing is superseded", async () => {
    const root = tempRoot();
    const g = await parkedAndGranted(root, boundPark({}, { specHash: "spec-1" }));
    const store = createPendingApprovalStore({ rootDir: root });
    const answer = await store.consume(g.id, spend({ specHash: "spec-2", reask: false }));
    expect(answer).toMatchObject({ outcome: "refused", reason: "revision-changed" });
    expect(answer.outcome === "refused" && answer.fresh).toBeUndefined();
    expect(claimsOf(root, "supersede")).toEqual([]);
    expect(rendezvousLines(root).map((l) => l["id"])).toEqual([g.id, g.id]);
    expect(linesOf(root, g.id, "refuse").map((l) => l["reason"])).toEqual(["revision-changed"]);
  });

  test("an operator's supersede of a maintainer-class bound request keeps its class and its binding", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = boundPark({ requiredClass: "maintainer" }, { specHash: "spec-1" });
    await store.persist(p);
    const parked = rendezvousLines(root)[0] as PendingApproval;
    const answer = await store.supersede(p.id, { actor: {}, reason: "other" }, ALLOW);
    expect(answer.outcome).toBe("superseded");
    const fresh = answer.fresh;
    if (fresh === undefined) throw new Error("no fresh request");
    expect(fresh.requiredClass).toBe("maintainer");
    expect(fresh.binding).toEqual(parked.binding as never);
    expect(fresh.bindingDigest).toBe(parked.bindingDigest as string);
  });

  test("a decider no longer on the projection: refused, superseded decider-revoked, asked again", async () => {
    const root = tempRoot();
    const decider = mintId("prn");
    const g = await parkedAndGranted(root, boundPark(), { principal: decider });
    expect(g.decidedByPrincipal).toBe(decider);
    const store = createPendingApprovalStore({ rootDir: root });
    const answer = await store.consume(
      g.id,
      spend({ approvers: { state: "present", projection: projection([]) } }),
    );
    expect(answer).toMatchObject({ outcome: "refused", reason: "decider-not-authorized" });
    if (answer.outcome !== "refused") return;
    expect(answer.record.supersededReason).toBe("decider-revoked");
    expect(answer.fresh?.supersedes?.id).toBe(g.id);
  });

  test("an unreadable projection is refused and kept; an absent one is single-owner mode", async () => {
    const root = tempRoot();
    const decider = mintId("prn");
    const g = await parkedAndGranted(root, boundPark(), { principal: decider });
    const store = createPendingApprovalStore({ rootDir: root });
    const unreadable = await store.consume(g.id, spend({ approvers: { state: "unreadable" } }));
    expect(unreadable).toMatchObject({ outcome: "refused", reason: "approvers-unreadable" });
    expect(unreadable.outcome === "refused" && unreadable.fresh).toBeUndefined();
    expect(claimsOf(root, "supersede")).toEqual([]);
    // A member who may decide passes.
    const member = projection([{ principal: decider, decide: "operator" }]);
    const present = await store.consume(
      g.id,
      spend({ approvers: { state: "present", projection: member } }),
    );
    expect(present.outcome).toBe("consumed");

    const other = tempRoot();
    const h = await parkedAndGranted(other, boundPark(), { principal: decider });
    const absent = await createPendingApprovalStore({ rootDir: other }).consume(h.id, spend());
    expect(absent.outcome).toBe("consumed");
  });
});

describe("a crash and an older writer", () => {
  test("a crash after the consume claim: reads see it spent at once, and the next locked touch writes its lines", async () => {
    const root = tempRoot();
    const g = await parkedAndGranted(root);
    const store = createPendingApprovalStore({ rootDir: root });
    _setApprovalSeamsForTest({
      afterClaim: () => {
        throw new Error("crash");
      },
    });
    await expect(store.consume(g.id, spend())).rejects.toThrow("crash");
    _setApprovalSeamsForTest(undefined);
    expect(linesOf(root, g.id, "consume")).toEqual([]);
    expect(rendezvousLines(root).filter((l) => l["consumedAt"] !== undefined)).toEqual([]);
    expect(foldReadOnly(root).records[0]?.consumedAt).toBeDefined();
    expect(await store.get(g.toolName, g.inputHash, { resumeScope: SCOPE })).toBeNull();

    // Any locked touch completes it: here, a park of another request.
    await store.persist(pending());
    const consumes = linesOf(root, g.id, "consume");
    expect(consumes).toHaveLength(1);
    expect(consumes[0]?.["outcome"]).toBe("repaired");
    expect(rendezvousLines(root).filter((l) => l["consumedAt"] !== undefined)).toHaveLength(1);
    expect(await store.consume(g.id, spend())).toMatchObject({
      outcome: "refused",
      reason: "consumed",
    });
  });

  test("an 0.8.x spend line with no claim counts: the grant is refused as consumed", async () => {
    const root = tempRoot();
    const g = await parkedAndGranted(root);
    const file = join(root, DEFAULT_APPROVALS_FILENAME);
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}${JSON.stringify({ ...g, consumedAt: new Date().toISOString() })}\n`,
    );
    const store = createPendingApprovalStore({ rootDir: root });
    expect(await store.consume(g.id, spend())).toMatchObject({
      outcome: "refused",
      reason: "consumed",
    });
    expect(claimsOf(root, "consume")).toEqual([]);
  });
});

describe("a decision needs the record's class", () => {
  test("the authorizer is asked for the record's class, and operator for an unclassed one", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const seen: string[] = [];
    const authorize = (request: AuthorizeRequest) => {
      seen.push(`${request.op}:${request.requiredClass}`);
      return allowSingleOwner(request);
    };
    const maintainer = pending({ requiredClass: "maintainer" });
    const plain = pending();
    const torn = pending({ requiredClass: "chief" as never });
    for (const p of [maintainer, plain, torn]) await store.persist(p);
    for (const p of [maintainer, plain, torn]) {
      await store.decide(p.id, { choice: "grant", actor: {} }, { authorize });
    }
    expect(seen).toEqual(["decide:maintainer", "decide:operator", "decide:owner"]);
  });
});

describe("a cancelled run's requests are withdrawn", () => {
  test("pending and unspent grants of the run are superseded run-cancelled, naming the run; the rest are untouched", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const resumed = mintRunId();
    const waiting = boundPark();
    const granted = boundPark({ inputHash: "b".repeat(64) });
    const spent = boundPark({ inputHash: "c".repeat(64) });
    const otherRun = boundPark({ inputHash: "d".repeat(64) }, { runId: mintRunId() });
    const unbound = pending({ runId: PARKING_RUN, inputHash: "e".repeat(64) });
    for (const p of [waiting, granted, spent, otherRun, unbound]) await store.persist(p);
    await store.decide(granted.id, { choice: "grant", actor: {} }, ALLOW);
    await store.decide(spent.id, { choice: "grant", actor: {} }, ALLOW);
    expect((await store.consume(spent.id, spend())).outcome).toBe("consumed");

    const before = rendezvousLines(root).length;
    const answer = await store.supersedeRun([resumed, PARKING_RUN, "run_0123abcd"], {
      reason: "run-cancelled",
    });
    expect(answer.superseded.sort()).toEqual([waiting.id, granted.id, unbound.id].sort());
    // No request is asked in their place: one line each, and no line names a run as its id.
    expect(rendezvousLines(root)).toHaveLength(before + 3);
    expect(rendezvousLines(root).some((l) => String(l["id"]).startsWith("run_"))).toBe(false);
    const folded = new Map(foldReadOnly(root).records.map((r) => [r.id, r]));
    for (const id of answer.superseded) {
      expect(folded.get(id)?.supersededBy).toBe(resumed);
      expect(folded.get(id)?.supersededReason).toBe("run-cancelled");
      expect(linesOf(root, id, "supersede")[0]?.["reason"]).toBe("run-cancelled");
    }
    expect(folded.get(spent.id)?.supersededBy).toBeUndefined();
    expect(folded.get(otherRun.id)?.supersededBy).toBeUndefined();

    // Later decisions and spends find it settled.
    expect((await store.decide(waiting.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "already-decided",
    );
    expect(await store.consume(granted.id, spend())).toMatchObject({
      outcome: "refused",
      reason: "superseded",
    });
    // A second cancel withdraws nothing more.
    expect((await store.supersedeRun([resumed], { reason: "run-cancelled" })).superseded).toEqual(
      [],
    );
  });

  test("a run id is a supersede claim's only for run-cancelled, and a crash before its line repairs with no fresh request", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const p = boundPark();
    const q = boundPark({ inputHash: "f".repeat(64) });
    await store.persist(p);
    await store.persist(q);
    const ledger = approvalsLedger(root);
    const run = mintRunId();
    // A run id with another reason is not a claim: the record stays as the file says.
    expect(
      publishClaim(ledger, `supersede/${q.id}`, {
        supersededBy: run,
        reason: "other",
        parkedAt: new Date().toISOString(),
      }).ok,
    ).toBe(true);
    const read = foldReadOnly(root);
    expect(read.faults.map((f) => f.id)).toEqual([q.id]);
    expect(read.records.find((r) => r.id === q.id)?.supersededBy).toBeUndefined();

    // A withdrawal whose lines a crash left out: repaired, and nothing parked for the run id.
    expect(
      publishClaim(ledger, `supersede/${p.id}`, {
        supersededBy: run,
        reason: "run-cancelled",
        parkedAt: new Date().toISOString(),
      }).ok,
    ).toBe(true);
    const before = rendezvousLines(root).length;
    await store.persist(pending({ inputHash: "9".repeat(64) }));
    const lines = rendezvousLines(root);
    expect(lines).toHaveLength(before + 2);
    expect(lines.some((l) => l["id"] === run)).toBe(false);
    expect(lines.filter((l) => l["id"] === p.id).at(-1)?.["supersededBy"]).toBe(run);
    expect(linesOf(root, p.id, "supersede")[0]?.["outcome"]).toBe("repaired");
    expect(linesOf(root, run, "park")).toEqual([]);
  });

  test("a call naming no canonical run, or a root with no approvals, withdraws nothing and creates nothing", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    expect(
      (await store.supersedeRun([mintRunId()], { reason: "run-cancelled" })).superseded,
    ).toEqual([]);
    expect(existsSync(join(root, APPROVALS_DIRNAME))).toBe(false);
    await store.persist(boundPark());
    expect(
      (await store.supersedeRun(["run_0123abcd"], { reason: "run-cancelled" })).superseded,
    ).toEqual([]);
    await expect(store.supersedeRun([PARKING_RUN], { reason: "other" as never })).rejects.toThrow(
      "cancelled",
    );
  });
});

describe("reads never write", () => {
  test("get, list and foldReadOnly leave the file and every claim byte-identical", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const g = await parkedAndGranted(root);
    expect((await store.consume(g.id, spend())).outcome).toBe("consumed");
    const r = await parkedAndGranted(
      root,
      boundPark({ inputHash: "1".repeat(64) }, { specHash: "a" }),
    );
    expect((await store.consume(r.id, spend({ specHash: "b" }))).outcome).toBe("refused");
    await store.persist(boundPark({ inputHash: "2".repeat(64) }));
    await store.supersedeRun([PARKING_RUN], { reason: "run-cancelled" });
    // A claim whose line is missing, which only a locked touch would repair.
    const late = await parkedAndGranted(root, boundPark({ inputHash: "3".repeat(64) }));
    publishClaim(approvalsLedger(root), `consume/${late.id}`, {
      consumedAt: new Date().toISOString(),
      consumedByRun: mintRunId(),
    });

    const file = join(root, DEFAULT_APPROVALS_FILENAME);
    const before = readFileSync(file);
    const claimsBefore = claimTexts(root);
    const logBefore = logText(root);
    await store.get(g.toolName, g.inputHash, { resumeScope: SCOPE });
    await store.get(g.toolName, g.inputHash);
    await store.list();
    foldReadOnly(root);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(claimTexts(root)).toEqual(claimsBefore);
    expect(logText(root)).toBe(logBefore);
    expect(foldReadOnly(root).records.find((x) => x.id === late.id)?.consumedAt).toBeDefined();
  });
});
