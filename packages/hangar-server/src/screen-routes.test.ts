/**
 * Every console screen the server names lands on a real screen. The health
 * score and the advisor say where a fix belongs by a screen id; the console
 * turns that id into a link with its own builders. Each id is sent through
 * them here, by the console's real router, and must land on a screen — not
 * on "Nothing at this address", and not on an address that still redirects.
 */
import { describe, expect, test } from "bun:test";
import { ADVISOR_SCREENS } from "./advisor";
import { HEALTH_SCREENS } from "./health";

type Route = { readonly view: string; readonly section?: string; readonly sub?: string | null };
type Router = {
  hrefHarness(id: string, tab?: string, ...rest: string[]): string;
  hrefGlobal(view: string): string;
  parseRoute(hash: string): Route;
  redirectFor(hash: string): string | null;
};

/** The console's router, loaded by URL: a browser module, outside this program. */
async function loadRouter(): Promise<Router> {
  const url = new URL("../../hangar-ui/assets/js/router.js", import.meta.url).href;
  return (await import(url)) as Router;
}

const router = await loadRouter();
const ID = "hrn_0123456789abcdef";

/** The link the console builds for a server screen id, as its views build it
 *  (`itemActionModel` in the advisor view, `deductionRow` in the health view):
 *  the approvals inbox is a fleet screen, everything else is on the harness. */
function linkFor(screen: string): string {
  return screen === "approvals" ? router.hrefGlobal(screen) : router.hrefHarness(ID, screen);
}

describe("every screen the server names", () => {
  const screens = [...new Set<string>([...HEALTH_SCREENS, ...ADVISOR_SCREENS])].sort();

  test("is the full set, so the check below covers what the server sends", () => {
    expect(HEALTH_SCREENS.length).toBe(16);
    expect(ADVISOR_SCREENS.length).toBe(15);
    expect(screens.length).toBe(18);
  });

  test("lands on a screen through the console's builders, and never redirects again", () => {
    for (const screen of screens) {
      const href = linkFor(screen);
      const route = router.parseRoute(href);
      expect(`${screen} → ${href}: ${route.view}`).not.toBe(`${screen} → ${href}: notfound`);
      expect(`${screen} → ${router.redirectFor(href)}`).toBe(`${screen} → null`);
    }
  });

  test("a harness screen lands in a harness section; the approvals inbox on Needs you", () => {
    for (const screen of screens.filter((s) => s !== "approvals")) {
      expect(`${screen}:${router.parseRoute(linkFor(screen)).view}`).toBe(`${screen}:harness`);
    }
    expect(router.parseRoute(linkFor("approvals"))).toMatchObject({
      view: "home",
      sub: "needs-you",
    });
  });
});
