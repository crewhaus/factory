/**
 * The oldest Bun that CrewHaus supports, and the check `crewhaus doctor` runs.
 *
 * 0.7.1 raised this from 1.2.0 to 1.3.11. On Bun 1.2 the guarantees 0.7.1's
 * hardening rests on do not hold: a regex worker that timed out keeps running
 * (a batch's thread stayed live for 39 s after `terminate`, against about 1 s on
 * 1.3), burning a core and filling the runaway-worker budget so later regex
 * calls come back "busy". The test suite cannot run there either
 * (`beforeAll(fn, timeout)` is rejected), so a 1.2 floor was a claim nothing
 * checked. 1.3.11 is the Bun the CI suite and the release binaries use; no
 * older 1.3 has been run against this tree.
 *
 * The same floor is stated in the root package.json's `engines.bun` (which
 * release-prep stamps into every published package), the container images and
 * the install docs; `scripts/bun-floor.test.ts` fails when any of them drifts.
 */
export const BUN_FLOOR = "1.3.11";

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
