/**
 * Common low-level helpers shared across factory.
 * Catalog F-foundations (`infra-utils`) — keep this package small. Only add
 * helpers when there is a real consumer. Things that grow into their own
 * concept (config loading, retries, ids) graduate to their own package.
 */

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
}

/**
 * Parse `argv` into positionals and flags per `schema`. Throws ArgParseError
 * for unknown flags or flags missing a required value. Treats `--` as the
 * end-of-flags sentinel; everything after it is positional.
 */
export function parseArgs(argv: ReadonlyArray<string>, schema: ParseArgsSchema): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  const byToken = new Map<string, FlagSpec>();
  for (const spec of schema.flags) {
    byToken.set(`--${spec.name}`, spec);
    if (spec.short !== undefined) byToken.set(`-${spec.short}`, spec);
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
