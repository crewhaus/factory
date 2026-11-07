/**
 * A toggle button: `aria-pressed` for assistive tech, and a visible check
 * glyph for everyone, so "on" is never told by colour alone. It updates in
 * place — the button that was clicked is the button that holds focus
 * afterwards, never a rebuilt copy.
 */

import { el } from "../dom.js";

/** The glyph shown on a pressed toggle. */
export const CHECK_GLYPH = "✓";

/** What a toggle shows in a state. Pure. */
export function toggleModel(pressed) {
  const on = pressed === true;
  return { ariaPressed: on ? "true" : "false", glyph: on ? CHECK_GLYPH : "" };
}

/** Put a toggle made by {@link toggleBtn} into a state, in place. */
export function setPressed(btn, pressed) {
  const model = toggleModel(pressed);
  btn.setAttribute("aria-pressed", model.ariaPressed);
  btn.classList.toggle("active", pressed === true);
  const glyph = btn.querySelector(".toggle-check");
  if (glyph !== null) glyph.textContent = model.glyph;
}

/** Change a toggle's words, in place. */
export function setToggleLabel(btn, label) {
  const text = btn.querySelector(".toggle-label");
  if (text !== null) text.textContent = String(label);
}

/**
 * `{ label, pressed, onToggle(next, btn), className }`. A click flips the
 * state, then calls `onToggle`; a caller that must refuse (the last choice
 * of a group) sets it back with {@link setPressed}.
 */
export function toggleBtn(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const btn = el(
    "button",
    {
      class: `btn btn-ghost toggle${typeof o.className === "string" ? ` ${o.className}` : ""}`,
      type: "button",
    },
    [
      el("span", { class: "toggle-check", "aria-hidden": "true" }),
      el("span", { class: "toggle-label", text: String(o.label ?? "") }),
    ],
  );
  setPressed(btn, o.pressed === true);
  btn.addEventListener("click", () => {
    const next = btn.getAttribute("aria-pressed") !== "true";
    setPressed(btn, next);
    if (typeof o.onToggle === "function") o.onToggle(next, btn);
  });
  return btn;
}
