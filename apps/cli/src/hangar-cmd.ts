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
 * Home's own key (`<hangarRoot>/token`) stays on this computer: no printed
 * line, QR code or argument list carries it. A browser on this computer signs
 * in through a single-use boot link (`/boot/<nonce>`), which redirects to a
 * one-time code the browser trades, with a key of its own, for a session.
 * The CLI mints that link with Home's own key over `<hangarRoot>/home.sock`
 * (TCP loopback where there is no socket).
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
 * `--lan` is the phone door: it binds the address `lan-address.ts` picks for
 * this machine (and loopback beside it, so this computer's own browser still
 * signs in) and prints a QR code (`@crewhaus/qr-code`, imported STATICALLY
 * for the same compiled-binary reason as the UI assets) that encodes an invite
 * link, `<lan address>/invite#c=<code>`: a single-use invite that works for 10
 * minutes, as a viewer of the whole Home unless `--lan-role` names another
 * role. The phone opens it, types a name, and joins as a member with that
 * role. `crewhaus hangar qr` mints a fresh one each time. It is its own opt-in
 * rather than a second `--host`: typing it is exactly the deliberate, visible
 * act HM-201 asks for, so the environment variable is not demanded on top.
 * Nothing else is relaxed — auth stays mandatory.
 *
 * Every verb that resolves Home's directory first refuses one taken from a
 * `.env` file in the working directory (`hangar-env.ts`).
 *
 * Bad arguments throw plain `Error`s; the entry file routes them through
 * `die()` like `harness` does.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import {
  HOME_SOCKET,
  type LocalIdentity,
  loadAccessSnapshot,
  noAuthRefusal,
} from "@crewhaus/access-control";
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";
import {
  currentLocalIdentity,
  outcomeOf,
  wireControl,
  withOwnStartTime,
} from "@crewhaus/control-service";
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
  resolveHangarRoot,
} from "@crewhaus/harness-registry";
import {
  type ShutdownSupervisor,
  createProcessOps,
  homeCrewhausArgv,
  runManagerShutdown,
  shutdownReportLines,
} from "@crewhaus/harness-supervisor";
import { encodeQr, renderQrLines, renderedWidth } from "@crewhaus/qr-code";
import { inviteAsLocalUser } from "./access-cmd";
import { dotenvRootRefusal } from "./hangar-env";
import { rotateTokenVerb } from "./hangar-rotate";
import {
  type ServiceDeps,
  install as installService,
  readLastRecovery,
  residentState,
  uninstall as uninstallService,
} from "./hangar-service";
import { assetSmokeCheck, problemSummary } from "./hangar-smoke";
import {
  type InterfaceMap,
  type LanAddress,
  NO_LAN_ADDRESS_REFUSAL,
  pickLanAddress,
} from "./lan-address";
import { REMOTE_BIND_ENV, isLoopbackHost, remoteBindRefusal } from "./remote-bind";
import type { CliFamily } from "./verbs";
import { cliVersion } from "./version";

/** What a verb returns: lines for stdout + the process exit code. `serve`
 *  streams through the `write` sink instead (it blocks), so its lines come
 *  back empty. */
export type HangarCommandResult = {
  readonly lines: readonly string[];
  /** 0, 1, or a control-plane exit (53 conflict, 54 unsupported, 55 invalid). */
  readonly exitCode: number;
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
  /** This machine's network interfaces, for `--lan`. Injected so a test can
   *  choose the fleet's address without depending on the host it runs on;
   *  defaults to `os.networkInterfaces()`. */
  readonly networkInterfaces?: () => InterfaceMap;
  /** Terminal width used to decide whether a QR code will fit; defaults to
   *  `process.stdout.columns`, and an unknown width is treated as wide
   *  enough (a redirected stdout has no columns and no reader to confuse). */
  readonly columns?: number | undefined;
  /** Whether to wrap the QR code in the SGR pair that pins its contrast.
   *  Defaults to "stdout is a TTY and NO_COLOR is unset". */
  readonly color?: boolean;
  /** The working directory whose `.env*` files must not choose Home's
   *  directories; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Reads a dotenv file for that check; injected by tests. */
  readonly readFile?: (path: string) => string | undefined;
  /** The OS user acting (`rotate-token`); `os.userInfo()` and `os.hostname()` by default. */
  readonly identity?: LocalIdentity;
  /**
   * The installed service's seams (`install`, `uninstall`, `status`): the platform, home
   * directory, PATH lookup, command runner and the rest. Each defaults to the real one.
   */
  readonly service?: Partial<ServiceDeps>;
};

const HANGAR_USAGE_LINES: readonly string[] = [
  "usage:",
  "  crewhaus hangar [serve]                      boot the Hangar manager console (the local",
  "       [--port <n>] [--host <h>] [--lan]       web UI over the machine-wide harness",
  "       [--allow-host <name>]...                registry) and open it in the browser",
  "       [--no-auth] [--no-open] [--no-qr]",
  "       [--lan-role <role>]",
  "       [--smoke] [--read-only]",
  "       [--read-only-locked]",
  "  crewhaus hangar status [--json]              lock/port/registry report — works without",
  "                                               a running server",
  "  crewhaus hangar open [--print]               sign a browser on this computer in",
  "  crewhaus hangar qr [--ascii] [--no-color]    a fresh invite QR code for the running console",
  "  crewhaus hangar rotate-token [--socket-only | --tcp]",
  "                                               replace Home's own key",
  "  crewhaus hangar install [--yes]              run Home as a service that starts when you",
  "                                               sign in and needs no open window",
  "  crewhaus hangar uninstall [--yes]            stop and remove that service, keeping your data",
  "",
  "  The console binds 127.0.0.1:4200 by default. A browser on this computer",
  "  signs in through a one-time link that `crewhaus hangar` and",
  "  `crewhaus hangar open` open for you; `open --print` shows the link instead,",
  "  to paste into the sign-in screen (it works once, for 2 minutes). Home's own",
  "  key stays in its directory: it works only from this computer.",
  "  --host binds another interface: it REQUIRES auth and, because the console",
  `  is machine control over plain HTTP, also ${REMOTE_BIND_ENV}=1.`,
  "  --no-auth is loopback-dev only, and is refused while a trusted proxy is",
  "  set or anyone other than the owner has access.",
  "  --lan binds this machine's LAN address as well, and prints a QR code to",
  "  scan with a phone on the same network. It is its own opt-in — typing it",
  `  is the deliberate act ${REMOTE_BIND_ENV} asks for. The code is an invite:`,
  "  it works once, for 10 minutes, and joins the phone as a viewer of this",
  "  Home (--lan-role operator|maintainer|owner gives another role), over",
  "  plain HTTP. --no-qr skips it.",
  "  --allow-host <name> adds a name Home answers to (a name in your hosts",
  "  file, say); any other name gets 421. Repeat it for more than one.",
  "  --read-only boots the console with every mutating route refused (403) —",
  "  the screen-share posture; it can still be lifted from the UI. Add",
  "  --read-only-locked when the person driving is not the person who owns",
  "  the machine: the mode then cannot be turned off over the wire, only by",
  "  restarting the manager without the flag.",
  "  --smoke boots on an ephemeral port, self-checks the embedded UI, the",
  "  sign-in rules and the Host check, and exits — the release workflow's",
  "  compiled-binary smoke entry.",
  "  rotate-token replaces Home's own key and signs every browser out;",
  "  --socket-only takes the key off TCP for good (only the CLI, over",
  "  <hangarRoot>/home.sock, uses it), and --tcp puts it back. It works with",
  "  Home running.",
  "  Home's directories (CREWHAUS_HANGAR_ROOT, CREWHAUS_REGISTRY_ROOT) are read",
  "  from your shell only, never from a .env file.",
  "  One instance per hangar root: <hangarRoot>/hangar.lock (stale locks",
  "  from dead pids are replaced automatically).",
  "  install shows the file it writes and the commands it runs, then asks",
  "  (--yes skips the question). The service runs `crewhaus hangar serve",
  "  --resident`: sign-in is always on, it opens no browser, and after the",
  "  machine starts it restarts only the harnesses a person last started.",
  "  `crewhaus hangar` opens it when it is running.",
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
  /** Home in a window, or the installed service. A lock without one is a window's. */
  readonly mode?: "foreground" | "resident";
  /** The `crewhaus` version that holds it, when it said. */
  readonly version?: string;
};

/** What a lock says it is: one written before the service existed is a window's. */
export function lockMode(lock: HangarLock): "foreground" | "resident" {
  return lock.mode === "resident" ? "resident" : "foreground";
}

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
    const mode = raw["mode"];
    const version = raw["version"];
    return {
      pid,
      startedAt: typeof raw["startedAt"] === "string" ? raw["startedAt"] : "",
      port: typeof raw["port"] === "number" ? raw["port"] : 0,
      url: typeof raw["url"] === "string" ? raw["url"] : "",
      ...(mode === "resident" || mode === "foreground" ? { mode } : {}),
      ...(typeof version === "string" ? { version } : {}),
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
 *  registry root, and keeps everything under one temp root in tests. This is
 *  `@crewhaus/harness-registry`'s resolver, the one the fleet tools and the
 *  runtime-state floor use too. */
export { resolveHangarRoot };

/**
 * The `hangar` family in the CLI's verb inventory (`verbs.ts`): each sub-verb
 * and the flags its parser takes. A bare `crewhaus hangar [--flags]` is
 * `serve`. Every `parseVerbArgs` call below reads its flags from here, and the
 * key order is the order the unknown-verb message lists them in.
 */
export const CLI_FAMILY = {
  verb: "hangar",
  since: "0.8.0",
  bare: "serve",
  sub: {
    serve: {
      flags: {
        port: "value",
        host: "value",
        lan: "boolean",
        "lan-role": "value",
        "no-auth": "boolean",
        "no-open": "boolean",
        "no-qr": "boolean",
        smoke: "boolean",
        "read-only": "boolean",
        "read-only-locked": "boolean",
        "allow-host": "values",
        resident: "boolean",
      },
    },
    status: { flags: { json: "boolean" } },
    open: { flags: { print: "boolean" } },
    qr: { flags: { ascii: "boolean", "no-color": "boolean" } },
    "rotate-token": { flags: { "socket-only": "boolean", tcp: "boolean" } },
    install: { flags: { yes: "boolean" } },
    uninstall: { flags: { yes: "boolean" } },
  },
} as const satisfies CliFamily;

// ---------------------------------------------------------------------------
// Tiny per-verb flag parsing (harness-cmd posture: throw plain Errors)
// ---------------------------------------------------------------------------

type VerbFlagSpec = Readonly<Record<string, "value" | "values" | "boolean">>;

type VerbArgs = {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
  /** Every value of a repeatable flag, in order. */
  readonly lists: ReadonlyMap<string, readonly string[]>;
};

function parseVerbArgs(verb: string, argv: readonly string[], spec: VerbFlagSpec): VerbArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
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
      if (kind === "value" || kind === "values") {
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`hangar ${verb}: ${a} requires a value`);
        flags.set(name, v);
        if (kind === "values") lists.set(name, [...(lists.get(name) ?? []), v]);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, lists };
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

/** The URL to HAND TO THE BROWSER: the server's single-use `/boot/<nonce>`
 *  path, which redirects once to a one-time sign-in code. A child process's
 *  argv is readable by every other process on the machine, and a nonce
 *  scraped from a process list is already spent. */
function handoffUrl(baseUrl: string, bootPath: string | undefined): string {
  return bootPath !== undefined && bootPath !== "" ? `${baseUrl}${bootPath}` : baseUrl;
}

/** The address a browser on THIS computer opens: loopback, at the same port,
 *  whatever else Home is bound to (a plain-HTTP LAN address is no place to
 *  sign in from: WebCrypto exists only on an encrypted or local page). */
export function loopbackBase(url: string, port: number): string {
  const host = hostFromUrl(url);
  return host !== undefined && isLoopbackHost(host) ? url : `http://127.0.0.1:${port}`;
}

/** Stop before anything else when Home's directory came from a dotenv file. */
function refuseDotenvRoots(opts: HangarCommandOptions): void {
  const refusal = dotenvRootRefusal({
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.readFile !== undefined ? { readFile: opts.readFile } : {}),
  });
  if (refusal !== undefined) throw new Error(refusal);
}

const BOOT_TICKET_TIMEOUT_MS = 5_000;

/** What the running console answered a boot-link request. */
type BootPathAnswer =
  | { readonly kind: "minted"; readonly bootPath: string }
  /** Home refused the key in `<hangarRoot>/token`: the file is not the key it recorded. */
  | { readonly kind: "key-refused" }
  | { readonly kind: "unavailable" };

/**
 * Mint a single-use boot link on the running console with Home's own key,
 * over `<hangarRoot>/home.sock` when it is there (TCP loopback otherwise).
 */
async function mintBootPath(hangarRoot: string, lock: HangarLock): Promise<BootPathAnswer> {
  const unavailable = { kind: "unavailable" } as const;
  let token: string;
  try {
    token = readFileSync(join(hangarRoot, TOKEN_FILENAME), "utf8").trim();
  } catch {
    return unavailable;
  }
  if (token === "") return unavailable;
  const sock = join(hangarRoot, HOME_SOCKET);
  const init = {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(BOOT_TICKET_TIMEOUT_MS),
  };
  try {
    const res = existsSync(sock)
      ? await fetch("http://localhost/api/boot-ticket", { ...init, unix: sock } as RequestInit)
      : await fetch(`${loopbackBase(lock.url, lock.port)}/api/boot-ticket`, init);
    if (res.status === 401) {
      const body = (await res.json().catch(() => ({}))) as { reason?: unknown };
      return body.reason === "credential_unknown" ? { kind: "key-refused" } : unavailable;
    }
    if (!res.ok) return unavailable;
    const body = (await res.json()) as { bootPath?: unknown };
    return typeof body.bootPath === "string" && /^\/boot\/[0-9a-f]{64}$/.test(body.bootPath)
      ? { kind: "minted", bootPath: body.bootPath }
      : unavailable;
  } catch {
    return unavailable;
  }
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
  /** Bind this machine's LAN address and print a scannable QR code. Its own
   *  HM-201 opt-in; see {@link resolveBindHost}. */
  readonly lan: boolean;
  /** Suppress the QR code a LAN bind would otherwise print. */
  readonly noQr: boolean;
  /** The role the `--lan` QR code's invite joins with. */
  readonly lanRole: LanRole;
  /** More names Home answers to (`--allow-host`, repeatable). */
  readonly allowHosts: readonly string[];
  /** Run as the installed service: sign-in on, no browser, no QR, reboot recovery. */
  readonly resident: boolean;
};

/** The flags the installed service refuses: it is always signed in, local and writable. */
const RESIDENT_REFUSED_FLAGS = [
  "no-auth",
  "lan",
  "smoke",
  "read-only",
  "read-only-locked",
] as const;

/** Why `serve --resident` refuses these flags, or `undefined` when it does not. */
function residentFlagRefusal(argv: readonly string[]): string | undefined {
  const args = parseVerbArgs("serve", argv, CLI_FAMILY.sub.serve.flags);
  if (args.flags.get("resident") !== true) return undefined;
  const refused = RESIDENT_REFUSED_FLAGS.filter((flag) => args.flags.get(flag) === true);
  if (refused.length === 0) return undefined;
  return `hangar serve --resident: the service always runs with sign-in on, on this computer, and writable — drop ${refused.map((flag) => `--${flag}`).join(", ")}`;
}

function parseServeFlags(argv: readonly string[]): ServeFlags {
  const args = parseVerbArgs("serve", argv, CLI_FAMILY.sub.serve.flags);
  if (args.positional.length > 0) {
    throw new Error(`hangar serve: unexpected argument "${args.positional[0]}"`);
  }
  const allowHosts = [...(args.lists.get("allow-host") ?? [])];
  for (const name of allowHosts) {
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(name) || name.startsWith(".") || name.endsWith(".")) {
      throw new Error(`hangar serve: --allow-host takes a host name (got "${name}")`);
    }
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
  const lanRoleFlag = args.flags.get("lan-role");
  if (lanRoleFlag !== undefined) {
    if (typeof lanRoleFlag !== "string" || !isLanRole(lanRoleFlag)) {
      throw new Error(
        `hangar serve: --lan-role takes one of ${LAN_ROLES.join(", ")} (got "${String(lanRoleFlag)}")`,
      );
    }
    if (args.flags.get("lan") !== true) {
      throw new Error("hangar serve: --lan-role names the role the --lan invite gives — add --lan");
    }
  }
  // `--read-only-locked` is the strictly stronger posture, so it implies
  // `--read-only`: an operator who types only the lock must not get a
  // writable console because they omitted the weaker flag.
  const readOnlyLocked = args.flags.get("read-only-locked") === true;
  const flags: ServeFlags = {
    port,
    host: typeof hostFlag === "string" ? hostFlag : undefined,
    lan: args.flags.get("lan") === true,
    noAuth: args.flags.get("no-auth") === true,
    noOpen: args.flags.get("no-open") === true,
    noQr: args.flags.get("no-qr") === true,
    lanRole: typeof lanRoleFlag === "string" && isLanRole(lanRoleFlag) ? lanRoleFlag : "viewer",
    smoke: args.flags.get("smoke") === true,
    readOnly: readOnlyLocked || args.flags.get("read-only") === true,
    readOnlyLocked,
    allowHosts,
    resident: args.flags.get("resident") === true,
  };
  if (flags.lan && flags.host !== undefined) {
    throw new Error(
      "hangar serve: --lan picks this machine's LAN address for you and --host names one yourself — pass one or the other",
    );
  }
  // --lan resolves to a non-loopback host, so it inherits every refusal
  // --host carries. Stated separately because the host is not known until
  // the interfaces are read, which happens after this pure-argv parse.
  if (flags.lan && flags.noAuth) {
    throw new Error(
      "hangar serve: --lan exposes the console beyond loopback and REQUIRES auth — drop --no-auth",
    );
  }
  if (flags.lan && flags.smoke) {
    throw new Error(
      "hangar serve: --smoke self-checks a throwaway loopback console — it cannot combine with --lan",
    );
  }
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
  /** As the CLI authenticates: over Home's own socket when there is one. */
  const asCli = (path: string, headers: Record<string, string>): Promise<Response> =>
    server.socketPath !== undefined
      ? fetch(`http://localhost${path}`, {
          headers,
          unix: server.socketPath,
          signal: AbortSignal.timeout(SMOKE_FETCH_TIMEOUT_MS),
        } as RequestInit)
      : get(path, headers);
  const access = loadAccessSnapshot(server.hangarRoot);
  const socketOnly =
    access.state === "present" &&
    access.snapshot.tokens.some(
      (row) => row.kind === "bootstrap" && row.state === "active" && row.socketOnly === true,
    );
  const checks: Array<{ readonly name: string; readonly run: () => Promise<void> }> = [
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
      name: "every embedded console file serves with its content type",
      run: async () => {
        const result = await assetSmokeCheck(get, hangarAssets);
        if (!result.ok) throw new Error(problemSummary(result.problems));
      },
    },
    {
      name: "GET /api/harnesses with Home's own key answers 200 JSON",
      run: async () => {
        const res = await asCli("/api/harnesses", { authorization: `Bearer ${token}` });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        await res.json();
      },
    },
    {
      name: "GET /api/harnesses without a credential is refused (401)",
      run: async () => {
        const res = await get("/api/harnesses");
        if (res.status !== 401) throw new Error(`status ${res.status} (expected 401)`);
      },
    },
    {
      name: "an undeclared /api path is refused (404)",
      run: async () => {
        const res = await asCli("/api/no-such-route", { authorization: `Bearer ${token}` });
        if (res.status !== 404) throw new Error(`status ${res.status} (expected 404)`);
      },
    },
    {
      name: "a request with a foreign Host is refused (421)",
      run: async () => {
        const res = await get("/api/harnesses", {
          host: "rebind.example.test",
          authorization: `Bearer ${token}`,
        });
        if (res.status !== 421) throw new Error(`status ${res.status} (expected 421)`);
        // The plain-text refusal, never an /api answer.
        const type = res.headers.get("content-type") ?? "";
        const text = await res.text();
        if (!type.startsWith("text/plain") || text.includes("harnesses")) {
          throw new Error("the refusal carried a body from /api");
        }
      },
    },
  ];
  if (socketOnly) {
    checks.push({
      name: "Home's own key is refused over TCP and accepted on its socket",
      run: async () => {
        const tcp = await get("/api/harnesses", { authorization: `Bearer ${token}` });
        if (tcp.status !== 401) throw new Error(`TCP answered ${tcp.status} (expected 401)`);
        if (server.socketPath === undefined) throw new Error("Home has no socket");
        const sock = await asCli("/api/harnesses", { authorization: `Bearer ${token}` });
        if (sock.status !== 200) throw new Error(`the socket answered ${sock.status}`);
      },
    });
  }
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

/**
 * The host `--lan` binds.
 *
 * A concrete address rather than `0.0.0.0`, for two reasons. The server
 * composes its advertised url by interpolating whatever it was handed, so a
 * wildcard bind yields the literal `http://0.0.0.0:4200` — a string that is
 * written into the lock file, printed by `status`, fetched by `open`, and
 * openable by nothing. And a wildcard also binds every tunnel and bridge the
 * machine happens to have, which is a wider exposure than "my LAN" asks for.
 *
 * `--lan` is its own HM-201 opt-in: typing it IS the deliberate, visible act
 * that {@link REMOTE_BIND_ENV} exists to require, so the refusal is not
 * applied on top of it. What is NOT relaxed is anything else — auth is still
 * mandatory (refused in the parser), and a bare `--host` still needs the
 * variable.
 */
function resolveBindHost(flags: ServeFlags, opts: HangarCommandOptions): LanAddress | undefined {
  if (!flags.lan) return undefined;
  const interfaces = (opts.networkInterfaces ?? (() => networkInterfaces() as InterfaceMap))();
  const chosen = pickLanAddress(interfaces);
  if (chosen === undefined) throw new Error(NO_LAN_ADDRESS_REFUSAL);
  return chosen;
}

/** Whether to pin the QR's contrast with escape codes. A terminal has no
 *  fixed background, so without them the symbol renders inverted on a light
 *  theme; with stdout redirected there is no terminal to pin and no reader
 *  to confuse, so they are dropped. */
function wantsColor(
  opts: HangarCommandOptions,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (opts.color !== undefined) return opts.color;
  const noColor = env["NO_COLOR"];
  if (noColor !== undefined && noColor !== "") return false;
  return process.stdout.isTTY === true;
}

/** Columns available for the QR; `undefined` (a pipe) counts as unlimited. */
function terminalColumns(opts: HangarCommandOptions): number | undefined {
  if (opts.columns !== undefined) return opts.columns;
  const columns = process.stdout.columns;
  return typeof columns === "number" && columns > 0 ? columns : undefined;
}

export type QrBlockOptions = {
  readonly ascii?: boolean;
  readonly color?: boolean;
  readonly columns?: number | undefined;
  /** The line printed above the code. */
  readonly caption?: string;
};

/**
 * A caption plus the rendered symbol, or a note explaining why there isn't
 * one.
 *
 * The width check is the whole reason this returns lines rather than
 * printing: a symbol wider than the terminal wraps, and a wrapped QR code is
 * not a degraded QR code, it is a picture. Saying so — with both numbers and
 * the command that reprints it — beats emitting something unscannable.
 */
export function qrBlockLines(url: string, options: QrBlockOptions = {}): string[] {
  const qr = encodeQr(url, { ecLevel: "M" });
  const renderOptions = {
    color: options.color ?? true,
    ...(options.ascii === true ? { ascii: true } : {}),
  };
  const width = renderedWidth(qr, renderOptions);
  const columns = options.columns;
  if (columns !== undefined && width > columns) {
    return [
      `(the QR code needs ${width} columns and this terminal has ${columns} — widen the window and run \`crewhaus hangar qr\`)`,
      url,
    ];
  }
  const caption = options.caption;
  return [...(caption !== undefined ? [caption, ""] : []), ...renderQrLines(qr, renderOptions)];
}

/** The roles a `--lan` invite can give. */
export const LAN_ROLES = ["viewer", "operator", "maintainer", "owner"] as const;
export type LanRole = (typeof LAN_ROLES)[number];

function isLanRole(value: string): value is LanRole {
  return (LAN_ROLES as readonly string[]).includes(value);
}

/** How long a `--lan` QR code's invite works. */
export const LAN_INVITE_TTL_MS = 10 * 60_000;

/** What the `--lan` QR code says above itself. */
export const LAN_QR_CAPTION =
  "scan to join Home on your phone — the code works once, for 10 minutes:";

/**
 * The link a `--lan` QR code encodes: Home's LAN address, the invite page, and the code in
 * the fragment, which never reaches a server log. Pure.
 */
export function lanInviteUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/invite#c=${code}`;
}

/**
 * A single-use invite for the `--lan` QR code, made as this OS user over Home's own
 * records, and the link that carries it; or the reason none could be made.
 */
async function lanInvite(
  baseUrl: string,
  role: LanRole,
  opts: HangarCommandOptions,
): Promise<
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string }
> {
  const made = await inviteAsLocalUser(
    {
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.identity !== undefined ? { identity: opts.identity } : {}),
      ...(opts.isPidAlive !== undefined ? { isPidAlive: opts.isPidAlive } : {}),
    },
    { role, scope: "home", ttlMs: LAN_INVITE_TTL_MS },
  );
  return made.ok ? { ok: true, url: lanInviteUrl(baseUrl, made.code) } : made;
}

/** The QR block for an invite link, and the link itself beneath it. */
function inviteBlockLines(url: string, options: QrBlockOptions): string[] {
  const block = qrBlockLines(url, { ...options, caption: LAN_QR_CAPTION });
  // The link as text too, for a phone that cannot scan: it works once, like the code.
  return block.includes(url) ? block : [...block, "", url];
}

/** The boxed boot summary (plain box-drawing, no color codes). It carries
 *  no credential: Home's own key is named by where it lives, never shown. */
function summaryLines(
  server: HangarServer,
  harnessCount: number | undefined,
  lan: LanAddress | undefined,
  resident = false,
): string[] {
  const rows: Array<[string, string]> = [["url", server.loopbackUrl ?? server.url]];
  if (resident) {
    rows.push(["mode", "the installed service: `crewhaus hangar` opens it"]);
  } else if (lan !== undefined) {
    rows.push([
      "network",
      `${server.url} on ${lan.interfaceName} — every device on this network can reach this console over plain HTTP`,
    ]);
  } else if (!server.noAuth) {
    // The one line that tells an operator the feature exists, on the boot
    // they are most likely to be looking at.
    rows.push([
      "phone",
      "crewhaus hangar --lan — bind this machine's LAN address and print a QR code to scan",
    ]);
  }
  if (server.noAuth) {
    rows.push(["auth", "DISABLED (--no-auth) — every local process can read this fleet's state"]);
  } else {
    rows.push(["sign in", "a browser on this computer: crewhaus hangar open"]);
    rows.push(["key", `${server.tokenPath ?? "(none)"}, stays on this computer`]);
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
  const residentRefusal = residentFlagRefusal(argv);
  if (residentRefusal !== undefined) {
    return { lines: [residentRefusal], exitCode: EXIT_FOR_ERROR.invalid };
  }
  const flags = parseServeFlags(argv);
  refuseDotenvRoots(opts);
  const env = opts.env ?? process.env;
  // HM-201 — the remote-bind opt-in. `parseServeFlags` is pure argv, and
  // this gate reads the environment, so it lives here rather than in the
  // parser: everything the refusal depends on is injected, and the check
  // runs BEFORE the lock is claimed, the registry is opened, or a socket is
  // bound. `--host` already implies auth (M1); this is the second gate,
  // because a bearer token over plain HTTP is a poor answer to a LAN.
  const remoteRefusal = remoteBindRefusal(flags.host, env);
  if (remoteRefusal !== undefined) throw new Error(remoteRefusal);
  // --lan is its own opt-in, so it is resolved after that gate rather than
  // through it — but still before the lock, the registry and the socket, so
  // a machine with no LAN address refuses without having started anything.
  const lan = resolveBindHost(flags, opts);
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const hangarRoot = resolveHangarRoot(env);
  if (flags.noAuth) {
    // Turning sign-in off makes every local process the owner: never while Home answers
    // to anyone else.
    const refusal = noAuthRefusal(hangarRoot);
    if (refusal !== undefined) throw new Error(`hangar serve: ${refusal}`);
  }

  const alreadyRunning = (existing: HangarLock): Error =>
    new Error(
      `hangar is already running at ${existing.url !== "" ? existing.url : "an unknown url"} (pid ${existing.pid}) — use \`crewhaus hangar open\`, or stop that instance first`,
    );

  // Fail fast BEFORE booting anything when a live instance holds the lock. The installed
  // service is the Home a window would show: `crewhaus hangar` opens it.
  const existing = readHangarLock(hangarRoot);
  if (existing !== undefined && existing.pid !== pid && isPidAlive(existing.pid)) {
    if (lockMode(existing) === "resident" && !flags.resident && !flags.smoke) {
      const opened = await hangarOpen([], opts);
      return {
        lines: [`Home is running as a service at ${existing.url}`, ...opened.lines],
        exitCode: opened.exitCode,
      };
    }
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
  // Only the real server runs jobs with this process's own entry; a host that injects its
  // own server (tests) runs another program as `Bun.main`.
  const homeCrewhaus = opts.startServer === undefined ? ownCrewhausArgv(hangarRoot) : undefined;
  const service = serviceDepsOf(opts, hangarRoot);
  const server = (opts.startServer ?? startHangarServer)({
    ...(flags.resident ? { mode: "resident" as const } : {}),
    residentUnit: () => residentState(service).state,
    port: flags.smoke ? 0 : (flags.port ?? DEFAULT_HANGAR_PORT),
    ...(lan !== undefined ? { hostname: lan.address, lanHost: lan.address } : {}),
    ...(flags.host !== undefined ? { hostname: flags.host } : {}),
    root: hangarRoot,
    ...(flags.noAuth ? { noAuth: true } : {}),
    ...(flags.readOnly ? { readOnly: true } : {}),
    ...(flags.readOnlyLocked ? { readOnlyLocked: true } : {}),
    ...(flags.allowHosts.length > 0 ? { allowHosts: flags.allowHosts } : {}),
    assets: hangarAssets,
    env,
    now,
    ...(version !== undefined ? { version } : {}),
    ...(homeCrewhaus !== undefined ? { homeCrewhaus } : {}),
  });

  // Claim the lock with the real bound port. The pre-boot check above makes
  // this a formality, but a boot race still resolves to exactly one winner.
  const acquired = acquireHangarLock(
    hangarRoot,
    {
      pid,
      startedAt: new Date(now()).toISOString(),
      port: server.port,
      url: server.url,
      mode: flags.resident ? "resident" : "foreground",
      ...(version !== undefined ? { version } : {}),
    },
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

  for (const line of summaryLines(server, registry?.list().length, lan, flags.resident)) {
    write(line);
  }
  // The QR goes last so it sits next to the shell prompt, which is the
  // easiest place on the screen to point a phone at. It encodes a single-use
  // invite that works for 10 minutes; `crewhaus hangar qr` makes another.
  if (lan !== undefined && !flags.noQr) {
    write("");
    const invite = await lanInvite(server.url, flags.lanRole, opts);
    if (invite.ok) {
      for (const line of inviteBlockLines(invite.url, {
        color: wantsColor(opts, env),
        columns: terminalColumns(opts),
      })) {
        write(line);
      }
    } else {
      write(`no invite QR code: ${invite.reason} — run \`crewhaus access invite\` instead`);
    }
    write("");
  }
  // The service has no one at a screen: it opens nothing, and `crewhaus hangar` opens it.
  if (!flags.noOpen && !flags.resident) {
    (opts.openBrowser ?? openInBrowser)(
      handoffUrl(server.loopbackUrl ?? server.url, server.bootPath),
    );
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
// the installed service
// ---------------------------------------------------------------------------

/** One y/N question at the terminal. */
async function confirmAtTerminal(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${question} [y/N] `, resolve),
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** The service's seams, each the real one unless a caller injected it. */
function serviceDepsOf(opts: HangarCommandOptions, hangarRoot: string): ServiceDeps {
  const env = opts.env ?? process.env;
  const given = opts.service ?? {};
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  let control: ReturnType<typeof wireControl> | undefined;
  return {
    platform: given.platform ?? process.platform,
    homedir: given.homedir ?? env["HOME"] ?? homedir(),
    uid: given.uid ?? process.getuid?.() ?? 0,
    username:
      given.username ??
      (() => {
        try {
          return userInfo().username;
        } catch {
          return env["USER"] ?? env["USERNAME"] ?? "";
        }
      })(),
    env,
    hangarRoot,
    which: given.which ?? ((name) => Bun.which(name, { PATH: env["PATH"] ?? "" }) ?? undefined),
    ...(given.isExecutable !== undefined ? { isExecutable: given.isExecutable } : {}),
    runner:
      given.runner ??
      ((argv) => {
        const [program, ...rest] = argv;
        const ran = spawnSync(program ?? "", rest, { encoding: "utf8" });
        return { code: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
      }),
    write: given.write ?? write,
    isTty: given.isTty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true),
    confirm: given.confirm ?? confirmAtTerminal,
    receipt:
      given.receipt ??
      (async (kind, effect) => {
        control ??= wireControl(
          {
            hangarRoot,
            identity: opts.identity ?? currentLocalIdentity(),
            ...(opts.now !== undefined ? { now: opts.now } : {}),
            probe: withOwnStartTime(createProcessOps()),
            supervisorFor: () => undefined,
            drainRequest: () => async () => undefined,
          },
          { mode: "direct" },
        );
        const answer = await control.commands.submit(
          { kind, ledger: "workspace", via: "cli" },
          async () =>
            (await effect())
              ? { settle: { state: "succeeded" as const }, value: undefined }
              : {
                  settle: { state: "failed" as const, outcome: outcomeOf("internal") },
                  value: undefined,
                },
        );
        return answer.ok
          ? { ok: true as const, id: answer.receipt.id }
          : { ok: false as const, message: answer.refusal.message };
      }),
  };
}

async function hangarInstall(
  verb: "install" | "uninstall",
  argv: readonly string[],
  opts: HangarCommandOptions,
): Promise<HangarCommandResult> {
  const args = parseVerbArgs(verb, argv, CLI_FAMILY.sub[verb].flags);
  if (args.positional.length > 0) {
    throw new Error(`hangar ${verb}: unexpected argument "${args.positional[0]}"`);
  }
  refuseDotenvRoots(opts);
  const deps = serviceDepsOf(opts, resolveHangarRoot(opts.env ?? process.env));
  const yes = args.flags.get("yes") === true;
  return verb === "install"
    ? await installService(deps, { yes })
    : await uninstallService(deps, { yes });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function hangarStatus(argv: readonly string[], opts: HangarCommandOptions): HangarCommandResult {
  const args = parseVerbArgs("status", argv, CLI_FAMILY.sub.status.flags);
  refuseDotenvRoots(opts);
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
  const unit = residentState(serviceDepsOf(opts, hangarRoot));
  const residentLive = running && lock !== undefined && lockMode(lock) === "resident";
  const resident = residentLive ? "running" : unit.state;
  const lastRecovery = readLastRecovery(hangarRoot);

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
        resident: {
          state: resident,
          unitPath: unit.unitPath ?? null,
          ...(residentLive && lock !== undefined
            ? {
                pid: lock.pid,
                port: lock.port,
                ...(lock.version !== undefined ? { version: lock.version } : {}),
              }
            : {}),
          ...(lastRecovery !== undefined
            ? {
                lastRecovery: {
                  at: lastRecovery.at,
                  restarted: lastRecovery.restarted,
                  skipped: lastRecovery.skipped,
                },
              }
            : {}),
        },
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
    // A non-loopback console is one a phone can reach, so say how.
    const host = hostFromUrl(lock.url);
    if (host !== undefined && !isLoopbackHost(host)) {
      lines.push("  scan it from a phone with `crewhaus hangar qr`");
    }
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
  lines.push(
    tokenPresent
      ? `key: ${tokenPath} (Home's own key; it stays on this computer)`
      : `key: none minted yet (${tokenPath})`,
  );
  if (resident === "running" && lock !== undefined) {
    lines.push(
      `resident: running (pid ${lock.pid}, port ${lock.port}${lock.version !== undefined ? `, version ${lock.version}` : ""})`,
    );
  } else if (resident === "installed") {
    lines.push(`resident: installed, not running (${unit.unitPath ?? "unit file"})`);
  } else {
    lines.push(
      "resident: absent — `crewhaus hangar install` keeps Home running with no window open",
    );
  }
  if (lastRecovery !== undefined) {
    lines.push(
      `last recovery: ${lastRecovery.at} (${lastRecovery.restarted} restarted, ${lastRecovery.skipped} skipped)`,
    );
  }
  return { lines, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

async function hangarOpen(
  argv: readonly string[],
  opts: HangarCommandOptions,
): Promise<HangarCommandResult> {
  const args = parseVerbArgs("open", argv, CLI_FAMILY.sub.open.flags);
  refuseDotenvRoots(opts);
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
  // A browser on this computer opens loopback, whatever else Home is bound to.
  const base = loopbackBase(lock.url, lock.port);
  // Trade Home's own key (which this OS user can read from disk) for a
  // single-use link, so the browser's command line carries nothing secret.
  const answer = await mintBootPath(hangarRoot, lock);
  if (answer.kind === "key-refused") {
    return {
      lines: [
        `Home refused the key in ${join(hangarRoot, TOKEN_FILENAME)}: it is not the one Home recorded. Run \`crewhaus hangar rotate-token\` to make a new one, then \`crewhaus hangar open\` again.`,
      ],
      exitCode: 1,
    };
  }
  if (answer.kind === "unavailable") {
    if (args.flags.get("print") === true) {
      return {
        lines: [
          `Home at ${base} did not give a sign-in link. Is it running from this release? Restart it with \`crewhaus hangar\`.`,
        ],
        exitCode: 1,
      };
    }
    (opts.openBrowser ?? openInBrowser)(base);
    return {
      lines: [`opened ${base} — Home did not give a sign-in link, so sign in there`],
      exitCode: 0,
    };
  }
  const link = handoffUrl(base, answer.bootPath);
  if (args.flags.get("print") === true) {
    // The operator's own terminal: a link that works once, for 2 minutes.
    return {
      lines: [link, "it works once, for 2 minutes: paste it into Home's sign-in screen"],
      exitCode: 0,
    };
  }
  (opts.openBrowser ?? openInBrowser)(link);
  return { lines: ["opened Home in your browser"], exitCode: 0 };
}

// ---------------------------------------------------------------------------
// qr
// ---------------------------------------------------------------------------

/**
 * A fresh invite QR code for the running console.
 *
 * Worth its own verb because the boot-time code scrolls away, works once and
 * lasts 10 minutes: a second person wants in, the terminal gets cleared. Each
 * call mints a new single-use viewer invite. It reads the lock rather than the
 * flags, so it reflects what the console is actually bound to — including the
 * honest answer when that is loopback and no phone can reach it.
 */
async function hangarQr(
  argv: readonly string[],
  opts: HangarCommandOptions,
): Promise<HangarCommandResult> {
  const args = parseVerbArgs("qr", argv, CLI_FAMILY.sub.qr.flags);
  refuseDotenvRoots(opts);
  const env = opts.env ?? process.env;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const hangarRoot = resolveHangarRoot(env);
  const lock = readHangarLock(hangarRoot);
  if (lock === undefined || !isPidAlive(lock.pid) || lock.url === "") {
    return {
      lines: ["hangar is not running — start it with `crewhaus hangar --lan`"],
      exitCode: 1,
    };
  }

  const host = hostFromUrl(lock.url);
  if (host !== undefined && isLoopbackHost(host)) {
    return {
      lines: [
        `hangar is bound to ${lock.url}, which only this machine can reach — a phone on the`,
        "network cannot open it, so there is no QR code worth printing.",
        "Restart it with `crewhaus hangar --lan` to bind this machine's LAN address.",
      ],
      exitCode: 1,
    };
  }

  const invite = await lanInvite(lock.url, "viewer", opts);
  if (!invite.ok) {
    return {
      lines: [`no invite could be made: ${invite.reason}`, "Try `crewhaus access invite`."],
      exitCode: 1,
    };
  }
  return {
    lines: inviteBlockLines(invite.url, {
      color: args.flags.get("no-color") === true ? false : wantsColor(opts, env),
      columns: terminalColumns(opts),
      ...(args.flags.get("ascii") === true ? { ascii: true } : {}),
    }),
    exitCode: 0,
  };
}

/** The host portion of a `http://host:port` url, tolerating the malformed
 *  IPv6 spellings the server can compose. */
function hostFromUrl(url: string): string | undefined {
  const match = /^https?:\/\/(.+):\d+$/.exec(url);
  return match?.[1];
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
  // `hangar [<verb>] --help` answers before any Home directory is read.
  if (argv.includes("--help") || argv.includes("-h")) {
    return { lines: HANGAR_USAGE_LINES, exitCode: 0 };
  }
  // Bare `crewhaus hangar [--flags]` is `hangar serve [--flags]`.
  if (verb === "" || verb.startsWith("--")) return await hangarServe(argv, opts);
  switch (verb) {
    case "serve":
      return await hangarServe(argv.slice(1), opts);
    case "status":
      return hangarStatus(argv.slice(1), opts);
    case "open":
      return await hangarOpen(argv.slice(1), opts);
    case "qr":
      return await hangarQr(argv.slice(1), opts);
    case "install":
      return await hangarInstall("install", argv.slice(1), opts);
    case "uninstall":
      return await hangarInstall("uninstall", argv.slice(1), opts);
    case "rotate-token": {
      const args = parseVerbArgs(
        "rotate-token",
        argv.slice(1),
        CLI_FAMILY.sub["rotate-token"].flags,
      );
      if (args.positional.length > 0) {
        throw new Error(`hangar rotate-token: unexpected argument "${args.positional[0]}"`);
      }
      refuseDotenvRoots(opts);
      return rotateTokenVerb({
        hangarRoot: resolveHangarRoot(opts.env ?? process.env),
        socketOnly: args.flags.get("socket-only") === true,
        tcp: args.flags.get("tcp") === true,
        ...(opts.identity !== undefined ? { identity: opts.identity } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
    }
    default:
      throw new Error(
        `unknown hangar verb "${verb}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
      );
  }
}

/**
 * The argv that runs this `crewhaus` again for a Home job, taking no code or settings from
 * the harness directory it runs in. A Bun-run `crewhaus` is given an empty `--config`
 * (`/dev/null`, or an empty file in Home's directory on Windows).
 */
function ownCrewhausArgv(hangarRoot: string): string[] | undefined {
  let emptyConfig = "/dev/null";
  if (process.platform === "win32") {
    emptyConfig = join(hangarRoot, "bunfig.empty.toml");
    try {
      if (!existsSync(emptyConfig)) writeFileSync(emptyConfig, "");
    } catch {
      return undefined;
    }
  }
  return homeCrewhausArgv({ execPath: process.execPath, main: Bun.main, emptyConfig });
}
