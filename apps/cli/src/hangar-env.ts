/**
 * Home's directories come from the shell, never from a `.env` file.
 *
 * Bun loads the `.env*` files of the directory a process starts in into its environment
 * before any code runs, and the compiled `crewhaus` binary does the same (the release
 * build leaves dotenv autoloading on). An exported value always wins over a file's. Home's
 * directory holds its own key and the access records that decide who may sign in, so a
 * `.env` in whatever folder `crewhaus hangar` happens to start in must not be able to
 * choose it. When `CREWHAUS_HANGAR_ROOT` or `CREWHAUS_REGISTRY_ROOT` holds exactly the
 * value one of those files defines, the value came from the file (or the shell agrees
 * with it, which the shell can show by exporting a different one), and the verb stops and
 * asks for an export instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvText } from "@crewhaus/harness-supervisor";

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
  readonly env: Readonly<Record<string, string | undefined>>;
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
 * The refusal when a root variable's value came from a dotenv file in `cwd`, or
 * `undefined`. Pure apart from `readFile`.
 */
export function dotenvRootRefusal(input: DotenvRootInput): string | undefined {
  const readFile = input.readFile ?? readIfThere;
  for (const name of ROOT_VARIABLES) {
    const value = input.env[name];
    if (value === undefined || value === "") continue;
    for (const file of DOTENV_FILES) {
      const text = readFile(join(input.cwd, file));
      if (text === undefined) continue;
      if (parseEnvText(text)[name] !== value) continue;
      return `crewhaus hangar: ${name} is set in ./${file}. Home's directory decides who can sign in, so it is read only from your shell: remove it from ./${file} and run \`export ${name}=<path>\` instead.`;
    }
  }
  return undefined;
}
