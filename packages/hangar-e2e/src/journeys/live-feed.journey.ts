/**
 * The run view over a long, live stream: thousands of events stay windowed, a reader
 * scrolled up is never moved, a dropped stream resumes after the last event with no
 * repeat and no loss, and a range retention removed shows its marker.
 *
 * The stream is Home's versioned run stream, answered here frame by frame, so the
 * drop and the resume are exact.
 */
import type { Page, Route } from "playwright";
import { routeFor } from "../console-routes";
import { waitFor } from "./a11y-states";
import type { Journey } from "./journey";

const RUN = "run_01m76e6f05hp514w9j4v3qymka";
const FIRST = 3000;
const GAP_WORDS = "Events are missing here: removed by retention";

/** One frame of the stream, as Home writes it. */
function frame(n: number, type: string, payload: Record<string, unknown>): string {
  const id = `c${n}`;
  const data = {
    v: 1,
    id,
    type,
    at: "2026-11-18T00:00:00.000Z",
    ingestedAt: "2026-11-18T00:00:00.000Z",
    run: RUN,
    sensitivity: "operational",
    payload,
  };
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sse(route: Route, body: string): Promise<void> {
  return route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: `: open\n\n${body}`,
  });
}

async function cursors(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".rv-list li[data-cursor]")].map(
      (li) => li.dataset["cursor"] ?? "",
    ),
  );
}

export const liveFeed: Journey = {
  id: "live-feed",
  shard: "smoke",
  proves:
    "Thousands of a run's events draw as a window with Show earlier events; a reader scrolled up stays where they are and is told how many arrived; a dropped stream resumes after the last event drawn, with no event repeated or lost; and a range retention removed shows its marker.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "live-feed", shapes: ["cli"] });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the fleet has no harness");
    const home = scope.home(fleet);
    const session = await scope.session(home);
    const { page } = session;
    const out: string[] = [];

    const resumes: Array<string | null> = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/v1\/runs\/[^/]+\/events/, async (route) => {
      const resume = route.request().headers()["last-event-id"] ?? null;
      resumes.push(resume);
      if (resume === null) {
        let body = frame(0, "run.started", { state: "running" });
        for (let n = 1; n <= FIRST; n += 1) body += frame(n, "run.trace", { traceKind: "handoff" });
        // The connection drops here: no pause, and the run has not ended.
        await sse(route, body);
        return;
      }
      await held;
      let body = frame(FIRST + 1, "stream.gap", { reason: "evicted", source: "trace" });
      for (let n = FIRST + 2; n <= FIRST + 10; n += 1) {
        body += frame(n, "run.trace", { traceKind: "handoff" });
      }
      body += frame(FIRST + 11, "run.succeeded", { state: "succeeded" });
      await sse(route, body);
    });

    await page.evaluate(
      (hash) => {
        globalThis.location.hash = hash;
      },
      `${routeFor("#/h/:id/work/runs", harness)}/${RUN}`,
    );
    await waitFor(page, `.rv-list li[data-cursor="c${FIRST}"]`, "the first batch's last event");

    // Windowed: only a window is drawn, and earlier events are one button away.
    const first = await cursors(page);
    if (first.length > 250) out.push(`${first.length} events drawn at once`);
    if (!(await page.locator(".rv-earlier").isVisible())) out.push("no Show earlier events");

    // The reader scrolls up, then the stream comes back.
    await page.locator(".rv-scroll").evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    release();
    await waitFor(page, ".rv-jump:not([hidden])", "the new-events button");
    const top = await page.locator(".rv-scroll").evaluate((node) => node.scrollTop);
    if (top !== 0) out.push(`the feed moved a reader who had scrolled up, to ${top}`);
    const jump = await page.locator(".rv-jump").innerText();
    if (!/new events? — Jump to latest/.test(jump)) out.push(`the button says "${jump}"`);

    // Resumed after the last event drawn: no repeat, no loss.
    if (resumes[1] !== `c${FIRST}`) out.push(`the stream resumed from ${resumes[1]}`);
    await page.locator(".rv-jump").click();
    await waitFor(page, `.rv-list li[data-cursor="c${FIRST + 11}"]`, "the resumed stream's end");
    const after = await cursors(page);
    if (new Set(after).size !== after.length) out.push("an event was drawn twice");
    const numbers = after.map((c) => Number(c.slice(1)));
    for (let i = 1; i < numbers.length; i += 1) {
      if (numbers[i] !== (numbers[i - 1] as number) + 1) {
        out.push(`events ${numbers[i - 1]} and ${numbers[i]} are not consecutive`);
        break;
      }
    }
    if ((await page.getByText(GAP_WORDS).count()) === 0)
      out.push("no marker for the removed range");
    if (resumes.length !== 2) out.push(`${resumes.length} connections for one drop`);

    if (out.length > 0) throw new Error(`the run view:\n  ${out.join("\n  ")}`);
    session.assertClean();
  },
};
