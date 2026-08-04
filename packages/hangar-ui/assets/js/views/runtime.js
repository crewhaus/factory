/**
 * Dev & MCP — the two remaining supervised run classes: the `serve --mcp` /
 * `expose:` projection, and the `crewhaus dev` watch-recompile-relaunch
 * loop.
 *
 * Both are PROCESSES, not panels: they get runfiles, run-ledger rows and
 * ledger-claimed ports, so the next manager boot adopts them. Their live
 * output is the EXISTING run console — these screens hand off a `runId` to
 * `#/h/<id>/runs/<runId>` rather than opening a second stream.
 *
 * The reason dev mode is driven from here at all: `crewhaus dev` normally
 * compiles into a temp directory and runs with that as the cwd, so sessions,
 * memory and feedback land somewhere that disappears. The manager owns the
 * spawn and sets the cwd to the harness dir, which keeps state in the
 * harness's own `.crewhaus/` across every recompile.
 */

import { renderPendingSurface } from "../pending.js";

export async function renderRuntime(root, _ctx) {
  renderPendingSurface(root, {
    group: "runtime",
    title: "Dev & MCP",
    blurb:
      "The MCP projection's transport, port and health with start/stop, and the dev watch loop with its last recompile — both supervised, ledgered, and watched through the existing run console.",
  });
}
