/**
 * A review entry is resolved once, whichever surface asks: its claim decides, one line is
 * appended, and the line says who resolved it and through which door. An id of any length
 * claims under a name of its own, and a claim its taker left behind is taken over.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_CLAIM_STALE_MS,
  type ReviewQueueEntry,
  claimReviewEntry,
  enqueueReviewEntries,
  readReviewQueue,
  resolveReviewEntry,
  reviewClaimName,
  reviewEntryId,
  reviewQueuePath,
} from "./index";

const TS = "2026-11-19T10:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(TS) + ms).toISOString();
const ANA = { by: "prn_00000000000000000000000001", via: "home" };
const BO = { by: `local:#${"0123456789abcdef".repeat(4)}`, via: "cli" };

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function harness(id = "rev_abstained_run_00000000000000aa_s1"): { dir: string; id: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "review-claim-")));
  roots.push(dir);
  const entry: ReviewQueueEntry = {
    schemaVersion: 1,
    id,
    kind: "abstained",
    sourceRef: { runId: "run_00000000000000aa", sampleId: "s1" },
    ts: TS,
    status: "open",
  };
  enqueueReviewEntries(dir, [entry]);
  return { dir, id };
}

const claimsOf = (dir: string) =>
  readdirSync(join(dir, ".crewhaus", "run", "control", "claims", "review"));
const lines = (dir: string) => readFileSync(reviewQueuePath(dir), "utf8").trim().split("\n");

describe("a review entry is resolved once", () => {
  test("of two resolvers one resolves, one line is appended, and it says who and where", () => {
    const { dir, id } = harness();
    // Both read the open entry; the claim decides, whatever either read.
    const first = resolveReviewEntry(dir, id, "pass", TS, ANA);
    const second = resolveReviewEntry(dir, id, "fail", later(1000), BO);
    expect(first.outcome).toBe("resolved");
    expect(second.outcome).toBe("already-resolved");
    expect(lines(dir)).toHaveLength(2);
    const resolved = readReviewQueue(dir)[0];
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "pass",
      resolvedTs: TS,
      resolvedBy: ANA.by,
      via: "home",
    });
    expect(claimsOf(dir)).toEqual([`${reviewClaimName(id).slice("review/".length)}.json`]);
  });

  test("a resolver that read the entry open loses to one that claimed it, and appends nothing", () => {
    const { dir, id } = harness();
    expect(claimReviewEntry(dir, id, { at: TS, actor: ANA })).toEqual({ outcome: "claimed" });
    const before = lines(dir);
    const loser = resolveReviewEntry(dir, id, "fail", later(1000), BO);
    expect(loser).toMatchObject({
      outcome: "already-resolved",
      winner: { by: ANA.by, via: "home", at: TS },
    });
    expect(lines(dir)).toEqual(before);
    // The holder finishes with the claim it took.
    const held = resolveReviewEntry(dir, id, "pass", later(2000), ANA, { claimed: true });
    expect(held.outcome).toBe("resolved");
    expect(lines(dir)).toHaveLength(2);
  });

  test("an id of 250 characters claims under its digest and resolves", () => {
    const id = `rev_quarantine_${"a".repeat(235)}`;
    expect(id.length).toBe(250);
    expect(reviewEntryId("quarantine", { dataset: "a".repeat(235) })).toBe(id);
    const { dir } = harness(id);
    expect(resolveReviewEntry(dir, id, "pass", TS, ANA).outcome).toBe("resolved");
    const [claim] = claimsOf(dir);
    expect(claim).toMatch(/^r[0-9a-f]{40}\.json$/);
    const record = JSON.parse(
      readFileSync(
        join(dir, ".crewhaus", "run", "control", "claims", "review", claim as string),
        "utf8",
      ),
    ) as { record: Record<string, unknown> };
    expect(record.record).toEqual({ id, at: TS, ...ANA });
  });

  test("a claim left unresolved is taken over once it is stale, by one resolver", () => {
    const { dir, id } = harness();
    claimReviewEntry(dir, id, { at: TS, actor: ANA });
    const soon = claimReviewEntry(dir, id, { at: later(REVIEW_CLAIM_STALE_MS), actor: BO });
    expect(soon.outcome).toBe("taken");
    const stale = later(REVIEW_CLAIM_STALE_MS + 1);
    expect(claimReviewEntry(dir, id, { at: stale, actor: BO })).toEqual({ outcome: "claimed" });
    expect(claimReviewEntry(dir, id, { at: stale, actor: ANA })).toMatchObject({
      outcome: "taken",
      winner: { by: BO.by },
    });
    expect(resolveReviewEntry(dir, id, "pass", stale, BO, { claimed: true }).outcome).toBe(
      "resolved",
    );
    // A resolved entry is never taken over, however old its claim is.
    expect(claimReviewEntry(dir, id, { at: later(86_400_000), actor: ANA }).outcome).toBe("taken");
  });

  test("with no actor the line names nobody, and an unknown id claims nothing", () => {
    const { dir, id } = harness();
    expect(resolveReviewEntry(dir, "rev_nope", "pass", TS).outcome).toBe("not-found");
    const done = resolveReviewEntry(dir, id, "pass", TS);
    expect(done.outcome).toBe("resolved");
    expect(Object.keys(readReviewQueue(dir)[0] ?? {})).not.toContain("resolvedBy");
  });

  test("a claims folder that is not a folder: nothing is written, and it says so", () => {
    const { dir, id } = harness();
    writeFileSync(join(dir, ".crewhaus", "run"), "not a folder");
    const answer = resolveReviewEntry(dir, id, "pass", TS, ANA);
    expect(answer.outcome).toBe("unavailable");
    expect(lines(dir)).toHaveLength(1);
  });
});
