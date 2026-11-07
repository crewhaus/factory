/**
 * WCAG 1.4.12: nothing is lost under the text-spacing overrides. They are set
 * through the CSSOM rather than an injected stylesheet, so they hold under a
 * page's own CSP without relaxing it.
 */
import type { Page } from "playwright";
import type { A11yFinding } from "./finding";

/** A clipped box's overflow can exceed its size by a pixel of ink before any override. */
const INK_TOLERANCE_PX = 1;

/** Apply the overrides, and report each element they newly clip. */
export async function textSpacingFindings(page: Page): Promise<readonly A11yFinding[]> {
  const clipped = await page.evaluate((tolerance) => {
    const hiddenOverflow = (node: Element): number => {
      const { overflowX, overflowY } = getComputedStyle(node);
      const across =
        overflowX === "hidden" || overflowX === "clip" ? node.scrollWidth - node.clientWidth : 0;
      const down =
        overflowY === "hidden" || overflowY === "clip" ? node.scrollHeight - node.clientHeight : 0;
      return Math.max(across, down);
    };
    const nodes = [...document.querySelectorAll<HTMLElement>("body *")];
    const before = new Map(nodes.map((node) => [node, hiddenOverflow(node)]));
    for (const node of [document.body, ...nodes]) {
      node.style.setProperty("line-height", "1.5", "important");
      node.style.setProperty("letter-spacing", "0.12em", "important");
      node.style.setProperty("word-spacing", "0.16em", "important");
    }
    for (const node of document.querySelectorAll<HTMLElement>("p")) {
      node.style.setProperty("margin-bottom", "2em", "important");
    }
    return nodes
      .filter((node) => hiddenOverflow(node) - (before.get(node) ?? 0) > tolerance)
      .map((node) => `<${node.tagName.toLowerCase()}> ${(node.textContent ?? "").slice(0, 40)}`);
  }, INK_TOLERANCE_PX);
  return clipped.map((detail) => ({ rule: "text-spacing-clip", detail }));
}
