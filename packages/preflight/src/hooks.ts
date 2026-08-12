/**
 * The hooks area: operator steps that will run as part of this spawn.
 *
 * Preflight is what an operator reads immediately before a start, so "a
 * `preSpawn` hook will run, here is what it is, here is when it last ran"
 * belongs in it. The point is not validation — the hook is operator-authored
 * code and this package cannot judge it — but DISCLOSURE: a supervised start
 * that runs a command from `.crewhaus/settings.json` should say so in the
 * same report that lists the credentials it will use.
 *
 * One warn-level case: a hook that has never run on a harness that has runs
 * behind it. That is the shape of a fleet whose operator believes prep is
 * happening and whose daemon has never had it — the exact failure the hook
 * contract replaced a `prep.sh` convention to prevent.
 *
 * Like the env area, the caller supplies the facts: this package sits under
 * the supervisor and does not read `.crewhaus/settings.json` itself.
 */
import type { PreflightItem } from "./types";

/** One declared manager hook. Mirrors the supervisor's shape structurally. */
export type HookDisclosure = {
  /** `postCompile` | `preSpawn`. */
  readonly name: string;
  /** The declaration verbatim. */
  readonly declaredAs: string;
  /** ISO 8601 of its last run, when one is recorded. */
  readonly lastRunAt?: string;
  /** Whether that last run succeeded. */
  readonly lastRunOk?: boolean;
  /** True when the harness has recorded runs but this hook never fired. */
  readonly neverRanDespiteRuns?: boolean;
};

/** Report the hooks a spawn from this harness will run. Pure. */
export function hookItems(hooks: readonly HookDisclosure[]): PreflightItem[] {
  const items: PreflightItem[] = [];
  for (const hook of hooks) {
    if (hook.lastRunOk === false) {
      items.push({
        id: `hooks.${hook.name}.failed`,
        area: "hooks",
        level: "warn",
        message: `${hook.name} hook \`${hook.declaredAs}\` FAILED on its last run${
          hook.lastRunAt !== undefined ? ` (${hook.lastRunAt})` : ""
        } — a start refuses until it succeeds`,
        remediation: `run it by hand from the harness root, or fix the \`manager.hooks.${hook.name}\` entry in .crewhaus/settings.json`,
      });
      continue;
    }
    if (hook.neverRanDespiteRuns === true) {
      items.push({
        id: `hooks.${hook.name}.never-ran`,
        area: "hooks",
        level: "warn",
        message: `${hook.name} hook \`${hook.declaredAs}\` is declared but has never run, though this harness has run before — earlier runs did not get it`,
        remediation:
          "the next supervised start runs it; a bundle those earlier runs left unpatched may still need a recompile",
      });
      continue;
    }
    items.push({
      id: `hooks.${hook.name}`,
      area: "hooks",
      level: "info",
      message: `${hook.name} hook will run: \`${hook.declaredAs}\`${
        hook.lastRunAt !== undefined ? ` (last ok ${hook.lastRunAt})` : ""
      }`,
    });
  }
  return items;
}
