/**
 * M3 · RUNTIME — the two remaining run classes the manager supervises: the
 * `mcp-server` projection and the `dev` watch-recompile-relaunch loop.
 *
 * STUBS. Owned by the Inspect+Runtime implementer together with `inspect.ts`.
 *
 * ---------------------------------------------------------------------------
 * THESE ARE PROCESSES, NOT PANELS
 * ---------------------------------------------------------------------------
 * Both go through the EXISTING process layer (`process.ts` →
 * `@crewhaus/harness-supervisor`) rather than a second spawner:
 *   - a runfile in `.crewhaus/run/`, so the next manager boot ADOPTS them,
 *   - a row in `.crewhaus/run/runs.jsonl` with its run class, so history
 *     survives a restart,
 *   - a claimed port in the port ledger, so nothing else takes it,
 *   - captured output served ONLY through the supervisor's scrubbed paths.
 *
 * M3 ADDS NO NEW STREAMING MECHANISM. Live output for both classes is the
 * existing SSE feed at `GET /api/h/:id/runs/:runId/events` — the routes here
 * return the `runId` and the console watches it there. Exactly one route in
 * the whole map is `stream: "sse"`, and it stays that way.
 *
 * ---------------------------------------------------------------------------
 * THE DEV-MODE TRAP THIS EXISTS TO FIX
 * ---------------------------------------------------------------------------
 * `crewhaus dev` compiles into a TEMPORARY directory and runs the bundle
 * with that temp dir as the cwd. Everything a harness writes relative to its
 * cwd — sessions, memory, feedback, the run ledger — therefore lands in a
 * directory that disappears. When the MANAGER owns the spawn it sets
 * `cwd = <harnessDir>`, so state stays in the harness's own `.crewhaus/`
 * across every recompile. That is the entire point of driving dev from here
 * rather than telling the operator to run it in a terminal; do not
 * regress it.
 *
 * A dev loop and a daemon are mutually exclusive for one harness: refuse to
 * start dev while a supervised daemon holds the runfile, with the reason,
 * rather than racing it.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/h/:id/mcp-servers` — the MCP projection's process picture.
 *
 * Whether `serve --mcp` / an `expose:` projection is running, its transport
 * (stdio or HTTP+SSE), its ledger-claimed port, its health-check result, and
 * its recent runs from the ledger. Absent configuration is an honest empty
 * state naming the spec block that would enable it.
 */
export const mcpServers: M3Handler = () => notImplemented("mcp-server status");

/**
 * `POST /api/h/:id/mcp-servers/start` — start the projection.
 *
 * Body: `{ transport?: "stdio"|"http" }`. Spawned through the process layer
 * as the `mcp-server` run class: runfile, ledger row, claimed port. Returns
 * the `runId` so the console can watch the existing SSE feed.
 */
export const mcpServerStart: M3Handler = () => notImplemented("mcp-server start");

/** `POST /api/h/:id/mcp-servers/stop` — stop it through the supervisor, with
 *  the same `not-adopted` honesty the daemon verbs already have: signalling
 *  nothing must never report `stopped`. */
export const mcpServerStop: M3Handler = () => notImplemented("mcp-server stop");

/**
 * `GET /api/h/:id/dev` — dev-mode status.
 *
 * Whether a watch loop is running, what it is watching, the last recompile's
 * result (including `compile --check` validate-only loops), and the runId of
 * the current child.
 */
export const dev: M3Handler = () => notImplemented("dev mode status");

/**
 * `POST /api/h/:id/dev/start` — start the watch loop.
 *
 * Body: `{ checkOnly? }` (`compile --watch` validate-only). The MANAGER owns
 * the spawn and sets `cwd = <harnessDir>` so state stays in the harness's
 * own `.crewhaus/` — see the module docblock. Refuse while a supervised
 * daemon is running, with the reason.
 */
export const devStart: M3Handler = () => notImplemented("dev mode start");

/** `POST /api/h/:id/dev/stop` — stop the watch loop through the supervisor
 *  (the loop owns a child; stopping must take both down). */
export const devStop: M3Handler = () => notImplemented("dev mode stop");
