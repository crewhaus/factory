/**
 * Tooltips: one real element for the whole console, shown beside whatever
 * carries a `data-tip` (set by `withTip` / `tipIcon` in `dom.js`).
 *
 * WCAG 1.4.13 asks three things of content that appears on hover or focus,
 * and each is a rule here:
 *
 *   - it opens on keyboard focus as well as on hover, so a keyboard user
 *     reads the same words a mouse user does;
 *   - it can itself be hovered: moving the pointer from the control onto the
 *     tip does not close it;
 *   - Escape closes it without moving focus or the pointer
 *     ({@link dismissTooltip}, called from the console's one key listener).
 *
 * While open, the control is described by the tip (`aria-describedby`), so a
 * screen reader reads it on focus. The text goes in with `textContent`:
 * a tip is always text, never markup.
 *
 * `installTooltips()` registers the listeners once; importing this module
 * does nothing.
 */

import { el } from "../dom.js";

/** How long the tip waits before closing, so the pointer can reach it. */
const HIDE_DELAY_MS = 250;
const TIP_ID = "hangar-tip";
const GAP_PX = 6;
const EDGE_PX = 8;

let tip = null;
let current = null;
let hideTimer = null;
let installed = false;

/** The element a tip belongs to, if `node` is inside one. */
function tipTarget(node) {
  return node instanceof Element ? node.closest("[data-tip]") : null;
}

function ensureTip() {
  if (tip === null) {
    tip = el("div", { class: "tip", id: TIP_ID, role: "tooltip", hidden: true });
    tip.addEventListener("mouseenter", cancelHide);
    tip.addEventListener("mouseleave", scheduleHide);
  }
  return tip;
}

function cancelHide() {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function scheduleHide() {
  cancelHide();
  hideTimer = setTimeout(hide, HIDE_DELAY_MS);
}

function describe(node, on) {
  const ids = (node.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id !== "");
  const next = on
    ? ids.includes(TIP_ID)
      ? ids
      : [...ids, TIP_ID]
    : ids.filter((id) => id !== TIP_ID);
  if (next.length === 0) node.removeAttribute("aria-describedby");
  else node.setAttribute("aria-describedby", next.join(" "));
}

/**
 * Where a tip of `size` goes beside a control at `anchor`, inside a viewport
 * of `view`. Below unless it would leave the viewport, then above; never past
 * either side. Pure.
 */
export function tipPlacement(anchor, size, view) {
  const left = Math.max(EDGE_PX, Math.min(anchor.left, view.width - size.width - EDGE_PX));
  const below = anchor.bottom + GAP_PX;
  const fitsBelow = below + size.height <= view.height - EDGE_PX;
  const top = fitsBelow ? below : Math.max(EDGE_PX, anchor.top - GAP_PX - size.height);
  return { left: Math.round(left), top: Math.round(top) };
}

function show(target) {
  const text = target.dataset.tip ?? "";
  if (text === "") return;
  cancelHide();
  const node = ensureTip();
  if (current !== null && current !== target) describe(current, false);
  current = target;
  node.textContent = text;
  // Inside a modal dialog the page behind is inert, so the tip goes in with
  // the control.
  const host = target.closest("dialog[open]") ?? document.body;
  if (node.parentNode !== host) host.appendChild(node);
  node.hidden = false;
  place();
  describe(target, true);
}

/** Put the open tip beside its control, where the control is now. */
function place() {
  if (tip === null || current === null) return;
  if (!current.isConnected) {
    hide();
    return;
  }
  const at = tipPlacement(
    current.getBoundingClientRect(),
    { width: tip.offsetWidth, height: tip.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
  );
  tip.style.left = `${at.left}px`;
  tip.style.top = `${at.top}px`;
}

function hide() {
  cancelHide();
  if (current !== null) describe(current, false);
  current = null;
  if (tip !== null) tip.hidden = true;
}

/** Close an open tip. True when one was open, so the caller can claim Escape. */
export function dismissTooltip() {
  if (tip === null || tip.hidden) return false;
  hide();
  return true;
}

/** True while a tip is showing. */
export function tooltipOpen() {
  return tip !== null && !tip.hidden;
}

/** Register the listeners, once. */
export function installTooltips() {
  if (installed) return;
  installed = true;
  document.addEventListener("mouseover", (event) => {
    const target = tipTarget(event.target);
    if (target !== null) show(target);
  });
  document.addEventListener("mouseout", (event) => {
    if (current === null) return;
    const to = event.relatedTarget;
    if (to instanceof Node && (current.contains(to) || tip?.contains(to) === true)) return;
    if (tipTarget(event.target) === current) scheduleHide();
  });
  document.addEventListener("focusin", (event) => {
    const target = tipTarget(event.target);
    if (target !== null) show(target);
    else if (current !== null) hide();
  });
  document.addEventListener("focusout", (event) => {
    if (current === null) return;
    const to = event.relatedTarget;
    if (to instanceof Node && current.contains(to)) return;
    if (tipTarget(event.target) === current) hide();
  });
  // The tip is fixed, so a scroll would leave it beside nothing: it follows.
  window.addEventListener("scroll", () => place(), { capture: true, passive: true });
  // A new screen removes the control without a focusout; the tip goes with it.
  window.addEventListener("hashchange", () => hide());
}
