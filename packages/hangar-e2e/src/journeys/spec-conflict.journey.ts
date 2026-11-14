/**
 * A spec saved after it changed on disk, answered by the real server.
 *
 * The editor loads the spec, a setting is changed in its control, the file is
 * edited on disk, and Save sends the revision the editor loaded: the server
 * answers 412 with the current revision and a kept draft, the conflict dialog
 * opens with focus on its heading, axe passes on that state, the change on disk
 * is kept, and closing the dialog gives focus back to the control that saved.
 *
 * The same holds for a watch-me proposal's "Apply selected" and an advice's
 * "Apply to the spec": each 412 opens the conflict view, and closing it puts
 * focus back on a live control in the view, never on the page itself.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { runAxe } from "../a11y/axe";
import { routeFor } from "../console-routes";
import { settle } from "../settle";
import { freshVisit, waitFor } from "./a11y-states";
import type { Journey } from "./journey";

const fail = (what: string): never => {
  throw new Error(what);
};

const specPatchPath = (id: string): string => `/api/h/${encodeURIComponent(id)}/spec/patch`;
const STAMP = "20261114T000000Z";
const watchmeApplyPath = (id: string): string =>
  `/api/h/${encodeURIComponent(id)}/memory/watchme/synthesized/${STAMP}/apply`;
const ADVICE_ID = "adv_instructions";
const adviceApplyPath = (id: string): string =>
  `/api/h/${encodeURIComponent(id)}/feedback/advice/${ADVICE_ID}/apply`;

/** The data-focus-key of a setting's control or its Save, by segments. */
const keyed = (what: "input" | "save", segments: readonly string[]): string =>
  `[data-focus-key='${what}:${JSON.stringify(segments)}']`;

/** Someone edits the file on disk after the screen read it. */
function editOnDisk(dir: string, note: string): string {
  const specPath = join(dir, "crewhaus.yaml");
  const edited = `${readFileSync(specPath, "utf8")}# ${note}\n`;
  writeFileSync(specPath, edited);
  return edited;
}

/** Close the open conflict view and say where focus went. */
async function closeConflict(page: Page, what: string): Promise<void> {
  await page.locator('dialog[open] button:text-is("Close")').click();
  await settle(page, `${what}: the conflict view closed`);
  const where = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      body: active === document.body || active === null,
      connected: active?.isConnected === true,
      control: active instanceof HTMLButtonElement || active instanceof HTMLInputElement,
      inView: active?.closest("#view") !== null && active?.closest("#view") !== undefined,
    };
  });
  if (where.body || !where.connected || !where.control || !where.inView) {
    fail(
      `${what}: closing the conflict view left focus off a live control: ${JSON.stringify(where)}`,
    );
  }
}

export const specConflict: Journey = {
  id: "spec-conflict",
  shard: "axe",
  proves:
    "A spec saved after it changed on disk is refused by the real server, never written over: the conflict dialog opens with focus on its heading, passes axe, and gives focus back to the control that saved when it closes; a watch-me or advice apply refused the same way gives focus back to a live control in its view.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "spec-conflict", shapes: ["cli"] });
    const [harness] = fleet.harnesses;
    if (harness === undefined) fail("the spec-conflict fleet has no harness");
    const h = harness as NonNullable<typeof harness>;
    const session = await scope.session(scope.home(fleet), {
      label: "spec-conflict",
      // The real server's answer to each write against a spec that moved.
      expectedStatuses: [
        { pathname: specPatchPath(h.id), status: 412 },
        { pathname: watchmeApplyPath(h.id), status: 412 },
        { pathname: adviceApplyPath(h.id), status: 412 },
      ],
    });
    const { page } = session;
    let saves = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === specPatchPath(h.id)) {
        saves += 1;
      }
    });

    await freshVisit(session, routeFor("#/h/:id/setup/spec", h));
    const field = page.locator(keyed("input", ["agent", "instructions"]));
    const save = page.locator(keyed("save", ["agent", "instructions"]));
    await save.waitFor({ state: "visible", timeout: 10_000 });
    // An unchanged control sends nothing, so the value changes first.
    await field.fill("You are a fixture. Answer in one line.");

    const edited = editOnDisk(h.dir, "edited on disk while the editor was open");
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
    if (readFileSync(join(h.dir, "crewhaus.yaml"), "utf8") !== edited) {
      fail("the save wrote over the change made on disk");
    }

    await page.locator('dialog[open] button:text-is("Close")').click();
    await settle(page, "the conflict view closed");
    const back = await save.evaluate((node) => node === document.activeElement);
    if (!back) fail("closing the conflict view did not give focus back to Save");

    // A watch-me proposal, applied after the spec moved.
    const synthesized = join(h.dir, ".crewhaus", "watchme", "synthesized");
    mkdirSync(synthesized, { recursive: true });
    const live = readFileSync(join(h.dir, "crewhaus.yaml"), "utf8");
    writeFileSync(
      join(synthesized, `${STAMP}.yaml`),
      live.replace("You are a fixture. Answer briefly.", "You are a fixture, watched."),
    );
    await freshVisit(session, `${routeFor("#/h/:id/knowledge/memory", h)}/watchme`);
    await waitFor(page, "#view details.fold summary", "the synthesized proposal");
    const proposal = page.locator("#view details.fold", { hasText: STAMP }).first();
    await proposal.locator("summary").first().click();
    await proposal.locator('input[type="checkbox"]').first().check();
    editOnDisk(h.dir, "edited on disk while the proposal was open");
    await proposal.getByRole("button", { name: "Apply selected" }).click();
    await waitFor(page, "dialog[open] .conflict", "the watch-me conflict view");
    await settle(page, "the watch-me conflict view");
    await closeConflict(page, "watch-me");

    // An advice suggestion, applied after the spec moved since its preview.
    const advice = join(h.dir, ".crewhaus", "advice");
    mkdirSync(advice, { recursive: true });
    writeFileSync(
      join(advice, "suggestions.json"),
      JSON.stringify({
        suggestions: [
          {
            findingId: ADVICE_ID,
            summary: "Answer briefly.",
            patch: {
              target: "cli",
              path: ["agent", "instructions"],
              op: "replace",
              value: "You are a fixture. Be brief.",
              rationale: "seen in the feedback",
            },
          },
        ],
      }),
    );
    await freshVisit(session, routeFor("#/h/:id/quality/feedback", h));
    const preview = page.getByRole("button", { name: "Preview diff" }).first();
    await preview.waitFor({ state: "visible", timeout: 10_000 });
    await preview.click();
    const apply = page.getByRole("button", { name: "Apply to the spec" }).first();
    await apply.waitFor({ state: "visible", timeout: 10_000 });
    editOnDisk(h.dir, "edited on disk while the advice was open");
    await apply.click();
    await waitFor(page, "dialog[open] .conflict", "the advice conflict view");
    await settle(page, "the advice conflict view");
    await closeConflict(page, "advice");
    const onApply = await apply.evaluate((node) => node === document.activeElement);
    if (!onApply) fail("closing the advice conflict view did not give focus back to its Apply");

    session.assertClean();
    await session.close();
  },
};
