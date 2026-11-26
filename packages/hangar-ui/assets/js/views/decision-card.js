/**
 * One decision card, everywhere a decision is shown: what is asked, in which harness,
 * which run asked (an object link), the full input when the caller may read it, the
 * places it acts on, what it supersedes, who may decide, what it is bound to, its
 * deadline and fallback, its state in words, and who decided it, in the server's own
 * words (`decidedByText`), shown as they are. The client never composes "decided by".
 *
 * Choosing sends the decision's binding digest as `expect`: a 412 says "This changed
 * since you opened it" with the record as it is now, and `already_decided` says who
 * decided and through which door. A one-key choice only arms its button; Enter confirms.
 *
 * `decisionCardModel` is pure; `renderDecisionCard` builds DOM with `el` only.
 */

import { el } from "../dom.js";
import { hrefHarness } from "../router.js";
import { createAction } from "../v1.js";

/** A decision's state, in words. */
export const DECISION_STATE_WORDS = Object.freeze({
  pending: "Waiting",
  granted: "Granted",
  denied: "Denied",
  expired: "Expired",
  superseded: "Superseded",
  consumed: "Used",
});

/** The door a decision came through, in words. */
const DOOR_WORDS = Object.freeze({
  home: "in Home",
  cli: "from the command line",
  slack: "in Slack",
  sdk: "through the API",
  github: "on GitHub",
  resident: "by the harness's resident",
  system: "by Home",
});

const CLASS_WORDS = Object.freeze({
  operator: "Needs an Operator",
  maintainer: "Needs a Maintainer",
  owner: "Needs an Owner",
});

const FALLBACK_WORDS = Object.freeze({
  deny: "If no one answers in time, it is denied.",
  "carry-on": "If no one answers in time, it carries on with other work.",
  grant: "If no one answers in time, it goes ahead.",
});

const KIND_WORDS = Object.freeze({
  merge: "Merge",
  rollout: "Roll out",
  "change-adoption": "Adopt a change",
  "standing-rule-proposal": "Allow it from now on",
});

const text = (value) => (typeof value === "string" && value !== "" ? value : null);

/** A deadline as a person reads it: `14 Nov, 14:00`. Pure. */
export function deadlineWords(iso) {
  const at = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(at)) return "its deadline";
  return new Date(at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The card's model. Pure: no DOM, no clock but `nowMs`. */
export function decisionCardModel(decision, nowMs = Date.now()) {
  const d = decision && typeof decision === "object" ? decision : {};
  const harness = text(d.harness);
  const id = text(d.id) ?? "";
  const ref = text(d.ref) ?? (harness !== null ? `${harness}/decision/${id}` : null);
  const state = text(d.state) ?? "pending";
  const tool = text(d.toolName);
  const kind = text(d.kind);
  const title =
    tool !== null
      ? `Approve or deny: ${tool}`
      : kind !== null && Object.hasOwn(KIND_WORDS, kind)
        ? KIND_WORDS[kind]
        : "A decision";
  const runId = text(d.runId);
  const places = Array.isArray(d.places) ? d.places.filter((p) => p && typeof p === "object") : [];
  const supersedes = d.supersedes && typeof d.supersedes === "object" ? d.supersedes : null;
  const expires = Date.parse(String(d.expiresAt ?? ""));
  const binding =
    typeof d.bindingDigest === "string" && d.bindingDigest !== ""
      ? "Bound to this run and this spec revision"
      : tool !== null
        ? "Resource version not bound"
        : null;
  return {
    id,
    ref,
    harness,
    title,
    state,
    stateWords: DECISION_STATE_WORDS[state] ?? state,
    pending: state === "pending",
    runHref: runId !== null && harness !== null ? `#/i/${harness}/run/${runId}` : null,
    runId,
    input:
      d.inputWithheld === true
        ? { shown: false, note: "You may not read this harness's content, so the input is hidden." }
        : Object.hasOwn(d, "input")
          ? { shown: true, value: d.input }
          : null,
    places,
    supersedes,
    classNeeded: CLASS_WORDS[text(d.requiredClass) ?? ""] ?? null,
    binding,
    deadline: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
    overdue:
      d.overdue === true || (Number.isFinite(expires) && expires <= nowMs && state === "pending"),
    fallback: FALLBACK_WORDS[text(d.fallback) ?? text(d.ifUnanswered) ?? ""] ?? null,
    // The server's words, shown as they are.
    decidedByText: text(d.decidedByText),
    door: DOOR_WORDS[text(d.decidedVia) ?? ""] ?? null,
    decidedAt: text(d.decidedAt),
    expect: text(d.bindingDigest),
    choices: state === "pending" ? ["grant", "deny"] : [],
  };
}

/** What a refused choice says, from the API's answer. Pure. */
export function choiceRefusalWords(answer) {
  const error = answer?.error ?? {};
  if (answer?.status === 412) return "This changed since you opened it.";
  if (error.code === "already_decided" || answer?.status === 409) {
    const current = error.current && typeof error.current === "object" ? error.current : {};
    const who = text(current.decidedByText);
    const door = DOOR_WORDS[text(current.surface) ?? ""] ?? null;
    return [
      "Someone already decided this.",
      ...(who !== null ? [`${who}.`] : []),
      ...(door !== null ? [`It was decided ${door}.`] : []),
    ].join(" ");
  }
  return typeof error.message === "string" ? error.message : "That choice was not made.";
}

/**
 * Send one choice: one action, so a retry sends the same key. Answers the API's answer.
 * `deps.createAction` is injected by a test.
 */
export function chooseDecision(model, choice, deps = { createAction }) {
  const action = deps.createAction("decisions.resolve", {
    params: { ref: model.ref ?? "" },
    body: { choice, ...(model.expect !== null ? { expect: model.expect } : {}) },
  });
  return action.run();
}

const CHOICE_LABEL = Object.freeze({ grant: "Grant", deny: "Deny" });

/** The card, built with `el` only. `opts.onDecided(answer)` hears each answer. */
export function renderDecisionCard(decision, opts = {}) {
  const model = decisionCardModel(decision, opts.nowMs ?? Date.now());
  const status = el("p", { class: "decision-status", role: "status", "aria-live": "polite" });
  const choose = async (choice) => {
    status.textContent = "Sending…";
    const answer = await chooseDecision(model, choice, opts.deps);
    status.textContent = answer.ok
      ? `${CHOICE_LABEL[choice] ?? choice}: sent.`
      : choiceRefusalWords(answer);
    opts.onDecided?.(answer);
  };
  let armed = null;
  const buttons = model.choices.map((choice) => {
    const button = el("button", {
      class: `btn ${choice === "grant" ? "btn-primary" : "btn-danger"}`,
      type: "button",
      text: CHOICE_LABEL[choice] ?? choice,
      onClick: () => void choose(choice),
    });
    return { choice, button };
  });
  const card = el("article", { class: "card decision-card", "aria-label": model.title }, [
    el("div", { class: "decision-head" }, [
      el("h3", { class: "decision-title", text: model.title }),
      el("span", { class: "chip", text: model.stateWords }),
      model.harness !== null
        ? el("a", { href: hrefHarness(model.harness), text: opts.harnessName ?? model.harness })
        : null,
    ]),
    model.runHref !== null
      ? el("p", null, [
          el("span", { text: "Asked by run " }),
          el("a", { class: "mono", href: model.runHref, text: model.runId }),
        ])
      : null,
    model.input === null
      ? null
      : model.input.shown
        ? el("pre", {
            class: "json decision-input",
            tabindex: "0",
            text: JSON.stringify(model.input.value, null, 2),
          })
        : el("p", { class: "muted", text: model.input.note }),
    model.places.length > 0
      ? el(
          "ul",
          { class: "decision-places", "aria-label": "Where it acts" },
          model.places.map((place) =>
            el("li", {
              class: "mono",
              text: String(place.path ?? place.target ?? place.ref ?? JSON.stringify(place)),
            }),
          ),
        )
      : null,
    model.supersedes !== null
      ? el("p", {
          class: "muted",
          text: `It takes the place of ${String(model.supersedes.id ?? "an earlier request")}.`,
        })
      : null,
    model.classNeeded !== null ? el("p", { class: "muted", text: model.classNeeded }) : null,
    model.binding !== null ? el("p", { class: "muted", text: model.binding }) : null,
    model.deadline !== null && model.pending
      ? el("p", {
          class: "muted",
          text: `${model.overdue ? "Past its deadline of" : "Answer by"} ${deadlineWords(model.deadline)}`,
        })
      : null,
    model.fallback !== null && model.pending
      ? el("p", { class: "muted", text: model.fallback })
      : null,
    model.decidedByText !== null
      ? el("p", { class: "decision-decided-by", text: model.decidedByText })
      : null,
    model.door !== null && !model.pending
      ? el("p", { class: "muted", text: `Decided ${model.door}.` })
      : null,
    buttons.length > 0
      ? el(
          "div",
          { class: "inbox-actions" },
          buttons.map((b) => b.button),
        )
      : null,
    status,
  ]);
  // A one-key choice arms its button; Enter confirms the armed one.
  card.addEventListener?.("keydown", (event) => {
    if (opts.singleKeys === false) return;
    const key = String(event.key ?? "").toLowerCase();
    const pick = key === "g" ? "grant" : key === "d" ? "deny" : null;
    if (pick !== null && model.choices.includes(pick)) {
      armed = pick;
      buttons.find((b) => b.choice === pick)?.button.focus?.();
      status.textContent = `${CHOICE_LABEL[pick]}? Press Enter to confirm.`;
      event.preventDefault?.();
    } else if (
      key === "enter" &&
      armed !== null &&
      event.target === buttons.find((b) => b.choice === armed)?.button
    ) {
      armed = null;
    }
  });
  return card;
}
