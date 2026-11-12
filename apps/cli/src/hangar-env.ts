/**
 * Home's directories come from the shell, never from a `.env` file.
 *
 * Bun loads the `.env*` files of the directory a process starts in into its environment
 * before any code runs, and the compiled `crewhaus` binary does the same (the release
 * build leaves dotenv autoloading on). Home's directory holds its own key and the access
 * records that decide who may sign in, so a `.env` in whatever folder `crewhaus hangar`
 * happens to start in must not be able to choose it.
 *
 * The rule is about the file, not the value: when any of those files defines
 * `CREWHAUS_HANGAR_ROOT` or `CREWHAUS_REGISTRY_ROOT` at all, the verb stops and asks for
 * the line to be removed and the value exported. Comparing the file's value with the
 * environment cannot work, because Bun's loader rewrites values as it loads them
 * (`$NAME` and `${NAME}` expansion, inline comments after a closing quote, backtick
 * quoting) and no other parser reproduces it exactly. An exported value already wins over
 * the file's, so such a line is either dead or the one choosing the directory.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every file Bun loads into a process started here, whichever NODE_ENV. The same list as
 * runtime-core's `ENV_FILES` (`packages/runtime-core/src/state-roots.ts`), which keeps it
 * private; a change to one is a change to both.
 */
export const DOTENV_FILES: readonly string[] = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];

/** The variables that choose Home's directories. */
export const ROOT_VARIABLES: readonly string[] = ["CREWHAUS_HANGAR_ROOT", "CREWHAUS_REGISTRY_ROOT"];

export type DotenvRootInput = {
  readonly cwd: string;
  /** A file's text, or `undefined` when it cannot be read. */
  readonly readFile?: (path: string) => string | undefined;
};

function readIfThere(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Whether `text` has a line that assigns `name`, in any spelling Bun's loader accepts:
 * leading spaces, an `export ` prefix, spaces around the `=` (or `:`), CRLF endings.
 * Over-matching (a line inside another key's multi-line quoted value) only refuses.
 */
export function definesVariable(text: string, name: string): boolean {
  for (const raw of text.split(/\r?\n|\r/)) {
    let line = raw.trimStart();
    if (line.startsWith("export") && /^export[ \t]/.test(line)) line = line.slice(6).trimStart();
    if (!line.startsWith(name)) continue;
    const rest = line.slice(name.length).trimStart();
    if (rest.startsWith("=") || rest.startsWith(":")) return true;
  }
  return false;
}

/**
 * The refusal when a dotenv file in `cwd` defines a root variable, or `undefined`. Pure
 * apart from `readFile`.
 */
export function dotenvRootRefusal(input: DotenvRootInput): string | undefined {
  const readFile = input.readFile ?? readIfThere;
  for (const name of ROOT_VARIABLES) {
    for (const file of DOTENV_FILES) {
      const text = readFile(join(input.cwd, file));
      if (text === undefined || !definesVariable(text, name)) continue;
      return `crewhaus hangar: ${name} is set in ./${file}. Home's directory decides who can sign in, so it is read only from your shell: remove it from ./${file} and run \`export ${name}=<path>\` instead.`;
    }
  }
  return undefined;
}
