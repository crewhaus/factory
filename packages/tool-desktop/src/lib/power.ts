/**
 * `PowerAssertion` — keeping a machine awake for a long step, and giving it
 * back afterwards.
 *
 * THE ASSERTION IS THE LIFETIME OF A CHILD PROCESS, NOT A CALL. The tool has
 * to return while the holder keeps running, which makes three things true
 * that an ordinary tool never has to think about:
 *
 * 1. **A DEADLINE IS MANDATORY, AND THE KERNEL ENFORCES IT.** An unbounded
 *    inhibitor is a laptop that never sleeps again because a harness crashed
 *    three days ago. So the bound is not a reaper in this process — a reaper
 *    dies with the harness that crashed — it is an argument to the holder
 *    itself. `caffeinate -t <seconds>` exits on its own; `systemd-inhibit …
 *    sleep <seconds>` releases when `sleep` returns; the PowerShell holder
 *    parks for a fixed `Start-Sleep`. Kill the whole harness and every one of
 *    them still ends on time. The result reports `expiresAt` because a
 *    caller that cannot see when its own inhibitor lapses will hold another.
 * 2. **A PID IS NOT AN IDENTITY.** Pids are reused, and `release` reading a
 *    stale state file would otherwise send SIGTERM to whatever now owns that
 *    number. So the state file records the backend program, and `release` and
 *    `status` VERIFY the live process's command line before signalling
 *    anything. A mismatch is reported as `stale` and the file is cleared —
 *    nothing is killed.
 * 3. **WINDOWS CANNOT DO THIS IN A ONE-LINER.** `SetThreadExecutionState` is
 *    THREAD-scoped and its effect dies with the thread, so a PowerShell
 *    one-liner that sets the flag and exits does precisely nothing — the
 *    naive port's failure is silent and total. The holder must stay alive
 *    with the flag set, which is what `Start-Sleep` inside the script is for.
 *
 * Nothing here escalates privilege: `caffeinate`, `systemd-inhibit` and
 * `SetThreadExecutionState` are all available to an ordinary user, and
 * `run.ts`'s `assertArgv` refuses an escalation program structurally.
 */
import type { HostPlatform } from "../host";
import type { RunRequest } from "../run";
import { powershellArgv, registerPowerShellScript } from "./escape";
import { type Unavailable, unsupportedPlatform } from "./outcome";

/** What the assertion covers. `display` also implies `system`. */
export type AssertionScope = "system" | "display";

/** The ceiling, and the reason there is one. Eight hours is a working day. */
export const MAX_HOLD_MINUTES = 480;
export const DEFAULT_HOLD_MINUTES = 30;

/** Where the held assertion is remembered, relative to the workspace root. */
export const STATE_RELATIVE_PATH = ".crewhaus/power-assertion.json";

export const WINDOWS_INHIBIT = registerPowerShellScript({
  name: "power-inhibit",
  // DOCUMENTED, NOT RECORDED. The flags are ES_CONTINUOUS (0x80000000) |
  // ES_SYSTEM_REQUIRED (0x00000001), plus ES_DISPLAY_REQUIRED (0x00000002)
  // when the caller asked for the display — passed as a NUMBER in the
  // environment, never interpolated into this source. `Start-Sleep` is what
  // keeps the thread alive; without it the state is discarded the instant the
  // process exits and the whole call is a no-op.
  script: [
    "$src = 'using System;using System.Runtime.InteropServices;public class CHPwr{[DllImport(\"kernel32.dll\")]public static extern uint SetThreadExecutionState(uint f);}'",
    "Add-Type -TypeDefinition $src -ErrorAction Stop",
    "[void][CHPwr]::SetThreadExecutionState([uint32]$env:CREWHAUS_INHIBIT_FLAGS)",
    "Start-Sleep -Seconds ([int]$env:CREWHAUS_INHIBIT_SECONDS)",
  ].join("; "),
  reads: ["CREWHAUS_INHIBIT_FLAGS", "CREWHAUS_INHIBIT_SECONDS"],
});

export const WINDOWS_PROCESS_PROBE = registerPowerShellScript({
  name: "process-probe",
  script:
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$env:CREWHAUS_PID" -ErrorAction SilentlyContinue; if ($p) { [Console]::Out.Write($p.CommandLine) }',
  reads: ["CREWHAUS_PID"],
});

/**
 * The reason string a caller may attach to a Linux inhibitor.
 *
 * Printable ASCII only, and no newline. It becomes one argv ELEMENT of the
 * form `--why=<text>`, so getopt reads the whole tail as the option's value
 * whatever it contains — but `systemd-inhibit --list` prints it to an
 * operator later, and a control character there corrupts a terminal rather
 * than the command.
 */
export const SAFE_REASON = /^[ -~]{1,120}$/;

/**
 * Is this parsed JSON a state record every field of which can be used?
 *
 * ADVERSARIAL REVIEW FOUND A CRASH HERE. The first version checked `pid` and
 * `marker` and nothing else, so a record carrying those two and a missing or
 * non-numeric `startedAt`/`expiresAt` — an interrupted write, a file from an
 * older layout, an operator who edited it — was accepted, and then
 * `new Date(undefined).toISOString()` threw `RangeError: Invalid time value`
 * straight out of `execute`. Both `status` and `release` did it, which is to
 * say the tool crashed on exactly the path a caller reaches when the recorded
 * assertion is the thing that has gone wrong. `hold` had the quieter half of
 * the same bug: `now() < state.expiresAt` against a non-number is `false`, so
 * it silently overwrote a record it should have refused to replace.
 *
 * Every field is checked, because every field is used: the dates are
 * formatted, the pid is signalled, the marker is matched and the scope and
 * backend are echoed.
 */
export function isAssertionState(value: unknown): value is AssertionState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const finite = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x);
  return (
    finite(v["pid"]) &&
    Number.isInteger(v["pid"]) &&
    (v["pid"] as number) > 0 &&
    typeof v["marker"] === "string" &&
    v["marker"] !== "" &&
    typeof v["backend"] === "string" &&
    typeof v["platform"] === "string" &&
    (v["scope"] === "system" || v["scope"] === "display") &&
    finite(v["startedAt"]) &&
    finite(v["expiresAt"]) &&
    (v["reason"] === null || typeof v["reason"] === "string")
  );
}

/** What is remembered between calls. Written atomically; see ./fsseam.ts. */
export type AssertionState = {
  readonly pid: number;
  readonly platform: HostPlatform;
  readonly backend: string;
  /** The program the live process must still be running to be OURS. */
  readonly marker: string;
  readonly scope: AssertionScope;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly reason: string | null;
};

export type HoldPlan =
  | {
      readonly ok: true;
      readonly backend: string;
      /** The program name `release` matches against a live command line. */
      readonly marker: string;
      readonly request: Omit<RunRequest, "timeoutMs">;
    }
  | { readonly ok: false; readonly unavailable: Unavailable };

/** Build the holder's argv for `seconds` of inhibition. */
export function planHold(
  platform: HostPlatform,
  scope: AssertionScope,
  seconds: number,
  reason: string | null,
): HoldPlan {
  switch (platform) {
    case "darwin": {
      // `-i` idle sleep, `-m` disk idle, `-s` only while on AC — omitted on
      // purpose, a laptop on battery still needs the step to finish. `-d`
      // additionally keeps the display awake. `-t` is the deadline, enforced
      // by caffeinate rather than by this process.
      const argv = ["caffeinate", "-i", "-m"];
      if (scope === "display") argv.push("-d");
      argv.push("-t", String(seconds));
      return { ok: true, backend: "caffeinate", marker: "caffeinate", request: { argv } };
    }
    case "linux": {
      const what = scope === "display" ? "idle:sleep:handle-lid-switch" : "idle:sleep";
      const argv = [
        "systemd-inhibit",
        `--what=${what}`,
        "--who=crewhaus",
        `--why=${reason ?? "crewhaus PowerAssertion"}`,
        "--mode=block",
        // The inhibitor lives exactly as long as this command. `sleep` is a
        // program, not a shell — `assertArgv` would refuse an interpreter.
        "sleep",
        String(seconds),
      ];
      return {
        ok: true,
        backend: "systemd-inhibit",
        marker: "systemd-inhibit",
        request: { argv },
      };
    }
    case "win32": {
      const flags = scope === "display" ? 0x8000_0003 : 0x8000_0001;
      const built = powershellArgv(WINDOWS_INHIBIT, {
        CREWHAUS_INHIBIT_FLAGS: String(flags),
        CREWHAUS_INHIBIT_SECONDS: String(seconds),
      });
      return {
        ok: true,
        backend: "powershell SetThreadExecutionState",
        marker: "CHPwr",
        request: { argv: built.argv, env: built.env },
      };
    }
    default:
      return { ok: false, unavailable: unsupportedPlatform(platform, "power-assertion") };
  }
}

/**
 * Ask the host what `pid` is actually running.
 *
 * Not `process.kill(pid, 0)`: that answers "some process has this number",
 * which after a pid rollover is exactly the wrong question. The command line
 * is what distinguishes our holder from whatever inherited its number.
 */
export function planProcessProbe(
  platform: HostPlatform,
  pid: number,
): Omit<RunRequest, "timeoutMs"> | undefined {
  switch (platform) {
    case "darwin":
    case "linux":
      // `-o command=` prints the command line with no header, and nothing
      // else. The pid is a number this package produced, not caller input.
      return { argv: ["ps", "-o", "command=", "-p", String(pid)] };
    case "win32":
      return { argv: powershellArgv(WINDOWS_PROCESS_PROBE, { CREWHAUS_PID: String(pid) }).argv };
    default:
      return undefined;
  }
}

/** The signal that ends a verified holder. */
export function planRelease(
  platform: HostPlatform,
  pid: number,
): Omit<RunRequest, "timeoutMs"> | undefined {
  switch (platform) {
    case "darwin":
    case "linux":
      // SIGTERM, not SIGKILL: `systemd-inhibit` must run its own teardown to
      // drop the logind lock, and a SIGKILLed inhibitor leaves the lock held
      // until logind notices the process is gone.
      return { argv: ["kill", "-TERM", String(pid)] };
    case "win32":
      // `/T` takes the child `Start-Sleep` with it; `/F` because a PowerShell
      // host parked in Start-Sleep does not process a polite close.
      return { argv: ["taskkill", "/PID", String(pid), "/T", "/F"] };
    default:
      return undefined;
  }
}

/**
 * Is the recorded assertion still ours, and still running?
 *
 * Four answers, and the two failure cases are deliberately different: a probe
 * that could not run at all is NOT the same as a probe that ran and found
 * somebody else's process. The first must not cause a kill, and must not
 * cause the state file to be discarded either — the holder may be alive and
 * unreachable only to `ps`.
 */
export type Liveness = "alive" | "gone" | "reused" | "unknown";

/**
 * Is this command line OUR holder, rather than something that merely mentions
 * it?
 *
 * ADVERSARIAL REVIEW: the first version was `line.includes(marker)`, which
 * answers "yes" for `vim /home/max/notes/caffeinate.md` and for
 * `node ./caffeinate-runner.js`. After a pid rollover that is `release`
 * sending SIGTERM to the operator's editor — precisely the failure the
 * module header promises this check prevents ("A PID IS NOT AN IDENTITY"). A
 * substring test over a whole command line is not an identity test.
 *
 * So the PROGRAM is compared: the first token, unquoted, basename, `.exe`
 * stripped. Windows is the one case where that is not enough and cannot be —
 * the holder there genuinely IS `powershell.exe`, and what makes it ours is
 * the generated type name inside the script it was handed — so the substring
 * test is kept for that case alone, narrowed to a powershell host.
 */
export function commandMatchesMarker(commandLine: string, marker: string): boolean {
  const first = commandLine.trim().split(/\s+/)[0] ?? "";
  const unquoted = first.replace(/^"+|"+$/g, "");
  const base = (unquoted.split(/[\\/]/).pop() ?? unquoted).replace(/\.exe$/i, "");
  if (base === marker) return true;
  return /^powershell$/i.test(base) && commandLine.includes(marker);
}

export function classifyLiveness(
  marker: string,
  result: {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly missing: boolean;
    readonly refused?: boolean;
  },
): Liveness {
  if (result.refused === true || result.missing || result.timedOut) return "unknown";
  // `ps -p <pid>` exits 1 with no output when nothing has that pid. That is a
  // definite answer, not a failure — but ONLY when `ps` itself said nothing.
  //
  // ADVERSARIAL REVIEW: the first version read every non-zero exit with empty
  // stdout as "gone", and `ps` has other ways to exit non-zero with an empty
  // stdout, all of them loud on stderr. Recorded on macOS 26.6.2:
  //   $ ps -o command= -p 999999 ; echo $?
  //   ps: process id too large
  //   1
  // Reading that as "gone" makes `release` delete the state file and report
  // `expired` for a holder that may still be running — the exact "could not
  // determine is not no" inversion rule 6 names, on the one path where the
  // consequence is an inhibitor nobody can release before its deadline.
  if (result.code !== 0) {
    if (result.stderr.trim() !== "") return "unknown";
    return result.stdout.trim() === "" ? "gone" : "unknown";
  }
  const line = result.stdout.trim();
  if (line === "") return "gone";
  return commandMatchesMarker(line, marker) ? "alive" : "reused";
}

/** Minutes to a bounded second count, or a refusal naming the ceiling. */
export function boundedSeconds(minutes: number): { seconds: number } | { refusal: string } {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { refusal: "maxMinutes must be a positive number of minutes" };
  }
  if (minutes > MAX_HOLD_MINUTES) {
    return {
      refusal: `maxMinutes must be at most ${MAX_HOLD_MINUTES} (8 hours) — an assertion held longer than a working day is one nobody is waiting for any more`,
    };
  }
  return { seconds: Math.max(1, Math.round(minutes * 60)) };
}
