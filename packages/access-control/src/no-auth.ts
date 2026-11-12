/**
 * When `--no-auth` is refused. Turning sign-in off makes every local process the owner, so
 * it is refused whenever Home answers to anyone else: a trusted proxy is configured, or a
 * member or service other than the owner has access.
 */
import { join } from "node:path";
import { SETTINGS_FILENAME, readOwnerSettings } from "./owner-settings";
import { loadAccessSnapshot } from "./snapshot";

/**
 * Why Home must not start with `--no-auth`, or `undefined` when it may. Reads only.
 *
 * First consumer: `crewhaus hangar --no-auth`.
 */
export function noAuthRefusal(hangarRoot: string): string | undefined {
  const settings = readOwnerSettings(hangarRoot);
  if (!settings.ok) {
    return `--no-auth needs Home's settings to be readable, and ${join(hangarRoot, SETTINGS_FILENAME)} is not (${settings.reason}) — start Home without --no-auth`;
  }
  if (settings.settings.trustedProxy !== undefined) {
    return `--no-auth turns signing in off, and a trusted proxy is set in ${join(hangarRoot, SETTINGS_FILENAME)}, so people reach Home through it — start Home without --no-auth, or remove the proxy with \`crewhaus access proxy --off\``;
  }
  const read = loadAccessSnapshot(hangarRoot);
  if (read.state === "unreadable") {
    return `--no-auth needs to know who has access, and the access records cannot be read (${read.reason}) — start Home without --no-auth`;
  }
  if (read.state === "absent") return undefined;
  const snapshot = read.snapshot;
  const others = snapshot.principals.filter(
    (row) => row.state === "active" && row.id !== snapshot.owner,
  ).length;
  if (others > 0) {
    return `--no-auth turns signing in off, and ${others === 1 ? "someone else has" : `${others} others have`} access to this Home, who would then act as its owner — start Home without --no-auth (\`crewhaus access members\` lists them)`;
  }
  return undefined;
}
