/**
 * Spec — the M3 half of the Spec tab: the field editor, trust-tier badges,
 * version history with pins and diffs, and the four builders (new-spec
 * wizard, grader builder, dataset builder, MCP connectors).
 *
 * The field editor is honest about its two halves. A SCALAR leaf edits
 * inline. Everything else — a block, a list, a field inside a list item, or
 * a block this spec does not declare at all — edits through the JSON pane,
 * which sends ONE edit (`path` + `value`) down the same `specDiff` →
 * `specEdit` road every other write here takes, so the server's trust tiers
 * and typed confirmation still decide what may land. There is no YAML
 * editor in this console and this screen never says there is: the console is
 * zero-build and dependency-free, so it has no YAML parser to be honest
 * with.
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

/** The tier badge — colour is never alone, the tier word rides with it. */
function tierBadge(row) {
  if (row.tier === "auto-tunable") return dot("ok", "auto-tunable");
  return dot(row.securitySurface === true ? "bad" : "warn", "human-owned");
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
function reportWrite(res, okMessage, conflict = null) {
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

/** The conflict view, in a dialog. Nothing is written until a choice is made.
 *  Focus goes back to the control that made the write (`conflict.opener`). */
function openConflict(current, okMessage, conflict) {
  const c = conflict && typeof conflict === "object" ? conflict : {};
  let dialog = null;
  const view = conflictView({
    current: { ...current, draft: typeof c.draft === "string" ? c.draft : current.draft },
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
        typeof res?.body?.error === "string"
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
// the field editor (trust tiers)
// ---------------------------------------------------------------------------

/**
 * One row per declared path, badged by tier, with the edit control the tier
 * allows:
 *
 *   auto-tunable → an inline input that saves through `specPatch` (the same
 *     restriction the optimizer runs under, enforced server-side);
 *   human-owned  → "Review & apply", which fetches the redacted diff FIRST
 *     and only then offers the typed confirmation, plus "Propose" for the
 *     review-PR path;
 *   a block or a list → the JSON pane, which takes the same diff → tier →
 *     confirm road with the whole value as one edit.
 */
function trustCard(ctx, trust, valueByPath, reload) {
  const rows = Array.isArray(trust.paths) ? trust.paths : [];
  // Rows are what the spec DECLARES; the pane is how anything else is
  // reached, so it belongs on the empty screen too — a spec with no rows is
  // exactly the one an operator needs to add a block to.
  const addBlock = el("button", { class: "btn", type: "button", text: "Edit any path…" });
  addBlock.addEventListener("click", () => {
    valueDialog(ctx, { path: "", value: undefined, pathEditable: true, reload });
  });
  const addForm = (lead) =>
    el("div", { class: "add-form" }, [el("p", { class: "muted grow", text: lead }), addBlock]);
  if (rows.length === 0) {
    return card("Fields & trust tiers", dot("off", "no fields"), [
      emptyState(
        typeof trust.note === "string" ? trust.note : "This spec declares no editable fields",
        typeof trust.verb === "string" ? trust.verb : "crewhaus init",
      ),
      addForm(
        "A path this spec has not declared is still reachable — the server applies it with the same diff, tier and typed confirmation.",
      ),
    ]);
  }
  const confirmName = String(trust.confirmName ?? "");
  const body = rows.map((row) => {
    const path = String(row.path ?? "");
    const current = valueByPath.get(path);
    const editable = current !== undefined && !isContainer(current);
    return el("tr", null, [
      el("td", { class: "mono", text: path }),
      el("td", null, [tierBadge(row)]),
      el("td", { class: "muted", text: String(row.reason ?? "") }),
      el("td", { class: "cell-actions" }, [
        editable
          ? row.tier === "auto-tunable"
            ? autoTunableEditor(ctx, path, current, reload)
            : humanOwnedActions(ctx, path, current, confirmName, reload)
          : jsonPaneButton(ctx, path, current, reload),
      ]),
    ]);
  });
  return card(
    "Fields & trust tiers",
    dot(
      "ok",
      `${trust.autoTunableCount ?? 0} auto-tunable · ${trust.humanOwnedCount ?? 0} human-owned`,
    ),
    [
      el("p", {
        class: "muted",
        text: "Auto-tunable fields are the ones the optimizer may write, so the console may write them too. Everything else needs a review of the diff and a typed confirmation — the server enforces the same split.",
      }),
      table(["Path", "Tier", "Why", ""], body, "Fields and trust tiers"),
      addForm(
        "Rows list what this spec DECLARES. A block it has never declared, or a field inside a list item, is reachable by path — same diff, same tier, same typed confirmation.",
      ),
    ],
  );
}

const isContainer = (value) => typeof value === "object" && value !== null;

/** Inline input + Save for a path the optimizer is allowed to write. */
function autoTunableEditor(ctx, path, current, reload) {
  const input = el("input", {
    class: "input",
    type: "text",
    value: typeof current === "string" ? current : JSON.stringify(current),
    "aria-label": `value for ${path}`,
  });
  const save = el("button", { class: "btn btn-primary", type: "button", text: "Save" });
  save.addEventListener("click", async () => {
    // Held with aria-disabled, not `disabled`: a disabled button drops focus
    // to the page, and the answer may open a dialog that must return it here.
    if (save.getAttribute("aria-disabled") === "true") return;
    save.setAttribute("aria-disabled", "true");
    const edit = { path, value: coerce(input.value, current) };
    const res = await api.specPatch({ id: ctx.id }, { edit });
    save.removeAttribute("aria-disabled");
    const conflict = {
      opener: save,
      draft: JSON.stringify(edit, null, 2),
      retry: (rev) => api.specPatch({ id: ctx.id }, { edit, expectedRev: rev }),
      reload,
      done: reload,
    };
    if (reportWrite(res, `Saved ${path}`, conflict)) reload();
  });
  return el("div", { class: "row-editor" }, [input, save]);
}

/** Keep a number a number and a boolean a boolean — a form field is text,
 *  and the spec schema is not. */
function coerce(text, current) {
  if (typeof current === "number") {
    const n = Number(text);
    return Number.isNaN(n) ? text : n;
  }
  if (typeof current === "boolean") return text === "true";
  return text;
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
 *  sentence to render, because "nothing happened" is not an answer. */
export function editsFor(path, text) {
  const segments = editPath(path);
  if (segments.length === 0) return { ok: false, message: "a path is required" };
  const parsed = parseJsonValue(text);
  if (!parsed.ok) return { ok: false, message: `that is not valid JSON: ${parsed.message}` };
  // No `value` key at all ⇒ the server deletes the path. `value: undefined`
  // would not survive JSON.stringify, so the key is omitted deliberately.
  return {
    ok: true,
    edits: [parsed.remove ? { path: segments } : { path: segments, value: parsed.value }],
    removing: parsed.remove === true,
  };
}

/** The row control for a path the inline editor cannot type: a container, or
 *  a declared path with no effective value to seed an input from. */
function jsonPaneButton(ctx, path, current, reload) {
  const open = el("button", { class: "btn btn-ghost", type: "button", text: "Edit as JSON…" });
  open.addEventListener("click", () => {
    valueDialog(ctx, { path, value: current, pathEditable: false, reload });
  });
  return open;
}

/**
 * The pane. It writes NOTHING on its own: Preview asks `specDiff` what would
 * change and which tier the batch lands in, and only the answer decides what
 * the operator is offered — a plain Apply for an auto-tunable path (the
 * optimizer's own surface), or the typed confirmation for a human-owned one.
 * Both roads end at the same `specEdit` PUT, so the server remains the gate
 * and this screen stays the explanation.
 */
function valueDialog(ctx, { path, value, pathEditable, reload }) {
  let dialog = null;
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
    const target = pathInput.value.trim();
    const batch = editsFor(target, editor.value);
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
      return;
    }
    if (batch.removing) {
      out.appendChild(
        el("p", { class: "muted", text: `an empty pane DELETES ${target} from the spec` }),
      );
    }
    out.appendChild(pre(String(body.diff ?? "")));
    const apply = async (extra) => {
      const wrote = await api.specEdit({ id: ctx.id }, { edits: batch.edits, ...extra });
      const typed = typeof extra.confirmName === "string";
      const conflict = {
        draft: JSON.stringify(batch.edits, null, 2),
        reload,
        done: reload,
      };
      if (typed) {
        conflict.reconfirm = (rev) =>
          reconfirmEdit(ctx, {
            edits: batch.edits,
            rev,
            label: target,
            okMessage: `Applied ${target}`,
            conflict,
          });
      } else {
        conflict.retry = (rev) =>
          api.specEdit({ id: ctx.id }, { edits: batch.edits, expectedRev: rev });
      }
      if (reportWrite(wrote, `Applied ${target}`, conflict)) {
        if (dialog !== null) dialog.close();
        reload();
      } else if (wrote?.status === 412 && dialog !== null) dialog.close();
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

/** "Review & apply" (diff → typed confirm) and "Propose" for a human-owned
 *  path. Neither writes anything before the operator has seen the diff. */
function humanOwnedActions(ctx, path, current, confirmName, reload) {
  const input = el("input", {
    class: "input",
    type: "text",
    value: typeof current === "string" ? current : JSON.stringify(current),
    "aria-label": `new value for ${path}`,
  });
  const review = el("button", { class: "btn", type: "button", text: "Review & apply" });
  const propose = el("button", { class: "btn btn-ghost", type: "button", text: "Propose" });
  const editFor = () => ({ path, value: coerce(input.value, current) });

  review.addEventListener("click", async () => {
    const edits = [editFor()];
    const preview = await api.specDiff({ id: ctx.id }, { edits });
    if (!preview.ok) {
      toast(preview.body?.error ?? `HTTP ${preview.status}`);
      return;
    }
    const body = preview.body ?? {};
    if (body.ok === false) {
      toast(`${body.code ?? "refused"}: ${body.reason ?? "this edit does not apply"}`);
      return;
    }
    confirmModal({
      title: `Change ${path}`,
      lead: "This is a human-owned field. Read the diff — values are credential-redacted server-side — then type the spec name to apply it here, or close this and open a review instead.",
      detail: [pre(String(body.diff ?? ""))],
      confirmName,
      action: "Apply to the live spec",
      onConfirm: async () => {
        const res = await api.specEdit({ id: ctx.id }, { edits, confirmName });
        const conflict = {
          draft: JSON.stringify(edits, null, 2),
          reload,
          done: reload,
        };
        conflict.reconfirm = (rev) =>
          reconfirmEdit(ctx, { edits, rev, label: path, okMessage: `Applied ${path}`, conflict });
        if (reportWrite(res, `Applied ${path}`, conflict)) reload();
      },
    });
  });

  propose.addEventListener("click", async () => {
    const res = await api.specPropose(
      { id: ctx.id },
      { edits: [editFor()], title: `hangar: ${path}` },
    );
    if (
      reportWrite(res, "Proposal staged — the review bundle is a dry run until you open the PR")
    ) {
      reload();
    }
  });
  return el("div", { class: "row-editor" }, [input, review, propose]);
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

function connectorsCard(ctx, body, catalog, reload) {
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
        servers.map((server) => connectorRow(ctx, server, confirmName, reload)),
        "MCP connectors",
      ),
    );
  }
  inner.push(connectorForm(ctx, catalog, confirmName, reload));
  return card(
    "MCP connectors",
    findings.some((f) => f.level === "bad")
      ? dot("bad", `${findings.filter((f) => f.level === "bad").length} blocking findings`)
      : dot("ok", `${servers.length} servers`),
    inner,
  );
}

function connectorRow(ctx, server, confirmName, reload) {
  const name = String(server.name ?? "");
  const refs = Array.isArray(server.envRefs) ? server.envRefs : [];
  const remove = el("button", { class: "btn btn-ghost", type: "button", text: "Remove…" });
  remove.addEventListener("click", async () => {
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
          `?confirmName=${encodeURIComponent(confirmName)}`,
        );
        if (reportWrite(res, `Removed ${name}`)) reload();
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
function connectorForm(ctx, catalog, confirmName, reload) {
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
  const add = el("button", { class: "btn btn-primary", type: "button", text: "Preview…" });
  add.addEventListener("click", async () => {
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
          { ...payload, dryRun: false, confirmName },
        );
        if (reportWrite(res, `Added ${payload.name}`)) reload();
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
        const res = await api.graderWrite({ id: ctx.id }, { yaml: editor.value, confirmName });
        if (reportWrite(res, "Wrote eval/graders.yaml")) reload();
      },
    });
  });
  inner.push(
    collapsible([el("span", { class: "muted", text: "edit graders.yaml" })], [editor, save]),
    el("p", {
      class: "muted",
      text: "The structured grader builder ships as a published package this manager does not bundle; the YAML pane above is the write path it has.",
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

export async function renderSpecEdit(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const reload = () => renderSpecEdit(root, ctx);
  const [schema, trust, versions, connectors, catalog, graders, dataset, templates] =
    await Promise.all([
      api.specSchema({ id: ctx.id }),
      api.specTrust({ id: ctx.id }),
      api.specVersions({ id: ctx.id }),
      api.mcpConnectors({ id: ctx.id }),
      api.mcpCatalog({}),
      api.graderCatalog({ id: ctx.id }),
      api.datasetBuilder({ id: ctx.id }),
      api.wizardTemplates({}),
    ]);
  clear(root);

  // path → effective value, so the field editor can seed its inputs from
  // what the harness is actually running rather than from the raw text.
  const valueByPath = new Map();
  if (schema.ok && Array.isArray(schema.body?.effective)) {
    for (const row of schema.body.effective) valueByPath.set(String(row.path), row.value);
  }
  const confirmName = String(
    trust.body?.confirmName ?? connectors.body?.confirmName ?? versions.body?.confirmName ?? "",
  );

  root.appendChild(
    isStub(schema)
      ? stubCard("Effective configuration", schema)
      : schema.ok
        ? effectiveCard(schema.body ?? {})
        : errorCard("Effective configuration", schema),
  );
  root.appendChild(
    isStub(trust)
      ? stubCard("Fields & trust tiers", trust)
      : trust.ok
        ? trustCard(ctx, trust.body ?? {}, valueByPath, reload)
        : errorCard("Fields & trust tiers", trust),
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
        ? connectorsCard(ctx, connectors.body ?? {}, catalog.ok ? catalog.body : null, reload)
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
}

/** A route that failed for a reason that is not "not built yet". */
function errorCard(title, res) {
  return card(title, dot("bad", `HTTP ${res.status ?? "?"}`), [
    el("p", { class: "muted", text: res.body?.error ?? "the manager could not answer" }),
    res.body
      ? collapsible([el("span", { class: "muted", text: "raw" })], [jsonPre(res.body)])
      : null,
  ]);
}
