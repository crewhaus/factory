/**
 * What a run directory records about the cases it measured and the plugin
 * graders it measured them with, beside `run.json`:
 *
 * - `cases.json` — `{"version": 1, "digests": {<sampleId>: <sha256>}}`, the
 *   sha256 of each case's canonical JSON. Two runs whose datasets differ can
 *   then say which shared cases are unchanged. Written on every run; a
 *   resumed run rewrites it.
 * - `config.pluginsDigest` — one digest over the `.crewhaus/graders` plugins
 *   the run's graders resolved, so a change to a plugin's code is a change of
 *   instrument. It covers each plugin's entry file only, not the modules that
 *   file imports.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import { canonicalJson } from "./tool-record";

/** The file a run directory keeps its case digests in. */
export const CASES_FILENAME = "cases.json";

/** The version of the `cases.json` format this runner writes. */
export const CASES_VERSION = 1;

/** sha256 hex of one case's canonical JSON. */
export function caseDigestOf(sample: Sample): string {
  return createHash("sha256").update(canonicalJson(sample)).digest("hex");
}

/** The `cases.json` body for these samples, ids in dataset order. */
export function caseDigestsFile(samples: ReadonlyArray<Sample>): string {
  const digests: Record<string, string> = {};
  for (const sample of samples) digests[sample.id] = caseDigestOf(sample);
  return `${JSON.stringify({ version: CASES_VERSION, digests }, null, 2)}\n`;
}

/** Write `<outDir>/cases.json` for these samples. */
export async function writeCaseDigests(
  outDir: string,
  samples: ReadonlyArray<Sample>,
): Promise<void> {
  await Bun.write(join(outDir, CASES_FILENAME), caseDigestsFile(samples));
}

/**
 * sha256 over the sorted lines `<name>\t<sha256 of the entry file's bytes>`,
 * or `undefined` when no plugin was resolved. An entry file that cannot be
 * read is digested as the line `<name>\tunreadable`, so the run still records
 * which plugin it resolved.
 */
export function pluginsDigestOf(
  plugins: ReadonlyArray<readonly [name: string, modulePath: string]>,
): string | undefined {
  if (plugins.length === 0) return undefined;
  const lines = plugins
    .map(([name, modulePath]) => {
      let digest: string;
      try {
        digest = createHash("sha256").update(readFileSync(modulePath)).digest("hex");
      } catch {
        digest = "unreadable";
      }
      return `${name}\t${digest}`;
    })
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
