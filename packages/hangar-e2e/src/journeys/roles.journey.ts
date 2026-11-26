/**
 * What a member's role lets them see and do, in a browser:
 *
 * - a viewer of one harness sees its header's controls disabled, each with the reason
 *   as text beside it;
 * - an operator of one harness sees nothing of another harness: not in the harness
 *   list, not in Home's status line, not in search, not among the command menu's
 *   controls and not in Spend; and the controls of their own harness are theirs to use.
 */
import { HARNESSES_ROUTE, HOME_ROUTE, routeFor } from "../console-routes";
import type { Session } from "../session";
import { waitFor } from "./a11y-states";
import { inviteLink } from "./access-invite";
import type { Journey } from "./journey";

/** Type a query into the command menu and read every row it shows, then close it. */
async function menuRows(session: Session, query: string): Promise<string[]> {
  const page = session.page;
  await page.locator(".omni-open").first().click();
  await waitFor(page, "dialog.omni-panel[open]", "the command menu");
  await page.getByRole("combobox", { name: "Search the fleet" }).fill(query);
  // Either rows or "Nothing matches" arrive once the search answers.
  await page.waitForFunction(
    () =>
      document.querySelector("dialog.omni-panel[open] .omni-row") !== null ||
      document
        .querySelector("dialog.omni-panel[open] .omni-status")
        ?.textContent?.includes("Nothing matches") === true,
    undefined,
    { timeout: 10_000 },
  );
  const rows = await page.locator("dialog.omni-panel[open] .omni-row").allTextContents();
  await page.keyboard.press("Escape");
  return rows;
}

export const roles: Journey = {
  id: "roles",
  shard: "smoke",
  proves:
    "A viewer of a harness sees its controls disabled with the reason as text; an operator of one harness sees nothing of another in the harness list, Home's status line, search, the command menu's controls or Spend, and may use their own harness's controls.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "roles", shapes: ["cli", "channel"] });
    const [a, b] = fleet.harnesses;
    if (a === undefined || b === undefined) throw new Error("the fleet needs two harnesses");
    const home = scope.home(fleet);
    const owner = await scope.session(home);
    const viewerLink = await inviteLink(owner, "viewer", a.id);
    const operatorLink = await inviteLink(owner, "operator", a.id);
    const overview = routeFor("#/h/:id", a);

    // A viewer: the controls are there, disabled, and say why.
    const viewer = await scope.session(home, { invite: { link: viewerLink, name: "Vee" } });
    await viewer.visit(overview);
    await waitFor(viewer.page, ".harness-controls", "the harness's controls");
    const pause = viewer.page
      .locator(".harness-controls")
      .getByRole("button", { name: "Pause new work", exact: true });
    if (!(await pause.isDisabled())) throw new Error("a viewer may press Pause new work");
    const reason = await viewer.page
      .locator(".harness-controls .control-row")
      .filter({ has: viewer.page.getByRole("button", { name: "Pause new work", exact: true }) })
      .textContent();
    if (!reason?.includes("Needs Operator: ask an owner")) {
      throw new Error(`a viewer's disabled pause says "${reason}"`);
    }

    // An operator of A: nothing of B anywhere.
    const operator = await scope.session(home, { invite: { link: operatorLink, name: "Opal" } });
    await operator.visit(HARNESSES_ROUTE);
    const list = operator.page.locator("table.fleet");
    await list.getByText(a.specName, { exact: true }).first().waitFor({ timeout: 10_000 });
    if ((await list.getByText(b.specName, { exact: true }).count()) !== 0) {
      throw new Error(`an operator of ${a.specName} sees ${b.specName} in the harness list`);
    }

    await operator.visit(HOME_ROUTE);
    await operator.page
      .locator(".home-status")
      .getByText("1 harness", { exact: true })
      .waitFor({ timeout: 10_000 });

    const found = await menuRows(operator, b.specName);
    if (found.some((row) => row.includes(b.specName))) {
      throw new Error(`search shows ${b.specName} to an operator of ${a.specName}: ${found}`);
    }
    const controls = (await menuRows(operator, "pause fleet")).filter((row) =>
      row.includes("Pause new work on"),
    );
    if (controls.length !== 1 || !controls[0]?.includes(a.specName)) {
      throw new Error(`the command menu offers these pauses: ${controls.join(" | ")}`);
    }

    await operator.visit("#/harnesses/spend");
    const spend = operator.page.locator("#view .page-body .table-scroll table tbody");
    await spend.getByText(a.specName).first().waitFor({ timeout: 10_000 });
    if ((await spend.getByText(b.specName).count()) !== 0) {
      throw new Error(`Spend shows ${b.specName} to an operator of ${a.specName}`);
    }

    await operator.visit(overview);
    const own = operator.page
      .locator(".harness-controls")
      .getByRole("button", { name: "Pause new work", exact: true });
    await own.waitFor({ timeout: 10_000 });
    if (await own.isDisabled()) throw new Error("an operator may not pause their own harness");
  },
};
