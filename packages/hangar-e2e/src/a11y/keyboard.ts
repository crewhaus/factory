/** Keyboard operation: a visible focus, no trap, and Escape that gives focus back. */
import type { Page } from "playwright";
import type { A11yFinding } from "./finding";
import { focusObscuredFinding } from "./focus-obscured";

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
  const style = await readFocusStyle(page);
  if (style === null) return { rule: "focus-undetermined", detail: "Tab reached no control" };
  return focusStyleFinding(style);
}

/** The focus indicator of whatever holds focus now, or null for nothing. */
async function readFocusStyle(page: Page): Promise<FocusStyle | null> {
  return await page.evaluate((): FocusStyle | null => {
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
    // The background the ring is seen against: the element's own, and, while
    // that is translucent, what shows through it from the ancestors behind,
    // down to the first opaque one (white past the root). A wash read on its
    // own over white is not what anyone sees on a dark page.
    const layers: Array<[number, number, number, number]> = [];
    // Chrome reports `color-mix()` results as `color(srgb r g b / a)`, in 0–1.
    const channels = (color: string): [number, number, number, number] | null => {
      const rgb = /^rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\)$/.exec(color);
      if (rgb !== null) {
        return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)];
      }
      const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(color);
      if (srgb !== null) {
        const c = (v: string | undefined): number => Number(v) * 255;
        return [c(srgb[1]), c(srgb[2]), c(srgb[3]), Number(srgb[4] ?? 1)];
      }
      return null;
    };
    for (let node: Element | null = active; node !== null; node = node.parentElement) {
      const layer = channels(getComputedStyle(node).backgroundColor);
      if (layer === null || layer[3] === 0) continue;
      layers.push(layer);
      if (layer[3] >= 1) break;
    }
    let shown: [number, number, number] = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) {
      shown = [r * a + shown[0] * (1 - a), g * a + shown[1] * (1 - a), b * a + shown[2] * (1 - a)];
    }
    const background = `rgb(${shown.map((c) => Math.round(c)).join(", ")})`;
    const focused = {
      tag: active.tagName.toLowerCase(),
      outlineStyle: computed.outlineStyle,
      outlineWidth: Number.parseFloat(computed.outlineWidth) || 0,
      outlineColor: computed.outlineColor,
      boxShadow: computed.boxShadow,
      background,
    };
    active.blur();
    const unfocusedBoxShadow = finished(active).boxShadow;
    active.focus();
    return { ...focused, unfocusedBoxShadow };
  });
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

/** How many Tab stops the page has: a negative tabindex is none, a radio group one. */
async function countTabStops(page: Page): Promise<number> {
  return await page.evaluate((selector) => {
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
}

/**
 * Put the next Tab at the top of the page. Blurring is not enough: a browser
 * keeps its place in the Tab order where focus last was (a page that moved
 * focus to its heading would start the walk there), so focus goes to a
 * marker at the very start of the body, which is then removed.
 */
async function startAtTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const marker = document.createElement("span");
    marker.tabIndex = -1;
    document.body.prepend(marker);
    marker.focus();
    marker.remove();
  });
}

/** Who holds focus, as `<tag> #index`, or null for nothing on the page. */
async function activeId(page: Page, press: number): Promise<string | null> {
  return await page.evaluate((count) => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active === null || active === document.body) return null;
    const id = `<${active.tagName.toLowerCase()}> #${[...document.querySelectorAll("*")].indexOf(active)}`;
    // Tab moves on inside a frame while the frame still holds focus out here.
    return active.tagName === "IFRAME" ? `${id} press ${count}` : id;
  }, press);
}

/**
 * Tab through the page until focus leaves it or comes round again. A negative
 * tabindex is no stop, and a radio group is one stop, however many buttons it has.
 */
export async function keyboardTrapFinding(page: Page): Promise<A11yFinding | undefined> {
  const stops = await countTabStops(page);
  if (stops === 0) return undefined;
  await startAtTop(page);

  const visited: (string | null)[] = [];
  const seen = new Set<string>();
  // A bound, not an expectation: a scrollable region can be a stop the count missed.
  for (let press = 0; press < stops * 2 + 4; press++) {
    await page.keyboard.press("Tab");
    const here = await activeId(page, press);
    visited.push(here);
    if (here === null ? seen.size > 0 : seen.has(here)) break;
    if (here !== null) seen.add(here);
  }
  return trapVerdict(visited, stops);
}

export type FocusTour = {
  readonly findings: readonly A11yFinding[];
  /** Tab stops the page counted, and distinct controls Tab reached. */
  readonly stops: number;
  readonly reached: number;
};

/**
 * Tab through the whole page once, the way {@link keyboardTrapFinding} walks
 * it, and judge every stop on the way: a control whose focus cannot be seen
 * ({@link focusStyleFinding}), one hidden under something fixed
 * ({@link focusObscuredFinding}), and, at the end, a trap ({@link trapVerdict}).
 * Each finding names the control it is about.
 */
export async function focusTour(page: Page): Promise<FocusTour> {
  const stops = await countTabStops(page);
  if (stops === 0) return { findings: [], stops: 0, reached: 0 };
  await startAtTop(page);
  const findings: A11yFinding[] = [];
  const visited: (string | null)[] = [];
  const seen = new Set<string>();
  for (let press = 0; press < stops * 2 + 4; press++) {
    await page.keyboard.press("Tab");
    const here = await activeId(page, press);
    visited.push(here);
    if (here === null ? seen.size > 0 : seen.has(here)) break;
    if (here === null) continue;
    seen.add(here);
    const name = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const text = (active?.getAttribute("aria-label") ?? active?.textContent ?? "").trim();
      return text.slice(0, 40);
    });
    const style = await readFocusStyle(page);
    const ring = style === null ? undefined : focusStyleFinding(style);
    if (ring !== undefined)
      findings.push({ rule: ring.rule, detail: `${ring.detail} (“${name}”)` });
    const covered = await focusObscuredFinding(page);
    if (covered !== undefined) {
      findings.push({ rule: covered.rule, detail: `${covered.detail} (“${name}”)` });
    }
  }
  const trap = trapVerdict(visited, stops);
  if (trap !== undefined) findings.push(trap);
  return { findings, stops, reached: seen.size };
}

/** Tab presses in a row that may leave focus where it was before focus
 *  counts as stuck. One press can: the step out to the browser's own
 *  controls on the way round leaves the last control active. Only a dialog
 *  with two or more controls is judged, since Tab round a single control
 *  lands back on it. */
const STUCK_PRESSES = 3;

/**
 * Tab past the end of an open dialog, again and again, and report the first
 * element OUTSIDE it that takes focus. Focus passing through `<body>` (or the
 * browser's own controls) on the way round is no finding: only a control of
 * the page behind is. Focus that Tab cannot move at all is a finding too: a
 * dialog with controls in it that swallows Tab holds the keyboard as surely
 * as one that lets it out.
 */
export async function dialogContainmentFinding(
  page: Page,
  dialog: string,
): Promise<A11yFinding | undefined> {
  const inside = await page.locator(dialog).evaluate((node) => {
    const selector =
      "a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex='-1'])";
    return node.querySelectorAll(selector).length;
  });
  if (!(await page.locator(dialog).isVisible())) {
    return { rule: "containment-undetermined", detail: `${dialog} is not open` };
  }
  const marker = "data-containment-was";
  const unmark = () =>
    page.evaluate((attr) => {
      for (const node of document.querySelectorAll(`[${attr}]`)) node.removeAttribute(attr);
    }, marker);
  try {
    return await tabRound(page, dialog, inside, marker);
  } finally {
    await unmark();
  }
}

async function tabRound(
  page: Page,
  dialog: string,
  inside: number,
  marker: string,
): Promise<A11yFinding | undefined> {
  let still = 0;
  for (let press = 0; press < inside * 2 + 4; press++) {
    // Mark where focus is, so the next read can tell whether Tab moved it.
    await page.evaluate((attr) => {
      for (const node of document.querySelectorAll(`[${attr}]`)) node.removeAttribute(attr);
      document.activeElement?.setAttribute(attr, "");
    }, marker);
    await page.keyboard.press("Tab");
    const step = await page.locator(dialog).evaluate((node, attr) => {
      const active = document.activeElement;
      const label =
        active === null
          ? "nothing"
          : `<${active.tagName.toLowerCase()}> ${(active.textContent ?? "").trim().slice(0, 40)}`;
      const moved = active === null || !active.hasAttribute(attr);
      if (active === null || active === document.body || node.contains(active)) {
        return { escaped: null, moved, label };
      }
      return { escaped: label, moved, label };
    }, marker);
    if (step.escaped !== null) {
      return { rule: "focus-escapes-dialog", detail: `Tab left ${dialog} for ${step.escaped}` };
    }
    still = step.moved ? 0 : still + 1;
    if (inside >= 2 && still >= STUCK_PRESSES) {
      return {
        rule: "focus-stuck-in-dialog",
        detail: `Tab did not move focus off ${step.label} in ${dialog}, ${still} presses in a row`,
      };
    }
  }
  return undefined;
}

/** How long an overlay that opens after a request may take to appear. */
const OVERLAY_WAIT_MS = 5_000;

/**
 * Open something with `trigger` (Enter, or `opts.key`), press Escape, and
 * report if it stayed open or focus did not come back to what opened it. An
 * overlay that opens after a request is waited for.
 */
export async function escapeFinding(
  page: Page,
  trigger: string,
  overlay: string,
  opts: { readonly key?: string } = {},
): Promise<A11yFinding | undefined> {
  await page.locator(trigger).focus();
  await page.keyboard.press(opts.key ?? "Enter");
  await page
    .locator(overlay)
    .first()
    .waitFor({ state: "visible", timeout: OVERLAY_WAIT_MS })
    .catch(() => undefined);
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
