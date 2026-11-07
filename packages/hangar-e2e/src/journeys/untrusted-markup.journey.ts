/** Outside text stays text. */
import {
  crawlRoutes,
  loadConsoleGrammar,
  runRoute,
  sessionRoute,
  wikiRoute,
} from "../console-routes";
import { MARKUP_VISIBLE } from "../seed/fleet";
import type { Journey } from "./journey";

/** Sessions, a transcript, memory, feedback, a run log and the wiki each show it. */
const MIN_SCREENS_SHOWING_PAYLOAD = 5;

export const untrustedMarkup: Journey = {
  id: "untrusted-markup",
  shard: "smoke",
  proves:
    "Script planted in a session, a wiki article, a memory, feedback, a run log, focus and goals renders as literal text wherever the console shows it and never runs.",
  run: async (scope) => {
    const grammar = await loadConsoleGrammar();
    const fleet = await scope.fleet({ seed: "markup", shapes: ["cli"], markup: true });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the markup fleet has no harness");
    const session = await scope.session(scope.home(fleet));

    const routes = [
      ...crawlRoutes(grammar, [harness.id]).map(({ route }) => route),
      sessionRoute(harness.id, harness.sessionIds[0] ?? ""),
      runRoute(harness.id, harness.runId),
      wikiRoute(harness.id, harness.wikiSlug),
    ];
    const visibleOn: string[] = [];
    const liveLinks: string[] = [];
    for (const route of routes) {
      await session.visit(route);
      const body = await session.page.locator("body").innerText();
      if (body.includes(MARKUP_VISIBLE)) visibleOn.push(route);
      const links = await session.page.locator('a[href^="javascript:" i]').count();
      if (links > 0) liveLinks.push(`${route}: ${links}`);
    }

    // The session fails on the sentinel, whichever route set it.
    session.assertClean();
    const sentinel = await session.page.evaluate(
      () => (globalThis as unknown as { __e2eSentinel?: unknown }).__e2eSentinel,
    );
    if (sentinel !== undefined) throw new Error(`the sentinel was set to ${String(sentinel)}`);
    if (liveLinks.length > 0) {
      throw new Error(`a planted link became a live one:\n  ${liveLinks.join("\n  ")}`);
    }
    // A seed that stopped landing would otherwise pass this journey with nothing to
    // render. The wiki route is where the markdown renderer reads the payload.
    if (visibleOn.length < MIN_SCREENS_SHOWING_PAYLOAD) {
      throw new Error(
        `the payload was on ${visibleOn.length} screens, under ${MIN_SCREENS_SHOWING_PAYLOAD}: [${visibleOn}]`,
      );
    }
    const wiki = wikiRoute(harness.id, harness.wikiSlug);
    if (!visibleOn.includes(wiki)) {
      throw new Error(`the wiki article did not show the payload as text; on: ${visibleOn}`);
    }
  },
};
