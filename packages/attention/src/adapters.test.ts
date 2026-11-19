/**
 * The adapters over fixtures written by the real writers: requests that ask the same
 * thing fold into one item; a refusal makes a re-ask recommend refusing again; a question
 * is its own kind; a harness whose sessions folder lies outside it is unreachable and
 * nothing of it is read; `dec_` requests, review entries and Advisor findings become
 * items of their kinds.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { isId, parseRef } from "@crewhaus/control-contract";
import type { AdvisorItem } from "@crewhaus/harness-advice/advisor";
import {
  DAY,
  HOUR,
  MIN,
  NOW,
  decide,
  harnessDir,
  iso,
  park,
  proposal,
  review,
  tempRoot,
  testFacts,
  treeState,
} from "./__test__/fleet";
import { assembleInbox, foldHarness } from "./fold";

const HRN = "hrn_0123456789abcdef";
const OTHER = "hrn_fedcba9876543210";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function root(): string {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  return t.root;
}

const inboxOf = (dir: string, opts: { content?: boolean; state?: "open" | "all" } = {}) =>
  assembleInbox(
    [foldHarness(dir, testFacts(), NOW, { harness: HRN, content: opts.content ?? false })],
    NOW,
    { state: opts.state ?? "open" },
  );

describe("tool approvals and questions", () => {
  test("two pending requests with one ask, in two sessions, are one item with two waiting runs", async () => {
    const dir = harnessDir(root(), "asks");
    const a = await park(dir, { askDigest: "d1", sessionId: `sess_${"1".repeat(16)}` });
    const b = await park(dir, { askDigest: "d1", sessionId: `sess_${"2".repeat(16)}` });
    const c = await park(dir, { askDigest: "d2" });
    const items = inboxOf(dir).items.filter((i) => i.kind === "permission");
    expect(items).toHaveLength(2);
    const folded = items.find((i) => i.evidence.length === 2);
    expect(folded?.evidence.map((e) => e.ref).sort()).toEqual(
      [`${HRN}/decision/${a}`, `${HRN}/decision/${b}`].sort(),
    );
    expect(folded?.affected.count).toBe(2);
    expect(folded?.choices.every((choice) => choice.cliTwin === null)).toBe(true);
    expect(folded?.choices[0]?.nullReason).toContain("crewhaus approvals list");
    const single = items.find((i) => i.evidence.length === 1);
    expect(single?.evidence[0]?.ref).toBe(`${HRN}/decision/${c}`);
    expect(single?.choices.map((choice) => choice.cliTwin)).toEqual([
      `crewhaus approvals grant ${c} --dir ${dir}`,
      `crewhaus approvals deny ${c} --dir ${dir}`,
    ]);
  });

  test("a request without an ask is its own item, and every id it gets parses", async () => {
    const dir = harnessDir(root(), "plain");
    await park(dir);
    await park(dir);
    const items = inboxOf(dir).items;
    expect(items).toHaveLength(2);
    for (const item of items) {
      const parsed = parseRef(item.ref);
      expect("error" in parsed).toBe(false);
      expect(isId("att", (parsed as { id: string }).id)).toBe(true);
      expect(item.title).toEqual({ template: "permission.ask", params: { tool: "Bash" } });
    }
  });

  test("an ask refused within 30 days recommends refusing again, and says so", async () => {
    const dir = harnessDir(root(), "refused");
    const first = await park(dir, { askDigest: "d9", at: NOW - 2 * DAY });
    await decide(dir, first, "deny", NOW - 2 * DAY + MIN);
    await park(dir, { askDigest: "d9", at: NOW - MIN });
    const [item] = inboxOf(dir).items;
    expect(item?.recommendation).toEqual({
      choiceId: "deny",
      reason: { template: "recommend.refused-before", params: {} },
    });
    expect(item?.whyNow.template).toBe("why.asked-again");
    expect(item?.asks?.count).toBe(2);
    expect(typeof item?.asks?.refusedAt).toBe("string");
  });

  test("an owner-class ask never carries a recommendation", async () => {
    const dir = harnessDir(root(), "owner");
    const first = await park(dir, { askDigest: "d8", at: NOW - DAY, requiredClass: "owner" });
    await decide(dir, first, "deny", NOW - DAY + MIN);
    await park(dir, { askDigest: "d8", at: NOW - MIN, requiredClass: "owner" });
    const [item] = inboxOf(dir).items;
    expect(item?.requiredClass).toBe("owner");
    expect(item?.recommendation).toBeUndefined();
  });

  test("a question is a question; its words reach only a content reader", async () => {
    const dir = harnessDir(root(), "question");
    await park(dir, {
      kind: "input",
      input: { question: "which branch?" },
      tool: "RequestGuidance",
    });
    const withheld = inboxOf(dir).items[0];
    expect(withheld?.kind).toBe("question");
    expect(withheld?.body).toBeUndefined();
    expect(withheld?.bodyWithheld).toBe(true);
    const shown = inboxOf(dir, { content: true }).items[0];
    expect(shown?.body).toEqual({ input: { question: "which branch?" } });
    expect(shown?.bodyWithheld).toBeUndefined();
  });

  test("a decided request leaves the open list and is listed, resolved, with state=all", async () => {
    const dir = harnessDir(root(), "decided");
    const id = await park(dir, { at: NOW - HOUR });
    await decide(dir, id, "grant", NOW - 30 * MIN);
    expect(inboxOf(dir).items).toEqual([]);
    const [item] = inboxOf(dir, { state: "all" }).items;
    expect(item?.state).toBe("resolved");
    expect(item?.resolution).toMatchObject({ how: "decided", via: "cli" });
    expect(item?.choices).toEqual([]);
  });

  test("a session root outside the harness is unreachable, and nothing of it is read", async () => {
    const r = root();
    const dir = harnessDir(r, "moved");
    const outside = join(r, "elsewhere");
    mkdirSync(outside, { recursive: true });
    const other = harnessDir(r, "other");
    await park(other);
    // The harness's sessions folder is a link out of it, holding a request.
    rmSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
    symlinkSync(join(other, ".crewhaus", "sessions"), join(dir, ".crewhaus", "sessions"));
    const before = treeState(r);
    const h = foldHarness(dir, testFacts(), NOW, { harness: HRN, content: true });
    expect(h.unreachable).toBe(true);
    expect(h.items.filter((d) => d.item.kind === "permission")).toEqual([]);
    const inbox = assembleInbox([h, foldHarness(other, testFacts(), NOW, { harness: OTHER })], NOW);
    expect(inbox.unreachable).toEqual([HRN]);
    expect(inbox.items.map((i) => i.harness)).toEqual([OTHER]);
    expect(treeState(r)).toEqual(before);
  });

  test("a deadline is only a real one: the agreement's, else the request's time to live", async () => {
    const dir = harnessDir(root(), "deadline");
    await park(dir, { at: NOW - HOUR });
    const [item] = inboxOf(dir).items;
    expect(item?.deadline).toEqual({ at: iso(NOW - HOUR + 30 * DAY), source: "ttl" });
  });
});

describe("decisions, review entries and Advisor findings", () => {
  test("a standing-rule request is the owner's to decide, with the command that does it", () => {
    const dir = harnessDir(root(), "requests");
    const id = proposal(dir);
    const [item] = inboxOf(dir).items;
    expect(item?.kind).toBe("standing-rule-proposal");
    expect(item?.requiredClass).toBe("owner");
    expect(item?.source).toEqual({ kind: "decision", id });
    expect(item?.choices.map((c) => c.cliTwin)).toEqual([
      `crewhaus approvals grant ${id} --dir ${dir}`,
      `crewhaus approvals deny ${id} --dir ${dir}`,
    ]);
  });

  test("a delegation request opens its consequences, through the preview command", () => {
    const dir = harnessDir(root(), "delegate");
    proposal(dir, { delegate: "merge" });
    const [item] = inboxOf(dir).items;
    expect(item?.title).toEqual({
      template: "delegation-proposal.pending",
      params: { delegationAction: "merge" },
    });
    expect(item?.choices[0]?.cliTwin).toBe(`crewhaus delegations preview merge --harness ${HRN}`);
  });

  test("an open review entry is a review item; its excerpt reaches only a content reader", () => {
    const dir = harnessDir(root(), "review");
    const id = review(dir);
    const [item] = inboxOf(dir).items;
    expect(item?.kind).toBe("review");
    expect(item?.source).toEqual({ kind: "review", id });
    expect(item?.body).toBeUndefined();
    expect(inboxOf(dir, { content: true }).items[0]?.body).toEqual({
      excerpt: "the sample asked about refunds",
    });
  });

  test("Advisor findings map by their id's family; pending approvals are left out", () => {
    const dir = harnessDir(root(), "advised");
    const finding = (id: string, severity: AdvisorItem["severity"] = "warn"): AdvisorItem => ({
      id,
      severity,
      title: "t",
      detail: "d",
      explain: "e",
      guidance: "g",
      screen: "overview",
      source: "s",
      action: null,
      status: "open",
    });
    const snapshot = {
      at: iso(NOW - MIN),
      items: [
        finding("eval-below-baseline"),
        finding("budget-near-9-total"),
        finding("incident-2026-11-01-guard"),
        finding("spec-unreadable", "critical"),
        finding("evals-none", "suggestion"),
        finding("approvals-pending-appr_0123456789abcdef"),
      ],
    };
    const facts = testFacts({}, new Map([[dir, snapshot]]));
    const inbox = assembleInbox([foldHarness(dir, facts, NOW, { harness: HRN })], NOW);
    expect(inbox.advisorUnchecked).toEqual([]);
    expect(inbox.items.map((i) => [i.kind, i.title.template]).sort()).toEqual(
      [
        ["budget", "advisor.budget-near"],
        ["quality-regression", "advisor.quality-regressed"],
        ["security", "advisor.incident-open"],
        ["setup", "advisor.evals-none"],
        ["spec", "advisor.spec-unreadable"],
      ].sort(),
    );
    const budget = inbox.items.find((i) => i.kind === "budget");
    expect(budget?.title.params).toEqual({ percent: 90, period: "total" });
  });

  test("without a snapshot, the harness is named as not checked yet", () => {
    const dir = harnessDir(root(), "unchecked");
    expect(inboxOf(dir).advisorUnchecked).toEqual([HRN]);
  });
});
