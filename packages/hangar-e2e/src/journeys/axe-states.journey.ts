/**
 * A route's first paint is not its whole UI. This sweeps the screens' other
 * states — every overlay, the header's lists, a section's sub-view list, an
 * armed inbox row, a filtered digest, an open disclosure, each panel of the
 * memory fabric and of the Thredz screen, and the harness list under each
 * Readability choice — with the same matrix and the same verdict as the
 * first-paint sweep: any violation fails.
 *
 * Its rows are `<template>><state>`, written to their own artifact
 * (`axe-states-report.json`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AXE_TAGS, runAxe } from "../a11y/axe";
import { rowKey, sortReport } from "../a11y/baseline";
import { GATE_THEMES, GATE_WIDTHS, gateMessage, gateVerdict } from "../a11y/gate";
import { a11yFleet, enterState, mockRefusals, screenStates } from "./a11y-states";
import type { Journey } from "./journey";

export const axeStates: Journey = {
  id: "axe-states",
  shard: "axe",
  proves:
    "Every overlay and state of the screens — the dialogs, the command menu, the header's Help, Settings and Menu lists, a section's sub-view list, the tooltip, an armed inbox row, the row menu, a filtered digest, every memory and Thredz panel, and each Readability choice — has no axe violation in either theme at either width.",
  run: async (scope) => {
    const world = await a11yFleet(scope, "axe-states");
    const states = screenStates(world.harness);
    const rows: Record<string, Record<string, number>> = {};
    const samples: Record<string, Readonly<Record<string, readonly string[]>>> = {};
    const notRun: string[] = [];
    let version = "";
    for (const theme of GATE_THEMES) {
      for (const width of GATE_WIDTHS) {
        const session = await scope.session(world.home, {
          label: `axe-states-${theme}-${width}`,
          theme,
          viewport: { width, height: 800 },
          expectedStatuses: world.expectedStatuses,
        });
        await mockRefusals(session.page, world.harness.id);
        for (const state of states) {
          await enterState(session, state);
          const result = await runAxe(session.page);
          version = result.version;
          const template = `${state.template}>${state.state}`;
          if (result.passes === 0) notRun.push(`${template} ${theme} ${width}`);
          rows[rowKey(template, theme, width)] = { ...result.violations };
          samples[rowKey(template, theme, width)] = result.samples;
        }
        session.assertClean();
        await session.close();
      }
    }
    const report = sortReport({ schema: 1, axe: version, tags: [...AXE_TAGS], rows });
    const artifacts = process.env["HANGAR_E2E_ARTIFACTS"];
    if (artifacts !== undefined && artifacts !== "") {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(
        join(artifacts, "axe-states-report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    if (notRun.length > 0) throw new Error(`axe did not run on: ${notRun.join(", ")}`);
    const verdict = gateVerdict(
      report,
      states.map((state) => `${state.template}>${state.state}`),
    );
    if (verdict.failures.length > 0 || verdict.missing.length > 0) {
      throw new Error(gateMessage(verdict, samples));
    }
  },
};
