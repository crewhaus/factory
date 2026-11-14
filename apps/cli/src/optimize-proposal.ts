/**
 * The candidate spec of `crewhaus changes propose --from opt_<id>`.
 *
 * A proposal from an optimize run applies only settings the optimizer may tune, from a
 * run the CLI recorded:
 *
 * - the run is one `crewhaus optimize` wrote: `.crewhaus/optimize/<id>/report.json` is a
 *   contained regular file (no link at the leaf, capped), and it names this run id and
 *   the current spec's target;
 * - its patches (`patches.json`, else `patch.json`) are read the same way, and each one
 *   passes `validatePatch` (the target's `OPTIMIZABLE_PATHS`, the refused leaves, the
 *   target match) against the spec as the earlier patches left it, before it is applied.
 *
 * Any refusal throws a one-line `Error` and no patch is applied, so the caller files
 * nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpec } from "@crewhaus/spec";
import { type SpecPatch, applySpecPatch, validatePatch } from "@crewhaus/spec-patch";
import { openForReadSync } from "@crewhaus/tool-safety/fs";

/** The largest optimize `report.json` read. */
export const OPTIMIZE_REPORT_MAX_BYTES = 1024 * 1024;
/** The largest optimize patch file read. */
export const OPTIMIZE_PATCHES_MAX_BYTES = 8 * 1024 * 1024;

/** An optimize run id as `crewhaus optimize` mints it. */
export const OPTIMIZE_RUN_ID = /^opt_[0-9a-f]+$/;

type Read = { readonly kind: "text"; readonly text: string } | { readonly kind: "absent" };

function readRunFile(root: string, rel: string, maxBytes: number, label: string): Read {
  const read = openForReadSync(root, rel, { maxBytes, followLeafSymlink: false });
  if (!read.ok) {
    if (read.code === "not-found") return { kind: "absent" };
    throw new Error(`${label}: ${read.reason}`);
  }
  if (read.truncated) throw new Error(`${label}: ${rel} is larger than ${maxBytes} bytes`);
  return { kind: "text", text: read.text };
}

function parseJson(text: string, what: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label}: ${what} is not JSON`);
  }
}

/**
 * The spec at `specRel` (relative to `harnessDir`) with the patches of optimize run
 * `runId` applied, in order. Throws when the run is not one the CLI recorded for this
 * spec's target, or when any patch is not one the optimizer may make.
 */
export function readOptimizeCandidate(
  harnessDir: string,
  runId: string,
  specRel: string,
  label = "changes propose",
): string {
  const notRecorded = `${label}: no optimize run ${runId} recorded under .crewhaus/optimize`;
  if (!OPTIMIZE_RUN_ID.test(runId)) throw new Error(notRecorded);
  const root = join(harnessDir, ".crewhaus", "optimize");
  const yaml = readFileSync(join(harnessDir, specRel), "utf8");
  const target = parseSpec(yaml).target;

  const report = readRunFile(
    root,
    join(runId, "report.json"),
    OPTIMIZE_REPORT_MAX_BYTES,
    notRecorded,
  );
  if (report.kind === "absent") throw new Error(notRecorded);
  const fields = parseJson(report.text, "its report.json", notRecorded);
  if (
    fields === null ||
    typeof fields !== "object" ||
    (fields as { runId?: unknown }).runId !== runId ||
    (fields as { target?: unknown }).target !== target
  ) {
    throw new Error(notRecorded);
  }

  let patches: unknown[];
  const list = readRunFile(
    root,
    join(runId, "patches.json"),
    OPTIMIZE_PATCHES_MAX_BYTES,
    notRecorded,
  );
  if (list.kind === "text") {
    const parsed = parseJson(list.text, "its patches.json", notRecorded);
    if (!Array.isArray(parsed)) throw new Error(`${label}: its patches.json is not a list`);
    patches = parsed;
  } else {
    const one = readRunFile(
      root,
      join(runId, "patch.json"),
      OPTIMIZE_PATCHES_MAX_BYTES,
      notRecorded,
    );
    if (one.kind === "absent") throw new Error(`${label}: optimize run ${runId} holds no patch`);
    patches = [parseJson(one.text, "its patch.json", notRecorded)];
  }
  if (patches.length === 0) throw new Error(`${label}: optimize run ${runId} holds no patch`);

  let accumulated = yaml;
  for (const [i, patch] of patches.entries()) {
    try {
      validatePatch(parseSpec(accumulated), patch as SpecPatch);
    } catch (err) {
      throw new Error(
        `${label}: patch ${i + 1} is not one the optimizer may make: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    accumulated = applySpecPatch(accumulated, patch as SpecPatch).yaml;
  }
  return accumulated;
}
