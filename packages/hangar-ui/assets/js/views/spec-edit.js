/**
 * Spec — the M3 half of the Spec tab: the field editor, trust-tier badges,
 * version history with pins and diffs, and the four builders (new-spec
 * wizard, grader builder, dataset builder, MCP connectors).
 *
 * The settings form is built from the schema this harness's spec is checked
 * with (`specs.schema`): a labelled control for every setting the form can
 * show, and the JSON pane for every one it cannot (a record keyed by names, a
 * list of entries, a setting that takes several forms, one whose shape the
 * masker hid). Every save is ONE edit down the same guarded routes: a setting
 * the optimizer may write saves with `specPatch`; any other is previewed with
 * `specDiff` and applied with `specEdit` after the confirmation the server's
 * answer asks for. There is no YAML editor in this console and this screen
 * never says there is: the console is zero-build and dependency-free, so it
 * has no YAML parser to be honest with.
 *
 * The M1 read (`views/spec.js`: YAML, issues, env-ref presence, badges)
 * stays where it is and is rendered above this.
 *
 * The one thing this screen must never let a user do accidentally: write a
 * HUMAN-OWNED path (permissions, the model roster, watchme, plugins, expose,
 * learning.sources, thredz, sandbox, transaction_policy) as if it were a
 * quality knob. Those fields render with the security-surface interstitial —
 * a credential-redacted diff plus a typed confirmation — or hand off to
 * `crewhaus propose`. The server enforces the same split, so the UI is the
 * explanation, never the gate.
 *
 * Two more things this screen is careful about:
 *
 *   - it renders the EFFECTIVE configuration, not the YAML. A spec that
 *     never mentions a default-ON block still runs it, so every row says
 *     whether it was declared or defaulted;
 *   - it says which schema validated the spec. A fleet spans crewhaus
 *     versions, and "validated against the manager's copy" is a materially
 *     different claim from "validated against this harness's own".
 */

import { api } from "../api.js";
import {
  clear,
  collapsible,
  copyBtn,
  dot,
  el,
  emptyState,
  jsonPre,
  scrollRegion,
  skeleton,
  toast,
} from "../dom.js";
import { conflictView } from "../ui/conflict.js";
import { confirmAction, openDialog } from "../ui/dialog.js";
import { CLEAR, carriesMasked, fieldEdit, formModel, issuesByField } from "../ui/schema-form.js";
import { call } from "../v1.js";

// ---------------------------------------------------------------------------
// small shared pieces
// ---------------------------------------------------------------------------

/** A titled card. `badge` is a node (usually a traffic light + its text). */
function card(title, badge, children) {
  return el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [el("span", { text: title }), badge]),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

/** A payload's `note` line, when it has one. */
function noteLine(body) {
  const note = typeof body?.note === "string" && body.note !== "" ? body.note : null;
  return note === null ? null : el("p", { class: "muted", text: note });
}

/** A table with a scroll container (wide content never scrolls the page),
 *  named and in the Tab order so a keyboard can scroll it too. */
function table(headers, rows, label = "table") {
  return scrollRegion(label, [
    el("table", { class: "fleet" }, [
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          headers.map((h) => el("th", { text: h })),
        ),
      ),
      el("tbody", null, rows),
    ]),
  ]);
}

/** Monospace block for a rendered diff or a YAML body. In the Tab order,
 *  because a long line scrolls sideways. */
function pre(text) {
  return el("pre", { class: "rawjson", tabindex: "0", text: text === "" ? "(no change)" : text });
}

/**
 * The read-only state a spec read answered (`readOnly`), as this screen
 * shows it. Pure. A spec carrying settings the schema in use does not know
 * takes no write here: the notice says why in words, and every write control
 * is held (`aria-disabled`, described by the notice) without leaving the
 * focus order.
 */
export function readOnlyModel(readOnly) {
  if (!readOnly || typeof readOnly !== "object") {
    return { held: false, notice: "", paths: [], verb: null };
  }
  return {
    held: true,
    notice:
      typeof readOnly.reason === "string" && readOnly.reason !== ""
        ? readOnly.reason
        : "This spec is read-only here.",
    paths: Array.isArray(readOnly.paths) ? readOnly.paths.map(String) : [],
    verb: typeof readOnly.verb === "string" ? readOnly.verb : null,
  };
}

/** The read-only notice's sentence: what every held control is described by. */
const READ_ONLY_REASON_ID = "spec-read-only-reason";

/**
 * Mark a write control, and hold it while the spec is read-only: still
 * focusable, announced as unavailable, described by the reason first and then
 * by its own description. Its handler returns before any request while held.
 */
function holdWhenReadOnly(control, live) {
  control.dataset.write = "true";
  if (live?.readOnly?.held === true) {
    control.setAttribute("aria-disabled", "true");
    const own = (control.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((token) => token !== "" && token !== READ_ONLY_REASON_ID);
    control.setAttribute("aria-describedby", [READ_ONLY_REASON_ID, ...own].join(" "));
  }
  return control;
}

/** True while a control is held (read-only spec, or a write in flight). */
const isHeld = (control) => control.getAttribute("aria-disabled") === "true";

/** The notice a read-only spec renders above the editor: the reason, then the one command, when there is one. */
function readOnlyCard(model) {
  return el("div", { class: "card spec-read-only" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Read-only here" }),
      dot("warn", "read-only"),
    ]),
    el("p", { id: READ_ONLY_REASON_ID, text: model.notice }),
    model.verb === null
      ? null
      : el("p", { class: "muted" }, [
          el("span", { text: "Run " }),
          el("code", { text: model.verb }),
        ]),
  ]);
}

/** The sentence a rename or a budget raise adds to a confirmation's lead, or "". */
function escalationLead(body) {
  const rows = Array.isArray(body?.escalations) ? body.escalations : [];
  return rows
    .map((row) => (typeof row?.warning === "string" ? row.warning : ""))
    .filter((text) => text !== "")
    .join(" ");
}

/**
 * Report the outcome of a write.
 *
 * Four distinct answers live behind one call, and collapsing them would
 * throw away the interesting one: a transport failure, a typed refusal the
 * server answered 200 with (`ok:false` — "that version is not in the
 * registry"), a 409 gate ("type the spec name"), and a 412 that says the
 * spec changed on disk since the editor read it. Each gets its own answer.
 *
 * The 412, when it carries the server's current state (`body.current`),
 * opens the conflict view rather than a toast, so the draft is never lost:
 * `conflict.retry(rev)` re-sends the same edit against the new revision,
 * `conflict.reload()` takes the version on disk, and `conflict.draft` is
 * what "Download my draft" saves.
 *
 * Only an auto-tunable write may be re-sent as it was. A write that needed
 * the spec's name typed carries `conflict.reconfirm(rev)` instead, which
 * shows the diff against the version on disk now and asks for the name
 * again: a confirmation typed against one version of the spec never applies
 * an edit on top of another.
 */
export function reportWrite(res, okMessage, conflict = null) {
  if (res === null || res === undefined) {
    toast("No answer from the manager");
    return false;
  }
  if (res.status === 412 && res.body?.current && typeof res.body.current === "object") {
    openConflict(res.body.current, okMessage, conflict);
    return false;
  }
  if (!res.ok) {
    const message =
      typeof res.body?.error === "string" ? res.body.error : `HTTP ${res.status ?? "?"}`;
    toast(message);
    return false;
  }
  if (res.body?.ok === false) {
    toast(`${res.body.code ?? "refused"}: ${res.body.reason ?? "refused"}`, "info");
    return false;
  }
  toast(okMessage, "info");
  return true;
}

const nonEmpty = (v) => (typeof v === "string" && v !== "" ? v : null);

/**
 * The text "Download my draft" saves: the caller's own copy of the refused
 * edit, else the draft the server kept (`current.draftId`, read through
 * `specDraft` for harness `conflict.id`, masked), else nothing — and then
 * the view offers no download. `fetchDraft` is the read (a test seam).
 */
export async function draftTextFor(
  current,
  conflict,
  fetchDraft = (params) => api.specDraft(params),
) {
  const cur = current && typeof current === "object" ? current : {};
  const c = conflict && typeof conflict === "object" ? conflict : {};
  const own = nonEmpty(c.draft) ?? nonEmpty(cur.draft);
  if (own !== null) return own;
  const draftId = nonEmpty(cur.draftId);
  const id = nonEmpty(c.id);
  if (draftId === null || id === null) return "";
  try {
    const res = await fetchDraft({ id, draft: draftId });
    const body = res?.ok && res.body && typeof res.body === "object" ? res.body : null;
    if (body === null) return "";
    const yaml = nonEmpty(body.yaml);
    if (yaml !== null) return yaml;
    return Array.isArray(body.edits) && body.edits.length > 0
      ? JSON.stringify(body.edits, null, 2)
      : "";
  } catch {
    return "";
  }
}

/** The conflict view, in a dialog. Nothing is written until a choice is made.
 *  Focus goes back to the control that made the write (`conflict.opener`).
 *  "Re-apply" is offered only when the caller can re-apply
 *  (`conflict.reconfirm` or `conflict.retry`). */
export async function openConflict(current, okMessage, conflict) {
  const c = conflict && typeof conflict === "object" ? conflict : {};
  const draft = await draftTextFor(current, c);
  let dialog = null;
  const view = conflictView({
    current: { ...current, draft },
    canReapply: typeof c.reconfirm === "function" || typeof c.retry === "function",
    onReapply: async (rev) => {
      dialog?.close();
      if (typeof c.reconfirm === "function") {
        await c.reconfirm(rev);
        return;
      }
      if (typeof c.retry !== "function") return;
      const again = await c.retry(rev);
      if (reportWrite(again, okMessage, c) && typeof c.done === "function") c.done();
    },
    onUseDisk: () => {
      dialog?.close();
      if (typeof c.reload === "function") c.reload();
    },
  });
  dialog = openDialog({
    title: "This changed since you opened it",
    body: [view],
    actions: [
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Close",
        onClick: () => dialog?.close(),
      }),
    ],
    initialFocus: "heading",
    returnFocus: c.opener instanceof HTMLElement ? c.opener : undefined,
  });
  return dialog;
}

/**
 * The typed-confirmation dialog: the operator types the spec's name and the
 * SERVER verifies it. The button stays disabled until the text matches, so
 * the dialog cannot be dismissed by muscle memory — and a click on the
 * backdrop does not close it, so a half-typed name is never lost.
 */
function confirmModal({ title, lead, detail, confirmName, action, onConfirm }) {
  return confirmAction({
    level: "typed",
    title,
    titleExtra: dot("warn", "human-owned"),
    lead,
    detail,
    confirmName,
    action,
    onConfirm: () => onConfirm(),
  });
}

/**
 * Re-apply a typed-confirm edit after a conflict: diff it against the spec
 * as it is on disk now, then ask for the spec's name again. Nothing is sent
 * until the name is typed; the name the first dialog took is never reused.
 */
async function reconfirmEdit(ctx, { edits, rev, label, okMessage, conflict }) {
  const preview = await api.specDiff({ id: ctx.id }, { edits });
  if (!preview?.ok) {
    toast(preview?.body?.error ?? `HTTP ${preview?.status ?? "?"}`);
    return;
  }
  const body = preview.body ?? {};
  if (body.ok === false) {
    toast(`${body.code ?? "refused"}: ${body.reason ?? "this edit does not apply"}`);
    return;
  }
  const confirmName = String(body.confirmName ?? "");
  if (confirmName === "") {
    toast("The manager sent no spec name to confirm, so nothing was applied");
    return;
  }
  confirmModal({
    title: `Re-apply ${label}`,
    lead: "The spec changed since you confirmed this edit. Read the diff against the version on disk now, then type the spec name again to apply it on top.",
    detail: [pre(String(body.diff ?? ""))],
    confirmName,
    action: "Apply to the live spec",
    onConfirm: async () => {
      const res = await api.specEdit({ id: ctx.id }, { edits, confirmName, expectedRev: rev });
      if (reportWrite(res, okMessage, conflict) && typeof conflict.done === "function") {
        conflict.done();
      }
    },
  });
}

/** A plain (untyped) dialog for previews — a version's YAML, a diff — or for
 *  a form (`holdsInput`), which a stray backdrop click must not close. */
function viewModal(title, children, holdsInput = false) {
  let dialog = null;
  dialog = openDialog({
    title,
    body: children,
    actions: [
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Close",
        onClick: () => dialog?.close(),
      }),
    ],
    dismissOnBackdrop: !holdsInput,
    initialFocus: holdsInput ? undefined : "heading",
  });
  return dialog;
}

/** A 501 stub, rendered as the fact it is rather than as a broken panel. */
function stubCard(title, res) {
  return card(title, dot("off", "not built yet (M3)"), [
    el("p", {
      class: "muted",
      text:
        typeof res?.error?.message === "string"
          ? res.error.message
          : typeof res?.body?.error === "string"
            ? res.body.error
            : "the server has no handler for this yet",
    }),
  ]);
}

const isStub = (res) => res !== null && res !== undefined && res.status === 501;

// ---------------------------------------------------------------------------
// effective configuration + diagnostics
// ---------------------------------------------------------------------------

function schemaBadge(body) {
  if (body.schemaSource === "harness") {
    return dot("ok", `validated against this harness's schema${suffix(body.schemaVersion)}`);
  }
  return dot("warn", "validated against the manager's schema");
}

const suffix = (version) => (typeof version === "string" && version !== "" ? ` (${version})` : "");

/**
 * The effective-config table: what this harness is ACTUALLY configured to
 * do. A `default` row is a value nobody wrote down — which is exactly the
 * question raw YAML cannot answer.
 */
function effectiveCard(body) {
  const rows = Array.isArray(body.effective) ? body.effective : [];
  const declared = Number(body.declaredCount ?? 0);
  const defaulted = Number(body.defaultedCount ?? 0);
  const inner = [];
  inner.push(
    el("p", { class: "muted" }, [
      el("span", { text: `${declared} declared · ${defaulted} from the schema's defaults` }),
    ]),
  );
  if (typeof body.effectiveNote === "string" && body.effectiveNote !== "") {
    inner.push(
      el("p", { class: "reason" }, [dot("warn", "defaults unavailable"), body.effectiveNote]),
    );
  }
  if (rows.length === 0) {
    inner.push(emptyState("Nothing to show yet — the spec has to validate first", "crewhaus init"));
  } else {
    const body_ = rows.map((row) =>
      el("tr", null, [
        el("td", { class: "mono", text: String(row.path ?? "") }),
        el("td", { class: "mono", text: renderValue(row.value) }),
        el("td", null, [
          row.source === "declared"
            ? dot("ok", "declared")
            : dot("unknown", "default (not in the file)"),
        ]),
      ]),
    );
    inner.push(table(["Path", "Value", "Source"], body_, "Effective configuration"));
  }
  const issues = Array.isArray(body.issues) ? body.issues : [];
  if (issues.length > 0) {
    inner.push(
      el("h4", { class: "sub-title", text: "Diagnostics" }),
      el(
        "ul",
        { class: "issue-list" },
        issues.map((issue) =>
          el("li", null, [
            dot("bad", String(issue.message ?? "issue")),
            el("code", { text: Array.isArray(issue.path) ? issue.path.join(".") : "(root)" }),
          ]),
        ),
      ),
    );
  }
  inner.push(
    el("p", { class: "muted" }, [
      el("span", { text: "Compile warnings (accepted-but-unwired keys) come from " }),
      el("code", { text: String(body.warningsVerb ?? "crewhaus compile") }),
      el("span", { text: " — this view does not run the compiler." }),
    ]),
  );
  return card("Effective configuration", schemaBadge(body), inner);
}

function renderValue(value) {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  try {
    const rendered = JSON.stringify(value);
    return rendered.length > 80 ? `${rendered.slice(0, 79)}…` : rendered;
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// the settings form — every setting the schema describes
// ---------------------------------------------------------------------------

/**
 * Values typed into the form and not saved yet, by harness and setting. They
 * survive a re-render that another write on this page causes. Kept in memory
 * only, never in stored drafts: a person can paste a key into this editor.
 */
const unsaved = new Map();
const unsavedKey = (ctx, node) => `${ctx.id}\u0000${node.key}`;

/** Ids of one render of the form; a re-render mints new ones. */
let formSeq = 0;

/** What a saved setting says: it is saved, and not active yet. */
export function savedMessage(node) {
  const segments = Array.isArray(node?.segments) ? node.segments.map(String) : [];
  const label = String(node?.label ?? segments.join("."));
  if (segments[0] === "permissions" && segments[1] === "delegation") {
    return `Saved ${label}. It is not active until a person activates a deployment.`;
  }
  return `Saved ${label}. It is not active until the harness is rebuilt.`;
}

/** The words a field's state is shown with, beside its traffic light. */
function fieldBadge(node) {
  if (node.security === true) return dot("bad", "security setting");
  if (node.tier === "auto-tunable") return dot("ok", "saves directly");
  if (node.tier === "human-owned") return dot("warn", "needs your confirmation");
  return dot("unknown", "reviewed before saving");
}

/** A refusal whose issues the form can place beside their fields. */
function rejectedIssues(res) {
  const body = res?.ok === true ? res.body : null;
  return body?.ok === false &&
    body.code === "edit_rejected" &&
    Array.isArray(body.issues) &&
    body.issues.length > 0
    ? body.issues
    : null;
}

/** Set a control's description ids, the read-only reason first when it is held. */
function describe(control, ids) {
  const held = (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .includes(READ_ONLY_REASON_ID);
  const tokens = [...(held ? [READ_ONLY_REASON_ID] : []), ...ids.filter((id) => id !== "")];
  if (tokens.length === 0) control.removeAttribute("aria-describedby");
  else control.setAttribute("aria-describedby", tokens.join(" "));
}

/** The options of a choice, with "Not set" first when the setting has no value. */
function choiceSelect(id, options, current, labelFor) {
  const select = el("select", { class: "input", id });
  const unset = current === undefined;
  if (unset) select.appendChild(el("option", { value: "", text: "Not set" }));
  options.forEach((option, index) => {
    const opt = el("option", { value: String(index), text: labelFor(option) });
    if (!unset && JSON.stringify(option) === JSON.stringify(current)) opt.selected = true;
    select.appendChild(opt);
  });
  return select;
}

const optionText = (value) => (value === null ? "None" : String(value));
const yesNo = (value) => (value === true ? "Yes" : value === false ? "No" : String(value));

/**
 * The settings form: one fieldset per block the spec declares, the blocks only
 * the schema's defaults set collapsed under "Using defaults", and the settings
 * at the top level in their own fieldset. Every control is labelled; its help
 * and any issue describe it. A save is one edit: a setting the optimizer may
 * write saves directly, any other is reviewed first (the server's preview says
 * what it needs), and an issue the schema finds is placed beside its field.
 */
function settingsCard(ctx, body, trust, live, reload) {
  const trustRows = Array.isArray(trust?.paths) ? trust.paths : [];
  const model = formModel(body.schema, body.effective, trustRows);
  const prefix = `sf${++formSeq}`;
  const fields = new Map();
  let seq = 0;
  const nextId = (what) => `${prefix}-${what}-${++seq}`;

  const issueBox = el("div", { class: "settings-issues", hidden: true });
  const defaultsPanel = el("div", {
    class: "settings-defaults",
    id: `${prefix}-defaults`,
    hidden: true,
  });
  const defaultsBtn = el("button", {
    class: "btn btn-ghost disclosure-btn",
    type: "button",
    "aria-expanded": "false",
    "aria-controls": defaultsPanel.id,
    text: "Using defaults",
  });
  const expandDefaults = (open) => {
    defaultsPanel.hidden = !open;
    defaultsBtn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  defaultsBtn.addEventListener("click", () => expandDefaults(defaultsPanel.hidden));

  const form = {
    /** Put each issue beside its field and list them above the form; focus the first placed one. */
    showIssues(issues, focusFirst) {
      for (const field of fields.values()) {
        field.slot.hidden = true;
        field.slot.textContent = "";
        if (field.input !== null) field.input.removeAttribute("aria-invalid");
        for (const target of field.described) describe(target, field.baseIds(target));
      }
      const { byPath, unplaced } = issuesByField(model.groups, issues);
      const placed = [];
      for (const [key, list] of byPath) {
        const field = fields.get(key);
        if (field === undefined) {
          unplaced.push(...list);
          continue;
        }
        field.slot.textContent = list.map((issue) => String(issue?.message ?? "")).join(" ");
        field.slot.hidden = false;
        if (field.input !== null) field.input.setAttribute("aria-invalid", "true");
        for (const target of field.described) {
          describe(target, [...field.baseIds(target), field.slot.id]);
        }
        if (defaultsPanel.contains(field.slot)) expandDefaults(true);
        // A block of defaults folded inside another opens, so the issue is seen.
        for (let fold = field.slot.closest("details"); fold !== null; ) {
          fold.open = true;
          fold = fold.parentElement?.closest("details") ?? null;
        }
        placed.push({ field, list });
      }
      clear(issueBox);
      issueBox.hidden = placed.length === 0 && unplaced.length === 0;
      if (!issueBox.hidden) {
        issueBox.appendChild(el("h4", { class: "sub-title", text: "Fix these first" }));
        issueBox.appendChild(
          el("ul", { class: "issue-list" }, [
            ...placed.map(({ field, list }) => {
              const go = el("button", {
                class: "btn btn-ghost",
                type: "button",
                text: `${field.node.label}: ${list.map((i) => String(i?.message ?? "")).join(" ")}`,
              });
              go.addEventListener("click", () => field.focusTarget.focus());
              return el("li", null, [dot("bad", "problem"), go]);
            }),
            ...unplaced.map((issue) =>
              el("li", null, [
                dot("bad", String(issue?.message ?? "problem")),
                el("code", {
                  text:
                    Array.isArray(issue?.path) && issue.path.length > 0
                      ? issue.path.join(".")
                      : "(the whole spec)",
                }),
              ]),
            ),
          ]),
        );
      }
      if (focusFirst === true) {
        const first = placed[0]?.field.focusTarget ?? issueBox.querySelector("button");
        if (first instanceof HTMLElement) first.focus();
      }
    },
  };

  /** The JSON pane for one node's path, from a button that stays its opener. */
  const jsonButton = (node, label, describedBy) => {
    const open = holdWhenReadOnly(
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: label,
        dataset: { focusKey: `json:${node.key}` },
      }),
      live,
    );
    if (describedBy.length > 0) describe(open, describedBy);
    open.addEventListener("click", () => {
      if (isHeld(open)) return;
      valueDialog(ctx, {
        path: node.segments.join("."),
        segments: node.segments,
        value: node.paneSeed,
        pathEditable: false,
        reload,
        live,
        opener: open,
        form,
      });
    });
    return open;
  };

  /** Write one field's edit: directly when the optimizer may, reviewed otherwise. */
  const write = async (node, input, opener) => {
    if (isHeld(opener)) return;
    const edit = fieldEdit(node, input);
    if (edit === null) {
      toast(`Nothing to save: ${node.label} is unchanged.`, "info");
      return;
    }
    const focusKey = opener.dataset.focusKey;
    const saved = () => {
      unsaved.delete(unsavedKey(ctx, node));
      reload({ focusKey });
    };
    if (node.tier === "auto-tunable" && node.security !== true) {
      // Held with aria-disabled, not `disabled`: a disabled button drops focus
      // to the page, and the answer may open a dialog that must return it here.
      opener.setAttribute("aria-disabled", "true");
      const res = await api.specPatch({ id: ctx.id }, { edit, expectedRev: live?.rev ?? "" });
      opener.removeAttribute("aria-disabled");
      const issues = rejectedIssues(res);
      if (issues !== null) {
        form.showIssues(issues, true);
        return;
      }
      const conflict = {
        opener,
        draft: JSON.stringify(edit, null, 2),
        retry: (rev) => api.specPatch({ id: ctx.id }, { edit, expectedRev: rev }),
        reload,
        done: saved,
      };
      if (reportWrite(res, savedMessage(node), conflict)) saved();
      return;
    }
    await reviewAndApply(ctx, {
      edits: [edit],
      label: node.label,
      okMessage: savedMessage(node),
      live,
      opener,
      form,
      reload,
      done: saved,
    });
  };

  /** One setting the form can show: its label, help, control, state and actions. */
  const leaf = (node) => {
    const id = nextId("field");
    const labelId = `${id}-label`;
    const helpId = node.help !== null || node.writeOnly ? `${id}-help` : "";
    const slot = el("p", { class: "field-issue", id: `${id}-issue`, hidden: true });
    const draftAt = unsavedKey(ctx, node);
    const kept = unsaved.has(draftAt) ? unsaved.get(draftAt) : undefined;
    const current = kept !== undefined ? kept : node.writeOnly ? undefined : node.seed;
    const remember = (value) => unsaved.set(draftAt, value);
    let input = null;
    let read = () => undefined;
    let control;
    if (node.kind === "boolean") {
      input = choiceSelect(id, [true, false], current, yesNo);
      read = () => (input.value === "" ? "" : input.value === "0");
      input.addEventListener("change", () => remember(input.value === "" ? undefined : read()));
      control = input;
    } else if (node.kind === "select") {
      const options = Array.isArray(node.options) ? node.options : [];
      input = choiceSelect(id, options, current, optionText);
      read = () => (input.value === "" ? undefined : options[Number(input.value)]);
      input.addEventListener("change", () => remember(read()));
      control = input;
    } else if (node.kind === "list") {
      const list = listEditor(
        node,
        id,
        labelId,
        Array.isArray(current) ? current : [],
        live,
        remember,
      );
      read = list.read;
      control = list.node;
      input = list.first;
    } else {
      const multiline = typeof current === "string" && current.includes("\n");
      input = multiline
        ? el("textarea", { class: "input notes", id, rows: 4, spellcheck: "false" })
        : el("input", {
            class: "input",
            id,
            type: "text",
            autocomplete: "off",
            ...(node.kind === "integer" ? { inputmode: "numeric" } : {}),
            ...(node.kind === "number" ? { inputmode: "decimal" } : {}),
          });
      input.value = current === undefined || current === null ? "" : String(current);
      read = () => input.value;
      input.addEventListener("input", () => remember(input.value));
      control = input;
    }
    if (input !== null && node.kind !== "list") {
      input.dataset.focusKey = `input:${node.key}`;
    }
    const isAuto = node.tier === "auto-tunable" && node.security !== true;
    const save = holdWhenReadOnly(
      el("button", {
        class: isAuto ? "btn btn-primary" : "btn",
        type: "button",
        text: isAuto ? "Save" : "Review and apply",
        "aria-label": `${isAuto ? "Save" : "Review and apply"} ${node.label}`,
        dataset: { focusKey: `save:${node.key}` },
      }),
      live,
    );
    save.addEventListener("click", () => void write(node, read(), save));
    const clearBtn =
      node.nullable === true && node.source === "declared"
        ? holdWhenReadOnly(
            el("button", {
              class: "btn btn-ghost",
              type: "button",
              text: "Clear",
              "aria-label": `Clear ${node.label}`,
              dataset: { focusKey: `clear:${node.key}` },
            }),
            live,
          )
        : null;
    clearBtn?.addEventListener("click", () => void write(node, CLEAR, clearBtn));
    const help =
      helpId === ""
        ? null
        : el("p", {
            class: "muted field-help",
            id: helpId,
            text: node.writeOnly
              ? `Value hidden. Type a new value to replace it.${node.help === null ? "" : ` ${node.help}`}`
              : node.help,
          });
    const field = {
      node,
      slot,
      input: node.kind === "list" ? null : input,
      focusTarget: input ?? save,
      described: [node.kind === "list" ? control : input],
      baseIds: () => (helpId === "" ? [] : [helpId]),
    };
    describe(field.described[0], field.baseIds());
    fields.set(node.key, field);
    return el("div", { class: "form-field", dataset: { fieldKey: node.key } }, [
      el("div", { class: "form-field-head" }, [
        node.kind === "list"
          ? el("span", { class: "form-label", id: labelId, text: node.label })
          : el("label", { class: "form-label", for: id, id: labelId, text: node.label }),
        fieldBadge(node),
      ]),
      help,
      el("div", { class: "row-editor" }, [control, save, clearBtn]),
      slot,
      el("p", { class: "muted field-path" }, [
        el("span", { text: "Setting " }),
        el("code", { text: node.segments.join(".") }),
      ]),
    ]);
  };

  /** A setting edited in the JSON pane, with the reason it is. */
  const jsonLeaf = (node) => {
    const id = nextId("json");
    const slot = el("p", { class: "field-issue", id: `${id}-issue`, hidden: true });
    const whyId = `${id}-why`;
    const button = jsonButton(node, "Edit as JSON…", [whyId]);
    button.setAttribute("aria-label", `Edit as JSON… ${node.label}`);
    fields.set(node.key, {
      node,
      slot,
      input: null,
      focusTarget: button,
      described: [button],
      baseIds: () => [whyId],
    });
    return el("div", { class: "form-field", dataset: { fieldKey: node.key } }, [
      el("div", { class: "form-field-head" }, [
        el("span", { class: "form-label", text: node.label }),
        fieldBadge(node),
      ]),
      node.help === null ? null : el("p", { class: "muted field-help", text: node.help }),
      el("p", { class: "muted", id: whyId, text: node.why }),
      el("div", { class: "row-editor" }, [button]),
      slot,
      el("p", { class: "muted field-path" }, [
        el("span", { text: "Setting " }),
        el("code", { text: node.segments.join(".") }),
      ]),
    ]);
  };

  /**
   * A block of settings: a fieldset named by its legend, its own JSON pane, its children.
   * A block inside another that only the schema's defaults set is folded, named by its
   * summary, so a declared block reads as what the file says.
   */
  const group = (node, top) => {
    const id = nextId("group");
    const slot = el("p", { class: "field-issue", id: `${id}-issue`, hidden: true });
    const helpId = node.help === null ? "" : `${id}-help`;
    const button = jsonButton(node, "Edit as JSON…", helpId === "" ? [] : [helpId]);
    button.setAttribute("aria-label", `Edit as JSON… all of ${node.label}`);
    fields.set(node.key, {
      node,
      slot,
      input: null,
      focusTarget: button,
      described: [button],
      baseIds: () => (helpId === "" ? [] : [helpId]),
    });
    const content = [
      helpId === "" ? null : el("p", { class: "muted field-help", id: helpId, text: node.help }),
      el("div", { class: "row-editor" }, [button]),
      slot,
      ...(node.children ?? []).map(render),
    ];
    if (top || node.source === "declared") {
      return el("fieldset", { class: top ? "settings-block" : "settings-block nested" }, [
        el("legend", { text: node.label }),
        ...content,
      ]);
    }
    const summaryId = `${id}-summary`;
    return el("details", { class: "fold settings-fold" }, [
      el("summary", { class: "fold-summary", id: summaryId }, [
        el("span", { class: "form-label", text: node.label }),
        el("span", { class: "muted", text: " using defaults" }),
      ]),
      el("fieldset", { class: "settings-block nested", "aria-labelledby": summaryId }, content),
    ]);
  };

  const render = (node) =>
    node.kind === "group" ? group(node, false) : node.kind === "json" ? jsonLeaf(node) : leaf(node);

  const declared = (node) => node.source === "declared";
  const topLeaves = model.groups.filter((n) => n.kind !== "group");
  const topGroups = model.groups.filter((n) => n.kind === "group");
  const shown = [];
  const general = topLeaves.filter(declared);
  if (general.length > 0) {
    shown.push(
      el("fieldset", { class: "settings-block" }, [
        el("legend", { text: "General" }),
        ...general.map(render),
      ]),
    );
  }
  for (const node of topGroups.filter(declared)) shown.push(group(node, true));
  const rest = [
    ...(topLeaves.some((n) => !declared(n))
      ? [
          el("fieldset", { class: "settings-block" }, [
            el("legend", { text: "Other settings" }),
            ...topLeaves.filter((n) => !declared(n)).map(render),
          ]),
        ]
      : []),
    ...topGroups.filter((n) => !declared(n)).map((n) => group(n, true)),
  ];
  for (const node of rest) defaultsPanel.appendChild(node);

  const addBlock = holdWhenReadOnly(
    el("button", {
      class: "btn",
      type: "button",
      text: "Edit any path…",
      dataset: { focusKey: "json:any" },
    }),
    live,
  );
  addBlock.addEventListener("click", () => {
    if (isHeld(addBlock)) return;
    valueDialog(ctx, {
      path: "",
      value: undefined,
      pathEditable: true,
      reload,
      live,
      opener: addBlock,
      form,
    });
  });

  const inner = [
    el("p", {
      class: "muted",
      text: "Each setting comes from the schema this harness is checked with. A save changes that one setting in crewhaus.yaml and leaves the rest of the file as it is.",
    }),
    body.effectiveTruncated === true
      ? el("p", {
          class: "reason",
          text: "Showing the first 600 settings. Edit the rest in the JSON pane or in crewhaus.yaml.",
        })
      : null,
    typeof body.effectiveNote === "string" && body.effectiveNote !== ""
      ? el("p", { class: "reason" }, [dot("warn", "values unavailable"), body.effectiveNote])
      : null,
    model.why === null ? null : el("p", { class: "reason", text: model.why }),
    issueBox,
    el("div", { class: "settings-form" }, [
      ...shown,
      rest.length > 0 ? el("div", { class: "settings-defaults-toggle" }, [defaultsBtn]) : null,
      rest.length > 0 ? defaultsPanel : null,
    ]),
    el("div", { class: "add-form" }, [
      el("p", {
        class: "muted grow",
        text: "A setting this form does not show, or a field inside a list item, is reachable by its path: the same preview and the same confirmation.",
      }),
      addBlock,
    ]),
  ];
  const node = card(
    "Settings",
    live.readOnly.held ? dot("warn", "read-only") : dot("ok", "editable"),
    inner,
  );
  node.classList.add("settings-card");
  // The answer to a read that already carried issues: place them now, without moving focus.
  if (Array.isArray(body.issues) && body.issues.length > 0) form.showIssues(body.issues, false);
  return node;
}

/**
 * A list of values: one input per item, with buttons to move an item up or
 * down and to remove it, and one to add an item. No dragging.
 */
function listEditor(node, id, labelId, initial, live, remember) {
  const items = initial.map((v) => (node.itemKind === "select" ? v : v === null ? "" : String(v)));
  const ul = el("ul", { class: "list-items" });
  const wrap = el("div", { class: "list-editor", role: "group", "aria-labelledby": labelId }, [ul]);
  const add = holdWhenReadOnly(
    el("button", { class: "btn btn-ghost", type: "button", text: "Add an item", id: `${id}-add` }),
    live,
  );
  const changed = () => remember(items.slice());
  const draw = (focus) => {
    clear(ul);
    items.forEach((value, index) => {
      const n = index + 1;
      let input;
      if (node.itemKind === "select") {
        const options = Array.isArray(node.itemOptions) ? node.itemOptions : [];
        input = choiceSelect(`${id}-item-${n}`, options, value, optionText);
        input.addEventListener("change", () => {
          items[index] = input.value === "" ? undefined : options[Number(input.value)];
          changed();
        });
      } else {
        input = el("input", {
          class: "input",
          type: "text",
          id: `${id}-item-${n}`,
          autocomplete: "off",
        });
        input.value = String(value ?? "");
        input.addEventListener("input", () => {
          items[index] = input.value;
          changed();
        });
      }
      input.setAttribute("aria-label", `${node.label}, item ${n}`);
      const button = (text, label, onPress) => {
        const b = holdWhenReadOnly(
          el("button", { class: "btn btn-ghost", type: "button", text, "aria-label": label }),
          live,
        );
        b.addEventListener("click", () => {
          if (isHeld(b)) return;
          onPress();
        });
        return b;
      };
      const up =
        index > 0
          ? button("Up", `Move item ${n} up`, () => {
              [items[index - 1], items[index]] = [items[index], items[index - 1]];
              changed();
              draw({ index: index - 1, what: "up" });
            })
          : null;
      const down =
        index < items.length - 1
          ? button("Down", `Move item ${n} down`, () => {
              [items[index + 1], items[index]] = [items[index], items[index + 1]];
              changed();
              draw({ index: index + 1, what: "down" });
            })
          : null;
      const remove = button("Remove", `Remove item ${n}`, () => {
        items.splice(index, 1);
        changed();
        draw({ index: Math.min(index, items.length - 1), what: "input" });
      });
      ul.appendChild(el("li", { class: "row-editor" }, [input, up, down, remove]));
    });
    if (focus !== undefined) {
      const row = ul.children[focus.index];
      const target =
        row === undefined
          ? add
          : focus.what === "up"
            ? (row.querySelector('[aria-label$=" up"]') ?? row.querySelector("input, select"))
            : focus.what === "down"
              ? (row.querySelector('[aria-label$=" down"]') ?? row.querySelector("input, select"))
              : row.querySelector("input, select");
      if (target instanceof HTMLElement) target.focus();
    }
  };
  add.addEventListener("click", () => {
    if (isHeld(add)) return;
    items.push(node.itemKind === "select" ? undefined : "");
    changed();
    draw({ index: items.length - 1, what: "input" });
  });
  draw();
  wrap.appendChild(add);
  return {
    node: wrap,
    first: null,
    read: () => items.filter((v) => v !== undefined),
  };
}

/**
 * Review an edit, then apply it: the server's preview says what would change and
 * what the batch needs. A batch the optimizer could make takes one confirmation;
 * any other takes the spec's name, typed. An issue the preview finds is placed
 * beside its field instead.
 */
async function reviewAndApply(ctx, { edits, label, okMessage, live, opener, form, reload, done }) {
  const preview = await api.specDiff({ id: ctx.id }, { edits });
  if (!preview?.ok) {
    toast(preview?.body?.error ?? `HTTP ${preview?.status ?? "?"}`);
    return;
  }
  const issues = rejectedIssues(preview);
  if (issues !== null) {
    form?.showIssues(issues, true);
    return;
  }
  const body = preview.body ?? {};
  if (body.ok === false) {
    toast(`${body.code ?? "refused"}: ${body.reason ?? "this edit does not apply"}`);
    return;
  }
  const auto = body.autoApplicable === true;
  const confirmName = String(body.confirmName ?? "");
  if (!auto && confirmName === "") {
    toast("The manager sent no spec name to confirm, so nothing was applied");
    return;
  }
  const warning = escalationLead(body);
  const previewRev = String(body.rev ?? live?.rev ?? "");
  confirmAction({
    level: auto ? "confirm" : "typed",
    title: `Change ${label}`,
    titleExtra: auto ? dot("ok", "saves directly") : dot("warn", "needs your confirmation"),
    lead: auto
      ? "Read the change, then apply it."
      : `${warning === "" ? "" : `${warning} `}A person confirms this setting. Read the change (values that could be secret are hidden), then type the spec name to apply it.`,
    detail: [pre(String(body.diff ?? ""))],
    confirmName,
    action: "Apply to the live spec",
    onConfirm: async () => {
      await applyEdits(ctx, {
        edits,
        ...(auto ? {} : { confirmName }),
        expectedRev: previewRev,
        label,
        okMessage,
        opener,
        form,
        reload,
        done,
      });
    },
  });
}

/**
 * Apply a reviewed batch with `specEdit`, against the revision its preview read.
 * A 412 opens the conflict view: an untyped batch may be sent again as it was,
 * a typed one asks for the name again over a fresh diff.
 */
async function applyEdits(
  ctx,
  { edits, confirmName, expectedRev, label, okMessage, opener, form, reload, done },
) {
  const typed = typeof confirmName === "string";
  const wrote = await api.specEdit(
    { id: ctx.id },
    { edits, ...(typed ? { confirmName } : {}), expectedRev },
  );
  const issues = rejectedIssues(wrote);
  if (issues !== null && form) {
    form.showIssues(issues, true);
    return wrote;
  }
  const conflict = {
    draft: JSON.stringify(edits, null, 2),
    reload,
    done,
    ...(opener instanceof HTMLElement ? { opener } : {}),
  };
  if (typed) {
    conflict.reconfirm = (rev) => reconfirmEdit(ctx, { edits, rev, label, okMessage, conflict });
  } else {
    conflict.retry = (rev) => api.specEdit({ id: ctx.id }, { edits, expectedRev: rev });
  }
  if (reportWrite(wrote, okMessage, conflict)) done();
  return wrote;
}

// ---------------------------------------------------------------------------
// the JSON pane — blocks, lists, and paths this spec has not declared
// ---------------------------------------------------------------------------

/**
 * A dotted path as the segment array the server's edit parser takes.
 *
 * A segment that is a non-negative integer becomes a NUMBER, because that is
 * the difference between `candidates.0.id` addressing the first list item
 * and addressing a mapping key called "0". Pure, so the rule is testable.
 */
export function editPath(dotted) {
  return String(dotted ?? "")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .map((segment) => (/^(?:0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : segment));
}

/**
 * Parse the pane's text into the value to write. Empty text is DELETE (the
 * server treats an edit with no `value` as one), which is how a block is
 * removed; anything else must be JSON — a subset of the YAML the spec is
 * written in, and the only structured format this dependency-free console
 * can parse without guessing.
 */
export function parseJsonValue(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return { ok: true, remove: true };
  try {
    return { ok: true, remove: false, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The one-edit batch a path + pane produce — or a refusal carrying the
 *  sentence to render, because "nothing happened" is not an answer. `path` is
 *  dotted, or the segments themselves (a key may hold a `.`). Text that still
 *  carries the masker's placeholder is refused: a masked read is a view, and
 *  is never written back. */
export function editsFor(path, text) {
  const segments = Array.isArray(path) ? path.map(String) : editPath(path);
  if (segments.length === 0) return { ok: false, message: "a path is required" };
  const parsed = parseJsonValue(text);
  if (!parsed.ok) return { ok: false, message: `that is not valid JSON: ${parsed.message}` };
  if (!parsed.remove && carriesMasked(parsed.value)) {
    return {
      ok: false,
      message:
        'Replace every "[redacted]" with the real value first. A hidden value is never written back.',
    };
  }
  // No `value` key at all ⇒ the server deletes the path. `value: undefined`
  // would not survive JSON.stringify, so the key is omitted deliberately.
  return {
    ok: true,
    edits: [parsed.remove ? { path: segments } : { path: segments, value: parsed.value }],
    removing: parsed.remove === true,
  };
}

/**
 * The pane. It writes NOTHING on its own: Preview asks `specDiff` what would
 * change and which tier the batch lands in, and only the answer decides what
 * the operator is offered — a plain Apply for an auto-tunable path (the
 * optimizer's own surface), or the typed confirmation for a human-owned one.
 * Both roads end at the same `specEdit` PUT, so the server remains the gate
 * and this screen stays the explanation. An issue the preview or the write
 * finds is shown here and placed beside its field in the form (`form`).
 * Focus goes back to `opener` when a conflict view it opens closes.
 */
function valueDialog(ctx, { path, segments, value, pathEditable, reload, live, opener, form }) {
  let dialog = null;
  // The form behind a modal cannot take focus: close the pane, then place the issues.
  const formBehind =
    form && typeof form.showIssues === "function"
      ? {
          showIssues: (issues, focusFirst) => {
            if (focusFirst === true && dialog !== null) dialog.close();
            form.showIssues(issues, focusFirst);
          },
        }
      : null;
  const pathInput = el("input", {
    class: "input grow",
    type: "text",
    value: path,
    placeholder: "agent.model_pool.candidates.0.id",
    "aria-label": "spec path — dotted, and a number is a list index",
  });
  const editor = el("textarea", {
    class: "input notes",
    rows: 12,
    spellcheck: "false",
    "aria-label": "value as JSON",
  });
  editor.value = value === undefined ? "" : JSON.stringify(value, null, 2);
  const out = el("div", { class: "modal-body" });

  const preview = el("button", { class: "btn btn-primary", type: "button", text: "Preview diff" });
  preview.addEventListener("click", async () => {
    const target = pathEditable || !Array.isArray(segments) ? pathInput.value.trim() : path;
    const batch = editsFor(
      pathEditable || !Array.isArray(segments) ? target : segments,
      editor.value,
    );
    clear(out);
    if (!batch.ok) {
      out.appendChild(el("p", { class: "reason", text: batch.message }));
      return;
    }
    const res = await api.specDiff({ id: ctx.id }, { edits: batch.edits });
    clear(out);
    if (!res.ok) {
      out.appendChild(el("p", { class: "reason", text: res.body?.error ?? `HTTP ${res.status}` }));
      return;
    }
    const body = res.body ?? {};
    if (body.ok === false) {
      out.appendChild(
        el("p", {
          class: "reason",
          text: `${body.code ?? "refused"}: ${body.reason ?? "this edit does not apply"}`,
        }),
      );
      const issues = rejectedIssues(res);
      if (issues !== null) {
        out.appendChild(
          el(
            "ul",
            { class: "issue-list" },
            issues.map((issue) =>
              el("li", null, [
                dot("bad", String(issue?.message ?? "issue")),
                el("code", {
                  text: Array.isArray(issue?.path) ? issue.path.join(".") : "(root)",
                }),
              ]),
            ),
          ),
        );
        // Beside their fields too, so they are still there when this pane closes.
        formBehind?.showIssues(issues, false);
      }
      return;
    }
    if (batch.removing) {
      out.appendChild(
        el("p", { class: "muted", text: `an empty pane DELETES ${target} from the spec` }),
      );
    }
    out.appendChild(pre(String(body.diff ?? "")));
    // The revision the preview read: the write is checked against it.
    const previewRev = String(body.rev ?? live?.rev ?? "");
    const apply = async (extra) => {
      const wrote = await applyEdits(ctx, {
        edits: batch.edits,
        ...(typeof extra.confirmName === "string" ? { confirmName: extra.confirmName } : {}),
        expectedRev: previewRev,
        label: target,
        okMessage: `Applied ${target}. It is not active until the harness is rebuilt.`,
        opener,
        form: formBehind,
        reload,
        done: () => {
          if (dialog !== null) dialog.close();
          reload(opener instanceof HTMLElement ? { focusKey: opener.dataset.focusKey } : {});
        },
      });
      if (wrote?.status === 412 && dialog !== null) dialog.close();
    };
    if (body.autoApplicable === true) {
      const go = el("button", { class: "btn btn-primary", type: "button", text: "Apply" });
      go.addEventListener("click", () => {
        void apply({});
      });
      out.appendChild(
        el("p", {
          class: "muted",
          text: "every path in this edit is auto-tunable — the surface the optimizer already writes.",
        }),
      );
      out.appendChild(el("div", { class: "modal-actions" }, [go]));
      return;
    }
    const confirmName = String(body.confirmName ?? "");
    const warning = escalationLead(body);
    if (warning !== "") out.appendChild(el("p", { class: "gated-why", text: warning }));
    const typed = el("input", {
      class: "input",
      type: "text",
      placeholder: confirmName,
      "aria-label": `type ${confirmName} to confirm`,
    });
    const go = el("button", {
      class: "btn btn-danger",
      type: "button",
      text: "Apply to the live spec",
      disabled: true,
    });
    typed.addEventListener("input", () => {
      go.disabled = typed.value.trim() !== confirmName;
    });
    go.addEventListener("click", () => {
      void apply({ confirmName });
    });
    // The same batch, sent for review instead — the road the scalar rows
    // offer, and the reason this pane can name it without lying.
    const propose = el("button", { class: "btn btn-ghost", type: "button", text: "Propose" });
    propose.addEventListener("click", async () => {
      const staged = await api.specPropose(
        { id: ctx.id },
        { edits: batch.edits, title: `hangar: ${target}` },
      );
      if (
        reportWrite(
          staged,
          "Proposal staged — the review bundle is a dry run until you open the PR",
        )
      ) {
        if (dialog !== null) dialog.close();
        reload();
      }
    });
    out.appendChild(
      el("p", {
        class: "muted",
        text: "This batch touches a human-owned path, so the server asks for the spec's name in writing — or send the same edit for review instead.",
      }),
    );
    out.appendChild(
      el("label", { class: "field" }, [
        el("span", { text: `Type ${confirmName} to confirm` }),
        typed,
      ]),
    );
    out.appendChild(el("div", { class: "modal-actions" }, [go, propose]));
  });

  dialog = viewModal(
    pathEditable ? "Edit a spec path" : `Edit ${path}`,
    [
      pathEditable
        ? el("label", { class: "field grow" }, [
            el("span", { text: "Path (dotted; a number is a list index)" }),
            pathInput,
          ])
        : el("p", { class: "muted mono", text: path }),
      el("p", {
        class: "muted",
        text: "The value is JSON. An empty pane deletes the path. Nothing is written until the diff below has been read.",
      }),
      editor,
      el("div", { class: "modal-actions" }, [preview]),
      out,
    ],
    true,
  );
  return dialog;
}

// ---------------------------------------------------------------------------
// version history
// ---------------------------------------------------------------------------

function versionsCard(ctx, body, reload) {
  const versions = Array.isArray(body.versions) ? body.versions : [];
  const pins = body.pins && typeof body.pins === "object" ? body.pins : {};
  const confirmName = String(body.confirmName ?? "");
  const inner = [];
  const pinEntries = Object.entries(pins);
  inner.push(
    el("p", { class: "muted" }, [
      el("span", { text: "Registry: " }),
      el("code", { text: String(body.dir ?? "") }),
    ]),
  );
  if (pinEntries.length > 0) {
    inner.push(
      el(
        "div",
        { class: "chip-group" },
        pinEntries.map(([env, version]) =>
          el("span", { class: "chip", text: `${env} → ${version}` }),
        ),
      ),
    );
  }
  if (versions.length === 0) {
    inner.push(
      emptyState(
        typeof body.note === "string" && body.note !== ""
          ? body.note
          : "No spec versions registered yet",
        typeof body.verb === "string" ? body.verb : "crewhaus spec put",
      ),
    );
  } else {
    inner.push(
      table(
        ["Version", "Pinned to", "Provenance", "", ""],
        versions.map((version) => versionRow(ctx, version, confirmName, reload)),
        "Version history",
      ),
    );
  }
  if (typeof body.changelog === "string" && body.changelog !== "") {
    inner.push(
      collapsible(
        [el("span", { class: "muted", text: "CHANGELOG (credential-redacted)" })],
        [pre(body.changelog)],
      ),
    );
  }
  return card(
    "Version history",
    body.present === true
      ? dot("ok", `${versions.length} versions`)
      : dot("off", "no registry yet"),
    inner,
  );
}

function versionRow(ctx, version, confirmName, reload) {
  const id = String(version.version ?? "");
  const provenance = version.provenance;
  const view = el("button", { class: "btn btn-ghost", type: "button", text: "View" });
  view.addEventListener("click", async () => {
    const res = await api.specVersion({ id: ctx.id, version: id });
    if (!res.ok || res.body?.present === false) {
      toast(res.body?.note ?? "that version's file is gone");
      return;
    }
    viewModal(`${id} (values masked server-side)`, [
      pre(String(res.body?.yaml ?? "")),
      copyBtn(String(res.body?.yaml ?? ""), "copy yaml"),
    ]);
  });
  const diff = el("button", { class: "btn btn-ghost", type: "button", text: "Diff vs live" });
  diff.addEventListener("click", async () => {
    const res = await api.specVersionDiff({ id: ctx.id, version: id });
    if (!res.ok) {
      toast(res.body?.error ?? `HTTP ${res.status}`);
      return;
    }
    viewModal(`${id} vs the live spec`, [
      res.body?.note ? el("p", { class: "muted", text: String(res.body.note) }) : null,
      pre(String(res.body?.diff ?? "")),
    ]);
  });
  const pin = el("button", { class: "btn", type: "button", text: "Pin to…" });
  pin.addEventListener("click", () => pinDialog(ctx, id, confirmName, reload));
  return el("tr", null, [
    el("td", { class: "mono" }, [
      el("span", { text: id }),
      version.isCurrent === true ? el("span", { class: "chip", text: "current" }) : null,
      version.present === false
        ? el("span", { class: "chip chip-warn", text: "file missing" })
        : null,
    ]),
    el("td", null, [
      Array.isArray(version.pinnedEnvs) && version.pinnedEnvs.length > 0
        ? el(
            "div",
            { class: "chip-group" },
            version.pinnedEnvs.map((env) => el("span", { class: "chip", text: env })),
          )
        : el("span", { class: "muted", text: "—" }),
    ]),
    el("td", { class: "muted", text: provenanceText(provenance) }),
    el("td", { class: "cell-actions" }, [view, diff]),
    el("td", { class: "cell-actions" }, [pin]),
  ]);
}

function provenanceText(provenance) {
  if (provenance === null || provenance === undefined || typeof provenance !== "object") {
    return "hand-authored";
  }
  const parts = [];
  if (provenance.runId) parts.push(`optimizer ${provenance.runId}`);
  if (provenance.mutator) parts.push(String(provenance.mutator));
  if (provenance.scoreBefore !== undefined && provenance.scoreAfter !== undefined) {
    parts.push(`score ${provenance.scoreBefore} → ${provenance.scoreAfter}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "optimizer";
}

/** Pin or roll back an environment to a version. Both shell the audited
 *  deploy verb server-side; both are typed-confirm here. */
function pinDialog(ctx, version, confirmName, reload) {
  const envInput = el("input", {
    class: "input",
    type: "text",
    value: "prod",
    "aria-label": "environment",
  });
  const rollback = el("input", { type: "checkbox", "aria-label": "treat this as a rollback" });
  confirmModal({
    title: `Pin ${version}`,
    lead: "Pins move through the deploy verbs, so the audit record and a protected environment's approval quorum are preserved. The manager never writes the manifest itself.",
    detail: [
      el("label", { class: "field" }, [el("span", { text: "Environment" }), envInput]),
      el("label", { class: "check modal-check" }, [
        rollback,
        el("span", { text: "This is a rollback (the environment is moving backwards)" }),
      ]),
    ],
    confirmName,
    action: "Move the pin",
    onConfirm: async () => {
      const params = { id: ctx.id };
      const payload = { env: envInput.value.trim(), version, confirmName };
      const res = rollback.checked
        ? await api.specRollback(params, payload)
        : await api.specPin(params, payload);
      if (reportWrite(res, `Queued the pin move for ${payload.env}`)) reload();
    },
  });
}

// ---------------------------------------------------------------------------
// MCP connectors
// ---------------------------------------------------------------------------

function connectorsCard(ctx, body, catalog, reload, live) {
  const servers = Array.isArray(body.servers) ? body.servers : [];
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const confirmName = String(body.confirmName ?? "");
  const inner = [];
  if (findings.length > 0) {
    inner.push(
      el(
        "ul",
        { class: "issue-list" },
        findings.map((finding) =>
          el("li", null, [
            dot(finding.level === "bad" ? "bad" : "warn", String(finding.code ?? "finding")),
            el("code", { text: `${finding.server ?? ""}.${finding.envName ?? ""}` }),
            el("span", { text: ` ${finding.message ?? ""}` }),
          ]),
        ),
      ),
    );
  }
  if (servers.length === 0) {
    inner.push(
      emptyState(
        typeof body.note === "string" && body.note !== ""
          ? body.note
          : "This spec declares no MCP servers",
        typeof body.verb === "string" ? body.verb : "crewhaus mcp doctor",
      ),
    );
  } else {
    inner.push(
      table(
        ["Server", "Transport", "Command / URL", "Env refs", ""],
        servers.map((server) => connectorRow(ctx, server, confirmName, reload, live)),
        "MCP connectors",
      ),
    );
  }
  inner.push(connectorForm(ctx, catalog, confirmName, reload, live));
  return card(
    "MCP connectors",
    findings.some((f) => f.level === "bad")
      ? dot("bad", `${findings.filter((f) => f.level === "bad").length} blocking findings`)
      : dot("ok", `${servers.length} servers`),
    inner,
  );
}

function connectorRow(ctx, server, confirmName, reload, live) {
  const name = String(server.name ?? "");
  const refs = Array.isArray(server.envRefs) ? server.envRefs : [];
  const remove = holdWhenReadOnly(
    el("button", { class: "btn btn-ghost", type: "button", text: "Remove…" }),
    live,
  );
  remove.addEventListener("click", async () => {
    if (isHeld(remove)) return;
    // The plan first — the server answers what WOULD change, then the same
    // call with the confirmation applies it.
    const plan = await api.mcpConnectorRemove({ id: ctx.id, name });
    if (!plan.ok) {
      toast(plan.body?.error ?? `HTTP ${plan.status}`);
      return;
    }
    if (plan.body?.ok === false) {
      toast(`${plan.body.code}: ${plan.body.reason}`, "info");
      return;
    }
    confirmModal({
      title: `Remove ${name}`,
      lead: "An MCP server is third-party code plus its credentials, so removing one is a human-owned spec edit.",
      detail: [pre(String(plan.body?.diff ?? ""))],
      confirmName,
      action: "Remove it",
      onConfirm: async () => {
        const res = await api.mcpConnectorRemove(
          { id: ctx.id, name },
          undefined,
          `?confirmName=${encodeURIComponent(confirmName)}&expectedRev=${encodeURIComponent(
            String(plan.body?.rev ?? live?.rev ?? ""),
          )}`,
        );
        // A typed write is never re-sent as it was: "re-apply" asks again
        // over the plan for the spec as it is now.
        const conflict = {
          id: ctx.id,
          opener: remove,
          reload,
          done: reload,
          reconfirm: () => remove.click(),
        };
        if (reportWrite(res, `Removed ${name}`, conflict)) {
          reload();
        }
      },
    });
  });
  return el("tr", null, [
    el("td", { class: "mono", text: name }),
    el("td", null, [el("span", { class: "chip", text: String(server.transport ?? "stdio") })]),
    el("td", { class: "mono", text: String(server.command ?? server.url ?? "—") }),
    el("td", null, [
      refs.length === 0
        ? el("span", { class: "muted", text: "—" })
        : el(
            "ul",
            { class: "check-list" },
            refs.map((ref) =>
              el("li", null, [
                dot(ref.set === true ? "ok" : "bad", ref.set === true ? "set" : "unset"),
                el("code", { text: String(ref.name ?? "") }),
              ]),
            ),
          ),
    ]),
    el("td", { class: "cell-actions" }, [remove]),
  ]);
}

/** Add a connector: pick a catalog skeleton or type one, preview the diff,
 *  then confirm. Values for secrets are never accepted here — the form takes
 *  a command and its arguments, and the server refuses the rest. */
function connectorForm(ctx, catalog, confirmName, reload, live) {
  const connectors = Array.isArray(catalog?.connectors) ? catalog.connectors : [];
  const name = el("input", { class: "input", type: "text", "aria-label": "server name" });
  const command = el("input", {
    class: "input",
    type: "text",
    placeholder: "bunx",
    "aria-label": "command",
  });
  const args = el("input", {
    class: "input grow",
    type: "text",
    placeholder: "-y some-server",
    "aria-label": "arguments",
  });
  const preset = el("select", { class: "input", "aria-label": "catalog entry" });
  preset.appendChild(el("option", { value: "", text: "custom…" }));
  for (const entry of connectors) {
    preset.appendChild(el("option", { value: String(entry.id), text: String(entry.title) }));
  }
  preset.addEventListener("change", () => {
    const entry = connectors.find((c) => String(c.id) === preset.value);
    if (entry === undefined) return;
    command.value = typeof entry.command === "string" ? entry.command : "";
    args.value = Array.isArray(entry.args) ? entry.args.join(" ") : "";
  });
  const add = holdWhenReadOnly(
    el("button", { class: "btn btn-primary", type: "button", text: "Preview…" }),
    live,
  );
  add.addEventListener("click", async () => {
    if (isHeld(add)) return;
    const payload = {
      name: name.value.trim(),
      command: command.value.trim(),
      args: args.value.trim() === "" ? [] : args.value.trim().split(/\s+/),
    };
    const plan = await api.mcpConnectorWrite({ id: ctx.id }, payload);
    if (!plan.ok) {
      toast(plan.body?.error ?? `HTTP ${plan.status}`);
      return;
    }
    if (plan.body?.ok === false) {
      toast(`${plan.body.code}: ${plan.body.reason}`);
      return;
    }
    confirmModal({
      title: `Add ${payload.name}`,
      lead: "Review the diff. Credentials never belong in a connector's env map — put them in this harness's .env and the server will refuse anything that looks like one.",
      detail: [pre(String(plan.body?.diff ?? ""))],
      confirmName,
      action: "Write it to the spec",
      onConfirm: async () => {
        const res = await api.mcpConnectorWrite(
          { id: ctx.id },
          {
            ...payload,
            dryRun: false,
            confirmName,
            expectedRev: String(plan.body?.rev ?? live?.rev ?? ""),
          },
        );
        const conflict = {
          id: ctx.id,
          opener: add,
          reload,
          done: reload,
          reconfirm: () => add.click(),
        };
        if (reportWrite(res, `Added ${payload.name}`, conflict)) {
          reload();
        }
      },
    });
  });
  return el("div", { class: "add-form" }, [
    el("label", { class: "field" }, [el("span", { text: "From catalog" }), preset]),
    el("label", { class: "field" }, [el("span", { text: "Name" }), name]),
    el("label", { class: "field" }, [el("span", { text: "Command" }), command]),
    el("label", { class: "field grow" }, [el("span", { text: "Arguments" }), args]),
    add,
  ]);
}

// ---------------------------------------------------------------------------
// graders + dataset builder
// ---------------------------------------------------------------------------

function gradersCard(ctx, body, confirmName, reload) {
  const graders = Array.isArray(body.graders) ? body.graders : [];
  const inner = [];
  inner.push(
    el("p", { class: "muted" }, [
      el("span", { text: "File: " }),
      el("code", { text: String(body.path ?? "eval/graders.yaml") }),
      body.hash ? el("span", { class: "chip", text: String(body.hash).slice(0, 14) }) : null,
    ]),
  );
  if (graders.length === 0) {
    inner.push(
      emptyState(
        typeof body.note === "string" && body.note !== "" ? body.note : "No graders configured yet",
        typeof body.verb === "string" ? body.verb : "crewhaus graders suggest",
      ),
    );
  } else {
    inner.push(
      table(
        ["Grader", "Kind"],
        graders.map((grader) =>
          el("tr", null, [
            el("td", { class: "mono", text: String(grader.name ?? "—") }),
            el("td", null, [el("span", { class: "chip", text: String(grader.type ?? "—") })]),
          ]),
        ),
        "Graders",
      ),
    );
  }
  const editor = el("textarea", {
    class: "input notes",
    rows: 8,
    "aria-label": "graders.yaml",
    text: typeof body.yaml === "string" ? body.yaml : "",
  });
  const save = el("button", { class: "btn", type: "button", text: "Save graders.yaml…" });
  save.addEventListener("click", () => {
    confirmModal({
      title: "Replace eval/graders.yaml",
      lead: "Runs scored after this write carry a new graders hash; runs already recorded keep the graders they were scored by.",
      detail: [el("p", { class: "muted", text: `${editor.value.length} characters` })],
      confirmName,
      action: "Write the file",
      onConfirm: async () => {
        // The revision this pane was loaded from: a file changed since is refused.
        const res = await api.graderWrite(
          { id: ctx.id },
          {
            yaml: editor.value,
            confirmName,
            ...(typeof body.hash === "string" ? { expectedRev: body.hash } : {}),
          },
        );
        if (reportWrite(res, "Wrote eval/graders.yaml")) reload();
      },
    });
  });
  inner.push(
    collapsible([el("span", { class: "muted", text: "edit graders.yaml" })], [editor, save]),
    el("p", {
      class: "muted",
      text: "Saving checks the file still matches what you loaded and that it is a valid graders file.",
    }),
    el("p", { class: "muted" }, [
      el("span", { text: "Render the rubric card with " }),
      el("code", { text: String(body.cardVerb ?? "crewhaus graders card") }),
      el("span", { text: "." }),
    ]),
  );
  return card(
    "Graders",
    body.present === true ? dot("ok", `${graders.length} graders`) : dot("off", "no graders.yaml"),
    inner,
  );
}

function datasetCard(body) {
  return card("Dataset builder", dot("off", "not in this build"), [
    emptyState(
      typeof body.note === "string" && body.note !== ""
        ? body.note
        : "The dataset builder is not part of this build",
      typeof body.verb === "string" ? body.verb : "crewhaus dataset mine",
    ),
    el("p", {
      class: "muted",
      text: "Datasets themselves live on the Data tab — this panel only ever drove the builder's state machine.",
    }),
  ]);
}

// ---------------------------------------------------------------------------
// the new-harness wizard
// ---------------------------------------------------------------------------

function wizardCard(body) {
  const templates = Array.isArray(body.templates) ? body.templates : [];
  if (templates.length === 0) {
    return card("New harness", dot("off", "no templates"), [
      emptyState("No templates in this build", "crewhaus init"),
    ]);
  }
  return card("New harness", dot("ok", `${templates.length} templates`), [
    noteLine(body),
    table(
      ["Template", "Shape", "What it scaffolds", ""],
      templates.map((template) => wizardRow(template)),
      "Templates",
    ),
  ]);
}

function wizardRow(template) {
  const create = el("button", { class: "btn", type: "button", text: "Create…" });
  create.addEventListener("click", () => wizardDialog(template));
  return el("tr", null, [
    el("td", null, [
      el("div", { text: String(template.title ?? template.id) }),
      el("div", { class: "muted", text: String(template.summary ?? "") }),
    ]),
    el("td", null, [el("span", { class: "shape-badge", text: String(template.target ?? "") })]),
    el("td", { class: "mono muted", text: (template.scaffolds ?? []).join(", ") }),
    el("td", { class: "cell-actions" }, [create]),
  ]);
}

/**
 * The wizard is dry-run-first: the plan renders the exact spec that would be
 * written and touches nothing, and only the typed confirmation creates the
 * directory. Registration is a second, explicit step — the manager does not
 * adopt a directory the operator has not asked it to.
 */
function wizardDialog(template) {
  const dir = el("input", {
    class: "input grow",
    type: "text",
    placeholder: "/absolute/path/to/new-harness",
    "aria-label": "new harness directory",
  });
  const nameInput = el("input", { class: "input", type: "text", "aria-label": "spec name" });
  const plan = el("button", { class: "btn btn-primary", type: "button", text: "Preview" });
  const out = el("div", { class: "modal-body" });
  plan.addEventListener("click", async () => {
    const answers = nameInput.value.trim() === "" ? {} : { name: nameInput.value.trim() };
    const res = await api.wizardCreate(
      {},
      { dir: dir.value.trim(), template: template.id, answers },
    );
    clear(out);
    if (!res.ok) {
      out.appendChild(el("p", { class: "reason", text: res.body?.error ?? `HTTP ${res.status}` }));
      return;
    }
    const body = res.body ?? {};
    if (body.ok === false) {
      out.appendChild(el("p", { class: "reason", text: `${body.code}: ${body.reason}` }));
      return;
    }
    out.appendChild(el("p", { class: "muted", text: String(body.note ?? "") }));
    out.appendChild(pre(String(body.yaml ?? "")));
    const confirmName = String(body.confirmName ?? "");
    const write = el("button", { class: "btn btn-danger", type: "button", text: "Create it" });
    const typed = el("input", {
      class: "input",
      type: "text",
      placeholder: confirmName,
      "aria-label": `type ${confirmName} to confirm`,
    });
    write.disabled = true;
    typed.addEventListener("input", () => {
      write.disabled = typed.value.trim() !== confirmName;
    });
    write.addEventListener("click", async () => {
      const made = await api.wizardCreate(
        {},
        {
          dir: dir.value.trim(),
          template: template.id,
          answers: nameInput.value.trim() === "" ? {} : { name: nameInput.value.trim() },
          dryRun: false,
          confirmName,
        },
      );
      if (!reportWrite(made, "Created the harness")) return;
      // Registering is the console's own route — the wizard's answer names it
      // rather than pretending the manager did it.
      try {
        await api.addHarness(String(made.body?.dir ?? dir.value.trim()));
        toast("Registered — it is in the Library now", "info");
      } catch (err) {
        toast(`Created, but not registered: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    out.appendChild(
      el("label", { class: "field" }, [
        el("span", { text: `Type ${confirmName} to create it` }),
        typed,
      ]),
    );
    out.appendChild(el("div", { class: "modal-actions" }, [write]));
  });
  viewModal(
    `New ${template.title ?? template.id}`,
    [
      el("label", { class: "field grow" }, [el("span", { text: "Directory (absolute)" }), dir]),
      el("label", { class: "field" }, [el("span", { text: "Spec name" }), nameInput]),
      el("div", { class: "modal-actions" }, [plan]),
      out,
    ],
    true,
  );
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function renderSpecEdit(root, ctx, opts = {}) {
  clear(root).appendChild(skeleton(6));
  // `focusKey` names the control that wrote, so focus stays on it after the re-read.
  const reload = (next) =>
    renderSpecEdit(root, ctx, next !== null && typeof next === "object" ? next : {});
  const [schema, trust, versions, connectors, catalog, graders, dataset, templates] =
    await Promise.all([
      call("specs.schema", { params: { h: ctx.id } }),
      api.specTrust({ id: ctx.id }),
      api.specVersions({ id: ctx.id }),
      api.mcpConnectors({ id: ctx.id }),
      api.mcpCatalog({}),
      api.graderCatalog({ id: ctx.id }),
      api.datasetBuilder({ id: ctx.id }),
      api.wizardTemplates({}),
    ]);
  clear(root);

  const confirmName = String(
    trust.body?.confirmName ?? connectors.body?.confirmName ?? versions.body?.confirmName ?? "",
  );
  // The revision this screen loaded (every write sends it back), and whether
  // this spec takes writes here at all.
  const live = {
    rev: String(schema.body?.rev ?? trust.body?.rev ?? ""),
    readOnly: readOnlyModel(schema.body?.readOnly ?? trust.body?.readOnly),
  };
  if (live.readOnly.held) root.appendChild(readOnlyCard(live.readOnly));

  root.appendChild(
    isStub(schema)
      ? stubCard("Effective configuration", schema)
      : schema.ok
        ? effectiveCard(schema.body ?? {})
        : errorCard("Effective configuration", schema),
  );
  root.appendChild(
    isStub(schema)
      ? stubCard("Settings", schema)
      : schema.ok
        ? settingsCard(ctx, schema.body ?? {}, trust.ok ? trust.body : null, live, reload)
        : errorCard("Settings", schema),
  );
  root.appendChild(
    isStub(versions)
      ? stubCard("Version history", versions)
      : versions.ok
        ? versionsCard(ctx, versions.body ?? {}, reload)
        : errorCard("Version history", versions),
  );
  root.appendChild(
    isStub(connectors)
      ? stubCard("MCP connectors", connectors)
      : connectors.ok
        ? connectorsCard(ctx, connectors.body ?? {}, catalog.ok ? catalog.body : null, reload, live)
        : errorCard("MCP connectors", connectors),
  );
  root.appendChild(
    isStub(graders)
      ? stubCard("Graders", graders)
      : graders.ok
        ? gradersCard(ctx, graders.body ?? {}, confirmName, reload)
        : errorCard("Graders", graders),
  );
  root.appendChild(
    isStub(dataset) ? stubCard("Dataset builder", dataset) : datasetCard(dataset.body ?? {}),
  );
  root.appendChild(
    isStub(templates)
      ? stubCard("New harness", templates)
      : templates.ok
        ? wizardCard(templates.body ?? {})
        : errorCard("New harness", templates),
  );
  if (typeof opts.focusKey === "string") {
    const target = [...root.querySelectorAll("[data-focus-key]")].find(
      (node) => node instanceof HTMLElement && node.dataset.focusKey === opts.focusKey,
    );
    if (target instanceof HTMLElement) target.focus();
  }
}

/** A route that failed for a reason that is not "not built yet". A versioned-API answer carries its words in `error`. */
function errorCard(title, res) {
  const raw = res.body ?? res.error;
  return card(title, dot("bad", `HTTP ${res.status ?? "?"}`), [
    el("p", {
      class: "muted",
      text:
        typeof res.error?.message === "string"
          ? res.error.message
          : (res.body?.error ?? "the manager could not answer"),
    }),
    raw ? collapsible([el("span", { class: "muted", text: "raw" })], [jsonPre(raw)]) : null,
  ]);
}
