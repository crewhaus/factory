/** WCAG 2.4.11: the focused element is not hidden behind something fixed. */
import type { Page } from "playwright";
import type { A11yFinding } from "./finding";

/** Report if what holds focus is covered at its centre by a fixed or sticky element. */
export async function focusObscuredFinding(page: Page): Promise<A11yFinding | undefined> {
  const covering = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return null;
    active.scrollIntoView({ block: "nearest" });
    const box = active.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (top === null || top === active || active.contains(top) || top.contains(active)) return null;
    for (let node: Element | null = top; node !== null; node = node.parentElement) {
      const { position } = getComputedStyle(node);
      if (position === "fixed" || position === "sticky") {
        return `<${active.tagName.toLowerCase()}> is under <${node.tagName.toLowerCase()}>`;
      }
    }
    return null;
  });
  return covering === null ? undefined : { rule: "focus-obscured", detail: covering };
}
