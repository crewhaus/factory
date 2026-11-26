/**
 * A protected environment's quorum as a decision: opened once per version, one vote per
 * person, satisfied by distinct people, written to the file every release's gate reads,
 * and closed once the move went through.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DeployQuorumSubject, mintId } from "@crewhaus/control-contract";
import {
  DEPLOY_QUORUM_TTL_MS,
  append,
  controlPaths,
  decisionsLedger,
  deployQuorumState,
  readActionDecisions,
  readChangeAdoptions,
  readDeployQuorums,
  readProposals,
} from "@crewhaus/control-records";
import { releasedCount, releasedReadApprovals } from "./__test__/released-reader";
import { decideApproval, distinctApprovers, readApprovals } from "./approval-gate";
import {
  openQuorumDecision,
  quorumVoterProblem,
  recordQuorumVote,
  settleQuorumDecision,
} from "./quorum";

const NOW = Date.parse("2026-11-19T10:00:00.000Z");
const HASH = `sha256:${"ab".repeat(32)}`;
const SUBJECT: DeployQuorumSubject = {
  spec: "support-bot",
  environment: "prod",
  version: "v2",
  specHash: HASH,
};
const ALICE = mintId("prn");
const BOB = mintId("prn");
const OPERATOR = mintId("prn");
const LOCAL = `local:#${"0123456789abcdef".repeat(4)}`;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function harness(minApprovals = 2): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "quorum-")));
  roots.push(dir);
  mkdirSync(join(dir, ".crewhaus"), { recursive: true });
  writeFileSync(
    join(dir, ".crewhaus", "environments.json"),
    JSON.stringify({ environments: { prod: { requireApproval: true, minApprovals } } }),
  );
  return dir;
}

/** A harness with members: Alice and Bob are maintainers, one more is an operator. */
function governed(dir: string): void {
  const file = join(dir, controlPaths(dir).approversFile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      epoch: 1,
      generatedAt: new Date(NOW).toISOString(),
      governedSince: new Date(NOW).toISOString(),
      harness: "hrn_0123456789abcdef",
      owner: mintId("prn"),
      members: [
        { principal: ALICE, decide: "maintainer" },
        { principal: BOB, decide: "maintainer" },
        { principal: OPERATOR, decide: "operator" },
      ],
      links: [],
    }),
  );
}

const approvalsFile = (dir: string) =>
  join(dir, ".crewhaus", "approvals", "support-bot__prod.json");
const entries = (dir: string) =>
  existsSync(approvalsFile(dir))
    ? (JSON.parse(readFileSync(approvalsFile(dir), "utf8")) as Record<string, unknown>[])
    : [];

async function opened(dir: string): Promise<string> {
  const answer = await openQuorumDecision(dir, SUBJECT, { now: NOW });
  if (!answer.ok) throw new Error(answer.reason);
  return answer.row.id;
}

const vote = (principal: string, choice: "approve" | "deny" = "approve", display = principal) => ({
  principal,
  display,
  choice,
  now: NOW + 1000,
});

const rowOf = (dir: string, id: string) => {
  const read = readDeployQuorums(dir);
  if (read.state !== "present") throw new Error(read.state);
  return read.rows.find((row) => row.id === id);
};

describe("opening", () => {
  test("is once per version: asked again, the open decision answers", async () => {
    const dir = harness();
    const first = await openQuorumDecision(dir, SUBJECT, { now: NOW });
    const second = await openQuorumDecision(dir, SUBJECT, { now: NOW + 5 });
    expect(first.ok && first.opened).toBe(true);
    expect(second.ok && !second.opened).toBe(true);
    if (!first.ok || !second.ok) throw new Error("not opened");
    expect(second.row.id).toBe(first.row.id);
    expect(first.row).toMatchObject({
      kind: "deploy-quorum",
      state: "pending",
      requiredClass: "maintainer",
      subject: SUBJECT,
    });
    const other = await openQuorumDecision(dir, { ...SUBJECT, version: "v3" }, { now: NOW });
    expect(other.ok && other.row.id !== first.row.id).toBe(true);
  });

  test("two at once open one", async () => {
    const dir = harness();
    const answers = await Promise.all([
      openQuorumDecision(dir, SUBJECT, { now: NOW }),
      openQuorumDecision(dir, SUBJECT, { now: NOW }),
    ]);
    expect(answers.filter((a) => a.ok && a.opened)).toHaveLength(1);
    const read = readDeployQuorums(dir);
    expect(read.state === "present" && read.rows.length).toBe(1);
  });

  test("a name that fits no command opens nothing", async () => {
    const dir = harness();
    for (const bad of [
      { ...SUBJECT, spec: "call jane" },
      { ...SUBJECT, environment: "--prod" },
      { ...SUBJECT, version: "" },
      { ...SUBJECT, specHash: "0".repeat(64) },
    ]) {
      expect((await openQuorumDecision(dir, bad, { now: NOW })).ok).toBe(false);
    }
    expect(readDeployQuorums(dir).state).toBe("absent");
  });

  test("the other decision readers pass over it", async () => {
    const dir = harness();
    await opened(dir);
    for (const read of [readProposals(dir), readChangeAdoptions(dir), readActionDecisions(dir)]) {
      expect(read.state).toBe("present");
      expect(read.state === "present" && read.rows).toEqual([]);
      expect(read.state === "present" && read.anomalies).toEqual([]);
    }
    // A row that only says it is one is reported, never read.
    append(decisionsLedger(dir), {
      id: mintId("dec"),
      kind: "deploy-quorum",
      state: "pending",
      subject: { spec: "x;y" },
    });
    const read = readDeployQuorums(dir);
    expect(read.state === "present" && read.rows.length).toBe(1);
    expect(read.state === "present" && read.anomalies.length).toBe(1);
  });

  test("a decision that ran out is asked again; a denied one is not, until it runs out", async () => {
    const dir = harness(1);
    const first = await opened(dir);
    await recordQuorumVote(dir, first, vote(LOCAL, "deny"));
    expect(rowOf(dir, first)?.state).toBe("denied");
    const again = await openQuorumDecision(dir, SUBJECT, { now: NOW + 10_000 });
    expect(again.ok && again.row.id).toBe(first);
    const later = await openQuorumDecision(dir, SUBJECT, { now: NOW + DEPLOY_QUORUM_TTL_MS + 1 });
    expect(later.ok && later.opened).toBe(true);
  });
});

describe("voting", () => {
  test("two people meet two approvals: the second grants it, and the file holds both", async () => {
    const dir = harness(2);
    governed(dir);
    const dec = await opened(dir);
    const first = await recordQuorumVote(dir, dec, vote(ALICE, "approve", "Alice"));
    expect(first).toMatchObject({ outcome: "recorded", counted: ["Alice"], required: 2 });
    expect(rowOf(dir, dec)?.state).toBe("pending");
    const second = await recordQuorumVote(dir, dec, vote(BOB, "approve", "Bob"));
    expect(second).toMatchObject({ outcome: "recorded", counted: ["Alice", "Bob"], required: 2 });
    expect(rowOf(dir, dec)).toMatchObject({
      state: "granted",
      decision: "grant",
      decidedByPrincipal: BOB,
    });
    expect(entries(dir)).toEqual([
      {
        approver: "Alice",
        ts: new Date(NOW + 1000).toISOString(),
        specHash: HASH,
        version: "v2",
        principal: ALICE,
      },
      {
        approver: "Bob",
        ts: new Date(NOW + 1000).toISOString(),
        specHash: HASH,
        version: "v2",
        principal: BOB,
      },
    ]);
    if (process.platform !== "win32") {
      expect(statSync(approvalsFile(dir)).mode & 0o777).toBe(0o600);
    }
    const third = await recordQuorumVote(dir, dec, vote(LOCAL));
    expect(third.outcome).toBe("forbidden");
  });

  test("one person votes once, whatever name they sign with", async () => {
    const dir = harness(2);
    const dec = await opened(dir);
    expect((await recordQuorumVote(dir, dec, vote(LOCAL, "approve", "max"))).outcome).toBe(
      "recorded",
    );
    expect((await recordQuorumVote(dir, dec, vote(LOCAL, "approve", "someone"))).outcome).toBe(
      "already-voted",
    );
    expect((await recordQuorumVote(dir, dec, vote(LOCAL, "deny"))).outcome).toBe("already-voted");
    expect(entries(dir)).toHaveLength(1);
    expect(rowOf(dir, dec)?.state).toBe("pending");
  });

  test("two votes of one person at once count once", async () => {
    const dir = harness(2);
    const dec = await opened(dir);
    const answers = await Promise.all([
      recordQuorumVote(dir, dec, vote(LOCAL)),
      recordQuorumVote(dir, dec, vote(LOCAL)),
    ]);
    expect(answers.map((a) => a.outcome).sort()).toEqual(["already-voted", "recorded"]);
    expect(entries(dir)).toHaveLength(1);
    expect(rowOf(dir, dec)?.state).toBe("pending");
  });

  test("a hand-written approval and the same person's vote are one; another name is another", async () => {
    const dir = harness(2);
    const dec = await opened(dir);
    mkdirSync(dirname(approvalsFile(dir)), { recursive: true });
    const hand = {
      approver: "alice",
      ts: "2026-11-18T00:00:00.000Z",
      specHash: HASH,
      note: "by hand",
    };
    writeFileSync(approvalsFile(dir), JSON.stringify([hand]));
    const mine = await recordQuorumVote(dir, dec, vote(LOCAL, "approve", "alice"));
    expect(mine).toMatchObject({ outcome: "recorded", counted: ["alice"] });
    expect(rowOf(dir, dec)?.state).toBe("pending");
    // What was in the file stays, whole.
    expect(entries(dir)[0]).toEqual(hand);
    expect(
      distinctApprovers([
        { approver: "alice", ts: "t" },
        { approver: "alice", ts: "t", principal: ALICE },
        { approver: "alice", ts: "t", principal: BOB },
        { approver: "carol", ts: "t" },
      ]).sort(),
    ).toEqual(["alice", "alice", "carol"]);
  });

  test("a deny ends it and adds nothing to the approvals file", async () => {
    const dir = harness(2);
    governed(dir);
    const dec = await opened(dir);
    await recordQuorumVote(dir, dec, vote(ALICE, "approve", "Alice"));
    const before = readFileSync(approvalsFile(dir), "utf8");
    const denied = await recordQuorumVote(dir, dec, vote(BOB, "deny", "Bob"));
    expect(denied.outcome).toBe("recorded");
    expect(rowOf(dir, dec)).toMatchObject({ state: "denied", decision: "deny" });
    expect(readFileSync(approvalsFile(dir), "utf8")).toBe(before);
    const after = await recordQuorumVote(dir, dec, vote(OPERATOR));
    expect(after.outcome).toBe("forbidden");
    const late = await recordQuorumVote(dir, dec, vote(ALICE));
    expect(late.outcome).toBe("already-decided");
  });

  test("a person votes: not a service, and on a harness with members not below a maintainer", async () => {
    const dir = harness(1);
    const dec = await opened(dir);
    const service = await recordQuorumVote(dir, dec, { ...vote(ALICE), service: true });
    expect(service).toMatchObject({ outcome: "forbidden" });
    expect(service.outcome === "forbidden" && service.reason).toContain("service");
    expect(quorumVoterProblem(dir, { principal: "sys:reconcile" }, NOW)).toContain("person");
    expect(quorumVoterProblem(dir, { principal: "max" }, NOW)).toContain("person");
    governed(dir);
    const low = await recordQuorumVote(dir, dec, vote(OPERATOR));
    expect(low).toMatchObject({ outcome: "forbidden" });
    expect(low.outcome === "forbidden" && low.reason).toContain("maintainer");
    const local = await recordQuorumVote(dir, dec, vote(LOCAL));
    expect(local.outcome).toBe("forbidden");
    writeFileSync(join(dir, controlPaths(dir).approversFile), "{}");
    const unreadable = await recordQuorumVote(dir, dec, vote(ALICE));
    expect(unreadable.outcome === "forbidden" && unreadable.reason).toContain("cannot be read");
    expect(existsSync(approvalsFile(dir))).toBe(false);
    expect(rowOf(dir, dec)?.state).toBe("pending");
  });

  test("a file that cannot be read whole takes no vote, and the vote can be made later", async () => {
    const dir = harness(1);
    const dec = await opened(dir);
    mkdirSync(dirname(approvalsFile(dir)), { recursive: true });
    writeFileSync(approvalsFile(dir), "{not json");
    const bad = await recordQuorumVote(dir, dec, vote(LOCAL));
    expect(bad.outcome).toBe("unavailable");
    expect(readFileSync(approvalsFile(dir), "utf8")).toBe("{not json");
    expect(rowOf(dir, dec)?.state).toBe("pending");
    writeFileSync(approvalsFile(dir), "[]");
    expect((await recordQuorumVote(dir, dec, vote(LOCAL))).outcome).toBe("recorded");
    expect(rowOf(dir, dec)?.state).toBe("granted");
  });

  test("an approvals folder that leaves the harness is not written through", async () => {
    const dir = harness(1);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "quorum-outside-")));
    roots.push(outside);
    symlinkSync(outside, join(dir, ".crewhaus", "approvals"));
    const dec = await opened(dir);
    const answer = await recordQuorumVote(dir, dec, vote(LOCAL));
    expect(answer.outcome).toBe("unavailable");
    expect(existsSync(join(outside, "support-bot__prod.json"))).toBe(false);
  });

  test("a vote whose recording was cut short is finished by asking again", async () => {
    const dir = harness(2);
    const dec = await opened(dir);
    await recordQuorumVote(dir, dec, vote(LOCAL));
    // As if the process stopped between the claim and the file.
    rmSync(approvalsFile(dir));
    expect(readdirSync(join(dir, controlPaths(dir).claimsDir, "quorum-vote"))).toHaveLength(1);
    const again = await recordQuorumVote(dir, dec, vote(LOCAL));
    expect(again).toMatchObject({ outcome: "recorded", counted: [LOCAL] });
    expect(entries(dir)).toHaveLength(1);
    expect((await recordQuorumVote(dir, dec, vote(LOCAL))).outcome).toBe("already-voted");
  });

  test("an expired or unknown decision takes no vote", async () => {
    const dir = harness(1);
    const dec = await opened(dir);
    const late = { ...vote(LOCAL), now: NOW + DEPLOY_QUORUM_TTL_MS + 1 };
    expect((await recordQuorumVote(dir, dec, late)).outcome).toBe("expired");
    expect((await recordQuorumVote(dir, mintId("dec"), vote(LOCAL))).outcome).toBe("not-found");
    expect(existsSync(approvalsFile(dir))).toBe(false);
  });
});

describe("the file every release reads", () => {
  test("a CLI that has not upgraded parses it and counts only the approvals", async () => {
    const dir = harness(2);
    governed(dir);
    const dec = await opened(dir);
    await recordQuorumVote(dir, dec, vote(ALICE, "approve", "Alice"));
    const old = releasedReadApprovals(dir, "support-bot", "prod");
    expect(old).toHaveLength(1);
    expect(releasedCount(old, "v2")).toEqual(["Alice"]);
    expect(releasedCount(old, "v3")).toEqual([]);
    await recordQuorumVote(dir, dec, vote(BOB, "deny", "Bob"));
    expect(releasedCount(releasedReadApprovals(dir, "support-bot", "prod"), "v2")).toEqual([
      "Alice",
    ]);
  });

  test("this release's gate counts the same people, for this content only", async () => {
    const dir = harness(2);
    governed(dir);
    const dec = await opened(dir);
    await recordQuorumVote(dir, dec, vote(ALICE, "approve", "Alice"));
    await recordQuorumVote(dir, dec, vote(BOB, "approve", "Bob"));
    const count = (specHash: string) =>
      decideApproval({
        specName: "support-bot",
        toEnv: "prod",
        toVersion: "v2",
        specHash,
        policy: { requireApproval: true, minApprovals: 2 },
        approvals: readApprovals(dir, "support-bot", "prod"),
      });
    expect(count(HASH).satisfied).toBe(true);
    expect(count(`sha256:${"cd".repeat(32)}`).satisfied).toBe(false);
  });
});

describe("closing", () => {
  test("a move that went through consumes a granted decision, and supersedes a waiting one", async () => {
    const dir = harness(1);
    const dec = await opened(dir);
    await recordQuorumVote(dir, dec, vote(LOCAL));
    expect(await settleQuorumDecision(dir, SUBJECT, { now: NOW + 5000 })).toBe(true);
    expect(rowOf(dir, dec)?.state).toBe("consumed");
    expect(await settleQuorumDecision(dir, SUBJECT, { now: NOW + 6000 })).toBe(false);
    const other = harness(1);
    const waiting = await opened(other);
    expect(await settleQuorumDecision(other, SUBJECT, { now: NOW + 5000 })).toBe(true);
    expect(rowOf(other, waiting)?.state).toBe("superseded");
    const row = rowOf(other, waiting);
    expect(row === undefined ? undefined : deployQuorumState(row, NOW)).toBe("superseded");
  });

  test("where nothing was asked, nothing is written or created", async () => {
    const dir = harness(1);
    expect(await settleQuorumDecision(dir, SUBJECT, { now: NOW })).toBe(false);
    expect(existsSync(join(dir, ".crewhaus", "run"))).toBe(false);
  });
});
