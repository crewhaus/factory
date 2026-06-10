/**
 * Coverage for the default `child_process`-backed build runner.
 *
 * Every other test injects a fake `runner`, so the real `defaultRunner`
 * (which spawns `bun build --compile`) is never exercised. Here we drive it
 * by calling `buildBinary` WITHOUT a runner and mocking `node:child_process`
 * so `spawn` returns a fake child emitter — no real process, no real timers.
 *
 * The fake child fires its stdout/stderr/close|error listeners on a
 * microtask (queueMicrotask), which is deterministic and needs no fake clock.
 * NOTE: `mock.restore()` does NOT undo `mock.module`, and Bun shares one
 * module registry across all test files (nondeterministic order) — the
 * `afterAll` below reinstalls the real `node:child_process` so the per-test
 * spawn fakes can't leak into the sibling suite.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { SingleBinaryError, buildBinary } from "./index";

// Captured before any mock.module call so afterAll can reinstall the real module.
const realChildProcess = require("node:child_process") as typeof import("node:child_process");

afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
});

type FakeOpts = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number | null;
  readonly emitError?: Error;
};

function fakeChild(opts: FakeOpts): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // Emit after the caller has attached its listeners (next microtask).
  queueMicrotask(() => {
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout, "utf8"));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr, "utf8"));
    if (opts.emitError) {
      child.emit("error", opts.emitError);
    } else {
      // Emit the code verbatim — including an explicit `null` — so the
      // `code ?? 1` branch in defaultRunner is exercised, not masked here.
      child.emit("close", opts.code === undefined ? 0 : opts.code);
    }
  });
  return child;
}

describe("defaultRunner (real child_process path, mocked spawn)", () => {
  afterEach(() => mock.restore());

  test("spawns `bun` with the compile argv and resolves on clean exit", async () => {
    let captured: { head?: string; rest?: string[]; cwd?: string } = {};
    mock.module("node:child_process", () => ({
      spawn: (head: string, rest: string[], optsArg: { cwd: string }) => {
        captured = { head, rest, cwd: optsArg.cwd };
        return fakeChild({ stdout: "compiled ok", code: 0 });
      },
    }));

    const result = await buildBinary({
      target: { platform: "linux", arch: "x64" },
      version: "9.9.9",
      outDir: "/tmp/sbc-runner-dist",
    });

    expect(captured.head).toBe("bun");
    expect(captured.rest).toContain("build");
    expect(captured.rest).toContain("--compile");
    expect(captured.rest).toContain("bun-linux-x64");
    // cwd is REPO_ROOT (two levels above the package).
    expect(captured.cwd).toMatch(/factory$/);
    expect(result.outPath).toBe("/tmp/sbc-runner-dist/crewhaus-linux-x64-9.9.9");
    expect(result.buildArgv[0]).toBe("bun");
  });

  test("accumulates multiple stdout/stderr chunks before close", async () => {
    mock.module("node:child_process", () => ({
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("part1-", "utf8"));
          child.stdout.emit("data", Buffer.from("part2", "utf8"));
          child.stderr.emit("data", Buffer.from("warn", "utf8"));
          child.emit("close", 0);
        });
        return child;
      },
    }));
    // exit 0 → resolves; the multi-chunk buffers exercise the data handlers.
    const result = await buildBinary({
      target: { platform: "macos", arch: "x64" },
      outDir: "/tmp/sbc-runner-dist",
    });
    expect(result.target.platform).toBe("macos");
  });

  test("non-zero exit code surfaces stderr in a SingleBinaryError", async () => {
    mock.module("node:child_process", () => ({
      spawn: () => fakeChild({ stderr: "bun: compile failed", code: 7 }),
    }));
    await expect(
      buildBinary({ target: { platform: "macos", arch: "arm64" }, outDir: "/tmp/sbc-runner-dist" }),
    ).rejects.toThrow(/exited with 7: bun: compile failed/);
  });

  test("a null exit code is treated as failure (exitCode 1)", async () => {
    mock.module("node:child_process", () => ({
      spawn: () => fakeChild({ stderr: "killed", code: null }),
    }));
    await expect(
      buildBinary({ target: { platform: "windows", arch: "x64" }, outDir: "/tmp/sbc-runner-dist" }),
    ).rejects.toBeInstanceOf(SingleBinaryError);
  });

  test("a spawn `error` event resolves to exitCode 1 → SingleBinaryError", async () => {
    mock.module("node:child_process", () => ({
      spawn: () => fakeChild({ emitError: new Error("spawn ENOENT: bun not on PATH") }),
    }));
    await expect(
      buildBinary({ target: { platform: "linux", arch: "arm64" }, outDir: "/tmp/sbc-runner-dist" }),
    ).rejects.toThrow(/spawn ENOENT: bun not on PATH/);
  });
});
