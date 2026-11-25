/**
 * Work › Work items: the feed's groups and every empty state (its cause and the verb that
 * fills it), Proposed split by why it matters, a status word for every status (never
 * colour alone), the item page's sections with evidence labelled in words, the actions
 * each state allows for a caller who may take them, "Move above…" as a form with its three
 * scopes, and the module embedded through the runtime area's own file. DOM only by
 * `createElement` and `textContent`; only operations the contract declares are called.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as router from "../assets/js/router.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { CAPTURE_TOKENS } from "../assets/js/sections/index.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { WORK } from "../assets/js/sections/work.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { emptyModel } from "../assets/js/ui/empty.js";
import {
  BASIS_HEADINGS,
  DECLINE_CHOICES,
  EVIDENCE_WORDS,
  GROUPS,
  RANK_LABEL_MAX,
  SCOPE_CHOICES,
  STATUS_TONES,
  WORK_COPY,
  actionsFor,
  causeOf,
  declineTwin,
  editTwin,
  feedModel,
  itemModel,
  rankControlModel,
  rankTwin,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/work.js";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "assets", "js", "views", "work.js"),
  "utf8",
);
const EMBED = readFileSync(join(import.meta.dir, "embed", "runtime.ts"), "utf8");
const CONTRACT = join(import.meta.dir, "..", "..", "control-contract", "src");

const HRN = "hrn_0123456789abcdef";
const WI = "wi_01m76e6f05hp514w9j4v3qymka";
const OTHER = "wi_01m76e6f05hp514w9j4v3qymkb";

const item = (over: Record<string, unknown> = {}) => ({
  id: WI,
  state: "open",
  status: "up-next",
  statusWord: "Up next",
  title: "Fix the date parser",
  kind: "fix",
  rev: 1,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:00.000Z",
  runs: [],
  ...over,
});

const entry = (over: Record<string, unknown> = {}) => {
  const view = item(over);
  return {
    kind: "item",
    id: view.id,
    label: view.title,
    status: view.status,
    statusWord: view.statusWord,
    item: view,
  };
};

const empty = (reason: string, remedy = "Why.", verb: string | null = null) => ({
  empty: { reason, remedy, verb },
});

describe("the feed", () => {
  test("groups in order, each row a word, a mark and a link; Proposed split by why it matters", () => {
    const model = feedModel(
      {
        freshness: "direct-fold",
        sections: {
          needsYou: {
            items: [
              entry({
                state: "proposed",
                status: "proposed",
                statusWord: "Proposed",
                basis: "user-pain",
              }),
            ],
          },
          workingNow: {
            items: [
              {
                kind: "runs",
                id: "trigger:channel",
                label: "Conversations",
                count: 2,
                statusWord: "Working",
              },
            ],
          },
          upNext: {
            items: [entry({ id: OTHER, corrected: { scope: "item", by: "local:#x", at: "2026" } })],
          },
          proposed: {
            items: [
              entry({
                state: "proposed",
                status: "proposed",
                statusWord: "Proposed",
                basis: "user-pain",
              }),
            ],
            groups: [{ basis: "user-pain", items: [WI] }],
          },
          goals: {
            items: [
              {
                kind: "goal",
                id: "goal-0001",
                label: "Reduce open bugs",
                progress: { current: 4, target: 10 },
              },
            ],
          },
          fromThredz: {
            items: [{ kind: "task", id: "task-1", label: "Triage the March reports" }],
          },
        },
      },
      HRN,
    );
    expect(model.groups.map((g: { heading: string }) => g.heading)).toEqual([
      "Needs you",
      "Working now",
      "Up next",
      "Proposed",
      "Goals",
      "From Thredz",
    ]);
    const [needs, working, upNext, proposed, goals, thredz] = model.groups;
    expect(needs.parts[0].rows[0]).toMatchObject({
      word: "Proposed",
      tone: "info",
      href: `#/h/${HRN}/work/items/${WI}`,
      primary: { label: "Review" },
    });
    expect(working.parts[0].rows[0]).toMatchObject({ label: "Conversations", detail: "2 runs" });
    expect(upNext.parts[0].rows[0].detail).toBe("Placed by a person");
    expect(proposed.parts.map((p: { heading: string }) => p.heading)).toEqual([
      "People ran into this",
    ]);
    expect(goals.parts[0].rows[0]).toMatchObject({
      detail: "4 of 10",
      primary: {
        op: "work.adopt",
        twin: `crewhaus work adopt --from continuity-goal:goal-0001 --harness ${HRN}`,
      },
    });
    // Home reads Thredz; the CLI cannot, so the row shows no twin rather than a made-up one.
    expect(thredz.parts[0].rows[0].primary).toMatchObject({ op: "work.adopt", twin: null });
  });

  test("every empty state says why and what fills it, and only useful ones are shown", () => {
    const model = feedModel(
      {
        sections: {
          needsYou: empty("no-data"),
          upNext: empty(
            "no-data",
            "Nothing to do yet. Add work, or let the harness propose some.",
            "crewhaus work add --title <title>",
          ),
          proposed: empty(
            "unsupported",
            "This harness doesn't keep a work list. Turn on the Work tools in Setup.",
          ),
          scheduled: empty("no-data", "No scheduled work."),
          goals: empty("no-access", WORK_COPY.noContent),
          fromThredz: empty(
            "unreachable",
            "Couldn't reach Thredz. Nothing is shown rather than old data.",
          ),
          delivered: empty("filtered", "No items match this filter."),
        },
      },
      HRN,
    );
    const shown = Object.fromEntries(
      model.groups.map((g: { id: string; empty: Record<string, unknown> }) => [g.id, g.empty]),
    );
    expect(Object.keys(shown).sort()).toEqual([
      "delivered",
      "fromThredz",
      "goals",
      "proposed",
      "upNext",
    ]);
    expect(shown["upNext"]).toMatchObject({
      cause: "no-data",
      verb: "crewhaus work add --title <title>",
    });
    expect(shown["proposed"]).toMatchObject({ cause: "unsupported" });
    expect(shown["goals"]).toMatchObject({ cause: "no-access" });
    expect(shown["fromThredz"]).toMatchObject({
      cause: "connection-failed",
      action: "Try again",
      retry: true,
    });
    expect(shown["delivered"]).toMatchObject({ cause: "filtered" });
    for (const [wire, ui] of [
      ["no-data", "no-data"],
      ["no-access", "no-access"],
      ["unreachable", "connection-failed"],
      ["unsupported", "unsupported"],
      ["filtered", "filtered"],
    ]) {
      expect(causeOf(wire)).toBe(ui);
    }
    // A read that failed is not a service that did not answer.
    expect(causeOf("unreachable", "goals")).toBe("unreachable");
    // Thredz not connected names the command that connects it.
    const thredz = feedModel(
      {
        sections: {
          fromThredz: empty(
            "unsupported",
            "Connect Thredz to see its tasks here.",
            "crewhaus services setup",
          ),
        },
      },
      HRN,
    );
    expect(thredz.groups[0].empty).toMatchObject({
      cause: "unsupported",
      verb: "crewhaus services setup",
    });
  });

  test('the drawn words name their subject: Thredz, or goals, never "it"', () => {
    const model = feedModel(
      {
        sections: {
          fromThredz: empty("unsupported", "Connect Thredz to see its tasks here."),
          goals: empty("unreachable", "The harness's goals could not be read."),
        },
      },
      HRN,
    );
    const drawn = Object.fromEntries(
      model.groups.map((g: { id: string; empty: Record<string, unknown> }) => [
        g.id,
        emptyModel(g.empty),
      ]),
    );
    expect(drawn["fromThredz"].message).toBe("Not available for this harness: Thredz.");
    expect(drawn["goals"]).toMatchObject({ cause: "unreachable", action: null });
    expect(drawn["goals"].message).toBe("Couldn't read goals.");
    const down = feedModel({ sections: { fromThredz: empty("unreachable", "Try later.") } }, HRN);
    expect(emptyModel(down.groups[0].empty).message).toBe("Can't reach Thredz right now.");
    for (const g of [...model.groups, ...down.groups]) {
      expect(emptyModel(g.empty).message).not.toContain(" it");
    }
  });

  test("a status word and a mark for every status the server sends", () => {
    const statuses = readFileSync(join(CONTRACT, "areas", "runtime-work.ts"), "utf8")
      .split("export const WORK_STATUSES")[1]
      ?.split("] as const")[0];
    const listed = [...(statuses ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(15);
    expect(Object.keys(STATUS_TONES).sort()).toEqual([...listed].sort());
  });
});

describe("the item page", () => {
  test("what's asked, done when, and why, with evidence labelled in words and usage unknown never shown as demand", () => {
    const model = itemModel({
      item: item({
        state: "proposed",
        status: "proposed",
        statusWord: "Proposed",
        basis: "user-pain",
        priority: 2,
      }),
      content: {
        goal: "Keep dates as dates.",
        acceptance: ["The import test passes."],
        assessment: {
          problem: "Dates import as text.",
          evidence: [
            {
              label: "reported",
              kind: "user-report",
              ref: "ticket-12",
              note: "Two people.",
              observedAt: "2026-11-01T00:00:00Z",
            },
            { label: "hypothesis", kind: "simulated", note: "A simulated reaction." },
          ],
          counterEvidence: [],
          doNothing: "People keep fixing it by hand.",
          cost: 1,
        },
      },
      history: [
        { at: "2026-11-18T09:00:00.000Z", event: "opened", by: "sys:runtime", via: "tool" },
      ],
    });
    expect(model).toMatchObject({ word: "Proposed", tone: "info", goal: "Keep dates as dates." });
    expect(model.facts).toEqual(["Fix", "Priority 2", "People ran into this"]);
    expect(model.why.evidence).toEqual([
      "reported (2026-11-01): Two people. — ticket-12",
      "hypothesis — not observed: A simulated reaction.",
    ]);
    expect(model.why.doNothing).toBe("People keep fixing it by hand.");
    expect(model.why.levels).toEqual(["Cost: low"]);
    expect(model.history[0]).toContain("Opened");
    expect(model.history[0]).toContain("by the harness");
    const unknown = itemModel({
      item: item(),
      content: { assessment: { problem: "x", evidence: [], counterEvidence: [] } },
      history: [],
    });
    expect(unknown.why.evidence).toEqual(["Usage unknown"]);
    expect(EVIDENCE_WORDS.hypothesis).toBe("hypothesis — not observed");
    const hidden = itemModel({ item: item(), hidden: ["content"], history: [] });
    expect(hidden).toMatchObject({ hidden: true, goal: null, why: null });
  });

  test("actions by state and by what the caller may do, each with its CLI twin", () => {
    const all = { "h.run.submit": true, "h.control": true };
    const ids = (state: string, can: Record<string, boolean>) =>
      actionsFor(item({ state }), can, HRN).map((a: { id: string }) => a.id);
    expect(ids("proposed", all)).toEqual(["accept", "decline", "edit"]);
    expect(ids("open", all)).toEqual(["start", "cancel", "edit"]);
    expect(ids("closed", all)).toEqual(["reopen"]);
    expect(ids("open", { "h.run.submit": true })).toEqual(["start", "edit"]);
    expect(ids("proposed", {})).toEqual([]);
    const twins = Object.fromEntries(
      actionsFor(item({ state: "proposed" }), all, HRN).map((a: { id: string; twin: string }) => [
        a.id,
        a.twin,
      ]),
    );
    expect(twins["accept"]).toBe(`crewhaus work accept ${WI} --harness ${HRN}`);
    expect(twins["decline"]).toBe(
      `crewhaus work decline ${WI} --reason out-of-scope --harness ${HRN}`,
    );
    expect(twins["edit"]).toBe(
      `crewhaus work edit ${WI} --expect 1 --note <text> --harness ${HRN}`,
    );
    // The twins follow the page: the revision it shows, and what the person picks.
    const at3 = actionsFor(item({ state: "open", rev: 3 }), all, HRN).find(
      (a: { id: string }) => a.id === "edit",
    );
    expect(at3.twin).toBe(editTwin(WI, 3, HRN));
    expect(at3.twin).toContain("--expect 3 --note <text>");
    expect(declineTwin(WI, "not-now", HRN)).toBe(
      `crewhaus work decline ${WI} --reason not-now --harness ${HRN}`,
    );
    expect(DECLINE_CHOICES.map((c: { value: string }) => c.value)).toEqual([
      "out-of-scope",
      "duplicate",
      "not-now",
      "wont-fix",
      "needs-evidence",
      "other",
    ]);
  });

  test("Move above… is a form with three scopes over the items of the same state", () => {
    const model = rankControlModel(
      item(),
      [
        item(),
        item({ id: OTHER, title: "Update the parser" }),
        item({ id: "wi_x", state: "proposed" }),
      ],
      HRN,
    );
    expect(model).toMatchObject({ available: true, label: "Move above…" });
    expect(model.options).toEqual([
      { value: OTHER, label: "Update the parser", title: "Update the parser" },
    ]);
    expect(SCOPE_CHOICES.map((s: { value: string }) => s.value)).toEqual([
      "item",
      "similar",
      "all",
    ]);
    expect(model.twin).toBe(
      `crewhaus work rank ${WI} --above ${OTHER} --scope item --harness ${HRN}`,
    );
    expect(rankTwin(WI, OTHER, "all", HRN)).toBe(
      `crewhaus work rank ${WI} --above ${OTHER} --scope all --harness ${HRN}`,
    );
    // A long title is cut in the choice, whole in its tooltip.
    const long = `${"Make the import keep every column ".repeat(6)}https://example.com/a/b`;
    const cut = rankControlModel(item(), [item({ id: OTHER, title: long })], HRN).options[0];
    expect([...cut.label].length).toBe(RANK_LABEL_MAX);
    expect(cut.label.endsWith("…")).toBe(true);
    expect(cut.title).toBe(long);
    expect(
      rankControlModel(item({ state: "closed" }), [item({ id: OTHER, state: "closed" })], HRN)
        .available,
    ).toBe(false);
  });
});

describe("the module", () => {
  test("Work lists it, its address takes an item, and it ships through the runtime area's embed file", () => {
    const views = WORK.views as readonly { id: string; capture?: string[]; deep?: boolean }[];
    expect(views.find((v) => v.id === "items")).toMatchObject({
      capture: ["workItem"],
      deep: true,
    });
    expect(CAPTURE_TOKENS.workItem).toBe(":wi");
    const route = router.parseRoute(`#/h/x/work/items/${WI}`);
    expect(route).toMatchObject({ view: "harness", section: "work", sub: "items", workItem: WI });
    expect(EMBED).toContain(
      'import workViewJs from "../../assets/js/views/work.js" with { type: "text" }',
    );
    expect(EMBED).toContain('"/assets/js/views/work.js"');
  });

  test("DOM by createElement and textContent only, and only operations the contract declares", () => {
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(SOURCE).not.toContain(banned);
    }
    expect(SOURCE).not.toContain("/api/v1/");
    const declared = new Set(
      [
        readFileSync(join(CONTRACT, "areas", "runtime-work.ts"), "utf8"),
        readFileSync(join(CONTRACT, "areas", "runtime-workspace.ts"), "utf8"),
        readFileSync(join(CONTRACT, "operations", "meta.ts"), "utf8"),
      ].flatMap((text) => [...text.matchAll(/id: "([a-z]+(?:\.[a-zA-Z]+)+)"/g)].map((m) => m[1])),
    );
    const called = [...SOURCE.matchAll(/(?:call|createAction)\("([a-z.A-Z]+)"/g)].map((m) => m[1]);
    const ops = [...SOURCE.matchAll(/op: "([a-z.A-Z]+)"/g)].map((m) => m[1]);
    expect(called.length + ops.length).toBeGreaterThan(5);
    for (const id of [...called, ...ops]) expect(`${id}: ${declared.has(id)}`).toBe(`${id}: true`);
  });

  test("the first view's words carry no package names, keys or shapes", () => {
    const words = JSON.stringify([
      WORK_COPY,
      GROUPS,
      BASIS_HEADINGS,
      DECLINE_CHOICES,
      SCOPE_CHOICES,
    ]);
    for (const jargon of ["@crewhaus", "tool_config", "yaml", "wi_", "work.", "jsonl"]) {
      expect(`${jargon}: ${words.includes(jargon)}`).toBe(`${jargon}: false`);
    }
  });
});
