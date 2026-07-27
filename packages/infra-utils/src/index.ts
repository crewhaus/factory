/**
 * Common low-level helpers shared across factory.
 * Catalog F-foundations (`infra-utils`) — keep this package small. Only add
 * helpers when there is a real consumer. Things that grow into their own
 * concept (config loading, retries, ids) graduate to their own package.
 */

// §7.6 advisory file lock (two real consumers: continuity-store, wiki-store).
export {
  type AcquireFileLockOptions,
  type FileLockHandle,
  type FileLockPolicy,
  DEFAULT_FILE_LOCK_POLICY,
  acquireFileLock,
  withFileLock,
} from "./file-lock";

/**
 * Escape `s` so it is safe to embed as a string literal inside generated
 * TypeScript or JSON source. Returns a JSON-quoted form (includes surrounding
 * `"`). Used by codegen targets that build source text by template.
 */
export function escapeJsonString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Exhaustiveness helper for union switches. `assertNever(x)` only typechecks
 * if every union member is already handled in the surrounding switch.
 */
export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

export type FlagSpec = {
  /** Long name, used as both the `--name` token and the result key. */
  readonly name: string;
  /** Optional single-character short alias, parsed as `-x`. */
  readonly short?: string;
  /** If true, the flag consumes the next argv token as its value. */
  readonly takesValue?: boolean;
};

export type ParseArgsSchema = {
  readonly flags: ReadonlyArray<FlagSpec>;
};

export type ParsedArgs = {
  readonly positional: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string | boolean>>;
};

export class ArgParseError extends Error {
  override readonly name = "ArgParseError";
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor so Bun --coverage counts it as a covered function (field-initializer-only classes can't hit 100% function coverage otherwise)
  constructor(message: string) {
    super(message);
  }
}

/**
 * Signals a malformed `ParseArgsSchema` — a programmer bug in a schema literal,
 * NOT bad user input. Deliberately not an `ArgParseError` subclass: apps/cli's
 * `parseFor` catches `ArgParseError` and calls `die()`, which would report a
 * schema bug to the end user as though they mistyped a flag. This must escape
 * uncaught, so do not add it to a `die()` branch.
 */
export class ArgSchemaError extends Error {
  override readonly name = "ArgSchemaError";
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor so Bun --coverage counts it as a covered function (field-initializer-only classes can't hit 100% function coverage otherwise)
  constructor(message: string) {
    super(message);
  }
}

/**
 * Register `token` for `spec`. `Map.set` is last-write-wins, so without this a
 * duplicate `--name` or `-short` would silently discard one FlagSpec — and when
 * the two disagree on `takesValue`, the survivor changes how argv parses.
 */
function claimToken(byToken: Map<string, FlagSpec>, token: string, spec: FlagSpec): void {
  const prev = byToken.get(token);
  if (prev !== undefined) {
    throw new ArgSchemaError(
      `duplicate flag token "${token}" (declared by "${prev.name}" and "${spec.name}")`,
    );
  }
  byToken.set(token, spec);
}

/**
 * Parse `argv` into positionals and flags per `schema`. Throws ArgParseError
 * for unknown flags or flags missing a required value. Throws ArgSchemaError —
 * a programmer bug, not user input — if `schema` declares the same flag token
 * twice, or declares an empty name or short alias. Treats `--` as the
 * end-of-flags sentinel; everything after it is positional.
 */
export function parseArgs(argv: ReadonlyArray<string>, schema: ParseArgsSchema): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  const byToken = new Map<string, FlagSpec>();
  for (const spec of schema.flags) {
    // An empty name renders as `--`, which the end-of-flags sentinel below
    // claims first; an empty short renders as `-`, which hijacks the
    // single-dash positional. Both would be permanently dead flags.
    if (spec.name === "") throw new ArgSchemaError("flag spec has an empty name");
    claimToken(byToken, `--${spec.name}`, spec);
    if (spec.short !== undefined) {
      if (spec.short === "") {
        throw new ArgSchemaError(`flag "${spec.name}" has an empty short alias`);
      }
      claimToken(byToken, `-${spec.short}`, spec);
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;

    if (arg === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        const v = argv[j];
        if (v !== undefined) positional.push(v);
      }
      break;
    }

    const spec = byToken.get(arg);
    if (spec !== undefined) {
      if (spec.takesValue === true) {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new ArgParseError(`flag "${arg}" requires a value`);
        }
        flags[spec.name] = next;
        i += 1;
      } else {
        flags[spec.name] = true;
      }
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      throw new ArgParseError(`unknown flag: ${arg}`);
    }

    positional.push(arg);
  }

  return { positional, flags };
}
