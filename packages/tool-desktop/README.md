# @crewhaus/tool-desktop

Deterministic access to the operator's desktop: the clipboard, notifications,
opening a document or a page, printing, the window list, whether a person is at
the machine, and keeping it awake. Every tool fails closed on a headless host.

```yaml
tools:
  - all-desktop
```

| Tool | What it does |
|---|---|
| `ClipboardRead` | Read the clipboard as text, returned verbatim |
| `ClipboardWrite` | Put text on the clipboard |
| `DesktopNotify` | Show a local notification |
| `OpenExternal` | Hand a URL or a workspace file to the operating system's registered handler |
| `PrintDocument` | Send a workspace file to a printer through CUPS (macOS, Linux) or a Windows queue |
| `WindowList` | List the open windows |
| `UserPresence` | Report whether a person is likely at the machine |
| `PowerAssertion` | Hold a bounded sleep inhibitor around a long step, release it, or report on one |

## What holds across all of them

- **Escaping is the security boundary.** `osascript -e` compiles AppleScript
  and a Windows toast is XML inside a PowerShell script, so text that looks
  like a value is source code. Every script here is a frozen constant, and
  caller values travel beside the program (argv after `--`, or an environment
  variable), never inside it.
- **Argv is an array.** No `sh -c`, no `cmd /c`, no interpolated command line,
  and nothing runs `sudo`, `doas`, `runas` or `pkexec`.
- **A headless host fails closed.** CI has no desktop, clipboard, notification
  daemon, printer or window server. Each tool answers with a typed
  `unavailable` naming what was missing, never a crash and never a silent
  success.
- **Could not determine is not no.** An empty clipboard is not an unreadable
  one, and a presence probe that failed is not "idle".
- **A state-changing tool says so and offers `dryRun`,** resolved through the
  same function as the real call.

## OpenExternal

"Open this" and "run this" are the same gesture to a desktop, and the URL side
is wider than the file side: the scheme table on a real machine is large and
mostly undocumented. So the gate is an allow-list, and it is short.

- **Schemes.** Only `https`, `http` and `mailto`. Everything else is refused by
  name: `file:` would bypass this tool's path containment; `smb:` and `nfs:`
  mount a remote share and can leak an authentication handshake to the host
  named in the URL; `javascript:` and `data:` run or render content the model
  wrote; the Windows `ms-*` handlers reach settings pages and the Store, and on
  unpatched builds have been argument-injection vectors. `allowSchemes` can
  only narrow the set, never widen it: a knob that re-enables `smb:` is the
  hole with extra steps.
- **What is checked is what is opened.** An http(s) URL is handed to the
  desktop in its normalised (WHATWG) form, not as it was typed, because a gate
  that validates one spelling and passes on another is not a gate. A URL
  containing a backslash is refused: parsers disagree about whether it is a
  path separator, so the host checked here would not be the host opened there.
  Credentials before the `@` are refused: they would sit in a process listing
  and in the transcript, and `google.com@evil.example` reads as the host it is
  not.
- **mailto.** Only the headers RFC 6068 calls safe. `attach=` is refused by
  name, because a mail client that honours it reads a local file into the
  message.
- **Paths.** A target with no scheme is a filesystem path, resolved inside the
  workspace root with symlinks followed, and refused if it lands outside. A
  local file is opened by naming its path, never by building a `file://` URL,
  so exactly one code path decides whether a path is reachable.
- **Files the desktop would run.** An executable file is refused even inside
  the workspace. So is a file whose type the desktop runs, installs or follows
  without an execute bit: scripts, installers and configuration profiles
  (`.jnlp`, `.mobileconfig`, `.msix`, `.py`), and shortcut or location files
  that point somewhere else (`.lnk`, `.url`, `.webloc`, `.fileloc`,
  `.library-ms`).
- **The result says `handedOff`, not `opened`.** Every opener returns as soon
  as the handler has been asked, and none of them reports what the handler then
  did.
- **Gated like a change.** What it opens acts in the operator's own desktop
  session and outlives the call: a browser tab carries the operator's cookies,
  an app keeps running. So the tool is destructive, every call carries a
  justification, and it is an egress sink whose destination the model chooses:
  content that came from a tool result is blocked from reaching it.

The three openers also disagree about `--`: macOS `open` honours it, Linux
`xdg-open` rejects any argument beginning with `-` (so flag-shaped targets are
refused), and on Windows the target crosses in an environment variable read by
`Start-Process -FilePath`, never the `start` builtin.

## ClipboardRead

The clipboard is where people keep a password, a recovery code or an API key
for the seconds between copying and pasting it. Whatever is on it when this
runs is returned verbatim into the model's context, from there into the
conversation transcript, and from there into any log or trace the harness
keeps.

The tool does **not** scan for or redact secrets. A heuristic that catches some
patterns and misses others earns trust it cannot honour, and the caller who
relied on it pastes the one it missed into a ticket. There is no schema knob
for it either, because offering one implies the tool could do it. Ask for the
clipboard only when the operator has been told to copy something for you, and
treat the result as sensitive for the rest of the run. The tool requires a
justification on every call, and its output goes through the runtime's output
classifier.

It has four outcomes and never conflates them: `read` with the text; `empty`
(the clipboard was reachable and holds nothing); `noTextFlavour` (it holds
something, such as an image or a file, that has no text form); and
`unavailable` with a reason when there was no clipboard to ask (no desktop
session, no backend program, an unsupported platform).

## Tests

```
bun test packages/tool-desktop/src
```

Every child process goes through the `_setRunner` and `_setDetacher` seams, and
the platform, session environment, clock and filesystem are injected too, so
the suite runs on a host with no desktop at all.
