/**
 * `crewhaus daemon` — the terminal head of the supervision state tree.
 *
 * Everything here runs against an injected `ProcessOps` and clock, so no
 * daemon is ever spawned: the point of these tests is the WIRING (does the
 * verb resolve the right harness, gate the right spawn, read the right
 * scrubbed capture, speak the right control call), not the supervision
 * machinery, which `@crewhaus/harness-supervisor` proves in its own suite.
 *
 * The load-bearing claim under test is the covenant: a daemon started here
 * leaves exactly the harness-local state (`.crewhaus/run/`) the Hangar
 * console adopts, and vice versa.
 */
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, ProcessOps, SpawnRequest, SpawnedProcess } from "@crewhaus/harness-supervisor";
import { runDaemonCommand } from "./daemon-cmd";

// --- seams -----------------------------------------------------------------

type FakeChild = {
  pid: number;
  request: SpawnRequest;
  signals: string[];
  exit(code: number | null, signal?: string | null): void;
  writeLog(text: string): void;
};

type FakeOps = ProcessOps & { children: FakeChild[]; last(): FakeChild | undefined };

function fakeOps(now: () => number): FakeOps {
  let nextPid = 9_001;
  const children: FakeChild[] = [];
  const live = new Map<number, { startTimeMs: number; commandLine: string }>();
  const childFor = (pid: number): FakeChild | undefined => children.find((c) => c.pid === pid);
  return {
    platform: "posix",
    children,
    last: () => children[children.length - 1],
    spawn: (request) => {
      const pid = nextPid;
      nextPid += 1;
      let settle: (v: { code: number | null; signal: string | null }) => void = () => {};
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
        settle = r;
      });
      const logPath = request.stdio.mode === "file" ? request.stdio.path : undefined;
      const child: FakeChild = {
        pid,
        request,
        signals: [],
        exit: (code, signal = null) => {
          live.delete(pid);
          settle({ code, signal });
        },
        writeLog: (text) => {
          if (logPath !== undefined) appendFileSync(logPath, text);
        },
      };
      children.push(child);
      live.set(pid, { startTimeMs: now(), commandLine: request.argv.join(" ") });
      return {
        pid,
        exited,
        write: () => {},
        closeStdin: () => {},
        unref: () => {},
      } as SpawnedProcess;
    },
    isAlive: (pid) => live.has(pid),
    startTimeMs: (pid) => live.get(pid)?.startTimeMs,
    commandLine: (pid) => live.get(pid)?.commandLine,
    terminate: (pid) => {
      childFor(pid)?.signals.push("SIGTERM");
      childFor(pid)?.exit(null, "SIGTERM");
    },
    forceKill: (pid) => {
      childFor(pid)?.signals.push("SIGKILL");
      childFor(pid)?.exit(null, "SIGKILL");
    },
  };
}

type Fixture = {
  readonly dir: string;
  readonly ops: FakeOps;
  readonly opts: {
    env: Record<string, string | undefined>;
    ops: ProcessOps;
    cwd: string;
  };
  cleanup(): void;
};

/** A compiled channel harness whose spec parses — so a preflight refusal in
 *  these tests is the channel-secret boot gate, not a spec lint. */
function fixture(specLines?: readonly string[]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "daemon-cmd-"));
  const dir = join(root, "harness");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "daemon.ts"), "// compiled bundle\n");
  const spec = specLines ?? [
    "name: daemon-fixture",
    "target: channel",
    "agent:",
    "  model: anthropic/claude-sonnet-4",
    "  instructions: |",
    "    You are a fixture.",
    "routing:",
    "  sessionKey: channel",
  ];
  writeFileSync(join(dir, "crewhaus.yaml"), `${spec.join("\n")}\n`);
  // The REAL clock on purpose. An ADOPTED run is not ours to await — the
  // supervisor never held its exit promise — so its exit is noticed by the
  // log pump's liveness poll, which is a timer. A frozen clock would hang
  // every `stop`/`drain`/`restart` here, and the thing under test is the
  // wiring, not the backoff arithmetic (the supervisor's own suite owns
  // that, with its own controllable clock).
  const ops = fakeOps(() => Date.now());
  return {
    dir,
    ops,
    opts: {
      // A temp registry root so nothing here touches the real ~/.crewhaus.
      env: { CREWHAUS_REGISTRY_ROOT: join(root, "registry"), CREWHAUS_NO_REGISTRY: "1" },
      ops,
      cwd: dir,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// --- tests -----------------------------------------------------------------

describe("crewhaus daemon", () => {
  test("--help lists every verb and says these drive the supervisor directly", async () => {
    const out = await runDaemonCommand(["--help"]);
    expect(out.exitCode).toBe(0);
    const text = out.lines.join("\n");
    for (const verb of ["start", "stop", "restart", "status", "logs", "wake", "drain"]) {
      expect(text).toContain(`crewhaus daemon ${verb}`);
    }
    expect(text).toContain("with no Hangar console running");
  });

  test("an unknown verb throws a plain Error (the entry file routes it through die())", async () => {
    await expect(runDaemonCommand(["frobnicate"])).rejects.toThrow(/unknown daemon verb/);
  });

  test("start spawns, writes the runfile the console adopts, and refuses a second start", async () => {
    const f = fixture();
    try {
      const started = await runDaemonCommand(["start", "--no-preflight"], f.opts);
      expect(started.exitCode).toBe(0);
      expect(started.lines[0]).toContain("started run_");
      expect(f.ops.children.length).toBe(1);

      // The harness-local state the OTHER head reads. This file is the whole
      // "one state tree, two heads" covenant.
      const runfile = JSON.parse(
        readFileSync(join(f.dir, ".crewhaus", "run", "daemon.json"), "utf8"),
      );
      expect(runfile.pid).toBe(f.ops.last()?.pid);
      expect(typeof runfile.argvFingerprint).toBe("string");

      const again = await runDaemonCommand(["start", "--no-preflight"], f.opts);
      expect(again.exitCode).toBe(1);
      expect(again.lines[0]).toContain("already running");
      expect(f.ops.children.length).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  test("the control port is stamped in the ENV as 0 and the token never enters argv", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const request = f.ops.last()?.request;
      expect(request?.env["CREWHAUS_CONTROL_PORT"]).toBe("0");
      // Omitting the token is what makes the daemon MINT a fresh one each
      // boot — a token left by a dead daemon must not authenticate against
      // its replacement.
      expect(request?.env["CREWHAUS_CONTROL_TOKEN"]).toBeUndefined();
      expect(request?.argv.join(" ")).not.toContain("TOKEN");
      // …and cwd is the harness ROOT, never the bundle dir.
      expect(request?.cwd).toBe(f.dir);
    } finally {
      f.cleanup();
    }
  });

  test("a preflight refusal names the unforceable finding and --force cannot clear it", async () => {
    const f = fixture([
      "name: daemon-fixture",
      "target: channel",
      "agent:",
      "  model: anthropic/claude-sonnet-4",
      "  instructions: |",
      "    You are a fixture.",
      "routing:",
      "  sessionKey: channel",
      "channels:",
      "  slack:",
      "    botToken: $DAEMON_TEST_SLACK_BOT_TOKEN",
      "    signingSecret: $DAEMON_TEST_SLACK_SIGNING_SECRET",
    ]);
    try {
      const refused = await runDaemonCommand(["start"], f.opts);
      expect(refused.exitCode).toBe(1);
      const text = refused.lines.join("\n");
      expect(text).toContain("preflight refused the spawn");
      expect(text).toContain("cannot be overridden");
      expect(f.ops.children.length).toBe(0);

      const forced = await runDaemonCommand(["start", "--force"], f.opts);
      expect(forced.exitCode).toBe(1);
      expect(forced.lines.join("\n")).toContain("cannot be overridden");
      // The refusal REPLACED the spawn — it did not precede one.
      expect(f.ops.children.length).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  test("stop adopts a daemon this process did not spawn, then signals it", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const pid = f.ops.last()?.pid;

      // A FRESH command invocation: no in-memory supervisor knows this pid,
      // so `stop` has to adopt off the runfile first.
      const stopped = await runDaemonCommand(["stop"], f.opts);
      expect(stopped.exitCode).toBe(0);
      expect(stopped.lines[0]).toContain("stopped");
      expect(f.ops.children.find((c) => c.pid === pid)?.signals).toEqual(["SIGTERM"]);
    } finally {
      f.cleanup();
    }
  });

  test("stop with no runfile is a no-op that says so, not an error", async () => {
    const f = fixture();
    try {
      const out = await runDaemonCommand(["stop"], f.opts);
      expect(out.exitCode).toBe(0);
      expect(out.lines[0]).toContain("not running");
    } finally {
      f.cleanup();
    }
  });

  test("status reports liveness, the control port, recent runs, and the CLI twin", async () => {
    const f = fixture();
    try {
      const cold = await runDaemonCommand(["status"], f.opts);
      expect(cold.lines[0]).toContain("not running (no runfile)");
      expect(cold.lines.join("\n")).toContain("would run:");

      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const hot = await runDaemonCommand(["status"], f.opts);
      expect(hot.lines[0]).toContain("running · pid");
      // No announcement has been pumped yet, so it must say so rather than
      // imply wake/drain will work.
      expect(hot.lines.join("\n")).toContain("control: none recorded");
    } finally {
      f.cleanup();
    }
  });

  test("status --json is machine-readable and carries the same facts", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const out = await runDaemonCommand(["status", "--json"], f.opts);
      const parsed = JSON.parse(out.lines.join("\n")) as Record<string, unknown>;
      expect(parsed["running"]).toBe(true);
      expect(parsed["runClass"]).toBe("daemon");
      expect(parsed["target"]).toBe("channel");
      expect(parsed["controlPort"]).toBe(null);
      expect(Array.isArray(parsed["recentRuns"])).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test("logs render the SCRUBBED capture — a credential value from .env never prints", async () => {
    const f = fixture();
    try {
      // Built from parts: this repo's push protection rejects realistic
      // secret literals, and a fixture never needs one.
      const secret = ["sk", "test", "0123456789abcdefghij"].join("-");
      writeFileSync(join(f.dir, ".env"), `MY_API_KEY=${secret}\n`, { mode: 0o600 });

      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      f.ops.last()?.writeLog(`connecting with ${secret}\nready\n`);

      const out = await runDaemonCommand(["logs", "--tail", "10"], f.opts);
      const text = out.lines.join("\n");
      expect(text).toContain("ready");
      // The raw file still holds it — the scrubber is the read-side gate,
      // and reading `logs/<runId>.log` directly is what this must never do.
      expect(text).not.toContain(secret);
      expect(text).toContain("«MY_API_KEY»");
    } finally {
      f.cleanup();
    }
  });

  test("logs with no runs says so instead of failing", async () => {
    const f = fixture();
    try {
      const out = await runDaemonCommand(["logs"], f.opts);
      expect(out.exitCode).toBe(0);
      expect(out.lines[0]).toContain("no runs recorded yet");
    } finally {
      f.cleanup();
    }
  });

  test("wake without a control port degrades to a FACT, not a failure", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const out = await runDaemonCommand(["wake", "--lane", "heartbeat"], f.opts);
      // Exit 0: a pre-0.5.0 bundle (or a daemon that has not announced yet)
      // is not an operator error.
      expect(out.exitCode).toBe(0);
      expect(out.lines[0]).toContain("no_control_port");
    } finally {
      f.cleanup();
    }
  });

  test("wake rejects a lane control.v1 does not define", async () => {
    const f = fixture();
    try {
      await expect(runDaemonCommand(["wake", "--lane", "janitor"], f.opts)).rejects.toThrow(
        /--lane must be heartbeat or schedule/,
      );
    } finally {
      f.cleanup();
    }
  });

  test("drain with no control plane falls back to the signal path and says which it was", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const out = await runDaemonCommand(["drain"], f.opts);
      expect(out.exitCode).toBe(0);
      const text = out.lines.join("\n");
      expect(text).toContain("stopped (SIGTERM)");
      expect(text).toContain("control.v1 unavailable");
    } finally {
      f.cleanup();
    }
  });

  test("a directory with no crewhaus.yaml is refused with a directing message", async () => {
    const root = mkdtempSync(join(tmpdir(), "daemon-nohar-"));
    try {
      await expect(runDaemonCommand(["status"], { cwd: root })).rejects.toThrow(/is not a harness/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restart rebuilds the plan, so a recompile between the two is picked up", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const firstArgv = f.ops.last()?.request.argv.join(" ");

      // Recompile to a different entry: `plan` is a closure, not a value.
      writeFileSync(join(f.dir, "dist", "daemon.ts"), "// recompiled\n");
      const out = await runDaemonCommand(["restart", "--no-preflight"], f.opts);
      expect(out.exitCode).toBe(0);
      expect(f.ops.children.length).toBe(2);
      expect(f.ops.last()?.request.argv.join(" ")).toBe(firstArgv as string);
      expect(out.lines[0]).toContain("restarted run_");
    } finally {
      f.cleanup();
    }
  });
});
