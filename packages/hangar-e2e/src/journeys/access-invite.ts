/**
 * Invites made the way an owner makes them: on Settings › Access, through the form a
 * person fills in, with the link read from the page once Home's sealed answer is opened.
 * Shared by the invite and roles journeys; not a journey itself.
 */
import type { Session } from "../session";
import { settle } from "../settle";

/** The roles the form offers, by the value the API takes. */
export type InviteRole = "viewer" | "operator" | "maintainer" | "owner";

/** Make an invite for `role` on one harness from the owner's Access page, and read its link. */
export async function inviteLink(
  owner: Session,
  role: InviteRole,
  harness: string,
): Promise<string> {
  const route = `#/settings/access?harness=${encodeURIComponent(harness)}`;
  await owner.visit(route);
  await settle(owner.page, route);
  const page = owner.page;
  await page.getByLabel("Role", { exact: true }).selectOption(role);
  await page.getByLabel("Where", { exact: true }).selectOption("harness");
  const target = page.getByLabel("Group or harness (when not all)");
  if ((await target.inputValue()) !== harness) {
    throw new Error(`the invite form names ${await target.inputValue()}, not ${harness}`);
  }
  const twin = await page
    .locator(".access-card code.twin-cmd")
    .filter({ hasText: "crewhaus access invite" })
    .first()
    .textContent();
  if (twin !== `crewhaus access invite --role ${role} --harness ${harness}`) {
    throw new Error(`the invite's command-line twin reads "${twin}"`);
  }
  await page.getByRole("button", { name: "Create invite link" }).click();
  const result = page.locator(".invite-result");
  const code = result.locator("code");
  await code.waitFor({ timeout: 10_000 });
  const said = (await result.locator("p").first().textContent()) ?? "";
  if (!said.startsWith("Send this link to them. It works once, until ")) {
    throw new Error(`the invite says "${said}"`);
  }
  const link = ((await code.textContent()) ?? "").trim();
  if (!/\/invite#c=[A-Za-z0-9_-]+$/.test(link)) throw new Error(`the invite link is "${link}"`);
  return link;
}
