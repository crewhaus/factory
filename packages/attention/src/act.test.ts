/**
 * Acting on items: each source settles through its own writer and is recorded once on the
 * actions ledger; what a person read must still hold; an assignment needs a member who
 * reaches the item's class; a deferral moves a request's deadline and hides a problem; a
 * snooze is its member's own; a problem set aside opens again on newer evidence.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AttentionItem, effectiveDecisionState, mintId } from "@crewhaus/control-contract";
import {
  append,
  attentionActionsLedger,
  controlPaths,
  decisionsLedger,
  readDeployQuorums,
  readPage,
} from "@crewhaus/control-records";
import { writeBudgetState } from "@crewhaus/control-records/budget";
import { type DecisionActor, createDecisions } from "@crewhaus/control-service";
import { openQuorumDecision } from "@crewhaus/deployment-controller/quorum";
import { claimReviewEntry, readReviewQueue, resolveReviewEntry } from "@crewhaus/feedback-distill";
import { createPendingApprovalStore, foldReadOnly } from "@crewhaus/session-store";
import {
  DAY,
  HOUR,
  MIN,
  type Members,
  NOW,
  harnessDir,
  iso,
  park,
  proposal,
  review,
  run,
  tempRoot,
  testFacts,
  treeState,
  withMembers,
} from "./__test__/fleet";
import {
  type ActAnswer,
  type ActDeps,
  acknowledgeItem,
  addMessage,
  assignItem,
  deferItem,
  dismissItem,
  listMessages,
  reopenItem,
  resolveItem,
  snoozeItem,
  unassignItem,
  undeferItem,
} from "./act";
import { assembleInbox, foldHarness } from "./fold";
import { idOfItem } from "./overlays";
import type { AdvisorSnapshot } from "./types";

const HRN = "hrn_0123456789abcdef";
/** A member a hand-written line names: nobody here. */
const SOMEONE = mintId("prn");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

type Fixture = {
  readonly dir: string;
  readonly hangarRoot: string;
  readonly deps: ActDeps;
  readonly clock: { now: number };
  /** The items the inbox holds, as `viewer` sees them. */
  items(opts?: { state?: "open" | "all"; viewer?: string; content?: boolean }): AttentionItem[];
};

function fixture(
  name: string,
  opts: { snapshots?: AdvisorSnapshot; deps?: Partial<ActDeps> } = {},
): Fixture {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  const dir = harnessDir(t.root, name);
  const hangarRoot = join(t.root, "hangar");
  mkdirSync(hangarRoot, { recursive: true });
  const clock = { now: NOW };
  const now = () => clock.now;
  const decisions = createDecisions({
    hangarRoot,
    identity: { username: "sam", hostname: "laptop" },
    now,
  });
  const deps: ActDeps = {
    decisions,
    now,
    members: { hangarRoot, harness: { id: HRN, dir, groups: [] } },
    reviewWriter: async (request) => {
      const actor = { by: request.by, via: request.via };
      const answer = resolveReviewEntry(
        request.dir,
        request.id,
        request.note ?? request.verdict,
        request.nowIso,
        actor,
      );
      return answer.outcome === "unavailable"
        ? { outcome: "rejected", reason: answer.reason }
        : { outcome: answer.outcome };
    },
    ...opts.deps,
  };
  const snapshots = new Map(opts.snapshots !== undefined ? [[dir, opts.snapshots]] : []);
  return {
    dir,
    hangarRoot,
    deps,
    clock,
    items: (o = {}) =>
      assembleInbox(
        [
          foldHarness(dir, testFacts({}, snapshots), clock.now, {
            harness: HRN,
            content: o.content ?? false,
            ...(o.viewer !== undefined ? { viewer: o.viewer } : {}),
          }),
        ],
        clock.now,
        { state: o.state ?? "open" },
      ).items as AttentionItem[],
  };
}

/** The harness's members, through the access records' own writer. */
const governed = (f: Fixture): Promise<Members> =>
  withMembers(f.hangarRoot, { id: HRN, dir: f.dir });

const SAM: DecisionActor = {
  kind: "local",
  identity: { username: "sam", hostname: "laptop" },
  display: "sam",
};
const member = (principal: string): DecisionActor => ({ kind: "principal", principal });

/** Every actions line of a harness, oldest first. */
function lines(dir: string): Record<string, unknown>[] {
  const page = readPage(attentionActionsLedger(dir), { limit: 500 });
  return page.items.map((i) => ({ ...i.record })).reverse();
}

const one = (items: readonly AttentionItem[], kind?: string): AttentionItem => {
  const hit = kind === undefined ? items[0] : items.find((i) => i.kind === kind);
  if (hit === undefined) throw new Error(`no ${kind ?? "item"}`);
  return hit;
};

const reasonOf = (answer: ActAnswer): string =>
  answer.ok ? "ok" : `${answer.code}/${answer.reason}`;

/** A failed run whose group is a problem item. */
function problem(f: Fixture, at = NOW - HOUR): void {
  run(f.dir, { at, state: "failed", failureClass: "tool_error" });
}

const FINDING: AdvisorSnapshot = {
  at: iso(NOW - MIN),
  items: [
    {
      id: "evals-none",
      severity: "suggestion",
      screen: "evals",
      source: "evals",
      action: { kind: "job", label: "Run", cliTwin: "crewhaus eval", jobKind: "eval" },
      status: "open",
    } as never,
  ],
};

describe("resolve settles each source through its own writer, and is recorded once", () => {
  test("a tool request: the decision log holds the verdict, and one line says where it was made", async () => {
    const f = fixture("grant");
    const id = await park(f.dir);
    const item = one(f.items(), "permission");
    const answer = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "grant" },
      f.deps,
      "cmd_00000000000000000000000000",
    );
    expect(answer).toMatchObject({ ok: true, event: "resolved", state: "resolved" });
    const record = foldReadOnly(join(f.dir, ".crewhaus", "sessions")).records.find(
      (r) => r.id === id,
    );
    expect(record?.decision).toBe("grant");
    expect(record?.decidedVia).toBe("cli");
    const [line, ...more] = lines(f.dir);
    expect(more).toEqual([]);
    expect(line).toMatchObject({
      v: 1,
      id: idOfItem(item),
      state: "resolved",
      event: "resolved",
      how: "decided",
      choice: "grant",
      via: "cli",
      evidenceRev: item.evidenceRev,
      cmd: "cmd_00000000000000000000000000",
    });
    expect(f.items()).toEqual([]);
    // The same verdict again changes nothing and records nothing.
    const again = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "deny" },
      f.deps,
    );
    expect(reasonOf(again)).toBe("already_decided/already_decided");
    expect(lines(f.dir)).toHaveLength(1);
  });

  test("an ask two sessions made: one verdict decides both requests, each on its own, by one person", async () => {
    const f = fixture("reask");
    const a = await park(f.dir, { askDigest: "d1", sessionId: `sess_${"1".repeat(16)}` });
    const b = await park(f.dir, { askDigest: "d1", sessionId: `sess_${"2".repeat(16)}` });
    const item = one(f.items(), "permission");
    expect(item.evidence).toHaveLength(2);
    const answer = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "home", choice: "deny" },
      f.deps,
    );
    expect(answer.ok).toBe(true);
    const records = foldReadOnly(join(f.dir, ".crewhaus", "sessions")).records;
    const decided = [a, b].map((id) => records.find((r) => r.id === id));
    expect(decided.map((r) => r?.decision)).toEqual(["deny", "deny"]);
    expect(decided.map((r) => r?.decidedVia)).toEqual(["home", "home"]);
    expect(new Set(decided.map((r) => r?.decidedByPrincipal)).size).toBe(1);
    expect(lines(f.dir)).toHaveLength(1);
    // A narrower answer for several runs at once is not offered.
    const other = fixture("reask-always");
    await park(other.dir, { askDigest: "d1", sessionId: `sess_${"1".repeat(16)}` });
    await park(other.dir, { askDigest: "d1", sessionId: `sess_${"2".repeat(16)}` });
    const refused = await resolveItem(
      {
        dir: other.dir,
        item: one(other.items(), "permission"),
        actor: SAM,
        via: "cli",
        choice: "grant-always",
      },
      other.deps,
    );
    expect(reasonOf(refused)).toBe("conflict/choice");
  });

  test("a request from now on is the owner's; a member allows it once and asks the owner", async () => {
    const f = fixture("propose");
    await park(f.dir, { tool: "Bash", input: { command: "git status" } });
    const m = await governed(f);
    const item = one(f.items(), "permission");
    const ask = (choice: string, principal: string) =>
      resolveItem({ dir: f.dir, item, actor: member(principal), via: "home", choice }, f.deps);
    expect(reasonOf(await ask("grant-always", m.operator))).toBe("forbidden/class");
    expect(reasonOf(await ask("grant-propose", m.owner))).toBe("conflict/owner");
    const proposed = await ask("grant-propose", m.operator);
    expect(proposed.ok).toBe(true);
    // The call is allowed once, and the owner has a request.
    const request = one(f.items(), "standing-rule-proposal");
    expect(request.requiredClass).toBe("owner");
  });

  test("a `dec_` request, refused by the owner; a member who is not the owner decides nothing", async () => {
    const f = fixture("dec");
    const id = proposal(f.dir);
    const m = await governed(f);
    const item = one(f.items(), "standing-rule-proposal");
    const by = (principal: string) =>
      resolveItem(
        { dir: f.dir, item, actor: member(principal), via: "home", choice: "deny" },
        f.deps,
      );
    expect(reasonOf(await by(m.maintainer))).toBe("forbidden/class");
    expect(lines(f.dir)).toEqual([]);
    expect((await by(m.owner)).ok).toBe(true);
    const row = readPage(decisionsLedger(f.dir), { limit: 10 }).items.find(
      (i) => i.record["id"] === id,
    );
    expect(row?.record["state"]).toBe("denied");
    expect(lines(f.dir)).toHaveLength(1);
  });

  test("a delegation request is refused here and turned on only from its page", async () => {
    const f = fixture("delegate");
    proposal(f.dir, { delegate: "merge" });
    const item = one(f.items(), "standing-rule-proposal");
    const granted = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "grant" },
      f.deps,
    );
    expect(reasonOf(granted)).toBe("conflict/choice");
    const reviewed = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "review" },
      f.deps,
    );
    expect(reasonOf(reviewed)).toBe("conflict/choice");
    const denied = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "deny" },
      f.deps,
    );
    expect(denied.ok).toBe(true);
  });

  test("a question is answered, never allowed or refused", async () => {
    const f = fixture("question");
    await park(f.dir, { kind: "input" });
    const item = one(f.items(), "question");
    const before = treeState(f.dir);
    const answer = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "grant" },
      f.deps,
    );
    expect(answer).toMatchObject({
      ok: false,
      code: "conflict",
      message: "A question is answered, not allowed or refused.",
    });
    expect(treeState(f.dir)).toEqual(before);
  });

  test("a review entry: claimed, resolved with who and where, and lost to whoever was first", async () => {
    const f = fixture("review");
    review(f.dir);
    const item = one(f.items(), "review");
    expect(item.choices.map((c) => c.id)).toEqual(["pass", "fail"]);
    const answer = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "fail", note: "wrong amount" },
      f.deps,
    );
    expect(answer.ok).toBe(true);
    expect(readReviewQueue(f.dir)[0]).toMatchObject({
      status: "resolved",
      resolution: "wrong amount",
      via: "cli",
    });
    const other = fixture("review-lost");
    const id = review(other.dir);
    const open = one(other.items(), "review");
    claimReviewEntry(other.dir, id, { at: iso(NOW) });
    const lost = await resolveItem(
      { dir: other.dir, item: open, actor: SAM, via: "cli", choice: "pass" },
      other.deps,
    );
    expect(reasonOf(lost)).toBe("already_decided/already_decided");
    expect(lines(other.dir)).toEqual([]);
    const note = JSON.stringify(lines(f.dir));
    expect(note).not.toContain("wrong amount");
  });

  test("a protected environment's quorum: a vote is recorded, and the second person's grants it", async () => {
    const f = fixture("quorum");
    writeFileSync(
      join(f.dir, ".crewhaus", "environments.json"),
      JSON.stringify({ environments: { prod: { requireApproval: true, minApprovals: 2 } } }),
    );
    const m = await governed(f);
    const opened = await openQuorumDecision(
      f.dir,
      {
        spec: "support-bot",
        environment: "prod",
        version: "v2",
        specHash: `sha256:${"ab".repeat(32)}`,
      },
      { now: NOW },
    );
    if (!opened.ok) throw new Error(opened.reason);
    const vote = async (principal: string, choice = "approve") =>
      resolveItem(
        {
          dir: f.dir,
          item: one(f.items(), "deploy-approval"),
          actor: member(principal),
          via: "home",
          choice,
        },
        f.deps,
      );
    expect(reasonOf(await vote(m.operator))).toBe("forbidden/class");
    expect(await vote(m.maintainer)).toMatchObject({ ok: true, state: "open" });
    expect(reasonOf(await vote(m.maintainer))).toBe("already_decided/already_voted");
    expect(await vote(m.owner)).toMatchObject({ ok: true, state: "resolved" });
    const quorums = readDeployQuorums(f.dir);
    expect(quorums.state === "present" && quorums.rows[0]?.state).toBe("granted");
    const events = lines(f.dir).map((l) => [l["event"], l["state"], l["choice"]]);
    expect(events).toEqual([
      ["resolved", "open", "approve"],
      ["resolved", "resolved", "approve"],
    ]);
    // Approved, it waits for its move, which is the deploy's own permission.
    const ready = one(f.items(), "deploy-approval");
    expect(ready.choices.map((c) => [c.id, c.permission])).toEqual([["promote", "h.deploy"]]);
    const nothing = await resolveItem(
      { dir: f.dir, item: ready, actor: member(m.owner), via: "home", choice: "promote" },
      f.deps,
    );
    expect(nothing).toMatchObject({
      ok: false,
      code: "unavailable",
      verb: "crewhaus spec pin support-bot prod v2",
    });
    const asked: unknown[] = [];
    const moved = await resolveItem(
      { dir: f.dir, item: ready, actor: member(m.owner), via: "home", choice: "promote" },
      {
        ...f.deps,
        promote: async (request) => {
          asked.push(request.subject);
          return { ok: true, job: "job_1" };
        },
      },
    );
    expect(moved).toMatchObject({ ok: true, state: "open", job: "job_1" });
    expect(asked).toEqual([
      {
        spec: "support-bot",
        environment: "prod",
        version: "v2",
        specHash: `sha256:${"ab".repeat(32)}`,
      },
    ]);
  });

  test("an Advisor finding: its own closed job, recorded in the Advisor's ledger and here", async () => {
    const queued: string[] = [];
    const f = fixture("advisor", {
      snapshots: FINDING,
      deps: {
        advisorAct: async ({ itemId }) => {
          queued.push(itemId);
          return { ok: true, job: "job_9" };
        },
      },
    });
    const item = one(f.items(), "setup");
    const answer = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "home", choice: "act" },
      f.deps,
      "cmd_00000000000000000000000000",
    );
    expect(answer).toMatchObject({ ok: true, job: "job_9", state: "open" });
    expect(queued).toEqual(["evals-none"]);
    const ledger = readFileSync(join(f.dir, ".crewhaus", "advisor", "decisions.jsonl"), "utf8");
    expect(JSON.parse(ledger)).toMatchObject({
      v: 2,
      itemId: "evals-none",
      action: "acted",
      via: "home",
      evidenceRev: item.evidenceRev,
      jobId: "job_9",
      cmd: "cmd_00000000000000000000000000",
    });
    expect(lines(f.dir)).toHaveLength(1);
  });

  test("a head that starts nothing says so, and names the command that does", async () => {
    const f = fixture("offline", { snapshots: FINDING });
    const item = one(f.items(), "setup");
    const answer = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "act" },
      f.deps,
    );
    expect(answer).toMatchObject({ ok: false, code: "unavailable", verb: "crewhaus eval" });
    expect(lines(f.dir)).toEqual([]);
  });

  test("a budget waits for its renewal, at the record's own time; with none it says so", async () => {
    const f = fixture("budget");
    run(f.dir, { at: NOW - HOUR, state: "failed", failureClass: "crewhaus_budget" });
    const item = one(f.items(), "budget");
    expect(item.choices.map((c) => [c.id, c.permission ?? null])).toEqual([
      ["raise-spec", "h.spec.edit"],
      ["raise-period", "h.budget.extend"],
      ["wait-for-renewal", null],
      ["acknowledge", null],
    ]);
    expect(item.choices.find((c) => c.id === "raise-period")).toMatchObject({
      cliTwin: null,
      nullReason: "The amount and reason are yours to choose: `crewhaus budget extend`.",
    });
    const wait = () =>
      resolveItem({ dir: f.dir, item, actor: SAM, via: "cli", choice: "wait-for-renewal" }, f.deps);
    expect(reasonOf(await wait())).toBe("conflict/no_renewal");
    expect(lines(f.dir)).toEqual([]);
    const renewsAt = iso(NOW + 3 * DAY);
    writeBudgetState(f.dir, { v: 1, periodId: "2026-11", exhaustedAt: iso(NOW - HOUR), renewsAt });
    expect(await wait()).toMatchObject({ ok: true, state: "deferred" });
    expect(lines(f.dir)[0]).toMatchObject({
      event: "resolved",
      choice: "wait-for-renewal",
      state: "deferred",
      until: renewsAt,
    });
    expect(f.items()).toEqual([]);
    f.clock.now = NOW + 3 * DAY + 1;
    expect(f.items().map((i) => i.kind)).toEqual(["budget"]);
    // A raise is a place to go, never carried out from here.
    const raise = await resolveItem(
      { dir: f.dir, item: one(f.items()), actor: SAM, via: "cli", choice: "raise-spec" },
      f.deps,
    );
    expect(reasonOf(raise)).toBe("conflict/choice");
  });
});

describe("what a person read must still hold", () => {
  test("a stale `expect` writes nothing; the item's state or revision is what it may be", async () => {
    const f = fixture("expect");
    await park(f.dir);
    const item = one(f.items(), "permission");
    const before = treeState(f.dir);
    const stale = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "grant", expect: "0000000000000000" },
      f.deps,
    );
    expect(stale).toMatchObject({
      ok: false,
      code: "precondition_failed",
      current: { state: "open", evidenceRev: item.evidenceRev },
    });
    expect(treeState(f.dir)).toEqual(before);
    for (const expectation of ["open", item.evidenceRev]) {
      const g = fixture(`expect-${expectation.length}`);
      await park(g.dir);
      const fresh = one(g.items(), "permission");
      const answer = await resolveItem(
        {
          dir: g.dir,
          item: fresh,
          actor: SAM,
          via: "cli",
          choice: "deny",
          expect: expectation === "open" ? "open" : fresh.evidenceRev,
        },
        g.deps,
      );
      expect(answer.ok).toBe(true);
    }
  });
});

describe("assignment grants nothing, and goes to someone who may decide", () => {
  test("an operator is not given a maintainer's item, and nothing is written", async () => {
    const f = fixture("assign-class");
    await park(f.dir, { requiredClass: "maintainer" });
    const m = await governed(f);
    const item = one(f.items(), "permission");
    const before = treeState(f.dir);
    const answer = await assignItem(
      { dir: f.dir, item, actor: member(m.maintainer), via: "home", to: m.operator },
      f.deps,
    );
    expect(answer).toMatchObject({
      ok: false,
      code: "conflict",
      reason: "assignee_class",
      current: { requiredClass: "maintainer" },
    });
    expect(answer.ok ? "" : answer.message).toContain("maintainer");
    expect(treeState(f.dir)).toEqual(before);
  });

  test("a member who may decide is; the item says so, and is theirs to find", async () => {
    const f = fixture("assign");
    await park(f.dir);
    const m = await governed(f);
    const item = one(f.items(), "permission");
    const request = { dir: f.dir, item, actor: member(m.owner), via: "home" as const };
    // Someone who only looks, and someone nobody knows, are given nothing.
    for (const to of [m.viewer, SOMEONE]) {
      expect(reasonOf(await assignItem({ ...request, to }, f.deps))).toBe(
        "conflict/assignee_class",
      );
    }
    expect(await assignItem({ ...request, to: m.operator }, f.deps)).toMatchObject({
      ok: true,
      state: "assigned",
    });
    const assigned = one(f.items(), "permission");
    expect(assigned.state).toBe("assigned");
    expect(assigned.assignee).toBe(m.operator);
    const mine = assembleInbox([foldHarness(f.dir, testFacts(), NOW, { harness: HRN })], NOW, {
      assignee: m.operator,
    });
    expect(mine.items).toHaveLength(1);
    const theirs = assembleInbox([foldHarness(f.dir, testFacts(), NOW, { harness: HRN })], NOW, {
      assignee: m.maintainer,
    });
    expect(theirs.items).toEqual([]);
    // Being assigned raised nobody's class: the decision checks it, as ever.
    expect(lines(f.dir)[0]).toMatchObject({
      event: "assigned",
      to: m.operator,
      state: "assigned",
    });
    const back = await unassignItem({ ...request, item: assigned }, f.deps);
    expect(back).toMatchObject({ ok: true, state: "open" });
    expect(one(f.items(), "permission").assignee).toBeUndefined();
    expect(reasonOf(await unassignItem({ ...request, item: one(f.items()) }, f.deps))).toBe(
      "conflict/not_assigned",
    );
  });

  test("a harness with no members has nobody to assign to", async () => {
    const f = fixture("assign-none");
    await park(f.dir);
    const answer = await assignItem(
      { dir: f.dir, item: one(f.items()), actor: SAM, via: "cli", to: SOMEONE },
      f.deps,
    );
    expect(reasonOf(answer)).toBe("conflict/assignee_class");
    expect(lines(f.dir)).toEqual([]);
  });
});

describe("putting off", () => {
  test("a request's own deadline moves with it, and the fallback waits for the new time", async () => {
    const f = fixture("defer-request");
    const at = NOW - HOUR;
    const id = await park(f.dir, { at });
    const root = join(f.dir, ".crewhaus", "sessions");
    const store = createPendingApprovalStore({ rootDir: root, now: () => new Date(at) });
    const record = foldReadOnly(root).records.find((r) => r.id === id);
    await store.persist({
      ...(record as object),
      expiresAt: iso(NOW + HOUR),
      ifUnanswered: "deny",
    } as never);
    const stateAt = (now: number) => {
      const r = foldReadOnly(root).records.find((x) => x.id === id);
      return effectiveDecisionState(r as never, null, now);
    };
    expect(stateAt(NOW + 2 * HOUR).overdue).toBe(true);
    const item = one(f.items(), "permission");
    const answer = await deferItem(
      {
        dir: f.dir,
        item,
        actor: SAM,
        via: "cli",
        until: iso(NOW + 4 * HOUR),
        reason: "awaiting-someone",
      },
      f.deps,
    );
    expect(answer).toMatchObject({ ok: true, event: "deferred", state: "deferred" });
    expect(stateAt(NOW + 2 * HOUR)).toMatchObject({ state: "pending", overdue: false });
    expect(stateAt(NOW + 5 * HOUR).overdue).toBe(true);
    // It still waits: a deferred request stays in the list and says until when.
    const listed = one(f.items(), "permission");
    expect(listed.state).toBe("deferred");
    expect(listed.deferral).toEqual({ until: iso(NOW + 4 * HOUR), deadlineMoved: true });
    expect(listed.choices.map((c) => c.id)).toContain("grant");
    const undone = await undeferItem({ dir: f.dir, item: listed, actor: SAM, via: "cli" }, f.deps);
    expect(reasonOf(undone)).toBe("conflict/deadline_moved");
  });

  test("a request someone decided is not put off", async () => {
    const f = fixture("defer-decided");
    const id = await park(f.dir);
    const item = one(f.items(), "permission");
    const root = join(f.dir, ".crewhaus", "sessions");
    const store = createPendingApprovalStore({ rootDir: root, now: () => new Date(NOW) });
    await store.resolve(id, "deny", "ana", { via: "home" });
    const answer = await deferItem(
      { dir: f.dir, item, actor: SAM, via: "cli", until: iso(NOW + HOUR), reason: "scheduled" },
      f.deps,
    );
    expect(reasonOf(answer)).toBe("already_decided/already_decided");
    expect(lines(f.dir)).toEqual([]);
  });

  test("an ask of two sessions, one of them settled meanwhile, is put off for the one that waits", async () => {
    const f = fixture("defer-some");
    const a = await park(f.dir, { askDigest: "d1", sessionId: `sess_${"1".repeat(16)}` });
    const b = await park(f.dir, { askDigest: "d1", sessionId: `sess_${"2".repeat(16)}` });
    const item = one(f.items(), "permission");
    const root = join(f.dir, ".crewhaus", "sessions");
    const store = createPendingApprovalStore({ rootDir: root, now: () => new Date(NOW) });
    await store.resolve(a, "deny", "ana", { via: "home" });
    const answer = await deferItem(
      { dir: f.dir, item, actor: SAM, via: "cli", until: iso(NOW + HOUR), reason: "scheduled" },
      f.deps,
    );
    expect(answer).toMatchObject({
      ok: true,
      event: "deferred",
      detail: "1 of 2 requests were put off; the others were already settled.",
    });
    const records = foldReadOnly(root).records;
    expect(records.find((r) => r.id === a)?.deferredUntil).toBeUndefined();
    expect(records.find((r) => r.id === b)?.deferredUntil).toBe(iso(NOW + HOUR));
    expect(lines(f.dir)).toHaveLength(1);
  });

  test("a problem is hidden until its time, then it is open again", async () => {
    const f = fixture("defer-problem");
    problem(f);
    const item = one(f.items(), "run-failures");
    const until = iso(NOW + DAY);
    const request = { dir: f.dir, item, actor: SAM, via: "cli" as const };
    expect(await deferItem({ ...request, until, reason: "scheduled" }, f.deps)).toMatchObject({
      ok: true,
      state: "deferred",
    });
    expect(f.items()).toEqual([]);
    const all = one(f.items({ state: "all" }), "run-failures");
    expect(all.state).toBe("deferred");
    expect(all.deferral).toEqual({ until, reasonCode: "scheduled", deadlineMoved: false });
    f.clock.now = NOW + DAY - 1;
    expect(f.items()).toEqual([]);
    f.clock.now = NOW + DAY;
    expect(one(f.items(), "run-failures").state).toBe("open");
    // Taken back before its time.
    const again = fixture("undefer");
    problem(again);
    const open = one(again.items());
    await deferItem(
      { dir: again.dir, item: open, actor: SAM, via: "cli", until, reason: "other" },
      again.deps,
    );
    const put = one(again.items({ state: "all" }));
    expect(
      await undeferItem({ dir: again.dir, item: put, actor: SAM, via: "cli" }, again.deps),
    ).toMatchObject({ ok: true, state: "open" });
    expect(again.items()).toHaveLength(1);
  });

  test("a decision's overlay hides it and leaves its own deadline where it was", async () => {
    const f = fixture("defer-dec");
    const id = proposal(f.dir);
    const item = one(f.items(), "standing-rule-proposal");
    const answer = await deferItem(
      { dir: f.dir, item, actor: SAM, via: "cli", until: iso(NOW + HOUR), reason: "scheduled" },
      f.deps,
    );
    expect(answer).toMatchObject({ ok: true, detail: "Its own deadline is unchanged." });
    const row = readPage(decisionsLedger(f.dir), { limit: 10 }).items.filter(
      (i) => i.record["id"] === id,
    );
    expect(row).toHaveLength(1);
    expect(f.items()).toEqual([]);
    const all = one(f.items({ state: "all" }));
    expect(all.deadline).toEqual(item.deadline as never);
  });

  test("a time that is past, is not one, or is too far is refused with nothing written", async () => {
    const f = fixture("defer-bad");
    problem(f);
    const item = one(f.items());
    const before = treeState(f.dir);
    for (const until of [iso(NOW - 1), "tomorrow", "2026-12-01", iso(NOW + 91 * DAY)]) {
      const answer = await deferItem(
        { dir: f.dir, item, actor: SAM, via: "cli", until, reason: "other" },
        f.deps,
      );
      expect(reasonOf(answer)).toBe("invalid/until");
    }
    const reason = await deferItem(
      {
        dir: f.dir,
        item,
        actor: SAM,
        via: "cli",
        until: iso(NOW + DAY),
        reason: "because" as never,
      },
      f.deps,
    );
    expect(reasonOf(reason)).toBe("invalid/reason");
    expect(treeState(f.dir)).toEqual(before);
  });

  test("a snooze hides it from its own member only, until its time", async () => {
    const f = fixture("snooze");
    problem(f);
    const m = await governed(f);
    const item = one(f.items());
    const answer = await snoozeItem(
      { dir: f.dir, item, actor: member(m.operator), via: "home", until: iso(NOW + DAY) },
      f.deps,
    );
    expect(answer).toMatchObject({ ok: true, event: "snoozed" });
    expect(f.items({ viewer: m.operator })).toEqual([]);
    expect(f.items({ viewer: m.maintainer })).toHaveLength(1);
    expect(f.items()).toHaveLength(1);
    const mine = one(f.items({ viewer: m.operator, state: "all" }));
    expect(mine.snoozedUntil).toBe(iso(NOW + DAY));
    expect(mine.state).toBe("open");
    f.clock.now = NOW + DAY + 1;
    expect(f.items({ viewer: m.operator })).toHaveLength(1);
  });
});

describe("setting aside", () => {
  test("a dismissal holds for the evidence it was made on; newer evidence opens it, linked to it", async () => {
    const f = fixture("dismiss");
    problem(f);
    const item = one(f.items());
    const answer = await dismissItem(
      { dir: f.dir, item, actor: SAM, via: "cli", reasonCode: "known" },
      f.deps,
    );
    expect(answer).toMatchObject({ ok: true, event: "dismissed", state: "resolved" });
    expect(f.items()).toEqual([]);
    const closed = one(f.items({ state: "all" }));
    expect(closed.resolution).toEqual({ how: "dismissed", at: iso(NOW), via: "cli" });
    expect(closed.choices).toEqual([]);
    problem(f, NOW - MIN);
    const reopened = one(f.items());
    expect(reopened.ref).toBe(item.ref);
    expect(reopened.evidenceRev).not.toBe(item.evidenceRev);
    expect(reopened.previous).toBe(item.ref);
    expect(reopened.previously).toEqual({
      how: "dismissed",
      at: iso(NOW),
      evidenceRev: item.evidenceRev,
    });
    // The newer evidence is set aside on its own.
    const second = await acknowledgeItem(
      { dir: f.dir, item: reopened, actor: SAM, via: "cli" },
      f.deps,
    );
    expect(second).toMatchObject({ ok: true, event: "acknowledged", state: "resolved" });
    expect(one(f.items({ state: "all" })).resolution?.how).toBe("acted");
    const up = await reopenItem(
      { dir: f.dir, item: one(f.items({ state: "all" })), actor: SAM, via: "cli" },
      f.deps,
    );
    expect(up).toMatchObject({ ok: true, event: "reopened", state: "open" });
    expect(f.items()).toHaveLength(1);
    expect(f.items()[0]?.anomalies).toBeUndefined();
    expect(lines(f.dir).map((l) => l["event"])).toEqual(["dismissed", "acknowledged", "reopened"]);
  });

  test("a decision is decided, never set aside", async () => {
    const f = fixture("dismiss-decision");
    await park(f.dir);
    const item = one(f.items());
    const request = { dir: f.dir, item, actor: SAM, via: "cli" as const };
    expect(reasonOf(await dismissItem({ ...request, reasonCode: "known" }, f.deps))).toBe(
      "conflict/decides",
    );
    expect(reasonOf(await acknowledgeItem(request, f.deps))).toBe("conflict/decides");
    expect(reasonOf(await reopenItem(request, f.deps))).toBe("conflict/decides");
    expect(lines(f.dir)).toEqual([]);
  });

  test("an overlay never settles a decision: a line that says one is resolved leaves it waiting", async () => {
    const f = fixture("forged");
    await park(f.dir);
    const item = one(f.items());
    for (const over of [
      { event: "dismissed", state: "resolved", how: "dismissed" },
      { event: "acknowledged", state: "resolved", how: "acted" },
    ]) {
      append(attentionActionsLedger(f.dir), {
        v: 1,
        id: idOfItem(item),
        at: iso(NOW),
        by: SOMEONE,
        via: "home",
        evidenceRev: item.evidenceRev,
        ...over,
      });
      expect(f.items().map((i) => i.state)).toEqual(["open"]);
    }
  });

  test("a request is put off on its own record: a line that says so hides nothing", async () => {
    const f = fixture("forged-defer");
    await park(f.dir);
    const item = one(f.items());
    append(attentionActionsLedger(f.dir), {
      v: 1,
      id: idOfItem(item),
      event: "deferred",
      state: "deferred",
      until: iso(NOW + DAY),
      at: iso(NOW),
      by: SOMEONE,
      via: "home",
      evidenceRev: item.evidenceRev,
    });
    expect(f.items().map((i) => i.state)).toEqual(["open"]);
  });

  test("a line the lifecycle does not allow is kept, counted, and shown as open", async () => {
    const f = fixture("illegal");
    problem(f);
    const item = one(f.items());
    await dismissItem({ dir: f.dir, item, actor: SAM, via: "cli", reasonCode: "known" }, f.deps);
    append(attentionActionsLedger(f.dir), {
      v: 1,
      id: idOfItem(item),
      event: "assigned",
      state: "assigned",
      to: SOMEONE,
      at: iso(NOW + 1),
      by: SOMEONE,
      via: "home",
      evidenceRev: item.evidenceRev,
    });
    const [shown] = f.items();
    expect(shown?.state).toBe("open");
    expect(shown?.anomalies).toBe(1);
    expect(shown?.assignee).toBeUndefined();
    expect(lines(f.dir)).toHaveLength(2);
  });

  test("an Advisor finding's dismissal is a version 2 line an older reader reads, and an acknowledgement one it skips", async () => {
    const f = fixture("advisor-ledger", { snapshots: FINDING });
    const item = one(f.items());
    const request = { dir: f.dir, item, actor: SAM, via: "home" as const };
    await dismissItem({ ...request, reasonCode: "not-now", note: "after the launch" }, f.deps);
    await reopenItem({ ...request, item: one(f.items({ state: "all" })) }, f.deps);
    await acknowledgeItem({ ...request, item: one(f.items()), note: "seen" }, f.deps);
    const raw = readFileSync(join(f.dir, ".crewhaus", "advisor", "decisions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(raw.map((l) => [l["v"], l["action"], l["reason"] ?? null])).toEqual([
      [2, "dismissed", "after the launch"],
      [2, "reopened", null],
      [2, "acknowledged", "seen"],
    ]);
    for (const line of raw) {
      expect(line["itemId"]).toBe("evals-none");
      expect(typeof line["by"]).toBe("string");
      expect(line["evidenceRev"]).toBe(item.evidenceRev);
    }
    // The actions an older reader keeps, and the one it leaves out.
    const kept = raw.filter((l) =>
      ["acted", "dismissed", "reopened"].includes(l["action"] as string),
    );
    expect(kept.map((l) => l["action"])).toEqual(["dismissed", "reopened"]);
    // A person's words stay there: the actions ledger holds codes.
    expect(JSON.stringify(lines(f.dir))).not.toContain("launch");
    expect(JSON.stringify(lines(f.dir))).not.toContain("seen");
  });

  test("a note belongs to an Advisor finding; a problem is discussed", async () => {
    const f = fixture("note");
    problem(f);
    const item = one(f.items());
    const before = treeState(f.dir);
    const answer = await dismissItem(
      { dir: f.dir, item, actor: SAM, via: "cli", reasonCode: "known", note: "jane said so" },
      f.deps,
    );
    expect(reasonOf(answer)).toBe("invalid/note");
    expect(treeState(f.dir)).toEqual(before);
  });
});

describe("the discussion", () => {
  test("a message is kept in the harness, private to it, and the act ledger says only that one exists", async () => {
    const f = fixture("thread");
    problem(f);
    const item = one(f.items());
    const request = { dir: f.dir, item, actor: SAM, via: "cli" as const };
    expect(await addMessage({ ...request, text: "Waiting on the vendor." }, f.deps)).toMatchObject({
      ok: true,
      event: "message",
      state: "open",
    });
    f.clock.now += MIN;
    await addMessage({ ...request, text: "They answered." }, f.deps);
    const thread = listMessages(f.dir, idOfItem(item));
    expect(thread.truncated).toBe(false);
    expect(thread.messages.map((m) => [m.text, m.via, m.at])).toEqual([
      ["Waiting on the vendor.", "cli", iso(NOW)],
      ["They answered.", "cli", iso(NOW + MIN)],
    ]);
    expect(thread.messages[0]?.by).toStartWith("local:#");
    expect(JSON.stringify(lines(f.dir))).not.toContain("vendor");
    expect(lines(f.dir).map((l) => l["event"])).toEqual(["message", "message"]);
    // The item is as it was.
    expect(one(f.items()).state).toBe("open");
    expect(listMessages(f.dir, "att_../../x").messages).toEqual([]);
  });

  test("an empty message, and one over 8 KiB, are refused with nothing written", async () => {
    const f = fixture("thread-caps");
    problem(f);
    const item = one(f.items());
    const before = treeState(f.dir);
    for (const text of ["", "   ", "é".repeat(4097)]) {
      const answer = await addMessage({ dir: f.dir, item, actor: SAM, via: "cli", text }, f.deps);
      expect(reasonOf(answer)).toBe("invalid/text");
    }
    expect(treeState(f.dir)).toEqual(before);
    expect(existsSync(join(f.dir, ".crewhaus", "run", "attention"))).toBe(false);
  });
});

describe("a refused act writes nothing", () => {
  test("a service credential below the class, and a head with an unreadable list of members", async () => {
    const f = fixture("refused");
    await park(f.dir, { requiredClass: "maintainer" });
    const item = one(f.items());
    const service: DecisionActor = { kind: "principal", principal: mintId("prn"), service: true };
    const before = treeState(f.dir);
    const answer = await resolveItem(
      { dir: f.dir, item, actor: service, via: "sdk", choice: "grant" },
      f.deps,
    );
    expect(reasonOf(answer)).toBe("forbidden/class");
    expect(treeState(f.dir)).toEqual(before);
    const file = join(f.dir, controlPaths(f.dir).approversFile);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{}");
    const unreadable = await resolveItem(
      { dir: f.dir, item, actor: SAM, via: "cli", choice: "grant" },
      f.deps,
    );
    expect(reasonOf(unreadable)).toBe("authorization_unavailable/approvers_unreadable");
  });
});
