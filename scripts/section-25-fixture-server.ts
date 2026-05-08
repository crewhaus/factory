#!/usr/bin/env bun
/**
 * Section 25 BROW — fixture HTTP server.
 *
 * Serves a single page at `/` with a known-id Submit button. Clicking
 * the button (or POSTing to `/submit`) flips the page state — the
 * post-submit state is detectable by reading `body.textContent` for
 * the marker "BROW_SMOKE_OK".
 *
 * The server is started by the section-25 smoke harness on a fixed
 * port (7325 by default; override with `BROW_SMOKE_PORT`). The smoke
 * compiles the hello-browser bundle pointed at this URL, runs the
 * agent, and asserts on the post-click DOM.
 */
const PORT = Number(process.env["BROW_SMOKE_PORT"] ?? 7325);

let submitted = false;

const PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Section 25 fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 60px; }
      .ok { color: #2a7a2a; font-weight: bold; }
      button#submit-btn {
        font-size: 18px; padding: 12px 32px; margin-top: 24px;
        background: #2a7a2a; color: white; border: none; border-radius: 6px;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <h1>BROW Smoke Fixture</h1>
    <p>Click the green Submit button below.</p>
    <button id="submit-btn" onclick="fetch('/submit', { method: 'POST' }).then(() => window.location.reload())">Submit</button>
    <p id="status">$STATUS</p>
  </body>
</html>`;

function renderHtml(status: "PENDING" | "BROW_SMOKE_OK"): string {
  return PAGE_HTML.replace(
    "$STATUS",
    status === "BROW_SMOKE_OK" ? `<span class="ok">BROW_SMOKE_OK</span>` : "PENDING",
  );
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(renderHtml(submitted ? "BROW_SMOKE_OK" : "PENDING"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/submit" && req.method === "POST") {
      submitted = true;
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/reset") {
      submitted = false;
      return new Response("reset", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
});

process.stdout.write(`[fixture] listening on http://127.0.0.1:${server.port}/\n`);

const shutdown = (signal: string): void => {
  process.stdout.write(`[fixture] received ${signal}, stopping\n`);
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
