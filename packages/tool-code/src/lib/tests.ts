/**
 * Turning a test runner's output into the three lines a harness can decide on.
 *
 * A green run is "0 failed" and nothing else. A red run is the failing tests,
 * the assertion that failed, where it failed, and a stack trimmed to the
 * frames in the project's own code. Everything else a runner prints —
 * progress dots, per-file headers, timing tables, the coverage summary — is
 * discarded here rather than in somebody's context window.
 *
 * Each parser's comment says why that output form was chosen. Everything in
 * this file is pure: same text in, same records out.
 */

export type TestFailure = {
  /** Full test name, including the describe path where the runner gives one. */
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
  /** The failing assertion, trimmed to its message. */
  readonly message?: string;
  /** Stack frames, runtime and dependency frames removed, capped. */
  readonly stack?: readonly string[];
};

export type TestOutcome = {
  readonly runner: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
  readonly failures: readonly TestFailure[];
  /** False when the parser recognised nothing, so a caller knows to read the raw output. */
  readonly parsed: boolean;
};

/** How many stack frames a failure keeps. Six is enough to place a bug. */
export const MAX_STACK_FRAMES = 6;
/** How much of one assertion message is kept. */
export const MAX_MESSAGE_CHARS = 1_000;
/**
 * How much of a single stack frame is kept.
 *
 * `locationFromFrame` searches a frame for `file:line:col` with an unanchored
 * pattern, which costs the square of the frame's length when there is nothing
 * to find — and `TestFailureSummary` will accept eight megabytes of stored
 * output on one line if a caller hands it that. Capping the frame bounds the
 * search; nothing a real runner prints comes close to this.
 */
export const MAX_FRAME_CHARS = 2_000;

const cap = (text: string, n = MAX_MESSAGE_CHARS): string =>
  text.length > n ? `${text.slice(0, n)}…` : text;

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/**
 * Runners are spawned with NO_COLOR and TERM=dumb, but one that colours
 * unconditionally — or output a caller stored elsewhere and passed to
 * `TestFailureSummary` — still arrives with escapes, and they would otherwise
 * end up inside every message. Built from a char code so the escape byte
 * never appears literally in this source.
 */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

const stripAnsi = (text: string): string => text.replace(ANSI_RE, "");

/**
 * Split a runner's failure blob into the assertion message and the stack.
 *
 * Frames inside the runtime (`node:internal`, `bun:test`) and inside
 * dependencies are dropped: they are never where the bug is, and they are the
 * bulk of the bytes.
 */
export function splitMessageAndStack(
  blob: string,
  maxFrames = MAX_STACK_FRAMES,
): { message: string; stack: string[] } {
  const lines = stripAnsi(blob).split("\n");
  const message: string[] = [];
  const stack: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*at\s+\S/.test(line)) {
      const full = line.trim();
      const frame = full.length > MAX_FRAME_CHARS ? full.slice(0, MAX_FRAME_CHARS) : full;
      if (/node:internal|node_modules|bun:test|\(native\)/.test(frame)) continue;
      if (stack.length < maxFrames) stack.push(frame);
      continue;
    }
    if (stack.length === 0 && line.trim() !== "") message.push(line.trim());
  }
  return { message: cap(message.join(" ").trim()), stack };
}

/** `file:line:col` out of a stack frame or a panic line. */
export function locationFromFrame(frame: string): { file: string; line: number } | undefined {
  const m = /([^\s()]+):(\d+):(\d+)/.exec(frame);
  if (m === null) return undefined;
  return { file: toPosix(m[1] as string), line: Number(m[2]) };
}

/**
 * Fill in the location from the stack when the runner did not give one.
 *
 * When the file is already known from a header, only the LINE is taken, and
 * only from a frame in that same file: the first frame of a nested-helper
 * failure often points at the helper, and reporting its line under the test
 * file's name would send a reader to the wrong place.
 */
function withLocation(failure: TestFailure): TestFailure {
  if (failure.stack === undefined) return failure;
  if (failure.file !== undefined && failure.line !== undefined) return failure;
  const base = failure.file?.slice((failure.file?.lastIndexOf("/") ?? -1) + 1);
  for (const frame of failure.stack) {
    const location = locationFromFrame(frame);
    if (location === undefined) continue;
    if (failure.file === undefined) return { ...failure, ...location };
    if (base !== undefined && location.file.endsWith(base)) {
      return { ...failure, line: location.line };
    }
  }
  return failure;
}

// ---------------------------------------------------------------------------
// bun test

/**
 * `bun test` prints a `(fail)` / `(skip)` / `(todo)` line per noteworthy test
 * under a header naming the file, a `(pass)` line per test in verbose mode,
 * and a count block at the end.
 *
 * Those prefixes are what this parses. Bun has no stdout JSON reporter — its
 * JUnit reporter only writes to a FILE, and a tool meant to report on a
 * project must not drop an artefact into it to learn what failed — so the
 * line prefixes, which bun emits unconditionally, are the machine-readable
 * form available. Note the layout: bun prints a failure's source excerpt,
 * error and stack BEFORE the `(fail)` line that names the test, so the detail
 * is collected from the lines preceding it rather than following it, and the
 * count block is authoritative because recent versions print nothing at all
 * for a passing test.
 */
/**
 * `suite > adds [0.12ms]` without its timing suffix: the last `[` that
 * follows whitespace and opens exactly `[<digits>ms]` or `[<digits>s]`.
 * Any other bracket (`weird [name]`) is part of the name.
 */
function withoutTiming(rest: string): string {
  const open = rest.lastIndexOf("[");
  if (open <= 0 || !/\s/.test(rest[open - 1] as string)) return rest;
  return /^\[[\d.]+\s*m?s\]\s*$/.test(rest.slice(open)) ? rest.slice(0, open) : rest;
}

export function parseBunTest(text: string): TestOutcome {
  const lines = stripAnsi(text).split("\n");
  const failures: TestFailure[] = [];
  let currentFile: string | undefined;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let sawAny = false;

  // Linear by construction (C079). The 0.7.0 pattern ended in a lazy name
  // and an OPTIONAL `\s+[1.2ms]` suffix, so a status line with a long run
  // of spaces was retried from every split point: 40,000 characters took
  // over a second, and a 400,000-character report minutes. Here the
  // status and the rest are one greedy pass that cannot fail after `\s+`,
  // and the timing suffix is cut off by position.
  const statusRe = /^\((pass|fail|skip|todo)\)\s+([\s\S]*)$/;

  // Lines seen since the last status line or file header: bun prints a
  // failure's detail ABOVE the `(fail)` line that names the test.
  let pending: string[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const fileHeader = /^(?<file>[\w./@\-+]+\.[cm]?[jt]sx?):$/.exec(line.trim());
    if (fileHeader !== null) {
      currentFile = toPosix(fileHeader.groups?.["file"] as string);
      pending = [];
      continue;
    }
    const m = statusRe.exec(line.trim());
    if (m === null) {
      pending.push(line);
      continue;
    }
    sawAny = true;
    const status = m[1];
    const name = withoutTiming(m[2] ?? "").trim();
    const detail = pending;
    pending = [];
    if (status === "pass") {
      passed += 1;
      continue;
    }
    if (status === "skip" || status === "todo") {
      skipped += 1;
      continue;
    }
    failed += 1;
    // Drop the source excerpt bun prints above the error: the numbered code
    // lines and the caret that points into them are for a human reading a
    // terminal, and the assertion below them says the same thing in words.
    const trimmed = detail.filter((l) => !/^\s*\d+\s*\|/.test(l) && !/^\s*\^\s*$/.test(l));
    const errorAt = trimmed.findIndex((l) => /^\s*error:/i.test(l));
    const body = errorAt === -1 ? trimmed : trimmed.slice(errorAt);
    const { message, stack } = splitMessageAndStack(body.join("\n"));
    failures.push(
      withLocation({
        name,
        ...(currentFile === undefined ? {} : { file: currentFile }),
        ...(message === "" ? {} : { message }),
        ...(stack.length === 0 ? {} : { stack }),
      }),
    );
  }

  // The summary block is authoritative when present: a test file that threw
  // while loading never printed a status line but is still counted there.
  for (const raw of lines) {
    const m = /^\s*(\d+)\s+(pass|fail|skip|todo)\s*$/.exec(stripAnsi(raw));
    if (m === null) continue;
    sawAny = true;
    const n = Number(m[1]);
    if (m[2] === "pass") passed = Math.max(passed, n);
    else if (m[2] === "fail") failed = Math.max(failed, n);
    else skipped = Math.max(skipped, n);
  }

  return {
    runner: "bun",
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    failures,
    parsed: sawAny,
  };
}

// ---------------------------------------------------------------------------
// jest and vitest

type Unknown = Record<string, unknown>;

/**
 * The JSON object inside a runner's output, whatever is printed around it.
 *
 * Both runners write their report to stdout, but a deprecation notice, a
 * bundler banner or — when a caller stores stdout and stderr together, which
 * is how `RunTests` retries — a line of stderr can sit on either side of it.
 * The first `{` to the last `}` is tried first, so trailing noise does not
 * cost the whole parse; the first `{` to the end is tried second, for the
 * case where the report itself is the last thing and a `}` appears after it
 * in prose.
 */
function parseEmbeddedJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  const end = text.lastIndexOf("}");
  const candidates =
    end > start ? [text.slice(start, end + 1), text.slice(start)] : [text.slice(start)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next framing.
    }
  }
  return undefined;
}

const asRecord = (value: unknown): Unknown | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Unknown)
    : undefined;

/**
 * jest (`--json`) and vitest (`--reporter=json`) share one shape:
 * `{ numPassedTests, testResults: [{ name, assertionResults: [...] }] }`.
 *
 * JSON is chosen over either runner's console reporter because both print a
 * code frame, a diff and a per-file tree whose indentation depends on suite
 * nesting, while the JSON carries the failure message and the test's own line
 * number as fields. One parser serves both, which is also why a project using
 * either gets the same records out.
 */
export function parseJestJson(text: string, runner = "jest"): TestOutcome | undefined {
  const parsed = parseEmbeddedJson(text);
  if (parsed === undefined) return undefined;
  const root = asRecord(parsed);
  if (root === undefined || !Array.isArray(root["testResults"])) return undefined;
  const failures: TestFailure[] = [];
  for (const entry of root["testResults"]) {
    const suite = asRecord(entry);
    if (suite === undefined) continue;
    const file = typeof suite["name"] === "string" ? toPosix(suite["name"] as string) : undefined;
    const assertions = suite["assertionResults"];
    if (!Array.isArray(assertions)) {
      // A suite that failed to load has no assertions, only a message.
      const failureMessage =
        typeof suite["message"] === "string" ? (suite["message"] as string) : undefined;
      if (failureMessage !== undefined && failureMessage.trim() !== "") {
        const { message, stack } = splitMessageAndStack(failureMessage);
        failures.push({
          name: file ?? "<suite>",
          ...(file === undefined ? {} : { file }),
          message,
          ...(stack.length === 0 ? {} : { stack }),
        });
      }
      continue;
    }
    for (const raw of assertions) {
      const test = asRecord(raw);
      if (test === undefined) continue;
      if (test["status"] !== "failed") continue;
      const messages = Array.isArray(test["failureMessages"]) ? test["failureMessages"] : [];
      const blob = messages.filter((m): m is string => typeof m === "string").join("\n");
      const { message, stack } = splitMessageAndStack(blob);
      const location = asRecord(test["location"]);
      const line =
        typeof location?.["line"] === "number" ? (location["line"] as number) : undefined;
      failures.push(
        withLocation({
          name: String(test["fullName"] ?? test["title"] ?? ""),
          ...(file === undefined ? {} : { file }),
          ...(line === undefined ? {} : { line }),
          ...(message === "" ? {} : { message }),
          ...(stack.length === 0 ? {} : { stack }),
        }),
      );
    }
  }
  const num = (key: string): number => (typeof root[key] === "number" ? (root[key] as number) : 0);
  return {
    runner,
    passed: num("numPassedTests"),
    failed: num("numFailedTests"),
    skipped: num("numPendingTests") + num("numTodoTests"),
    total: num("numTotalTests"),
    failures,
    parsed: true,
  };
}

// ---------------------------------------------------------------------------
// pytest

/**
 * pytest, run as `-q --no-header -rf --tb=short`.
 *
 * `--json-report` would be richer but it is a third-party plugin most projects
 * do not have installed, and a tool that only works when an optional plugin is
 * present is a tool that mostly does not work. The `-rf` short summary —
 * `FAILED path::test - message` — is built in, one line per failure, and
 * stable; `--tb=short` gives the file and line without a source excerpt.
 */
export function parsePytest(text: string): TestOutcome {
  const lines = stripAnsi(text).split("\n");
  const failures: TestFailure[] = [];
  const locations = new Map<string, { file: string; line: number; detail: string }>();
  let sawAny = false;

  // Traceback blocks: `path/to/test_x.py:12: in test_thing`, then the
  // assertion lines prefixed `E   `.
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?<file>[^\s:]+\.py):(?<line>\d+):\s*(?:in\s+(?<name>\S+))?/.exec(
      (lines[i] as string).trim(),
    );
    if (m === null) continue;
    const detail: string[] = [];
    for (let j = i + 1; j < lines.length && j < i + 30; j++) {
      const next = (lines[j] as string).replace(/\r$/, "");
      if (/^E\s{2,}/.test(next)) detail.push(next.replace(/^E\s+/, ""));
      else if (detail.length > 0) break;
    }
    const name = m.groups?.["name"];
    if (name === undefined) continue;
    locations.set(name, {
      file: toPosix(m.groups?.["file"] as string),
      line: Number(m.groups?.["line"]),
      detail: detail.join(" ").trim(),
    });
  }

  for (const raw of lines) {
    const line = stripAnsi(raw).trim();
    const m =
      /^(?<kind>FAILED|ERROR)\s+(?<path>[^\s:]+)(?:::(?<rest>\S+))?(?:\s+-\s+(?<msg>.*))?$/.exec(
        line,
      );
    if (m === null) continue;
    sawAny = true;
    const filePath = toPosix(m.groups?.["path"] as string);
    const rest = m.groups?.["rest"] ?? "";
    const testName = rest === "" ? filePath : `${filePath}::${rest}`;
    const bare = rest.split("::").pop() ?? rest;
    const located = locations.get(bare);
    const message = (m.groups?.["msg"] ?? located?.detail ?? "").trim();
    failures.push({
      name: testName,
      file: located?.file ?? filePath,
      ...(located === undefined ? {} : { line: located.line }),
      ...(message === "" ? {} : { message: cap(message) }),
    });
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const raw of lines) {
    const counts = pytestSummaryCounts(stripAnsi(raw).trim());
    if (counts === undefined) continue;
    sawAny = true;
    for (const [kind, n] of counts) {
      if (kind === "passed" || kind === "xpassed") passed += n;
      else if (kind === "failed" || kind.startsWith("error")) failed += n;
      else skipped += n;
    }
  }

  const failedCount = failed === 0 ? failures.length : failed;
  return {
    runner: "pytest",
    passed,
    failed: failedCount,
    skipped,
    total: passed + failedCount + skipped,
    failures,
    parsed: sawAny,
  };
}

/** The words a pytest summary line counts, in the order 0.7.0's pattern tried them. */
const PYTEST_COUNT_WORDS = ["passed", "failed", "errors", "error", "skipped", "xfailed", "xpassed"];
/** Any of them, for "is this a summary at all". */
const PYTEST_SUMMARY_WORD_RE = /passed|failed|error|skipped/;
/** What a summary line's body may hold: words, spaces and commas. */
const PYTEST_BODY_RE = /^[\w\s,]*$/;
/** The duration after ` in `, matched at a fixed position. */
const PYTEST_DURATION_RE = /[\d.]+s/y;

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

/**
 * The counts in pytest's final summary line — `=== 1 failed, 3 passed in
 * 0.12s ===`, or `-q`'s bare `1 failed, 3 passed in 0.12s` — as
 * `[word, n]` pairs, or undefined when the line is not one.
 *
 * A scan, not a pattern: 0.7.0 matched this with two lazy groups around the
 * count word and a `\s+` after them, which retried a run of spaces from
 * every position (C079) — quadratic in a line the caller supplies. The body
 * is what precedes the first ` in <duration>s` after a count word, and must
 * hold only words, spaces and commas, as before.
 */
export function pytestSummaryCounts(line: string): Array<[string, number]> | undefined {
  let at = 0;
  while (line[at] === "=") at += 1;
  while (isSpace(line[at])) at += 1;
  const text = line.slice(at);
  const word = PYTEST_SUMMARY_WORD_RE.exec(text);
  if (word === null) return undefined;
  // The first ` in <duration>s` after the count word, preceded by space.
  let from = word.index + word[0].length;
  let bodyEnd = -1;
  for (;;) {
    const idx = text.indexOf("in", from);
    if (idx < 0) break;
    from = idx + 1;
    if (!isSpace(text[idx - 1]) || !isSpace(text[idx + 2])) continue;
    let after = idx + 2;
    while (isSpace(text[after])) after += 1;
    PYTEST_DURATION_RE.lastIndex = after;
    if (!PYTEST_DURATION_RE.test(text)) continue;
    let start = idx - 1;
    while (start > 0 && isSpace(text[start - 1])) start -= 1;
    bodyEnd = start;
    break;
  }
  if (bodyEnd < word.index + word[0].length) return undefined;
  const body = text.slice(0, bodyEnd);
  if (!PYTEST_BODY_RE.test(body)) return undefined;
  const counts: Array<[string, number]> = [];
  for (const part of body.split(",")) {
    const tokens = part.trim().split(/\s+/);
    for (let i = 0; i + 1 < tokens.length; i++) {
      // The digits the token ends with, found from the end (a `\d+$`
      // pattern retries from every digit of a long run).
      const token = tokens[i] as string;
      let d = token.length;
      while (d > 0 && (token[d - 1] as string) >= "0" && (token[d - 1] as string) <= "9") d -= 1;
      if (d === token.length) continue;
      const next = tokens[i + 1] as string;
      const kind = PYTEST_COUNT_WORDS.find((w) => next.startsWith(w));
      if (kind === undefined) continue;
      counts.push([kind, Number(token.slice(d))]);
      break;
    }
  }
  return counts;
}

/**
 * The first `file.go:12: message` line in a failed go test's output, or
 * undefined. Line by line, each trimmed and matched anchored: 0.7.0 ran one
 * multiline pattern whose `^\s*` spanned newlines, so a failed test that
 * printed many blank lines took quadratic time (C079).
 */
function goFailureLocation(
  blob: string,
): { file: string; line: number; message: string } | undefined {
  for (const raw of blob.split("\n")) {
    const m = /^([\w./-]+\.go):(\d+):\s*(.*)/.exec(raw.trimStart());
    if (m !== null) {
      return { file: m[1] as string, line: Number(m[2]), message: (m[3] as string).trim() };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// go test

/**
 * `go test -json ./...` emits one JSON object per line — the only structured
 * form go ships, and the reason this tool always passes `-json`: without it
 * the output interleaves package results with test output and there is no way
 * to attribute a failure line to a test.
 *
 * Output arrives as many small `Action: "output"` events, so they are
 * accumulated per test and kept only for the ones that end in `fail`.
 */
export function parseGoTestJson(text: string): TestOutcome {
  const buffers = new Map<string, string[]>();
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let sawAny = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let event: Unknown | undefined;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (event === undefined) continue;
    const test = typeof event["Test"] === "string" ? (event["Test"] as string) : undefined;
    if (test === undefined) continue;
    sawAny = true;
    const pkg = String(event["Package"] ?? "");
    const key = `${pkg}.${test}`;
    const action = String(event["Action"] ?? "");
    if (action === "output") {
      const chunk = typeof event["Output"] === "string" ? (event["Output"] as string) : "";
      const buffer = buffers.get(key) ?? [];
      if (buffer.length < 200) buffer.push(chunk);
      buffers.set(key, buffer);
      continue;
    }
    if (action === "pass") passed += 1;
    else if (action === "skip") skipped += 1;
    else if (action === "fail") {
      failed += 1;
      const blob = (buffers.get(key) ?? []).join("");
      // go prints `    file_test.go:12: message`, relative to the package dir.
      const located = goFailureLocation(blob);
      const message =
        located !== undefined
          ? located.message
          : blob
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l !== "" && !/^(---|===)/.test(l))
              .slice(0, 4)
              .join(" ");
      failures.push({
        name: key,
        ...(located === undefined ? {} : { file: toPosix(located.file), line: located.line }),
        ...(message === "" ? {} : { message: cap(message) }),
      });
    }
  }

  return {
    runner: "go",
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    failures,
    parsed: sawAny,
  };
}

// ---------------------------------------------------------------------------
// cargo test

/**
 * `cargo test` prints `test <path> ... ok|FAILED|ignored`, then a `failures:`
 * section with each failing test's captured output.
 *
 * Cargo's JSON output (`--message-format=json`) describes the BUILD, not the
 * test results — libtest's own `--format json` is still nightly-only — so the
 * stable text form is what there is, and it is at least one line per test.
 */
export function parseCargoTest(text: string): TestOutcome {
  const lines = stripAnsi(text).split("\n");
  const failures: TestFailure[] = [];
  const details = new Map<string, string>();
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let sawAny = false;

  for (let i = 0; i < lines.length; i++) {
    const header = /^-{4}\s+(?<name>\S+)\s+stdout\s+-{4}$/.exec((lines[i] as string).trim());
    if (header === null) continue;
    const blob: string[] = [];
    for (let j = i + 1; j < lines.length && j < i + 40; j++) {
      const next = (lines[j] as string).trim();
      if (/^-{4}\s+\S+\s+stdout\s+-{4}$/.test(next) || next === "failures:") break;
      blob.push(next);
    }
    details.set(header.groups?.["name"] as string, blob.join("\n").trim());
  }

  for (const raw of lines) {
    const m = /^test\s+(?<name>\S+)\s+\.\.\.\s+(?<status>ok|FAILED|ignored)$/.exec(
      stripAnsi(raw).trim(),
    );
    if (m === null) continue;
    sawAny = true;
    const status = m.groups?.["status"];
    const name = m.groups?.["name"] as string;
    if (status === "ok") passed += 1;
    else if (status === "ignored") skipped += 1;
    else {
      failed += 1;
      const blob = details.get(name) ?? "";
      const panic = /panicked at ([^\s:]+):(\d+):(\d+):?/.exec(blob);
      const message = blob
        .split("\n")
        .filter((l) => l !== "" && !l.startsWith("panicked at") && !l.startsWith("thread '"))
        .slice(0, 4)
        .join(" ")
        .trim();
      failures.push({
        name,
        ...(panic === null ? {} : { file: toPosix(panic[1] as string), line: Number(panic[2]) }),
        ...(message === "" ? {} : { message: cap(message) }),
      });
    }
  }

  return {
    runner: "cargo",
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    failures,
    parsed: sawAny,
  };
}

// ---------------------------------------------------------------------------
// dispatch

export type RunnerName = "bun" | "vitest" | "jest" | "pytest" | "go" | "cargo";

/** How much of each end of the output the signature match looks at. */
const DETECTION_SAMPLE_CHARS = 20_000;

/**
 * Both ENDS of the output, not just the head.
 *
 * Half the signatures below are things a runner prints when it finishes —
 * `test result:`, the short test summary — and a stored log often begins with
 * an install or a build. Sampling only the first twenty thousand characters
 * made a run unrecognisable because of what came before it, which is exactly
 * the case a caller reaches for `TestFailureSummary` to solve. Sampling is
 * still bounded: the head and the tail, never the middle.
 */
function sampleForDetection(text: string): string {
  const stripped = stripAnsi(text.length > 4_000_000 ? text.slice(0, 4_000_000) : text);
  if (stripped.length <= DETECTION_SAMPLE_CHARS * 2) return stripped;
  return `${stripped.slice(0, DETECTION_SAMPLE_CHARS)}\n${stripped.slice(-DETECTION_SAMPLE_CHARS)}`;
}

/**
 * Guess which runner produced this text, for a caller who stored output and
 * no longer knows. Deliberately conservative: each signature is something the
 * runner prints and the others do not.
 */
export function detectRunnerFromOutput(text: string): RunnerName | undefined {
  const sample = sampleForDetection(text);
  // `[ \t]*`, not `\s*`: with the m flag `^\s*` spans newlines and retried a
  // run of blank lines from every line start (C079).
  if (/^[ \t]*\{"(Time|Action|Package)":/m.test(sample)) return "go";
  if (/"numTotalTests"|"assertionResults"/.test(sample)) return "jest";
  if (/^\((pass|fail|skip|todo)\)\s/m.test(sample) || /Ran \d+ tests? across/.test(sample)) {
    return "bun";
  }
  if (/short test summary info|^={3,}\s*FAILURES/m.test(sample)) return "pytest";
  if (/^test result: |^running \d+ tests?$/m.test(sample)) return "cargo";
  return undefined;
}

/**
 * Rewrite each failure's file path to be relative to `roots`.
 *
 * Runners disagree about whether they print an absolute or a relative path,
 * and the same runner disagrees with itself across platforms: bun printed
 * `a.test.ts` on macOS and `/tmp/xxxx/a.test.ts` on Linux for the same
 * suite. A caller wants the path it would open, and an absolute one also
 * puts the machine's layout into a result a model may read.
 *
 * Several roots may be given because macOS reaches its temporary directory
 * through a symlink, so the run's directory has two equally valid spellings.
 * A path under none of them is left exactly as the runner printed it.
 */
export function relativizeFailures(
  outcome: TestOutcome,
  roots: ReadonlyArray<string>,
): TestOutcome {
  const prefixes = roots
    .map(toPosix)
    .filter((r) => r !== "")
    .map((r) => (r.endsWith("/") ? r : `${r}/`));
  const shorten = (file: string): string => {
    const posix = toPosix(file);
    for (const prefix of prefixes) if (posix.startsWith(prefix)) return posix.slice(prefix.length);
    return posix;
  };
  return {
    ...outcome,
    failures: outcome.failures.map((failure) =>
      failure.file === undefined ? failure : { ...failure, file: shorten(failure.file) },
    ),
  };
}

/** Parse output from a named runner, or from whichever one it looks like. */
export function parseTestOutput(text: string, runner: RunnerName | "auto"): TestOutcome {
  const chosen = runner === "auto" ? detectRunnerFromOutput(text) : runner;
  switch (chosen) {
    case "bun":
      return parseBunTest(text);
    case "vitest":
      return parseJestJson(text, "vitest") ?? { ...parseBunTest(text), runner: "vitest" };
    case "jest":
      return parseJestJson(text, "jest") ?? emptyOutcome("jest");
    case "pytest":
      return parsePytest(text);
    case "go":
      return parseGoTestJson(text);
    case "cargo":
      return parseCargoTest(text);
    default:
      return emptyOutcome("unknown");
  }
}

function emptyOutcome(runner: string): TestOutcome {
  return { runner, passed: 0, failed: 0, skipped: 0, total: 0, failures: [], parsed: false };
}
