/**
 * The Hangar root: the directory where Home (`crewhaus hangar`) keeps its own
 * files — its token, its settings, its cache and its job ledger.
 *
 * One resolver serves the CLI, the fleet tools and the runtime-state floor,
 * so the console, the tools that read its ledger and the floor that keeps an
 * agent's tools out of it always name the same directory.
 *
 * The floor protects every Hangar root the run's environment names, and the
 * default (`~/.crewhaus/hangar`) always: these two variables,
 * `CREWHAUS_HANGAR_ROOT` and `CREWHAUS_REGISTRY_ROOT`, can add a protected
 * root and never move one. The default comes from the home directory
 * (`homedir()`), as the server's own fallback does.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRegistryRoot } from "./registry.js";

/**
 * The Hangar root: `CREWHAUS_HANGAR_ROOT` when it is set and not empty,
 * resolved to an absolute path, else `<registryRoot>/hangar` — which is the
 * server's own `~/.crewhaus/hangar` default under the default registry root,
 * and keeps everything under one temp root in tests.
 */
export function resolveHangarRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = env["CREWHAUS_HANGAR_ROOT"];
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  return join(resolveRegistryRoot(env), "hangar");
}

/**
 * Every Hangar root `env` can name, absolute and without repeats, in this
 * order: the one {@link resolveHangarRoot} picks, `<registryRoot>/hangar`,
 * and `~/.crewhaus/hangar` always. The runtime-state floor protects each of
 * them, so a variable set for a run adds a protected directory and never
 * takes the default's protection away. No link is followed here: the runtime
 * adds the other spellings of each root.
 */
export function hangarStateRoots(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const roots = [
    resolveHangarRoot(env),
    join(resolveRegistryRoot(env), "hangar"),
    join(homedir(), ".crewhaus", "hangar"),
  ];
  return [...new Set(roots.map((root) => resolve(root)))];
}
