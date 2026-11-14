/**
 * A spec with a setting this version of CrewHaus does not know is read-only in
 * Home, said in words, with every write control still reachable.
 *
 * The harness's spec gains a key no schema in use knows. The notice names it
 * in a plain sentence and names the one command that can help, once. From the
 * notice, Tab reaches every visible write control in the settings form, none
 * skipped and no trap; each is announced as unavailable and described by the
 * notice's sentence; Enter and Space on a Save send nothing; and axe passes.
 */
import { runAxe } from "../a11y/axe";
import { routeFor } from "../console-routes";
import { settle } from "../settle";
import { freshVisit, waitFor } from "./a11y-states";
import type { Journey } from "./journey";

const fail = (what: string): never => {
  throw new Error(what);
};

const REASON = "spec-read-only-reason";

export const specReadOnly: Journey = {
  id: "spec-read-only",
  shard: "axe",
  proves:
    "A spec with a setting this CrewHaus does not know is read-only in Home: the notice says why in a sentence and names one runnable command, every write control stays in the Tab order announced as unavailable and described by that sentence, Enter and Space send nothing, and axe passes.",
  run: async (scope) => {
    // The spec carries a top-level setting no schema in use knows.
    const fleet = await scope.fleet({
      seed: "spec-read-only",
      shapes: ["cli"],
      specExtra: "zz_future_block: true",
    });
    const [harness] = fleet.harnesses;
    if (harness === undefined) fail("the spec-read-only fleet has no harness");
    const h = harness as NonNullable<typeof harness>;
    const session = await scope.session(scope.home(fleet), { label: "spec-read-only" });
    const { page } = session;
    let writes = 0;
    const specPrefix = `/api/h/${encodeURIComponent(h.id)}/spec`;
    page.on("request", (request) => {
      const method = request.method();
      if (
        (method === "POST" || method === "PUT") &&
        new URL(request.url()).pathname.startsWith(specPrefix)
      ) {
        writes += 1;
      }
    });

    await freshVisit(session, routeFor("#/h/:id/setup/spec", h));
    await waitFor(page, `#${REASON}`, "the read-only notice");
    await waitFor(page, ".settings-card", "the settings form");
    await settle(page, "the read-only spec");

    const notice = String(await page.locator(`#${REASON}`).textContent());
    if (!notice.includes("zz_future_block"))
      fail(`the notice does not name the setting: ${notice}`);
    if (notice.includes("`")) fail(`the notice carries a backtick: ${notice}`);
    const verbs = await page.locator(".spec-read-only code").allTextContents();
    if (verbs.length !== 1 || verbs[0] !== `crewhaus harness adopt ${h.id}`) {
      fail(`the notice's command is not one runnable command: ${JSON.stringify(verbs)}`);
    }

    // Number every visible write control in the form, then walk the Tab order from the notice.
    const counts = await page.evaluate(() => {
      const card = document.querySelector(".settings-card");
      // Not only a box: a closed disclosure's content keeps its boxes but is skipped.
      const visible = (node: Element) =>
        node instanceof HTMLElement && node.getClientRects().length > 0 && node.checkVisibility();
      const writes = [...(card?.querySelectorAll("[data-write='true']") ?? [])].filter(visible);
      writes.forEach((node, i) => node.setAttribute("data-e2e-write", String(i)));
      const focusable = [
        ...(document
          .querySelector("#view")
          ?.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]") ??
          []),
      ].filter(visible);
      return { writes: writes.length, focusable: focusable.length };
    });
    if (counts.writes === 0) fail("the form shows no write control");
    const cap = counts.focusable * 2 + 10;
    await page.locator(`#${REASON}`).click();
    const reached = new Set<string>();
    let left = false;
    for (let press = 0; press < cap; press += 1) {
      await page.keyboard.press("Tab");
      const at = await page.evaluate(() => {
        const active = document.activeElement;
        const card = document.querySelector(".settings-card");
        if (active === null || card === null) return { index: null, after: false };
        const after =
          !card.contains(active) &&
          (card.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        return { index: active.getAttribute("data-e2e-write"), after };
      });
      if (at.index !== null) reached.add(at.index);
      if (at.after) {
        left = true;
        break;
      }
    }
    if (!left) fail(`Tab did not leave the settings form within ${cap} presses`);
    const skipped = Array.from({ length: counts.writes }, (_, i) => String(i)).filter(
      (i) => !reached.has(i),
    );
    if (skipped.length > 0)
      fail(`Tab skipped ${skipped.length} of ${counts.writes} write controls`);

    const held = await page.evaluate((reason) => {
      const bad: string[] = [];
      for (const node of document.querySelectorAll("[data-e2e-write]")) {
        const tokens = (node.getAttribute("aria-describedby") ?? "").split(/\s+/);
        if (node.getAttribute("aria-disabled") !== "true" || !tokens.includes(reason)) {
          bad.push(node.getAttribute("aria-label") ?? node.textContent ?? "?");
        }
        if ((node as HTMLButtonElement).disabled === true)
          bad.push(`disabled: ${node.textContent}`);
      }
      return bad;
    }, REASON);
    if (held.length > 0) fail(`write controls not held by the notice: ${held.join(", ")}`);

    const save = page
      .locator(".settings-card button[data-write='true']", { hasText: /^Save$/ })
      .first();
    await save.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await settle(page, "Enter and Space on a held Save");
    if (writes !== 0) fail(`a held control sent ${writes} spec writes`);

    const axe = await runAxe(page);
    if (axe.passes === 0) fail("axe did not run on the read-only spec");
    if (Object.keys(axe.violations).length > 0) {
      fail(`axe found violations on the read-only spec: ${JSON.stringify(axe.samples)}`);
    }

    session.assertClean();
    await session.close();
  },
};
