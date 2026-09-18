/**
 * Resolve a version range against a list of available versions.
 *
 * "Which version would this range pick?" is asked constantly — before an
 * upgrade, when reading a lockfile, when deciding whether a published fix is
 * reachable — and it has one right answer. The range grammar and the
 * comparison come from `@crewhaus/tool-code`, so this agrees with
 * `DependencyOutdated` by construction rather than by coincidence.
 */
import { type SemVer, compareSemver, parseSemver, satisfies } from "@crewhaus/tool-code";

export type ResolveOptions = {
  /**
   * Consider prereleases. Off by default, matching npm: `^1.0.0` does not
   * pick `2.0.0-rc.1`, and picking one silently would ship a release
   * candidate to anybody who asked for a stable range.
   */
  readonly includePrerelease?: boolean;
  /** `highest` (default) is what a fresh install picks; `lowest` is the floor. */
  readonly strategy?: "highest" | "lowest";
};

export type ResolveResult = {
  readonly range: string;
  /** Every version that satisfies, in ascending order. */
  readonly satisfying: ReadonlyArray<string>;
  /** The one the strategy picks, or null when nothing satisfies. */
  readonly best: string | null;
  /** Versions that did not satisfy, and why in one word. */
  readonly rejected: ReadonlyArray<{ readonly version: string; readonly why: string }>;
  /** True when the range grammar was not understood at all. */
  readonly rangeUnderstood: boolean;
};

const isPrerelease = (v: SemVer): boolean => v.prerelease !== "";

export function resolveRange(
  range: string,
  versions: ReadonlyArray<string>,
  options: ResolveOptions = {},
): ResolveResult {
  const wantPrerelease = options.includePrerelease === true || /-/.test(range);

  const satisfying: Array<{ raw: string; parsed: SemVer }> = [];
  const rejected: Array<{ version: string; why: string }> = [];
  // `satisfies` answers undefined for a range it does not understand — a
  // workspace:, file: or git: specifier, or a typo. That is not the same as
  // "nothing matched", and reporting it as no-match would tell a caller the
  // dependency is unsatisfiable when it was never a version range.
  let understood = false;

  for (const raw of versions) {
    const parsed = parseSemver(raw);
    if (parsed === undefined) {
      rejected.push({ version: raw, why: "unparseable" });
      continue;
    }
    const ok = satisfies(raw, range);
    if (ok === undefined) {
      rejected.push({ version: raw, why: "range not understood" });
      continue;
    }
    understood = true;
    if (!ok) {
      rejected.push({ version: raw, why: "out of range" });
      continue;
    }
    if (isPrerelease(parsed) && !wantPrerelease) {
      rejected.push({ version: raw, why: "prerelease" });
      continue;
    }
    satisfying.push({ raw, parsed });
  }

  satisfying.sort((a, b) => compareSemver(a.parsed, b.parsed));
  const ordered = satisfying.map((s) => s.raw);
  const best =
    ordered.length === 0
      ? null
      : (((options.strategy ?? "highest") === "highest"
          ? ordered[ordered.length - 1]
          : ordered[0]) ?? null);

  return { range, satisfying: ordered, best, rejected, rangeUnderstood: understood };
}
