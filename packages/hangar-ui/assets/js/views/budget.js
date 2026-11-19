/**
 * Overview › Budget: the harness's spending period (#516), read through `budget.get` and
 * raised through `budget.extend`, both by operation id in `v1.js`. The states, each in
 * words beside its colour:
 *
 *   - no period: each run keeps only its own cap, with the verb that shows it;
 *   - under the limit: a bar and "$12.40 of $50.00 used this month";
 *   - spend with no price: "+ unknown", and "Add a price" with `crewhaus models audit`,
 *     in the used-up state too;
 *   - a capped or damaged ledger read: the totals are lower bounds, and the card says so;
 *   - used up: "New work waits until 1 Dec", and the raise form for a caller the server
 *     says may raise it (`you.extend`), or "Ask a maintainer to raise the limit." with
 *     the CLI twin otherwise (a 403 on submit says the same);
 *   - a spec that could not be read: the limit is unknown, never "no limit";
 *   - enforcement unavailable: the build is older than spending periods; `crewhaus compile`.
 *
 * Every renewal day is read in the period's own zone (`fold.timezone`). Every action
 * shows its exact CLI twin, for this harness (`--harness <id>`); the raise's twin follows
 * the typed amount and the chosen reason. After a raise, the card is drawn again, the
 * sentence that says so stays on screen outside the redrawn part and is announced once,
 * and focus moves to the card's heading. DOM by `createElement` and `textContent` only;
 * the models below are pure, so the tests read them without a DOM.
 */

import { el, statusBadge } from "../dom.js";
import { announce } from "../ui/live.js";
import { call, createAction } from "../v1.js";

/** The words the card says, in one place. */
export const BUDGET_COPY = Object.freeze({
  title: "Spending limit",
  noPeriod: "No limit for a period: each run keeps only its own cap.",
  specUnreadable: "The harness's spec could not be read, so its spending limit is unknown.",
  unknown:
    "Some calls used a model with no price, so their cost is unknown and the spend shown is a lower bound.",
  lowerBound: "Some spend records could not be read, so these totals are lower bounds.",
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
});

/** The reasons a raise may give, as the contract closes them, with their words. */
export const REASONS = Object.freeze([
  ["planned-work", "Planned work"],
  ["incident", "An incident"],
  ["one-off", "A one-off"],
  ["other", "Something else"],
]);

/**
 * The exact CLI twins for one harness: run from any directory, each reaches this
 * harness. `extend` takes the typed amount and the chosen reason code when there are
 * any, and names the choices when there are none.
 */
export function budgetVerbs(harness) {
  const at = `--harness ${harness}`;
  const codes = REASONS.map(([code]) => code).join("|");
  return {
    show: `crewhaus budget show ${at}`,
    extend: (usd, reasonCode) => {
      const amount = typeof usd === "number" && usd > 0 ? usd.toFixed(2) : "<amount>";
      const reason = REASONS.some(([code]) => code === reasonCode) ? reasonCode : `<${codes}>`;
      return `crewhaus budget extend ${at} --usd ${amount} --reason ${reason}`;
    },
  };
}

const PERIOD_WORD = Object.freeze({ day: "today", week: "this week", month: "this month" });

const dollars = (micros) =>
  typeof micros === "number" && Number.isFinite(micros)
    ? `$${(micros / 1_000_000).toFixed(2)}`
    : "—";

/**
 * `1 Dec`: the day a period renews, in the period's own zone, so a period that renews
 * at local midnight names that local day. An unknown zone reads in UTC.
 */
export function shortDate(iso, timeZone = "UTC") {
  const at = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(at)) return "its renewal";
  const options = { day: "numeric", month: "short" };
  try {
    return new Date(at).toLocaleDateString("en-GB", { ...options, timeZone });
  } catch {
    return new Date(at).toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });
  }
}

/**
 * The card's model from a `budget.get` answer, for harness `harness`: `{state, words,
 * ratio?, …}`. `state` is one of `none`, `ok`, `unknown`, `used-up`, `unreadable`;
 * `tone` is the traffic light the words carry. `unknown` (calls with no price) and
 * `lowerBound` (a capped or damaged ledger read) hold in every state that has a fold;
 * `canExtend` is the server's `you.extend`, and only `true` offers the raise.
 */
export function budgetModel(body, harness = "<harness>") {
  const verbs = budgetVerbs(harness);
  if (body === null || typeof body !== "object") {
    return { state: "unreadable", tone: "warn", words: "The spending limit could not be read." };
  }
  const canExtend = body.you?.extend === true;
  if (body.present !== true || typeof body.fold !== "object" || body.fold === null) {
    if (body.why === "spec_unreadable") {
      return {
        state: "unreadable",
        tone: "warn",
        words:
          typeof body.note === "string" && body.note !== ""
            ? body.note
            : BUDGET_COPY.specUnreadable,
        ...(typeof body.verb === "string" ? { verb: body.verb } : {}),
      };
    }
    return { state: "none", tone: "ok", words: BUDGET_COPY.noPeriod, verb: verbs.show };
  }
  const f = body.fold;
  const timeZone = typeof f.timezone === "string" && f.timezone !== "" ? f.timezone : "UTC";
  const limit = (f.capUsdMicros ?? 0) + (f.extensionsUsdMicros ?? 0);
  const word = PERIOD_WORD[f.every] ?? "this period";
  const unknown = typeof f.unknownCalls === "number" && f.unknownCalls > 0;
  const lowerBound = f.truncated === true || (typeof f.gaps === "number" && f.gaps > 0);
  const used = `${dollars(f.spentUsdMicros)}${unknown ? " + unknown" : ""} of ${dollars(limit)} used ${word}`;
  const ratio =
    limit > 0 ? Math.min(1, ((f.spentUsdMicros ?? 0) + (f.reservedUsdMicros ?? 0)) / limit) : 1;
  const date = shortDate(f.renewsAt, timeZone);
  const tail = lowerBound ? ` ${BUDGET_COPY.lowerBound}` : "";
  const common = {
    ratio,
    unknown,
    lowerBound,
    canExtend,
    periodId: f.periodId,
    every: f.every,
    renewsAt: f.renewsAt,
    timeZone,
  };
  if (f.exhausted === true) {
    return {
      ...common,
      state: "used-up",
      tone: "bad",
      words: `${used}. ${BUDGET_COPY.usedUp(date)}${tail}`,
    };
  }
  return {
    ...common,
    state: unknown ? "unknown" : "ok",
    tone: unknown || lowerBound ? "warn" : ratio >= 0.8 ? "warn" : "ok",
    words: `${used}. ${BUDGET_COPY.renews(date)}${tail}`,
  };
}

const TONE_WORD = Object.freeze({ ok: "On track", warn: "Check", bad: "Used up" });

/** A CLI twin line: "<lead>: <code>verb</code>", "CLI" when no lead is given. */
function twin(verb, lead = "CLI") {
  return el("p", { class: "muted cli-twin" }, [`${lead}: `, el("code", { text: verb })]);
}

/**
 * The raise form: an amount and a reason, both labelled, and the CLI twin that follows
 * them. `onRaised(words)` runs after a raise succeeds; a refusal stays in the form, in
 * its status line, with focus on the amount.
 */
function raiseForm(ctx, model, onRaised) {
  const id = `budget-raise-${String(ctx.id ?? "h").replace(/[^A-Za-z0-9_-]/g, "")}`;
  const verbs = budgetVerbs(ctx.id);
  const status = el("p", {
    id: `${id}-status`,
    class: "muted",
    role: "status",
    "aria-live": "polite",
  });
  const amount = el("input", {
    id: `${id}-usd`,
    type: "number",
    min: "0.01",
    step: "0.01",
    inputmode: "decimal",
    required: "required",
    "aria-describedby": status.id,
  });
  const reason = el(
    "select",
    { id: `${id}-reason`, required: "required" },
    REASONS.map(([value, words]) => el("option", { value, text: words })),
  );
  const command = el("code", { text: verbs.extend(undefined, reason.value) });
  const follow = () => {
    command.textContent = verbs.extend(Number(amount.value), reason.value);
  };
  amount.addEventListener("input", follow);
  reason.addEventListener("change", follow);
  const button = el("button", { type: "submit", class: "btn", text: BUDGET_COPY.submit });
  const form = el("form", { class: "budget-raise" }, [
    el("label", { for: amount.id, text: BUDGET_COPY.amount }),
    amount,
    el("label", { for: reason.id, text: BUDGET_COPY.reason }),
    reason,
    button,
    status,
    el("p", { class: "muted cli-twin" }, ["CLI: ", command]),
  ]);
  const refuse = (message) => {
    status.textContent = message;
    amount.setAttribute("aria-invalid", "true");
    amount.focus();
  };
  const action = createAction("budget.extend", { params: { h: ctx.id } });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const usd = Number(amount.value);
    if (!(usd > 0)) {
      refuse("Enter an amount above $0.");
      return;
    }
    amount.removeAttribute("aria-invalid");
    status.textContent = "";
    button.disabled = true;
    const answer = await action.run({
      body: { usd, reasonCode: reason.value, expect: model.periodId },
    });
    button.disabled = false;
    if (answer.ok) {
      const fold = answer.body?.fold;
      onRaised(
        BUDGET_COPY.raised(
          `$${usd.toFixed(2)}`,
          PERIOD_WORD[model.every] ?? "this period",
          shortDate(fold?.renewsAt ?? model.renewsAt, fold?.timezone ?? model.timeZone),
        ),
      );
      return;
    }
    refuse(
      answer.status === 403 ? BUDGET_COPY.askMaintainer : (answer.error?.message ?? "Not raised."),
    );
  });
  return form;
}

/** The card, for one harness. Reads only; the raise is the one write, and asks first. */
export async function budgetCard(ctx) {
  const headingId = `budget-${ctx.id}`;
  const verbs = budgetVerbs(ctx.id);
  // Outside the redrawn part: what the last raise did stays on screen after the redraw.
  const done = el("p", { class: "budget-done", hidden: true });
  const content = el("div");
  let heading = null;
  const section = el("section", { class: "card ov-card", "aria-labelledby": headingId }, [
    content,
    done,
  ]);
  const render = async () => {
    const [read, caps] = await Promise.all([
      call("budget.get", { params: { h: ctx.id } }),
      call("harnesses.capabilities", { params: { h: ctx.id } }),
    ]);
    const model = budgetModel(read.ok ? read.body : null, ctx.id);
    const period = caps.ok ? caps.body?.capabilities?.["budget.period"] : undefined;
    heading = el("h3", {
      class: "card-title",
      id: headingId,
      tabindex: "-1",
      text: BUDGET_COPY.title,
    });
    const children = [heading];
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
    if (model.unknown === true) {
      children.push(
        el("p", { text: BUDGET_COPY.unknown }),
        twin(BUDGET_COPY.auditVerb, BUDGET_COPY.addPrice),
      );
    }
    if (model.state === "used-up") {
      if (model.canExtend === true) {
        children.push(
          el("details", { class: "budget-raise-wrap" }, [
            el("summary", { text: BUDGET_COPY.raise(PERIOD_WORD[model.every] ?? "this period") }),
            raiseForm(ctx, model, async (words) => {
              await render();
              done.textContent = words;
              done.hidden = false;
              // Announced once, from the console's own region; focus to the redrawn card.
              announce(words);
              heading?.focus();
            }),
          ]),
        );
      } else {
        children.push(el("p", { text: BUDGET_COPY.askMaintainer }), twin(verbs.extend()));
      }
    }
    content.replaceChildren(...children);
  };
  await render();
  return section;
}
