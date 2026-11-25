import { afterEach, describe, expect, test } from "bun:test";
import { outcomesLedger, readLedgerLines } from "../work-items/delivery";
import {
  effectiveWorkState,
  openWorkStore,
  readDeliveryFacts,
  readOutcomes,
} from "../work-items/index";
import { writeBindings } from "./bindings";
import { ENDED_WATCH_MS, type SyncDeps, applyPullEvent, syncOutcomes } from "./outcomes";
import { appendOutcome } from "./records";
import { type Bench, HARNESS, PERSON, REPO, bench } from "./test-helpers";

const benches: Bench[] = [];
afterEach(async () => {
  for (const b of benches.splice(0)) await b.stop();
});

const SLOW = 60_000; // real git children and a loopback host

/** A harness with one open pull request, and a clock the test moves. */
async function delivered() {
  const b = await bench();
  benches.push(b);
  writeBindings(b.dir, b.bindings);
  let clock = Date.now();
  const now = () => clock;
  const engine = b.engine({ now });
  const wi = await b.item();
  const opened = await engine.open(wi, { actor: HARNESS });
  if (!opened.ok) throw new Error(opened.message);
  b.write(opened.worktree, "src/dates.ts", "export const parse = 2;\n");
  const done = await b.publish(engine, wi);
  if (!done.ok || done.pr === undefined) throw new Error(JSON.stringify(done));
  const deps: SyncDeps = { now, env: b.env };
  return {
    b,
    now,
    wi,
    engine,
    worktree: opened.worktree,
    pr: done.pr,
    later: (ms = 60_000) => {
      clock += ms;
    },
    sync: () => syncOutcomes(b.dir, deps),
    item: () => {
      const read = openWorkStore(b.dir, { now }).get(wi);
      if ("ok" in read) throw new Error(read.message);
      return read.item;
    },
    status: () => {
      const read = openWorkStore(b.dir).get(wi);
      if ("ok" in read) throw new Error(read.message);
      const { state, outcome } = read.item;
      return effectiveWorkState({
        state,
        ...(outcome !== undefined ? { outcome } : {}),
        ...readDeliveryFacts(b.dir).get(wi),
      });
    },
    lines: () => readLedgerLines(outcomesLedger(b.dir)).lines,
    store: openWorkStore(b.dir, { now }),
    apply: (id: string, payload: unknown) => applyPullEvent(b.dir, id, payload, { now }),
  };
}

describe("the pull request tracker", () => {
  test(
    "open, then approved, then merged: the item closes as done, by the tracker",
    async () => {
      const t = await delivered();
      expect(await t.sync()).toMatchObject({ checked: 1, wrote: 1, moved: 0 });
      expect(t.status()).toBe("in-review");
      t.later();
      t.b.fake.setReviews(REPO, t.pr, [{ login: "max", state: "CHANGES_REQUESTED" }]);
      expect(await t.sync()).toMatchObject({ wrote: 1 });
      expect(t.status()).toBe("changes-requested");
      t.later();
      t.b.fake.mergePull(REPO, t.pr);
      expect(await t.sync()).toMatchObject({ wrote: 1, moved: 1 });
      expect(t.item()).toMatchObject({ state: "closed", outcome: "done" });
      const closed = t.item().history.at(-1);
      expect(closed).toMatchObject({ event: "closed", by: "sys:outcomes", rule: "work.outcomes" });
      expect(readOutcomes(t.b.dir).get(t.wi)).toMatchObject({ state: "merged" });
      expect(readOutcomes(t.b.dir).get(t.wi)?.changed).toBeUndefined();
      expect(t.status()).toBe("merged");
    },
    SLOW,
  );

  test(
    "an answer that did not change writes nothing",
    async () => {
      const t = await delivered();
      await t.sync();
      const lines = t.lines().length;
      const before = t.b.fake.requests().length;
      t.later();
      expect(await t.sync()).toMatchObject({ checked: 1, wrote: 0, moved: 0 });
      expect(t.lines().length).toBe(lines);
      // One read, answered 304: the reviews are not asked again.
      expect(t.b.fake.requests().slice(before)).toEqual([`GET /repos/${REPO}/pulls/${t.pr}`]);
    },
    SLOW,
  );

  test(
    "reviews that could not be read keep what is known, and are asked for again",
    async () => {
      const t = await delivered();
      t.b.fake.setReviews(REPO, t.pr, [{ login: "max", state: "APPROVED" }]);
      await t.sync();
      expect(readOutcomes(t.b.dir).get(t.wi)).toMatchObject({ review: "approved" });
      const lines = t.lines().length;
      t.later();
      t.b.fake.setReviews(REPO, t.pr, [{ login: "max", state: "CHANGES_REQUESTED" }]);
      t.b.fake.refuseNext("/reviews", 503);
      const refused = await t.sync();
      expect(refused).toMatchObject({ checked: 1, wrote: 0 });
      expect(refused.problem).toContain("503");
      expect(t.lines().length).toBe(lines);
      t.later();
      expect(await t.sync()).toMatchObject({ checked: 1, wrote: 1 });
      expect(readOutcomes(t.b.dir).get(t.wi)).toMatchObject({ review: "changes-requested" });
    },
    SLOW,
  );

  test(
    "closed without merging declines the item, and reopened reopens it",
    async () => {
      const t = await delivered();
      await t.sync();
      t.later();
      t.b.fake.closePull(REPO, t.pr);
      expect(await t.sync()).toMatchObject({ wrote: 1, moved: 1 });
      expect(t.item()).toMatchObject({
        state: "closed",
        outcome: "declined",
        reasonCode: "pr-closed",
      });
      expect(t.status()).toBe("closed-unmerged");
      t.later();
      t.b.fake.reopenPull(REPO, t.pr);
      expect(await t.sync()).toMatchObject({ wrote: 1, moved: 1 });
      expect(t.item().state).toBe("open");
      expect(t.item().history.at(-1)).toMatchObject({ event: "reopened", by: "sys:outcomes" });
      expect(t.status()).toBe("in-review");
    },
    SLOW,
  );

  test(
    "an item a person already closed is left closed, and only the pull request's line is written",
    async () => {
      const t = await delivered();
      await t.sync();
      t.later();
      await t.store.transition(t.wi, "closed", { outcome: "cancelled" }, PERSON);
      t.later();
      t.b.fake.closePull(REPO, t.pr);
      expect(await t.sync()).toMatchObject({ wrote: 1, moved: 0 });
      expect(t.item()).toMatchObject({ state: "closed", outcome: "cancelled" });
      t.later();
      t.b.fake.reopenPull(REPO, t.pr);
      expect(await t.sync()).toMatchObject({ wrote: 1, moved: 0 });
      expect(t.item().state).toBe("closed");
    },
    SLOW,
  );

  test(
    "an item a person reopened after it is not closed again",
    async () => {
      const t = await delivered();
      await t.sync();
      t.later();
      t.b.fake.closePull(REPO, t.pr);
      await t.sync();
      t.later();
      await t.store.transition(t.wi, "open", {}, PERSON);
      t.later();
      expect(await t.sync()).toMatchObject({ moved: 0 });
      expect(t.item().state).toBe("open");
    },
    SLOW,
  );

  test(
    "a head that moved before the merge is merged with changes",
    async () => {
      const t = await delivered();
      await t.sync();
      t.later();
      t.b.fake.mergePull(REPO, t.pr, { changeFirst: true });
      await t.sync();
      expect(readOutcomes(t.b.dir).get(t.wi)).toMatchObject({ state: "merged", changed: true });
    },
    SLOW,
  );

  test(
    "a revert of the merge on the base is recorded once, and the watch ends",
    async () => {
      const t = await delivered();
      await t.sync();
      t.later();
      const { mergeSha } = t.b.fake.mergePull(REPO, t.pr);
      await t.sync();
      t.later();
      expect(await t.sync()).toMatchObject({ checked: 1, wrote: 0 });
      t.b.fake.commitOnBranch(REPO, "main", `Revert it\n\nThis reverts commit ${mergeSha}.`);
      expect(await t.sync()).toMatchObject({ wrote: 1 });
      expect(readOutcomes(t.b.dir).get(t.wi)).toMatchObject({ state: "reverted", reverted: true });
      expect(t.status()).toBe("reverted");
      const before = t.b.fake.requests().length;
      expect(await t.sync()).toMatchObject({ checked: 0, wrote: 0 });
      expect(t.b.fake.requests().length).toBe(before);
    },
    SLOW,
  );

  test(
    "a merged pull request is not watched for ever",
    async () => {
      const t = await delivered();
      t.b.fake.mergePull(REPO, t.pr);
      await t.sync();
      t.later(ENDED_WATCH_MS + 1);
      const before = t.b.fake.requests().length;
      expect(await t.sync()).toMatchObject({ checked: 0 });
      expect(t.b.fake.requests().length).toBe(before);
    },
    SLOW,
  );

  test(
    "a rate limit backs off: nothing is asked until the host's wait is over",
    async () => {
      const t = await delivered();
      t.b.fake.rateLimitNext(1, 600);
      const limited = await t.sync();
      expect(limited.waitUntil).toBeDefined();
      const before = t.b.fake.requests().length;
      t.later(599_000);
      expect(await t.sync()).toMatchObject({ checked: 0 });
      expect(t.b.fake.requests().length).toBe(before);
      t.later(2_000);
      expect(await t.sync()).toMatchObject({ checked: 1, wrote: 1 });
    },
    SLOW,
  );

  test(
    "a move a stopped process left unmade is made by the next pass, once",
    async () => {
      const t = await delivered();
      await t.sync();
      t.later();
      // The outcome is recorded and the item is not moved: what stopping in between leaves.
      const newest = readOutcomes(t.b.dir).get(t.wi);
      if (newest === undefined) throw new Error("no outcome line");
      await appendOutcome(
        t.b.dir,
        {
          ...newest,
          at: new Date(t.now()).toISOString(),
          state: "merged",
          mergeSha: "e".repeat(40),
        },
        () => false,
        () => undefined,
      );
      expect(t.item().state).toBe("open");
      t.later();
      expect(await t.sync()).toMatchObject({ moved: 1 });
      expect(t.item()).toMatchObject({ state: "closed", outcome: "done" });
      t.later();
      expect(await t.sync()).toMatchObject({ moved: 0 });
    },
    SLOW,
  );
});

describe("one webhook delivery", () => {
  const payload = (t: { pr: number; b: Bench }, over: Record<string, unknown> = {}) => ({
    action: "closed",
    repository: { full_name: REPO },
    pull_request: {
      number: t.pr,
      state: "closed",
      merged: true,
      merged_at: "2026-11-25T00:00:00Z",
      merge_commit_sha: "c".repeat(40),
      head: { ref: "crewhaus/x", sha: "d".repeat(40) },
      base: { ref: "main" },
      ...over,
    },
  });

  test(
    "is applied once, and the poll that follows writes nothing",
    async () => {
      const t = await delivered();
      const lines = t.lines().length;
      expect(await t.apply("delivery-1", payload(t))).toEqual({ wrote: true, moved: true });
      expect(await t.apply("delivery-1", payload(t))).toEqual({ wrote: false, moved: false });
      expect(t.lines().length).toBe(lines + 1);
      expect(t.item()).toMatchObject({ state: "closed", outcome: "done" });
      const line = t.lines().at(-1) as Record<string, unknown>;
      expect(line["delivery"]).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(line)).not.toContain("delivery-1");
      // A second delivery that says the same thing writes nothing either.
      expect(await t.apply("delivery-2", payload(t))).toEqual({ wrote: false, moved: false });
    },
    SLOW,
  );

  test(
    "about another repository or pull request does nothing",
    async () => {
      const t = await delivered();
      expect(
        await t.apply("d1", { ...payload(t), repository: { full_name: "acme/other" } }),
      ).toEqual({ wrote: false, moved: false });
      expect(await t.apply("d2", payload(t, { number: 99 }))).toEqual({
        wrote: false,
        moved: false,
      });
      expect(await t.apply("d3", "not a payload")).toEqual({ wrote: false, moved: false });
      expect(t.item().state).toBe("open");
    },
    SLOW,
  );
});

test(
  "a system reopen without the tracker's rule is refused",
  async () => {
    const b = await bench();
    benches.push(b);
    const store = openWorkStore(b.dir);
    const wi = await b.item();
    const system = { by: "sys:outcomes", via: "system", role: "system" } as const;
    await store.transition(wi, "closed", { outcome: "declined", reasonCode: "pr-closed" }, system);
    expect(await store.transition(wi, "open", {}, system)).toMatchObject({
      ok: false,
      reason: "rule_required",
    });
    expect(await store.transition(wi, "open", {}, system, "work.outcomes")).toMatchObject({
      ok: true,
    });
  },
  SLOW,
);
