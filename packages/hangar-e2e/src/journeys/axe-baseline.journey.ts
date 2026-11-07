/**
 * The report-only accessibility sweep. It never fails on a violation. It fails
 * only when the machine broke: too few rows, a route that did not settle, a row
 * where axe did not run, a session failure, or a malformed baseline.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { AXE_TAGS, runAxe } from "../a11y/axe";
import {
  type AxeReport,
  baselineProblems,
  diffAgainstBaseline,
  diffMarkdown,
  rowKey,
  sortReport,
} from "../a11y/baseline";
import { fleetRoutes, harnessRoutes, loadConsoleGrammar } from "../console-routes";
import type { Journey } from "./journey";

export const BASELINE_PATH = join(import.meta.dir, "..", "..", "axe-baseline.json");

const THEMES = ["dark", "light"] as const;
const WIDTHS = [1280, 320] as const;

export const axeBaseline: Journey = {
  id: "axe-baseline",
  shard: "axe",
  proves:
    "Every fleet screen and every tab are swept with axe in both themes at both widths, and the node counts are reported against a committed baseline. A violation is reported, never fatal.",
  run: async (scope) => {
    const grammar = await loadConsoleGrammar();
    const fleet = await scope.fleet({ seed: "axe", shapes: ["cli"] });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the sweep's fleet has no harness");
    const home = scope.home(fleet);
    const templates = [...fleetRoutes(grammar), ...harnessRoutes(grammar, harness.id)];
    const expectedRows = templates.length * THEMES.length * WIDTHS.length;

    const rows: Record<string, Record<string, number>> = {};
    const notRun: string[] = [];
    let version = "";
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const session = await scope.session(home, {
          label: `axe-${theme}-${width}`,
          theme,
          viewport: { width, height: 800 },
        });
        const shown = await session.page.evaluate(() => ({
          theme: document.documentElement.dataset["theme"],
          width: globalThis.innerWidth,
        }));
        if (shown.theme !== theme || shown.width !== width) {
          throw new Error(
            `asked for ${theme} at ${width} and got ${shown.theme} at ${shown.width}, so the rows would lie`,
          );
        }
        for (const { template, route } of templates) {
          await session.visit(route);
          const result = await runAxe(session.page);
          version = result.version;
          if (result.passes === 0) notRun.push(`${template} ${theme} ${width}`);
          rows[rowKey(template, theme, width)] = { ...result.violations };
        }
        session.assertClean();
        await session.close();
      }
    }
    if (notRun.length > 0) throw new Error(`axe did not run on: ${notRun.join(", ")}`);
    if (Object.keys(rows).length !== expectedRows) {
      throw new Error(`the sweep has ${Object.keys(rows).length} rows, not ${expectedRows}`);
    }

    const report = sortReport({ schema: 1, axe: version, tags: [...AXE_TAGS], rows });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    const artifacts = process.env["HANGAR_E2E_ARTIFACTS"];
    if (artifacts !== undefined && artifacts !== "") {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, "axe-report.json"), text);
    }
    if (process.env["HANGAR_E2E_WRITE_BASELINE"] === "1") writeFileSync(BASELINE_PATH, text);

    const baselineText = readFileSync(BASELINE_PATH, "utf8");
    const problems = baselineProblems(baselineText);
    if (problems.length > 0) {
      throw new Error(`axe-baseline.json is malformed: ${problems.join("; ")}`);
    }
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined && summary !== "") {
      const diff = diffAgainstBaseline(JSON.parse(baselineText) as AxeReport, report);
      const fd = openSync(summary, "a");
      try {
        writeSync(fd, diffMarkdown(diff, report));
      } finally {
        closeSync(fd);
      }
    }
  },
};
