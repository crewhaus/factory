/** The accessibility tree, as Playwright reads it. */
import type { Page } from "playwright";
import type { A11yFinding } from "./finding";

const NAMED_ROLES = /^\s*- (button|link|textbox|combobox|checkbox|radio|switch|tab)\s*(:|$)/;

/** A control with no accessible name, from an ARIA snapshot's text. */
export function unnamedControls(snapshot: string): readonly A11yFinding[] {
  const findings: A11yFinding[] = [];
  for (const line of snapshot.split("\n")) {
    const match = NAMED_ROLES.exec(line);
    if (match !== null) findings.push({ rule: "unnamed-control", detail: `a ${match[1]}` });
  }
  return findings;
}

/** The snapshot of `selector`, and the controls in it nobody can name. */
export async function ariaSnapshot(
  page: Page,
  selector = "body",
): Promise<{ readonly snapshot: string; readonly findings: readonly A11yFinding[] }> {
  const snapshot = await page.locator(selector).ariaSnapshot();
  return { snapshot, findings: unnamedControls(snapshot) };
}
