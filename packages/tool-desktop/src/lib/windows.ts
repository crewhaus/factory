/**
 * `WindowList` — enumerating what is on the operator's screen, and the one
 * answer this tool must never give.
 *
 * AN EMPTY LIST IS A CLAIM. It says "this desktop has no windows open", and a
 * workflow that reads it will conclude the operator is looking at nothing.
 * Every failure mode here produces that same empty list unless it is caught:
 * a macOS box that has not granted Accessibility, a Wayland session where
 * enumeration is not permitted at all, a Linux box with no `wmctrl`
 * installed, a truncated stream. So none of them return a list. They return
 * `unavailable` with the reason, and the reason names the grant to give or
 * the package to install.
 *
 * ── THE macOS BACKEND, AND WHY IT IS THE SLOW ONE ─────────────────────────
 *
 * There are two, and the survey sketch was right that it is a real fork:
 *
 *   CGWindowListCopyWindowInfo   one call, stable CGWindowIDs, bounds, layer
 *                                and on-screen state. It is a C API with no
 *                                JS binding, so using it means shipping and
 *                                code-signing a per-arch native helper.
 *   osascript / System Events    no build step, an order of magnitude slower,
 *                                no CGWindowID, and it needs the
 *                                Accessibility grant.
 *
 * House rule 8 settles it: no new runtime dependency, and a signed native
 * helper is a large one. So this is the System Events backend, and on a
 * machine that has not granted Accessibility the honest answer is
 * `unavailable` naming that grant — NOT an empty list, and not a list with
 * blank titles. (The blank-title failure the sketch describes belongs to the
 * CGWindowList backend, where a missing Screen Recording grant strips titles
 * while still returning every window. That trap is not reachable from here;
 * the System Events path fails loudly instead, which is the better failure.)
 *
 * The script is a frozen constant with arity 0 — no caller value reaches it —
 * and it reports each field separately, so a window whose position cannot be
 * read is a window with unknown bounds rather than a window at 0,0.
 */
import { type HostPlatform, type SessionEnv, linuxDisplayEnv, linuxSession } from "../host";
import type { RunRequest } from "../run";
import {
  osascriptArgv,
  osascriptPermissionReason,
  powershellArgv,
  registerAppleScript,
  registerPowerShellScript,
} from "./escape";
import { type Unavailable, firstLine, unavailable, unsupportedPlatform } from "./outcome";

/**
 * The field and record separators, ASCII 31 and 30.
 *
 * They are built INSIDE each script (`character id 31`, `[char]31`) rather
 * than written into this file, so no control byte travels through argv and no
 * source file in this package holds one (house rule 13's neighbourhood). They
 * are also the two characters a window title cannot plausibly contain, which
 * a printable sentinel like `<|f|>` cannot promise.
 */
const FS = "\u001F";
const RS = "\u001E";

export const WINDOW_LIST_SCRIPT = registerAppleScript({
  name: "window-list",
  lines: [
    "set fs to (character id 31)",
    "set rs to (character id 30)",
    'set out to ""',
    'tell application "System Events"',
    "repeat with p in (application processes whose visible is true)",
    "set pname to name of p",
    "set isFront to frontmost of p",
    "repeat with w in (windows of p)",
    'set wname to ""',
    "try",
    "set wname to name of w",
    "end try",
    'set wx to "?"',
    'set wy to "?"',
    'set ww to "?"',
    'set wh to "?"',
    "try",
    "set {px, py} to position of w",
    "set {sw, sh} to size of w",
    "set wx to px as string",
    "set wy to py as string",
    "set ww to sw as string",
    "set wh to sh as string",
    "end try",
    'set wmin to "?"',
    "try",
    'set wmin to (value of attribute "AXMinimized" of w) as string',
    "end try",
    "set out to out & pname & fs & wname & fs & wx & fs & wy & fs & ww & fs & wh & fs & (isFront as string) & fs & wmin & rs",
    "end repeat",
    "end repeat",
    "end tell",
    "return out",
  ],
  arity: 0,
});

export const WINDOWS_WINDOW_LIST = registerPowerShellScript({
  name: "window-list",
  // DOCUMENTED, NOT RECORDED. `MainWindowHandle`/`MainWindowTitle` give one
  // window per process and no geometry; real bounds need EnumWindows +
  // GetWindowRect through a P/Invoke shim, which is a compile step this
  // package will not take (house rule 8). So the Windows rows report bounds
  // as UNKNOWN rather than as zeros, and say why.
  script:
    "$fs = [char]31; $rs = [char]30; Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [Console]::Out.Write($_.ProcessName + $fs + $_.MainWindowTitle + $fs + '?' + $fs + '?' + $fs + '?' + $fs + '?' + $fs + 'false' + $fs + '?' + $rs) }",
  reads: [],
});

/**
 * One window.
 *
 * Every field that a backend may fail to read is `null`, never a zero and
 * never a `false`. `minimized: null` means "this backend could not ask",
 * which is a different thing from a window that is not minimized.
 */
export type WindowRecord = {
  readonly app: string;
  readonly title: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly focused: boolean | null;
  readonly minimized: boolean | null;
  /** Present on backends that expose one (wmctrl, Windows handles). */
  readonly id?: string;
  readonly pid?: number;
};

export type WindowPlan =
  | { readonly ok: true; readonly backend: string; readonly request: Omit<RunRequest, "timeoutMs"> }
  | { readonly ok: false; readonly unavailable: Unavailable };

export function planWindowList(platform: HostPlatform, env: SessionEnv): WindowPlan {
  switch (platform) {
    case "darwin":
      return {
        ok: true,
        backend: "osascript System Events",
        request: { argv: osascriptArgv(WINDOW_LIST_SCRIPT) },
      };
    case "linux": {
      const session = linuxSession(env);
      if (session.kind === "none" || session.kind === "wayland-unreachable") {
        return { ok: false, unavailable: unavailable("session", session.reason) };
      }
      if (session.kind === "wayland") {
        // Not a missing program and not an empty desktop. Wayland has no
        // protocol by which one client may enumerate another's windows; the
        // compositor-specific extensions that do (wlr-foreign-toplevel, the
        // GNOME Shell eval endpoint) are per-compositor and, in GNOME's case,
        // removed. There is nothing to install that would fix this, and the
        // reason says so rather than suggesting a package.
        return {
          ok: false,
          unavailable: unavailable(
            "session",
            "this is a Wayland session, and Wayland deliberately provides no protocol for one client to enumerate another client's windows — there is no program to install that would change this; an X11 session or a compositor-specific extension is the only way",
          ),
        };
      }
      return {
        ok: true,
        backend: "wmctrl",
        // `-l` list, `-G` geometry, `-p` pid, `-x` WM_CLASS. No caller value.
        request: { argv: ["wmctrl", "-l", "-G", "-p", "-x"], env: linuxDisplayEnv(env) },
      };
    }
    case "win32":
      return {
        ok: true,
        backend: "powershell Get-Process",
        request: { argv: powershellArgv(WINDOWS_WINDOW_LIST, {}).argv },
      };
    default:
      return { ok: false, unavailable: unsupportedPlatform(platform, "window") };
  }
}

/** `"?"` is the scripts' unknown marker; everything else must parse. */
function num(value: string | undefined): number | null {
  if (value === undefined || value === "?" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: string | undefined): boolean | null {
  if (value === undefined || value === "?") return null;
  const lowered = value.trim().toLowerCase();
  if (lowered === "true" || lowered === "yes") return true;
  if (lowered === "false" || lowered === "no") return false;
  return null;
}

/** Parse the separator-delimited output the macOS and Windows scripts emit. */
export function parseDelimitedWindows(stdout: string): WindowRecord[] {
  const out: WindowRecord[] = [];
  for (const record of stdout.split(RS)) {
    if (record.trim() === "") continue;
    const f = record.split(FS);
    if (f.length < 8) continue;
    out.push({
      app: (f[0] ?? "").trim(),
      // An empty title is a real state (a palette, a sheet), so it stays an
      // empty string; only a field the script could not read becomes null.
      title: f[1] ?? null,
      x: num(f[2]),
      y: num(f[3]),
      width: num(f[4]),
      height: num(f[5]),
      focused: bool(f[6]),
      minimized: bool(f[7]),
    });
  }
  return out;
}

/**
 * Parse `wmctrl -l -G -p -x`.
 *
 * Columns: id, desktop, pid, x, y, width, height, WM_CLASS, client machine,
 * then the title — which contains spaces and is therefore everything left.
 * A desktop of `-1` means "sticky / on all desktops", not an error.
 */
export function parseWmctrl(stdout: string): WindowRecord[] {
  const out: WindowRecord[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const [id, , pid, x, y, w, h, wmClass] = parts;
    // Nine fixed columns, then the title. The cursor walks the ORIGINAL line
    // rather than re-joining the split, so a title with runs of spaces, or
    // one that repeats a column's text, survives intact.
    let cursor = 0;
    for (let i = 0; i < 9; i += 1) {
      const field = parts[i] as string;
      const next = line.indexOf(field, cursor);
      if (next < 0) break;
      cursor = next + field.length;
    }
    const title = line.slice(cursor).trim();
    const parsedPid = num(pid);
    out.push({
      app: (wmClass ?? "").split(".").pop() ?? "",
      title,
      x: num(x),
      y: num(y),
      width: num(w),
      height: num(h),
      // wmctrl does not report focus or minimisation. Unknown, not false —
      // reporting `focused: false` for every window says "nothing has focus",
      // which is never true of a running X session.
      focused: null,
      minimized: null,
      ...(id === undefined ? {} : { id }),
      ...(parsedPid === null ? {} : { pid: parsedPid }),
    });
  }
  return out;
}

export type WindowOutcome =
  | {
      readonly outcome: "listed";
      readonly windows: ReadonlyArray<WindowRecord>;
      /** The stream was cut; the list is a PREFIX, not the whole desktop. */
      readonly truncated: boolean;
    }
  | Unavailable
  | { readonly outcome: "failed"; readonly reason: string };

export function classifyWindowList(
  backend: string,
  result: {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly missing: boolean;
    readonly refused?: boolean;
    readonly stdoutTruncated?: boolean;
  },
): WindowOutcome {
  if (result.refused === true) return { outcome: "failed", reason: result.stderr };
  if (result.missing) {
    return unavailable(
      "program",
      `the window enumerator for this platform is not installed on this host (${backend}; on X11 that is wmctrl)`,
      backend,
    );
  }
  if (result.timedOut) {
    return unavailable(
      "unknown",
      "the window enumerator did not finish within its timeout and was killed — the window list could not be read, which is not the same as there being no windows",
      backend,
    );
  }
  // Checked BEFORE the exit code: System Events reports a missing grant as an
  // ordinary script error, and treating it as one would hand a caller "the
  // script failed" when the actionable fact is "grant Accessibility".
  const permission = osascriptPermissionReason(result.stderr);
  if (permission !== undefined) {
    return unavailable("permission", permission, backend);
  }
  if (result.code !== 0) {
    const detail = firstLine(result.stderr);
    return {
      outcome: "failed",
      reason: detail === "" ? `${backend} exited ${result.code}` : `${backend}: ${detail}`,
    };
  }
  const windows =
    backend === "wmctrl" ? parseWmctrl(result.stdout) : parseDelimitedWindows(result.stdout);
  return { outcome: "listed", windows, truncated: result.stdoutTruncated === true };
}
