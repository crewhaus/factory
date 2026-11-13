/**
 * What the accessibility journeys share: a fleet with everything the gated
 * screens show, the two answers no server gives here (a start refusal and a
 * spec conflict, mocked with `page.route`), and how to bring each screen to
 * each of its states. A route's first paint is not its whole UI, so the
 * states are swept too.
 */
import type { Page } from "playwright";
import { type FakeThredz, fakeThredz } from "service-fakes";
import type { Home } from "../boot";
import { HARNESSES_ROUTE, HOME_ROUTE, type RouteHarness, routeFor } from "../console-routes";
import type { Fleet, SeededHarness } from "../seed/fleet";
import type { ExpectedStatus, Session } from "../session";
import { settle } from "../settle";
import type { JourneyScope } from "./journey";

/** Every list a Thredz panel reads, answered empty, so each panel renders. */
const THREDZ_PANEL_ROUTES = {
  "GET /wiki/articles": { status: 200, body: { articles: [] } },
  "GET /records": { status: 200, body: { records: [] } },
  "GET /schemas": { status: 200, body: { schemas: [] } },
  "GET /goals": { status: 200, body: { goals: [] } },
  "GET /tasks": { status: 200, body: { tasks: [] } },
  "GET /views": { status: 200, body: { views: [] } },
  "GET /dashboards": { status: 200, body: { dashboards: [] } },
  "GET /listeners": { status: 200, body: { listeners: [] } },
  "GET /listeners/events": { status: 200, body: { events: [] } },
  "GET /webhooks": { status: 200, body: { webhooks: [] } },
  "GET /webhooks/deliveries": { status: 200, body: { deliveries: [] } },
  "GET /connectors": { status: 200, body: { connectors: [] } },
  "GET /activity": { status: 200, body: { items: [] } },
  "GET /wiki/audit": { status: 200, body: { entries: [] } },
  "GET /keys": { status: 200, body: { keys: [] } },
  "GET /wiki/access": { status: 200, body: { grants: [] } },
} as const;

export type A11yFleet = {
  readonly fleet: Fleet;
  readonly home: Home;
  readonly harness: SeededHarness;
  readonly thredz: FakeThredz;
  /** The statuses the mocks below answer, for `openSession`. */
  readonly expectedStatuses: readonly ExpectedStatus[];
};

/** A rich one-harness fleet wired to a fake Thredz that answers every panel. */
export async function a11yFleet(scope: JourneyScope, seed: string): Promise<A11yFleet> {
  const thredz = fakeThredz({ routes: THREDZ_PANEL_ROUTES });
  scope.defer(() => thredz.stop());
  // Built from parts, and only ever sent to the loopback fake.
  const key = ["thz", "e2e", "a11y0123456789ab"].join("_");
  const fleet = await scope.fleet({
    seed,
    shapes: ["cli"],
    rich: true,
    specExtra: ["thredz:", "  api_key: $THREDZ_API_KEY", `  base_url: ${thredz.baseUrl}`].join(
      "\n",
    ),
    envLines: [`THREDZ_API_KEY=${key}`],
  });
  const [harness] = fleet.harnesses;
  if (harness === undefined) throw new Error("the accessibility fleet has no harness");
  const home = scope.home(fleet);
  return {
    fleet,
    home,
    harness,
    thredz,
    expectedStatuses: [
      { pathname: startPath(harness.id), status: 409 },
      { pathname: specPatchPath(harness.id), status: 412 },
      // The sign-in screen first asks whether Home answers this tab with no
      // credential at all (a trusted proxy, or --no-auth); this one does not.
      { pathname: "/api/version", status: 401 },
    ],
  };
}

const startPath = (id: string): string => `/api/h/${encodeURIComponent(id)}/proc/start`;
const specPatchPath = (id: string): string => `/api/h/${encodeURIComponent(id)}/spec/patch`;

/** A preflight refusal, as `POST /proc/start` answers one. */
export const REFUSAL_BODY = {
  reason: "preflight-blocked",
  refused: [
    {
      id: "env-missing",
      area: "env",
      level: "blocking",
      message: "A variable the spec reads is not set.",
      remediation: "Set it in this harness's .env file.",
      acknowledgeable: true,
    },
  ],
  unforceable: [],
};

/** A spec conflict, as a revision-guarded write answers one. */
export function conflictBody(diff: string): unknown {
  return { error: "the spec changed on disk", current: { rev: "r2", diff } };
}

/**
 * Answer the start refusal and the spec conflict for this harness. Installed
 * before any visit, so every click that reaches them is answered here.
 */
export async function mockRefusals(
  page: Page,
  harnessId: string,
  opts: { readonly diff?: string; readonly refusal?: unknown } = {},
): Promise<void> {
  await page.route(`**${startPath(harnessId)}`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify(opts.refusal ?? REFUSAL_BODY),
    }),
  );
  await page.route(`**${specPatchPath(harnessId)}`, (route) =>
    route.fulfill({
      status: 412,
      contentType: "application/json",
      body: JSON.stringify(conflictBody(opts.diff ?? "-  temperature: 0.2\n+  temperature: 0.7\n")),
    }),
  );
}

/** Wait until `selector` matches something visible, or fail naming it. */
export async function waitFor(page: Page, selector: string, what: string): Promise<void> {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    throw new Error(`${what}: nothing visible matches ${selector}`);
  }
}

/** Close every open dialog and tooltip, so the next state starts clean. */
export async function resetOverlays(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // A dialog's `close` event, and the focus it gives back, come a task
    // later: wait for each one before the next state starts.
    const closed = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].map(
      (dialog) =>
        new Promise<void>((resolve) => {
          dialog.addEventListener("close", () => setTimeout(resolve, 0), { once: true });
          setTimeout(resolve, 1_000);
          dialog.close();
        }),
    );
    await Promise.all(closed);
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
}

/** Press a key with nothing focused, the way a key from the page itself arrives. */
export async function pressOnPage(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press(key);
}

/** The memory fabric's and the Thredz tab's panels, as the screens name them. */
export const MEMORY_PANELS = [
  "Facts",
  "Continuity",
  "Wiki",
  "Dream",
  "Watchme",
  "Learning",
  "Knowledge",
] as const;
export const THREDZ_PANELS = [
  "Wiki",
  "Records",
  "Goals & tasks",
  "Views & dashboards",
  "Automations",
  "Graph",
  "Keys",
] as const;

/** The sign-in screen has no route of its own: it is what a tab with nothing shows. */
export const SIGN_IN_TEMPLATE = "#/sign-in";

/**
 * Bring a signed-in tab to the sign-in screen: drop its session, forget its key, and
 * reload. Leaves the tab signed out, so it comes last in anything that uses it.
 */
export async function showSignInScreen(page: Page): Promise<void> {
  await page.evaluate(async () => {
    sessionStorage.removeItem("hangar.session");
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("crewhaus-home");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });
  await page.reload();
  await waitFor(page, "#sign-in-title", "the sign-in screen");
  await settle(page, "the sign-in screen");
}

export type ScreenState = {
  /** The gated template the state belongs to. */
  readonly template: string;
  /** A short name: the row is `<template>><state>`. */
  readonly state: string;
  /** The route to visit before opening it. */
  readonly route: string;
  /** Bring the screen to the state. */
  open(page: Page): Promise<void>;
};

/** Every state the sweep covers, for one harness. */
export function screenStates(harness: RouteHarness): readonly ScreenState[] {
  const h = (template: string): string => routeFor(template, harness);
  const panel = (nav: string, label: string) => async (page: Page) => {
    await page.locator(`nav[aria-label="${nav}"] button`, { hasText: label }).first().click();
    await settle(page, `${nav} ${label}`);
    await waitFor(page, `nav[aria-label="${nav}"] [aria-current="true"]`, label);
  };
  const states: ScreenState[] = [
    {
      template: HOME_ROUTE,
      state: "bindings sheet",
      route: HOME_ROUTE,
      open: async (page) => {
        await pressOnPage(page, "?");
        await waitFor(page, "dialog.sheet[open]", "the bindings sheet");
      },
    },
    {
      template: HOME_ROUTE,
      state: "command menu empty",
      route: HOME_ROUTE,
      open: async (page) => {
        await pressOnPage(page, "/");
        await waitFor(page, "dialog.omni-panel[open]", "the command menu");
      },
    },
    {
      template: HOME_ROUTE,
      state: "command menu results",
      route: HOME_ROUTE,
      open: async (page) => {
        await pressOnPage(page, "/");
        await page.keyboard.type("fleet");
        await waitFor(page, '[role="option"]', "a search result");
      },
    },
    {
      template: HOME_ROUTE,
      state: "command menu armed action",
      route: HOME_ROUTE,
      open: async (page) => {
        await pressOnPage(page, "/");
        await page.keyboard.type("start fleet");
        await waitFor(page, ".omni-action", "a proposed action");
        await page.locator(".omni-action").first().click();
        await waitFor(page, ".omni-confirm-row", "the action's confirm row");
      },
    },
    {
      template: HOME_ROUTE,
      state: "header list open",
      route: HOME_ROUTE,
      // Help on a wide screen; the Menu, which holds the destinations, Settings
      // and Help, on a narrow one.
      open: async (page) => {
        const narrow = await page.evaluate(() => globalThis.innerWidth < 720);
        await page
          .locator(narrow ? "button.menu-toggle" : 'button[aria-controls="help-menu"]')
          .click();
        await waitFor(
          page,
          narrow ? "#narrow-menu .menu-link" : "#help-menu .menu-link",
          "the open header list",
        );
      },
    },
    {
      template: HOME_ROUTE,
      state: "settings list open",
      route: HOME_ROUTE,
      open: async (page) => {
        const narrow = await page.evaluate(() => globalThis.innerWidth < 720);
        await page
          .locator(narrow ? "button.menu-toggle" : 'button[aria-controls="settings-menu"]')
          .click();
        await waitFor(
          page,
          narrow ? "#narrow-menu .menu-link" : "#settings-menu .menu-link",
          "the open settings list",
        );
      },
    },
    {
      template: "#/h/:id/setup",
      state: "sub-view list open",
      route: h("#/h/:id/setup"),
      // A disclosure on a narrow screen, a rail on a wide one: open it if it folds.
      open: async (page) => {
        const toggle = page.locator("button.subview-toggle");
        if (await toggle.isVisible()) await toggle.click();
        await waitFor(page, ".subview-list .subview-link", "the sub-view list");
      },
    },
    {
      template: HARNESSES_ROUTE,
      state: "tooltip open",
      route: HARNESSES_ROUTE,
      open: async (page) => {
        await page.locator("#view button[data-tip]").first().focus();
        await waitFor(page, ".tip", "the tooltip");
      },
    },
    {
      template: "#/home/needs-you?type=approvals",
      state: "row armed",
      route: "#/home/needs-you?type=approvals",
      open: async (page) => {
        await page.locator(".inbox-card").first().focus();
        await page.keyboard.press("g");
        await waitFor(page, ".inbox-armed", "the armed prompt");
      },
    },
    {
      template: "#/home/needs-you?type=approvals",
      state: "row menu",
      route: "#/home/needs-you?type=approvals",
      open: async (page) => {
        await page.locator(".inbox-card").first().focus();
        await page.keyboard.press(".");
        await waitFor(page, ".rowmenu button", "the row menu");
      },
    },
    {
      template: "#/home/needs-you?type=approvals",
      state: "inbox help",
      route: "#/home/needs-you?type=approvals",
      open: async (page) => {
        await page.locator(".inbox-card").first().focus();
        await page.keyboard.press("?");
        await waitFor(page, ".keyhelp li", "the inbox help");
      },
    },
    {
      template: "#/home/changes",
      state: "a kind off",
      route: "#/home/changes",
      open: async (page) => {
        await page
          .locator('[aria-label="activity kinds"] button[aria-pressed="true"]')
          .first()
          .click();
        await waitFor(
          page,
          '[aria-label="activity kinds"] button[aria-pressed="false"]',
          "a kind off",
        );
      },
    },
    {
      template: "#/home/changes",
      state: "every kind off",
      route: "#/home/changes",
      open: async (page) => {
        const on = page.locator('[aria-label="activity kinds"] button[aria-pressed="true"]');
        while ((await on.count()) > 0) await on.first().click();
        await waitFor(page, '[data-cause="filtered"]', "the filtered empty state");
      },
    },
    {
      template: "#/h/:id/overview/needs-you",
      state: "why this matters open",
      route: h("#/h/:id/overview/needs-you"),
      open: async (page) => {
        await page.locator("summary", { hasText: "Why this matters" }).first().click();
        await waitFor(page, "details[open] .adv-explain", "the open disclosure");
      },
    },
    {
      template: "#/h/:id/setup/spec",
      state: "value dialog",
      route: h("#/h/:id/setup/spec"),
      open: async (page) => {
        await page.getByRole("button", { name: "Edit any path…" }).click();
        await waitFor(page, "dialog[open] textarea", "the value dialog");
      },
    },
    {
      template: "#/h/:id/setup/spec",
      state: "typed confirm",
      route: h("#/h/:id/setup/spec"),
      open: async (page) => {
        await page.getByRole("button", { name: "Pin to…" }).first().click();
        await waitFor(page, "dialog[open] input[placeholder]", "the typed confirm");
      },
    },
    {
      template: "#/h/:id/setup/spec",
      state: "view dialog",
      route: h("#/h/:id/setup/spec"),
      open: async (page) => {
        await page.getByRole("button", { name: "View", exact: true }).first().click();
        await settle(page, "the view dialog");
        await waitFor(page, "dialog[open] pre", "the view dialog");
      },
    },
    {
      template: "#/h/:id/setup/spec",
      state: "conflict view",
      route: h("#/h/:id/setup/spec"),
      open: async (page) => {
        await page.getByRole("button", { name: "Save", exact: true }).first().click();
        await waitFor(page, "dialog[open] .conflict", "the conflict view");
      },
    },
    {
      template: "#/h/:id",
      state: "refusal dialog",
      route: h("#/h/:id"),
      open: async (page) => {
        await page.getByRole("button", { name: "Start", exact: true }).first().click();
        await waitFor(page, "dialog[open] .refusal-list", "the refusal dialog");
      },
    },
  ];
  for (const label of MEMORY_PANELS) {
    states.push({
      template: "#/h/:id/knowledge/memory",
      state: `panel ${label}`,
      route: h("#/h/:id/knowledge/memory"),
      open: panel("memory fabric panels", label),
    });
  }
  for (const label of THREDZ_PANELS) {
    states.push({
      template: "#/h/:id/knowledge/thredz",
      state: `panel ${label}`,
      route: h("#/h/:id/knowledge/thredz"),
      open: panel("thredz panels", label),
    });
  }
  for (const [state, prefs] of [
    ["text size larger", { textSize: "larger" }],
    ["more contrast", { contrast: "more" }],
    ["compact density", { density: "compact" }],
  ] as const) {
    states.push({
      template: HARNESSES_ROUTE,
      state,
      route: HARNESSES_ROUTE,
      open: async (page) => {
        await setPrefs(page, prefs);
        await waitFor(page, "table.fleet tbody.row-group", "the harness list after a reload");
      },
    });
  }
  // Last: they leave the tab signed out.
  states.push({
    template: SIGN_IN_TEMPLATE,
    state: "first paint",
    route: HOME_ROUTE,
    open: showSignInScreen,
  });
  states.push({
    template: SIGN_IN_TEMPLATE,
    state: "a link refused",
    route: HOME_ROUTE,
    open: async (page) => {
      await showSignInScreen(page);
      await page.getByLabel("Sign-in link").fill("not a link");
      await page.getByLabel("Sign-in link").press("Enter");
      await waitFor(page, ".sign-in-message strong", "the refusal on the sign-in screen");
    },
  });
  return states;
}

/** Store exactly these Readability choices (the rest default) and reload,
 *  so the page boots with them. */
export async function setPrefs(
  page: Page,
  prefs: Readonly<Record<string, unknown>>,
): Promise<void> {
  await page.evaluate((patch) => {
    localStorage.setItem("hangar.prefs", JSON.stringify({ v: 1, ...patch }));
  }, prefs);
  await page.reload();
  await settle(page, "a reload");
}

/** Leave the Readability choices as a fresh device has them, and reload. */
export async function clearPrefs(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.removeItem("hangar.prefs"));
  await page.reload();
  await settle(page, "a reload");
}

/** Show `route` freshly drawn: a visit, or a reload when the page is on it
 *  already (setting the same hash changes nothing). */
export async function freshVisit(session: Session, route: string): Promise<void> {
  const here = await session.page.evaluate(() => globalThis.location.hash);
  if (here === route) {
    await session.page.reload();
    await settle(session.page, route);
  } else await session.visit(route);
}

/** Visit a route, bring it to a state, and leave the session on it. */
export async function enterState(session: Session, state: ScreenState): Promise<void> {
  await resetOverlays(session.page);
  await freshVisit(session, state.route);
  await state.open(session.page);
  await settle(session.page, `${state.template} ${state.state}`);
}
