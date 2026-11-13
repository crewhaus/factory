/**
 * When a screen has finished arriving. Every journey goes through this one
 * function.
 *
 * The console marks a screen arrived: `main#view` carries `data-ready` set to
 * the template of the route it drew, once the current navigation has drawn
 * (or drawn its error). Settled means that mark is there — equal to the
 * visited route's template when `route` is an address — and, as before, no
 * `.skeleton` in the document and no request in flight other than a live
 * event stream, across consecutive polls. The sign-in screen is drawn before
 * the router starts and has no mark, so it settles on the quiet polls alone.
 * The bound is a wait, not an assertion on time: a route that never settles
 * names itself in the failure.
 */
import type { Page, Request } from "playwright";
import { templateOf } from "./console-routes";

const POLL_MS = 25;
const QUIET_POLLS = 4;
const BOUND_MS = 15_000;

const inFlightByPage = new WeakMap<Page, Set<Request>>();

const isEventStream = (request: Request): boolean =>
  request.headers()["accept"]?.includes("text/event-stream") === true;

/**
 * Start counting a page's requests. A session calls this before it navigates,
 * since a request already under way when counting starts would be invisible.
 */
export function trackInFlight(page: Page): Set<Request> {
  const existing = inFlightByPage.get(page);
  if (existing !== undefined) return existing;
  const inFlight = new Set<Request>();
  inFlightByPage.set(page, inFlight);
  page.on("request", (request) => {
    if (!isEventStream(request)) inFlight.add(request);
  });
  const done = (request: Request): void => {
    inFlight.delete(request);
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  // The client never reads the body of a 401 or a 404, and the browser may never
  // report such a request finished. Nothing is coming after these headers.
  page.on("response", (response) => {
    if (response.status() < 200 || response.status() >= 300) done(response.request());
  });
  return inFlight;
}

/**
 * What the ready mark says now: the template, `""` when the shell is drawn
 * but the screen has not arrived, or null when there is no shell (the
 * sign-in screen, or a page between documents).
 */
async function readyMark(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      if (document.querySelector(".app-header") === null) return null;
      return document.querySelector<HTMLElement>("main#view")?.dataset["ready"] ?? "";
    });
  } catch {
    return ""; // the document is being replaced: not ready yet
  }
}

/** Wait until `route` has settled, or fail naming it. */
export async function settle(page: Page, route: string): Promise<void> {
  const inFlight = trackInFlight(page);
  const skeletons = page.locator(".skeleton");
  const deadline = Date.now() + BOUND_MS;
  // An address names the screen that must arrive; a label ("a reload") only
  // asks for whichever screen is current to have arrived.
  const isAddress = route.startsWith("#") && !/\s/.test(route);
  const expected = isAddress ? (templateOf(route) ?? "notfound") : null;
  let quiet = 0;
  let skeletonCount = 0;
  let mark: string | null = null;
  while (quiet < QUIET_POLLS) {
    if (Date.now() > deadline) {
      const urls = [...inFlight].map((request) => new URL(request.url()).pathname).join(", ");
      throw new Error(
        `route ${route} did not settle within ${BOUND_MS} ms: ${skeletonCount} skeleton(s), ${inFlight.size} request(s) in flight [${urls}], ready mark ${JSON.stringify(mark)}${expected === null ? "" : ` (waiting for ${expected})`}`,
      );
    }
    skeletonCount = await skeletons.count();
    mark = await readyMark(page);
    const arrived = mark === null || (mark !== "" && (expected === null || mark === expected));
    quiet = arrived && skeletonCount === 0 && inFlight.size === 0 ? quiet + 1 : 0;
    if (quiet < QUIET_POLLS) await Bun.sleep(POLL_MS);
  }
}
