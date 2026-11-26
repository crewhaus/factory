/**
 * Needs you, All: Home's inbox. Three bands in order; each closed text id turns into a
 * plain sentence and an unknown one into "Something needs a look"; the deadline line
 * only for a real deadline; who may decide as words; a group's cause with its run and
 * harness counts; the command that shows the item; the page that fixes a problem; each
 * choice with what it does, its command, and why the reader may not take it; one confirm
 * step for a verdict; the acts beside the choices; the kind filter; an unreadable harness
 * named; `?item=` focus; new items behind "Show N new"; and the modules embedded through
 * the attention area's own embed file. DOM only by `createElement` and `textContent`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { screenHref } from "../assets/js/router.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as acts from "../assets/js/views/attention-acts.js";
import {
  ATTENTION_TEXT,
  BANDS,
  KIND_WORDS,
  UNKNOWN_TEXT,
  bandsOf,
  cardMemory,
  cardModel,
  causeLine,
  classWord,
  deadlineLine,
  emptyOptsOf,
  firstNewIndex,
  kindFilter,
  kindLinks,
  listNotes,
  moveOf,
  newCount,
  nextIndex,
  placeOf,
  restoreCards,
  settledLine,
  showTwin,
  sinceLine,
  standingLines,
  textOf,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/attention.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { needsYouFilter, needsYouSections } from "../assets/js/views/needs-you.js";
const CSS = readFileSync(join(import.meta.dir, "..", "assets", "hangar.css"), "utf8");

const VIEWS = join(import.meta.dir, "..", "assets", "js", "views");
const SOURCE = readFileSync(join(VIEWS, "attention.js"), "utf8");
const ACTS = readFileSync(join(VIEWS, "attention-acts.js"), "utf8");
const EMBED = readFileSync(join(import.meta.dir, "embed", "attention.ts"), "utf8");
const CONTRACT = readFileSync(
  join(import.meta.dir, "..", "..", "control-contract", "src", "areas", "attention.ts"),
  "utf8",
);

/** The terminal's table of the same sentences, read from its source. */
const SENTENCES = readFileSync(
  join(import.meta.dir, "..", "..", "attention", "src", "sentences.ts"),
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
    expect(textOf({ template: "delegation-proposal.pending", params: {} })).toBe(
      "Letting it act on its own is proposed",
    );
    for (const params of [{}, { decisionKind: "other" }]) {
      expect(textOf({ template: "decision.pending", params })).toBe("A decision is waiting");
    }
    expect(textOf({ template: "decision.pending", params: { decisionKind: "merge" } })).toBe(
      "A merge decision is waiting",
    );
    expect(textOf({ template: "no.such-text", params: {} })).toBe(UNKNOWN_TEXT);
    expect(textOf(undefined)).toBe("Something needs a look");
  });

  test("who may decide, as words", () => {
    expect(classWord("operator")).toBe("Needs an operator");
    expect(classWord("maintainer")).toBe("Needs a maintainer");
    expect(classWord("owner")).toBe("Owner only");
  });

  test("a deadline line only for a real deadline, ahead or passed", () => {
    expect(deadlineLine(item(), NOW)).toBe("No deadline. It waits until someone decides.");
    const ahead = new Date(NOW + 2 * 3_600_000).toISOString();
    const passed = new Date(NOW - 2 * 3_600_000).toISOString();
    const line = (at: string, source: string) =>
      deadlineLine(item({ deadline: { at, source } }), NOW);
    expect(line(ahead, "agreement")).toBe("Decide within 2h (agreed deadline).");
    expect(line(passed, "agreement")).toBe("The agreed deadline passed 2h ago.");
    expect(line(ahead, "ttl")).toBe("Lapses in 2h.");
    expect(line(passed, "ttl")).toBe("Lapsed 2h ago.");
  });

  test("how long a request waited, or when a problem was first seen", () => {
    expect(sinceLine(item(), NOW)).toBe("Waiting 1h");
    expect(sinceLine(item({ band: "fix" }), NOW)).toBe("First seen 1h ago");
    expect(sinceLine(item({ since: "not a time" }), NOW)).toBe("Waiting");
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
    expect(model.since).toBe("Waiting 1h");
    expect(model.who).toBe("Needs an operator");
    expect(model.deadline).toBe("No deadline. It waits until someone decides.");
    expect(model.twin).toBe(`crewhaus inbox show att_${"0".repeat(26)}`);
    expect(showTwin(REF)).toBe(model.twin);
    // It is decided here: there is nowhere else to go.
    expect(model.place).toBeNull();
  });

  test("a problem has no deadline or class line, and an unnamed harness shows its id", () => {
    const model = cardModel(item({ band: "fix", kind: "run-failures" }), { names: [], nowMs: NOW });
    expect(model.deadline).toBeNull();
    expect(model.who).toBeNull();
    expect(model.harnesses).toEqual([A]);
  });

  test("a problem links the page that fixes it, and a question the run that asked", () => {
    expect(placeOf(item({ kind: "review" }))).toBeNull();
    expect(
      placeOf(item({ kind: "setup", source: { kind: "advisor", id: "evals-none" } }))?.label,
    ).toBe("Open in Advice");
    const run = "run_01m72n6sx0krc77t75yn3a3xgy";
    expect(placeOf(item({ kind: "question", affected: { runs: [run], count: 1 } }))).toEqual({
      label: "See the run that asked",
      href: `#/i/${A}/run/${run}`,
    });
    const credential = item({
      kind: "credential",
      band: "fix",
      source: { kind: "runs", id: "x" },
      title: { template: "credential.failing", params: { envName: "ANTHROPIC_API_KEY" } },
    });
    expect(placeOf(credential)).toEqual({
      label: "Fix the ANTHROPIC_API_KEY key",
      href: `#/h/${A}/setup/credentials`,
    });
    expect(placeOf({ ...credential, harness: undefined, harnesses: [A, B] })?.href).toBe(
      "#/connections/credentials",
    );
    expect(placeOf(item({ kind: "budget", band: "fix" }))?.href).toBe(`#/h/${A}/setup/budget`);
  });

  test("every kind gives a place to go or a choice to make", () => {
    // The contract's own rows, read from its source: every kind, its band and its choices.
    const rows = [...CONTRACT.matchAll(/\{ kind: "([a-z-]+)", band: "([a-z]+)" \}/g)].map((m) => ({
      kind: m[1] as string,
      band: m[2] as string,
    }));
    expect(rows.length).toBeGreaterThan(14);
    for (const { kind, band } of rows) {
      const choices = choiceRows()
        .filter((row) => row.kind === kind)
        .map((row) => ({ id: row.choice, needs: "operator", cliTwin: null, nullReason: "x" }));
      const m = cardModel(item({ kind, band, source: { kind: "runs", id: "x" }, choices }), {
        nowMs: NOW,
      });
      expect(`${kind}:${m.place !== null || m.choices.length > 0}`).toBe(`${kind}:true`);
    }
  });

  test("says who has it, until when it is out of the way, and how it was settled", () => {
    const ahead = new Date(NOW + 2 * 3_600_000).toISOString();
    const lines = (over: Record<string, unknown>) =>
      standingLines(item(over), { nowMs: NOW, meId: "prn_me" });
    expect(lines({})).toEqual([]);
    expect(lines({ assignee: "prn_me" })).toEqual(["With you."]);
    // Someone else is named as Home knows them, and never by their raw id.
    expect(lines({ assignee: "prn_x" })).toEqual(["With Someone else."]);
    expect(
      standingLines(item({ assignee: "prn_x" }), {
        nowMs: NOW,
        meId: "prn_me",
        people: [{ id: "prn_x", name: "Ana" }],
      }),
    ).toEqual(["With Ana."]);
    expect(
      cardModel(item({ assignee: "prn_x" }), {
        nowMs: NOW,
        people: [{ id: "prn_x", name: "Ana" }],
      }).standing,
    ).toEqual(["With Ana."]);
    expect(SOURCE).toContain("people: list.people ?? []");
    expect(lines({ deferral: { until: ahead, deadlineMoved: true } })).toEqual([
      "Put off. It is due again in 2h.",
    ]);
    expect(
      lines({
        source: { kind: "decision", id: "dec_1" },
        deferral: { until: ahead, deadlineMoved: false },
      }),
    ).toEqual(["Put off. It comes back in 2h.", "Its own deadline is unchanged."]);
    expect(lines({ snoozedUntil: ahead })).toEqual(["Hidden from you. It comes back in 2h."]);
    expect(
      lines({ previously: { how: "dismissed", at: ahead, evidenceRev: "0123456789abcdef" } }),
    ).toEqual(["It was set aside before, and happened again."]);
    const at = new Date(NOW - 3_600_000).toISOString();
    expect(settledLine(item(), NOW)).toBeNull();
    expect(settledLine(item({ state: "deferred" }), NOW)).toBeNull();
    expect(
      settledLine(item({ state: "resolved", resolution: { how: "dismissed", at } }), NOW),
    ).toBe("Set aside 1h ago.");
    expect(settledLine(item({ state: "expired" }), NOW)).toBe("It expired.");
  });
});

/** The contract's choice rows, read from its source. */
function choiceRows(): Array<{ kind: string; choice: string; does: string }> {
  return [
    ...CONTRACT.matchAll(/\{ kind: "([a-z-]+)", choice: "([a-z-]+)", does: "([a-z]+)" \}/g),
  ].map((m) => ({ kind: m[1] as string, choice: m[2] as string, does: m[3] as string }));
}

const YOU = (over: Record<string, unknown> = {}) => [
  { harness: A, act: true, class: "operator", content: true, can: [], ...over },
];

const choice = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  needs: "operator",
  cliTwin: `crewhaus inbox decide att_${"0".repeat(26)} ${id}`,
  ...over,
});

type Model = {
  id: string;
  label: string;
  does: string;
  effect: string;
  href: string | null;
  why: string | null;
  twin: string | null;
  reason: string | null;
};

describe("the choices", () => {
  const models = (over: Record<string, unknown>, you: unknown = YOU()): Model[] =>
    acts.choiceModels(item(over), you);

  test("every row the contract has is known here, does the same, and reads as the terminal does", () => {
    const rows = choiceRows();
    expect(rows.length).toBeGreaterThan(40);
    for (const { kind, choice: id, does } of rows) {
      const row = acts.choiceRow(kind, id);
      expect(`${kind}.${id}: ${row?.does}`).toBe(`${kind}.${id}: ${does}`);
      const said = new RegExp(`"${kind}\\.${id}": "((?:[^"\\\\]|\\\\.)*)"`).exec(SENTENCES)?.[1];
      expect(`${kind}.${id}: ${row?.effect}`).toBe(`${kind}.${id}: ${said}`);
    }
    expect(Object.keys(acts.CHOICES)).toHaveLength(rows.length);
    expect(acts.choiceRow("permission", "explode")).toBeNull();
    // Never from what an item says: a choice no table knows is not offered.
    expect(models({ choices: [choice("explode")] })).toEqual([]);
  });

  /** A closed list the contract declares, read from its source. */
  const contractList = (name: string): string[] => {
    const body = new RegExp(`export const ${name} = deepFreeze\\(\\[([^\\]]*)\\]`).exec(
      CONTRACT,
    )?.[1];
    return [...(body ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as string);
  };

  test("an Advisor finding opens the screen it names, with a button that says which", () => {
    const advisor = (kind: string, place?: string) =>
      models({
        kind,
        band: kind === "setup" ? "consider" : "fix",
        source: { kind: "advisor", id: "x" },
        choices: [choice("open", { cliTwin: null, ...(place !== undefined ? { place } : {}) })],
      })[0];
    const rows: Array<[string, string, string, string]> = [
      ["security", "security", "Open the incident", "Opens the incident."],
      ["spec", "spec", "Open the spec", "Opens the spec."],
      ["quality-regression", "evals", "Open the results", "Opens the results."],
      ["budget", "costs", "Open the budget", "Opens the budget."],
      ["setup", "creds", "Open where it is fixed", "Opens the place that fixes it."],
    ];
    for (const [kind, place, label, effect] of rows) {
      expect(advisor(kind, place)).toMatchObject({
        label,
        effect,
        does: "open",
        href: screenHref(A, place),
      });
    }
    expect(advisor("security", "approvals")?.href).toBe(screenHref(A, "approvals"));
    // A screen it does not name, or one no list holds, opens the suggestion in Advice, and says so.
    for (const place of [undefined, "javascript:alert(1)", "nowhere"]) {
      expect(advisor("security", place)).toMatchObject({
        label: "Open in Advice",
        effect: "Opens the suggestion in Advice.",
        href: "#/home/needs-you?type=advice",
      });
    }
    // One control goes to the place: the card adds no second link to Advice.
    const finding = item({
      kind: "security",
      band: "fix",
      source: { kind: "advisor", id: "incident-1" },
      choices: [choice("open", { place: "security" })],
    });
    expect(placeOf(finding)).toBeNull();
    expect(acts.PLACES).toEqual(contractList("ATTENTION_PLACES"));
    expect(acts.PLACES).toHaveLength(15);
  });

  test("an Advisor finding's job says what it starts, and what it spends", () => {
    const act = (job?: string) =>
      models({
        kind: "quality-regression",
        band: "fix",
        source: { kind: "advisor", id: "eval-below-baseline" },
        choices: [choice("act", job !== undefined ? { job } : {})],
      })[0];
    expect(act("optimize")).toMatchObject({
      label: "Queue an optimize run",
      effect:
        "Starts an optimize run. It uses model credits and proposes changes for you to review.",
      does: "act",
    });
    expect(act("compile")).toMatchObject({
      label: "Recompile",
      effect: "Rebuilds the bundle from the spec.",
    });
    expect(act("dream-run")?.label).toBe("Run the memory review");
    expect(act("eval")).toMatchObject({
      label: "Run the evals",
      effect: "Starts an eval run. It uses model credits.",
    });
    expect(act("doctor")?.effect).toBe(
      "Checks the harness's setup and says what it finds. It changes nothing.",
    );
    for (const job of [undefined, "rm-rf", "toString"]) {
      expect(act(job)).toMatchObject({
        label: "Start the suggested job",
        effect: "Starts the suggested job.",
      });
    }
    // Every job has its words here and in the terminal, the same words.
    const jobs = contractList("ATTENTION_JOBS");
    expect(jobs.length).toBeGreaterThan(5);
    expect(Object.keys(acts.JOB_CHOICES).sort()).toEqual([...jobs].sort());
    for (const job of jobs) {
      const key = job.includes("-") ? `"${job}"` : job;
      const said = new RegExp(`\\n  ${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(SENTENCES)?.[1];
      expect(`${job}: ${acts.JOB_CHOICES[job][1]}`).toBe(`${job}: ${said}`);
    }
    expect(acts.doneWords("act")).toBe("Queued.");
  });

  test("each is a button with what it does and its exact command, or why there is none", () => {
    const [grant, deny] = models({
      choices: [
        choice("grant"),
        choice("deny", { cliTwin: null, nullReason: "Decide it in Home." }),
      ],
    });
    expect(grant).toMatchObject({
      label: "Allow once",
      does: "decide",
      effect: "Allows this one call, and the run goes on.",
      twin: `crewhaus inbox decide att_${"0".repeat(26)} grant`,
      reason: null,
      why: null,
    });
    expect(deny).toMatchObject({ label: "Refuse", twin: null, reason: "Decide it in Home." });
  });

  test("an owner allows from now on; anyone else asks the owner to", () => {
    const choices = ["grant", "deny", "grant-always", "grant-propose"].map((id) => choice(id));
    const ids = (you: unknown) => models({ choices }, you).map((m) => m.id);
    expect(ids(YOU({ class: "owner" }))).toEqual(["grant", "deny", "grant-always"]);
    expect(ids(YOU({ class: "maintainer" }))).toEqual(["grant", "deny", "grant-propose"]);
  });

  test("what the reader may not do is disabled with why, and Home's silence leaves it to Home", () => {
    const why = (over: Record<string, unknown>, you: unknown) => models(over, you)[0]?.why;
    const one = { choices: [choice("grant")] };
    expect(why(one, YOU({ act: false, class: null }))).toBe(
      "You can read this, but not act on it.",
    );
    expect(why({ choices: [choice("grant", { needs: "maintainer" })] }, YOU())).toBe(
      "Needs a maintainer.",
    );
    expect(
      why({ choices: [choice("grant", { needs: "owner" })] }, YOU({ class: "owner" })),
    ).toBeNull();
    expect(why(one, undefined)).toBeNull();
    const promote = {
      kind: "deploy-approval",
      choices: [choice("promote", { needs: "maintainer", permission: "h.deploy" })],
    };
    expect(why(promote, YOU({ class: "maintainer" }))).toBe("You can't deploy here.");
    expect(why(promote, YOU({ class: "maintainer", can: ["h.deploy"] }))).toBeNull();
  });

  test("both budget raises go to their own place, worded apart, and only for who may raise it", () => {
    const budget = {
      kind: "budget",
      band: "fix",
      source: { kind: "runs", id: "budget:x:total" },
      choices: [
        choice("raise-spec", { cliTwin: null, permission: "h.spec.edit" }),
        choice("raise-period", { cliTwin: null, permission: "h.budget.extend" }),
        choice("wait-for-renewal"),
        choice("acknowledge"),
      ],
    };
    const may = models(budget, YOU({ can: ["h.spec.edit", "h.budget.extend"] }));
    expect(may.map((m) => [m.label, m.does, m.href])).toEqual([
      ["Raise the limit in the spec", "open", `#/h/${A}/setup/budget`],
      ["Raise this period's limit", "open", `#/h/${A}`],
      ["Wait for renewal", "act", null],
      ["Acknowledge", "act", null],
    ]);
    expect(models(budget).map((m) => m.why)).toEqual([
      "You can't edit the spec here.",
      "You can't raise the budget here.",
      null,
      null,
    ]);
  });

  test("a place to go names its object, and a choice that goes nowhere is not offered", () => {
    const run = `${A}/run/run_01m72n6sx0krc77t75yn3a3xgy`;
    const inspect = (over: Record<string, unknown>) =>
      models({
        kind: "run-failures",
        band: "fix",
        choices: [choice("inspect")],
        evidence: [{ kind: "run", ref: run, label: "run" }],
        ...over,
      })[0]?.href;
    expect(inspect({ affected: { runs: ["r"], count: 1 } })).toBe(`#/i/${run}`);
    expect(inspect({ affected: { runs: ["r", "s"], count: 2 } })).toBe(`#/h/${A}/work/runs`);
    expect(
      inspect({ affected: { runs: ["r", "s"], count: 2 }, harness: undefined, harnesses: [A, B] }),
    ).toBe("#/home/working");
    const review = models({
      kind: "standing-rule-proposal",
      source: { kind: "decision", id: "dec_x" },
      title: { template: "delegation-proposal.pending", params: { delegationAction: "merge" } },
      choices: [choice("review")],
    });
    expect(review[0]?.href).toBe(`#/h/${A}/setup/delegations/new/merge/dec_x`);
    const adopt = { kind: "quality-adoption", choices: [choice("adopt")] };
    expect(models({ ...adopt, evidence: [] })).toEqual([]);
  });

  test("a letter chooses a verdict the reader may take, and only with single-key shortcuts on", () => {
    const m = models({ choices: [choice("grant"), choice("deny")] });
    expect(acts.verdictOf("g", m, true)?.id).toBe("grant");
    expect(acts.verdictOf("d", m, true)?.id).toBe("deny");
    expect(acts.verdictOf("g", m, false)).toBeNull();
    expect(acts.verdictOf("p", m, true)).toBeNull();
    expect(acts.verdictOf("constructor", m, true)).toBeNull();
    const no = models({ choices: [choice("grant", { needs: "owner" })] });
    expect(acts.verdictOf("g", no, true)).toBeNull();
    const review = models({
      kind: "review",
      choices: ["pass", "fail", "up", "down"].map((id) => choice(id)),
    });
    expect(["p", "f", "u", "d"].map((k) => acts.verdictOf(k, review, true)?.id)).toEqual([
      "pass",
      "fail",
      "up",
      "down",
    ]);
    const pause = models({ kind: "checkpoint", choices: [choice("approve"), choice("reject")] });
    expect(["g", "d"].map((k) => acts.verdictOf(k, pause, true)?.id)).toEqual([
      "approve",
      "reject",
    ]);
  });

  test("every verdict, and every choice that starts something, asks first", () => {
    for (const { kind, choice: id, does } of choiceRows()) {
      if (does === "open") continue;
      const asks = acts.asksFirst({ id, does });
      // Setting a problem aside, or waiting for a budget, is taken up again in one press.
      const reversible = id === "acknowledge" || id === "wait-for-renewal";
      expect(`${kind}.${id}: ${asks}`).toBe(`${kind}.${id}: ${!reversible}`);
    }
  });

  test("the confirm step restates the effect; Enter confirms, a held Enter does not, Escape cancels", () => {
    expect(ACTS).toContain("title: `${model.label}: ${ctx.title}`");
    expect(ACTS).toContain("lead: model.effect");
    expect(ACTS).toContain("initialFocus: fields.length === 0 ? go : undefined");
    expect(ACTS).toContain('if (event.key === "Enter" && event.repeat) event.preventDefault();');
    expect(ACTS).toContain("openDialog({");
  });

  test("what happened is said with what is left", () => {
    expect(acts.afterWords(acts.doneWords("grant"), 3)).toBe("Allowed. 3 left.");
    expect(acts.afterWords(acts.doneWords("deny"), 1)).toBe("Refused. 1 left.");
    expect(acts.afterWords(acts.doneWords("acknowledge"), 0)).toBe(
      "Acknowledged. Nothing is left.",
    );
    for (const { choice: id, does } of choiceRows()) {
      if (does === "open") continue;
      expect(`${id}: ${acts.doneWords(id) !== "Done."}`).toBe(`${id}: true`);
    }
  });

  test("after one is acted on, focus is on the next card, the last one, or the heading", () => {
    expect(nextIndex(["b", "c"], { index: 0, ref: "a" })).toBe(0);
    expect(nextIndex(["a", "b"], { index: 0, ref: "a" })).toBe(1);
    expect(nextIndex(["a", "b"], { index: 2, ref: "c" })).toBe(1);
    expect(nextIndex(["a"], { index: 0, ref: "a" })).toBe(0);
    expect(nextIndex([], { index: 0, ref: "a" })).toBe(-1);
  });
});

describe("carrying an act out", () => {
  type Sent = { operation: string; params: Record<string, string>; body: unknown };
  function home(answers: Array<{ ok: boolean; status: number; body?: unknown; error?: unknown }>) {
    const sent: Sent[] = [];
    const made: number[] = [];
    let n = 0;
    const createAction = (
      operation: string,
      opts: { params: Record<string, string>; body: unknown },
    ) => {
      const mine = made.push(made.length) - 1;
      return {
        run: async () => {
          sent.push({ operation, ...opts });
          made[mine] = mine;
          return answers[Math.min(n++, answers.length - 1)];
        },
      };
    };
    return { sent, made, createAction };
  }

  test("a verdict names the harness, the item and what was read", async () => {
    const h = home([{ ok: true, status: 200, body: { detail: "It is queued." } }]);
    const answer = await acts.sendChoice(item(), { id: "grant" }, { harnesses: [A], deps: h });
    expect(answer).toEqual({ ok: true, detail: "It is queued." });
    expect(h.sent).toEqual([
      {
        operation: "attention.resolve",
        params: { h: A, ref: REF },
        body: { choice: "grant", expect: "0123456789abcdef" },
      },
    ]);
  });

  test("an item about several harnesses is acted on in each; the first refusal is the answer", async () => {
    const h = home([
      { ok: true, status: 200, body: {} },
      { ok: false, status: 412, error: { message: "This has changed since you read it." } },
    ]);
    const answer = await acts.sendChoice(
      item(),
      { id: "acknowledge" },
      { harnesses: [A, B], deps: h },
    );
    expect(h.sent.map((s) => s.params["h"])).toEqual([A, B]);
    expect(answer).toMatchObject({ ok: false, status: 412 });
    expect(acts.isStale(answer)).toBe(true);
    const none = await acts.sendChoice(item(), { id: "grant" }, { harnesses: [], deps: h });
    expect(none).toMatchObject({ ok: false, status: 403 });
  });

  test("trying again after Home was not reached is the same action; after an answer it is a new one", async () => {
    const h = home([
      { ok: false, status: 0, error: { message: "Home could not be reached." } },
      { ok: false, status: 409, error: { message: "Already settled." } },
      { ok: true, status: 200, body: {} },
    ]);
    const deps = { ...h, kept: new Map() };
    const send = () => acts.sendChoice(item(), { id: "grant" }, { harnesses: [A], deps });
    expect((await send()).ok).toBe(false);
    expect((await send()).ok).toBe(false);
    expect(h.made).toHaveLength(1);
    expect((await send()).ok).toBe(true);
    expect(h.made).toHaveLength(2);
  });

  test("a refusal is said in Home's words, with its command when it names one", () => {
    expect(
      acts.problemText({ message: "Nothing here can move it.", verb: "crewhaus spec pin a b c" }),
    ).toBe("Nothing here can move it. Try: crewhaus spec pin a b c");
    expect(acts.problemText(undefined)).toBe("Home could not do that.");
  });
});

describe("the acts beside the choices", () => {
  const ids = (over: Record<string, unknown>, you: unknown = YOU()): string[] =>
    acts.sideActs(item(over), you).map((a: { id: string }) => a.id);

  test("a request is given, put off or hidden; a problem is also set aside, and taken up again", () => {
    expect(ids({})).toEqual(["assign", "snooze", "defer"]);
    expect(ids({ band: "fix", kind: "run-failures" })).toEqual([
      "assign",
      "snooze",
      "defer",
      "dismiss",
    ]);
    const put = { state: "deferred", deferral: { until: "x", deadlineMoved: false } };
    expect(ids({ ...put, band: "fix" })).toContain("undefer");
    // A request whose own deadline moved stays decidable, and stays put off.
    expect(ids({ state: "deferred", deferral: { until: "x", deadlineMoved: true } })).toContain(
      "defer",
    );
    const aside = { band: "fix", state: "resolved", resolution: { how: "dismissed", at: "x" } };
    expect(ids(aside)).toEqual(["reopen"]);
    expect(ids({ ...aside, resolution: { how: "cleared", at: "x" } })).toEqual([]);
    expect(ids({ state: "resolved", resolution: { how: "decided", at: "x" } })).toEqual([]);
  });

  test("a viewer may hide it from themselves and nothing else, and is told why", () => {
    const viewer = acts.sideActs(item(), YOU({ act: false, class: null }));
    expect(viewer.map((a: { id: string; why: string | null }) => [a.id, a.why])).toEqual([
      ["assign", "You can read this, but not act on it."],
      ["snooze", null],
      ["defer", "You can read this, but not act on it."],
    ]);
    const below = acts.sideActs(item({ requiredClass: "owner" }), YOU());
    expect(below.find((a: { id: string }) => a.id === "defer")?.why).toBe("Owner only.");
  });

  test("each shows its exact command", () => {
    const att = `att_${"0".repeat(26)}`;
    const until = "2026-11-12T09:00:00.000Z";
    expect(acts.sideTwin("assign", REF, { to: "prn_1" })).toBe(
      `crewhaus inbox assign ${att} --to prn_1`,
    );
    expect(acts.sideTwin("assign", REF)).toBe(`crewhaus inbox unassign ${att}`);
    expect(acts.sideTwin("snooze", REF, { until })).toBe(
      `crewhaus inbox snooze ${att} --until ${until}`,
    );
    expect(acts.sideTwin("defer", REF, { until, reason: "scheduled" })).toBe(
      `crewhaus inbox defer ${att} --until ${until} --reason scheduled`,
    );
    expect(acts.sideTwin("dismiss", REF, { reason: "known" })).toBe(
      `crewhaus inbox dismiss ${att} --reason known`,
    );
    expect(acts.sideTwin("reopen", REF)).toBe(`crewhaus inbox reopen ${att}`);
  });

  test("the reasons are the API's own, each in words", () => {
    const listed = (name: string) =>
      [
        ...(
          new RegExp(`${name} = deepFreeze\\(\\[([^\\]]*)\\]`).exec(CONTRACT)?.[1] ?? ""
        ).matchAll(/"([a-z-]+)"/g),
      ].map((m) => m[1] as string);
    expect(acts.DISMISS_REASONS.map((r: { value: string }) => r.value).sort()).toEqual(
      listed("DISMISS_REASONS").sort(),
    );
    const core = readFileSync(
      join(import.meta.dir, "..", "..", "control-contract", "src", "areas", "core.ts"),
      "utf8",
    );
    const defer = /DEFER_REASONS = [^[]*\[([^\]]*)\]/.exec(core)?.[1] ?? "";
    expect(acts.DEFER_REASONS.map((r: { value: string }) => r.value).sort()).toEqual(
      [...defer.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as string).sort(),
    );
  });

  test("a ready time is always ahead, and a typed one only when it is", () => {
    const choices = acts.whenChoices(NOW);
    for (const { value, at } of choices) {
      if (value === "other") expect(at).toBeNull();
      else expect(`${value}: ${Date.parse(at) > NOW}`).toBe(`${value}: true`);
    }
    expect(acts.typedTime("2026-11-11T09:00:00.000Z", NOW)).toBe("2026-11-11T09:00:00.000Z");
    expect(acts.typedTime("2026-11-09T09:00:00.000Z", NOW)).toBeNull();
    expect(acts.typedTime("", NOW)).toBeNull();
  });

  test("an item is given to oneself, or to a member the reader may see", async () => {
    const asked: string[] = [];
    const call = async (id: string) => {
      asked.push(id);
      return {
        ok: true,
        body: {
          items: [
            { id: "prn_me", kind: "member", displayName: "Me" },
            { id: "prn_o", kind: "member", displayName: "Olly" },
            { id: "prn_s", kind: "service", displayName: "robot" },
          ],
        },
      };
    };
    expect(await acts.assignees({ id: "prn_me", can: {} }, { call })).toEqual([
      { value: "prn_me", label: "Me" },
    ]);
    expect(asked).toEqual([]);
    expect(
      await acts.assignees({ id: "prn_me", can: { "home.access.manage": true } }, { call }),
    ).toEqual([
      { value: "prn_me", label: "Me" },
      { value: "prn_o", label: "Olly" },
    ]);
    expect(await acts.assignees(null, { call })).toEqual([]);
  });

  test("a message has some text, at most 8 KiB of it", () => {
    expect(acts.messageProblem("  ")).toBe("Write something first.");
    expect(acts.messageProblem("x".repeat(8 * 1024))).toBeNull();
    expect(acts.messageProblem("é".repeat(5 * 1024))).toBe("A message holds at most 8 KiB.");
    expect(acts.messageHead({ by: "prn_me" }, { meId: "prn_me", ago: "2h ago" })).toBe(
      "You · 2h ago",
    );
    expect(acts.messageHead({ by: `local:#${"a".repeat(64)}` }, { ago: "" })).toContain(
      "Someone at this computer",
    );
    // Another member reads as their name, or as "Someone else": never as their id.
    const people = [{ id: "prn_ana", name: "Ana" }];
    expect(acts.messageHead({ by: "prn_ana" }, { meId: "prn_me", people, ago: "1m ago" })).toBe(
      "Ana · 1m ago",
    );
    expect(acts.messageHead({ by: "prn_bo" }, { meId: "prn_me", people, ago: "1m ago" })).toBe(
      "Someone else · 1m ago",
    );
    expect(ACTS).toContain('title: typeof message.by === "string" ? message.by : null');
  });
});

describe("the kind filter", () => {
  test("every kind the contract has is named", () => {
    const kinds = [...CONTRACT.matchAll(/\{ kind: "([a-z-]+)", band: "[a-z]+" \}/g)].map(
      (m) => m[1],
    );
    expect(Object.keys(KIND_WORDS).sort()).toEqual((kinds as string[]).sort());
  });

  test("?kind= shows one kind, and the old ?type= addresses show theirs", () => {
    const route = (query: Record<string, string>) => ({ view: "home", sub: "needs-you", query });
    expect(kindFilter(route({}))).toBeNull();
    expect(kindFilter(route({ kind: "permission" }))).toBe("permission");
    expect(kindFilter(route({ kind: "__proto__" }))).toBeNull();
    expect(kindFilter(route({ type: "approvals" }))).toBe("permission");
    expect(kindFilter(route({ type: "review" }))).toBe("review");
    expect(kindFilter(route({ kind: "permission", type: "review" }))).toBe("permission");
    expect(needsYouFilter(route({ type: "approvals" }))).toBeNull();
    expect(needsYouFilter(route({ type: "advice" }))).toBe("advice");
  });

  test("links each kind the list holds, with its count, and keeps the one shown", () => {
    const links = kindLinks([item(), item({ kind: "review" }), item()], "budget");
    expect(links.map((l: { label: string; current: boolean }) => [l.label, l.current])).toEqual([
      ["All (3)", false],
      ["Permissions (2)", false],
      ["Reviews (1)", false],
      ["Budget (0)", true],
    ]);
    expect(links[1].href).toBe("#/home/needs-you?kind=permission");
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

  test("after Show N new, focus goes to the first card that was not shown", () => {
    expect(firstNewIndex(["a", "b"], ["c", "a", "b"])).toBe(0);
    expect(firstNewIndex(["a", "b"], ["a", "d", "b"])).toBe(1);
    expect(firstNewIndex(["a", "b"], ["a", "b"])).toBe(-1);
    expect(SOURCE).toContain("redraw({ restore: { shownRefs } })");
    expect(SOURCE).toContain("announce(added > 0 ? `Showing ${added} new`");
  });

  /** A card as the list draws it, with just what a redraw keeps: its disclosures and draft. */
  function fakeCard(ref: string, opts: { body?: boolean } = {}) {
    const body = opts.body === true ? { open: false } : null;
    const thread = { open: false };
    const text = { value: "" };
    const parts: Record<string, unknown> = {
      "details.attention-body": body,
      "details.attention-thread": thread,
      ".attention-discuss textarea": text,
    };
    return {
      body,
      thread,
      text,
      getAttribute: (name: string) => (name === "data-ref" ? ref : null),
      querySelector: (selector: string) => parts[selector] ?? null,
    };
  }
  const listOf = (cards: unknown[]) => ({
    querySelectorAll: (selector: string) => (selector === ".attention-card" ? cards : []),
  });

  test("deciding one card leaves another's open discussion open, with what was typed in it", () => {
    const a = fakeCard("home/attention/a", { body: true });
    const b = fakeCard("home/attention/b", { body: true });
    b.thread.open = true;
    b.text.value = "Let's wait for the release notes.";
    const memory = cardMemory(listOf([a, b]));
    // A is decided: the list is drawn again from fresh cards, and A is gone.
    const fresh = fakeCard("home/attention/b", { body: true });
    restoreCards([fresh], memory);
    expect(fresh.thread.open).toBe(true);
    // The card's first disclosure is what the harness sent: it stays as it was.
    expect(fresh.body?.open).toBe(false);
    expect(fresh.text.value).toBe("Let's wait for the release notes.");
    // What was open on what the harness sent is kept the same way, on its own.
    const shown = fakeCard("home/attention/c", { body: true });
    if (shown.body !== null) shown.body.open = true;
    const kept = cardMemory(listOf([shown]));
    const again = fakeCard("home/attention/c", { body: true });
    restoreCards([again], kept);
    expect(again.body?.open).toBe(true);
    expect(again.thread.open).toBe(false);
    // A card nobody touched is remembered as nothing.
    expect(cardMemory(listOf([fakeCard("home/attention/d")])).size).toBe(0);
  });

  test("every redraw keeps the cards' disclosures and drafts: after an act, Show settled and Show N new alike", () => {
    const draw = SOURCE.slice(SOURCE.indexOf("async function drawInbox"));
    const kept = draw.indexOf("const memory = cardMemory(frame.body);");
    const cleared = draw.indexOf("clear(frame.body);");
    const put = draw.indexOf("restoreCards(drawn.roving.rows(), memory);");
    expect(kept).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(-1);
    expect(kept).toBeLessThan(cleared);
    expect(put).toBeGreaterThan(draw.indexOf("frame.body.appendChild(drawn.region);"));
  });

  test("what a harness sent wraps inside its card", () => {
    const rule = /\.attention-body pre \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(rule).toContain("white-space: pre-wrap");
    expect(rule).toContain("overflow-wrap: anywhere");
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

  test("All draws the inbox; Advice keeps its own screen", () => {
    expect(needsYouSections(null).map((s: { id: string }) => s.id)).toEqual(["all"]);
    expect(needsYouSections("advice").map((s: { id: string }) => s.id)).toEqual(["advice"]);
  });
});

describe("the module", () => {
  test("is embedded through the attention area's own embed file", () => {
    expect(EMBED).toContain('"/assets/js/views/attention.js"');
    expect(EMBED).toContain('"/assets/js/views/attention-acts.js"');
    expect(EMBED).toContain('with { type: "text" }');
  });

  test("builds DOM with createElement and textContent only, and cards a test can find", () => {
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(`${banned}: ${SOURCE.includes(banned) || ACTS.includes(banned)}`).toBe(
        `${banned}: false`,
      );
    }
    expect(SOURCE).toContain("inbox-card");
    expect(SOURCE).toContain('"attention-band", "aria-labelledby": bandHeading');
    expect(SOURCE).toContain('role: "status"');
    // "Show settled" is built once, so a redraw never drops its focus.
    expect(SOURCE).toContain("view.frame ??= buildFrame(host, redraw);");
  });
});
