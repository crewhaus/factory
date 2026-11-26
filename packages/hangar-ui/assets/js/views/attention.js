/**
 * Needs you, All: one list of everything waiting on a person across the
 * harnesses you can see, read from Home's inbox (`attention.list`). Three
 * labelled bands, Decide, Fix and Consider, newest first within each; a card
 * per item says what it is, why now, which harness, since when, the deadline
 * only when there is a real one, who may decide, who has it, and each choice
 * as a button with what choosing it does and its exact command, or why there
 * is none. A problem also links the page that fixes it.
 *
 * Acting is done here (`./attention-acts.js`). A verdict opens one confirm
 * step; afterwards the list is read again, focus is on the next card, and
 * what happened is said politely with how many are left. `?kind=` shows one
 * kind; "Show settled" adds what was already settled, so a problem set aside
 * can be taken up again.
 *
 * Reading never moves anything under you: the list is fetched again now and
 * then, and new items wait behind "Show N new", which keeps what was open and
 * moves focus to the first new card. `j`/`k` (and the arrows) move between
 * cards only while focus is inside the list, and a letter (`g`, `d`, `p`,
 * `f`, `u`) opens a verdict's confirm step there; the letters follow the
 * "Single-key shortcuts" setting. `?item=<id>` moves focus to that card, or
 * says it is no longer open.
 *
 * The decisions are pure functions this package tests without a browser; the
 * DOM is built with `createElement` and `textContent` only.
 */

import { clear, el, skeleton } from "../dom.js";
import { actionBar } from "../inspect/actions.js";
import { readPrefs } from "../prefs.js";
import { hrefFleet, hrefHarness, hrefInspect } from "../router.js";
import { emptyFor } from "../ui/empty.js";
import { rovingList } from "../ui/listbox.js";
import { announce } from "../ui/live.js";
import { toggleBtn } from "../ui/toggle.js";
import { parseTs } from "../util.js";
import { call } from "../v1.js";
import {
  afterWords,
  asksFirst,
  choiceLabel,
  choiceModels,
  classWord,
  confirmChoice,
  discussion,
  doneWords,
  harnessesOf,
  isStale,
  itemIdOf,
  oneHarness,
  problemText,
  reachOf,
  runSideAct,
  sendChoice,
  sideActs,
  verdictOf,
} from "./attention-acts.js";

export { classWord, itemIdOf };

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
/** A spec and its version, as far as they are named. */
const version = (p, fallback) =>
  [p.spec, p.version].filter((v) => typeof v === "string" && v !== "").join(" ") || fallback;

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
  "checkpoint.waiting": (p) =>
    typeof p.node === "string" && p.node !== ""
      ? `A graph run is paused before ${p.node}`
      : "A graph run is paused for a decision",
  "deploy-approval.pending": (p) =>
    `Approve ${version(p, "a version")} for ${word(p.environment, "an environment")}`,
  "deploy-approval.ready": (p) =>
    `${version(p, "A version")} is approved for ${word(p.environment, "an environment")}`,
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
  "why.graph-paused": () => "The run goes no further until someone decides.",
  "why.deploy-blocked": () => "The environment is protected: it takes approvals.",
  "why.deploy-approved": () => "It has its approvals and is not there yet.",
  "why.advisor-critical": () => "The harness can't do its job until this is fixed.",
  "why.advisor-warn": () => "The harness is at risk.",
  "why.advisor-suggestion": () => "It would run better.",
  "recommend.refused-before": () => "Refused before: the same request was refused recently.",
  "budget.raise-spec": () => "Raise the limit in the spec",
  "budget.raise-period": () => "Raise this period's limit",
  "note.deadline-unchanged": () => "Its own deadline is unchanged.",
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

/** The command that shows an item in full. Pure. */
export function showTwin(ref) {
  return `crewhaus inbox show ${itemIdOf(ref)}`;
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

/** The page beside the choices: where a problem is fixed or a question was asked. Pure. */
export function placeOf(item) {
  if (item?.kind === "question") {
    // A question is answered, not allowed or refused: the run that asked it says where.
    const harness = oneHarness(item);
    const run = Array.isArray(item?.affected?.runs) ? item.affected.runs[0] : undefined;
    return harness === null || typeof run !== "string"
      ? null
      : { label: "See the run that asked", href: hrefInspect(`${harness}/run/${run}`) };
  }
  if (item?.source?.kind === "advisor") {
    // A finding that opens a place says so on its own button: one control, one place.
    const opens = Array.isArray(item?.choices) && item.choices.some((c) => c?.id === "open");
    return opens
      ? null
      : { label: "Open in Advice", href: hrefFleet("home", "needs-you", { type: "advice" }) };
  }
  return fixOn(item);
}

/**
 * A member's name, from an answer's `people`, else "Someone else": a raw id is technical
 * detail, never what a person reads. Pure.
 */
export function personOf(people, id) {
  const hit = Array.isArray(people) ? people.find((p) => p?.id === id) : undefined;
  return typeof hit?.name === "string" && hit.name !== "" ? hit.name : "Someone else";
}

/** Who has an item and until when it is out of the way. Pure. */
export function standingLines(item, ctx = {}) {
  const nowMs = typeof ctx.nowMs === "number" ? ctx.nowMs : Date.now();
  const back = (at) => {
    const span = spanOf(at, nowMs);
    return span === null ? "later" : span.ahead ? `in ${span.label}` : "now";
  };
  const out = [];
  if (typeof item?.assignee === "string") {
    out.push(
      item.assignee === ctx.meId ? "With you." : `With ${personOf(ctx.people, item.assignee)}.`,
    );
  }
  if (item?.deferral) {
    out.push(
      item.deferral.deadlineMoved
        ? `Put off. It is due again ${back(item.deferral.until)}.`
        : `Put off. It comes back ${back(item.deferral.until)}.`,
    );
    if (!item.deferral.deadlineMoved && item.source?.kind === "decision") {
      out.push(ATTENTION_TEXT["note.deadline-unchanged"]());
    }
  }
  if (typeof item?.snoozedUntil === "string") {
    out.push(`Hidden from you. It comes back ${back(item.snoozedUntil)}.`);
  }
  if (item?.previously) out.push("It was set aside before, and happened again.");
  return out;
}

const HOW_WORDS = Object.freeze({
  decided: "Decided",
  cleared: "Cleared by itself",
  dismissed: "Set aside",
  acted: "Acknowledged",
  answered: "Answered",
  fallback: "Settled when its time ran out",
});

/** How a settled item was settled, or `null` for one that still waits. Pure. */
export function settledLine(item, nowMs) {
  const state = item?.state;
  if (state === "open" || state === "assigned" || state === "deferred") return null;
  if (state === "expired") return "It expired.";
  if (state === "superseded") return "A newer one replaced it.";
  const how = item?.resolution?.how;
  const label = Object.hasOwn(HOW_WORDS, how) ? HOW_WORDS[how] : "Settled";
  const span = spanOf(item?.resolution?.at, nowMs);
  return span === null ? `${label}.` : `${label} ${span.label} ago.`;
}

/** Everything a card says, in the order it says it. Pure. */
export function cardModel(item, ctx = {}) {
  const nowMs = typeof ctx.nowMs === "number" ? ctx.nowMs : Date.now();
  const names = ctx.names ?? [];
  const harnessIds = harnessesOf(item);
  const decide = item?.band === "decide";
  const recommendation = item?.recommendation;
  const settled = settledLine(item, nowMs);
  return {
    id: itemIdOf(item?.ref),
    ref: String(item?.ref ?? ""),
    title: textOf(item?.title),
    whyNow: textOf(item?.whyNow),
    harnesses: harnessIds.map((id) => nameOf(names, id)),
    since: sinceLine(item, nowMs),
    settled,
    standing: standingLines(item, { nowMs, meId: ctx.me?.id, people: ctx.people }),
    deadline: decide && settled === null ? deadlineLine(item, nowMs) : null,
    ifUnanswered: item?.ifUnanswered ? textOf({ template: item.ifUnanswered.template }) : null,
    who: decide ? classWord(item?.requiredClass) : null,
    cause: causeLine(item),
    asks: asksLine(item, nowMs),
    recommendation:
      recommendation && typeof recommendation === "object"
        ? `Suggested: ${choiceLabel(item?.kind, recommendation.choiceId)}. ${textOf(recommendation.reason)}`
        : null,
    twin: showTwin(item?.ref),
    place: placeOf(item),
    choices: choiceModels(item, ctx.you),
    side: sideActs(item, ctx.you),
    hasBody: item !== null && typeof item === "object" && "body" in item,
    bodyWithheld: item?.bodyWithheld === true,
  };
}

/** Every kind of item, with its name in the kind filter. */
export const KIND_WORDS = Object.freeze({
  permission: "Permissions",
  question: "Questions",
  review: "Reviews",
  "standing-rule-proposal": "Standing permissions",
  "quality-adoption": "Changes to adopt",
  decision: "Other decisions",
  checkpoint: "Paused graph runs",
  "deploy-approval": "Deployment approvals",
  credential: "Sign-in problems",
  "provider-limit": "Provider limits",
  budget: "Budget",
  spec: "Spec problems",
  "run-failures": "Failed runs",
  security: "Security",
  "quality-regression": "Quality drops",
  setup: "Setup",
});

/** The old `?type=` addresses, as the kind each became. */
const KIND_OF_TYPE = Object.freeze({ approvals: "permission", review: "review" });

/** The kind a route shows, or `null` for all of them. Pure. */
export function kindFilter(route) {
  const { kind, type } = route?.query ?? {};
  if (typeof kind === "string" && Object.hasOwn(KIND_WORDS, kind)) return kind;
  return typeof type === "string" && Object.hasOwn(KIND_OF_TYPE, type) ? KIND_OF_TYPE[type] : null;
}

/** The kind filter's links: All, then each kind the list holds, with its count. Pure. */
export function kindLinks(items, current) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (Object.hasOwn(KIND_WORDS, item?.kind)) {
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    }
  }
  // The one being shown stays, so it can be left even when it holds nothing.
  if (current !== null && !counts.has(current)) counts.set(current, 0);
  const total = Array.isArray(items) ? items.length : 0;
  const link = (kind, label, n) => ({
    kind,
    label: `${label} (${n})`,
    href: hrefFleet("home", "needs-you", kind === null ? null : { kind }),
    current: kind === current,
  });
  return [
    link(null, "All", total),
    ...Object.keys(KIND_WORDS)
      .filter((kind) => counts.has(kind))
      .map((kind) => link(kind, KIND_WORDS[kind], counts.get(kind))),
  ];
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

/** One choice: its button or link, what it does, and its command or why there is none. */
function drawChoice(item, model, card, ctx) {
  const effectId = `${card.id}-${model.id}`;
  const described = `${card.titleId} ${effectId}`;
  const control =
    model.does === "open" && model.why === null
      ? el("a", {
          class: "btn",
          href: model.href,
          text: model.label,
          "aria-describedby": described,
        })
      : el("button", {
          class: model.does === "open" ? "btn" : "btn attention-verdict",
          type: "button",
          disabled: model.why !== null,
          "data-choice": model.id,
          text: model.label,
          "aria-describedby": described,
          onClick: (event) => ctx.choose(item, model, event.currentTarget),
        });
  return el("li", null, [
    control,
    el("span", { class: "attention-effect", id: effectId, text: model.why ?? model.effect }),
    model.twin === null
      ? el("span", { class: "muted", text: model.reason })
      : el("code", { text: model.twin }),
  ]);
}

/** One act beside the choices, with why the reader may not take it. */
function drawSide(item, side, card, ctx) {
  const whyId = `${card.id}-${side.id}-why`;
  return el("span", { class: "attention-side" }, [
    el("button", {
      class: "btn btn-ghost",
      type: "button",
      disabled: side.why !== null,
      "data-act": side.id,
      text: side.label,
      "aria-describedby": side.why === null ? card.titleId : `${card.titleId} ${whyId}`,
      onClick: (event) => ctx.side(item, side.id, event.currentTarget),
    }),
    side.why === null ? null : el("span", { class: "muted", id: whyId, text: side.why }),
  ]);
}

function drawCard(item, ctx) {
  const m = cardModel(item, ctx);
  const titleId = `att-${m.id}`;
  const card = { id: m.id, titleId };
  const reach = reachOf(ctx.you, item);
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
      line("attention-settled", m.settled),
      ...m.standing.map((text) => line("attention-standing", text)),
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
      m.choices.length === 0
        ? null
        : el(
            "ul",
            { class: "attention-choices", "aria-label": "Choices" },
            m.choices.map((model) => drawChoice(item, model, card, ctx)),
          ),
      el("div", { class: "inbox-actions" }, [
        m.place === null
          ? null
          : el("a", { class: "btn", href: m.place.href, text: m.place.label }),
        ...m.side.map((side) => drawSide(item, side, card, ctx)),
        actionBar({
          ref: m.ref,
          label: m.title,
          operation: { id: "attention.get", params: { ref: m.ref } },
        }),
      ]),
      discussion(item, {
        harnesses: reach.harnesses,
        content: reach.content,
        mayAct: reach.act,
        meId: ctx.me?.id,
        ago: (at) => {
          const span = spanOf(at, Date.now());
          return span === null ? "" : `${span.label} ago`;
        },
      }),
      el("div", { class: "inbox-twins" }, [
        el("span", { class: "muted", text: "Show it in a terminal: " }),
        el("code", { text: m.twin }),
      ]),
    ],
  );
}

/** The bands and their cards; `j`/`k` move between cards while focus is inside. */
function drawList(items, ctx) {
  // The list sits in the labelled section that holds it; each band is a region of its own.
  const region = el("div", { class: "attention" });
  const byRef = new Map(items.map((item) => [String(item.ref), item]));
  for (const band of bandsOf(items)) {
    const bandHeading = `attention-band-${band.id}`;
    region.appendChild(
      el("section", { class: "attention-band", "aria-labelledby": bandHeading }, [
        el("h3", { class: "attention-band-heading", id: bandHeading, text: band.label }),
        el(
          "ul",
          { class: "inbox attention-list", "aria-label": band.label },
          band.items.map((item) => drawCard(item, ctx)),
        ),
      ]),
    );
  }
  const roving = rovingList(region, ".attention-card", {
    onKey: (event, index) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, summary")) return;
      const singleKeys = readPrefs().singleKeys !== false;
      const rows = roving.rows();
      const item = byRef.get(rows[index]?.getAttribute("data-ref") ?? "");
      const verdict =
        item === undefined || event.repeat
          ? null
          : verdictOf(event.key, choiceModels(item, ctx.you), singleKeys);
      if (verdict !== null) {
        event.preventDefault();
        ctx.choose(item, verdict, rows[index]);
        return;
      }
      const move = moveOf(event.key, singleKeys);
      if (move === null) return;
      const count = rows.length;
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

/** The disclosures a card keeps open across a redraw, each known by its own class. */
const KEPT_DISCLOSURES = ["attention-body", "attention-thread"];

/**
 * What a reader left on each card, by ref: which of its disclosures are open, and what they
 * typed in its discussion and have not sent. Read before a redraw replaces the cards.
 */
export function cardMemory(root) {
  const memory = new Map();
  for (const card of root?.querySelectorAll?.(".attention-card") ?? []) {
    const ref = card.getAttribute("data-ref");
    if (typeof ref !== "string") continue;
    const open = KEPT_DISCLOSURES.filter(
      (name) => card.querySelector(`details.${name}`)?.open === true,
    );
    const draft = card.querySelector(".attention-discuss textarea")?.value ?? "";
    if (open.length > 0 || draft !== "") memory.set(ref, { open, draft });
  }
  return memory;
}

/** Put back what {@link cardMemory} kept, on the cards that are still there. */
export function restoreCards(rows, memory) {
  if (!(memory instanceof Map) || memory.size === 0) return;
  for (const row of rows) {
    const kept = memory.get(row.getAttribute("data-ref"));
    if (kept === undefined) continue;
    for (const name of kept.open) {
      const details = row.querySelector(`details.${name}`);
      if (details !== null && details !== undefined) details.open = true;
    }
    const text = row.querySelector(".attention-discuss textarea");
    if (kept.draft !== "" && text !== null && text !== undefined) text.value = kept.draft;
  }
}

/** Focus the list's own heading: where there is no card to go to. */
function focusHeading(host) {
  const heading = host.closest("section")?.querySelector("h2, h3") ?? host.querySelector("h3");
  if (heading === null || heading === undefined) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus();
}

/**
 * After "Show N new": focus moves to the first new card (or the list's heading when none
 * is left), and the count is said. What was open and typed was put back by the redraw.
 */
function restoreAfterNew(host, drawn, restore) {
  const rows = drawn.roving.rows();
  const refs = rows.map((row) => row.getAttribute("data-ref"));
  const index = firstNewIndex(restore.shownRefs, refs);
  const added = refs.filter((ref) => !new Set(restore.shownRefs ?? []).has(ref)).length;
  if (index >= 0) {
    drawn.roving.setCurrent(index);
    drawn.roving.focus(index);
  } else {
    focusHeading(host);
  }
  announce(added > 0 ? `Showing ${added} new` : "The list is up to date.");
}

/**
 * The card focus goes to once one was acted on: the one that took its place, the next one
 * when it is still there, the last one when it was last; -1 with none left. Pure.
 */
export function nextIndex(refs, acted) {
  const list = Array.isArray(refs) ? refs : [];
  if (list.length === 0) return -1;
  const at = Math.min(Math.max(Number(acted?.index) || 0, 0), list.length - 1);
  return list[at] === acted?.ref ? Math.min(at + 1, list.length - 1) : at;
}

/** After an act: focus on the next card, and what happened said with what is left. */
function restoreAfterAct(host, drawn, acted, left) {
  const refs = drawn.roving.rows().map((row) => row.getAttribute("data-ref"));
  const index = nextIndex(refs, acted);
  if (index >= 0) {
    drawn.roving.setCurrent(index);
    drawn.roving.focus(index);
  } else focusHeading(host);
  announce(afterWords(acted.words, left));
}

/** The reader, as Home knows them: who they are and what they may do somewhere. */
async function whoAmI() {
  const answer = await call("me.get");
  const id = answer.ok ? answer.body?.principal?.id : undefined;
  return typeof id === "string" ? { id, can: answer.body?.can ?? {} } : null;
}

/** The kind filter's links, redrawn with their counts. */
function drawKinds(list, items, kind) {
  list.replaceChildren(
    ...kindLinks(items, kind).map((link) =>
      el("li", null, [
        el("a", {
          class: `tab${link.current ? " active" : ""}`,
          href: link.href,
          "aria-current": link.current ? "page" : null,
          text: link.label,
        }),
      ]),
    ),
  );
}

/**
 * The list's frame, built once per mount: the kind filter, "Show settled" (kept, so it
 * keeps its focus), a status line, the "Show N new" slot and the list's own body.
 */
function buildFrame(host, redraw) {
  const kinds = el("ul", { class: "tabs page-nav-list" });
  const toggle = toggleBtn({
    label: "Show settled",
    pressed: false,
    onToggle: (next) => redraw({ settled: next }),
  });
  const status = el("p", { class: "muted attention-status", role: "status" });
  const fresh = el("div", { class: "attention-fresh" });
  const body = el("div", { class: "attention-list-body" });
  clear(host).append(
    el("div", { class: "attention-filters" }, [
      el("nav", { class: "attention-kinds", "aria-label": "Kind" }, kinds),
      toggle,
    ]),
    status,
    fresh,
    body,
  );
  return { kinds, status, fresh, body };
}

/** Needs you, All: Home's inbox. */
export async function renderAttention(host, ctx = {}) {
  host.appendChild(skeleton(4));
  const view = { frame: null, settled: false, me: undefined, seq: 0 };
  const redraw = async (over = {}) => {
    if (typeof over.settled === "boolean") view.settled = over.settled;
    try {
      await drawInbox(host, view, ctx, redraw, over);
    } catch (err) {
      if (ctx.signal?.aborted || view.frame === null) throw err;
      view.frame.status.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  await redraw();
}

async function drawInbox(host, view, ctx, redraw, over) {
  const fetchList = () =>
    call("attention.list", {
      query: { limit: "500", ...(view.settled ? { state: "all" } : {}) },
    });
  view.seq += 1;
  const mine = view.seq;
  const [answer, me] = await Promise.all([
    fetchList(),
    view.me !== undefined ? Promise.resolve(view.me) : whoAmI(),
  ]);
  // A newer redraw already asked, or the page is gone: this answer is out of date.
  if (ctx.signal?.aborted || mine !== view.seq) return;
  view.me = me;
  if (!answer.ok) {
    if (answer.status === 403) {
      clear(host).appendChild(emptyFor({ cause: "no-access", detail: answer.error.message }));
      view.frame = null;
      return;
    }
    throw new Error(answer.error.message);
  }
  view.frame ??= buildFrame(host, redraw);
  const { frame } = view;
  const { status } = frame;
  const list = answer.body ?? {};
  const nowMs = Date.now();
  const kind = kindFilter(ctx.route);
  const all = Array.isArray(list.items) ? list.items : [];
  const items = kind === null ? all : all.filter((item) => item?.kind === kind);
  drawKinds(frame.kinds, all, kind);
  status.textContent = "";
  frame.fresh.replaceChildren();
  // Whatever redrew the list, an open discussion and its unsent words stay as they were.
  const memory = cardMemory(frame.body);
  clear(frame.body);
  for (const note of listNotes(list)) {
    frame.body.appendChild(el("p", { class: "muted", text: note }));
  }
  const asked =
    over.acted === undefined && over.restore === undefined && over.settled === undefined;
  const wanted = asked ? ctx.route?.query?.item : undefined;
  if (items.length === 0) {
    frame.body.append(
      emptyFor(
        kind === null
          ? emptyOptsOf(list)
          : {
              cause: "filtered",
              detail: `Nothing under ${KIND_WORDS[kind]}.`,
              onAction: () => {
                location.hash = hrefFleet("home", "needs-you");
              },
            },
      ),
      el("p", { class: "muted" }, ["In a terminal: ", el("code", { text: "crewhaus inbox list" })]),
    );
    focusItem({ roving: { rows: () => [] } }, wanted, status);
    if (over.acted !== undefined) {
      focusHeading(host);
      announce(afterWords(over.acted.words, 0));
    }
    return;
  }

  const names = list.names ?? [];
  /** What an act needs to know about its card, and what follows it. */
  const actContext = (item, opener) => {
    const ref = String(item.ref);
    const index = drawn.roving.rows().findIndex((row) => row.getAttribute("data-ref") === ref);
    const reach = reachOf(list.you, item);
    return {
      title: textOf(item.title),
      where: harnessesOf(item)
        .map((id) => nameOf(names, id))
        .join(", "),
      deadline: item.band === "decide" ? deadlineLine(item, Date.now()) : null,
      opener,
      nowMs: Date.now(),
      harnesses: reach.harnesses,
      me,
      deps: { kept: new Map() },
      onDone: (done, stale, words) => {
        if (ctx.signal?.aborted) return;
        if (done === null) {
          // Cancelled; a list that changed meanwhile is read again.
          if (stale) void redraw({ acted: { index, ref, words: "The list was read again." } });
          return;
        }
        if (!done.ok) {
          const problem = problemText(done.error);
          if (isStale(done)) void redraw({ acted: { index, ref, words: problem } });
          else {
            status.textContent = problem;
            announce(problem, { assertive: true });
          }
          return;
        }
        const said = done.detail === undefined ? words : `${words} ${done.detail}`;
        void redraw({ acted: { index, ref, words: said } });
      },
    };
  };
  const drawn = drawList(items, {
    names,
    people: list.people ?? [],
    nowMs,
    you: list.you,
    me: me ?? undefined,
    choose: async (item, model, opener) => {
      const act = actContext(item, opener);
      const onDone = (done, stale) => act.onDone(done, stale, doneWords(model.id));
      if (asksFirst(model)) confirmChoice(item, model, { ...act, onDone });
      else onDone(await sendChoice(item, model, act), false);
    },
    side: (item, id, opener) => void runSideAct(id, item, actContext(item, opener)),
  });
  frame.body.appendChild(drawn.region);
  restoreCards(drawn.roving.rows(), memory);
  const waiting = items.filter((item) => settledLine(item, nowMs) === null).length;
  focusItem(drawn, wanted, status);
  if (over.restore !== undefined) restoreAfterNew(host, drawn, over.restore);
  if (over.acted !== undefined) restoreAfterAct(host, drawn, over.acted, waiting);
  const shownRefs = all.map((i) => i.ref);
  // New items wait behind a button, so nothing moves under focus or under the reader.
  const recheck = () => {
    const gone = () => ctx.signal?.aborted || !drawn.region.isConnected;
    if (gone()) return;
    setTimeout(async () => {
      if (gone()) return;
      try {
        const next = await fetchList();
        const n = next.ok ? newCount(shownRefs, next.body?.items) : 0;
        if (n > 0 && !gone()) {
          const label = `Show ${n} new`;
          frame.fresh.replaceChildren(
            el("button", {
              class: "btn",
              type: "button",
              text: label,
              onClick: () => redraw({ restore: { shownRefs } }),
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
