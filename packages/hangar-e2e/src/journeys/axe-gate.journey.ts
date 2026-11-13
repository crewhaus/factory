/**
 * The accessibility gate: every route the console serves, in both themes at
 * both widths, with no allow-list and no baseline. Any violation on any row
 * fails the build, and so does a missing row, a screen without the content it
 * must show (`GATE_EXPECTS`), a route that did not settle, a row where axe
 * did not run, a route that scrolls sideways at 320 CSS px (axe has no reflow
 * rule, so the narrow pass measures it on every route), or a session failure. The report (`axe-report.json`) and the
 * step summary are written before any of that throws, so the artifact exists
 * on a failure too.
 */
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { AXE_TAGS, runAxe } from "../a11y/axe";
import { gateMarkdown, rowKey, sortReport } from "../a11y/baseline";
import {
  GATE_EXPECTS,
  GATE_THEMES,
  GATE_WIDTHS,
  gateMessage,
  gateVerdict,
  gatedTemplates,
} from "../a11y/gate";
import { REFLOW_WIDTH, reflowFinding } from "../a11y/reflow";
import { routeFor } from "../console-routes";
import type { Journey } from "./journey";

export const axeGate: Journey = {
  id: "axe-gate",
  shard: "axe",
  proves:
    "Every route the console serves — each fleet page and each harness section and sub-view — has no axe violation in either theme at either width, reflows at 320 px without scrolling sideways, and shows the content it exists for; there is no allow-list and no baseline.",
  run: async (scope) => {
    const templates = await gatedTemplates();
    const fleet = await scope.fleet({ seed: "axe", shapes: ["cli"], rich: true });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the sweep's fleet has no harness");
    const home = scope.home(fleet);
    const expectedRows = templates.length * GATE_THEMES.length * GATE_WIDTHS.length;

    const unlisted = templates.filter((template) => GATE_EXPECTS[template] === undefined);
    if (unlisted.length > 0) {
      throw new Error(`a route has no line in GATE_EXPECTS: ${unlisted.join(", ")}`);
    }

    const rows: Record<string, Record<string, number>> = {};
    const samples: Record<string, Readonly<Record<string, readonly string[]>>> = {};
    const notRun: string[] = [];
    const emptyScreens: string[] = [];
    const unreflowed: string[] = [];
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
        for (const template of templates) {
          await session.visit(routeFor(template, harness));
          const expects = GATE_EXPECTS[template] as string;
          if ((await session.page.locator(expects).count()) === 0) {
            emptyScreens.push(`${template} ${theme} ${width}: nothing matches ${expects}`);
          }
          const result = await runAxe(session.page);
          version = result.version;
          if (result.passes === 0) notRun.push(`${template} ${theme} ${width}`);
          rows[rowKey(template, theme, width)] = { ...result.violations };
          samples[rowKey(template, theme, width)] = result.samples;
          if (width === REFLOW_WIDTH) {
            const reflow = await reflowFinding(session.page);
            if (reflow !== undefined) unreflowed.push(`${template} ${theme}: ${reflow.detail}`);
          }
        }
        session.assertClean();
        await session.close();
      }
    }

    const report = sortReport({ schema: 1, axe: version, tags: [...AXE_TAGS], rows });
    const verdict = gateVerdict(report, templates);
    const artifacts = process.env["HANGAR_E2E_ARTIFACTS"];
    if (artifacts !== undefined && artifacts !== "") {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, "axe-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    }
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined && summary !== "") {
      const fd = openSync(summary, "a");
      try {
        writeSync(
          fd,
          gateMarkdown(report, {
            gated: templates.length,
            failures: verdict.failures.length,
            missing: verdict.missing.length,
          }),
        );
      } finally {
        closeSync(fd);
      }
    }
    if (notRun.length > 0) throw new Error(`axe did not run on: ${notRun.join(", ")}`);
    if (Object.keys(rows).length !== expectedRows) {
      throw new Error(`the sweep has ${Object.keys(rows).length} rows, not ${expectedRows}`);
    }
    if (unreflowed.length > 0) {
      throw new Error(
        `a route scrolls sideways at ${REFLOW_WIDTH} px (WCAG 1.4.10 reflow):\n  ${unreflowed.join("\n  ")}`,
      );
    }
    if (emptyScreens.length > 0) {
      throw new Error(
        `a screen showed none of the content it must, so its sweep proves nothing:\n  ${emptyScreens.join("\n  ")}`,
      );
    }
    if (verdict.failures.length > 0 || verdict.missing.length > 0) {
      throw new Error(gateMessage(verdict, samples));
    }
  },
};
