/**
 * The browser suite: `bun test ./src/journeys/suite.ts`, run by the `ui-e2e` job.
 *
 * Deliberately not named `*.test.ts`, and neither is any journey: a runner with no
 * browser must be able to run `bun test src` over this package and find only the
 * DOM-free units.
 */
import { afterAll, test } from "bun:test";
import { closeSharedBrowser } from "../session";
import { runJourney, selectJourneys } from "./journey";
import { JOURNEYS } from "./registry";

for (const journey of selectJourneys(JOURNEYS, process.env["HANGAR_E2E_SHARD"])) {
  test(`${journey.shard}: ${journey.id}`, async () => {
    await runJourney(journey);
  }, 300_000); // a browser and a real boot
}

afterAll(async () => {
  await closeSharedBrowser();
}, 60_000); // a browser shutting down on a loaded runner
