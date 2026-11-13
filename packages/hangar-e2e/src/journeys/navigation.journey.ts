/**
 * Moving around the console: a slow screen the person has already left never
 * replaces the one they moved to; the narrow shell's Menu reaches every
 * destination without the page scrolling sideways; and a screen's code loads
 * when it is first opened, not before.
 */
import { reflowFinding } from "../a11y/reflow";
import { HOME_ROUTE, routeFor } from "../console-routes";
import { settle } from "../settle";
import { waitFor } from "./a11y-states";
import type { Journey } from "./journey";

/** Screens a cold visit to Home must not fetch: none of them is on Home. */
const NOT_ON_HOME = ["evals", "spec-edit", "memory-fabric", "thredz", "runs"].map(
  (name) => `/assets/js/views/${name}.js`,
);

export const navigation: Journey = {
  id: "navigation",
  shard: "smoke",
  proves:
    "A slow screen the person has left never replaces the screen they moved to, which keeps focus on its heading; at 320 px the Menu opens and reaches every destination with no sideways scroll; and a cold visit to Home fetches none of the heavy screens, which load when first opened.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "navigation", shapes: ["cli"], rich: true });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the fleet has no harness");
    const home = scope.home(fleet);
    const out: string[] = [];

    // A cold load of Home, every request seen from before sign-in.
    const fetched: string[] = [];
    const session = await scope.session(home, {
      label: "navigation",
      onResponse: (response) => {
        fetched.push(new URL(response.url()).pathname);
      },
    });
    const { page } = session;
    await settle(page, HOME_ROUTE);
    const coldModules = fetched.filter((path) => path.endsWith(".js")).length;
    for (const path of NOT_ON_HOME) {
      if (fetched.includes(path)) out.push(`a cold visit to Home fetched ${path}`);
    }
    await session.visit(routeFor("#/h/:id/work/runs", harness));
    if (!fetched.includes("/assets/js/views/runs.js")) {
      out.push("opening Work › Runs did not fetch its screen");
    }

    // Hold the slow screen's harness read, move on to a fast one, then let it answer.
    const slow = routeFor("#/h/:id/setup/spec", harness);
    const detail = new RegExp(`/api/h/${encodeURIComponent(harness.id)}$`);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(detail, async (route) => {
      await held;
      await route.continue();
    });
    // Not through `visit`, which waits for every request: one is being held.
    await page.evaluate((hash) => {
      globalThis.location.hash = hash;
    }, slow);
    await waitFor(page, "#view .skel-line", "the slow screen's skeleton");
    await page.evaluate(() => {
      globalThis.location.hash = "#/settings/readability";
    });
    await waitFor(page, "#readability fieldset", "the fast screen");
    release();
    await settle(page, "#/settings/readability");
    await page.unroute(detail);
    const after = await page.evaluate(() => ({
      hash: globalThis.location.hash,
      headings: [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").trim()),
      focused: document.activeElement?.id ?? "",
      harnessHeader: document.querySelector(".h-head") !== null,
      ready: document.querySelector<HTMLElement>("main#view")?.dataset["ready"] ?? "",
    }));
    if (after.hash !== "#/settings/readability")
      out.push(`the slow screen moved the address to ${after.hash}`);
    if (JSON.stringify(after.headings) !== JSON.stringify(["Readability"])) {
      out.push(`after the slow screen answered the headings are ${JSON.stringify(after.headings)}`);
    }
    if (after.harnessHeader) out.push("the slow screen drew its harness header over the fast one");
    if (after.focused !== "page-title")
      out.push(`focus is on #${after.focused}, not the page heading`);
    if (after.ready !== "#/settings/readability") out.push(`the ready mark says ${after.ready}`);
    session.assertClean();
    await session.close();

    // The narrow shell: the Menu reaches every destination, and nothing scrolls sideways.
    const narrow = await scope.session(home, {
      label: "navigation-narrow",
      viewport: { width: 320, height: 640 },
    });
    const destinations: ReadonlyArray<readonly [string, string]> = [
      ["Home", HOME_ROUTE],
      ["Harnesses", "#/harnesses"],
      ["People", "#/people"],
      ["Connections", "#/connections"],
    ];
    for (const [label, route] of destinations) {
      await narrow.visit(label === "Home" ? "#/settings" : HOME_ROUTE);
      await narrow.page.locator("button.menu-toggle").click();
      await waitFor(narrow.page, "#narrow-menu a", "the open Menu");
      const finding = await reflowFinding(narrow.page);
      if (finding !== undefined) out.push(`the open Menu at 320: ${finding.detail}`);
      await narrow.page.locator("#narrow-menu a", { hasText: label }).first().click();
      await settle(narrow.page, route);
      const heading = await narrow.page.locator("h1").first().textContent();
      if (heading !== label) out.push(`the Menu's ${label} opened "${heading}"`);
      if (await narrow.page.locator("#narrow-menu").isVisible()) {
        out.push(`choosing ${label} left the Menu open`);
      }
      const after320 = await reflowFinding(narrow.page);
      if (after320 !== undefined) out.push(`${label} at 320: ${after320.detail}`);
    }
    narrow.assertClean();

    const artifacts = process.env["HANGAR_E2E_ARTIFACTS"];
    if (artifacts !== undefined && artifacts !== "") {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(
        join(artifacts, "navigation-report.json"),
        `${JSON.stringify({ coldModules }, null, 2)}\n`,
      );
    }
    if (out.length > 0) throw new Error(`navigation broke:\n  ${out.join("\n  ")}`);
  },
};
