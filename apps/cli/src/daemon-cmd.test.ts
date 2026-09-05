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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type { Clock, ProcessOps, SpawnRequest, SpawnedProcess } from "@crewhaus/harness-supervisor";
import { hashSpecSource } from "@crewhaus/harness-supervisor";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import { registryPinFreshness, runDaemonCommand } from "./daemon-cmd";

// --- seams -----------------------------------------------------------------

type FakeChild = {
  pid: number;
  request: SpawnRequest;
  signals: string[];
  /** Monotonic order this child was FIRST signalled, so a test can assert
   *  the order a walk stopped a fleet in rather than the order it spawned it. */
  signalSeq?: number;
  exit(code: number | null, signal?: string | null): void;
  writeLog(text: string): void;
};

type FakeOps = ProcessOps & { children: FakeChild[]; last(): FakeChild | undefined };

function fakeOps(now: () => number): FakeOps {
  let nextPid = 9_001;
  let signalSeq = 0;
  const children: FakeChild[] = [];
  const live = new Map<number, { startTimeMs: number; commandLine: string }>();
  const childFor = (pid: number): FakeChild | undefined => children.find((c) => c.pid === pid);
  return {
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
      const child = childFor(pid);
      if (child !== undefined && child.signalSeq === undefined) child.signalSeq = ++signalSeq;
      child?.signals.push("SIGTERM");
      child?.exit(null, "SIGTERM");
    },
    forceKill: (pid) => {
      const child = childFor(pid);
      if (child !== undefined && child.signalSeq === undefined) child.signalSeq = ++signalSeq;
      child?.signals.push("SIGKILL");
      child?.exit(null, "SIGKILL");
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
    /** Pinned so the HM-188 win32 notice cannot prepend a line to the output
     *  these tests assert on when the suite runs on Windows. The notice has
     *  its own test, which injects `win32`. */
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

/** A compiled crew harness — the shape whose INPUT is a document. */
function crewFixture(): Fixture {
  return fixture([
    "name: crew-fixture",
    "target: crew",
    "agent:",
    "  model: anthropic/claude-sonnet-4",
    "  instructions: |",
    "    You are a fixture.",
  ]);
}

type GroupFixture = {
  readonly ops: FakeOps;
  readonly opts: { env: Record<string, string | undefined>; ops: ProcessOps; cwd: string };
  dirOf(name: string): string;
  /** Member names in the order their daemons were SPAWNED. */
  spawnedNames(): string[];
  /** Member names in the order they were SIGNALLED. */
  signalledNames(): string[];
  cleanup(): void;
};

/**
 * A three-member fleet with a declared boot order, registered in a temp
 * registry: secretary first (everyone mounts its door), archivist second
 * (owns the shared space), chief last (it supervises the rest).
 *
 * Deliberately REGISTERED in the opposite order, so a walk that happens to
 * follow registry insertion order fails the test.
 */
function groupFixture(options: { withCli?: boolean } = {}): GroupFixture {
  const root = mkdtempSync(join(tmpdir(), "daemon-group-"));
  const registryRoot = join(root, "registry");
  const ops = fakeOps(() => Date.now());
  const dirs = new Map<string, string>();

  const member = (name: string, target: string, order: number | undefined): void => {
    const dir = join(root, name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", target === "cli" ? "agent.ts" : "daemon.ts"), "// bundle\n");
    writeFileSync(
      join(dir, "crewhaus.yaml"),
      [
        `name: ${name}`,
        `target: ${target}`,
        "agent:",
        "  model: anthropic/claude-sonnet-4",
        "  instructions: |",
        "    A fixture.",
      ].join("\n"),
    );
    dirs.set(name, dir);
    const reg = openHangarRegistry({ root: registryRoot, env: {} });
    reg.upsert({ dir, specName: name, target, origin: "manual", originDetail: "test" });
    reg.addGroup({ name: "crew" });
    reg.setGroups(dir, ["crew"]);
    if (order !== undefined) reg.setGroupOrder(dir, "crew", order);
  };
  member("chief", "channel", 3);
  member("archivist", "channel", 2);
  member("secretary", "channel", 1);
  if (options.withCli === true) member("scratch", "cli", 4);

  const nameOf = (path: string): string =>
    [...dirs.entries()].find(([, dir]) => path.startsWith(dir))?.[0] ?? path;

  return {
    ops,
    opts: { env: { CREWHAUS_REGISTRY_ROOT: registryRoot }, ops, cwd: root },
    dirOf: (name) => dirs.get(name) as string,
    spawnedNames: () => ops.children.map((c) => nameOf(c.request.cwd)),
    signalledNames: () =>
      ops.children
        .filter((c) => c.signalSeq !== undefined)
        .sort((a, b) => (a.signalSeq as number) - (b.signalSeq as number))
        .map((c) => nameOf(c.request.cwd)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * What a control-serving daemon writes at bind: the announcement on stdout
 * (the ONLY place a kernel-assigned port exists) plus the 0600 token file it
 * mints at the same moment. Written directly rather than compiled, because
 * the thing under test is the CLI's wiring, not the daemon emitter.
 */
function announceControl(f: Fixture, port: number): void {
  f.ops
    .last()
    ?.writeLog(
      `[control] crewhaus.control.v1 listening on http://127.0.0.1:${port} (token: .crewhaus/run/control-token)\n`,
    );
  // Built from parts: this repo's push protection rejects realistic secret
  // literals, and a fixture never needs one.
  const token = ["ctl", "fixture", "token"].join("-");
  writeFileSync(join(f.dir, ".crewhaus", "run", "control-token"), `${token}\n`, { mode: 0o600 });
}

/** A `fetch` that records the URLs it was asked for and answers `body`. */
function spyFetch(seen: string[], body: unknown, onCall?: () => void): typeof fetch {
  return (async (input: string | URL | Request) => {
    seen.push(String(input));
    onCall?.();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
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

  test("HM-188: every other platform is told nothing", async () => {
    const f = fixture();
    try {
      for (const platform of ["darwin", "linux"]) {
        const started = await runDaemonCommand(["restart", "--no-preflight"], {
          ...f.opts,
          platform,
        });
        expect(started.lines.join("\n")).not.toContain("UNVERIFIED");
      }
    } finally {
      f.cleanup();
    }
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

  test("status names the SHARED env files a fleet member reads, and where they resolved", async () => {
    const f = fixture();
    try {
      // The fleet layout the declaration exists for: one `.env` beside the
      // harness dir, declared rather than symlinked.
      const fleetRoot = join(f.dir, "..");
      writeFileSync(join(fleetRoot, ".env"), "SHARED_KEY=x\n");
      mkdirSync(join(f.dir, ".crewhaus"), { recursive: true });
      writeFileSync(
        join(f.dir, ".crewhaus", "settings.json"),
        JSON.stringify({ manager: { envFiles: ["../.env"] } }),
      );
      writeFileSync(join(f.dir, ".env"), "LOCAL_KEY=y\n");

      const out = await runDaemonCommand(["status"], f.opts);
      const text = out.lines.join("\n");
      expect(text).toContain("env files (lowest precedence first");
      expect(text).toContain("../.env →");
      expect(text).toContain("[shared]");
      expect(text).toContain("  .env");
      // A file list, never a value — status is piped and screen-shared.
      expect(text).not.toContain("SHARED_KEY");

      const json = JSON.parse(
        (await runDaemonCommand(["status", "--json"], f.opts)).lines.join("\n"),
      ) as { envFiles: Array<{ declaredAs: string; scope: string; present: boolean }> };
      expect(json.envFiles.map((r) => [r.declaredAs, r.scope, r.present])).toEqual([
        ["../.env", "shared", true],
        [".env", "harness", true],
      ]);
    } finally {
      f.cleanup();
    }
  });

  test("--group starts every member in boot order, and stop reverses it", async () => {
    const g = groupFixture();
    try {
      const started = await runDaemonCommand(
        ["start", "--group", "crew", "--no-preflight"],
        g.opts,
      );
      expect(started.exitCode).toBe(0);
      // secretary (1) → archivist (2) → chief (3): the dependency order the
      // group declares, not registry insertion order (which is reversed).
      expect(g.spawnedNames()).toEqual(["secretary", "archivist", "chief"]);
      expect(started.lines.join("\n")).toContain("start 3 member(s): 3 ok, 0 failed");

      const stopped = await runDaemonCommand(["stop", "--group", "crew"], g.opts);
      expect(stopped.exitCode).toBe(0);
      expect(g.signalledNames()).toEqual(["chief", "archivist", "secretary"]);
    } finally {
      g.cleanup();
    }
  });

  test("a member that refuses does not strand the ones behind it, and the walk exits 1", async () => {
    const g = groupFixture();
    try {
      // The middle member is already running, so its start refuses.
      await runDaemonCommand(["start", "--no-preflight"], {
        ...g.opts,
        cwd: g.dirOf("archivist"),
      });
      const out = await runDaemonCommand(["start", "--group", "crew", "--no-preflight"], g.opts);
      expect(out.exitCode).toBe(1);
      const text = out.lines.join("\n");
      expect(text).toContain("already running");
      expect(text).toContain("start 3 member(s): 2 ok, 1 failed");
      expect(text).toContain("failed: archivist");
      // The member AFTER the refusal still started.
      expect(g.spawnedNames()).toContain("chief");
    } finally {
      g.cleanup();
    }
  });

  test("shapes with no daemon are skipped WITH A NOTE, never silently dropped", async () => {
    const g = groupFixture({ withCli: true });
    try {
      const out = await runDaemonCommand(["start", "--group", "crew", "--no-preflight"], g.opts);
      const text = out.lines.join("\n");
      expect(text).toContain("skipped — cli is the interactive class");
      expect(text).toContain("1 skipped");
      // A skip is not a failure.
      expect(out.exitCode).toBe(0);
      expect(g.spawnedNames()).not.toContain("scratch");
    } finally {
      g.cleanup();
    }
  });

  test("--group refuses alongside a harness argument, and names unknown groups", async () => {
    const g = groupFixture();
    try {
      await expect(
        runDaemonCommand(["start", "--group", "crew", g.dirOf("chief")], g.opts),
      ).rejects.toThrow(/mutually exclusive/);
      await expect(runDaemonCommand(["start", "--group", "nope"], g.opts)).rejects.toThrow(
        /has no members.*known groups: crew/s,
      );
    } finally {
      g.cleanup();
    }
  });

  test("flags ride along to each member, even one whose value equals the group name", async () => {
    const g = groupFixture();
    try {
      // `--ack crew` would be eaten by a naive argv string-filter.
      const out = await runDaemonCommand(
        ["start", "--group", "crew", "--no-preflight", "--ack", "crew"],
        g.opts,
      );
      expect(out.exitCode).toBe(0);
      expect(g.spawnedNames()).toHaveLength(3);
    } finally {
      g.cleanup();
    }
  });

  test("submit runs a crew with a brief on stdin, tracked as a job", async () => {
    const f = crewFixture();
    try {
      const brief = join(f.dir, "..", "brief.md");
      writeFileSync(brief, "# ship the newsletter\n");
      const out = await runDaemonCommand(
        ["submit", "--brief-file", brief, "--no-preflight"],
        f.opts,
      );
      expect(out.exitCode).toBe(0);
      const text = out.lines.join("\n");
      expect(text).toContain("submitted run_");
      expect(text).toContain("one run, never restarted");

      const child = f.ops.last();
      // The brief reaches the child as a FILE the kernel feeds, never argv.
      expect(child?.request.stdinFile).toBe(brief);
      expect(child?.request.argv.join(" ")).not.toContain(brief);
      // A job, not a daemon: no runfile, so nothing claims the daemon slot.
      expect(existsSync(join(f.dir, ".crewhaus", "run", "daemon.json"))).toBe(false);
      const ledger = readFileSync(join(f.dir, ".crewhaus", "run", "runs.jsonl"), "utf8");
      expect(JSON.parse(ledger.split("\n")[0] as string).kind).toBe("job");
    } finally {
      f.cleanup();
    }
  });

  test("submit without --brief-file, or with a missing/empty one, refuses up front", async () => {
    const f = crewFixture();
    try {
      await expect(runDaemonCommand(["submit"], f.opts)).rejects.toThrow(/--brief-file/);
      await expect(runDaemonCommand(["submit", "--brief-file", "nope.md"], f.opts)).rejects.toThrow(
        /no brief at/,
      );
      const empty = join(f.dir, "empty.md");
      writeFileSync(empty, "");
      await expect(runDaemonCommand(["submit", "--brief-file", empty], f.opts)).rejects.toThrow(
        /is empty/,
      );
      expect(f.ops.children).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });

  test("submit on a shape whose input is NOT a brief points at the verb that is", async () => {
    const f = fixture(); // channel
    try {
      const brief = join(f.dir, "brief.md");
      writeFileSync(brief, "hello\n");
      await expect(runDaemonCommand(["submit", "--brief-file", brief], f.opts)).rejects.toThrow(
        /is a channel harness.*crewhaus daemon start/s,
      );
    } finally {
      f.cleanup();
    }
  });

  test("`daemon start` on a crew harness refuses with the remedy, and spawns NOTHING", async () => {
    // Before this it spawned a bundle guaranteed to exit 2 ("no input on
    // stdin"), which is not a terminal code — so the supervisor read a crash
    // and walked the backoff ladder into crash-looping.
    const f = crewFixture();
    try {
      const out = await runDaemonCommand(["start", "--no-preflight"], f.opts);
      expect(out.exitCode).toBe(1);
      expect(out.lines.join("\n")).toContain("crewhaus daemon submit");
      expect(f.ops.children).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });

  test("a preSpawn hook that fails REFUSES the start, quoting its own output", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.dir, ".crewhaus"), { recursive: true });
      writeFileSync(
        join(f.dir, ".crewhaus", "settings.json"),
        JSON.stringify({ manager: { hooks: { preSpawn: "./prep.sh" } } }),
      );
      // The fake ops answer every spawn with exit 0 by default, so make the
      // hook the thing that fails: a command that cannot be launched.
      const out = await runDaemonCommand(["start", "--no-preflight"], {
        ...f.opts,
        ops: {
          ...f.ops,
          spawn: (request) => {
            if (request.argv[0] === join(f.dir, "prep.sh")) throw new Error("ENOENT");
            return f.ops.spawn(request);
          },
        },
      });
      expect(out.exitCode).toBe(1);
      const text = out.lines.join("\n");
      expect(text).toContain("preSpawn refused the start");
      expect(text).toContain("ENOENT");
      // Refused means refused: no daemon, no runfile.
      expect(existsSync(join(f.dir, ".crewhaus", "run", "daemon.json"))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test("--compile and --no-compile are mutually exclusive", async () => {
    const f = fixture();
    try {
      await expect(
        runDaemonCommand(["start", "--compile", "--no-compile"], f.opts),
      ).rejects.toThrow(/mutually exclusive/);
    } finally {
      f.cleanup();
    }
  });

  test("--compile on a bundle that is NOT stale compiles nothing", async () => {
    const f = fixture();
    try {
      // A spec-hash stamp matching the spec ⇒ EXACTLY fresh. `--compile` is
      // safe to leave on in a wrapper script precisely because of this.
      writeFileSync(
        join(f.dir, "dist", "package.json"),
        JSON.stringify({
          name: "crewhaus-compiled-bundle",
          crewhaus: {
            specHash: hashSpecSource(readFileSync(join(f.dir, "crewhaus.yaml"), "utf8")),
            compiledWith: "0.5.2",
          },
        }),
      );
      const out = await runDaemonCommand(["start", "--compile", "--no-preflight"], f.opts);
      expect(out.exitCode).toBe(0);
      // One spawn: the daemon. A compile would have been a second.
      expect(f.ops.children).toHaveLength(1);
      expect(f.ops.children[0]?.request.argv[0]).toBe("bun");
    } finally {
      f.cleanup();
    }
  });

  test("--no-compile beats manager.autoCompile on a stale bundle", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.dir, ".crewhaus"), { recursive: true });
      writeFileSync(
        join(f.dir, ".crewhaus", "settings.json"),
        JSON.stringify({ manager: { autoCompile: true } }),
      );
      // The fixture writes the bundle BEFORE the spec, so the mtime
      // heuristic reads approximate-stale — exactly the case autoCompile
      // fires on, and exactly the case --no-compile must suppress.
      const out = await runDaemonCommand(["start", "--no-compile", "--no-preflight"], f.opts);
      expect(out.exitCode).toBe(0);
      expect(f.ops.children).toHaveLength(1);
      expect(f.ops.children[0]?.request.argv[0]).toBe("bun");
    } finally {
      f.cleanup();
    }
  });

  test("status names the prep contract: autoCompile, the hooks, and when each last ran", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.dir, ".crewhaus"), { recursive: true });
      writeFileSync(
        join(f.dir, ".crewhaus", "settings.json"),
        JSON.stringify({
          manager: { autoCompile: true, hooks: { postCompile: "./patch.ts" } },
        }),
      );
      const text = (await runDaemonCommand(["status"], f.opts)).lines.join("\n");
      expect(text).toContain("prep (.crewhaus/settings.json → manager):");
      expect(text).toContain("autoCompile: on");
      expect(text).toContain("postCompile: `./patch.ts` · never run");
    } finally {
      f.cleanup();
    }
  });

  test("a harness with no prep configured grows no prep section", async () => {
    const f = fixture();
    try {
      expect((await runDaemonCommand(["status"], f.opts)).lines.join("\n")).not.toContain("prep (");
    } finally {
      f.cleanup();
    }
  });

  test("status reports a declared shared env file that is NOT there", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.dir, ".crewhaus"), { recursive: true });
      writeFileSync(
        join(f.dir, ".crewhaus", "settings.json"),
        JSON.stringify({ manager: { envFiles: ["../fleet.env"] } }),
      );
      const text = (await runDaemonCommand(["status"], f.opts)).lines.join("\n");
      expect(text).toContain("MISSING — nothing is read from it");
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

  test("--tail N renders N lines, not the 8-line crash window", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const child = f.ops.last();
      for (let i = 1; i <= 30; i++) child?.writeLog(`line-${i}\n`);

      const out = await runDaemonCommand(["logs", "--tail", "20"], f.opts);
      // The header, then exactly the 20 lines that were asked for. The byte
      // budget bounds the READ; it must not silently clip the result to the
      // forensics tail.
      expect(out.lines.slice(1)).toHaveLength(20);
      expect(out.lines.at(1)).toBe("line-11");
      expect(out.lines.at(-1)).toBe("line-30");
    } finally {
      f.cleanup();
    }
  });

  test("--follow keeps emitting past the tail window instead of going silent", async () => {
    const f = fixture();
    const timers: ReturnType<typeof setTimeout>[] = [];
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const child = f.ops.last();
      for (let i = 1; i <= 12; i++) child?.writeLog(`line-${i}\n`);

      // More lines arrive AFTER the opening window, which is exactly the
      // case an index into a sliding N-line window cannot see: `emitted`
      // saturates at N and every later poll slices an empty list.
      timers.push(
        setTimeout(() => {
          for (let i = 13; i <= 20; i++) child?.writeLog(`line-${i}\n`);
        }, 20),
      );
      // The follow loop ends when the daemon does — the only clean exit a
      // blocking verb has in a test.
      timers.push(setTimeout(() => child?.exit(0), 150));

      const seen: string[] = [];
      await runDaemonCommand(["logs", "--follow", "--tail", "5"], {
        ...f.opts,
        followPollMs: 5,
        write: (line) => seen.push(line),
      });
      const expected: string[] = [];
      for (let i = 8; i <= 20; i++) expected.push(`line-${i}`);
      expect(seen.filter((l) => l.startsWith("line-"))).toEqual(expected);
    } finally {
      for (const t of timers) clearTimeout(t);
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
      // Exit 0: a bundle with no control plane is not an operator error.
      expect(out.exitCode).toBe(0);
      expect(out.lines[0]).toContain("no_control_port");
      // …and it names WHICH cause it is. This fixture's bundle carries no
      // provenance stamp, so "recompile" is the true remedy; telling an
      // operator that about a current bundle would send them nowhere.
      expect(out.lines[0]).toContain("predates crewhaus.control.v1");
    } finally {
      f.cleanup();
    }
  });

  test("a current bundle that has not announced yet is told to wait, not to recompile", async () => {
    const f = fixture();
    try {
      // The provenance stamp `compile` writes. A bundle from this release
      // DOES bind a control port, so the honest answer is "not yet" —
      // "recompile" would send an operator down a road that changes nothing.
      writeFileSync(
        join(f.dir, "dist", "package.json"),
        JSON.stringify({
          name: "crewhaus-compiled-bundle",
          crewhaus: { specHash: "sha256:deadbeef", compiledWith: "0.5.0" },
        }),
      );
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const out = await runDaemonCommand(["wake", "--lane", "heartbeat"], f.opts);
      expect(out.exitCode).toBe(0);
      expect(out.lines[0]).toContain("no control port recorded yet");
      expect(out.lines[0]).not.toContain("recompile");
    } finally {
      f.cleanup();
    }
  });

  test("wake pumps the daemon's own announcement out of the log and dials it", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      // What a control-serving daemon prints at bind. It is the ONLY place
      // the kernel-assigned port exists, and `daemon start` exits long
      // before it lands — so a head that never pumps the log can never
      // reach control.v1 for a daemon it started itself.
      announceControl(f, 41_234);

      const seen: string[] = [];
      const out = await runDaemonCommand(["wake", "--lane", "heartbeat"], {
        ...f.opts,
        fetch: spyFetch(seen, { ok: true, sessionId: "sess_abc" }),
      });
      expect(out.exitCode).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(":41234/");
      expect(out.lines[0]).toContain("heartbeat tick accepted");

      // The port is now in the harness-local state tree, so the OTHER head
      // (and the next invocation) finds it with no pump at all.
      const runfile = JSON.parse(
        readFileSync(join(f.dir, ".crewhaus", "run", "daemon.json"), "utf8"),
      );
      expect(runfile.controlPort).toBe(41_234);
    } finally {
      f.cleanup();
    }
  });

  test("status reports the announced port once the log has been pumped", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      announceControl(f, 41_235);
      const out = await runDaemonCommand(["status"], f.opts);
      expect(out.lines.join("\n")).toContain("crewhaus.control.v1 on 127.0.0.1:41235");
    } finally {
      f.cleanup();
    }
  });

  test("drain reaches control.v1 rather than degrading to SIGTERM", async () => {
    const f = fixture();
    try {
      await runDaemonCommand(["start", "--no-preflight"], f.opts);
      const child = f.ops.last();
      announceControl(f, 41_236);

      const seen: string[] = [];
      const out = await runDaemonCommand(["drain"], {
        ...f.opts,
        // A drained daemon finishes its in-flight work and exits on its own
        // — which is the whole point of preferring this path to a signal.
        fetch: spyFetch(seen, { ok: true }, () => child?.exit(0)),
      });
      expect(out.exitCode).toBe(0);
      expect(out.lines[0]).toContain("drained");
      expect(out.lines.join("\n")).not.toContain("SIGTERM");
      expect(seen[0]).toContain(":41236/");
      expect(child?.signals).toEqual([]);
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

// ---------------------------------------------------------------------------
// 0.6.0 §9.4 — `daemon status` pin freshness (the restart-to-serve-pin signal)
// ---------------------------------------------------------------------------

describe("crewhaus daemon status — registry pin freshness", () => {
  /** Stamp the fixture's bundle as compiled from `specYaml` (what `compile` writes). */
  function stampBundle(dir: string, specYaml: string): void {
    writeFileSync(
      join(dir, "dist", "package.json"),
      `${JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: hashSpecSource(specYaml), compiledWith: "0.6.0" },
      })}\n`,
    );
  }

  test("no registry, no pins → not a word about pins (the common case adds no output)", async () => {
    const f = fixture();
    try {
      const out = await runDaemonCommand(["status"], f.opts);
      expect(out.lines.join("\n")).not.toContain("pins (");
      const json = JSON.parse(
        (await runDaemonCommand(["status", "--json"], f.opts)).lines.join("\n"),
      ) as Record<string, unknown>;
      expect(json["pins"]).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  test("a pin the running bundle was compiled from is `served`; a newer pin says restart-to-serve-pin", async () => {
    const f = fixture();
    try {
      const specYaml = readFileSync(join(f.dir, "crewhaus.yaml"), "utf8");
      stampBundle(f.dir, specYaml);
      const reg = createFileBackedRegistry({ rootDir: join(f.dir, ".crewhaus", "specs") });
      await reg.put("daemon-fixture", "v1", specYaml);
      await reg.put("daemon-fixture", "v2", `${specYaml}budget:\n  usd: 1\n`);
      await reg.pin("daemon-fixture", "staging", "v1");
      await reg.pin("daemon-fixture", "prod", "v2");

      const text = (await runDaemonCommand(["status"], f.opts)).lines.join("\n");
      expect(text).toContain("pins (");
      expect(text).toContain("staging → v1 · served by the compiled bundle");
      expect(text).toContain("prod → v2 · NOT served");
      expect(text).toContain("restart-to-serve-pin");
      expect(text).toContain("crewhaus daemon restart");

      const json = JSON.parse(
        (await runDaemonCommand(["status", "--json"], f.opts)).lines.join("\n"),
      ) as { pins: { entries: Array<{ env: string; version: string; state: string }> } };
      expect(json.pins.entries).toEqual([
        expect.objectContaining({ env: "prod", version: "v2", state: "not-served" }),
        expect.objectContaining({ env: "staging", version: "v1", state: "served" }),
      ]);
    } finally {
      f.cleanup();
    }
  });

  test("an unstamped bundle cannot be compared, and says so instead of guessing", async () => {
    const f = fixture();
    try {
      const specYaml = readFileSync(join(f.dir, "crewhaus.yaml"), "utf8");
      const reg = createFileBackedRegistry({ rootDir: join(f.dir, ".crewhaus", "specs") });
      await reg.put("daemon-fixture", "v1", specYaml);
      await reg.pin("daemon-fixture", "prod", "v1");
      const text = (await runDaemonCommand(["status"], f.opts)).lines.join("\n");
      expect(text).toContain("prod → v1 · cannot compare");
      expect(text).toContain("no spec-hash stamp");
    } finally {
      f.cleanup();
    }
  });

  test("registryPinFreshness is undefined for a registry that holds versions but pins nothing", async () => {
    const f = fixture();
    try {
      const reg = createFileBackedRegistry({ rootDir: join(f.dir, ".crewhaus", "specs") });
      await reg.put("daemon-fixture", "v1", "name: daemon-fixture\n");
      expect(
        await registryPinFreshness({ dir: f.dir, target: "channel", specName: "daemon-fixture" }),
      ).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });
});
