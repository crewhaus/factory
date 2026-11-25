/**
 * Needs you, All: one list of everything waiting on a person across the
 * harnesses you can see, read from Home's inbox (`attention.list`). Three
 * labelled bands, Decide, Fix and Consider, newest first within each; a card
 * per item says what it is, why now, which harness, since when, the deadline
 * only when there is a real one, who may decide, and the command that shows it
 * (`crewhaus inbox show <id>`), and each choice with its own command or why
 * there is none. Acting stays on the screens the filters open (Approvals,
 * Review, Advice) and on the harness page that fixes a problem: each card
 * links there.
 *
 * Reading never moves anything under you: the list is fetched again now and
 * then, and new items wait behind "Show N new", which keeps what was open and
 * moves focus to the first new card. `j`/`k` (and the arrows) move
 * between cards only while focus is inside the list, and the letters follow
 * the "Single-key shortcuts" setting. `?item=<id>` moves focus to that card,
 * or says it is no longer open.
 *
 * The decisions are pure functions this package tests without a browser; the
 * DOM is built with `createElement` and `textContent` only.
 */

import { clear, el } from "../dom.js";
import { readPrefs } from "../prefs.js";
import { hrefFleet, hrefHarness } from "../router.js";
import { emptyFor } from "../ui/empty.js";
import { rovingList } from "../ui/listbox.js";
import { announce } from "../ui/live.js";
import { parseTs } from "../util.js";
import { call } from "../v1.js";

/** The bands, in the order they are shown. */
export const BANDS = Object.freeze([
  Object.freeze({ id: "decide", label: "Decide" }),
  Object.freeze({ id: "fix", label: "Fix" }),
  Object.freeze({ id: "consider", label: "Consider" }),
]);

const s = (n) => (Number(n) === 1 ? "" : "s");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const word = (value, fallback) => (typeof value === "string" && value !== "" ? value : fallback);

/**
 * Every closed text id an item may carry → its sentence. A param is an id, a
 * name or a count, never a person's words. An id this console does not know
 * reads "Something needs a look".
 */
export const ATTENTION_TEXT = Object.freeze({
  "permission.ask": (p) => `Permission to use ${word(p.tool, "a tool")}`,
  "question.ask": (p) => `A question, asked while using ${word(p.tool, "a tool")}`,
  "review.open": () => "An answer needs review",
  "standing-rule-proposal.pending": () => "A standing permission is proposed",
  "delegation-proposal.pending": (p) =>
    `Letting it ${word(p.delegationAction, "act")} on its own is proposed`,
  "quality-adoption.pending": () => "A change is ready to adopt",
  "decision.pending": (p) => {
    const kind = word(p.decisionKind, "other");
    return kind === "other" ? "A decision is waiting" : `A ${kind} decision is waiting`;
  },
  "credential.failing": (p) =>
    `Runs can't sign in to ${word(p.provider, "the model provider")} (${word(p.envName, "its key")})`,
  "provider-limit.hit": (p) => `${word(p.provider, "The model provider")} is limiting requests`,
  "budget.exhausted": () => "Runs stopped at the budget",
  "spec.failing": () => "Runs fail on the spec",
  "deployment.failing": () => "A deployment keeps failing",
  "run-failures.message": (p) => `Runs fail the same way (${word(p.class, "unknown")})`,
  "run-failures.class": (p) => `Runs fail: ${word(p.class, "unknown")}`,
  "advisor.spec-unreadable": () => "The spec can't be read",
  "advisor.preflight-blocked": (p) => `A start check fails: ${word(p.check, "a check")}`,
  "advisor.crash-looping": () => "It keeps crashing",
  "advisor.parked": () => "It stopped and is waiting",
  "advisor.terminal": () => "It stopped and won't restart",
  "advisor.quality-regressed": () => "Quality dropped below the baseline",
  "advisor.incident-open": (p) => `An incident is open: ${word(p.incident, "unnamed")}`,
  "advisor.dream-overdue": (p) => `A memory review is overdue: ${word(p.spec, "this harness")}`,
  "advisor.budget-exceeded": () => "Spending is over the budget",
  "advisor.budget-near": (p) =>
    `Spending is at ${word(String(p.percent ?? ""), "most")}% of the budget`,
  "advisor.budget-absent": () => "No budget is set",
  "advisor.spec-issue": () => "The spec has an issue",
  "advisor.evals-none": () => "No eval has run yet",
  "advisor.evals-no-baseline": () => "No baseline is pinned for evals",
  "advisor.advice-waiting": () => "Suggestions are waiting",
  "advisor.policy-flip-ready": () => "Model routing has enough data to learn",
  "advisor.candidate-underperforming": () => "A model choice is doing worse",
  "advisor.audition-ready": () => "A model trial is ready",
  "advisor.escalation-rate-high": () => "Many turns move to a stronger model",
  "advisor.judge-spend-dominates": () => "Grading costs more than the work",
  "advisor.model-retiring": (p) => `A model is retiring: ${word(p.model, "one in use")}`,
  "advisor.pin-not-served": (p) =>
    `A pinned version isn't running in ${word(p.environment, "an environment")}`,
  "advisor.other": () => "The Advisor has a suggestion",
  "why.waiting": (p) =>
    Number(p.runs) > 1 ? `${p.runs} runs are waiting for this.` : "A run is waiting for this.",
  "why.asked-again": () => "This was asked before.",
  "why.runs-failed": (p) => `${p.runs ?? "Some"} run${s(p.runs)} failed this way.`,
  "why.review-open": () => "An answer was set aside for a person to check.",
  "why.decision-open": () => "It waits until someone decides.",
  "why.advisor-critical": () => "The harness can't do its job until this is fixed.",
  "why.advisor-warn": () => "The harness is at risk.",
  "why.advisor-suggestion": () => "It would run better.",
  "recommend.refused-before": () => "Refused before: the same request was refused recently.",
  "if-unanswered.continue-independent": () => "If no one answers, it carries on with other work.",
  "if-unanswered.defer": () => "If no one answers, it is put off.",
  "if-unanswered.pause-lane": () => "If no one answers, this line of work pauses.",
  "if-unanswered.deny": () => "If no one answers, it is refused.",
  "if-unanswered.waits": () => "If no one answers, it waits.",
  "if-unanswered.expires": () => "If no one answers, it expires.",
});

/** The fallback for a text id this console does not know. */
export const UNKNOWN_TEXT = "Something needs a look";

/** A closed text and its params → a sentence. Pure. */
export function textOf(text) {
  const id = typeof text?.template === "string" ? text.template : "";
  const params = text?.params && typeof text.params === "object" ? text.params : {};
  const build = Object.hasOwn(ATTENTION_TEXT, id) ? ATTENTION_TEXT[id] : null;
  return build === null ? UNKNOWN_TEXT : build(params);
}

/** Who may decide, as words. Pure. */
export function classWord(requiredClass) {
  if (requiredClass === "owner") return "Owner only";
  if (requiredClass === "maintainer") return "Needs a maintainer";
  return "Needs an operator";
}

/**
 * How far a time is from now, as a span ("2h"), and whether it is still ahead.
 * `null` for a time that does not parse. Pure.
 */
export function spanOf(at, nowMs) {
  const ts = typeof at === "number" ? at : parseTs(at);
  if (ts === null) return null;
  const diff = ts - nowMs;
  const abs = Math.abs(diff);
  const label =
    abs < HOUR_MS
      ? `${Math.max(1, Math.round(abs / MINUTE_MS))}m`
      : abs < 24 * HOUR_MS
        ? `${Math.round(abs / HOUR_MS)}h`
        : `${Math.round(abs / (24 * HOUR_MS))}d`;
  return { label, ahead: diff > 0 };
}

/** The deadline line: a real deadline only, else that it waits. Pure. */
export function deadlineLine(item, nowMs) {
  const at = item?.deadline?.at;
  if (typeof at !== "string") return "No deadline. It waits until someone decides.";
  const span = spanOf(at, nowMs);
  const agreed = item.deadline.source === "agreement";
  if (span === null) return agreed ? "It has an agreed deadline." : "It lapses after a while.";
  if (agreed) {
    return span.ahead
      ? `Decide within ${span.label} (agreed deadline).`
      : `The agreed deadline passed ${span.label} ago.`;
  }
  return span.ahead ? `Lapses in ${span.label}.` : `Lapsed ${span.label} ago.`;
}

/** How long an item has waited (a request) or since it was first seen (a problem). Pure. */
export function sinceLine(item, nowMs) {
  const span = spanOf(item?.since, nowMs);
  const decide = item?.band === "decide";
  if (span === null) return decide ? "Waiting" : "Seen before";
  if (span.ahead) return decide ? "Waiting 1m" : "First seen 1m ago";
  return decide ? `Waiting ${span.label}` : `First seen ${span.label} ago`;
}

/** The name of a harness, from the answer's names, else its id. Pure. */
export function nameOf(names, id) {
  const hit = Array.isArray(names) ? names.find((n) => n?.id === id) : undefined;
  return typeof hit?.name === "string" && hit.name !== "" ? hit.name : String(id ?? "");
}

/** A group's cause, with how many runs and harnesses it covers. Pure. */
export function causeLine(item) {
  const cause = item?.cause;
  if (cause === undefined || cause === null) return null;
  const runs = Number(item?.affected?.count ?? 0);
  const harnesses = Array.isArray(item?.harnesses) ? item.harnesses.length : 1;
  const where = harnesses > 1 ? ` on ${harnesses} harnesses` : "";
  return `Same cause: ${cause.label}. ${runs} run${s(runs)}${where}.`;
}

/** How often this was asked, and when it was last refused. Pure. */
export function asksLine(item, nowMs) {
  const asks = item?.asks;
  if (asks === undefined || asks === null) return null;
  const count = Number(asks.count ?? 1);
  const asked = count > 1 ? `Asked ${count} times.` : "Asked once.";
  const refused = spanOf(asks.refusedAt, nowMs);
  return refused === null ? asked : `${asked} Refused ${refused.label} ago.`;
}

/** The `att_` id of a ref. Pure. */
export function itemIdOf(ref) {
  const text = String(ref ?? "");
  return text.slice(text.lastIndexOf("/") + 1);
}

/** The command that shows an item in full. Pure. */
export function showTwin(ref) {
  return `crewhaus inbox show ${itemIdOf(ref)}`;
}

/** The one harness an item is about, or `null` for a group across several. Pure. */
function oneHarness(item) {
  if (typeof item?.harness === "string" && item.harness !== "") return item.harness;
  const list = Array.isArray(item?.harnesses) ? item.harnesses : [];
  return list.length === 1 && typeof list[0] === "string" ? list[0] : null;
}

/** Where a problem is fixed: the harness page that changes what broke. Pure. */
function fixOn(item) {
  const kind = item?.kind;
  const harness = oneHarness(item);
  const params = item?.title?.params ?? {};
  if (kind === "credential") {
    const env = typeof params.envName === "string" && params.envName !== "" ? params.envName : null;
    return {
      label: env === null ? "Fix the key" : `Fix the ${env} key`,
      href:
        harness === null
          ? hrefFleet("connections", "credentials")
          : hrefHarness(harness, "setup", "credentials"),
    };
  }
  if (kind === "budget" && harness !== null) {
    return { label: "Review the budget", href: hrefHarness(harness, "setup", "budget") };
  }
  if (kind === "spec" && harness !== null) {
    return { label: "Fix the spec", href: hrefHarness(harness, "setup", "spec") };
  }
  if (kind === "provider-limit" && harness !== null) {
    return { label: "Review model settings", href: hrefHarness(harness, "setup", "models") };
  }
  if (kind === "run-failures" && harness !== null) {
    return item?.title?.template === "deployment.failing"
      ? { label: "Check the deployment", href: hrefHarness(harness, "setup", "deployment") }
      : { label: "See the failed runs", href: hrefHarness(harness, "work", "runs") };
  }
  if (kind === "provider-limit" || kind === "run-failures") {
    return { label: "See the failed runs", href: hrefFleet("home", "working") };
  }
  if (item?.band === "fix" && harness !== null) {
    return { label: "Open the harness", href: hrefHarness(harness) };
  }
  return null;
}

/** Where an item is acted on today, or `null` when nowhere yet. Pure. */
export function actOn(item) {
  const kind = item?.kind;
  if (kind === "permission" || kind === "question") {
    return {
      label: "Decide in Approvals",
      href: hrefFleet("home", "needs-you", { type: "approvals" }),
    };
  }
  if (kind === "review") {
    return { label: "Review in Review", href: hrefFleet("home", "needs-you", { type: "review" }) };
  }
  if (item?.title?.template === "delegation-proposal.pending" && typeof item.harness === "string") {
    const action = item.title.params?.delegationAction;
    if (typeof action === "string" && action !== "" && action !== "unknown") {
      return {
        label: "See what it would allow",
        href: hrefHarness(item.harness, "setup", "delegations", "new", action, item.source?.id),
      };
    }
  }
  if (item?.source?.kind === "advisor") {
    return { label: "Open in Advice", href: hrefFleet("home", "needs-you", { type: "advice" }) };
  }
  return fixOn(item);
}

/** A choice's name, as words. */
const CHOICE_WORDS = Object.freeze({
  grant: "Grant",
  deny: "Deny",
  resolve: "Resolve",
  review: "Preview",
  adopt: "Adopt",
});

/** Each choice with its exact command, or why there is none. Pure. */
export function choiceLines(item) {
  const list = Array.isArray(item?.choices) ? item.choices : [];
  return list
    .filter((c) => c && typeof c.id === "string")
    .map((c) => ({
      label: Object.hasOwn(CHOICE_WORDS, c.id) ? CHOICE_WORDS[c.id] : c.id,
      twin: typeof c.cliTwin === "string" && c.cliTwin !== "" ? c.cliTwin : null,
      reason:
        typeof c.cliTwin === "string" && c.cliTwin !== ""
          ? null
          : typeof c.nullReason === "string" && c.nullReason !== ""
            ? c.nullReason
            : "There is no command for this.",
    }));
}

/** Everything a card says, in the order it says it. Pure. */
export function cardModel(item, ctx = {}) {
  const nowMs = typeof ctx.nowMs === "number" ? ctx.nowMs : Date.now();
  const names = ctx.names ?? [];
  const harnessIds = Array.isArray(item?.harnesses)
    ? item.harnesses
    : typeof item?.harness === "string"
      ? [item.harness]
      : [];
  const decide = item?.band === "decide";
  const recommendation = item?.recommendation;
  return {
    id: itemIdOf(item?.ref),
    ref: String(item?.ref ?? ""),
    title: textOf(item?.title),
    whyNow: textOf(item?.whyNow),
    harnesses: harnessIds.map((id) => nameOf(names, id)),
    since: sinceLine(item, nowMs),
    deadline: decide ? deadlineLine(item, nowMs) : null,
    ifUnanswered: item?.ifUnanswered ? textOf({ template: item.ifUnanswered.template }) : null,
    who: decide ? classWord(item?.requiredClass) : null,
    cause: causeLine(item),
    asks: asksLine(item, nowMs),
    recommendation:
      recommendation && typeof recommendation === "object"
        ? `Suggested: ${recommendation.choiceId}. ${textOf(recommendation.reason)}`
        : null,
    twin: showTwin(item?.ref),
    act: actOn(item),
    choices: choiceLines(item),
    hasBody: item !== null && typeof item === "object" && "body" in item,
    bodyWithheld: item?.bodyWithheld === true,
  };
}

/** The bands with their items, in order; a band with none is left out. Pure. */
export function bandsOf(items) {
  const list = Array.isArray(items) ? items : [];
  return BANDS.map((band) => ({ ...band, items: list.filter((i) => i?.band === band.id) })).filter(
    (band) => band.items.length > 0,
  );
}

/** What the list says above its bands: harnesses it could not read or check, and freshness. Pure. */
export function listNotes(list) {
  const names = list?.names ?? [];
  const notes = [];
  const unreachable = Array.isArray(list?.unreachable) ? list.unreachable : [];
  if (unreachable.length > 0) {
    const who = unreachable.map((id) => nameOf(names, id));
    notes.push(
      who.length === 1
        ? `Couldn't read the requests of ${who[0]}: its sessions folder is outside its folder.`
        : `Couldn't read the requests of ${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}: each keeps its sessions folder outside its folder.`,
    );
  }
  const unchecked = Array.isArray(list?.advisorUnchecked) ? list.advisorUnchecked : [];
  if (unchecked.length > 0) {
    notes.push("Advisor findings appear after Home has checked a harness.");
  }
  const items = Array.isArray(list?.items) ? list.items : [];
  if (items.some((i) => i?.freshness?.mode === "direct-fold")) {
    notes.push("Updated just now (slower view while Home catches up).");
  }
  return notes;
}

/** What the empty list says, by the reason Home gave. Pure. */
export function emptyOptsOf(list) {
  const reason = list?.empty?.reason;
  const remedy = typeof list?.empty?.remedy === "string" ? list.empty.remedy : undefined;
  if (reason === "unreachable") {
    const names = (list?.unreachable ?? []).map((id) => nameOf(list?.names, id));
    return {
      cause: "unreachable",
      subject: names.length > 0 ? `the requests of ${names.join(", ")}` : "some requests",
      detail:
        "Its sessions folder is outside its folder. Keep the sessions folder inside the harness folder.",
    };
  }
  if (reason === "no-access")
    return { cause: "no-access", detail: remedy, action: "Ask the owner to share a harness" };
  if (reason === "filtered") return { cause: "filtered", detail: remedy };
  return { cause: "no-data", detail: "Nothing needs you right now." };
}

/** The index of the first ref `shownRefs` does not hold, or -1. Pure. */
export function firstNewIndex(shownRefs, refs) {
  const shown = new Set(Array.isArray(shownRefs) ? shownRefs : []);
  return (Array.isArray(refs) ? refs : []).findIndex((ref) => !shown.has(ref));
}

/** How many items `fresh` holds that the shown list does not. Pure. */
export function newCount(shownRefs, freshItems) {
  const shown = new Set(Array.isArray(shownRefs) ? shownRefs : []);
  return (Array.isArray(freshItems) ? freshItems : []).filter((i) => !shown.has(i?.ref)).length;
}

/** The key that moves between cards, or null. Letters only with single keys on. Pure. */
export function moveOf(key, singleKeys) {
  if (key === "ArrowDown" || (singleKeys && key === "j")) return 1;
  if (key === "ArrowUp" || (singleKeys && key === "k")) return -1;
  if (key === "Home") return "first";
  if (key === "End") return "last";
  return null;
}

/** How often the list looks for new items while it is open. */
export const RECHECK_MS = 30_000;

function line(cls, text) {
  return text === null || text === undefined ? null : el("div", { class: cls, text });
}

function drawCard(item, names, nowMs) {
  const m = cardModel(item, { names, nowMs });
  const titleId = `att-${m.id}`;
  return el(
    "li",
    {
      class: "card inbox-card attention-card",
      tabindex: "-1",
      "data-ref": m.ref,
      "aria-labelledby": titleId,
    },
    [
      el("h4", { class: "attention-title", id: titleId, text: m.title }),
      line("attention-why", m.whyNow),
      el("div", { class: "muted attention-meta" }, [
        m.harnesses.length > 0 ? `${m.harnesses.join(", ")} · ` : "",
        m.since,
        m.who === null ? "" : ` · ${m.who}`,
      ]),
      line("attention-deadline", m.deadline),
      line("muted attention-fallback", m.ifUnanswered),
      line("attention-cause", m.cause),
      line("muted attention-asks", m.asks),
      line("attention-recommendation", m.recommendation),
      m.hasBody
        ? el("details", { class: "attention-body" }, [
            el("summary", { text: "What the harness sent (its own words)" }),
            el("pre", { class: "mono", text: JSON.stringify(item.body, null, 2) }),
          ])
        : m.bodyWithheld
          ? line(
              "muted attention-withheld",
              "What it sent is hidden: you can't read this harness's content.",
            )
          : null,
      el("div", { class: "inbox-actions" }, [
        m.act === null ? null : el("a", { class: "btn", href: m.act.href, text: m.act.label }),
      ]),
      m.choices.length === 0
        ? null
        : el(
            "ul",
            { class: "attention-choices", "aria-label": "Choices" },
            m.choices.map((c) =>
              el("li", null, [
                el("span", { class: "muted", text: `${c.label}: ` }),
                c.twin === null ? el("span", { text: c.reason }) : el("code", { text: c.twin }),
              ]),
            ),
          ),
      el("div", { class: "inbox-twins" }, [
        el("span", { class: "muted", text: "Show it in a terminal: " }),
        el("code", { text: m.twin }),
      ]),
    ],
  );
}

/** The bands and their cards; `j`/`k` move between cards while focus is inside. */
function drawList(list, nowMs) {
  // The list sits in the labelled section that holds it; each band is a region of its own.
  const region = el("div", { class: "attention" });
  for (const band of bandsOf(list.items)) {
    const bandHeading = `attention-band-${band.id}`;
    region.appendChild(
      el("section", { class: "attention-band", "aria-labelledby": bandHeading }, [
        el("h3", { class: "attention-band-heading", id: bandHeading, text: band.label }),
        el(
          "ul",
          { class: "inbox attention-list", "aria-label": band.label },
          band.items.map((item) => drawCard(item, list.names, nowMs)),
        ),
      ]),
    );
  }
  const roving = rovingList(region, ".attention-card", {
    onKey: (event, index) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, summary")) return;
      const move = moveOf(event.key, readPrefs().singleKeys !== false);
      if (move === null) return;
      const count = roving.rows().length;
      if (count === 0) return;
      event.preventDefault();
      const at = index < 0 ? 0 : index;
      const next =
        move === "first"
          ? 0
          : move === "last"
            ? count - 1
            : Math.min(Math.max(at + move, 0), count - 1);
      roving.setCurrent(next);
      roving.focus(next);
    },
  });
  roving.setCurrent(0);
  return { region, roving };
}

/** Focus the card `?item=` names, or say it is no longer open. */
function focusItem(drawn, itemId, status) {
  if (typeof itemId !== "string" || itemId === "") return;
  const rows = drawn.roving.rows();
  const index = rows.findIndex((row) => itemIdOf(row.dataset.ref) === itemId);
  if (index < 0) {
    status.textContent = "That item is no longer open.";
    return;
  }
  drawn.roving.setCurrent(index);
  drawn.roving.focus(index);
}

/** The cards whose "What the harness sent" is open, by ref. */
function openBodyRefs(host) {
  return [...host.querySelectorAll(".attention-card details[open]")]
    .map((details) => details.closest("[data-ref]")?.getAttribute("data-ref"))
    .filter((ref) => typeof ref === "string");
}

/**
 * After "Show N new": what was open stays open, focus moves to the first new card (or
 * the list's heading when none is left), and the count is said.
 */
function restoreAfterNew(host, drawn, restore) {
  const rows = drawn.roving.rows();
  const open = new Set(restore.openRefs ?? []);
  for (const row of rows) {
    if (!open.has(row.getAttribute("data-ref"))) continue;
    const details = row.querySelector("details");
    if (details !== null) details.open = true;
  }
  const refs = rows.map((row) => row.getAttribute("data-ref"));
  const index = firstNewIndex(restore.shownRefs, refs);
  const added = refs.filter((ref) => !new Set(restore.shownRefs ?? []).has(ref)).length;
  if (index >= 0) {
    drawn.roving.setCurrent(index);
    drawn.roving.focus(index);
  } else {
    const heading = host.closest("section")?.querySelector("h2, h3") ?? host.querySelector("h3");
    if (heading !== null && heading !== undefined) {
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus();
    }
  }
  announce(added > 0 ? `Showing ${added} new` : "The list is up to date.");
}

/** Needs you, All: Home's inbox. */
export async function renderAttention(host, ctx = {}) {
  const fetchList = () => call("attention.list", { query: { limit: "500" } });
  const answer = await fetchList();
  if (ctx.signal?.aborted) return;
  if (!answer.ok) {
    if (answer.status === 403) {
      clear(host).appendChild(emptyFor({ cause: "no-access", detail: answer.error.message }));
      return;
    }
    throw new Error(answer.error.message);
  }
  const list = answer.body ?? {};
  const nowMs = Date.now();
  clear(host);
  const status = el("p", { class: "muted attention-status", role: "status" });
  const fresh = el("div", { class: "attention-fresh" });
  host.append(status, fresh);
  for (const note of listNotes(list)) host.appendChild(el("p", { class: "muted", text: note }));
  const items = Array.isArray(list.items) ? list.items : [];
  if (items.length === 0) {
    host.appendChild(emptyFor(emptyOptsOf(list)));
    host.appendChild(
      el("p", { class: "muted" }, ["In a terminal: ", el("code", { text: "crewhaus inbox list" })]),
    );
    focusItem({ roving: { rows: () => [] } }, ctx.route?.query?.item, status);
    return;
  }
  const drawn = drawList(list, nowMs);
  host.appendChild(drawn.region);
  focusItem(drawn, ctx.route?.query?.item, status);
  if (ctx.restore !== undefined) restoreAfterNew(host, drawn, ctx.restore);
  const shownRefs = items.map((i) => i.ref);
  // New items wait behind a button, so nothing moves under focus or under the reader.
  const recheck = () => {
    if (ctx.signal?.aborted || !host.isConnected) return;
    setTimeout(async () => {
      if (ctx.signal?.aborted || !host.isConnected) return;
      try {
        const next = await fetchList();
        const n = next.ok ? newCount(shownRefs, next.body?.items) : 0;
        if (n > 0 && !ctx.signal?.aborted) {
          const label = `Show ${n} new`;
          fresh.replaceChildren(
            el("button", {
              class: "btn",
              type: "button",
              text: label,
              onClick: () =>
                renderAttention(host, {
                  ...ctx,
                  route: { ...ctx.route, query: {} },
                  restore: { shownRefs, openRefs: openBodyRefs(host) },
                }),
            }),
          );
          announce(`${n} new item${s(n)} waiting. ${label} to see them.`);
          return;
        }
      } catch {
        // A failed look leaves the list as it is; the next one tries again.
      }
      recheck();
    }, RECHECK_MS);
  };
  recheck();
}
