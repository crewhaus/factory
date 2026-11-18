/**
 * `crewhaus eval --rebaseline --reason <code>`: re-anchor the (spec, dataset)
 * lineage on this run instead of gating it against a baseline it is not
 * comparable with. The pin records the reason, the run it replaced and the
 * command, so a re-anchor is never silent.
 *
 * Side-effect-free, so the unit tests drive it directly; `index.ts` dies with
 * the refusal.
 */
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RebaselineReason } from "@crewhaus/eval-report";

/** The codes `--reason` takes. */
export const REBASELINE_REASONS = [
  "instrument-changed",
  "cases-changed",
  "baseline-unreadable",
  "reset",
] as const satisfies ReadonlyArray<RebaselineReason>;

export type CliRebaselineReason = (typeof REBASELINE_REASONS)[number];

/** The command a re-anchor made from the CLI records on its pin. */
export const REBASELINE_CMD = "crewhaus eval --rebaseline";

/** Flags `--rebaseline` cannot be combined with, and why. */
const INCOMPATIBLE: ReadonlyArray<readonly [flag: string, why: string]> = [
  ["no-promote", "a re-anchor is a pin, and --no-promote keeps the pin as it is"],
  ["models", "a --models matrix compares models and pins no single run"],
  ["sentinel", "a sentinel probe pins nothing"],
  ["resume", "re-anchor on a complete run, after the resume has finished"],
  ["provability", "a --provability run measures a what-if floor and is never a baseline"],
];

export type RebaselineParse =
  | { readonly ok: true; readonly rebaseline?: { reason: CliRebaselineReason; cmd: string } }
  | { readonly ok: false; readonly error: string };

/**
 * Read `--rebaseline` and `--reason` from an `eval` invocation's flags: both
 * or neither, a known reason code, and none of the flags a re-anchor cannot
 * combine with.
 */
export function parseRebaseline(flags: Readonly<Record<string, unknown>>): RebaselineParse {
  const requested = flags["rebaseline"] === true;
  const reason = flags["reason"];
  if (!requested) {
    if (reason !== undefined) {
      return { ok: false, error: "--reason is only valid with --rebaseline" };
    }
    return { ok: true };
  }
  if (typeof reason !== "string" || reason === "") {
    return {
      ok: false,
      error: `--rebaseline requires --reason <code> (one of: ${REBASELINE_REASONS.join(", ")})`,
    };
  }
  if (!(REBASELINE_REASONS as ReadonlyArray<string>).includes(reason)) {
    return {
      ok: false,
      error: `--reason "${reason}" is not a re-anchor reason — use one of: ${REBASELINE_REASONS.join(", ")}`,
    };
  }
  for (const [flag, why] of INCOMPATIBLE) {
    if (flags[flag] !== undefined && flags[flag] !== false) {
      return { ok: false, error: `--rebaseline and --${flag} cannot be combined: ${why}` };
    }
  }
  return { ok: true, rebaseline: { reason: reason as CliRebaselineReason, cmd: REBASELINE_CMD } };
}

/**
 * Why a re-anchor (`--rebaseline` or `--regrade-baseline`, named by `flag`) of
 * the spec at `specPath` is refused from `cwd`, or `undefined` when it may run:
 * the run history it re-anchors is the one under the working directory, so the
 * working directory must be the spec's own (links resolved). The owner check,
 * the receipt and the pin then all bind to that one harness.
 */
export function reanchorDirRefusal(
  specPath: string,
  cwd: string,
  flag: "--rebaseline" | "--regrade-baseline",
): string | undefined {
  const specDir = dirname(resolve(cwd, specPath));
  const realOf = (dir: string): string | undefined => {
    try {
      return realpathSync(dir);
    } catch {
      return undefined;
    }
  };
  const here = realOf(cwd);
  const there = realOf(specDir);
  if (here !== undefined && here === there) return undefined;
  return `${flag} re-anchors the baseline in the eval history of the directory it runs in, so it runs from the spec's own directory: cd ${specDir}`;
}
