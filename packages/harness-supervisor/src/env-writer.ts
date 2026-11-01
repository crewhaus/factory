/**
 * The `.env` writer — the ONLY path a value takes into a file.
 *
 * It sits beside the reader that builds every spawn environment
 * (`parseEnvText` / `unquoteEnvValue` in `spawn-contracts.ts`): the writer's
 * encoding and the reader's decoding are two halves of one format, and a
 * value must come back byte for byte. It moved here from
 * `@crewhaus/hangar-server`, which keeps thin wrappers that answer a refusal
 * as an HTTP 400, for one release.
 *
 * A refusal is an {@link EnvWriteError} whose message names the VARIABLE and
 * never the value. Every other failure (a filesystem error) is thrown as it
 * came, so a caller can tell "this value cannot be written" from "the write
 * failed".
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/** A syntactically valid environment variable name. Checked before any name
 *  becomes an `.env` line or a grid column. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** A live `KEY=` assignment, with or without an `export ` prefix. */
export const ENV_ASSIGN_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
/** A `# KEY=` commented stub — the line "unset" leaves behind. */
export const ENV_STUB_RE = /^[ \t]*#[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
const ENV_EXPORT_PREFIX_RE = /^[ \t]*export[ \t]+/;

/**
 * The writer refused: the name is not a variable name, or the value holds a
 * character one `.env` line cannot represent. The message names the variable
 * and never the value.
 */
export class EnvWriteError extends Error {
  override readonly name = "EnvWriteError";
}

/** Encode a value as one `.env` scalar. Quoted whenever bare text would be
 *  re-read differently (whitespace, `#`, quotes); `\` and `"` escaped. */
function encodeEnvValue(value: string): string {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Result of one env write — presence only, and deliberately so.
 *
 * The field is `variable`, not `key`: `maskDeep` redacts every value under a
 * key literally NAMED `key` (that is what keeps a spec's `api_key` out of a
 * response), so a field called `key` would come back as `[redacted]` and the
 * panel would lose the very NAME it is trying to report.
 */
export type EnvWriteResult = {
  readonly variable: string;
  /** `set` when a live assignment now exists, `commented-stub` after unset. */
  readonly state: "set" | "commented-stub";
  /** How the line got there. */
  readonly how: "replaced" | "uncommented" | "appended" | "commented";
  readonly file: string;
};

/**
 * Write `KEY=value` into `path`, the ONE writer for env values.
 *
 * Ordering and comments are preserved: an existing live assignment is
 * rewritten in place (keeping any `export ` prefix), a `# KEY=` stub is
 * promoted in place so the key stays where the operator left it, and only a
 * genuinely new key is appended. The file is written 0600 AND chmod'ed to
 * 0600 afterwards — `writeFileSync`'s `mode` only applies at CREATION, so an
 * already-loose `.env` would otherwise stay loose.
 *
 * The value is a parameter and a local. It is never returned, never logged,
 * and never stored.
 */
export function upsertEnvVar(path: string, key: string, value: string): EnvWriteResult {
  if (!ENV_KEY_RE.test(key)) throw new EnvWriteError(`"${key}" is not a valid variable name`);
  if (value.includes("\n") || value.includes("\0")) {
    throw new EnvWriteError(`the value for ${key} contains a newline — .env cannot represent that`);
  }
  const lines = readEnvLines(path);
  const encoded = encodeEnvValue(value);
  let how: EnvWriteResult["how"] = "appended";
  let written = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.match(ENV_ASSIGN_RE)?.[1] === key) {
      const prefix = ENV_EXPORT_PREFIX_RE.test(line) ? "export " : "";
      lines[i] = `${prefix}${key}=${encoded}`;
      how = "replaced";
      written = true;
      break;
    }
    if (line.match(ENV_STUB_RE)?.[1] === key) {
      lines[i] = `${key}=${encoded}`;
      how = "uncommented";
      written = true;
      break;
    }
  }
  if (!written) appendEnvLine(lines, `${key}=${encoded}`);
  writeEnvFile(path, lines);
  return { variable: key, state: "set", how, file: basename(path) };
}

/**
 * Unset `key` by rewriting its line as a `# KEY=` stub.
 *
 * There is no delete. A removed line takes the requirement's NAME with it,
 * and the next doctor run has to rediscover it; a stub keeps the checklist
 * honest and is exactly what `doctor --fix` appends.
 */
export function unsetEnvVar(path: string, key: string): EnvWriteResult {
  if (!ENV_KEY_RE.test(key)) throw new EnvWriteError(`"${key}" is not a valid variable name`);
  const lines = readEnvLines(path);
  let how: EnvWriteResult["how"] = "appended";
  let written = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.match(ENV_ASSIGN_RE)?.[1] === key) {
      lines[i] = `# ${key}=`;
      how = "commented";
      written = true;
      break;
    }
    if (line.match(ENV_STUB_RE)?.[1] === key) {
      how = "commented";
      written = true;
      break; // already a stub — idempotent
    }
  }
  if (!written) appendEnvLine(lines, `# ${key}=`);
  writeEnvFile(path, lines);
  return { variable: key, state: "commented-stub", how, file: basename(path) };
}

/**
 * The file's lines WITHOUT the empty element a trailing newline produces.
 *
 * `writeEnvFile` re-adds exactly one terminating newline, so carrying that
 * empty element through would append a blank line on every single write —
 * a `.env` that grows a line each time the operator touches a variable.
 */
function readEnvLines(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf8");
    if (text === "") return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch {
    return [];
  }
}

function appendEnvLine(lines: string[], line: string): void {
  lines.push(line);
}

function writeEnvFile(path: string, lines: readonly string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // a filesystem without POSIX modes — the write itself still succeeded
  }
}
