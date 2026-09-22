/**
 * `PrintDocument` — the one tool here whose effect is physical.
 *
 * Three things shape this file.
 *
 * 1. **`lp` AND `lpstat` HAVE NO `--`.** CUPS documents no end-of-options
 *    separator for either, so a destination or a page range that begins with
 *    `-` cannot be defended downstream — it is REFUSED here, against a closed
 *    pattern, before an argv exists. (`escape.ts` holds the patterns and the
 *    story of the `git branch -D` injection this repo already shipped once.)
 *    The document path needs no such defence for a different reason: it comes
 *    out of `../paths.ts` containment already absolute, so it begins with `/`.
 *
 * 2. **THE QUEUE IS PROBED FIRST, ON BOTH PATHS.** `lpstat -p -d` runs before
 *    `lp` on a real print AND is the whole of a `dryRun`. That is not a
 *    courtesy: it is what makes rule 9 true here. The dry run is a PREFIX of
 *    the real run rather than a parallel preview that predicts a destination
 *    the real call never uses — the drift that happened in tool-hostfs's
 *    TrashPath. It also buys the rule-6 distinction: a host whose scheduler
 *    is down prints "Scheduler is not running." and lists nothing, which
 *    reads exactly like a host with zero queues, and the two are different
 *    answers.
 *
 * 3. **WINDOWS IS A NAMED GAP, NOT A PAPERED-OVER ONE.** `Out-Printer` sends
 *    TEXT to a queue. It cannot rasterise a PDF, a PNG or anything else, and
 *    there is no PDF renderer in the Windows base image to pipe one through.
 *    So a `.txt` prints and everything else comes back `unavailable` saying
 *    exactly that, rather than silently spooling a page of mojibake. CUPS
 *    options (copies beyond one, duplex, page ranges) have no Out-Printer
 *    equivalent either, so asking for one on Windows is refused by name
 *    instead of being dropped.
 */
import type { HostPlatform } from "../host";
import type { RunRequest } from "../run";
import {
  SAFE_DESTINATION,
  SAFE_PAGE_RANGES,
  powershellArgv,
  registerPowerShellScript,
} from "./escape";
import { type Unavailable, firstLine, unavailable, unsupportedPlatform } from "./outcome";

export type Duplex = "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
export const DUPLEX_VALUES: readonly Duplex[] = [
  "one-sided",
  "two-sided-long-edge",
  "two-sided-short-edge",
];

export const MAX_COPIES = 100;

/** The queue probe. No caller value reaches it, on any platform. */
export function planPrinterProbe(
  platform: HostPlatform,
): Omit<RunRequest, "timeoutMs"> | undefined {
  switch (platform) {
    case "darwin":
    case "linux":
      return { argv: ["lpstat", "-p", "-d"] };
    case "win32":
      return { argv: powershellArgv(WINDOWS_PRINTER_LIST, {}).argv };
    default:
      return undefined;
  }
}

export const WINDOWS_PRINTER_LIST = registerPowerShellScript({
  name: "printer-list",
  // DOCUMENTED, NOT RECORDED — nobody here has a Windows box. `Get-Printer`
  // is in the PrintManagement module, present on client Windows since 8.1.
  script:
    "try { Get-Printer | ForEach-Object { [Console]::Out.WriteLine('printer ' + $_.Name + ' is ' + $_.PrinterStatus) } } catch { [Console]::Error.WriteLine($_.Exception.Message) }",
  reads: [],
});

export const WINDOWS_PRINT_TEXT = registerPowerShellScript({
  name: "print-text",
  script:
    "Get-Content -Raw -LiteralPath $env:CREWHAUS_PRINT_PATH | Out-Printer -Name $env:CREWHAUS_PRINT_DEST",
  reads: ["CREWHAUS_PRINT_PATH", "CREWHAUS_PRINT_DEST"],
});

/** What `lpstat -p -d` said. Every field is separately unknown-able. */
export type QueueFacts = {
  readonly printers: ReadonlyArray<{ readonly name: string; readonly state: string }>;
  /** `null` when the output named no default — NOT "there is no default". */
  readonly defaultPrinter: string | null;
  /** Set when the scheduler is down, which is not "no printers". */
  readonly schedulerDown: boolean;
  /** Set when the probe could not answer at all. */
  readonly unreadable: string | null;
};

/**
 * Parse `lpstat -p -d`.
 *
 * Recorded on macOS 26.6.2 (CUPS 2.4), verbatim:
 *
 *   printer Canon_MX490_series is idle.  enabled since Sun Jul 26 10:59:45 2026
 *   printer Canon_TS5300_series now printing Canon_TS5300_series-33.  enabled since Sat Sep 12 00:00:20 2026
 *           Looking for printer.
 *   system default destination: Canon_MX490_series
 *
 * Two shapes in two adjacent lines — `is idle.` and `now printing <job>.` —
 * plus an indented continuation that belongs to the line above and must not
 * be read as a printer. The state is taken as the words between the name and
 * the first `.`, which is deliberately tolerant: the sketch was right that
 * this is prose, and a strict grammar over a CUPS version's wording is a
 * parser that breaks on the next one.
 */
export function parseQueues(stdout: string, stderr: string): QueueFacts {
  const both = `${stdout}\n${stderr}`;
  if (/Scheduler is not running/i.test(both)) {
    return { printers: [], defaultPrinter: null, schedulerDown: true, unreadable: null };
  }
  const printers: Array<{ name: string; state: string }> = [];
  let defaultPrinter: string | null = null;
  for (const raw of stdout.split("\n")) {
    // An indented line continues the one above it (`Looking for printer.`),
    // and is not a record of its own.
    if (raw.startsWith(" ") || raw.startsWith("\t")) continue;
    const line = raw.trim();
    if (line === "") continue;
    const printer = /^printer\s+(\S+)\s+(.*?)\.?(?:\s{2,}.*)?$/.exec(line);
    if (printer?.[1] !== undefined) {
      printers.push({ name: printer[1], state: (printer[2] ?? "").replace(/\.$/, "").trim() });
      continue;
    }
    const dflt = /^system default destination:\s*(\S+)/.exec(line);
    if (dflt?.[1] !== undefined) defaultPrinter = dflt[1];
    // "no system default destination" is a real CUPS line and leaves the
    // field null, which is correct: there is genuinely none.
  }
  return { printers, defaultPrinter, schedulerDown: false, unreadable: null };
}

/** The probe could not answer. Distinct from "it answered, there are none". */
export function unreadableQueues(reason: string): QueueFacts {
  return { printers: [], defaultPrinter: null, schedulerDown: false, unreadable: reason };
}

export type PrintOptions = {
  readonly absolutePath: string;
  readonly printer?: string;
  readonly copies: number;
  readonly pageRanges?: string;
  readonly duplex?: Duplex;
};

export type PrintPlan =
  | { readonly ok: true; readonly backend: string; readonly request: Omit<RunRequest, "timeoutMs"> }
  | { readonly ok: false; readonly unavailable: Unavailable };

/** A refusal string, or `undefined` when every caller value fits its pattern. */
export function refusePrintOptions(
  platform: HostPlatform,
  options: PrintOptions,
): string | undefined {
  if (options.printer !== undefined && !SAFE_DESTINATION.test(options.printer)) {
    return `the printer name ${JSON.stringify(options.printer)} is not a CUPS destination name (letters, digits, "_", "." and "-", not starting with "-"); lp documents no "--", so a name that could be read as an option is refused rather than escaped`;
  }
  if (options.pageRanges !== undefined && !SAFE_PAGE_RANGES.test(options.pageRanges)) {
    return `the page range ${JSON.stringify(options.pageRanges)} is not of the form "1", "1-4" or "1,3,5-9"`;
  }
  if (!Number.isInteger(options.copies) || options.copies < 1 || options.copies > MAX_COPIES) {
    return `copies must be a whole number between 1 and ${MAX_COPIES}`;
  }
  if (platform === "win32") {
    // Named, not dropped. See the header.
    if (options.copies !== 1) {
      return "Out-Printer has no copies option; print once or use a CUPS host";
    }
    if (options.pageRanges !== undefined) {
      return "Out-Printer has no page-range option; it prints the whole document or nothing";
    }
    if (options.duplex !== undefined) {
      return "Out-Printer has no duplex option; the queue's own default decides";
    }
    if (!/\.txt$/i.test(options.absolutePath)) {
      return "Out-Printer sends TEXT to a queue and cannot rasterise a PDF, an image or an office document — on Windows this tool prints .txt only, and spooling anything else would put a page of mojibake on the operator's printer";
    }
  }
  return undefined;
}

/** Build the print argv. `refusePrintOptions` must have passed first. */
export function planPrint(platform: HostPlatform, options: PrintOptions): PrintPlan {
  switch (platform) {
    case "darwin":
    case "linux": {
      const argv: string[] = ["lp"];
      if (options.printer !== undefined) argv.push("-d", options.printer);
      if (options.copies !== 1) argv.push("-n", String(options.copies));
      if (options.pageRanges !== undefined) argv.push("-o", `page-ranges=${options.pageRanges}`);
      if (options.duplex !== undefined) argv.push("-o", `sides=${options.duplex}`);
      // The path last, and absolute because containment resolved it. `lp`
      // reads a leading "-" as an option, which is why nothing that could
      // start with one reaches this array.
      argv.push(options.absolutePath);
      return { ok: true, backend: "lp", request: { argv } };
    }
    case "win32": {
      const built = powershellArgv(WINDOWS_PRINT_TEXT, {
        CREWHAUS_PRINT_PATH: options.absolutePath,
        // An empty name means "the default queue" to Out-Printer, and keeping
        // the key present keeps the script's `reads` contract exact.
        CREWHAUS_PRINT_DEST: options.printer ?? "",
      });
      return {
        ok: true,
        backend: "powershell Out-Printer",
        request: { argv: built.argv, env: built.env },
      };
    }
    default:
      return { ok: false, unavailable: unsupportedPlatform(platform, "printing") };
  }
}

export type PrintOutcome =
  | { readonly outcome: "queued"; readonly jobId: string | null; readonly note: string }
  | Unavailable
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Pull the job id out of `lp`'s prose.
 *
 * `lp` answers `request id is Canon_MX490_series-33 (1 file(s))`. There is no
 * machine-readable alternative, so this is a regex over a sentence and it
 * degrades to `null` — never to a guess, and never to the raw line dressed up
 * as an id. A caller that gets `null` still knows the job was accepted; it
 * just cannot name it to `lpstat`.
 */
export function parseJobId(stdout: string): string | null {
  const match = /request id is\s+(\S+)/i.exec(stdout);
  return match?.[1] ?? null;
}

export function classifyPrint(result: {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly missing: boolean;
  readonly refused?: boolean;
}): PrintOutcome {
  if (result.refused === true) return { outcome: "failed", reason: result.stderr };
  if (result.missing) {
    return unavailable(
      "program",
      "the print command is not installed on this host (lp, from CUPS)",
      "lp",
    );
  }
  if (result.timedOut) {
    // The rule-14 shape: the reason says what is unknown, so an assertion on
    // it cannot also be satisfied by an unrelated failure.
    return {
      outcome: "failed",
      reason:
        "lp did not finish within its timeout and was killed — whether the job reached the queue is unknown, so do not resend without checking the queue first",
    };
  }
  if (result.code === 0) {
    return {
      outcome: "queued",
      jobId: parseJobId(result.stdout),
      // Said plainly: the queue accepted it. Paper is a separate question and
      // this tool cannot see the answer.
      note: "the job was accepted by the queue; whether it printed depends on the printer and is not observable from here",
    };
  }
  const detail = firstLine(result.stderr) || firstLine(result.stdout);
  return {
    outcome: "failed",
    reason: detail === "" ? `lp exited ${result.code}` : `lp exited ${result.code}: ${detail}`,
  };
}
