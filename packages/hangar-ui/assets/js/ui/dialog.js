/**
 * The one dialog primitive. Every overlay in the console — the start
 * refusal, the spec editor's dialogs, the keyboard sheet, the command menu —
 * is a native `<dialog>` opened with `showModal()`, because the platform
 * already gets the hard parts right: focus moves in, the page behind is
 * inert, Escape closes it, and Tab cannot leave it.
 *
 * What is still this module's job:
 *
 *   - the title names the dialog (`aria-labelledby`), and focus starts on the
 *     first field or, when there is none, on the title, so the first thing
 *     read is what the dialog is for;
 *   - focus goes back to whatever opened the dialog when it closes;
 *   - a dialog that holds typed input never closes on a stray click on the
 *     backdrop, so a half-typed confirmation is never lost;
 *   - the live regions move into the dialog while it is open (`live.js`), or
 *     an inert page would swallow every announcement.
 *
 * The decisions are pure exports ({@link confirmReady}); the DOM is built
 * only with `el`, and nothing runs at import.
 */

import { el } from "../dom.js";
import { enterDialog, leaveDialog } from "./live.js";

let dialogCount = 0;

/** The fields focus may start on, in document order. */
const FIELD_SELECTOR =
  "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])";

/**
 * Open a modal dialog.
 *
 *   title             — the dialog's name (a string)
 *   titleExtra        — a node shown beside the title (a status badge)
 *   titleHidden       — keep the title for assistive tech only
 *   body              — node | string | array
 *   actions           — the button row (nodes)
 *   dismissOnBackdrop — close on a click outside the box (default false)
 *   initialFocus      — a node, `"heading"`, or unset for first field / title
 *   className         — the dialog's class (default `"modal card"`)
 *   dataset           — data-* attributes for the dialog element
 *   returnFocus       — where focus goes on close (default: what had focus
 *                       when it opened)
 *   onClose           — called once, after the dialog has gone
 *
 * Returns `{ node, close }`. `close()` is safe to call more than once.
 */
export function openDialog(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  dialogCount += 1;
  const titleId = `dialog-title-${dialogCount}`;
  const opener = o.returnFocus instanceof HTMLElement ? o.returnFocus : document.activeElement;
  const title = el("h2", {
    class: o.titleHidden === true ? "sr-only" : "modal-title",
    id: titleId,
    tabindex: "-1",
    text: String(o.title ?? ""),
  });
  const head =
    o.titleExtra !== undefined && o.titleExtra !== null
      ? el("div", { class: "modal-head" }, [title, o.titleExtra])
      : title;
  const body =
    o.body === undefined || o.body === null ? null : el("div", { class: "modal-body" }, o.body);
  const actions =
    Array.isArray(o.actions) && o.actions.length > 0
      ? el("div", { class: "modal-actions" }, o.actions)
      : null;
  const node = el(
    "dialog",
    {
      class: typeof o.className === "string" ? o.className : "modal card",
      "aria-labelledby": titleId,
      dataset: o.dataset && typeof o.dataset === "object" ? o.dataset : null,
    },
    [head, body, actions],
  );

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    // Focus goes back only if nothing else has taken it since: the native
    // `close` event comes a task later, and by then the reader may have moved.
    const active = document.activeElement;
    const unclaimed = active === null || active === document.body || node.contains(active);
    leaveDialog(node);
    node.remove();
    if (
      unclaimed &&
      opener instanceof HTMLElement &&
      opener.isConnected &&
      opener !== document.body
    ) {
      opener.focus({ preventScroll: true });
    }
    if (typeof o.onClose === "function") o.onClose();
  };
  // The native `close` event arrives on a later task; finishing at once means
  // focus is back on the opener before the next line of the caller runs.
  const close = () => {
    if (node.open) node.close();
    finish();
  };
  node.addEventListener("close", finish);
  node.addEventListener("click", (event) => {
    if (o.dismissOnBackdrop !== true || event.target !== node) return;
    // A click on the dialog's own padding also targets the dialog; only one
    // outside its box is a click on the backdrop.
    const box = node.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) close();
  });

  document.body.appendChild(node);
  node.showModal();
  enterDialog(node);
  const start =
    o.initialFocus === "heading"
      ? title
      : o.initialFocus instanceof HTMLElement
        ? o.initialFocus
        : (node.querySelector(FIELD_SELECTOR) ?? title);
  start.focus();
  return { node, close };
}

/**
 * Whether a confirmation may go ahead. Pure.
 *
 *   level         — `"typed"` (the name must be typed) or `"confirm"`
 *   confirmName   — what a typed confirmation must match
 *   typed         — what has been typed
 *   reasonRequired, reason — a confirmation that records a reason
 *
 * Returns `{ ready, why }`, where `why` is the sentence to show when not ready.
 */
export function confirmReady({ level, confirmName, typed, reasonRequired, reason }) {
  if (level === "typed") {
    const want = String(confirmName ?? "");
    if (want === "" || String(typed ?? "").trim() !== want) {
      return { ready: false, why: `Type ${want} to confirm.` };
    }
  }
  if (reasonRequired === true && String(reason ?? "").trim() === "") {
    return { ready: false, why: "A reason is required. It is recorded with this change." };
  }
  return { ready: true, why: null };
}

/**
 * The two rungs of the confirmation ladder that open a dialog.
 *
 *   level: "typed"   — type the spec's name to enable the action; the server
 *                       checks the same name, so this is the explanation,
 *                       never the gate.
 *   level: "confirm" — one explicit confirm, optionally with a required
 *                       reason that is recorded with the change.
 *
 *   title, titleExtra, lead, detail, confirmName, action (button label),
 *   reason: { label, placeholder } — ask for a reason, required,
 *   onConfirm(reasonText)
 *
 * A dialog that asks for typing never closes on a backdrop click.
 */
export function confirmAction(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const level = o.level === "typed" ? "typed" : "confirm";
  const confirmName = String(o.confirmName ?? "");
  const fields = [];
  let typedInput = null;
  let reasonInput = null;
  if (level === "typed") {
    typedInput = el("input", {
      class: "input",
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: confirmName,
    });
    fields.push(
      el("label", { class: "field" }, [
        el("span", { text: `Type ${confirmName} to confirm` }),
        typedInput,
      ]),
    );
  }
  if (o.reason && typeof o.reason === "object") {
    reasonInput = el("input", {
      class: "input",
      type: "text",
      placeholder: String(o.reason.placeholder ?? ""),
      "aria-required": "true",
    });
    fields.push(
      el("label", { class: "field" }, [
        el("span", { text: String(o.reason.label ?? "Reason") }),
        reasonInput,
      ]),
    );
  }
  const why = el("p", { class: "muted gated-why", role: "status" });
  const go = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: String(o.action ?? "Confirm"),
  });
  const cancel = el("button", { class: "btn btn-ghost", type: "button", text: "Cancel" });
  const state = () =>
    confirmReady({
      level,
      confirmName,
      typed: typedInput?.value,
      reasonRequired: reasonInput !== null,
      reason: reasonInput?.value,
    });
  // The typed rung holds the button until the name matches; the reason rung
  // keeps it pressable and says what is missing, so the cause is never only
  // a greyed-out button.
  const sync = () => {
    if (level === "typed") go.disabled = !state().ready;
  };
  typedInput?.addEventListener("input", sync);
  reasonInput?.addEventListener("input", () => {
    why.textContent = "";
    reasonInput.removeAttribute("aria-invalid");
  });
  sync();

  const dialog = openDialog({
    title: o.title,
    titleExtra: o.titleExtra,
    body: [
      o.lead ? el("p", { class: "muted", text: String(o.lead) }) : null,
      o.detail ? el("div", { class: "modal-detail" }, o.detail) : null,
      ...fields,
      why,
    ],
    actions: [go, cancel],
    dismissOnBackdrop: fields.length === 0,
    onClose: o.onClose,
  });
  go.addEventListener("click", () => {
    const verdict = state();
    if (!verdict.ready) {
      why.textContent = verdict.why ?? "";
      if (reasonInput !== null && String(reasonInput.value).trim() === "") {
        reasonInput.setAttribute("aria-invalid", "true");
        reasonInput.focus();
      }
      return;
    }
    const reasonText = reasonInput === null ? undefined : reasonInput.value.trim();
    dialog.close();
    if (typeof o.onConfirm === "function") o.onConfirm(reasonText);
  });
  cancel.addEventListener("click", () => dialog.close());
  return dialog;
}
