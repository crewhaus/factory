/** Every screen, for every shape, against a seeded fleet. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ERROR_CARD_SELECTOR,
  NOT_FOUND_TEXT,
  crawlRouteCount,
  crawlRoutes,
  loadConsoleGrammar,
} from "../console-routes";
import { digestFleet } from "../seed/fleet";
import type { Journey } from "./journey";

export const crawl: Journey = {
  id: "crawl",
  shard: "smoke",
  proves:
    "The Library, every fleet-wide view, and every tab for every shape render with no not-found page, no error card and no session failure, and reading them changes no byte of any harness directory.",
  run: async (scope) => {
    const grammar = await loadConsoleGrammar();
    const fleet = await scope.fleet({ seed: "crawl" });
    const before = digestFleet(fleet);
    const home = scope.home(fleet);
    const session = await scope.session(home);

    const routes = crawlRoutes(
      grammar,
      fleet.harnesses.map((harness) => harness.id),
    );
    const expected = crawlRouteCount(grammar, grammar.shapeTargets.length);
    if (routes.length !== expected || fleet.harnesses.length !== grammar.shapeTargets.length) {
      throw new Error(
        `the crawl has ${routes.length} routes over ${fleet.harnesses.length} harnesses, not ${expected} over ${grammar.shapeTargets.length}`,
      );
    }

    const notRendered: string[] = [];
    for (const { route } of routes) {
      await session.visit(route);
      const body = await session.page.locator("body").innerText();
      if (body.includes(NOT_FOUND_TEXT)) notRendered.push(`${route}: ${NOT_FOUND_TEXT}`);
      const errorCards = await session.page.locator(ERROR_CARD_SELECTOR).count();
      if (errorCards > 0) {
        const text = await session.page.locator(ERROR_CARD_SELECTOR).first().innerText();
        notRendered.push(`${route}: error card: ${text}`);
      }
    }
    if (notRendered.length > 0) {
      throw new Error(`routes did not render:\n  ${notRendered.join("\n  ")}`);
    }
    session.assertClean();

    const after = digestFleet(fleet);
    const changed = Object.keys(before).filter((target) => before[target] !== after[target]);
    if (changed.length > 0) {
      throw new Error(`reading the console changed these harness directories: ${changed}`);
    }

    const artifacts = process.env["HANGAR_E2E_ARTIFACTS"];
    if (artifacts !== undefined && artifacts !== "") {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(
        join(artifacts, "smoke-report.json"),
        `${JSON.stringify({ routes: routes.length, ...session.counts() }, null, 2)}\n`,
      );
    }
  },
};
