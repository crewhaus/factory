/**
 * THE SECURITY BOUNDARY OF THIS PACKAGE.
 *
 * Every tool here carries a caller-supplied string to a platform API, and on
 * two of the three platforms that API takes SOURCE CODE rather than data.
 *
 *   macOS   `osascript -e '<statement>'` compiles AppleScript. A title
 *           interpolated into `display notification "<title>"` is not text in
 *           a dialog - it is program text. A single double quote ends the
 *           string literal and everything after it RUNS, with the operator's
 *           automation permissions.
 *   Windows `powershell.exe -Command <script>` compiles PowerShell, and the
 *           toast payload inside it is an XML document. A body containing
 *           `</toast>` closes the document early; a body containing `&`
 *           makes it malformed. Same shape, one layer over.
 *   Linux   `notify-send` takes argv, which is the easy case - except that a
 *           summary beginning with `-` is still read as a FLAG. Recorded on
 *           Debian 12 / libnotify 0.8.1: `notify-send "-u" "body"` prints
 *           "Unknown urgency body specified", because `-u` was consumed as
 *           the urgency flag and the body became its argument.
 *
 * THE THREE RULES THIS FILE ENFORCES.
 *
 * 1. NO SCRIPT SOURCE IS EVER BUILT AT CALL TIME. Every AppleScript and every
 *    PowerShell script in this package is a frozen module constant registered
 *    here at load. `osascriptArgv` and `powershellArgv` REFUSE a script object
 *    that is not in that registry, so "just interpolate it this once" cannot
 *    compile. This is stronger than escaping and needs no escaper to be
 *    correct: there is nothing to escape into.
 * 2. CALLER VALUES TRAVEL BESIDE THE PROGRAM, NEVER INSIDE IT.
 *      - macOS: as ARGV, after `--`, read back with `item N of argv`. Verified
 *        on macOS 26.6.2: without `--`, a value of `-e` is consumed as an
 *        option ("osascript: option requires an argument -- e"); with `--` it
 *        arrives as `item 1 of argv` verbatim.
 *      - Windows: through the child's ENVIRONMENT. Argv is not a safe channel
 *        for PowerShell - `powershell -Command <script> a b c` CONCATENATES
 *        the trailing arguments onto the command string, so a value passed
 *        "as an argument" is still source.
 *      - Linux: as argv after `--`.
 * 3. WHAT CANNOT TRAVEL BESIDE THE PROGRAM IS VALIDATED, NOT ESCAPED. The
 *    Windows toast body has to end up inside an XML document, so it is
 *    escaped here (`escapeXmlText`) and the FINISHED DOCUMENT is what crosses
 *    the environment channel - one testable escaper, applied once, whose
 *    output never becomes PowerShell source. Everything else that would have
 *    to be interpolated (a printer name, a page range) is matched against a
 *    closed pattern and refused if it does not fit.
 */

// ---------------------------------------------------------------------------
// the script registry
// ---------------------------------------------------------------------------

/**
 * One AppleScript, as a fixed list of statements.
 *
 * `lines` become one `-e` argument each. They are written by hand in this
 * package and contain no caller value; `item N of argv` is how they reach
 * what the caller sent.
 */
export type AppleScript = {
  readonly name: string;
  readonly lines: readonly string[];
  /** How many `argv` items the statements read. Checked when argv is built. */
  readonly arity: number;
};

/** One PowerShell script, as a single statement string plus its env contract. */
export type PowerShellScript = {
  readonly name: string;
  readonly script: string;
  /** Environment variable names the script reads. Nothing else is set. */
  readonly reads: readonly string[];
};

const APPLE_SCRIPTS = new Set<AppleScript>();
const POWERSHELL_SCRIPTS = new Set<PowerShellScript>();

/**
 * Declare an AppleScript. Only a registered script may be run, and the only
 * place `registerAppleScript` is called is at module scope in this package -
 * so a script cannot be assembled from a caller's value and then run.
 */
export function registerAppleScript(script: AppleScript): AppleScript {
  const frozen: AppleScript = Object.freeze({
    name: script.name,
    lines: Object.freeze([...script.lines]),
    arity: script.arity,
  });
  APPLE_SCRIPTS.add(frozen);
  return frozen;
}

export function registerPowerShellScript(script: PowerShellScript): PowerShellScript {
  const frozen: PowerShellScript = Object.freeze({
    name: script.name,
    script: script.script,
    reads: Object.freeze([...script.reads]),
  });
  POWERSHELL_SCRIPTS.add(frozen);
  return frozen;
}

/** Raised when something tries to run source this file did not register. */
export class UnregisteredScriptError extends Error {
  constructor(kind: string, name: string) {
    super(
      `refusing to run an unregistered ${kind} script "${name}": script source in this package is a frozen module constant, never built at call time`,
    );
    this.name = "UnregisteredScriptError";
  }
}

// ---------------------------------------------------------------------------
// macOS - osascript
// ---------------------------------------------------------------------------

/**
 * `osascript` with the caller's values as `argv`.
 *
 * The shape is `osascript -e 'on run argv' -e '<statement>' ... -e 'end run'
 * -- <value> ...`, which is the whole point: the statements are compiled, the
 * values are not. `--` is mandatory and is not decoration - see the header.
 */
export function osascriptArgv(
  script: AppleScript,
  values: readonly string[] = [],
): readonly string[] {
  if (!APPLE_SCRIPTS.has(script)) throw new UnregisteredScriptError("AppleScript", script.name);
  if (values.length !== script.arity) {
    throw new Error(
      `AppleScript "${script.name}" reads ${script.arity} argv item(s) but ${values.length} were supplied`,
    );
  }
  const argv: string[] = ["osascript", "-e", "on run argv"];
  for (const line of script.lines) {
    argv.push("-e", line);
  }
  argv.push("-e", "end run", "--", ...values);
  return Object.freeze(argv);
}

/**
 * The statements of an osascript argv - everything the compiler sees.
 *
 * Used by the tests that assert a hostile value never reaches program text,
 * and by `dryRun` so a caller can read the source that would run.
 */
export function osascriptProgramText(argv: readonly string[]): string {
  const text: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--") break;
    if (argv[i] === "-e") {
      const line = argv[i + 1];
      if (line !== undefined) text.push(line);
      i += 1;
    }
  }
  return text.join("\n");
}

/**
 * An AppleScript error line, split into its code and message.
 *
 * Recorded on macOS 26.6.2 with Accessibility NOT granted:
 *   `44:87: execution error: System Events got an error: osascript is not
 *    allowed assistive access. (-25211)`
 * The code is what distinguishes "you have not granted this" from "the script
 * was wrong", and the two must not become the same result.
 */
export function parseOsascriptError(stderr: string): { code: number | null; message: string } {
  const trimmed = stderr.trim();
  const codeMatch = /\((-?\d+)\)\s*$/.exec(trimmed);
  const code = codeMatch?.[1] === undefined ? null : Number(codeMatch[1]);
  const afterPrefix = /execution error:\s*(.*)$/s.exec(trimmed);
  const message = (afterPrefix?.[1] ?? trimmed).trim();
  return { code, message };
}

/**
 * macOS error codes that mean "the operator has not granted this", as
 * distinct from "the script failed".
 *
 * -25211 and -1728 were both recorded from the same un-granted machine for
 * the same request, which is why this is a set and not an equality check:
 * System Events reports assistive-access denial with more than one code.
 * -1743 is the Automation (Apple-events) denial, a DIFFERENT grant in a
 * DIFFERENT pane of System Settings, so its message names the right one.
 */
export const APPLESCRIPT_PERMISSION_CODES: ReadonlyMap<number, string> = new Map([
  [
    -25211,
    "macOS Accessibility is not granted - System Settings > Privacy & Security > Accessibility, and add the program running this harness",
  ],
  [
    -1728,
    "macOS Accessibility is not granted - System Settings > Privacy & Security > Accessibility, and add the program running this harness",
  ],
  [
    -1743,
    "macOS Automation is not granted - System Settings > Privacy & Security > Automation, and allow this program to control System Events",
  ],
]);

/**
 * True when a failed osascript run failed for want of a PERMISSION.
 *
 * The message test is a fallback for a future OS that changes the code but
 * keeps the sentence; a code match is preferred because a message is
 * localised and this package pins `LC_ALL=C` for the commands it parses but
 * cannot pin the language of a macOS framework string.
 */
export function osascriptPermissionReason(stderr: string): string | undefined {
  const { code, message } = parseOsascriptError(stderr);
  if (code !== null) {
    const known = APPLESCRIPT_PERMISSION_CODES.get(code);
    if (known !== undefined) return known;
  }
  if (/not allowed assistive access/i.test(message)) {
    return APPLESCRIPT_PERMISSION_CODES.get(-25211);
  }
  if (/not authorized to send apple events/i.test(message)) {
    return APPLESCRIPT_PERMISSION_CODES.get(-1743);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Windows - PowerShell and XML
// ---------------------------------------------------------------------------

/** The fixed prefix for every PowerShell invocation this package makes. */
export const POWERSHELL_FLAGS: readonly string[] = Object.freeze([
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
]);

/**
 * `powershell.exe` running a registered script, with caller values in the
 * ENVIRONMENT.
 *
 * Nothing is appended after the script: `powershell -Command <script> a b`
 * concatenates `a b` onto the command string, which would put a caller's
 * value back into source. The refusal below makes that impossible to write
 * by accident.
 */
export function powershellArgv(
  script: PowerShellScript,
  env: Readonly<Record<string, string>>,
): { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> } {
  if (!POWERSHELL_SCRIPTS.has(script)) {
    throw new UnregisteredScriptError("PowerShell", script.name);
  }
  const supplied = Object.keys(env).sort();
  const expected = [...script.reads].sort();
  if (supplied.join(",") !== expected.join(",")) {
    throw new Error(
      `PowerShell script "${script.name}" reads [${expected.join(", ")}] but was given [${supplied.join(", ")}]`,
    );
  }
  return {
    argv: Object.freeze(["powershell.exe", ...POWERSHELL_FLAGS, script.script]),
    env: Object.freeze({ ...env }),
  };
}

/**
 * XML text escaping for the Windows toast payload.
 *
 * This is the one place in the package where a caller's value is put INSIDE
 * something it could otherwise restructure, and it is done here - in
 * TypeScript, where it can be tested against `</toast>`, `&`, `<`, `"`, a
 * backslash and a newline - rather than in PowerShell, where the same
 * escaping would be invisible to this suite.
 *
 * The finished document then crosses to PowerShell through the environment,
 * so even the ESCAPED value is never part of the program text. Escaping is
 * the second line of defence here, not the first.
 *
 * `'` and `"` are escaped although an XML text node does not require it: the
 * value also has to survive an attribute position in a future template, and
 * an escaper whose correctness depends on where its output is pasted is the
 * kind that eventually is not.
 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strip the characters XML 1.0 cannot represent AT ALL.
 *
 * A control byte such as U+0001 has no escape in XML 1.0 - the numeric
 * reference for it is itself illegal - so `LoadXml` throws on the document
 * rather than showing a broken toast. Dropping them is the only option that
 * still delivers the message, and the tool SAYS it did (`sanitized`) rather
 * than silently changing what the operator asked to show. TAB, LF and CR are
 * legal and are kept.
 */
export function stripXmlIllegalChars(value: string): { text: string; removed: number } {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the entire job.
  const cleaned = value.replace(/[ --]/g, "");
  return { text: cleaned, removed: value.length - cleaned.length };
}

// ---------------------------------------------------------------------------
// argv hygiene for programs with no `--`
// ---------------------------------------------------------------------------

/**
 * Would this value be read as an OPTION rather than as a value?
 *
 * `--` solves this wherever the program supports it (osascript and
 * notify-send both do, verified). Where it does not - CUPS `lp` documents no
 * `--` - the answer is not to escape but to REFUSE, and to say so. This repo
 * has already shipped one argument injection of exactly this shape
 * (`gitBranchCreate({name:"-D"})` ran `git branch -D victim`).
 */
export function looksLikeFlag(value: string): boolean {
  return value.startsWith("-");
}

/**
 * A printer/queue name that can safely be an argv element.
 *
 * CUPS destination names are documented as printable ASCII without space,
 * `/`, `#` or `@`; this is stricter still, and deliberately excludes a
 * leading `-`.
 */
export const SAFE_DESTINATION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$/;

/** A CUPS `page-ranges` value: `1`, `1-4`, `1,3,5-9`. Nothing else. */
export const SAFE_PAGE_RANGES = /^\d{1,6}(-\d{1,6})?(,\d{1,6}(-\d{1,6})?)*$/;
