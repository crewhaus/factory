/**
 * Structured logging for crewhaus-factory.
 * Catalog F-foundations (`logging`) — every later layer routes diagnostic
 * output through this contract instead of raw stderr writes.
 *
 * Format (CREWHAUS_LOG env, default = "pretty"):
 *   pretty  human-readable single line, written to stderr
 *   json    one JSON object per line, written to stderr
 *
 * Level (CREWHAUS_LOG_LEVEL env, default = "info"):
 *   debug | info | warn | error
 *
 * Logger output is for diagnostic / observability — user-visible CLI output
 * (usage text, "compiled bundle ..." status) stays on stdout via direct writes.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "pretty" | "json";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export type LoggerOptions = {
  level?: LogLevel;
  format?: LogFormat;
  /** Where each line is written. Defaults to process.stderr. */
  sink?: (line: string) => void;
  /** Constant fields attached to every record (e.g. component name). */
  bindings?: LogFields;
  /** Clock used for the `time` field. Defaults to `new Date()`. */
  now?: () => Date;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? envLevel() ?? "info";
  const format = opts.format ?? envFormat() ?? "pretty";
  const sink =
    opts.sink ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const now = opts.now ?? (() => new Date());
  const bindings = opts.bindings ?? {};
  return new ConfiguredLogger(level, format, sink, now, bindings);
}

class ConfiguredLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly format: LogFormat,
    private readonly sink: (line: string) => void,
    private readonly now: () => Date,
    private readonly bindings: LogFields,
  ) {}

  debug(msg: string, fields?: LogFields): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }

  child(bindings: LogFields): Logger {
    return new ConfiguredLogger(this.level, this.format, this.sink, this.now, {
      ...this.bindings,
      ...bindings,
    });
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const merged = { ...this.bindings, ...(fields ?? {}) };
    const time = this.now().toISOString();
    const line =
      this.format === "json"
        ? `${JSON.stringify({ time, level, msg, ...merged })}\n`
        : renderPretty(time, level, msg, merged);
    this.sink(line);
  }
}

function renderPretty(time: string, level: LogLevel, msg: string, fields: LogFields): string {
  const head = `${time} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const keys = Object.keys(fields);
  if (keys.length === 0) return `${head}\n`;
  const tail = keys.map((k) => `${k}=${formatValue(fields[k])}`).join(" ");
  return `${head} ${tail}\n`;
}

function formatValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function envLevel(): LogLevel | undefined {
  const v = process.env["CREWHAUS_LOG_LEVEL"];
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return undefined;
}

function envFormat(): LogFormat | undefined {
  const v = process.env["CREWHAUS_LOG"];
  if (v === "json" || v === "pretty") return v;
  return undefined;
}
