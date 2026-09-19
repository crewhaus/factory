/**
 * `OpenExternal` — handing something to whatever the operating system has
 * registered for it, which is the widest-reaching thing in this package.
 *
 * "Open this" and "run this" are the SAME GESTURE to a desktop. `open` on a
 * `.command` file runs it in Terminal; `xdg-open` on a file whose type is
 * associated with an interpreter runs it; `Start-Process` on a `.ps1` or a
 * `.bat` runs it. And the URL side is worse than the file side, because the
 * scheme table on a real machine is enormous and mostly undocumented:
 * `file://` reaches the filesystem with no containment, `smb://` mounts a
 * remote share (and leaks an authentication handshake to whoever owns the
 * host in the URL), and Windows `ms-*` handlers reach settings pages, the
 * Store, and on unpatched builds have been argument-injection vectors in
 * their own right.
 *
 * SO THE GATE IS AN ALLOW-LIST, AND IT IS SHORT.
 *
 *   - Anything with a URI scheme must have one of `https`, `http`, `mailto`.
 *     Every other scheme is refused by name. There is no input that widens
 *     this set — `allowSchemes` can only NARROW it, because a knob that
 *     re-enables `smb:` is the hole with extra steps.
 *   - THE STRING THAT IS CHECKED IS THE STRING THAT IS OPENED. An http(s) URL
 *     is handed to the desktop in the WHATWG parser's NORMALISED form, not as
 *     the caller typed it, because a gate that validates one spelling and
 *     passes on another is not a gate. A backslash — where WHATWG and CFURL
 *     disagree outright — is refused rather than folded, and credentials
 *     before the `@` are refused too: they end up in a process listing and in
 *     the transcript, and `https://google.com@evil.example/` reads as the
 *     host it is not.
 *   - A `mailto:` may carry only the headers RFC 6068 calls safe. `attach=`
 *     is the reason: a client that honours it reads a local file into a
 *     message, which is `file:`'s hole with a mail client in the middle.
 *   - Anything without a scheme is a PATH, and goes through `../paths.ts`'s
 *     containment (the workspace root, resolved, symlinks followed) before it
 *     is allowed to exist. A local file is opened by naming its path, never
 *     by building a `file://` URL — that way there is exactly one code path
 *     that decides whether a path is reachable.
 *   - An EXECUTABLE file is refused even inside the workspace. It is the one
 *     case where the caller may have meant "open" and the OS will hear "run".
 *
 * The three openers also disagree about `--`, so this file does not assume:
 *   macOS     `open` honours it. Verified on 26.6.2: `open -- -a` answers
 *             "The file /private/tmp/-a does not exist", while `open -a`
 *             answers "open: option requires an argument -- a".
 *   Linux     `xdg-open` does NOT. It rejects any argument beginning with `-`
 *             as an unknown option, `--` included, so passing one would break
 *             every call. Flag-shaped targets are REFUSED instead.
 *   Windows   argv is not the channel at all — the target crosses in the
 *             environment and `Start-Process -FilePath $env:…` reads it. Not
 *             the `start` shell builtin, which treats a first quoted argument
 *             as a window title and splits an unquoted one on `&`, so a URL
 *             with a query string opens something other than what was asked.
 */
import { type HostPlatform, type SessionEnv, linuxDisplayEnv, linuxSession } from "../host";
import type { RunRequest } from "../run";
import { looksLikeFlag, powershellArgv, registerPowerShellScript } from "./escape";
import { type PathFacts, isExecutable } from "./fsseam";
import { type Unavailable, unavailable, unsupportedPlatform } from "./outcome";

/**
 * The schemes this package will hand to the OS, and the complete list.
 *
 * Deliberately three. `mailto` is here because composing a message is the one
 * non-web thing a harness plausibly wants, and it reaches a compose window
 * rather than a filesystem or a network share.
 */
export const OPENABLE_SCHEMES = ["https", "http", "mailto"] as const;
export type OpenableScheme = (typeof OPENABLE_SCHEMES)[number];

/**
 * Schemes named in the refusal, because a caller who tried one deserves to
 * know it was recognised and rejected rather than merely unparsed.
 */
const NOTABLE_REFUSALS: ReadonlyMap<string, string> = new Map([
  ["file", "a file: URL bypasses this package's path containment — pass the path itself instead"],
  [
    "smb",
    "an smb: URL mounts a remote share and can leak an authentication handshake to the host named in it",
  ],
  ["nfs", "an nfs: URL mounts a remote share"],
  ["ftp", "an ftp: URL is handed to a helper with no transport security"],
  ["javascript", "a javascript: URL runs in whichever browser profile is registered"],
  [
    "data",
    "a data: URL carries its payload inline and is handled by whatever claims the media type",
  ],
  ["vbscript", "a vbscript: URL is a script, not a document"],
  ["ms-settings", "an ms-* URL reaches a Windows shell handler rather than a document"],
  ["shell", "a shell: URL reaches the Windows shell namespace"],
  ["search-ms", "a search-ms: URL reaches a Windows shell handler"],
]);

export const WINDOWS_OPEN_SCRIPT = registerPowerShellScript({
  name: "open-external",
  // `-FilePath` takes the target as DATA from the environment. Nothing is
  // interpolated into this string, so a target containing a quote, a
  // semicolon or a `$(...)` is a string to Start-Process and not source.
  script: "Start-Process -FilePath $env:CREWHAUS_OPEN_TARGET",
  reads: ["CREWHAUS_OPEN_TARGET"],
});

/**
 * Headers a `mailto:` URI may carry.
 *
 * RFC 6068 §5 is explicit that only a short list is safe to create or act on,
 * and this is that list. Everything else is refused BY NAME, `attach` and
 * `attachment` above all: a mail client that honours them reads a LOCAL FILE
 * off the disk and puts it in a message addressed to whoever the URI names.
 * That is the same hole `file:` is refused for at the top of this file —
 * reaching the filesystem without passing this package's containment — with a
 * mail client in the middle, so refusing one and not the other would be a
 * gate with a door beside it.
 */
const MAILTO_SAFE_HEADERS: ReadonlySet<string> = new Set([
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "in-reply-to",
]);

/** What the caller's string turned out to be. */
export type OpenTarget =
  | {
      readonly kind: "url";
      readonly scheme: OpenableScheme;
      /**
       * THE STRING THAT IS HANDED TO THE OPERATING SYSTEM, and the string this
       * function validated — they are the same object on purpose. See
       * `classifyTarget`.
       */
      readonly value: string;
      /** The caller's own text, when normalising changed it. For the result. */
      readonly given?: string;
    }
  | { readonly kind: "path"; readonly value: string };

export type TargetDecision =
  | { readonly ok: true; readonly target: OpenTarget }
  | { readonly ok: false; readonly reason: string; readonly scheme?: string };

/**
 * Does this string carry a URI scheme?
 *
 * RFC 3986: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"`. The
 * single-letter carve-out is for Windows: `C:\Users\…` matches the scheme
 * production exactly, and classifying a drive path as a `c:` URL would refuse
 * every absolute Windows path with a baffling message.
 */
export function uriScheme(value: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (match?.[1] === undefined) return undefined;
  const scheme = match[1];
  if (scheme.length === 1 && /^[A-Za-z]:[\\/]/.test(value)) return undefined;
  return scheme.toLowerCase();
}

/**
 * Decide what a caller's target is, or refuse it.
 *
 * Returns the URL case resolved; a path is handed back for the caller to
 * contain, because containment needs the filesystem and this function is
 * pure.
 */
export function classifyTarget(target: string, allowed: readonly OpenableScheme[]): TargetDecision {
  const trimmed = target.trim();
  if (trimmed === "") return { ok: false, reason: "the target is empty" };
  // Checked before anything else: a NUL truncates the argument at the syscall
  // boundary, so the OS would open a shorter string than the one validated.
  if (trimmed.includes("\u0000")) {
    return { ok: false, reason: "the target contains a NUL byte" };
  }
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, reason: "the target contains a newline" };
  }
  const scheme = uriScheme(trimmed);
  if (scheme === undefined) {
    if (looksLikeFlag(trimmed)) {
      // `xdg-open` has no `--`, so this cannot be defended downstream.
      return {
        ok: false,
        reason:
          'the target begins with "-", which every opener here would read as an option rather than as a file',
      };
    }
    return { ok: true, target: { kind: "path", value: trimmed } };
  }
  if (!(OPENABLE_SCHEMES as readonly string[]).includes(scheme)) {
    const why = NOTABLE_REFUSALS.get(scheme);
    return {
      ok: false,
      scheme,
      reason:
        why === undefined
          ? `the scheme "${scheme}:" is not one this tool opens; it hands only ${OPENABLE_SCHEMES.join(", ")} to the operating system`
          : `the scheme "${scheme}:" is refused — ${why}`,
    };
  }
  if (!allowed.includes(scheme as OpenableScheme)) {
    return {
      ok: false,
      scheme,
      reason: `the scheme "${scheme}:" is openable but this call narrowed the allowed set to ${allowed.join(", ")}`,
    };
  }
  // A URL this parser cannot make sense of is refused rather than handed on:
  // this parser and the OS's disagreeing is how a target that passes a check
  // here opens something else there.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, scheme, reason: "the URL could not be parsed" };
  }
  if (scheme === "mailto") {
    // `new URL` does not decompose a mailto:, so the query is read by hand.
    const query = trimmed.slice(trimmed.indexOf("?") + 1);
    if (trimmed.includes("?")) {
      for (const [rawKey] of new URLSearchParams(query)) {
        const key = rawKey.toLowerCase();
        if (!MAILTO_SAFE_HEADERS.has(key)) {
          return {
            ok: false,
            scheme,
            reason:
              key === "attach" || key === "attachment"
                ? `the mailto: header "${rawKey}" asks a mail client to read a LOCAL FILE into the message, which walks around the same path containment that file: URLs are refused for — it is not one of the headers this tool passes on (${[...MAILTO_SAFE_HEADERS].join(", ")})`
                : `the mailto: header "${rawKey}" is not one RFC 6068 calls safe to act on; this tool passes only ${[...MAILTO_SAFE_HEADERS].join(", ")}`,
          };
        }
      }
    }
    return { ok: true, target: { kind: "url", scheme: "mailto", value: trimmed } };
  }
  if (parsed.hostname === "") return { ok: false, scheme, reason: "the URL has no host" };
  // CREDENTIALS BEFORE THE `@` ARE REFUSED, not passed on. Two reasons, and
  // the second is the one that made this a review finding: a password in a
  // URL is put into an argv (world-readable through `ps` on every platform
  // here), into the result, and from there into the transcript and any log
  // the harness keeps; and `https://google.com@evil.example/` reads to a
  // human — and to a model checking the result — as google.com while the
  // browser goes to evil.example.
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      scheme,
      reason: `the URL carries credentials before the "@" (host: ${parsed.hostname}); they would be visible in a process listing and in this run's transcript, and a "user@host" prefix reads as the host it is not — pass the URL without them`,
    };
  }
  // A BACKSLASH IS REFUSED RATHER THAN FOLDED. The WHATWG parser above
  // rewrites `\` to `/` in a special scheme; CFURL (macOS `open`) and most
  // other parsers do not. `https://example.com\@evil.example/` is therefore
  // host `example.com` HERE and host `evil.example` THERE — the check passes
  // on one string and the desktop opens another. Nothing legitimate needs a
  // backslash in a URL, so the disagreement is refused instead of resolved.
  if (trimmed.includes("\\")) {
    return {
      ok: false,
      scheme,
      reason:
        'the URL contains a backslash; URL parsers disagree about whether that is a path separator, so the host this tool checked would not be the host the operating system opened — send the URL with "/"',
    };
  }
  // THE NORMALISED FORM IS WHAT IS OPENED. Handing the OS the caller's raw
  // text while validating the parse is how the two come apart
  // (`https:evil.example` and `https://EVIL.example` are the parser's
  // problem, not the desktop's) — so the string that passed the checks above
  // is the string that travels.
  const normalized = parsed.href;
  return {
    ok: true,
    target: {
      kind: "url",
      scheme: scheme as OpenableScheme,
      value: normalized,
      ...(normalized === trimmed ? {} : { given: trimmed }),
    },
  };
}

/**
 * Extensions a desktop RUNS, or that redirect somewhere this tool cannot see.
 *
 * The POSIX execute bit is not enough on its own, for three reasons found
 * while reviewing this file:
 *
 *   - Windows has no execute bit worth reading. `statSync` there reports a
 *     mode with no `0o111` set for a perfectly runnable `.bat`, so the mode
 *     check passes it and `Start-Process` runs it.
 *   - a macOS `.app` is a DIRECTORY, so `facts.isFile` is false and the mode
 *     check never even applies — while `open Foo.app` launches it.
 *   - `.desktop`, `.lnk`, `.url` and `.webloc` are INDIRECTION. They contain a
 *     target, and opening one reaches a program or a URL that never passed
 *     the scheme allow-list at the top of this file. A `.url` file holding
 *     `URL=file:///etc/passwd` walks straight around the gate.
 */
const DANGEROUS_EXTENSIONS = new Set([
  // runs directly
  "exe",
  "com",
  "scr",
  "bat",
  "cmd",
  "pif",
  "msi",
  "msp",
  "cpl",
  "hta",
  "reg",
  "ps1",
  "psm1",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "js",
  "jse",
  "jar",
  "sh",
  "bash",
  "zsh",
  "fish",
  "command",
  "tool",
  "run",
  "bin",
  "out",
  // macOS bundles and automation
  "app",
  "pkg",
  "dmg",
  "workflow",
  "scpt",
  "scptd",
  "applescript",
  "terminal",
  // indirection — the target never passes the scheme gate
  "desktop",
  "lnk",
  "url",
  "webloc",
  "inetloc",
  "inf",
]);

/** The lowercase extension, or `""`. */
export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Why a contained path is still not openable.
 *
 * `undefined` means it is. The two executable refusals are the substantive
 * ones — see the header and `DANGEROUS_EXTENSIONS`.
 */
export function refusePath(absolutePath: string, facts: PathFacts | undefined): string | undefined {
  if (facts === undefined || !facts.exists) {
    return "the path does not exist (or its parent could not be read)";
  }
  const extension = extensionOf(absolutePath);
  if (DANGEROUS_EXTENSIONS.has(extension)) {
    return `the path ends in ".${extension}", which a desktop either RUNS or follows to a target this tool never got to check — "open this" and "run this" are the same gesture to an operating system, so it is refused`;
  }
  if (facts.isFile && isExecutable(facts)) {
    return "the path is an executable file, and asking a desktop to OPEN one is how it gets RUN — this tool refuses, whatever the registered handler would have done";
  }
  return undefined;
}

export type OpenPlan =
  | { readonly ok: true; readonly backend: string; readonly request: Omit<RunRequest, "timeoutMs"> }
  | { readonly ok: false; readonly unavailable: Unavailable };

/** Build the argv (or the env channel) that would open an accepted target. */
export function planOpen(platform: HostPlatform, env: SessionEnv, value: string): OpenPlan {
  switch (platform) {
    case "darwin":
      // `-n` is NOT passed: it forces a new instance of the handling app,
      // which for a browser means a second profile window rather than a tab.
      return { ok: true, backend: "open", request: { argv: ["open", "--", value] } };
    case "linux": {
      const session = linuxSession(env);
      if (session.kind === "none" || session.kind === "wayland-unreachable") {
        return { ok: false, unavailable: unavailable("session", session.reason, "xdg-open") };
      }
      if (looksLikeFlag(value)) {
        // Unreachable after `classifyTarget`, and asserted anyway: xdg-open
        // has no `--`, so this is the last place the guarantee can hold.
        return {
          ok: false,
          unavailable: unavailable(
            "program",
            'the target begins with "-" and xdg-open has no "--" to separate options from arguments',
            "xdg-open",
          ),
        };
      }
      return {
        ok: true,
        backend: "xdg-open",
        request: { argv: ["xdg-open", value], env: linuxDisplayEnv(env) },
      };
    }
    case "win32": {
      const built = powershellArgv(WINDOWS_OPEN_SCRIPT, { CREWHAUS_OPEN_TARGET: value });
      return {
        ok: true,
        backend: "powershell Start-Process",
        request: { argv: built.argv, env: built.env },
      };
    }
    default:
      return { ok: false, unavailable: unsupportedPlatform(platform, "open") };
  }
}

/**
 * What an opener reported.
 *
 * `handedOff` rather than `opened`: `open` and `xdg-open` both return as soon
 * as the handler has been asked, long before anything is on screen, and
 * neither reports what the handler then did. Claiming more than that is the
 * "silent success" rule 5 names.
 */
export type OpenOutcome =
  | { readonly outcome: "handedOff" }
  | Unavailable
  | { readonly outcome: "failed"; readonly reason: string };

/** xdg-open's documented exit codes. Each is a different instruction. */
const XDG_EXIT: ReadonlyMap<number, string> = new Map([
  [1, "error in the command line syntax"],
  [2, "the file or URL does not exist"],
  [3, "a required tool could not be found"],
  [4, "the action failed"],
]);

export function classifyOpen(
  backend: string,
  result: {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly missing: boolean;
    readonly refused?: boolean;
  },
): OpenOutcome {
  if (result.refused === true) return { outcome: "failed", reason: result.stderr };
  if (result.missing) {
    return unavailable(
      "program",
      `the opener for this platform is not installed on this host (${backend}; on Linux that is xdg-open, from xdg-utils)`,
      backend,
    );
  }
  if (result.timedOut) {
    return {
      outcome: "failed",
      reason:
        "the opener did not finish within its timeout and was killed — whether the handler was reached is unknown",
    };
  }
  if (result.code === 0) {
    // macOS `open` exits 0 even when the file does not exist, printing the
    // complaint on stdout. Recorded on 26.6.2:
    //   $ /usr/bin/open -- /tmp/definitely-not-here-crewhaus-xyz ; echo $?
    //   The file /tmp/definitely-not-here-crewhaus-xyz does not exist.
    //   0
    // Reporting that as a success is precisely the silent success rule 5
    // forbids, so stdout is read on the ZERO-exit path for this one backend.
    if (/does not exist|Unable to find application/i.test(result.stdout)) {
      return { outcome: "failed", reason: result.stdout.trim() };
    }
    return { outcome: "handedOff" };
  }
  const known = XDG_EXIT.get(result.code);
  const detail = result.stderr.trim();
  return {
    outcome: "failed",
    reason:
      known === undefined
        ? `${backend} exited ${result.code}${detail === "" ? "" : `: ${detail}`}`
        : `${backend} exited ${result.code} (${known})${detail === "" ? "" : `: ${detail}`}`,
  };
}
