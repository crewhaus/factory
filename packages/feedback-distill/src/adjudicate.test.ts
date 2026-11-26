/**
 * A verdict on a review entry, whichever surface gives it: a rating on a session's turn is
 * recorded on that session's log and then the entry is resolved; a verdict on an entry with
 * no turn is recorded on the entry; of two verdicts one is recorded, and the other writes
 * nothing; a sessions folder that cannot be reached takes no rating.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjudicateReviewEntry, isAdjudicable, isReviewVerdict } from "./adjudicate";
import { type ReviewQueueEntry, enqueueReviewEntries, reviewQueuePath } from "./review-queue";

const TS = "2026-11-19T10:00:00.000Z";
const SESSION = "sess_00000000000000aa";
const ANA = { by: "prn_00000000000000000000000001", via: "home" };
const BO = { by: `local:#${"0123456789abcdef".repeat(4)}`, via: "cli" };

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function harness(entry: Partial<ReviewQueueEntry> = {}): { dir: string; sessions: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "review-adjudicate-")));
  roots.push(dir);
  enqueueReviewEntries(dir, [
    {
      schemaVersion: 1,
      id: "rev_rater_disagreement_sess_00000000000000aa_t1",
      kind: "rater_disagreement",
      sourceRef: { sessionId: SESSION, turn: 1 },
      ts: TS,
      status: "open",
      ...entry,
    } as ReviewQueueEntry,
  ]);
  return { dir, sessions: join(dir, ".crewhaus", "sessions") };
}

const lines = (dir: string) => readFileSync(reviewQueuePath(dir), "utf8").trim().split("\n");

/** Every rating on a session's log. */
function ratings(sessions: string): Record<string, unknown>[] {
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions)
    .filter((name) => name.startsWith(SESSION))
    .flatMap((name) => readFileSync(join(sessions, name), "utf8").trim().split("\n"))
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event["kind"] === "user_feedback");
}

describe("a verdict on a review entry", () => {
  test("a rating on a turn lands on the session's log, then the entry is resolved, once", async () => {
    const { dir, sessions } = harness();
    const id = "rev_rater_disagreement_sess_00000000000000aa_t1";
    const ask = (verdict: "up" | "down", actor: typeof ANA) =>
      adjudicateReviewEntry({
        harnessDir: dir,
        itemId: id,
        verdict,
        by: actor.by,
        actor,
        source: "cli",
        nowIso: TS,
        sessionRoot: () => ({ root: sessions }),
      });
    const [first, second] = await Promise.all([ask("up", ANA), ask("down", BO)]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-resolved", "resolved"]);
    const won = first.outcome === "resolved" ? first : second;
    expect(won).toMatchObject({ adjudicated: true });
    const recorded = ratings(sessions);
    expect(recorded).toHaveLength(1);
    const payload = recorded[0]?.["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({ adjudication: true, source: "cli", sessionId: SESSION });
    const last = JSON.parse(lines(dir).at(-1) as string) as Record<string, unknown>;
    expect(last["status"]).toBe("resolved");
    expect([last["resolvedBy"], last["via"]]).toEqual(
      first.outcome === "resolved" ? [ANA.by, ANA.via] : [BO.by, BO.via],
    );
    expect(lines(dir)).toHaveLength(2);
  });

  test("a verdict on an entry with no turn is recorded on the entry, and no rating is", async () => {
    const { dir, sessions } = harness({
      id: "rev_abstained_run_00000000000000aa_s1",
      kind: "abstained",
      sourceRef: { runId: "run_00000000000000aa", sampleId: "s1" },
    });
    const base = {
      harnessDir: dir,
      itemId: "rev_abstained_run_00000000000000aa_s1",
      by: ANA.by,
      actor: ANA,
      nowIso: TS,
      sessionRoot: () => ({ root: sessions }),
    };
    const thumbs = await adjudicateReviewEntry({ ...base, verdict: "up" });
    expect(thumbs.outcome).toBe("rejected");
    expect(lines(dir)).toHaveLength(1);
    const passed = await adjudicateReviewEntry({ ...base, verdict: "pass", note: "fine" });
    expect(passed).toMatchObject({ outcome: "resolved", adjudicated: false, resolution: "fine" });
    expect(ratings(sessions)).toEqual([]);
  });

  test("a sessions folder that cannot be reached takes no rating, and nothing is written", async () => {
    const { dir, sessions } = harness();
    const answer = await adjudicateReviewEntry({
      harnessDir: dir,
      itemId: "rev_rater_disagreement_sess_00000000000000aa_t1",
      verdict: "down",
      by: BO.by,
      nowIso: TS,
      sessionRoot: () => ({ note: "outside the harness" }),
    });
    expect(answer).toEqual({ outcome: "rejected", reason: "outside the harness" });
    expect(lines(dir)).toHaveLength(1);
    expect(ratings(sessions)).toEqual([]);
    expect(existsSync(join(dir, ".crewhaus", "run", "control", "claims"))).toBe(false);
  });

  test("an unknown entry, and words that are not verdicts", async () => {
    const { dir, sessions } = harness();
    const answer = await adjudicateReviewEntry({
      harnessDir: dir,
      itemId: "rev_abstained_nope",
      verdict: "pass",
      by: ANA.by,
      nowIso: TS,
      sessionRoot: () => ({ root: sessions }),
    });
    expect(answer).toEqual({ outcome: "not-found" });
    expect(["up", "down", "pass", "fail"].every(isReviewVerdict)).toBe(true);
    expect(isReviewVerdict("grant")).toBe(false);
    expect(isAdjudicable({ sourceRef: { sessionId: SESSION, turn: 1 } })).toBe(true);
    expect(isAdjudicable({ sourceRef: { runId: "run_00000000000000aa" } })).toBe(false);
  });
});
