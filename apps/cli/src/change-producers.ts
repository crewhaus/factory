/**
 * The CLI's change producers: a loop that found a better candidate either files it as a
 * `proposed` change (`--propose`, and every loop Home launches), or, for a command-line
 * write-back that already wrote the spec, records the change it made as `adopted` by the
 * local user. Content and the change row go through `@crewhaus/quality-service`; the
 * local user is recorded as a stored actor, never by name.
 */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ChangeSource } from "@crewhaus/control-contract";
import { type ChangeRow, createChange } from "@crewhaus/quality-service";
import { localStoredActor, qualityControl } from "./quality-receipts";

export type ProducedChange = {
  /** The spec the change is about. */
  readonly specPath: string;
  readonly source: ChangeSource;
  /** The spec's text before the candidate. */
  readonly baseText: string;
  /** The candidate spec's text. */
  readonly candidateText: string;
  /** The dataset the loop measured on, as given (`registry:…` or a path). */
  readonly dataset?: string;
  /** The graders file, as given. */
  readonly graders?: string;
  /** Evidence the loop already computed (its before and after runs). */
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly changelogEntry?: string;
  /** The PR body a proposal opens with. */
  readonly prBody?: string;
  /** A change id minted beforehand (the PR and the bundle name it). */
  readonly chg?: string;
  /** Fields a proposal bundle's patch.json carries beside the change's own. */
  readonly patchExtra?: Readonly<Record<string, unknown>>;
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/** A path relative to the harness when it lies inside it, else as given. */
function harnessRel(harnessDir: string, given: string | undefined, fallback: string): string {
  if (given === undefined) return fallback;
  if (given.startsWith("registry:")) return given;
  const abs = isAbsolute(given) ? given : resolve(given);
  const rel = relative(harnessDir, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
    ? rel.split("\\").join("/")
    : given;
}

async function produce(
  change: ProducedChange,
  adopted: { readonly specVersion?: string } | undefined,
): Promise<{ ok: true; row: ChangeRow } | { ok: false; reason: string }> {
  const specAbs = resolve(change.specPath);
  const harnessDir = dirname(specAbs);
  const control = qualityControl(change.env !== undefined ? { env: change.env } : {});
  let actor: string;
  try {
    actor = await localStoredActor(harnessDir, control);
  } catch (err) {
    return { ok: false, reason: `the local user cannot be recorded: ${(err as Error).message}` };
  }
  return createChange({
    harnessDir,
    kind: "spec",
    source: change.source,
    spec: relative(harnessDir, specAbs).split("\\").join("/"),
    graders: harnessRel(harnessDir, change.graders, "eval/graders.yaml"),
    dataset: harnessRel(harnessDir, change.dataset, "eval/dataset.jsonl"),
    baseText: change.baseText,
    candidateText: change.candidateText,
    actor,
    via: "cli",
    now: change.now ?? (() => Date.now()),
    ...(change.evidence !== undefined ? { evidence: change.evidence } : {}),
    ...(change.changelogEntry !== undefined ? { changelogEntry: change.changelogEntry } : {}),
    ...(change.prBody !== undefined ? { prBody: change.prBody } : {}),
    ...(change.chg !== undefined ? { chg: change.chg } : {}),
    ...(change.patchExtra !== undefined ? { patchExtra: change.patchExtra } : {}),
    ...(adopted !== undefined ? { adopted } : {}),
  });
}

/** File an accepted candidate as a `proposed` change; the spec is not written. */
export function proposeChange(
  change: ProducedChange,
): Promise<{ ok: true; row: ChangeRow } | { ok: false; reason: string }> {
  return produce(change, undefined);
}

/** Record a write-back the CLI already made as an `adopted` change. */
export function recordWriteBack(
  change: ProducedChange & { readonly specVersion?: string },
): Promise<{ ok: true; row: ChangeRow } | { ok: false; reason: string }> {
  return produce(
    change,
    change.specVersion !== undefined ? { specVersion: change.specVersion } : {},
  );
}

/** The lines a producer prints for the change it filed. */
export function producedLines(
  prefix: string,
  answer: { ok: true; row: ChangeRow } | { ok: false; reason: string },
): string[] {
  if (!answer.ok) return [`${prefix} warning: the change record was not written: ${answer.reason}`];
  const row = answer.row;
  return row.state === "proposed"
    ? [
        `${prefix} proposed ${row.id} — the spec was not written; check it with \`crewhaus changes check ${row.id}\``,
      ]
    : [`${prefix} recorded ${row.id} (adopted from the command line)`];
}
