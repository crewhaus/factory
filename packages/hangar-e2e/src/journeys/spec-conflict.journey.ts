/**
 * A spec saved after it changed on disk, answered by the real server.
 *
 * The editor loads the spec, the file is edited on disk, and Save sends the
 * revision the editor loaded: the server answers 412 with the current
 * revision and a kept draft, the conflict dialog opens with focus on its
 * heading, axe passes on that state, the change on disk is kept, and closing
 * the dialog gives focus back to the control that saved.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAxe } from "../a11y/axe";
import { harnessRoute } from "../console-routes";
import { settle } from "../settle";
import { freshVisit, waitFor } from "./a11y-states";
import type { Journey } from "./journey";

const fail = (what: string): never => {
  throw new Error(what);
};

const specPatchPath = (id: string): string => `/api/h/${encodeURIComponent(id)}/spec/patch`;

export const specConflict: Journey = {
  id: "spec-conflict",
  shard: "axe",
  proves:
    "A spec saved after it changed on disk is refused by the real server, never written over: the conflict dialog opens with focus on its heading, passes axe, and gives focus back to the control that saved when it closes.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "spec-conflict", shapes: ["cli"] });
    const [harness] = fleet.harnesses;
    if (harness === undefined) fail("the spec-conflict fleet has no harness");
    const h = harness as NonNullable<typeof harness>;
    const session = await scope.session(scope.home(fleet), {
      label: "spec-conflict",
      // The real server's answer to a save against a spec that moved.
      expectedStatuses: [{ pathname: specPatchPath(h.id), status: 412 }],
    });
    const { page } = session;
    let saves = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === specPatchPath(h.id)) {
        saves += 1;
      }
    });

    await freshVisit(session, harnessRoute(h.id, "spec"));
    const save = page.getByRole("button", { name: "Save", exact: true }).first();
    await save.waitFor({ state: "visible", timeout: 10_000 });

    // Someone edits the file on disk after the editor loaded it.
    const specPath = join(h.dir, "crewhaus.yaml");
    const edited = `${readFileSync(specPath, "utf8")}# edited on disk while the editor was open\n`;
    writeFileSync(specPath, edited);

    await save.click();
    await waitFor(page, "dialog[open] .conflict", "the conflict view");
    await settle(page, "the conflict view");
    if (saves !== 1) fail(`Save sent ${saves} writes, not 1`);
    const onHeading = await page.evaluate(() => {
      const active = document.activeElement;
      return (
        active !== null &&
        active.closest("dialog[open]") !== null &&
        /^H[1-6]$/.test(active.tagName)
      );
    });
    if (!onHeading) fail("the conflict dialog did not put focus on its heading");
    const revision = await page.locator("dialog[open] .conflict p.mono").textContent();
    if (!String(revision).includes("sha256:")) {
      fail(`the conflict view named no revision from the server: ${String(revision)}`);
    }
    const axe = await runAxe(page);
    if (axe.passes === 0) fail("axe did not run on the conflict view");
    if (Object.keys(axe.violations).length > 0) {
      fail(`axe found violations on the conflict view: ${JSON.stringify(axe.samples)}`);
    }
    if (readFileSync(specPath, "utf8") !== edited) {
      fail("the save wrote over the change made on disk");
    }

    await page.locator('dialog[open] button:text-is("Close")').click();
    await settle(page, "the conflict view closed");
    const back = await save.evaluate((node) => node === document.activeElement);
    if (!back) fail("closing the conflict view did not give focus back to Save");

    session.assertClean();
    await session.close();
  },
};
