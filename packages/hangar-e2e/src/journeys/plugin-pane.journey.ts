/**
 * A plugin pane's own script runs, under its own policy, while the console keeps its
 * strict one. A pane in a `srcdoc` frame would inherit the console's policy, which runs
 * no inline script; the pane loads from a single-use address that serves the plugin's
 * policy and the sandbox as headers instead. The session fails on any policy violation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { routeFor } from "../console-routes";
import type { Journey } from "./journey";

/** What the planted pane's own script writes, so the journey can tell it ran. */
const RAN = "the pane's own script ran";

export const pluginPane: Journey = {
  id: "plugin-pane",
  shard: "smoke",
  proves:
    "A plugin pane's own inline script runs in its sandboxed frame under the plugin's policy, the console raises no policy violation, and the pane's address works once.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "plugin-pane", shapes: ["cli"] });
    const home = scope.home(fleet);
    const harness = fleet.harnesses[0];
    if (harness === undefined) throw new Error("the fleet has no harness");
    const plugin = join(home.pluginsDir, "pane-probe");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      join(plugin, "plugin.json"),
      JSON.stringify({
        name: "pane-probe",
        version: "1.0.0",
        panes: [{ id: "probe", title: "Probe", file: "probe.html" }],
        permissions: { fs: [`read:${dirname(harness.dir)}/**`] },
      }),
    );
    writeFileSync(
      join(plugin, "probe.html"),
      `<p id="out">waiting</p><script>document.getElementById("out").textContent = ${JSON.stringify(RAN)};</script>`,
    );

    const panes: string[] = [];
    const session = await scope.session(home, {
      onResponse: (response) => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith("/pane/")) panes.push(`${path} ${response.status()}`);
      },
    });
    await session.visit(routeFor("#/h/:id/setup/plugins", harness));
    const frame = session.page.frameLocator("iframe.pane-frame");
    try {
      await frame.getByText(RAN).waitFor({ timeout: 10_000 });
    } catch {
      throw new Error("the pane's own script did not run in its frame");
    }
    const sandbox = await session.page.locator("iframe.pane-frame").getAttribute("sandbox");
    if (sandbox !== "allow-scripts") throw new Error(`the pane frame's sandbox is "${sandbox}"`);
    if (panes.length !== 1 || !panes[0]?.endsWith(" 200")) {
      throw new Error(`the pane loaded as ${panes.join(", ") || "nothing"}`);
    }
    const again = await fetch(`${home.url}${panes[0].split(" ")[0]}`);
    if (again.status !== 404) throw new Error(`a spent pane address answered ${again.status}`);
    session.assertClean();
  },
};
