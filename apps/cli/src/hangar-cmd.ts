/**
 * Hangar M1 — the `crewhaus hangar` verb family: boot, inspect, and reopen
 * the local manager console.
 *
 * Composes the manager stack without duplicating any layer:
 *   - `@crewhaus/hangar-server` — `startHangarServer()` is the whole HTTP
 *     surface (token-gated loopback API + static UI). This module only
 *     wires ports, assets, and lifecycle around it.
 *   - `@crewhaus/hangar-ui` — `hangarAssets`, the embedded static console.
 *     Imported STATICALLY on purpose: `bun build --compile` embeds only
 *     what the import graph references statically, so a dynamic `import()`
 *     of the ui package (or a `readFileSync` of a package-relative path)
 *     would brick the compiled binary (the v0.3.2 default-skills lesson).
 *   - `@crewhaus/harness-registry` — the registry the console fronts; the
 *     boot flow seeds it from the legacy watchme store best-effort.
 *
 * Single-instance lock: `<hangarRoot>/hangar.lock` (JSON: pid/startedAt/
 * port/url) written atomically at boot. A live pid refuses the second boot;
 * a stale lock (dead pid, or unparseable file) is replaced with a note; a
 * clean shutdown unlinks it. The hangar root is `CREWHAUS_HANGAR_ROOT`,
 * else `<registryRoot>/hangar` (so a temp `CREWHAUS_REGISTRY_ROOT` keeps
 * tests and CI hermetic), which matches the server's own
 * `~/.crewhaus/hangar` default under the default registry root.
 *
 * The auth token is handed to the browser as a URL FRAGMENT (`/#t=<token>`),
 * NEVER a query string — fragments never leave the browser, so the token
 * cannot land in server logs or referrer headers.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Side-effect-free on import, mirroring `harness-cmd.ts`: every function
 * takes an injected environment/clock/pid-liveness/browser-opener seam and
 * returns lines + an exit code; `serve` streams progress through the
 * injected `write` sink because it blocks until SIGINT/SIGTERM.
 *
 * M4 shutdown: SIGINT/SIGTERM drives `runManagerShutdown()` over every
 * supervisor this manager holds — enumerated from the process layer's own
 * handle map (`processes.held()`), never from the registry, which a removal
 * or a relocation can silently shrink mid-session — BEFORE the socket and
 * the lock are given up: daemons detach (runfile-tracked, the next boot
 * adopts them), everything else is stopped so it cannot be orphaned, running
 * jobs are signalled and left open for `restore()` to reopen as
 * `interrupted` — and only then does the process exit, explicitly.
 *
 * Two M4 boot-time postures live here too, because the flags are the only
 * way in: the HM-201 remote-bind opt-in (a non-loopback `--host` needs
 * `CREWHAUS_HANGAR_ALLOW_REMOTE=1` on top of the M1 auth requirement) and
 * `--read-only` / `--read-only-locked`, the screen-share posture the server's
 * 403 remedy tells operators to restart into.
 *
 * Bad arguments throw plain `Error`s; the entry file routes them through
 * `die()` like `harness` does.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_HANGAR_PORT,
  type HangarServer,
  type HangarServerOptions,
  TOKEN_FILENAME,
  startHangarServer,
} from "@crewhaus/hangar-server";
import { hangarAssets } from "@crewhaus/hangar-ui";
import {
  type HangarRegistry,
  openHangarRegistry,
  resolveRegistryRoot,
} from "@crewhaus/harness-registry";
import {
  type ShutdownSupervisor,
  runManagerShutdown,
  shutdownReportLines,
} from "@crewhaus/harness-supervisor";
import { REMOTE_BIND_ENV, remoteBindRefusal } from "./remote-bind";
import { cliVersion } from "./version";

/** What a verb returns: lines for stdout + the process exit code. `serve`
 *  streams through the `write` sink instead (it blocks), so its lines come
 *  back empty. */
export type HangarCommandResult = {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
};

export type HangarCommandOptions = {
  /** Environment consulted for CREWHAUS_HANGAR_ROOT / CREWHAUS_REGISTRY_ROOT
   *  / CREWHAUS_WATCHME_ROOT (and handed to the server). Injected by tests
   *  so they never touch the real `~/.crewhaus`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock (epoch ms); injected by tests. */
  readonly now?: () => number;
  /** Pid recorded in / compared against the lock; defaults to `process.pid`. */
  readonly pid?: number;
  /** Pid-liveness probe; defaults to `process.kill(pid, 0)` (EPERM counts
   *  as alive: the process exists, we just may not signal it). */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Browser opener; defaults to a best-effort detached `open`/`xdg-open`
   *  spawn that never throws and never blocks shutdown. */
  readonly openBrowser?: (url: string) => void;
  /** Line sink for `serve`'s streamed progress; defaults to stdout. */
  readonly write?: (line: string) => void;
  /** Server factory; injected so a test can drive `serve`'s shutdown path
   *  against a fake child without binding a socket or spawning anything.
   *  Defaults to `startHangarServer`. */
  readonly startServer?: (options: HangarServerOptions) => HangarServer;
  /** Process exit, called by `serve` after a clean shutdown. Injected by
   *  tests (a real `process.exit` would take the test runner with it);
   *  defaults to `process.exit`. */
  readonly exit?: (code: 0 | 1) => void;
  /** SIGTERM → SIGKILL grace for each supervised child at shutdown; default
   *  the supervisor package's `SHUTDOWN_GRACE_MS`. */
  readonly shutdownGraceMs?: number;
  /** Hard cap on waiting for any one child to confirm its exit; default the
   *  supervisor package's `SHUTDOWN_DEADLINE_MS`. */
  readonly shutdownDeadlineMs?: number;
};

const HANGAR_USAGE_LINES: readonly string[] = [
  "usage:",
  "  crewhaus hangar [serve]                      boot the Hangar manager console (the local",
  "       [--port <n>] [--host <h>]               web UI over the machine-wide harness",
  "       [--no-auth] [--no-open] [--smoke]       registry) and open it in the browser",
  "       [--read-only] [--read-only-locked]",
  "  crewhaus hangar status [--json]              lock/port/registry/token report — works",
  "                                               without a running server",
  "  crewhaus hangar open                         print + open the running console's URL",
  "",
  "  The console binds 127.0.0.1:4200 by default and hands its bearer token",
  "  to the browser as a URL #fragment (never a query string). --host binds",
  "  another interface: it REQUIRES auth and, because the console is machine",
  `  control over plain HTTP, also ${REMOTE_BIND_ENV}=1.`,
  "  --no-auth is loopback-dev only.",
  "  --read-only boots the console with every mutating route refused (403) —",
  "  the screen-share posture; it can still be lifted from the UI. Add",
  "  --read-only-locked when the person driving is not the person who owns",
  "  the machine: the mode then cannot be turned off over the wire, only by",
  "  restarting the manager without the flag.",
  "  --smoke boots on an ephemeral port, self-checks the embedded UI + API",
  "  auth, and exits — the release workflow's compiled-binary smoke entry.",
  "  One instance per hangar root: <hangarRoot>/hangar.lock (stale locks",
  "  from dead pids are replaced automatically).",
];

// ---------------------------------------------------------------------------
// The single-instance lock (M1 portion)
// ---------------------------------------------------------------------------

export const HANGAR_LOCK_FILENAME = "hangar.lock";

export type HangarLock = {
  readonly pid: number;
  readonly startedAt: string;
  readonly port: number;
  readonly url: string;
};

export type LockAcquisition =
  | { readonly ok: true; readonly staleNote?: string }
  | { readonly ok: false; readonly existing: HangarLock };

/** Default pid-liveness probe: signal 0 through `process.kill`. EPERM means
 *  the process exists but belongs to someone else — that still counts as
 *  alive (we must not clobber its lock). */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the lock file. Absent, unparseable, or pid-less files all read as
 *  "no lock" — a corrupt lock must never wedge the console shut. */
export function readHangarLock(hangarRoot: string): HangarLock | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(hangarRoot, HANGAR_LOCK_FILENAME), "utf8")) as Record<
      string,
      unknown
    >;
    const pid = raw["pid"];
    if (typeof pid !== "number" || !Number.isInteger(pid)) return undefined;
    return {
      pid,
      startedAt: typeof raw["startedAt"] === "string" ? raw["startedAt"] : "",
      port: typeof raw["port"] === "number" ? raw["port"] : 0,
      url: typeof raw["url"] === "string" ? raw["url"] : "",
    };
  } catch {
    return undefined;
  }
}

/** Write the lock atomically (tmp + rename in the same directory). */
export function writeHangarLock(hangarRoot: string, lock: HangarLock): void {
  mkdirSync(hangarRoot, { recursive: true, mode: 0o700 });
  const path = join(hangarRoot, HANGAR_LOCK_FILENAME);
  const tmp = `${path}.${lock.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Exclusive create (`wx`): succeeds only if we created the file, so two
 *  racing consoles cannot both believe they hold the lock. */
function createLockExclusive(hangarRoot: string, lock: HangarLock): boolean {
  mkdirSync(hangarRoot, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(hangarRoot, HANGAR_LOCK_FILENAME), `${JSON.stringify(lock, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Claim the single-instance lock. A live foreign pid refuses; a stale lock
 * (dead pid or unreadable file) is replaced and reported via `staleNote`;
 * re-acquiring under our own pid just rewrites (port updates after boot).
 *
 * The claim is an exclusive create, not a read-then-write: between "no lock
 * found" and "lock written" a second console could otherwise slip through
 * and both would serve the same root. Only the loser of that race falls back
 * to inspecting the winner's lock.
 */
export function acquireHangarLock(
  hangarRoot: string,
  lock: HangarLock,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): LockAcquisition {
  // Two passes at most: create → (someone else holds it) → resolve that
  // holder → if it was stale, unlink and create again. A third contender
  // taking the slot in between is itself a live holder, so we refuse.
  let replacedPid: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createLockExclusive(hangarRoot, lock)) {
      return replacedPid === undefined
        ? { ok: true }
        : {
            ok: true,
            staleNote: `replaced a stale hangar.lock left by pid ${replacedPid} (process no longer running)`,
          };
    }
    const existing = readHangarLock(hangarRoot);
    if (existing === undefined) {
      // Unparseable/corrupt: not a claim by anyone. Take it.
      writeHangarLock(hangarRoot, lock);
      return { ok: true, staleNote: "replaced an unreadable hangar.lock" };
    }
    if (existing.pid === lock.pid) {
      writeHangarLock(hangarRoot, lock); // our own: rewrite with the bound port
      return { ok: true };
    }
    if (isPidAlive(existing.pid)) return { ok: false, existing };
    replacedPid = existing.pid;
    try {
      unlinkSync(join(hangarRoot, HANGAR_LOCK_FILENAME));
    } catch {
      // Someone else cleaned it up first; the next create decides.
    }
  }
  const existing = readHangarLock(hangarRoot);
  if (existing !== undefined && existing.pid !== lock.pid && isPidAlive(existing.pid)) {
    return { ok: false, existing };
  }
  writeHangarLock(hangarRoot, lock);
  return { ok: true };
}

/** Release the lock — but only our own: a foreign pid's lock is left alone
 *  so a crashed-then-restarted console never deletes a live sibling's. */
export function releaseHangarLock(hangarRoot: string, pid: number): void {
  const existing = readHangarLock(hangarRoot);
  if (existing === undefined || existing.pid !== pid) return;
  try {
    unlinkSync(join(hangarRoot, HANGAR_LOCK_FILENAME));
  } catch {
    // Releasing is best-effort; a leftover lock is stale-replaced next boot.
  }
}

/** The hangar root: `CREWHAUS_HANGAR_ROOT`, else `<registryRoot>/hangar` —
 *  which is the server's own `~/.crewhaus/hangar` default under the default
 *  registry root, and keeps everything under one temp root in tests. */
export function resolveHangarRoot(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env["CREWHAUS_HANGAR_ROOT"];
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  return join(resolveRegistryRoot(env), "hangar");
}

// ---------------------------------------------------------------------------
// Tiny per-verb flag parsing (harness-cmd posture: throw plain Errors)
// ---------------------------------------------------------------------------

type VerbFlagSpec = Readonly<Record<string, "value" | "boolean">>;

type VerbArgs = {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
};

function parseVerbArgs(verb: string, argv: readonly string[], spec: VerbFlagSpec): VerbArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const kind = spec[name];
      if (kind === undefined) {
        const known = Object.keys(spec).map((k) => `--${k}`);
        throw new Error(
          `hangar ${verb}: unknown flag "${a}"${known.length > 0 ? ` (expected: ${known.join(", ")})` : ""}`,
        );
      }
      if (kind === "value") {
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`hangar ${verb}: ${a} requires a value`);
        flags.set(name, v);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Best-effort detached browser open — never throws, never holds the event
 *  loop, silently a no-op on platforms without a known opener. */
function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (cmd === undefined) return;
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // A missing opener must never fail the console boot.
  }
}

function openRegistrySafe(opts: HangarCommandOptions): HangarRegistry | undefined {
  try {
    return openHangarRegistry({
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  } catch {
    return undefined;
  }
}

function jsonLines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n");
}

/** The URL to PRINT: token as a #fragment (never a query string — fragments
 *  never leave the browser, so the token cannot leak into logs/referrers).
 *  Printing to the operator's own terminal is fine; see {@link handoffUrl}
 *  for what may be passed to another process. */
function fragmentUrl(baseUrl: string, token: string | undefined): string {
  return token !== undefined && token !== "" ? `${baseUrl}/#t=${token}` : baseUrl;
}

/** The URL to HAND TO THE BROWSER. A child process's argv is readable by
 *  every other process on the machine, so the token must not appear in it:
 *  the server's single-use `/boot/<nonce>` path redirects to the fragment
 *  form instead, and a nonce scraped from a process list is already spent. */
function handoffUrl(baseUrl: string, bootPath: string | undefined): string {
  return bootPath !== undefined && bootPath !== "" ? `${baseUrl}${bootPath}` : baseUrl;
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

type ServeFlags = {
  readonly port: number | undefined;
  readonly host: string | undefined;
  readonly noAuth: boolean;
  readonly noOpen: boolean;
  readonly smoke: boolean;
  /** Boot the console with every mutating route refused. Persisted settings
   *  can also engage this; the flag is the posture for ONE process. */
  readonly readOnly: boolean;
  /** …and refuse the un-toggle too, so the mode cannot be lifted over the
   *  wire by whoever is driving. Implies {@link ServeFlags.readOnly}. */
  readonly readOnlyLocked: boolean;
};

function parseServeFlags(argv: readonly string[]): ServeFlags {
  const args = parseVerbArgs("serve", argv, {
    port: "value",
    host: "value",
    "no-auth": "boolean",
    "no-open": "boolean",
    smoke: "boolean",
    "read-only": "boolean",
    "read-only-locked": "boolean",
  });
  if (args.positional.length > 0) {
    throw new Error(`hangar serve: unexpected argument "${args.positional[0]}"`);
  }
  const portFlag = args.flags.get("port");
  let port: number | undefined;
  if (typeof portFlag === "string") {
    port = Number.parseInt(portFlag, 10);
    if (Number.isNaN(port) || String(port) !== portFlag.trim() || port < 0 || port > 65535) {
      throw new Error(`hangar serve: --port must be an integer 0..65535 (got "${portFlag}")`);
    }
  }
  const hostFlag = args.flags.get("host");
  // `--read-only-locked` is the strictly stronger posture, so it implies
  // `--read-only`: an operator who types only the lock must not get a
  // writable console because they omitted the weaker flag.
  const readOnlyLocked = args.flags.get("read-only-locked") === true;
  const flags: ServeFlags = {
    port,
    host: typeof hostFlag === "string" ? hostFlag : undefined,
    noAuth: args.flags.get("no-auth") === true,
    noOpen: args.flags.get("no-open") === true,
    smoke: args.flags.get("smoke") === true,
    readOnly: readOnlyLocked || args.flags.get("read-only") === true,
    readOnlyLocked,
  };
  if (flags.host !== undefined && flags.noAuth) {
    throw new Error(
      "hangar serve: --host exposes the console beyond loopback and REQUIRES auth — drop --no-auth",
    );
  }
  if (flags.smoke && flags.noAuth) {
    throw new Error(
      "hangar serve: --smoke verifies the auth surface (401 without a token) — it cannot combine with --no-auth",
    );
  }
  if (flags.smoke && flags.port !== undefined) {
    throw new Error("hangar serve: --smoke always boots on an ephemeral port — drop --port");
  }
  return flags;
}

/** A marker the embedded UI shell must carry — asserted by `--smoke` so a
 *  compiled binary that lost the static-asset embedding fails loudly. */
const UI_SHELL_MARKER = "Hangar — CrewHaus";

const SMOKE_FETCH_TIMEOUT_MS = 10_000;

/** The `--smoke` self-checks, in order; the first failure names itself. */
async function runSmokeChecks(server: HangarServer, write: (line: string) => void): Promise<0 | 1> {
  const token = server.token ?? "";
  const get = (path: string, headers?: Record<string, string>): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      ...(headers !== undefined ? { headers } : {}),
      signal: AbortSignal.timeout(SMOKE_FETCH_TIMEOUT_MS),
    });
  const checks: ReadonlyArray<{ readonly name: string; readonly run: () => Promise<void> }> = [
    {
      name: "GET /healthz answers ok",
      run: async () => {
        const res = await get("/healthz");
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok !== true) throw new Error(`body ${JSON.stringify(body)}`);
      },
    },
    {
      name: "GET / serves the embedded UI shell",
      run: async () => {
        const res = await get("/");
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const text = await res.text();
        if (!text.includes(UI_SHELL_MARKER)) {
          throw new Error(`response is not the embedded console (missing "${UI_SHELL_MARKER}")`);
        }
      },
    },
    {
      name: "GET /api/harnesses with the bearer token answers 200 JSON",
      run: async () => {
        const res = await get("/api/harnesses", { authorization: `Bearer ${token}` });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        await res.json();
      },
    },
    {
      name: "GET /api/harnesses without a token is refused (401)",
      run: async () => {
        const res = await get("/api/harnesses");
        if (res.status !== 401) throw new Error(`status ${res.status} (expected 401)`);
      },
    },
  ];
  for (const check of checks) {
    try {
      await check.run();
      write(`✓ ${check.name}`);
    } catch (err) {
      write(`✗ ${check.name}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  write("smoke: all checks passed");
  return 0;
}

/** The boxed boot summary (plain box-drawing, no color codes). */
function summaryLines(
  server: HangarServer,
  openUrl: string,
  harnessCount: number | undefined,
): string[] {
  const rows: Array<[string, string]> = [["url", openUrl]];
  if (server.noAuth) {
    rows.push(["auth", "DISABLED (--no-auth) — every local process can read this fleet's state"]);
  } else {
    rows.push([
      "token",
      `${server.tokenPath ?? "(supplied via options)"} — sent as a URL #fragment`,
    ]);
  }
  rows.push([
    "registry",
    `${server.registryPath}${harnessCount !== undefined ? ` (${harnessCount} harness(es))` : ""}`,
  ]);
  rows.push([
    "stop",
    "Ctrl-C (SIGINT/SIGTERM) — stops attached runs, leaves daemons up, releases the lock",
  ]);
  const width = Math.max(...rows.map(([k]) => k.length));
  return [
    "┌─ Hangar — the CrewHaus harness manager",
    ...rows.map(([k, v]) => `│  ${k.padEnd(width)}  ${v}`),
    "└─",
  ];
}

/**
 * Every supervisor this manager is holding.
 *
 * THE SOURCE IS THE PROCESS LAYER, NOT THE REGISTRY. `ProcessLayer.held()`
 * enumerates the handle map — the only authority on which supervisors hold a
 * pid. The registry is a strictly smaller and differently-keyed set: handles
 * are keyed by the dir they were CREATED with, `DELETE /api/h/:id` and
 * `POST /api/h/:id/relocate` (and their `crewhaus harness` twins) mutate the
 * registry with no live-run guard, and nothing prunes the handle map. Driving
 * shutdown from `registry.list()` therefore drops any harness removed or
 * relocated mid-session: not signalled, not even named in the report. The
 * guaranteed casualty is the detached one-shot class (`workflow`, `graph`,
 * `pipeline`, `research`, `eval`, `onchain`), which lives in its own process
 * group — immune to the terminal's SIGINT — and writes no runfile, so no
 * later manager can enumerate, adopt, stop or name it either.
 *
 * `held()` is the side-effect-free half of the layer, like `peek`: it returns
 * already-created handles only, so enumerating for shutdown never builds a
 * supervisor — and therefore never adopts a daemon — as a side effect of
 * going down. This function only de-duplicates, keeping that property intact.
 *
 * Exported because it is the seam the shutdown wiring is tested through.
 */
export function heldSupervisors(
  handles: readonly { readonly supervisor: ShutdownSupervisor }[],
): ShutdownSupervisor[] {
  const held: ShutdownSupervisor[] = [];
  const seen = new Set<ShutdownSupervisor>();
  for (const handle of handles) {
    if (seen.has(handle.supervisor)) continue;
    seen.add(handle.supervisor);
    held.push(handle.supervisor);
  }
  return held;
}

async function hangarServe(
  argv: readonly string[],
  opts: HangarCommandOptions,
): Promise<HangarCommandResult> {
  const flags = parseServeFlags(argv);
  const env = opts.env ?? process.env;
  // HM-201 — the remote-bind opt-in. `parseServeFlags` is pure argv, and
  // this gate reads the environment, so it lives here rather than in the
  // parser: everything the refusal depends on is injected, and the check
  // runs BEFORE the lock is claimed, the registry is opened, or a socket is
  // bound. `--host` already implies auth (M1); this is the second gate,
  // because a bearer token over plain HTTP is a poor answer to a LAN.
  const remoteRefusal = remoteBindRefusal(flags.host, env);
  if (remoteRefusal !== undefined) throw new Error(remoteRefusal);
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const hangarRoot = resolveHangarRoot(env);

  const alreadyRunning = (existing: HangarLock): Error =>
    new Error(
      `hangar is already running at ${existing.url !== "" ? existing.url : "an unknown url"} (pid ${existing.pid}) — use \`crewhaus hangar open\`, or stop that instance first`,
    );

  // Fail fast BEFORE booting anything when a live instance holds the lock.
  const existing = readHangarLock(hangarRoot);
  if (existing !== undefined && existing.pid !== pid && isPidAlive(existing.pid)) {
    throw alreadyRunning(existing);
  }

  // Seed the registry from the legacy watchme store — best-effort by
  // contract: a failure here must never block the console.
  const registry = openRegistrySafe(opts);
  try {
    const seeded = registry?.seedFromWatchme();
    if (seeded !== undefined && seeded.imported > 0) {
      write(`seeded ${seeded.imported} harness(es) from the legacy watchme registry`);
    }
  } catch {
    // Best-effort: the watchme store is optional interop.
  }

  const version = cliVersion();
  const server = (opts.startServer ?? startHangarServer)({
    port: flags.smoke ? 0 : (flags.port ?? DEFAULT_HANGAR_PORT),
    ...(flags.host !== undefined ? { hostname: flags.host } : {}),
    root: hangarRoot,
    ...(flags.noAuth ? { noAuth: true } : {}),
    ...(flags.readOnly ? { readOnly: true } : {}),
    ...(flags.readOnlyLocked ? { readOnlyLocked: true } : {}),
    assets: hangarAssets,
    env,
    now,
    ...(version !== undefined ? { version } : {}),
  });

  // Claim the lock with the real bound port. The pre-boot check above makes
  // this a formality, but a boot race still resolves to exactly one winner.
  const acquired = acquireHangarLock(
    hangarRoot,
    { pid, startedAt: new Date(now()).toISOString(), port: server.port, url: server.url },
    isPidAlive,
  );
  if (!acquired.ok) {
    await server.stop();
    throw alreadyRunning(acquired.existing);
  }
  if (acquired.staleNote !== undefined) write(`note: ${acquired.staleNote}`);

  // M2: the process picture. `Bun.serve` already bound, so the console is
  // reachable either way; awaiting the boot means the first paint shows
  // adopted daemons rather than an empty fleet that fills in a beat later.
  // Order inside: port ledger → adopt() per registered harness →
  // jobQueue.restore() (pending re-enqueued, running closed as
  // `interrupted`, never silently re-run).
  const booted = await server.ready;
  if (booted.adopted > 0 || booted.lost > 0 || booted.jobs > 0) {
    write(
      `adopted ${booted.adopted} running daemon(s)${
        booted.lost > 0 ? `, ${booted.lost} gone since the last manager` : ""
      }${booted.jobs > 0 ? `, re-queued ${booted.jobs} pending job(s)` : ""}`,
    );
  }

  if (flags.smoke) {
    write(`smoke: booted ${server.url} (ephemeral port ${server.port})`);
    let exitCode: 0 | 1;
    try {
      exitCode = await runSmokeChecks(server, write);
    } finally {
      await server.stop();
      releaseHangarLock(hangarRoot, pid);
    }
    return { lines: [], exitCode };
  }

  const openUrl = fragmentUrl(server.url, server.token);
  for (const line of summaryLines(server, openUrl, registry?.list().length)) write(line);
  if (!flags.noOpen) {
    (opts.openBrowser ?? openInBrowser)(handoffUrl(server.url, server.bootPath));
  }

  // Block until SIGINT/SIGTERM, then stop cleanly and release the lock.
  await new Promise<void>((resolveWait) => {
    const onSigint = (): void => {
      process.removeListener("SIGTERM", onSigterm);
      resolveWait();
    };
    const onSigterm = (): void => {
      process.removeListener("SIGINT", onSigint);
      resolveWait();
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
  write("hangar: shutting down…");
  // Children FIRST, before the socket and before the lock. Freeing the port
  // while this manager still holds children is precisely the observed
  // failure: a second manager bound the port and the first lived on with a
  // job child under it. Holding the port until supervision has settled is
  // what makes "the console is up" and "the console owns these processes"
  // the same statement.
  const report = await runManagerShutdown({
    supervisors: heldSupervisors(server.processes.held()),
    jobs: server.processes.jobs,
    ...(opts.shutdownGraceMs !== undefined ? { graceMs: opts.shutdownGraceMs } : {}),
    ...(opts.shutdownDeadlineMs !== undefined ? { deadlineMs: opts.shutdownDeadlineMs } : {}),
  });
  await server.stop();
  releaseHangarLock(hangarRoot, pid);
  for (const line of shutdownReportLines(report)) write(line);
  // Deterministic exit. Even with every child stopped or detached, a
  // half-drained pipe or a straggling handle can keep the loop alive, and a
  // manager that has already given up its lock and its port must not linger:
  // that is the state an operator reads as "it exited" and an orphan hunter
  // finds hours later.
  (opts.exit ?? ((code: 0 | 1): void => process.exit(code)))(0);
  return { lines: [], exitCode: 0 };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function hangarStatus(argv: readonly string[], opts: HangarCommandOptions): HangarCommandResult {
  const args = parseVerbArgs("status", argv, { json: "boolean" });
  const env = opts.env ?? process.env;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const hangarRoot = resolveHangarRoot(env);
  const lock = readHangarLock(hangarRoot);
  const running = lock !== undefined && isPidAlive(lock.pid);
  const staleLock = lock !== undefined && !running;
  const registry = openRegistrySafe(opts);
  const harnessCount = registry !== undefined ? registry.list().length : undefined;
  const tokenPath = join(hangarRoot, TOKEN_FILENAME);
  const tokenPresent = existsSync(tokenPath);

  if (args.flags.get("json") === true) {
    return {
      lines: jsonLines({
        running,
        ...(running && lock !== undefined
          ? { pid: lock.pid, port: lock.port, url: lock.url, startedAt: lock.startedAt }
          : {}),
        staleLock,
        hangarRoot,
        lockPath: join(hangarRoot, HANGAR_LOCK_FILENAME),
        registryPath: registry?.path ?? null,
        harnessCount: harnessCount ?? null,
        tokenPath,
        tokenPresent,
      }),
      exitCode: 0,
    };
  }

  const lines: string[] = [];
  if (running && lock !== undefined) {
    lines.push(
      `hangar: running at ${lock.url} (pid ${lock.pid}, port ${lock.port}, since ${lock.startedAt})`,
    );
    lines.push("  open it with `crewhaus hangar open`");
  } else {
    lines.push("hangar: not running — start it with `crewhaus hangar`");
    if (staleLock && lock !== undefined) {
      lines.push(
        `  note: stale hangar.lock at ${join(hangarRoot, HANGAR_LOCK_FILENAME)} (pid ${lock.pid} is dead) — the next boot replaces it`,
      );
    }
  }
  lines.push(
    registry !== undefined
      ? `registry: ${registry.path} (${harnessCount} harness(es))`
      : "registry: unreadable",
  );
  lines.push(tokenPresent ? `token: ${tokenPath}` : `token: none minted yet (${tokenPath})`);
  return { lines, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

async function hangarOpen(
  argv: readonly string[],
  opts: HangarCommandOptions,
): Promise<HangarCommandResult> {
  parseVerbArgs("open", argv, {});
  const env = opts.env ?? process.env;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const hangarRoot = resolveHangarRoot(env);
  const lock = readHangarLock(hangarRoot);
  if (lock === undefined || !isPidAlive(lock.pid) || lock.url === "") {
    return {
      lines: ["hangar is not running — start it with `crewhaus hangar`"],
      exitCode: 1,
    };
  }
  // Re-read the token file so the fragment survives console restarts that
  // reminted it. A missing token file (a --no-auth boot) opens the bare url.
  let token: string | undefined;
  try {
    token = readFileSync(join(hangarRoot, TOKEN_FILENAME), "utf8").trim();
  } catch {
    token = undefined;
  }
  // Trade the token (which we can read from disk) for a single-use handoff
  // path, so the browser command line carries no secret. If the running
  // console is older or unreachable, fall back to opening the bare url and
  // let the UI's token screen take over — never put the token in argv.
  let handoff = lock.url;
  if (token !== undefined && token !== "") {
    try {
      const res = await fetch(`${lock.url}/api/boot-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { bootPath?: unknown };
        if (typeof body.bootPath === "string") handoff = handoffUrl(lock.url, body.bootPath);
      }
    } catch {
      // Unreachable or auth-disabled console — bare url below.
    }
  }
  (opts.openBrowser ?? openInBrowser)(handoff);
  // Printed for manual copy: the operator's own terminal, not another
  // process's argv.
  return { lines: [fragmentUrl(lock.url, token)], exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Run `crewhaus hangar [<verb>] …`. Bare `hangar` (with or without flags)
 *  serves; bad arguments throw plain `Error`s (the entry file routes them
 *  through `die()`); everything else returns lines + an exit code. */
export async function runHangarCommand(
  argv: readonly string[],
  opts: HangarCommandOptions = {},
): Promise<HangarCommandResult> {
  const verb = argv[0] ?? "";
  if (verb === "--help" || verb === "-h") return { lines: HANGAR_USAGE_LINES, exitCode: 0 };
  // Bare `crewhaus hangar [--flags]` is `hangar serve [--flags]`.
  if (verb === "" || verb.startsWith("--")) return await hangarServe(argv, opts);
  switch (verb) {
    case "serve":
      return await hangarServe(argv.slice(1), opts);
    case "status":
      return hangarStatus(argv.slice(1), opts);
    case "open":
      return await hangarOpen(argv.slice(1), opts);
    default:
      throw new Error(`unknown hangar verb "${verb}" (expected: serve | status | open)`);
  }
}
