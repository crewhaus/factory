/**
 * The accessibility sweep: every fleet screen and every tab, in both themes
 * at both widths, in one pass.
 *
 * The gated screens (`a11y/gate.ts`) fail the build on any violation, with no
 * allow-list, and on a missing row or missing content. Every other screen is
 * reported against the committed baseline and never fails. The sweep also
 * fails when the machine broke: too few rows, a route that did not settle, a
 * row where axe did not run, a session failure, or a malformed baseline. The
 * report and the step summary are written before any of that throws, so the
 * artifact exists on a failure too.
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
import {
  GATED_TEMPLATES,
  GATE_EXPECTS,
  GATE_THEMES,
  GATE_WIDTHS,
  gateMessage,
  gateVerdict,
} from "../a11y/gate";
import { fleetRoutes, harnessRoutes, loadConsoleGrammar } from "../console-routes";
import type { Journey } from "./journey";

export const BASELINE_PATH = join(import.meta.dir, "..", "..", "axe-baseline.json");

export const axeBaseline: Journey = {
  id: "axe-baseline",
  shard: "axe",
  proves:
    "Every fleet screen and every tab are swept with axe in both themes at both widths. A gated screen with any violation, or without the content it must show, fails the build; every other screen is reported against a committed baseline and never fails.",
  run: async (scope) => {
    const grammar = await loadConsoleGrammar();
    const fleet = await scope.fleet({ seed: "axe", shapes: ["cli"], rich: true });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the sweep's fleet has no harness");
    const home = scope.home(fleet);
    const templates = [...fleetRoutes(grammar), ...harnessRoutes(grammar, harness.id)];
    const expectedRows = templates.length * GATE_THEMES.length * GATE_WIDTHS.length;

    const rows: Record<string, Record<string, number>> = {};
    const samples: Record<string, Readonly<Record<string, readonly string[]>>> = {};
    const notRun: string[] = [];
    const emptyScreens: string[] = [];
    let version = "";
    for (const theme of GATE_THEMES) {
      for (const width of GATE_WIDTHS) {
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
          const expects = GATE_EXPECTS[template];
          if (expects !== undefined && (await session.page.locator(expects).count()) === 0) {
            emptyScreens.push(`${template} ${theme} ${width}: nothing matches ${expects}`);
          }
          const result = await runAxe(session.page);
          version = result.version;
          if (result.passes === 0) notRun.push(`${template} ${theme} ${width}`);
          rows[rowKey(template, theme, width)] = { ...result.violations };
          samples[rowKey(template, theme, width)] = result.samples;
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
    const verdict = gateVerdict(report, GATED_TEMPLATES);
    const text = `${JSON.stringify(report, null, 2)}\n`;
    const artifacts = process.env["HANGAR_E2E_ARTIFACTS"];
    if (artifacts !== undefined && artifacts !== "") {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, "axe-report.json"), text);
    }
    if (process.env["HANGAR_E2E_WRITE_BASELINE"] === "1") writeFileSync(BASELINE_PATH, text);

    const baselineText = readFileSync(BASELINE_PATH, "utf8");
    const problems = baselineProblems(baselineText);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined && summary !== "" && problems.length === 0) {
      const diff = diffAgainstBaseline(JSON.parse(baselineText) as AxeReport, report);
      const fd = openSync(summary, "a");
      try {
        writeSync(
          fd,
          diffMarkdown(diff, report, {
            gated: GATED_TEMPLATES.length,
            failures: verdict.failures.length,
            missing: verdict.missing.length,
          }),
        );
      } finally {
        closeSync(fd);
      }
    }
    if (problems.length > 0) {
      throw new Error(`axe-baseline.json is malformed: ${problems.join("; ")}`);
    }
    if (emptyScreens.length > 0) {
      throw new Error(
        `a gated screen showed none of the content it must, so its sweep proves nothing:\n  ${emptyScreens.join("\n  ")}`,
      );
    }
    if (verdict.failures.length > 0 || verdict.missing.length > 0) {
      throw new Error(gateMessage(verdict, samples));
    }
  },
};
