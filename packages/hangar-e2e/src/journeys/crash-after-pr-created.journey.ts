/**
 * The code host made the pull request and its answer was lost: the item reads "Checking
 * with GitHub…", Home's pass looks the pull request up by its branch, and the item then shows
 * the one pull request. Exactly one pull request was ever asked for.
 */
import { routeFor } from "../console-routes";
import { waitFor } from "./a11y-states";
import type { Journey } from "./journey";
import { STEWARD_TITLE, steward } from "./steward";

const HOME_ACTOR = { by: "sys:runtime", via: "system", role: "system" } as const;

export const crashAfterPrCreated: Journey = {
  id: "crash-after-pr-created",
  shard: "smoke",
  proves:
    'A publish whose pull request landed but whose answer was lost reads "Checking with GitHub…", is settled by looking the pull request up, never by making a second one, and the item then shows that one pull request.',
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "steward-crash", shapes: ["cli"] });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the fleet has no harness");
    const home = scope.home(fleet);
    await home.server.scheduler.idle();
    const s = await steward(harness.dir);
    scope.defer(() => s.stop());
    const out: string[] = [];

    s.fake.interruptNextCreate("error");
    const lost = await s.publish();
    if (!lost.ok || lost.state !== "unknown") {
      throw new Error(`the interrupted publish answered ${JSON.stringify(lost)}`);
    }
    const session = await scope.session(home);
    const { page } = session;
    const itemRoute = `${routeFor("#/h/:id/work/items", harness)}/${s.wi}`;
    await session.visit(itemRoute);
    await waitFor(page, "text=Checking with GitHub…", "the unconfirmed publish");
    if ((await page.getByRole("button", { name: "Retry publishing" }).count()) !== 0) {
      out.push("an unconfirmed publish offers Retry publishing");
    }

    const settled = await s.engine.settle(s.wi, { actor: HOME_ACTOR });
    if (settled?.state !== "done" || settled.pr !== 1) {
      out.push(`the lookup settled it as ${JSON.stringify(settled)}`);
    }
    await session.visit(routeFor("#/h/:id/work/items", harness));
    await session.visit(itemRoute);
    await waitFor(page, ".work-card", "the pull request's card");
    const card = await page.locator(".work-card").first().innerText();
    if (!card.includes(`PR #1 opened: ${STEWARD_TITLE}`)) out.push(`the card says "${card}"`);
    if ((await page.getByText("Checking with GitHub…").count()) !== 0) {
      out.push("the settled publish still says it is being checked");
    }
    if (s.creates() !== 1) out.push(`${s.creates()} pull requests were asked for`);

    if (out.length > 0) throw new Error(`a lost answer:\n  ${out.join("\n  ")}`);
    session.assertClean();
  },
};
