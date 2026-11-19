/**
 * Overview › Budget: the harness's spending period (#516), read through `budget.get` and
 * raised through `budget.extend`, both by operation id in `v1.js`. The states, each in
 * words beside its colour:
 *
 *   - no period: each run keeps only its own cap, with the verb that shows it;
 *   - under the limit: a bar and "$12.40 of $50.00 used this month";
 *   - spend with no price: "+ unknown", and "Add a price" with `crewhaus models audit`;
 *   - used up: "New work waits until 1 Dec", and the raise form (a maintainer's) or
 *     "Ask a maintainer to raise the limit." when the raise is refused for permission;
 *   - enforcement unavailable: the build is older than spending periods; `crewhaus compile`.
 *
 * Every action shows its CLI twin. DOM by `createElement` and `textContent` only; the
 * models below are pure, so the tests read them without a DOM.
 */

import { el, statusBadge } from "../dom.js";
import { announce } from "../ui/live.js";
import { call, createAction } from "../v1.js";

/** The words the card says, in one place. */
export const BUDGET_COPY = Object.freeze({
  title: "Spending limit",
  noPeriod: "No limit for a period: each run keeps only its own cap.",
  noPeriodVerb: "crewhaus budget show",
  unknown:
    "Some calls used a model with no price, so their cost is unknown and the spend shown is a lower bound.",
  addPrice: "Add a price",
  auditVerb: "crewhaus models audit",
  usedUp: (date) => `New work waits until ${date}.`,
  renews: (date) => `Renews on ${date}.`,
  raise: (word) => `Raise ${word}'s limit`,
  askMaintainer: "Ask a maintainer to raise the limit.",
  unsupported: "This build is older than spending periods, so the limit is not enforced yet.",
  compileVerb: "crewhaus compile",
  amount: "Amount to add, in dollars",
  reason: "Reason",
  submit: "Raise the limit",
  raised: (amount, word, date) => `Raised by ${amount} for ${word}. It resets on ${date}.`,
  extendVerb: "crewhaus budget extend --usd <amount> --reason <code>",
});

/** The reasons a raise may give, as the contract closes them, with their words. */
export const REASONS = Object.freeze([
  ["planned-work", "Planned work"],
  ["incident", "An incident"],
  ["one-off", "A one-off"],
  ["other", "Something else"],
]);

const PERIOD_WORD = Object.freeze({ day: "today", week: "this week", month: "this month" });
const RAISE_WORD = Object.freeze({ day: "today", week: "this week", month: "this month" });

const dollars = (micros) =>
  typeof micros === "number" && Number.isFinite(micros)
    ? `$${(micros / 1_000_000).toFixed(2)}`
    : "—";

/** `1 Dec`, in UTC. */
export function shortDate(iso) {
  const at = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(at)) return "its renewal";
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * The card's model from a `budget.get` answer: `{state, words, ratio?, …}`. `state` is
 * one of `none`, `ok`, `unknown`, `used-up`, `unreadable`; `tone` is the traffic light
 * the words carry.
 */
export function budgetModel(body) {
  if (body === null || typeof body !== "object") {
    return { state: "unreadable", tone: "warn", words: "The spending limit could not be read." };
  }
  if (body.present !== true || typeof body.fold !== "object" || body.fold === null) {
    return {
      state: "none",
      tone: "ok",
      words: BUDGET_COPY.noPeriod,
      verb: BUDGET_COPY.noPeriodVerb,
    };
  }
  const f = body.fold;
  const limit = (f.capUsdMicros ?? 0) + (f.extensionsUsdMicros ?? 0);
  const word = PERIOD_WORD[f.every] ?? "this period";
  const unknown = typeof f.unknownCalls === "number" && f.unknownCalls > 0;
  const used = `${dollars(f.spentUsdMicros)}${unknown ? " + unknown" : ""} of ${dollars(limit)} used ${word}`;
  const ratio =
    limit > 0 ? Math.min(1, ((f.spentUsdMicros ?? 0) + (f.reservedUsdMicros ?? 0)) / limit) : 1;
  if (f.exhausted === true) {
    return {
      state: "used-up",
      tone: "bad",
      words: `${used}. ${BUDGET_COPY.usedUp(shortDate(f.renewsAt))}`,
      ratio,
      periodId: f.periodId,
      every: f.every,
      renewsAt: f.renewsAt,
    };
  }
  return {
    state: unknown ? "unknown" : "ok",
    tone: unknown ? "warn" : ratio >= 0.8 ? "warn" : "ok",
    words: `${used}. ${BUDGET_COPY.renews(shortDate(f.renewsAt))}`,
    ratio,
    periodId: f.periodId,
    every: f.every,
    renewsAt: f.renewsAt,
  };
}

const TONE_WORD = Object.freeze({ ok: "On track", warn: "Check", bad: "Used up" });

/** A CLI twin line: "CLI: <code>verb</code>". */
function twin(verb) {
  return el("p", { class: "muted cli-twin" }, ["CLI: ", el("code", { text: verb })]);
}

/** The raise form: an amount and a reason, both labelled, and the CLI twin. */
function raiseForm(ctx, model, onDone) {
  const id = `budget-raise-${String(ctx.id ?? "h").replace(/[^A-Za-z0-9_-]/g, "")}`;
  const amount = el("input", {
    id: `${id}-usd`,
    type: "number",
    min: "0.01",
    step: "0.01",
    inputmode: "decimal",
    required: "required",
  });
  const reason = el(
    "select",
    { id: `${id}-reason`, required: "required" },
    REASONS.map(([value, words]) => el("option", { value, text: words })),
  );
  const status = el("p", { class: "muted", role: "status", "aria-live": "polite" });
  const button = el("button", { type: "submit", class: "btn", text: BUDGET_COPY.submit });
  const form = el("form", { class: "budget-raise" }, [
    el("label", { for: amount.id, text: BUDGET_COPY.amount }),
    amount,
    el("label", { for: reason.id, text: BUDGET_COPY.reason }),
    reason,
    button,
    status,
    twin(BUDGET_COPY.extendVerb),
  ]);
  const action = createAction("budget.extend", { params: { h: ctx.id } });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const usd = Number(amount.value);
    if (!(usd > 0)) {
      status.textContent = "Enter an amount above $0.";
      amount.focus();
      return;
    }
    button.disabled = true;
    const answer = await action.run({
      body: { usd, reasonCode: reason.value, expect: model.periodId },
    });
    button.disabled = false;
    if (answer.ok) {
      const words = BUDGET_COPY.raised(
        `$${usd.toFixed(2)}`,
        RAISE_WORD[model.every] ?? "this period",
        shortDate(answer.body?.fold?.renewsAt ?? model.renewsAt),
      );
      status.textContent = words;
      announce(words);
      onDone();
      return;
    }
    status.textContent =
      answer.status === 403 ? BUDGET_COPY.askMaintainer : (answer.error?.message ?? "Not raised.");
  });
  return form;
}

/** The card, for one harness. Reads only; the raise is the one write, and asks first. */
export async function budgetCard(ctx) {
  const section = el("section", { class: "card ov-card", "aria-labelledby": `budget-${ctx.id}` });
  const render = async () => {
    const [read, caps] = await Promise.all([
      call("budget.get", { params: { h: ctx.id } }),
      call("harnesses.capabilities", { params: { h: ctx.id } }),
    ]);
    const model = budgetModel(read.ok ? read.body : null);
    const period = caps.ok ? caps.body?.capabilities?.["budget.period"] : undefined;
    const children = [
      el("h3", { class: "card-title", id: `budget-${ctx.id}`, text: BUDGET_COPY.title }),
    ];
    if (model.state !== "none" && period?.supported === false) {
      children.push(el("p", { text: BUDGET_COPY.unsupported }), twin(BUDGET_COPY.compileVerb));
    }
    children.push(
      el("p", { class: "budget-state" }, [
        statusBadge(model.tone, TONE_WORD[model.tone] ?? ""),
        el("span", { text: ` ${model.words}` }),
      ]),
    );
    if (typeof model.ratio === "number") {
      children.push(
        el("progress", {
          max: "100",
          value: String(Math.round(model.ratio * 100)),
          "aria-label": `${Math.round(model.ratio * 100)}% of the limit used or held`,
        }),
      );
    }
    if (model.verb !== undefined) children.push(twin(model.verb));
    if (model.state === "unknown") {
      children.push(el("p", { text: BUDGET_COPY.unknown }), twin(BUDGET_COPY.auditVerb));
    }
    if (model.state === "used-up") {
      children.push(
        el("details", { class: "budget-raise-wrap" }, [
          el("summary", { text: BUDGET_COPY.raise(RAISE_WORD[model.every] ?? "this period") }),
          raiseForm(ctx, model, () => {
            void render();
          }),
        ]),
      );
    }
    section.replaceChildren(...children);
  };
  await render();
  return section;
}
