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
import { startHangarServer } from "@crewhaus/hangar-server";
import {
  HANGAR_LOCK_FILENAME,
  type HangarLock,
  acquireHangarLock,
  defaultIsPidAlive,
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

  test("open re-reads the token file and builds the #fragment url", async () => {
    const ws = newWorkspace();
    mkdirSync(ws.hangarRoot, { recursive: true });
    writeFileSync(join(ws.hangarRoot, "token"), "tok-abc123\n");
    writeHangarLock(ws.hangarRoot, { ...LOCK, pid: process.pid, url: "http://127.0.0.1:4321" });
    const opened: string[] = [];
    const out = await runHangarCommand(["open"], {
      env: ws.env,
      openBrowser: (url) => opened.push(url),
    });
    expect(out.exitCode).toBe(0);
    expect(out.lines).toEqual(["http://127.0.0.1:4321/#t=tok-abc123"]);
    expect(opened).toEqual(["http://127.0.0.1:4321/#t=tok-abc123"]);
    // The token travels as a fragment, never a query string.
    expect(out.lines[0]).not.toContain("?");
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
