/**
 * The owner decides what a plugin sees (#522): an installed plugin waits for the
 * owner's OK and shows nothing; once the owner allows its pane on harness A in
 * Settings › Plugins, the pane is on A and on no other harness, and only A offers
 * "Use in this harness". Focus never falls to the page body: "Not now" hands it
 * back to Review, and a review that went stale meanwhile focuses its notice.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SERVED_NOTHING, grantPlugin, readPluginInventory } from "@crewhaus/hangar-server";
import type { Page } from "playwright";
import { routeFor } from "../console-routes";
import { settle } from "../settle";
import type { Journey } from "./journey";

const RAN = "the granted pane ran";

/** What has focus, as a tag and its text, so a failure names it. */
async function focused(page: Page): Promise<{ tag: string; text: string; cls: string }> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return {
      tag: active?.tagName ?? "",
      text: (active?.textContent ?? "").trim(),
      cls: active instanceof HTMLElement ? active.className : "",
    };
  });
}

export const pluginGrant: Journey = {
  id: "plugin-grant",
  shard: "smoke",
  proves:
    "An installed plugin shows Waiting for your OK and no pane until its owner allows it; allowed on harness A in Settings › Plugins, its pane is on A and not on B.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "plugin-grant", shapes: ["cli", "channel"] });
    const home = scope.home(fleet);
    const [a, b] = fleet.harnesses;
    if (a === undefined || b === undefined) throw new Error("the fleet needs two harnesses");
    const plugin = join(home.pluginsDir, "grant-probe");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      join(plugin, "plugin.json"),
      JSON.stringify({
        name: "grant-probe",
        version: "1.0.0",
        panes: [{ id: "probe", title: "Probe", file: "probe.html" }],
        // It asks to see both harnesses; asking is not being allowed.
        permissions: { fs: [`read:${dirname(a.dir)}/**`] },
        integration: { protocol: "crewhaus.hangar.v1" },
      }),
    );
    writeFileSync(
      join(plugin, "probe.html"),
      `<p id="out">waiting</p><script>document.getElementById("out").textContent = ${JSON.stringify(RAN)};</script>`,
    );
    const session = await scope.session(home, {
      // The stale review below is Home's own 412, which the browser logs.
      expectedStatuses: [{ pathname: "/api/v1/plugins/grant-probe/grant", status: 412 }],
    });
    const { page } = session;

    await session.visit(routeFor("#/h/:id/setup/plugins", a));
    await page.getByText("Waiting for your OK").first().waitFor({ timeout: 10_000 });
    if ((await page.locator("iframe.pane-frame").count()) !== 0) {
      throw new Error("a pane showed before the owner allowed it");
    }

    await session.visit("#/settings/plugins");
    await page.getByText("Waiting for your OK").first().waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Review" }).click();
    await page.locator("form.plugin-review fieldset").first().waitFor({ timeout: 10_000 });
    await page.locator("form.plugin-review").getByRole("button", { name: "Not now" }).click();
    const afterNotNow = await focused(page);
    if (afterNotNow.tag !== "BUTTON" || afterNotNow.text !== "Review") {
      throw new Error(`"Not now" left focus on ${afterNotNow.tag} "${afterNotNow.text}"`);
    }

    await page.getByRole("button", { name: "Review" }).click();
    await page.locator("form.plugin-review fieldset").first().waitFor({ timeout: 10_000 });
    await page.getByRole("checkbox", { name: a.specName, exact: false }).first().check();
    await page.getByRole("checkbox", { name: "probe", exact: true }).check();
    // The access changes behind the open review: a grant on B, with nothing in it.
    const row = readPluginInventory(home.pluginsDir).plugins.find((p) => p.name === "grant-probe");
    if (row === undefined) throw new Error("the planted plugin is not in the inventory");
    const behind = await grantPlugin(home.hangarRoot, {
      row,
      grant: { ...SERVED_NOTHING, harnesses: [b.id] },
      by: "local:e2e",
      cmd: "cmd_e2e",
    });
    if (!behind.ok) throw new Error(`the grant behind the review failed: ${behind.code}`);
    await page.getByRole("button", { name: "Allow selected" }).click();
    await page.locator("form.plugin-review .notice").waitFor({ timeout: 10_000 });
    const afterStale = await focused(page);
    if (!afterStale.cls.split(/\s+/).includes("notice")) {
      throw new Error(`a stale review left focus on ${afterStale.tag} "${afterStale.text}"`);
    }
    for (const name of [a.specName, "probe"]) {
      if (
        !(await page
          .getByRole("checkbox", { name, exact: name === "probe" })
          .first()
          .isChecked())
      ) {
        throw new Error(`the stale review dropped the tick for ${name}`);
      }
    }

    await page.getByRole("button", { name: "Allow selected" }).click();
    await page.getByRole("heading", { name: "Allowed" }).waitFor({ timeout: 10_000 });
    const afterAllow = await focused(page);
    if (afterAllow.tag !== "H4" || afterAllow.text !== "Allowed") {
      throw new Error(`a grant left focus on ${afterAllow.tag} "${afterAllow.text}"`);
    }
    await page.getByRole("button", { name: "Remove access" }).waitFor({ timeout: 10_000 });
    await settle(page, "the grant");

    await session.visit(routeFor("#/h/:id/setup/plugins", a));
    try {
      await page.frameLocator("iframe.pane-frame").getByText(RAN).waitFor({ timeout: 10_000 });
    } catch {
      throw new Error("the granted pane did not show on harness A");
    }
    await page.getByRole("button", { name: "Use in this harness" }).waitFor({ timeout: 10_000 });
    await session.visit(routeFor("#/h/:id/setup/plugins", b));
    await settle(page, "harness B's plugins");
    if ((await page.locator("iframe.pane-frame").count()) !== 0) {
      throw new Error("the pane granted on A showed on B");
    }
    if ((await page.getByRole("button", { name: "Use in this harness" }).count()) !== 0) {
      throw new Error("harness B offers Use in this harness for a plugin allowed on A only");
    }
    session.assertClean();
  },
};
