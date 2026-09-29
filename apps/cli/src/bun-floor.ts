/**
 * The oldest Bun that CrewHaus supports, and the check `crewhaus doctor` runs.
 *
 * 0.7.1 raised this from 1.2.0. The guarantee it was raised for is
 * @crewhaus/tool-safety's regex worker: a caller-supplied regex runs in a
 * worker that is terminated at its deadline, so a pattern that never finishes
 * costs one abandoned thread for a moment, not a core for as long as it runs.
 * - On 1.2 a timed-out batch's thread stayed live for 39 s after `terminate`
 *   (about 1 s on 1.3), filling the runaway-worker budget so later regex calls
 *   came back "busy"; the test suite cannot run there at all
 *   (`beforeAll(fn, timeout)` is rejected).
 * - On 1.3.11, Linux x64 (CI run 36615945808), tool-safety's own tests fail:
 *   a terminated batch kept its thread for the whole batch, and
 *   String.prototype.replace split a surrogate pair against the spec. The
 *   first 0.7.1 floor was 1.3.11, which promised the guarantee exactly where
 *   CI refuted it.
 * - On 1.3.13 and 1.3.14 both pass on Linux arm64, and on 1.3.14 on macOS,
 *   where this whole tree is developed and tested. They also pass with the
 *   x64 builds of 1.3.13 and 1.3.14 (macOS, under Rosetta), so the x64 code
 *   generator is not what failed; the Bun version is the difference we can see.
 *
 * So the floor is 1.3.14, and CI's and the release jobs' Bun pins EQUAL it
 * (scripts/bun-floor.test.ts): the gating ubuntu x64 `ci` job is what proves
 * the floor on Linux x64, and release.yml's build waits on it, so no tag ships
 * a floor that job has not run green. The standalone binaries embed the Bun
 * that builds them, the same pin.
 *
 * The same floor is stated in the root package.json's `engines.bun` (which
 * release-prep stamps into every published package), the container images and
 * the install docs; `scripts/bun-floor.test.ts` fails when any of them drifts.
 */
export const BUN_FLOOR = "1.3.14";

/** major.minor.patch of a Bun version string; a pre-release tag is ignored. */
export function bunVersionParts(version: string): [number, number, number] | undefined {
  const m = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
}

export function checkBunVersion(version: string): { pass: boolean; reason?: string } {
  const have = bunVersionParts(version);
  if (have === undefined) return { pass: false, reason: `unparseable version "${version}"` };
  const need = bunVersionParts(BUN_FLOOR) as [number, number, number];
  for (let i = 0; i < 3; i++) {
    const a = have[i] as number;
    const b = need[i] as number;
    if (a > b) return { pass: true };
    if (a < b) {
      return {
        pass: false,
        reason: `bun ${version} is below the minimum ${BUN_FLOOR} (run \`bun upgrade\`; the standalone crewhaus binaries carry their own Bun)`,
      };
    }
  }
  return { pass: true };
}
