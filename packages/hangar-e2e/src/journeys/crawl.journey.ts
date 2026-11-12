/**
 * Every screen, for every shape, against a seeded fleet; and every screen is
 * reachable by following the console's own links from Home.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  ERROR_CARD_SELECTOR,
  HOME_ROUTE,
  NOT_FOUND_TEXT,
  crawlRouteCount,
  crawlRoutes,
  loadConsoleGrammar,
  redirectFor,
  templateOf,
} from "../console-routes";
import { digestFleet } from "../seed/fleet";
import type { Session } from "../session";
import type { Journey } from "./journey";

/** The furthest a section's own page may be from Home, in followed links. */
const SECTION_DEPTH = 3;

/** Every in-app link on the page, as written. */
async function inAppLinks(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#/"]')].map(
      (a) => a.getAttribute("href") ?? "",
    ),
  );
}

/**
 * Breadth first from Home over the links the console draws, staying on the
 * fleet's pages and one harness's. Answers the fewest links followed to reach
 * each template, and every link that is an old address.
 */
async function walkFromHome(
  session: Session,
  harnessId: string,
): Promise<{ depth: Map<string, number>; legacy: string[] }> {
  const depth = new Map<string, number>();
  const legacy: string[] = [];
  const seen = new Set<string>([HOME_ROUTE]);
  let frontier = [HOME_ROUTE];
  for (let level = 0; frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const href of frontier) {
      const template = templateOf(href);
      if (template !== null && !depth.has(template)) depth.set(template, level);
      await session.visit(href);
      for (const link of await inAppLinks(session.page)) {
        if (redirectFor(link) !== null) legacy.push(`${href} → ${link}`);
        const own =
          !link.startsWith("#/h/") || link.startsWith(`#/h/${encodeURIComponent(harnessId)}`);
        if (!own || seen.has(link)) continue;
        seen.add(link);
        next.push(link);
      }
    }
    frontier = next;
  }
  return { depth, legacy };
}

export const crawl: Journey = {
  id: "crawl",
  shard: "smoke",
  proves:
    "Following the console's own links from Home reaches every route template, each section's page within three links; no link is an old address; every fleet page and every harness screen for every shape renders with no not-found page, no error card, no missing value drawn as a word and no session failure; and reading them changes no byte of any harness directory.",
  run: async (scope) => {
    const grammar = await loadConsoleGrammar();
    const fleet = await scope.fleet({ seed: "crawl" });
    const before = digestFleet(fleet);
    const home = scope.home(fleet);
    const session = await scope.session(home);

    const routes = crawlRoutes(grammar, fleet.harnesses);
    const expected = crawlRouteCount(grammar, grammar.shapeTargets.length);
    if (routes.length !== expected || fleet.harnesses.length !== grammar.shapeTargets.length) {
      throw new Error(
        `the crawl has ${routes.length} routes over ${fleet.harnesses.length} harnesses, not ${expected} over ${grammar.shapeTargets.length}`,
      );
    }

    const notRendered: string[] = [];
    const legacyLinks: string[] = [];
    for (const { route } of routes) {
      await session.visit(route);
      const body = await session.page.locator("body").innerText();
      if (body.includes(NOT_FOUND_TEXT)) notRendered.push(`${route}: ${NOT_FOUND_TEXT}`);
      // A value that was never there, drawn as a word.
      const stray = /^(null|undefined|\[object Object\])$/m.exec(body);
      if (stray !== null) notRendered.push(`${route}: the page shows "${stray[0]}"`);
      const errorCards = await session.page.locator(ERROR_CARD_SELECTOR).count();
      if (errorCards > 0) {
        const text = await session.page.locator(ERROR_CARD_SELECTOR).first().innerText();
        notRendered.push(`${route}: error card: ${text}`);
      }
      for (const link of await inAppLinks(session.page)) {
        if (redirectFor(link) !== null) legacyLinks.push(`${route} → ${link}`);
      }
    }
    if (notRendered.length > 0) {
      throw new Error(`routes did not render:\n  ${notRendered.join("\n  ")}`);
    }

    // The channel shape is the one that can use every screen, so every
    // template has a link to it somewhere.
    const everything = fleet.harnesses.find((harness) => harness.target === "channel");
    if (everything === undefined) throw new Error("the crawl's fleet has no channel harness");
    const walk = await walkFromHome(session, everything.id);
    const unreached = grammar.templates.filter((template) => !walk.depth.has(template));
    if (unreached.length > 0) {
      throw new Error(`no link from Home reaches:\n  ${unreached.join("\n  ")}`);
    }
    const deep = grammar.templates
      .filter((template) => /^#\/h\/:id\/[a-z]+$/.test(template))
      .filter((template) => (walk.depth.get(template) ?? Number.POSITIVE_INFINITY) > SECTION_DEPTH)
      .map((template) => `${template} at ${walk.depth.get(template)}`);
    if (deep.length > 0) {
      throw new Error(`a section's page is more than ${SECTION_DEPTH} links from Home:\n  ${deep}`);
    }
    const old = [...new Set([...legacyLinks, ...walk.legacy])];
    if (old.length > 0) {
      throw new Error(`a link on the page is an old address:\n  ${old.slice(0, 20).join("\n  ")}`);
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
        `${JSON.stringify({ routes: routes.length, walked: walk.depth.size, ...session.counts() }, null, 2)}\n`,
      );
    }
  },
};
