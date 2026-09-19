/**
 * Clipboard backends, and the one distinction the rest of the package is
 * shaped around: an EMPTY clipboard is not an UNREADABLE one.
 *
 * Recorded on Debian 12 / xclip 0.13, in a container with no X server and
 * then under Xvfb:
 *
 *   no display        `xclip -selection clipboard -o` -> exit 1,
 *                     "Error: Can't open display: (null)"
 *   display, nothing  `xclip -selection primary -o`   -> exit 1,
 *   on the selection                                    "Error: target STRING
 *                                                        not available"
 *   display, text     `xclip -selection clipboard -o` -> exit 0, the text
 *
 * The first two are the same exit code and the same empty stdout. A backend
 * that reports "the clipboard is empty" for both tells a workflow that the
 * operator has copied nothing when the truth is that nothing was asked.
 *
 * macOS is the mirror image: `pbpaste` exits 0 with empty stdout whether the
 * clipboard is empty or holds an image with no text flavour. So the macOS
 * reader disambiguates with a SECOND probe, `clipboard info`, and only when
 * the first one came back empty - never on the happy path.
 */
import type { SessionEnv } from "../host";
import { type HostPlatform, linuxSession } from "../host";
import type { RunRequest } from "../run";
import { registerAppleScript, registerPowerShellScript } from "./escape";
import { osascriptArgv, powershellArgv } from "./escape";
import { type Unavailable, unavailable, unsupportedPlatform } from "./outcome";

export type ClipboardFormat = "text" | "html";

/**
 * `clipboard info` names the FLAVOURS on the pasteboard and their byte
 * counts. It never returns content, which is why it is safe to run as a
 * disambiguating probe: the tool learns "there is something there" without
 * putting whatever it is into a context window.
 *
 * Recorded on macOS 26.6.2 against an EMPTY clipboard: empty stdout, exit 0.
 */
export const CLIPBOARD_INFO_SCRIPT = registerAppleScript({
  name: "clipboard-info",
  lines: ["return (clipboard info) as string"],
  arity: 0,
});

/** Windows readers. Two registered scripts, chosen from a closed enum - the
 *  format is never interpolated into one script. */
export const WINDOWS_CLIPBOARD_READ_TEXT = registerPowerShellScript({
  name: "clipboard-read-text",
  script: "$t = Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }",
  reads: [],
});

export const WINDOWS_CLIPBOARD_READ_HTML = registerPowerShellScript({
  name: "clipboard-read-html",
  script:
    "$t = Get-Clipboard -TextFormatType Html -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }",
  reads: [],
});

/**
 * The Windows writer takes the payload on STDIN, not as a parameter.
 *
 * Argv is world-readable through a process listing on every platform this
 * package supports, and a clipboard payload is exactly the sort of thing an
 * operator would not want there. It is also, on Windows specifically, the
 * channel that would put the value back into PowerShell source.
 */
export const WINDOWS_CLIPBOARD_WRITE = registerPowerShellScript({
  name: "clipboard-write",
  script: "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
  reads: [],
});

export type ClipboardPlan =
  | {
      readonly ok: true;
      /** Which backend program was chosen, for the result and for `dryRun`. */
      readonly backend: string;
      readonly request: Omit<RunRequest, "timeoutMs">;
      /**
       * Run only when the primary read came back empty, to tell an empty
       * clipboard from one holding a non-text flavour. macOS only.
       */
      readonly disambiguate?: Omit<RunRequest, "timeoutMs">;
    }
  | { readonly ok: false; readonly unavailable: Unavailable };

/**
 * Environment a Linux clipboard backend needs to find the display.
 *
 * Forwarded explicitly rather than inherited: the runner pins the child
 * environment, and an X11 client with no `DISPLAY` does not fail fast, it
 * fails after a connection attempt - or, on some builds, blocks.
 */
function linuxDisplayEnv(env: SessionEnv): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.DISPLAY !== undefined) out["DISPLAY"] = env.DISPLAY;
  if (env.WAYLAND_DISPLAY !== undefined) out["WAYLAND_DISPLAY"] = env.WAYLAND_DISPLAY;
  if (env.XDG_RUNTIME_DIR !== undefined) out["XDG_RUNTIME_DIR"] = env.XDG_RUNTIME_DIR;
  return out;
}

export function planClipboardRead(
  platform: HostPlatform,
  env: SessionEnv,
  format: ClipboardFormat,
): ClipboardPlan {
  switch (platform) {
    case "darwin": {
      if (format === "html") {
        return {
          ok: false,
          unavailable: unavailable(
            "program",
            "pbpaste exposes only the plain-text flavour; the HTML flavour needs an osascript «class HTML» round-trip that returns hex, which this package does not decode - ask for format \"text\"",
            "pbpaste",
          ),
        };
      }
      return {
        ok: true,
        backend: "pbpaste",
        request: { argv: ["pbpaste"] },
        disambiguate: { argv: osascriptArgv(CLIPBOARD_INFO_SCRIPT) },
      };
    }
    case "linux": {
      const session = linuxSession(env);
      if (session.kind === "none" || session.kind === "wayland-unreachable") {
        return { ok: false, unavailable: unavailable("session", session.reason) };
      }
      const displayEnv = linuxDisplayEnv(env);
      if (session.kind === "wayland") {
        return {
          ok: true,
          backend: "wl-paste",
          request: {
            argv:
              format === "html"
                ? ["wl-paste", "--no-newline", "--type", "text/html"]
                : ["wl-paste", "--no-newline"],
            env: displayEnv,
          },
        };
      }
      return {
        ok: true,
        backend: "xclip",
        request: {
          argv:
            format === "html"
              ? ["xclip", "-selection", "clipboard", "-o", "-t", "text/html"]
              : ["xclip", "-selection", "clipboard", "-o"],
          env: displayEnv,
        },
      };
    }
    case "win32": {
      const script =
        format === "html" ? WINDOWS_CLIPBOARD_READ_HTML : WINDOWS_CLIPBOARD_READ_TEXT;
      const built = powershellArgv(script, {});
      return { ok: true, backend: "powershell Get-Clipboard", request: { argv: built.argv } };
    }
    default:
      return { ok: false, unavailable: unsupportedPlatform(platform, "clipboard") };
  }
}

export function planClipboardWrite(
  platform: HostPlatform,
  env: SessionEnv,
  payload: string,
): ClipboardPlan {
  switch (platform) {
    case "darwin":
      return { ok: true, backend: "pbcopy", request: { argv: ["pbcopy"], stdin: payload } };
    case "linux": {
      const session = linuxSession(env);
      if (session.kind === "none" || session.kind === "wayland-unreachable") {
        return { ok: false, unavailable: unavailable("session", session.reason) };
      }
      const displayEnv = linuxDisplayEnv(env);
      if (session.kind === "wayland") {
        return {
          ok: true,
          backend: "wl-copy",
          request: { argv: ["wl-copy"], stdin: payload, env: displayEnv },
        };
      }
      // Under X11 there is no server-side clipboard store: the writing
      // process OWNS the selection and must outlive this call or the content
      // vanishes the moment the child exits. `xclip -i` forks a resident
      // holder by itself, which is the behaviour that makes this work - and
      // the reason the runner's stream drain is BOUNDED, because that holder
      // inherits the stdout pipe and never closes it.
      return {
        ok: true,
        backend: "xclip",
        request: {
          argv: ["xclip", "-selection", "clipboard", "-i"],
          stdin: payload,
          env: displayEnv,
        },
      };
    }
    case "win32": {
      const built = powershellArgv(WINDOWS_CLIPBOARD_WRITE, {});
      return {
        ok: true,
        backend: "powershell Set-Clipboard",
        request: { argv: built.argv, stdin: payload },
      };
    }
    default:
      return { ok: false, unavailable: unsupportedPlatform(platform, "clipboard") };
  }
}

/**
 * What a clipboard READ actually found.
 *
 * Four outcomes, not two. `noTextFlavour` is the one people forget: a
 * screenshot on the clipboard makes `pbpaste` print nothing at all, and
 * reporting that as "empty" sends a workflow off to ask the operator to copy
 * something they have already copied.
 */
export type ClipboardReadOutcome =
  | { readonly outcome: "read"; readonly text: string }
  | { readonly outcome: "empty"; readonly reason: string }
  | { readonly outcome: "noTextFlavour"; readonly reason: string }
  | Unavailable
  | { readonly outcome: "failed"; readonly reason: string };

/** Stderr patterns that mean "there is no display to talk to", per backend. */
const NO_SESSION = [
  /Can't open display/i,
  /Failed to connect to a Wayland server/i,
  /XDG_RUNTIME_DIR is invalid or not set/i,
  /Unable to init server/i,
];

/** Stderr patterns that mean "the display is fine, the selection is empty". */
const EMPTY_SELECTION = [
  // xclip 0.13, recorded under Xvfb with nothing on the PRIMARY selection.
  /target \S+ not available/i,
  // wl-clipboard's wording. DOCUMENTED, NOT RECORDED: the capture container
  // had no compositor, so this branch is written from wl-clipboard's source
  // and is the one string in this file nobody here has seen a program print.
  /Nothing is copied/i,
];

export function classifyClipboardRead(result: {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly missing: boolean;
  readonly refused?: boolean;
  readonly stdoutTruncated?: boolean;
}): ClipboardReadOutcome {
  if (result.refused === true) {
    return { outcome: "failed", reason: result.stderr };
  }
  if (result.missing) {
    return unavailable(
      "program",
      "the clipboard program for this platform is not installed on this host",
    );
  }
  if (result.timedOut) {
    // An X11 clipboard read against a wedged server BLOCKS rather than
    // exiting, which is why every read here has a deadline. What it would
    // have said is unknown, and unknown is not empty.
    return unavailable(
      "session",
      "the clipboard program did not finish within its timeout and was killed - the clipboard could not be read, which is not the same as it being empty",
    );
  }
  if (result.code === 0) {
    if (result.stdout.length > 0) return { outcome: "read", text: result.stdout };
    // Exit 0 and nothing on stdout: on macOS this is ambiguous and the caller
    // runs the disambiguating probe; on Linux and Windows an empty successful
    // read means an empty clipboard.
    return { outcome: "empty", reason: "the clipboard program returned no bytes" };
  }
  for (const pattern of NO_SESSION) {
    if (pattern.test(result.stderr)) {
      return unavailable("session", `the clipboard backend could not reach a display: ${result.stderr.trim()}`);
    }
  }
  for (const pattern of EMPTY_SELECTION) {
    if (pattern.test(result.stderr)) {
      return {
        outcome: "empty",
        reason: `the display was reachable and the selection holds nothing: ${result.stderr.trim()}`,
      };
    }
  }
  return {
    outcome: "failed",
    reason: `the clipboard program exited ${result.code}: ${result.stderr.trim()}`,
  };
}

/**
 * Read the macOS disambiguating probe.
 *
 * Empty output means the pasteboard genuinely holds nothing (recorded).
 * Non-empty means it holds SOMETHING that `pbpaste` would not give us, which
 * is a different answer and a different instruction to the caller.
 */
export function classifyClipboardInfo(stdout: string): "empty" | "noTextFlavour" {
  return stdout.trim() === "" ? "empty" : "noTextFlavour";
}
