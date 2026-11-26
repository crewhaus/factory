/**
 * Run again: the input a new run starts with when it starts a recorded run again
 * (`runs.create` with `from`, `crewhaus runs create --from <run>`), and the one primitive
 * every head that starts a run again uses.
 *
 * The recorded request comes first: the run's input file (`inputs/<run>.json` for a cli or
 * managed run, `inputs/<run>.txt` otherwise), read whole, only as a regular file inside
 * the harness. A `.json` file gives its `input` field and nothing else: who a run serves
 * is asserted again with the new request, or not at all. Once the run's input file is
 * gone, its seed is the run's first message a person or a caller sent, read whole from
 * its session log, unmasked: a masked read is a view, never the source of a new run.
 *
 * It reads only; the new run's input is classified at `api` where it starts, like any
 * other.
 */
import { join } from "node:path";
import { controlPaths, readRecordFile } from "@crewhaus/control-records";
import { foldSummary, loadRun } from "@crewhaus/run-inspect";
import type { RunRefusal } from "./runs";

/** As large as a request body the API takes: a larger input is not started again here. */
export const RERUN_INPUT_MAX_BYTES = 256 * 1024;

export type RerunInput =
  | {
      readonly ok: true;
      readonly input: string;
      /** The run's input file, or its seed message in the session log. */
      readonly source: "input-file" | "seed";
    }
  | { readonly ok: false; readonly refusal: RunRefusal };

export type RerunOptions = {
  /** The harness's env-file variables: they say where its session root is. */
  readonly envVars: Readonly<Record<string, string | undefined>>;
  readonly now: number;
};

const TOO_LARGE: RunRefusal = {
  code: "unsupported",
  reason: "input_too_large",
  message: `This run's request is larger than ${RERUN_INPUT_MAX_BYTES / 1024} KiB, so it can't be run again from here.`,
};

const NOT_KEPT: RunRefusal = {
  code: "unsupported",
  reason: "input_not_kept",
  message: "This run's request was not kept, so it can't be run again.",
};

/** The input an input file holds: a `.txt` file's text, a `.json` file's `input` field. */
function inputOfFile(text: string, json: boolean): string | undefined {
  if (!json) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const input = (parsed as { readonly input?: unknown } | null)?.input;
  return typeof input === "string" ? input : undefined;
}

/**
 * What `runId` of this harness started with, to start it again: its input file while it
 * exists, else its seed message. Over {@link RERUN_INPUT_MAX_BYTES}, or with nothing
 * recorded, it refuses (`unsupported`: `input_too_large`, `input_not_kept`).
 */
export function rerunInputOf(harnessDir: string, runId: string, opts: RerunOptions): RerunInput {
  const inputs = controlPaths(harnessDir).inputsDir;
  for (const [name, json] of [
    [`${runId}.json`, true],
    [`${runId}.txt`, false],
  ] as const) {
    const read = readRecordFile(harnessDir, join(inputs, name), RERUN_INPUT_MAX_BYTES + 1);
    if (!read.ok) continue;
    if (read.truncated || read.size > RERUN_INPUT_MAX_BYTES)
      return { ok: false, refusal: TOO_LARGE };
    const input = inputOfFile(read.text, json);
    if (input !== undefined && input !== "") return { ok: true, input, source: "input-file" };
  }
  const loaded = loadRun({ harnessDir, ref: runId, envVars: opts.envVars, now: opts.now });
  if (!loaded.ok) return { ok: false, refusal: NOT_KEPT };
  const asked = foldSummary(loaded).asked.value;
  if (asked === undefined || asked === "") return { ok: false, refusal: NOT_KEPT };
  if (Buffer.byteLength(asked, "utf8") > RERUN_INPUT_MAX_BYTES) {
    return { ok: false, refusal: TOO_LARGE };
  }
  return { ok: true, input: asked, source: "seed" };
}
