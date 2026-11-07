/**
 * The console's route grammar, and the one file in this package that knows it.
 *
 * The lists come from the real router, never a hand copy, so a new tab is
 * crawled the day it ships. The floors below catch a router that stopped
 * exporting them; they are floors rather than equalities so that adding a tab
 * cannot break an unrelated change.
 */

export type ConsoleGrammar = {
  readonly globalViews: readonly string[];
  readonly harnessTabs: readonly string[];
  readonly shapeTargets: readonly string[];
};

const FLOOR = { globalViews: 10, harnessTabs: 20, shapeTargets: 14 } as const;

let loaded: Promise<ConsoleGrammar> | undefined;

/** Read the three lists out of hangar-ui's real router module. */
export function loadConsoleGrammar(): Promise<ConsoleGrammar> {
  loaded ??= (async () => {
    // hangar-ui exports only its asset map, so the module is found beside it.
    const entry = import.meta.resolve("@crewhaus/hangar-ui");
    const router = (await import(new URL("../assets/js/router.js", entry).href)) as {
      readonly GLOBAL_VIEWS: readonly string[];
      readonly HARNESS_TABS: readonly string[];
      readonly SHAPE_TARGETS: readonly string[];
    };
    const grammar: ConsoleGrammar = {
      globalViews: router.GLOBAL_VIEWS,
      harnessTabs: router.HARNESS_TABS,
      shapeTargets: router.SHAPE_TARGETS,
    };
    for (const key of Object.keys(FLOOR) as Array<keyof typeof FLOOR>) {
      if (!Array.isArray(grammar[key]) || grammar[key].length < FLOOR[key]) {
        throw new Error(
          `the router's ${key} has ${grammar[key]?.length} entries, under the floor of ${FLOOR[key]}`,
        );
      }
    }
    return grammar;
  })();
  return loaded;
}

export const LIBRARY_ROUTE = "#/";

export const globalRoute = (view: string): string => `#/${view}`;

const harnessBase = (id: string): string => `#/h/${encodeURIComponent(id)}`;

export const harnessRoute = (id: string, tab: string): string => `${harnessBase(id)}/${tab}`;

export const sessionRoute = (id: string, sessionId: string): string =>
  `${harnessBase(id)}/sessions/${encodeURIComponent(sessionId)}`;

export const runRoute = (id: string, runId: string): string =>
  `${harnessBase(id)}/runs/${encodeURIComponent(runId)}`;

export const wikiRoute = (id: string, slug: string): string =>
  `${harnessBase(id)}/memory/wiki/${encodeURIComponent(slug)}`;

/** A route, and the template it stands for with the harness id taken out. */
export type TemplatedRoute = { readonly template: string; readonly route: string };

/** The Library, then every fleet-wide screen. */
export function fleetRoutes(grammar: ConsoleGrammar): readonly TemplatedRoute[] {
  return [
    { template: LIBRARY_ROUTE, route: LIBRARY_ROUTE },
    ...grammar.globalViews.map((view) => ({
      template: globalRoute(view),
      route: globalRoute(view),
    })),
  ];
}

/** Every tab, for one harness. */
export function harnessRoutes(grammar: ConsoleGrammar, id: string): readonly TemplatedRoute[] {
  return grammar.harnessTabs.map((tab) => ({
    template: harnessRoute(":id", tab).replace("%3Aid", ":id"),
    route: harnessRoute(id, tab),
  }));
}

/** Every route the crawl walks: fleet screens, then every tab of every harness. */
export function crawlRoutes(
  grammar: ConsoleGrammar,
  harnessIds: readonly string[],
): readonly TemplatedRoute[] {
  return [...fleetRoutes(grammar), ...harnessIds.flatMap((id) => harnessRoutes(grammar, id))];
}

/** What the crawl's route count must equal. */
export function crawlRouteCount(grammar: ConsoleGrammar, harnesses: number): number {
  return 1 + grammar.globalViews.length + grammar.harnessTabs.length * harnesses;
}

/** The text that means no screen answers at this address. */
export const NOT_FOUND_TEXT = "Nothing at this address";
/**
 * The card a screen draws when its request failed. A bare `.error-card` is a
 * different thing: the Thredz tab's banner, which says honestly that a harness has
 * no key or that its workspace did not answer.
 */
export const ERROR_CARD_SELECTOR = ".card.error-card";
