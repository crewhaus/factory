/**
 * The Overview's cards that read the versioned API: the header strip (state in words,
 * where it runs, when it was last heard from), its purpose, what needs you here, what is
 * working now, recent outcomes, the quality of its latest comparable evaluation, and its
 * operating limits (what it may do on its own, from its delegation rules, and its
 * spending limit). Each card loads, empties and fails on its own.
 *
 * The models are pure and exported for tests; the cards build DOM with `el` only.
 */

import { el } from "../dom.js";
import { hrefHarness } from "../router.js";
import { timeEl } from "../ui/time.js";
import { call, createAction } from "../v1.js";
import { partialNotes } from "./attention.js";
import { renderDecisionCard } from "./decision-card.js";

/** A harness's display state, in words. Never colour alone: the dot carries the word. */
export const HARNESS_STATE_WORDS = Object.freeze({
  running: { word: "Working", dot: "ok" },
  idle: { word: "Idle", dot: "ok" },
  paused: { word: "Paused (new work held)", dot: "warn" },
  draining: { word: "Finishing current work", dot: "warn" },
  stopped: { word: "Stopped", dot: "off" },
  crashed: { word: "Keeps crashing", dot: "bad" },
  disabled: { word: "Disabled", dot: "off" },
  disconnected: { word: "Not responding", dot: "bad" },
});

const DAY_MONTH = { day: "numeric", month: "short", timeZone: "UTC" };

/** `16 Nov`, or null. Pure. */
export function dayMonth(iso) {
  const at = Date.parse(String(iso ?? ""));
  return Number.isFinite(at) ? new Date(at).toLocaleDateString("en-GB", DAY_MONTH) : null;
}

/** The header strip's words, from `harnesses.get` and where the page is served from. Pure. */
export function headerStripModel(overview, { loopback = true, host = null } = {}) {
  const display = overview?.display && typeof overview.display === "object" ? overview.display : {};
  const known = HARNESS_STATE_WORDS[display.state] ?? {
    word: String(display.state ?? "Unknown"),
    dot: "off",
  };
  const recorded = display.enforcement === "recorded-not-enforced";
  return {
    word: recorded ? "Recorded, not enforced" : known.word,
    dot: recorded ? "warn" : known.dot,
    host: loopback ? "Runs on this computer" : `Runs on ${host ?? "Home's computer"}`,
    keeps:
      "Keeps running when you close this window. Runs that Home started itself stop if Home stops.",
    lastVerified:
      typeof overview?.lastVerifiedContactAt === "string" ? overview.lastVerifiedContactAt : null,
  };
}

/** The purpose card's words. Pure. */
export function purposeWords(overview) {
  return typeof overview?.purpose === "string" && overview.purpose.trim() !== ""
    ? overview.purpose.trim()
    : "No purpose yet. Add one in Setup.";
}

/** What an action is called while a rule does it, and when a person is asked. */
const ACTION_NOUN = Object.freeze({ merge: "Merging", rollout: "Rolling out" });
const ASK_NOUN = Object.freeze({ merge: "Merges", rollout: "Rollouts" });
const DELEGABLE = Object.freeze(["merge", "rollout"]);

/** What the Operating limits card says when its delegation rules could not be read. */
export const LIMITS_UNREAD = "What this harness may do on its own could not be read.";

/**
 * What the harness may do on its own, and what needs a person, from `delegations.list`
 * and `budget.get`: `[{text, review?, retry?}]`, one line each. A read that failed
 * (`delegations` null) says so, with a retry, and never that anything asks a person.
 * Pure.
 */
export function operatingLimitsModel(delegations, budget, harness = "<harness>") {
  const lines = [];
  const unread = delegations === null || typeof delegations !== "object";
  if (unread) lines.push({ text: LIMITS_UNREAD, retry: true });
  const items = Array.isArray(delegations?.items) ? delegations.items : [];
  const active = new Set();
  for (const rule of items) {
    const noun = ACTION_NOUN[rule?.action];
    if (noun === undefined) continue;
    if (rule.state === "active") {
      active.add(rule.action);
      const until = dayMonth(rule.endsAt);
      const uses = Number.isSafeInteger(rule.uses) && rule.uses > 0 ? rule.uses : 0;
      lines.push({
        text: `${noun} delegated${until !== null ? ` until ${until}` : ""} (${uses} so far)`,
      });
    } else if (rule.state === "suspended" && rule.suspendedReason === "rolled-back") {
      lines.push({
        text: "Rule turned off after a rollback.",
        review: hrefHarness(harness, "setup", "delegations"),
      });
    }
  }
  for (const action of DELEGABLE) {
    if (!unread && !active.has(action)) lines.push({ text: `${ASK_NOUN[action]} ask a person` });
  }
  if (budget !== null && typeof budget === "object") {
    if (budget.present !== true && budget.why !== "spec_unreadable") {
      lines.push({ text: "No spending limit set." });
    } else if (budget.present === true && (budget.fold?.unknownCalls ?? 0) > 0) {
      lines.push({ text: "Cost unknown for some calls." });
    }
  }
  return lines;
}

/**
 * The Needs you card's model, from `decisions.list?harness=…&state=pending`: the requests
 * waiting here, and what a list read only in part says. "Nothing waits" is said only of
 * a list read whole. Pure.
 */
export function needsYouCardModel(list, harnessName = null) {
  const items = Array.isArray(list?.items) ? list.items : [];
  const pending = items.filter((d) => d?.state === "pending");
  const notes = partialNotes({
    ...(list ?? {}),
    names:
      harnessName === null || !Array.isArray(list?.unreachable)
        ? []
        : list.unreachable.map((id) => ({ id, name: harnessName })),
  });
  return {
    pending,
    notes,
    empty: pending.length === 0 && notes.length === 0 ? "No requests are waiting here." : null,
  };
}

/** The fields that make two evaluation runs comparable. */
const LINEAGE = Object.freeze(["datasetName", "datasetHash", "gradersHash", "judgeModel"]);

const lineageOf = (run) => LINEAGE.map((field) => String(run?.[field] ?? "")).join("\u0000");

/**
 * The Quality card's model from the eval history, newest first: the latest run that is
 * neither partial nor replayed, its passed and failed counts, and whether it is measured
 * differently from the run before it. Pure.
 */
export function qualityModel(history) {
  const runs = (Array.isArray(history) ? history : Array.isArray(history?.runs) ? history.runs : [])
    .filter((run) => run && typeof run === "object")
    .filter((run) => run.partial !== true && run.replayed !== true);
  if (runs.length === 0) return { state: "none", words: "Not evaluated yet." };
  const latest = runs[0];
  const samples = Number(latest.samples ?? latest.sampleCount ?? latest.n);
  const rate = typeof latest.passRate === "number" ? latest.passRate : null;
  const total = Number.isFinite(samples) && samples > 0 ? samples : null;
  const passed = total !== null && rate !== null ? Math.round(rate * total) : null;
  const previous = runs[1];
  return {
    state: "measured",
    runId: typeof latest.runId === "string" ? latest.runId : null,
    words:
      passed !== null && total !== null
        ? `Latest comparable evaluation: ${passed} of ${total} passed · ${total - passed} failed`
        : "Latest comparable evaluation: no pass count recorded",
    skipped: "Skipped cases aren't reported yet.",
    lineageChanged: previous !== undefined && lineageOf(previous) !== lineageOf(latest),
    lineage: LINEAGE.map((field) => latest[field] ?? null),
  };
}

/** The runs a `runs.list` holds that are working now, and those that finished. Pure. */
export function runsModel(list) {
  const items = Array.isArray(list?.items) ? list.items : [];
  const WORKING = new Set(["queued", "starting", "running", "waiting", "parked", "held"]);
  const DONE = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
  return {
    working: items.filter((run) => WORKING.has(run?.state)),
    finished: items.filter((run) => DONE.has(run?.state)),
  };
}

const RUN_WORDS = Object.freeze({
  queued: "Waiting to start",
  starting: "Starting",
  running: "Working",
  waiting: "Waiting for a decision",
  parked: "Waiting for a decision",
  held: "Held while paused",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted, needs a decision",
});

function card(title, children) {
  return el("section", { class: "card ov-card" }, [
    el("h3", { class: "card-title", text: title }),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

const muted = (text) => el("p", { class: "muted", text });

/** The cards that read the versioned API, in Overview order. Each fails on its own. */
export async function v1OverviewCards(ctx) {
  const params = { h: ctx.id };
  const [harness, decisions, runs, delegations, budget] = await Promise.all([
    call("harnesses.get", { params }),
    call("decisions.list", { query: { harness: ctx.id, state: "pending", limit: "5" } }),
    call("runs.list", { params, query: { limit: "20" } }),
    call("delegations.list", { params }),
    call("budget.get", { params }),
  ]);
  const cards = [];
  const loopback =
    typeof window === "undefined" ||
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(window.location.hostname);
  if (harness.ok) {
    const strip = headerStripModel(harness.body, {
      loopback,
      host: typeof window === "undefined" ? null : window.location.hostname,
    });
    cards.push(
      card("Status", [
        el("p", null, [
          el("span", { class: `dot dot-${strip.dot}`, "aria-hidden": "true" }),
          el("span", { text: ` ${strip.word}` }),
        ]),
        el("p", { text: strip.host }),
        muted(strip.keeps),
        strip.lastVerified !== null
          ? el("p", { class: "muted" }, [
              el("span", { text: "Last verified " }),
              timeEl(strip.lastVerified),
            ])
          : muted("Contact not tracked for this build."),
      ]),
    );
    cards.push(card("Purpose", el("p", { text: purposeWords(harness.body) })));
    const saved = harness.body?.savedSpecHash;
    const deployed = harness.body?.deployedSpecHash;
    if (typeof saved === "string" && typeof deployed === "string" && saved !== deployed) {
      cards.push(
        card("Saved vs deployed", [
          el("p", { text: "Saved changes are not active yet." }),
          el("a", {
            class: "btn",
            href: hrefHarness(ctx.id, "setup", "deployment"),
            text: "Review and activate",
          }),
        ]),
      );
    }
  } else {
    cards.push(card("Status", muted("This harness's status could not be read.")));
  }
  if (decisions.ok) {
    const name = harness.ok && typeof harness.body?.name === "string" ? harness.body.name : null;
    const model = needsYouCardModel(decisions.body, name);
    cards.push(
      card("Needs you", [
        ...model.pending.slice(0, 3).map((d) => renderDecisionCard(d)),
        model.empty !== null ? muted(model.empty) : null,
        ...model.notes.map((note) => muted(note)),
        el("a", { href: "#/home/needs-you", text: "Everything that needs you" }),
      ]),
    );
  } else {
    cards.push(card("Needs you", muted("What needs you here could not be read.")));
  }
  if (runs.ok) {
    const { working, finished } = runsModel(runs.body);
    const line = (run, stoppable = false) =>
      el("li", null, [
        el("a", {
          class: "mono",
          href: `#/i/${ctx.id}/run/${String(run.id)}`,
          text: String(run.id),
        }),
        el("span", { text: ` ${RUN_WORDS[run.state] ?? String(run.state)}` }),
        stoppable ? stopRun(ctx, run) : null,
      ]);
    cards.push(
      card(
        "Working now",
        working.length === 0
          ? muted("Nothing is running.")
          : el(
              "ul",
              { class: "home-list" },
              working.slice(0, 5).map((run) => line(run, true)),
            ),
      ),
    );
    cards.push(
      card(
        "Recent outcomes",
        finished.length === 0
          ? muted("No finished work yet.")
          : el(
              "ul",
              { class: "home-list" },
              finished.slice(0, 5).map((run) => line(run)),
            ),
      ),
    );
  } else {
    cards.push(card("Working now", muted("This harness's runs could not be read.")));
  }
  cards.push(
    limitsCard(ctx, delegations.ok ? delegations.body : null, budget.ok ? budget.body : null),
  );
  return cards;
}

/**
 * The Operating limits card. A failed read of the delegation rules offers a retry, which
 * redraws the lines in place and puts focus on the card's heading.
 */
function limitsCard(ctx, delegations, budget) {
  const heading = el("h3", { class: "card-title", text: "Operating limits", tabindex: "-1" });
  const linesOf = (rules) =>
    operatingLimitsModel(rules, budget, ctx.id).map((line) =>
      el("li", null, [
        el("span", { text: line.text }),
        line.review !== undefined
          ? el("a", { class: "btn btn-ghost", href: line.review, text: "Review" })
          : null,
        line.retry === true
          ? el("button", {
              class: "btn btn-ghost",
              type: "button",
              text: "Try again",
              onClick: async () => {
                const again = await call("delegations.list", { params: { h: ctx.id } });
                list.replaceChildren(...linesOf(again.ok ? again.body : null));
                heading.focus();
              },
            })
          : null,
      ]),
    );
  const list = el("ul", { class: "home-list" }, linesOf(delegations));
  return el("section", { class: "card ov-card" }, [heading, list]);
}

/**
 * Stop this run: it stops at the next safe point, and anything it already did outside
 * CrewHaus stays done. One action, its receipt said in place.
 */
function stopRun(ctx, run) {
  const status = el("span", { class: "muted", role: "status", "aria-live": "polite" });
  const holder = el("span", { class: "stop-run" });
  const ask = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Stop this run",
    onClick: () => {
      const yes = el("button", {
        class: "btn btn-danger",
        type: "button",
        text: "Stop it",
        onClick: async () => {
          const answer = await createAction("runs.cancel", {
            params: { run: String(run.id) },
            query: { harness: ctx.id },
            body: {},
          }).run();
          status.textContent = answer.ok
            ? `Stop asked · ${answer.body?.receipt?.state === "succeeded" ? "Done" : "Accepted"}`
            : String(answer.error?.message ?? "It was not stopped.");
        },
      });
      holder.replaceChildren(
        el("span", {
          text: "It stops at the next safe point. Anything it already did outside CrewHaus stays done.",
        }),
        yes,
        el("code", {
          class: "twin-cmd mono",
          tabindex: "0",
          text: `crewhaus runs cancel ${String(run.id)} --harness ${ctx.id}`,
        }),
        status,
      );
      yes.focus();
    },
  });
  holder.appendChild(ask);
  return holder;
}

/** The Quality card, from the legacy eval history the Overview already reads. */
export function qualityCard(history, harness) {
  const model = qualityModel(history);
  if (model.state === "none") {
    return card("Quality", [
      muted(model.words),
      el("a", { href: hrefHarness(harness, "quality", "results"), text: "Run an evaluation" }),
    ]);
  }
  return card("Quality", [
    el("p", { text: model.words }),
    muted(model.skipped),
    model.lineageChanged ? muted("Measured differently from here on.") : null,
    model.runId !== null
      ? el("a", {
          href: hrefHarness(harness, "quality", "results", model.runId),
          text: "Inspect failures",
        })
      : null,
  ]);
}
