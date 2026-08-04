/**
 * Tests for the `crewhaus hangar` verb family (Hangar M1).
 *
 * Every test runs against a temp hangar/registry/watchme root injected
 * through the module's `env` option, so nothing here can touch the real
 * `~/.crewhaus`. Lock semantics are unit-tested with fake pid-liveness
 * probes; the `status --json` running case boots a real in-process
 * `startHangarServer` on an ephemeral port; the ONE subprocess in this file
 * is the `hangar serve --smoke` end-to-end (the release workflow's smoke
 * entry), spawned with an explicit generous timeout per the CI rule.
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
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type { JobRecord, SupervisedChild } from "@crewhaus/harness-supervisor";
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
  },
): Promise<HangarServerOptions[]> {
  const seen: HangarServerOptions[] = [];
  const baseline = process.listenerCount("SIGTERM");
  const run = runHangarCommand(["serve", "--no-open", ...argv], {
    env: opts.env,
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    pid: 4242,
    isPidAlive: () => false,
    write: opts.write ?? ((): void => {}),
    startServer: (options) => {
      seen.push(options);
      return fakeServer({ handles: new Map(), runningJobs: [] }, []);
    },
    exit: () => {},
  });
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
): Promise<unknown> {
  return runHangarCommand(["serve", "--no-open", ...argv], {
    env,
    pid: 4242,
    isPidAlive: () => false,
    write: () => {},
    startServer: () => {
      throw new Error(SERVER_FACTORY_REACHED);
    },
    exit: () => {},
  });
}

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

  test("HM-188: win32 is told supervision there is UNVERIFIED; nobody else is", async () => {
    const ws = newWorkspace();
    const onWindows: string[] = [];
    await driveServe([], { env: ws.env, platform: "win32", write: (l) => onWindows.push(l) });
    const notice = onWindows.find((l) => l.includes("UNVERIFIED"));
    expect(notice).toBeDefined();
    // The payload is the failure and its cheap check, not a bare
    // "unsupported": a wrong liveness verdict is what starts a second copy.
    expect(notice).toContain("supervision on Windows");
    expect(notice).toContain("second copy");
    expect(notice).toContain("crewhaus daemon status");
    // …and it lands ABOVE the summary box, not as a footnote under it.
    expect(onWindows.indexOf(notice ?? "")).toBeLessThan(
      onWindows.findIndex((l) => l.includes("┌─ Hangar")),
    );

    for (const platform of ["darwin", "linux"]) {
      const elsewhere: string[] = [];
      await driveServe([], { env: ws.env, platform, write: (l) => elsewhere.push(l) });
      expect(elsewhere.join("\n")).not.toContain("UNVERIFIED");
    }
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

  test("--help prints usage with the fragment-token contract", async () => {
    const out = await runHangarCommand(["--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain("URL #fragment (never a query string)");
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

  test("open prints the #fragment url but never hands the token to the opener", async () => {
    const ws = newWorkspace();
    mkdirSync(ws.hangarRoot, { recursive: true });
    writeFileSync(join(ws.hangarRoot, "token"), "tok-abc123\n");
    // Nothing is listening on this port, so the boot-ticket mint fails and
    // the opener falls back to the bare url — the token still must not
    // appear in what another process would see.
    writeHangarLock(ws.hangarRoot, { ...LOCK, pid: process.pid, url: "http://127.0.0.1:4321" });
    const opened: string[] = [];
    const out = await runHangarCommand(["open"], {
      env: ws.env,
      openBrowser: (url) => opened.push(url),
    });
    expect(out.exitCode).toBe(0);
    // Printed to the operator's own terminal: the full fragment url.
    expect(out.lines).toEqual(["http://127.0.0.1:4321/#t=tok-abc123"]);
    expect(out.lines[0]).not.toContain("?"); // fragment, never a query string
    // Handed to another process: never the token.
    expect(opened).toEqual(["http://127.0.0.1:4321"]);
    expect(opened[0]).not.toContain("tok-abc123");
  });

  test("open trades the token for a single-use boot path against a live console", async () => {
    const ws = newWorkspace();
    const server = startHangarServer({
      port: 0,
      root: ws.hangarRoot,
      registryRoot: ws.registryRoot,
      env: ws.env,
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
      const handed = opened[0] as string;
      expect(handed).toMatch(/\/boot\/[0-9a-f]{64}$/);
      expect(handed).not.toContain(server.token as string);
      // It is a real, single-use ticket: it redirects once to the fragment.
      const first = await fetch(handed, { redirect: "manual" });
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toBe(`/#t=${server.token}`);
      expect((await fetch(handed, { redirect: "manual" })).status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// serve --smoke end-to-end (the ONE subprocess in this file)
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
    expect(stdout).toContain("✓ GET /api/harnesses with the bearer token answers 200 JSON");
    expect(stdout).toContain("✓ GET /api/harnesses without a token is refused (401)");
    expect(stdout).toContain("smoke: all checks passed");
    // The boot minted a real token file and the clean exit released the lock.
    expect(readFileSync(join(ws.hangarRoot, "token"), "utf8").trim().length).toBeGreaterThan(0);
    expect(existsSync(join(ws.hangarRoot, HANGAR_LOCK_FILENAME))).toBe(false);
  }, 120_000);
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
function fakeServer(processes: FakeProcesses, log: string[]): HangarServer {
  return {
    url: "http://127.0.0.1:4321",
    port: 4321,
    hostname: "127.0.0.1",
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
