/**
 * The settings form writes one setting at a time, keeping every other byte.
 *
 * On a writable harness, a setting the optimizer may write is changed in its
 * control and saved: the file differs from what it was only on that setting's
 * line. Saving the same value again sends nothing. A block edited as JSON that
 * gives one of its settings a value of the wrong type is refused at the
 * preview, and the refusal is shown beside that setting, marked invalid. axe
 * passes on the form and on the refused state.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAxe } from "../a11y/axe";
import { routeFor } from "../console-routes";
import { settle } from "../settle";
import { freshVisit, waitFor } from "./a11y-states";
import type { Journey } from "./journey";

const fail = (what: string): never => {
  throw new Error(what);
};

const keyed = (what: "input" | "save" | "json", segments: readonly string[]): string =>
  `[data-focus-key='${what}:${JSON.stringify(segments)}']`;

const specPatchPath = (id: string): string => `/api/h/${encodeURIComponent(id)}/spec/patch`;

async function axeClean(page: import("playwright").Page, what: string): Promise<void> {
  const axe = await runAxe(page);
  if (axe.passes === 0) fail(`axe did not run on ${what}`);
  if (Object.keys(axe.violations).length > 0) {
    fail(`axe found violations on ${what}: ${JSON.stringify(axe.samples)}`);
  }
}

export const specForm: Journey = {
  id: "spec-form",
  shard: "axe",
  proves:
    "The settings form saves one setting and keeps every other byte of the file, sends nothing for an unchanged value, puts a refused block edit's issue beside its setting marked invalid, and passes axe on the form and on the refused state.",
  run: async (scope) => {
    const fleet = await scope.fleet({
      seed: "spec-form",
      shapes: ["cli"],
      specExtra: "  max_tokens: 4096",
    });
    const [harness] = fleet.harnesses;
    if (harness === undefined) fail("the spec-form fleet has no harness");
    const h = harness as NonNullable<typeof harness>;
    const specPath = join(h.dir, "crewhaus.yaml");
    const seeded = readFileSync(specPath, "utf8");
    const session = await scope.session(scope.home(fleet), { label: "spec-form" });
    const { page } = session;
    let patches = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === specPatchPath(h.id)) {
        patches += 1;
      }
    });

    await freshVisit(session, routeFor("#/h/:id/setup/spec", h));
    const field = page.locator(keyed("input", ["agent", "max_tokens"]));
    const save = page.locator(keyed("save", ["agent", "max_tokens"]));
    await save.waitFor({ state: "visible", timeout: 10_000 });
    await settle(page, "the settings form");
    await axeClean(page, "the settings form");

    await field.fill("8192");
    await save.click();
    // The form reads the spec again and puts focus back on the Save that wrote.
    await page.waitForFunction(
      (selector) => document.activeElement === document.querySelector(selector),
      keyed("save", ["agent", "max_tokens"]),
      { timeout: 10_000 },
    );
    await settle(page, "the saved setting");
    if (patches !== 1) fail(`Save sent ${patches} writes, not 1`);
    const saved = readFileSync(specPath, "utf8");
    const line = "  max_tokens: 4096\n";
    const at = seeded.indexOf(line);
    if (at < 0) fail("the seeded spec has no max_tokens line");
    if (saved !== `${seeded.slice(0, at)}  max_tokens: 8192\n${seeded.slice(at + line.length)}`) {
      fail(`the save changed more than its own line:\n${saved}`);
    }

    // The control now holds what the file says: Save sends nothing.
    if ((await field.inputValue()) !== "8192") fail("the control did not take the saved value");
    await save.click();
    await settle(page, "Save with the value unchanged");
    if (patches !== 1) fail(`an unchanged Save sent a write (${patches} in all)`);

    // The whole block as JSON, with one setting of the wrong type.
    await page.locator(keyed("json", ["agent"])).click();
    await waitFor(page, "dialog[open] textarea", "the JSON pane");
    await page.locator("dialog[open] textarea").fill(
      JSON.stringify({
        model: "claude-opus-5",
        instructions: "You are a fixture. Answer briefly.\n",
        max_tokens: "many",
      }),
    );
    await page.locator("dialog[open]").getByRole("button", { name: "Preview diff" }).click();
    await waitFor(page, "dialog[open] .issue-list", "the refusal in the pane");
    await page.locator('dialog[open] button:text-is("Close")').click();
    await settle(page, "the JSON pane closed");
    if ((await field.getAttribute("aria-invalid")) !== "true") {
      fail("the refused setting is not marked invalid beside its field");
    }
    const describedBy = String(await field.getAttribute("aria-describedby"));
    const issue = await page.evaluate((ids) => {
      return ids
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    }, describedBy);
    if (!/number|integer/i.test(issue)) fail(`the field is not described by its issue: ${issue}`);
    if (readFileSync(specPath, "utf8") !== saved) fail("a refused preview changed the file");
    await axeClean(page, "the refused state");

    session.assertClean();
    await session.close();
  },
};
