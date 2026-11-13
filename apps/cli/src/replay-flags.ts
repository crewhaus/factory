/**
 * `--replay-tools <dir>` and `--replay-miss error|live`, validated the way `crewhaus
 * eval` validates them, for a verb whose every eval replays tool results from one
 * recording (`crewhaus optimize`).
 */
import { resolve } from "node:path";

export type ReplayToolsFlags =
  | {
      readonly ok: true;
      readonly replayToolsDir?: string;
      /** Only `live` is carried: `error` is the runner's default. */
      readonly replayMiss?: "live";
    }
  | { readonly ok: false; readonly error: string };

/** Read the two flags, or say why they cannot be used. */
export function parseReplayToolsFlags(
  flags: Readonly<Record<string, string | boolean | readonly string[] | undefined>>,
): ReplayToolsFlags {
  const dir = flags["replay-tools"];
  const miss = flags["replay-miss"];
  if (dir !== undefined && typeof dir !== "string") {
    return { ok: false, error: "--replay-tools needs a recording directory" };
  }
  if (miss !== undefined && dir === undefined) {
    return { ok: false, error: "--replay-miss is only valid with --replay-tools" };
  }
  if (miss !== undefined && miss !== "error" && miss !== "live") {
    return {
      ok: false,
      error: `invalid --replay-miss "${String(miss)}" — must be "error" or "live"`,
    };
  }
  if (typeof dir === "string" && dir.trim() === "") {
    return { ok: false, error: "--replay-tools needs a recording directory" };
  }
  return {
    ok: true,
    ...(typeof dir === "string" ? { replayToolsDir: resolve(dir) } : {}),
    ...(miss === "live" ? { replayMiss: "live" as const } : {}),
  };
}
