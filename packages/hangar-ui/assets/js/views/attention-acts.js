/**
 * What a person does about an item in Needs you: the choices it offers, each with what
 * choosing it does, in words from a closed table; giving it to someone, putting it off,
 * hiding it from yourself, setting a problem aside or taking it up again; and saying
 * something about it. Every one is a named operation of Home's API, sent through `v1.js`.
 *
 * A verdict never goes out on one press: it opens a dialog that says what it does, where
 * Enter confirms and Escape cancels, and a held Enter confirms nothing. What a reader may
 * not do is shown with why (`you`, as Home answered it); Home checks again as they act.
 *
 * The decisions are pure functions this package tests without a browser; the DOM is built
 * with `createElement` and `textContent` only.
 */

import { el } from "../dom.js";
import { hrefFleet, hrefHarness, hrefInspect, screenHref } from "../router.js";
import { openDialog } from "../ui/dialog.js";
import { announce } from "../ui/live.js";
import { call, createAction } from "../v1.js";

/** The `att_` id of a ref. Pure. */
export function itemIdOf(ref) {
  const text = String(ref ?? "");
  return text.slice(text.lastIndexOf("/") + 1);
}

/** The harnesses an item is about. Pure. */
export function harnessesOf(item) {
  if (Array.isArray(item?.harnesses)) return item.harnesses.filter((h) => typeof h === "string");
  return typeof item?.harness === "string" && item.harness !== "" ? [item.harness] : [];
}

/** The one harness an item is about, or `null` for a group across several. Pure. */
export function oneHarness(item) {
  const about = harnessesOf(item);
  return about.length === 1 ? about[0] : null;
}

// ---------------------------------------------------------------------------
// The choices
// ---------------------------------------------------------------------------

/**
 * Every choice an item may offer, by kind: what it does and what choosing it does, in
 * words. `decide` settles something, `act` does something about a problem, and `open`
 * goes to a place. A choice this console does not know is not offered.
 */
export const CHOICES = Object.freeze({
  "permission.grant": ["decide", "Allows this one call, and the run goes on."],
  "permission.deny": ["decide", "Refuses this one call, and the run goes on without it."],
  "permission.grant-always": ["decide", "Allows this call, and calls like it for 30 days."],
  "permission.grant-propose": [
    "decide",
    "Allows this one call, and asks the owner about next time.",
  ],
  "review.pass": ["decide", "Records that the answer is right."],
  "review.fail": ["decide", "Records that the answer is wrong."],
  "review.up": ["decide", "Settles the raters' disagreement as a good answer."],
  "review.down": ["decide", "Settles the raters' disagreement as a bad answer."],
  "standing-rule-proposal.grant": ["decide", "Makes the standing permission that was asked for."],
  "standing-rule-proposal.deny": ["decide", "Refuses the standing permission."],
  "standing-rule-proposal.review": ["open", "Opens what turning it on would allow."],
  "quality-adoption.grant": ["decide", "Says the change may be adopted. Nothing is applied yet."],
  "quality-adoption.deny": ["decide", "Refuses the change. Nothing is applied."],
  "quality-adoption.adopt": ["open", "Opens the change, to review and adopt it."],
  "decision.grant": ["decide", "Allows it to go ahead."],
  "decision.deny": ["decide", "Refuses it. It does not go ahead."],
  "checkpoint.approve": ["decide", "Lets the paused run go on."],
  "checkpoint.reject": ["decide", "Skips the paused step, and the run goes on without it."],
  "deploy-approval.approve": [
    "decide",
    "Adds your approval. Once enough people approve, it can be put there.",
  ],
  "deploy-approval.deny": ["decide", "Refuses it for this environment."],
  "deploy-approval.promote": ["act", "Puts the approved version in the environment."],
  "credential.acknowledge": ["act", "Sets it aside until it fails again."],
  "credential.inspect": ["open", "Opens the runs it stopped."],
  "provider-limit.acknowledge": ["act", "Sets it aside until it happens again."],
  "provider-limit.inspect": ["open", "Opens the runs it stopped."],
  "budget.raise-spec": ["open", "Opens the spec's budget, to raise the limit for good."],
  "budget.raise-period": ["open", "Opens this period's budget, to raise it once."],
  "budget.wait-for-renewal": ["act", "Puts it off until the budget renews."],
  "budget.acknowledge": ["act", "Sets it aside until it happens again."],
  "budget.act": ["act", "Starts the suggested job."],
  "budget.open": ["open", "Opens the budget."],
  "spec.acknowledge": ["act", "Sets it aside until it fails again."],
  "spec.inspect": ["open", "Opens the runs it stopped."],
  "spec.act": ["act", "Starts the suggested job."],
  "spec.open": ["open", "Opens the spec."],
  "run-failures.acknowledge": ["act", "Sets it aside until it fails again."],
  "run-failures.inspect": ["open", "Opens the runs that failed."],
  "security.act": ["act", "Starts the suggested job."],
  "security.open": ["open", "Opens the incident."],
  "quality-regression.act": ["act", "Starts the suggested job."],
  "quality-regression.open": ["open", "Opens the results."],
  "setup.act": ["act", "Starts the suggested job."],
  "setup.open": ["open", "Opens the place that fixes it."],
});

/**
 * An Advisor finding's `act` choice, by the job it starts: its button and what starting it
 * does, the sentence a person confirms before a job that spends model credits or rebuilds
 * the harness. The terminal's table says the same.
 */
export const JOB_CHOICES = Object.freeze({
  doctor: [
    "Run the checks",
    "Checks the harness's setup and says what it finds. It changes nothing.",
  ],
  compile: ["Recompile", "Rebuilds the bundle from the spec."],
  optimize: [
    "Queue an optimize run",
    "Starts an optimize run. It uses model credits and proposes changes for you to review.",
  ],
  "dream-run": ["Run the memory review", "Starts the memory review now. It uses model credits."],
  eval: ["Run the evals", "Starts an eval run. It uses model credits."],
  "route-propose": ["Propose the routing change", "Proposes the routing change for you to review."],
  "route-status": ["Compare the models", "Shows how the models compare. It changes nothing."],
  "models-explain": [
    "Explain the routing",
    "Explains which model each step uses. It changes nothing.",
  ],
  "models-audit": ["Audit the models", "Checks the models in use. It changes nothing."],
});

/** The screens an `open` choice may name: where the console keeps a finding's fix. */
export const PLACES = Object.freeze([
  "overview",
  "approvals",
  "spec",
  "runs",
  "schedulers",
  "evals",
  "memory",
  "feedback",
  "costs",
  "models",
  "creds",
  "channels",
  "security",
  "deploy",
  "dev",
]);

/** What an `open` choice that names no screen says, and where it goes instead. */
const IN_ADVICE = Object.freeze(["Open in Advice", "Opens the suggestion in Advice."]);

/** The screen an item's `open` choice names, or `null`. Pure. */
function placeOfChoice(item) {
  const list = Array.isArray(item?.choices) ? item.choices : [];
  const place = list.find((c) => c?.id === "open")?.place;
  return typeof place === "string" && PLACES.includes(place) ? place : null;
}

/** The job an `act` choice names, or `null`. Pure. */
function jobOf(choice) {
  const job = choice?.job;
  return typeof job === "string" && Object.hasOwn(JOB_CHOICES, job) ? job : null;
}

/** A choice's button, by kind and choice, else by choice. */
const CHOICE_LABELS = Object.freeze({
  "permission.grant": "Allow once",
  "permission.grant-always": "Allow from now on",
  "permission.grant-propose": "Allow, and ask the owner",
  grant: "Allow",
  deny: "Refuse",
  pass: "Pass",
  fail: "Fail",
  up: "Good answer",
  down: "Bad answer",
  approve: "Approve",
  reject: "Reject",
  promote: "Put it there",
  acknowledge: "Acknowledge",
  inspect: "See the runs",
  "raise-spec": "Raise the limit in the spec",
  "raise-period": "Raise this period's limit",
  "wait-for-renewal": "Wait for renewal",
  act: "Start the suggested job",
  "budget.open": "Open the budget",
  "spec.open": "Open the spec",
  "security.open": "Open the incident",
  "quality-regression.open": "Open the results",
  "setup.open": "Open where it is fixed",
  open: "Open in Advice",
  adopt: "Review and adopt",
  review: "See what it would allow",
});

/** What a carried-out choice is announced as. */
const DONE_WORDS = Object.freeze({
  grant: "Allowed.",
  "grant-always": "Allowed, and calls like it.",
  "grant-propose": "Allowed once. The owner is asked about next time.",
  deny: "Refused.",
  approve: "Approved.",
  reject: "Rejected.",
  pass: "Passed.",
  fail: "Failed.",
  up: "Settled as a good answer.",
  down: "Settled as a bad answer.",
  promote: "Started.",
  act: "Queued.",
  acknowledge: "Acknowledged.",
  "wait-for-renewal": "Put off until the budget renews.",
});

/** What a missing permission means, in words. */
const PERMISSION_WORDS = Object.freeze({
  "h.deploy": "You can't deploy here.",
  "h.spec.edit": "You can't edit the spec here.",
  "h.budget.extend": "You can't raise the budget here.",
});

const CLASS_RANK = Object.freeze({ operator: 1, maintainer: 2, owner: 3 });

/** Who may decide, as words. Pure. */
export function classWord(requiredClass) {
  if (requiredClass === "owner") return "Owner only";
  if (requiredClass === "maintainer") return "Needs a maintainer";
  return "Needs an operator";
}

/** A choice's button. Pure. */
export function choiceLabel(kind, id) {
  const own = `${kind}.${id}`;
  if (Object.hasOwn(CHOICE_LABELS, own)) return CHOICE_LABELS[own];
  return Object.hasOwn(CHOICE_LABELS, id) ? CHOICE_LABELS[id] : id;
}

/** What a choice does, and what choosing it does; `null` for one no table knows. Pure. */
export function choiceRow(kind, id) {
  const key = `${kind}.${id}`;
  if (!Object.hasOwn(CHOICES, key)) return null;
  const [does, effect] = CHOICES[key];
  return { does, effect };
}

/**
 * What the reader may do about an item, from the list's `you` rows: whether they may act,
 * the highest class they decide at, which named permissions they hold, whether they may
 * read its content, and where. An answer with no rows leaves everything to Home. Pure.
 */
export function reachOf(you, item) {
  const about = harnessesOf(item);
  const rows = (Array.isArray(you) ? you : []).filter((row) => about.includes(row?.harness));
  if (rows.length === 0) {
    return { known: false, act: true, rank: 3, can: null, content: true, harnesses: about };
  }
  const acting = rows.filter((row) => row.act === true);
  return {
    known: true,
    act: acting.length > 0,
    rank: Math.max(0, ...acting.map((row) => CLASS_RANK[row.class] ?? 0)),
    can: new Set(acting.flatMap((row) => (Array.isArray(row.can) ? row.can : []))),
    content: rows.some((row) => row.content === true),
    harnesses: acting.map((row) => row.harness),
  };
}

/** Why the reader may not take a class of thing here, or `null`. Pure. */
function classGap(reach, needs) {
  if (!reach.act) return "You can read this, but not act on it.";
  return reach.rank >= (CLASS_RANK[needs] ?? 1) ? null : `${classWord(needs)}.`;
}

/** Where an `open` choice goes, or `null` when it names nothing here. Pure. */
export function openHref(item, id) {
  const harness = oneHarness(item);
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  const ref = typeof evidence[0]?.ref === "string" ? evidence[0].ref : null;
  switch (id) {
    case "raise-spec":
      return harness === null ? null : hrefHarness(harness, "setup", "budget");
    case "raise-period":
      return harness === null ? null : hrefHarness(harness);
    case "inspect":
      if (Number(item?.affected?.count ?? 0) === 1 && ref !== null) return hrefInspect(ref);
      return harness === null ? hrefFleet("home", "working") : hrefHarness(harness, "work", "runs");
    case "adopt":
      return ref === null ? null : hrefInspect(ref);
    case "review": {
      if (harness === null) return null;
      const action = item?.title?.params?.delegationAction;
      return typeof action === "string" && action !== "" && action !== "unknown"
        ? hrefHarness(harness, "setup", "delegations", "new", action, item?.source?.id)
        : hrefHarness(harness, "setup", "delegations");
    }
    case "open": {
      // The screen the finding names, on its harness; with none, the suggestion in Advice.
      const place = placeOfChoice(item);
      return place !== null && harness !== null
        ? screenHref(harness, place)
        : hrefFleet("home", "needs-you", { type: "advice" });
    }
    default:
      return null;
  }
}

/**
 * The choices a card shows: each with its button, what choosing it does, where it goes or
 * why the reader may not take it, and its exact command or why there is none. An owner is
 * offered "from now on" and anyone else asking them. Pure.
 */
export function choiceModels(item, you) {
  const list = Array.isArray(item?.choices) ? item.choices : [];
  const reach = reachOf(you, item);
  const owner = reach.known ? reach.rank >= CLASS_RANK.owner : null;
  return list.flatMap((choice) => {
    const id = typeof choice?.id === "string" ? choice.id : "";
    const row = choiceRow(item?.kind, id);
    if (row === null) return [];
    if (owner === true && id === "grant-propose") return [];
    if (owner === false && id === "grant-always") return [];
    const href = row.does === "open" ? openHref(item, id) : null;
    if (row.does === "open" && href === null) return [];
    const twin =
      typeof choice.cliTwin === "string" && choice.cliTwin !== "" ? choice.cliTwin : null;
    const lacks =
      typeof choice.permission === "string" &&
      reach.can !== null &&
      !reach.can.has(choice.permission)
        ? (PERMISSION_WORDS[choice.permission] ?? `You lack ${choice.permission} here.`)
        : null;
    const why =
      row.does === "open" ? lacks : (classGap(reach, choice.needs ?? item?.requiredClass) ?? lacks);
    // A job is worded by what it does; a screen that is not named opens Advice, and says so.
    const job = id === "act" ? jobOf(choice) : null;
    const advice = id === "open" && (placeOfChoice(item) === null || oneHarness(item) === null);
    const [label, effect] =
      job !== null
        ? JOB_CHOICES[job]
        : advice
          ? IN_ADVICE
          : [choiceLabel(item?.kind, id), row.effect];
    return [
      {
        id,
        label,
        does: row.does,
        effect,
        href,
        why,
        twin,
        reason:
          twin !== null
            ? null
            : typeof choice.nullReason === "string" && choice.nullReason !== ""
              ? choice.nullReason
              : "There is no command for this.",
      },
    ];
  });
}

/** The letters that choose a verdict while a card has focus, and what each may choose. */
export const VERDICT_KEYS = Object.freeze({
  g: Object.freeze(["grant", "approve"]),
  d: Object.freeze(["deny", "reject", "down"]),
  p: Object.freeze(["pass"]),
  f: Object.freeze(["fail"]),
  u: Object.freeze(["up"]),
});

/** The verdict a letter chooses on an item, when single-key shortcuts are on. Pure. */
export function verdictOf(key, models, singleKeys) {
  if (!singleKeys || !Object.hasOwn(VERDICT_KEYS, key)) return null;
  const wanted = VERDICT_KEYS[key];
  return models.find((m) => wanted.includes(m.id) && m.why === null && m.does === "decide") ?? null;
}

/** Whether a choice asks before it goes out: what sets a problem aside can be taken up again. */
export function asksFirst(model) {
  return model.does === "decide" || model.id === "promote" || model.id === "act";
}

/** What is announced after an act, with what is left in the list. Pure. */
export function afterWords(words, left) {
  const n = Number(left);
  return `${words} ${n > 0 ? `${n} left.` : "Nothing is left."}`;
}

/** What a choice is announced as. Pure. */
export function doneWords(id) {
  return Object.hasOwn(DONE_WORDS, id) ? DONE_WORDS[id] : "Done.";
}

// ---------------------------------------------------------------------------
// Everything else a person does about an item
// ---------------------------------------------------------------------------

const OPEN_STATES = new Set(["open", "assigned", "deferred"]);

/**
 * The acts beside an item's choices, each with why the reader may not take it: give it to
 * someone, hide it from yourself, put it off or bring it back, set a problem aside or take
 * it up again. Pure.
 */
export function sideActs(item, you) {
  const reach = reachOf(you, item);
  const acts = [];
  const add = (id, label, why) => acts.push({ id, label, why: why ?? null });
  const open = OPEN_STATES.has(item?.state);
  const decides = item?.band === "decide";
  const mayAct = reach.act ? null : "You can read this, but not act on it.";
  if (open) {
    add("assign", typeof item?.assignee === "string" ? "Reassign…" : "Assign…", mayAct);
    add("snooze", "Remind me later…", null);
    if (item?.state === "deferred" && item?.deferral?.deadlineMoved === false) {
      add("undefer", "Bring it back", classGap(reach, item?.requiredClass));
    } else if (item?.kind !== "question") {
      add("defer", "Put off…", classGap(reach, item?.requiredClass));
    }
    if (!decides) add("dismiss", "Set aside…", mayAct);
  } else if (
    !decides &&
    item?.state === "resolved" &&
    (item?.resolution?.how === "dismissed" || item?.resolution?.how === "acted")
  ) {
    add("reopen", "Take up again", mayAct);
  }
  return acts;
}

/** Why something is put off, with its words. */
export const DEFER_REASONS = Object.freeze([
  Object.freeze({ value: "awaiting-information", label: "Waiting for information" }),
  Object.freeze({ value: "awaiting-someone", label: "Waiting for someone" }),
  Object.freeze({ value: "scheduled", label: "Planned for later" }),
  Object.freeze({ value: "other", label: "Something else" }),
]);

/** Why something is set aside, with its words. */
export const DISMISS_REASONS = Object.freeze([
  Object.freeze({ value: "known", label: "We know about it" }),
  Object.freeze({ value: "not-a-problem", label: "It isn't a problem" }),
  Object.freeze({ value: "handled-elsewhere", label: "It's handled elsewhere" }),
  Object.freeze({ value: "not-now", label: "Not now" }),
  Object.freeze({ value: "other", label: "Something else" }),
]);

/** The times a person may pick without typing one, from a clock. Pure. */
export function whenChoices(nowMs) {
  const hour = new Date(nowMs + 3_600_000);
  const tomorrow = new Date(nowMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const week = new Date(nowMs);
  week.setDate(week.getDate() + 7);
  week.setHours(9, 0, 0, 0);
  return [
    { value: "hour", label: "In an hour", at: hour.toISOString() },
    { value: "tomorrow", label: "Tomorrow at 9:00", at: tomorrow.toISOString() },
    { value: "week", label: "In a week", at: week.toISOString() },
    { value: "other", label: "Another time", at: null },
  ];
}

/** A typed local time as the API takes it, or `null` for one that is not ahead. Pure. */
export function typedTime(value, nowMs) {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) && ms > nowMs ? new Date(ms).toISOString() : null;
}

/** The exact command of an act beside the choices. Pure. */
export function sideTwin(act, ref, fields = {}) {
  const att = itemIdOf(ref);
  const until = typeof fields.until === "string" ? fields.until : "<time>";
  switch (act) {
    case "assign":
      return typeof fields.to === "string"
        ? `crewhaus inbox assign ${att} --to ${fields.to}`
        : `crewhaus inbox unassign ${att}`;
    case "snooze":
      return `crewhaus inbox snooze ${att} --until ${until}`;
    case "defer":
      return `crewhaus inbox defer ${att} --until ${until} --reason ${fields.reason ?? "other"}`;
    case "undefer":
      return `crewhaus inbox undefer ${att}`;
    case "dismiss":
      return `crewhaus inbox dismiss ${att} --reason ${fields.reason ?? "other"}`;
    case "reopen":
      return `crewhaus inbox reopen ${att}`;
    default:
      return `crewhaus inbox show ${att}`;
  }
}

/** What a refused act says: Home's words, and its command when it names one. Pure. */
export function problemText(error) {
  const message =
    typeof error?.message === "string" && error.message !== ""
      ? error.message
      : "Home could not do that.";
  return typeof error?.verb === "string" ? `${message} Try: ${error.verb}` : message;
}

/** Whether a refusal says the list is out of date. Pure. */
export function isStale(answer) {
  return answer?.status === 404 || answer?.status === 409 || answer?.status === 412;
}

/**
 * Carry one act out in each harness it is made in. Answers `{ok, detail?, error?, status}`:
 * ok when every one took it, and the first refusal otherwise. An act that may not have
 * reached Home keeps its key in `deps.kept`, so trying again is the same action.
 */
export async function carryOut(operation, item, harnesses, bodyOf, deps = {}) {
  const make = deps.createAction ?? createAction;
  const kept = deps.kept ?? new Map();
  let detail;
  let refused;
  for (const harness of harnesses) {
    const { params, body } = bodyOf(harness);
    const same = JSON.stringify([operation, params, body]);
    const action = kept.get(same) ?? make(operation, { params, body });
    const answer = await action.run();
    if (!answer.ok && (answer.status === 0 || answer.status >= 500)) kept.set(same, action);
    else kept.delete(same);
    if (!answer.ok) {
      refused ??= answer;
      continue;
    }
    if (typeof answer.body?.detail === "string") detail ??= answer.body.detail;
  }
  if (refused !== undefined) return { ok: false, status: refused.status, error: refused.error };
  if (harnesses.length === 0) {
    return { ok: false, status: 403, error: { message: "You can read this, but not act on it." } };
  }
  return { ok: true, ...(detail !== undefined ? { detail } : {}) };
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

let formCount = 0;

/**
 * A form in a dialog: its lead says what will happen, Enter submits, Escape cancels, and a
 * refusal is said inside it, with what was typed kept. A held Enter never confirms.
 * `submit` answers `{ok, …}`; `onDone` runs once the dialog has gone, with the answer, or
 * `null` when it was cancelled.
 */
function formDialog(o) {
  formCount += 1;
  const formId = `attention-form-${formCount}`;
  const leadId = `${formId}-lead`;
  // What went wrong stays in the dialog, and is said once, through the one assertive region.
  const status = el("p", { class: "attention-form-status" });
  const say = (text) => {
    status.textContent = text;
    announce(text, { assertive: true });
  };
  const twin = typeof o.twinOf === "function" ? el("code", { text: o.twinOf() }) : null;
  const fields = o.fields ?? [];
  const form = el("form", { id: formId, class: "attention-form", novalidate: "novalidate" }, [
    el("p", { id: leadId, text: o.lead }),
    ...(o.details ?? []).map((line) => el("p", { class: "muted", text: line })),
    ...fields,
    status,
    twin === null ? null : el("p", { class: "muted cli-twin" }, ["CLI: ", twin]),
    o.twinReason ? el("p", { class: "muted", text: o.twinReason }) : null,
  ]);
  const go = el("button", {
    class: o.danger === true ? "btn btn-danger" : "btn btn-primary",
    type: "submit",
    form: formId,
    text: o.action,
    "aria-describedby": leadId,
  });
  const cancel = el("button", { class: "btn btn-ghost", type: "button", text: "Cancel" });
  let settled = null;
  let stale = false;
  let busy = false;
  const dialog = openDialog({
    title: o.title,
    body: form,
    actions: [go, cancel],
    initialFocus: fields.length === 0 ? go : undefined,
    returnFocus: o.returnFocus,
    dismissOnBackdrop: fields.length === 0,
    onClose: () => o.onDone(settled, stale),
  });
  const follow = () => {
    if (twin !== null) twin.textContent = o.twinOf();
  };
  form.addEventListener("input", follow);
  form.addEventListener("change", follow);
  // The press that opened the dialog may still be held down: only a fresh one confirms.
  go.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.repeat) event.preventDefault();
  });
  cancel.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const problem = typeof o.check === "function" ? o.check() : null;
    if (problem !== null) {
      say(problem);
      return;
    }
    busy = true;
    status.textContent = "";
    go.setAttribute("aria-disabled", "true");
    const answer = await o.submit();
    busy = false;
    go.removeAttribute("aria-disabled");
    if (answer.ok) {
      settled = answer;
      dialog.close();
      return;
    }
    stale = stale || isStale(answer);
    say(problemText(answer.error));
    if (stale) cancel.textContent = "Close";
  });
  return dialog;
}

/** The one confirm step of a verdict: what it is about, what it does, and its command. */
export function confirmChoice(item, model, ctx) {
  return formDialog({
    title: `${model.label}: ${ctx.title}`,
    lead: model.effect,
    details: [ctx.where, ctx.deadline].filter((line) => typeof line === "string" && line !== ""),
    action: model.label,
    danger: model.id === "deny" || model.id === "reject",
    ...(model.twin !== null ? { twinOf: () => model.twin } : { twinReason: model.reason }),
    returnFocus: ctx.opener,
    submit: () => sendChoice(item, model, ctx),
    onDone: ctx.onDone,
  });
}

/** Send a verdict, naming what was read: one that changed since is refused. */
export function sendChoice(item, model, ctx) {
  return carryOut(
    "attention.resolve",
    item,
    ctx.harnesses,
    (h) => ({
      params: { h, ref: item.ref },
      body: { choice: model.id, expect: item.evidenceRev },
    }),
    ctx.deps,
  );
}

/** A set of radio buttons under one legend, and what is picked. */
function radioSet(name, legend, options, picked) {
  const inputs = options.map((option) =>
    el("input", {
      type: "radio",
      name,
      value: option.value,
      checked: option.value === picked ? "checked" : null,
    }),
  );
  const node = el("fieldset", { class: "attention-set" }, [
    el("legend", { text: legend }),
    ...options.map((option, i) =>
      el("label", { class: "attention-option" }, [inputs[i], el("span", { text: option.label })]),
    ),
  ]);
  return { node, value: () => inputs.find((input) => input.checked)?.value ?? null };
}

/** Pick a time: a few ready ones, or another. */
function whenField(nowMs) {
  const choices = whenChoices(nowMs);
  const set = radioSet("until", "Until when", choices, "tomorrow");
  const other = el("input", { class: "input", type: "datetime-local", name: "other" });
  const label = el("label", { class: "field" }, [el("span", { text: "Another time" }), other]);
  other.addEventListener("input", () => {
    const radio = set.node.querySelector('input[value="other"]');
    if (radio !== null) radio.checked = true;
  });
  return {
    nodes: [set.node, label],
    value: () => {
      const choice = choices.find((c) => c.value === set.value());
      return choice?.at ?? typedTime(other.value, nowMs);
    },
  };
}

const selectField = (label, options, name) => {
  const select = el(
    "select",
    { class: "input", name },
    options.map((o) => el("option", { value: o.value, text: o.label })),
  );
  return {
    node: el("label", { class: "field" }, [el("span", { text: label }), select]),
    value: () => select.value,
  };
};

/** Who an item can be given to: the reader, and the members they may see. */
export async function assignees(me, deps = {}) {
  const ask = deps.call ?? call;
  const out = [];
  if (typeof me?.id === "string") out.push({ value: me.id, label: "Me" });
  if (me?.can?.["home.access.manage"] === true) {
    const answer = await ask("access.members.list", { query: { limit: "500" } });
    const items = answer.ok && Array.isArray(answer.body?.items) ? answer.body.items : [];
    for (const row of items) {
      if (row?.kind !== "member" || typeof row.id !== "string" || row.id === me?.id) continue;
      out.push({ value: row.id, label: row.displayName ?? row.id });
    }
  }
  return out;
}

const UNTIL_MISSING = "Pick a time that is still ahead.";

/** Open the dialog of an act beside the choices, or carry it out when it asks nothing. */
export async function runSideAct(act, item, ctx) {
  const where = { h: "", ref: item.ref };
  const everywhere = (operation, body) =>
    carryOut(operation, item, ctx.harnesses, (h) => ({ params: { ...where, h }, body }), ctx.deps);
  const base = { returnFocus: ctx.opener };
  const done = (words) => (answer, stale) => ctx.onDone(answer, stale, words);
  switch (act) {
    case "undefer":
      return ctx.onDone(await everywhere("attention.undefer", {}), false, "It is back.");
    case "reopen":
      return ctx.onDone(await everywhere("attention.reopen", {}), false, "Taken up again.");
    case "snooze": {
      const when = whenField(ctx.nowMs);
      return formDialog({
        ...base,
        title: `Remind me later: ${ctx.title}`,
        lead: "It leaves your list until then. Nobody else's list changes.",
        action: "Remind me later",
        fields: when.nodes,
        twinOf: () => sideTwin("snooze", item.ref, { until: when.value() ?? undefined }),
        check: () => (when.value() === null ? UNTIL_MISSING : null),
        submit: () =>
          carryOut(
            "attention.snooze",
            item,
            harnessesOf(item),
            (h) => ({ params: { ref: item.ref }, body: { harness: h, until: when.value() } }),
            ctx.deps,
          ),
        onDone: done("Hidden from you for now."),
      });
    }
    case "defer": {
      const when = whenField(ctx.nowMs);
      const reason = selectField("Why", DEFER_REASONS, "reason");
      return formDialog({
        ...base,
        title: `Put off: ${ctx.title}`,
        lead:
          item.source?.kind === "approval"
            ? "It leaves everyone's list until then, and its own deadline moves with it."
            : item.source?.kind === "decision"
              ? "It leaves everyone's list until then. Its own deadline is unchanged."
              : "It leaves everyone's list until then.",
        action: "Put off",
        fields: [...when.nodes, reason.node],
        twinOf: () =>
          sideTwin("defer", item.ref, { until: when.value() ?? undefined, reason: reason.value() }),
        check: () => (when.value() === null ? UNTIL_MISSING : null),
        submit: () =>
          everywhere("attention.defer", { until: when.value(), reason: reason.value() }),
        onDone: done("Put off."),
      });
    }
    case "dismiss": {
      const reason = selectField("Why", DISMISS_REASONS, "reason");
      const advisor = item.source?.kind === "advisor";
      const note = advisor
        ? el("textarea", { class: "input", name: "note", rows: "2", maxlength: "2048" })
        : null;
      return formDialog({
        ...base,
        title: `Set aside: ${ctx.title}`,
        lead: "It leaves everyone's list. It comes back if it happens again.",
        action: "Set aside",
        fields: [
          reason.node,
          note === null
            ? null
            : el("label", { class: "field" }, [el("span", { text: "Note (optional)" }), note]),
        ],
        twinOf: () => sideTwin("dismiss", item.ref, { reason: reason.value() }),
        submit: () => {
          const said = note?.value.trim() ?? "";
          return everywhere("attention.dismiss", {
            reasonCode: reason.value(),
            ...(said !== "" ? { note: said } : {}),
          });
        },
        onDone: done("Set aside."),
      });
    }
    case "assign": {
      const people = await assignees(ctx.me, ctx.deps);
      const options = [
        ...people,
        ...(typeof item.assignee === "string" ? [{ value: "", label: "Nobody" }] : []),
      ];
      const to = selectField(
        "Give it to",
        options.length > 0 ? options : [{ value: "", label: "Nobody" }],
        "to",
      );
      return formDialog({
        ...base,
        title: `Assign: ${ctx.title}`,
        lead: "They see it as theirs. It grants them nothing: whoever decides it needs the same class as before.",
        action: "Assign",
        fields: [to.node],
        ...(options.length > 0
          ? {
              twinOf: () =>
                sideTwin("assign", item.ref, to.value() === "" ? {} : { to: to.value() }),
            }
          : {}),
        check: () => (options.length > 0 ? null : "This Home has no members to give it to yet."),
        submit: () =>
          to.value() === ""
            ? everywhere("attention.unassign", {})
            : everywhere("attention.assign", { to: to.value() }),
        onDone: (answer, stale) =>
          ctx.onDone(answer, stale, to.value() === "" ? "Unassigned." : "Assigned."),
      });
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Discussion
// ---------------------------------------------------------------------------

/** The most a message holds, as the API counts it. */
export const MESSAGE_MAX_BYTES = 8 * 1024;

/** Why a message is not one, or `null`. Pure. */
export function messageProblem(text) {
  const said = String(text ?? "");
  if (said.trim() === "") return "Write something first.";
  return new TextEncoder().encode(said).length > MESSAGE_MAX_BYTES
    ? "A message holds at most 8 KiB."
    : null;
}

/**
 * A message's line: who and when. A member is shown by the name the answer gives them,
 * else as "Someone else"; their id stays in the line's title. Pure.
 */
export function messageHead(message, ctx = {}) {
  const by = message?.by;
  const named = Array.isArray(ctx.people) ? ctx.people.find((p) => p?.id === by) : undefined;
  const who =
    typeof ctx.meId === "string" && by === ctx.meId
      ? "You"
      : typeof by === "string" && by.startsWith("local:")
        ? "Someone at this computer"
        : typeof named?.name === "string" && named.name !== ""
          ? named.name
          : "Someone else";
  return `${who} · ${ctx.ago ?? ""}`;
}

/**
 * The discussion of an item, read when it is opened. What is said stays with the item, for
 * people: no model is given it.
 */
export function discussion(item, ctx) {
  const harness = ctx.harnesses[0] ?? harnessesOf(item)[0];
  const params = { h: harness, ref: item.ref };
  const list = el("ul", { class: "attention-messages", "aria-label": "Messages" });
  const status = el("p", { class: "muted", role: "status" });
  const text = el("textarea", { class: "input", rows: "3", name: "text" });
  const add = el("button", { class: "btn", type: "submit", text: "Add message" });
  const form = el("form", { class: "attention-discuss", novalidate: "novalidate" }, [
    el("label", { class: "field" }, [el("span", { text: "Say something" }), text]),
    add,
    el("p", { class: "muted cli-twin" }, [
      "CLI: ",
      el("code", { text: `crewhaus inbox discuss ${itemIdOf(item.ref)} --file <path>` }),
    ]),
  ]);
  const load = async () => {
    if (!ctx.content) {
      status.textContent = "You can't read this harness's content, so what was said is hidden.";
      return;
    }
    const answer = await call("attention.messages.list", { params });
    if (!answer.ok) {
      status.textContent = problemText(answer.error);
      return;
    }
    const items = Array.isArray(answer.body?.items) ? answer.body.items : [];
    const people = Array.isArray(answer.body?.people) ? answer.body.people : [];
    status.textContent = items.length === 0 ? "No one has said anything here yet." : "";
    list.replaceChildren(
      ...items.map((message) =>
        el("li", null, [
          el("div", {
            class: "muted",
            title: typeof message.by === "string" ? message.by : null,
            text: messageHead(message, { meId: ctx.meId, people, ago: ctx.ago(message.at) }),
          }),
          el("p", { class: "attention-message", text: String(message.text ?? "") }),
        ]),
      ),
    );
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const problem = messageProblem(text.value);
    if (problem !== null) {
      status.textContent = problem;
      text.focus();
      return;
    }
    const answer = await createAction("attention.messages.add", {
      params,
      body: { text: text.value },
    }).run();
    if (!answer.ok) {
      status.textContent = problemText(answer.error);
      return;
    }
    text.value = "";
    announce("Message added.");
    await load();
    text.focus();
  });
  let read = false;
  const node = el("details", { class: "attention-thread" }, [
    el("summary", { text: "Discuss" }),
    list,
    status,
    ctx.mayAct ? form : null,
  ]);
  node.addEventListener("toggle", () => {
    if (!node.open || read) return;
    read = true;
    void load();
  });
  return node;
}
