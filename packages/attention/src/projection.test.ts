/**
 * One fold, two ways to reach it, and neither writes. The projection (folded, saved,
 * caught up and refreshed) gives the same items as the direct fold for every fixture
 * harness; a refresh over a harness that did not change reads no file content and
 * answers the same object; the ids are the same in both and in every process; every item
 * key holds only ids, kinds, names and digests; an evidence revision moves only with its
 * evidence. Folding, refreshing and measuring a fixture fleet changes no byte or mtime
 * and creates nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isId, parseRef } from "@crewhaus/control-contract";
import { type ResumeItem, resume } from "@crewhaus/control-records";
import type { AdvisorItem } from "@crewhaus/harness-advice/advisor";
import {
  HOUR,
  MIN,
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
} from "./__test__/fleet";
import { assembleInbox, foldHarness, harnessAttention } from "./fold";
import { KEY_SHAPE_RE, attIdOf, evidenceRevOf } from "./ids";
import { metricsOf } from "./metrics";
import { attentionProjection } from "./projection";
import { type AttentionReader, DEFAULT_READER, READ_CAPS } from "./read";
import type { AdvisorSnapshot, AttentionModel, HarnessFacts } from "./types";

const HRNS = ["hrn_0000000000000001", "hrn_0000000000000002", "hrn_0000000000000003"];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function counting(): AttentionReader & { tails: number } {
  const reader = {
    tails: 0,
    stamp: DEFAULT_READER.stamp,
    tail(root: string, rel: string, caps: typeof READ_CAPS) {
      reader.tails += 1;
      return DEFAULT_READER.tail(root, rel, caps);
    },
  };
  return reader;
}

const finding = (id: string): AdvisorItem => ({
  id,
  severity: "suggestion",
  title: "t",
  detail: "d",
  explain: "e",
  guidance: "g",
  screen: "evals",
  source: "evals",
  action: null,
  status: "open",
});

/** Three harnesses: approvals and a request, review and runs, and an Advisor snapshot. */
async function fleet(): Promise<{ root: string; dirs: string[]; facts: HarnessFacts }> {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  const dirs = ["one", "two", "three"].map((name) => harnessDir(t.root, name));
  const [one, two, three] = dirs as [string, string, string];
  await park(one, { askDigest: "q1" });
  await park(one, { askDigest: "q1", sessionId: `sess_${"9".repeat(16)}` });
  proposal(one);
  review(two);
  run(two, { at: NOW - HOUR, state: "failed", failureClass: "tool" });
  run(two, { at: NOW - 2 * HOUR, state: "failed", failureClass: "auth" });
  run(three, { at: NOW - 3 * HOUR, state: "succeeded" });
  const snapshot: AdvisorSnapshot = { at: iso(NOW - MIN), items: [finding("evals-none")] };
  const facts = testFacts({}, new Map([[three, snapshot]]));
  return { root: t.root, dirs, facts };
}

/** What a projector pass then a later read do, without the projector: fold, save, catch up, refresh. */
function projected(
  dir: string,
  facts: HarnessFacts,
  reader: AttentionReader,
): { saved: AttentionModel; cursor: ReturnType<typeof resume>["next"] } {
  const projection = attentionProjection(facts, { reader });
  const answer = resume(projection.sources(dir), undefined, READ_CAPS);
  let state = projection.empty();
  for (const item of answer.items) state = projection.fold(state, item);
  state = projection.refresh(state, dir, NOW);
  return { saved: JSON.parse(JSON.stringify(state)) as AttentionModel, cursor: answer.next };
}

function catchUp(
  dir: string,
  facts: HarnessFacts,
  reader: AttentionReader,
  saved: AttentionModel,
  cursor: ReturnType<typeof resume>["next"],
): AttentionModel {
  const projection = attentionProjection(facts, { reader });
  let state = structuredClone(saved);
  const answer = resume(projection.sources(dir), cursor, READ_CAPS);
  for (const item of answer.items as ResumeItem[]) state = projection.fold(state, item);
  return projection.refresh(state, dir, NOW);
}

const withoutFreshness = (items: readonly { freshness: unknown }[]) =>
  items.map(({ freshness: _f, ...rest }) => rest);

describe("one fold, two ways", () => {
  test("the projection and the direct fold give identical items for each harness", async () => {
    const { dirs, facts } = await fleet();
    for (const [i, dir] of dirs.entries()) {
      const harness = HRNS[i] as string;
      const direct = foldHarness(dir, facts, NOW, { harness, content: true });
      const { saved } = projected(dir, facts, DEFAULT_READER);
      const advisor = facts.advisorSnapshot?.(dir);
      const viaModel = harnessAttention(
        saved,
        {
          harness,
          dir,
          now: NOW,
          content: true,
          freshness: { asOf: iso(NOW), mode: "projection" },
        },
        { facts, ...(advisor !== undefined ? { advisor } : {}) },
      );
      const a = assembleInbox([direct], NOW, { state: "all" }).items;
      const b = assembleInbox([viaModel], NOW, { state: "all" }).items;
      expect(a.length).toBeGreaterThan(0);
      expect(withoutFreshness(b)).toEqual(withoutFreshness(a));
      expect(b.every((item) => item.freshness.mode === "projection")).toBe(true);
      expect(a.every((item) => item.freshness.mode === "direct-fold")).toBe(true);
    }
  });

  test("a refresh over a harness that did not change reads no content and answers the same model", async () => {
    const { dirs, facts } = await fleet();
    for (const dir of dirs) {
      const reader = counting();
      const { saved } = projected(dir, facts, reader);
      reader.tails = 0;
      const again = attentionProjection(facts, { reader }).refresh(saved, dir, NOW);
      expect(again).toBe(saved);
      expect(reader.tails).toBe(0);
    }
  });

  test("a change re-reads only the section that changed, and the caught-up model matches a new fold", async () => {
    const { dirs, facts } = await fleet();
    const two = dirs[1] as string;
    const reader = counting();
    const { saved, cursor } = projected(two, facts, reader);
    run(two, { at: NOW - MIN, state: "failed", failureClass: "auth" });
    reader.tails = 0;
    const caught = catchUp(two, facts, reader, saved, cursor);
    // A new run joins, and no approvals or review file was read again.
    expect(reader.tails).toBe(0);
    const ctx = {
      harness: HRNS[1] as string,
      dir: two,
      now: NOW,
      content: false,
      freshness: { asOf: iso(NOW), mode: "projection" as const },
    };
    const viaModel = assembleInbox([harnessAttention(caught, ctx, { facts })], NOW).items;
    const direct = assembleInbox(
      [foldHarness(two, facts, NOW, { harness: HRNS[1] as string })],
      NOW,
    ).items;
    expect(withoutFreshness(viaModel)).toEqual(withoutFreshness(direct));
  });
});

describe("ids and revisions", () => {
  test("the same evidence names the same item in two folds; every ref parses", async () => {
    const { dirs, facts } = await fleet();
    const refs = (n: number) =>
      assembleInbox(
        dirs.map((dir, i) => foldHarness(dir, facts, NOW, { harness: HRNS[i] as string })),
        NOW + n,
        { state: "all" },
      ).items.map((i) => i.ref);
    expect(refs(0)).toEqual(refs(1));
    for (const ref of refs(0)) {
      const parsed = parseRef(ref);
      expect("error" in parsed).toBe(false);
      expect(isId("att", (parsed as { id: string }).id)).toBe(true);
    }
  });

  test("every item key holds only ids, kinds, names and digests", async () => {
    const { dirs, facts } = await fleet();
    const inbox = assembleInbox(
      dirs.map((dir, i) => foldHarness(dir, facts, NOW, { harness: HRNS[i] as string })),
      NOW,
      { state: "all" },
    );
    let checked = 0;
    for (const item of inbox.all) {
      const scope = item.harnesses !== undefined ? "home" : (item.harness as string);
      // The key is what the id is the digest of: find it among the item's own names.
      const candidates = [
        item.cause?.id,
        `dec:${item.source.id}`,
        `rev:${item.source.id}`,
        `adv:${item.source.id}`,
        `ask:${item.source.id}`,
        `appr:${item.source.id}`,
      ].filter((k): k is string => k !== undefined);
      const key = candidates.find(
        (k) => `home/attention/${attIdOf(scope, item.kind, k)}` === item.ref,
      );
      expect(key).toBeDefined();
      expect(KEY_SHAPE_RE.test(key as string)).toBe(true);
      checked++;
    }
    expect(checked).toBe(inbox.all.length);
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  test("a revision holds still when an unrelated file changes, and moves when a run joins", async () => {
    const { dirs, facts } = await fleet();
    const two = dirs[1] as string;
    const revOf = () =>
      assembleInbox([foldHarness(two, facts, NOW, { harness: HRNS[1] as string })], NOW).items.find(
        (i) => i.kind === "credential",
      )?.evidenceRev;
    const before = revOf();
    writeFileSync(join(two, "notes.txt"), "unrelated\n");
    expect(revOf()).toBe(before);
    run(two, { at: NOW - 5 * MIN, state: "failed", failureClass: "auth" });
    expect(revOf()).not.toBe(before);
    expect(
      evidenceRevOf([
        { id: "b", state: "x" },
        { id: "a", state: "y" },
      ]),
    ).toBe(
      evidenceRevOf([
        { id: "a", state: "y" },
        { id: "b", state: "x" },
      ]),
    );
  });
});

describe("reads never mutate", () => {
  test("folding, refreshing and measuring a fleet leaves every byte and mtime, and creates nothing", async () => {
    const { root, dirs, facts } = await fleet();
    const before = treeState(root);
    expect(before.size).toBeGreaterThan(10);
    const per = dirs.map((dir, i) =>
      foldHarness(dir, facts, NOW, { harness: HRNS[i] as string, content: true }),
    );
    const inbox = assembleInbox(per, NOW, { state: "all" });
    for (const dir of dirs) projected(dir, facts, DEFAULT_READER);
    metricsOf(
      { items: inbox.items, decisions: inbox.decisions },
      { since: NOW - 30 * 86_400_000, now: NOW },
    );
    expect(treeState(root)).toEqual(before);
  });
});
