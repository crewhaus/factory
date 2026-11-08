/**
 * When a spec changed on disk while someone was editing it, the write is
 * refused with 412 and the server's current state (`body.current`: its
 * revision and the diff from what the editor started from). This view says
 * so in words, shows the diff as text with its `+`/`-` kept, and offers the
 * three ways forward: re-apply the edit on top of the new version, take the
 * version on disk, or download the draft so nothing typed is lost.
 *
 * {@link conflictModel} is pure. Nothing here writes: the caller decides
 * what "re-apply" sends.
 */

import { el } from "../dom.js";

export const CONFLICT_MESSAGE = "This spec changed on disk while you were editing.";

/** The three actions, in order. */
export const CONFLICT_ACTIONS = Object.freeze([
  { id: "reapply", label: "Re-apply my changes on top" },
  { id: "use-disk", label: "Use the version on disk" },
  { id: "download", label: "Download my draft" },
]);

/**
 * `(current, draft)` → `{ message, rev, diff, draft, actions }`. `current` is
 * the 412's `body.current`; `draft` is the edit that was refused (falling
 * back to `current.draft`). The diff stays a string, whatever is in it.
 */
export function conflictModel(current, draft) {
  const c = current && typeof current === "object" ? current : {};
  const rev = typeof c.rev === "string" || typeof c.rev === "number" ? String(c.rev) : null;
  const draftText = typeof draft === "string" ? draft : typeof c.draft === "string" ? c.draft : "";
  return {
    message: CONFLICT_MESSAGE,
    rev,
    diff: typeof c.diff === "string" ? c.diff : "",
    draft: draftText,
    actions: CONFLICT_ACTIONS.map((a) => ({ ...a })),
  };
}

/** Hand `text` to the browser as a file, then revoke the URL. */
function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = el("a", { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * `{ current: { rev, diff, draft }, onReapply(rev), onUseDisk() }` → the view.
 */
export function conflictView(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const model = conflictModel(o.current, o.current?.draft);
  const buttons = model.actions.map((action) => {
    const btn = el("button", {
      class: action.id === "reapply" ? "btn btn-primary" : "btn",
      type: "button",
      text: action.label,
    });
    btn.addEventListener("click", () => {
      if (action.id === "reapply" && typeof o.onReapply === "function") o.onReapply(model.rev);
      else if (action.id === "use-disk" && typeof o.onUseDisk === "function") o.onUseDisk();
      else if (action.id === "download") download(model.draft, "spec-draft.txt");
    });
    return btn;
  });
  return el("div", { class: "conflict" }, [
    el("p", { text: model.message }),
    model.rev === null
      ? null
      : el("p", { class: "muted mono", text: `on disk: revision ${model.rev}` }),
    el("pre", {
      class: "rawjson conflict-diff",
      tabindex: "0",
      text: model.diff === "" ? "(the server sent no diff)" : model.diff,
    }),
    el("div", { class: "modal-actions" }, buttons),
  ]);
}
