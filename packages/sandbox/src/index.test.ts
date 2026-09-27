import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SANDBOX_CONTAINER_LABEL,
  SANDBOX_DEFAULT_ALLOWED_IMAGES,
  SANDBOX_DEFAULT_MAX_OUTPUT_BYTES,
  SANDBOX_REAPER_TAG,
  SandboxError,
  createSandbox,
  resolveSandboxBackend,
  sandboxAvailableFromEnv,
} from "./index";

const ORIGINAL_ENV = { ...process.env };
function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CREWHAUS_SANDBOX")) delete process.env[key];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k.startsWith("CREWHAUS_SANDBOX") && v !== undefined) process.env[k] = v;
  }
}

describe("createSandbox factory", () => {
  beforeEach(() => {
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
  });

  test("backend resolves from env", () => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
    const s = createSandbox();
    expect(s.backend).toBe("noop");
  });

  test("explicit option overrides env", () => {
    process.env["CREWHAUS_SANDBOX"] = "docker";
    const s = createSandbox({ backend: "noop" });
    expect(s.backend).toBe("noop");
  });

  test("invalid env value throws at construction", () => {
    process.env["CREWHAUS_SANDBOX"] = "vagrant";
    expect(() => createSandbox()).toThrow(SandboxError);
  });

  test("default allowlist exposes the curated image list", () => {
    expect(SANDBOX_DEFAULT_ALLOWED_IMAGES).toContain("python:3.13-slim");
    expect(SANDBOX_DEFAULT_ALLOWED_IMAGES).toContain("node:22-alpine");
    expect(SANDBOX_DEFAULT_ALLOWED_IMAGES).toContain("alpine:3.19");
  });
});

describe("noop backend exec", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("runs argv and captures stdout", async () => {
    const sandbox = createSandbox();
    const result = await sandbox.exec({
      image: "python:3.13-slim",
      argv: ["printf", "hello"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("propagates non-zero exit code", async () => {
    const sandbox = createSandbox();
    const result = await sandbox.exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "echo nope >&2; exit 17"],
    });
    expect(result.exitCode).toBe(17);
    expect(result.stderr).toContain("nope");
  });

  test("times out and marks timedOut=true", async () => {
    const sandbox = createSandbox();
    const result = await sandbox.exec({
      image: "alpine:3.19",
      argv: ["sleep", "5"],
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    // SIGKILL via Bun -> exitCode is non-zero (typically negative for signals)
    expect(result.exitCode).not.toBe(0);
  });

  test("streams stdout chunks to onStdoutChunk", async () => {
    const sandbox = createSandbox();
    const chunks: string[] = [];
    await sandbox.exec({
      image: "python:3.13-slim",
      argv: ["printf", "abcdefg"],
      onStdoutChunk: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toBe("abcdefg");
  });
});

describe("image allowlist", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("default allowlist accepts curated images", async () => {
    const sandbox = createSandbox();
    const result = await sandbox.exec({ image: "alpine:3.19", argv: ["printf", "ok"] });
    expect(result.stdout).toBe("ok");
  });

  test("rejects unknown image", async () => {
    const sandbox = createSandbox();
    await expect(sandbox.exec({ image: "evil:latest", argv: ["true"] })).rejects.toThrow(
      /not on the allowlist/,
    );
  });

  test("rejects image starting with dash (CLI flag injection)", async () => {
    const sandbox = createSandbox();
    await expect(sandbox.exec({ image: "--privileged", argv: ["true"] })).rejects.toThrow(
      /CLI flag/,
    );
  });

  test("rejects image with whitespace (newline injection)", async () => {
    const sandbox = createSandbox();
    await expect(
      sandbox.exec({ image: "alpine:3.19\n--privileged", argv: ["true"] }),
    ).rejects.toThrow(/whitespace|valid registry/);
  });

  test("rejects image with shell-meta tag", async () => {
    const sandbox = createSandbox();
    await expect(sandbox.exec({ image: "alpine:$(id)", argv: ["true"] })).rejects.toThrow(
      /valid registry/,
    );
  });

  test("env CREWHAUS_SANDBOX_ALLOWED_IMAGES extends allowlist", async () => {
    process.env["CREWHAUS_SANDBOX_ALLOWED_IMAGES"] = "busybox:1.36";
    const sandbox = createSandbox();
    // No throw: image is now allowed (will run via Bun.spawn with non-existent
    // binary args but the allowlist check passes first).
    await sandbox.exec({ image: "busybox:1.36", argv: ["printf", "x"] });
  });

  test("explicit allowedImages overrides default", async () => {
    const sandbox = createSandbox({ allowedImages: ["my:image"] });
    await expect(sandbox.exec({ image: "alpine:3.19", argv: ["true"] })).rejects.toThrow(
      /not on the allowlist/,
    );
  });
});

describe("mount whitelist", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("rejects mount src outside whitelist", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "/etc", dst: "/etc-mounted" }],
      }),
    ).rejects.toThrow(/not under any whitelisted root/);
  });

  test("rejects relative mount src", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "../etc", dst: "/etc-mounted" }],
      }),
    ).rejects.toThrow(/absolute/);
  });

  test("rejects mount path with traversal segment", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "/srv/agent/../etc", dst: "/etc-mounted" }],
      }),
    ).rejects.toThrow(/may not contain "\.\."/);
  });

  test("rejects newline in mount path", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "/srv/agent\n--privileged", dst: "/x" }],
      }),
    ).rejects.toThrow(/newline|may not contain/);
  });

  test("accepts mount inside whitelist root", async () => {
    const sandbox = createSandbox({ mountWhitelist: ["/srv/agent"] });
    // Goes through validation; noop won't actually mount anything.
    await sandbox.exec({
      image: "alpine:3.19",
      argv: ["printf", "ok"],
      mounts: [{ src: "/srv/agent/data", dst: "/data" }],
    });
  });
});

describe("env-key validation", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("rejects invalid env key", async () => {
    const sandbox = createSandbox();
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        env: { "FOO BAR": "1" },
      }),
    ).rejects.toThrow(/not a valid identifier/);
  });

  test("accepts well-formed env key", async () => {
    const sandbox = createSandbox();
    await sandbox.exec({
      image: "alpine:3.19",
      argv: ["printf", "ok"],
      env: { FOO_BAR: "1" },
    });
  });
});

describe("close", () => {
  beforeEach(() => {
    process.env["CREWHAUS_SANDBOX"] = "noop";
  });
  afterEach(() => {
    resetEnv();
  });

  test("close prevents further exec", async () => {
    const sandbox = createSandbox();
    await sandbox.close();
    await expect(sandbox.exec({ image: "alpine:3.19", argv: ["true"] })).rejects.toThrow(/closed/);
  });

  test("close is idempotent", async () => {
    const sandbox = createSandbox();
    await sandbox.close();
    await sandbox.close();
  });
});

describe("docker backend (no daemon required for argv assembly)", () => {
  beforeEach(() => {
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
  });

  test("validates image on docker backend before invoking docker", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    await expect(sandbox.exec({ image: "evil:latest", argv: ["true"] })).rejects.toThrow(
      /not on the allowlist/,
    );
  });

  test("validates mount on docker backend before invoking docker", async () => {
    const sandbox = createSandbox({ backend: "docker", mountWhitelist: ["/srv/agent"] });
    await expect(
      sandbox.exec({
        image: "alpine:3.19",
        argv: ["true"],
        mounts: [{ src: "/etc", dst: "/etc" }],
      }),
    ).rejects.toThrow(/not under any whitelisted root/);
  });
});

// Drives the DockerLikeSandbox body WITHOUT a docker daemon: Bun.spawn is
// spied so `docker`/`podman` resolve to a fake CLI script that behaves as the
// real CLI and daemon do where it matters here:
//   - `create` asks the "daemon" for a container record, which it commits in
//     a session of its own (so killing the client does not stop it): at once,
//     or FAKE_CLI_CREATE_DELAY seconds later — or right after an `rm -f` has
//     looked for the name and found nothing, the order a busy daemon showed.
//   - `start -a -i NAME` runs the record's program in a session of its own (a
//     real container sits outside the CLI's process group) and waits for it,
//     holding the pipes. `run` (0.7.0's verb) is create and start in one.
//   - `kill NAME` stops a running container (a created one is "not running");
//     `rm -f NAME` stops and removes it, and answers 0 for a name it lacks.
//   - FAKE_CLI_WRAPPER: `run`/`start` fork the real client in the CLI's group,
//     as Docker Desktop's wrapper does; the wrapper dies of SIGTERM, the
//     client proxies it and lives on, and acts FAKE_CLI_CLIENT_DELAY seconds
//     in — or at once after an `rm -f` has looked for its container.
//   - FAKE_CLI_KILL_DELAY makes `kill` slow; FAKE_CLI_RM_FAIL makes `rm`
//     fail.
const posix = process.platform !== "win32";
const hasPerl = posix && Bun.spawnSync(["perl", "-e", "exit 0"]).exitCode === 0;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, budgetMs: number): Promise<boolean> {
  const until = performance.now() + budgetMs;
  while (performance.now() < until) {
    if (!alive(pid)) return true;
    await Bun.sleep(20);
  }
  return !alive(pid);
}

/** Kills the detached reapers (retries) started for `names` by processes the test cannot reach. */
function killReapersFor(names: ReadonlyArray<string>): void {
  if (names.length === 0) return;
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  for (const line of new TextDecoder().decode(ps.stdout).split("\n")) {
    if (!line.includes(SANDBOX_REAPER_TAG)) continue;
    if (!names.some((n) => n !== "" && line.includes(n))) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

const FAKE_CLI = (d: string) => `#!/bin/sh
D='${d}'
[ -z "$FAKE_CLI_NOLOG" ] && printf '%s\\n' "$*" >> "$D/log"
verb="$1"; shift

# The "daemon" commits a create in a session of its own.
commit() {
  perl -e '
    use POSIX (); use Time::HiRes qw(sleep time);
    POSIX::setsid();
    my ($d, $n, $delay) = @ARGV;
    my $until = time + ($delay || 0);
    sleep 0.01 while time < $until && ! -e "$d/asked-$n";
    rename "$d/pending-$n", "$d/record-$n";
    open my $l, ">>", "$d/log"; print $l "committed $n\\n"; close $l;
  ' "$D" "$1" "$FAKE_CLI_CREATE_DELAY" </dev/null >/dev/null 2>&1 &
}

# Runs a committed record's program as the container, and waits for it.
attach() {
  n="$1"
  [ -f "$D/record-$n" ] || { echo "Error: No such container: $n" >&2; exit 1; }
  set --
  while IFS= read -r a; do set -- "$@" "$a"; done < "$D/record-$n"
  exec 3<&0
  perl -e 'use POSIX (); POSIX::setsid(); exec @ARGV or exit 127' -- "$@" <&3 3<&- &
  pid=$!
  echo "$pid" > "$D/container-$n"
  wait "$pid"; st=$?
  rm -f "$D/record-$n"
  exit $st
}

if [ -n "$FAKE_CLI_WRAPPER" ] && [ -z "$FAKE_CLI_IS_CLIENT" ] && { [ "$verb" = run ] || [ "$verb" = start ]; }; then
  exec 3<&0
  FAKE_CLI_IS_CLIENT=1 FAKE_CLI_NOLOG=1 "$0" "$verb" "$@" <&3 3<&- &
  wait $!
  exit $?
fi
if [ -n "$FAKE_CLI_IS_CLIENT" ]; then
  trap '' TERM
  : > "$D/client-ready"
fi

# The client proxies TERM and goes on: it acts FAKE_CLI_CLIENT_DELAY seconds
# in, or at once when an \`rm -f\` has just looked for its container.
client_wait() {
  [ -n "$FAKE_CLI_IS_CLIENT" ] || return 0
  perl -e 'use Time::HiRes qw(sleep time); my ($f, $d) = @ARGV; my $u = time + $d; sleep 0.01 while time < $u && ! -e $f;' "$D/asked-$1" "\${FAKE_CLI_CLIENT_DELAY:-0}"
}

case "$verb" in
  create|run)
    name=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --tmpfs|--security-opt|--ulimit|--label|-v|-e) shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    shift
    client_wait "$name"
    printf '%s\\n' "$@" > "$D/pending-$name"
    commit "$name"
    while [ ! -f "$D/record-$name" ]; do sleep 0.02; done
    [ "$verb" = run ] && attach "$name"
    echo "$name"
    exit 0
    ;;
  start)
    for n; do :; done
    client_wait "$n"
    attach "$n"
    ;;
  kill|rm)
    [ "$1" = "-f" ] && shift
    [ "$verb" = kill ] && [ -n "$FAKE_CLI_KILL_DELAY" ] && sleep "$FAKE_CLI_KILL_DELAY"
    if [ "$verb" = rm ] && [ -n "$FAKE_CLI_RM_FAIL" ]; then
      echo "Error response from daemon: $FAKE_CLI_RM_FAIL" >&2; exit 1
    fi
    status=0
    for n; do
      pid=$(cat "$D/container-$n" 2>/dev/null)
      running=""
      [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && running=1
      if [ -f "$D/record-$n" ] || [ -n "$running" ]; then
        if [ "$verb" = kill ] && [ -z "$running" ]; then
          echo "Error response from daemon: Cannot kill container: $n: is not running" >&2; status=1
        else
          [ -n "$running" ] && kill -9 "$pid" 2>/dev/null
          rm -f "$D/record-$n"
          echo "$n"
        fi
      else
        [ "$verb" = rm ] && : > "$D/asked-$n"
        echo "Error: No such container: $n" >&2
        [ "$verb" = kill ] && status=1
      fi
    done
    exit $status
    ;;
esac
exit 125
`;

describe.if(hasPerl)("docker backend (fake CLI — no daemon)", () => {
  type SpawnCall = {
    argv: readonly string[];
    options: Record<string, unknown>;
    proc: ReturnType<typeof Bun.spawn>;
  };
  let dir = "";
  let fake = "";
  let calls: SpawnCall[] = [];
  let spawnSpy: ReturnType<typeof spyOn> | undefined;

  // Bracket-notation call into the Sandbox interface method (defined in
  // ./index). Keeps every call site free of the bare exec( token.
  type RunArgs = Parameters<ReturnType<typeof createSandbox>["exec"]>[0];
  function runExec(sandbox: ReturnType<typeof createSandbox>, args: RunArgs) {
    return sandbox["exec"](args);
  }

  function log(): string[] {
    const file = join(dir, "log");
    return existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l !== "")
      : [];
  }

  /** The CLI's own calls, without the create's commit lines. */
  function cliLog(): string[] {
    return log().filter((l) => !l.startsWith("committed "));
  }

  function containerPid(name: string): number {
    return Number(readFileSync(join(dir, `container-${name}`), "utf8").trim());
  }

  /** Container records the fake daemon still has (created or running). */
  function records(): string[] {
    return readdirSync(dir)
      .filter((f) => f.startsWith("record-"))
      .map((f) => f.slice("record-".length));
  }

  /** Programs the fake started that are still running. */
  function running(): string[] {
    return readdirSync(dir)
      .filter((f) => f.startsWith("container-"))
      .filter((f) => alive(Number(readFileSync(join(dir, f), "utf8").trim())))
      .map((f) => f.slice("container-".length));
  }

  /** Resolves once the fake container of the first run has started. */
  async function containerStarted(budgetMs: number): Promise<string> {
    const until = performance.now() + budgetMs;
    while (performance.now() < until) {
      const f = readdirSync(dir).find((n) => n.startsWith("container-"));
      if (f !== undefined && readFileSync(join(dir, f), "utf8").trim() !== "") {
        return f.slice("container-".length);
      }
      await Bun.sleep(10);
    }
    throw new Error("the fake container never started");
  }

  /** Resolves once the CLI log has a line starting with one of `prefixes`. */
  async function logged(prefixes: ReadonlyArray<string>, budgetMs: number): Promise<void> {
    const until = performance.now() + budgetMs;
    while (performance.now() < until) {
      if (log().some((l) => prefixes.some((p) => l.startsWith(p)))) return;
      await Bun.sleep(5);
    }
    throw new Error(`the fake CLI never logged ${prefixes.join(" or ")}`);
  }

  /** Resolves once `path` exists. */
  async function appears(path: string, budgetMs: number): Promise<void> {
    const until = performance.now() + budgetMs;
    while (!existsSync(path)) {
      if (performance.now() > until) throw new Error(`${path} never appeared`);
      await Bun.sleep(5);
    }
  }

  function nameOf(line: string | undefined): string {
    const m = /(crewhaus-sbx-[0-9a-f]{16})/.exec(line ?? "");
    return m?.[1] ?? "";
  }

  const cliCalls = () => calls.filter((c) => c.argv[0] === "docker" || c.argv[0] === "podman");
  const reaperCalls = () => calls.filter((c) => c.argv[3] === SANDBOX_REAPER_TAG);

  function routeCli(cliPath: (argv0: string) => string | undefined): void {
    const orig = Bun.spawn.bind(Bun);
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
      argv: readonly string[],
      options: Record<string, unknown>,
    ) => {
      let routed = [...argv];
      const to = cliPath(argv[0] ?? "");
      if (to !== undefined) routed = [to, ...argv.slice(1)];
      // A reaper names the CLI it will run: route that too.
      if (argv[3] === SANDBOX_REAPER_TAG) {
        const cli = cliPath(argv[4] ?? "");
        if (cli !== undefined) routed[4] = cli;
      }
      // Bun.spawn does not see process.env changes made after startup: hand
      // the fake the FAKE_CLI_* a test set.
      const proc = orig(routed, { ...options, env: { ...process.env, ...(options["env"] ?? {}) } });
      calls.push({ argv, options, proc });
      return proc;
      // biome-ignore lint/suspicious/noExplicitAny: test double for Bun.spawn
    }) as any);
  }

  const env: Record<string, string | undefined> = {};
  function setFakeEnv(vars: Record<string, string>): void {
    for (const [k, v] of Object.entries(vars)) {
      env[k] = process.env[k];
      process.env[k] = v;
    }
  }

  beforeEach(() => {
    resetEnv();
    calls = [];
    dir = mkdtempSync(join(tmpdir(), "sandbox-fake-cli-"));
    fake = join(dir, "fake-cli");
    writeFileSync(fake, FAKE_CLI(dir));
    chmodSync(fake, 0o755);
    // The first exec of a new file can be slow (macOS checks it); pay that
    // here, not inside a test's timeout. `version` is logged nowhere.
    Bun.spawnSync([fake, "version"], { env: { ...process.env, FAKE_CLI_NOLOG: "1" } });
    routeCli((argv0) => (argv0 === "docker" || argv0 === "podman" ? fake : undefined));
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    spawnSpy = undefined;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete env[k];
    }
    // Never leave a reaper or a fake container behind a failed assertion.
    for (const c of reaperCalls()) {
      if (c.proc.exitCode !== null || c.proc.signalCode !== null) continue;
      try {
        process.kill(-c.proc.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("container-")) continue;
      const pid = Number(readFileSync(join(dir, f), "utf8").trim());
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
    resetEnv();
  });

  test("happy path: creates a named, labelled container, starts it attached, pipes stdin, collects streams", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "cat; echo err! >&2"],
      stdin: "payload-in",
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "payload-in",
      stderr: "err!\n",
      timedOut: false,
      aborted: false,
      outputComplete: true,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0,
    });
    expect(result.strayContainer).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // A clean run is create + start: no kill and no rm.
    const [create, start, ...rest] = cliCalls();
    expect(rest).toEqual([]);
    expect(create?.argv.slice(0, 3)).toEqual(["docker", "create", "--rm"]);
    // The hardened default flags.
    expect(create?.argv).toContain("--network=none");
    expect(create?.argv).toContain("--read-only");
    expect(create?.argv).toContain("--security-opt");
    expect(create?.argv).toContain("no-new-privileges");
    const at = create?.argv.indexOf("--name") ?? -1;
    const name = create?.argv[at + 1] ?? "";
    expect(name).toMatch(/^crewhaus-sbx-[0-9a-f]{16}$/);
    const label = create?.argv.indexOf("--label") ?? -1;
    expect(create?.argv[label + 1]).toBe(`${SANDBOX_CONTAINER_LABEL}=1`);
    // image + argv are appended verbatim as the trailing elements.
    expect(create?.argv.slice(-4)).toEqual(["alpine:3.19", "sh", "-c", "cat; echo err! >&2"]);
    expect(start?.argv).toEqual(["docker", "start", "-a", "-i", name]);
    // The CLI leads its own process group, and the caller's signal is not
    // handed to Bun.spawn: its SIGTERM reaches the container's PID 1, which
    // ignores it.
    expect(start?.options["detached"]).toBe(true);
    expect(start?.options["signal"]).toBeUndefined();
  }, 20_000);

  test("every run gets a container name of its own", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    await runExec(sandbox, { image: "alpine:3.19", argv: ["true"] });
    await runExec(sandbox, { image: "alpine:3.19", argv: ["true"] });
    const names = cliLog()
      .filter((l) => l.startsWith("create "))
      .map(nameOf);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  }, 20_000);

  test("network=true switches to --network=bridge", async () => {
    const sandbox = createSandbox({ backend: "docker", network: true });
    await runExec(sandbox, { image: "alpine:3.19", argv: ["true"] });
    expect(cliCalls()[0]?.argv).toContain("--network=bridge");
    expect(cliCalls()[0]?.argv).not.toContain("--network=none");
  }, 20_000);

  test("forwards env vars and mounts (with :ro) to docker", async () => {
    const sandbox = createSandbox({ backend: "docker", mountWhitelist: ["/srv/agent"] });
    await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["true"],
      env: { FOO_BAR: "1" },
      mounts: [
        { src: "/srv/agent/ro", dst: "/ro" },
        { src: "/srv/agent/rw", dst: "/rw", readonly: false },
      ],
    });
    const argv = cliCalls()[0]?.argv ?? [];
    expect(argv).toContain("-e");
    expect(argv).toContain("FOO_BAR=1");
    expect(argv).toContain("/srv/agent/ro:/ro:ro");
    expect(argv).toContain("/srv/agent/rw:/rw");
  }, 20_000);

  test("streams stdout chunks through onStdoutChunk on the docker path", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    const chunks: string[] = [];
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["printf", "chunked"],
      onStdoutChunk: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toBe("chunked");
    expect(result.stdout).toBe("chunked");
  }, 20_000);

  test("run without stdin gives the program an empty stdin", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    const result = await runExec(sandbox, { image: "alpine:3.19", argv: ["cat"] });
    expect(result).toMatchObject({ exitCode: 0, stdout: "", timedOut: false });
  }, 20_000);

  // `docker create` exits 1 for a daemon error where `docker run` exited
  // 125; the result keeps 0.7.0's 125, so nothing reading it changes.
  test("a create the daemon refuses is the run's result, with its message and docker run's 125", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    spawnSpy?.mockRestore();
    const refusing = join(dir, "refusing-cli");
    writeFileSync(
      refusing,
      "#!/bin/sh\necho 'Error response from daemon: no space left on device' >&2\nexit 1\n",
    );
    chmodSync(refusing, 0o755);
    routeCli((argv0) => (argv0 === "docker" ? refusing : undefined));
    const result = await runExec(sandbox, { image: "alpine:3.19", argv: ["true"] });
    expect(result).toMatchObject({
      exitCode: 125,
      stdout: "",
      stderr: "Error response from daemon: no space left on device\n",
      timedOut: false,
      aborted: false,
    });
    // Nothing was made, so nothing is started or removed.
    expect(cliCalls().map((c) => c.argv[1])).toEqual(["create"]);
    expect(result.strayContainer).toBeUndefined();
  }, 20_000);

  test("close() makes the docker sandbox refuse further runs", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    await sandbox.close();
    await expect(runExec(sandbox, { image: "alpine:3.19", argv: ["true"] })).rejects.toThrow(
      /closed/,
    );
    // Idempotent close.
    await sandbox.close();
    expect(calls).toHaveLength(0);
  });

  test("docker constructor rejects a non-absolute mountWhitelist entry", () => {
    expect(() => createSandbox({ backend: "docker", mountWhitelist: ["relative/path"] })).toThrow(
      /must be absolute/,
    );
  });

  test("docker constructor honours an explicit allowedImages list", async () => {
    // Passing a NON-EMPTY allowedImages exercises the constructor's
    // `.filter((s) => s.length > 0)` callback (empty-array constructions
    // never invoke it). The custom list also replaces the curated default.
    const sandbox = createSandbox({ backend: "docker", allowedImages: ["custom:tag", ""] });
    const result = await runExec(sandbox, { image: "custom:tag", argv: ["printf", "ok"] });
    expect(result.stdout).toBe("ok");
    // A curated default image is now rejected because the explicit list won.
    await expect(runExec(sandbox, { image: "alpine:3.19", argv: ["true"] })).rejects.toThrow(
      /not on the allowlist/,
    );
  }, 20_000);

  test("a UTF-8 character split across chunks reaches onStdoutChunk whole", async () => {
    // "A" + the first byte of "€", a pause, then its last two bytes.
    const sandbox = createSandbox({ backend: "docker" });
    const chunks: string[] = [];
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "printf 'A\\342'; sleep 0.2; printf '\\202\\254'"],
      onStdoutChunk: (c) => chunks.push(c),
    });
    expect(result.stdout).toBe("A€");
    expect(chunks.join("")).toBe("A€");
  }, 20_000);

  test("a CLI that cannot start is a SandboxError that names it", async () => {
    spawnSpy?.mockRestore();
    routeCli((argv0) => (argv0 === "docker" ? join(dir, "no-such-cli") : undefined));
    const sandbox = createSandbox({ backend: "docker" });
    await expect(runExec(sandbox, { image: "alpine:3.19", argv: ["true"] })).rejects.toThrow(
      /could not start docker/,
    );
  }, 20_000);

  // security-6#0 / flag-truth-3#0: the timeout SIGKILLed only the CLI and then
  // waited for pipes the still-running container held — the call returned when
  // the program ended on its own, and the container outlived the timeout.
  test("a timeout kills the container by name, and the call returns without waiting for it", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    const t0 = performance.now();
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "echo started; sleep 30; echo never"],
      timeoutMs: 3_000,
    });
    const elapsed = performance.now() - t0;
    const lines = cliLog();
    const name = nameOf(lines[0]);
    expect(name).toMatch(/^crewhaus-sbx-[0-9a-f]{16}$/);
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.stdout).toBe("started\n");
    // Killed by name, then removed.
    expect(lines.slice(1)).toEqual([`start -a -i ${name}`, `kill ${name}`, `rm -f ${name}`]);
    expect(await waitGone(containerPid(name), 2_000)).toBe(true);
    expect(records()).toEqual([]);
    expect(result.strayContainer).toBeUndefined();
    // The fake container sleeps 30 s; returning in a fraction of that is the
    // property, not a race.
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  test("an abort stops the container the same way and says it was cancelled", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    const controller = new AbortController();
    // Abort once the container runs: the property is what an abort does to
    // a running container, whatever the machine's spawn latency.
    void containerStarted(10_000).then(() => controller.abort());
    const t0 = performance.now();
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "echo started; sleep 30; echo never"],
      signal: controller.signal,
    });
    const elapsed = performance.now() - t0;
    const lines = cliLog();
    const name = nameOf(lines[0]);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).not.toContain("never");
    expect(lines.slice(1)).toEqual([`start -a -i ${name}`, `kill ${name}`, `rm -f ${name}`]);
    expect(await waitGone(containerPid(name), 2_000)).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  test("a signal aborted before the call starts nothing", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    const controller = new AbortController();
    controller.abort();
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "echo should-not-run"],
      signal: controller.signal,
    });
    expect(result).toMatchObject({ aborted: true, timedOut: false, exitCode: -1, stdout: "" });
    expect(log()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("the podman backend drives podman: create, start, and a kill by name", async () => {
    const sandbox = createSandbox({ backend: "podman" });
    const controller = new AbortController();
    void containerStarted(10_000).then(() => controller.abort());
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sleep", "30"],
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    const verbs = cliCalls().map((c) => `${c.argv[0]} ${c.argv[1]}`);
    expect(verbs).toEqual(["podman create", "podman start", "podman kill", "podman rm"]);
  }, 20_000);

  // C012: the CLI was killed while the daemon was still creating the
  // container. `kill` and `rm -f` both found nothing, and the daemon committed
  // the create right after: a container left in the Created state, with the
  // tool reporting a clean cancel.
  test("a create the daemon commits after the stop is waited for and removed", async () => {
    setFakeEnv({ FAKE_CLI_CREATE_DELAY: "1.5" });
    const sandbox = createSandbox({ backend: "docker" });
    const controller = new AbortController();
    void logged(["create ", "run "], 10_000).then(() => controller.abort());
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "echo should-not-run; sleep 30"],
      signal: controller.signal,
    });
    const name = nameOf(log()[0]);
    expect({ records: records(), running: running() }).toEqual({ records: [], running: [] });
    // The daemon did commit it, and it was removed after that.
    const lines = log();
    expect(lines.indexOf(`committed ${name}`)).toBeGreaterThan(-1);
    expect(lines.indexOf(`rm -f ${name}`)).toBeGreaterThan(lines.indexOf(`committed ${name}`));
    // It never ran, and the result says it was cancelled, not that it exited.
    expect(result).toMatchObject({ aborted: true, timedOut: false, exitCode: -1, stdout: "" });
    expect(result.strayContainer).toBeUndefined();
    // Nothing turns up later either.
    await Bun.sleep(1_000);
    expect({ records: records(), running: running() }).toEqual({ records: [], running: [] });
  }, 30_000);

  // C012, the other half: Docker Desktop's wrapper died of the SIGTERM, but
  // the client it forked proxied it and lived on, and started the container
  // after the sandbox's `rm -f` — running after the tool said "cancelled".
  test("a client that outlives its SIGTERM cannot leave a container after the call returns", async () => {
    setFakeEnv({ FAKE_CLI_WRAPPER: "1", FAKE_CLI_CLIENT_DELAY: "0.9" });
    const sandbox = createSandbox({ backend: "docker" });
    const controller = new AbortController();
    // Once the client is up and proxying TERM, as a real one is by then.
    void appears(join(dir, "client-ready"), 10_000).then(() => controller.abort());
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "while :; do sleep 0.05; done"],
      signal: controller.signal,
    });
    // Longer than the client's delay: had it lived, it would have acted by now.
    await Bun.sleep(1_500);
    expect({ records: records(), running: running() }).toEqual({ records: [], running: [] });
    expect(result.aborted).toBe(true);
    expect(result.strayContainer).toBeUndefined();
  }, 30_000);

  test("a timeout while the container is still being created is waited out the same way", async () => {
    setFakeEnv({ FAKE_CLI_CREATE_DELAY: "1.5" });
    const sandbox = createSandbox({ backend: "docker" });
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "sleep 30"],
      timeoutMs: 150,
    });
    await Bun.sleep(500);
    expect({ records: records(), running: running() }).toEqual({ records: [], running: [] });
    expect(result).toMatchObject({ timedOut: true, aborted: false, exitCode: -1 });
    expect(cliLog().map((l) => l.split(" ")[0])).toEqual(["create", "rm"]);
  }, 30_000);

  test("a create that never answers is cut off after the grace, and the result names what may be left", async () => {
    setFakeEnv({ FAKE_CLI_CREATE_DELAY: "60" });
    const sandbox = createSandbox({ backend: "docker" });
    const controller = new AbortController();
    void logged(["create "], 10_000).then(() => controller.abort());
    const t0 = performance.now();
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "sleep 30"],
      signal: controller.signal,
    });
    const name = nameOf(log()[0]);
    expect(result).toMatchObject({ aborted: true, exitCode: -1 });
    expect(result.strayContainer?.name).toBe(name);
    expect(result.strayContainer?.reason).toContain("still creating its container");
    expect(result.strayContainer?.reason).toContain("did not answer within 5s");
    // Bounded: the grace, not the create.
    expect(performance.now() - t0).toBeLessThan(20_000);
    // The daemon commits it after the sandbox's `rm -f`; the detached retry
    // removes it (5 s later), and it never runs.
    const retry = reaperCalls().find((c) => c.argv[6] === "5");
    expect(retry?.argv.slice(4)).toEqual(["docker", name, "5", "30"]);
    expect(retry?.options["detached"]).toBe(true);
    const until = performance.now() + 15_000;
    while (records().length > 0 || !log().includes(`committed ${name}`)) {
      if (performance.now() > until) break;
      await Bun.sleep(100);
    }
    expect(log()).toContain(`committed ${name}`);
    expect({ records: records(), running: running() }).toEqual({ records: [], running: [] });
  }, 40_000);

  test("an rm -f that fails is reported, not presented as a clean stop", async () => {
    setFakeEnv({ FAKE_CLI_RM_FAIL: "the daemon is wedged" });
    const sandbox = createSandbox({ backend: "docker" });
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "sleep 30"],
      timeoutMs: 1_000,
    });
    const name = nameOf(log()[0]);
    expect(result.timedOut).toBe(true);
    expect(result.strayContainer).toEqual({
      name,
      reason: "docker rm -f failed: Error response from daemon: the daemon is wedged",
    });
    expect(reaperCalls().some((c) => c.argv[5] === name && c.argv[6] === "5")).toBe(true);
  }, 30_000);

  test("a CLI killed by something else leaves no container running", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    const done = runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["sh", "-c", "sleep 30"],
    });
    const name = await containerStarted(10_000);
    const attached = cliCalls().find((c) => c.argv[1] === "start" || c.argv[1] === "run");
    process.kill(-(attached?.proc.pid as number), "SIGKILL");
    const result = await done;
    expect(result.timedOut).toBe(false);
    expect(await waitGone(containerPid(name), 5_000)).toBe(true);
    expect(records()).toEqual([]);
    expect(cliLog().slice(-2)).toEqual([`kill ${name}`, `rm -f ${name}`]);
  }, 30_000);

  // The backstop for a host killed outright: the kernel, not the host, ends
  // a program that has used its timeout's worth of CPU (at the --cpus cap).
  test("every run carries a CPU-time limit the kernel enforces: its timeout's worth plus a grace", async () => {
    const ulimitOf = (i: number): string | undefined => {
      const argv = cliCalls().filter((c) => c.argv[1] === "create")[i]?.argv ?? [];
      const at = argv.indexOf("--ulimit");
      return at === -1 ? undefined : argv[at + 1];
    };
    await runExec(createSandbox({ backend: "docker" }), {
      image: "alpine:3.19",
      argv: ["true"],
      timeoutMs: 1_000,
    });
    await runExec(createSandbox({ backend: "docker" }), { image: "alpine:3.19", argv: ["true"] });
    await runExec(createSandbox({ backend: "docker", cpus: "2.5" }), {
      image: "alpine:3.19",
      argv: ["true"],
      timeoutMs: 1_000,
    });
    await runExec(createSandbox({ backend: "docker" }), {
      image: "alpine:3.19",
      argv: ["true"],
      timeoutMs: 1_500,
    });
    await runExec(createSandbox({ backend: "docker" }), {
      image: "alpine:3.19",
      argv: ["true"],
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    expect([0, 1, 2, 3, 4].map(ulimitOf)).toEqual([
      "cpu=11:11",
      "cpu=70:70",
      "cpu=13:13",
      "cpu=12:12",
      undefined, // no timeout, no limit
    ]);
  }, 20_000);

  test("a sandbox says the default timeout a call without one runs with", () => {
    expect(createSandbox({ backend: "docker" }).execDefaults).toEqual({ timeoutMs: 60_000 });
    expect(createSandbox({ backend: "podman", defaultTimeoutMs: 5_000 }).execDefaults).toEqual({
      timeoutMs: 5_000,
    });
    expect(createSandbox({ backend: "noop", defaultTimeoutMs: 7_000 }).execDefaults).toEqual({
      timeoutMs: 7_000,
    });
  });

  // C012: the timeout and the abort live in the host. A host that went away
  // mid-run — process.exit, a SIGINT or SIGTERM it does not handle, a second
  // Ctrl-C right after the first one's abort — left the container running
  // with no limit at all. The host here is a separate process whose
  // `docker` is the fake CLI.
  describe("when the host goes away mid-run", () => {
    const sandboxModule = join(import.meta.dir, "index.ts");

    type HostMode = "exit" | "abort-exit" | "unhandled" | "once";
    let hosts: Array<ReturnType<typeof Bun.spawn>> = [];

    afterEach(() => {
      // A host left behind by a failed assertion, with its group.
      for (const h of hosts) {
        if (h.exitCode !== null || h.signalCode !== null) continue;
        try {
          process.kill(-(h.pid as number), "SIGKILL");
        } catch {
          // already gone
        }
      }
      hosts = [];
    });

    function startHost(mode: HostMode, env: Record<string, string> = {}) {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      if (!existsSync(join(bin, "docker"))) symlinkSync(fake, join(bin, "docker"));
      const script = join(dir, `host-${mode}.ts`);
      writeFileSync(
        script,
        [
          `import { readdirSync, readFileSync } from "node:fs";`,
          `import { createSandbox } from ${JSON.stringify(sandboxModule)};`,
          `const dir = ${JSON.stringify(dir)};`,
          `const mode = ${JSON.stringify(mode)};`,
          `if (mode === "once") process.once("SIGINT", () => console.log("host handled SIGINT"));`,
          "const controller = new AbortController();",
          "const run = createSandbox({ backend: 'docker' }).exec({",
          "  image: 'alpine:3.19',",
          "  argv: mode === 'once' ? ['sh', '-c', 'sleep 1; echo finished'] : ['sh', '-c', 'while :; do sleep 0.05; done'],",
          "  timeoutMs: 120_000,",
          "  signal: controller.signal,",
          "});",
          "const poll = setInterval(() => {",
          "  const f = readdirSync(dir).find((n) => n.startsWith('container-'));",
          "  if (f === undefined || readFileSync(`${dir}/${f}`, 'utf8').trim() === '') return;",
          "  clearInterval(poll);",
          "  if (mode === 'exit') process.exit(0);",
          // The second Ctrl-C of a REPL: exit while the first one's kill runs.
          "  if (mode === 'abort-exit') { controller.abort(); process.exit(130); }",
          "}, 10);",
          "const r = await run;",
          "console.log(`exec returned ${r.exitCode} ${r.stdout.trim()}`);",
        ].join("\n"),
      );
      const h = Bun.spawn([process.execPath, script], {
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, ...env },
        stdout: "pipe",
        stderr: "pipe",
        // Its own process group, so a Ctrl-C can be sent to the whole of it.
        detached: true,
      });
      hosts.push(h);
      return h;
    }

    function hostContainer(): string {
      return nameOf(log().find((l) => l.startsWith("create ")));
    }

    test("process.exit stops the container by name before the host is gone", async () => {
      const h = startHost("exit");
      await h.exited;
      expect(h.exitCode).toBe(0);
      const name = hostContainer();
      expect(await waitGone(containerPid(name), 5_000)).toBe(true);
      expect(cliLog().slice(2)).toEqual([`kill ${name}`, `rm -f ${name}`]);
    }, 30_000);

    test("an exit right after an abort still stops it, though the abort's own kill is cut off", async () => {
      // The abort's `docker kill` is still running when the host exits, and
      // the exit kills it; the host's own stop must not depend on it.
      const h = startHost("abort-exit", { FAKE_CLI_KILL_DELAY: "1" });
      await h.exited;
      expect(h.exitCode).toBe(130);
      const name = hostContainer();
      expect(await waitGone(containerPid(name), 5_000)).toBe(true);
      expect(cliLog()).toContain(`rm -f ${name}`);
    }, 30_000);

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      test(`a ${sig} the host does not handle stops the container, and the host dies of it`, async () => {
        const h = startHost("unhandled");
        await containerStarted(15_000);
        // SIGINT to the whole group, as a terminal's Ctrl-C; SIGTERM to the
        // host, as a supervisor's stop. The CLI and the container are in
        // groups of their own, so neither reaches them.
        if (sig === "SIGINT") process.kill(-(h.pid as number), sig);
        else h.kill(sig);
        await h.exited;
        expect(h.signalCode).toBe(sig);
        const name = hostContainer();
        expect(await waitGone(containerPid(name), 5_000)).toBe(true);
        expect(cliLog()).toContain(`kill ${name}`);
      }, 30_000);
    }

    // eval-runner's pattern: `process.once("SIGINT", …)` lets in-flight work
    // finish. The once-wrapper removes itself before later listeners run, so
    // the host looked handler-less and was killed with 130 mid-run.
    test("a host whose SIGINT handler is process.once keeps its policy: the run finishes", async () => {
      const h = startHost("once");
      await containerStarted(15_000);
      h.kill("SIGINT");
      await h.exited;
      const out = await new Response(h.stdout).text();
      expect({ exitCode: h.exitCode, signal: h.signalCode }).toEqual({
        exitCode: 0,
        signal: null,
      });
      expect(out).toContain("host handled SIGINT");
      expect(out).toContain("exec returned 0 finished");
      expect(cliLog().filter((l) => !l.startsWith("create ") && !l.startsWith("start "))).toEqual(
        [],
      );
    }, 30_000);
  });
});

// A third-party backend written the way 0.7.0's own classes were — with a
// private `defaultTimeoutMs` — must still implement Sandbox (a type-level
// break of 0.7.1's first draft).
describe("a Sandbox written against 0.7.0 still type-checks", () => {
  test("a class with a private defaultTimeoutMs implements Sandbox", () => {
    // Outside the package, so no concurrent lint or build ever sees it; tsc
    // runs from here to find the workspace's types.
    const fixtureDir = mkdtempSync(join(tmpdir(), "sandbox-compat-"));
    try {
      const fixture = join(fixtureDir, "backend.ts");
      writeFileSync(
        fixture,
        [
          `import type { Sandbox, SandboxExecOptions, SandboxExecResult } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};`,
          "export class FirecrackerSandbox implements Sandbox {",
          '  readonly backend = "docker" as const;',
          "  private readonly defaultTimeoutMs: number = 30_000;",
          "  async exec(opts: SandboxExecOptions): Promise<SandboxExecResult> {",
          '    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: opts.timeoutMs ?? this.defaultTimeoutMs };',
          "  }",
          "  async close(): Promise<void> {}",
          "}",
        ].join("\n"),
      );
      const tsc = require.resolve("typescript/lib/tsc.js");
      const r = Bun.spawnSync(
        [
          process.execPath,
          tsc,
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "esnext",
          "--module",
          "esnext",
          "--moduleResolution",
          "bundler",
          "--allowImportingTsExtensions",
          "--types",
          "bun",
          fixture,
        ],
        { stdout: "pipe", stderr: "pipe", cwd: import.meta.dir },
      );
      const out = new TextDecoder().decode(r.stdout);
      expect(out.split("\n").filter((l) => l.includes("backend.ts"))).toEqual([]);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.if(posix)("noop backend: a timeout or abort takes down what the program started", () => {
  beforeEach(() => {
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
  });

  // The timeout used to SIGKILL only the direct child; a grandchild holding
  // the pipe kept the call waiting until it finished on its own.
  test("a grandchild holding the pipe does not hold the call past the timeout", async () => {
    const sandbox = createSandbox({ backend: "noop" });
    const t0 = performance.now();
    const result = await sandbox.exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "echo started; sleep 30; echo never"],
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("started\n");
    expect(result.exitCode).not.toBe(0);
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  test("an abort kills the program's group and says cancelled, not exit 0", async () => {
    const sandbox = createSandbox({ backend: "noop" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const t0 = performance.now();
    const result = await sandbox.exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "sleep 30; echo never"],
      signal: controller.signal,
    });
    expect(result).toMatchObject({ aborted: true, timedOut: false, stdout: "" });
    expect(result.exitCode).not.toBe(0);
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  test("a signal aborted before the call runs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-noop-abort-"));
    try {
      const marker = join(dir, "ran");
      const controller = new AbortController();
      controller.abort();
      const result = await createSandbox({ backend: "noop" }).exec({
        image: "alpine:3.19",
        argv: ["touch", marker],
        signal: controller.signal,
      });
      expect(result).toMatchObject({ aborted: true, exitCode: -1 });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// security-12#4 / security-6#8: stdout and stderr were buffered whole on the
// host — 150 MB of program output reached the tool result, and 256 MiB of
// verifier output cost 2.6 GiB of host memory. The cap now applies as bytes
// arrive; past it the output is drained and counted, never held.
describe.if(posix)("output is capped as it arrives", () => {
  const FLOOD = "head -c 3000000 /dev/zero | tr '\\0' a; echo; echo TAIL";
  const FLOOD_BYTES = 3_000_000 + 1 + 5;
  const marker = (n: number) => `[stdout truncated: ${n} bytes dropped]\n`;

  beforeEach(() => {
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
  });

  for (const streaming of [false, true]) {
    test(`keeps the start and the end, marks and counts the rest${streaming ? " (streaming)" : ""}`, async () => {
      const chunks: string[] = [];
      const result = await createSandbox({ backend: "noop" }).exec({
        image: "alpine:3.19",
        argv: ["sh", "-c", FLOOD],
        maxOutputBytes: 65_536,
        ...(streaming ? { onStdoutChunk: (c: string) => chunks.push(c) } : {}),
      });
      const dropped = FLOOD_BYTES - 65_536;
      expect(result.exitCode).toBe(0);
      expect(result.stdoutBytes).toBe(FLOOD_BYTES);
      expect(result.stdoutDroppedBytes).toBe(dropped);
      expect(result.stdout.startsWith("aaaa")).toBe(true);
      expect(result.stdout.endsWith("\nTAIL\n")).toBe(true);
      expect(result.stdout).toContain(`\n${marker(dropped)}`);
      expect(Buffer.byteLength(result.stdout)).toBe(
        65_536 + 1 + Buffer.byteLength(marker(dropped)),
      );
      if (streaming) {
        // Only the kept start is streamed live, then one notice.
        const streamed = chunks.join("");
        expect(streamed.startsWith("a".repeat(32_768))).toBe(true);
        expect(streamed.slice(32_768)).toBe(
          "\n[stdout truncated: output past 32768 bytes is not streamed]\n",
        );
      }
    }, 20_000);
  }

  test("with no cap given, the sandbox default (1 MiB per stream) applies", async () => {
    const result = await createSandbox({ backend: "noop" }).exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", FLOOD],
    });
    expect(SANDBOX_DEFAULT_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
    expect(result.stdoutDroppedBytes).toBe(FLOOD_BYTES - SANDBOX_DEFAULT_MAX_OUTPUT_BYTES);
    expect(result.stdout.endsWith("TAIL\n")).toBe(true);
  }, 20_000);

  test("a sandbox-level cap applies to every call, and a call can set its own", async () => {
    const sandbox = createSandbox({ backend: "noop", maxOutputBytes: 1_000 });
    const byDefault = await sandbox.exec({ image: "alpine:3.19", argv: ["sh", "-c", FLOOD] });
    expect(byDefault.stdoutDroppedBytes).toBe(FLOOD_BYTES - 1_000);
    const perCall = await sandbox.exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", FLOOD],
      maxOutputBytes: 2_000,
    });
    expect(perCall.stdoutDroppedBytes).toBe(FLOOD_BYTES - 2_000);
  }, 20_000);

  test("stderr has its own cap, and output that fits is untouched", async () => {
    const result = await createSandbox({ backend: "noop" }).exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "head -c 200000 /dev/zero | tr '\\0' e >&2; printf out"],
      maxOutputBytes: 1_000,
    });
    expect(result.stdout).toBe("out");
    expect(result.stdoutDroppedBytes).toBe(0);
    expect(result.stderrBytes).toBe(200_000);
    expect(result.stderrDroppedBytes).toBe(199_000);
    expect(result.stderr).toContain("[stderr truncated: 199000 bytes dropped]");
  }, 20_000);

  test("a cap that falls inside a multi-byte character leaves no replacement character", async () => {
    // 100 000 × "€" (3 bytes each); an odd cap puts both cuts mid-character.
    const result = await createSandbox({ backend: "noop" }).exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "head -c 100000 /dev/zero | tr '\\0' x | sed 's/x/€/g' | tr -d '\\n'"],
      maxOutputBytes: 1_001,
    });
    expect(result.stdoutBytes).toBe(300_000);
    expect(result.stdout).not.toContain("�");
    const dropped = result.stdoutDroppedBytes ?? 0;
    // The marker sits on a line of its own between the kept start and end.
    const line = `\n${marker(dropped)}`;
    expect(result.stdout).toContain(`€${line}€`);
    const kept = Buffer.byteLength(result.stdout) - Buffer.byteLength(line);
    // Every byte is either in the text or counted as dropped.
    expect(kept + dropped).toBe(300_000);
    expect(kept).toBeLessThanOrEqual(1_001);
  }, 20_000);

  test("binary output past the cap never reports fewer dropped bytes than were not kept", async () => {
    // 0xFF is not UTF-8: each kept byte decodes to a 3-byte replacement
    // character, so a count taken from the text alone came out negative.
    const result = await createSandbox({ backend: "noop" }).exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "head -c 100000 /dev/zero | tr '\\0' '\\377'"],
      maxOutputBytes: 1_000,
    });
    expect(result.stdoutBytes).toBe(100_000);
    expect(result.stdoutDroppedBytes).toBe(99_000);
  }, 20_000);

  test("a live consumer that throws does not stop the run", async () => {
    const result = await createSandbox({ backend: "noop" }).exec({
      image: "alpine:3.19",
      argv: ["printf", "fine"],
      onStdoutChunk: () => {
        throw new Error("consumer broke");
      },
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "fine" });
  });

  test("a cap or a timeout that is not a number is refused, not obeyed", async () => {
    const sandbox = createSandbox({ backend: "noop" });
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      await expect(
        sandbox.exec({ image: "alpine:3.19", argv: ["true"], maxOutputBytes: bad }),
      ).rejects.toThrow(/maxOutputBytes must be/);
    }
    for (const bad of [Number.NaN, 0, -5]) {
      await expect(
        sandbox.exec({ image: "alpine:3.19", argv: ["true"], timeoutMs: bad }),
      ).rejects.toThrow(/timeoutMs must be/);
    }
    expect(() => createSandbox({ backend: "docker", maxOutputBytes: Number.NaN })).toThrow(
      SandboxError,
    );
  });
});

// The real thing, where a docker daemon and the image are already here. It
// never pulls: without alpine:3.19 locally the block is skipped.
function dockerReady(): boolean {
  if (!posix) return false;
  try {
    const info = Bun.spawnSync(["docker", "image", "inspect", "alpine:3.19"], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5_000,
    });
    return info.exitCode === 0;
  } catch {
    return false;
  }
}

describe.if(dockerReady())("docker backend against a real daemon", () => {
  let names: string[] = [];
  let spawnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    resetEnv();
    names = [];
    const orig = Bun.spawn.bind(Bun);
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
      argv: readonly string[],
      options: Record<string, unknown>,
    ) => {
      const at = argv.indexOf("--name");
      if (argv[1] === "create" && at > 0) names.push(argv[at + 1] as string);
      return orig([...argv], options);
      // biome-ignore lint/suspicious/noExplicitAny: pass-through spy on Bun.spawn
    }) as any);
  });
  afterEach(() => {
    spawnSpy?.mockRestore();
    for (const name of names) {
      Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
    }
    killReapersFor(names);
    resetEnv();
  });

  function left(name: string): string {
    const ps = Bun.spawnSync(["docker", "ps", "-a", "-q", "--filter", `name=^/${name}$`], {
      timeout: 10_000,
    });
    return new TextDecoder().decode(ps.stdout).trim();
  }

  test("a busy loop is stopped at the timeout and no container is left", async () => {
    const t0 = performance.now();
    const result = await createSandbox({ backend: "docker" }).exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "echo started; while :; do :; done"],
      timeoutMs: 2_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("started\n");
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(names).toHaveLength(1);
    expect(left(names[0] as string)).toBe("");
  }, 30_000);

  test("an abort stops the container and no container is left", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2_000);
    const result = await createSandbox({ backend: "docker" }).exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "sleep 60"],
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(left(names[0] as string)).toBe("");
  }, 30_000);

  // C012: aborts and short timeouts that land while the container is still
  // being created left it behind (Created, or started after the call
  // returned). Every stop point from "at once" to "running" leaves nothing.
  test("stops at every point of the create leave no container, then or later", async () => {
    const sandbox = createSandbox({ backend: "docker" });
    for (const ms of [0, 5, 10, 20, 40, 80, 120, 160, 200, 300]) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      const r = await sandbox.exec({
        image: "alpine:3.19",
        argv: ["sh", "-c", "while :; do :; done"],
        signal: controller.signal,
      });
      expect(r.aborted).toBe(true);
      expect(r.strayContainer).toBeUndefined();
    }
    for (const timeoutMs of [50, 100, 150, 250]) {
      const r = await sandbox.exec({
        image: "alpine:3.19",
        argv: ["sh", "-c", "while :; do :; done"],
        timeoutMs,
      });
      expect(r.timedOut).toBe(true);
      expect(r.strayContainer).toBeUndefined();
    }
    expect(names).toHaveLength(14);
    expect(names.filter((n) => left(n) !== "")).toEqual([]);
    await Bun.sleep(3_000);
    expect(names.filter((n) => left(n) !== "")).toEqual([]);
  }, 120_000);

  /** The containers, running or not, whose command carries `token`. */
  function withToken(token: string): string[] {
    const ps = Bun.spawnSync(
      ["docker", "ps", "-a", "--no-trunc", "--format", "{{.Names}} {{.Command}}"],
      { timeout: 10_000 },
    );
    return new TextDecoder()
      .decode(ps.stdout)
      .split("\n")
      .filter((l) => l.includes(token))
      .map((l) => l.split(" ")[0] as string);
  }

  /**
   * A host process that starts a busy loop in a container and says so once
   * the loop runs. `exit`: it then calls process.exit. `wait`: it waits for
   * the test to kill it.
   */
  function busyHost(mode: "exit" | "wait", token: string, timeoutMs: number) {
    const script = join(tmpdir(), `sandbox-live-host-${token}.ts`);
    writeFileSync(
      script,
      [
        `import { createSandbox } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};`,
        "await createSandbox({ backend: 'docker' }).exec({",
        "  image: 'alpine:3.19',",
        `  argv: ['sh', '-c', ${JSON.stringify(`echo started; : ${token}; while :; do :; done`)}],`,
        `  timeoutMs: ${timeoutMs},`,
        "  onStdoutChunk: (c) => {",
        "    if (!c.includes('started')) return;",
        "    console.log('running');",
        `    if (${JSON.stringify(mode)} === 'exit') process.exit(0);`,
        "  },",
        "});",
      ].join("\n"),
    );
    const h = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore" });
    const running = (async () => {
      const reader = (h.stdout as ReadableStream<Uint8Array>).getReader();
      let seen = "";
      while (!seen.includes("running")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      rmSync(script, { force: true });
    })();
    return { h, running };
  }

  test("a host that exits mid-run leaves no container behind", async () => {
    const token = `exit-${randomUUID()}`;
    const { h, running } = busyHost("exit", token, 120_000);
    try {
      await running;
      await h.exited;
      expect(h.exitCode).toBe(0);
      expect(withToken(token)).toEqual([]);
    } finally {
      for (const name of withToken(token)) names.push(name);
    }
  }, 60_000);

  // Nothing on the host can run after a SIGKILL: the CPU-time limit inside
  // the container is what ends the loop (1 s timeout → 11 s of CPU).
  test("a host killed outright: the kernel ends the orphaned busy loop", async () => {
    const token = `sigkill-${randomUUID()}`;
    const { h, running } = busyHost("wait", token, 1_000);
    try {
      await running;
      h.kill("SIGKILL");
      await h.exited;
      expect(withToken(token)).toHaveLength(1);
      const until = performance.now() + 45_000;
      while (withToken(token).length > 0 && performance.now() < until) await Bun.sleep(500);
      expect(withToken(token)).toEqual([]);
    } finally {
      for (const name of withToken(token)) names.push(name);
    }
  }, 60_000);

  test("a flood from the container is capped on the host", async () => {
    const result = await createSandbox({ backend: "docker" }).exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", FLOOD_IN_CONTAINER],
      maxOutputBytes: 65_536,
    });
    expect(result.stdoutBytes).toBe(3_000_006);
    expect(result.stdoutDroppedBytes).toBe(3_000_006 - 65_536);
    expect(result.stdout.endsWith("TAIL\n")).toBe(true);
  }, 30_000);

  test("stdin, exit status and both streams come through create and start", async () => {
    const result = await createSandbox({ backend: "docker" }).exec({
      image: "alpine:3.19",
      argv: ["sh", "-c", "cat; echo err >&2; exit 7"],
      stdin: "payload",
    });
    expect(result).toMatchObject({ exitCode: 7, stdout: "payload", stderr: "err\n" });
    expect(left(names[0] as string)).toBe("");
  }, 30_000);
});

const FLOOD_IN_CONTAINER = "head -c 3000000 /dev/zero | tr '\\0' a; echo; echo TAIL";

describe("one reading of CREWHAUS_SANDBOX (security-6#1)", () => {
  beforeEach(() => {
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
  });

  // The floor and the backend used to read the variable two ways: the floor
  // compared it untrimmed, createSandbox trimmed it. `noop ` or a CRLF `.env`'s
  // `noop\r` then told the floor a sandbox existed while the noop backend ran
  // the code on the host.
  const values = [
    "noop",
    " noop",
    "noop ",
    "noop\r",
    "NOOP",
    "\tNoOp\n",
    "docker",
    " Docker ",
    "podman\r",
    "",
    "   ",
    "vagrant",
    "no op",
  ];

  test("the floor says 'sandboxed' exactly when createSandbox would build a real container backend", () => {
    let real = 0;
    let refused = 0;
    for (const value of values) {
      process.env["CREWHAUS_SANDBOX"] = value;
      const floor = sandboxAvailableFromEnv();
      let backend: string;
      try {
        backend = createSandbox().backend;
      } catch (err) {
        // A value naming no backend: createSandbox refuses, and the floor
        // must not call that a sandbox either.
        expect(err).toBeInstanceOf(SandboxError);
        backend = "refused";
        refused++;
      }
      expect({ value, floor }).toEqual({
        value,
        floor: backend === "docker" || backend === "podman",
      });
      if (floor) real++;
    }
    // Both answers occur, so the agreement is not vacuous.
    expect(real).toBe(5);
    expect(refused).toBe(2);
  });

  test("resolveSandboxBackend trims, lower-cases, and says when a value names nothing", () => {
    expect(resolveSandboxBackend({ CREWHAUS_SANDBOX: "noop\r" })).toEqual({
      ok: true,
      backend: "noop",
      fromEnv: true,
    });
    expect(resolveSandboxBackend({})).toEqual({ ok: true, backend: "docker", fromEnv: false });
    expect(resolveSandboxBackend({ CREWHAUS_SANDBOX: "vagrant" })).toEqual({
      ok: false,
      reason:
        'CREWHAUS_SANDBOX="vagrant" is not a sandbox backend. Set it to docker or podman to run code in a container, or noop to turn code execution off.',
    });
  });
});
