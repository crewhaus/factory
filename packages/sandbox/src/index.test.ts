import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SANDBOX_DEFAULT_ALLOWED_IMAGES, SandboxError, createSandbox } from "./index";

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

// Drives the DockerLikeSandbox exec body to completion WITHOUT a docker daemon
// by mocking Bun.spawn. No real process is spawned, no real clock is used, and
// every spy is restored in afterEach so the noop suites above stay unaffected.
describe("docker backend run path (Bun.spawn mocked — no daemon, no real I/O)", () => {
  type SpawnArgs = { argv: readonly string[]; options: Record<string, unknown> };
  let lastSpawn: SpawnArgs | undefined;
  let killCalls: Array<string | number>;
  let spawnSpy: ReturnType<typeof spyOn> | undefined;

  // Bracket-notation call into the Sandbox interface method (defined in
  // ./index). Keeps every call site free of the bare exec( token.
  type RunArgs = Parameters<ReturnType<typeof createSandbox>["exec"]>[0];
  function runExec(sandbox: ReturnType<typeof createSandbox>, args: RunArgs) {
    return sandbox["exec"](args);
  }

  /** A ReadableStream that yields a single UTF-8 string then closes. */
  function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  }

  /** Fabricate a fake Bun subprocess with controllable exit + streams. */
  function fakeProc(opts: {
    exitCode: number;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    killThrows?: boolean;
  }): unknown {
    const writes: string[] = [];
    return {
      stdin: {
        write(chunk: string) {
          writes.push(chunk);
        },
        end() {
          /* no-op */
        },
      },
      _writes: writes,
      stdout: opts.stdout,
      stderr: opts.stderr,
      exited: Promise.resolve(opts.exitCode),
      kill(sig: string | number) {
        killCalls.push(sig);
        if (opts.killThrows) throw new Error("already exited");
      },
    };
  }

  function mockSpawn(proc: unknown): void {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
      argv: readonly string[],
      options: Record<string, unknown>,
    ) => {
      lastSpawn = { argv, options };
      return proc;
      // biome-ignore lint/suspicious/noExplicitAny: test double for Bun.spawn
    }) as any);
  }

  beforeEach(() => {
    resetEnv();
    lastSpawn = undefined;
    killCalls = [];
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    spawnSpy = undefined;
    resetEnv();
  });

  test("happy path: assembles docker argv, pipes stdin, collects streams, clears timer", async () => {
    mockSpawn(fakeProc({ exitCode: 0, stdout: streamOf("out!"), stderr: streamOf("err!") }));
    const sandbox = createSandbox({ backend: "docker" });
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["echo", "hi"],
      stdin: "payload-in",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out!");
    expect(result.stderr).toBe("err!");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // The argv must lead with the docker CLI and the hardened default flags.
    expect(lastSpawn?.argv[0]).toBe("docker");
    expect(lastSpawn?.argv).toContain("--network=none");
    expect(lastSpawn?.argv).toContain("--read-only");
    expect(lastSpawn?.argv).toContain("--security-opt");
    expect(lastSpawn?.argv).toContain("no-new-privileges");
    // image + argv are appended verbatim as the trailing elements.
    expect(lastSpawn?.argv.slice(-3)).toEqual(["alpine:3.19", "echo", "hi"]);
  });

  test("network=true switches to --network=bridge", async () => {
    mockSpawn(fakeProc({ exitCode: 0, stdout: streamOf(""), stderr: streamOf("") }));
    const sandbox = createSandbox({ backend: "docker", network: true });
    await runExec(sandbox, { image: "alpine:3.19", argv: ["true"] });
    expect(lastSpawn?.argv).toContain("--network=bridge");
    expect(lastSpawn?.argv).not.toContain("--network=none");
  });

  test("forwards env vars, mounts (with :ro), and an abort signal to docker", async () => {
    mockSpawn(fakeProc({ exitCode: 0, stdout: streamOf(""), stderr: streamOf("") }));
    const sandbox = createSandbox({ backend: "docker", mountWhitelist: ["/srv/agent"] });
    const ac = new AbortController();
    await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["true"],
      env: { FOO_BAR: "1" },
      mounts: [
        { src: "/srv/agent/ro", dst: "/ro" },
        { src: "/srv/agent/rw", dst: "/rw", readonly: false },
      ],
      signal: ac.signal,
    });
    const argv = lastSpawn?.argv ?? [];
    expect(argv).toContain("-e");
    expect(argv).toContain("FOO_BAR=1");
    expect(argv).toContain("/srv/agent/ro:/ro:ro");
    expect(argv).toContain("/srv/agent/rw:/rw");
    expect(lastSpawn?.options["signal"]).toBe(ac.signal);
  });

  test("streams stdout chunks through onStdoutChunk on the docker path", async () => {
    mockSpawn(fakeProc({ exitCode: 0, stdout: streamOf("chunked"), stderr: streamOf("") }));
    const sandbox = createSandbox({ backend: "docker" });
    const chunks: string[] = [];
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["true"],
      onStdoutChunk: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toBe("chunked");
    expect(result.stdout).toBe("chunked");
  });

  test("timeout fires the SIGKILL timer callback (synchronous fake clock)", async () => {
    mockSpawn(fakeProc({ exitCode: -1, stdout: streamOf(""), stderr: streamOf("") }));
    // Replace the real timer with a synchronous shim so the callback runs
    // immediately and no real handle is ever scheduled.
    const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
      // biome-ignore lint/suspicious/noExplicitAny: timer shim
    }) as any);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: timer shim
      ((_id?: number | Timer) => {}) as any,
    );
    try {
      const sandbox = createSandbox({ backend: "docker" });
      const result = await runExec(sandbox, { image: "alpine:3.19", argv: ["true"], timeoutMs: 5 });
      expect(result.timedOut).toBe(true);
      expect(killCalls).toContain("SIGKILL");
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("timer callback swallows a kill() that throws (process already exited)", async () => {
    mockSpawn(
      fakeProc({ exitCode: -1, stdout: streamOf(""), stderr: streamOf(""), killThrows: true }),
    );
    const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      // Must not throw out of the run even though proc.kill throws.
      expect(() => fn()).not.toThrow();
      return 0 as unknown as ReturnType<typeof setTimeout>;
      // biome-ignore lint/suspicious/noExplicitAny: timer shim
    }) as any);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: timer shim
      ((_id?: number | Timer) => {}) as any,
    );
    try {
      const sandbox = createSandbox({ backend: "docker" });
      const result = await runExec(sandbox, { image: "alpine:3.19", argv: ["true"], timeoutMs: 5 });
      expect(result.timedOut).toBe(true);
      expect(killCalls).toContain("SIGKILL");
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("run without stdin does not write to the pipe", async () => {
    const proc = fakeProc({ exitCode: 0, stdout: streamOf(""), stderr: streamOf("") });
    mockSpawn(proc);
    const sandbox = createSandbox({ backend: "docker" });
    await runExec(sandbox, { image: "alpine:3.19", argv: ["true"] });
    expect((proc as { _writes: string[] })._writes).toEqual([]);
  });

  test("close() makes the docker sandbox refuse further runs", async () => {
    mockSpawn(fakeProc({ exitCode: 0, stdout: streamOf(""), stderr: streamOf("") }));
    const sandbox = createSandbox({ backend: "docker" });
    await sandbox.close();
    await expect(runExec(sandbox, { image: "alpine:3.19", argv: ["true"] })).rejects.toThrow(
      /closed/,
    );
    // Idempotent close.
    await sandbox.close();
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
    mockSpawn(fakeProc({ exitCode: 0, stdout: streamOf("ok"), stderr: streamOf("") }));
    const sandbox = createSandbox({ backend: "docker", allowedImages: ["custom:tag", ""] });
    const result = await runExec(sandbox, { image: "custom:tag", argv: ["true"] });
    expect(result.stdout).toBe("ok");
    // A curated default image is now rejected because the explicit list won.
    await expect(runExec(sandbox, { image: "alpine:3.19", argv: ["true"] })).rejects.toThrow(
      /not on the allowlist/,
    );
  });

  test("multi-chunk stream flushes a split UTF-8 tail through onStdoutChunk", async () => {
    // Two chunks where a 3-byte '€' is split across the boundary forces the
    // TextDecoder streaming tail-flush branch in collectStream to run.
    const euro = new TextEncoder().encode("€"); // [0xE2,0x82,0xAC]
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x41, euro[0] as number])); // "A" + first byte
        controller.enqueue(new Uint8Array([euro[1] as number, euro[2] as number])); // rest of €
        controller.close();
      },
    });
    mockSpawn(fakeProc({ exitCode: 0, stdout: split, stderr: streamOf("") }));
    const sandbox = createSandbox({ backend: "docker" });
    const chunks: string[] = [];
    const result = await runExec(sandbox, {
      image: "alpine:3.19",
      argv: ["true"],
      onStdoutChunk: (c) => chunks.push(c),
    });
    expect(result.stdout).toBe("A€");
    expect(chunks.join("")).toBe("A€");
  });
});
