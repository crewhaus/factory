/**
 * Tests for the `crewhaus hangar` verb family (Hangar M1).
 *
 * Every test runs against a temp hangar/registry/watchme root injected
 * through the module's `env` option, so nothing here can touch the real
 * `~/.crewhaus`. Lock semantics are unit-tested with fake pid-liveness
 * probes; the `status --json` running case boots a real in-process
 * `startHangarServer` on an ephemeral port. The subprocesses are the
 * `hangar serve --smoke` end-to-end (the release workflow's smoke entry) and
 * the dotenv rows, which need Bun's own `.env` loader; each is spawned with an
 * explicit generous timeout per the CI rule.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HangarServer,
  type HangarServerOptions,
  startHangarServer,
} from "@crewhaus/hangar-server";
import {
  openHangarRegistry,
  resolveHangarRoot as registryHangarRoot,
} from "@crewhaus/harness-registry";
import type { JobRecord, SupervisedChild } from "@crewhaus/harness-supervisor";
import { encodeQr, renderQrLines } from "@crewhaus/qr-code";
import {
  HANGAR_LOCK_FILENAME,
  type HangarLock,
  acquireHangarLock,
  defaultIsPidAlive,
  heldSupervisors,
  readHangarLock,
  releaseHangarLock,
  resolveHangarRoot,
  runHangarCommand,
  writeHangarLock,
} from "./hangar-cmd";
import type { InterfaceMap } from "./lan-address";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

type Workspace = {
  readonly root: string;
  readonly hangarRoot: string;
  readonly env: Record<string, string | undefined>;
};

function newWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-hangar-cmd-"));
  TMP_ROOTS.push(root);
  const hangarRoot = join(root, "hangar");
  return {
    root,
    hangarRoot,
    env: {
      CREWHAUS_HANGAR_ROOT: hangarRoot,
      CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
      CREWHAUS_WATCHME_ROOT: join(root, "watchme"),
    },
  };
}

const LOCK: HangarLock = {
  pid: 4242,
  startedAt: "2026-08-03T00:00:00.000Z",
  port: 4200,
  url: "http://127.0.0.1:4200",
};

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

describe("hangar lock helpers", () => {
  test("acquire on an empty root writes the lock (atomic file, JSON roundtrip)", () => {
    const ws = newWorkspace();
    const got = acquireHangarLock(ws.hangarRoot, LOCK, () => true);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.staleNote).toBeUndefined();
    expect(readHangarLock(ws.hangarRoot)).toEqual(LOCK);
    // No tmp file left behind by the tmp+rename write.
    expect(existsSync(join(ws.hangarRoot, `${HANGAR_LOCK_FILENAME}.${LOCK.pid}.tmp`))).toBe(false);
  });

  test("a live foreign pid refuses the acquire and keeps the original lock", () => {
    const ws = newWorkspace();
    writeHangarLock(ws.hangarRoot, LOCK);
    const got = acquireHangarLock(ws.hangarRoot, { ...LOCK, pid: 5555 }, () => true);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.existing).toEqual(LOCK);
    expect(readHangarLock(ws.hangarRoot)?.pid).toBe(4242);
  });

  test("a stale lock (dead pid) is replaced with a note", () => {
    const ws = newWorkspace();
    writeHangarLock(ws.hangarRoot, LOCK);
    const got = acquireHangarLock(ws.hangarRoot, { ...LOCK, pid: 5555 }, () => false);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.staleNote).toContain("stale hangar.lock left by pid 4242");
    expect(readHangarLock(ws.hangarRoot)?.pid).toBe(5555);
  });

  test("re-acquiring under the same pid rewrites without a stale note", () => {
    const ws = newWorkspace();
    writeHangarLock(ws.hangarRoot, LOCK);
    const got = acquireHangarLock(ws.hangarRoot, { ...LOCK, port: 4321 }, () => {
      throw new Error("liveness must not be probed for our own pid");
    });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.staleNote).toBeUndefined();
    expect(readHangarLock(ws.hangarRoot)?.port).toBe(4321);
  });

  test("a corrupt lock file reads as absent and is replaced silently", () => {
    const ws = newWorkspace();
    mkdirSync(ws.hangarRoot, { recursive: true });
    writeFileSync(join(ws.hangarRoot, HANGAR_LOCK_FILENAME), "not json{{{\n");
    expect(readHangarLock(ws.hangarRoot)).toBeUndefined();
    const got = acquireHangarLock(ws.hangarRoot, LOCK, () => true);
    expect(got.ok).toBe(true);
    expect(readHangarLock(ws.hangarRoot)).toEqual(LOCK);
  });

  test("release removes only our own lock, never a foreign pid's", () => {
    const ws = newWorkspace();
    writeHangarLock(ws.hangarRoot, LOCK);
    releaseHangarLock(ws.hangarRoot, 9999); // foreign pid — must be a no-op
    expect(readHangarLock(ws.hangarRoot)).toEqual(LOCK);
    releaseHangarLock(ws.hangarRoot, LOCK.pid);
    expect(readHangarLock(ws.hangarRoot)).toBeUndefined();
    releaseHangarLock(ws.hangarRoot, LOCK.pid); // idempotent on absence
  });

  test("defaultIsPidAlive: our own pid is alive; non-positive pids are not", () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
    expect(defaultIsPidAlive(0)).toBe(false);
    expect(defaultIsPidAlive(-5)).toBe(false);
    expect(defaultIsPidAlive(1.5)).toBe(false);
  });

  test("resolveHangarRoot: explicit env wins, else <registryRoot>/hangar", () => {
    expect(resolveHangarRoot({ CREWHAUS_HANGAR_ROOT: "/tmp/hr" })).toBe("/tmp/hr");
    expect(resolveHangarRoot({ CREWHAUS_REGISTRY_ROOT: "/tmp/reg" })).toBe("/tmp/reg/hangar");
  });

  test("resolveHangarRoot is the registry package's resolver itself, not a copy of it", () => {
    // The fleet tools and the runtime-state floor resolve Hangar's directory with
    // the same function, so a copy reintroduced here, however faithful, fails.
    expect(resolveHangarRoot).toBe(registryHangarRoot);
  });
});

/**
 * Boot `serve` against a server that binds nothing, wait for it to settle,
 * then take it down with SIGTERM. Returns the options the server factory was
 * HANDED.
 *
 * That return value is the point: a boot flag that is parsed and then dropped
 * looks exactly like a flag nobody added, which is how M4's `--read-only` and
 * its remote-bind gate both shipped inert. Asserting on the constant, or on
 * the parser, would have passed either way.
 */
async function driveServe(
  argv: readonly string[],
  opts: {
    readonly env: Record<string, string | undefined>;
    readonly platform?: string;
    readonly write?: (line: string) => void;
    readonly networkInterfaces?: () => InterfaceMap;
    readonly columns?: number;
    readonly color?: boolean;
    readonly openBrowser?: (url: string) => void;
  },
): Promise<HangarServerOptions[]> {
  const seen: HangarServerOptions[] = [];
  const baseline = process.listenerCount("SIGTERM");
  const run = runHangarCommand(
    ["serve", ...(opts.openBrowser !== undefined ? [] : ["--no-open"]), ...argv],
    {
      env: opts.env,
      ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
      pid: 4242,
      isPidAlive: () => false,
      write: opts.write ?? ((): void => {}),
      ...(opts.networkInterfaces !== undefined
        ? { networkInterfaces: opts.networkInterfaces }
        : {}),
      ...(opts.columns !== undefined ? { columns: opts.columns } : {}),
      ...(opts.color !== undefined ? { color: opts.color } : {}),
      ...(opts.openBrowser !== undefined ? { openBrowser: opts.openBrowser } : {}),
      startServer: (options) => {
        seen.push(options);
        return fakeServer({ handles: new Map(), runningJobs: [] }, [], options.hostname);
      },
      exit: () => {},
    },
  );
  await awaitSignalWait(baseline);
  process.emit("SIGTERM");
  await run;
  return seen;
}

/** The sentinel a boot refusal must never reach. */
const SERVER_FACTORY_REACHED = "the server factory was reached — the refusal did not fire";

/**
 * Drive `serve` expecting it to REFUSE before anything boots.
 *
 * The server factory is injected and throws, so a gate that silently stops
 * firing fails this suite fast and loudly instead of binding a real socket
 * (`--host 0.0.0.0` would bind every interface on the machine running the
 * tests) and then blocking until a signal that never comes.
 */
function refuseServe(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  networkInterfaces?: () => InterfaceMap,
): Promise<unknown> {
  return runHangarCommand(["serve", "--no-open", ...argv], {
    env,
    pid: 4242,
    isPidAlive: () => false,
    write: () => {},
    ...(networkInterfaces !== undefined ? { networkInterfaces } : {}),
    startServer: () => {
      throw new Error(SERVER_FACTORY_REACHED);
    },
    exit: () => {},
  });
}

/** A laptop whose only usable address hides behind a VPN and two radios. */
const LAN_INTERFACES: InterfaceMap = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  utun0: [{ address: "fe80::da12:389f:2939:f760", family: "IPv6", internal: false }],
  en0: [{ address: "192.168.7.31", family: "IPv4", internal: false }],
};

/** Nothing but loopback — a machine off every network. */
const NO_LAN_INTERFACES: InterfaceMap = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
};

/** Collect what `serve` streamed to its write sink. */
function sink(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

// ---------------------------------------------------------------------------
// serve --lan + the QR code
// ---------------------------------------------------------------------------

describe("hangar serve --lan", () => {
  test("binds the LAN address the picker chose, not a wildcard", async () => {
    const ws = newWorkspace();
    const seen = await driveServe(["--lan"], {
      env: ws.env,
      networkInterfaces: () => LAN_INTERFACES,
    });
    // A concrete address, because the server interpolates whatever it is
    // handed into its advertised url — `0.0.0.0` would be written into the
    // lock, printed by `status`, and openable by nothing.
    expect(seen[0]?.hostname).toBe("192.168.7.31");
  });

  test("is its own HM-201 opt-in — no environment variable required", async () => {
    const ws = newWorkspace();
    // The same address via --host is refused without the variable...
    await expect(refuseServe(["--host", "192.168.7.31"], ws.env)).rejects.toThrow(
      /binds beyond loopback/,
    );
    // ...while --lan, which IS the deliberate visible act the variable asks
    // for, reaches the server on its own.
    const seen = await driveServe(["--lan"], {
      env: ws.env,
      networkInterfaces: () => LAN_INTERFACES,
    });
    expect(seen[0]?.hostname).toBe("192.168.7.31");
  });

  test("still REQUIRES auth, and refuses to be combined with --host or --smoke", async () => {
    const ws = newWorkspace();
    await expect(
      runHangarCommand(["serve", "--lan", "--no-auth"], { env: ws.env }),
    ).rejects.toThrow(/--lan exposes the console beyond loopback and REQUIRES auth/);
    await expect(
      runHangarCommand(["serve", "--lan", "--host", "0.0.0.0"], { env: ws.env }),
    ).rejects.toThrow(/pass one or the other/);
    await expect(runHangarCommand(["serve", "--lan", "--smoke"], { env: ws.env })).rejects.toThrow(
      /--smoke .*cannot combine with --lan/,
    );
  });

  test("refuses before booting when the machine has no LAN address", async () => {
    const ws = newWorkspace();
    await expect(refuseServe(["--lan"], ws.env, () => NO_LAN_INTERFACES)).rejects.toThrow(
      /found no LAN address/,
    );
    // Refused early: no socket, and no lock left behind.
    await expect(refuseServe(["--lan"], ws.env, () => NO_LAN_INTERFACES)).rejects.not.toThrow(
      new RegExp(SERVER_FACTORY_REACHED),
    );
    expect(existsSync(join(ws.hangarRoot, HANGAR_LOCK_FILENAME))).toBe(false);
  });

  test("prints a QR code that encodes the bare LAN address, and no credential", async () => {
    const ws = newWorkspace();
    const out = sink();
    const opened: string[] = [];
    await driveServe(["--lan"], {
      env: ws.env,
      networkInterfaces: () => LAN_INTERFACES,
      write: out.write,
      color: false,
      columns: 200,
      openBrowser: (url) => opened.push(url),
    });
    const printed = out.lines.join("\n");
    // The bare address the fake server composed: no token, no fragment.
    const url = "http://192.168.7.31:4321";
    expect(printed).toContain("scan to open Home on your phone");
    // …and the code really is that url, not merely some code-shaped output.
    const want = renderQrLines(encodeQr(url, { ecLevel: "M" }), { color: false });
    for (const line of want) expect(out.lines).toContain(line);
    const withToken = renderQrLines(encodeQr(`${url}/#t=fake-token`, { ecLevel: "M" }), {
      color: false,
    });
    expect(withToken.every((line) => out.lines.includes(line))).toBe(false);
    // The summary names the interface and the exposure.
    expect(printed).toContain("on en0 — every device on this network can reach this console");
    // No printed line and no opener argument carries Home's own key.
    expect(printed).not.toContain("fake-token");
    expect(printed).not.toContain("#t=");
    expect(opened.join(" ")).not.toContain("fake-token");
  });

  test("--no-qr boots the LAN console without printing one", async () => {
    const ws = newWorkspace();
    const out = sink();
    await driveServe(["--lan", "--no-qr"], {
      env: ws.env,
      networkInterfaces: () => LAN_INTERFACES,
      write: out.write,
      color: false,
      columns: 200,
    });
    const printed = out.lines.join("\n");
    expect(printed).not.toContain("scan to open Hangar");
    expect(printed).not.toContain("\u2588");
    // The console itself is unaffected.
    expect(printed).toContain("http://192.168.7.31:4321");
  });

  test("says so rather than wrapping when the terminal is too narrow", async () => {
    const ws = newWorkspace();
    const out = sink();
    await driveServe(["--lan"], {
      env: ws.env,
      networkInterfaces: () => LAN_INTERFACES,
      write: out.write,
      color: false,
      columns: 20,
    });
    const printed = out.lines.join("\n");
    // A wrapped QR code is not a degraded QR code, it is a picture.
    expect(printed).toMatch(/needs \d+ columns and this terminal has 20/);
    expect(printed).toContain("crewhaus hangar qr");
    expect(printed).not.toContain("\u2588");
  });

  test("a loopback boot prints no QR, but does name the flag that would", async () => {
    const ws = newWorkspace();
    const out = sink();
    await driveServe([], { env: ws.env, write: out.write, color: false, columns: 200 });
    const printed = out.lines.join("\n");
    expect(printed).not.toContain("\u2588");
    expect(printed).toContain("crewhaus hangar --lan");
  });
});

// ---------------------------------------------------------------------------
// qr
// ---------------------------------------------------------------------------

describe("hangar qr", () => {
  test("reprints the running console's code from the lock: the bare address, no key", () => {
    const ws = newWorkspace();
    mkdirSync(ws.hangarRoot, { recursive: true });
    writeFileSync(join(ws.hangarRoot, "token"), "lan-token\n");
    writeHangarLock(ws.hangarRoot, {
      pid: 4242,
      startedAt: "2026-09-17T00:00:00.000Z",
      port: 4200,
      url: "http://192.168.7.31:4200",
    });
    const got = runHangarCommand(["qr"], {
      env: ws.env,
      isPidAlive: () => true,
      color: false,
      columns: 200,
    });
    return got.then((result) => {
      expect(result.exitCode).toBe(0);
      const want = renderQrLines(encodeQr("http://192.168.7.31:4200", { ecLevel: "M" }), {
        color: false,
      });
      for (const line of want) expect(result.lines).toContain(line);
      expect(result.lines.join("\n")).not.toContain("lan-token");
    });
  });

  test("refuses for a loopback console, and names the flag that fixes it", async () => {
    const ws = newWorkspace();
    writeHangarLock(ws.hangarRoot, LOCK); // url is http://127.0.0.1:4200
    const got = await runHangarCommand(["qr"], { env: ws.env, isPidAlive: () => true });
    expect(got.exitCode).toBe(1);
    expect(got.lines.join(" ")).toContain("only this machine can reach");
    expect(got.lines.join(" ")).toContain("crewhaus hangar --lan");
  });

  test("refuses when nothing is running", async () => {
    const ws = newWorkspace();
    const got = await runHangarCommand(["qr"], { env: ws.env, isPidAlive: () => false });
    expect(got.exitCode).toBe(1);
    expect(got.lines.join(" ")).toContain("hangar is not running");
  });

  test("--ascii avoids the half-block characters", async () => {
    const ws = newWorkspace();
    mkdirSync(ws.hangarRoot, { recursive: true });
    writeFileSync(join(ws.hangarRoot, "token"), "t\n");
    writeHangarLock(ws.hangarRoot, {
      pid: 4242,
      startedAt: "2026-09-17T00:00:00.000Z",
      port: 4200,
      url: "http://10.0.0.9:4200",
    });
    const got = await runHangarCommand(["qr", "--ascii", "--no-color"], {
      env: ws.env,
      isPidAlive: () => true,
      columns: 400,
    });
    expect(got.exitCode).toBe(0);
    const body = got.lines.join("\n");
    expect(body).not.toContain("\u2580");
    expect(body).not.toContain("\u2584");
    expect(body).toContain("\u2588");
  });
});

// ---------------------------------------------------------------------------
// serve — argument validation + live-refusal (no server boots here)
// ---------------------------------------------------------------------------

describe("hangar serve argument validation", () => {
  test("--host with --no-auth is rejected (exposed bind REQUIRES auth)", () => {
    const ws = newWorkspace();
    expect(
      runHangarCommand(["serve", "--host", "0.0.0.0", "--no-auth"], { env: ws.env }),
    ).rejects.toThrow(/--host .*REQUIRES auth.*drop --no-auth/);
  });

  test("HM-201: a non-loopback --host is REFUSED without the opt-in variable", async () => {
    const ws = newWorkspace();
    // The two that look the most harmless are the most exposing: `0.0.0.0`
    // and `::` bind every interface the machine has.
    for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
      await expect(refuseServe(["--host", host], ws.env)).rejects.toThrow(/binds beyond loopback/);
    }
    // The refusal names the variable AND the supported answer — an error
    // that withholds the escape hatch just gets worked around with something
    // worse.
    await expect(refuseServe(["--host", "0.0.0.0"], ws.env)).rejects.toThrow(
      /CREWHAUS_HANGAR_ALLOW_REMOTE=1.*Tailscale, an SSH tunnel/,
    );
    // A typo in the variable fails CLOSED: the check is an allow-list.
    await expect(
      refuseServe(["--host", "0.0.0.0"], { ...ws.env, CREWHAUS_HANGAR_ALLOW_REMOTE: "yes" }),
    ).rejects.toThrow(/binds beyond loopback/);
    // …and the gate runs BEFORE anything is booted: no socket, no lock.
    await expect(refuseServe(["--host", "0.0.0.0"], ws.env)).rejects.not.toThrow(
      new RegExp(SERVER_FACTORY_REACHED),
    );
    expect(existsSync(join(ws.hangarRoot, HANGAR_LOCK_FILENAME))).toBe(false);
  });

  test("HM-201: a loopback --host never needs the opt-in", async () => {
    const ws = newWorkspace();
    for (const host of ["127.0.0.1", "localhost", "::1", "127.0.0.2"]) {
      const seen = await driveServe(["--host", host], { env: ws.env });
      expect(seen[0]?.hostname).toBe(host);
    }
  });

  test("HM-201: with the opt-in set, the remote host reaches the server", async () => {
    const ws = newWorkspace();
    const seen = await driveServe(["--host", "0.0.0.0"], {
      env: { ...ws.env, CREWHAUS_HANGAR_ALLOW_REMOTE: "1" },
    });
    expect(seen[0]?.hostname).toBe("0.0.0.0");
  });

  test("--read-only and --read-only-locked reach the server (the flag the 403 remedy names)", async () => {
    const ws = newWorkspace();
    const plain = await driveServe(["--read-only"], { env: ws.env });
    expect(plain[0]?.readOnly).toBe(true);
    expect(plain[0]?.readOnlyLocked).toBeUndefined();

    // The lock is the strictly stronger posture, so it implies read-only: an
    // operator who types only the lock must not get a WRITABLE console
    // because they omitted the weaker flag.
    const locked = await driveServe(["--read-only-locked"], { env: ws.env });
    expect(locked[0]?.readOnly).toBe(true);
    expect(locked[0]?.readOnlyLocked).toBe(true);

    // …and a plain boot stays writable.
    const open = await driveServe([], { env: ws.env });
    expect(open[0]?.readOnly).toBeUndefined();
    expect(open[0]?.readOnlyLocked).toBeUndefined();
  });

  test("--smoke with --no-auth and --smoke with --port are rejected", () => {
    const ws = newWorkspace();
    expect(runHangarCommand(["serve", "--smoke", "--no-auth"], { env: ws.env })).rejects.toThrow(
      /--smoke .*cannot combine with --no-auth/,
    );
    expect(
      runHangarCommand(["serve", "--smoke", "--port", "4201"], { env: ws.env }),
    ).rejects.toThrow(/--smoke always boots on an ephemeral port/);
  });

  test("bad --port, unknown flag, unknown verb are rejected", () => {
    const ws = newWorkspace();
    expect(runHangarCommand(["serve", "--port", "70000"], { env: ws.env })).rejects.toThrow(
      /--port must be an integer 0\.\.65535/,
    );
    expect(runHangarCommand(["serve", "--nope"], { env: ws.env })).rejects.toThrow(
      /unknown flag "--nope"/,
    );
    expect(runHangarCommand(["bogus"], { env: ws.env })).rejects.toThrow(
      /unknown hangar verb "bogus".*serve \| status \| open/,
    );
  });

  test("a live lock refuses a second serve before anything boots", () => {
    const ws = newWorkspace();
    writeHangarLock(ws.hangarRoot, LOCK);
    expect(
      runHangarCommand(["serve"], { env: ws.env, pid: 5555, isPidAlive: () => true }),
    ).rejects.toThrow(/already running at http:\/\/127\.0\.0\.1:4200 \(pid 4242\).*hangar open/);
  });

  test("--help prints usage: a one-time link signs a browser in; Home's own key stays here", async () => {
    const out = await runHangarCommand(["--help"]);
    expect(out.exitCode).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("signs in through a one-time link");
    expect(text).toContain("crewhaus hangar rotate-token [--socket-only | --tcp]");
    expect(text).toContain("--allow-host <name>");
    expect(text).not.toContain("#fragment");
  });

  test("--allow-host reaches the server, repeatable", async () => {
    const ws = newWorkspace();
    const seen = await driveServe(["--allow-host", "home.lan", "--allow-host", "nas.local"], {
      env: ws.env,
    });
    expect(seen[0]?.allowHosts).toEqual(["home.lan", "nas.local"]);
    const none = await driveServe([], { env: ws.env });
    expect(none[0]?.allowHosts).toBeUndefined();
    await expect(
      runHangarCommand(["serve", "--allow-host", "bad name"], { env: ws.env }),
    ).rejects.toThrow(/--allow-host takes a host name/);
  });
});

// ---------------------------------------------------------------------------
// status / open (running case boots an in-process ephemeral server)
// ---------------------------------------------------------------------------

describe("hangar status / open", () => {
  test("status --json reports not-running on a fresh root", async () => {
    const ws = newWorkspace();
    const out = await runHangarCommand(["status", "--json"], { env: ws.env });
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.lines.join("\n")) as Record<string, unknown>;
    expect(body["running"]).toBe(false);
    expect(body["staleLock"]).toBe(false);
    expect(body["hangarRoot"]).toBe(ws.hangarRoot);
    expect(body["lockPath"]).toBe(join(ws.hangarRoot, HANGAR_LOCK_FILENAME));
    expect(String(body["registryPath"])).toEndWith("harnesses.json");
    expect(body["harnessCount"]).toBe(0);
    expect(body["tokenPresent"]).toBe(false);
  });

  test("status reports a stale lock without deleting it", async () => {
    const ws = newWorkspace();
    writeHangarLock(ws.hangarRoot, LOCK);
    const out = await runHangarCommand(["status"], { env: ws.env, isPidAlive: () => false });
    expect(out.exitCode).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("hangar: not running");
    expect(text).toContain("stale hangar.lock");
    expect(text).toContain("pid 4242 is dead");
    expect(readHangarLock(ws.hangarRoot)).toEqual(LOCK); // status never mutates
  });

  test("status --json reports a running server booted through startHangarServer", async () => {
    const ws = newWorkspace();
    const server = startHangarServer({
      port: 0,
      root: ws.hangarRoot,
      registryRoot: ws.env["CREWHAUS_REGISTRY_ROOT"] as string,
      env: { CREWHAUS_WATCHME_ROOT: ws.env["CREWHAUS_WATCHME_ROOT"] },
      onWarn: () => {},
    });
    try {
      writeHangarLock(ws.hangarRoot, {
        pid: process.pid,
        startedAt: "2026-08-03T00:00:00.000Z",
        port: server.port,
        url: server.url,
      });
      const out = await runHangarCommand(["status", "--json"], { env: ws.env });
      const body = JSON.parse(out.lines.join("\n")) as Record<string, unknown>;
      expect(body["running"]).toBe(true);
      expect(body["pid"]).toBe(process.pid);
      expect(body["port"]).toBe(server.port);
      expect(body["url"]).toBe(server.url);
      expect(body["tokenPresent"]).toBe(true); // the boot minted <hangarRoot>/token
    } finally {
      await server.stop();
    }
  });

  test("open on a stopped console exits 1 with the boot hint", async () => {
    const ws = newWorkspace();
    const opened: string[] = [];
    const out = await runHangarCommand(["open"], {
      env: ws.env,
      openBrowser: (url) => opened.push(url),
    });
    expect(out.exitCode).toBe(1);
    expect(out.lines[0]).toContain("not running");
    expect(out.lines[0]).toContain("crewhaus hangar");
    expect(opened).toEqual([]);
  });

  test("open with no answer from the console opens the bare address, never the key", async () => {
    const ws = newWorkspace();
    mkdirSync(ws.hangarRoot, { recursive: true });
    writeFileSync(join(ws.hangarRoot, "token"), "tok-abc123\n");
    // Nothing is listening on this port, so no link can be minted.
    writeHangarLock(ws.hangarRoot, { ...LOCK, pid: process.pid, url: "http://127.0.0.1:4321" });
    const opened: string[] = [];
    const out = await runHangarCommand(["open"], {
      env: ws.env,
      openBrowser: (url) => opened.push(url),
    });
    expect(out.exitCode).toBe(0);
    expect(opened).toEqual(["http://127.0.0.1:4321"]);
    expect(out.lines.join(" ")).not.toContain("tok-abc123");
    expect(out.lines.join(" ")).toContain("sign in there");
  });

  test("open signs a browser in through a single-use link minted over home.sock", async () => {
    const ws = newWorkspace();
    const server = startHangarServer({
      port: 0,
      root: ws.hangarRoot,
      registryRoot: ws.env["CREWHAUS_REGISTRY_ROOT"] as string,
      env: ws.env,
      onWarn: () => {},
    });
    try {
      writeHangarLock(ws.hangarRoot, {
        ...LOCK,
        pid: process.pid,
        port: server.port,
        url: server.url,
      });
      const opened: string[] = [];
      const out = await runHangarCommand(["open"], {
        env: ws.env,
        openBrowser: (url) => opened.push(url),
      });
      expect(out.exitCode).toBe(0);
      expect(out.lines).toEqual(["opened Home in your browser"]);
      const handed = opened[0] as string;
      expect(handed).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/boot\/[0-9a-f]{64}$/);
      expect(handed).not.toContain(server.token as string);
      // It is a real, single-use link: it redirects once to a one-time code.
      const first = await fetch(handed, { redirect: "manual" });
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toMatch(/^\/#x=[A-Za-z0-9_-]{43}$/);
      expect((await fetch(handed, { redirect: "manual" })).status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("open --print prints a one-time /boot/ link instead of opening it", async () => {
    const ws = newWorkspace();
    const server = startHangarServer({
      port: 0,
      root: ws.hangarRoot,
      registryRoot: ws.env["CREWHAUS_REGISTRY_ROOT"] as string,
      env: ws.env,
      onWarn: () => {},
    });
    try {
      writeHangarLock(ws.hangarRoot, {
        ...LOCK,
        pid: process.pid,
        port: server.port,
        url: server.url,
      });
      const opened: string[] = [];
      const out = await runHangarCommand(["open", "--print"], {
        env: ws.env,
        openBrowser: (url) => opened.push(url),
      });
      expect(out.exitCode).toBe(0);
      expect(opened).toEqual([]);
      expect(out.lines[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/boot\/[0-9a-f]{64}$/);
      expect(out.lines.join("\n")).not.toContain(server.token as string);
    } finally {
      await server.stop();
    }
  });

  test("open names rotate-token when Home refuses the key in the file", async () => {
    const ws = newWorkspace();
    const server = startHangarServer({
      port: 0,
      root: ws.hangarRoot,
      registryRoot: ws.env["CREWHAUS_REGISTRY_ROOT"] as string,
      env: ws.env,
      onWarn: () => {},
    });
    try {
      writeHangarLock(ws.hangarRoot, {
        ...LOCK,
        pid: process.pid,
        port: server.port,
        url: server.url,
      });
      // Recorded by a rotation, then the file replaced behind Home's back.
      const rotated = await runHangarCommand(["rotate-token"], {
        env: ws.env,
        identity: { username: "tester", hostname: "test-host" },
      });
      expect(rotated.exitCode).toBe(0);
      writeFileSync(join(ws.hangarRoot, "token"), `${"cd".repeat(32)}\n`, { mode: 0o600 });
      for (const argv of [["open"], ["open", "--print"]]) {
        const opened: string[] = [];
        const out = await runHangarCommand(argv, {
          env: ws.env,
          openBrowser: (url) => opened.push(url),
        });
        expect(out.exitCode).toBe(1);
        expect(opened).toEqual([]);
        expect(out.lines.join("\n")).toContain("is not the one Home recorded");
        expect(out.lines.join("\n")).toContain("crewhaus hangar rotate-token");
        expect(out.lines.join("\n")).not.toContain("cd".repeat(32));
      }
    } finally {
      await server.stop();
    }
  });

  test("rotate-token against a running Home: the old key is refused at once, the new one works", async () => {
    const ws = newWorkspace();
    const server = startHangarServer({
      port: 0,
      root: ws.hangarRoot,
      registryRoot: ws.env["CREWHAUS_REGISTRY_ROOT"] as string,
      env: ws.env,
      onWarn: () => {},
    });
    try {
      const old = server.token as string;
      const ask = (token: string) =>
        fetch(`${server.url}/api/version`, { headers: { authorization: `Bearer ${token}` } });
      expect((await ask(old)).status).toBe(200);
      const out = await runHangarCommand(["rotate-token"], {
        env: ws.env,
        identity: { username: "tester", hostname: "test-host" },
      });
      expect(out.exitCode).toBe(0);
      const fresh = readFileSync(join(ws.hangarRoot, "token"), "utf8").trim();
      expect(fresh).not.toBe(old);
      // The key is never printed.
      expect(out.lines.join("\n")).not.toContain(fresh);
      expect(out.lines.join("\n")).toContain("the old one no longer works");
      expect((await ask(old)).status).toBe(401);
      expect((await ask(fresh)).status).toBe(200);
      await expect(
        runHangarCommand(["rotate-token", "--socket-only", "--tcp"], { env: ws.env }),
      ).rejects.toThrow(/not both/);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Home's directories come from the shell, not a .env file
// ---------------------------------------------------------------------------

describe("Home's directories and dotenv files", () => {
  const files = (map: Record<string, string>) => (path: string) => {
    const name = path.split(/[\\/]/).pop() as string;
    return map[name];
  };

  test.each([
    ["CREWHAUS_HANGAR_ROOT", ".env"],
    ["CREWHAUS_REGISTRY_ROOT", ".env"],
    ["CREWHAUS_HANGAR_ROOT", ".env.development.local"],
    ["CREWHAUS_REGISTRY_ROOT", ".env.test.local"],
  ])("%s with the value ./%s holds is refused, naming both", async (name, file) => {
    const ws = newWorkspace();
    const value = ws.env[name] as string;
    for (const verb of [["serve"], ["status"], ["open"], ["qr"], ["rotate-token"]]) {
      await expect(
        runHangarCommand(verb, {
          env: ws.env,
          cwd: ws.root,
          readFile: files({ [file]: `# local\n${name}=${value}\n` }),
          isPidAlive: () => false,
          startServer: () => {
            throw new Error(SERVER_FACTORY_REACHED);
          },
        }),
      ).rejects.toThrow(
        `crewhaus hangar: ${name} is set in ./${file}. Home's directory decides who can sign in, so it is read only from your shell: remove it from ./${file} and run \`export ${name}=<path>\` instead.`,
      );
    }
  });

  test("a line in the file is refused even when a different value is exported", async () => {
    // Bun never overrides an export, so such a line is dead or the one that chose the
    // directory; it cannot tell which, and neither can Home.
    const ws = newWorkspace();
    await expect(
      runHangarCommand(["status"], {
        env: ws.env,
        cwd: ws.root,
        readFile: files({ ".env": "CREWHAUS_HANGAR_ROOT=/somewhere/else\n" }),
      }),
    ).rejects.toThrow(/CREWHAUS_HANGAR_ROOT is set in \.\/\.env\./);
  });

  test("files without either variable, and no files, are accepted", async () => {
    const ws = newWorkspace();
    const other = await runHangarCommand(["status"], {
      env: ws.env,
      cwd: ws.root,
      readFile: files({
        ".env": "# CREWHAUS_HANGAR_ROOT=/commented\nCREWHAUS_HANGAR_ROOTS=/other\nPORT=1\n",
      }),
    });
    expect(other.exitCode).toBe(0);
    const none = await runHangarCommand(["status"], {
      env: ws.env,
      cwd: ws.root,
      readFile: () => undefined,
    });
    expect(none.exitCode).toBe(0);
  });

  // Each spelling goes through Bun's own loader in a child started in a directory that
  // holds only that `.env`, with neither variable in its environment: the child proves the
  // line reached `process.env` and that the refusal still names it.
  test.each([
    ["CREWHAUS_HANGAR_ROOT", "CREWHAUS_HANGAR_ROOT=/tmp/plain\n"],
    ["CREWHAUS_HANGAR_ROOT", "CREWHAUS_HANGAR_ROOT=$HOME/planted-root\n"],
    ["CREWHAUS_HANGAR_ROOT", "CREWHAUS_HANGAR_ROOT=${HOME}/planted-root\n"],
    ["CREWHAUS_HANGAR_ROOT", "CREWHAUS_HANGAR_ROOT='$HOME/planted-root'\n"],
    ["CREWHAUS_REGISTRY_ROOT", "R=/tmp/r\nCREWHAUS_REGISTRY_ROOT=$R\n"],
    ["CREWHAUS_HANGAR_ROOT", 'CREWHAUS_HANGAR_ROOT="/tmp/e" # note\n'],
    ["CREWHAUS_HANGAR_ROOT", "CREWHAUS_HANGAR_ROOT='/tmp/sq'  # comment\n"],
    ["CREWHAUS_HANGAR_ROOT", "CREWHAUS_HANGAR_ROOT=`/tmp/bt`\n"],
    ["CREWHAUS_HANGAR_ROOT", "  export CREWHAUS_HANGAR_ROOT = /tmp/spaced\r\n"],
  ])(
    "%s from Bun's own loading of %j is refused",
    async (name, text) => {
      const dir = mkdtempSync(join(tmpdir(), "hangar-dotenv-"));
      writeFileSync(join(dir, ".env"), text);
      const script = [
        `import { dotenvRootRefusal } from ${JSON.stringify(join(import.meta.dir, "hangar-env.ts"))};`,
        "const refusal = dotenvRootRefusal({ cwd: process.cwd() });",
        `console.log(JSON.stringify({ value: process.env[${JSON.stringify(name)}] ?? null, refusal: refusal ?? null }));`,
      ].join("\n");
      const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: dir };
      const proc = Bun.spawn([process.execPath, "-e", script], {
        cwd: dir,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      rmSync(dir, { recursive: true, force: true });
      if (exitCode !== 0) throw new Error(`child exited ${exitCode}: ${stderr}`);
      const got = JSON.parse(stdout.trim()) as { value: string | null; refusal: string | null };
      // Bun loaded the line, so the variable is set in the child.
      expect(got.value).not.toBeNull();
      expect(got.refusal).toContain(`${name} is set in ./.env.`);
    },
    // A child process per row; CI runners start one far slower than a laptop.
    20_000,
  );

  test("reads the real files in the working directory", async () => {
    const ws = newWorkspace();
    writeFileSync(join(ws.root, ".env.local"), `CREWHAUS_HANGAR_ROOT=${ws.hangarRoot}\n`);
    await expect(runHangarCommand(["status"], { env: ws.env, cwd: ws.root })).rejects.toThrow(
      /CREWHAUS_HANGAR_ROOT is set in \.\/\.env\.local/,
    );
  });
});

// ---------------------------------------------------------------------------
// serve --smoke end-to-end (a subprocess)
// ---------------------------------------------------------------------------

describe("hangar serve --smoke", () => {
  test("boots ephemerally, passes every self-check, releases the lock, exits 0", async () => {
    const ws = newWorkspace();
    const proc = Bun.spawn([process.execPath, CLI_PATH, "hangar", "serve", "--smoke"], {
      cwd: ws.root,
      env: {
        PATH: process.env["PATH"] ?? "",
        CREWHAUS_HANGAR_ROOT: ws.env["CREWHAUS_HANGAR_ROOT"] as string,
        CREWHAUS_REGISTRY_ROOT: ws.env["CREWHAUS_REGISTRY_ROOT"] as string,
        CREWHAUS_WATCHME_ROOT: ws.env["CREWHAUS_WATCHME_ROOT"] as string,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`smoke exited ${exitCode}\nstderr:\n${stderr}\nstdout:\n${stdout}`);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("smoke: booted http://127.0.0.1:");
    expect(stdout).toContain("✓ GET /healthz answers ok");
    expect(stdout).toContain("✓ GET / serves the embedded UI shell");
    expect(stdout).toContain("✓ every embedded console file serves with its content type");
    expect(stdout).toContain("✓ GET /api/harnesses with Home's own key answers 200 JSON");
    expect(stdout).toContain("✓ GET /api/harnesses without a credential is refused (401)");
    expect(stdout).toContain("✓ a request with a foreign Host is refused (421)");
    expect(stdout).toContain("smoke: all checks passed");
    // The boot minted a real token file and the clean exit released the lock.
    expect(readFileSync(join(ws.hangarRoot, "token"), "utf8").trim().length).toBeGreaterThan(0);
    expect(existsSync(join(ws.hangarRoot, HANGAR_LOCK_FILENAME))).toBe(false);
  }, 120_000);
});

describe("hangar serve --smoke, in process", () => {
  test("fails on the Host check when the allowlist lets a foreign name through", async () => {
    const ws = newWorkspace();
    const out = sink();
    const got = await runHangarCommand(["serve", "--smoke"], {
      env: ws.env,
      cwd: ws.root,
      write: out.write,
      isPidAlive: () => false,
      // An allowlist that answers the name the smoke sends is no allowlist.
      startServer: (options) =>
        startHangarServer({ ...options, allowHosts: ["rebind.example.test"], onWarn: () => {} }),
    });
    expect(got.exitCode).toBe(1);
    expect(out.lines.join("\n")).toContain("✗ a request with a foreign Host is refused (421)");
  });

  test("checks that a socket-only key is refused over TCP and taken on the socket", async () => {
    const ws = newWorkspace();
    const rotated = await runHangarCommand(["rotate-token", "--socket-only"], {
      env: ws.env,
      identity: { username: "tester", hostname: "test-host" },
    });
    expect(rotated.exitCode).toBe(0);
    const out = sink();
    const got = await runHangarCommand(["serve", "--smoke"], {
      env: ws.env,
      cwd: ws.root,
      write: out.write,
      isPidAlive: () => false,
      startServer: (options) => startHangarServer({ ...options, onWarn: () => {} }),
    });
    expect(out.lines.join("\n")).toContain(
      "✓ Home's own key is refused over TCP and accepted on its socket",
    );
    expect(got.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// serve shutdown — the exit path, driven with a FAKE supervised child
// ---------------------------------------------------------------------------

/** A fake supervision handle: one live child and a recorded stop. */
function fakeHandle(child: SupervisedChild | undefined, log: string[]) {
  return {
    supervisor: {
      liveChild: () => child,
      stop: async () => {
        log.push(`stop ${child?.harnessDir}`);
        return { stopped: true, forced: true };
      },
      close: () => {
        log.push(`close ${child?.harnessDir}`);
      },
    },
  };
}

type FakeProcesses = {
  readonly handles: ReadonlyMap<string, ReturnType<typeof fakeHandle>>;
  readonly runningJobs: readonly JobRecord[];
  /** Dirs the run looked up by key. The shutdown enumeration must leave this
   *  EMPTY: its source is the process layer's own handle map, not a walk of
   *  `registry.list()` (which a mid-session remove/relocate silently
   *  shrinks). */
  readonly peeked?: string[];
};

/** A `HangarServer` that binds nothing: enough surface for `serve` to boot,
 *  print its summary and shut down, with a fake process layer. */
function fakeServer(processes: FakeProcesses, log: string[], hostname = "127.0.0.1"): HangarServer {
  return {
    // Composed exactly as the real server composes it (server.ts), so a test
    // that asserts on a printed url is asserting on the real shape.
    url: `http://${hostname}:4321`,
    port: 4321,
    hostname,
    hangarRoot: "/nonexistent/hangar",
    registryPath: "/nonexistent/harnesses.json",
    token: "fake-token",
    tokenPath: "/nonexistent/token",
    bootPath: "/boot/fake-nonce",
    noAuth: false,
    idleTimeoutSeconds: 120,
    processes: {
      held: () => [...processes.handles.values()],
      peek: (dir: string) => {
        processes.peeked?.push(dir);
        return processes.handles.get(dir);
      },
      // Enumerating for shutdown must never BUILD a supervisor: building one
      // adopts, and a manager on its way down must not adopt a daemon.
      get: () => {
        throw new Error("shutdown must not build a supervisor");
      },
      jobs: {
        running: () => processes.runningJobs,
        terminateRunning: async () => {
          log.push("terminateRunning");
          return processes.runningJobs;
        },
      },
    } as unknown as HangarServer["processes"],
    ready: Promise.resolve({ adopted: 0, lost: 0, jobs: 0 }),
    stop: async () => {
      log.push("server.stop");
    },
  } as unknown as HangarServer;
}

/** A live child description, as `HarnessSupervisor.liveChild()` returns. */
function liveChild(over: Partial<SupervisedChild> & { harnessDir: string }): SupervisedChild {
  return {
    target: "channel",
    state: "running",
    kind: "daemon",
    runId: "run_0123456789abcdef",
    pid: 4_242,
    adopted: false,
    detached: true,
    reAdoptable: true,
    ...over,
  };
}

function runningJob(jobId: string, kind: string, harnessDir: string): JobRecord {
  return {
    jobId,
    harnessDir,
    kind,
    argv: [kind],
    mutating: true,
    state: "running",
    enqueuedAt: "2026-08-04T00:00:00.000Z",
  };
}

/** Resolve once `serve` has installed its signal handlers. */
async function awaitSignalWait(baseline: number): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (process.listenerCount("SIGTERM") > baseline) return;
    await Bun.sleep(2);
  }
  throw new Error("serve never installed its SIGTERM handler");
}

describe("heldSupervisors", () => {
  test("de-duplicates the handle map's supervisors and touches none of them", () => {
    const log: string[] = [];
    const one = fakeHandle(liveChild({ harnessDir: "/h/one" }), log);
    const two = fakeHandle(liveChild({ harnessDir: "/h/two" }), log);
    // A supervisor listed twice must not be shut down twice…
    expect(heldSupervisors([one, two, one])).toEqual([one.supervisor, two.supervisor]);
    expect(heldSupervisors([])).toEqual([]);
    // …and enumerating is pure: nothing is stopped, closed, or built by
    // counting what is held. Building a handle ADOPTS, which a manager on
    // its way down must never do.
    expect(log).toEqual([]);
  });
});

describe("hangar serve shutdown", () => {
  test("SIGTERM stops the orphanable child, leaves the daemon, releases the lock, and EXITS", async () => {
    const ws = newWorkspace();
    const daemonDir = join(ws.root, "chat");
    const cliDir = join(ws.root, "helper");
    mkdirSync(daemonDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    // Register both so the shutdown enumeration has dirs to peek at.
    const registry = openHangarRegistry({ env: ws.env });
    registry.upsert({ dir: daemonDir, target: "channel" });
    registry.upsert({ dir: cliDir, target: "cli" });

    const lines: string[] = [];
    const log: string[] = [];
    const exits: number[] = [];
    const baseline = process.listenerCount("SIGTERM");
    const baselineSigint = process.listenerCount("SIGINT");
    const handles = new Map([
      [daemonDir, fakeHandle(liveChild({ harnessDir: daemonDir }), log)],
      [
        cliDir,
        fakeHandle(
          liveChild({
            harnessDir: cliDir,
            target: "cli",
            kind: "interactive",
            detached: false,
            reAdoptable: false,
          }),
          log,
        ),
      ],
    ]);

    const run = runHangarCommand(["serve", "--no-open"], {
      env: ws.env,
      pid: 4242,
      isPidAlive: () => false,
      write: (line) => lines.push(line),
      startServer: () =>
        fakeServer({ handles, runningJobs: [runningJob("job_dev", "dev", cliDir)] }, log),
      exit: (code) => exits.push(code),
    });
    await awaitSignalWait(baseline);
    expect(existsSync(join(ws.hangarRoot, HANGAR_LOCK_FILENAME))).toBe(true);

    process.emit("SIGTERM");
    const out = await run;

    expect(out.exitCode).toBe(0);
    // The attached run was STOPPED and the running job SIGNALLED, and both
    // happened BEFORE the socket and the lock were given up: freeing the
    // port while children are still held is how a second manager bound it
    // while the first lived on.
    expect(log).toEqual([
      `stop ${cliDir}`,
      "terminateRunning",
      `close ${daemonDir}`,
      `close ${cliDir}`,
      "server.stop",
    ]);
    // The lock is gone AND the process was told to exit — releasing the lock
    // without exiting is exactly the orphaned-manager failure (F-6).
    expect(existsSync(join(ws.hangarRoot, HANGAR_LOCK_FILENAME))).toBe(false);
    expect(exits).toEqual([0]);
    const text = lines.join("\n");
    expect(text).toContain("hangar: shutting down…");
    expect(text).toContain("stopped 1 supervised run(s)");
    expect(text).toContain(`cli ${cliDir}`);
    // …and the operator is told what survived and what happens to it next.
    expect(text).toContain("left 1 daemon(s) running");
    expect(text).toContain(`crewhaus daemon stop '${daemonDir}'`);
    expect(text).toContain("signalled 1 running job(s) (dev)");
    expect(text).toContain("`interrupted`");
    // Both signal handlers are gone: nothing of this run is left installed.
    expect(process.listenerCount("SIGTERM")).toBe(baseline);
    expect(process.listenerCount("SIGINT")).toBe(baselineSigint);
  });

  test("a manager holding nothing shuts down silently and still exits", async () => {
    const ws = newWorkspace();
    const lines: string[] = [];
    const log: string[] = [];
    const exits: number[] = [];
    const baseline = process.listenerCount("SIGTERM");

    const run = runHangarCommand(["serve", "--no-open"], {
      env: ws.env,
      pid: 4242,
      isPidAlive: () => false,
      write: (line) => lines.push(line),
      startServer: () => fakeServer({ handles: new Map(), runningJobs: [] }, log),
      exit: (code) => exits.push(code),
    });
    await awaitSignalWait(baseline);
    process.emit("SIGTERM");
    await run;

    expect(log).toEqual(["terminateRunning", "server.stop"]);
    expect(exits).toEqual([0]);
    expect(lines.join("\n")).not.toContain("daemon(s) running");
  });

  test("a harness REMOVED from the registry mid-session is still stopped and still named", async () => {
    const ws = newWorkspace();
    // A `workflow` harness: the one-shot class is spawned DETACHED and writes
    // no runfile, so it lives in its own process group (immune to the
    // terminal's SIGINT) and no later manager can enumerate, adopt, stop or
    // even name it. Missing it at shutdown is silent and permanent — this is
    // the orphan class the M4 shutdown exists to close.
    const jobDir = join(ws.root, "nightly");
    mkdirSync(jobDir, { recursive: true });
    const registry = openHangarRegistry({ env: ws.env });
    const entry = registry.upsert({ dir: jobDir, target: "workflow" });

    const lines: string[] = [];
    const log: string[] = [];
    const peeked: string[] = [];
    const exits: number[] = [];
    const baseline = process.listenerCount("SIGTERM");
    const handles = new Map([
      [
        jobDir,
        fakeHandle(
          liveChild({
            harnessDir: jobDir,
            target: "workflow",
            kind: "job",
            detached: true,
            reAdoptable: false,
          }),
          log,
        ),
      ],
    ]);

    const run = runHangarCommand(["serve", "--no-open"], {
      env: ws.env,
      pid: 4242,
      isPidAlive: () => false,
      write: (line) => lines.push(line),
      startServer: () => fakeServer({ handles, runningJobs: [], peeked }, log),
      exit: (code) => exits.push(code),
    });
    await awaitSignalWait(baseline);
    // The registry row goes away while the child is live — `DELETE
    // /api/h/:id`, the Library's Remove on a missing card, or `crewhaus
    // harness remove` in another terminal. None of them has a live-run
    // guard, and none of them touches the handle map.
    registry.remove(entry.id);
    expect(registry.list()).toHaveLength(0);
    process.emit("SIGTERM");
    await run;

    // The child is still ours, so it is still stopped — before the socket
    // and the lock are given up — and still reported.
    expect(log).toEqual([`stop ${jobDir}`, "terminateRunning", `close ${jobDir}`, "server.stop"]);
    expect(lines.join("\n")).toContain("stopped 1 supervised run(s)");
    expect(lines.join("\n")).toContain(`workflow ${jobDir}`);
    expect(exits).toEqual([0]);
    // And the registry was never the enumeration source: nothing was looked
    // up by key at all.
    expect(peeked).toEqual([]);
  });
});

describe("lock contention (exclusive create)", () => {
  test("a second live claimant loses the race rather than co-owning the root", () => {
    const ws = newWorkspace();
    // The winner's lock is already on disk with a LIVE pid.
    writeHangarLock(ws.hangarRoot, { ...LOCK, pid: 4242 });
    const loser = acquireHangarLock(ws.hangarRoot, { ...LOCK, pid: 7777 }, () => true);
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.existing.pid).toBe(4242);
    // The winner's lock is untouched.
    expect(readHangarLock(ws.hangarRoot)?.pid).toBe(4242);
  });

  test("a stale lock is replaced under contention, and the replacement is exclusive", () => {
    const ws = newWorkspace();
    writeHangarLock(ws.hangarRoot, { ...LOCK, pid: 4242 });
    const first = acquireHangarLock(ws.hangarRoot, { ...LOCK, pid: 7777 }, (p) => p !== 4242);
    expect(first.ok).toBe(true);
    expect(readHangarLock(ws.hangarRoot)?.pid).toBe(7777);
    // Now 7777 holds it and is alive: a third console must be refused.
    const third = acquireHangarLock(ws.hangarRoot, { ...LOCK, pid: 8888 }, () => true);
    expect(third.ok).toBe(false);
  });
});
