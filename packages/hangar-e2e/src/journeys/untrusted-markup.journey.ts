/** Outside text stays text. */
import type { Page } from "playwright";
import { crawlRoutes, loadConsoleGrammar, routeFor } from "../console-routes";
import { MARKUP_PAYLOAD, MARKUP_VISIBLE } from "../seed/fleet";
import { settle } from "../settle";
import { pressSpecSave } from "./a11y-states";
import type { Journey } from "./journey";

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** The text of the first match, once it is visible. */
async function shownText(page: Page, selector: string, what: string): Promise<string> {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    throw new Error(`${what} never showed (${selector})`);
  }
  return (await page.locator(selector).first().innerText()) ?? "";
}

/** Sessions, a transcript, memory, feedback, a run log and the wiki each show it. */
const MIN_SCREENS_SHOWING_PAYLOAD = 5;

export const untrustedMarkup: Journey = {
  id: "untrusted-markup",
  shard: "smoke",
  proves:
    "Script planted in a session, a wiki article, a memory, feedback, a run log, focus and goals, and in what the server sends to a toast, a tooltip, a chart label, a dialog title and a conflict diff, renders as literal text wherever the console shows it and never runs.",
  run: async (scope) => {
    const grammar = await loadConsoleGrammar();
    const fleet = await scope.fleet({ seed: "markup", shapes: ["cli"], markup: true });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the markup fleet has no harness");
    const patchPath = `/api/h/${encodeURIComponent(harness.id)}/spec/patch`;
    const session = await scope.session(scope.home(fleet), {
      expectedStatuses: [{ pathname: patchPath, status: 412 }],
    });

    // Every route, the deep ones (a transcript, a run, a wiki article) included.
    const routes = crawlRoutes(grammar, [harness]).map(({ route }) => route);
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
    const wiki = routeFor("#/h/:id/knowledge/wiki/:slug", harness);
    if (!visibleOn.includes(wiki)) {
      throw new Error(`the wiki article did not show the payload as text; on: ${visibleOn}`);
    }

    // The components that show what a server sends: each is handed the
    // payload, and each must show it as characters.
    const { page } = session;
    const id = encodeURIComponent(harness.id);
    await page.route("**/api/notifications", (route) =>
      route.fulfill(
        json({
          badge: 1,
          rules: [],
          // A delivery is announced once, by the tick time it carries.
          delivered: [{ label: MARKUP_PAYLOAD, at: new Date().toISOString() }],
        }),
      ),
    );
    await page.route(`**/api/h/${id}/advisor/reports`, (route) =>
      route.fulfill(json({ kinds: [MARKUP_PAYLOAD], reports: [] })),
    );
    await page.route(`**/api/h/${id}/costs`, (route) =>
      route.fulfill(
        json({
          id: harness.id,
          costs: {
            calls: 1,
            spend7dUsdMicros: 1200,
            byModel: [],
            days: [{ day: MARKUP_PAYLOAD, usdMicros: 1200 }],
          },
        }),
      ),
    );
    await page.route(`**/api/h/${id}/spec/versions`, (route) =>
      route.fulfill(
        json({
          present: true,
          dir: ".crewhaus/specs",
          versions: [{ version: MARKUP_PAYLOAD, present: true, pinnedEnvs: [] }],
          pins: {},
          confirmName: "fleet-cli",
        }),
      ),
    );
    await page.route(`**/api/h/${id}/spec/versions/*`, (route) =>
      route.fulfill(json({ present: true, yaml: "name: fleet-cli\n" })),
    );
    await page.route(`**${patchPath}`, (route) =>
      route.fulfill({
        status: 412,
        contentType: "application/json",
        body: JSON.stringify({ error: "changed", current: { rev: "r2", diff: MARKUP_PAYLOAD } }),
      }),
    );
    const components: Record<string, string> = {};
    // The notification poll runs at boot.
    await page.reload();
    await settle(page, "a reload");
    components["toast"] = await shownText(page, ".toast", "the notification toast");

    await session.visit(routeFor("#/h/:id/overview/needs-you", harness));
    const reportButton = page.locator("button[data-tip]", { hasText: "Generate" }).first();
    await reportButton.focus();
    components["tooltip"] = await shownText(page, ".tip", "the report tooltip");

    await session.visit(routeFor("#/h/:id/setup/budget", harness));
    await page.locator("figure.chart summary").first().click();
    components["chart label"] = await shownText(page, "figure.chart td", "the chart's data table");

    await session.visit(routeFor("#/h/:id/setup/spec", harness));
    await page.getByRole("button", { name: "View", exact: true }).first().click();
    components["dialog title"] = await shownText(page, "dialog[open] h2", "the version dialog");
    await page.keyboard.press("Escape");
    await pressSpecSave(page);
    components["conflict diff"] = await shownText(
      page,
      "dialog[open] .conflict-diff",
      "the conflict view",
    );
    await page.keyboard.press("Escape");

    const missing = Object.entries(components)
      .filter(([, text]) => !text.includes(MARKUP_VISIBLE))
      .map(([what, text]) => `${what}: ${text.slice(0, 80)}`);
    if (missing.length > 0) {
      throw new Error(`these did not show the payload as text:\n  ${missing.join("\n  ")}`);
    }
    session.assertClean();
    const after = await page.evaluate(
      () => (globalThis as unknown as { __e2eSentinel?: unknown }).__e2eSentinel,
    );
    if (after !== undefined) throw new Error(`the sentinel was set to ${String(after)}`);
  },
};
