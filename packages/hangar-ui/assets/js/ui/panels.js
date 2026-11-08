/**
 * A row of panel buttons over one content area (the Memory fabric's and
 * the Thredz tab's sub-panels). It updates in place, so the button that was
 * pressed keeps focus; the current one carries `aria-current="true"` (a
 * panel is not a page); and the new panel's name is announced politely, so
 * a screen-reader user hears that the content below changed.
 */

import { el } from "../dom.js";
import { announce } from "./live.js";

/** Each panel with whether it is the current one. Pure. */
export function panelModel(panels, current) {
  const list = Array.isArray(panels) ? panels : [];
  const known = list.some(([id]) => id === current);
  return list.map(([id, label], i) => ({
    id,
    label,
    current: known ? id === current : i === 0,
  }));
}

/**
 * `{ label, panels: [[id, label]…], current, onSelect(id) }` →
 * `{ node, select(id) }`. `select` repaints, announces and calls `onSelect`.
 */
export function panelNav(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const panels = Array.isArray(o.panels) ? o.panels : [];
  const nav = el("nav", { class: "tabs", "aria-label": String(o.label ?? "panels") });
  const buttons = new Map();
  const paint = (id) => {
    for (const row of panelModel(panels, id)) {
      const btn = buttons.get(row.id);
      if (btn === undefined) continue;
      btn.classList.toggle("active", row.current);
      if (row.current) btn.setAttribute("aria-current", "true");
      else btn.removeAttribute("aria-current");
    }
  };
  const select = (id) => {
    paint(id);
    const row = panelModel(panels, id).find((r) => r.current);
    if (row !== undefined) announce(`Showing ${row.label}`);
    if (typeof o.onSelect === "function") o.onSelect(row?.id ?? id);
  };
  for (const [id, label] of panels) {
    const btn = el("button", {
      class: "tab",
      type: "button",
      text: label,
      onClick: () => select(id),
    });
    buttons.set(id, btn);
    nav.appendChild(btn);
  }
  paint(o.current);
  return { node: nav, select };
}
