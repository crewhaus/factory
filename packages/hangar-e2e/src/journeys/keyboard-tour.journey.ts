/**
 * The console by keyboard alone: the skip link, a focus ring and no trap on
 * every toured screen, the header's Help and Settings lists and the narrow
 * Menu (Escape gives focus back), a harness's section nav and sub-view list,
 * dialogs that hold focus and give it back, the command menu as a combobox
 * whose armed action the keyboard can confirm, inbox verdicts that take two
 * keys and only while the list has focus, tooltips, controls that keep focus
 * across their own updates, a refresh that keeps an open editor, and the
 * Readability choices. Two edits that must not slip past a newer version
 * close it: a conflict asks for the typed confirmation again, and a restored
 * wiki draft saves against the version it was typed on. The sign-in screen is
 * toured too, and the dialog a session that ends mid-use opens keeps what is
 * typed into it and its focus while polls go on.
 */
import { join } from "node:path";
import { createWikiStore } from "@crewhaus/wiki-store";
import type { JSHandle, Page } from "playwright";
import type { A11yFinding } from "../a11y/finding";
import { TOURED_TEMPLATES } from "../a11y/gate";
import { dialogContainmentFinding, escapeFinding, focusTour } from "../a11y/keyboard";
import { HARNESSES_ROUTE, HOME_ROUTE, type RouteHarness, routeFor } from "../console-routes";
import type { HomeAddress, Session } from "../session";
import { settle } from "../settle";
import {
  a11yFleet,
  clearPrefs,
  conflictBody,
  freshVisit,
  mockRefusals,
  resetOverlays,
  setPrefs,
  showSignInScreen,
  waitFor,
} from "./a11y-states";
import type { Journey, JourneyScope } from "./journey";

const fail = (what: string): never => {
  throw new Error(what);
};

/** The addresses this tour uses, by what they are. */
const APPROVALS = "#/home/needs-you?type=approvals";
const REVIEW = "#/home/needs-you?type=review";
const CHANGES = "#/home/changes";

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

/** The sign-in screen by keyboard alone: focus starts on its heading, every control is
 *  reached with a visible ring and no trap, and a pasted key is refused from the keyboard. */
async function signInScreen(session: Session): Promise<void> {
  const { page } = session;
  await showSignInScreen(page);
  if (!(await activeMatches(page, "#sign-in-title"))) {
    fail("the sign-in screen did not put focus on its heading");
  }
  const tour = await focusTour(page);
  if (tour.reached < 3) fail(`Tab reached ${tour.reached} controls on the sign-in screen`);
  if (tour.findings.length > 0) {
    fail(
      `the sign-in screen's focus tour found:\n  ${tour.findings.map((f) => `${f.rule}: ${f.detail}`).join("\n  ")}`,
    );
  }
  await page.getByLabel("Sign-in link").focus();
  await page.keyboard.type("ab".repeat(32));
  await page.keyboard.press("Enter");
  await until(page, "the field to refuse Home's own key", async () =>
    (await page.locator(".sign-in-message").innerText()).includes("Home's own key"),
  );
}

/** A session that ends while the shell is open: the sign-in dialog comes up over the
 *  view, and the notification poll that keeps running underneath never redraws it, so
 *  what is typed into it and where focus is stay put. */
async function sessionEndsMidUse(session: Session): Promise<void> {
  const { page } = session;
  await page.clock.install();
  await session.visit(HARNESSES_ROUTE);
  await page.reload();
  await settle(page, "the harness list under a fake clock");
  // The session ends and the browser's key is gone, so signing in silently cannot work.
  await page.evaluate(async () => {
    sessionStorage.removeItem("hangar.session");
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("crewhaus-home");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });
  await page.clock.fastForward(31_000); // one notification poll, which meets a 401
  await waitFor(page, "dialog[open] #sign-in-link", "the sign-in dialog after the session ended");
  if (!(await activeWithin(page, "dialog[open]"))) fail("the sign-in dialog did not take focus");
  if ((await page.locator("#view .sign-in-card").count()) !== 0) {
    fail("the sign-in screen replaced the view instead of opening over it");
  }
  await page.getByLabel("Sign-in link").focus();
  await page.keyboard.type("half-typed");
  await page.clock.fastForward(61_000); // two more polls' worth
  await page.waitForTimeout(150);
  if ((await page.getByLabel("Sign-in link").inputValue()) !== "half-typed") {
    fail("what was typed into the sign-in link was lost while the dialog was up");
  }
  if (!(await activeMatches(page, "#sign-in-link"))) {
    fail("focus left the sign-in link while the dialog was up");
  }
  if ((await page.locator("dialog[open]").count()) !== 1) {
    fail("a second sign-in dialog opened while the first was up");
  }
  await page.keyboard.press("Escape");
  await until(
    page,
    "Escape to close the sign-in dialog",
    async () => (await page.locator("dialog[open]").count()) === 0,
  );
}

async function skipLink(session: Session): Promise<void> {
  const { page } = session;
  await freshVisit(session, HOME_ROUTE);
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

async function tourEveryScreen(
  session: Session,
  harness: RouteHarness,
  theme: string,
): Promise<void> {
  const findings: string[] = [];
  for (const template of TOURED_TEMPLATES) {
    await freshVisit(session, routeFor(template, harness));
    const tour = await focusTour(session.page);
    if (tour.reached === 0) findings.push(`${template} ${theme}: Tab reached nothing`);
    for (const finding of tour.findings) {
      findings.push(`${template} ${theme}: ${finding.rule}: ${finding.detail}`);
    }
  }
  if (findings.length > 0) fail(`the focus tour found:\n  ${findings.join("\n  ")}`);
}

/** The aria-expanded a disclosure's button says now. */
async function expanded(page: Page, button: string): Promise<string | null> {
  return await page.locator(button).getAttribute("aria-expanded");
}

/**
 * Make the header take a counts update now, through the console's own path:
 * the tab goes hidden and comes back, which restarts the notification poll,
 * and the poll's snapshot redraws the header's badges. Resolves once that
 * poll has answered and the page has had a frame to redraw.
 */
async function forceCountsUpdate(page: Page): Promise<void> {
  const answered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/notifications",
  );
  await page.evaluate(() => {
    const flip = (hidden: boolean) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    flip(true);
    flip(false);
    Reflect.deleteProperty(document, "hidden");
  });
  await answered;
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
  );
}

/** Open a header list from its button, by keyboard. */
async function openList(page: Page, button: string, panel: string): Promise<void> {
  await page.locator(button).focus();
  if ((await expanded(page, button)) !== "true") await page.keyboard.press("Enter");
  await until(page, `${panel} to open`, async () => (await expanded(page, button)) === "true");
}

/** An open list keeps its state, and the focus inside it, across a counts update. */
async function keepsAcrossCounts(page: Page, button: string, panel: string): Promise<void> {
  await openList(page, button, panel);
  const first = page.locator(`${panel} a`).first();
  await first.focus();
  const held = await first.elementHandle();
  if (held === null) return fail(`${panel} has no link to focus`);
  await forceCountsUpdate(page);
  if ((await expanded(page, button)) !== "true") fail(`a counts update closed ${panel}`);
  if (!(await activeIs(page, held))) fail(`a counts update moved focus out of ${panel}`);
  await page.keyboard.press("Escape");
  await until(page, `${panel} to close`, async () => (await expanded(page, button)) === "false");
}

/** Theme inside a list closes it and leaves focus on the list's button, never the body. */
async function themeKeepsFocus(page: Page, button: string, panel: string): Promise<void> {
  const theme = page.locator(`${panel} button.menu-link`, { hasText: "Theme" });
  const themeNow = () => page.evaluate(() => document.documentElement.dataset["theme"]);
  const before = await themeNow();
  for (const round of ["switch", "switch back"]) {
    await openList(page, button, panel);
    await theme.focus();
    await page.keyboard.press("Enter");
    await until(
      page,
      `Theme (${round}) in ${panel} to close it`,
      async () => (await expanded(page, button)) === "false",
    );
    if (!(await activeMatches(page, button))) fail(`Theme (${round}) in ${panel} dropped focus`);
    if (round === "switch" && (await themeNow()) === before) {
      fail(`Theme in ${panel} did not change the theme`);
    }
  }
}

/** Keyboard shortcuts inside a list: its sheet closes back onto the list's button. */
async function sheetReturnsFocus(page: Page, button: string, panel: string): Promise<void> {
  await openList(page, button, panel);
  await page.locator(`${panel} button.menu-link`, { hasText: "Keyboard shortcuts" }).focus();
  await page.keyboard.press("Enter");
  await waitFor(page, "dialog.sheet[open]", `Keyboard shortcuts in ${panel}`);
  await page.keyboard.press("Escape");
  await until(
    page,
    "the shortcuts sheet to close",
    async () => (await page.locator("dialog.sheet[open]").count()) === 0,
  );
  if (!(await activeMatches(page, button))) {
    fail(`closing the shortcuts sheet opened from ${panel} did not give focus back to its button`);
  }
}

/** The wide header's Settings and Help, past their open and close. */
async function settingsAndHelpItems(page: Page): Promise<void> {
  const settings = 'button[aria-controls="settings-menu"]';
  const help = 'button[aria-controls="help-menu"]';
  await keepsAcrossCounts(page, settings, "#settings-menu");
  await themeKeepsFocus(page, settings, "#settings-menu");
  await keepsAcrossCounts(page, help, "#help-menu");
  await sheetReturnsFocus(page, help, "#help-menu");
}

/**
 * The shell by keyboard alone. Each of the header's lists opens from its
 * button and says so; Escape closes it and gives focus back to the button;
 * Tab out of it closes it. A harness's section nav and sub-view list are
 * reached by Tab with the current ones marked, and Enter on a sub-view lands
 * on its page with focus on the page's heading.
 */
async function shellByKeyboard(session: Session, harness: RouteHarness): Promise<void> {
  const { page } = session;
  await freshVisit(session, HOME_ROUTE);
  for (const id of ["help-menu", "settings-menu"]) {
    const button = `button[aria-controls="${id}"]`;
    const list = page.locator(`#${id}`);
    await page.locator(button).focus();
    if ((await expanded(page, button)) !== "false") fail(`${id} starts open`);
    await page.keyboard.press("Enter");
    await until(page, `Enter to open ${id}`, async () => (await expanded(page, button)) === "true");
    if (!(await list.isVisible())) fail(`${id} says it is open and shows nothing`);
    await page.keyboard.press("Tab");
    if (!(await activeWithin(page, `#${id}`))) fail(`Tab from its button did not enter ${id}`);
    await page.keyboard.press("Escape");
    await until(
      page,
      `Escape to close ${id}`,
      async () => (await expanded(page, button)) === "false",
    );
    if (await list.isVisible()) fail(`${id} says it is closed and still shows`);
    if (!(await activeMatches(page, button))) fail(`Escape in ${id} did not give focus back`);
    // Tab past its last item closes it, without a key of its own.
    await page.keyboard.press("Enter");
    await until(page, `${id} to open again`, async () => (await expanded(page, button)) === "true");
    const items = await page.locator(`#${id} .menu-link`).count();
    for (let i = 0; i <= items; i += 1) await page.keyboard.press("Tab");
    await until(
      page,
      `Tab out of ${id} to close it`,
      async () => (await expanded(page, button)) === "false",
    );
  }
  // Settings holds Theme; Help holds Keyboard shortcuts.
  await freshVisit(session, HOME_ROUTE);
  await settingsAndHelpItems(page);

  await freshVisit(session, routeFor("#/h/:id/setup/spec", harness));
  const section = page.locator('nav[aria-label="Harness sections"] a[aria-current="page"]');
  if ((await section.textContent()) !== "Setup") fail("the section nav does not mark Setup");
  const sub = page.locator('nav[aria-label="Setup views"] a[aria-current="page"]');
  if ((await sub.textContent()) !== "Spec") fail("the sub-view list does not mark Spec");
  await page.locator('nav[aria-label="Harness sections"] a').first().focus();
  let reached = false;
  for (let i = 0; i < 12 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await activeWithin(page, 'nav[aria-label="Setup views"]');
  }
  if (!reached) fail("Tab from the section nav never reached the sub-view list");
  const before = await page.evaluate(() => globalThis.location.hash);
  await page.keyboard.press("Enter");
  await until(
    page,
    "Enter on a sub-view to open it",
    async () => (await page.evaluate(() => globalThis.location.hash)) !== before,
  );
  await settle(page, "a sub-view");
  if (!(await activeMatches(page, "h1#page-title"))) fail("the page's heading did not take focus");
}

/** The narrow Menu by keyboard: it opens, holds every destination, and Escape gives focus back. */
async function narrowMenu(scope: JourneyScope, home: HomeAddress): Promise<void> {
  const session = await scope.session(home, {
    label: "keyboard-tour-narrow",
    viewport: { width: 320, height: 640 },
  });
  const { page } = session;
  await freshVisit(session, HOME_ROUTE);
  if (await page.locator("nav.app-nav").isVisible()) fail("the wide nav shows at 320");
  const menu = "button.menu-toggle";
  await page.locator(menu).focus();
  await page.keyboard.press("Enter");
  await until(page, "Enter to open the Menu", async () => (await expanded(page, menu)) === "true");
  for (const label of ["Home", "Harnesses", "People", "Connections", "Readability"]) {
    if (!(await page.locator("#narrow-menu a", { hasText: label }).first().isVisible())) {
      fail(`the open Menu shows no ${label}`);
    }
  }
  await page.keyboard.press("Tab");
  if (!(await activeWithin(page, "#narrow-menu"))) fail("Tab from Menu did not enter it");
  await page.keyboard.press("Escape");
  await until(
    page,
    "Escape to close the Menu",
    async () => (await expanded(page, menu)) === "false",
  );
  if (!(await activeMatches(page, menu))) fail("Escape in the Menu did not give focus back");
  await keepsAcrossCounts(page, menu, "#narrow-menu");
  await themeKeepsFocus(page, menu, "#narrow-menu");
  await sheetReturnsFocus(page, menu, "#narrow-menu");
  session.assertClean();
  await session.close();
}

async function overlays(session: Session, harness: RouteHarness): Promise<void> {
  const { page } = session;
  const spec = routeFor("#/h/:id/setup/spec", harness);
  const overview = routeFor("#/h/:id", harness);
  const cases: Array<{ route: string; trigger: string; overlay: string; key?: string }> = [
    { route: overview, trigger: 'button:text-is("Start")', overlay: "dialog[open]" },
    { route: spec, trigger: 'button:text-is("Pin to…")', overlay: "dialog[open]" },
    { route: spec, trigger: 'button:text-is("View")', overlay: "dialog[open]" },
    { route: spec, trigger: 'button:text-is("Save")', overlay: "dialog[open]" },
    { route: HOME_ROUTE, trigger: "button.omni-open", overlay: "dialog.omni-panel[open]" },
    { route: HOME_ROUTE, trigger: "button.omni-open", overlay: "dialog.sheet[open]", key: "?" },
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
  await freshVisit(session, HOME_ROUTE);
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
  await freshVisit(session, HOME_ROUTE);
  await page.locator("button.omni-open").focus();
  await page.keyboard.press("Enter");
  await waitFor(page, "dialog.omni-panel[open]", "the command menu");
  await page.keyboard.type("start fleet");
  await waitFor(page, ".omni-action", "a proposed action");
  const armAction = async (): Promise<void> => {
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
  };
  await armAction();
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

  // …and the keyboard alone can confirm it: Tab reaches "Run it", Enter
  // presses it once. The start is answered with a refusal (mocked).
  await page.locator("button.omni-open").focus();
  await page.keyboard.press("Enter");
  await waitFor(page, "dialog.omni-panel[open]", "the command menu");
  await page.keyboard.type("start fleet");
  await waitFor(page, ".omni-action", "a proposed action");
  await armAction();
  // The confirm row's danger button is its "Run it".
  const runIt = ".omni-confirm-row button.btn-danger";
  for (let i = 0; i < 6 && !(await activeMatches(page, runIt)); i += 1) {
    await page.keyboard.press("Tab");
  }
  if (!(await activeMatches(page, runIt))) {
    const focus = await page.evaluate(
      () =>
        `<${document.activeElement?.tagName.toLowerCase()}> ${document.activeElement?.className}`,
    );
    fail(`Tab never reached the armed action's Run it (focus stayed on ${focus})`);
  }
  await page.keyboard.press("Enter");
  await until(page, "Enter on Run it to send one start", async () => starts() === 1);
  await until(
    page,
    "the menu to close after Run it",
    async () => (await page.locator("dialog.omni-panel[open]").count()) === 0,
  );
  if (starts() !== 1) fail(`Run it sent ${starts()} starts, not 1`);
}

async function inbox(session: Session, harness: RouteHarness): Promise<void> {
  const { page } = session;
  const grants = grantCounter(page);
  const row = '.inbox-card[tabindex="0"]';
  await freshVisit(session, APPROVALS);
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
  await freshVisit(session, routeFor("#/h/:id/setup/spec", harness));
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
  await freshVisit(session, HARNESSES_ROUTE);
  const trigger = page.locator("#view button[data-tip]").first();
  const handle = await trigger.elementHandle();
  if (handle === null) fail("no control on the harness list carries a tooltip");
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

async function panelsAndToggles(session: Session, harness: RouteHarness): Promise<void> {
  const { page } = session;
  await freshVisit(session, routeFor("#/h/:id/knowledge/memory", harness));
  await keepsFocus(
    page,
    'nav[aria-label="memory fabric panels"] button:text-is("Wiki")',
    "a memory panel",
  );
  await freshVisit(session, routeFor("#/h/:id/knowledge/thredz", harness));
  await keepsFocus(
    page,
    'nav[aria-label="thredz panels"] button:text-is("Records")',
    "a Thredz panel",
  );
  await freshVisit(session, CHANGES);
  await keepsFocus(page, '[aria-label="activity kinds"] button', "an activity kind toggle");
  await keepsFocus(
    page,
    '[aria-label="digest window"] button:has-text("7 days")',
    "the window toggle",
  );
  // The inboxes repaint their list on a toggle; the toggle itself is kept.
  await freshVisit(session, APPROVALS);
  await keepsFocus(page, 'button.toggle:has-text("Show settled")', "the Show settled toggle");
  await freshVisit(session, REVIEW);
  await keepsFocus(page, 'button.toggle:has-text("Show resolved")', "the Show resolved toggle");
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
  await session.visit("#/settings");
  // Not through `visit`, which waits for every request: one is being held.
  await page.evaluate((hash) => {
    globalThis.location.hash = hash;
  }, HARNESSES_ROUTE);
  await waitFor(
    page,
    'button[aria-label^="edit registry fields"]',
    "the harness list's first paint",
  );
  await page.locator('button[aria-label^="edit registry fields"]').first().click();
  const notes = page.locator('.editor-tr textarea[aria-label="notes"]');
  await waitFor(page, '.editor-tr textarea[aria-label="notes"]', "the row editor");
  await notes.focus();
  await page.keyboard.type("kept across the refresh");
  const handle = await notes.elementHandle();
  release();
  await settle(page, "the harness list refresh");
  await page.unroute(/\/api\/harnesses\?hydrate=1/);
  if ((await page.locator(".rollup").textContent())?.includes("refreshing") === true) {
    fail("the harness list never finished its refresh");
  }
  if ((await notes.count()) !== 1) fail("the refresh closed the open row editor");
  if ((await notes.inputValue()) !== "kept across the refresh")
    fail("the refresh lost what was typed");
  if (handle === null || !(await activeIs(page, handle)))
    fail("the refresh moved focus out of the editor");
}

async function firstRunAndReadability(session: Session, harness: RouteHarness): Promise<void> {
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
    "Adjust to land on Readability",
    async () => (await page.evaluate(() => globalThis.location.hash)) === "#/settings/readability",
  );
  await settle(page, "#/settings/readability");
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
  await freshVisit(session, routeFor("#/h/:id/overview/needs-you", harness));
  const title = page.locator('input[aria-label="issue title"]');
  await title.fill("the agent loops on a refusal");
  await title.dispatchEvent("input");
  await page.reload();
  await settle(page, "a reload");
  if ((await title.inputValue()) !== "the agent loops on a refusal")
    fail("the draft did not survive a reload");
}

/** The spec's own write route: a human-owned edit is a PUT to it. */
const specEditPath = (id: string): string => `/api/h/${encodeURIComponent(id)}/spec`;

/**
 * A typed confirmation holds for the version of the spec it was typed
 * against. When the write comes back as a conflict, "Re-apply my changes on
 * top" opens the typed dialog again over the new diff, and nothing is sent
 * until the name is typed again.
 */
async function conflictAsksAgain(session: Session, harness: RouteHarness): Promise<void> {
  const harnessId = harness.id;
  const { page } = session;
  let edits = 0;
  await page.route(`**${specEditPath(harnessId)}`, (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    edits += 1;
    return edits === 1
      ? route.fulfill({
          status: 412,
          contentType: "application/json",
          body: JSON.stringify(
            conflictBody("-  model: claude-opus-5\n+  model: claude-sonnet-5\n"),
          ),
        })
      : route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  try {
    await freshVisit(session, routeFor("#/h/:id/setup/spec", harness));
    const row = page.locator("tr", { has: page.locator("td.mono", { hasText: /^agent\.model$/ }) });
    await row.getByRole("button", { name: "Review & apply" }).click();
    const typed = "dialog[open] input[placeholder]";
    await waitFor(page, typed, "the typed confirm for a human-owned field");
    const name = (await page.locator(typed).getAttribute("placeholder")) ?? "";
    await page.locator(typed).fill(name);
    await page.locator('dialog[open] button:text-is("Apply to the live spec")').click();
    await waitFor(page, "dialog[open] .conflict", "the conflict view");
    if (edits !== 1) fail(`the typed apply sent ${edits} writes, not 1`);
    await page.locator('dialog[open] button:text-is("Re-apply my changes on top")').click();
    await waitFor(page, typed, "the typed confirm asked again after a conflict");
    await settle(page, "the diff against the version on disk");
    if (edits !== 1) fail(`Re-apply sent ${edits - 1} writes before the name was typed again`);
    if ((await page.locator(typed).inputValue()) !== "")
      fail("Re-apply reopened the typed confirm with the name already in it");
    if (!(await page.locator('dialog[open] button:text-is("Apply to the live spec")').isDisabled()))
      fail("Re-apply offered Apply before the name was typed again");
    await page.locator(typed).fill(name);
    await page.locator('dialog[open] button:text-is("Apply to the live spec")').click();
    await until(page, "the name typed again to send the write", async () => edits === 2);
    await settle(page, "the re-applied write");
  } finally {
    await page.unroute(`**${specEditPath(harnessId)}`);
    await resetOverlays(page);
  }
}

/**
 * An unsent wiki draft is saved against the version it was typed on. When
 * someone else wrote a newer version meanwhile, Save comes back stale and
 * the newer version stays on disk; it is never silently written over.
 */
async function wikiDraftAgainstNewer(scope: JourneyScope): Promise<void> {
  const fleet = await scope.fleet({ seed: "keyboard-tour-wiki", shapes: ["cli"], rich: true });
  const [harness] = fleet.harnesses;
  if (harness === undefined) fail("the wiki fleet has no harness");
  const h = harness as NonNullable<typeof harness>;
  const session = await scope.session(scope.home(fleet), { label: "keyboard-tour-wiki" });
  const { page } = session;
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && /\/memory\/wiki\//.test(new URL(request.url()).pathname)) {
      writes.push(JSON.parse(request.postData() ?? "{}"));
    }
  });
  const area = page.locator('textarea[aria-label="article body"]');
  const openEditor = async (): Promise<void> => {
    await freshVisit(session, routeFor("#/h/:id/knowledge/memory", h));
    await page
      .locator('nav[aria-label="memory fabric panels"] button', { hasText: "Wiki" })
      .click();
    await settle(page, "the wiki panel");
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await waitFor(page, 'textarea[aria-label="article body"]', "the wiki editor");
    await until(page, "the article to load", async () =>
      area.evaluate((node) => !(node as HTMLTextAreaElement).readOnly),
    );
  };
  await openEditor();
  await area.focus();
  await page.keyboard.press("End");
  await page.keyboard.type(" an unsent edit");
  const draft = await area.inputValue();
  await session.visit("#/");
  // Another writer lands a newer version while the draft waits.
  const wiki = createWikiStore({
    specName: h.specName,
    rootDir: join(h.dir, ".crewhaus", "wiki"),
  });
  const before = await wiki.get(h.wikiSlug);
  const theirs = "Someone else's newer body.";
  await wiki.write({
    slug: h.wikiSlug,
    title: before?.title ?? h.wikiSlug,
    body: theirs,
    tags: before?.tags ?? [],
    expectedVersion: before?.version ?? 1,
  });
  await openEditor();
  if ((await area.inputValue()) !== draft) fail("the unsent wiki draft was not restored");
  await waitFor(page, 'button:text-is("Discard draft")', "the restored-draft note");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await until(
    page,
    "the save to come back stale",
    async () => (await page.locator('button:has-text("Retry against version")').count()) > 0,
  );
  const sent = writes.at(-1) as { expectedVersion?: number } | undefined;
  if (sent?.expectedVersion !== before?.version) {
    fail(
      `the restored draft was saved against version ${sent?.expectedVersion}, not the ${before?.version} it was typed on`,
    );
  }
  const now = await wiki.get(h.wikiSlug);
  if (now?.body.trim() !== theirs || now.version !== (before?.version ?? 1) + 1) {
    fail(
      `a restored draft wrote over a newer version: on disk ${JSON.stringify(now?.body)} at version ${now?.version}`,
    );
  }
  session.assertClean();
  await session.close();
}

export const keyboardTour: Journey = {
  id: "keyboard-tour",
  shard: "axe",
  proves:
    "Every toured screen works by keyboard alone: a skip link first, a visible unobscured focus and no trap, the header's lists and the narrow Menu that close on Escape and give focus back, the section nav and sub-view list, dialogs that hold focus and give it back on Escape, a command menu that arms actions rather than running them and confirms them by keyboard, inbox verdicts that take two keys and only in the list, tooltips, controls that keep focus across their updates, a refresh that keeps an open editor, the first-run card, Readability and drafts; a conflict asks for a typed confirmation again, and a restored wiki draft never writes over a newer version.",
  run: async (scope) => {
    const world = await a11yFleet(scope, "keyboard-tour");
    const id = world.harness.id;
    let starts = 0;
    for (const theme of ["dark", "light"] as const) {
      const session = await scope.session(world.home, {
        label: `keyboard-tour-${theme}`,
        theme,
        viewport: { width: 1280, height: 800 },
        // The typed-confirm conflict is mocked here too.
        expectedStatuses: [
          ...world.expectedStatuses,
          { pathname: specEditPath(id), status: 412 },
          // The poll that meets the session ended mid-use.
          { pathname: "/api/notifications", status: 401 },
        ],
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
      await tourEveryScreen(session, world.harness, theme);
      if (theme === "dark") {
        await shellByKeyboard(session, world.harness);
        await overlays(session, world.harness);
        const before = starts;
        await commandMenu(session, () => starts - before);
        await tooltip(session);
        await panelsAndToggles(session, world.harness);
        await keyedRefresh(session);
        await inbox(session, world.harness);
        await firstRunAndReadability(session, world.harness);
        await conflictAsksAgain(session, world.harness);
        // Last: these leave the tab signed out.
        await sessionEndsMidUse(session);
        await signInScreen(session);
      }
      session.assertClean();
      await session.close();
    }
    await narrowMenu(scope, world.home);
    await wikiDraftAgainstNewer(scope);
  },
};
