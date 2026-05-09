/**
 * Render the playground SPA shell. Production deployments serve this
 * from `crewhaus-cloud` behind §20 gateway-server with a CDN cache; the
 * actual UI is a Monaco editor + a trace-viewer iframe pointing at
 * §31 studio-server.
 *
 * The renderer is a pure function so we can snapshot-test it. No DOM /
 * Lit imports here — just an HTML string the SPA bootstraps in the
 * browser.
 */
import { templateMenuEntries } from "./templates";

export type RenderIndexOptions = {
  readonly title?: string;
  readonly studioUrl: string;
  readonly oauthClientId?: string;
  /** Inline CSP nonce for production. */
  readonly cspNonce?: string;
};

export function playgroundIndexHtml(opts: RenderIndexOptions): string {
  const title = escapeHtml(opts.title ?? "CrewHaus Playground");
  const studioUrl = JSON.stringify(opts.studioUrl);
  const oauthClientId = JSON.stringify(opts.oauthClientId ?? "");
  const templatesJson = JSON.stringify(templateMenuEntries());
  const nonce = opts.cspNonce ? ` nonce="${escapeHtml(opts.cspNonce)}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style${nonce}>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #app { display: grid; grid-template-columns: 280px 1fr 1fr; height: 100vh; }
    aside { background: #f6f8fa; border-right: 1px solid #d0d7de; padding: 16px; overflow-y: auto; }
    main, section { padding: 0; overflow: hidden; }
    main { border-right: 1px solid #d0d7de; }
    .template-card { padding: 8px; margin-bottom: 8px; border: 1px solid #d0d7de; border-radius: 6px; cursor: pointer; background: #fff; }
    .template-card:hover { background: #eaeef2; }
    .template-card h3 { margin: 0 0 4px; font-size: 14px; }
    .template-card p { margin: 0; font-size: 12px; color: #57606a; }
    iframe.studio { width: 100%; height: 100%; border: 0; }
    button.run { display: block; margin: 8px; padding: 8px 16px; background: #0969da; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-weight: 600; }
    .quota { font-size: 12px; color: #57606a; padding: 4px 8px; }
  </style>
</head>
<body>
  <div id="app">
    <aside>
      <h2>Templates</h2>
      <div id="templates"></div>
      <hr />
      <div class="quota" id="quota">Anonymous tier — 5 runs / hour</div>
    </aside>
    <main>
      <button class="run" id="run">▶ Run Spec</button>
      <div id="editor" style="height:calc(100% - 56px)"></div>
    </main>
    <section>
      <iframe class="studio" id="studio" title="Trace Viewer"></iframe>
    </section>
  </div>
  <script${nonce}>
    window.__CREWHAUS_PLAYGROUND__ = {
      studioUrl: ${studioUrl},
      oauthClientId: ${oauthClientId},
      templates: ${templatesJson},
    };
  </script>
  <!-- main.js bootstraps Monaco + the run button.
       In production we ship it precompiled; here we leave it as a
       placeholder for the marketplace bundle. -->
  <script src="/main.js"${nonce} defer></script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
