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
 *     "logRetention": { "runs": 20, "bytes": 52428800 }
 *   }
 * }
 * ```
 *
 *   - `envFiles` — shared env files merged UNDER the harness-local
 *     `.env`/`.env.local` chain, so a fleet of sibling harnesses can keep
 *     ONE credentials file instead of a `.env → ../.env` symlink per member
 *     that no tool can see. See {@link loadEnvChain}.
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

/** The `manager` block, with every field resolved to a usable default. */
export type ManagerSettings = {
  /** Shared env files, as declared (harness-root-relative or absolute), in
   *  declaration order. Empty when none are declared. */
  readonly envFiles: readonly string[];
};

const EMPTY: ManagerSettings = { envFiles: [] };

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

/** Read the `manager` block of a harness's `.crewhaus/settings.json`. */
export function readManagerSettings(harnessDir: string): ManagerSettings {
  const manager = readManagerBlock(harnessDir);
  if (manager === undefined) return EMPTY;
  return { envFiles: stringList(manager["envFiles"]) };
}
