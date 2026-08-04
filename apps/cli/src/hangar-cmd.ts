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
 * injected `write` sink because it blocks until SIGINT/SIGTERM. Bad
 * arguments throw plain `Error`s; the entry file routes them through
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
  TOKEN_FILENAME,
  startHangarServer,
} from "@crewhaus/hangar-server";
import { hangarAssets } from "@crewhaus/hangar-ui";
import {
  type HangarRegistry,
  openHangarRegistry,
  resolveRegistryRoot,
} from "@crewhaus/harness-registry";
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
};

const HANGAR_USAGE_LINES: readonly string[] = [
  "usage:",
  "  crewhaus hangar [serve]                      boot the Hangar manager console (the local",
  "       [--port <n>] [--host <h>]               web UI over the machine-wide harness",
  "       [--no-auth] [--no-open] [--smoke]       registry) and open it in the browser",
  "  crewhaus hangar status [--json]              lock/port/registry/token report — works",
  "                                               without a running server",
  "  crewhaus hangar open                         print + open the running console's URL",
  "",
  "  The console binds 127.0.0.1:4200 by default and hands its bearer token",
  "  to the browser as a URL #fragment (never a query string). --host binds",
  "  another interface and REQUIRES auth; --no-auth is loopback-dev only.",
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

/**
 * Claim the single-instance lock. A live foreign pid refuses; a stale lock
 * (dead pid or unreadable file) is replaced and reported via `staleNote`;
 * re-acquiring under our own pid just rewrites (port updates after boot).
 */
export function acquireHangarLock(
  hangarRoot: string,
  lock: HangarLock,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): LockAcquisition {
  const existing = readHangarLock(hangarRoot);
  if (existing !== undefined && existing.pid !== lock.pid) {
    if (isPidAlive(existing.pid)) return { ok: false, existing };
    writeHangarLock(hangarRoot, lock);
    return {
      ok: true,
      staleNote: `replaced a stale hangar.lock left by pid ${existing.pid} (process no longer running)`,
    };
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

/** The open URL: token as a #fragment (never a query string — fragments
 *  never leave the browser, so the token cannot leak into logs/referrers). */
function fragmentUrl(baseUrl: string, token: string | undefined): string {
  return token !== undefined && token !== "" ? `${baseUrl}/#t=${token}` : baseUrl;
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
};

function parseServeFlags(argv: readonly string[]): ServeFlags {
  const args = parseVerbArgs("serve", argv, {
    port: "value",
    host: "value",
    "no-auth": "boolean",
    "no-open": "boolean",
    smoke: "boolean",
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
  const flags: ServeFlags = {
    port,
    host: typeof hostFlag === "string" ? hostFlag : undefined,
    noAuth: args.flags.get("no-auth") === true,
    noOpen: args.flags.get("no-open") === true,
    smoke: args.flags.get("smoke") === true,
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
  rows.push(["stop", "Ctrl-C (SIGINT/SIGTERM) — releases the hangar.lock"]);
  const width = Math.max(...rows.map(([k]) => k.length));
  return [
    "┌─ Hangar — the CrewHaus harness manager",
    ...rows.map(([k, v]) => `│  ${k.padEnd(width)}  ${v}`),
    "└─",
  ];
}

async function hangarServe(
  argv: readonly string[],
  opts: HangarCommandOptions,
): Promise<HangarCommandResult> {
  const flags = parseServeFlags(argv);
  const env = opts.env ?? process.env;
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
  const server = startHangarServer({
    port: flags.smoke ? 0 : (flags.port ?? DEFAULT_HANGAR_PORT),
    ...(flags.host !== undefined ? { hostname: flags.host } : {}),
    root: hangarRoot,
    ...(flags.noAuth ? { noAuth: true } : {}),
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
  if (!flags.noOpen) (opts.openBrowser ?? openInBrowser)(openUrl);

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
  await server.stop();
  releaseHangarLock(hangarRoot, pid);
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

function hangarOpen(argv: readonly string[], opts: HangarCommandOptions): HangarCommandResult {
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
  const url = fragmentUrl(lock.url, token);
  (opts.openBrowser ?? openInBrowser)(url);
  return { lines: [url], exitCode: 0 };
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
      return hangarOpen(argv.slice(1), opts);
    default:
      throw new Error(`unknown hangar verb "${verb}" (expected: serve | status | open)`);
  }
}
