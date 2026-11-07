/**
 * Empty states that say WHY. A list with nothing in it is a fact about the
 * world, and there are six different facts behind "nothing to show"; each
 * has its own words and its own way forward:
 *
 *   no-data            nothing exists yet          → the verb or button that creates it
 *   no-access          you may not see it          → who can grant it
 *   connection-failed  a service did not answer    → Retry
 *   unsupported        this harness cannot have it → the CLI verb, if one exists
 *   filtered           your filters hide it        → Clear filters
 *   not-indexed        search is still being built → nothing to do
 *
 * `emptyState` in `dom.js` stays for the screens that have not moved here.
 * The decisions are {@link emptyModel}, pure; {@link emptyFor} draws one.
 */

import { el } from "../dom.js";

/** The six causes, with their copy and their default action. */
export const EMPTY_CAUSES = Object.freeze({
  "no-data": { message: "Nothing here yet.", action: null },
  "no-access": {
    message: "You don't have access to this.",
    action: "Needs Maintainer — ask an owner",
  },
  "connection-failed": { message: "Can't reach {subject} right now.", action: "Retry" },
  unsupported: { message: "Not available for this harness: {subject}.", action: null },
  filtered: { message: "Your filters hide everything here.", action: "Clear filters" },
  "not-indexed": { message: "Search is still being built.", action: null },
});

/**
 * `{ cause, subject, detail, action, verb }` → what the empty state says.
 * `subject` fills the cause's sentence (the service, the reason); `detail`
 * is one more sentence about what creates the data; `action` overrides the
 * cause's default label; `verb` is the CLI command that fills the list.
 * An unknown cause throws: an empty state that cannot say why is a bug.
 */
export function emptyModel(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cause = String(o.cause ?? "");
  if (!Object.hasOwn(EMPTY_CAUSES, cause)) throw new Error(`unknown empty-state cause: ${cause}`);
  const spec = EMPTY_CAUSES[cause];
  const subject = typeof o.subject === "string" && o.subject !== "" ? o.subject : "it";
  const action = typeof o.action === "string" && o.action !== "" ? o.action : spec.action;
  return {
    cause,
    message: spec.message.replace("{subject}", subject),
    detail: typeof o.detail === "string" && o.detail !== "" ? o.detail : null,
    action,
    verb: typeof o.verb === "string" && o.verb !== "" ? o.verb : null,
  };
}

/**
 * Draw an empty state. `onAction` makes the action a button; without it the
 * action is shown as words (a role to ask for, say).
 */
export function emptyFor(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const model = emptyModel(o);
  const action =
    model.action === null
      ? null
      : typeof o.onAction === "function"
        ? el("button", { class: "btn", type: "button", text: model.action, onClick: o.onAction })
        : el("div", { class: "empty-verb", text: model.action });
  return el("div", { class: "empty", "data-cause": model.cause }, [
    el("div", { class: "empty-msg", text: model.message }),
    model.detail === null ? null : el("div", { class: "empty-detail", text: model.detail }),
    model.verb === null
      ? null
      : el("div", { class: "empty-verb" }, [
          "Run ",
          el("code", { text: model.verb }),
          " to create it.",
        ]),
    action,
  ]);
}
