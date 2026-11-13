/**
 * One navigation at a time, and only the newest one gets to finish.
 *
 * Each `navigate(route)` aborts the previous navigation's controller, mounts
 * a fresh container for this one (attached at once, so a view that checks
 * where it is, or focuses a node, behaves as it always has), awaits the
 * render, and runs `after` only if this navigation is still the current one.
 * A slow screen the person has already left can still finish its requests,
 * but it writes into a removed container and its `after` never runs: it can
 * never replace, focus or announce over the screen they moved on to.
 *
 * DOM-free: the caller supplies `mount`, `render`, `after` and the two error
 * paths, so the ordering is unit-tested with fake containers.
 */

/**
 * `{ mount(route, signal) → container, render(route, container, { signal }),
 *    after?(route, container, result), onError?(err, container, route),
 *    isStale?(err) → boolean, onStale?(route, container) }`
 *
 * `navigate` resolves to what happened: `"done"`, `"superseded"`, `"error"`
 * or `"stale"` (a sign-in is needed; the container keeps its skeleton and
 * the next sign-in draws the route again).
 */
export function createNavigator(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  let current = null;

  async function navigate(route) {
    if (current !== null) current.controller.abort();
    const controller = new AbortController();
    const entry = { route, controller, container: null };
    current = entry;
    entry.container = o.mount(route, controller.signal);
    let result;
    try {
      result = await o.render(route, entry.container, { signal: controller.signal });
    } catch (err) {
      if (current !== entry) return "superseded";
      if (typeof o.isStale === "function" && o.isStale(err)) {
        if (typeof o.onStale === "function") o.onStale(route, entry.container);
        return "stale";
      }
      if (typeof o.onError === "function") o.onError(err, entry.container, route);
      return "error";
    }
    if (current !== entry) return "superseded";
    if (typeof o.after === "function") o.after(route, entry.container, result);
    return "done";
  }

  return {
    navigate,
    /** The route of the newest navigation, or null before the first. */
    route: () => (current === null ? null : current.route),
    /** The newest navigation's signal, or null before the first. */
    signal: () => (current === null ? null : current.controller.signal),
  };
}
