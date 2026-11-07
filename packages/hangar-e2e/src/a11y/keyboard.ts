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
  /** The same element's shadow without focus: one that was already there shows nothing. */
  readonly unfocusedBoxShadow: string;
  readonly background: string;
};

type Rgba = readonly [number, number, number, number];

function parseColor(color: string): Rgba | undefined {
  const match = /^rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\)$/.exec(color);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)];
}

/** `top` painted over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const [r, g, b, a] = top;
  return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const WHITE: Rgba = [255, 255, 255, 1];

/**
 * The WCAG contrast ratio of a computed colour as it shows over another, or
 * undefined if unreadable. Alpha counts: a fully transparent colour is 1:1 against
 * whatever is behind it. A translucent `behind` is taken over white.
 */
export function contrastRatio(color: string, behind: string): number | undefined {
  const top = parseColor(color);
  const back = parseColor(behind);
  if (top === undefined || back === undefined) return undefined;
  const under = over(back, WHITE);
  const [high, low] = [luminance(over(top, under)), luminance(under)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

/** WCAG 1.4.11: a focus indicator needs 3:1 against what is behind it. */
const MIN_INDICATOR_CONTRAST = 3;

/** A computed `box-shadow`'s layers. Its commas also sit inside `rgb(...)`. */
function shadowLayers(boxShadow: string): readonly string[] {
  if (boxShadow === "none" || boxShadow === "") return [];
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < boxShadow.length; at++) {
    const char = boxShadow[at];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      layers.push(boxShadow.slice(start, at).trim());
      start = at + 1;
    }
  }
  layers.push(boxShadow.slice(start).trim());
  return layers;
}

/** What focus added in shadows: nothing, something that shows, or a colour it cannot read. */
function shadowIndicator(style: FocusStyle): "none" | "visible" | "unreadable" {
  const already = new Set(shadowLayers(style.unfocusedBoxShadow));
  let verdict: "none" | "unreadable" = "none";
  for (const layer of shadowLayers(style.boxShadow)) {
    if (already.has(layer)) continue;
    // Chrome computes `<colour> <x> <y> <blur> <spread> [inset]`.
    const match = /^(\w+\([^)]*\))\s+(.*)$/.exec(layer);
    if (match === null) {
      verdict = "unreadable";
      continue;
    }
    const lengths = (match[2] ?? "").split(/\s+/).map((part) => Number.parseFloat(part));
    if (!lengths.some((length) => Number.isFinite(length) && length !== 0)) continue;
    const ratio = contrastRatio(match[1] ?? "", style.background);
    if (ratio === undefined) verdict = "unreadable";
    else if (ratio >= MIN_INDICATOR_CONTRAST) return "visible";
  }
  return verdict;
}

/** Judge a focus style. Pure, so a colour Chrome reports oddly can be tested. */
export function focusStyleFinding(style: FocusStyle): A11yFinding | undefined {
  const shadow = shadowIndicator(style);
  if (shadow === "visible") return undefined;
  if (style.outlineStyle === "none" || style.outlineWidth === 0) {
    if (shadow === "unreadable") {
      return {
        rule: "focus-undetermined",
        detail: `could not read <${style.tag}>'s shadow ${style.boxShadow}`,
      };
    }
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

/**
 * Tab to the next control, and report if its focus cannot be seen. It blurs the
 * control to read its unfocused shadow, then gives focus back.
 */
export async function focusVisibleFinding(page: Page): Promise<A11yFinding | undefined> {
  await page.keyboard.press("Tab");
  const style = await page.evaluate((): FocusStyle | null => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return null;
    // A ring that eases in would otherwise be read partway.
    const finished = (node: Element): CSSStyleDeclaration => {
      for (const animation of node.getAnimations()) {
        if (animation instanceof CSSTransition) animation.finish();
      }
      return getComputedStyle(node);
    };
    const computed = finished(active);
    let background = "rgba(0, 0, 0, 0)";
    for (let node: Element | null = active; node !== null; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
        background = color;
        break;
      }
    }
    const focused = {
      tag: active.tagName.toLowerCase(),
      outlineStyle: computed.outlineStyle,
      outlineWidth: Number.parseFloat(computed.outlineWidth) || 0,
      outlineColor: computed.outlineColor,
      boxShadow: computed.boxShadow,
      background: background === "rgba(0, 0, 0, 0)" ? "rgb(255, 255, 255)" : background,
    };
    active.blur();
    const unfocusedBoxShadow = finished(active).boxShadow;
    active.focus();
    return { ...focused, unfocusedBoxShadow };
  });
  if (style === null) return { rule: "focus-undetermined", detail: "Tab reached no control" };
  return focusStyleFinding(style);
}

/** Everything that can be a tab stop. The walk below judges which really are. */
const TAB_STOP_SELECTOR =
  "a[href], area[href], button, input, select, textarea, summary, audio[controls], video[controls], [contenteditable]:not([contenteditable='false']), [tabindex]";

/**
 * Judge a walk: what held focus after each Tab, `null` for nothing on the page. Tab
 * leaving focus where it was is a trap, wherever on the page that control sits. A
 * walk that came round without reaching every stop is caught in a smaller loop.
 */
export function trapVerdict(
  visited: readonly (string | null)[],
  stops: number,
): A11yFinding | undefined {
  for (let press = 1; press < visited.length; press++) {
    const here = visited[press];
    if (here !== null && here !== undefined && here === visited[press - 1]) {
      return { rule: "keyboard-trap", detail: `Tab stayed on ${here}` };
    }
  }
  const reached = new Set(visited.filter((id) => id !== null)).size;
  if (reached >= stops) return undefined;
  return { rule: "keyboard-trap", detail: `Tab reached ${reached} of ${stops} controls` };
}

/**
 * Tab through the page until focus leaves it or comes round again. A negative
 * tabindex is no stop, and a radio group is one stop, however many buttons it has.
 */
export async function keyboardTrapFinding(page: Page): Promise<A11yFinding | undefined> {
  const stops = await page.evaluate((selector) => {
    const groups = new Set<string>();
    let count = 0;
    for (const node of document.querySelectorAll<HTMLElement>(selector)) {
      const tabindex = Number.parseInt(node.getAttribute("tabindex") ?? "", 10);
      if (tabindex < 0 || node.matches(":disabled") || node.closest("[inert]") !== null) continue;
      if (!node.checkVisibility({ visibilityProperty: true })) continue;
      if (node instanceof HTMLInputElement && node.type === "radio" && node.name !== "") {
        const form = node.form === null ? -1 : [...document.forms].indexOf(node.form);
        const group = `${form}/${node.name}`;
        if (groups.has(group)) continue;
        groups.add(group);
      }
      count += 1;
    }
    return count;
  }, TAB_STOP_SELECTOR);
  if (stops === 0) return undefined;
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  const visited: (string | null)[] = [];
  const seen = new Set<string>();
  // A bound, not an expectation: a scrollable region can be a stop the count missed.
  for (let press = 0; press < stops * 2 + 4; press++) {
    await page.keyboard.press("Tab");
    const here = await page.evaluate((count) => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      if (active === null || active === document.body) return null;
      const id = `<${active.tagName.toLowerCase()}> #${[...document.querySelectorAll("*")].indexOf(active)}`;
      // Tab moves on inside a frame while the frame still holds focus out here.
      return active.tagName === "IFRAME" ? `${id} press ${count}` : id;
    }, press);
    visited.push(here);
    if (here === null ? seen.size > 0 : seen.has(here)) break;
    if (here !== null) seen.add(here);
  }
  return trapVerdict(visited, stops);
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
