/** Keyboard operation: a visible focus, no trap, and Escape that gives focus back. */
import type { Page } from "playwright";
import type { A11yFinding } from "./finding";

/** The computed focus indicator of whatever holds focus. */
type FocusStyle = {
  readonly tag: string;
  readonly outlineStyle: string;
  readonly outlineWidth: number;
  readonly outlineColor: string;
  readonly boxShadow: string;
  readonly background: string;
};

function parseColor(color: string): readonly [number, number, number, number] | undefined {
  const match = /^rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\)$/.exec(color);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)];
}

function luminance([r, g, b]: readonly [number, number, number, number]): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG contrast ratio of two computed colours, or undefined if unreadable. */
export function contrastRatio(a: string, b: string): number | undefined {
  const first = parseColor(a);
  const second = parseColor(b);
  if (first === undefined || second === undefined) return undefined;
  const [high, low] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

/** WCAG 1.4.11: a focus indicator needs 3:1 against what is behind it. */
const MIN_INDICATOR_CONTRAST = 3;

/** Judge a focus style. Pure, so a colour Chrome reports oddly can be tested. */
export function focusStyleFinding(style: FocusStyle): A11yFinding | undefined {
  if (style.boxShadow !== "none" && style.boxShadow !== "") return undefined;
  if (style.outlineStyle === "none" || style.outlineWidth === 0) {
    return { rule: "focus-not-visible", detail: `<${style.tag}> shows no focus indicator` };
  }
  const ratio = contrastRatio(style.outlineColor, style.background);
  if (ratio === undefined) {
    return {
      rule: "focus-undetermined",
      detail: `could not read <${style.tag}>'s ring ${style.outlineColor} on ${style.background}`,
    };
  }
  if (ratio < MIN_INDICATOR_CONTRAST) {
    return {
      rule: "focus-not-visible",
      detail: `<${style.tag}>'s ring has ${ratio.toFixed(2)}:1 contrast, under ${MIN_INDICATOR_CONTRAST}:1`,
    };
  }
  return undefined;
}

/** Tab to the next control, and report if its focus cannot be seen. */
export async function focusVisibleFinding(page: Page): Promise<A11yFinding | undefined> {
  await page.keyboard.press("Tab");
  const style = await page.evaluate((): FocusStyle | null => {
    const active = document.activeElement;
    if (active === null || active === document.body) return null;
    const computed = getComputedStyle(active);
    let background = "rgba(0, 0, 0, 0)";
    for (let node: Element | null = active; node !== null; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
        background = color;
        break;
      }
    }
    return {
      tag: active.tagName.toLowerCase(),
      outlineStyle: computed.outlineStyle,
      outlineWidth: Number.parseFloat(computed.outlineWidth) || 0,
      outlineColor: computed.outlineColor,
      boxShadow: computed.boxShadow,
      background: background === "rgba(0, 0, 0, 0)" ? "rgb(255, 255, 255)" : background,
    };
  });
  if (style === null) return { rule: "focus-undetermined", detail: "Tab reached no control" };
  return focusStyleFinding(style);
}

/**
 * Tab through the page. A control the keyboard can reach but never leave stops
 * the walk from reaching the rest, so a trap shows up as controls never visited.
 */
export async function keyboardTrapFinding(page: Page): Promise<A11yFinding | undefined> {
  const total = await page.evaluate(
    () =>
      [
        ...document.querySelectorAll(
          "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((node) => node.checkVisibility()).length,
  );
  if (total === 0) return undefined;
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  const seen = new Set<string>();
  for (let press = 0; press < total + 1; press++) {
    await page.keyboard.press("Tab");
    const identity = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) return null;
      const all = [...document.querySelectorAll("*")];
      return `${active.tagName}:${all.indexOf(active)}`;
    });
    if (identity !== null) seen.add(identity);
  }
  if (seen.size >= total) return undefined;
  return {
    rule: "keyboard-trap",
    detail: `Tab reached ${seen.size} of ${total} controls`,
  };
}

/**
 * Open something with `trigger`, press Escape, and report if it stayed open or
 * focus did not come back to what opened it.
 */
export async function escapeFinding(
  page: Page,
  trigger: string,
  overlay: string,
): Promise<A11yFinding | undefined> {
  await page.locator(trigger).focus();
  await page.keyboard.press("Enter");
  if (!(await page.locator(overlay).isVisible())) {
    return { rule: "escape-undetermined", detail: `${trigger} did not open ${overlay}` };
  }
  await page.keyboard.press("Escape");
  if (await page.locator(overlay).isVisible()) {
    return { rule: "escape-does-not-close", detail: `${overlay} stayed open after Escape` };
  }
  const returned = await page.locator(trigger).evaluate((node) => node === document.activeElement);
  if (!returned) {
    return { rule: "focus-not-returned", detail: `focus did not return to ${trigger}` };
  }
  return undefined;
}
