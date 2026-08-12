/**
 * Per-harness MANAGER settings — the `manager` block of
 * `<harness>/.crewhaus/settings.json`.
 *
 * This is the one file both heads read for "how should this harness be
 * supervised", and it lives INSIDE the harness for the same reason the
 * runfile and the run ledger do: all harness state is cwd-local, so a
 * harness copied to another machine carries its own supervision contract
 * with it, and `crewhaus daemon start` in a fresh directory behaves
 * identically whether or not the machine has a registry entry or a console
 * running. A registry field could not promise that — an unregistered
 * harness is the normal case for the standalone-harness convention.
 *
 * Today the block carries:
 *
 * ```json
 * {
 *   "manager": {
 *     "envFiles": ["../.env"],
 *     "autoCompile": true,
 *     "hooks": {
 *       "postCompile": "./patch-schemas.ts",
 *       "preSpawn": ["bun", "run", "prep.ts"],
 *       "timeoutMs": 120000
 *     },
 *     "logRetention": { "runs": 20, "bytes": 52428800 }
 *   }
 * }
 * ```
 *
 *   - `envFiles` — shared env files merged UNDER the harness-local
 *     `.env`/`.env.local` chain, so a fleet of sibling harnesses can keep
 *     ONE credentials file instead of a `.env → ../.env` symlink per member
 *     that no tool can see. See {@link loadEnvChain}.
 *   - `autoCompile` — recompile a stale bundle before starting, so the
 *     console's Restart button gets what `daemon start --compile` gives the
 *     terminal. Opt-in: the manager never mutates a bundle by default.
 *   - `hooks` — the operator's own step between compile and spawn. A STRING
 *     is one command with no arguments; an ARRAY is an argv vector. Never a
 *     shell: nothing here is word-split, glob-expanded or `$`-interpolated,
 *     so a path with a space is just a path.
 *   - `logRetention` — read by `readRetentionPolicy` (runfiles.ts), kept
 *     there because pruning is the only thing that consumes it.
 *
 * READING IS TOLERANT, ALWAYS. A missing file, malformed JSON, a `manager`
 * key of the wrong type, or one bad entry in an array degrades to the
 * default for that field and never throws: this file is human-owned, it is
 * read on the spawn path, and a typo in it must not be the reason a fleet
 * cannot start. Everything unrecognized is ignored and left untouched —
 * `settings.json` is shared with the runtime's own `hooks`/`permissions`
 * blocks, and this reader must never be the thing that drops them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the block lives, relative to the harness root. */
export const MANAGER_SETTINGS_SEGMENTS = [".crewhaus", "settings.json"] as const;

/** The two moments an operator can wedge a step into. */
export const MANAGER_HOOK_NAMES = ["postCompile", "preSpawn"] as const;
export type ManagerHookName = (typeof MANAGER_HOOK_NAMES)[number];

/** A declared hook, normalized to an argv vector. */
export type ManagerHook = {
  /** argv, index 0 is the command. Never empty. */
  readonly argv: readonly string[];
  /** The declaration verbatim, for reporting. */
  readonly declaredAs: string;
};

export type ManagerHooks = {
  readonly postCompile?: ManagerHook;
  readonly preSpawn?: ManagerHook;
  /** How long a hook may run before it is killed and refused. */
  readonly timeoutMs: number;
};

/** Long enough for a real prep step (a bundle patch, an asset pre-warm),
 *  short enough that a wedged hook does not hold a fleet's start forever. */
export const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

/** The `manager` block, with every field resolved to a usable default. */
export type ManagerSettings = {
  /** Shared env files, as declared (harness-root-relative or absolute), in
   *  declaration order. Empty when none are declared. */
  readonly envFiles: readonly string[];
  /** Recompile a stale bundle before starting. Default false — the manager
   *  never mutates a bundle unless asked. */
  readonly autoCompile: boolean;
  readonly hooks: ManagerHooks;
};

const EMPTY: ManagerSettings = {
  envFiles: [],
  autoCompile: false,
  hooks: { timeoutMs: DEFAULT_HOOK_TIMEOUT_MS },
};

/** The raw `manager` object, or undefined when there isn't a usable one. */
export function readManagerBlock(harnessDir: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(harnessDir, ...MANAGER_SETTINGS_SEGMENTS), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const manager = (parsed as Record<string, unknown>)["manager"];
  if (typeof manager !== "object" || manager === null || Array.isArray(manager)) return undefined;
  return manager as Record<string, unknown>;
}

/** Non-empty strings from a JSON array, in order. Anything else is dropped —
 *  one malformed entry must not discard the entries around it. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

/**
 * Normalize one hook declaration to an argv vector.
 *
 * A STRING is one command with NO arguments — deliberately not split on
 * whitespace, because splitting is the first half of implementing a shell,
 * and a half-shell is the kind that runs the wrong thing when a path
 * contains a space. Callers who need arguments write the array form.
 *
 * Returns undefined for anything unusable, so a malformed hook is "no hook"
 * rather than a start-time crash.
 */
export function parseManagerHook(value: unknown): ManagerHook | undefined {
  if (typeof value === "string") {
    const command = value.trim();
    return command === "" ? undefined : { argv: [command], declaredAs: command };
  }
  if (!Array.isArray(value)) return undefined;
  const argv = stringList(value);
  if (argv.length === 0) return undefined;
  return { argv, declaredAs: argv.join(" ") };
}

/** Read the `manager` block of a harness's `.crewhaus/settings.json`. */
export function readManagerSettings(harnessDir: string): ManagerSettings {
  const manager = readManagerBlock(harnessDir);
  if (manager === undefined) return EMPTY;
  const rawHooks = manager["hooks"];
  const hooks =
    typeof rawHooks === "object" && rawHooks !== null && !Array.isArray(rawHooks)
      ? (rawHooks as Record<string, unknown>)
      : {};
  const timeout = hooks["timeoutMs"];
  const postCompile = parseManagerHook(hooks["postCompile"]);
  const preSpawn = parseManagerHook(hooks["preSpawn"]);
  return {
    envFiles: stringList(manager["envFiles"]),
    autoCompile: manager["autoCompile"] === true,
    hooks: {
      ...(postCompile !== undefined ? { postCompile } : {}),
      ...(preSpawn !== undefined ? { preSpawn } : {}),
      timeoutMs:
        typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
          ? Math.floor(timeout)
          : DEFAULT_HOOK_TIMEOUT_MS,
    },
  };
}
