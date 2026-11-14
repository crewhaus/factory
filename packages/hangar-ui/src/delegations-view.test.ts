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
    expect(SOURCE).toContain("DELEGATIONS_COPY.allowAgreement");
    expect(DELEGATIONS_COPY.allowAgreement).toBe("Allow in the agreement");
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
      uses: "2",
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
      uses: "2 of 5",
      buttons: ["resume", "revoke"],
    });
    expect(list(MAINTAINER, paused).rows[0]?.buttons).toEqual([]);
    expect(list(OWNER, row({ state: "expired" })).rows[0]).toMatchObject({
      word: "Ended",
      buttons: [],
    });
    // A caller the server said nothing about is offered nothing.
    expect(listModel({ items: [row()], ceiling: { present: true } }).rows[0]?.buttons).toEqual([]);
    for (const state of Object.keys(STATE_WORDS))
      expect(STATE_WORDS[state].word.length).toBeGreaterThan(2);
    expect(Object.keys(SUSPEND_WORDS)).toHaveLength(8);
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
    // The same words, now with their digest, are confirmed once more; others are shown first.
    expect(SOURCE).toContain("fresh.body.text === shown");
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
