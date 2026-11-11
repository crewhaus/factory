/** The ways into the console. */
import { LIBRARY_ROUTE } from "../console-routes";
import { openPlainPage, signInPath } from "../session";
import { settle, trackInFlight } from "../settle";
import type { Journey } from "./journey";

/** Two P-256 public keys, as a browser would send them. */
async function publicJwk(
  usage: "ECDSA" | "ECDH",
): Promise<{ kty: string; crv: string; x: string; y: string }> {
  const pair = (await crypto.subtle.generateKey(
    { name: usage, namedCurve: "P-256" },
    true,
    usage === "ECDSA" ? ["sign", "verify"] : ["deriveBits"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string };
}

export const signIn: Journey = {
  id: "sign-in",
  shard: "smoke",
  proves:
    "The boot link signs a browser in with its own key and leaves no code or key in the address; a boot link and its code each work once; a tab with nothing gets the sign-in screen, where Home's own key is refused unsent and a pasted link works; and a reload after the session is gone signs in again with the browser's key alone.",
  run: async (scope) => {
    const fleet = await scope.fleet({ seed: "sign-in", shapes: ["cli"] });
    const home = scope.home(fleet);
    const spent = home.bootPath;
    let code: string | undefined;

    const session = await scope.session(home, {
      onResponse: (response) => {
        const location = response.headers()["location"] ?? "";
        const match = /^\/#x=([A-Za-z0-9_-]+)$/.exec(location);
        if (match !== null) code = match[1];
      },
    });
    const landed = session.page.url();
    for (const fragment of ["#x=", "#t=", home.token]) {
      if (landed.includes(fragment)) throw new Error(`signing in left ${fragment} in the address`);
    }
    if (new URL(landed).hash !== LIBRARY_ROUTE) {
      throw new Error(`signing in landed on ${landed}, not the Library`);
    }
    const harnessName = fleet.harnesses[0]?.specName ?? "";
    if ((await session.page.getByText(harnessName).count()) === 0) {
      throw new Error("the Library does not show the seeded harness after signing in");
    }
    const stored = await session.page.evaluate(
      () => sessionStorage.getItem("hangar.session") ?? "",
    );
    if (!/^cha_[A-Za-z0-9_-]{43}$/.test(stored)) throw new Error("the tab holds no session");
    if (await session.page.evaluate(() => sessionStorage.getItem("hangar.token") !== null)) {
      throw new Error("the tab holds Home's own key");
    }

    // A reload with the session gone signs in again with the browser's own key.
    await session.page.evaluate(() => sessionStorage.removeItem("hangar.session"));
    await session.page.reload();
    await settle(session.page, "a reload with no session");
    if ((await session.page.getByText(harnessName).count()) === 0) {
      throw new Error("a reload with no session did not sign in with the browser's key");
    }
    if ((await session.page.getByRole("heading", { name: "Sign in to Home" }).count()) !== 0) {
      throw new Error("a reload with the browser's key still showed the sign-in screen");
    }
    session.assertClean();

    // The code the boot link carried was spent by the first exchange.
    if (code === undefined) throw new Error("the boot link's redirect was not seen");
    const replay = await fetch(`${home.url}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        deviceJwk: await publicJwk("ECDSA"),
        seal: await publicJwk("ECDH"),
      }),
    });
    if (replay.status !== 401)
      throw new Error(`a replayed code answered ${replay.status}, not 401`);

    // These use a plain page: a spent ticket's 404 logs a console error by design.
    const spentPage = await openPlainPage();
    scope.defer(() => spentPage.close());
    const second = await spentPage.page.goto(`${home.url}${spent}`);
    if (second?.status() !== 404) {
      throw new Error(`a spent boot link answered ${second?.status()}, not 404`);
    }

    const fresh = await openPlainPage();
    scope.defer(() => fresh.close());
    trackInFlight(fresh.page);
    await fresh.page.goto(`${home.url}/`);
    await fresh.page.getByRole("heading", { name: "Sign in to Home" }).waitFor();
    await settle(fresh.page, "the sign-in screen");
    const input = fresh.page.getByLabel("Sign-in link");

    // Home's own key is recognised and refused before anything is sent.
    const sentBefore: string[] = [];
    fresh.page.on("request", (request) => sentBefore.push(new URL(request.url()).pathname));
    await input.fill(home.token);
    await input.press("Enter");
    await fresh.page.getByText("That is Home's own key").waitFor();
    if (sentBefore.length !== 0)
      throw new Error(`pasting Home's key sent ${sentBefore.join(", ")}`);
    if ((await input.inputValue()) !== "") throw new Error("Home's key stayed in the field");

    // A pasted boot link signs the tab in.
    await input.fill(`${home.url}${await signInPath(home)}`);
    await input.press("Enter");
    await fresh.page.getByText(harnessName).first().waitFor();
    await settle(fresh.page, "after pasting a boot link");
    if ((await fresh.page.getByLabel("Sign-in link").count()) !== 0) {
      throw new Error("the sign-in screen is still up after pasting a good link");
    }
    if (fresh.page.url().includes("#x=")) throw new Error("the code stayed in the address");
  },
};
