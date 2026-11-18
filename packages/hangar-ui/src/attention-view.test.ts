/**
 * Needs you, All: Home's inbox. Three bands in order; each closed text id turns into a
 * plain sentence and an unknown one into "Something needs a look"; the deadline line
 * only for a real deadline; who may decide as words; a group's cause with its run and
 * harness counts; the command that shows the item; the screen where it is acted on; an
 * unreadable harness named; `?item=` focus; new items behind "Show N new"; and the
 * module embedded through the attention area's own embed file. DOM only by
 * `createElement` and `textContent`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTENTION_TEXT,
  BANDS,
  UNKNOWN_TEXT,
  actOn,
  bandsOf,
  cardModel,
  causeLine,
  classWord,
  deadlineLine,
  emptyOptsOf,
  listNotes,
  moveOf,
  newCount,
  showTwin,
  textOf,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/attention.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { needsYouSections } from "../assets/js/views/needs-you.js";

const VIEWS = join(import.meta.dir, "..", "assets", "js", "views");
const SOURCE = readFileSync(join(VIEWS, "attention.js"), "utf8");
const EMBED = readFileSync(join(import.meta.dir, "embed", "attention.ts"), "utf8");
const CONTRACT = readFileSync(
  join(import.meta.dir, "..", "..", "control-contract", "src", "areas", "attention.ts"),
  "utf8",
);

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const A = "hrn_000000000000000a";
const B = "hrn_000000000000000b";
const REF = `home/attention/att_${"0".repeat(26)}`;

const item = (over: Record<string, unknown> = {}) => ({
  ref: REF,
  kind: "permission",
  band: "decide",
  harness: A,
  source: { kind: "approval", id: "appr_00000000000000a1" },
  title: { template: "permission.ask", params: { tool: "SendMessage" } },
  whyNow: { template: "why.waiting", params: { runs: 1 } },
  affected: { runs: ["run_1"], count: 1 },
  evidence: [],
  choices: [],
  requiredClass: "operator",
  state: "open",
  evidenceRev: "0123456789abcdef",
  since: new Date(NOW - 3_600_000).toISOString(),
  freshness: { asOf: new Date(NOW).toISOString(), mode: "projection" },
  ...over,
});

describe("bands and texts", () => {
  test("Decide, then Fix, then Consider; a band with nothing is left out", () => {
    expect(BANDS.map((b: { label: string }) => b.label)).toEqual(["Decide", "Fix", "Consider"]);
    const shown = bandsOf([
      item({ band: "consider", ref: "c" }),
      item({ band: "decide", ref: "d" }),
      item({ band: "consider", ref: "c2" }),
    ]);
    expect(
      shown.map(
        (b: { id: string; items: { ref: string }[] }) =>
          `${b.id}:${b.items.map((i) => i.ref).join(",")}`,
      ),
    ).toEqual(["decide:d", "consider:c,c2"]);
  });

  test("every text id the contract declares has a sentence, and an unknown one says so", () => {
    const declared = [...CONTRACT.matchAll(/^\s+"([a-z-]+\.[a-z-]+)",$/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(40);
    for (const id of declared)
      expect(`${id}:${Object.hasOwn(ATTENTION_TEXT, id)}`).toBe(`${id}:true`);
    expect(textOf({ template: "permission.ask", params: { tool: "Bash" } })).toBe(
      "Permission to use Bash",
    );
    expect(textOf({ template: "no.such-text", params: {} })).toBe(UNKNOWN_TEXT);
    expect(textOf(undefined)).toBe("Something needs a look");
  });

  test("who may decide, as words", () => {
    expect(classWord("operator")).toBe("Needs an operator");
    expect(classWord("maintainer")).toBe("Needs a maintainer");
    expect(classWord("owner")).toBe("Owner only");
  });

  test("a deadline line only for a real deadline", () => {
    expect(deadlineLine(item(), NOW)).toBe("No deadline. It waits until someone decides.");
    const at = new Date(NOW + 2 * 3_600_000).toISOString();
    expect(deadlineLine(item({ deadline: { at, source: "agreement" } }), NOW)).toBe(
      "Decide by in 2h, as agreed.",
    );
    expect(deadlineLine(item({ deadline: { at, source: "ttl" } }), NOW)).toBe(
      "This request lapses in 2h.",
    );
  });

  test("a group's cause names its runs and harnesses", () => {
    const group = item({
      kind: "credential",
      band: "fix",
      harness: undefined,
      harnesses: [A, B],
      affected: { runs: [], count: 10 },
      cause: {
        id: "credential:gemini:GEMINI_API_KEY@x",
        kind: "credential",
        label: "gemini GEMINI_API_KEY",
      },
    });
    expect(causeLine(group)).toBe("Same cause: gemini GEMINI_API_KEY. 10 runs on 2 harnesses.");
    expect(causeLine(item())).toBeNull();
  });
});

describe("a card", () => {
  test("says what, why, where, since when, who decides, and the command that shows it", () => {
    const model = cardModel(item(), { names: [{ id: A, name: "release-bot" }], nowMs: NOW });
    expect(model.title).toBe("Permission to use SendMessage");
    expect(model.whyNow).toBe("A run is waiting for this.");
    expect(model.harnesses).toEqual(["release-bot"]);
    expect(model.since).toBe("Since 1h ago");
    expect(model.who).toBe("Needs an operator");
    expect(model.deadline).toBe("No deadline. It waits until someone decides.");
    expect(model.twin).toBe(`crewhaus inbox show att_${"0".repeat(26)}`);
    expect(showTwin(REF)).toBe(model.twin);
    expect(model.act).toEqual({
      label: "Decide in Approvals",
      href: "#/home/needs-you?type=approvals",
    });
  });

  test("a problem has no deadline or class line, and an unnamed harness shows its id", () => {
    const model = cardModel(item({ band: "fix", kind: "run-failures" }), { names: [], nowMs: NOW });
    expect(model.deadline).toBeNull();
    expect(model.who).toBeNull();
    expect(model.harnesses).toEqual([A]);
  });

  test("each kind links to where it is acted on today", () => {
    expect(actOn(item({ kind: "review" }))?.href).toBe("#/home/needs-you?type=review");
    expect(
      actOn(item({ kind: "setup", source: { kind: "advisor", id: "evals-none" } }))?.label,
    ).toBe("Open in Advice");
    const delegation = actOn(
      item({
        kind: "standing-rule-proposal",
        source: { kind: "decision", id: "dec_x" },
        title: { template: "delegation-proposal.pending", params: { delegationAction: "merge" } },
      }),
    );
    expect(delegation?.href).toBe(`#/h/${A}/setup/delegations/new/merge/dec_x`);
    expect(actOn(item({ kind: "credential", source: { kind: "runs", id: "x" } }))).toBeNull();
  });
});

describe("the list", () => {
  test("names a harness it could not read, says when Advisor findings are pending, and a slower view", () => {
    const notes = listNotes({
      items: [item({ freshness: { asOf: "x", mode: "direct-fold" } })],
      unreachable: [A],
      advisorUnchecked: [B],
      names: [{ id: A, name: "release-bot" }],
    });
    expect(notes).toEqual([
      "Couldn't read the requests of release-bot: its sessions folder is outside its folder.",
      "Advisor findings appear after Home has checked a harness.",
      "Updated just now (slower view while Home catches up).",
    ]);
  });

  test("an empty list says why, by Home's reason, and an unreadable one names no command", () => {
    const unreachable = emptyOptsOf({
      items: [],
      unreachable: [A],
      names: [{ id: A, name: "release-bot" }],
      empty: { reason: "unreachable" },
    });
    expect(unreachable.cause).toBe("unreachable");
    expect(unreachable.subject).toBe("the requests of release-bot");
    expect(JSON.stringify(unreachable)).not.toContain("crewhaus");
    expect(emptyOptsOf({ items: [], empty: { reason: "filtered" } }).cause).toBe("filtered");
    expect(emptyOptsOf({ items: [], empty: { reason: "no-access" } }).cause).toBe("no-access");
    expect(emptyOptsOf({ items: [], empty: { reason: "no-data" } }).cause).toBe("no-data");
  });

  test("new items are counted for the Show N new button, never drawn under focus", () => {
    expect(newCount(["a", "b"], [{ ref: "a" }, { ref: "b" }])).toBe(0);
    expect(newCount(["a"], [{ ref: "a" }, { ref: "c" }, { ref: "d" }])).toBe(2);
    expect(SOURCE).toContain("Show ${n} new");
  });

  test("j and k move only with single-key shortcuts on; the arrows always", () => {
    expect(moveOf("j", true)).toBe(1);
    expect(moveOf("k", true)).toBe(-1);
    expect(moveOf("j", false)).toBeNull();
    expect(moveOf("k", false)).toBeNull();
    expect(moveOf("ArrowDown", false)).toBe(1);
    expect(moveOf("ArrowUp", false)).toBe(-1);
    expect(moveOf("x", true)).toBeNull();
  });

  test("?item= moves focus to its card, or says it is no longer open", () => {
    expect(SOURCE).toContain("ctx.route?.query?.item");
    expect(SOURCE).toContain("That item is no longer open.");
  });

  test("All draws the inbox; a filter keeps its own screen", () => {
    expect(needsYouSections(null).map((s: { id: string }) => s.id)).toEqual(["all"]);
    expect(needsYouSections("approvals").map((s: { id: string }) => s.id)).toEqual(["approvals"]);
  });
});

describe("the module", () => {
  test("is embedded through the attention area's own embed file", () => {
    expect(EMBED).toContain('"/assets/js/views/attention.js"');
    expect(EMBED).toContain('with { type: "text" }');
  });

  test("builds DOM with createElement and textContent only, and cards a test can find", () => {
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(SOURCE.includes(banned)).toBe(false);
    }
    expect(SOURCE).toContain("inbox-card");
    expect(SOURCE).toContain('"attention-band", "aria-labelledby": bandHeading');
    expect(SOURCE).toContain('role: "status"');
  });
});
