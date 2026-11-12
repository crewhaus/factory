/**
 * The console's route grammar, and the one file in this package that knows it.
 *
 * Everything comes from the real router, never a hand copy: the route
 * templates (derived there from the destination and section tables), the
 * shape targets, the redirect table and the template filler. A new screen is
 * crawled and swept the day its table row ships. The floors below catch a
 * router that stopped exporting them; they are floors rather than equalities
 * so that adding a screen cannot break an unrelated change.
 */

type RouterModule = {
  readonly ROUTE_TEMPLATES: readonly string[];
  readonly SHAPE_TARGETS: readonly string[];
  redirectFor(hash: string): string | null;
  routeFor(template: string, params?: Readonly<Record<string, string>>): string;
  parseRoute(hash: string): { readonly view: string };
  routeTemplate(route: unknown): string | null;
};

export type ConsoleGrammar = {
  /** Every fleet and harness template the console serves. */
  readonly templates: readonly string[];
  readonly shapeTargets: readonly string[];
};

const FLOOR = { templates: 40, shapeTargets: 14 } as const;

/** hangar-ui exports only its asset map, so the router module is found beside it. */
const router = (await import(
  new URL("../assets/js/router.js", import.meta.resolve("@crewhaus/hangar-ui")).href
)) as RouterModule;

const grammar: ConsoleGrammar = {
  templates: router.ROUTE_TEMPLATES,
  shapeTargets: router.SHAPE_TARGETS,
};

/** The grammar, checked against its floors. */
export async function loadConsoleGrammar(): Promise<ConsoleGrammar> {
  for (const key of Object.keys(FLOOR) as Array<keyof typeof FLOOR>) {
    if (!Array.isArray(grammar[key]) || grammar[key].length < FLOOR[key]) {
      throw new Error(
        `the router's ${key} has ${grammar[key]?.length} entries, under the floor of ${FLOOR[key]}`,
      );
    }
  }
  return grammar;
}

/** Home, where a signed-in tab lands. */
export const HOME_ROUTE = "#/";
/** The harness list (what the Library was). */
export const HARNESSES_ROUTE = "#/harnesses";

/** What a template needs from a harness to be filled in. */
export type RouteHarness = {
  readonly id: string;
  readonly runId?: string;
  readonly sessionIds?: readonly string[];
  readonly wikiSlug?: string;
};

/**
 * A console template filled in from a harness (`:id`, `:run`, `:session`,
 * `:slug`), through the router's own filler. Throws for a template the
 * console does not serve, so a journey cannot visit a typo.
 */
export function routeFor(template: string, harness?: RouteHarness): string {
  if (!router.ROUTE_TEMPLATES.includes(template)) {
    throw new Error(`${template} is not one of the console's route templates`);
  }
  const params: Record<string, string> = {};
  if (harness !== undefined) {
    params["id"] = harness.id;
    if (harness.runId !== undefined) params["run"] = harness.runId;
    const session = harness.sessionIds?.[0];
    if (session !== undefined) params["session"] = session;
    if (harness.wikiSlug !== undefined) params["slug"] = harness.wikiSlug;
  }
  return router.routeFor(template, params);
}

/** Where an address redirects, or null for a new one. The router's own table. */
export function redirectFor(hash: string): string | null {
  return router.redirectFor(hash);
}

/** The template an address stands for (after any redirect), or null for not found. */
export function templateOf(hash: string): string | null {
  return router.routeTemplate(router.parseRoute(hash));
}

/** A route, and the template it stands for. */
export type TemplatedRoute = { readonly template: string; readonly route: string };

const isHarnessTemplate = (template: string): boolean => template.startsWith("#/h/");

/** Every fleet template, once. */
export function fleetRoutes(g: ConsoleGrammar): readonly TemplatedRoute[] {
  return g.templates
    .filter((template) => !isHarnessTemplate(template))
    .map((template) => ({ template, route: routeFor(template) }));
}

/** Every harness template, for one harness. */
export function harnessRoutes(g: ConsoleGrammar, harness: RouteHarness): readonly TemplatedRoute[] {
  return g.templates
    .filter(isHarnessTemplate)
    .map((template) => ({ template, route: routeFor(template, harness) }));
}

/** Every route the crawl walks: the fleet templates, then every harness template per harness. */
export function crawlRoutes(
  g: ConsoleGrammar,
  harnesses: readonly RouteHarness[],
): readonly TemplatedRoute[] {
  return [...fleetRoutes(g), ...harnesses.flatMap((harness) => harnessRoutes(g, harness))];
}

/** What the crawl's route count must equal. */
export function crawlRouteCount(g: ConsoleGrammar, harnesses: number): number {
  const harnessTemplates = g.templates.filter(isHarnessTemplate).length;
  return g.templates.length - harnessTemplates + harnessTemplates * harnesses;
}

/** The text that means no screen answers at this address. */
export const NOT_FOUND_TEXT = "Nothing at this address";
/**
 * The card a screen draws when its request failed. A bare `.error-card` is a
 * different thing: the Thredz screen's banner, which says honestly that a harness has
 * no key or that its workspace did not answer.
 */
export const ERROR_CARD_SELECTOR = ".card.error-card";
