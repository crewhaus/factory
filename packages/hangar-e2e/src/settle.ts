/**
 * When a screen has finished arriving. The console has no ready mark yet, so
 * this watches what it does have: every journey goes through this one function,
 * so a mark can replace the heuristic in one place.
 *
 * Settled means no `.skeleton` in the document and no request in flight, other
 * than a live event stream, across consecutive polls. The bound is a wait, not
 * an assertion on time: a route that never settles names itself in the failure.
 */
import type { Page, Request } from "playwright";

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

/** Wait until `route` has settled, or fail naming it. */
export async function settle(page: Page, route: string): Promise<void> {
  const inFlight = trackInFlight(page);
  const skeletons = page.locator(".skeleton");
  const deadline = Date.now() + BOUND_MS;
  let quiet = 0;
  let skeletonCount = 0;
  while (quiet < QUIET_POLLS) {
    if (Date.now() > deadline) {
      const urls = [...inFlight].map((request) => new URL(request.url()).pathname).join(", ");
      throw new Error(
        `route ${route} did not settle within ${BOUND_MS} ms: ${skeletonCount} skeleton(s), ${inFlight.size} request(s) in flight [${urls}]`,
      );
    }
    skeletonCount = await skeletons.count();
    quiet = skeletonCount === 0 && inFlight.size === 0 ? quiet + 1 : 0;
    if (quiet < QUIET_POLLS) await Bun.sleep(POLL_MS);
  }
}
