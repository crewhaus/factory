/**
 * The floor under the toured screens that axe does not measure: reflow at
 * 320 CSS px (the shell with its Menu open too), text spacing, the
 * accessibility tree of the shell — the header, a harness's section nav and
 * its sub-view list — and of each overlay, reduced motion from the system
 * and from Readability, and announcements that are polite for information
 * and assertive only for an error.
 */
import type { Page } from "playwright";
import { ariaSnapshot } from "../a11y/aria";
import type { A11yFinding } from "../a11y/finding";
import { TOURED_TEMPLATES } from "../a11y/gate";
import { reducedMotionFindings } from "../a11y/reduced-motion";
import { reflowFinding } from "../a11y/reflow";
import { textSpacingFindings } from "../a11y/text-spacing";
import { HOME_ROUTE, type RouteHarness, routeFor } from "../console-routes";
import type { Session } from "../session";
import { settle } from "../settle";
import {
  a11yFleet,
  freshVisit,
  mockRefusals,
  pressOnPage,
  resetOverlays,
  waitFor,
} from "./a11y-states";
import type { Journey } from "./journey";

/** The approvals inbox, where the announcements are heard. */
const APPROVALS = "#/home/needs-you?type=approvals";

const note = (out: string[], where: string, findings: readonly (A11yFinding | undefined)[]) => {
  for (const finding of findings) {
    if (finding !== undefined) out.push(`${where}: ${finding.rule}: ${finding.detail}`);
  }
};

/** A snapshot with no unnamed control, holding every line it must. */
async function snapshotHolds(
  page: Page,
  out: string[],
  where: string,
  selector: string,
  wants: readonly string[],
): Promise<void> {
  const { snapshot, findings } = await ariaSnapshot(page, selector);
  note(out, where, findings);
  for (const want of wants) {
    if (!snapshot.includes(want)) out.push(`${where}: the tree has no ${want}:\n${snapshot}`);
  }
}

async function overlaySnapshots(
  session: Session,
  harness: RouteHarness,
  out: string[],
): Promise<void> {
  const { page } = session;
  await freshVisit(session, HOME_ROUTE);
  await snapshotHolds(page, out, "the shell", "body", [
    'link "Skip to content"',
    'navigation "Main"',
    "main",
    'button "Search',
  ]);
  await snapshotHolds(page, out, "the header", "header", [
    'link "Home',
    'link "Harnesses"',
    'link "People"',
    'link "Connections"',
    'button "Help',
    'button "Settings',
  ]);
  await snapshotHolds(page, out, "the page heading", "main", ['heading "Home" [level=1]']);
  await page.locator('button[aria-controls="settings-menu"]').click();
  await waitFor(page, "#settings-menu .menu-link", "the Settings list");
  await snapshotHolds(page, out, "the Settings list", "#settings-menu", [
    'link "Readability"',
    'link "Your account"',
    'button "Theme',
  ]);
  await resetOverlays(page);

  await freshVisit(session, routeFor("#/h/:id/setup/spec", harness));
  await snapshotHolds(page, out, "the section nav", 'nav[aria-label="Harness sections"]', [
    'navigation "Harness sections"',
    'link "Overview"',
    'link "Work"',
    'link "Quality"',
    'link "Knowledge"',
    'link "Setup"',
  ]);
  await snapshotHolds(page, out, "the sub-view list", 'nav[aria-label="Setup views"]', [
    'navigation "Setup views"',
    'heading "What it does"',
    'link "Spec"',
    'heading "What it uses"',
    'link "Files"',
  ]);

  await pressOnPage(page, "/");
  await waitFor(page, "dialog.omni-panel[open]", "the command menu");
  await page.keyboard.type("fleet");
  await waitFor(page, '[role="option"]', "a result");
  await snapshotHolds(page, out, "the command menu", "dialog[open]", [
    'dialog "Search the fleet"',
    'combobox "Search the fleet"',
    "listbox",
    "option",
  ]);
  await resetOverlays(page);

  await pressOnPage(page, "?");
  await waitFor(page, "dialog.sheet[open]", "the bindings sheet");
  await snapshotHolds(page, out, "the bindings sheet", "dialog[open]", [
    'dialog "Keyboard"',
    'heading "Keyboard"',
    'button "Close"',
  ]);
  await resetOverlays(page);

  await freshVisit(session, routeFor("#/h/:id", harness));
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await waitFor(page, "dialog[open] .refusal-list", "the refusal dialog");
  await snapshotHolds(page, out, "the refusal dialog", "dialog[open]", [
    'dialog "Preflight refused this start"',
    'button "Start anyway"',
    'button "Close"',
  ]);
  await resetOverlays(page);

  await freshVisit(session, routeFor("#/h/:id/setup/spec", harness));
  await page.getByRole("button", { name: "Pin to…" }).first().click();
  await waitFor(page, "dialog[open] input[placeholder]", "the typed confirm");
  await snapshotHolds(page, out, "the typed confirm", "dialog[open]", [
    "dialog",
    "textbox",
    'button "Cancel"',
  ]);
  await resetOverlays(page);

  await page.getByRole("button", { name: "View", exact: true }).first().click();
  await waitFor(page, "dialog[open] pre", "the view dialog");
  await snapshotHolds(page, out, "the view dialog", "dialog[open]", ["dialog", 'button "Close"']);
  await resetOverlays(page);

  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await waitFor(page, "dialog[open] .conflict", "the conflict view");
  await snapshotHolds(page, out, "the conflict view", "dialog[open]", [
    'dialog "This changed since you opened it"',
    'button "Re-apply my changes on top"',
    'button "Use the version on disk"',
    'button "Download my draft"',
  ]);
  await resetOverlays(page);
}

/** Hold the next request matching `pattern` while `then` runs, so a skeleton
 *  stays on screen. Not through `visit`, which waits for every request. */
async function withHeldRequest(
  session: Session,
  pattern: RegExp,
  route: string,
  then: () => Promise<void>,
): Promise<void> {
  const { page } = session;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (r) => {
    await held;
    await r.continue();
  });
  await page.evaluate((hash) => {
    globalThis.location.hash = hash;
  }, route);
  try {
    await waitFor(page, ".skel-line", "a skeleton while a request is held");
    await then();
  } finally {
    release();
    await page.unroute(pattern);
    await settle(page, route);
  }
}

async function reducedMotion(session: Session, out: string[]): Promise<void> {
  const { page } = session;
  const approvals = /\/api\/approvals(\?|$)/;
  const animations = () => page.evaluate(() => document.getAnimations().length);

  // The system's setting.
  await freshVisit(session, HOME_ROUTE);
  await withHeldRequest(session, approvals, APPROVALS, async () => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    if ((await animations()) === 0) {
      out.push("reduced motion: the skeleton does not animate at all, so no check below can fail");
    }
    note(out, "reduced motion (system)", await reducedMotionFindings(page));
  });

  // Readability's own switch, with the system asking for motion.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() =>
    localStorage.setItem("hangar.prefs", JSON.stringify({ v: 1, motion: "reduce" })),
  );
  await page.reload();
  await settle(page, "a reload");
  await freshVisit(session, HOME_ROUTE);
  await withHeldRequest(session, approvals, APPROVALS, async () => {
    if ((await page.evaluate(() => document.documentElement.dataset["motion"])) !== "reduce") {
      out.push("reduced motion (Readability): the choice did not reach the root element");
    }
    note(
      out,
      "reduced motion (Readability)",
      await reducedMotionFindings(page, { emulate: false }),
    );
  });
  await page.evaluate(() => localStorage.removeItem("hangar.prefs"));
  await page.reload();
  await settle(page, "a reload");
}

async function announcements(session: Session, out: string[]): Promise<void> {
  const { page } = session;
  const region = (which: string) => page.locator(`[data-live="${which}"]`);
  const waitText = async (which: string, text: string): Promise<boolean> => {
    for (let i = 0; i < 200; i += 1) {
      if (((await region(which).textContent()) ?? "").includes(text)) return true;
      await page.waitForTimeout(25);
    }
    return false;
  };
  await freshVisit(session, APPROVALS);
  await page.locator('.inbox-card[tabindex="0"] .inbox-actions button:text-is("Grant")').click();
  await waitFor(page, ".toast-info", "an information toast");
  if ((await page.locator(".toast[role=alert], .toast [role=alert]").count()) > 0) {
    out.push("an information toast is an alert");
  }
  if (!(await waitText("polite", "Granted")))
    out.push("an information toast was not said politely");
  if (((await region("assertive").textContent()) ?? "").includes("Granted")) {
    out.push("an information toast was said assertively");
  }
  await settle(page, "the inbox after a grant");

  // A write the server refuses is an error: assertive, and it stays.
  await page.route(DENY, (route) =>
    route.fulfill({ status: 400, contentType: "text/plain", body: "refused for this test" }),
  );
  await freshVisit(session, APPROVALS);
  await page.locator('.inbox-card[tabindex="0"] .inbox-actions button:text-is("Deny")').click();
  await waitFor(page, ".toast-error", "an error toast");
  if (!(await waitText("assertive", "Deny failed")))
    out.push("a failed write was not said assertively");
  if (
    (await page.locator('.toast-error button[aria-label="Dismiss this message"]').count()) !== 1
  ) {
    out.push("an error toast has no close button");
  }
  await page.unroute(DENY);
}

/** Every deny, answered with a refusal by the test itself. */
const DENY = /\/api\/h\/[^/]+\/approvals\/[^/]+\/deny$/;

export const a11yFloor: Journey = {
  id: "a11y-floor",
  shard: "axe",
  proves:
    "Every toured screen, and the shell's open Menu, reflows at 320 px and loses nothing under the text-spacing overrides; the header, a harness's section nav and sub-view list, the command menu and each overlay name every control and carry their roles; nothing animates under reduced motion from the system or from Readability; and information is announced politely, an error assertively.",
  run: async (scope) => {
    const world = await a11yFleet(scope, "a11y-floor");
    const id = world.harness.id;
    // The deny this journey refuses itself, for whichever row is selected.
    const expectedStatuses = [
      ...world.expectedStatuses,
      ...world.harness.approvalIds.map((approval) => ({
        pathname: `/api/h/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approval)}/deny`,
        status: 400,
      })),
    ];
    const out: string[] = [];

    // Reflow leaves the viewport at 320, so it has a session of its own.
    const narrow = await scope.session(world.home, {
      label: "a11y-floor-reflow",
      viewport: { width: 320, height: 800 },
    });
    for (const template of TOURED_TEMPLATES) {
      await freshVisit(narrow, routeFor(template, world.harness));
      note(out, `${template} at 320`, [await reflowFinding(narrow.page)]);
    }
    // The shell's Menu, open, reflows too.
    await freshVisit(narrow, HOME_ROUTE);
    await narrow.page.locator("button.menu-toggle").click();
    await waitFor(narrow.page, "#narrow-menu .menu-link", "the Menu at 320");
    note(out, "the open Menu at 320", [await reflowFinding(narrow.page)]);
    narrow.assertClean();
    await narrow.close();

    const session = await scope.session(world.home, {
      label: "a11y-floor",
      viewport: { width: 1280, height: 800 },
      expectedStatuses,
    });
    await mockRefusals(session.page, id);
    // Spacing is written onto every node: a reload before each screen starts
    // it from the page as served, where a visit would keep the spaced shell.
    for (const template of TOURED_TEMPLATES) {
      await freshVisit(session, routeFor(template, world.harness));
      await session.page.reload();
      await settle(session.page, template);
      note(out, `${template} text spacing`, await textSpacingFindings(session.page));
    }
    await session.page.reload();
    await settle(session.page, "a reload");
    await overlaySnapshots(session, world.harness, out);
    await reducedMotion(session, out);
    await announcements(session, out);
    session.assertClean();
    if (out.length > 0) throw new Error(`the accessibility floor broke:\n  ${out.join("\n  ")}`);
  },
};
