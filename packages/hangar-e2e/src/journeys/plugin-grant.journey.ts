/**
 * The owner decides what a plugin sees (#522): an installed plugin waits for the
 * owner's OK and shows nothing; once the owner allows its pane on harness A in
 * Settings › Plugins, the pane is on A and on no other harness.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { routeFor } from "../console-routes";
import { settle } from "../settle";
import type { Journey } from "./journey";

const RAN = "the granted pane ran";

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
    const session = await scope.session(home);
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
    await page.getByRole("checkbox", { name: a.specName, exact: false }).first().check();
    await page.getByRole("checkbox", { name: "probe", exact: true }).check();
    await page.getByRole("button", { name: "Allow selected" }).click();
    await page.getByRole("heading", { name: "Allowed" }).waitFor({ timeout: 10_000 });
    await settle(page, "the grant");

    await session.visit(routeFor("#/h/:id/setup/plugins", a));
    try {
      await page.frameLocator("iframe.pane-frame").getByText(RAN).waitFor({ timeout: 10_000 });
    } catch {
      throw new Error("the granted pane did not show on harness A");
    }
    await session.visit(routeFor("#/h/:id/setup/plugins", b));
    await settle(page, "harness B's plugins");
    if ((await page.locator("iframe.pane-frame").count()) !== 0) {
      throw new Error("the pane granted on A showed on B");
    }
    session.assertClean();
  },
};
