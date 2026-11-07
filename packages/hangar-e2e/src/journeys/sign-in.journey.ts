/** The ways into the console. */
import { LIBRARY_ROUTE } from "../console-routes";
import { openPlainPage } from "../session";
import { settle, trackInFlight } from "../settle";
import type { Journey } from "./journey";

export const signIn: Journey = {
  id: "sign-in",
  shard: "smoke",
  proves:
    "The boot path signs a browser in and leaves no token in the URL, a boot ticket works once, and a tab with no token gets the token screen, where a pasted token works.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "sign-in", shapes: ["cli"] });
    const home = scope.home(fleet);
    const spent = home.bootPath;

    const session = await scope.session(home);
    const landed = session.page.url();
    if (landed.includes("#t=") || landed.includes(home.token)) {
      throw new Error("the token is still in the URL after signing in");
    }
    if (new URL(landed).hash !== LIBRARY_ROUTE) {
      throw new Error(`signing in landed on ${landed}, not the Library`);
    }
    if ((await session.page.getByText(fleet.harnesses[0]?.specName ?? "").count()) === 0) {
      throw new Error("the Library does not show the seeded harness after signing in");
    }
    session.assertClean();

    // These two use a plain page: a spent ticket's 404 and a missing token's 401
    // each log a console error by design, and a session would rightly fail on them.
    const replay = await openPlainPage();
    scope.defer(() => replay.close());
    const second = await replay.page.goto(`${home.url}${spent}`);
    if (second?.status() !== 404) {
      throw new Error(`a spent boot ticket answered ${second?.status()}, not 404`);
    }

    const fresh = await openPlainPage();
    scope.defer(() => fresh.close());
    trackInFlight(fresh.page);
    await fresh.page.goto(`${home.url}/`);
    const input = fresh.page.getByLabel("Hangar token");
    await input.waitFor();
    // Every request a tab with no token sends answers 401, and each one puts the
    // token screen up again, so a paste faster than a person waits for the last.
    await settle(fresh.page, "the token screen");
    await input.fill(home.token);
    await input.press("Enter");
    await fresh.page
      .getByText(fleet.harnesses[0]?.specName ?? "")
      .first()
      .waitFor();
    await settle(fresh.page, "after pasting a token");
    if ((await fresh.page.getByLabel("Hangar token").count()) !== 0) {
      throw new Error("the token screen is still up after pasting a good token");
    }
  },
};
