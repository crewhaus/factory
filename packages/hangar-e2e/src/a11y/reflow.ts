/** WCAG 1.4.10: at 320 CSS px, the page scrolls in one direction only. */
import type { Page } from "playwright";
import type { A11yFinding } from "./finding";

export const REFLOW_WIDTH = 320;

/** Report horizontal page scroll at 320 px. Leaves the viewport at that width. */
export async function reflowFinding(page: Page): Promise<A11yFinding | undefined> {
  const height = page.viewportSize()?.height ?? 720;
  await page.setViewportSize({ width: REFLOW_WIDTH, height });
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (scrollWidth <= clientWidth) return undefined;
  return {
    rule: "reflow",
    detail: `the page is ${scrollWidth} px wide in a ${clientWidth} px viewport`,
  };
}
