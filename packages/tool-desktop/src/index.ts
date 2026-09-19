/**
 * `@crewhaus/tool-desktop` — reaching the operator's actual desktop:
 * clipboard, toasts, opening a document, printing, windows, presence and
 * sleep. Eight tools, and every one of them fails closed on a headless host.
 *
 * SIX PROPERTIES HOLD ACROSS ALL OF THEM.
 *
 * 1. **ESCAPING IS THE SECURITY BOUNDARY, NOT A TIDINESS CONCERN.** Two of
 *    the three platforms take SOURCE CODE where it looks like they take text.
 *    `osascript -e` compiles AppleScript, so a notification body with a
 *    double quote in it ends the string literal and the rest RUNS; a Windows
 *    toast is an XML document inside a PowerShell script, so `</toast>` does
 *    the same job one layer over. The answer is not a better escaper. Every
 *    script in this package is a FROZEN MODULE CONSTANT, caller values travel
 *    BESIDE the program (`item N of argv` after `--` on macOS, `$env:…` on
 *    Windows, argv after `--` on Linux), and `./lib/escape.ts` refuses to
 *    build an argv for source it did not register. See that file's header for
 *    the verification, run on this machine, that a value of
 *    `say "hi"; display dialog "x"` comes back as data.
 * 2. **ARGV IS AN ARRAY.** No `sh -c`, no `cmd /c`, no interpolated command
 *    line. `./run.ts`'s `assertArgv` refuses a shell as argv[0] before a
 *    process exists. PowerShell is the one carve-out and is replaced by a
 *    narrower, checkable guarantee — see `run.ts`.
 * 3. **NO PRIVILEGE ESCALATION.** Nothing here runs `sudo`, `doas`, `runas`
 *    or `pkexec`, nothing raises a UAC prompt, and no schema accepts a
 *    password. `assertArgv` enforces the first structurally and
 *    `index.test.ts` asserts both over every recorded call and every schema.
 * 4. **FAIL CLOSED ON A HEADLESS HOST.** CI has no desktop, no clipboard, no
 *    notification daemon, no printer and no window server. Every tool answers
 *    with a typed `unavailable` naming what was missing — a platform, a
 *    program, a session or an OS grant — never a crash, never a silent
 *    success, and never a `false` that reads as "the user is away" when the
 *    truth is "nothing could be asked".
 * 5. **"COULD NOT DETERMINE" IS NOT "NO".** An empty clipboard is not an
 *    unreadable one; a presence probe that failed is not "idle"; a window
 *    list that could not be read is not "no windows"; a printer query that
 *    timed out is not "no printers". Each is a distinct outcome naming its
 *    reason, and every nullable field that came back null carries an entry in
 *    `unknown` saying which probe failed and why.
 * 6. **A STATE-CHANGING TOOL SAYS SO AND OFFERS `dryRun`.** The dry run
 *    resolves through the SAME function as the real path and stops before the
 *    effect — it is never a parallel preview, which is how tool-hostfs's
 *    TrashPath once predicted a destination the real call never used.
 *
 * The seams are `_setRunner` and `_setDetacher` (every child process),
 * `_setPlatform`, `_setSessionEnv`, `_setClock` and `_setFs`. The suite
 * drives all of them, and the un-injected platform is deliberately a platform
 * no backend serves — see `./host.ts`.
 */
import { join } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type HostPlatform, hostPlatform, now, sessionEnv } from "./host";
import {
  type ClipboardFormat,
  classifyClipboardInfo,
  classifyClipboardRead,
  planClipboardRead,
  planClipboardWrite,
} from "./lib/clipboard";
import { osascriptProgramText } from "./lib/escape";
import { fs } from "./lib/fsseam";
import { type NotifyUrgency, classifyNotify, planNotify } from "./lib/notify";
import {
  OPENABLE_SCHEMES,
  type OpenableScheme,
  classifyOpen,
  classifyTarget,
  planOpen,
  refusePath,
} from "./lib/open";
import { type UnknownFact, Unknowns, unavailable, unsupportedPlatform } from "./lib/outcome";
import {
  type AssertionScope,
  type AssertionState,
  DEFAULT_HOLD_MINUTES,
  MAX_HOLD_MINUTES,
  SAFE_REASON,
  STATE_RELATIVE_PATH,
  boundedSeconds,
  classifyLiveness,
  isAssertionState,
  planHold,
  planProcessProbe,
  planRelease,
} from "./lib/power";
import {
  parseIoregIdleSeconds,
  parseIoregLocked,
  parseLoginctl,
  parseWindowsPresence,
  parseXprintidleSeconds,
  planPresence,
  sessionKind,
} from "./lib/presence";
import {
  DUPLEX_VALUES,
  type Duplex,
  MAX_COPIES,
  classifyPrint,
  parseQueues,
  planPrint,
  planPrinterProbe,
  refusePrintOptions,
  unreadableQueues,
} from "./lib/print";
import { classifyWindowList, planWindowList } from "./lib/windows";
import { ToolPermissionError, resolveSafe, workspaceRoot } from "./paths";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  type RunRequest,
  type RunResult,
  capText,
  detachHostCommand,
  runHostCommand,
} from "./run";

export { _setRunner, _setDetacher, _resetRunSeams, _allowRealHost } from "./run";
export type { Runner, Detacher, RunRequest, RunResult, DetachResult } from "./run";
export {
  _setPlatform,
  _setSessionEnv,
  _setClock,
  _resetHostSeams,
  realHostPlatform,
  HEADLESS_ENV,
} from "./host";
export type { HostPlatform, SessionEnv } from "./host";
export { _setFs } from "./lib/fsseam";
export type { HostFs, PathFacts } from "./lib/fsseam";
export { ToolPermissionError } from "./paths";

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

const timeoutSchema = z
  .number()
  .int()
  .min(100)
  .max(MAX_COMMAND_TIMEOUT_MS)
  .optional()
  .describe(
    `milliseconds any single command may take before it is SIGTERMed (default ${DEFAULT_COMMAND_TIMEOUT_MS})`,
  );

const dryRunSchema = z
  .boolean()
  .optional()
  .describe(
    "resolve everything and report exactly what would run, without doing it (default false); the same code decides the plan either way",
  );

/**
 * Run one command through the seam.
 *
 * Every tool goes through here so that `timeoutMs` and the abort signal are
 * applied in one place, and so the recorded-argv tests see one shape.
 */
async function run(
  request: Omit<RunRequest, "timeoutMs">,
  timeoutMs: number,
  signal?: AbortSignal,
  maxOutputChars?: number,
): Promise<RunResult> {
  return runHostCommand({
    ...request,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
  });
}

/** The argv of a planned command, for a result or a `dryRun`. */
function planJson(request: Omit<RunRequest, "timeoutMs">): Record<string, unknown> {
  const text = osascriptProgramText(request.argv);
  return {
    argv: request.argv,
    // The script source, when there is one, so a caller reading a dry run can
    // see for itself that no value of theirs is inside it.
    ...(text === "" ? {} : { programText: text }),
    ...(request.env === undefined ? {} : { env: Object.keys(request.env).sort() }),
    ...(request.stdin === undefined ? {} : { stdinBytes: request.stdin.length }),
  };
}

// ---------------------------------------------------------------------------
// ClipboardRead
// ---------------------------------------------------------------------------

/** The read cap, in characters. A clipboard can hold a whole file. */
const DEFAULT_CLIPBOARD_MAX_CHARS = 20_000;
const MAX_CLIPBOARD_MAX_CHARS = 1_000_000;

export const clipboardRead: RegisteredTool = buildTool({
  name: "ClipboardRead",
  description:
    'Read the operator\'s system clipboard as text. WHAT THE CALLER TAKES ON: the clipboard is where people put a password, a recovery code or an API key for the seconds between copying and pasting it, and whatever is on it when this runs is returned verbatim into the model\'s context, from there into the conversation transcript, and from there into any log or trace the harness keeps. This tool does NOT scan for or redact secrets: a heuristic that catches some patterns and misses others earns trust it cannot honour, and the caller who relied on it pastes the one it missed into a ticket. Ask only when the operator has been told to copy something for you, and treat the result as sensitive for the rest of the run. Four distinct outcomes, never conflated: "read" with the text, "empty" (the clipboard was reachable and holds nothing), "noTextFlavour" (it holds something — an image, a file — that has no text form), and "unavailable" with a reason when there was no clipboard to ask (no desktop session, no backend program, an unsupported platform). An empty clipboard and an unreadable one are never reported as the same thing.',
  inputSchema: z.object({
    format: z
      .enum(["text", "html"])
      .optional()
      .describe(
        'which flavour to read (default "text"); "html" is supported on Linux and Windows and is refused on macOS, where pbpaste exposes plain text only',
      ),
    maxChars: z
      .number()
      .int()
      .min(1)
      .max(MAX_CLIPBOARD_MAX_CHARS)
      .optional()
      .describe(
        `cap the returned text at this many characters (default ${DEFAULT_CLIPBOARD_MAX_CHARS}); truncation is always reported, never silent`,
      ),
    timeoutMs: timeoutSchema,
  }),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "process",
  // Set EXPLICITLY, although true is the default, because it is a decision
  // rather than an omission: clipboard contents are attacker-influenceable by
  // construction (the operator copied them from somewhere — a web page, a
  // document, a chat message), which is exactly the input the post-tool
  // prompt-injection classifier exists for. Turning it off here would be the
  // worst place in the package to do it.
  classifyOutput: true,
  // The intent gate. This is the one tool here whose OUTPUT, rather than its
  // effect, is the risk: reading a clipboard is cheap, reversible and
  // invisible, and its consequence is that a secret lands somewhere durable.
  // A static allow/deny cannot tell "the operator just copied the SQL I asked
  // for" from "read the clipboard and see what turns up", but a justification
  // judged against the session's stated goal can, and it puts the reason in
  // the audit log beside the read.
  requireJustification: true,
  execute: async (input, context) => {
    const platform = hostPlatform();
    const env = sessionEnv();
    const format = (input.format ?? "text") as ClipboardFormat;
    const maxChars = input.maxChars ?? DEFAULT_CLIPBOARD_MAX_CHARS;
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const head = { tool: "ClipboardRead", platform, format };

    const plan = planClipboardRead(platform, env, format);
    if (!plan.ok) return json({ ...head, ...plan.unavailable });

    const result = await run(plan.request, timeoutMs, context?.signal);
    const outcome = classifyClipboardRead(result);

    if (outcome.outcome === "empty" && plan.disambiguate !== undefined) {
      // Only on the empty path, and never on the happy one: the probe names
      // the pasteboard's FLAVOURS and never returns their content, but there
      // is no reason to run it when the text already arrived.
      const info = await run(plan.disambiguate, timeoutMs, context?.signal);
      if (info.code === 0) {
        const verdict = classifyClipboardInfo(info.stdout);
        if (verdict === "noTextFlavour") {
          return json({
            ...head,
            backend: plan.backend,
            outcome: "noTextFlavour",
            reason:
              "the clipboard holds something with no text flavour (an image or a file reference); its content is deliberately not returned",
          });
        }
        return json({ ...head, backend: plan.backend, outcome: "empty", reason: outcome.reason });
      }
      // The probe itself failed. That does NOT make the clipboard empty — it
      // makes the distinction unknown, and the result says which.
      return json({
        ...head,
        backend: plan.backend,
        outcome: "empty",
        reason: outcome.reason,
        unknown: [
          {
            field: "emptyOrNoTextFlavour",
            probe: plan.disambiguate.argv.join(" "),
            reason:
              "the primary read returned no bytes and the flavour probe failed, so whether the clipboard is empty or holds a non-text flavour could not be established",
          },
        ],
      });
    }

    if (outcome.outcome === "read") {
      const capped = capText(outcome.text, maxChars);
      return json({
        ...head,
        backend: plan.backend,
        outcome: "read",
        chars: capped.text.length,
        truncated: capped.truncated || result.stdoutTruncated === true,
        text: capped.text,
      });
    }
    return json({ ...head, backend: plan.backend, ...outcome });
  },
});

// ---------------------------------------------------------------------------
// ClipboardWrite
// ---------------------------------------------------------------------------

export const clipboardWrite: RegisteredTool = buildTool({
  name: "ClipboardWrite",
  description:
    "Put text on the operator's system clipboard, replacing whatever was there. Declared destructive because that replacement cannot be undone: the thing the operator had copied a moment ago is gone, and there is no clipboard history to restore it from. The payload is piped to the backend on STDIN and never appears as a command argument, because argv is world-readable through a process listing on every platform here. Use dryRun to see which backend and argument list would be used without writing anything. On X11 the writing process owns the selection and must outlive this call, which xclip handles by forking its own resident holder — so on Linux the content survives this tool returning, but not the X session ending.",
  inputSchema: z.object({
    text: z
      .string()
      .max(10_000_000)
      .describe(
        "the text to place on the clipboard; it is piped in on stdin, never as an argument",
      ),
    dryRun: dryRunSchema,
    timeoutMs: timeoutSchema,
  }),
  readOnly: false,
  destructive: true,
  concurrencySafe: false,
  scope: "external",
  ioCapability: "process",
  execute: async (input, context) => {
    const platform = hostPlatform();
    const env = sessionEnv();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const head = { tool: "ClipboardWrite", platform };

    // Resolved BEFORE the dryRun branch, by the same call: the dry run and the
    // real write differ only in whether the plan is then executed.
    const plan = planClipboardWrite(platform, env, input.text);
    if (!plan.ok) return json({ ...head, ...plan.unavailable });

    if (input.dryRun === true) {
      return json({
        ...head,
        outcome: "dryRun",
        backend: plan.backend,
        plan: planJson(plan.request),
        wouldWriteChars: input.text.length,
      });
    }

    const result = await run(plan.request, timeoutMs, context?.signal);
    if (result.refused === true) {
      return json({ ...head, outcome: "failed", backend: plan.backend, reason: result.stderr });
    }
    if (result.missing) {
      return json({
        ...head,
        backend: plan.backend,
        ...unavailable(
          "program",
          "the clipboard program for this platform is not installed on this host",
          plan.backend,
        ),
      });
    }
    if (result.timedOut) {
      return json({
        ...head,
        outcome: "failed",
        backend: plan.backend,
        reason:
          "the clipboard writer did not finish within its timeout and was killed — whether the clipboard was replaced is unknown",
      });
    }
    if (result.code !== 0) {
      return json({
        ...head,
        outcome: "failed",
        backend: plan.backend,
        reason: `${plan.backend} exited ${result.code}: ${result.stderr.trim()}`,
      });
    }
    return json({
      ...head,
      outcome: "written",
      backend: plan.backend,
      chars: input.text.length,
    });
  },
});

// ---------------------------------------------------------------------------
// DesktopNotify
// ---------------------------------------------------------------------------

const MAX_NOTIFY_FIELD = 2_000;

export const desktopNotify: RegisteredTool = buildTool({
  name: "DesktopNotify",
  description:
    'Show a notification on the operator\'s desktop — a macOS notification, a FreeDesktop notification on Linux, a toast on Windows. The title, body and subtitle may contain anything at all: on macOS they travel as argv items that the AppleScript reads with `item N of argv`, so a body containing quotes or semicolons is displayed rather than executed, and on Windows they are XML-escaped into a document that crosses to PowerShell through the environment rather than as source. The result says "dispatched", not "shown": every one of these APIs accepts a notification and returns, and whether a human saw it depends on Do Not Disturb, a Focus mode and whether the screen is on — none of which is observable from here. A host with no notification daemon, no display session or no notifier installed is reported as unavailable with the reason.',
  inputSchema: z.object({
    title: z.string().min(1).max(MAX_NOTIFY_FIELD).describe("the notification's title line"),
    body: z.string().max(MAX_NOTIFY_FIELD).describe("the notification's body text"),
    subtitle: z
      .string()
      .max(MAX_NOTIFY_FIELD)
      .optional()
      .describe(
        "a second line, shown as a subtitle on macOS and Windows; the FreeDesktop spec has no subtitle, so on Linux it is folded into the top of the body rather than dropped",
      ),
    urgency: z
      .enum(["low", "normal", "critical"])
      .optional()
      .describe('Linux only; ignored elsewhere (default "normal")'),
    sound: z
      .boolean()
      .optional()
      .describe("play the platform's default notification sound (default false)"),
    expireMs: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .optional()
      .describe(
        "Linux only: how long the notification stays up. Omitted means the flag is not sent at all and the daemon's own default applies - note that 0 is NOT that, it is libnotify's \"never expire\".",
      ),
    dryRun: dryRunSchema,
    timeoutMs: timeoutSchema,
  }),
  readOnly: false,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, context) => {
    const platform = hostPlatform();
    const env = sessionEnv();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const head = { tool: "DesktopNotify", platform };

    const plan = planNotify(platform, env, {
      title: input.title,
      body: input.body,
      ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
      urgency: (input.urgency ?? "normal") as NotifyUrgency,
      sound: input.sound ?? false,
      ...(input.expireMs === undefined ? {} : { expireMs: input.expireMs }),
    });
    if (!plan.ok) return json({ ...head, ...plan.unavailable });

    if (input.dryRun === true) {
      return json({
        ...head,
        outcome: "dryRun",
        backend: plan.backend,
        plan: planJson(plan.request),
        ...(plan.sanitized === true ? { sanitized: true } : {}),
      });
    }

    const result = await run(plan.request, timeoutMs, context?.signal);
    const outcome = classifyNotify(result);
    return json({
      ...head,
      backend: plan.backend,
      ...(plan.sanitized === true
        ? {
            sanitized: true,
            sanitizedReason:
              "characters an XML 1.0 document cannot carry were removed from the text before it was shown",
          }
        : {}),
      ...outcome,
    });
  },
});

// ---------------------------------------------------------------------------
// OpenExternal
// ---------------------------------------------------------------------------

export const openExternal: RegisteredTool = buildTool({
  name: "OpenExternal",
  description: `Hand a URL or a local path to the operating system to open with whatever is registered for it. The scheme set is an ALLOW-LIST and it is short: ${OPENABLE_SCHEMES.join(", ")}. Everything else is refused by name — file: (it would bypass this tool's path containment), smb: and nfs: (they mount a remote share and can leak an authentication handshake to the host named in the URL), javascript:, data:, and the Windows ms-* shell handlers. The allowSchemes input can only NARROW that set, never widen it. What is checked is what is opened: an http(s) URL is handed to the desktop in its normalised form rather than as you typed it, a URL containing a backslash is refused (parsers disagree about whether that is a path separator, so the host checked here would not be the host opened there), a URL carrying credentials before the "@" is refused (they would sit in a process listing and in this transcript, and "google.com@evil.example" reads as the host it is not), and a mailto: may carry only the headers RFC 6068 calls safe — attach= is refused by name, because a mail client that honours it reads a local file into the message. A target with no scheme is treated as a filesystem path, resolved inside the workspace root with symlinks followed, and refused if it lands outside; an EXECUTABLE file is refused even inside the workspace, because "open this" and "run this" are the same gesture to a desktop. The result says "handedOff", not "opened": every opener returns as soon as the handler has been asked and none of them report what it then did.`,
  inputSchema: z.object({
    target: z
      .string()
      .min(1)
      .max(4_096)
      .describe(
        "an https, http or mailto URL, or a path relative to the workspace root (or absolute inside it)",
      ),
    allowSchemes: z
      .array(z.enum(OPENABLE_SCHEMES))
      .min(1)
      .optional()
      .describe(
        `narrow the schemes this call will open to a subset of ${OPENABLE_SCHEMES.join(", ")} (default: all three). This cannot widen the set — there is no input that makes file:, smb: or ms-* openable.`,
      ),
    dryRun: dryRunSchema,
    timeoutMs: timeoutSchema,
  }),
  readOnly: false,
  concurrencySafe: false,
  scope: "external",
  ioCapability: "process",
  execute: async (input, context) => {
    const platform = hostPlatform();
    const env = sessionEnv();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const head = { tool: "OpenExternal", platform };
    const allowed = (input.allowSchemes ?? [...OPENABLE_SCHEMES]) as OpenableScheme[];

    const decision = classifyTarget(input.target, allowed);
    if (!decision.ok) {
      return json({
        ...head,
        outcome: "refused",
        reason: decision.reason,
        ...(decision.scheme === undefined ? {} : { scheme: decision.scheme }),
        allowedSchemes: allowed,
      });
    }

    let value = decision.target.value;
    let resolvedPath: string | undefined;
    if (decision.target.kind === "path") {
      let safe: ReturnType<typeof resolveSafe>;
      try {
        safe = resolveSafe("OpenExternal", decision.target.value);
      } catch (err) {
        if (err instanceof ToolPermissionError) {
          return json({
            ...head,
            outcome: "refused",
            reason: err.message,
            kind: "path",
          });
        }
        throw err;
      }
      const refusal = refusePath(safe.real, fs().stat(safe.real));
      if (refusal !== undefined) {
        return json({ ...head, outcome: "refused", reason: refusal, kind: "path", path: safe.rel });
      }
      // The REAL path is what is opened: symlinks already followed, so the
      // desktop opens the thing containment actually approved.
      value = safe.real;
      resolvedPath = safe.rel;
    }

    const plan = planOpen(platform, env, value);
    if (!plan.ok) return json({ ...head, ...plan.unavailable });

    const kindFields = {
      kind: decision.target.kind,
      ...(decision.target.kind === "url"
        ? {
            scheme: decision.target.scheme,
            // Reported whenever normalising changed the caller's text, so a
            // rewrite the gate performed is visible rather than silent — the
            // URL that was checked IS the URL that was opened, and the caller
            // can see when the two differ from what they sent.
            ...(decision.target.given === undefined
              ? {}
              : { url: decision.target.value, given: decision.target.given }),
          }
        : {}),
      ...(resolvedPath === undefined ? {} : { path: resolvedPath }),
    };

    if (input.dryRun === true) {
      return json({
        ...head,
        outcome: "dryRun",
        backend: plan.backend,
        ...kindFields,
        plan: planJson(plan.request),
      });
    }

    const result = await run(plan.request, timeoutMs, context?.signal);
    return json({
      ...head,
      backend: plan.backend,
      ...kindFields,
      ...classifyOpen(plan.backend, result),
    });
  },
});

// ---------------------------------------------------------------------------
// PrintDocument
// ---------------------------------------------------------------------------

export const printDocument: RegisteredTool = buildTool({
  name: "PrintDocument",
  description:
    'Send a local file to a printer through CUPS (macOS and Linux) or to a Windows queue. The queue is probed with lpstat FIRST, on both the dry run and the real print, so the two resolve through the same code and a dry run is a prefix of the real thing rather than a separate prediction. That probe is also what keeps the answers apart: a host whose scheduler is not running prints nothing and lists nothing, which looks exactly like a host with no printers, and the two are reported differently. Declared destructive because paper and toner do not come back. On Windows the honest scope is narrow and stated rather than papered over: Out-Printer sends TEXT to a queue and cannot rasterise a PDF or an image, and it has no copies, duplex or page-range option — asking for one there is refused by name instead of silently dropped. Printer names and page ranges are matched against closed patterns and refused if they do not fit, because lp documents no "--" and a destination beginning with "-" would become an option.',
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(4_096)
      .describe("the document, as a path relative to the workspace root (or absolute inside it)"),
    printer: z
      .string()
      .max(127)
      .optional()
      .describe("the CUPS destination or Windows queue name; omitted means the system default"),
    copies: z
      .number()
      .int()
      .min(1)
      .max(MAX_COPIES)
      .optional()
      .describe("how many copies (default 1)"),
    pageRanges: z
      .string()
      .max(200)
      .optional()
      .describe('a CUPS page range such as "1", "1-4" or "1,3,5-9"; CUPS only'),
    duplex: z
      .enum(DUPLEX_VALUES as unknown as [Duplex, ...Duplex[]])
      .optional()
      .describe("two-sided printing; CUPS only"),
    dryRun: dryRunSchema,
    timeoutMs: timeoutSchema,
  }),
  readOnly: false,
  destructive: true,
  concurrencySafe: false,
  scope: "external",
  ioCapability: "process",
  // Printing is the one effect here that spends a physical consumable and
  // cannot be undone by another tool call. The justification is judged
  // against the run's goal and recorded beside the job.
  requireJustification: true,
  execute: async (input, context) => {
    const platform = hostPlatform();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const head = { tool: "PrintDocument", platform };

    let safe: ReturnType<typeof resolveSafe>;
    try {
      safe = resolveSafe("PrintDocument", input.path);
    } catch (err) {
      if (err instanceof ToolPermissionError) {
        return json({ ...head, outcome: "refused", reason: err.message });
      }
      throw err;
    }
    const facts = fs().stat(safe.real);
    if (facts === undefined || !facts.exists || facts.isDirectory) {
      return json({
        ...head,
        outcome: "refused",
        path: safe.rel,
        reason: "the path does not exist, or is a directory",
      });
    }

    const options = {
      absolutePath: safe.real,
      ...(input.printer === undefined ? {} : { printer: input.printer }),
      copies: input.copies ?? 1,
      ...(input.pageRanges === undefined ? {} : { pageRanges: input.pageRanges }),
      ...(input.duplex === undefined ? {} : { duplex: input.duplex as Duplex }),
    };
    const refusal = refusePrintOptions(platform, options);
    if (refusal !== undefined) {
      return json({ ...head, outcome: "refused", path: safe.rel, reason: refusal });
    }

    // The queue probe runs on BOTH paths. See the module header of ./lib/print.
    const probeRequest = planPrinterProbe(platform);
    if (probeRequest === undefined) {
      return json({ ...head, ...unsupportedPlatform(platform, "printing") });
    }
    const probe = await run(probeRequest, timeoutMs, context?.signal);
    const queues =
      probe.refused === true || probe.missing || probe.timedOut
        ? unreadableQueues(
            probe.missing
              ? "lpstat is not installed on this host, so the queue could not be read"
              : probe.timedOut
                ? "the queue probe did not finish within its timeout and was killed, so whether this host has printers is unknown — it is NOT that it has none"
                : probe.stderr,
          )
        : parseQueues(probe.stdout, probe.stderr);

    const queueJson = {
      printers: queues.printers,
      defaultPrinter: queues.defaultPrinter,
      ...(queues.schedulerDown ? { schedulerDown: true } : {}),
      ...(queues.unreadable === null ? {} : { queueUnreadable: queues.unreadable }),
    };

    if (queues.schedulerDown) {
      return json({
        ...head,
        path: safe.rel,
        queue: queueJson,
        ...unavailable(
          "program",
          "the print scheduler is not running on this host, so no queue would accept this job — that is not the same as the host having no printers",
          "cupsd",
        ),
      });
    }

    const plan = planPrint(platform, options);
    if (!plan.ok) return json({ ...head, path: safe.rel, queue: queueJson, ...plan.unavailable });

    if (input.dryRun === true) {
      return json({
        ...head,
        outcome: "dryRun",
        path: safe.rel,
        backend: plan.backend,
        queue: queueJson,
        plan: planJson(plan.request),
      });
    }

    const result = await run(plan.request, timeoutMs, context?.signal);
    return json({
      ...head,
      path: safe.rel,
      backend: plan.backend,
      queue: queueJson,
      ...classifyPrint(result),
    });
  },
});

// ---------------------------------------------------------------------------
// WindowList
// ---------------------------------------------------------------------------

export const windowList: RegisteredTool = buildTool({
  name: "WindowList",
  description:
    "List the windows open on the operator's desktop, with the app, title and — where the backend can supply them — position and size. It never answers an empty list for a failure: a macOS host that has not granted Accessibility comes back as unavailable naming that grant in System Settings, a Wayland session comes back as unavailable explaining that Wayland provides no protocol for one client to enumerate another's windows (there is nothing to install that would fix it), a missing wmctrl comes back as unavailable naming the package, and a stream cut at the output cap is reported as truncated so the list is read as a prefix rather than as the whole desktop. Fields a backend cannot supply are null rather than zero or false — wmctrl reports no focus state, so every window's focused is null rather than a claim that nothing has focus.",
  inputSchema: z.object({ timeoutMs: timeoutSchema }),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, context) => {
    const platform = hostPlatform();
    const env = sessionEnv();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const head = { tool: "WindowList", platform };

    const plan = planWindowList(platform, env);
    if (!plan.ok) return json({ ...head, ...plan.unavailable });

    const result = await run(plan.request, timeoutMs, context?.signal);
    const outcome = classifyWindowList(plan.backend, result);
    if (outcome.outcome === "listed") {
      return json({
        ...head,
        backend: plan.backend,
        outcome: "listed",
        count: outcome.windows.length,
        truncated: outcome.truncated,
        ...(outcome.truncated
          ? {
              unknown: [
                {
                  field: "windows",
                  probe: plan.request.argv.join(" "),
                  reason:
                    "the enumerator's output hit the capture cap, so this list is a PREFIX of the open windows rather than all of them",
                },
              ],
            }
          : {}),
        windows: outcome.windows,
      });
    }
    return json({ ...head, backend: plan.backend, ...outcome });
  },
});

// ---------------------------------------------------------------------------
// UserPresence
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_THRESHOLD_SECONDS = 300;

export const userPresence: RegisteredTool = buildTool({
  name: "UserPresence",
  description:
    "Report whether a human is likely at this machine: seconds since the last input, whether the screen is locked, and what kind of session this is (console, ssh or headless). Every field is separately nullable and a null always carries an entry in `unknown` naming the probe that failed, because the tempting fallbacks here invert the tool's purpose — reporting idle:false when nothing could be asked tells a workflow the operator is at the keyboard, and reporting idle:true tells it the opposite and sends it off to act unattended. macOS reads idle time out of the IOKit registry, in nanoseconds, and lock state from the same dump; Linux needs xprintidle (usually not installed, and unavailable under Wayland, which exposes no idle query at all) and reads logind's LockedHint, which is a HINT a screen locker has to set and some do not; Windows uses GetLastInputInfo and the presence of LogonUI. An ssh session reports sessionKind \"ssh\" and does not pretend the far end's idle time says anything about the person typing.",
  inputSchema: z.object({
    idleThresholdSeconds: z
      .number()
      .int()
      .min(1)
      .max(86_400)
      .optional()
      .describe(
        `how many idle seconds count as "idle" in the derived boolean (default ${DEFAULT_IDLE_THRESHOLD_SECONDS}); the boolean is null whenever idleSeconds is`,
      ),
    timeoutMs: timeoutSchema,
  }),
  readOnly: true,
  concurrencySafe: true,
  scope: "external",
  ioCapability: "process",
  execute: async (input, context) => {
    const platform = hostPlatform();
    const env = sessionEnv();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const threshold = input.idleThresholdSeconds ?? DEFAULT_IDLE_THRESHOLD_SECONDS;
    const unknowns = new Unknowns();

    let idleSeconds: number | null = null;
    let screenLocked: boolean | null = null;
    let lockedNote: string | undefined;

    const { probes, notes } = planPresence(platform, env);
    for (const [field, reason] of notes) unknowns.add(field, "(no probe on this platform)", reason);

    for (const probe of probes) {
      const result = await run(probe.request, timeoutMs, context?.signal);
      const argvText = probe.request.argv.join(" ");
      if (result.refused === true || result.missing || result.timedOut || result.code !== 0) {
        const why =
          result.refused === true
            ? result.stderr
            : result.missing
              ? "the probe program is not installed on this host"
              : result.timedOut
                ? "the probe did not finish within its timeout and was killed"
                : `the probe exited ${result.code}: ${result.stderr.trim()}`;
        unknowns.add(probe.field, argvText, why);
        if (platform === "win32" && probe.field === "idleSeconds") {
          unknowns.add("screenLocked", argvText, why);
        }
        continue;
      }
      if (platform === "darwin" && probe.field === "idleSeconds") {
        idleSeconds = parseIoregIdleSeconds(result.stdout);
        if (idleSeconds === null) {
          unknowns.add(probe.field, argvText, 'the dump contained no "HIDIdleTime" key');
        }
      } else if (platform === "darwin") {
        screenLocked = parseIoregLocked(result.stdout);
        if (screenLocked === null) {
          unknowns.add(
            probe.field,
            argvText,
            'the dump contained neither "IOConsoleLocked" nor "CGSSessionScreenIsLocked" — this macOS version reports lock state somewhere this parser does not look',
          );
        }
      } else if (platform === "linux" && probe.field === "idleSeconds") {
        idleSeconds = parseXprintidleSeconds(result.stdout);
        if (idleSeconds === null) {
          unknowns.add(probe.field, argvText, "xprintidle printed something that was not a number");
        }
      } else if (platform === "linux") {
        const parsed = parseLoginctl(result.stdout);
        screenLocked = parsed.locked;
        if (parsed.locked === null) {
          unknowns.add(probe.field, argvText, "loginctl reported no LockedHint for this session");
        } else {
          lockedNote =
            'LockedHint is a hint: a screen locker that does not call SetLockedHint leaves it "no" on a locked screen';
        }
      } else if (platform === "win32") {
        const parsed = parseWindowsPresence(result.stdout);
        idleSeconds = parsed.idleSeconds;
        screenLocked = parsed.locked;
        if (parsed.idleSeconds === null) {
          unknowns.add(probe.field, argvText, "GetLastInputInfo could not be called");
        }
        if (parsed.locked === null) {
          unknowns.add("screenLocked", argvText, "the LogonUI probe printed nothing parseable");
        }
      }
    }

    const kind = sessionKind(platform, env);
    if (kind === "ssh" && idleSeconds !== null) {
      // The number is real; what it MEANS is not what the caller wants. Say so
      // rather than deleting it.
      unknowns.add(
        "idle",
        "sessionKind",
        "this is an ssh session, so idle time measures the machine at the far end and not the person running this harness",
      );
    }

    return json({
      tool: "UserPresence",
      platform,
      sessionKind: kind,
      idleSeconds,
      idleThresholdSeconds: threshold,
      // Null in, null out. A derived boolean that defaults is the exact bug
      // this tool exists not to have.
      idle: idleSeconds === null ? null : idleSeconds >= threshold,
      screenLocked,
      ...(lockedNote === undefined ? {} : { screenLockedNote: lockedNote }),
      ...(unknowns.size > 0 ? { unknown: unknowns.list() } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// PowerAssertion
// ---------------------------------------------------------------------------

function statePath(): string {
  return join(workspaceRoot(), STATE_RELATIVE_PATH);
}

/**
 * What the state file says, or why it says nothing usable.
 *
 * Three answers, not two. A file that is ABSENT and a file that is THERE AND
 * UNREADABLE are different facts about this machine, and conflating them is
 * the rule-6 shape one level in from the tools: "no assertion is held" would
 * be a claim, and the file's existence is evidence against it.
 */
type StateRead =
  | { readonly kind: "none" }
  | { readonly kind: "state"; readonly state: AssertionState }
  | { readonly kind: "unreadable"; readonly reason: string };

function readState(): StateRead {
  const text = fs().readText(statePath());
  if (text === undefined) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable", reason: "the state file is not valid JSON" };
  }
  // Every field is validated, not just the two that used to be: a record with
  // a pid and a marker but a missing deadline used to be accepted here and
  // then threw `RangeError: Invalid time value` out of `execute` when the
  // result was formatted. See `isAssertionState`.
  if (!isAssertionState(parsed)) {
    return {
      kind: "unreadable",
      reason:
        "the state file parsed but is not a complete assertion record (it needs pid, marker, backend, platform, scope and numeric startedAt/expiresAt)",
    };
  }
  return { kind: "state", state: parsed };
}

export const powerAssertion: RegisteredTool = buildTool({
  name: "PowerAssertion",
  description: `Hold a BOUNDED sleep inhibitor around a long step, release it, or report on one. The deadline is mandatory and is not enforced by this process: caffeinate exits at its own -t, systemd-inhibit releases when its sleep returns, and the Windows holder parks for a fixed Start-Sleep — so killing the whole harness still ends the assertion on time, which an in-process reaper could not promise. Every result says when the assertion expires. The maximum is ${MAX_HOLD_MINUTES} minutes and the default is ${DEFAULT_HOLD_MINUTES}. A held assertion is remembered in a state file, and release verifies that the recorded pid is still running THIS package's holder before signalling anything: pids are reused, and a stale file must never become a SIGTERM to whatever now owns that number. A probe that could not run at all leaves the state alone and reports "unknown" rather than assuming the holder is gone.`,
  inputSchema: z.object({
    action: z
      .enum(["hold", "release", "status"])
      .describe(
        '"hold" starts a bounded inhibitor, "release" ends the one this package is holding, "status" reports on it without changing anything',
      ),
    scope: z
      .enum(["system", "display"])
      .optional()
      .describe(
        'what to keep awake: "system" prevents idle sleep, "display" also keeps the screen on (default "system")',
      ),
    maxMinutes: z
      .number()
      .min(1)
      .max(MAX_HOLD_MINUTES)
      .optional()
      .describe(
        `how long the inhibitor may last before the holder ends it by itself (default ${DEFAULT_HOLD_MINUTES}, maximum ${MAX_HOLD_MINUTES})`,
      ),
    reason: z
      .string()
      .max(120)
      .optional()
      .describe(
        "a short printable-ASCII note shown to an operator running `systemd-inhibit --list`; Linux only",
      ),
    dryRun: dryRunSchema,
    timeoutMs: timeoutSchema,
  }),
  readOnly: false,
  // "Destructive" is used here in the sense the permission engine cares
  // about: the effect OUTLIVES the call and the process, so it must be gated
  // like one rather than treated as a read. `status` is read-only in
  // practice, but a static flag covers the whole tool and fails closed.
  destructive: true,
  concurrencySafe: false,
  scope: "external",
  ioCapability: "process",
  execute: async (input, context) => {
    const platform = hostPlatform();
    const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const head = { tool: "PowerAssertion", platform, action: input.action };
    const stateRead = readState();
    if (stateRead.kind === "unreadable") {
      // FAIL CLOSED, AND SAY WHICH FILE. A record that exists but cannot be
      // trusted is not "no assertion is held": there may be a holder out
      // there whose pid this file was the only copy of. Nothing is signalled
      // (the pid is exactly the field that cannot be trusted) and nothing is
      // started (a new holder would overwrite the last copy of the old one),
      // and the path is named so an operator can clear it.
      return json({
        ...head,
        outcome: "unreadableState",
        reason: `${stateRead.reason} — so this package cannot say whether an inhibitor it started is still running. Nothing was signalled and nothing was started; any holder recorded there still ends at its own deadline. Delete the file to start again.`,
        statePath: STATE_RELATIVE_PATH,
      });
    }
    const state = stateRead.kind === "state" ? stateRead.state : undefined;

    const liveness = async (
      recorded: AssertionState,
    ): Promise<{ verdict: ReturnType<typeof classifyLiveness>; argv: readonly string[] }> => {
      const probeRequest = planProcessProbe(platform, recorded.pid);
      if (probeRequest === undefined) return { verdict: "unknown", argv: [] };
      const probe = await run(probeRequest, timeoutMs, context?.signal);
      return { verdict: classifyLiveness(recorded.marker, probe), argv: probeRequest.argv };
    };

    const stateJson = (recorded: AssertionState): Record<string, unknown> => ({
      pid: recorded.pid,
      backend: recorded.backend,
      scope: recorded.scope,
      startedAt: new Date(recorded.startedAt).toISOString(),
      expiresAt: new Date(recorded.expiresAt).toISOString(),
      expiresInMs: recorded.expiresAt - now(),
      ...(recorded.reason === null ? {} : { reason: recorded.reason }),
    });

    if (input.action === "status") {
      if (state === undefined) {
        return json({ ...head, outcome: "none", reason: "this package is holding no assertion" });
      }
      const { verdict, argv } = await liveness(state);
      const expired = now() >= state.expiresAt;
      return json({
        ...head,
        outcome:
          verdict === "alive"
            ? expired
              ? "expiring"
              : "held"
            : verdict === "gone"
              ? "expired"
              : verdict,
        ...stateJson(state),
        liveness: verdict,
        probe: argv.join(" "),
        ...(verdict === "unknown"
          ? {
              unknown: [
                {
                  field: "liveness",
                  probe: argv.join(" "),
                  reason:
                    "the process probe could not answer, so whether the holder is still running is unknown — it is NOT that it has stopped",
                },
              ],
            }
          : {}),
      });
    }

    if (input.action === "release") {
      if (state === undefined) {
        return json({ ...head, outcome: "none", reason: "this package is holding no assertion" });
      }
      const { verdict, argv } = await liveness(state);
      if (verdict === "unknown") {
        // The state file is DELIBERATELY left in place: the holder may be
        // alive and merely unreachable to `ps`, and forgetting it would leave
        // an inhibitor nobody can release before its deadline.
        return json({
          ...head,
          outcome: "unknown",
          ...stateJson(state),
          reason:
            "the process probe could not answer, so nothing was signalled and the recorded assertion was kept — it will still end at its own deadline",
          probe: argv.join(" "),
        });
      }
      if (verdict === "gone") {
        fs().remove(statePath());
        return json({
          ...head,
          outcome: "expired",
          ...stateJson(state),
          reason: "the holder had already ended; the recorded assertion was cleared",
        });
      }
      if (verdict === "reused") {
        fs().remove(statePath());
        return json({
          ...head,
          outcome: "stale",
          ...stateJson(state),
          reason:
            "a process with the recorded pid exists but is not this package's holder, so the pid was reused — NOTHING was signalled and the recorded assertion was cleared",
        });
      }
      const killRequest = planRelease(platform, state.pid);
      if (killRequest === undefined) {
        return json({ ...head, ...unsupportedPlatform(platform, "power-assertion") });
      }
      if (input.dryRun === true) {
        return json({
          ...head,
          outcome: "dryRun",
          ...stateJson(state),
          plan: planJson(killRequest),
        });
      }
      const killed = await run(killRequest, timeoutMs, context?.signal);
      if (killed.code !== 0 || killed.refused === true) {
        return json({
          ...head,
          outcome: "failed",
          ...stateJson(state),
          reason: `the release command exited ${killed.code}: ${killed.stderr.trim()}`,
        });
      }
      fs().remove(statePath());
      return json({ ...head, outcome: "released", ...stateJson(state) });
    }

    // ---- hold ----
    const scope = (input.scope ?? "system") as AssertionScope;
    if (input.reason !== undefined && !SAFE_REASON.test(input.reason)) {
      return json({
        ...head,
        outcome: "refused",
        reason:
          "the reason must be 1-120 printable ASCII characters with no control characters or newlines",
      });
    }
    const bounded = boundedSeconds(input.maxMinutes ?? DEFAULT_HOLD_MINUTES);
    if ("refusal" in bounded) {
      return json({ ...head, outcome: "refused", reason: bounded.refusal });
    }

    if (state !== undefined && now() < state.expiresAt) {
      const { verdict } = await liveness(state);
      // "unknown" refuses as firmly as "alive" does, and that is the point.
      // Starting a second holder would overwrite the state file, and the
      // first holder - which may well be running - could then never be
      // released by this package at all. It would still end at its own
      // deadline, but nothing could end it sooner. A recorded assertion
      // already PAST its deadline is safe to replace, which is why the expiry
      // is checked before the probe rather than after it.
      if (verdict === "alive" || verdict === "unknown") {
        return json({
          ...head,
          outcome: verdict === "alive" ? "alreadyHeld" : "refused",
          ...stateJson(state),
          reason:
            verdict === "alive"
              ? "an assertion from this package is already held and has not expired; release it first, or wait for its deadline"
              : "an assertion is recorded and has not expired, and the process probe could not say whether its holder is still running - starting a second one would overwrite the record and leave the first unreleasable, so nothing was started",
        });
      }
    }

    const plan = planHold(platform, scope, bounded.seconds, input.reason ?? null);
    if (!plan.ok) return json({ ...head, ...plan.unavailable });

    const startedAt = now();
    const expiresAt = startedAt + bounded.seconds * 1000;

    if (input.dryRun === true) {
      return json({
        ...head,
        outcome: "dryRun",
        backend: plan.backend,
        scope,
        seconds: bounded.seconds,
        expiresAt: new Date(expiresAt).toISOString(),
        plan: planJson(plan.request),
      });
    }

    const detached = await detachHostCommand({ ...plan.request, timeoutMs });
    if (!detached.ok) {
      return json({
        ...head,
        backend: plan.backend,
        ...(detached.missing
          ? unavailable(
              "program",
              `the sleep inhibitor for this platform is not installed on this host (${plan.marker})`,
              plan.marker,
            )
          : { outcome: "failed", reason: detached.reason }),
      });
    }

    const recorded: AssertionState = {
      pid: detached.pid,
      platform,
      backend: plan.backend,
      marker: plan.marker,
      scope,
      startedAt,
      expiresAt,
      reason: input.reason ?? null,
    };
    fs().writeTextAtomic(statePath(), JSON.stringify(recorded));
    return json({
      ...head,
      outcome: "held",
      backend: plan.backend,
      scope,
      pid: detached.pid,
      seconds: bounded.seconds,
      startedAt: new Date(startedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      note: "the deadline is enforced by the holder itself, so this assertion ends on time even if this harness stops",
    });
  },
});

/** Everything this package registers, in one place for the catalog wiring. */
export const DESKTOP_TOOLS: ReadonlyArray<RegisteredTool> = [
  clipboardRead,
  clipboardWrite,
  desktopNotify,
  openExternal,
  printDocument,
  windowList,
  userPresence,
  powerAssertion,
];

export type { UnknownFact, HostPlatform as DesktopPlatform };
