/**
 * The console by keyboard alone: the skip link, a focus ring and no trap on
 * every gated screen, dialogs that hold focus and give it back, the command
 * menu as a combobox, inbox verdicts that take two keys and only while the
 * list has focus, tooltips, controls that keep focus across their own
 * updates, a refresh that keeps an open editor, and the Readability choices.
 */
import type { JSHandle, Page } from "playwright";
import type { A11yFinding } from "../a11y/finding";
import { GATED_TEMPLATES } from "../a11y/gate";
import { dialogContainmentFinding, escapeFinding, focusTour } from "../a11y/keyboard";
import { LIBRARY_ROUTE, globalRoute, harnessRoute } from "../console-routes";
import type { Session } from "../session";
import { settle } from "../settle";
import {
  a11yFleet,
  clearPrefs,
  freshVisit,
  mockRefusals,
  resetOverlays,
  setPrefs,
  waitFor,
} from "./a11y-states";
import type { Journey } from "./journey";

const fail = (what: string): never => {
  throw new Error(what);
};

/** The route a gated template stands for, for one harness. */
function routeOf(template: string, harnessId: string): string {
  return template.startsWith("#/h/:id/")
    ? harnessRoute(harnessId, template.slice("#/h/:id/".length))
    : template;
}

async function activeIs(page: Page, handle: JSHandle): Promise<boolean> {
  return await page.evaluate((node) => node === document.activeElement, handle);
}

async function activeMatches(page: Page, selector: string): Promise<boolean> {
  return await page.evaluate(
    (sel) => document.activeElement instanceof Element && document.activeElement.matches(sel),
    selector,
  );
}

async function activeWithin(page: Page, selector: string): Promise<boolean> {
  return await page.evaluate(
    (sel) => document.activeElement?.closest(sel) !== null && document.activeElement !== null,
    selector,
  );
}

/** Wait until a condition in the page holds, or fail naming it. */
async function until(page: Page, what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await page.waitForTimeout(25);
  }
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    return active === null
      ? "nothing"
      : `<${active.tagName.toLowerCase()} class="${active.className}"> ${(active.textContent ?? "").trim().slice(0, 40)}`;
  });
  fail(`never happened: ${what} (focus is on ${focus}, at ${page.url()})`);
}

/** Every grant the browser sends, counted. */
function grantCounter(page: Page): () => number {
  let grants = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/approvals\/[^/]+\/grant$/.test(new URL(request.url()).pathname)
    ) {
      grants += 1;
    }
  });
  return () => grants;
}

async function skipLink(session: Session): Promise<void> {
  const { page } = session;
  await freshVisit(session, LIBRARY_ROUTE);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press("Tab");
  if (!(await activeMatches(page, "a.skip-link")))
    fail("the first Tab did not reach the skip link");
  const before = await page.evaluate(() => globalThis.location.hash);
  await page.keyboard.press("Enter");
  if (!(await activeMatches(page, "main#view"))) fail("the skip link did not move focus to main");
  const after = await page.evaluate(() => globalThis.location.hash);
  if (after !== before) fail(`the skip link changed the address from ${before} to ${after}`);
}

async function tourEveryScreen(session: Session, harnessId: string, theme: string): Promise<void> {
  const findings: string[] = [];
  for (const template of GATED_TEMPLATES) {
    await freshVisit(session, routeOf(template, harnessId));
    const tour = await focusTour(session.page);
    if (tour.reached === 0) findings.push(`${template} ${theme}: Tab reached nothing`);
    for (const finding of tour.findings) {
      findings.push(`${template} ${theme}: ${finding.rule}: ${finding.detail}`);
    }
  }
  if (findings.length > 0) fail(`the focus tour found:\n  ${findings.join("\n  ")}`);
}

async function overlays(session: Session, harnessId: string): Promise<void> {
  const { page } = session;
  const spec = harnessRoute(harnessId, "spec");
  const overview = harnessRoute(harnessId, "overview");
  const cases: Array<{ route: string; trigger: string; overlay: string; key?: string }> = [
    { route: overview, trigger: 'button:text-is("Start")', overlay: "dialog[open]" },
    { route: spec, trigger: 'button:text-is("Pin to…")', overlay: "dialog[open]" },
    { route: spec, trigger: 'button:text-is("View")', overlay: "dialog[open]" },
    { route: spec, trigger: 'button:text-is("Save")', overlay: "dialog[open]" },
    { route: LIBRARY_ROUTE, trigger: "button.omni-open", overlay: "dialog.omni-panel[open]" },
    { route: LIBRARY_ROUTE, trigger: "button.omni-open", overlay: "dialog.sheet[open]", key: "?" },
  ];
  const findings: A11yFinding[] = [];
  for (const c of cases) {
    await resetOverlays(page);
    await freshVisit(session, c.route);
    const escaped = await escapeFinding(
      page,
      c.trigger,
      c.overlay,
      c.key !== undefined ? { key: c.key } : {},
    );
    if (escaped !== undefined) {
      findings.push({ ...escaped, detail: `${c.trigger}: ${escaped.detail}` });
    }
    // Again, and Tab round the open dialog: nothing behind it may take focus.
    await page.locator(c.trigger).focus();
    await page.keyboard.press(c.key ?? "Enter");
    await waitFor(page, c.overlay, `${c.trigger} opening ${c.overlay}`);
    const contained = await dialogContainmentFinding(page, c.overlay);
    if (contained !== undefined) findings.push(contained);
    await resetOverlays(page);
  }
  if (findings.length > 0) {
    fail(
      `an overlay broke the keyboard:\n  ${findings.map((f) => `${f.rule}: ${f.detail}`).join("\n  ")}`,
    );
  }
}

async function commandMenu(session: Session, starts: () => number): Promise<void> {
  const { page } = session;
  await freshVisit(session, LIBRARY_ROUTE);
  const opener = await page.locator("button.omni-open").elementHandle();
  if (opener === null) fail("no command menu button");
  await (opener as JSHandle<HTMLElement>).evaluate((node) => node.focus());
  await page.keyboard.press("Enter");
  await waitFor(page, "dialog.omni-panel[open] input[role=combobox]", "the command menu");
  const input = page.locator("dialog.omni-panel[open] input[role=combobox]");
  if ((await input.getAttribute("aria-expanded")) !== "false")
    fail("an empty menu says it is expanded");
  await page.keyboard.type("fleet");
  await waitFor(page, '[role="option"]', "a result for fleet");
  if ((await input.getAttribute("aria-expanded")) !== "true")
    fail("a menu with results says it is collapsed");
  const first = await input.getAttribute("aria-activedescendant");
  if (first === null || (await page.locator(`#${first}`).getAttribute("role")) !== "option") {
    fail(`aria-activedescendant names no option: ${first}`);
  }
  if ((await page.locator('[role="option"]').count()) > 1) {
    await page.keyboard.press("ArrowDown");
    if ((await input.getAttribute("aria-activedescendant")) === first)
      fail("ArrowDown did not move the active option");
    await page.keyboard.press("ArrowUp");
  }
  const before = await page.evaluate(() => globalThis.location.hash);
  await page.keyboard.press("Enter");
  await until(
    page,
    "Enter on a result to navigate and close the menu",
    async () =>
      (await page.locator("dialog.omni-panel[open]").count()) === 0 &&
      (await page.evaluate(() => globalThis.location.hash)) !== before,
  );
  await settle(page, "a result");

  // An action takes a second step, and Escape takes it back.
  await freshVisit(session, LIBRARY_ROUTE);
  await page.locator("button.omni-open").focus();
  await page.keyboard.press("Enter");
  await waitFor(page, "dialog.omni-panel[open]", "the command menu");
  await page.keyboard.type("start fleet");
  await waitFor(page, ".omni-action", "a proposed action");
  for (let i = 0; i < 20; i += 1) {
    const active = await input.getAttribute("aria-activedescendant");
    if (
      active !== null &&
      (await page.locator(`#${active}`).getAttribute("class"))?.includes("omni-action")
    )
      break;
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Enter");
  await waitFor(page, ".omni-confirm-row", "the action's confirm row");
  if (starts() !== 0) fail("Enter on an action started it without a second step");
  await page.keyboard.press("Escape");
  if (await page.locator(".omni-confirm-row").isVisible())
    fail("Escape did not take the armed action back");
  if ((await page.locator("dialog.omni-panel[open]").count()) !== 1)
    fail("Escape on an armed action closed the whole menu");
  await page.keyboard.press("Escape");
  await until(
    page,
    "Escape to close the menu",
    async () => (await page.locator("dialog.omni-panel[open]").count()) === 0,
  );
  if (!(await activeMatches(page, "button.omni-open")))
    fail("focus did not return to the command menu button");
  if (starts() !== 0) fail("the command menu started something");
}

async function inbox(session: Session, harnessId: string): Promise<void> {
  const { page } = session;
  const grants = grantCounter(page);
  const row = '.inbox-card[tabindex="0"]';
  await freshVisit(session, globalRoute("approvals"));
  await page.locator(row).focus();
  await page.keyboard.press("g");
  await waitFor(page, ".inbox-armed", "the armed prompt");
  if (grants() !== 0) fail("g alone sent a grant");
  await until(page, "the polite region to say what Enter will do", async () =>
    ((await page.locator('[data-live="polite"]').textContent()) ?? "").includes("Grant"),
  );
  await page.keyboard.press("Escape");
  if ((await page.locator(".inbox-armed").count()) !== 0) fail("Escape left the row armed");
  if (grants() !== 0) fail("Escape sent a grant");

  await page.keyboard.press("g");
  await page.keyboard.press("Enter");
  await until(page, "g then Enter to send one grant", async () => grants() === 1);
  await settle(page, "the inbox after a grant");
  await until(page, "focus to return to a row", async () => activeMatches(page, ".inbox-card"));
  if (grants() !== 1) fail(`g then Enter sent ${grants()} grants`);

  // Enter on the row's own Grant button is that button's: one grant.
  const button = page.locator(`${row} .inbox-actions button:text-is("Grant")`);
  await button.focus();
  await page.keyboard.press("Enter");
  await until(page, "Enter on Grant to send one grant", async () => grants() === 2);
  await settle(page, "the inbox after a second grant");
  await until(page, "focus to return to the remaining row", async () =>
    activeMatches(page, ".inbox-card"),
  );

  // Outside the list, the inbox keys are nobody's.
  await page.getByRole("button", { name: "Show settled" }).focus();
  await page.keyboard.press("g");
  if ((await page.locator(".inbox-armed").count()) !== 0) fail("g outside the list armed a row");
  if (grants() !== 2) fail("g outside the list sent a grant");

  // Single-key shortcuts off: no letter does anything, in the list too.
  await page.evaluate(() =>
    localStorage.setItem("hangar.prefs", JSON.stringify({ v: 1, singleKeys: false })),
  );
  await page.locator(row).focus();
  await page.keyboard.press("g");
  if ((await page.locator(".inbox-armed").count()) !== 0)
    fail("g armed a row with single-key shortcuts off");
  await page.evaluate(() => localStorage.removeItem("hangar.prefs"));

  // `?` in the list is the inbox's help; outside it, the global sheet.
  await page.locator(row).focus();
  await page.keyboard.press("?");
  await waitFor(page, ".keyhelp li", "the inbox help");
  if ((await page.locator("dialog.sheet[open]").count()) !== 0)
    fail("? in the list opened the global sheet too");
  await page.keyboard.press("?");
  await page.getByRole("button", { name: "Show settled" }).focus();
  await page.keyboard.press("?");
  await waitFor(page, "dialog.sheet[open]", "the global sheet from outside the list");
  await resetOverlays(page);

  // `.` goes into the row menu, Escape comes back to the row.
  await page.locator(row).focus();
  await page.keyboard.press(".");
  await until(page, ". to move focus into the row menu", async () =>
    activeWithin(page, ".rowmenu"),
  );
  await page.keyboard.press("Escape");
  await until(page, "Escape to return focus to the row", async () =>
    activeMatches(page, ".inbox-card"),
  );

  // Enter on an unarmed row opens it.
  await page.keyboard.press("Enter");
  await until(page, "unarmed Enter to follow the row's link", async () =>
    (await page.evaluate(() => globalThis.location.hash)).startsWith("#/h/"),
  );
  await settle(page, "the row's harness");
  if (grants() !== 2) fail(`the inbox sent ${grants()} grants, not 2`);

  // Over a typed confirmation, `?` and `/` open nothing.
  await freshVisit(session, harnessRoute(harnessId, "spec"));
  await page.getByRole("button", { name: "Pin to…" }).first().click();
  await waitFor(page, "dialog[open] input[placeholder]", "the typed confirm");
  await page.locator('dialog[open] button:text-is("Cancel")').focus();
  await page.keyboard.press("?");
  await page.keyboard.press("/");
  if ((await page.locator("dialog[open]").count()) !== 1)
    fail("a shortcut stacked an overlay on the typed confirm");
  // A click on the backdrop does not close a dialog that holds typing.
  await page.locator("dialog[open] input[placeholder]").fill("half-typed");
  await page.mouse.click(4, 4);
  if ((await page.locator("dialog[open]").count()) !== 1)
    fail("a backdrop click closed the typed confirm");
  if ((await page.locator("dialog[open] input[placeholder]").inputValue()) !== "half-typed") {
    fail("a backdrop click lost the typed text");
  }
  await resetOverlays(page);
}

async function tooltip(session: Session): Promise<void> {
  const { page } = session;
  await freshVisit(session, LIBRARY_ROUTE);
  const trigger = page.locator("#view button[data-tip]").first();
  const handle = await trigger.elementHandle();
  if (handle === null) fail("no control on the Library carries a tooltip");
  await trigger.focus();
  await waitFor(page, ".tip", "the tooltip on focus");
  await page.keyboard.press("Escape");
  await until(
    page,
    "Escape to close the tooltip",
    async () => !(await page.locator(".tip").isVisible()),
  );
  if (!(await activeIs(page, handle as JSHandle))) fail("Escape on a tooltip moved focus");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await trigger.hover();
  await waitFor(page, ".tip", "the tooltip on hover");
  await page.locator(".tip").hover();
  // Longer than the tip waits before it closes: hovering it must hold it open.
  await page.waitForTimeout(600);
  if (!(await page.locator(".tip").isVisible())) fail("the tooltip closed while it was hovered");
}

async function keepsFocus(
  page: Page,
  selector: string,
  what: string,
  press = "Enter",
): Promise<void> {
  const handle = await page.locator(selector).first().elementHandle();
  if (handle === null) fail(`${what}: nothing matches ${selector}`);
  await (handle as JSHandle<HTMLElement>).evaluate((node) => node.focus());
  await page.keyboard.press(press);
  await settle(page, what);
  if (!(await activeIs(page, handle as JSHandle)))
    fail(`${what}: focus left the control after its update`);
}

async function panelsAndToggles(session: Session, harnessId: string): Promise<void> {
  const { page } = session;
  await freshVisit(session, harnessRoute(harnessId, "memory"));
  await keepsFocus(
    page,
    'nav[aria-label="memory fabric panels"] button:text-is("Wiki")',
    "a memory panel",
  );
  await freshVisit(session, harnessRoute(harnessId, "thredz"));
  await keepsFocus(
    page,
    'nav[aria-label="thredz panels"] button:text-is("Records")',
    "a Thredz panel",
  );
  await freshVisit(session, globalRoute("activity"));
  await keepsFocus(page, '[aria-label="activity kinds"] button', "an activity kind toggle");
  await keepsFocus(
    page,
    '[aria-label="digest window"] button:has-text("7 days")',
    "the window toggle",
  );
}

async function keyedRefresh(session: Session): Promise<void> {
  const { page } = session;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/harnesses\?hydrate=1/, async (route) => {
    await held;
    await route.continue();
  });
  await session.visit(globalRoute("settings"));
  // Not through `visit`, which waits for every request: one is being held.
  await page.evaluate((hash) => {
    globalThis.location.hash = hash;
  }, LIBRARY_ROUTE);
  await waitFor(page, 'button[aria-label^="edit registry fields"]', "the Library's first paint");
  await page.locator('button[aria-label^="edit registry fields"]').first().click();
  const notes = page.locator('.editor-tr textarea[aria-label="notes"]');
  await waitFor(page, '.editor-tr textarea[aria-label="notes"]', "the row editor");
  await notes.focus();
  await page.keyboard.type("kept across the refresh");
  const handle = await notes.elementHandle();
  release();
  await settle(page, "the Library refresh");
  await page.unroute(/\/api\/harnesses\?hydrate=1/);
  if ((await page.locator(".rollup").textContent())?.includes("refreshing") === true) {
    fail("the Library never finished its refresh");
  }
  if ((await notes.count()) !== 1) fail("the refresh closed the open row editor");
  if ((await notes.inputValue()) !== "kept across the refresh")
    fail("the refresh lost what was typed");
  if (handle === null || !(await activeIs(page, handle)))
    fail("the refresh moved focus out of the editor");
}

async function firstRunAndReadability(session: Session, harnessId: string): Promise<void> {
  const { page } = session;
  await clearPrefs(page);
  await waitFor(page, ".firstrun", "the first-run card");
  await page.getByRole("button", { name: "Not now" }).click();
  if ((await page.locator(".firstrun").count()) !== 0) fail("Not now left the first-run card");
  await page.reload();
  await settle(page, "a reload");
  if ((await page.locator(".firstrun").count()) !== 0)
    fail("the first-run card came back after Not now");

  await clearPrefs(page);
  await waitFor(page, ".firstrun", "the first-run card");
  await page.getByRole("button", { name: "Adjust" }).click();
  await until(
    page,
    "Adjust to land on Settings",
    async () => (await page.evaluate(() => globalThis.location.hash)) === globalRoute("settings"),
  );
  await settle(page, "Settings");
  await until(page, "focus in the Readability card", async () =>
    activeWithin(page, "#readability"),
  );

  const rootSize = () =>
    page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  const before = await rootSize();
  await page.locator("#readability label", { hasText: "Larger" }).click();
  const larger = await rootSize();
  if (!(larger > before)) fail(`Larger left the root text size at ${larger}px (was ${before}px)`);
  await page.reload();
  await settle(page, "a reload");
  if ((await rootSize()) !== larger) fail("Larger did not survive a reload");
  await page.locator("#readability label", { hasText: "Light" }).click();
  if ((await page.evaluate(() => document.documentElement.dataset["theme"])) !== "light") {
    fail("Theme: Light did not change the theme");
  }
  await page.locator("#readability label", { hasText: "Dark" }).click();
  await setPrefs(page, { firstRunDone: true });

  // A draft survives a reload of the tab.
  await freshVisit(session, harnessRoute(harnessId, "advisor"));
  const title = page.locator('input[aria-label="issue title"]');
  await title.fill("the agent loops on a refusal");
  await title.dispatchEvent("input");
  await page.reload();
  await settle(page, "a reload");
  if ((await title.inputValue()) !== "the agent loops on a refusal")
    fail("the draft did not survive a reload");
}

export const keyboardTour: Journey = {
  id: "keyboard-tour",
  shard: "axe",
  proves:
    "Every gated screen works by keyboard alone: a skip link first, a visible unobscured focus and no trap, dialogs that hold focus and give it back on Escape, a command menu that arms actions rather than running them, inbox verdicts that take two keys and only in the list, tooltips, controls that keep focus across their updates, a refresh that keeps an open editor, the first-run card, Readability and drafts.",
  run: async (scope) => {
    const world = await a11yFleet(scope, "keyboard-tour");
    const id = world.harness.id;
    let starts = 0;
    for (const theme of ["dark", "light"] as const) {
      const session = await scope.session(world.home, {
        label: `keyboard-tour-${theme}`,
        theme,
        viewport: { width: 1280, height: 800 },
        expectedStatuses: world.expectedStatuses,
      });
      await mockRefusals(session.page, id);
      session.page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith("/proc/start")
        ) {
          starts += 1;
        }
      });
      await skipLink(session);
      await tourEveryScreen(session, id, theme);
      if (theme === "dark") {
        await overlays(session, id);
        const before = starts;
        await commandMenu(session, () => starts - before);
        await tooltip(session);
        await panelsAndToggles(session, id);
        await keyedRefresh(session);
        await inbox(session, id);
        await firstRunAndReadability(session, id);
      }
      session.assertClean();
      await session.close();
    }
  },
};
