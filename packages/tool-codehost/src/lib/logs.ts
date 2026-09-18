/**
 * The actionable part of a CI log.
 *
 * A failed GitHub Actions job writes tens of thousands of lines and a handful
 * of them say what broke. Returning the whole log is the same mistake as
 * returning the whole file when a caller asked for one function: it costs a
 * context window, and the model then has to do by hand the extraction that a
 * parser can do exactly.
 *
 * What comes out is: the step that was running when the first error appeared,
 * the first error line itself, the annotations the host emitted (`##[error]`
 * and friends, which are the runner's own judgement about what mattered), a
 * capped list of further error-looking lines, and the tail — because the last
 * twenty lines of a failed job are where the exit code and the summary live.
 *
 * Everything here is pure: no clock, no network, no randomness, and the same
 * log in gives the same excerpt out.
 */

/** CSI/SGR escapes, built from the code point so no control character is written inline. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
/** GitHub Actions prefixes every raw log line with an RFC 3339 timestamp. */
const LEADING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;
/** `##[group]NAME`, `##[endgroup]`, `##[error]TEXT` — the runner's own markers. */
const RUNNER_MARKER = /^##\[([a-z]+)\](.*)$/;
/** The `::error file=x,line=1::message` workflow-command spelling. */
const WORKFLOW_COMMAND = /^::([a-z]+)(?:\s+[^:]*)?::(.*)$/;
/** GitLab's collapsible-section markers, after ANSI and CR removal. */
const GITLAB_SECTION = /^section_(start|end):\d+:([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/;

/** Lines that read as the actual failure, rather than merely mentioning one. */
const ERROR_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  // Ordered most specific first, because `failureRule` reports the first
  // match and "which rule fired" is only useful when it is the precise one.
  { name: "npm", pattern: /^\s*npm (?:ERR!|error\b)/ },
  { name: "traceback", pattern: /^\s*Traceback \(most recent call last\)/ },
  { name: "typescript", pattern: /\berror TS\d+\b/ },
  { name: "assertion", pattern: /\b(?:AssertionError|expect\(received\))/ },
  { name: "test-fail", pattern: /^\s*(?:FAIL|✗|×|not ok)\b/ },
  { name: "go-panic", pattern: /^\s*panic:/ },
  { name: "compile", pattern: /^\s*(?:[^\s:]+):\d+:\d+:\s+error:/i },
  { name: "segfault", pattern: /\b(?:Segmentation fault|core dumped)\b/ },
  { name: "exit-code", pattern: /\b(?:exit(?:ed with)? code|exit status)\s+[1-9]\d*\b/i },
  { name: "prefix", pattern: /^\s*(?:error|fatal)\b[:\s]/i },
];

/** `Process completed with exit code 1.` and GitLab's `ERROR: Job failed: exit code 1`. */
const EXIT_CODE = /exit (?:code|status)\s+(\d+)/i;

export type LogLocation = {
  /** 1-based line number in the normalised log. */
  readonly line: number;
  readonly text: string;
  /** The group or section that was open, when the log named one. */
  readonly step?: string;
};

export type LogAnnotation = LogLocation & {
  readonly level: string;
};

export type LogExcerpt = {
  readonly totalLines: number;
  /** The step open at the first error, or the last step opened when none is. */
  readonly failingStep: string | null;
  readonly firstError: LogLocation | null;
  /** Non-zero exit code the log reported, when it reported one. */
  readonly exitCode: number | null;
  readonly annotations: readonly LogAnnotation[];
  readonly errorLines: readonly LogLocation[];
  readonly tail: readonly string[];
  /** How many annotations and error lines the caps dropped. */
  readonly droppedAnnotations: number;
  readonly droppedErrorLines: number;
};

export type ExcerptOptions = {
  readonly maxAnnotations?: number;
  readonly maxErrorLines?: number;
  readonly tailLines?: number;
  /** Characters kept per line; a minified bundle in a stack trace is one line. */
  readonly maxLineChars?: number;
};

/** One log line with the runner's decoration removed. */
export function normalizeLogLine(raw: string): string {
  return raw.replace(/\r/g, "").replace(ANSI_PATTERN, "").replace(LEADING_TIMESTAMP, "");
}

/** True when a line reads as the failure itself. Exported so the rule is testable. */
export function looksLikeFailure(line: string): boolean {
  return ERROR_PATTERNS.some((entry) => entry.pattern.test(line));
}

/** Which of the rules matched, for a caller that wants to know why. */
export function failureRule(line: string): string | null {
  for (const entry of ERROR_PATTERNS) {
    if (entry.pattern.test(line)) return entry.name;
  }
  return null;
}

/**
 * Reduce a raw job log to the part worth reading.
 *
 * `raw` is expected to be already byte-capped by the caller. It is walked
 * with `indexOf` rather than `split("\n")`, one line held at a time, so peak
 * memory is the input plus the excerpt instead of the input plus an array of
 * every line in it — which on the two-megabyte default cap is the difference
 * between a copy and a multiple.
 *
 * A trailing newline TERMINATES the last line rather than starting an empty
 * one, so a log that ends the way every real log ends is not reported as
 * having one more line than it has. An empty log has no lines at all.
 */
export function excerptLog(raw: string, opts: ExcerptOptions = {}): LogExcerpt {
  const maxAnnotations = opts.maxAnnotations ?? 20;
  const maxErrorLines = opts.maxErrorLines ?? 20;
  const tailLines = opts.tailLines ?? 20;
  const maxLineChars = opts.maxLineChars ?? 500;

  const cut = (text: string): string =>
    text.length <= maxLineChars ? text : `${text.slice(0, maxLineChars)}…`;

  const stack: string[] = [];
  let lastStep: string | null = null;
  const annotations: LogAnnotation[] = [];
  const errorLines: LogLocation[] = [];
  const tail: string[] = [];
  let firstError: LogLocation | null = null;
  let failingStep: string | null = null;
  let exitCode: number | null = null;
  let droppedAnnotations = 0;
  let droppedErrorLines = 0;

  const currentStep = (): string | undefined => stack[stack.length - 1];

  let totalLines = 0;
  let cursor = 0;
  while (cursor < raw.length) {
    const brk = raw.indexOf("\n", cursor);
    const end = brk === -1 ? raw.length : brk;
    const text = normalizeLogLine(raw.slice(cursor, end)).trimEnd();
    cursor = end + 1;
    totalLines++;
    const lineNumber = totalLines;

    // Keep a rolling tail of the non-blank lines rather than slicing at the
    // end: on a large log that is one pass and one small array.
    if (text.trim() !== "") {
      tail.push(cut(text));
      if (tail.length > tailLines) tail.shift();
    }

    const section = text.match(GITLAB_SECTION);
    if (section !== null) {
      const kind = section[1] as string;
      const name = section[2] as string;
      if (kind === "start") {
        stack.push(name);
        lastStep = name;
      } else {
        popTo(stack, name);
      }
      continue;
    }

    const marker = text.match(RUNNER_MARKER);
    const command = marker === null ? text.match(WORKFLOW_COMMAND) : null;
    const kind =
      marker !== null ? (marker[1] as string) : command !== null ? (command[1] as string) : null;
    const payload =
      marker !== null ? (marker[2] as string) : command !== null ? (command[2] as string) : "";

    if (kind === "group") {
      stack.push(payload.trim());
      lastStep = payload.trim();
      continue;
    }
    if (kind === "endgroup") {
      stack.pop();
      continue;
    }
    if (kind === "error" || kind === "warning" || kind === "notice") {
      const entry: LogAnnotation = {
        level: kind,
        line: lineNumber,
        text: cut(payload.trim()),
        ...(currentStep() !== undefined ? { step: currentStep() as string } : {}),
      };
      if (annotations.length < maxAnnotations) annotations.push(entry);
      else droppedAnnotations++;
      if (kind === "error" && firstError === null) {
        firstError = {
          line: entry.line,
          text: entry.text,
          ...(entry.step !== undefined ? { step: entry.step } : {}),
        };
        failingStep = entry.step ?? currentStep() ?? lastStep;
      }
    }
    if (kind !== null && marker !== null) {
      // Any other runner marker (`##[debug]`, `##[command]`) is decoration.
      if (kind !== "error") continue;
    }

    if (exitCode === null) {
      const match = text.match(EXIT_CODE);
      if (match !== null) {
        const value = Number.parseInt(match[1] as string, 10);
        if (Number.isInteger(value) && value !== 0) exitCode = value;
      }
    }

    if (looksLikeFailure(text)) {
      const entry: LogLocation = {
        line: lineNumber,
        text: cut(text.trim()),
        ...(currentStep() !== undefined ? { step: currentStep() as string } : {}),
      };
      if (errorLines.length < maxErrorLines) errorLines.push(entry);
      else droppedErrorLines++;
      if (firstError === null) {
        firstError = entry;
        failingStep = entry.step ?? lastStep;
      }
    }
  }

  return {
    totalLines,
    failingStep: failingStep ?? currentStep() ?? lastStep,
    firstError,
    exitCode,
    annotations,
    errorLines,
    tail,
    droppedAnnotations,
    droppedErrorLines,
  };
}

/**
 * Close a named section, and everything a malformed log left open inside it.
 * A `section_end` for a name that was never started is ignored rather than
 * popping something unrelated.
 */
function popTo(stack: string[], name: string): void {
  const index = stack.lastIndexOf(name);
  if (index === -1) return;
  stack.length = index;
}
