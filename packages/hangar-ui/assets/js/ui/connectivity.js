/**
 * Whether Home can be reached from this tab, as the console's own requests find it: a
 * request that could not reach Home marks it unreachable, and the next one that gets
 * any answer marks it reachable again. Each change is told once, so the shell says
 * "Can't reach Home. Retrying…" once, and "Connected again" once when it is back.
 *
 * No DOM: the shell subscribes and draws the banner.
 */

const listeners = new Set();
let down = false;

/** Tell every listener when reachability changes; answers how to stop listening. */
export function onReachChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What a request found: `true` when Home answered at all, `false` when it could not be reached. */
export function reportReach(reached) {
  const next = reached !== true;
  if (next === down) return;
  down = next;
  for (const listener of [...listeners]) {
    try {
      listener(down ? "down" : "up");
    } catch {
      // A listener that throws never stops the others.
    }
  }
}

/** Whether the last request could not reach Home. */
export function homeUnreachable() {
  return down;
}

/** The banner's words for a change. Pure. */
export function reachWords(state) {
  return state === "down" ? "Can't reach Home. Retrying…" : "Connected again";
}

/** Forget what was seen: for a test. */
export function resetReach() {
  down = false;
  listeners.clear();
}
