/**
 * Stack traces into frames.
 *
 * The question a harness asks of a stack trace is almost always "which of
 * these lines is MY code", and the answer is the difference between reading
 * three frames and reading sixty. So every frame is classified, and the
 * classification is the point of the parser rather than a nicety on top of it.
 *
 * Pure: text in, records out, no filesystem and no clock.
 */

export type FrameKind = "project" | "dependency" | "runtime" | "unknown";

export type StackFrame = {
  /** Function or method name, when the trace names one. */
  readonly function?: string;
  /** File path, with `file://` and query strings removed. */
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly kind: FrameKind;
  /** The original line, trimmed. */
  readonly raw: string;
};

export type ParsedStack = {
  /** The error class and message, when the trace begins with one. */
  readonly error?: string;
  readonly frames: readonly StackFrame[];
  /** Index of the first project frame, or -1 — usually where to start reading. */
  readonly firstProjectFrame: number;
};

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/** Marks of a dependency, in the three ecosystems these tools cover. */
const DEPENDENCY_RE = /\/(node_modules|site-packages|dist-packages|vendor|\.venv|venv)\//;
/** Marks of the runtime itself rather than of any file on disk. */
const RUNTIME_RE = /^(node:|bun:|internal\/|<anonymous>$|native$|\[native code\]$)/;

/**
 * Classify a frame's file.
 *
 * `root`, when given, is the only thing that can promote a frame to
 * "project": an absolute path outside it is a dependency's, even when no
 * `node_modules` appears in it. Without a root, a relative path is taken as
 * project code, which is what every runner prints for the code under test.
 */
export function classifyFrame(file: string, root?: string): FrameKind {
  const f = toPosix(file);
  if (f === "") return "unknown";
  if (RUNTIME_RE.test(f)) return "runtime";
  if (DEPENDENCY_RE.test(f)) return "dependency";
  if (root !== undefined && root !== "") {
    const r = toPosix(root).replace(/\/$/, "");
    if (f.startsWith(`${r}/`)) return "project";
    if (f.startsWith("/")) return "dependency";
    return "project";
  }
  return f.startsWith("/") ? "unknown" : "project";
}

/** Strip `file://`, a bundler query string and a trailing `)` from a path. */
function cleanPath(file: string): string {
  let f = toPosix(file.trim());
  if (f.startsWith("file://")) f = f.slice("file://".length);
  const query = f.indexOf("?");
  if (query !== -1) f = f.slice(0, query);
  return f;
}

/**
 * How much of one line any pattern here is allowed to see.
 *
 * A real frame is a function name and a path; nothing legitimate is a
 * kilobyte. The cap is not cosmetic: several of the patterns below scan a
 * line more than once (a lazy name followed by a location, a bare location
 * searched for `file:line:col`), so their cost grows with the SQUARE of the
 * line length, and a caller may hand this parser two megabytes in one line.
 * Capping the line is what turns that from a hang into a truncated frame.
 */
const MAX_LINE_CHARS = 2_000;

/**
 * Cut an over-long line from the MIDDLE, keeping both ends.
 *
 * Cutting the tail instead would throw away the `:line:col)` that makes a
 * frame worth having, and the frame would then be dropped rather than
 * truncated — a silent hole in the trace. Keeping both ends leaves the
 * function name, the closing parenthesis and the position intact, and the
 * elision is visible in `raw`.
 */
function capLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  const half = Math.floor((MAX_LINE_CHARS - 1) / 2);
  return `${line.slice(0, half)}…${line.slice(line.length - half)}`;
}

const AT_PREFIX = /^at\s+/;
const V8_BARE = /^at\s+(?<loc>[^\s()]+)$/;

/**
 * Split `at name (location)` without a backtracking pattern.
 *
 * The obvious `/^at\s+(.+?)\s+\((.+)\)$/` is quadratic-to-exponential: on a
 * line of spaces the lazy name and the greedy `\s+` retry every split, which
 * measured at twelve seconds for four thousand characters. This does the one
 * pass the pattern was trying to express — the first `(` that follows
 * whitespace, with the line ending in `)` — in linear time.
 */
function splitNamedFrame(line: string): { fn: string; loc: string } | undefined {
  const prefix = AT_PREFIX.exec(line);
  if (prefix === null || !line.endsWith(")")) return undefined;
  const rest = line.slice(prefix[0].length);
  for (let i = 1; i < rest.length - 1; i++) {
    if (rest[i] !== "(") continue;
    if (!/\s/.test(rest[i - 1] as string)) continue;
    const fn = rest.slice(0, i).trimEnd();
    const loc = rest.slice(i + 1, rest.length - 1);
    if (fn === "" || loc === "") return undefined;
    return { fn, loc };
  }
  return undefined;
}
const PYTHON = /^File\s+"(?<file>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<fn>.+))?$/;

function splitLocation(loc: string): { file: string; line?: number; column?: number } {
  const m = /^(?<file>.*?):(?<line>\d+):(?<col>\d+)$/.exec(loc.trim());
  if (m !== null) {
    return {
      file: cleanPath(m.groups?.["file"] as string),
      line: Number(m.groups?.["line"]),
      column: Number(m.groups?.["col"]),
    };
  }
  const m2 = /^(?<file>.*?):(?<line>\d+)$/.exec(loc.trim());
  if (m2 !== null) {
    return { file: cleanPath(m2.groups?.["file"] as string), line: Number(m2.groups?.["line"]) };
  }
  return { file: cleanPath(loc) };
}

/**
 * Parse a V8 (node, bun, browser) or CPython stack trace.
 *
 * Not handled, and said so rather than guessed at: JVM and .NET traces, Go
 * panics (goroutine traces have their own two-line shape), source-map
 * resolution back to original sources, and traces whose frames were rewritten
 * by a bundler beyond the `?query` suffix that is stripped here.
 */
export function parseStackTrace(text: string, root?: string, maxFrames = 100): ParsedStack {
  const lines = text.split("\n");
  const frames: StackFrame[] = [];
  let error: string | undefined;

  for (const rawLine of lines) {
    // See MAX_LINE_CHARS: the patterns below cost more than linear in the
    // length of what they are given, and the input is caller-supplied.
    const line = capLine(rawLine.replace(/\r$/, "").trim());
    if (line === "") continue;
    if (frames.length >= maxFrames) break;

    const python = PYTHON.exec(line);
    if (python !== null) {
      const file = cleanPath(python.groups?.["file"] as string);
      const fn = python.groups?.["fn"];
      frames.push({
        ...(fn === undefined ? {} : { function: fn.trim() }),
        file,
        line: Number(python.groups?.["line"]),
        kind: classifyFrame(file, root),
        raw: line,
      });
      continue;
    }

    const named = splitNamedFrame(line);
    if (named !== undefined) {
      const location = splitLocation(named.loc);
      frames.push({
        function: named.fn,
        ...location,
        kind: classifyFrame(location.file, root),
        raw: line,
      });
      continue;
    }

    const bare = V8_BARE.exec(line);
    if (bare !== null) {
      const location = splitLocation(bare.groups?.["loc"] as string);
      frames.push({
        ...location,
        kind: classifyFrame(location.file, root),
        raw: line,
      });
      continue;
    }

    // A header line: the first one is the error, later ones (`Caused by:`,
    // `During handling of the above exception`) are noise between frames.
    if (error === undefined && frames.length === 0 && !line.startsWith("Traceback")) {
      error = line.length > 500 ? `${line.slice(0, 500)}…` : line;
    }
  }

  return {
    ...(error === undefined ? {} : { error }),
    frames,
    firstProjectFrame: frames.findIndex((f) => f.kind === "project"),
  };
}
