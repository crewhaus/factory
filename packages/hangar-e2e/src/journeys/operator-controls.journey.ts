/**
 * Home's controls and its decision card, in a browser:
 *
 * - a decision read and granted on a phone-width screen (320 × 640): the card shows the
 *   request's full input, Grant answers in place, and the page never scrolls sideways;
 * - Home, open in another tab while that happens, counts one fewer item needing you once
 *   its tab comes back, with no reload;
 * - Pause new work on a harness's header asks first, then shows the server's own receipt
 *   sentence and the command that does the same in a terminal.
 */
import { HOME_ROUTE, routeFor } from "../console-routes";
import { settle } from "../settle";
import { waitFor } from "./a11y-states";
import type { Journey } from "./journey";

export const operatorControls: Journey = {
  id: "operator-controls",
  shard: "smoke",
  proves:
    "On a 320 px screen a pending decision shows its full input and is granted in place with no sideways scroll; an open Home counts one fewer item needing you when its tab comes back; Pause new work asks first, then shows the server's receipt sentence and its command-line twin.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "operator-controls", shapes: ["cli"], rich: true });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the fleet has no harness");
    const home = scope.home(fleet);

    // Home, open on another screen while the decision is granted.
    const watcher = await scope.session(home);
    await watcher.visit(HOME_ROUTE);
    const needsYou = watcher.page.locator(".home-status .home-status-part", { hasText: "you" });
    await needsYou.first().waitFor({ timeout: 10_000 });
    const before = Number.parseInt((await needsYou.first().textContent()) ?? "", 10);
    if (!Number.isInteger(before) || before < 1) {
      throw new Error(`Home's status line says "${await needsYou.first().textContent()}"`);
    }

    // A decision, on a phone.
    const phone = await scope.session(home, { viewport: { width: 320, height: 640 } });
    const overview = routeFor("#/h/:id", harness);
    await phone.visit(overview);
    await waitFor(phone.page, ".decision-card", "a decision card on the Overview");
    const card = phone.page.locator(".decision-card").first();
    const input = await card.locator(".decision-input").textContent();
    if (input === null || input.trim() === "") throw new Error("the card shows no input");
    await card.getByRole("button", { name: "Grant" }).click();
    const status = card.locator(".decision-status");
    await phone.page.waitForFunction(
      (node) => {
        const text = node?.textContent ?? "";
        return text !== "" && text !== "Sending…";
      },
      await status.elementHandle(),
      { timeout: 10_000 },
    );
    const answered = (await status.textContent()) ?? "";
    if (answered !== "Grant: sent.") throw new Error(`the grant answered "${answered}"`);
    const wide = await phone.page.evaluate(() => document.documentElement.scrollWidth);
    if (wide > 320) throw new Error(`the page is ${wide} px wide on a 320 px screen`);

    // The open Home reads its status line again when its tab comes back, without a reload.
    const fewer = before - 1;
    await watcher.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await watcher.page.waitForFunction(
      (want) => {
        const parts = [...document.querySelectorAll(".home-status .home-status-part")];
        const text = parts.map((p) => p.textContent ?? "").find((t) => t.includes("you"));
        return want === 0 ? text === undefined : text?.startsWith(`${want} need`) === true;
      },
      fewer,
      { timeout: 15_000 },
    );

    // Pause new work from the header.
    const desk = await scope.session(home);
    await desk.visit(overview);
    await settle(desk.page, overview);
    const pause = desk.page.locator(".harness-controls").getByRole("button", {
      name: "Pause new work",
      exact: true,
    });
    await pause.first().waitFor({ timeout: 10_000 });
    await pause.first().click();
    const confirm = desk.page.locator(".control-detail").getByRole("button", {
      name: "Pause new work",
    });
    await confirm.waitFor({ timeout: 10_000 });
    await confirm.click();
    const said = desk.page.locator(".controls-status");
    await said.filter({ hasText: /Recorded|Paused new work/ }).waitFor({ timeout: 10_000 });
    const twin = await desk.page
      .locator(".harness-controls code.twin-cmd")
      .filter({ hasText: `crewhaus daemon pause ${harness.id}` })
      .count();
    if (twin !== 1) throw new Error("the pause control shows no command-line twin");
  },
};
