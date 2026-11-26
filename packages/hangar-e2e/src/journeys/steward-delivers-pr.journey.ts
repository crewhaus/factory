/**
 * A steward delivers an accepted work item as a pull request, and the console follows it:
 * the item reads "In review" with its card "PR #1 opened: <title>", the Work list names the
 * pull request, and once a maintainer merges it the item reads "Merged". Axe runs on the
 * item page in both states, and with the judge's long one-line reasons unfolded the page
 * still reflows at 320 px.
 */
import { runAxe } from "../a11y/axe";
import { reflowFinding } from "../a11y/reflow";
import { routeFor } from "../console-routes";
import { waitFor } from "./a11y-states";
import type { Journey } from "./journey";
import { STEWARD_REPO, STEWARD_TITLE, steward } from "./steward";

export const stewardDeliversPr: Journey = {
  id: "steward-delivers-pr",
  shard: "smoke",
  proves:
    'An accepted item delivered by its harness is one pull request on the code host; the item page shows its card and "In review", the Work list names the pull request, a merge reads "Merged" once Home\'s tracker looks, and the item page has no axe violation in either state.',
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "steward", shapes: ["cli"] });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the fleet has no harness");
    const home = scope.home(fleet);
    await home.server.scheduler.idle();
    const s = await steward(harness.dir);
    scope.defer(() => s.stop());
    const out: string[] = [];

    // A judge's reasons are usually one long line, with a path that has no place to break.
    const rationale = `${"The export now rounds every currency amount half to even, as the item asks. ".repeat(12)}See src/${"rounding-".repeat(30)}helpers.ts.`;
    const published = await s.publish(rationale);
    if (!published.ok || published.state !== "done" || published.pr !== 1) {
      throw new Error(`the publish answered ${JSON.stringify(published)}`);
    }
    const session = await scope.session(home);
    const { page } = session;
    const itemRoute = `${routeFor("#/h/:id/work/items", harness)}/${s.wi}`;

    await session.visit(itemRoute);
    await waitFor(page, ".work-card", "the pull request's card");
    const card = await page.locator(".work-card").first().innerText();
    if (!card.includes(`PR #1 opened: ${STEWARD_TITLE}`)) out.push(`the card says "${card}"`);
    if (!card.includes("In review")) out.push(`the card has no "In review": "${card}"`);
    if (!card.includes("Acceptance check passed")) out.push(`the card has no verdict: "${card}"`);
    const href = await page.locator(".work-card a").first().getAttribute("href");
    if (href !== `${s.fake.url}/${STEWARD_REPO}/pull/1`) out.push(`the card links to ${href}`);
    if ((await page.getByText("crewhaus/").count()) === 0) out.push("no workspace branch shown");
    const viewport = page.viewportSize();
    await page.evaluate(() => {
      for (const fold of document.querySelectorAll("details.work-fold")) {
        fold.setAttribute("open", "");
      }
    });
    if ((await page.getByText("rounds every currency amount").count()) === 0) {
      out.push("the judge's reasons are not on the item page");
    }
    const reflow = await reflowFinding(page);
    if (reflow !== undefined) out.push(`reflow with the reasons open: ${reflow.detail}`);
    if (viewport !== null) await page.setViewportSize(viewport);
    const inReview = await runAxe(page);
    const found = Object.entries(inReview.violations).filter(([, n]) => n > 0);
    if (inReview.passes === 0) out.push("axe did not run on the item page");
    if (found.length > 0) out.push(`axe, in review: ${JSON.stringify(found)}`);

    await session.visit(routeFor("#/h/:id/work/items", harness));
    await waitFor(page, ".work-row", "the Work list's rows");
    const rows = await page.locator(".work-row").allInnerTexts();
    const row = rows.find((r) => r.includes(STEWARD_TITLE)) ?? "";
    if (!row.includes("In review") || !row.includes("PR #1")) {
      out.push(`the row says "${row}"`);
    }

    s.fake.mergePull(STEWARD_REPO, 1);
    const tracked = await s.track();
    if (tracked.moved !== 1) out.push(`the tracker answered ${JSON.stringify(tracked)}`);
    await session.visit(itemRoute);
    await waitFor(page, ".work-card", "the pull request's card, after the merge");
    const merged = await page.locator(".work-card").first().innerText();
    if (!merged.includes("Merged")) out.push(`after the merge the card says "${merged}"`);
    const header = await page.locator("h2 + p").first().innerText();
    if (!header.includes("Merged")) out.push(`after the merge the item says "${header}"`);
    const after = await runAxe(page);
    const afterFound = Object.entries(after.violations).filter(([, n]) => n > 0);
    if (afterFound.length > 0) out.push(`axe, merged: ${JSON.stringify(afterFound)}`);
    if (s.creates() !== 1) out.push(`${s.creates()} pull requests were asked for`);

    if (out.length > 0) throw new Error(`a steward's delivery:\n  ${out.join("\n  ")}`);
    session.assertClean();
  },
};
