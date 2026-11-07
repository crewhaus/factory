/** Each of a session's detectors, against a page planted to trip it. */
import { type SessionFailureKind, openSession } from "../session";
import type { Journey } from "./journey";
import { plantedHtml, servePlantedPages } from "./planted-pages";

const script = (path: string): string => `<script type="module" src="${path}"></script>`;

const js = (body: string) => ({ type: "text/javascript", body });

const PLANTS: Readonly<Record<string, SessionFailureKind>> = {
  "console-error": "console-error",
  "page-error": "page-error",
  "csp-violation": "csp-violation",
  // An asset can fail two ways: an answer that is not 2xx, and no answer at all.
  "asset-404": "failed-asset",
  "asset-unreachable": "failed-asset",
  "server-error": "server-error",
  sentinel: "sentinel",
};

export const sessionSelfTest: Journey = {
  id: "session-self-test",
  shard: "smoke",
  proves:
    "Each detector a session relies on catches a page planted to trip it, and none fires on a clean page, so a journey cannot pass over a page that broke.",
  run: async (scope) => {
    // A port nothing is listening on any more, for an asset that cannot be fetched.
    const gone = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      development: false,
      fetch: () => new Response(),
    });
    const unreachable = `http://127.0.0.1:${gone.port}/assets/unreachable.js`;
    await gone.stop();

    const server = servePlantedPages(
      {
        clean: { html: plantedHtml(`<h1>Clean</h1>${script("/assets/clean.js")}`) },
        "console-error": { html: plantedHtml(script("/assets/console-error.js")) },
        "page-error": { html: plantedHtml(script("/assets/page-error.js")) },
        "csp-violation": { html: plantedHtml("<script>globalThis.__planted = 1</script>") },
        "asset-404": { html: plantedHtml(script("/assets/fetch-missing.js")) },
        "asset-unreachable": { html: plantedHtml(script(unreachable)), csp: false },
        "server-error": { html: plantedHtml(script("/assets/server-error.js")) },
        sentinel: { html: plantedHtml(script("/assets/sentinel.js")) },
        "api-404": { html: plantedHtml(script("/assets/api-404.js")) },
      },
      {
        "/assets/clean.js": js("document.title = 'Clean';"),
        "/assets/console-error.js": js("console.error('planted');"),
        "/assets/page-error.js": js("throw new Error('planted');"),
        "/assets/fetch-missing.js": js("await fetch('/assets/missing.json');"),
        "/assets/server-error.js": js("await fetch('/api/boom');"),
        "/assets/sentinel.js": js("globalThis.__e2eSentinel = 1;"),
        "/assets/api-404.js": js("await fetch('/api/nothing-here');"),
      },
      { "/api/boom": () => new Response("boom", { status: 500 }) },
    );
    scope.defer(() => server.stop());

    for (const [page, expected] of Object.entries(PLANTS)) {
      const session = await openSession(server.home(page), { label: `self-test-${page}` });
      const kinds = session.failures().map((failure) => failure.kind);
      await session.close({ trace: "discard" });
      if (!kinds.includes(expected)) {
        throw new Error(`the ${expected} detector went quiet on its plant: saw [${kinds}]`);
      }
    }

    const assertQuiet = async (page: string): Promise<void> => {
      const session = await openSession(server.home(page), { label: `self-test-${page}` });
      const failures = session.failures();
      await session.close();
      if (failures.length > 0) {
        throw new Error(`a detector fired on ${page}: ${JSON.stringify(failures)}`);
      }
    };
    await assertQuiet("clean");
    // A 404 from the API is how the client learns something is absent.
    await assertQuiet("api-404");
  },
};
