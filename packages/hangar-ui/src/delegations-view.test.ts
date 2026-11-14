/**
 * Setup › Delegations: the three empty-or-not states, each saying why; buttons by what
 * the caller may do; the consequences page drawn from the server's sections, with Turn on
 * disabled until the harness's name is typed; a maintainer's Ask the owner; and the
 * module embedded through the delegation area's own embed file. DOM only by
 * `createElement` and `textContent`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { SETUP } from "../assets/js/sections/setup.js";
import {
  DELEGATIONS_COPY,
  STATE_WORDS,
  SUSPEND_WORDS,
  confirms,
  dateWords,
  listModel,
  pageModel,
  routeOf,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/delegations.js";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "assets", "js", "views", "delegations.js"),
  "utf8",
);
const EMBED = readFileSync(join(import.meta.dir, "embed", "delegation.ts"), "utf8");

const RULE = "rule_01m76e6f05hp514w9j4v3qymka";
const OWNER = { manage: true, propose: true, suspend: true };
const MAINTAINER = { manage: false, propose: true, suspend: true };
const VIEWER = { manage: false, propose: false, suspend: false };

const row = (over: Record<string, unknown> = {}) => ({
  id: RULE,
  action: "merge",
  state: "active",
  revision: 1,
  label: "Merges its own pull requests",
  endsAt: "2026-11-28T12:00:00.000Z",
  uses: 2,
  ...over,
});

describe("dates in words", () => {
  test("a time reads as its calendar date, and anything else as nothing", () => {
    expect(dateWords("2026-11-28T09:14:03.512Z")).toBe("28 November 2026");
    expect(dateWords("not a time")).toBeNull();
    expect(dateWords(undefined)).toBeNull();
  });
});

describe("the list", () => {
  test("no ceiling: nothing can be delegated, and the agreement is where to allow it", () => {
    const model = listModel({
      items: [],
      offers: [],
      proposals: [],
      ceiling: { present: false },
      you: OWNER,
    });
    expect(model.state).toBe("not-allowed");
    expect(model.sentence).toBe(
      "Nothing can be delegated on this harness yet. Its agreement doesn't allow it.",
    );
    // The step that fills it includes activating the build, and only an owner is offered it.
    expect(model.remedy).toBe(
      "An owner allows delegation in this harness's agreement, then activates that build.",
    );
    expect(model.allowAgreement).toBe(true);
    expect(SOURCE).toContain("DELEGATIONS_COPY.allowAgreement");
    expect(DELEGATIONS_COPY.allowAgreement).toBe("Allow in the agreement");
    for (const you of [MAINTAINER, VIEWER]) {
      const other = listModel({
        items: [],
        offers: [],
        proposals: [],
        ceiling: { present: false },
        you,
      });
      expect(other).toMatchObject({ state: "not-allowed", allowAgreement: false });
      expect(other.remedy).toContain("then activates that build");
    }
  });

  test("records that cannot be read say so, never that the agreement forbids it", () => {
    const model = listModel({
      items: [],
      offers: [],
      proposals: [],
      ceiling: { present: false },
      empty: {
        reason: "unreadable",
        remedy:
          "Whether this harness may delegate is unknown: its deployment records cannot be read (bad line).",
        verb: "crewhaus delegations list --harness hrn_1",
      },
      unreadable: ["The deployment records cannot be read: bad line"],
      truncated: { reason: "log_cap", verb: "crewhaus delegations list --harness hrn_1" },
      you: OWNER,
    });
    expect(model.state).toBe("unreadable");
    expect(model.sentence).toContain("cannot be read");
    expect(model.sentence).not.toContain("doesn't allow");
    expect(model.allowAgreement).toBe(false);
    expect(model.emptyVerb).toBe("crewhaus delegations list --harness hrn_1");
    expect(model.unreadable).toEqual(["The deployment records cannot be read: bad line"]);
    expect(model.truncated).toEqual({
      reason: "log_cap",
      verb: "crewhaus delegations list --harness hrn_1",
    });
  });

  test("a ceiling and no rules: what asks a person, and a button only for an offered kind", () => {
    const none = listModel({
      items: [],
      offers: [],
      proposals: [],
      ceiling: { present: true },
      you: OWNER,
    });
    expect(none.state).toBe("empty");
    expect(none.sentence).toBe(DELEGATIONS_COPY.noActions);
    expect(none.offers).toEqual([]);
    const some = listModel({
      items: [],
      offers: [
        {
          action: "merge",
          label: "Merges its own pull requests",
          verb: "crewhaus delegations preview merge --harness hrn_1",
        },
      ],
      proposals: [],
      ceiling: { present: true },
      you: OWNER,
    });
    expect(some.sentence).toBe(DELEGATIONS_COPY.canDelegate);
    expect(some.offers).toHaveLength(1);
    expect(some.note).toBe(
      "Rules are applied while Home is running and whenever `crewhaus delegations apply` runs. Otherwise these decisions wait for a person.",
    );
  });

  test("each rule's state is a word with its mark, and its buttons follow the caller's role", () => {
    const list = (you: unknown, item = row()) =>
      listModel({ items: [item], offers: [], proposals: [], ceiling: { present: true }, you });
    expect(list(OWNER).rows[0]).toMatchObject({
      word: "Active",
      tone: "ok",
      ends: "Ends on 28 November 2026",
      uses: "Used 2 times",
      buttons: ["pause", "change", "revoke"],
    });
    expect(list(MAINTAINER).rows[0]?.buttons).toEqual(["pause"]);
    expect(list(VIEWER).rows[0]?.buttons).toEqual([]);
    const paused = row({
      state: "suspended",
      suspendedReason: "owner-authority-changed",
      maxUses: 5,
    });
    expect(list(OWNER, paused).rows[0]).toMatchObject({
      word: "Paused: its owner is no longer an owner",
      tone: "warn",
      ends: "Ends on 28 November 2026",
      uses: "Used 2 of 5 times",
      buttons: ["resume", "revoke"],
    });
    expect(list(MAINTAINER, paused).rows[0]?.buttons).toEqual([]);
    expect(list(OWNER, row({ state: "expired" })).rows[0]).toMatchObject({
      word: "Ended",
      ends: "Ended on 28 November 2026",
      buttons: [],
    });
    expect(list(OWNER, row({ state: "revoked", uses: 0 })).rows[0]).toMatchObject({
      ends: "Was set to end on 28 November 2026",
      uses: "Not used yet",
    });
    expect(list(OWNER, row({ uses: 1 })).rows[0]?.uses).toBe("Used once");
    // No machine time in what a person reads.
    expect(JSON.stringify(list(OWNER).rows[0])).not.toContain("T12:00");
    // A caller the server said nothing about is offered nothing.
    expect(listModel({ items: [row()], ceiling: { present: true } }).rows[0]?.buttons).toEqual([]);
    for (const state of Object.keys(STATE_WORDS))
      expect(STATE_WORDS[state].word.length).toBeGreaterThan(2);
    expect(Object.keys(SUSPEND_WORDS)).toHaveLength(8);
  });
});

describe("a maintainer's request", () => {
  const PROPOSAL = {
    id: "dec_01m76e6f05hp514w9j4v3qymkb",
    action: "merge",
    days: 7,
    createdAt: "2026-11-14T09:00:00.000Z",
    expiresAt: "2026-11-21T09:00:00.000Z",
    verb: "crewhaus delegations enable merge --harness hrn_1 --days 7 --proposal dec_01m76e6f05hp514w9j4v3qymkb",
  };
  const OFFER = {
    action: "merge",
    label: "Merges its own pull requests",
    verb: "crewhaus delegations preview merge --harness hrn_1",
  };

  test("an owner sees each request with its terms; others are not shown one", () => {
    const listed = (you: unknown) =>
      listModel({
        items: [],
        offers: [OFFER],
        proposals: [PROPOSAL],
        ceiling: { present: true },
        you,
      });
    expect(listed(OWNER).proposals).toEqual([
      {
        id: PROPOSAL.id,
        action: "merge",
        label: "Merges its own pull requests",
        days: 7,
        text: "Merges its own pull requests, for 7 days. The request expires on 21 November 2026.",
        verb: PROPOSAL.verb,
      },
    ]);
    expect(listed(MAINTAINER).proposals).toEqual([]);
    expect(SOURCE).toContain("DELEGATIONS_COPY.reviewRequest");
    expect(DELEGATIONS_COPY.reviewRequest).toBe("Review request");
  });

  test("its page is the new-rule page with the request's id, and turning on answers it", () => {
    expect(routeOf(["new", "merge", PROPOSAL.id])).toEqual({
      page: "new",
      action: "merge",
      proposal: PROPOSAL.id,
    });
    expect(routeOf(["new", "merge", "dec_x"])).toEqual({ page: "unknown" });
    expect(SOURCE).toContain(
      "...(route.proposal !== undefined ? { proposal: route.proposal } : {})",
    );
    // What the maintainer is told is where the owner will see it.
    expect(DELEGATIONS_COPY.asked).toBe(
      "Sent to the owner. They'll see it under Setup › Delegations.",
    );
    expect(SOURCE).not.toContain("They decide from this page.");
  });
});

describe("the consequences page", () => {
  const PAGE = {
    action: "merge",
    title: "Let support merge its own pull requests",
    sections: [
      { id: "does", heading: "What it will do on its own", lines: ["Merge pull requests."] },
      { id: "stop", heading: "Stop", lines: ["Any maintainer can pause it."] },
    ],
    text: "…",
    consequencesDigest: "a".repeat(64),
    confirmName: "support",
    verb: "crewhaus delegations enable merge --harness hrn_1 --days 14 --confirm support",
  };

  test("drawn from the server's sections, with the exact CLI line", () => {
    const model = pageModel(PAGE, OWNER, "");
    expect(model.sections.map((s: { heading: string }) => s.heading)).toEqual([
      "What it will do on its own",
      "Stop",
    ]);
    expect(model.cli).toBe(PAGE.verb);
    expect(model.confirmLabel).toBe("Type support to confirm");
  });

  test("Turn on stays disabled until the name is typed exactly", () => {
    for (const typed of ["", "Support", "suppor", "support ", " support"]) {
      expect([typed, pageModel(PAGE, OWNER, typed).canTurnOn]).toEqual([typed, false]);
    }
    expect(pageModel(PAGE, OWNER, "support").canTurnOn).toBe(true);
    expect(confirms("support", "")).toBe(false);
  });

  test("a maintainer asks the owner; anyone else reads", () => {
    expect(pageModel(PAGE, MAINTAINER, "support")).toMatchObject({
      canConfirm: false,
      canTurnOn: false,
      canAsk: true,
      readOnly: false,
    });
    expect(pageModel(PAGE, VIEWER, "")).toMatchObject({ canAsk: false, readOnly: true });
    expect(SOURCE).toContain('text: "Ask the owner"');
  });

  test("its addresses: a new rule per action, and a rule's resume or change page", () => {
    expect(routeOf([])).toEqual({ page: "list" });
    expect(routeOf(["new", "merge"])).toEqual({ page: "new", action: "merge" });
    expect(routeOf([RULE, "resume"])).toEqual({ page: "rule", rule: RULE, mode: "resume" });
    expect(routeOf([RULE, "change"])).toEqual({ page: "rule", rule: RULE, mode: "change" });
    for (const bad of [["new", "deploy"], ["rule_x", "resume"], [RULE, "delete"], ["new"]]) {
      expect(routeOf(bad)).toEqual({ page: "unknown" });
    }
  });

  test("a changed page is drawn again from the server, keeping the typed name and focus", () => {
    expect(SOURCE).toContain("draw(DELEGATIONS_COPY.changed, true)");
    expect(SOURCE).toContain("field.value = typed;");
    expect(SOURCE).toContain("if (keepFocus) field.focus();");
    // Only a page that had no digest is confirmed again on its own, and only with the
    // same words: any other refusal waits for a fresh click on the page as it is now.
    expect(SOURCE).toContain("const hadDigest = digest !== undefined;");
    expect(SOURCE).toContain(
      "if (!hadDigest && fresh.ok && fresh.body.text === shown && digest !== undefined) {",
    );
    expect(SOURCE.match(/write\.run\(/g)).toHaveLength(2);
  });

  test("after Pause or Turn off the list is reconciled by rule and focus stays on the row", () => {
    expect(SOURCE).toContain('import { reconcile } from "../ui/keyed.js";');
    expect(SOURCE).toContain("keyOf: (row) => row.id");
    expect(SOURCE).toContain("await redraw(row.id);");
    expect(SOURCE).toContain(
      'node?.querySelector("button, a") ?? node?.querySelector("[data-row-label]") ?? parts.heading',
    );
    expect(SOURCE).toContain('el("h2", { tabindex: "-1", text: "Delegations" })');
  });
});

describe("the module", () => {
  test("labelled controls, status in words, calls by operation id, and no markup", () => {
    expect(SOURCE).toContain('el("label", { for: "delegation-confirm"');
    expect(SOURCE).toContain('el("label", { for: "delegation-days"');
    expect(SOURCE).toContain("statusBadge(row.tone, row.word)");
    for (const id of [
      "delegations.list",
      "delegations.preview",
      "delegations.enable",
      "delegations.resume",
      "delegations.update",
      "delegations.propose",
      "delegations.pause",
      "delegations.revoke",
    ]) {
      expect(SOURCE).toContain(`"${id}"`);
    }
    expect(SOURCE).not.toContain("/api/v1/");
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(SOURCE).not.toContain(banned);
    }
  });

  test("Setup lists it under Limits, after Security, and it ships through its own embed file", () => {
    const views = SETUP.views as readonly { id: string; group: string; rest?: boolean }[];
    const at = views.findIndex((v) => v.id === "delegations");
    expect(at).toBeGreaterThan(-1);
    expect(views[at - 1]?.id).toBe("security");
    expect(views[at]).toMatchObject({ group: "Limits", rest: true });
    expect(EMBED).toContain(
      'import delegationsViewJs from "../../assets/js/views/delegations.js" with { type: "text" }',
    );
    expect(EMBED).toContain('"/assets/js/views/delegations.js"');
    const home = readFileSync(join(import.meta.dir, "embed", "home.ts"), "utf8");
    expect(home).not.toContain("delegations.js");
  });
});
