/**
 * An owner invites someone to one harness, and they join:
 *
 * - the owner makes the invite on Settings › Access, which shows the link once with the
 *   sentence that says it works once, and the command that does the same in a terminal;
 * - a second browser opens the link, types a name and lands in Home, where the harness
 *   list holds the harness the invite named and no other;
 * - the same link opened again is refused on the join screen, and makes no member.
 */
import { HARNESSES_ROUTE } from "../console-routes";
import { openPlainPage } from "../session";
import { inviteLink } from "./access-invite";
import type { Journey } from "./journey";

export const invite: Journey = {
  id: "invite",
  shard: "smoke",
  proves:
    "An owner's invite to one harness is shown once as a link; a second browser joins from it with a name and sees only that harness; the link opened again is refused and makes no member.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "invite", shapes: ["cli", "channel"] });
    const [a, b] = fleet.harnesses;
    if (a === undefined || b === undefined) throw new Error("the fleet needs two harnesses");
    const home = scope.home(fleet);
    const owner = await scope.session(home);
    const link = await inviteLink(owner, "operator", a.id);

    // A second browser joins, and lands in the scope the invite granted.
    const joined = await scope.session(home, { invite: { link, name: "Ira" } });
    await joined.visit(HARNESSES_ROUTE);
    const list = joined.page.locator("table.fleet");
    await list.getByText(a.specName, { exact: true }).first().waitFor({ timeout: 10_000 });
    if ((await list.getByText(b.specName, { exact: true }).count()) !== 0) {
      throw new Error(`a member invited to ${a.specName} sees ${b.specName}`);
    }

    // The link works once. A refused join logs its 4xx, so this browser is a plain page.
    const again = await openPlainPage();
    scope.defer(() => again.close());
    await again.page.goto(link);
    await again.page.getByRole("heading", { name: "Join Home" }).waitFor({ timeout: 10_000 });
    await again.page.getByLabel("Your name").fill("Ira again");
    await again.page.getByRole("button", { name: "Join Home" }).click();
    await again.page.locator('.sign-in-message[data-kind="error"]').waitFor({ timeout: 10_000 });
    if ((await again.page.getByRole("heading", { name: "Join Home" }).count()) !== 1) {
      throw new Error("a spent invite left the join screen");
    }

    // The owner's members list holds one new member, not two.
    await owner.visit("#/settings/access");
    const members = owner.page.locator(".access-card table tbody tr");
    await members.first().waitFor({ timeout: 10_000 });
    const names = await members.allTextContents();
    const iras = names.filter((row) => row.includes("Ira")).length;
    if (iras !== 1)
      throw new Error(`the members list names Ira ${iras} times: ${names.join(" | ")}`);
  },
};
