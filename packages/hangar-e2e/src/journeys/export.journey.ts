/**
 * Taking a harness away from Home: the spec download is the masked copy, its first line
 * saying so; an evaluation run's CSV holds the run's own rows; and exporting the whole
 * harness names where Home wrote the archive and downloads nothing.
 */
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { HARNESSES_ROUTE, routeFor } from "../console-routes";
import { waitFor } from "./a11y-states";
import type { Journey } from "./journey";
import { PLANTED_EVAL, plantEvalResults } from "./planted-evals";

/** Open a row's More menu (named for `label`) and choose `item`. */
async function choose(page: Page, label: string, item: string): Promise<void> {
  await page.locator(`summary[aria-label="More for ${label}"]`).first().click();
  await page.locator(".more-menu[open] button", { hasText: item }).first().click();
}

/** The text of the file a click downloads. */
async function downloaded(page: Page, act: () => Promise<void>): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), act()]);
  const path = await download.path();
  if (path === null) throw new Error("the download was not saved");
  return readFileSync(path, "utf8");
}

export const exportJourney: Journey = {
  id: "export",
  shard: "smoke",
  proves:
    "Export spec downloads the masked spec whose first line says it is not the file on disk; Export results downloads the evaluation run's own rows as CSV; and Export harness says where Home is writing the archive, says it is saved only once Home lists it, and downloads nothing.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "export", shapes: ["cli"], rich: true });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the fleet has no harness");
    const runId = plantEvalResults(harness.dir);
    const home = scope.home(fleet);
    const session = await scope.session(home);
    const { page } = session;
    const out: string[] = [];
    const label = `${harness.specName} (${harness.id})`;

    await session.visit(HARNESSES_ROUTE);
    const spec = await downloaded(page, () => choose(page, label, "Export spec"));
    const firstLine = spec.split("\n")[0] ?? "";
    if (!firstLine.startsWith("# Exported from Home.")) out.push(`the spec starts "${firstLine}"`);
    if (!spec.includes(`name: ${harness.specName}`)) out.push("the spec download holds no spec");

    await session.visit(routeFor("#/h/:id/quality/results", harness));
    const csv = await downloaded(page, () =>
      choose(page, `evaluation run ${runId}`, "Export results (CSV)"),
    );
    const lines = csv.trimEnd().split("\n");
    if (!(lines[0] ?? "").startsWith("runId,")) out.push(`the CSV header is "${lines[0]}"`);
    if (lines.length !== 2) out.push(`the CSV has ${lines.length - 1} rows, not 1`);
    for (const value of [
      runId,
      PLANTED_EVAL.sampleId,
      PLANTED_EVAL.grader,
      PLANTED_EVAL.rationale,
    ]) {
      if (!(lines[1] ?? "").includes(value)) out.push(`the CSV row lacks ${value}`);
    }

    await session.visit(HARNESSES_ROUTE);
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    await choose(page, label, "Export harness");
    await waitFor(page, "dialog[open] .modal-body p", "the export's answer");
    const said = await page.locator("dialog[open] .modal-body p").first().innerText();
    if (
      !/^Home is writing the archive to \/.+\.tar\.gz on its computer\. When the job finishes, copy it from there\.$/.test(
        said,
      )
    ) {
      out.push(`the export said "${said}"`);
    }
    // Saved is said only from Home's own list of archives.
    await page.getByRole("button", { name: "Check whether it is saved" }).click();
    await waitFor(page, "dialog[open] .export-saved:not(:empty)", "whether the archive is saved");
    const saved = await page.locator("dialog[open] .export-saved").innerText();
    if (!/^(Saved: .+\.tar\.gz\.|Not saved yet\. .+)$/.test(saved)) {
      out.push(`checking the archive said "${saved}"`);
    }
    if (!said.includes(`exports/${harness.id}/`))
      out.push("the archive is not in Home's exports folder");
    if (downloads !== 0) out.push(`exporting the harness downloaded ${downloads} file(s)`);

    if (out.length > 0) throw new Error(`export:\n  ${out.join("\n  ")}`);
    session.assertClean();
  },
};
