/**
 * Every tool this package registers, exercised against a real world.
 *
 * These tools spawn real processes, open real sockets and watch real files,
 * so the tests do too: a mocked process proves nothing about whether the
 * arguments we hand the OS are right. Each test runs inside its own temp
 * directory — `process.chdir` makes that directory the workspace root, which
 * is also what gives the containment assertions something to escape from —
 * and removes it afterwards. Nothing is ever written into the repo.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  PROC_TOOLS,
  __resetRegistryForTest,
  commandExists,
  envInspect,
  processList,
  processOutput,
  processStart,
  processStatus,
  processStop,
  retry,
  runCommand,
  runPipeline,
  waitForFile,
  waitForOutput,
  waitForPort,
} from "./index";

let originalCwd: string;
let tmp: string;
let outside: string;

beforeEach(() => {
  originalCwd = process.cwd();
  // realpath because macOS /var is a symlink to /private/var, and the
  // containment check compares real paths.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-proc-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-proc-outside-")));
  process.chdir(tmp);
  __resetRegistryForTest();
});

afterEach(() => {
  __resetRegistryForTest();
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Tools return compact JSON on success and a plain string on a refusal. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function call(tool: RegisteredTool, input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/** Write an executable shell script into the temp workspace. */
function script(name: string, body: string): string {
  const file = join(tmp, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

// ---------------------------------------------------------------------------

describe("package-wide contract", () => {
  /**
   * The safety flags are the part of a tool the runtime trusts without
   * reading the code, so they are asserted per tool rather than in a loop
   * that could pass vacuously.
   */
  const EXPECTED: Record<
    string,
    {
      readOnly: boolean;
      destructive: boolean;
      concurrencySafe: boolean;
      scope: string;
      io: string | undefined;
    }
  > = {
    RunCommand: {
      readOnly: false,
      destructive: true,
      concurrencySafe: false,
      scope: "external",
      io: "process",
    },
    RunPipeline: {
      readOnly: false,
      destructive: true,
      concurrencySafe: false,
      scope: "external",
      io: "process",
    },
    Retry: {
      readOnly: false,
      destructive: true,
      concurrencySafe: false,
      scope: "external",
      io: "process",
    },
    ProcessStart: {
      readOnly: false,
      destructive: true,
      concurrencySafe: false,
      scope: "external",
      io: "process",
    },
    ProcessStop: {
      readOnly: false,
      destructive: true,
      concurrencySafe: false,
      scope: "external",
      io: "process",
    },
    ProcessOutput: {
      readOnly: false,
      destructive: false,
      concurrencySafe: false,
      scope: "internal",
      io: undefined,
    },
    ProcessStatus: {
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      scope: "internal",
      io: undefined,
    },
    ProcessList: {
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      scope: "internal",
      io: undefined,
    },
    WaitForPort: {
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      scope: "external",
      io: "network",
    },
    WaitForFile: {
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      scope: "internal",
      io: undefined,
    },
    WaitForOutput: {
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      scope: "internal",
      io: undefined,
    },
    CommandExists: {
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      scope: "internal",
      io: undefined,
    },
    EnvInspect: {
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      scope: "internal",
      io: undefined,
    },
  };

  test("PROC_TOOLS holds every tool, once", () => {
    expect(PROC_TOOLS.length).toBe(13);
    const names = PROC_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.slice().sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test("the array is frozen, so a consumer cannot mutate the catalog", () => {
    expect(Object.isFrozen(PROC_TOOLS)).toBe(true);
  });

  test("every name is PascalCase", () => {
    for (const t of PROC_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("each tool carries exactly the flags its behaviour earns", () => {
    for (const t of PROC_TOOLS) {
      expect({ name: t.name, ...EXPECTED[t.name] }).toEqual({
        name: t.name,
        readOnly: t.readOnly,
        destructive: t.destructive,
        concurrencySafe: t.concurrencySafe,
        scope: t.scope,
        io: t.ioCapability,
      });
    }
  });

  test("everything that spawns a process declares it", () => {
    for (const t of PROC_TOOLS) {
      if (t.ioCapability !== undefined)
        expect({ n: t.name, s: t.scope }).toEqual({ n: t.name, s: "external" });
    }
  });

  /**
   * The check above only runs on tools that already declare a capability, so
   * a tool that declares nothing passes it for free — which is precisely the
   * failure it is meant to catch. This names the tools that touch an OS
   * process and requires the declaration from them.
   */
  test("every tool that touches an OS process declares the process capability", () => {
    const touchesAProcess = ["RunCommand", "RunPipeline", "Retry", "ProcessStart", "ProcessStop"];
    for (const name of touchesAProcess) {
      const t = PROC_TOOLS.find((x) => x.name === name);
      expect({ name, io: t?.ioCapability, scope: t?.scope }).toEqual({
        name,
        io: "process",
        scope: "external",
      });
    }
  });

  /**
   * The permission engine auto-allows a read-only tool, so a mislabelled one
   * is a silent grant rather than a visible bug.
   */
  test("nothing that changes the world outside this process claims to be read-only", () => {
    for (const t of PROC_TOOLS) {
      if (t.ioCapability === "process")
        expect({ n: t.name, ro: t.readOnly, d: t.destructive }).toEqual({
          n: t.name,
          ro: false,
          d: true,
        });
    }
  });

  test("no tool claims to be both read-only and destructive", () => {
    for (const t of PROC_TOOLS) expect(t.readOnly && t.destructive).toBe(false);
  });

  test("nothing here runs untrusted code, so nothing requires the sandbox", () => {
    for (const t of PROC_TOOLS)
      expect({ n: t.name, s: t.requiresSandbox }).toEqual({ n: t.name, s: false });
  });

  test("every description says what the tool is for, in a second sentence", () => {
    for (const t of PROC_TOOLS) {
      expect(t.description.length).toBeGreaterThan(60);
      expect(t.description).toMatch(/\.\s+Use /);
    }
  });

  test("every waiting tool requires a deadline — it cannot be omitted", async () => {
    for (const t of [waitForPort, waitForFile, waitForOutput]) {
      const parsed = t.inputSchema.safeParse(
        t.name === "WaitForPort"
          ? { port: 1 }
          : t.name === "WaitForFile"
            ? { path: "x" }
            : { id: "proc_1", pattern: "x" },
      );
      expect({ name: t.name, ok: parsed.success }).toEqual({ name: t.name, ok: false });
    }
  });
});

// ---------------------------------------------------------------------------

describe("RunCommand", () => {
  test("runs a program and reports stdout and the exit code", async () => {
    const out = await call(runCommand, { argv: ["echo", "hello"] });
    expect(out.exitCode).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.stdout.trim()).toBe("hello");
    expect(out.timedOut).toBe(false);
  });

  test("a non-zero exit is data, not an error", async () => {
    const out = await call(runCommand, { argv: ["false"] });
    expect(out.exitCode).toBe(1);
    expect(out.ok).toBe(false);
  });

  test("argv is passed as an array, so shell syntax in an argument stays literal", async () => {
    const out = await call(runCommand, { argv: ["echo", "$(id -u); rm -rf /"] });
    expect(out.stdout.trim()).toBe("$(id -u); rm -rf /");
  });

  test("stdin is delivered to the process", async () => {
    const out = await call(runCommand, { argv: ["cat"], stdin: "piped in" });
    expect(out.stdout).toBe("piped in");
  });

  test("a command that reads stdin without being given any does not hang", async () => {
    const out = await call(runCommand, { argv: ["cat"], timeoutMs: 5_000 });
    expect(out.timedOut).toBe(false);
    expect(out.stdout).toBe("");
  });

  test("stderr is captured separately", async () => {
    const path = script("noisy.sh", "echo out; echo err >&2; exit 2");
    const out = await call(runCommand, { argv: [path] });
    expect(out.stdout.trim()).toBe("out");
    expect(out.stderr.trim()).toBe("err");
    expect(out.exitCode).toBe(2);
  });

  test("a command that outruns its timeout is killed and reported", async () => {
    const started = Date.now();
    const out = await call(runCommand, { argv: ["sleep", "30"], timeoutMs: 200 });
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).not.toBe(0);
    // The point of the timeout is that the call returns: 30s would fail here.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  /**
   * The SIGTERM at the deadline is only half the promise: a child that traps
   * it must still die. This asserts the SIGKILL escalation really happens, by
   * running a script that ignores TERM and would otherwise loop forever.
   */
  test("a command that ignores SIGTERM is SIGKILLed after the grace period", async () => {
    const path = script("deaf.sh", 'trap "" TERM\nwhile true; do sleep 0.05; done');
    const started = Date.now();
    const out = await call(runCommand, { argv: [path], timeoutMs: 200 });
    const elapsed = Date.now() - started;
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).not.toBe(0);
    // SIGTERM at 200ms, SIGKILL 2s later: it must land well inside that, and
    // emphatically not run to the end of a `while true`.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(8_000);
  });

  /**
   * A grandchild inherits the pipe, so reading stdout to EOF can outlive the
   * process that was actually being run. The drain window is what stops that
   * from becoming an unbounded wait.
   */
  test("a grandchild holding the pipe open does not hold the call open", async () => {
    const path = script("forker.sh", "sleep 20 &\necho parent done");
    const started = Date.now();
    const out = await call(runCommand, { argv: [path], timeoutMs: 30_000 });
    const elapsed = Date.now() - started;
    expect(out.exitCode).toBe(0);
    expect(out.timedOut).toBe(false);
    // The grandchild sleeps 20s; returning in anything under that proves the
    // drain gave up rather than waiting for EOF.
    expect(elapsed).toBeLessThan(10_000);
  });

  test("output over the cap is truncated at both ends rather than dropped or unbounded", async () => {
    const out = await call(runCommand, { argv: ["seq", "1", "5000"], maxOutputChars: 200 });
    expect(out.stdoutTruncated).toBe(true);
    expect(out.stdout).toContain("chars dropped");
    expect(out.stdout.startsWith("1\n2\n")).toBe(true);
    expect(out.stdout.trimEnd().endsWith("5000")).toBe(true);
  });

  test("a program that does not exist is reported, not thrown", async () => {
    const out = await call(runCommand, { argv: ["crewhaus-no-such-binary-xyz"] });
    expect(out.spawnError).toBeDefined();
    expect(out.ok).toBe(false);
  });

  test("the child inherits nothing it was not given", async () => {
    process.env["TOOL_PROC_FAKE_SECRET"] = "s3cr3t-value";
    try {
      const sealed = await call(runCommand, { argv: ["env"] });
      expect(sealed.stdout).not.toContain("TOOL_PROC_FAKE_SECRET");
      expect(sealed.stdout).toContain("LC_ALL=C");
      const forwarded = await call(runCommand, {
        argv: ["env"],
        env: ["TOOL_PROC_FAKE_SECRET"],
      });
      expect(forwarded.stdout).toContain("TOOL_PROC_FAKE_SECRET=s3cr3t-value");
    } finally {
      // Reflect.deleteProperty rather than `delete`: assigning undefined
      // would leave the name set to the string "undefined".
      Reflect.deleteProperty(process.env, "TOOL_PROC_FAKE_SECRET");
    }
  });

  test("envSet supplies a literal value", async () => {
    const out = await call(runCommand, { argv: ["env"], envSet: { GREETING: "hi" } });
    expect(out.stdout).toContain("GREETING=hi");
  });

  test("a forwarded name the harness does not define is reported", async () => {
    const out = await call(runCommand, { argv: ["true"], env: ["CREWHAUS_NOT_SET_ANYWHERE"] });
    expect(out.envNotSet).toEqual(["CREWHAUS_NOT_SET_ANYWHERE"]);
  });

  test("a subdirectory is a legitimate cwd", async () => {
    mkdirSync(join(tmp, "sub"));
    writeFileSync(join(tmp, "sub", "marker.txt"), "x");
    const out = await call(runCommand, { argv: ["ls"], cwd: "sub" });
    expect(out.stdout.trim()).toBe("marker.txt");
  });

  test("a cwd above the workspace root is refused", async () => {
    const out = await call(runCommand, { argv: ["pwd"], cwd: ".." });
    expect(typeof out).toBe("string");
    expect(out).toContain("refused path");
  });

  test("an absolute cwd outside the workspace is refused", async () => {
    const out = await call(runCommand, { argv: ["pwd"], cwd: outside });
    expect(out).toContain("refused path");
  });

  test("a symlink pointing out of the workspace is refused too", async () => {
    symlinkSync(outside, join(tmp, "escape-hatch"));
    const out = await call(runCommand, { argv: ["pwd"], cwd: "escape-hatch" });
    expect(out).toContain("refused path");
  });

  test("an empty program name is refused before anything is spawned", async () => {
    expect(await call(runCommand, { argv: ["  "] })).toContain("argv[0] must name a program");
  });
});

// ---------------------------------------------------------------------------

describe("RunPipeline", () => {
  test("runs the steps in order", async () => {
    const out = await call(runPipeline, {
      steps: [{ argv: ["echo", "one"] }, { argv: ["echo", "two"] }],
    });
    expect(out.ok).toBe(true);
    expect(out.results.map((r: { stdout: string }) => r.stdout.trim())).toEqual(["one", "two"]);
  });

  test("stops at the first non-zero exit", async () => {
    const out = await call(runPipeline, {
      steps: [{ argv: ["echo", "one"] }, { argv: ["false"] }, { argv: ["echo", "three"] }],
    });
    expect(out.ok).toBe(false);
    expect(out.failedAtStep).toBe(1);
    expect(out.ran).toBe(2);
  });

  test("continueOnError runs the rest anyway", async () => {
    const out = await call(runPipeline, {
      steps: [{ argv: ["false"] }, { argv: ["echo", "still here"] }],
      continueOnError: true,
    });
    expect(out.ran).toBe(2);
    expect(out.ok).toBe(false);
  });

  /**
   * With a single step there is nothing before the bad one, so the claim
   * "before any step runs" was untestable by construction. A prior step with
   * a visible side effect is what actually proves it: if the file exists
   * afterwards, the refusal came too late and the caller got a bare string
   * instead of the results of work that really happened.
   */
  test("a step's bad cwd is refused before any step runs", async () => {
    const out = await call(runPipeline, {
      steps: [
        { argv: ["touch", "should-not-exist.txt"] },
        { argv: ["pwd"], cwd: "../.." },
        { argv: ["touch", "also-should-not-exist.txt"] },
      ],
    });
    expect(out).toContain("refused path");
    expect(existsSync(join(tmp, "should-not-exist.txt"))).toBe(false);
    expect(existsSync(join(tmp, "also-should-not-exist.txt"))).toBe(false);
  });

  test("an absolute step cwd outside the workspace is refused, however late in the list", async () => {
    const out = await call(runPipeline, {
      steps: [{ argv: ["true"] }, { argv: ["true"] }, { argv: ["ls"], cwd: outside }],
    });
    expect(out).toContain("refused path");
  });

  test("a step cwd reached through an escaping symlink is refused", async () => {
    symlinkSync(outside, join(tmp, "sneaky"));
    const out = await call(runPipeline, {
      steps: [{ argv: ["true"] }, { argv: ["pwd"], cwd: "sneaky" }],
    });
    expect(out).toContain("refused path");
  });
});

// ---------------------------------------------------------------------------

/**
 * A real git repository, built in the temp directory, is the sharpest
 * available test of the pinned child environment: a commit's SHA is a hash of
 * its tree, author, committer and both dates, so if anything in the
 * environment leaked through or drifted, two independently-built repositories
 * would disagree. `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are pointed at
 * /dev/null so the developer's own git config cannot reach the commit.
 */
describe("determinism against a real git repository", () => {
  const DATE = "2026-01-01T00:00:00Z";

  async function buildRepo(dir: string): Promise<string> {
    mkdirSync(join(tmp, dir));
    writeFileSync(join(tmp, dir, "README.md"), "# fixture\n");
    const envSet = {
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: DATE,
      GIT_COMMITTER_DATE: DATE,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const built = await call(runPipeline, {
      cwd: dir,
      envSet,
      steps: [
        { argv: ["git", "init", "--quiet", "--initial-branch", "main"] },
        { argv: ["git", "add", "README.md"] },
        { argv: ["git", "commit", "--quiet", "-m", "fixture commit"] },
      ],
    });
    expect({ dir, ok: built.ok, results: built.results }).toMatchObject({ dir, ok: true });
    // %H is the full object name: the most machine-stable thing git prints,
    // with no abbreviation length, colour or pager in play.
    const log = await call(runCommand, {
      argv: ["git", "log", "-n", "1", "--pretty=format:%H %an %aI"],
      cwd: dir,
      envSet,
    });
    expect(log.exitCode).toBe(0);
    return log.stdout.trim();
  }

  test("two repositories built the same way produce the same commit", async () => {
    const first = await buildRepo("repo-a");
    const second = await buildRepo("repo-b");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{40} Fixture 2026-01-01T00:00:00Z$/);
  });
});

// ---------------------------------------------------------------------------

describe("Retry", () => {
  test("a command that works first time is run once", async () => {
    const out = await call(retry, {
      argv: ["true"],
      maxAttempts: 3,
      backoff: { kind: "fixed", delayMs: 10 },
    });
    expect(out.succeeded).toBe(true);
    expect(out.attemptsUsed).toBe(1);
    expect(out.attempts[0].waitedBeforeMs).toBe(0);
  });

  test("a command that keeps failing is attempted exactly maxAttempts times", async () => {
    const out = await call(retry, {
      argv: ["false"],
      maxAttempts: 3,
      backoff: { kind: "fixed", delayMs: 10 },
    });
    expect(out.succeeded).toBe(false);
    expect(out.attemptsUsed).toBe(3);
    expect(out.attempts.map((a: { waitedBeforeMs: number }) => a.waitedBeforeMs)).toEqual([
      0, 10, 10,
    ]);
  });

  test("a command that only works on the second attempt succeeds there, and every attempt is reported", async () => {
    const path = script(
      "flaky.sh",
      'n=$(cat counter 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > counter\necho "attempt $n"\n[ "$n" -ge 2 ]',
    );
    const out = await call(retry, {
      argv: [path],
      maxAttempts: 4,
      backoff: { kind: "exponential", baseMs: 10 },
    });
    expect(out.succeeded).toBe(true);
    expect(out.attemptsUsed).toBe(2);
    expect(out.attempts[0].ok).toBe(false);
    expect(out.attempts[1].ok).toBe(true);
    expect(out.attempts[1].stdout.trim()).toBe("attempt 2");
  });

  test("successExitCodes lets a caller define success", async () => {
    const out = await call(retry, {
      argv: ["false"],
      maxAttempts: 2,
      backoff: { kind: "fixed", delayMs: 0 },
      successExitCodes: [1],
    });
    expect(out.succeeded).toBe(true);
    expect(out.attemptsUsed).toBe(1);
  });

  test("a backoff that cannot fit the deadline is refused up front, not discovered halfway", async () => {
    const out = await call(retry, {
      argv: ["false"],
      maxAttempts: 4,
      backoff: { kind: "fixed", delayMs: 1_000 },
      deadlineMs: 500,
    });
    expect(out).toContain("exceeds the 500ms deadline");
  });

  test("the overall deadline stops further attempts", async () => {
    const out = await call(retry, {
      argv: ["sleep", "1"],
      maxAttempts: 5,
      backoff: { kind: "fixed", delayMs: 10 },
      timeoutMs: 200,
      deadlineMs: 700,
    });
    expect(out.succeeded).toBe(false);
    expect(out.stoppedBy).toBe("deadline");
    expect(out.attemptsUsed).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------

describe("background processes", () => {
  test("a process starts, appears in the list, and is stopped deterministically", async () => {
    const started = await call(processStart, { argv: ["sleep", "30"], label: "sleeper" });
    expect(started.id).toBe("proc_1");
    expect(started.status).toBe("running");

    const listed = await call(processList, {});
    expect(listed.count).toBe(1);
    expect(listed.running).toBe(1);
    expect(listed.processes[0]).toMatchObject({
      id: "proc_1",
      label: "sleeper",
      status: "running",
    });

    const status = await call(processStatus, { id: "proc_1" });
    expect(status.status).toBe("running");

    const stopped = await call(processStop, { id: "proc_1", killAfterMs: 1_000 });
    expect(stopped.stopped).toBe(true);
    expect(stopped.status).toBe("killed");

    const after = await call(processStatus, { id: "proc_1" });
    expect(after.status).toBe("killed");
  });

  test("ids count up from the start of the session, so they are predictable", async () => {
    await call(processStart, { argv: ["true"] });
    const second = await call(processStart, { argv: ["true"] });
    expect(second.id).toBe("proc_2");
  });

  test("output is returned once: a second poll sees only what is new", async () => {
    const path = script("emit.sh", "echo first\nsleep 0.15\necho second\n");
    const started = await call(processStart, { argv: [path] });
    await call(waitForOutput, { id: started.id, pattern: "first", timeoutMs: 3_000 });
    const firstPoll = await call(processOutput, { id: started.id });
    expect(firstPoll.stdout).toContain("first");
    expect(firstPoll.stdout).not.toContain("second");

    await call(waitForOutput, { id: started.id, pattern: "second", timeoutMs: 3_000 });
    const secondPoll = await call(processOutput, { id: started.id });
    expect(secondPoll.stdout).toContain("second");
    expect(secondPoll.stdout).not.toContain("first");

    const thirdPoll = await call(processOutput, { id: started.id, stream: "stdout" });
    expect(thirdPoll.stdout).toBe("");
  });

  test("a finished process keeps its output until it is reaped", async () => {
    const started = await call(processStart, { argv: ["echo", "done"] });
    await call(waitForOutput, { id: started.id, pattern: "done", timeoutMs: 3_000 });
    const status = await call(processStatus, { id: started.id });
    expect(status.status).toBe("exited");
    expect(status.exitCode).toBe(0);

    const reaped = await call(processStop, { id: started.id, reap: true });
    expect(reaped.alreadyFinished).toBe(true);
    expect(reaped.reaped).toBe(true);
    expect(await call(processStatus, { id: started.id })).toContain("no background process");
  });

  test("a process that ignores SIGTERM is escalated to SIGKILL within the grace period", async () => {
    const path = script("stubborn.sh", 'trap "" TERM\necho ready\nwhile true; do sleep 0.05; done');
    const started = await call(processStart, { argv: [path] });
    await call(waitForOutput, { id: started.id, pattern: "ready", timeoutMs: 3_000 });
    const stopped = await call(processStop, { id: started.id, killAfterMs: 300 });
    expect(stopped.stopped).toBe(true);
    expect(stopped.escalatedToSigkill).toBe(true);
  });

  test("an unknown id is a readable message listing what is known", async () => {
    await call(processStart, { argv: ["true"] });
    const out = await call(processOutput, { id: "proc_999" });
    expect(out).toContain('no background process with id "proc_999"');
    expect(out).toContain("proc_1");
  });

  test("the background cwd is contained like every other path", async () => {
    expect(await call(processStart, { argv: ["pwd"], cwd: outside })).toContain("refused path");
  });

  test("the list shows only processes this harness started", async () => {
    const listed = await call(processList, {});
    expect(listed.count).toBe(0);
    expect(listed.processes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("WaitForOutput", () => {
  test("returns as soon as the pattern appears", async () => {
    const path = script("server.sh", 'echo booting\nsleep 0.1\necho "Listening on 4321"\nsleep 5');
    const started = await call(processStart, { argv: [path] });
    const out = await call(waitForOutput, {
      id: started.id,
      pattern: "Listening on (\\d+)",
      timeoutMs: 5_000,
    });
    expect(out.matched).toBe(true);
    expect(out.match).toBe("Listening on 4321");
  });

  test("a failure pattern ends the wait early instead of burning the deadline", async () => {
    const path = script(
      "broken.sh",
      'echo booting\nsleep 0.05\necho "FATAL: port in use" >&2\nsleep 5',
    );
    const started = await call(processStart, { argv: [path] });
    const out = await call(waitForOutput, {
      id: started.id,
      pattern: "Listening on",
      failurePattern: "FATAL",
      timeoutMs: 5_000,
    });
    expect(out.matched).toBe(false);
    expect(out.matchedFailure).toBe(true);
    expect(out.match).toBe("FATAL");
  });

  test("the deadline is honoured when the pattern never appears", async () => {
    const started = await call(processStart, { argv: ["sleep", "30"] });
    const at = Date.now();
    const out = await call(waitForOutput, {
      id: started.id,
      pattern: "never-appears",
      timeoutMs: 250,
    });
    expect(out.matched).toBe(false);
    expect(out.reason).toBe("deadline");
    expect(Date.now() - at).toBeLessThan(5_000);
  });

  test("a process that finishes without matching stops the wait immediately", async () => {
    const started = await call(processStart, { argv: ["echo", "nothing useful"] });
    const out = await call(waitForOutput, {
      id: started.id,
      pattern: "ready",
      timeoutMs: 30_000,
    });
    expect(out.matched).toBe(false);
    expect(out.reason).toBe("process finished without matching");
  });

  test("watching does not consume: ProcessOutput still returns everything", async () => {
    const started = await call(processStart, { argv: ["echo", "hello world"] });
    await call(waitForOutput, { id: started.id, pattern: "hello", timeoutMs: 3_000 });
    const polled = await call(processOutput, { id: started.id });
    expect(polled.stdout).toContain("hello world");
  });

  test("a pattern that could backtrack exponentially is refused", async () => {
    const started = await call(processStart, { argv: ["sleep", "1"] });
    const out = await call(waitForOutput, { id: started.id, pattern: "(a+)+b", timeoutMs: 100 });
    expect(out).toContain("exponentially");
  });

  /**
   * The deadline bounds the poll loop, not one `exec`, so a catastrophic
   * pattern would run past it with no way to interrupt. The refusal must
   * therefore happen before the first match, and it must cover the
   * overlapping-alternation shape that star height alone does not see.
   */
  test("an overlapping alternation is refused before it is ever matched, not at the deadline", async () => {
    const path = script(
      "many-a.sh",
      'printf "%s" "$(head -c 400 /dev/zero | tr "\\0" "a")"\nsleep 5',
    );
    const started = await call(processStart, { argv: [path] });
    const at = Date.now();
    const out = await call(waitForOutput, {
      id: started.id,
      pattern: "(a|a)*$",
      timeoutMs: 1_000,
    });
    expect(typeof out).toBe("string");
    expect(out).toContain("alternation");
    // Refused up front: it never even reached the deadline, let alone the
    // match that would have outlived the process.
    expect(Date.now() - at).toBeLessThan(1_000);
  });

  test("a wait for a line, with an unquantified alternation, still works", async () => {
    const path = script("alt.sh", 'sleep 0.05\necho "server ready on 8080"\nsleep 5');
    const started = await call(processStart, { argv: [path] });
    const out = await call(waitForOutput, {
      id: started.id,
      pattern: "(ready|listening) on \\d+",
      timeoutMs: 5_000,
    });
    expect(out.matched).toBe(true);
    expect(out.match).toBe("ready on 8080");
  });
});

// ---------------------------------------------------------------------------

describe("WaitForPort", () => {
  test("returns as soon as a real listener accepts, and reports the closed port afterwards", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const open = await call(waitForPort, { port, timeoutMs: 3_000 });
      expect(open.satisfied).toBe(true);
      expect(open.state).toBe("open");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const closed = await call(waitForPort, { port, state: "closed", timeoutMs: 3_000 });
    expect(closed.satisfied).toBe(true);
  });

  test("a port nobody is listening on fails at the deadline, not forever", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const at = Date.now();
    const out = await call(waitForPort, { port, timeoutMs: 300, intervalMs: 50 });
    const elapsed = Date.now() - at;
    expect(out.satisfied).toBe(false);
    expect(out.reason).toBe("deadline");
    expect(out.attempts).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("a host that is not a hostname is refused", async () => {
    const out = await call(waitForPort, { port: 80, host: "not a host", timeoutMs: 50 });
    expect(out).toContain("is not a hostname");
  });
});

// ---------------------------------------------------------------------------

describe("WaitForFile", () => {
  test("returns once the file appears", async () => {
    const target = join(tmp, "artifact.bin");
    const timer = setTimeout(() => writeFileSync(target, "built"), 100);
    try {
      const out = await call(waitForFile, {
        path: "artifact.bin",
        timeoutMs: 3_000,
        intervalMs: 20,
      });
      expect(out.satisfied).toBe(true);
      expect(out.sizeBytes).toBe(5);
    } finally {
      clearTimeout(timer);
    }
  });

  test("waits for a file to disappear", async () => {
    const target = join(tmp, "lock");
    writeFileSync(target, "held");
    const timer = setTimeout(() => rmSync(target, { force: true }), 100);
    try {
      const out = await call(waitForFile, {
        path: "lock",
        condition: "absent",
        timeoutMs: 3_000,
        intervalMs: 20,
      });
      expect(out.satisfied).toBe(true);
      expect(out.exists).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });

  test("'stable' waits for the size to stop moving", async () => {
    const target = join(tmp, "growing.log");
    writeFileSync(target, "a");
    const grow = setTimeout(() => writeFileSync(target, "aaaaaa"), 60);
    try {
      const out = await call(waitForFile, {
        path: "growing.log",
        condition: "stable",
        stableForMs: 150,
        timeoutMs: 5_000,
        intervalMs: 20,
      });
      expect(out.satisfied).toBe(true);
      expect(out.sizeBytes).toBe(6);
    } finally {
      clearTimeout(grow);
    }
  });

  test("a file that never appears fails at the deadline", async () => {
    const at = Date.now();
    const out = await call(waitForFile, { path: "never.txt", timeoutMs: 250, intervalMs: 25 });
    expect(out.satisfied).toBe(false);
    expect(out.reason).toBe("deadline");
    expect(Date.now() - at).toBeGreaterThanOrEqual(200);
    expect(Date.now() - at).toBeLessThan(5_000);
  });

  test("a path outside the workspace is refused", async () => {
    expect(await call(waitForFile, { path: "../secret", timeoutMs: 50 })).toContain("refused path");
    expect(await call(waitForFile, { path: "/etc/passwd", timeoutMs: 50 })).toContain(
      "refused path",
    );
  });

  test("a symlink out of the workspace is refused, not followed", async () => {
    writeFileSync(join(outside, "target.txt"), "secret");
    symlinkSync(join(outside, "target.txt"), join(tmp, "innocent.txt"));
    const out = await call(waitForFile, { path: "innocent.txt", timeoutMs: 50 });
    expect(out).toContain("refused path");
  });

  /**
   * The escape the up-front check cannot see. A symlink to a path that does
   * not exist YET resolves to nothing, so containment is decided on its
   * parent and the link is admitted — and then the tool polls it for as long
   * as the deadline allows. Create the target outside meanwhile and, before
   * the fix, the wait reported `satisfied` with the outside file's size:
   * a working existence-and-size oracle for any path the workspace does not
   * contain. Containment is therefore re-checked on every poll.
   */
  test("a DANGLING symlink whose target appears outside later is refused, not reported on", async () => {
    const target = join(outside, "appears-later.txt");
    expect(existsSync(target)).toBe(false);
    symlinkSync(target, join(tmp, "dangling"));
    const appear = setTimeout(() => writeFileSync(target, "22-bytes-of-secrets!!!"), 100);
    try {
      const out = await call(waitForFile, {
        path: "dangling",
        timeoutMs: 2_000,
        intervalMs: 20,
      });
      expect(typeof out).toBe("string");
      expect(out).toContain("refused path");
      expect(out).not.toContain("22");
    } finally {
      clearTimeout(appear);
    }
  });

  test("a symlink swapped in mid-wait cannot escape either", async () => {
    const swap = setTimeout(() => {
      writeFileSync(join(outside, "late.txt"), "secret");
      symlinkSync(join(outside, "late.txt"), join(tmp, "swapped.txt"));
    }, 100);
    try {
      const out = await call(waitForFile, {
        path: "swapped.txt",
        timeoutMs: 2_000,
        intervalMs: 20,
      });
      expect(out).toContain("refused path");
    } finally {
      clearTimeout(swap);
    }
  });

  test("a dangling symlink to a path INSIDE the workspace still works normally", async () => {
    symlinkSync(join(tmp, "built-later.txt"), join(tmp, "link-to-artifact"));
    const build = setTimeout(() => writeFileSync(join(tmp, "built-later.txt"), "ok!"), 80);
    try {
      const out = await call(waitForFile, {
        path: "link-to-artifact",
        timeoutMs: 2_000,
        intervalMs: 20,
      });
      expect(out.satisfied).toBe(true);
      expect(out.sizeBytes).toBe(3);
    } finally {
      clearTimeout(build);
    }
  });
});

// ---------------------------------------------------------------------------

describe("CommandExists", () => {
  test("finds a program that is on PATH and resolves it", async () => {
    const out = await call(commandExists, { name: "sh" });
    expect(out.found).toBe(true);
    expect(out.path.endsWith("/sh")).toBe(true);
  });

  test("reports a missing program as an answer, not an error", async () => {
    const out = await call(commandExists, { name: "crewhaus-no-such-binary-xyz" });
    expect(out.found).toBe(false);
    expect(out.path).toBeNull();
  });

  test("a path is refused: this looks up names, it does not stat wherever it is pointed", async () => {
    expect(await call(commandExists, { name: "/etc/passwd" })).toContain("is a path");
    expect(await call(commandExists, { name: "../sh" })).toContain("is a path");
  });

  test("the answer is stable across calls", async () => {
    const a = await commandExists.execute({ name: "sh" });
    const b = await commandExists.execute({ name: "sh" });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------

describe("EnvInspect", () => {
  beforeEach(() => {
    process.env["TOOL_PROC_TOKEN"] = "sk-0123456789";
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, "TOOL_PROC_TOKEN");
  });

  test("reports presence and length without revealing the value", async () => {
    const out = await call(envInspect, { names: ["TOOL_PROC_TOKEN"] });
    expect(out.variables).toEqual([{ name: "TOOL_PROC_TOKEN", present: true, chars: 13 }]);
    expect(JSON.stringify(out)).not.toContain("sk-0123456789");
  });

  test("reveals only what the caller names", async () => {
    const out = await call(envInspect, {
      names: ["TOOL_PROC_TOKEN"],
      reveal: ["TOOL_PROC_TOKEN"],
    });
    expect(out.variables[0].value).toBe("sk-0123456789");
  });

  test("revealing something that was not inspected is refused", async () => {
    const out = await call(envInspect, { names: ["PATH"], reveal: ["TOOL_PROC_TOKEN"] });
    expect(out).toContain("which names does not");
  });

  test("an unset variable is reported as absent", async () => {
    const out = await call(envInspect, { names: ["CREWHAUS_DEFINITELY_UNSET"] });
    expect(out.variables[0]).toEqual({
      name: "CREWHAUS_DEFINITELY_UNSET",
      present: false,
      chars: 0,
    });
  });

  test("there is no way to ask for the whole environment", () => {
    const parsed = envInspect.inputSchema.safeParse({ names: [] });
    expect(parsed.success).toBe(false);
  });

  test("the same request twice returns the same bytes", async () => {
    const a = await envInspect.execute({ names: ["PATH", "HOME"] });
    const b = await envInspect.execute({ names: ["HOME", "PATH"] });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------

/**
 * Regression — the DANGLING-symlink hole in `resolveSafe` itself.
 *
 * The containment walk used to probe for the deepest existing ancestor with
 * `existsSync`, which FOLLOWS symlinks: a link whose target is missing
 * answers false, so the walk strode past it, treated it as a plain missing
 * leaf, and re-appended the name to the realpath'd parent. Containment was
 * then decided on a path that pointed back into the workspace while the link
 * pointed anywhere at all. Nothing in this package writes through a resolved
 * path today — `WaitForFile` only polls for a size — so the hole was latent
 * rather than live here, and `recheckContainment` caught the escape at the
 * moment the outside target appeared. But "the tool that uses it is
 * read-only" is not a property of the resolver, and the next tool to be
 * handed a resolved path would inherit the hole. `resolveSafe` now refuses
 * an outward dangling link UP FRONT; `recheckContainment` stays as the
 * at-use guard for links planted or swapped after the check.
 */
describe("dangling-symlink containment in resolveSafe", () => {
  test("an outward dangling symlink is refused up front, as a containment failure", async () => {
    const target = join(outside, "appears-never.txt");
    expect(existsSync(target)).toBe(false);
    symlinkSync(target, join(tmp, "dangling.bin"));

    const at = Date.now();
    const out = await call(waitForFile, { path: "dangling.bin", timeoutMs: 2_000, intervalMs: 20 });

    // The specific refusal matters. Before the fix the path was admitted and
    // the tool polled it to the deadline (returning `satisfied: false`), and
    // the only thing standing between a caller and an outside oracle was the
    // per-poll recheck, whose wording is different ("it NOW resolves
    // outside…"). This asserts the up-front check did the refusing.
    expect(typeof out).toBe("string");
    expect(out).toMatch(/a symlink on it leads outside the workspace root/);
    // Refused before the first poll, not at the deadline.
    expect(Date.now() - at).toBeLessThan(1_000);
    // A read-only tool cannot have created the target, but assert it anyway:
    // this is the assertion that would fail first if a writing tool were ever
    // wired to `resolveSafe`. The planted link is left exactly as it was.
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(join(tmp, "dangling.bin")).isSymbolicLink()).toBe(true);
  });

  test("a dangling symlinked DIRECTORY on the way out is refused too", async () => {
    // The escape does not need the leaf to be the link: a link standing in
    // for a directory that does not exist yet was walked past the same way,
    // and everything under it inherited the parent's verdict.
    symlinkSync(join(outside, "not-made-yet"), join(tmp, "dlink"));
    const out = await call(waitForFile, {
      path: "dlink/artifact.bin",
      timeoutMs: 2_000,
      intervalMs: 20,
    });
    expect(typeof out).toBe("string");
    expect(out).toMatch(/a symlink on it leads outside the workspace root/);
    expect(existsSync(join(outside, "not-made-yet"))).toBe(false);
  });

  test("a dangling symlink pointing INSIDE the workspace is still honoured", async () => {
    // The mirror of the tests above: refusing every dangling link would also
    // "pass" them. Waiting on a link whose target is not built yet is the
    // whole point of WaitForFile, so it must survive the fix.
    mkdirSync(join(tmp, "sub"));
    const realTarget = join(tmp, "sub", "built-later.bin");
    symlinkSync(realTarget, join(tmp, "inside-link.bin"));
    const build = setTimeout(() => writeFileSync(realTarget, "built"), 80);
    try {
      const out = await call(waitForFile, {
        path: "inside-link.bin",
        timeoutMs: 2_000,
        intervalMs: 20,
      });
      expect(out.satisfied).toBe(true);
      expect(out.sizeBytes).toBe(5);
    } finally {
      clearTimeout(build);
    }
  });

  test("an in-workspace target NAMED through an outside path is honoured, not refused", async () => {
    /**
     * The macOS wrinkle, made portable. There, a link written as
     * /var/folders/… lands inside a workspace whose real root is
     * /private/var/folders/… — the link target's SPELLING is outside the
     * root even though the place it leads is inside. Here the same shape is
     * built by hand: a directory symlink living outside the workspace that
     * points back at it. Following one `readlink` hop and RECURSING resolves
     * the target to its real in-workspace path; returning the raw readlink
     * target instead would compare the outside spelling against the root and
     * refuse a perfectly legitimate wait.
     */
    mkdirSync(join(tmp, "sub"));
    symlinkSync(tmp, join(outside, "alias"));
    const realTarget = join(tmp, "sub", "via-alias.bin");
    symlinkSync(join(outside, "alias", "sub", "via-alias.bin"), join(tmp, "aliased-link.bin"));
    const build = setTimeout(() => writeFileSync(realTarget, "ok!"), 80);
    try {
      const out = await call(waitForFile, {
        path: "aliased-link.bin",
        timeoutMs: 2_000,
        intervalMs: 20,
      });
      expect(out.satisfied).toBe(true);
      expect(out.sizeBytes).toBe(3);
    } finally {
      clearTimeout(build);
    }
  });

  test("a RELATIVE dangling target is measured from where the link really lives", async () => {
    /**
     * A relative symlink target is resolved by the kernel against the
     * directory that actually CONTAINS the link — not against the lexical
     * spelling of the path used to reach it. Here `dirlink` is an
     * in-workspace link to a directory OUTSIDE the root, and `l` inside that
     * directory dangles at `../escape.bin`, i.e. at `<outside>/escape.bin`.
     * Resolving `../escape.bin` from the LEXICAL parent (`<tmp>/dirlink`)
     * instead reads it as `<tmp>/escape.bin` and admits the path, so the
     * containment verdict is passed on a location the path does not lead to.
     */
    mkdirSync(join(outside, "realdir"));
    symlinkSync(join(outside, "realdir"), join(tmp, "dirlink"));
    symlinkSync("../escape.bin", join(outside, "realdir", "l"));

    const at = Date.now();
    const out = await call(waitForFile, { path: "dirlink/l", timeoutMs: 2_000, intervalMs: 20 });
    expect(typeof out).toBe("string");
    expect(out).toMatch(/a symlink on it leads outside the workspace root/);
    expect(Date.now() - at).toBeLessThan(1_000);
    expect(existsSync(join(outside, "escape.bin"))).toBe(false);
  });

  test("a relative dangling target that really lands inside is still honoured", async () => {
    // The mirror of the test above, and the reason the parent has to be made
    // REAL rather than simply dropped: `inlink` leads deeper into the
    // workspace, so `../../legit.bin` climbs back to `<tmp>/legit.bin`, which
    // is inside. Measured lexically it reads as `<tmp>/../legit.bin` — the
    // root's parent — and a legitimate wait is refused.
    mkdirSync(join(tmp, "deep", "inner"), { recursive: true });
    symlinkSync(join(tmp, "deep", "inner"), join(tmp, "inlink"));
    symlinkSync("../../legit.bin", join(tmp, "deep", "inner", "m"));
    const realTarget = join(tmp, "legit.bin");
    const build = setTimeout(() => writeFileSync(realTarget, "yes"), 80);
    try {
      const out = await call(waitForFile, { path: "inlink/m", timeoutMs: 2_000, intervalMs: 20 });
      expect(out.satisfied).toBe(true);
      expect(out.sizeBytes).toBe(3);
    } finally {
      clearTimeout(build);
    }
  });
});
