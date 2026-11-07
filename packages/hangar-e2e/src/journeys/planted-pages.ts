/** A small server for planted pages, under the strict CSP a self-test needs. */

/**
 * Nothing inline, nothing from elsewhere. A page's own stylesheet and script are
 * served as files, so every plant has to work the way a page under this policy
 * really would.
 */
export const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'";

export type PlantedAsset = { readonly type: string; readonly body: string };
export type PlantedPage = {
  /** The whole HTML document. */
  readonly html: string;
  /** Sends the strict CSP header. Default true. */
  readonly csp?: boolean;
};

export type PlantedServer = {
  readonly url: string;
  /** The address `openSession` needs to land on a page. */
  home(page: string): { readonly url: string; readonly bootPath: string; readonly token: string };
  stop(): Promise<void>;
};

/** Serve `pages` at `/p/<name>`, and `assets` at their paths. Any other path is a 404. */
export function servePlantedPages(
  pages: Readonly<Record<string, PlantedPage>>,
  assets: Readonly<Record<string, PlantedAsset>> = {},
  routes: Readonly<Record<string, () => Response>> = {},
): PlantedServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      const route = routes[pathname];
      if (route !== undefined) return route();
      const asset = assets[pathname];
      if (asset !== undefined) {
        return new Response(asset.body, { headers: { "content-type": asset.type } });
      }
      const page = pages[pathname.slice("/p/".length)];
      if (!pathname.startsWith("/p/") || page === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(page.html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...(page.csp === false ? {} : { "content-security-policy": STRICT_CSP }),
        },
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    home: (page) => ({ url, bootPath: `/p/${page}`, token: "planted" }),
    stop: async () => {
      await server.stop();
    },
  };
}

/** A minimal page with a language and a title, so a plant is the only finding. */
export function plantedHtml(body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Planted</title>${head}</head><body>${body}</body></html>`;
}
