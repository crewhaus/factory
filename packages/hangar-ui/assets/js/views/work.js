/**
 * Work › Work items: what this harness is working on, what's next, and what it proposes
 * (#516). The feed's groups in order: Needs you, Working now, Up next, Proposed (grouped by
 * why it matters), Scheduled, Delivered, Goals, From Thredz. A group with nothing in it is
 * hidden, unless its empty state says something useful (why, and what fills it).
 *
 * The item page (`#/h/<id>/work/items/<wi>`): its title and status, What's asked, Done
 * when, Why (a proposal's evidence, each labelled in words), its runs and its history, and
 * the actions its state allows: Accept or Decline a proposal, Start now or Cancel an open
 * item, Reopen a closed one, Edit, and "Move above…" to correct the ranking (a form, never
 * a drag). Every action shows its CLI twin where one exists.
 *
 * Status is a word beside a mark, never colour alone. A refresh never moves focus or
 * scrolls, and keeps a half-typed note. Every call goes through `v1.js` by operation id;
 * DOM by `createElement` and `textContent` only. The models are pure, so the tests read
 * them without a DOM.
 */

import { clear, el, statusBadge } from "../dom.js";
import { hrefHarness } from "../router.js";
import { emptyFor, emptyModel } from "../ui/empty.js";
import { announce } from "../ui/live.js";
import { call, createAction } from "../v1.js";

/** The words the screen says, in one place. */
export const WORK_COPY = Object.freeze({
  title: "Work items",
  addWork: "Add work",
  added: "Added. It's up next.",
  accepted: "Accepted. It's up next.",
  declined: "Declined.",
  started: "Started.",
  cancelled: "Cancelled.",
  reopened: "Reopened.",
  saved: "Saved.",
  moved: "Moved.",
  tracked: "Tracking it here. Changes in Thredz don't update this item.",
  noContent: "You can see this harness but not its work details. Ask an owner for access.",
  usageUnknown: "Usage unknown",
  notDone: (message) => `Not done: ${message ?? "Something went wrong."}`,
  back: "Back to work items",
});

/** The feed's groups, in the order the screen shows them. */
export const GROUPS = Object.freeze([
  { id: "needsYou", heading: "Needs you" },
  { id: "workingNow", heading: "Working now" },
  { id: "upNext", heading: "Up next" },
  { id: "proposed", heading: "Proposed" },
  { id: "scheduled", heading: "Scheduled" },
  { id: "delivered", heading: "Delivered" },
  { id: "goals", heading: "Goals" },
  { id: "fromThredz", heading: "From Thredz" },
]);

/** Why a proposal matters, as the Proposed group's sub-headings say it. */
export const BASIS_HEADINGS = Object.freeze({
  "compatibility-security": "Keeps it safe and working",
  "user-pain": "People ran into this",
  speculative: "Ideas",
});

/** The mark beside each status word. The word is the message; the mark repeats it. */
export const STATUS_TONES = Object.freeze({
  merged: "ok",
  done: "ok",
  "closed-unmerged": "off",
  reverted: "warn",
  declined: "off",
  cancelled: "off",
  superseded: "off",
  failed: "bad",
  "waiting-approval": "warn",
  "needs-input": "warn",
  working: "info",
  "in-review": "info",
  "changes-requested": "warn",
  "publish-unfinished": "warn",
  interrupted: "warn",
  paused: "warn",
  disabled: "off",
  "waiting-budget": "warn",
  proposed: "info",
  queued: "info",
  "up-next": "off",
});

/** How a piece of evidence is known, in words. A hypothesis is never shown as demand. */
export const EVIDENCE_WORDS = Object.freeze({
  observed: "observed",
  reported: "reported",
  hypothesis: "hypothesis — not observed",
});

/** A 0–3 level in words. */
export const LEVEL_WORDS = Object.freeze(["none", "low", "medium", "high"]);

/** Why a person declines a proposal: the reasons the API takes, in words. */
export const DECLINE_CHOICES = Object.freeze([
  { value: "out-of-scope", label: "Out of scope" },
  { value: "duplicate", label: "Duplicate" },
  { value: "not-now", label: "Not now" },
  { value: "wont-fix", label: "Won't fix" },
  { value: "needs-evidence", label: "Needs more evidence" },
  { value: "other", label: "Other" },
]);

/** How far a ranking correction reaches. */
export const SCOPE_CHOICES = Object.freeze([
  { value: "item", label: "Just this item" },
  { value: "similar", label: "Items like it" },
  { value: "all", label: "Everything with the same reason" },
]);

/** The kinds of work, in words. */
export const KIND_CHOICES = Object.freeze([
  { value: "fix", label: "Fix" },
  { value: "feature", label: "Feature" },
  { value: "maintenance", label: "Maintenance" },
  { value: "research", label: "Research" },
  { value: "report", label: "Report" },
  { value: "request", label: "Request" },
  { value: "other", label: "Other" },
]);

const WI_RE = /^wi_[0-9a-hjkmnp-tv-z]{26}$/;
const GOAL_RE = /^goal-\d{4}$/;

/** The wire's empty reason, as the screen's own cause. */
export function causeOf(reason) {
  switch (reason) {
    case "no-access":
      return "no-access";
    case "unreachable":
      return "connection-failed";
    case "unsupported":
      return "unsupported";
    case "filtered":
      return "filtered";
    case "not-indexed":
      return "not-indexed";
    default:
      return "no-data";
  }
}

/** One row of a group: its words, its status, its link and its one primary action. */
function rowOf(entry, hrn) {
  const label = typeof entry?.label === "string" ? entry.label : "";
  const status = typeof entry?.status === "string" ? entry.status : null;
  const word = typeof entry?.statusWord === "string" ? entry.statusWord : null;
  const base = {
    key: `${entry?.kind}:${entry?.id}`,
    kind: String(entry?.kind ?? ""),
    id: String(entry?.id ?? ""),
    label,
    word,
    tone: STATUS_TONES[status] ?? "off",
    href: null,
    primary: null,
    detail: null,
  };
  if (entry?.kind === "item" && WI_RE.test(String(entry.id))) {
    const item = entry.item ?? {};
    return {
      ...base,
      href: hrefHarness(hrn, "work", "items", entry.id),
      detail:
        item.corrected !== undefined
          ? "Placed by a person"
          : item.ranking === "weights"
            ? "Ranked by your weights"
            : null,
      primary: {
        label: item.state === "proposed" ? "Review" : "Open",
        href: hrefHarness(hrn, "work", "items", entry.id),
      },
    };
  }
  if (entry?.kind === "runs") {
    const count = Number.isSafeInteger(entry.count) ? entry.count : 0;
    return { ...base, detail: count === 1 ? "1 run" : `${count} runs`, tone: "info" };
  }
  if (entry?.kind === "goal") {
    const source = `continuity-goal:${base.id}`;
    const p = entry.progress ?? {};
    const progress =
      Number.isFinite(p.current) && Number.isFinite(p.target)
        ? `${p.current} of ${p.target}${typeof p.unit === "string" ? ` ${p.unit}` : ""}`
        : null;
    return {
      ...base,
      detail: progress,
      primary: GOAL_RE.test(base.id)
        ? {
            label: "Track as work",
            op: "work.adopt",
            body: { source },
            twin: `crewhaus work adopt --from ${source} --harness ${hrn}`,
          }
        : null,
    };
  }
  if (entry?.kind === "plan") {
    const steps = Array.isArray(entry.steps) ? entry.steps : [];
    return { ...base, detail: steps.map((s) => `${s.title}: ${s.status}`).join(" · ") || null };
  }
  if (entry?.kind === "task") {
    return {
      ...base,
      // Home reads Thredz for the harness; the CLI cannot, so there is no twin.
      primary: {
        label: "Track as work",
        op: "work.adopt",
        body: { source: `thredz-task:${base.id}` },
        twin: null,
      },
    };
  }
  if (entry?.kind === "schedule") {
    return { ...base, href: hrefHarness(hrn, "work", "schedule") };
  }
  return base;
}

/**
 * The feed as the screen draws it: each group with its rows, the Proposed group split by
 * basis, and an empty state only where it says something useful.
 */
export function feedModel(feed, hrn) {
  const sections =
    feed && typeof feed.sections === "object" && feed.sections !== null ? feed.sections : {};
  const nothing = GROUPS.every(
    (g) => !Array.isArray(sections[g.id]?.items) || sections[g.id].items.length === 0,
  );
  const groups = [];
  for (const group of GROUPS) {
    const section = sections[group.id] ?? {};
    const items = Array.isArray(section.items) ? section.items : [];
    if (items.length > 0) {
      const rows = items.map((entry) => rowOf(entry, hrn));
      const parts =
        group.id === "proposed" && Array.isArray(section.groups) && section.groups.length > 0
          ? section.groups.map((g) => ({
              heading: BASIS_HEADINGS[g.basis] ?? "Other",
              rows: rows.filter((r) => Array.isArray(g.items) && g.items.includes(r.id)),
            }))
          : [{ heading: null, rows }];
      groups.push({
        id: group.id,
        heading: group.heading,
        parts,
        empty: null,
        truncated: section.truncated === true,
      });
      continue;
    }
    const empty = section.empty;
    if (empty === undefined) continue;
    const useful = empty.reason !== "no-data" || (group.id === "upNext" && nothing);
    if (!useful) continue;
    groups.push({
      id: group.id,
      heading: group.heading,
      parts: [],
      empty: emptyModel({
        cause: causeOf(empty.reason),
        subject: group.id === "fromThredz" ? "Thredz" : group.heading.toLowerCase(),
        detail: typeof empty.remedy === "string" ? empty.remedy : undefined,
        ...(typeof empty.verb === "string" ? { verb: empty.verb } : {}),
        ...(empty.reason === "unreachable" ? { action: "Try again" } : {}),
      }),
      truncated: false,
    });
  }
  return {
    groups,
    hidden: Array.isArray(feed?.hidden) && feed.hidden.includes("content"),
    anomalies: Number.isSafeInteger(feed?.anomalies) ? feed.anomalies : 0,
  };
}

function evidenceLine(e) {
  const how = EVIDENCE_WORDS[e?.label] ?? "hypothesis — not observed";
  const when = typeof e?.observedAt === "string" ? ` (${e.observedAt.slice(0, 10)})` : "";
  const where = typeof e?.ref === "string" ? ` — ${e.ref}` : "";
  return `${how}${when}: ${String(e?.note ?? "")}${where}`;
}

/** An item's page as the screen draws it: header, what's asked, done when, why, runs, history. */
export function itemModel(detail) {
  const item = detail?.item ?? {};
  const content = detail?.content;
  const a = content?.assessment;
  const why =
    a === undefined
      ? null
      : {
          problem: String(a.problem ?? ""),
          audience: typeof a.audience === "string" ? a.audience : null,
          evidence:
            Array.isArray(a.evidence) && a.evidence.length > 0
              ? a.evidence.map(evidenceLine)
              : [WORK_COPY.usageUnknown],
          counter: Array.isArray(a.counterEvidence) ? a.counterEvidence.map(evidenceLine) : [],
          fit: [a.intentFit?.supports, a.intentFit?.conflicts].filter((s) => typeof s === "string"),
          doNothing: typeof a.doNothing === "string" ? a.doNothing : null,
          alternatives: Array.isArray(a.alternatives) ? a.alternatives.map(String) : [],
          levels: ["cost", "upkeep", "uncertainty", "reversibility"]
            .filter((k) => Number.isInteger(a[k]))
            .map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${LEVEL_WORDS[a[k]] ?? a[k]}`),
          measure: typeof a.measure === "string" ? a.measure : null,
        };
  return {
    id: String(item.id ?? ""),
    title: String(item.title ?? ""),
    state: String(item.state ?? ""),
    word: String(item.statusWord ?? ""),
    tone: STATUS_TONES[item.status] ?? "off",
    rev: Number.isSafeInteger(item.rev) ? item.rev : 1,
    facts: [
      typeof item.kind === "string"
        ? (KIND_CHOICES.find((k) => k.value === item.kind)?.label ?? item.kind)
        : null,
      Number.isInteger(item.priority) ? `Priority ${item.priority}` : null,
      typeof item.basis === "string" ? (BASIS_HEADINGS[item.basis] ?? null) : null,
      content?.source?.kind === "thredz-task" ? "From a Thredz task" : null,
      content?.source?.kind === "continuity-goal" ? "From a goal" : null,
    ].filter((f) => f !== null),
    hidden: Array.isArray(detail?.hidden) && detail.hidden.includes("content"),
    goal: typeof content?.goal === "string" ? content.goal : null,
    acceptance: Array.isArray(content?.acceptance) ? content.acceptance.map(String) : [],
    why,
    notes: Array.isArray(content?.notes)
      ? content.notes.map((n) => ({ at: String(n.at ?? ""), text: String(n.text ?? "") }))
      : [],
    delivered: Array.isArray(content?.delivered)
      ? content.delivered.map((d) => `${d.kind}: ${d.ref}`)
      : [],
    runs: Array.isArray(item.runs) ? item.runs.map(String) : [],
    history: Array.isArray(detail?.history) ? detail.history.map(historyLine) : [],
  };
}

const VIA_WORDS = Object.freeze({
  home: "in Home",
  cli: "from the command line",
  sdk: "from the app",
  slack: "in Slack",
  tool: "by the harness",
  system: "by the system",
});
const EVENT_WORDS = Object.freeze({
  opened: "Opened",
  accepted: "Accepted",
  declined: "Declined",
  updated: "Changed",
  linked: "Run linked",
  ranked: "Moved",
  delivered: "Delivered",
  closed: "Closed",
  reopened: "Reopened",
});

function historyLine(h) {
  const what = EVENT_WORDS[h?.event] ?? String(h?.event ?? "");
  const where = VIA_WORDS[h?.via] ?? "";
  const outcome = typeof h?.outcome === "string" ? ` (${h.outcome})` : "";
  return `${String(h?.at ?? "")
    .slice(0, 16)
    .replace("T", " ")} · ${what}${outcome} ${where}`.trim();
}

/**
 * The actions an item's state allows, for a caller who may take them (`can` is `me.get`'s
 * answer). Each names its operation and its exact CLI twin. Home decides again.
 */
export function actionsFor(item, can, hrn) {
  const submit = can?.["h.run.submit"] === true;
  const control = can?.["h.control"] === true;
  const wi = String(item?.id ?? "");
  // Each twin spelled whole, so it reads as the command it is.
  const twins = {
    accept: `crewhaus work accept ${wi} --harness ${hrn}`,
    decline: `crewhaus work decline ${wi} --reason <code> --harness ${hrn}`,
    start: `crewhaus work start ${wi} --harness ${hrn}`,
    cancel: `crewhaus work cancel ${wi} --harness ${hrn}`,
    reopen: `crewhaus work reopen ${wi} --harness ${hrn}`,
    edit: `crewhaus work edit ${wi} --expect <rev> --harness ${hrn}`,
  };
  const twin = (verb) => twins[verb];
  const out = [];
  if (item?.state === "proposed" && submit) {
    out.push({
      id: "accept",
      label: "Accept",
      op: "work.accept",
      twin: twin("accept"),
      primary: true,
    });
    out.push({
      id: "decline",
      label: "Decline",
      op: "work.decline",
      twin: twin("decline"),
    });
  }
  if (item?.state === "open") {
    if (submit)
      out.push({
        id: "start",
        label: "Start now",
        op: "work.start",
        twin: twin("start"),
        primary: true,
      });
    if (control)
      out.push({ id: "cancel", label: "Cancel", op: "work.cancel", twin: twin("cancel") });
  }
  if (item?.state === "closed" && submit) {
    out.push({
      id: "reopen",
      label: "Reopen",
      op: "work.reopen",
      twin: twin("reopen"),
      primary: true,
    });
  }
  if (item?.state !== "closed" && submit) {
    out.push({
      id: "edit",
      label: "Edit",
      op: "work.update",
      twin: twin("edit"),
    });
  }
  return out;
}

/** "Move above…": the items it can be moved above (same state, not itself), and the scopes. */
export function rankControlModel(item, candidates, hrn) {
  const wi = String(item?.id ?? "");
  const options = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c?.id !== wi && c?.state === item?.state && item?.state !== "closed")
    .map((c) => ({ value: String(c.id), label: String(c.title ?? c.id) }));
  return {
    available: options.length > 0,
    label: "Move above…",
    options,
    scopes: SCOPE_CHOICES,
    twin: `crewhaus work rank ${wi} --above <wi> --scope item|similar|all --harness ${hrn}`,
  };
}

function twinLine(command) {
  if (typeof command !== "string" || command === "") return null;
  return el("div", { class: "twin" }, [
    el("span", { class: "twin-label", text: "CLI" }),
    el("code", { class: "twin-cmd", tabindex: "0", text: command }),
  ]);
}

function errorText(answer) {
  return WORK_COPY.notDone(answer?.error?.message);
}

/** Half-typed text, kept across a redraw by where it was typed. */
const drafts = new Map();

function draftField(key, attrs, multiline = false) {
  const field = el(multiline ? "textarea" : "input", { class: "input", ...attrs });
  field.value = drafts.get(key) ?? "";
  field.addEventListener("input", () => drafts.set(key, field.value));
  return field;
}

function select(id, choices) {
  return el(
    "select",
    { id, class: "input" },
    choices.map((c) => el("option", { value: c.value, text: c.label })),
  );
}

function drawGroups(host, model) {
  clear(host);
  if (model.hidden) host.appendChild(el("p", { class: "muted", text: WORK_COPY.noContent }));
  for (const group of model.groups) {
    const section = el("section", { class: "work-group", "aria-labelledby": `work-${group.id}` }, [
      el("h3", { id: `work-${group.id}`, text: group.heading }),
    ]);
    if (group.empty !== null) section.appendChild(emptyFor(group.empty));
    for (const part of group.parts) {
      if (part.heading !== null) section.appendChild(el("h4", { text: part.heading }));
      section.appendChild(
        el(
          "ul",
          { class: "work-rows" },
          part.rows.map((row) =>
            el("li", { class: "work-row", dataset: { key: row.key } }, [
              row.href !== null
                ? el("a", { href: row.href, text: row.label })
                : el("span", { text: row.label }),
              row.word !== null ? [" ", statusBadge(row.tone, row.word)] : null,
              row.detail !== null ? el("span", { class: "muted", text: ` · ${row.detail}` }) : null,
              row.primary !== null && row.primary.op !== undefined ? actionButton(row) : null,
            ]),
          ),
        ),
      );
    }
    if (group.truncated)
      section.appendChild(el("p", { class: "muted", text: "Showing the first hundred." }));
    host.appendChild(section);
  }
}

let currentHarness = null;

function actionButton(row) {
  const status = el("span", { class: "muted", role: "status" });
  const button = el("button", { class: "btn", type: "button", text: row.primary.label });
  button.addEventListener("click", async () => {
    button.disabled = true;
    const done = await createAction(row.primary.op, { params: { h: currentHarness } }).run({
      body: row.primary.body,
    });
    button.disabled = false;
    status.textContent = done.ok ? WORK_COPY.tracked : errorText(done);
    announce(status.textContent);
  });
  return el("span", { class: "row-actions" }, [
    " ",
    button,
    " ",
    status,
    twinLine(row.primary.twin),
  ]);
}

function addForm(ctx, onAdded) {
  const key = (name) => `${ctx.id}:add:${name}`;
  const title = draftField(key("title"), {
    id: "work-add-title",
    type: "text",
    maxlength: "200",
    autocomplete: "off",
  });
  const goal = draftField(key("goal"), { id: "work-add-goal", rows: "3", maxlength: "8192" }, true);
  const done = draftField(key("done"), { id: "work-add-done", rows: "3" }, true);
  const kind = select("work-add-kind", KIND_CHOICES);
  kind.value = "request";
  const status = el("p", { class: "muted", role: "status" });
  const action = createAction("work.create", { params: { h: ctx.id } });
  const submit = el("button", {
    class: "btn btn-primary",
    type: "submit",
    text: WORK_COPY.addWork,
  });
  const form = el("form", { class: "work-add", "aria-labelledby": "work-add-heading" }, [
    el("h3", { id: "work-add-heading", text: WORK_COPY.addWork }),
    el("p", {}, [el("label", { for: "work-add-title", text: "What should it do?" }), " ", title]),
    el("p", {}, [
      el("label", { for: "work-add-goal", text: "What's asked (optional)" }),
      " ",
      goal,
    ]),
    el("p", {}, [
      el("label", { for: "work-add-done", text: "Done when, one per line (optional)" }),
      " ",
      done,
    ]),
    el("p", {}, [el("label", { for: "work-add-kind", text: "Kind" }), " ", kind]),
    el("p", {}, [submit]),
    status,
    twinLine(`crewhaus work add --title <title> --harness ${ctx.id}`),
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (title.value.trim() === "") {
      status.textContent = "Give it a title.";
      title.focus();
      return;
    }
    submit.disabled = true;
    const criteria = done.value
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const answer = await action.run({
      body: {
        title: title.value.trim(),
        kind: kind.value,
        ...(goal.value.trim() !== "" ? { goal: goal.value } : {}),
        ...(criteria.length > 0 ? { acceptance: criteria } : {}),
      },
    });
    submit.disabled = false;
    if (answer.ok) {
      for (const name of ["title", "goal", "done"]) drafts.delete(key(name));
      title.value = "";
      goal.value = "";
      done.value = "";
      status.textContent = WORK_COPY.added;
      announce(WORK_COPY.added);
      onAdded();
      return;
    }
    status.textContent = errorText(answer);
  });
  return form;
}

async function canOf() {
  const me = await call("me.get");
  return me.ok && typeof me.body?.can === "object" && me.body.can !== null ? me.body.can : {};
}

export async function renderWork(root, ctx) {
  const wi = ctx?.route?.workItem;
  if (typeof wi === "string") return renderWorkItem(root, ctx, wi);
  currentHarness = ctx.id;
  clear(root);
  const heading = el("h2", { tabindex: "-1", text: WORK_COPY.title });
  const groups = el("div", { class: "work-groups" });
  root.appendChild(heading);
  root.appendChild(groups);
  const can = await canOf();
  const refresh = async () => {
    const feed = await call("work.feed", { params: { h: ctx.id } });
    // Never redraw under the reader's focus: the next refresh catches up.
    if (groups.contains(document.activeElement) && groups.childElementCount > 0) return;
    if (!feed.ok) {
      clear(groups);
      groups.appendChild(
        emptyFor({
          cause: feed.status === 403 ? "no-access" : "connection-failed",
          subject: "Home",
          detail: feed.error?.message,
        }),
      );
      return;
    }
    drawGroups(groups, feedModel(feed.body, ctx.id));
  };
  await refresh();
  if (can["h.run.submit"] === true) root.appendChild(addForm(ctx, refresh));
  return undefined;
}

export async function renderWorkItem(root, ctx, wi) {
  currentHarness = ctx.id;
  clear(root);
  const back = el("a", { href: hrefHarness(ctx.id, "work", "items"), text: WORK_COPY.back });
  if (!WI_RE.test(wi)) {
    root.appendChild(el("p", { text: "There is no such work item." }));
    root.appendChild(back);
    return undefined;
  }
  const [detail, can, list] = await Promise.all([
    call("work.get", { params: { ref: `${ctx.id}/work/${wi}` } }),
    canOf(),
    call("work.list", { params: { h: ctx.id } }),
  ]);
  if (!detail.ok) {
    root.appendChild(el("h2", { text: WORK_COPY.title }));
    root.appendChild(el("p", { text: errorText(detail) }));
    root.appendChild(back);
    return undefined;
  }
  const model = itemModel(detail.body);
  const heading = el("h2", { tabindex: "-1", text: model.title });
  root.appendChild(back);
  root.appendChild(heading);
  root.appendChild(
    el("p", {}, [
      statusBadge(model.tone, model.word),
      model.facts.length > 0 ? ` · ${model.facts.join(" · ")}` : "",
    ]),
  );
  if (model.hidden) root.appendChild(el("p", { class: "muted", text: WORK_COPY.noContent }));
  const block = (title, children) =>
    el("section", { "aria-label": title }, [el("h3", { text: title }), ...children]);
  if (model.goal !== null)
    root.appendChild(block("What's asked", [el("p", { class: "prewrap", text: model.goal })]));
  if (model.acceptance.length > 0) {
    root.appendChild(
      block("Done when", [
        el(
          "ul",
          {},
          model.acceptance.map((c) => el("li", { text: c })),
        ),
      ]),
    );
  }
  if (model.why !== null) {
    const w = model.why;
    root.appendChild(
      block("Why", [
        el("p", { text: w.problem }),
        w.audience !== null ? el("p", { text: `Who it affects: ${w.audience}` }) : null,
        el("h4", { text: "Evidence" }),
        el(
          "ul",
          {},
          w.evidence.map((line) => el("li", { text: line })),
        ),
        w.counter.length > 0
          ? [
              el("h4", { text: "Against it" }),
              el(
                "ul",
                {},
                w.counter.map((line) => el("li", { text: line })),
              ),
            ]
          : null,
        w.fit.length > 0 ? el("p", { text: `Fit with its purpose: ${w.fit.join(" ")}` }) : null,
        w.doNothing !== null ? el("p", { text: `If nothing is done: ${w.doNothing}` }) : null,
        w.alternatives.length > 0
          ? el("p", { text: `Alternatives: ${w.alternatives.join("; ")}` })
          : null,
        w.levels.length > 0 ? el("p", { text: w.levels.join(" · ") }) : null,
        w.measure !== null ? el("p", { text: `How we'd know it worked: ${w.measure}` }) : null,
      ]),
    );
  }
  if (model.notes.length > 0) {
    root.appendChild(
      block("Notes", [
        el(
          "ul",
          {},
          model.notes.map((n) => el("li", { text: `${n.at.slice(0, 10)}: ${n.text}` })),
        ),
      ]),
    );
  }
  if (model.delivered.length > 0) {
    root.appendChild(
      block("Delivered", [
        el(
          "ul",
          {},
          model.delivered.map((d) => el("li", { text: d })),
        ),
      ]),
    );
  }
  if (model.runs.length > 0) {
    root.appendChild(
      block("Runs", [
        el(
          "ul",
          {},
          model.runs.map((run) =>
            el("li", {}, [el("a", { href: hrefHarness(ctx.id, "work", "runs", run), text: run })]),
          ),
        ),
      ]),
    );
  }
  root.appendChild(
    block("History", [
      el(
        "ul",
        {},
        model.history.map((h) => el("li", { text: h })),
      ),
    ]),
  );

  const status = el("p", { class: "muted", role: "status", "aria-live": "polite" });
  const after = async (answer, words) => {
    if (answer.ok) {
      announce(words);
      await renderWorkItem(root, ctx, wi);
      return;
    }
    status.textContent = errorText(answer);
  };
  const actions = el("section", { "aria-label": "Actions" }, [el("h3", { text: "Actions" })]);
  for (const a of actionsFor(detail.body.item, can, ctx.id)) {
    const row = el("div", { class: "work-action" });
    if (a.id === "decline") {
      const reason = select(`work-decline-${wi}`, DECLINE_CHOICES);
      const note = draftField(`${wi}:decline-note`, {
        id: `work-decline-note-${wi}`,
        type: "text",
        maxlength: "4096",
      });
      const button = el("button", { class: "btn", type: "button", text: a.label });
      button.addEventListener("click", async () => {
        button.disabled = true;
        const done = await createAction(a.op, { params: { ref: `${ctx.id}/work/${wi}` } }).run({
          body: { reason: reason.value, ...(note.value.trim() !== "" ? { note: note.value } : {}) },
        });
        button.disabled = false;
        if (done.ok) drafts.delete(`${wi}:decline-note`);
        await after(done, WORK_COPY.declined);
      });
      row.append(
        el("label", { for: `work-decline-${wi}`, text: "Reason" }),
        " ",
        reason,
        " ",
        el("label", { for: `work-decline-note-${wi}`, text: "Note (optional)" }),
        " ",
        note,
        " ",
        button,
      );
    } else if (a.id === "edit") {
      const note = draftField(`${wi}:note`, {
        id: `work-note-${wi}`,
        type: "text",
        maxlength: "4096",
      });
      const button = el("button", { class: "btn", type: "button", text: "Add note" });
      button.addEventListener("click", async () => {
        if (note.value.trim() === "") return;
        button.disabled = true;
        const done = await createAction(a.op, { params: { ref: `${ctx.id}/work/${wi}` } }).run({
          body: { expect: model.rev, note: note.value },
        });
        button.disabled = false;
        if (done.ok) drafts.delete(`${wi}:note`);
        await after(done, WORK_COPY.saved);
      });
      row.append(el("label", { for: `work-note-${wi}`, text: "Note" }), " ", note, " ", button);
    } else {
      const button = el("button", {
        class: a.primary === true ? "btn btn-primary" : "btn",
        type: "button",
        text: a.label,
      });
      const words = {
        accept: WORK_COPY.accepted,
        start: WORK_COPY.started,
        cancel: WORK_COPY.cancelled,
        reopen: WORK_COPY.reopened,
      }[a.id];
      button.addEventListener("click", async () => {
        button.disabled = true;
        const done = await createAction(a.op, { params: { ref: `${ctx.id}/work/${wi}` } }).run({
          body: {},
        });
        button.disabled = false;
        await after(done, words);
      });
      row.append(button);
    }
    const line = twinLine(a.twin);
    if (line !== null) row.append(" ", line);
    actions.appendChild(row);
  }
  const rank = rankControlModel(detail.body.item, list.ok ? list.body?.items : [], ctx.id);
  if (rank.available && can["h.run.submit"] === true) {
    const above = select(`work-rank-above-${wi}`, rank.options);
    const scopes = el("fieldset", {}, [
      el("legend", { text: "How far it reaches" }),
      ...rank.scopes.map((s, i) =>
        el("label", {}, [
          el("input", {
            type: "radio",
            name: `work-rank-scope-${wi}`,
            value: s.value,
            ...(i === 0 ? { checked: true } : {}),
          }),
          ` ${s.label} `,
        ]),
      ),
    ]);
    const button = el("button", { class: "btn", type: "button", text: "Move" });
    button.addEventListener("click", async () => {
      const scope =
        root.querySelector(`input[name="work-rank-scope-${wi}"]:checked`)?.value ?? "item";
      button.disabled = true;
      const done = await createAction("work.rank", { params: { ref: `${ctx.id}/work/${wi}` } }).run(
        {
          body: { below: above.value, scope },
        },
      );
      button.disabled = false;
      await after(done, WORK_COPY.moved);
    });
    actions.appendChild(
      el("div", { class: "work-action" }, [
        el("label", { for: `work-rank-above-${wi}`, text: rank.label }),
        " ",
        above,
        scopes,
        button,
        " ",
        twinLine(rank.twin),
      ]),
    );
  }
  root.appendChild(actions);
  root.appendChild(status);
  heading.focus();
  return undefined;
}
