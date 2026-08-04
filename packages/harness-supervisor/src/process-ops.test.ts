import { describe, expect, test } from "bun:test";
import {
  argvFingerprint,
  argvMatchesCommandLine,
  createPosixProcessOps,
  createProcessOps,
  createWindowsProcessOps,
  parseProcBtime,
  parseProcCmdline,
  parseProcStartTime,
  parsePsLstart,
  parseWindowsStartTime,
  startTimesMatch,
} from "./process-ops";
import { START_TIME_TOLERANCE_MS } from "./types";

describe("argvFingerprint", () => {
  test("is stable, and keys on BOTH the cwd and the argv", () => {
    const a = argvFingerprint("/h", ["bun", "dist/daemon.ts"]);
    expect(argvFingerprint("/h", ["bun", "dist/daemon.ts"])).toBe(a);
    expect(argvFingerprint("/other", ["bun", "dist/daemon.ts"])).not.toBe(a);
    expect(argvFingerprint("/h", ["bun", "dist/agent.ts"])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("start-time parsers", () => {
  test("parses `ps -o lstart=` output", () => {
    const ms = parsePsLstart("Mon Aug  4 00:22:11 2026\n");
    expect(ms).toBe(Date.parse("Mon Aug  4 00:22:11 2026"));
  });

  test("empty or unparseable ps output yields undefined", () => {
    expect(parsePsLstart("")).toBeUndefined();
    expect(parsePsLstart("   \n")).toBeUndefined();
    expect(parsePsLstart("not a date")).toBeUndefined();
  });

  test("parses /proc/<pid>/stat field 22 against /proc/stat btime", () => {
    // A comm field containing spaces AND parentheses is the case a naive
    // whitespace split gets wrong.
    const fields = [
      "S", // 3 state
      "1",
      "1",
      "1",
      "0",
      "-1",
      "4194560",
      "100",
      "0",
      "0",
      "0",
      "5",
      "2",
      "0",
      "0",
      "20",
      "0",
      "1",
      "0",
      "123456", // 22 starttime (ticks since boot)
    ];
    const stat = `4242 (my (weird) proc) ${fields.join(" ")}`;
    const btime = 1_700_000_000;
    expect(parseProcStartTime(stat, btime)).toBe(1_700_000_000_000 + 1_234_560);
  });

  test("a malformed stat line yields undefined", () => {
    expect(parseProcStartTime("no parens here", 1)).toBeUndefined();
    expect(parseProcStartTime("42 (x) S", 1)).toBeUndefined();
  });

  test("parses btime out of /proc/stat", () => {
    expect(parseProcBtime("cpu  1 2 3\nbtime 1700000000\nprocesses 9\n")).toBe(1_700_000_000);
    expect(parseProcBtime("cpu 1 2 3\n")).toBeUndefined();
  });

  test("parses the PowerShell round-trip timestamp", () => {
    const iso = "2026-08-04T00:22:11.1234567Z";
    expect(parseWindowsStartTime(`${iso}\r\n`)).toBe(Date.parse(iso));
    expect(parseWindowsStartTime("")).toBeUndefined();
  });

  test("start times compare with tolerance (ps reports whole seconds)", () => {
    expect(startTimesMatch(1_000, 1_999, START_TIME_TOLERANCE_MS)).toBe(true);
    expect(startTimesMatch(1_000, 9_000, START_TIME_TOLERANCE_MS)).toBe(false);
  });
});

describe("command-line matching", () => {
  test("parses NUL-separated /proc cmdline", () => {
    expect(parseProcCmdline("bun\0dist/daemon.ts\0")).toBe("bun dist/daemon.ts");
    expect(parseProcCmdline("")).toBeUndefined();
  });

  test("matches argv tokens in order", () => {
    expect(argvMatchesCommandLine("bun /h/dist/daemon.ts", ["bun", "/h/dist/daemon.ts"])).toBe(
      true,
    );
    expect(argvMatchesCommandLine("bun /h/dist/daemon.ts", ["bun", "/h/dist/agent.ts"])).toBe(
      false,
    );
    // Order matters: the same tokens in the wrong order is a different run.
    expect(argvMatchesCommandLine("a b", ["b", "a"])).toBe(false);
    expect(argvMatchesCommandLine("", ["bun"])).toBe(false);
  });
});

describe("posix adapter", () => {
  test("isAlive treats EPERM as alive (the process exists, it is just not ours)", () => {
    const ops = createPosixProcessOps({
      kill: (_pid, _signal) => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
    });
    expect(ops.isAlive(1)).toBe(true);
  });

  test("isAlive is false for a dead pid and for nonsense pids", () => {
    const ops = createPosixProcessOps({
      kill: () => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
    });
    expect(ops.isAlive(999_999)).toBe(false);
    expect(ops.isAlive(0)).toBe(false);
    expect(ops.isAlive(-5)).toBe(false);
  });

  test("signals go to the process GROUP first, falling back to the bare pid", () => {
    const sent: Array<[number, string | number]> = [];
    const ops = createPosixProcessOps({
      kill: (pid, signal) => {
        sent.push([pid, signal]);
      },
    });
    ops.terminate(77);
    ops.forceKill(77);
    expect(sent).toEqual([
      [-77, "SIGTERM"],
      [-77, "SIGKILL"],
    ]);
  });

  test("a group signal that throws falls back to the pid", () => {
    const sent: Array<[number, string | number]> = [];
    const ops = createPosixProcessOps({
      kill: (pid, signal) => {
        if (pid < 0) throw new Error("no group");
        sent.push([pid, signal]);
      },
    });
    ops.terminate(77);
    expect(sent).toEqual([[77, "SIGTERM"]]);
  });

  test("linux reads /proc first and falls back to ps", () => {
    const calls: string[] = [];
    const ops = createPosixProcessOps({
      platform: "linux",
      readText: (path) => {
        calls.push(path);
        if (path === "/proc/9/stat") return "9 (bun) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 200";
        if (path === "/proc/stat") return "btime 1700000000\n";
        return undefined;
      },
      run: () => "Mon Aug  4 00:22:11 2026",
    });
    expect(ops.startTimeMs(9)).toBe(1_700_000_000_000 + 2_000);
    expect(calls).toContain("/proc/9/stat");

    const psOnly = createPosixProcessOps({
      platform: "linux",
      readText: () => undefined,
      run: () => "Mon Aug  4 00:22:11 2026",
    });
    expect(psOnly.startTimeMs(9)).toBe(Date.parse("Mon Aug  4 00:22:11 2026"));
  });

  test("commandLine prefers /proc/<pid>/cmdline on linux", () => {
    const ops = createPosixProcessOps({
      platform: "linux",
      readText: (path) => (path === "/proc/9/cmdline" ? "bun\0dist/daemon.ts\0" : undefined),
      run: () => "should not be used",
    });
    expect(ops.commandLine(9)).toBe("bun dist/daemon.ts");
  });

  test("an unavailable probe reports undefined rather than guessing", () => {
    const ops = createPosixProcessOps({ platform: "darwin", run: () => undefined });
    expect(ops.startTimeMs(9)).toBeUndefined();
    expect(ops.commandLine(9)).toBeUndefined();
  });
});

describe("windows adapter", () => {
  test("stops the tree with taskkill /T and escalates with /F", () => {
    const invocations: Array<[string, readonly string[]]> = [];
    const ops = createWindowsProcessOps({
      run: (cmd, args) => {
        invocations.push([cmd, args]);
        return "";
      },
    });
    ops.terminate(1234);
    ops.forceKill(1234);
    expect(invocations).toEqual([
      ["taskkill", ["/PID", "1234", "/T"]],
      ["taskkill", ["/PID", "1234", "/T", "/F"]],
    ]);
  });

  test("liveness and start time come from PowerShell", () => {
    const ops = createWindowsProcessOps({
      run: (_cmd, args) => {
        const command = args[2] ?? "";
        if (command.includes("Get-Process -Id 1234 -ErrorAction SilentlyContinue) { ")) return "1";
        if (command.includes("StartTime")) return "2026-08-04T00:22:11.0000000Z";
        if (command.includes("Win32_Process")) return "bun dist\\daemon.ts";
        return "";
      },
    });
    expect(ops.isAlive(1234)).toBe(true);
    expect(ops.startTimeMs(1234)).toBe(Date.parse("2026-08-04T00:22:11.0000000Z"));
    expect(ops.commandLine(1234)).toBe("bun dist\\daemon.ts");
    expect(ops.platform).toBe("windows");
  });
});

describe("createProcessOps", () => {
  test("picks the adapter for the platform", () => {
    expect(createProcessOps("win32").platform).toBe("windows");
    expect(createProcessOps("darwin").platform).toBe("posix");
    expect(createProcessOps("linux").platform).toBe("posix");
  });
});
