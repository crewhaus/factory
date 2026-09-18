/**
 * One diagnostic shape, and the parsers that reach it from each tool's own
 * output.
 *
 * A harness that has to branch on "was this tsc or eslint or ruff" cannot
 * decide anything without a model reading the text. So every parser here
 * lands on the same record — file, line, column, severity, rule, message —
 * and `Diagnostics` returns exactly that shape whichever tools ran.
 *
 * Where a tool has a machine-readable form, that is what these parse, and the
 * comment on each parser says why that form was chosen. Everything here is
 * pure: text in, records out.
 */

export type Severity = "error" | "warning" | "info";

export type Diagnostic = {
  /** Path as the tool reported it, normalised to forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly severity: Severity;
  /** Rule or error code (`TS2345`, `lint/suspicious/noDoubleEquals`, `E501`). */
  readonly rule?: string;
  readonly message: string;
  /** Which tool produced it: `tsc`, `biome`, `eslint`, `ruff`, … */
  readonly source: string;
};

/**
 * The order a caller reads them in, fixed so the same run gives the same
 * bytes: by file, then position, then rule, then message. Plain `<` rather
 * than `localeCompare`, which would order differently on a machine with a
 * different locale — the same trap the workspace's determinism rule names.
 */
export function sortDiagnostics(items: readonly Diagnostic[]): Diagnostic[] {
  return [...items].sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      a.column - b.column ||
      ((a.rule ?? "") < (b.rule ?? "") ? -1 : (a.rule ?? "") > (b.rule ?? "") ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}

/** Counts by severity, for the one-line answer to "is it clean?". */
export function countBySeverity(items: readonly Diagnostic[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const item of items) counts[item.severity] += 1;
  return counts;
}

const toPosix = (p: string): string => p.replace(/\\/g, "/");

function normalizeSeverity(raw: string): Severity {
  const value = raw.toLowerCase();
  if (value === "error" || value === "fatal" || value === "2") return "error";
  if (value === "warning" || value === "warn" || value === "1") return "warning";
  return "info";
}

/** Strip a leading absolute root so results are workspace-relative. */
export function relativize(file: string, root: string): string {
  const f = toPosix(file);
  const r = toPosix(root).replace(/\/$/, "");
  if (r !== "" && f.startsWith(`${r}/`)) return f.slice(r.length + 1);
  return f;
}

// ---------------------------------------------------------------------------
// tsc

/**
 * `tsc --pretty false` prints one diagnostic per line as
 * `file(line,col): error TS2345: message`, with continuation lines indented.
 *
 * That form is chosen over the default pretty output because pretty mode
 * wraps the message across lines, draws a source excerpt with box characters
 * and inserts ANSI colour — all of which move with the terminal width. tsc
 * has no JSON reporter, and the `--pretty false` shape has been stable for
 * years.
 */
export function parseTsc(text: string, root = ""): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re =
    /^(?<file>[^\s(][^(]*)\((?<line>\d+),(?<col>\d+)\):\s+(?<sev>error|warning|message)\s+(?<code>TS\d+):\s+(?<msg>.*)$/;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, "");
    const m = re.exec(line);
    if (m === null) {
      // A file-less diagnostic: `error TS18003: No inputs were found…`.
      const bare = /^(?<sev>error|warning)\s+(?<code>TS\d+):\s+(?<msg>.*)$/.exec(line);
      if (bare !== null) {
        out.push({
          file: "",
          line: 0,
          column: 0,
          severity: normalizeSeverity(bare.groups?.["sev"] ?? "error"),
          rule: bare.groups?.["code"] as string,
          message: (bare.groups?.["msg"] ?? "").trim(),
          source: "tsc",
        });
      }
      continue;
    }
    // Indented follow-on lines belong to the diagnostic above them.
    let message = (m.groups?.["msg"] ?? "").trim();
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] as string)) {
      const cont = (lines[i + 1] as string).trim();
      if (re.test(cont)) break;
      message += ` ${cont}`;
      i += 1;
    }
    out.push({
      file: relativize(m.groups?.["file"] as string, root),
      line: Number(m.groups?.["line"]),
      column: Number(m.groups?.["col"]),
      severity: normalizeSeverity(m.groups?.["sev"] ?? "error"),
      rule: m.groups?.["code"] as string,
      message,
      source: "tsc",
    });
  }
  return sortDiagnostics(out);
}

// ---------------------------------------------------------------------------
// biome

type Unknown = Record<string, unknown>;

const asRecord = (value: unknown): Unknown | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Unknown)
    : undefined;

/** Pull the plain text out of biome's nested description/advice markup. */
function flattenBiomeText(value: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => flattenBiomeText(v, depth + 1)).join("");
  const record = asRecord(value);
  if (record === undefined) return "";
  if (typeof record["content"] === "string") return record["content"];
  if (record["content"] !== undefined) return flattenBiomeText(record["content"], depth + 1);
  if (record["elements"] !== undefined) return flattenBiomeText(record["elements"], depth + 1);
  return "";
}

/**
 * `biome check --reporter=json` emits `{ diagnostics: [...] }`.
 *
 * JSON is chosen over biome's default output because the text reporter draws
 * a framed source excerpt per diagnostic — visually excellent, and ten lines
 * of box-drawing per finding in a context window. The JSON reporter gives a
 * byte span rather than a line/column, so the span is converted using the
 * `sourceCode` biome ships alongside it; when that is absent the diagnostic is
 * still returned, with line 0, rather than dropped.
 */
export function parseBiomeJson(text: string, root = ""): Diagnostic[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const root_ = asRecord(parsed);
  const list = root_?.["diagnostics"];
  if (!Array.isArray(list)) return undefined;
  const out: Diagnostic[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const location = asRecord(record["location"]);
    const pathRecord = asRecord(location?.["path"]);
    const file = typeof pathRecord?.["file"] === "string" ? (pathRecord["file"] as string) : "";
    const span = location?.["span"];
    const sourceCode =
      typeof location?.["sourceCode"] === "string" ? (location["sourceCode"] as string) : undefined;
    let line = 0;
    let column = 0;
    if (Array.isArray(span) && typeof span[0] === "number" && sourceCode !== undefined) {
      const offset = span[0] as number;
      const before = sourceCode.slice(0, offset);
      line = before.split("\n").length;
      column = offset - (before.lastIndexOf("\n") + 1) + 1;
    }
    const message =
      flattenBiomeText(record["description"]).trim() || flattenBiomeText(record["message"]).trim();
    const category =
      typeof record["category"] === "string" ? (record["category"] as string) : undefined;
    out.push({
      file: relativize(file, root),
      line,
      column,
      severity: normalizeSeverity(String(record["severity"] ?? "error")),
      ...(category === undefined ? {} : { rule: category }),
      message,
      source: "biome",
    });
  }
  return sortDiagnostics(out);
}

// ---------------------------------------------------------------------------
// eslint

/**
 * `eslint -f json` emits one object per file with a `messages` array.
 *
 * Chosen because eslint's default stylish formatter aligns columns with
 * padding that depends on the longest path in the run, so the same finding
 * renders differently depending on what else failed — unparseable in any
 * stable way. `severity` is 2/1; a message with `fatal` is a parse error and
 * is kept as an error rather than dropped.
 */
export function parseEslintJson(text: string, root = ""): Diagnostic[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const out: Diagnostic[] = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const file = typeof record["filePath"] === "string" ? (record["filePath"] as string) : "";
    const messages = record["messages"];
    if (!Array.isArray(messages)) continue;
    for (const raw of messages) {
      const message = asRecord(raw);
      if (message === undefined) continue;
      const ruleId =
        typeof message["ruleId"] === "string" ? (message["ruleId"] as string) : undefined;
      out.push({
        file: relativize(file, root),
        line: typeof message["line"] === "number" ? (message["line"] as number) : 0,
        column: typeof message["column"] === "number" ? (message["column"] as number) : 0,
        severity:
          message["fatal"] === true ? "error" : normalizeSeverity(String(message["severity"] ?? 2)),
        ...(ruleId === undefined ? {} : { rule: ruleId }),
        message: String(message["message"] ?? ""),
        source: "eslint",
      });
    }
  }
  return sortDiagnostics(out);
}

// ---------------------------------------------------------------------------
// ruff

/**
 * `ruff check --output-format json` emits a flat array of findings.
 *
 * Chosen because ruff's default "concise" output omits the rule's message
 * body for some rules and its "full" output includes a source excerpt; the
 * JSON carries both the code and the message on every finding, and its
 * `location` is already line/column rather than a byte offset.
 */
export function parseRuffJson(text: string, root = ""): Diagnostic[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const out: Diagnostic[] = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const location = asRecord(record["location"]);
    const code = typeof record["code"] === "string" ? (record["code"] as string) : undefined;
    out.push({
      file: relativize(String(record["filename"] ?? ""), root),
      line: typeof location?.["row"] === "number" ? (location["row"] as number) : 0,
      column: typeof location?.["column"] === "number" ? (location["column"] as number) : 0,
      // ruff reports lint findings without a severity field; every finding it
      // prints is something it wants changed, so they land as warnings unless
      // the rule is a syntax error (code absent).
      severity: code === undefined ? "error" : "warning",
      ...(code === undefined ? {} : { rule: code }),
      message: String(record["message"] ?? ""),
      source: "ruff",
    });
  }
  return sortDiagnostics(out);
}

// ---------------------------------------------------------------------------
// last resort

/**
 * A line-oriented fallback for a tool with no machine-readable output at all:
 * `file:line:col: severity: message`, the GNU convention that most compilers
 * and many linters follow.
 *
 * Used only when no structured parser matched, and the result says
 * `source: "generic"` so a caller can tell a guessed diagnostic from a parsed
 * one rather than trusting it equally.
 */
export function parseGenericDiagnostics(text: string, source = "generic", root = ""): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re =
    /^(?<file>[^\s:][^:]*):(?<line>\d+):(?:(?<col>\d+):)?\s*(?:(?<sev>error|warning|note|info)\s*:)?\s*(?<msg>.+)$/;
  for (const raw of text.split("\n")) {
    const m = re.exec(raw.replace(/\r$/, "").trim());
    if (m === null) continue;
    const file = m.groups?.["file"] as string;
    // `http://example.com:80` and `12:30:00` are not diagnostics.
    if (/^\d+$/.test(file) || /^https?$/.test(file)) continue;
    out.push({
      file: relativize(file, root),
      line: Number(m.groups?.["line"]),
      column: m.groups?.["col"] === undefined ? 0 : Number(m.groups["col"]),
      severity: normalizeSeverity(m.groups?.["sev"] ?? "error"),
      message: (m.groups?.["msg"] ?? "").trim(),
      source,
    });
  }
  return sortDiagnostics(out);
}

/**
 * Try every structured parser, in the order that a false positive is least
 * likely, and fall back to the line-oriented one. Used by `Diagnostics` when
 * the caller supplied a command whose output format was not declared.
 */
export function parseAnyDiagnostics(text: string, root = ""): Diagnostic[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const biome = parseBiomeJson(trimmed, root);
    if (biome !== undefined && biome.length > 0) return biome;
    const eslint = parseEslintJson(trimmed, root);
    if (eslint !== undefined && eslint.length > 0) return eslint;
    const ruff = parseRuffJson(trimmed, root);
    if (ruff !== undefined && ruff.length > 0) return ruff;
    // Valid JSON with no findings is a clean run, not a parse failure.
    if (biome !== undefined || eslint !== undefined || ruff !== undefined) return [];
  }
  const tsc = parseTsc(text, root);
  if (tsc.length > 0) return tsc;
  return parseGenericDiagnostics(text, "generic", root);
}
