/** The console reaches Thredz through the server, and the key stays there. */
import { fakeThredz } from "service-fakes";
import { harnessRoute } from "../console-routes";
import type { Journey } from "./journey";

export const thredzProxy: Journey = {
  id: "thredz-proxy",
  shard: "smoke",
  proves:
    "A harness wired to Thredz shows its tab through the server's proxy, the server sends the key upstream, and the key never appears in anything the browser receives.",
  run: async (scope) => {
    // The tab opens on the wiki list, which the status defaults do not cover.
    const thredz = fakeThredz({
      routes: { "GET /wiki/articles": { status: 200, body: { articles: [] } } },
    });
    scope.defer(() => thredz.stop());
    // Built from parts, and only ever sent to the loopback fake.
    const key = ["thz", "e2e", "0123456789abcdef"].join("_");
    const fleet = await scope.fleet({
      seed: "thredz",
      shapes: ["cli"],
      specExtra: ["thredz:", "  api_key: $THREDZ_API_KEY", `  base_url: ${thredz.baseUrl}`].join(
        "\n",
      ),
      envLines: [`THREDZ_API_KEY=${key}`],
    });
    const [harness] = fleet.harnesses;
    if (harness === undefined) throw new Error("the Thredz fleet has no harness");
    const session = await scope.session(scope.home(fleet));

    const bodies: Array<Promise<string>> = [];
    session.page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/")) {
        bodies.push(response.text().catch(() => ""));
      }
    });
    await session.visit(harnessRoute(harness.id, "thredz"));
    session.assertClean();
    // With a key and an answering workspace, there is no refusal to show.
    if ((await session.page.locator(".error-card").count()) > 0) {
      const text = await session.page.locator(".error-card").first().innerText();
      throw new Error(`the Thredz tab shows a refusal: ${text}`);
    }

    const calls = thredz.calls();
    const stats = calls.find((call) => call.method === "GET" && call.path === "/wiki/stats");
    if (stats === undefined) {
      throw new Error(`the tab did not reach Thredz: ${JSON.stringify(calls)}`);
    }
    if (stats.apiKeyHeader !== "present" && stats.authorization !== "present") {
      throw new Error("the server called Thredz without the key");
    }
    const responses = await Promise.all(bodies);
    if (responses.length === 0) throw new Error("no API response was read, so nothing was checked");
    if (responses.some((body) => body.includes(key))) {
      throw new Error("the key reached the browser in an API response");
    }
    if ((await session.page.content()).includes(key)) {
      throw new Error("the key reached the browser in the document");
    }
  },
};
