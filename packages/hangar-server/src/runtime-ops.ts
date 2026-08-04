/**
 * M3 · RUNTIME — the two remaining run classes the manager supervises: the
 * `mcp-server` projection and the `dev` watch-recompile-relaunch loop.
 *
 * ---------------------------------------------------------------------------
 * THESE ARE PROCESSES, NOT PANELS
 * ---------------------------------------------------------------------------
 * Both go through the EXISTING process layer rather than a second spawner.
 * Concretely that is the durable JOB QUEUE (`ctx.submitJob`) — the write
 * covenant's sanctioned path for "anything else that is a CLI verb", and the
 * only spawn seam this surface is handed. What the queue gives them:
 *
 *   - one spawn seam (the layer's injected process ops), never a second one;
 *   - `cwd = <harnessDir>` by construction — see the dev trap below;
 *   - capture into `.crewhaus/run/logs/<runId>.log`, the file the supervisor's
 *     scrubbed read paths (`runs.ts`) serve — nothing here reads it raw;
 *   - the per-harness MUTATING mutex, so a dev loop, an mcp projection, an
 *     eval and a compile can never run over each other's `.crewhaus/`;
 *   - a durable ledger that survives a manager restart: work the previous
 *     manager left running reopens as `interrupted`, never silently re-run.
 *
 * Each start also appends a row to `.crewhaus/run/runs.jsonl` with its run
 * KIND (`mcp-server` / `job`), which is what makes the run visible in the run
 * history and resolvable by the existing run routes after a restart.
 *
 * M3 ADDS NO NEW STREAMING MECHANISM. Live output for both classes is the
 * existing SSE feed at `GET /api/h/:id/runs/:runId/events` — the routes here
 * return the `runId` and the console watches it there. Exactly one route in
 * the whole map is `stream: "sse"`, and it stays that way.
 *
 * WHAT THIS LAYER CANNOT DO, AND SAYS SO. The queue can cancel work that has
 * not STARTED; it holds no handle on a child that is already running, and it
 * writes no runfile, so a started projection is not adoptable by the next
 * manager and cannot be signalled from here. Every payload therefore carries
 * `supervision.{stoppable,reason}` and every stop answers with the same
 * `not-adopted` honesty the daemon verbs have: signalling nothing must never
 * report `stopped`. A supervised, signalable, port-claiming mcp-server/dev
 * slot needs a run-class-parameterised start on the process layer, which is
 * an addition to that layer rather than something this module may invent.
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
 * The cwd the manager sets is the `crewhaus dev` PROCESS's. The relocatable
 * roots it can additionally pin are reported on the status route as
 * `stateRoots`, so an operator can see which parts of the state tree are
 * actually anchored rather than being told a blanket "fixed".
 *
 * A dev loop and a daemon are mutually exclusive for one harness: refuse to
 * start dev while a supervised daemon holds the runfile, with the reason,
 * rather than racing it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type JobRecord,
  type RunKind,
  type RunLedgerEntry,
  appendRunLedger,
  defaultPortProbe,
  readRunLedger,
  readRunfile,
  shellQuote,
} from "@crewhaus/harness-supervisor";
import { HttpError } from "./http";
import type { M3Context, M3Handler } from "./m3";
import { jobArg } from "./m3";
import { isSupervisorRunId } from "./runs";
import { readSpecYaml } from "./schedulers";

/** Job kind for the MCP projection — display key, lock key, and the string
 *  the run ledger's `mcp-server` rows are correlated by. */
export const MCP_JOB_KIND = "mcp-server";

/** Job kind for the dev watch loop. */
export const DEV_JOB_KIND = "dev";

/** Transports the start route accepts. `http` and `sse` are the same thing —
 *  the route map documents `http`, the spec's `expose.mcp.transport` spells
 *  it `sse`, and refusing one of the two spellings would be pedantry. */
export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type McpTransport = "stdio" | "http";

/** `crewhaus serve --mcp` projects only the `cli` shape's turn function; a
 *  channel/managed daemon self-exposes from its own compiled bundle. */
export const MCP_SERVE_TARGET = "cli";

/** The CLI's default SSE port when neither a flag nor `CREWHAUS_MCP_PORT`
 *  says otherwise. Mirrored (not imported) — the manager must not grow an
 *  edge onto the CLI app. */
export const MCP_DEFAULT_PORT = 8000;

/** Rows folded per class for a runtime panel. */
const MAX_RUNTIME_ROWS = 20;

// ---------------------------------------------------------------------------
// Lenient spec reads
// ---------------------------------------------------------------------------

/** The `expose.mcp` block as DECLARED, read without a schema parse: a fleet
 *  console must render a spec one schema version ahead of this manager. */
export type DeclaredExpose = {
  readonly declared: boolean;
  readonly transport: string | null;
  readonly tools: string | null;
};

/** Indentation of a YAML line. */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n += 1;
  return n;
}

/** The lines strictly inside `<key>:` at the given indent level. */
function blockUnder(lines: readonly string[], key: string, atIndent: number): string[] | undefined {
  const header = new RegExp(`^\\s{${atIndent}}${key}\\s*:\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!header.test(lines[i] as string)) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] as string;
      if (next.trim() === "" || next.trim().startsWith("#")) continue;
      if (indentOf(next) <= atIndent) break;
      body.push(next);
    }
    return body;
  }
  return undefined;
}

/** The scalar for `key:` inside a block, quotes and trailing comment removed. */
function scalarIn(block: readonly string[], key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`);
  for (const line of block) {
    const m = line.match(re);
    if (m === null) continue;
    let value = (m[1] ?? "").trim();
    if (value === "" || value.startsWith("#")) continue;
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;
    if (quote !== undefined && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    return value;
  }
  return undefined;
}

/** Read `expose: { mcp: { transport, tools } }` out of a spec's TEXT. */
export function declaredExpose(yamlText: string): DeclaredExpose {
  const lines = yamlText.split("\n");
  const expose = blockUnder(lines, "expose", 0);
  if (expose === undefined) return { declared: false, transport: null, tools: null };
  const mcp = blockUnder(expose, "mcp", indentOf(expose[0] ?? "  "));
  if (mcp === undefined) return { declared: true, transport: null, tools: null };
  return {
    declared: true,
    transport: scalarIn(mcp, "transport") ?? null,
    tools: scalarIn(mcp, "tools") ?? null,
  };
}

/** The spec's `target:`, read leniently (empty when the file is unreadable). */
export function specTarget(yamlText: string): string {
  const m = /^target:[ \t]*(.*)$/m.exec(yamlText);
  const raw = (m?.[1] ?? "").trim();
  const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : undefined;
  if (quote !== undefined && raw.length >= 2 && raw.endsWith(quote)) return raw.slice(1, -1);
  const hash = raw.indexOf(" #");
  return (hash === -1 ? raw : raw.slice(0, hash)).trim();
}

/** The spec file name at the harness root, as a harness-relative argv value. */
function specFileName(harnessDir: string): string | null {
  for (const name of ["crewhaus.yaml", "crewhaus.yml"]) {
    if (existsSync(join(harnessDir, name))) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Job + ledger correlation
// ---------------------------------------------------------------------------

/**
 * The runId a job's captured output lands under.
 *
 * The layer's job runner derives it from the job id by swapping the prefix,
 * so this is the same derivation — and it is CHECKED, because a manager
 * composed with a custom id minter could produce something that is not a
 * `run_<16hex>` and therefore not addressable by the run routes.
 */
export function runIdForJob(jobId: string): string | null {
  const candidate = jobId.replace(/^job_/, "run_");
  return isSupervisorRunId(candidate) ? candidate : null;
}

/** Every job of `kind` for this harness: live ones from the queue, finished
 *  ones folded from the durable ledger. */
function jobsOfKind(ctx: M3Context, kind: string): { live: JobRecord[]; past: JobRecord[] } {
  const dir = ctx.harnessDir ?? "";
  const mine = (job: JobRecord): boolean => job.harnessDir === dir && job.kind === kind;
  const live = [...ctx.jobs.running().filter(mine), ...ctx.jobs.pending().filter(mine)];
  const past = ctx.jobs
    .recent(MAX_RUNTIME_ROWS * 4)
    .filter(mine)
    .slice(0, MAX_RUNTIME_ROWS);
  return { live, past };
}

/** Ledger rows of one run kind, newest first. A folded read — never a store
 *  `list()` that compacts. */
function ledgerRows(harnessDir: string, kind: RunKind): RunLedgerEntry[] {
  let all: RunLedgerEntry[];
  try {
    all = readRunLedger(harnessDir);
  } catch {
    return [];
  }
  return all
    .filter((row) => row.kind === kind)
    .reverse()
    .slice(0, MAX_RUNTIME_ROWS);
}

/** One job rendered for a runtime panel. */
export type RuntimeRun = {
  readonly jobId: string;
  readonly runId: string | null;
  readonly state: string;
  readonly argv: readonly string[];
  readonly enqueuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly error: string | null;
};

function runtimeRun(job: JobRecord): RuntimeRun {
  return {
    jobId: job.jobId,
    runId: runIdForJob(job.jobId),
    state: job.state,
    argv: job.argv,
    enqueuedAt: job.enqueuedAt,
    startedAt: job.startedAt ?? null,
    endedAt: job.endedAt ?? null,
    exitCode: job.exitCode ?? null,
    error: job.error ?? null,
  };
}

/** Whether a supervised process holds this harness's runfile right now. */
function daemonHolding(harnessDir: string): { held: boolean; reason: string | null } {
  const runfile = readRunfile(harnessDir);
  if (runfile === undefined) return { held: false, reason: null };
  return {
    held: true,
    reason: `a supervised process already holds this harness's runfile (${runfile.runId}, pid ${runfile.pid}) — stop or drain it first`,
  };
}

/** The always-honest "can this layer signal the child" answer. */
function supervisionOf(live: readonly JobRecord[]): {
  stoppable: boolean;
  reason: string | null;
} {
  const running = live.some((j) => j.state === "running");
  if (!running) {
    return {
      stoppable: live.length > 0,
      reason:
        live.length > 0
          ? null
          : "nothing to stop — the queue holds no run of this class for this harness",
    };
  }
  return {
    stoppable: false,
    reason:
      "this run has already started: the job queue can cancel queued work but holds no signal handle on a running child — stop it where it is captured, or through the daemon verbs once this class gets a supervised slot",
  };
}

/** The command an operator could paste. Every value is quoted
 *  unconditionally — a harness directory is an attacker-influenceable name. */
function twin(harnessDir: string, argv: readonly string[]): string {
  return ["cd", shellQuote(harnessDir), "&&", "crewhaus", ...argv.map(shellQuote)].join(" ");
}

/** The SSE path the console watches a started run on. */
function watchPath(harnessId: string, runId: string): string {
  return ["/api/h", harnessId, "runs", runId, "events"].join("/");
}

/** Open a run-ledger row for a job-spawned runtime run, so the run history and
 *  the existing run routes can find it after a restart. Best effort: a ledger
 *  that cannot be written must not fail the start the operator asked for — it
 *  is reported instead. */
function openLedgerRow(
  ctx: M3Context,
  runId: string,
  kind: RunKind,
  argv: readonly string[],
): string | null {
  const dir = ctx.harnessDir;
  if (dir === null) return "no harness directory";
  try {
    appendRunLedger(dir, {
      runId,
      kind,
      argv,
      startedAt: new Date(ctx.now()).toISOString(),
      logFile: `logs/${runId}.log`,
    });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.warn(`hangar-server: could not open a run-ledger row for ${runId}: ${message}`);
    return message;
  }
}

// ---------------------------------------------------------------------------
// GET /api/h/:id/mcp-servers
// ---------------------------------------------------------------------------

/**
 * How this harness's MCP projection is (or is not) reachable.
 *
 * Three genuinely different answers, and conflating them is what makes an
 * "MCP" panel useless:
 *   `serve`     a `cli` shape — the projection is a SEPARATE process the
 *               manager starts (`crewhaus serve --mcp`);
 *   `self`      a channel/managed daemon — it exposes itself from its own
 *               compiled bundle, so there is nothing separate to start and
 *               the projection's liveness IS the daemon's;
 *   `none`      the shape does not project at all.
 */
export type McpProjection = "serve" | "self" | "none";

export function projectionFor(target: string, expose: DeclaredExpose): McpProjection {
  if (target === MCP_SERVE_TARGET) return "serve";
  if (expose.declared && (target === "channel" || target === "managed")) return "self";
  return "none";
}

/** Resolve the transport a start would use. */
export function resolveTransport(requested: unknown, expose: DeclaredExpose): McpTransport {
  const raw =
    typeof requested === "string" && requested !== "" ? requested : (expose.transport ?? "stdio");
  if (!(MCP_TRANSPORTS as readonly string[]).includes(raw)) {
    throw new HttpError(
      400,
      `"transport" must be one of ${MCP_TRANSPORTS.join(", ")} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw === "stdio" ? "stdio" : "http";
}

/** A listen port from the body, the harness env, or the CLI default. */
export function resolvePort(ctx: M3Context): number {
  const requested = ctx.body["port"];
  if (requested !== undefined) {
    if (
      typeof requested !== "number" ||
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > 65535
    ) {
      throw new HttpError(400, '"port" must be an integer between 1 and 65535');
    }
    return requested;
  }
  const fromEnv = Number.parseInt(ctx.env["CREWHAUS_MCP_PORT"] ?? "", 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535 ? fromEnv : MCP_DEFAULT_PORT;
}

/** The argv a projection start runs, from a CLOSED vocabulary. Nothing from
 *  the request body reaches it except a shape-checked port NUMBER. */
export function mcpArgv(specFile: string, transport: McpTransport, port: number): string[] {
  const argv = ["serve", "--mcp", jobArg("spec", specFile)];
  if (transport === "http") argv.push("--sse", "--port", String(port));
  return argv;
}

/** The `--port` value on a command line, when it carries one. */
function portInArgv(argv: readonly string[]): number | null {
  const at = argv.indexOf("--port");
  const parsed = Number.parseInt(at === -1 ? "" : (argv[at + 1] ?? ""), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Loopback liveness probe for an HTTP+SSE projection.
 *
 * A bind attempt, not an MCP handshake: "something is listening on 127.0.0.1
 * at this port" is exactly as much as the manager can honestly claim without
 * speaking the protocol, and the payload says so rather than calling it
 * "healthy".
 */
async function probePort(port: number): Promise<{ listening: boolean; error: string | null }> {
  try {
    return { listening: !(await defaultPortProbe(port)), error: null };
  } catch (err) {
    return { listening: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `GET /api/h/:id/mcp-servers` — the MCP projection's process picture.
 *
 * Whether `serve --mcp` / an `expose:` projection is running, its transport
 * (stdio or HTTP+SSE), its ledger-claimed port, its health-check result, and
 * its recent runs from the ledger. Absent configuration is an honest empty
 * state naming the spec block that would enable it.
 */
export const mcpServers: M3Handler = async (ctx) => {
  const dir = ctx.harnessDir as string;
  const yaml = readSpecYaml(dir);
  const target = specTarget(yaml);
  const expose = declaredExpose(yaml);
  const projection = projectionFor(target, expose);
  const { live, past } = jobsOfKind(ctx, MCP_JOB_KIND);
  const running = live.find((j) => j.state === "running") ?? null;
  const runfile = readRunfile(dir);

  // A port is known when a live run declared one on its command line or when
  // a runfile claims one. Nothing is invented.
  const port = (running === null ? null : portInArgv(running.argv)) ?? runfile?.port ?? null;
  const transport: McpTransport | null =
    running !== null
      ? running.argv.includes("--sse")
        ? "http"
        : "stdio"
      : expose.transport === null
        ? null
        : expose.transport === "stdio"
          ? "stdio"
          : "http";

  const health =
    port === null || transport !== "http"
      ? {
          checked: false,
          listening: null,
          port: null,
          at: null,
          error: null,
          note:
            transport === "stdio"
              ? "a stdio projection has no port to probe — its liveness is the run's state"
              : "no port is known for this projection yet",
        }
      : {
          checked: true,
          ...(await probePort(port)),
          port,
          at: new Date(ctx.now()).toISOString(),
          note: "a loopback bind probe, not an MCP handshake — it proves something is listening, not that it speaks MCP",
        };

  const specFile = specFileName(dir);
  const notes: Record<McpProjection, string> = {
    serve: expose.declared
      ? "this cli shape declares expose.mcp — start it to project the agent's turn as an MCP tool"
      : "no expose: block in the spec, but a cli shape still projects through `crewhaus serve --mcp`",
    self: "this daemon shape exposes itself from its own compiled bundle — start the DAEMON, not a separate process",
    none: `target: ${target || "(unreadable)"} does not project as an MCP server — only the cli shape projects through serve, and channel/managed daemons self-expose with expose.mcp.transport: sse`,
  };

  return {
    present: projection !== "none",
    note: projection === "none" ? notes.none : running === null ? notes[projection] : null,
    verb:
      projection === "serve" && running === null && specFile !== null
        ? `crewhaus serve --mcp ${specFile}`
        : null,
    target,
    projection,
    projectionNote: notes[projection],
    expose,
    running: running !== null,
    runId: running === null ? null : runIdForJob(running.jobId),
    jobId: running?.jobId ?? null,
    startedAt: running?.startedAt ?? null,
    transport,
    port,
    health,
    runs: [...live, ...past].map(runtimeRun),
    ledger: ledgerRows(dir, "mcp-server"),
    supervision: supervisionOf(live),
    cliTwin:
      specFile === null
        ? null
        : twin(dir, mcpArgv(specFile, transport ?? "stdio", port ?? MCP_DEFAULT_PORT)),
  };
};

// ---------------------------------------------------------------------------
// POST /api/h/:id/mcp-servers/start | stop
// ---------------------------------------------------------------------------

/** A refusal that is a PAYLOAD, not an error: the console renders the reason
 *  next to a disabled button instead of a toast that says "409". */
function refusal(code: string, reason: string, extra: Record<string, unknown> = {}): unknown {
  return { ok: false, started: false, code, reason, ...extra };
}

/**
 * `POST /api/h/:id/mcp-servers/start` — start the projection.
 *
 * Body: `{ transport?: "stdio"|"http", port?: number }`. Spawned through the
 * process layer's job queue as the `mcp-server` run class, with a run-ledger
 * row opened for it. Returns the `runId` so the console can watch the
 * existing SSE feed.
 */
export const mcpServerStart: M3Handler = (ctx) => {
  const dir = ctx.harnessDir as string;
  const yaml = readSpecYaml(dir);
  const target = specTarget(yaml);
  const expose = declaredExpose(yaml);
  const projection = projectionFor(target, expose);
  if (projection !== "serve") {
    return refusal(
      "not-projectable",
      projection === "self"
        ? "this daemon shape self-exposes from its compiled bundle — start the daemon instead of a separate projection"
        : `target: ${target || "(unreadable)"} does not project through \`crewhaus serve --mcp\``,
      { projection, target },
    );
  }
  const specFile = specFileName(dir);
  if (specFile === null) {
    return refusal("no-spec", "no crewhaus.yaml at the harness root", { remedy: "add-spec" });
  }
  const { live } = jobsOfKind(ctx, MCP_JOB_KIND);
  if (live.length > 0) {
    return refusal(
      "already-running",
      "a projection is already queued or running for this harness — it is a singleton",
      { jobId: live[0]?.jobId ?? null, runId: runIdForJob(live[0]?.jobId ?? "") },
    );
  }
  const transport = resolveTransport(ctx.body["transport"], expose);
  const port = transport === "http" ? resolvePort(ctx) : null;
  const argv = mcpArgv(specFile, transport, port ?? MCP_DEFAULT_PORT);
  const job = ctx.submitJob(MCP_JOB_KIND, argv);
  const runId = runIdForJob(job.jobId);
  const ledgerError = runId === null ? null : openLedgerRow(ctx, runId, "mcp-server", argv);
  return {
    ok: true,
    started: true,
    jobId: job.jobId,
    runId,
    transport,
    port,
    argv,
    cliTwin: twin(dir, argv),
    ledgerError,
    // The port is NOT claimed in the port ledger: this layer allocates
    // nothing, so a collision surfaces as the CLI failing to bind rather than
    // as a reservation the manager cannot honour.
    portClaimed: false,
    supervision: supervisionOf([job]),
    watch: runId === null ? null : watchPath(ctx.entry?.id ?? "", runId),
  };
};

/** `POST /api/h/:id/mcp-servers/stop` — stop it through the supervisor, with
 *  the same `not-adopted` honesty the daemon verbs already have: signalling
 *  nothing must never report `stopped`. */
export const mcpServerStop: M3Handler = (ctx) => stopRuntime(ctx, MCP_JOB_KIND, "projection");

/** Shared stop for both classes: cancel queued work, refuse honestly for a
 *  child already running. */
function stopRuntime(ctx: M3Context, kind: string, label: string): unknown {
  const { live } = jobsOfKind(ctx, kind);
  if (live.length === 0) {
    return {
      ok: true,
      stopped: false,
      reason: "nothing-running",
      message: `no ${label} is queued or running for this harness`,
      cancelled: [],
      running: [],
    };
  }
  const cancelled: string[] = [];
  const stillRunning: string[] = [];
  for (const job of live) {
    if (ctx.jobs.cancel(job.jobId)) cancelled.push(job.jobId);
    else stillRunning.push(job.jobId);
  }
  if (stillRunning.length === 0) {
    return {
      ok: true,
      stopped: true,
      reason: null,
      message: `cancelled ${cancelled.length} queued ${label} run(s) before they started`,
      cancelled,
      running: [],
    };
  }
  // The daemon verbs' `not-adopted` shape, for the same reason: this manager
  // holds no pid for that child, so nothing was signalled and reporting
  // `stopped: true` would be a lie the operator acts on.
  return {
    ok: true,
    stopped: false,
    reason: "not-adopted",
    message: `the ${label} is already running and this manager holds no signal handle for it — nothing was signalled`,
    cancelled,
    running: stillRunning,
    supervision: supervisionOf(live),
  };
}

// ---------------------------------------------------------------------------
// GET /api/h/:id/dev
// ---------------------------------------------------------------------------

/** What `crewhaus dev` watches for changes. */
export const DEV_WATCHED = ["crewhaus.yaml", ".crewhaus/commands/", ".crewhaus/skills/"] as const;

/**
 * The state roots the manager can anchor for a dev child.
 *
 * `crewhaus dev` emits its bundle into a temp dir and runs the CHILD there,
 * so the parent's cwd alone does not keep every store in the harness. These
 * four are relocatable by environment and the spawn env carries them through
 * to the child; the rest of the tree follows the child's cwd. Reported, not
 * asserted — an operator gets to see which half is anchored.
 */
export const DEV_STATE_ROOT_KEYS = [
  "CREWHAUS_SESSION_DIR",
  "CREWHAUS_DATASETS_DIR",
  "CREWHAUS_WATCHME_ROOT",
  "CREWHAUS_SHARED_DIR",
] as const;

export type DevStateRoot = {
  readonly name: string;
  readonly anchored: boolean;
  readonly value: string | null;
};

function stateRoots(ctx: M3Context): DevStateRoot[] {
  return DEV_STATE_ROOT_KEYS.map((name) => {
    const value = ctx.env[name];
    const set = typeof value === "string" && value !== "";
    return { name, anchored: set, value: set ? (value as string) : null };
  });
}

/** The argv a dev start runs, from a CLOSED vocabulary. */
export function devArgv(specFile: string, checkOnly: boolean): string[] {
  const spec = jobArg("spec", specFile);
  return checkOnly ? ["compile", spec, "--check", "--watch"] : ["dev", spec];
}

/**
 * `GET /api/h/:id/dev` — dev-mode status.
 *
 * Whether a watch loop is running, what it is watching, the last recompile's
 * result (including `compile --check` validate-only loops), and the runId of
 * the current child.
 */
export const dev: M3Handler = (ctx) => {
  const dir = ctx.harnessDir as string;
  const { live, past } = jobsOfKind(ctx, DEV_JOB_KIND);
  const running = live.find((j) => j.state === "running") ?? null;
  const specFile = specFileName(dir);
  const daemon = daemonHolding(dir);
  // The newest terminal dev/compile job IS the last recompile result: a
  // `--check` loop and a full dev loop both end as one of these rows.
  const lastCompile =
    ctx.jobs
      .recent(MAX_RUNTIME_ROWS * 4)
      .find((j) => j.harnessDir === dir && (j.kind === DEV_JOB_KIND || j.kind === "compile")) ??
    null;

  const mode: "watch" | "check" | null =
    running === null ? null : running.argv.includes("--check") ? "check" : "watch";

  return {
    present: running !== null || past.length > 0,
    note:
      running !== null
        ? null
        : specFile === null
          ? "no crewhaus.yaml at the harness root — nothing to watch"
          : "no dev loop is running for this harness",
    verb: specFile === null ? null : `crewhaus dev ${specFile}`,
    running: running !== null,
    mode,
    jobId: running?.jobId ?? null,
    runId: running === null ? null : runIdForJob(running.jobId),
    startedAt: running?.startedAt ?? null,
    watching: DEV_WATCHED,
    // The whole reason dev is driven from here.
    cwd: dir,
    cwdNote:
      "the manager spawns `crewhaus dev` with the HARNESS directory as its cwd; run from a terminal it compiles into a temp dir whose cwd the child inherits, and state written there disappears with it",
    stateRoots: stateRoots(ctx),
    lastCompile:
      lastCompile === null
        ? null
        : {
            kind: lastCompile.kind,
            state: lastCompile.state,
            exitCode: lastCompile.exitCode ?? null,
            error: lastCompile.error ?? null,
            at: lastCompile.endedAt ?? lastCompile.startedAt ?? lastCompile.enqueuedAt,
          },
    blocked: daemon.held,
    blockedReason: daemon.reason,
    runs: [...live, ...past].map(runtimeRun),
    ledger: ledgerRows(dir, "job"),
    supervision: supervisionOf(live),
    cliTwin: specFile === null ? null : twin(dir, devArgv(specFile, false)),
  };
};

/**
 * `POST /api/h/:id/dev/start` — start the watch loop.
 *
 * Body: `{ checkOnly? }` (`compile --watch` validate-only). The MANAGER owns
 * the spawn and sets `cwd = <harnessDir>` so state stays in the harness's
 * own `.crewhaus/` — see the module docblock. Refuse while a supervised
 * daemon is running, with the reason.
 */
export const devStart: M3Handler = (ctx) => {
  const dir = ctx.harnessDir as string;
  const specFile = specFileName(dir);
  if (specFile === null) {
    return refusal("no-spec", "no crewhaus.yaml at the harness root", { remedy: "add-spec" });
  }
  const daemon = daemonHolding(dir);
  if (daemon.held) {
    // Racing a daemon means two processes compiling and writing into one
    // `.crewhaus/`; refuse with the reason rather than start beside it.
    return refusal("daemon-running", daemon.reason ?? "a supervised daemon is running");
  }
  const { live } = jobsOfKind(ctx, DEV_JOB_KIND);
  if (live.length > 0) {
    return refusal("already-running", "a dev loop is already queued or running for this harness", {
      jobId: live[0]?.jobId ?? null,
      runId: runIdForJob(live[0]?.jobId ?? ""),
    });
  }
  const checkOnly = ctx.body["checkOnly"] === true;
  const argv = devArgv(specFile, checkOnly);
  const job = ctx.submitJob(DEV_JOB_KIND, argv);
  const runId = runIdForJob(job.jobId);
  const ledgerError = runId === null ? null : openLedgerRow(ctx, runId, "job", argv);
  return {
    ok: true,
    started: true,
    jobId: job.jobId,
    runId,
    mode: checkOnly ? "check" : "watch",
    argv,
    cwd: dir,
    stateRoots: stateRoots(ctx),
    cliTwin: twin(dir, argv),
    ledgerError,
    supervision: supervisionOf([job]),
    watch: runId === null ? null : watchPath(ctx.entry?.id ?? "", runId),
  };
};

/** `POST /api/h/:id/dev/stop` — stop the watch loop through the supervisor
 *  (the loop owns a child; stopping must take both down). */
export const devStop: M3Handler = (ctx) => stopRuntime(ctx, DEV_JOB_KIND, "dev loop");
