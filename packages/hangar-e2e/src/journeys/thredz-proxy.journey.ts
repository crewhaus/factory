/** The console reaches Thredz through the server, and the key stays there. */
import { fakeThredz } from "service-fakes";
import { routeFor } from "../console-routes";
import { responseRecorder, unreadResponses, whereReceived } from "../responses";
import type { Journey } from "./journey";

export const thredzProxy: Journey = {
  id: "thredz-proxy",
  shard: "smoke",
  proves:
    "A harness wired to Thredz shows its tab through the server's proxy, the server sends the key upstream, and from before sign-in on the key is in no response header or body the browser receives.",
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
    // From before sign-in, because the first load is when the harness list arrives.
    const recorder = responseRecorder();
    const session = await scope.session(scope.home(fleet), { onResponse: recorder.observe });
    await session.visit(routeFor("#/h/:id/knowledge/thredz", harness));
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

    const responses = await recorder.received();
    const unread = unreadResponses(responses);
    if (unread.length > 0) throw new Error(`these responses went unread: ${unread.join(", ")}`);
    // The search that finds nothing below must be able to find something: the
    // harness list carries the id, and every response carries a content type.
    if (!whereReceived(responses, harness.id).includes("body of /api/harnesses")) {
      throw new Error("the harness list was not read, so the first load was not checked");
    }
    if (!whereReceived(responses, "text/html").some((place) => place.includes(" header of "))) {
      throw new Error("no response header was read, so headers were not checked");
    }
    const leaks = whereReceived(responses, key);
    if (leaks.length > 0) throw new Error(`the key reached the browser: ${leaks.join(", ")}`);
    if ((await session.page.content()).includes(key)) {
      throw new Error("the key reached the browser in the document");
    }
  },
};
