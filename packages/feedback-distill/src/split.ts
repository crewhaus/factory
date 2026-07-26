/**
 * Deterministic train/dev/test assignment + the `vN` auto-bump — the two
 * pieces every promotion path (CLI `datasets put` / `distill --register`, the
 * teardown auto-distill, and the D39 daemon janitor step) must agree on.
 *
 * Extracted here so a compiled daemon bundle registers the SAME splits the
 * toolchain would; `apps/cli/src/datasets.ts` re-exports these.
 */
import { createHash } from "node:crypto";
import type { Sample } from "@crewhaus/eval-dataset";

export type SplitSpec = { readonly train: number; readonly dev: number; readonly test: number };

/** Default promotion split for `datasets put` / `distill --register`. */
export const DEFAULT_SPLIT_SPEC: SplitSpec = { train: 70, dev: 15, test: 15 };

function idHash(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/**
 * Deterministic split assignment. Samples are ordered by sha256(id) (stable
 * pseudo-shuffle, independent of input order; ties break on the raw id), then
 * cut at the cumulative percentage boundaries: train takes
 * `[0, floor(n·train%))`, dev the next slice, test the remainder — so the
 * three always partition the input exactly. NOT random: the same ids map to
 * the same splits on every run, which is what makes registry versions
 * reproducible. Tiny inputs can leave dev/test empty (floor); consumers fall
 * back accordingly.
 */
export function splitSamples(
  samples: ReadonlyArray<Sample>,
  spec: SplitSpec,
): { train: Sample[]; dev: Sample[]; test: Sample[] } {
  const ordered = [...samples].sort((a, b) => {
    const ha = idHash(a.id);
    const hb = idHash(b.id);
    if (ha !== hb) return ha < hb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const n = ordered.length;
  const trainEnd = Math.floor((n * spec.train) / 100);
  const devEnd = Math.floor((n * (spec.train + spec.dev)) / 100);
  return {
    train: ordered.slice(0, trainEnd),
    dev: ordered.slice(trainEnd, devEnd),
    test: ordered.slice(devEnd),
  };
}

const VERSION_GRAMMAR = /^v(\d+)$/;

/**
 * Auto-bump: `v<N+1>` where N is the highest existing `v<digits>` version
 * (0 when there is none → `v1`). Versions outside that grammar (a
 * hand-imported "1.0.0") are ignored rather than guessed at — the promotion
 * lineage always lives in the vN namespace, so this can't collide.
 */
export function nextVersion(existing: ReadonlyArray<string>): string {
  let max = 0;
  for (const v of existing) {
    const m = v.match(VERSION_GRAMMAR);
    if (m === null) continue;
    const n = Number.parseInt(m[1] as string, 10);
    if (n > max) max = n;
  }
  return `v${max + 1}`;
}

/** The registry's on-disk name grammar (verbatim from the CLI's
 *  `regression-pin.ts` `REGISTRY_NAME_REGEX`). */
export const REGISTRY_NAME_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** Registry-safe dataset name: the on-disk registry keys on the name, so a
 *  spec whose name cannot form one gets a clean skip, never a bad write. */
export function isRegistrySafeDatasetName(name: string): boolean {
  return REGISTRY_NAME_REGEX.test(name);
}
