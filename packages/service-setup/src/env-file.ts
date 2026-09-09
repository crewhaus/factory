/**
 * The credential write-back path: `KEY=value` into a harness's own `.env`.
 *
 * Semantics are deliberately byte-for-byte the ones `upsertEnvVar` already
 * established in `@crewhaus/hangar-server` (`src/creds-ops.ts`), because the
 * Hangar console and this command edit the SAME files and must not disagree
 * about what "already set" looks like:
 *
 *   - an existing live assignment is rewritten IN PLACE, keeping any
 *     `export ` prefix, so ordering and the operator's grouping survive;
 *   - a `# KEY=` commented stub is PROMOTED in place, so a key stays where
 *     the operator (or `doctor --fix`) parked it;
 *   - only a genuinely new key is appended;
 *   - the file is written 0600 *and* chmod'ed afterwards, because
 *     `writeFileSync`'s `mode` applies only at creation — an already-loose
 *     `.env` would otherwise stay loose;
 *   - values are never returned, never logged, never included in a result.
 *
 * The WRITER is duplicated rather than imported: `hangar-server` is an HTTP
 * server that throws `HttpError`, and a CLI setup command has no business
 * depending on it.
 *
 * The READER is a different matter, and the duplication there has already
 * cost something. `@crewhaus/harness-supervisor` now owns the canonical
 * `unquoteEnvValue`, and `hangar-server` imports it instead of keeping a
 * second copy — because when both copies stripped surrounding quotes without
 * reversing the writer's `\\`/`\"` escapes, the bug had to be found and fixed
 * twice. This module keeps its own only because it must not depend on the
 * supervisor either; the escape rules below are the same rules, and both
 * packages carry round-trip tests over the same awkward characters — a
 * space, `#`, `\"`, `\\`, `=`, `$`, and the empty string — so a divergence
 * shows up as a failing test rather than a corrupted secret.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { ServiceSetupError } from "./types";

/** A syntactically valid env variable name. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const ENV_ASSIGN_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
const ENV_STUB_RE = /^[ \t]*#[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
const ENV_EXPORT_PREFIX_RE = /^[ \t]*export[ \t]+/;

/** How a write landed — reported so the CLI can say what it did. */
export type EnvWriteHow = "replaced" | "uncommented" | "appended" | "unchanged";

/** One write's outcome. Carries the NAME, never the value. */
export type EnvWriteResult = {
  readonly variable: string;
  readonly how: EnvWriteHow;
  readonly file: string;
};

/** The raw file view of a `.env`: which names are set, and to what. */
export type EnvFileView = {
  /** Key → value. Never serialize this. */
  readonly values: Readonly<Record<string, string>>;
  /** Keys held open by a `# NAME=` commented stub. */
  readonly stubs: readonly string[];
  /** Whether the file exists at all. */
  readonly exists: boolean;
};

/** Read a `.env` into a name→value view. A missing file is empty, not an error. */
export function readEnvFile(path: string): EnvFileView {
  if (!existsSync(path)) return { values: {}, stubs: [], exists: false };
  const values: Record<string, string> = {};
  const stubs = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const stub = line.match(ENV_STUB_RE);
    if (stub?.[1] !== undefined) {
      stubs.add(stub[1]);
      continue;
    }
    const assign = line.match(ENV_ASSIGN_RE);
    const key = assign?.[1];
    if (key === undefined) continue;
    values[key] = unquoteEnvValue(line.slice(line.indexOf("=") + 1).trim());
    stubs.delete(key);
  }
  return { values, stubs: [...stubs].sort(), exists: true };
}

/**
 * Write `KEY=value` into `path`.
 *
 * `skipIfUnchanged` (the default) makes the call a no-op when the file
 * already assigns exactly this value — so a re-run of setup reports
 * `unchanged` instead of rewriting a file and churning its mtime.
 */
export function upsertEnvVar(
  path: string,
  key: string,
  value: string,
  opts: { readonly skipIfUnchanged?: boolean } = {},
): EnvWriteResult {
  if (!ENV_KEY_RE.test(key)) {
    throw new ServiceSetupError("harness", `"${key}" is not a valid variable name`, {
      fix: "env variable names must match [A-Za-z_][A-Za-z0-9_]*",
    });
  }
  if (value.includes("\n") || value.includes("\0")) {
    throw new ServiceSetupError(
      "harness",
      `the value for ${key} contains a newline — .env cannot represent that`,
      { fix: "the provider returned a multi-line value; paste it into the file by hand" },
    );
  }

  if (opts.skipIfUnchanged !== false) {
    const current = readEnvFile(path).values[key];
    if (current === value) return { variable: key, how: "unchanged", file: basename(path) };
  }

  const lines = readEnvLines(path);
  const encoded = encodeEnvValue(value);
  let how: EnvWriteHow = "appended";
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
  return { variable: key, how, file: basename(path) };
}

/** Split a file into lines, tolerating a missing file. */
function readEnvLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text === "" ? [] : text.split("\n");
}

/**
 * Append a line, repairing a missing trailing newline first — a file that
 * ends mid-line would otherwise get the new assignment glued onto the last
 * one. Mirrors `planEnvStubs`'s repair in `apps/cli/src/doctor-fix.ts`.
 */
function appendEnvLine(lines: string[], line: string): void {
  if (lines.length === 0) {
    // A missing or empty file: the assignment plus its terminating newline.
    lines.push(line, "");
    return;
  }
  if (lines[lines.length - 1] !== "") lines.push("");
  // The trailing "" element IS the file's final newline; insert before it.
  lines.splice(lines.length - 1, 0, line);
}

/** Write with 0600, then chmod — `mode` alone only applies on creation. */
function writeEnvFile(path: string, lines: readonly string[]): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Quote only when the value needs it; keeps a plain token unquoted. */
function encodeEnvValue(value: string): string {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Strip matched surrounding quotes, else trim an unquoted trailing comment.
 *
 * A double-quoted value is UNESCAPED, reversing {@link encodeEnvValue}'s
 * `\\` and `\"`. Single quotes are left literal, matching every dotenv reader
 * in the workspace: the writer never emits them, and inside them there is no
 * escape sequence to reverse.
 *
 * These are byte for byte the rules `unquoteEnvValue` applies in
 * `@crewhaus/harness-supervisor`, which is the canonical reader — the one
 * that builds the environment a spawned daemon actually receives, and which
 * `@crewhaus/hangar-server` imports rather than reimplementing.
 *
 * It matters here because this module's whole job is putting a credential in
 * a file and having the daemon read back exactly what the provider issued.
 * Today's tokens are all `[A-Za-z0-9_.-]` and never reach the quoting path at
 * all, so an asymmetry would be invisible in practice — which is exactly how
 * one survived in the readers upstream until a round-trip test found it.
 */
function unquoteEnvValue(raw: string): string {
  const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : undefined;
  if (quote !== undefined && raw.length >= 2 && raw.endsWith(quote)) {
    const inner = raw.slice(1, -1);
    return quote === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner;
  }
  const hash = raw.indexOf(" #");
  return hash === -1 ? raw : raw.slice(0, hash).trim();
}
