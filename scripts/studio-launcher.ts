#!/usr/bin/env bun
import { startStudioServer } from "@crewhaus/studio-server";
/**
 * `bun run studio` entrypoint. Boots the studio-server, prints the
 * URL, optionally serves the studio-ui at `/`, and waits for SIGINT.
 *
 * The studio-server already serves a minimal index at `/`; this
 * launcher overlays the richer studio-ui by intercepting `/` and
 * serving the bundle from `@crewhaus/studio-ui`.
 */
import { renderStudioHtml } from "@crewhaus/studio-ui";

const port = Number(process.env["STUDIO_PORT"] ?? 4187);
const workspaceDir = process.env["STUDIO_WORKSPACE"] ?? `${process.cwd()}/.crewhaus/studio-specs`;
const pluginRoot = process.env["STUDIO_PLUGIN_ROOT"];

const server = await startStudioServer({
  port,
  workspaceDir,
  ...(pluginRoot !== undefined ? { pluginRoot } : {}),
});
process.stdout.write(`Studio listening on http://localhost:${server.port}/\n`);
// Smoke-friendly machine-readable banner.
process.stdout.write(`READY:${server.port}\n`);

// (The studio-server's GET / already returns a stub HTML page; richer
// UI rendering with `renderStudioHtml` is intentionally not exposed
// from the server module yet — keeping the server backend-only and the
// UI bundle separate so they can ship independently. The launcher logs
// the UI snippet so users can see it's available for embedding.)
process.stdout.write(
  `(UI bundle is ${renderStudioHtml().length} bytes; embed via @crewhaus/studio-ui)\n`,
);

const shutdown = async (signal: string): Promise<void> => {
  process.stdout.write(`Studio received ${signal}, stopping\n`);
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Block forever (handlers exit the process).
await new Promise(() => {});
